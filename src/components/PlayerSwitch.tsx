import { t } from '../i18n';
import { navigate } from '../app/router';
import { useApp } from '../app/state';
import { Avatar } from './Avatar';
import { Icon } from './Icon';

export function greeting(name: string, now = new Date()) {
  const h = now.getHours();
  if (h < 11) return t.home.greetingMorning(name);
  if (h >= 18) return t.home.greetingEvening(name);
  return t.home.greeting(name);
}

/** The kid's avatar and greeting, top left of every main screen. Tap to switch player. */
export function PlayerSwitch() {
  const { profile } = useApp();
  if (!profile) return null;
  return (
    <button className="player-switch" onClick={() => navigate('/')} aria-label={t.nav.switchPlayer} data-testid="switch-player">
      <Avatar id={profile.avatar} size={44} />
      <span className="player-greeting">{greeting(profile.name)}</span>
      <Icon name="expand_more" className="player-chevron" />
    </button>
  );
}
