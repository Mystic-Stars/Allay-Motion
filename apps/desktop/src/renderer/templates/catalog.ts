// 渲染进程里的模板来源：经 window.allay.templates 向主进程要（内置和用户模板走同一条路，AGENTS.md 硬性规则 5），
// 交给引擎的是“生效 manifest + 源码文本”（派生模板已套上 overrides，代码来自基模板，04-templates.md 4.7）。
import { effectiveManifest, localize, studioMaterialManifest, type LocalizedString, type ParamDef, type TemplateManifest } from '@allay/template-sdk';
import type { TemplateBundle } from '../../shared/templates';

/** asset: 引用从哪里读：已安装的模板，或正在试运行的暂存包 */
export type AssetSource = { id: string; version: string } | { stagingId: string };

export interface TemplateSource {
  /** 用户选的那个模板（派生模板是派生的那份） */
  ref: { id: string; version: string };
  /** 交给引擎的生效 manifest（参数定义已套上派生模板的覆盖） */
  manifest: TemplateManifest;
  params: ParamDef[];
  /** 属性面板里不显示的参数（4.7） */
  hidden: string[];
  /** 模板的 ESM 源码文本 */
  code: string;
  assets: AssetSource | null;
}

/** 旗舰模板，应用启动时默认选它 */
export const DEFAULT_TEMPLATE_ID = 'allay.builtin.block-wipe';

export function sourceFromBundle(bundle: TemplateBundle, assets: AssetSource | null = { id: bundle.entry.id, version: bundle.entry.version }): TemplateSource {
  const { resolved } = bundle;
  return {
    ref: { id: bundle.entry.id, version: bundle.entry.version },
    manifest: effectiveManifest(resolved),
    params: resolved.params,
    hidden: resolved.hidden,
    code: bundle.code,
    assets,
  };
}

/** 读一个已安装的模板；不存在或基模板缺失时为 null */
export async function readTemplate(id: string, version: string): Promise<TemplateSource | null> {
  const bundle = await window.allay.templates.read(id, version);
  return bundle ? sourceFromBundle(bundle) : null;
}

export type CompositionClipSource = TemplateSource | Omit<TemplateSource, 'code'>;

export async function readCompositionClip(ref: TemplateSource['ref']): Promise<CompositionClipSource | null> {
  const manifest = studioMaterialManifest(ref);
  return manifest ? { ref, manifest, params: manifest.params ?? [], hidden: [], assets: null } : readTemplate(ref.id, ref.version);
}

/** 按界面语言取 manifest 里的多语言文字 */
export function localized(value: LocalizedString | undefined, language: string): string {
  return localize(value, language);
}

/** 资源缓存和引擎缓存的分代键：asset: 引用随模板变 */
export function assetKey(source: AssetSource | null): string {
  if (!source) return '';
  return 'stagingId' in source ? `staging:${source.stagingId}` : `${source.id}@${source.version}`;
}
