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
  // A stand-in Screen Wake Lock that records what the app asks for.
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { wakeLog: string[] }).wakeLog = log;
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: {
        request: async () => {
          log.push('request');
          const sentinel = { released: false, release: async () => { sentinel.released = true; log.push('release'); } };
          (window as unknown as { wakeSentinel: typeof sentinel }).wakeSentinel = sentinel;
          return sentinel;
        },
      },
    });
  });
  const wakeLog = () => page.evaluate(() => (window as unknown as { wakeLog: string[] }).wakeLog.join(','));
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

  // No player switcher at the top of Tools: the whole device, Start included, fits on a phone.
  await expect(page.getByTestId('switch-player')).toHaveCount(0);
  await expect(page.getByTestId('metronome-start')).toBeInViewport({ ratio: 1 });

  // Accent: a button on the device, shown on the LCD, the same setting as the Menu's.
  const accent = page.getByTestId('accent');
  await expect(accent).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('lcd-accent')).toHaveText('>');
  await accent.click();
  await expect(accent).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('lcd-accent')).toHaveCount(0);
  await page.getByTestId('menu').click();
  await expect(page.getByRole('checkbox', { name: 'Accent beat 1' })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Accent beat 1' }).check();
  await expect(accent).toHaveAttribute('aria-pressed', 'true');
  await accent.click();
  await page.getByTestId('menu').click();
  // Remembered for this kid (saved, and loaded again when Tools opens).
  await page.waitForTimeout(500);
  await page.getByRole('link', { name: 'Home' }).click();
  await page.getByRole('link', { name: 'Tools' }).click();
  await expect(page.getByTestId('accent')).toHaveAttribute('aria-pressed', 'false', { timeout: 10_000 });
  await page.getByTestId('accent').click();
  await expect(page.getByTestId('accent')).toHaveAttribute('aria-pressed', 'true');

  // The screen stays awake while it clicks, and lets go when it stops.
  expect(await wakeLog()).toBe('');
  await page.getByTestId('metronome-start').click();
  await expect.poll(wakeLog).toBe('request');
  // The browser dropped the lock while the app was hidden: back in front, it asks again.
  await page.evaluate(() => {
    (window as unknown as { wakeSentinel: { released: boolean } }).wakeSentinel.released = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(wakeLog).toBe('request,request');
  await page.getByTestId('metronome-start').click();
  await expect.poll(wakeLog).toBe('request,request,release');

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
