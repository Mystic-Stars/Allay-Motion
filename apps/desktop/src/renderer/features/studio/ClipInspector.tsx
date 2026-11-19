import { COMPOSITION_MAX_SECONDS, defaultParams, localize, sanitizeParams, sanitizeValue, studioMaterialKind, type Composition, type CompositionClip, type CompositionTrack, type ParamDef, type ParamValue } from '@allay/template-sdk';
import { Button } from '@allay/ui/components/button';
import { Dialog, DialogContent, DialogTitle } from '@allay/ui/components/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuItemIcon, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from '@allay/ui/components/dropdown-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@allay/ui/components/tabs';
import { EditorProvider, isVisible, ParamPanel, useEditor, type EditorServices } from '@allay/ui/editor';
import { ArrowRight, Copy, DotsThree, GearSix, Lock, Scissors, Trash } from '@phosphor-icons/react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { mapProjectImages, UNLINKED_PROJECT_IMAGE_REF } from '../../../shared/project';
import type { TemplateEntry } from '../../../shared/templates';
import { usePreviewStore } from '../../stores/previewStore';
import { useProjectStore } from '../../stores/projectStore';
import { readCompositionClip, type CompositionClipSource } from '../../templates/catalog';
import { SkinLibraryField } from '../skins/SkinLibraryField';
import { FontField } from '../fonts/FontField';
import { FontUsageHint } from '../fonts/FontUsageHint';
import { PanoramaFallbackHint } from '../resources/PanoramaFallbackHint';
import { seekFrame, useStudioFrame } from './StudioTimeline';
import { describeClip } from './clipPresentation';
import { TRANSFORM_KEYS, setKeyframe, valueAt, type TransformKey } from './edits';
import { FieldRow, NumberField, ProfileField, selectClass } from './fields';
import { useStudioLabels } from './labels';

type EditClip = (edit: (value: CompositionClip) => CompositionClip) => void;
type ObjectKind = Extract<ParamDef, { type: 'enum' }>;
let clipboard: { type: ParamDef['type']; value: ParamValue } | undefined;

function useClipTemplate(id: string, version: string, catalogRevision: unknown) {
  const [result, setResult] = useState<{ id: string; version: string; source: CompositionClipSource | null }>();
  useEffect(() => {
    let active = true;
    void readCompositionClip({ id, version }).catch(() => null).then((source) => {
      if (active) setResult({ id, version, source: source?.ref.id === id && source.ref.version === version ? source : null });
    });
    return () => { active = false; };
  }, [id, version, catalogRevision]);
  return result?.id === id && result.version === version ? result.source : undefined;
}

