import { describe, expect, it } from 'vitest';
import { deleteNote, EDIT_DIVISIONS, insertAfter, serialise, setDuration, setKey, setTime, setTitle, toggleRest, transpose } from '../../src/sheet/editor';
import { parseMusicXml, parseXmlDocument } from '../../src/sheet/musicxml';
import { fixtureXml } from '../fixtures/load';
import { readFileSync } from 'node:fs';
import { insertLine } from '../../src/sheet/lineInsert';
import { notationToMusicXml, type RnScore } from '../../src/sheet/notation';

function edit(name: string, op: (d: Document) => void) {
  const doc = parseXmlDocument(fixtureXml(name));
  op(doc);
  return parseMusicXml(serialise(doc));
}

describe('sheet editor', () => {
  it('moves a note up and down, spelt for the key', () => {
    const s = edit('twinkle.musicxml', (d) => transpose(d, 0, 4)); // D4 → F♯4 in D major
    expect(s.notes[0]).toMatchObject({ midi: 66, step: 'F', alter: 1 });
    const flat = edit('ties.musicxml', (d) => transpose(d, 4, 1)); // A4 → B♭ in F major
    expect(flat.notes[4]).toMatchObject({ midi: 70, step: 'B', alter: -1 });
  });

  it('changes a note length (and rescales divisions)', () => {
    const s = edit('twinkle.musicxml', (d) => setDuration(d, 0, 'eighth', 1));
    expect(s.notes[0].durationQ).toBe(0.75);
    expect(s.notes[1].startQ).toBe(0.75);
    const doc = parseXmlDocument(fixtureXml('twinkle.musicxml'));
    setDuration(doc, 0, 'half');
    expect(doc.getElementsByTagName('divisions')[0].textContent).toBe(String(EDIT_DIVISIONS));
  });

  it('changes a whole chord together', () => {
    const s = edit('piano-two-staves.musicxml', (d) => {
      const idx = parseMusicXml(serialise(d)).notes.findIndex((n) => n.measureIndex === 2 && n.midi === 72);
      setDuration(d, idx, 'half');
    });
    const chord = s.notes.filter((n) => n.measureIndex === 2 && n.staff === 1 && n.startQ === 0);
    expect(chord.map((n) => n.durationQ)).toEqual([2, 2]);
  });

  it('turns notes into rests and back', () => {
    let s = edit('twinkle.musicxml', (d) => toggleRest(d, 2));
    expect(s.notes[2].isRest).toBe(true);
    s = edit('twinkle.musicxml', (d) => {
      toggleRest(d, 2);
      toggleRest(d, 2, 69);
    });
    expect(s.notes[2]).toMatchObject({ isRest: false, midi: 69 });
  });

  it('deletes and inserts notes', () => {
    const del = edit('twinkle.musicxml', (d) => deleteNote(d, 0));
    expect(del.notes).toHaveLength(27);
    let inserted = -1;
    const ins = edit('twinkle.musicxml', (d) => (inserted = insertAfter(d, 1, 'note')));
    expect(inserted).toBe(2);
    expect(ins.notes[2]).toMatchObject({ midi: 62, startQ: 2 });
    const rest = edit('twinkle.musicxml', (d) => insertAfter(d, 0, 'rest'));
    expect(rest.notes[1].isRest).toBe(true);
  });

  it('deleting the first note of a chord keeps the rest of the chord', () => {
    const before = parseMusicXml(fixtureXml('piano-two-staves.musicxml'));
    const head = before.notes.findIndex((n) => n.measureIndex === 2 && n.midi === 72);
    const s = edit('piano-two-staves.musicxml', (d) => deleteNote(d, head));
    const e4 = s.notes.find((n) => n.measureIndex === 2 && n.midi === 64);
    expect(e4).toMatchObject({ isChord: false, startQ: 0 });
  });

  it('changes key, time and title', () => {
    const s = edit('twinkle.musicxml', (d) => {
      setKey(d, -3);
      setTime(d, 3, 4);
      setTitle(d, 'My Twinkle');
    });
    expect(s.measures[0]).toMatchObject({ fifths: -3, beats: 3, beatType: 4 });
    expect(s.title).toBe('My Twinkle');
  });
});

describe('putting a line read again back in', () => {
  const ref = JSON.parse(readFileSync(new URL('../fixtures/sheets/hermans-hornpipe.reference.json', import.meta.url), 'utf8')) as RnScore & { lines: [number, number][] };
  const notes = (xml: string) => parseMusicXml(xml).notes.map((n) => `${n.measureIndex}:${n.midi ?? 'r'}:${n.startQ}:${n.durationQ}`);
  const full = notationToMusicXml(ref, 'Violin').musicxml;
  const ctx = { key: 2, time: '4/4', clef: 'treble' };

  it.each([
    ['a middle line', 2],
    ['the first line (with its pickup)', 0],
    ['the last line', 6],
  ])('%s lands exactly where it belongs', (_, i) => {
    const [a, b] = ref.lines[i];
    const inLine = (m: { n?: number | string }) => Number(m.n) >= a && Number(m.n) <= b;
    const without = notationToMusicXml({ ...ref, measures: ref.measures.filter((m) => !inLine(m)).map((m, k) => (k === 0 ? { ...m, key: 2, time: '4/4', clef: 'treble' } : m)) }, 'Violin').musicxml;
    const at = ref.measures.findIndex(inLine);
    const line = ref.measures.filter(inLine).map(({ key: _k, time: _t, clef: _c, ...m }) => m);
    const { xml, count } = insertLine(without, at, line, ctx, 'violin');
    expect(count).toBe(line.length);
    expect(notes(xml)).toEqual(notes(full));
    const parsed = parseMusicXml(xml);
    expect(parsed.measures.map((m) => m.number)).toEqual(parseMusicXml(full).measures.map((m) => m.number));
    expect(parsed.measures[0].fifths).toBe(2);
  });
});
