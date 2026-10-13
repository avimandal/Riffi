import { describe, expect, it } from 'vitest';
import { buildBeatGrid, countInMs } from '../../src/audio/beats';
import { renderClick } from '../../src/audio/click';
import { median, resample, StreamingResampler } from '../../src/audio/dsp';
import { detectClickOnsets, estimateLatency, measureNoiseFloor } from '../../src/audio/latency';
import { fitWithin } from '../../src/screens/add/imagePrep';
import { buildTimeline } from '../../src/sheet/expected';
import { strings } from '../../src/i18n/en-AU';
import { addNoise, addTone, blank, SR } from '../fixtures/audio';
import { fixture } from '../fixtures/load';

describe('metronome beat grid', () => {
  it('has a one-bar count-in then every beat, accent on beat 1', () => {
    const tl = buildTimeline(fixture('twinkle.musicxml'), 60);
    const beats = buildBeatGrid(tl);
    expect(beats.filter((b) => b.countIn).map((b) => b.timeMs)).toEqual([-4000, -3000, -2000, -1000]);
    expect(countInMs(tl)).toBe(4000);
    const piece = beats.filter((b) => !b.countIn);
    expect(piece).toHaveLength(32);
    expect(piece.filter((b) => b.accent)).toHaveLength(8);
    expect(piece[4]).toMatchObject({ timeMs: 4000, accent: true, bar: 1 });
  });

  it('clicks eighths in 6/8 and handles a pickup bar', () => {
    const tl = buildTimeline(fixture('pickup.musicxml'), 60);
    const beats = buildBeatGrid(tl).filter((b) => !b.countIn);
    expect(beats[0]).toMatchObject({ timeMs: 0, beat: 2, accent: false }); // pickup on beat 3
    expect(beats[1]).toMatchObject({ timeMs: 1000, accent: true });
  });
});

describe('latency calibration', () => {
  it('finds clicks and measures the delay', () => {
    const delay = 0.137;
    const sched = [0.4, 0.85, 1.3, 1.75, 2.2, 2.65];
    const buf = blank(3200);
    const click = renderClick(SR, true);
    for (const s of sched) {
      const at = Math.round((s + delay) * SR);
      for (let i = 0; i < click.length; i++) buf[at + i] += 0.5 * click[i];
    }
    addNoise(buf, 0.003);
    const detected = detectClickOnsets(buf, SR);
    const est = estimateLatency(sched, detected);
    expect(est.ok).toBe(true);
    expect(Math.abs(est.latencyMs - 137)).toBeLessThanOrEqual(3);
  });

  it('reports failure when no clicks are heard', () => {
    expect(estimateLatency([0.4, 0.8], []).ok).toBe(false);
  });

  it('measures the noise floor', () => {
    const buf = addNoise(blank(1000), 0.01);
    const floor = measureNoiseFloor(buf);
    expect(floor).toBeGreaterThan(0.004);
    expect(floor).toBeLessThan(0.008);
  });
});

describe('dsp', () => {
  it('resamples a tone without changing its pitch', () => {
    const buf = addTone(blank(1000), { midi: 69, startMs: 0, durationMs: 1000, amp: 0.5 });
    const rs = new StreamingResampler(SR, 22050);
    const parts: Float32Array[] = [];
    for (let i = 0; i < buf.length; i += 1000) parts.push(rs.push(buf.subarray(i, i + 1000)));
    const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
    }
    expect(Math.abs(out.length - 22050)).toBeLessThan(3);
    // Count zero crossings → ~440 Hz.
    let z = 0;
    for (let i = 2000; i < out.length - 1; i++) if (out[i] <= 0 && out[i + 1] > 0) z++;
    expect(Math.abs(z / ((out.length - 2001) / 22050) - 440)).toBeLessThan(3);
    expect(resample(buf, SR, 24000).length).toBe(24000);
  });

  it('takes a median', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe('photo prep', () => {
  it('fits the long edge within 2000 px', () => {
    expect(fitWithin(4032, 3024, 2000)).toEqual({ w: 2000, h: 1500 });
    expect(fitWithin(800, 600, 2000)).toEqual({ w: 800, h: 600 });
  });
});

describe('copy tone rules (SPEC §9)', () => {
  function allStrings(v: unknown, out: string[] = []): string[] {
    if (typeof v === 'string') out.push(v);
    else if (typeof v === 'function') {
      // Call with sample arguments to see the text.
      const r = (v as (...a: unknown[]) => unknown)('X', 'Y', 'Z');
      if (typeof r === 'string') out.push(r);
      const n = (v as (...a: unknown[]) => unknown)(2, 3, 4);
      if (typeof n === 'string') out.push(n);
    } else if (v && typeof v === 'object') Object.values(v).forEach((x) => allStrings(x, out));
    return out;
  }
  const all = allStrings(strings);

  it('never says "wrong" or "bad"', () => {
    // "Retry all failed lines" is the button's agreed wording (it's about lines of the photo, not the kid).
    const offenders = all.filter((s) => s !== 'Retry all failed lines' && /\b(wrong|bad|badly|fail|failed)\b/i.test(s));
    expect(offenders).toEqual([]);
  });

  it('uses Australian spelling', () => {
    const us = all.filter((s) => /\b(color|favorite|practicing|practiced|center|behavior|recognize|organize)\b/i.test(s));
    expect(us).toEqual([]);
  });
});
