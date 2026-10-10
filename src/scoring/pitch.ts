import type { Difficulty, Instrument } from '../config';
import { SCORING, pitchTolerance } from './config';

export type PitchClass = 'correct' | 'close' | 'wrong' | 'missed';

/**
 * Distance in cents between a detected pitch and a written one. With
 * octave equivalence (voice), shifts of up to two octaves are forgiven.
 */
export function pitchDistanceCents(detected: number, expected: number, octaveEquivalent: boolean): number {
  let d = detected - expected;
  if (octaveEquivalent) {
    const k = Math.round(d / 12);
    if (Math.abs(k) <= SCORING.maxOctaveShift) d -= 12 * k;
  }
  return Math.abs(d) * 100;
}

/** Signed deviation in cents after octave folding (positive = sharp). */
export function signedCents(detected: number, expected: number, octaveEquivalent: boolean): number {
  let d = detected - expected;
  if (octaveEquivalent) {
    const k = Math.round(d / 12);
    if (Math.abs(k) <= SCORING.maxOctaveShift) d -= 12 * k;
  }
  return d * 100;
}

export interface PitchJudgement {
  pitch: PitchClass;
  credit: number;
  /** For single notes: signed cents vs the nearest written pitch. */
  centsOff?: number;
  /** Written pitches that were heard. */
  hit: number[];
  /** Written pitches that weren't heard. */
  notHit: number[];
  /** Played pitches that matched nothing written. */
  extra: number[];
}

/** Judge the pitch(es) played for one expected event. */
export function judgePitch(
  played: number[],
  expected: number[],
  instrument: Instrument,
  difficulty: Difficulty,
): PitchJudgement {
  if (played.length === 0) {
    return { pitch: 'missed', credit: 0, hit: [], notHit: [...expected], extra: [] };
  }
  const octave = SCORING.octaveEquivalent[instrument];

  if (instrument === 'piano') {
    const playedSet = new Set(played.map((p) => Math.round(p)));
    const hit = expected.filter((e) => playedSet.has(e));
    const notHit = expected.filter((e) => !playedSet.has(e));
    const expSet = new Set(expected);
    const extra = [...playedSet].filter((p) => !expSet.has(p));
    const credit = expected.length ? hit.length / expected.length : 0;
    const pitch: PitchClass = credit >= 0.999 ? 'correct' : credit > 0 ? 'close' : 'wrong';
    return { pitch, credit, hit, notHit, extra };
  }

  // Mono instruments: the best-matching played pitch against the best-matching written one.
  const tol = pitchTolerance(instrument, difficulty);
  const closeLimit = Math.min(tol * SCORING.closeMultiplier, SCORING.closeMaxCents);
  let best = Infinity;
  let bestExp = expected[0];
  let bestPlayed = played[0];
  for (const p of played) {
    for (const e of expected) {
      const d = pitchDistanceCents(p, e, octave);
      if (d < best) {
        best = d;
        bestExp = e;
        bestPlayed = p;
      }
    }
  }
  const centsOff = signedCents(bestPlayed, bestExp, octave);
  const pitch: PitchClass = best <= tol ? 'correct' : best <= closeLimit ? 'close' : 'wrong';
  const credit = SCORING.pitchCredit[pitch];
  const ok = pitch !== 'wrong';
  return {
    pitch,
    credit,
    centsOff,
    hit: ok ? [bestExp] : [],
    notHit: ok ? expected.filter((e) => e !== bestExp) : [...expected],
    extra: ok ? [] : [bestPlayed],
  };
}

/**
 * Continuous pitch cost for the score follower: 0 = spot on, 1 = nothing like it.
 * Softer than `judgePitch` so the follower stays on track through small slips.
 */
export function pitchCost(played: number[], expected: number[], instrument: Instrument): number {
  if (played.length === 0 || expected.length === 0) return 1;
  if (instrument === 'piano') {
    const playedSet = new Set(played.map((p) => Math.round(p)));
    const hits = expected.filter((e) => playedSet.has(e)).length;
    const extras = [...playedSet].filter((p) => !expected.includes(p)).length;
    return Math.min(1, 1 - hits / expected.length + 0.1 * extras);
  }
  const octave = SCORING.octaveEquivalent[instrument];
  let best = Infinity;
  for (const p of played) for (const e of expected) best = Math.min(best, pitchDistanceCents(p, e, octave));
  return Math.min(1, best / 100);
}
