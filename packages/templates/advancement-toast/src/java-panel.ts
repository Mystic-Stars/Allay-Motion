import type { SetupContext } from '@allay/template-sdk';
import type { JavaToastProfile } from './java-timing';

export const PANEL_W = 160;
export const PANEL_H = 32;
const SPRITE = 'minecraft:gui/sprites/toast/advancement';
const LEGACY_ATLAS = 'minecraft:gui/achievement/achievement_background';
const BETA_ATLAS = 'minecraft:gui/achievement/bg';
const TOAST_ATLAS = 'minecraft:gui/toasts';

type PanelSource = { id: string; crop?: readonly [number, number] };
const SOURCES: Record<JavaToastProfile, PanelSource[]> = {
  javaAchievement: [{ id: LEGACY_ATLAS, crop: [96, 202] }, { id: BETA_ATLAS, crop: [96, 202] }],
  javaAdvancement: [{ id: TOAST_ATLAS, crop: [0, 0] }, { id: SPRITE }],
  javaAdvancement263: [{ id: SPRITE }],
};

export async function createJavaPanel(ctx: SetupContext, profile: JavaToastProfile) {
  const { THREE } = ctx;
  for (const { id, crop } of SOURCES[profile]) {
    const map = await ctx.resources.optionalTexture(id);
    if (!map) continue;
    const geometry = new THREE.PlaneGeometry(PANEL_W, PANEL_H);
    if (crop) {
      const uv = geometry.getAttribute('uv');
      if (uv) {
        for (let index = 0; index < uv.count; index++) {
          uv.setXY(index, (crop[0] + PANEL_W * uv.getX(index)) / 256, 1 - (crop[1] + PANEL_H * (1 - uv.getY(index))) / 256);
        }
      }
    }
    const material = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false });
    const object = new THREE.Mesh(geometry, material);
    return { object, dispose() { geometry.dispose(); material.dispose(); } };
  }
  const ids = SOURCES[profile].map(({ id }) => id).join(' / ');
  ctx.warn(ctx.locale?.startsWith('zh')
    ? `缺少 Java 提示面板：${ids}。请选择对应版本的 Java 原版素材或含该贴图的资源包；不绘制替代面板。`
    : `Java toast panel unavailable: ${ids}. Select matching Java assets or a resource pack containing this texture; no substitute panel is drawn.`);
  return null;
}
