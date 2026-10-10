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
