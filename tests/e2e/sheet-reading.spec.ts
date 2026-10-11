/// <reference lib="dom" />
import { expect, test, type Page, type Request } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const photo = fileURLToPath(new URL('../fixtures/sheets/hermans-hornpipe.webp', import.meta.url));
interface Measure {
  n: number;
  s1: string;
  [k: string]: unknown;
}
const ref = JSON.parse(readFileSync(new URL('../fixtures/sheets/hermans-hornpipe.reference.json', import.meta.url), 'utf8')) as {
  lines: [number, number][];
  measures: Measure[];
};
const lineBars = (line: number) => ref.measures.filter((m) => m.n >= ref.lines[line - 1][0] && m.n <= ref.lines[line - 1][1]);

/** Fields and file parts out of a multipart body. */
function parseForm(req: Request) {
  const body = req.postDataBuffer()?.toString('latin1') ?? '';
  const fields: Record<string, string> = {};
  for (const m of body.matchAll(/name="([^"]+)"\r\n\r\n([^\r]*)\r\n/g)) fields[m[1]] = m[2];
  const files = [...body.matchAll(/name="pages\[\]"; filename="([^"]+)"\r\nContent-Type: ([^\r]+)\r\n\r\n/g)].map((m) => ({ name: m[1], type: m[2] }));
  const sizes = body.split(/--[-\w]+\r\n/).filter((p) => p.includes('name="pages[]"')).map((p) => p.length);
  return { fields, files, sizes };
}

/** Save the images sent (set RIFFI_SHOTS to a folder to look at what the reader sees). */
function saveParts(req: Request, prefix: string) {
  const dir = process.env.RIFFI_SHOTS;
  if (!dir) return;
  const body = req.postDataBuffer();
  if (!body) return;
  const text = body.toString('latin1');
  for (const m of text.matchAll(/filename="([^"]+)"\r\nContent-Type: [^\r]+\r\n\r\n/g)) {
    const start = m.index! + m[0].length;
    const end = text.indexOf('\r\n--', start);
    writeFileSync(`${dir}/${prefix}-${m[1]}`, body.subarray(start, end));
  }
}

const ndjson = (...lines: object[]) => ({ status: 200, contentType: 'application/x-ndjson', body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n' });

async function newKid(page: Page, name: string, instrument?: string) {
  await page.goto('/');
  await page.getByTestId('add-kid').click();
  await page.getByLabel('Name').fill(name);
  if (instrument) await page.getByRole('button', { name: instrument }).click();
  await page.getByRole('button', { name: "Let's go!" }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`${name}!`) })).toBeVisible();
}

