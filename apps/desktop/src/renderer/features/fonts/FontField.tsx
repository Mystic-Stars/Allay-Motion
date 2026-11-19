import { DEFAULT_FONT_ID, normalizeRequestedFont } from '@allay/template-sdk';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@allay/ui/components/select';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FontCatalogSchema } from '../../../shared/fonts';
import { profileStamp } from '../../engine-host/resource-client';
import { useResourceStore } from '../../stores/resourceStore';

const catalogs = new Map<string, Promise<string[]>>();

function listFonts(key: string, profileId?: string): Promise<string[]> {
  let pending = catalogs.get(key);
  if (!pending) {
    pending = window.allay.fonts.list(profileId).then((raw) => FontCatalogSchema.parse(raw).resources
      .filter((id) => id !== DEFAULT_FONT_ID && normalizeRequestedFont(id) === id)).catch(() => {
      catalogs.delete(key);
      return [];
    });
    catalogs.set(key, pending);
    if (catalogs.size > 8) catalogs.delete(catalogs.keys().next().value!);
  }
  return pending;
}

export interface AnimationFontFieldProps {
  value: string;
  onChange(value: string): void;
  label: string;
  testId: string;
  profileId?: string;
}

export function FontField({ value, onChange, label, testId, profileId }: AnimationFontFieldProps) {
  const { t } = useTranslation();
  const stamp = useResourceStore(() => profileStamp(profileId));
  const key = JSON.stringify([profileId, stamp]);
  const [catalog, setCatalog] = useState<{ key: string; resources: string[] }>();
  useEffect(() => {
    let current = true;
    void listFonts(key, profileId).then((resources) => { if (current) setCatalog({ key, resources }); });
    return () => { current = false; };
  }, [key, profileId]);

  const resources = catalog?.key === key ? catalog.resources : [];
  const requested = normalizeRequestedFont(value);
  const current = requested === DEFAULT_FONT_ID ? t('editor.font.default')
    : catalog?.key === key && !resources.includes(requested) ? t('editor.font.unavailable', { id: requested }) : requested;
  return (
    <Select value={requested} onValueChange={(next) => { if (next === DEFAULT_FONT_ID || (next !== null && resources.includes(next))) onChange(next); }}>
      <SelectTrigger aria-label={label} title={current} data-testid={testId}>
        <SelectValue className="truncate">{current}</SelectValue>
      </SelectTrigger>
      <SelectContent className="max-w-(--available-width)">
        <SelectItem value={DEFAULT_FONT_ID}>{t('editor.font.default')}</SelectItem>
        {resources.map((id) => <SelectItem key={id} value={id} label={id}><span className="truncate">{id}</span></SelectItem>)}
      </SelectContent>
    </Select>
  );
}
