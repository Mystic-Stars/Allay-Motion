// 落地页与仿真器 iframe 之间的消息（同源，postMessage）。两边收到的消息都先过 zod，不认识的丢掉。
import { z } from 'zod';

export const SiteThemeSchema = z.enum(['dark', 'light']);
export type SiteTheme = z.infer<typeof SiteThemeSchema>;
export const SiteLanguageSchema = z.enum(['zh-CN', 'en']);
export type SiteLanguage = z.infer<typeof SiteLanguageSchema>;

/** 只有桌面版才能做的事（仿真器里点到时，落地页给出下载引导） */
export const DESKTOP_ONLY_FEATURES = ['files', 'project', 'packs', 'vanilla', 'templates', 'presets', 'folder'] as const;
export const DesktopOnlySchema = z.enum(DESKTOP_ONLY_FEATURES);
export type DesktopOnlyFeature = z.infer<typeof DesktopOnlySchema>;

/** 落地页 → 仿真器 */
export const ToSimulatorSchema = z.discriminatedUnion('type', [
  z.strictObject({ channel: z.literal('allay-site'), type: z.literal('settings'), theme: SiteThemeSchema, language: SiteLanguageSchema, reducedMotion: z.boolean() }),
  /** 在仿真器里选中一个模板（落地页的模板卡片上点了“在仿真器里打开”） */
  z.strictObject({ channel: z.literal('allay-site'), type: z.literal('select'), id: z.string().min(1).max(128), version: z.string().min(1).max(64) }),
  /** 仿真器窗口是否在视口里：进来时自动循环播放，出去时暂停（不占显卡） */
  z.strictObject({ channel: z.literal('allay-site'), type: z.literal('visibility'), visible: z.boolean() }),
]);
export type ToSimulator = z.infer<typeof ToSimulatorSchema>;

/** 仿真器 → 落地页 */
export const FromSimulatorSchema = z.discriminatedUnion('type', [
  z.strictObject({ channel: z.literal('allay-sim'), type: z.literal('ready') }),
  z.strictObject({ channel: z.literal('allay-sim'), type: z.literal('settings'), theme: SiteThemeSchema, language: z.enum(['system', 'zh-CN', 'en']) }),
  z.strictObject({ channel: z.literal('allay-sim'), type: z.literal('desktop-only'), feature: DesktopOnlySchema }),
  z.strictObject({ channel: z.literal('allay-sim'), type: z.literal('export-finished'), frames: z.int().min(0), preset: z.string().max(40) }),
]);
export type FromSimulator = z.infer<typeof FromSimulatorSchema>;

/** 只认同源窗口发来的消息 */
export function readMessage<T>(event: MessageEvent, schema: z.ZodType<T>): T | null {
  if (event.origin !== window.location.origin) return null;
  const parsed = schema.safeParse(event.data);
  return parsed.success ? parsed.data : null;
}
