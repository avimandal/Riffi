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
  await expect(page.getByTestId('switch-player')).toContainText(`${name}!`);
}

test('reads a photographed page line by line, double-checks, and flags bars to look at', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const requests: ReturnType<typeof parseForm>[] = [];
  const timings: string[] = [];
  await page.route('**/api/omr.php**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ providers: ['gemini'], default: 'gemini', rpm: { gemini: 100 }, lines_per_request: 3, check_rounds: 2, parallel: 3 }) });
    if (req.url().includes('timings=1')) {
      timings.push(parseForm(req).fields.timings);
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    }
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
  // Progress headings can be on screen for well under a second, so record every one shown.
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { riffiSeen: string[] }).riffiSeen = seen;
    new MutationObserver(() => document.querySelectorAll('h2, .live-progress').forEach((h) => seen.push(h.textContent ?? ''))).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByRole('button', { name: 'Read my music' }).click();
  await expect(page.getByRole('heading', { name: 'Check the notes' })).toBeVisible({ timeout: 90_000 });
  const seen = await page.evaluate(() => (window as unknown as { riffiSeen: string[] }).riffiSeen);
  expect(seen.some((h) => /Reading lines \d–\d of 7/.test(h))).toBe(true);
  expect(seen.some((h) => /Double-checking line/.test(h))).toBe(true);

  // The browser found all seven lines on the real photo and sent each one as its own crop, three lines per request.
  const modes = requests.map((r) => `${r.fields.mode}${r.fields.line ?? ''}:${r.files.length}${r.fields.round ? `.r${r.fields.round}` : ''}`);
  // Requests go out in parallel, so they can finish in any order.
  expect([...modes].sort()).toEqual(['check1:4.r1', 'check3:2.r2', 'check3:4.r1', 'check5:4.r1', 'check7:2.r1', 'line1:3', 'line4:3', 'line7:1', 'overview:1']);
  const second = requests.find((r) => r.fields.mode === 'line' && r.fields.line === '4')!;
  // Read at the same time as line 1, so it goes with the overview's key and time (and no guessed bar number).
  expect(second.fields).toMatchObject({ key: '2', time: '4/4', lines: '7' });
  expect(second.fields.first_bar).toBeUndefined();
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
  expect(JSON.parse(requests.find((r) => r.fields.round === '2')!.fields.line_numbers)).toEqual([3]);

  // Review: bar 21 (the reader wasn't sure) is listed and outlined on the music.
  await expect(page.getByTestId('flag-list')).toContainText('Bar 21');
  await expect(page.getByTestId('flag-list')).not.toContainText('Bar 8');
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-rendered', 'true');
  await expect(page.getByTestId('bar-flag')).toHaveCount(1);
  await page.getByRole('button', { name: 'Bar 21' }).click();
  await expect(page.getByText(/Selected:/)).toBeVisible();
  // The line of the photo that bar came from sits right by the editing tools, and the reader is named.
  await expect(page.getByTestId('bar-photo')).toContainText('Your photo, bar 21');
  await expect(page.getByTestId('bar-photo').getByRole('img')).toBeVisible();
  await expect(page.getByTestId('reader-used')).toHaveText(/Read by Gemini \(free\)/);
  await page.getByTestId('looks-good').click();
  await expect(page.getByTestId('start-stop')).toBeVisible();

  // Later: edit it from the Practice screen's menu. The photos are still there.
  await page.getByTestId('practice-more').click();
  await page.getByTestId('edit-music').click();
  await expect(page.getByRole('heading', { name: 'Edit music' })).toBeVisible();
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-rendered', 'true', { timeout: 20_000 });
  await expect(page.getByTestId('reader-used')).toBeVisible();
  await page.getByTestId('sheet').locator('.vf-notehead').nth(5).click();
  await expect(page.getByTestId('bar-photo')).toContainText(/Your photo, bar \d+/);
  if (process.env.RIFFI_SHOTS) await page.screenshot({ path: `${process.env.RIFFI_SHOTS}/edit-music.png`, fullPage: true });
  await page.getByRole('button', { name: 'Higher' }).click();
  // Cancel with an unsaved change asks first.
  await page.getByTestId('cancel-edit').click();
  const leave = page.getByRole('dialog', { name: 'Leave without saving?' });
  await leave.getByRole('button', { name: 'Keep editing' }).click();
  await page.getByLabel('Title').fill('Hermans hornpipe (fixed)');
  await page.getByTestId('looks-good').click();
  await expect(page.getByRole('heading', { name: 'Hermans hornpipe (fixed)' })).toBeVisible();

  // Download the music file, and open it again through Add music.
  await page.getByTestId('practice-more').click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('download-music').click()]);
  expect(download.suggestedFilename()).toBe('Hermans-hornpipe-fixed.musicxml');
  const file = test.info().outputPath('downloaded.musicxml');
  await download.saveAs(file);
  await page.goto('/add');
  await page.getByTestId('musicxml-input').setInputFiles(file);
  await expect(page.getByRole('heading', { name: 'Check the notes' })).toBeVisible();
  await expect(page.getByLabel('Title')).toHaveValue('Hermans hornpipe (fixed)');
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-rendered', 'true', { timeout: 20_000 });
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

