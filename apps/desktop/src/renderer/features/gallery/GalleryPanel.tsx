import { AllayEmpty, AllayLoader, useReducedMotion } from '@allay/mascot';
import { localize } from '@allay/template-sdk';
import { Button } from '@allay/ui/components/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@allay/ui/components/context-menu';
import { Input, Skeleton } from '@allay/ui/components/misc';
import { Tabs, TabsList, TabsTrigger } from '@allay/ui/components/tabs';
import { TemplateCard } from '@allay/ui/editor';
import { ICON } from '@allay/ui/lib/icons';
import { MagnifyingGlass, Plus, X } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import type { TemplateEntry } from '../../../shared/templates';
import { filterGallery, galleryPage, galleryTabs, type GalleryTab } from '../../../shared/gallery';
import { notify } from '../../stores/noticeStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useTemplateStore } from '../../stores/templateStore';
import { useUiStore } from '../../stores/uiStore';
import { usePresets } from '../params/ParamsPanel';
import type { Selection } from '../studio/edits';
import { applyPresetEntry } from '../templates/presets';
import { installViaDialog, removeTemplate, selectTemplate } from '../templates/actions';
import { COVER_FPS, COVER_H, COVER_W, coverKey, covers, useCoverStore, type Cover } from './covers';
import { appendTemplate } from './appendTemplate';
import { GalleryPager } from './GalleryPager';

// 左面板（6.4）的两个标签页（经注册表挂到 TabbedPanel 上，见 app/core.tsx）：“模板 | 预设”；模板页的标题行右侧是搜索和导入图标。
// 模板页：分类“全部/转场/叠加/我的”是安静的文字切换（选中项有控件底色）；两列缩略图，名称在下、时长（等宽）在右；
// 悬停时播放预览循环；选中 = 面板色 2 px 间隙 + 2 px 强调色外框。首次加载、资源栈变化后重建封面时：骨架加悦灵。
// 预设页：当前模板的预设（沿用已有的预设存取），点一下应用。

/** 悬停预览：按 30 fps 把网格图里的帧画到一块小画布上（一个 rAF 循环） */
function HoverPlayer({ cover, entry }: { cover: Cover; entry: TemplateEntry }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => covers.animate(entry), [entry]);
  useEffect(() => {
    const canvas = ref.current;
    const sheet = cover.sheet;
    if (!canvas || !sheet || cover.frames === 0) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    let raf = 0;
    let last = -1;
    const t0 = performance.now();
    const tick = (now: number) => {
      const i = Math.floor(((now - t0) / 1000) * COVER_FPS) % cover.frames;
      if (i !== last && sheet.width) {
        last = i;
        g.clearRect(0, 0, COVER_W, COVER_H);
        g.drawImage(sheet, (i % cover.cols) * COVER_W, Math.floor(i / cover.cols) * COVER_H, COVER_W, COVER_H, 0, 0, COVER_W, COVER_H);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [cover]);
  return cover.sheet ? <canvas ref={ref} width={COVER_W} height={COVER_H} className="preview-checker-sm size-full" aria-hidden="true" /> : null;
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-x-2.5 gap-y-3 px-3 pt-3" aria-hidden="true">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex flex-col gap-[7px]">
          <Skeleton className="aspect-video w-full" />
          <Skeleton className="h-3 w-2/3 rounded-sm" />
        </div>
      ))}
    </div>
  );
}

function warningOf(e: TemplateEntry, t: (k: string) => string): string | undefined {
  if (e.baseMissing) return t('gallery.baseMissing');
  if (e.trialWarnings.length > 0) return e.trialWarnings.map((w) => t(`templates.warnings.${w}`)).join(t('templates.listSeparator'));
  return undefined;
}

