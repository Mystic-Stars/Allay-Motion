import { DOWNLOAD_STAGES, type DownloadActivity, type DownloadProgressView, type DownloadStage, type StageStatus } from '../../shared/resources';
import { DownloadProgressSchema } from './download';

// 下载原版资源的进度（docs/06-ui-design.md 6.12、docs/decisions.md 界面增强）：把下载器逐个文件上报的字节数
// 折算成五个阶段的状态和整体进度。纯逻辑，时钟可注入，单元测试直接用。
//
// - 阶段只往前走：下载器或服务给出更早的阶段时不回退。
// - 整体进度按字节算：jar、资源索引、全景、字体和音效对象（已缓存的文件算作已收到）。音效的总量要等读到资源索引才知道，
//   在那之前分母里放一个估计值；真正的数字比估计小时分数会想往回跳，所以分数只增不减。
// - 不是字节的几步（清单、读 jar 的条目目录、建立资源栈）各占一小份固定权重，所以字节下完之后还有可见的推进，
//   完成之前最多到 0.99，完成时才是 1。
// - 速度只按真正从网络收到的字节、最近 3 秒算；超过 2 秒没有新字节就不显示速度和剩余时间。

const W_MANIFEST = 0.02;
const W_BYTES = 0.9;
const W_SCAN = 0.03;
// 剩下的 0.05 给“建立资源栈”，完成时补上
/** 读到资源索引之前，音效对象总量的估计（10 个事件的全部变体，实际约几百 KB）；不超过 jar 的 5% */
export const SOUNDS_ESTIMATE_BYTES = 1024 * 1024;
export function soundsEstimate(jarBytes: number): number {
  return Math.min(SOUNDS_ESTIMATE_BYTES, Math.round(jarBytes * 0.05));
}
const SPEED_WINDOW_MS = 3000;
const SPEED_MIN_SPAN_MS = 500;
const SPEED_STALE_MS = 2000;

const EXTRACT_FILES = ['index', 'panorama', 'fonts'] as const;
type FileKey = 'jar' | typeof EXTRACT_FILES[number] | 'sounds';

export class DownloadTracker {
  private stageIdx = 0;
  private readonly status = new Map<DownloadStage, StageStatus>(DOWNLOAD_STAGES.map((s, i) => [s, i === 0 ? 'active' : 'pending']));
  private readonly got: Record<FileKey, number> = { jar: 0, index: 0, panorama: 0, fonts: 0, sounds: 0 };
  private readonly size: Record<FileKey, number | null> = { jar: null, index: null, panorama: null, fonts: null, sounds: null };
  private planned = false;
  private versionId: string | null = null;
  private currentActivity: DownloadActivity = 'manifest';
  private items: { done: number; total: number } | null = null;
  private fraction = 0;
  private completed = false;
  private transferred = 0;
  private samples: { t: number; bytes: number }[] = [];
  private lastBytesAt = -Infinity;

  constructor(private readonly now: () => number = Date.now) {}

  get stage(): DownloadStage {
    return DOWNLOAD_STAGES[this.stageIdx]!;
  }

  get activity(): DownloadActivity {
    return this.currentActivity;
  }

  /** 进入某个阶段（之前的阶段都算完成）；更早的阶段忽略 */
  enter(stage: DownloadStage, activity?: DownloadActivity): void {
    const idx = DOWNLOAD_STAGES.indexOf(stage);
    if (idx > this.stageIdx) {
      for (let i = this.stageIdx; i < idx; i++) this.status.set(DOWNLOAD_STAGES[i]!, 'done');
      // 离开音效阶段时，没报过总量（没有资源索引）就按实际收到的算
      if (this.stageIdx <= DOWNLOAD_STAGES.indexOf('sounds') && idx > DOWNLOAD_STAGES.indexOf('sounds')) {
        this.size.sounds ??= this.got.sounds;
        this.items = null;
      }
      this.stageIdx = idx;
      this.status.set(stage, 'active');
    }
    if (activity && idx >= this.stageIdx) this.currentActivity = activity;
    this.recompute();
  }

