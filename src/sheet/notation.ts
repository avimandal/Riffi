/**
 * Riffi Notation (RN): the compact note format the sheet reader returns.
 *
 * Asking the AI for full MusicXML made dense pages take minutes (MusicXML is
 * ~200 characters per note). RN is ~5 characters per note, so a page reads in
 * seconds, and the app turns it into MusicXML itself.
 *
 * {
 *   "title": "Herman's hornpipe", "composer": "Mark O'Connor",
 *   "tempo": { "bpm": 70, "beat": "q", "text": "Brightly" },
 *   "staves": 1,                         // 2 for piano (treble + bass)
 *   "measures": [
 *     { "n": 0, "pickup": true, "key": 2, "time": "4/4", "s1": "A5e" },
 *     { "n": 1, "repeat": "start", "s1": "F#5s D5s A4s D5s E5s C#5s A4s C#5s D5q rq" },
 *     ...
 *   ],
 *   "warnings": ["Bar 7: the accidental on the third note was hard to read."]
 * }
 *
 * Measure fields: n (printed number), pickup, key (fifths, -7..7, when it
 * changes), time ("3/4", when it changes), clef / clef2 ("treble", "bass",
 * "alto", "tenor", when they change), repeat ("start" | "end" | "both"),
 * ending ("1", "2", "1,2") with ending_stop (true when the bracket closes
 * here), s1 (staff 1) and s2 (staff 2, piano only).
 *
 * Tokens (space-separated):
 *   note   C#5q.   letter, accidental (# ## b bb n), octave (C4 = middle C),
 *                 duration (w h q e s t = whole … 32nd), dots, optional ~ tie
 *   chord  D4+A4h  members joined by +, sharing the last member's duration
 *   rest   rq      r + duration; R = whole-bar rest
 *   tuplet 3( C#6s D6s E6s )   n notes in the time of the usual count (3 in 2)
 * Pitches are the SOUNDING pitch: the key signature is already applied.
 */

export interface RnMeasure {
  n?: number | string;
  pickup?: boolean;
  key?: number;
  time?: string;
  clef?: string;
  clef2?: string;
  repeat?: 'start' | 'end' | 'both';
  ending?: string;
  ending_stop?: boolean;
  s1?: string;
  s2?: string;
}

export interface RnScore {
  title?: string;
  composer?: string;
  tempo?: { bpm?: number; beat?: string; text?: string } | null;
  staves?: number;
  measures: RnMeasure[];
  warnings?: string[];
}

export class NotationError extends Error {}

const DURATION_Q: Record<string, number> = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25, t: 0.125 };
const TYPE_NAME: Record<string, string> = { w: 'whole', h: 'half', q: 'quarter', e: 'eighth', s: '16th', t: '32nd' };
const ALTER: Record<string, number> = { '': 0, n: 0, '#': 1, '##': 2, b: -1, bb: -2 };
const TUPLET_NORMAL: Record<number, number> = { 2: 3, 3: 2, 4: 3, 5: 4, 6: 4, 7: 4, 9: 8 };
const DIVISIONS = 48;

