import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { addTone, blank, toWav, VIOLINISH } from '../fixtures/audio';

/** Make the fake microphone's audio: a violin-like Twinkle at 90 BPM after a short pause. */
export default function globalSetup() {
  const dir = fileURLToPath(new URL('./.generated/', import.meta.url));
  mkdirSync(dir, { recursive: true });
  const melody = [62, 62, 69, 69, 71, 71, 69, 67, 67, 66, 66, 64, 64, 62];
  const lens = [1, 1, 1, 1, 1, 1, 2, 1, 1, 1, 1, 1, 1, 2];
  const beat = 60000 / 90;
  const lead = 3000;
  const buf = blank(lead + 16 * beat + 2000);
  let t = lead;
  melody.forEach((m, i) => {
    addTone(buf, { midi: m, startMs: t, durationMs: lens[i] * beat * 0.9, harmonics: VIOLINISH, vibratoCents: 30, amp: 0.25 });
    t += lens[i] * beat;
  });
  writeFileSync(`${dir}twinkle.wav`, toWav(buf));
}
