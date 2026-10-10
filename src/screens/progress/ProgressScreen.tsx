import { useLiveQuery } from 'dexie-react-hooks';
import { t } from '../../i18n';
import { useApp } from '../../app/state';
import { BarChart, TrendLine } from '../../components/Charts';
import { Icon } from '../../components/Icon';
import { db } from '../../data/db';
import { BADGES, bestStreak, currentStreak, dailyMinutes, dateKey, practiceDays, scoreTrend, startOfWeek, totalMinutes } from '../../data/stats';

const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export default function ProgressScreen() {
  const { profile } = useApp();
  const sessions = useLiveQuery(() => (profile ? db.sessions.where('profileId').equals(profile.id).sortBy('startedAt') : []), [profile?.id]);
  const badges = useLiveQuery(() => (profile ? db.badges.where('profileId').equals(profile.id).toArray() : []), [profile?.id]);
  const pieces = useLiveQuery(() => db.pieces.toArray(), []);
  if (!profile || !sessions || !badges || !pieces) return <div className="page" aria-busy="true" />;

  const days = practiceDays(sessions);
  const today = new Date();
  const start = startOfWeek(today);
  start.setDate(start.getDate() - 7 * 4);
  const calendar = Array.from({ length: 35 }, (_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
  const fmt = new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long' });
  const daily = dailyMinutes(sessions, 14, today).map((d) => ({
    key: d.key,
    value: d.minutes,
    short: String(Number(d.key.slice(8))),
  }));
  const earned = new Set(badges.map((b) => b.badgeId));
  const bests = pieces
    .map((p) => ({ piece: p, trend: scoreTrend(sessions, p.id) }))
    .filter((x) => x.trend.length > 0)
    .sort((a, b) => Math.max(...b.trend.map((x) => x.score)) - Math.max(...a.trend.map((x) => x.score)));

  return (
    <div className="page progress">
      <h1>{t.progress.title}</h1>

      <section className="card">
        <div className="spread">
          <h2 className="row" style={{ margin: 0 }}>
            <Icon name="local_fire_department" filled className="flame" size={40} /> {t.home.streak(currentStreak(sessions, today))}
          </h2>
          <span className="muted">{t.progress.bestStreak(bestStreak(sessions))}</span>
        </div>
        <h3 style={{ marginTop: 16 }}>{t.progress.calendar}</h3>
        <div className="calendar" role="list" aria-label={t.progress.calendar}>
          {DAY_LETTERS.map((l, i) => (
            <span key={`h${i}`} className="cal-head" aria-hidden>
              {l}
            </span>
          ))}
          {calendar.map((d) => {
            const k = dateKey(d);
            const practised = days.has(k);
            const future = d > today;
            return (
              <span
                key={k}
                role="listitem"
                className={`cal-day${practised ? ' on' : ''}${future ? ' future' : ''}${k === dateKey(today) ? ' today' : ''}`}
                aria-label={t.progress.calendarDay(fmt.format(d), practised)}
              >
                {practised ? <Icon name="check" size={20} /> : d.getDate()}
              </span>
            );
          })}
        </div>
      </section>

      <section className="card">
        <h2>{t.progress.minutes}</h2>
        <BarChart data={daily} label={t.progress.minutesChart} />
        <p className="muted">{t.progress.totalMinutes(Math.round(totalMinutes(sessions)))}</p>
      </section>

      <section className="card">
        <h2>{t.progress.badges}</h2>
        <ul className="badge-grid" role="list">
          {BADGES.map((b) => {
            const has = earned.has(b);
            return (
              <li key={b} className={`badge${has ? ' earned' : ''}`}>
                <span className="badge-medal" aria-hidden>
                  <Icon name={has ? 'military_tech' : 'lock'} filled={has} size={44} />
                </span>
                <strong>{t.badges[b].name}</strong>
                <span className="muted small">{has ? t.badges[b].desc : t.progress.badgeLocked}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="card">
        <h2>{t.progress.bests}</h2>
        {bests.length === 0 && <p className="muted">{t.progress.noBests}</p>}
        <ul className="bests" role="list">
          {bests.map(({ piece, trend }) => (
            <li key={piece.id} className="best-row">
              <div>
                <strong>{piece.title}</strong>
                <div className="muted">{t.home.best(Math.max(...trend.map((x) => x.score)))}</div>
              </div>
              <TrendLine points={trend.slice(-12).map((x) => x.score)} label={t.progress.trend(piece.title)} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
