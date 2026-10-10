import { useEffect, useState } from 'react';
import { prefersReducedMotion } from './motion';

/** Animated count-up for the big score (instant under reduced motion). */
export function CountUp({ value, durationMs = 1200 }: { value: number; durationMs?: number }) {
  const [shown, setShown] = useState(prefersReducedMotion() ? value : 0);
  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(Math.round(value * eased));
      if (p < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs]);
  return <>{shown}</>;
}
