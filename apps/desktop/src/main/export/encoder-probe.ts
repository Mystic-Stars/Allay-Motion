// H.264 编码器探测（docs/05-export.md 5.3）：`-encoders` 里列出来不代表能用（取决于显卡和驱动），能编出来也不代表
// 编得对，所以按顺序对每个候选做一次真实的试编码再解回来核对画质（见 trialArgs），第一个通过的胜出。不依赖 Electron。
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { H264_ENCODERS, H264_PROBE_CHECK, type EncoderAttempt, type H264Probe } from '../../shared/export';
import { H264_METADATA_BSF, colorFilter, h264EncoderArgs } from './ffmpeg-args';

export interface ProbeH264Options {
  ffmpeg: string;
  /** ffmpeg -version 的第一行，和结果一起缓存 */
  version: string;
  /** -encoders 列出的编码器名 */
  listed: ReadonlySet<string>;
  /** 候选及顺序；默认 5.3 的表 */
  candidates?: readonly string[];
  /** 单个候选的时限（毫秒，试编码和解码各算一次） */
  timeoutMs?: number;
  /** 试编码的临时文件放在哪；缺省是系统临时目录 */
  tempDir?: string;
}

/**
 * 按默认的导出规格试（1080p60，编码器参数也取这个规格的）。原来用 256×144、30 fps：CI 的机器上 h264_amf 在这么小的
 * 画面上编得干净，按 1080p60 导出时末帧却有残影（最大误差 42），小画面测不出来（docs/decisions.md）
 */
const TRIAL_W = 1920;
const TRIAL_H = 1080;
const TRIAL_FPS = 60;
/** 前面这么多帧是有运动的测试画面，之后是纯色 */
const TRIAL_MOTION_FRAMES = 10;
const TRIAL_FRAMES = 12;
/** 末帧应是的纯色：绿幕的默认底色 #00FF00（5.3 ④） */
export const TRIAL_COLOR = [0, 255, 0] as const;
/**
 * 运动之后的纯色帧的判定，和 T-EXP-7 判绿幕 MP4 末帧的口径相同（那里的末帧也紧跟在运动之后）：
 * 误差超过 TRIAL_FLAT_ERROR 的像素不到 TRIAL_FLAT_RATIO，且没有任何像素超过 TRIAL_MAX_ERROR。
 * 不用 T-EXP-1 ④ 的“全部 ≤ 4”：那是静止画面的口径，运动之后的帧上 nvenc 实测最多 8（导出 1080p 的 T1）
 */
export const TRIAL_FLAT_ERROR = 4;
export const TRIAL_FLAT_RATIO = 0.001;
export const TRIAL_MAX_ERROR = 16;

/**
 * 试编码的命令行：10 帧有运动的合成画面（testsrc2）接 2 帧纯绿 → 与导出相同的色彩滤镜、编码器参数（5.3 的表，1080p60）
 * 和比特流滤镜 → 一个裸 H.264 文件。
 * 末帧要回到纯色：转场的首末帧就是这样（绿幕 MP4 首末帧是纯底色），有的编码器能编出来，但运动之后的纯色帧上留着
 * 上一帧的残影（CI 的机器上应用选中的 h264_amf：1080p 末帧最大误差 42；这台开发机上 h264_mf 在这段试编码里
 * 最大 63、0.56% 的像素超过 4，见 docs/decisions.md）。
 */
