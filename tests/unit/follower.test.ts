import { describe, expect, it } from 'vitest';
import { groupIntoChords, LearnFollower, ScoreFollower } from '../../src/follow/follower';
import { buildExpectedNotes } from '../../src/sheet/expected';
import { fixture } from '../fixtures/load';
import { perfect } from '../fixtures/streams';

const twinkle = fixture('twinkle.musicxml');
const { notes: expected, timeline } = buildExpectedNotes(twinkle, { instrument: 'violin', bpm: 90 });
const opts = { instrument: 'violin' as const, msPerQuarter: timeline.msPerQuarter };

function follow(events = perfect(expected)) {
  const f = new ScoreFollower(expected, opts);
  const positions = groupIntoChords(events, 0).map((g) => f.push(g));
  return { f, positions };
}

describe('score follower', () => {
  it('tracks a perfect run note by note', () => {
    const { positions } = follow();
    expect(positions).toEqual(expected.map((_, i) => i));
  });

  it('recovers after a skipped note', () => {
    const events = perfect(expected).filter((_, i) => i !== 3);
    const { positions, f } = follow(events);
    expect(positions.slice(3)).toEqual(expected.map((_, i) => i).slice(4));
    expect(f.alignment().matches[3]).toBeUndefined();
  });

  it('ignores an extra note', () => {
    const events = perfect(expected);
    events.splice(6, 0, { midi: 90, cents: 0, onsetMs: expected[5].onsetMs + 200, durationMs: 80, confidence: 0.6 });
    const { f } = follow(events);
    const a = f.alignment();
    expect(a.extras).toHaveLength(1);
    expect(a.matches.every(Boolean)).toBe(true);
  });

  it('copes with a player who gradually slows down', () => {
    const events = perfect(expected).map((e, i) => ({ ...e, onsetMs: e.onsetMs * (1 + i * 0.012) }));
    const { f } = follow(events);
    const a = f.alignment();
    expect(a.matches.filter(Boolean).length).toBe(expected.length);
    expect(a.lastReached).toBe(expected.length - 1);
  });

  it('copes with repeated notes (same pitch twice)', () => {
    // Twinkle starts D D A A: dropping the second D must not shift the As.
    const events = perfect(expected).filter((_, i) => i !== 1);
    const { f } = follow(events);
    const a = f.alignment();
    expect(a.matches[1]).toBeUndefined();
    expect(a.matches[2]?.pitches[0]).toBe(69);
  });

  it('groups chord notes within 60 ms', () => {
    const g = groupIntoChords([
      { midi: 60, cents: 0, onsetMs: 0, durationMs: 300, confidence: 1 },
      { midi: 64, cents: 0, onsetMs: 30, durationMs: 300, confidence: 1 },
      { midi: 67, cents: 0, onsetMs: 55, durationMs: 300, confidence: 1 },
      { midi: 72, cents: 0, onsetMs: 140, durationMs: 300, confidence: 1 },
    ]);
    expect(g.map((x) => x.pitches)).toEqual([[60, 64, 67], [72]]);
  });
});

describe('learn mode', () => {
  it('waits on each note until it hears it', () => {
    const l = new LearnFollower(expected, 'violin', 30);
    const ev = (midi: number) => ({ midi, cents: 0, onsetMs: 0, durationMs: 300, confidence: 1 });
    expect(l.hear(ev(70))).toBe(false);
    expect(l.position).toBe(0);
    expect(l.hear(ev(62))).toBe(true);
    expect(l.position).toBe(1);
    for (const e of expected.slice(1)) l.hear(ev(e.pitches[0]));
    expect(l.done).toBe(true);
    // One mistake on the first note.
    expect(l.accuracy).toBeCloseTo((expected.length - 1) / expected.length);
  });

  it('waits for every note of a piano chord', () => {
    const p = buildExpectedNotes(fixture('piano-two-staves.musicxml'), { instrument: 'piano', bpm: 72 }).notes;
    const l = new LearnFollower(p, 'piano', 0);
    const ev = (midi: number) => ({ midi, cents: 0, onsetMs: 0, durationMs: 300, confidence: 1 });
    l.hear(ev(48));
    l.hear(ev(76));
    expect(l.position).toBe(0);
    l.hear(ev(55));
    expect(l.position).toBe(1);
  });
});
