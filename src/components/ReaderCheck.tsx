import { useState } from 'react';
import { t } from '../i18n';
import { checkMusicReader, type CheckReport } from '../sheet/omrClient';
import { adviseFromReport, type CheckLine } from '../sheet/readerCheck';
import { Icon } from './Icon';

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
    </div>
  );
}
