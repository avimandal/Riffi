/**
 * MusicXML (3.1 partwise) parser. Produces a flat, position-annotated model
 * that the rest of the app (expected notes, editor, OSMD mapping) works from.
 *
 * Positions are in quarter notes ("Q") so they are independent of
 * `<divisions>`, which can change mid-piece.
 */

export interface ScorePart {
  id: string;
  name: string;
  staves: number;
}

export interface ScoreMeasure {
  index: number;
  /** The printed measure number (may be "0" for a pickup, or "12a"). */
  number: string;
  /** Start in the unexpanded score, in quarters. */
  startQ: number;
  lengthQ: number;
  beats: number;
  beatType: number;
  fifths: number;
  mode: string;
  forwardRepeat: boolean;
  backwardRepeat: boolean;
  /** Total number of times a backward-repeat section is played (default 2). */
  repeatTimes: number;
  /** Volta numbers this measure belongs to, if inside an ending bracket. */
  endingNumbers?: number[];
  /** Tempo change (quarter notes per minute) that starts in this measure. */
  tempoQ?: number;
  /** True for a pickup/anacrusis (implicit="yes"). */
  implicit: boolean;
}

export interface ScoreNote {
  /** Index of this `<note>` element in document order. Stable identifier for editing. */
  xmlIndex: number;
  partIndex: number;
  staff: number;
  voice: string;
  measureIndex: number;
  /** Start within the measure, in quarters. */
  startQ: number;
  durationQ: number;
  isRest: boolean;
  isChord: boolean;
  isGrace: boolean;
  midi?: number;
  step?: string;
  alter?: number;
  octave?: number;
  tieStart: boolean;
  tieStop: boolean;
  type?: string;
  dots: number;
}

export interface ParsedScore {
  title: string;
  parts: ScorePart[];
  measures: ScoreMeasure[];
  notes: ScoreNote[];
  /** First tempo marking in quarter notes per minute, if present. */
  tempoQ?: number;
}

export class MusicXmlError extends Error {}

const STEP_SEMITONES: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export function pitchToMidi(step: string, alter: number, octave: number): number {
  const base = STEP_SEMITONES[step.toUpperCase()];
  if (base === undefined) throw new MusicXmlError(`Unknown pitch step "${step}"`);
  return (octave + 1) * 12 + base + alter;
}

function childrenByTag(el: Element, tag: string): Element[] {
  const out: Element[] = [];
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === tag) out.push(c);
  }
  return out;
}

function child(el: Element | null | undefined, tag: string): Element | null {
  if (!el) return null;
  for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
    if (c.localName === tag) return c;
  }
  return null;
}

function childText(el: Element | null | undefined, tag: string): string | null {
  const c = child(el, tag);
  return c ? (c.textContent ?? '').trim() : null;
}

function num(text: string | null | undefined, fallback: number): number {
  if (text === null || text === undefined || text === '') return fallback;
  const n = Number(text);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse an XML string into a DOM Document, throwing a readable error on failure. */
export function parseXmlDocument(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) {
    throw new MusicXmlError(`The music file couldn't be read: ${(err.textContent ?? '').trim().slice(0, 200)}`);
  }
  return doc;
}

const BEAT_UNIT_QUARTERS: Record<string, number> = {
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
};

function readTempoFromDirection(dir: Element): number | undefined {
  const sound = child(dir, 'sound');
  const t = sound?.getAttribute('tempo');
  if (t && Number(t) > 0) return Number(t);
  const dtypes = childrenByTag(dir, 'direction-type');
  for (const dt of dtypes) {
    const metro = child(dt, 'metronome');
    if (!metro) continue;
    const unit = childText(metro, 'beat-unit') ?? 'quarter';
    const perMin = num(childText(metro, 'per-minute'), NaN);
    if (!Number.isFinite(perMin) || perMin <= 0) continue;
    let q = BEAT_UNIT_QUARTERS[unit] ?? 1;
    if (child(metro, 'beat-unit-dot')) q *= 1.5;
    return perMin * q;
  }
  return undefined;
}

