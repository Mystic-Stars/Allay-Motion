import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, test, type ElectronApplication, type Page } from '@playwright/test';
import { isSoftwareRenderer } from '../engine/software';

export const ROOT = resolve(import.meta.dirname, '../..');
export const DESKTOP_DIR = join(ROOT, 'apps/desktop');

const requireFromDesktop = createRequire(join(DESKTOP_DIR, 'package.json'));
/** electron 包导出的是可执行文件路径 */
export const ELECTRON_PATH = requireFromDesktop('electron') as string;

export function makeUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'allay-e2e-'));
}

/** Electron 的子进程退出得比 app.close() 晚一点，删除时重试；实在删不掉就留在临时目录 */
export function removeUserDataDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    // 临时目录，系统会清理
  }
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
}

/** 启动构建好的应用（apps/desktop/out），用独立的数据目录 */
/** 启动参数（例如双击关联文件时系统带上的路径，M8）和等待哪个元素出现（缺省是顶栏） */
export interface LaunchOptions {
  args?: string[];
  waitFor?: string;
  /**
   * 首次启动：数据目录里没有设置文件时也不预先写一个，应用会显示首次启动引导（6.10）。
   * 缺省时 launchApp 先写一个只记着“引导已走过”的设置文件（和老用户升级后一样），其他测试不受引导影响
   */
  firstRun?: boolean;
}

/** 没有设置文件时写一个只记着“引导已走过”的（其他设置都是默认值） */
export function seedSettings(userDataDir: string): void {
  const file = join(userDataDir, 'settings.json');
  if (existsSync(file)) return;
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ formatVersion: 1, ui: { onboardingCompleted: true } }));
}

/** 测试进程的环境变量，加上测试开关（launchApp 和直接起第二个实例的测试共用） */
export function appEnv(userDataDir: string, extraEnv: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'ELECTRON_RENDERER_URL' && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  }
  env.ALLAY_USER_DATA_DIR = userDataDir;
  // 窗口不显示、不抢焦点：测试不能影响用户的前台操作
  env.ALLAY_E2E_HIDDEN = '1';
  // 渲染进程装上测试钩子（只在未打包时生效）
  env.ALLAY_E2E_HOOKS = '1';
  // 探测本机游戏时看这个（空）目录，绝不碰这台机器上真装的游戏；需要假游戏的测试自己覆盖
  env.ALLAY_E2E_GAME_APPDATA = join(userDataDir, 'no-game');
  // 下载原版资源时连一个没人监听的本机端口：测试里误点“下载”也不会访问真实网络；下载测试自己覆盖成假服务器
  env.ALLAY_E2E_MOJANG_ORIGIN = 'http://127.0.0.1:9';
  // 悦灵的烘焙产物：默认指向一个不存在的目录，界面用 CSS 占位。这台机器上烘焙过的真实产物（原版贴图的派生图像）
  // 不进任何测试和截图基线；需要图集的测试（m5b.spec.ts）自己生成假图集并覆盖这个变量
  env.ALLAY_E2E_MASCOT_DIR = join(userDataDir, 'no-mascot');
  Object.assign(env, extraEnv);
  return env;
}

export async function launchApp(userDataDir: string, extraEnv: Record<string, string> = {}, opts: LaunchOptions = {}): Promise<Launched> {
  const env = appEnv(userDataDir, extraEnv);
  if (!opts.firstRun) seedSettings(userDataDir);
  const app = await electron.launch({ executablePath: ELECTRON_PATH, args: [DESKTOP_DIR, ...(opts.args ?? [])], env, cwd: DESKTOP_DIR });
  const page = await app.firstWindow();
  await page.waitForSelector(opts.waitFor ?? '[data-testid="topbar"]');
  await adaptToRenderer(page);
  return { app, page };
}

/** 应用页面里 WebGL2 的渲染器名字（WEBGL_debug_renderer_info）；没有 WebGL2 时是 'none' */
export function rendererOf(page: Page): Promise<string> {
  return page.evaluate(() => {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2');
    if (!gl) return 'none';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  });
}

/** 软件渲染（CI 的 WARP）下测试自身的时限放宽到这么多倍（tests/engine/software.ts，docs/decisions.md M8） */
export const SOFTWARE_TIMEOUT_FACTOR = 5;
const slowed = new Set<string>();

/**
 * 识别出软件渲染时，把当前测试的时限放宽 SOFTWARE_TIMEOUT_FACTOR 倍（每个测试只放宽一次）。只看渲染器自己报的名字，
 * 有显卡时什么都不变。判定（预算、像素容差）不在这里放宽。
 */
export async function adaptToRenderer(page: Page): Promise<string> {
  const gpu = await rendererOf(page).catch(() => 'unknown');
  if (!isSoftwareRenderer(gpu)) return gpu;
  let info: ReturnType<typeof test.info>;
  try {
    info = test.info();
  } catch {
    return gpu; // 不在测试里（例如评审脚本）
  }
  if (!slowed.has(info.testId)) {
    slowed.add(info.testId);
    test.setTimeout(info.timeout * SOFTWARE_TIMEOUT_FACTOR);
    info.annotations.push({ type: 'renderer', description: `${gpu}（软件渲染：时限 × ${SOFTWARE_TIMEOUT_FACTOR}）` });
  }
  return gpu;
}

/**
 * 等一件随渲染器变慢的事（例如一次导出做完）的时限：识别出软件渲染（CI 的 WARP）时乘 SOFTWARE_TIMEOUT_FACTOR，
 * 有显卡时原样返回。和测试自身时限的放宽同一个依据（docs/decisions.md M8），判定不在这里放宽。
 * 按页面现问渲染器，launchApp 在 beforeAll 里调用的测试也适用
 */
export async function renderBoundTimeout(page: Page, ms: number): Promise<number> {
  return isSoftwareRenderer(await rendererOf(page).catch(() => 'unknown')) ? ms * SOFTWARE_TIMEOUT_FACTOR : ms;
}

/**
 * 逐个内置模板走一遍的测试：当前测试的时限再加上每个模板 perTemplateMs（软件渲染下这一份同样乘 SOFTWARE_TIMEOUT_FACTOR）。
 * 内置模板一批批加进来（docs/template-catalog.md），按十几个模板定的固定时限迟早不够；在知道模板数之后调用。
 */
export function extendTimeoutPerTemplate(count: number, perTemplateMs: number): void {
  const info = test.info();
  const factor = slowed.has(info.testId) ? SOFTWARE_TIMEOUT_FACTOR : 1;
  test.setTimeout(info.timeout + count * perTemplateMs * factor);
}

export function readMainLog(userDataDir: string): string {
  try {
    return readFileSync(join(userDataDir, 'logs', 'main.log'), 'utf8');
  } catch {
    return '';
  }
}


/** 固定版本的 FFmpeg（pnpm ffmpeg:fetch）；不在就明确失败 */
export const PINNED_FFMPEG = join(ROOT, 'resources', 'ffmpeg', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
export function requirePinnedFfmpeg(): string {
  if (!existsSync(PINNED_FFMPEG)) throw new Error(`找不到 ${PINNED_FFMPEG}。先运行 pnpm ffmpeg:fetch。`);
  return PINNED_FFMPEG;
}

export function readFixture(name: string): string {
  return readFileSync(join(ROOT, 'tests', 'fixtures', 'templates', name), 'utf8');
}
