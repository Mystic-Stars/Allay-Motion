// 导出的共享定义（docs/05-export.md）：预设 ID、请求与结果的 schema、错误码、编码器探测的结果，
// 以及几个纯函数（偶数修正、文件名、体积估算）。主进程和渲染进程共用；进程边界用这里的 schema 校验。
import { z } from 'zod';

/** 四个预设，顺序就是对话框里格式卡片的顺序（5.3） */
export const EXPORT_PRESETS = ['prores4444', 'png-sequence', 'webm-vp9', 'greenscreen-mp4'] as const;
export const ExportPresetSchema = z.enum(EXPORT_PRESETS);
export type ExportPreset = z.infer<typeof ExportPresetSchema>;

export const EXPORT_FPS = [24, 25, 30, 50, 60] as const;
export type ExportFps = (typeof EXPORT_FPS)[number];

/** 自定义分辨率的范围（5.2） */
export const MIN_DIMENSION = 64;
export const MAX_DIMENSION = 4096;

/** 宽高各限制在 64–4096，取偶数（5.2） */
const Dimension = z
  .int()
  .min(MIN_DIMENSION)
  .max(MAX_DIMENSION)
  .refine((v) => v % 2 === 0, { message: 'must be even' });

/** 自定义分辨率的修正：限制在 64–4096，奇数向下取偶数（yuv420p 要求偶数，5.4 第 6 条） */
export function evenDimension(value: number): number {
  const v = Number.isFinite(value) ? Math.round(value) : MIN_DIMENSION;
  const clamped = Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, v));
  return clamped - (clamped % 2);
}

/** 30 秒 × 60 fps，再加首尾两帧的余量 */
export const MAX_EXPORT_FRAMES = 30 * 60 + 2;

/** 绿幕的底色（#RRGGBB） */
export const KeyColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const DEFAULT_KEY_COLOR = '#00FF00';
export const KEY_COLOR_CHOICES = ['#00FF00', '#0000FF', '#000000'] as const;

export const ExportStartSchema = z.strictObject({
  preset: ExportPresetSchema,
  width: Dimension,
  height: Dimension,
  fps: z.union(EXPORT_FPS.map((f) => z.literal(f)) as [z.ZodLiteral<24>, z.ZodLiteral<25>, z.ZodLiteral<30>, z.ZodLiteral<50>, z.ZodLiteral<60>]),
  totalFrames: z.int().min(1).max(MAX_EXPORT_FRAMES),
  /** 剪辑点所在的帧；叠加层模板没有 */
  cutFrame: z.int().min(0).max(MAX_EXPORT_FRAMES).nullable(),
  /**
   * 文件名（不含扩展名、不含目录）。对话框里用户可以改；主进程会再清洗一次，
   * 目录只来自主进程自己的文件夹对话框（1.6 第 6 条），这里给的任何路径分隔符都会被替换掉。
   */
  suggestedName: z.string().min(1).max(120),
  /** 有音轨（5.5）：为真时主进程等 writeAudio 交来混音后才启动 FFmpeg。缺省为没有 */
  audio: z.boolean().optional(),
});
export type ExportStartRequest = z.infer<typeof ExportStartSchema>;

export const ExportJobIdSchema = z.uuid();

/** 单帧最大字节数：4096 × 4096 × 4 */
export const MAX_FRAME_BYTES = 4096 * 4096 * 4;
export const FramePixelsSchema = z.instanceof(Uint8Array).refine((b) => b.byteLength > 0 && b.byteLength <= MAX_FRAME_BYTES, {
  message: 'frame size out of range',
});

