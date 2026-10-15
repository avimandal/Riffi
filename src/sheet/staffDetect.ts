/**
 * Find the staff systems on a photographed page, so each line of music can be
 * cropped at full resolution and read on its own.
 *
 * Works on a grayscale copy (any size; ~1000–1600 px wide is plenty). For many
 * narrow columns across the page it looks for five evenly spaced dark lines,
 * follows each staff from left to right (pages are often tilted or curved), fits
 * a gentle curve through it, and returns the band each system occupies.
 * Pure (no DOM), so it's unit-tested on synthetic pages and in the browser on
 * the real fixture photo.
 */

export interface Staff {
  /** Top line y = c0 + c1·x + c2·x² (analysis pixels). */
  coef: [number, number, number];
  /** Distance between staff lines. */
  spacing: number;
  /** Left and right x where the staff was seen. */
  x0: number;
  x1: number;
}

export interface SystemBand {
  /** Index of the staves in this system (1 for most instruments, 2 for piano). */
  staves: Staff[];
  /** Crop band (analysis pixels), including room for ledger lines, fingering and dynamics. */
  y0: number;
  y1: number;
}

export const topAt = (s: Staff, x: number) => s.coef[0] + s.coef[1] * x + s.coef[2] * x * x;

interface Hit {
  x: number;
  top: number;
  sp: number;
}

/** Five evenly spaced dark lines in one column profile. */
function columnHits(dark: Float32Array, threshold: number): { top: number; sp: number }[] {
  const peaks: number[] = [];
  for (let y = 2; y < dark.length - 2; y++) {
    const v = dark[y];
    if (v > threshold && v >= dark[y - 1] && v >= dark[y + 1] && v >= dark[y - 2] && v >= dark[y + 2]) peaks.push(y);
  }
  const out: { top: number; sp: number }[] = [];
  for (let i = 0; i + 4 < peaks.length; i++) {
    const q = peaks.slice(i, i + 5);
    const d = [q[1] - q[0], q[2] - q[1], q[3] - q[2], q[4] - q[3]];
    const lo = Math.min(...d);
    const hi = Math.max(...d);
    if (lo >= 4 && hi <= 40 && hi - lo <= Math.max(2, 0.25 * lo)) {
      out.push({ top: q[0], sp: (q[4] - q[0]) / 4 });
      i += 4;
    }
  }
  return out;
}

/** Least-squares quadratic fit, dropping outliers. */
function fit(hits: Hit[], curved: boolean): { coef: [number, number, number]; kept: Hit[] } {
  let pts = hits;
  let coef: [number, number, number] = [hits[0].top, 0, 0];
  for (let round = 0; round < 3 && pts.length >= 3; round++) {
    coef = polyfit2(pts, curved);
    const tol = Math.max(1.5, 0.3 * median(pts.map((p) => p.sp)));
    const kept = pts.filter((p) => Math.abs(p.top - (coef[0] + coef[1] * p.x + coef[2] * p.x * p.x)) <= tol);
    if (kept.length === pts.length) break;
    pts = kept;
  }
  return { coef, kept: pts };
}

function polyfit2(pts: Hit[], curved: boolean): [number, number, number] {
  // Normalise x for stability, then solve the 3×3 normal equations.
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const sx = Math.max(1, Math.sqrt(pts.reduce((s, p) => s + (p.x - mx) ** 2, 0) / pts.length));
  const S = [0, 0, 0, 0, 0];
  const T = [0, 0, 0];
  for (const p of pts) {
    const u = (p.x - mx) / sx;
    let pw = 1;
    for (let k = 0; k < 5; k++) {
      S[k] += pw;
      if (k < 3) T[k] += pw * p.top;
      pw *= u;
    }
  }
  const A = [
    [S[0], S[1], S[2]],
    [S[1], S[2], S[3]],
    [S[2], S[3], S[4]],
  ];
  let [a, b, c] = solve3(A, T);
  if (!curved || !Number.isFinite(c) || pts.length < 8) {
    // Too few points for a curve: straight line.
    const n = pts.length;
    const su = S[1];
    const suu = S[2];
    const det = n * suu - su * su;
    b = det ? (n * T[1] - su * T[0]) / det : 0;
    a = (T[0] - b * su) / n;
    c = 0;
  }
  // Back to pixel x: top = a + b·u + c·u², u = (x - mx)/sx.
  return [a - (b * mx) / sx + (c * mx * mx) / (sx * sx), b / sx - (2 * c * mx) / (sx * sx), c / (sx * sx)];
}

