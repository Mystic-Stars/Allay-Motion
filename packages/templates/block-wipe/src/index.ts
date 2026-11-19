// T1 方块擦除 allay.builtin.block-wipe（docs/04-templates.md 4.10）。
// 只用公开的模板接口：THREE 和所有辅助函数都从 ctx 拿，只从 template-sdk 做类型导入（4.9）。
// 构建时由 scripts/build-templates.ts 用 esbuild 打成不含 import 的单文件 ESM。
import type { BlockInstances, ParamValue, SetupContext, TemplateInstance, TemplateModule } from '@allay/template-sdk';

type Pattern = 'leftToRight' | 'rightToLeft' | 'topToBottom' | 'bottomToTop' | 'centerOut' | 'edgesIn' | 'diagonal' | 'random' | 'noise';

interface BlockEntry {
  id: string;
  weight: number;
}

const num = (v: ParamValue | undefined, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const str = (v: ParamValue | undefined, fallback: string): string => (typeof v === 'string' ? v : fallback);

function blockList(v: ParamValue | undefined): BlockEntry[] {
  const out: BlockEntry[] = [];
  if (Array.isArray(v)) {
    for (const e of v) {
      if (e && typeof e === 'object' && !Array.isArray(e) && typeof e.id === 'string' && typeof e.weight === 'number' && e.weight > 0) out.push({ id: e.id, weight: e.weight });
    }
  }
  return out.length > 0 ? out : [{ id: 'minecraft:diamond_block', weight: 1 }];
}

function orderedIndex(distribution: ParamValue | undefined, cols: number): ((index: number) => number) | undefined {
  const row = (index: number) => Math.floor(index / cols);
  const col = (index: number) => index % cols;
  switch (distribution) {
    case 'horizontalStripes': return row;
    case 'verticalStripes': return col;
    case 'cyclic': return (index) => index;
    case 'checker': return (index) => col(index) + row(index) % 2;
    case 'diagonal': return (index) => col(index) + row(index);
    default: return undefined;
  }
}

/**
 * 每个格子的顺序值 u ∈ [0, 1]：图案函数给出原始值并归一化，加 jitter × 随机数后再归一化（4.10）。
 * px、py 是格子中心的设计坐标（原点在舞台中心，+y 向上）。
 */
function orderValues(ctx: SetupContext, pattern: Pattern, px: Float64Array, py: Float64Array, jitter: number, key: string): Float64Array {
  const { width: W, height: H } = ctx.stage;
  const n = px.length;
  const rng = ctx.random(`order:${key}`);
  const jitterRng = ctx.random(`jitter:${key}`);
  const raw = new Float64Array(n);
  const radius = Math.hypot(W / 2, H / 2);
  for (let i = 0; i < n; i++) {
    const fx = (px[i]! + W / 2) / W; // 0 = 左
    const fy = (H / 2 - py[i]!) / H; // 0 = 上
    const d = Math.hypot(px[i]!, py[i]!) / radius;
    switch (pattern) {
      case 'leftToRight': raw[i] = fx; break;
      case 'rightToLeft': raw[i] = 1 - fx; break;
      case 'topToBottom': raw[i] = fy; break;
      case 'bottomToTop': raw[i] = 1 - fy; break;
      case 'centerOut': raw[i] = d; break;
      case 'edgesIn': raw[i] = 1 - d; break;
      case 'diagonal': raw[i] = fx + fy; break;
      case 'random': raw[i] = rng.next(); break;
      case 'noise': raw[i] = ctx.noise2D(px[i]! / 420, py[i]! / 420, `pattern:${key}`); break;
    }
  }
  normalize(raw);
  for (let i = 0; i < n; i++) raw[i] = raw[i]! + jitter * jitterRng.next();
  normalize(raw);
  return raw;
}

function normalize(a: Float64Array): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of a) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  for (let i = 0; i < a.length; i++) a[i] = hi > lo ? (a[i]! - lo) / (hi - lo) : 0;
}

