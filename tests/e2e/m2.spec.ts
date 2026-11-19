import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { requiredTextures } from '../../packages/assets/src/index';
import { buildZip, catalogJarEntries, makeCatalogGame, packMcmeta, solidPng, tex, writeFiles, writeZip } from '../unit/helpers/resource-fixtures';
import { startFakeMojang, type FakeMojang } from './fake-mojang';
import { ROOT, launchApp, makeUserDataDir, readMainLog, removeUserDataDir, type Launched } from './helpers';

// M2 的端到端测试：资源栈经 IPC 和界面接进预览（叠加顺序、开关、重排）、拖入资源包（含恶意 zip，T-AST-5 的界面部分）、
// 首次发现本机游戏的询问、没有素材时的引导状态、原版下载的同意—进度—取消—失败—成功（本机假服务器），
// T-AST-2（只有一个假原版层时内置模板没有警告）、缩略图的磁盘缓存。
// 游戏、资源包、jar 全部是测试脚本生成的纯色色块，不碰这台机器上真装的游戏，也不访问真实网络。

type Locale = { resources: { addErrors: Record<string, string>; download: { errors: Record<string, string> } } };
const locale = (name: string): Locale => JSON.parse(readFileSync(join(ROOT, 'apps/desktop/src/renderer/i18n/locales', name), 'utf8')) as Locale;
const en = locale('en.json');
const zhCN = locale('zh-CN.json');
async function messages(page: Page) {
  const lang = await page.evaluate(() => document.documentElement.lang);
  return lang.startsWith('zh') ? zhCN : en;
}

const REQUIRED = requiredTextures().map((r) => ({ id: r.id, path: r.anyOf[0]! }));
const DIAMOND = 'minecraft:block/diamond_block';
const GREEN = '#20e020';
const RED = '#e02020';
const BLUE = '#2020e0';

/** 剪辑点（全部方块落定）时，左数第 6 列、中间偏下一行那个方块的正面中心 */
const CUT = 0.55;
const SPOT: [number, number] = [5.5 / 12, 0.574];

type Color = 'red' | 'green' | 'blue' | 'placeholder' | 'other';
function classify([r, g, b, a]: [number, number, number, number]): Color {
  if (a < 250) return 'other';
  if (r > 40 && r < 205 && g > r && b > g && b - r < 45) return 'placeholder';
  if (r > 120 && g < 60 && b < 60) return 'red';
  if (g > 120 && r < 60 && b < 60) return 'green';
  if (b > 120 && r < 60 && g < 60) return 'blue';
  return 'other';
}

async function spotColor(page: Page): Promise<Color> {
  const px = await page.evaluate(([t, x, y]) => window.__allayTest!.previewPixel(t, x, y), [CUT, ...SPOT] as const);
  return classify(px);
}

async function waitReady(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => window.__allayTest!.status().kind), { timeout: 20_000 }).toBe('ready');
}

async function expectSpot(page: Page, color: Color): Promise<void> {
  await expect.poll(async () => (await page.evaluate(() => window.__allayTest!.status().kind)) === 'ready' && (await spotColor(page)), { timeout: 20_000 }).toBe(color);
}

interface Env {
  dir: string;
  appData: string;
  extra: Record<string, string>;
}

/** 数据目录 + 假游戏目录；consent 给定时预先写进 settings.json */
function prepare(opts: { game?: boolean; consent?: boolean | null } = {}): Env {
  const dir = makeUserDataDir();
  const appData = join(dir, 'fake-appdata');
  mkdirSync(appData, { recursive: true });
  if (opts.game) makeCatalogGame(join(appData, '.minecraft'), '1.21.1', '2024-08-08T00:00:00+00:00', catalogJarEntries(REQUIRED, { [DIAMOND]: GREEN }));
  if (opts.consent !== undefined && opts.consent !== null) {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ formatVersion: 1, resources: { vanilla: { consent: opts.consent, enabled: true, dir: null }, packs: [] } }));
  }
  return { dir, appData, extra: { ALLAY_E2E_GAME_APPDATA: appData } };
}

