// 导出的主进程实现（docs/05-export.md 5.1、1.8 的 export 命名空间）。
// 输出文件夹只来自主进程自己的文件夹对话框（1.6 第 6 条），记在设置里；渲染进程只给文件名，这里再清洗一次。
// 测试开关 ALLAY_E2E_EXPORT_TARGET、ALLAY_E2E_H264 只在未打包时生效。
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { app, clipboard, powerSaveBlocker, shell, type BrowserWindow } from 'electron';
import {
  PRESET_EXTENSION,
  sanitizeFileName,
  type ChooseFolderResult,
  type ExportFailure,
  type ExportFinishResult,
  type ExportStartRequest,
  type ExportStartResult,
  type ExportStepResult,
  type FfmpegInfo,
  type H264Probe,
  H264_PROBE_CHECK,
} from '../../shared/export';
import type { Logger } from '../logger';
import type { SettingsStore } from '../settings-store';
import type { FolderService } from '../folders';
import { probeH264 } from './encoder-probe';
import { buildInfo, locateFfmpeg, probeCaps, type FfmpegCaps } from './ffmpeg-locate';
import { ExportJob, ExportJobError, uniquePath } from './export-job';
import { PRESET_AUDIO_ENCODER } from './ffmpeg-args';

export interface ExportServiceOptions {
  log: Logger;
  settings: SettingsStore;
  getMainWindow(): BrowserWindow | null;
  /** 未打包时 ALLAY_FFMPEG 指定的 FFmpeg */
  ffmpegOverride: string | null;
  /** 未打包时测试用的输出文件夹（跳过文件夹对话框） */
  testTarget: string | null;
  /** 未打包时测试用的 H.264 候选列表（代替 5.3 的表） */
  h264Candidates: string[] | null;
  /** 输出文件夹的检查与选择（和设置页共用一套，界面增强） */
  folders: FolderService;
}

interface Running {
  job: ExportJob;
  blocker: number;
}

/** 记住最近完成的输出，“在文件夹中显示”只能显示这里面的 */
const MAX_REMEMBERED_OUTPUTS = 20;

export class ExportService {
  private readonly jobs = new Map<string, Running>();
  private readonly outputs = new Map<string, string>();
  private caps: Promise<FfmpegCaps> | null = null;
  private probing: Promise<H264Probe | null> | null = null;
  private logged = false;

  constructor(private readonly opts: ExportServiceOptions) {}

  /** resources/ffmpeg：打包后在安装目录的 resources 下，开发时在仓库根目录 */
  private resourcesDir(): string {
    return app.isPackaged ? join(process.resourcesPath, 'ffmpeg') : join(app.getAppPath(), '../../resources/ffmpeg');
  }

  ffmpegPath(): string | null {
    return locateFfmpeg({ override: this.opts.ffmpegOverride, resourcesDir: this.resourcesDir(), searchPath: !app.isPackaged });
  }

  private capabilities(): Promise<FfmpegCaps> {
    this.caps ??= probeCaps(this.ffmpegPath());
    return this.caps;
  }

  /** 版本、各预设能不能用、缓存的 H.264 探测结果。启动时跑一次并记进日志（5.6） */
  async ffmpegInfo(): Promise<FfmpegInfo> {
    const caps = await this.capabilities();
    const info = buildInfo(caps, this.opts.settings.exportSettings.h264, this.opts.h264Candidates ?? undefined);
    if (!this.logged) {
      this.logged = true;
      this.opts.log.info('export', 'ffmpeg probed', { path: this.ffmpegPath(), version: info.version, presets: info.presets, h264: info.h264?.encoder ?? null });
    }
    return info;
  }

  /**
   * H.264 编码器探测（5.3）：缓存的结果与当前 FFmpeg 版本一致时直接用，force 为真时重新试编码。
   * FFmpeg 不能用时返回 null。
   */
  probeEncoders(force: boolean): Promise<H264Probe | null> {
    this.probing ??= this.runProbe(force).finally(() => {
      this.probing = null;
    });
    return this.probing;
  }

