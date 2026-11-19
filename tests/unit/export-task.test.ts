// 导出任务的命令（docs/code-editing-and-mcp-plan.md H7）：exportTask.start / get / cancel 经注册表的 dispatch 执行，
// 参数和返回值都过 zod。这里把引擎和 window.allay.export 换成假的，只测任务的状态机和命令的形状；
// 真实的引擎和 FFmpeg 在 e2e（tests/e2e/export.spec.ts）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExportTaskSnapshot } from '../../apps/desktop/src/renderer/features/export/exportTasks';

const engine = vi.hoisted(() => ({
  frames: 0,
  cutTime: 0.5 as number | null,
  duration: 1,
  fail: false,
  gate: null as null | (() => Promise<void>),
}));

vi.mock('../../apps/desktop/src/renderer/engine-host/EngineHost', () => {
  class EngineUnresponsiveError extends Error {}
  return {
    EngineUnresponsiveError,
    EngineHost: {
      create: async () => ({
        load: async () => ({ duration: engine.duration, cutTime: engine.cutTime, audioCues: [] }),
        renderFrame: async (_i: number) => {
          if (engine.gate) await engine.gate();
          if (engine.fail) throw new Error('boom in update');
          engine.frames++;
          return new Uint8Array(4 * 4 * 4).fill(255);
        },
        dispose: () => undefined,
      }),
    },
  };
});
vi.mock('../../apps/desktop/src/renderer/engine-host/resource-client', () => ({ createResolver: () => () => null, loadStamp: () => 'stamp' }));

const { dispatch, CommandError, registerCommand } = await import('../../apps/desktop/src/renderer/app/registry');
const tasks = await import('../../apps/desktop/src/renderer/features/export/exportTasks');
const { usePreviewStore } = await import('../../apps/desktop/src/renderer/stores/previewStore');
const { useProjectStore } = await import('../../apps/desktop/src/renderer/stores/projectStore');
const { useUiStore } = await import('../../apps/desktop/src/renderer/stores/uiStore');

interface Calls {
  start: unknown[];
  written: number;
  canceled: string[];
}
let calls: Calls;
const JOB = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

function installFakeApi(): void {
  calls = { start: [], written: 0, canceled: [] };
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    allay: {
      export: {
        start: async (req: unknown) => {
          calls.start.push(req);
          return { ok: true, job: { jobId: JOB, target: 'C:/out/x.mov', encoder: null } };
        },
        writeFrame: async () => {
          calls.written++;
          return { ok: true };
        },
        finish: async () => ({ ok: true, path: 'C:/out/x.mov', frames: calls.written }),
        cancel: async (id: string) => {
          calls.canceled.push(id);
        },
      },
    },
  }));
}

const disposers: (() => void)[] = [];
beforeEach(() => {
  installFakeApi();
  Object.assign(engine, { frames: 0, cutTime: 0.5, duration: 1, fail: false, gate: null });
  for (const c of tasks.EXPORT_TASK_COMMANDS) disposers.push(registerCommand(c as never));
  usePreviewStore.setState({ status: { kind: 'ready', warnings: [] } } as never);
  useProjectStore.setState({
    template: { ref: { id: 'allay.builtin.block-wipe', version: '1.0.0' }, manifest: { name: 'Block wipe' }, code: '', assets: null, params: [], hidden: [] },
    params: {},
    output: { width: 64, height: 64, fps: 30 },
    name: 'proj',
  } as never);
  tasks.useExportTasks.setState({ tasks: {}, activeId: null });
});
afterEach(() => {
  while (disposers.length) disposers.pop()!();
  vi.unstubAllGlobals();
});

async function waitFor(fn: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !fn(); i++) await new Promise((r) => setTimeout(r, 2));
  expect(fn()).toBe(true);
}

