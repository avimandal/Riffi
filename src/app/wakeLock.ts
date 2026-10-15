import { useEffect } from 'react';

interface Sentinel {
  release: () => Promise<void>;
  released?: boolean;
  addEventListener?: (type: 'release', fn: () => void) => void;
}
type WakeLockNavigator = Navigator & { wakeLock?: { request: (type: 'screen') => Promise<Sentinel> } };

/**
 * Keep the screen from dimming or locking while `active` (the metronome is
 * running, the tuner is listening, a practice run is going). Released as soon
 * as it's not; asked for again when the app comes back to the front while
 * still active (browsers drop the lock when the page is hidden). Where the
 * Screen Wake Lock API isn't there, or it's refused, nothing happens. It never
 * tries to keep listening once the phone is locked.
 */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const nav = typeof navigator !== 'undefined' ? (navigator as WakeLockNavigator) : undefined;
    if (!nav?.wakeLock) return;
    let lock: Sentinel | null = null;
    let stopped = false;
    const acquire = async () => {
      if (stopped || document.visibilityState !== 'visible' || (lock && !lock.released)) return;
      try {
        const l = await nav.wakeLock!.request('screen');
        if (stopped) void l.release().catch(() => undefined);
        else lock = l;
      } catch {
        // Not allowed (low battery, no user gesture yet…): fine, just no wake lock.
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
      lock = null;
    };
  }, [active]);
}
