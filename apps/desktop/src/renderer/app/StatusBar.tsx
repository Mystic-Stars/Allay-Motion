import { diffFromDefaults } from '@allay/template-sdk';
import { ICON, ICON_WEIGHT } from '@allay/ui/lib/icons';
import { CheckCircle, CircleNotch, Export, WarningCircle } from '@phosphor-icons/react';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DevModeIndicator } from '../features/dev/devMode';
import { DevWatchStatus } from '../features/preview/DevWatchStatus';
import { usePreviewStore } from '../stores/previewStore';
import { useProjectStore } from '../stores/projectStore';
import { useResourceStore } from '../stores/resourceStore';
import { useUiStore } from '../stores/uiStore';

// 状态栏（6.4）：24 px，坐在底色上。左：状态（启动中、装载中、就绪、模板出错、导出中）与素材摘要；
// 右：已修改几项参数、播放时实测的预览帧率、版本号。只显示已有的信息，拿不到的不显示。

function useStatus(): { icon: ReactNode; text: string } {
  const { t } = useTranslation();
  const status = usePreviewStore((s) => s.status);
  const exporting = useUiStore((s) => s.exporting);
  if (exporting) return { icon: <Export size={ICON.sm - 1} weight={ICON_WEIGHT.active} className="text-primary-text" />, text: t('status.exporting') };
  switch (status.kind) {
    case 'ready':
      return { icon: <CheckCircle size={ICON.sm - 1} weight={ICON_WEIGHT.active} className="text-success" />, text: t('status.ready') };
    case 'starting':
    case 'loading':
      return { icon: <CircleNotch size={ICON.sm - 1} className="animate-spin text-fg-subtle" />, text: t(`status.${status.kind}`) };
    default:
      return { icon: <WarningCircle size={ICON.sm - 1} weight={ICON_WEIGHT.active} className="text-danger" />, text: t('status.error') };
  }
}

function useAssetSummary(): string | null {
  const { t } = useTranslation();
  const state = useResourceStore((s) => s.state);
  if (!state) return null;
  // 原版基底：最上面启用的原版层
  const vanilla = state.layers.find((l) => l.base === true);
  const packs = state.layers.filter((l) => l.kind === 'pack' && l.enabled && l.source !== 'imported').length;
  return vanilla ? t('status.assets', { version: vanilla.name, count: packs }) : t('status.assetsNoVanilla', { count: packs });
}

export function StatusBar() {
  const { t, i18n } = useTranslation();
  const status = useStatus();
  const assets = useAssetSummary();
  const template = useProjectStore((s) => s.template);
  const params = useProjectStore((s) => s.params);
  const fps = usePreviewStore((s) => s.measuredFps);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => void window.allay.app.info().then((i) => setVersion(i.version)), []);
  const changed = template ? Object.keys(diffFromDefaults(template.params, params, { locale: i18n.language })).length : 0;
  return (
    <footer role="contentinfo" aria-label={t('status.region')} data-testid="statusbar" className="flex h-statusbar shrink-0 items-center gap-[18px] px-2.5 text-xs text-fg-subtle">
      <span className="flex items-center gap-1.5" data-testid="status-state">
        {status.icon}
        {status.text}
      </span>
      <DevModeIndicator />
      {assets && <span className="truncate">{assets}</span>}
      <DevWatchStatus />
      <span className="flex-1" />
      {changed > 0 && <span data-testid="status-changed">{t('status.changed', { count: changed })}</span>}
      {fps !== null && (
        <span className="num" data-testid="status-fps">
          {t('status.previewFps', { fps: Math.round(fps) })}
        </span>
      )}
      {version && (
        <span className="num" data-testid="status-version">
          {t('status.version', { version })}
        </span>
      )}
    </footer>
  );
}
