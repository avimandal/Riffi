import { describe, expect, it } from 'vitest';
import { detectStaves, systemBands, topAt } from '../../src/sheet/staffDetect';

/** A synthetic page: tilted staves, note heads, stems, beams and a block of "text". */
function page(w: number, h: number, tops: number[], sp: number, slope = 0.015, seed = 1) {
  const g = new Uint8Array(w * h).fill(235);
  let r = seed;
  const rand = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < g.length; i++) g[i] = 225 + Math.floor(rand() * 25); // paper texture
  const dot = (x: number, y: number, v = 30) => {
    if (x >= 0 && y >= 0 && x < w && y < h) g[Math.round(y) * w + Math.round(x)] = v;
  };
  for (const top of tops) {
    for (let x = Math.round(w * 0.05); x < w * 0.95; x++) {
      for (let l = 0; l < 5; l++) dot(x, top + slope * x + l * sp, 60 + Math.floor(rand() * 40));
    }
    // Notes: filled heads on lines/spaces with stems, every 25 px.
    for (let x = Math.round(w * 0.1); x < w * 0.9; x += 25) {
      const y = top + slope * x + Math.floor(rand() * 10) * (sp / 2) - sp;
      for (let dy = -sp / 2; dy <= sp / 2; dy++) for (let dx = -sp * 0.7; dx <= sp * 0.7; dx++) dot(x + dx, y + dy);
      for (let dy = 0; dy < 3.5 * sp; dy++) dot(x + sp * 0.7, y - dy);
    }
  }
  // A title block.
  for (let y = 10; y < 40; y++) for (let x = w * 0.3; x < w * 0.7; x++) if ((x + y) % 3 === 0) dot(x, y);
  return g;
}

describe('staff detection', () => {
  it('finds tilted staves on a busy page and follows their slope', () => {
    const w = 900;
    const h = 700;
    const tops = [80, 230, 380, 530];
    const staves = detectStaves(page(w, h, tops, 9), w, h);
    expect(staves).toHaveLength(4);
    staves.forEach((s, i) => {
      expect(s.spacing).toBeCloseTo(9, 0);
      for (const x of [100, 450, 800]) expect(Math.abs(topAt(s, x) - (tops[i] + 0.015 * x))).toBeLessThan(1.6);
    });
    const bands = systemBands(staves, w, h);
    expect(bands).toHaveLength(4);
    bands.forEach((b, i) => {
      // Each band holds its whole staff (plus room) and doesn't reach the next staff.
      expect(b.y0).toBeLessThanOrEqual(tops[i] - 2 * 9);
      expect(b.y1).toBeGreaterThanOrEqual(tops[i] + 0.015 * w + 4 * 9 + 2 * 9);
      if (i < 3) expect(b.y1).toBeLessThan(tops[i + 1]);
    });
  });

  it('pairs staves into systems for piano', () => {
    const w = 800;
    const h = 700;
    const staves = detectStaves(page(w, h, [80, 170, 380, 470], 8, 0.005), w, h);
    expect(staves).toHaveLength(4);
    const bands = systemBands(staves, w, h, 2);
    expect(bands.map((b) => b.staves.length)).toEqual([2, 2]);
    expect(bands[0].y1).toBeLessThan(380);
  });

  it('finds nothing on a page without music', () => {
    const w = 600;
    const h = 400;
    expect(detectStaves(page(w, h, [], 9), w, h)).toEqual([]);
  });
});
