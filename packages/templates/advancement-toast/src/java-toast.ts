import type { SetupContext, TemplateInstance, TextObject } from '@allay/template-sdk';
import { createJavaPanel, PANEL_H, PANEL_W } from './java-panel';
import { javaGuiProjection } from './java-gui-scale';
import { layoutJavaToastText } from './java-text';
import { cueJavaToast, javaTextAlpha, javaToastTiming, unit, type JavaToastProfile } from './java-timing';

const ADVANCEMENT_HEADERS = {
  task: ['Advancement Made!', '进度已达成！'],
  goal: ['Goal Reached!', '目标已达成！'],
  challenge: ['Challenge Complete!', '挑战已完成！'],
} as const;
const ACHIEVEMENT_HEADER = ['Achievement get!', '获得成就！'] as const;
const TEXT_X = 30;
const ICON_SIZE = 16;
const VERIFIED_GUI_CUBES = new Set([
  'diamond_block', 'stone', 'cobblestone', 'dirt', 'oak_planks', 'oak_log', 'furnace',
]);
const stringOr = (value: unknown, fallback: string): string => typeof value === 'string' ? value : fallback;
const numberOr = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;

async function createToastIcon(ctx: SetupContext, legacy: boolean) {
  const { THREE, params } = ctx;
  const id = stringOr(params.icon, 'minecraft:diamond');
  const vanillaId = id.startsWith('minecraft:') ? id.slice('minecraft:'.length) : id;
  const cube = !legacy && VERIFIED_GUI_CUBES.has(vanillaId);
  const icon = (await ctx.resources.item(id)).single();
  icon.scale.set(ICON_SIZE, ICON_SIZE, 1);
  icon.position.set(8 + ICON_SIZE / 2 - PANEL_W / 2, PANEL_H / 2 - (8 + ICON_SIZE / 2), legacy ? 2 : 4);
  if (cube) {
    icon.rotation.set(Math.PI / 6, 5 * Math.PI / 4, 0, 'XYZ');
    icon.scale.setScalar(ICON_SIZE * 0.625);
    icon.position.z = ICON_SIZE;
  }
  if (!legacy) {
    icon.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.renderOrder = 2;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        material.transparent = true;
        material.toneMapped = false;
      }
    });
  }
  return icon;
}

export async function setupJavaToast(ctx: SetupContext, profile: JavaToastProfile): Promise<TemplateInstance> {
  const { THREE, params, stage, scene } = ctx;
  const legacy = profile === 'javaAchievement';
  const frame = params.frame === 'goal' || params.frame === 'challenge' ? params.frame : 'task';
  const titleText = stringOr(params.javaTitle, stringOr(params.title, ''));
  const legacyHeader = stringOr(params.header, '');
  const inputHeader = stringOr(params.javaHeader, legacyHeader);
  const legacyPreset = typeof params.javaHeader !== 'string' && ADVANCEMENT_HEADERS.task.some((text) => text === legacyHeader);
  const customHeading = params.javaHeadingMode === 'custom' || (params.javaHeadingMode === undefined && !legacyPreset && inputHeader.trim() !== '');
  const zh = params.toastLanguage === 'zh-CN' || (params.toastLanguage !== 'en' && /^zh/i.test(ctx.locale));
  const defaultHeader = (legacy ? ACHIEVEMENT_HEADER : ADVANCEMENT_HEADERS[frame])[zh ? 1 : 0];
  const headerText = customHeading ? inputHeader : defaultHeader;
  const headerFont = stringOr(params.headerFont, 'minecraft:default');
  const titleFont = stringOr(params.titleFont, 'minecraft:default');
  const inputColor = stringOr(params.headerColor, '#FFFF55');
  const headerColor = inputColor.toUpperCase() === '#FFFF55' ? (!legacy && frame === 'challenge' ? '#FF88FF' : '#FFFF00') : inputColor;
  const titleColor = stringOr(params.titleColor, '#FFFFFF');

  const panel = await createJavaPanel(ctx, profile);
  const root = new THREE.Group();
  root.visible = false;
  const margin = Math.max(0, Math.min(numberOr(params.margin, 0), Math.min(stage.width, stage.height) / 4));
  const automatic = !legacy && params.guiScaleMode === 'vanillaAuto' ? javaGuiProjection(stage) : undefined;
  const scale = automatic?.scale ?? Math.min(numberOr(params.guiScale, 4), (stage.width - 2 * margin) / PANEL_W, (stage.height - 2 * margin) / PANEL_H);
  root.scale.set(scale, scale, 1);
  scene.add(root);
  if (panel) root.add(panel.object);

  const layout = layoutJavaToastText(headerText, titleText, (text) => ctx.text.measureGui(text, headerFont), (text) => ctx.text.measureGui(text, titleFont), legacy);
  const placeText = (row: typeof layout.header, font: string, color: string): TextObject => {
    const label = ctx.text.create({ text: row.text, font, size: row.scale, align: 'left', color, shadow: false, origin: 'guiBaseline' });
    label.object.position.set(TEXT_X - PANEL_W / 2 - row.left, PANEL_H / 2 - row.baseline, 3);
    if (!legacy) label.object.traverse((object) => {
      if (object instanceof THREE.Mesh) object.renderOrder = 1;
    });
    root.add(label.object);
    return label;
  };
  const header = placeText(layout.header, headerFont, headerColor);
  const titles = layout.titles.map((line) => placeText(line, titleFont, titleColor));

  root.add(await createToastIcon(ctx, legacy));

  const timing = javaToastTiming(profile, params);
  cueJavaToast(ctx, profile, frame === 'challenge', timing);
  const restX = (automatic?.right ?? stage.width / 2) - PANEL_W * scale / 2 - margin;
  const restY = stage.height / 2 - PANEL_H * scale / 2 - margin;
  const endpointPad = 0.5 / stage.fps;
  return {
    duration: timing.duration,
    timing: timing.phases,
    cutTime: null,
    update(time) {
      const state = timing.sample(time);
      root.visible = time > endpointPad && time < timing.duration - endpointPad;
      root.position.set(
        legacy ? restX : restX + (PANEL_W * scale + margin) * (1 - state.horizontalShown),
        legacy ? restY + Math.trunc(36 * state.legacyHidden) * scale + margin * unit(state.legacyHidden * 36 / PANEL_H) : restY,
        0,
      );
      if (layout.alternating) {
        const alpha = javaTextAlpha(profile, state.holdAge);
        header.setOpacity(alpha.header);
        for (const title of titles) title.setOpacity(alpha.title);
      }
    },
    dispose() { panel?.dispose(); },
  };
}
