import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '../../i18n';
import { useApp } from '../../app/state';
import { navigate } from '../../app/router';
import { Icon } from '../../components/Icon';
import { SheetView } from '../../components/SheetView';
import { playTone } from '../../audio/tone';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { readerName } from '../../components/MusicReader';
import { downloadMusicXml } from '../../data/download';
import { getPiece, savePiece } from '../../data/repo';
import type { Piece, PhotoLine } from '../../data/types';
import type { Instrument } from '../../config';
import {
  deleteNote,
  insertAfter,
  NOTE_TYPES,
  noteTypeOf,
  serialise,
  setDuration,
  setKey,
  setTime,
  setTitle,
  toggleRest,
  transpose,
  type NoteType,
} from '../../sheet/editor';
import { countPitchedNotes, keyName, noteName, parseMusicXml, parseXmlDocument, type ParsedScore } from '../../sheet/musicxml';
import { clearDraft, loadDraft, saveDraft, type FailedLineDraft } from '../add/draft';
import { useLiveRead } from '../add/liveRead';
import { rereadLine } from '../../sheet/readSheet';
import { insertLine } from '../../sheet/lineInsert';
import type { RnMeasure } from '../../sheet/notation';
import type { BarProblem } from '../../sheet/checks';
import { LiveReview } from './LiveReview';
import type { BarFlag } from '../../sheet/reader';

const TIME_SIGS: [number, number][] = [
  [2, 4],
  [3, 4],
  [4, 4],
  [5, 4],
  [2, 2],
  [3, 8],
  [6, 8],
  [9, 8],
  [12, 8],
];

interface Source {
  /** Set when editing a piece that's already saved. */
  piece?: Piece;
  thumbnails: string[];
  /** Bigger copies of the photos, and where each line of music is on them. */
  photos: string[];
  photoLines: PhotoLine[];
  /** Which music reader read the photos. */
  reader?: string;
  warnings: string[];
  instrument: Instrument;
  /** Bars the music reader flagged for a look. */
  flags: BarFlag[];
  /** The music and title as they were when the editor opened (to spot unsaved changes). */
  originalXml: string;
}

/**
 * Check the notes after a scan, or edit a saved piece later (same tools).
 * `?from=practice` returns to the Practice screen afterwards.
 */
