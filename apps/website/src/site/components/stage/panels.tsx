// 分镜里浮在预览旁边的两块示意面板：属性面板（第二步）与导出进度面板（第三步，含悦灵 AllayProgress 捧块与跳舞编排）。
import { AllayProgress, type AllayProgressPhase } from '@allay/mascot';
import { localize, type TemplateManifest } from '@allay/template-sdk';
import { Slider } from '@allay/ui/components/slider';
import { Check } from '@phosphor-icons/react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { mcTextureUrl } from '../../../host/mc-pack';
import { SITE_EXPORT_FORMATS } from '../../links';
import { usePrefs } from '../../prefs';

export interface TuneValues {
  cols: number;
  inPattern: string;
  spin: string;
}

type Param = NonNullable<TemplateManifest['params']>[number];

function param(m: TemplateManifest, key: string): Param | undefined {
  return (m.params ?? []).find((p) => p.key === key);
}

function options(p: Param | undefined): { value: string; label: Record<string, string> | string; pattern?: number[] }[] {
  return p && 'options' in p && Array.isArray(p.options) ? (p.options as { value: string; label: Record<string, string> | string; pattern?: number[] }[]) : [];
}

/** 4×4 出场顺序小格图：每格深浅对应出场先后 */
export function PatternGrid({ pattern, size = 40 }: { pattern: number[]; size?: number }) {
  return (
    <span className="grid shrink-0 grid-cols-4 gap-[2px] rounded-[5px] bg-well p-[3px]" style={{ width: size, height: size }} aria-hidden="true">
      {pattern.map((v, i) => (
        <span key={i} className="rounded-[1.5px] bg-primary transition-opacity duration-300" style={{ opacity: 0.18 + (1 - v) * 0.82 }} />
      ))}
    </span>
  );
}

const panel = 'card p-4';

export function TunePanel({ manifest, values, className, style }: { manifest: TemplateManifest; values: TuneValues; className?: string; style?: CSSProperties }) {
  const { t } = useTranslation();
  const { language } = usePrefs();
  const cols = param(manifest, 'cols');
  const inPattern = param(manifest, 'inPattern');
  const spin = param(manifest, 'spin');
  const min = cols && 'min' in cols && typeof cols.min === 'number' ? cols.min : 4;
  const max = cols && 'max' in cols && typeof cols.max === 'number' ? cols.max : 40;
  const pat = options(inPattern).find((o) => o.value === values.inPattern);
  const spins = options(spin);

  return (
    <div className={`${panel} w-[300px] ${className ?? ''}`} style={style} data-testid="tune-panel">
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-semibold">{t('site.story.panel')}</span>
        <span className="text-[12px] text-fg-subtle">{localize(manifest.name, language)}</span>
      </div>
      <div className="mt-4 space-y-4 text-[12.5px]">
        <div>
          <div className="flex items-baseline justify-between">
            <span className="text-fg-muted">{cols ? localize(cols.label, language) : 'cols'}</span>
            <span className="t-tab text-[13px] font-medium text-foreground">{values.cols}</span>
          </div>
          <Slider className="mt-1" value={values.cols} min={min} max={max} disabled thumbLabel={cols ? localize(cols.label, language) : 'cols'} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-fg-muted">{inPattern ? localize(inPattern.label, language) : 'pattern'}</div>
            <div className="mt-1 font-medium">{pat ? localize(pat.label, language) : values.inPattern}</div>
          </div>
          {pat?.pattern && <PatternGrid pattern={pat.pattern} size={42} />}
        </div>
        <div>
          <div className="text-fg-muted">{spin ? localize(spin.label, language) : 'spin'}</div>
          <div className="mt-2 grid grid-cols-4 gap-[3px] rounded-[8px] bg-well p-[3px]">
            {spins.map((o) => (
              <span
                key={o.value}
                className={`truncate rounded-[5px] px-1 py-1 text-center text-[11px] transition-colors duration-200 ${
                  o.value === values.spin ? 'bg-control-hi font-medium text-foreground' : 'text-fg-subtle'
                }`}
              >
                {localize(o.label, language)}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function CarryBlock() {
  const src = mcTextureUrl('minecraft:block/diamond_block');
  return src ? <img src={src} alt="" width={14} height={14} className="pixelated size-full rounded-[2px]" draggable={false} /> : <span className="block size-full rounded-[2px] bg-[#52D6DC]" />;
}

export function ExportPanel({
  frame,
  total,
  phase,
  cutFrame,
  live,
  className,
  style,
}: {
  frame: number;
  total: number;
  phase: AllayProgressPhase;
  cutFrame: number;
  live: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useTranslation();
  const primary = SITE_EXPORT_FORMATS[0];
  return (
    <div className={`${panel} w-[360px] ${className ?? ''}`} style={style} data-testid="export-panel">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-semibold">{t('site.story.exportTitle')}</span>
        <span className="t-mono text-[10.5px] text-fg-subtle">1920 × 1080 · 60 fps</span>
      </div>
      <div className="mt-3 flex items-center gap-2.5 rounded-[9px] bg-primary-soft px-2.5 py-2 text-[12.5px]">
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Check size={10} weight="bold" />
        </span>
        <span className="truncate font-medium">{t(`site.features.formats.names.${primary.key}`)}</span>
        <span className="ml-auto flex gap-1">
          {SITE_EXPORT_FORMATS.map((p, i) => (
            <span key={p.id} className={`t-tab rounded-[4px] px-1 text-[10.5px] ${i === 0 ? 'text-primary-text' : 'text-fg-subtle'}`}>
              {p.ext}
            </span>
          ))}
        </span>
      </div>
      <div className="mt-3 min-h-[84px]">
        {live && <AllayProgress value={total > 0 ? frame / total : 0} phase={phase} carry={<CarryBlock />} label={t('site.story.exportProgressLabel')} />}
      </div>
      <p className="mt-2 flex items-center justify-between text-[12px]" aria-live="polite">
        <span className={phase === 'done' ? 'font-medium text-success' : 'text-fg-muted'}>
          {phase === 'done' ? t('site.story.exportStages.done') : phase === 'muxing' ? t('site.story.exportStages.muxing') : t('site.story.exportStages.rendering')}
        </span>
        <span className="t-tab text-fg-subtle">
          {phase === 'rendering' ? t('site.story.exportFrames', { written: frame, total }) : t('site.story.cutFrame', { frame: cutFrame })}
        </span>
      </p>
    </div>
  );
}
