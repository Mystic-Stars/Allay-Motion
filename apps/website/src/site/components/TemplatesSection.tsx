// 精选模板展示（8 个代表作不对称 Bento + 指针聚光边框 + 3D 微倾视差 + 35mm 齿孔胶片技术跑马灯）：
// 点击任意卡片右侧按钮，直接把该模板载入上方 1:1 真实桌面应用试玩台并平滑滚去操作。
import { localize } from '@allay/template-sdk';
import { buttonVariants } from '@allay/ui/components/button';
import { Badge, Skeleton } from '@allay/ui/components/misc';
import { ArrowUpRight, Plus } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { mcTextureUrl } from '../../host/mc-pack';
import { defaultDuration, showcaseEntries, type SiteTemplateEntry } from '../../host/templates';
import { COVER_H, COVER_W, drawCoverSlot, nextCoverSlot, useShowcaseCovers, type ShowcaseCover } from '../engine/covers';
import { REPO_URL, SECTION, TEMPLATE_ICON_IDS } from '../links';
import { useReveal } from '../motion/interactions';
import { usePrefs } from '../prefs';
import { requestOpenTemplate } from './SimulatorSection';

export const SHOWCASE_MAX = 8;
export const AUTHORING_URL = `${REPO_URL}/blob/main/docs/template-authoring.md`;

const RIBBON_SPECS = [
  'DETERMINISTIC f(t) ENGINE',
  'PRORES 4444 RGBA ALPHA',
  'WEBM VP9 TRANSPARENT',
  'SUBFRAME MOTION BLUR',
  'ISOLATED WORKER SANDBOX',
  'MINECRAFT 1.21.1 ASSETS',
  '60 FPS REAL-TIME WEBGL2',
  'ZERO NETWORK TELEMETRY',
] as const;

function SheetPlayer({ cover, label, playing }: { cover: ShowcaseCover; label: string; playing: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { reducedMotion } = usePrefs();

  useEffect(() => {
    const canvas = ref.current;
    const sheet = cover.sheet;
    if (!canvas || !sheet || cover.frames <= 0 || reducedMotion) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    drawCoverSlot(g, cover, cover.posterSlot);
    if (!playing) return;
    let raf = 0;
    let start = 0;
    let last = cover.posterSlot;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      start ||= now;
      const i = nextCoverSlot(cover, (now - start) / 1000);
      if (i === last) return;
      last = i;
      drawCoverSlot(g, cover, i);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      if (raf !== 0) cancelAnimationFrame(raf);
    };
  }, [cover, playing, reducedMotion]);

  if (reducedMotion) {
    return <img src={cover.url} alt={label} className="pointer-events-none absolute inset-0 size-full object-cover" draggable={false} />;
  }
  return (
    <canvas
      ref={ref}
      width={COVER_W}
      height={COVER_H}
      className="pointer-events-none absolute inset-0 size-full object-cover"
      role="img"
      aria-label={label}
      data-testid="template-sheet"
    />
  );
}

