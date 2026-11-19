// T2 方块坠落 allay.builtin.block-fall（docs/04-templates.md 4.10）。
// 只用公开的模板接口：THREE 和所有辅助函数都从 ctx 拿，只从 template-sdk 做类型导入（4.9）。
// 下落、回弹、散落全部是时间的闭式函数（局部进度的函数），不做逐帧积分（2.9）。
import type { BlockInstances, ParamValue, SetupContext, TemplateInstance, TemplateModule } from '@allay/template-sdk';

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
  return out.length > 0 ? out : [{ id: 'minecraft:stone', weight: 3 }, { id: 'minecraft:cobblestone', weight: 1 }];
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

function normalize(a: Float64Array): void {
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of a) {
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  for (let i = 0; i < a.length; i++) a[i] = hi > lo ? (a[i]! - lo) / (hi - lo) : 0;
}

/** 单个方块的动画占整个阶段的比例 */
const IN_SPAN = 0.35;
const OUT_SPAN = 0.5;
/** 有回弹时，局部进度里下落占的部分（其余是回弹） */
const FALL_PART = 0.62;
/** explode 的重力下坠（以舞台高度计） */
const EXPLODE_GRAVITY = 0.35;

const template: TemplateModule = {
  async setup(ctx: SetupContext): Promise<TemplateInstance> {
    const { THREE, stage, scene, params } = ctx;
    const cols = Math.round(num(params.cols, 10));
    const columnOrder = str(params.columnOrder, 'random');
    const bounce = Math.min(1, Math.max(0, num(params.bounce, 0.25)));
    const outMode = str(params.outMode, 'fall');
    const inDuration = num(params.inDuration, 0.7);
    const hold = num(params.hold, 0.1);
    const outDuration = num(params.outDuration, 0.6);
    const volume = num(params.volume, 0.6);

    const duration = inDuration + hold + outDuration;
    const cutTime = inDuration + hold / 2;

    // 透视相机（fov 30）和面明暗，和 T1 的 3d 样式一样，下落和散落时能看到侧面
    ctx.setCamera(ctx.createStageCamera({ fov: 30 }));

    // 网格同 T1：格子边长 s = stage.width / cols，行数 ceil(height / s) + 1，垂直居中（r = 0 是最上一行）
    const W = stage.width;
    const H = stage.height;
    const s = W / cols;
    const rows = Math.ceil(H / s) + 1;
    const count = cols * rows;
    const px = new Float64Array(count);
    const py = new Float64Array(count);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        px[i] = -W / 2 + (c + 0.5) * s;
        py[i] = ((rows - 1) / 2 - r) * s;
      }
    }

    // 列的先后（0 = 最先）
    const colOrder = new Float64Array(cols);
    if (columnOrder === 'random') {
      const ranks = Array.from({ length: cols }, (_, c) => c);
      ctx.random('columns').shuffle(ranks);
      for (let c = 0; c < cols; c++) colOrder[c] = ranks[c]!;
    } else {
      for (let c = 0; c < cols; c++) {
        colOrder[c] = columnOrder === 'rightToLeft' ? cols - 1 - c : columnOrder === 'centerOut' ? Math.abs(c - (cols - 1) / 2) : c;
      }
    }
    normalize(colOrder);

    // 进入：每个方块的开始时刻（阶段进度里的位置）。列的先后占 55%，同一列里从下往上占 45%：
    // 同一列里每块都比下面那块晚开始、下落曲线相同，所以上面的方块永远在下面那块之上，不会穿过去
    const startIn = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const fromBottom = rows > 1 ? (rows - 1 - r) / (rows - 1) : 0;
      startIn[i] = (1 - IN_SPAN) * (0.55 * colOrder[c]! + 0.45 * fromBottom);
    }

    // 退出：先后顺序和每块的随机量（都在 setup 里定好）
    const rnd = ctx.random('out');
    const startOut = new Float64Array(count);
    const vx = new Float64Array(count);
    const kick = new Float64Array(count);
    const spinRate = new Float64Array(count);
    const ax = new Float64Array(count);
    const ay = new Float64Array(count);
    const az = new Float64Array(count);
    const dirX = new Float64Array(count);
    const dirY = new Float64Array(count);
    const reach = new Float64Array(count);
    const diag = Math.hypot(W, H);
    for (let i = 0; i < count; i++) {
      const r = Math.floor(i / cols);
      // fall：上面的行先走；explode：几乎同时，略带随机；shrink：与进入相反（后落定的先缩）
      if (outMode === 'fall') startOut[i] = 0.65 * (rows > 1 ? r / (rows - 1) : 0) + 0.35 * rnd.next();
      else if (outMode === 'explode') startOut[i] = 0.25 * rnd.next() + 0.15 * (Math.hypot(px[i]!, py[i]!) / (diag / 2));
      else startOut[i] = 1 - startIn[i]!;
      vx[i] = rnd.range(-1, 1) * W * 0.35;
      kick[i] = rnd.range(0.4, 1.2) * s;
      spinRate[i] = rnd.range(-1, 1) * Math.PI * 1.5;
      // 随机自转轴（单位向量）
      const theta = rnd.range(0, Math.PI * 2);
      const zc = rnd.range(-1, 1);
      const rr = Math.sqrt(1 - zc * zc);
      ax[i] = rr * Math.cos(theta);
      ay[i] = rr * Math.sin(theta);
      az[i] = zc;
      // explode 的方向：从画面中心向外；正中心的格子随机取一个方向
      const d = Math.hypot(px[i]!, py[i]!);
      if (d > 1e-6) {
        dirX[i] = px[i]! / d;
        dirY[i] = py[i]! / d;
      } else {
        dirX[i] = Math.cos(theta);
        dirY[i] = Math.sin(theta);
      }
      // 走到画面对角线一半以外再多两格，再补上重力拉回的那段，保证出画
      reach[i] = (diag / 2 + 2 * s + EXPLODE_GRAVITY * H) * rnd.range(1, 1.4);
    }
    normalize(startOut);

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
      const handle = await ctx.resources.block(kinds[k]!, { shading: true });
      const inst = handle.instanced(kindCount[k]!);
      scene.add(inst.object);
      groups.push(inst);
    }

    // 时间窗（同 T1，docs/decisions.md M3“T1 的时间余量”）：首尾各留一帧，剪辑点前后各一帧保持铺满。
    // 局部进度为 0 的方块缩放为 0（不可见），进度为 1 的方块在网格上的原位（进入）或已经不可见（退出），
    // 所以 [0, 1/fps]、[duration − 1/fps, duration] 内画面全空，[cutTime − 1/fps, cutTime + 1/fps] 内全满。
    const pad = 1 / stage.fps;
    const inStart = Math.min(pad, inDuration / 2);
    const inEnd = Math.max(inStart + 1e-4, Math.min(inDuration, cutTime - pad));
    const outEnd = duration - Math.min(pad, outDuration / 2);
    const outStart = Math.min(Math.max(inDuration + hold, cutTime + pad), outEnd - 1e-4);
    const inLen = inEnd - inStart;
    const outLen = outEnd - outStart;
    const fallPart = bounce > 0 ? FALL_PART : 1;

    // 音效：在最多 12 个均匀抽样的方块落地时刻放 placeSound，散落开始时刻放 breakSound（同 T1 的抽样）
    const sampleCues = (sound: ParamValue | undefined, times: number[]) => {
      if (typeof sound !== 'string') return;
      const sorted = times.map((time, cell) => ({ time, cell })).sort((a, b) => a.time - b.time);
      const k = Math.min(12, sorted.length);
      for (let j = 0; j < k; j++) {
        const idx = k === 1 ? 0 : Math.round((j * (sorted.length - 1)) / (k - 1));
        const { time, cell } = sorted[idx]!;
        ctx.audio.cue(sound, time, params.spatialAudio === true ? { gain: volume, position: [px[cell]!, py[cell]!, 0] } : { gain: volume });
      }
    };
    sampleCues(params.placeSound, Array.from(startIn, (u) => inStart + (u + IN_SPAN * fallPart) * inLen));
    sampleCues(params.breakSound, Array.from(startOut, (u) => outStart + u * (1 - OUT_SPAN) * outLen));
    if (typeof params.music === 'string') ctx.audio.cue(params.music, 0, { gain: num(params.musicVolume, 0.5) });

    // update 里复用的对象（update 内不分配内存）
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const axis = new THREE.Vector3();
    const flip = new THREE.Vector3(0, 1, 0);
    const clamp01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x);
    const backOut = ctx.ease.backOut;
    // 下落高度：从最下一行算起也在画面上方（透视的放大和抬起都算进去）
    const drop = H + 3 * s;
    // fall 散落的落差：从最上一行算起也落到画面下方
    const fallDrop = H + 4 * s;
    const lift = s * 0.05;

    return {
      duration,
      cutTime,
      update(t: number) {
        const entering = t <= cutTime;
        const phase = entering ? clamp01((t - inStart) / inLen) : clamp01((t - outStart) / outLen);
        for (let i = 0; i < count; i++) {
          let k = s;
          let z = 0;
          let x = px[i]!;
          let y = py[i]!;
          quat.identity();
          if (entering) {
            const p = phase >= 1 ? 1 : clamp01((phase - startIn[i]!) / IN_SPAN);
            if (p <= 0) k = 0;
            else if (p < 1) {
              z = lift;
              if (p < fallPart) {
                // 匀加速下落：y = y终 + H × (1 − q²)
                const q = p / fallPart;
                y += drop * (1 - q * q);
              } else {
                // 衰减的回弹：bounce × s × e^(−6τ) × |sin(3πτ)|
                const tau = (p - fallPart) / (1 - fallPart);
                y += bounce * s * Math.exp(-6 * tau) * Math.abs(Math.sin(3 * Math.PI * tau));
              }
            }
          } else {
            const p = phase >= 1 ? 1 : clamp01((phase - startOut[i]! * (1 - OUT_SPAN)) / OUT_SPAN);
            if (p >= 1) k = 0;
            else if (p > 0) {
              z = lift;
              if (outMode === 'fall') {
                // 抛物线：水平初速度 + 先向上一点再加速下落，带随机角速度
                x += vx[i]! * p;
                y += kick[i]! * 4 * p * (1 - p) - fallDrop * p * p;
                axis.set(0, 0, 1);
                quat.setFromAxisAngle(axis, spinRate[i]! * p);
              } else if (outMode === 'explode') {
                // 从画面中心向外的抛物线，加自转
                const e = 1 - (1 - p) * (1 - p);
                x += dirX[i]! * reach[i]! * e;
                y += dirY[i]! * reach[i]! * e + kick[i]! * 2 * p * (1 - p) - H * EXPLODE_GRAVITY * p * p;
                z += s * 2 * e;
                axis.set(ax[i]!, ay[i]!, az[i]!);
                quat.setFromAxisAngle(axis, spinRate[i]! * 2 * p);
              } else {
                // 同 T1 的缩回：缩放从 1 回到 0，同时绕竖轴翻转
                const e = backOut(1 - p);
                k = e * s;
                quat.setFromAxisAngle(flip, (1 - e) * (Math.PI / 2));
              }
            }
          }
          pos.set(x, y, z);
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
