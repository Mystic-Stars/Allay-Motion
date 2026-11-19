import { z } from 'zod';

export const MAC_MENU_COMMANDS = [
  'settings', 'newProject', 'newAnimation', 'newAnimationFromTemplate', 'openProject', 'saveProject', 'saveProjectAs', 'export',
  'mac.openRecent', 'mac.importTemplate', 'copyBuiltinTemplate', 'openTemplateFolder',
  'undo', 'redo', 'reroll', 'mac.theme', 'mac.language', 'mac.background',
  'guides', 'toggleLeft', 'showCodeEditor', 'showPreview', 'palette', 'onboarding', 'tour',
] as const;

export type MacMenuCommand = (typeof MAC_MENU_COMMANDS)[number];

export const MacMenuStateSchema = z.strictObject({
  enabled: z.array(z.enum(MAC_MENU_COMMANDS)).max(MAC_MENU_COMMANDS.length),
  textEditing: z.boolean(),
});
export type MacMenuState = z.infer<typeof MacMenuStateSchema>;
