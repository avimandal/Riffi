/** Pure logic for the Tuner & Metronome gadget's metronome. */
import type { ClickLevel, MetronomeSound } from '../audio/sounds';

export const GADGET_TEMPO_MIN = 30;
export const GADGET_TEMPO_MAX = 250;

export const TIME_SIGNATURES = ['2/4', '3/4', '4/4', '5/4', '6/8', '7/8', '12/8'] as const;
export type TimeSignature = (typeof TIME_SIGNATURES)[number];

export const SUBDIVISIONS = ['none', 'eighths', 'triplets', 'sixteenths'] as const;
export type Subdivision = (typeof SUBDIVISIONS)[number];

/** Clicks per beat for each subdivision. */
export const SUBDIVISION_COUNT: Record<Subdivision, number> = { none: 1, eighths: 2, triplets: 3, sixteenths: 4 };

export interface MetronomeSettings {
  bpm: number;
  timeSignature: TimeSignature;
  sound: MetronomeSound;
  accent: boolean;
  subdivision: Subdivision;
}

export const DEFAULT_METRONOME: MetronomeSettings = {
  bpm: 100,
  timeSignature: '4/4',
  sound: 'woodblock',
  accent: true,
  subdivision: 'none',
};

export function beatsPerBar(ts: TimeSignature): number {
  return Number(ts.split('/')[0]);
}

export function clampTempo(bpm: number): number {
  return Math.max(GADGET_TEMPO_MIN, Math.min(GADGET_TEMPO_MAX, Math.round(bpm)));
}

const TEMPO_NAMES: [number, string][] = [
  [40, 'Grave'],
  [60, 'Largo'],
  [66, 'Larghetto'],
  [76, 'Adagio'],
  [108, 'Andante'],
  [120, 'Moderato'],
  [156, 'Allegro'],
  [176, 'Vivace'],
  [200, 'Presto'],
  [Infinity, 'Prestissimo'],
];

/** The Italian tempo marking for a BPM (Largo, Andante, Allegro…). */
export function tempoName(bpm: number): string {
  for (const [upTo, name] of TEMPO_NAMES) if (bpm < upTo) return name;
  return 'Prestissimo';
}

/**
 * Tap tempo: the average of the last few intervals. Taps more than 2 s apart
 * start over. Returns null until there are two taps.
 */
export function tapTempo(tapsMs: number[]): number | null {
  const recent: number[] = [];
  for (let i = tapsMs.length - 1; i >= 0; i--) {
    if (recent.length && recent[recent.length - 1] - tapsMs[i] > 2000) break;
    recent.push(tapsMs[i]);
    if (recent.length === 6) break;
  }
  if (recent.length < 2) return null;
  const span = recent[0] - recent[recent.length - 1];
  return clampTempo((60000 * (recent.length - 1)) / span);
}

/** One metronome click. */
export interface Tick {
  /** Audio-clock time (s). */
  when: number;
  /** Beat in the bar, from 0. */
  beat: number;
  /** Subdivision within the beat, from 0 (0 = the beat itself). */
  sub: number;
  level: ClickLevel;
}

/** Level of a click: accent on beat 1 (if on), ordinary beat, or a quieter subdivision. Pure. */
export function levelFor(beat: number, sub: number, accent: boolean): ClickLevel {
  if (sub > 0) return 'sub';
  return beat === 0 && accent ? 'accent' : 'beat';
}

/**
 * The click after `prev` with the settings as they are now, so a tempo or
 * time-signature change takes effect on the very next click. Pure.
 */
export function nextTick(prev: Tick | null, s: MetronomeSettings, startAt: number): Tick {
  if (!prev) return { when: startAt, beat: 0, sub: 0, level: levelFor(0, 0, s.accent) };
  const per = SUBDIVISION_COUNT[s.subdivision];
  const interval = 60 / s.bpm / per;
  let sub = prev.sub + 1;
  let beat = prev.beat;
  if (sub >= per) {
    sub = 0;
    beat = (beat + 1) % beatsPerBar(s.timeSignature);
  }
  return { when: prev.when + interval, beat, sub, level: levelFor(beat, sub, s.accent) };
}

export const PRACTICE_TIMERS = [0, 5, 10, 15] as const;

export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
