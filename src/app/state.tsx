import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import { getDeviceSettings, updateDeviceSettings } from '../data/repo';
import { DEFAULT_DEVICE_SETTINGS, type DeviceSettings, type Profile } from '../data/types';

const PROFILE_KEY = 'riffi.currentProfile';

interface AppState {
  profile: Profile | undefined;
  profiles: Profile[] | undefined;
  selectProfile: (id: string | null) => void;
  settings: DeviceSettings;
  updateSettings: (changes: Partial<DeviceSettings>) => Promise<void>;
  online: boolean;
}

const Ctx = createContext<AppState | null>(null);

function readStoredProfile(): string | null {
  try {
    return window.localStorage.getItem(PROFILE_KEY);
  } catch {
    return null;
  }
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [profileId, setProfileId] = useState<string | null>(readStoredProfile);
  const profiles = useLiveQuery(() => db.profiles.orderBy('createdAt').toArray(), []);
  const [settings, setSettings] = useState<DeviceSettings>(DEFAULT_DEVICE_SETTINGS);
  const [online, setOnline] = useState(typeof navigator === 'undefined' ? true : navigator.onLine);

  useEffect(() => {
    getDeviceSettings().then(setSettings).catch(() => undefined);
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', settings.theme);
  }, [settings.theme]);

  const selectProfile = useCallback((id: string | null) => {
    setProfileId(id);
    try {
      if (id) window.localStorage.setItem(PROFILE_KEY, id);
      else window.localStorage.removeItem(PROFILE_KEY);
    } catch {
      // Private mode: fine, we just won't remember.
    }
  }, []);

  const updateSettings = useCallback(async (changes: Partial<DeviceSettings>) => {
    setSettings(await updateDeviceSettings(changes));
  }, []);

  const profile = profiles?.find((p) => p.id === profileId);
  const value = useMemo(
    () => ({ profile, profiles, selectProfile, settings, updateSettings, online }),
    [profile, profiles, selectProfile, settings, updateSettings, online],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}
