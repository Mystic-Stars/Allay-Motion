// 主进程的资源栈服务（docs/03-assets.md 3.2–3.5、01-product-architecture.md 1.8 的 resources 命名空间）。
// 持有各层、按设置组装资源栈、算 resourceStamp，栈一变就通知渲染进程。不依赖 Electron：对话框由调用方传入。
import { createHash, randomUUID } from 'node:crypto';
import { realpath, rm, stat } from 'node:fs/promises';
import { normalizeRequestedFont } from '@allay/template-sdk';
import { basename, extname, join } from 'node:path';
import {
  buildStack,
  computeResourceStamp,
  fontPathToId,
  layersWith,
  listMerged,
  parseFontJson,
  readResource,
  resolveLayer,
  resolveFontProviders,
  SOUND_EVENTS,
  textureIdToPath,
  textureMetaPath,
  type ResourceLayer,
  type ResourceStackSettings,
} from '@allay/assets';
import type {
  AddPackResult,
  BrokenPack,
  ChooseGameDirResult,
  DownloadErrorKind,
  DownloadResult,
  DownloadState,
  FontProvidersResult,
  LayerInfo,
  OfficialVersion,
  ResourceLocation,
  ResourceProfileInfo,
  ResourceState,
  SoundFileState,
  SoundFilesResult,
  SoundLibrary,
  SoundVariantInfo,
  VanillaState,
} from '../../shared/resources';
import type { Logger } from '../logger';
import type { SettingsStore } from '../settings-store';
import { DownloadError, type VanillaDownloader } from './download';
import { EncryptedPackError, openBedrockPack } from './bedrock';
import { DownloadTracker } from './download-progress';
import { BUILTIN_LAYER_ID, openBuiltinLayer, openFolderPack, openZipPack, type ClosableLayer } from './layers';
import { importZipPack, packArchiveType, packZipPath } from './pack-import';
import { buildSoundCatalog, findSoundFile, missingSoundNameObjects } from './sound-catalog';
import { detectJavaVersions, findJavaVersions, openVanillaLayer, vanillaRevision, VANILLA_LAYER_ID, type CandidateEnv, type VanillaInstall } from './vanilla';
import { javaProfile, listInstancePacks, sourceId, VersionLibraryFile, type SavedProfile } from './version-library';
import { ZipRejectedError } from './zip';
import { readUnihexArchive } from '../fonts/unihex';

export interface ResourceServiceOptions {
  userDataDir: string;
  /** 内置层的目录（v1 没有自制素材，通常不存在，见 decisions.md M2a） */
  builtinDir: string;
  settings: SettingsStore;
  log: Logger;
  gameEnv: CandidateEnv;
  downloader: VanillaDownloader;
  onChanged(state: ResourceState): void;
}

/** 下载进度最多每 100 ms 通知一次 */
const PROGRESS_INTERVAL_MS = 100;

