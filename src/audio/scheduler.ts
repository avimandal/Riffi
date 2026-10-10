/**
 * Web Audio lookahead scheduler ("a tale of two clocks"). A light timer wakes
 * up often, but every event is placed on the audio clock, so timing is
 * sample-accurate and never drifts with the main thread.
 *
 * Shared by the practice metronome (a fixed list of beats) and the
 * Tuner & Metronome gadget (an endless stream whose tempo can change live).
 */
export const LOOKAHEAD_S = 0.12;
export const TICK_MS = 25;

export interface TimedEvent {
  /** Audio-clock time (s). */
  when: number;
}

/** Where events come from: look at the next one without using it up, then advance past it. */
export interface EventSource<E extends TimedEvent> {
  peek(): E | null;
  advance(): void;
}

export class LookaheadScheduler<E extends TimedEvent> {
  private timer: number | null = null;

  /**
   * @param source the events, in time order. `peek` may be recomputed each tick,
   *   so a live tempo change takes effect from the next unscheduled event.
   * @param play called once per event, ahead of time, with its exact audio time.
   */
  constructor(
    private readonly clock: { readonly currentTime: number },
    private readonly source: EventSource<E>,
    private readonly play: (e: E) => void,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start() {
    this.stop();
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS) as unknown as number;
  }

  /** Schedule everything due before the lookahead horizon. Exposed for tests. */
  tick(now = this.clock.currentTime) {
    const horizon = now + LOOKAHEAD_S;
    for (let guard = 0; guard < 1000; guard++) {
      const e = this.source.peek();
      if (!e || e.when > horizon) return;
      this.source.advance();
      // Skip anything already in the past (e.g. after the tab was asleep).
      if (e.when >= now - 0.01) this.play(e);
    }
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
