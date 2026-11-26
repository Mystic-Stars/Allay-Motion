// FFmpeg 的位置与能力（docs/05-export.md 5.6）。不依赖 Electron。
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { EXPORT_PRESETS, H264_ENCODERS, H264_PROBE_CHECK, type ExportPreset, type FfmpegInfo, type H264Probe, type PresetBlocker } from '../../shared/export';
import { PRESET_ENCODERS } from './ffmpeg-args';

const run = promisify(execFile);

/** resources/ffmpeg/<平台>/ 下的目录名 */
export function platformDir(): string {
  return `${process.platform}-${process.arch}`;
}

export function exeName(tool: 'ffmpeg' | 'ffprobe'): string {
  return process.platform === 'win32' ? `${tool}.exe` : tool;
}

export interface LocateOptions {
  /** 未打包时可用：ALLAY_FFMPEG 指定的可执行文件 */
  override: string | null;
  /** resources/ffmpeg 目录（开发时是仓库根目录下的，打包后是 process.resourcesPath 下的） */
  resourcesDir: string;
  /** 未打包时可以退到 PATH */
  searchPath: boolean;
  env?: NodeJS.ProcessEnv;
}

/** 查找顺序：ALLAY_FFMPEG（仅开发）、resources/ffmpeg/、PATH（仅开发）。找不到返回 null */
export function locateFfmpeg(opts: LocateOptions): string | null {
  if (opts.override) return opts.override;
  const bundled = join(opts.resourcesDir, platformDir(), exeName('ffmpeg'));
  if (existsSync(bundled)) return bundled;
  if (!opts.searchPath) return null;
  const pathVar = (opts.env ?? process.env).PATH ?? (opts.env ?? process.env).Path ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exeName('ffmpeg'));
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const NO_WINDOW = { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 } as const;

/** FFmpeg 本身的能力：能不能启动、版本、-encoders 列出的编码器 */
export interface FfmpegCaps {
  available: boolean;
  version: string | null;
  encoders: ReadonlySet<string>;
}

/** 跑一次 ffmpeg -version 和 -encoders */
export async function probeCaps(ffmpeg: string | null): Promise<FfmpegCaps> {
  if (!ffmpeg) return { available: false, version: null, encoders: new Set() };
  try {
    const version = (await run(ffmpeg, ['-hide_banner', '-version'], NO_WINDOW)).stdout.split(/\r?\n/)[0]?.trim() ?? null;
    const encodersOut = (await run(ffmpeg, ['-hide_banner', '-encoders'], NO_WINDOW)).stdout;
    return { available: true, version, encoders: parseEncoders(encodersOut) };
  } catch {
    return { available: false, version: null, encoders: new Set() };
  }
}

/**
 * 每个预设能不能用、不能用的原因。绿幕 MP4：有探测结果时看它；还没探测过时，只要列表里有任何一个候选就先算可用
 * （真正导出前一定会探测，5.3“首次需要时”）。
 */
export function buildInfo(caps: FfmpegCaps, h264: H264Probe | null, candidates: readonly string[] = H264_ENCODERS): FfmpegInfo {
  const presets = {} as Record<ExportPreset, boolean>;
  const blockers = {} as Record<ExportPreset, PresetBlocker>;
  const usableProbe = h264 && caps.version !== null && h264.ffmpegVersion === caps.version && h264.check === H264_PROBE_CHECK ? h264 : null;
  for (const p of EXPORT_PRESETS) {
    let blocker: PresetBlocker = null;
    if (!caps.available) blocker = 'ffmpeg-missing';
    else if (!PRESET_ENCODERS[p].every((e) => caps.encoders.has(e))) blocker = 'encoder-missing';
    else if (p === 'greenscreen-mp4') {
      if (usableProbe) blocker = usableProbe.encoder ? null : 'no-h264';
      else blocker = candidates.some((e) => caps.encoders.has(e)) ? null : 'no-h264';
    }
    presets[p] = blocker === null;
    blockers[p] = blocker;
  }
  return { available: caps.available, version: caps.version, presets, blockers, h264: usableProbe };
}

/** 跑一次 ffmpeg -version 和 -encoders，得出版本和每个预设能不能用（不含 H.264 探测） */
export async function probeFfmpeg(ffmpeg: string | null): Promise<FfmpegInfo> {
  return buildInfo(await probeCaps(ffmpeg), null);
}

/** 解析 ffmpeg -encoders 的输出，取编码器名 */
export function parseEncoders(text: string): Set<string> {
  const names = new Set<string>();
  let started = false;
  for (const line of text.split(/\r?\n/)) {
    if (!started) {
      if (/^\s*-{6}/.test(line)) started = true;
      continue;
    }
    const m = /^\s*[VAS.][F.][S.][X.][B.][D.]\s+(\S+)/.exec(line);
    if (m?.[1]) names.add(m[1]);
  }
  return names;
}
