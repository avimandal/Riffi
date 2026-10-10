import type { Instrument } from '../config';
import type { NoteEvent } from '../engines/types';
import type { ExpectedNote } from '../sheet/expected';
import { SCORING } from '../scoring/config';
import { pitchCost } from '../scoring/pitch';

/** One or more notes that started together (a chord on piano, a single note otherwise). */
export interface PlayedGroup {
  pitches: number[];
  onsetMs: number;
  durationMs: number;
  confidence: number;
  events: NoteEvent[];
}

/** Group notes whose onsets fall within `windowMs` of the first note in the group. */
export function groupIntoChords(events: NoteEvent[], windowMs: number = SCORING.follow.chordGroupMs): PlayedGroup[] {
  const sorted = [...events].sort((a, b) => a.onsetMs - b.onsetMs);
  const groups: PlayedGroup[] = [];
  for (const e of sorted) {
    const g = groups[groups.length - 1];
    if (g && e.onsetMs - g.onsetMs <= windowMs) {
      g.events.push(e);
      if (!g.pitches.some((p) => Math.abs(p - e.midi) < 0.5)) g.pitches.push(e.midi);
      g.durationMs = Math.max(g.durationMs, e.onsetMs + e.durationMs - g.onsetMs);
      g.confidence = Math.max(g.confidence, e.confidence);
    } else {
      groups.push({ pitches: [e.midi], onsetMs: e.onsetMs, durationMs: e.durationMs, confidence: e.confidence, events: [e] });
    }
  }
  return groups;
}

export interface FollowerOptions {
  instrument: Instrument;
  msPerQuarter: number;
  /** Turn off timing costs (learn mode, or when the player sets their own pace). */
  ignoreTiming?: boolean;
}

/** Back-pointer for one event: for each state in the window, where it came from. */
interface StepRecord {
  lo: number;
  /** -1 = stayed in the same state (event was an extra); otherwise the previous state. */
  from: Int32Array;
}

/**
 * Online score follower: windowed dynamic-programming alignment of played
 * groups against expected notes, over pitch and onset time. A missed note costs
 * a skip; an extra note costs an insertion; so one slip doesn't derail
 * everything after it.
 *
 * States are "last matched expected note" (-1 = none yet), stored at offset +1.
 */
export class ScoreFollower {
  private readonly n: number;
  private cost: Float64Array;
  private lastOnset: Float64Array;
  private readonly records: StepRecord[] = [];
  private readonly groups: PlayedGroup[] = [];
  private best = 0;

  constructor(
    private readonly expected: ExpectedNote[],
    private readonly opts: FollowerOptions,
  ) {
    this.n = expected.length;
    this.cost = new Float64Array(this.n + 1).fill(Infinity);
    this.cost[0] = 0;
    this.lastOnset = new Float64Array(this.n + 1).fill(NaN);
  }

  /** Index of the expected note most recently matched (-1 if none). */
  get position(): number {
    return this.best - 1;
  }

  private matchCost(g: PlayedGroup, t: number, prevState: number): number {
    const cfg = SCORING.follow;
    const e = this.expected[t];
    const pc = pitchCost(g.pitches, e.pitches, this.opts.instrument);
    if (this.opts.ignoreTiming) return cfg.pitchWeight * pc;
    const scale = 2 * this.opts.msPerQuarter;
    const absTerm = Math.min(1, Math.abs(g.onsetMs - e.onsetMs) / scale);
    let relTerm = absTerm;
    const prevOnset = this.lastOnset[prevState];
    if (prevState > 0 && Number.isFinite(prevOnset)) {
      const expGap = e.onsetMs - this.expected[prevState - 1].onsetMs;
      const gap = g.onsetMs - prevOnset;
      relTerm = Math.min(1, Math.abs(gap - expGap) / scale);
    }
    // Absolute time keeps us honest with the metronome; relative time tolerates drift.
    return cfg.pitchWeight * pc + cfg.timeWeight * (0.4 * absTerm + 0.6 * relTerm);
  }

