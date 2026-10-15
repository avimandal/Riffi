import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { t } from '../../i18n';
import { useApp } from '../../app/state';
import { Icon } from '../../components/Icon';
import { SevenSeg } from '../../components/SevenSeg';
import { prefersReducedMotion } from '../../components/motion';
import { resumeAudio } from '../../audio/context';
import { MicError } from '../../audio/mic';
import { useWakeLock } from '../../app/wakeLock';
import { METRONOME_SOUNDS } from '../../audio/sounds';
import { recordSession } from '../../data/repo';
import type { BadgeId } from '../../data/stats';
import { GadgetAudio, GadgetListener, GadgetMetronome } from '../../gadget/device';
import {
  beatsPerBar,
  clampTempo,
  formatClock,
  PRACTICE_TIMERS,
  SUBDIVISIONS,
  tapTempo,
  tempoName,
  TIME_SIGNATURES,
  type MetronomeSettings,
} from '../../gadget/metronomeCore';
import { DEFAULT_GADGET, loadGadget, makePreset, MAX_PRESETS, saveGadget, type GadgetState } from '../../gadget/storage';
import {
  clampRef,
  noteHz,
  TUNER_INSTRUMENTS,
  TUNER_RANGE,
  tunerReading,
  TunerSmoother,
  VIOLIN_STRINGS,
  type TunerReading,
  type ViolinString,
} from '../../gadget/tuner';
import type { Instrument } from '../../config';
import './gadget.css';

type Mode = 'metronome' | 'tuner';
type Led = 'off' | 'flat' | 'in' | 'sharp' | 'beat' | 'accent';

const MIN_COUNTED_MS = 5000;

const cycle = <T,>(list: readonly T[], current: T): T => list[(list.indexOf(current) + 1) % list.length];

function practiceRange(instrument: Instrument | undefined) {
  if (instrument === 'violin') return TUNER_RANGE.violin;
  if (instrument === 'voice') return TUNER_RANGE.voice;
  return TUNER_RANGE.chromatic;
}

/** A chunky device button that visibly presses in, with optional hold-to-repeat. */
function DeviceButton({
  label,
  caption,
  children,
  onPress,
  repeat,
  className,
  pressed,
  disabled,
  testId,
}: {
  label: string;
  caption?: string;
  children: ReactNode;
  onPress: () => void;
  repeat?: boolean;
  className?: string;
  pressed?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  const timers = useRef<number[]>([]);
  const [held, setHeld] = useState(false);
  const clear = () => {
    timers.current.forEach((x) => window.clearTimeout(x));
    timers.current = [];
    setHeld(false);
  };
  useEffect(() => clear, []);
  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || disabled) return;
    setHeld(true);
    if (!repeat) return;
    e.preventDefault();
    onPress();
    // Hold to repeat: wait, then speed up.
    let delay = 380;
    const again = () => {
      onPress();
      delay = Math.max(45, delay * 0.8);
      timers.current.push(window.setTimeout(again, delay));
    };
    timers.current.push(window.setTimeout(again, delay));
  };
  return (
    <div className={`g-btn-wrap ${className ?? ''}`}>
      <button
        type="button"
        className={`g-btn${held ? ' is-held' : ''}`}
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onPointerDown={down}
        onPointerUp={clear}
        onPointerLeave={clear}
        onPointerCancel={clear}
        onContextMenu={(e) => e.preventDefault()}
        // Repeating buttons fire on pointer down; the rest (and keyboard) on click.
        onClick={(e) => {
          if (repeat && e.detail > 0) return;
          onPress();
        }}
        data-testid={testId}
      >
        <span className="g-btn-face">{children}</span>
      </button>
      {caption && (
        <span className="g-btn-caption" aria-hidden>
          {caption}
        </span>
      )}
    </div>
  );
}

