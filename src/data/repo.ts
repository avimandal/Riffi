import { db, newId } from './db';
import { newBadges, dateKey, type BadgeId } from './stats';
import {
  DEFAULT_DEVICE_SETTINGS,
  type DeviceSettings,
  type EarnedBadge,
  type Piece,
  type PracticeSession,
  type Profile,
} from './types';

// Profiles

export async function listProfiles(): Promise<Profile[]> {
  return db.profiles.orderBy('createdAt').toArray();
}

export async function createProfile(p: Omit<Profile, 'id' | 'createdAt'>): Promise<Profile> {
  const profile: Profile = { ...p, id: newId(), createdAt: Date.now() };
  await db.profiles.add(profile);
  return profile;
}

export async function updateProfile(id: string, changes: Partial<Profile>) {
  await db.profiles.update(id, changes);
}

/** Remove a kid and everything recorded for them. */
export async function deleteProfile(id: string) {
  await db.transaction('rw', db.profiles, db.sessions, db.badges, async () => {
    await db.sessions.where('profileId').equals(id).delete();
    await db.badges.where('profileId').equals(id).delete();
    await db.profiles.delete(id);
  });
}

// Pieces

export async function listPieces(): Promise<Piece[]> {
  return db.pieces.orderBy('updatedAt').reverse().toArray();
}

export async function getPiece(id: string): Promise<Piece | undefined> {
  return db.pieces.get(id);
}

export async function savePiece(p: Omit<Piece, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<Piece> {
  const now = Date.now();
  const existing = p.id ? await db.pieces.get(p.id) : undefined;
  const piece: Piece = {
    ...p,
    id: p.id ?? newId(),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.pieces.put(piece);
  return piece;
}

/** Remember the Practice screen's "Play repeats" choice for a piece (doesn't count as an edit). */
export async function setPlayRepeats(id: string, playRepeats: boolean) {
  await db.pieces.update(id, { playRepeats });
}

export async function deletePiece(id: string) {
  await db.transaction('rw', db.pieces, db.sessions, async () => {
    await db.sessions.where('pieceId').equals(id).delete();
    await db.pieces.delete(id);
  });
}

// Sessions

export async function sessionsFor(profileId: string): Promise<PracticeSession[]> {
  return db.sessions.where('profileId').equals(profileId).sortBy('startedAt');
}

export async function getSession(id: string) {
  return db.sessions.get(id);
}

export async function bestFor(profileId: string, pieceId: string): Promise<number | undefined> {
  const list = await db.sessions.where('[profileId+pieceId]').equals([profileId, pieceId]).toArray();
  const scores = list.filter((s) => s.score !== undefined).map((s) => s.score!);
  return scores.length ? Math.max(...scores) : undefined;
}

export async function lastSession(profileId: string): Promise<PracticeSession | undefined> {
  const list = await db.sessions.where('[profileId+startedAt]').between([profileId, 0], [profileId, Infinity]).reverse().limit(1).toArray();
  return list[0];
}

/**
 * Save a finished session, work out personal best and badges, and return
 * the stored record.
 */
export async function recordSession(
  s: Omit<PracticeSession, 'id' | 'dateKey' | 'previousBest' | 'personalBest' | 'newBadges'>,
): Promise<PracticeSession> {
  return db.transaction('rw', db.sessions, db.badges, async () => {
    const previousBest = await bestFor(s.profileId, s.pieceId);
    const session: PracticeSession = {
      ...s,
      id: newId(),
      dateKey: dateKey(s.startedAt),
      previousBest,
      personalBest: s.score !== undefined && (previousBest === undefined ? s.score > 0 : s.score > previousBest),
    };
    const all = [...(await db.sessions.where('profileId').equals(s.profileId).toArray()), session];
    const earned = await db.badges.where('profileId').equals(s.profileId).toArray();
    const badges: BadgeId[] = newBadges(all, session, earned, new Date(s.startedAt));
    session.newBadges = badges;
    await db.sessions.add(session);
    await db.badges.bulkAdd(
      badges.map(
        (badgeId): EarnedBadge => ({
          id: `${s.profileId}:${badgeId}`,
          profileId: s.profileId,
          badgeId,
          earnedAt: Date.now(),
          sessionId: session.id,
        }),
      ),
    );
    return session;
  });
}

export async function badgesFor(profileId: string): Promise<EarnedBadge[]> {
  return db.badges.where('profileId').equals(profileId).toArray();
}

// Settings (per device)

export async function getDeviceSettings(): Promise<DeviceSettings> {
  const row = await db.settings.get('device');
  return { ...DEFAULT_DEVICE_SETTINGS, ...((row?.value as Partial<DeviceSettings>) ?? {}) };
}

export async function updateDeviceSettings(changes: Partial<DeviceSettings>): Promise<DeviceSettings> {
  const next = { ...(await getDeviceSettings()), ...changes };
  await db.settings.put({ key: 'device', value: next });
  return next;
}

export async function deleteEverything() {
  await db.transaction('rw', [db.profiles, db.pieces, db.sessions, db.badges, db.settings], async () => {
    await Promise.all([db.profiles.clear(), db.pieces.clear(), db.sessions.clear(), db.badges.clear(), db.settings.clear()]);
  });
}
