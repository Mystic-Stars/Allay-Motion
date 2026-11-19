// window.allay 的浏览器实现：官网的仿真器用它代替 Electron 的 preload + 主进程。
//
// 桌面版渲染进程只通过 window.allay 和宿主打交道（docs/01-product-architecture.md 1.4、1.8），
// 所以把这一个对象换掉，界面、引擎 Worker、内置模板就都是桌面版的同一份代码。这里只实现宿主层：
// - 模板：构建时打包好的内置模板（templates.ts），和桌面版主进程读 .allaytpl 得到的数据相同；
// - 资源：只返回官网索引中实际可读的字节。缺图返回 null，与桌面共用引擎末级占位；
//   无可用字形时由共享引擎使用系统字体；
// - 设置、预设、缩略图缓存：只在内存里，关掉页面就没了；
// - 导出：真实的导出 Worker 照常逐帧渲染，帧交到这里后直接丢弃（浏览器里没有 FFmpeg），结束时通知落地页；
// - 文件、工程、资源包、游戏目录这类需要本机文件系统的操作：不做，通知落地页给出“下载桌面版”的引导。
// 这里不发任何网络请求（AGENTS.md 硬性规则 10）。
import type { AllayApi } from '../../../desktop/src/preload/api';
import { EXPORT_PRESETS, type ExportPreset, type FfmpegInfo, type H264Probe, type PresetBlocker } from '../../../desktop/src/shared/export';
import type { ResourceState } from '../../../desktop/src/shared/resources';
import { UiSettingsPatchSchema, applyUiPatch, defaultUiSettings, type UiSettings, type UiSettingsPatch } from '../../../desktop/src/shared/settings';
import type { PresetEntry } from '../../../desktop/src/shared/templates';
import { resolveUpdateSource, type UpdateState } from '../../../desktop/src/shared/updates';
import desktopPackage from '../../../desktop/package.json';
import type { DesktopOnlyFeature, SiteLanguage } from './bridge';
import { mcGameVersion, mcTexture } from './mc-pack';
import { builtinBundle, builtinEntries } from './templates';

/** 宿主里给人看的几句话（文案在官网的语言文件里，由调用方传入） */
export interface HostMessages {
  /** 原版贴图层的名字，{{version}} 换成游戏版本 */
  mcPackName: Record<SiteLanguage, string>;
  mcPackDescription: Record<SiteLanguage, string>;
  exportTarget: Record<SiteLanguage, string>;
}

export interface BrowserHostOptions {
  settings: Partial<Pick<UiSettings, 'theme' | 'language' | 'reducedMotion'>>;
  messages: HostMessages;
  /** 装上 window.__allayTest（只给官网的冒烟测试用） */
  testHooks?: boolean;
  /** 需要本机文件系统的操作被点到了 */
  onDesktopOnly?(feature: DesktopOnlyFeature): void;
  /** 一次仿真导出走完了（帧都渲染过、没有写文件） */
  onExportFinished?(info: { frames: number; preset: ExportPreset }): void;
  /** 设置变了（界面里切主题、语言） */
  onSettings?(settings: UiSettings): void;
}

/** 资源栈指纹：固定值（这一层构建后不会变），格式与主进程相同（16 位十六进制）；有没有原版贴图是两个不同的栈 */
const STAMP = mcGameVersion ? '0eb5de00000000a2' : '0eb5de0000000001';
const MC_LAYER_ID = 'web-mc';

type Listener<T> = (value: T) => void;

function emitter<T>() {
  const listeners = new Set<Listener<T>>();
  return {
    on(fn: Listener<T>): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    emit(value: T): void {
      for (const fn of listeners) fn(value);
    },
  };
}

