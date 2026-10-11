import type { Instrument } from '../config';
import { parseStaff, type RnEvent, type RnMeasure } from './notation';

/**
 * Free checks (no AI) on a transcription: does each bar add up, is the key
 * signature there and actually applied, are notes in the instrument's range,
 * do tuplets have the right number of notes. Problems go to the AI's
 * double-check pass and, if they survive it, are highlighted on the review screen.
 */

export type ProblemKind = 'syntax' | 'duration' | 'key' | 'time' | 'range' | 'tuplet';

export interface BarProblem {
  /** Printed bar number. */
  n: number;
  kind: ProblemKind;
  message: string;
}

export interface LineContext {
  /** Key (fifths) and time carried in from the previous line, if known. */
  key?: number;
  time?: string;
  instrument: Instrument;
  /** The first line of the piece may start with a pickup bar. */
  firstLine?: boolean;
  /** The last line of the piece may end with a short bar (completing a pickup). */
  lastLine?: boolean;
}

/** Lowest and highest MIDI notes we expect for each instrument. */
export const RANGE: Record<Instrument, [number, number]> = {
  violin: [55, 100], // G3 (open G) to E7
  voice: [45, 84], // A2 to C6, generous for kids and adults
  piano: [21, 108],
};

const STEP_SEMI: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];

export function midiOf(p: { step: string; alter: number; octave: number }): number {
  return (p.octave + 1) * 12 + STEP_SEMI[p.step] + p.alter;
}

/** How the key signature alters each letter: {F: 1, C: 1} for D major. Pure. */
export function keyAlters(fifths: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (fifths > 0) SHARP_ORDER.slice(0, fifths).forEach((s) => (out[s] = 1));
  if (fifths < 0) [...SHARP_ORDER].reverse().slice(0, -fifths).forEach((s) => (out[s] = -1));
  return out;
}

export function barLength(time: string | undefined): number {
  const [b, t] = (time ?? '4/4').split('/').map(Number);
  return b > 0 && t > 0 ? (b * 4) / t : 4;
}

export const fmtBeats = (q: number) => {
  const r = Math.round(q * 1000) / 1000;
  return `${r} ${r === 1 ? 'beat' : 'beats'}`;
};

