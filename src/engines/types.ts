/** The one shape every listening engine emits (SPEC §3). */
export type NoteEvent = {
  /** MIDI note number (float allowed for cents). */
  midi: number;
  /** Deviation from the nearest semitone, in cents. */
  cents: number;
  /** Relative to session start, latency-corrected. */
  onsetMs: number;
  durationMs: number;
  /** 0..1 */
  confidence: number;
};

export interface ListeningEngine {
  /** Feed mono samples. `startMs` is the session time of the first sample (before latency correction). */
  process(samples: Float32Array, startMs: number): void;
  /** Notes detected so far. The last one may still be growing. */
  notes(): NoteEvent[];
  /** Flush and return the final note list. */
  finish(): Promise<NoteEvent[]> | NoteEvent[];
  /** Notes safe to follow live (won't be merged away later). Defaults to notes(). */
  settledNotes?(): NoteEvent[];
  setClickTimes?(times: number[]): void;
  /** Live input level 0..1 for the meter. */
  level?: number;
  reset(): void;
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function centsOf(midi: number): number {
  return Math.round((midi - Math.round(midi)) * 100);
}
