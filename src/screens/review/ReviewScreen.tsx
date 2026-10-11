import { useCallback, useEffect, useMemo, useState } from 'react';
import { t } from '../../i18n';
import { useApp } from '../../app/state';
import { navigate } from '../../app/router';
import { Icon } from '../../components/Icon';
import { SheetView } from '../../components/SheetView';
import { playTone } from '../../audio/tone';
import { getPiece, savePiece } from '../../data/repo';
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
import { clearDraft, loadDraft } from '../add/draft';
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
  pieceId?: string;
  thumbnails: string[];
  warnings: string[];
  instrument: Instrument;
  /** Bars the music reader flagged for a look. */
  flags: BarFlag[];
}

export default function ReviewScreen({ id }: { id: string }) {
  const { profile } = useApp();
  const [source, setSource] = useState<Source | null>(null);
  const [xml, setXml] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [title, setTitleText] = useState('');
  const [showPhoto, setShowPhoto] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (id === 'draft') {
        const d = await loadDraft();
        if (cancelled) return;
        if (!d) return setMissing(true);
        setSource({ thumbnails: d.thumbnails, warnings: d.warnings, instrument: d.instrument, flags: d.flags ?? [] });
        setXml(d.musicxml);
      } else {
        const p = await getPiece(id);
        if (cancelled) return;
        if (!p) return setMissing(true);
        setSource({ pieceId: p.id, thumbnails: p.thumbnails, warnings: [], instrument: p.instrument ?? profile?.instrument ?? 'violin', flags: [] });
        setXml(p.musicxml);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, profile?.instrument]);

  const { score, parseError } = useMemo((): { score: ParsedScore | null; parseError: string | null } => {
    if (!xml) return { score: null, parseError: null };
    try {
      return { score: parseMusicXml(xml), parseError: null };
    } catch (e) {
      return { score: null, parseError: String((e as Error).message) };
    }
  }, [xml]);

  useEffect(() => {
    if (score && !title) setTitleText(score.title === 'Untitled' ? '' : score.title);
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

  const save = async () => {
    if (!xml || !source || !score) return;
    const doc = parseXmlDocument(xml);
    const finalTitle = title.trim() || score.title || 'My music';
    setTitle(doc, finalTitle);
    const piece = await savePiece({
      id: source.pieceId,
      title: finalTitle,
      musicxml: serialise(doc),
      thumbnails: source.thumbnails,
      instrument: source.instrument,
    });
    if (!source.pieceId) await clearDraft();
    navigate(`/practice/${piece.id}`, { replace: true });
  };

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
        <button className="btn icon-only round ghost" aria-label={t.common.back} onClick={() => navigate('/home')}>
          <Icon name="arrow_back" />
        </button>
        <h1>{t.review.title}</h1>
        <button className="btn" onClick={undo} disabled={history.length === 0}>
          <Icon name="undo" /> {t.review.undo}
        </button>
      </div>
      <p className="muted">{t.review.intro}</p>

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
        {source.thumbnails.length > 0 && (
          <aside className="review-photo">
            <button className="btn" onClick={() => setShowPhoto((s) => !s)} aria-expanded={showPhoto}>
              <Icon name="image" /> {showPhoto ? t.review.hidePhoto : t.review.showPhoto}
            </button>
            {showPhoto && (
              <div className="photo-strip">
                {source.thumbnails.map((src, i) => (
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

      <div className="sticky-action">
        {!hasNotes && <p className="notice warn">{t.review.noNotes}</p>}
        <button className="btn primary big" style={{ width: '100%' }} onClick={save} disabled={!hasNotes} data-testid="looks-good">
          <Icon name="check_circle" filled /> {t.review.looksGood}
        </button>
      </div>
    </div>
  );
}

function safeTypeOf(xml: string, i: number) {
  try {
    return noteTypeOf(parseXmlDocument(xml), i);
  } catch {
    return null;
  }
}
