import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { adminReader, readerInfo, type AdminResult, type ReaderInfo } from '../sheet/omrClient';
import { Icon } from './Icon';
import { Modal } from './Modal';

const NAMES: Record<string, string> = { gemini: 'Gemini (free)', claude: 'Claude (paid)' };
export const readerName = (p: string | null | undefined) => (p ? (NAMES[p] ?? p) : '');

/**
 * Settings → App → Music reader. Everyone sees which AI reads the photos (for the
 * whole site); changing it needs the admin password, checked by the server.
 */
export function MusicReader() {
  const [info, setInfo] = useState<ReaderInfo | null | undefined>(undefined);
  const [changing, setChanging] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void readerInfo().then((i) => live && setInfo(i));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="card stack" aria-labelledby="music-reader-title">
      <h2 id="music-reader-title">{t.settings.reader}</h2>
      <p className="muted">{t.settings.readerHelp}</p>
      <div className="spread reader-row">
        <strong data-testid="reader-now">{info === undefined ? t.common.loading : info ? t.settings.readerNow(readerName(info.provider)) : t.settings.readerUnknown}</strong>
        {info?.canChange && (
          <button className="btn" onClick={() => (setSaved(null), setChanging(true))} data-testid="reader-change">
            <Icon name="edit" /> {t.settings.readerChange}
          </button>
        )}
      </div>
      {saved && (
        <p className="notice good" role="status">
          {t.settings.readerSaved(readerName(saved))}
        </p>
      )}
      {changing && info && (
        <ChangeReader
          current={info.provider}
          onClose={() => setChanging(false)}
          onSaved={(p) => {
            setInfo({ ...info, provider: p });
            setSaved(p);
            setChanging(false);
          }}
        />
      )}
    </section>
  );
}

function ChangeReader({ current, onClose, onSaved }: { current: string | null; onClose: () => void; onSaved: (p: string) => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [options, setOptions] = useState<string[] | null>(null);
  const [locked, setLocked] = useState(false);

  const explain = (r: Exclude<AdminResult, { ok: true }>) => {
    if (r.reason === 'wrong') return t.settings.readerWrong(r.attemptsLeft);
    if (r.reason === 'locked') {
      setLocked(true);
      return t.settings.readerLocked(r.minutes);
    }
    if (r.reason === 'off') return t.settings.readerOff;
    return t.settings.readerFailed;
  };

  const run = async (provider?: string) => {
    setBusy(true);
    setProblem(null);
    const r = await adminReader(password, provider);
    setBusy(false);
    if (!r.ok) {
      if (r.reason === 'wrong') setPassword('');
      setProblem(explain(r));
      return;
    }
    if (provider) onSaved(r.provider);
    else setOptions(r.providers);
  };

  return (
    <Modal title={t.settings.readerPasswordTitle} onClose={onClose}>
      {!options ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (password && !busy && !locked) void run();
          }}
        >
          <p className="muted">{t.settings.readerPasswordHelp}</p>
          <div className="field">
            <label htmlFor="admin-password">{t.settings.readerPassword}</label>
            <input id="admin-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={locked} data-testid="admin-password" />
          </div>
          {problem && (
            <p className={`notice ${locked ? 'warn' : 'error'}`} role="alert">
              <Icon name={locked ? 'timer' : 'info'} /> {problem}
            </p>
          )}
          <button className="btn primary big" type="submit" disabled={!password || busy || locked}>
            <Icon name="lock" /> {t.settings.readerUnlock}
          </button>
        </form>
      ) : (
        <div className="stack">
          <p>{options.length > 1 ? t.settings.readerPick : t.settings.readerOnlyOne}</p>
          <div className="stack" role="group" aria-label={t.settings.readerPick}>
            {options.map((p) => (
              <button key={p} className={`btn big reader-option${p === current ? ' current' : ''}`} aria-pressed={p === current} disabled={busy} onClick={() => void run(p)}>
                <Icon name={p === current ? 'check_circle' : 'auto_awesome'} filled={p === current} /> {readerName(p)}
              </button>
            ))}
          </div>
          {problem && (
            <p className="notice error" role="alert">
              <Icon name="info" /> {problem}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
