import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../data/db';
import type { ReadTimings } from '../sheet/reader';
import { t } from '../i18n';
import { checkMusicReader, type CheckReport } from '../sheet/omrClient';
import { adviseFromReport, timingSummary, type CheckLine } from '../sheet/readerCheck';
import { Icon } from './Icon';

/** Settings → App → Check music reader. */
export function ReaderCheck() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ raw: CheckReport; lines: CheckLine[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const last = useLiveQuery(() => db.settings.get('lastReadTimings'), [])?.value as (ReadTimings & { at: number }) | undefined;
  const run = async () => {
    setBusy(true);
    setCopied(false);
    try {
      const raw = await checkMusicReader();
      setResult({ raw, lines: adviseFromReport(raw) });
    } catch {
      const raw: CheckReport = { report: { code: 'network', error: t.settings.readerCheckOffline }, streamed: false, totalMs: 0 };
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
      <p className="muted">{t.settings.readerCheckHelp}</p>
      {last && (
        <p className="small" data-testid="last-read">
          <strong>{t.settings.lastRead(new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(last.at))}</strong> {timingSummary(last)}
        </p>
      )}
      <button className="btn primary" onClick={run} disabled={busy} data-testid="reader-check">
        <Icon name={busy ? 'graphic_eq' : 'build'} /> {busy ? t.settings.readerChecking : t.settings.readerCheck}
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
            <Icon name="content_copy" /> {copied ? t.settings.readerCopied : t.settings.readerCopy}
          </button>
          <details>
            <summary>{t.settings.readerDetails}</summary>
            <pre className="check-raw">{text}</pre>
          </details>
        </>
      )}
    </div>
  );
}