export function parseMusicXml(xml: string | Document): ParsedScore {
  const doc = typeof xml === 'string' ? parseXmlDocument(xml) : xml;
  const root = doc.documentElement;
  if (!root || root.localName !== 'score-partwise') {
    throw new MusicXmlError('Only partwise MusicXML is supported.');
  }

  const title =
    childText(child(root, 'work'), 'work-title') || childText(root, 'movement-title') || 'Untitled';

  const partListEl = child(root, 'part-list');
  const partNames = new Map<string, string>();
  if (partListEl) {
    for (const sp of childrenByTag(partListEl, 'score-part')) {
      partNames.set(sp.getAttribute('id') ?? '', childText(sp, 'part-name') ?? '');
    }
  }

  const partEls = childrenByTag(root, 'part');
  if (partEls.length === 0) throw new MusicXmlError('The music has no parts.');

  // Document-order index for every <note>.
  const allNotes = Array.from(doc.getElementsByTagName('note'));
  const noteIndex = new Map<Element, number>();
  allNotes.forEach((n, i) => noteIndex.set(n, i));

  const parts: ScorePart[] = [];
  const notes: ScoreNote[] = [];
  const measures: ScoreMeasure[] = [];
  let firstTempo: number | undefined;

  partEls.forEach((partEl, partIndex) => {
    const id = partEl.getAttribute('id') ?? `P${partIndex + 1}`;
    const part: ScorePart = { id, name: partNames.get(id) ?? '', staves: 1 };
    parts.push(part);

    let divisions = 1;
    let beats = 4;
    let beatType = 4;
    let fifths = 0;
    let mode = 'major';
    let inEnding: number[] | undefined;
    let startQ = 0;

    childrenByTag(partEl, 'measure').forEach((mEl, mIndex) => {
      let pos = 0; // in divisions
      let maxPos = 0;
      let lastNoteStart = 0;
      let forwardRepeat = false;
      let backwardRepeat = false;
      let repeatTimes = 2;
      let endingThis: number[] | undefined = inEnding;
      let endingStopsAfter = false;
      let tempoHere: number | undefined;

      for (let el = mEl.firstElementChild; el; el = el.nextElementSibling) {
        switch (el.localName) {
          case 'attributes': {
            divisions = num(childText(el, 'divisions'), divisions);
            const key = child(el, 'key');
            if (key) {
              fifths = num(childText(key, 'fifths'), fifths);
              mode = childText(key, 'mode') ?? mode;
            }
            const time = child(el, 'time');
            if (time) {
              // Compound signatures like "3+2" are summed.
              const b = (childText(time, 'beats') ?? '4').split('+').reduce((s, x) => s + num(x, 0), 0);
              beats = b > 0 ? b : beats;
              beatType = num(childText(time, 'beat-type'), beatType);
            }
            part.staves = Math.max(part.staves, num(childText(el, 'staves'), 1));
            break;
          }
          case 'direction': {
            const t = readTempoFromDirection(el);
            if (t !== undefined) {
              tempoHere ??= t;
              firstTempo ??= t;
            }
            break;
          }
          case 'sound': {
            const t = el.getAttribute('tempo');
            if (t && Number(t) > 0) {
              tempoHere ??= Number(t);
              firstTempo ??= Number(t);
            }
            break;
          }
          case 'backup':
            pos = Math.max(0, pos - num(childText(el, 'duration'), 0));
            break;
          case 'forward':
            pos += num(childText(el, 'duration'), 0);
            maxPos = Math.max(maxPos, pos);
            break;
          case 'barline': {
            const loc = el.getAttribute('location') ?? 'right';
            const rep = child(el, 'repeat');
            if (rep) {
              const dir = rep.getAttribute('direction');
              if (dir === 'forward') forwardRepeat = true;
              if (dir === 'backward') {
                backwardRepeat = true;
                repeatTimes = Math.max(2, num(rep.getAttribute('times'), 2));
              }
            }
            const ending = child(el, 'ending');
            if (ending) {
              const type = ending.getAttribute('type');
              const numbers = (ending.getAttribute('number') ?? '1')
                .split(/[,\s]+/)
                .map((s) => parseInt(s, 10))
                .filter((n) => Number.isFinite(n));
              if (type === 'start' && (loc === 'left' || !endingThis)) {
                endingThis = numbers;
                inEnding = numbers;
              } else if (type === 'stop' || type === 'discontinue') {
                endingStopsAfter = true;
              }
            }
            break;
          }
          case 'note': {
            const isChord = !!child(el, 'chord');
            const isGrace = !!child(el, 'grace');
            const isRest = !!child(el, 'rest');
            const durDiv = isGrace ? 0 : num(childText(el, 'duration'), 0);
            const start = isChord ? lastNoteStart : pos;
            if (!isChord) {
              lastNoteStart = pos;
              pos += durDiv;
              maxPos = Math.max(maxPos, pos);
            }
            const pitchEl = child(el, 'pitch');
            let midi: number | undefined;
            let step: string | undefined;
            let alter: number | undefined;
            let octave: number | undefined;
            if (pitchEl && !isRest) {
              step = childText(pitchEl, 'step') ?? 'C';
              alter = num(childText(pitchEl, 'alter'), 0);
              octave = num(childText(pitchEl, 'octave'), 4);
              midi = pitchToMidi(step, alter, octave);
            }
            const ties = childrenByTag(el, 'tie');
            const tiedEls = Array.from(child(el, 'notations')?.getElementsByTagName('tied') ?? []);
            const tieTypes = [...ties, ...tiedEls].map((t) => t.getAttribute('type'));
            notes.push({
              xmlIndex: noteIndex.get(el) ?? -1,
              partIndex,
              staff: num(childText(el, 'staff'), 1),
              voice: childText(el, 'voice') ?? '1',
              measureIndex: mIndex,
              startQ: start / divisions,
              durationQ: durDiv / divisions,
              isRest: isRest || !pitchEl,
              isChord,
              isGrace,
              midi,
              step,
              alter,
              octave,
              tieStart: tieTypes.includes('start'),
              tieStop: tieTypes.includes('stop'),
              type: childText(el, 'type') ?? undefined,
              dots: childrenByTag(el, 'dot').length,
            });
            break;
          }
          default:
            break;
        }
      }

      const nominal = (beats * 4) / beatType;
      const lengthQ = maxPos > 0 ? maxPos / divisions : nominal;
      const implicit = mEl.getAttribute('implicit') === 'yes';

      if (partIndex === 0) {
        measures.push({
          index: mIndex,
          number: mEl.getAttribute('number') ?? String(mIndex + 1),
          startQ,
          lengthQ,
          beats,
          beatType,
          fifths,
          mode,
          forwardRepeat,
          backwardRepeat,
          repeatTimes,
          endingNumbers: endingThis,
          tempoQ: tempoHere,
          implicit,
        });
        startQ += lengthQ;
      } else if (measures[mIndex]) {
        // Other parts can only lengthen a measure, and can carry repeat marks.
        const m = measures[mIndex];
        if (lengthQ > m.lengthQ + 1e-6) m.lengthQ = lengthQ;
        m.forwardRepeat ||= forwardRepeat;
        m.backwardRepeat ||= backwardRepeat;
        m.tempoQ ??= tempoHere;
      }
      if (endingStopsAfter) inEnding = undefined;
    });
  });

  // Recompute starts in case another part lengthened a measure.
  let s = 0;
  for (const m of measures) {
    m.startQ = s;
    s += m.lengthQ;
  }

  return { title, parts, measures, notes, tempoQ: firstTempo };
}

