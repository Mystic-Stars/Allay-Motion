// 模板一节：精选展示，不讲数量。一大几小的不等大网格 + “更多模板，持续加入”。
// 卡片由内置模板的 manifest 推导（名称、说明、分类、默认时长），顺序按 showcaseEntries（偏好在前，新加的排在后面，不用改代码）；
// 只展示前 SHOWCASE_MAX 个，其余在仿真器的模板库里。
// 封面和循环播放的帧来自桌面版模板库同一个封面服务（features/gallery/covers.ts：杂务引擎 Worker，320×180、30 fps）。
import { AllayLoader } from '@allay/mascot';
import { buttonVariants } from '@allay/ui/components/button';
import { Badge } from '@allay/ui/components/misc';
import { localize } from '@allay/template-sdk';
import { ArrowRight, ArrowUpRight, Plus } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { Cover } from '../../../../desktop/src/renderer/features/gallery/covers';
import type { TemplateEntry } from '../../../../desktop/src/shared/templates';
import { defaultDuration, showcaseEntries } from '../../host/templates';
import { REPO_URL, SECTION } from '../links';
import { BlockSkeleton } from '../motion/BlockSkeleton';
import { useReveal } from '../motion/interactions';
import { usePrefs } from '../prefs';
import { LiveCanvas } from './LiveCanvas';
import { requestOpenTemplate } from './SimulatorSection';

/** 这一节最多展示几个（一大四小） */
export const SHOWCASE_MAX = 5;
export const AUTHORING_URL = `${REPO_URL}/blob/main/docs/template-authoring.md`;

type CoverMap = Record<string, Cover | null>;

const COVER_W = 320;
const COVER_H = 180;
const COVER_FPS = 30;

function useCovers(entries: TemplateEntry[], anchor: React.RefObject<HTMLElement | null>): { covers: CoverMap; keyOf: (e: TemplateEntry) => string } {
  const [covers, setCovers] = useState<CoverMap>({});
  const [keyOf, setKeyOf] = useState<(e: TemplateEntry) => string>(() => () => '');
  useEffect(() => {
    const el = anchor.current;
    if (!el) return;
    let off: (() => void) | null = null;
    let alive = true;
    let started = false;
    let idle = 0;
    let timer = 0;
    const start = () => {
      if (started) return;
      started = true;
      io.disconnect();
      void (async () => {
        const rt = await import('../engine/runtime');
        await rt.ensureRuntime();
        if (!alive) return;
        setKeyOf(() => (e: TemplateEntry) => rt.coverKey(e.id, e.version));
        setCovers(rt.useCoverStore.getState().covers);
        off = rt.useCoverStore.subscribe((s) => setCovers(s.covers));
        if (rt.hasWebgl2()) rt.covers.ensure(entries);
      })();
    };
    // 不等滚到这里：页面空闲下来就开始渲染（杂务 Worker 一个模板一个模板地排队，不和首屏抢）
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && start(), { rootMargin: '1200px 0px' });
    io.observe(el);
    const onLoad = () => {
      timer = window.setTimeout(() => {
        if ('requestIdleCallback' in window) idle = window.requestIdleCallback(start, { timeout: 2500 });
        else start();
      }, 800);
    };
    if (document.readyState === 'complete') onLoad();
    else window.addEventListener('load', onLoad, { once: true });
    return () => {
      alive = false;
      io.disconnect();
      window.removeEventListener('load', onLoad);
      window.clearTimeout(timer);
      if (idle) window.cancelIdleCallback(idle);
      off?.();
    };
  }, [entries, anchor]);
  return { covers, keyOf };
}

