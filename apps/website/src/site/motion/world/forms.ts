// 体素雕塑的各个“形”（docs/decisions.md 官网 · 体素雕塑）。同一批实例方块在这些形之间重组：
// - rest：散在视口里的细尘（少数看得见）和藏在画面外一圈的方块（大多数，缩成 0）；正文多的几节用它；
// - allay：首屏的体素悦灵，从应用那只 3D 悦灵的同一份模型和原版贴图精确体素化（allayVoxels）；
// - cut：剪辑点的标记 ◆ 做成一颗体素八面体，一根播放头竖着穿过它；
// - timeline：三条轨道上的片段和一根来回走的播放头（开源一节的空白处）；
// 每个形是一组方块：局部坐标（单位是“一格体素”）、大小、颜色、贴图格、部件编号。全部是确定性的（同样的输入得到同样的数组）。
import { ALLAY_PARTS, ALLAY_TEXTURE_SIZE } from '@allay/mascot/model';
import { boxFaces, clipPose, partMatrices, transformPoint } from '@allay/mascot/rig';

export const FORM_NAMES = ['rest', 'allay', 'cut', 'timeline'] as const;
export type FormName = (typeof FORM_NAMES)[number];
export const FORM_INDEX: Record<FormName, number> = { rest: 0, allay: 1, cut: 2, timeline: 3 };

/** 贴图集里的格子（8×4，每格 16×16）。0 是生成的细噪点（纯色方块用它带一点颗粒），其余是原版方块贴图 */
export const TILES: { id: string | null; fallback: string }[] = [
  { id: null, fallback: '#ffffff' },
  { id: 'minecraft:diamond_block', fallback: '#52D6DC' },
  { id: 'minecraft:packed_ice', fallback: '#9CC3F5' },
  { id: 'minecraft:lapis_block', fallback: '#2F5DB8' },
  { id: 'minecraft:amethyst_block', fallback: '#9B85E8' },
  { id: 'minecraft:sea_lantern', fallback: '#A9DCD3' },
  { id: 'minecraft:gold_block', fallback: '#F2C94C' },
  { id: 'minecraft:quartz_block', fallback: '#ECE6DE' },
  { id: 'minecraft:black_concrete', fallback: '#141518' },
  { id: 'minecraft:light_blue_concrete', fallback: '#3AAFD9' },
  { id: 'minecraft:cyan_concrete', fallback: '#158991' },
  { id: 'minecraft:purple_concrete', fallback: '#64209C' },
  { id: 'minecraft:white_concrete', fallback: '#CFD5D6' },
  { id: 'minecraft:obsidian', fallback: '#22183A' },
  { id: 'minecraft:snow_block', fallback: '#F0FBFB' },
  { id: 'minecraft:ice', fallback: '#91B7FD' },
  { id: 'minecraft:orange_concrete', fallback: '#E06101' },
  { id: 'minecraft:blue_concrete', fallback: '#2D2F8F' },
  { id: 'minecraft:magenta_concrete', fallback: '#A9309F' },
  { id: 'minecraft:yellow_concrete', fallback: '#F1AF15' },
];
const T = Object.fromEntries(TILES.map((t, i) => [t.id ?? 'noise', i])) as Record<string, number>;

/** 部件编号：着色器按它做局部动作（宝石转、播放头走） */
export const PART = { none: 0, gem: 8, playhead: 9 } as const;

/** 一个形：每块方块 4 + 4 个数（x、y、z、大小；r、g、b 线性色，贴图格 + 32 × 部件） */
export interface Form {
  count: number;
  pos: Float32Array;
  col: Float32Array;
  /** 局部坐标的范围（最小 x、最大 x、最小 y、最大 y），放进页面上的框时按它缩放；也用来排入场的先后 */
  bounds: [number, number, number, number];
  /** 播放头走的宽度（局部坐标） */
  playWidth?: number;
}

