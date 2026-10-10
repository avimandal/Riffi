import type { Instrument } from '../config';
import { keySignatureAlters, spellMidi } from '../sheet/musicxml';
import { SCORING } from './config';
import type { BarResult, NoteResult, RunScore } from './score';

export type IssueKind = 'rushed' | 'dragging' | 'pitch' | 'tuning' | 'missed' | 'short';

export interface LoopFix {
  type: 'loop';
  fromIndex: number;
  toIndex: number;
  tempoFactor: number;
}

export interface NoteFix {
  type: 'note';
  noteId: number;
  measureIndex: number;
  /** Loop to offer after showing the note. */
  loop: LoopFix;
}

export interface Issue {
  kind: IssueKind;
  bar: string;
  measureIndex: number;
  playIndex: number;
  /** Points lost, roughly. Bigger = more worth fixing. */
  severity: number;
  /** Written pitch, for pitch/tuning issues. */
  expectedMidi?: number;
  playedMidi?: number;
  /** Tuning direction. */
  direction?: 'high' | 'low';
  /** Whether the key signature explains the note (e.g. F → F♯ in G major). */
  keyHint?: boolean;
  fifths?: number;
  fix: LoopFix | NoteFix;
}

export type PositiveKind =
  | 'allTheWay'
  | 'greatPitch'
  | 'steadyRhythm'
  | 'perfectBars'
  | 'goodStart'
  | 'strongFinish'
  | 'improved'
  | 'effort';

export interface Positive {
  kind: PositiveKind;
  count?: number;
  bar?: string;
}

/** True when the written note is sharpened/flattened by the key signature and they played it plain. */
export function missedKeySignature(expectedMidi: number, playedMidi: number, fifths: number): boolean {
  if (fifths === 0) return false;
  const { step, alter } = spellMidi(expectedMidi, fifths);
  const keyAlter = keySignatureAlters(fifths)[step] ?? 0;
  return alter !== 0 && alter === keyAlter && playedMidi === expectedMidi - alter;
}

function loopAround(measureIndex: number, maxIndex: number, factor: number = SCORING.feedback.fixTempoFactor): LoopFix {
  return {
    type: 'loop',
    fromIndex: Math.max(0, measureIndex - 1),
    toIndex: Math.min(maxIndex, measureIndex + 1),
    tempoFactor: factor,
  };
}

/** Top issues (max 3), one per bar, most points lost first. Pure. */
export function findIssues(run: RunScore, maxMeasureIndex: number, instrument: Instrument): Issue[] {
  const cfg = SCORING.feedback;
  const candidates: Issue[] = [];
  const notesByPlay = new Map<number, NoteResult[]>();
  for (const n of run.notes) {
    const l = notesByPlay.get(n.playIndex) ?? [];
    l.push(n);
    notesByPlay.set(n.playIndex, l);
  }

  for (const bar of run.bars) {
    const notes = notesByPlay.get(bar.playIndex) ?? [];
    const base = { bar: bar.bar, measureIndex: bar.measureIndex, playIndex: bar.playIndex };

    // A note that's off: the most useful thing to fix.
    const off = notes.find((n) => n.pitch === 'wrong');
    if (off) {
      const expectedMidi = off.expected[off.expected.length - 1];
      const playedMidi = off.played.length ? Math.round(off.played[0]) : undefined;
      // Did they miss an accidental from the key signature? (played a semitone away)
      const keyHint = playedMidi !== undefined && missedKeySignature(expectedMidi, playedMidi, off.fifths);
      candidates.push({
        ...base,
        kind: 'pitch',
        severity: (bar.offPitch / Math.max(1, bar.notes)) * 60 + 5,
        expectedMidi,
        playedMidi,
        keyHint,
        fifths: off.fifths,
        fix: { type: 'note', noteId: off.id, measureIndex: off.measureIndex, loop: loopAround(bar.measureIndex, maxMeasureIndex) },
      });
    }

    if (bar.missed >= Math.max(1, Math.ceil(bar.notes / 3)) && bar.missed < bar.notes + 1) {
      candidates.push({
        ...base,
        kind: 'missed',
        severity: (bar.missed / bar.notes) * 50,
        fix: loopAround(bar.measureIndex, maxMeasureIndex),
      });
    }

    if (Math.abs(bar.meanOnsetErrorMs) >= cfg.rushedMs && bar.notes - bar.missed >= 2) {
      candidates.push({
        ...base,
        kind: bar.meanOnsetErrorMs < 0 ? 'rushed' : 'dragging',
        severity: (1 - bar.rhythmAccuracy) * 30 + 3,
        fix: loopAround(bar.measureIndex, maxMeasureIndex),
      });
    }

    if (instrument !== 'piano') {
      const close = notes.find((n) => n.pitch === 'close' && n.centsOff !== undefined);
      if (close) {
        candidates.push({
          ...base,
          kind: 'tuning',
          severity: (bar.close / bar.notes) * 25,
          expectedMidi: close.expected[0],
          direction: (close.centsOff ?? 0) > 0 ? 'high' : 'low',
          fix: loopAround(bar.measureIndex, maxMeasureIndex),
        });
      }
      if (bar.short >= Math.max(1, Math.ceil(bar.notes / 2))) {
        candidates.push({
          ...base,
          kind: 'short',
          severity: (bar.short / bar.notes) * 8,
          fix: loopAround(bar.measureIndex, maxMeasureIndex, 1),
        });
      }
    }
  }

  // Only bars the player actually reached.
  const reachedPlay = Math.max(-1, ...run.notes.filter((n) => n.pitch !== 'missed').map((n) => n.playIndex));
  const usable = candidates.filter((c) => c.playIndex <= reachedPlay);

  usable.sort((a, b) => b.severity - a.severity || a.playIndex - b.playIndex);
  const out: Issue[] = [];
  const usedBars = new Set<string>();
  for (const c of usable) {
    if (usedBars.has(c.bar)) continue;
    usedBars.add(c.bar);
    out.push(c);
    if (out.length >= cfg.maxIssues) break;
  }
  return out;
}

/** Things they did well, best first. There is always at least one. Pure. */
export function findPositives(run: RunScore, bestBefore?: number): Positive[] {
  const out: Positive[] = [];
  if (bestBefore !== undefined && run.score > bestBefore) out.push({ kind: 'improved', count: run.score - bestBefore });
  if (run.completion >= 0.999) out.push({ kind: 'allTheWay' });
  if (run.pitchAccuracy >= 0.85) out.push({ kind: 'greatPitch' });
  if (run.rhythmAccuracy >= 0.8) out.push({ kind: 'steadyRhythm' });
  const perfect = run.bars.filter((b: BarResult) => b.perfect).length;
  if (perfect > 0) out.push({ kind: 'perfectBars', count: perfect, bar: run.bars.find((b) => b.perfect)?.bar });
  const first = run.bars[0];
  if (first && first.pitchAccuracy >= 0.75) out.push({ kind: 'goodStart' });
  const last = run.bars[run.bars.length - 1];
  if (last && run.completion >= 0.999 && last.pitchAccuracy >= 0.75 && run.bars.length > 1) out.push({ kind: 'strongFinish' });
  if (out.length === 0) out.push({ kind: 'effort' });
  return out;
}
