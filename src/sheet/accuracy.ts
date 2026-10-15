import { midiOf } from './checks';
import { parseStaff, type RnMeasure, type RnScore } from './notation';

/**
 * How close a transcription is to a hand-made reference, bar by bar.
 *
 * Bars are matched by content (so a missing pickup or an extra bar doesn't
 * shift everything after it), then notes inside each pair of bars are matched
 * in order. Pitch accuracy = matched notes / the larger of the two note counts
 * (extra notes count against it too). Rhythm accuracy (strict) = matched notes
 * that also start at the same point in the bar and last the same time, /
 * reference notes: one missing note early in a bar shifts every later note, so
 * this is harsh. Lengths = matched notes with the right length (wherever they
 * start), / reference notes.
 */

interface Ev {
  /** Sorted MIDI numbers ('' for a rest). */
  pitch: string;
  start: number;
  len: number;
}

export interface BarAccuracy {
  /** Reference bar number (or predicted, for an extra bar). */
  n: number;
  /** Predicted bar number it was matched with, if any. */
  matchedN?: number;
  refNotes: number;
  predNotes: number;
  pitchMatched: number;
  rhythmMatched: number;
  lengthMatched: number;
  pitch: number;
  rhythm: number;
  lengths: number;
  uncertain?: boolean;
  extra?: boolean;
}

export interface AccuracyReport {
  bars: BarAccuracy[];
  /** Over all certain bars (missing bars count as 0). */
  pitch: number;
  rhythm: number;
  lengths: number;
  key: { ref?: number; got?: number; ok: boolean };
  time: { ref?: string; got?: string; ok: boolean };
  pickup: { ok: boolean; detail: string };
  barsExpected: number;
  barsFound: number;
}

function events(m: RnMeasure | undefined): Ev[] {
  if (!m?.s1) return [];
  const out: Ev[] = [];
  let t = 0;
  try {
    for (const e of [...parseStaff(m.s1), ...(m.s2 ? parseStaff(m.s2) : [])]) {
      if (e.kind === 'barRest') continue;
      if (e.kind === 'note') out.push({ pitch: e.pitches.map(midiOf).sort((a, b) => a - b).join('+'), start: t, len: e.quarters });
      t += e.quarters;
    }
  } catch {
    return [];
  }
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** Longest common subsequence of two note lists by pitch; returns matched index pairs. */
function lcs(a: Ev[], b: Ev[]): [number, number][] {
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i].pitch === b[j].pitch ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i].pitch === b[j].pitch) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

function compareBar(ref: Ev[], pred: Ev[]) {
  const pairs = lcs(ref, pred);
  const rhythm = pairs.filter(([i, j]) => near(ref[i].start, pred[j].start) && near(ref[i].len, pred[j].len)).length;
  const lengths = pairs.filter(([i, j]) => near(ref[i].len, pred[j].len)).length;
  return { pitchMatched: pairs.length, rhythmMatched: rhythm, lengthMatched: lengths };
}

const num = (m: RnMeasure, i: number) => (Number.isFinite(Number(m.n)) ? Number(m.n) : i);

