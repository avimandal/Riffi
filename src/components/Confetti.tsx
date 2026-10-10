import { useEffect, useRef } from 'react';
import { prefersReducedMotion } from './motion';

const COLOURS = ['#5b3fe0', '#ff7a3d', '#1e9e57', '#ffc400', '#e83e8c', '#2aa3ff'];

/** Personal-best confetti. Renders nothing under prefers-reduced-motion. */
export function Confetti({ run }: { run: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!run || prefersReducedMotion()) return;
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const w = (canvas.width = window.innerWidth * dpr);
    const h = (canvas.height = window.innerHeight * dpr);
    const parts = Array.from({ length: 140 }, () => ({
      x: w / 2 + (Math.random() - 0.5) * w * 0.3,
      y: h * 0.35,
      vx: (Math.random() - 0.5) * 16 * dpr,
      vy: (-Math.random() * 16 - 6) * dpr,
      r: (Math.random() * 6 + 4) * dpr,
      a: Math.random() * Math.PI,
      va: (Math.random() - 0.5) * 0.3,
      c: COLOURS[Math.floor(Math.random() * COLOURS.length)],
    }));
    let raf = 0;
    const t0 = performance.now();
    const frame = (now: number) => {
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.vy += 0.45 * dpr;
        p.vx *= 0.99;
        p.x += p.vx;
        p.y += p.vy;
        p.a += p.va;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.a);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.r, -p.r / 2, p.r * 2, p.r);
        ctx.restore();
      }
      if (now - t0 < 3500) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [run]);
  if (!run) return null;
  return <canvas ref={ref} aria-hidden style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 70 }} />;
}
