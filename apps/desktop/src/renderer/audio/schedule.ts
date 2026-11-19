// 音频 cue 的调度（docs/05-export.md 5.5、02-engine.md 2.10）。这一段只写一份：
// 预览时传实时的 AudioContext，导出时传 OfflineAudioContext，两边走同一条 buffer → gain → pan 的链路。
import type { AudioCue } from '@allay/template-sdk';

/** 一个能播的 cue：引擎选定的变体已经解码成 AudioBuffer */
export interface CueVoice {
  cue: AudioCue;
  buffer: AudioBuffer;
}

export interface ScheduleOptions {
  /** 时间轴起点（秒）：音乐、空间音效及裁切过的 cue 可从中途续播。 */
  from: number;
  /** from 对应的上下文时刻（ctx.currentTime 的刻度） */
  startAt: number;
  /** 时间轴的终点（秒）：声音在这里截断，不拖到下一轮；不给时放完为止 */
  until?: number;
}

/** 预览和导出共用的数值规则：变体的系数乘到模板给的值上，再钳制到 Web Audio 接受的范围 */
export function voiceParams(cue: AudioCue): { gain: number; rate: number; pan: number } {
  const v = cue.variant;
  const spatial = v?.kind === 'music' ? undefined : cue.spatial;
  const finite = (x: number, d: number) => (Number.isFinite(x) ? x : d);
  return {
    gain: Math.max(0, finite(cue.gain, 1) * (v?.volume ?? 1) * (spatial?.gain ?? 1)),
    rate: Math.min(16, Math.max(1 / 16, finite(cue.rate, 1) * (v?.pitch ?? 1))),
    pan: Math.min(1, Math.max(-1, finite(cue.pan, 0) + (spatial?.pan ?? 0))),
  };
}

export function cueWindow(cue: AudioCue, bufferDuration: number, rate: number, from: number, until = Infinity) {
  if (!cue.clip && !cue.spatial && cue.variant?.kind !== 'music' && cue.at < from) return null;
  const start = Math.max(cue.at, from);
  const offset = Math.max(0, (cue.clip?.offset ?? 0) + start - cue.at) * rate;
  const end = Math.min(until, cue.clip?.end ?? Infinity, start + (bufferDuration - offset) / rate);
  return end > start ? { start, offset, end } : null;
}

/**
 * 把 cue 排进上下文：AudioBufferSourceNode（playbackRate = rate）→ GainNode → StereoPannerNode → destination，
 * 在 at 秒开始（5.5）。返回建好的音源，调用方停止时用。
 */
export function scheduleCues(ctx: BaseAudioContext, destination: AudioNode, voices: readonly CueVoice[], opts: ScheduleOptions): AudioBufferSourceNode[] {
  const sources: AudioBufferSourceNode[] = [];
  for (const { cue, buffer } of voices) {
    const p = voiceParams(cue);
    if (p.gain <= 0) continue;
    const window = cueWindow(cue, buffer.duration, p.rate, opts.from, opts.until);
    if (!window) continue;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = p.rate;
    const gain = ctx.createGain();
    gain.gain.value = p.gain;
    const pan = ctx.createStereoPanner();
    pan.pan.value = p.pan;
    source.connect(gain).connect(pan).connect(destination);
    const when = opts.startAt + (window.start - opts.from);
    source.start(Math.max(0, when), window.offset);
    source.stop(opts.startAt + (window.end - opts.from));
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      pan.disconnect();
    };
    sources.push(source);
  }
  return sources;
}
