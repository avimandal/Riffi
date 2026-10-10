import type { RawPianoNote } from './postprocess';

export type ToPianoWorker =
  | { type: 'init'; modelUrl: string; sampleRate: number }
  | { type: 'start'; live: boolean }
  | { type: 'audio'; samples: Float32Array }
  | { type: 'finish' }
  | { type: 'reset' };

export type FromPianoWorker =
  | { type: 'ready'; backend: string; warmupMs: number }
  | { type: 'notes'; notes: RawPianoNote[] }
  | { type: 'fellBehind' }
  | { type: 'progress'; fraction: number }
  | { type: 'done'; notes: RawPianoNote[] }
  | { type: 'error'; message: string };
