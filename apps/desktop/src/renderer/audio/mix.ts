// 导出的离线混音（docs/05-export.md 5.5）：OfflineAudioContext 走和预览同一段调度代码（schedule.ts），
// 结尾 10 ms 淡出，峰值超过 0 dBFS 时整体压到 −1 dBFS，输出 48 kHz 立体声 16 位 PCM 的 WAV。
import type { AudioCue } from '@allay/template-sdk';
import { cueWindow, scheduleCues, voiceParams } from './schedule';
import { MIX_SAMPLE_RATE, type SoundBank } from './sound-bank';
import { encodeWav } from './wav';

export interface MixResult {
  /** 没有能出声的 cue（或混出来全是静音）时为 null：不加音轨（5.5、T-EXP-4） */
  wav: Uint8Array | null;
  /** 峰值超过 0 dBFS，整体压到了 −1 dBFS（界面记一条提示） */
  peakNormalized: boolean;
  /** 放不出声的音效事件 */
  missing: string[];
}

const FADE_SECONDS = 0.01;
const TARGET_PEAK = 10 ** (-1 / 20);

/** 音频的样本数：与视频的长度（帧数 / 帧率）严格相等（5.5） */
export function mixFrames(videoFrames: number, fps: number): number {
  return Math.round((videoFrames / fps) * MIX_SAMPLE_RATE);
}

/**
 * 离线混音。length 是样本数（mixFrames 给出）。同样的 cue、同样的解码结果，两次混音逐样本相同
 * （每个声音单独渲染、按 cue 的顺序相加；淡出和峰值处理在渲染之后用固定的算术做）。
 */
export async function mixOffline(cues: readonly AudioCue[], length: number, bank: SoundBank, signal?: AbortSignal): Promise<MixResult> {
  signal?.throwIfAborted();
  const { voices, missing } = await bank.prepare(cues);
  signal?.throwIfAborted();
  if (voices.length === 0 || length <= 0) return { wav: null, peakNormalized: false, missing };
  // 每个声音单独在一个离线上下文里渲染（同一个 scheduleCues），再按 cue 的顺序在这里相加。
  // 不把所有声音接到同一个 destination 上：Chromium 对一个节点的多路输入求和的顺序不固定，
  // 浮点加法不满足结合律，叠在一起的声音两次混出来会差几个最低位（e2e 实测，见 docs/decisions.md M6b）。
  const channels = [new Float32Array(length), new Float32Array(length)];
  const seconds = length / MIX_SAMPLE_RATE;
  for (const voice of voices) {
    const { cue, buffer } = voice;
    const { rate, gain } = voiceParams(cue);
    const window = gain > 0 ? cueWindow(cue, buffer.duration, rate, 0, seconds) : null;
    if (!window) continue;
    const startFrame = Math.floor(window.start * MIX_SAMPLE_RATE);
    // 这个声音最长占多少个样本（按播放速率换算），多留一个渲染块的余量；不超过视频结尾
    const span = Math.min(length - startFrame, Math.ceil(window.end * MIX_SAMPLE_RATE) - startFrame + 256);
    const ctx = new OfflineAudioContext(2, span, MIX_SAMPLE_RATE);
    const offset = Math.min(startFrame / MIX_SAMPLE_RATE, window.start);
    // 和预览同一个函数：时间轴的 offset 对应这个上下文的 0，声音在视频结尾截断
    scheduleCues(ctx, ctx.destination, [voice], { from: offset, startAt: 0, until: seconds });
    const rendered = await ctx.startRendering();
    signal?.throwIfAborted();
    for (let c = 0; c < 2; c++) {
      const src = rendered.getChannelData(c);
      const dst = channels[c]!;
      for (let i = 0; i < span; i++) dst[startFrame + i]! += src[i]!;
    }
  }

  // 结尾 10 ms 线性淡出
  const fade = Math.min(length, Math.round(FADE_SECONDS * MIX_SAMPLE_RATE));
  for (const data of channels) for (let i = 0; i < fade; i++) data[length - fade + i]! *= (fade - 1 - i) / fade;

  let peak = 0;
  for (const data of channels) for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(data[i]!));
  if (peak === 0) return { wav: null, peakNormalized: false, missing };
  const peakNormalized = peak > 1;
  if (peakNormalized) {
    const k = TARGET_PEAK / peak;
    for (const data of channels) for (let i = 0; i < length; i++) data[i]! *= k;
  }
  return { wav: encodeWav(channels, MIX_SAMPLE_RATE), peakNormalized, missing };
}
