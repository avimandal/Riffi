import type { Difficulty, Instrument } from '../config';
import type { NoteEvent } from '../engines/types';
import type { ExpectedNote } from '../sheet/expected';
import type { PlayedGroup } from '../follow/follower';
import { alignRun } from '../follow/follower';
import { SCORING, starsFor } from './config';
import { judgePitch, type PitchClass } from './pitch';

export type TimingClass = 'good' | 'ok' | 'early' | 'late' | 'missed';
export type LengthClass = 'ok' | 'short' | 'na';

export interface NoteResult {
  id: number;
  measureIndex: number;
  playIndex: number;
  bar: string;
  expected: number[];
  played: number[];
  pitch: PitchClass;
  pitchCredit: number;
  centsOff?: number;
  timing: TimingClass;
  onsetErrorMs?: number;
  length: LengthClass;
  rhythmCredit: number;
  /** Weight in the averages (dense piano passages count for less when missed). */
  weight: number;
  refs: number[];
  fifths: number;
}

export interface BarResult {
  measureIndex: number;
  playIndex: number;
  bar: string;
  notes: number;
  pitchAccuracy: number;
  rhythmAccuracy: number;
  /** Mean signed onset error of matched notes (negative = rushed). */
  meanOnsetErrorMs: number;
  missed: number;
  offPitch: number;
  close: number;
  short: number;
  perfect: boolean;
}

export interface RunScore {
  score: number;
  stars: number;
  pitchAccuracy: number;
  rhythmAccuracy: number;
  completion: number;
  notes: NoteResult[];
  bars: BarResult[];
  extras: number;
}

export interface ScoreOptions {
  instrument: Instrument;
  difficulty: Difficulty;
  msPerQuarter: number;
  /** Set false when durations can't be trusted (e.g. piano). */
  scoreLength?: boolean;
}

export function classifyTiming(errorMs: number, msPerQuarter: number, instrument: Instrument): TimingClass {
  const t = SCORING.timing;
  const scale = instrument === 'piano' ? t.pianoScale : 1;
  const good = Math.max(t.goodQuarters * msPerQuarter, t.goodFloorMs) * scale;
  const ok = Math.max(t.okQuarters * msPerQuarter, t.okFloorMs) * scale;
  const a = Math.abs(errorMs);
  if (a <= good) return 'good';
  if (a <= ok) return 'ok';
  return errorMs < 0 ? 'early' : 'late';
}

export function classifyLength(heldMs: number, writtenMs: number): LengthClass {
  return heldMs >= SCORING.length.minHeldFraction * writtenMs ? 'ok' : 'short';
}

/** Local note density (notes per second) around each expected note, over a ±1 s window. */
function densities(expected: ExpectedNote[]): number[] {
  return expected.map((e) => {
    const n = expected.filter((x) => Math.abs(x.onsetMs - e.onsetMs) <= 1000).length;
    return n / 2;
  });
}

/** Judge one expected note against what was matched to it. Pure. */
export function judgeNote(e: ExpectedNote, g: PlayedGroup | undefined, opts: ScoreOptions, weight = 1): NoteResult {
  const base = {
    id: e.id,
    measureIndex: e.measureIndex,
    playIndex: e.playIndex,
    bar: e.bar,
    expected: e.pitches,
    refs: e.refs,
    fifths: e.fifths,
    weight,
  };
  if (!g) {
    return {
      ...base,
      played: [],
      pitch: 'missed',
      pitchCredit: 0,
      timing: 'missed',
      length: 'na',
      rhythmCredit: 0,
    };
  }
  const pj = judgePitch(g.pitches, e.pitches, opts.instrument, opts.difficulty);
  const onsetErrorMs = g.onsetMs - e.onsetMs;
  const timing = classifyTiming(onsetErrorMs, opts.msPerQuarter, opts.instrument);
  const scoreLength = (opts.scoreLength ?? opts.instrument !== 'piano') && opts.instrument !== 'piano';
  const length: LengthClass = scoreLength ? classifyLength(g.durationMs, e.durationMs) : 'na';
  const tc = SCORING.timingCredit[timing];
  const rhythmCredit =
    length === 'na'
      ? tc
      : SCORING.rhythmMix.timing * tc + SCORING.rhythmMix.length * (length === 'ok' ? 1 : SCORING.length.shortCredit);
  return {
    ...base,
    played: g.pitches,
    pitch: pj.pitch,
    pitchCredit: pj.credit,
    centsOff: pj.centsOff,
    timing,
    onsetErrorMs,
    length,
    rhythmCredit,
  };
}

