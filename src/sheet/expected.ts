import type { Instrument } from '../config';
import type { ParsedScore, ScoreMeasure, ScoreNote } from './musicxml';

/**
 * Expand repeats and volta endings into the order measures are actually played.
 * Returns measure indices.
 */
export function expandRepeats(measures: ScoreMeasure[]): number[] {
  const order: number[] = [];
  const jumpsDone = new Map<number, number>();
  let repeatStart = 0;
  let pass = 1;
  let i = 0;
  const cap = measures.length * 12 + 10;

  while (i < measures.length && order.length < cap) {
    const m = measures[i];
    if (m.forwardRepeat && i !== repeatStart) {
      repeatStart = i;
      pass = 1;
    }
    if (m.endingNumbers && !m.endingNumbers.includes(pass)) {
      i++;
      continue;
    }
    order.push(i);
    if (m.backwardRepeat) {
      const done = jumpsDone.get(i) ?? 0;
      if (done < m.repeatTimes - 1) {
        jumpsDone.set(i, done + 1);
        pass = done + 2;
        i = repeatStart;
        continue;
      }
      jumpsDone.delete(i);
      repeatStart = i + 1;
      // Keep the pass number if a "2." ending follows; otherwise we're back to pass 1.
      if (!measures[i + 1]?.endingNumbers) pass = 1;
    } else if (m.endingNumbers && !measures[i + 1]?.endingNumbers) {
      // Leaving the last ending bracket.
      pass = 1;
    }
    i++;
  }
  return order;
}

export interface ExpectedNote {
  /** Position in the expected list. */
  id: number;
  /** MIDI pitches, ascending. One for single notes, more for chords/double stops. */
  pitches: number[];
  onsetQ: number;
  durationQ: number;
  onsetMs: number;
  durationMs: number;
  measureIndex: number;
  /** Printed bar number. */
  bar: string;
  /** Position of this bar in the played (expanded) order. */
  playIndex: number;
  /** `<note>` document indices for every notehead in this event (for colouring). */
  refs: number[];
  /** Key signature in effect (for "that F wants to be F♯" hints). */
  fifths: number;
}

export interface Timeline {
  /** Measure indices in played order. */
  order: number[];
  /** Start of each played bar (aligned with `order`), in quarters. */
  startsQ: number[];
  totalQ: number;
  msPerQuarter: number;
  /** Beats per bar and beat length for each played bar (for the metronome). */
  bars: { measureIndex: number; startQ: number; lengthQ: number; beats: number; beatType: number }[];
}

export interface LoopRange {
  /** Inclusive measure indices (unexpanded). */
  fromIndex: number;
  toIndex: number;
}

export interface BuildOptions {
  instrument: Instrument;
  /** Beats per minute, where a beat is the time signature's bottom number. */
  bpm: number;
  partIndex?: number;
  loop?: LoopRange;
}

export function msPerQuarterFor(bpm: number, beatType: number): number {
  return ((60000 / bpm) * beatType) / 4;
}

/** Quarter-note tempo from a score → BPM in the score's beat unit. */
export function bpmFromTempoQ(tempoQ: number, beatType: number): number {
  return (tempoQ * beatType) / 4;
}

export function playOrder(score: ParsedScore, loop?: LoopRange): number[] {
  const full = expandRepeats(score.measures);
  if (!loop) return full;
  const from = Math.min(loop.fromIndex, loop.toIndex);
  const to = Math.max(loop.fromIndex, loop.toIndex);
  const start = full.findIndex((m) => m >= from && m <= to);
  if (start < 0) return full;
  const out: number[] = [];
  for (let k = start; k < full.length; k++) {
    const m = full[k];
    if (m < from || m > to) break;
    out.push(m);
    if (m === to) break;
  }
  return out;
}

export function buildTimeline(score: ParsedScore, bpm: number, loop?: LoopRange): Timeline {
  const order = playOrder(score, loop);
  const firstBeatType = score.measures[order[0] ?? 0]?.beatType ?? 4;
  const msPerQuarter = msPerQuarterFor(bpm, firstBeatType);
  const startsQ: number[] = [];
  const bars: Timeline['bars'] = [];
  let t = 0;
  for (const mi of order) {
    const m = score.measures[mi];
    startsQ.push(t);
    bars.push({ measureIndex: mi, startQ: t, lengthQ: m.lengthQ, beats: m.beats, beatType: m.beatType });
    t += m.lengthQ;
  }
  return { order, startsQ, totalQ: t, msPerQuarter, bars };
}

