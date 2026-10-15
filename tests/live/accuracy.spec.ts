/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareHands, compareScores, exactCounts, firstReadScore, formatReport, type AccuracyReport } from '../../src/sheet/accuracy';
import type { RnScore } from '../../src/sheet/notation';
import type { ReadResult } from '../../src/sheet/reader';

/**
 * Live accuracy run: every photo in tests/fixtures/sheets/ that has a
 * <name>.reference.json is read by the real pipeline (staff detection, line
 * crops and OSMD engravings in Chromium; the real api/omr.php; the real AI),
 * then scored against the reference, first read vs after the double-check.
 *
 * The API key comes only from the environment and goes only to the local PHP
 * server's environment; the config file written below reads it with getenv().
 * Every reply is recorded (no key, no images) so CI can replay the run.
 */

const root = fileURLToPath(new URL('../..', import.meta.url));
const sheets = join(root, 'tests/fixtures/sheets');
const outDir = process.env.RIFFI_LIVE_OUT ?? join(sheets, 'recordings');
const PORT = 8899;

const provider = process.env.RIFFI_PROVIDER ?? 'gemini';
/** Hard cap on requests that reach the AI (free-tier keys allow only a few a day). Over it, the app gets a quota error. */
const maxRequests = Number(process.env.RIFFI_MAX_REQUESTS ?? Infinity);
let aiRequests = 0;
const haveKey = provider === 'claude' ? !!process.env.ANTHROPIC_API_KEY : !!process.env.GEMINI_API_KEY;

let php: ChildProcess | null = null;

test.beforeAll(async () => {
  if (!haveKey) return;
  const tmp = mkdtempSync(join(tmpdir(), 'riffi-live-'));
  const cfg = join(tmp, 'config.php');
  writeFileSync(
    cfg,
    `<?php return [
  'PROVIDER' => '${provider}',
  'GEMINI_API_KEY' => (string) getenv('GEMINI_API_KEY'),
  'ANTHROPIC_API_KEY' => (string) getenv('ANTHROPIC_API_KEY'),
  'GEMINI_MODEL' => getenv('GEMINI_MODEL') ?: 'gemini-flash-latest',
  'GEMINI_API_URL' => getenv('GEMINI_API_URL') ?: 'https://generativelanguage.googleapis.com/v1beta',
  'GEMINI_THINKING' => getenv('GEMINI_THINKING') !== false ? getenv('GEMINI_THINKING') : 'low',
  'GEMINI_RPM' => (int) (getenv('GEMINI_RPM') ?: 8),
  'LINES_PER_REQUEST' => (int) (getenv('LINES_PER_REQUEST') ?: 3),
  'PARALLEL_REQUESTS' => (int) (getenv('PARALLEL_REQUESTS') ?: 3),
  'CHECK_ROUNDS' => getenv('CHECK_ROUNDS') !== false ? (int) getenv('CHECK_ROUNDS') : 2,
  'REQUEST_SECONDS' => (int) (getenv('REQUEST_SECONDS') ?: 60),
  'ALLOWED_ORIGIN' => 'http://localhost:5174',
  'RATE_LIMIT_DIR' => '${tmp}/rl',
  'LOG_FILE' => '${tmp}/omr.log',
];\n`,
  );
  php = spawn('php', ['-d', 'max_execution_time=0', '-S', `127.0.0.1:${PORT}`, '-t', join(root, 'api')], { env: { ...process.env, RIFFI_CONFIG: cfg }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 800));
  console.log(`PHP log: ${tmp}/omr.log`);
});

test.afterAll(() => {
  php?.kill();
});

const fixtures = readdirSync(sheets).filter((f) => /\.(webp|jpe?g|png)$/i.test(f) && existsSync(join(sheets, f.replace(/\.[^.]+$/, '.reference.json'))));

