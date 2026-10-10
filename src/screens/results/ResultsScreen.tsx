import { useEffect, useMemo, useState } from 'react';
import { t } from '../../i18n';
import { navigate } from '../../app/router';
import { CountUp } from '../../components/CountUp';
import { Confetti } from '../../components/Confetti';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { SheetView } from '../../components/SheetView';
import { Stars } from '../../components/Stars';
import { getPiece, getSession } from '../../data/repo';
import type { BadgeId } from '../../data/stats';
import type { Piece, PracticeSession, StoredNoteMark } from '../../data/types';
import { findPositives, type Issue, type LoopFix, type Positive } from '../../scoring/feedback';
import { keyName, keySignatureAlters, noteName, parseMusicXml, spellMidi } from '../../sheet/musicxml';
import type { NoteMark } from '../../sheet/osmd';
import type { RunScore } from '../../scoring/score';

const SEVERITY: Record<NoteMark, number> = { correct: 0, close: 1, missed: 2, wrong: 3 };

function markOf(m: StoredNoteMark): NoteMark {
  if (m.pitch === 'missed') return 'missed';
  if (m.pitch === 'wrong') return 'wrong';
  if (m.pitch === 'close' || m.timing === 'early' || m.timing === 'late') return 'close';
  return 'correct';
}

/** One mark per notehead; with repeats, the trickiest pass wins so it's visible. */
export function marksToMap(marks: StoredNoteMark[]): Map<number, NoteMark> {
  const out = new Map<number, NoteMark>();
  for (const m of marks) {
    const mark = markOf(m);
    for (const r of m.refs) {
      const prev = out.get(r);
      if (!prev || SEVERITY[mark] > SEVERITY[prev]) out.set(r, mark);
    }
  }
  return out;
}

function positiveText(p: Positive): string {
  const P = t.results.positives;
  switch (p.kind) {
    case 'improved':
      return P.improved(p.count ?? 0);
    case 'perfectBars':
      return P.perfectBars(p.count ?? 1);
    default:
      return P[p.kind];
  }
}

function issueText(i: Issue): string {
  const I = t.results.issues;
  const written = i.expectedMidi !== undefined ? noteName(i.expectedMidi, i.fifths ?? 0) : '';
  switch (i.kind) {
    case 'rushed':
      return I.rushed(i.bar);
    case 'dragging':
      return I.dragging(i.bar);
    case 'pitch':
      return i.keyHint && i.playedMidi !== undefined ? I.pitchKey(i.bar, written, noteName(i.playedMidi, 0)) : I.pitch(i.bar, written);
    case 'tuning':
      return i.direction === 'high' ? I.tuningHigh(i.bar, written) : I.tuningLow(i.bar, written);
    case 'missed':
      return I.missed(i.bar);
    case 'short':
      return I.short(i.bar);
  }
}

