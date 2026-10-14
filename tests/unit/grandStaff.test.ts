import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { alignRun, groupIntoChords, ScoreFollower } from '../../src/follow/follower';
import { compareHands, exactCounts } from '../../src/sheet/accuracy';
import { checkLine } from '../../src/sheet/checks';
import { buildExpectedNotes } from '../../src/sheet/expected';
import { parseMusicXml } from '../../src/sheet/musicxml';
import { notationToMusicXml, type RnMeasure, type RnScore } from '../../src/sheet/notation';
import { RequestPacer } from '../../src/sheet/pacer';
import type { ReaderRequest, ReaderResult } from '../../src/sheet/omrClient';
import { headsFor, readPrepared, type LineJob } from '../../src/sheet/reader';
import { detectStaves, groupSystems, systemBands } from '../../src/sheet/staffDetect';
import { perfect } from '../fixtures/streams';

/**
 * Piano music: a grand staff (right hand over left hand, joined by a brace)
 * is ONE line of music, read together, with both hands in the same bars.
 * The fixture photo (tests/fixtures/sheets/piano-allegro.webp) has both hands
 * in treble clef; its hand reference is piano-allegro.reference.json.
 */
const ref = JSON.parse(readFileSync('tests/fixtures/sheets/piano-allegro.reference.json', 'utf8')) as RnScore & { lines: [number, number][]; uncertain?: number[] };
const lineBars = (i: number) => ref.measures.filter((m) => Number(m.n) >= ref.lines[i][0] && Number(m.n) <= ref.lines[i][1]);

/** A synthetic page of staves; `joined` pairs get a brace-side line and bar lines running through. */
function page(w: number, h: number, tops: number[], sp: number, joined: number[] = []) {
  const g = new Uint8Array(w * h).fill(235);
  const dot = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) g[Math.round(y) * w + Math.round(x)] = 40;
  };
  const x0 = Math.round(w * 0.05);
  const x1 = Math.round(w * 0.95);
  tops.forEach((top) => {
    for (let x = x0; x < x1; x++) for (let l = 0; l < 5; l++) dot(x, top + l * sp);
    // Bar lines inside the staff, and a few notes with stems.
    for (const bx of [0.3, 0.55, 0.8]) for (let y = top; y <= top + 4 * sp; y++) dot(w * bx, y);
    for (let x = x0 + 60; x < x1 - 20; x += 40) {
      const y = top + ((x / 40) % 8) * (sp / 2);
      for (let dy = -sp / 2; dy <= sp / 2; dy++) for (let dx = -sp * 0.6; dx <= sp * 0.6; dx++) dot(x + dx, y + dy);
      for (let dy = 0; dy < 3.5 * sp; dy++) dot(x + sp * 0.6, y + dy);
    }
  });
  for (const i of joined) {
    const a = tops[i];
    const b = tops[i + 1] + 4 * sp;
    for (let y = a; y <= b; y++) {
      dot(x0, y); // the system's opening line
      for (const bx of [0.3, 0.55, 0.8]) dot(w * bx, y); // bar lines through both staves
    }
  }
  return g;
}

