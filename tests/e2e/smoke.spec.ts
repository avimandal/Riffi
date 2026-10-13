import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

// MuseScore's default export format (compressed .mxl), so the browser unzip path is covered too.
const fixture = fileURLToPath(new URL('../fixtures/musicxml/twinkle.mxl', import.meta.url));

test('create a kid, import music, practise with the fake mic, see results saved', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: "Who's practising?" })).toBeVisible();

  // Create a profile.
  await page.getByTestId('add-kid').click();
  await page.getByLabel('Name').fill('Mia');
  await page.getByRole('button', { name: "Let's go!" }).click();
  await expect(page.getByTestId('switch-player')).toContainText('Mia!');

  // Import a compressed MusicXML (.mxl) file (bypassing photo reading).
  await page.getByTestId('add-music').click();
  await page.getByTestId('musicxml-input').setInputFiles(fixture);
  await expect(page.getByRole('heading', { name: 'Check the notes' })).toBeVisible();
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-rendered', 'true', { timeout: 20_000 });

  // Tap-to-fix: select a note and nudge it up and back down.
  const sheet = page.getByTestId('sheet');
  const head = sheet.locator('.vf-notehead').first();
  await head.click();
  await expect(page.getByText(/Selected:/)).toBeVisible();
  await page.getByRole('button', { name: 'Higher' }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByTestId('looks-good').click();

  // Practice screen.
  await expect(page.getByTestId('start-stop')).toBeVisible();
  await expect(page.getByTestId('sheet')).toHaveAttribute('data-rendered', 'true', { timeout: 20_000 });
  await page.getByTestId('start-stop').click();
  // First run offers a sound check; skip it for the test.
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByTestId('start-stop')).toHaveAccessibleName('Stop', { timeout: 15_000 });
  await expect(page.getByRole('meter')).toBeVisible();
  await page.waitForTimeout(9_000);
  await page.getByTestId('start-stop').click();

  // Results are shown and saved.
  await expect(page.getByText(/^Score: \d+ out of 100$/)).toBeAttached({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: 'Things to try next' })).toBeVisible();
  // A first run earns the "First song" badge (or similar): close any badge pop-ups.
  const badge = page.getByRole('dialog', { name: 'New badge!' });
  while (await badge.isVisible().catch(() => false)) await badge.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByRole('button', { name: 'Play again' })).toBeVisible();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText(/Best \d+/)).toBeVisible();
  // The … menu on the card: edit the saved music (no changes, so Cancel just goes back).
  await page.getByTestId('piece-more').click();
  await expect(page.getByTestId('download-music')).toBeVisible();
  await page.getByTestId('edit-music').click();
  await expect(page.getByRole('heading', { name: 'Edit music' })).toBeVisible();
  await page.getByTestId('cancel-edit').click();
  await expect(page.getByText(/Best \d+/)).toBeVisible();
  await page.getByRole('link', { name: 'My progress' }).click();
  await expect(page.getByRole('heading', { name: 'My best scores' })).toBeVisible();
  await expect(page.getByText('Twinkle Twinkle')).toBeVisible();

  expect(errors).toEqual([]);
});

test('Settings: no gate, a site-wide music reader behind the admin password, and "Are you sure?" before deleting', async ({ page }) => {
  let saved = 'gemini';
  let tries = 0;
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/omr.php**', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return route.fulfill(json({ providers: ['gemini', 'claude'], provider: saved, can_change: true, rpm: { gemini: 8, claude: 40 }, lines_per_request: 8, check_rounds: 0 }));
    const body = req.postData() ?? '';
    const password = body.match(/name="password"\r\n\r\n([^\r]*)/)?.[1];
    const provider = body.match(/name="provider"\r\n\r\n([^\r]*)/)?.[1];
    if (password !== 'open sesame') {
      tries++;
      return route.fulfill(tries >= 2 ? json({ code: 'locked', retry_after: 840 }, 429) : json({ code: 'wrong_password', attempts_left: 5 - tries }, 403));
    }
    if (provider) saved = provider;
    return route.fulfill(json({ ok: true, provider: saved, providers: ['gemini', 'claude'] }));
  });

  // The old address still works, and there is no gate.
  await page.goto('/parent');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'App' }).click();
  await expect(page.getByTestId('reader-now')).toHaveText('Music reader: Gemini (free)');
  await expect(page.getByText('Compare music readers')).toHaveCount(0);

  // A wrong password, then a lockout with a friendly message.
  await page.getByTestId('reader-change').click();
  await page.getByTestId('admin-password').fill('guess');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('alert')).toHaveText(/That password isn't right. 4 tries left./);
  await page.getByTestId('admin-password').fill('guess again');
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('alert')).toHaveText(/Too many tries. Have a break and try again in 14 minutes./);
  await expect(page.getByTestId('admin-password')).toBeDisabled();
  await page.getByRole('button', { name: 'Close' }).click();

  // The right password shows the readers with a key; choosing one saves it for the whole site.
  tries = 0;
  await page.getByTestId('reader-change').click();
  await page.getByTestId('admin-password').fill('open sesame');
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByRole('button', { name: 'Claude (paid)' }).click();
  await expect(page.getByTestId('reader-now')).toHaveText('Music reader: Claude (paid)');
  await expect(page.getByText('Saved. New photos are now read by Claude (paid).')).toBeVisible();
  expect(saved).toBe('claude');

  // Deleting everything asks first; "No, keep it" keeps it.
  await page.getByRole('tab', { name: 'Backup' }).click();
  await page.getByTestId('delete-everything').click();
  const dialog = page.getByRole('dialog', { name: 'Are you sure?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'No, keep it' })).toBeFocused();
  await dialog.getByRole('button', { name: 'No, keep it' }).click();
  await expect(dialog).toHaveCount(0);
});

test('bottom navigation and switching player from the top bar', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('add-kid').click();
  await page.getByLabel('Name').fill('Ari');
  await page.getByRole('button', { name: "Let's go!" }).click();
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link')).toHaveText([/Home$/, /My progress$/, /Tools$/, /Settings$/]);
  await expect(page.getByText('Tuner & Metronome')).toHaveCount(0);
  for (const [tab, heading] of [
    ['Tools', 'Tuner & Metronome'],
    ['Settings', 'Settings'],
    ['My progress', 'My progress'],
  ]) {
    await nav.getByRole('link', { name: tab }).click();
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    const sw = page.getByRole('button', { name: 'Switch player' });
    await expect(sw).toContainText('Ari!');
    expect((await sw.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  }
  await page.getByRole('button', { name: 'Switch player' }).click();
  await expect(page.getByRole('heading', { name: "Who's practising?" })).toBeVisible();
});

test('privacy page is reachable without a profile', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible();
  await expect(page.getByText(/Australian Privacy Act/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Google Gemini free tier' })).toBeVisible();
  await expect(page.getByText(/Google may use the photos sent to it to improve/)).toBeVisible();
});
