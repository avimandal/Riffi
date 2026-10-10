import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('../fixtures/musicxml/twinkle.musicxml', import.meta.url));

test('create a kid, import music, practise with the fake mic, see results saved', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: "Who's practising?" })).toBeVisible();

  // Create a profile.
  await page.getByTestId('add-kid').click();
  await page.getByLabel('Name').fill('Mia');
  await page.getByRole('button', { name: "Let's go!" }).click();
  await expect(page.getByRole('heading', { name: /Mia!/ })).toBeVisible();

  // Import a MusicXML file (bypassing photo reading).
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
  await expect(page.getByText('out of 100')).toBeVisible({ timeout: 20_000 });
  // A first run earns the "First song" badge (or similar): close any badge pop-ups.
  const badge = page.getByRole('dialog', { name: 'New badge!' });
  while (await badge.isVisible().catch(() => false)) await badge.getByRole('button', { name: 'OK' }).click();
  await expect(page.getByRole('button', { name: 'Play again' })).toBeVisible();
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText(/Best \d+/)).toBeVisible();
  await page.getByRole('link', { name: 'My progress' }).click();
  await expect(page.getByRole('heading', { name: 'My best scores' })).toBeVisible();
  await expect(page.getByText('Twinkle Twinkle')).toBeVisible();

  expect(errors).toEqual([]);
});

test('parent area is behind a gate', async ({ page }) => {
  await page.goto('/parent');
  await expect(page.getByRole('heading', { name: 'Grown-ups only' })).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
  const hold = page.getByTestId('parent-hold');
  const box = (await hold.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(3300);
  await page.mouse.up();
  const q = await page.getByText(/What is \d+ \+ \d+\?/).textContent();
  const [, a, b] = q!.match(/(\d+) \+ (\d+)/)!;
  await page.getByTestId('parent-answer').fill(String(Number(a) + Number(b)));
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByRole('tab', { name: 'Backup' })).toBeVisible();
});

test('privacy page is reachable without a profile', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible();
  await expect(page.getByText(/Australian Privacy Act/)).toBeVisible();
});
