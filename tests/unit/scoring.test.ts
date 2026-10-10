import { describe, expect, it } from 'vitest';
import { SCORING, starsFor } from '../../src/scoring/config';
import { judgePitch, pitchDistanceCents } from '../../src/scoring/pitch';
import { classifyTiming, scoreRun } from '../../src/scoring/score';
import { findIssues, findPositives, missedKeySignature } from '../../src/scoring/feedback';
import { buildExpectedNotes } from '../../src/sheet/expected';
import { fixture } from '../fixtures/load';
import { perfect } from '../fixtures/streams';

const twinkle = fixture('twinkle.musicxml');
const BPM = 90;
const { notes: expected, timeline } = buildExpectedNotes(twinkle, { instrument: 'violin', bpm: BPM });
const q = timeline.msPerQuarter;
const opts = { instrument: 'violin' as const, difficulty: 'normal' as const, msPerQuarter: q };

describe('pitch judgement', () => {
  it('uses the tolerance table', () => {
    expect(judgePitch([69.25], [69], 'violin', 'normal').pitch).toBe('correct'); // 25c ≤ 30
    expect(judgePitch([69.35], [69], 'violin', 'normal').pitch).toBe('close');
    expect(judgePitch([69.35], [69], 'violin', 'easy').pitch).toBe('correct');
    expect(judgePitch([69.25], [69], 'violin', 'tricky').pitch).toBe('close');
    expect(judgePitch([70], [69], 'violin', 'normal').pitch).toBe('wrong');
    expect(judgePitch([69.45], [69], 'voice', 'normal').pitch).toBe('correct');
  });

  it('treats an octave away as fine for singing only', () => {
    expect(pitchDistanceCents(57, 69, true)).toBe(0);
    expect(judgePitch([57], [69], 'voice', 'normal').pitch).toBe('correct');
    expect(judgePitch([45.2], [69], 'voice', 'normal').pitch).toBe('correct'); // two octaves
    expect(judgePitch([57], [69], 'violin', 'normal').pitch).toBe('wrong');
  });

  it('gives piano chords partial credit', () => {
    const j = judgePitch([60, 64], [60, 64, 67], 'piano', 'normal');
    expect(j.credit).toBeCloseTo(2 / 3);
    expect(j.pitch).toBe('close');
    expect(judgePitch([60, 64, 67], [60, 64, 67], 'piano', 'normal').pitch).toBe('correct');
    expect(judgePitch([61], [60], 'piano', 'normal').pitch).toBe('wrong');
  });
});

describe('timing', () => {
  it('classifies onsets by 16th/8th windows with floors', () => {
    expect(classifyTiming(50, 500, 'violin')).toBe('good'); // 16th = 125ms
    expect(classifyTiming(-200, 500, 'violin')).toBe('ok'); // 8th = 250ms
    expect(classifyTiming(-300, 500, 'violin')).toBe('early');
    expect(classifyTiming(300, 500, 'violin')).toBe('late');
    // Fast tempo: the floor keeps things fair.
    expect(classifyTiming(65, 200, 'violin')).toBe('good');
  });
});

