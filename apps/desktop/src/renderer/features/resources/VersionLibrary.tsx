import { Button } from '@allay/ui/components/button';
import { Badge, Collapsible, CollapsibleContent, CollapsibleTrigger, Input } from '@allay/ui/components/misc';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@allay/ui/components/select';
import { Switch } from '@allay/ui/components/switch';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { InstancePackInfo, OfficialVersion, ResourceLocation, ResourceProfileInfo } from '../../../shared/resources';
import { useNoticeStore } from '../../stores/noticeStore';
import { useResourceStore } from '../../stores/resourceStore';
import { addPack, chooseGameDir, downloadVanilla, selectInstalledVersion, selectVersion } from './actions';
import { DownloadProgress } from './DownloadProgress';
import { profileName, resourceLabels } from './resourceLabels';

const replace = (state: Awaited<ReturnType<typeof window.allay.resources.layers>>) => useResourceStore.getState().replace(state);

function ProfileDetails({ profile, pinned, active, busy }: { profile: ResourceProfileInfo; pinned: boolean; active: boolean; busy: boolean }) {
  const { t } = useTranslation();
  const [showPacks, setShowPacks] = useState(false);
  const [packs, setPacks] = useState<InstancePackInfo[] | null>(null);
  const [pending, setPending] = useState(false);
  const error = () => useNoticeStore.getState().show('error', t('resources.library.unavailable'));
  const { id, source, stamp } = profile;
  useEffect(() => {
    if (!showPacks) return;
    let current = true;
    void window.allay.resources.instancePacks(id).then((entries) => { if (current) setPacks(entries); }, () => { if (current) setPacks([]); });
    return () => { current = false; };
  }, [id, showPacks, stamp]);

  const locate = (target: ResourceLocation) => void window.allay.resources.locateProfile(id, target).then((found) => { if (!found) error(); }, error);
  const toggle = async (pack: InstancePackInfo, enabled: boolean) => {
    setPending(true);
    try {
      replace(await window.allay.resources.setInstancePack(id, pack.id, enabled));
      setPacks(await window.allay.resources.instancePacks(id));
    } catch { error(); }
    finally { setPending(false); }
  };
  return (
    <section aria-label={profileName(profile)} data-testid="resource-profile-details" className="flex min-w-0 flex-col gap-3 rounded-lg bg-surface-1 p-3">
      <header>
        <h3 className="break-words font-semibold">{profileName(profile)}</h3>
        <p className="text-xs text-fg-muted">{t(`resources.library.sources.${source}`)}{profile.versionType && ` · ${t(`resources.library.types.${profile.versionType}`, { defaultValue: profile.versionType })}`}</p>
      </header>
      {!(profile.missing && source === 'downloaded') && <div className="flex flex-wrap gap-1">
        {!profile.missing && <Button variant="secondary" size="sm" disabled={busy || pending || (pinned && active)} onClick={() => {
          setPending(true);
          void selectVersion(t, id).finally(() => setPending(false));
        }}>{t('resources.library.use')}</Button>}
        {!profile.missing && source === 'local' && <Button variant="ghost" size="sm" aria-expanded={showPacks} onClick={() => setShowPacks(!showPacks)}>{t('resources.library.instancePacks')}</Button>}
        {profile.missing && source === 'local' && <Button variant="secondary" size="sm" onClick={() => void chooseGameDir(t, id)}>{t('resources.library.reconnect')}</Button>}
        {profile.missing && source === 'bedrock' && <>
          <Button variant="secondary" size="sm" onClick={() => void addPack(t, 'zip', id)}>{t('resources.library.reconnectFile')}</Button>
          <Button variant="ghost" size="sm" onClick={() => void addPack(t, 'folder', id)}>{t('resources.library.reconnectFolder')}</Button>
        </>}
      </div>}
      {source === 'downloaded' && !busy && <Collapsible>
        <CollapsibleTrigger render={<Button variant="secondary" size="sm" />}>
          {t('resources.library.redownload')}
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-2 pt-2">
          <p className="text-xs text-fg-muted">{t('resources.download.note')}</p>
          <Button variant="secondary" size="sm" className="self-start" onClick={() => downloadVanilla(profile.versionId)}>{t('resources.library.downloadSelected')}</Button>
        </CollapsibleContent>
      </Collapsible>}
      <dl className="flex flex-col gap-2 text-xs">
        {([['game', profile.gameDir], ['packs', profile.resourcePacksDir], ['source', profile.sourcePath]] as const).map(([target, path]) => path && (
          <div key={target} className="flex min-w-0 flex-col gap-1">
            <dt className="font-medium">{t(`resources.library.paths.${target}`)}</dt>
            <dd className="flex flex-wrap items-start gap-x-2">
              <span className="min-w-0 flex-1 break-all select-text text-fg-muted">{path}</span>
              {!profile.missing && <Button size="sm" variant="ghost" aria-label={`${t('resources.library.locate')} · ${t(`resources.library.paths.${target}`)}`} onClick={() => locate(target)}>{t('resources.library.locate')}</Button>}
            </dd>
          </div>
        ))}
      </dl>
      {showPacks && <div className="flex flex-col gap-1 text-xs">
        {packs?.length === 0 && <p className="text-fg-muted">{t('resources.library.noInstancePacks')}</p>}
        {packs?.map((pack) => <div key={pack.id} className="flex items-start gap-2" title={pack.path}>
          <Switch aria-label={pack.name} checked={pack.enabled} disabled={pending || (pack.missing && !pack.enabled)} onCheckedChange={(enabled) => void toggle(pack, enabled)} />
          <span>{pack.name}{pack.missing && ` · ${t('resources.library.missing')}`}</span>
        </div>)}
      </div>}
    </section>
  );
}

