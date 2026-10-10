import type { Timeline } from '../sheet/expected';

export interface Beat {
  /** ms relative to the start of the piece (count-in beats are negative). */
  timeMs: number;
  /** Index into the timeline's bars (-1 for count-in). */
  bar: number;
  beat: number;
  accent: boolean;
  countIn: boolean;
}

/**
 * Every click for a run: a one-bar count-in, then each beat of each played bar.
 * Pure, so the click times are exactly known for onset suppression.
 */
export function buildBeatGrid(timeline: Timeline): Beat[] {
  const beats: Beat[] = [];
  const first = timeline.bars[0];
  if (!first) return beats;
  const q = timeline.msPerQuarter;
  const countBeats = first.beats;
  const countBeatMs = (4 / first.beatType) * q;
  for (let i = 0; i < countBeats; i++) {
    beats.push({ timeMs: -(countBeats - i) * countBeatMs, bar: -1, beat: i, accent: i === 0, countIn: true });
  }
  timeline.bars.forEach((bar, bi) => {
    const beatQ = 4 / bar.beatType;
    const nBeats = Math.max(1, Math.round(bar.lengthQ / beatQ));
    // A pickup bar only has its last beats, so its first click isn't the downbeat.
    const offset = bar.lengthQ < bar.beats * beatQ - 1e-6 ? bar.beats - nBeats : 0;
    for (let i = 0; i < nBeats; i++) {
      beats.push({
        timeMs: (bar.startQ + i * beatQ) * q,
        bar: bi,
        beat: i + offset,
        accent: i + offset === 0,
        countIn: false,
      });
    }
  });
  return beats;
}

/** Length of the count-in in ms. */
export function countInMs(timeline: Timeline): number {
  const first = timeline.bars[0];
  if (!first) return 0;
  return first.beats * (4 / first.beatType) * timeline.msPerQuarter;
}
