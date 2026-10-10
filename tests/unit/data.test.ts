import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../../src/data/db';
import { BackupError, exportBackup, importBackup, validateBackup } from '../../src/data/backup';
import { createProfile, deleteProfile, recordSession, savePiece, sessionsFor } from '../../src/data/repo';
import {
  activePlayingMs,
  bestStreak,
  currentStreak,
  dateKey,
  newBadges,
  startOfWeek,
  weekMinutes,
  weeklySummary,
} from '../../src/data/stats';
import type { PracticeSession } from '../../src/data/types';

function session(day: string, over: Partial<PracticeSession> = {}): PracticeSession {
  const [y, m, d] = day.split('-').map(Number);
  const startedAt = new Date(y, m - 1, d, 16, 0).getTime();
  return {
    id: `${day}-${Math.random()}`,
    profileId: 'kid',
    pieceId: 'piece',
    pieceTitle: 'Twinkle',
    startedAt,
    dateKey: day,
    instrument: 'violin',
    mode: 'playalong',
    difficulty: 'normal',
    tempoBpm: 80,
    activeMs: 5 * 60_000,
    durationMs: 6 * 60_000,
    bars: [],
    marks: [],
    ...over,
  };
}

describe('practice stats', () => {
  const now = new Date(2026, 9, 10, 18, 0); // Sat 10 Oct 2026

  it('counts a streak ending today or yesterday', () => {
    const s = ['2026-10-08', '2026-10-09', '2026-10-10'].map((d) => session(d));
    expect(currentStreak(s, now)).toBe(3);
    expect(currentStreak(s.slice(0, 2), now)).toBe(2); // not practised yet today
    expect(currentStreak([session('2026-10-07')], now)).toBe(0);
  });

  it('ignores days with only a few seconds of playing', () => {
    const s = [session('2026-10-09'), session('2026-10-10', { activeMs: 5000 })];
    expect(currentStreak(s, now)).toBe(1);
  });

  it('finds the best streak', () => {
    const s = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-10', '2026-09-11'].map((d) => session(d));
    expect(bestStreak(s)).toBe(4);
  });

  it('weeks start on Monday', () => {
    expect(dateKey(startOfWeek(now))).toBe('2026-10-05');
    const s = [session('2026-10-04'), session('2026-10-05'), session('2026-10-10')];
    expect(weekMinutes(s, now)).toBe(10);
  });

  it('summarises a week for parents', () => {
    const s = [session('2026-10-06', { score: 70 }), session('2026-10-08', { score: 82, pieceTitle: 'Lightly Row' })];
    const w = weeklySummary(s, 60, now);
    expect(w).toMatchObject({ minutes: 10, goalMinutes: 60, daysPractised: 2, sessions: 2, bestScore: 82 });
    expect(w.pieces).toEqual(['Twinkle', 'Lightly Row']);
  });

  it('measures active playing time from detected notes', () => {
    const notes = [
      { onsetMs: 0, durationMs: 400 },
      { onsetMs: 500, durationMs: 400 }, // bridged (100 ms gap)
      { onsetMs: 3000, durationMs: 1000 },
    ];
    expect(activePlayingMs(notes)).toBe(900 + 1000);
  });

  it('awards badges', () => {
    const latest = session('2026-10-10', { completion: 1, score: 85, previousBest: 70, bars: [{ measureIndex: 0, playIndex: 0, bar: '1', pitchAccuracy: 1, rhythmAccuracy: 1, perfect: true, missed: 0 }] });
    const all = [session('2026-10-08'), session('2026-10-09'), latest];
    const b = newBadges(all, latest, [], now);
    expect(b).toEqual(expect.arrayContaining(['firstSong', 'streak3', 'perfectBar', 'comeback']));
    expect(b).not.toContain('streak7');
    // Not awarded twice.
    expect(newBadges(all, latest, [{ id: 'kid:firstSong', profileId: 'kid', badgeId: 'firstSong', earnedAt: 0 }], now)).not.toContain('firstSong');
  });
});

describe('storage and backup', () => {
  beforeEach(async () => {
    await Promise.all([db.profiles.clear(), db.pieces.clear(), db.sessions.clear(), db.badges.clear(), db.settings.clear()]);
  });

  it('records sessions with personal bests and badges', async () => {
    const kid = await createProfile({ name: 'Mia', avatar: 'koala', instrument: 'violin', difficulty: 'normal', weeklyGoalMinutes: 60 });
    const piece = await savePiece({ title: 'Twinkle', musicxml: '<score-partwise/>', thumbnails: [] });
    const base = { profileId: kid.id, pieceId: piece.id, pieceTitle: piece.title, instrument: 'violin' as const, mode: 'playalong' as const, difficulty: 'normal' as const, tempoBpm: 80, activeMs: 60_000, durationMs: 70_000, bars: [], marks: [] };
    const first = await recordSession({ ...base, startedAt: Date.now() - 1000, score: 72, completion: 1 });
    expect(first.previousBest).toBeUndefined();
    expect(first.newBadges).toContain('firstSong');
    const second = await recordSession({ ...base, startedAt: Date.now(), score: 81, completion: 1 });
    expect(second.previousBest).toBe(72);
    expect(second.personalBest).toBe(true);
    expect(second.newBadges).not.toContain('firstSong');
    expect(await sessionsFor(kid.id)).toHaveLength(2);
  });

  it('exports and re-imports everything', async () => {
    const kid = await createProfile({ name: 'Leo', avatar: 'fox', instrument: 'piano', difficulty: 'easy', weeklyGoalMinutes: 30 });
    await savePiece({ title: 'Song', musicxml: '<score-partwise/>', thumbnails: [] });
    const backup = JSON.parse(JSON.stringify(await exportBackup()));
    await deleteProfile(kid.id);
    expect(await db.profiles.count()).toBe(0);
    const r = await importBackup(backup);
    expect(r).toEqual({ profiles: 1, pieces: 1, sessions: 0 });
    expect((await db.profiles.toArray())[0].name).toBe('Leo');
  });

  it('refuses files that are not backups', () => {
    expect(() => validateBackup({ hello: 1 })).toThrow(BackupError);
    expect(() => validateBackup({ app: 'Riffi', version: 99, profiles: [], pieces: [], sessions: [] })).toThrow('too-new');
    expect(() => validateBackup({ app: 'Riffi', version: 1, profiles: [{}], pieces: [], sessions: [] })).toThrow('damaged');
  });
});

describe('metronome practice counts towards the streak', () => {
  it('a counted metronome session is a practice day', () => {
    const now = new Date(2026, 9, 10, 18, 0);
    const s = [session('2026-10-09'), session('2026-10-10', { mode: 'metronome', pieceId: 'gadget', pieceTitle: 'Metronome practice', activeMs: 60_000 })];
    expect(currentStreak(s, now)).toBe(2);
    expect(weekMinutes(s, now)).toBe(6);
  });
});
