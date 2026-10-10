import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from './motion';

/**
 * The always-on visual metronome: a big dot that bounces on every beat
 * (bigger on beat 1). Driven by the audio clock, so it stays in time.
 */
export function PulseDot({ beatTimes, now, countInLabel }: { beatTimes: () => { at: number; accent: boolean; countIn: boolean; n: number }[]; now: () => number; countInLabel?: (n: number) => string }) {
  const dot = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    const reduced = prefersReducedMotion();
    const frame = () => {
      const times = beatTimes();
      const t = now();
      let last: (typeof times)[number] | undefined;
      for (const b of times) {
        if (b.at <= t) last = b;
        else break;
      }
      const el = dot.current;
      if (el) {
        const since = last ? t - last.at : 99;
        const p = Math.max(0, 1 - since / 0.18);
        const scale = 1 + (last?.accent ? 0.45 : 0.25) * p;
        el.style.transform = reduced ? 'none' : `scale(${scale.toFixed(3)})`;
        el.style.opacity = reduced ? (p > 0.2 ? '1' : '0.45') : String(0.55 + 0.45 * p);
        el.dataset.accent = last?.accent && p > 0 ? 'true' : 'false';
      }
      if (label.current) {
        label.current.textContent = last?.countIn && countInLabel ? countInLabel(last.n + 1) : '';
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [beatTimes, now, countInLabel]);
  return (
    <div className="pulse-wrap" aria-hidden>
      <div className="pulse-dot" ref={dot}>
        <span ref={label} />
      </div>
    </div>
  );
}
