// 音效文件的载入与解码（docs/03-assets.md 3.8）：引擎在 cue 里写好了选定的变体（音效名），
// 这里按音效名取文件、用 decodeAudioData 解码成 48 kHz 的 AudioBuffer 并缓存。
// 解码一律在 48 kHz 的离线上下文里做：预览和导出拿到的是同一份样本，导出结果与声卡的采样率无关。
import type { AudioCue } from '@allay/template-sdk';
import { ImportedSoundIdSchema, MAX_SOUND_BYTES } from '@allay/assets';
import type { CueVoice } from './schedule';

export const MIX_SAMPLE_RATE = 48_000;

/** 按音效名（带命名空间，例如 minecraft:dig/stone1）取文件的原始字节；没有时为 null */
export type SoundLoader = (file: string, profile?: string) => Promise<Uint8Array | null>;

export interface PreparedVoices {
  voices: CueVoice[];
  /** 放不出声的音效事件（资源栈里没有这个事件，或文件缺失、解码失败），去重后按出现顺序 */
  missing: string[];
}

export class SoundBank {
  private readonly cache = new Map<string, Promise<AudioBuffer | null>>();
  private decoder: OfflineAudioContext | null = null;

  constructor(private readonly load: SoundLoader) {}

  /** 资源栈变了：丢掉全部缓存 */
  clear(): void {
    this.cache.clear();
  }

  /** 解码好的音效；缺失或解码失败时为 null（null 不缓存：按需取回之后下次就能读到） */
  buffer(file: string, profile?: string): Promise<AudioBuffer | null> {
    const key = JSON.stringify([file, ImportedSoundIdSchema.safeParse(file).success ? null : profile ?? null]);
    let p = this.cache.get(key);
    if (!p) {
      const entry = this.decode(file, profile).catch((error: unknown) => {
        console.warn(`[audio] ${file}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      p = entry.then((b) => {
        if (!b && this.cache.get(key) === p) this.cache.delete(key);
        return b;
      });
      this.cache.set(key, p);
    }
    return p;
  }

  /** 把 cue 换成能播的声音；放不出声的事件记进 missing（不报错：缺失时静音，5.5 / 任务约定） */
  async prepare(cues: readonly AudioCue[]): Promise<PreparedVoices> {
    const voices: CueVoice[] = [];
    const missing: string[] = [];
    const buffers = await Promise.all(cues.map((c) => (c.variant ? this.buffer(c.variant.file, c.clip?.profile) : Promise.resolve(null))));
    cues.forEach((cue, i) => {
      const buffer = buffers[i];
      if (buffer) voices.push({ cue, buffer });
      else if (!missing.includes(cue.sound)) missing.push(cue.sound);
    });
    return { voices, missing };
  }

  private async decode(file: string, profile?: string): Promise<AudioBuffer | null> {
    const bytes = await this.load(file, profile);
    if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_SOUND_BYTES) return null;
    this.decoder ??= new OfflineAudioContext(2, 1, MIX_SAMPLE_RATE);
    // decodeAudioData 会转移（分离）传进去的缓冲：给它一份副本
    return this.decoder.decodeAudioData(bytes.slice().buffer);
  }
}
