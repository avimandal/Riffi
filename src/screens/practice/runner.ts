import type { Difficulty, Instrument, MetronomeMode, PracticeMode } from '../../config';
import { buildBeatGrid, countInMs, type Beat } from '../../audio/beats';
import { resumeAudio, estimatedLatencyMs } from '../../audio/context';
import { Metronome } from '../../audio/metronome';
import { MicInput } from '../../audio/mic';
import { activePlayingMs } from '../../data/stats';
import { MonoEngine } from '../../engines/mono/monoEngine';
import { PianoEngine, type PianoMode, type PianoEngineStatus } from '../../engines/piano/pianoEngine';
import type { ListeningEngine, NoteEvent } from '../../engines/types';
import { groupIntoChords, LearnFollower, ScoreFollower } from '../../follow/follower';
import { RunEnd } from '../../follow/runEnd';
import { SCORING, pitchTolerance } from '../../scoring/config';
import { scoreRun, type RunScore } from '../../scoring/score';
import { buildExpectedNotes, type ExpectedNote, type LoopRange, type Timeline } from '../../sheet/expected';
import type { ParsedScore } from '../../sheet/musicxml';

export interface RunConfig {
  score: ParsedScore;
  instrument: Instrument;
  difficulty: Difficulty;
  mode: PracticeMode;
  bpm: number;
  loop?: LoopRange;
  /** Follow repeat signs; off = every bar once. */
  playRepeats?: boolean;
  metronomeMode: MetronomeMode;
  metronomeVolume: number;
  latencyMs?: number;
  noiseFloor?: number;
  pianoPreferred: 'auto' | PianoMode;
}

/** The piano model is loaded once per visit ("Getting the piano ears ready" only shows the first time). */
let cachedPiano: { engine: PianoEngine; key: string } | null = null;

export function pianoReady(): boolean {
  return cachedPiano !== null;
}

export type RunState = 'idle' | 'preparing' | 'countin' | 'running' | 'analysing' | 'done';

export interface RunOutcome {
  events: NoteEvent[];
  expected: ExpectedNote[];
  timeline: Timeline;
  score?: RunScore;
  learn?: { accuracy: number; completion: number; reached: number };
  activeMs: number;
  durationMs: number;
  playThenScore: boolean;
}

export interface RunCallbacks {
  onState?: (s: RunState) => void;
  /** Expected-note index the player is at. */
  onPosition?: (index: number) => void;
  onPianoStatus?: (s: PianoEngineStatus) => void;
  onAnalyseProgress?: (fraction: number) => void;
  /** Called when the run ends by itself (last bar played, long silence at the end, or every note found). */
  onAutoStop?: () => void;
}

/**
 * One practice run: shared audio clock for metronome and mic, the right
 * listening engine, live following for the cursor, and scoring at the end.
 */
export class PracticeRun {
  readonly expected: ExpectedNote[];
  readonly timeline: Timeline;
  readonly beats: Beat[];
  private ctx: AudioContext | null = null;
  private mic: MicInput | null = null;
  private metronome: Metronome | null = null;
  private engine: ListeningEngine | null = null;
  private piano: PianoEngine | null = null;
  private follower: ScoreFollower | null = null;
  private learn: LearnFollower | null = null;
  private fedNotes = 0;
  private fedKeys = new Set<string>();
  private startAt = 0;
  private startedWall = 0;
  private offFrames: (() => void) | null = null;
  private runEnd: RunEnd | null = null;
  private autoStopped = false;
  private state: RunState = 'idle';
  private lastAudioMs = -Infinity;
  /** Last time the input was loud (for engines that only report notes at the end). */
  private lastLoudMs = -Infinity;

  constructor(
    private readonly cfg: RunConfig,
    private readonly cb: RunCallbacks = {},
  ) {
    const built = buildExpectedNotes(cfg.score, { instrument: cfg.instrument, bpm: cfg.bpm, loop: cfg.loop, playRepeats: cfg.playRepeats ?? false });
    this.expected = built.notes;
    this.timeline = built.timeline;
    this.beats = cfg.mode === 'playalong' ? buildBeatGrid(this.timeline) : [];
  }

