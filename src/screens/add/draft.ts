import type { Instrument } from '../../config';
import type { BarFlag } from '../../sheet/reader';
import { db } from '../../data/db';

/** A freshly read piece waiting on the review screen (kept in IndexedDB so a reload doesn't lose it). */
export interface Draft {
  musicxml: string;
  warnings: string[];
  thumbnails: string[];
  instrument: Instrument;
  /** Bars to look at: still failing a check, or the reader wasn't sure. */
  flags?: BarFlag[];
}

export async function saveDraft(d: Draft) {
  await db.settings.put({ key: 'draft', value: d });
}

export async function loadDraft(): Promise<Draft | undefined> {
  return (await db.settings.get('draft'))?.value as Draft | undefined;
}

export async function clearDraft() {
  await db.settings.delete('draft');
}
