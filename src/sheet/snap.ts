import { keyAlters } from './checks';
import type { RnMeasure } from './notation';

/**
 * Trust the measured note heads for pitch: line the transcription's notes up
 * with the heads measured on the photo (in order), and where a note sits on a
 * different line or space than its head, move it there. The model still
 * decides everything else: rhythm, accidentals (kept when the letter doesn't
 * change), ties, tuplets, rests, chords and bar lines.
 *
 * How: notes that already sit exactly on a head (in order) are anchors.
 * Between two anchors, if there are as many heads as notes (or up to two more:
 * stray marks like fingering), the notes take those heads' positions one to
 * one, however far off they were (a misread octave, a slipped line); a lone
 * note only moves by up to a third. The ends of a line, stretches that don't
 * match in count, chords, and lines where under a third of the notes agree
 * with the heads are left alone.
 */

const LETTERS = 'CDEFGAB';
const NOTE = /^([A-G])(##|#|bb|b|n)?(\d)([whqest].*)$/;
const ACC: Record<string, string> = { '1': '#', '-1': 'b', '0': '' };

const diatonic = (name: string) => LETTERS.indexOf(name[0]) + 7 * Number(name.slice(1));

interface Slot {
  m: number;
  staff: 's1' | 's2';
  token: number;
  name: string;
  snappable: boolean;
}

/** A line is snapped only if at least this share of its notes already sit on their heads. */
const MIN_AGREEMENT = 0.35;
/** Longest stretch between two agreeing notes that is filled in. */
const MAX_GAP = 8;
/** Extra heads (stray marks) a stretch may have over its notes. */
const MAX_EXTRA = 2;
/** A lone note between two agreeing ones is weak evidence: only moved by up to a third. */
const MAX_LONE_MOVE = 2;

/** Notes and heads that agree exactly, in order (longest common subsequence). */
function anchors(notes: string[], heads: string[]): [number, number][] {
  const A = notes.length;
  const B = heads.length;
  const dp = Array.from({ length: A + 1 }, () => new Uint16Array(B + 1));
  for (let i = A - 1; i >= 0; i--) for (let j = B - 1; j >= 0; j--) dp[i][j] = notes[i] === heads[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < A && j < B; ) {
    if (notes[i] === heads[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/**
 * Between two agreeing notes, notes and heads that come in the same number are
 * the same notes, however far the model's pitch was off (a misread octave, a
 * line slipped). With a couple of extra heads (stray marks), the heads closest
 * in pitch are used. Returns [noteIndex, headIndex] pairs to move.
 */
function fillGaps(notes: string[], heads: string[], anchor: [number, number][]): [number, number][] {
  const moves: [number, number][] = [];
  // Only stretches with an agreeing note on both sides (the ends of a line are left alone).
  for (let k = 0; k + 1 < anchor.length; k++) {
    const [i0, j0] = anchor[k];
    const [i1, j1] = anchor[k + 1];
    const n = i1 - i0 - 1;
    const h = j1 - j0 - 1;
    if (n < 1 || n > MAX_GAP || h < n || h - n > MAX_EXTRA) continue;
    // Choose which n of the h heads, in order, are closest in pitch (small DP).
    const cost = Array.from({ length: n + 1 }, () => new Float64Array(h + 1).fill(Infinity));
    for (let j = 0; j <= h; j++) cost[n][j] = 0;
    for (let i = n - 1; i >= 0; i--) {
      for (let j = h - 1; j >= 0; j--) {
        const d = Math.abs(diatonic(notes[i0 + 1 + i]) - diatonic(heads[j0 + 1 + j]));
        cost[i][j] = Math.min(cost[i][j + 1], d + cost[i + 1][j + 1]);
      }
    }
    for (let i = 0, j = 0; i < n; ) {
      const d = Math.abs(diatonic(notes[i0 + 1 + i]) - diatonic(heads[j0 + 1 + j]));
      if (cost[i][j] === d + cost[i + 1][j + 1]) {
        if (n > 1 || d <= MAX_LONE_MOVE) moves.push([i0 + 1 + i, j0 + 1 + j]);
        i++;
        j++;
      } else j++;
    }
  }
  return moves;
}

const tokens = (src: string) => src.replace(/(\d)\(/g, ' $1( ').replace(/(?<!\d)\(/g, ' ( ').replace(/\)/g, ' ) ').split(/\s+/).filter(Boolean);

/**
 * Snap one line's pitches to the measured heads (natural names per staff, left
 * to right). `fifths` is the key at the start of the line. Pure.
 */
export function snapToHeads(measures: RnMeasure[], heads: string[][], fifths = 0): { measures: RnMeasure[]; moved: number } {
  const out = measures.map((m) => ({ ...m }));
  const toks = out.map((m) => ({ s1: m.s1 ? tokens(m.s1) : [], s2: m.s2 ? tokens(m.s2) : [] }));
  let moved = 0;
  (['s1', 's2'] as const).forEach((staff, si) => {
    const found = heads[si];
    if (!found || found.length === 0) return;
    const slots: Slot[] = [];
    toks.forEach((t, m) =>
      t[staff].forEach((tok, k) => {
        const single = tok.includes('+') ? null : tok.match(NOTE);
        if (single) slots.push({ m, staff, token: k, name: `${single[1]}${single[3]}`, snappable: true });
        else if (/^[A-G]/.test(tok)) {
          // A chord: it takes part in the line-up (its first note), but isn't moved.
          const first = tok.match(/^([A-G])(?:##|#|bb|b|n)?(\d)/);
          if (first) slots.push({ m, staff, token: k, name: `${first[1]}${first[2]}`, snappable: false });
        }
      }),
    );
    if (slots.length < 4 || found.length < slots.length * 0.6) return;
    const names = slots.map((x) => x.name);
    const agree = anchors(names, found);
    if (agree.length < slots.length * MIN_AGREEMENT) return;
    for (const [i, j] of fillGaps(names, found, agree)) {
      const s = slots[i];
      if (!s.snappable || s.name === found[j]) continue;
      // rest = length, dots and any tie, kept exactly as the model wrote them.
      const [, , acc = '', , rest] = toks[s.m][staff][s.token].match(NOTE)!;
      const letter = found[j][0];
      const octave = found[j].slice(1);
      let newAcc: string;
      if (letter === s.name[0]) newAcc = acc; // same letter, other octave: keep the model's accidental
      else {
        // An accidental written earlier in the bar on this note carries on; otherwise the key signature applies.
        const earlier = toks[s.m][staff]
          .slice(0, s.token)
          .map((x) => x.match(/^([A-G])(##|#|bb|b|n)?(\d)/))
          .filter((x): x is RegExpMatchArray => !!x && x[1] === letter && x[3] === octave && !!x[2]);
        newAcc = earlier.length ? earlier[earlier.length - 1][2] : ACC[String(keyAlters(fifths)[letter] ?? 0)];
      }
      toks[s.m][staff][s.token] = `${letter}${newAcc}${octave}${rest}`;
      moved++;
    }
  });
  if (moved === 0) return { measures, moved };
  toks.forEach((t, m) => {
    if (out[m].s1 !== undefined) out[m].s1 = t.s1.join(' ');
    if (out[m].s2 !== undefined) out[m].s2 = t.s2.join(' ');
  });
  return { measures: out, moved };
}
