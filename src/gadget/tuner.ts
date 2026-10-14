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
export const IN_TUNE_CENTS = 10;

/** How the tuner steadies the raw pitch (see TunerSmoother). */
export const TUNER_SMOOTHING = {
  /** Average over this much recent sound: a few vibrato cycles, so vibrato cancels out. */
  windowMs: 800,
  /** A different note must hold this long before the display moves to it (drops overtone blips). */
  changeMs: 160,
  /** The first note shows after this long. */
  firstMs: 90,
  /** Readings this close (semitones) count as the same note. */
  sameNote: 0.5,
  /** Keep showing the last note this long after the sound stops. */
  holdMs: 1200,
} as const;

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

/**
 * Steadies the pitch engine's readings for the tuner display: averages the
 * last ~0.8 s of the note being shown (so vibrato and bow noise cancel out),
 * ignores brief jumps (an overtone popping out, a scratch), and only moves to a
 * new note once it has held for a moment. Works in MIDI (A = 440). Pure.
 */
export class TunerSmoother {
  private readings: { midi: number; t: number }[] = [];
  private candidate: { midi: number; t: number }[] = [];
  private lastHeard = -Infinity;
  private note: number | null = null;

  constructor(private readonly cfg: typeof TUNER_SMOOTHING = TUNER_SMOOTHING) {}

  /** Feed the latest reading (null when nothing clear is heard) at time `t` (ms). Returns the pitch to show, or null. */
  push(midi: number | null, t: number): number | null {
    const c = this.cfg;
    if (midi !== null && Number.isFinite(midi)) {
      this.lastHeard = t;
      if (this.note !== null && Math.abs(midi - this.note) <= c.sameNote) {
        this.readings.push({ midi, t });
        this.candidate = [];
      } else {
        // Something else: a new note, or a blip. Collect it until it proves itself.
        if (this.candidate.length && Math.abs(midi - median(this.candidate.map((x) => x.midi))) > c.sameNote) this.candidate = [];
        this.candidate.push({ midi, t });
        const held = t - this.candidate[0].t;
        if (held >= (this.note === null ? c.firstMs : c.changeMs)) {
          this.readings = this.candidate;
          this.candidate = [];
        }
      }
      if (this.readings.length) this.note = median(this.readings.slice(-8).map((x) => x.midi));
    }
    if (t - this.lastHeard > c.holdMs) {
      this.reset();
      return null;
    }
    this.readings = this.readings.filter((x) => x.t >= t - c.windowMs);
    if (this.note === null) return null;
    if (this.readings.length === 0) return this.note;
    return this.readings.reduce((s, x) => s + x.midi, 0) / this.readings.length;
  }

  reset() {
    this.readings = [];
    this.candidate = [];
    this.note = null;
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Frequency of a note in the chosen reference tuning. */
export function noteHz(midi: number, refHz: number): number {
  return refHz * Math.pow(2, (midi - 69) / 12);
}

export function clampRef(hz: number): number {
  return Math.max(REF_MIN, Math.min(REF_MAX, Math.round(hz)));
}
