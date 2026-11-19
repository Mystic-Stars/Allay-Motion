// 应用里的音频（docs/05-export.md 5.5、06-ui-design.md 6.4、6.5）：
// - 音效库：按音效名或库 ID 经 IPC 取文件，资源栈一变就清空；
// - 预览播放：跟着 transportStore 走。音乐、空间音效及裁切过的 cue 可以从中途续播；暂停、拖动、跳转或循环时
//   立刻停掉正在响的声音再重新调度，不叠音、不拖到下一轮；静音时不调度；
// - 试听（SoundField 的按钮）；
// - 缺失的音效：静音并给一条提示（不报错），同一组缺失在同一个资源栈下只提示一次。
// 时间轴的时钟仍是界面的 rAF（TransportBar），声音按 AudioContext 的时钟排；两者偏离超过容差就重新调度。
import { ImportedSoundIdSchema } from '@allay/assets';
import type { AudioCue } from '@allay/template-sdk';
import i18next from 'i18next';
import { notify } from '../stores/noticeStore';
import { usePreviewStore } from '../stores/previewStore';
import { currentStamp, useResourceStore } from '../stores/resourceStore';
import { useTransportStore } from '../stores/transportStore';
import { useUiStore } from '../stores/uiStore';
import { scheduleCues } from './schedule';
import { MIX_SAMPLE_RATE, SoundBank } from './sound-bank';
import { soundFileStates, useSoundLibraryStore } from './sound-library';

async function loadSoundFile(file: string, profile?: string): Promise<Uint8Array | null> {
  return profile ? window.allay.sound.read(file, profile) : window.allay.sound.read(file);
}

const notifiedMissing = new Set<string>();

/** 应用共用的音效库（预览、试听、导出） */
export const soundBank = new SoundBank(loadSoundFile);
let bankStamp = currentStamp();
useResourceStore.subscribe((s, previous) => {
  const stamp = s.state?.stamp ?? '';
  const profiles = (state: typeof s) => JSON.stringify(state.state?.library?.profiles.map(({ id, stamp }) => [id, stamp]));
  if (stamp !== bankStamp || profiles(s) !== profiles(previous)) {
    bankStamp = stamp;
    soundBank.clear();
    notifiedMissing.clear();
  }
});

function soundName(id: string): string {
  const names = useSoundLibraryStore.getState().events.find((item) => item.id === id)?.names;
  const label = i18next.language.startsWith('zh') ? names?.['zh-CN'] : names?.en;
  if (label) return label;
  return i18next.t(`editor.sound.names.${id.replace(/[:.]/g, '_')}`, { defaultValue: id });
}

/**
 * 放不出声的音效：给一条提示（同一组在同一个资源栈下只提示一次）。
 * forCues 为真时（预览播放、导出）同时记进 previewStore，给测试和以后的界面看。
 */
export function reportMissingSounds(missing: readonly string[], forCues = true): void {
  if (forCues) usePreviewStore.getState().setAudioMissing(missing);
  if (missing.length === 0) return;
  const key = `${bankStamp}|${[...missing].sort().join(',')}`;
  if (notifiedMissing.has(key)) return;
  notifiedMissing.add(key);
  const list = missing.slice(0, 4).map(soundName).join(i18next.t('templates.listSeparator'));
  notify('info', i18next.t('audio.missing', { count: missing.length, list }));
}

