import { useEffect, useRef, useState } from 'react';
import { INSTRUMENTS, UPLOAD_MAX_PAGES, type Instrument } from '../../config';
import { t } from '../../i18n';
import { useApp } from '../../app/state';
import { navigate } from '../../app/router';
import { Icon } from '../../components/Icon';
import { INSTRUMENT_ICON } from '../../components/instrumentIcons';
import { newId } from '../../data/db';
import { countPitchedNotes, parseMusicXml } from '../../sheet/musicxml';
import { OmrError, readSheetMusic } from '../../sheet/omrClient';
import { CropModal } from './CropModal';
import { saveDraft } from './draft';
import { renderPage, thumbnail, type PageDraft } from './imagePrep';

type Busy = { label: string; note?: string } | null;

export default function AddMusicScreen() {
  const { profile, online } = useApp();
  const [instrument, setInstrument] = useState<Instrument>(profile?.instrument ?? 'violin');
  const [pages, setPages] = useState<PageDraft[]>([]);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [cropping, setCropping] = useState<PageDraft | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const camera = useRef<HTMLInputElement>(null);
  const gallery = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const retake = useRef<HTMLInputElement>(null);
  const retakeId = useRef<string | null>(null);

  // Release preview URLs when leaving.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;
  useEffect(() => () => pagesRef.current.forEach((p) => URL.revokeObjectURL(p.previewUrl)), []);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    setError(null);
    const imgs = [...files].filter((f) => f.type.startsWith('image/') || f.type === '');
    const room = UPLOAD_MAX_PAGES - pages.length;
    if (imgs.length > room) setError(t.add.tooMany(UPLOAD_MAX_PAGES));
    const added = imgs.slice(0, Math.max(0, room)).map((f) => ({ id: newId(), file: f, previewUrl: URL.createObjectURL(f), rotation: 0 as const }));
    setPages((ps) => [...ps, ...added]);
  };

  const update = (id: string, changes: Partial<PageDraft>) => setPages((ps) => ps.map((p) => (p.id === id ? { ...p, ...changes } : p)));
  const move = (from: number, to: number) =>
    setPages((ps) => {
      if (to < 0 || to >= ps.length) return ps;
      const next = [...ps];
      const [x] = next.splice(from, 1);
      next.splice(to, 0, x);
      return next;
    });
  const remove = (id: string) =>
    setPages((ps) => {
      const p = ps.find((x) => x.id === id);
      if (p) URL.revokeObjectURL(p.previewUrl);
      return ps.filter((x) => x.id !== id);
    });

  const openMusicFile = async (f: File | undefined) => {
    if (!f) return;
    setError(null);
    try {
      const xml = await f.text();
      const score = parseMusicXml(xml);
      if (countPitchedNotes(score) === 0) {
        setError(t.add.errors.noNotes);
        return;
      }
      await saveDraft({ musicxml: xml, warnings: [], thumbnails: [], instrument });
      navigate('/review/draft');
    } catch {
      setError(t.add.errors.badFile);
    }
  };

  const readMusic = async () => {
    setError(null);
    try {
      const prepared: Blob[] = [];
      for (let i = 0; i < pages.length; i++) {
        setBusy({ label: t.add.preparing(i + 1, pages.length) });
        prepared.push(await renderPage(pages[i]));
      }
      const thumbs = await Promise.all(prepared.map((b) => thumbnail(b)));
      const result = await readSheetMusic(prepared, instrument, (p) => {
        setBusy(
          p.uploaded
            ? { label: t.add.reading, note: t.add.readingNote }
            : { label: t.add.uploading(p.page + 1, p.pages), note: t.add.readingNote },
        );
      });
      await saveDraft({ musicxml: result.musicxml, warnings: result.warnings, thumbnails: thumbs, instrument });
      navigate('/review/draft');
    } catch (e) {
      const kind = e instanceof OmrError ? e.kind : 'server';
      setError(t.add.errors[kind]);
    } finally {
      setBusy(null);
    }
  };

  // Drag to reorder (pointer events so it works with fingers too).
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>('[data-page-id]');
    const overId = el?.dataset.pageId;
    if (!overId || overId === dragging) return;
    const from = pages.findIndex((p) => p.id === dragging);
    const to = pages.findIndex((p) => p.id === overId);
    if (from >= 0 && to >= 0) move(from, to);
  };

  if (busy) {
    return (
      <div className="page" aria-live="polite">
        <div className="card stack busy-card" style={{ alignItems: 'center', textAlign: 'center' }}>
          <span className="spinner" aria-hidden />
          <h2>{busy.label}</h2>
          {busy.note && <p className="muted">{busy.note}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="page add">
      <div className="topbar">
        <button className="btn icon-only round ghost" aria-label={t.common.back} onClick={() => navigate('/home')}>
          <Icon name="arrow_back" />
        </button>
        <h1>{t.add.title}</h1>
      </div>
      <p>{t.add.intro}</p>

      <div className="field" style={{ marginBottom: 16 }}>
        <span style={{ fontWeight: 600 }} id="for-label">
          {t.add.instrumentFor}
        </span>
        <div className="segmented" role="group" aria-labelledby="for-label">
          {INSTRUMENTS.map((i) => (
            <button key={i} className="btn" aria-pressed={instrument === i} onClick={() => setInstrument(i)}>
              <Icon name={INSTRUMENT_ICON[i]} /> {t.instruments[i]}
            </button>
          ))}
        </div>
      </div>

      <div className="row" style={{ marginBottom: 16 }}>
        <button className="btn primary big" onClick={() => camera.current?.click()} disabled={pages.length >= UPLOAD_MAX_PAGES}>
          <Icon name="photo_camera" filled /> {t.add.takePhoto}
        </button>
        <button className="btn big" onClick={() => gallery.current?.click()} disabled={pages.length >= UPLOAD_MAX_PAGES}>
          <Icon name="photo_library" /> {t.add.fromGallery}
        </button>
      </div>
      <input ref={camera} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
      <input ref={gallery} type="file" accept="image/*" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ''))} />
      <input
        ref={retake}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          const id = retakeId.current;
          if (f && id) {
            const old = pages.find((p) => p.id === id);
            if (old) URL.revokeObjectURL(old.previewUrl);
            update(id, { file: f, previewUrl: URL.createObjectURL(f), rotation: 0, crop: undefined });
          }
          e.target.value = '';
        }}
      />

      {error && (
        <p className="notice error" role="alert">
          <Icon name="info" /> {error}
        </p>
      )}

      {pages.length > 0 && (
        <section aria-label={t.add.pages(pages.length)}>
          <div className="spread">
            <h2 style={{ margin: 0 }}>{t.add.pages(pages.length)}</h2>
            {pages.length > 1 && <span className="muted">{t.add.dragHint}</span>}
          </div>
          <ol className="page-tray" onPointerMove={onPointerMove} onPointerUp={() => setDragging(null)} onPointerCancel={() => setDragging(null)}>
            {pages.map((p, i) => (
              <li key={p.id} data-page-id={p.id} className={`page-card card${dragging === p.id ? ' dragging' : ''}`}>
                <div
                  className="page-thumb-wrap"
                  onPointerDown={(e) => {
                    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
                    setDragging(p.id);
                  }}
                  style={{ touchAction: 'none' }}
                >
                  <img src={p.previewUrl} alt={t.add.pageLabel(i + 1)} style={{ transform: `rotate(${p.rotation}deg)` }} draggable={false} />
                  <span className="page-num">{i + 1}</span>
                </div>
                <div className="page-actions">
                  <button className="btn icon-only" aria-label={t.add.moveEarlier} onClick={() => move(i, i - 1)} disabled={i === 0}>
                    <Icon name="arrow_back" />
                  </button>
                  <button className="btn icon-only" aria-label={t.add.moveLater} onClick={() => move(i, i + 1)} disabled={i === pages.length - 1}>
                    <Icon name="arrow_forward" />
                  </button>
                  <button className="btn icon-only" aria-label={t.add.rotate} onClick={() => update(p.id, { rotation: (((p.rotation + 90) % 360) as PageDraft['rotation']), crop: undefined })}>
                    <Icon name="rotate_right" />
                  </button>
                  <button className="btn icon-only" aria-label={t.add.crop} onClick={() => setCropping(p)}>
                    <Icon name="crop" />
                  </button>
                  <button
                    className="btn icon-only"
                    aria-label={t.add.retake}
                    onClick={() => {
                      retakeId.current = p.id;
                      retake.current?.click();
                    }}
                  >
                    <Icon name="replay" />
                  </button>
                  <button className="btn icon-only danger" aria-label={t.add.remove} onClick={() => remove(p.id)}>
                    <Icon name="delete" />
                  </button>
                </div>
              </li>
            ))}
          </ol>
          <p className="muted">{t.add.tips}</p>
          {!online && <p className="notice warn">{t.add.errors.offline}</p>}
          <button className="btn primary big" style={{ width: '100%' }} onClick={readMusic} disabled={!online}>
            <Icon name="auto_awesome" filled /> {t.add.readMusic}
          </button>
        </section>
      )}

      <section className="card flat" style={{ marginTop: 24 }}>
        <h2>{t.add.openFile}</h2>
        <p className="muted">{t.add.openFileHelp}</p>
        <button className="btn" onClick={() => file.current?.click()}>
          <Icon name="upload_file" /> {t.add.openFile}
        </button>
        <input
          ref={file}
          type="file"
          accept=".musicxml,.xml,application/vnd.recordare.musicxml+xml,application/xml,text/xml"
          hidden
          data-testid="musicxml-input"
          onChange={(e) => {
            void openMusicFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </section>

      {cropping && (
        <CropModal
          page={cropping}
          onClose={() => setCropping(null)}
          onApply={(crop) => {
            update(cropping.id, { crop });
            setCropping(null);
          }}
        />
      )}
    </div>
  );
}