export function h01(n: number, seed: number): number {
  let x = Math.imul(n + 1, 2654435761) ^ Math.imul(seed + 7, 1597334677);
  x = Math.imul(x ^ (x >>> 15), 2246822519);
  x = Math.imul(x ^ (x >>> 13), 3266489917);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const WHITE: [number, number, number] = [1, 1, 1];

class Builder {
  private p: number[] = [];
  private c: number[] = [];
  add(x: number, y: number, z: number, s: number, rgb: [number, number, number], tile: number, part = 0): void {
    this.p.push(x, y, z, s);
    this.c.push(rgb[0], rgb[1], rgb[2], tile + 32 * part);
  }
  get size(): number {
    return this.p.length / 4;
  }
  /** 确定性地打乱顺序（实例 i 在各形里落到哪块是随机的，重组时方块交叉着飞），再居中、截到 max 块 */
  finish(max: number, seed: number, extra: Partial<Form> = {}): Form {
    const n = this.size;
    const order = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(h01(i, seed) * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    const count = Math.min(n, max);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      minX = Math.min(minX, this.p[i * 4]!);
      maxX = Math.max(maxX, this.p[i * 4]!);
      minY = Math.min(minY, this.p[i * 4 + 1]!);
      maxY = Math.max(maxY, this.p[i * 4 + 1]!);
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const pos = new Float32Array(count * 4);
    const col = new Float32Array(count * 4);
    for (let k = 0; k < count; k++) {
      const i = order[k]!;
      pos[k * 4] = this.p[i * 4]! - cx;
      pos[k * 4 + 1] = this.p[i * 4 + 1]! - cy;
      pos[k * 4 + 2] = this.p[i * 4 + 2]!;
      pos[k * 4 + 3] = this.p[i * 4 + 3]!;
      col.set(this.c.slice(i * 4, i * 4 + 4), k * 4);
    }
    const out: Form = { count, pos, col, bounds: [minX - cx - 0.5, maxX - cx + 0.5, minY - cy - 0.5, maxY - cy + 0.5], ...extra };
    return out;
  }
}

// —— 悦灵 ——

/**
 * 体素悦灵：与应用里那只 3D 悦灵同一份来源——`packages/mascot` 的模型（ALLAY_PARTS 的长方体、枢轴）、
 * 同一套盒子展开（allay.rig.ts 的 boxFaces）、同一张原版贴图。
 * - 每个模型像素切成 k×k×k 格，只留长方体的外壳；宽度为 0 的翅膀是一层“薄”体素；下摆在身体里面的部分不要；
 * - 位置存的是部件自己的坐标（模型像素），姿态由着色器每帧用应用的骨架矩阵（partMatrices，hover 动作）摆；
 * - 颜色逐片元取：片元在部件坐标里的位置按应用那一面的仿射映射（boxFaces 的四个顶点和贴图坐标）算出贴图坐标，
 *   取最近的像素——和应用光栅化那一面时插值出来的一样。应用的东面展开是转过 90° 并拉伸的（翅膀东面 5 个模型像素
 *   里排了 8 个贴图像素），像素边界不落在格子上，所以不能按格取色，只能逐片元算；
 * - 翅膀：应用里是同一平面上的西、东两个面，双面材质、深度相等时后画的赢，两边看到的都是东面的像素，
 *   东面透明（alpha < 0.5 被丢掉）的地方才露出西面；
 * - 每块记：哪几面在盒子表面上、属于哪个盒子和部件、半透明（下摆）、薄（翅膀）、主像素（散开时露出的内侧用）。
 *   一块体素所在的那几面上涉及的像素全透明的，整块不要。
 */
export interface AllayVoxels extends Form {
  /** 每块 4 个数：标记（表面掩码、盒子、部件、半透明、薄）、主像素编号 + 1、0、0 */
  faces: Float32Array;
  /** 每个盒子 6 个方向各 16 个数（4 个 RGBA）：P1、e0/|e0|²、e1/|e1|²（各带一个 dU1 分量和有效位）、U1 与 dU0 */
  faceParams: Float32Array;
  boxes: number;
  /** hover 第 0 帧摆好姿态后的包围盒中心（应用的全身取景坐标，模型像素）：形的局部原点 */
  center: [number, number];
}

export const ALLAY_BITS = { box: 64, part: 512, translucent: 4096, thin: 8192 } as const;

interface FaceMap {
  p1: number[];
  e0n: number[];
  e1n: number[];
  u1: [number, number];
  du0: [number, number];
  du1: [number, number];
}

function faceMap(f: ReturnType<typeof boxFaces>[number]): FaceMap {
  const [p0, p1, p2] = f.positions;
  const e0 = [p0[0] - p1[0], p0[1] - p1[1], p0[2] - p1[2]];
  const e1 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
  const l0 = e0[0]! ** 2 + e0[1]! ** 2 + e0[2]! ** 2 || 1;
  const l1 = e1[0]! ** 2 + e1[1]! ** 2 + e1[2]! ** 2 || 1;
  const [u0, u1, u2] = f.uvs;
  return { p1: [...p1], e0n: e0.map((v) => v / l0), e1n: e1.map((v) => v / l1), u1: [u1[0], u1[1]], du0: [u0[0] - u1[0], u0[1] - u1[1]], du1: [u2[0] - u1[0], u2[1] - u1[1]] };
}

/** 面上一点（部件坐标）→ 贴图像素（列、行）；超出这一面的部分钳到面内 */
function texelAt(m: FaceMap, x: number[], S: number): [number, number] {
  const d = [x[0]! - m.p1[0]!, x[1]! - m.p1[1]!, x[2]! - m.p1[2]!];
  const s = Math.min(1, Math.max(0, d[0]! * m.e0n[0]! + d[1]! * m.e0n[1]! + d[2]! * m.e0n[2]!));
  const t = Math.min(1, Math.max(0, d[0]! * m.e1n[0]! + d[1]! * m.e1n[1]! + d[2]! * m.e1n[2]!));
  const u = m.u1[0] + s * m.du0[0] + t * m.du1[0];
  const v = m.u1[1] + s * m.du0[1] + t * m.du1[1];
  return [Math.min(S - 1, Math.max(0, Math.floor(u))), Math.min(S - 1, Math.max(0, Math.floor(v)))];
}

export function allayVoxels(k: number, max: number, alphaAt: (u: number, v: number) => number): AllayVoxels {
  const pos: number[] = [];
  const faces: number[] = [];
  const posed: [number, number][] = [];
  const rest = partMatrices(clipPose('hover', 0), { kind: 'body' });
  const body = ALLAY_PARTS.find((p) => p.name === 'body')!.boxes[0]!;
  const S = ALLAY_TEXTURE_SIZE;
  const params: number[] = [];
  let boxIndex = 0;
  ALLAY_PARTS.forEach((part, pi) => {
    for (const box of part.boxes) {
      const bi = boxIndex++;
      const fs = boxFaces(box);
      const g = box.grow;
      const lo = [box.origin[0] - g, box.origin[1] - g, box.origin[2] - g];
      const size = [box.size[0] + 2 * g, box.size[1] + 2 * g, box.size[2] + 2 * g];
      const n = size.map((v) => (v <= 0 ? 1 : Math.max(1, Math.round(v * k))));
      const step = size.map((v, a) => (v <= 0 ? 0 : v / n[a]!));
      const thin = size[0]! <= 0;
      const cutoff = box.translucent ? 0.01 : 0.5;
      // 6 个方向（+x −x +y −y +z −z，部件坐标，Y 朝下）各一个面；薄的盒子：+x 放后画的面（东），−x 放先画的面（西）
      const byDir: (FaceMap | null)[] = [null, null, null, null, null, null];
      if (thin) {
        byDir[0] = faceMap(fs[fs.length - 1]!);
        byDir[1] = faceMap(fs[0]!);
      } else {
        for (const f of fs) {
          const axis = Math.abs(f.normal[0]) > 0.5 ? 0 : Math.abs(f.normal[1]) > 0.5 ? 1 : 2;
          byDir[axis * 2 + (f.normal[axis]! > 0 ? 0 : 1)] = faceMap(f);
        }
      }
      for (const m of byDir) {
        if (!m) {
          params.push(...new Array<number>(16).fill(0));
          continue;
        }
        params.push(m.p1[0]!, m.p1[1]!, m.p1[2]!, m.du1[0], m.e0n[0]!, m.e0n[1]!, m.e0n[2]!, m.du1[1], m.e1n[0]!, m.e1n[1]!, m.e1n[2]!, 1, m.u1[0], m.u1[1], m.du0[0], m.du0[1]);
      }
      /** 这一面在 [a0, a1]×[b0, b1] 那一块（部件坐标里的一个面片）涉及的像素里有没有看得见的；有的话给出中心那个像素 */
      const visible = (m: FaceMap, corners: number[][]): number => {
        let us = Infinity;
        let ue = -Infinity;
        let vs = Infinity;
        let ve = -Infinity;
        for (const x of corners) {
          const [u, v] = texelAt(m, x, S);
          us = Math.min(us, u);
          ue = Math.max(ue, u);
          vs = Math.min(vs, v);
          ve = Math.max(ve, v);
        }
        for (let v = vs; v <= ve; v++) for (let u = us; u <= ue; u++) if (alphaAt(u, v) >= cutoff) {
          const c = corners[corners.length - 1]!;
          const [cu, cv] = texelAt(m, c, S);
          return alphaAt(cu, cv) >= cutoff ? cv * S + cu + 1 : v * S + u + 1;
        }
        return 0;
      };
      for (let ix = 0; ix < n[0]!; ix++) {
        for (let iy = 0; iy < n[1]!; iy++) {
          for (let iz = 0; iz < n[2]!; iz++) {
            const idx = [ix, iy, iz];
            const c = idx.map((i, a) => (size[a]! <= 0 ? lo[a]! : lo[a]! + (i + 0.5) * step[a]!));
            let mask = 0;
            let primary = 0;
            for (let d = 0; d < 6; d++) {
              const a = d >> 1;
              const sign = d % 2 === 0 ? 1 : -1;
              const m = byDir[d];
              if (!m) continue;
              const onEdge = size[a]! <= 0 || (sign > 0 ? idx[a] === n[a]! - 1 : idx[a] === 0);
              if (!onEdge) continue;
              // 这一面的四个角和中心（部件坐标）
              const b1 = (a + 1) % 3;
              const b2 = (a + 2) % 3;
              const corners: number[][] = [];
              for (const s1 of [-0.5, 0.5]) for (const s2 of [-0.5, 0.5]) {
                const x = [...c];
                x[a] = x[a]! + (sign * step[a]!) / 2;
                x[b1] = x[b1]! + s1 * step[b1]! * 0.98;
                x[b2] = x[b2]! + s2 * step[b2]! * 0.98;
                corners.push(x);
              }
              const center = [...c];
              center[a] = center[a]! + (sign * step[a]!) / 2;
              corners.push(center);
              let t = visible(m, corners);
              if (thin && !t) t = visible(byDir[d === 0 ? 1 : 0]!, corners);
              mask |= 1 << d;
              if (t) primary ||= t;
            }
            if (!primary) continue;
            if (box.translucent) {
              const inside = (v: number, h: number, o: number, s: number) => v - h >= o && v + h <= o + s;
              if (inside(c[0]!, step[0]! / 2, body.origin[0], body.size[0]) && inside(c[1]!, step[1]! / 2, body.origin[1], body.size[1]) && inside(c[2]!, step[2]! / 2, body.origin[2], body.size[2])) continue;
            }
            const vox = Math.max(step[0]!, step[1]!, step[2]!);
            pos.push(c[0]!, c[1]!, c[2]!, vox * 1.0005);
            faces.push(mask + bi * ALLAY_BITS.box + pi * ALLAY_BITS.part + (box.translucent ? ALLAY_BITS.translucent : 0) + (thin ? ALLAY_BITS.thin : 0), primary, 0, 0);
            const w = transformPoint(rest[part.name], c);
            posed.push([w[0], w[1]]);
          }
        }
      }
    }
  });
  const count = Math.min(pos.length / 4, max);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of posed) {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const col = new Float32Array(count * 4).fill(1);
  for (let i = 0; i < count; i++) col[i * 4 + 3] = 0;
  return {
    count,
    pos: Float32Array.from(pos.slice(0, count * 4)),
    col,
    faces: Float32Array.from(faces.slice(0, count * 4)),
    faceParams: Float32Array.from(params),
    boxes: boxIndex,
    bounds: [minX - cx, maxX - cx, minY - cy, maxY - cy],
    center: [cx, cy],
  };
}

/** 不看贴图时最多有多少块（实例数按它留，贴图装好以后透明的像素只会让块数变少） */
export function allayVoxelCount(k: number): number {
  return allayVoxels(k, Infinity, () => 1).count;
}

// —— 剪辑点 ◆ ——

export function cutForm(k: number, max: number): Form {
  const b = new Builder();
  const R = Math.max(6, Math.round(k * 2.6));
  for (let x = -R; x <= R; x++) {
    for (let y = -R; y <= R; y++) {
      for (let z = -R; z <= R; z++) {
        const d = Math.abs(x) + Math.abs(y) + Math.abs(z);
        if (d > R || d < R - 1.5) continue;
        const r = h01((x + 64) * 16384 + (y + 64) * 128 + z + 64, 5);
        const tile = y < -R * 0.35 && r < 0.45 ? T['minecraft:orange_concrete']! : r < 0.12 ? T['minecraft:yellow_concrete']! : T['minecraft:gold_block']!;
        b.add(x, y, z, 0.92, WHITE, tile, PART.gem);
      }
    }
  }
  // 播放头：一根竖线穿过宝石，顶上一个倒三角（与导航里的播放头同形）
  const top = Math.round(R * 2.1);
  const bottom = -Math.round(R * 2.1);
  const blue = T['minecraft:light_blue_concrete']!;
  for (let y = bottom; y <= top; y++) {
    if (Math.abs(y) <= R) continue;
    b.add(0, y, 0, 0.92, WHITE, blue);
  }
  for (let row = 0; row < 4; row++) {
    for (let x = -3 + row; x <= 3 - row; x++) b.add(x, top + 4 - row, 0, 0.92, WHITE, blue);
  }
  return b.finish(max, 23);
}

// —— 时间线 ——

export function timelineForm(k: number, max: number): Form {
  const b = new Builder();
  const W = Math.round(k * 17);
  const h = Math.max(3, Math.round(k * 0.9));
  const gap = Math.max(1, Math.round(k * 0.45));
  const depth = 2;
  const tracks = [
    [T['minecraft:light_blue_concrete']!, T['minecraft:cyan_concrete']!],
    [T['minecraft:purple_concrete']!, T['minecraft:magenta_concrete']!],
    [T['minecraft:white_concrete']!, T['minecraft:snow_block']!],
  ];
  let seq = 0;
  tracks.forEach((pair, ti) => {
    const y0 = (1 - ti) * (h + gap);
    let x = 0;
    let clip = 0;
    while (x < W) {
      const len = Math.round(k * (2.2 + h01(ti * 31 + clip, 3) * 4.5));
      const end = Math.min(W, x + len);
      const tile = pair[clip % 2]!;
      for (let cx = x; cx < end; cx++) {
        for (let cy = 0; cy < h; cy++) {
          for (let cz = 0; cz < depth; cz++) {
            const edge = cx === x || cx === end - 1 || cy === 0 || cy === h - 1 || cz === 0;
            if (!edge && h01(seq, 9) < 0.5) {
              seq++;
              continue;
            }
            seq++;
            b.add(cx - W / 2, y0 + cy - h / 2, -cz, 0.9, WHITE, tile);
          }
        }
      }
      x = end + Math.max(1, Math.round(k * (0.3 + h01(ti * 17 + clip, 4) * 0.6)));
      clip++;
    }
  });
  // 播放头：竖线 + 顶上的 ◆（剪辑点的颜色）；着色器让它沿 x 来回走
  const yTop = (h + gap) + h / 2 + 2;
  const yBottom = -(h + gap) - h / 2 - 1;
  for (let y = Math.floor(yBottom); y <= yTop; y++) b.add(0, y, 1, 0.9, WHITE, T['minecraft:white_concrete']!, PART.playhead);
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -(2 - Math.abs(dy)); dx <= 2 - Math.abs(dy); dx++) b.add(dx, yTop + 3 + dy, 1, 0.9, WHITE, T['minecraft:gold_block']!, PART.playhead);
  }
  return b.finish(max, 29, { playWidth: W });
}

