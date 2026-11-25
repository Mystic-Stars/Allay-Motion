// 从设计变量读颜色给画布用（画布里不能写 var()）。主题一变（<html data-theme> 改了）就重新读。
import { useEffect, useState } from 'react';

const cache = new Map<string, string>();
let probe: HTMLSpanElement | null = null;

/** 设计变量（`--xxx`）或任意 CSS 颜色表达式（如 color-mix(...)）的实际颜色（浏览器解析后的结果） */
export function tokenColor(nameOrExpr: string): string {
  const hit = cache.get(nameOrExpr);
  if (hit) return hit;
  probe ??= Object.assign(document.createElement('span'), { hidden: true });
  if (!probe.isConnected) document.body.appendChild(probe);
  probe.style.color = nameOrExpr.startsWith('--') ? `var(${nameOrExpr})` : nameOrExpr;
  const c = getComputedStyle(probe).color;
  cache.set(nameOrExpr, c);
  return c;
}

const listeners = new Set<() => void>();
let observing = false;

function observe(): void {
  if (observing) return;
  observing = true;
  new MutationObserver(() => {
    cache.clear();
    for (const l of listeners) l();
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

export function onThemeChange(fn: () => void): () => void {
  observe();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 主题版本号：主题变了就加一（让画布重画） */
export function useThemeVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => onThemeChange(() => setV((n) => n + 1)), []);
  return v;
}

/** 确定性的散列（0–1），画面里的“随机”顺序都用它，刷新页面也一样 */
export function hash01(a: number, b: number, seed = 0): number {
  let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(seed + 1, 83492791)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
export const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
/** 方块弹出：略微过冲再回落（与方块擦除模板默认的出场缓动同一类） */
export const easeOutBack = (x: number) => {
  const c1 = 1.4;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
