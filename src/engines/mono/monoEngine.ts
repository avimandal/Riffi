import { PitchDetector } from 'pitchy';
import { INSTRUMENT_RANGE, type Instrument } from '../../config';
import { Biquad, median, rms } from '../../audio/dsp';
import { centsOf, hzToMidi, type ListeningEngine, type NoteEvent } from '../types';

/** Mono engine tuning (violin, voice). SPEC §6.1. */
export const MONO_ENGINE = {
  windowSize: 2048,
  hopSize: 256,
  minClarity: 0.9,
  /** Used until the mic check measures the room's noise floor. */
  defaultRmsThreshold: 0.008,
  /** Threshold = noise floor × this. */
  noiseFloorMultiplier: 3,
  minRmsThreshold: 0.002,
  medianFrames: 5,
  /** A new note starts when pitch moves more than this… */
  changeCents: 60,
  /** …and holds for at least this long. */
  holdMs: 60,
  /** Shortest note we report (blips are ignored). */
  minNoteMs: 60,
  /** Unvoiced time that ends a note. */
  gapMs: 50,
  /** Ignore analysis frames this close to a metronome click (SPEC §5). */
  clickMaskMs: 35,
  /** Click sound centre, relative to its scheduled start. */
  clickCentreMs: 10,
  /** Analysis band: keeps the >4 kHz click out of the pitch tracker. */
  lowpassHz: 3500,
  highpassHz: 60,
  /** Same-pitch re-attack (bow change / re-sung note): dip below this share of the note's level… */
  reattackDip: 0.35,
  /** …then recover above this share, within `reattackWindowMs`. */
  reattackRecover: 0.75,
  reattackWindowMs: 160,
  /**
   * Slides (sung glides, violin shifts) leave short in-between fragments.
   * A fragment shorter than this, pitched between its neighbours and off the
   * semitone grid, is folded into the note it was sliding to.
   */
  glideMergeMs: 100,
  glideOffGridCents: 25,
  /** Range slack either side of the instrument range, in semitones. */
  rangeSlack: 1,
} as const;

interface Frame {
  t: number; // ms, latency-corrected, centre of the analysis window
  midi: number; // median-filtered
  clarity: number;
  rms: number;
}

export interface MonoEngineOptions {
  instrument: Exclude<Instrument, 'piano'>;
  sampleRate: number;
  latencyMs?: number;
  /** Measured RMS of the room with nobody playing. */
  noiseFloor?: number;
}

/**
 * Pitch-tracking note segmenter. Segments by pitch, not volume, so bowed and
 * sung notes that start softly still count, and reports each note's pitch as
 * the median over its body so vibrato isn't a mistake.
 */
export class MonoEngine implements ListeningEngine {
  private readonly detector: PitchDetector<Float32Array>;
  private readonly window: Float32Array;
  private ring: Float32Array;
  private ringFill = 0;
  private ringPos = 0;
  private sinceHop = 0;
  private samplesSeen = 0;
  private t0Ms: number | null = null;
  private lp1: Biquad;
  private lp2: Biquad;
  private hp: Biquad;
  private readonly minMidi: number;
  private readonly maxMidi: number;
  private readonly threshold: number;
  private readonly hopMs: number;

  private medianBuf: number[] = [];
  private out: NoteEvent[] = [];
  private meta: { bodyStart: number; endedByChange: boolean }[] = [];
  private current: { frames: Frame[]; startT: number; lastVoicedT: number; peakRms: number; dipT: number | null } | null = null;
  private candidate: Frame[] = [];
  private candidateStart = 0;
  private maskedRun: Frame[] = [];
  private gapMs = 0;
  private clicks: number[] = [];
  private clickCursor = 0;
  /** Live input level 0..1 for the meter. */
  level = 0;

