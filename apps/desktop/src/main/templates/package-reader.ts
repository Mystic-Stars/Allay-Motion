// 读取并校验一个 .allaytpl（docs/04-templates.md 4.2、4.8 第 1–3 步）。
// zip 的读取复用 resources/zip.ts 的防护（路径穿越、解压炸弹，1.6 第 9 条）；整包读进内存（≤ 50 MB）再校验，
// 校验通过的内容原样写进暂存区，所以“校验的”就是“安装的”。
import { stat } from 'node:fs/promises';
import { isReservedId, parseManifest, parseVersion, compareVersions, type TemplateDiagnostic, type TemplateManifest } from '@allay/template-sdk';
import {
  MAX_PACKAGE_BYTES,
  MAX_PACKAGE_ENTRIES,
  MAX_PACKAGE_ENTRY_BYTES,
  MAX_PACKAGE_UNPACKED_BYTES,
  PACKAGE_EXTENSIONS,
  type InstallError,
  type InstallErrorCode,
} from '../../shared/templates';
import { analyzeTemplateCode, TemplateCodeError } from '../../shared/template-code';
import { openZip, ZipRejectedError } from '../resources/zip';

export class PackageError extends Error {
  constructor(
    readonly code: InstallErrorCode,
    readonly detail: string,
    /** 源码预检失败时的 compile 类诊断（带位置） */
    readonly diagnostic?: TemplateDiagnostic,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PackageError';
  }

  toInstallError(): InstallError {
    return { code: this.code, detail: this.detail, ...(this.diagnostic ? { diagnostic: this.diagnostic } : {}) };
  }
}

export interface TemplatePackage {
  manifest: TemplateManifest;
  /** 脚本模板的源码；派生模板为 null */
  code: string | null;
  /** 包里的全部文件（路径 → 内容），包括 manifest.json */
  files: Map<string, Uint8Array>;
  /** 确定性静态规则的提示（rule 类诊断，H12）；内置模板和派生模板为空 */
  ruleDiagnostics: TemplateDiagnostic[];
}

export interface ReadPackageOptions {
  /** 内置模板：跳过第 1、3 步（体积和导入检查已在构建时保证，4.9），也不检查 allay. 前缀 */
  builtin?: boolean;
  /** 应用版本，用于 minAppVersion */
  appVersion: string;
}

function extOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

/** 读文件 → 校验 → 包内容。失败抛 PackageError */
export async function readPackage(file: string, options: ReadPackageOptions): Promise<TemplatePackage> {
  const builtin = options.builtin === true;
  // 第 1 步：包大小
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new PackageError('not-a-zip', 'file not found');
  if (!builtin && info.size > MAX_PACKAGE_BYTES) throw new PackageError('package-too-large', `${info.size} bytes > ${MAX_PACKAGE_BYTES}`);

  let archive;
  try {
    archive = await openZip(file, { maxEntryBytes: MAX_PACKAGE_ENTRY_BYTES, maxEntries: MAX_PACKAGE_ENTRIES, rejectLinks: true });
  } catch (error) {
    if (error instanceof ZipRejectedError) {
      // zip.ts 对不安全的条目名整包拒绝；yauzl 自己发现的 .. 和绝对路径也在这里
      const unsafe = error.entryName !== undefined || /relative path|absolute path|不安全|invalid characters/i.test(error.message);
      throw new PackageError(unsafe ? 'unsafe-path' : 'not-a-zip', error.message);
    }
    throw error;
  }
  try {
    // 被跳过的条目（过大、加密、重复）说明包有问题：整包拒绝，不装一个缺了东西的模板
    if (archive.warnings.length > 0) {
      const oversize = archive.warnings.find((w) => w.includes('过大'));
      throw new PackageError(oversize ? 'unpacked-too-large' : 'not-a-zip', oversize ?? archive.warnings[0]!);
    }
    for (const path of archive.paths) {
      if (!PACKAGE_EXTENSIONS.includes(extOf(path))) throw new PackageError('bad-extension', path);
    }
    const files = new Map<string, Uint8Array>();
    let total = 0;
    for (const path of [...archive.paths].sort()) {
      let data: Uint8Array | null;
      try {
        data = await archive.read(path);
      } catch (error) {
        // 实际解压出的字节数超过上限（中央目录里谎报了大小）
        if (error instanceof ZipRejectedError) throw new PackageError('unpacked-too-large', error.message);
        throw new PackageError('not-a-zip', `${path}: ${(error as Error).message}`);
      }
      if (!data) continue;
      total += data.byteLength;
      if (total > MAX_PACKAGE_UNPACKED_BYTES) throw new PackageError('unpacked-too-large', `more than ${MAX_PACKAGE_UNPACKED_BYTES} bytes unpacked`);
      files.set(path, data);
    }

    // 第 2 步：manifest
    const manifestBytes = files.get('manifest.json');
    if (!manifestBytes) throw new PackageError('manifest-missing', 'manifest.json');
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes));
    } catch (error) {
      throw new PackageError('manifest-invalid', `manifest.json is not valid JSON: ${(error as Error).message}`);
    }
    const parsed = parseManifest(json);
    if (!parsed.ok) throw new PackageError(parsed.code, parsed.issues.map((i) => `${i.path}: ${i.message}`).join('; ').slice(0, 1000));
    const manifest = parsed.manifest;
    if (!builtin && isReservedId(manifest.id)) throw new PackageError('reserved-id', `id "${manifest.id}" must not start with "allay."`);
    if (manifest.minAppVersion) {
      const need = parseVersion(manifest.minAppVersion);
      const have = parseVersion(options.appVersion);
      if (need && have && compareVersions(have, need) < 0) throw new PackageError('app-too-old', `needs app ${manifest.minAppVersion}, this is ${options.appVersion}`);
    }

    // 第 3 步：脚本
    const codeBytes = files.get('template.js');
    if (manifest.extends) {
      if (codeBytes) throw new PackageError('derived-has-code', 'a derived template must not contain template.js');
      return { manifest, code: null, files, ruleDiagnostics: [] };
    }
    if (!codeBytes) throw new PackageError('code-missing', 'template.js');
    let code: string;
    try {
      code = new TextDecoder('utf-8', { fatal: true }).decode(codeBytes);
    } catch {
      throw new PackageError('code-syntax', 'template.js is not valid UTF-8');
    }
    let ruleDiagnostics: TemplateDiagnostic[] = [];
    if (!builtin) {
      try {
        // 同一次解析里跑确定性的静态规则（H12）：只是提示，安装时并进试运行的警告
        ruleDiagnostics = await analyzeTemplateCode(code);
      } catch (error) {
        if (error instanceof TemplateCodeError) {
          const code2: InstallErrorCode = error.problem === 'too-large' ? 'code-too-large' : error.problem === 'has-import' ? 'code-has-import' : 'code-syntax';
          throw new PackageError(code2, error.message, error.diagnostic);
        }
        throw error;
      }
    }
    return { manifest, code, files, ruleDiagnostics };
  } finally {
    archive.close();
  }
}