const template: TemplateModule = {
  async setup(ctx: SetupContext): Promise<TemplateInstance> {
    const { THREE, stage, scene, params } = ctx;
    const cols = Math.round(num(params.cols, 12));
    const style = str(params.style, '3d');
    const inPattern = str(params.inPattern, 'centerOut') as Pattern;
    const outPattern = str(params.outPattern, 'reverse');
    const inDuration = num(params.inDuration, 0.5);
    const hold = num(params.hold, 0.1);
    const outDuration = num(params.outDuration, 0.5);
    const overlap = Math.min(1, Math.max(0.01, num(params.overlap, 0.45)));
    const jitter = num(params.jitter, 0.1);
    const spin = str(params.spin, 'flipY');
    const volume = num(params.volume, 0.6);
    const ease = ctx.ease.from(params.easing);

    const duration = inDuration + hold + outDuration;
    const cutTime = inDuration + hold / 2;

    // 相机：flat 用默认的正交相机、不加面明暗；3d 用 fov 30 的透视相机，z = 0 平面恰好填满舞台
    if (style === '3d') ctx.setCamera(ctx.createStageCamera({ fov: 30 }));
    const shading = style === '3d';

    // 网格：格子边长 s = stage.width / cols，行数 ceil(height / s) + 1，垂直居中
    const s = stage.width / cols;
    const rows = Math.ceil(stage.height / s) + 1;
    const count = cols * rows;
    const px = new Float64Array(count);
    const py = new Float64Array(count);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        px[i] = -stage.width / 2 + (c + 0.5) * s;
        py[i] = ((rows - 1) / 2 - r) * s;
      }
    }

    const uIn = orderValues(ctx, inPattern, px, py, jitter, 'in');
    let uOut: Float64Array;
    if (outPattern === 'same') uOut = uIn;
    else if (outPattern === 'reverse') uOut = uIn.map((u) => 1 - u);
    else uOut = orderValues(ctx, outPattern as Pattern, px, py, jitter, 'out');

    // 只按最终落位分配材质；随机模式沿用旧的 blocks 随机流和取样顺序。
    const entries = blockList(params.blocks);
    const totalWeight = entries.reduce((a, e) => a + e.weight, 0);
    const paletteIndex = orderedIndex(params.materialDistribution, cols);
    const pick = paletteIndex ? undefined : ctx.random('blocks');
    const kinds = [...new Set(entries.map((e) => e.id))];
    const cellKind = new Uint8Array(count);
    const kindCount = new Array<number>(kinds.length).fill(0);
    const cellIndex = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      let id: string;
      if (pick) {
        let x = pick.next() * totalWeight;
        id = entries[entries.length - 1]!.id;
        for (const e of entries) {
          x -= e.weight;
          if (x < 0) {
            id = e.id;
            break;
          }
        }
      } else {
        id = entries[paletteIndex!(i) % entries.length]!.id;
      }
      const k = kinds.indexOf(id);
      cellKind[i] = k;
      cellIndex[i] = kindCount[k]!;
      kindCount[k] = kindCount[k]! + 1;
    }
    const groups: (BlockInstances | null)[] = [];
    for (let k = 0; k < kinds.length; k++) {
      if (kindCount[k] === 0) {
        groups.push(null);
        continue;
      }
      const handle = await ctx.resources.block(kinds[k]!, { shading });
      const inst = handle.instanced(kindCount[k]!);
      scene.add(inst.object);
      groups.push(inst);
    }

    // 时间窗：首尾各留一帧的余量，剪辑点前后各一帧保持铺满（docs/decisions.md M3“T1 的时间余量”）。
    // 运动模糊的子帧最多偏离帧时刻 ±0.5/fps（快门角 360°），剪辑点那一帧离 cutTime 最多 0.5/fps，
    // 所以 [0, 1/fps]、[duration − 1/fps, duration] 内画面全空，[cutTime − 1/fps, cutTime + 1/fps] 内全满。
    // 帧率极低（一帧比半个阶段还长）时余量做不到，退回各阶段的一半，保证时间窗不为空。
    const pad = 1 / stage.fps;
    const inStart = Math.min(pad, inDuration / 2);
    const inEnd = Math.max(inStart + 1e-4, Math.min(inDuration, cutTime - pad));
    const outEnd = duration - Math.min(pad, outDuration / 2);
    const outStart = Math.min(Math.max(inDuration + hold, cutTime + pad), outEnd - 1e-4);
    const inLen = inEnd - inStart;
    const outLen = outEnd - outStart;
    const lag = 1 - overlap;

    // 音效：在最多 12 个均匀抽样的方块起始时刻放（4.10）
    const sampleCues = (sound: ParamValue | undefined, u: Float64Array, start: number, len: number) => {
      if (typeof sound !== 'string') return;
      const sorted = Array.from(u, (order, cell) => ({ order, cell })).sort((a, b) => a.order - b.order);
      const k = Math.min(12, sorted.length);
      for (let j = 0; j < k; j++) {
        const idx = k === 1 ? 0 : Math.round((j * (sorted.length - 1)) / (k - 1));
        const { order, cell } = sorted[idx]!;
        ctx.audio.cue(sound, start + order * lag * len, params.spatialAudio === true ? { gain: volume, position: [px[cell]!, py[cell]!, 0] } : { gain: volume });
      }
    };
    sampleCues(params.placeSound, uIn, inStart, inLen);
    sampleCues(params.breakSound, uOut, outStart, outLen);
    if (typeof params.music === 'string') ctx.audio.cue(params.music, 0, { gain: num(params.musicVolume, 0.5) });

    // update 里复用的对象（update 内不分配内存）
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const axis = spin === 'flipX' ? new THREE.Vector3(1, 0, 0) : spin === 'twist' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const rotate = spin !== 'none';
    const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
    /** 单个方块的局部进度：phase 是阶段进度，u 是顺序值 */
    const local = (phase: number, u: number) => (phase >= 1 ? 1 : clamp01((phase - u * lag) / overlap));

    return {
      duration,
      cutTime,
      update(t: number) {
        const entering = t <= cutTime;
        const phase = entering ? clamp01((t - inStart) / inLen) : clamp01((t - outStart) / outLen);
        for (let i = 0; i < count; i++) {
          // 退出阶段对称：缩放从 1 回到 0
          const p = entering ? local(phase, uIn[i]!) : 1 - local(phase, uOut[i]!);
          const e = p <= 0 ? 0 : p >= 1 ? 1 : ease(p);
          // 动画中的方块朝相机抬起，落定后回到 z = 0，避免过冲时与邻居的面重合闪烁
          const lift = p > 0 && p < 1 ? (1 - p) * s * 0.5 : 0;
          pos.set(px[i]!, py[i]!, lift);
          if (rotate) quat.setFromAxisAngle(axis, (1 - e) * (Math.PI / 2));
          else quat.identity();
          const k = e * s;
          scl.set(k, k, k);
          m.compose(pos, quat, scl);
          groups[cellKind[i]!]!.setMatrix(cellIndex[i]!, m);
        }
        for (const g of groups) g?.commit();
      },
    };
  },
};

export default template;