describe('finding grand staves on the page', () => {
  it('groups staves joined by a brace line and bar lines into one system', () => {
    const w = 900;
    const h = 700;
    const tops = [60, 140, 300, 380, 540, 620];
    const gray = page(w, h, tops, 9, [0, 2, 4]);
    const staves = detectStaves(gray, w, h);
    expect(staves).toHaveLength(6);
    const groups = groupSystems(staves, { gray, width: w, height: h });
    expect(groups.map((g) => g.length)).toEqual([2, 2, 2]);
    const bands = systemBands(staves, w, h, groups);
    expect(bands).toHaveLength(3);
    // Each band holds both staves (and the gap between them).
    expect(bands[0].y0).toBeLessThan(60);
    expect(bands[0].y1).toBeGreaterThan(140 + 36);
  });

  it('leaves separate lines of single-staff music alone, whatever the instrument', () => {
    const w = 900;
    const h = 700;
    const tops = [80, 230, 380, 530];
    const gray = page(w, h, tops, 9);
    const staves = detectStaves(gray, w, h);
    expect(groupSystems(staves, { gray, width: w, height: h }).map((g) => g.length)).toEqual([1, 1, 1, 1]);
    // Even for piano: nothing joined anywhere means pairs, as before.
    expect(groupSystems(staves, { gray, width: w, height: h }, 2).map((g) => g.length)).toEqual([2, 2]);
  });

  it('a lone melody staff above a grand staff stays on its own', () => {
    const w = 900;
    const h = 700;
    const tops = [80, 260, 340, 520];
    const gray = page(w, h, tops, 9, [1]);
    const staves = detectStaves(gray, w, h);
    expect(groupSystems(staves, { gray, width: w, height: h }).map((g) => g.length)).toEqual([1, 2, 1]);
  });
});

describe('checks for a grand staff', () => {
  it('both staves must add up to the same length, and both must be there', () => {
    const bars: RnMeasure[] = [
      { n: 1, key: 0, time: '4/4', s1: 'C5q E5q G5q C6q', s2: 'C4e G4e E4e G4e C4e G4e E4e' },
      { n: 2, s1: 'B5e G5e A5e B5e C6q G5q' },
      { n: 3, s1: 'E5q E5q E5q G5q', s2: 'C4e G4e E4e G4e C4e G4e E4e G4e' },
    ];
    const problems = checkLine(bars, { instrument: 'piano', staves: 2 });
    expect(problems.map((p) => [p.n, p.message])).toEqual([
      [1, 'Bar 1 (lower staff) adds up to 3.5 beats instead of 4 beats.'],
      [1, 'Bar 1: the upper staff adds up to 4 beats but the lower staff to 3.5 beats; both hands share the bar.'],
      [2, 'Bar 2: the lower staff is missing (both staves of a grand staff share every bar).'],
    ]);
  });

  it('the reference transcription of the photo is clean', () => {
    expect(checkLine(ref.measures, { instrument: 'piano', staves: 2, firstLine: true, lastLine: true })).toEqual([]);
  });
});

describe('naming the measured heads by the clefs read', () => {
  const job = (clef2?: string): LineJob => ({
    page: 1, pages: 1, line: 1, lines: 1, crop: new Blob(), hint: '', heads: [], firstOfPiece: true, lastOfPiece: true,
    staves: 2, ctx: { key: 0, time: '4/4', clef: 'treble', clef2 }, rawHeads: [[{ x: 10, step: 4 }], [{ x: 10, step: 0 }]],
  });
  it('a treble lower staff is named as treble, never assumed bass', () => {
    expect(headsFor(job('treble'))).toEqual([['B4'], ['E4']]);
    expect(headsFor(job('bass'))).toEqual([['B4'], ['G2']]);
    // The reader's own clef on the line wins over the overview's.
    expect(headsFor(job('bass'), [{ n: 1, clef2: 'treble' }])).toEqual([['B4'], ['E4']]);
  });
  it("with the lower staff's clef unknown, its heads aren't used", () => {
    expect(headsFor(job(undefined))).toEqual([['B4'], []]);
  });
});

