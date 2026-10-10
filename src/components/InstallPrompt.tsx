import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { Icon } from './Icon';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferred: BeforeInstallPromptEvent | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
  });
}

const DISMISS_KEY = 'riffi.installDismissed';

function standalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** "Add Riffi to your home screen": the browser's prompt where there is one, a how-to hint on iPad/iPhone. */
export function InstallPrompt() {
  const [ready, setReady] = useState(!!deferred);
  const [hidden, setHidden] = useState(() => {
    try {
      return standalone() || window.localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return standalone();
    }
  });
  useEffect(() => {
    const on = () => setReady(true);
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);
  if (hidden || (!ready && !isIos())) return null;
  const dismiss = () => {
    setHidden(true);
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // fine
    }
  };
  return (
    <aside className="card install-card" aria-label={t.install.title}>
      <Icon name="install_mobile" size={40} />
      <div style={{ flex: 1 }}>
        <strong>{t.install.title}</strong>
        {!ready && <div className="muted small">{t.install.iosHint}</div>}
      </div>
      {ready && (
        <button
          className="btn primary"
          onClick={async () => {
            await deferred?.prompt();
            deferred = null;
            dismiss();
          }}
        >
          {t.install.button}
        </button>
      )}
      <button className="btn icon-only round ghost" aria-label={t.common.close} onClick={dismiss}>
        <Icon name="close" />
      </button>
    </aside>
  );
}
