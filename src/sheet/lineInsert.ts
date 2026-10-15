import type { Instrument } from '../config';
import { insertMeasures, serialise } from './editor';
import { parseXmlDocument } from './musicxml';
import { notationToMusicXml, type RnMeasure } from './notation';

const PART: Record<Instrument, string> = { violin: 'Violin', piano: 'Piano', voice: 'Voice' };

/**
 * Put a line read again into the music at measure index `at`. The line's own key,
 * time and clef only go in if it changes them; otherwise the music carries on.
 */
export function insertLine(
  xml: string,
  at: number,
  measures: RnMeasure[],
  ctx: { key?: number; time?: string; clef?: string; clef2?: string },
  instrument: Instrument,
  /** 2 for a grand staff (older drafts don't say: then piano is 2). */
  lineStaves?: 1 | 2,
): { xml: string; count: number } {
  if (measures.length === 0) return { xml, count: 0 };
  const staves = lineStaves ?? (instrument === 'piano' ? 2 : 1);
  const [head, ...rest] = measures;
  const first = { ...head, key: head.key ?? ctx.key ?? 0, time: head.time ?? ctx.time ?? '4/4', clef: head.clef ?? ctx.clef, ...(staves === 2 ? { clef2: head.clef2 ?? ctx.clef2 } : {}) };
  const line = notationToMusicXml({ staves, measures: [first, ...rest] }, PART[instrument]).musicxml;
  const doc = parseXmlDocument(xml);
  const keep = { key: head.key !== undefined && head.key !== ctx.key, time: !!head.time && head.time !== ctx.time, clef: !!head.clef && head.clef !== ctx.clef };
  const count = insertMeasures(doc, at, line, keep);
  return { xml: serialise(doc), count };
}
