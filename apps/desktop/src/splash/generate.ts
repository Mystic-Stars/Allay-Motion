// 启动画面（docs/07-allay-mascot.md 7.6 C、7.5 第 1 项）的生成器：构建时从源码生成静态的 HTML 和 CSS。
//
// - 只用静态 HTML、CSS 和图集：CSS steps() 播帧，关键帧动画做飞入；没有脚本，不依赖主应用，进程一启动就能显示。
// - 文字不写死在这里（硬性规则 9）：产品名、字标、非官方声明取自 packages/ui/src/brand，状态字取自界面文案（两种语言）。
// - 颜色取自设计变量（packages/ui/src/styles/globals.css 的两套主题），不另起色值。
// - 帧在图集里的位置、捧着的方块的位置（手部锚点）都由 packages/mascot/model 的同一份代码算出，与烘焙结果一致；
//   不读烘焙产物，所以产物缺失时构建照常进行。
// - 每种语言 × 每种主题一个页面（主进程按设置挑）。页面的地址片段选状态（:target，仍然不需要脚本）：
//     #p  产物缺失，用 CSS 占位；  #s  减少动效（静态）；  #ps  两者都是。
//   系统的“减少动效”由 @media (prefers-reduced-motion) 直接生效。
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brandMessages } from '../../../../packages/ui/src/brand/messages';
import { CLIP_ORDER, CLIPS, type ClipName } from '../../../../packages/mascot/model/allay.motions';
import { handAnchor } from '../../../../packages/mascot/model/allay.rig';
import en from '../renderer/i18n/locales/en.json';
import zhCN from '../renderer/i18n/locales/zh-CN.json';

export const SPLASH_LANGUAGES = ['zh-CN', 'en'] as const;
export const SPLASH_THEMES = ['dark', 'light'] as const;
export type SplashLanguage = (typeof SPLASH_LANGUAGES)[number];
export type SplashTheme = (typeof SPLASH_THEMES)[number];

/** 窗口尺寸（7.6 C） */
export const SPLASH_SIZE = { width: 420, height: 260 } as const;
/** 悦灵的显示尺寸（css px）；用 288 的图集缩小显示，高分屏上也清楚 */
const SPRITE = 96;
const ATLAS_CELL = 288;
const COLUMNS = 13;

export function splashPagePath(language: SplashLanguage, theme: SplashTheme): string {
  return `splash/${language}-${theme}.html`;
}

/** 设计变量所在的文件（相对仓库根目录）。路径由调用方给出仓库根目录：这个文件会被打进 Vite 配置，import.meta.dirname 指的不是这里 */
const GLOBALS_CSS = 'packages/ui/src/styles/globals.css';

/** 用到的设计变量 */
const VARS = ['--background', '--surface-1', '--divider', '--foreground', '--fg-muted', '--fg-subtle', '--allay', '--allay-deep', '--allay-light', '--control', '--control-hi', '--fg-faint'] as const;

/** 从 globals.css 里取两套主题的变量值（深色块以 `[data-theme='dark'] {` 结尾，浅色块以 `[data-theme='light'] {` 开头） */
export function readThemeVars(repoRoot: string): Record<SplashTheme, Record<string, string>> {
  return parseThemeVars(readFileSync(resolve(repoRoot, GLOBALS_CSS), 'utf8'));
}

export function parseThemeVars(css: string): Record<SplashTheme, Record<string, string>> {
  const block = (selector: string): string => {
    const at = css.indexOf(`${selector} {`);
    if (at < 0) throw new Error(`globals.css: ${selector} not found`);
    return css.slice(at, css.indexOf('}', at));
  };
  const pick = (body: string) =>
    Object.fromEntries(
      VARS.map((name) => {
        const m = new RegExp(`${name}:\\s*([^;]+);`).exec(body);
        if (!m) throw new Error(`globals.css: ${name} missing`);
        return [name, m[1]!.trim()];
      }),
    );
  return { dark: pick(block("[data-theme='dark']")), light: pick(block("[data-theme='light']")) };
}

function clipStart(clip: ClipName): number {
  let start = 0;
  for (const c of CLIP_ORDER) {
    if (c === clip) return start;
    start += CLIPS[c].frames;
  }
  throw new Error(clip);
}

const pct = (i: number, n: number) => `${((i / n) * 100).toFixed(3)}%`;

/** 一段动作的帧动画（background-position）和手部锚点动画（transform） */
function clipKeyframes(clip: ClipName): string {
  const n = CLIPS[clip].frames;
  const start = clipStart(clip);
  const frames: string[] = [];
  const anchors: string[] = [];
  for (let i = 0; i <= n; i++) {
    const f = Math.min(i, n - 1);
    const idx = start + f;
    frames.push(`${pct(i, n)}{background-position:${-(idx % COLUMNS) * SPRITE}px ${-Math.floor(idx / COLUMNS) * SPRITE}px}`);
    anchors.push(`${pct(i, n)}{transform:${anchorTransform(clip, f)}}`);
  }
  return `@keyframes sprite-${clip}{${frames.join('')}}\n@keyframes carry-${clip}{${anchors.join('')}}\n`;
}

function anchorTransform(clip: ClipName, frame: number): string {
  const [x, y, deg] = handAnchor(clip, frame);
  return `translate(${(x * SPRITE).toFixed(1)}px,${(y * SPRITE).toFixed(1)}px) rotate(${deg}deg)`;
}

