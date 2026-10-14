import { describe, expect, it } from 'vitest';
import { MonoEngine } from '../../src/engines/mono/monoEngine';
import { TUNER_RANGE, TunerSmoother, tunerReading, type TunerReading } from '../../src/gadget/tuner';
import { addTone, blank, SR, VIOLINISH } from '../fixtures/audio';
import { feed, shiftCents, throughPhone, violinClip, type Clip, type PhoneOptions } from '../fixtures/violinAudio';

/**
 * The tuner on real violin recordings (tests/fixtures/violin, CC0) through
 * simulated phone mics, the way the Tuner screen reads it: the engine's pitch
 * sampled every animation frame, steadied by TunerSmoother.
 */
function tune(clip: Clip): { shown: TunerReading[]; pitches: number[] } {
  const eng = new MonoEngine({ instrument: 'voice', range: TUNER_RANGE.violin, sampleRate: clip.sampleRate });
  const sm = new TunerSmoother();
  const shown: TunerReading[] = [];
  const pitches: number[] = [];
  let next = 0;
  feed(clip, (b, t) => {
    eng.process(b, t);
    if (t < next) return;
    next = t + 16.7;
    const v = sm.push(eng.reading ? eng.reading.midi : null, t);
    if (v === null) return;
    shown.push(tunerReading(v, 440, 'violin', null));
    if (t > 700) pitches.push(v);
  });
  return { shown, pitches };
}

const OPEN = [
  { name: 'G3', midi: 55, files: ['arco_G3_f', 'arco_G3_p'] },
  { name: 'D4', midi: 62, files: ['arco_D4_f_from_E4', 'arco_D4_p_from_E4'] },
  { name: 'A4', midi: 69, files: ['arco_A4_f', 'arco_A4_p'] },
  { name: 'E5', midi: 76, files: ['arco_E5_f', 'arco_E5_p'] },
];
const PHONES: PhoneOptions[] = [
  { highpassHz: 150, noise: 0.002, seed: 4 },
  { highpassHz: 450, noise: 0.004, peak: 0.12, seed: 2 },
];

describe('tuner on real violin recordings', () => {
  for (const s of OPEN) {
    it(`names the open ${s.name} string right every time, and in tune / out of tune right`, () => {
      for (const file of s.files) {
        const raw = violinClip(file);
        // Where the recording itself sits (the players weren't tuning to exactly A = 440).
        const own = tune(raw).pitches;
        const offCents = ((own.reduce((a, x) => a + x, 0) / own.length) - s.midi) * 100;
        for (const phone of PHONES) {
          for (const want of [0, -5, 5, -25, 25]) {
            const { shown } = tune(throughPhone(shiftCents(raw, want - offCents), phone));
            expect(shown.length, `${file} ${want}c`).toBeGreaterThan(40);
            // Every frame shown names the right string (no overtone / octave errors).
            expect(shown.filter((r) => r.target !== s.midi).map((r) => r.target), `${file} ${want}c ${JSON.stringify(phone)}`).toEqual([]);
            const settled = shown.slice(Math.floor(shown.length / 4));
            const status = Math.abs(want) <= 10 ? 'in' : want < 0 ? 'flat' : 'sharp';
            const share = settled.filter((r) => r.status === status).length / settled.length;
            expect(share, `${file} ${want}c shown ${status}`).toBeGreaterThanOrEqual(0.95);
          }
        }
      }
    });
  }

  it('shows a steady open string within ±10 cents as in tune', () => {
    // No vibrato on an open string: the reading must sit still.
    for (const midi of [55, 62, 69, 76]) {
      for (const cents of [-9, 9]) {
        const buf = addTone(blank(2000), { midi: midi + cents / 100, startMs: 0, durationMs: 2000, harmonics: [0.15, 1, 0.8, 0.5, 0.35, 0.2], attackMs: 60 });
        const { shown } = tune(throughPhone({ samples: buf, sampleRate: SR }, { highpassHz: 300, noise: 0.003, seed: 9 }));
        const settled = shown.slice(Math.floor(shown.length / 4));
        expect(settled.every((r) => r.target === midi && r.status === 'in'), `${midi} ${cents}c`).toBe(true);
      }
    }
  });
});

describe('TunerSmoother', () => {
  it('ignores a brief overtone blip and averages out vibrato', () => {
    const sm = new TunerSmoother();
    let last: number | null = null;
    for (let t = 0; t < 1500; t += 16) {
      // G3 with ±20 cent vibrato; a twelfth (D5) pops out for ~100 ms.
      const midi = t > 600 && t < 700 ? 74 : 55 + 0.2 * Math.sin((2 * Math.PI * 5.5 * t) / 1000);
      last = sm.push(midi, t);
      if (t > 200) expect(Math.abs((last ?? 0) - 55)).toBeLessThan(0.06);
    }
  });

  it('moves to a new note once it holds, and lets go after silence', () => {
    const sm = new TunerSmoother();
    for (let t = 0; t < 500; t += 16) sm.push(55, t);
    let v: number | null = null;
    for (let t = 500; t < 800; t += 16) v = sm.push(62, t);
    expect(v).toBeCloseTo(62, 5);
    for (let t = 800; t < 1900; t += 16) v = sm.push(null, t);
    expect(v).toBeCloseTo(62, 5);
    expect(sm.push(null, 2100)).toBeNull();
  });
});

describe('overtone guard', () => {
  it('finds the fundamental of a tone whose fundamental is almost gone', () => {
    // Soft G string through a small mic: the 3rd harmonic dominates.
    const buf = addTone(blank(1200), { midi: 55, startMs: 0, durationMs: 1200, harmonics: [0.03, 0.2, 1, 0.3, 0.25, 0.1], attackMs: 40 });
    const eng = new MonoEngine({ instrument: 'violin', sampleRate: SR });
    const seen: number[] = [];
    feed({ samples: buf, sampleRate: SR }, (b, t) => {
      eng.process(b, t);
      if (eng.reading) seen.push(Math.round(eng.reading.midi));
    });
    expect(seen.length).toBeGreaterThan(50);
    expect(seen.filter((m) => m !== 55)).toEqual([]);
  });

  it('leaves real notes alone (violin recordings, every note)', () => {
    for (const [file, midi] of [['arco_C4_f', 60], ['arco_E4_f', 64], ['arco_G4_f', 67], ['arco_A3_f', 57], ['arco_C5_f', 72], ['spic_G4', 67], ['spic_E5', 76], ['spic_G3', 55], ['spic_C5', 72]] as const) {
      const eng = new MonoEngine({ instrument: 'violin', sampleRate: 44100 });
      const notes: number[] = [];
      feed(throughPhone(violinClip(file), { highpassHz: 250, noise: 0.003 }), (b, t) => eng.process(b, t));
      for (const n of eng.finish()) notes.push(Math.round(n.midi));
      expect(notes.length, file).toBeGreaterThan(0);
      expect(notes.filter((m) => m !== midi), file).toEqual([]);
    }
  });
});
