// 模板的来源、安装、卸载、导出与派生（docs/04-templates.md 4.7–4.9；01-product-architecture.md 1.8、1.9）。
//
// 两个来源走同一条装载路径（读包 → 校验 manifest → 解析派生 → 交给渲染进程的引擎）：
// - 内置：resources/templates/*.allaytpl，只读。跳过 4.8 的第 1、3 步（构建时已保证），其余与用户模板相同。
// - 用户：userData/templates/<id>/<version>/，里面是解压后的包内容；安装元数据在旁边的 <version>.meta.json。
//
// 安装分两段：stage（第 1–3 步，解压到 templates/.staging/<uuid>/）→ 渲染进程试运行（第 4 步）→ commit（第 6 步，改名就位）。
// 渲染进程交来的只有暂存 ID 和试运行的警告，路径都由主进程决定（1.6 第 6 条）。
import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  DeriveError,
  TEMPLATE_ID_RE,
  compareVersionStrings,
  isSafeAssetPath,
  isReservedId,
  parseManifest,
  type TemplateDiagnostic,
  pickVersion,
  resolveDerived,
  resolveScript,
  sanitizeParams,
  studioMaterialRefs,
  type ResolvedTemplate,
  type TemplateManifest,
} from '@allay/template-sdk';
import { z } from 'zod';
import type { SourceReadResult, WriteResult } from '@allay/host-api';
import { MAX_SOURCE_MANIFEST_BYTES, type FreezeCompositionRequest, type WriteSourceRequest } from '../../shared/template-authoring';
import {
  InstallReportSchema,
  type CommitResult,
  type InstallReport,
  type SaveDerivedRequest,
  type StageResult,
  type TemplateBundle,
  type TemplateEntry,
  type TemplateSourceKind,
  type TrialWarning,
} from '../../shared/templates';
import type { Logger } from '../logger';
import { writeJsonAtomic } from '../settings-store';
import { PackageError, readPackage } from './package-reader';
import { writeZip } from './zip-writer';
import { ensureTemplateParent, readRegular, readSourceFiles, replaceSourceFiles, safeTemplateDir, validateSource } from './source-files';
import { CompositionLibrary, freezeComposition } from './composition-package';

const removedBuiltinIds = new Set([
  'allay.builtin.furnace-smelt', 'allay.builtin.single-chest',
  studioMaterialRefs.object.id, studioMaterialRefs.player.id,
]);

/** 暂存的包多久没提交就作废 */
const STAGING_TTL_MS = 10 * 60 * 1000;

interface Stored {
  source: TemplateSourceKind;
  manifest: TemplateManifest;
  /** 内置模板：包内容在内存里；用户模板：从目录按需读 */
  files: Map<string, Uint8Array> | null;
  dir: string | null;
  trialWarnings: TrialWarning[];
}

interface Staged {
  dir: string;
  manifest: TemplateManifest;
  code: string | null;
  expires: number;
  /** 确定性静态规则的提示（H12），提交时并进警告 */
  ruleDiagnostics: TemplateDiagnostic[];
}

const MetaSchema = z.looseObject({ formatVersion: z.literal(1), installedAt: z.string(), trialWarnings: z.array(z.string()) });

export type AssetSource = { id: string; version: string } | { stagingId: string };

export interface TemplateServiceOptions {
  /** 内置模板包所在目录（resources/templates） */
  builtinDir: string;
  /** userData 目录 */
  userDataDir: string;
  appVersion: string;
  log: Logger;
  now?: () => number;
}

const key = (id: string, version: string) => `${id}@${version}`;

/** 包住对用户模板目录的写入（模板开发模式的监视服务用它认出应用自己的写入，H10） */
export type TemplateWriteGuard = <T>(id: string, version: string, fn: () => Promise<T>) => Promise<T>;
const passthrough: TemplateWriteGuard = (_id, _version, fn) => fn();

export class TemplateService {
  private readonly templates = new Map<string, Stored>();
  private readonly staged = new Map<string, Staged>();
  private readonly editable = new Set<string>();
  private readonly userDir: string;
  private readonly stagingDir: string;
  readonly compositionLibrary: CompositionLibrary;
  private readonly now: () => number;
  /** 写操作串行：安装、删除、派生不交错 */
  private queue: Promise<unknown> = Promise.resolve();
  private guard: TemplateWriteGuard = passthrough;