  private async runProbe(force: boolean): Promise<H264Probe | null> {
    const caps = await this.capabilities();
    const ffmpeg = this.ffmpegPath();
    if (!caps.available || !caps.version || !ffmpeg) return null;
    const cached = this.opts.settings.exportSettings.h264;
    if (!force && cached && cached.ffmpegVersion === caps.version && cached.check === H264_PROBE_CHECK) return cached;
    const result = await probeH264({ ffmpeg, version: caps.version, listed: caps.encoders, candidates: this.opts.h264Candidates ?? undefined });
    await this.opts.settings.updateExport({ h264: result });
    this.opts.log.info('export', 'h264 encoders probed', { encoder: result.encoder, attempts: result.attempts });
    return result;
  }

  /** 当前的输出文件夹：测试开关，或设置里记的（还存在的）文件夹；都没有时为 null */
  outputFolder(): string | null {
    if (this.opts.testTarget) return this.opts.testTarget;
    const folder = this.opts.settings.exportSettings.folder;
    if (!folder) return null;
    try {
      return statSync(folder).isDirectory() ? folder : null;
    } catch {
      return null;
    }
  }

  /** 主进程的文件夹对话框；选中的文件夹可写才记进设置（选了不能写的文件夹算取消，设置页会说明原因） */
  async chooseFolder(): Promise<ChooseFolderResult> {
    const result = await this.opts.folders.choose('export');
    if ('canceled' in result || !result.ok || !result.info.path) return { canceled: true };
    return { canceled: false, folder: result.info.path };
  }

  async start(req: ExportStartRequest): Promise<ExportStartResult> {
    const ffmpeg = this.ffmpegPath();
    const info = await this.ffmpegInfo();
    if (!ffmpeg || !info.available) return { ok: false, error: { code: 'ffmpeg-missing', detail: 'ffmpeg executable not found or not runnable' } };
    if (info.blockers[req.preset] === 'encoder-missing') return { ok: false, error: { code: 'encoder-unavailable', detail: `encoder for ${req.preset} not in ffmpeg -encoders` } };

    let h264Encoder: string | null = null;
    if (req.preset === 'greenscreen-mp4') {
      // 首次需要时探测（5.1 第 1 步）
      const probe = await this.probeEncoders(false);
      if (!probe?.encoder) {
        const detail = probe ? probe.attempts.map((a) => `${a.encoder}: ${a.result}${a.detail ? ` (${a.detail})` : ''}`).join('\n') : 'probe failed';
        return { ok: false, error: { code: 'encoder-unavailable', detail } };
      }
      h264Encoder = probe.encoder;
    }

    // 有音轨（M6b）：这个预设的音频编码器要在（5.6 列的 aac、libopus、pcm_s16le）
    const audioEncoder = req.audio ? PRESET_AUDIO_ENCODER[req.preset] : null;
    if (audioEncoder && !(await this.capabilities()).encoders.has(audioEncoder)) {
      return { ok: false, error: { code: 'encoder-unavailable', detail: `audio encoder ${audioEncoder} not in ffmpeg -encoders` } };
    }

    // 设置里的文件夹不存在或不可写时，和没选过一样先问（docs/decisions.md 界面增强）
    let folder = this.opts.testTarget ?? (await this.opts.folders.usable('export'));
    if (!folder) {
      const chosen = await this.chooseFolder();
      if (chosen.canceled) return { ok: false, canceled: true };
      folder = chosen.folder;
    }
    const name = sanitizeFileName(req.suggestedName);
    const wanted = req.preset === 'png-sequence' ? join(folder, name) : join(folder, `${name}.${PRESET_EXTENSION[req.preset]}`);
    const target = await uniquePath(wanted);

    const job = new ExportJob({ ffmpeg, preset: req.preset, width: req.width, height: req.height, fps: req.fps, totalFrames: req.totalFrames, cutFrame: req.cutFrame, target, h264Encoder, audio: req.audio === true });
    try {
      await job.start();
    } catch (error) {
      return { ok: false, error: this.failure(error, 'start') };
    }
    const jobId = randomUUID();
    const blocker = powerSaveBlocker.start('prevent-app-suspension');
    this.jobs.set(jobId, { job, blocker });
    this.opts.log.info('export', 'job started', { jobId, pid: job.pid, sleepBlocked: powerSaveBlocker.isStarted(blocker), preset: req.preset, encoder: h264Encoder, width: req.width, height: req.height, fps: req.fps, frames: req.totalFrames, audio: req.audio === true });
    return { ok: true, job: { jobId, target, encoder: h264Encoder } };
  }

