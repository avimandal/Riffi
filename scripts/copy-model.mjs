// Copies the Basic Pitch TF.js model out of node_modules into public/ so it is
// served (and precached for offline use) alongside the app.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', '@spotify', 'basic-pitch', 'model');
const dest = join(root, 'public', 'models', 'basic-pitch');

if (!existsSync(src)) {
  console.warn('[copy-model] Basic Pitch model not found; skipping.');
  process.exit(0);
}
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log('[copy-model] Basic Pitch model copied to public/models/basic-pitch');
