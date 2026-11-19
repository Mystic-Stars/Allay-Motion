import { defaultParams, diffFromDefaults, localize, sanitizeValue, type ParamDef, type ParamValue } from '@allay/template-sdk';
import { Button } from '@allay/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuEmpty,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@allay/ui/components/dropdown-menu';
import { Input, ScrollArea } from '@allay/ui/components/misc';
import { ParamPanel } from '@allay/ui/editor';
import { ICON } from '@allay/ui/lib/icons';
import { ArrowCounterClockwise, CaretUpDown, DotsThree, FloppyDisk, MagnifyingGlass } from '@phosphor-icons/react';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PresetEntry } from '../../../shared/templates';
import type { SkinEntry } from '../../../shared/skins';
import { notify } from '../../stores/noticeStore';
import { usePreviewStore } from '../../stores/previewStore';
import { setParam, useProjectStore } from '../../stores/projectStore';
import { useTemplateStore } from '../../stores/templateStore';
import { useTransportStore } from '../../stores/transportStore';
import { useUiStore } from '../../stores/uiStore';
import { OutputSettingsForm } from '../settings/OutputSettingsForm';
import { applyPresetEntry } from '../templates/presets';
import { SkinLibraryField } from '../skins/SkinLibraryField';
import { FontUsageHint } from '../fonts/FontUsageHint';
import { PanoramaFallbackHint } from '../resources/PanoramaFallbackHint';
import { filterCopy, matchingParamKeys } from './filter';

// 右面板（6.4）的两个标签页（经注册表挂到 TabbedPanel 上，见 app/core.tsx）：
// 属性页：模板名（15 px）和“类别 · 时长”，右侧预设下拉；主体是按 groups 分组的参数（ParamPanel，由参数定义自动生成），
// 折叠状态按模板记忆；底部一行“另存为模板 / 全部重置”。属性页的标题行右侧是更多菜单
// （保存为预设、另存为模板、重置全部参数、导入/导出预设）。
// 输出页：分辨率、帧率等输出设置。

/** 应用内的“剪贴板”：复制值、粘贴值只在参数之间用，不经系统剪贴板（权限请求一律被拒，1.6 第 4 条） */
let clipboard: { type: ParamDef['type']; value: ParamValue } | null = null;

/** 当前模板的预设；保存、导入预设后（uiStore.presetsVersion 变了）重新取 */
export function usePresets(templateId: string | undefined): PresetEntry[] {
  const [presets, setPresets] = useState<PresetEntry[]>([]);
  const version = useUiStore((s) => s.presetsVersion);
  useEffect(() => {
    let alive = true;
    void window.allay.presets.list().then((all) => alive && setPresets(all.filter((p) => p.template.id === templateId)));
    return () => {
      alive = false;
    };
  }, [templateId, version]);
  return presets;
}

function useDefaults() {
  const template = useProjectStore((s) => s.template);
  const { i18n } = useTranslation();
  return useMemo(() => (template ? defaultParams(template.params, { locale: i18n.language }) : {}), [template, i18n.language]);
}

