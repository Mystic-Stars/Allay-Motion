// 主进程这一端的命令通道（docs/code-editing-and-mcp-plan.md H11；格式见 shared/host-commands.ts）：
// run() 给主窗口发一个带 requestId 的请求，等界面经 host:commandResult 交回结果（主进程用 zod 再校验一次），
// 超时、窗口不在时给出明确的失败。现在主进程里还没有调用方；文件关联、第二实例参数在 M8 接。
import { randomUUID } from 'node:crypto';
import { HostCommandIdSchema, HostCommandResultSchema, type HostCommandOutcome, type HostCommandRequest } from '../shared/host-commands';
import type { Logger } from './logger';

export const HOST_COMMAND_TIMEOUT_MS = 15_000;

interface Pending {
  resolve(outcome: HostCommandOutcome): void;
  timer: ReturnType<typeof setTimeout>;
}

export class HostCommandChannel {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly opts: {
      /** 把请求发给主窗口；没有窗口时返回 false */
      send(request: HostCommandRequest): boolean;
      log: Logger;
      timeoutMs?: number;
    },
  ) {}

  /**
   * 请界面执行命令 id（参数经界面的命令层校验）。永远 resolve，不抛错。
   * timeoutMs：这一次的时限（缺省 15 秒）；会等用户回答的命令（文件关联时“放弃未保存的改动？”，M8）给长一些
   */
  run(command: string, input?: unknown, opts: { timeoutMs?: number; source?: HostCommandRequest['source'] } = {}): Promise<HostCommandOutcome> {
    if (!HostCommandIdSchema.safeParse(command).success) return Promise.resolve({ ok: false, error: 'unknown-command', message: 'bad command id' });
    const requestId = randomUUID();
    return new Promise<HostCommandOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        this.opts.log.warn('host-commands', 'command timed out', { command });
        resolve({ ok: false, error: 'timeout', message: `no result for ${command}` });
      }, opts.timeoutMs ?? this.opts.timeoutMs ?? HOST_COMMAND_TIMEOUT_MS);
      this.pending.set(requestId, { resolve, timer });
      let sent = false;
      try {
        sent = this.opts.send({ requestId, command, ...(opts.source && { source: opts.source }), ...(input !== undefined && { input: input as HostCommandRequest['input'] }) });
      } catch (error) {
        this.opts.log.warn('host-commands', 'send failed', { command, error: String(error) });
      }
      if (!sent) this.settle(requestId, { ok: false, error: 'no-window', message: 'main window is not available' });
    });
  }

  /** 界面交回的结果（IPC 处理函数调用；参数已经按 IPC_ARGS 校验过，这里再按结果的 schema 校验一次） */
  receive(raw: unknown): boolean {
    const parsed = HostCommandResultSchema.safeParse(raw);
    if (!parsed.success) {
      this.opts.log.warn('host-commands', 'malformed result');
      return false;
    }
    const { requestId, ...rest } = parsed.data;
    if (!this.pending.has(requestId)) return false;
    this.settle(requestId, rest.ok ? (rest.output === undefined ? { ok: true } : { ok: true, output: rest.output }) : { ok: false, error: rest.error, message: rest.message });
    return true;
  }

  /** 窗口关了：还在等的全部失败 */
  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { ok: false, error: 'no-window', message: 'main window closed' });
  }

  private settle(requestId: string, outcome: HostCommandOutcome): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    p.resolve(outcome);
  }
}
