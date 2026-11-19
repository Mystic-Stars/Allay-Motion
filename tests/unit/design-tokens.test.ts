import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_CHROME_COLORS } from '../../apps/desktop/src/shared/theme-colors';
import { splashFiles } from '../../apps/desktop/src/splash/generate';

// 6.2 的设计变量原样写进了 packages/ui 的 globals.css；主进程用到的几个颜色和它一致。

const ROOT = resolve(import.meta.dirname, '../..');
const css = readFileSync(resolve(ROOT, 'packages/ui/src/styles/globals.css'), 'utf8').replace(/\r\n/g, '\n');
const spec = readFileSync(resolve(ROOT, 'docs/06-ui-design.md'), 'utf8').replace(/\r\n/g, '\n');

function block(source: string, selector: string): Record<string, string> {
  const start = source.indexOf(selector);
  if (start < 0) throw new Error(`missing ${selector}`);
  const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('}', start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[m[1]!] = m[2]!.trim().toUpperCase();
  return vars;
}

describe('6.2 设计变量', () => {
  const specDark = block(spec, ":root, [data-theme='dark'] {");
  const specLight = block(spec, "[data-theme='light'] {");
  const cssDark = block(css, ":root,\n[data-theme='dark'] {");
  const cssLight = block(css, "[data-theme='light'] {");

  it('规格里的变量完整解析出来了', () => {
    expect(Object.keys(specDark).length).toBeGreaterThanOrEqual(35);
    expect(Object.keys(specLight).sort()).toEqual(Object.keys(specDark).sort());
  });
  it('深色主题与规格逐项一致', () => {
    for (const [k, v] of Object.entries(specDark)) expect(cssDark[k], k).toBe(v);
    expect(Object.keys(cssDark).sort()).toEqual(Object.keys(specDark).sort());
  });
  it('浅色主题与规格逐项一致', () => {
    for (const [k, v] of Object.entries(specLight)) expect(cssLight[k], k).toBe(v);
    expect(Object.keys(cssLight).sort()).toEqual(Object.keys(specLight).sort());
  });
  it('深色主题的数值取自定稿稿（docs/design/ui-direction-v4.html）', () => {
    // 定稿稿里的变量名 → 我们的变量名；只有第三级文字为了对比度换成了 fg-subtle（fg-faint 保留原值）
    const v4: Record<string, string> = {
      '--background': '#0D0D0E', '--surface-1': '#1A1A1B', '--surface-2': '#202021', '--well': '#131314', '--control': '#28282A',
      '--control-hi': '#333336', '--divider': '#262628', '--viewer': '#121213', '--foreground': '#F0F0F1', '--fg-muted': '#A2A2A6',
      '--fg-faint': '#6D6D72', '--primary': '#3CB7F4', '--primary-foreground': '#04212F', '--mark': '#F2A93B',
      '--stage-enter': '#2B6C9B', '--stage-hold': '#47474B', '--stage-exit': '#6652A6', '--cue': '#49B382',
    };
    for (const [k, v] of Object.entries(v4)) expect(cssDark[k], k).toBe(v);
  });
  it('动效变量', () => {
    for (const v of ['--dur-1: 80ms', '--dur-2: 120ms', '--dur-4: 400ms', '--ease-out: cubic-bezier(.2, .8, .2, 1)', '--ease-in-out: cubic-bezier(.45, .05, .2, 1)']) {
      expect(css).toContain(v);
      expect(spec).toContain(v);
    }
  });
  it('shadcn 变量的映射', () => {
    for (const v of [
      '--card: var(--surface-1)',
      '--popover: var(--surface-2)',
      '--muted: var(--control)',
      '--muted-foreground: var(--fg-muted)',
      '--secondary: var(--control)',
      '--accent: var(--control-hi)',
      '--destructive: var(--danger)',
      '--border: var(--divider)',
      '--input: var(--control)',
    ]) {
      expect(css).toContain(v);
    }
  });
  it('字号、圆角、尺寸（6.2）', () => {
    for (const v of [
      '--fs-body: 12px', '--fs-small: 11.5px', '--fs-label: 12.5px', '--fs-title: 15px', '--fs-timecode: 19px',
      '--r-panel: 10px', '--r-control: 6px', '--r-tile: 7px',
      '--gap: 6px', '--h-topbar: 44px', '--h-statusbar: 24px', '--h-panel-head: 40px', '--h-timeline: 236px',
    ]) expect(css).toContain(v);
  });
  it('主进程的窗口颜色与设计变量一致（顶栏坐在底色上）', () => {
    expect(THEME_CHROME_COLORS.dark).toEqual({
      background: specDark['--background'],
      titleBar: specDark['--background'],
      titleBarSymbol: specDark['--foreground'],
    });
    expect(THEME_CHROME_COLORS.light).toEqual({
      background: specLight['--background'],
      titleBar: specLight['--background'],
      titleBarSymbol: specLight['--foreground'],
    });
  });
  it('禁止的手法：渐变、模糊、背景模糊、发丝描边；阴影只在浮起的东西上', () => {
    expect(css).not.toMatch(/(linear|radial)-gradient/);
    expect(css).not.toMatch(/blur\(/);
    expect(css).not.toMatch(/backdrop-filter:\s*(?!none)/);
    // box-shadow 只出现在“浮起”的工具类里（通过变量），不在别处写死
    const shadows = [...css.matchAll(/(?:^|[;{\s])box-shadow:\s*([^;]+);/g)].map((m) => m[1]!.trim());
    expect(shadows).toEqual(['var(--shadow-float)']);
  });
  it('T-UI-FONT 共享界面用系统字，代码和数字用系统等宽，不加载或按语言切换字体', () => {
    for (const token of [
      '--font-ui: system-ui, sans-serif',
      '--font-num: ui-monospace, "SFMono-Regular", Consolas, monospace',
    ]) {
      expect(css).toContain(`${token};`);
      expect(spec).toContain(token);
    }
    expect(css).toContain('--font-sans: var(--font-ui);');
    expect(css).toContain('--font-mono: var(--font-num);');
    expect(css).not.toMatch(/@font-face|@fontsource|:lang\(|url\(["']?data:/i);
    expect(readFileSync(resolve(ROOT, 'packages/ui/package.json'), 'utf8')).not.toContain('@fontsource');
  });
  it('T-UI-FONT 中英文启动页离线用系统字', () => {
    const splash = splashFiles(ROOT);
    const styles = splash.get('splash/splash.css');
    expect(styles).toContain('font-family:system-ui,sans-serif');
    expect(styles).not.toMatch(/@font-face|@import|:lang\(/i);
    for (const language of ['en', 'zh-CN']) {
      const page = splash.get(`splash/${language}-dark.html`);
      expect(page).toContain(`<html lang="${language}"`);
      expect(page).toContain('href="splash.css"');
    }
  });
});
