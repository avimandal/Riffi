import type { Instrument } from '../config';
import type { PageDraft } from '../screens/add/imagePrep';
import { readerInfo } from './omrClient';
import { preparePage, type PreparedPage } from './pagePrep';
import { readPrepared, type ReadProgress, type ReadResult } from './reader';
import { renderLinePng } from './renderLine';

export type SheetProgress = ReadProgress | { stage: 'preparing'; page: number; pages: number };

/** Read photographed pages in the browser: find the lines, then read them one by one. */
export async function readSheetMusic(
  drafts: PageDraft[],
  instrument: Instrument,
  onProgress?: (p: SheetProgress) => void,
  opts: { provider?: string } = {},
): Promise<ReadResult & { pages: PreparedPage[] }> {
  const pages: PreparedPage[] = [];
  for (let i = 0; i < drafts.length; i++) {
    onProgress?.({ stage: 'preparing', page: i + 1, pages: drafts.length });
    pages.push(await preparePage(drafts[i], instrument));
  }
  const info = await readerInfo();
  const provider = opts.provider && info?.providers.includes(opts.provider) ? opts.provider : undefined;
  const rpm = info?.rpm[provider ?? info.default ?? 'gemini'] ?? 8;
  const result = await readPrepared(pages, {
    instrument,
    provider,
    rpm,
    linesPerRequest: info?.linesPerRequest ?? 8,
    onProgress,
    render: (measures, ctx) => renderLinePng(measures, ctx, instrument),
  });
  return { ...result, pages };
}