  constructor(private readonly opts: MonoEngineOptions) {
    const cfg = MONO_ENGINE;
    this.detector = PitchDetector.forFloat32Array(cfg.windowSize);
    this.detector.minVolumeDecibels = -70;
    this.window = new Float32Array(cfg.windowSize);
    this.ring = new Float32Array(cfg.windowSize);
    const sr = opts.sampleRate;
    this.lp1 = Biquad.lowpass(sr, cfg.lowpassHz);
    this.lp2 = Biquad.lowpass(sr, cfg.lowpassHz);
    this.hp = Biquad.highpass(sr, cfg.highpassHz);
    const range = INSTRUMENT_RANGE[opts.instrument];
    this.minMidi = range.low - cfg.rangeSlack;
    this.maxMidi = range.high + cfg.rangeSlack;
    this.threshold =
      opts.noiseFloor !== undefined
        ? Math.max(cfg.minRmsThreshold, opts.noiseFloor * cfg.noiseFloorMultiplier)
        : cfg.defaultRmsThreshold;
    this.hopMs = (cfg.hopSize / sr) * 1000;
  }

  /** Metronome click times (session ms, already in the corrected time base). */
  setClickTimes(times: number[]) {
    this.clicks = [...times].sort((a, b) => a - b);
    this.clickCursor = 0;
  }

  private isMasked(t: number): boolean {
    const cfg = MONO_ENGINE;
    while (this.clickCursor < this.clicks.length && this.clicks[this.clickCursor] + cfg.clickCentreMs < t - cfg.clickMaskMs) {
      this.clickCursor++;
    }
    const c = this.clicks[this.clickCursor];
    return c !== undefined && Math.abs(c + cfg.clickCentreMs - t) <= cfg.clickMaskMs;
  }

  process(samples: Float32Array, startMs: number): void {
    const cfg = MONO_ENGINE;
    if (this.t0Ms === null) this.t0Ms = startMs - (this.samplesSeen / this.opts.sampleRate) * 1000;
    for (let i = 0; i < samples.length; i++) {
      const x = this.hp.process(this.lp2.process(this.lp1.process(samples[i])));
      // Circular buffer holding the newest windowSize samples.
      this.ring[this.ringPos] = x;
      this.ringPos = (this.ringPos + 1) % cfg.windowSize;
      if (this.ringFill < cfg.windowSize) this.ringFill++;
      this.samplesSeen++;
      this.sinceHop++;
      if (this.ringFill === cfg.windowSize && this.sinceHop >= cfg.hopSize) {
        this.sinceHop = 0;
        this.analyse();
      }
    }
  }

  private analyse() {
    const cfg = MONO_ENGINE;
    const sr = this.opts.sampleRate;
    // Unroll the circular buffer, oldest sample first.
    const n = cfg.windowSize;
    this.window.set(this.ring.subarray(this.ringPos), 0);
    this.window.set(this.ring.subarray(0, this.ringPos), n - this.ringPos);
    const level = rms(this.window);
    this.level = Math.min(1, level * 8);
    const centreSample = this.samplesSeen - cfg.windowSize / 2;
    const t = (this.t0Ms ?? 0) + (centreSample / sr) * 1000 - (this.opts.latencyMs ?? 0);

    let voiced = false;
    let midi = NaN;
    let clarity = 0;
    if (level >= this.threshold) {
      const [hz, c] = this.detector.findPitch(this.window, sr);
      clarity = c;
      if (c >= cfg.minClarity && hz > 0) {
        midi = hzToMidi(hz);
        voiced = midi >= this.minMidi && midi <= this.maxMidi;
      }
    }

    if (voiced) {
      this.medianBuf.push(midi);
      if (this.medianBuf.length > cfg.medianFrames) this.medianBuf.shift();
    } else {
      this.medianBuf = [];
    }
    const frame: Frame = { t, midi: voiced ? median(this.medianBuf) : NaN, clarity, rms: level };

    if (this.isMasked(t)) {
      // Don't let clicks start, end or bend notes. Remember the frame so a real
      // note that starts on the beat can be back-dated to its true start.
      this.maskedRun.push(frame);
      return;
    }
    this.step(frame);
    this.maskedRun = [];
  }

