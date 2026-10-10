import Dexie, { type Table } from 'dexie';
import type { EarnedBadge, Piece, PracticeSession, Profile, Setting } from './types';

export class RiffiDB extends Dexie {
  profiles!: Table<Profile, string>;
  pieces!: Table<Piece, string>;
  sessions!: Table<PracticeSession, string>;
  badges!: Table<EarnedBadge, string>;
  settings!: Table<Setting, string>;

  constructor(name = 'riffi') {
    super(name);
    this.version(1).stores({
      profiles: 'id, createdAt',
      pieces: 'id, updatedAt, title',
      sessions: 'id, profileId, pieceId, startedAt, dateKey, [profileId+pieceId], [profileId+startedAt]',
      badges: 'id, profileId, badgeId',
      settings: 'key',
    });
  }
}

export const db = new RiffiDB();

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
