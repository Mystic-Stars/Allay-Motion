// 1:1 真实桌面应用试玩台（SimulatorSection）：
// 窗口内部运行的就是桌面版渲染进程本身（apps/desktop/src/renderer/main.tsx）：顶栏菜单、可拖拽分栏、左侧模板库（精选 8 模板）、
// 中央预览舞台、底部多段可拖时间轴、右侧数值擦除/方块选择器/预设属性面板，以及真实的“导出”弹窗与悦灵送达编排。
import { AllayLoader } from '@allay/mascot';
import { localize } from '@allay/template-sdk';
import { Button, buttonVariants } from '@allay/ui/components/button';
import { ArrowSquareOut, Monitor, X } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import type { EXPORT_PRESETS } from '../../../../desktop/src/shared/export';
import { FromSimulatorSchema, readMessage, type DesktopOnlyFeature, type ToSimulator } from '../../host/bridge';
import { mcTextureUrl } from '../../host/mc-pack';
import { showcaseEntries } from '../../host/templates';
import { REPO_URL, SECTION, TEMPLATE_ICON_IDS } from '../links';
import { useReveal } from '../motion/interactions';
import { setLanguage, setTheme, usePrefs } from '../prefs';
import { LiveViewer } from './LiveViewer';

const LOGICAL_W = 1280;
const LOGICAL_H = 820;
const WIDE_QUERY = '(min-width: 900px)';

function useWide(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = window.matchMedia(WIDE_QUERY);
      mq.addEventListener('change', fn);
      return () => mq.removeEventListener('change', fn);
    },
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
}

export const OPEN_TEMPLATE_EVENT = 'site:open-template';
export function requestOpenTemplate(id: string, version: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_TEMPLATE_EVENT, { detail: { id, version } }));
}

const PRESET_KEY: Record<(typeof EXPORT_PRESETS)[number], string> = {
  prores4444: 'prores',
  'png-sequence': 'png',
  'webm-vp9': 'webm',
  'greenscreen-mp4': 'greenscreen',
};

type Notice = { kind: 'desktop-only'; feature: DesktopOnlyFeature } | { kind: 'export'; frames: number; preset: string };

function simulatorUrl(theme: string, language: string): string {
  const q = new URLSearchParams({ theme, lang: language });
  if (new URLSearchParams(window.location.search).has('e2e')) q.set('e2e', '1');
  return `./simulator.html?${q.toString()}`;
}

function EditorSkeleton({ label }: { label: string }) {
  const panel = 'rounded-[10px] bg-surface-1';
  return (
    <div className="absolute inset-0 flex flex-col bg-background" data-testid="sim-skeleton">
      <div className="flex h-11 shrink-0 items-center gap-3 px-3">
        <span className="size-[22px] rounded-md bg-skeleton" />
        <span className="h-3 w-24 rounded bg-skeleton" />
        <span className="ml-auto h-7 w-28 rounded-md bg-skeleton" />
        <span className="mr-[150px] h-7 w-20 rounded-md bg-skeleton" />
      </div>
      <AllayLoader loading label={label} priority="preview" className="min-h-0 flex-1">
        <div className="flex size-full gap-1.5 px-1.5 pb-1.5">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex min-h-0 flex-1 gap-1.5">
              <div className={`${panel} w-[280px] shrink-0 p-3`}>
                <div className="grid grid-cols-2 gap-2">
                  {Array.from({ length: 6 }, (_, i) => (
                    <span key={i} className="aspect-video rounded-[7px] bg-skeleton" />
                  ))}
                </div>
              </div>
              <div className={`${panel} flex flex-1 items-center justify-center bg-viewer`}>
                <span className="aspect-video w-[62%] rounded-md bg-skeleton" />
              </div>
            </div>
            <div className={`${panel} h-[220px] shrink-0 p-3`}>
              <span className="block h-7 w-1/3 rounded bg-skeleton" />
              <span className="mt-5 block h-6 rounded bg-skeleton" />
              <span className="mt-3 block h-6 rounded bg-skeleton" />
            </div>
          </div>
          <div className={`${panel} w-[320px] shrink-0 p-3`}>
            {Array.from({ length: 9 }, (_, i) => (
              <span key={i} className="mt-3 block h-6 rounded bg-skeleton" />
            ))}
          </div>
        </div>
      </AllayLoader>
    </div>
  );
}

