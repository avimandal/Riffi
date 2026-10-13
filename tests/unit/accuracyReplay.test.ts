import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareScores, firstReadScore, formatReport } from '../../src/sheet/accuracy';
import { replayer, splitReplayer, type Recording } from '../fixtures/replay';
import { RequestPacer } from '../../src/sheet/pacer';
import { readPrepared } from '../../src/sheet/reader';
import type { RnScore } from '../../src/sheet/notation';

/**
 * Replays recorded runs of the real music reader (made by
 * `npx playwright test -c playwright.live.config.ts` with an API key) through
 * the app's pipeline, so CI checks the line-by-line logic against real AI
 * replies and the accuracy numbers stay as recorded.
 */

const dir = join(process.cwd(), 'tests/fixtures/sheets');
const recDir = join(dir, 'recordings');
const recordings = existsSync(recDir) ? readdirSync(recDir).filter((f) => f.endsWith('.json')) : [];

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

    // The same answers, split into smaller requests read in parallel, must give the same music.
    it.each([1, 3])(`replays ${file} at %i line(s) per request, in parallel, with the same accuracy`, async (linesPerRequest) => {
      const rec = JSON.parse(readFileSync(join(recDir, file), 'utf8')) as Recording;
      const ref = JSON.parse(readFileSync(join(dir, rec.fixture.replace(/\.[^.]+$/, '.reference.json')), 'utf8')) as RnScore;
      const pages = rec.lines.map((n, p) => ({ context: new Blob(['page']), lines: Array.from({ length: n }, () => new Blob(['line'])), heads: rec.heads?.[p], detected: true }));
      const result = await readPrepared(pages, {
        instrument: rec.instrument,
        send: splitReplayer(rec),
        linesPerRequest,
        parallel: 3,
        render: async () => new Blob(['png']),
        pacer: new RequestPacer({ rpm: 1000, now: () => 0, sleep: async () => undefined }),
      });
      const final = compareScores(result.score, ref);
      const first = compareScores(firstReadScore(result.score, result.trace.lines), ref);
      expect(result.failed).toEqual([]);
      expect([first.pitch, first.rhythm, final.pitch, final.rhythm].map((x) => x.toFixed(6))).toEqual(
        [rec.report.first.pitch, rec.report.first.rhythm, rec.report.final.pitch, rec.report.final.rhythm].map((x) => x.toFixed(6)),
      );
    });
  }
});
