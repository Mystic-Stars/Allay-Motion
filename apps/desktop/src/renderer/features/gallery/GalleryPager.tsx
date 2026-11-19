import { Button } from '@allay/ui/components/button';
import { ICON } from '@allay/ui/lib/icons';
import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

export function GalleryPager({ page, pages, onPage }: { page: number; pages: number; onPage(page: number): void }) {
  const { t } = useTranslation();
  if (pages <= 1) return null;
  return <nav className="flex shrink-0 items-center justify-center gap-2 py-1 text-xs text-fg-subtle" aria-label={t('gallery.pages')}>
    <Button size="icon-sm" variant="ghost" data-testid="gallery-prev" aria-label={t('gallery.previous')} disabled={page === 0} onClick={() => onPage(page - 1)}><CaretLeft size={ICON.sm} /></Button>
    <span aria-live="polite" className="num">{page + 1} / {pages}</span>
    <Button size="icon-sm" variant="ghost" data-testid="gallery-next" aria-label={t('gallery.next')} disabled={page + 1 === pages} onClick={() => onPage(page + 1)}><CaretRight size={ICON.sm} /></Button>
  </nav>;
}
