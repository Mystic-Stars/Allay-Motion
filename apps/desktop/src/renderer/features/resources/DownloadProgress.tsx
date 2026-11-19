import { AllayProgress, useReducedMotion, type AllayProgressPhase } from '@allay/mascot';
import { Button } from '@allay/ui/components/button';
import { ICON } from '@allay/ui/lib/icons';
import { ArrowClockwise, CheckCircle, Circle, CircleNotch, Cube, MinusCircle, WarningCircle } from '@phosphor-icons/react';
import { cn } from '@allay/ui/lib/utils';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { DOWNLOAD_STAGES, type DownloadProgressView, type DownloadStage, type DownloadState, type StageStatus } from '../../../shared/resources';
import { downloadVanilla } from './actions';

// 下载原版资源的进度（docs/06-ui-design.md 6.12）：整体进度条（按字节）、已下载 / 总大小、速度、剩余时间、
// 当前在做什么，以及五个阶段各自的状态。失败、取消时指明停在哪一步，可以重试（已下载且校验通过的文件不会重下）。
// 设置的“素材”页和首次启动引导共用；引导里大一号，带悦灵（7.5、7.6 B）。

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function formatEta(t: TFunction, seconds: number): string {
  const s = Math.max(1, Math.round(seconds));
  if (s < 60) return t('resources.progress.etaSeconds', { count: s });
  return t('resources.progress.etaMinutes', { minutes: Math.floor(s / 60), seconds: String(s % 60).padStart(2, '0') });
}

/** 百分比：一位小数，完成之前不显示 100 */
export function formatPercent(fraction: number, done: boolean): string {
  if (done) return '100%';
  return `${Math.min(99.9, Math.floor(fraction * 1000) / 10).toFixed(1)}%`;
}

function StageIcon({ status }: { status: StageStatus }) {
  const reduced = useReducedMotion();
  switch (status) {
    case 'done':
      return <CheckCircle size={ICON.md} weight="fill" className="text-success" />;
    case 'active':
      return <CircleNotch size={ICON.md} weight="bold" className={cn('text-primary-text', !reduced && 'animate-spin')} />;
    case 'failed':
      return <WarningCircle size={ICON.md} weight="fill" className="text-danger" />;
    case 'canceled':
      return <MinusCircle size={ICON.md} className="text-fg-subtle" />;
    default:
      return <Circle size={ICON.md} className="text-fg-faint" />;
  }
}

function stageMeta(t: TFunction, p: DownloadProgressView, stage: DownloadStage): string | null {
  const s = p.stages.find((x) => x.id === stage)!;
  if (stage === 'sounds' && p.items && s.status === 'active') return t('resources.progress.items', { done: p.items.done, total: p.items.total });
  if (s.total === null || s.total === 0) return null;
  if (s.status === 'done') return formatBytes(s.total);
  if (s.status === 'pending') return formatBytes(s.total);
  return `${formatBytes(s.received)} / ${formatBytes(s.total)}`;
}

function activityText(t: TFunction, p: DownloadProgressView): string {
  const version = p.versionId ?? '';
  return t(`resources.progress.activity.${p.activity}`, { version, done: p.items?.done ?? 0, total: p.items?.total ?? 0 });
}

const PHASE: Record<DownloadState['status'], AllayProgressPhase> = { idle: 'rendering', running: 'rendering', done: 'done', failed: 'error', canceled: 'canceled' };

