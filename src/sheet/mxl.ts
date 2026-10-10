/**
 * Compressed MusicXML (.mxl) support. An .mxl file is a zip archive with
 * META-INF/container.xml pointing at the score inside. MuseScore exports
 * this by default.
 *
 * Small, dependency-free zip reader: reads the central directory and
 * inflates entries with the browser's DecompressionStream ('deflate-raw').
 */

export class MxlError extends Error {}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localHeaderOffset: number;
}

/** Is this an .mxl (zip) file rather than plain XML? Checks the "PK\x03\x04" signature. */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

function readEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // End of central directory: search backwards (it may be followed by a comment).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new MxlError('Not a zip file');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new MxlError('Damaged zip directory');
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, compressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new MxlError('This browser cannot open .mxl files');
  const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function extract(bytes: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const h = e.localHeaderOffset;
  if (view.getUint32(h, true) !== 0x04034b50) throw new MxlError('Damaged zip entry');
  const start = h + 30 + view.getUint16(h + 26, true) + view.getUint16(h + 28, true);
  const data = bytes.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRaw(data);
  throw new MxlError(`Unsupported compression (${e.method})`);
}

/** Pull the MusicXML text out of an .mxl file. */
export async function readMxl(input: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const entries = readEntries(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const decoder = new TextDecoder();

  let rootPath: string | undefined;
  const container = byName.get('META-INF/container.xml');
  if (container) {
    const xml = decoder.decode(await extract(bytes, container));
    rootPath = xml.match(/<rootfile[^>]*full-path\s*=\s*["']([^"']+)["']/)?.[1];
  }
  // Fall back to the first score-looking file outside META-INF.
  const root =
    (rootPath && byName.get(rootPath)) ||
    entries.find((e) => !e.name.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(e.name));
  if (!root) throw new MxlError('No score inside the .mxl file');
  return decoder.decode(await extract(bytes, root));
}

/** Read an opened file as MusicXML text, whether it's .mxl or plain XML. */
export async function musicXmlFromFile(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isZip(bytes)) return readMxl(bytes);
  return new TextDecoder().decode(bytes);
}
