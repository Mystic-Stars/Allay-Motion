// 模板包夹具：在测试时用脚本生成，不提交二进制。PNG 是纯色色块，只是测试数据。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeZip } from '../../../apps/desktop/src/main/templates/zip-writer';
import { createLogger } from '../../../apps/desktop/src/main/logger';
import { TemplateService } from '../../../apps/desktop/src/main/templates/service';
import { packTemplate, TEMPLATES_SRC } from '../../../scripts/build-templates';
import { solidPng } from './resource-fixtures';

export const log = createLogger(null, false);

/** 一个合法的脚本模板：texture 参数 logo、number 参数 size、seed */
export const BASE_CODE = `export default {
  async setup(ctx) {
    const tex = ctx.params.logo ? await ctx.resources.texture(ctx.params.logo) : null;
    if (tex) {
      const s = ctx.sprite.create(tex, { pixelSize: 1 });
      s.setSize(ctx.stage.width, ctx.stage.height);
      ctx.scene.add(s.object);
    }
    return { duration: 1, cutTime: 0.5, update() {} };
  },
};
`;

export function baseManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    id: 'user.test.base',
    version: '1.2.0',
    name: { 'zh-CN': '测试基模板', en: 'Test base' },
    category: 'overlay',
    params: [
      { key: 'logo', type: 'texture', label: 'Logo', default: '' },
      { key: 'size', type: 'number', label: 'Size', default: 1, min: 0, max: 10 },
      { key: 'mode', type: 'enum', label: 'Mode', default: 'a', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
      { key: 'seed', type: 'seed', label: 'Seed', default: 1 },
    ],
    ...over,
  };
}

export function derivedManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    id: 'user.test.derived',
    version: '1.0.0',
    name: '派生',
    category: 'overlay',
    extends: { id: 'user.test.base', version: '^1.0.0' },
    overrides: { defaults: { logo: 'asset:logo.png', size: 99, mode: 'nope', unknownKey: 1 }, hidden: ['size', 'unknownKey'] },
    ...over,
  };
}

export type Entries = Record<string, Uint8Array | string>;

export function packageBytes(entries: Entries): Buffer {
  return writeZip(Object.entries(entries).map(([path, data]) => ({ path, data: typeof data === 'string' ? Buffer.from(data, 'utf8') : data })));
}

export function writePackage(file: string, entries: Entries): string {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, packageBytes(entries));
  return file;
}

export const basePackage = (over: Record<string, unknown> = {}, extra: Entries = {}): Entries => ({
  'manifest.json': JSON.stringify(baseManifest(over)),
  'template.js': BASE_CODE,
  'assets/base-only.png': solidPng('#00ff00'),
  ...extra,
});

export const derivedPackage = (over: Record<string, unknown> = {}, extra: Entries = {}): Entries => ({
  'manifest.json': JSON.stringify(derivedManifest(over)),
  'assets/logo.png': solidPng('#ff0000'),
  ...extra,
});

/** 打一份真实的内置模板目录（pnpm templates:build 的产物）到 dir */
export async function buildBuiltins(dir: string, names: readonly string[] = ['block-wipe']): Promise<void> {
  mkdirSync(dir, { recursive: true });
  for (const name of names) {
    const { fileName, zip } = await packTemplate(join(TEMPLATES_SRC, name));
    writeFileSync(join(dir, fileName), zip);
  }
}

export async function makeService(userDataDir: string, builtinDir: string, appVersion = '0.1.0'): Promise<TemplateService> {
  const svc = new TemplateService({ builtinDir, userDataDir, appVersion, log });
  await svc.init();
  return svc;
}
