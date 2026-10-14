import type { Instrument } from '../config';
import { canvasToJpeg, loadImage, type PageDraft } from '../screens/add/imagePrep';
import { callReader, readerInfo, REQUEST_TIMEOUT_MS, OMR_TIMINGS_ENDPOINT, type ReaderInfo } from './omrClient';
import { preparePage, type PreparedPage } from './pagePrep';
import { readOneLine, readPrepared, type LineJob, type PartialRead, type ReadProgress, type ReadResult, type ReadTimings } from './reader';
import { renderLinePng } from './renderLine';

export type SheetProgress = ReadProgress | { stage: 'preparing'; page: number; pages: number };

/** A request's deadline in the app: a little over the server's own, never past Cloudflare's 100 s. */
export function requestTimeoutMs(info: ReaderInfo | null): number {
  return Math.min(REQUEST_TIMEOUT_MS, ((info?.requestSeconds ?? 85) + 10) * 1000);
}

/** A smaller copy of a line's picture, for its retry. */
export async function shrinkCrop(blob: Blob, scale = 0.7): Promise<Blob> {
  const img = await loadImage(blob);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return canvasToJpeg(c, 0.85);
}

/** Send a read's timings to the server's private log (best effort). */
export function sendTimings(t: ReadTimings) {
  try {
    const form = new FormData();
    form.append('timings', JSON.stringify(t));
    void fetch(OMR_TIMINGS_ENDPOINT, { method: 'POST', body: form, keepalive: true }).catch(() => undefined);
  } catch {
    // Timings are only for the log.
  }
}

/**
 * Read photographed pages in the browser: find the lines, then read them (several
 * at once). Lines that can't be read are reported in `failed`; the rest is kept.
 */
export async function readSheetMusic(
  drafts: PageDraft[],
  instrument: Instrument,
  onProgress?: (p: SheetProgress) => void,
  onLine?: (p: PartialRead) => void,
): Promise<ReadResult & { pages: PreparedPage[] }> {
  const pages: PreparedPage[] = [];
  for (let i = 0; i < drafts.length; i++) {
    onProgress?.({ stage: 'preparing', page: i + 1, pages: drafts.length });
    pages.push(await preparePage(drafts[i], instrument));
  }
  const info = await readerInfo();
  // The server decides which AI reads (site-wide, in Settings); the app only paces itself for it.
  const rpm = info?.rpm[info.provider ?? 'gemini'] ?? 8;
  const timeoutMs = requestTimeoutMs(info);
  const result = await readPrepared(pages, {
    instrument,
    rpm,
    linesPerRequest: info?.linesPerRequest ?? 4,
    checkRounds: info?.checkRounds ?? 0,
    parallel: info?.parallel ?? 2,
    onProgress,
    onLine,
    send: (req, onBars) => callReader(req, { instrument, onBars, timeoutMs }),
    shrink: (b) => shrinkCrop(b),
    prepMs: pages.reduce((s, p) => s + (p.timing?.prepMs ?? 0), 0),
    headsMs: pages.reduce((s, p) => s + (p.timing?.headsMs ?? 0), 0),
    render: (measures, ctx) => renderLinePng(measures, ctx, instrument),
  });
  sendTimings(result.timings);
  return { ...result, pages };
}

/** "Read this line again" on the review screen. */
export async function rereadLine(job: LineJob, instrument: Instrument) {
  const info = await readerInfo();
  return readOneLine(job, { instrument, rpm: info?.rpm[info.provider ?? 'gemini'] ?? 8, timeoutMs: requestTimeoutMs(info) });
}