export function splashCss(vars: Record<SplashTheme, Record<string, string>>): string {
  const theme = (t: SplashTheme) => `[data-theme='${t}']{color-scheme:${t};${Object.entries(vars[t]).map(([k, v]) => `${k}:${v}`).join(';')}}`;
  const hover = CLIPS.hover.duration;
  const fly = CLIPS.fly.duration;
  return `/* 由 apps/desktop/src/splash/generate.ts 生成，不要手改 */
${theme('dark')}
${theme('light')}
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;background:transparent;overflow:hidden;user-select:none;cursor:default}
body{font-family:system-ui,sans-serif;color:var(--foreground)}
.card{position:absolute;inset:0;border-radius:12px;background:var(--background);border:1px solid var(--divider);overflow:hidden;display:flex;flex-direction:column;align-items:center;-webkit-app-region:drag}
.stage{position:relative;width:100%;height:${SPRITE + 22}px;flex:none}
.flyer{position:absolute;left:calc(50% - ${SPRITE / 2}px);top:14px;width:${SPRITE}px;height:${SPRITE}px;animation:fly-in 600ms cubic-bezier(.2,.8,.2,1) both;pointer-events:none}
.sprite{position:absolute;inset:0;background-image:url(../mascot/allay-${ATLAS_CELL}.png);background-repeat:no-repeat;background-size:${COLUMNS * SPRITE}px ${COLUMNS * SPRITE}px;background-position:0 0;
  animation:sprite-fly ${fly}s steps(1,end) 1,sprite-hover ${hover}s steps(1,end) .6s infinite}
.carry{position:absolute;left:0;top:0;width:${Math.round(SPRITE * 0.26)}px;height:${Math.round(SPRITE * 0.26)}px;margin:-${Math.round(SPRITE * 0.13)}px 0 0 -${Math.round(SPRITE * 0.13)}px;transform-origin:50% 50%;transform:${anchorTransform('hover', 0)};
  animation:carry-fly ${fly}s steps(1,end) 1,carry-hover ${hover}s steps(1,end) .6s infinite}
.carry i{position:absolute;display:block}
.carry .top{left:0;top:0;width:100%;height:30%;background:var(--control-hi);border-radius:2px 2px 0 0}
.carry .front{left:0;top:30%;width:60%;height:70%;background:var(--fg-subtle)}
.carry .side{left:60%;top:30%;width:40%;height:70%;background:var(--fg-faint)}
.ph{display:none;position:absolute;inset:0;animation:ph-bob ${hover}s ease-in-out .6s infinite}
.ph i{position:absolute;display:block}
.ph .wing{left:10%;top:28%;width:36%;height:22%;border-radius:50%;background:var(--allay-light);opacity:.7}
.ph .head{left:36%;top:14%;width:36%;height:36%;border-radius:22%;background:var(--allay)}
.ph .eye{top:27%;width:5%;height:9%;border-radius:1px;background:var(--background)}
.ph .eye.l{left:51%}
.ph .eye.r{left:61%}
.ph .body{left:44%;top:50%;width:20%;height:26%;border-radius:30%;background:var(--allay-deep)}
.wordmark{margin-top:6px;font-size:20px;font-weight:600;letter-spacing:.01em;line-height:1.2}
.name{margin-top:2px;font-size:12px;color:var(--fg-muted);line-height:1.4}
.status{margin-top:10px;font-size:11px;color:var(--fg-subtle);line-height:1.4}
.disclaimer{margin-top:auto;padding:0 20px 12px;font-size:9px;line-height:1.45;color:var(--fg-subtle);text-align:center;white-space:pre-line}
@keyframes fly-in{from{transform:translateX(-${SPRITE * 3}px)}to{transform:none}}
@keyframes ph-bob{0%,100%{transform:none}50%{transform:translateY(-6%)}}
${clipKeyframes('hover')}${clipKeyframes('fly')}
/* 地址片段选状态：#p 产物缺失用 CSS 占位，#s 静态（减少动效），#ps 两者都是 */
#p:target .sprite,#ps:target .sprite{display:none}
#p:target .ph,#ps:target .ph{display:block}
#s:target *,#ps:target *{animation:none!important}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
`;
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function splashHtml(language: SplashLanguage, theme: SplashTheme): string {
  const brand = brandMessages[language];
  const status = (language === 'en' ? en : zhCN).splash.starting;
  // 字标与产品名相同时（英文）只写一次
  const name = brand.name !== brand.wordmark ? `\n      <p class="name">${escapeHtml(brand.name)}</p>` : '';
  return `<!doctype html>
<!-- 由 apps/desktop/src/splash/generate.ts 生成，不要手改 -->
<html lang="${language}" data-theme="${theme}">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(brand.name)}</title>
  <link rel="stylesheet" href="splash.css">
</head>
<body>
<div id="ps"><div id="p"><div id="s">
  <main class="card" data-testid="splash">
    <div class="stage" aria-hidden="true">
      <div class="flyer">
        <div class="sprite" data-allay="splash"></div>
        <div class="ph"><i class="wing"></i><i class="head"></i><i class="eye l"></i><i class="eye r"></i><i class="body"></i></div>
        <div class="carry"><i class="top"></i><i class="front"></i><i class="side"></i></div>
      </div>
    </div>
    <h1 class="wordmark">${escapeHtml(brand.wordmark)}</h1>${name}
    <p class="status" role="status">${escapeHtml(status)}</p>
    <p class="disclaimer" data-testid="splash-disclaimer">${escapeHtml(brand.disclaimer)}</p>
  </main>
</div></div></div>
</body>
</html>
`;
}

/** 全部文件：发布路径（相对渲染进程的根目录）→ 内容 */
export function splashFiles(repoRoot: string): Map<string, string> {
  const files = new Map<string, string>([['splash/splash.css', splashCss(readThemeVars(repoRoot))]]);
  for (const l of SPLASH_LANGUAGES) for (const t of SPLASH_THEMES) files.set(splashPagePath(l, t), splashHtml(l, t));
  return files;
}