function OfficialVersionSearch({ busy }: { busy: boolean }) {
  const { t } = useTranslation();
  const [versions, setVersions] = useState<OfficialVersion[] | null>(null);
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const matches = versions?.filter((entry) => entry.versionId.toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const version = matches.find((entry) => entry.versionId === selected)?.versionId ?? matches[0]?.versionId ?? '';
  const search = async () => {
    setLoading(true);
    setFailed(false);
    try { setVersions(await window.allay.resources.officialVersions()); }
    catch { setFailed(true); }
    finally { setLoading(false); }
  };
  return <div className="flex flex-col gap-2">
    <Button variant="ghost" size="sm" className="self-start" disabled={busy || loading} onClick={() => void search()}>{t('resources.library.fetchOfficial')}{loading && '…'}</Button>
    {failed && <p role="status" className="text-xs text-warning">{t('resources.library.offline')}</p>}
    {versions && <>
      <Input type="search" value={query} aria-label={t('resources.library.searchOfficial')} placeholder={t('resources.library.searchOfficial')} onChange={(event) => setQuery(event.target.value)} />
      {version ? <div className="flex flex-wrap items-center gap-2">
        <Select<string> disabled={busy} value={version} onValueChange={(id) => setSelected(id ?? '')}>
          <SelectTrigger aria-label={t('resources.library.officialVersion')}><SelectValue>{version}</SelectValue></SelectTrigger>
          <SelectContent>{matches.map((entry) => <SelectItem key={entry.versionId} value={entry.versionId}>{entry.versionId}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => downloadVanilla(version)}>{t('resources.library.downloadSelected')}</Button>
      </div> : <p className="text-xs text-fg-muted">{t('resources.library.noResults')}</p>}
    </>}
  </div>;
}

export function VersionLibrary() {
  const { t, i18n } = useTranslation();
  const state = useResourceStore((store) => store.state);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (!state) return null;
  const { library, download, vanilla } = state;
  const busy = download.status === 'running';
  const labels = resourceLabels(i18n.language);
  const filtered = library?.profiles.filter((entry) => [entry.name, entry.versionId, entry.gameDir, entry.sourcePath, t(`resources.library.sources.${entry.source}`)].some((value) => value?.toLowerCase().includes(query.trim().toLowerCase()))) ?? [];
  const selected = filtered.find((profile) => profile.id === (selectedId ?? library?.activeProfileId ?? library?.pinnedId)) ?? filtered[0];
  const retryAvailable = download.status === 'failed' || download.status === 'canceled';
  return <div className="flex min-w-0 flex-col gap-3" data-testid="version-library">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" data-testid="vanilla-choose-dir" onClick={() => void chooseGameDir(t)}>{t('resources.findGame')}</Button>
      {library && <Button size="sm" variant="ghost" disabled={state.detecting} onClick={() => void window.allay.resources.detectMinecraft().then(replace, () => {
        useNoticeStore.getState().show('error', t('resources.library.unavailable'));
      })}>{t('resources.library.rescan')}</Button>}
      {library?.pinnedId && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void selectVersion(t, null)}>{t('resources.library.unpin')}</Button>}
      {!library && vanilla.local && vanilla.consent !== true && <Button size="sm" variant="secondary" data-testid="vanilla-use-local" onClick={() => void selectInstalledVersion()}>{t('resources.useLocal', { version: vanilla.local.versionId })}</Button>}
    </div>
    {library && <>
      <Input type="search" aria-label={t('resources.library.search')} placeholder={t('resources.library.search')} value={query} onChange={(event) => setQuery(event.target.value)} />
      {selected ? <div className="grid min-w-0 items-start gap-3 @min-[460px]:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <ul aria-label={t('resources.library.title')} className="flex max-h-60 min-w-0 flex-col gap-1 overflow-y-auto rounded-lg bg-well p-1.5">
          {filtered.map((profile) => <li key={profile.id}>
            <Button variant="ghost" aria-pressed={profile.id === selected.id} className="h-auto w-full flex-col items-start gap-1 px-2 py-1.5 text-left" data-testid="resource-profile" data-source={profile.source} onClick={() => setSelectedId(profile.id)}>
              <span className="w-full truncate" title={profileName(profile)}>{profileName(profile)}</span>
              <span className="w-full truncate text-xs font-normal text-fg-muted">{t(`resources.library.sources.${profile.source}`)}</span>
              {(profile.id === library.activeProfileId || profile.id === library.pinnedId || profile.missing) && <span className="flex flex-wrap gap-1 whitespace-normal">
                {profile.id === library.activeProfileId && <Badge>{t('resources.library.active')}</Badge>}
                {profile.id === library.pinnedId && <Badge>{t('resources.library.pinned')}</Badge>}
                {profile.missing && <Badge variant="warning">{t('resources.library.missing')}</Badge>}
              </span>}
            </Button>
          </li>)}
        </ul>
        <ProfileDetails key={selected.id} profile={selected} pinned={selected.id === library.pinnedId} active={selected.id === library.activeProfileId} busy={busy} />
      </div> : <p className="text-xs text-fg-muted">{t('resources.library.noResults')}</p>}
    </>}
    <div className="flex flex-col gap-2">
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="secondary" data-testid="resources-download-options" />}>
          {labels.download}
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-2 pt-2">
          {!busy && <>
            <p className="text-xs leading-relaxed text-fg-muted" data-testid="download-note">{t('resources.download.note')}</p>
            {!retryAvailable && <Button variant="secondary" className="self-start" data-testid="vanilla-download" onClick={() => downloadVanilla()}>{labels.latest}</Button>}
          </>}
          {library && <OfficialVersionSearch busy={busy} />}
        </CollapsibleContent>
      </Collapsible>
      {download.status !== 'idle' && <DownloadProgress state={download} />}
    </div>
  </div>;
}