  private setState(s: RunState) {
    this.state = s;
    this.cb.onState?.(s);
  }

  get level(): number {
    return this.engine?.level ?? 0;
  }

  /** Audio-clock time now (s), for the visual metronome. */
  now = (): number => this.ctx?.currentTime ?? 0;

  /** Beat times on the audio clock, for the visual metronome. */
  beatTimes = (): { at: number; accent: boolean; countIn: boolean; n: number }[] =>
    this.beats.map((b) => ({ at: this.startAt + b.timeMs / 1000, accent: b.accent, countIn: b.countIn, n: b.beat }));

  get pianoMode(): PianoMode | undefined {
    return this.piano?.mode;
  }

  /** Ask for the mic and load the engine. Must follow a tap (audio unlock). */
  async prepare(): Promise<void> {
    this.setState('preparing');
    this.ctx = await resumeAudio();
    const latencyMs = this.cfg.latencyMs ?? estimatedLatencyMs(this.ctx);
    this.mic = new MicInput(this.ctx);
    await this.mic.start();
    if (this.cfg.instrument === 'piano') {
      const key = `${this.ctx.sampleRate}:${latencyMs}:${this.cfg.pianoPreferred}`;
      if (!cachedPiano || cachedPiano.key !== key) {
        cachedPiano?.engine.dispose();
        cachedPiano = null;
        cachedPiano = {
          key,
          engine: await PianoEngine.create({ sampleRate: this.ctx.sampleRate, latencyMs, preferred: this.cfg.pianoPreferred }),
        };
      }
      this.piano = cachedPiano.engine;
      this.piano.onStatus = (s) => this.cb.onPianoStatus?.(s);
      this.piano.onProgress = (f) => this.cb.onAnalyseProgress?.(f);
      this.cb.onPianoStatus?.({ mode: this.piano.mode, backend: this.piano.backend });
      this.engine = this.piano;
    } else {
      this.engine = new MonoEngine({
        instrument: this.cfg.instrument,
        sampleRate: this.ctx.sampleRate,
        latencyMs,
        noiseFloor: this.cfg.noiseFloor,
      });
    }
  }

  start() {
    if (!this.ctx || !this.mic || !this.engine) throw new Error('Run not prepared');
    const ctx = this.ctx;
    const playAlong = this.cfg.mode === 'playalong';
    const lead = playAlong ? 0.3 + countInMs(this.timeline) / 1000 : 0.15;
    this.startAt = ctx.currentTime + lead;
    this.startedWall = performance.now() + lead * 1000;
    this.engine.reset();
    this.piano?.start();
    this.fedNotes = 0;
    this.fedKeys.clear();
    this.follower = playAlong
      ? new ScoreFollower(this.expected, { instrument: this.cfg.instrument, msPerQuarter: this.timeline.msPerQuarter })
      : null;
    this.learn = playAlong
      ? null
      : new LearnFollower(this.expected, this.cfg.instrument, pitchTolerance(this.cfg.instrument, this.cfg.difficulty));

    if (playAlong) {
      this.metronome = new Metronome(ctx);
      this.metronome.mode = this.cfg.metronomeMode;
      this.metronome.volume = this.cfg.metronomeVolume;
      this.metronome.start(this.beats, this.startAt);
      // Click times are known exactly, so the engines can ignore them.
      this.engine.setClickTimes?.(this.cfg.metronomeMode === 'sound' ? this.beats.map((b) => b.timeMs) : []);
      this.setState('countin');
      window.setTimeout(() => this.state === 'countin' && this.setState('running'), lead * 1000);
      // Ends when the last bar has been played, or after a long silence at the end; never on a timer.
      this.runEnd = new RunEnd(this.expected);
      this.autoStopped = false;
    } else {
      this.engine.setClickTimes?.([]);
      this.setState('running');
    }
    this.cb.onPosition?.(playAlong ? -1 : 0);

    this.offFrames = this.mic.onFrames((samples, t) => {
      const ms = (t - this.startAt) * 1000;
      this.lastAudioMs = ms;
      this.engine?.process(samples, ms);
      this.followLive();
      this.checkEnd(ms);
    });
  }

