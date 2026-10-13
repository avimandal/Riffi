import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { compareScores } from '../../src/sheet/accuracy';
import { OmrError, type ReaderRequest, type ReaderResult } from '../../src/sheet/omrClient';
import { RequestPacer } from '../../src/sheet/pacer';
import { markPickup, normaliseLine, readPrepared, type ReadProgress } from '../../src/sheet/reader';
import type { RnMeasure, RnScore } from '../../src/sheet/notation';

const ref = JSON.parse(readFileSync(new URL('../fixtures/sheets/hermans-hornpipe.reference.json', import.meta.url), 'utf8')) as RnScore & {
  lines: [number, number][];
  uncertain: number[];
};
const lineBars = (i: number) => ref.measures.filter((m) => Number(m.n) >= ref.lines[i][0] && Number(m.n) <= ref.lines[i][1]);
const blob = (s: string) => new Blob([s]);
const page = { context: blob('page'), lines: ref.lines.map((_, i) => blob(`line ${i + 1}`)), detected: true };
const instant = { now: () => 0, sleep: async () => undefined };

/** A pretend reader: line 1 comes back wrong at first, and the double-check fixes it. */
function fakeServer() {
  const calls: ReaderRequest[] = [];
  const correctLine = (line: number) => lineBars(line - 1).map(({ n, ...m }) => ({ n, ...m }));
  const send = async (req: ReaderRequest): Promise<ReaderResult> => {
    calls.push(req);
    if (req.mode === 'overview') {
      return { overview: { title: "Herman's hornpipe", key: 2, time: '4/4', pickup: true, pickup_notes: 'A5e', first_bars: [null, 4, 7, 10, 13, 16, 19] }, provider: 'gemini' };
    }
    if (req.mode === 'line') {
      const first = Number(req.fields.line);
      const lines = req.images.map((_, k) => {
        const line = first + k;
        const correct = correctLine(line);
        if (line === 1) {
          // No pickup, bar 1 going up instead of down, and the key not applied in bar 2.
          const wrong: RnMeasure[] = [
            { n: 1, key: 2, time: '4/4', repeat: 'start', s1: 'D4s F#4s A4s D5s E5s C#5s A4s D5s B4s G4s D4s B4s A4s F#4s D4s F#4s' },
            { n: 2, s1: 'E4s C4s E4s A4s F#4s D4s F#4s A4s E4s B4s G#4s B4s A4s C#5s E5s A5s' },
            correct[3],
          ];
          return { line, measures: wrong, unsure: [] };
        }
        return { line, measures: correct, unsure: line === 7 ? [21] : [] };
      });
      return { line: { lines, warnings: [] } };
    }
    // check
    const sent = JSON.parse(String(req.fields.transcriptions)) as { measures: RnMeasure[] }[];
    const numbers = JSON.parse(String(req.fields.line_numbers)) as number[];
    const problems = JSON.parse(String(req.fields.problems)) as string[][];
    expect(req.images).toHaveLength(sent.length * 2);
    return {
      check: {
        lines: sent.map((t, k) => {
          const line = numbers[k];
          const correct = correctLine(line);
          const same = JSON.stringify(t.measures.map((m) => m.s1)) === JSON.stringify(correct.map((m) => m.s1));
          if (same) return { line, mismatches: [], measures: null, unsure: line === 7 ? [21] : [] };
          expect(problems[k].join(' ')).toContain('C4');
          return { line, mismatches: [{ bar: 1, what: 'pitch', detail: 'bar 1 goes down from F#5' }, { bar: 0, what: 'pickup', detail: 'missing A5 pickup' }], measures: correct };
        }),
      },
    };
  };
  return { calls, send };
}

