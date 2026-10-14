import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DIFFICULTIES, INSTRUMENTS, TEMPO_MAX, TEMPO_MIN, type Difficulty, type MetronomeMode, type PracticeMode } from '../../config';
import { t } from '../../i18n';
import { useApp } from '../../app/state';
import { useKidInstrument } from '../../app/useKidInstrument';
import { navigate } from '../../app/router';
import { Icon } from '../../components/Icon';
import { INSTRUMENT_ICON } from '../../components/instrumentIcons';
import { Meter } from '../../components/Meter';
import { Modal } from '../../components/Modal';
import { PieceMenu } from '../../components/PieceMenu';
import { PulseDot } from '../../components/PulseDot';
import { SheetView, type SheetHandle } from '../../components/SheetView';
import { SoundCheck } from '../../components/SoundCheck';
import { canVibrate } from '../../audio/metronome';
import { MicError } from '../../audio/mic';
import { getPiece, recordSession, setPlayRepeats } from '../../data/repo';
import type { Piece, StoredNoteMark } from '../../data/types';
import { findIssues } from '../../scoring/feedback';
import { defaultBpm, hasRepeats } from '../../sheet/expected';
import { noteName, parseMusicXml } from '../../sheet/musicxml';
import { PracticeRun, pianoReady, type RunOutcome, type RunState } from './runner';

type UiState = RunState | 'loadingPiano';

function clampTempo(n: number) {
  return Math.max(TEMPO_MIN, Math.min(TEMPO_MAX, Math.round(n)));
}

