// 特性一节（6 卡不对称 Bento 网格）：
// 1. 导出带透明通道：分界对比滑块（叠加浏览器引擎实时渲染的 block-wipe 半透明代表帧）；
// 2. 预览就是成片：双行 5 帧胶片同步步进（frame(t) = update(t)，离开视口自动暂停）；
// 3. 多种导出格式：桌面端四种导出预设；
// 4. 用你自己的素材：可点击锁定的三层资源栈 + CSS 3D 等轴测方块；
// 5. 完全离线与沙箱隔离：Worker 沙箱移除的全局对象划线演示；
// 6. 模板可以扩展：真实 manifest 参数 JSON 与交互式 Slider 对照。
import { localize } from '@allay/template-sdk';
import { Button } from '@allay/ui/components/button';
import { Badge, Skeleton } from '@allay/ui/components/misc';
import { Slider } from '@allay/ui/components/slider';
import { Export as ExportIcon, FilmStrip, PlugsConnected, PuzzlePiece, Stack, WifiSlash } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { REMOVED_GLOBALS } from '../../../../../packages/engine/src/harden';
import { mcTextureUrl } from '../../host/mc-pack';
import { showcaseEntries } from '../../host/templates';
import { COVER_H, COVER_W, useShowcaseCovers, type ShowcaseCover } from '../engine/covers';
import { SECTION, SITE_EXPORT_FORMATS } from '../links';
import { useReveal } from '../motion/interactions';
import { usePrefs } from '../prefs';

const ALPHA_TEMPLATE = 'allay.builtin.block-wipe';

function Card({
  icon,
  title,
  body,
  children,
  className,
  testId,
  style,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  children?: ReactNode;
  className?: string;
  testId?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={className} style={style}>
      <article className="card card-spotlight flex h-full flex-col p-6 sm:p-7" data-testid={testId}>
        <div className="relative z-[1] flex flex-1 flex-col">
          <span className="flex size-9 items-center justify-center rounded-lg bg-control text-fg-muted">{icon}</span>
          <h3 className="t-h3 mt-5">{title}</h3>
          <p className="t-body mt-2 max-w-[36em]">{body}</p>
          {children}
        </div>
      </article>
    </div>
  );
}

function Footage() {
  return (
    <div className="preview-footage absolute inset-0">
      <div className="absolute top-[52%] left-[64%] aspect-square w-[11%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#ffe3a8] opacity-90 blur-[2px]" />
      <div
        className="absolute inset-x-0 bottom-0 h-[42%] bg-[#3b3157]"
        style={{ clipPath: 'polygon(0 40%, 12% 22%, 24% 38%, 38% 12%, 52% 34%, 66% 18%, 80% 36%, 92% 20%, 100% 30%, 100% 100%, 0 100%)' }}
      />
      <div
        className="absolute inset-x-0 bottom-0 h-[26%] bg-[#231d38]"
        style={{ clipPath: 'polygon(0 30%, 18% 50%, 34% 24%, 50% 46%, 70% 20%, 86% 44%, 100% 26%, 100% 100%, 0 100%)' }}
      />
    </div>
  );
}

function CoverOverlay({ cover, label }: { cover: ShowcaseCover | null | undefined; label: string }) {
  if (cover === undefined) return <Skeleton className="absolute inset-0 size-full rounded-none opacity-40" />;
  if (cover === null) return null;
  return <img src={cover.url} alt={label} className="pointer-events-none absolute inset-0 size-full object-cover" draggable={false} />;
}

