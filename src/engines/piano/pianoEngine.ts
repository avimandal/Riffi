import { BASIC_PITCH_MODEL_URL } from '../../config';
import type { ListeningEngine, NoteEvent } from '../types';
import { PIANO_ENGINE, stepSeconds } from './config';
import type { FromPianoWorker, ToPianoWorker } from './messages';
import { toNoteEvents, type RawPianoNote } from './postprocess';

export type PianoMode = 'live' | 'playThenScore';

export interface PianoEngineStatus {
  mode: PianoMode;
  backend: string;
  /** Set when live listening couldn't keep up mid-run. */
  fellBehind?: boolean;
}

/**
 * Main-thread side of the piano engine. Basic Pitch runs in a Web Worker;
 * the model is only loaded when piano is chosen.
 */
export class PianoEngine implements ListeningEngine {
  private worker: Worker;
  private raw: RawPianoNote[] = [];
  private offsetMs: number | null = null;
  private clicks: number[] = [];
  private waiters: ((m: FromPianoWorker) => void)[] = [];
  private status: PianoEngineStatus = { mode: 'live', backend: 'unknown' };
  onStatus?: (s: PianoEngineStatus) => void;
  onProgress?: (fraction: number) => void;
  level = 0;

  private constructor(private readonly latencyMs: number) {
    this.worker = new Worker(new URL('./piano.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<FromPianoWorker>) => this.onMessage(ev.data);
  }

  /**
   * Load the model and decide whether this device can listen live.
   * `preferred` lets Settings force play-then-score on a device.
   */
  static async create(opts: { sampleRate: number; latencyMs: number; preferred?: PianoMode | 'auto' }): Promise<PianoEngine> {
    const engine = new PianoEngine(opts.latencyMs);
    const ready = await engine.request({ type: 'init', modelUrl: BASIC_PITCH_MODEL_URL, sampleRate: opts.sampleRate }, 'ready');
    if (ready.type !== 'ready') throw new Error('Piano listener failed to start');
    const budgetMs = PIANO_ENGINE.realtimeBudget * stepSeconds(PIANO_ENGINE.liveStepFrames) * 1000;
    const tooSlow = ready.warmupMs > budgetMs;
    const mode: PianoMode =
      opts.preferred === 'live' ? 'live' : opts.preferred === 'playThenScore' || tooSlow ? 'playThenScore' : 'live';
    engine.status = { mode, backend: ready.backend };
    return engine;
  }

  get mode(): PianoMode {
    return this.status.mode;
  }

  get backend(): string {
    return this.status.backend;
  }

  private onMessage(m: FromPianoWorker) {
    if (m.type === 'notes') this.raw = m.notes;
    if (m.type === 'fellBehind') {
      this.status = { ...this.status, mode: 'playThenScore', fellBehind: true };
      this.onStatus?.(this.status);
    }
    if (m.type === 'progress') this.onProgress?.(m.fraction);
    const pending = this.waiters;
    this.waiters = [];
    pending.forEach((w) => w(m));
  }

  private request(msg: ToPianoWorker, until: FromPianoWorker['type']): Promise<FromPianoWorker> {
    return new Promise((resolve, reject) => {
      const wait = (m: FromPianoWorker) => {
        if (m.type === 'error') reject(new Error(m.message));
        else if (m.type === until) resolve(m);
        else this.waiters.push(wait);
      };
      this.waiters.push(wait);
      this.worker.postMessage(msg);
    });
  }

  setClickTimes(times: number[]) {
    this.clicks = times;
  }

  start() {
    this.raw = [];
    this.offsetMs = null;
    this.worker.postMessage({ type: 'start', live: this.status.mode === 'live' } satisfies ToPianoWorker);
  }

  process(samples: Float32Array, startMs: number): void {
    if (this.offsetMs === null) this.offsetMs = startMs;
    let s = 0;
    for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
    this.level = Math.min(1, Math.sqrt(s / Math.max(1, samples.length)) * 8);
    const copy = samples.slice();
    this.worker.postMessage({ type: 'audio', samples: copy } satisfies ToPianoWorker, [copy.buffer]);
  }

  private convert(raw: RawPianoNote[]): NoteEvent[] {
    return toNoteEvents(raw, { offsetMs: this.offsetMs ?? 0, latencyMs: this.latencyMs, clickTimes: this.clicks });
  }

  notes(): NoteEvent[] {
    return this.convert(this.raw);
  }

  async finish(): Promise<NoteEvent[]> {
    const done = await this.request({ type: 'finish' }, 'done');
    if (done.type === 'done') this.raw = done.notes;
    return this.convert(this.raw);
  }

  reset(): void {
    this.raw = [];
    this.offsetMs = null;
    this.worker.postMessage({ type: 'reset' } satisfies ToPianoWorker);
  }

  dispose() {
    this.worker.terminate();
  }
}
