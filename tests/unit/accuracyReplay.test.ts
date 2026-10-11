import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareScores, firstReadScore, formatReport } from '../../src/sheet/accuracy';
import { kindForCode, OmrError, type ReaderRequest, type ReaderResult } from '../../src/sheet/omrClient';
import { RequestPacer } from '../../src/sheet/pacer';
import { readPrepared } from '../../src/sheet/reader';
import type { RnScore } from '../../src/sheet/notation';
import type { Instrument } from '../../src/config';

/**
 * Replays recorded runs of the real music reader (made by
 * `npx playwright test -c playwright.live.config.ts` with an API key) through
 * the app's pipeline, so CI checks the line-by-line logic against real AI
 * replies and the accuracy numbers stay as recorded.
 */

const dir = join(process.cwd(), 'tests/fixtures/sheets');
const recDir = join(dir, 'recordings');
const recordings = existsSync(recDir) ? readdirSync(recDir).filter((f) => f.endsWith('.json')) : [];

interface Recording {
  fixture: string;
  provider: string;
  model: string;
  instrument: Instrument;
  lines: number[];
  /** Note heads the browser measured on each page ([page][line][staff]), so pitch snapping replays too. */
  heads?: { x: number; step: number }[][][][];
  responses: { mode: string; page: number; line: number | null; round: number | null; body: string }[];
  report: Record<'first' | 'final', { pitch: number; rhythm: number; key: boolean; time: boolean; pickup: boolean }>;
}

function replayer(rec: Recording) {
  const used = new Set<number>();
  return async (req: ReaderRequest): Promise<ReaderResult> => {
    const want = (r: Recording['responses'][number]) =>
      r.mode === req.mode && r.page === Number(req.fields.page ?? 1) && (r.line ?? null) === (req.fields.line === undefined ? null : Number(req.fields.line)) && (r.round ?? null) === (req.fields.round === undefined ? null : Number(req.fields.round));
    const i = rec.responses.findIndex((r, k) => !used.has(k) && want(r));
    if (i < 0) throw new Error(`No recorded reply for ${req.mode} page ${req.fields.page} line ${req.fields.line} round ${req.fields.round}`);
    used.add(i);
    const body = rec.responses[i].body.trim();
    // A plain JSON error (sent before streaming started, e.g. the pace limit).
    if (body.startsWith('{"error"')) {
      const e = JSON.parse(body) as { code: string; ref?: string; retry_after?: number };
      throw new OmrError(kindForCode(e.code), e.ref, e.code, e.retry_after);
    }
    const last = JSON.parse(body.split('\n').pop()!) as { type: string; code?: string; ref?: string; retry_after?: number } & ReaderResult;
    if (last.type === 'error') throw new OmrError(kindForCode(last.code), last.ref, last.code, last.retry_after ?? undefined);
    return last;
  };
}

describe('recorded runs of the real music reader', () => {
  it.skipIf(recordings.length > 0)('(no recordings yet)', () => undefined);

  for (const file of recordings) {
    it(`replays ${file} and gets the recorded accuracy`, async () => {
      const rec = JSON.parse(readFileSync(join(recDir, file), 'utf8')) as Recording;
      const ref = JSON.parse(readFileSync(join(dir, rec.fixture.replace(/\.[^.]+$/, '.reference.json')), 'utf8')) as RnScore & { uncertain?: number[] };
      const pages = rec.lines.map((n, p) => ({ context: new Blob(['page']), lines: Array.from({ length: n }, () => new Blob(['line'])), heads: rec.heads?.[p], detected: true }));
      const result = await readPrepared(pages, {
        instrument: rec.instrument,
        send: replayer(rec),
        render: async () => new Blob(['png']),
        pacer: new RequestPacer({ rpm: 1000, now: () => 0, sleep: async () => undefined }),
      });
      const final = compareScores(result.score, ref);
      const first = compareScores(firstReadScore(result.score, result.trace.lines), ref);
      console.log(`${file} (${rec.provider} ${rec.model})\n${formatReport(first, 'FIRST READ: ')}\n${formatReport(final, 'AFTER CHECK: ')}`);
      expect(first.pitch).toBeCloseTo(rec.report.first.pitch, 6);
      expect(first.rhythm).toBeCloseTo(rec.report.first.rhythm, 6);
      expect(final.pitch).toBeCloseTo(rec.report.final.pitch, 6);
      expect(final.rhythm).toBeCloseTo(rec.report.final.rhythm, 6);
      expect([final.key.ok, final.time.ok, final.pickup.ok]).toEqual([rec.report.final.key, rec.report.final.time, rec.report.final.pickup]);
    });
  }
});
