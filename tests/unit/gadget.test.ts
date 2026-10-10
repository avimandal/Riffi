import { describe, expect, it } from 'vitest';
import { LookaheadScheduler } from '../../src/audio/scheduler';
import { METRONOME_SOUNDS, renderSound, SOUND_MS, type MetronomeSound } from '../../src/audio/sounds';
import { activePlayingMs } from '../../src/data/stats';
import { MONO_ENGINE, MonoEngine } from '../../src/engines/mono/monoEngine';
import {
  beatsPerBar,
  clampTempo,
  DEFAULT_METRONOME,
  nextTick,
  SUBDIVISIONS,
  tapTempo,
  tempoName,
  TIME_SIGNATURES,
  type MetronomeSettings,
  type Subdivision,
  type Tick,
} from '../../src/gadget/metronomeCore';
import { noteHz, toReference, TUNER_RANGE, tunerReading } from '../../src/gadget/tuner';
import { addNoise, addTone, blank, SR, VIOLINISH } from '../fixtures/audio';

describe('gadget metronome logic', () => {
  it('names tempos in Italian', () => {
    expect([30, 50, 63, 70, 90, 112, 132, 160, 180, 220].map(tempoName)).toEqual([
      'Grave', 'Largo', 'Larghetto', 'Adagio', 'Andante', 'Moderato', 'Allegro', 'Vivace', 'Presto', 'Prestissimo',
    ]);
  });

  it('keeps tempo within 30–250', () => {
    expect(clampTempo(10)).toBe(30);
    expect(clampTempo(300)).toBe(250);
    expect(clampTempo(120.4)).toBe(120);
  });

  it('works out tap tempo and starts over after a pause', () => {
    expect(tapTempo([1000])).toBeNull();
    expect(tapTempo([0, 500, 1000, 1500])).toBe(120);
    expect(tapTempo([0, 600, 5000, 5500, 6000])).toBe(120); // the old taps are ignored
  });

  it('counts the right beats for every time signature', () => {
    expect(TIME_SIGNATURES.map(beatsPerBar)).toEqual([2, 3, 4, 5, 6, 7, 12]);
  });

  it('makes ticks with subdivisions and an accent on beat 1', () => {
    const s: MetronomeSettings = { ...DEFAULT_METRONOME, bpm: 120, timeSignature: '3/4', subdivision: 'triplets' };
    let t: Tick | null = null;
    const ticks: Tick[] = [];
    for (let i = 0; i < 10; i++) ticks.push((t = nextTick(t, s, 1)));
    expect(ticks[0]).toMatchObject({ when: 1, beat: 0, sub: 0, level: 'accent' });
    expect(ticks[1]).toMatchObject({ beat: 0, sub: 1, level: 'sub' });
    expect(ticks[1].when).toBeCloseTo(1 + 0.5 / 3);
    expect(ticks[3]).toMatchObject({ beat: 1, sub: 0, level: 'beat' });
    expect(ticks[9]).toMatchObject({ beat: 0, sub: 0, level: 'accent' }); // bar 2
    expect(nextTick(null, { ...s, accent: false }, 0).level).toBe('beat');
  });

  it('applies a tempo change from the next click, on the shared lookahead scheduler', () => {
    const clock = { currentTime: 0 };
    let settings: MetronomeSettings = { ...DEFAULT_METRONOME, bpm: 60 };
    let last: Tick | null = null;
    const played: number[] = [];
    const sched = new LookaheadScheduler<Tick>(
      clock,
      { peek: () => nextTick(last, settings, 0.1), advance: () => (last = nextTick(last, settings, 0.1)) },
      (t) => played.push(t.when),
    );
    for (let now = 0; now < 2.05; now += 0.025) sched.tick((clock.currentTime = now));
    expect(played.map((x) => +x.toFixed(3))).toEqual([0.1, 1.1, 2.1]);
    settings = { ...settings, bpm: 120 };
    for (let now = 2.05; now < 3.2; now += 0.025) sched.tick((clock.currentTime = now));
    expect(played.slice(3).map((x) => +x.toFixed(3))).toEqual([2.6, 3.1]);
  });
});

describe('tuner logic', () => {
  it('reads cents against the reference pitch', () => {
    expect(tunerReading(69, 440, 'chromatic')).toMatchObject({ letter: 'A', sharp: false, octave: 4, cents: 0, status: 'in' });
    expect(tunerReading(69.2, 440, 'chromatic')).toMatchObject({ cents: 20, status: 'sharp' });
    // At A = 442, a 440 Hz A is about 8 cents flat.
    expect(tunerReading(69, 442, 'chromatic')).toMatchObject({ letter: 'A', cents: -8, status: 'flat' });
    expect(tunerReading(66.03, 440, 'voice')).toMatchObject({ letter: 'F', sharp: true, status: 'in' });
    expect(toReference(69, 440)).toBe(69);
    expect(noteHz(69, 442)).toBe(442);
  });

  it('tunes violin strings: the chosen one, or the nearest', () => {
    expect(tunerReading(55.6, 440, 'violin')).toMatchObject({ string: 'G', letter: 'G', cents: 60, status: 'sharp' });
    expect(tunerReading(68.7, 440, 'violin')).toMatchObject({ string: 'A', cents: -30, status: 'flat' });
    // With D chosen, an A is 7 semitones sharp of it.
    expect(tunerReading(69, 440, 'violin', 'D')).toMatchObject({ string: 'D', cents: 700 });
    // Far from any string: chromatic.
    expect(tunerReading(82, 440, 'violin')).toMatchObject({ letter: 'A', sharp: true, string: undefined });
  });
});

