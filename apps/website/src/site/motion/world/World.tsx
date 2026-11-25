// 全页共用的 3D 方块世界：一块固定在所有内容后面的全视口画布、一个 WebGL 上下文、挂在共享帧循环上（motion/world/world-scene.ts）。
// - 走到哪一节（视口中线落在哪一节里）由滚动决定，相机用弹簧飞到那一节的机位；方块给正文让位；
// - 页尾字标：按 DOM 里那段字的字体栅格化成点阵交给世界，方块对齐它拼出来；拼好以后 DOM 里的字只是变透明；
// - 背景的方块能玩（只在方块本身上按下才算，正文、按钮、链接、仿真器上的操作完全照旧，文字照样能选中）：
//   指针经过时方块不动（能抓的那块稍微放大一点）；按下不动再松开 = 单击，敲碎它；按下后移动超过 5 px = 拖，
//   手里的方块是磁铁，紧跟指针；屏幕上和它平齐、在它左右几块以内的方块被吸过来，“啪”地贴在左面或右面；
//   拖的时候滚轮照常滚页面（相机去下一节，方块跟着指针一起过去）；用力甩甩脱最外面那块；双击把一块从组里弹出去；
//   触摸屏上不抓不敲（不和滑动页面抢）；
// - 体素雕塑（sculpture.ts）：首屏的体素悦灵（从应用那只 3D 悦灵的同一份模型和原版贴图精确生成，原版贴图不在时不拼）、
//   剪辑点的 ◆、开源的时间线，放在各节 data-voxel-slot 留的空白里；指针划过拨开它的体素，空白处按下放冲击波，
//   在它的框里（没按在背景方块上）按住拖动转它；
// - 首屏的体素悦灵在场时带路的悦灵让位（bridge.ts）；拼出一大块时带路的悦灵飞过来看一眼；
// - 减少动效：只在首屏后面画一帧静止的画面（随页面滚走）；没有 WebGL 时什么也不画（文字照常、带路悦灵照常）。
import { whenMascotAssetsSettled } from '@allay/mascot';
import { ALLAY_TEXTURE_ID } from '@allay/mascot/model';
import { useEffect, useRef, useState } from 'react';
import { mcTexture, mcTextureUrl } from '../../../host/mc-pack';
import { usePrefs } from '../../prefs';
import { onFrame, onFrameRead, onGeometryChange, track, type Geometry } from '../frame';
import { allay3d, setSculptureExpected } from './bridge';
import type { Box, FormName, Tier, World as WorldScene, WordmarkGrid } from './world-scene';

/** 机位对应的各节（顺序就是世界里从上到下的顺序） */
const STATION_IDS = ['top', 'workflow', 'cut', 'try', 'templates', 'features', 'open-source', 'end'];

/** 正文：方块不能落在它们后面（卡片、面板本身是不透明的，挡得住，不用算） */
const TEXT = 'main h1, main h2, main h3, main p, main li, main [role=tablist], footer p:not([data-voxel-wordmark]), footer a, footer span';

/**
 * 一个元素里文字实际占的行框（只取文本节点的，不取子元素的盒子：标题里按行包的块级 span 和标题本身一样宽，
 * 按盒子算会把旁边给雕塑留的空白也当成文字）
 */
function textBoxes(el: Element, range: Range, fn: (r: DOMRect) => boolean | void): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.nodeValue?.trim()) continue;
    range.selectNodeContents(n);
    for (const r of range.getClientRects()) {
      if (r.width < 1 || r.height < 1) continue;
      if (fn(r) === true) return;
    }
  }
}

/** 正文在文档里的位置（文档坐标，每 4 个数一个框），尺寸变化、字体载入后重算；每帧减去滚动位置就是视口坐标 */
function collectTextRects(): Float32Array {
  const out: number[] = [];
  const sy = window.scrollY;
  const range = document.createRange();
  for (const el of document.querySelectorAll<HTMLElement>(TEXT)) {
    if (el.closest('.card, .monitor, [aria-hidden="true"]')) continue;
    textBoxes(el, range, (r) => {
      out.push(r.left - 10, r.top + sy - 6, r.right + 10, r.bottom + sy + 6);
    });
  }
  range.detach();
  return new Float32Array(out);
}

