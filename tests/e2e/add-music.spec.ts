/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const photo = fileURLToPath(new URL('../fixtures/sheets/hermans-hornpipe.webp', import.meta.url));
const shots = process.env.RIFFI_SHOTS; // set to a folder to save screenshots for a look

async function openAddMusic(page: Page) {
  await page.goto('/');
  await page.getByTestId('add-kid').click();
  await page.getByLabel('Name').fill('Ava');
  await page.getByRole('button', { name: "Let's go!" }).click();
  await expect(page.getByTestId('switch-player')).toContainText('Ava!');
  await page.getByTestId('add-music').click();
  await expect(page.getByRole('heading', { name: 'Add music' })).toBeVisible();
}

/** Fire a file drag over the upload box and drop files built in the page. */
async function dropFiles(page: Page, files: { name: string; type: string }[], drop = true) {
  await page.getByTestId('upload-box').evaluate(
    (box, { files, drop }) => {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(new File([new Uint8Array([1, 2, 3])], f.name, { type: f.type }));
      box.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      box.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
      if (drop) box.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    },
    { files, drop },
  );
}

/** Are all these elements on one line? */
async function oneLine(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((els) => new Set(els.map((e) => Math.round(e.getBoundingClientRect().top))).size === 1);
}

const sizes = [
  { name: 'small phone', width: 320, height: 640 },
  { name: 'phone', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 },
];

for (const size of sizes) {
  test(`Add music upload box and page tray (${size.name})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.setViewportSize({ width: size.width, height: size.height });
    await openAddMusic(page);

    // "Music for": always one line; scrolls sideways (mouse wheel too) if it doesn't fit.
    const row = page.getByRole('group', { name: 'This music is for' });
    expect(await oneLine(page, '.chips-row > .btn')).toBe(true);
    const { scrollable, overflowX, rowRight } = await row.evaluate((el) => ({
      scrollable: el.scrollWidth > el.clientWidth + 1,
      overflowX: getComputedStyle(el).overflowX,
      rowRight: el.getBoundingClientRect().right,
    }));
    expect(overflowX).toBe('auto');
    expect(rowRight).toBeLessThanOrEqual(size.width);
    if (scrollable) {
      await expect(row).toHaveClass(/more-right/);
      await row.hover();
      await page.mouse.wheel(0, 200);
      await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
      await expect(row).toHaveClass(/more-left/);
    }
    // No horizontal page scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    // One big upload box replaces the two buttons and the separate notice.
    await expect(page.getByRole('button', { name: 'Take a photo' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Choose from photos' })).toHaveCount(0);
    const box = page.getByTestId('upload-box');
    await expect(box.getByText('Add your music!')).toBeVisible();
    await expect(box.getByText('Only the music please, no faces or pets!')).toBeVisible();
    await expect(box.getByRole('link', { name: 'Privacy' })).toBeVisible();
    const input = page.getByTestId('photo-input');
    await expect(input).toHaveAttribute('accept', 'image/*');
    await expect(input).toHaveAttribute('multiple', '');
    expect(await input.getAttribute('capture')).toBeNull();
    if (shots) await page.screenshot({ path: `${shots}/${size.width}-empty.png`, fullPage: true });

    // Dragging shows "Drop your music here!"; non-images are left out with a friendly message.
    await dropFiles(page, [{ name: 'tune.png', type: 'image/png' }], false);
    await expect(box).toHaveClass(/over/);
    await expect(box.getByText('Drop your music here!')).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/${size.width}-drag.png` });
    await box.evaluate((el) => el.dispatchEvent(new DragEvent('dragleave', { bubbles: true })));
    await expect(box).not.toHaveClass(/over/);
    await dropFiles(page, [{ name: 'notes.pdf', type: 'application/pdf' }]);
    await expect(page.getByRole('alert')).toContainText("isn't a photo");

    // Keyboard: focus the box, Enter opens the device's picker.
    const main = box.locator('.dropzone-main');
    await main.focus();
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Enter');
    const fc = await chooser;
    expect(fc.isMultiple()).toBe(true);
    await fc.setFiles(photo);
    // Clicking anywhere on the box (not just the middle) also opens it.
    const chooser2 = page.waitForEvent('filechooser');
    const b = (await box.boundingBox())!;
    await page.mouse.click(b.x + 12, b.y + b.height / 2);
    await (await chooser2).setFiles(photo);

    // The box shrinks to "Add another page" above the tray.
    await expect(page.getByRole('heading', { name: '2 pages' })).toBeVisible();
    await expect(box).toHaveClass(/compact/);
    await expect(box.getByText('Add another page')).toBeVisible();
    const boxBottom = (await box.boundingBox())!.y + (await box.boundingBox())!.height;
    expect(boxBottom).toBeLessThan((await page.locator('.page-tray').boundingBox())!.y);

    // Actions under each page: five, on one line, inside the card. Delete sits on the photo.
    const card = page.locator('.page-card').first();
    await expect(card.locator('.page-actions .btn')).toHaveCount(5);
    expect(await oneLine(page, '.page-card:first-child .page-actions .btn')).toBe(true);
    const fits = await card.evaluate((el) => {
      const c = el.getBoundingClientRect();
      return [...el.querySelectorAll('.page-actions .btn')].every((b) => {
        const r = b.getBoundingClientRect();
        return r.left >= c.left - 0.5 && r.right <= c.right + 0.5 && r.width >= 36 && r.height >= 40;
      });
    });
    expect(fits).toBe(true);
    const del = card.getByRole('button', { name: 'Remove page 1' });
    const wrap = (await card.locator('.page-thumb-wrap').boundingBox())!;
    const d = (await del.boundingBox())!;
    expect(d.x + d.width).toBeGreaterThan(wrap.x + wrap.width - 60);
    expect(d.y).toBeLessThan(wrap.y + 20);
    if (shots) await page.screenshot({ path: `${shots}/${size.width}-pages.png`, fullPage: true });

    // Delete asks first.
    await del.click();
    const dialog = page.getByRole('dialog', { name: 'Remove this page?' });
    await expect(dialog).toBeVisible();
    if (shots) await page.screenshot({ path: `${shots}/${size.width}-confirm.png` });
    await dialog.getByRole('button', { name: 'Keep it' }).click();
    await expect(page.getByRole('heading', { name: '2 pages' })).toBeVisible();
    await del.click();
    await page.getByRole('dialog').getByRole('button', { name: 'Yes, remove' }).click();
    await expect(page.getByRole('heading', { name: '1 page' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove page 1' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Yes, remove' }).click();
    await expect(box.getByText('Add your music!')).toBeVisible();

    expect(errors).toEqual([]);
  });
}

test('upload box respects reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openAddMusic(page);
  await dropFiles(page, [{ name: 'tune.png', type: 'image/png' }], false);
  const box = page.getByTestId('upload-box');
  await expect(box).toHaveClass(/over/);
  expect(await box.evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(await box.locator('.dropzone-note').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
});
