// “渲染某一时刻为一张图”的统一接口（docs/code-editing-and-mcp-plan.md H4）：在杂务（或导出）Worker 里装载模板，
// 按帧号或时刻渲染成直通 alpha 的 RGBA 图，尺寸有上限（最长边不超过 STILL_MAX_EDGE，超过时等比缩小）。
// 模板封面和悬停预览、评审截图、测试钩子都经它；将来可能的 MCP 的 render_frames 也只会经它（届时再收紧上限）。
import { frameCount } from '@allay/engine/frames';
import type { FrameQuality, LoadRequest, ParamValues } from '@allay/template-sdk';
import type { TemplateSource } from '../templates/catalog';
import { EngineHost } from './EngineHost';
import { createResolver, loadStamp } from './resource-client';

/** 一张图的最长边上限（像素） */
export const STILL_MAX_EDGE = 1920;
/** 一个会话最多渲染多少张（封面的悬停预览最多 120 张） */
export const STILL_MAX_FRAMES = 240;
/** 缩略图的默认画质：不加运动模糊 */
export const STILL_FAST: FrameQuality = { subframes: 1, shutterAngle: 0 };

export interface StillRequest {
  source: TemplateSource;
  params: ParamValues;
  /** 想要的尺寸；最长边超过 maxEdge（缺省 STILL_MAX_EDGE，也不能超过它）时等比缩小 */
  width: number;
  height: number;
  /** 缩略图可显式指定原输出尺寸；否则用缩小前的 width / height。 */
  referenceSize?: LoadRequest['referenceSize'];
  fps: number;
  maxEdge?: number;
  locale: string;
  profileId?: string;
}

export interface StillSession {
  usesPlaceholder: boolean;
  /** 实际的渲染尺寸（已按上限缩小） */
  width: number;
  height: number;
  fps: number;
  duration: number;
  cutTime: number | null;
  /** 总帧数 */
  frames: number;
  /** 第 index 帧（0 起）；直通 alpha 的 RGBA，第一行是顶部 */
  frame(index: number, quality?: FrameQuality): Promise<ImageData>;
  /** t 时刻（秒）所在的那一帧 */
  at(t: number, quality?: FrameQuality): Promise<ImageData>;
}

/** 按上限等比缩小；两边都至少 16（引擎的输出下限） */
export function clampStillSize(width: number, height: number, maxEdge = STILL_MAX_EDGE): { width: number; height: number } {
  const edge = Math.max(16, Math.min(STILL_MAX_EDGE, Math.floor(maxEdge)));
  const k = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(16, Math.round(width * k)), height: Math.max(16, Math.round(height * k)) };
}

/**
 * 在 host（杂务或导出模式）里装载 req 的模板，返回可以逐帧取图的会话。
 * host 由调用方管理（封面一批模板共用一个 Worker）；会话在 host 装载别的模板之后失效。
 */
export async function openStill(host: Pick<EngineHost, 'load' | 'renderFrame'>, req: StillRequest): Promise<StillSession> {
  const size = clampStillSize(req.width, req.height, req.maxEdge);
  const output = { ...size, fps: req.fps };
  const referenceSize = req.referenceSize ?? ((size.width !== req.width || size.height !== req.height) ? { width: req.width, height: req.height } : undefined);
  const loaded = await host.load({ manifest: req.source.manifest, code: req.source.code, params: req.params, output, referenceSize,
    resourceStamp: loadStamp(req.source.assets, req.profileId), locale: req.locale });
  const total = frameCount(loaded.duration, req.fps);
  let rendered = 0;
  const frame = async (index: number, quality: FrameQuality = STILL_FAST): Promise<ImageData> => {
    if (++rendered > STILL_MAX_FRAMES) throw new Error(`still session exceeds ${STILL_MAX_FRAMES} frames`);
    const i = Math.min(total - 1, Math.max(0, Math.round(index)));
    const px = await host.renderFrame(i, quality);
    return new ImageData(new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength), size.width, size.height);
  };
  return {
    ...size,
    usesPlaceholder: loaded.resourceNotices?.includes('catalog-placeholder') ?? false,
    fps: req.fps,
    duration: loaded.duration,
    cutTime: loaded.cutTime,
    frames: total,
    frame,
    at: (t, quality) => frame(Math.round(t * req.fps), quality),
  };
}

/** 渲染单独一张（自己建、用完就销毁杂务 Worker），编码成 PNG */
export async function renderStillPng(req: StillRequest & { t: number; quality?: FrameQuality }): Promise<{ png: Uint8Array; width: number; height: number }> {
  const host = await EngineHost.create({ mode: 'utility', resolveResource: createResolver(() => req.source.assets, req.profileId) });
  try {
    const session = await openStill(host, req);
    const img = await session.at(req.t, req.quality);
    const canvas = new OffscreenCanvas(img.width, img.height);
    const g = canvas.getContext('2d');
    if (!g) throw new Error('2d context unavailable');
    g.putImageData(img, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { png: new Uint8Array(await blob.arrayBuffer()), width: img.width, height: img.height };
  } finally {
    host.dispose();
  }
}
