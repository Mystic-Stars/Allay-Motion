// 模板的界面动作：选模板、安装（含试运行）、删除。结果变成窗口底部的提示。
import type { TFunction } from 'i18next';
import type { StageResult, TemplateEntry } from '../../../shared/templates';
import { previewEngine } from '../preview/previewEngine';
import { useNoticeStore } from '../../stores/noticeStore';
import { clearHistory, useProjectStore } from '../../stores/projectStore';
import { useResourceStore } from '../../stores/resourceStore';
import { useTemplateStore } from '../../stores/templateStore';
import { DEFAULT_TEMPLATE_ID, readTemplate } from '../../templates/catalog';
import { trialRun, type TrialResult } from './trial';
import { boundResourceEdition, creationParams } from './profileDefaults';

async function activateTemplate(id: string, version: string, locale: string, params: Readonly<Record<string, unknown>>, fresh: boolean): Promise<boolean> {
  const source = await readTemplate(id, version);
  if (!source) return false;
  const resource = boundResourceEdition(useResourceStore.getState().state);
  useProjectStore.getState().setTemplate(source, fresh ? creationParams(source, locale, resource, params) : params, locale);
  previewEngine.retry();
  return true;
}

/** 显式新选；导入模板和载入已有对象不走这条入口。 */
export function selectTemplate(id: string, version: string, locale: string, params: Readonly<Record<string, unknown>> = {}): Promise<boolean> {
  return activateTemplate(id, version, locale, params, true);
}

/** 启动时：取模板列表，选旗舰模板的最高版本（没有就选第一个能装载的） */
export async function loadInitialTemplate(locale: string): Promise<void> {
  const entries = await useTemplateStore.getState().refresh();
  const flagship = entries.filter((e) => e.id === DEFAULT_TEMPLATE_ID).reverse();
  const others = entries.filter((e) => e.id !== DEFAULT_TEMPLATE_ID && !e.baseMissing);
  for (const e of [...flagship, ...others]) {
    const source = await readTemplate(e.id, e.version);
    if (!source) continue;
    // 启动时的默认工程：不算改动，也不进撤销历史
    useProjectStore.getState().reset({ template: source, name: null, handle: null, locale });
    clearHistory();
    previewEngine.retry();
    return;
  }
}

export type InstallOutcome =
  | { kind: 'canceled' }
  | { kind: 'rejected'; code: string; detail: string }
  | { kind: 'installed'; entry: TemplateEntry; trial: Extract<TrialResult, { ok: true }> };

/** 安装的后半段：试运行，通过就提交（4.8 第 4、6 步） */
export async function finishInstall(stage: StageResult, locale: string): Promise<InstallOutcome> {
  if ('canceled' in stage && stage.canceled) return { kind: 'canceled' };
  if (!('ok' in stage)) return { kind: 'canceled' };
  if (!stage.ok) return { kind: 'rejected', code: stage.error.code, detail: stage.error.detail };
  const trial = await trialRun(stage.bundle, { stagingId: stage.stagingId }, locale);
  if (!trial.ok) {
    await window.allay.templates.cancelInstall(stage.stagingId);
    return { kind: 'rejected', code: 'trial-failed', detail: trial.detail };
  }
  const committed = await window.allay.templates.commitInstall(stage.stagingId, { warnings: trial.warnings });
  if (!committed.ok) return { kind: 'rejected', code: committed.error.code, detail: committed.error.detail };
  await useTemplateStore.getState().refresh();
  return { kind: 'installed', entry: committed.entry, trial };
}

function report(t: TFunction, outcome: InstallOutcome): void {
  const notice = useNoticeStore.getState();
  if (outcome.kind === 'canceled') return;
  if (outcome.kind === 'rejected') {
    notice.show('error', t('templates.rejected', { reason: t(`templates.errors.${outcome.code}`), detail: outcome.detail.slice(0, 160) }));
  } else if (outcome.trial.warnings.length > 0) {
    const list = outcome.trial.warnings.map((w) => t(`templates.warnings.${w}`)).join(t('templates.listSeparator'));
    notice.show('info', t('templates.installedWithWarnings', { warnings: list }));
  } else {
    notice.show('info', t('templates.installed'));
  }
}

async function afterInstall(t: TFunction, outcome: InstallOutcome, locale: string): Promise<InstallOutcome> {
  report(t, outcome);
  if (outcome.kind === 'installed' && !outcome.entry.baseMissing) {
    await activateTemplate(outcome.entry.id, outcome.entry.version, locale, {}, false);
  }
  return outcome;
}

/** “导入模板…”：主进程弹对话框 */
export async function installViaDialog(t: TFunction, locale: string): Promise<InstallOutcome> {
  return afterInstall(t, await finishInstall(await window.allay.templates.install(), locale), locale);
}

/** 拖进窗口的 .allaytpl：路径由 preload 从 File 取（1.6 第 6 条） */
export async function installDroppedTemplate(t: TFunction, file: File, locale: string): Promise<InstallOutcome> {
  let outcome: InstallOutcome;
  try {
    outcome = await finishInstall(await window.allay.templates.installDropped(file), locale);
  } catch {
    outcome = { kind: 'rejected', code: 'not-a-zip', detail: file.name };
  }
  return afterInstall(t, outcome, locale);
}

/** 双击关联的 .allaytpl（M8）：主进程经命令通道发来一次性令牌，路径不经过界面；之后与“导入模板…”相同 */
export async function installAssociatedTemplate(t: TFunction, token: string, locale: string): Promise<InstallOutcome> {
  return afterInstall(t, await finishInstall(await window.allay.templates.installRequested(token), locale), locale);
}

/** 删除用户模板；当前正在用它时换回旗舰模板 */
export async function removeTemplate(id: string, version: string, locale: string): Promise<boolean> {
  const removed = await window.allay.templates.remove(id, version);
  await useTemplateStore.getState().refresh();
  const current = useProjectStore.getState().template?.ref;
  if (removed && current && current.id === id && current.version === version) await loadInitialTemplate(locale);
  return removed;
}
