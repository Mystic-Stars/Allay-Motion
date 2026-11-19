import { Button } from '@allay/ui/components/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@allay/ui/components/popover';
import { ICON } from '@allay/ui/lib/icons';
import { Stack } from '@phosphor-icons/react';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useResourceStore } from '../../stores/resourceStore';
import { useUiStore } from '../../stores/uiStore';
import { openAssetSettings } from './actions';
import { layerDisplayName, ResourceStackPanel } from './ResourceStackPanel';

// 顶栏的素材按钮（6.4）：显示最上层启用的那一层（图标和名称），点开是资源栈弹层（shadcn Popover）。

export function ResourceButton() {
  const { t } = useTranslation();
  const trigger = useRef<HTMLButtonElement>(null);
  const manageAfterClose = useRef(false);
  const state = useResourceStore((s) => s.state);
  const open = useUiStore((s) => s.resourcesOpen);
  const top = state ? [...state.layers].reverse().find((l) => l.enabled && !(l.kind === 'builtin' && l.empty)) : undefined;
  const label = top ? t('resources.button', { name: layerDisplayName(t, top) }) : t('resources.buttonNone');
  // 顶栏只显示图标和名称（如“Minecraft 1.21.1”），完整说明放在读屏标签里
  const short = top ? layerDisplayName(t, top) : t('resources.buttonNone');
  const icon = useMemo(() => (top?.icon ? URL.createObjectURL(new Blob([top.icon as Uint8Array<ArrayBuffer>], { type: 'image/png' })) : null), [top?.icon]);
  useEffect(() => () => {
    if (icon) URL.revokeObjectURL(icon);
  }, [icon]);

  return (
    <Popover
      open={open}
      onOpenChange={(o) => useUiStore.getState().setResourcesOpen(o)}
      onOpenChangeComplete={(isOpen) => {
        if (isOpen || !manageAfterClose.current) return;
        manageAfterClose.current = false;
        trigger.current?.focus();
        openAssetSettings();
      }}
    >
      <PopoverTrigger
        render={<Button ref={trigger} variant="ghost" className="app-no-drag h-[30px] max-w-64 gap-[7px] rounded-lg px-2.5 font-normal" data-testid="resources-button" aria-label={`${t('resources.buttonLabel')}: ${label}`} />}
      >
        {icon ? <img src={icon} alt="" className="pixelated size-4 rounded-[3px]" /> : <Stack size={ICON.md} />}
        <span className="truncate">{short}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[400px] max-h-[min(70vh,600px)]" data-testid="resources-popover" aria-label={t('resources.title')}>
        <PopoverTitle className="mb-2 text-base font-semibold">{t('resources.title')}</PopoverTitle>
        <ResourceStackPanel onManage={() => {
          manageAfterClose.current = true;
          useUiStore.getState().setResourcesOpen(false);
        }} />
      </PopoverContent>
    </Popover>
  );
}
