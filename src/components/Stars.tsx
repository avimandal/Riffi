import { t } from '../i18n';
import { Icon } from './Icon';

export function Stars({ count, size = 48 }: { count: number; size?: number }) {
  return (
    <span role="img" aria-label={t.results.stars(count)} style={{ display: 'inline-flex', gap: 4 }}>
      {[0, 1, 2].map((i) => (
        <Icon key={i} name="star" filled={i < count} size={size} className={i < count ? 'star-on' : 'star-off'} />
      ))}
    </span>
  );
}
