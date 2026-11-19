import { localize } from '@allay/template-sdk';
import type { TemplateEntry } from './templates';

export const GALLERY_PAGE_SIZE = 6;
export const galleryTabs = ['all', 'transition', 'overlay', 'title', 'mine'] as const;
export type GalleryTab = typeof galleryTabs[number];

export function filterGallery(entries: readonly TemplateEntry[], tab: GalleryTab, query: string): TemplateEntry[] {
  const term = query.trim().toLowerCase();
  return entries.filter(entry => {
    if (tab === 'mine' && entry.source !== 'user') return false;
    if (tab !== 'all' && tab !== 'mine' && tab !== entry.manifest.category) return false;
    if (!term) return true;
    const { name, description, tags } = entry.manifest;
    return [entry.id, ...(tags ?? []), ...['zh-CN', 'en'].flatMap(lang => [localize(name, lang), localize(description, lang)])]
      .some(text => text.toLowerCase().includes(term));
  }).sort((left, right) => Number(right.source === 'builtin') - Number(left.source === 'builtin'));
}

export function galleryPage<T>(items: readonly T[], requested: number, size = GALLERY_PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const page = Math.max(0, Math.min(pages - 1, requested));
  return { page, pages, items: items.slice(page * size, (page + 1) * size) };
}
