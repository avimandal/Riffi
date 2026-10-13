import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OmrError, type ReaderRequest, type ReaderResult } from '../../src/sheet/omrClient';
import { RequestPacer } from '../../src/sheet/pacer';
import { readPrepared } from '../../src/sheet/reader';
import { splitReplayer, type Recording } from '../fixtures/replay';

/**
 * How long reading the recorded page takes, before and after reading lines in
 * parallel, replayed from the recording on a simulated clock (no live calls).
 *
 * The AI's own speed is a model, calibrated on the recorded run: its 7-line
 * request streamed for well over 48 s (12 keep-alive pings, each sent only
 * after 4 s of silence), so a request costs about 5 s plus 8 s per line read
 * (61 s for 7 lines), and an overview about 6 s. A request still running at
 * the server's deadline ends as a timeout, as the real endpoint does.
 */
const rec = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/sheets/recordings/hermans-hornpipe.gemini-3.5-flash.json'), 'utf8')) as Recording;
const SCALE = 100; // simulated ms per real ms

function simulate(opts: { linesPerRequest: number; parallel: number; deadlineS: number; rpm: number; slow?: number; checkRounds?: number }) {
  const t0 = Date.now();
  const now = () => (Date.now() - t0) * SCALE;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms / SCALE));
  const replay = splitReplayer(rec);
  const firstLineAt: number[] = [];
  const send = async (req: ReaderRequest): Promise<ReaderResult> => {
    const lines = req.mode === 'check' ? req.images.length / 2 : req.images.length;
    const seconds = (req.mode === 'overview' ? 6 : 5 + (req.mode === 'check' ? 10 : 8) * lines) * (opts.slow ?? 1);
    if (seconds > opts.deadlineS) {
      await sleep(opts.deadlineS * 1000);
      throw new OmrError('timeout', undefined, 'timeout');
    }
    await sleep(seconds * 1000);
    return replay(req);
  };
  return readPrepared([{ context: new Blob(['page']), lines: Array.from({ length: rec.lines[0] }, () => new Blob(['line'])), heads: rec.heads?.[0], detected: true }], {
    instrument: 'violin',
    send,
    linesPerRequest: opts.linesPerRequest,
    parallel: opts.parallel,
    checkRounds: opts.checkRounds ?? 0,
    render: async () => new Blob(['png']),
    onLine: (p) => firstLineAt.length === 0 && p.musicxml && firstLineAt.push(now()),
    pacer: new RequestPacer({ rpm: opts.rpm, now, sleep }),
  }).then(
    (r) => ({ seconds: Math.round(now() / 1000), firstLines: Math.round((firstLineAt[0] ?? now()) / 1000), requests: r.timings.requests.length, failed: r.failed.length, bars: r.score.measures.length }),
    (e: OmrError) => ({ seconds: Math.round(now() / 1000), firstLines: null, requests: null, failed: rec.lines[0], bars: 0, error: e.code }),
  );
}

describe('reading time on the recorded page (simulated clock)', () => {
  it('reads faster in parallel, and a slow day never loses the page', async () => {
    // Before this change (measured the same way with the old code): 73 s for the page, nothing shown until the
    // end; on a slow day (×1.5) its one 7-line request ran past the 85 s deadline twice and the page was lost at 180 s.
    // After: 3 lines per request (the free-tier recommendation), 3 at once, 60 s deadline.
    const after3 = await simulate({ linesPerRequest: 3, parallel: 3, deadlineS: 60, rpm: 8 });
    const after3Slow = await simulate({ linesPerRequest: 3, parallel: 3, deadlineS: 60, rpm: 8, slow: 1.5 });
    // A paid key: one line per request, 3 at once.
    const after1 = await simulate({ linesPerRequest: 1, parallel: 3, deadlineS: 60, rpm: 40 });
    const after1Slow = await simulate({ linesPerRequest: 1, parallel: 3, deadlineS: 60, rpm: 40, slow: 1.5 });
    const rows = { after3, after3Slow, after1, after1Slow };
    console.table(rows);

    // Normal day: well under the old 73 s, and the first lines show up within about half a minute.
    expect(after3.seconds).toBeLessThan(55);
    expect(after3.firstLines).toBeLessThan(35);
    expect(after1.firstLines).toBeLessThan(35);
    // A slow day: every line still arrives, no request near the deadline.
    expect([after3Slow.failed, after1Slow.failed]).toEqual([0, 0]);
    expect(after3Slow.bars).toBe(23);
  });
});
