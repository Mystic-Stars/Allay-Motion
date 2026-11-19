import type { AudioCue, CompositionLoadResult, EffectiveTiming, FontUsage, LoadResult } from '@allay/template-sdk';
import { create } from 'zustand';
import type { LoadIssue } from '../features/preview/loadIssues';

// 预览引擎的状态，给预览区的错误卡片、时间轴的音效轨、状态栏和测试钩子看。

export type PreviewStatus =
  | { kind: 'starting' }
  | { kind: 'loading' }
  | { kind: 'ready'; warnings: string[] }
  /**
   * 模板出错：装载、setup 或渲染时抛错。issues 是校验失败时的原始 issue（界面整理成短句显示，原样进诊断信息）
   */
  | { kind: 'error'; message: string; issues?: LoadIssue[] }
  /** 看门狗终止了 Worker（模板无响应），已经重建了一个空闲的 Worker */
  | { kind: 'unresponsive'; operation: string }
  /** 显卡或驱动不支持、Worker 崩溃 */
  | { kind: 'crashed'; message: string };

interface PreviewState {
  status: PreviewStatus;
  loaded: { revision: number; locale: string; duration: number; timing?: EffectiveTiming | undefined; clipTiming?: CompositionLoadResult['clipTiming'];
    resourceNotices?: LoadResult['resourceNotices']; clipResourceNotices?: CompositionLoadResult['clipResourceNotices'] } | null;
  /** 当前 Worker 是第几个（每重建一次加一） */
  generation: number;
  /** 当前装载结果里的音效 cue（时间轴的音效轨只读显示） */
  audioCues: readonly AudioCue[];
  /** 最近一次播放、导出时放不出声的音效事件（资源栈里没有，已静音并提示过） */
  audioMissing: readonly string[];
  fontUsage: readonly FontUsage[];
  /** 播放时实测的预览帧率（最近约 1 秒的滑动平均）；没在播放时为 null */
  measuredFps: number | null;
  setStatus(status: PreviewStatus, loaded?: NonNullable<PreviewState['loaded']>): void;
  setGeneration(generation: number): void;
  setAudioCues(cues: readonly AudioCue[]): void;
  setAudioMissing(missing: readonly string[]): void;
  setFontUsage(usage: readonly FontUsage[]): void;
  clearResourceNotices(): void;
  setMeasuredFps(fps: number | null): void;
}

export const usePreviewStore = create<PreviewState>((set) => ({
  status: { kind: 'starting' },
  loaded: null,
  generation: 0,
  audioCues: [],
  audioMissing: [],
  fontUsage: [],
  measuredFps: null,
  setStatus: (status, loaded) => set({ status, loaded: loaded ?? null, fontUsage: [] }),
  setGeneration: (generation) => set({ generation }),
  setAudioCues: (audioCues) => set({ audioCues }),
  setAudioMissing: (audioMissing) => set({ audioMissing: [...audioMissing] }),
  setFontUsage: (fontUsage) => set((state) => state.fontUsage.length === fontUsage.length && state.fontUsage.every((item, index) =>
    item.clipId === fontUsage[index]?.clipId && item.flags === fontUsage[index]?.flags) ? state : { fontUsage }),
  clearResourceNotices: () => set((state) => state.loaded && (state.loaded.resourceNotices || state.loaded.clipResourceNotices)
    ? { loaded: { ...state.loaded, resourceNotices: undefined, clipResourceNotices: undefined } } : state),
  setMeasuredFps: (measuredFps) => set({ measuredFps }),
}));
