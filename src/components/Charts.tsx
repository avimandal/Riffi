/** Small dependency-free SVG charts. */

export function BarChart({ data, label, height = 160 }: { data: { key: string; value: number; short: string }[]; label: string; height?: number }) {
  const max = Math.max(10, ...data.map((d) => d.value));
  const w = 100 / Math.max(1, data.length);
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 100 ${height / 3}`} width="100%" height={height} preserveAspectRatio="none" role="img" aria-label={label}>
        {data.map((d, i) => {
          const h = (d.value / max) * (height / 3 - 4);
          return <rect key={d.key} x={i * w + w * 0.15} y={height / 3 - h} width={w * 0.7} height={Math.max(0.6, h)} rx={1.2} fill={d.value > 0 ? 'var(--primary)' : 'var(--border)'} />;
        })}
      </svg>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${data.length}, 1fr)`, fontSize: 13, textAlign: 'center' }} className="muted" aria-hidden>
        {data.map((d) => (
          <span key={d.key}>{d.short}</span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.key}>
              <th>{d.key}</th>
              <td>{Math.round(d.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function TrendLine({ points, label, height = 80 }: { points: number[]; label: string; height?: number }) {
  if (points.length === 0) return null;
  const W = 200;
  const H = 60;
  const xs = points.map((_, i) => (points.length === 1 ? W / 2 : (i / (points.length - 1)) * (W - 10) + 5));
  const ys = points.map((p) => H - 5 - (p / 100) * (H - 10));
  const d = xs.map((x, i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={height} role="img" aria-label={`${label}: ${points.join(', ')}`}>
      <line x1={0} x2={W} y1={H - 5 - 0.9 * (H - 10)} y2={H - 5 - 0.9 * (H - 10)} stroke="var(--border)" strokeDasharray="3 3" />
      <path d={d} fill="none" stroke="var(--primary)" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
      {xs.map((x, i) => (
        <circle key={i} cx={x} cy={ys[i]} r={3.5} fill="var(--accent)" />
      ))}
    </svg>
  );
}