function siteLanguage(settings: UiSettings): SiteLanguage {
  if (settings.language === 'zh-CN' || settings.language === 'en') return settings.language;
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function createBrowserHost(opts: BrowserHostOptions): { api: AllayApi; applySettings(patch: UiSettingsPatch): void } {
  // 网页里默认静音（访客没点过任何东西就出声不礼貌）；用户可以在界面里打开
  let settings: UiSettings = { ...defaultUiSettings(), ...opts.settings };
  settings.editor = { ...settings.editor, muted: true };
  // 仿真器直接进入演示工程；需要本机目录的首次启动流程不挡住网页预览，仍可从帮助菜单重开。
  settings.onboardingCompleted = true;
  settings.tourCompleted = true;
  settings.updates = { ...settings.updates, mode: 'off' };
  const settingsChanged = emitter<UiSettings>();
  const updatesChanged = emitter<UpdateState>();
  const resourcesChanged = emitter<ResourceState>();
  const thumbs = new Map<string, Uint8Array>();
  const presets: PresetEntry[] = [];
  const jobs = new Map<string, { preset: ExportPreset; frames: number }>();

  const desktopOnly = (feature: DesktopOnlyFeature) => opts.onDesktopOnly?.(feature);
  // 网页不运行安装包更新，也不假报“已是最新版本”。
  const updateState = (): UpdateState => ({
    status: 'unsupported',
    currentVersion: desktopPackage.version,
    channel: settings.updates.channel,
    preferredSource: resolveUpdateSource(settings.updates.source, Intl.DateTimeFormat().resolvedOptions().timeZone),
    latest: null,
    progress: null,
    error: null,
    checkedAt: null,
    announce: false,
  });

  const resourceState = (): ResourceState => {
    const lang = siteLanguage(settings);
    return {
      stamp: STAMP,
      layers: [
        { id: 'builtin', kind: 'builtin', name: 'builtin', enabled: true, legacyFormat: false, warnings: [], empty: true },
        ...(mcGameVersion ? [{
              id: MC_LAYER_ID,
              kind: 'pack' as const,
              name: opts.messages.mcPackName[lang].replace('{{version}}', mcGameVersion),
              description: opts.messages.mcPackDescription[lang],
              enabled: true,
              legacyFormat: false,
              warnings: [],
              source: 'folder' as const,
            }] : []),
      ],
      brokenPacks: [],
      vanilla: { consent: false, enabled: false, local: null, cached: null, active: null, problem: null },
      download: { status: 'idle' },
      detecting: false,
      hasAssets: Boolean(mcGameVersion),
    };
  };

  const h264: H264Probe = { ffmpegVersion: 'web-demo', encoder: 'web-demo', attempts: [], probedAt: new Date(0).toISOString() };
  const ffmpegInfo = (): FfmpegInfo => ({
    available: true,
    version: null,
    presets: Object.fromEntries(EXPORT_PRESETS.map((p) => [p, true])) as Record<ExportPreset, boolean>,
    blockers: Object.fromEntries(EXPORT_PRESETS.map((p) => [p, null])) as Record<ExportPreset, PresetBlocker>,
    h264,
  });

  const applySettings = (patch: UiSettingsPatch): void => {
    const parsed = UiSettingsPatchSchema.parse(patch);
    const prevLang = siteLanguage(settings);
    settings = applyUiPatch(settings, parsed);
    settingsChanged.emit(structuredClone(settings));
    if (parsed.updates) updatesChanged.emit(updateState());
    opts.onSettings?.(structuredClone(settings));
    // 演示层的名字跟着语言走
    if (siteLanguage(settings) !== prevLang) resourcesChanged.emit(resourceState());
  };

  const api: AllayApi = {
    // 不提供 codeInspector：浏览器不能打开原生的独立代码窗。
    app: {
      info: async () => ({
        version: desktopPackage.version,
        platform: 'web',
        userDataDir: '',
        testHooks: opts.testHooks === true,
        systemLocale: navigator.language,
      }),
    },
    settings: {
      get: async () => structuredClone(settings),
      set: async (patch) => {
        applySettings(patch);
        return structuredClone(settings);
      },
      onChanged: (cb) => settingsChanged.on(cb),
    },
    window: {
      // 标题栏的系统按钮由仿真器自己画，颜色直接用设计变量，这里不用记
      setTitleBarColors: async () => undefined,
      reload: async () => window.location.reload(),
    },
    sound: {
      pick: async () => {
        desktopOnly('files');
        return null;
      },
      list: async () => [],
      read: async () => null,
      fetchNames: async () => undefined,
    },
    fonts: {
      list: async () => ({ resources: [] }),
    },
    files: {
      pickImage: async () => {
        desktopOnly('files');
        return null;
      },
      read: async () => {
        throw new Error('no picked files in the web demo');
      },
    },
    export: {
      start: async (req) => {
        const jobId = crypto.randomUUID();
        jobs.set(jobId, { preset: req.preset, frames: 0 });
        const lang = siteLanguage(settings);
        return { ok: true, job: { jobId, target: opts.messages.exportTarget[lang], encoder: req.preset === 'greenscreen-mp4' ? h264.encoder : null } };
      },
      writeFrame: async (jobId, pixels) => {
        const job = jobs.get(jobId);
        if (!job || pixels.byteLength === 0) return { ok: false, error: { code: 'ffmpeg-failed', detail: 'unknown job' } };
        job.frames++;
        return { ok: true };
      },
      writeAudio: async (jobId) => (jobs.has(jobId) ? { ok: true } : { ok: false, error: { code: 'ffmpeg-failed', detail: 'unknown job' } }),
      finish: async (jobId) => {
        const job = jobs.get(jobId);
        if (!job) return { ok: false, error: { code: 'ffmpeg-failed', detail: 'unknown job' } };
        opts.onExportFinished?.({ frames: job.frames, preset: job.preset });
        return { ok: true, path: opts.messages.exportTarget[siteLanguage(settings)], frames: job.frames };
      },
      cancel: async (jobId) => {
        jobs.delete(jobId);
      },
      ffmpegInfo: async () => ffmpegInfo(),
      probeEncoders: async () => h264,
      outputFolder: async () => null,
      chooseFolder: async () => {
        desktopOnly('folder');
        return { canceled: true };
      },
      reveal: async () => desktopOnly('folder'),
      copyDiagnostics: async (text) => {
        await navigator.clipboard?.writeText(text).catch(() => undefined);
      },
    },
    resources: {
      layers: async () => resourceState(),
      stamp: async () => STAMP,
      read: async () => null,
      readTexture: async (id, profileId) => {
        if (profileId !== undefined) return null;
        return mcTexture(id);
      },
      soundVariants: async () => null,
      soundLibrary: async () => ({ stamp: STAMP, events: [] }),
      soundFiles: async (files) => ({ ok: true, states: Object.fromEntries(files.map((f) => [f, 'missing' as const])) }),
      list: async () => [],
      fontProviders: async () => null,
      detectMinecraft: async () => resourceState(),
      selectProfile: async () => resourceState(),
      officialVersions: async () => [],
      locateProfile: async () => false,
      instancePacks: async () => [],
      setInstancePack: async () => resourceState(),
      setVanilla: async () => {
        desktopOnly('vanilla');
        return resourceState();
      },
      chooseGameDir: async () => {
        desktopOnly('vanilla');
        return { canceled: true };
      },
      // 不联网：网页里不替用户下载任何东西
      downloadVanilla: async () => {
        desktopOnly('vanilla');
        return { canceled: true };
      },
      cancelDownload: async () => undefined,
      addPack: async () => {
        desktopOnly('packs');
        return { canceled: true };
      },
      addDroppedPack: async () => {
        desktopOnly('packs');
        return { canceled: true };
      },
      removeLayer: async () => resourceState(),
      reorder: async () => resourceState(),
      setEnabled: async () => resourceState(),
      onChanged: (cb) => resourcesChanged.on(cb),
    },
    templates: {
      readSource: async () => ({ ok: false, error: 'not-user' }),
      writeSource: async () => ({ ok: false, error: 'not-user' }),
      createBlank: async () => { desktopOnly('templates'); return null; },
      freezeComposition: async () => { desktopOnly('templates'); return { canceled: true }; },
      importComposition: async () => { desktopOnly('templates'); return { canceled: true }; },
      listCompositions: async () => [],
      openComposition: async () => ({ ok: false, error: 'desktop-only' }),
      list: async () => builtinEntries(),
      read: async (id, version) => builtinBundle(id, version),
      // 内置模板都没有 assets/（构建时 build-templates 会把它们打进 .allaytpl，官网暂不需要）
      readAsset: async () => null,
      install: async () => {
        desktopOnly('templates');
        return { canceled: true };
      },
      installDropped: async () => {
        desktopOnly('templates');
        return { canceled: true };
      },
      installRequested: async () => {
        desktopOnly('templates');
        return { canceled: true };
      },
      commitInstall: async () => ({ ok: false, error: { code: 'staging-expired', detail: 'web demo' } }),
      cancelInstall: async () => undefined,
      remove: async () => false,
      exportPackage: async () => {
        desktopOnly('templates');
        return { canceled: true };
      },
      saveDerived: async () => {
        desktopOnly('templates');
        return { ok: false, error: 'web demo' };
      },
      copyBuiltin: async () => {
        desktopOnly('templates');
        return { ok: false, error: 'open-failed' };
      },
      writeDevFiles: async () => ({ ok: false, error: 'open-failed' }),
      openFolder: async () => {
        desktopOnly('templates');
        return { ok: false, error: 'open-failed' };
      },
      onChanged: () => () => undefined,
    },
    presets: {
      list: async () => structuredClone(presets),
      save: async (req) => {
        const entry: PresetEntry = { id: randomHex(16), name: req.name, template: req.template, params: req.params, createdAt: new Date().toISOString() };
        presets.push(entry);
        return structuredClone(entry);
      },
      remove: async (id) => {
        const i = presets.findIndex((p) => p.id === id);
        if (i < 0) return false;
        presets.splice(i, 1);
        return true;
      },
      importFile: async () => {
        desktopOnly('presets');
        return { canceled: true };
      },
      exportFile: async () => {
        desktopOnly('presets');
        return { canceled: true };
      },
    },
    project: {
      open: async () => {
        desktopOnly('project');
        return { canceled: true };
      },
      openRequested: async () => {
        desktopOnly('project');
        return { canceled: true };
      },
      openRecent: async () => {
        desktopOnly('project');
        return { canceled: true };
      },
      save: async () => {
        desktopOnly('project');
        return { canceled: true };
      },
      saveAs: async () => {
        desktopOnly('project');
        return { canceled: true };
      },
      recents: async () => [],
    },
    host: {
      onCommand: () => () => undefined,
      commandResult: async () => true,
      ready: async () => undefined,
    },
    folders: {
      get: async () => ({
        project: { kind: 'project', path: null, state: 'unset' },
        export: { kind: 'export', path: null, state: 'unset' },
      }),
      choose: async () => {
        desktopOnly('folder');
        return { canceled: true };
      },
      reset: async (kind) => ({ kind, path: null, state: 'unset' }),
    },
    updates: {
      state: async () => updateState(),
      check: async () => updateState(),
      download: async () => updateState(),
      cancel: async () => undefined,
      install: async () => updateState(),
      onChanged: (cb) => updatesChanged.on(cb),
    },
    cache: {
      getThumb: async (stamp, key) => thumbs.get(`${stamp}/${key}`)?.slice() ?? null,
      putThumb: async (stamp, key, png) => {
        const limit = 24 * 1024 * 1024;
        if (png.byteLength > limit) return;
        const ref = `${stamp}/${key}`;
        thumbs.delete(ref);
        let bytes = png.byteLength + [...thumbs.values()].reduce((size, value) => size + value.byteLength, 0);
        for (const [old, value] of thumbs) {
          if (bytes <= limit && thumbs.size < 256) break;
          bytes -= value.byteLength;
          thumbs.delete(old);
        }
        thumbs.set(ref, png.slice());
      },
      clear: async () => thumbs.clear(),
      usage: async () => ({ files: thumbs.size, bytes: [...thumbs.values()].reduce((n, b) => n + b.byteLength, 0) }),
    },
  };
  return { api, applySettings };
}

/** 装到 window.allay 上（桌面版由 preload 的 contextBridge 暴露同名对象） */
export function installBrowserHost(api: AllayApi): void {
  Object.defineProperty(window, 'allay', { value: api, configurable: false, enumerable: true, writable: false });
}
