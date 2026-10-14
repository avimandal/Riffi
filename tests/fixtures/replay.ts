import { kindForCode, OmrError, type ReaderRequest, type ReaderResult } from '../../src/sheet/omrClient';
import type { Instrument } from '../../src/config';

/** A recorded run of the real music reader (tests/fixtures/sheets/recordings). */
export interface Recording {
  fixture: string;
  provider: string;
  model: string;
  instrument: Instrument;
  lines: number[];
  seconds?: number;
  /** Note heads the browser measured on each page ([page][line][staff]), so pitch snapping replays too. */
  heads?: { x: number; step: number }[][][][];
  responses: { mode: string; page: number; line: number | null; round: number | null; body: string; ms?: number }[];
  report: Record<'first' | 'final', { pitch: number; rhythm: number; key: boolean; time: boolean; pickup: boolean }>;
}

/** The result line of a recorded reply, or the error it carried. */
function outcome(body: string): ReaderResult {
  const text = body.trim();
  // A plain JSON error (sent before streaming started, e.g. the pace limit).
  if (text.startsWith('{"error"')) {
    const e = JSON.parse(text) as { code: string; ref?: string; retry_after?: number };
    throw new OmrError(kindForCode(e.code), e.ref, e.code, e.retry_after);
  }
  const last = JSON.parse(text.split('\n').pop()!) as { type: string; code?: string; ref?: string; retry_after?: number } & ReaderResult;
  if (last.type === 'error') throw new OmrError(kindForCode(last.code), last.ref, last.code, last.retry_after ?? undefined);
  return last;
}

/**
 * Replays the recorded requests as they were made (same grouping, same errors, in order).
 * `skipErrors`: answer each request with its first recorded reply that wasn't an error,
 * as a server that wasn't overloaded would have (the app no longer re-sends after "busy").
 */
export function replayer(rec: Recording, opts: { skipErrors?: boolean } = {}) {
  const used = new Set<number>();
  const isError = (body: string) => {
    try {
      outcome(body);
      return false;
    } catch {
      return true;
    }
  };
  return async (req: ReaderRequest): Promise<ReaderResult> => {
    const want = (r: Recording['responses'][number]) =>
      r.mode === req.mode && r.page === Number(req.fields.page ?? 1) && (r.line ?? null) === (req.fields.line === undefined ? null : Number(req.fields.line)) && (r.round ?? null) === (req.fields.round === undefined ? null : Number(req.fields.round));
    const i = rec.responses.findIndex((r, k) => !used.has(k) && want(r) && !(opts.skipErrors && isError(r.body)));
    if (i < 0) throw new Error(`No recorded reply for ${req.mode} page ${req.fields.page} line ${req.fields.line} round ${req.fields.round}`);
    used.add(i);
    return outcome(rec.responses[i].body);
  };
}

/**
 * Replays the recorded answers for any grouping of lines: each line gets what the
 * reader said about it (in whichever request it came), so reading one line per
 * request can be replayed from a run that read the whole page at once. Busy
 * errors in the recording (the reader's own pace) are skipped.
 */
export function splitReplayer(rec: Recording) {
  const ok = (r: Recording['responses'][number]) => {
    try {
      return outcome(r.body);
    } catch {
      return null;
    }
  };
  const lineAnswers = new Map<string, unknown>();
  const checkAnswers = new Map<string, unknown>();
  const overviews = new Map<number, ReaderResult>();
  let provider: string | undefined;
  for (const r of rec.responses) {
    const res = ok(r);
    if (!res) continue;
    provider ??= res.provider;
    if (r.mode === 'overview') overviews.set(r.page, res);
    if (r.mode === 'line') for (const l of ((res.line as { lines?: { line: number }[] }).lines ?? [])) lineAnswers.set(`${r.page}:${l.line}`, l);
    if (r.mode === 'check') for (const l of ((res.check as { lines?: { line: number }[] }).lines ?? [])) checkAnswers.set(`${r.page}:${r.round}:${l.line}`, l);
  }
  return async (req: ReaderRequest): Promise<ReaderResult> => {
    const page = Number(req.fields.page ?? 1);
    if (req.mode === 'overview') return overviews.get(page) ?? { overview: {} };
    if (req.mode === 'line') {
      const first = Number(req.fields.line);
      const lines = req.images.map((_, k) => lineAnswers.get(`${page}:${first + k}`)).filter(Boolean);
      return { line: { lines }, provider };
    }
    const numbers = JSON.parse(String(req.fields.line_numbers)) as number[];
    return { check: { lines: numbers.map((n) => checkAnswers.get(`${page}:${req.fields.round}:${n}`) ?? { line: n, mismatches: [], measures: null }) }, provider };
  };
}
