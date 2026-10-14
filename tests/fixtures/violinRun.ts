/**
 * Practice runs played on real violin notes (tests/fixtures/violin): a player
 * model (tempo off, drifting, hesitating, missing, adding and fluffing notes)
 * renders a performance of the expected notes, which goes through a phone mic
 * model, the real mono engine and the score follower exactly as the Practice
 * screen feeds them. Used to tune the follower and to measure how far through
 * a piece it stays in sync.
 */
import { MonoEngine } from '../../src/engines/mono/monoEngine';
import { ScoreFollower } from '../../src/follow/follower';
import { RunEnd } from '../../src/follow/runEnd';
import type { ExpectedNote } from '../../src/sheet/expected';
import { rng, sequence, shiftCents, throughPhone, violinClip, type Clip } from './violinAudio';

const ARCO: Record<number, string> = { 55: 'arco_G3_f', 57: 'arco_A3_f', 60: 'arco_C4_f', 62: 'arco_D4_f_from_E4', 64: 'arco_E4_f', 67: 'arco_G4_f', 69: 'arco_A4_f', 72: 'arco_C5_f', 76: 'arco_E5_f' };
const SPIC: Record<number, string> = { 55: 'spic_G3', 60: 'spic_C4', 64: 'spic_E4', 67: 'spic_G4', 69: 'spic_A4', 72: 'spic_C5', 76: 'spic_E5', 79: 'spic_G5', 81: 'spic_A5', 84: 'spic_C6', 88: 'spic_E6' };

const cache = new Map<string, Clip>();
function sample(midi: number, short: boolean, cents: number): Clip {
  const bank = short ? SPIC : ARCO;
  const roots = Object.keys(bank).map(Number);
  const root = roots.reduce((a, b) => (Math.abs(b - midi) < Math.abs(a - midi) ? b : a));
  const key = `${bank[root]}:${Math.round((midi - root) * 100 + cents)}`;
  let c = cache.get(key);
  if (!c) {
    c = shiftCents(violinClip(bank[root]), Math.round((midi - root) * 100 + cents));
    cache.set(key, c);
  }
  return c;
}

export interface PlayerModel {
  /** Player's tempo as a share of the metronome's (0.8 = 20% slower). */
  tempo?: number;
  /** Gradual slowing over the whole piece (0.15 = 15% slower by the end; negative speeds up). */
  drift?: number;
  jitterMs?: number;
  /** Random tuning spread (± cents). */
  detuneCents?: number;
  missRate?: number;
  /** Extra notes: a scratchy grace / stray note before a written one. */
  extraRate?: number;
  /** Wrong notes: a semitone or two off. */
  wrongRate?: number;
  /** Hesitations: stop for about a beat before this share of notes. */
  pauseRate?: number;
  /** Plays the notes in this order (indexes into expected), e.g. skipping a repeat. Default: all. */
  order?: number[];
  startDelayMs?: number;
  /** Silence after the last note. */
  tailMs?: number;
  seed?: number;
}

export interface Performance {
  clip: Clip;
  /** What was really played: the expected index (or -1 for an extra note) and when. */
  truth: { index: number; onsetMs: number; endMs: number }[];
  endMs: number;
}

export function perform(expected: ExpectedNote[], msPerQuarter: number, p: PlayerModel = {}): Performance {
  const rand = rng(p.seed ?? 11);
  const u = () => (rand() + 1) / 2;
  const order = p.order ?? expected.map((_, i) => i);
  const tempo = p.tempo ?? 1;
  const parts: Parameters<typeof sequence>[0] = [];
  const truth: Performance['truth'] = [];
  let t = p.startDelayMs ?? 0;
  for (let k = 0; k < order.length; k++) {
    const scale = (1 + (p.drift ?? 0) * (k / Math.max(1, order.length - 1))) / tempo;
    const e = expected[order[k]];
    const next = expected[order[k + 1]];
    // Time to the next written note (or the note's own length at the end, or across a jump).
    const gapQ = next && next.onsetQ > e.onsetQ ? next.onsetQ - e.onsetQ : e.durationQ;
    const ms = gapQ * msPerQuarter * scale;
    if (p.pauseRate && u() < p.pauseRate) t += msPerQuarter * (0.7 + 0.6 * u());
    const at = Math.max(0, t + (p.jitterMs ?? 0) * rand());
    if (p.extraRate && u() < p.extraRate) {
      // A short stray note just before (a slip onto a neighbouring string).
      const stray = e.pitches[0] + (u() < 0.5 ? 5 : -5);
      parts.push({ clip: sample(stray, true, 0), atMs: Math.max(0, at - 140), lengthMs: 110, gain: 0.8 });
      truth.push({ index: -1, onsetMs: Math.max(0, at - 140), endMs: at - 30 });
    }
    if (!(p.missRate && u() < p.missRate)) {
      const wrong = p.wrongRate && u() < p.wrongRate ? (u() < 0.5 ? 1 : -1) * (u() < 0.7 ? 1 : 2) : 0;
      const len = Math.min(e.durationMs * scale, ms) * 0.92;
      const short = len < 300;
      parts.push({ clip: sample(e.pitches[0] + wrong, short, (p.detuneCents ?? 0) * rand()), atMs: at, lengthMs: len, gain: 0.8 + 0.2 * u() });
      truth.push({ index: wrong ? -2 - order[k] : order[k], onsetMs: at, endMs: at + len });
    }
    t += ms;
  }
  const endMs = t;
  const total = endMs + (p.tailMs ?? 6000);
  return { clip: throughPhone(sequence(parts, total), { highpassHz: 250, noise: 0.003, peak: 0.2, seed: p.seed ?? 11 }), truth, endMs };
}

