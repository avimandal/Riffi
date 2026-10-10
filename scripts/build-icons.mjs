// Builds the self-hosted Material Symbols Rounded subset used by the app.
// It scans src/ for icon names, asks Google Fonts for a font containing only
// those icons (weight 500, FILL 0..1), and saves it to public/fonts/.
// The app never contacts Google at runtime; this runs only when icons change.
// Run: node scripts/build-icons.mjs
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|jsx?)$/.test(f) ? [p] : [];
  });
}

const names = new Set();
for (const file of walk('src')) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(/name="([a-z0-9_]+)"/g)) names.add(m[1]);
  // name={cond ? 'a' : 'b'} and icon maps
  for (const m of src.matchAll(/name=\{([^}]*)\}/g)) for (const q of m[1].matchAll(/'([a-z0-9_]+)'/g)) names.add(q[1]);
  for (const m of src.matchAll(/icon: '([a-z0-9_]+)'/g)) names.add(m[1]);
  const maps = src.match(/(?:_ICON|ICON)[^=]*=\s*\{([\s\S]*?)\};/g) ?? [];
  for (const block of maps) for (const q of block.matchAll(/:\s*'([a-z0-9_]+)'/g)) names.add(q[1]);
}
const list = [...names].sort();
console.log(`${list.length} icons:`, list.join(', '));

const css = await fetch(
  `https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@24,500,0..1,0&icon_names=${list.join(',')}&display=block`,
  { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' } },
).then((r) => r.text());
const url = css.match(/src:\s*url\(([^)]+)\)/)?.[1];
if (!url) throw new Error(`No font URL in response:\n${css}`);
const font = Buffer.from(await fetch(url).then((r) => r.arrayBuffer()));
mkdirSync('public/fonts', { recursive: true });
writeFileSync('public/fonts/material-symbols-rounded-subset.woff2', font);
writeFileSync('public/fonts/icons.txt', list.join('\n') + '\n');
console.log(`Saved ${font.length} bytes`);
