import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { checkLine, keyAlters } from '../../src/sheet/checks';
import { compareScores, formatReport } from '../../src/sheet/accuracy';
import type { RnMeasure, RnScore } from '../../src/sheet/notation';

const ref = JSON.parse(readFileSync(new URL('../fixtures/sheets/hermans-hornpipe.reference.json', import.meta.url), 'utf8')) as RnScore & {
  lines: [number, number][];
  uncertain: number[];
};

const bars = (from: number, to: number) => ref.measures.filter((m) => Number(m.n) >= from && Number(m.n) <= to);

describe('code checks', () => {
  it('the hand-made reference passes every check, line by line', () => {
    ref.lines.forEach(([from, to], i) => {
      const problems = checkLine(bars(from, to), {
        key: i === 0 ? undefined : 2,
        time: i === 0 ? undefined : '4/4',
        instrument: 'violin',
        firstLine: i === 0,
        lastLine: i === ref.lines.length - 1,
      });
      expect(problems, `line ${i + 1}`).toEqual([]);
    });
  });

  it('knows which notes a key signature changes', () => {
    expect(keyAlters(2)).toEqual({ F: 1, C: 1 });
    expect(keyAlters(-2)).toEqual({ B: -1, E: -1 });
    expect(keyAlters(0)).toEqual({});
  });

  const line = (ms: RnMeasure[], extra: Partial<Parameters<typeof checkLine>[1]> = {}) => checkLine(ms, { key: 2, time: '4/4', instrument: 'violin', ...extra });

  it('finds bars that do not add up (but allows a pickup)', () => {
    expect(line([{ n: 3, s1: 'F#5s D5s A4s F#5s E5q' }])).toEqual([{ n: 3, kind: 'duration', message: 'Bar 3 adds up to 2 beats instead of 4 beats.' }]);
    expect(line([{ n: 0, pickup: true, s1: 'A5e' }], { firstLine: true })).toEqual([]);
    // A short first bar of the first line is fine even if not marked as a pickup.
    expect(line([{ n: 0, s1: 'A5e' }], { firstLine: true })).toEqual([]);
    // 2/2 bars are 4 quarters too, but 3/4 is not.
    expect(line([{ n: 1, time: '3/4', s1: 'D5q D5q D5q D5q' }])[0].message).toBe('Bar 1 adds up to 4 beats instead of 3 beats.');
  });

  it('finds a missing key or time signature on the first line', () => {
    const p = checkLine([{ n: 1, s1: 'D5w' }], { instrument: 'violin', firstLine: true });
    expect(p.map((x) => x.kind)).toEqual(['key', 'time']);
  });

  it('spots notes where the key signature was not applied', () => {
    const p = line([{ n: 1, s1: 'F5s D5s A4s F5s C5q Cn5q F#5q' }]);
    expect(p).toHaveLength(1);
    expect(p[0].kind).toBe('key');
    expect(p[0].message).toContain('F5, C5');
    // A written natural is fine, and carries on through the bar.
    expect(line([{ n: 1, s1: 'Fn5q F5q C#5h' }])).toEqual([]);
  });

  it('spots notes outside the instrument range', () => {
    expect(line([{ n: 1, s1: 'D3q D5q D5h' }])[0].kind).toBe('range');
    expect(line([{ n: 1, s1: 'D3q D5q D5h' }], { instrument: 'piano' })).toEqual([]);
  });

  it('spots tuplets with the wrong number of notes', () => {
    const p = line([{ n: 1, s1: 'D5q D5q D5q 3( C#5s D5s )' }]);
    expect(p.map((x) => x.kind)).toContain('tuplet');
    expect(line([{ n: 1, s1: 'D5q D5q D5q 3( C#5s D5s E5s' }]).map((x) => x.kind)).toContain('tuplet');
  });

  it('reports bad tokens', () => {
    expect(line([{ n: 4, s1: 'D5q X5q' }])[0].kind).toBe('syntax');
  });
});

describe('accuracy report', () => {
  it('the reference scores 100% against itself', () => {
    const r = compareScores(ref, ref);
    expect(r.pitch).toBe(1);
    expect(r.rhythm).toBe(1);
    expect(r.key.ok && r.time.ok && r.pickup.ok).toBe(true);
    expect(r.bars.find((b) => b.n === 21)?.uncertain).toBe(true);
  });

  it('a missing pickup and wrong time signature are reported, and later bars still line up', () => {
    const pred: RnScore = { ...ref, measures: ref.measures.slice(1).map((m, i) => (i === 0 ? { ...m, key: 2, time: '2/2' } : m)) };
    const r = compareScores(pred, ref);
    expect(r.pickup).toEqual({ ok: false, detail: 'pickup bar missing' });
    expect(r.time).toEqual({ ref: '4/4', got: '2/2', ok: false });
    expect(r.bars.find((b) => b.n === 5)?.pitch).toBe(1);
    expect(r.pitch).toBeLessThan(1);
    expect(r.pitch).toBeGreaterThan(0.99);
  });

  it('wrong pitches and rhythms lower the scores of just that bar', () => {
    const measures = ref.measures.map((m) => (m.n === 1 ? { ...m, s1: 'F#5s D5s A4s F#5s E5s C#5s A4s D5s B4s G4s D4s B4s A4e D4s F#4s' } : m));
    const r = compareScores({ ...ref, measures }, ref);
    const b1 = r.bars.find((b) => b.n === 1)!;
    expect(b1.pitchMatched).toBe(15);
    expect(b1.pitch).toBeCloseTo(15 / 16);
    // Only the A4 that became an eighth is off; D4 and F#4 still land on their beats.
    expect(b1.rhythm).toBeCloseTo(14 / 16);
    expect(r.bars.find((b) => b.n === 2)?.pitch).toBe(1);
  });

  it('prints a per-bar table', () => {
    expect(formatReport(compareScores(ref, ref))).toContain('bar  notes  pitch');
  });

});