function solve3(A: number[][], b: number[]): [number, number, number] {
  const m = A.map((r, i) => [...r, b[i]]);
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(m[r][i]) > Math.abs(m[p][i])) p = r;
    [m[i], m[p]] = [m[p], m[i]];
    if (Math.abs(m[i][i]) < 1e-12) return [NaN, NaN, NaN];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const f = m[r][i] / m[i][i];
      for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c];
    }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/** Find staves on a grayscale image (0 = black, 255 = white). */
export function detectStaves(gray: Uint8ClampedArray | Uint8Array | Float32Array, width: number, height: number): Staff[] {
  const colW = Math.max(6, Math.round(width / 100));
  const step = Math.max(4, Math.round(width / 130));
  const col = new Float32Array(height);
  const dark = new Float32Array(height);
  const R = 10; // background window (rows each side)
  const hits: Hit[] = [];
  for (let x = Math.round(width * 0.02); x + colW < width * 0.98; x += step) {
    for (let y = 0; y < height; y++) {
      let s = 0;
      const row = y * width;
      for (let k = 0; k < colW; k++) s += gray[row + x + k];
      col[y] = s / colW;
    }
    // Running mean as the local background; lines are darker than it.
    let acc = 0;
    for (let y = 0; y < Math.min(height, R); y++) acc += col[y];
    for (let y = 0; y < height; y++) {
      if (y + R < height) acc += col[y + R];
      if (y - R - 1 >= 0) acc -= col[y - R - 1];
      const n = Math.min(height - 1, y + R) - Math.max(0, y - R) + 1;
      dark[y] = acc / n - col[y];
    }
    for (const h of columnHits(dark, 10)) hits.push({ x: x + colW / 2, top: h.top, sp: h.sp });
  }
  if (hits.length === 0) return [];

  // Follow staves left to right. Joining is strict (half a line space, plus a little
  // for tilt over a gap) so a "staff" seen one line off can't hijack a track.
  hits.sort((a, b) => a.x - b.x || a.top - b.top);
  const tracks: Hit[][] = [];
  for (const h of hits) {
    let best: Hit[] | null = null;
    let bestD = Infinity;
    for (const t of tracks) {
      const last = t[t.length - 1];
      if (last.x === h.x) continue;
      const d = Math.abs(last.top - h.top);
      const tol = 0.45 * h.sp + 0.04 * (h.x - last.x);
      if (d <= tol && d < bestD && Math.abs(last.sp - h.sp) <= Math.max(1.5, 0.25 * h.sp)) {
        best = t;
        bestD = d;
      }
    }
    if (best) best.push(h);
    else tracks.push([h]);
  }

  const build = (pts: Hit[]): (Staff & { hits: Hit[] }) | null => {
    if (pts.length < 4) return null;
    const sorted = [...pts].sort((a, b) => a.x - b.x);
    const wide = sorted[sorted.length - 1].x - sorted[0].x > width * 0.6;
    const { coef, kept } = fit(sorted, wide);
    if (kept.length < 4) return null;
    return { coef, spacing: median(kept.map((p) => p.sp)), x0: kept[0].x, x1: kept[kept.length - 1].x, hits: kept };
  };
  const cands = tracks.map(build).filter((s): s is Staff & { hits: Hit[] } => s !== null);
  // Join pieces of the same staff (broken by a gap or a dense passage) and refit.
  cands.sort((a, b) => topAt(a, (a.x0 + a.x1) / 2) - topAt(b, (b.x0 + b.x1) / 2));
  for (let changed = true; changed; ) {
    changed = false;
    outer: for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const a = cands[i];
        const b = cands[j];
        const x = (Math.max(a.x0, b.x0) + Math.min(a.x1, b.x1)) / 2;
        if (Math.abs(topAt(a, x) - topAt(b, x)) < 0.5 * a.spacing && Math.abs(a.spacing - b.spacing) <= 1.5) {
          const m = build([...a.hits, ...b.hits]);
          if (m) {
            cands[i] = m;
            cands.splice(j, 1);
            changed = true;
            break outer;
          }
        }
      }
    }
  }
  const span = width * 0.96;
  // A real staff runs a good way across (lines are broken by notes, so be lenient).
  const staves = cands.filter((s) => s.x1 - s.x0 >= span * 0.3 && s.hits.length >= 5);
  staves.sort((a, b) => topAt(a, width / 2) - topAt(b, width / 2));
  // Overlapping leftovers: keep the best supported (its position is checked below).
  const paper = (() => {
    const v: number[] = [];
    for (let i = 0; i < gray.length; i += 97) v.push(gray[i]);
    v.sort((a, b) => a - b);
    return v[Math.floor(v.length * 0.8)] ?? 255;
  })();
  const lineCover = (st: Staff, from: number, to: number) => {
    let worst = 1;
    for (let l = 0; l < 5; l++) {
      let n = 0;
      let dark = 0;
      for (let x = Math.round(from); x <= to; x += 3) {
        const y = Math.round(topAt(st, x) + l * st.spacing);
        n++;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy >= 0 && yy < height && gray[yy * width + x] < paper * 0.72) {
            dark++;
            break;
          }
        }
      }
      if (n) worst = Math.min(worst, dark / n);
    }
    return worst;
  };
  const out: (Staff & { hits: Hit[] })[] = [];
  for (const s of staves) {
    const prev = out[out.length - 1];
    if (prev && Math.abs(topAt(prev, width / 2) - topAt(s, width / 2)) < 3 * s.spacing) {
      if (s.hits.length > prev.hits.length) out[out.length - 1] = s;
      continue;
    }
    out.push(s);
  }
  // A staff can be found one line off, along all or part of its length: four real lines
  // plus the ledger lines of a run of low (or high) notes, with beams hiding the real top
  // line. Its fifth "line" is broken where the ledger notes stop. So check it in short
  // stretches, move the hits of any stretch that's a line off, and fit it again.
  for (let k = 0; k < out.length; k++) {
    const st = out[k];
    const seg = Math.max(8 * st.spacing, (st.x1 - st.x0) / 8);
    const shiftAt: { from: number; to: number; by: number }[] = [];
    for (let from = st.x0; from < st.x1; from += seg) {
      const to = Math.min(st.x1, from + seg);
      let by = 0;
      let best = lineCover(st, from, to);
      for (const d of [-1, 1]) {
        const c = lineCover({ ...st, coef: [st.coef[0] + d * st.spacing, st.coef[1], st.coef[2]] }, from, to);
        if (c > best + 0.15 && c >= 0.7) {
          by = d;
          best = c;
        }
      }
      if (by) shiftAt.push({ from, to, by });
    }
    if (shiftAt.length === 0) continue;
    const moved = st.hits.map((h) => {
      const s2 = shiftAt.find((z) => h.x >= z.from && h.x <= z.to);
      return s2 ? { ...h, top: h.top + s2.by * st.spacing } : h;
    });
    const refit = build(moved);
    // Only if it fits better along (nearly) the whole staff.
    if (refit && refit.x1 - refit.x0 >= 0.9 * (st.x1 - st.x0) && lineCover(refit, st.x0, st.x1) > lineCover(st, st.x0, st.x1)) out[k] = refit;
  }
  return out.map(({ coef, spacing, x0, x1 }) => ({ coef, spacing, x0, x1 }));
}

