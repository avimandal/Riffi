/** Piano engine tuning (SPEC §6.2). */
export const PIANO_ENGINE = {
  /** Basic Pitch constants (from basic_pitch/constants.py). */
  sampleRate: 22050,
  fftHop: 256,
  windowSamples: 22050 * 2 - 256,
  windowFrames: 172,
  /** Frames trimmed at each window edge (the model's context). */
  edgeFrames: 15,
  /** Frames produced per live step (~0.5 s). Smaller = lower latency, more work. */
  liveStepFrames: 43,
  /** Frames per step when analysing a whole recording ("play then score"). */
  offlineStepFrames: 142,
  onsetThreshold: 0.5,
  frameThreshold: 0.3,
  /** Shortest note, in model frames (~93 ms). */
  minNoteFrames: 8,
  energyTolerance: 11,
  /** Highest note we accept (C7); the metronome click lives up above this. */
  maxMidi: 96,
  minMidi: 21,
  /** Notes this close to a click that are short or quiet are dropped. */
  clickMaskMs: 35,
  clickShortMs: 120,
  clickQuietAmplitude: 0.35,
  /** Same pitch, onsets this close → one note. */
  dedupeMs: 50,
  /** If a live step takes longer than this share of its audio duration, we can't keep up. */
  realtimeBudget: 0.75,
  /** If warm-up inference takes longer than this, the device is too slow for live. */
  slowFirstInferenceMs: 2500,
  /** Re-run note extraction over at most this many trailing frames (~40 s). */
  maxRecomputeFrames: 3440,
} as const;

export const stepSeconds = (frames: number) => (frames * PIANO_ENGINE.fftHop) / PIANO_ENGINE.sampleRate;