/** 混音的格式（5.5）：48 kHz、立体声、16 位 PCM 的 WAV */
export const AUDIO_SAMPLE_RATE = 48_000;
export const AUDIO_CHANNELS = 2;
/** WAV 最大字节数：31 秒（30 秒加余量）的 48 kHz 立体声 16 位，再加头部 */
export const MAX_AUDIO_BYTES = 31 * AUDIO_SAMPLE_RATE * AUDIO_CHANNELS * 2 + 1024;
export const AudioWavSchema = z.instanceof(Uint8Array).refine((b) => b.byteLength > 44 && b.byteLength <= MAX_AUDIO_BYTES, {
  message: 'audio size out of range',
});

export interface WavInfo {
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** data 块的字节数 */
  dataBytes: number;
}

/** 读 WAV 头（RIFF/WAVE，fmt 为 PCM）。不是这种格式时返回 null */
export function readWavInfo(bytes: Uint8Array): WavInfo | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let fmt: Omit<WavInfo, 'dataBytes'> | null = null;
  for (let o = 12; o + 8 <= bytes.byteLength; ) {
    const id = tag(o);
    const size = view.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.byteLength) {
      if (view.getUint16(body, true) !== 1) return null;
      fmt = { channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bitsPerSample: view.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt || body + size > bytes.byteLength) return null;
      return { ...fmt, dataBytes: size };
    }
    o = body + size + (size % 2);
  }
  return null;
}
/** “复制诊断信息”的文本上限 */
export const MAX_DIAGNOSTICS_CHARS = 20_000;
export const DiagnosticsTextSchema = z.string().min(1).max(MAX_DIAGNOSTICS_CHARS);

/** 失败的种类；界面按它给出一句人话（5.7） */
export const EXPORT_ERROR_CODES = [
  'ffmpeg-missing',
  'output-not-writable',
  'disk-full',
  'encoder-unavailable',
  'ffmpeg-failed',
  'frame-mismatch',
  'template-failed',
  'template-unresponsive',
] as const;
export type ExportErrorCode = (typeof EXPORT_ERROR_CODES)[number];

export interface ExportFailure {
  code: ExportErrorCode;
  /** 诊断信息（FFmpeg stderr 的最后几行等），只用于日志和“复制诊断信息” */
  detail: string;
}

export interface ExportStarted {
  jobId: string;
  /** 输出位置（显示用） */
  target: string;
  /** 绿幕 MP4 用的 H.264 编码器；其他预设为 null */
  encoder: string | null;
}

export type ExportStepResult = { ok: true } | { ok: false; error: ExportFailure };
export type ExportFinishResult = { ok: true; path: string; frames: number } | { ok: false; error: ExportFailure };
export type ExportStartResult = { ok: true; job: ExportStarted } | { ok: false; error: ExportFailure } | { ok: false; canceled: true };

// ---------------------------------------------------------------- H.264 编码器探测（5.3）

/**
 * 探测顺序（5.3 的表）。libx264、libopenh264 只在所用构建里有时才试；libopenh264 是否保留由人决定（H-H264，默认保留、排最后）。
 * h264_videotoolbox 是 macOS 的系统编码器（只在 macOS 的构建里有）；前四个只在 Windows 的构建里有，顺序互不影响。
 */
export const H264_ENCODERS = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_mf', 'h264_videotoolbox', 'libx264', 'libopenh264'] as const;
export type H264Encoder = (typeof H264_ENCODERS)[number];

export const EncoderAttemptSchema = z.strictObject({
  encoder: z.string().max(64),
  /** unlisted：-encoders 里没有，没试；ok：试编码成功；failed：试编码失败 */
  result: z.enum(['unlisted', 'ok', 'failed']),
  /** 失败时 stderr 的最后一行，或画质不过的原因（截断） */
  detail: z.string().max(500).optional(),
  /** 试编码末帧（运动之后的纯色帧）每个通道的最大误差；编解码都成功时才有 */
  maxError: z.number().int().min(0).max(255).optional(),
});
export type EncoderAttempt = z.infer<typeof EncoderAttemptSchema>;

