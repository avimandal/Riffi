/** Pure logic for the Tuner & Metronome gadget's tuner. */

export const TUNER_INSTRUMENTS = ['violin', 'voice', 'chromatic'] as const;
export type TunerInstrument = (typeof TUNER_INSTRUMENTS)[number];

export const VIOLIN_STRINGS = [
  { name: 'G', midi: 55 },
  { name: 'D', midi: 62 },
  { name: 'A', midi: 69 },
  { name: 'E', midi: 76 },
] as const;
export type ViolinString = (typeof VIOLIN_STRINGS)[number]['name'];

export const REF_MIN = 438;
export const REF_MAX = 445;
export const REF_DEFAULT = 440;

/** Within this many cents counts as in tune (green). */
export const IN_TUNE_CENTS = 5;

/** What each tuner preset listens for (MIDI range). */
export const TUNER_RANGE: Record<TunerInstrument, { low: number; high: number }> = {
  violin: { low: 52, high: 100 },
  voice: { low: 40, high: 86 },
  chromatic: { low: 28, high: 105 },
};

const NAMES = ['C', 'C', 'D', 'D', 'E', 'F', 'F', 'G', 'G', 'A', 'A', 'B'];
const SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];

export interface TunerReading {
  /** Target note (MIDI, in the reference tuning). */
  target: number;
  letter: string;
  sharp: boolean;
  octave: number;
  /** How far off the target, in cents (positive = sharp). */
  cents: number;
  status: 'flat' | 'in' | 'sharp';
  /** The violin string being tuned, if any. */
  string?: ViolinString;
}

/** Convert a pitch measured against A = 440 into the chosen reference tuning. */
export function toReference(midi440: number, refHz: number): number {
  return midi440 - 12 * Math.log2(refHz / 440);
}

export function noteParts(midi: number): { letter: string; sharp: boolean; octave: number } {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  return { letter: NAMES[pc], sharp: SHARP[pc], octave: Math.floor(m / 12) - 1 };
}

/**
 * Read a detected pitch for the tuner display. Violin with a string chosen
 * tunes that string; violin without one picks the nearest string (if close);
 * voice and chromatic use the nearest semitone. Pure.
 */
export function tunerReading(midi440: number, refHz: number, instrument: TunerInstrument, string?: ViolinString | null): TunerReading {
  const m = toReference(midi440, refHz);
  let target = Math.round(m);
  let chosen: ViolinString | undefined;
  if (instrument === 'violin') {
    if (string) {
      const s = VIOLIN_STRINGS.find((x) => x.name === string)!;
      target = s.midi;
      chosen = s.name;
    } else {
      const nearest = [...VIOLIN_STRINGS].sort((a, b) => Math.abs(a.midi - m) - Math.abs(b.midi - m))[0];
      if (Math.abs(nearest.midi - m) <= 3.5) {
        target = nearest.midi;
        chosen = nearest.name;
      }
    }
  }
  const cents = Math.round((m - target) * 100);
  const status = Math.abs(cents) <= IN_TUNE_CENTS ? 'in' : cents < 0 ? 'flat' : 'sharp';
  return { target, ...noteParts(target), cents, status, string: chosen };
}

/** Frequency of a note in the chosen reference tuning. */
export function noteHz(midi: number, refHz: number): number {
  return refHz * Math.pow(2, (midi - 69) / 12);
}

export function clampRef(hz: number): number {
  return Math.max(REF_MIN, Math.min(REF_MAX, Math.round(hz)));
}
