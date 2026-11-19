import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { decodePng } from '../../scripts/mascot-bake/png';
import { TemplateManifestSchema, type ParamValues } from '../../packages/template-sdk/src/index';
import type { Harness } from './harness/harness';
import { BEDROCK_MARKERS } from './harness/versioned-resources';
import { isSoftwareRenderer } from './software';

const ROOT = resolve(import.meta.dirname, '../..');
const ELECTRON = createRequire(join(ROOT, 'apps/desktop/package.json'))('electron') as string;
const LOADING = 'allay.builtin.loading-screen';
const TOAST = 'allay.builtin.advancement-toast';
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'NODE_OPTIONS') env[key] = value;
  }
  app = await electron.launch({ executablePath: ELECTRON, args: [join(import.meta.dirname, 'electron-main.mjs')], env });
  page = await app.firstWindow();
  await page.waitForFunction(() => window.harnessReady === true);
});

test.afterAll(async () => { await app?.close(); });

function call<K extends keyof Harness>(name: K, ...args: Parameters<Harness[K]>): Promise<Awaited<ReturnType<Harness[K]>>> {
  return page.evaluate(([method, inputs]: readonly [keyof Harness, unknown[]]) => {
    const fn = window.harness[method] as (...values: unknown[]) => unknown;
    return fn(...inputs);
  }, [name, args as unknown[]] as const) as Promise<Awaited<ReturnType<Harness[K]>>>;
}

const ASPECTS = [[640, 360, '16x9'], [360, 640, '9x16'], [480, 480, '1x1']] as const;
const QUALITY = { subframes: 8, shutterAngle: 180 };
const SINGLE = { subframes: 1, shutterAngle: 0 };
const OUTPUT = { width: 160, height: 90, fps: 24 };
const BEDROCK_OUTPUT = { width: 480, height: 270, fps: 24 };
const SPANS = { inDuration: 0.25, hold: 0.75, outDuration: 0.25 };
const javaPanorama = [
  ...Array.from({ length: 6 }, (_, face) => `minecraft:gui/title/background/panorama_${face}`),
  'minecraft:gui/title/background/panorama_overlay', 'minecraft:gui/menu_background',
];
const bedrockPanorama = Array.from({ length: 6 }, (_, face) => `minecraft:ui/panorama_${face}`);
const bedrockTitle = 'minecraft:ui/title';
const bedrockPanel = 'minecraft:ui/dialog_background_hollow_3';
const bedrockLoop = 'minecraft:ui/loading_bar';
const bedrockBg = 'minecraft:ui/bg32';
const bedrockModal = [bedrockPanel, bedrockTitle];
const bedrockMeter = ['minecraft:ui/experiencebarempty', 'minecraft:ui/experiencebarfull', 'minecraft:ui/experiencenub'];
const javaWhite = ['minecraft:gui/title/mojang'];
const javaRed = ['minecraft:gui/title/mojangstudios'];
const javaDirt = ['minecraft:gui/options_background'];
const javaNether = ['minecraft:block/nether_portal'];
const javaEndSky = 'minecraft:environment/end_sky';
const javaEndClassic = 'minecraft:entity/end_portal';
const javaEndModern = 'minecraft:entity/end_portal/end_portal';
const javaOldAtlas = 'minecraft:gui/achievement/achievement_background';
const javaToastAtlas = 'minecraft:gui/toasts';
const javaToastSprite = 'minecraft:gui/sprites/toast/advancement';
const diamond = 'minecraft:item/diamond';
const bedrockToastPanel = 'minecraft:ui/greyborder';
const bedrockToastIcon = 'minecraft:ui/achievement_third_party';

