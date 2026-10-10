import { Biquad } from './dsp';

/** Click length in ms (SPEC §5: short, ~20 ms). */
export const CLICK_MS = 20;

/**
 * Render a short, high woodblock-style click. Energy sits mostly above 4 kHz,
 * so the mono engine's low-pass keeps it out of the pitch tracker.
 * Deterministic (seeded noise) so tests can mix in the exact same sound.
 */
export function renderClick(sampleRate: number, accent = false): Float32Array {
  const n = Math.round((CLICK_MS / 1000) * sampleRate);
  const out = new Float32Array(n);
  const toneHz = accent ? 5200 : 4400;
  const bp = Biquad.bandpass(sampleRate, Math.min(accent ? 6000 : 5200, sampleRate * 0.4), 1.2);
  let seed = accent ? 12345 : 54321;
  const gain = accent ? 0.9 : 0.6;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const noise = (seed / 0x7fffffff) * 2 - 1;
    const t = i / sampleRate;
    const env = Math.exp(-t * 260);
    const attack = Math.min(1, i / (sampleRate * 0.0008));
    const tone = Math.sin(2 * Math.PI * toneHz * t);
    out[i] = gain * attack * env * (0.55 * tone + 0.45 * bp.process(noise) * 2.5);
  }
  return out;
}
