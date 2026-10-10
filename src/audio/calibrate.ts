import { renderClick } from './click';
import { estimateLatency, detectClickOnsets, measureNoiseFloor, type LatencyEstimate } from './latency';
import { MicInput } from './mic';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Record the mic for `ms`, returning samples and the audio-clock time of the first one. */
async function record(mic: MicInput, ms: number, during?: () => void): Promise<{ samples: Float32Array; startSec: number }> {
  const chunks: Float32Array[] = [];
  let startSec = -1;
  const off = mic.onFrames((s, t) => {
    if (startSec < 0) startSec = t;
    chunks.push(s.slice());
  });
  during?.();
  await wait(ms);
  off();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const samples = new Float32Array(total);
  let o = 0;
  for (const c of chunks) {
    samples.set(c, o);
    o += c.length;
  }
  return { samples, startSec };
}

/**
 * Play clicks through the speaker, hear them through the mic, and measure
 * the round trip. Tries with echo cancellation first (as in practice), then
 * without, because some browsers cancel the clicks completely.
 */
export async function calibrateLatency(ctx: AudioContext, clicks = 8): Promise<LatencyEstimate> {
  let best: LatencyEstimate = { latencyMs: 0, matched: 0, spreadMs: 0, ok: false };
  for (const aec of [true, false]) {
    const mic = new MicInput(ctx, aec);
    await mic.start();
    try {
      await wait(300);
      const gap = 0.45;
      const scheduled: number[] = [];
      const buf = renderClick(ctx.sampleRate, true);
      const ab = ctx.createBuffer(1, buf.length, ctx.sampleRate);
      ab.getChannelData(0).set(buf);
      const { samples, startSec } = await record(mic, (clicks * gap + 0.9) * 1000, () => {
        const t0 = ctx.currentTime + 0.4;
        for (let i = 0; i < clicks; i++) {
          const src = ctx.createBufferSource();
          src.buffer = ab;
          src.connect(ctx.destination);
          src.start(t0 + i * gap);
          scheduled.push(t0 + i * gap);
        }
      });
      const detected = detectClickOnsets(samples, ctx.sampleRate).map((t) => t + startSec);
      const est = estimateLatency(scheduled, detected);
      if (est.ok) return est;
      if (est.matched > best.matched) best = est;
    } finally {
      mic.stop();
    }
  }
  return best;
}

/** Measure the room with nobody playing (for the mono engine's volume gate). */
export async function measureRoomNoise(ctx: AudioContext, ms = 1500): Promise<number> {
  const mic = new MicInput(ctx);
  await mic.start();
  try {
    await wait(200);
    const { samples } = await record(mic, ms);
    return measureNoiseFloor(samples);
  } finally {
    mic.stop();
  }
}
