import type { ParamValue, SetupContext, TemplateInstance } from '@allay/template-sdk';
import { bedrockAchievementValues } from './bedrock-values';

const numeric = (value: ParamValue | undefined, fallback: number) => typeof value === 'number' ? value : fallback;
const string = (value: ParamValue | undefined) => typeof value === 'string' ? value : '';
const clamp = (value: number) => Math.min(1, Math.max(0, value));

export async function setupBedrockAchievement(ctx: SetupContext): Promise<TemplateInstance> {
  const { THREE, params, stage } = ctx;
  const zh = params.toastLanguage === 'zh-CN' || (params.toastLanguage !== 'en' && /^zh/i.test(ctx.locale));
  const iconOverride = string(params.bedrockAchievementIcon);
  const loadIcon = async () => {
    if (iconOverride) {
      const selected = await ctx.resources.optionalTexture(iconOverride);
      if (selected) return selected;
      ctx.warn(zh ? '无法读取所选基岩成就图标。' : 'The selected Bedrock achievement icon could not be read.');
    }
    return ctx.resources.optionalTexture('minecraft:ui/achievement_third_party');
  };
  const [panel, icon] = await Promise.all([
    ctx.resources.optionalTexture('minecraft:ui/greyborder'),
    loadIcon(),
  ]);
  if (!panel || !icon) ctx.warn(zh
    ? '缺少基岩游戏内提示的面板或图标。可导入普通资源包或绑定图标；不模拟 Xbox 通知。'
    : 'In-game toast panel or icon missing. Import a regular pack or bind an icon; Xbox notifications are not simulated.');
  const root = new THREE.Group();
  ctx.scene.add(root);
  const unit = Math.min(numeric(params.guiScale, 4), stage.width / 196);
  const margin = Math.max(0, numeric(params.margin, 0));
  const width = 186 * unit;
  const start = numeric(params.inDuration, 0.25);
  const hold = numeric(params.hold, 2.5);
  const duration = start + hold + numeric(params.outDuration, 0.25);
  const pad = Math.min(1 / stage.fps, start / 2, (duration - start - hold) / 2);

  const { heading, color, sound } = bedrockAchievementValues(params, zh);
  const label = (text: string, font: string, color: string) => ctx.text.create({
    text, font: font || 'minecraft:default', color, size: unit, align: 'left', maxWidth: width - (icon ? 28 : 13) * unit, shadow: false,
  });
  const first = heading ? label(heading, string(params.headerFont), color) : null;
  const second = label(string(params.title), string(params.titleFont), string(params.titleColor) || '#AAAAAA');
  const height = Math.max(28 * unit, (first?.height ?? 0) + second.height + 9 * unit);
  if (panel) {
    const sprite = ctx.sprite.create(panel, { pixelSize: unit });
    sprite.setSize(width, height);
    root.add(sprite.object);
  } else {
    root.add(new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ color: '#343434' })));
  }
  if (icon) {
    const sprite = ctx.sprite.create(icon);
    sprite.setSize(13 * unit, 13 * unit);
    sprite.object.position.set(-width / 2 + 12.5 * unit, 0, 1);
    sprite.object.renderOrder = 1;
    root.add(sprite.object);
  }
  const left = -width / 2 + (icon ? 21 : 6) * unit;
  first?.object.position.set(left, (second.height + unit) / 2, 2);
  second.object.position.set(left, first ? -(first.height + unit) / 2 : 0, 2);
  for (const text of first ? [first.object, second.object] : [second.object]) {
    text.traverse((child) => { child.renderOrder = 2; });
    root.add(text);
  }
  if (sound) ctx.audio.cue(sound, 0, { gain: numeric(params.volume, 0.8) });
  return {
    duration, cutTime: null,
    update(time) {
      const shown = Math.min(clamp((time - pad) / (start - pad)), clamp((duration - pad - time) / (duration - start - hold - pad)));
      const top = stage.height / 2;
      root.visible = shown > 0;
      root.position.y = top + height / 2 - (height + margin) * shown;
    },
  };
}
