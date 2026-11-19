import { FontUsageFlag } from '@allay/template-sdk';
import { useTranslation } from 'react-i18next';
import { usePreviewStore } from '../../stores/previewStore';
import { useResourceStore } from '../../stores/resourceStore';
import { openAssetSettings } from '../resources/actions';

export function FontUsageHint({ clipId }: { clipId?: string }) {
  const { t } = useTranslation();
  const flags = usePreviewStore((state) => state.fontUsage.find((entry) => entry.clipId === clipId)?.flags ?? 0);
  const hasLibrary = useResourceStore((state) => Boolean(state.state?.library));
  const whole = Boolean(flags & FontUsageFlag.whole);
  const partial = Boolean(flags & FontUsageFlag.partial);
  if (!whole && !partial) return null;
  const message = whole && partial ? 'mixed' : whole ? 'whole' : 'partial';
  return (
    <div className="px-3.5 py-2 text-xs text-fg-muted" data-testid="font-usage-hint">
      <p>{t(`editor.font.usage.${message}`)}</p>
      {hasLibrary && (
        <button type="button" className="mt-1 text-foreground underline underline-offset-2" onClick={openAssetSettings}>
          {t('editor.font.usage.assets')}
        </button>
      )}
    </div>
  );
}
