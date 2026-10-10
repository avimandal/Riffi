/**
 * End to end through the real mono engine: synthesised performances of a
 * fixture piece (with vibrato, metronome clicks, octave-down singing) are
 * listened to and scored (SPEC §17).
 */
import { describe, expect, it } from 'vitest';
import { buildBeatGrid } from '../../src/audio/beats';
import { MonoEngine } from '../../src/engines/mono/monoEngine';
import { scoreRun } from '../../src/scoring/score';
import { buildExpectedNotes, type ExpectedNote } from '../../src/sheet/expected';
import { addClicks, addNoise, addTone, blank, SR, VIOLINISH, VOICEISH } from '../fixtures/audio';
import { fixture } from '../fixtures/load';

const twinkle = fixture('twinkle.musicxml');
const BPM = 90;

function perform(
  notes: ExpectedNote[],
  opts: { harmonics: number[]; vibrato?: number; shift?: number; wrong?: Set<number>; clicks?: number[]; lead?: number },
) {
  const lead = opts.lead ?? 500;
  const end = notes[notes.length - 1];
  const buf = blank(lead + end.onsetMs + end.durationMs + 600);
  notes.forEach((n, i) => {
    addTone(buf, {
      midi: n.pitches[0] + (opts.shift ?? 0) + (opts.wrong?.has(i) ? 1 : 0),
      startMs: lead + n.onsetMs,
      durationMs: n.durationMs * 0.92,
      harmonics: opts.harmonics,
      vibratoCents: opts.vibrato,
      vibratoHz: 5.5,
      attackMs: 30,
    });
  });
  if (opts.clicks) addClicks(buf, opts.clicks.map((t) => t + lead), 0.7);
  addNoise(buf, 0.002);
  return { buf, lead };
}

function listen(buf: Float32Array, lead: number, instrument: 'violin' | 'voice', clicks: number[] = []) {
  const e = new MonoEngine({ instrument, sampleRate: SR });
  e.setClickTimes(clicks);
  // Session time 0 = first beat of the piece.
  for (let i = 0; i < buf.length; i += 1024) e.process(buf.subarray(i, i + 1024), (i / SR) * 1000 - lead);
  return e.finish();
}

describe('acceptance (synthetic audio through the mono engine)', () => {
  const { notes, timeline } = buildExpectedNotes(twinkle, { instrument: 'violin', bpm: BPM });
  const clicks = buildBeatGrid(timeline).map((b) => b.timeMs);
  const opts = { instrument: 'violin' as const, difficulty: 'normal' as const, msPerQuarter: timeline.msPerQuarter };

  it('playing the piece correctly (with vibrato and metronome clicks) scores 90+', () => {
    const { buf, lead } = perform(notes, { harmonics: VIOLINISH, vibrato: 35, clicks });
    const events = listen(buf, lead, 'violin', clicks);
    const r = scoreRun(notes, events, opts);
    expect(r.score).toBeGreaterThanOrEqual(90);
    expect(r.pitchAccuracy).toBeGreaterThanOrEqual(0.95);
  });

  it('metronome clicks alone are not heard as notes', () => {
    const buf = addNoise(addClicks(blank(clicks[clicks.length - 1] + 2000), clicks.map((c) => c + 2000), 1), 0.002);
    expect(listen(buf, 2000, 'violin', clicks)).toHaveLength(0);
  });

  it('deliberately wrong notes are flagged on the right bars', () => {
    const wrong = new Set([notes.findIndex((n) => n.bar === '2'), notes.findIndex((n) => n.bar === '6')]);
    const { buf, lead } = perform(notes, { harmonics: VIOLINISH, wrong });
    const r = scoreRun(notes, listen(buf, lead, 'violin'), opts);
    const offBars = [...new Set(r.notes.filter((n) => n.pitch === 'wrong').map((n) => n.bar))].sort();
    expect(offBars).toEqual(['2', '6']);
  });

  it('a child singing an octave below scores normally', () => {
    const v = buildExpectedNotes(twinkle, { instrument: 'voice', bpm: BPM });
    const { buf, lead } = perform(v.notes, { harmonics: VOICEISH, vibrato: 40, shift: -12 });
    const r = scoreRun(v.notes, listen(buf, lead, 'voice'), { ...opts, instrument: 'voice' });
    expect(r.score).toBeGreaterThanOrEqual(90);
  });
});
