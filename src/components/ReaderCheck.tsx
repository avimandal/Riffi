import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { useApp } from '../app/state';
import { checkMusicReader, readerInfo, type CheckReport } from '../sheet/omrClient';
import { adviseFromReport, type CheckLine } from '../sheet/readerCheck';
import { Icon } from './Icon';

const PROVIDER_NAMES: Record<string, string> = { gemini: 'Google Gemini', claude: 'Anthropic Claude' };

/**
 * Hidden unless the server has keys for more than one AI: choose which one reads
 * the next scans on this device, to compare them on the same photo.
 */
function ProviderChoice() {
  const { settings, updateSettings } = useApp();
  const [providers, setProviders] = useState<{ list: string[]; def: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    void readerInfo().then((info) => live && info && setProviders({ list: info.providers, def: info.default }));
    return () => {
      live = false;
    };
  }, []);
  if (!providers || providers.list.length < 2) return null;
  return (
    <details className="provider-choice" data-testid="provider-choice">
      <summary>{t.parent.readerCompare}</summary>
      <p className="muted">{t.parent.readerCompareHelp}</p>
      <label htmlFor="reader-provider">{t.parent.readerProvider}</label>
      <select id="reader-provider" value={settings.readerProvider ?? ''} onChange={(e) => void updateSettings({ readerProvider: e.target.value })}>
        <option value="">{t.parent.readerProviderDefault(PROVIDER_NAMES[providers.def ?? ''] ?? providers.def ?? '')}</option>
        {providers.list.map((p) => (
          <option key={p} value={p}>
            {PROVIDER_NAMES[p] ?? p}
          </option>
        ))}
      </select>
    </details>
  );
}

/** Parents → Settings → Check music reader. */
export function ReaderCheck() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ raw: CheckReport; lines: CheckLine[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const run = async () => {
    setBusy(true);
    setCopied(false);
    try {
      const raw = await checkMusicReader();
      setResult({ raw, lines: adviseFromReport(raw) });
    } catch {
      const raw: CheckReport = { report: { code: 'network', error: t.parent.readerCheckOffline }, streamed: false, totalMs: 0 };
      setResult({ raw, lines: adviseFromReport(raw) });
    } finally {
      setBusy(false);
    }
  };
  const text = result
    ? [`Riffi music reader check (ref ${String(result.raw.report.ref ?? '-')})`, ...result.lines.map((l) => `${l.ok ? 'OK ' : 'NO '} ${l.label}: ${l.detail}`), '', JSON.stringify(result.raw, null, 1)].join('\n')
    : '';
  return (
    <div className="stack">
      <p className="muted">{t.parent.readerCheckHelp}</p>
      <button className="btn primary" onClick={run} disabled={busy} data-testid="reader-check">
        <Icon name={busy ? 'graphic_eq' : 'build'} /> {busy ? t.parent.readerChecking : t.parent.readerCheck}
      </button>
      {result && (
        <>
          <ul className="check-list" aria-live="polite">
            {result.lines.map((l) => (
              <li key={l.label} className={l.ok ? 'ok' : 'bad'}>
                <Icon name={l.ok ? 'check_circle' : 'info'} filled />
                <div>
                  <strong>{l.label}</strong>: {l.detail}
                  {l.advice && <div className="muted small">{l.advice}</div>}
                </div>
              </li>
            ))}
          </ul>
          <button
            className="btn"
            onClick={() => {
              void navigator.clipboard?.writeText(text).then(() => setCopied(true));
            }}
          >
            <Icon name="content_copy" /> {copied ? t.parent.readerCopied : t.parent.readerCopy}
          </button>
          <details>
            <summary>{t.parent.readerDetails}</summary>
            <pre className="check-raw">{text}</pre>
          </details>
        </>
      )}
      <ProviderChoice />
    </div>
  );
}
