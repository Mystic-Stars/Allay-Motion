// 用户模板目录的监视（docs/code-editing-and-mcp-plan.md H10；docs/08-milestones.md MD）。
//
// - 只监视一个位置：userData/templates/（路径由主进程决定，1.6 第 6 条）。下面一层是 <id>/<版本>/。
// - 只认与模板本身有关的文件（manifest.json、template.js、assets/**）；编辑器的临时文件、交换文件、
//   template-api.d.ts、jsconfig.json、.vscode/ 之类都不算。
// - 每个模板（id + 版本）一个防抖计时器；计时器到点时按内容重新算哈希，和上次一样就不报。
//   这样编辑器“先写临时文件再改名”的原子保存只报一次，应用自己的写入也不报（见 ownWrite）。
// - 对外是一个事件：{ id, version, change: added | changed | removed, hash }。
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { isValidVersion, TEMPLATE_ID_RE } from '@allay/template-sdk';
import { isTemplateContentPath } from '../../shared/template-dev';
import type { Logger } from '../logger';
import { readRegular, safeTemplateDir } from './source-files';

export type TemplateChangeKind = 'added' | 'changed' | 'removed';

export interface TemplateChangeEvent {
  id: string;
  version: string;
  change: TemplateChangeKind;
  /** 新的内容哈希（SHA-256，十六进制）；removed 时为 null */
  hash: string | null;
}

export interface TemplateWatcherOptions {
  /** userData/templates */
  root: string;
  log: Logger;
  /** 防抖时长（毫秒），默认 150 */
  debounceMs?: number;
}

const key = (id: string, version: string) => `${id}@${version}`;

/** 编辑器和系统留下的临时文件（不是模板内容，忽略） */
const TEMP_FILE = /(^\.#)|(^#.*#$)|(~$)|(^~\$)|(^\.~)|(^4913$)|(\.(tmp|temp|swp|swo|swx|swpx|bak|orig|crswap|part|partial)$)|(\.sb-[0-9a-f]+-)|(^\.DS_Store$)|(^Thumbs\.db$)|(^desktop\.ini$)/i;

export function isIgnoredTemplateFile(rel: string): boolean {
  const parts = rel.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || TEMP_FILE.test(p))) return true;
  return !isTemplateContentPath(rel);
}

/** 模板文件夹里参与哈希的文件：manifest.json、template.js、assets/**（不跟随符号链接） */
async function contentFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    if (!(await lstat(join(dir, prefix))).isDirectory()) return out;
    entries = await readdir(join(dir, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of entries) {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    if (d.isSymbolicLink()) continue;
    if (d.isDirectory()) {
      if (rel === 'assets' || rel.startsWith('assets/')) out.push(...(await contentFiles(dir, rel)));
    } else if (d.isFile() && !isIgnoredTemplateFile(rel)) out.push(rel);
  }
  return out.sort();
}

/** 模板内容的哈希；版本目录或 manifest.json 不在时为 null */
export async function hashTemplateDir(dir: string): Promise<string | null> {
  const files = await contentFiles(dir);
  if (!files.includes('manifest.json')) return null;
  const h = createHash('sha256');
  for (const rel of files) {
    let data: Buffer | null;
    try {
      data = await readRegular(join(dir, ...rel.split('/')), 64 * 1024 * 1024);
    } catch {
      // 读的时候正好被删或被改名：下一个事件会再算一次
      continue;
    }
    if (!data) continue;
    h.update(rel);
    h.update('\0');
    h.update(String(data.byteLength));
    h.update('\0');
    h.update(data);
  }
  return h.digest('hex');
}

export class TemplateWatcher {
  private readonly hashes = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly chains = new Map<string, Promise<void>>();
  /** 正在自己写入的模板：计数大于 0 时不报事件 */
  private readonly muted = new Map<string, number>();
  private readonly listeners = new Set<(event: TemplateChangeEvent) => void>();
  private watcher: FSWatcher | null = null;
  private readonly debounceMs: number;
  private closed = false;

  constructor(private readonly opts: TemplateWatcherOptions) {
    this.debounceMs = opts.debounceMs ?? 150;
  }

  get root(): string {
    return this.opts.root;
  }

  /** 建好目录，记下现有模板的哈希，开始监视 */
  async start(): Promise<void> {
    if (this.watcher || this.closed) return;
    await mkdir(this.opts.root, { recursive: true });
    for (const [id, version] of await this.listTemplates()) {
      const dir = await this.resolveDir(id, version);
      const h = dir && await hashTemplateDir(dir);
      if (h) this.hashes.set(key(id, version), h);
    }
    const w = watch(this.opts.root, { recursive: true, persistent: false }, (_type, filename) => this.onRaw(filename));
    w.on('error', (error) => this.opts.log.warn('templates', 'template folder watcher failed', { error: error instanceof Error ? error.message : String(error) }));
    this.watcher = w;
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
  }

