import { Biquad } from './dsp';
import { CLICK_MS, renderClick } from './click';

/** Metronome sounds for the Tuner & Metronome gadget. */
export const METRONOME_SOUNDS = ['woodblock', 'click', 'beep', 'cowbell', 'soft'] as const;
export type MetronomeSound = (typeof METRONOME_SOUNDS)[number];

/** Accent (beat 1), an ordinary beat, or a quieter subdivision. */
export type ClickLevel = 'accent' | 'beat' | 'sub';

/**
 * How long each sound lasts. Every sound is kept short (≤ 30 ms) so the
 * listening engine can mask it completely and never hear it as playing,
 * even the pitched ones (beep, cowbell, soft).
 */
export const SOUND_MS: Record<MetronomeSound, number> = {
  woodblock: CLICK_MS,
  click: 8,
  beep: 30,
  cowbell: 30,
  soft: 25,
};

const GAIN: Record<ClickLevel, number> = { accent: 1, beat: 0.7, sub: 0.38 };

function seeded(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * 2 - 1;
  };
}

/** Render one metronome sound. Deterministic, so tests can mix in the exact same audio. */
export function renderSound(kind: MetronomeSound, sampleRate: number, level: ClickLevel): Float32Array {
  if (kind === 'woodblock') {
    const c = renderClick(sampleRate, level === 'accent');
    if (level === 'sub') for (let i = 0; i < c.length; i++) c[i] *= 0.5;
    return c;
  }
  const n = Math.round((SOUND_MS[kind] / 1000) * sampleRate);
  const out = new Float32Array(n);
  const g = GAIN[level];
  const hi = level === 'accent';
  const fade = (i: number) => Math.min(1, i / (sampleRate * 0.001)) * Math.min(1, (n - i) / (sampleRate * 0.003));
  switch (kind) {
    case 'click': {
      // A crisp, bright tick: high-passed noise.
      const noise = seeded(hi ? 11 : 13);
      const hp = Biquad.highpass(sampleRate, Math.min(sampleRate * 0.4, hi ? 6000 : 4500));
      for (let i = 0; i < n; i++) out[i] = 1.6 * g * Math.exp(-i / (sampleRate * 0.0015)) * hp.process(noise());
      break;
    }
    case 'beep': {
      const f = hi ? 1760 : level === 'beat' ? 1320 : 1100;
      for (let i = 0; i < n; i++) out[i] = 0.5 * g * fade(i) * Math.sin((2 * Math.PI * f * i) / sampleRate);
      break;
    }
    case 'cowbell': {
      // Two detuned square-ish partials, like the classic drum-machine cowbell.
      const f1 = hi ? 800 : 587;
      const f2 = hi ? 1190 : 845;
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        const env = Math.exp(-t * 90) * fade(i);
        out[i] = 0.35 * g * env * (Math.sign(Math.sin(2 * Math.PI * f1 * t)) * 0.6 + Math.sign(Math.sin(2 * Math.PI * f2 * t)) * 0.4);
      }
      break;
    }
    case 'soft': {
      // A gentle, low "tock".
      const f = hi ? 660 : 520;
      for (let i = 0; i < n; i++) {
        const t = i / sampleRate;
        out[i] = 0.45 * g * Math.exp(-t * 140) * fade(i) * Math.sin(2 * Math.PI * f * t);
      }
      break;
    }
  }
  return out;
}

/** A gentle end-of-timer chime (three soft bell notes). */
export function renderChime(sampleRate: number): Float32Array {
  const notes = [76, 79, 84];
  const len = Math.round(sampleRate * 1.8);
  const out = new Float32Array(len);
  notes.forEach((m, k) => {
    const start = Math.round(k * 0.28 * sampleRate);
    const f = 440 * Math.pow(2, (m - 69) / 12);
    for (let i = 0; start + i < len; i++) {
      const t = i / sampleRate;
      const env = Math.min(1, i / (sampleRate * 0.005)) * Math.exp(-t * 3);
      out[start + i] += 0.18 * env * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * 2.76 * f * t) * Math.exp(-t * 6));
    }
  });
  return out;
}