export default function ResultsScreen({ id }: { id: string }) {
  const [session, setSession] = useState<PracticeSession | null | undefined>(undefined);
  const [piece, setPiece] = useState<Piece | undefined>(undefined);
  const [noteFix, setNoteFix] = useState<Issue | null>(null);
  const [badgeQueue, setBadgeQueue] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      const s = await getSession(id);
      setSession(s ?? null);
      if (s) {
        setPiece(await getPiece(s.pieceId));
        setBadgeQueue(s.newBadges ?? []);
      }
    })();
  }, [id]);

  const score = useMemo(() => {
    try {
      return piece ? parseMusicXml(piece.musicxml) : null;
    } catch {
      return null;
    }
  }, [piece]);
  const marks = useMemo(() => (session ? marksToMap(session.marks) : new Map<number, NoteMark>()), [session]);

  if (session === null) {
    return (
      <div className="page">
        <p className="notice">{t.errors.notFound}</p>
        <button className="btn primary" onClick={() => navigate('/home')}>
          {t.errors.goHome}
        </button>
      </div>
    );
  }
  if (!session) return <div className="page" aria-busy="true" />;

  const scored = session.score !== undefined;
  const positives = findPositives(
    {
      score: session.score ?? 0,
      stars: session.stars ?? 0,
      pitchAccuracy: session.pitchAccuracy ?? 0,
      rhythmAccuracy: session.rhythmAccuracy ?? 0,
      completion: session.completion ?? 0,
      bars: session.bars.map((b) => ({ ...b, notes: 0, meanOnsetErrorMs: 0, offPitch: 0, close: 0, short: 0 })),
      notes: [],
      extras: 0,
    } satisfies RunScore,
    scored ? session.previousBest : undefined,
  ).slice(0, 2);
  const issues = session.issues ?? [];
  const activeS = Math.round(session.activeMs / 1000);

  const playAgainQuery = () => {
    const q = new URLSearchParams({ bpm: String(session.tempoBpm), mode: session.mode });
    if (session.loop) {
      q.set('from', String(session.loop.fromIndex));
      q.set('to', String(session.loop.toIndex));
    }
    return q.toString();
  };
  const runFix = (fix: LoopFix) => {
    const q = new URLSearchParams({
      from: String(fix.fromIndex),
      to: String(fix.toIndex),
      bpm: String(Math.max(40, Math.round(session.tempoBpm * fix.tempoFactor))),
    });
    navigate(`/practice/${session.pieceId}?${q.toString()}`);
  };
  const barNum = (i: number) => score?.measures[i]?.number ?? String(i + 1);

  let improvement: string;
  if (!scored) improvement = '';
  else if (session.previousBest === undefined) improvement = t.results.firstTime;
  else if (session.score! > session.previousBest) improvement = t.results.improved(session.previousBest, session.score!);
  else if (session.score === session.previousBest) improvement = t.results.sameAsBest(session.previousBest);
  else improvement = t.results.notQuite(session.previousBest);

  const badge = badgeQueue[0] as BadgeId | undefined;

  return (
    <div className="page results">
      <Confetti run={!!session.personalBest && session.previousBest !== undefined} />
      <h1 className="sr-only">{t.results.title}</h1>

      <section className="card results-hero" aria-live="polite">
        {scored ? (
          <>
            <div className="big-score" aria-label={`${t.results.score}: ${session.score} ${t.results.outOf}`}>
              <span aria-hidden>
                <CountUp value={session.score!} />
              </span>
              <span className="out-of" aria-hidden>
                {t.results.outOf}
              </span>
            </div>
            <Stars count={session.stars ?? 0} size={56} />
            {session.personalBest && session.previousBest !== undefined && <p className="pb">{t.results.personalBest}</p>}
            <p className="improvement">{improvement}</p>
          </>
        ) : (
          <>
            <h2>{t.results.learnTitle}</h2>
            <p className="improvement">{t.results.learnAccuracy(Math.round((session.learnAccuracy ?? 0) * 100))}</p>
          </>
        )}
        <ul className="positives">
          {positives.map((p, i) => (
            <li key={i}>
              <Icon name="favorite" filled /> {positiveText(p)}
            </li>
          ))}
          <li>
            <Icon name="timer" filled /> {t.results.activeTime(Math.floor(activeS / 60), activeS % 60)}
          </li>
        </ul>
      </section>

      {scored && (
        <section className="card">
          <h2>{t.results.toWorkOn}</h2>
          {issues.length === 0 && <p>{t.results.nothingToFix}</p>}
          <ul className="issues" role="list">
            {issues.map((i, k) => (
              <li key={k} className="issue">
                <span>{issueText(i)}</span>
                <button
                  className="btn primary"
                  onClick={() => (i.fix.type === 'note' ? setNoteFix(i) : runFix(i.fix))}
                  aria-label={`${t.results.fixIt}: ${issueText(i)}`}
                >
                  <Icon name="build" filled /> {t.results.fixIt}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {piece && score && (
        <section>
          <SheetView xml={piece.musicxml} score={score} marks={marks} label={t.practice.sheetLabel} style={{ maxHeight: '60vh' }} />
          <ul className="legend" aria-label={t.results.legendTitle}>
            <li>
              <span className="swatch correct" aria-hidden /> {t.results.legendCorrect}
            </li>
            <li>
              <span className="swatch close" aria-hidden>
                <Icon name="adjust" />
              </span>{' '}
              {t.results.legendClose}
            </li>
            <li>
              <span className="swatch wrong" aria-hidden>
                <Icon name="priority_high" />
              </span>{' '}
              {t.results.legendWrong}
            </li>
            <li>
              <span className="swatch missed" aria-hidden>
                <Icon name="more_horiz" />
              </span>{' '}
              {t.results.legendMissed}
            </li>
          </ul>
        </section>
      )}

      <div className="row" style={{ marginTop: 16 }}>
        <button className="btn primary big" onClick={() => navigate(`/practice/${session.pieceId}?${playAgainQuery()}`)} data-testid="play-again">
          <Icon name="replay" /> {t.results.playAgain}
        </button>
        <button className="btn big" onClick={() => navigate('/home')}>
          <Icon name="home" /> {t.results.backHome}
        </button>
      </div>

      {noteFix && noteFix.fix.type === 'note' && (
        <Modal title={t.common.bar(noteFix.bar)} onClose={() => setNoteFix(null)}>
          <p className="big-note">{noteFix.expectedMidi !== undefined ? noteName(noteFix.expectedMidi, noteFix.fifths ?? 0, true) : ''}</p>
          {noteFix.expectedMidi !== undefined && <p>{t.results.noteHint(noteName(noteFix.expectedMidi, noteFix.fifths ?? 0))}</p>}
          {noteFix.keyHint && noteFix.expectedMidi !== undefined && (
            <p className="notice">
              <Icon name="key" />{' '}
              {(() => {
                const sp = spellMidi(noteFix.expectedMidi, noteFix.fifths ?? 0);
                const alter = keySignatureAlters(noteFix.fifths ?? 0)[sp.step] ?? 0;
                return t.results.keyHint(keyName(noteFix.fifths ?? 0), sp.step, `${sp.step}${alter > 0 ? '♯' : '♭'}`);
              })()}
            </p>
          )}
          <button className="btn primary big" style={{ width: '100%' }} onClick={() => noteFix.fix.type === 'note' && runFix(noteFix.fix.loop)}>
            <Icon name="repeat" />{' '}
            {t.results.practiseBars(barNum(noteFix.fix.loop.fromIndex), barNum(noteFix.fix.loop.toIndex), Math.round(noteFix.fix.loop.tempoFactor * 100))}
          </button>
        </Modal>
      )}

      {badge && t.badges[badge] && (
        <Modal title={t.results.newBadge} onClose={() => setBadgeQueue((q) => q.slice(1))}>
          <div className="stack" style={{ alignItems: 'center', textAlign: 'center' }}>
            <span className="badge-medal big" aria-hidden>
              <Icon name="military_tech" filled size={72} />
            </span>
            <h3>{t.badges[badge].name}</h3>
            <p>{t.badges[badge].desc}</p>
            <button className="btn primary big" onClick={() => setBadgeQueue((q) => q.slice(1))}>
              {t.common.ok}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
