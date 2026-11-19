import type { ParamValues } from '@allay/template-sdk';

const TITLE_PRESETS = ['Loading world', '正在加载世界'];
const SUBTITLE_PRESETS = ['Building terrain…', '正在生成地形…'];
const text = (value: unknown) => typeof value === 'string' ? value : undefined;

export function javaLoadingCopy(params: Readonly<ParamValues>) {
  const oldTitle = text(params.title);
  const oldSubtitle = text(params.subtitle);
  const title = params.javaTitleMode === 'custom' ? text(params.javaTitle) ?? oldTitle ?? ''
    : params.javaTitleMode === undefined && oldTitle !== undefined && !TITLE_PRESETS.includes(oldTitle) ? oldTitle : undefined;
  const subtitle = params.javaSubtitleMode === 'custom' ? text(params.javaSubtitle) ?? oldSubtitle ?? ''
    : params.javaSubtitleMode === undefined && oldSubtitle !== undefined && !SUBTITLE_PRESETS.includes(oldSubtitle) ? oldSubtitle : '';
  const oldJavaFill = text(params.javaBarColor)?.toUpperCase();
  const oldGenericFill = text(params.barColor)?.toUpperCase();
  const legacyFill = oldJavaFill && oldJavaFill !== '#00000000' ? oldJavaFill
    : oldGenericFill && oldGenericFill !== '#55FF55' ? oldGenericFill : undefined;
  const overrideBarColor = params.javaFillMode === 'custom' ? text(params.javaFillColor) ?? legacyFill ?? '#00FF00'
    : params.javaFillMode === undefined ? legacyFill : undefined;
  return { title, subtitle, overrideBarColor };
}
