import { useState } from 'react';
import { t } from '../i18n';
import { useApp } from '../app/state';
import { resumeAudio } from '../audio/context';
import { calibrateLatency, measureRoomNoise } from '../audio/calibrate';
import { MicError } from '../audio/mic';
import { Icon } from './Icon';

type Step = 'idle' | 'noise' | 'latency' | 'done' | 'failed';

/** Mic check + latency calibration (Settings, and offered on first run). */
export function SoundCheck({ onDone, compact }: { onDone?: () => void; compact?: boolean }) {
  const { settings, updateSettings } = useApp();
  const [step, setStep] = useState<Step>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const run = async () => {
    setMessage(null);
    try {
      const ctx = await resumeAudio();
      setStep('noise');
      const floor = await measureRoomNoise(ctx);
      setStep('latency');
      const est = await calibrateLatency(ctx);
      const changes: Parameters<typeof updateSettings>[0] = { noiseFloor: floor, firstRunDone: true };
      if (est.ok) changes.latencyMs = est.latencyMs;
      await updateSettings(changes);
      const db = Math.round(20 * Math.log10(Math.max(1e-6, floor)));
      setMessage(est.ok ? `${t.settings.micCheckDone(db)} ${t.settings.latencyResult(est.latencyMs)}` : `${t.settings.micCheckDone(db)} ${t.settings.latencyFailed}`);
      setStep(est.ok ? 'done' : 'failed');
      if (est.ok) onDone?.();
    } catch (e) {
      setStep('failed');
      setMessage(e instanceof MicError && e.reason === 'denied' ? t.practice.micDenied : t.settings.latencyFailed);
    }
  };

  const running = step === 'noise' || step === 'latency';
  return (
    <div className="stack">
      {!compact && <p className="muted">{t.settings.latencyHelp}</p>}
      <p className="muted" aria-live="polite">
        {settings.latencyMs !== undefined ? t.settings.latencyCurrent(settings.latencyMs) : t.settings.latencyNotSet}
      </p>
      <button className="btn primary big" onClick={run} disabled={running} data-testid="sound-check">
        <Icon name={running ? 'graphic_eq' : 'tune'} filled={running} />
        {step === 'noise' ? t.settings.micCheckQuiet : step === 'latency' ? t.settings.latencyRunning : t.settings.latencyStart}
      </button>
      {message && (
        <p className={`notice ${step === 'done' ? 'good' : 'warn'}`} role="status">
          {message}
        </p>
      )}
    </div>
  );
}
