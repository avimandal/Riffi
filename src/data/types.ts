import type { Difficulty, Instrument, MetronomeMode, PracticeMode } from '../config';
import type { LoopRange } from '../sheet/expected';
import type { Issue } from '../scoring/feedback';

export interface Profile {
  id: string;
  name: string;
  avatar: string;
  instrument: Instrument;
  difficulty: Difficulty;
  /** Set by a parent. */
  weeklyGoalMinutes: number;
  createdAt: number;
}

export interface Piece {
  id: string;
  title: string;
  musicxml: string;
  /** Small JPEG data URLs of the original photos (kept on this device only). */
  thumbnails: string[];
  /** Instrument it was scanned for. */
  instrument?: Instrument;
  /** The original photos (larger than the thumbnails), to check the notes against when editing. Device only. */
  photos?: string[];
  /** Where each line of music sits on the photos, and which bars came from it. */
  photoLines?: PhotoLine[];
  /** Which music reader read the photos ('gemini' or 'claude'). */
  reader?: string;
  /** When the music was changed after it was first saved. */
  editedAt?: number[];
  /** Practice follows the repeat signs (off unless chosen on the Practice screen). */
  playRepeats?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** One line of music on a photo, and the bars (measure indexes) read from it. */
export interface PhotoLine {
  /** 0-based photo. */
  page: number;
  /** Fractions of the photo's height. */
  top: number;
  bottom: number;
  from: number;
  to: number;
}

export interface StoredBar {
  measureIndex: number;
  playIndex: number;
  bar: string;
  pitchAccuracy: number;
  rhythmAccuracy: number;
  perfect: boolean;
  missed: number;
}

/** Per-notehead outcome, kept so a past result can be shown on the sheet again. */
export interface StoredNoteMark {
  refs: number[];
  pitch: 'correct' | 'close' | 'wrong' | 'missed';
  timing: 'good' | 'ok' | 'early' | 'late' | 'missed';
}

export interface PracticeSession {
  id: string;
  profileId: string;
  pieceId: string;
  pieceTitle: string;
  startedAt: number;
  /** Local date, YYYY-MM-DD. */
  dateKey: string;
  instrument: Instrument;
  mode: PracticeMode;
  difficulty: Difficulty;
  tempoBpm: number;
  loop?: LoopRange;
  /** Time sound was detected (not just app open). */
  activeMs: number;
  durationMs: number;
  score?: number;
  stars?: number;
  pitchAccuracy?: number;
  rhythmAccuracy?: number;
  completion?: number;
  /** Learn mode: share of notes found first try. */
  learnAccuracy?: number;
  bars: StoredBar[];
  marks: StoredNoteMark[];
  /** Score before this session (for "Your best was 72, now 81!"). */
  previousBest?: number;
  personalBest?: boolean;
  newBadges?: string[];
  /** Top things to work on (max 3), worked out when the run was scored. */
  issues?: Issue[];
  /** Piano scored after the run (device too slow for live). */
  playThenScore?: boolean;
}

export interface EarnedBadge {
  id: string; // `${profileId}:${badgeId}`
  profileId: string;
  badgeId: string;
  earnedAt: number;
  sessionId?: string;
}

export interface Setting {
  key: string;
  value: unknown;
}

export interface DeviceSettings {
  latencyMs?: number;
  noiseFloor?: number;
  metronomeMode: MetronomeMode;
  metronomeVolume: number;
  pianoMode: 'auto' | 'live' | 'playThenScore';
  theme: 'system' | 'light' | 'dark';
  firstRunDone: boolean;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  metronomeMode: 'sound',
  metronomeVolume: 0.8,
  pianoMode: 'auto',
  theme: 'system',
  firstRunDone: false,
};
