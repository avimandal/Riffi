import type { MetronomeMode } from '../config';
import type { Beat } from './beats';
import { renderClick } from './click';
import { LookaheadScheduler } from './scheduler';

/** The practice metronome: plays a run's fixed list of beats on the shared lookahead scheduler. */
export class Metronome {
  private scheduler: LookaheadScheduler<{ when: number; beat: Beat }> | null = null;
  private beats: Beat[] = [];
  private next = 0;
  private startAt = 0;
  private buffers: { normal: AudioBuffer; accent: AudioBuffer } | null = null;
  private gain: GainNode | null = null;
  private sources: AudioBufferSourceNode[] = [];
  mode: MetronomeMode = 'sound';
  volume = 0.8;

  constructor(private readonly ctx: AudioContext) {}

  private ensureBuffers() {
    if (this.buffers) return this.buffers;
    const make = (accent: boolean) => {
      const data = renderClick(this.ctx.sampleRate, accent);
      const buf = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
      buf.getChannelData(0).set(data);
      return buf;
    };
    this.buffers = { normal: make(false), accent: make(true) };
    return this.buffers;
  }

  /**
   * Start clicking. `startAt` is the audio-clock time (s) of the piece's first
   * beat; count-in beats have negative times and land before it.
   */
  start(beats: Beat[], startAt: number) {
    this.stop();
    this.ensureBuffers();
    this.beats = beats;
    this.startAt = startAt;
    this.next = 0;
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this.volume;
    this.gain.connect(this.ctx.destination);
    this.scheduler = new LookaheadScheduler(
      this.ctx,
      {
        peek: () => {
          const b = this.beats[this.next];
          return b ? { when: this.startAt + b.timeMs / 1000, beat: b } : null;
        },
        advance: () => {
          this.next++;
        },
      },
      ({ when, beat: b }) => this.play(when, b),
    );
    this.scheduler.start();
  }

  private play(when: number, b: Beat) {
    if (this.mode === 'sound' && this.buffers && this.gain) {
      const src = this.ctx.createBufferSource();
      src.buffer = b.accent ? this.buffers.accent : this.buffers.normal;
      src.connect(this.gain);
      src.start(when);
      this.sources.push(src);
      src.onended = () => {
        this.sources = this.sources.filter((s) => s !== src);
      };
    } else if (this.mode === 'vibrate' && 'vibrate' in navigator) {
      const delay = Math.max(0, (when - this.ctx.currentTime) * 1000);
      window.setTimeout(() => navigator.vibrate?.(b.accent ? 40 : 20), delay);
    }
  }

  /** Audio-clock time of each beat, for the visual pulse. */
  beatTimes(): { at: number; beat: Beat }[] {
    return this.beats.map((b) => ({ at: this.startAt + b.timeMs / 1000, beat: b }));
  }

  stop() {
    this.scheduler?.stop();
    this.scheduler = null;
    this.sources.forEach((s) => {
      try {
        s.stop();
      } catch {
        // already stopped
      }
    });
    this.sources = [];
    this.gain?.disconnect();
    this.gain = null;
  }
}

export function canVibrate(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}
