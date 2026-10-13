import { OMR_ENDPOINT, type Instrument } from '../config';
import type { RnScore } from './notation';

export interface OmrResult {
  musicxml: string;
  warnings: string[];
}

/**
 * Why reading failed, in categories a parent can act on.
 * - offline: no internet
 * - tooBig: the photo is over the upload limit
 * - rateLimited: Riffi's own hourly limit
 * - busy: the AI provider's limit (e.g. Gemini free tier) or it's overloaded
 * - quota: the provider's daily free allowance is used up
 * - timeout: the page took too long (deadline, or Cloudflare's 100 s limit)
 * - notConfigured: the server has no key / config
 * - blocked: the server can't reach the AI provider (outgoing connections blocked)
 * - settings: the provider rejected the key, model name or region
 * - unreadable: the AI couldn't make music out of the photo
 * - server: anything else
 */
export type OmrErrorKind =
  | 'offline'
  | 'tooBig'
  | 'rateLimited'
  | 'busy'
  | 'quota'
  | 'timeout'
  | 'notConfigured'
  | 'blocked'
  | 'settings'
  | 'unreadable'
  | 'server';

export class OmrError extends Error {
  constructor(
    readonly kind: OmrErrorKind,
    /** Reference code to find the details in the server's private log. */
    readonly ref?: string,
    /** Short technical code (e.g. model_not_found, http_524). */
    readonly code?: string,
    /** Seconds the server asked us to wait before trying again. */
    readonly retryAfter?: number,
  ) {
    super(code ?? kind);
  }
}

export interface OmrProgress {
  /** 0-based page being read. */
  page: number;
  pages: number;
  stage: 'sending' | 'reading';
  /** Bars found so far on this page. */
  bars: number;
}

/** Map a server error code to a category. Pure. */
export function kindForCode(code: string | undefined): OmrErrorKind {
  switch (code) {
    case 'busy':
      return 'busy';
    case 'quota':
      return 'quota';
    case 'timeout':
      return 'timeout';
    case 'rate_limited':
      return 'rateLimited';
    case 'too_big':
    case 'too_many_pages':
      return 'tooBig';
    case 'not_configured':
      return 'notConfigured';
    case 'blocked':
      return 'blocked';
    case 'bad_key':
    case 'model_not_found':
    case 'region':
    case 'provider_rejected':
    case 'origin':
      return 'settings';
    case 'unreadable':
      return 'unreadable';
    default:
      return 'server';
  }
}

/** Map an HTTP status that isn't one of ours (e.g. a Cloudflare error page). Pure. */
export function kindForStatus(status: number): OmrErrorKind {
  if (status === 413) return 'tooBig';
  if (status === 429) return 'rateLimited';
  // 504 gateway timeout; 522/523/524 Cloudflare couldn't connect / timed out.
  if (status === 504 || status === 522 || status === 523 || status === 524) return 'timeout';
  return 'server';
}

type StreamLine =
  | { type: 'start' | 'ping'; ref?: string }
  | { type: 'progress'; bars: number }
  | { type: 'result'; score?: RnScore; warnings?: string[]; overview?: unknown; line?: unknown; check?: unknown; ref?: string }
  | { type: 'error'; code: string; message?: string; ref?: string; retry_after?: number | null };

/** Read an NDJSON response line by line. */
async function* readLines(res: Response): AsyncGenerator<StreamLine> {
  const reader = res.body?.getReader();
  if (!reader) {
    for (const line of (await res.text()).split('\n')) if (line.trim()) yield JSON.parse(line) as StreamLine;
    return;
  }
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as StreamLine;
    }
    if (done) break;
  }
  if (buf.trim()) yield JSON.parse(buf) as StreamLine;
}

export type ReaderMode = 'overview' | 'line' | 'check';

export interface ReaderRequest {
  mode: ReaderMode;
  /** Images in the order the mode expects (overview: page; line: crop; check: crop, engraving). */
  images: { blob: Blob; name: string }[];
  fields: Record<string, string | number | boolean | null | undefined>;
}