export function summariseBars(results: NoteResult[]): BarResult[] {
  const map = new Map<number, NoteResult[]>();
  for (const r of results) {
    const list = map.get(r.playIndex) ?? [];
    list.push(r);
    map.set(r.playIndex, list);
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([playIndex, list]) => {
      const matched = list.filter((r) => r.onsetErrorMs !== undefined);
      const meanOnsetErrorMs = matched.length
        ? matched.reduce((s, r) => s + (r.onsetErrorMs ?? 0), 0) / matched.length
        : 0;
      const pitchAccuracy = list.reduce((s, r) => s + r.pitchCredit, 0) / list.length;
      const rhythmAccuracy = list.reduce((s, r) => s + r.rhythmCredit, 0) / list.length;
      return {
        measureIndex: list[0].measureIndex,
        playIndex,
        bar: list[0].bar,
        notes: list.length,
        pitchAccuracy,
        rhythmAccuracy,
        meanOnsetErrorMs,
        missed: list.filter((r) => r.pitch === 'missed').length,
        offPitch: list.filter((r) => r.pitch === 'wrong').length,
        close: list.filter((r) => r.pitch === 'close').length,
        short: list.filter((r) => r.length === 'short').length,
        perfect: list.every((r) => r.pitch === 'correct' && r.timing === 'good' && r.length !== 'short'),
      };
    });
}

/** Score out of 100 from per-note results (SPEC §8). */
export function totalScore(results: NoteResult[], lastReached: number, total: number) {
  const w = SCORING.weights;
  const weightSum = results.reduce((s, r) => s + r.weight, 0) || 1;
  const pitchAccuracy = results.reduce((s, r) => s + r.pitchCredit * r.weight, 0) / weightSum;
  const rhythmAccuracy = results.reduce((s, r) => s + r.rhythmCredit * r.weight, 0) / weightSum;
  const completion = total === 0 ? 0 : Math.max(0, Math.min(1, (lastReached + 1) / total));
  const score = Math.round(w.pitch * pitchAccuracy + w.rhythm * rhythmAccuracy + w.completion * completion);
  return { score, stars: starsFor(score), pitchAccuracy, rhythmAccuracy, completion };
}

/** Align a run's notes against the expected notes and score it. */
export function scoreRun(expected: ExpectedNote[], events: NoteEvent[], opts: ScoreOptions): RunScore {
  if (expected.length === 0) {
    return { score: 0, stars: 0, pitchAccuracy: 0, rhythmAccuracy: 0, completion: 0, notes: [], bars: [], extras: 0 };
  }
  const { matches, extras, lastReached } = alignRun(expected, events, {
    instrument: opts.instrument,
    msPerQuarter: opts.msPerQuarter,
  });
  const dens = opts.instrument === 'piano' ? densities(expected) : [];
  const notes = expected.map((e, i) => {
    const g = matches[i];
    const dense = opts.instrument === 'piano' && dens[i] > SCORING.pianoDense.notesPerSecond;
    const weight = !g && dense ? SCORING.pianoDense.missedWeight : 1;
    return judgeNote(e, g, opts, weight);
  });
  const totals = totalScore(notes, lastReached, expected.length);
  return { ...totals, notes, bars: summariseBars(notes), extras: extras.length };
}
