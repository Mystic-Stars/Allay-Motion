// T-ANIM-32：大文档下拖动的流畅度（docs/animation-editor.md 第 8 节）。64 个图层（一个方块图层带 16 × 16 = 256 份复制器，
// 21 个文字、42 个形状；每层 4 条属性各 4 个关键帧）。
// - 模拟拖动：每个动画帧改一次（拖动时每次指针移动就是一次改动），连续 120 帧，量界面的帧间隔（主线程卡不卡）
//   和预览在这段时间里实际更新了几次；
// - 单次改动：改完等预览画好再改下一次，量“改动 → 预览画好”的延迟。
// 数字打印出来写进文档；断言只防明显退化。软件渲染（CI 的 WARP）下只记数字、不判定（docs/decisions.md M8 的放宽清单）。
import { expect, test, type Page } from '@playwright/test';
import { launchApp, makeUserDataDir, removeUserDataDir, rendererOf, type Launched } from './helpers';
import { isSoftwareRenderer } from '../engine/software';

let launched: Launched | null = null;
let dir = '';

test.afterEach(async () => {
  await launched?.app.close();
  launched = null;
  removeUserDataDir(dir);
});

const ready = (page: Page) => page.waitForFunction(() => window.__allayTest?.previewUpToDate() === true, undefined, { timeout: 60_000 });

async function dispatch(page: Page, id: string, input?: unknown): Promise<unknown> {
  const r = await page.evaluate(({ id, input }) => window.__allayTest!.dispatch(id, input), { id, input });
  if (!r.ok) throw new Error(`${id}: ${r.message}`);
  return r.output;
}

function bigDoc(): Record<string, unknown> {
  const keys = (base: number, span: number) => ({ keys: [0, 0.6, 1.2, 1.8].map((t, i) => ({ t, v: base + (i % 2) * span, ease: 'cubicInOut' })) });
  const layers: Record<string, unknown>[] = [
    { id: 'wall', name: 'Wall', type: 'block', block: 'minecraft:stone', size: 40, props: { x: keys(0, 100), y: keys(0, 50), rotY: keys(0, 90), scale: keys(1, 0.5) }, repeat: { mode: 'grid', cols: 16, rows: 16, spacing: { x: 50, y: 50 }, stagger: 0.002, order: 'center' } },
  ];
  for (let i = 1; i < 64; i++) {
    const type = i % 3 === 0 ? 'text' : i % 3 === 1 ? 'rect' : 'ellipse';
    const content = type === 'text' ? { text: `Layer ${i}`, size: 4 } : { width: 60, height: 40, color: '#3CB7F4' };
    layers.push({ id: `l${i}`, name: `L${i}`, type, ...content, props: { x: keys(-800 + i * 25, 100), y: keys(-400 + (i % 8) * 100, 60), rotZ: keys(0, 45), opacity: keys(1, -0.5) } });
  }
  return { kind: 'allay-animation', formatVersion: 2, name: 'Perf', category: 'transition', duration: 2, cutTime: 1, params: [], sounds: [], layers };
}

type Edit = 'value' | 'move';
const editInput = (edit: Edit, i: number) =>
  edit === 'value' ? { id: 'animSetKeyframe', input: { layer: 'l5', prop: 'x', t: 0.6, v: 100 + i * 3 } } : { id: 'animMoveKeyframe', input: { layer: 'l7', prop: 'y', from: 0.6 + (i % 2) * 0.05, to: 0.6 + ((i + 1) % 2) * 0.05 } };