const loadingAssets: Record<string, string[]> = {
  javaStartupWhite: javaWhite, javaStartupRed: javaRed, javaReloadWhite: javaWhite, javaReloadRed: javaRed,
  javaWorldDirt114: javaDirt, javaWorldDirt: javaDirt, javaTravelDirt: javaDirt,
  javaWorldPanorama: javaPanorama, javaWorldBar: javaPanorama, javaWorld263: javaPanorama,
  javaTravelOverworld: javaPanorama, javaTravelOverworld263: javaPanorama,
  javaTravelNether: javaNether, javaTravelNether263: javaNether,
  javaTravelEnd: [javaEndSky, javaEndClassic], javaTravelEnd263: [javaEndSky, javaEndModern],
  bedrockStartup: [bedrockTitle],
  bedrockPacks: [...bedrockPanorama, ...bedrockModal, bedrockLoop],
  bedrockWorld: [...bedrockPanorama, ...bedrockModal, bedrockLoop, ...bedrockMeter],
  bedrockTravelNether: [...bedrockModal, 'minecraft:blocks/netherrack'],
  bedrockTravelEnd: [...bedrockModal, 'minecraft:blocks/end_stone'],
  bedrockTravelOverworld: [...bedrockModal, 'minecraft:blocks/dirt'],
};
const toastAssets: Record<string, string[]> = {
  javaAchievement: [javaOldAtlas, diamond], javaAdvancement: [javaToastAtlas, diamond], javaAdvancement263: [javaToastSprite, diamond],
  bedrockAchievement: [bedrockToastPanel, bedrockToastIcon],
};

test('T-TPL-5 旧加载界面和旧提示框在三种画幅继续匹配既有基准', async () => {
  const limit = isSoftwareRenderer(await call('gpu')) ? 4 : 1.5;
  for (const id of [LOADING, TOAST]) {
    for (const [width, height, aspect] of ASPECTS) {
      const result = await call('tplKeyFrames', id, { width, height, fps: 60 }, QUALITY);
      expect(result.warnings).toEqual([]);
      for (const [key, encoded] of Object.entries(result.frames)) {
        const base = decodePng(readFileSync(join(ROOT, 'tests/fixtures/baselines', id, `${aspect}-${key}.png`)));
        const pixels = Buffer.from(encoded, 'base64');
        expect([base.width, base.height, pixels.length]).toEqual([width, height, base.data.length]);
        const error = pixels.reduce((sum, value, index) => sum + Math.abs(value - base.data[index]!), 0);
        expect(error / pixels.length, `${id} ${aspect} ${key}`).toBeLessThanOrEqual(limit);
      }
    }
  }
});

test('T-TPL-3/4 版本样式装载、透明首尾、转场覆盖和乱序确定性', async () => {
  const manifests = await call('builtins');
  const styles = (id: string, key: string) => {
    const def = TemplateManifestSchema.parse(manifests[id]).params?.find((param) => param.key === key);
    if (def?.type !== 'enum') throw new Error(`${id} missing ${key}`);
    return def.options.filter((option) => option.value !== 'generic').map((option) => option.value);
  };
  for (const [id, key, assets] of [[LOADING, 'loadingStyle', loadingAssets], [TOAST, 'toastStyle', toastAssets]] as const) {
    const options = styles(id, key);
    expect([...options].sort()).toEqual(Object.keys(assets).sort());
    for (const [index, style] of options.entries()) {
      const [width, height] = ASPECTS[index % ASPECTS.length]!;
      const params: ParamValues = { [key]: style, inDuration: 0.125, hold: 0.5, outDuration: 0.125 };
      if (id === LOADING) {
        params.cutAt = 0.5;
        params.loadingLanguage = index % 2 ? 'en' : 'zh-CN';
        params.inStyle = ['fade', 'slideUp', 'dissolve'][index % 3]!;
        params.outStyle = ['dissolve', 'fade', 'slideUp'][index % 3]!;
      } else {
        params.toastLanguage = index % 2 ? 'en' : 'zh-CN';
        params.margin = 120;
        params.title = index % 2 ? 'A long advancement name now' : '中文世界中的超长成就名称测试';
      }
      const result = await call('tplCheck', id, { width: width / 4, height: height / 4, fps: 24 }, { subframes: 2, shutterAngle: 360 }, params, true, {});
      expect(result.warnings, style).toEqual([]);
      expect(result.textures, style).toEqual([...assets[style]!].sort());
      expect(result.mismatched, style).toEqual([]);
      expect(result.deterministic, style).toBe(true);
      expect(result.distinct, style).toBeGreaterThan(2);
      expect([result.first.max, result.last.max], style).toEqual([0, 0]);
      if (id === LOADING) {
        expect(result.cutTime, style).toBeCloseTo(0.375, 8);
        expect(result.cut?.min, style).toBe(255);
      } else expect(result.cutTime, style).toBeNull();
    }
  }
});

