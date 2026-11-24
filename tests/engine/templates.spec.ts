// pnpm test:engine：内置模板的验收测试（docs/04-templates.md 4.11 的 T-TPL-3、T-TPL-4、T-TPL-5）。
// 资源是测试脚本生成的纯色假资源栈（fake-resources.ts），不含任何原版贴图。窗口不显示、不抢焦点。
//
// 模板多了以后可以只跑一部分（tests/engine/shard.ts）：ALLAY_TPL_SHARD="i/n" 分片，ALLAY_TPL_ONLY="名字,名字" 指定模板。
// 分片只决定跑哪些模板，每个模板的检查不变；n 份合起来是全部。
//
// T-TPL-5 的基准图在 tests/fixtures/baselines/<模板 id>/ 下，由 `pnpm templates:baselines` 重新生成（同一份测试，
// 设 ALLAY_UPDATE_BASELINES=1 时写入而不是比较）。基准图在真实显卡上生成；软件渲染时判定放宽到 4/255（4.11）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { decodePng, encodePng } from '../../scripts/mascot-bake/png';
import { TemplateManifestSchema, type FrameQuality, type TemplateManifest } from '../../packages/template-sdk/src/index';
import type { Harness } from './harness/harness';
import { prng, randomParamSets } from './random-params';
import { probeRenderTargets, type RtProbeVerdict } from './rt-probe';
import { selectionFromEnv, selectTemplateIds } from './shard';
import { isSoftwareRenderer } from './software';

const ROOT = resolve(import.meta.dirname, '../..');
const ELECTRON = createRequire(join(ROOT, 'apps/desktop/package.json'))('electron') as string;
export const BASELINE_DIR = join(ROOT, 'tests/fixtures/baselines');
const UPDATE = process.env.ALLAY_UPDATE_BASELINES === '1';

let app: ElectronApplication;
let page: Page;
/** 这一次要跑的内置模板（全部，或 ALLAY_TPL_SHARD / ALLAY_TPL_ONLY 挑出的那部分） */
let builtins: Record<string, TemplateManifest> = {};
/** 内置模板的总数（不受挑选影响） */
let builtinCount = 0;
/** 渲染目标稳定性探针的结论：不稳定时 T-TPL-3/4 里逐字节的 T-ENG-1 判定带理由跳过，其余判定照常（tests/engine/rt-probe.ts） */
let rt: RtProbeVerdict;

test.beforeAll(async () => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE' && k !== 'NODE_OPTIONS') env[k] = v;
  app = await electron.launch({ executablePath: ELECTRON, args: [join(import.meta.dirname, 'electron-main.mjs')], env });
  page = await app.firstWindow();
  await page.waitForFunction(() => window.harnessReady === true);
  rt = await probeRenderTargets(app, page);
  console.log(`[templates] ${rt.summary}`);
  const raw = await call('builtins');
  builtinCount = Object.keys(raw).length;
  const selected = selectTemplateIds(Object.keys(raw), selectionFromEnv(process.env));
  builtins = Object.fromEntries(selected.map((id) => [id, TemplateManifestSchema.parse(raw[id])]));
  console.log(`[templates] ${selected.length} of ${builtinCount} built-in templates selected`);
});

test.afterAll(async () => {
  await app?.close();
});