export interface CallOptions {
  instrument: Instrument;
  /** Bars streamed so far (the line being read). */
  onBars?: (bars: number) => void;
  fetchImpl?: typeof fetch;
}

/** The parts of the server's result we use. */
export interface ReaderResult {
  overview?: unknown;
  line?: unknown;
  check?: unknown;
  provider?: string;
  ref?: string;
}

/**
 * One request to the reading endpoint (one image or one line: short, so it stays
 * well inside Cloudflare's 100 s and the host's time limit). Streams NDJSON.
 */
export async function callReader(req: ReaderRequest, opts: CallOptions): Promise<ReaderResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const form = new FormData();
  form.append('mode', req.mode);
  form.append('instrument', opts.instrument);
  for (const [k, v] of Object.entries(req.fields)) if (v !== undefined && v !== null) form.append(k, String(v));
  for (const img of req.images) form.append('pages[]', img.blob, img.name);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 150_000);
  let res: Response;
  try {
    res = await fetchImpl(OMR_ENDPOINT, { method: 'POST', body: form, signal: ctl.signal });
  } catch {
    clearTimeout(timer);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new OmrError('offline');
    throw new OmrError(ctl.signal.aborted ? 'timeout' : 'server', undefined, ctl.signal.aborted ? 'client_timeout' : 'network');
  }
  try {
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !type.includes('ndjson')) {
      // Our own JSON errors carry a code; anything else (e.g. Cloudflare's HTML 524) doesn't.
      let body: { code?: string; ref?: string; retry_after?: number | null } | null = null;
      try {
        body = type.includes('json') ? await res.json() : null;
      } catch {
        body = null;
      }
      const retry = body?.retry_after ?? (Number(res.headers.get('retry-after')) || undefined);
      if (body?.code) throw new OmrError(kindForCode(body.code), body.ref, body.code, retry ?? undefined);
      throw new OmrError(kindForStatus(res.status), undefined, `http_${res.status}`, retry ?? undefined);
    }
    let ref: string | undefined;
    for await (const line of readLines(res)) {
      if ('ref' in line && line.ref) ref = line.ref;
      if (line.type === 'progress') opts.onBars?.(line.bars);
      if (line.type === 'error') throw new OmrError(kindForCode(line.code), line.ref ?? ref, line.code, line.retry_after ?? undefined);
      if (line.type === 'result') {
        const r = line as ReaderResult;
        return { overview: r.overview, line: r.line, check: r.check, provider: r.provider, ref: line.ref ?? ref };
      }
    }
    // The stream ended without a result: the connection was cut (e.g. a proxy timeout).
    throw new OmrError('timeout', ref, 'stream_cut');
  } catch (e) {
    if (e instanceof OmrError) throw e;
    throw new OmrError(ctl.signal.aborted ? 'timeout' : 'server', undefined, ctl.signal.aborted ? 'client_timeout' : 'bad_stream');
  } finally {
    clearTimeout(timer);
  }
}

/** GET ?info=1: which providers have keys, which one reads (site-wide), and the request pace. */
export interface ReaderInfo {
  providers: string[];
  /** The reader every scan uses (chosen in Settings with the admin password, or the config's PROVIDER). */
  provider: string | null;
  /** Whether the server has an admin password, so the reader can be changed. */
  canChange: boolean;
  rpm: Record<string, number>;
  /** Lines of music per request (the server's LINES_PER_REQUEST). */
  linesPerRequest: number;
  /** Double-check rounds per line (the server's CHECK_ROUNDS). */
  checkRounds: number;
}