/** 一格里的循环播放：把帧网格图一格一格画到小画布上（和模板库悬停预览同一个做法） */
function SheetPlayer({ cover, label }: { cover: Cover; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { reducedMotion } = usePrefs();
  useEffect(() => {
    const canvas = ref.current;
    const sheet = cover.sheet;
    if (!canvas || !sheet || cover.frames <= 0 || reducedMotion) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    let raf = 0;
    let visible = false;
    let start = 0;
    let last = -1;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (!visible) return;
      start ||= now;
      const span = cover.frames + Math.round(COVER_FPS * 0.4);
      const f = Math.floor(((now - start) / 1000) * COVER_FPS) % span;
      const i = Math.min(cover.frames - 1, f);
      if (i === last) return;
      last = i;
      g.clearRect(0, 0, COVER_W, COVER_H);
      g.drawImage(sheet, (i % cover.cols) * COVER_W, Math.floor(i / cover.cols) * COVER_H, COVER_W, COVER_H, 0, 0, COVER_W, COVER_H);
    };
    const io = new IntersectionObserver((es) => (visible = es.some((e) => e.isIntersecting)));
    io.observe(canvas);
    raf = requestAnimationFrame(draw);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [cover, reducedMotion]);
  return (
    <>
      <img src={cover.url} alt={label} className="absolute inset-0 size-full object-cover" draggable={false} />
      {cover.sheet && !reducedMotion && <canvas ref={ref} width={COVER_W} height={COVER_H} className="absolute inset-0 size-full" aria-hidden="true" data-testid="template-sheet" />}
    </>
  );
}

function CoverBox({ entry, cover, name, live, className }: { entry: TemplateEntry; cover: Cover | null | undefined; name: string; live?: boolean; className?: string }) {
  const { t } = useTranslation();
  return (
    <div className={`preview-checker relative overflow-hidden rounded-md ${className ?? ''}`} data-template={entry.id}>
      <div className="absolute inset-0 transition-transform duration-700 ease-(--ease-expo) group-hover:scale-[1.03]">
        {live ? (
          // 精选的大格：引擎实时渲染（放大也清楚）；没起来之前先放封面的循环帧
          <LiveCanvas templateId={entry.id} className="absolute inset-0" testId="template-live" fallback={cover ? <SheetPlayer cover={cover} label={name} /> : <BlockSkeleton className="absolute inset-0 size-full" />} />
        ) : cover ? (
          <div className="absolute inset-0 animate-[fade-in_700ms_var(--ease-out)_both]">
            <SheetPlayer cover={cover} label={name} />
          </div>
        ) : cover === null ? (
          <div className="absolute inset-0 flex items-center justify-center text-[12px] text-fg-subtle">{t('site.templates.failed')}</div>
        ) : (
          <div className="absolute inset-0" aria-busy="true" aria-label={t('site.templates.rendering')} role="img">
            <BlockSkeleton className="absolute inset-0 size-full" />
          </div>
        )}
      </div>
    </div>
  );
}

function Tile({ entry, cover, featured, wideCover = false }: { entry: TemplateEntry; cover: Cover | null | undefined; featured: boolean; wideCover?: boolean }) {
  const { t } = useTranslation();
  const { language } = usePrefs();
  const m = entry.manifest;
  const name = localize(m.name, language);
  const duration = defaultDuration(m);
  const category = t(`gallery.categories.${m.category}`);
  return (
    <article className="card hoverable group flex h-full flex-col p-2" data-testid="template-card" data-template={entry.id}>
      {/* 叠在大格右边的两个小格用扁一点的画面，两列高度对齐（帧网格是 16:9，裁掉上下一点） */}
      <CoverBox entry={entry} cover={cover} name={name} live={featured} className={wideCover ? 'aspect-video lg:aspect-[2/1]' : 'aspect-video'} />
      <div className={`flex flex-1 flex-col justify-end ${featured ? 'px-4 pt-6 pb-4 sm:px-5' : 'px-3 pt-4 pb-3'}`}>
        <div className="flex items-center gap-3">
          {featured && <Badge className="text-primary-text">{t('site.templates.featured')}</Badge>}
          <span className="t-mono text-[10.5px] text-fg-subtle">{duration !== null ? t('site.templates.meta', { category, duration: duration.toFixed(2) }) : t('site.templates.metaNoDuration', { category })}</span>
        </div>
        <div className="mt-3 flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h3 className={featured ? 't-h2 !text-[clamp(30px,3vw,48px)]' : 't-h3'}>{name}</h3>
            {m.description && <p className={`t-body mt-2 ${featured ? 'max-w-[34em]' : 'line-clamp-2 !text-[14px]'}`}>{localize(m.description, language)}</p>}
          </div>
          <button
            type="button"
            onClick={() => requestOpenTemplate(entry.id, entry.version)}
            className={buttonVariants({ variant: 'secondary', size: 'icon' })}
            data-testid="template-open"
            aria-label={`${t('site.templates.openInSim')}：${name}`}
            title={t('site.templates.openInSim')}
          >
            <ArrowRight size={16} className="transition-transform duration-200 ease-(--ease-out) group-hover:translate-x-0.5" />
          </button>
        </div>
        {featured && (
          // 精选的大格：列出可调的参数（取自 manifest，不含音效），看得出它能怎么调
          <ul className="mt-5 flex flex-wrap gap-1.5" aria-label={t('site.templates.params')}>
            {(m.params ?? [])
              .filter((p) => p.group !== 'sound' && p.type !== 'seed')
              .slice(0, 9)
              .map((p) => (
                <li key={p.key}>
                  <Badge>{localize(p.label, language)}</Badge>
                </li>
              ))}
          </ul>
        )}
      </div>
    </article>
  );
}

function MoreTile() {
  const { t } = useTranslation();
  return (
    <a href={AUTHORING_URL} target="_blank" rel="noreferrer noopener" className="card group link-focus relative flex h-full min-h-[260px] flex-col justify-between overflow-hidden p-6" data-testid="templates-more">
      <div className="pointer-events-none absolute inset-0 bg-grid fade-mask opacity-70" aria-hidden="true" />
      <span className="relative flex size-9 items-center justify-center rounded-lg bg-control text-fg-muted transition-transform duration-500 ease-(--ease-expo) group-hover:rotate-90">
        <Plus size={18} weight="bold" />
      </span>
      <div className="relative">
        <h3 className="t-h3">{t('site.templates.moreTitle')}</h3>
        <p className="t-body mt-2 !text-[14px]">{t('site.templates.moreBody')}</p>
        <span className="mt-5 inline-flex items-center gap-1.5 text-[14px] font-medium text-primary-text">
          {t('site.templates.moreLink')}
          <ArrowUpRight size={15} className="transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </span>
      </div>
    </a>
  );
}

export function TemplatesSection() {
  const { t } = useTranslation();
  const shown = useMemo(() => showcaseEntries().slice(0, SHOWCASE_MAX), []);
  const grid = useRef<HTMLDivElement>(null);
  const head = useReveal<HTMLDivElement>();
  const gridReveal = useReveal<HTMLDivElement>(0.08);
  const { covers, keyOf } = useCovers(shown, grid);
  // 封面在页面空闲时就开始渲染；悦灵（模板库的加载编排）只在这一格进了视口附近、还没渲染完时才出场，
  // 免得远处看不见的加载占着“全页一只”的位置，让首屏的悦灵等它
  const [gridNear, setGridNear] = useState(false);
  useEffect(() => {
    const el = grid.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setGridNear(es.some((e) => e.isIntersecting)), { rootMargin: '10% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  const pending = shown.filter((e) => {
    const k = keyOf(e);
    return !k || !(k in covers);
  }).length;
  // 格子在网格里的位置：大格占左边两行，两个小格叠在它右边，其余排在下一行，最后是“更多”
  const spans = ['sm:col-span-2 lg:col-span-8 lg:row-span-2', 'lg:col-span-4', 'lg:col-span-4', 'lg:col-span-4', 'lg:col-span-4'];
  return (
    <section id={SECTION.templates} data-tl-clip="templates" data-tl-color="var(--stage-exit)" aria-labelledby="templates-title" className="relative py-32">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[60vh] bg-dots fade-mask-b opacity-60" aria-hidden="true" />
      <div className="wrap relative">
        <div ref={head} className="reveal grid items-end gap-6 lg:grid-cols-[1.2fr_1fr] lg:gap-16">
          <div>
            <p className="t-mono text-fg-subtle">{t('site.templates.kicker')}</p>
            <h2 id="templates-title" className="t-h2 mt-4">
              {t('site.templates.title')}
            </h2>
          </div>
          <div className="relative">
            <span data-allay-anchor="templates" data-allay-facing="left" className="absolute -top-16 right-6 size-1" aria-hidden="true" />
            <p className="t-lead max-w-[34em]">{t('site.templates.lead')}</p>
          </div>
        </div>

        <div ref={grid} className="relative mt-14">
          <div className="pointer-events-none absolute inset-0 z-10 overflow-hidden" aria-hidden={pending === 0}>
            <AllayLoader loading={pending > 0 && gridNear} label={t('site.templates.rendering')} priority="gallery" className="size-full">
              <div />
            </AllayLoader>
          </div>
          <div ref={gridReveal} className="reveal grid gap-4 sm:grid-cols-2 lg:grid-cols-12 lg:gap-5">
            {shown.map((e, i) => {
              const key = keyOf(e);
              return (
                <div key={e.id} className={spans[i] ?? 'lg:col-span-4'} style={{ '--i': i } as CSSProperties}>
                  <Tile entry={e} cover={key ? covers[key] : undefined} featured={i === 0} wideCover={i === 1 || i === 2} />
                </div>
              );
            })}
            <div className="lg:col-span-4" style={{ '--i': shown.length } as CSSProperties}>
              <MoreTile />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
