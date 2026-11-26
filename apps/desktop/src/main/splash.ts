import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { Theme, UiSettings } from '../shared/settings';
import type { Logger } from './logger';
import { startup } from './startup-timing';

// 启动画面（docs/07-allay-mascot.md 7.5 第 1 项、7.6 C）：420×260 的无边框小窗，进程一启动就显示，
// 页面是构建时生成的静态 HTML/CSS（apps/desktop/src/splash），没有脚本、没有 preload。
// 至少显示 600 ms；主窗口就绪后先显示主窗口，再让启动画面淡出关闭。
// webPreferences 与主窗口相同（1.6 第 1 条一条不放宽），只是不带 preload；CSP、网络拦截、导航拦截照常生效。

export const SPLASH_MIN_MS = 600;
const FADE_MS = 180;
/** 主窗口一直没就绪（崩溃等）时，启动画面最多停留这么久 */
const GIVE_UP_MS = 20_000;
const SIZE = { width: 420, height: 260 };

export interface SplashOptions {
  /** 页面所在的 origin：app://renderer，或开发服务器 */
  origin: string;
  ui: Pick<UiSettings, 'theme' | 'language' | 'reducedMotion'>;
  /** 悦灵烘焙产物的目录：没有图集时页面用 CSS 占位 */
  mascotDir: string;
  log: Logger;
  /** 后台测试：创建但不显示 */
  hiddenForTests: boolean;
}

function splashLanguage(pref: UiSettings['language']): 'zh-CN' | 'en' {
  if (pref !== 'system') return pref;
  const sys = app.getPreferredSystemLanguages()[0] ?? app.getLocale();
  return sys.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** 页面地址：语言 × 主题选页面，地址片段选状态（#p 占位、#s 静态、#ps 两者） */
export function splashUrl(origin: string, language: 'zh-CN' | 'en', theme: Theme, opts: { hasAtlas: boolean; reduced: boolean }): string {
  const flags = `${opts.hasAtlas ? '' : 'p'}${opts.reduced ? 's' : ''}`;
  return `${origin}/splash/${language}-${theme}.html${flags ? `#${flags}` : ''}`;
}

export class Splash {
  private readonly win: BrowserWindow;
  private readonly createdAt = Date.now();
  private shownAt: number | null = null;
  private markShown!: () => void;
  private readonly shown = new Promise<void>((resolve) => (this.markShown = resolve));
  private closing = false;
  private readonly giveUp: NodeJS.Timeout;

  constructor(private readonly opts: SplashOptions) {
    const hasAtlas = existsSync(join(opts.mascotDir, 'allay.atlas.json')) && existsSync(join(opts.mascotDir, 'allay-288.png'));
    const url = splashUrl(opts.origin, splashLanguage(opts.ui.language), opts.ui.theme, { hasAtlas, reduced: opts.ui.reducedMotion === 'on' });
    this.win = new BrowserWindow({
      ...SIZE,
      useContentSize: true,
      center: true,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      title: '',
      webPreferences: {
        // 1.6 第 1 条，与主窗口相同
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        spellcheck: false,
        webviewTag: false,
      },
    });
    this.win.setMenu(null);
    this.win.once('ready-to-show', () => {
      if (this.closing || this.win.isDestroyed()) return;
      if (!opts.hiddenForTests) this.win.show();
      this.shownAt = Date.now();
      startup.mark('splash-shown');
      this.markShown();
      opts.log.info('splash', 'shown', { afterMs: this.shownAt - this.createdAt, atlas: hasAtlas });
    });
    this.giveUp = setTimeout(() => this.close(), GIVE_UP_MS);
    startup.mark('splash-created');
    void this.win.loadURL(url).catch((error: unknown) => {
      opts.log.warn('splash', 'failed to load', { error: String(error) });
      this.close();
    });
  }

  /**
   * 等启动画面画出第一帧（最多 maxMs）。主进程在这之前不做别的重活（起 FFmpeg、读 jar、建主窗口）：
   * 实测它们在主线程上会卡住几十到上百毫秒，推迟启动画面的第一帧（T-ARC-7，docs/decisions.md M8）。
   * 主窗口反正要等启动画面显示满 600 ms，晚一点开始建不推迟它显示的时间。
   */
  async firstFrame(maxMs: number): Promise<void> {
    await Promise.race([this.shown, new Promise((r) => setTimeout(r, maxMs))]);
  }

  /** 主窗口就绪后调用：等启动画面至少显示满 600 ms 再返回（之后由调用方显示主窗口，再 close） */
  async ready(): Promise<void> {
    const since = this.shownAt ?? this.createdAt;
    // 计时器可能比 Date.now() 量出来的早 1 ms 左右到点（CI 上量到过 visibleMs 599）：没满就再等，直到真的满 600 ms
    for (;;) {
      const left = since + SPLASH_MIN_MS - Date.now();
      if (left <= 0 || this.closing) return;
      await new Promise((r) => setTimeout(r, left));
    }
  }

  /** 淡出并关闭 */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.markShown();
    clearTimeout(this.giveUp);
    const win = this.win;
    if (win.isDestroyed()) return;
    const visibleMs = this.shownAt === null ? 0 : Date.now() - this.shownAt;
    const finish = () => {
      if (!win.isDestroyed()) win.destroy();
      this.opts.log.info('splash', 'closed', { visibleMs });
    };
    if (!win.isVisible()) {
      finish();
      return;
    }
    // 淡出：在主窗口之上把不透明度降到 0
    win.moveTop();
    const t0 = Date.now();
    const timer = setInterval(() => {
      const k = Math.min(1, (Date.now() - t0) / FADE_MS);
      if (win.isDestroyed()) {
        clearInterval(timer);
        return;
      }
      win.setOpacity(1 - k);
      if (k >= 1) {
        clearInterval(timer);
        finish();
      }
    }, 16);
  }
}
