// 仿真器的入口（在落地页的 iframe 里）：先装上浏览器版的 window.allay，再启动桌面版渲染进程的真实入口
// apps/desktop/src/renderer/main.tsx。之后的界面、Zustand 状态、引擎 Worker、模板装载、导出管线全是桌面版的代码。
import { z } from 'zod';
import { FromSimulatorSchema, SiteLanguageSchema, SiteThemeSchema, ToSimulatorSchema, readMessage, type FromSimulator } from '../host/bridge';
import { createBrowserHost, installBrowserHost } from '../host/browser-host';
import { hostMessages } from '../site/i18n';
import { useTransportStore } from '../../../desktop/src/renderer/stores/transportStore';
import './simulator.css';


const params = new URLSearchParams(window.location.search);
const theme = SiteThemeSchema.catch('dark').parse(params.get('theme'));
const language = SiteLanguageSchema.catch('en').parse(params.get('lang'));
document.documentElement.dataset.theme = theme;

const embedded = window.parent !== window;
function toParent(msg: FromSimulator): void {
  // 发出去之前也过一遍 schema，免得两边对不上
  if (embedded) window.parent.postMessage(FromSimulatorSchema.parse(msg), window.location.origin);
}

const host = createBrowserHost({
  settings: { theme, language },
  messages: hostMessages(),
  testHooks: params.has('e2e'),
  onDesktopOnly: (feature) => toParent({ channel: 'allay-sim', type: 'desktop-only', feature }),
  onExportFinished: ({ frames, preset }) => toParent({ channel: 'allay-sim', type: 'export-finished', frames, preset }),
  onSettings: (s) => toParent({ channel: 'allay-sim', type: 'settings', theme: s.theme, language: s.language }),
});
installBrowserHost(host.api);

// Windows 上 titleBarOverlay 画的那三个系统按钮：浏览器里没有，自己画在同一个位置（只是样子，不可点）
function drawCaptionButtons(): void {
  const bar = document.createElement('div');
  bar.className = 'sim-caption';
  bar.setAttribute('aria-hidden', 'true');
  bar.innerHTML =
    '<span><svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor"/></svg></span>' +
    '<span><svg width="10" height="10" viewBox="0 0 10 10"><rect x=".5" y=".5" width="9" height="9" fill="none" stroke="currentColor"/></svg></span>' +
    '<span><svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor"/></svg></span>';
  document.body.appendChild(bar);
}

const SelectSchema = z.object({ id: z.string(), version: z.string() });

window.addEventListener('message', (event) => {
  if (event.source !== window.parent) return;
  const msg = readMessage(event, ToSimulatorSchema);
  if (!msg) return;
  if (msg.type === 'settings') {
    host.applySettings({ theme: msg.theme, language: msg.language, reducedMotion: msg.reducedMotion ? 'on' : 'system' });
  } else if (msg.type === 'select') {
    const ref = SelectSchema.parse(msg);
    autoplay.enabled = true;
    void import('../../../desktop/src/renderer/features/templates/actions').then(async ({ selectTemplate }) => {
      const i18next = (await import('i18next')).default;
      await selectTemplate(ref.id, ref.version, i18next.language);
    });
  } else if (msg.type === 'visibility') {
    autoplay.visible = msg.visible;
    autoplay.apply();
  }
});

// ---- 嵌在落地页里时的两处行为（桌面版不受影响：只有官网的仿真器入口装这些）----

/**
 * 自动播放：窗口进视口就从剪辑点（画面最满的那一帧）开始循环播放，出视口就暂停。
 * 转场模板在第 0 帧是全透明的，停在那里访客只看到一块空棋盘格，以为坏了。
 * 用户自己按了暂停，就不再替他播放（直到他从落地页再打开一个模板）。
 */
const autoplay = {
  enabled: true,
  visible: false,
  /** 正在由这里改播放状态（区分用户自己按的暂停） */
  driving: false,
  apply(): void {
    const s = useTransportStore.getState();
    if (s.duration <= 0) return;
    this.driving = true;
    if (this.visible && this.enabled && !s.playing) {
      s.setLoop(true);
      s.setPlaying(true);
    } else if (!this.visible && s.playing) {
      s.setPlaying(false);
    }
    this.driving = false;
  },
};
useTransportStore.subscribe((s, prev) => {
  // 换了模板（时长或剪辑点变了）：跳到剪辑点再播
  if (autoplay.enabled && (s.duration !== prev.duration || s.cutTime !== prev.cutTime) && s.duration > 0) {
    autoplay.driving = true;
    s.setTime(s.cutTime ?? s.duration / 2);
    autoplay.driving = false;
    autoplay.apply();
  } else if (prev.playing && !s.playing && !autoplay.driving && autoplay.visible) {
    autoplay.enabled = false;
  }
});

/**
 * 滚轮：仿真器页面本身不滚动（html、body 都是 overflow: hidden），滚轮落在预览区等不能滚的地方时，
 * 浏览器不会把它交给外面的落地页，页面就“卡住”了。这里把这种滚轮转给落地页；
 * 面板里能往那个方向滚的（属性面板、模板库）照常自己滚；按着 Ctrl / ⌘ 的不管。
 */
function canScroll(el: Element | null, dy: number): boolean {
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    if (!(node instanceof HTMLElement)) continue;
    const oy = getComputedStyle(node).overflowY;
    if ((oy !== 'auto' && oy !== 'scroll') || node.scrollHeight <= node.clientHeight + 1) continue;
    if (dy > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight - 1 : node.scrollTop > 0) return true;
  }
  return false;
}
if (embedded) {
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey || e.deltaY === 0 || canScroll(e.target as Element | null, e.deltaY)) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? window.parent.innerHeight : 1;
      window.parent.scrollBy({ top: e.deltaY * unit, behavior: 'instant' });
    },
    { passive: false, capture: true },
  );
}

drawCaptionButtons();
// 桌面版渲染进程的入口：bootstrap() 读 window.allay，初始化 i18n，挂上 <App />
await import('../../../desktop/src/renderer/main');
// main.tsx 的 bootstrap 是异步的：等根节点有了内容再告诉落地页
const root = document.getElementById('root');
const announce = () => toParent({ channel: 'allay-sim', type: 'ready' });
if (root && root.childElementCount > 0) announce();
else if (root) {
  const mo = new MutationObserver(() => {
    if (root.childElementCount === 0) return;
    mo.disconnect();
    announce();
  });
  mo.observe(root, { childList: true });
}
