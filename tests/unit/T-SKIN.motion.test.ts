import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { defaultParams, parseManifest, studioMaterialManifest, studioMaterialRefs, type SetupContext, type TemplateModule } from '../../packages/template-sdk/src/index';
import manifest from '../../packages/template-sdk/src/studio/player.json';

const root = resolve(import.meta.dirname, '../..');
const requireEngine = createRequire(join(root, 'packages/engine/package.json'));
const three = await import(pathToFileURL(requireEngine.resolve('three').replace(/three\.cjs$/, 'three.module.js')).href) as SetupContext['THREE'];
const source = '../../packages/engine/src/studio/player';
type Three = SetupContext['THREE'];
type Group = InstanceType<Three['Group']>;
type Texture = InstanceType<Three['Texture']>;
type Action = 'idle' | 'walk' | 'sprint' | 'jump';
type Edition = 'java' | 'bedrock';
type Rig = { upper: Group; head: Group; rightArm: Group; leftArm: Group; leftLeg: Group };
const { default: template } = await import(`${source}/index.ts`) as { default: TemplateModule };
const { buildRig } = await import(`${source}/rig.ts`) as { buildRig(three: Three, texture: Texture, height: number, slim: boolean): Rig };
const { sampleMotion } = await import(`${source}/motion.ts`) as {
  sampleMotion(time: number, action: Action, edition: Edition, bob: number): { lift: number; bobX: number; bobY: number; roll: number };
};
const ref = 'skins:39ed46af-e1e9-437c-8d55-347ab4c2ec3f';

function rig(height: number, slim: boolean) {
  return buildRig(three, new three.Texture(), height, slim);
}

function mesh(parent: ReturnType<typeof rig>['head'], layer: 'base' | 'outer') {
  const child = parent.children.find((object) => object.name === layer);
  if (!(child instanceof three.Mesh)) throw new Error('missing test mesh');
  return child;
}

function face(parent: ReturnType<typeof rig>['head'], layer: 'base' | 'outer', index: number, height: number) {
  const uv = mesh(parent, layer).geometry.getAttribute('uv');
  return Array.from({ length: 4 }, (_, corner) => [uv.getX(index * 4 + corner) * 64, (1 - uv.getY(index * 4 + corner)) * height]);
}

describe('T-SKIN-3 几何与布料 UV', () => {
  it('宽臂、窄臂分别用四列和三列的正面；袖、帽、裤、外衣各自取第二层且保留透明', () => {
    const classic = rig(64, false);
    const slim = rig(64, true);
    expect(mesh(classic.rightArm, 'base').geometry.getAttribute('position').getX(0)).toBe(2);
    expect(mesh(slim.rightArm, 'base').geometry.getAttribute('position').getX(0)).toBe(1.5);
    expect(face(classic.rightArm, 'base', 4, 64)).toEqual([[44, 20], [48, 20], [44, 32], [48, 32]]);
    expect(face(slim.rightArm, 'outer', 4, 64)).toEqual([[44, 36], [47, 36], [44, 48], [47, 48]]);
    expect(face(slim.leftArm, 'outer', 4, 64)).toEqual([[52, 52], [55, 52], [52, 64], [55, 64]]);
    expect(face(slim.head, 'outer', 4, 64)).toEqual([[40, 8], [48, 8], [40, 16], [48, 16]]);
    expect(face(slim.leftLeg, 'outer', 4, 64)).toEqual([[4, 52], [8, 52], [4, 64], [8, 64]]);
    const body = slim.upper.children.find((object) => object.name === 'body');
    if (!(body instanceof three.Group)) throw new Error('missing body');
    expect(face(body, 'outer', 4, 64)).toEqual([[20, 36], [28, 36], [20, 48], [28, 48]]);
    expect(mesh(slim.rightArm, 'outer').material).toMatchObject({ transparent: true, depthWrite: false });
  });

  it('旧宽臂格式镜像两个左肢，交换其两侧面，只留帽子外层', () => {
    const legacy = rig(32, true);
    expect(mesh(legacy.leftArm, 'base').geometry.getAttribute('position').getX(0)).toBe(2);
    expect(face(legacy.leftArm, 'base', 4, 32)).toEqual([[48, 20], [44, 20], [48, 32], [44, 32]]);
    expect(face(legacy.leftArm, 'base', 0, 32)).toEqual([[44, 20], [40, 20], [44, 32], [40, 32]]);
    expect(face(legacy.leftLeg, 'base', 4, 32)).toEqual([[8, 20], [4, 20], [8, 32], [4, 32]]);
    expect(legacy.leftLeg.children).toHaveLength(1);
    expect(legacy.rightArm.children).toHaveLength(1);
    expect(legacy.head.children).toHaveLength(2);
  });
});