/** 一个只有 diamond_block 的资源包（纯色） */
function packZip(dir: string, name: string, color: string): string {
  const file = join(dir, 'drops', `${name}.zip`);
  writeZip(file, [{ name: 'pack.mcmeta', data: packMcmeta(name) }, { name: tex('diamond_block'), data: solidPng(color) }]);
  return file;
}

/** 模拟把文件拖进窗口：用真实的文件输入框拿到带本机路径的 File，再派发 drop 事件（页面只把 File 交给 preload） */
async function dropFiles(page: Page, paths: string[]): Promise<void> {
  await page.evaluate(() => {
    if (document.getElementById('__e2e_drop')) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.id = '__e2e_drop';
    input.style.display = 'none';
    document.body.append(input);
  });
  await page.setInputFiles('#__e2e_drop', paths);
  await page.evaluate(() => {
    const input = document.getElementById('__e2e_drop') as HTMLInputElement;
    const dt = new DataTransfer();
    for (const f of input.files ?? []) dt.items.add(f);
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
}

const layerIds = (page: Page) => page.evaluate(() => window.__allayTest!.resourceState()!.layers.map((l) => `${l.kind}:${l.name}:${l.enabled}`));

test('没有任何素材层时显示简短引导；管理素材才展开联网说明', async () => {
  const env = prepare();
  const { app, page } = await launchApp(env.dir, env.extra);
  try {
    await waitReady(page);
    await expect(page.getByTestId('resources-onboarding')).toBeVisible();
    await expect(page.getByTestId('preview-error')).toHaveCount(0);
    await expect(page.getByTestId('onboarding-add-pack')).toBeVisible();
    await expect(page.getByTestId('download-note')).not.toBeVisible();
    // 模板照常装载，缺的贴图是占位（并报警告），画面不是空的
    const status = await page.evaluate(() => window.__allayTest!.status());
    expect(status.kind === 'ready' && status.warnings.some((w) => w.includes(DIAMOND))).toBe(true);
    expect(await spotColor(page)).toBe('placeholder');
    await page.getByTestId('onboarding-manage-assets').click();
    const settings = page.getByTestId('settings-dialog');
    await expect(settings.getByTestId('vanilla-choose-dir')).toBeVisible();
    await settings.getByTestId('resources-download-options').click();
    await expect(settings.getByTestId('download-note')).toContainText('piston-meta.mojang.com');
    await expect(settings.getByTestId('download-note')).toContainText('piston-data.mojang.com');
    // 没有询问对话框（没找到游戏），没有任何下载请求
    await expect(page.getByTestId('vanilla-discovery')).toHaveCount(0);
    expect(readMainLog(env.dir)).not.toContain('vanilla downloaded');
  } finally {
    await app.close();
    removeUserDataDir(env.dir);
  }
});

test('T-AST-2 资源栈里只有一个假原版层（覆盖目录全部贴图）时加载每个内置模板：warnings 为空', async () => {
  const env = prepare({ game: true, consent: true });
  const { app, page } = await launchApp(env.dir, env.extra);
  try {
    await waitReady(page);
    await expect.poll(() => layerIds(page)).toEqual(['builtin:builtin:true', 'vanilla:1.21.1:true']);
    // 内置的旗舰模板 T1
    await page.evaluate(() => window.__allayTest!.loadBuiltin());
    await waitReady(page);
    expect(await page.evaluate(() => window.__allayTest!.status())).toEqual({ kind: 'ready', warnings: [] });
    await expect(page.getByTestId('resources-onboarding')).toHaveCount(0);
    await expectSpot(page, 'green');
  } finally {
    await app.close();
    removeUserDataDir(env.dir);
  }
});

test('首次发现本机游戏时询问一次：同意后原版层进入资源栈、预览改变；重启后不再询问', async () => {
  const env = prepare({ game: true });
  let launched: Launched = await launchApp(env.dir, env.extra);
  try {
    const { page } = launched;
    await expect(page.getByTestId('vanilla-discovery')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('vanilla-discovery')).toContainText('1.21.1');
    await waitReady(page);
    expect(await spotColor(page)).toBe('placeholder');
    await page.getByTestId('discovery-accept').click();
    await expect(page.getByTestId('vanilla-discovery')).toHaveCount(0);
    await expectSpot(page, 'green');
    await launched.app.close();

    launched = await launchApp(env.dir, env.extra);
    await waitReady(launched.page);
    await expectSpot(launched.page, 'green');
    await expect(launched.page.getByTestId('vanilla-discovery')).toHaveCount(0);
  } finally {
    await launched.app.close();
    removeUserDataDir(env.dir);
  }
});

test('首次发现时选“暂不使用”：不用原版层，引导状态里留着“使用本机的游戏”', async () => {
  const env = prepare({ game: true });
  const { app, page } = await launchApp(env.dir, env.extra);
  try {
    await page.getByTestId('discovery-decline').click({ timeout: 20_000 });
    await expect(page.getByTestId('resources-onboarding')).toBeVisible();
    await expect(page.getByTestId('vanilla-use-local')).toContainText('1.21.1');
    expect(await page.evaluate(() => window.__allayTest!.resourceState()!.vanilla.consent)).toBe(false);
    await page.getByTestId('vanilla-use-local').click();
    await expectSpot(page, 'green');
    await expect(page.getByTestId('resources-onboarding')).toHaveCount(0);
  } finally {
    await app.close();
    removeUserDataDir(env.dir);
  }
});

for (const [language, theme, manage] of [['zh-CN', 'dark', '管理素材…'], ['en', 'light', 'Manage assets…']] as const) {
  test(`T-AST-VERSION 快切、查看所选详情及焦点返回 (${language}, ${theme})`, async () => {
    const env = prepare({ game: true, consent: true });
    const gameDir = join(env.appData, '.minecraft');
    const cacheDir = join(env.dir, 'vanilla-cache', 'versions', '1.21.1');
    const jar = Buffer.from(buildZip(catalogJarEntries(REQUIRED, { [DIAMOND]: BLUE })));
    writeFiles(cacheDir, {
      'client.jar': jar,
      'version.json': JSON.stringify({ id: '1.21.1', type: 'release', releaseTime: '2024-08-08T00:00:00Z', downloads: { client: { url: 'https://piston-data.mojang.com/client.jar', sha1: createHash('sha1').update(jar).digest('hex'), size: jar.byteLength } } }),
    });
    const bedrock = join(env.dir, 'fixture.mcpack');
    writeZip(bedrock, [
      { name: 'manifest.json', data: JSON.stringify({ format_version: 2, header: { name: 'Fixture Bedrock', uuid: '0137cfde-ebdb-4c12-8ee9-2f4d5bba0261', version: [1, 2, 3] }, modules: [{ type: 'resources' }] }) },
      { name: 'textures/terrain_texture.json', data: JSON.stringify({ texture_data: { stone: { textures: 'textures/blocks/stone' } } }) },
      { name: 'textures/blocks/stone.png', data: solidPng(RED) },
    ]);
    const { app, page } = await launchApp(env.dir, env.extra);
    try {
      await page.evaluate(([lang, mode]) => window.allay.settings.set({ language: lang, theme: mode }), [language, theme] as const);
      await waitReady(page);
      await dropFiles(page, [bedrock]);
      await expect.poll(() => page.evaluate(() => window.__allayTest!.resourceState()?.library?.profiles.length)).toBe(3);
      const trigger = page.getByTestId('resources-button');
      await trigger.press('Enter');
      const popup = page.getByTestId('resources-popover');
      const vanillaRow = popup.locator('[data-testid="layer-row"][data-layer-id="vanilla"]');
      await expect(vanillaRow).toHaveCount(1);
      const quick = vanillaRow.getByTestId('resources-quick-version');
      await quick.press('Enter');
      const options = page.getByRole('option');
      await expect(options).toHaveCount(3);
      await expect(options.filter({ hasText: '1.21.1' })).toHaveCount(2);
      await expect(options.filter({ hasText: 'Fixture Bedrock' })).toContainText(/Bedrock · local pack|基岩版/);
      await options.filter({ hasText: /downloaded|下载缓存/ }).click();
      await expect(quick).toContainText(/downloaded|下载缓存/);
      const open = popup.getByRole('button', { name: manage });
      await expect(popup.getByTestId('version-library')).toHaveCount(0);
      await open.press('Enter');
      const settings = page.getByTestId('settings-dialog');
      await expect(settings.getByTestId('settings-tab-assets')).toHaveAttribute('aria-selected', 'true');
      await expect(popup).toHaveCount(0);
      const details = settings.getByTestId('resource-profile-details');
      await expect(details).toHaveCount(1);
      await expect(details).toContainText(cacheDir);
      const local = settings.locator('[data-testid="resource-profile"][data-source="local"]');
      await local.press('Enter');
      await expect(local).toBeFocused();
      await expect(details).toContainText(gameDir);
      await expect(details).not.toContainText(cacheDir);
      expect(await page.evaluate(() => window.__allayTest!.resourceState()?.vanilla.active)).toBe('cached');
      await page.keyboard.press('Escape');
      await expect(settings).toHaveCount(0);
      await expect(trigger).toBeFocused();
      await trigger.press('Enter');
      await expect(popup).toBeVisible();
    } finally {
      await app.close();
      removeUserDataDir(env.dir);
    }
  });
}

test('资源栈弹层：拖入资源包，叠加顺序、开关、重排都会改变预览', async () => {
  const env = prepare({ game: true, consent: true });
  const red = packZip(env.dir, 'Red', RED);
  const blue = packZip(env.dir, 'Blue', BLUE);
  const { app, page } = await launchApp(env.dir, env.extra);
  try {
    await waitReady(page);
    await expectSpot(page, 'green');

    await dropFiles(page, [red]);
    await expect(page.getByTestId('notice')).toHaveAttribute('data-kind', 'info');
    await expectSpot(page, 'red');
    await dropFiles(page, [blue]);
    await expectSpot(page, 'blue');
    expect(await layerIds(page)).toEqual(['builtin:builtin:true', 'vanilla:1.21.1:true', 'pack:Red:true', 'pack:Blue:true']);

    await page.getByTestId('resources-button').click();
    const popover = page.getByTestId('resources-popover');
    await expect(popover).toBeVisible();
    const row = (name: string) => popover.locator('[data-testid="layer-row"]', { hasText: name });
    // 弹层自上而下：Blue、Red、原版
    await expect(popover.getByTestId('layer-row')).toHaveCount(3);
    await expect(popover.getByTestId('layer-row').first()).toContainText('Blue');

    // 关掉 Blue → Red
    await row('Blue').getByTestId('layer-toggle').click();
    await expectSpot(page, 'red');
    await row('Blue').getByTestId('layer-toggle').click();
    await expectSpot(page, 'blue');
    // Blue 下移（到 Red 下面）→ Red。dnd-kit 的键盘拖拽：聚焦手柄，空格拿起，下移一格，空格放下。
    // dnd-kit 在拿起之后才异步量各行的位置，量好之前的方向键不起作用：等拿起生效、等这一行真的移动了再放下（不靠时序假设）
    const handle = row('Blue').getByTestId('layer-drag');
    await handle.focus();
    await page.keyboard.press('Space');
    await expect(handle).toHaveAttribute('aria-pressed', 'true');
    const movedDown = () => row('Blue').evaluate((el) => new DOMMatrix(getComputedStyle(el).transform).m42 > 0);
    await expect
      .poll(async () => {
        if (!(await movedDown())) await page.keyboard.press('ArrowDown');
        return movedDown();
      })
      .toBe(true);
    await page.keyboard.press('Space');
    await expect(handle).not.toHaveAttribute('aria-pressed', 'true');
    await expectSpot(page, 'red');
    await expect(popover.getByTestId('layer-row').first()).toContainText('Red');
    // 关掉 Red → Blue
    await row('Red').getByTestId('layer-toggle').click();
    await expectSpot(page, 'blue');
    // 从管理页删除 Blue → 原版（Red 还关着）
    await popover.getByTestId('resources-manage').click();
    const settings = page.getByTestId('settings-dialog');
    await expect(popover).toHaveCount(0);
    await settings.getByTestId('layer-row').filter({ hasText: 'Blue' }).getByTestId('layer-remove').click();
    await expectSpot(page, 'green');
    await page.keyboard.press('Escape');
    await expect(settings).toHaveCount(0);
    await page.getByTestId('resources-button').click();
    // 关掉原版层 → 占位
    const vanillaToggle = row('1.21.1').getByTestId('layer-toggle');
    await vanillaToggle.press('Space');
    await expectSpot(page, 'placeholder');
    expect(await layerIds(page)).toEqual(['builtin:builtin:true', 'vanilla:1.21.1:false', 'pack:Red:false']);
    await expect(vanillaToggle).toBeFocused();
    await vanillaToggle.press('Space');
    await expectSpot(page, 'green');
    // 键盘：Escape 关闭弹层
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
  } finally {
    await app.close();
    removeUserDataDir(env.dir);
  }
});

test('T-AST-5（界面）含 ../ 条目的恶意 zip 经拖入被拒绝：应用数据目录外没有新文件，资源栈不变', async () => {
  const env = prepare({ game: true, consent: true });
  const evilDir = join(env.dir, 'drops', 'nested', 'deeper');
  const evil = join(evilDir, 'evil.zip');
  writeZip(evil, [
    { name: '../escape.txt', data: 'should never be written' },
    { name: '../../escape2.txt', data: 'should never be written' },
    { name: tex('diamond_block'), data: solidPng(RED) },
  ]);
  const { app, page } = await launchApp(env.dir, env.extra);
  try {
    await waitReady(page);
    const before = await page.evaluate(() => window.__allayTest!.resourceState()!.stamp);
    await dropFiles(page, [evil]);
    const notice = page.getByTestId('notice');
    await expect(notice).toHaveAttribute('data-kind', 'error');
    await expect(notice).toHaveText((await messages(page)).resources.addErrors.rejected!);
    expect(readdirSync(evilDir)).toEqual(['evil.zip']);
    expect(existsSync(join(env.dir, 'drops', 'nested', 'escape.txt'))).toBe(false);
    expect(existsSync(join(env.dir, 'drops', 'escape2.txt'))).toBe(false);
    const packs = join(env.dir, 'packs');
    expect(existsSync(packs) ? readdirSync(packs) : []).toEqual([]);
    expect(await page.evaluate(() => window.__allayTest!.resourceState()!.stamp)).toBe(before);
    await expectSpot(page, 'green');
    expect(readMainLog(env.dir)).toContain('zip pack rejected');
  } finally {
    await app.close();
    removeUserDataDir(env.dir);
  }
});

test.describe('下载原版资源（本机假服务器）', () => {
  let server: FakeMojang;
  test.beforeAll(async () => {
    server = await startFakeMojang('9.9.9', catalogJarEntries(REQUIRED, { [DIAMOND]: BLUE }));
  });
  test.afterAll(async () => {
    await server.close();
  });

  test('点了才联网；进度、取消、失败、成功', async () => {
    const env = prepare();
    const { app, page } = await launchApp(env.dir, { ...env.extra, ALLAY_E2E_MOJANG_ORIGIN: server.origin });
    const cache = join(env.dir, 'vanilla-cache');
    const partFiles = () => {
      const out: string[] = [];
      const walk = (d: string) => {
        if (!existsSync(d)) return;
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (e.isDirectory()) walk(join(d, e.name));
          else if (e.name.endsWith('.part')) out.push(e.name);
        }
      };
      walk(cache);
      return out;
    };
    try {
      await waitReady(page);
      await expect(page.getByTestId('resources-onboarding')).toBeVisible();
      // 启动、探测都是离线的：还没有任何请求
      expect(server.requests).toEqual([]);

      // 1) 取消：jar 发了一半停住时点“取消下载”
      server.jarMode = 'hold';
      await page.getByTestId('onboarding-manage-assets').click();
      const settings = page.getByTestId('settings-dialog');
      await settings.getByTestId('resources-download-options').click();
      expect(server.requests).toEqual([]);
      await settings.getByTestId('vanilla-download').click();
      await expect(page.getByTestId('download-progress')).toBeVisible();
      await expect.poll(() => server.holding(), { timeout: 15_000 }).toBe(true);
      // 分阶段的进度（6.12）：停在“下载客户端 jar”，已经收到一半
      await expect(page.getByTestId('download-progress')).toHaveAttribute('data-stage', 'jar');
      await expect.poll(async () => Number(await page.getByTestId('download-progress').getAttribute('data-fraction')), { timeout: 15_000 }).toBeGreaterThan(0.2);
      await page.getByTestId('download-cancel').click();
      // 取消：进度留着，指明停在哪一步，可以重试；不算错误
      await expect(page.getByTestId('download-progress')).toHaveAttribute('data-status', 'canceled');
      await expect(page.getByTestId('download-stage-jar')).toHaveAttribute('data-status', 'canceled');
      await expect(page.getByTestId('download-retry')).toBeVisible();
      await expect(page.getByTestId('download-error')).toHaveCount(0);
      await expect.poll(() => partFiles()).toEqual([]);
      expect(await page.evaluate(() => window.__allayTest!.resourceState()!.vanilla.active)).toBeNull();

      // 2) 失败：服务器返回 500
      server.jarMode = 'fail';
      await page.getByTestId('download-retry').click();
      await expect(page.getByTestId('download-error')).toHaveAttribute('data-error', 'network');
      await expect(page.getByTestId('download-stage-jar')).toHaveAttribute('data-status', 'failed');
      await expect(page.getByTestId('download-error')).toHaveText((await messages(page)).resources.download.errors.network!);
      expect(partFiles()).toEqual([]);

      // 3) 成功：原版层用下载的 jar，引导状态消失，预览变成假 jar 里的颜色
      server.jarMode = 'ok';
      await page.getByTestId('download-retry').click();
      await expect.poll(() => page.evaluate(() => window.__allayTest!.resourceState()!.vanilla.active), { timeout: 20_000 }).toBe('cached');
      await expect(page.getByTestId('resources-onboarding')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(settings).toHaveCount(0);
      await expectSpot(page, 'blue');
      expect(existsSync(join(cache, 'versions', '9.9.9', 'client.jar'))).toBe(true);
      // 只访问了白名单里的路径，没有任何标识头
      expect(new Set(server.requests)).toEqual(new Set(['/mc/game/version_manifest_v2.json', '/v1/packages/fake/version.json', '/v1/objects/fake/client.jar']));
      expect(server.identifyingHeaders).toEqual([]);
    } finally {
      await app.close();
      removeUserDataDir(env.dir);
    }
  });
});

test('缩略图：杂务 Worker 生成，按渲染版本和 resourceStamp 缓存，资源栈一变就失效', async () => {
  const env = prepare({ game: true, consent: true });
  const { app, page } = await launchApp(env.dir, env.extra);
  try {
    await waitReady(page);
    const first = await page.evaluate(() => window.__allayTest!.thumbnail('block', 'minecraft:stone', 64));
    expect(first).toMatchObject({ source: 'rendered', width: 64, height: 64 });
    const file = join(env.dir, 'cache', 'thumbs-v2', first!.stamp, 'block_64_minecraft~stone.png');
    expect(existsSync(file)).toBe(true);
    expect(await page.evaluate(() => window.__allayTest!.thumbnail('block', 'minecraft:stone', 64))).toMatchObject({ source: 'memory' });
    const item = await page.evaluate(() => window.__allayTest!.thumbnail('item', 'minecraft:diamond', 128));
    expect(item).toMatchObject({ source: 'rendered', width: 128 });

    // 重新载入页面：内存没了，从磁盘缓存取
    await page.reload();
    await page.waitForSelector('[data-testid="topbar"]');
    await waitReady(page);
    expect(await page.evaluate(() => window.__allayTest!.thumbnail('block', 'minecraft:stone', 64))).toMatchObject({ source: 'disk' });

    // 关掉原版层：stamp 变了，重新画，旧 stamp 的目录被清掉
    await page.evaluate(() => window.allay.resources.setEnabled('vanilla', false));
    await expect.poll(() => page.evaluate(() => window.__allayTest!.resourceState()!.stamp)).not.toBe(first!.stamp);
    // 要过的缩略图在后台按新的资源栈重建（3.10），所以这里可能已经在内存里了；无论如何都是按新 stamp 新画的
    const again = await page.evaluate(() => window.__allayTest!.thumbnail('block', 'minecraft:stone', 64));
    expect(['rendered', 'memory']).toContain(again!.source);
    expect(again!.stamp).not.toBe(first!.stamp);
    await expect.poll(() => existsSync(join(env.dir, 'cache', 'thumbs-v2', again!.stamp, 'block_64_minecraft~stone.png'))).toBe(true);
    expect(existsSync(file)).toBe(false);
  } finally {
    await app.close();
    removeUserDataDir(env.dir);
  }
});
