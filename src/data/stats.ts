import type { EarnedBadge, PracticeSession } from './types';

/** Local calendar date, YYYY-MM-DD. */
export function dateKey(ts: number | Date): string {
  const d = typeof ts === 'number' ? new Date(ts) : ts;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday 00:00 of the week containing `now` (Australian weeks start on Monday). */
export function startOfWeek(now: Date): Date {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (d.getDay() + 6) % 7; // Mon = 0
  return addDays(d, -dow);
}

/** A day counts towards a streak if they actually played for this long. */
export const STREAK_MIN_ACTIVE_MS = 20_000;

export function practiceDays(sessions: PracticeSession[]): Set<string> {
  const days = new Map<string, number>();
  for (const s of sessions) days.set(s.dateKey, (days.get(s.dateKey) ?? 0) + s.activeMs);
  return new Set([...days.entries()].filter(([, ms]) => ms >= STREAK_MIN_ACTIVE_MS).map(([k]) => k));
}

/** Consecutive practice days ending today (or yesterday, so the streak isn't "lost" before they practise today). */
export function currentStreak(sessions: PracticeSession[], now = new Date()): number {
  const days = practiceDays(sessions);
  let d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (!days.has(dateKey(d))) d = addDays(d, -1);
  let n = 0;
  while (days.has(dateKey(d))) {
    n++;
    d = addDays(d, -1);
  }
  return n;
}

export function bestStreak(sessions: PracticeSession[]): number {
  const days = [...practiceDays(sessions)].sort();
  let best = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const k of days) {
    const [y, m, d] = k.split('-').map(Number);
    const cur = new Date(y, m - 1, d);
    run = prev && dateKey(addDays(prev, 1)) === k ? run + 1 : 1;
    best = Math.max(best, run);
    prev = cur;
  }
  return best;
}

export function minutesBetween(sessions: PracticeSession[], from: Date, to: Date): number {
  const ms = sessions
    .filter((s) => s.startedAt >= from.getTime() && s.startedAt < to.getTime())
    .reduce((n, s) => n + s.activeMs, 0);
  return ms / 60000;
}

export function weekMinutes(sessions: PracticeSession[], now = new Date()): number {
  const start = startOfWeek(now);
  return minutesBetween(sessions, start, addDays(start, 7));
}

/** Minutes per day for the last `days` days (oldest first). */
export function dailyMinutes(sessions: PracticeSession[], days: number, now = new Date()): { key: string; minutes: number }[] {
  const out: { key: string; minutes: number }[] = [];
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = days - 1; i >= 0; i--) {
    const k = dateKey(addDays(today, -i));
    out.push({ key: k, minutes: sessions.filter((s) => s.dateKey === k).reduce((n, s) => n + s.activeMs, 0) / 60000 });
  }
  return out;
}

export function totalMinutes(sessions: PracticeSession[]): number {
  return sessions.reduce((n, s) => n + s.activeMs, 0) / 60000;
}

export function bestScore(sessions: PracticeSession[], pieceId: string): number | undefined {
  const scores = sessions.filter((s) => s.pieceId === pieceId && s.score !== undefined).map((s) => s.score!);
  return scores.length ? Math.max(...scores) : undefined;
}

/** Scored runs of a piece in time order, for the trend chart. */
export function scoreTrend(sessions: PracticeSession[], pieceId: string): { at: number; score: number }[] {
  return sessions
    .filter((s) => s.pieceId === pieceId && s.score !== undefined)
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((s) => ({ at: s.startedAt, score: s.score! }));
}

/**
 * Active playing time: the union of detected note spans, bridging short
 * breaths/bow changes. Pure.
 */
export function activePlayingMs(notes: { onsetMs: number; durationMs: number }[], bridgeMs = 400): number {
  const spans = notes
    .map((n) => [n.onsetMs, n.onsetMs + Math.max(0, n.durationMs)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const s of spans) {
    if (cur && s[0] <= cur[1] + bridgeMs) cur[1] = Math.max(cur[1], s[1]);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [s[0], s[1]];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return Math.round(total);
}

export interface WeeklySummary {
  minutes: number;
  goalMinutes: number;
  daysPractised: number;
  sessions: number;
  pieces: string[];
  bestScore?: number;
  streak: number;
}

export function weeklySummary(sessions: PracticeSession[], goalMinutes: number, now = new Date()): WeeklySummary {
  const start = startOfWeek(now);
  const end = addDays(start, 7);
  const week = sessions.filter((s) => s.startedAt >= start.getTime() && s.startedAt < end.getTime());
  const scores = week.filter((s) => s.score !== undefined).map((s) => s.score!);
  return {
    minutes: Math.round(minutesBetween(sessions, start, end)),
    goalMinutes,
    daysPractised: new Set(week.filter((s) => s.activeMs > 0).map((s) => s.dateKey)).size,
    sessions: week.length,
    pieces: [...new Set(week.map((s) => s.pieceTitle))],
    bestScore: scores.length ? Math.max(...scores) : undefined,
    streak: currentStreak(sessions, now),
  };
}

export const BADGES = ['firstSong', 'streak3', 'streak7', 'minutes100', 'perfectBar', 'comeback', 'learnedIt'] as const;
export type BadgeId = (typeof BADGES)[number];

/**
 * Which new badges a just-finished session earns. `all` includes the new
 * session. Pure.
 */
export function newBadges(all: PracticeSession[], latest: PracticeSession, earned: EarnedBadge[], now = new Date()): BadgeId[] {
  const have = new Set(earned.map((b) => b.badgeId));
  const out: BadgeId[] = [];
  const give = (b: BadgeId, cond: boolean) => {
    if (cond && !have.has(b)) out.push(b);
  };
  // First song: played (or learnt) a piece most of the way through.
  give('firstSong', all.some((s) => (s.completion ?? 0) >= 0.9));
  const streak = currentStreak(all, now);
  give('streak3', streak >= 3);
  give('streak7', streak >= 7);
  give('minutes100', totalMinutes(all) >= 100);
  give('perfectBar', latest.bars.some((b) => b.perfect));
  give('comeback', latest.score !== undefined && latest.previousBest !== undefined && latest.score >= latest.previousBest + 10);
  give('learnedIt', latest.mode === 'learn' && (latest.completion ?? 0) >= 0.999);
  return out;
}
