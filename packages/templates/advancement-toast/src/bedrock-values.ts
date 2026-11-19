import type { ParamValues } from '@allay/template-sdk';

export function bedrockAchievementValues(params: Readonly<ParamValues>, zh: boolean) {
  const preset = zh ? '成就已解锁' : 'Achievement unlocked';
  const legacyHeading = params.header;
  const inheritedHeading = typeof legacyHeading === 'string' && legacyHeading !== '' && legacyHeading !== 'Advancement Made!' && legacyHeading !== '进度已达成！'
    ? legacyHeading : preset;
  const customHeading = typeof params.bedrockHeading === 'string' ? params.bedrockHeading : '';
  const heading = params.bedrockHeadingMode === 'custom' ? customHeading : params.bedrockHeadingMode === 'preset' ? preset : inheritedHeading;
  const savedColor = typeof params.headerColor === 'string' ? params.headerColor : '#FFFFFF';
  const color = params.bedrockColorMode !== 'custom' && savedColor === '#FFFF55' ? '#FFFFFF' : savedColor;
  const savedSound = typeof params.sound === 'string' ? params.sound : null;
  const sound = params.bedrockSoundMode !== 'custom' && savedSound === 'minecraft:ui.toast.in' ? null : savedSound;
  return { heading, color, sound };
}
