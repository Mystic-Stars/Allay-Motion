import { useTranslation } from 'react-i18next';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useResourceStore } from '../../stores/resourceStore';
import { openAssetSettings } from './actions';

export function PanoramaFallbackHint({ clipId }: { clipId?: string }) {
  const { t } = useTranslation();
  const revision = useProjectStore((state) => state.revision);
  const hasLibrary = useResourceStore((state) => Boolean(state.state?.library));
  const fallback = usePreviewStore((state) => {
    const loaded = state.loaded;
    if (!loaded || loaded.revision !== revision) return false;
    const codes = clipId === undefined ? loaded.resourceNotices : loaded.clipResourceNotices?.find(({ id }) => id === clipId)?.notices;
    return codes?.includes('panorama-fallback') ?? false;
  });
  if (!fallback) return null;
  return (
    <div role="status" className="px-3.5 py-2 text-xs text-fg-muted" data-testid="panorama-fallback-hint">
      <p>{t('resources.panoramaFallback')}</p>
      {hasLibrary && (
        <button type="button" className="mt-1 text-foreground underline underline-offset-2" onClick={openAssetSettings}>
          {t('resources.openAssetSettings')}
        </button>
      )}
    </div>
  );
}