/** 不能当“空白处”的东西：在它们上面按下时不抓方块、不放冲击波、不转雕塑（事件照常落到 DOM 上） */
const INTERACTIVE = 'a,button,input,textarea,select,label,summary,iframe,[role=button],[role=tab],[role=slider],[contenteditable],.card,.monitor,pre,code,img,nav,header';
/** 文字：只有按在字上（行框里）才算文字，标题盒子右边空着的那一大块算空白 */
const TEXTY = 'p,h1,h2,h3,h4,li';

function onText(el: Element, x: number, y: number): boolean {
  let hit = false;
  textBoxes(el, document.createRange(), (r) => (hit = x >= r.left - 6 && x <= r.right + 6 && y >= r.top - 3 && y <= r.bottom + 3));
  return hit;
}


/** 字标的点阵，外加把它对齐到 DOM 里那段字所需的度量（都以字号为单位） */
interface WordmarkRaster extends WordmarkGrid {
  fontAscent: number;
  fontDescent: number;
  inkTop: number;
  inkLeft: number;
  cell: number;
}

function rasterizeWordmark(el: HTMLElement, px: number): WordmarkRaster | null {
  const text = el.textContent?.trim();
  if (!text) return null;
  const cs = getComputedStyle(el);
  const canvas = document.createElement('canvas');
  const g = canvas.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  const font = `${cs.fontWeight} ${px}px ${cs.fontFamily}`;
  g.font = font;
  const w = Math.ceil(g.measureText(text).width) + 4;
  canvas.width = w;
  canvas.height = Math.ceil(px * 1.4);
  g.font = font;
  g.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : `${(parseFloat(cs.letterSpacing) / parseFloat(cs.fontSize)) * px}px`;
  g.textBaseline = 'alphabetic';
  g.fillStyle = '#000';
  g.fillText(text, 1, px);
  const m = g.measureText(text);
  const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
  const cells: [number, number][] = [];
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3]! > 120) {
        cells.push([x, y]);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (cells.length === 0) return null;
  return {
    cols: maxX - minX + 1,
    rows: maxY - minY + 1,
    cells: cells.map(([x, y]) => [x - minX, y - minY]),
    fontAscent: m.fontBoundingBoxAscent / px,
    fontDescent: m.fontBoundingBoxDescent / px,
    inkTop: (px - minY) / px,
    inkLeft: (minX - 1) / px,
    cell: 1 / px,
  };
}

/** DOM 里那段字的墨迹框（视口坐标）：按行高算出基线，再按点阵的度量换算 */
function inkBox(el: HTMLElement, r: DOMRect, raster: WordmarkRaster): { left: number; top: number; height: number } {
  const cs = getComputedStyle(el);
  const fs = parseFloat(cs.fontSize);
  const lh = cs.lineHeight === 'normal' ? fs * (raster.fontAscent + raster.fontDescent) : parseFloat(cs.lineHeight);
  const baseline = r.top + parseFloat(cs.paddingTop) + (lh - (raster.fontAscent + raster.fontDescent) * fs) / 2 + raster.fontAscent * fs;
  return { left: r.left + parseFloat(cs.paddingLeft) + raster.inkLeft * fs, top: baseline - raster.inkTop * fs, height: raster.rows * raster.cell * fs };
}

