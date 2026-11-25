// 剪辑点：全页唯一的一处整幅实时转场。
// 盖在“工作流”与“互动试玩台”两节接缝上的，就是应用的方块擦除模板本身（桌面引擎实时渲染，pointer-events: none 不挡点击）。
// 越过分界线自动按时间完整播完约 1.54s，铺满那一刻切换下方开场白；快速跳过直接落到终态，不补播。
import { localize, type ParamValues } from '@allay/template-sdk';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { showcaseEntries } from '../../host/templates';
import { LivePreview, hasWebgl2 } from '../engine/runtime';
import { SECTION } from '../links';
import { onFrame, track } from '../motion/frame';
import { usePrefs } from '../prefs';

const TEMPLATE = 'allay.builtin.block-wipe';
const IN = 0.6;
const HOLD = 0.24;
const OUT = 0.7;
const DURATION = IN + HOLD + OUT;
const CUT_TIME = IN + HOLD / 2;
const TRIGGER = 0.75;

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
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const hudTimeRef = useRef<HTMLSpanElement>(null);
  const clipBRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<LivePreview | null>(null);
  const [near, setNear] = useState(false);
  const [ready, setReady] = useState(false);
  const entry = useMemo(() => showcaseEntries().find((e) => e.id === TEMPLATE), []);
  const enabled = !reducedMotion && entry !== undefined;

  useEffect(() => {
    const el = sectionRef.current;
    if (!el || !enabled || near) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setNear(true), { rootMargin: '250% 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [enabled, near]);

  useEffect(() => {
    const host = canvasHostRef.current;
    if (!near || !host || !entry || !hasWebgl2()) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'block size-full';
    host.replaceChildren(canvas);

    let disposed = false;
    let live: LivePreview | null = null;
    void (async () => {
      try {
        live = await LivePreview.create(canvas);
      } catch (error) {
        if (!disposed) console.warn('[cut] engine failed to start', error);
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
      canvas.remove();
    };
  }, [near, entry]);

  useEffect(() => {
    const live = liveRef.current;
    if (!ready || !live || !entry) return;
    const load = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const portrait = vh > vw;
      const width = portrait ? 1080 : 1920;
      const height = Math.max(2, Math.round((width * vh) / vw / 2) * 2);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      live.resize(vw * dpr, vh * dpr);
      void live.show(
        entry,
        language,
        {
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
        },
        { width, height },
      );
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

  useEffect(() => {
    const section = sectionRef.current;
    const overlay = overlayRef.current;
    const clipB = clipBRef.current;
    if (!section || !overlay || !clipB || !enabled) return;
    const g = track(section);
    let state: 'idle' | 'playing' | 'done' = 'idle';
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
        showB(true);
        if (state === 'idle' && top < -0.5) set('done');
        else if (state === 'done' && top > 1.05) set('idle');
        return;
      }
      if (state === 'idle') {
        if (top < -0.5) {
          set('done');
          showB(true);
        } else if (top < TRIGGER) {
          live.setPlaying(false);
          live.seek(0);
          startAt = s.now;
          set('playing');
          showB(false);
        } else {
          showB(false);
        }
        return;
      }
      if (state === 'playing') {
        if (top > 1.2 || top < -1.6) {
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
      showB(true);
      if (top > 1.05) set('idle');
    });
    return () => {
      off();
      g.untrack();
    };
  }, [enabled, ready]);

  const name = entry ? localize(entry.manifest.name, language) : '';

  return (
    <section ref={sectionRef} id={SECTION.cut} data-cut data-motion="cut" data-settled="true" data-cut-state="idle" aria-labelledby="cut-title" className="relative">
      <div className="relative flex min-h-[92svh] items-center overflow-hidden py-24">
        <div className="pointer-events-none absolute inset-0 bg-grid fade-mask opacity-60" aria-hidden="true" />
        <div ref={clipBRef} className="wrap relative">
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
          <div ref={canvasHostRef} className="absolute inset-0 size-full" />
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
