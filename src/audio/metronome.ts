import type { MetronomeMode } from '../config';
import type { Beat } from './beats';
import { renderClick } from './click';

const LOOKAHEAD_S = 0.12;
const TICK_MS = 25;

/**
 * Web Audio lookahead scheduler ("a tale of two clocks"): a light timer
 * wakes up often, but every click is placed on the audio clock, so timing
 * is sample-accurate and never drifts with the main thread.
 */
export class Metronome {
  private timer: number | null = null;
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
    this.tick();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private tick() {
    const horizon = this.ctx.currentTime + LOOKAHEAD_S;
    while (this.next < this.beats.length) {
      const b = this.beats[this.next];
      const when = this.startAt + b.timeMs / 1000;
      if (when > horizon) break;
      this.next++;
      if (when < this.ctx.currentTime - 0.01) continue;
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
  }

  /** Audio-clock time of each beat, for the visual pulse. */
  beatTimes(): { at: number; beat: Beat }[] {
    return this.beats.map((b) => ({ at: this.startAt + b.timeMs / 1000, beat: b }));
  }

  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
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