  /** Feed the next played group. Returns the new position. */
  push(g: PlayedGroup): number {
    const cfg = SCORING.follow;
    const n1 = this.n + 1;
    const lo = Math.max(1, this.best - cfg.windowBehind);
    const hi = Math.min(this.n, this.best + cfg.windowAhead);

    const next = new Float64Array(n1);
    const nextOnset = new Float64Array(this.lastOnset);
    for (let s = 0; s < n1; s++) next[s] = this.cost[s] + cfg.insertCost;

    const from = new Int32Array(Math.max(0, hi - lo + 1)).fill(-1);
    for (let t = lo; t <= hi; t++) {
      const kMin = Math.max(0, t - cfg.maxSkip - 1);
      for (let k = kMin; k < t; k++) {
        const base = this.cost[k];
        if (!Number.isFinite(base)) continue;
        const c = base + cfg.skipCost * (t - k - 1) + this.matchCost(g, t - 1, k);
        if (c < next[t]) {
          next[t] = c;
          from[t - lo] = k;
          nextOnset[t] = g.onsetMs;
        }
      }
    }
    this.records.push({ lo, from });
    this.groups.push(g);
    this.cost = next;
    this.lastOnset = nextOnset;

    // Best state: lowest cost, preferring later positions on near-ties.
    let best = 0;
    for (let s = 0; s < n1; s++) {
      if (next[s] <= next[best] + 1e-9) best = s;
    }
    this.best = best;
    return this.position;
  }

  /**
   * Final alignment: for each expected note, the played group matched to it
   * (or undefined if missed / not reached). Also returns extras.
   */
  alignment(): { matches: (PlayedGroup | undefined)[]; extras: PlayedGroup[]; lastReached: number } {
    const matches: (PlayedGroup | undefined)[] = new Array(this.n).fill(undefined);
    const extras: PlayedGroup[] = [];
    let state = this.best;
    const lastReached = state - 1;
    for (let j = this.records.length - 1; j >= 0; j--) {
      const rec = this.records[j];
      const idx = state - rec.lo;
      const prev = state >= rec.lo && idx < rec.from.length ? rec.from[idx] : -1;
      if (prev >= 0) {
        matches[state - 1] = this.groups[j];
        state = prev;
      } else {
        extras.push(this.groups[j]);
      }
    }
    extras.reverse();
    return { matches, extras, lastReached };
  }
}

/** Offline convenience: align a whole run at once. */
export function alignRun(expected: ExpectedNote[], events: NoteEvent[], opts: FollowerOptions) {
  const f = new ScoreFollower(expected, opts);
  for (const g of groupIntoChords(events, opts.instrument === 'piano' ? SCORING.follow.chordGroupMs : 0)) f.push(g);
  return f.alignment();
}

/**
 * Learn mode: the cursor waits on each note until it hears it.
 * Piano chords accumulate notes until every written note has been heard.
 */
export class LearnFollower {
  private index = 0;
  private heard = new Set<number>();
  private attemptsOnCurrent = 0;
  firstTry = 0;
  attempts = 0;

  constructor(
    private readonly expected: ExpectedNote[],
    private readonly instrument: Instrument,
    private readonly toleranceCents: number,
  ) {}

  get position(): number {
    return this.index;
  }

  get done(): boolean {
    return this.index >= this.expected.length;
  }

  /** Accuracy so far: share of notes found on the first try. */
  get accuracy(): number {
    const finished = Math.min(this.index, this.expected.length);
    return finished === 0 ? 0 : this.firstTry / finished;
  }

  /** Returns true if the cursor moved on. */
  hear(e: NoteEvent): boolean {
    if (this.done) return false;
    const target = this.expected[this.index];
    this.attempts++;
    this.attemptsOnCurrent++;
    const octave = SCORING.octaveEquivalent[this.instrument];
    let matched = false;
    for (const p of target.pitches) {
      let d = e.midi - p;
      if (octave) {
        const k = Math.round(d / 12);
        if (Math.abs(k) <= SCORING.maxOctaveShift) d -= 12 * k;
      }
      const tol = this.instrument === 'piano' ? 50 : Math.max(this.toleranceCents, 20);
      if (Math.abs(d) * 100 <= tol) {
        this.heard.add(p);
        matched = true;
      }
    }
    const complete =
      this.instrument === 'piano' ? target.pitches.every((p) => this.heard.has(p)) : matched;
    if (complete) {
      const notesInTarget = this.instrument === 'piano' ? target.pitches.length : 1;
      if (this.attemptsOnCurrent <= notesInTarget) this.firstTry++;
      this.index++;
      this.heard.clear();
      this.attemptsOnCurrent = 0;
      return true;
    }
    return false;
  }

  jumpTo(index: number) {
    this.index = Math.max(0, Math.min(this.expected.length, index));
    this.heard.clear();
    this.attemptsOnCurrent = 0;
  }
}
