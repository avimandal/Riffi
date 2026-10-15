import type { ReactNode } from 'react';
import { t } from '../i18n';
import { Icon } from '../components/Icon';
import { PlayerSwitch } from '../components/PlayerSwitch';
import { Link } from './router';
import { useApp } from './state';

const NAV = [
  { to: '/home', icon: 'home', label: () => t.nav.home },
  { to: '/progress', icon: 'insights', label: () => t.nav.progress },
  { to: '/gadget', icon: 'music_note', label: () => t.nav.tools },
  { to: '/settings', icon: 'settings', label: () => t.nav.settings },
];

/**
 * The main screens (the bottom tabs) show the player switcher at the top, except
 * Tools: there the whole Tuner & Metronome (Start/Stop included) must fit on a phone.
 */
const MAIN = new Set(NAV.map((n) => n.to).filter((to) => to !== '/gadget'));

export function Layout({ children, nav, path }: { children: ReactNode; nav: boolean; path: string }) {
  const { online, profile } = useApp();
  return (
    <>
      <a className="skip-link" href="#main">
        {t.common.skipToContent}
      </a>
      {!online && (
        <div className="offline-banner" role="status">
          <Icon name="cloud_off" /> {t.common.offline}
        </div>
      )}
      <main id="main" tabIndex={-1}>
        {nav && profile && MAIN.has(path) && (
          <div className="app-topbar">
            <PlayerSwitch />
          </div>
        )}
        {children}
      </main>
      {nav && (
        <nav className="bottom-nav" aria-label={t.nav.main}>
          {NAV.map((n) => (
            <Link key={n.to} to={n.to} aria-current={path === n.to ? 'page' : undefined}>
              <Icon name={n.icon} />
              <span>{n.label()}</span>
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}
