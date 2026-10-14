import { LookaheadScheduler } from '../audio/scheduler';
import { MicInput } from '../audio/mic';
import { renderChime, renderSound, SOUND_MS, type ClickLevel, type MetronomeSound } from '../audio/sounds';
import { activePlayingMs } from '../data/stats';
import { MONO_ENGINE, MonoEngine, type PitchReading } from '../engines/mono/monoEngine';
import { nextTick, type MetronomeSettings, type Tick } from './metronomeCore';

/** Output side of the gadget: one master volume for clicks, reference tones and the chime. */
export class GadgetAudio {
  readonly master: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private tone: { osc: OscillatorNode[]; gain: GainNode } | null = null;

  constructor(readonly ctx: AudioContext) {
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
  }

  set volume(v: number) {
    this.master.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime, 0.01);
  }

  private buffer(data: Float32Array, key: string): AudioBuffer {
    let b = this.buffers.get(key);
    if (!b) {
      b = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
      b.getChannelData(0).set(data);
      this.buffers.set(key, b);
    }
    return b;
  }

  playClick(kind: MetronomeSound, level: ClickLevel, when: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer(renderSound(kind, this.ctx.sampleRate, level), `${kind}:${level}`);
    src.connect(this.master);
    src.start(when);
  }

  playChime() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer(renderChime(this.ctx.sampleRate), 'chime');
    src.connect(this.master);
    src.start();
  }

  /** A warm reference note to tune by ear. Returns its audio-clock start and end (s). */
  playTone(hz: number, seconds = 2.5): { start: number; end: number } {
    this.stopTone();
    const start = this.ctx.currentTime + 0.02;
    const end = start + seconds;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.35, start + 0.05);
    gain.gain.setValueAtTime(0.35, end - 0.3);
    gain.gain.linearRampToValueAtTime(0, end);
    gain.connect(this.master);
    const osc = [1, 2, 3].map((h, i) => {
      const o = this.ctx.createOscillator();
      o.frequency.value = hz * h;
      const g = this.ctx.createGain();
      g.gain.value = [1, 0.35, 0.15][i];
      o.connect(g).connect(gain);
      o.start(start);
      o.stop(end + 0.05);
      return o;
    });
    this.tone = { osc, gain };
    return { start, end };
  }

  stopTone() {
    if (!this.tone) return;
    const t = this.ctx.currentTime;
    this.tone.gain.gain.cancelScheduledValues(t);
    this.tone.gain.gain.setTargetAtTime(0, t, 0.02);
    this.tone.osc.forEach((o) => {
      try {
        o.stop(t + 0.1);
      } catch {
        // already stopped
      }
    });
    this.tone = null;
  }

  dispose() {
    this.stopTone();
    this.master.disconnect();
  }
}

/**
 * The gadget's metronome: an endless click stream on the same lookahead
 * scheduler as the practice metronome. Settings are read live, so tempo,
 * time signature, sound and subdivision changes apply from the next click.
 */
export class GadgetMetronome {
  private scheduler: LookaheadScheduler<Tick> | null = null;
  private last: Tick | null = null;
  private startAt = 0;
  /** Every click as it's scheduled (for the LEDs and for masking the listener). */
  onTick?: (t: Tick, soundMs: number) => void;

  constructor(
    private readonly audio: GadgetAudio,
    private readonly settings: () => MetronomeSettings,
  ) {}

  get running(): boolean {
    return this.scheduler !== null;
  }

  start() {
    this.stop();
    this.last = null;
    this.startAt = this.audio.ctx.currentTime + 0.1;
    this.scheduler = new LookaheadScheduler<Tick>(
      this.audio.ctx,
      {
        peek: () => nextTick(this.last, this.settings(), this.startAt),
        advance: () => {
          this.last = nextTick(this.last, this.settings(), this.startAt);
        },
      },
      (t) => {
        const s = this.settings();
        this.audio.playClick(s.sound, t.level, t.when);
        this.onTick?.(t, SOUND_MS[s.sound]);
      },
    );
    this.scheduler.start();
  }

  stop() {
    this.scheduler?.stop();
    this.scheduler = null;
  }
}

/**
 * Microphone + mono pitch engine for the tuner and for "Count my practice".
 * The gadget's own sounds are masked out: every metronome click (each sound,
 * each subdivision) and the reference tone, so they're never heard as playing.
 */
export class GadgetListener {
  private mic: MicInput | null = null;
  private engine: MonoEngine | null = null;
  private t0 = 0;
  private off: (() => void) | null = null;

  constructor(private readonly ctx: AudioContext) {}

  get running(): boolean {
    return this.engine !== null;
  }

  /** `rawMic`: no echo cancelling, noise suppression or auto gain (the tuner, when no metronome is playing). */
  async start(opts: { range: { low: number; high: number }; latencyMs?: number; noiseFloor?: number; rawMic?: boolean }) {
    this.stop();
    const mic = new MicInput(this.ctx, !opts.rawMic);
    await mic.start();
    this.mic = mic;
    this.engine = new MonoEngine({
      instrument: 'voice',
      range: opts.range,
      sampleRate: this.ctx.sampleRate,
      latencyMs: opts.latencyMs ?? 0,
      noiseFloor: opts.noiseFloor,
    });
    this.t0 = this.ctx.currentTime;
    this.off = mic.onFrames((samples, t) => this.engine?.process(samples, (t - this.t0) * 1000));
  }

  /** Session ms for an audio-clock time. */
  private ms(ctxTime: number): number {
    return (ctxTime - this.t0) * 1000;
  }

  /** A metronome click at audio-clock time `when` (s), lasting `soundMs`. */
  maskClick(when: number, soundMs: number) {
    this.engine?.addClick(this.ms(when), soundMs);
  }

  /** Don't listen between two audio-clock times (s), plus a little room echo. */
  mute(start: number, end: number, tailMs = 200) {
    // Start a little early: the analysis window looks ~21 ms ahead.
    this.engine?.addMask(this.ms(start) - MONO_ENGINE.clickPreMs, this.ms(end) + tailMs);
  }

  get reading(): PitchReading | null {
    return this.engine?.reading ?? null;
  }

  get level(): number {
    return this.engine?.level ?? 0;
  }

  /** Time the player has actually been playing so far (ms). */
  playedMs(): number {
    return this.engine ? activePlayingMs(this.engine.notes()) : 0;
  }

  /** Stop listening; returns the final played time (ms). */
  stop(): number {
    let played = 0;
    if (this.engine) played = activePlayingMs(this.engine.finish());
    this.off?.();
    this.off = null;
    this.mic?.stop();
    this.mic = null;
    this.engine = null;
    return played;
  }
}
