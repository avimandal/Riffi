import type { NoteEvent } from '../types';
import { PIANO_ENGINE } from './config';

/** A note straight from Basic Pitch, timed from the start of the recording. */
export interface RawPianoNote {
  startSeconds: number;
  durationSeconds: number;
  pitchMidi: number;
  amplitude: number;
}

export interface PostprocessOptions {
  /** Session time of the first recorded sample. */
  offsetMs: number;
  latencyMs: number;
  /** Metronome click times in the corrected session time base. */
  clickTimes?: number[];
}

/** Convert Basic Pitch notes to NoteEvents: latency-corrected, range-limited, clicks removed, de-duplicated. Pure. */
export function toNoteEvents(raw: RawPianoNote[], opts: PostprocessOptions): NoteEvent[] {
  const cfg = PIANO_ENGINE;
  const clicks = [...(opts.clickTimes ?? [])].sort((a, b) => a - b);
  const nearClick = (t: number) => {
    // Binary search for the nearest click.
    let lo = 0;
    let hi = clicks.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (clicks[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    const cands = [clicks[lo], clicks[lo - 1]].filter((c) => c !== undefined);
    return cands.some((c) => Math.abs(c - t) <= cfg.clickMaskMs);
  };

  const events: NoteEvent[] = [];
  for (const n of raw) {
    if (n.pitchMidi < cfg.minMidi || n.pitchMidi > cfg.maxMidi) continue;
    const onsetMs = n.startSeconds * 1000 + opts.offsetMs - opts.latencyMs;
    const durationMs = n.durationSeconds * 1000;
    if (clicks.length && nearClick(onsetMs) && (durationMs < cfg.clickShortMs || n.amplitude < cfg.clickQuietAmplitude)) {
      continue;
    }
    events.push({
      midi: n.pitchMidi,
      cents: 0,
      onsetMs,
      durationMs,
      confidence: Math.max(0, Math.min(1, n.amplitude)),
    });
  }
  events.sort((a, b) => a.onsetMs - b.onsetMs || a.midi - b.midi);

  const out: NoteEvent[] = [];
  for (const e of events) {
    const dup = out.find((o) => o.midi === e.midi && Math.abs(o.onsetMs - e.onsetMs) <= cfg.dedupeMs);
    if (dup) {
      if (e.confidence > dup.confidence) Object.assign(dup, { confidence: e.confidence });
      dup.durationMs = Math.max(dup.durationMs, e.onsetMs + e.durationMs - dup.onsetMs);
      continue;
    }
    out.push({ ...e });
  }
  return out;
}
