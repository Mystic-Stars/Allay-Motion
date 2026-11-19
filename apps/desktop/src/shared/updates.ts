import { z } from 'zod';

// 自动更新（docs/decisions.md“自动更新”）：主进程和渲染进程共用的设置、状态 schema，以及不依赖 Electron 的纯逻辑。
// 更新源是 GitHub 和 GitCode 的 Release；时区在中国大陆时“自动”选 GitCode 镜像。

export const UPDATE_REPO = 'Mystic-Stars/Allay-Motion';

/**
 * - auto：自动检查，有新版本就在后台下载，下载完提示重启安装；
 * - notify：自动检查，有新版本时提示，由用户决定是否下载；
 * - off：不自动检查，只在设置页手动检查。
 */
export const UPDATE_MODES = ['auto', 'notify', 'off'] as const;
export const UpdateModeSchema = z.enum(UPDATE_MODES);
export type UpdateMode = z.infer<typeof UpdateModeSchema>;

/** auto：按时区选（中国大陆用 GitCode，其他地区用 GitHub） */
export const UPDATE_SOURCE_PREFS = ['auto', 'github', 'gitcode'] as const;
export const UpdateSourcePrefSchema = z.enum(UPDATE_SOURCE_PREFS);
export type UpdateSourcePref = z.infer<typeof UpdateSourcePrefSchema>;
export type UpdateSource = Exclude<UpdateSourcePref, 'auto'>;

export const UPDATE_CHANNELS = ['codex', 'main', 'dev'] as const;
export const UpdateChannelSchema = z.enum(UPDATE_CHANNELS);
export type UpdateChannel = z.infer<typeof UpdateChannelSchema>;

const VersionSchema = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/).max(64);

export const UpdatePrefsSchema = z.strictObject({
  mode: UpdateModeSchema.catch('auto'),
  source: UpdateSourcePrefSchema.catch('auto'),
  channel: UpdateChannelSchema.catch('main'),
  /** “跳过这个版本”：自动检查时不再提示这个版本（手动检查照常显示） */
  skipVersion: VersionSchema.nullable().catch(null),
});
export type UpdatePrefs = z.infer<typeof UpdatePrefsSchema>;

export function defaultUpdatePrefs(): UpdatePrefs {
  return { mode: 'auto', source: 'auto', channel: 'main', skipVersion: null };
}

/** 渲染进程发来的修改：整体替换；旧客户端省略渠道时仍使用正式版 */
export const UpdatePrefsPatchSchema = z.strictObject({
  mode: UpdateModeSchema,
  source: UpdateSourcePrefSchema,
  channel: UpdateChannelSchema.optional(),
  skipVersion: VersionSchema.nullable(),
}).transform(({ channel, skipVersion, ...prefs }): UpdatePrefs => ({
  ...prefs,
  channel: channel ?? 'main',
  skipVersion: channel && skipVersion && channelVersion(`v${skipVersion}`, channel) === null ? null : skipVersion,
}));

// ---- 状态（主进程 → 渲染进程）----

export const UPDATE_STATUSES = ['idle', 'checking', 'up-to-date', 'available', 'downloading', 'downloaded', 'error', 'unsupported'] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

/** space：临时文件夹所在的磁盘不够安装用（见 INSTALL_TEMP_SPACE_MB） */
export const UPDATE_ERRORS = ['network', 'no-release', 'no-asset', 'checksum', 'install', 'disk', 'space'] as const;
export type UpdateErrorCode = (typeof UPDATE_ERRORS)[number];

export interface UpdateRelease {
  version: string;
  tag: string;
  /** 实际取到这个版本的源 */
  source: UpdateSource;
  publishedAt: string | null;
  /** 这台机器要下载的安装包 */
  asset: { name: string; size: number };
}

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  channel: UpdateChannel;
  /** 按设置和时区实际首选的源 */
  preferredSource: UpdateSource;
  latest: UpdateRelease | null;
  progress: { received: number; total: number } | null;
  error: UpdateErrorCode | null;
  /** 上次检查完成的时间（毫秒） */
  checkedAt: number | null;
  /**
   * 界面要不要弹通知：自动检查发现了没被跳过的新版本（notify 模式），或后台下载完成（auto 模式）。
   * 手动检查的结果只在设置页里显示
   */
  announce: boolean;
}

// ---- 纯逻辑 ----

/** 中国大陆的 IANA 时区（含旧别名）。港澳台不算：GitHub 在那里可以直接用 */
const MAINLAND_TIME_ZONES = new Set(['Asia/Shanghai', 'Asia/Chongqing', 'Asia/Chungking', 'Asia/Harbin', 'Asia/Urumqi', 'Asia/Kashgar', 'PRC']);

