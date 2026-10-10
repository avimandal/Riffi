/**
 * LCD-style seven-segment characters (SVG), with faint "ghost" segments like
 * a real display. Supports 0–9, A–G (as a, b, C, d, E, F, G), '-' and space.
 */
const SEGMENTS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abdeg',
  '3': 'abcdg',
  '4': 'bcfg',
  '5': 'acdfg',
  '6': 'acdefg',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg',
  A: 'abcefg',
  B: 'cdefg',
  C: 'adef',
  D: 'bcdeg',
  E: 'adefg',
  F: 'aefg',
  G: 'acdef',
  '-': 'g',
  ' ': '',
};

// Segment shapes in a 60 × 100 box (slanted a little, like a real LCD).
const SHAPES: Record<string, string> = {
  a: '14,4 50,4 44,12 20,12',
  b: '52,7 52,46 46,50 46,15',
  c: '52,54 52,93 46,85 46,50',
  d: '14,96 50,96 44,88 20,88',
  e: '8,54 14,50 14,85 8,93',
  f: '8,7 14,15 14,50 8,46',
  g: '12,50 18,45 42,45 48,50 42,55 18,55',
};

/** Without `height`, size it with CSS (set the height; the width follows). */
export function SevenSeg({ text, digits, height, className }: { text: string; digits?: number; height?: number; className?: string }) {
  const chars = (digits ? text.toUpperCase().padStart(digits, ' ').slice(-digits) : text.toUpperCase()).split('');
  const w = 60;
  return (
    <svg
      className={`sevenseg${className ? ` ${className}` : ''}`}
      viewBox={`0 0 ${chars.length * w} 100`}
      height={height}
      width={height ? (height * chars.length * w) / 100 : undefined}
      aria-hidden
      style={{ transform: 'skewX(-6deg)' }}
    >
      {chars.map((ch, i) => {
        const on = SEGMENTS[ch] ?? '';
        return (
          <g key={i} transform={`translate(${i * w} 0)`}>
            {Object.entries(SHAPES).map(([seg, pts]) => (
              <polygon key={seg} points={pts} className={on.includes(seg) ? 'seg-on' : 'seg-off'} />
            ))}
          </g>
        );
      })}
    </svg>
  );
}
