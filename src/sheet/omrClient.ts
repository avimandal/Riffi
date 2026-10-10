import { OMR_ENDPOINT, type Instrument } from '../config';
import { checkScore, mergePages, NotationError, notationToMusicXml, type RnScore } from './notation';

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
  | { type: 'result'; score: RnScore; warnings?: string[]; ref?: string }
  | { type: 'error'; code: string; message?: string; ref?: string };

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

/** Read one page. Exported for tests (pass a fetch). */
export async function readPage(
  page: Blob,
  index: number,
  pages: number,
  instrument: Instrument,
  onProgress?: (p: OmrProgress) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<{ score: RnScore; warnings: string[] }> {
  const form = new FormData();
  form.append('pages[]', page, `page-${index + 1}.jpg`);
  form.append('instrument', instrument);
  form.append('page', String(index + 1));
  form.append('pages', String(pages));
  onProgress?.({ page: index, pages, stage: 'sending', bars: 0 });

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
      let body: { code?: string; ref?: string } | null = null;
      try {
        body = type.includes('json') ? await res.json() : null;
      } catch {
        body = null;
      }
      if (body?.code) throw new OmrError(kindForCode(body.code), body.ref, body.code);
      throw new OmrError(kindForStatus(res.status), undefined, `http_${res.status}`);
    }
    let ref: string | undefined;
    for await (const line of readLines(res)) {
      if ('ref' in line && line.ref) ref = line.ref;
      if (line.type === 'progress') onProgress?.({ page: index, pages, stage: 'reading', bars: line.bars });
      if (line.type === 'start') onProgress?.({ page: index, pages, stage: 'reading', bars: 0 });
      if (line.type === 'error') throw new OmrError(kindForCode(line.code), line.ref ?? ref, line.code);
      if (line.type === 'result') {
        const problems = checkScore(line.score);
        if (problems.length) throw new OmrError('unreadable', line.ref ?? ref, 'bad_notation');
        return { score: line.score, warnings: line.warnings ?? [] };
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

/**
 * Read prepared pages one request at a time (so no single request runs long),
 * then join them and build MusicXML.
 */
export async function readSheetMusic(pages: Blob[], instrument: Instrument, onProgress?: (p: OmrProgress) => void, fetchImpl: typeof fetch = fetch): Promise<OmrResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new OmrError('offline');
  const scores: RnScore[] = [];
  for (let i = 0; i < pages.length; i++) {
    const { score, warnings } = await readPage(pages[i], i, pages.length, instrument, onProgress, fetchImpl);
    scores.push({ ...score, warnings });
  }
  const merged = mergePages(scores);
  try {
    const partName = { violin: 'Violin', piano: 'Piano', voice: 'Voice' }[instrument];
    return notationToMusicXml({ ...merged, staves: instrument === 'piano' ? 2 : merged.staves }, partName);
  } catch (e) {
    if (e instanceof NotationError) throw new OmrError('unreadable', undefined, 'bad_notation');
    throw e;
  }
}

/** The self-check report from GET ?check=1, plus how the reply streamed. */
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
