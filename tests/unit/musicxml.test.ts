import { describe, expect, it } from 'vitest';
import { buildExpectedNotes, buildTimeline, defaultBpm, expandRepeats, playOrder } from '../../src/sheet/expected';
import { countPitchedNotes, keyName, keySignatureAlters, MusicXmlError, noteName, parseMusicXml, pitchToMidi, spellMidi } from '../../src/sheet/musicxml';
import { fixture } from '../fixtures/load';

describe('MusicXML parsing', () => {
  it('reads title, key, time, tempo and notes', () => {
    const s = fixture('twinkle.musicxml');
    expect(s.title).toBe('Twinkle Twinkle');
    expect(s.measures).toHaveLength(8);
    expect(s.measures[0]).toMatchObject({ fifths: 2, beats: 4, beatType: 4, lengthQ: 4 });
    expect(s.tempoQ).toBe(90);
    expect(countPitchedNotes(s)).toBe(28);
    expect(s.notes[0]).toMatchObject({ midi: 62, startQ: 0, durationQ: 1, measureIndex: 0, xmlIndex: 0 });
    // F# from <alter>
    expect(s.notes.find((n) => n.step === 'F')?.midi).toBe(66);
  });

  it('expands repeats, volta endings and repeat counts', () => {
    const s = fixture('repeats.musicxml');
    expect(s.measures[0].forwardRepeat).toBe(true);
    expect(s.measures[2]).toMatchObject({ backwardRepeat: true, endingNumbers: [1] });
    expect(s.measures[3].endingNumbers).toEqual([2]);
    expect(s.measures[4]).toMatchObject({ forwardRepeat: true, backwardRepeat: true, repeatTimes: 3 });
    expect(expandRepeats(s.measures)).toEqual([0, 1, 2, 0, 1, 3, 4, 4, 4, 5]);
  });

  it('merges tied notes into one expected note and handles dots', () => {
    const s = fixture('ties.musicxml');
    expect(s.measures[0].fifths).toBe(-1);
    const { notes } = buildExpectedNotes(s, { instrument: 'violin', bpm: 60 });
    // F (tied over 3 notes = 4 beats), dotted B♭, A, dotted G
    expect(notes.map((n) => n.pitches[0])).toEqual([65, 70, 69, 67]);
    expect(notes[0].durationQ).toBe(4);
    expect(notes[0].refs).toHaveLength(3);
    expect(notes[1]).toMatchObject({ onsetQ: 4, durationQ: 1.5 });
    expect(notes[3]).toMatchObject({ onsetQ: 6, durationQ: 3 });
    expect(notes[0].durationMs).toBe(4000);
  });

  it('merges both piano staves into chords by onset', () => {
    const s = fixture('piano-two-staves.musicxml');
    expect(s.parts[0].staves).toBe(2);
    expect(s.measures[0].lengthQ).toBe(4);
    const { notes } = buildExpectedNotes(s, { instrument: 'piano', bpm: 72 });
    expect(notes[0].pitches).toEqual([48, 55, 76]); // C3 + G3 (left) + E5 (right)
    expect(notes[1].pitches).toEqual([74]);
    const bar3 = notes.filter((n) => n.measureIndex === 2);
    expect(bar3[0].pitches).toEqual([53, 57, 64, 72]); // F3 A3 (left) + E4 C5 (right chord)
    // Violin reads only the top staff.
    const mono = buildExpectedNotes(s, { instrument: 'violin', bpm: 72 }).notes;
    expect(mono[0].pitches).toEqual([76]);
    expect(mono.every((n) => n.pitches.every((p) => p >= 60))).toBe(true);
  });

  it('follows key and time signature changes', () => {
    const s = fixture('key-change.musicxml');
    expect(s.measures.map((m) => m.fifths)).toEqual([0, 1, -2, -2]);
    expect(s.measures.map((m) => `${m.beats}/${m.beatType}`)).toEqual(['4/4', '4/4', '3/4', '6/8']);
    expect(s.measures.map((m) => m.lengthQ)).toEqual([4, 4, 3, 3]);
    const { notes } = buildExpectedNotes(s, { instrument: 'violin', bpm: 120 });
    expect(notes.find((n) => n.measureIndex === 2)?.fifths).toBe(-2);
    expect(notes[notes.length - 1]).toMatchObject({ onsetQ: 11, durationQ: 3, pitches: [70] });
  });

  it('handles a pickup bar', () => {
    const s = fixture('pickup.musicxml');
    expect(s.measures[0]).toMatchObject({ implicit: true, lengthQ: 1, number: '0' });
    const tl = buildTimeline(s, 60);
    expect(tl.startsQ).toEqual([0, 1, 4]);
  });

  it('picks a loop range out of the played order', () => {
    const s = fixture('repeats.musicxml');
    expect(playOrder(s, { fromIndex: 3, toIndex: 4 })).toEqual([3, 4]);
    expect(playOrder(s, { fromIndex: 0, toIndex: 1 })).toEqual([0, 1]);
    const { notes, timeline } = buildExpectedNotes(s, { instrument: 'violin', bpm: 60, loop: { fromIndex: 1, toIndex: 2 } });
    expect(timeline.order).toEqual([1, 2]);
    expect(notes[0]).toMatchObject({ onsetQ: 0, pitches: [76] });
  });

  it('defaults the tempo from the marking, or 80', () => {
    expect(defaultBpm(fixture('twinkle.musicxml'))).toBe(90);
    expect(defaultBpm(fixture('repeats.musicxml'))).toBe(80);
  });

  it('rejects things that are not MusicXML', () => {
    expect(() => parseMusicXml('<html><body/></html>')).toThrow(MusicXmlError);
    expect(() => parseMusicXml('not xml at all <')).toThrow(MusicXmlError);
  });
});

describe('pitch helpers', () => {
  it('converts pitches to MIDI', () => {
    expect(pitchToMidi('C', 0, 4)).toBe(60);
    expect(pitchToMidi('A', 0, 4)).toBe(69);
    expect(pitchToMidi('B', -1, 3)).toBe(58);
  });
  it('names and spells notes to suit the key', () => {
    expect(noteName(66, 2)).toBe('F♯');
    expect(noteName(70, -1)).toBe('B♭');
    expect(noteName(60, 0, true)).toBe('C4');
    expect(spellMidi(70, -2)).toEqual({ step: 'B', alter: -1, octave: 4 });
    expect(spellMidi(66, 1)).toEqual({ step: 'F', alter: 1, octave: 4 });
    expect(keySignatureAlters(2)).toEqual({ F: 1, C: 1 });
    expect(keySignatureAlters(-2)).toEqual({ B: -1, E: -1 });
    expect(keyName(1)).toBe('G major');
    expect(keyName(0, 'minor')).toBe('A minor');
  });
});
