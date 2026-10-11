import type { Instrument } from '../config';
import { barLength, checkLine, type BarProblem } from './checks';
import { callReader, OmrError, type ReaderRequest, type ReaderResult } from './omrClient';
import { NotationError, notationToMusicXml, parseStaff, type RnMeasure, type RnScore } from './notation';
import { RequestPacer } from './pacer';
import type { PreparedPage } from './pagePrep';

/**
 * Reading a page, line by line:
 *  1. a quick look at the whole page (small picture) for the title, key, time
 *     signature, tempo and pickup;
 *  2. each line of music read on its own from a full-resolution crop, carrying
 *     the key and time signature from line to line;
 *  3. free code checks on each line (bars add up, key applied, range, tuplets);
 *  4. up to two double-check rounds per line: a fresh request with the photo,
 *     an engraving of our transcription and the problems found, which lists
 *     mismatches and returns a corrected line. Stops early when nothing is wrong.
 * Bars that still fail a check, or that the reader wasn't sure about, are
 * flagged for the review screen.
 */

export interface Overview {
  title?: string | null;
  composer?: string | null;
  tempo?: { bpm?: number; beat?: string; text?: string } | null;
  key?: number | null;
  time?: string | null;
  clef?: string | null;
  staves?: number;
  pickup?: boolean;
  pickup_notes?: string;
  lines?: number | null;
  first_bars?: (number | null)[];
  changes?: string[];
}

interface LineReply {
  measures: RnMeasure[];
  unsure?: number[];
  warnings?: string[];
}

interface CheckReply {
  mismatches: { bar: number | null; what: string; detail: string }[];
  measures: RnMeasure[] | null;
  unsure?: number[];
}

export type ReadStage = 'overview' | 'reading' | 'checking';

export interface ReadProgress {
  stage: ReadStage;
  page: number;
  pages: number;
  /** 1-based line on this page. */
  line?: number;
  lines?: number;
  /** Double-check round (1 or 2). */
  round?: number;
  /** Bars found so far on the line being read. */
  bars?: number;
  /** Waiting for the reader's per-minute limit: seconds left. */
  waitSeconds?: number;
}

export interface BarFlag {
  /** Index into the final measure list (= OSMD's measure index). */
  index: number;
  /** Printed bar number. */
  n: number;
  reasons: string[];
}

/** What happened on each line, for the accuracy report and debugging. */
export interface LineTrace {
  page: number;
  line: number;
  firstRead: RnMeasure[];
  firstProblems: BarProblem[];
  rounds: { mismatches: CheckReply['mismatches']; measures: RnMeasure[]; problems: BarProblem[]; accepted: boolean }[];
  final: RnMeasure[];
  checkSkipped?: string;
}

export interface ReadResult {
  score: RnScore;
  musicxml: string;
  warnings: string[];
  flags: BarFlag[];
  trace: { overview: Overview[]; lines: LineTrace[]; provider?: string };
}

/** Sends one request (tests replace this). */
export type Sender = (req: ReaderRequest, onBars?: (bars: number) => void) => Promise<ReaderResult>;
/** Engraves one line to an image (tests replace this; the app uses OSMD). */
export type LineRenderer = (measures: RnMeasure[], ctx: { key?: number; time?: string; clef?: string; staves: 1 | 2 }) => Promise<Blob>;

export interface ReadOptions {
  instrument: Instrument;
  provider?: string;
  onProgress?: (p: ReadProgress) => void;
  /** Double-check rounds per line (0 = off). */
  checkRounds?: number;
  rpm?: number;
  send?: Sender;
  render?: LineRenderer;
  pacer?: RequestPacer;
}

/** Turn whatever the model sent as a bar list into clean measures, numbered from `first`. Pure. */
export function normaliseLine(raw: RnMeasure[], first: number, allowPickup: boolean): RnMeasure[] {
  const out: RnMeasure[] = [];
  let n = first;
  raw.forEach((m, i) => {
    const pickup = allowPickup && i === 0 && (m.pickup === true || Number(m.n) === 0);
    const clean: RnMeasure = { ...m };
    if (pickup) {
      clean.pickup = true;
      clean.n = 0;
    } else {
      delete clean.pickup;
      clean.n = n++;
    }
    if (typeof clean.key === 'string') clean.key = Number(clean.key);
    if (clean.key !== undefined && !Number.isFinite(clean.key)) delete clean.key;
    out.push(clean);
  });
  return out;
}