/** 预览播放和试听共用的实时上下文（第一次需要时才建，48 kHz：与离线混音同一个采样率） */
let ctx: AudioContext | null = null;
function context(): AudioContext {
  ctx ??= new AudioContext({ sampleRate: MIX_SAMPLE_RATE, latencyHint: 'interactive' });
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

interface Session {
  gain: GainNode;
  sources: AudioBufferSourceNode[];
  /** 时间轴时刻 from 对应上下文时刻 startAt */
  from: number;
  startAt: number;
}

/** 时间轴与声音的时钟偏离超过这个值（秒）就当作跳转，重新调度 */
const DRIFT_TOLERANCE = 0.2;
/** 停止时的淡出（避免爆音），秒 */
const STOP_FADE = 0.008;

class PreviewAudio {
  private session: Session | null = null;
  /** 每次开始或停止加一：异步准备完时据此判断是否已经过时 */
  private token = 0;
  private audition: AudioBufferSourceNode | null = null;
  private auditionToken = 0;
  private auditionTurn = new Map<string, number>();
  /** 测试钩子看的：最近一次试听 */
  lastAudition: { sound: string; file: string | null } | null = null;
  private started = false;

  /** 订阅播放状态（应用启动时调用一次） */
  start(): void {
    if (this.started) return;
    this.started = true;
    useTransportStore.subscribe((s, prev) => {
      if (s.playing !== prev.playing) {
        if (s.playing) this.restart();
        else this.stop();
      } else if (s.playing && s.time !== prev.time) {
        this.follow(s.time);
      }
    });
    usePreviewStore.subscribe((s, prev) => {
      if (s.audioCues === prev.audioCues) return;
      // sound 参数变了：立刻反映到 cue（正在播放就按新的 cue 重新调度），并提前解码
      void soundBank.prepare(s.audioCues);
      const t = useTransportStore.getState();
      if (t.playing) this.restart();
    });
    useUiStore.subscribe((s, prev) => {
      if (s.settings.editor.muted === prev.settings.editor.muted) return;
      const t = useTransportStore.getState();
      if (s.settings.editor.muted) this.stop();
      else if (t.playing) this.restart();
    });
  }

  /** 正在播放：时间轴的时刻和声音的时钟对不上（循环回到开头、跳转）就重新调度 */
  private follow(time: number): void {
    const s = this.session;
    if (!s || !ctx) return;
    const expected = s.from + (ctx.currentTime - s.startAt);
    if (Math.abs(time - expected) > DRIFT_TOLERANCE) this.restart();
  }

  private stop(): void {
    this.token++;
    const s = this.session;
    this.session = null;
    if (!s || !ctx) return;
    const now = ctx.currentTime;
    s.gain.gain.cancelScheduledValues(now);
    s.gain.gain.setValueAtTime(s.gain.gain.value, now);
    s.gain.gain.linearRampToValueAtTime(0, now + STOP_FADE);
    for (const src of s.sources) {
      try {
        src.stop(now + STOP_FADE + 0.002);
      } catch {
        // 已经停了
      }
    }
    setTimeout(() => s.gain.disconnect(), 100);
  }

  private restart(): void {
    this.stop();
    if (useUiStore.getState().settings.editor.muted) return;
    const cues = usePreviewStore.getState().audioCues;
    if (cues.length === 0) return;
    const token = this.token;
    void this.begin(cues, token);
  }

  private async begin(cues: readonly AudioCue[], token: number): Promise<void> {
    const prepared = await soundBank.prepare(cues);
    if (token !== this.token) return;
    reportMissingSounds(prepared.missing);
    if (prepared.voices.length === 0) return;
    const c = context();
    const transport = useTransportStore.getState();
    if (!transport.playing) return;
    // 准备期间时间轴可能往前走了一点：从现在的时刻排
    const from = transport.time;
    const gain = c.createGain();
    gain.connect(c.destination);
    const startAt = c.currentTime + 0.01;
    const sources = scheduleCues(c, gain, prepared.voices, { from, startAt, until: transport.duration });
    this.session = { gain, sources, from, startAt };
  }

  /** SoundField 的试听：放一次这个事件（多个变体时每点一次换下一个）。不受时间轴静音的影响：这是用户明确要听 */
  async preview(eventId: string): Promise<void> {
    const token = ++this.auditionToken;
    this.audition?.stop();
    this.audition = null;
    const variants = (await window.allay.resources.soundVariants(eventId).catch(() => null)) ?? [];
    if (token !== this.auditionToken) return;
    const playable = variants.filter((v) => v.weight > 0);
    const turn = this.auditionTurn.get(eventId) ?? 0;
    this.auditionTurn.set(eventId, turn + 1);
    const variant = playable.length > 0 ? playable[turn % playable.length]! : null;
    // 下载缓存里还没取回的：试听是用户操作，按需取回（decisions.md M6b）
    if (variant && !ImportedSoundIdSchema.safeParse(variant.file).success && (await soundFileStates([variant.file], false))[variant.file] === 'remote') await soundFileStates([variant.file], true);
    const buffer = variant ? await soundBank.buffer(variant.file) : null;
    if (token !== this.auditionToken) return;
    this.lastAudition = { sound: eventId, file: buffer && variant ? variant.file : null };
    if (!buffer || !variant) {
      reportMissingSounds([eventId], false);
      return;
    }
    const c = context();
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = Math.min(16, Math.max(1 / 16, variant.pitch));
    const gain = c.createGain();
    gain.gain.value = Math.min(1, variant.volume);
    source.connect(gain).connect(c.destination);
    source.onended = () => {
      source.disconnect();
      gain.disconnect();
      if (this.audition === source) this.audition = null;
    };
    source.start();
    this.audition = source;
  }

  /** 测试钩子：当前调度的状态 */
  debug() {
    return {
      scheduled: this.session?.sources.length ?? 0,
      from: this.session?.from ?? null,
      contextState: ctx?.state ?? null,
      sampleRate: ctx?.sampleRate ?? null,
      auditioning: this.audition !== null,
      lastAudition: this.lastAudition,
      missing: [...usePreviewStore.getState().audioMissing],
    };
  }
}

export const previewAudio = new PreviewAudio();
