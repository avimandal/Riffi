import type { ExpectedNote } from '../sheet/expected';

/** When a play-along run ends by itself (the player can always press Stop). */
export const RUN_END = {
  /** After the last note is heard: this much silence ends the run… */
  afterLastNoteSilenceMs: 800,
  /** …or this long after it, if something keeps sounding (room noise, a very long last note). */
  afterLastNoteMaxMs: 8000,
  /** Silence that ends a run once the cursor is in the final bars. */
  silenceMs: 5000,
  /** Silence that ends it once the piece's time is up but the cursor isn't near the end (lost, or the player gave up). */
  timeUpSilenceMs: 10000,
  /** "The final bars": the last this many bars of the piece. */
  finalBars: 2,
} as const;

/**
 * Decides when a play-along run is over. Never early: only when the last bar
 * has been reached and its last note played, or the player has gone quiet for
 * several seconds once they are in the final bars (or the piece's time is up).
 */
export class RunEnd {
  private readonly finalFrom: number;
  private readonly totalMs: number;
  private lastNoteAt: number | null = null;

  constructor(
    private readonly expected: ExpectedNote[],
    private readonly cfg: typeof RUN_END = RUN_END,
  ) {
    const n = expected.length;
    const lastPlay = n ? expected[n - 1].playIndex : 0;
    const idx = expected.findIndex((e) => e.playIndex > lastPlay - cfg.finalBars);
    this.finalFrom = idx < 0 ? 0 : idx;
    const last = expected[n - 1];
    this.totalMs = last ? last.onsetMs + last.durationMs : 0;
  }

  /**
   * `nowMs`: session time; `position`: the follower's expected-note index;
   * `soundEndMs`: when the last detected note stopped sounding (-Infinity if none yet).
   */
  shouldEnd(nowMs: number, position: number, soundEndMs: number): boolean {
    const n = this.expected.length;
    if (n === 0) return false;
    const silentMs = nowMs - soundEndMs;
    if (position >= n - 1) {
      this.lastNoteAt ??= nowMs;
      if (silentMs >= this.cfg.afterLastNoteSilenceMs) return true;
      if (nowMs - this.lastNoteAt >= Math.max(this.cfg.afterLastNoteMaxMs, 2 * this.expected[n - 1].durationMs)) return true;
    }
    if (position >= this.finalFrom && silentMs >= this.cfg.silenceMs) return true;
    return nowMs >= this.totalMs && silentMs >= this.cfg.timeUpSilenceMs;
  }
}
