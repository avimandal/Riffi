import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { groupIntoChords, ScoreFollower } from '../../src/follow/follower';
import { RunEnd } from '../../src/follow/runEnd';
import { buildExpectedNotes, hasRepeats, straightThrough } from '../../src/sheet/expected';
import { parseMusicXml } from '../../src/sheet/musicxml';
import { notationToMusicXml, type RnScore } from '../../src/sheet/notation';
import { fixture } from '../fixtures/load';
import { perfect } from '../fixtures/streams';
import { followPerformance, perform, type PlayerModel } from '../fixtures/violinRun';

/**
 * Practice following on real violin notes (tests/fixtures/violin, CC0) played
 * by a child-like player model, through a phone mic model and the real engine.
 */
const KID: PlayerModel = { tempo: 0.88, drift: 0.1, jitterMs: 50, detuneCents: 30, missRate: 0.08, extraRate: 0.08, wrongRate: 0.05, pauseRate: 0.03 };
const ref = JSON.parse(readFileSync('tests/fixtures/sheets/hermans-hornpipe.reference.json', 'utf8')) as RnScore;
// The final "let ring" bar is unclear in the photo; leave it out.
const hornpipe = parseMusicXml(notationToMusicXml({ ...ref, measures: ref.measures.slice(0, 21) }, 'Violin').musicxml);

describe('following a child playing real violin', () => {
  it('Twinkle: slower than the metronome, slips and all, followed to the end; never ends early', () => {
    const { notes, timeline } = buildExpectedNotes(fixture('twinkle.musicxml'), { instrument: 'violin', bpm: 90 });
    for (const seed of [1, 2]) {
      const perf = perform(notes, timeline.msPerQuarter, { ...KID, seed });
      const r = followPerformance(notes, timeline.msPerQuarter, perf);
      expect(r.syncedTo, `seed ${seed}`).toBe(1);
      expect(r.inSync).toBeGreaterThan(0.9);
      expect(r.maxBackJump).toBe(0);
      expect(r.endedEarly).toBe(false);
      // It did end by itself: just after the last note, or (if that note went unheard) after 5 s of quiet.
      expect(r.endedAtMs).not.toBeNull();
      expect(r.endedAtMs! - perf.truth[perf.truth.length - 1].endMs).toBeLessThan(6000);
    }
  });

  it("Herman's Hornpipe (16th notes) at 70 bpm, repeats off: in sync to the end", () => {
    const { notes, timeline } = buildExpectedNotes(hornpipe, { instrument: 'violin', bpm: 70, playRepeats: false });
    const perf = perform(notes, timeline.msPerQuarter, { ...KID, seed: 1 });
    const r = followPerformance(notes, timeline.msPerQuarter, perf);
    expect(r.syncedTo).toBeGreaterThan(0.95);
    expect(r.inSync).toBeGreaterThan(0.85);
    expect(r.maxBackJump).toBe(0);
    expect(r.endedEarly).toBe(false);
  });
});

describe('score follower: holding its place', () => {
  const { notes: expected, timeline } = buildExpectedNotes(fixture('twinkle.musicxml'), { instrument: 'violin', bpm: 90 });
  const opts = { instrument: 'violin' as const, msPerQuarter: timeline.msPerQuarter };

  it('never jumps back to the start, even when the player starts again', () => {
    const f = new ScoreFollower(expected, opts);
    const run = perfect(expected);
    const half = Math.floor(run.length / 2);
    const restart = run.slice(0, half).map((e) => ({ ...e, onsetMs: e.onsetMs + run[half].onsetMs + 2000 }));
    let last = -1;
    for (const g of groupIntoChords([...run.slice(0, half), ...restart], 0)) {
      const pos = f.push(g);
      expect(pos).toBeGreaterThanOrEqual(last);
      last = pos;
    }
    expect(last).toBeGreaterThanOrEqual(half - 1);
  });

  it('holds its place through wrong notes, then carries on', () => {
    const f = new ScoreFollower(expected, opts);
    const run = perfect(expected);
    const positions = groupIntoChords(run.map((e, i) => (i >= 5 && i < 8 ? { ...e, midi: e.midi + 5 } : e)), 0).map((g) => f.push(g));
    expect(positions.slice(5, 8)).toEqual([4, 4, 4]);
    expect(positions.at(-1)).toBe(expected.length - 1);
  });
});

describe('run end', () => {
  const { notes } = buildExpectedNotes(fixture('twinkle.musicxml'), { instrument: 'violin', bpm: 90 });
  const last = notes.length - 1;
  const total = notes[last].onsetMs + notes[last].durationMs;

  it("doesn't end when the piece's time is up but the player is still going", () => {
    const e = new RunEnd(notes);
    expect(e.shouldEnd(total + 3000, Math.floor(last / 2), total + 2900)).toBe(false);
  });

  it('ends shortly after the last note has been played', () => {
    const e = new RunEnd(notes);
    expect(e.shouldEnd(total, last, total - 100)).toBe(false);
    expect(e.shouldEnd(total + 800, last, total)).toBe(true);
  });

  it('ends after several seconds of silence in the final bars, not in the middle', () => {
    const final = notes.findIndex((n) => n.playIndex > notes[last].playIndex - 2);
    expect(new RunEnd(notes).shouldEnd(total, final, total - 5000)).toBe(true);
    expect(new RunEnd(notes).shouldEnd(total / 2, Math.floor(last / 3), total / 2 - 6000)).toBe(false);
  });
});

describe('play repeats switch', () => {
  it('off: every bar once, taking the last ending', () => {
    const s = fixture('repeats.musicxml');
    expect(hasRepeats(s.measures)).toBe(true);
    expect(straightThrough(s.measures)).toEqual([0, 1, 3, 4, 5]);
    const off = buildExpectedNotes(s, { instrument: 'violin', bpm: 80, playRepeats: false });
    const on = buildExpectedNotes(s, { instrument: 'violin', bpm: 80 });
    expect(off.timeline.order).toEqual([0, 1, 3, 4, 5]);
    expect(on.timeline.order).toEqual([0, 1, 2, 0, 1, 3, 4, 4, 4, 5]);
    expect(off.notes.length).toBeLessThan(on.notes.length);
  });

  it('music without repeats is the same either way', () => {
    const s = fixture('twinkle.musicxml');
    expect(hasRepeats(s.measures)).toBe(false);
    expect(buildExpectedNotes(s, { instrument: 'violin', bpm: 80, playRepeats: false }).notes).toEqual(buildExpectedNotes(s, { instrument: 'violin', bpm: 80 }).notes);
  });
});