test('piano: each grand staff (both hands, both in treble clef) is one line, read together; either hand can be fixed', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const piano = JSON.parse(readFileSync(new URL('../fixtures/sheets/piano-allegro.reference.json', import.meta.url), 'utf8')) as { lines: [number, number][]; measures: Measure[] };
  const pianoLine = (line: number) => piano.measures.filter((m) => m.n >= piano.lines[line - 1][0] && m.n <= piano.lines[line - 1][1]);
  const requests: ReturnType<typeof parseForm>[] = [];
  await page.route('**/api/omr.php**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ providers: ['gemini'], provider: 'gemini', rpm: { gemini: 100 }, lines_per_request: 4, check_rounds: 0, parallel: 2, request_seconds: 60 }) });
    if (req.url().includes('timings=1')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    const form = parseForm(req);
    requests.push(form);
    saveParts(req, `piano-${requests.length}`);
    if (form.fields.mode === 'overview') {
      return route.fulfill(ndjson({ type: 'result', overview: { title: 'Allegro', key: 0, time: '4/4', clef: 'treble', clef2: 'treble', staves: 2, lines: 3 }, provider: 'gemini', ref: 'pn0001' }));
    }
    const first = Number(form.fields.line);
    const lines = form.files.map((_, k) => ({ line: first + k, measures: pianoLine(first + k), unsure: [] }));
    return route.fulfill(ndjson({ type: 'result', line: { lines }, provider: 'gemini', ref: 'pn0002' }));
  });

  // A violin player's profile: the page itself shows it's piano music.
  await newKid(page, 'Pia');
  await page.getByTestId('add-music').click();
  await page.getByTestId('photo-input').setInputFiles(fileURLToPath(new URL('../fixtures/sheets/piano-allegro.webp', import.meta.url)));
  await page.getByRole('button', { name: 'Read my music' }).click();
  await expect(page.getByRole('heading', { name: 'Check the notes' })).toBeVisible({ timeout: 90_000 });

  // The real photo: three systems found, each sent as ONE picture marked as two staves.
  const lineReqs = requests.filter((r) => r.fields.mode === 'line');
  expect(lineReqs.flatMap((r) => r.files.map((f) => f.name))).toEqual(['line-1-1.jpg', 'line-1-2.jpg', 'line-1-3.jpg']);
  expect(lineReqs.every((r) => r.fields.staves === '2' && r.fields.clef2 === 'treble')).toBe(true);
  // The lower staff's measured heads are named in treble clef (bar 4's left hand: G3 E4 C4 E4 G3 D4 B3 D4).
  expect(JSON.parse(lineReqs[0].fields.hints)[0]).toMatch(/lower staff: .*G3 E4 C4 E4 G3 D4 B3 D4/);

  // A grand staff on screen: two staves per system.
  const sheet = page.getByTestId('sheet');
  await expect(sheet).toHaveAttribute('data-rendered', 'true', { timeout: 20_000 });
  await expect(page.getByTestId('failed-lines')).toHaveCount(0);

  // Fix a left-hand note: the first note on the lower staff (C4) goes up to D4.
  const box = await page.evaluate(() => {
    // Note heads in bands down the page: system 1's right hand, then its left hand, …
    const heads = [...document.querySelectorAll('[data-testid="sheet"] .vf-notehead')].map((h) => h.getBoundingClientRect()).filter((r) => r.width > 0);
    const ys = heads.map((r) => r.top + r.height / 2).sort((a, b) => a - b);
    const bands: number[][] = [];
    for (const y of ys) {
      const band = bands[bands.length - 1];
      if (band && y - band[band.length - 1] < 25) band.push(y);
      else bands.push([y]);
    }
    const lower = bands[1];
    if (!lower) return null;
    const inLower = heads.filter((r) => r.top + r.height / 2 >= lower[0] && r.top + r.height / 2 <= lower[lower.length - 1]).sort((a, b) => a.left - b.left);
    const all = [...document.querySelectorAll('[data-testid="sheet"] .vf-notehead')];
    return all.findIndex((h) => {
      const r = h.getBoundingClientRect();
      return r.left === inLower[0].left && r.top === inLower[0].top;
    });
  });
  expect(box).toBeGreaterThanOrEqual(0);
  await sheet.locator('.vf-notehead').nth(box!).click();
  if (process.env.RIFFI_SHOTS) await page.screenshot({ path: `${process.env.RIFFI_SHOTS}/piano-review.png`, fullPage: true });
  await expect(page.getByText('Selected: C4')).toBeVisible();
  // A semitone at a time: C4 → C♯4 → D4.
  await page.getByRole('button', { name: 'Higher' }).click();
  await expect(page.getByText('Selected: C♯4')).toBeVisible();
  await page.getByRole('button', { name: 'Higher' }).click();
  await expect(page.getByText('Selected: D4')).toBeVisible();
  await page.getByTestId('looks-good').click();
  await expect(page.getByTestId('start-stop')).toBeVisible();

  const xml = await page.evaluate(
    () =>
      new Promise<string>((done) => {
        const open = indexedDB.open('riffi');
        open.onsuccess = () => {
          const all = open.result.transaction('pieces').objectStore('pieces').getAll();
          all.onsuccess = () => done((all.result[0] as { musicxml: string }).musicxml);
        };
      }),
  );
  expect((xml.match(/<measure /g) ?? []).length).toBe(16);
  expect(xml).toContain('<staves>2</staves>');
  expect((xml.match(/<backup>/g) ?? []).length).toBe(16);
  const leftNotes = [...xml.matchAll(/<note>((?:(?!<\/note>).)*?)<\/note>/gs)].map((m) => m[1]).filter((n) => n.includes('<staff>2</staff>'));
  // Every left-hand note is as written (snapping to the measured heads moved nothing wrongly), but the one fixed.
  const pitch = (n: string) => `${n.match(/<step>(\w)<\/step>/)?.[1]}${n.match(/<octave>(\d)<\/octave>/)?.[1]}`;
  const want = piano.measures.flatMap((m) => String(m.s2).split(' ').map((t) => t.replace(/[whqest].*$/, '')));
  want[0] = 'D4';
  expect(leftNotes.filter((n) => !n.includes('<rest')).map(pitch)).toEqual(want);
  const rightNotes = [...xml.matchAll(/<note>((?:(?!<\/note>).)*?)<\/note>/gs)].map((m) => m[1]).filter((n) => n.includes('<staff>1</staff>') && !n.includes('<rest'));
  expect(rightNotes.map(pitch)).toEqual(piano.measures.flatMap((m) => String(m.s1).split(' ').map((t) => t.replace(/[whqest].*$/, ''))));
  expect(errors).toEqual([]);
});

