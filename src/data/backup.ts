import { APP_NAME } from '../config';
import { db } from './db';
import type { EarnedBadge, Piece, PracticeSession, Profile, Setting } from './types';

export const BACKUP_VERSION = 1;

export interface Backup {
  app: string;
  version: number;
  exportedAt: string;
  profiles: Profile[];
  pieces: Piece[];
  sessions: PracticeSession[];
  badges: EarnedBadge[];
  settings: Setting[];
}

export class BackupError extends Error {}

export async function exportBackup(): Promise<Backup> {
  const [profiles, pieces, sessions, badges, settings] = await Promise.all([
    db.profiles.toArray(),
    db.pieces.toArray(),
    db.sessions.toArray(),
    db.badges.toArray(),
    db.settings.toArray(),
  ]);
  return {
    app: APP_NAME,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    profiles,
    pieces,
    sessions,
    badges,
    settings,
  };
}

function isArrayOf(v: unknown, keys: string[]): boolean {
  return Array.isArray(v) && v.every((x) => x && typeof x === 'object' && keys.every((k) => k in (x as object)));
}

/** Check a parsed file looks like one of our backups. Pure. */
export function validateBackup(data: unknown): Backup {
  if (!data || typeof data !== 'object') throw new BackupError('not-a-backup');
  const b = data as Partial<Backup>;
  if (b.app !== APP_NAME || typeof b.version !== 'number') throw new BackupError('not-a-backup');
  if (b.version > BACKUP_VERSION) throw new BackupError('too-new');
  if (
    !isArrayOf(b.profiles, ['id', 'name']) ||
    !isArrayOf(b.pieces, ['id', 'musicxml']) ||
    !isArrayOf(b.sessions, ['id', 'profileId', 'pieceId']) ||
    !isArrayOf(b.badges ?? [], ['id', 'profileId']) ||
    !isArrayOf(b.settings ?? [], ['key'])
  ) {
    throw new BackupError('damaged');
  }
  return { ...b, badges: b.badges ?? [], settings: b.settings ?? [] } as Backup;
}

/** Replace everything on this device with the backup's contents. */
export async function importBackup(data: unknown): Promise<{ profiles: number; pieces: number; sessions: number }> {
  const b = validateBackup(data);
  await db.transaction('rw', [db.profiles, db.pieces, db.sessions, db.badges, db.settings], async () => {
    await Promise.all([db.profiles.clear(), db.pieces.clear(), db.sessions.clear(), db.badges.clear()]);
    await db.profiles.bulkPut(b.profiles);
    await db.pieces.bulkPut(b.pieces);
    await db.sessions.bulkPut(b.sessions);
    await db.badges.bulkPut(b.badges);
    // Device settings (latency etc.) belong to the device, so keep this device's own.
    await db.settings.bulkPut(b.settings.filter((s) => s.key !== 'device'));
  });
  return { profiles: b.profiles.length, pieces: b.pieces.length, sessions: b.sessions.length };
}

export function backupFileName(now = new Date()): string {
  const d = now.toISOString().slice(0, 10);
  return `${APP_NAME.toLowerCase()}-backup-${d}.json`;
}