/** 模拟拖动：每个动画帧做一次改动，连续 n 帧；返回界面的帧间隔和预览每秒更新几次 */
async function drag(page: Page, n: number, edit: Edit): Promise<{ frames: number[]; updatesPerSecond: number }> {
  const inputs = Array.from({ length: n }, (_, i) => editInput(edit, i));
  return page.evaluate(async (inputs) => {
    const hooks = window.__allayTest!;
    const frame = () => new Promise<number>((r) => requestAnimationFrame((ts) => r(ts)));
    const frames: number[] = [];
    const loads0 = hooks.previewLoads();
    let last = await frame();
    const start = performance.now();
    for (const e of inputs) {
      void hooks.dispatch(e.id, e.input);
      const now = await frame();
      frames.push(now - last);
      last = now;
    }
    while (!hooks.previewUpToDate()) await frame();
    return { frames, updatesPerSecond: (hooks.previewLoads() - loads0) / ((performance.now() - start) / 1000) };
  }, inputs);
}

/** 单次改动的延迟：改完等预览画好（状态就绪、装载的版本是最新的、再过一帧）再改下一次 */
async function latency(page: Page, n: number, edit: Edit): Promise<number[]> {
  const inputs = Array.from({ length: n }, (_, i) => editInput(edit, i));
  return page.evaluate(async (inputs) => {
    const hooks = window.__allayTest!;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    const out: number[] = [];
    for (const e of inputs) {
      const t0 = performance.now();
      const r = await hooks.dispatch(e.id, e.input);
      if (!r.ok) throw new Error(r.message);
      while (!hooks.previewUpToDate()) await frame();
      await frame();
      out.push(performance.now() - t0);
    }
    return out;
  }, inputs);
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return { median: Math.round(s[Math.floor(s.length / 2)]!), p95: Math.round(s[Math.floor(s.length * 0.95)]!), max: Math.round(s.at(-1)!) };
};

test('T-ANIM-32 大文档（64 层、256 份复制、每层 16 个关键帧）里拖动关键帧的值、挪关键帧：界面不卡，预览跟得上', async () => {
  dir = makeUserDataDir();
  launched = await launchApp(dir);
  const { page } = launched;
  // 软件渲染下每帧真要约两帧（CI 上界面帧间隔中位数 30–35 ms，不是 60 Hz 帧长的整数倍），贴着判定线随机过不过；
  // 同 T-EXP-7、T-ARC-7，只把数字打进日志和注解看趋势，不判定。有显卡时判定照旧
  const gpu = await rendererOf(page);
  const software = isSoftwareRenderer(gpu);
  await dispatch(page, 'animNew', { name: 'Perf' });
  expect(((await dispatch(page, 'animSetText', { text: JSON.stringify(bigDoc(), null, 2) })) as { ok: boolean }).ok).toBe(true);
  await page.evaluate(() => window.__allayTest!.setTime(0.9));
  await ready(page);
  // 热身（第一次编译着色器、建实例、画文字）
  await latency(page, 3, 'value');
  for (const edit of ['value', 'move'] as const) {
    const d = await drag(page, 120, edit);
    const ui = stats(d.frames);
    const l = stats(await latency(page, 30, edit));
    const line = `T-ANIM-32 ${edit}: ui-frame ${JSON.stringify(ui)} preview-updates/s ${d.updatesPerSecond.toFixed(1)} latency ${JSON.stringify(l)}`;
    console.log(software ? `${line} （软件渲染 ${gpu}：只记不判）` : line);
    test.info().annotations.push({ type: `T-ANIM-32 ${edit}`, description: software ? `${line}; ${gpu}（软件渲染：只记不判）` : line });
    if (software) continue;
    // 防退化：界面的帧间隔中位数在两帧以内、预览每秒至少更新 15 次、单次延迟中位数 100 ms 以内
    expect(ui.median).toBeLessThan(34);
    expect(d.updatesPerSecond).toBeGreaterThan(15);
    expect(l.median).toBeLessThan(100);
  }
  // 拖完画面就是最后一次改动的结果（没有丢掉最后一次）
  const doc = JSON.parse(((await dispatch(page, 'animGet')) as { text: string }).text) as { layers: { id: string; props: { x: { keys: { t: number; v: number }[] } } }[] };
  expect(doc.layers.find((l) => l.id === 'l5')!.props.x.keys.find((k) => k.t === 0.6)!.v).toBe(100 + 29 * 3);
});
