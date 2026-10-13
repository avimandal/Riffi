/**
 * Tap-to-fix edits on a MusicXML document (SPEC §4 review screen).
 * Every function takes a Document and mutates it; callers serialise and re-render.
 * Notes are addressed by their document-order index among `<note>` elements,
 * which is what the parser reports as `xmlIndex`.
 */
import { pitchToMidi, spellMidi } from './musicxml';

export const EDIT_DIVISIONS = 96;

export const NOTE_TYPES = ['whole', 'half', 'quarter', 'eighth', '16th'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

const TYPE_QUARTERS: Record<string, number> = {
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
};

function kids(el: Element, tag: string): Element[] {
  return Array.from(el.children).filter((c) => c.localName === tag);
}

function kid(el: Element, tag: string): Element | null {
  return kids(el, tag)[0] ?? null;
}

function make(doc: Document, tag: string, text?: string): Element {
  const el = doc.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Insert `child` among `parent`'s children following MusicXML's element order. */
function insertInOrder(parent: Element, child: Element, order: string[]) {
  const idx = order.indexOf(child.localName);
  for (const c of Array.from(parent.children)) {
    const ci = order.indexOf(c.localName);
    if (ci > idx) {
      parent.insertBefore(child, c);
      return;
    }
  }
  parent.appendChild(child);
}

const NOTE_ORDER = [
  'grace', 'cue', 'chord', 'pitch', 'unpitched', 'rest', 'duration', 'tie', 'instrument', 'footnote', 'level',
  'voice', 'type', 'dot', 'accidental', 'time-modification', 'stem', 'notehead', 'notehead-text', 'staff', 'beam',
  'notations', 'lyric', 'play', 'listen',
];
const PITCH_ORDER = ['step', 'alter', 'octave'];

export function noteElements(doc: Document): Element[] {
  return Array.from(doc.getElementsByTagName('note'));
}

export function getNote(doc: Document, xmlIndex: number): Element {
  const el = noteElements(doc)[xmlIndex];
  if (!el) throw new Error(`No note at index ${xmlIndex}`);
  return el;
}

function measureOf(note: Element): Element | null {
  let p = note.parentElement;
  while (p && p.localName !== 'measure') p = p.parentElement;
  return p;
}

function partOf(el: Element): Element | null {
  let p = el.parentElement;
  while (p && p.localName !== 'part') p = p.parentElement;
  return p;
}

/**
 * Rescale every duration so `<divisions>` is EDIT_DIVISIONS throughout.
 * Makes duration edits simple integers.
 */
export function normaliseDivisions(doc: Document) {
  for (const part of Array.from(doc.getElementsByTagName('part'))) {
    let d = 1;
    for (const m of kids(part, 'measure')) {
      for (const el of Array.from(m.children)) {
        if (el.localName === 'attributes') {
          const div = kid(el, 'divisions');
          if (div) {
            d = Number(div.textContent) || d;
            div.textContent = String(EDIT_DIVISIONS);
          }
        }
        if (el.localName === 'note' || el.localName === 'backup' || el.localName === 'forward') {
          const dur = kid(el, 'duration');
          if (dur) dur.textContent = String(Math.round((Number(dur.textContent) * EDIT_DIVISIONS) / d));
        }
      }
    }
    // Make sure the first measure declares divisions.
    const first = kid(part, 'measure');
    if (first) {
      let attrs = kid(first, 'attributes');
      if (!attrs) {
        attrs = make(doc, 'attributes');
        first.insertBefore(attrs, first.firstElementChild);
      }
      if (!kid(attrs, 'divisions')) attrs.insertBefore(make(doc, 'divisions', String(EDIT_DIVISIONS)), attrs.firstElementChild);
    }
  }
}

/** Notes sounding together with this one (`<chord/>` followers), including itself. */
function chordGroup(note: Element): Element[] {
  const all = noteElements(note.ownerDocument);
  let i = all.indexOf(note);
  while (i > 0 && kid(all[i], 'chord')) i--;
  const group = [all[i]];
  for (let j = i + 1; j < all.length && kid(all[j], 'chord'); j++) group.push(all[j]);
  return group;
}

/** Key signature in effect for a note. */
export function fifthsAt(note: Element): number {
  const part = partOf(note);
  if (!part) return 0;
  let fifths = 0;
  for (const m of kids(part, 'measure')) {
    for (const el of Array.from(m.children)) {
      if (el === note) return fifths;
      if (el.localName === 'attributes') {
        const key = kid(el, 'key');
        if (key) fifths = Number(kid(key, 'fifths')?.textContent) || 0;
      }
    }
  }
  return fifths;
}

function stripBeams(measure: Element | null) {
  if (!measure) return;
  for (const b of Array.from(measure.getElementsByTagName('beam'))) b.remove();
}

function setPitch(note: Element, midi: number, fifths: number) {
  const doc = note.ownerDocument;
  const { step, alter, octave } = spellMidi(midi, fifths);
  let pitch = kid(note, 'pitch');
  if (!pitch) {
    pitch = make(doc, 'pitch');
    insertInOrder(note, pitch, NOTE_ORDER);
  }
  pitch.replaceChildren();
  insertInOrder(pitch, make(doc, 'step', step), PITCH_ORDER);
  if (alter) insertInOrder(pitch, make(doc, 'alter', String(alter)), PITCH_ORDER);
  insertInOrder(pitch, make(doc, 'octave', String(octave)), PITCH_ORDER);
  // Let the renderer work accidentals out from the key signature.
  kid(note, 'accidental')?.remove();
}

export function noteMidi(note: Element): number | null {
  const pitch = kid(note, 'pitch');
  if (!pitch) return null;
  return pitchToMidi(
    kid(pitch, 'step')?.textContent?.trim() ?? 'C',
    Number(kid(pitch, 'alter')?.textContent ?? 0),
    Number(kid(pitch, 'octave')?.textContent ?? 4),
  );
}

/** Move a note up or down by semitones, spelt to suit the key. */
export function transpose(doc: Document, xmlIndex: number, semitones: number) {
  const note = getNote(doc, xmlIndex);
  const midi = noteMidi(note);
  if (midi === null) return;
  const next = Math.max(21, Math.min(108, midi + semitones));
  setPitch(note, next, fifthsAt(note));
}

/** Change a note's (or chord's) written length. */
export function setDuration(doc: Document, xmlIndex: number, type: NoteType, dots = 0) {
  normaliseDivisions(doc);
  const note = getNote(doc, xmlIndex);
  const quarters = TYPE_QUARTERS[type] * (dots === 1 ? 1.5 : dots === 2 ? 1.75 : 1);
  const duration = Math.round(quarters * EDIT_DIVISIONS);
  for (const n of chordGroup(note)) {
    let dur = kid(n, 'duration');
    if (!dur) {
      dur = make(doc, 'duration');
      insertInOrder(n, dur, NOTE_ORDER);
    }
    dur.textContent = String(duration);
    let t = kid(n, 'type');
    if (!t) {
      t = make(doc, 'type');
      insertInOrder(n, t, NOTE_ORDER);
    }
    t.textContent = type;
    kids(n, 'dot').forEach((d) => d.remove());
    for (let i = 0; i < dots; i++) insertInOrder(n, make(doc, 'dot'), NOTE_ORDER);
    kid(n, 'time-modification')?.remove();
    for (const tup of Array.from(n.getElementsByTagName('tuplet'))) tup.remove();
  }
  stripBeams(measureOf(note));
}

export function isRest(doc: Document, xmlIndex: number): boolean {
  return !!kid(getNote(doc, xmlIndex), 'rest');
}

/** Turn a note into a rest of the same length, or a rest into a note. */
export function toggleRest(doc: Document, xmlIndex: number, pitchForNewNote = 71) {
  const note = getNote(doc, xmlIndex);
  if (kid(note, 'rest')) {
    kid(note, 'rest')!.remove();
    setPitch(note, pitchForNewNote, fifthsAt(note));
    return;
  }
  // A chord member can't become a rest on its own: remove it instead.
  if (kid(note, 'chord')) {
    note.remove();
    return;
  }
  // If this note heads a chord, its followers go too.
  const group = chordGroup(note);
  group.slice(1).forEach((n) => n.remove());
  kid(note, 'pitch')?.remove();
  kid(note, 'accidental')?.remove();
  kid(note, 'stem')?.remove();
  kids(note, 'tie').forEach((t) => t.remove());
  for (const t of Array.from(note.getElementsByTagName('tied'))) t.remove();
  insertInOrder(note, make(doc, 'rest'), NOTE_ORDER);
  stripBeams(measureOf(note));
}

/** Remove a note. If it heads a chord, the next chord note takes its place. */
export function deleteNote(doc: Document, xmlIndex: number) {
  const note = getNote(doc, xmlIndex);
  const all = noteElements(doc);
  const next = all[all.indexOf(note) + 1];
  if (!kid(note, 'chord') && next && kid(next, 'chord')) kid(next, 'chord')!.remove();
  const measure = measureOf(note);
  note.remove();
  stripBeams(measure);
}

/** Insert a note or rest straight after the selected one (after its whole chord). Returns the new note's index. */
export function insertAfter(doc: Document, xmlIndex: number, kind: 'note' | 'rest'): number {
  normaliseDivisions(doc);
  const note = getNote(doc, xmlIndex);
  const group = chordGroup(note);
  const last = group[group.length - 1];
  const head = group[0];
  const el = make(doc, 'note');
  if (kind === 'rest') el.appendChild(make(doc, 'rest'));
  el.appendChild(make(doc, 'duration', kid(head, 'duration')?.textContent ?? String(EDIT_DIVISIONS)));
  const voice = kid(head, 'voice')?.textContent;
  if (voice) el.appendChild(make(doc, 'voice', voice));
  el.appendChild(make(doc, 'type', kid(head, 'type')?.textContent ?? 'quarter'));
  kids(head, 'dot').forEach(() => el.appendChild(make(doc, 'dot')));
  const staff = kid(head, 'staff')?.textContent;
  if (staff) el.appendChild(make(doc, 'staff', staff));
  last.after(el);
  if (kind === 'note') setPitch(el, noteMidi(group[group.length - 1]) ?? 71, fifthsAt(el));
  stripBeams(measureOf(el));
  return noteElements(doc).indexOf(el);
}

function firstAttributes(doc: Document, part: Element): Element | null {
  const first = kid(part, 'measure');
  if (!first) return null;
  let attrs = kid(first, 'attributes');
  if (!attrs) {
    attrs = make(doc, 'attributes');
    first.insertBefore(attrs, first.firstElementChild);
  }
  return attrs;
}

const ATTR_ORDER = ['footnote', 'level', 'divisions', 'key', 'time', 'staves', 'part-symbol', 'instruments', 'clef', 'staff-details', 'transpose', 'directive', 'measure-style'];

/** Change the key signature (from the start of the piece). */
export function setKey(doc: Document, fifths: number) {
  for (const part of Array.from(doc.getElementsByTagName('part'))) {
    const attrs = firstAttributes(doc, part);
    if (!attrs) continue;
    let key = kid(attrs, 'key');
    if (!key) {
      key = make(doc, 'key');
      insertInOrder(attrs, key, ATTR_ORDER);
    }
    let f = kid(key, 'fifths');
    if (!f) {
      f = make(doc, 'fifths');
      key.insertBefore(f, key.firstElementChild);
    }
    f.textContent = String(Math.max(-7, Math.min(7, Math.round(fifths))));
  }
}

/** Change the time signature (from the start of the piece). */
export function setTime(doc: Document, beats: number, beatType: number) {
  for (const part of Array.from(doc.getElementsByTagName('part'))) {
    const attrs = firstAttributes(doc, part);
    if (!attrs) continue;
    let time = kid(attrs, 'time');
    if (!time) {
      time = make(doc, 'time');
      insertInOrder(attrs, time, ATTR_ORDER);
    }
    time.removeAttribute('symbol');
    time.replaceChildren(make(doc, 'beats', String(beats)), make(doc, 'beat-type', String(beatType)));
  }
}

export function setTitle(doc: Document, title: string) {
  const root = doc.documentElement;
  let work = kid(root, 'work');
  if (!work) {
    work = make(doc, 'work');
    root.insertBefore(work, root.firstElementChild);
  }
  let wt = kid(work, 'work-title');
  if (!wt) {
    wt = make(doc, 'work-title');
    work.appendChild(wt);
  }
  wt.textContent = title;
  kid(root, 'movement-title')?.remove();
}

export function serialise(doc: Document): string {
  return new XMLSerializer().serializeToString(doc);
}

/** Written type and dots of a note (for the duration picker). */
export function noteTypeOf(doc: Document, xmlIndex: number): { type: string; dots: number } {
  const n = getNote(doc, xmlIndex);
  return { type: kid(n, 'type')?.textContent?.trim() ?? 'quarter', dots: kids(n, 'dot').length };
}

/**
 * Put a line's bars into the music at measure index `at` (the review screen's
 * "Read this line again"). `lineXml` is that line as its own MusicXML; its first
 * bar's key, time and clef are dropped unless `keep` says the line really
 * changes them. Bars are renumbered afterwards. Returns how many bars went in.
 */
export function insertMeasures(doc: Document, at: number, lineXml: string, keep: { key?: boolean; time?: boolean; clef?: boolean } = {}): number {
  const line = new DOMParser().parseFromString(lineXml, 'application/xml');
  normaliseDivisions(doc);
  normaliseDivisions(line);
  const part = doc.getElementsByTagName('part')[0];
  const from = line.getElementsByTagName('part')[0];
  if (!part || !from) return 0;
  const incoming = kids(from, 'measure');
  const first = incoming[0];
  const attrs = first && kid(first, 'attributes');
  // At the very start the new bars must set everything up (divisions, key, time, clef).
  if (attrs && at > 0) {
    kid(attrs, 'divisions')?.remove();
    kid(attrs, 'staves')?.remove();
    if (!keep.key) kid(attrs, 'key')?.remove();
    if (!keep.time) kid(attrs, 'time')?.remove();
    if (!keep.clef) kids(attrs, 'clef').forEach((c) => c.remove());
    if (attrs.children.length === 0) attrs.remove();
  }
  const existing = kids(part, 'measure');
  const before = existing[at] ?? null;
  for (const m of incoming) {
    const node = doc.importNode(m, true) as Element;
    // Only the piece's first bar can be a pickup.
    if (at > 0 || m !== first) node.removeAttribute('implicit');
    part.insertBefore(node, before);
  }
  renumberMeasures(doc);
  return incoming.length;
}

/** Number bars 1, 2, 3… in order (a pickup stays bar 0). */
export function renumberMeasures(doc: Document) {
  for (const part of Array.from(doc.getElementsByTagName('part'))) {
    let n = 1;
    kids(part, 'measure').forEach((m, i) => {
      if (i === 0 && m.getAttribute('implicit') === 'yes') m.setAttribute('number', '0');
      else {
        m.removeAttribute('implicit');
        m.setAttribute('number', String(n++));
      }
    });
  }
}