  constructor(private readonly opts: TemplateServiceOptions) {
    this.userDir = join(opts.userDataDir, 'templates');
    this.stagingDir = join(this.userDir, '.staging');
    this.compositionLibrary = new CompositionLibrary(join(opts.userDataDir, 'composition-templates'));
    this.now = opts.now ?? Date.now;
  }

  /** 之后对用户模板目录的写入都经过它 */
  setWriteGuard(guard: TemplateWriteGuard | null): void {
    this.guard = guard ?? passthrough;
  }

  /** 用户模板的文件夹（不检查是否存在）；内置模板没有文件夹 */
  userTemplateDir(id: string, version: string): string | null {
    const s = this.templates.get(key(id, version));
    return s?.source === 'user' ? s.dir : null;
  }

  async init(): Promise<void> {
    await mkdir(this.userDir, { recursive: true });
    if (!(await lstat(this.userDir)).isDirectory()) throw new Error('invalid template root');
    await rm(this.stagingDir, { recursive: true, force: true });
    await this.loadBuiltins();
    await this.scanUser();
  }

  // ---- 读 ----

  list(): TemplateEntry[] {
    const out: TemplateEntry[] = [];
    for (const s of this.templates.values()) out.push(this.entryOf(s));
    return out.sort((a, b) => (a.source === b.source ? 0 : a.source === 'builtin' ? -1 : 1) || a.id.localeCompare(b.id) || compareVersionStrings(a.version, b.version));
  }

  /** 装载需要的一切；不存在或派生模板的基模板缺失时返回 null */
  async read(id: string, version: string): Promise<TemplateBundle | null> {
    return this.serial(() => this.readBundle(id, version));
  }

  private async readBundle(id: string, version: string): Promise<TemplateBundle | null> {
    const s = this.templates.get(key(id, version));
    if (!s) return null;
    const resolved = this.resolve(s.manifest);
    if (!resolved) return null;
    const codeOwner = this.templates.get(key(resolved.codeFrom.id, resolved.codeFrom.version));
    if (!codeOwner) return null;
    const bytes = await this.readFile(codeOwner, 'template.js');
    if (!bytes) return null;
    return { entry: this.entryOf(s), resolved, code: new TextDecoder().decode(bytes) };
  }

  /**
   * 模板包 assets/ 里的文件（asset: 引用）。派生模板先找自己的，再找基模板的。
   * 暂存的包（试运行时）也能读。
   */
  async readAsset(source: AssetSource, path: string): Promise<Uint8Array | null> {
    if (!isSafeAssetPath(path)) return null;
    const rel = `assets/${path}`;
    if ('stagingId' in source) {
      const st = this.staged.get(source.stagingId);
      if (!st) return null;
      const own = await readInside(st.dir, rel);
      if (own || !st.manifest.extends) return own;
      const base = this.resolveBase(st.manifest);
      return base ? this.readFile(base, rel) : null;
    }
    const s = this.templates.get(key(source.id, source.version));
    if (!s) return null;
    const own = await this.readFile(s, rel);
    if (own || !s.manifest.extends) return own;
    const base = this.resolveBase(s.manifest);
    return base ? this.readFile(base, rel) : null;
  }

  // ---- 安装（4.8）----

