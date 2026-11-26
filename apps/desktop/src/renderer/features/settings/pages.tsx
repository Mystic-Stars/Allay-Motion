import { Allay } from '@allay/mascot';
import { Button } from '@allay/ui/components/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@allay/ui/components/select';
import { ICON } from '@allay/ui/lib/icons';
import { ArrowClockwise, Compass, FolderSimple, MapTrifold, Trash, Warning, X } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FolderInfo, FolderKind, FoldersInfo } from '../../../shared/folders';
import { LANGUAGE_PREFS } from '../../../shared/settings';
import { CacheUsageSchema, type CacheUsage } from '../../../shared/resources';
import { trigger } from '../../app/registry';
import { notify } from '../../stores/noticeStore';
import { useUiStore } from '../../stores/uiStore';
import { useExportInfo } from '../export/exportInfo';
import { formatBytes } from '../resources/DownloadProgress';
import { ResourceStackPanel } from '../resources/ResourceStackPanel';
import { MotionChoice, ThemeChoice } from './choices';
import { CONTROL_W, SettingsPageHeader, SettingsRow, SettingsSection } from './layout';
import { OutputSettingsForm } from './OutputSettingsForm';
import { GUIDELINES_URL, ISSUES_URL, ThirdPartyList } from './ThirdPartyList';

// 设置对话框的各个分类（docs/06-ui-design.md 6.11），经注册表的 registerSettingsPage 挂上（app/core.tsx）。