function ClipParams({ source, clip, doc, edit, objectKind }: { source: CompositionClipSource; clip: CompositionClip; doc: Composition; edit: EditClip; objectKind?: ObjectKind }) {
  const { i18n } = useTranslation();
  const label = useStudioLabels();
  const parent = useEditor();
  const fileNames = useProjectStore((state) => state.fileNames);
  const locale = i18n.language;
  const timing = usePreviewStore((state) => state.loaded?.clipTiming?.find(({ id }) => id === clip.id)?.timing);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [relinking, setRelinking] = useState(false);
  const [imagePreviews] = useState(() => new Map<string, Promise<string | null>>());
  useEffect(() => () => {
    for (const pending of imagePreviews.values()) void pending.then((url) => { if (url) URL.revokeObjectURL(url); });
    imagePreviews.clear();
  }, [imagePreviews]);
  const profileId = clip.profile ?? doc.defaultProfile;
  const services = useMemo<EditorServices>(() => ({
    ...parent,
    fps: doc.fps,
    renderFont: (props) => <FontField {...props} profileId={profileId} />,
    texturePreview(value: string) {
      if (!value.startsWith('asset:')) return parent.texturePreview(value);
      const assets = source.assets;
      if (!assets) return Promise.resolve(null);
      let pending = imagePreviews.get(value);
      if (!pending) {
        pending = window.allay.templates.readAsset(assets, value.slice(6)).then((bytes) =>
          bytes ? URL.createObjectURL(new Blob([new Uint8Array(bytes)])) : null).catch(() => null);
        imagePreviews.set(value, pending);
      }
      return pending;
    },
  }), [parent, doc.fps, source.assets, imagePreviews, profileId]);
  const defaults = useMemo(() => defaultParams(source.params, { locale }), [source, locale]);
  const values = useMemo(() => sanitizeParams(source.params, clip.params, { locale }), [source, clip.params, locale]);
  const skin = source.params.find((def) => def.type === 'texture' && def.skinLibrary === true && !source.hidden.includes(def.key));
  const unlinked = useMemo(() => {
    const refs = new Map<string, string>();
    for (const [key, value] of Object.entries(clip.params)) {
      const definition = objectKind && source.params.find((def) => def.key === key);
      if (definition && !isVisible(definition, values)) continue;
      mapProjectImages(value, (ref) => {
        if (UNLINKED_PROJECT_IMAGE_REF.test(ref) && !refs.has(ref)) refs.set(ref, key);
        return ref;
      });
    }
    return [...refs];
  }, [clip.params, objectKind, source.params, values]);
  const hidden = [...source.hidden, ...(objectKind ? [objectKind.key] : []), ...(skin ? [skin.key, 'armModel'] : [])];
  async function relink(ref: string) {
    setRelinking(true);
    try {
      const picked = await parent.pickImage?.();
      if (!picked) return;
      edit((current) => ({ ...current, params: Object.fromEntries(Object.entries(current.params).map(([key, value]) => [key,
        mapProjectImages(value, (candidate) => candidate === ref ? picked.value : candidate),
      ])) }));
    } finally {
      setRelinking(false);
    }
  }
  function change(key: string, value: ParamValue) {
    if (timing?.editable === false && Object.hasOwn(timing.durations, key)) return;
    const definition = source.params.find((def) => def.key === key);
    if (definition) edit((current) => ({ ...current, params: { ...current.params, [key]: sanitizeValue(definition, value, { locale }) } }));
  }
  return (
    <EditorProvider value={services}>
      <FontUsageHint clipId={clip.id} />
      <PanoramaFallbackHint clipId={clip.id} />
      {unlinked.length > 0 && <div role="status" className="flex flex-col gap-1 px-3 py-2 text-xs text-fg-muted">
        <p>{label('missingImage')}</p>
        {unlinked.map(([ref, key], index) => (
          <Button key={ref} size="sm" variant="secondary" disabled={relinking} onClick={() => void relink(ref)}>
            {label('image')} {index + 1} · {localize(source.params.find((def) => def.key === key)?.label, locale) || key}
          </Button>
        ))}
      </div>}
      {skin && <SkinLibraryField value={String(values[skin.key] ?? '')} language={locale} onSelect={(entry) => edit((current) => ({
        ...current, params: { ...current.params, [skin.key]: sanitizeValue(skin, entry?.ref ?? '', { locale }), armModel: entry?.model ?? 'classic' },
      }))} />}
      <ParamPanel defs={source.params} hidden={hidden} groups={source.manifest.groups} values={values} defaults={defaults}
        {...(timing?.editable === false && { readOnlyDurations: timing.durations })}
        onChange={change} collapsed={collapsed} onToggleGroup={(group, open) => setCollapsed((old) => ({ ...old, [group]: open }))} fileNames={fileNames}
        clipboard={{
          copy: (def, value) => { clipboard = { type: def.type, value: structuredClone(value) }; },
          paste: (def) => clipboard?.type === def.type ? sanitizeValue(def, clipboard.value, { locale }) : undefined,
        }} />
    </EditorProvider>
  );
}