/** How sure the join between two staves needs to be (see joinedStaves). */
export const SYSTEM_JOIN = {
  /** Share of the gap's rows with ink at the left edge (brace or the system's opening line). */
  leftCoverage: 0.85,
  /** Share of the gap's rows a bar line must cover to count as running through. */
  barCoverage: 0.9,
  /** Bar lines running through the gap needed (when the left edge doesn't decide it). */
  barLines: 2,
} as const;

type Gray = Uint8ClampedArray | Uint8Array | Float32Array;

/**
 * Are two neighbouring staves (upper `a`, lower `b`) one system? A grand staff
 * is joined at the left by a brace and the system's opening line, and its bar
 * lines usually run straight through from one staff to the other; separate
 * lines of single-staff music have empty paper between them. Pure.
 */
export function joinedStaves(gray: Gray, width: number, height: number, a: Staff, b: Staff): boolean {
  const sp = (a.spacing + b.spacing) / 2;
  const gapAt = (x: number) => [Math.ceil(topAt(a, x) + 4 * a.spacing + 0.35 * sp), Math.floor(topAt(b, x) - 0.35 * sp)] as const;
  const left = Math.max(0, Math.min(a.x0, b.x0));
  const [g0, g1] = gapAt(left);
  // Too far apart for a grand staff (more than ~12 line spaces of paper), or overlapping.
  if (g1 - g0 < 2 || g1 - g0 > 12 * sp) return false;
  // Paper brightness around the gap; ink is clearly darker.
  const samples: number[] = [];
  for (let y = g0; y <= g1; y += 2) for (let x = Math.round(left); x < width; x += 7) samples.push(gray[y * width + x]);
  samples.sort((p, q) => p - q);
  const paper = samples[Math.floor(samples.length * 0.7)] ?? 255;
  const ink = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height && gray[y * width + x] < paper * 0.62;

  // 1. The left edge: a brace or the opening line crosses (almost) every row of the gap.
  const xs = Math.round(left - 4 * sp);
  const xe = Math.round(left + 1.2 * sp);
  let rows = 0;
  let hit = 0;
  for (let y = g0; y <= g1; y++) {
    rows++;
    for (let x = xs; x <= xe; x++) {
      if (ink(x, y)) {
        hit++;
        break;
      }
    }
  }
  if (rows > 0 && hit / rows >= SYSTEM_JOIN.leftCoverage) return true;

  // 2. Bar lines that run through the gap from one staff to the other.
  const right = Math.min(width - 2, Math.max(a.x1, b.x1));
  let lines = 0;
  let lastX = -Infinity;
  for (let x = Math.round(left + 5 * sp); x <= right; x++) {
    const [y0, y1] = gapAt(x);
    if (y1 <= y0) continue;
    let covered = 0;
    for (let y = y0; y <= y1; y++) if (ink(x, y) || ink(x - 1, y) || ink(x + 1, y)) covered++;
    if (covered / (y1 - y0 + 1) >= SYSTEM_JOIN.barCoverage) {
      if (x - lastX > 2 * sp) lines++;
      lastX = x;
      if (lines >= SYSTEM_JOIN.barLines) return true;
    }
  }
  return false;
}