test('T-TPL-4 已绑定资源时，Java 门与 Java／基岩全景分别运动及冻结', async () => {
  const points: [number, number][] = [[8, 9], [20, 70], [135, 17]];
  for (const loadingStyle of ['javaTravelNether', 'javaWorldBar', 'bedrockWorld']) {
    const params = { ...SPANS, loadingStyle };
    const moving = await call('versionedPixels', LOADING, OUTPUT, params, [9, 19], points);
    const still = await call('versionedPixels', LOADING, OUTPUT, { ...params, animateBackground: false }, [9, 19], points);
    expect(moving.warnings, loadingStyle).toEqual([]);
    expect(still.warnings, loadingStyle).toEqual([]);
    expect(moving.frames[0], loadingStyle).not.toEqual(moving.frames[1]);
    expect(still.frames[0], loadingStyle).toEqual(still.frames[1]);
    expect(still.frames[0]?.every((pixel) => pixel[3] === 255), loadingStyle).toBe(true);
  }
});

test('T-TPL-4 冻结背景后仍推进 Java 条、基岩往返帧与确定进度', async () => {
  const frozen = { ...SPANS, animateBackground: false };
  const bar = await call('versionedPixels', LOADING, { ...OUTPUT, width: 960, height: 540 }, { ...frozen, loadingStyle: 'javaWorldBar' }, [9, 19], [[414, 173]]);
  expect(bar.warnings).toEqual([]);
  expect(bar.frames).toEqual([[[0, 0, 0, 255]], [[0, 255, 0, 255]]]);

  const packs = await call('versionedPixels', LOADING, BEDROCK_OUTPUT, { ...frozen, hold: 1.25, loadingStyle: 'bedrockPacks' }, [9, 19, 23, 27], [[240, 163], [20, 230]]);
  expect(packs.warnings).toEqual([]);
  expect(packs.textures).toEqual([...loadingAssets.bedrockPacks!].sort());
  // 24 fps 取样、10 fps 往返：图集第 3、7、9、7 帧；着色器在线性空间乘 0.7。
  const srgb = (linear: number) => linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055;
  for (const [index, atlasFrame] of [3, 7, 9, 7].entries()) {
    const sourceRed = (32 + 20 * atlasFrame) / 255;
    const expectedRed = Math.round(srgb(0.7 * ((sourceRed + 0.055) / 1.055) ** 2.4) * 255);
    const [red, green, blue, alpha] = packs.frames[index]![0]!;
    expect(Math.abs(red! - expectedRed), `图集帧 ${atlasFrame}`).toBeLessThanOrEqual(1);
    expect([green, blue, alpha]).toEqual([0, 0, 255]);
    expect(packs.frames[index]![1]).toEqual(packs.frames[0]![1]);
  }
  expect(packs.frames[3]).toEqual(packs.frames[1]);

  // 480×270 时一个 GUI 单位正好一像素。条覆盖 x=114.9…365.1、y=161…166，首条分隔 x=119.9…120.9。
  // 15/24 和 22/24 秒的填充端点约 x=179.2 与 x=355.1；为条、分隔、面板外背景各自取样。
  const points: [number, number][] = [[116, 163], [120, 163], [185, 163], [362, 163], [185, 158], [20, 230]];
  const world = await call('versionedPixels', LOADING, BEDROCK_OUTPUT, { ...frozen, loadingStyle: 'bedrockWorld' }, [15, 22], points);
  expect(world.warnings).toEqual([]);
  expect(world.textures).toEqual([...loadingAssets.bedrockWorld!].sort());
  const { divider, empty, fill } = BEDROCK_MARKERS;
  expect(world.frames[0]!.slice(0, 4)).toEqual([fill, divider, empty, empty]);
  expect(world.frames[1]!.slice(0, 4)).toEqual([fill, divider, fill, empty]);
  expect(world.frames[0]!.slice(4)).toEqual(world.frames[1]!.slice(4));
  expect(world.frames.flat().every((pixel) => pixel[3] === 255)).toBe(true);
});