function downloadErrorKind(error: unknown): DownloadErrorKind {
  if (error instanceof DownloadError) {
    if (error.code === 'hash' || error.code === 'size' || error.code === 'bad-data') return 'verify';
    if (error.code === 'aborted') return 'unknown';
    return 'network';
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOSPC' || code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'disk';
  return 'unknown';
}

type Profile = {
  info: SavedProfile;
  revision: string;
  install?: VanillaInstall;
  layer?: Promise<ClosableLayer | null>;
  overlays: ClosableLayer[];
};

export class ResourceService {
  private builtin: ClosableLayer | null = null;
  private vanillaLayer: ClosableLayer | null = null;
  private activeProfile: Profile | null = null;
  private readonly profiles = new Map<string, Profile>();
  private readonly versionLibrary: VersionLibraryFile;
  private vanillaProblem: VanillaState['problem'] = null;
  private readonly packs = new Map<string, ClosableLayer>();
  private broken: BrokenPack[] = [];
  private stack: ResourceLayer[] = [];
  private stamp = '';
  private detecting = true;
  private download: DownloadState = { status: 'idle' };
  private downloadAbort: AbortController | null = null;
  private lastProgress = 0;
  private progressTimer: ReturnType<typeof setTimeout> | null = null;
  /** 改栈的操作串行执行，避免交错 */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ResourceServiceOptions) {
    this.versionLibrary = new VersionLibraryFile(join(opts.userDataDir, 'resource-library.json'));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private get settings(): ResourceStackSettings {
    return this.opts.settings.resources;
  }

  private async saveSettings(next: ResourceStackSettings): Promise<void> {
    await this.opts.settings.updateResources(next);
  }

  /** 启动：先打开内置层和资源包（不需要探测），再在后台离线探测原版层（3.4） */
  private opened: Promise<void> | null = null;
  private detected: Promise<void> | null = null;

  /** 内置层和资源包已经打开（state() 才有意义） */
  whenOpened(): Promise<void> {
    return this.opened ?? Promise.resolve();
  }

  async init(): Promise<void> {
    this.opened = this.serial(async () => {
      this.builtin = await openBuiltinLayer(this.opts.builtinDir);
      await Promise.all([this.openPacks(), this.versionLibrary.load()]);
      this.rebuild();
    });
    await this.opened;
    this.detected = this.serial(async () => {
      try {
        await this.detectVanilla();
      } catch (error) {
        this.opts.log.warn('resources', 'offline scan failed', { error });
      } finally {
        this.detecting = false;
        this.rebuild();
      }
    });
  }

  // ---- 状态 ----

  state(): ResourceState {
    const profiles = this.profileInfos();
    const active = this.activeProfile?.info.source;
    const local = profiles.find((profile) => profile.source === 'local' && !profile.missing && profile.versionType === 'release');
    const cached = profiles.find((profile) => profile.source === 'downloaded' && !profile.missing);
    const vanilla: VanillaState = {
      consent: this.settings.vanilla.consent,
      enabled: this.settings.vanilla.enabled,
      local: local?.gameDir ? { versionId: local.versionId, gameDir: local.gameDir } : null,
      cached: cached ? { versionId: cached.versionId } : null,
      active: this.settings.vanilla.enabled && this.vanillaLayer && active !== 'bedrock' ? (active === 'downloaded' ? 'cached' : 'local') : null,
      problem: this.vanillaProblem,
    };
    const layers: LayerInfo[] = this.stack.map((l) => {
      const info: LayerInfo = { id: l.id, kind: l.kind, name: l.name, enabled: l.enabled, legacyFormat: l.legacyFormat === true, warnings: [...(l.warnings ?? [])].slice(0, 20) };
      if (l.description !== undefined) info.description = l.description;
      if (l.packFormat !== undefined) info.packFormat = l.packFormat;
      if (l.icon) info.icon = l.icon;
      if (l.kind === 'vanilla') info.source = active === 'bedrock' ? 'bedrock' : vanilla.active === 'cached' ? 'downloaded' : 'local';
      if (l.kind === 'pack') info.source = this.settings.packs.find((p) => p.id === l.id)?.source.kind ?? 'zip';
      if (l.kind === 'builtin') info.empty = l.revision === 'empty' || l.list('').length === 0;
      return info;
    });
    const hasAssets = this.stack.some((l) => l.kind !== 'builtin' && l.enabled) || layers.some((l) => l.kind === 'builtin' && !l.empty);
    return {
      stamp: this.stamp, layers, brokenPacks: [...this.broken], vanilla, download: this.download, detecting: this.detecting, hasAssets,
      library: { profiles, pinnedId: this.versionLibrary.data.pinnedId, activeProfileId: this.settings.vanilla.enabled ? this.activeProfile?.info.id ?? null : null },
    };
  }

  get resourceStamp(): string {
    return this.stamp;
  }

  private emit(): void {
    this.opts.onChanged(this.state());
  }

  private rebuild(): void {
    if (!this.builtin) return;
    const vanilla = this.activeProfile?.info.source === 'bedrock' && this.vanillaLayer
      ? { ...this.vanillaLayer, id: VANILLA_LAYER_ID, kind: 'vanilla' as const } : this.vanillaLayer;
    this.stack = [...buildStack(this.builtin, vanilla, this.packs, this.settings), ...(this.settings.vanilla.enabled ? this.activeProfile?.overlays ?? [] : [])];
    this.stamp = this.fingerprint(this.stack, this.activeProfile?.info.id ?? this.versionLibrary.data.pinnedId ?? 'default');
    this.soundDefs.clear();
    this.soundLibraries.clear();
    this.emit();
  }

  private fingerprint(stack: ResourceLayer[], id = 'default'): string {
    return createHash('sha256').update(JSON.stringify([id, computeResourceStamp(stack)])).digest('hex').slice(0, 16);
  }

  private profileInfos(): ResourceProfileInfo[] {
    const common = this.builtin ? computeResourceStamp(buildStack(this.builtin, null, this.packs, this.settings)) : '';
    const available = [...this.profiles.values()].map(({ info, install, revision, overlays }) => ({
      ...info, missing: false,
      stamp: this.fingerprint(overlays, `${info.id}:${revision}:${common}:${this.isAuthorized(info)}`),
      ...(install ? { releaseTime: install.releaseTime, versionType: install.versionType ?? 'release' } : {}),
    }));
    const missing = this.versionLibrary.data.profiles.filter((info) => !this.profiles.has(info.id));
    return [...available, ...missing.map((info) => ({ ...info, missing: true, stamp: '' }))];
  }

  // ---- 原版层 ----

  /** 离线：探测本机游戏和下载缓存，按设置决定用哪个（不联网） */
  private async detectVanilla(): Promise<void> {
    const legacy = this.settings.vanilla.dir && await realpath(this.settings.vanilla.dir).catch(() => null);
    if (legacy && !this.versionLibrary.data.authorized.includes(legacy)) this.versionLibrary.data.authorized.push(legacy);
    const [local, cached] = await Promise.all([
      detectJavaVersions(this.opts.gameEnv, this.versionLibrary.data.authorized),
      this.opts.downloader.listCached ? this.opts.downloader.listCached().catch(() => []) : this.opts.downloader.findCached().then((entry) => entry ? [entry] : []).catch(() => []),
    ]);
    const next = new Map<string, Profile>();
    for (const [source, installs] of [['local', local], ['downloaded', cached]] as const) for (const install of installs) {
      const discovered = javaProfile(install, source);
      const remembered = source === 'local' ? this.versionLibrary.data.profiles.find((entry) => entry.source === source && entry.gameDir === install.gameDir && entry.versionId === install.versionId) : undefined;
      const info = remembered ? { ...discovered, id: remembered.id } : discovered;
      const revision = await vanillaRevision(install).catch(() => null);
      if (!revision) continue;
      const previous = this.profiles.get(info.id);
      const profile: Profile = previous?.revision === revision ? previous : { info, revision, install, overlays: [] };
      next.set(info.id, profile);
      if (source === 'downloaded' || this.isAuthorized(info)) {
        this.versionLibrary.remember(info);
        await this.refreshInstanceLayers(profile);
      }
    }
    for (const info of this.versionLibrary.data.profiles.filter((entry) => entry.source === 'bedrock')) {
      try {
        const layer = await openBedrockPack(info.sourcePath, info.id, (await stat(info.sourcePath)).isFile());
        if (!layer) continue;
        if (!info.id.startsWith(`bedrock:${layer.uuid}:`) || info.versionId !== layer.version) { layer.close(); continue; }
        const previous = this.profiles.get(info.id);
        if (previous?.revision === layer.revision) {
          next.set(info.id, previous);
          layer.close();
        } else next.set(info.id, { info, revision: layer.revision, layer: Promise.resolve(layer), overlays: [] });
      } catch { /* 缺失项保留在库里，供重新连接。 */ }
    }
    for (const [id, previous] of this.profiles) if (next.get(id) !== previous) this.closeProfile(previous);
    this.profiles.clear();
    for (const [id, profile] of next) this.profiles.set(id, profile);
    await this.versionLibrary.save().catch((error: unknown) => this.opts.log.warn('resources', 'could not save library', { error }));
    await this.applyVanilla();
  }

  private async applyVanilla(): Promise<void> {
    const pinned = this.versionLibrary.data.pinnedId;
    const want = pinned ? this.profiles.get(pinned) : [...this.profiles.values()]
      .filter(({ install }) => install && (install.versionType ?? 'release') === 'release')
      .sort((left, right) => Date.parse(right.install!.releaseTime) - Date.parse(left.install!.releaseTime))[0];
    this.vanillaLayer = null;
    this.activeProfile = null;
    this.vanillaProblem = null;
    if (this.settings.vanilla.consent !== true) return;
    if (want) {
      this.vanillaLayer = await this.profileLayer(want);
      if (this.vanillaLayer) this.activeProfile = want;
    }
    if (!this.vanillaLayer && this.settings.vanilla.enabled) this.vanillaProblem = want ? 'jar-unreadable' : 'missing';
  }

  private isAuthorized(info: SavedProfile): boolean {
    return info.source === 'local' && info.gameDir !== null && this.versionLibrary.data.authorized.includes(info.gameDir);
  }

  private profileLayer(profile: Profile): Promise<ClosableLayer | null> {
    const install = profile.install;
    if (!profile.layer && install) {
      profile.layer = openVanillaLayer(install).catch((error: unknown) => {
        this.opts.log.warn('resources', 'vanilla jar unreadable', { profile: profile.info.id, error });
        delete profile.layer;
        return null;
      });
    }
    return profile.layer ?? Promise.resolve(null);
  }

  private closeProfile(profile: Profile): void {
    void profile.layer?.then((layer) => layer?.close());
    for (const layer of profile.overlays) layer.close();
  }

  private async refreshInstanceLayers(profile: Profile): Promise<void> {
    const saved = this.versionLibrary.data.instancePacks[profile.info.id] ?? [];
    const listed = this.isAuthorized(profile.info) && saved.length ? await listInstancePacks(profile.info, saved) : [];
    const previous = profile.overlays;
    const next: ClosableLayer[] = [];
    for (const pack of listed) {
      if (!pack.enabled || pack.missing) continue;
      try {
        const directory = (await stat(pack.path)).isDirectory();
        const bedrock = await openBedrockPack(pack.path, pack.id, !directory, extname(pack.path).toLowerCase() === '.mcpack');
        const layer = bedrock ?? (directory ? await openFolderPack(pack.path, pack.id) : await openZipPack(pack.path, pack.id, pack.name));
        const old = previous.find((entry) => entry.id === layer.id && entry.revision === layer.revision);
        if (old) layer.close();
        next.push(old ?? layer);
      } catch (error) {
        this.opts.log.warn('resources', 'instance pack unavailable', { id: pack.id, error });
      }
    }
    profile.overlays = next;
    for (const layer of previous) if (!next.includes(layer)) layer.close();
  }

  selectProfile(id: string | null): Promise<ResourceState> {
    return this.serial(async () => {
      const profile = id ? this.profiles.get(id) : null;
      if (id && (!profile || !(await this.profileLayer(profile)))) return this.state();
      if (profile?.info.source === 'local' && profile.info.gameDir && !this.isAuthorized(profile.info)) this.versionLibrary.data.authorized.push(profile.info.gameDir);
      if (profile) this.versionLibrary.remember(profile.info);
      this.versionLibrary.data.pinnedId = id;
      await this.versionLibrary.save();
      await this.saveSettings({ ...this.settings, vanilla: { ...this.settings.vanilla, consent: true, enabled: true } });
      await this.applyVanilla();
      this.rebuild();
      return this.state();
    });
  }

  async instancePacks(profileId: string) {
    await this.detected;
    const info = this.profiles.get(profileId)?.info;
    return info && this.isAuthorized(info) ? listInstancePacks(info, this.versionLibrary.data.instancePacks[profileId] ?? []) : [];
  }

  setInstancePack(profileId: string, packId: string, enabled: boolean): Promise<ResourceState> {
    return this.serial(async () => {
      const profile = this.profiles.get(profileId);
      const pack = (await this.instancePacks(profileId)).find((entry) => entry.id === packId);
      if (!profile || !pack || (enabled && pack.missing)) return this.state();
      const selected = (this.versionLibrary.data.instancePacks[profileId] ?? []).filter((entry) => entry.id !== packId);
      if (enabled) selected.push({ id: pack.id, name: pack.name, path: pack.path });
      this.versionLibrary.data.instancePacks[profileId] = selected;
      await this.versionLibrary.save();
      await this.refreshInstanceLayers(profile);
      this.rebuild();
      return this.state();
    });
  }

  async locateProfile(id: string, target: ResourceLocation): Promise<string | null> {
    const info = this.profiles.get(id)?.info ?? this.versionLibrary.data.profiles.find((entry) => entry.id === id);
    if (!info) return null;
    const path = target === 'game' ? info.gameDir : target === 'packs' ? (this.isAuthorized(info) ? info.resourcePacksDir : null) : info.sourcePath;
    return path && await stat(path).then(() => true, () => false) ? path : null;
  }

  listOfficialVersions(): Promise<OfficialVersion[]> {
    return this.opts.downloader.listOfficialReleases();
  }

  detectMinecraft(): Promise<ResourceState> {
    return this.serial(async () => {
      await this.detectVanilla();
      this.rebuild();
      return this.state();
    });
  }

  setVanilla(patch: { consent?: boolean; enabled?: boolean }): Promise<ResourceState> {
    return this.serial(async () => {
      const v = { ...this.settings.vanilla, ...patch };
      if (patch.consent === true) {
        const local = [...this.profiles.values()].find((profile) => profile.info.source === 'local' && profile.install?.versionType === 'release');
        if (local?.info.gameDir && !this.isAuthorized(local.info)) {
          this.versionLibrary.data.authorized.push(local.info.gameDir);
          this.versionLibrary.remember(local.info);
          await this.versionLibrary.save();
        }
      }
      await this.saveSettings({ ...this.settings, vanilla: v });
      await this.applyVanilla();
      this.rebuild();
      return this.state();
    });
  }

  /** 用户在主进程的对话框里选了一个游戏目录 */
  useGameDir(dir: string, reconnectId?: string): Promise<ChooseGameDirResult> {
    return this.serial(async () => {
      const root = await realpath(dir).catch(() => null);
      if (!root) return { ok: false, error: 'no-release' } as const;
      const versions = await findJavaVersions(root);
      const reconnect = reconnectId ? this.versionLibrary.data.profiles.find((entry) => entry.id === reconnectId && entry.source === 'local') : null;
      const install = reconnectId ? versions.find((version) => version.versionId === reconnect?.versionId) : versions.find((version) => version.versionType === 'release') ?? versions[0];
      if (!install) return { ok: false, error: 'no-release' } as const;
      const info = javaProfile(install, 'local');
      if (reconnect) this.versionLibrary.remember({ ...info, id: reconnect.id });
      if (!this.versionLibrary.data.authorized.includes(root)) this.versionLibrary.data.authorized.push(root);
      this.versionLibrary.data.pinnedId ??= reconnect?.id ?? info.id;
      await this.saveSettings({ ...this.settings, vanilla: { ...this.settings.vanilla, dir: root, consent: true, enabled: true } });
      await this.detectVanilla();
      this.rebuild();
      return { ok: true } as const;
    });
  }

  /**
   * 联网：只在用户点了“下载原版资源”之后调用（decisions.md M2a 的联网例外）。
   * 进度按五个阶段和字节数上报（DownloadTracker，docs/decisions.md 界面增强）：取版本清单 → 下载客户端 jar →
   * 提取资源（资源索引、全景和字体对象、读 jar 的条目目录）→ 取常用音效 → 建立资源栈。失败、取消时记下停在哪一步，重试从头再走一遍
   * （已下载且校验通过的文件不重复下载）。
   */
  async downloadVanilla(versionId?: string): Promise<DownloadResult> {
    if (this.downloadAbort) return { ok: false, error: 'busy' };
    const abort = new AbortController();
    this.downloadAbort = abort;
    const tracker = new DownloadTracker();
    const publish = (force: boolean) => {
      this.download = { status: 'running', progress: tracker.snapshot() };
      const now = Date.now();
      if (force || now - this.lastProgress >= PROGRESS_INTERVAL_MS) {
        this.lastProgress = now;
        this.emit();
      } else {
        // 节流掉的这一次在间隔结束时补发，免得下载停住时界面停在旧的进度上
        this.progressTimer ??= setTimeout(() => {
          this.progressTimer = null;
          this.lastProgress = Date.now();
          if (this.download.status === 'running') {
            this.download = { status: 'running', progress: tracker.snapshot() };
            this.emit();
          }
        }, PROGRESS_INTERVAL_MS);
      }
    };
    const onProgress = (p: unknown) => {
      const before = tracker.stage;
      const activity = tracker.activity;
      if (!tracker.event(p)) {
        this.opts.log.warn('resources', 'malformed download progress ignored', { progress: p });
        return;
      }
      publish(tracker.stage !== before || tracker.activity !== activity);
    };
    const step = (stage: Parameters<DownloadTracker['enter']>[0], activity: Parameters<DownloadTracker['enter']>[1]) => {
      tracker.enter(stage, activity);
      publish(true);
    };
    publish(true);
    try {
      const options = { signal: abort.signal, onProgress, includePanorama: true, includeFonts: true };
      const cached = versionId ? await this.opts.downloader.downloadRelease(versionId, options) : await this.opts.downloader.downloadLatest(options);
      // 提取资源：读 jar 的条目目录（jar 整体保留、不解包），打不开的 jar 在这里就报出来
      step('extract', 'scan');
      const probe = await openVanillaLayer(cached);
      probe.close();
      if (abort.signal.aborted) throw new DownloadError('已取消', 'aborted');
      // 同一次下载里取回音效事件用到的对象（decisions.md M6b）：之后不再按需联网
      step('sounds', 'sounds-list');
      const sounds = await this.opts.downloader.fetchSoundObjects(cached, SOUND_EVENTS, { signal: abort.signal, onProgress });
      this.opts.log.info('resources', 'vanilla downloaded', { version: cached.versionId, soundObjects: sounds.fetched, soundsMissing: sounds.missing.slice(0, 20) });
      step('finalize', 'stack');
      await this.serial(async () => {
        if (abort.signal.aborted) throw new DownloadError('已取消', 'aborted');
        const info = javaProfile(cached, 'downloaded');
        this.versionLibrary.remember(info);
        if (this.versionLibrary.data.pinnedId === null) {
          if (versionId) this.versionLibrary.data.pinnedId = info.id;
          await this.saveSettings({ ...this.settings, vanilla: { ...this.settings.vanilla, consent: true, enabled: true } });
        }
        const revision = await vanillaRevision(cached);
        const old = this.profiles.get(info.id);
        if (old?.revision !== revision) {
          if (old) this.closeProfile(old);
          this.profiles.set(info.id, { info, revision, install: cached, overlays: [] });
        }
        await this.versionLibrary.save();
        await this.applyVanilla();
        tracker.complete();
        this.download = { status: 'done', progress: tracker.snapshot() };
        this.rebuild();
      });
      return { ok: true };
    } catch (error) {
      if (abort.signal.aborted) {
        this.opts.log.info('resources', 'vanilla download canceled', { stage: tracker.stage });
        tracker.stop('canceled');
        this.download = { status: 'canceled', progress: tracker.snapshot(), ...(versionId ? { requestedVersion: versionId } : {}) };
        this.emit();
        return { canceled: true };
      }
      const kind = downloadErrorKind(error);
      this.opts.log.warn('resources', 'vanilla download failed', { kind, stage: tracker.stage, error });
      tracker.stop('failed');
      this.download = { status: 'failed', error: kind, progress: tracker.snapshot(), ...(versionId ? { requestedVersion: versionId } : {}) };
      this.emit();
      return { ok: false, error: kind };
    } finally {
      this.downloadAbort = null;
      if (this.progressTimer) clearTimeout(this.progressTimer);
      this.progressTimer = null;
    }
  }

  cancelDownload(): void {
    this.downloadAbort?.abort();
  }

  // ---- 资源包 ----

  private async openPacks(): Promise<void> {
    for (const l of this.packs.values()) l.close();
    this.packs.clear();
    this.broken = [];
    for (const p of this.settings.packs) {
      try {
        const layer = await this.openPack(p.id, p.name, p.source);
        this.packs.set(p.id, layer);
      } catch (error) {
        const problem: BrokenPack['problem'] = error instanceof ZipRejectedError ? 'rejected' : (error as { code?: string }).code === 'ENOENT' ? 'missing' : 'unreadable';
        this.opts.log.warn('resources', 'pack unavailable', { id: p.id, problem });
        this.broken.push({ id: p.id, name: p.name, problem });
      }
    }
  }

  private async openPack(id: string, name: string, source: ResourceStackSettings['packs'][number]['source']): Promise<ClosableLayer> {
    if (source.kind === 'zip') {
      const file = packZipPath(this.opts.userDataDir, source.file);
      if (!file) throw new ZipRejectedError('bad pack file name');
      return openZipPack(file, id, name);
    }
    const layer = await openFolderPack(source.path, id);
    return { ...layer, name };
  }

  /** 添加 zip 或文件夹形式的资源包（路径来自主进程的对话框或拖放） */
  addPackFromPath(path: string, reconnectId?: string): Promise<AddPackResult> {
    return this.serial(async () => {
      const st = await stat(path).catch(() => null);
      if (!st) return { ok: false, error: 'unreadable' } as const;
      const canonical = await realpath(path).catch(() => null);
      if (!canonical) return { ok: false, error: 'unreadable' } as const;
      const archive = packArchiveType(path);
      if (st.isDirectory() || (st.isFile() && archive)) {
        try {
          const probe = await openBedrockPack(canonical, 'probe', st.isFile(), archive === 'mcpack' || Boolean(reconnectId));
          if (probe) {
            const { uuid, version, name } = probe;
            probe.close();
            const previous = reconnectId ? this.versionLibrary.data.profiles.find((entry) => entry.id === reconnectId && entry.source === 'bedrock') : null;
            if (reconnectId && (!previous || previous.versionId !== version || !reconnectId.startsWith(`bedrock:${uuid}:`))) return { ok: false, error: 'unsupported' } as const;
            const id = previous?.id ?? `bedrock:${uuid}:${sourceId('bedrock', canonical, version).split(':')[1]}`;
            const layer = await openBedrockPack(canonical, id, st.isFile());
            if (!layer) return { ok: false, error: 'unreadable' } as const;
            const info: SavedProfile = { id, source: 'bedrock', name, versionId: version, gameDir: null, resourcePacksDir: null, sourcePath: canonical };
            this.versionLibrary.remember(info);
            await this.versionLibrary.save();
            const old = this.profiles.get(id);
            if (old) this.closeProfile(old);
            this.profiles.set(id, { info, revision: layer.revision, layer: Promise.resolve(layer), overlays: [] });
            await this.applyVanilla();
            this.rebuild();
            return { ok: true, id, warnings: [...(layer.warnings ?? [])].slice(0, 20) } as const;
          }
        } catch (error) {
          if (error instanceof EncryptedPackError) return { ok: false, error: 'encrypted' } as const;
          if (error instanceof ZipRejectedError) return { ok: false, error: 'rejected' } as const;
          return { ok: false, error: 'unreadable' } as const;
        }
      }
      let entry: ResourceStackSettings['packs'][number];
      let layer: ClosableLayer;
      if (st.isDirectory()) {
        const id = `folder:${randomUUID()}`;
        const name = basename(path);
        try {
          layer = await openFolderPack(path, id);
        } catch (error) {
          this.opts.log.warn('resources', 'folder pack unreadable', { error });
          return { ok: false, error: 'unreadable' } as const;
        }
        layer = { ...layer, name };
        entry = { id, name, source: { kind: 'folder', path }, enabled: true };
      } else if (st.isFile() && archive === 'zip') {
        let imported;
        try {
          imported = await importZipPack(path, this.opts.userDataDir);
        } catch (error) {
          if (error instanceof ZipRejectedError) {
            this.opts.log.warn('resources', 'zip pack rejected', { reason: error.message });
            return { ok: false, error: 'rejected', detail: error.message.slice(0, 200) } as const;
          }
          this.opts.log.warn('resources', 'zip pack unreadable', { error });
          return { ok: false, error: 'unreadable' } as const;
        }
        const id = `zip:${imported.sha256.slice(0, 16)}`;
        const existing = this.settings.packs.find((p) => p.id === id);
        if (existing) return { ok: true, id, warnings: [] } as const;
        const name = basename(path).replace(/\.zip$/i, '');
        layer = await openZipPack(imported.path, id, name);
        entry = { id, name, source: { kind: 'zip', file: imported.file }, enabled: true };
      } else {
        return { ok: false, error: 'unsupported' } as const;
      }
      this.packs.set(entry.id, layer);
      // 新包放在最上面
      await this.saveSettings({ ...this.settings, packs: [...this.settings.packs, entry] });
      this.rebuild();
      return { ok: true, id: entry.id, warnings: [...(layer.warnings ?? [])].slice(0, 20) } as const;
    });
  }

  removeLayer(id: string): Promise<ResourceState> {
    const owner = this.activeProfile?.overlays.some((layer) => layer.id === id) ? this.activeProfile : null;
    if (owner) return this.setInstancePack(owner.info.id, id, false);
    return this.serial(async () => {
      if (id === VANILLA_LAYER_ID) {
        await this.saveSettings({ ...this.settings, vanilla: { ...this.settings.vanilla, consent: false } });
        await this.applyVanilla();
      } else {
        const entry = this.settings.packs.find((p) => p.id === id);
        if (!entry) return this.state();
        this.packs.get(id)?.close();
        this.packs.delete(id);
        this.broken = this.broken.filter((b) => b.id !== id);
        const packs = this.settings.packs.filter((p) => p.id !== id);
        await this.saveSettings({ ...this.settings, packs });
        // 应用数据目录里的 zip 副本没人用了就删掉
        if (entry.source.kind === 'zip' && !packs.some((p) => p.source.kind === 'zip' && p.source.file === (entry.source as { file: string }).file)) {
          const file = packZipPath(this.opts.userDataDir, entry.source.file);
          if (file) await rm(file, { force: true }).catch(() => undefined);
        }
      }
      this.rebuild();
      return this.state();
    });
  }

  /** 资源包的新顺序（从下往上）；没列出的保持原来的相对顺序放在最上面 */
  reorder(idsBottomToTop: readonly string[]): Promise<ResourceState> {
    return this.serial(async () => {
      const rank = new Map(idsBottomToTop.map((id, i) => [id, i]));
      const listed = this.settings.packs.filter((p) => rank.has(p.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
      const rest = this.settings.packs.filter((p) => !rank.has(p.id));
      await this.saveSettings({ ...this.settings, packs: [...listed, ...rest] });
      this.rebuild();
      return this.state();
    });
  }

  setEnabled(id: string, enabled: boolean): Promise<ResourceState> {
    if (id === VANILLA_LAYER_ID) return this.setVanilla({ enabled });
    const owner = this.activeProfile?.overlays.some((layer) => layer.id === id) ? this.activeProfile : null;
    if (owner) return this.setInstancePack(owner.info.id, id, enabled);
    return this.serial(async () => {
      if (id === BUILTIN_LAYER_ID) return this.state();
      await this.saveSettings({ ...this.settings, packs: this.settings.packs.map((p) => (p.id === id ? { ...p, enabled } : p)) });
      this.rebuild();
      return this.state();
    });
  }

  /** 窗口重新获得焦点时重扫文件夹形式的资源包（3.5）；内容有变化才通知 */
  rescanFolders(): Promise<void> {
    return this.serial(async () => {
      let changed = false;
      for (const p of this.settings.packs) {
        if (p.source.kind !== 'folder') continue;
        const old = this.packs.get(p.id);
        try {
          const layer = { ...(await openFolderPack(p.source.path, p.id)), name: p.name };
          if (!old || old.revision !== layer.revision) {
            this.packs.set(p.id, layer);
            this.broken = this.broken.filter((b) => b.id !== p.id);
            changed = true;
          }
        } catch {
          if (old) {
            this.packs.delete(p.id);
            this.broken = [...this.broken.filter((b) => b.id !== p.id), { id: p.id, name: p.name, problem: 'missing' }];
            changed = true;
          }
        }
      }
      for (const profile of this.profiles.values()) {
        if (this.isAuthorized(profile.info) && (this.versionLibrary.data.instancePacks[profile.info.id]?.length ?? 0) > 0) {
          const before = computeResourceStamp(profile.overlays);
          await this.refreshInstanceLayers(profile);
          changed ||= computeResourceStamp(profile.overlays) !== before;
        }
      }
      if (changed) this.rebuild();
    });
  }

  // ---- 读取（渲染进程经 IPC 调用；路径已经过 isSafeRelativePath 校验） ----

  private async stackFor(profileId?: string): Promise<ResourceLayer[]> {
    if (profileId === undefined) return this.stack;
    await this.detected;
    const profile = this.profiles.get(profileId);
    if (!this.builtin) return [];
    const allowed = profile && (profile.info.source !== 'local' || this.isAuthorized(profile.info));
    const layer = allowed ? await this.profileLayer(profile) : null;
    const [base, ...packs] = buildStack(this.builtin, null, this.packs, this.settings);
    return [base!, ...(layer ? [layer] : []), ...packs, ...(allowed ? profile.overlays : [])];
  }

  async read(path: string, profileId?: string): Promise<Uint8Array | null> {
    return (await readResource(await this.stackFor(profileId), path))?.data ?? null;
  }

  /** 贴图 PNG 和与它来自同一层的 .mcmeta（游戏的规则：元数据跟着胜出的那张图走） */
  async readTexture(id: string, profileId?: string): Promise<{ png: Uint8Array; mcmeta: string | null } | null> {
    const path = textureIdToPath(id);
    if (!path) return null;
    const stack = await this.stackFor(profileId);
    for (let i = stack.length - 1; i >= 0; i--) {
      const layer = stack[i];
      if (!layer?.enabled || !layer.has(path)) continue;
      const png = await layer.read(path).catch(() => null);
      if (!png) continue;
      const metaPath = textureMetaPath(path);
      const meta = layer.has(metaPath) ? await layer.read(metaPath).catch(() => null) : null;
      return { png, mcmeta: meta && meta.byteLength <= 65_536 ? new TextDecoder().decode(meta) : null };
    }
    return null;
  }

  async list(prefix: string, profileId?: string): Promise<string[]> {
    return listMerged(await this.stackFor(profileId), prefix).slice(0, 10_000);
  }

  /** 资源栈里的字体定义（3.9）：各层合并、展开 reference；没有任何层提供时为 null */
  private async fontDefinitions(stack: ResourceLayer[], fontId: string) {
    let found = false;
    const { providers, skipped } = await resolveFontProviders(fontId, async (path) => {
      const layers = layersWith(stack, path);
      if (layers.length === 0) return null;
      found = true;
      const out = [];
      for (const layer of layers) {
        const bytes = await layer.read(path).catch(() => null);
        if (bytes && bytes.byteLength <= 4 * 1024 * 1024) out.push(parseFontJson(new TextDecoder().decode(bytes)));
      }
      return out;
    });
    if (!found) return null;
    return { providers, skipped };
  }

  async fontIds(profileId?: string): Promise<string[]> {
    const stack = (await this.stackFor(profileId)).filter((layer) => layer.kind !== 'builtin');
    const candidates = listMerged(stack, 'assets/').flatMap((path) => fontPathToId(path) ?? []).slice(0, 1024);
    const ids: string[] = [];
    for (const id of candidates) {
      if (normalizeRequestedFont(id) !== id) continue;
      const def = await this.fontDefinitions(stack, id);
      if (def?.providers.some((provider) => provider.type === 'space' || resolveLayer(stack, provider.file))) ids.push(id);
    }
    return ids;
  }

  async fontProviders(fontId: string, profileId?: string): Promise<FontProvidersResult | null> {
    const stack = (await this.stackFor(profileId)).filter((layer) => layer.kind !== 'builtin');
    const definition = await this.fontDefinitions(stack, normalizeRequestedFont(fontId));
    if (!definition) return null;
    const providers: FontProvidersResult['providers'] = [];
    const { skipped } = definition;
    let archives = 0;
    for (const provider of definition.providers) {
      if (provider.type === 'space') providers.push({ type: 'space', advances: [...provider.advances] });
      else if (provider.type === 'unihex') {
        if (++archives > 4) continue;
        const raw = await readResource(stack, provider.file);
        const tables = raw ? await readUnihexArchive(raw.data, provider.overrides).catch(() => null) : null;
        if (tables) providers.push({ type: 'unihex', tables });
        else skipped.push(`undecodable(${provider.file})`);
      } else if (resolveLayer(stack, provider.file)) providers.push(provider);
      else skipped.push(`missing(${provider.file})`);
    }
    return { providers, skipped: skipped.slice(0, 256) };
  }

  private readonly soundDefs = new Map<string, ReturnType<typeof buildSoundCatalog>>();

  private soundDefinitions(stack: ResourceLayer[], profileId?: string) {
    const key = this.fingerprint(stack, profileId);
    let catalog = this.soundDefs.get(key);
    if (!catalog) {
      catalog = buildSoundCatalog(stack);
      this.soundDefs.set(key, catalog);
      void catalog.catch(() => { if (this.soundDefs.get(key) === catalog) this.soundDefs.delete(key); });
    }
    return catalog;
  }

  /**
   * 音效事件的全部变体（02-engine.md 2.10、03-assets.md 3.8）：资源栈各层的 sounds.json 合并后展开 event 引用。
   * 资源栈里没有这个事件时为 null。不联网：下载缓存的原版层只读已经取回的对象（decisions.md M6b）。
   */
  async soundVariants(eventId: string, profileId?: string): Promise<SoundVariantInfo[] | null> {
    return (await this.soundDefinitions(await this.stackFor(profileId), profileId)).variants(eventId);
  }

  async readSound(file: string, profileId?: string): Promise<Uint8Array | null> {
    const source = findSoundFile(await this.stackFor(profileId), file);
    return source ? source.layer.read(source.path).catch(() => null) : null;
  }

  async fetchSoundNames(): Promise<void> {
    const stack = await this.stackFor();
    if (!this.isDownloaded()) return;
    const objects = await missingSoundNameObjects(stack);
    try {
      for (const { hash, size } of objects) await this.opts.downloader.fetchObject(hash, size);
    } finally {
      this.soundDefs.clear();
      this.soundLibraries.clear();
    }
  }

  /** 音效名在资源栈里的状态；按 .ogg、.wav 的顺序找胜出的那一层 */
  private async soundFileState(file: string, stack: ResourceLayer[], downloaded: boolean): Promise<{ state: SoundFileState; remote?: { hash: string; size: number } }> {
    const source = findSoundFile(stack, file);
    if (!source) return { state: 'missing' };
    const remote = await (source.layer as ClosableLayer).remoteObject?.(source.path);
    if (!remote) return { state: 'local' };
    return downloaded ? { state: 'remote', remote } : { state: 'missing' };
  }

  private readonly soundLibraries = new Map<string, Promise<SoundLibrary>>();

  /**
   * 音效选择器的库（decisions.md M6b）：资源栈里每个命名空间的 sounds.json 合并后的全部事件，带可用状态。
   * 按 stamp 缓存；按需取回音效对象后重算。没有任何素材层时为空。
   */
  async soundLibrary(profileId?: string): Promise<SoundLibrary> {
    const stack = await this.stackFor(profileId);
    const stamp = profileId === undefined ? this.stamp : this.fingerprint(stack, profileId);
    const cached = this.soundLibraries.get(stamp);
    if (cached) return cached;
    const downloaded = this.isDownloaded(profileId);
    const library = (async () => {
      const catalog = await this.soundDefinitions(stack, profileId);
      const events = await catalog.items(async (file) => (await this.soundFileState(file, stack, downloaded)).state);
      const namesDownloadable = downloaded && (await missingSoundNameObjects(stack)).length > 0;
      return { stamp, namesDownloadable, events: events.sort((first, second) => first.id.localeCompare(second.id)) };
    })();
    this.soundLibraries.set(stamp, library);
    library.catch(() => this.soundLibraries.delete(stamp));
    return library;
  }

  private isDownloaded(profileId?: string): boolean {
    return (profileId === undefined ? this.activeProfile : this.profiles.get(profileId))?.info.source === 'downloaded';
  }

  /**
   * 音效文件的状态；fetch 为真时先把 remote 的取回来（联网，只经 fetchObject：白名单、sha1 和大小校验不变）。
   * 只在用户试听、选中某个音效，或在导出前确认取回时由渲染进程调用；不做后台批量下载（decisions.md M6b）。
   */
  async soundFiles(files: readonly string[], fetch: boolean, profileId?: string): Promise<SoundFilesResult> {
    const stack = await this.stackFor(profileId);
    const downloaded = this.isDownloaded(profileId);
    const states: Record<string, SoundFileState> = {};
    let failed: DownloadErrorKind | null = null;
    let fetched = false;
    for (const file of new Set(files)) {
      const s = await this.soundFileState(file, stack, downloaded);
      if (s.state === 'remote' && fetch && s.remote && !failed) {
        try {
          await this.opts.downloader.fetchObject(s.remote.hash, s.remote.size);
          states[file] = 'local';
          fetched = true;
          continue;
        } catch (e) {
          failed = downloadErrorKind(e);
          this.opts.log.warn('resources', 'sound object fetch failed', { file, kind: failed });
        }
      }
      states[file] = s.state;
    }
    if (fetched) {
      this.soundLibraries.clear();
      this.opts.log.info('resources', 'sound objects fetched on demand', { count: Object.values(states).filter((s) => s === 'local').length });
    }
    return failed ? { ok: false, error: failed, states } : { ok: true, states };
  }

  close(): void {
    this.cancelDownload();
    this.builtin?.close();
    for (const profile of this.profiles.values()) this.closeProfile(profile);
    for (const l of this.packs.values()) l.close();
  }
}