function ClipTransform({ clip, doc, edit }: { clip: CompositionClip; doc: Composition; edit: EditClip }) {
  const label = useStudioLabels();
  const frame = useStudioFrame(doc) - clip.startFrame;
  const [mode, setMode] = useState<'base' | 'keyframe'>('base');
  const active = frame >= 0 && frame < clip.durationFrames;
  const point = clip.keyframes?.find((item) => item.frame === frame);
  function change(key: TransformKey, value: number) {
    edit((old) => mode === 'base' ? { ...old, transform: { ...old.transform, [key]: value } } : setKeyframe(old, frame, { [key]: value }));
  }
  return (
    <div className="px-3 py-2">
      <FieldRow label={label('transform')}>
        <select aria-label={label('transform')} className={selectClass} value={mode} onChange={(event) => setMode(event.target.value === 'base' ? 'base' : 'keyframe')}>
          <option value="base">{label('base')}</option><option value="keyframe">{label('keyframe')}</option>
        </select>
      </FieldRow>
      <div className="flex items-center gap-1 py-1">
        <Button size="sm" variant="secondary" disabled={!active || !!point} onClick={() => {
          edit((old) => setKeyframe(old, frame, Object.fromEntries(TRANSFORM_KEYS.map((key) => [key, valueAt(old, key, frame)]))));
          setMode('keyframe');
        }}>{label('addKey')}</Button>
        <Button size="sm" variant="ghost" disabled={!point} onClick={() => edit((old) => ({ ...old, keyframes: old.keyframes?.filter((item) => item.frame !== frame) }))}>
          {label('removeKey')}
        </Button>
      </div>
      {(mode === 'base' || active) && <div className="mt-1">
        {TRANSFORM_KEYS.map((key) => {
          const [min, max, step] = key === 'opacity' ? [0, 1, 0.01] : key === 'scale' ? [0, 100, 0.01] : key === 'rotation' ? [-36_000, 36_000, 1] : [-100_000, 100_000, 1];
          return <NumberField key={key} label={label(key)} value={mode === 'base' ? valueAt({ ...clip, keyframes: [] }, key, 0) : valueAt(clip, key, frame)}
            min={min} max={max} step={step} onChange={(value) => change(key, value)} />;
        })}
      </div>}
      {!!clip.keyframes?.length && <FieldRow label={label('keyframe')}>
        <select aria-label={label('keyframe')} className={`${selectClass} num`} value={point?.frame ?? ''} onChange={(event) => {
          if (event.target.value !== '') { seekFrame(doc, clip.startFrame + Number(event.target.value)); setMode('keyframe'); }
        }}>
          <option value="" disabled>—</option>
          {clip.keyframes.filter((item) => item.frame < clip.durationFrames).map((item) => <option key={item.frame} value={item.frame}>{item.frame + clip.startFrame}</option>)}
        </select>
      </FieldRow>}
    </div>
  );
}

type ClipActionsProps = {
  clip: CompositionClip; track: CompositionTrack; doc: Composition;
  move: (start: number, trackId?: string) => void; trim: (edge: 'start' | 'end', frame: number) => void;
  duplicate: () => void; split: (frame: number) => void; remove: () => void;
};

function ClipActions({ clip, track, doc, move, trim, duplicate, split, remove, edit, objectKind }: ClipActionsProps & { edit: EditClip; objectKind?: ObjectKind }) {
  const label = useStudioLabels();
  const { t, i18n } = useTranslation();
  const trigger = useRef<HTMLButtonElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const frame = useStudioFrame(doc);
  const end = clip.startFrame + clip.durationFrames;
  const otherTracks = doc.tracks.filter((item) => item.id !== track.id);
  return <><DropdownMenu>
    <DropdownMenuTrigger render={<Button ref={trigger} variant="ghost" size="icon-sm" aria-label={label('clipActions')} title={label('clipActions')} />}>
      <DotsThree size={18} weight="bold" />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuGroup>
        <DropdownMenuItem disabled={frame <= clip.startFrame || frame >= end} onClick={() => split(frame)}><DropdownMenuItemIcon icon={Scissors} />{label('split')}</DropdownMenuItem>
        <DropdownMenuItem onClick={duplicate}><DropdownMenuItemIcon icon={Copy} />{label('duplicate')}</DropdownMenuItem>
        <DropdownMenuItem disabled={frame >= end || frame < clip.startFrame - clip.sourceInFrame} onClick={() => trim('start', frame)}><DropdownMenuItemIcon />{label('trimIn')}</DropdownMenuItem>
        <DropdownMenuItem disabled={frame <= clip.startFrame} onClick={() => trim('end', frame)}><DropdownMenuItemIcon />{label('trimOut')}</DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={!otherTracks.some((item) => !item.locked)}><DropdownMenuItemIcon icon={ArrowRight} />{label('moveTo')}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-(--available-height) max-w-64 overflow-auto">
            <DropdownMenuGroup>
              {otherTracks.map((item) => <DropdownMenuItem key={item.id} disabled={item.locked} onClick={() => move(clip.startFrame, item.id)}>
                <DropdownMenuItemIcon /><span className="truncate">{item.name}</span>
              </DropdownMenuItem>)}
            </DropdownMenuGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuItem onClick={() => setSettingsOpen(true)}><DropdownMenuItemIcon icon={GearSix} />{label('openClipSettings')}</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={remove}><DropdownMenuItemIcon icon={Trash} />{label('delete')}</DropdownMenuItem>
      </DropdownMenuGroup>
    </DropdownMenuContent>
  </DropdownMenu>
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent closeLabel={t('common.close')} finalFocus={trigger}>
        <DialogTitle>{label('clipSettings')}</DialogTitle>
        <div>
          {objectKind && <FieldRow label={label('changeObjectKind')}>
            <select aria-label={label('changeObjectKind')} className={selectClass}
              value={String(sanitizeValue(objectKind, clip.params[objectKind.key], { locale: i18n.language }))}
              onChange={(event) => {
                const value = sanitizeValue(objectKind, event.currentTarget.value, { locale: i18n.language });
                edit((old) => old.params[objectKind.key] === value ? old : { ...old, params: { ...old.params, [objectKind.key]: value } });
              }}>
              {objectKind.options.map((option) => <option key={option.value} value={option.value}>{localize(option.label, i18n.language)}</option>)}
            </select>
          </FieldRow>}
          <ProfileField value={clip.profile} inherit onChange={(profile) => edit((old) => old.profile === profile ? old : { ...old, profile })} />
        </div>
      </DialogContent>
    </Dialog>
  </>;
}