for (const file of fixtures) {
  test(`live accuracy: ${file}`, async ({ page }) => {
    test.skip(!haveKey, 'Set GEMINI_API_KEY (or RIFFI_PROVIDER=claude and ANTHROPIC_API_KEY) to run against the real reader.');
    const name = file.replace(/\.[^.]+$/, '');
    const ref = JSON.parse(readFileSync(join(sheets, `${name}.reference.json`), 'utf8')) as RnScore & { instrument?: string; uncertain?: number[] };
    const instrument = ref.instrument ?? 'violin';
    const recorded: { mode: string; page: number; line: number | null; round: number | null; body: string; ms?: number }[] = [];

    await page.route('**/__fixture/**', (route) => route.fulfill({ body: readFileSync(join(sheets, file)), contentType: 'image/webp' }));
    await page.route('**/api/omr.php**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const t0 = Date.now();
      if (req.method() === 'POST' && ++aiRequests > maxRequests) {
        console.log(`  (request budget of ${maxRequests} used up: refused without asking the AI)`);
        await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Request budget used up.', code: 'quota' }) });
        return;
      }
      const res = await route.fetch({ url: `http://127.0.0.1:${PORT}/omr.php${url.search}`, timeout: 150_000 });
      const body = await res.text();
      const ms = Date.now() - t0;
      if (req.method() === 'POST') {
        const form = req.postDataBuffer()?.toString('latin1') ?? '';
        const field = (k: string) => form.match(new RegExp(`name="${k.replace(/[[\]]/g, '\\$&')}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
        recorded.push({ mode: field('mode') ?? '', page: Number(field('page') ?? 1), line: field('line') ? Number(field('line')) : null, round: field('round') ? Number(field('round')) : null, body, ms });
        const last = body.trim().split('\n').pop() ?? '';
        console.log(`  ${field('mode')}${field('line') ? ` line ${field('line')}` : ''}${field('round') ? ` round ${field('round')}` : ''} (${(ms / 1000).toFixed(1)} s): ${last.slice(0, 160)}`);
      }
      await route.fulfill({ status: res.status(), headers: res.headers(), body });
    });
    page.on('console', (m) => m.type() === 'error' && console.log('browser:', m.text()));

    await page.goto('/');
    const started = Date.now();
    const result = (await page.evaluate(
      async ({ file, instrument }) => {
        // Served by the Vite dev server, so the page can import the pipeline directly.
        const path = '/src/sheet/readSheet.ts';
        const { readSheetMusic } = (await import(/* @vite-ignore */ path)) as typeof import('../../src/sheet/readSheet');
        const blob = await (await fetch(`/__fixture/${file}`)).blob();
        const r = await readSheetMusic([{ id: 'p1', file: blob, previewUrl: '', rotation: 0 }], instrument as 'violin');
        return { score: r.score, flags: r.flags, trace: r.trace, lines: r.pages.map((p) => p.lines.length), heads: r.pages.map((p) => p.heads ?? []), failed: r.failed.map((f) => ({ page: f.page, line: f.line, kind: f.kind, code: f.code })), timings: r.timings };
      },
      { file, instrument },
    )) as Pick<ReadResult, 'score' | 'flags' | 'trace' | 'timings'> & { lines: number[]; heads: unknown[]; failed: { page: number; line: number; kind: string; code?: string }[] };
    const seconds = Math.round((Date.now() - started) / 1000);

    const final = compareScores(result.score, ref);
    const first = compareScores(firstReadScore(result.score, result.trace.lines), ref);
    const summary = (r: AccuracyReport) => ({ pitch: r.pitch, rhythm: r.rhythm, lengths: r.lengths, key: r.key.ok, time: r.time.ok, pickup: r.pickup.ok, bars: r.barsFound });
    console.log(`\n${file} (${result.lines.join('+')} lines, ${recorded.length} requests, ${seconds} s)`);
    console.log(`lines read ${result.timings.lines_read}/${result.timings.lines}, failed: ${JSON.stringify(result.failed)}, retries ${result.timings.retries}, waited ${Math.round(result.timings.wait_ms / 1000)} s`);
    console.log(formatReport(first, 'FIRST READ: '));
    console.log(formatReport(final, 'AFTER CHECK: '));
    if (ref.staves === 2) {
      // Piano: each hand on its own (right = upper staff, left = lower staff).
      const hands = compareHands(result.score, ref);
      for (const [name, r] of [['Right hand', hands.right], ['Left hand', hands.left]] as const) {
        const c = exactCounts(r);
        console.log(`${name}: ${c.bars}/${c.of} bars exactly right, ${c.notes}/${c.notesOf} notes with the right pitch`);
      }
    }

    mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const model = provider === 'claude' ? (process.env.CLAUDE_MODEL ?? 'claude-default') : (process.env.GEMINI_MODEL ?? 'gemini-flash-latest');
    writeFileSync(
      join(outDir, `${name}.${model}.json`),
      JSON.stringify(
        {
          fixture: file,
          provider,
          model,
          date: stamp,
          instrument,
          lines: result.lines,
          heads: result.heads,
          seconds,
          responses: recorded,
          report: { first: summary(first), final: summary(final) },
          flags: result.flags,
        },
        null,
        1,
      ) + '\n',
    );
    writeFileSync(join(outDir, `${name}.${model}.md`), `# ${file}: ${model}, ${stamp}\n\n\`\`\`\n${formatReport(first, 'FIRST READ: ')}\n\n${formatReport(final, 'AFTER CHECK: ')}\n\`\`\`\n`);
    expect(result.score.measures.length).toBeGreaterThan(0);
  });
}
