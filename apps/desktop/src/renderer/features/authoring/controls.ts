import { isDirty, useProjectStore } from '../../stores/projectStore';
import { askConfirm } from '../project/confirm';
import type { AuthoringMessages } from './messages';

export const codeFieldClass = 'min-h-36 w-full resize-y rounded-md border bg-background p-2 font-mono text-xs text-foreground';

export async function confirmReplace(message: AuthoringMessages, dirtyDraft = false): Promise<boolean> {
  if (!dirtyDraft && !isDirty(useProjectStore.getState())) return true;
  return askConfirm({ title: message.studio, body: message.discard, confirm: message.open });
}
