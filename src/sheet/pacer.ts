import { OmrError } from './omrClient';

/**
 * Keeps requests to the music reader under the AI provider's per-minute limit
 * (Gemini's free tier allows only a handful a minute), and waits and retries
 * when the server says it's busy. Reading a page line by line makes ~20
 * requests, so this is what lets a busy page finish instead of failing.
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
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: PacerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? defaultSleep;
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

  /** Run one request, pacing it and retrying when the reader is busy (or once after a timeout). */
  async run<T>(fn: () => Promise<T>, onWait?: (seconds: number) => void): Promise<T> {
    const maxRetries = this.opts.maxRetries ?? 5;
    let timeouts = 0;
    for (let attempt = 0; ; attempt++) {
      await this.slot(onWait);
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof OmrError)) throw e;
        if (e.kind === 'timeout' && timeouts++ === 0 && attempt < maxRetries) continue;
        if (e.kind !== 'busy' || attempt >= maxRetries) throw e;
        const backoff = Math.min(90, 5 * 2 ** attempt);
        await this.wait(Math.max(e.retryAfter ?? 0, backoff) * 1000, onWait);
      }
    }
  }
}
