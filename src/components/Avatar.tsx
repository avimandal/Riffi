import { t } from '../i18n';

export const AVATARS = {
  fox: { emoji: '🦊', bg: '#ffd9c2' },
  koala: { emoji: '🐨', bg: '#dfe6ee' },
  owl: { emoji: '🦉', bg: '#eadcc8' },
  cat: { emoji: '🐱', bg: '#ffe8a8' },
  dog: { emoji: '🐶', bg: '#f3dcc0' },
  frog: { emoji: '🐸', bg: '#cdf0c5' },
  penguin: { emoji: '🐧', bg: '#d6e8ff' },
  bee: { emoji: '🐝', bg: '#fff1a6' },
  octopus: { emoji: '🐙', bg: '#ffd1e4' },
  turtle: { emoji: '🐢', bg: '#c9f0e4' },
  unicorn: { emoji: '🦄', bg: '#ead8ff' },
  robot: { emoji: '🤖', bg: '#d9e3ea' },
} as const;

export type AvatarId = keyof typeof AVATARS;
export const AVATAR_IDS = Object.keys(AVATARS) as AvatarId[];

export function Avatar({ id, size = 96, label }: { id: string; size?: number; label?: boolean }) {
  const a = AVATARS[id as AvatarId] ?? AVATARS.fox;
  const name = t.avatars[id as AvatarId] ?? id;
  return (
    <span
      role={label ? 'img' : undefined}
      aria-label={label ? name : undefined}
      aria-hidden={label ? undefined : true}
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: a.bg,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.58,
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {a.emoji}
    </span>
  );
}
