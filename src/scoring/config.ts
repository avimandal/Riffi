import type { Difficulty, Instrument } from '../config';

/**
 * Every scoring and alignment tolerance lives here, so tuning after
 * real-world testing with kids is a one-file change. See README "Tuning".
 */
export const SCORING = {
  /** Pitch tolerance in cents for "correct" (SPEC §8). Piano uses exact semitones. */
  pitchToleranceCents: {
    violin: { easy: 40, normal: 30, tricky: 20 },
    voice: { easy: 60, normal: 50, tricky: 35 },
    piano: { easy: 0, normal: 0, tricky: 0 },
  } satisfies Record<Instrument, Record<Difficulty, number>>,

  /** "Close" reaches up to this multiple of the tolerance, capped below a semitone. */
  closeMultiplier: 2,
  closeMaxCents: 90,

  /** Voice: match an octave (or two) away from what's written. */
  octaveEquivalent: { violin: false, voice: true, piano: false } satisfies Record<Instrument, boolean>,
  maxOctaveShift: 2,

  /** Credit for each pitch class. Piano chords get notes hit ÷ notes in chord. */
  pitchCredit: { correct: 1, close: 0.5, wrong: 0, missed: 0 },

  /**
   * Timing: good ≤ a 16th note, OK ≤ an 8th note (in quarter-note units),
   * never tighter than the floor (detection jitter on phones is ~30–60 ms).
   */
  timing: {
    goodQuarters: 0.25,
    okQuarters: 0.5,
    goodFloorMs: 70,
    okFloorMs: 140,
    /** Basic Pitch onsets are less precise, so piano windows are wider. */
    pianoScale: 1.5,
  },
  timingCredit: { good: 1, ok: 0.6, early: 0.2, late: 0.2, missed: 0 },

  /** Length (violin, voice): held at least this fraction of the written duration. */
  length: { minHeldFraction: 0.6, shortCredit: 0.4 },

  /** How rhythm credit is built for instruments that also score length. */
  rhythmMix: { timing: 0.8, length: 0.2 },

  /** Score out of 100 (SPEC §8). */
  weights: { pitch: 60, rhythm: 30, completion: 10 },
  stars: [50, 75, 90] as const,

  /** Piano: dense or fast passages are scored more leniently (SPEC §18). */
  pianoDense: { notesPerSecond: 6, missedWeight: 0.5 },

  /** Feedback thresholds. */
  feedback: {
    /** Mean signed onset error (ms) in a bar before we call it rushed/dragging. */
    rushedMs: 90,
    maxIssues: 3,
    fixTempoFactor: 0.75,
  },

  /** Score follower (online alignment) costs. */
  follow: {
    insertCost: 0.7,
    skipCost: 0.6,
    pitchWeight: 0.6,
    timeWeight: 0.4,
    maxSkip: 8,
    windowBehind: 4,
    windowAhead: 14,
    chordGroupMs: 60,
    /** The cursor only moves on a match at least this good (pitch cost, 0..1: 0.5 = half a semitone off). */
    confidentPitch: 0.5,
    /** Skipping a note the player's tempo says is already past (missed) costs this instead of skipCost… */
    passedSkipCost: 0.15,
    /** …once it's this far in the past (ms; at least half a beat). */
    passedMinMs: 150,
    /** Recent confident matches used to learn the player's own tempo. */
    tempoAnchors: 8,
  },
} as const;

export type ScoringConfig = typeof SCORING;

export function pitchTolerance(instrument: Instrument, difficulty: Difficulty): number {
  return SCORING.pitchToleranceCents[instrument][difficulty];
}

export function starsFor(score: number): number {
  return SCORING.stars.filter((s) => score >= s).length;
}
