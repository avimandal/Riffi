import { useSyncExternalStore } from 'react';
import type { Instrument } from '../../config';
import { OmrError } from '../../sheet/omrClient';
import { readSheetMusic, type SheetProgress } from '../../sheet/readSheet';
import type { PartialRead } from '../../sheet/reader';
import { db } from '../../data/db';
import { saveDraft, type FailedLineDraft } from './draft';
import { renderPage, thumbnail, type PageDraft } from './imagePrep';

/**
 * The read in progress, kept outside any screen so the review screen can show
 * lines as they arrive (and the read carries on if the kid looks elsewhere).
 */
export interface LiveRead {
  status: 'reading' | 'failed';
  progress: SheetProgress | null;
  partial: PartialRead | null;
  /** On failure: what went wrong (nothing at all could be read). */
  error?: OmrError | Error;
  /** The photos, so Add music can show them again after a failure. */
  pages: PageDraft[];
  instrument: Instrument;
}

/** The photos kept with a piece, to check the notes against later (big enough to read, small enough to store). */
const PHOTO_MAX_EDGE = 1600;

let current: LiveRead | null = null;
const listeners = new Set<() => void>();
const set = (next: LiveRead | null) => {
  current = next;
  listeners.forEach((l) => l());
};

export function getLiveRead(): LiveRead | null {
  return current;
}

export function clearLiveRead() {
  set(null);
}

export function useLiveRead(): LiveRead | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/**
 * Start reading. Resolves when the draft is saved (lines that failed are in it,
 * ready to read again) or the read failed completely (then `status` is 'failed').
 */
export async function startLiveRead(pages: PageDraft[], instrument: Instrument): Promise<void> {
  set({ status: 'reading', progress: { stage: 'preparing', page: 1, pages: pages.length }, partial: null, pages, instrument });
  const update = (changes: Partial<LiveRead>) => current && set({ ...current, ...changes });
  try {
    const thumbs: string[] = [];
    const photos: string[] = [];
    for (const p of pages) {
      const big = await renderPage(p, PHOTO_MAX_EDGE);
      thumbs.push(await thumbnail(big));
      photos.push(await thumbnail(big, PHOTO_MAX_EDGE));
    }
    const result = await readSheetMusic(
      pages,
      instrument,
      (progress) => update({ progress }),
      (partial) => update({ partial }),
    );
    const band = (page: number, line: number) => result.pages[page - 1]?.bands?.[line - 1] ?? (result.pages[page - 1]?.detected === false ? { top: 0, bottom: 1 } : undefined);
    const photoLines = result.lineBars.flatMap(({ page, line, from, to }) => {
      const b = band(page, line);
      return b ? [{ page: page - 1, top: b.top, bottom: b.bottom, from, to }] : [];
    });
    const failedLines: FailedLineDraft[] = result.failed.map((f) => ({ ...f, band: band(f.page, f.line) }));
    // Where the time went, for Settings → Check music reader on this device.
    await db.settings.put({ key: 'lastReadTimings', value: { ...result.timings, at: Date.now() } });
    await saveDraft({ musicxml: result.musicxml, warnings: result.warnings, thumbnails: thumbs, photos, photoLines, reader: result.trace.provider, instrument, flags: result.flags, failedLines });
    pages.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    set(null);
  } catch (e) {
    update({ status: 'failed', error: e instanceof Error ? e : new Error(String(e)) });
  }
}
