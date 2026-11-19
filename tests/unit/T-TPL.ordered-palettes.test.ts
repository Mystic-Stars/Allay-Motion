import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NAMES, getBlock, resolveBlockFaces, textureIdToPath } from '../../packages/assets/src/index';
import { ease, math, segment } from '../../packages/engine/src/ease';
import { createRng } from '../../packages/engine/src/random';
import blockFallManifest from '../../packages/templates/block-fall/manifest.json';
import blockFall from '../../packages/templates/block-fall/src/index';
import blockWipeManifest from '../../packages/templates/block-wipe/manifest.json';
import blockWipe from '../../packages/templates/block-wipe/src/index';
import { TemplateManifestSchema, sanitizeParams, type ParamValues, type SetupContext, type TemplateModule } from '../../packages/template-sdk/src/index';

const require = createRequire(new URL('../../packages/engine/package.json', import.meta.url));
const THREE = await import(pathToFileURL(realpathSync(require.resolve('three')).replace(/three\.cjs$/, 'three.module.js')).href) as SetupContext['THREE'];
const entries = [
  { id: 'minecraft:red_concrete', weight: 3 },
  { id: 'minecraft:orange_concrete', weight: 0 },
  { id: 'minecraft:lime_concrete', weight: 1 },
  { id: 'minecraft:blue_concrete', weight: 2 },
];
const missing = (): never => { throw new Error('模板调用了未预期的资源'); };

async function capture(template: TemplateModule, manifest: unknown, patch: ParamValues) {
  const { params: defs = [] } = TemplateManifestSchema.parse(manifest);
  const params = sanitizeParams(defs, { blocks: entries, cols: 5, ...patch });
  const requested: string[] = [];
  const rngKeys: string[] = [];
  const matrices: { id: string; index: number; elements: number[] }[] = [];
  const instance = await template.setup({
    THREE, params, locale: 'en', stage: { width: 5, height: 2, aspect: 2.5, fps: 60, pixelScale: 1 },
    scene: new THREE.Scene(), camera: new THREE.OrthographicCamera(), setCamera: () => {}, createStageCamera: () => new THREE.PerspectiveCamera(),
    resources: { texture: missing, optionalTexture: missing, item: missing, block: async (id) => {
      requested.push(id);
      return {
        single: missing, faceTexture: missing,
        instanced: (count) => ({
          count, object: new THREE.Object3D(),
          setMatrix: (index, matrix) => matrices.push({ id, index, elements: [...matrix.elements] }),
          setOpacity: missing, setTint: missing, commit: () => {},
        }),
      };
    } },
    text: { prepare: missing, measureGui: missing, create: missing }, sprite: { create: missing },
    random: (key = '') => {
      rngKeys.push(key);
      return createRng(params.seed as number, key);
    },
    noise2D: () => 0, ease, math, time: { segment }, audio: { cue: () => {} }, warn: missing,
  });
  const frame = (t = instance.cutTime!) => {
    matrices.length = 0;
    instance.update(t);
    return [...matrices];
  };
  return { frame, requested, rngKeys, duration: instance.duration };
}

const layouts = [
  ['horizontalStripes', 'RRRRR LLLLL BBBBB'],
  ['verticalStripes', 'RLBRL RLBRL RLBRL'],
  ['cyclic', 'RLBRL BRLBR LBRLB'],
  ['checker', 'RLBRL LBRLB RLBRL'],
  ['diagonal', 'RLBRL LBRLB BRLBR'],
] as const;
const colorCode = (id: string) => id.split(':')[1]![0]!.toUpperCase();

describe.each([
  ['block-wipe', blockWipe, blockWipeManifest],
  ['block-fall', blockFall, blockFallManifest],
] as const)('T-TPL-3/4 %s 有序方块材质', (_name, template, manifest) => {
  it.each(layouts)('%s 按格子坐标分配材质，与时间、进出场图案和种子无关', async (materialDistribution, expected) => {
    const base = await capture(template, manifest, { materialDistribution });
    const changedMotion = await capture(template, manifest, {
      materialDistribution, seed: 99, inPattern: 'random', outPattern: 'random', jitter: 0.4,
      columnOrder: 'rightToLeft', outMode: 'explode', inDuration: 1.2, outDuration: 0.8,
    });
    for (const run of [base, changedMotion]) {
      expect(run.rngKeys).not.toContain('blocks');
      const cut = run.frame();
      const ids = cut.map(({ id }) => id);
      expect(ids.map(colorCode).join('')).toBe(expected.replaceAll(' ', ''));
      expect(run.frame(run.duration * 0.8).map(({ id }) => id)).toEqual(ids);
      expect(run.frame(run.duration * 0.2).map(({ id }) => id)).toEqual(ids);
      expect(run.frame()).toEqual(cut);
    }
    const weighted = await capture(template, manifest, {});
    for (const fraction of [0.2, 0.8]) {
      expect(base.frame(base.duration * fraction).map(({ elements }) => elements)).toEqual(weighted.frame(base.duration * fraction).map(({ elements }) => elements));
    }
  });

  it('使用列表顺序，保留重复项并跳过零权重项', async () => {
    const [red, orange, lime, blue] = entries;
    const run = await capture(template, manifest, { materialDistribution: 'verticalStripes', blocks: [blue!, orange!, red!, red!, lime!] });
    expect(run.frame().map(({ id }) => colorCode(id)).join('')).toBe('BRRLB'.repeat(3));
  });

  it('默认加权随机沿用旧随机流、格子顺序和实例索引', async () => {
    for (const seed of [1, 42, 2147483647]) {
      const base = await capture(template, manifest, { seed });
      const explicit = await capture(template, manifest, { materialDistribution: 'weightedRandom', seed });
      const rng = createRng(seed, 'blocks');
      const nextIndex = new Map<string, number>();
      const expected = Array.from({ length: 15 }, () => {
        const draw = rng.next() * 6;
        const id = entries[draw < 3 ? 0 : draw < 4 ? 2 : 3]!.id;
        const index = nextIndex.get(id) ?? 0;
        nextIndex.set(id, index + 1);
        return { id, index };
      });
      expect(base.frame().map(({ id, index }) => ({ id, index }))).toEqual(expected);
      expect(base.frame()).toEqual(explicit.frame());
      expect(base.requested).toEqual(entries.filter(({ id }) => nextIndex.has(id)).map(({ id }) => id));
      expect(base.rngKeys.filter((key) => key === 'blocks')).toEqual(['blocks']);
    }
  });
});

it('T-AST-7 七色混凝土各自解析到有双语名称的真实方块与贴图路径', () => {
  for (const color of ['red', 'orange', 'yellow', 'lime', 'light_blue', 'blue', 'purple']) {
    const id = `minecraft:${color}_concrete`;
    const block = getBlock(id);
    expect(NAMES[id]?.en).toBeTruthy();
    expect(NAMES[id]?.['zh-CN']).toBeTruthy();
    expect(block).toBeDefined();
    const { faces } = resolveBlockFaces(block!);
    expect(Object.values(faces).map(({ texture }) => textureIdToPath(texture))).toEqual(Array(6).fill(`assets/minecraft/textures/block/${color}_concrete.png`));
  }
});