/** 属性页标题行右侧：更多菜单 */
export function PropsActions() {
  const { t, i18n } = useTranslation();
  const template = useProjectStore((s) => s.template);
  const params = useProjectStore((s) => s.params);
  const presets = usePresets(template?.ref.id);
  const defaults = useDefaults();
  const locale = i18n.language;
  if (!template) return null;
  const changedCount = Object.keys(diffFromDefaults(template.params, params, { locale })).length;
  const exportPreset = async (p: PresetEntry) => {
    const r = await window.allay.presets.exportFile(p.id);
    if (!r.canceled) notify('info', t('params.presets.exported'));
  };
  const importPreset = async () => {
    const r = await window.allay.presets.importFile();
    if (r.canceled) return;
    if (!r.ok) notify('error', t('params.presets.importFailed'));
    else {
      notify('info', t('params.presets.imported', { name: r.entry.name }));
      useUiStore.getState().bumpPresets();
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="text-fg-subtle" aria-label={t('params.more')} data-testid="params-more" />}>
        <DotsThree size={ICON.md} weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onClick={() => useUiStore.getState().openDialog('savePreset')}>{t('params.presets.save')}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => useUiStore.getState().openDialog('saveTemplate')}>{t('params.saveAsTemplate')}</DropdownMenuItem>
        <DropdownMenuItem disabled={changedCount === 0} onClick={() => useProjectStore.getState().setParams(defaults, locale)}>
          {t('params.resetAll')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void importPreset()}>{t('params.presets.import')}</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={presets.length === 0}>{t('params.presets.export')}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {presets.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => void exportPreset(p)}>
                <span className="truncate">{p.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** 属性页 */
export function PropsTab() {
  const { t } = useTranslation();
  const template = useProjectStore((state) => state.template);
  if (!template) return <p className="px-3.5 py-3 text-xs text-fg-subtle">{t('params.placeholder')}</p>;
  return <TemplateProperties key={`${template.ref.id}@${template.ref.version}`} template={template} />;
}

function TemplateProperties({ template }: { template: NonNullable<ReturnType<typeof useProjectStore.getState>['template']> }) {
  const { t, i18n } = useTranslation();
  const handle = useProjectStore((s) => s.handle);
  const savedRevision = useProjectStore((s) => s.savedRevision);
  const params = useProjectStore((s) => s.params);
  const timing = usePreviewStore((s) => s.loaded?.timing);
  const fileNames = useProjectStore((s) => s.fileNames);
  const duration = useTransportStore((s) => s.duration);
  const groupState = useUiStore((s) => s.settings.editor.groups[template.ref.id]);
  const entries = useTemplateStore((s) => s.entries);
  const presets = usePresets(template.ref.id);
  const defaults = useDefaults();
  const locale = i18n.language;
  const messages = filterCopy[locale.startsWith('zh') ? 'zh-CN' : 'en'];
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [modifiedOnly, setModifiedOnly] = useState(false);
  const filterId = useId();
  const filterTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (filterOpen) searchInput.current?.focus();
  }, [filterOpen]);

  const clearFilter = () => {
    setQuery('');
    setModifiedOnly(false);
  };
  const closeFilter = () => {
    clearFilter();
    setFilterOpen(false);
    filterTrigger.current?.focus();
  };

  const onChange = useCallback((key: string, value: ParamValue) => {
    if (timing?.editable === false && Object.hasOwn(timing.durations, key)) return;
    setParam(key, value, locale);
  }, [locale, timing]);
  const clip = useMemo(
    () => ({
      copy: (def: ParamDef, value: ParamValue) => {
        clipboard = { type: def.type, value: structuredClone(value) };
      },
      paste: (def: ParamDef) => (clipboard && clipboard.type === def.type ? sanitizeValue(def, clipboard.value, { locale }) : undefined),
    }),
    [locale],
  );

  const entry = entries.find((e) => e.id === template.ref.id && e.version === template.ref.version);
  const name = localize(template.manifest.name, locale);
  const changedCount = Object.keys(diffFromDefaults(template.params, params, { locale })).length;
  const resetAll = () => useProjectStore.getState().setParams(defaults, locale);
  const skinField = template.params.find((def) => def.type === 'texture' && def.skinLibrary === true && !template.hidden.includes(def.key));
  const filtering = filterOpen && (query.trim() !== '' || modifiedOnly);
  const matches = filterOpen ? matchingParamKeys({ defs: template.params,
    hidden: skinField ? [...template.hidden, 'armModel'] : template.hidden,
    values: params, defaults, query, modifiedOnly, locale }) : undefined;
  const updateSkin = (skin: SkinEntry | null) => {
    const project = useProjectStore.getState();
    if (!skinField || project.template !== template || project.handle !== handle || project.savedRevision !== savedRevision) return;
    project.setParams({ [skinField.key]: skin?.ref ?? '', armModel: skin?.model ?? 'classic' }, locale);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={(event) => {
      if (!filterOpen || event.key !== 'Escape' || event.defaultPrevented || event.nativeEvent.isComposing ||
        !(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      closeFilter();
    }}>
      <div className="flex shrink-0 items-center gap-1.5 px-3.5 pt-0.5 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold" title={name} data-testid="params-template-name">
            {name}
          </h2>
          <p className="truncate text-xs text-fg-subtle" data-testid="params-template-meta">
            {duration > 0
              ? t('params.meta', { category: t(`gallery.categories.${template.manifest.category}`), duration: duration.toFixed(2) })
              : t(`gallery.categories.${template.manifest.category}`)}
            {entry?.source === 'user' && <span className="text-amethyst"> · {t('gallery.user')}</span>}
          </p>
        </div>
        <Button ref={filterTrigger} variant="ghost" size="icon-sm" className="shrink-0" aria-expanded={filterOpen}
          aria-controls={filterOpen ? filterId : undefined} aria-label={filterOpen ? messages.close : messages.open}
          title={filterOpen ? messages.close : messages.open} data-testid="params-filter-toggle"
          onClick={() => filterOpen ? closeFilter() : setFilterOpen(true)}>
          <MagnifyingGlass size={ICON.md} aria-hidden="true" />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="secondary" className="w-[118px] shrink-0 justify-between pr-2 pl-2.5 font-normal" data-testid="preset-menu" />}>
            <span className="truncate">{t('params.presets.title')}</span>
            <CaretUpDown size={ICON.xs} className="text-fg-subtle" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {presets.length === 0 ? (
              <DropdownMenuEmpty data-testid="preset-none">{t('params.presets.none')}</DropdownMenuEmpty>
            ) : (
              presets.map((p) => (
                <DropdownMenuItem
                  key={p.id}
                  data-testid={`preset-${p.name}`}
                  onClick={() =>
                    void applyPresetEntry(p, locale).then((ok) => {
                      if (!ok) notify('error', t('params.presets.applyFailed'));
                    })
                  }
                >
                  <span className="truncate">{p.name}</span>
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => useUiStore.getState().openDialog('savePreset')} data-testid="preset-save">
              {t('params.presets.save')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {filterOpen && <div id={filterId} role="group" aria-label={messages.open} className="flex shrink-0 flex-col gap-1.5 px-3.5 pb-2.5">
        <Input ref={searchInput} type="search" aria-label={messages.search} placeholder={messages.search} value={query}
          onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) event.stopPropagation();
          }} />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Button variant="ghost" size="sm" className="px-2" aria-pressed={modifiedOnly} onClick={() => setModifiedOnly(!modifiedOnly)}>{messages.modified}</Button>
          <span role="status" className="flex-1 text-xs text-fg-subtle">{messages.count(matches?.size ?? 0)}</span>
          {filtering && <Button variant="ghost" size="sm" className="px-2" onClick={() => {
            clearFilter();
            searchInput.current?.focus();
          }}>{messages.clear}</Button>}
        </div>
      </div>}
      <ScrollArea className="min-h-0 flex-1">
        <FontUsageHint />
        <PanoramaFallbackHint />
        {filtering && matches?.size === 0 && <p className="border-t border-divider px-3.5 py-4 text-sm text-fg-muted">{messages.empty}</p>}
        {skinField && (!filtering || matches?.has(skinField.key)) && <SkinLibraryField key={`${template.ref.id}@${template.ref.version}`} value={String(params[skinField.key] ?? '')} language={locale} onSelect={updateSkin} />}
        <ParamPanel
          defs={template.params}
          groups={template.manifest.groups ?? []}
          hidden={skinField ? [...template.hidden, skinField.key, 'armModel'] : template.hidden}
          {...(filtering && matches && { matchingKeys: matches })}
          values={params}
          defaults={defaults}
          {...(timing?.editable === false && { readOnlyDurations: timing.durations })}
          onChange={onChange}
          collapsed={groupState ?? {}}
          onToggleGroup={(g, c) => useUiStore.getState().setGroupCollapsed(template.ref.id, g, c)}
          fileNames={fileNames}
          clipboard={clip}
        />
      </ScrollArea>
      <footer className="flex h-panel-head shrink-0 items-center gap-2 border-t border-divider px-2">
        <Button variant="ghost" className="min-w-0 gap-2 px-2" data-testid="save-as-template" onClick={() => useUiStore.getState().openDialog('saveTemplate')}>
          <FloppyDisk size={ICON.md} />
          <span className="truncate">{t('params.saveAsTemplate')}</span>
        </Button>
        <span className="flex-1" />
        <Button variant="ghost" className="min-w-0 gap-2 px-2" disabled={changedCount === 0} title={t('params.resetAll')} data-testid="params-reset-all" onClick={resetAll}>
          <ArrowCounterClockwise size={ICON.md} />
          <span className="truncate">{t('params.resetAllShort')}</span>
        </Button>
      </footer>
    </div>
  );
}

/** 输出页 */
export function OutputTab() {
  return (
    <div className="px-3.5 pt-1 pb-3">
      <OutputSettingsForm />
    </div>
  );
}
