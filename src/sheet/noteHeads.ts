import { topAt, type Staff } from './staffDetect';

/**
 * Find filled note heads on a line of music and say which line or space each
 * sits on. AI models are surprisingly poor at this on small, dense photos (they
 * guess plausible tunes), while it's simple geometry once the staff lines are
 * known. The positions are given to the reader as hints and used to check its
 * answer. Hollow heads (half and whole notes) aren't found; that's fine for hints.
 */

export interface Head {
  /** Analysis-image x of the head's centre. */
  x: number;
  /** Half-spaces above the bottom line (0 = E4 in treble clef, 8 = F5). */
  step: number;
}

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];

/** Bottom-line note for each clef, as a diatonic number (C4 = 28). */
const BOTTOM: Record<string, number> = { treble: 4 * 7 + 2, bass: 2 * 7 + 4, alto: 3 * 7 + 3, tenor: 3 * 7 + 1 };

/** Natural note name (no accidental) for a step on a clef. Pure. */
export function stepName(step: number, clef = 'treble'): string {
  const d = (BOTTOM[clef] ?? BOTTOM.treble) + step;
  return `${LETTERS[((d % 7) + 7) % 7]}${Math.floor(d / 7)}`;
}

/** Summed-area table for fast box means. */
function integral(gray: ArrayLike<number>, w: number, h: number): Float64Array {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += gray[y * w + x];
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
    }
  }
  return I;
}

/** Note heads on each staff (indexes match `staves`), left to right. */
export function findHeads(gray: ArrayLike<number>, width: number, height: number, staves: Staff[]): Head[][] {
  const out: Head[][] = staves.map(() => []);
  if (staves.length === 0) return out;
  const sp = staves.reduce((s, x) => s + x.spacing, 0) / staves.length;
  // Ink: clearly darker than the local background (survives shadows and paper tint).
  const I = integral(gray, width, height);
  const R = Math.max(10, Math.round(2.5 * sp));
  const ink = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - R);
    const y1 = Math.min(height, y + R + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - R);
      const x1 = Math.min(width, x + R + 1);
      const sum = I[y1 * (width + 1) + x1] - I[y0 * (width + 1) + x1] - I[y1 * (width + 1) + x0] + I[y0 * (width + 1) + x0];
      const bg = sum / ((y1 - y0) * (x1 - x0));
      ink[y * width + x] = bg - gray[y * width + x] > 45 ? 1 : 0;
    }
  }
  // Erode with a small ellipse: thin things (staff lines, stems, beams' edges, text strokes) vanish, heads remain.
  const rx = Math.max(1, Math.round(0.25 * sp));
  const ry = Math.max(1, Math.round(0.15 * sp));
  const offs: number[][] = [];
  for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1) offs.push([dx, dy]);
  const core = new Uint8Array(width * height);
  for (let y = ry; y < height - ry; y++) {
    for (let x = rx; x < width - rx; x++) {
      if (!ink[y * width + x]) continue;
      let all = 1;
      for (const [dx, dy] of offs) {
        if (!ink[(y + dy) * width + x + dx]) {
          all = 0;
          break;
        }
      }
      core[y * width + x] = all;
    }
  }
  // Connected blobs.
  const seen = new Uint8Array(width * height);
  const stack: number[] = [];
  for (let start = 0; start < core.length; start++) {
    if (!core[start] || seen[start]) continue;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let sx = 0;
    let sy = 0;
    let n = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % width;
      const y = (p - x) / width;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      sx += x;
      sy += y;
      n++;
      for (const q of [p - 1, p + 1, p - width, p + width]) {
        if (q >= 0 && q < core.length && core[q] && !seen[q] && Math.abs((q % width) - x) <= 1) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    // A head's core is about a space tall at most and wider than tall-ish; beams are long, dots tiny.
    if (h < Math.max(2, 0.2 * sp) || w < Math.max(3, 0.35 * sp) || h > 1.2 * sp || w > 1.8 * sp) continue;
    const cx = sx / n;
    const cy = sy / n;
    // Nearest staff, within ledger-line reach.
    let best = -1;
    let bestD = Infinity;
    staves.forEach((s, k) => {
      const mid = topAt(s, cx) + 2 * s.spacing;
      const d = Math.abs(cy - mid);
      if (d < 7 * s.spacing && d < bestD) {
        best = k;
        bestD = d;
      }
    });
    if (best < 0) continue;
    const s = staves[best];
    // Skip the clef, key and time signature at the start of the staff.
    if (cx < s.x0 + 4 * s.spacing) continue;
    const step = Math.round((topAt(s, cx) + 4 * s.spacing - cy) / (s.spacing / 2));
    if (step < -7 || step > 15) continue;
    out[best].push({ x: cx, step });
  }
  for (const list of out) list.sort((a, b) => a.x - b.x || a.step - b.step);
  return out;
}

/** Hint text for the reader: natural note names, left to right; heads at the same x are a chord. Pure. */
export function headHint(heads: Head[], clef = 'treble'): string {
  if (heads.length < 4) return '';
  const groups: Head[][] = [];
  for (const h of heads) {
    const g = groups[groups.length - 1];
    if (g && Math.abs(g[0].x - h.x) < 3) g.push(h);
    else groups.push([h]);
  }
  return groups.map((g) => g.map((h) => stepName(h.step, clef)).join('+')).join(' ');
}

/** Drop marks outside the notes an instrument can play (stray pencil, clef curls). Pure. */
export function inRange(heads: Head[], clef: string, low: string, high: string): Head[] {
  const d = (name: string) => LETTERS.indexOf(name[0]) + 7 * Number(name.slice(1));
  const dl = d(low);
  const dh = d(high);
  return heads.filter((h) => {
    const n = stepName(h.step, clef);
    const v = d(n);
    return v >= dl && v <= dh;
  });
}

/** The hint for one line: one staff, or "upper staff: … / lower staff: …" for piano. Pure. */
export function lineHint(staves: Head[][] | undefined, clef = 'treble', clef2 = 'bass', range?: [string, string]): string {
  if (!staves || staves.length === 0) return '';
  if (staves.length === 1) return headHint(range ? inRange(staves[0], clef, range[0], range[1]) : staves[0], clef);
  const a = headHint(staves[0], clef);
  const b = headHint(staves[1], clef2);
  return a && b ? `upper staff: ${a} / lower staff: ${b}` : '';
}

/** Natural note names of the heads, flattened (for comparing with a transcription). Pure. */
export function headNames(staves: Head[][] | undefined, clef = 'treble', clef2 = 'bass', range?: [string, string]): string[][] {
  return (staves ?? []).map((list, i) => (range && staves?.length === 1 ? inRange(list, clef, range[0], range[1]) : list).map((h) => stepName(h.step, i === 1 ? clef2 : clef)));
}
