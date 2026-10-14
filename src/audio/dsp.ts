/** Small, dependency-free DSP helpers shared by the engines and tests. */

/** RBJ cookbook biquad, transposed direct form II. */
export class Biquad {
  private z1 = 0;
  private z2 = 0;
  constructor(
    private b0: number,
    private b1: number,
    private b2: number,
    private a1: number,
    private a2: number,
  ) {}

  static lowpass(sampleRate: number, freq: number, q = Math.SQRT1_2): Biquad {
    const w0 = (2 * Math.PI * Math.min(freq, sampleRate * 0.45)) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    return new Biquad(((1 - cos) / 2) / a0, (1 - cos) / a0, ((1 - cos) / 2) / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  static highpass(sampleRate: number, freq: number, q = Math.SQRT1_2): Biquad {
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    return new Biquad(((1 + cos) / 2) / a0, (-(1 + cos)) / a0, ((1 + cos) / 2) / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  static bandpass(sampleRate: number, freq: number, q = 1): Biquad {
    const w0 = (2 * Math.PI * freq) / sampleRate;
    const alpha = Math.sin(w0) / (2 * q);
    const cos = Math.cos(w0);
    const a0 = 1 + alpha;
    return new Biquad(alpha / a0, 0, -alpha / a0, (-2 * cos) / a0, (1 - alpha) / a0);
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  processBuffer(input: Float32Array, output: Float32Array = new Float32Array(input.length)): Float32Array {
    for (let i = 0; i < input.length; i++) output[i] = this.process(input[i]);
    return output;
  }

  reset() {
    this.z1 = 0;
    this.z2 = 0;
  }
}

export function rms(buf: ArrayLike<number>, start = 0, end = buf.length): number {
  let s = 0;
  for (let i = start; i < end; i++) s += buf[i] * buf[i];
  const n = end - start;
  return n > 0 ? Math.sqrt(s / n) : 0;
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Resample mono audio with linear interpolation after a low-pass at the new
 * Nyquist (good enough for Basic Pitch, which listens up to ~4 kHz).
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  let src = input;
  if (toRate < fromRate) {
    const lp1 = Biquad.lowpass(fromRate, toRate * 0.45);
    const lp2 = Biquad.lowpass(fromRate, toRate * 0.45);
    src = lp2.processBuffer(lp1.processBuffer(input));
  }
  const ratio = fromRate / toRate;
  const outLen = Math.floor(src.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const frac = x - i0;
    const a = src[i0] ?? 0;
    const b = src[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * Stateful streaming resampler (low-pass + linear interpolation), so audio
 * arriving in small chunks resamples without clicks at chunk boundaries.
 */
export class StreamingResampler {
  private readonly ratio: number;
  private readonly lp1: Biquad | null;
  private readonly lp2: Biquad | null;
  private pos = 0; // fractional read position into the virtual input stream, relative to `prev`
  private prev = 0;

  constructor(
    readonly fromRate: number,
    readonly toRate: number,
  ) {
    this.ratio = fromRate / toRate;
    this.lp1 = toRate < fromRate ? Biquad.lowpass(fromRate, toRate * 0.45) : null;
    this.lp2 = toRate < fromRate ? Biquad.lowpass(fromRate, toRate * 0.45) : null;
  }

  push(input: Float32Array): Float32Array {
    if (this.fromRate === this.toRate) return input.slice();
    const src = new Float32Array(input.length + 1);
    src[0] = this.prev;
    for (let i = 0; i < input.length; i++) {
      let x = input[i];
      if (this.lp1 && this.lp2) x = this.lp2.process(this.lp1.process(x));
      src[i + 1] = x;
    }
    const out: number[] = [];
    // src[0] is the last sample of the previous chunk; positions are relative to it.
    while (this.pos + 1 < src.length) {
      const i0 = Math.floor(this.pos);
      const frac = this.pos - i0;
      out.push(src[i0] + (src[i0 + 1] - src[i0]) * frac);
      this.pos += this.ratio;
    }
    this.pos -= src.length - 1;
    this.prev = src[src.length - 1];
    return Float32Array.from(out);
  }
}

/** Power of one frequency in a (windowed) frame: a single DFT bin, anywhere. */
export function powerAt(frame: Float32Array, sampleRate: number, hz: number): number {
  const w = (2 * Math.PI * hz) / sampleRate;
  // Goertzel recurrence.
  const k = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < frame.length; i++) {
    const s0 = frame[i] + k * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - k * s1 * s2;
}

const hannCache = new Map<number, Float32Array>();
function hann(n: number): Float32Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

/**
 * Guard against overtone (octave / twelfth) errors. Time-domain trackers lock
 * onto the 2nd or 3rd harmonic when the fundamental is weak, which is normal for
 * a violin's low strings through a phone mic (and in the first few hundred ms
 * of a soft bow stroke). If `hz` were really the k-th harmonic of `hz / k`, the
 * frame would also hold partials *between* the harmonics of `hz` (at hz·j/k); a
 * true fundamental has only noise there. Steps down while that evidence is
 * strong, both relative to the harmonics and to the frame's average spectral
 * level, and the lower pitch is still >= `minHz`. Returns the corrected
 * frequency. Pure.
 */
export function fundamentalOf(
  frame: Float32Array,
  sampleRate: number,
  hz: number,
  minHz: number,
  opts: { minRatio: number; minOverLevel: number } = { minRatio: 0.01, minOverLevel: 1.6 },
): number {
  const w = hann(frame.length);
  const x = new Float32Array(frame.length);
  // White noise of the same energy has this expected power in any one bin.
  let level = 0;
  for (let i = 0; i < x.length; i++) {
    x[i] = frame[i] * w[i];
    level += x[i] * x[i];
  }
  if (level <= 0) return hz;
  const nyq = sampleRate * 0.45;
  const p = (f: number) => (f > 0 && f < nyq ? powerAt(x, sampleRate, f) : 0);
  let f = hz;
  for (let step = 0; step < 3; step++) {
    const onHarmonics = p(f) + p(2 * f) + p(3 * f);
    if (onHarmonics <= 0) break;
    let next = 0;
    // Twelfth first (hz is the 3rd harmonic), then octave (2nd).
    for (const k of [3, 2]) {
      if (f / k < minHz) continue;
      let between = 0;
      let n = 0;
      for (let j = 1; j < 3 * k; j++) {
        if (j % k === 0) continue;
        between += p((f * j) / k);
        n++;
      }
      if (between >= opts.minRatio * onHarmonics && between / n >= opts.minOverLevel * level) {
        next = f / k;
        break;
      }
    }
    if (!next) break;
    f = next;
  }
  return f;
}