function SimulatorWindow() {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const entries = useMemo(() => showcaseEntries(), []);
  const outer = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [started, setStarted] = useState(false);
  const [ready, setReady] = useState(false);
  const [activeId, setActiveId] = useState<string>(entries[0]?.id ?? 'allay.builtin.block-wipe');
  const [box, setBox] = useState({ scale: 1, width: LOGICAL_W });
  const [notice, setNotice] = useState<Notice | null>(null);
  const pending = useRef<ToSimulator | null>(null);
  const [src, setSrc] = useState<string | null>(null);

  const post = (msg: ToSimulator) => frame.current?.contentWindow?.postMessage(msg, window.location.origin);

  useEffect(() => {
    const el = outer.current;
    if (!el || started) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setStarted(true), { rootMargin: '420px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [started]);

  useEffect(() => {
    if (started && src === null) setSrc(simulatorUrl(prefs.theme, prefs.language));
  }, [started, src, prefs.theme, prefs.language]);

  useEffect(() => {
    const el = outer.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (w >= LOGICAL_W) setBox({ scale: 1, width: Math.min(w, 1440) });
      else setBox({ scale: w / LOGICAL_W, width: LOGICAL_W });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const msg = readMessage(event, FromSimulatorSchema);
      if (!msg) return;
      if (msg.type === 'ready') {
        setReady(true);
        if (pending.current) post(pending.current);
        pending.current = null;
      } else if (msg.type === 'settings') {
        if (msg.theme !== document.documentElement.dataset.theme) setTheme(msg.theme);
        if (msg.language !== 'system' && msg.language !== document.documentElement.lang) setLanguage(msg.language);
      } else if (msg.type === 'desktop-only') {
        setNotice({ kind: 'desktop-only', feature: msg.feature });
      } else if (msg.type === 'export-finished') {
        const delay = document.documentElement.dataset.reducedMotion === 'true' ? 0 : 1600;
        window.setTimeout(() => setNotice({ kind: 'export', frames: msg.frames, preset: msg.preset }), delay);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    const el = outer.current;
    if (!ready || !el) return;
    const io = new IntersectionObserver((es) => post({ channel: 'allay-site', type: 'visibility', visible: es.some((e) => e.isIntersecting) }), { threshold: 0.15 });
    io.observe(el);
    return () => io.disconnect();
  }, [ready]);

  useEffect(() => {
    if (ready) post({ channel: 'allay-site', type: 'settings', theme: prefs.theme, language: prefs.language, reducedMotion: prefs.reducedMotion });
  }, [ready, prefs.theme, prefs.language, prefs.reducedMotion]);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<{ id: string; version: string }>).detail;
      const msg: ToSimulator = { channel: 'allay-site', type: 'select', id: detail.id, version: detail.version };
      setActiveId(detail.id);
      setStarted(true);
      if (ready) post(msg);
      else pending.current = msg;
      document.getElementById(SECTION.try)?.scrollIntoView({ behavior: prefs.reducedMotion ? 'auto' : 'smooth', block: 'start' });
    };
    window.addEventListener(OPEN_TEMPLATE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TEMPLATE_EVENT, onOpen);
  }, [ready, prefs.reducedMotion]);

  const selectQuickTemplate = (id: string, version: string) => {
    setActiveId(id);
    const msg: ToSimulator = { channel: 'allay-site', type: 'select', id, version };
    setStarted(true);
    if (ready) post(msg);
    else pending.current = msg;
  };

  const presetName = (p: string) => {
    const key = (PRESET_KEY as Record<string, string | undefined>)[p];
    return key ? t(`site.features.formats.names.${key}`) : p;
  };

  const height = Math.round(LOGICAL_H * box.scale);

  return (
    <div ref={outer} className="w-full">
      {/* 窗口上方快捷切模板胶囊：一键把 8 个精选代表作载入下方的真实桌面编辑器 */}
      <div
        className="site-scroll-x mx-auto mb-4 flex max-w-[1440px] items-center gap-1.5 overflow-x-auto rounded-[11px] border border-[var(--site-line)] bg-site-card/90 p-1.5"
        role="toolbar"
        aria-label={t('site.sim.quickPick')}
        data-testid="sim-quick-bar"
      >
        {entries.map((e) => {
          const on = e.id === activeId;
          const icon = mcTextureUrl(TEMPLATE_ICON_IDS[e.id] ?? '');
          return (
            <button
              key={e.id}
              type="button"
              aria-pressed={on}
              data-testid="sim-quick-pick"
              data-template={e.id}
              onClick={() => selectQuickTemplate(e.id, e.version)}
              className={`link-focus flex h-8 shrink-0 items-center gap-2 rounded-[7px] px-3 text-[12.5px] whitespace-nowrap transition-colors duration-150 ${
                on ? 'bg-control-hi font-semibold text-foreground' : 'text-fg-muted hover:bg-control hover:text-foreground'
              }`}
            >
              {icon && <img src={icon} alt="" width={15} height={15} className="pixelated size-[15px] shrink-0 rounded-[2px]" draggable={false} />}
              <span>{localize(e.manifest.name, prefs.language)}</span>
            </button>
          );
        })}
      </div>

      <div className="studio-bezel mx-auto" style={{ width: box.width * box.scale }}>
        <div className="site-window relative" style={{ height, width: box.width * box.scale }} data-testid="sim-window" aria-label={t('site.sim.frameLabel')}>
          {src ? (
            <div className="relative" style={{ width: box.width, height: LOGICAL_H, transform: `scale(${box.scale})`, transformOrigin: '0 0' }}>
              <iframe
                ref={frame}
                src={src}
                title={t('site.sim.frameLabel')}
                data-testid="sim-frame"
                className="block size-full border-0 transition-opacity duration-300 ease-(--ease-out)"
                style={{ colorScheme: 'normal', opacity: ready ? 1 : 0 }}
              />
              {!ready && <EditorSkeleton label={t('site.sim.starting')} />}
            </div>
          ) : (
            <div className="flex size-full flex-col items-center justify-center gap-4 bg-background p-6 text-center">
              <Monitor size={28} className="text-fg-faint" />
              <Button size="lg" onClick={() => setStarted(true)} data-testid="sim-start">
                {t('site.sim.start')}
              </Button>
              <p className="text-[13px] text-fg-subtle">{t('site.sim.autoStart')}</p>
            </div>
          )}

          {notice?.kind === 'desktop-only' && (
            <div className="absolute inset-x-0 bottom-10 z-10 flex justify-center px-4" role="status" data-testid="sim-desktop-only">
              <div className="float flex max-w-[560px] items-center gap-3 py-2.5 pr-2 pl-4 text-[13px]">
                <span>
                  <span className="font-medium">{t(`site.sim.desktopOnly.${notice.feature}`)}</span>{' '}
                  <span className="text-fg-muted">{t('site.sim.desktopOnlyHint')}</span>
                </span>
                <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className={buttonVariants({ variant: 'secondary', size: 'lg', className: 'shrink-0' })}>
                  {t('site.sim.getDesktop')}
                </a>
                <Button variant="ghost" size="icon-sm" aria-label={t('site.sim.dismiss')} onClick={() => setNotice(null)}>
                  <X size={14} />
                </Button>
              </div>
            </div>
          )}

          {notice?.kind === 'export' && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-scrim p-4" data-testid="sim-export-done">
              <div role="dialog" aria-modal="true" aria-labelledby="sim-export-title" className="float w-full max-w-[460px] p-6 shadow-dialog">
                <h3 id="sim-export-title" className="t-h3">
                  {t('site.sim.exportDoneTitle', { frames: notice.frames })}
                </h3>
                <p className="t-body mt-2">{t('site.sim.exportDone', { format: presetName(notice.preset), mascot: t('brand.mascot') })}</p>
                <div className="mt-5 flex justify-end gap-2">
                  <Button variant="ghost" size="lg" onClick={() => setNotice(null)}>
                    {t('site.sim.keepTrying')}
                  </Button>
                  <a href={REPO_URL} target="_blank" rel="noreferrer noopener" className={buttonVariants({ size: 'lg' })}>
                    {t('site.sim.getDesktop')}
                    <ArrowSquareOut size={16} />
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="t-mono mt-5 text-center text-[10.5px] text-fg-subtle">{t('site.sim.exportNote')}</p>
    </div>
  );
}

/**
 * 窄屏的紧凑试玩台：没有仿真器窗口时，模板卡片的“在仿真器里打开”由这里接住，
 * 切到该模板并滚到预览（与宽屏的仿真器、PR #14 的首屏 onPreview 行为一致）。
 */
function CompactSimulator() {
  const { t } = useTranslation();
  const { reducedMotion } = usePrefs();
  const [request, setRequest] = useState<{ id: string; seq: number } | null>(null);

  useEffect(() => {
    const onOpen = (e: Event) => {
      const { id } = (e as CustomEvent<{ id: string; version: string }>).detail;
      setRequest((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }));
      document.getElementById(SECTION.try)?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'start' });
    };
    window.addEventListener(OPEN_TEMPLATE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_TEMPLATE_EVENT, onOpen);
  }, [reducedMotion]);

  return (
    <div data-testid="sim-compact">
      <div className="card mb-4 p-5">
        <p className="text-[15px] font-semibold">{t('site.sim.compactTitle')}</p>
        <p className="t-body mt-1">{t('site.sim.compact')}</p>
      </div>
      <LiveViewer scrubbable testId="compact-viewer" requestPick={request} />
    </div>
  );
}

export function SimulatorSection() {
  const { t } = useTranslation();
  const wide = useWide();
  const head = useReveal<HTMLDivElement>();
  return (
    <section id={SECTION.try} data-tl-clip="try" data-tl-color="var(--stage-hold)" data-allay-nofly aria-labelledby="sim-title" className="relative overflow-x-clip pt-[6vh] pb-28">
      <span className="scene-watermark absolute top-4 right-[var(--gutter)] hidden lg:block" aria-hidden="true">
        SCENE 02
      </span>
      <div ref={head} className="wrap reveal relative grid items-end gap-6 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
        <div>
          <p className="t-mono text-primary-text">{t('site.sim.kicker')}</p>
          <h2 id="sim-title" className="t-h2 mt-4 !text-[clamp(30px,3.6vw,58px)]">
            {t('site.sim.title')}
          </h2>
        </div>
        <p className="t-lead max-w-[36em]">{t('site.sim.lead')}</p>
      </div>
      <div className="relative mx-auto mt-10 w-full max-w-[1520px] px-[var(--gutter)] lg:px-6">
        {wide ? <SimulatorWindow /> : <CompactSimulator />}
      </div>
    </section>
  );
}
