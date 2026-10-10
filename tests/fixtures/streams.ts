import type { NoteEvent } from '../../src/engines/types';
import type { ExpectedNote } from '../../src/sheet/expected';

/** A perfect performance of the expected notes (one event per written pitch). */
export function perfect(expected: ExpectedNote[], opts: { jitterMs?: number; cents?: number; holdFraction?: number } = {}): NoteEvent[] {
  let seed = 3;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  return expected.flatMap((e) =>
    e.pitches.map((p) => ({
      midi: p + (opts.cents ?? 0) / 100,
      cents: opts.cents ?? 0,
      onsetMs: e.onsetMs + (opts.jitterMs ? rand() * opts.jitterMs : 0),
      durationMs: e.durationMs * (opts.holdFraction ?? 0.9),
      confidence: 0.95,
    })),
  );
}
