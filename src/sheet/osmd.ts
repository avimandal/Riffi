import { OpenSheetMusicDisplay, type GraphicalNote, type GraphicalMeasure } from 'opensheetmusicdisplay';
import type { ParsedScore } from './musicxml';

export type NoteMark = 'correct' | 'close' | 'wrong' | 'missed';

interface Mapped {
  gnote: GraphicalNote;
  measure: GraphicalMeasure;
}

/** Shape of the bits of OSMD's VexFlow note we use (not in its public types). */
interface VexNoteLike {
  getSVGGElement?: () => SVGGElement | undefined;
  vfnoteIndex?: number;
}

const OSMD_UNIT_PX = 10;

/**
 * Thin wrapper around OpenSheetMusicDisplay: renders MusicXML, maps OSMD's
 * graphical notes back to our `<note>` indices, and colours/locates them.
 */
export class SheetRenderer {
  readonly osmd: OpenSheetMusicDisplay;
  private map = new Map<number, Mapped>();
  private marked: Element[] = [];

  constructor(private readonly host: HTMLElement) {
    this.osmd = new OpenSheetMusicDisplay(host, {
      backend: 'svg',
      autoResize: false,
      drawTitle: true,
      drawSubtitle: false,
      drawComposer: true,
      drawCredits: false,
      drawPartNames: false,
      drawFingerings: false,
      drawLyrics: false,
      autoBeam: true,
      followCursor: false,
      pageFormat: 'Endless',
      darkMode: false,
    });
  }

  async render(xml: string, score: ParsedScore, zoom = 1) {
    await this.osmd.load(xml);
    this.osmd.zoom = zoom;
    this.osmd.render();
    this.buildMap(score);
    this.marked = [];
  }

  /** Re-layout at the current container width (call on resize). */
  relayout(score: ParsedScore) {
    this.osmd.render();
    this.buildMap(score);
    this.marked = [];
  }

  set zoom(z: number) {
    this.osmd.zoom = z;
  }

  /**
   * OSMD and our parser both know each note's bar, staff and position in the
   * bar; within those, sort by pitch and pair them up in order.
   */
  private buildMap(score: ParsedScore) {
    this.map.clear();
    const staffBase: number[] = [];
    let acc = 0;
    for (const p of score.parts) {
      staffBase.push(acc);
      acc += p.staves;
    }
    const keyOf = (m: number, staff: number, q: number) => `${m}|${staff}|${Math.round(q * 1000)}`;

    const ours = new Map<string, { xmlIndex: number; rest: boolean; midi: number }[]>();
    for (const n of score.notes) {
      const k = keyOf(n.measureIndex, staffBase[n.partIndex] + n.staff - 1, n.startQ);
      const list = ours.get(k) ?? [];
      list.push({ xmlIndex: n.xmlIndex, rest: n.isRest, midi: n.midi ?? -1 });
      ours.set(k, list);
    }

    const theirs = new Map<string, Mapped[]>();
    const measureList = this.osmd.GraphicSheet?.MeasureList ?? [];
    for (const row of measureList) {
      for (const gm of row) {
        if (!gm) continue;
        const mIndex = gm.parentSourceMeasure?.measureListIndex ?? -1;
        const staff = gm.ParentStaff?.idInMusicSheet ?? 0;
        for (const se of gm.staffEntries) {
          for (const gve of se.graphicalVoiceEntries) {
            for (const gn of gve.notes) {
              const src = gn.sourceNote;
              if (!src) continue;
              const q = (src.ParentStaffEntry?.Timestamp?.RealValue ?? 0) * 4;
              const k = keyOf(mIndex, staff, q);
              const list = theirs.get(k) ?? [];
              list.push({ gnote: gn, measure: gm });
              theirs.set(k, list);
            }
          }
        }
      }
    }

    for (const [k, list] of ours) {
      const other = theirs.get(k);
      if (!other) continue;
      const a = [...list].sort((x, y) => Number(x.rest) - Number(y.rest) || x.midi - y.midi);
      const b = [...other].sort((x, y) => {
        const xr = x.gnote.sourceNote.isRest();
        const yr = y.gnote.sourceNote.isRest();
        return Number(xr) - Number(yr) || (x.gnote.sourceNote.halfTone ?? 0) - (y.gnote.sourceNote.halfTone ?? 0);
      });
      for (let i = 0; i < Math.min(a.length, b.length); i++) this.map.set(a[i].xmlIndex, b[i]);
    }
  }