/**
 * 探测方法的版本：3 = 按 1080p60 试编码以后解回来核对运动之后的纯色帧（docs/05-export.md 5.3）。缓存里没有这一项
 * 或版本不同的结果当作过期、重新探测（没有这一项的旧方法只看能不能编出来，CI 的机器上会选中末帧有残影的 h264_amf；
 * 2 是同样的核对但用 256×144，同样测不出来）
 */
export const H264_PROBE_CHECK = 3;

export const H264ProbeSchema = z.strictObject({
  /** 探测时的 FFmpeg 版本（ffmpeg -version 的第一行）；版本变了缓存作废 */
  ffmpegVersion: z.string().max(300),
  /** 探测方法的版本（H264_PROBE_CHECK）；旧缓存没有这一项 */
  check: z.number().int().optional(),
  /** 胜出的编码器；全部失败时为 null */
  encoder: z.string().max(64).nullable(),
  attempts: z.array(EncoderAttemptSchema).max(16),
  /** ISO 时间 */
  probedAt: z.string().max(40),
});
export type H264Probe = z.infer<typeof H264ProbeSchema>;

/** 预设不可用的原因（界面据此给一句说明） */
export type PresetBlocker = 'ffmpeg-missing' | 'encoder-missing' | 'no-h264' | null;

export interface FfmpegInfo {
  available: boolean;
  version: string | null;
  /** 每个预设是否可用（所需编码器都在；绿幕 MP4 还要有一个试编码成功的 H.264 编码器，未探测时按“列表里有候选”算） */
  presets: Record<ExportPreset, boolean>;
  /** 不可用的原因 */
  blockers: Record<ExportPreset, PresetBlocker>;
  /** 缓存的 H.264 探测结果；还没探测过（或 FFmpeg 版本变了）时为 null */
  h264: H264Probe | null;
}

/** 输出文件夹（主进程的文件夹对话框选的，记在设置里） */
export type ChooseFolderResult = { canceled: true } | { canceled: false; folder: string };

// ---------------------------------------------------------------- 纯函数

export const PRESET_EXTENSION: Record<ExportPreset, string> = {
  prores4444: 'mov',
  'png-sequence': 'png',
  'webm-vp9': 'webm',
  'greenscreen-mp4': 'mp4',
};

/** 文件名：{工程名}_{模板名}_{宽}x{高}_{帧率}fps（5.2）；扩展名由主进程按预设加 */
export function exportBaseName(project: string, template: string, width: number, height: number, fps: number): string {
  return `${project}_${template}_${width}x${height}_${fps}fps`;
}

/** 去掉文件系统不允许的字符（5.2） */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- 去掉控制字符
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  const reserved = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
  if (!cleaned || reserved.test(cleaned)) return 'export';
  return cleaned;
}

/**
 * 每像素每帧的字节数，来自 5.9 的实测（1920×1080、方块风格的合成画面）：
 * ProRes 4444 约 107 MB / 120 帧，PNG 序列约 5 MB，VP9 约 2 MB；H.264 按 1080p60 约 20 Mbps 折算。
 * 实际体积取决于画面内容，界面上写“约”。
 */
const BYTES_PER_PIXEL: Record<ExportPreset, number> = {
  prores4444: 107e6 / (120 * 1920 * 1080),
  'png-sequence': 5e6 / (120 * 1920 * 1080),
  'webm-vp9': 2e6 / (120 * 1920 * 1080),
  'greenscreen-mp4': 20e6 / 8 / 60 / (1920 * 1080),
};

/** 估算的文件大小（字节） */
export function estimateBytes(preset: ExportPreset, width: number, height: number, frames: number): number {
  return Math.round(BYTES_PER_PIXEL[preset] * width * height * frames);
}

/** 剪辑点的时间码 分:秒:帧 */
export function frameTimecode(frame: number, fps: number): string {
  const totalSeconds = Math.floor(frame / fps);
  const f = frame - totalSeconds * fps;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(m)}:${pad(s)}:${pad(f)}`;
}
