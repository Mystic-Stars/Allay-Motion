import { frameCount } from '@allay/engine/frames';
import { localize } from '@allay/template-sdk';
import { Button } from '@allay/ui/components/button';
import { TimelineTrack, type TimelineSegment } from '@allay/ui/editor';
import { ICON, ICON_WEIGHT } from '@allay/ui/lib/icons';
import { Pause, Play, Repeat, SkipBack, SkipForward, SpeakerHigh, SpeakerSlash } from '@phosphor-icons/react';
import { cn } from '@allay/ui/lib/utils';
import { useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useTransportStore } from '../../stores/transportStore';
import { useUiStore } from '../../stores/uiStore';
import { togglePlay } from '../commands/commands';
import { startSegmentGesture } from './segment-gesture';

// 时间轴面板（6.4）：跨左、中两列。
// 标题行 48 px：到开头、播放（圆角方块按钮）、到结尾、循环；大号时间码“当前 / 总时长”；右侧静音。
// 下面是多轨时间轴（阶段、音效、剪辑点，见 TimelineTrack）。高质量预览在预览面板的悬浮工具条里，输出设置在右栏的“输出”页。

/** 时间码：分:秒:帧（6.4），例如 00:00:36 是第 0 秒第 36 帧 */
export function formatTimecode(t: number, fps: number): string {
  const totalFrames = Math.round(t * fps);
  const s = Math.floor(totalFrames / fps);
  const f = totalFrames - s * fps;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

export function TimelinePanel() {
  const { t, i18n } = useTranslation();
  const time = useTransportStore((s) => s.time);
  const duration = useTransportStore((s) => s.duration);
  const cutTime = useTransportStore((s) => s.cutTime);
  const playing = useTransportStore((s) => s.playing);
  const loop = useTransportStore((s) => s.loop);
  const output = useProjectStore((s) => s.output);
  const template = useProjectStore((s) => s.template);
  const params = useProjectStore((s) => s.params);
  const ready = usePreviewStore((s) => s.status.kind === 'ready');
  const timing = usePreviewStore((s) => s.loaded?.timing);
  const audioCues = usePreviewStore((s) => s.audioCues);
  const muted = useUiStore((s) => s.settings.editor.muted);
  const structureRevision = useProjectStore((s) => s.structureRevision);
  const finishGesture = useRef<(() => void) | null>(null);

  const total = duration > 0 ? frameCount(duration, output.fps) : 0;
  const cues = useMemo(() => (ready ? audioCues.map((c) => c.at) : []), [audioCues, ready]);

  // timeline.segments：把几个 duration 参数画成首尾相接的色段（4.3）
  const segments = useMemo<TimelineSegment[]>(() => {
    const segs = template?.manifest.timeline?.segments ?? [];
    return segs.flatMap((s) => {
      const def = template!.params.find((p) => p.key === s.param);
      if (!def || def.type !== 'duration') return [];
      const v = params[s.param];
      const duration = (timing?.editable === false ? timing.durations[s.param] : undefined) ?? (typeof v === 'number' ? v : def.default);
      return [{ key: s.param, label: localize(s.label ?? def.label, i18n.language), duration, min: def.min, max: def.max, defaultDuration: def.default }];
    });
  }, [template, params, timing, i18n.language]);

  return (
    <section aria-label={t('timeline.region')} className="flex h-timeline shrink-0 flex-col rounded-xl bg-surface-1" data-testid="timeline-panel">
      <div role="toolbar" aria-label={t('transport.region')} className="flex h-12 shrink-0 items-center gap-1 pr-2.5 pl-3" data-testid="transport">
        <Button variant="ghost" size="icon" aria-label={t('transport.toStart')} disabled={!ready} onClick={() => useTransportStore.getState().setTime(0)}>
          <SkipBack size={ICON.md} weight={ICON_WEIGHT.active} />
        </Button>
        <Button
          variant="secondary"
          className="mx-0.5 size-8 rounded-[9px] bg-control-hi px-0 hover:bg-control-hi hover:brightness-125"
          data-testid="transport-play"
          aria-label={playing ? t('transport.pause') : t('transport.play')}
          disabled={!ready}
          onClick={togglePlay}
        >
          {playing ? <Pause size={ICON.md - 1} weight={ICON_WEIGHT.active} /> : <Play size={ICON.md - 1} weight={ICON_WEIGHT.active} />}
        </Button>
        <Button variant="ghost" size="icon" aria-label={t('timeline.toEnd')} disabled={!ready} onClick={() => useTransportStore.getState().setTime(useTransportStore.getState().duration)}>
          <SkipForward size={ICON.md} weight={ICON_WEIGHT.active} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('transport.loop')}
          aria-pressed={loop}
          className={cn('aria-pressed:bg-transparent', loop ? 'text-primary-text hover:text-primary-text' : 'text-fg-muted')}
          onClick={() => useTransportStore.getState().setLoop(!loop)}
          data-testid="transport-loop"
        >
          <Repeat size={ICON.md} />
        </Button>
        <div className="ml-3 flex min-w-0 items-baseline gap-2 num">
          <span data-testid="transport-time" className="text-xl font-medium tracking-[.2px]" aria-label={t('transport.time')}>
            {formatTimecode(time, output.fps)}
          </span>
          <span data-testid="transport-duration" className="text-sm text-fg-subtle">
            / {formatTimecode(Math.max(0, total - 1) / output.fps, output.fps)}
          </span>
        </div>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="icon"
          aria-label={muted ? t('transport.unmute') : t('transport.mute')}
          aria-pressed={muted}
          className="aria-pressed:bg-transparent"
          data-testid="transport-mute"
          onClick={() => useUiStore.getState().setEditor({ muted: !muted })}
        >
          {muted ? <SpeakerSlash size={ICON.md} /> : <SpeakerHigh size={ICON.md} />}
        </Button>
      </div>
      <TimelineTrack
        key={structureRevision}
        duration={duration}
        time={time}
        fps={output.fps}
        segments={segments}
        readOnlySegments={timing?.editable === false}
        cutTime={cutTime}
        cues={cues}
        disabled={!ready}
        labels={{
          scrub: t('transport.scrub'),
          cut: t('transport.cut'),
          boundary: (a, b) => t('transport.boundary', { left: a, right: b }),
          endHandle: (label) => t('timeline.endHandle', { label }),
          stages: t('timeline.stages'),
          sound: t('timeline.sound'),
          cutTrack: t('timeline.cut'),
          stageStart: (label) => t('timeline.stageStart', { label }),
          stageEnd: (label) => t('timeline.stageEnd', { label }),
          resetStage: (label) => t('timeline.resetStage', { label }),
          goToFrame: (timecode) => t('timeline.goToFrame', { timecode }),
          goToCut: t('timeline.goToCut'),
          beforeCut: t('timeline.beforeCut'),
          goToCue: (timecode) => t('timeline.goToCue', { timecode }),
          audioToggle: muted ? t('transport.unmute') : t('transport.mute'),
        }}
        formatTime={(x) => formatTimecode(x, output.fps)}
        onSeekStart={() => useTransportStore.getState().setPlaying(false)}
        onSeek={(x) => useTransportStore.getState().setTime(x)}
        onSegmentChange={(key, d) => {
          if (usePreviewStore.getState().loaded?.timing?.editable !== false) useProjectStore.getState().setParams({ [key]: d }, i18n.language);
        }}
        onGesture={(phase) => {
          if (phase === 'start') finishGesture.current = startSegmentGesture();
          else {
            finishGesture.current?.();
            finishGesture.current = null;
          }
        }}
        onToggleAudio={() => useUiStore.getState().setEditor({ muted: !useUiStore.getState().settings.editor.muted })}
      />
    </section>
  );
}