export default function ReviewScreen({ id, query }: { id: string; query?: URLSearchParams }) {
  const { profile } = useApp();
  const from = query?.get('from') === 'practice' ? 'practice' : 'home';
  const [originalTitle, setOriginalTitle] = useState('');
  const [leaving, setLeaving] = useState(false);
  const [source, setSource] = useState<Source | null>(null);
  const [xml, setXml] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [title, setTitleText] = useState('');
  const [showPhoto, setShowPhoto] = useState(false);
  const [missing, setMissing] = useState(false);
  const [failed, setFailed] = useState<FailedLineDraft[]>([]);
  const [rereading, setRereading] = useState<Set<string>>(new Set());
  const [rereadProblem, setRereadProblem] = useState<string | null>(null);
  // A page still being read shows here line by line; the draft loads once it's done.
  const live = useLiveRead();
  const liveHere = id === 'draft' && !!live;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (id === 'draft') {
        if (liveHere) return;
        const d = await loadDraft();
        if (cancelled) return;
        if (!d) return setMissing(true);
        setMissing(false);
        setFailed(d.failedLines ?? []);
        setSource({ thumbnails: d.thumbnails, photos: d.photos ?? [], photoLines: d.photoLines ?? [], reader: d.reader, warnings: d.warnings, instrument: d.instrument, flags: d.flags ?? [], originalXml: d.musicxml });
        setXml(d.musicxml);
      } else {
        const p = await getPiece(id);
        if (cancelled) return;
        if (!p) return setMissing(true);
        setSource({
          piece: p,
          thumbnails: p.thumbnails,
          photos: p.photos ?? [],
          photoLines: p.photoLines ?? [],
          reader: p.reader,
          warnings: [],
          instrument: p.instrument ?? profile?.instrument ?? 'violin',
          flags: [],
          originalXml: p.musicxml,
        });
        setTitleText(p.title);
        setOriginalTitle(p.title);
        setXml(p.musicxml);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, profile?.instrument, liveHere]);

  const { score, parseError } = useMemo((): { score: ParsedScore | null; parseError: string | null } => {
    if (!xml) return { score: null, parseError: null };
    try {
      return { score: parseMusicXml(xml), parseError: null };
    } catch (e) {
      return { score: null, parseError: String((e as Error).message) };
    }
  }, [xml]);

  useEffect(() => {
    if (score && !title && !source?.piece) setTitleText(score.title === 'Untitled' ? '' : score.title);
    // Only seed the title once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score]);

  const edit = useCallback(
    (op: (doc: Document) => number | null | void, opts: { keepSelection?: boolean } = {}) => {
      if (!xml) return;
      const doc = parseXmlDocument(xml);
      const result = op(doc);
      const next = serialise(doc);
      setHistory((h) => [...h.slice(-49), xml]);
      setXml(next);
      if (typeof result === 'number') setSelected(result);
      else if (!opts.keepSelection) setSelected(null);
    },
    [xml],
  );

  const undo = () => {
    setHistory((h) => {
      if (h.length === 0) return h;
      setXml(h[h.length - 1]);
      setSelected(null);
      return h.slice(0, -1);
    });
  };

  const highlights = useMemo(() => (source?.flags ?? []).map((f) => ({ index: f.index, n: f.n })), [source]);
  /** Select the first note of a flagged bar (so the editing tools are right there). */
  const showBar = (index: number) => {
    const first = score?.notes.filter((n) => n.measureIndex === index).sort((a, b) => a.startQ - b.startQ)[0];
    if (first) setSelected(first.xmlIndex);
  };

  const note = score && selected !== null ? score.notes.find((n) => n.xmlIndex === selected) : undefined;
  const fifths = score?.measures[note?.measureIndex ?? 0]?.fifths ?? 0;
  const firstMeasure = score?.measures[0];
  const typeInfo = xml && selected !== null ? safeTypeOf(xml, selected) : null;

  const pitchEdit = (semis: number) => {
    if (selected === null || !note || note.isRest) return;
    edit((doc) => transpose(doc, selected, semis), { keepSelection: true });
    if (note.midi !== undefined) playTone(note.midi + semis);
  };

  const editing = !!source?.piece;
  const dirty = !!source && !!xml && (xml !== source.originalXml || (editing && title.trim() !== originalTitle.trim()));

  // Don't lose edits to a reload or closing the tab.
  useEffect(() => {
    if (!editing || !dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editing, dirty]);

  /** The music as it stands, with the title in it. */
  const currentXml = () => {
    const doc = parseXmlDocument(xml!);
    const finalTitle = title.trim() || score?.title || 'My music';
    setTitle(doc, finalTitle);
    return { finalTitle, musicxml: serialise(doc) };
  };

  const done = () => navigate(source?.piece && from === 'practice' ? `/practice/${source.piece.id}` : '/home', { replace: !!source?.piece });

  const save = async () => {
    if (!xml || !source || !score) return;
    if (source.piece && !dirty) return done();
    const { finalTitle, musicxml } = currentXml();
    const piece = await savePiece({
      id: source.piece?.id,
      title: finalTitle,
      musicxml,
      thumbnails: source.thumbnails,
      photos: source.photos.length ? source.photos : undefined,
      photoLines: source.photoLines.length ? source.photoLines : undefined,
      reader: source.reader,
      instrument: source.instrument,
      // Keeps the kid's scores (they're linked by id), and notes the edit in their history.
      editedAt: source.piece ? [...(source.piece.editedAt ?? []), Date.now()] : undefined,
    });
    if (source.piece) return done();
    await clearDraft();
    navigate(`/practice/${piece.id}`, { replace: true });
  };

  const cancel = () => (editing && dirty ? setLeaving(true) : editing ? done() : navigate('/home'));

  const lineKey = (f: FailedLineDraft) => `${f.page}-${f.line}`;
  const order = (f: { page: number; line: number }) => f.page * 1000 + f.line;

  /** Read failed lines again (all at once), then put each one's bars where they belong. */
  const reread = async (lines: FailedLineDraft[]) => {
    if (!source || !xml) return;
    setRereadProblem(null);
    setRereading((r) => new Set([...r, ...lines.map(lineKey)]));
    const results = await Promise.all(
      lines.map((f) =>
        rereadLine(f.job, source.instrument).then(
          (r) => ({ f, measures: r.measures, problems: r.problems }),
          () => null,
        ),
      ),
    );
    setRereading((r) => new Set([...r].filter((k) => !lines.some((f) => lineKey(f) === k))));
    const got = results.filter((r): r is { f: FailedLineDraft; measures: RnMeasure[]; problems: BarProblem[] } => !!r && r.measures.length > 0);
    if (got.length < lines.length) setRereadProblem(t.review.rereadFailed);
    if (got.length === 0) return;
    // Latest line first, so putting one in never moves the place of another still to go in.
    let cur = xml;
    let left = failed;
    let photoLines = source.photoLines;
    let flags = source.flags;
    const fresh: { index: number; reasons: string[] }[] = [];
    for (const g of [...got].sort((a, b) => order(b.f) - order(a.f))) {
      const { xml: next, count } = insertLine(cur, g.f.at, g.measures, g.f.job.ctx, source.instrument);
      const at = g.f.at;
      cur = next;
      left = left.filter((x) => x !== g.f).map((x) => (order(x) > order(g.f) ? { ...x, at: x.at + count } : x));
      photoLines = [
        ...photoLines.map((l) => (l.from >= at ? { ...l, from: l.from + count, to: l.to + count } : l)),
        ...(g.f.band ? [{ page: g.f.page - 1, top: g.f.band.top, bottom: g.f.band.bottom, from: at, to: at + count - 1 }] : []),
      ];
      flags = flags.map((x) => (x.index >= at ? { ...x, index: x.index + count } : x));
      fresh.forEach((x) => x.index >= at && (x.index += count));
      g.problems.forEach((p) => {
        const k = g.measures.findIndex((m) => Number(m.n) === p.n);
        if (k >= 0) fresh.push({ index: at + k, reasons: [p.message.replace(/^Bar \d+/, 'This bar')] });
      });
    }
    // Bar numbers moved on: name each flagged bar by its new number.
    const parsed = parseMusicXml(cur);
    const barNo = (i: number) => Number(parsed.measures[i]?.number ?? i + 1);
    flags = [...flags.map((x) => ({ ...x, n: barNo(x.index), reasons: x.reasons.map((r) => r.replace(`bar ${x.n}`, `bar ${barNo(x.index)}`).replace(`Bar ${x.n}`, `Bar ${barNo(x.index)}`)) })), ...fresh.map((x) => ({ index: x.index, n: barNo(x.index), reasons: x.reasons }))].sort((a, b) => a.index - b.index);
    setHistory([]);
    setSelected(null);
    setXml(cur);
    setFailed(left);
    setSource({ ...source, photoLines, flags, originalXml: source.piece ? source.originalXml : cur });
    if (!source.piece) {
      const d = await loadDraft();
      if (d) await saveDraft({ ...d, musicxml: cur, failedLines: left, photoLines, flags });
    }
  };

  const pagePhotos = source ? (source.photos.length ? source.photos : source.thumbnails) : [];
  const line = note && source ? source.photoLines.find((l) => note.measureIndex >= l.from && note.measureIndex <= l.to) : undefined;
  const barPhoto = line && source?.photos[line.page] ? { src: source.photos[line.page], top: line.top, bottom: line.bottom } : null;

  if (liveHere && live) return <LiveReview live={live} />;

  if (missing) {
    return (
      <div className="page">
        <p className="notice">{t.review.notFound}</p>
        <button className="btn primary" onClick={() => navigate('/home')}>
          {t.errors.goHome}
        </button>
      </div>
    );
  }
  if (!xml || !source) return <div className="page" aria-busy="true" />;

  const hasNotes = score ? countPitchedNotes(score) > 0 : false;

  return (
    <div className="page wide review">
      <div className="topbar">
        <button className="btn icon-only round ghost" aria-label={editing ? t.common.cancel : t.common.back} onClick={cancel}>
          <Icon name={editing ? 'close' : 'arrow_back'} />
        </button>
        <h1>{editing ? t.review.editTitle : t.review.title}</h1>
        <button className="btn" onClick={undo} disabled={history.length === 0}>
          <Icon name="undo" /> {t.review.undo}
        </button>
      </div>
      <p className="muted">{editing ? t.review.editIntro : t.review.intro}</p>
      {source.reader && (
        <p className="muted small reader-used" data-testid="reader-used">
          <Icon name="auto_awesome" /> {t.review.readBy(readerName(source.reader))}
        </p>
      )}

      {source.warnings.length > 0 && (
        <div className="notice warn" role="note">
          <Icon name="lightbulb" />
          <div>
            <strong>{t.review.warnings}</strong>
            <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
              {source.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {source.flags.length > 0 && (
        <div className="notice warn bar-flags" role="note" data-testid="flag-list">
          <Icon name="priority_high" />
          <div>
            <strong>{t.review.flagsTitle(source.flags.length)}</strong>
            <p className="muted" style={{ margin: '2px 0 6px' }}>{t.review.flagsHelp}</p>
            <ul>
              {source.flags.map((f) => (
                <li key={f.index}>
                  <button className="btn bar-chip" onClick={() => showBar(f.index)}>
                    {t.review.barLabel(f.n)}
                  </button>{' '}
                  <span>{f.reasons.join(' ')}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {failed.length > 0 && (
        <section className="notice warn failed-lines" role="note" data-testid="failed-lines">
          <Icon name="priority_high" />
          <div className="stack" style={{ flex: 1 }}>
            <div>
              <strong>{t.review.failedTitle(failed.length)}</strong>
              <p className="muted" style={{ margin: '2px 0 0' }}>{t.review.failedHelp}</p>
            </div>
            <ul className="failed-list">
              {failed.map((f) => {
                const busy = rereading.has(lineKey(f));
                const photo = source.photos[f.page - 1];
                return (
                  <li key={lineKey(f)} className="failed-line">
                    <strong>{t.review.lineLabel(f.page, f.line, Math.max(1, source.photos.length, ...failed.map((x) => x.page)))}</strong>
                    {photo && f.band && <PhotoSlice src={photo} top={f.band.top} bottom={f.band.bottom} alt={t.review.lineLabel(f.page, f.line, 2)} />}
                    <button className="btn primary" onClick={() => void reread([f])} disabled={busy} data-testid="read-again">
                      <Icon name={busy ? 'graphic_eq' : 'replay'} /> {busy ? t.review.rereading : t.review.readAgain}
                    </button>
                  </li>
                );
              })}
            </ul>
            {failed.length > 1 && (
              <button className="btn" onClick={() => void reread(failed.filter((f) => !rereading.has(lineKey(f))))} disabled={rereading.size > 0} data-testid="retry-all">
                <Icon name="replay" /> {t.review.retryAll}
              </button>
            )}
            {rereadProblem && (
              <p className="notice error" role="alert" style={{ margin: 0 }}>
                {rereadProblem}
              </p>
            )}
          </div>
        </section>
      )}

      <div className="review-settings row">
        <div className="field" style={{ flex: '1 1 240px' }}>
          <label htmlFor="piece-title">{t.review.titleLabel}</label>
          <input id="piece-title" type="text" value={title} maxLength={80} onChange={(e) => setTitleText(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="piece-key">{t.review.keyLabel}</label>
          <select id="piece-key" value={firstMeasure?.fifths ?? 0} onChange={(e) => edit((doc) => setKey(doc, Number(e.target.value)), { keepSelection: true })}>
            {Array.from({ length: 15 }, (_, i) => i - 7).map((f) => (
              <option key={f} value={f}>
                {keyName(f, firstMeasure?.mode)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="piece-time">{t.review.timeLabel}</label>
          <select
            id="piece-time"
            value={`${firstMeasure?.beats ?? 4}/${firstMeasure?.beatType ?? 4}`}
            onChange={(e) => {
              const [b, bt] = e.target.value.split('/').map(Number);
              edit((doc) => setTime(doc, b, bt), { keepSelection: true });
            }}
          >
            {TIME_SIGS.map(([b, bt]) => (
              <option key={`${b}/${bt}`} value={`${b}/${bt}`}>
                {b}/{bt}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className={`review-body${showPhoto ? ' with-photo' : ''}`}>
        {pagePhotos.length > 0 && (
          <aside className="review-photo">
            <button className="btn" onClick={() => setShowPhoto((s) => !s)} aria-expanded={showPhoto}>
              <Icon name="image" /> {showPhoto ? t.review.hidePhoto : t.review.showPhoto}
            </button>
            {showPhoto && (
              <div className="photo-strip">
                {pagePhotos.map((src, i) => (
                  <img key={i} src={src} alt={`${t.review.photo} ${i + 1}`} />
                ))}
              </div>
            )}
          </aside>
        )}
        <div className="review-sheet">
          {parseError && <p className="notice error">{parseError}</p>}
          {score && (
            <SheetView
              xml={xml}
              score={score}
              selected={selected}
              highlights={highlights}
              label={t.practice.sheetLabel}
              onTapNote={(i) => {
                setSelected(i);
                const n = score.notes.find((x) => x.xmlIndex === i);
                if (n?.midi !== undefined) playTone(n.midi);
              }}
              style={{ maxHeight: '62vh' }}
            />
          )}
        </div>
      </div>

      <section className="card edit-tools" aria-label={t.review.tapANote}>
        {barPhoto && note && (
          <figure className="bar-photo" data-testid="bar-photo">
            <figcaption>
              <strong>{t.review.photoForBar(Number(score?.measures[note.measureIndex]?.number ?? note.measureIndex + 1))}</strong>{' '}
              <span className="muted small">{t.review.photoForBarHelp}</span>
            </figcaption>
            <PhotoSlice src={barPhoto.src} top={barPhoto.top} bottom={barPhoto.bottom} alt={t.review.photoForBar(Number(score?.measures[note.measureIndex]?.number ?? note.measureIndex + 1))} />
          </figure>
        )}
        <p className="selected-label" aria-live="polite">
          {note ? (note.isRest ? t.review.selectedRest : t.review.selected(noteName(note.midi ?? 60, fifths, true))) : t.review.tapANote}
        </p>
        {note && selected !== null && (
          <div className="stack">
            {!note.isRest && (
              <div className="row">
                <button className="btn" onClick={() => pitchEdit(1)}>
                  <Icon name="arrow_upward" /> {t.review.higher}
                </button>
                <button className="btn" onClick={() => pitchEdit(-1)}>
                  <Icon name="arrow_downward" /> {t.review.lower}
                </button>
                <button className="btn" onClick={() => pitchEdit(12)}>
                  <Icon name="keyboard_double_arrow_up" /> {t.review.octaveUp}
                </button>
                <button className="btn" onClick={() => pitchEdit(-12)}>
                  <Icon name="keyboard_double_arrow_down" /> {t.review.octaveDown}
                </button>
              </div>
            )}
            <div className="row" role="group" aria-label={t.review.length}>
              <span style={{ fontWeight: 600 }}>{t.review.length}</span>
              <div className="segmented">
                {NOTE_TYPES.map((ty) => (
                  <button
                    key={ty}
                    className="btn"
                    aria-pressed={typeInfo?.type === ty}
                    title={t.review.lengthsLong[ty]}
                    aria-label={t.review.lengthsLong[ty]}
                    onClick={() => edit((doc) => setDuration(doc, selected, ty as NoteType, typeInfo?.dots ?? 0), { keepSelection: true })}
                  >
                    {t.review.lengths[ty]}
                  </button>
                ))}
              </div>
              <button
                className="btn"
                aria-pressed={(typeInfo?.dots ?? 0) > 0}
                onClick={() =>
                  edit((doc) => setDuration(doc, selected, ((typeInfo?.type as NoteType) ?? 'quarter'), (typeInfo?.dots ?? 0) > 0 ? 0 : 1), { keepSelection: true })
                }
              >
                {t.review.dotted}
              </button>
            </div>
            <div className="row">
              <button className="btn" onClick={() => edit((doc) => toggleRest(doc, selected), { keepSelection: !note.isChord })}>
                <Icon name={note.isRest ? 'music_note' : 'pause'} /> {note.isRest ? t.review.makeNote : t.review.makeRest}
              </button>
              <button className="btn" onClick={() => edit((doc) => insertAfter(doc, selected, 'note'))}>
                <Icon name="add" /> {t.review.insertNote}
              </button>
              <button className="btn" onClick={() => edit((doc) => insertAfter(doc, selected, 'rest'))}>
                <Icon name="add" /> {t.review.insertRest}
              </button>
              <button className="btn danger" onClick={() => edit((doc) => deleteNote(doc, selected))}>
                <Icon name="delete" /> {t.review.deleteNote}
              </button>
            </div>
          </div>
        )}
      </section>

      <div className="row review-extra">
        <button className="btn" onClick={() => xml && void downloadMusicXml(currentXml().musicxml, title.trim() || score?.title || 'My music')} disabled={!hasNotes} data-testid="download-music">
          <Icon name="download" /> {t.review.download}
        </button>
      </div>

      <div className="sticky-action">
        {!hasNotes && <p className="notice warn">{t.review.noNotes}</p>}
        <div className="row sticky-buttons">
          {editing && (
            <button className="btn big" onClick={cancel} data-testid="cancel-edit">
              {t.common.cancel}
            </button>
          )}
          <button className="btn primary big" style={{ flex: 1 }} onClick={save} disabled={!hasNotes} data-testid="looks-good">
            <Icon name="check_circle" filled /> {editing ? t.review.saveChanges : t.review.looksGood}
          </button>
        </div>
      </div>

      {leaving && (
        <ConfirmDialog
          title={t.review.leaveTitle}
          message={t.review.leaveMessage}
          confirmLabel={t.review.leaveYes}
          cancelLabel={t.review.keepEditing}
          onCancel={() => setLeaving(false)}
          onConfirm={done}
        />
      )}
    </div>
  );
}

/** One line of a photo (top and bottom as fractions of its height), cut out so it sits right by the notes. */
function PhotoSlice({ src, top, bottom, alt }: { src: string; top: number; bottom: number; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const img = new Image();
    img.onload = () => {
      const y0 = Math.max(0, Math.floor(top * img.naturalHeight));
      const h = Math.max(1, Math.min(img.naturalHeight, Math.ceil(bottom * img.naturalHeight)) - y0);
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = h;
      c.getContext('2d')?.drawImage(img, 0, y0, img.naturalWidth, h, 0, 0, img.naturalWidth, h);
      if (live) setUrl(c.toDataURL('image/jpeg', 0.85));
    };
    img.src = src;
    return () => {
      live = false;
    };
  }, [src, top, bottom]);
  return url ? <img className="photo-slice" src={url} alt={alt} /> : <div className="photo-slice placeholder" aria-busy="true" />;
}

function safeTypeOf(xml: string, i: number) {
  try {
    return noteTypeOf(parseXmlDocument(xml), i);
  } catch {
    return null;
  }
}