const EPS = 1e-4;

function selectNotes(score: ParsedScore, instrument: Instrument, partIndex: number): ScoreNote[] {
  const inPart = score.notes.filter(
    (n) => n.partIndex === partIndex && !n.isRest && !n.isGrace && n.midi !== undefined,
  );
  if (instrument === 'piano') return inPart;
  // Violin and voice read the top staff of the chosen part.
  const topStaff = Math.min(...inPart.map((n) => n.staff), 1);
  return inPart.filter((n) => n.staff === topStaff);
}

/**
 * Build the list of notes the player is expected to play: repeats expanded,
 * ties merged, simultaneous notes (both piano staves) merged into chords.
 */
export function buildExpectedNotes(score: ParsedScore, opts: BuildOptions): { notes: ExpectedNote[]; timeline: Timeline } {
  const partIndex = opts.partIndex ?? 0;
  const timeline = buildTimeline(score, opts.bpm, opts.loop);
  const { msPerQuarter } = timeline;
  const chosen = selectNotes(score, opts.instrument, partIndex);
  const byMeasure = new Map<number, ScoreNote[]>();
  for (const n of chosen) {
    const list = byMeasure.get(n.measureIndex) ?? [];
    list.push(n);
    byMeasure.set(n.measureIndex, list);
  }

  interface Draft {
    pitches: Set<number>;
    onsetQ: number;
    endQ: number;
    measureIndex: number;
    playIndex: number;
    refs: number[];
  }
  const drafts: Draft[] = [];
  // Ties waiting for their continuation, keyed by staff+pitch.
  const pendingTies = new Map<string, { draft: Draft; endQ: number }>();

  timeline.order.forEach((mi, playIndex) => {
    const barStart = timeline.startsQ[playIndex];
    const list = [...(byMeasure.get(mi) ?? [])].sort((a, b) => a.startQ - b.startQ || (a.midi ?? 0) - (b.midi ?? 0));
    const groups = new Map<number, Draft>();
    for (const n of list) {
      const onset = barStart + n.startQ;
      const end = onset + n.durationQ;
      const key = `${n.staff}:${n.midi}`;
      const pending = pendingTies.get(key);
      if (n.tieStop && pending && Math.abs(pending.endQ - onset) < 0.05) {
        // Continuation of a tied note: extend, don't add a new onset.
        pending.draft.endQ = Math.max(pending.draft.endQ, end);
        pending.draft.refs.push(n.xmlIndex);
        if (n.tieStart) pendingTies.set(key, { draft: pending.draft, endQ: end });
        else pendingTies.delete(key);
        continue;
      }
      const gk = Math.round(onset / EPS);
      let g = groups.get(gk);
      if (!g) {
        g = { pitches: new Set(), onsetQ: onset, endQ: end, measureIndex: mi, playIndex, refs: [] };
        groups.set(gk, g);
        drafts.push(g);
      }
      g.pitches.add(n.midi!);
      g.endQ = Math.max(g.endQ, end);
      g.refs.push(n.xmlIndex);
      if (n.tieStart) pendingTies.set(key, { draft: g, endQ: end });
    }
  });

  drafts.sort((a, b) => a.onsetQ - b.onsetQ);
  const notes: ExpectedNote[] = drafts.map((d, id) => {
    const m = score.measures[d.measureIndex];
    return {
      id,
      pitches: [...d.pitches].sort((a, b) => a - b),
      onsetQ: d.onsetQ,
      durationQ: d.endQ - d.onsetQ,
      onsetMs: d.onsetQ * msPerQuarter,
      durationMs: (d.endQ - d.onsetQ) * msPerQuarter,
      measureIndex: d.measureIndex,
      bar: m?.number ?? String(d.measureIndex + 1),
      playIndex: d.playIndex,
      refs: d.refs,
      fifths: m?.fifths ?? 0,
    };
  });
  return { notes, timeline };
}

/** Default BPM for a score: its tempo marking, else 80. Clamped to the metronome range. */
export function defaultBpm(score: ParsedScore, fallback = 80, min = 40, max = 200): number {
  const beatType = score.measures[0]?.beatType ?? 4;
  const bpm = score.tempoQ ? bpmFromTempoQ(score.tempoQ, beatType) : fallback;
  return Math.round(Math.max(min, Math.min(max, bpm)));
}