test("the free tier's daily limit mid-read: what was read is kept, the limit is said plainly, and nothing is retried", async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const asked: string[] = [];
  await page.route('**/api/omr.php**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ providers: ['gemini'], provider: 'gemini', rpm: { gemini: 100 }, lines_per_request: 1, check_rounds: 0, parallel: 1, request_seconds: 60 }) });
    if (req.url().includes('timings=1')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    const form = parseForm(req);
    asked.push(`${form.fields.mode}${form.fields.line ?? ''}`);
    if (form.fields.mode === 'overview') {
      return route.fulfill(ndjson({ type: 'start', ref: 'ov0003' }, { type: 'result', overview: { title: "Herman's hornpipe", key: 2, time: '4/4', pickup: true, pickup_notes: 'A5e', lines: 7 }, provider: 'gemini', ref: 'ov0003' }));
    }
    const first = Number(form.fields.line);
    // The day's free reading runs out after line 3.
    if (first > 3) return route.fulfill(ndjson({ type: 'start', ref: 'qq0004' }, { type: 'error', code: 'quota', message: "The music reader has used up today's free reading.", ref: 'qq0004' }));
    return route.fulfill(ndjson({ type: 'start', ref: 'ln0003' }, { type: 'result', line: { lines: [{ line: first, measures: lineBars(first), unsure: [] }] }, provider: 'gemini', ref: 'ln0003' }));
  });

  await newKid(page, 'Ada');
  await page.getByTestId('add-music').click();
  await page.getByTestId('photo-input').setInputFiles(photo);
  await page.getByRole('button', { name: 'Read my music' }).click();
  await expect(page.getByRole('heading', { name: 'Check the notes' })).toBeVisible({ timeout: 90_000 });
  const panel = page.getByTestId('failed-lines');
  await expect(panel).toContainText("4 lines couldn't be read");
  await expect(panel.getByTestId('daily-limit')).toContainText("used up today's free reading");
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-rendered', 'true', { timeout: 20_000 });
  // One try per line up to the limit, then nothing more: no retries.
  expect(asked).toEqual(['overview', 'line1', 'line2', 'line3', 'line4']);
  expect(errors).toEqual([]);
});

