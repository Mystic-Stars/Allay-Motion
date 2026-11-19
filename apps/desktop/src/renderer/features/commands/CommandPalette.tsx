import { localize } from '@allay/template-sdk';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@allay/ui/components/command';
import { Dialog, DialogContent, DialogTitle } from '@allay/ui/components/dialog';
import { Kbd } from '@allay/ui/components/misc';
import { ICON } from '@allay/ui/lib/icons';
import { FilmSlate, Lightning, SlidersHorizontal } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PresetEntry } from '../../../shared/templates';
import { useTemplateStore } from '../../stores/templateStore';
import { useProjectStore } from '../../stores/projectStore';
import { useUiStore } from '../../stores/uiStore';
import { selectTemplate } from '../templates/actions';
import { applyPresetEntry } from '../templates/presets';
import { commandEnabled, trigger, useCommands } from '../../app/registry';
import { shortcutLabel, shortcutMap } from './shortcutState';

// 命令面板（6.4，Ctrl+K）：搜索操作（注册表里的命令）、模板、预设。

export function CommandPalette() {
  const { t, i18n } = useTranslation();
  const entries = useTemplateStore((s) => s.entries);
  const composing = useProjectStore((s) => s.composition !== null);
  const commands = useCommands();
  const overrides = useUiStore((s) => s.settings.shortcuts);
  const keys = new Map([...shortcutMap(commands, overrides).byKey].map(([k, id]) => [id, k]));
  const [presets, setPresets] = useState<PresetEntry[]>([]);
  useEffect(() => {
    void window.allay.presets.list().then(setPresets);
  }, []);
  const close = () => useUiStore.getState().openDialog(null);
  const run = (fn: () => void) => {
    close();
    // 等对话框关掉（焦点回到原处）再执行
    requestAnimationFrame(fn);
  };
  const templateName = (id: string) => {
    const e = entries.find((x) => x.id === id);
    return e ? localize(e.manifest.name, i18n.language) : id;
  };
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent showClose={false} className="top-[18%] w-[560px] translate-y-0 gap-0 p-0" data-testid="command-palette">
        <DialogTitle className="sr-only">{t('command.title')}</DialogTitle>
        <Command loop>
          <CommandInput autoFocus placeholder={t('command.placeholder')} aria-label={t('command.placeholder')} />
          <CommandList>
            <CommandEmpty>{t('command.empty')}</CommandEmpty>
            <CommandGroup heading={t('command.groups.actions')}>
              {commands
                .filter((c) => !c.hideInPalette && !c.input)
                .map((c) => {
                const enabled = commandEnabled(c);
                return (
                  <CommandItem key={c.id} value={`action ${t(c.titleKey)} ${c.id}`} disabled={!enabled} onSelect={() => run(() => trigger(c.id))} data-testid={`command-${c.id}`}>
                    {c.icon ? <c.icon size={ICON.sm} /> : <Lightning size={ICON.sm} />}
                    <span className="flex-1 truncate">{t(c.titleKey)}</span>
                    {keys.has(c.id) && <Kbd>{shortcutLabel(keys.get(c.id)!)}</Kbd>}
                  </CommandItem>
                );
              })}
            </CommandGroup>
            {!composing && <CommandGroup heading={t('command.groups.templates')}>
              {entries
                .filter((e) => !e.baseMissing)
                .map((e) => {
                  const name = localize(e.manifest.name, i18n.language);
                  return (
                    <CommandItem key={`${e.id}@${e.version}`} value={`template ${name} ${e.id}`} onSelect={() => run(() => void selectTemplate(e.id, e.version, i18n.language))}>
                      <FilmSlate size={ICON.sm} />
                      <span className="flex-1 truncate">{name}</span>
                      <span className="num text-xs text-fg-subtle">{e.version}</span>
                    </CommandItem>
                  );
                })}
            </CommandGroup>}
            {!composing && presets.length > 0 && (
              <CommandGroup heading={t('command.groups.presets')}>
                {presets.map((p) => (
                  <CommandItem key={p.id} value={`preset ${p.name} ${p.id}`} onSelect={() => run(() => void applyPresetEntry(p, i18n.language))}>
                    <SlidersHorizontal size={ICON.sm} />
                    <span className="flex-1 truncate">{p.name}</span>
                    <span className="truncate text-xs text-fg-muted">{templateName(p.template.id)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
