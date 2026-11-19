import { ScrubNumberField } from '@allay/ui/editor';
import type { ReactNode } from 'react';
import { useResourceStore } from '../../stores/resourceStore';
import { useStudioLabels } from './labels';

export function NumberField({ label, value, min, max, step = 1, onChange }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void;
}) {
  return (
    <FieldRow label={label}>
      <ScrubNumberField label={label} value={value} min={min} max={max} step={step} onChange={onChange} />
    </FieldRow>
  );
}

export function FieldRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid min-h-row grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-2">
    <span className="min-w-0 text-xs text-fg-muted" aria-hidden="true">{label}</span>
    {children}
  </div>;
}

export const selectClass = 'h-control w-full min-w-0 rounded-md bg-control px-2 text-xs text-foreground focus-visible:outline-2 focus-visible:outline-primary';

export function ProfileField({ value, inherit, onChange }: { value?: string; inherit?: boolean; onChange: (value: string | undefined) => void }) {
  const label = useStudioLabels();
  const profiles = useResourceStore((state) => state.state?.library?.profiles);
  if (!inherit && !profiles?.length && !value) return null;
  const name = label(inherit ? 'resourceVersion' : 'profile');
  return <FieldRow label={name}>
    <select aria-label={name} className={`${selectClass} disabled:opacity-45`} value={value ?? ''}
      disabled={!value && !profiles?.some((profile) => !profile.missing)} onChange={(event) => onChange(event.target.value || undefined)}>
      <option value="">{label(inherit ? 'inherit' : 'activeProfile')}</option>
      {value && !profiles?.some((profile) => profile.id === value) && <option value={value} disabled>{label('missingProfile')}</option>}
      {profiles?.map((profile) => <option key={profile.id} value={profile.id} disabled={profile.missing}>
        {profile.name} · {profile.versionId}{profile.missing ? ` · ${label('missingProfile')}` : ''}
      </option>)}
    </select>
  </FieldRow>;
}
