import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMusicXml } from '../../src/sheet/musicxml';

export function fixtureXml(name: string): string {
  return readFileSync(join(process.cwd(), 'tests', 'fixtures', 'musicxml', name), 'utf8');
}

export function fixture(name: string) {
  return parseMusicXml(fixtureXml(name));
}
