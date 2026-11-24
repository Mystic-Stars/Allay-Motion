// 全页唯一的帧循环（悦灵的帧循环在 packages/mascot 里另有一个，它只管悦灵自己的画帧）。
// 滚动驱动的东西（时间轴导航的播放头、首屏到分镜的主视觉、剪辑点的转场、悦灵的飞行）都在这里订阅：
// - 每帧先跑所有“读”回调，再跑所有“写”回调，读写不交错，不会强制重排；
// - 元素在文档里的位置只在尺寸变化、字体载入、页面载入时量（track），循环里只用 scrollY 推算；
// - 指针位置来自 pointermove，循环里只读变量。
// 没有订阅者时循环停下。

export interface FrameState {
  now: number;
  /** 距上一帧的实际秒数；数值积分在使用处限制步长 */
  dt: number;
  /** 页面滚动位置（CSS 像素） */
  y: number;
  vw: number;
  vh: number;
  /** 指针的视口坐标；没有指针（触屏、还没动过）时为 null */
  pointer: { x: number; y: number } | null;
}

type Fn = (s: FrameState) => void;

const reads = new Set<Fn>();
const writes = new Set<Fn>();
let handle = 0;
let last = 0;
const state: FrameState = { now: 0, dt: 0, y: 0, vw: 1, vh: 1, pointer: null };

function loop(now: number): void {
  handle = 0;
  state.dt = last ? Math.max(0, (now - last) / 1000) : 0;
  last = now;
  state.now = now;
  state.y = window.scrollY;
  state.vw = window.innerWidth;
  state.vh = window.innerHeight;
  for (const fn of reads) fn(state);
  for (const fn of writes) fn(state);
  if (reads.size + writes.size > 0) handle = requestAnimationFrame(loop);
}

function kick(): void {
  if (handle === 0 && reads.size + writes.size > 0) {
    last = 0;
    handle = requestAnimationFrame(loop);
  }
}

/** 每帧调用 fn（写阶段）；返回取消订阅 */
export function onFrame(fn: Fn): () => void {
  writes.add(fn);
  installPointer();
  kick();
  return () => {
    writes.delete(fn);
  };
}

/** 每帧调用 fn（读阶段，先于所有写）；只在确实要读布局时用 */
export function onFrameRead(fn: Fn): () => void {
  reads.add(fn);
  installPointer();
  kick();
  return () => {
    reads.delete(fn);
  };
}

/** 当前的状态（不在帧里时也能读，滚动位置是最新的） */
export function frameState(): FrameState {
  state.y = window.scrollY;
  state.vw = window.innerWidth;
  state.vh = window.innerHeight;
  return state;
}

let pointerInstalled = false;
function installPointer(): void {
  if (pointerInstalled) return;
  pointerInstalled = true;
  window.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType === 'touch') return;
      if (state.pointer) {
        state.pointer.x = e.clientX;
        state.pointer.y = e.clientY;
      } else state.pointer = { x: e.clientX, y: e.clientY };
    },
    { passive: true },
  );
  document.documentElement.addEventListener('pointerleave', () => (state.pointer = null));
}

// ---- 元素在文档里的位置 ----

export interface Geometry {
  /** 文档坐标（不随滚动变） */
  top: number;
  left: number;
  width: number;
  height: number;
}

const tracked = new Map<Element, Geometry>();
const geometryListeners = new Set<() => void>();
let ro: ResizeObserver | null = null;
let remeasureQueued = false;

function measure(): void {
  remeasureQueued = false;
  const sy = window.scrollY;
  const sx = window.scrollX;
  for (const [el, g] of tracked) {
    const r = el.getBoundingClientRect();
    g.top = r.top + sy;
    g.left = r.left + sx;
    g.width = r.width;
    g.height = r.height;
  }
  for (const l of geometryListeners) l();
}

/** 下一帧之前重新量一遍（合并多次请求） */
export function remeasure(): void {
  if (remeasureQueued) return;
  remeasureQueued = true;
  queueMicrotask(measure);
}

let geometryInstalled = false;
function installGeometry(): void {
  if (geometryInstalled) return;
  geometryInstalled = true;
  ro = new ResizeObserver(remeasure);
  ro.observe(document.documentElement);
  window.addEventListener('resize', remeasure);
  window.addEventListener('load', remeasure);
  void document.fonts?.ready.then(remeasure);
}

/**
 * 跟踪一个元素在文档里的位置。返回的对象会被原地更新（尺寸变化、字体载入后），帧循环里直接读它的字段。
 * 注意：sticky 元素量到的是量的那一刻的位置，用它所在的外层（不 sticky 的）元素来算进度。
 */
export function track(el: Element): { geometry: Geometry; untrack: () => void } {
  installGeometry();
  let g = tracked.get(el);
  if (!g) {
    g = { top: 0, left: 0, width: 0, height: 0 };
    tracked.set(el, g);
    ro?.observe(el);
    const r = el.getBoundingClientRect();
    g.top = r.top + window.scrollY;
    g.left = r.left + window.scrollX;
    g.width = r.width;
    g.height = r.height;
  }
  const geometry = g;
  return {
    geometry,
    untrack: () => {
      if (tracked.get(el) === geometry) {
        tracked.delete(el);
        ro?.unobserve(el);
      }
    },
  };
}

export function onGeometryChange(fn: () => void): () => void {
  installGeometry();
  geometryListeners.add(fn);
  return () => {
    geometryListeners.delete(fn);
  };
}

/** 页面可以滚动的最大距离 */
export function maxScroll(): number {
  return Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
}

// ---- 小工具 ----

export const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
export const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
/** x 在 [a, b] 里的位置（0–1，夹住） */
export const range = (x: number, a: number, b: number) => clamp01((x - a) / (b - a || 1));
export const easeOutCubic = (x: number) => 1 - (1 - x) ** 3;
export const easeInOutCubic = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
export const easeOutExpo = (x: number) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x));

/**
 * 临界阻尼弹簧（不过冲、不抖）：把 value 以角频率 omega 拉向 target。返回新的 [值, 速度]。
 * 与帧率无关（按 dt 积分的解析解）。
 */
export function spring(value: number, velocity: number, target: number, omega: number, dt: number): [number, number] {
  const x = value - target;
  const e = Math.exp(-omega * dt);
  const nx = (x + (velocity + omega * x) * dt) * e;
  const nv = (velocity - omega * (velocity + omega * x) * dt) * e;
  return [target + nx, nv];
}
