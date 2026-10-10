import type { ReactNode } from 'react';
import { t } from '../i18n';
import { Icon } from '../components/Icon';
import { Link } from './router';
import { useApp } from './state';

const NAV = [
  { to: '/home', icon: 'home', label: () => t.nav.home },
  { to: '/progress', icon: 'insights', label: () => t.nav.progress },
  { to: '/', icon: 'group', label: () => t.nav.switchKid },
  { to: '/parent', icon: 'shield_person', label: () => t.nav.parents },
];

export function Layout({ children, nav, path }: { children: ReactNode; nav: boolean; path: string }) {
  const { online } = useApp();
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
