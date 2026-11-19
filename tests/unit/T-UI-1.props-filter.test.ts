import { expect, it } from 'vitest';
import type { ParamDef, ParamValues } from '../../packages/template-sdk/src/index';
import { matchingParamKeys } from '../../apps/desktop/src/renderer/features/params/filter';

const defs: ParamDef[] = [
  { key: 'showDetails', label: { en: 'Show details', 'zh-CN': '显示细节' }, type: 'boolean', default: false },
  { key: 'detailSize', label: { en: 'Detail size', 'zh-CN': '细节尺寸' }, type: 'integer', min: 1, max: 20, default: 5, visibleWhen: { key: 'showDetails', equals: true } },
  { key: 'privateSize', label: { en: 'Private size', 'zh-CN': '隐藏尺寸' }, type: 'integer', min: 1, max: 20, default: 5 },
];
const defaults = { showDetails: false, detailSize: 5, privateSize: 5 };
const match = (values: ParamValues, query: string, modifiedOnly = false, locale = 'en') =>
  [...matchingParamKeys({ defs, hidden: ['privateSize'], values, defaults, query, modifiedOnly, locale })];

it('T-UI-1 属性筛选匹配本地化名称或键名，但不显示条件隐藏和模板隐藏的参数', () => {
  const shown = { ...defaults, showDetails: true };
  expect(match(shown, '细节尺寸', false, 'zh-CN')).toEqual(['detailSize']);
  expect(match(shown, ' ＤＥＴＡＩＬＳＩＺＥ ', false, 'zh-CN')).toEqual(['detailSize']);
  expect(match(shown, 'size')).toEqual(['detailSize']);
  expect(match(defaults, 'size')).toEqual([]);
});

it('T-UI-1 仅已修改随实时值和可见性变化；恢复默认值后移除结果', () => {
  const hiddenChanged = { ...defaults, detailSize: 12, privateSize: 13 };
  expect(match(hiddenChanged, '', true)).toEqual([]);
  const shown = { ...hiddenChanged, showDetails: true };
  expect(match(shown, '', true)).toEqual(['showDetails', 'detailSize']);
  expect(match(shown, 'size', true)).toEqual(['detailSize']);
  expect(match({ ...shown, detailSize: defaults.detailSize }, 'size', true)).toEqual([]);
});
