// 加载中的骨架：一块 16:9 的方格，用方块擦除的节奏（中心扩散地弹出、停一下、再缩回）循环，颜色只用骨架和控件两档灰。
// 只在视口里时画；减少动效时是一块静止的骨架色。
import { useEffect, useRef } from 'react';
import { clamp01, easeOutBack, hash01, onThemeChange, tokenColor } from './tokens';
import { getPrefs } from '../prefs';

const COLS = 16;
const ROWS = 9;
const PERIOD = 2.2;

export function BlockSkeleton({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const g = canvas?.getContext('2d');
    if (!canvas || !g) return;
    const order = new Float32Array(COLS * ROWS);
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) order[r * COLS + c] = Math.min(1, Math.hypot((c - (COLS - 1) / 2) / COLS, (r - (ROWS - 1) / 2) / ROWS) * 1.5 + 0.15 * hash01(c, r, 5));
    let raf = 0;
    let visible = false;
    let base = tokenColor('--skeleton');
    let hi = tokenColor('--control');
    const draw = (now: number) => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.fillStyle = base;
      g.fillRect(0, 0, w, h);
      if (getPrefs().reducedMotion) return;
      const cw = w / COLS;
      const ch = h / ROWS;
      const t = (now / 1000) % PERIOD / PERIOD;
      g.fillStyle = hi;
      for (let i = 0; i < order.length; i++) {
        const o = order[i]! * 0.45;
        // 进入 0–0.5、退出 0.55–1：每格按自己的先后弹出又缩回
        const s = Math.min(easeOutBack(clamp01((t - o) / 0.2)), 1 - clamp01((t - 0.55 - o) / 0.2));
        if (s <= 0) continue;
        const sz = Math.min(cw, ch) * 0.82 * s;
        const x = (i % COLS) * cw + (cw - sz) / 2;
        const y = Math.floor(i / COLS) * ch + (ch - sz) / 2;
        g.fillRect(x, y, sz, sz);
      }
    };
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (visible) draw(now);
    };
    const io = new IntersectionObserver((es) => (visible = es.some((e) => e.isIntersecting)));
    io.observe(canvas);
    raf = requestAnimationFrame(loop);
    const off = onThemeChange(() => {
      base = tokenColor('--skeleton');
      hi = tokenColor('--control');
    });
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      off();
    };
  }, []);
  return <canvas ref={ref} aria-hidden="true" className={className} />;
}
