/**
 * Real violin recordings for the tuner and follower tests (tests/fixtures/violin,
 * CC0, see SOURCES.md there), plus a "phone microphone" model: phone mics roll
 * off the low end (which weakens a G string's fundamental against its
 * overtones), add hiss and room noise, and record quietly with gain control off.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Biquad } from '../../src/audio/dsp';

export const VIOLIN_DIR = join(process.cwd(), 'tests', 'fixtures', 'violin');

export interface Clip {
  samples: Float32Array;
  sampleRate: number;
}

/** Read a 16-bit PCM WAV (mono, or the first channel). */
export function readWav(path: string): Clip {
  const buf = readFileSync(path);
  let pos = 12;
  let channels = 1;
  let sampleRate = 44100;
  let bits = 16;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = pos + 8;
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`${path}: only 16-bit PCM`);
      const frames = Math.floor(size / (2 * channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) out[i] = buf.readInt16LE(body + i * 2 * channels) / 32768;
      return { samples: out, sampleRate };
    }
    pos = body + size + (size & 1);
  }
  throw new Error(`${path}: no data chunk`);
}

export function violinClip(name: string): Clip {
  return readWav(join(VIOLIN_DIR, `${name}.wav`));
}

/** Play a clip faster/slower so its pitch moves by `cents` (cubic interpolation). */
export function shiftCents(clip: Clip, cents: number): Clip {
  if (cents === 0) return clip;
  const ratio = Math.pow(2, cents / 1200);
  const src = clip.samples;
  const n = Math.floor((src.length - 3) / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const k = Math.floor(x);
    const f = x - k;
    const y0 = src[Math.max(0, k - 1)];
    const y1 = src[k];
    const y2 = src[k + 1];
    const y3 = src[k + 2];
    out[i] = y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
  }
  return { samples: out, sampleRate: clip.sampleRate };
}

/** Deterministic noise. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

export interface PhoneOptions {
  /** Low-end roll-off of the mic (Hz). Many phone mics are well down by 200–300 Hz. */
  highpassHz?: number;
  /** Peak level after the mic (no auto gain). */
  peak?: number;
  /** Noise level (RMS) relative to full scale. */
  noise?: number;
  seed?: number;
}

/** What a phone mic a metre or so from a violin might hand the app. */
export function throughPhone(clip: Clip, opts: PhoneOptions = {}): Clip {
  const sr = clip.sampleRate;
  const hp1 = Biquad.highpass(sr, opts.highpassHz ?? 250);
  const hp2 = Biquad.highpass(sr, opts.highpassHz ?? 250);
  const out = new Float32Array(clip.samples.length);
  let peak = 1e-9;
  for (let i = 0; i < out.length; i++) {
    out[i] = hp2.process(hp1.process(clip.samples[i]));
    peak = Math.max(peak, Math.abs(out[i]));
  }
  const gain = (opts.peak ?? 0.25) / peak;
  const rand = rng(opts.seed ?? 7);
  const noise = opts.noise ?? 0.003;
  // Hiss plus a low room rumble.
  const rumble = Biquad.lowpass(sr, 120);
  for (let i = 0; i < out.length; i++) out[i] = out[i] * gain + noise * (rand() * 1.7) + 4 * noise * rumble.process(rand());
  return { samples: out, sampleRate: sr };
}

/** Lay clips end to end at the given times (ms) into one buffer, each cut to `lengthMs`. */
export function sequence(parts: { clip: Clip; atMs: number; lengthMs: number; gain?: number }[], totalMs: number, sampleRate = 44100): Clip {
  const out = new Float32Array(Math.ceil((totalMs / 1000) * sampleRate));
  for (const p of parts) {
    const start = Math.round((p.atMs / 1000) * sampleRate);
    const len = Math.min(p.clip.samples.length, Math.round((p.lengthMs / 1000) * sampleRate));
    const fade = Math.min(len, Math.round(0.012 * sampleRate));
    for (let i = 0; i < len && start + i < out.length; i++) {
      const env = Math.min(1, (len - i) / fade);
      out[start + i] += (p.gain ?? 1) * env * p.clip.samples[i];
    }
  }
  return { samples: out, sampleRate };
}

/** Feed a clip to something that takes audio in 128-sample blocks (like the capture worklet). */
export function feed(clip: Clip, process: (block: Float32Array, startMs: number) => void, block = 128) {
  for (let i = 0; i < clip.samples.length; i += block) {
    process(clip.samples.subarray(i, Math.min(clip.samples.length, i + block)), (i / clip.sampleRate) * 1000);
  }
}