  private step(f: Frame) {
    const cfg = MONO_ENGINE;
    if (!Number.isFinite(f.midi)) {
      // A quiet moment inside a note may be a re-attack of the same pitch.
      if (this.current && this.current.dipT === null && f.rms < this.current.peakRms * cfg.reattackDip) this.current.dipT = f.t;
      this.gapMs += this.hopMs;
      this.candidate = [];
      if (this.current && this.gapMs >= cfg.gapMs) this.endCurrent();
      return;
    }
    this.gapMs = 0;

    if (!this.current) {
      this.addToCandidate(f);
      const span = this.candidateSpan();
      if (span >= cfg.minNoteMs) this.promoteCandidate();
      return;
    }

    const cur = this.current;
    // Same-pitch re-attack detection (volume dip then recovery).
    if (cur.dipT === null && f.rms < cur.peakRms * cfg.reattackDip) cur.dipT = f.t;
    if (cur.dipT !== null) {
      if (f.t - cur.dipT > cfg.reattackWindowMs) cur.dipT = null;
      else if (f.rms > cur.peakRms * cfg.reattackRecover) {
        const splitAt = cur.dipT;
        cur.dipT = null;
        const ref = this.refPitch();
        if (Math.abs(f.midi - ref) * 100 <= cfg.changeCents) {
          // The new note starts where the sound came back (which may be inside a click mask).
          let startT = f.t;
          for (let i = this.maskedRun.length - 1; i >= 0; i--) {
            const mf = this.maskedRun[i];
            if (mf.t > splitAt && Number.isFinite(mf.midi) && Math.abs(mf.midi - f.midi) * 100 <= cfg.changeCents) startT = mf.t;
            else break;
          }
          this.endCurrent(splitAt);
          this.candidate = [f];
          this.candidateStart = startT;
          this.promoteCandidate(startT);
          return;
        }
      }
    }

    const ref = this.refPitch();
    if (Math.abs(f.midi - ref) * 100 <= cfg.changeCents) {
      // Back on the note: any brief excursion (vibrato) belongs to it.
      for (const c of this.candidate) cur.frames.push(c);
      this.candidate = [];
      cur.frames.push(f);
      cur.lastVoicedT = f.t;
      cur.peakRms = Math.max(cur.peakRms * 0.999, f.rms);
      this.updateLast();
      return;
    }

    this.addToCandidate(f);
    cur.lastVoicedT = f.t;
    if (this.candidateSpan() >= cfg.holdMs) {
      const start = this.candidateStart;
      this.endCurrent(start, true);
      this.promoteCandidate(undefined, true);
    }
  }

  /** Add to the candidate; if the candidate itself is unstable (a glide), restart it here. */
  private addToCandidate(f: Frame) {
    const cfg = MONO_ENGINE;
    if (this.candidate.length) {
      const m = median(this.candidate.map((c) => c.midi));
      if (Math.abs(f.midi - m) * 100 > cfg.changeCents) this.candidate = [];
    }
    if (this.candidate.length === 0) {
      // Back-date into click-masked frames that were already this note.
      this.candidateStart = f.t;
      for (let i = this.maskedRun.length - 1; i >= 0; i--) {
        const mf = this.maskedRun[i];
        if (Number.isFinite(mf.midi) && Math.abs(mf.midi - f.midi) * 100 <= cfg.changeCents) this.candidateStart = mf.t;
        else break;
      }
    }
    this.candidate.push(f);
  }

  private candidateSpan(): number {
    if (this.candidate.length === 0) return 0;
    return this.candidate[this.candidate.length - 1].t - this.candidate[0].t + this.hopMs;
  }