function harness(params: SetupContext['params']) {
  const scene = new three.Scene();
  const texture = new three.DataTexture(new Uint8Array(64 * 64 * 4), 64, 64);
  const resolveTexture = vi.fn(async () => texture);
  const setCamera = vi.fn<SetupContext['setCamera']>();
  const ctx = { THREE: three, scene, stage: { width: 1920, height: 1080, aspect: 16 / 9, fps: 60, pixelScale: 1 }, params, resources: { texture: resolveTexture }, setCamera } as unknown as SetupContext;
  const snapshot = () => {
    const values: unknown[] = [];
    scene.updateMatrixWorld(true);
    scene.traverse((object) => { values.push([object.name, object.visible, [...object.matrixWorld.elements]]); });
    return values;
  };
  return { scene, ctx, snapshot, resolveTexture, setCamera };
}

describe('T-SKIN-4 绝对时间动作与镜头', () => {
  it.each(['first', 'third'] as const)('%s：乱序采样和重复采样拿到相同变换', async (view) => {
    const { scene, ctx, snapshot, resolveTexture, setCamera } = harness({ skin: ref, action: 'sprint', view });
    const instance = await template.setup(ctx);
    expect(resolveTexture).toHaveBeenCalledExactlyOnceWith(ref);
    expect(setCamera).toHaveBeenCalledOnce();
    const [camera, player] = scene.children;
    const viewArm = camera?.children[0];
    instance.update(0);
    expect(player?.visible).toBe(false);
    if (viewArm) expect(viewArm.visible).toBe(false);
    instance.update(0.28);
    expect(player?.visible).toBe(view === 'third');
    expect(viewArm?.visible ?? false).toBe(view === 'first');
    const first = snapshot();
    instance.update(2.28);
    expect(snapshot()).not.toEqual(first);
    instance.update(0.017);
    instance.update(0.28);
    expect(snapshot()).toEqual(first);
    instance.update(179 / 60);
    expect(player?.visible).toBe(false);
    if (viewArm) expect(viewArm.visible).toBe(false);
  });

  it('四个动作与两个版本各异，关掉 bob 不改姿势，跳起后落回地面', () => {
    const actions: Action[] = ['idle', 'walk', 'sprint', 'jump'];
    const editions: Edition[] = ['java', 'bedrock'];
    for (const edition of editions) {
      expect(new Set(actions.map((action) => JSON.stringify(sampleMotion(0.33, action, edition, 1)))).size).toBe(4);
      expect(sampleMotion(0.46, 'jump', edition, 1).lift).toBeGreaterThan(4);
      expect(sampleMotion(0.95, 'jump', edition, 1).lift).toBe(0);
    }
    const withBob = sampleMotion(0.33, 'sprint', 'java', 1);
    const without = sampleMotion(0.33, 'sprint', 'java', 0);
    expect(withBob).not.toEqual(sampleMotion(0.33, 'sprint', 'bedrock', 1));
    expect(without).toEqual({ ...withBob, bobX: Math.sign(withBob.bobX) * 0, bobY: -0, roll: Math.sign(withBob.roll) * 0 });
  });

  it('默认无皮肤时不请求资源也不画占位模型', async () => {
    const { ctx, scene, resolveTexture } = harness({});
    const instance = await template.setup(ctx);
    instance.update(0.5);
    expect(resolveTexture).not.toHaveBeenCalled();
    expect(scene.children).toEqual([]);
  });
});

it('T-SKIN-5 工作台通过旧版本引用取得原生玩家参数，不匹配的版本不回退', () => {
  const parsed = parseManifest(manifest);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(defaultParams(parsed.manifest.params ?? [], { locale: 'en' })).toMatchObject({ skin: '', view: 'third' });
  expect(studioMaterialManifest(studioMaterialRefs.player)).toEqual(parsed.manifest);
  expect(studioMaterialManifest({ ...studioMaterialRefs.player, version: '0.0.0' })).toBeUndefined();
});
