import { useEffect, useState } from 'react';
import { t } from '../i18n';

/** Registers the service worker and offers updates (never reloads mid-practice by itself). */
export function UpdatePrompt() {
  const [update, setUpdate] = useState<null | (() => void)>(null);
  useEffect(() => {
    if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;
    let cancelled = false;
    import('virtual:pwa-register')
      .then(({ registerSW }) => {
        const updateSW = registerSW({
          onNeedRefresh() {
            if (!cancelled) setUpdate(() => () => updateSW(true));
          },
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  if (!update) return null;
  return (
    <div className="toast" role="status">
      <span>{t.common.updateReady}</span>
      <button className="btn primary" onClick={update}>
        {t.common.updateNow}
      </button>
      <button className="btn ghost" style={{ color: 'inherit' }} onClick={() => setUpdate(null)}>
        {t.common.later}
      </button>
    </div>
  );
}
