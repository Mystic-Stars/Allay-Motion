// 通用的“主进程到界面”的命令通道（docs/code-editing-and-mcp-plan.md H11）：主进程请界面执行一个已注册的命令
// （经界面的 dispatch，和菜单、快捷键、命令面板走同一条路），界面把结果交回来。两端都用这里的 zod schema 校验：
// 界面校验主进程发来的请求，主进程校验界面交回的结果（结果走 invoke 通道，和其他 IPC 一样先查来源再校验）。
// 将来的文件关联、第二实例参数、可能的 MCP 桥都经它；它不带任何代码，只带命令 id 和 JSON 参数。
import { z } from 'zod';

/** 结果里的 JSON 最多这么长（序列化后的字符数） */
export const MAX_HOST_COMMAND_JSON = 1_000_000;

const BoundedJson = z.json().refine((v) => JSON.stringify(v).length <= MAX_HOST_COMMAND_JSON, 'payload too large');

export const HostCommandIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9.-]*$/).max(64);

/** 主进程 → 界面（host:command 事件） */
export const HostCommandRequestSchema = z.strictObject({
  requestId: z.uuid(),
  command: HostCommandIdSchema,
  source: z.literal('mac-menu').optional(),
  input: BoundedJson.optional(),
});
export type HostCommandRequest = z.infer<typeof HostCommandRequestSchema>;

/** 命令没有执行成功的原因：前四个与界面命令层的 CommandError 相同；conflict 是工程修订号对不上（H3） */
export const HOST_COMMAND_ERRORS = ['unknown-command', 'disabled', 'invalid-input', 'invalid-output', 'conflict', 'failed', 'timeout', 'no-window'] as const;
export type HostCommandError = (typeof HOST_COMMAND_ERRORS)[number];

/** 界面 → 主进程（host:commandResult 调用的唯一参数） */
export const HostCommandResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({ requestId: z.uuid(), ok: z.literal(true), output: BoundedJson.optional() }),
  z.strictObject({
    requestId: z.uuid(),
    ok: z.literal(false),
    error: z.enum(HOST_COMMAND_ERRORS),
    message: z.string().max(2000),
  }),
]);
export type HostCommandResult = z.infer<typeof HostCommandResultSchema>;

/** 主进程拿到的结果（去掉 requestId） */
export type HostCommandOutcome = { ok: true; output?: unknown } | { ok: false; error: HostCommandError; message: string };