export function DownloadProgress({ state, size = 'compact', onRetry }: { state: Exclude<DownloadState, { status: 'idle' }>; size?: 'compact' | 'large'; onRetry?: () => void }) {
  const { t } = useTranslation();
  const p = state.progress;
  const done = state.status === 'done';
  const pct = formatPercent(p.fraction, done);
  const stoppedAt = t(`resources.progress.stages.${p.activity === 'panorama' ? 'panorama' : p.stage}`);
  const large = size === 'large';
  const retry = onRetry ?? (() => downloadVanilla('requestedVersion' in state ? state.requestedVersion : undefined));
  const numbers = [
    p.total !== null ? t('resources.progress.bytes', { received: formatBytes(p.received), total: formatBytes(p.total) }) : null,
    state.status === 'running' && p.bytesPerSecond !== null ? t('resources.progress.speed', { speed: formatBytes(Math.round(p.bytesPerSecond)) }) : null,
    state.status === 'running' && p.etaSeconds !== null ? formatEta(t, p.etaSeconds) : null,
  ].filter((x): x is string => x !== null);

  return (
    <div
      className={cn('flex flex-col', large ? 'gap-4' : 'gap-3')}
      data-testid="download-progress"
      data-status={state.status}
      data-stage={p.stage}
      data-fraction={p.fraction.toFixed(4)}
      aria-live="polite"
      aria-busy={state.status === 'running'}
    >
      {large ? (
        <AllayProgress value={done ? 1 : p.fraction} phase={PHASE[state.status]} carry={<Cube size={18} weight="fill" className="text-foreground" />} label={t('resources.download.progress')} />
      ) : (
        <div
          role="progressbar"
          aria-label={t('resources.download.progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round((done ? 1 : p.fraction) * 100)}
          className="h-1.5 w-full overflow-hidden rounded-full bg-well"
        >
          <div className={cn('h-full rounded-full transition-[width] duration-(--dur-2)', state.status === 'failed' ? 'bg-danger' : 'bg-primary')} style={{ width: `${(done ? 1 : p.fraction) * 100}%` }} />
        </div>
      )}

      {/* 读数：左边字节、速度、剩余时间，右边百分比 */}
      <div className="flex items-baseline justify-between gap-3">
        <span className="num truncate text-xs text-fg-subtle" data-testid="download-numbers">
          {numbers.join(' · ') || ' '}
        </span>
        <span className={cn('num shrink-0 font-medium text-foreground', large ? 'text-lg' : 'text-sm')} data-testid="download-percent">
          {pct}
        </span>
      </div>

      {state.status === 'running' && (
        <p className="truncate text-sm text-foreground" data-testid="download-activity">
          {activityText(t, p)}
        </p>
      )}

      {/* 五个阶段 */}
      <ol className={cn('flex flex-col', large ? 'gap-0.5' : 'gap-0')} aria-label={t('resources.progress.stagesLabel')} data-testid="download-stages">
        {DOWNLOAD_STAGES.map((id, i) => {
          const s = p.stages[i]!;
          const meta = stageMeta(t, p, id);
          return (
            <li
              key={id}
              className={cn('flex items-center gap-2.5 rounded-md px-2', large ? 'h-8' : 'h-7', s.status === 'active' && 'bg-control')}
              data-testid={`download-stage-${id}`}
              data-status={s.status}
            >
              <StageIcon status={s.status} />
              <span className="num w-4 shrink-0 text-xs text-fg-subtle">{i + 1}</span>
              <span className={cn('min-w-0 flex-1 truncate text-sm', s.status === 'pending' ? 'text-fg-muted' : 'text-foreground')}>{t(`resources.progress.stages.${id}`)}</span>
              {meta && <span className="num shrink-0 text-xs text-fg-subtle">{meta}</span>}
            </li>
          );
        })}
      </ol>

      {state.status === 'running' && (
        <Button variant="secondary" className={cn('self-start', large && 'bg-control-hi hover:bg-well')} data-testid="download-cancel" onClick={() => void window.allay.resources.cancelDownload()}>
          {t('resources.download.cancel')}
        </Button>
      )}
      {state.status === 'failed' && (
        <div className="flex flex-col gap-2">
          <p role="alert" data-testid="download-error" data-error={state.error} className="text-sm text-danger">
            {t(`resources.download.errors.${state.error}`)}
          </p>
          <p className="text-xs text-fg-subtle" data-testid="download-stopped">
            {t('resources.progress.stoppedAt', { stage: stoppedAt })}
          </p>
        </div>
      )}
      {state.status === 'canceled' && (
        <p className="text-sm text-fg-muted" data-testid="download-canceled">
          {t('resources.progress.canceledAt', { stage: stoppedAt })}
        </p>
      )}
      {(state.status === 'failed' || state.status === 'canceled') && (
        <Button variant="secondary" className={cn('self-start', large && 'bg-control-hi hover:bg-well')} data-testid="download-retry" onClick={retry}>
          <ArrowClockwise size={ICON.sm} />
          {t('resources.download.retry')}
        </Button>
      )}
      {done && (
        <p className="text-sm text-foreground" data-testid="download-done">
          {t('resources.progress.done', { version: p.versionId ?? '' })}
        </p>
      )}
    </div>
  );
}
