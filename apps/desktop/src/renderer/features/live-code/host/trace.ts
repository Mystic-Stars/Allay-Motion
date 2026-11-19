import type { CodeInspectorPacket } from '../../../../shared/code-inspector';

type Frame = Extract<CodeInspectorPacket, { type: 'frame' }>;
export type TraceTarget = { id: string; version: string; clipId?: string };
export type ExecutionTrace = TraceTarget & { source: string; t: number; lines: number[] };

export function matchesTrace(target: TraceTarget, source: string, sample: ExecutionTrace): boolean {
  return sample.id === target.id && sample.version === target.version && sample.clipId === target.clipId && sample.source === source;
}

/** 播放时只保留最新完成帧，定时器补发末帧。暂停和拖帧绕过限流。 */
export function framePublisher(send: (frame: Frame, revision: number) => void) {
  let pending: { frame: Frame; revision: number } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = -Infinity;

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const next = pending;
    pending = undefined;
    if (!next) return;
    last = performance.now();
    send(next.frame, next.revision);
  };

  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  return {
    push(frame: Frame, revision: number) {
      pending = { frame, revision };
      const wait = last + 50 - performance.now();
      if (!frame.playing || wait <= 0) flush();
      else timer ??= setTimeout(flush, Math.ceil(wait));
    },
    cancel,
    clear() {
      cancel();
      last = -Infinity;
    },
  };
}