export function trialArgs(encoder: string, output: string): string[] {
  const size = `${TRIAL_W}x${TRIAL_H}`;
  const green = TRIAL_COLOR.map((c) => c.toString(16).padStart(2, '0')).join('');
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=s=${size}:r=${TRIAL_FPS}`,
    '-f',
    'lavfi',
    '-i',
    `color=c=0x${green}:s=${size}:r=${TRIAL_FPS}`,
    '-filter_complex',
    `[0:v]trim=end_frame=${TRIAL_MOTION_FRAMES},setpts=PTS-STARTPTS[m];[m][1:v]concat=n=2:v=1:a=0,${colorFilter('yuv420p')}[v]`,
    '-map',
    '[v]',
    '-frames:v',
    String(TRIAL_FRAMES),
    '-c:v',
    encoder,
    ...h264EncoderArgs(encoder, TRIAL_W, TRIAL_H, TRIAL_FPS),
    '-bsf:v',
    H264_METADATA_BSF,
    '-f',
    'h264',
    '-y',
    output,
  ];
}

/** 把试编码里的纯色帧解成 RGBA（和测试回读用的同一种解法：FFmpeg 的缺省转换）；只输出纯色那几帧，省内存 */
export function trialDecodeArgs(input: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', input, '-vf', `select='gte(n,${TRIAL_MOTION_FRAMES})'`, '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'];
}

/** 一帧（RGBA）与纯色的误差：每个像素取三个通道里最大的差；worst 是全帧最大，over 是超过 TRIAL_FLAT_ERROR 的像素数 */
export function solidFrameError(rgba: Uint8Array): { worst: number; over: number } {
  let worst = 0;
  let over = 0;
  for (let p = 0; p < rgba.length; p += 4) {
    let e = 0;
    for (let c = 0; c < 3; c++) e = Math.max(e, Math.abs(rgba[p + c]! - TRIAL_COLOR[c]!));
    if (e > worst) worst = e;
    if (e > TRIAL_FLAT_ERROR) over++;
  }
  return { worst, over };
}

function run(ffmpeg: string, args: string[], timeoutMs: number): Promise<{ ok: true; stdout: Buffer } | { ok: false; detail: string }> {
  return new Promise((resolve) => {
    execFile(ffmpeg, args, { windowsHide: true, timeout: timeoutMs, maxBuffer: (TRIAL_FRAMES - TRIAL_MOTION_FRAMES + 1) * TRIAL_W * TRIAL_H * 4, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ ok: true, stdout });
        return;
      }
      const lines = stderr
        .toString('utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean);
      resolve({ ok: false, detail: (lines.at(-1) ?? (error.killed ? 'timed out' : error.message)).slice(0, 500) });
    });
  });
}

async function trial(ffmpeg: string, encoder: string, timeoutMs: number, tempDir: string): Promise<EncoderAttempt> {
  const file = join(tempDir, `allay-h264-probe-${randomUUID()}.h264`);
  try {
    const encoded = await run(ffmpeg, trialArgs(encoder, file), timeoutMs);
    if (!encoded.ok) return { encoder, result: 'failed', detail: encoded.detail };
    const decoded = await run(ffmpeg, trialDecodeArgs(file), timeoutMs);
    if (!decoded.ok) return { encoder, result: 'failed', detail: `decode: ${decoded.detail}`.slice(0, 500) };
    const frameBytes = TRIAL_W * TRIAL_H * 4;
    const solid = TRIAL_FRAMES - TRIAL_MOTION_FRAMES;
    if (decoded.stdout.length !== frameBytes * solid) {
      return { encoder, result: 'failed', detail: `decoded ${decoded.stdout.length / frameBytes} of ${solid} solid frames` };
    }
    // 运动之后的每一帧纯色都要过（第一帧最难：紧跟在运动后面，和转场的末帧一样）
    let maxError = 0;
    let maxOver = 0;
    for (let i = 0; i < solid; i++) {
      const e = solidFrameError(decoded.stdout.subarray(frameBytes * i, frameBytes * (i + 1)));
      maxError = Math.max(maxError, e.worst);
      maxOver = Math.max(maxOver, e.over);
    }
    if (maxError > TRIAL_MAX_ERROR || maxOver / (TRIAL_W * TRIAL_H) >= TRIAL_FLAT_RATIO) {
      const detail = `solid frames after motion: max color error ${maxError} (limit ${TRIAL_MAX_ERROR}), ${maxOver} px over ${TRIAL_FLAT_ERROR} (limit ${TRIAL_FLAT_RATIO * 100}%)`;
      return { encoder, result: 'failed', maxError, detail };
    }
    return { encoder, result: 'ok', maxError };
  } finally {
    await rm(file, { force: true }).catch(() => undefined);
  }
}

/** 按顺序试，第一个通过的胜出；之后的候选不再试 */
export async function probeH264(opts: ProbeH264Options): Promise<H264Probe> {
  const attempts: EncoderAttempt[] = [];
  let winner: string | null = null;
  for (const encoder of opts.candidates ?? H264_ENCODERS) {
    if (!opts.listed.has(encoder)) {
      attempts.push({ encoder, result: 'unlisted' });
      continue;
    }
    const attempt = await trial(opts.ffmpeg, encoder, opts.timeoutMs ?? 20_000, opts.tempDir ?? tmpdir());
    attempts.push(attempt);
    if (attempt.result === 'ok') {
      winner = encoder;
      break;
    }
  }
  return { ffmpegVersion: opts.version, check: H264_PROBE_CHECK, encoder: winner, attempts, probedAt: new Date().toISOString() };
}
