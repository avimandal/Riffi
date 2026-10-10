/** Material Symbols Rounded (self-hosted subset). Decorative unless given a label. */
export function Icon({ name, filled, label, size, className }: { name: string; filled?: boolean; label?: string; size?: number; className?: string }) {
  return (
    <span
      className={`icon${filled ? ' filled' : ''}${className ? ` ${className}` : ''}`}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      style={size ? { fontSize: size } : undefined}
    >
      {name}
    </span>
  );
}