export function GeneralPage() {
  const { t } = useTranslation();
  const language = useUiStore((s) => s.settings.language);
  return (
    <div className="flex flex-col">
      <SettingsPageHeader title={t('settings.pages.general')} description={t('settings.descriptions.general')} />
      <SettingsSection>
        <SettingsRow label={t('settings.language')} hint={t('settings.languageHint')}>
          <Select value={language} onValueChange={(v) => useUiStore.getState().update({ language: v as typeof language })}>
            <SelectTrigger className={CONTROL_W} aria-label={t('settings.language')} data-testid="settings-language">
              <SelectValue>{(v: unknown) => t(`settings.languages.${String(v)}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {LANGUAGE_PREFS.map((l) => (
                <SelectItem key={l} value={l}>
                  {t(`settings.languages.${l}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
      </SettingsSection>
      <SettingsSection title={t('settings.onboarding.title')}>
        <SettingsRow label={t('settings.onboarding.rerun')} hint={t('settings.onboarding.hint')}>
          <Button variant="secondary" data-testid="settings-rerun-onboarding" onClick={() => trigger('onboarding')}>
            <Compass size={ICON.sm} />
            {t('settings.onboarding.button')}
          </Button>
        </SettingsRow>
        <SettingsRow label={t('settings.tour.rerun')} hint={t('settings.tour.hint')}>
          <Button variant="secondary" data-testid="settings-rerun-tour" onClick={() => trigger('tour')}>
            <MapTrifold size={ICON.sm} />
            {t('settings.tour.button')}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

export function AppearancePage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col">
      <SettingsPageHeader title={t('settings.pages.appearance')} description={t('settings.descriptions.appearance')} />
      <SettingsSection title={t('settings.theme')}>
        <div className="pt-1 pb-2" data-testid="settings-theme">
          <ThemeChoice testId="settings-theme-choice" />
        </div>
      </SettingsSection>
      <SettingsSection title={t('settings.motionTitle')}>
        <SettingsRow label={t('settings.reducedMotion')} hint={t('settings.reducedMotionHint')}>
          <MotionChoice testId="settings-reduced-motion" />
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

export function AssetsPage() {
  const { t } = useTranslation();
  const [usage, setUsage] = useState<CacheUsage | null>(null);
  // 主进程交来的数据过一遍 schema：不合法时不显示读数
  const refresh = () => void window.allay.cache.usage().then((u) => setUsage(CacheUsageSchema.safeParse(u).data ?? null));
  useEffect(refresh, []);
  return (
    <div className="flex flex-col">
      <SettingsPageHeader title={t('settings.pages.assets')} description={t('settings.descriptions.assets')} />
      <SettingsSection title={t('settings.assetsStack')}>
        <ResourceStackPanel />
      </SettingsSection>
      <SettingsSection title={t('settings.cacheTitle')}>
        <SettingsRow
          label={t('settings.cache')}
          hint={
            <span className="num" data-testid="cache-usage">
              {usage ? t('settings.cacheUsage', { files: usage.files, size: formatBytes(usage.bytes), limit: formatBytes(usage.limit) }) : '…'}
            </span>
          }
        >
          <Button
            variant="secondary"
            onClick={() =>
              void window.allay.cache.clear().then(() => {
                refresh();
                notify('info', t('settings.cacheCleared'));
              })
            }
          >
            <Trash size={ICON.sm} />
            {t('settings.clearCache')}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

export function FolderRow({ info, onChange }: { info: FolderInfo; onChange(info: FolderInfo): void }) {
  const { t } = useTranslation();
  const kind = info.kind;
  const choose = async () => {
    const r = await window.allay.folders.choose(kind);
    if ('canceled' in r) return;
    if (r.ok) onChange(r.info);
    else notify('error', t(`settings.folders.chooseErrors.${r.error}`));
  };
  const problem = info.state === 'missing' || info.state === 'readonly';
  return (
    <SettingsRow label={t(`settings.folders.${kind}.label`)} hint={t(`settings.folders.${kind}.hint`)} stacked testId={`folder-${kind}`}>
      <div className="flex w-full min-w-0 flex-col gap-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-control min-w-0 flex-1 items-center gap-2 rounded-md bg-well px-2.5">
            <FolderSimple size={ICON.sm} className="shrink-0 text-fg-subtle" aria-hidden="true" />
            <span className={info.path ? 'truncate text-xs text-foreground select-text' : 'truncate text-xs text-fg-subtle'} title={info.path ?? undefined} data-testid={`folder-${kind}-path`} data-state={info.state}>
              {info.path ?? t(`settings.folders.${kind}.unset`)}
            </span>
          </div>
          <Button variant="secondary" data-testid={`folder-${kind}-choose`} onClick={() => void choose()}>
            {t('settings.folders.choose')}
          </Button>
          {info.path && (
            <Button variant="ghost" size="icon-sm" aria-label={t('settings.folders.reset')} data-testid={`folder-${kind}-reset`} onClick={() => void window.allay.folders.reset(kind).then(onChange)}>
              <X size={ICON.sm} />
            </Button>
          )}
        </div>
        {problem && (
          <p className="flex items-start gap-1.5 text-xs text-warning" role="status" data-testid={`folder-${kind}-problem`}>
            <Warning size={ICON.sm} className="mt-px shrink-0" aria-hidden="true" />
            {t(`settings.folders.problems.${info.state}`, { fallback: t(`settings.folders.${kind}.fallback`) })}
          </p>
        )}
      </div>
    </SettingsRow>
  );
}

export function FoldersPage() {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<FoldersInfo | null>(null);
  const refresh = () => void window.allay.folders.get().then(setFolders);
  useEffect(() => {
    refresh();
    // 窗口重新获得焦点时再查一次（移动硬盘插上、拔下）
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  const set = (kind: FolderKind) => (info: FolderInfo) => setFolders((f) => (f ? { ...f, [kind]: info } : f));
  return (
    <div className="flex flex-col" data-testid="settings-folders">
      <SettingsPageHeader title={t('settings.pages.folders')} description={t('settings.descriptions.folders')} />
      <SettingsSection>
        {folders ? (
          <>
            <FolderRow info={folders.project} onChange={set('project')} />
            <FolderRow info={folders.export} onChange={set('export')} />
          </>
        ) : (
          <div className="h-40" aria-busy="true" />
        )}
      </SettingsSection>
    </div>
  );
}

export function ExportPage() {
  const { t } = useTranslation();
  const info = useExportInfo((s) => s.info);
  const probing = useExportInfo((s) => s.probing);
  useEffect(() => void useExportInfo.getState().load(), []);
  const h264 = info?.h264 ?? null;
  return (
    <div className="flex flex-col">
      <SettingsPageHeader title={t('settings.pages.export')} description={t('settings.descriptions.export')} />
      <SettingsSection title={t('settings.projectOutput')} description={t('settings.projectOutputHint')}>
        <OutputSettingsForm />
      </SettingsSection>
      <SettingsSection title={t('settings.encoderTitle')}>
        <SettingsRow label={t('settings.ffmpeg')}>
          <span className="num text-xs text-fg-subtle" data-testid="ffmpeg-version">
            {info ? (info.available ? (info.version ?? t('settings.ffmpegUnknown')) : t('export.errors.ffmpegMissing')) : '…'}
          </span>
        </SettingsRow>
        <SettingsRow
          label={t('settings.encoders')}
          hint={
            <span className="num" data-testid="h264-encoder" title={h264 ? h264.attempts.map((a) => `${a.encoder}: ${a.result}${a.detail ? ` — ${a.detail}` : ''}`).join('\n') : undefined}>
              {probing ? t('settings.encoderProbing') : !info?.available ? t('export.errors.ffmpegMissing') : h264 ? (h264.encoder ?? t('settings.encoderNone')) : t('settings.encoderNotProbed')}
            </span>
          }
        >
          <Button variant="secondary" disabled={probing || !info?.available} data-testid="redetect-encoders" onClick={() => void useExportInfo.getState().probe(true)}>
            <ArrowClockwise size={ICON.sm} />
            {t('settings.redetect')}
          </Button>
        </SettingsRow>
      </SettingsSection>
    </div>
  );
}

export function AboutPage() {
  const { t } = useTranslation();
  const [version, setVersion] = useState('');
  useEffect(() => void window.allay.app.info().then((i) => setVersion(i.version)), []);
  return (
    <div className="flex flex-col">
      <SettingsSection>
        <div className="flex items-center gap-4 pb-1">
          <Allay clip="hover" size={56} priority="dialog" />
          <div className="flex flex-col gap-0.5">
            <span className="text-lg font-semibold">{t('brand.name')}</span>
            <span className="num text-xs text-fg-subtle" data-testid="about-version">
              {t('settings.version', { version })}
            </span>
          </div>
        </div>
        <p className="mt-3 text-xs whitespace-pre-line text-fg-muted" data-testid="about-disclaimer">
          {t('brand.disclaimer')}
        </p>
      </SettingsSection>
      <SettingsSection title={t('settings.license.title')} testId="about-license">
        <p className="text-xs text-fg-muted select-text">{t('settings.license.body', { url: ISSUES_URL })}</p>
        <p className="mt-1.5 text-xs text-fg-muted" data-testid="about-license-scope">
          {t('brand.licenseScope')}
        </p>
        <p className="mt-1.5 text-xs text-fg-muted select-text" data-testid="about-guidelines">
          {t('settings.guidelines', { url: GUIDELINES_URL })}
        </p>
      </SettingsSection>
      <SettingsSection title={t('settings.thirdParty')} testId="about-third-party">
        <ul className="flex flex-col gap-1 text-xs text-fg-muted">
          <li>{t('settings.licenses.ffmpeg')}</li>
          <li>{t('settings.licenses.unifont')}</li>
          <li>{t('settings.licenses.plex')}</li>
          <li>{t('settings.licenses.noto')}</li>
          <li>{t('settings.licenses.phosphor')}</li>
          <li>{t('settings.licenses.npm')}</li>
        </ul>
        <ThirdPartyList />
      </SettingsSection>
    </div>
  );
}
