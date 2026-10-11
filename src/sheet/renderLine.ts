import type { Instrument } from '../config';
import { notationToMusicXml, parseStaff, type RnMeasure } from './notation';

/**
 * Engrave one line of a transcription with the app's own renderer (OSMD), as a
 * PNG, so the double-check pass can put it side by side with the photo. Every
 * bar is numbered, and the line is kept on one system like the original.
 */

export interface LineContext {
  key?: number;
  time?: string;
  clef?: string;
  clef2?: string;
  staves: 1 | 2;
}

/** The measures to engrave, with the carried key/time/clef put on the first bar. Pure. */
export function lineForRender(measures: RnMeasure[], ctx: LineContext): RnMeasure[] {
  if (measures.length === 0) return [];
  const [first, ...rest] = measures;
  return [
    {
      ...first,
      key: first.key ?? ctx.key ?? 0,
      time: first.time ?? ctx.time ?? '4/4',
      clef: first.clef ?? ctx.clef ?? 'treble',
      clef2: ctx.staves === 2 ? (first.clef2 ?? ctx.clef2 ?? 'bass') : undefined,
    },
    ...rest,
  ];
}

/** CSS width that gives every note room on a single system. Pure. */
export function engravingWidth(measures: RnMeasure[]): number {
  let w = 140;
  for (const m of measures) {
    let events = 0;
    for (const src of [m.s1, m.s2]) {
      try {
        events = Math.max(events, src ? parseStaff(src).length : 0);
      } catch {
        events = Math.max(events, 8);
      }
    }
    w += 50 + Math.max(4, events) * 34;
  }
  return Math.max(900, Math.round(w));
}

export async function renderLinePng(measures: RnMeasure[], ctx: LineContext, instrument: Instrument, targetWidth = 2400): Promise<Blob> {
  const { OpenSheetMusicDisplay } = await import('opensheetmusicdisplay');
  const line = lineForRender(measures, ctx);
  const { musicxml } = notationToMusicXml({ staves: ctx.staves, measures: line }, instrument);
  const host = document.createElement('div');
  // Wide enough that the whole line fits on one system without squashing.
  const cssWidth = engravingWidth(line);
  host.style.cssText = `position:absolute;left:-30000px;top:0;width:${cssWidth}px;background:#fff;`;
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  try {
    const osmd = new OpenSheetMusicDisplay(host, {
      backend: 'svg',
      autoResize: false,
      drawTitle: false,
      drawSubtitle: false,
      drawComposer: false,
      drawCredits: false,
      drawPartNames: false,
      drawFingerings: false,
      drawLyrics: false,
      drawMeasureNumbers: true,
      drawMeasureNumbersOnlyAtSystemStart: false,
      measureNumberInterval: 1,
      autoBeam: true,
      pageFormat: 'Endless',
      darkMode: false,
    });
    await osmd.load(musicxml);
    // One system, like the photo, with every bar numbered (so mismatches can name the bar).
    osmd.EngravingRules.RenderXMeasuresPerLineAkaSystem = line.length;
    osmd.EngravingRules.RenderMeasureNumbers = true;
    osmd.EngravingRules.RenderMeasureNumbersOnlyAtSystemStart = false;
    osmd.EngravingRules.UseXMLMeasureNumbers = true;
    osmd.EngravingRules.StretchLastSystemLine = true;
    osmd.render();
    const svg = host.querySelector('svg');
    if (!svg) throw new Error('Nothing was engraved');
    const w = Number(svg.getAttribute('width')) || svg.getBoundingClientRect().width;
    const h = Number(svg.getAttribute('height')) || svg.getBoundingClientRect().height;
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const scale = Math.min(3, targetWidth / w);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx2 = canvas.getContext('2d')!;
      ctx2.fillStyle = '#ffffff';
      ctx2.fillRect(0, 0, canvas.width, canvas.height);
      ctx2.drawImage(img, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode'))), 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  } finally {
    host.remove();
  }
}
