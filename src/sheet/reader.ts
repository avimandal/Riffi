import type { Instrument } from '../config';
import { barLength, checkLine, type BarProblem } from './checks';
import { callReader, OmrError, type ReaderRequest, type ReaderResult } from './omrClient';
import { headNames, lineHint } from './noteHeads';
import { snapToHeads } from './snap';
import { NotationError, notationToMusicXml, parseStaff, type RnMeasure, type RnScore } from './notation';
import { RequestPacer } from './pacer';
import type { PreparedPage } from './pagePrep';

/**
 * Reading a page, line by line:
 *  1. a quick look at the whole page (small picture) for the title, key, time
 *     signature, tempo and pickup;
 *  2. every line of music read from its own full-resolution crop, with the note
 *     heads the app measured on it as hints, carrying the key, time signature
 *     and bar numbers from line to line;
 *  3. free code checks on each line (bars add up, key applied, range, tuplets,
 *     pitches agree with the measured note heads);
 *  4. up to two double-check rounds per line: a fresh request with the photo,
 *     an engraving of our transcription and the problems found, which lists
 *     mismatches and returns a corrected line. Stops early when nothing is wrong.
 * Several lines can share one request (each still its own picture): Gemini's
 * free tier allows only about 20 requests a day per model, so the server says
 * how many lines go together (LINES_PER_REQUEST). Bars that still fail a check,
 * or that the reader wasn't sure about, are flagged for the review screen.
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
  lines?: { line: number; measures: RnMeasure[]; unsure?: number[] }[];
  /** Older single-line form. */
  measures?: RnMeasure[];
  unsure?: number[];
  warnings?: string[];
}

interface CheckLine {
  line: number;
  mismatches: { bar: number | null; what: string; detail: string }[];
  measures: RnMeasure[] | null;
  unsure?: number[];
}

interface CheckReply {
  lines?: CheckLine[];
}

export type ReadStage = 'overview' | 'reading' | 'checking';