  /** 下载器的一次上报；不合法时返回 false（调用方记日志，进度不变） */
  event(raw: unknown): boolean {
    const parsed = DownloadProgressSchema.safeParse(raw);
    if (!parsed.success) return false;
    const p = parsed.data;
    if (p.versionId) this.versionId = p.versionId;
    switch (p.phase) {
      case 'manifest':
        this.enter('manifest', 'manifest');
        break;
      case 'version':
        this.enter('manifest', 'version');
        if (p.plan) {
          this.planned = true;
          this.size.jar = p.plan.jarBytes;
          this.size.index = p.plan.indexBytes;
          if (p.plan.indexBytes === 0) this.got.index = 0;
        }
        break;
      case 'jar':
        this.enter('jar', p.cached ? 'jar-cached' : 'jar');
        this.bytes('jar', p.received, p.total, p.cached === true);
        break;
      case 'index':
        this.enter('extract', 'index');
        this.bytes('index', p.received, p.total, p.cached === true);
        break;
      case 'panorama':
      case 'fonts':
        this.enter('extract', p.phase);
        this.bytes(p.phase, p.received, p.total, p.cached === true);
        break;
      case 'object':
        this.enter('sounds', p.total === null ? 'sounds-list' : 'sounds');
        if (p.total !== null) this.bytes('sounds', p.received, p.total, false);
        if (p.items) this.items = p.items;
        break;
    }
    this.recompute();
    return true;
  }

  private bytes(file: FileKey, received: number, total: number | null, cached: boolean): void {
    if (total !== null) this.size[file] = total;
    const delta = received - this.got[file];
    this.got[file] = Math.max(this.got[file], received);
    if (cached || delta <= 0) return;
    this.transferred += delta;
    const t = this.now();
    this.lastBytesAt = t;
    this.samples.push({ t, bytes: this.transferred });
    while (this.samples.length > 2 && this.samples[0]!.t < t - SPEED_WINDOW_MS) this.samples.shift();
  }

  /** 成功 */
  complete(): void {
    for (const s of DOWNLOAD_STAGES) this.status.set(s, 'done');
    this.stageIdx = DOWNLOAD_STAGES.length - 1;
    this.size.sounds ??= this.got.sounds;
    this.items = null;
    this.completed = true;
    this.currentActivity = 'done';
    this.fraction = 1;
  }

  /** 失败或取消：停在当前阶段 */
  stop(how: 'failed' | 'canceled'): void {
    this.status.set(this.stage, how);
  }

  private knownTotal(): number | null {
    if (!this.planned) return null;
    return this.assetBytes() + (this.size.sounds ?? 0);
  }

  private assetBytes(): number {
    return (this.size.jar ?? 0) + EXTRACT_FILES.reduce((total, file) => total + (this.size[file] ?? 0), 0);
  }

  private received(): number {
    return this.got.jar + EXTRACT_FILES.reduce((total, file) => total + this.got[file], 0) + this.got.sounds;
  }

  private recompute(): void {
    if (this.completed) return;
    const soundsIdx = DOWNLOAD_STAGES.indexOf('sounds');
    let byteFrac = 0;
    if (this.planned) {
      const denom = this.assetBytes() + (this.size.sounds ?? soundsEstimate(this.size.jar ?? 0));
      byteFrac = denom > 0 ? Math.min(1, this.received() / denom) : 1;
    }
    const raw = (this.stageIdx > 0 ? W_MANIFEST : 0) + W_BYTES * byteFrac + (this.stageIdx >= soundsIdx ? W_SCAN : 0);
    this.fraction = Math.min(0.99, Math.max(this.fraction, raw));
  }

  private speed(): number | null {
    const t = this.now();
    if (t - this.lastBytesAt > SPEED_STALE_MS || this.samples.length < 2) return null;
    const first = this.samples[0]!;
    const last = this.samples.at(-1)!;
    const span = last.t - first.t;
    if (span < SPEED_MIN_SPAN_MS) return null;
    return ((last.bytes - first.bytes) * 1000) / span;
  }

  snapshot(): DownloadProgressView {
    const total = this.knownTotal();
    const received = this.received();
    const speed = this.completed ? null : this.speed();
    let eta: number | null = null;
    if (speed && speed > 0 && this.planned) {
      const remaining = Math.max(0, this.assetBytes() + (this.size.sounds ?? soundsEstimate(this.size.jar ?? 0)) - received);
      eta = remaining / speed;
    }
    const fileOf: Partial<Record<DownloadStage, FileKey>> = { jar: 'jar', sounds: 'sounds' };
    return {
      stage: this.stage,
      stages: DOWNLOAD_STAGES.map((id) => {
        if (id === 'extract') return {
          id, status: this.status.get(id)!, received: EXTRACT_FILES.reduce((total, file) => total + this.got[file], 0),
          total: EXTRACT_FILES.every((file) => this.size[file] === null) ? null : EXTRACT_FILES.reduce((total, file) => total + (this.size[file] ?? 0), 0),
        };
        const f = fileOf[id];
        return { id, status: this.status.get(id)!, received: f ? this.got[f] : 0, total: f ? this.size[f] : null };
      }),
      received,
      total: total === null ? null : Math.max(total, received),
      fraction: this.fraction,
      bytesPerSecond: speed,
      etaSeconds: eta,
      versionId: this.versionId,
      activity: this.activity,
      items: this.items,
    };
  }
}