function Needle({ cents, active }: { cents: number; active: boolean }) {
  const clamped = Math.max(-50, Math.min(50, cents));
  const angle = (clamped / 50) * 45;
  return (
    <svg className="g-needle" viewBox="0 0 200 92" aria-hidden>
      <path d="M 29 86 A 100 100 0 0 1 171 86" className="g-arc" />
      {Array.from({ length: 11 }, (_, i) => {
        const a = ((i - 5) * 9 * Math.PI) / 180;
        const long = i === 5 || i === 0 || i === 10;
        const r1 = 100;
        const r2 = long ? 84 : 91;
        return (
          <line
            key={i}
            x1={100 + r1 * Math.sin(a)}
            y1={106 - r1 * Math.cos(a)}
            x2={100 + r2 * Math.sin(a)}
            y2={106 - r2 * Math.cos(a)}
            className={i === 5 ? 'g-tick g-tick-centre' : 'g-tick'}
          />
        );
      })}
      <text x="22" y="90" className="g-scale">♭</text>
      <text x="172" y="90" className="g-scale">♯</text>
      <g className={`g-needle-hand${active ? '' : ' idle'}`} style={{ transform: `rotate(${angle}deg)` }}>
        <line x1="100" y1="106" x2="100" y2="14" />
      </g>
      <circle cx="100" cy="106" r="7" className="g-hub" />
    </svg>
  );
}