  /** 交来混好的 WAV（5.5）；主进程写临时文件（PNG 序列直接写进输出目录）后才启动 FFmpeg */
  async writeAudio(jobId: string, wav: Uint8Array): Promise<ExportStepResult> {
    const running = this.require(jobId);
    try {
      await running.job.writeAudio(wav);
      return { ok: true };
    } catch (error) {
      this.end(jobId);
      return { ok: false, error: this.failure(error, 'audio') };
    }
  }

  async writeFrame(jobId: string, pixels: Uint8Array): Promise<ExportStepResult> {
    const running = this.require(jobId);
    try {
      await running.job.writeFrame(pixels);
      return { ok: true };
    } catch (error) {
      this.end(jobId);
      return { ok: false, error: this.failure(error, 'write') };
    }
  }

  async finish(jobId: string): Promise<ExportFinishResult> {
    const running = this.require(jobId);
    try {
      const path = await running.job.finish();
      this.remember(jobId, path);
      this.opts.log.info('export', 'job finished', { jobId, frames: running.job.framesWritten });
      return { ok: true, path, frames: running.job.framesWritten };
    } catch (error) {
      return { ok: false, error: this.failure(error, 'finish') };
    } finally {
      this.end(jobId);
    }
  }

  async cancel(jobId: string): Promise<void> {
    const running = this.jobs.get(jobId);
    if (!running) return;
    this.end(jobId);
    await running.job.cancel();
    this.opts.log.info('export', 'job canceled', { jobId });
  }

  /** 退出应用时：取消全部任务，不留临时文件 */
  async cancelAll(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map((id) => this.cancel(id)));
  }

  /** 是否有进行中的任务（powerSaveBlocker 是否开着，测试用） */
  isBlockingSleep(): boolean {
    return [...this.jobs.values()].some((r) => powerSaveBlocker.isStarted(r.blocker));
  }

  /** “在文件夹中显示”：只认这个进程里导出完成的任务 */
  reveal(jobId: string): void {
    const path = this.outputs.get(jobId);
    if (!path) throw new UnknownJobError();
    shell.showItemInFolder(path);
  }

  /** “复制诊断信息”：文本由界面拼好（不含任何文件内容），写进系统剪贴板 */
  copyDiagnostics(text: string): void {
    clipboard.writeText(text);
  }

  private remember(jobId: string, path: string): void {
    this.outputs.set(jobId, path);
    while (this.outputs.size > MAX_REMEMBERED_OUTPUTS) this.outputs.delete(this.outputs.keys().next().value!);
  }

  private require(jobId: string): Running {
    const running = this.jobs.get(jobId);
    if (!running) throw new UnknownJobError();
    return running;
  }

  private end(jobId: string): void {
    const running = this.jobs.get(jobId);
    if (!running) return;
    this.jobs.delete(jobId);
    if (powerSaveBlocker.isStarted(running.blocker)) powerSaveBlocker.stop(running.blocker);
  }

  private failure(error: unknown, stage: string): ExportFailure {
    const failure: ExportFailure =
      error instanceof ExportJobError ? error.failure : { code: 'ffmpeg-failed', detail: error instanceof Error ? error.message : String(error) };
    this.opts.log.warn('export', 'job failed', { stage, code: failure.code, detail: failure.detail.slice(-1000) });
    return failure;
  }
}

export class UnknownJobError extends Error {
  constructor() {
    super('unknown export job');
    this.name = 'UnknownJobError';
  }
}