const NOTE_RE = /^([A-G])(##|#|bb|b|n)?(\d)$/;
const DUR_RE = /^([whqest])(\.{0,2})$/;

export interface RnPitch {
  step: string;
  alter: number;
  octave: number;
}

export interface RnEvent {
  kind: 'note' | 'rest' | 'barRest';
  pitches: RnPitch[];
  /** Duration letter and dots (not set for whole-bar rests). */
  dur?: string;
  dots: number;
  tie: boolean;
  /** Tuplet (actual:normal), if inside one. */
  tuplet?: { actual: number; normal: number };
  /** Length in quarter notes (whole-bar rests: filled in later). */
  quarters: number;
}

/** Split a staff string into events. Throws NotationError with the offending token. */
export function parseStaff(src: string): RnEvent[] {
  const text = src.replace(/(\d)\(/g, ' $1( ').replace(/(?<!\d)\(/g, ' ( ').replace(/\)/g, ' ) ');
  const tokens = text.split(/\s+/).filter(Boolean);
  const out: RnEvent[] = [];
  let tuplet: RnEvent['tuplet'];
  for (const tok of tokens) {
    const open = tok.match(/^(\d)\($/);
    if (open) {
      const actual = Number(open[1]);
      tuplet = { actual, normal: TUPLET_NORMAL[actual] ?? 2 };
      continue;
    }
    if (tok === '(') continue;
    if (tok === ')') {
      tuplet = undefined;
      continue;
    }
    if (tok === 'R') {
      out.push({ kind: 'barRest', pitches: [], dots: 0, tie: false, quarters: 0 });
      continue;
    }
    const tie = tok.endsWith('~');
    const body = tie ? tok.slice(0, -1) : tok;
    const rest = body.match(/^r([whqest])(\.{0,2})$/);
    if (rest) {
      out.push(event('rest', [], rest[1], rest[2].length, false, tuplet));
      continue;
    }
    const members = body.split('+');
    const last = members[members.length - 1];
    const dm = last.match(/^(.*?)([whqest])(\.{0,2})$/);
    if (!dm) throw new NotationError(`"${tok}" has no length (w h q e s t)`);
    members[members.length - 1] = dm[1];
    const pitches = members.map((m) => {
      // Other chord members may repeat the length ("D4h+A4h"); it's the same.
      const clean = NOTE_RE.test(m) ? m : m.replace(/[whqest]\.{0,2}$/, '');
      const pm = clean.match(NOTE_RE);
      if (!pm) throw new NotationError(`"${tok}" isn't a note like C#5q`);
      return { step: pm[1], alter: ALTER[pm[2] ?? ''], octave: Number(pm[3]) };
    });
    out.push(event('note', pitches, dm[2], dm[3].length, tie, tuplet));
  }
  return out;
}

function event(kind: 'note' | 'rest', pitches: RnPitch[], dur: string, dots: number, tie: boolean, tuplet?: RnEvent['tuplet']): RnEvent {
  if (!DUR_RE.test(dur + '.'.repeat(dots))) throw new NotationError(`Unknown length "${dur}"`);
  let q = DURATION_Q[dur] * (dots === 1 ? 1.5 : dots === 2 ? 1.75 : 1);
  if (tuplet) q = (q * tuplet.normal) / tuplet.actual;
  return { kind, pitches, dur, dots, tie, tuplet, quarters: q };
}

/** Check an RN score is usable. Returns a list of problems (empty = fine). */
export function checkScore(score: unknown): string[] {
  const problems: string[] = [];
  if (!score || typeof score !== 'object') return ['The reply was not a JSON object.'];
  const s = score as RnScore;
  if (!Array.isArray(s.measures) || s.measures.length === 0) return ['There are no measures.'];
  let pitched = 0;
  s.measures.forEach((m, i) => {
    for (const key of ['s1', 's2'] as const) {
      if (m[key] === undefined) continue;
      if (typeof m[key] !== 'string') {
        problems.push(`Measure ${m.n ?? i + 1}: ${key} must be a string.`);
        continue;
      }
      try {
        pitched += parseStaff(m[key]!).filter((e) => e.kind === 'note').length;
      } catch (e) {
        problems.push(`Measure ${m.n ?? i + 1}, ${key}: ${(e as Error).message}.`);
      }
    }
  });
  if (pitched === 0 && problems.length === 0) problems.push('There are no notes.');
  return problems.slice(0, 5);
}

/** Join pages read separately into one score: carries key/time on, numbers bars in order. */
export function mergePages(pages: RnScore[]): RnScore {
  const first = pages.find((p) => p.title) ?? pages[0];
  const measures: RnMeasure[] = [];
  let last = -1;
  for (const page of pages) {
    for (const m of page.measures ?? []) {
      const n = Number(m.n);
      const num = Number.isFinite(n) && n > last ? n : last + 1;
      measures.push({ ...m, n: num });
      last = num;
    }
  }
  return {
    title: first?.title,
    composer: first?.composer,
    tempo: pages.find((p) => p.tempo)?.tempo ?? null,
    staves: Math.max(1, ...pages.map((p) => p.staves ?? 1)),
    measures,
    warnings: pages.flatMap((p) => p.warnings ?? []),
  };
}

const CLEFS: Record<string, [string, number]> = {
  treble: ['G', 2],
  bass: ['F', 4],
  alto: ['C', 3],
  tenor: ['C', 4],
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function barLengthQ(time: string): number {
  const [b, t] = time.split('/').map(Number);
  return b > 0 && t > 0 ? (b * 4) / t : 4;
}

export interface ConvertResult {
  musicxml: string;
  /** Things worth a look on the review screen (e.g. a bar that doesn't add up). */
  warnings: string[];
}

/** Build MusicXML 3.1 partwise from RN. Throws NotationError if a staff can't be read. */
export function notationToMusicXml(score: RnScore, partName = 'Music'): ConvertResult {
  const staves = score.staves === 2 ? 2 : 1;
  const warnings: string[] = [...(score.warnings ?? [])];
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<score-partwise version="3.1">');
  if (score.title) out.push(`<work><work-title>${esc(score.title)}</work-title></work>`);
  if (score.composer) out.push(`<identification><creator type="composer">${esc(score.composer)}</creator></identification>`);
  out.push(`<part-list><score-part id="P1"><part-name>${esc(partName)}</part-name></score-part></part-list>`);
  out.push('<part id="P1">');

  let time = '4/4';
  let key = 0;
  const pendingTies: Map<string, boolean>[] = [new Map(), new Map()];

  score.measures.forEach((m, i) => {
    const attrs: string[] = [];
    const first = i === 0;
    if (first) attrs.push(`<divisions>${DIVISIONS}</divisions>`);
    if (first || (m.key !== undefined && m.key !== key)) {
      key = Math.max(-7, Math.min(7, Math.round(Number(m.key ?? 0))));
      attrs.push(`<key><fifths>${key}</fifths></key>`);
    }
    if (first || (m.time && m.time !== time)) {
      if (m.time && /^\d+\/\d+$/.test(m.time)) time = m.time;
      const [b, t] = time.split('/');
      attrs.push(`<time><beats>${b}</beats><beat-type>${t}</beat-type></time>`);
    }
    if (first && staves === 2) attrs.push('<staves>2</staves>');
    const clefs: string[] = [];
    if (first || m.clef) clefs.push(clefXml(m.clef ?? 'treble', staves === 2 ? 1 : 0));
    if (staves === 2 && (first || m.clef2)) clefs.push(clefXml(m.clef2 ?? 'bass', 2));
    attrs.push(...clefs);

    const body: string[] = [];
    if (m.repeat === 'start' || m.repeat === 'both' || m.ending) {
      body.push('<barline location="left">');
      if (m.repeat === 'start' || m.repeat === 'both') body.push('<repeat direction="forward"/>');
      if (m.ending) body.push(`<ending number="${esc(m.ending)}" type="start"/>`);
      body.push('</barline>');
    }
    if (attrs.length) body.push(`<attributes>${attrs.join('')}</attributes>`);
    if (first && score.tempo?.bpm) {
      const unit = { h: 'half', q: 'quarter', e: 'eighth' }[score.tempo.beat ?? 'q'] ?? 'quarter';
      const dotted = (score.tempo.beat ?? '').endsWith('.');
      const qpm = Math.round(score.tempo.bpm * ({ h: 2, q: 1, e: 0.5 }[(score.tempo.beat ?? 'q')[0]] ?? 1) * (dotted ? 1.5 : 1));
      body.push(
        `<direction placement="above"><direction-type>${score.tempo.text ? `<words>${esc(score.tempo.text)}</words></direction-type><direction-type>` : ''}<metronome><beat-unit>${unit}</beat-unit>${dotted ? '<beat-unit-dot/>' : ''}<per-minute>${score.tempo.bpm}</per-minute></metronome></direction-type><sound tempo="${qpm}"/></direction>`,
      );
    }

    const barQ = barLengthQ(time);
    const label = String(m.n ?? i + 1);
    const staffXml = (src: string | undefined, staff: number): { xml: string; q: number } => {
      if (!src || !src.trim()) {
        if (staff === 2 || !src) return { xml: restXml(barQ, staff, staves, true), q: barQ };
      }
      const events = parseStaff(src!);
      let q = 0;
      const xs: string[] = [];
      const ties = pendingTies[staff - 1];
      events.forEach((ev, k) => {
        if (ev.kind === 'barRest') {
          xs.push(restXml(barQ, staff, staves, true));
          q += barQ;
          return;
        }
        const startTuplet = ev.tuplet && (k === 0 || events[k - 1].tuplet !== ev.tuplet);
        const endTuplet = ev.tuplet && (k === events.length - 1 || events[k + 1].tuplet !== ev.tuplet);
        xs.push(noteXml(ev, staff, staves, ties, startTuplet, endTuplet));
        q += ev.quarters;
      });
      return { xml: xs.join(''), q };
    };

    const s1 = staffXml(m.s1, 1);
    body.push(s1.xml);
    if (staves === 2) {
      body.push(`<backup><duration>${Math.round(s1.q * DIVISIONS)}</duration></backup>`);
      body.push(staffXml(m.s2, 2).xml);
    }
    const isLast = i === score.measures.length - 1;
    if (!m.pickup && !isLast && Math.abs(s1.q - barQ) > 1e-6) {
      warnings.push(`Bar ${label} adds up to ${fmtBeats(s1.q, time)} instead of ${fmtBeats(barQ, time)}.`);
    }

    if (m.repeat === 'end' || m.repeat === 'both' || m.ending_stop) {
      body.push('<barline location="right">');
      if (m.repeat === 'end' || m.repeat === 'both') body.push('<bar-style>light-heavy</bar-style>');
      if (m.ending_stop) body.push(`<ending number="${esc(m.ending ?? '1')}" type="${m.repeat === 'end' || m.repeat === 'both' ? 'stop' : 'discontinue'}"/>`);
      if (m.repeat === 'end' || m.repeat === 'both') body.push('<repeat direction="backward"/>');
      body.push('</barline>');
    } else if (isLast) {
      body.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
    }

    out.push(`<measure number="${esc(label)}"${m.pickup ? ' implicit="yes"' : ''}>${body.join('')}</measure>`);
  });
  out.push('</part></score-partwise>');
  return { musicxml: out.join('\n'), warnings };
}

function fmtBeats(q: number, time: string): string {
  const beatQ = 4 / Number(time.split('/')[1] || 4);
  const beats = Math.round((q / beatQ) * 100) / 100;
  return `${beats} ${beats === 1 ? 'beat' : 'beats'}`;
}

function clefXml(name: string, number: number): string {
  const [sign, line] = CLEFS[name] ?? CLEFS.treble;
  return `<clef${number ? ` number="${number}"` : ''}><sign>${sign}</sign><line>${line}</line></clef>`;
}

function restXml(q: number, staff: number, staves: number, measureRest: boolean): string {
  return `<note><rest${measureRest ? ' measure="yes"' : ''}/><duration>${Math.round(q * DIVISIONS)}</duration><voice>${staff === 2 ? 5 : 1}</voice>${staves === 2 ? `<staff>${staff}</staff>` : ''}</note>`;
}

function noteXml(ev: RnEvent, staff: number, staves: number, ties: Map<string, boolean>, startTuplet?: boolean, endTuplet?: boolean): string {
  const dur = Math.round(ev.quarters * DIVISIONS);
  const voice = staff === 2 ? 5 : 1;
  const common =
    `<duration>${dur}</duration>` +
    '%TIE%' +
    `<voice>${voice}</voice><type>${TYPE_NAME[ev.dur!]}</type>${'<dot/>'.repeat(ev.dots)}` +
    (ev.tuplet ? `<time-modification><actual-notes>${ev.tuplet.actual}</actual-notes><normal-notes>${ev.tuplet.normal}</normal-notes></time-modification>` : '') +
    (staves === 2 ? `<staff>${staff}</staff>` : '');
  if (ev.kind === 'rest') {
    return `<note><rest/>${common.replace('%TIE%', '')}${tupletNotations(startTuplet, endTuplet)}</note>`;
  }
  return ev.pitches
    .map((p, k) => {
      const id = `${p.step}${p.alter}${p.octave}`;
      const stop = ties.get(id) ?? false;
      const start = ev.tie;
      if (stop) ties.delete(id);
      if (start) ties.set(id, true);
      const tieEls = `${stop ? '<tie type="stop"/>' : ''}${start ? '<tie type="start"/>' : ''}`;
      const notations: string[] = [];
      if (stop) notations.push('<tied type="stop"/>');
      if (start) notations.push('<tied type="start"/>');
      if (k === 0 && startTuplet) notations.push('<tuplet type="start"/>');
      if (k === 0 && endTuplet) notations.push('<tuplet type="stop"/>');
      return (
        `<note>${k > 0 ? '<chord/>' : ''}<pitch><step>${p.step}</step>${p.alter ? `<alter>${p.alter}</alter>` : ''}<octave>${p.octave}</octave></pitch>` +
        common.replace('%TIE%', tieEls) +
        (notations.length ? `<notations>${notations.join('')}</notations>` : '') +
        '</note>'
      );
    })
    .join('');
}

function tupletNotations(start?: boolean, end?: boolean): string {
  const n: string[] = [];
  if (start) n.push('<tuplet type="start"/>');
  if (end) n.push('<tuplet type="stop"/>');
  return n.length ? `<notations>${n.join('')}</notations>` : '';
}

/** Pull the JSON object out of a model reply (tolerates code fences and chatter). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new NotationError('No JSON object in the reply.');
  return JSON.parse(text.slice(start, end + 1));
}
