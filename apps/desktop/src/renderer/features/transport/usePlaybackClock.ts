import type { Composition } from '@allay/template-sdk';
import { useEffect } from 'react';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { useTransportStore } from '../../stores/transportStore';

/** 快速模板包含末点；合成的时长为半开区间，末帧在结束边界之前。 */
export function playbackBounds(duration: number, composition: Pick<Composition, 'fps' | 'durationFrames'> | null) {
  return composition ? {
    duration: composition.durationFrames / composition.fps,
    endTime: (composition.durationFrames - 1) / composition.fps,
  } : { duration, endTime: duration };
}

/** 工作区共用的预览时钟。模板仍只接收求值用的时间，导出不使用这个时钟。 */
export function usePlaybackClock(): void {
  useEffect(() => {
    let raf: number | null = null;
    let lastTick: number | null = null;

    function tick(now: number) {
      raf = null;
      const transport = useTransportStore.getState();
      if (!transport.playing) return;
      const { duration, endTime } = playbackBounds(transport.duration, useProjectStore.getState().composition);
      if (lastTick !== null && duration > 0) {
        let next = transport.time + (now - lastTick) / 1000;
        if (next >= duration) {
          if (transport.loop) next %= duration;
          else {
            transport.setTime(endTime);
            transport.setPlaying(false);
            return;
          }
        }
        transport.setTime(next);
      }
      if (useTransportStore.getState().playing && raf === null) {
        lastTick = now;
        raf = requestAnimationFrame(tick);
      }
    }

    function cancel() {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      lastTick = null;
    }

    function sync(playing: boolean) {
      if (playing) {
        if (raf === null) raf = requestAnimationFrame(tick);
      } else {
        cancel();
        usePreviewStore.getState().setMeasuredFps(null);
      }
    }

    const unsubscribe = useTransportStore.subscribe((state, previous) => {
      if (state.playing !== previous.playing) sync(state.playing);
    });
    sync(useTransportStore.getState().playing);
    return () => {
      unsubscribe();
      cancel();
    };
  }, []);
}
