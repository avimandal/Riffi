import { beforeAll, describe, expect, it } from 'vitest';
import { BasicPitchStream } from '../../src/engines/piano/stream';
import { toNoteEvents } from '../../src/engines/piano/postprocess';
import { PIANO_ENGINE } from '../../src/engines/piano/config';
import { StreamingResampler } from '../../src/audio/dsp';
import { groupIntoChords } from '../../src/follow/follower';
import { addClicks, addTone, blank, PIANOISH, SR } from '../fixtures/audio';
import { loadBasicPitchModel, tf } from '../fixtures/basicPitchNode';
import type * as TF from '@tensorflow/tfjs';

let model: TF.GraphModel;
beforeAll(async () => {
  tf.env().set('IS_TEST', true);
  model = await loadBasicPitchModel();
}, 60000);

const chords = [
  { at: 300, pitches: [60, 64, 67] }, // C major
  { at: 1300, pitches: [55, 59, 62] }, // G major
  { at: 2300, pitches: [53, 57, 60] }, // F major
];

function pianoAudio(withClicks: boolean) {
  const buf = blank(3600);
  for (const c of chords) {
    for (const p of c.pitches) addTone(buf, { midi: p, startMs: c.at, durationMs: 850, harmonics: PIANOISH, amp: 0.18, attackMs: 3, decay: 2.5 });
  }
  const clicks = [300, 800, 1300, 1800, 2300, 2800, 3300];
  if (withClicks) addClicks(buf, clicks, 0.6);
  return { buf, clicks };
}

function analyse(buf: Float32Array, stepFrames: number, clicks: number[] = []) {
  const rs = new StreamingResampler(SR, PIANO_ENGINE.sampleRate);
  const stream = new BasicPitchStream(tf, model, stepFrames);
  for (let i = 0; i < buf.length; i += 4096) stream.append(rs.push(buf.subarray(i, i + 4096)));
  stream.runReady(true);
  return toNoteEvents(stream.notes(), { offsetMs: 0, latencyMs: 0, clickTimes: clicks });
}

function checkChords(events: ReturnType<typeof analyse>) {
  const groups = groupIntoChords(events, 60);
  for (const c of chords) {
    const g = groups.find((x) => Math.abs(x.onsetMs - c.at) < 80);
    expect(g, `chord at ${c.at}`).toBeDefined();
    for (const p of c.pitches) expect(g!.pitches.map(Math.round)).toContain(p);
  }
}

describe('piano engine (Basic Pitch)', () => {
  it('transcribes piano-like chords (play then score)', () => {
    const { buf } = pianoAudio(false);
    checkChords(analyse(buf, PIANO_ENGINE.offlineStepFrames));
  }, 120000);

  it('gives the same chords in live (streaming) mode, with clicks mixed in', () => {
    const { buf, clicks } = pianoAudio(true);
    const events = analyse(buf, PIANO_ENGINE.liveStepFrames, clicks);
    checkChords(events);
    // Nothing up where the click lives.
    expect(events.every((e) => e.midi <= PIANO_ENGINE.maxMidi)).toBe(true);
  }, 180000);
});

describe('piano post-processing', () => {
  it('drops short notes on clicks, out-of-range notes and duplicates', () => {
    const out = toNoteEvents(
      [
        { startSeconds: 0.5, durationSeconds: 0.05, pitchMidi: 70, amplitude: 0.6 }, // click artefact
        { startSeconds: 0.5, durationSeconds: 0.5, pitchMidi: 60, amplitude: 0.6 }, // real note on the beat
        { startSeconds: 0.52, durationSeconds: 0.4, pitchMidi: 60, amplitude: 0.4 }, // duplicate
        { startSeconds: 1.0, durationSeconds: 0.3, pitchMidi: 105, amplitude: 0.9 }, // too high
      ],
      { offsetMs: 0, latencyMs: 0, clickTimes: [500] },
    );
    expect(out).toHaveLength(1);
    expect(out[0].midi).toBe(60);
  });

  it('applies the session offset and latency', () => {
    const [n] = toNoteEvents([{ startSeconds: 1, durationSeconds: 0.3, pitchMidi: 60, amplitude: 0.5 }], { offsetMs: 200, latencyMs: 80 });
    expect(n.onsetMs).toBe(1120);
  });
});