/** The last key/time/clef set on these bars (carried to the next line). Pure. */
export function carryForward(measures: RnMeasure[], ctx: { key?: number; time?: string; clef?: string }) {
  const next = { ...ctx };
  for (const m of measures) {
    if (m.key !== undefined && Number.isInteger(m.key)) next.key = m.key;
    if (m.time) next.time = m.time;
    if (m.clef) next.clef = m.clef;
  }
  return next;
}

/** A pickup that wasn't marked: the piece's first bar is short. Pure. */
export function markPickup(measures: RnMeasure[], time: string | undefined): RnMeasure[] {
  const first = measures[0];
  if (!first || first.pickup || !first.s1) return measures;
  try {
    const q = parseStaff(first.s1).reduce((s, e) => s + e.quarters, 0);
    if (q > 0 && q < barLength(first.time ?? time) - 1e-6) {
      return [{ ...first, pickup: true, n: 0 }, ...measures.slice(1).map((m) => ({ ...m, n: Number(m.n) - (Number(first.n) === 0 ? 0 : 1) }))];
    }
  } catch {
    // Unreadable bar: the checks will report it.
  }
  return measures;
}

const asArray = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);

export async function readPrepared(pages: PreparedPage[], opts: ReadOptions): Promise<ReadResult> {
  const instrument = opts.instrument;
  const staves: 1 | 2 = instrument === 'piano' ? 2 : 1;
  const send: Sender = opts.send ?? ((req, onBars) => callReader(req, { instrument, provider: opts.provider, onBars }));
  const pacer = opts.pacer ?? new RequestPacer({ rpm: opts.rpm ?? 8, maxWaitMs: 20 * 60_000 });
  const rounds = Math.max(0, Math.min(2, opts.checkRounds ?? 2));
  const progress = opts.onProgress ?? (() => undefined);

  const overviews: Overview[] = [];
  const traces: LineTrace[] = [];
  const all: { m: RnMeasure; unsure: boolean; problems: BarProblem[] }[] = [];
  const warnings: string[] = [];
  let provider: string | undefined;
  let ctx: { key?: number; time?: string; clef?: string } = {};
  let nextBar = 1;

  const request = async (base: ReadProgress, req: ReaderRequest): Promise<ReaderResult> => {
    progress(base);
    const res = await pacer.run(
      () => send(req, (bars) => progress({ ...base, bars })),
      (s) => progress({ ...base, waitSeconds: s }),
    );
    provider ??= res.provider;
    return res;
  };

  for (let p = 0; p < pages.length; p++) {
    const page = pages[p];
    const pageNo = p + 1;
    // 1. Overview.
    let ov: Overview = {};
    try {
      const res = await request({ stage: 'overview', page: pageNo, pages: pages.length }, {
        mode: 'overview',
        images: [{ blob: page.context, name: `page-${pageNo}.jpg` }],
        fields: { page: pageNo, pages: pages.length },
      });
      ov = (res.overview ?? {}) as Overview;
    } catch (e) {
      // The overview only helps; carry on without it unless the reader can't work at all.
      if (!(e instanceof OmrError) || !['unreadable', 'server', 'timeout'].includes(e.kind)) throw e;
    }
    overviews.push(ov);
    if (ov.key !== null && ov.key !== undefined && (p === 0 || ctx.key === undefined)) ctx.key = ov.key;
    if (ov.time && (p === 0 || !ctx.time)) ctx.time = ov.time;
    if (ov.clef && !ctx.clef) ctx.clef = ov.clef;

    const lines = page.lines.length;
    for (let l = 0; l < lines; l++) {
      const lineNo = l + 1;
      const firstOfPiece = p === 0 && l === 0;
      const lastOfPiece = p === pages.length - 1 && l === lines - 1;
      const printed = ov.first_bars?.[l];
      const firstBar = typeof printed === 'number' && printed >= nextBar - 1 && printed <= nextBar + 2 ? printed : nextBar;
      const fields = {
        page: pageNo,
        pages: pages.length,
        line: lineNo,
        lines,
        key: ctx.key,
        time: ctx.time,
        clef: ctx.clef,
        first_bar: firstBar,
        pickup: firstOfPiece ? (ov.pickup === true ? 'yes' : ov.pickup === false ? 'no' : undefined) : undefined,
        pickup_notes: firstOfPiece ? ov.pickup_notes : undefined,
      };
      const crop = { blob: page.lines[l], name: `line-${pageNo}-${lineNo}.jpg` };

      // 2. Read the line.
      const res = await request({ stage: 'reading', page: pageNo, pages: pages.length, line: lineNo, lines }, { mode: 'line', images: [crop], fields });
      const reply = (res.line ?? { measures: [] }) as LineReply;
      let measures = normaliseLine(asArray<RnMeasure>(reply.measures), firstBar, firstOfPiece);
      if (firstOfPiece) measures = markPickup(measures, ctx.time);
      let unsure = new Set(asArray<number>(reply.unsure).map(Number));
      warnings.push(...asArray<string>(reply.warnings));
      const lineCtx = { key: ctx.key, time: ctx.time, instrument, firstLine: firstOfPiece, lastLine: lastOfPiece };

      // 3. Free checks.
      let problems = checkLine(measures, lineCtx);
      const trace: LineTrace = { page: pageNo, line: lineNo, firstRead: measures, firstProblems: problems, rounds: [], final: measures };

      // 4. Double-check rounds.
      for (let round = 1; round <= rounds; round++) {
        let image: Blob;
        try {
          if (!opts.render) throw new Error('no renderer');
          image = await opts.render(measures, { key: ctx.key, time: ctx.time, clef: ctx.clef, staves });
        } catch (e) {
          trace.checkSkipped = `couldn't engrave the line (${(e as Error).message})`;
          break;
        }
        const check = await request(
          { stage: 'checking', page: pageNo, pages: pages.length, line: lineNo, lines, round },
          {
            mode: 'check',
            images: [crop, { blob: image, name: `engraving-${pageNo}-${lineNo}.png` }],
            fields: {
              ...fields,
              round,
              transcription: JSON.stringify({ measures }),
              problems: JSON.stringify(problems.map((x) => x.message)),
            },
          },
        );
        const c = (check.check ?? { mismatches: [], measures: null }) as CheckReply;
        const mismatches = asArray<CheckReply['mismatches'][number]>(c.mismatches);
        unsure = new Set(asArray<number>(c.unsure).map(Number));
        if (mismatches.length === 0 || !c.measures) {
          trace.rounds.push({ mismatches, measures, problems, accepted: false });
          break;
        }
        let corrected = normaliseLine(asArray<RnMeasure>(c.measures), firstBar, firstOfPiece);
        if (firstOfPiece) corrected = markPickup(corrected, ctx.time);
        const newProblems = checkLine(corrected, lineCtx);
        // Take the correction unless it breaks more bars than it fixes.
        const accepted = newProblems.length <= problems.length || corrected.length === measures.length;
        trace.rounds.push({ mismatches, measures: corrected, problems: newProblems, accepted });
        if (!accepted) break;
        measures = corrected;
        problems = newProblems;
      }
      trace.final = measures;
      traces.push(trace);

      for (const m of measures) {
        all.push({ m, unsure: unsure.has(Number(m.n)), problems: problems.filter((x) => x.n === Number(m.n)) });
      }
      ctx = carryForward(measures, ctx);
      const last = measures.filter((m) => !m.pickup).pop();
      nextBar = last ? Number(last.n) + 1 : nextBar;
    }
  }

  // Put the piece together.
  const ov0 = overviews.find((o) => o.title || o.composer || o.tempo) ?? overviews[0] ?? {};
  const measures = all.map((x) => x.m);
  if (measures.length === 0) throw new OmrError('unreadable', undefined, 'no_measures');
  const firstKey = measures.find((m) => m.key !== undefined)?.key ?? overviews[0]?.key ?? 0;
  const firstTime = measures.find((m) => m.time)?.time ?? overviews[0]?.time ?? '4/4';
  measures[0] = { ...measures[0], key: measures[0].key ?? firstKey ?? 0, time: measures[0].time ?? firstTime, clef: measures[0].clef ?? overviews[0]?.clef ?? (staves === 2 ? 'treble' : undefined) };
  const score: RnScore = {
    title: ov0.title ?? undefined,
    composer: ov0.composer ?? undefined,
    tempo: ov0.tempo ?? null,
    staves,
    measures,
    warnings: [...new Set(warnings)].slice(0, 6),
  };
  const flags: BarFlag[] = [];
  all.forEach((x, index) => {
    const reasons = x.problems.map((p) => p.message);
    if (x.unsure) reasons.push(`The music reader wasn't sure about bar ${x.m.n}.`);
    if (reasons.length) flags.push({ index, n: Number(x.m.n), reasons });
  });
  let converted;
  try {
    const partName = { violin: 'Violin', piano: 'Piano', voice: 'Voice' }[instrument];
    converted = notationToMusicXml(score, partName);
  } catch (e) {
    if (e instanceof NotationError) throw new OmrError('unreadable', undefined, 'bad_notation');
    throw e;
  }
  return { score, musicxml: converted.musicxml, warnings: score.warnings ?? [], flags, trace: { overview: overviews, lines: traces, provider } };
}
