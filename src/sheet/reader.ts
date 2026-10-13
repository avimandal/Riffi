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

/** Everything needed to read one line (again). */
export interface LineJob {
  page: number;
  pages: number;
  line: number;
  lines: number;
  crop: Blob;
  /** Key/time/clef in force at the start of the line (from the page overview and earlier lines). */
  ctx: { key?: number; time?: string; clef?: string };
  /** Printed number of its first bar, if the overview saw it. */
  printedFirstBar?: number;
  hint: string;
  heads: string[][];
  firstOfPiece: boolean;
  lastOfPiece: boolean;
  pickup?: 'yes' | 'no';
  pickupNotes?: string;
}

/** A line that couldn't be read (after one retry with a smaller request). */
export interface FailedLine {
  page: number;
  line: number;
  /** Where its bars belong: the index in the measure list they would start at. */
  at: number;
  /** Error category and code, e.g. timeout / client_timeout. */
  kind: string;
  code?: string;
  ref?: string;
  job: LineJob;
}

/** How each line is getting on, for showing results as they arrive. */
export type LineStatus = 'waiting' | 'reading' | 'retrying' | 'done' | 'failed';

export interface PartialRead {
  /** MusicXML of the lines read so far (in order, skipping lines not read yet). */
  musicxml: string | null;
  lines: { page: number; line: number; status: LineStatus }[];
}

/** Where the time went (sent to the private log, and shown in Settings). */
export interface ReadTimings {
  pages: number;
  lines: number;
  lines_read: number;
  lines_failed: number;
  retries: number;
  total_ms: number;
  prep_ms: number;
  heads_ms: number;
  render_ms: number;
  wait_ms: number;
  parallel: number;
  lines_per_request: number;
  requests: { mode: string; lines: number; ms: number; ok: boolean; code?: string; ref?: string }[];
}

export interface ReadResult {
  score: RnScore;
  musicxml: string;
  warnings: string[];
  flags: BarFlag[];
  /** Which bars (indexes into the measure list) came from each line of each photo, for side-by-side checking. */
  lineBars: { page: number; line: number; from: number; to: number }[];
  /** Lines that couldn't be read; everything else is kept. */
  failed: FailedLine[];
  timings: ReadTimings;
  trace: { overview: Overview[]; lines: LineTrace[]; provider?: string };
}

/** Sends one request (tests replace this). */
export type Sender = (req: ReaderRequest, onBars?: (bars: number) => void) => Promise<ReaderResult>;
/** Engraves one line to an image (tests replace this; the app uses OSMD). */
export type LineRenderer = (measures: RnMeasure[], ctx: { key?: number; time?: string; clef?: string; staves: 1 | 2 }) => Promise<Blob>;

export interface ReadOptions {
  instrument: Instrument;
  onProgress?: (p: ReadProgress) => void;
  /** Called whenever a line arrives (or fails), with everything read so far. */
  onLine?: (p: PartialRead) => void;
  /** Double-check rounds per line (0 = off). */
  checkRounds?: number;
  rpm?: number;
  /** Lines per request (1 = one line at a time). */
  linesPerRequest?: number;
  /** Requests waiting on the reader at once (still within rpm). */
  parallel?: number;
  send?: Sender;
  render?: LineRenderer;
  /** A smaller copy of a line's picture, for its retry (the app scales it down; tests pass it through). */
  shrink?: (crop: Blob) => Promise<Blob>;
  pacer?: RequestPacer;
  /** Image prep and note-head timings measured before reading, to report with the rest. */
  prepMs?: number;
  headsMs?: number;
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
  job: LineJob;
  status: LineStatus;
  measures: RnMeasure[];
  unsure: Set<number>;
  problems: BarProblem[];
  trace: LineTrace;
  /** Still worth another double-check. */
  pending: boolean;
  /** Why the last request for it failed. */
  error?: OmrError;
}

/** Notes worth hinting for each instrument (one staff); piano hints aren't filtered. */
const HINT_RANGE: Partial<Record<Instrument, [string, string]>> = { violin: ['G3', 'E7'], voice: ['A2', 'C6'] };

const chunks = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

/** Run at most `n` of these at once. */
function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

