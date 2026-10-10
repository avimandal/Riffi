import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkScore, extractJson, mergePages, NotationError, notationToMusicXml, parseStaff, type RnScore } from '../../src/sheet/notation';
import { parseMusicXml } from '../../src/sheet/musicxml';
import { buildExpectedNotes, expandRepeats } from '../../src/sheet/expected';

const hornpipe = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/sheets/hermans-hornpipe.rn.json'), 'utf8')) as RnScore;

describe('Riffi Notation tokens', () => {
  it('reads notes, dots, ties, chords and rests', () => {
    const ev = parseStaff('C#5q. Bb4e~ Bb4s D4+A4h rq R');
    expect(ev.map((e) => e.kind)).toEqual(['note', 'note', 'note', 'note', 'rest', 'barRest']);
    expect(ev[0]).toMatchObject({ pitches: [{ step: 'C', alter: 1, octave: 5 }], quarters: 1.5 });
    expect(ev[1]).toMatchObject({ tie: true, quarters: 0.5, pitches: [{ step: 'B', alter: -1 }] });
    expect(ev[3].pitches.map((p) => p.step)).toEqual(['D', 'A']);
    expect(ev[3].quarters).toBe(2);
    expect(parseStaff('D4h+F#4h')[0].pitches).toHaveLength(2);
  });

  it('reads tuplets, with or without spaces', () => {
    const a = parseStaff('3( D5s E5s D5s ) C#5s');
    const b = parseStaff('3(D5s E5s D5s) C#5s');
    expect(a.map((e) => +e.quarters.toFixed(4))).toEqual([0.1667, 0.1667, 0.1667, 0.25]);
    expect(b.map((e) => e.quarters)).toEqual(a.map((e) => e.quarters));
    expect(a[0].tuplet).toEqual({ actual: 3, normal: 2 });
  });

  it('explains what it cannot read', () => {
    expect(() => parseStaff('C#5')).toThrow(NotationError);
    expect(() => parseStaff('H4q')).toThrow(/isn't a note/);
    expect(checkScore({ measures: [{ s1: 'Q9' }] })[0]).toMatch(/Measure 1/);
    expect(checkScore({ measures: [] })).toEqual(['There are no measures.']);
    expect(checkScore({ measures: [{ s1: 'rq rq rq rq' }] })).toEqual(['There are no notes.']);
  });

  it('finds the JSON in a chatty or fenced reply', () => {
    expect(extractJson('Here you go:\n```json\n{"measures":[]}\n```')).toEqual({ measures: [] });
  });
});

describe('the dense violin fixture (Herman\'s hornpipe photo)', () => {
  it('passes the checks', () => {
    expect(checkScore(hornpipe)).toEqual([]);
  });

  it('becomes MusicXML that adds up bar by bar', () => {
    const { musicxml, warnings } = notationToMusicXml(hornpipe, 'Violin');
    // Only the reader's own warnings: every bar adds up to 4 beats.
    expect(warnings).toEqual(hornpipe.warnings);
    const s = parseMusicXml(musicxml);
    expect(s.title).toBe("Herman's hornpipe");
    expect(s.tempoQ).toBe(70);
    expect(s.measures).toHaveLength(22);
    expect(s.measures[0]).toMatchObject({ implicit: true, lengthQ: 0.5, fifths: 2 });
    for (const m of s.measures.slice(1)) expect(m.lengthQ).toBeCloseTo(4, 6);
    // The repeat (bars 1–16) is played twice.
    const order = expandRepeats(s.measures);
    expect(order).toHaveLength(1 + 16 * 2 + 5);
    // Triplets land on whole numbers of MusicXML divisions.
    const notes = buildExpectedNotes(s, { instrument: 'violin', bpm: 70 }).notes;
    expect(notes.length).toBeGreaterThan(500);
    expect(notes[0].pitches).toEqual([81]); // the A5 pickup
    expect(notes[1].pitches).toEqual([78]); // F♯5
  });

  it('flags a bar that does not add up (so the review screen can say so)', () => {
    const broken: RnScore = { ...hornpipe, warnings: [], measures: hornpipe.measures.map((m) => (m.n === 3 ? { ...m, s1: m.s1!.split(' ').slice(0, -2).join(' ') } : m)) };
    expect(notationToMusicXml(broken).warnings).toEqual(['Bar 3 adds up to 3.5 beats instead of 4 beats.']);
  });

  it('joins pages read one at a time', () => {
    const page1: RnScore = { ...hornpipe, measures: hornpipe.measures.slice(0, 11) };
    const page2: RnScore = { measures: hornpipe.measures.slice(11).map((m) => ({ ...m, n: Number(m.n) - 10 })), warnings: ['Page 2 note'] };
    const merged = mergePages([page1, page2]);
    expect(merged.title).toBe("Herman's hornpipe");
    expect(merged.measures.map((m) => m.n)).toEqual(Array.from({ length: 22 }, (_, i) => i));
    expect(merged.warnings).toContain('Page 2 note');
    expect(parseMusicXml(notationToMusicXml(merged).musicxml).measures).toHaveLength(22);
  });

  it('builds two-staff piano music', () => {
    const piano: RnScore = { staves: 2, measures: [{ n: 1, key: 0, time: '3/4', s1: 'E5q D5q C5q', s2: 'C3h. ' }] };
    const s = parseMusicXml(notationToMusicXml(piano).musicxml);
    expect(s.parts[0].staves).toBe(2);
    const exp = buildExpectedNotes(s, { instrument: 'piano', bpm: 60 }).notes;
    expect(exp[0].pitches).toEqual([48, 76]);
  });
});
