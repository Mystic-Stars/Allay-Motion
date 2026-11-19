import { localize, sameValue, type ParamDef, type ParamValues } from '@allay/template-sdk';
import { isVisible } from '@allay/ui/editor';

export const filterCopy = {
  en: {
    open: 'Filter properties',
    close: 'Close property filter',
    search: 'Search by name or key',
    modified: 'Only modified',
    clear: 'Clear filters',
    empty: 'No matching properties',
    count: (count: number) => `${count} ${count === 1 ? 'property' : 'properties'}`,
  },
  'zh-CN': {
    open: '筛选属性',
    close: '关闭属性筛选',
    search: '按名称或参数键搜索',
    modified: '仅已修改',
    clear: '清除筛选',
    empty: '没有匹配的属性',
    count: (count: number) => `${count} 项属性`,
  },
};

export function matchingParamKeys({ defs, hidden, values, defaults, query, modifiedOnly, locale }: {
  defs: readonly ParamDef[];
  hidden: readonly string[];
  values: ParamValues;
  defaults: ParamValues;
  query: string;
  modifiedOnly: boolean;
  locale: string;
}): ReadonlySet<string> {
  const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase(locale);
  const terms = normalize(query.trim()).split(/\s+/).filter(Boolean);
  const keys = new Set<string>();
  for (const def of defs) {
    if (hidden.includes(def.key) || !isVisible(def, values)) continue;
    if (modifiedOnly && sameValue(values[def.key] ?? defaults[def.key] ?? null, defaults[def.key] ?? null)) continue;
    const name = normalize(localize(def.label, locale));
    const key = normalize(def.key);
    if (terms.every((term) => name.includes(term) || key.includes(term))) keys.add(def.key);
  }
  return keys;
}