  /** Play-along: end the run by itself once the piece is really over (see RunEnd). */
  private checkEnd(ms: number) {
    const engine = this.engine;
    if (!engine || !this.runEnd || !this.follower || this.autoStopped) return;
    if ((engine.level ?? 0) >= 0.08) this.lastLoudMs = ms;
    const notes = engine.notes();
    const last = notes[notes.length - 1];
    let soundEnd = last ? last.onsetMs + last.durationMs : -Infinity;
    // Piano scored after the run has no live notes: go by loudness (the metronome has stopped by then).
    if (this.piano?.mode === 'playThenScore') soundEnd = Math.max(soundEnd, this.lastLoudMs);
    if (this.runEnd.shouldEnd(ms, this.follower.position, soundEnd)) {
      this.autoStopped = true;
      this.cb.onAutoStop?.();
    }
  }

  /** Feed newly settled notes to the live follower and report the cursor. */
  private followLive() {
    const engine = this.engine;
    if (!engine) return;
    const notes = (engine.settledNotes?.() ?? engine.notes()).filter((n) => n.onsetMs > -150);
    if (this.cfg.instrument === 'piano') {
      // Piano notes are re-extracted as audio arrives; feed each chord once it's had time to gather.
      const groups = groupIntoChords(notes, SCORING.follow.chordGroupMs).filter(
        (g) => g.onsetMs < this.lastAudioMs - SCORING.follow.chordGroupMs - 200,
      );
      for (const g of groups) {
        const key = `${Math.round(g.onsetMs / 40)}`;
        if (this.fedKeys.has(key)) continue;
        this.fedKeys.add(key);
        this.consume(g.pitches, g.onsetMs, g);
      }
      return;
    }
    for (; this.fedNotes < notes.length; this.fedNotes++) {
      const n = notes[this.fedNotes];
      this.consume([n.midi], n.onsetMs, { pitches: [n.midi], onsetMs: n.onsetMs, durationMs: n.durationMs, confidence: n.confidence, events: [n] });
    }
  }

  private consume(pitches: number[], onsetMs: number, group: Parameters<ScoreFollower['push']>[0]) {
    if (this.follower) {
      const pos = this.follower.push(group);
      this.cb.onPosition?.(pos);
    } else if (this.learn) {
      for (const p of pitches) {
        const moved = this.learn.hear({ midi: p, cents: 0, onsetMs, durationMs: group.durationMs, confidence: group.confidence });
        if (moved) this.cb.onPosition?.(this.learn.position);
      }
      if (this.learn.done) this.cb.onAutoStop?.();
    }
  }

  /** Stop, analyse and score. */
  async stop(): Promise<RunOutcome> {
    this.runEnd = null;
    this.metronome?.stop();
    this.offFrames?.();
    this.offFrames = null;
    this.mic?.stop();
    const durationMs = Math.max(0, performance.now() - this.startedWall);
    const playThenScore = this.piano?.mode === 'playThenScore';
    if (playThenScore) this.setState('analysing');
    const events = ((await this.engine?.finish()) ?? []).filter((n) => n.onsetMs > -150);
    const activeMs = Math.min(durationMs, activePlayingMs(events));
    const outcome: RunOutcome = {
      events,
      expected: this.expected,
      timeline: this.timeline,
      activeMs,
      durationMs,
      playThenScore,
    };
    if (this.cfg.mode === 'playalong') {
      outcome.score = scoreRun(this.expected, events, {
        instrument: this.cfg.instrument,
        difficulty: this.cfg.difficulty,
        msPerQuarter: this.timeline.msPerQuarter,
      });
    } else if (this.learn) {
      outcome.learn = {
        accuracy: this.learn.accuracy,
        completion: this.expected.length ? this.learn.position / this.expected.length : 0,
        reached: this.learn.position,
      };
    }
    this.setState('done');
    return outcome;
  }

  /** Release everything (leaving the screen mid-run). */
  dispose() {
    this.runEnd = null;
    this.metronome?.stop();
    this.offFrames?.();
    this.mic?.stop();
    this.piano?.reset();
    this.engine = null;
    this.piano = null;
  }
}

