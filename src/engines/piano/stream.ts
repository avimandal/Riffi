import type * as TF from '@tensorflow/tfjs';
import { outputToNotesPoly } from '@spotify/basic-pitch/esm/toMidi.js';
import { PIANO_ENGINE } from './config';
import type { RawPianoNote } from './postprocess';

const OUTPUT_FRAMES = 'Identity_1';
const OUTPUT_ONSETS = 'Identity_2';

/**
 * Streaming Basic Pitch. Audio (22,050 Hz mono) is appended as it arrives;
 * each step runs the model on a 2 s window and keeps the frames just inside
 * its right edge, so output frames are contiguous and the look-ahead is only
 * the model's own context (~0.17 s).
 *
 * Shared by the Web Worker and the unit tests (which run it on tfjs-cpu).
 */
export class BasicPitchStream {
  private audio: Float32Array = new Float32Array(22050 * 30);
  private length = 0;
  private nextFrame = 0;
  private frames: number[][] = [];
  private onsets: number[][] = [];
  private finalNotes: RawPianoNote[] = [];
  private finalBeforeFrame = 0;
  stepMs: number[] = [];

  constructor(
    private readonly tf: typeof TF,
    private readonly model: TF.GraphModel,
    private readonly stepFrames: number = PIANO_ENGINE.liveStepFrames,
  ) {}

  append(samples: Float32Array) {
    if (this.length + samples.length > this.audio.length) {
      const bigger = new Float32Array(Math.max(this.audio.length * 2, this.length + samples.length));
      bigger.set(this.audio.subarray(0, this.length));
      this.audio = bigger;
    }
    this.audio.set(samples, this.length);
    this.length += samples.length;
  }

  get audioSeconds(): number {
    return this.length / PIANO_ENGINE.sampleRate;
  }

  /** Whether another step can run with the audio we have (or, when flushing, whether any audio is left). */
  canStep(flush = false): boolean {
    const cfg = PIANO_ENGINE;
    if (flush) return this.nextFrame < Math.ceil(this.length / cfg.fftHop);
    // A step's window ends this many samples after its last output frame.
    const lookAhead = cfg.windowSamples - (cfg.windowFrames - cfg.edgeFrames) * cfg.fftHop;
    return this.length >= (this.nextFrame + this.stepFrames) * cfg.fftHop + lookAhead;
  }

  /** Run one model step. Returns the time it took (ms). */
  step(): number {
    const cfg = PIANO_ENGINE;
    const tf = this.tf;
    const t0 = performance.now();
    const k = this.stepFrames;
    const firstUsable = cfg.windowFrames - cfg.edgeFrames - k;
    const windowStart = (this.nextFrame - firstUsable) * cfg.fftHop;

    const input = new Float32Array(cfg.windowSamples);
    const from = Math.max(0, windowStart);
    const to = Math.min(this.length, windowStart + cfg.windowSamples);
    if (to > from) input.set(this.audio.subarray(from, to), from - windowStart);

    const [fr, on] = tf.tidy(() => {
      const x = tf.tensor3d(input, [1, cfg.windowSamples, 1]);
      const out = this.model.execute(x, [OUTPUT_FRAMES, OUTPUT_ONSETS]) as TF.Tensor[];
      return out.map((t) => t.squeeze([0]).slice([firstUsable, 0], [k, -1]));
    }) as [TF.Tensor2D, TF.Tensor2D];
    const framesArr = fr.arraySync() as number[][];
    const onsetsArr = on.arraySync() as number[][];
    fr.dispose();
    on.dispose();
    for (let i = 0; i < framesArr.length; i++) {
      this.frames.push(framesArr[i]);
      this.onsets.push(onsetsArr[i]);
    }
    this.nextFrame += k;
    const ms = performance.now() - t0;
    this.stepMs.push(ms);
    return ms;
  }

  /** Run every step that is ready. */
  runReady(flush = false): number {
    let n = 0;
    while (this.canStep(flush)) {
      this.step();
      n++;
    }
    return n;
  }

  /** Extract notes from all frames produced so far. */
  notes(): RawPianoNote[] {
    const cfg = PIANO_ENGINE;
    const total = this.frames.length;
    const usableEnd = Math.min(total, Math.ceil(this.length / cfg.fftHop));
    // Bound the work for long sessions: older notes are frozen.
    if (usableEnd - this.finalBeforeFrame > cfg.maxRecomputeFrames) {
      const newBoundary = usableEnd - Math.floor(cfg.maxRecomputeFrames / 2);
      const older = this.extract(this.finalBeforeFrame, usableEnd).filter(
        (n) => n.startSeconds * (cfg.sampleRate / cfg.fftHop) < newBoundary,
      );
      this.finalNotes.push(...older);
      this.finalBeforeFrame = newBoundary;
    }
    return [...this.finalNotes, ...this.extract(this.finalBeforeFrame, usableEnd)];
  }

  private extract(fromFrame: number, toFrame: number): RawPianoNote[] {
    const cfg = PIANO_ENGINE;
    if (toFrame - fromFrame < cfg.minNoteFrames) return [];
    const frames = this.frames.slice(fromFrame, toFrame);
    const onsets = this.onsets.slice(fromFrame, toFrame);
    const raw = outputToNotesPoly(
      frames,
      onsets,
      cfg.onsetThreshold,
      cfg.frameThreshold,
      cfg.minNoteFrames,
      true,
      null,
      null,
      true,
      cfg.energyTolerance,
    );
    const secPerFrame = cfg.fftHop / cfg.sampleRate;
    return raw.map((n) => ({
      startSeconds: (n.startFrame + fromFrame) * secPerFrame,
      durationSeconds: n.durationFrames * secPerFrame,
      pitchMidi: n.pitchMidi,
      amplitude: n.amplitude,
    }));
  }

  reset() {
    this.length = 0;
    this.nextFrame = 0;
    this.frames = [];
    this.onsets = [];
    this.finalNotes = [];
    this.finalBeforeFrame = 0;
    this.stepMs = [];
  }
}