function TemplatesPage({ query, setQuery, insert }: { query: string; setQuery(q: string): void; insert?: (entry: TemplateEntry) => Promise<void> }) {
  const { t, i18n } = useTranslation();
  const entries = useTemplateStore((s) => s.entries);
  const loaded = useTemplateStore((s) => s.loaded);
  const current = useProjectStore((s) => s.template?.ref);
  const revision = useProjectStore((s) => s.revision);
  const loadedPreview = usePreviewStore((s) => s.loaded);
  const coverMap = useCoverStore((s) => s.covers);
  const [tab, setTab] = useState<GalleryTab>('all');
  const [position, setPosition] = useState({ query, tab, page: 0 });
  const scroll = useRef<HTMLDivElement>(null);
  const reducedMotion = useReducedMotion();
  const [pendingInsert, setPendingInsert] = useState(false);
  const locale = i18n.language;
  const durationFormat = useMemo(() => new Intl.NumberFormat(locale, { maximumFractionDigits: 2, minimumFractionDigits: 1 }), [locale]);
  const instanceDuration = loadedPreview?.revision === revision && loadedPreview.locale === locale ? loadedPreview.duration : null;
  const matches = useMemo(() => filterGallery(entries, tab, query), [entries, tab, query]);
  const requested = position.query === query && position.tab === tab ? position.page : 0;
  const { items: shown, page, pages } = useMemo(() => galleryPage(matches, requested), [matches, requested]);
  const coverEntries = useMemo(() => shown.filter(entry => !entry.baseMissing), [shown]);
  useEffect(() => covers.ensure(coverEntries), [coverEntries]);
  useEffect(() => { scroll.current?.scrollTo(0, 0); }, [query, tab, page]);
  const loading = !loaded || (coverEntries.length > 0 && coverEntries.every(entry => !(coverKey(entry.id, entry.version) in coverMap)));
  const loaderLabel = loaded ? t('gallery.redrawing') : t('gallery.loading');

  return (
    <>
      <Tabs value={tab} onValueChange={(v) => setTab(v as GalleryTab)}>
        <TabsList className="flex-wrap gap-0.5 px-2" aria-label={t('gallery.categoriesLabel')}>
          {galleryTabs.map((k) => (
            <TabsTrigger key={k} value={k} className="px-1.5" data-testid={`gallery-tab-${k}`}>
              {t(`gallery.tabs.${k}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div ref={scroll} className="min-h-0 flex-1 overflow-y-auto">
        <AllayLoader loading={loading} label={loaderLabel} priority="gallery" className="min-h-full" testId="gallery-loader">
          {!loaded ? (
            <GridSkeleton />
          ) : shown.length === 0 ? (
            query ? (
              <div className="flex flex-col items-center gap-2.5 px-4 py-8 text-center" data-testid="gallery-no-results">
                <p className="text-fg-muted">{t('gallery.noResults', { query: query.trim() })}</p>
                <Button variant="secondary" onClick={() => setQuery('')}>
                  {t('gallery.clearSearch')}
                </Button>
              </div>
            ) : tab === 'mine' ? (
              <AllayEmpty
                title={t('gallery.mineEmptyTitle')}
                description={t(insert ? 'workspaceNavigation.noUserTemplates' : 'gallery.mineEmpty')}
                action={!insert && (
                  <Button variant="secondary" onClick={() => void installViaDialog(t, locale)}>
                    {t('gallery.import')}
                  </Button>
                )}
              />
            ) : (
              <p className="p-4 text-xs text-fg-subtle">{t('gallery.empty')}</p>
            )
          ) : (
            <div className="grid grid-cols-2 gap-x-2.5 gap-y-3 px-3 pt-3 pb-3" data-testid="template-list">
              {shown.map((e) => {
                const key = coverKey(e.id, e.version);
                const cover = coverMap[key];
                const name = localize(e.manifest.name, locale);
                const warning = warningOf(e, t);
                const selected = !insert && current?.id === e.id && current.version === e.version;
                const seconds = selected ? instanceDuration : cover?.duration;
                const duration = seconds != null && seconds > 0 ? t('gallery.seconds', { value: durationFormat.format(seconds) }) : undefined;
                const actionLabel = insert ? t('workspaceNavigation.insertTemplate', { name }) : name;
                const description = [insert ? actionLabel : t(`gallery.categories.${e.manifest.category}`), cover?.usesPlaceholder && t('resources.catalogPlaceholder')].filter(Boolean).join(' · ');
                const pick = () => {
                  if (!insert) {
                    void selectTemplate(e.id, e.version, locale);
                  } else {
                    setPendingInsert(true);
                    void insert(e).finally(() => setPendingInsert(false));
                  }
                };
                const card = (
                  <TemplateCard
                    testId={`template-${e.id}`}
                    name={name}
                    duration={duration}
                    coverUrl={cover?.url ?? null}
                    selected={selected}
                    user={e.source === 'user'}
                    userLabel={t('gallery.user')}
                    warning={warning}
                    disabled={e.baseMissing || pendingInsert}
                    description={duration ? `${description} · ${t(selected ? 'gallery.instanceDuration' : 'gallery.defaultDuration', { duration })}` : description}
                    renderPreview={cover && !reducedMotion ? () => <HoverPlayer cover={cover} entry={e} /> : undefined}
                    onSelect={pick}
                  />
                );
                return (
                  <div key={`${e.id}@${e.version}`} data-allay-item>
                    {e.source === 'user' && !insert ? (
                      <ContextMenu>
                        <ContextMenuTrigger render={<div />}>{card}</ContextMenuTrigger>
                        <ContextMenuContent>
                          <ContextMenuItem
                            onClick={() =>
                              void window.allay.templates.exportPackage(e.id, e.version).then((r) => {
                                if (!r.canceled) notify('info', t('gallery.exported'));
                              })
                            }
                          >
                            {t('gallery.exportPackage')}
                          </ContextMenuItem>
                          <ContextMenuItem className="text-danger" onClick={() => void removeTemplate(e.id, e.version, locale)}>
                            {t('gallery.remove')}
                          </ContextMenuItem>
                        </ContextMenuContent>
                      </ContextMenu>
                    ) : (
                      card
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </AllayLoader>
      </div>
      <GalleryPager page={page} pages={pages} onPage={value => setPosition({ tab, query, page: value })} />
    </>
  );
}

function PresetsPage() {
  const { t, i18n } = useTranslation();
  const template = useProjectStore((s) => s.template);
  const presets = usePresets(template?.ref.id);
  if (presets.length === 0) return <p className="px-3.5 py-3 text-xs leading-relaxed text-fg-subtle" data-testid="gallery-presets-empty">{t('gallery.presetsEmpty')}</p>;
  return (
    <ul className="flex flex-col gap-0.5 overflow-y-auto px-2 pb-3" data-testid="gallery-presets">
      {presets.map((p) => (
        <li key={p.id}>
          <button
            type="button"
            className="flex h-8 w-full items-center rounded-md px-2.5 text-left text-fg-muted hover:bg-control hover:text-foreground"
            onClick={() =>
              void applyPresetEntry(p, i18n.language).then((ok) => {
                if (!ok) notify('error', t('params.presets.applyFailed'));
              })
            }
          >
            <span className="truncate">{p.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** 模板页标题行右侧：搜索（展开搜索框，Ctrl+F 同）和导入 */
export function TemplatesActions({ allowImport = true }: { allowImport?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const searchOpen = useUiStore((s) => s.searchOpen);
  const query = useUiStore((s) => s.galleryQuery);
  const showSearch = searchOpen || query !== '';
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-fg-subtle"
        aria-label={t('gallery.searchToggle')}
        aria-pressed={showSearch}
        data-testid="gallery-search-toggle"
        onClick={() => {
          if (showSearch) useUiStore.setState({ searchOpen: false, galleryQuery: '' });
          else {
            useUiStore.setState({ searchOpen: true });
            requestAnimationFrame(() => document.getElementById('gallery-search')?.focus());
          }
        }}
      >
        <MagnifyingGlass size={ICON.md - 1} />
      </Button>
      {allowImport && <Button variant="ghost" size="icon-sm" className="text-fg-subtle" aria-label={t('gallery.import')} title={t('gallery.import')} data-testid="template-import" onClick={() => void installViaDialog(t, i18n.language)}>
        <Plus size={ICON.md - 1} />
      </Button>}
    </>
  );
}

/** 模板页：搜索框（展开时）、分类、缩略图网格 */
function TemplateLibrary({ insert }: Pick<ComponentProps<typeof TemplatesPage>, 'insert'>) {
  const { t } = useTranslation();
  const searchOpen = useUiStore((s) => s.searchOpen);
  const query = useUiStore((s) => s.galleryQuery);
  const setQuery = (galleryQuery: string) => useUiStore.setState({ galleryQuery });
  const showSearch = searchOpen || query !== '';
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {showSearch && (
        <div className="relative mx-2.5">
          <MagnifyingGlass size={ICON.sm} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle" aria-hidden="true" />
          <Input
            id="gallery-search"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query === '') useUiStore.setState({ searchOpen: false });
            }}
            placeholder={t('gallery.search')}
            aria-label={t('gallery.search')}
            className="h-7 pr-8 pl-8"
            data-testid="gallery-search"
          />
          {query && (
            <button type="button" aria-label={t('gallery.clearSearch')} className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-fg-subtle hover:text-foreground" onClick={() => setQuery('')}>
              <X size={ICON.sm} />
            </button>
          )}
        </div>
      )}
      <TemplatesPage query={query} setQuery={setQuery} insert={insert} />
    </div>
  );
}

export function TemplatesTab() {
  return <TemplateLibrary />;
}

export function StudioTemplateLibrary({ trackId, select }: { trackId?: string; select(selection: Selection): void }) {
  const { t, i18n } = useTranslation();
  return (
    <aside aria-label={t('workspaceNavigation.insertTemplates')} className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl bg-surface-1" data-testid="studio-template-library">
      <div className="flex h-panel-head shrink-0 items-center justify-between gap-2 pr-2 pl-3.5">
        <h2 className="truncate font-semibold">{t('workspaceNavigation.insertTemplates')}</h2>
        <TemplatesActions allowImport={false} />
      </div>
      <p className="px-3.5 pb-2 text-xs text-fg-muted">{t('workspaceNavigation.insertHint')}</p>
      <TemplateLibrary insert={async (entry) => {
        const selection = await appendTemplate(entry, trackId, i18n.language, t);
        if (selection) select(selection);
      }} />
    </aside>
  );
}

/** 预设页 */
export function PresetsTab() {
  return <PresetsPage />;
}