/** Tuplet groups as written: [actual, notes inside]. Unclosed groups are reported. */
function tupletGroups(src: string): { groups: { actual: number; count: number }[]; unclosed: boolean } {
  const text = src.replace(/(\d)\(/g, ' $1( ').replace(/(?<!\d)\(/g, ' ( ').replace(/\)/g, ' ) ');
  const groups: { actual: number; count: number }[] = [];
  let cur: { actual: number; count: number } | null = null;
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    const open = tok.match(/^(\d)\($/);
    if (open) {
      if (cur) groups.push(cur);
      cur = { actual: Number(open[1]), count: 0 };
    } else if (tok === ')') {
      if (cur) groups.push(cur);
      cur = null;
    } else if (cur && tok !== '(') {
      cur.count++;
    }
  }
  return { groups, unclosed: cur !== null };
}

/**
 * Notes written without an accidental where the key signature says sharp/flat:
 * the reader probably forgot to apply the key (RN wants sounding pitches, with
 * naturals written as "n"). Accidentals earlier in the bar carry on.
 */
function keyMisses(src: string, fifths: number): string[] {
  const alters = keyAlters(fifths);
  // Read the raw note names to tell "F5" (no accidental written) from "Fn5".
  const names = [...src.matchAll(/([A-G])(##|#|bb|b|n)?(\d)/g)].map((m) => ({ step: m[1], acc: m[2] ?? '', octave: Number(m[3]) }));
  const carried = new Map<string, string>();
  const misses: string[] = [];
  for (const nm of names) {
    const id = `${nm.step}${nm.octave}`;
    if (nm.acc) {
      carried.set(id, nm.acc);
      continue;
    }
    if (alters[nm.step] && !carried.has(id)) misses.push(`${nm.step}${nm.octave}`);
  }
  return misses;
}

/** Check one line's bars. Returns problems in bar order. Pure. */
export function checkLine(measures: RnMeasure[], ctx: LineContext): BarProblem[] {
  const problems: BarProblem[] = [];
  let key = ctx.key;
  let time = ctx.time;
  const [lo, hi] = RANGE[ctx.instrument];
  measures.forEach((m, i) => {
    const n = Number.isFinite(Number(m.n)) ? Number(m.n) : i + 1;
    if (m.key !== undefined) {
      if (!Number.isInteger(m.key) || m.key < -7 || m.key > 7) problems.push({ n, kind: 'key', message: `Bar ${n}: the key signature "${m.key}" isn't a number of sharps (1 to 7) or flats (-1 to -7).` });
      else key = m.key;
    }
    if (m.time !== undefined) {
      if (!/^\d{1,2}\/(1|2|4|8|16|32)$/.test(m.time)) problems.push({ n, kind: 'time', message: `Bar ${n}: the time signature "${m.time}" doesn't look right.` });
      else time = m.time;
    }
    if (i === 0 && key === undefined) problems.push({ n, kind: 'key', message: `Bar ${n}: no key signature was given (use 0 for no sharps or flats).` });
    if (i === 0 && time === undefined) problems.push({ n, kind: 'time', message: `Bar ${n}: no time signature was given.` });

    const want = barLength(time);
    for (const staff of ['s1', 's2'] as const) {
      const src = m[staff];
      if (src === undefined) continue;
      let events: RnEvent[];
      try {
        events = parseStaff(src);
      } catch (e) {
        problems.push({ n, kind: 'syntax', message: `Bar ${n}${staff === 's2' ? ' (lower staff)' : ''}: ${(e as Error).message}.` });
        continue;
      }
      const where = staff === 's2' ? ' (lower staff)' : '';
      // Duration.
      if (!events.some((e) => e.kind === 'barRest')) {
        const got = events.reduce((sum, e) => sum + e.quarters, 0);
        const firstBar = ctx.firstLine && i === 0;
        const lastBar = ctx.lastLine && i === measures.length - 1;
        const short = got < want - 1e-6;
        const ok = Math.abs(got - want) < 1e-6 || (short && got > 0 && (m.pickup || firstBar || lastBar));
        if (!ok) problems.push({ n, kind: 'duration', message: `Bar ${n}${where} adds up to ${fmtBeats(got)} instead of ${fmtBeats(want)}${m.pickup && !short ? ' (marked as a pickup, but it is full)' : ''}.` });
      }
      // Key signature applied.
      if (key !== undefined && key !== 0) {
        const misses = keyMisses(src, key);
        if (misses.length) problems.push({ n, kind: 'key', message: `Bar ${n}${where}: ${[...new Set(misses)].join(', ')} ${misses.length === 1 ? 'has' : 'have'} no sharp or flat, but the key signature (${keyName(key)}) changes ${misses.length === 1 ? 'it' : 'them'}. Write the sounding pitch, or "n" for a printed natural.` });
      }
      // Range (piano: each staff can go anywhere on the keyboard).
      const out = events.flatMap((e) => e.pitches).map(midiOf).filter((p) => p < lo || p > hi);
      if (out.length) problems.push({ n, kind: 'range', message: `Bar ${n}${where}: ${out.length === 1 ? 'a note is' : `${out.length} notes are`} outside the ${ctx.instrument === 'voice' ? 'singing' : ctx.instrument} range (check the octave or ledger lines).` });
      // Tuplets.
      const { groups, unclosed } = tupletGroups(src);
      if (unclosed) problems.push({ n, kind: 'tuplet', message: `Bar ${n}${where}: a tuplet bracket "(" isn't closed with ")".` });
      for (const g of groups) {
        if (g.count !== g.actual) problems.push({ n, kind: 'tuplet', message: `Bar ${n}${where}: a ${g.actual}-tuplet has ${g.count} ${g.count === 1 ? 'note' : 'notes'} in it.` });
      }
    }
  });
  return problems;
}

export function keyName(fifths: number): string {
  if (fifths === 0) return 'no sharps or flats';
  return fifths > 0 ? `${fifths} ${fifths === 1 ? 'sharp' : 'sharps'}` : `${-fifths} ${fifths === -1 ? 'flat' : 'flats'}`;
}