function AlphaDemo() {
  const { t } = useTranslation();
  const { language } = usePrefs();
  const [split, setSplit] = useState(50);
  const covers = useShowcaseCovers(language);
  const cover = covers[ALPHA_TEMPLATE];

  return (
    <div className="relative mt-auto pt-6">
      <div className="relative aspect-video overflow-hidden rounded-md ring-1 ring-[var(--site-line)] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--ring)]">
        <div className="preview-checker absolute inset-0" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} />
        <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${split}%)` }}>
          <Footage />
        </div>
        <CoverOverlay cover={cover} label={t('site.features.alpha.title')} />
        <Badge className="absolute top-3 left-3">{t('site.features.alpha.transparent')}</Badge>
        <Badge className="absolute top-3 right-3">{t('site.features.alpha.over')}</Badge>
        <div className="pointer-events-none absolute inset-y-0 w-0" style={{ left: `${split}%` }} aria-hidden="true">
          <div className="absolute inset-y-0 -left-px w-[2px] bg-foreground" />
          <div className="float absolute top-1/2 left-0 flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center !rounded-full text-foreground">
            <span className="text-[13px] font-semibold">⇆</span>
          </div>
        </div>
        <input
          type="range"
          min={4}
          max={96}
          value={split}
          aria-valuetext={`${split}%`}
          onChange={(e) => setSplit(Number(e.currentTarget.value))}
          data-testid="alpha-split"
          className="link-focus absolute inset-0 size-full cursor-ew-resize opacity-0"
          aria-label={t('site.features.alpha.drag')}
        />
      </div>
      <p className="t-mono mt-3 text-[10px] text-fg-subtle">
        {t('site.features.alpha.drag')} · {t('site.features.alpha.footage')}
      </p>
    </div>
  );
}

function FramesDemo() {
  const { t } = useTranslation();
  const { language, reducedMotion } = usePrefs();
  const covers = useShowcaseCovers(language);
  const cover = covers[ALPHA_TEMPLATE];
  const N = 5;
  const rootRef = useRef<HTMLDivElement>(null);
  const strips = useRef<(HTMLCanvasElement | null)[]>([]);
  const [hot, setHot] = useState(2);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const sheet = cover?.sheet;
    if (!cover || !sheet) return;
    strips.current.forEach((c, k) => {
      const g = c?.getContext('2d');
      if (!g) return;
      const i = Math.min(cover.frames - 1, Math.round(((k % N) + 0.5) * (cover.frames / N)));
      g.clearRect(0, 0, COVER_W, COVER_H);
      g.drawImage(sheet, (i % cover.cols) * COVER_W, Math.floor(i / cover.cols) * COVER_H, COVER_W, COVER_H, 0, 0, COVER_W, COVER_H);
    });
  }, [cover]);

  useEffect(() => {
    if (reducedMotion || !visible) return;
    const id = window.setInterval(() => setHot((h) => (h + 1) % N), 620);
    return () => window.clearInterval(id);
  }, [reducedMotion, visible]);

  const frameNo = cover ? Math.round((hot + 0.5) * (cover.frames / N)) : hot;

  return (
    <div ref={rootRef} className="mt-auto space-y-2 pt-6" aria-hidden="true">
      <div className="mb-5 flex items-end justify-between gap-4">
        <span className="t-tab text-[clamp(52px,5.6vw,86px)] leading-none font-medium tracking-[-0.06em] text-foreground">
          <span className="text-fg-subtle">#</span>
          {String(frameNo).padStart(3, '0')}
        </span>
        <span className="t-mono pb-2 text-right text-[10px] text-primary-text">
          {t('site.features.frames.preview')} = {t('site.features.frames.export')}
        </span>
      </div>
      {(['preview', 'export'] as const).map((row, r) => (
        <div key={row} className="flex items-center gap-3">
          <span className="t-mono w-16 shrink-0 text-[10px] text-fg-subtle">{t(`site.features.frames.${row}`)}</span>
          <div className="relative grid flex-1 grid-cols-5 gap-1.5">
            {Array.from({ length: N }, (_, k) => (
              <div
                key={k}
                className={`preview-checker relative aspect-video overflow-hidden rounded-[5px] transition-[box-shadow,opacity] duration-300 ${
                  k === hot ? 'opacity-100 ring-2 ring-primary' : 'opacity-55'
                }`}
              >
                <canvas
                  ref={(el) => {
                    strips.current[r * N + k] = el;
                  }}
                  width={COVER_W}
                  height={COVER_H}
                  className="absolute inset-0 size-full object-cover"
                />
              </div>
            ))}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-3 pt-2">
        <span className="w-16 shrink-0" />
        <div className="relative h-5 flex-1">
          <div className="absolute top-1/2 h-px w-full bg-[var(--site-line-hi)]" />
          <div
            className="absolute top-0 bottom-0 w-[2px] rounded bg-primary transition-[left] duration-500 ease-(--ease-expo)"
            style={{ left: `${((hot + 0.5) / N) * 100}%` }}
          />
        </div>
      </div>
      <p className="t-mono pl-[76px] text-[10px] text-primary-text">
        {t('site.features.frames.same')} · frame(t) = update(t)
      </p>
    </div>
  );
}

function FormatsDemo() {
  const { t } = useTranslation();
  return (
    <ul className="mt-5 flex-1 space-y-1.5" data-testid="format-list">
      {SITE_EXPORT_FORMATS.map((item) => (
        <li key={item.id} className="rounded-md px-3 py-2.5 transition-colors duration-(--dur-1) hover:bg-control">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[14px] font-medium">{t(`site.features.formats.names.${item.key}`)}</span>
            <Badge className="t-tab">{item.ext}</Badge>
          </div>
          <p className="mt-1 text-[12.5px] text-fg-subtle">{t(`site.features.formats.apps.${item.key}`)}</p>
        </li>
      ))}
    </ul>
  );
}

function StackDemo() {
  const { t } = useTranslation();
  const { reducedMotion } = usePrefs();
  const layers = t('site.features.stack.layers', { returnObjects: true }) as string[];
  const [autoLayer, setAutoLayer] = useState(2);
  const [selected, setSelected] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => setVisible(es.some((e) => e.isIntersecting)));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reducedMotion || selected !== null || !visible) return;
    const id = window.setInterval(() => setAutoLayer((v) => (v + 1) % 3), 1800);
    return () => window.clearInterval(id);
  }, [reducedMotion, selected, visible]);

  const active = selected ?? autoLayer;
  const diamond = mcTextureUrl('minecraft:block/diamond_block');
  const swatch = (i: number): CSSProperties =>
    i === 0 || !diamond
      ? { background: i === 2 ? '#9B85E8' : i === 1 ? '#52D6DC' : 'repeating-linear-gradient(45deg, #3f8fa8 0 4px, #4aa6c1 4px 8px)' }
      : { backgroundImage: `url(${diamond})`, backgroundSize: 'cover', imageRendering: 'pixelated', filter: i === 2 ? 'hue-rotate(115deg) saturate(1.3)' : undefined };

  return (
    <div ref={rootRef} className="mt-auto flex flex-1 items-center gap-5 pt-6">
      <div className="flex flex-1 flex-col-reverse gap-1.5">
        {[0, 1, 2].map((i) => (
          <Button
            key={i}
            type="button"
            variant="ghost"
            size="lg"
            data-testid="stack-layer"
            data-layer={i}
            onClick={() => setSelected(i)}
            className={`h-10 justify-start gap-3 transition-[opacity,transform,background-color] duration-300 ${i <= active ? 'opacity-100' : 'opacity-45'}`}
            aria-pressed={i === active}
          >
            <span className="t-mono w-4 text-[10px] text-fg-subtle">{i + 1}</span>
            <span className="pixelated size-6 shrink-0 rounded-[4px]" style={swatch(i)} />
            <span className={i === active ? 'font-medium text-foreground' : 'text-fg-muted'}>{layers[2 - i]}</span>
          </Button>
        ))}
      </div>

      <div className="relative size-[86px] shrink-0" style={{ perspective: '400px' }} aria-hidden="true">
        <div className="absolute inset-0" style={{ transformStyle: 'preserve-3d', transform: 'rotateX(-28deg) rotateY(38deg)' }}>
          {(['front', 'right', 'top'] as const).map((f) => (
            <span
              key={f}
              className="pixelated absolute inset-[18px] transition-[filter,background] duration-300"
              style={{
                ...swatch(active),
                transform: f === 'front' ? 'translateZ(25px)' : f === 'right' ? 'rotateY(90deg) translateZ(25px)' : 'rotateX(90deg) translateZ(25px)',
                filter: `${swatch(active).filter ?? ''} brightness(${f === 'top' ? 1.1 : f === 'right' ? 0.7 : 0.88})`,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function OfflineDemo() {
  const { t } = useTranslation();
  const ref = useReveal<HTMLUListElement>(0.25);
  return (
    <div className="mt-5 flex-1">
      <p className="t-mono text-[10px] text-fg-subtle">{t('site.features.offline.sandbox')}</p>
      <ul ref={ref} className="strike mt-3 grid grid-cols-2 gap-1.5">
        {REMOVED_GLOBALS.map((g, i) => (
          <li key={g} className="t-tab relative rounded-sm bg-control px-2.5 py-1.5 text-[11.5px] text-fg-muted" style={{ '--i': i } as CSSProperties}>
            {g}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExtendDemo() {
  const { language } = usePrefs();
  const param = useMemo(() => {
    const wipe = showcaseEntries().find((e) => e.id === ALPHA_TEMPLATE) ?? showcaseEntries()[0];
    return (wipe?.manifest.params ?? []).find(
      (p): p is Extract<typeof p, { min: number; max: number }> => p.key === 'cols' && 'min' in p && typeof p.min === 'number' && typeof p.max === 'number',
    );
  }, []);
  const [v, setV] = useState(14);
  if (!param) return null;
  const json = {
    key: param.key,
    type: param.type,
    label: param.label,
    default: param.default,
    min: param.min,
    max: param.max,
    ...(param.ui ? { ui: param.ui } : {}),
  };

  return (
    <div className="mt-6 grid flex-1 items-center gap-4 md:grid-cols-[1.35fr_auto_1fr] lg:max-w-[1040px]">
      <pre className="t-tab overflow-x-auto rounded-md bg-well p-4 text-[11.5px] leading-[1.6]" aria-label="manifest.json">
        {JSON.stringify(json, null, 2)
          .split('\n')
          .map((line, idx) => {
            const m = /^(\s*)("[^"]+")(:\s*)(.*)$/.exec(line);
            return (
              <span key={idx} className="block">
                {m ? (
                  <>
                    {m[1]}
                    <span className="text-primary-text">{m[2]}</span>
                    {m[3]}
                    <span className={/^"/.test(m[4]!) ? 'text-[var(--cue)]' : /^[\d.]/.test(m[4]!) ? 'text-[var(--mark)]' : 'text-fg-muted'}>{m[4]}</span>
                  </>
                ) : (
                  <span className="text-fg-subtle">{line}</span>
                )}
              </span>
            );
          })}
      </pre>
      <span className="t-mono hidden text-center text-[18px] text-fg-faint md:block" aria-hidden="true">
        →
      </span>
      <div className="float p-4">
        <div className="flex items-baseline justify-between text-[12.5px]">
          <span className="text-fg-muted">{localize(param.label, language)}</span>
          <span className="t-tab font-semibold text-foreground">{v}</span>
        </div>
        <Slider className="mt-1.5" value={v} min={param.min} max={param.max} step={1} thumbLabel={localize(param.label, language)} onValueChange={setV} />
        <div className="t-tab mt-2 flex justify-between text-[10px] text-fg-subtle">
          <span>{param.min}</span>
          <span>{param.max}</span>
        </div>
      </div>
    </div>
  );
}

export function FeaturesSection() {
  const { t } = useTranslation();
  const head = useReveal<HTMLDivElement>();
  const grid = useReveal<HTMLDivElement>(0.06);
  const i = (n: number) => ({ '--i': n }) as CSSProperties;

  return (
    <section id={SECTION.features} data-tl-clip="features" data-tl-color="var(--stage-enter)" aria-labelledby="features-title" className="relative py-28">
      <div className="ruler wrap pointer-events-none absolute inset-x-0 top-0 opacity-60" aria-hidden="true" />
      <span className="scene-watermark absolute top-8 right-[var(--gutter)] hidden lg:block" aria-hidden="true">
        SCENE 04
      </span>
      <div className="wrap relative">
        <div ref={head} className="reveal relative max-w-[900px]">
          <span data-allay-anchor="features" data-allay-facing="left" className="absolute -top-6 right-0 size-1 lg:-right-[18%]" aria-hidden="true" />
          <p className="t-mono text-fg-subtle">{t('site.features.kicker')}</p>
          <h2 id="features-title" className="t-h2 mt-4">
            {t('site.features.title')}
          </h2>
        </div>

        <div ref={grid} className="reveal mt-14 grid gap-4 md:grid-cols-2 lg:grid-cols-12 lg:gap-5">
          <Card icon={<FilmStrip size={20} weight="fill" />} title={t('site.features.alpha.title')} body={t('site.features.alpha.body')} className="md:col-span-2 lg:col-span-7" testId="feature-alpha" style={i(0)}>
            <AlphaDemo />
          </Card>
          <Card icon={<PlugsConnected size={20} weight="fill" />} title={t('site.features.frames.title')} body={t('site.features.frames.body')} className="lg:col-span-5" style={i(1)}>
            <FramesDemo />
          </Card>
          <Card icon={<ExportIcon size={20} weight="fill" />} title={t('site.features.formats.title')} body={t('site.features.formats.body')} className="lg:col-span-5" style={i(2)}>
            <FormatsDemo />
          </Card>
          <Card icon={<Stack size={20} weight="fill" />} title={t('site.features.stack.title')} body={t('site.features.stack.body')} className="lg:col-span-4" style={i(3)}>
            <StackDemo />
          </Card>
          <Card icon={<WifiSlash size={20} weight="fill" />} title={t('site.features.offline.title')} body={t('site.features.offline.body')} className="lg:col-span-3" style={i(4)}>
            <OfflineDemo />
          </Card>
          <Card icon={<PuzzlePiece size={20} weight="fill" />} title={t('site.features.extend.title')} body={t('site.features.extend.body')} className="md:col-span-2 lg:col-span-12" style={i(5)}>
            <ExtendDemo />
          </Card>
        </div>
      </div>
    </section>
  );
}