  /** 订阅变更；返回取消订阅的函数 */
  onChange(listener: (event: TemplateChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 已知的内容哈希（测试与诊断用） */
  hashOf(id: string, version: string): string | null {
    return this.hashes.get(key(id, version)) ?? null;
  }

  /**
   * 应用自己的写入：期间这个模板的事件都不报；写完按新内容更新哈希。
   * 之后才到的文件系统事件算出的哈希与此相同，也不会报。
   */
  async ownWrite<T>(id: string, version: string, fn: () => Promise<T>): Promise<T> {
    const k = key(id, version);
    this.muted.set(k, (this.muted.get(k) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      try {
        const dir = await this.resolveDir(id, version);
        const h = dir && await hashTemplateDir(dir);
        if (h) this.hashes.set(k, h);
        else this.hashes.delete(k);
      } finally {
        const n = (this.muted.get(k) ?? 1) - 1;
        if (n > 0) this.muted.set(k, n);
        else this.muted.delete(k);
      }
    }
  }

  /**
   * 模板文件夹的路径：id、版本格式合法，且真实路径（解开符号链接、目录联接之后）在监视的根目录之内。
   * 不满足时为 null。目录不存在时也为 null。
   */
  async resolveDir(id: string, version: string): Promise<string | null> {
    return safeTemplateDir(this.opts.root, id, version);
  }

  // ---- 内部 ----

  private async listTemplates(): Promise<[string, string][]> {
    const out: [string, string][] = [];
    const ids = await readdir(this.opts.root).catch(() => [] as string[]);
    for (const id of ids) {
      if (!TEMPLATE_ID_RE.test(id)) continue;
      if (!(await lstat(join(this.opts.root, id)).catch(() => null))?.isDirectory()) continue;
      for (const version of await readdir(join(this.opts.root, id)).catch(() => [] as string[])) {
        if (isValidVersion(version)) out.push([id, version]);
      }
    }
    return out;
  }

  private onRaw(filename: string | Buffer | null): void {
    if (this.closed) return;
    if (filename === null) {
      // 系统没给文件名（缓冲区溢出等）：全部重新核对
      void this.rescanAll();
      return;
    }
    const parts = String(filename).replace(/\\/g, '/').split('/').filter(Boolean);
    const [id, version, ...rest] = parts;
    if (!id || !TEMPLATE_ID_RE.test(id)) return;
    if (!version) {
      // id 目录本身变了（新建、删除、改名）：核对它下面的所有版本
      void this.rescanId(id);
      return;
    }
    if (!isValidVersion(version)) return;
    if (rest.length > 0) {
      const rel = rest.join('/');
      // assets 目录本身的事件也算（整个目录被删或换掉）
      if (rel !== 'assets' && isIgnoredTemplateFile(rel)) return;
      if (TEMP_FILE.test(basename(rel))) return;
    }
    this.schedule(id, version);
  }

  private async rescanId(id: string): Promise<void> {
    const parent = join(this.opts.root, id);
    const versions = new Set((await lstat(parent).catch(() => null))?.isDirectory() ? await readdir(parent).catch(() => []) : []);
    for (const k of this.hashes.keys()) if (k.startsWith(`${id}@`)) versions.add(k.slice(id.length + 1));
    for (const v of versions) if (isValidVersion(v)) this.schedule(id, v);
  }

  private async rescanAll(): Promise<void> {
    const seen = new Set<string>();
    for (const [id, version] of await this.listTemplates()) {
      seen.add(key(id, version));
      this.schedule(id, version);
    }
    for (const k of this.hashes.keys()) {
      if (seen.has(k)) continue;
      const at = k.lastIndexOf('@');
      this.schedule(k.slice(0, at), k.slice(at + 1));
    }
  }

  private schedule(id: string, version: string): void {
    const k = key(id, version);
    const old = this.timers.get(k);
    if (old) clearTimeout(old);
    this.timers.set(
      k,
      setTimeout(() => {
        this.timers.delete(k);
        // 同一个模板的核对串行，免得两次核对交错
        const prev = this.chains.get(k) ?? Promise.resolve();
        const next = prev.then(() => this.check(id, version)).catch((error: unknown) => this.opts.log.warn('templates', 'template change check failed', { id, version, error: String(error) }));
        this.chains.set(k, next);
        void next.finally(() => {
          if (this.chains.get(k) === next) this.chains.delete(k);
        });
      }, this.debounceMs),
    );
  }

  private async check(id: string, version: string): Promise<void> {
    if (this.closed) return;
    const k = key(id, version);
    // 自己正在写：写完时 ownWrite 会更新哈希，之后的事件按新哈希比较
    if (this.muted.has(k)) return;
    const dir = await this.resolveDir(id, version);
    const hash = dir && await hashTemplateDir(dir);
    if (this.muted.has(k) || this.closed) return;
    const prev = this.hashes.get(k) ?? null;
    if (hash === prev) return;
    if (hash) this.hashes.set(k, hash);
    else this.hashes.delete(k);
    const change: TemplateChangeKind = prev === null ? 'added' : hash === null ? 'removed' : 'changed';
    const event: TemplateChangeEvent = { id, version, change, hash };
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (error) {
        this.opts.log.warn('templates', 'template change listener failed', { error: String(error) });
      }
    }
  }
}