/**
 * The gadget must never hear itself: every metronome sound, at every
 * subdivision, is mixed into synthetic playing (and played alone), run
 * through the real mono engine with the gadget's masking, and only the
 * playing may count.
 */
describe('Count my practice never hears the metronome', () => {
  const BPM = 100;
  const DURATION_MS = 6000;

  function clickTimes(sub: Subdivision): { t: number; level: 'accent' | 'beat' | 'sub' }[] {
    const s: MetronomeSettings = { ...DEFAULT_METRONOME, bpm: BPM, subdivision: sub };
    const out: { t: number; level: 'accent' | 'beat' | 'sub' }[] = [];
    let tick: Tick | null = null;
    for (;;) {
      tick = nextTick(tick, s, 0.3);
      if (tick.when * 1000 > DURATION_MS - 200) break;
      out.push({ t: tick.when * 1000, level: tick.level });
    }
    return out;
  }

  function mixClicks(buf: Float32Array, kind: MetronomeSound, clicks: { t: number; level: 'accent' | 'beat' | 'sub' }[], gain: number) {
    for (const c of clicks) {
      const snd = renderSound(kind, SR, c.level);
      const at = Math.round((c.t / 1000) * SR);
      for (let i = 0; i < snd.length && at + i < buf.length; i++) buf[at + i] += gain * snd[i];
    }
  }

  function listen(buf: Float32Array, kind: MetronomeSound, clicks: { t: number }[], range = TUNER_RANGE.violin) {
    const e = new MonoEngine({ instrument: 'voice', range, sampleRate: SR });
    for (const c of clicks) e.addClick(c.t, SOUND_MS[kind]);
    for (let i = 0; i < buf.length; i += 1024) e.process(buf.subarray(i, i + 1024), (i / SR) * 1000);
    return e.finish();
  }

  // Legato violin-ish notes with vibrato, starting off the beat so onsets don't hide in masks.
  const melody = [69, 71, 72, 74, 76, 74, 72, 71];
  const NOTE_MS = 600;
  function playing(): Float32Array {
    const buf = blank(DURATION_MS);
    melody.forEach((m, i) =>
      addTone(buf, { midi: m, startMs: 500 + i * NOTE_MS, durationMs: NOTE_MS - 40, harmonics: VIOLINISH, vibratoCents: 30, amp: 0.25, attackMs: 40 }),
    );
    return buf;
  }
  const playedMs = melody.length * (NOTE_MS - 40);

  for (const kind of METRONOME_SOUNDS) {
    it(`${kind}: every sound is short enough to mask`, () => {
      for (const level of ['accent', 'beat', 'sub'] as const) {
        const snd = renderSound(kind, SR, level);
        expect(snd.length / SR * 1000).toBeLessThanOrEqual(SOUND_MS[kind] + 0.5);
        expect(Math.max(...snd.map(Math.abs))).toBeGreaterThan(0.05);
      }
    });

    for (const sub of SUBDIVISIONS) {
      it(`${kind}, ${sub}: clicks alone are never counted`, () => {
        const clicks = clickTimes(sub);
        const buf = addNoise(blank(DURATION_MS), 0.002);
        mixClicks(buf, kind, clicks, 1); // full volume, straight into the mic
        const notes = listen(buf, kind, clicks, TUNER_RANGE.chromatic);
        expect(notes).toEqual([]);
        expect(activePlayingMs(notes)).toBe(0);
      });

      it(`${kind}, ${sub}: playing with the clicks is counted, and only the playing`, () => {
        const clicks = clickTimes(sub);
        const buf = playing();
        mixClicks(buf, kind, clicks, 0.8);
        addNoise(buf, 0.002);
        const notes = listen(buf, kind, clicks);
        // Every note found, with the right pitch; nothing extra.
        expect(notes.map((n) => Math.round(n.midi))).toEqual(melody);
        const active = activePlayingMs(notes);
        expect(active).toBeGreaterThan(playedMs * 0.85);
        expect(active).toBeLessThan(playedMs * 1.1);
      });
    }
  }

  it("mutes listening while the tuner's reference tone plays", () => {
    const buf = blank(5000);
    // Reference A4 (with harmonics, like the gadget's tone) from 0.5 s to 3 s…
    addTone(buf, { midi: 69, startMs: 500, durationMs: 2500, harmonics: [1, 0.35, 0.15], amp: 0.3, attackMs: 50 });
    // …then the kid plays a D afterwards.
    addTone(buf, { midi: 62, startMs: 3600, durationMs: 1000, harmonics: VIOLINISH, amp: 0.25 });
    const e = new MonoEngine({ instrument: 'voice', range: TUNER_RANGE.violin, sampleRate: SR });
    e.addMask(500 - MONO_ENGINE.clickPreMs, 3000 + 200);
    const readings: number[] = [];
    for (let i = 0; i < buf.length; i += 1024) {
      e.process(buf.subarray(i, i + 1024), (i / SR) * 1000);
      if (e.reading) readings.push(Math.round(e.reading.midi));
    }
    const notes = e.finish();
    expect(notes.map((n) => Math.round(n.midi))).toEqual([62]);
    expect(readings.every((m) => m === 62)).toBe(true);
  });
});
