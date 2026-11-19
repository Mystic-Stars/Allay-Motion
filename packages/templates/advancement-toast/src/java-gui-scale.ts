import type { StageInfo } from '@allay/template-sdk';

export function vanillaGuiScale(width: number, height: number): number {
  return Math.max(1, Math.min(Math.floor(width / 320), Math.floor(height / 240)));
}

export function javaGuiProjection(stage: StageInfo): { scale: number; right: number } {
  const reference = stage.referenceSize ?? {
    width: Math.round(stage.width * stage.pixelScale),
    height: Math.round(stage.height * stage.pixelScale),
  };
  const guiScale = vanillaGuiScale(reference.width, reference.height);
  const unitsPerPixel = Math.min(stage.width, stage.height) / Math.min(reference.width, reference.height);
  const guiRight = Math.ceil(reference.width / guiScale) * guiScale;
  return {
    scale: guiScale * unitsPerPixel,
    right: stage.width / 2 + (guiRight - reference.width) * unitsPerPixel,
  };
}
