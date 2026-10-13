import { expect, test, type Page } from '@playwright/test';

async function newKid(page: Page) {
  await page.goto('/');
  await page.getByTestId('add-kid').click();
  await page.getByLabel('Name').fill('Leo');
  await page.getByRole('button', { name: "Let's go!" }).click();
  await expect(page.getByTestId('switch-player')).toContainText('Leo!');
}

test('Tuner & Metronome: metronome, counting practice, and tuner', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await newKid(page);

  // Open it from Home, no sheet music needed.
  await page.getByRole('link', { name: 'Tools' }).click();
  await expect(page.getByRole('heading', { name: 'Tuner & Metronome' })).toBeVisible();
  const lcd = page.getByTestId('lcd');
  await expect(lcd).toContainText('METRONOME');
  await expect(page.getByTestId('tempo-name')).toHaveText('Andante');

  // Tempo up by keyboard (Enter fires once per press).
  const up = page.getByTestId('tempo-up');
  for (let i = 0; i < 10; i++) {
    await up.focus();
    await page.keyboard.press('Enter');
  }
  await expect(page.getByText('110 BPM, Moderato, 4/4, Woodblock')).toBeAttached();
  await page.getByRole('button', { name: /Time signature: 4\/4/ }).click();
  await expect(lcd).toContainText('5/4');

  // Count my practice: the fake microphone plays a violin melody.
  await page.getByTestId('menu').click();
  await page.getByTestId('count-practice').check();
  await page.getByTestId('metronome-start').click();
  await expect(lcd).toContainText('REC');
  await page.waitForTimeout(12_000);
  await page.getByTestId('metronome-start').click();
  await expect(page.getByRole('status').filter({ hasText: /added to your practice/ })).toBeVisible({ timeout: 10_000 });

  // Tuner hears the violin and names the note.
  await page.getByTestId('mode').click();
  await expect(lcd).toContainText('TUNER');
  await expect(page.getByRole('img', { name: /Lights: (Flat|In tune|Sharp)/ })).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('tone').click();
  await expect(lcd).toContainText('REF A');

  // The counted minutes show up in the practice log (parent summary).
  expect(errors).toEqual([]);
});
