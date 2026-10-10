import { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DIFFICULTIES, type Difficulty, type MetronomeMode } from '../../config';
import { t } from '../../i18n';
import { useApp } from '../../app/state';
import { back, navigate } from '../../app/router';
import { Avatar } from '../../components/Avatar';
import { Icon } from '../../components/Icon';
import { Modal } from '../../components/Modal';
import { ParentGate } from '../../components/ParentGate';
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

/** The gate stays open for a few minutes so parents aren't asked again and again. */
let gateOpenUntil = 0;
const GATE_MINUTES = 10;

export default function ParentScreen() {
  const [open, setOpen] = useState(() => Date.now() < gateOpenUntil);
  const [tab, setTab] = useState<Tab>('summary');
  const { profile } = useApp();

  return (
    <div className="page parent">
      <div className="topbar">
        <button className="btn icon-only round ghost" aria-label={t.common.back} onClick={() => back(profile ? '/home' : '/')}>
          <Icon name="arrow_back" />
        </button>
        <h1>{t.parent.title}</h1>
      </div>
      {!open ? (
        <ParentGate
          onPass={() => {
            gateOpenUntil = Date.now() + GATE_MINUTES * 60_000;
            setOpen(true);
          }}
        />
      ) : (
        <>
          <div className="tabs" role="tablist" aria-label={t.parent.title}>
            {(Object.keys(t.parent.tabs) as Tab[]).map((k) => (
              <button key={k} role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls={`panel-${k}`} className="btn" onClick={() => setTab(k)}>
                {t.parent.tabs[k]}
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
        </>
      )}
    </div>
  );
}

function Summary() {
  const profiles = useLiveQuery(() => db.profiles.orderBy('createdAt').toArray(), []);
  const sessions = useLiveQuery(() => db.sessions.toArray(), []);
  if (!profiles || !sessions) return null;
  if (profiles.length === 0) return <p className="muted">{t.parent.noKids}</p>;
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
              <h2 style={{ margin: 0 }}>{t.parent.summaryFor(p.name)}</h2>
            </div>
            <ul className="summary-list">
              <li>
                <Icon name="timer" /> {t.parent.summaryMinutes(s.minutes, s.goalMinutes)}
              </li>
              <li>
                <Icon name="calendar_month" /> {t.parent.summaryDays(s.daysPractised)}
              </li>
              <li>
                <Icon name="play_circle" /> {t.parent.summarySessions(s.sessions)}
              </li>
              <li>
                <Icon name="local_fire_department" /> {t.parent.summaryStreak(s.streak)}
              </li>
              {s.bestScore !== undefined && (
                <li>
                  <Icon name="star" /> {t.parent.summaryBest(s.bestScore)}
                </li>
              )}
              {s.pieces.length > 0 && (
                <li>
                  <Icon name="queue_music" /> {t.parent.summaryPieces(s.pieces.join(', '))}
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
  if (!profiles) return null;
  if (profiles.length === 0) return <p className="muted">{t.parent.noKids}</p>;
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
            <label htmlFor={`goal-${p.id}`}>{t.parent.goal}</label>
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
            <span style={{ fontWeight: 600 }}>{t.parent.difficulty}</span>
            <div className="segmented" role="group" aria-label={t.parent.difficulty}>
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
            onClick={async () => {
              if (!window.confirm(t.parent.confirmRemoveKid(p.name))) return;
              await deleteProfile(p.id);
              if (current?.id === p.id) selectProfile(null);
            }}
          >
            <Icon name="person_remove" /> {t.parent.removeKid(p.name)}
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
      <section className="card stack">
        <h2>{t.parent.latency}</h2>
        <p className="muted">{t.parent.micCheckHelp}</p>
        <SoundCheck />
        <div className="field">
          <label htmlFor="latency-manual">{t.parent.latencyManual}</label>
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
        <h2>{t.parent.readerCheckTitle}</h2>
        <ReaderCheck />
      </section>
      <section className="card stack">
        <h2>{t.parent.metronome}</h2>
        <div className="field">
          <span style={{ fontWeight: 600 }}>{t.parent.metronomeMode}</span>
          <div className="segmented" role="group" aria-label={t.parent.metronomeMode}>
            {modes.map((m) => (
              <button key={m} className="btn" aria-pressed={settings.metronomeMode === m} onClick={() => set({ metronomeMode: m })}>
                {modeLabel[m]}
              </button>
            ))}
          </div>
        </div>
        <div className="field">
          <label htmlFor="metro-vol">{t.parent.metronomeVolume}</label>
          <input id="metro-vol" type="range" min={0.1} max={1} step={0.05} value={settings.metronomeVolume} onChange={(e) => set({ metronomeVolume: Number(e.target.value) })} />
        </div>
      </section>
      <section className="card stack">
        <h2>{t.parent.pianoMode}</h2>
        <p className="muted">{t.parent.pianoHelp}</p>
        <div className="segmented" role="group" aria-label={t.parent.pianoMode}>
          {(
            [
              ['auto', t.parent.pianoAuto],
              ['live', t.parent.pianoLive],
              ['playThenScore', t.parent.pianoAfter],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className="btn" aria-pressed={settings.pianoMode === v} onClick={() => set({ pianoMode: v })}>
              {label}
            </button>
          ))}
        </div>
      </section>
      <section className="card stack">
        <h2>{t.parent.theme}</h2>
        <div className="segmented" role="group" aria-label={t.parent.theme}>
          {(
            [
              ['system', t.parent.themeSystem],
              ['light', t.parent.themeLight],
              ['dark', t.parent.themeDark],
            ] as const
          ).map(([v, label]) => (
            <button key={v} className="btn" aria-pressed={settings.theme === v} onClick={() => set({ theme: v })}>
              {label}
            </button>
          ))}
        </div>
      </section>
      <p className="muted">{t.parent.storageNote}</p>
      <p className="muted small">{t.parent.version(__APP_VERSION__)}</p>
    </>
  );
}

function Backup() {
  const { selectProfile } = useApp();
  const file = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ kind: 'good' | 'error'; text: string } | null>(null);

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
      const data = JSON.parse(await f.text());
      if (!window.confirm(t.parent.importConfirm)) return;
      const r = await importBackup(data);
      selectProfile(null);
      setMessage({ kind: 'good', text: t.parent.importDone(r.profiles, r.pieces, r.sessions) });
    } catch (e) {
      const code = e instanceof BackupError ? (e.message as keyof typeof t.parent.importFailed) : 'damaged';
      setMessage({ kind: 'error', text: t.parent.importFailed[code] ?? t.parent.importFailed.damaged });
    }
  };

  return (
    <>
      <section className="card stack">
        <h2>{t.parent.exportTitle}</h2>
        <p className="muted">{t.parent.exportHelp}</p>
        <button className="btn primary" onClick={download}>
          <Icon name="download" /> {t.parent.exportButton}
        </button>
      </section>
      <section className="card stack">
        <h2>{t.parent.importTitle}</h2>
        <p className="muted">{t.parent.importHelp}</p>
        <button className="btn" onClick={() => file.current?.click()}>
          <Icon name="upload" /> {t.parent.importButton}
        </button>
        <input ref={file} type="file" accept="application/json,.json" hidden onChange={(e) => (void restore(e.target.files?.[0]), (e.target.value = ''))} />
        {message && (
          <p className={`notice ${message.kind}`} role="status">
            {message.text}
          </p>
        )}
      </section>
      <section className="card stack">
        <h2>{t.parent.deleteTitle}</h2>
        <p className="muted">{t.parent.deleteHelp}</p>
        <button
          className="btn danger"
          onClick={async () => {
            if (!window.confirm(t.parent.deleteConfirm)) return;
            await deleteEverything();
            selectProfile(null);
            navigate('/', { replace: true });
          }}
        >
          <Icon name="delete_forever" /> {t.parent.deleteButton}
        </button>
      </section>
    </>
  );
}