export async function readerInfo(fetchImpl: typeof fetch = fetch): Promise<ReaderInfo | null> {
  try {
    const res = await fetchImpl(`${OMR_ENDPOINT}?info=1`, { cache: 'no-store' });
    if (!res.ok) return null;
    const j = (await res.json()) as { providers?: string[]; provider?: string; default?: string; can_change?: boolean; rpm?: Record<string, number>; lines_per_request?: number; check_rounds?: number };
    const per = Number(j.lines_per_request);
    const rounds = Number(j.check_rounds);
    return {
      providers: Array.isArray(j.providers) ? j.providers : [],
      provider: j.provider ?? j.default ?? null,
      canChange: j.can_change === true,
      rpm: j.rpm ?? {},
      linesPerRequest: per > 0 ? per : 8,
      checkRounds: Number.isFinite(rounds) && j.check_rounds !== undefined ? Math.max(0, Math.min(2, rounds)) : 2,
    };
  } catch {
    return null;
  }
}

export type AdminResult =
  | { ok: true; provider: string; providers: string[] }
  | { ok: false; reason: 'wrong'; attemptsLeft: number }
  | { ok: false; reason: 'locked'; minutes: number }
  | { ok: false; reason: 'off' | 'offline' | 'server' };

/**
 * POST ?admin=1: check the admin password (the server allows 5 wrong tries per
 * 15 minutes) and, with a provider, change the music reader for the whole site.
 */
export async function adminReader(password: string, provider?: string, fetchImpl: typeof fetch = fetch): Promise<AdminResult> {
  const form = new FormData();
  form.append('password', password);
  if (provider) form.append('provider', provider);
  let res: Response;
  try {
    res = await fetchImpl(`${OMR_ENDPOINT}?admin=1`, { method: 'POST', body: form, cache: 'no-store' });
  } catch {
    return { ok: false, reason: typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'server' };
  }
  let j: { ok?: boolean; code?: string; provider?: string; providers?: string[]; attempts_left?: number; retry_after?: number | null } = {};
  try {
    j = await res.json();
  } catch {
    return { ok: false, reason: 'server' };
  }
  if (res.ok && j.ok && j.provider) return { ok: true, provider: j.provider, providers: j.providers ?? [] };
  if (j.code === 'wrong_password') return { ok: false, reason: 'wrong', attemptsLeft: Math.max(0, Number(j.attempts_left ?? 0)) };
  if (j.code === 'locked') return { ok: false, reason: 'locked', minutes: Math.max(1, Math.ceil(Number(j.retry_after ?? 900) / 60)) };
  if (j.code === 'admin_off') return { ok: false, reason: 'off' };
  return { ok: false, reason: 'server' };
}

export interface CheckReport {
  report: Record<string, unknown>;
  /** ms from request to the first ping, and to the second (streamed if they're ~1 s apart). */
  firstPingMs?: number;
  secondPingMs?: number;
  streamed: boolean;
  totalMs: number;
}

export async function checkMusicReader(fetchImpl: typeof fetch = fetch): Promise<CheckReport> {
  const t0 = performance.now();
  const res = await fetchImpl(`${OMR_ENDPOINT}?check=1`, { method: 'GET', cache: 'no-store' });
  if (!res.ok || !(res.headers.get('content-type') ?? '').includes('ndjson')) {
    let body: { code?: string; ref?: string; error?: string } | null = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return {
      report: { http_status: res.status, code: body?.code ?? `http_${res.status}`, error: body?.error ?? 'No report (is api/omr.php deployed?)', ref: body?.ref },
      streamed: false,
      totalMs: Math.round(performance.now() - t0),
    };
  }
  const pings: number[] = [];
  let report: Record<string, unknown> = {};
  for await (const line of readLines(res)) {
    if (line.type === 'ping') pings.push(Math.round(performance.now() - t0));
    if (line.type === 'result') report = (line as unknown as { report: Record<string, unknown> }).report;
  }
  const totalMs = Math.round(performance.now() - t0);
  // Streamed if the two pings (sent 1 s apart) arrived about 1 s apart.
  const streamed = pings.length >= 2 && pings[1] - pings[0] > 600;
  return { report, firstPingMs: pings[0], secondPingMs: pings[1], streamed, totalMs };
}
