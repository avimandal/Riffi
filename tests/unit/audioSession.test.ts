import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAppleMobile, micStarted, micStopped, micWillStart, prepareForPlayback, resetAudioSessionForTests, silentWav } from '../../src/audio/session';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';

/** A fake <audio> element and document that record what happened. */
function fakeDom() {
  const els: { play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn>; paused: boolean; loop?: boolean; src?: string; attrs: Record<string, string>; dataset: Record<string, string> }[] = [];
  const listeners: Record<string, () => void> = {};
  const doc = {
    visibilityState: 'visible',
    createElement: () => {
      const el = {
        paused: true,
        attrs: {} as Record<string, string>,
        dataset: {} as Record<string, string>,
        setAttribute(k: string, v: string) {
          this.attrs[k] = v;
        },
        play: vi.fn(function (this: { paused: boolean }) {
          this.paused = false;
          return Promise.resolve();
        }),
        pause: vi.fn(function (this: { paused: boolean }) {
          this.paused = true;
        }),
      };
      els.push(el as never);
      return el;
    },
    addEventListener: (type: string, fn: () => void) => {
      listeners[type] = fn;
    },
  };
  vi.stubGlobal('document', doc);
  return { els, listeners, doc };
}

afterEach(() => {
  resetAudioSessionForTests();
  vi.unstubAllGlobals();
});

describe('audio session (iPhone silent switch and loudspeaker)', () => {
  it('uses navigator.audioSession: playback, play-and-record while the mic is on, then back', () => {
    const session = { type: 'auto' };
    vi.stubGlobal('navigator', { userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5, audioSession: session });
    const { els } = fakeDom();

    prepareForPlayback();
    expect(session.type).toBe('playback');

    micWillStart();
    expect(session.type).toBe('play-and-record');
    micStarted();
    // A tap during practice keeps play-and-record (switching to playback would stop the mic).
    prepareForPlayback();
    expect(session.type).toBe('play-and-record');

    // Two mics (e.g. sound check inside practice): only the last one releases it.
    micWillStart();
    micStopped();
    expect(session.type).toBe('play-and-record');
    micStopped();
    expect(session.type).toBe('playback');

    // The fallback isn't needed when the API exists.
    expect(els).toHaveLength(0);
  });

  it('falls back to a silent looping <audio> on older iOS, paused when hidden', () => {
    vi.stubGlobal('navigator', { userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5 });
    const { els, listeners, doc } = fakeDom();

    prepareForPlayback();
    expect(els).toHaveLength(1);
    const el = els[0];
    expect(el.loop).toBe(true);
    expect(el.src).toMatch(/^blob:/);
    expect(el.attrs.playsinline).toBe('');
    expect(el.play).toHaveBeenCalledTimes(1);

    // Already playing: a second tap doesn't restart it or make another.
    prepareForPlayback();
    expect(el.play).toHaveBeenCalledTimes(1);
    expect(els).toHaveLength(1);

    // Hidden: let go. The next tap starts it again.
    doc.visibilityState = 'hidden';
    listeners.visibilitychange();
    expect(el.pause).toHaveBeenCalled();
    doc.visibilityState = 'visible';
    prepareForPlayback();
    expect(el.play).toHaveBeenCalledTimes(2);

    // When the mic opens, it's re-kicked to pull output back to the loudspeaker.
    micWillStart();
    micStarted();
    expect(el.play).toHaveBeenCalledTimes(3);
    micStopped();
  });

  it('does nothing on Android or desktop without the API', () => {
    vi.stubGlobal('navigator', { userAgent: ANDROID, platform: 'Linux armv8l', maxTouchPoints: 5 });
    const { els } = fakeDom();
    prepareForPlayback();
    micWillStart();
    micStarted();
    micStopped();
    expect(els).toHaveLength(0);
  });

  it('recognises iPadOS, which reports itself as a Mac with touch', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 });
    expect(isAppleMobile()).toBe(true);
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 });
    expect(isAppleMobile()).toBe(false);
  });

  it('an audioSession that throws is ignored, not fatal', () => {
    const session = {
      get type() {
        return 'auto';
      },
      set type(_v: string) {
        throw new Error('nope');
      },
    };
    vi.stubGlobal('navigator', { userAgent: IPHONE, platform: 'iPhone', maxTouchPoints: 5, audioSession: session });
    const { els } = fakeDom();
    expect(() => prepareForPlayback()).not.toThrow();
    // Couldn't set it, so the fallback takes over.
    expect(els).toHaveLength(1);
  });

  it('builds a valid silent WAV', () => {
    const wav = silentWav(0.5, 8000);
    const text = (a: number, b: number) => String.fromCharCode(...wav.slice(a, b));
    const v = new DataView(wav.buffer);
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 12)).toBe('WAVE');
    expect(v.getUint32(4, true)).toBe(wav.length - 8);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(8000);
    expect(v.getUint32(40, true)).toBe(4000);
    expect(wav.length).toBe(44 + 4000);
    expect(wav.slice(44).every((b) => b === 0x80)).toBe(true);
  });
});
