/// <reference lib="webworker" />
import * as tf from '@tensorflow/tfjs';
import { StreamingResampler } from '../../audio/dsp';
import { PIANO_ENGINE, stepSeconds } from './config';
import type { FromPianoWorker, ToPianoWorker } from './messages';
import { BasicPitchStream } from './stream';

declare const self: DedicatedWorkerGlobalScope;

let model: tf.GraphModel | null = null;
let stream: BasicPitchStream | null = null;
let resampler: StreamingResampler | null = null;
let sampleRate = 48000;
let live = true;
let slowSteps = 0;

const post = (m: FromPianoWorker) => self.postMessage(m);

async function pickBackend(): Promise<string> {
  for (const b of ['webgl', 'cpu']) {
    try {
      if (await tf.setBackend(b)) {
        await tf.ready();
        return b;
      }
    } catch {
      // try the next one
    }
  }
  return tf.getBackend();
}

async function init(modelUrl: string, sr: number) {
  sampleRate = sr;
  const backend = await pickBackend();
  model = await tf.loadGraphModel(modelUrl);
  // Warm-up: the first run compiles shaders, so time the second one too.
  const zeros = tf.zeros([1, PIANO_ENGINE.windowSamples, 1]);
  const t0 = performance.now();
  tf.tidy(() => model!.execute(zeros, ['Identity_1', 'Identity_2']));
  const first = performance.now() - t0;
  const t1 = performance.now();
  const outs = tf.tidy(() => model!.execute(zeros, ['Identity_1', 'Identity_2']) as tf.Tensor[]);
  await Promise.all(outs.map((o) => o.data()));
  outs.forEach((o) => o.dispose());
  const second = performance.now() - t1;
  zeros.dispose();
  // Report the steady-state cost per live step, but flag a very slow first run too.
  post({ type: 'ready', backend, warmupMs: Math.max(second, first > PIANO_ENGINE.slowFirstInferenceMs ? first : 0) });
}

function handleAudio(samples: Float32Array) {
  if (!stream || !resampler) return;
  stream.append(resampler.push(samples));
  if (!live) return;
  let ran = false;
  while (stream.canStep()) {
    const ms = stream.step();
    ran = true;
    if (ms > PIANO_ENGINE.realtimeBudget * stepSeconds(stream.stepFrames) * 1000) slowSteps++;
    else slowSteps = Math.max(0, slowSteps - 1);
    if (slowSteps >= 3) {
      // Can't keep up: stop live work, keep recording, score at the end.
      live = false;
      stream.stepFrames = PIANO_ENGINE.offlineStepFrames;
      post({ type: 'fellBehind' });
      return;
    }
  }
  if (ran) post({ type: 'notes', notes: stream.notes() });
}

async function finish() {
  if (!stream) {
    post({ type: 'done', notes: [] });
    return;
  }
  stream.stepFrames = live ? stream.stepFrames : PIANO_ENGINE.offlineStepFrames;
  const totalFrames = Math.ceil((stream.audioSeconds * PIANO_ENGINE.sampleRate) / PIANO_ENGINE.fftHop);
  let lastPost = 0;
  while (stream.canStep(true)) {
    stream.step();
    const now = performance.now();
    if (now - lastPost > 200) {
      lastPost = now;
      post({ type: 'progress', fraction: Math.min(1, stream.framesDone / Math.max(1, totalFrames)) });
      // Let the progress message out.
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const notes = stream.notes();
  // Recordings are never kept: drop the audio as soon as it's analysed.
  stream.reset();
  post({ type: 'done', notes });
}

self.onmessage = async (ev: MessageEvent<ToPianoWorker>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'init':
        await init(msg.modelUrl, msg.sampleRate);
        break;
      case 'start':
        if (!model) throw new Error('Model not loaded');
        live = msg.live;
        slowSteps = 0;
        stream = new BasicPitchStream(tf, model, live ? PIANO_ENGINE.liveStepFrames : PIANO_ENGINE.offlineStepFrames);
        resampler = new StreamingResampler(sampleRate, PIANO_ENGINE.sampleRate);
        break;
      case 'audio':
        handleAudio(msg.samples);
        break;
      case 'finish':
        await finish();
        break;
      case 'reset':
        stream?.reset();
        stream = null;
        break;
    }
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