function Tile({
  entry,
  cover,
  featured,
  wideCover = false,
  tallCover = false,
}: {
  entry: SiteTemplateEntry;
  cover: ShowcaseCover | null | undefined;
  featured: boolean;
  wideCover?: boolean;
  tallCover?: boolean;
}) {
  const { t } = useTranslation();
  const { language, reducedMotion } = usePrefs();
  const [hovering, setHovering] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  const m = entry.manifest;
  const name = localize(m.name, language);
  const duration = defaultDuration(m);
  const category = t(`site.categories.${m.category}`);
  const icon = mcTextureUrl(TEMPLATE_ICON_IDS[entry.id] ?? '');
  const coverShape = wideCover ? 'aspect-video lg:aspect-[2/1]' : tallCover ? 'aspect-video lg:aspect-auto lg:min-h-[240px] lg:flex-1' : 'aspect-video';

  const onMove = (e: PointerEvent<HTMLElement>) => {
    if (reducedMotion || e.pointerType === 'touch') return;
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const nx = (e.clientX - r.left) / r.width - 0.5;
    const ny = (e.clientY - r.top) / r.height - 0.5;
    el.style.transform = `perspective(960px) rotateX(${(-ny * 4.5).toFixed(2)}deg) rotateY(${(nx * 5.5).toFixed(2)}deg) translateY(-2px)`;
  };

  const onLeave = () => {
    setHovering(false);
    if (cardRef.current) cardRef.current.style.transform = '';
  };

  return (
    <article
      ref={cardRef}
      className="card card-spotlight hoverable group flex h-full flex-col p-2 will-change-transform"
      data-testid="template-card"
      data-template={entry.id}
      onPointerEnter={() => setHovering(true)}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onFocus={() => setHovering(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setHovering(false);
      }}
    >
      <div className={`preview-checker relative z-[1] overflow-hidden rounded-md ${coverShape}`}>
        <div className="absolute inset-0 transition-transform duration-500 ease-(--ease-expo) group-hover:scale-[1.035]">
          {cover ? (
            <SheetPlayer cover={cover} label={name} playing={hovering} />
          ) : cover === null ? (
            <div className="flex size-full items-center justify-center p-4 text-center text-[12px] text-fg-subtle">{t('site.templates.failed')}</div>
          ) : (
            <div className="size-full" aria-busy="true" aria-label={t('site.templates.rendering')} role="img">
              <Skeleton className="size-full rounded-none" />
            </div>
          )}
        </div>
      </div>

      <div className={`relative z-[1] flex flex-col justify-end ${tallCover ? '' : 'flex-1'} ${featured ? 'px-4 pt-5 pb-4 sm:px-5' : 'px-3 pt-4 pb-3'}`}>
        <div className="flex items-center gap-2">
          {icon && <img src={icon} alt="" width={14} height={14} className="pixelated size-[14px] shrink-0 rounded-[2px]" draggable={false} />}
          {featured && <Badge className="text-primary-text">{t('site.templates.featured')}</Badge>}
          <span className="t-mono text-[10.5px] text-fg-subtle">
            {duration !== null ? t('site.templates.meta', { category, duration: duration.toFixed(2) }) : t('site.templates.metaNoDuration', { category })}
          </span>
        </div>
        <div className="mt-2.5 flex items-end justify-between gap-3">
          <div className="min-w-0">
            <h3 className={featured ? 't-h2 !text-[clamp(26px,2.4vw,38px)]' : 't-h3'}>{name}</h3>
            {m.description && <p className={`t-body mt-1.5 ${featured ? 'max-w-[34em]' : 'line-clamp-2 !text-[13.5px]'}`}>{localize(m.description, language)}</p>}
          </div>
          <button
            type="button"
            onClick={() => requestOpenTemplate(entry.id, entry.version)}
            className={buttonVariants({ variant: 'secondary', size: 'icon' })}
            data-testid="template-open"
            aria-label={`${t('site.templates.openInSim')}：${name}`}
            title={t('site.templates.openInSim')}
          >
            <ArrowUpRight size={16} />
          </button>
        </div>
        {featured && (
          <ul className="mt-4 flex flex-wrap gap-1.5" aria-label={t('site.templates.params')}>
            {(m.params ?? [])
              .filter((p) => p.group !== 'sound' && p.type !== 'seed')
              .slice(0, 8)
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
    <a
      href={AUTHORING_URL}
      target="_blank"
      rel="noreferrer noopener"
      className="card card-spotlight group link-focus relative flex h-full min-h-[240px] flex-col justify-between overflow-hidden p-6"
      data-testid="templates-more"
    >
      <div className="pointer-events-none absolute inset-0 bg-grid fade-mask opacity-60" aria-hidden="true" />
      <span className="relative z-[1] flex size-9 items-center justify-center rounded-lg bg-control text-fg-muted transition-transform duration-500 ease-(--ease-expo) group-hover:rotate-90">
        <Plus size={18} weight="bold" />
      </span>
      <div className="relative z-[1]">
        <h3 className="t-h3">{t('site.templates.moreTitle')}</h3>
        <p className="t-body mt-2 !text-[14px]">{t('site.templates.moreBody')}</p>
        <span className="mt-4 inline-flex items-center gap-1.5 text-[14px] font-medium text-primary-text">
          {t('site.templates.moreLink')}
          <ArrowUpRight size={15} className="transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </span>
      </div>
    </a>
  );
}

function FilmRibbon() {
  return (
    <div className="film-ribbon mt-24 select-none" aria-hidden="true">
      <div className="film-sprockets" />
      <div className="marquee-track py-3.5">
        {[0, 1].map((dup) => (
          <div key={dup} className="flex shrink-0 items-center gap-7 pr-7">
            {RIBBON_SPECS.map((spec) => (
              <span key={`${dup}-${spec}`} className="t-mono flex items-center gap-7 text-[11.5px] text-fg-muted">
                <span>{spec}</span>
                <span className="inline-block size-1.5 rotate-45 rounded-[1px] bg-mark" />
              </span>
            ))}
          </div>
        ))}
      </div>
      <div className="film-sprockets" />
    </div>
  );
}

export function TemplatesSection() {
  const { t } = useTranslation();
  const { language } = usePrefs();
  const allEntries = useMemo(() => showcaseEntries().slice(0, SHOWCASE_MAX), []);
  const ordered = useMemo(() => {
    const portal = allEntries.find((e) => e.id === 'allay.builtin.portal-gate');
    return portal ? [portal, ...allEntries.filter((e) => e.id !== portal.id)] : allEntries;
  }, [allEntries]);
  const covers = useShowcaseCovers(language);
  const head = useReveal<HTMLDivElement>();
  const grid = useReveal<HTMLDivElement>(0.05);

  return (
    <section id={SECTION.templates} data-tl-clip="templates" data-tl-color="var(--stage-exit)" aria-labelledby="templates-title" className="relative pt-28 pb-8">
      <div className="ruler wrap pointer-events-none absolute inset-x-0 top-0 opacity-60" aria-hidden="true" />
      <span className="scene-watermark absolute top-8 left-[var(--gutter)] hidden lg:block" aria-hidden="true">
        SCENE 03
      </span>
      <div className="wrap relative">
        <div ref={head} className="reveal relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <span data-allay-anchor="templates" data-allay-facing="left" className="absolute -top-6 right-[8%] hidden size-1 lg:block" aria-hidden="true" />
          <div className="max-w-[34em]">
            <p className="t-mono text-fg-subtle">{t('site.templates.kicker')}</p>
            <h2 id="templates-title" className="t-h2 mt-4">
              {t('site.templates.title')}
            </h2>
          </div>
          <p className="t-body max-w-[29em] lg:pb-1">{t('site.templates.lead')}</p>
        </div>

        <div ref={grid} className="reveal mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-3 lg:gap-5">
          {ordered.map((entry, idx) => (
            <div key={entry.id} className={idx === 0 ? 'md:col-span-2 lg:col-span-2' : undefined} style={{ '--i': idx } as CSSProperties}>
              <Tile entry={entry} cover={covers[entry.id]} featured={idx === 0} wideCover={idx === 0} tallCover={idx === 1} />
            </div>
          ))}
          <div style={{ '--i': ordered.length } as CSSProperties}>
            <MoreTile />
          </div>
        </div>
      </div>

      <FilmRibbon />
    </section>
  );
}
