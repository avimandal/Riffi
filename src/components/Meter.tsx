import { t } from '../i18n';
import { Icon } from './Icon';

/** "I can hear you!" input level meter. */
export function Meter({ level, active }: { level: number; active: boolean }) {
  const heard = level > 0.08;
  const pct = Math.round(Math.min(1, level) * 100);
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={t.practice.hearYou}>
      <Icon name={heard ? 'hearing' : 'mic'} filled={heard} />
      <div className="meter-track" aria-hidden>
        <div className="meter-fill" style={{ transform: `scaleX(${Math.min(1, level)})` }} />
      </div>
      <span className="meter-text">{active ? (heard ? t.practice.hearYou : t.practice.listening) : ''}</span>
    </div>
  );
}