/** Errors that no retry can fix (no key, no quota left, offline…): stop sending more. */
const FATAL = new Set(['quota', 'notConfigured', 'settings', 'blocked', 'offline', 'rateLimited']);
const isFatal = (e: unknown) => e instanceof OmrError && FATAL.has(e.kind);

const partName = (instrument: Instrument) => ({ violin: 'Violin', piano: 'Piano', voice: 'Voice' })[instrument];

/** The model's bar numbers for "unsure" bars → our numbering of the same bars. Pure. */
function unsureBars(raw: RnMeasure[], measures: RnMeasure[], unsure: unknown): Set<number> {
  const out = new Set<number>();
  for (const u of asArray<number>(unsure).map(Number)) {
    const i = raw.findIndex((m) => Number(m.n) === u);
    if (i >= 0 && measures[i]) out.add(Number(measures[i].n));
  }
  return out;
}

/** Fields for one line request (several lines share the first line's context). */
function lineFields(group: LineJob[]) {
  const first = group[0];
  return {
    page: first.page,
    pages: first.pages,
    line: first.line,
    lines: first.lines,
    key: first.ctx.key,
    time: first.ctx.time,
    clef: first.ctx.clef,
    first_bar: first.printedFirstBar,
    pickup: first.firstOfPiece ? first.pickup : undefined,
    pickup_notes: first.firstOfPiece ? first.pickupNotes : undefined,
    hints: JSON.stringify(group.map((g) => g.hint)),
  };
}

/** Turn one line's reply into checked, snapped bars. Pure. */
function processLine(job: LineJob, r: { measures?: unknown; unsure?: unknown } | undefined, instrument: Instrument) {
  const raw = asArray<RnMeasure>(r?.measures);
  // Read in parallel, a line may not know where it starts: then go by the bar numbers the reader saw.
  const seen = Number(raw.find((m) => !m.pickup && Number(m.n) > 0)?.n);
  let measures = normaliseLine(raw, job.printedFirstBar ?? (Number.isInteger(seen) ? seen : 1), job.firstOfPiece);
  if (job.firstOfPiece) measures = markPickup(measures, job.ctx.time);
  // Pitch comes from the measured note heads; the model keeps rhythm, accidentals, ties, tuplets and bars.
  const snapped = snapToHeads(measures, job.heads, job.ctx.key ?? 0);
  measures = snapped.measures;
  return {
    measures,
    moved: snapped.moved,
    unsure: unsureBars(raw, measures, r?.unsure),
    problems: checkLine(measures, { key: job.ctx.key, time: job.ctx.time, instrument, firstLine: job.firstOfPiece, lastLine: job.lastOfPiece, heads: job.heads }),
  };
}

/**
 * Read one line on its own (the review screen's "Read this line again").
 * Returns its bars, checked and snapped to the measured note heads.
 */
export async function readOneLine(job: LineJob, opts: { instrument: Instrument; send?: Sender; pacer?: RequestPacer; rpm?: number; timeoutMs?: number }) {
  const send: Sender = opts.send ?? ((req, onBars) => callReader(req, { instrument: opts.instrument, onBars, timeoutMs: opts.timeoutMs }));
  const pacer = opts.pacer ?? new RequestPacer({ rpm: opts.rpm ?? 8 });
  const res = await pacer.run(() => send({ mode: 'line', images: [{ blob: job.crop, name: `line-${job.page}-${job.line}.jpg` }], fields: lineFields([job]) }));
  const reply = (res.line ?? {}) as LineReply;
  const r = asArray<NonNullable<LineReply['lines']>[number]>(reply.lines)[0] ?? (reply.measures ? { line: job.line, measures: reply.measures, unsure: reply.unsure } : undefined);
  const out = processLine(job, r, opts.instrument);
  if (out.measures.length === 0) throw new OmrError('unreadable', res.ref, 'no_measures');
  return { ...out, ref: res.ref, provider: res.provider };
}

/**
 * Read prepared pages: a quick overview of each page, then every line (or small
 * batch of lines) as its own request, several at once within the reader's
 * per-minute limit. A request that fails is retried with a smaller one (its
 * lines one by one, or a lone line with a smaller picture); a line that still
 * fails is reported, and everything else is kept.
 */
