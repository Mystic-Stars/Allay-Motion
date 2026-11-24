// 剪辑点：全页唯一的整幅转场（docs/decisions.md 官网 · 第三版）。
// 盖在“分镜”和“试用”两节的接缝上的，就是应用的方块擦除模板本身——由桌面版的引擎在浏览器里实时渲染。
// 这正是成片在剪辑软件里的用法：盖在两段素材的接缝上。
// - 往下越过分界线（这一节的上沿过了视口 75%）时自动按时间完整播一遍（约 1.5 秒），不按滚动位置逐帧驱动，
//   停手也会播完；铺满的那一刻（剪辑点）才把下面的开场白显示出来，换的过程被方块完全挡住；
// - 快速跳过（这一节已经整个滚过去了才被发现）就直接落到终态，不补播；播的时候滚远了就停下、落到终态；
// - 往回滚不倒放：整节回到视口下方以后才干净地复位，下次往下走再播；
// - 一块固定在视口上的画布，pointer-events: none，不挡点击；不播的时候不渲染；
// - 引擎起不来（没有 WebGL2 等）或减少动效时，没有转场，开场白一直可见。
import { localize, type ParamValues } from '@allay/template-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { builtinEntries } from '../../host/templates';
import { SECTION } from '../links';
import { onFrame, track } from '../motion/frame';
import { usePrefs } from '../prefs';
import type { LivePreview } from '../engine/runtime';

const TEMPLATE = 'allay.builtin.block-wipe';
const IN = 0.6;
const HOLD = 0.24;
const OUT = 0.7;
const DURATION = IN + HOLD + OUT;
const CUT_TIME = IN + HOLD / 2;
/** 这一节的上沿（以视口高为单位）走到这里时触发 */
const TRIGGER = 0.75;

/**
 * 方块：一面安静的墙，亮色只零星点缀。深色主题是近黑的混凝土（夹一点黑曜石的纹理）上的钻石块和青金石，
 * 浅色主题是白色混凝土上的浮冰和钻石块。墙铺满时是平静的一块面，翻转时才看得出体积；品牌蓝的光扫过波前。
 */
function blocksFor(theme: 'dark' | 'light'): ParamValues['blocks'] {
  return theme === 'dark'
    ? [
        { id: 'minecraft:black_concrete', weight: 9 },
        { id: 'minecraft:obsidian', weight: 1 },
        { id: 'minecraft:diamond_block', weight: 1.2 },
        { id: 'minecraft:lapis_block', weight: 0.6 },
      ]
    : [
        { id: 'minecraft:white_concrete', weight: 9 },
        { id: 'minecraft:quartz_block', weight: 1 },
        { id: 'minecraft:packed_ice', weight: 1 },
        { id: 'minecraft:diamond_block', weight: 1 },
      ];
}

