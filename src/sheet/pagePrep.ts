import type { Instrument } from '../config';
import { canvasToJpeg, renderPageCanvas, type PageDraft } from '../screens/add/imagePrep';
import { detectStaves, systemBands } from './staffDetect';

/**
 * Get a page ready for line-by-line reading: one small picture of the whole page
 * (for the title, key, time signature, tempo, pickup and repeats) and one
 * full-resolution crop per line of music.
 */

/** Big photos are capped here (phone cameras give 4000+ px; more doesn't help and costs memory). */
export const FULL_MAX_EDGE = 4096;
/** The whole-page context picture. */
export const CONTEXT_MAX_EDGE = 1200;
/** Width cap for a line crop. */
export const LINE_MAX_WIDTH = 2400;
/** Staff detection runs on a copy this wide. */
const ANALYSIS_WIDTH = 1400;

export interface PreparedPage {
  context: Blob;
  lines: Blob[];
  /** False if no staves were found, and the whole page is sent as one "line". */
  detected: boolean;
}

function grayOf(canvas: HTMLCanvasElement, width: number): { gray: Uint8ClampedArray; w: number; h: number } {
  const scale = Math.min(1, width / canvas.width);
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(canvas, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const gray = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (rgba[j] * 299 + rgba[j + 1] * 587 + rgba[j + 2] * 114) / 1000;
  return { gray, w, h };
}

function crop(src: HTMLCanvasElement, y0: number, y1: number, maxWidth: number): HTMLCanvasElement {
  const scale = Math.min(1, maxWidth / src.width);
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.max(1, Math.round((y1 - y0) * scale));
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, y0, src.width, y1 - y0, 0, 0, c.width, c.height);
  return c;
}

function shrink(src: HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  return crop(src, 0, src.height, Math.round(src.width * scale));
}

export async function preparePage(page: PageDraft, instrument: Instrument): Promise<PreparedPage> {
  const full = await renderPageCanvas(page, FULL_MAX_EDGE);
  const { gray, w, h } = grayOf(full, ANALYSIS_WIDTH);
  const staves = detectStaves(gray, w, h);
  const bands = systemBands(staves, w, h, instrument === 'piano' ? 2 : 1);
  const k = full.width / w;
  const context = await canvasToJpeg(shrink(full, CONTEXT_MAX_EDGE), 0.8);
  if (bands.length === 0) {
    return { context, lines: [await canvasToJpeg(shrink(full, LINE_MAX_WIDTH), 0.88)], detected: false };
  }
  const lines: Blob[] = [];
  for (const b of bands) lines.push(await canvasToJpeg(crop(full, Math.floor(b.y0 * k), Math.ceil(b.y1 * k), LINE_MAX_WIDTH), 0.9));
  return { context, lines, detected: true };
}
