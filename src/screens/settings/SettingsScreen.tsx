import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DIFFICULTIES, type Difficulty, type MetronomeMode } from '../../config';
import { t } from '../../i18n';
import { useApp } from '../../app/state';
import { back, navigate } from '../../app/router';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { MusicReader } from '../../components/MusicReader';
import { SoundCheck } from '../../components/SoundCheck';
import { ReaderCheck } from '../../components/ReaderCheck';
import { canVibrate } from '../../audio/metronome';
import { BackupError, backupFileName, exportBackup, importBackup } from '../../data/backup';
import { db } from '../../data/db';
import { deleteEverything, deleteProfile, updateProfile } from '../../data/repo';
import { weeklySummary } from '../../data/stats';
import type { DeviceSettings, Profile } from '../../data/types';
import { KidForm } from '../profiles/KidForm';
import { PrivacyContent } from '../privacy/PrivacyScreen';

type Tab = 'summary' | 'kids' | 'settings' | 'backup' | 'privacy';

export default function SettingsScreen() {
  const [tab, setTab] = useState<Tab>('summary');
  const { profile } = useApp();

  return (
    <div className="page settings">
      <div className="topbar">
        {!profile && (
          <button className="btn icon-only round ghost" aria-label={t.common.back} onClick={() => back('/')}>
            <Icon name="arrow_back" />
          </button>
        )}
        <h1>{t.settings.title}</h1>
      </div>
      <div className="tabs" role="tablist" aria-label={t.settings.title}>
        {(Object.keys(t.settings.tabs) as Tab[]).map((k) => (
          <button key={k} role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls={`panel-${k}`} className="btn" onClick={() => setTab(k)}>
            {t.settings.tabs[k]}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="stack" style={{ marginTop: 16 }}>
        {tab === 'summary' && <Summary />}
        {tab === 'kids' && <Kids />}
        {tab === 'settings' && <Settings />}
        {tab === 'backup' && <Backup />}
        {tab === 'privacy' && <PrivacyContent />}
      </div>
    </div>
  );
}

function Summary() {
  const profiles = useLiveQuery(() => db.profiles.orderBy('createdAt').toArray(), []);
  const sessions = useLiveQuery(() => db.sessions.toArray(), []);
  if (!profiles || !sessions) return null;
  if (profiles.length === 0) return <p className="muted">{t.settings.noKids}</p>;
  return (
    <>
      {profiles.map((p) => {
        const s = weeklySummary(
          sessions.filter((x) => x.profileId === p.id),
          p.weeklyGoalMinutes,
        );
        return (
          <section key={p.id} className="card">
            <div className="row">
              <Avatar id={p.avatar} size={56} />
              <h2 style={{ margin: 0 }}>{t.settings.summaryFor(p.name)}</h2>
            </div>
            <ul className="summary-list">
              <li>
                <Icon name="timer" /> {t.settings.summaryMinutes(s.minutes, s.goalMinutes)}
              </li>
              <li>
                <Icon name="calendar_month" /> {t.settings.summaryDays(s.daysPractised)}
              </li>
              <li>
                <Icon name="play_circle" /> {t.settings.summarySessions(s.sessions)}
              </li>
              <li>
                <Icon name="local_fire_department" /> {t.settings.summaryStreak(s.streak)}
              </li>
              {s.bestScore !== undefined && (
                <li>
                  <Icon name="star" /> {t.settings.summaryBest(s.bestScore)}
                </li>
              )}
              {s.pieces.length > 0 && (
                <li>
                  <Icon name="queue_music" /> {t.settings.summaryPieces(s.pieces.join(', '))}
                </li>
              )}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function Kids() {
  const profiles = useLiveQuery(() => db.profiles.orderBy('createdAt').toArray(), []);
  const { profile: current, selectProfile } = useApp();
  const [editing, setEditing] = useState<Profile | null>(null);
  const [removing, setRemoving] = useState<Profile | null>(null);
  if (!profiles) return null;
  if (profiles.length === 0) return <p className="muted">{t.settings.noKids}</p>;
  return (
    <>
      {profiles.map((p) => (
        <section key={p.id} className="card stack">
          <div className="spread">
            <div className="row">
              <Avatar id={p.avatar} size={56} />
              <h2 style={{ margin: 0 }}>{p.name}</h2>
            </div>
            <button className="btn" onClick={() => setEditing(p)}>
              <Icon name="edit" /> {t.common.edit}
            </button>
          </div>
          <div className="field">
            <label htmlFor={`goal-${p.id}`}>{t.settings.goal}</label>
            <input
              id={`goal-${p.id}`}
              type="number"
              min={5}
              max={1000}
              step={5}
              defaultValue={p.weeklyGoalMinutes}
              onBlur={(e) => updateProfile(p.id, { weeklyGoalMinutes: Math.max(5, Math.min(1000, Number(e.target.value) || 60)) })}
            />
          </div>
          <div className="field">
            <span style={{ fontWeight: 600 }}>{t.settings.difficulty}</span>
            <div className="segmented" role="group" aria-label={t.settings.difficulty}>
              {DIFFICULTIES.map((d: Difficulty) => (
                <button key={d} className="btn" aria-pressed={p.difficulty === d} onClick={() => updateProfile(p.id, { difficulty: d })}>
                  {t.difficulty[d]}
                </button>
              ))}
            </div>
            <span className="muted small">{t.difficulty.help}</span>
          </div>
          <button
            className="btn danger"
            onClick={() => setRemoving(p)}
          >
            <Icon name="person_remove" /> {t.settings.removeKid(p.name)}
          </button>
        </section>
      ))}
      {editing && (
        <Modal title={t.profiles.editKidTitle} onClose={() => setEditing(null)}>
          <KidForm
            initial={editing}
            submitLabel={t.common.save}
            onSubmit={async (k) => {
              await updateProfile(editing.id, k);
              setEditing(null);
            }}
          />
        </Modal>
      )}
      {removing && (
        <ConfirmDialog
          message={t.settings.confirmRemoveKid(removing.name)}
          confirmLabel={t.settings.removeKidYes(removing.name)}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await deleteProfile(removing.id);
            if (current?.id === removing.id) selectProfile(null);
            setRemoving(null);
          }}
        />
      )}
    </>
  );
}

function Settings() {
  const { settings, updateSettings } = useApp();
  const set = (c: Partial<DeviceSettings>) => void updateSettings(c);
  const modes: MetronomeMode[] = canVibrate() ? ['sound', 'visual', 'vibrate'] : ['sound', 'visual'];
  const modeLabel = { sound: t.practice.metronomeSound, visual: t.practice.metronomeVisual, vibrate: t.practice.metronomeVibrate };
  return (
    <>
      <MusicReader />
      <section className="card stack">
        <h2>{t.settings.latency}</h2>
        <p className="muted">{t.settings.micCheckHelp}</p>
        <SoundCheck />
        <div className="field">
          <label htmlFor="latency-manual">{t.settings.latencyManual}</label>
          <input
            id="latency-manual"
            type="number"
            min={0}
            max={600}
            step={5}
            key={settings.latencyMs ?? 'unset'}
            defaultValue={settings.latencyMs ?? ''}
            onBlur={(e) => e.target.value !== '' && set({ latencyMs: Math.max(0, Math.min(600, Number(e.target.value))) })}
          />
        </div>
      </section>
      <section className="card stack">
        <h2>{t.settings.readerCheckTitle}</h2>
        <ReaderCheck />
      </section>
      <section className="card stack">
        <h2>{t.settings.metronome}</h2>
        <div className="field">
          <span style={{ fontWeight: 600 }}>{t.settings.metronomeMode}</span>
          <div className="segmented" role="group" aria-label={t.settings.metronomeMode}>
            {modes.map((m) => (
              <button key={m} className="btn" aria-pressed={settings.metronomeMode === m} onClick={() => set({ metronomeMode: m })}>
                {modeLabel[m]}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="metro-vol">{t.settings.metronomeVolume}</label>
          <input id="metro-vol" type="range" min={0.1} max={1} step={0.05} value={settings.metronomeVolume} onChange={(e) => set({ metronomeVolume: Number(e.target.value) })} />
        </div>
      </section>
      <section className="card stack">
        <h2>{t.settings.pianoMode}</h2>
        <p className="muted">{t.settings.pianoHelp}</p>
        <div className="segmented" role="group" aria-label={t.settings.pianoMode}>
          {(
            [
              ['auto', t.settings.pianoAuto],
              ['live', t.settings.pianoLive],
              ['playThenScore', t.settings.pianoAfter],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className="btn" aria-pressed={settings.pianoMode === v} onClick={() => set({ pianoMode: v })}>
              {label}
            </button>
          ))}
        </div>
      </section>
      <section className="card stack">
        <h2>{t.settings.theme}</h2>
        <div className="segmented" role="group" aria-label={t.settings.theme}>
          {(
            [
              ['system', t.settings.themeSystem],
              ['light', t.settings.themeLight],
              ['dark', t.settings.themeDark],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className="btn" aria-pressed={settings.theme === v} onClick={() => set({ theme: v })}>
              {label}
            </button>
          ))}
        </div>
      </section>
      <p className="muted">{t.settings.storageNote}</p>
      <p className="muted small">{t.settings.version(__APP_VERSION__)}</p>
    </>
  );
}

function Backup() {
  const { selectProfile } = useApp();
  const file = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ kind: 'good' | 'error'; text: string } | null>(null);
  const [confirm, setConfirm] = useState<'delete' | { restore: unknown } | null>(null);

  const download = async () => {
    const data = await exportBackup();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = backupFileName();
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const restore = async (f: File | undefined) => {
    if (!f) return;
    setMessage(null);
    try {
      setConfirm({ restore: JSON.parse(await f.text()) });
    } catch (e) {
      failed(e);
    }
  };
  const failed = (e: unknown) => {
    const code = e instanceof BackupError ? (e.message as keyof typeof t.settings.importFailed) : 'damaged';
    setMessage({ kind: 'error', text: t.settings.importFailed[code] ?? t.settings.importFailed.damaged });
  };
  const doRestore = async (data: unknown) => {
    setConfirm(null);
    try {
      const r = await importBackup(data);
      selectProfile(null);
      setMessage({ kind: 'good', text: t.settings.importDone(r.profiles, r.pieces, r.sessions) });
    } catch (e) {
      failed(e);
    }
  };

  return (
    <>
      <section className="card stack">
        <h2>{t.settings.exportTitle}</h2>
        <p className="muted">{t.settings.exportHelp}</p>
        <button className="btn primary" onClick={download}>
          <Icon name="download" /> {t.settings.exportButton}
        </button>
      </section>
      <section className="card stack">
        <h2>{t.settings.importTitle}</h2>
        <p className="muted">{t.settings.importHelp}</p>
        <button className="btn" onClick={() => file.current?.click()}>
          <Icon name="upload" /> {t.settings.importButton}
        </button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => (void restore(e.target.files?.[0]), (e.target.value = ''))} />
        {message && (
          <p className={`notice ${message.kind}`} role="status">
            {message.text}
          </p>
        )}
      </section>
      <section className="card stack">
        <h2>{t.settings.deleteTitle}</h2>
        <p className="muted">{t.settings.deleteHelp}</p>
        <button
          className="btn danger"
          onClick={() => setConfirm('delete')}
          data-testid="delete-everything"
        >
          <Icon name="delete_forever" /> {t.settings.deleteButton}
        </button>
      </section>
      {confirm === 'delete' && (
        <ConfirmDialog
          message={t.settings.deleteConfirm}
          confirmLabel={t.settings.deleteYes}
          onCancel={() => setConfirm(null)}
          onConfirm={async () => {
            await deleteEverything();
            selectProfile(null);
            navigate('/', { replace: true });
          }}
        />
      )}
      {confirm && confirm !== 'delete' && (
        <ConfirmDialog message={t.settings.importConfirm} confirmLabel={t.settings.importYes} onCancel={() => setConfirm(null)} onConfirm={() => doRestore(confirm.restore)} />
      )}
    </>
  );
}