export function compareScores(pred: RnScore, ref: RnScore & { uncertain?: number[] }): AccuracyReport {
  const R = ref.measures.map(events);
  const P = (pred.measures ?? []).map(events);
  // Align bars: maximise matched notes; gaps cost nothing (they just score 0).
  const score = (i: number, j: number) => compareBar(R[i], P[j]).pitchMatched;
  const dp = Array.from({ length: R.length + 1 }, () => new Array<number>(P.length + 1).fill(0));
  for (let i = R.length - 1; i >= 0; i--) {
    for (let j = P.length - 1; j >= 0; j--) {
      dp[i][j] = Math.max(dp[i + 1][j + 1] + score(i, j), dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const match = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i < R.length && j < P.length) {
    const s = score(i, j);
    if (dp[i][j] === dp[i + 1][j + 1] + s && (s > 0 || (R[i].length === 0 && P[j].length === 0))) {
      match.set(i, j);
      i++;
      j++;
    } else if (dp[i][j] === dp[i + 1][j]) i++;
    else j++;
  }
  const uncertain = new Set(ref.uncertain ?? []);
  const bars: BarAccuracy[] = ref.measures.map((m, ri) => {
    const pj = match.get(ri);
    const pe = pj === undefined ? [] : P[pj];
    const { pitchMatched, rhythmMatched, lengthMatched } = compareBar(R[ri], pe);
    const denom = Math.max(R[ri].length, pe.length);
    return {
      n: num(m, ri),
      matchedN: pj === undefined ? undefined : num(pred.measures[pj], pj),
      refNotes: R[ri].length,
      predNotes: pe.length,
      pitchMatched,
      rhythmMatched,
      lengthMatched,
      pitch: denom ? pitchMatched / denom : 1,
      rhythm: R[ri].length ? rhythmMatched / R[ri].length : 1,
      lengths: R[ri].length ? lengthMatched / R[ri].length : 1,
      uncertain: uncertain.has(num(m, ri)) || undefined,
    };
  });
  const used = new Set(match.values());
  P.forEach((pe, pj) => {
    if (!used.has(pj) && pe.length) bars.push({ n: num(pred.measures[pj], pj), matchedN: num(pred.measures[pj], pj), refNotes: 0, predNotes: pe.length, pitchMatched: 0, rhythmMatched: 0, lengthMatched: 0, pitch: 0, rhythm: 0, lengths: 0, extra: true });
  });
  const counted = bars.filter((b) => !b.uncertain);
  const sum = (f: (b: BarAccuracy) => number) => counted.reduce((s, b) => s + f(b), 0);
  const pitch = sum((b) => b.pitchMatched) / Math.max(1, sum((b) => Math.max(b.refNotes, b.predNotes)));
  const rhythm = sum((b) => b.rhythmMatched) / Math.max(1, sum((b) => b.refNotes + (b.extra ? b.predNotes : 0)));
  const lengths = sum((b) => b.lengthMatched) / Math.max(1, sum((b) => b.refNotes + (b.extra ? b.predNotes : 0)));

  const firstKey = (s: RnScore) => s.measures?.find((m) => m.key !== undefined)?.key;
  const firstTime = (s: RnScore) => s.measures?.find((m) => m.time !== undefined)?.time;
  const refPickup = ref.measures[0]?.pickup ? R[0] : null;
  const predFirst = pred.measures?.[0];
  let pickup: AccuracyReport['pickup'];
  if (!refPickup) pickup = { ok: !predFirst?.pickup, detail: predFirst?.pickup ? 'pickup added that is not there' : 'no pickup, as expected' };
  else if (!predFirst?.pickup) pickup = { ok: false, detail: 'pickup bar missing' };
  else {
    const pe = P[0];
    const same = pe.length === refPickup.length && pe.every((e, k) => e.pitch === refPickup[k].pitch && near(e.len, refPickup[k].len));
    pickup = { ok: same, detail: same ? 'pickup correct' : 'pickup bar has different notes' };
  }
  return {
    bars,
    pitch,
    rhythm,
    lengths,
    key: { ref: firstKey(ref), got: firstKey(pred), ok: firstKey(ref) === firstKey(pred) },
    time: { ref: firstTime(ref), got: firstTime(pred), ok: firstTime(ref) === firstTime(pred) },
    pickup,
    barsExpected: ref.measures.length,
    barsFound: pred.measures?.length ?? 0,
  };
}

/** Each hand of a grand staff on its own: right = upper staff (s1), left = lower staff (s2). Pure. */
export function compareHands(pred: RnScore, ref: RnScore & { uncertain?: number[] }): { right: AccuracyReport; left: AccuracyReport } {
  const only = <T extends RnScore>(s: T, k: 's1' | 's2'): T => ({ ...s, measures: (s.measures ?? []).map((m) => ({ ...m, s1: m[k], s2: undefined })) });
  return { right: compareScores(only(pred, 's1'), only(ref, 's1')), left: compareScores(only(pred, 's2'), only(ref, 's2')) };
}

/** Bars read exactly right (every note's pitch, start and length) and notes with the right pitch, for one report. Pure. */
export function exactCounts(r: AccuracyReport): { bars: number; of: number; notes: number; notesOf: number } {
  const real = r.bars.filter((b) => !b.extra && !b.uncertain);
  const extraNotes = r.bars.filter((b) => b.extra).reduce((s, b) => s + b.predNotes, 0);
  return {
    bars: real.filter((b) => b.matchedN !== undefined && b.refNotes === b.predNotes && b.rhythmMatched === b.refNotes).length,
    of: real.length,
    notes: real.reduce((s, b) => s + b.pitchMatched, 0),
    notesOf: real.reduce((s, b) => s + Math.max(b.refNotes, b.predNotes), 0) + extraNotes,
  };
}

/** Plain-text table for the console / PR. */
export function formatReport(r: AccuracyReport, label = ''): string {
  const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
  const lines = [
    `${label}pitch ${pct(r.pitch)}, rhythm ${pct(r.rhythm)} (note lengths ${pct(r.lengths)}); key ${r.key.ok ? 'ok' : `wrong (${r.key.got} vs ${r.key.ref})`}, time ${r.time.ok ? 'ok' : `wrong (${r.time.got} vs ${r.time.ref})`}, ${r.pickup.detail}; bars ${r.barsFound}/${r.barsExpected}`,
    'bar  notes  pitch   rhythm  lengths',
  ];
  for (const b of r.bars) {
    lines.push(`${String(b.extra ? `+${b.n}` : b.n).padStart(3)}  ${String(b.refNotes).padStart(5)}  ${pct(b.pitch).padStart(6)}  ${pct(b.rhythm).padStart(6)}  ${pct(b.lengths).padStart(6)}${b.uncertain ? '  (uncertain, not counted)' : ''}${b.matchedN === undefined && !b.extra ? '  (missing)' : ''}`);
  }
  return lines.join('\n');
}

/** The score as first read (before any double-check), built the same way as the final one. Pure. */
export function firstReadScore(final: RnScore, lines: { firstRead: RnMeasure[] }[]): RnScore {
  const measures = lines.flatMap((l) => l.firstRead);
  if (measures.length) {
    const m0 = final.measures[0] ?? {};
    measures[0] = { ...measures[0], key: measures[0].key ?? m0.key, time: measures[0].time ?? m0.time, clef: measures[0].clef ?? m0.clef };
  }
  return { ...final, measures };
}
