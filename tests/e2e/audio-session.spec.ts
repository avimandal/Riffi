import { expect, test, type Page } from '@playwright/test';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1';

async function newKid(page: Page) {
  await page.goto('/');
  await page.getByTestId('add-kid').click();
  await page.getByLabel('Name').fill('Zoe');
  await page.getByRole('button', { name: "Let's go!" }).click();
  await expect(page.getByRole('heading', { name: /Zoe!/ })).toBeVisible();
}

test.describe('older iPhone (no navigator.audioSession)', () => {
  test.use({ userAgent: IPHONE, viewport: { width: 390, height: 844 }, hasTouch: true });

  test('metronome start plays the silent loop, and the browser can decode it', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    // Record every media element play() and how it ended.
    await page.addInitScript(() => {
      const w = window as unknown as { riffiPlays: string[] };
      w.riffiPlays = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        const p = play.call(this);
        p.then(
          () => w.riffiPlays.push(`ok loop=${this.loop}`),
          (e: Error) => w.riffiPlays.push(`error ${e.name}`),
        );
        return p;
      };
    });
    await newKid(page);
    await page.getByTestId('open-gadget').click();
    await page.getByTestId('metronome-start').click();
    await expect(page.getByTestId('lcd')).toContainText('BPM');
    await expect.poll(() => page.evaluate(() => (window as unknown as { riffiPlays: string[] }).riffiPlays)).toContain('ok loop=true');
    await page.getByTestId('metronome-start').click();
    expect(errors).toEqual([]);
  });
});

test('where navigator.audioSession exists: playback, then play-and-record while the mic listens', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { riffiTypes: string[] };
    w.riffiTypes = [];
    let type = 'auto';
    Object.defineProperty(navigator, 'audioSession', {
      value: {
        get type() {
          return type;
        },
        set type(v: string) {
          type = v;
          w.riffiTypes.push(v);
        },
      },
    });
  });
  await newKid(page);
  await page.getByTestId('open-gadget').click();
  await page.getByTestId('metronome-start').click();
  const types = () => page.evaluate(() => (window as unknown as { riffiTypes: string[] }).riffiTypes);
  await expect.poll(types).toEqual(['playback']);
  await page.getByTestId('metronome-start').click();

  // Tuner opens the mic: play-and-record first, then back to playback when it closes.
  await page.getByTestId('mode').click();
  await expect(page.getByTestId('lcd')).toContainText('TUNER');
  await expect.poll(types).toContain('play-and-record');
  await page.getByTestId('mode').click();
  await expect.poll(async () => (await types()).at(-1)).toBe('playback');
});
