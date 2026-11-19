import { Button } from '@allay/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@allay/ui/components/select';
import { ResourceStackList, type StackRow } from '@allay/ui/editor';
import { ICON } from '@allay/ui/lib/icons';
import { FolderPlus, Package, Trash, Warning } from '@phosphor-icons/react';
import type { TFunction } from 'i18next';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import type { LayerInfo } from '../../../shared/resources';
import { useResourceStore } from '../../stores/resourceStore';
import { addPack, selectVersion } from './actions';
import { formatPercent } from './DownloadProgress';
import { profileName, resourceLabels } from './resourceLabels';

// 资源栈弹层的内容（6.4）：自上而下列出各层（与解析顺序一致），每行拖动手柄、图标、名称、描述、类型徽标、开关、删除。
// 只有资源包能拖（dnd-kit，键盘可用）；原版层固定在资源包之下（decisions.md M2b）。v1 的内置层是空的，不列出。

export function layerDisplayName(t: TFunction, layer: LayerInfo): string {
  return layer.kind === 'vanilla' && layer.source !== 'bedrock' ? t('resources.vanillaName', { version: layer.name }) : layer.name;
}

/** 包图标的 blob: URL，随层的图标数据变 */
function useIconUrls(layers: readonly LayerInfo[]): Map<string, string> {
  const urls = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of layers) if (l.icon) m.set(l.id, URL.createObjectURL(new Blob([l.icon as Uint8Array<ArrayBuffer>], { type: 'image/png' })));
    return m;
  }, [layers]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return urls;
}

