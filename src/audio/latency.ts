import { Biquad, median, rms } from './dsp';

/**
 * Find click onsets in a recording: high-pass (clicks live up high), fast
 * envelope, and a rising-edge threshold relative to the loudest click.
 * Returns onset times in seconds relative to the recording start. Pure.
 */
export function detectClickOnsets(samples: Float32Array, sampleRate: number, minGapMs = 150): number[] {
  const hp1 = Biquad.highpass(sampleRate, 2500);
  const hp2 = Biquad.highpass(sampleRate, 2500);
  const env = new Float32Array(samples.length);
  let e = 0;
  const attack = 1 - Math.exp(-1 / (0.0005 * sampleRate));
  const release = 1 - Math.exp(-1 / (0.01 * sampleRate));
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = Math.abs(hp2.process(hp1.process(samples[i])));
    e += (x - e) * (x > e ? attack : release);
    env[i] = e;
    if (e > peak) peak = e;
  }
  if (peak < 1e-4) return [];
  const noise = median(Array.from({ length: Math.floor(samples.length / 512) }, (_, k) => rms(env, k * 512, k * 512 + 512)));
  const threshold = Math.max(peak * 0.3, noise * 4);
  const out: number[] = [];
  const gap = (minGapMs / 1000) * sampleRate;
  let last = -Infinity;
  for (let i = 1; i < env.length; i++) {
    if (env[i] >= threshold && env[i - 1] < threshold && i - last > gap) {
      out.push(i / sampleRate);
      last = i;
    }
  }
  return out;
}

export interface LatencyEstimate {
  latencyMs: number;
  matched: number;
  spreadMs: number;
  ok: boolean;
}

/**
 * Match each scheduled click to the first detected onset after it (within
 * 400 ms) and take the median delay. Pure.
 */
export function estimateLatency(scheduled: number[], detected: number[], maxMs = 400): LatencyEstimate {
  const diffs: number[] = [];
  for (const s of scheduled) {
    const d = detected.find((x) => x >= s - 0.005 && x - s <= maxMs / 1000);
    if (d !== undefined) diffs.push((d - s) * 1000);
  }
  if (diffs.length === 0) return { latencyMs: 0, matched: 0, spreadMs: 0, ok: false };
  const m = median(diffs);
  const spread = median(diffs.map((d) => Math.abs(d - m)));
  return {
    latencyMs: Math.round(Math.max(0, m)),
    matched: diffs.length,
    spreadMs: Math.round(spread),
    ok: diffs.length >= Math.ceil(scheduled.length * 0.6) && spread < 25,
  };
}

/** Median RMS of a recording in 2048-sample windows (the room's noise floor). */
export function measureNoiseFloor(samples: Float32Array): number {
  const levels: number[] = [];
  for (let i = 0; i + 2048 <= samples.length; i += 1024) levels.push(rms(samples, i, i + 2048));
  return levels.length ? median(levels) : 0;
}
