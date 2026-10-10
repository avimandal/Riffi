/**
 * Synthetic test audio: tones with vibrato, sung-like glides, piano-like
 * chords, and metronome clicks mixed in.
 */
import { renderClick } from '../../src/audio/click';
import { midiToHz } from '../../src/engines/types';

export const SR = 48000;

export interface ToneSpec {
  midi: number;
  startMs: number;
  durationMs: number;
  /** Vibrato depth in cents (±) and rate in Hz. */
  vibratoCents?: number;
  vibratoHz?: number;
  /** Glide from this MIDI pitch over `glideMs` at the start. */
  glideFrom?: number;
  glideMs?: number;
  /** Harmonic amplitudes (1 = fundamental). */
  harmonics?: number[];
  amp?: number;
  /** Soft (bowed/sung) attack time. */
  attackMs?: number;
  /** Exponential decay (piano-like), per second. */
  decay?: number;
}

export function blank(totalMs: number): Float32Array {
  return new Float32Array(Math.ceil((totalMs / 1000) * SR));
}

export function addTone(buf: Float32Array, spec: ToneSpec): Float32Array {
  const start = Math.round((spec.startMs / 1000) * SR);
  const len = Math.round((spec.durationMs / 1000) * SR);
  const harmonics = spec.harmonics ?? [1];
  const amp = spec.amp ?? 0.3;
  const attack = ((spec.attackMs ?? 15) / 1000) * SR;
  const release = 0.01 * SR;
  let phase = 0;
  for (let i = 0; i < len && start + i < buf.length; i++) {
    const t = i / SR;
    let midi = spec.midi;
    if (spec.glideFrom !== undefined && spec.glideMs && t * 1000 < spec.glideMs) {
      midi = spec.glideFrom + (spec.midi - spec.glideFrom) * ((t * 1000) / spec.glideMs);
    }
    if (spec.vibratoCents) midi += (spec.vibratoCents / 100) * Math.sin(2 * Math.PI * (spec.vibratoHz ?? 5.5) * t);
    phase += (2 * Math.PI * midiToHz(midi)) / SR;
    let s = 0;
    harmonics.forEach((h, k) => (s += h * Math.sin((k + 1) * phase)));
    let env = Math.min(1, i / attack) * Math.min(1, (len - i) / release);
    if (spec.decay) env *= Math.exp(-spec.decay * t);
    buf[start + i] += amp * env * s;
  }
  return buf;
}

export const VIOLINISH = [1, 0.6, 0.45, 0.3, 0.2, 0.12];
export const VOICEISH = [1, 0.5, 0.25, 0.1];
export const PIANOISH = [1, 0.5, 0.33, 0.2, 0.12];

export function addClicks(buf: Float32Array, timesMs: number[], gain = 1, beatsPerBar = 4): Float32Array {
  timesMs.forEach((t, i) => {
    const click = renderClick(SR, i % beatsPerBar === 0);
    const start = Math.round((t / 1000) * SR);
    for (let k = 0; k < click.length && start + k < buf.length; k++) buf[start + k] += gain * click[k];
  });
  return buf;
}

export function addNoise(buf: Float32Array, level: number, seed = 7): Float32Array {
  let s = seed;
  for (let i = 0; i < buf.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    buf[i] += level * ((s / 0x7fffffff) * 2 - 1);
  }
  return buf;
}

/** Feed a buffer to an engine in worklet-sized chunks. */
export function feed(engine: { process(s: Float32Array, startMs: number): void }, buf: Float32Array, chunk = 1024) {
  for (let i = 0; i < buf.length; i += chunk) {
    engine.process(buf.subarray(i, Math.min(buf.length, i + chunk)), (i / SR) * 1000);
  }
}

/** Write a 16-bit mono WAV (used for the Playwright fake microphone). */
export function toWav(buf: Float32Array, sampleRate = SR): Uint8Array {
  const data = new DataView(new ArrayBuffer(44 + buf.length * 2));
  const w = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  data.setUint32(4, 36 + buf.length * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, sampleRate, true);
  data.setUint32(28, sampleRate * 2, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  w(36, 'data');
  data.setUint32(40, buf.length * 2, true);
  for (let i = 0; i < buf.length; i++) {
    const v = Math.max(-1, Math.min(1, buf[i]));
    data.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(data.buffer);
}
