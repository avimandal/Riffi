import { useEffect, useRef, useState } from 'react';
import { t } from '../../i18n';
import { Modal } from '../../components/Modal';
import { renderPage, type Crop, type PageDraft } from './imagePrep';

type Handle = 'nw' | 'ne' | 'sw' | 'se' | 'move';
const MIN = 0.1;

/** Simple crop: drag the corners (or the box) over a rotated preview. */
export function CropModal({ page, onClose, onApply }: { page: PageDraft; onClose: () => void; onApply: (c: Crop) => void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [crop, setCrop] = useState<Crop>(page.crop ?? { x: 0.03, y: 0.03, w: 0.94, h: 0.94 });
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ handle: Handle; x: number; y: number; start: Crop } | null>(null);

  useEffect(() => {
    let url: string | null = null;
    renderPage({ ...page, crop: undefined }, 1000, 0.8)
      .then((b) => {
        url = URL.createObjectURL(b);
        setPreview(url);
      })
      .catch(() => setPreview(page.previewUrl));
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [page]);

  const onDown = (handle: Handle) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { handle, x: e.clientX, y: e.clientY, start: crop };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const el = box.current;
    if (!d || !el) return;
    const r = el.getBoundingClientRect();
    const dx = (e.clientX - d.x) / r.width;
    const dy = (e.clientY - d.y) / r.height;
    const s = d.start;
    let { x, y, w, h } = s;
    if (d.handle === 'move') {
      x = Math.min(1 - w, Math.max(0, s.x + dx));
      y = Math.min(1 - h, Math.max(0, s.y + dy));
    } else {
      if (d.handle.includes('w')) {
        x = Math.min(s.x + s.w - MIN, Math.max(0, s.x + dx));
        w = s.x + s.w - x;
      }
      if (d.handle.includes('e')) w = Math.min(1 - s.x, Math.max(MIN, s.w + dx));
      if (d.handle.includes('n')) {
        y = Math.min(s.y + s.h - MIN, Math.max(0, s.y + dy));
        h = s.y + s.h - y;
      }
      if (d.handle.includes('s')) h = Math.min(1 - s.y, Math.max(MIN, s.h + dy));
    }
    setCrop({ x, y, w, h });
  };
  const onUp = () => {
    drag.current = null;
  };

  return (
    <Modal title={t.add.cropTitle} onClose={onClose} wide>
      <p className="muted">{t.add.cropHelp}</p>
      <div className="crop-area" ref={box} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        {preview && <img src={preview} alt="" draggable={false} />}
        <div
          className="crop-box"
          style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.w * 100}%`, height: `${crop.h * 100}%` }}
          onPointerDown={onDown('move')}
        >
          {(['nw', 'ne', 'sw', 'se'] as const).map((hd) => (
            <span key={hd} className={`crop-handle ${hd}`} onPointerDown={onDown(hd)} />
          ))}
        </div>
      </div>
      <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => setCrop({ x: 0, y: 0, w: 1, h: 1 })}>
          {t.add.resetCrop}
        </button>
        <button className="btn primary" onClick={() => onApply(crop)}>
          {t.add.applyCrop}
        </button>
      </div>
    </Modal>
  );
}
