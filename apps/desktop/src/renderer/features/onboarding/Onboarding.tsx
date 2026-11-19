import { AllayHead } from '@allay/mascot';
import { Button } from '@allay/ui/components/button';
import { ICON } from '@allay/ui/lib/icons';
import { cn } from '@allay/ui/lib/utils';
import { ResourceThumb } from '@allay/ui/editor';
import { ArrowLeft, ArrowRight, Check, CheckCircle, Clock, CloudArrowDown, FolderOpen, FolderSimple, GameController, type Icon } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { FoldersInfo, FolderInfo, FolderKind } from '../../../shared/folders';
import { titlebarInsets } from '../../app/titlebarChrome';
import { resolveLanguage, systemLocale } from '../../i18n';
import { useResourceStore } from '../../stores/resourceStore';
import { useUiStore } from '../../stores/uiStore';
import { chooseGameDir, downloadVanilla, selectInstalledVersion } from '../resources/actions';
import { DownloadProgress } from '../resources/DownloadProgress';
import { LanguageChoice, MotionChoice, ThemeChoice } from '../settings/choices';
import { FolderRow } from '../settings/pages';
import { Companion, CompanionIsland, CompanionScenery, SpeechBubble } from './Companion';

// 首次启动引导（docs/06-ui-design.md 6.10）：整页，盖住主界面。版面参照 Windows 的开箱设置：左边一大块插画区，
// 吉祥物陪着（每一步不同的姿态和一句话），右边是步骤进度、这一步的标题、说明和选项，底部固定“上一步 / 跳过这一步 / 继续”。
// 语言和主题选了立刻生效；素材这一步只有用户点了“开始下载”才联网（说明文字和资源栈弹层里的一样），进度用分阶段的组件（6.12），
// 下载中由进度条上的吉祥物接手（export 优先级，全应用只此一只）。每一步都能返回、能跳过；“跳过引导”直接结束。
// 走完或跳过都记进设置（ui.onboardingCompleted），帮助菜单和设置里可以重新运行。换步时内容按方向滑入、淡入；减少动效时没有动画。

export const ONBOARDING_STEPS = ['language', 'appearance', 'assets', 'folders', 'done'] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

type AssetChoice = 'download' | 'local' | 'later';

/**
 * 步骤进度（6.10）：一排编号圆点和名称，用细线连起来；走过的是成功色对勾，当前步是强调色。
 * 走过的步骤可以点回去。每一步当前选的值放在 title 里（悬停可见），完成页另有摘要
 */
