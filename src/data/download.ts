/**
 * Saving files from the app: a plain download link on desktop and Android; on
 * iPhone and iPad the share sheet (which has "Save to Files"), since a download
 * link in an installed app opens a preview with no way back.
 */

export const MUSICXML_TYPE = 'application/vnd.recordare.musicxml+xml';

/** "Herman's hornpipe" → "Hermans-hornpipe.musicxml". Pure. */
export function musicFileName(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `${base || 'music'}.musicxml`;
}

function isAppleMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function clickDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Save a file for the user. Returns false if they closed the share sheet. */
export async function saveFile(text: string, name: string, type: string): Promise<boolean> {
  const blob = new Blob([text], { type });
  if (isAppleMobile() && typeof navigator.share === 'function' && typeof File !== 'undefined') {
    // Safari only shares types it knows; plain XML still keeps the .musicxml name.
    for (const t of [type, 'application/xml']) {
      const file = new File([text], name, { type: t });
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          return true;
        } catch (e) {
          if ((e as Error).name === 'AbortError') return false;
          break; // Not allowed here (e.g. no recent tap): fall back to a download.
        }
      }
    }
  }
  clickDownload(blob, name);
  return true;
}

export function downloadMusicXml(xml: string, title: string): Promise<boolean> {
  return saveFile(xml, musicFileName(title), MUSICXML_TYPE);
}
