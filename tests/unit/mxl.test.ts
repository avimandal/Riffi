import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { isZip, musicXmlFromFile, MxlError, readMxl } from '../../src/sheet/mxl';
import { parseMusicXml } from '../../src/sheet/musicxml';
import { fixtureXml } from '../fixtures/load';

const dir = join(process.cwd(), 'tests', 'fixtures', 'musicxml');

describe('.mxl (compressed MusicXML)', () => {
  it('finds the score via META-INF/container.xml and inflates it', async () => {
    const bytes = new Uint8Array(readFileSync(join(dir, 'twinkle.mxl')));
    expect(isZip(bytes)).toBe(true);
    const xml = await readMxl(bytes);
    expect(xml).toBe(fixtureXml('twinkle.musicxml'));
    expect(parseMusicXml(xml).title).toBe('Twinkle Twinkle');
  });

  it('falls back to the first score file when there is no container, and handles stored entries', async () => {
    const zip = execFileSync('python3', [
      '-c',
      `import zipfile,io,sys
b=io.BytesIO()
with zipfile.ZipFile(b,'w') as z: z.writestr('song.xml', open(sys.argv[1]).read(), compress_type=zipfile.ZIP_STORED)
sys.stdout.buffer.write(b.getvalue())`,
      join(dir, 'ties.musicxml'),
    ]);
    expect(parseMusicXml(await readMxl(new Uint8Array(zip))).title).toBe('Tied Notes');
  });

  it('opens either kind of file', async () => {
    const plain = new Blob([fixtureXml('ties.musicxml')]);
    expect(await musicXmlFromFile(plain)).toContain('<score-partwise');
    const mxl = new Blob([new Uint8Array(readFileSync(join(dir, 'twinkle.mxl')))]);
    expect(await musicXmlFromFile(mxl)).toContain('Twinkle Twinkle');
  });

  it('rejects broken archives', async () => {
    await expect(readMxl(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).rejects.toThrow(MxlError);
  });
});
