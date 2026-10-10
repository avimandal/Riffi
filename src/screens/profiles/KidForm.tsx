import { useState } from 'react';
import { INSTRUMENTS, type Instrument } from '../../config';
import { t } from '../../i18n';
import { Avatar, AVATAR_IDS } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { INSTRUMENT_ICON } from '../../components/instrumentIcons';

export interface KidDraft {
  name: string;
  avatar: string;
  instrument: Instrument;
}

export function KidForm({ initial, onSubmit, submitLabel }: { initial?: KidDraft; onSubmit: (k: KidDraft) => void; submitLabel: string }) {
  const [name, setName] = useState(initial?.name ?? '');
  const [avatar, setAvatar] = useState(initial?.avatar ?? AVATAR_IDS[Math.floor(Math.random() * AVATAR_IDS.length)]);
  const [instrument, setInstrument] = useState<Instrument>(initial?.instrument ?? 'violin');
  const ok = name.trim().length > 0;
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (ok) onSubmit({ name: name.trim().slice(0, 30), avatar, instrument });
      }}
    >
      <div className="field">
        <label htmlFor="kid-name">{t.profiles.nameLabel}</label>
        <input
          id="kid-name"
          type="text"
          value={name}
          maxLength={30}
          autoComplete="off"
          placeholder={t.profiles.namePlaceholder}
          onChange={(e) => setName(e.target.value)}
          aria-describedby="kid-name-help"
        />
        <span id="kid-name-help" className="muted" style={{ fontSize: 16 }}>
          {t.profiles.nameHelp}
        </span>
      </div>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 8 }}>{t.profiles.avatarLabel}</legend>
        <div className="avatar-grid">
          {AVATAR_IDS.map((a) => (
            <button
              type="button"
              key={a}
              className="avatar-choice"
              aria-pressed={avatar === a}
              aria-label={t.profiles.avatarName(t.avatars[a])}
              onClick={() => setAvatar(a)}
            >
              <Avatar id={a} size={56} />
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontWeight: 600, marginBottom: 8 }}>{t.profiles.instrumentLabel}</legend>
        <div className="segmented">
          {INSTRUMENTS.map((i) => (
            <button type="button" key={i} className="btn" aria-pressed={instrument === i} onClick={() => setInstrument(i)}>
              <Icon name={INSTRUMENT_ICON[i]} /> {t.instruments[i]}
            </button>
          ))}
        </div>
      </fieldset>
      <button type="submit" className="btn primary big" disabled={!ok}>
        {submitLabel}
      </button>
    </form>
  );
}
