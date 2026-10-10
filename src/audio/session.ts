/**
 * Make Riffi's sounds (metronome clicks, reference tones) play on iPhone and iPad
 * even when the ringer switch is on silent, and keep them on the loudspeaker
 * while the mic is listening.
 *
 * - Where Safari has the Audio Session API (`navigator.audioSession`, iOS 16.4+/17):
 *   'playback' while only playing sound (ignores the silent switch), and
 *   'play-and-record' while the mic is on (also ignores the switch, and Safari
 *   routes it to the loudspeaker rather than the earpiece). It's set before the
 *   mic opens, because switching to 'playback' mid-recording would stop the mic.
 * - Older iOS: a silent, looping <audio> element. Once a media element plays, iOS
 *   treats the page as media playback, so Web Audio is no longer muted by the
 *   switch. It's started from the same tap that starts the audio, paused while
 *   the app is hidden (so it doesn't sit in the lock screen's Now Playing), and
 *   restarted after the mic opens to pull output back to the loudspeaker.
 * Elsewhere (Android, desktop) none of this is needed, and nothing is done.
 */

type SessionType = 'auto' | 'playback' | 'transient' | 'transient-solo' | 'ambient' | 'play-and-record';
interface AudioSessionLike {
  type: SessionType;
}

let micUsers = 0;
let silentEl: HTMLAudioElement | null = null;
let silentUrl: string | null = null;
let visibilityHooked = false;

function audioSession(): AudioSessionLike | null {
  const nav = globalThis.navigator as (Navigator & { audioSession?: AudioSessionLike }) | undefined;
  return nav?.audioSession ?? null;
}

/** iPhone, iPod or iPad (iPadOS reports itself as a Mac with touch). */
export function isAppleMobile(): boolean {
  const nav = globalThis.navigator;
  if (!nav) return false;
  return /iPhone|iPad|iPod/.test(nav.userAgent) || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
}

function setType(type: SessionType) {
  const s = audioSession();
  if (!s) return false;
  try {
    if (s.type !== type) s.type = type;
    return true;
  } catch {
    return false;
  }
}

/** A tiny silent WAV (8 kHz, 8-bit mono; 0x80 is silence for 8-bit PCM). Pure. */
export function silentWav(seconds = 0.5, rate = 8000): Uint8Array {
  const n = Math.round(seconds * rate);
  const buf = new Uint8Array(44 + n);
  const v = new DataView(buf.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true); // byte rate
  v.setUint16(32, 1, true); // block align
  v.setUint16(34, 8, true); // bits per sample
  text(36, 'data');
  v.setUint32(40, n, true);
  buf.fill(0x80, 44);
  return buf;
}

function playSilentLoop() {
  const doc = globalThis.document;
  if (!doc) return;
  if (!silentEl) {
    silentUrl = URL.createObjectURL(new Blob([silentWav() as BlobPart], { type: 'audio/wav' }));
    const el = doc.createElement('audio');
    el.src = silentUrl;
    el.loop = true;
    el.preload = 'auto';
    el.setAttribute('playsinline', '');
    el.setAttribute('x-webkit-airplay', 'deny');
    (el as HTMLAudioElement & { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
    el.setAttribute('aria-hidden', 'true');
    el.dataset.riffiSilent = '';
    silentEl = el;
  }
  if (!visibilityHooked) {
    visibilityHooked = true;
    doc.addEventListener('visibilitychange', () => {
      // Hidden: let go, so it doesn't show in Now Playing. It's restarted by the next tap.
      if (doc.visibilityState === 'hidden') silentEl?.pause();
    });
  }
  if (silentEl.paused) silentEl.play()?.catch(() => undefined);
}

/**
 * Call from the tap that starts sound (before any await), every time: it's cheap
 * and re-arms the fallback if iOS paused it.
 */
export function prepareForPlayback() {
  if (setType(micUsers > 0 ? 'play-and-record' : 'playback')) return;
  if (isAppleMobile()) playSilentLoop();
}

/** Call just before opening the mic. */
export function micWillStart() {
  micUsers++;
  setType('play-and-record');
}

/** Call once the mic is open: on older iOS, re-kick the silent loop so output stays on the loudspeaker. */
export function micStarted() {
  if (!audioSession() && isAppleMobile() && silentEl) {
    silentEl.pause();
    playSilentLoop();
  }
}

/** Call when the mic closes (or failed to open). */
export function micStopped() {
  micUsers = Math.max(0, micUsers - 1);
  if (micUsers === 0) setType('playback');
}

/** For tests. */
export function resetAudioSessionForTests() {
  micUsers = 0;
  silentEl?.pause();
  silentEl = null;
  if (silentUrl) URL.revokeObjectURL(silentUrl);
  silentUrl = null;
  visibilityHooked = false;
}
