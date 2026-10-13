import { t } from '../../i18n';
import { OmrError } from '../../sheet/omrClient';
import type { SheetProgress } from '../../sheet/readSheet';

/** What to tell the kid when nothing could be read. */
export function errorText(e: unknown): string {
  const kind = e instanceof OmrError ? e.kind : 'server';
  const ref = e instanceof OmrError && (e.ref || e.code) ? ` ${t.add.errors.reference(e.ref ?? e.code ?? '')}` : '';
  return `${t.add.errors[kind]}${ref}`;
}

/** Friendly words for where the reader is up to. */
export function progressText(p: SheetProgress): { label: string; note?: string } {
  const note = t.add.readingNote;
  if (p.stage === 'preparing') return { label: t.add.preparing(p.page, p.pages), note };
  const wait = 'waitSeconds' in p && p.waitSeconds ? t.add.waiting(p.waitSeconds) : undefined;
  if (p.stage === 'overview') return { label: t.add.lookingAtPage(p.page, p.pages), note: wait ?? note };
  if (p.stage === 'checking') return { label: t.add.checkingLine(p.line ?? 1, p.lineTo, p.round ?? 1), note: wait ?? note };
  const bars = p.bars ? t.add.barsSoFar(p.bars) : '';
  return { label: t.add.readingLine(p.line ?? 1, p.lineTo, p.lines ?? 1, p.page, p.pages), note: wait ?? (bars ? `${bars} · ${note}` : note) };
}