  get mappedCount(): number {
    return this.map.size;
  }

  /** The notehead SVG element for one of our notes (or the whole note group for rests). */
  noteElement(xmlIndex: number): Element | null {
    const m = this.map.get(xmlIndex);
    if (!m) return null;
    const vex = m.gnote as unknown as VexNoteLike;
    const group = vex.getSVGGElement?.();
    if (!group) return null;
    const heads = group.querySelectorAll('.vf-notehead');
    if (heads.length === 0) return group;
    return heads[Math.min(heads.length - 1, vex.vfnoteIndex ?? 0)] ?? group;
  }

  /** Bounding box of a note, relative to the host element's content. */
  noteRect(xmlIndex: number): DOMRect | null {
    const el = this.noteElement(xmlIndex);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const h = this.host.getBoundingClientRect();
    return new DOMRect(r.left - h.left + this.host.scrollLeft, r.top - h.top + this.host.scrollTop, r.width, r.height);
  }

  /** The vertical extent of the system (all staves) a note sits in, relative to the host. */
  systemBand(xmlIndex: number): { top: number; height: number } | null {
    const m = this.map.get(xmlIndex);
    const svg = this.host.querySelector('svg');
    if (!m || !svg) return null;
    const system = m.measure.ParentMusicSystem;
    const box = system?.PositionAndShape;
    if (!box) return null;
    const scale = OSMD_UNIT_PX * this.osmd.zoom;
    const svgRect = svg.getBoundingClientRect();
    const h = this.host.getBoundingClientRect();
    const top = box.AbsolutePosition.y + box.BorderTop;
    const bottom = box.AbsolutePosition.y + box.BorderBottom;
    return {
      top: svgRect.top - h.top + this.host.scrollTop + top * scale,
      height: Math.max(40, (bottom - top) * scale),
    };
  }

  /** Colour noteheads by result. Classes carry dashes/patterns too, so colour isn't the only cue. */
  mark(marks: Map<number, NoteMark>) {
    this.clearMarks();
    for (const [xmlIndex, mark] of marks) {
      const el = this.noteElement(xmlIndex);
      if (!el) continue;
      el.classList.add('riffi-mark', `riffi-mark-${mark}`);
      this.marked.push(el);
    }
  }

  select(xmlIndex: number | null) {
    this.host.querySelectorAll('.riffi-selected').forEach((e) => e.classList.remove('riffi-selected'));
    if (xmlIndex === null) return;
    this.noteElement(xmlIndex)?.classList.add('riffi-selected');
  }

  clearMarks() {
    for (const el of this.marked) {
      el.classList.remove('riffi-mark', 'riffi-mark-correct', 'riffi-mark-close', 'riffi-mark-wrong', 'riffi-mark-missed');
    }
    this.marked = [];
  }

  /** Nearest note to a point (host coordinates), within `maxPx`. */
  hitTest(x: number, y: number, maxPx = 36): number | null {
    let best: number | null = null;
    let bestD = maxPx;
    for (const xmlIndex of this.map.keys()) {
      const r = this.noteRect(xmlIndex);
      if (!r) continue;
      const d = Math.hypot(r.x + r.width / 2 - x, r.y + r.height / 2 - y);
      if (d < bestD) {
        bestD = d;
        best = xmlIndex;
      }
    }
    return best;
  }

  clear() {
    this.osmd.clear();
    this.map.clear();
    this.marked = [];
  }
}