export function isMainlandChinaTimeZone(timeZone: string | undefined): boolean {
  return timeZone !== undefined && MAINLAND_TIME_ZONES.has(timeZone);
}

export function resolveUpdateSource(pref: UpdateSourcePref, timeZone: string | undefined): UpdateSource {
  if (pref !== 'auto') return pref;
  return isMainlandChinaTimeZone(timeZone) ? 'gitcode' : 'github';
}

export function otherSource(source: UpdateSource): UpdateSource {
  return source === 'github' ? 'gitcode' : 'github';
}

/** 去掉标签前的 v；不是语义化版本时为 null */
export function versionFromTag(tag: string): string | null {
  const v = tag.startsWith('v') ? tag.slice(1) : tag;
  return VersionSchema.safeParse(v).success ? v : null;
}

const CHANNEL_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(codex|dev)\.(0|[1-9]\d*))?$/;

export function channelVersion(tag: string, channel: UpdateChannel): string | null {
  const match = CHANNEL_TAG.exec(tag);
  return match?.[0] === tag && (match[4] ?? 'main') === channel ? versionFromTag(tag) : null;
}

/** 语义化版本比较：a 比 b 新时为正数 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const suffix = v.indexOf('-');
    const core = suffix < 0 ? v : v.slice(0, suffix);
    return { nums: core.split('.'), pre: suffix < 0 ? null : v.slice(suffix + 1) };
  };
  const numericOrder = (left: string, right: string) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0);
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    const d = numericOrder(x.nums[i] ?? '0', y.nums[i] ?? '0');
    if (d !== 0) return d;
  }
  // 同一个核心版本：正式版比预发布版新
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  const xp = x.pre.split('.');
  const yp = y.pre.split('.');
  for (let i = 0; i < Math.max(xp.length, yp.length); i++) {
    const p = xp[i];
    const q = yp[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      const order = numericOrder(p, q);
      if (order !== 0) return order;
    }
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * 这台机器该下载哪个附件（名字由发版工作流定，见 .github/workflows/release.yml）：
 * Windows x64 的 NSIS 安装包、macOS 对应架构的 dmg。其他平台没有安装包，返回 null。
 */
export function assetPattern(platform: string, arch: string): RegExp | null {
  if (platform === 'win32' && arch === 'x64') return /-x64-setup\.exe$/;
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return new RegExp(`-${arch}\\.dmg$`);
  return null;
}

export const CHECKSUMS_ASSET = 'SHA256SUMS.txt';

/**
 * Windows 安装程序要的临时空间（MB）：electron-builder 的安装程序先把整个应用解压进临时文件夹再复制进安装目录，
 * 空间不够时会装出半截、打不开的应用（docs/decisions.md“安装时临时空间不足”）。
 * 安装程序自己在启动时按这个数检查（scripts/dist-extras.ts），应用内更新在启动安装程序之前也按它检查
 */
export const INSTALL_TEMP_SPACE_MB = 1024;

/** 下载目录里的安装包或半成品：版本号不比当前新的可以删 */
export function staleDownload(name: string, currentVersion: string): boolean {
  if (name.endsWith('.part')) return true;
  const m = /-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)-(?:x64|arm64)/.exec(name);
  return m ? compareVersions(m[1]!, currentVersion) <= 0 : false;
}

/** SHA256SUMS.txt：每行“<64 位十六进制>  <文件名>” */
export function parseChecksums(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) out.set(m[2]!, m[1]!.toLowerCase());
  }
  return out;
}

/** 两个平台的 Release 接口（GitHub REST、GitCode v5）里本应用用到的字段，两边格式一致 */
export const ReleaseJsonSchema = z.looseObject({
  tag_name: z.string().min(1).max(128),
  name: z.string().max(512).nullish(),
  body: z.string().max(200_000).nullish(),
  draft: z.boolean().nullish(),
  prerelease: z.boolean().nullish(),
  published_at: z.string().max(64).nullish(),
  created_at: z.string().max(64).nullish(),
  assets: z
    .array(
      z.looseObject({
        name: z.string().min(1).max(256),
        browser_download_url: z.string().max(2048),
        size: z.number().int().nonnegative().nullish(),
        /** GitCode 的源码包 type 是 source，上传的附件是 attach；GitHub 没有这个字段 */
        type: z.string().nullish(),
      }),
    )
    .max(200)
    .default([]),
});
export type ReleaseJson = z.infer<typeof ReleaseJsonSchema>;