function Stepper({ step, visited, go, summaries }: { step: OnboardingStep; visited: number; go(s: OnboardingStep): void; summaries: Record<OnboardingStep, string> }) {
  const { t } = useTranslation();
  const current = ONBOARDING_STEPS.indexOf(step);
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label={t('onboarding.stepsLabel')} data-testid="onboarding-stepper">
      {ONBOARDING_STEPS.map((s, i) => {
        const active = i === current;
        const reachable = i <= visited;
        const done = i < current || (i <= visited && i !== current && s !== 'done');
        return (
          <li key={s} className="flex items-center gap-1.5">
            {i > 0 && <span aria-hidden="true" className={cn('h-px w-2 shrink-0 transition-colors duration-(--dur-2) xl:w-6 2xl:w-10', i <= visited ? 'bg-primary' : 'bg-divider')} />}
            <button
              type="button"
              disabled={!reachable}
              aria-current={active ? 'step' : undefined}
              title={reachable && summaries[s] ? summaries[s] : undefined}
              data-testid={`onboarding-rail-${s}`}
              onClick={() => go(s)}
              className={cn(
                'flex h-8 items-center gap-1.5 rounded-full pr-2 pl-1 text-left transition-colors duration-(--dur-2) outline-none',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)',
                active ? 'bg-control-hi' : reachable ? 'hover:bg-control' : 'cursor-default',
              )}
            >
              <span
                className={cn(
                  'num flex size-6 shrink-0 items-center justify-center rounded-full text-2xs',
                  active ? 'bg-primary text-primary-foreground' : done ? 'bg-primary-soft text-primary-text' : 'bg-well text-fg-subtle',
                )}
              >
                {done && !active ? <Check size={12} weight="bold" aria-hidden="true" /> : i + 1}
              </span>
              <span className={cn('text-xs whitespace-nowrap', active ? 'font-medium text-foreground' : reachable ? 'text-fg-muted' : 'text-fg-subtle')}>{t(`onboarding.steps.${s}.name`)}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function OptionCard({ icon: IconC, title, detail, selected, disabled, onSelect, testId, children }: { icon: Icon; title: string; detail: ReactNode; selected: boolean; disabled?: boolean; onSelect(): void; testId: string; children?: ReactNode }) {
  return (
    <div
      // 选中只靠外框，底色不变：卡片里的进度条轨道（control-hi）在 control 底上看得见
      className={cn('flex flex-col rounded-lg bg-control transition-colors duration-(--dur-1)', selected && 'shadow-[0_0_0_2px_var(--surface-1),0_0_0_4px_var(--primary)]', disabled && 'opacity-60')}
      data-testid={testId}
      data-selected={selected || undefined}
    >
      <button
        type="button"
        role="radio"
        aria-checked={selected}
        disabled={disabled}
        onClick={onSelect}
        className="flex items-start gap-3.5 rounded-lg p-4 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ring)"
      >
        <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', selected ? 'bg-primary-soft text-primary-text' : 'bg-well text-fg-muted')}>
          <IconC size={18} weight={selected ? 'fill' : 'regular'} />
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium text-foreground">{title}</span>
          <span className="text-xs leading-relaxed text-fg-subtle">{detail}</span>
        </span>
      </button>
      {selected && children && <div className="flex flex-col gap-3 px-4 pt-0 pb-4 pl-[66px]">{children}</div>}
    </div>
  );
}

function AssetsStep({ choice, setChoice }: { choice: AssetChoice | null; setChoice(c: AssetChoice): void }) {
  const { t } = useTranslation();
  const state = useResourceStore((s) => s.state);
  if (!state) return null;
  const { vanilla, download } = state;
  const active = state.library?.profiles.find((profile) => profile.id === state.library?.activeProfileId)?.versionId
    ?? (vanilla.active === 'local' ? vanilla.local?.versionId : vanilla.active === 'cached' ? vanilla.cached?.versionId : null);
  const showProgress = download.status !== 'idle';
  return (
    <div className="-m-1 flex flex-col gap-3 p-1" role="radiogroup" aria-label={t('onboarding.steps.assets.name')}>
      {active && (
        <p className="flex items-center gap-2 text-sm text-foreground" data-testid="onboarding-assets-active">
          <CheckCircle size={ICON.md} weight="fill" className="text-success" />
          {t('onboarding.assets.active', { version: active })}
        </p>
      )}
      <OptionCard
        icon={CloudArrowDown}
        title={t('onboarding.assets.download.title')}
        detail={t('onboarding.assets.download.detail')}
        selected={choice === 'download'}
        onSelect={() => setChoice('download')}
        testId="onboarding-asset-download"
      >
        {showProgress ? (
          <DownloadProgress state={download as Exclude<typeof download, { status: 'idle' }>} size="large" />
        ) : (
          <>
            <p className="text-xs leading-relaxed text-fg-muted" data-testid="download-note">
              {t('resources.download.note')}
            </p>
            <p className="text-xs text-fg-subtle">{t('onboarding.assets.download.consent')}</p>
            <Button variant="secondary" className="self-start" data-testid="vanilla-download" onClick={() => downloadVanilla()}>
              <CloudArrowDown size={ICON.sm} />
              {t('onboarding.assets.download.start')}
            </Button>
          </>
        )}
      </OptionCard>
      <OptionCard
        icon={GameController}
        title={vanilla.local ? t('onboarding.assets.local.found', { version: vanilla.local.versionId }) : t('onboarding.assets.local.title')}
        detail={vanilla.local ? t('onboarding.assets.local.foundDetail', { dir: vanilla.local.gameDir }) : t('onboarding.assets.local.detail')}
        selected={choice === 'local'}
        onSelect={() => setChoice('local')}
        testId="onboarding-asset-local"
      >
        {vanilla.local ? (
          vanilla.active === 'local' ? (
            <p className="text-xs text-fg-muted">{t('onboarding.assets.local.using')}</p>
          ) : (
            <Button variant="secondary" className="self-start" data-testid="vanilla-use-local" onClick={() => void selectInstalledVersion()}>
              <GameController size={ICON.sm} />
              {t('resources.useLocal', { version: vanilla.local.versionId })}
            </Button>
          )
        ) : (
          <Button variant="secondary" className="self-start" data-testid="vanilla-choose-dir" onClick={() => void chooseGameDir(t)}>
            <FolderOpen size={ICON.sm} />
            {t('resources.findGame')}
          </Button>
        )}
      </OptionCard>
      <OptionCard icon={Clock} title={t('onboarding.assets.later.title')} detail={t('onboarding.assets.later.detail')} selected={choice === 'later'} onSelect={() => setChoice('later')} testId="onboarding-asset-later" />
    </div>
  );
}

/**
 * 语言这一步的即时预览：主界面的缩略示意，用当前的主题变量和当前语言的真实文案（菜单、面板标题、轨道名、状态），
 * 选了语言立刻跟着变。只是示意，不可交互、读屏跳过。
 */
function LivePreview() {
  const { t } = useTranslation();
  const label = 'text-[9px] leading-none';
  return (
    <figure className="flex flex-col gap-2" data-testid="onboarding-preview">
      <figcaption className="text-xs text-fg-subtle">{t('onboarding.previewLabel')}</figcaption>
      <div aria-hidden="true" className="flex aspect-[16/11] w-full flex-col gap-[3px] overflow-hidden rounded-lg bg-background p-[4px] select-none">
        <div className="flex h-[16px] shrink-0 items-center gap-[6px] px-[3px]">
          <span className="size-[9px] rounded-[2px] bg-allay" />
          {(['file', 'edit', 'view', 'help'] as const).map((m) => (
            <span key={m} className={cn(label, 'text-fg-muted')}>
              {t(`menu.${m}`)}
            </span>
          ))}
          <span className={cn(label, 'ml-auto rounded-[3px] bg-primary px-[5px] py-[2px] font-semibold text-primary-foreground')}>{t('topbar.export')}</span>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[26%_1fr_28%] gap-[3px]">
          <div className="flex flex-col gap-[4px] rounded-[5px] bg-surface-1 p-[5px]">
            <span className={cn(label, 'font-semibold text-foreground')}>{t('gallery.title')}</span>
            <div className="grid grid-cols-2 gap-[3px]">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={cn('aspect-video rounded-[2px] bg-well', i === 0 && 'shadow-[0_0_0_1px_var(--primary)]')} />
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-[4px] rounded-[5px] bg-viewer p-[5px]">
            <span className={cn(label, 'font-semibold text-foreground')}>{t('preview.title')}</span>
            <span className="m-auto aspect-video w-[78%] rounded-[2px] bg-(--checker-b)" />
          </div>
          <div className="row-span-2 flex flex-col gap-[5px] rounded-[5px] bg-surface-1 p-[5px]">
            <span className={cn(label, 'font-semibold text-foreground')}>
              {t('params.tabs.props')} <span className="font-normal text-fg-subtle">{t('params.tabs.output')}</span>
            </span>
            {[38, 64, 22, 50].map((w, i) => (
              <span key={i} className="relative h-[8px] overflow-hidden rounded-[2px] bg-control">
                <span className="absolute inset-y-0 left-0 bg-primary-soft" style={{ width: `${w}%` }} />
              </span>
            ))}
          </div>
          <div className="col-span-2 flex flex-col justify-center gap-[3px] rounded-[5px] bg-surface-1 px-[5px] py-[4px]">
            {(['stages', 'sound', 'cut'] as const).map((k, i) => (
              <div key={k} className="flex items-center gap-[4px]">
                <span className={cn(label, 'w-[38px] shrink-0 truncate text-fg-muted')}>{t(`timeline.${k}`)}</span>
                <span className="flex h-[7px] flex-1 gap-[1px] overflow-hidden rounded-[2px] bg-well">
                  {i === 0 && (
                    <>
                      <span className="w-[42%] bg-stage-enter" />
                      <span className="w-[10%] bg-stage-hold" />
                      <span className="w-[42%] bg-stage-exit" />
                    </>
                  )}
                  {i === 2 && <span className="ml-[50%] w-[5px] bg-mark" />}
                </span>
              </div>
            ))}
          </div>
        </div>
        <span className={cn(label, 'shrink-0 px-[3px] pt-[1px] text-fg-subtle')}>{t('status.ready')}</span>
      </div>
    </figure>
  );
}

function FoldersStep() {
  const [folders, setFolders] = useState<FoldersInfo | null>(null);
  useEffect(() => void window.allay.folders.get().then(setFolders), []);
  const set = (kind: FolderKind) => (info: FolderInfo) => setFolders((f) => (f ? { ...f, [kind]: info } : f));
  if (!folders) return <div className="h-40" aria-busy="true" />;
  return (
    <div className="flex flex-col gap-2" data-testid="onboarding-folders">
      <FolderRow info={folders.project} onChange={set('project')} />
      <div className="border-t border-divider" />
      <FolderRow info={folders.export} onChange={set('export')} />
    </div>
  );
}

function DoneStep({ summaries }: { summaries: Record<OnboardingStep, string> }) {
  const { t } = useTranslation();
  const rows: [OnboardingStep, string][] = [
    ['language', summaries.language],
    ['appearance', summaries.appearance],
    ['assets', summaries.assets],
    ['folders', summaries.folders],
  ];
  return (
    <dl className="grid max-w-xl grid-cols-[140px_1fr] gap-x-6 gap-y-3" data-testid="onboarding-summary">
      {rows.map(([s, v]) => (
        <div key={s} className="contents">
          <dt className="text-sm text-fg-muted">{t(`onboarding.steps.${s}.name`)}</dt>
          <dd className="text-sm text-foreground" data-testid={`onboarding-summary-${s}`}>
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}


/** 这一步吉祥物的姿态和说的话（素材这一步跟着下载状态变） */
function useCompanionPose(step: OnboardingStep): { clip: 'hover' | 'fly' | 'dance' | 'sad'; line: string; carry?: ReactNode; facing: 'left' | 'right' } {
  const { t } = useTranslation();
  const download = useResourceStore((s) => s.state?.download.status ?? 'idle');
  const active = useResourceStore((s) => s.state?.vanilla.active ?? null);
  const tourPending = useUiStore((s) => !s.settings.tourCompleted);
  const mascot = t('brand.mascot');
  switch (step) {
    case 'language':
      return { clip: 'hover', facing: 'right', line: t('onboarding.mascot.language', { mascot }) };
    case 'appearance':
      return { clip: 'hover', facing: 'left', line: t('onboarding.mascot.appearance') };
    case 'assets':
      if (download === 'running') return { clip: 'fly', facing: 'right', line: t('onboarding.mascot.assetsRunning') };
      if (download === 'failed' || download === 'canceled') return { clip: 'sad', facing: 'right', line: t('onboarding.mascot.assetsFailed') };
      if (download === 'done' || active) return { clip: 'dance', facing: 'right', line: t('onboarding.mascot.assetsDone') };
      return { clip: 'hover', facing: 'right', line: t('onboarding.mascot.assets'), carry: <ResourceThumb kind="block" id="minecraft:grass_block" size={28} /> };
    case 'folders':
      return { clip: 'hover', facing: 'left', line: t('onboarding.mascot.folders'), carry: <FolderSimple size={26} weight="fill" className="text-mark" /> };
    case 'done':
      return { clip: 'dance', facing: 'right', line: tourPending ? t('onboarding.mascot.doneTour') : t('onboarding.mascot.done') };
  }
}

/** 每一步吉祥物在插画区里的横向位置（占它自身宽度的比例），换步时挪一点，像是跟着你走 */
const COMPANION_SHIFT: Record<OnboardingStep, number> = { language: -0.18, appearance: 0.14, assets: -0.08, folders: 0.18, done: 0 };

/**
 * 左侧的插画区：欢迎语、吉祥物和它的气泡、脚下的小方块、漂着的像素方块。换步时吉祥物挪位置
 * （transform 过渡，--dur-4），气泡里的话换掉时轻轻弹出；减少动效时都没有动画。
 */
function Illustration({ step }: { step: OnboardingStep }) {
  const { t } = useTranslation();
  const pose = useCompanionPose(step);
  return (
    <section className="relative flex w-[40%] max-w-[560px] min-w-[340px] shrink-0 flex-col overflow-hidden rounded-xl bg-surface-1" aria-label={t('onboarding.illustrationLabel')} data-testid="onboarding-illustration">
      <CompanionScenery />
      <div className="relative flex flex-col gap-2 px-9 pt-[clamp(28px,7vh,72px)]">
        <h1 className="text-xl font-semibold">{t('onboarding.welcome', { name: t('brand.name') })}</h1>
        <p className="max-w-[44ch] text-sm leading-relaxed text-fg-subtle">{t('onboarding.intro')}</p>
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-8 pb-6">
        <div className="onboarding-companion flex flex-col items-center" style={{ transform: `translateX(${COMPANION_SHIFT[step] * 100}%)` }}>
          <SpeechBubble key={`${step}:${pose.line}`} tail="bottom" className="mb-5 max-w-[300px]" testId="onboarding-bubble">
            {pose.line}
          </SpeechBubble>
          <Companion clip={pose.clip} size={150} facing={pose.facing} carry={pose.carry} />
          <div className="-mt-8">
            <CompanionIsland />
          </div>
        </div>
      </div>
      <p className="relative px-9 pb-6 text-xs leading-relaxed text-fg-subtle">{t('onboarding.changeLater')}</p>
    </section>
  );
}

export function Onboarding() {
  const { t } = useTranslation();
  const settings = useUiStore((s) => s.settings);
  const resources = useResourceStore((s) => s.state);
  const [step, setStep] = useState<OnboardingStep>('language');
  const [visited, setVisited] = useState(0);
  // 换步的方向：内容从右边（前进）或左边（返回）滑进来
  const [dir, setDir] = useState<'forward' | 'back'>('forward');
  const [assetChoice, setAssetChoice] = useState<AssetChoice | null>(null);
  const [folders, setFolders] = useState<FoldersInfo | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const idx = ONBOARDING_STEPS.indexOf(step);

  // 文件夹的摘要：进到“完成”时再查一次
  useEffect(() => {
    if (step === 'done' || step === 'folders') void window.allay.folders.get().then(setFolders);
  }, [step]);
  // 换步时把焦点放回这一步的标题（键盘、读屏用户知道到了哪里）
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('#onboarding-title')?.focus();
  }, [step]);

  const go = (s: OnboardingStep) => {
    const i = ONBOARDING_STEPS.indexOf(s);
    setDir(i < idx ? 'back' : 'forward');
    setStep(s);
    setVisited((v) => Math.max(v, i));
  };
  const next = () => go(ONBOARDING_STEPS[Math.min(idx + 1, ONBOARDING_STEPS.length - 1)]!);
  const back = () => go(ONBOARDING_STEPS[Math.max(idx - 1, 0)]!);
  const finish = () => {
    // 引导里已经回答过素材的问题，这次启动不再弹“找到了你的 Minecraft”
    useResourceStore.getState().setDiscoveryHandled();
    useUiStore.getState().finishOnboarding();
  };

  const lang = resolveLanguage(settings.language, systemLocale());
  const vanilla = resources?.vanilla;
  const activeVersion = resources?.library?.profiles.find((profile) => profile.id === resources.library?.activeProfileId)?.versionId
    ?? (vanilla?.active === 'local' ? vanilla.local?.versionId : vanilla?.active === 'cached' ? vanilla.cached?.versionId : null);
  const downloading = resources?.download.status === 'running';
  const folderSummary = (f: FolderInfo | undefined) => (f?.path && f.state === 'ok' ? f.path : t(`onboarding.folderDefault.${f?.kind ?? 'project'}`));
  const summaries: Record<OnboardingStep, string> = {
    language: settings.language === 'system' ? t('onboarding.language.systemDetail', { language: t(`settings.languages.${lang}`) }) : t(`settings.languages.${settings.language}`),
    appearance: [t(`settings.themes.${settings.theme}`), settings.reducedMotion === 'on' ? t('onboarding.reducedMotionOn') : null].filter(Boolean).join(' · '),
    assets: activeVersion
      ? t('onboarding.assets.summaryActive', { version: activeVersion })
      : downloading
        ? t('onboarding.assets.summaryDownloading')
        : assetChoice === 'later' || !assetChoice
          ? t('onboarding.assets.summaryLater')
          : t('onboarding.assets.summaryNone'),
    folders: folders ? `${folderSummary(folders.project)} · ${folderSummary(folders.export)}` : '',
    done: '',
  };

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
      data-testid="onboarding"
      data-step={step}
      className="fixed inset-0 z-[60] flex flex-col bg-background text-foreground"
    >
      <header className="app-drag flex h-11 shrink-0 items-center gap-2 pr-[150px] pl-3.5" style={titlebarInsets(true)}>
        <AllayHead size={22} label={t('brand.name')} />
        <span className="text-[13px] font-semibold whitespace-nowrap">{t('brand.wordmark')}</span>
        <span className="ml-3 text-xs text-fg-subtle">{t('onboarding.eyebrow')}</span>
        <div className="flex-1" />
        <Button variant="ghost" className="app-no-drag" data-testid="onboarding-skip-all" onClick={finish}>
          {t('onboarding.skipAll')}
        </Button>
      </header>

      {/* 全屏两栏（参照 Windows 的开箱设置）：左边是大的插画和吉祥物，右边是这一步的标题、说明和选项，底部按钮固定 */}
      <div className="flex min-h-0 flex-1 gap-1.5 px-1.5 pb-1.5">
        <Illustration step={step} />

        <main className="flex min-w-0 flex-1 flex-col rounded-xl bg-surface-1">
          <div className="shrink-0 overflow-x-auto px-10 pt-5 pb-1">
            <div className="mx-auto w-full max-w-[760px]">
              <Stepper step={step} visited={visited} go={go} summaries={summaries} />
            </div>
          </div>
          <div key={step} className="onboarding-step min-h-0 flex-1 overflow-y-auto px-10" data-dir={dir}>
            <div className="mx-auto flex w-full max-w-[760px] flex-col pt-[clamp(20px,6vh,72px)] pb-8">
              <div className="flex flex-col gap-2 pb-7">
                <span className="num text-xs text-fg-subtle" data-testid="onboarding-counter">
                  {String(idx + 1).padStart(2, '0')} / {String(ONBOARDING_STEPS.length).padStart(2, '0')}
                </span>
                <h2 id="onboarding-title" tabIndex={-1} className="text-[26px] leading-tight font-semibold outline-none">
                  {t(`onboarding.steps.${step}.title`)}
                </h2>
                <p className="max-w-[64ch] text-sm leading-relaxed text-fg-muted">{t(`onboarding.steps.${step}.body`)}</p>
              </div>
              {step === 'language' && (
                <div className="grid grid-cols-1 items-start gap-8 xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
                  <LanguageChoice testId="onboarding-language" />
                  <LivePreview />
                </div>
              )}
              {step === 'appearance' && (
                <div className="flex flex-col gap-6">
                  <ThemeChoice testId="onboarding-theme" />
                  <div className="flex items-center justify-between gap-6 border-t border-divider pt-5">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm">{t('settings.reducedMotion')}</span>
                      <span className="text-xs text-fg-subtle">{t('settings.reducedMotionHint')}</span>
                    </div>
                    <MotionChoice testId="onboarding-motion" />
                  </div>
                </div>
              )}
              {step === 'assets' && <AssetsStep choice={assetChoice} setChoice={setAssetChoice} />}
              {step === 'folders' && <FoldersStep />}
              {step === 'done' && <DoneStep summaries={summaries} />}
            </div>
          </div>

          <footer className="shrink-0 border-t border-divider px-10">
            <div className="mx-auto flex h-16 w-full max-w-[760px] items-center gap-2">
              <Button variant="ghost" disabled={idx === 0} data-testid="onboarding-back" onClick={back}>
                <ArrowLeft size={ICON.sm} />
                {t('onboarding.back')}
              </Button>
              <div className="flex-1" />
              {step !== 'done' && (
                <Button variant="ghost" data-testid="onboarding-skip" onClick={next}>
                  {t('onboarding.skip')}
                </Button>
              )}
              {step === 'done' ? (
                <Button size="lg" data-testid="onboarding-finish" onClick={finish}>
                  {t('onboarding.finish')}
                  <ArrowRight size={ICON.sm} />
                </Button>
              ) : (
                <Button size="lg" data-testid="onboarding-next" onClick={next}>
                  {t('onboarding.next')}
                  <ArrowRight size={ICON.sm} />
                </Button>
              )}
            </div>
          </footer>
        </main>
      </div>
    </div>
  );
}