export default function GadgetScreen() {
  const { profile, settings: device } = useApp();
  const [state, setState] = useState<GadgetState>(DEFAULT_GADGET);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<Mode>('metronome');
  const [running, setRunning] = useState(false);
  const [beat, setBeat] = useState(0);
  const [led, setLed] = useState<Led>('off');
  const [menuOpen, setMenuOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [playedMs, setPlayedMs] = useState(0);
  const [listening, setListening] = useState(false);
  // Keep the screen awake while the metronome clicks or the tuner listens (released when they stop).
  useWakeLock(running || listening);
  const [reading, setReading] = useState<TunerReading | null>(null);
  const [string, setString] = useState<ViolinString | null>(null);
  const [toneNote, setToneNote] = useState<string | null>(null);
  const [srText, setSrText] = useState('');

  const audio = useRef<GadgetAudio | null>(null);
  const metro = useRef<GadgetMetronome | null>(null);
  const listener = useRef<GadgetListener | null>(null);
  const ticks = useRef<{ when: number; beat: number; level: string }[]>([]);
  const settingsRef = useRef<MetronomeSettings>(state.metronome);
  settingsRef.current = state.metronome;
  const taps = useRef<number[]>([]);
  const runStart = useRef(0);
  const countingRef = useRef(false);
  const toneTimer = useRef<number | null>(null);
  const ledTimer = useRef<number | null>(null);

  // Load this kid's settings and presets.
  useEffect(() => {
    if (!profile) return;
    loadGadget(profile.id).then((s) => {
      setState(s);
      setLoaded(true);
    });
  }, [profile]);

  // Save changes (lightly debounced).
  useEffect(() => {
    if (!loaded || !profile) return;
    const id = window.setTimeout(() => void saveGadget(profile.id, state), 300);
    return () => window.clearTimeout(id);
  }, [state, loaded, profile]);

  useEffect(() => {
    if (audio.current) audio.current.volume = state.volume;
  }, [state.volume]);

  const update = (changes: Partial<GadgetState>) => setState((s) => ({ ...s, ...changes }));
  const updateMetro = (changes: Partial<MetronomeSettings>) => setState((s) => ({ ...s, metronome: { ...s.metronome, ...changes } }));

  const ensureAudio = useCallback(async () => {
    const ctx = await resumeAudio();
    if (!audio.current) {
      audio.current = new GadgetAudio(ctx);
      audio.current.volume = state.volume;
    }
    return audio.current;
  }, [state.volume]);

  const flash = (kind: Led) => {
    setLed(kind);
    if (ledTimer.current) window.clearTimeout(ledTimer.current);
    ledTimer.current = window.setTimeout(() => setLed('off'), 110);
  };

  // ---- Metronome -------------------------------------------------------

  const finishCounting = useCallback(async () => {
    if (!countingRef.current) return;
    countingRef.current = false;
    const played = listener.current?.stop() ?? 0;
    setListening(false);
    setPlayedMs(0);
    if (!profile) return;
    if (played < MIN_COUNTED_MS) {
      setMessage(t.gadget.countedNone);
      return;
    }
    const s = await recordSession({
      profileId: profile.id,
      pieceId: 'gadget',
      pieceTitle: t.gadget.sessionTitle,
      startedAt: runStart.current,
      instrument: profile.instrument,
      mode: 'metronome',
      difficulty: profile.difficulty,
      tempoBpm: settingsRef.current.bpm,
      activeMs: Math.round(played),
      durationMs: Date.now() - runStart.current,
      bars: [],
      marks: [],
    });
    const badge = s.newBadges?.[0] as BadgeId | undefined;
    setMessage(`${t.gadget.counted(formatClock(played))}${badge ? ` ${t.gadget.newBadge(t.badges[badge].name)}` : ''}`);
  }, [profile]);

  const stopMetronome = useCallback(async () => {
    metro.current?.stop();
    ticks.current = [];
    setRunning(false);
    setBeat(0);
    setLed('off');
    await finishCounting();
  }, [finishCounting]);

  const startMetronome = useCallback(async () => {
    setMessage(null);
    const a = await ensureAudio();
    if (!metro.current) metro.current = new GadgetMetronome(a, () => settingsRef.current);
    metro.current.onTick = (tick, soundMs) => {
      ticks.current.push({ when: tick.when, beat: tick.beat, level: tick.level });
      // The listener must never hear our own clicks.
      if (countingRef.current) listener.current?.maskClick(tick.when, soundMs);
    };
    runStart.current = Date.now();
    if (state.countPractice) {
      try {
        listener.current ??= new GadgetListener(a.ctx);
        await listener.current.start({ range: practiceRange(profile?.instrument), latencyMs: device.latencyMs, noiseFloor: device.noiseFloor });
        countingRef.current = true;
        setListening(true);
      } catch (e) {
        setMessage(e instanceof MicError && e.reason === 'denied' ? t.practice.micDenied : t.gadget.micNeeded);
      }
    }
    metro.current.start();
    setRunning(true);
    setRemainingMs(state.timerMinutes * 60_000);
  }, [ensureAudio, state.countPractice, state.timerMinutes, profile, device.latencyMs, device.noiseFloor]);

  // LEDs and beat counter follow the audio clock.
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    const frame = () => {
      const now = audio.current?.ctx.currentTime ?? 0;
      while (ticks.current.length && ticks.current[0].when <= now) {
        const tk = ticks.current.shift()!;
        if (tk.level !== 'sub') {
          setBeat(tk.beat + 1);
          flash(tk.level === 'accent' ? 'accent' : 'beat');
        }
      }
      if (countingRef.current) setPlayedMs(listener.current?.playedMs() ?? 0);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  // Practice timer: counts down while the metronome runs, then a gentle chime.
  useEffect(() => {
    if (!running || state.timerMinutes === 0) return;
    const endAt = Date.now() + state.timerMinutes * 60_000;
    const id = window.setInterval(() => {
      const left = endAt - Date.now();
      setRemainingMs(left);
      if (left <= 0) {
        window.clearInterval(id);
        void stopMetronome().then(() => {
          audio.current?.playChime();
          navigator.vibrate?.([200, 100, 200]);
          setMessage((m) => (m ? `${t.gadget.timesUp} ${m}` : t.gadget.timesUp));
        });
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [running, state.timerMinutes, stopMetronome]);

  const tap = () => {
    const now = performance.now();
    taps.current = [...taps.current.filter((x) => now - x < 8000), now];
    const bpm = tapTempo(taps.current);
    if (bpm) updateMetro({ bpm });
  };

  // ---- Tuner -----------------------------------------------------------

  const stopTone = useCallback(() => {
    audio.current?.stopTone();
    if (toneTimer.current) window.clearTimeout(toneTimer.current);
    toneTimer.current = null;
    setToneNote(null);
  }, []);

  const stopListening = useCallback(() => {
    listener.current?.stop();
    setListening(false);
    setReading(null);
    setLed('off');
  }, []);

  const startListening = useCallback(
    async (instrument = state.tunerInstrument) => {
      setMessage(null);
      const a = await ensureAudio();
      listener.current ??= new GadgetListener(a.ctx);
      try {
        // Tuner: the phone's voice processing (echo cancelling, noise suppression, auto gain) bends pitch, so it's all off,
        // unless the metronome is clicking (then echo cancelling stays on, and the clicks are masked as before).
        await listener.current.start({ range: TUNER_RANGE[instrument], latencyMs: device.latencyMs, noiseFloor: device.noiseFloor, rawMic: !metro.current?.running });
        setListening(true);
      } catch (e) {
        setListening(false);
        setMessage(e instanceof MicError && e.reason === 'denied' ? t.practice.micDenied : t.gadget.micNeeded);
      }
    },
    [ensureAudio, state.tunerInstrument, device.latencyMs, device.noiseFloor],
  );

  // Read the pitch; steady it (vibrato, overtone blips) and hold the last note briefly so it doesn't flicker.
  useEffect(() => {
    if (mode !== 'tuner' || !listening) return;
    let raf = 0;
    let lastUpdate = 0;
    let lastSr = 0;
    const smoother = new TunerSmoother();
    const frame = (now: number) => {
      const r = listener.current?.reading;
      const shown = smoother.push(r ? r.midi : null, now);
      if (now - lastUpdate > 50) {
        lastUpdate = now;
        if (shown !== null) {
          const rd = tunerReading(shown, state.refHz, state.tunerInstrument, string);
          setReading(rd);
          setLed(rd.status);
          if (now - lastSr > 1500) {
            lastSr = now;
            setSrText(t.gadget.tuner.status(`${rd.letter}${rd.sharp ? ' sharp' : ''}`, rd.cents, rd.status));
          }
        } else {
          setReading(null);
          setLed('off');
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [mode, listening, state.refHz, state.tunerInstrument, string]);

  const playTone = async () => {
    if (toneNote) {
      stopTone();
      return;
    }
    const a = await ensureAudio();
    const target = state.tunerInstrument === 'violin' ? VIOLIN_STRINGS.find((s) => s.name === (string ?? 'A'))!.midi : 69;
    const { start, end } = a.playTone(noteHz(target, state.refHz));
    // Never hear our own reference tone as the instrument.
    listener.current?.mute(start, end);
    const name = state.tunerInstrument === 'violin' ? (string ?? 'A') : 'A';
    setToneNote(name);
    toneTimer.current = window.setTimeout(() => setToneNote(null), (end - a.ctx.currentTime) * 1000);
  };

  // ---- Mode and lifecycle ------------------------------------------------

  const switchMode = async () => {
    if (mode === 'metronome') {
      await stopMetronome();
      setMenuOpen(false);
      setMode('tuner');
      await startListening();
    } else {
      stopTone();
      stopListening();
      setMode('metronome');
    }
  };

  // Leaving the screen: stop everything and save any counted practice.
  const finishRef = useRef(finishCounting);
  finishRef.current = finishCounting;
  useEffect(
    () => () => {
      metro.current?.stop();
      void finishRef.current();
      listener.current?.stop();
      audio.current?.dispose();
    },
    [],
  );

  // ---- Rendering ---------------------------------------------------------

  const m = state.metronome;
  const reduced = prefersReducedMotion();
  const ledFlat = led === 'flat' || led === 'beat';
  const ledGreen = led === 'in' || led === 'accent';
  const ledSharp = led === 'sharp' || led === 'beat';
  const ledState = [ledFlat && t.gadget.leds.flat, ledGreen && t.gadget.leds.inTune, ledSharp && t.gadget.leds.sharp].filter(Boolean).join(', ') || t.gadget.leds.off;
  const tunerName = reading ? `${reading.letter}${reading.sharp ? '♯' : ''}${reading.octave}` : '';

  return (
    <div className="page gadget-page">
      <div className="gadget-layout">
      <div className="gadget-col">
      <div className="topbar">
        <h1>{t.gadget.title}</h1>
      </div>

      <section className={`gadget mode-${mode}${reduced ? ' reduced' : ''}`} aria-label={t.gadget.deviceLabel}>
        <div className="g-top">
          <span className="g-vol-label" aria-hidden>
            VOL
          </span>
          <input
            className="g-vol"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={state.volume}
            aria-label={t.gadget.volume}
            onChange={(e) => update({ volume: Number(e.target.value) })}
          />
        </div>

        <div className="g-face">
          <div className="g-main">
            <div className="g-leds" role="img" aria-label={t.gadget.leds.label(ledState)}>
              <span className="g-led-wrap">
                <span className={`g-led red${ledFlat ? ' on' : ''}`} />
                <span className="g-led-label">♭</span>
              </span>
              <span className="g-led-wrap">
                <span className={`g-led green${ledGreen ? ' on' : ''}`} />
                <span className="g-led-label">●</span>
              </span>
              <span className="g-led-wrap">
                <span className={`g-led red${ledSharp ? ' on' : ''}`} />
                <span className="g-led-label">♯</span>
              </span>
            </div>

            <div className="g-lcd" data-testid="lcd">
              {mode === 'metronome' ? (
                <>
                  <div className="lcd-row lcd-top">
                    <span className="lcd-mode">{t.gadget.modeMetronome}</span>
                    {listening && <span className="lcd-rec">● {t.gadget.rec}</span>}
                    {state.timerMinutes > 0 && (
                      <span className="lcd-timer">
                        {t.gadget.timer} {formatClock(running ? remainingMs : state.timerMinutes * 60_000)}
                      </span>
                    )}
                  </div>
                  <div className="lcd-row lcd-big">
                    <SevenSeg text={String(m.bpm)} digits={3} className="lcd-digits" />
                    <span className="lcd-unit">{t.gadget.bpm}</span>
                  </div>
                  <div className="lcd-row lcd-info">
                    <span className="lcd-tempo" data-testid="tempo-name">
                      {tempoName(m.bpm)}
                    </span>
                    <span className="lcd-ts">{m.timeSignature}</span>
                  </div>
                  <div className="lcd-row lcd-bottom">
                    <span className="lcd-beat">
                      {t.gadget.beat}{' '}
                      <SevenSeg text={running ? String(beat) : '-'} digits={2} className="lcd-small-digits" />
                      <span className="lcd-of">/{beatsPerBar(m.timeSignature)}</span>
                    </span>
                    <span>{t.gadget.soundsLcd[m.sound]}</span>
                    {m.accent && (
                      <span className="lcd-accent" data-testid="lcd-accent" title={t.gadget.accentOnTitle} aria-label={t.gadget.accentOnTitle}>
                        <Icon name="counter_1" />
                      </span>
                    )}
                    {m.subdivision !== 'none' && <span>{{ eighths: '♪♪', triplets: '3', sixteenths: '♬♬' }[m.subdivision]}</span>}
                    {listening && <span className="lcd-played">{formatClock(playedMs)}</span>}
                  </div>
                </>
              ) : (
                <>
                  <div className="lcd-row lcd-top">
                    <span className="lcd-mode">{t.gadget.modeTuner}</span>
                    <span>{t.gadget.tunerInstrumentsLcd[state.tunerInstrument]}</span>
                    <span>{t.gadget.tuner.ref(state.refHz)}</span>
                  </div>
                  <div className="lcd-row lcd-note">
                    {toneNote ? (
                      <span className="lcd-msg">♪ {t.gadget.tuner.playing(toneNote)}</span>
                    ) : (
                      <span className="lcd-note-name" data-testid="tuner-note">
                        <SevenSeg text={reading ? reading.letter : '-'} digits={1} className="lcd-digits" />
                        <span className="lcd-acc">{reading?.sharp ? '♯' : ''}</span>
                        <span className="lcd-oct">{reading ? reading.octave : ''}</span>
                      </span>
                    )}
                  </div>
                  <Needle cents={reading?.cents ?? 0} active={!!reading && !toneNote} />
                  <div className="lcd-row lcd-bottom">
                    <span>
                      {reading && !toneNote ? `${reading.cents > 0 ? '+' : reading.cents < 0 ? '−' : '±'}${Math.min(99, Math.abs(reading.cents))}¢` : listening ? '' : t.gadget.tuner.noMic}
                    </span>
                    {reading?.string && <span>{reading.string}</span>}
                    {state.tunerInstrument === 'violin' && (
                      <span className="lcd-strings">
                        {VIOLIN_STRINGS.map((s) => (
                          <span key={s.name} className={string === s.name ? 'sel' : ''}>
                            {s.name}
                          </span>
                        ))}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>

            {mode === 'metronome' ? (
              <div className="g-buttons">
                <DeviceButton label={t.gadget.buttons.modeLabel(t.gadget.modeMetronome)} caption={t.gadget.buttons.mode} onPress={switchMode} className="g-mode" testId="mode">
                  <Icon name="tune" />
                </DeviceButton>
                <DeviceButton label={t.gadget.buttons.beatLabel(m.timeSignature)} caption={t.gadget.buttons.beat} onPress={() => updateMetro({ timeSignature: cycle(TIME_SIGNATURES, m.timeSignature) })}>
                  {m.timeSignature}
                </DeviceButton>
                <DeviceButton label={t.gadget.buttons.soundLabel(t.gadget.sounds[m.sound])} caption={t.gadget.buttons.sound} onPress={() => updateMetro({ sound: cycle(METRONOME_SOUNDS, m.sound) })}>
                  <Icon name="music_note" />
                </DeviceButton>
                <DeviceButton label={t.gadget.buttons.menuLabel} caption={t.gadget.buttons.menu} onPress={() => setMenuOpen((o) => !o)} pressed={menuOpen} testId="menu">
                  <Icon name="menu" />
                </DeviceButton>
                <DeviceButton label={t.gadget.buttons.slower} caption={t.gadget.buttons.slowerCaption} repeat onPress={() => updateMetro({ bpm: clampTempo(settingsRef.current.bpm - 1) })} testId="tempo-down">
                  <Icon name="remove" />
                </DeviceButton>
                <DeviceButton label={t.gadget.buttons.tapLabel} onPress={tap}>
                  {t.gadget.buttons.tap.toUpperCase()}
                </DeviceButton>
                <DeviceButton label={t.gadget.buttons.faster} caption={t.gadget.buttons.fasterCaption} repeat onPress={() => updateMetro({ bpm: clampTempo(settingsRef.current.bpm + 1) })} testId="tempo-up">
                  <Icon name="add" />
                </DeviceButton>
                <DeviceButton
                  label={t.gadget.buttons.accentLabel(m.accent)}
                  caption={t.gadget.buttons.accent}
                  onPress={() => updateMetro({ accent: !settingsRef.current.accent })}
                  pressed={m.accent}
                  testId="accent"
                >
                  <span className="g-accent-mark" aria-hidden>
                    <Icon name="counter_1" filled={m.accent} />
                  </span>
                </DeviceButton>
                <DeviceButton
                  label={running ? t.gadget.buttons.stop : t.gadget.buttons.start}
                  onPress={() => (running ? void stopMetronome() : void startMetronome())}
                  className="g-start"
                  pressed={running}
                  testId="metronome-start"
                >
                  <Icon name={running ? 'stop' : 'play_arrow'} filled /> {running ? t.gadget.buttons.stop : t.gadget.buttons.start}
                </DeviceButton>
              </div>
            ) : (
              <div className="g-buttons">
                <DeviceButton label={t.gadget.buttons.modeLabel(t.gadget.modeTuner)} caption={t.gadget.buttons.mode} onPress={switchMode} className="g-mode" testId="mode">
                  <Icon name="av_timer" />
                </DeviceButton>
                <DeviceButton
                  label={t.gadget.buttons.instrumentLabel(t.gadget.tunerInstruments[state.tunerInstrument])}
                  caption={t.gadget.buttons.instrument}
                  onPress={() => {
                    const next = cycle(TUNER_INSTRUMENTS, state.tunerInstrument);
                    update({ tunerInstrument: next });
                    setString(null);
                    if (listening) void startListening(next);
                  }}
                >
                  <Icon name={state.tunerInstrument === 'voice' ? 'mic' : state.tunerInstrument === 'violin' ? 'music_note' : 'piano'} />
                </DeviceButton>
                <DeviceButton label={t.gadget.buttons.refLabel(state.refHz, t.gadget.buttons.lower)} caption={t.gadget.buttons.refDown} onPress={() => update({ refHz: clampRef(state.refHz - 1) })}>
                  <Icon name="remove" />
                </DeviceButton>
                <DeviceButton label={t.gadget.buttons.refLabel(state.refHz, t.gadget.buttons.higher)} caption={t.gadget.buttons.refUp} onPress={() => update({ refHz: clampRef(state.refHz + 1) })}>
                  <Icon name="add" />
                </DeviceButton>
                {state.tunerInstrument === 'violin' &&
                  VIOLIN_STRINGS.map((s) => (
                    <DeviceButton key={s.name} label={t.gadget.buttons.string(s.name)} caption={t.gadget.buttons.stringCaption} pressed={string === s.name} onPress={() => setString((cur) => (cur === s.name ? null : s.name))}>
                      {s.name}
                    </DeviceButton>
                  ))}
                <DeviceButton
                  label={toneNote ? t.gadget.buttons.toneStop : t.gadget.buttons.toneLabel(state.tunerInstrument === 'violin' ? (string ?? 'A') : 'A')}
                  caption={t.gadget.buttons.tone}
                  onPress={() => void playTone()}
                  pressed={!!toneNote}
                  className="g-wide"
                  testId="tone"
                >
                  <Icon name="volume_up" />
                </DeviceButton>
                <DeviceButton
                  label={listening ? t.gadget.buttons.stopListening : t.gadget.buttons.listen}
                  onPress={() => (listening ? stopListening() : void startListening())}
                  className="g-start"
                  pressed={listening}
                  testId="tuner-listen"
                >
                  <Icon name={listening ? 'stop' : 'mic'} filled /> {listening ? t.gadget.buttons.stopListening : t.gadget.buttons.listen}
                </DeviceButton>
              </div>
            )}
          </div>
          <div className="g-grille" aria-hidden>
            {Array.from({ length: 36 }, (_, i) => (
              <span key={i} />
            ))}
          </div>
        </div>
        <div className="g-brand" aria-hidden>
          {t.gadget.brand}
        </div>
      </section>

      <p className="sr-only" aria-live="polite">
        {mode === 'metronome' ? `${m.bpm} ${t.gadget.bpm}, ${tempoName(m.bpm)}, ${m.timeSignature}, ${t.gadget.sounds[m.sound]}` : srText}
      </p>
      {mode === 'tuner' && reading && !toneNote && (
        <p className={`g-hint ${reading.status}`} aria-hidden>
          {tunerName} · {t.gadget.tuner.hint[reading.status]}
        </p>
      )}
      {mode === 'tuner' && listening && !reading && !toneNote && <p className="g-hint">{t.gadget.tuner.listening}</p>}
      {message && (
        <p className="notice good g-message" role="status">
          <Icon name="favorite" filled /> {message}
        </p>
      )}

      </div>
      {menuOpen && mode === 'metronome' && (
        <section className="card g-menu" aria-label={t.gadget.menu.title}>
          <h2>{t.gadget.menu.title}</h2>
          <label className="g-switch">
            <input type="checkbox" checked={m.accent} onChange={(e) => updateMetro({ accent: e.target.checked })} />
            <span>{t.gadget.menu.accent}</span>
          </label>
          <fieldset className="control-group">
            <legend>{t.gadget.menu.subdivision}</legend>
            <div className="segmented">
              {SUBDIVISIONS.map((sd) => (
                <button key={sd} className="btn" aria-pressed={m.subdivision === sd} onClick={() => updateMetro({ subdivision: sd })}>
                  {t.gadget.subdivisions[sd]}
                </button>
              ))}
            </div>
          </fieldset>
          <fieldset className="control-group" disabled={running}>
            <legend>{t.gadget.menu.timer}</legend>
            <div className="segmented">
              {PRACTICE_TIMERS.map((n) => (
                <button key={n} className="btn" aria-pressed={state.timerMinutes === n} onClick={() => update({ timerMinutes: n })}>
                  {n === 0 ? t.gadget.menu.timerOff : t.gadget.menu.timerMinutes(n)}
                </button>
              ))}
            </div>
          </fieldset>
          <label className="g-switch">
            <input type="checkbox" checked={state.countPractice} disabled={running} onChange={(e) => update({ countPractice: e.target.checked })} data-testid="count-practice" />
            <span>{t.gadget.menu.count}</span>
          </label>
          <p className="muted small">{t.gadget.menu.countHelp}</p>

          <h3>{t.gadget.menu.presets}</h3>
          {state.presets.length === 0 && <p className="muted small">{t.gadget.menu.presetsEmpty}</p>}
          <ul className="g-presets" role="list">
            {state.presets.map((p) => (
              <li key={p.id}>
                <span>{p.name}</span>
                <button className="btn" onClick={() => update({ metronome: { ...p.settings } })}>
                  {t.gadget.menu.load}
                </button>
                <button className="btn danger icon-only" aria-label={`${t.gadget.menu.remove}: ${p.name}`} onClick={() => update({ presets: state.presets.filter((x) => x.id !== p.id) })}>
                  <Icon name="delete" />
                </button>
              </li>
            ))}
          </ul>
          <button
            className="btn primary"
            onClick={() => {
              if (state.presets.length >= MAX_PRESETS) {
                setMessage(t.gadget.menu.presetsFull);
                return;
              }
              const name = t.gadget.menu.presetName(m.bpm, m.timeSignature, t.gadget.sounds[m.sound]);
              update({ presets: [...state.presets, makePreset(name, m)] });
            }}
          >
            <Icon name="add" /> {t.gadget.menu.savePreset}
          </button>
          <button className="btn ghost" onClick={() => setMenuOpen(false)} style={{ marginLeft: 8 }}>
            {t.gadget.menu.close}
          </button>
        </section>
      )}
      </div>
    </div>
  );
}