// —— 散尘（rest）——

/**
 * 每个实例在 rest 里的位置。x、y 是视口的归一化坐标（−1–1），z 是深度（世界单位）；着色器按深度换算成世界坐标，
 * 并让看得见的那部分随滚动（阻尼过的）缓缓漂移。看得见的只有 dust 块，其余藏在画面外一圈、缩成 0。
 */
export function restForm(n: number, dust: number): Form {
  const pos = new Float32Array(n * 4);
  const col = new Float32Array(n * 4);
  const dustTiles = [T['minecraft:diamond_block']!, T['minecraft:packed_ice']!, T['minecraft:light_blue_concrete']!, T['minecraft:sea_lantern']!, T['minecraft:amethyst_block']!, T['minecraft:white_concrete']!, T['minecraft:lapis_block']!];
  for (let i = 0; i < n; i++) {
    // 看得见的细尘是最后 dust 个实例（不参与任何雕塑，各节都一样），其余藏在画面外一圈
    if (i >= n - dust) {
      pos[i * 4] = (h01(i, 1) * 2 - 1) * 1.08;
      pos[i * 4 + 1] = (h01(i, 2) * 2 - 1) * 1.25;
      pos[i * 4 + 2] = -14 - h01(i, 3) ** 1.3 * 46;
      pos[i * 4 + 3] = 0.05 + h01(i, 4) * 0.08;
    } else {
      const a = h01(i, 5) * Math.PI * 2;
      const r = 1.3 + h01(i, 6) * 0.5;
      pos[i * 4] = Math.cos(a) * r;
      pos[i * 4 + 1] = Math.sin(a) * r;
      pos[i * 4 + 2] = -24 + h01(i, 7) * 28;
      pos[i * 4 + 3] = 0;
    }
    col[i * 4] = 1;
    col[i * 4 + 1] = 1;
    col[i * 4 + 2] = 1;
    col[i * 4 + 3] = dustTiles[Math.floor(h01(i, 8) * dustTiles.length)]!;
  }
  return { count: n, pos, col, bounds: [-1, 1, -1, 1] };
}