/**
 * Group staves into systems from the picture: neighbours joined by a brace or
 * by bar lines running through them are one system (at most two staves: a
 * grand staff). Without a picture to look at, `fallback` staves per system.
 * Pure.
 */
export function groupSystems(staves: Staff[], image?: { gray: Gray; width: number; height: number }, fallback: 1 | 2 = 1): Staff[][] {
  if (!image) return fallbackGroups(staves, fallback);
  const joins = staves.slice(0, -1).map((s, i) => joinedStaves(image.gray, image.width, image.height, s, staves[i + 1]));
  // Nothing joined anywhere, but the child plays piano: pair them up as before.
  if (fallback === 2 && !joins.some(Boolean)) return fallbackGroups(staves, 2);
  const groups: Staff[][] = [];
  for (let i = 0; i < staves.length; i++) {
    if (joins[i]) {
      groups.push([staves[i], staves[i + 1]]);
      i++;
    } else groups.push([staves[i]]);
  }
  return groups;
}

function fallbackGroups(staves: Staff[], perSystem: 1 | 2): Staff[][] {
  const groups: Staff[][] = [];
  if (perSystem === 2 && staves.length >= 2) {
    for (let i = 0; i < staves.length; i += 2) groups.push(staves.slice(i, i + 2));
  } else staves.forEach((s) => groups.push([s]));
  return groups;
}

/**
 * Crop bands for systems: each band splits the space between neighbouring
 * systems. Pass the groups from groupSystems, or a number of staves per system.
 */
export function systemBands(staves: Staff[], width: number, height: number, systems: 1 | 2 | Staff[][] = 1): SystemBand[] {
  const groups = Array.isArray(systems) ? systems : fallbackGroups(staves, systems);
  const extent = (g: Staff[]) => {
    let top = Infinity;
    let bottom = -Infinity;
    for (const s of g) {
      for (const x of [0, width / 2, width - 1, s.x0, s.x1]) {
        top = Math.min(top, topAt(s, x));
        bottom = Math.max(bottom, topAt(s, x) + 4 * s.spacing);
      }
    }
    return { top, bottom, sp: g[0].spacing };
  };
  const ex = groups.map(extent);
  return groups.map((g, i) => {
    const e = ex[i];
    // Room above for ledger lines, fingering and the bar number; below for ledger lines and dynamics.
    const above = i > 0 ? (ex[i - 1].bottom + e.top) / 2 : e.top - 7 * e.sp;
    const below = i < ex.length - 1 ? (e.bottom + ex[i + 1].top) / 2 : e.bottom + 7 * e.sp;
    return {
      staves: g,
      y0: Math.max(0, Math.floor(Math.max(above, e.top - 9 * e.sp))),
      y1: Math.min(height, Math.ceil(Math.min(below, e.bottom + 9 * e.sp))),
    };
  });
}
