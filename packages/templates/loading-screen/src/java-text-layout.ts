import type { GuiTextMetrics } from '@allay/template-sdk';

export function fitJavaGuiLine(metrics: GuiTextMetrics, scale: number, centerX: number, guiWidth: number, preferredBaseline: number, top: number, bottom: number) {
  const { advance, left, above, below, width } = metrics;
  if (width <= 0 || above + below <= 0 || bottom - top <= 1 || guiWidth <= 5) return null;

  const right = left + Math.ceil(width) + 1;
  const descent = Math.ceil(above + below) - above + 1;
  const leftEdge = 2;
  const rightEdge = guiWidth - 2;
  const constrain = (value: number, lower: number, upper: number) => Math.min(upper, Math.max(lower, value));
  const fitScale = Math.min(scale, (bottom - top - 1) / (above + descent), (rightEdge - leftEdge - 1) / (right - left));
  const penX = constrain(centerX - Math.floor(Math.ceil(advance * fitScale) / 2), Math.ceil(leftEdge - left * fitScale), Math.floor(rightEdge - right * fitScale));
  const baseline = constrain(preferredBaseline, Math.ceil(top + above * fitScale), Math.floor(bottom - descent * fitScale));
  return { penX, baseline, scale: fitScale };
}