export function ClipInspector({ catalogRevision, edit, ...actions }: ClipActionsProps & { catalogRevision: readonly TemplateEntry[]; edit: EditClip }) {
  const { clip, track, doc, move, trim } = actions;
  const label = useStudioLabels();
  const { i18n } = useTranslation();
  const titleId = useId();
  const fileNames = useProjectStore((state) => state.fileNames);
  const source = useClipTemplate(clip.template.id, clip.template.version, catalogRevision);
  const manifest = source?.manifest ?? catalogRevision.find((entry) => entry.id === clip.template.id && entry.version === clip.template.version)?.manifest;
  const objectKind = studioMaterialKind(clip.template) === 'object' ? source?.params.find((def): def is ObjectKind =>
    def.key === 'kind' && def.type === 'enum' && !source.hidden.includes(def.key)) : undefined;
  const { name, icon: Icon } = describeClip(clip, manifest?.name, i18n.language, label, fileNames, manifest?.params?.find((def) => def.key === 'kind')?.default);
  return (
    <section aria-labelledby={titleId} data-testid="studio-inspector" className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-3 pt-3 pb-2">
        <Icon aria-hidden="true" size={16} weight="fill" className="shrink-0 self-start text-fg-muted" />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="truncate text-lg leading-tight font-semibold" title={name}>{name}</h2>
          <p className="truncate text-xs text-fg-subtle" title={track.name}>{track.name}</p>
        </div>
        {!track.locked && <ClipActions {...actions} {...{ edit, objectKind }} />}
      </header>
      {track.locked ? <p className="flex items-center gap-2 border-t border-divider px-3 py-2 text-xs text-fg-muted"><Lock size={14} />{label('lockNote')}</p> :
        <Tabs key={clip.id} defaultValue="content" className="flex min-h-0 flex-1 flex-col">
          <TabsList aria-label={label('clip')} className="h-9 shrink-0 gap-1 border-b border-divider px-2">
            <TabsTrigger value="content">{label('content')}</TabsTrigger>
            <TabsTrigger value="transform">{label('transform')}</TabsTrigger>
            <TabsTrigger value="timing">{label('timing')}</TabsTrigger>
          </TabsList>
          <TabsContent value="content" keepMounted className="min-h-0 overflow-auto">
            {source && <ClipParams {...{ source, clip, doc, edit, objectKind }} />}
            {source === null && <p role="status" className="px-3 text-xs text-fg-muted">{label('missingTemplate')}</p>}
          </TabsContent>
          <TabsContent value="transform" keepMounted className="min-h-0 overflow-auto"><ClipTransform {...{ clip, doc, edit }} /></TabsContent>
          <TabsContent value="timing" className="min-h-0 overflow-auto px-3 py-2">
            <NumberField label={label('start')} min={0} max={doc.durationFrames - clip.durationFrames} value={clip.startFrame} onChange={move} />
            <NumberField label={label('length')} min={1} max={doc.durationFrames - clip.startFrame} value={clip.durationFrames} onChange={(value) => trim('end', clip.startFrame + value)} />
            <NumberField label={label('sourceIn')} min={0} max={COMPOSITION_MAX_SECONDS * 60} value={clip.sourceInFrame} onChange={(value) => {
              const sourceInFrame = Math.round(value);
              edit((old) => sourceInFrame === old.sourceInFrame ? old : { ...old, sourceInFrame });
            }} />
          </TabsContent>
        </Tabs>}
    </section>
  );
}