type Fn = { [K in keyof Harness]: Harness[K] extends (...a: infer A) => infer R ? (...a: A) => R : never };
function call<K extends keyof Harness>(name: K, ...args: Parameters<Fn[K]>): Promise<Awaited<ReturnType<Fn[K]>>> {
  return page.evaluate(
    ([n, a]) => (window.harness[n as keyof Harness] as (...x: unknown[]) => unknown)(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<Fn[K]>>>;
}

const STANDARD: FrameQuality = { subframes: 8, shutterAngle: 180 };
const ASPECTS = [
  { name: '16x9', width: 1920, height: 1080 },
  { name: '9x16', width: 1080, height: 1920 },
  { name: '1x1', width: 1080, height: 1080 },
] as const;

/** 4.6 第 6 条 */
const DURATION_RANGE = [0.1, 30] as const;

/** 软件渲染（CI 的 WARP）只放宽测试自身的时限（tests/engine/software.ts）；判定和显卡上一样 */
async function rendererRules(): Promise<{ software: boolean; gpu: string }> {
  const gpu = await call('gpu');
  const software = isSoftwareRenderer(gpu);
  return { software, gpu };
}

/**
 * 测试自身的时限按这一份选中的模板数算，每个模板一份预算，不少于原来的数。原来按 6 个模板写死（显卡 600 秒、1800 秒，
 * 软件渲染一小时）；38 个模板分 4 份时 CI 的软件渲染上每份 9–10 个，T-TPL-3、T-TPL-4 都撞了一小时（docs/decisions.md“v0.3.0 的发版准备”）。
 * 预算：显卡上 T-TPL-3 每个 100 秒、T-TPL-4 每个 300 秒（原来的数除以 6）；软件渲染两条都是每个 900 秒（一小时除以 6 再放宽一半）
 */
function perTemplateTimeout(base: number, perTemplate: number): number {
  return Math.max(base, Object.keys(builtins).length * perTemplate);
}

/** 剪辑点没盖满时把位置打进日志（CI 上看是边缘还是内部，docs/decisions.md M8） */
function reportCut(where: string, width: number, height: number, cut: { min: number; below: number; samples: [number, number, number][] } | null | undefined): void {
  if (!cut || cut.min >= 255) return;
  console.log(`[cut<255] ${where} ${width}x${height} below=${cut.below} min=${cut.min} samples(x,y,a)=${JSON.stringify(cut.samples)}`);
}

test('T-TPL-3 每个内置模板、三种画幅、默认参数：无警告，通过 T-ENG-1，首末帧全透明，剪辑点完全不透明', async () => {
  const rules = await rendererRules();
  // WARP 上同样的工作量慢二三十倍
  test.setTimeout(rules.software ? perTemplateTimeout(3_600_000, 900_000) : perTemplateTimeout(600_000, 100_000));
  test.info().annotations.push({ type: 'renderer', description: rules.gpu }, { type: 'rt-probe', description: rt.summary });
  // 分片时这一份可以是空的（模板比份数少），但内置模板本身不能一个都没有
  expect(builtinCount).toBeGreaterThan(0);
  for (const [id, manifest] of Object.entries(builtins)) {
    for (const a of ASPECTS) {
      const r = await call('tplCheck', id, { width: a.width, height: a.height, fps: 60 }, STANDARD, {}, true);
      const where = `${id} ${a.name}`;
      expect(r.warnings, `${where} warnings`).toEqual([]);
      // 逐字节的 T-ENG-1：探针证明这块显卡会写坏渲染目标时跳过（rt-probe 注解里有探针的结果）
      if (rt.stable) {
        expect(r.mismatched, `${where} T-ENG-1 mismatched frames ${JSON.stringify(r.debug)}`).toEqual([]);
        expect(r.deterministic, `${where} T-ENG-1`).toBe(true);
      }
      // 确实在动。转场类照旧要求一半以上的帧互不相同；叠加层（没有剪辑点，如 T6 的提示框）在停留阶段本来就静止，
      // 停留阶段内部的帧不计入（docs/decisions.md M6a）
      const holdDef = manifest.params?.find((p) => p.key === 'hold');
      const holdSeconds = manifest.category !== 'transition' && holdDef?.type === 'duration' ? holdDef.default : 0;
      const still = Math.max(0, Math.floor(holdSeconds * 60) - 1);
      expect(r.distinct, `${where} distinct frames`).toBeGreaterThan((r.total - still) / 2);
      expect(r.first.max, `${where} first frame`).toBe(0);
      expect(r.last.max, `${where} last frame`).toBe(0);
      reportCut(where, a.width, a.height, r.cut);
      if (manifest.category === 'transition') {
        expect(r.cut, `${where} has a cut`).not.toBeNull();
        expect(r.cut!.min, `${where} cut frame`).toBe(255);
      }
      test.info().annotations.push({ type: where, description: `duration ${r.duration}, cut ${r.cutTime}, ${r.total} frames, ${r.cues} cues` });
    }
  }
});

test('T-TPL-4 每个内置模板 50 组随机合法参数：不抛错，三条断言仍成立，duration 在规定范围内', async () => {
  const rules = await rendererRules();
  test.setTimeout(rules.software ? perTemplateTimeout(3_600_000, 900_000) : perTemplateTimeout(1_800_000, 300_000));
  test.info().annotations.push({ type: 'renderer', description: rules.gpu }, { type: 'rt-probe', description: rt.summary });
  for (const [id, manifest] of Object.entries(builtins)) {
    const sets = randomParamSets(manifest.params ?? [], 50, 20261113);
    const r = prng(7);
    for (const [k, params] of sets.entries()) {
      // 画幅、帧率、画质、快门角也随机：首末帧透明、剪辑点不透明要在任意画质和 0–360° 快门角下成立
      const aspect = ASPECTS[k % 3]!;
      const scale = 1 / 8;
      const fps = [24, 30, 60][Math.floor(r() * 3)]!;
      const quality: FrameQuality = { subframes: [1, 2, 4, 8, 16][Math.floor(r() * 5)]!, shutterAngle: k % 5 === 0 ? 360 : Math.floor(r() * 361) };
      const output = { width: aspect.width * scale, height: aspect.height * scale, fps };
      const where = `${id} #${k} ${aspect.name} ${fps}fps N=${quality.subframes} A=${quality.shutterAngle} ${JSON.stringify(params)}`;
      const res = await call('tplCheck', id, output, quality, params, true);
      expect(res.duration, where).toBeGreaterThanOrEqual(DURATION_RANGE[0]);
      expect(res.duration, where).toBeLessThanOrEqual(DURATION_RANGE[1]);
      expect(res.warnings, where).toEqual([]);
      // 逐字节的 T-ENG-1：探针证明这块显卡会写坏渲染目标时跳过（同 T-TPL-3）
      if (rt.stable) expect(res.deterministic, `${where} T-ENG-1 ${JSON.stringify(res.debug)}`).toBe(true);
      expect(res.first.max, `${where} first frame`).toBe(0);
      expect(res.last.max, `${where} last frame`).toBe(0);
      reportCut(where, output.width, output.height, res.cut);
      if (manifest.category === 'transition') expect(res.cut?.min, `${where} cut frame`).toBe(255);
    }
  }
});

const KEY_FRAMES = ['p0', 'p25', 'cut', 'p75', 'p100'] as const;
const BASELINE_SIZES = [
  { name: '16x9', width: 640, height: 360 },
  { name: '9x16', width: 360, height: 640 },
  { name: '1x1', width: 480, height: 480 },
] as const;

test('T-TPL-5 每个内置模板 0%、25%、cutTime、75%、100% 五帧与基准图比较：平均绝对误差 ≤ 1.5/255（软件渲染 4/255）', async () => {
  test.setTimeout(300_000);
  const gpu = await call('gpu');
  const software = isSoftwareRenderer(gpu);
  const limit = software ? 4 : 1.5;
  test.info().annotations.push({ type: 'renderer', description: `${gpu}（判定 ≤ ${limit}/255）` });
  for (const id of Object.keys(builtins)) {
    const dir = join(BASELINE_DIR, id);
    for (const size of BASELINE_SIZES) {
      const r = await call('tplKeyFrames', id, { width: size.width, height: size.height, fps: 60 }, STANDARD);
      expect(r.warnings).toEqual([]);
      for (const key of KEY_FRAMES) {
        const pixels = new Uint8Array(Buffer.from(r.frames[key]!, 'base64'));
        const file = join(dir, `${size.name}-${key}.png`);
        if (UPDATE) {
          mkdirSync(dir, { recursive: true });
          writeFileSync(file, encodePng({ width: size.width, height: size.height, data: pixels }));
          continue;
        }
        expect(existsSync(file), `baseline ${file} (run pnpm templates:baselines)`).toBe(true);
        const base = decodePng(readFileSync(file));
        expect([base.width, base.height]).toEqual([size.width, size.height]);
        let sum = 0;
        for (let i = 0; i < pixels.length; i++) sum += Math.abs(pixels[i]! - base.data[i]!);
        const mae = sum / pixels.length;
        test.info().annotations.push({ type: `${id} ${size.name} ${key}`, description: `MAE ${mae.toFixed(4)}/255 (frame ${r.indices[key]})` });
        expect(mae, `${id} ${size.name} ${key}`).toBeLessThanOrEqual(limit);
      }
    }
  }
});
