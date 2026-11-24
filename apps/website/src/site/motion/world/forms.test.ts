// T-WEB-18：首屏的体素悦灵与应用里那只 3D 悦灵同源——同一份模型、同一套盒子展开、同一张贴图逐片元取色。
// 这里不碰原版贴图：用合成的透明度函数检查生成逻辑；与应用烘焙渲染器的逐像素对比见 docs/decisions.md。
import { ALLAY_PARTS, ALLAY_TEXTURE_SIZE } from '@allay/mascot/model';
import { boxFaces } from '@allay/mascot/rig';
import { describe, expect, it } from 'vitest';
import { ALLAY_BITS, allayVoxelCount, allayVoxels } from './forms';

const boxes = ALLAY_PARTS.flatMap((p) => p.boxes);
const opaque = () => 1;

/** faceParams 里第 box 个盒子、第 d 个方向的映射：部件坐标 → 贴图坐标（与着色器里同一个算法，不钳制） */
function uvOf(params: Float32Array, box: number, d: number, x: readonly number[]): [number, number] | null {
  const o = (box * 6 + d) * 16;
  if (params[o + 11]! < 0.5) return null;
  const dd = [x[0]! - params[o]!, x[1]! - params[o + 1]!, x[2]! - params[o + 2]!];
  const s = dd[0]! * params[o + 4]! + dd[1]! * params[o + 5]! + dd[2]! * params[o + 6]!;
  const t = dd[0]! * params[o + 8]! + dd[1]! * params[o + 9]! + dd[2]! * params[o + 10]!;
  return [params[o + 12]! + s * params[o + 14]! + t * params[o + 3]!, params[o + 13]! + s * params[o + 15]! + t * params[o + 7]!];
}

describe('T-WEB-18 体素悦灵与应用同源', () => {
  const v = allayVoxels(2, Infinity, opaque);

  it('每个面的映射在四个顶点上给出应用 boxFaces 的贴图坐标（东面那种转过 90° 的展开也一样）', () => {
    boxes.forEach((b, bi) => {
      const fs = boxFaces(b);
      const thin = b.size[0] === 0;
      fs.forEach((f, fi) => {
        const axis = Math.abs(f.normal[0]) > 0.5 ? 0 : Math.abs(f.normal[1]) > 0.5 ? 1 : 2;
        // 薄片：+x 放后画的面，−x 放先画的面
        const d = thin ? (fi === fs.length - 1 ? 0 : 1) : axis * 2 + (f.normal[axis]! > 0 ? 0 : 1);
        f.positions.forEach((p, i) => {
          const uv = uvOf(v.faceParams, bi, d, p)!;
          expect(uv[0]).toBeCloseTo(f.uvs[i]![0], 6);
          expect(uv[1]).toBeCloseTo(f.uvs[i]![1], 6);
        });
      });
    });
  });

  it('不透明的盒子：每个面正好被 (k·宽)×(k·高) 块体素的那一面铺满，体素都在盒子里', () => {
    const k = 2;
    const head = boxes[0]!;
    const n = head.size.map((s) => s * k);
    const perDir = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < v.count; i++) {
      const flags = v.faces[i * 4]!;
      if (Math.floor(flags / ALLAY_BITS.box) % 8 !== 0) continue;
      for (let d = 0; d < 6; d++) if ((flags & (1 << d)) !== 0) perDir[d]!++;
      for (let a = 0; a < 3; a++) {
        expect(v.pos[i * 4 + a]!).toBeGreaterThan(head.origin[a]!);
        expect(v.pos[i * 4 + a]!).toBeLessThan(head.origin[a]! + head.size[a]!);
      }
    }
    expect(perDir).toEqual([n[1]! * n[2]!, n[1]! * n[2]!, n[0]! * n[2]!, n[0]! * n[2]!, n[0]! * n[1]!, n[0]! * n[1]!]);
  });

  it('翅膀：东面透明时退到西面的像素（应用里先画西面、后画东面）；两面都透明的整块不要', () => {
    const wing = boxes.findIndex((b) => b.size[0] === 0);
    const fs = boxFaces(boxes[wing]!);
    const east = fs[fs.length - 1]!.uvs;
    const eastRect = [Math.min(...east.map((u) => u[0])), Math.max(...east.map((u) => u[0])), Math.min(...east.map((u) => u[1])), Math.max(...east.map((u) => u[1]))];
    const inEast = (u: number, w: number) => u >= eastRect[0]! && u < eastRect[1]! && w >= eastRect[2]! && w < eastRect[3]!;
    const thinCount = (alpha: (u: number, w: number) => number) => {
      const r = allayVoxels(2, Infinity, alpha);
      let n = 0;
      for (let i = 0; i < r.count; i++) if ((r.faces[i * 4]! & ALLAY_BITS.thin) !== 0) n++;
      return n;
    };
    const all = thinCount(opaque);
    expect(all).toBeGreaterThan(0);
    // 东面全透明：靠西面，一块不少
    expect(thinCount((u, w) => (inEast(u, w) ? 0 : 1))).toBe(all);
    // 整张贴图透明：翅膀一块不剩
    expect(thinCount(() => 0)).toBe(0);
  });

  it('块数只随格数变；贴图里的透明像素只会让块数变少', () => {
    expect(allayVoxelCount(2)).toBe(v.count);
    expect(allayVoxelCount(4)).toBeGreaterThan(allayVoxelCount(2) * 3);
    const S = ALLAY_TEXTURE_SIZE;
    const holes = allayVoxels(2, Infinity, (u, w) => ((u + w * S) % 3 === 0 ? 0 : 1));
    expect(holes.count).toBeLessThan(v.count);
  });
});
