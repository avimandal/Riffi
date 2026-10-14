import { OmrError } from './omrClient';

/**
 * Keeps requests to the music reader under the AI provider's per-minute limit
 * (Gemini's free tier allows only a handful a minute). When the server says
 * it's pacing ('pace': nothing was sent to the AI) it waits its turn and sends
 * again. It never re-sends after the AI itself said no (its rate limit, daily
 * limit, overload or a timeout): the reader decides about the one retry.
 */

export interface PacerOptions {
  /** Requests per minute (from the server's ?info, else a safe default). */
  rpm: number;
  /** Give up after waiting this long in total (ms). */
  maxWaitMs?: number;
  maxRetries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class RequestPacer {
  private starts: number[] = [];
  private waited = 0;
  private heldUntil = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: PacerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Send nothing more until `ms` from now (e.g. after the AI's rate limit). */
  hold(ms: number) {
    this.heldUntil = Math.max(this.heldUntil, this.now() + ms);
  }

  /** Total time spent waiting so far (ms). */
  get waitedMs(): number {
    return this.waited;
  }

  private async wait(ms: number, onWait?: (seconds: number) => void) {
    if (ms <= 0) return;
    const budget = this.opts.maxWaitMs ?? 6 * 60_000;
    if (this.waited + ms > budget) throw new OmrError('busy', undefined, 'gave_up_waiting');
    // Tell the UI once a second-ish, counting down.
    let left = ms;
    while (left > 0) {
      onWait?.(Math.ceil(left / 1000));
      const step = Math.min(left, 1000);
      await this.sleep(step);
      left -= step;
    }
    this.waited += ms;
  }

  /** Space requests so no 60-second window holds more than `rpm` of them. */
  private async slot(onWait?: (seconds: number) => void) {
    const rpm = Math.max(1, this.opts.rpm);
    if (this.heldUntil > this.now()) await this.wait(this.heldUntil - this.now(), onWait);
    for (;;) {
      const t = this.now();
      this.starts = this.starts.filter((s) => s > t - 60_000);
      if (this.starts.length < rpm) {
        this.starts.push(t);
        return;
      }
      await this.wait(this.starts[0] + 60_000 - t + 250, onWait);
    }
  }

  /**
   * Run one request, pacing it. Sent again only when the server was pacing
   * ('pace': it didn't ask the AI), after the wait it names.
   */
  async run<T>(fn: () => Promise<T>, onWait?: (seconds: number) => void): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      await this.slot(onWait);
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof OmrError)) throw e;
        if (e.code !== 'pace' || attempt >= maxRetries) throw e;
        await this.wait(Math.max(e.retryAfter ?? 0, 2) * 1000, onWait);
      }
    }
  }
}
