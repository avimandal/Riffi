// Renders the SVG logo to the PNG app icons with headless Chromium.
// Run: node scripts/render-icons.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const logo = readFileSync('public/icons/favicon.svg', 'utf8');
const maskable = readFileSync('scripts/maskable.svg', 'utf8');
const jobs = [
  ['public/icons/icon-192.png', logo, 192, 'transparent'],
  ['public/icons/icon-512.png', logo, 512, 'transparent'],
  ['public/icons/icon-maskable-512.png', maskable, 512, '#6C4DF5'],
  ['public/icons/apple-touch-icon.png', maskable, 180, '#6C4DF5'],
];
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [out, svg, size, bg] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:${bg}">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: out, omitBackground: bg === 'transparent' });
  console.log('wrote', out);
}
await browser.close();