  private refPitch(): number {
    const frames = this.current?.frames ?? [];
    const recent = frames.length > 80 ? frames.slice(-80) : frames;
    return median(recent.map((x) => x.midi));
  }

  private promoteCandidate(forcedStart?: number, byChange = false) {
    const cfg = MONO_ENGINE;
    const frames = this.candidate;
    this.candidate = [];
    if (frames.length === 0) return;
    let startT = forcedStart ?? Math.min(this.candidateStart, frames[0].t);
    const bodyStart = startT;
    if (byChange) {
      // Fold glide fragments into this note.
      const m = median(frames.map((x) => x.midi));
      while (this.out.length >= 2) {
        const prev = this.out[this.out.length - 1];
        const pm = this.meta[this.meta.length - 1];
        const before = this.out[this.out.length - 2];
        const body = prev.onsetMs + prev.durationMs - pm.bodyStart;
        const between = (before.midi - prev.midi) * (prev.midi - m) > 0;
        const offGrid = Math.abs(prev.cents) > cfg.glideOffGridCents || body < cfg.glideMergeMs * 0.7;
        if (!(pm.endedByChange && body < cfg.glideMergeMs && between && offGrid)) break;
        startT = prev.onsetMs;
        this.out.pop();
        this.meta.pop();
      }
    }
    this.current = {
      frames: [...frames],
      startT,
      lastVoicedT: frames[frames.length - 1].t,
      peakRms: Math.max(...frames.map((x) => x.rms)),
      dipT: null,
    };
    this.out.push(this.toEvent());
    this.meta.push({ bodyStart, endedByChange: false });
  }

  private toEvent(): NoteEvent {
    const cur = this.current!;
    const m = median(cur.frames.map((x) => x.midi));
    const conf = cur.frames.reduce((s, x) => s + x.clarity, 0) / cur.frames.length;
    return {
      midi: m,
      cents: centsOf(m),
      onsetMs: cur.startT,
      durationMs: Math.max(0, cur.lastVoicedT - cur.startT + this.hopMs),
      confidence: Math.max(0, Math.min(1, conf)),
    };
  }

  private updateLast() {
    if (!this.current || this.out.length === 0) return;
    this.out[this.out.length - 1] = this.toEvent();
  }

  private endCurrent(endT?: number, byChange = false) {
    if (!this.current) return;
    if (byChange && this.meta.length) this.meta[this.meta.length - 1].endedByChange = true;
    if (endT !== undefined) this.current.lastVoicedT = Math.max(this.current.startT, endT - this.hopMs);
    this.updateLast();
    this.current = null;
    this.gapMs = 0;
  }

  notes(): NoteEvent[] {
    return this.out;
  }

  /**
   * Notes that won't be merged away any more (safe to show and follow live).
   * The newest note only counts once its own body is long enough.
   */
  settledNotes(): NoteEvent[] {
    const n = this.out.length;
    if (n === 0) return [];
    const last = this.out[n - 1];
    const body = last.onsetMs + last.durationMs - this.meta[n - 1].bodyStart;
    return body >= MONO_ENGINE.glideMergeMs * 1.2 || !this.current ? this.out : this.out.slice(0, n - 1);
  }

  finish(): NoteEvent[] {
    // Flush anything still waiting in a mask window.
    for (const f of this.maskedRun) this.step(f);
    this.maskedRun = [];
    this.endCurrent();
    return this.out.filter((n) => n.durationMs >= MONO_ENGINE.minNoteMs * 0.5);
  }

  reset(): void {
    this.out = [];
    this.meta = [];
    this.current = null;
    this.candidate = [];
    this.maskedRun = [];
    this.medianBuf = [];
    this.gapMs = 0;
    this.ringFill = 0;
    this.ringPos = 0;
    this.sinceHop = 0;
    this.samplesSeen = 0;
    this.t0Ms = null;
    this.clickCursor = 0;
    this.lp1.reset();
    this.lp2.reset();
    this.hp.reset();
  }
}
