import { UPLOAD_JPEG_QUALITY, UPLOAD_MAX_EDGE_PX } from '../../config';

export interface Crop {
  /** Fractions of the (rotated) image, 0..1. */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PageDraft {
  id: string;
  file: Blob;
  previewUrl: string;
  rotation: 0 | 90 | 180 | 270;
  crop?: Crop;
}

/**
 * Load an image the way the browser displays it. Modern browsers apply EXIF
 * orientation when decoding (`image-orientation: from-image` is the default),
 * so drawing it to a canvas "bakes in" the right way up and drops the EXIF.
 */
export async function loadImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // Safe to revoke after decode; the pixels are in memory.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Fit (w, h) inside a box with the long edge at most `maxEdge`. Pure. */
export function fitWithin(w: number, h: number, maxEdge: number): { w: number; h: number } {
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

/** Rotate and crop a page onto a canvas, with the long edge at most `maxEdge`. */
export async function renderPageCanvas(page: PageDraft, maxEdge: number): Promise<HTMLCanvasElement> {
  const img = await loadImage(page.file);
  const rotated = page.rotation === 90 || page.rotation === 270;
  const rw = rotated ? img.naturalHeight : img.naturalWidth;
  const rh = rotated ? img.naturalWidth : img.naturalHeight;
  const crop = page.crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const cw = rw * crop.w;
  const ch = rh * crop.h;
  const out = fitWithin(cw, ch, maxEdge);
  const scale = out.w / cw;

  const canvas = document.createElement('canvas');
  canvas.width = out.w;
  canvas.height = out.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No canvas');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, out.w, out.h);
  ctx.imageSmoothingQuality = 'high';
  ctx.save();
  ctx.scale(scale, scale);
  ctx.translate(-crop.x * rw, -crop.y * rh);
  // Rotate about the rotated image's frame.
  ctx.translate(rw / 2, rh / 2);
  ctx.rotate((page.rotation * Math.PI) / 180);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  ctx.restore();
  return canvas;
}

export function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/jpeg', quality));
}

/** Rotate, crop and downscale a page; returns a JPEG blob. */
export async function renderPage(page: PageDraft, maxEdge = UPLOAD_MAX_EDGE_PX, quality = UPLOAD_JPEG_QUALITY): Promise<Blob> {
  return canvasToJpeg(await renderPageCanvas(page, maxEdge), quality);
}

/** Small thumbnail data URL to keep with the piece (device only). */
export async function thumbnail(blob: Blob, maxEdge = 480): Promise<string> {
  const img = await loadImage(blob);
  const { w, h } = fitWithin(img.naturalWidth, img.naturalHeight, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')?.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.7);
}