export default function PracticeScreen({ id, query }: { id: string; query: URLSearchParams }) {
  const { profile, settings, updateSettings } = useApp();
  const [piece, setPiece] = useState<Piece | null | undefined>(undefined);
  const score = useMemo(() => (piece ? safeParse(piece.musicxml) : null), [piece]);

  const [instrument, setInstrument] = useKidInstrument();
  const [difficulty, setDifficulty] = useState<Difficulty>(profile?.difficulty ?? 'normal');
  const [mode, setMode] = useState<PracticeMode>(query.get('mode') === 'learn' ? 'learn' : 'playalong');
  const [bpm, setBpm] = useState<number | null>(null);
  const [metro, setMetro] = useState<MetronomeMode>(settings.metronomeMode);
  const [loop, setLoop] = useState<{ from: number; to: number } | null>(null);
  const [playRepeats, setPlayRepeatsState] = useState(false);
  const [zoom, setZoom] = useState(() => (typeof window !== 'undefined' && window.innerWidth < 600 ? 0.8 : 1));
  const [ui, setUi] = useState<UiState>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [analysePct, setAnalysePct] = useState(0);
  const [learnPos, setLearnPos] = useState(0);
  const [showInstrument, setShowInstrument] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [showFirstRun, setShowFirstRun] = useState(false);
  const [level, setLevel] = useState(0);
  const sheet = useRef<SheetHandle>(null);
  const run = useRef<PracticeRun | null>(null);
  const startedAt = useRef(0);
  const stopping = useRef(false);

  useEffect(() => {
    getPiece(id).then((p) => {
      setPiece(p ?? null);
      setPlayRepeatsState(p?.playRepeats ?? false);
    });
  }, [id]);

  const togglePlayRepeats = (on: boolean) => {
    setPlayRepeatsState(on);
    if (piece) void setPlayRepeats(piece.id, on);
  };

  // Defaults from the music and from a "Fix it" link.
  useEffect(() => {
    if (!score) return;
    const base = defaultBpm(score);
    const q = Number(query.get('bpm'));
    setBpm(q > 0 ? clampTempo(q) : base);
    const from = query.get('from');
    const to = query.get('to');
    if (from !== null && to !== null) {
      const max = score.measures.length - 1;
      setLoop({ from: Math.max(0, Math.min(max, Number(from))), to: Math.max(0, Math.min(max, Number(to))) });
    }
    // Only when the music loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [score]);

  useEffect(() => setMetro(settings.metronomeMode), [settings.metronomeMode]);

  // Level meter, driven by animation frames while running.
  useEffect(() => {
    if (ui !== 'running' && ui !== 'countin') return;
    let raf = 0;
    const frame = () => {
      setLevel(run.current?.level ?? 0);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [ui]);

  // Keep the screen awake while practising.
  useEffect(() => {
    if (ui !== 'running' && ui !== 'countin') return;
    let lock: { release: () => Promise<void> } | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    nav.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => undefined);
    return () => {
      void lock?.release().catch(() => undefined);
    };
  }, [ui]);

  useEffect(() => () => run.current?.dispose(), []);

  const expectedForUi = run.current?.expected;

  const finish = useCallback(
    async (outcome: RunOutcome) => {
      if (!profile || !piece) return;
      if (outcome.events.length === 0) {
        setNotice(t.practice.nothingHeard);
        setUi('idle');
        sheet.current?.setCursor(null);
        return;
      }
      const marks: StoredNoteMark[] = [];
      if (outcome.score) {
        // Only mark notes up to where they got: unreached notes aren't "missed".
        const reached = Math.round(outcome.score.completion * outcome.score.notes.length);
        for (const n of outcome.score.notes.slice(0, reached)) marks.push({ refs: n.refs, pitch: n.pitch, timing: n.timing });
      } else if (outcome.learn) {
        outcome.expected.forEach((e, i) => marks.push({ refs: e.refs, pitch: i < outcome.learn!.reached ? 'correct' : 'missed', timing: 'good' }));
      }
      const maxIndex = score ? score.measures.length - 1 : 0;
      const issues = outcome.score ? findIssues(outcome.score, maxIndex, instrument) : [];
      const s = await recordSession({
        issues,
        profileId: profile.id,
        pieceId: piece.id,
        pieceTitle: piece.title,
        startedAt: startedAt.current,
        instrument,
        mode,
        difficulty,
        tempoBpm: bpm ?? 80,
        loop: loop ? { fromIndex: loop.from, toIndex: loop.to } : undefined,
        activeMs: outcome.activeMs,
        durationMs: Math.round(outcome.durationMs),
        score: outcome.score?.score,
        stars: outcome.score?.stars,
        pitchAccuracy: outcome.score?.pitchAccuracy,
        rhythmAccuracy: outcome.score?.rhythmAccuracy,
        completion: outcome.score?.completion ?? outcome.learn?.completion,
        learnAccuracy: outcome.learn?.accuracy,
        bars: (outcome.score?.bars ?? []).map((b) => ({
          measureIndex: b.measureIndex,
          playIndex: b.playIndex,
          bar: b.bar,
          pitchAccuracy: b.pitchAccuracy,
          rhythmAccuracy: b.rhythmAccuracy,
          perfect: b.perfect,
          missed: b.missed,
        })),
        marks,
        playThenScore: outcome.playThenScore,
      });
      navigate(`/results/${s.id}`);
    },
    [profile, piece, score, instrument, mode, difficulty, bpm, loop],
  );

  const stop = useCallback(async () => {
    const r = run.current;
    if (!r || stopping.current) return;
    stopping.current = true;
    try {
      const outcome = await r.stop();
      run.current = null;
      await finish(outcome);
    } catch {
      setNotice(t.errors.generic);
      setUi('idle');
    } finally {
      stopping.current = false;
    }
  }, [finish]);

  const start = useCallback(async () => {
    if (!score || !bpm) return;
    if (!settings.firstRunDone && settings.latencyMs === undefined && !showFirstRun) {
      setShowFirstRun(true);
      return;
    }
    setNotice(null);
    const r = new PracticeRun(
      {
        score,
        instrument,
        difficulty,
        mode,
        bpm,
        loop: loop ? { fromIndex: loop.from, toIndex: loop.to } : undefined,
        playRepeats,
        metronomeMode: metro,
        metronomeVolume: settings.metronomeVolume,
        latencyMs: settings.latencyMs,
        noiseFloor: settings.noiseFloor,
        pianoPreferred: settings.pianoMode,
      },
      {
        onState: (s) => setUi(s),
        onPosition: (i) => {
          const r2 = run.current;
          if (!r2) return;
          const exp = r2.expected[Math.max(0, Math.min(r2.expected.length - 1, i))];
          sheet.current?.setCursor(exp ? exp.refs[0] : null);
          if (mode === 'learn') setLearnPos(i);
        },
        onPianoStatus: (s) => {
          if (s.mode === 'playThenScore') setNotice(s.fellBehind ? t.practice.pianoFellBehind : t.practice.pianoPlayThenScore);
        },
        onAnalyseProgress: (f) => setAnalysePct(Math.round(f * 100)),
        onAutoStop: () => void stop(),
      },
    );
    if (r.expected.length === 0) {
      setNotice(t.practice.noNotes);
      return;
    }
    run.current = r;
    try {
      if (instrument === 'piano' && !pianoReady()) setUi('loadingPiano');
      await r.prepare();
      startedAt.current = Date.now();
      setLearnPos(0);
      r.start();
    } catch (e) {
      run.current = null;
      r.dispose();
      setUi('idle');
      if (e instanceof MicError) {
        setNotice(
          e.reason === 'denied' ? t.practice.micDenied : e.reason === 'notfound' ? t.practice.micMissing : e.reason === 'insecure' ? t.practice.micInsecure : t.practice.micNeeded,
        );
      } else setNotice(t.errors.generic);
    }
  }, [score, bpm, settings, showFirstRun, instrument, difficulty, mode, loop, playRepeats, metro, stop]);

  const active = ui === 'running' || ui === 'countin';
  const busy = ui === 'preparing' || ui === 'loadingPiano' || ui === 'analysing';

  // Space bar starts/stops.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || (e.target as HTMLElement)?.closest('input, select, textarea, button')) return;
      e.preventDefault();
      if (active) void stop();
      else if (!busy) void start();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, busy, start, stop]);

  if (piece === null) {
    return (
      <div className="page">
        <p className="notice">{t.review.notFound}</p>
        <button className="btn primary" onClick={() => navigate('/home')}>
          {t.errors.goHome}
        </button>
      </div>
    );
  }
  if (!piece || !score || bpm === null) return <div className="page" aria-busy="true" />;

  const measures = score.measures;
  const learnTarget = mode === 'learn' && active ? expectedForUi?.[learnPos] : undefined;

  return (
    <div className={`practice-screen${active ? ' is-active' : ''}`}>
      <header className="practice-top">
        <button className="btn icon-only round ghost" aria-label={t.common.back} onClick={() => (active ? void stop() : navigate('/home'))} disabled={busy}>
          <Icon name="arrow_back" />
        </button>
        <h1 className="practice-title">{piece.title}</h1>
        <button className="chip chip-btn" onClick={() => setShowInstrument(true)} disabled={active || busy} aria-label={`${t.practice.instrumentChip(t.instruments[instrument])}. ${t.practice.changeInstrument}`}>
          <Icon name={INSTRUMENT_ICON[instrument]} filled /> {t.instruments[instrument]}
        </button>
        <div className="row zoom-btns">
          <button className="btn icon-only round ghost" aria-label={t.practice.zoomOut} onClick={() => setZoom((z) => Math.max(0.6, z - 0.15))}>
            <Icon name="zoom_out" />
          </button>
          <button className="btn icon-only round ghost" aria-label={t.practice.zoomIn} onClick={() => setZoom((z) => Math.min(2, z + 0.15))}>
            <Icon name="zoom_in" />
          </button>
          <button className="btn icon-only round ghost" aria-label={t.home.moreFor(piece.title)} onClick={() => setShowMenu(true)} disabled={active || busy} data-testid="practice-more">
            <Icon name="more_horiz" />
          </button>
        </div>
      </header>

      <div className="practice-main">
        <SheetView ref={sheet} xml={piece.musicxml} score={score} zoom={zoom} label={t.practice.sheetLabel} className="practice-sheet" />

        <aside className="practice-controls" aria-label={t.practice.title}>
          {notice && (
            <p className="notice warn" role="status">
              <Icon name="info" /> {notice}
            </p>
          )}
          {ui === 'loadingPiano' && (
            <div className="notice" role="status">
              <span className="spinner small" aria-hidden />
              <div>
                <strong>{t.practice.pianoLoading}</strong>
                <div className="muted">{t.practice.pianoLoadingNote}</div>
              </div>
            </div>
          )}
          {ui === 'analysing' && (
            <div className="notice" role="status">
              <span className="spinner small" aria-hidden /> {t.practice.analysing(analysePct)}
            </div>
          )}

          <div className="start-row">
            {mode === 'playalong' && run.current && active && <PulseDot beatTimes={run.current.beatTimes} now={run.current.now} countInLabel={t.practice.countInBeat} />}
            <button
              className={`start-btn${active ? ' stop' : ''}`}
              onClick={() => (active ? void stop() : void start())}
              disabled={busy}
              aria-label={active ? t.practice.stop : t.practice.start}
              data-testid="start-stop"
            >
              <Icon name={active ? 'stop' : 'play_arrow'} filled size={48} />
              <span>{active ? t.practice.stop : t.practice.start}</span>
            </button>
          </div>
          {ui === 'countin' && <p className="countin" aria-live="assertive">{t.practice.countIn}</p>}
          {active && <Meter level={level} active={active} />}
          {learnTarget && (
            <p className="learn-prompt" aria-live="polite">
              {t.practice.learnWaiting(learnTarget.pitches.map((p) => noteName(p, learnTarget.fifths)).join(' + '))}
              <span className="muted"> · {t.practice.learnProgress(learnPos, expectedForUi?.length ?? 0)}</span>
            </p>
          )}

          <fieldset className="control-group" disabled={active || busy}>
            <legend>{t.practice.mode}</legend>
            <div className="segmented">
              <button className="btn" aria-pressed={mode === 'playalong'} onClick={() => setMode('playalong')}>
                <Icon name="timer" /> {t.practice.playAlong}
              </button>
              <button className="btn" aria-pressed={mode === 'learn'} onClick={() => setMode('learn')}>
                <Icon name="school" /> {t.practice.learn}
              </button>
            </div>
            <p className="muted small">{mode === 'learn' ? t.practice.learnHelp : t.practice.playAlongHelp}</p>
          </fieldset>

          {mode === 'playalong' && (
            <fieldset className="control-group" disabled={active || busy}>
              <legend>{t.practice.tempo}</legend>
              <div className="tempo">
                <button className="btn icon-only round" aria-label={t.practice.slower} onClick={() => setBpm((b) => clampTempo((b ?? 80) - 4))}>
                  <Icon name="remove" />
                </button>
                <label className="tempo-value">
                  <span className="sr-only">{t.practice.tempo}</span>
                  <input
                    type="number"
                    min={TEMPO_MIN}
                    max={TEMPO_MAX}
                    value={bpm}
                    onChange={(e) => setBpm(Number(e.target.value) || TEMPO_MIN)}
                    onBlur={() => setBpm((b) => clampTempo(b ?? 80))}
                  />
                  <span aria-hidden>{t.practice.bpmShort}</span>
                </label>
                <button className="btn icon-only round" aria-label={t.practice.faster} onClick={() => setBpm((b) => clampTempo((b ?? 80) + 4))}>
                  <Icon name="add" />
                </button>
              </div>
            </fieldset>
          )}

          {mode === 'playalong' && (
            <fieldset className="control-group" disabled={active || busy}>
              <legend>{t.practice.metronome}</legend>
              <div className="segmented">
                <button className="btn" aria-pressed={metro === 'sound'} onClick={() => setMetro('sound')}>
                  <Icon name="volume_up" /> {t.practice.metronomeSound}
                </button>
                <button className="btn" aria-pressed={metro === 'visual'} onClick={() => setMetro('visual')}>
                  <Icon name="visibility" /> {t.practice.metronomeVisual}
                </button>
                {canVibrate() && (
                  <button className="btn" aria-pressed={metro === 'vibrate'} onClick={() => setMetro('vibrate')}>
                    <Icon name="vibration" /> {t.practice.metronomeVibrate}
                  </button>
                )}
              </div>
              {metro === 'sound' && <p className="muted small">{t.practice.headphonesTip}</p>}
            </fieldset>
          )}

          <fieldset className="control-group" disabled={active || busy}>
            <legend>{t.difficulty.label}</legend>
            <div className="segmented">
              {DIFFICULTIES.map((d) => (
                <button key={d} className="btn" aria-pressed={difficulty === d} onClick={() => setDifficulty(d)}>
                  {t.difficulty[d]}
                </button>
              ))}
            </div>
          </fieldset>

          {hasRepeats(measures) && (
            <fieldset className="control-group" disabled={active || busy}>
              <legend>{t.practice.repeats}</legend>
              <label className="row" style={{ gap: 8 }}>
                <input type="checkbox" role="switch" checked={playRepeats} onChange={(e) => togglePlayRepeats(e.target.checked)} data-testid="play-repeats" />
                <span>{t.practice.playRepeats}</span>
              </label>
              {!playRepeats && <p className="muted small">{t.practice.repeatsHelp}</p>}
            </fieldset>
          )}

          <fieldset className="control-group" disabled={active || busy}>
            <legend>{t.practice.loop}</legend>
            <div className="row">
              <button className="btn" aria-pressed={!loop} onClick={() => setLoop(null)}>
                {t.practice.loopOff}
              </button>
              <label className="row" style={{ gap: 6 }}>
                <span>{t.practice.loopFrom}</span>
                <select
                  value={loop?.from ?? ''}
                  onChange={(e) => {
                    const from = Number(e.target.value);
                    setLoop((l) => ({ from, to: Math.max(from, l?.to ?? Math.min(measures.length - 1, from + 2)) }));
                  }}
                >
                  {!loop && <option value="">–</option>}
                  {measures.map((m) => (
                    <option key={m.index} value={m.index}>
                      {m.number}
                    </option>
                  ))}
                </select>
              </label>
              <label className="row" style={{ gap: 6 }}>
                <span>{t.practice.loopTo}</span>
                <select
                  value={loop?.to ?? ''}
                  onChange={(e) => {
                    const to = Number(e.target.value);
                    setLoop((l) => ({ from: Math.min(to, l?.from ?? Math.max(0, to - 2)), to }));
                  }}
                >
                  {!loop && <option value="">–</option>}
                  {measures.map((m) => (
                    <option key={m.index} value={m.index}>
                      {m.number}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </fieldset>
        </aside>
      </div>

      {showMenu && <PieceMenu piece={piece} from="practice" onClose={() => setShowMenu(false)} />}
      {showInstrument && (
        <Modal title={t.practice.changeInstrument} onClose={() => setShowInstrument(false)}>
          <div className="stack">
            {INSTRUMENTS.map((i) => (
              <button
                key={i}
                className="btn big"
                aria-pressed={instrument === i}
                onClick={() => {
                  setInstrument(i);
                  setShowInstrument(false);
                }}
              >
                <Icon name={INSTRUMENT_ICON[i]} /> {t.instruments[i]}
              </button>
            ))}
          </div>
        </Modal>
      )}

      {showFirstRun && (
        <Modal title={t.practice.firstRunTitle} onClose={() => setShowFirstRun(false)}>
          <p>{t.practice.firstRunBody}</p>
          <SoundCheck compact onDone={() => setShowFirstRun(false)} />
          <button
            className="btn ghost"
            style={{ marginTop: 12 }}
            onClick={() => {
              setShowFirstRun(false);
              void updateSettings({ firstRunDone: true });
              void start();
            }}
          >
            {t.practice.firstRunSkip}
          </button>
        </Modal>
      )}
    </div>
  );
}

function safeParse(xml: string) {
  try {
    return parseMusicXml(xml);
  } catch {
    return null;
  }
}