export function CutScene() {
  const { t } = useTranslation();
  const { reducedMotion, theme, language } = usePrefs();
  const sectionRef = useRef<HTMLElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hudTimeRef = useRef<HTMLSpanElement>(null);
  const clipBRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<LivePreview | null>(null);
  const [near, setNear] = useState(false);
  const [ready, setReady] = useState(false);
  const entry = useMemo(() => builtinEntries().find((e) => e.id === TEMPLATE), []);
  const enabled = !reducedMotion && entry !== undefined;

  // 快到这里时才启动引擎（离视口三屏，访客还在分镜里时就开始，滚到这里时已经好了）
  useEffect(() => {
    const el = sectionRef.current;
    if (!el || !enabled || near) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '300% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, near]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!near || !canvas || !entry) return;
    let disposed = false;
    let live: LivePreview | null = null;
    void (async () => {
      const rt = await import('../engine/runtime');
      if (disposed || !rt.hasWebgl2()) return;
      try {
        live = await rt.LivePreview.create(canvas);
      } catch (error) {
        console.warn('[cut] engine failed to start', error);
        return;
      }
      if (disposed) {
        live.dispose();
        return;
      }
      live.loop = false;
      live.setPlaying(false);
      live.setVisible(false);
      liveRef.current = live;
      setReady(true);
    })();
    return () => {
      disposed = true;
      liveRef.current = null;
      setReady(false);
      live?.dispose();
    };
  }, [near, entry]);

  // 装载：按视口的宽高比、当前主题的方块；尺寸变了重新装
  useEffect(() => {
    const live = liveRef.current;
    const canvas = canvasRef.current;
    if (!ready || !live || !entry || !canvas) return;
    const load = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const portrait = vh > vw;
      const width = portrait ? 1080 : 1920;
      const height = Math.round((width * vh) / vw / 2) * 2;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      live.resize(vw * dpr, vh * dpr);
      void live.show(entry, language, {
        blocks: blocksFor(theme),
        cols: portrait ? 6 : vw < 1280 ? 9 : 11,
        style: '3d',
        inPattern: 'bottomToTop',
        outPattern: 'same',
        inDuration: IN,
        hold: HOLD,
        outDuration: OUT,
        overlap: 0.55,
        jitter: 0.32,
        spin: 'flipX',
        seed: 7,
      }, { width, height });
    };
    load();
    let timer = 0;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(load, 200);
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.clearTimeout(timer);
    };
  }, [ready, entry, theme, language]);

  // 越过分界线 → 自动完整播一遍。状态：idle（等着）→ playing（在播）→ done（播完，开场白可见）
  useEffect(() => {
    const section = sectionRef.current;
    const overlay = overlayRef.current;
    const clipB = clipBRef.current;
    if (!section || !overlay || !clipB || !enabled) return;
    const g = track(section);
    let state: 'idle' | 'playing' | 'done' = 'idle';
    /** 开始播的时刻：模板时间按墙上时钟算（掉帧也按时播完，不会因为帧率低拖长） */
    let startAt = 0;
    let shown: boolean | null = null;
    let lastHud = '';
    const showB = (v: boolean) => {
      if (v === shown) return;
      shown = v;
      clipB.style.visibility = v ? 'visible' : 'hidden';
    };
    const set = (next: typeof state) => {
      state = next;
      overlay.dataset.active = String(next === 'playing');
      section.dataset.settled = String(next !== 'playing');
      section.dataset.cutState = next;
      liveRef.current?.setVisible(next === 'playing');
    };
    set('idle');
    const off = onFrame((s) => {
      const top = (g.geometry.top - s.y) / s.vh;
      const live = liveRef.current;
      if (!ready || !live) {
        // 引擎没起来（还在起、或者没有 WebGL）：没有转场，开场白一直可见；整节滚过去了就算终态（跳过时不补播）
        showB(true);
        if (state === 'idle' && top < -0.5) set('done');
        else if (state === 'done' && top > 1.05) set('idle');
        return;
      }
      if (state === 'idle') {
        if (top < -0.5) {
          // 已经整个滚过去了（拖滚动条、锚点跳转、连按 PageDown）：直接落到终态，不补播
          set('done');
          showB(true);
        } else if (top < TRIGGER) {
          live.setPlaying(false);
          live.seek(0);
          startAt = s.now;
          set('playing');
          showB(false);
        } else showB(false);
        return;
      }
      if (state === 'playing') {
        if (top > 1.2 || top < -1.6) {
          // 播的时候滚远了：停下，落到终态（往上滚远就复位）
          set(top > 1.2 ? 'idle' : 'done');
          showB(top <= 1.2);
          return;
        }
        const time = Math.min(DURATION, (s.now - startAt) / 1000);
        live.seek(time);
        if (time >= CUT_TIME) showB(true);
        const hud = `${time.toFixed(2)} / ${DURATION.toFixed(2)} s`;
        if (hud !== lastHud && hudTimeRef.current) {
          lastHud = hud;
          hudTimeRef.current.textContent = hud;
        }
        if (time >= DURATION) {
          set('done');
          showB(true);
        }
        return;
      }
      // done：开场白一直可见；整节回到视口下方以后才复位
      showB(true);
      if (top > 1.05) set('idle');
    });
    return () => {
      off();
      g.untrack();
    };
  }, [enabled, ready]);

  // 测试钩子：剪辑点那一刻画面是否铺满（读引擎的像素）
  useEffect(() => {
    if (!ready || !new URLSearchParams(window.location.search).has('e2e')) return;
    (window as unknown as { __siteCut?: unknown }).__siteCut = {
      cutTime: CUT_TIME,
      duration: DURATION,
      time: () => liveRef.current?.currentTime ?? -1,
      playing: () => liveRef.current?.isPlaying ?? false,
      coverage: async (time: number) => {
        const px = await liveRef.current?.readPixels(time);
        if (!px) return -1;
        let opaque = 0;
        let n = 0;
        for (let i = 3; i < px.length; i += 4 * 97) {
          n++;
          if (px[i]! > 250) opaque++;
        }
        return n > 0 ? opaque / n : -1;
      },
    };
  }, [ready]);

  const name = entry ? localize(entry.manifest.name, language) : '';

  return (
    <section ref={sectionRef} id={SECTION.cut} data-cut data-motion="cut" data-settled="true" aria-labelledby="cut-title" className="relative">
      <div className="relative flex min-h-[100svh] items-center overflow-hidden py-28">
        <div className="pointer-events-none absolute inset-0 bg-grid fade-mask opacity-60" aria-hidden="true" />
        <div ref={clipBRef} className="wrap relative">
          {/* 给剪辑点 ◆ 留的空白（motion/world 把方块拼在这个框里）：标题右边 */}
          <div data-voxel-slot="cut" aria-hidden="true" className="pointer-events-none absolute top-1/2 right-0 hidden h-[min(60vh,560px)] w-[24vw] -translate-y-1/2 lg:block" />
          <span data-allay-anchor="cut" data-allay-facing="right" className="absolute right-[30vw] bottom-[-12%] hidden size-1 lg:block" aria-hidden="true" />
          <p className="t-mono flex items-center gap-3 text-fg-subtle">
            <span className="inline-block size-2 rotate-45 rounded-[1.5px] bg-mark" aria-hidden="true" />
            {t('site.cut.kicker')}
          </p>
          <h2 id="cut-title" className="t-display mt-6 max-w-[11em]">
            {t('site.cut.titleA')}
            <br />
            <span className="accent">{t('site.cut.titleB')}</span>
          </h2>
          <p className="t-lead mt-8 max-w-[32em]">{t('site.cut.body', { template: name })}</p>
        </div>
      </div>

      {enabled && (
        <div ref={overlayRef} data-active="false" className="cut-overlay pointer-events-none fixed inset-0 z-40" data-testid="cut-overlay" aria-hidden="true">
          <canvas ref={canvasRef} className="absolute inset-0 size-full" />
          <div className="float absolute bottom-5 left-[var(--gutter)] flex items-center gap-3 px-3.5 py-2 text-[12px]">
            <span className="inline-block size-2 rotate-45 rounded-[1.5px] bg-mark" />
            <span className="font-medium">{t('site.cut.hud', { template: name })}</span>
            <span ref={hudTimeRef} className="t-tab text-fg-subtle">
              0.00 / {DURATION.toFixed(2)} s
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