describe('scoring a run', () => {
  it('a perfect run scores 100 with 3 stars', () => {
    const r = scoreRun(expected, perfect(expected), opts);
    expect(r.score).toBe(100);
    expect(r.stars).toBe(3);
    expect(r.notes.every((n) => n.pitch === 'correct' && n.timing === 'good')).toBe(true);
  });

  it('a slightly human run (timing jitter, small pitch offset) still scores 90+', () => {
    const r = scoreRun(expected, perfect(expected, { jitterMs: 60, cents: 12 }), opts);
    expect(r.score).toBeGreaterThanOrEqual(90);
  });

  it('a skipped note only costs that note', () => {
    const events = perfect(expected).filter((_, i) => i !== 5);
    const r = scoreRun(expected, events, opts);
    expect(r.notes[5].pitch).toBe('missed');
    expect(r.notes.filter((n) => n.pitch === 'missed')).toHaveLength(1);
    expect(r.notes.filter((_, i) => i !== 5).every((n) => n.pitch === 'correct')).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(95);
  });

  it('extra notes are ignored rather than derailing the follower', () => {
    const events = perfect(expected);
    events.splice(8, 0, { midi: 80, cents: 0, onsetMs: expected[8].onsetMs - q / 2, durationMs: 100, confidence: 0.9 });
    events.splice(20, 0, { midi: 50, cents: 0, onsetMs: expected[19].onsetMs + q / 2, durationMs: 100, confidence: 0.9 });
    const r = scoreRun(expected, events, opts);
    expect(r.notes.every((n) => n.pitch === 'correct')).toBe(true);
    expect(r.extras).toBe(2);
  });

  it('late notes are flagged as late, not as missing', () => {
    const events = perfect(expected).map((e, i) => (i >= 8 && i < 12 ? { ...e, onsetMs: e.onsetMs + q * 0.7 } : e));
    const r = scoreRun(expected, events, opts);
    expect(r.notes.slice(8, 12).every((n) => n.timing === 'late' && n.pitch === 'correct')).toBe(true);
    expect(r.score).toBeLessThan(100);
    expect(r.score).toBeGreaterThan(85);
  });

  it('flags deliberately wrong notes on the right bars', () => {
    const events = perfect(expected);
    // Bar 3 (index 8..11) and bar 7: play a semitone off.
    const targets = expected.map((e, i) => (e.bar === '3' || e.bar === '7' ? i : -1)).filter((i) => i >= 0).slice(0, 2);
    const bar7 = expected.findIndex((e) => e.bar === '7');
    for (const i of [targets[0], bar7]) events[i] = { ...events[i], midi: events[i].midi + 1 };
    const r = scoreRun(expected, events, opts);
    const off = r.notes.filter((n) => n.pitch === 'wrong');
    expect(off.map((n) => n.bar).sort()).toEqual(['3', '7']);
    const issues = findIssues(r, twinkle.measures.length - 1, 'violin');
    expect(issues.map((i) => i.bar)).toEqual(expect.arrayContaining(['3', '7']));
  });

  it('vibrato-like pitch spread does not lower the pitch score', () => {
    // Engines report the median, so vibrato shows up as a small offset at most.
    const events = perfect(expected).map((e, i) => ({ ...e, midi: e.midi + (i % 2 ? 0.08 : -0.08) }));
    expect(scoreRun(expected, events, opts).pitchAccuracy).toBe(1);
  });

  it('singing an octave below scores normally', () => {
    const v = buildExpectedNotes(twinkle, { instrument: 'voice', bpm: BPM });
    const events = perfect(v.notes).map((e) => ({ ...e, midi: e.midi - 12 }));
    const r = scoreRun(v.notes, events, { ...opts, instrument: 'voice' });
    expect(r.score).toBeGreaterThanOrEqual(95);
  });

  it('short notes on violin cost a little rhythm credit', () => {
    const r = scoreRun(expected, perfect(expected, { holdFraction: 0.3 }), opts);
    expect(r.notes.every((n) => n.length === 'short')).toBe(true);
    expect(r.score).toBeLessThan(100);
    expect(r.score).toBeGreaterThanOrEqual(85);
  });

  it('partial piano chords get partial credit', () => {
    const piano = fixture('piano-two-staves.musicxml');
    const p = buildExpectedNotes(piano, { instrument: 'piano', bpm: 72 });
    const events = perfect(p.notes).filter((e) => !(e.midi === 55 && e.onsetMs === 0)); // drop G3 from the first chord
    const r = scoreRun(p.notes, events, { instrument: 'piano', difficulty: 'normal', msPerQuarter: p.timeline.msPerQuarter });
    expect(r.notes[0].pitchCredit).toBeCloseTo(2 / 3);
    expect(r.notes.slice(1).every((n) => n.pitch === 'correct')).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(90);
  });

  it('stopping halfway lowers completion', () => {
    const half = perfect(expected).slice(0, 14);
    const r = scoreRun(expected, half, opts);
    expect(r.completion).toBeCloseTo(0.5);
    expect(r.score).toBeLessThan(60);
  });

  it('nothing played scores 0', () => {
    expect(scoreRun(expected, [], opts).score).toBe(0);
  });

  it('awards stars at 50, 75 and 90', () => {
    expect([49, 50, 74, 75, 89, 90, 100].map(starsFor)).toEqual([0, 1, 1, 2, 2, 3, 3]);
  });
});

describe('feedback', () => {
  it('spots a rushed bar and offers a slower loop around it', () => {
    const events = perfect(expected).map((e, i) => (expected[i].bar === '4' ? { ...e, onsetMs: e.onsetMs - 160 } : e));
    const r = scoreRun(expected, events, opts);
    const issues = findIssues(r, 7, 'violin');
    const rushed = issues.find((i) => i.kind === 'rushed');
    expect(rushed?.bar).toBe('4');
    expect(rushed?.fix).toEqual({ type: 'loop', fromIndex: 2, toIndex: 4, tempoFactor: SCORING.feedback.fixTempoFactor });
  });

  it('notices a missed key-signature sharp', () => {
    expect(missedKeySignature(66, 65, 2)).toBe(true); // F♯ in D major, played F
    expect(missedKeySignature(66, 67, 2)).toBe(false);
    expect(missedKeySignature(65, 64, 0)).toBe(false);
    const events = perfect(expected);
    const fsharp = expected.findIndex((e) => e.pitches[0] === 66);
    events[fsharp] = { ...events[fsharp], midi: 65 };
    const r = scoreRun(expected, events, opts);
    const issue = findIssues(r, 7, 'violin').find((i) => i.kind === 'pitch');
    expect(issue?.keyHint).toBe(true);
    expect(issue?.fix.type).toBe('note');
  });

  it('never lists more than 3 issues', () => {
    const events = perfect(expected).map((e) => ({ ...e, midi: e.midi + 1 }));
    expect(findIssues(scoreRun(expected, events, opts), 7, 'violin').length).toBeLessThanOrEqual(3);
  });

  it('always finds something positive to lead with', () => {
    expect(findPositives(scoreRun(expected, [], opts)).length).toBeGreaterThan(0);
    const good = scoreRun(expected, perfect(expected), opts);
    const kinds = findPositives(good, 80).map((p) => p.kind);
    expect(kinds[0]).toBe('improved');
    expect(kinds).toContain('allTheWay');
  });
});
