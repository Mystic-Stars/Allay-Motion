// 一块只有画面的实时渲染（没有面板外框）：精选模板的大格、特性一节的透明通道演示用它。
// 和首屏预览一样是桌面版的 EngineHost（预览模式），按显示尺寸 × 设备像素比渲染，所以放大了也清楚（封面的帧网格只有 320×180）。
// 生命周期跟着视口走：离视口一屏半时才启动，离开三屏就销毁（全页同时活着的实时引擎不超过两三个）；
// 没有 WebGL2、启动失败、减少动效时退回 fallback（封面的静帧）。
import { localize, type ParamValues } from '@allay/template-sdk';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { builtinEntries } from '../../host/templates';
import { usePrefs } from '../prefs';
import type { LivePreview } from '../engine/runtime';

export function LiveCanvas({ templateId, params, fallback, className, testId }: { templateId: string; params?: ParamValues; fallback?: ReactNode; className?: string; testId?: string }) {
  const { language, reducedMotion } = usePrefs();
  const wrapRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<LivePreview | null>(null);
  const [near, setNear] = useState(false);
  const [ready, setReady] = useState(false);
  const entry = useMemo(() => builtinEntries().find((e) => e.id === templateId), [templateId]);
  const paramsKey = params ? JSON.stringify(params) : '';

  // 近了启动、远了销毁
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || reducedMotion) return;
    const io = new IntersectionObserver(
      (es) => {
        const e = es[0];
        if (!e) return;
        const r = e.boundingClientRect;
        const vh = window.innerHeight;
        if (r.bottom > -vh * 1.5 && r.top < vh * 2.5) setNear(true);
        else if (r.bottom < -vh * 3 || r.top > vh * 4) setNear(false);
      },
      { rootMargin: '300% 0px', threshold: [0, 0.01, 0.5, 1] },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [reducedMotion]);

  useEffect(() => {
    const host = hostRef.current;
    if (!near || !host || !entry) return;
    // 每次启动用一块新画布（控制权交给 Worker 之后旧画布就不能再用了），销毁时一并移走
    const canvas = document.createElement('canvas');
    canvas.className = 'absolute inset-0 size-full';
    host.appendChild(canvas);
    let disposed = false;
    let live: LivePreview | null = null;
    let ro: ResizeObserver | null = null;
    let io: IntersectionObserver | null = null;
    void (async () => {
      const rt = await import('../engine/runtime');
      if (disposed || !rt.hasWebgl2()) return;
      try {
        live = await rt.LivePreview.create(canvas);
      } catch (error) {
        console.warn('[live-canvas] engine failed to start', error);
        return;
      }
      if (disposed) {
        live.dispose();
        return;
      }
      liveRef.current = live;
      const size = () => {
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        live?.resize(canvas.clientWidth * dpr, canvas.clientHeight * dpr);
      };
      size();
      ro = new ResizeObserver(size);
      ro.observe(canvas);
      io = new IntersectionObserver((es) => live?.setVisible(es.some((x) => x.isIntersecting)));
      io.observe(canvas);
      setReady(true);
    })();
    return () => {
      disposed = true;
      ro?.disconnect();
      io?.disconnect();
      liveRef.current = null;
      live?.dispose();
      canvas.remove();
      setReady(false);
    };
  }, [near, entry]);

  useEffect(() => {
    const live = liveRef.current;
    if (!ready || !live || !entry) return;
    void live.show(entry, language, paramsKey ? (JSON.parse(paramsKey) as ParamValues) : undefined).catch((error: unknown) => console.warn('[live-canvas] load failed', error));
  }, [ready, entry, language, paramsKey]);

  const label = entry ? localize(entry.manifest.name, language) : undefined;
  return (
    <div ref={wrapRef} className={className ?? 'relative'} data-testid={testId} data-live={ready}>
      {!ready && fallback}
      {!reducedMotion && <div ref={hostRef} className="absolute inset-0" aria-label={label} role="img" />}
    </div>
  );
}
