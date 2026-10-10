import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { BASE_PATH } from '../config';

/** Tiny history router that respects the build-time base path. */

const listeners = new Set<() => void>();

function stripBase(pathname: string): string {
  const base = BASE_PATH.replace(/\/$/, '');
  const p = base && pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  return p.startsWith('/') ? p : `/${p}`;
}

export function currentPath(): string {
  return stripBase(window.location.pathname) + window.location.search;
}

export function href(path: string): string {
  return BASE_PATH.replace(/\/$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

export function navigate(path: string, opts: { replace?: boolean } = {}) {
  const url = href(path);
  if (opts.replace) window.history.replaceState(null, '', url);
  else window.history.pushState(null, '', url);
  listeners.forEach((l) => l());
  window.scrollTo({ top: 0 });
}

export function back(fallback = '/home') {
  if (window.history.length > 1) window.history.back();
  else navigate(fallback, { replace: true });
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath());
  useEffect(() => {
    const update = () => setPath(currentPath());
    listeners.add(update);
    window.addEventListener('popstate', update);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', update);
    };
  }, []);
  return path;
}

export interface Match {
  params: Record<string, string>;
  query: URLSearchParams;
}

/** Match "/practice/:id" style patterns. */
export function matchPath(pattern: string, path: string): Match | null {
  const [pathname, search = ''] = path.split('?');
  const a = pattern.split('/').filter(Boolean);
  const b = pathname.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return { params, query: new URLSearchParams(search) };
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      {...rest}
      href={href(to)}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}
