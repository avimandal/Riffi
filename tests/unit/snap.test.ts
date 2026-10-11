import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { headNames, inRange } from '../../src/sheet/noteHeads';
import type { RnMeasure } from '../../src/sheet/notation';
import { snapToHeads } from '../../src/sheet/snap';

const heads = (s: string) => [s.split(' ')];

describe('snapping pitches to the measured note heads', () => {
  it('moves notes between agreeing ones onto their heads, keeping rhythm, ties and tuplets', () => {
    // Bar 10 as read: beat 3 an octave low (C4 D4 E4 C4 where the photo has B4 C5 B4 A4).
    const read = [{ n: 10, s1: 'F#5s D5s A4s F#5s E5s C#5s A4s C#5s C#4t D4t E4t C#4t G#4s~ G#4s 3( C#5s D5s D#5s ) A4e' }];
    const measured = heads('F5 D5 A4 F5 E5 C5 A4 C5 B4 C5 B4 A4 G4 G4 C5 D5 D5 A4');
    const { measures, moved } = snapToHeads(read, measured, 2);
    expect(moved).toBe(4);
    // Key signature applied to the new letters (C# in D major); lengths, tie and triplet untouched.
    expect(measures[0].s1).toBe('F#5s D5s A4s F#5s E5s C#5s A4s C#5s B4t C#5t B4t A4t G#4s~ G#4s 3( C#5s D5s D#5s ) A4e');
  });

  it('ignores a couple of stray marks, picking the heads closest in pitch', () => {
    const read = [{ n: 1, s1: 'D5s A4s F4s A4s D5s A4s F#4s D4s' }];
    // A fingering "4" read as a head (A5) sits in the middle of the stretch.
    const measured = heads('D5 A4 G4 A5 B4 D5 A4 F4 D4');
    const { measures } = snapToHeads(read, measured, 2);
    expect(measures[0].s1).toBe('D5s A4s G4s B4s D5s A4s F#4s D4s');
  });

  it('carries an accidental written earlier in the bar', () => {
    const read = [{ n: 1, s1: 'Cn5q D5q E5q F#5e A4s B4s' }];
    // The 3rd note is really C5: after a written natural in the bar it stays natural.
    const { measures } = snapToHeads(read, heads('C5 D5 C5 F5 A4 B4'), 2);
    expect(measures[0].s1).toBe('Cn5q D5q Cn5q F#5e A4s B4s');
  });

  it('keeps the model accidental when only the octave changes', () => {
    const { measures } = snapToHeads([{ n: 1, s1: 'D5q Bb3e G3e F5q A5q' }], heads('D5 B4 G4 F5 A5'), -1);
    expect(measures[0].s1).toBe('D5q Bb4e G4e F5q A5q');
  });

  it('moves a lone note only a little, and leaves the ends of a line alone', () => {
    // A lone note a fifth away from its "head" (likely a stray mark) stays put.
    expect(snapToHeads([{ n: 1, s1: 'E5s F#5s D5s~ D5+F#5e A4q B4q' }], heads('E5 F5 G4 D5 A4 B4'), 2).moved).toBe(0);
    // Before the first or after the last agreeing note, nothing is moved.
    expect(snapToHeads([{ n: 1, s1: 'A4s C#5s E5s A5s' }], heads('A4 C5 E5 B5'), 2).moved).toBe(0);
  });

  it('never moves a note of a correct transcription on the real photo', () => {
    const rec = JSON.parse(readFileSync(new URL('../fixtures/sheets/recordings/hermans-hornpipe.gemini-3.5-flash.json', import.meta.url), 'utf8'));
    const ref = JSON.parse(readFileSync(new URL('../fixtures/sheets/hermans-hornpipe.reference.json', import.meta.url), 'utf8')) as {
      lines: [number, number][];
      measures: RnMeasure[];
    };
    ref.lines.forEach(([a, b], i) => {
      const bars = ref.measures.filter((m) => Number(m.n) >= a && Number(m.n) <= b);
      // The heads the browser measured on this photo, as the reader uses them for a violin.
      const measured = headNames([inRange(rec.heads[0][i][0], 'treble', 'G3', 'E7')], 'treble');
      expect(snapToHeads(bars, measured, 2).moved, `line ${i + 1}`).toBe(0);
    });
  });

  it('leaves alone stretches that do not match in count, chords, and lines that mostly disagree', () => {
    const read = [{ n: 1, s1: 'D5s E5s F#5s G5s A5s D4+A4e B5s C#6e' }];
    // One head missing between anchors D5 and A5: not filled. The chord isn't moved.
    expect(snapToHeads(read, heads('D5 E5 G5 A5 B4 B5 C6'), 2).moved).toBe(0);
    // Hardly anything agrees: the heads (or the read) can't be trusted on this line.
    expect(snapToHeads(read, heads('C4 C4 C4 C4 C4 C4 C4 C4'), 2).moved).toBe(0);
    // No heads (e.g. detection failed): unchanged, same object back.
    expect(snapToHeads(read, [[]], 2).measures).toBe(read);
  });
});