describe('line-by-line reader', () => {
  it('one line per request: reads each line, double-checks, fixes line 1 and stops early on clean lines', async () => {
    const { calls, send } = fakeServer();
    const progress: ReadProgress[] = [];
    const engraved: number[] = [];
    const result = await readPrepared([page], {
      instrument: 'violin',
      linesPerRequest: 1,
      send,
      render: async (measures) => {
        engraved.push(measures.length);
        return blob('png');
      },
      onProgress: (p) => progress.push(p),
      pacer: new RequestPacer({ rpm: 100, ...instant }),
    });

    // 1 overview + 7 line reads, then a check for each line, then line 1 again (its round 1 changed it).
    expect(calls.map((c) => `${c.mode}${c.fields.line ?? ''}`)).toEqual(['overview', 'line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7', 'check1', 'check2', 'check3', 'check4', 'check5', 'check6', 'check7', 'check1']);
    // The carried key, time and bar numbers go with each line.
    const line2 = calls.find((c) => c.mode === 'line' && c.fields.line === 2)!;
    expect(line2.fields).toMatchObject({ key: 2, time: '4/4', first_bar: 4, lines: 7 });
    expect(calls[1].fields).toMatchObject({ pickup: 'yes', pickup_notes: 'A5e', first_bar: 1 });
    expect(calls[8].images.map((i) => i.name)).toEqual(['line-1-1.jpg', 'engraving-1-1.png']);

    const r = compareScores(result.score, ref);
    expect(r.pitch).toBe(1);
    expect(r.rhythm).toBe(1);
    expect(r.key.ok && r.time.ok && r.pickup.ok).toBe(true);
    // The first read of line 1 was worse.
    const first = compareScores({ ...ref, measures: [...result.trace.lines[0].firstRead, ...result.score.measures.slice(4)] }, ref);
    expect(first.pickup.ok).toBe(false);
    expect(first.pitch).toBeLessThan(1);
    expect(result.trace.lines[0].firstProblems.map((p) => p.kind)).toContain('key');

    // Flags: only the bar the reader was unsure about.
    expect(result.flags).toEqual([{ index: 21, n: 21, reasons: ["The music reader wasn't sure about bar 21."] }]);
    expect(result.musicxml).toContain("<work-title>Herman's hornpipe</work-title>");
    // Which line of the photo each bar came from (for checking against the photo later), and who read it.
    expect(result.lineBars[0]).toEqual({ page: 1, line: 1, from: 0, to: 3 });
    expect(result.lineBars.at(-1)?.to).toBe(result.score.measures.length - 1);
    expect(result.trace.provider).toBe('gemini');
    expect(progress.some((p) => p.stage === 'checking' && p.line === 1 && p.round === 2)).toBe(true);
    expect(progress.some((p) => p.stage === 'reading' && p.line === 7 && p.lines === 7)).toBe(true);
    expect(engraved[0]).toBe(3);
  });

  it('whole page per request (the free-tier default): overview + 1 read + checks in halves', async () => {
    const { calls, send } = fakeServer();
    const progress: ReadProgress[] = [];
    const result = await readPrepared([page], { instrument: 'violin', send, render: async () => blob('png'), onProgress: (p) => progress.push(p), pacer: new RequestPacer({ rpm: 100, ...instant }) });
    // Checks carry two pictures per line, so 4 lines each; then line 1's second look.
    expect(calls.map((c) => `${c.mode}:${c.images.length}`)).toEqual(['overview:1', 'line:7', 'check:8', 'check:6', 'check:2']);
    expect(JSON.parse(String(calls[4].fields.line_numbers))).toEqual([1]);
    expect(compareScores(result.score, ref).pitch).toBe(1);
    expect(progress.some((p) => p.stage === 'reading' && p.line === 1 && p.lineTo === 7)).toBe(true);
    expect(result.flags.map((f) => f.n)).toEqual([21]);
  });

  it('keeps the first read when a double-check fails', async () => {
    const { send } = fakeServer();
    const failing = async (req: ReaderRequest) => {
      if (req.mode === 'check') throw new OmrError('unreadable', 'x1', 'unreadable');
      return send(req);
    };
    const result = await readPrepared([page], { instrument: 'violin', send: failing, render: async () => blob('png'), pacer: new RequestPacer({ rpm: 100, ...instant }) });
    expect(result.score.measures).toHaveLength(21);
    expect(result.trace.lines[0].checkSkipped).toBe('double-check failed (unreadable)');
    // Line 1's problems are still flagged for the review screen.
    expect(result.flags.some((f) => f.n === 2)).toBe(true);
  });

  it('passes measured note heads as hints and flags bars that disagree with them', async () => {
    const { calls, send } = fakeServer();
    const head = (step: number, x: number) => ({ x, step });
    // Heads for line 2 that say bar 4 starts E4 C4 E4 A4 …: steps 0 -2 0 3; give 16 "wrong" ones for bar 5 instead.
    const stepOf: Record<string, number> = { C4: -2, D4: -1, E4: 0, F4: 1, G4: 2, A4: 3, B4: 4, C5: 5, D5: 6, E5: 7, F5: 8, G5: 9, A5: 10 };
    const names = (s1: string) => [...s1.matchAll(/([A-G])(?:##|#|bb|b|n)?(\d)/g)].map((m) => `${m[1]}${m[2]}`);
    const line2 = lineBars(1).flatMap((m, k) => names(m.s1!).map((nm) => (k === 1 ? 'C4' : nm)));
    const heads = ref.lines.map((_, i) => [i === 1 ? line2.map((nm, j) => head(stepOf[nm], j * 10)) : []]);
    const result = await readPrepared([{ ...page, heads }], { instrument: 'violin', send, checkRounds: 0, pacer: new RequestPacer({ rpm: 100, ...instant }) });
    const hints = JSON.parse(String(calls[1].fields.hints)) as string[];
    expect(hints[1].startsWith('E4 C4 E4 A4')).toBe(true);
    expect(hints[0]).toBe('');
    const bar5 = result.flags.find((f) => f.n === 5);
    expect(bar5?.reasons.join(' ')).toContain("don't match the note heads measured on the photo");
    expect(result.flags.find((f) => f.n === 4)).toBeUndefined();
  });

  it('flags bars that still fail the code checks, and works without double-checking', async () => {
    const { send } = fakeServer();
    const result = await readPrepared([page], { instrument: 'violin', send, checkRounds: 0, pacer: new RequestPacer({ rpm: 100, ...instant }) });
    // Line 1 stays as first read: bar 2 has C4 without the key's sharp.
    const bar2 = result.flags.find((f) => f.n === 2);
    expect(bar2?.reasons.join(' ')).toContain('no sharp or flat');
    // The short first bar wasn't marked as a pickup, but it's full here (bar 1), so no pickup.
    expect(result.score.measures[0].n).toBe(1);
  });

  it('numbers bars in order and spots an unmarked pickup', () => {
    const m = normaliseLine([{ n: 5, s1: 'A5e' }, { n: 5, s1: 'D5w' }, { s1: 'D5w' }], 1, true);
    expect(m.map((x) => x.n)).toEqual([1, 2, 3]);
    const p = markPickup(m, '4/4');
    expect(p.map((x) => [x.n, x.pickup ?? false])).toEqual([
      [0, true],
      [1, false],
      [2, false],
    ]);
    expect(normaliseLine([{ n: 0, pickup: true, s1: 'A5e' }, { s1: 'D5w' }], 1, true).map((x) => x.n)).toEqual([0, 1]);
    // Only the piece's first line may start with a pickup.
    expect(normaliseLine([{ n: 0, pickup: true, s1: 'A5e' }], 4, false)[0]).toEqual({ n: 4, s1: 'A5e' });
  });
});

describe('request pacer', () => {
  it('keeps to the per-minute limit', async () => {
    let t = 0;
    const waits: number[] = [];
    const pacer = new RequestPacer({ rpm: 2, now: () => t, sleep: async (ms) => void (t += ms) });
    for (let i = 0; i < 3; i++) await pacer.run(async () => i, (s) => waits.push(s));
    expect(t).toBeGreaterThanOrEqual(60_000);
    expect(waits[0]).toBe(61);
  });

  it('waits as long as the server asks when busy, then retries', async () => {
    let t = 0;
    let n = 0;
    const pacer = new RequestPacer({ rpm: 100, now: () => t, sleep: async (ms) => void (t += ms) });
    const out = await pacer.run(async () => {
      if (n++ === 0) throw new OmrError('busy', 'abc', 'busy', 23);
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(t).toBe(23_000);
  });

  it('gives up on errors that waiting will not fix, and after too long', async () => {
    const pacer = new RequestPacer({ rpm: 100, ...instant });
    await expect(pacer.run(async () => Promise.reject(new OmrError('settings', undefined, 'bad_key')))).rejects.toMatchObject({ kind: 'settings' });
    let t = 0;
    const slow = new RequestPacer({ rpm: 100, maxWaitMs: 30_000, now: () => t, sleep: async (ms) => void (t += ms) });
    await expect(slow.run(async () => Promise.reject(new OmrError('busy', undefined, 'busy', 40)))).rejects.toMatchObject({ kind: 'busy', code: 'gave_up_waiting' });
  });
});