test('reads a photographed page line by line, double-checks, and flags bars to look at', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const requests: ReturnType<typeof parseForm>[] = [];
  await page.route('**/api/omr.php**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ providers: ['gemini'], default: 'gemini', rpm: { gemini: 100 }, lines_per_request: 3 }) });
    const form = parseForm(req);
    requests.push(form);
    saveParts(req, `${requests.length}`);
    await new Promise((r) => setTimeout(r, 250));
    if (form.fields.mode === 'overview') {
      return route.fulfill(ndjson({ type: 'start', ref: 'ov0001' }, { type: 'result', overview: { title: "Herman's hornpipe", composer: "Mark O'Connor", key: 2, time: '4/4', pickup: true, pickup_notes: 'A5e', lines: 7 }, provider: 'gemini', ref: 'ov0001' }));
    }
    if (form.fields.mode === 'line') {
      const first = Number(form.fields.line);
      // Line 3 comes back with bar 8's ending as plain 16ths (one beat too long); the double-check fixes it.
      const lines = form.files.map((_, k) => {
        const line = first + k;
        const bars = lineBars(line);
        const measures = line === 3 ? bars.map((m) => (m.n === 8 ? { ...m, s1: m.s1.replace('3( C#5s D5s D#5s )', 'C#5s D5s D#5s') } : m)) : bars;
        return { line, measures, unsure: line === 7 ? [21] : [] };
      });
      return route.fulfill(ndjson({ type: 'start', ref: 'ln0001' }, { type: 'progress', bars: 2 }, { type: 'result', line: { lines }, ref: 'ln0001' }));
    }
    const sent = JSON.parse(form.fields.transcriptions) as { measures: Measure[] }[];
    const numbers = JSON.parse(form.fields.line_numbers) as number[];
    const lines = sent.map((t, k) => {
      const line = numbers[k];
      const bars = lineBars(line);
      const fixed = t.measures.every((m, i) => m.s1 === bars[i].s1);
      return fixed ? { line, mismatches: [], measures: null, unsure: line === 7 ? [21] : [] } : { line, mismatches: [{ bar: 8, what: 'triplet', detail: 'the last three notes are a triplet' }], measures: bars };
    });
    return route.fulfill(ndjson({ type: 'start', ref: 'ck0001' }, { type: 'result', check: { lines }, ref: 'ck0001' }));
  });

  await newKid(page, 'Ivy');
  await page.getByTestId('add-music').click();
  await page.getByTestId('photo-input').setInputFiles(photo);
  await page.getByRole('button', { name: 'Read my music' }).click();
  await expect(page.getByRole('heading', { name: /Reading lines \d–\d of 7/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: /Double-checking line/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Check the notes' })).toBeVisible({ timeout: 90_000 });

  // The browser found all seven lines on the real photo and sent each one as its own crop, three lines per request.
  const modes = requests.map((r) => `${r.fields.mode}${r.fields.line ?? ''}:${r.files.length}${r.fields.round ? `.r${r.fields.round}` : ''}`);
  expect(modes).toEqual(['overview:1', 'line1:3', 'line4:3', 'line7:1', 'check1:4.r1', 'check3:4.r1', 'check5:4.r1', 'check7:2.r1', 'check3:2.r2']);
  const second = requests[2];
  expect(second.fields).toMatchObject({ key: '2', time: '4/4', first_bar: '10', lines: '7' });
  expect(second.files).toEqual([
    { name: 'line-1-4.jpg', type: 'image/jpeg' },
    { name: 'line-1-5.jpg', type: 'image/jpeg' },
    { name: 'line-1-6.jpg', type: 'image/jpeg' },
  ]);
  // Note heads measured on the photo go along as hints (line 4 starts F#5 D5 A4 F#5 …).
  const hints = JSON.parse(second.fields.hints) as string[];
  expect(hints).toHaveLength(3);
  expect(hints[0]).toContain('F5 D5 A4 F5 E5 C5');
  // The double-check gets each line's photo then an engraving of our transcription.
  const check = requests[4];
  expect(check.files.slice(0, 2)).toEqual([
    { name: 'line-1-1.jpg', type: 'image/jpeg' },
    { name: 'engraving-1-1.png', type: 'image/png' },
  ]);
  expect(check.sizes[1]).toBeGreaterThan(4000);
  // Bar 8's beat problem went to the double-check, and only line 3 got a second look.
  const c3 = requests.find((r) => r.fields.mode === 'check' && r.fields.line === '3')!;
  expect(c3.fields.problems).toContain('Bar 8 adds up to 4.25 beats');
  expect(JSON.parse(requests[8].fields.line_numbers)).toEqual([3]);

  // Review: bar 21 (the reader wasn't sure) is listed and outlined on the music.
  await expect(page.getByTestId('flag-list')).toContainText('Bar 21');
  await expect(page.getByTestId('flag-list')).not.toContainText('Bar 8');
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-rendered', 'true');
  await expect(page.getByTestId('bar-flag')).toHaveCount(1);
  await page.getByRole('button', { name: 'Bar 21' }).click();
  await expect(page.getByText(/Selected:/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("the instrument defaults to the kid's own, even after a reload", async ({ page }) => {
  await newKid(page, 'Max', 'Singing');
  await page.getByTestId('add-music').click();
  await expect(page.getByRole('button', { name: 'Singing' })).toHaveAttribute('aria-pressed', 'true');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Singing' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Piano' })).toHaveAttribute('aria-pressed', 'false');
});
