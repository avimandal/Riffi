import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { t } from '../../i18n';
import { useApp } from '../../app/state';
import { Link, navigate } from '../../app/router';
import { Avatar } from '../../components/Avatar';
import { GoalRing } from '../../components/GoalRing';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { db } from '../../data/db';
import { deletePiece } from '../../data/repo';
import { bestScore, currentStreak, weekMinutes } from '../../data/stats';
import type { Piece } from '../../data/types';

function greeting(name: string, now = new Date()) {
  const h = now.getHours();
  if (h < 11) return t.home.greetingMorning(name);
  if (h >= 18) return t.home.greetingEvening(name);
  return t.home.greeting(name);
}

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
      <header className="spread home-head">
        <div className="row">
          <Avatar id={profile.avatar} size={64} />
          <h1 style={{ margin: 0 }}>{greeting(profile.name)}</h1>
        </div>
      </header>

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
                <button className="btn icon-only round ghost piece-more" aria-label={`${t.common.edit}: ${p.title}`} onClick={() => setMenuFor(p)}>
                  <Icon name="more_vert" />
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      {menuFor && (
        <Modal title={menuFor.title} onClose={() => setMenuFor(null)}>
          <div className="stack">
            <button className="btn primary big" onClick={() => navigate(`/practice/${menuFor.id}`)}>
              <Icon name="play_arrow" filled /> {t.home.practise}
            </button>
            <button className="btn big" onClick={() => navigate(`/review/${menuFor.id}`)}>
              <Icon name="edit" /> {t.home.editPiece}
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                if (window.confirm(t.home.confirmDelete(menuFor.title))) {
                  await deletePiece(menuFor.id);
                  setMenuFor(null);
                }
              }}
            >
              <Icon name="delete" /> {t.home.deletePiece}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