export interface FollowResult {
  /** Cursor (expected index) reported after each note was fed, with the session time. */
  cursor: { atMs: number; pos: number }[];
  /** When the run ended by itself (ms), if it did. */
  endedAtMs: number | null;
  /** How far through the notes played it was still in sync (0..1; brief losses it recovered from don't count). */
  syncedTo: number;
  /** Share of cursor updates that were in sync (within 3 notes). */
  inSync: number;
  /** Largest backwards cursor jump (notes). */
  maxBackJump: number;
  /** Did it end before the player had finished? */
  endedEarly: boolean;
  lastReached: number;
}

type Follower = { push: ScoreFollower['push'] };

/**
 * Feed a performance through the engine and a follower like PracticeRun does,
 * with the run-end rules. `makeFollower` lets tests compare follower versions.
 */
export function followPerformance(
  expected: ExpectedNote[],
  msPerQuarter: number,
  perf: Performance,
  opts: { makeFollower?: () => Follower; end?: (lastAudioMs: number, pos: number, soundEndMs: number) => boolean } = {},
): FollowResult {
  const sr = perf.clip.sampleRate;
  const engine = new MonoEngine({ instrument: 'violin', sampleRate: sr });
  const follower = opts.makeFollower?.() ?? new ScoreFollower(expected, { instrument: 'violin', msPerQuarter });
  const ender = new RunEnd(expected);
  const cursor: FollowResult['cursor'] = [];
  let fed = 0;
  let pos = -1;
  let endedAtMs: number | null = null;
  const block = 128;
  for (let i = 0; i < perf.clip.samples.length && endedAtMs === null; i += block) {
    const ms = (i / sr) * 1000;
    engine.process(perf.clip.samples.subarray(i, i + block), ms);
    const notes = engine.settledNotes().filter((n) => n.onsetMs > -150);
    for (; fed < notes.length; fed++) {
      const n = notes[fed];
      pos = follower.push({ pitches: [n.midi], onsetMs: n.onsetMs, durationMs: n.durationMs, confidence: n.confidence, events: [n] });
      cursor.push({ atMs: ms, pos });
    }
    const all = engine.notes();
    const last = all[all.length - 1];
    const soundEnd = last ? last.onsetMs + last.durationMs : -Infinity;
    const done = opts.end ? opts.end(ms, pos, soundEnd) : ender.shouldEnd(ms, pos, soundEnd);
    if (done) endedAtMs = ms;
  }
  // In sync: the cursor is within 3 notes of what's really being played (a missed or extra note can lag it briefly).
  const played = perf.truth.map((tr) => (tr.index >= 0 ? tr.index : tr.index <= -2 ? -2 - tr.index : -1));
  const playedCount = played.filter((k) => k >= 0).length;
  const truthAt = (ms: number) => {
    let k = -1;
    perf.truth.forEach((tr, i) => {
      if (tr.onsetMs <= ms && played[i] >= 0) k = i;
    });
    return k;
  };
  let syncedK = -1;
  let good = 0;
  let maxBackJump = 0;
  let prev = -1;
  for (const c of cursor) {
    const k = truthAt(c.atMs - 100);
    const want = k >= 0 ? played[k] : -1;
    maxBackJump = Math.max(maxBackJump, prev - c.pos);
    prev = Math.max(prev, c.pos);
    if (Math.abs(c.pos - want) <= 3) {
      good++;
      if (k > syncedK) syncedK = k;
    }
  }
  const syncedNotes = played.slice(0, syncedK + 1).filter((x) => x >= 0).length;
  const lastPlayed = perf.truth[perf.truth.length - 1];
  const endedEarly = endedAtMs !== null && endedAtMs < (lastPlayed?.endMs ?? 0);
  return { cursor, endedAtMs, syncedTo: playedCount ? syncedNotes / playedCount : 0, inSync: cursor.length ? good / cursor.length : 0, maxBackJump, endedEarly, lastReached: pos };
}