test('T-FID Java 两种图集只绘制有色裁区；26.3 绘制独立 sprite', async () => {
  const colors: number[][] = [];
  for (const toastStyle of ['javaAchievement', 'javaAdvancement', 'javaAdvancement263']) {
    const result = await call('versionedPixels', TOAST, OUTPUT, { ...SPANS, toastStyle, guiScale: 4 }, [12], [[156, 1]]);
    expect(result.warnings, toastStyle).toEqual([]);
    const pixel = result.frames[0]?.[0];
    expect(pixel?.[3], toastStyle).toBe(255);
    colors.push(pixel!.slice(0, 3));
  }
  expect(new Set(colors.map((color) => color.join(','))).size).toBe(3);
});

test('T-FID 探测候选不误报；实际缺图才告警并保留有效画面', async () => {
  const loading = await call('tplCheck', LOADING, OUTPUT, SINGLE, { ...SPANS, loadingStyle: 'javaWorld263' }, false, { missing: [javaPanorama[4]!] });
  expect(loading.textures).toEqual(javaPanorama.slice(0, 6).sort());
  expect(loading.warnings).toEqual([expect.stringMatching(/panorama_0…5.+plain dark background/)]);
  expect([loading.first.max, loading.cut?.min, loading.last.max]).toEqual([0, 255, 0]);
  const fallback = await call('versionedPixels', TOAST, OUTPUT, { ...SPANS, toastStyle: 'javaAdvancement', guiScale: 4 }, [12], [[156, 1]], [javaToastAtlas]);
  expect(fallback.textures).toEqual([javaToastAtlas, javaToastSprite, diamond].sort());
  expect(fallback.warnings).toEqual([]);
  expect(fallback.frames[0]?.[0]?.[3]).toBe(255);
  const missing = await call('versionedPixels', TOAST, OUTPUT, { ...SPANS, toastStyle: 'javaAdvancement', guiScale: 4 }, [12], [[156, 1]], [javaToastAtlas, javaToastSprite]);
  expect(missing.warnings).toEqual([expect.stringMatching(/Java toast panel unavailable.+no substitute panel/)]);
  expect(missing.frames).toEqual([[[0, 0, 0, 0]]]);

  const bedrock = await call('tplCheck', LOADING, OUTPUT, SINGLE, { ...SPANS, loadingStyle: 'bedrockPacks' }, false, { missing: [bedrockLoop] });
  expect(bedrock.textures).toEqual([...loadingAssets.bedrockPacks!].sort());
  expect(bedrock.warnings).toEqual([expect.stringMatching(/Bedrock panel or bar textures are missing.+neutral substitutes/)]);
  expect([bedrock.first.max, bedrock.cut?.min, bedrock.last.max]).toEqual([0, 255, 0]);
});

