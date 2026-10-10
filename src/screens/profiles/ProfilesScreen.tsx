import { useState } from 'react';
import { t } from '../../i18n';
import { useApp } from '../../app/state';
import { Link, navigate } from '../../app/router';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { createProfile } from '../../data/repo';
import { KidForm } from './KidForm';

export function ProfilesScreen() {
  const { profiles, selectProfile } = useApp();
  const [adding, setAdding] = useState(false);

  const pick = (id: string) => {
    selectProfile(id);
    navigate('/home');
  };

  return (
    <div className="page profiles">
      <div className="spread" style={{ marginBottom: 16 }}>
        <span className="brand" aria-hidden>
          <Icon name="music_note" filled /> {t.appName}
        </span>
        <Link to="/parent" className="btn ghost">
          <Icon name="shield_person" /> {t.nav.parents}
        </Link>
      </div>
      <h1 style={{ textAlign: 'center' }}>{t.profiles.title}</h1>
      {profiles && profiles.length === 0 && <p className="muted" style={{ textAlign: 'center' }}>{t.profiles.empty}</p>}
      <ul className="profile-grid" role="list">
        {profiles?.map((p) => (
          <li key={p.id}>
            <button className="profile-tile" onClick={() => pick(p.id)}>
              <Avatar id={p.avatar} size={112} />
              <span className="profile-name">{p.name}</span>
              <span className="muted">{t.instruments[p.instrument]}</span>
            </button>
          </li>
        ))}
        <li>
          <button className="profile-tile add" onClick={() => setAdding(true)} data-testid="add-kid">
            <span className="add-circle" aria-hidden>
              <Icon name="add" size={56} />
            </span>
            <span className="profile-name">{t.profiles.addKid}</span>
          </button>
        </li>
      </ul>
      <p style={{ textAlign: 'center', marginTop: 32 }}>
        <Link to="/privacy">{t.profiles.privacyLink}</Link>
      </p>
      {adding && (
        <Modal title={t.profiles.newKidTitle} onClose={() => setAdding(false)}>
          <KidForm
            submitLabel={t.profiles.create}
            onSubmit={async (k) => {
              const p = await createProfile({ ...k, difficulty: 'normal', weeklyGoalMinutes: 60 });
              setAdding(false);
              pick(p.id);
            }}
          />
        </Modal>
      )}
    </div>
  );
}
