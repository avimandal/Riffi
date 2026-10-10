import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ParsedScore } from '../sheet/musicxml';
import { SheetRenderer, type NoteMark } from '../sheet/osmd';
import { prefersReducedMotion } from './motion';
import { Icon } from './Icon';

export interface SheetHandle {
  /** Move the practice cursor to a note (xml index), or hide it. */
  setCursor(xmlIndex: number | null): void;
  renderer(): SheetRenderer | null;
}

interface Props {
  xml: string;
  score: ParsedScore;
  marks?: Map<number, NoteMark>;
  selected?: number | null;
  onTapNote?: (xmlIndex: number) => void;
  zoom?: number;
  label: string;
  className?: string;
  style?: React.CSSProperties;
  onRendered?: () => void;
}

const BADGE_ICON: Record<Exclude<NoteMark, 'correct'>, string> = {
  close: 'adjust',
  wrong: 'priority_high',
  missed: 'more_horiz',
};

export const SheetView = forwardRef<SheetHandle, Props>(function SheetView(
  { xml, score, marks, selected = null, onTapNote, zoom = 1, label, className, style, onRendered },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const renderer = useRef<SheetRenderer | null>(null);
  const cursorAt = useRef<number | null>(null);
  const [version, setVersion] = useState(0);
  const [badges, setBadges] = useState<{ x: number; y: number; mark: Exclude<NoteMark, 'correct'> }[]>([]);
  const [ring, setRing] = useState<DOMRect | null>(null);
  const [error, setError] = useState<string | null>(null);

  const placeCursor = useCallback((xmlIndex: number | null) => {
    cursorAt.current = xmlIndex;
    const r = renderer.current;
    const el = cursor.current;
    const h = host.current;
    if (!el || !r || !h) return;
    if (xmlIndex === null) {
      el.style.display = 'none';
      return;
    }
    const rect = r.noteRect(xmlIndex);
    const band = r.systemBand(xmlIndex);
    if (!rect) return;
    el.style.display = 'block';
    el.style.left = `${rect.x + rect.width / 2}px`;
    el.style.top = `${(band?.top ?? rect.y - 40) - 6}px`;
    el.style.height = `${(band?.height ?? 80) + 12}px`;
    // Keep the cursor's line in view.
    const top = band?.top ?? rect.y;
    const bottom = top + (band?.height ?? 80);
    if (top < h.scrollTop + 20 || bottom > h.scrollTop + h.clientHeight - 20) {
      h.scrollTo({ top: Math.max(0, top - 40), behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }, []);

  useImperativeHandle(ref, () => ({ setCursor: placeCursor, renderer: () => renderer.current }), [placeCursor]);

  // Render (and re-render when the music changes).
  useEffect(() => {
    if (!inner.current) return;
    let cancelled = false;
    if (!renderer.current) renderer.current = new SheetRenderer(inner.current);
    const r = renderer.current;
    r.zoom = zoom;
    r.render(xml, score, zoom)
      .then(() => {
        if (cancelled) return;
        setError(null);
        setVersion((v) => v + 1);
        onRendered?.();
      })
      .catch((e: unknown) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
    // onRendered is intentionally not a dependency (callers pass inline functions).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [xml, score, zoom]);

  // Re-layout on resize.
  useEffect(() => {
    const h = host.current;
    if (!h || typeof ResizeObserver === 'undefined') return;
    let timer = 0;
    let lastW = h.clientWidth;
    const ro = new ResizeObserver(() => {
      if (Math.abs(h.clientWidth - lastW) < 24) return;
      lastW = h.clientWidth;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        if (!renderer.current) return;
        renderer.current.relayout(score);
        setVersion((v) => v + 1);
      }, 250);
    });
    ro.observe(h);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [score]);

  // Marks, selection and cursor after each render.
  useEffect(() => {
    const r = renderer.current;
    if (!r || version === 0) return;
    r.mark(marks ?? new Map());
    r.select(selected);
    const next: typeof badges = [];
    for (const [xmlIndex, mark] of marks ?? []) {
      if (mark === 'correct') continue;
      const rect = r.noteRect(xmlIndex);
      if (rect) next.push({ x: rect.x + rect.width / 2, y: rect.y - 24, mark });
    }
    setBadges(next);
    setRing(selected !== null ? r.noteRect(selected) : null);
    placeCursor(cursorAt.current);
  }, [version, marks, selected, placeCursor]);

  // Keyboard: arrow keys move the selection from note to note.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onTapNote || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
    const order = [...score.notes].sort((a, b) => a.measureIndex - b.measureIndex || a.startQ - b.startQ || (a.midi ?? 0) - (b.midi ?? 0)).map((n) => n.xmlIndex);
    if (order.length === 0) return;
    e.preventDefault();
    const at = selected === null ? -1 : order.indexOf(selected);
    const next = e.key === 'ArrowRight' ? Math.min(order.length - 1, at + 1) : Math.max(0, at - 1);
    onTapNote(order[next]);
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onTapNote || !renderer.current || !host.current) return;
    const h = host.current.getBoundingClientRect();
    const hit = renderer.current.hitTest(e.clientX - h.left + host.current.scrollLeft, e.clientY - h.top + host.current.scrollTop);
    if (hit !== null) onTapNote(hit);
  };

  return (
    <div
      ref={host}
      className={`sheet-host${className ? ` ${className}` : ''}`}
      style={style}
      role="region"
      aria-label={label}
      tabIndex={0}
      onClick={onClick}
      onKeyDown={onKeyDown}
      data-testid="sheet"
      data-rendered={version > 0 ? 'true' : 'false'}
    >
      <div ref={inner} />
      <div ref={cursor} className="sheet-cursor" style={{ display: 'none' }} aria-hidden />
      {badges.map((b, i) => (
        <span key={i} className={`mark-badge ${b.mark}`} style={{ left: b.x, top: b.y }} aria-hidden>
          <Icon name={BADGE_ICON[b.mark]} />
        </span>
      ))}
      {ring && (
        <span
          className="select-ring"
          style={{ left: ring.x - 8, top: ring.y - 8, width: ring.width + 16, height: ring.height + 16 }}
          aria-hidden
        />
      )}
      {error && <p className="notice error" style={{ margin: 16 }}>{error}</p>}
    </div>
  );
});