test('a line that times out never sinks the page: the rest is kept, and the missing lines can be read again', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let fixed = false;
  await page.route('**/api/omr.php**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ providers: ['gemini'], provider: 'gemini', rpm: { gemini: 100 }, lines_per_request: 3, check_rounds: 0, parallel: 3, request_seconds: 60 }) });
    if (req.url().includes('timings=1')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
    const form = parseForm(req);
    if (form.fields.mode === 'overview') {
      return route.fulfill(ndjson({ type: 'start', ref: 'ov0002' }, { type: 'result', overview: { title: "Herman's hornpipe", key: 2, time: '4/4', pickup: true, pickup_notes: 'A5e', lines: 7 }, provider: 'gemini', ref: 'ov0002' }));
    }
    // Lines 3 and 5 time out (alone or with others) until the server is "fixed".
    const names = form.files.map((f) => f.name);
    if (!fixed && names.some((n) => n === 'line-1-3.jpg' || n === 'line-1-5.jpg')) {
      return route.fulfill(ndjson({ type: 'start', ref: '4f5f60' }, { type: 'ping' }, { type: 'error', code: 'timeout', message: 'That page took too long to read.', ref: '4f5f60' }));
    }
    const first = Number(form.fields.line);
    const lines = form.files.map((_, k) => ({ line: first + k, measures: lineBars(first + k), unsure: [] }));
    return route.fulfill(ndjson({ type: 'start', ref: 'ln0002' }, { type: 'result', line: { lines }, provider: 'gemini', ref: 'ln0002' }));
  });

  await newKid(page, 'Kai');
  await page.getByTestId('add-music').click();
  await page.getByTestId('photo-input').setInputFiles(photo);
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { riffiSeen: string[] }).riffiSeen = seen;
    new MutationObserver(() => document.querySelectorAll('[data-status] > span:last-child').forEach((h) => seen.push(h.textContent ?? ''))).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  });
  await page.getByRole('button', { name: 'Read my music' }).click();
  await expect(page.getByRole('heading', { name: 'Check the notes' })).toBeVisible({ timeout: 90_000 });
  // While reading, each line's progress showed, and lines 3 and 5 were marked.
  const seen = await page.evaluate(() => (window as unknown as { riffiSeen: string[] }).riffiSeen);
  expect(seen).toContain('Line 1: Done');
  expect(seen).toContain("Line 3: Couldn't read");

  // The rest of the page is there; the two missing lines are listed with their photo.
  const panel = page.getByTestId('failed-lines');
  await expect(panel).toContainText("2 lines couldn't be read");
  if (process.env.RIFFI_SHOTS) await page.screenshot({ path: `${process.env.RIFFI_SHOTS}/failed-lines.png`, fullPage: true });
  await expect(panel.getByRole('img')).toHaveCount(2);
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-rendered', 'true', { timeout: 20_000 });
  const bars = () => page.evaluate(() => document.querySelectorAll('[data-testid="sheet"] .vf-stavenote').length);
  const before = await bars();

  // Still failing: it says so and keeps the button.
  await panel.getByTestId('read-again').first().click();
  await expect(panel.getByRole('alert')).toContainText("Still couldn't read it");
  // Fixed: "Retry all failed lines" puts both lines back in place.
  fixed = true;
  await panel.getByTestId('retry-all').click();
  await expect(panel).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(bars).toBeGreaterThan(before);
  await page.getByTestId('looks-good').click();
  await expect(page.getByTestId('start-stop')).toBeVisible();
  const measures = await page.evaluate(
    () =>
      new Promise<number>((done) => {
        const open = indexedDB.open('riffi');
        open.onsuccess = () => {
          const all = open.result.transaction('pieces').objectStore('pieces').getAll();
          all.onsuccess = () => done(((all.result[0] as { musicxml: string }).musicxml.match(/<measure /g) ?? []).length);
        };
      }),
  );
  expect(measures).toBe(22);
  expect(errors).toEqual([]);
});
