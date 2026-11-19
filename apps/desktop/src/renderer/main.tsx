import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
import './app.css';
import { App } from './app/App';
import { installGlobalErrorLogging } from './app/diagnostics';
import { ErrorBoundary } from './app/ErrorBoundary';
import { hasWebGL2, NoWebGL } from './app/NoWebGL';
import { registerCore } from './app/core';
import { installMacMenuState } from './app/mainCommands';
import { setTitlebarPlatform } from './app/titlebarChrome';
import { applyThemeToDocument } from './app/useThemeSync';
import { initI18n, resolveLanguage, setSystemLocale } from './i18n';
import { loadInitialTemplate } from './features/templates/actions';
import { runCommand } from './features/commands/commands';
import { installCodeInspector } from './features/live-code/host';
import { installTestHooks } from './test-hooks';
import { previewAudio } from './audio/app-audio';
import { startSoundLibrary } from './audio/sound-library';
import { useResourceStore } from './stores/resourceStore';
import { useUiStore } from './stores/uiStore';

async function bootstrap(): Promise<void> {
  // 未捕获的异常和 Promise 拒绝写进日志（经 console.error，主进程收进 logs/main.log）
  installGlobalErrorLogging();
  const [settings, info, resources] = await Promise.all([window.allay.settings.get(), window.allay.app.info(), window.allay.resources.layers()]);
  useUiStore.getState().replace(settings);
  // 先拿到资源栈（和它的 stamp）再装载模板，免得用空栈白装一次
  useResourceStore.getState().replace(resources);
  window.allay.resources.onChanged((next) => useResourceStore.getState().replace(next));
  // 界面注册表：核心命令、标签页、菜单项（可选模块也经它接入）
  registerCore();
  // 预览播放的声音跟着播放状态走（cue 调度、静音、循环）
  previewAudio.start();
  // 音效选择器的库（资源栈合并后的 sounds.json），资源栈一变就重新取
  startSoundLibrary();
  if (info.testHooks) installTestHooks();
  applyThemeToDocument(settings);

  setSystemLocale(info.systemLocale);
  const language = resolveLanguage(settings.language, info.systemLocale);
  const i18n = await initI18n(language);
  document.documentElement.lang = language;

  // 模板列表与默认模板（内置的旗舰模板）。预览引擎等 projectStore 里有了模板再装载
  const webgl2 = hasWebGL2();
  setTitlebarPlatform(info.platform);
  if (webgl2) installCodeInspector(() => runCommand('showAuthoringTools'));
  if (webgl2 && info.platform === 'darwin') installMacMenuState();
  const initial = webgl2 ? loadInitialTemplate(language).catch((error: unknown) => console.error('[templates] initial load failed', error)) : Promise.resolve();

  // 设置可能在别处被改（以后的设置对话框、测试），以主进程推来的为准
  window.allay.settings.onChanged((next) => useUiStore.getState().replace(next));

  const container = document.getElementById('root');
  if (!container) throw new Error('missing #root');
  createRoot(container).render(
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        {/* 最外层的错误边界：渲染时抛错显示错误页，不再整棵卸载成黑屏 */}
        <ErrorBoundary scope="app" variant="app">
          {webgl2 ? <App /> : <NoWebGL info={info} />}
        </ErrorBoundary>
      </I18nextProvider>
    </StrictMode>,
  );

  // 界面就绪：首屏画出来（两次 rAF 之后）、初始模板装好，再告诉主进程（M8）。
  // 主进程据此开始执行排队的文件关联请求（免得和初始模板互相覆盖），并记下启动时间（T-ARC-7）
  const painted = new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  void Promise.all([initial, painted])
    .then(() => window.allay.host.ready())
    .catch((error: unknown) => console.error('[startup] ready signal failed', error));
}

void bootstrap();
