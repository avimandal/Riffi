import { describe, expect, it } from 'vitest';
import { MonoEngine } from '../../src/engines/mono/monoEngine';
import { addClicks, addNoise, addTone, blank, feed, SR, VIOLINISH, VOICEISH } from '../fixtures/audio';

function run(buf: Float32Array, instrument: 'violin' | 'voice', clicks: number[] = []) {
  const e = new MonoEngine({ instrument, sampleRate: SR });
  e.setClickTimes(clicks);
  feed(e, buf);
  return e.finish();
}

const melody = [67, 69, 71, 72, 74, 72, 71, 69]; // G4 A4 B4 C5 D5 C5 B4 A4

describe('mono engine', () => {
  it('detects a simple violin-like melody with correct pitch and onsets', () => {
    const buf = blank(8 * 500 + 500);
    melody.forEach((m, i) => addTone(buf, { midi: m, startMs: 200 + i * 500, durationMs: 460, harmonics: VIOLINISH }));
    const notes = run(buf, 'violin');
    expect(notes.map((n) => Math.round(n.midi))).toEqual(melody);
    notes.forEach((n, i) => {
      expect(Math.abs(n.onsetMs - (200 + i * 500))).toBeLessThan(45);
      expect(Math.abs(n.cents)).toBeLessThan(10);
      expect(n.durationMs).toBeGreaterThan(300);
    });
  });

  it('treats vibrato as one in-tune note', () => {
    const buf = blank(2600);
    addTone(buf, { midi: 69, startMs: 100, durationMs: 2000, vibratoCents: 45, vibratoHz: 5.5, harmonics: VIOLINISH, attackMs: 80 });
    const notes = run(buf, 'violin');
    expect(notes).toHaveLength(1);
    expect(Math.abs(notes[0].midi - 69) * 100).toBeLessThan(10);
  });

  it('handles legato notes with vibrato (no gaps)', () => {
    const buf = blank(4200);
    [69, 71, 72, 74].forEach((m, i) =>
      addTone(buf, { midi: m, startMs: 100 + i * 1000, durationMs: 1000, vibratoCents: 35, harmonics: VIOLINISH, attackMs: 5 }),
    );
    const notes = run(buf, 'violin');
    expect(notes.map((n) => Math.round(n.midi))).toEqual([69, 71, 72, 74]);
  });

  it('segments a sung-like glide into the target note, not the slide', () => {
    const buf = blank(2400);
    addTone(buf, { midi: 60, startMs: 100, durationMs: 900, harmonics: VOICEISH, attackMs: 120 });
    addTone(buf, { midi: 64, glideFrom: 60, glideMs: 150, startMs: 1000, durationMs: 1100, harmonics: VOICEISH, vibratoCents: 50, vibratoHz: 5 });
    const notes = run(buf, 'voice');
    expect(notes.map((n) => Math.round(n.midi))).toEqual([60, 64]);
    expect(Math.abs(notes[1].onsetMs - 1000)).toBeLessThan(200);
  });

  it('ignores metronome clicks on their own', () => {
    const clicks = Array.from({ length: 8 }, (_, i) => 200 + i * 500);
    const buf = addNoise(addClicks(blank(4500), clicks, 1), 0.001);
    expect(run(buf, 'violin', clicks)).toHaveLength(0);
    // Even without the click mask, band-limiting and range checks keep clicks out.
    expect(run(buf, 'violin', [])).toHaveLength(0);
  });

  it('still hears notes that start on the click, with true onsets', () => {
    const clicks = Array.from({ length: 8 }, (_, i) => 200 + i * 500);
    const buf = blank(4600);
    melody.forEach((m, i) => addTone(buf, { midi: m, startMs: 200 + i * 500, durationMs: 460, harmonics: VIOLINISH }));
    addClicks(buf, clicks, 0.8);
    const notes = run(buf, 'violin', clicks);
    expect(notes.map((n) => Math.round(n.midi))).toEqual(melody);
    notes.forEach((n, i) => expect(Math.abs(n.onsetMs - (200 + i * 500))).toBeLessThan(45));
  });

  it('splits repeated same-pitch notes separated by a short gap', () => {
    const buf = blank(2200);
    [0, 1, 2, 3].forEach((i) => addTone(buf, { midi: 72, startMs: 100 + i * 500, durationMs: 420, harmonics: VIOLINISH }));
    expect(run(buf, 'violin')).toHaveLength(4);
  });

  it('discards pitches outside the instrument range', () => {
    const buf = blank(1200);
    addTone(buf, { midi: 40, startMs: 100, durationMs: 900, harmonics: VIOLINISH }); // E2, below violin
    expect(run(buf, 'violin')).toHaveLength(0);
  });

  it('applies latency correction', () => {
    const buf = blank(1200);
    addTone(buf, { midi: 69, startMs: 300, durationMs: 600, harmonics: VIOLINISH });
    const e = new MonoEngine({ instrument: 'violin', sampleRate: SR, latencyMs: 100 });
    feed(e, buf);
    const [n] = e.finish();
    expect(Math.abs(n.onsetMs - 200)).toBeLessThan(45);
  });
});
