/** Weekly goal ring (minutes done / goal). */
export function GoalRing({ done, goal, size = 120, label }: { done: number; goal: number; size?: number; label: string }) {
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const frac = goal > 0 ? Math.min(1, done / goal) : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={12} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={12}
        strokeLinecap="round"
        strokeDasharray={`${c * frac} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text x="50%" y="47%" textAnchor="middle" dominantBaseline="middle" fontSize={size / 4} fontWeight={800} fill="var(--text)">
        {Math.round(done)}
      </text>
      <text x="50%" y="68%" textAnchor="middle" dominantBaseline="middle" fontSize={size / 9} fill="var(--text-muted)">
        / {goal} min
      </text>
    </svg>
  );
}