describe('导出任务的命令', () => {
  it('start 立即返回任务编号；get 能查到进度直到完成；结果里有路径、帧数、剪辑点', async () => {
    const out = (await dispatch('exportTask.start', { preset: 'prores4444', quality: 'draft' })) as { taskId: string };
    expect(out.taskId).toMatch(/^[0-9a-f-]{36}$/);
    expect(useUiStore.getState().exporting).toBe(true);
    const unloading = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unloading);
    expect(unloading.defaultPrevented).toBe(true);
    const first = (await dispatch('exportTask.get', { taskId: out.taskId })) as { status: string };
    expect(['preparing', 'rendering', 'muxing']).toContain(first.status);
    await waitFor(() => tasks.getExportTask(out.taskId)?.status === 'done');
    const done = (await dispatch('exportTask.get', { taskId: out.taskId })) as ExportTaskSnapshot;
    // 1 秒 30 fps：首尾两帧都渲染，31 帧
    expect(done).toMatchObject({ status: 'done', progress: 1, written: 31, total: 31, preset: 'prores4444', error: null });
    expect(done.result).toMatchObject({ path: 'C:/out/x.mov', frames: 31, cutFrame: 15, cutMinAlpha: 255, fps: 30 });
    expect(calls.start[0]).toMatchObject({ preset: 'prores4444', width: 64, height: 64, fps: 30, totalFrames: 31, cutFrame: 15, suggestedName: 'proj_Block wipe_64x64_30fps' });
    expect(useUiStore.getState().exporting).toBe(false);
    expect(tasks.useExportTasks.getState().activeId).toBeNull();
    expect(window.dispatchEvent(new Event('beforeunload', { cancelable: true }))).toBe(true);
  });

  it('省略的参数取工程的导出设置；文件名可以指定', async () => {
    useProjectStore.getState().setExportSettings({ preset: 'webm-vp9', quality: 'standard', shutterAngle: 90 });
    const { taskId } = (await dispatch('exportTask.start', { fileName: 'mine' })) as { taskId: string };
    const snap = tasks.getExportTask(taskId)!;
    expect(snap.preset).toBe('webm-vp9');
    expect(snap.settings).toMatchObject({ quality: 'standard', shutterAngle: 90, fileName: 'mine' });
    await waitFor(() => tasks.getExportTask(taskId)?.status === 'done');
    expect(calls.start[0]).toMatchObject({ preset: 'webm-vp9', suggestedName: 'mine' });
  });

  it('畸形参数被 dispatch 拦下；不接受输出路径', async () => {
    for (const bad of [
      { preset: 'gif' },
      { quality: 'max' },
      { shutterAngle: 400 },
      { key: 'green' },
      { fileName: '' },
      { path: 'C:\\Windows\\x.mov' },
      'prores4444',
    ]) {
      await expect(dispatch('exportTask.start', bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid-input' });
    }
    for (const bad of [undefined, {}, { taskId: 'x' }, { taskId: JOB, extra: 1 }]) {
      await expect(dispatch('exportTask.get', bad)).rejects.toBeInstanceOf(CommandError);
      await expect(dispatch('exportTask.cancel', bad)).rejects.toBeInstanceOf(CommandError);
    }
    expect(await dispatch('exportTask.get', { taskId: JOB })).toBeNull();
    expect(calls.start).toHaveLength(0);
  });

  it('一次只跑一个：进行中再 start 是 disabled；预览没就绪时也不能 start', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    engine.gate = () => hold;
    const { taskId } = (await dispatch('exportTask.start')) as { taskId: string };
    await expect(dispatch('exportTask.start')).rejects.toMatchObject({ code: 'disabled' });
    release();
    engine.gate = null;
    await waitFor(() => tasks.getExportTask(taskId)?.status === 'done');
    usePreviewStore.setState({ status: { kind: 'loading' } } as never);
    await expect(dispatch('exportTask.start')).rejects.toMatchObject({ code: 'disabled' });
  });

  it('cancel：进行中的任务停下、主进程收到取消；返回 canceled；再取消没有副作用', async () => {
    let release!: () => void;
    let reached!: () => void;
    const atFrame = new Promise<void>((r) => (reached = r));
    engine.gate = () => {
      if (engine.frames === 3) {
        reached();
        return new Promise<void>((r) => (release = r));
      }
      return Promise.resolve();
    };
    const { taskId } = (await dispatch('exportTask.start')) as { taskId: string };
    await atFrame;
    const canceling = dispatch('exportTask.cancel', { taskId });
    release();
    expect(await canceling).toEqual({ status: 'canceled' });
    expect(calls.canceled).toEqual([JOB]);
    expect(tasks.getExportTask(taskId)?.status).toBe('canceled');
    expect(await dispatch('exportTask.cancel', { taskId })).toEqual({ status: 'canceled' });
    expect(tasks.useExportTasks.getState().activeId).toBeNull();
  });

  it('模板出错：任务失败，带帧号和错误码，主进程的任务被取消', async () => {
    engine.fail = true;
    const { taskId } = (await dispatch('exportTask.start')) as { taskId: string };
    await waitFor(() => tasks.getExportTask(taskId)?.status === 'failed');
    const snap = tasks.getExportTask(taskId)!;
    expect(snap.error).toMatchObject({ code: 'template-failed', frame: 0 });
    expect(snap.error!.detail).toContain('boom');
    expect(calls.canceled).toEqual([JOB]);
  });
});