export async function readPrepared(pages: PreparedPage[], opts: ReadOptions): Promise<ReadResult> {
  const t0 = Date.now();
  const instrument = opts.instrument;
  const staves: 1 | 2 = instrument === 'piano' ? 2 : 1;
  const send: Sender = opts.send ?? ((req, onBars) => callReader(req, { instrument, onBars }));
  const pacer = opts.pacer ?? new RequestPacer({ rpm: opts.rpm ?? 8, maxWaitMs: 20 * 60_000 });
  const rounds = Math.max(0, Math.min(2, opts.checkRounds ?? 2));
  const per = Math.max(1, Math.min(12, opts.linesPerRequest ?? 8));
  const parallel = Math.max(1, Math.min(6, opts.parallel ?? 3));
  const limit = limiter(parallel);
  const progress = opts.onProgress ?? (() => undefined);
  const timings: ReadTimings = {
    pages: pages.length,
    lines: pages.reduce((n, p) => n + p.lines.length, 0),
    lines_read: 0,
    lines_failed: 0,
    retries: 0,
    total_ms: 0,
    prep_ms: Math.round(opts.prepMs ?? 0),
    heads_ms: Math.round(opts.headsMs ?? 0),
    render_ms: 0,
    wait_ms: 0,
    parallel,
    lines_per_request: per,
    requests: [],
  };

  const overviews: Overview[] = [];
  const warnings: string[] = [];
  let provider: string | undefined;
  /** A problem no retry can fix: stop sending, keep what we have. */
  let fatal: OmrError | null = null;

  const request = async (base: ReadProgress, req: ReaderRequest, lines: number): Promise<ReaderResult> => {
    if (fatal) throw fatal;
    progress(base);
    const started = Date.now();
    try {
      const res = await pacer.run(
        () => send(req, (bars) => progress({ ...base, bars })),
        (s) => progress({ ...base, waitSeconds: s }),
      );
      provider ??= res.provider;
      timings.requests.push({ mode: req.mode, lines, ms: Date.now() - started, ok: true, ref: res.ref });
      return res;
    } catch (e) {
      const err = e instanceof OmrError ? e : null;
      timings.requests.push({ mode: req.mode, lines, ms: Date.now() - started, ok: false, code: err?.code ?? err?.kind ?? 'error', ref: err?.ref });
      if (isFatal(e)) fatal ??= e as OmrError;
      throw e;
    }
  };

  // 1. A quick look at each page (title, key, time signature, pickup, printed bar numbers), all at once.
  await Promise.all(
    pages.map((page, p) =>
      limit(async () => {
        try {
          const res = await request(
            { stage: 'overview', page: p + 1, pages: pages.length },
            { mode: 'overview', images: [{ blob: page.context, name: `page-${p + 1}.jpg` }], fields: { page: p + 1, pages: pages.length } },
            0,
          );
          overviews[p] = (res.overview ?? {}) as Overview;
        } catch (e) {
          // The overview only helps; carry on without it unless nothing can be read at all.
          if (!(e instanceof OmrError)) throw e;
          overviews[p] = {};
        }
      }),
    ),
  );
  if (fatal) throw fatal;

  // 2. Every line, with the context the overviews give (key, time, clef, printed bar numbers).
  const all: LineState[] = [];
  const ctx: { key?: number; time?: string; clef?: string } = {};
  pages.forEach((page, p) => {
    const ov = overviews[p] ?? {};
    if (ov.key !== null && ov.key !== undefined && (p === 0 || ctx.key === undefined)) ctx.key = ov.key;
    if (ov.time && (p === 0 || !ctx.time)) ctx.time = ov.time;
    if (ov.clef && !ctx.clef) ctx.clef = ov.clef;
    const clef = ctx.clef ?? 'treble';
    page.lines.forEach((blob, l) => {
      const printed = ov.first_bars?.[l];
      const job: LineJob = {
        page: p + 1,
        pages: pages.length,
        line: l + 1,
        lines: page.lines.length,
        crop: blob,
        ctx: { ...ctx },
        printedFirstBar: typeof printed === 'number' && printed >= 0 ? printed : p === 0 && l === 0 ? 1 : undefined,
        hint: lineHint(page.heads?.[l], clef, 'bass', HINT_RANGE[instrument]),
        heads: headNames(page.heads?.[l], clef, 'bass', HINT_RANGE[instrument]),
        firstOfPiece: p === 0 && l === 0,
        lastOfPiece: p === pages.length - 1 && l === page.lines.length - 1,
        pickup: p === 0 && l === 0 ? (ov.pickup === true ? 'yes' : ov.pickup === false ? 'no' : undefined) : undefined,
        pickupNotes: p === 0 && l === 0 ? ov.pickup_notes : undefined,
      };
      all.push({
        job,
        status: 'waiting',
        measures: [],
        unsure: new Set<number>(),
        problems: [],
        trace: { page: p + 1, line: l + 1, firstRead: [], firstProblems: [], rounds: [], final: [] },
        pending: true,
      });
    });
  });

  const report = () => {
    if (!opts.onLine) return;
    const done = all.filter((st) => st.status === 'done' && st.measures.length);
    let musicxml: string | null = null;
    if (done.length) {
      try {
        musicxml = notationToMusicXml(pieceFrom(done.map((st) => st.measures), overviews, staves, warnings).score, partName(instrument)).musicxml;
      } catch {
        musicxml = null;
      }
    }
    opts.onLine({ musicxml, lines: all.map((st) => ({ page: st.job.page, line: st.job.line, status: st.status })) });
  };

  const accept = (st: LineState, r: { measures?: unknown; unsure?: unknown } | undefined): boolean => {
    const out = processLine(st.job, r, instrument);
    if (out.measures.length === 0) return false;
    st.measures = out.measures;
    st.unsure = out.unsure;
    st.problems = out.problems;
    st.trace.snapped = [out.moved];
    st.trace.firstRead = out.measures;
    st.trace.firstProblems = out.problems;
    st.status = 'done';
    timings.lines_read++;
    return true;
  };

  const readGroup = async (group: LineState[], smaller = false): Promise<LineState[]> => {
    group.forEach((st) => (st.status = smaller || st.status === 'retrying' ? 'retrying' : 'reading'));
    report();
    const first = group[0].job;
    const images = await Promise.all(
      group.map(async (st) => ({ blob: smaller && opts.shrink ? await opts.shrink(st.job.crop) : st.job.crop, name: `line-${st.job.page}-${st.job.line}.jpg` })),
    );
    let res: ReaderResult;
    try {
      res = await request(
        { stage: 'reading', page: first.page, pages: pages.length, lines: first.lines, line: first.line, lineTo: group.length > 1 ? group[group.length - 1].job.line : undefined },
        { mode: 'line', images, fields: lineFields(group.map((g) => g.job)) },
        group.length,
      );
    } catch (e) {
      if (!(e instanceof OmrError)) throw e;
      group.forEach((st) => (st.error = e));
      return group;
    }
    const reply = (res.line ?? {}) as LineReply;
    warnings.push(...asArray<string>(reply.warnings));
    const replies = asArray<NonNullable<LineReply['lines']>[number]>(reply.lines);
    if (replies.length === 0 && reply.measures) replies.push({ line: first.line, measures: reply.measures, unsure: reply.unsure });
    const missed: LineState[] = [];
    group.forEach((st, k) => {
      const r = replies.find((x) => Number(x.line) === st.job.line) ?? (group.length === 1 ? replies[0] : replies[k]);
      if (!accept(st, r)) {
        st.error = new OmrError('unreadable', res.ref, 'no_measures');
        missed.push(st);
      }
    });
    report();
    return missed;
  };

  /** A failed request is tried once more, smaller: its lines one by one, or a lone line with a smaller picture. */
  const readWithRetry = async (group: LineState[]) => {
    const failed = await limit(() => readGroup(group));
    if (failed.length === 0) return;
    const retry = failed.filter((st) => !isFatal(st.error) && !fatal);
    await Promise.all(
      retry.map((st) =>
        limit(async () => {
          timings.retries++;
          st.status = 'retrying';
          await readGroup([st], group.length === 1);
        }),
      ),
    );
    for (const st of failed) if (st.status !== 'done') st.status = 'failed';
    report();
  };

  report();
  await Promise.all(pages.map((_, p) => chunks(all.filter((st) => st.job.page === p + 1), per)).flat().map((g) => readWithRetry(g)));
  for (const st of all) if (st.status !== 'done') st.status = 'failed';

  // Nothing read at all: there is nothing to show, so say why.
  if (!all.some((st) => st.status === 'done')) {
    if (fatal) throw fatal;
    const e = all.find((st) => st.error)?.error;
    throw e ?? new OmrError('unreadable', undefined, 'no_measures');
  }

  // 3. In order now: a key or time change on one line carries to the next, so re-check lines that started differently.
  let carried: { key?: number; time?: string; clef?: string } = { ...(all[0]?.job.ctx ?? {}) };
  for (const st of all) {
    if (st.status !== 'done') continue;
    const was = st.job.ctx;
    const now = { key: carried.key ?? was.key, time: carried.time ?? was.time, clef: carried.clef ?? was.clef };
    if (now.key !== was.key || now.time !== was.time) {
      st.job = { ...st.job, ctx: now };
      st.problems = checkLine(st.measures, { key: now.key, time: now.time, instrument, firstLine: st.job.firstOfPiece, lastLine: st.job.lastOfPiece, heads: st.job.heads });
    }
    carried = carryForward(st.measures, now);
  }

  // 4. Double-check rounds, several lines per request, several requests at once.
  // A check sends two pictures per line and makes the model think harder, so it takes half as many lines.
  const perCheck = Math.max(1, Math.ceil(per / 2));
  for (let round = 1; round <= rounds && !fatal; round++) {
    const pending = all.filter((st) => st.status === 'done' && st.pending && st.measures.length > 0);
    if (pending.length === 0) break;
    await Promise.all(chunks(pending, perCheck).map((group) => limit(() => checkGroup(group, round))));
  }

  async function checkGroup(group: LineState[], round: number) {
    const ready: { st: LineState; image: Blob }[] = [];
    for (const st of group) {
      const started = Date.now();
      try {
        if (!opts.render) throw new Error('no renderer');
        ready.push({ st, image: await opts.render(st.measures, { key: st.job.ctx.key, time: st.job.ctx.time, clef: st.job.ctx.clef, staves }) });
      } catch (e) {
        st.trace.checkSkipped = `couldn't engrave the line (${(e as Error).message})`;
        st.pending = false;
      } finally {
        timings.render_ms += Date.now() - started;
      }
    }
    if (ready.length === 0) return;
    const first = ready[0].st.job;
    let check: ReaderResult;
    try {
      check = await request(
        { stage: 'checking', page: first.page, pages: pages.length, lines: first.lines, round, line: first.line, lineTo: ready.length > 1 ? ready[ready.length - 1].st.job.line : undefined },
        {
          mode: 'check',
          images: ready.flatMap(({ st, image }) => [{ blob: st.job.crop, name: `line-${st.job.page}-${st.job.line}.jpg` }, { blob: image, name: `engraving-${st.job.page}-${st.job.line}.png` }]),
          fields: {
            page: first.page,
            pages: pages.length,
            line: first.line,
            lines: first.lines,
            line_numbers: JSON.stringify(ready.map((r) => r.st.job.line)),
            key: first.ctx.key,
            time: first.ctx.time,
            round,
            transcriptions: JSON.stringify(ready.map((r) => ({ measures: r.st.measures }))),
            problems: JSON.stringify(ready.map((r) => r.st.problems.map((x) => x.message))),
            hints: JSON.stringify(ready.map((r) => r.st.job.hint)),
          },
        },
        ready.length,
      );
    } catch (e) {
      // A double-check that fails keeps the first read (its bars still get the code checks' flags).
      if (!(e instanceof OmrError)) throw e;
      for (const { st } of ready) {
        st.trace.checkSkipped = `double-check failed (${e.code ?? e.kind})`;
        st.pending = false;
      }
      return;
    }
    const replies = asArray<CheckLine>(((check.check ?? {}) as CheckReply).lines);
    ready.forEach(({ st }, k) => {
      const c = replies.find((x) => Number(x.line) === st.job.line) ?? replies[k];
      const mismatches = asArray<CheckLine['mismatches'][number]>(c?.mismatches);
      if (c?.unsure) st.unsure = new Set(asArray<number>(c.unsure).map(Number));
      if (!c || mismatches.length === 0 || !c.measures) {
        st.trace.rounds.push({ mismatches, measures: st.measures, problems: st.problems, accepted: false });
        st.pending = false;
        return;
      }
      const firstBar = Number(st.measures.find((m) => !m.pickup)?.n ?? st.job.printedFirstBar ?? 1);
      let corrected = normaliseLine(asArray<RnMeasure>(c.measures), firstBar, st.job.firstOfPiece);
      if (st.job.firstOfPiece) corrected = markPickup(corrected, st.job.ctx.time);
      const snapped = snapToHeads(corrected, st.job.heads, st.job.ctx.key ?? 0);
      corrected = snapped.measures;
      st.trace.snapped?.push(snapped.moved);
      const newProblems = checkLine(corrected, { key: st.job.ctx.key, time: st.job.ctx.time, instrument, firstLine: st.job.firstOfPiece, lastLine: st.job.lastOfPiece, heads: st.job.heads });
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
    report();
  }

  // 5. Put the piece together, numbering bars in order (a correction may have changed a line's bar count).
  const entries: { m: RnMeasure; unsure: boolean; problems: BarProblem[] }[] = [];
  let n = 1;
  const lineBars: ReadResult['lineBars'] = [];
  const failed: FailedLine[] = [];
  for (const st of all) {
    st.trace.final = st.measures;
    if (st.status !== 'done') {
      timings.lines_failed++;
      failed.push({ page: st.job.page, line: st.job.line, at: entries.length, kind: st.error?.kind ?? 'unreadable', code: st.error?.code, ref: st.error?.ref, job: st.job });
      continue;
    }
    if (st.measures.length) lineBars.push({ page: st.job.page, line: st.job.line, from: entries.length, to: entries.length + st.measures.length - 1 });
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
  const { score } = pieceFrom([entries.map((x) => x.m)], overviews, staves, warnings);
  const flags: BarFlag[] = [];
  entries.forEach((x, index) => {
    const reasons = x.problems.map((p) => p.message);
    if (x.unsure) reasons.push(`The music reader wasn't sure about bar ${x.m.n}.`);
    if (reasons.length) flags.push({ index, n: Number(x.m.n), reasons });
  });
  let converted;
  try {
    converted = notationToMusicXml(score, partName(instrument));
  } catch (e) {
    if (e instanceof NotationError) throw new OmrError('unreadable', undefined, 'bad_notation');
    throw e;
  }
  timings.wait_ms = Math.round(pacer.waitedMs);
  timings.total_ms = Date.now() - t0 + timings.prep_ms;
  return {
    score,
    musicxml: converted.musicxml,
    warnings: score.warnings ?? [],
    flags,
    lineBars,
    failed,
    timings,
    trace: { overview: overviews, lines: all.map((st) => st.trace), provider },
  };
}

/** A whole piece from lines of bars (title, tempo and the first bar's key/time from the overviews). Pure. */
function pieceFrom(lines: RnMeasure[][], overviews: Overview[], staves: 1 | 2, warnings: string[]): { score: RnScore; ov0: Overview } {
  const ov0 = overviews.find((o) => o?.title || o?.composer || o?.tempo) ?? overviews[0] ?? {};
  const measures = lines.flat().map((m) => ({ ...m }));
  if (measures.length === 0) throw new OmrError('unreadable', undefined, 'no_measures');
  const firstKey = measures.find((m) => m.key !== undefined)?.key ?? overviews[0]?.key ?? 0;
  const firstTime = measures.find((m) => m.time)?.time ?? overviews[0]?.time ?? '4/4';
  measures[0] = { ...measures[0], key: measures[0].key ?? firstKey ?? 0, time: measures[0].time ?? firstTime, clef: measures[0].clef ?? overviews[0]?.clef ?? (staves === 2 ? 'treble' : undefined) };
  return {
    ov0,
    score: {
      title: ov0.title ?? undefined,
      composer: ov0.composer ?? undefined,
      tempo: ov0.tempo ?? null,
      staves,
      measures,
      warnings: [...new Set(warnings)].slice(0, 6),
    },
  };
}