/** Count the pitched notes in a score (used to validate OMR output). */
export function countPitchedNotes(score: ParsedScore): number {
  return score.notes.filter((n) => !n.isRest && n.midi !== undefined).length;
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Kid-friendly note name, spelled to suit the key signature. Uses ♯ and ♭. */
export function noteName(midi: number, fifths = 0, withOctave = false): string {
  const pc = ((Math.round(midi) % 12) + 12) % 12;
  const raw = (fifths < 0 ? FLAT_NAMES : SHARP_NAMES)[pc];
  const pretty = raw.replace('#', '♯').replace('b', '♭');
  if (!withOctave) return pretty;
  return `${pretty}${Math.floor(Math.round(midi) / 12) - 1}`;
}

/** Spell a note with the step/alter MusicXML wants, guided by the key signature. */
export function spellMidi(midi: number, fifths = 0): { step: string; alter: number; octave: number } {
  const pc = ((midi % 12) + 12) % 12;
  const octave = Math.floor(midi / 12) - 1;
  const name = (fifths < 0 ? FLAT_NAMES : SHARP_NAMES)[pc];
  const step = name[0];
  const alter = name.length > 1 ? (name[1] === '#' ? 1 : -1) : 0;
  return { step, alter, octave };
}

const ORDER_OF_SHARPS = ['F', 'C', 'G', 'D', 'A', 'E', 'B'];

/** The letters a key signature changes, e.g. fifths=2 → { F: 1, C: 1 }. */
export function keySignatureAlters(fifths: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (fifths > 0) ORDER_OF_SHARPS.slice(0, fifths).forEach((s) => (out[s] = 1));
  if (fifths < 0) [...ORDER_OF_SHARPS].reverse().slice(0, -fifths).forEach((s) => (out[s] = -1));
  return out;
}

const MAJOR_KEYS = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];
const MINOR_KEYS = ['A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯', 'G♯', 'D♯', 'A♯'];

export function keyName(fifths: number, mode = 'major'): string {
  const i = Math.max(-7, Math.min(7, fifths)) + 7;
  return mode === 'minor' ? `${MINOR_KEYS[i]} minor` : `${MAJOR_KEYS[i]} major`;
}
