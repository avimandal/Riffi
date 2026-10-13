import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { t } from '../../i18n';
import { useApp } from '../../app/state';
import { Link, navigate } from '../../app/router';
import { GoalRing } from '../../components/GoalRing';
import { Icon } from '../../components/Icon';
import { InstallPrompt } from '../../components/InstallPrompt';
import { PieceMenu } from '../../components/PieceMenu';
import { db } from '../../data/db';
import { bestScore, currentStreak, weekMinutes } from '../../data/stats';
import type { Piece } from '../../data/types';

export function HomeScreen() {
  const { profile } = useApp();
  const pieces = useLiveQuery(() => db.pieces.orderBy('updatedAt').reverse().toArray(), []);
  const sessions = useLiveQuery(() => (profile ? db.sessions.where('profileId').equals(profile.id).sortBy('startedAt') : []), [profile?.id]);
  const [menuFor, setMenuFor] = useState<Piece | null>(null);
  if (!profile) return null;

  const streak = sessions ? currentStreak(sessions) : 0;
  const minutes = sessions ? Math.round(weekMinutes(sessions)) : 0;
  const goal = profile.weeklyGoalMinutes;
  const last = sessions?.[sessions.length - 1];
  const lastPiece = last ? pieces?.find((p) => p.id === last.pieceId) : undefined;

  return (
    <div className="page home">
      <h1 className="sr-only">{t.nav.home}</h1>

      <InstallPrompt />

      <section className="home-stats" aria-label={t.progress.title}>
        <div className="card stat-card" aria-label={t.home.streakLabel(streak)}>
          <Icon name="local_fire_department" filled={streak > 0} size={56} className="flame" />
          <div>
            <div className="stat-big">{streak}</div>
            <div className="muted">{t.home.streak(streak)}</div>
          </div>
        </div>
        <div className="card stat-card">
          <GoalRing done={minutes} goal={goal} size={104} label={t.home.weekGoal(minutes, goal)} />
          <div className="muted">{minutes >= goal ? t.home.weekGoalDone : t.home.weekGoal(minutes, goal)}</div>
        </div>
      </section>

      {lastPiece && (
        <section className="card keep-going">
          <h2>{t.home.keepGoing}</h2>
          <p className="muted">{t.home.keepGoingWith(lastPiece.title)}</p>
          <div className="row">
            <button className="btn primary big" onClick={() => navigate(`/practice/${lastPiece.id}`)}>
              <Icon name="play_arrow" filled /> {t.home.practise}
            </button>
            {last?.score !== undefined && <span className="chip">{t.home.lastScore(last.score)}</span>}
          </div>
        </section>
      )}

      <section>
        <div className="spread" style={{ margin: '24px 0 12px' }}>
          <h2 style={{ margin: 0 }}>{t.home.library}</h2>
          <Link to="/add" className="btn primary big" data-testid="add-music">
            <Icon name="add_a_photo" filled /> {t.home.addMusic}
          </Link>
        </div>
        {pieces && pieces.length === 0 && <p className="notice">{t.home.libraryEmpty}</p>}
        <ul className="grid piece-grid" role="list">
          {pieces?.map((p) => {
            const best = sessions ? bestScore(sessions, p.id) : undefined;
            return (
              <li key={p.id} className="card piece-card">
                <button className="piece-main" onClick={() => navigate(`/practice/${p.id}`)} aria-label={`${t.home.practise}: ${p.title}`}>
                  {p.thumbnails[0] ? (
                    <img src={p.thumbnails[0]} alt="" className="piece-thumb" />
                  ) : (
                    <span className="piece-thumb placeholder" aria-hidden>
                      <Icon name="queue_music" size={48} />
                    </span>
                  )}
                  <span className="piece-title">{p.title}</span>
                  <span className="chip">{best !== undefined ? t.home.best(best) : t.home.notPlayedYet}</span>
                </button>
                <button className="btn icon-only round ghost piece-more" aria-label={t.home.moreFor(p.title)} onClick={() => setMenuFor(p)} data-testid="piece-more">
                  <Icon name="more_horiz" />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {menuFor && <PieceMenu piece={menuFor} from="home" onClose={() => setMenuFor(null)} />}
    </div>
  );
}