function QuickVersion({ layer, trigger, focusAfterAdd }: { layer?: LayerInfo; trigger: RefObject<HTMLButtonElement | null>; focusAfterAdd: RefObject<boolean> }) {
  const { t, i18n } = useTranslation();
  const state = useResourceStore((s) => s.state);
  const [pending, setPending] = useState(false);
  if (!state) return null;
  const profiles = state.library?.profiles.filter((profile) => !profile.missing) ?? [];
  const current = layer ? profiles.find((profile) => profile.id === (state.library?.activeProfileId ?? state.library?.pinnedId)) : undefined;
  const busy = state.download.status === 'running';
  const source = layer?.source === 'downloaded' || layer?.source === 'bedrock' ? layer.source : 'local';
  const missing = !layer && (state.vanilla.problem !== null || state.library?.profiles.some((profile) => profile.id === state.library?.pinnedId && profile.missing));
  const name = current ? profileName(current) : layer ? layerDisplayName(t, layer) : t(missing ? 'resources.library.missing' : 'resources.noVanilla');
  const sourceLabel = layer ? t(`resources.library.sources.${current?.source ?? source}`) : undefined;
  const versionText = (name: string, sourceLabel?: string) => (
    <span className="flex min-w-0 items-center gap-2">
      <span className="truncate" title={name}>{name}</span>
      {sourceLabel && <span className="shrink-0 text-xs text-fg-muted">{sourceLabel}</span>}
    </span>
  );
  if (profiles.length === 0) return <div className="text-sm" data-testid={layer ? undefined : 'vanilla-missing'}>{versionText(name, sourceLabel)}</div>;
  return (
    <Select<string> value={current?.id ?? null} onValueChange={(id) => {
      if (busy || pending || !id || id === current?.id) return;
      setPending(true);
      focusAfterAdd.current = !layer;
      void selectVersion(t, id).finally(() => {
        if (!useResourceStore.getState().state?.layers.some((entry) => entry.kind === 'vanilla')) focusAfterAdd.current = false;
        setPending(false);
      });
    }}>
      <SelectTrigger ref={trigger} className="w-full" aria-label={`${resourceLabels(i18n.language).current}: ${sourceLabel ? `${name} · ${sourceLabel}` : name}`} data-testid="resources-quick-version" aria-disabled={busy || pending}>
        <SelectValue className="min-w-0">{versionText(name, sourceLabel)}</SelectValue>
      </SelectTrigger>
      <SelectContent className="max-w-[min(400px,calc(100vw-16px))]">
        {profiles.map((profile) => <SelectItem key={profile.id} value={profile.id} disabled={busy || pending}>{versionText(profileName(profile), t(`resources.library.sources.${profile.source}`))}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}

export function ResourceStackPanel({ management = false, onManage }: { management?: boolean; onManage?: () => void }) {
  const { t, i18n } = useTranslation();
  const state = useResourceStore((s) => s.state);
  const quickTrigger = useRef<HTMLButtonElement>(null);
  const focusAfterAdd = useRef(false);
  const top = useMemo(() => (state ? [...state.layers].reverse().filter((l) => !(l.kind === 'builtin' && l.empty)) : []), [state]);
  const icons = useIconUrls(top);
  const vanilla = top.find((layer) => layer.kind === 'vanilla');
  const hasVanilla = Boolean(vanilla);
  useEffect(() => {
    if (!hasVanilla || !focusAfterAdd.current) return;
    focusAfterAdd.current = false;
    if (document.activeElement === document.body) quickTrigger.current?.focus();
  }, [hasVanilla]);
  if (!state) return null;
  const download = state.download;
  const replace = (p: Promise<typeof state>) => void p.then((s) => useResourceStore.getState().replace(s));
  const rows: StackRow[] = top.map((layer) => {
    const sub =
      layer.kind === 'vanilla'
        ? t(layer.source === 'bedrock' ? 'resources.library.sources.bedrock' : layer.source === 'downloaded' ? 'resources.vanillaDownloaded' : 'resources.vanillaLocal')
        : (layer.description ?? (layer.source === 'folder' ? t('resources.folder') : ''));
    const warning = layer.legacyFormat ? t('resources.legacy') : layer.warnings.length > 0 ? t('resources.skipped', { count: layer.warnings.length }) : undefined;
    return {
      id: layer.id,
      name: layerDisplayName(t, layer),
      description: sub,
      kindLabel: t(`resources.kinds.${layer.kind}`),
      iconUrl: icons.get(layer.id) ?? null,
      enabled: layer.enabled,
      sortable: layer.kind === 'pack' && !layer.id.startsWith('instance:'),
      locked: layer.kind === 'builtin',
      toggleDisabled: state.download.status === 'running' && layer.kind === 'vanilla',
      ...(warning ? { warning } : {}),
    };
  });
  return (
    <div className={management ? 'flex flex-col gap-3' : 'flex flex-col gap-2'} data-testid="resource-stack">
      <p className="text-xs text-fg-subtle">{t('resources.materialSource')}</p>
      <ResourceStackList
        rows={rows}
        // 列表给的是资源包从上到下的顺序；主进程要从下往上
        onReorder={(ids) => replace(window.allay.resources.reorder([...ids].reverse()))}
        onToggle={(id, enabled) => replace(window.allay.resources.setEnabled(id, enabled))}
        onRemove={management ? (id) => replace(window.allay.resources.removeLayer(id)) : undefined}
        renderLabel={!management && vanilla ? (row) => row.id === vanilla.id ? <QuickVersion layer={vanilla} trigger={quickTrigger} focusAfterAdd={focusAfterAdd} /> : null : undefined}
        labels={{
          drag: (name) => t('resources.drag', { name }),
          toggle: (name) => t('resources.toggle', { name }),
          remove: (name) => t('resources.remove', { name }),
        }}
      />
      {!management && !vanilla && <QuickVersion trigger={quickTrigger} focusAfterAdd={focusAfterAdd} />}
      {!management && download.status === 'running' && <p role="status" className="text-xs text-fg-muted">{t('resources.download.progress')} · {formatPercent(download.progress.fraction, false)}</p>}
      {management && state.brokenPacks.length > 0 && (
        <ul className="flex flex-col gap-0.5">
          {state.brokenPacks.map((b) => (
            <li key={b.id} data-testid="layer-broken" data-layer-id={b.id} className="flex items-center gap-2 py-1.5 pr-1 pl-6">
              <Warning size={ICON.md} className="shrink-0 text-warning" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{b.name}</p>
                <p className="text-xs text-warning">{t(`resources.broken.${b.problem}`)}</p>
              </div>
              <Button variant="ghost" size="icon-sm" aria-label={t('resources.remove', { name: b.name })} onClick={() => replace(window.allay.resources.removeLayer(b.id))}>
                <Trash size={ICON.md} />
              </Button>
            </li>
          ))}
        </ul>
      )}
      {management && state.vanilla.problem && (
        <p role="status" className="flex items-start gap-1 text-xs text-warning">
          <Warning size={ICON.sm} className="mt-0.5 shrink-0" aria-hidden="true" />
          {t('resources.vanillaProblem')}
        </p>
      )}
      <div className="flex flex-col gap-2">
        <div className={management ? 'flex flex-wrap gap-2' : 'flex flex-wrap items-center justify-between gap-2'}>
          <Button variant="secondary" data-testid="pack-add" onClick={() => void addPack(t, 'zip')}>
            <Package size={ICON.md} />
            {t('resources.addPack')}
          </Button>
          {management && <Button variant="ghost" data-testid="pack-add-folder" onClick={() => void addPack(t, 'folder')}>
            <FolderPlus size={ICON.md} />
            {t('resources.addFolder')}
          </Button>}
          {!management && onManage && <Button variant="ghost" data-testid="resources-manage" onClick={onManage}>
            {resourceLabels(i18n.language).manage}
          </Button>}
        </div>
        {management && <p className="text-xs text-fg-muted">{t('resources.dropHint')}</p>}
      </div>
    </div>
  );
}
