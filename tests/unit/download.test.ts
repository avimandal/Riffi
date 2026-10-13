// @vitest-environment jsdom
import { File as NodeFile } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadMusicXml, musicFileName } from '../../src/data/download';
import { musicXmlFromFile } from '../../src/sheet/mxl';
import { parseMusicXml } from '../../src/sheet/musicxml';
import { fixtureXml } from '../fixtures/load';

describe('Download music file', () => {
  afterEach(() => vi.restoreAllMocks());

  it('names the file after the title', () => {
    expect(musicFileName("Herman's hornpipe")).toBe('Hermans-hornpipe.musicxml');
    expect(musicFileName('Twinkle, Twinkle  Little Star!')).toBe('Twinkle-Twinkle-Little-Star.musicxml');
    expect(musicFileName('Für Elise')).toBe('Fur-Elise.musicxml');
    expect(musicFileName('???')).toBe('music.musicxml');
    expect(musicFileName('a'.repeat(100))).toHaveLength(60 + '.musicxml'.length);
  });

  it('downloads the music as .musicxml, and the file opens again through Add music', async () => {
    const xml = fixtureXml('twinkle.musicxml');
    let blob: Blob | undefined;
    let name = '';
    // jsdom has no object URLs; capture what would be downloaded instead.
    Object.assign(URL, { createObjectURL: (b: Blob) => ((blob = b), 'blob:x'), revokeObjectURL: () => undefined });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      name = this.download;
    });
    expect(await downloadMusicXml(xml, 'Twinkle Twinkle')).toBe(true);
    expect(name).toBe('Twinkle-Twinkle.musicxml');
    expect(blob?.type).toBe('application/vnd.recordare.musicxml+xml');
    const text = await new Promise<string>((done) => {
      const r = new FileReader();
      r.onload = () => done(String(r.result));
      r.readAsText(blob!);
    });
    expect(text).toBe(xml);
    // Opened again as Add music → Open a music file would.
    const again = await musicXmlFromFile(new NodeFile([text], name) as unknown as File);
    expect(parseMusicXml(again).title).toBe('Twinkle Twinkle');
  });
});