  /** 第 1–3 步，解压到暂存区。失败返回错误码 */
  stage(file: string): Promise<StageResult> {
    return this.serial(async () => {
      this.dropExpired();
      let pkg;
      try {
        pkg = await readPackage(file, { appVersion: this.opts.appVersion });
      } catch (error) {
        if (error instanceof PackageError) return { ok: false, error: error.toInstallError() };
        throw error;
      }
      const { manifest } = pkg;
      // 派生模板：基模板必须已安装、版本匹配、是脚本模板（第 2 步）
      let resolved: ResolvedTemplate;
      let code: string;
      if (manifest.extends) {
        const candidate = this.findBase(manifest);
        if (!candidate) return { ok: false, error: { code: 'base-missing', detail: `${manifest.extends.id}@${manifest.extends.version}` } };
        // 只允许派生一层（4.7）
        if (candidate.manifest.extends) return { ok: false, error: { code: 'base-not-script', detail: `${candidate.manifest.id}@${candidate.manifest.version}` } };
        const base = candidate;
        try {
          resolved = resolveDerived(manifest, base.manifest);
        } catch (error) {
          if (error instanceof DeriveError) return { ok: false, error: { code: error.code === 'base-not-script' ? 'base-not-script' : 'base-missing', detail: error.message } };
          throw error;
        }
        const baseCode = await this.readFile(base, 'template.js');
        if (!baseCode) return { ok: false, error: { code: 'base-missing', detail: 'base template code is missing' } };
        code = new TextDecoder().decode(baseCode);
      } else {
        resolved = resolveScript(manifest);
        code = pkg.code!;
      }
      const stagingId = randomUUID();
      const dir = join(this.stagingDir, stagingId);
      for (const [path, data] of pkg.files) {
        const target = join(dir, ...path.split('/'));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, data);
      }
      this.staged.set(stagingId, { dir, manifest, code: pkg.code, expires: this.now() + STAGING_TTL_MS, ruleDiagnostics: pkg.ruleDiagnostics });
      const entry: TemplateEntry = { id: manifest.id, version: manifest.version, source: 'user', kind: manifest.extends ? 'derived' : 'script', manifest, baseMissing: false, trialWarnings: [] };
      return {
        ok: true,
        stagingId,
        bundle: { entry, resolved, code },
        replaces: this.templates.has(key(manifest.id, manifest.version)),
        ruleDiagnostics: pkg.ruleDiagnostics,
      };
    });
  }

  /** 第 6 步：暂存区改名就位，记下试运行的警告 */
  commit(stagingId: string, report: InstallReport): Promise<CommitResult> {
    return this.serial(async () => {
      const st = this.staged.get(stagingId);
      this.staged.delete(stagingId);
      if (!st || st.expires < this.now()) {
        if (st) await rm(st.dir, { recursive: true, force: true });
        return { ok: false, error: { code: 'staging-expired', detail: stagingId } };
      }
      const { id, version } = st.manifest;
      const dir = this.versionDir(id, version);
      await ensureTemplateParent(this.userDir, dir);
      await this.guard(id, version, async () => {
        const info = await lstat(dir).catch(() => null);
        if (info && !(await safeTemplateDir(this.userDir, id, version))) throw new Error('invalid template directory');
        await rm(dir, { recursive: true, force: true });
        await rename(st.dir, dir);
      });
      const warnings = InstallReportSchema.parse(report).warnings;
      // 静态规则发现了 Math.random 之类（H12）：和试运行的确定性自检一样记为“预览与导出可能不一致”。
      // 只是提示，不拒绝安装；具体位置记进元数据
      if (st.ruleDiagnostics.length > 0 && !warnings.includes('nondeterministic')) warnings.push('nondeterministic');
      await writeJsonAtomic(this.metaFile(id, version), {
        formatVersion: 1,
        installedAt: new Date(this.now()).toISOString(),
        trialWarnings: warnings,
        ...(st.ruleDiagnostics.length > 0 ? { ruleDiagnostics: st.ruleDiagnostics } : {}),
      });
      const stored: Stored = { source: 'user', manifest: st.manifest, files: null, dir, trialWarnings: warnings };
      this.templates.set(key(id, version), stored);
      if (!st.manifest.extends) this.editable.add(key(id, version));
      else this.editable.delete(key(id, version));
      this.opts.log.info('templates', 'installed', { id, version, warnings });
      return { ok: true, entry: this.entryOf(stored) };
    });
  }

  cancel(stagingId: string): Promise<void> {
    return this.serial(async () => {
      const st = this.staged.get(stagingId);
      this.staged.delete(stagingId);
      if (st) await rm(st.dir, { recursive: true, force: true });
    });
  }

  /** 删除用户模板。依赖它的预设和派生模板保留，标记为“基模板缺失”（4.8 末尾） */
  remove(id: string, version: string): Promise<boolean> {
    return this.serial(async () => {
      const s = this.templates.get(key(id, version));
      if (!s || s.source !== 'user') return false;
      const dir = await safeTemplateDir(this.userDir, id, version);
      if (!dir) return false;
      this.templates.delete(key(id, version));
      this.editable.delete(key(id, version));
      await this.guard(id, version, () => rm(dir, { recursive: true, force: true }));
      await rm(this.metaFile(id, version), { force: true });
      // 这个 id 的最后一个版本：把空目录也删掉
      const idDir = join(this.userDir, id);
      const left = await readdir(idDir).catch(() => []);
      if (left.length === 0) await rmdir(idDir).catch(() => undefined);
      this.opts.log.info('templates', 'removed', { id, version });
      return true;
    });
  }

  /** 导出成 .allaytpl 的字节 */
  async exportPackage(id: string, version: string): Promise<Buffer | null> {
    const s = this.templates.get(key(id, version));
    if (!s) return null;
    const entries: { path: string; data: Uint8Array }[] = [];
    if (s.files) {
      for (const [path, data] of [...s.files].sort(([a], [b]) => a.localeCompare(b))) entries.push({ path, data });
    } else {
      const dir = await safeTemplateDir(this.userDir, id, version);
      if (!dir) return null;
      for (const path of await listDir(dir)) {
        const data = await readInside(dir, path);
        if (data) entries.push({ path, data });
      }
    }
    return writeZip(entries);
  }

  /**
   * 另存为派生模板（4.7）：新的 id 是 user.<随机>.<名字>，版本 1.0.0。
   * 覆盖的默认值按基模板的参数定义清洗，只留基模板有的键。
   */
  saveDerived(req: SaveDerivedRequest, resolveFile: (ref: string) => string | null = () => null): Promise<{ ok: true; entry: TemplateEntry } | { ok: false; error: string }> {
    return this.serial(async () => {
      const base = this.templates.get(key(req.base.id, req.base.version));
      if (!base) return { ok: false, error: 'base-missing' };
      if (base.manifest.extends) return { ok: false, error: 'base-not-script' };
      const defs = base.manifest.params ?? [];
      const known = new Set(defs.map((d) => d.key));
      const picked: Record<string, unknown> = Object.fromEntries(Object.entries(req.defaults).filter(([k]) => known.has(k)));
      // 用户选的图片（texture 参数的 file: 引用）：按引用读出、复制进派生模板的 assets/，默认值改成 asset: 引用（4.7、M4）
      const assets: { name: string; bytes: Uint8Array }[] = [];
      for (const def of defs) {
        const v = picked[def.key];
        if (def.type !== 'texture' || typeof v !== 'string') continue;
        const m = /^file:([0-9a-fA-F-]{36})$/.exec(v);
        if (!m) continue;
        const path = resolveFile(m[1]!);
        const image = path ? await readImageFile(path) : null;
        if (!image) return { ok: false, error: 'image-unreadable' };
        const name = `${def.key}.${image.ext}`;
        assets.push({ name, bytes: image.bytes });
        picked[def.key] = `asset:${name}`;
      }
      const clean = sanitizeParams(defs, picked);
      const defaults = Object.fromEntries(Object.keys(picked).map((k) => [k, clean[k]!]));
      const slug = req.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'template';
      const id = `user.${randomBytes(3).toString('hex')}.${slug}`;
      const raw = {
        formatVersion: 1,
        id,
        version: '1.0.0',
        name: req.name,
        category: base.manifest.category,
        extends: { id: base.manifest.id, version: `^${base.manifest.version}` },
        overrides: { defaults, hidden: req.hidden.filter((k) => known.has(k)) },
      };
      const parsed = parseManifest(raw);
      if (!parsed.ok) return { ok: false, error: parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ') };
      const dir = this.versionDir(id, '1.0.0');
      await ensureTemplateParent(this.userDir, dir);
      await this.guard(id, '1.0.0', async () => {
        await mkdir(dir);
        if (assets.length > 0) {
          await mkdir(join(dir, 'assets'), { recursive: true });
          for (const a of assets) await writeFile(join(dir, 'assets', a.name), a.bytes);
        }
        await writeJsonAtomic(join(dir, 'manifest.json'), raw);
      });
      await writeJsonAtomic(this.metaFile(id, '1.0.0'), { formatVersion: 1, installedAt: new Date(this.now()).toISOString(), trialWarnings: [] });
      const stored: Stored = { source: 'user', manifest: parsed.manifest, files: null, dir, trialWarnings: [] };
      this.templates.set(key(id, '1.0.0'), stored);
      return { ok: true, entry: this.entryOf(stored) };
    });
  }

  // ---- 模板开发模式（docs/08-milestones.md MD）----

  freezeComposition(req: FreezeCompositionRequest) {
    return this.serial(() => freezeComposition(req, (id, version) => this.readBundle(id, version)));
  }

  openComposition(id: string) {
    return this.serial(() => this.compositionLibrary.open(id, (template, version) => this.readBundle(template, version)));
  }

  readSource(id: string, version: string): Promise<SourceReadResult> {
    return this.serial(() => this.readEditable(id, version));
  }

  private async readEditable(id: string, version: string): Promise<SourceReadResult> {
    if (!this.editable.has(key(id, version))) return { ok: false, error: 'not-user' };
    try {
      const dir = await safeTemplateDir(this.userDir, id, version);
      const files = dir && await readSourceFiles(dir);
      return files ? { ok: true, ...files } : { ok: false, error: 'io' };
    } catch {
      return { ok: false, error: 'io' };
    }
  }

  writeSource(id: string, version: string, req: WriteSourceRequest): Promise<WriteResult> {
    return this.serial(async () => {
      const current = await this.readEditable(id, version);
      if (!current.ok) return current;
      if (current.version !== req.baseVersion) return { ok: false, error: 'conflict', currentVersion: current.version };
      try {
        const valid = await validateSource(id, version, req);
        if (!valid.ok) return { ok: false, error: 'invalid', diagnostics: valid.diagnostics ? [...valid.diagnostics] : [{ kind: 'compile', severity: 'error', code: 'manifest-invalid', message: valid.message }] };
        const dir = await safeTemplateDir(this.userDir, id, version);
        if (!dir) return { ok: false, error: 'io' };
        const result = await this.guard(id, version, () => replaceSourceFiles(dir, req, current, async () => {
          const latest = await this.readEditable(id, version);
          return latest.ok ? latest.version : null;
        }));
        if (result.ok) {
          const old = this.templates.get(key(id, version));
          this.templates.set(key(id, version), { source: 'user', manifest: valid.manifest, files: null, dir, trialWarnings: old?.trialWarnings ?? [] });
        }
        return result;
      } catch {
        return { ok: false, error: 'io' };
      }
    });
  }

  createBlank(name: string): Promise<TemplateEntry> {
    return this.serial(async () => {
      const id = `user.t${randomUUID()}.blank`;
      const version = '1.0.0';
      const parsed = parseManifest({ formatVersion: 1, id, version, name, category: 'overlay', params: [] });
      if (!parsed.ok) throw new Error('invalid blank template manifest');
      const dir = this.versionDir(id, version);
      await ensureTemplateParent(this.userDir, dir);
      const temp = join(dirname(dir), `.${randomUUID()}.tmp`);
      await this.guard(id, version, async () => {
        await mkdir(temp);
        try {
          await writeFile(join(temp, 'template.js'), 'export default {\n  setup(ctx) {\n    return { duration: 2, update(t) {} };\n  },\n};\n', { flag: 'wx' });
          await writeFile(join(temp, 'manifest.json'), `${JSON.stringify(parsed.manifest, null, 2)}\n`, { flag: 'wx' });
          await rename(temp, dir);
        } finally {
          await rm(join(temp, 'template.js'), { force: true });
          await rm(join(temp, 'manifest.json'), { force: true });
          await rmdir(temp).catch(() => undefined);
        }
      });
      const stored: Stored = { source: 'user', manifest: parsed.manifest, files: null, dir, trialWarnings: [] };
      this.templates.set(key(id, version), stored);
      this.editable.add(key(id, version));
      return this.entryOf(stored);
    });
  }

  /**
   * 把内置的脚本模板复制成一份可编辑的用户模板（解压后的文件夹）。新的 id 由调用方给（不得以 allay. 开头），
   * 版本 1.0.0；name 不给时沿用原名。annotate 可以改写 template.js（加类型注解）。
   */
  copyBuiltin(
    source: { id: string; version: string },
    target: { id: string; name?: string },
    annotate: (code: string) => string = (c) => c,
  ): Promise<{ ok: true; entry: TemplateEntry } | { ok: false; error: 'not-found' | 'not-builtin' | 'not-script' | 'bad-id' }> {
    return this.serial(async () => {
      const s = this.templates.get(key(source.id, source.version));
      if (!s) return { ok: false, error: 'not-found' };
      if (s.source !== 'builtin' || !s.files) return { ok: false, error: 'not-builtin' };
      if (s.manifest.extends) return { ok: false, error: 'not-script' };
      if (isReservedId(target.id) || !TEMPLATE_ID_RE.test(target.id) || [...this.templates.values()].some((t) => t.manifest.id === target.id)) {
        return { ok: false, error: 'bad-id' };
      }
      const version = '1.0.0';
      const raw = JSON.parse(new TextDecoder().decode(s.files.get('manifest.json')!)) as Record<string, unknown>;
      const manifestJson = { ...raw, id: target.id, version, ...(target.name ? { name: target.name } : {}) };
      const parsed = parseManifest(manifestJson);
      if (!parsed.ok) throw new Error(`copied manifest is invalid: ${parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`);
      const dir = this.versionDir(target.id, version);
      await ensureTemplateParent(this.userDir, dir);
      await this.guard(target.id, version, async () => {
        await mkdir(dir);
        for (const [path, data] of s.files!) {
          if (path === 'manifest.json') continue;
          const file = join(dir, ...path.split('/'));
          await mkdir(dirname(file), { recursive: true });
          await writeFile(file, path === 'template.js' ? annotate(new TextDecoder().decode(data)) : data);
        }
        await writeJsonAtomic(join(dir, 'manifest.json'), manifestJson);
      });
      await writeJsonAtomic(this.metaFile(target.id, version), { formatVersion: 1, installedAt: new Date(this.now()).toISOString(), trialWarnings: [], copiedFrom: source });
      const stored: Stored = { source: 'user', manifest: parsed.manifest, files: null, dir, trialWarnings: [] };
      this.templates.set(key(target.id, version), stored);
      this.editable.add(key(target.id, version));
      this.opts.log.info('templates', 'copied built-in template', { from: source, id: target.id });
      return { ok: true, entry: this.entryOf(stored) };
    });
  }

  /**
   * 文件夹在外面被改了（监视服务报来的）：重新读 manifest.json，更新或移除这个用户模板。
   * 返回新的条目；文件夹不在了或 manifest 不合法时为 null（不合法的原因记进日志）。
   */
  refreshUser(id: string, version: string): Promise<TemplateEntry | null> {
    return this.serial(async () => {
      const existing = this.templates.get(key(id, version));
      if (existing && existing.source !== 'user') return null;
      this.templates.delete(key(id, version));
      const stored = await this.loadUserVersion(id, version);
      if (!stored) return null;
      this.templates.set(key(id, version), stored);
      if (!stored.manifest.extends) this.editable.add(key(id, version));
      else this.editable.delete(key(id, version));
      return this.entryOf(stored);
    });
  }

  // ---- 内部 ----

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private dropExpired(): void {
    const now = this.now();
    for (const [id, st] of this.staged) {
      if (st.expires >= now) continue;
      this.staged.delete(id);
      void rm(st.dir, { recursive: true, force: true });
    }
  }

  private versionDir(id: string, version: string): string {
    return join(this.userDir, id, version);
  }

  private metaFile(id: string, version: string): string {
    return join(this.userDir, id, `${version}.meta.json`);
  }

  private entryOf(s: Stored): TemplateEntry {
    const m = s.manifest;
    return {
      id: m.id,
      version: m.version,
      source: s.source,
      kind: m.extends ? 'derived' : 'script',
      manifest: m,
      baseMissing: m.extends ? this.resolve(m) === null : false,
      trialWarnings: s.trialWarnings,
    };
  }

  /** extends 指向的模板：满足版本范围的最高版本（可能本身是派生模板） */
  private findBase(m: TemplateManifest): Stored | null {
    const ext = m.extends;
    if (!ext) return null;
    const versions = [...this.templates.values()].filter((s) => s.manifest.id === ext.id).map((s) => s.manifest.version);
    const v = pickVersion(versions, ext.version, compareVersionStrings);
    return (v ? this.templates.get(key(ext.id, v)) : undefined) ?? null;
  }

  /** 派生模板的基模板：必须是脚本模板 */
  private resolveBase(m: TemplateManifest): Stored | null {
    const base = this.findBase(m);
    return base && !base.manifest.extends ? base : null;
  }

  private resolve(m: TemplateManifest): ResolvedTemplate | null {
    if (!m.extends) return resolveScript(m);
    const base = this.resolveBase(m);
    if (!base) return null;
    try {
      return resolveDerived(m, base.manifest);
    } catch {
      return null;
    }
  }

  private async readFile(s: Stored, path: string): Promise<Uint8Array | null> {
    if (s.files) return s.files.get(path) ?? null;
    const dir = await safeTemplateDir(this.userDir, s.manifest.id, s.manifest.version);
    return dir ? readInside(dir, path) : null;
  }

  private async loadBuiltins(): Promise<void> {
    const names = await readdir(this.opts.builtinDir).catch(() => [] as string[]);
    for (const name of names.filter((n) => n.endsWith('.allaytpl')).sort()) {
      try {
        const pkg = await readPackage(join(this.opts.builtinDir, name), { builtin: true, appVersion: this.opts.appVersion });
        if (removedBuiltinIds.has(pkg.manifest.id)) continue;
        this.templates.set(key(pkg.manifest.id, pkg.manifest.version), { source: 'builtin', manifest: pkg.manifest, files: pkg.files, dir: null, trialWarnings: [] });
      } catch (error) {
        this.opts.log.error('templates', 'built-in template rejected', { name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (this.templates.size === 0) this.opts.log.warn('templates', 'no built-in templates found', { dir: this.opts.builtinDir });
  }

  private async scanUser(): Promise<void> {
    const ids = await readdir(this.userDir).catch(() => [] as string[]);
    for (const id of ids) {
      if (!TEMPLATE_ID_RE.test(id)) continue;
      if (!(await lstat(join(this.userDir, id)).catch(() => null))?.isDirectory()) continue;
      const versions = await readdir(join(this.userDir, id)).catch(() => [] as string[]);
      for (const version of versions) {
        const stored = await this.loadUserVersion(id, version);
        if (stored) {
          this.templates.set(key(id, version), stored);
          if (!stored.manifest.extends) this.editable.add(key(id, version));
        }
      }
    }
  }

  /** 读一个已安装的用户模板（扫描和刷新共用）；不在、不合法时为 null */
  private async loadUserVersion(id: string, version: string): Promise<Stored | null> {
    const dir = await safeTemplateDir(this.userDir, id, version);
    if (!dir) return null;
    try {
      const manifestBytes = await readRegular(join(dir, 'manifest.json'), MAX_SOURCE_MANIFEST_BYTES);
      if (!manifestBytes) return null;
      const parsed = parseManifest(JSON.parse(manifestBytes.toString('utf8').replace(/^\uFEFF/, '')));
      if (!parsed.ok) throw new Error(parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; '));
      const m = parsed.manifest;
      if (m.id !== id || m.version !== version) throw new Error('manifest id/version does not match its folder');
      if (!m.extends && !(await lstat(join(dir, 'template.js')).catch(() => null))?.isFile()) throw new Error('template.js is missing');
      if (this.templates.has(key(id, version))) throw new Error('shadows a built-in template');
      let trialWarnings: TrialWarning[] = [];
      try {
        const metaBytes = await readRegular(this.metaFile(id, version), 256 * 1024);
        const meta = MetaSchema.parse(metaBytes && JSON.parse(metaBytes.toString('utf8')));
        trialWarnings = InstallReportSchema.parse({ warnings: meta.trialWarnings }).warnings;
      } catch {
        // 元数据丢了不影响装载
      }
      return { source: 'user', manifest: m, files: null, dir, trialWarnings };
    } catch (error) {
      this.opts.log.warn('templates', 'skipped installed template', { id, version, error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
}

/** 读目录里的一个相对路径（正斜杠分隔，已确认安全）；不是普通文件时返回 null */
async function readInside(dir: string, rel: string): Promise<Uint8Array | null> {
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || /[\\:]/.test(p))) return null;
  for (let depth = 1; depth < parts.length; depth++) {
    if (!(await lstat(join(dir, ...parts.slice(0, depth))).catch(() => null))?.isDirectory()) return null;
  }
  return readRegular(join(dir, ...parts), 64 * 1024 * 1024);
}

async function listDir(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.isSymbolicLink()) continue;
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isDirectory()) out.push(...(await listDir(join(dir, d.name), rel)));
    else if (d.isFile()) out.push(rel);
  }
  return out.sort();
}

/** 派生模板里带的图片上限（单张） */
export const MAX_DERIVED_IMAGE_BYTES = 16 * 1024 * 1024;

/** 读用户选的图片：只认 PNG、JPEG、WebP（按文件头判断，不看扩展名） */
export async function readImageFile(path: string): Promise<{ bytes: Uint8Array; ext: 'png' | 'jpg' | 'webp' } | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_DERIVED_IMAGE_BYTES || info.size < 12) return null;
    const bytes = new Uint8Array(await readFile(path));
    const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
    if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return { bytes, ext: 'png' };
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { bytes, ext: 'jpg' };
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { bytes, ext: 'webp' };
    return null;
  } catch {
    return null;
  }
}
