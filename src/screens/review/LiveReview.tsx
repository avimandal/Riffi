import { useMemo } from 'react';
import { t } from '../../i18n';
import { navigate } from '../../app/router';
import { Icon } from '../../components/Icon';
import { SheetView } from '../../components/SheetView';
import { parseMusicXml } from '../../sheet/musicxml';
import type { LiveRead } from '../add/liveRead';
import { errorText, progressText } from '../add/readText';

/** The review screen while a page is being read: every line's progress, and the music read so far. */
export function LiveReview({ live }: { live: LiveRead }) {
  const xml = live.partial?.musicxml ?? null;
  const score = useMemo(() => {
    try {
      return xml ? parseMusicXml(xml) : null;
    } catch {
      return null;
    }
  }, [xml]);
  const lines = live.partial?.lines ?? [];
  const pages = Math.max(1, ...lines.map((l) => l.page));
  const busy = live.progress ? progressText(live.progress) : null;

  return (
    <div className="page wide review" aria-busy={live.status === 'reading'}>
      <div className="topbar">
        <button className="btn icon-only round ghost" aria-label={t.common.back} onClick={() => navigate('/home')}>
          <Icon name="arrow_back" />
        </button>
        <h1>{t.review.liveTitle}</h1>
      </div>
      {live.status === 'failed' ? (
        <div className="stack">
          <p className="notice error" role="alert">
            <Icon name="info" /> {errorText(live.error)}
          </p>
          <button className="btn primary big" onClick={() => navigate('/add')}>
            <Icon name="arrow_back" /> {t.review.backToAdd}
          </button>
        </div>
      ) : (
        <>
          <p className="muted">{t.review.liveHelp}</p>
          {busy && (
            <p className="live-progress" role="status" aria-live="polite">
              <span className="spinner small" aria-hidden /> {busy.label}
            </p>
          )}
          {lines.length > 0 && (
            <ol className="line-status" aria-label={t.review.liveTitle} data-testid="line-status">
              {lines.map((l) => (
                <li key={`${l.page}-${l.line}`} className={`line-chip ${l.status}`} data-status={l.status}>
                  <Icon name={l.status === 'done' ? 'check_circle' : l.status === 'failed' ? 'priority_high' : 'more_horiz'} filled={l.status === 'done'} />
                  <span>
                    {t.review.lineLabel(l.page, l.line, pages)}: {t.review.lineStatus[l.status]}
                  </span>
                </li>
              ))}
            </ol>
          )}
          {score && xml && <SheetView xml={xml} score={score} label={t.practice.sheetLabel} style={{ maxHeight: '62vh' }} />}
        </>
      )}
    </div>
  );
}
