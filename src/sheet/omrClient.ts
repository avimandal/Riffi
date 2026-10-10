import { OMR_ENDPOINT, type Instrument } from '../config';

export interface OmrResult {
  musicxml: string;
  warnings: string[];
}

export type OmrErrorKind = 'offline' | 'tooBig' | 'rateLimited' | 'unreadable' | 'server';

export class OmrError extends Error {
  constructor(readonly kind: OmrErrorKind, message?: string) {
    super(message ?? kind);
  }
}

export interface OmrProgress {
  /** 0-based page currently uploading, or `pages` when the upload is done and the server is reading. */
  page: number;
  pages: number;
  uploaded: boolean;
}

/** Send prepared pages to the sheet-reading endpoint. Uses XHR for upload progress. */
export function readSheetMusic(pages: Blob[], instrument: Instrument, onProgress?: (p: OmrProgress) => void): Promise<OmrResult> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return Promise.reject(new OmrError('offline'));
  const form = new FormData();
  pages.forEach((p, i) => form.append('pages[]', p, `page-${i + 1}.jpg`));
  form.append('instrument', instrument);
  const sizes = pages.map((p) => p.size);
  const total = sizes.reduce((a, b) => a + b, 0);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', OMR_ENDPOINT);
    xhr.responseType = 'json';
    xhr.timeout = 240_000;
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const sent = (e.loaded / e.total) * total;
      let acc = 0;
      let page = 0;
      for (; page < sizes.length - 1; page++) {
        acc += sizes[page];
        if (sent < acc) break;
      }
      onProgress?.({ page, pages: pages.length, uploaded: false });
    };
    xhr.upload.onload = () => onProgress?.({ page: pages.length, pages: pages.length, uploaded: true });
    xhr.onerror = () => reject(new OmrError(navigator.onLine === false ? 'offline' : 'server'));
    xhr.ontimeout = () => reject(new OmrError('server', 'timeout'));
    xhr.onload = () => {
      const body = xhr.response as Partial<OmrResult> & { error?: string; code?: string };
      if (xhr.status === 200 && body && typeof body.musicxml === 'string') {
        resolve({ musicxml: body.musicxml, warnings: Array.isArray(body.warnings) ? body.warnings : [] });
        return;
      }
      if (xhr.status === 413) reject(new OmrError('tooBig'));
      else if (xhr.status === 429) reject(new OmrError('rateLimited'));
      else if (xhr.status === 422) reject(new OmrError('unreadable', body?.error));
      else reject(new OmrError('server', body?.error));
    };
    onProgress?.({ page: 0, pages: pages.length, uploaded: false });
    xhr.send(form);
  });
}