export interface ReadProgress {
  stage: ReadStage;
  page: number;
  pages: number;
  /** 1-based line on this page (the first, if several are read together). */
  line?: number;
  /** The last line in this request, if several are read together. */
  lineTo?: number;
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
  rounds: { mismatches: CheckLine['mismatches']; measures: RnMeasure[]; problems: BarProblem[]; accepted: boolean }[];
  final: RnMeasure[];
  checkSkipped?: string;
  /** Notes moved onto the measured note heads (first read, then each accepted correction). */
  snapped?: number[];
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
  /** Lines per request (1 = one line at a time). */
  linesPerRequest?: number;
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

interface LineState {
  page: number;
  line: number;
  crop: { blob: Blob; name: string };
  firstBar: number;
  firstOfPiece: boolean;
  lastOfPiece: boolean;
  /** Key/time/clef in force at the start of the line. */
  ctx: { key?: number; time?: string; clef?: string };
  hint: string;
  heads: string[][];
  measures: RnMeasure[];
  unsure: Set<number>;
  problems: BarProblem[];
  trace: LineTrace;
  /** Still worth another double-check. */
  pending: boolean;
}

/** Notes worth hinting for each instrument (one staff); piano hints aren't filtered. */
const HINT_RANGE: Partial<Record<Instrument, [string, string]>> = { violin: ['G3', 'E7'], voice: ['A2', 'C6'] };

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export async function readPrepared(pages: PreparedPage[], opts: ReadOptions): Promise<ReadResult> {
  const instrument = opts.instrument;
  const staves: 1 | 2 = instrument === 'piano' ? 2 : 1;
  const send: Sender = opts.send ?? ((req, onBars) => callReader(req, { instrument, provider: opts.provider, onBars }));
  const pacer = opts.pacer ?? new RequestPacer({ rpm: opts.rpm ?? 8, maxWaitMs: 20 * 60_000 });
  const rounds = Math.max(0, Math.min(2, opts.checkRounds ?? 2));
  const per = Math.max(1, Math.min(12, opts.linesPerRequest ?? 8));
  const progress = opts.onProgress ?? (() => undefined);

  const overviews: Overview[] = [];
  const all: LineState[] = [];
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
  const lineCtx = (st: LineState) => ({
    key: st.ctx.key,
    time: st.ctx.time,
    instrument,
    firstLine: st.firstOfPiece,
    lastLine: st.lastOfPiece,
    heads: st.heads,
  });
  const span = (group: LineState[]) => ({ line: group[0].line, lineTo: group.length > 1 ? group[group.length - 1].line : undefined });

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

    // 2–3. Read the lines (several per request), then check each in code.
    const lines = page.lines.length;
    const clef = ctx.clef ?? 'treble';
    const pageLines: LineState[] = page.lines.map((blob, l) => ({
      page: pageNo,
      line: l + 1,
      crop: { blob, name: `line-${pageNo}-${l + 1}.jpg` },
      firstBar: 0,
      firstOfPiece: p === 0 && l === 0,
      lastOfPiece: p === pages.length - 1 && l === lines - 1,
      ctx: {},
      hint: lineHint(page.heads?.[l], clef, 'bass', HINT_RANGE[instrument]),
      heads: headNames(page.heads?.[l], clef, 'bass', HINT_RANGE[instrument]),
      measures: [],
      unsure: new Set<number>(),
      problems: [],
      trace: { page: pageNo, line: l + 1, firstRead: [], firstProblems: [], rounds: [], final: [] },
      pending: true,
    }));
    for (const group of chunks(pageLines, per)) {
      const firstOfPiece = group[0].firstOfPiece;
      const printed = ov.first_bars?.[group[0].line - 1];
      const firstBar = typeof printed === 'number' && printed >= nextBar - 1 && printed <= nextBar + 2 ? printed : nextBar;
      const res = await request(
        { stage: 'reading', page: pageNo, pages: pages.length, lines, ...span(group) },
        {
          mode: 'line',
          images: group.map((g) => g.crop),
          fields: {
            page: pageNo,
            pages: pages.length,
            line: group[0].line,
            lines,
            key: ctx.key,
            time: ctx.time,
            clef: ctx.clef,
            first_bar: firstBar,
            pickup: firstOfPiece ? (ov.pickup === true ? 'yes' : ov.pickup === false ? 'no' : undefined) : undefined,
            pickup_notes: firstOfPiece ? ov.pickup_notes : undefined,
            hints: JSON.stringify(group.map((g) => g.hint)),
          },
        },
      );
      const reply = (res.line ?? {}) as LineReply;
      warnings.push(...asArray<string>(reply.warnings));
      const replies = asArray<NonNullable<LineReply['lines']>[number]>(reply.lines);
      if (replies.length === 0 && reply.measures) replies.push({ line: group[0].line, measures: reply.measures, unsure: reply.unsure });
      let bar = firstBar;
      group.forEach((st, k) => {
        const r = replies.find((x) => Number(x.line) === st.line) ?? replies[k];
        st.firstBar = bar;
        st.ctx = { ...ctx };
        let measures = normaliseLine(asArray<RnMeasure>(r?.measures), bar, st.firstOfPiece);
        if (st.firstOfPiece) measures = markPickup(measures, ctx.time);
        // Pitch comes from the measured note heads; the model keeps rhythm, accidentals, ties, tuplets and bars.
        const snapped = snapToHeads(measures, st.heads, ctx.key ?? 0);
        measures = snapped.measures;
        st.trace.snapped = [snapped.moved];
        st.measures = measures;
        st.unsure = new Set(asArray<number>(r?.unsure).map(Number));
        st.problems = checkLine(measures, lineCtx(st));
        st.trace.firstRead = measures;
        st.trace.firstProblems = st.problems;
        ctx = carryForward(measures, ctx);
        const last = measures.filter((m) => !m.pickup).pop();
        bar = last ? Number(last.n) + 1 : bar;
      });
      nextBar = bar;
    }
    all.push(...pageLines);
  }