/** 能不能起 WebGL2（探测用的上下文马上释放） */
function canWebgl2(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

/** PNG 字节 → 像素 */
async function decodeImage(png: Uint8Array): Promise<ImageData | null> {
  try {
    const bmp = await createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' }));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0);
    bmp.close();
    return g.getImageData(0, 0, c.width, c.height);
  } catch {
    return null;
  }
}

/** 一个框在视口里露出来的比例（nav 下面那一段） */
function visible(r: { top: number; height: number }, top: number, vh: number): number {
  if (r.height <= 1) return 0;
  return Math.max(0, Math.min(r.top + r.height, vh) - Math.max(r.top, top)) / r.height;
}

export function World() {
  const { theme, reducedMotion } = usePrefs();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<WorldScene | null>(null);
  const tierRef = useRef<Tier>('high');
  const [ready, setReady] = useState(false);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const rasterRef = useRef<WordmarkRaster | null>(null);

  // 起世界：懒加载 three 和场景；没有 WebGL 时什么也不做
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!canWebgl2()) return;
    // 原版悦灵贴图在不在（构建时就知道）：在才会拼体素悦灵
    const hasAllayTexture = mcTextureUrl(ALLAY_TEXTURE_ID) !== null;
    setSculptureExpected(hasAllayTexture);
    let alive = true;
    let ro: ResizeObserver | null = null;
    // 先让文字出来（首屏的入场动画），再起场景
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const { World: Scene, pickTier } = await import('./world-scene');
          if (!alive) return;
          const tier = pickTier();
          tierRef.current = tier;
          const narrow = window.innerWidth < 1024;
          const slotHeight = document.querySelector('[data-voxel-slot="allay"]')?.getBoundingClientRect().height || window.innerHeight * 0.4;
          const scene = await Scene.create(canvas, { theme: themeRef.current, narrow, tier, slotHeight });
          if (!alive) {
            scene.dispose();
            return;
          }
          sceneRef.current = scene;
          const size = () => {
            const dpr = tier === 'software' ? 1 : Math.min(window.innerWidth < 1024 ? 1.5 : 2, window.devicePixelRatio || 1);
            scene.resize(canvas.clientWidth * dpr, canvas.clientHeight * dpr);
          };
          size();
          ro = new ResizeObserver(size);
          ro.observe(canvas);
          canvas.dataset.tier = tier;
          canvas.dataset.instances = String(scene.sculpture?.instances ?? 0);
          canvas.dataset.allayVoxels = 'missing';
          // 原版悦灵贴图（与应用同一张）：装好后按它生成体素悦灵
          if (hasAllayTexture) {
            const r = await mcTexture(ALLAY_TEXTURE_ID);
            if (!alive) return;
            const img = r ? await decodeImage(r.png) : null;
            if (img) {
              scene.setAllayTexture(img);
              canvas.dataset.allayVoxels = 'ready';
            } else setSculptureExpected(false);
          }
          setReady(true);
          // 悦灵的图集（应用同一份烘焙产物）：装进世界以后，带路的悦灵改由世界来画
          const assets = await whenMascotAssetsSettled();
          if (!alive || assets.status !== 'ready') return;
          const cell = window.devicePixelRatio > 1.15 && assets.atlas.sizes.includes(288) ? 288 : 96;
          const res = await fetch(new URL(`mascot/allay-${cell}.png`, document.baseURI));
          if (!res.ok || !alive) return;
          const bitmap = await createImageBitmap(await res.blob());
          if (!alive) return;
          scene.setAllayAtlas(bitmap, { columns: assets.atlas.columns, size: cell });
          allay3d.ready = true;
        } catch (error) {
          console.warn('[world] 3D scene unavailable', error);
          setSculptureExpected(false);
        }
      })();
    }, 180);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      ro?.disconnect();
      allay3d.ready = false;
      allay3d.sculpture = null;
      allay3d.attention = null;
      setSculptureExpected(false);
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    // 远处融进页面底色：取 body 的背景色（主题切换后）
    const raf = requestAnimationFrame(() => scene.setTheme(theme, getComputedStyle(document.body).backgroundColor || (theme === 'dark' ? '#0b0b0c' : '#f4f4f5')));
    return () => cancelAnimationFrame(raf);
  }, [theme, ready]);

  // 页尾字标的点阵（语言、主题、字体载入后重新栅格化）
  useEffect(() => {
    const scene = sceneRef.current;
    if (!ready || !scene || reducedMotion) return;
    const el = document.querySelector<HTMLElement>('[data-voxel-wordmark]');
    if (!el) return;
    const apply = () => {
      const grid = rasterizeWordmark(el, 18);
      rasterRef.current = grid;
      if (grid) scene.setWordmark(grid);
    };
    apply();
    void document.fonts?.ready.then(apply);
  }, [ready, reducedMotion, theme]);

  // 每帧：读各节、占位框、字标的位置（读阶段），再交给世界画（写阶段）
  useEffect(() => {
    const scene = sceneRef.current;
    const canvas = canvasRef.current;
    if (!ready || !scene || !canvas) return;
    const root = document.documentElement;
    const still = reducedMotion;
    const stations = STATION_IDS.map((id) => document.getElementById(id));
    const tracked = stations.map((el) => (el ? track(el) : null));
    let slotEls = new Map<FormName, HTMLElement>();
    const findSlots = () => {
      slotEls = new Map();
      for (const el of document.querySelectorAll<HTMLElement>('[data-voxel-slot]')) slotEls.set(el.dataset.voxelSlot as FormName, el);
    };
    findSlots();
    const wordEl = document.querySelector<HTMLElement>('[data-voxel-wordmark]');
    let docRects = collectTextRects();
    const screenRects = new Float32Array(4096);
    const keepOut = new Float32Array(4);
    const recollect = () => {
      docRects = collectTextRects();
      findSlots();
    };
    const offGeo = onGeometryChange(recollect);
    const recollectTimer = window.setInterval(recollect, 2000);

    const slots: Partial<Record<FormName, Box | null>> = {};
    const vis: Partial<Record<FormName, number>> = {};
    let wordRect: { left: number; top: number; height: number } | null = null;
    let target: FormName = 'rest';
    let vw = window.innerWidth;
    let vh = window.innerHeight;
    // 指针轨迹（最近的在前）、冲击波、转雕塑
    const trailPts: { x: number; y: number; t: number; speed: number }[] = [];
    const trail = new Float32Array(16 * 4);
    const shocks: { x: number; y: number; t: number; k: number }[] = [];
    const shockBuf = new Float32Array(8);
    const turn = { yaw: 0, pitch: 0, vy: 0, vp: 0, on: false, x: 0, y: 0 };
    // 按在背景方块上：按下的位置和时刻、有没有拖起来、上一次单击（认双击）
    let press: { id: number; x: number; y: number; t: number; moved: boolean } | null = null;
    let lastClick: { id: number; t: number } | null = null;
    let pendingBreak = 0;
    let lastMove = { x: 0, y: 0, t: 0, speed: 0 };

    const offRead = onFrameRead((s) => {
      // 减少动效：画布贴在首屏上（随页面滚动），坐标换成相对画布的
      const base = still ? canvas.getBoundingClientRect() : null;
      vw = base ? base.width : s.vw;
      vh = base ? base.height : s.vh;
      const navH = still ? 0 : 56;
      for (const name of ['allay', 'cut', 'timeline'] as const) {
        const el = slotEls.get(name);
        const r = el?.getBoundingClientRect();
        if (!r || r.width < 2 || r.height < 2) {
          slots[name] = null;
          vis[name] = 0;
          continue;
        }
        const box = { left: r.left - (base?.left ?? 0), top: r.top - (base?.top ?? 0), width: r.width, height: r.height };
        slots[name] = box;
        vis[name] = visible(box, navH, vh);
      }
      const hasAllay = scene.sculpture?.hasAllay ?? false;
      // 首屏的占位框不显示（窄屏的减少动效版）或没有原版贴图时不拼体素悦灵，带路的悦灵照常用首屏的锚点
      setSculptureExpected(!!slots.allay && hasAllay);
      const raster = rasterRef.current;
      wordRect = null;
      if (wordEl && raster && !still) {
        const r = wordEl.getBoundingClientRect();
        wordRect = r.bottom > 0 && r.top < s.vh ? inkBox(wordEl, r, raster) : null;
      }
      if (still) {
        target = hasAllay ? 'allay' : 'rest';
        return;
      }
      // 换成露出最多的那个（至少露出六成）；当前的还露出三成以上、又没有明显更合适的，就留着（回差）
      const cur = target !== 'rest' ? (vis[target] ?? 0) : 0;
      let best: FormName = 'rest';
      let bestVis = 0.6;
      for (const name of ['allay', 'cut', 'timeline'] as const) {
        if (name === 'allay' && !hasAllay) continue;
        const v = vis[name] ?? 0;
        if (v >= bestVis) {
          best = name;
          bestVis = v;
        }
      }
      if (best !== target && cur >= 0.3 && bestVis < cur + 0.3) return;
      target = best === 'rest' && cur >= 0.3 ? target : best;
    });

    let lastForm = '';
    let lastSettled = '';
    let lastWordReady = false;
    const offWrite = onFrame((s) => {
      // 视口中线落在哪一节里（相机的机位）
      let station = 0;
      const mid = s.y + s.vh * 0.5;
      tracked.forEach((t, i) => {
        if (t && (t.geometry as Geometry).top <= mid) station = i;
      });
      if (still) station = 0;
      // 视口里的正文框
      let n = 0;
      if (still) {
        for (let i = 0; i < docRects.length && n < screenRects.length - 4; i += 4) {
          if (docRects[i + 1]! > vh) continue;
          screenRects.set(docRects.subarray(i, i + 4), n);
          n += 4;
        }
      } else {
        for (let i = 0; i < docRects.length && n < screenRects.length - 4; i += 4) {
          const top = docRects[i + 1]! - s.y;
          const bottom = docRects[i + 3]! - s.y;
          if (bottom < 0 || top > s.vh) continue;
          screenRects[n++] = docRects[i]!;
          screenRects[n++] = top;
          screenRects[n++] = docRects[i + 2]!;
          screenRects[n++] = bottom;
        }
      }
      // 雕塑占着的框：背景的方块给它让位
      const form = scene.sculpture?.form ?? 'rest';
      const held = form !== 'rest' ? slots[form] : null;
      if (held) keepOut.set([held.left - 24, held.top - 24, held.left + held.width + 24, held.top + held.height + 24]);
      // 轨迹：当前指针（距今 0 秒）在最前，后面是最近一秒的点
      trail.fill(0);
      let k = 0;
      const now = performance.now();
      if (s.pointer && !still) {
        const recent = trailPts[0];
        const speed = recent ? recent.speed * Math.exp(-(now - recent.t) / 120) : 0;
        trail.set([s.pointer.x, s.pointer.y, 0, speed], 0);
        k = 1;
      }
      for (const p of trailPts) {
        if (k >= 16) break;
        const age = (now - p.t) / 1000;
        if (age > 1.6) break;
        trail.set([p.x, p.y, age, p.speed], k * 4);
        k++;
      }
      shockBuf.fill(0);
      shocks.slice(0, 2).forEach((sh, i) => shockBuf.set([sh.x, sh.y, (now - sh.t) / 1000, sh.k], i * 4));
      // 转雕塑：松手后弹回
      if (!turn.on) {
        const e = Math.exp(-3 * s.dt);
        const step = (v: number, vel: number): [number, number] => [(v + (vel + 3 * v) * s.dt) * e, (vel - 3 * (vel + 3 * v) * s.dt) * e];
        [turn.yaw, turn.vy] = step(turn.yaw, turn.vy);
        [turn.pitch, turn.vp] = step(turn.pitch, turn.vp);
      }
      const pointer = s.pointer && !still ? { x: (s.pointer.x / s.vw) * 2 - 1, y: (s.pointer.y / s.vh) * 2 - 1 } : null;
      scene.frame({
        now: s.now,
        dt: s.dt,
        station,
        pointer,
        wordmark: wordRect,
        allay: allay3d.ready && !still ? allay3d.state : null,
        vw,
        vh,
        still,
        textRects: screenRects.subarray(0, n),
        keepOut: held ? keepOut : null,
        sculpt: {
          now: s.now,
          dt: s.dt,
          vw,
          vh,
          scroll: s.y,
          target,
          slots,
          pointer: still ? null : s.pointer,
          trail: trail.subarray(0, k * 4),
          shocks: shockBuf,
          drag: turn,
          still,
          textRects: screenRects.subarray(0, n),
        },
      });
      if (form !== lastForm) {
        lastForm = form;
        canvas.dataset.form = form;
      }
      const settled = String(scene.settled);
      if (settled !== lastSettled) {
        lastSettled = settled;
        canvas.dataset.settled = settled;
      }
      // 体素悦灵在场（拼向它或已拼好，且它的框还有三成在视口里）：带路的悦灵让位，散开时从这里飞出去
      const box = slots.allay;
      const present = form === 'allay' && !!box && (still || (vis.allay ?? 0) >= 0.3);
      allay3d.sculpture = present && box && !still ? { x: box.left + box.width / 2, y: box.top + box.height * 0.4 } : null;
      canvas.dataset.sculpture = String(present);
      // 拼出一大块：带路的悦灵飞过来看一眼（1.8 秒）
      const att = scene.attention;
      if (att && s.now - att.at < 1800) {
        const p = scene.toScreen(att.pos, s.vw, s.vh);
        allay3d.attention = p ? { x: p.x, y: p.y, until: performance.now() + (1800 - (s.now - att.at)) } : null;
      } else allay3d.attention = null;
      // 字标拼好以后，DOM 里的字只变透明（仍可选中、可被读屏读到）
      const wordReady = !!wordRect && !still;
      if (wordEl && wordReady !== lastWordReady) {
        lastWordReady = wordReady;
        wordEl.dataset.voxelReady = String(wordReady);
      }
    });

    const ndc = (x: number, y: number): [number, number] => [(x / window.innerWidth) * 2 - 1, (y / window.innerHeight) * 2 - 1];
    const isBackground = (e: PointerEvent) => {
      const el = e.target;
      if (!(el instanceof Element) || el.closest(INTERACTIVE) || root.dataset.dragging === 'true') return false;
      const texty = el.closest(TEXTY);
      return !texty || !onText(texty, e.clientX, e.clientY);
    };
    const shock = (x: number, y: number) => {
      shocks.unshift({ x, y, t: performance.now(), k: 1 });
      if (shocks.length > 2) shocks.pop();
      canvas.dataset.shocks = String(Number(canvas.dataset.shocks ?? 0) + 1);
    };
    const setCursor = (state: 'none' | 'hover' | 'drag') => {
      root.dataset.worldHover = String(state === 'hover');
      root.dataset.worldDrag = String(state === 'drag');
    };
    let hoverTimer = 0;
    let rotation: { pointer: number; x: number; y: number } | null = null;
    let blockMenu = false;
    const stopRotation = () => {
      if (!rotation) return;
      rotation = null;
      scene.release();
      setCursor('none');
    };
    const onMenu = (event: MouseEvent) => {
      if (blockMenu && event.button === 2) event.preventDefault();
      blockMenu = false;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      if (rotation && rotation.pointer === e.pointerId) {
        if (!(e.buttons & 2)) stopRotation();
        else {
          scene.rotateGrab(e.clientX - rotation.x, e.clientY - rotation.y);
          rotation.x = e.clientX;
          rotation.y = e.clientY;
        }
        return;
      }
      const now = performance.now();
      const last = trailPts[0];
      const dist = last ? Math.hypot(e.clientX - last.x, e.clientY - last.y) : Infinity;
      if (!last || dist > 9 || now - last.t > 60) {
        const speed = last ? (dist / Math.max(8, now - last.t)) * 1000 : 0;
        trailPts.unshift({ x: e.clientX, y: e.clientY, t: now, speed: Number.isFinite(speed) ? speed : 0 });
        if (trailPts.length > 15) trailPts.pop();
      }
      // 指针速度（拖的时候用力甩会甩脱最外面那块）
      const mdt = Math.max(1, now - lastMove.t);
      const inst = (Math.hypot(e.clientX - lastMove.x, e.clientY - lastMove.y) / mdt) * 1000;
      lastMove = { x: e.clientX, y: e.clientY, t: now, speed: lastMove.speed * 0.5 + inst * 0.5 };
      if (press) {
        if (!press.moved && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 5) {
          press.moved = true;
          scene.grab(press.id, ...ndc(press.x, press.y));
          setCursor('drag');
        }
        if (press.moved) scene.dragTo(...ndc(e.clientX, e.clientY), lastMove.speed);
        return;
      }
      if (turn.on) {
        turn.yaw += (e.clientX - turn.x) * 0.008;
        turn.pitch = Math.max(-0.6, Math.min(0.6, turn.pitch + (e.clientY - turn.y) * 0.004));
        turn.x = e.clientX;
        turn.y = e.clientY;
        return;
      }
      // 光标：指针下有能抓的方块（空白处）时是“可抓”；在雕塑的框里也是
      if (hoverTimer) return;
      hoverTimer = window.setTimeout(() => {
        hoverTimer = 0;
        if (press || turn.on || rotation) return;
        const bg = isBackground(e);
        const hit = bg ? scene.pickBlock(...ndc(e.clientX, e.clientY)) : null;
        const onBlock = hit !== null;
        scene.setHover(hit);
        const form = scene.sculpture?.form ?? 'rest';
        const box = form !== 'rest' ? slots[form] : null;
        const inSlot = bg && !!box && e.clientX > box.left && e.clientX < box.left + box.width && e.clientY > box.top && e.clientY < box.top + box.height;
        setCursor(onBlock || inSlot ? 'hover' : 'none');
      }, 40);
    };
    const onDown = (e: PointerEvent) => {
      blockMenu = false;
      if (!isBackground(e)) return;
      if (e.button === 2 && e.pointerType === 'mouse') {
        const id = scene.pickBlock(...ndc(e.clientX, e.clientY));
        if (id === null) return;
        blockMenu = true;
        e.preventDefault();
        scene.grab(id, ...ndc(e.clientX, e.clientY));
        scene.rotateGrab(0, 0);
        rotation = { pointer: e.pointerId, x: e.clientX, y: e.clientY };
        setCursor('drag');
        return;
      }
      if (e.button !== 0) return;
      if (e.pointerType === 'touch') {
        turn.x = e.clientX;
        turn.y = e.clientY;
        return;
      }
      const id = scene.pickBlock(...ndc(e.clientX, e.clientY));
      if (id !== null) {
        // 按在背景方块上：先不动作，看是点还是拖
        e.preventDefault();
        scene.setHover(null);
        press = { id, x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
        return;
      }
      e.preventDefault();
      shock(e.clientX, e.clientY);
      const form = scene.sculpture?.form ?? 'rest';
      const box = form !== 'rest' ? slots[form] : null;
      if (box && e.clientX > box.left && e.clientX < box.left + box.width && e.clientY > box.top && e.clientY < box.top + box.height) {
        turn.on = true;
        turn.x = e.clientX;
        turn.y = e.clientY;
        turn.vy = 0;
        turn.vp = 0;
        setCursor('drag');
      }
    };
    const onUp = (e: PointerEvent) => {
      if (rotation?.pointer === e.pointerId) {
        stopRotation();
        return;
      }
      if (e.pointerType === 'touch' && isBackground(e) && Math.hypot(e.clientX - turn.x, e.clientY - turn.y) < 8) shock(e.clientX, e.clientY);
      if (press) {
        const p = press;
        press = null;
        setCursor('none');
        if (p.moved) {
          scene.release();
          return;
        }
        // 单击：等一下看是不是双击；双击把这一块从组里弹出去，单击敲碎它
        const now = performance.now();
        if (lastClick && lastClick.id === p.id && now - lastClick.t < 320) {
          window.clearTimeout(pendingBreak);
          pendingBreak = 0;
          lastClick = null;
          if (scene.popOut(p.id)) canvas.dataset.pops = String(Number(canvas.dataset.pops ?? 0) + 1);
          return;
        }
        lastClick = { id: p.id, t: now };
        window.clearTimeout(pendingBreak);
        pendingBreak = window.setTimeout(() => {
          pendingBreak = 0;
          if (scene.breakBlock(p.id)) canvas.dataset.breaks = String(Number(canvas.dataset.breaks ?? 0) + 1);
        }, 320);
        return;
      }
      if (turn.on) {
        turn.on = false;
        setCursor('none');
      }
    };
    if (!still) {
      window.addEventListener('pointermove', onMove, { passive: true });
      window.addEventListener('pointerdown', onDown);
      window.addEventListener('contextmenu', onMenu);
      window.addEventListener('blur', stopRotation);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    }
    // 测试和调试：世界此刻的状态（指针有没有真的拨动、拖动、吸附）
    (window as unknown as { __siteWorld?: unknown }).__siteWorld = {
      form: () => scene.sculpture?.form ?? 'rest',
      settled: () => scene.settled,
      stir: () => scene.sculpture?.stir ?? 0,
      yaw: () => scene.sculpture?.yaw ?? 0,
      bench: (n: number) => scene.bench(n),
      // 能抓的方块：中心没有被正文、卡片、面板盖住的（按在那里的事件属于 DOM）
      blocks: () =>
        scene.blocksOnScreen(window.innerWidth, window.innerHeight).filter((b) => {
          const el = document.elementFromPoint(b.x, b.y);
          if (!el || el.closest(INTERACTIVE)) return false;
          const texty = el.closest(TEXTY);
          return !texty || !onText(texty, b.x, b.y);
        }),
      groupOf: (id: number) => scene.groupOf(id),
      pos: (id: number) => scene.screenPos(id, window.innerWidth, window.innerHeight),
      // 体素悦灵的对比检查：换一张贴图（PNG 的 base64；测试用合成贴图），按应用全身图集的取景画出 hover 第 frame 帧
      setAllayTexture: async (pngBase64: string) => {
        const img = await decodeImage(Uint8Array.from(atob(pngBase64), (c) => c.charCodeAt(0)));
        if (img) scene.setAllayTexture(img);
        return !!img;
      },
      reference: (size: number, frame: number) => {
        const px = scene.sculpture?.renderAllayReference(size, frame);
        if (!px) return null;
        let bin = '';
        for (let i = 0; i < px.length; i += 0x8000) bin += String.fromCharCode(...px.subarray(i, i + 0x8000));
        return btoa(bin);
      },
      instances: scene.sculpture?.instances ?? 0,
      tier: tierRef.current,
    };
    return () => {
      offRead();
      offWrite();
      offGeo();
      window.clearInterval(recollectTimer);
      window.clearTimeout(pendingBreak);
      window.clearTimeout(hoverTimer);
      tracked.forEach((t) => t?.untrack());
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('contextmenu', onMenu);
      window.removeEventListener('blur', stopRotation);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      allay3d.sculpture = null;
      allay3d.attention = null;
      if (wordEl) wordEl.dataset.voxelReady = 'false';
      setCursor('none');
    };
  }, [ready, reducedMotion]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-testid="world"
      data-motion="world"
      data-settled="true"
      className={`pointer-events-none z-0 transition-opacity duration-[1200ms] ease-(--ease-out) ${reducedMotion ? 'absolute inset-x-0 top-0 h-[100svh] w-full' : 'fixed inset-0 size-full'} ${ready ? 'opacity-100' : 'opacity-0'}`}
    />
  );
}