test('T-FID 基岩回退顺序、自选静态图和无进度条分支', async () => {
  const params = { ...SPANS, loadingStyle: 'bedrockWorld' };
  const frames = [9, 19];
  const background: [number, number] = [20, 230];
  const title: [number, number] = [240, 42];
  const bgImage = 'test:ui/custom_background';
  const titleImage = 'test:ui/custom_title';
  const defaultTextures = loadingAssets.bedrockWorld!;
  const full = await call('versionedPixels', LOADING, BEDROCK_OUTPUT, params, frames, [background]);
  const tiled = await call('versionedPixels', LOADING, BEDROCK_OUTPUT, params, frames, [background], [bedrockPanorama[4]!]);
  expect(tiled.textures).toEqual([...defaultTextures, bedrockBg].sort());
  expect(tiled.warnings).toEqual([expect.stringContaining('Bedrock background assets are missing')]);
  expect(tiled.frames[0]).toEqual(tiled.frames[1]);
  expect(tiled.frames[0]).not.toEqual(full.frames[0]);
  const solid = await call('versionedPixels', LOADING, BEDROCK_OUTPUT, params, frames, [background], [bedrockPanorama[4]!, bedrockBg]);
  expect(solid.textures).toEqual(tiled.textures);
  expect(solid.warnings).toEqual(tiled.warnings);
  expect(solid.frames).toEqual([[[51, 49, 46, 255]], [[51, 49, 46, 255]]]);

  const overrides = { bedrockBackground: bgImage, bedrockTitle: titleImage, showBar: false };
  const custom = await call('versionedPixels', LOADING, BEDROCK_OUTPUT, { ...params, ...overrides }, frames, [background, title]);
  expect(custom.textures).toEqual([bedrockPanel, bgImage, titleImage].sort());
  expect(custom.warnings).toEqual([]);
  expect(custom.frames).toEqual(frames.map(() => [BEDROCK_MARKERS.customBackground, BEDROCK_MARKERS.customTitle]));
  const invalid = await call('versionedPixels', LOADING, BEDROCK_OUTPUT, { ...params, ...overrides }, frames, [background, title], [bgImage, titleImage]);
  expect(invalid.textures).toEqual([...bedrockPanorama, ...bedrockModal, bgImage, titleImage].sort());
  expect(invalid.warnings).toEqual(expect.arrayContaining([
    expect.stringContaining('selected Bedrock background could not be read'),
    expect.stringContaining('selected Bedrock title image could not be read'),
  ]));
  expect(invalid.warnings).toHaveLength(2);
  expect(invalid.frames[0]![0]).toEqual(full.frames[0]![0]);
  expect(invalid.frames[0]![1]).not.toEqual(BEDROCK_MARKERS.customTitle);

  const travel = { ...params, loadingStyle: 'bedrockTravelNether', bedrockTitle: titleImage };
  const tile = 'minecraft:blocks/netherrack';
  const dimension = await call('versionedPixels', LOADING, BEDROCK_OUTPUT, travel, frames, [background, title, [240, 163]]);
  expect(dimension.textures).toEqual([tile, bedrockPanel, titleImage].sort());
  expect(dimension.warnings).toEqual([]);
  expect(dimension.frames[0]).toEqual(dimension.frames[1]);
  expect(dimension.frames[0]![1]).toEqual(BEDROCK_MARKERS.customTitle);
  const noTile = await call('versionedPixels', LOADING, BEDROCK_OUTPUT, travel, frames, [background], [tile]);
  expect(noTile.textures).toEqual(dimension.textures);
  expect(noTile.warnings).toEqual(tiled.warnings);
  expect(noTile.frames).toEqual([[[69, 39, 40, 255]], [[69, 39, 40, 255]]]);
});

test('T-FID Java 末地首选版号贴图路径，仅缺图时跨版回退', async () => {
  for (const [loadingStyle, primary, alternate] of [
    ['javaTravelEnd', javaEndClassic, javaEndModern],
    ['javaTravelEnd263', javaEndModern, javaEndClassic],
  ] as const) {
    const params = { ...SPANS, loadingStyle };
    const fallback = await call('tplCheck', LOADING, OUTPUT, SINGLE, params, false, { missing: [primary] });
    expect(fallback.textures).toEqual([javaEndSky, primary, alternate].sort());
    expect(fallback.warnings).toEqual([expect.stringContaining('using the other verified Java version’s End texture path')]);
    expect(fallback.cut?.min).toBe(255);
    const missing = await call('tplCheck', LOADING, OUTPUT, SINGLE, params, false, { missing: [primary, alternate] });
    expect(missing.textures).toEqual(fallback.textures);
    expect(missing.warnings).toEqual([expect.stringContaining('using a plain dark background')]);
    expect(missing.cut?.min).toBe(255);
  }
});

test('T-FID Java 末地 15 层投影经标准画质合成后可寻帧且背景独立冻结', async () => {
  for (const loadingStyle of ['javaTravelEnd', 'javaTravelEnd263']) {
    const params = { ...SPANS, loadingStyle };
    const moving = await call('versionedComposition', LOADING, params);
    const frozen = await call('versionedComposition', LOADING, { ...params, animateBackground: false });
    for (const result of [moving, frozen]) {
      expect(result.textures, loadingStyle).toEqual([...loadingAssets[loadingStyle]!].sort());
      expect(result.warnings, loadingStyle).toEqual([]);
      expect(result.alpha, loadingStyle).toEqual([{ min: 0, max: 0 }, { min: 255, max: 255 }, { min: 255, max: 255 }, { min: 0, max: 0 }]);
      expect(result.background.every((frame) => new Set(frame.map((pixel) => pixel.join(','))).size > 1), loadingStyle).toBe(true);
      expect(result.deterministic, loadingStyle).toBeNull();
    }
    expect(moving.background[0], loadingStyle).not.toEqual(moving.background[1]);
    expect(frozen.background[0], loadingStyle).toEqual(frozen.background[1]);
  }
});
