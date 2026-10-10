import { prepareForPlayback } from './session';

/** One shared AudioContext, so the metronome and the mic share a clock. */
let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx || ctx.state === 'closed') {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new Ctor({ latencyHint: 'interactive' });
  }
  return ctx;
}

/**
 * Must be called from a tap/click (browsers block audio until a gesture). Also
 * makes sure iPhones play through the silent switch (see ./session).
 */
export async function resumeAudio(): Promise<AudioContext> {
  prepareForPlayback();
  const c = getAudioContext();
  if (c.state !== 'running') await c.resume();
  return c;
}

/** Best guess at round-trip latency before calibration (ms). */
export function estimatedLatencyMs(c: AudioContext): number {
  const out = (c.outputLatency || 0) + (c.baseLatency || 0);
  return Math.round(out * 1000 + 15);
}
