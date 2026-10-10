import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A single-line row that never wraps. If its children don't fit, it scrolls
 * sideways (touch swipe, trackpad, and a plain mouse wheel), snaps to items,
 * hides the scrollbar and fades the edge that has more to see.
 */
export function ScrollRow({ children, className, label, labelledBy }: { children: ReactNode; className?: string; label?: string; labelledBy?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const max = el.scrollWidth - el.clientWidth;
      setMore({ left: el.scrollLeft > 2, right: el.scrollLeft < max - 2 });
    };
    // A vertical mouse wheel scrolls the row sideways, but only while the row can
    // still move that way, so the page keeps scrolling once the row reaches its end.
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      if ((e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1)) return;
      e.preventDefault();
      el.scrollBy({ left: e.deltaY, behavior: 'auto' });
    };
    measure();
    // Show the selected item.
    el.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    el.addEventListener('scroll', measure, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', measure);
      el.removeEventListener('wheel', onWheel);
      ro?.disconnect();
    };
  }, []);

  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      aria-labelledby={labelledBy}
      className={`scroll-row${more.left ? ' more-left' : ''}${more.right ? ' more-right' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
    </div>
  );
}