describe('reading a grand staff', () => {
  function fakeServer(clef2 = 'treble') {
    const calls: ReaderRequest[] = [];
    const send = async (req: ReaderRequest): Promise<ReaderResult> => {
      calls.push(req);
      if (req.mode === 'overview') return { overview: { title: 'Allegro', key: 0, time: '4/4', clef: 'treble', clef2, staves: 2, lines: 3, first_bars: [null, null, null] }, provider: 'gemini' };
      const first = Number(req.fields.line);
      const lines = req.images.map((_, k) => ({ line: first + k, measures: lineBars(first + k - 1).map((m) => ({ ...m })) }));
      return { line: { lines }, provider: 'gemini' };
    };
    return { calls, send };
  }
  const pg = { context: new Blob(['page']), lines: ref.lines.map((_, i) => new Blob([`line ${i + 1}`])), staves: [2, 2, 2] as (1 | 2)[], detected: true };

  it('each system is one line, read with both staves, and comes out as one piano part on two staves', async () => {
    const { calls, send } = fakeServer();
    // Read for a violin player's profile too: the page decides that it's a grand staff.
    for (const instrument of ['piano', 'violin'] as const) {
      calls.length = 0;
      const result = await readPrepared([pg], { instrument, linesPerRequest: 4, checkRounds: 0, send, pacer: new RequestPacer({ rpm: 100, now: () => 0, sleep: async () => undefined }) });
      const lineCalls = calls.filter((c) => c.mode === 'line');
      expect(lineCalls.every((c) => c.fields.staves === 2 && c.fields.clef2 === 'treble')).toBe(true);
      expect(result.failed).toEqual([]);
      expect(result.flags).toEqual([]);
      // 16 bars, not 32: the left hand is in the same bars as the right hand.
      expect(result.score.measures).toHaveLength(16);
      expect(result.score.staves).toBe(2);
      const xml = result.musicxml;
      expect((xml.match(/<measure /g) ?? []).length).toBe(16);
      expect(xml).toContain('<staves>2</staves>');
      expect((xml.match(/<backup>/g) ?? []).length).toBe(16);
      expect(xml).toMatch(/<clef number="2"><sign>G<\/sign><line>2<\/line>/);
      // Every hand reads exactly right.
      const hands = compareHands(result.score, ref);
      for (const hand of [hands.right, hands.left]) {
        const c = exactCounts(hand);
        expect(c).toMatchObject({ bars: 16, of: 16 });
        expect(c.notes).toBe(c.notesOf);
      }
      expect(exactCounts(hands.right).notesOf).toBe(85);
      expect(exactCounts(hands.left).notesOf).toBe(125);
    }
  });

  it('what the old reading did (left hand appended after the right hand) scores badly per hand', () => {
    const split: RnScore = { ...ref, staves: 1, measures: [...ref.measures.map((m) => ({ ...m, s2: undefined })), ...ref.measures.map((m) => ({ n: Number(m.n) + 16, s1: m.s2 }))] };
    const hands = compareHands(split, ref);
    expect(exactCounts(hands.left).bars).toBe(0);
  });
});

describe('practising a grand staff', () => {
  const score = parseMusicXml(notationToMusicXml(ref, 'Piano').musicxml);
  const { notes, timeline } = buildExpectedNotes(score, { instrument: 'piano', bpm: 100, playRepeats: false });

  it('expects both hands together: notes at the same moment are one chord', () => {
    expect(timeline.order).toHaveLength(16);
    // Bar 1, beat 1: left-hand C4 with right-hand C5.
    expect(notes[0].pitches).toEqual([60, 72]);
    expect(notes[0].onsetQ).toBe(0);
    // Then the left hand's eighth G4 alone.
    expect(notes[1]).toMatchObject({ pitches: [67], onsetQ: 0.5 });
    // Never one hand after the other: no onset past the 16 bars.
    expect(Math.max(...notes.map((n) => n.onsetQ))).toBeLessThan(16 * 4);
  });

  it('the follower takes both hands at once and follows to the end', () => {
    const events = perfect(notes, { jitterMs: 20 });
    const a = alignRun(notes, events, { instrument: 'piano', msPerQuarter: timeline.msPerQuarter });
    expect(a.matches.filter(Boolean).length).toBe(notes.length);
    const f = new ScoreFollower(notes, { instrument: 'piano', msPerQuarter: timeline.msPerQuarter });
    let pos = -1;
    for (const g of groupIntoChords(events)) pos = f.push(g);
    expect(pos).toBe(notes.length - 1);
  });
});