  // 4. Double-check rounds, for every line, several lines per request.
  // A check sends two pictures per line and makes the model think harder, so it takes half as many lines.
  const perCheck = Math.max(1, Math.ceil(per / 2));
  for (let round = 1; round <= rounds; round++) {
    const pending = all.filter((st) => st.pending && st.measures.length > 0);
    if (pending.length === 0) break;
    for (const group of chunks(pending, perCheck)) {
      const ready: { st: LineState; image: Blob }[] = [];
      for (const st of group) {
        try {
          if (!opts.render) throw new Error('no renderer');
          ready.push({ st, image: await opts.render(st.measures, { key: st.ctx.key, time: st.ctx.time, clef: st.ctx.clef, staves }) });
        } catch (e) {
          st.trace.checkSkipped = `couldn't engrave the line (${(e as Error).message})`;
          st.pending = false;
        }
      }
      if (ready.length === 0) continue;
      const first = ready[0].st;
      let check: ReaderResult;
      try {
        check = await request(
          { stage: 'checking', page: first.page, pages: pages.length, lines: pages[first.page - 1].lines.length, round, ...span(ready.map((r) => r.st)) },
          {
            mode: 'check',
            images: ready.flatMap(({ st, image }) => [st.crop, { blob: image, name: `engraving-${st.page}-${st.line}.png` }]),
            fields: {
              page: first.page,
              pages: pages.length,
              line: first.line,
              lines: pages[first.page - 1].lines.length,
              line_numbers: JSON.stringify(ready.map((r) => r.st.line)),
              key: first.ctx.key,
              time: first.ctx.time,
              round,
              transcriptions: JSON.stringify(ready.map((r) => ({ measures: r.st.measures }))),
              problems: JSON.stringify(ready.map((r) => r.st.problems.map((x) => x.message))),
              hints: JSON.stringify(ready.map((r) => r.st.hint)),
            },
          },
        );
      } catch (e) {
        // A double-check that fails keeps the first read (its bars still get the code checks' flags).
        if (!(e instanceof OmrError) || !['unreadable', 'timeout', 'server', 'busy'].includes(e.kind)) throw e;
        for (const { st } of ready) {
          st.trace.checkSkipped = `double-check failed (${e.code ?? e.kind})`;
          st.pending = false;
        }
        continue;
      }
      const replies = asArray<CheckLine>(((check.check ?? {}) as CheckReply).lines);
      ready.forEach(({ st }, k) => {
        const c = replies.find((x) => Number(x.line) === st.line) ?? replies[k];
        const mismatches = asArray<CheckLine['mismatches'][number]>(c?.mismatches);
        if (c?.unsure) st.unsure = new Set(asArray<number>(c.unsure).map(Number));
        if (!c || mismatches.length === 0 || !c.measures) {
          st.trace.rounds.push({ mismatches, measures: st.measures, problems: st.problems, accepted: false });
          st.pending = false;
          return;
        }
        let corrected = normaliseLine(asArray<RnMeasure>(c.measures), st.firstBar, st.firstOfPiece);
        if (st.firstOfPiece) corrected = markPickup(corrected, st.ctx.time);
        const snapped = snapToHeads(corrected, st.heads, st.ctx.key ?? 0);
        corrected = snapped.measures;
        st.trace.snapped?.push(snapped.moved);
        const newProblems = checkLine(corrected, lineCtx(st));
        // Take the correction unless it breaks more bars than it fixes.
        const accepted = newProblems.length <= st.problems.length || corrected.length === st.measures.length;
        st.trace.rounds.push({ mismatches, measures: corrected, problems: newProblems, accepted });
        if (!accepted) {
          st.pending = false;
          return;
        }
        st.measures = corrected;
        st.problems = newProblems;
      });
    }
  }

  // Put the piece together, numbering bars in order (a correction may have changed a line's bar count).
  const ov0 = overviews.find((o) => o.title || o.composer || o.tempo) ?? overviews[0] ?? {};
  const entries: { m: RnMeasure; unsure: boolean; problems: BarProblem[] }[] = [];
  let n = 1;
  for (const st of all) {
    st.trace.final = st.measures;
    for (const m of st.measures) {
      const local = Number(m.n);
      const renumbered = m.pickup ? { ...m, n: 0 } : { ...m, n: n++ };
      entries.push({
        m: renumbered,
        unsure: st.unsure.has(local),
        problems: st.problems.filter((x) => x.n === local).map((x) => ({ ...x, message: x.message.replace(`Bar ${local}`, `Bar ${renumbered.n}`) })),
      });
    }
  }
  const measures = entries.map((x) => x.m);
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
  entries.forEach((x, index) => {
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
  return { score, musicxml: converted.musicxml, warnings: score.warnings ?? [], flags, trace: { overview: overviews, lines: all.map((st) => st.trace), provider } };
}
