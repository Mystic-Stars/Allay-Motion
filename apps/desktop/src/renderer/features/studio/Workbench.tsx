import { COMPOSITION_MAX_SECONDS, COMPOSITION_MAX_TRACKS, CompositionFpsSchema, localize, studioMaterialKind, type Composition, type CompositionClip } from '@allay/template-sdk';
import { Button } from '@allay/ui/components/button';
import { Dialog, DialogContent, DialogTitle } from '@allay/ui/components/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuItemIcon, DropdownMenuSeparator, DropdownMenuTrigger } from '@allay/ui/components/dropdown-menu';
import { useEditor } from '@allay/ui/editor';
import { CaretDown, DotsThree, FilmStrip, GearSix, Pause, PencilSimple, Play, Plus, Repeat, SkipBack, SkipForward, SpeakerHigh, SpeakerSlash, Stack, Trash } from '@phosphor-icons/react';
import { notify } from '../../stores/noticeStore';
import { useProjectStore } from '../../stores/projectStore';
import { useResourceStore } from '../../stores/resourceStore';
import { useTemplateStore } from '../../stores/templateStore';
import { useTransportStore } from '../../stores/transportStore';
import { usePreviewStore } from '../../stores/previewStore';
import { useUiStore } from '../../stores/uiStore';
import { readCompositionClip } from '../../templates/catalog';
import { togglePlay } from '../commands/commands';
import { newComposition } from '../project/actions';
import { boundResourceEdition, creationParams } from '../templates/profileDefaults';
import { formatTimecode } from '../transport/TransportBar';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipInspector } from './ClipInspector';
import { StudioTimeline, seekFrame, templateKey, useStudioFrame } from './StudioTimeline';
import { appendClip, clampFrame, clipEdit, duplicateClip, lastClipEnd, makeTrack, moveClip, splitClip, trackEdit, trimClip, type Selection } from './edits';
import { FieldRow, NumberField, ProfileField, selectClass } from './fields';
import { useStudioLabels } from './labels';
import { materialIcons, materialRefs, type Material } from './clipPresentation';

function editDocument(edit: (doc: Composition) => Composition) {
  const project = useProjectStore.getState();
  if (project.composition) project.setComposition(edit(project.composition));
}

type WorkbenchProps = { doc: Composition; selection: Selection | null; select: (selection: Selection | null) => void };

export function StudioIntro() {
  const label = useStudioLabels();
  const enabled = useProjectStore((state) => state.template !== null);
  return <div className="flex h-12 items-center gap-2 px-3">
    <p className="min-w-0 text-xs text-fg-muted">{label('intro')}</p>
    <Button size="sm" variant="secondary" onClick={() => void newComposition()}>{label('newAnimation')}</Button>
    <Button size="sm" variant="secondary" disabled={!enabled} onClick={() => void newComposition(true)}>{label('fromQuick')}</Button>
  </div>;
}

function Playback({ doc }: { doc: Composition }) {
  const label = useStudioLabels();
  const { t } = useTranslation();
  const ready = usePreviewStore((state) => state.status.kind === 'ready');
  const playing = useTransportStore((state) => state.playing);
  const loop = useTransportStore((state) => state.loop);
  const muted = useUiStore((state) => state.settings.editor.muted);
  const playLabel = t(playing ? 'transport.pause' : 'transport.play');
  const muteLabel = t(muted ? 'transport.unmute' : 'transport.mute');
  return <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={t('transport.region')}>
    <Button size="icon-sm" variant="ghost" aria-label={label('first')} title={label('first')} onClick={() => seekFrame(doc, 0)}><SkipBack size={16} weight="fill" /></Button>
    <Button size="icon-lg" variant="secondary" aria-label={playLabel} title={playLabel} disabled={!ready} onClick={togglePlay}>
      {playing ? <Pause size={16} weight="fill" /> : <Play size={16} weight="fill" />}
    </Button>
    <Button size="icon-sm" variant="ghost" aria-label={label('last')} title={label('last')} onClick={() => seekFrame(doc, doc.durationFrames - 1)}><SkipForward size={16} weight="fill" /></Button>
    <Button size="icon-sm" variant="ghost" aria-label={t('transport.loop')} title={t('transport.loop')} aria-pressed={loop} onClick={() => useTransportStore.getState().setLoop(!loop)}><Repeat size={16} /></Button>
    <Button size="icon-sm" variant="ghost" aria-label={muteLabel} title={muteLabel} aria-pressed={muted} onClick={() => useUiStore.getState().setEditor({ muted: !muted })}>
      {muted ? <SpeakerSlash size={16} weight="fill" /> : <SpeakerHigh size={16} />}
    </Button>
  </div>;
}

function TransportReadout({ doc }: { doc: Composition }) {
  const label = useStudioLabels();
  const frame = useStudioFrame(doc);
  const [draft, setDraft] = useState<string | null>(null);
  return <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
    <span className="num text-xl font-semibold" data-testid="studio-timecode">{formatTimecode(frame / doc.fps, doc.fps)}</span>
    <span className="num text-xs text-fg-subtle">/ {formatTimecode((doc.durationFrames - 1) / doc.fps, doc.fps)}</span>
    <label className="ml-1 flex items-center gap-1 text-2xs text-fg-subtle">
      {label('frame')}
      <input className="num h-control w-16 rounded-md bg-control px-1.5 text-right text-xs text-foreground [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        type="number" min={0} max={doc.durationFrames - 1} value={draft ?? frame} onChange={(event) => setDraft(event.target.value)} onBlur={(event) => {
          if (draft !== null && Number.isFinite(event.target.valueAsNumber)) seekFrame(doc, event.target.valueAsNumber);
          setDraft(null);
        }} onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') { setDraft(null); event.preventDefault(); }
        }} />
    </label>
  </div>;
}

export function StudioWorkbench({ doc, selection, select }: WorkbenchProps) {
  const label = useStudioLabels();
  const { t, i18n } = useTranslation();
  const editor = useEditor();
  const entries = useTemplateStore((state) => state.entries);
  const installed = useMemo(() => new Map(entries.filter((entry) => !entry.baseMissing).map((entry) => [templateKey(entry), entry])), [entries]);
  const [pending, setPending] = useState(false);
  const [dialog, setDialog] = useState<'template' | 'settings' | 'rename' | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const track = doc.tracks.find((value) => value.id === selection?.trackId);

  function addTrack() {
    const id = crypto.randomUUID();
    editDocument((current) => current.tracks.length >= COMPOSITION_MAX_TRACKS ? current : {
      ...current, tracks: [...current.tracks, makeTrack(id, `${label('track')} ${current.tracks.length + 1}`)],
    });
    select({ trackId: id });
  }

  async function append(ref: CompositionClip['template'], material?: Material) {
    if (track?.locked || pending) return;
    const key = templateKey(ref);
    const snapshot = useProjectStore.getState().composition;
    setPending(true);
    try {
      const source = await readCompositionClip(ref);
      if (!source || templateKey(source.ref) !== key) {
        notify('error', t('project.errors.templateMissing', ref));
        return;
      }
      const picture = material === 'image' ? await editor.pickImage() : null;
      if (material === 'image' && !picture) return;
      const project = useProjectStore.getState();
      const current = project.composition;
      if (!current || current !== snapshot) return;
      const params = creationParams(source, i18n.language, boundResourceEdition(useResourceStore.getState().state, current.defaultProfile));
      const isObject = studioMaterialKind(source.ref) === 'object';
      if (isObject && material && material !== 'player') params.kind = material;
      if (picture) params.image = picture.value;
      const segmentKeys = source.manifest.timeline?.segments.map(({ param }) => param) ?? [];
      const seconds = segmentKeys.length ? segmentKeys.reduce((sum, param) => sum + Number(params[param] ?? 0), 0)
        : typeof params.duration === 'number' ? params.duration : isObject ? 3 : 1;
      const startFrame = clampFrame(useTransportStore.getState().time * current.fps, 0, current.durationFrames - 1);
      const durationFrames = clampFrame(seconds * current.fps, 1, current.fps * COMPOSITION_MAX_SECONDS - startFrame);
      const target = (material === 'sound' ? undefined : current.tracks.find((value) => value.id === track?.id)) ?? makeTrack(crypto.randomUUID(), material ? label(material) : `${label('track')} ${current.tracks.length + 1}`);
      const clip: CompositionClip = { id: crypto.randomUUID(), startFrame, durationFrames, sourceInFrame: 0, template: source.ref, params };
      const next = appendClip(current, target, clip);
      if (next === current) { notify('info', label('limit')); return; }
      project.setComposition(next);
      select({ trackId: target.id, clipId: clip.id });
    } catch {
      notify('error', t('project.errors.templateMissing', ref));
    } finally {
      setPending(false);
    }
  }

  const blocked = pending || track?.locked;
  return <>
    <div className="flex h-12 shrink-0 items-center gap-3 px-3">
      <Playback doc={doc} />
      <TransportReadout doc={doc} />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button ref={addButton} size="default" variant="secondary" data-testid="studio-add" />}>
            <Plus size={14} />{label('add')}<CaretDown size={10} />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={doc.tracks.length >= COMPOSITION_MAX_TRACKS} onClick={addTrack}><DropdownMenuItemIcon icon={Stack} />{label('addTrack')}</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={blocked || !installed.size} onClick={() => setDialog('template')}><DropdownMenuItemIcon icon={FilmStrip} />{label('addTemplate')}</DropdownMenuItem>
              {(Object.keys(materialRefs) as Material[]).map((material) => {
                return <DropdownMenuItem key={material} disabled={blocked} onClick={() => void append(materialRefs[material], material)}>
                  <DropdownMenuItemIcon icon={materialIcons[material]} />{label(material)}
                </DropdownMenuItem>;
              })}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button ref={moreButton} variant="ghost" size="icon-sm" aria-label={label('timelineActions')} title={label('timelineActions')} />}>
            <DotsThree size={18} weight="bold" />
          </DropdownMenuTrigger>
          <DropdownMenuContent side="top" align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => setDialog('settings')}><DropdownMenuItemIcon icon={GearSix} />{label('compositionSettings')}</DropdownMenuItem>
              {track && <>
                <DropdownMenuItem disabled={track.locked} onClick={() => setDialog('rename')}><DropdownMenuItemIcon icon={PencilSimple} />{label('renameTrack')}</DropdownMenuItem>
                <DropdownMenuItem disabled={track.locked || track.clips.length !== 0} onClick={() => {
                  editDocument((current) => trackEdit(current, track.id, (value) => value.locked || value.clips.length ? value : null));
                  select(null);
                }} variant="destructive"><DropdownMenuItemIcon icon={Trash} />{label('deleteTrack')}</DropdownMenuItem>
              </>}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
    <Dialog open={dialog === 'template'} onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <DialogContent closeLabel={t('common.close')} finalFocus={addButton}>
        <DialogTitle>{label('selectTemplate')}</DialogTitle>
        <div className="flex min-h-0 flex-col gap-0.5 overflow-auto p-1">
          {!installed.size && <p className="text-xs text-fg-subtle">{label('noTemplates')}</p>}
          {[...installed].map(([key, entry]) => <Button key={key} variant="ghost" className="w-full justify-start" onClick={() => {
            setDialog(null);
            void append({ id: entry.id, version: entry.version });
          }}>
            <FilmStrip size={14} /><span className="min-w-0 truncate">{localize(entry.manifest.name, i18n.language)}</span>
            <span className="num ml-auto text-xs text-fg-subtle">{entry.version}</span>
          </Button>)}
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={dialog === 'settings'} onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <DialogContent closeLabel={t('common.close')} finalFocus={moreButton}>
        <DialogTitle>{label('compositionSettings')}</DialogTitle>
        <CompositionSettings doc={doc} />
      </DialogContent>
    </Dialog>
    <Dialog open={dialog === 'rename' && !!track} onOpenChange={(open) => { if (!open) setDialog(null); }}>
      <DialogContent closeLabel={t('common.close')} finalFocus={moreButton}>
        <DialogTitle>{label('renameTrack')}</DialogTitle>
        {track && <form key={track.id} className="flex items-center gap-2" onSubmit={(event) => {
          event.preventDefault();
          const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
          if (name) editDocument((current) => trackEdit(current, track.id, (value) => value.locked || name === value.name ? value : { ...value, name }));
          setDialog(null);
        }}>
          <input className={selectClass} name="name" aria-label={label('trackName')} defaultValue={track.name} required maxLength={120} />
          <Button type="submit" variant="secondary">{label('rename')}</Button>
        </form>}
      </DialogContent>
    </Dialog>
    <StudioTimeline doc={doc} entries={installed} selection={selection} select={select}
      onTrack={(id, edit) => editDocument((current) => trackEdit(current, id, edit))}
      onDrag={(target, mode, frame) => editDocument((current) => mode === 'move' ? moveClip(current, target, frame) : trimClip(current, target, mode, frame))} />
  </>;
}

export function StudioInspector({ doc, selection, select }: WorkbenchProps) {
  const cat = useTemplateStore((state) => state.entries);
  const track = doc.tracks.find((value) => value.id === selection?.trackId);
  const clip = track?.clips.find((value) => value.id === selection?.clipId);
  if (!clip || !track || !selection) return null;
  return <div className="flex h-full min-h-0 min-w-0 flex-col overflow-auto rounded-xl bg-surface-1">
    <ClipInspector {...{ clip, track, doc, catalogRevision: cat }}
      edit={(edit) => editDocument((current) => clipEdit(current, selection, edit))}
      move={(start, target) => {
        editDocument((current) => moveClip(current, selection, start, target));
        if (target && useProjectStore.getState().composition?.tracks.find((value) => value.id === target)?.clips.some((value) => value.id === clip.id)) select({ ...selection, trackId: target });
      }} trim={(edge, frame) => editDocument((current) => trimClip(current, selection, edge, frame))}
      duplicate={() => {
        const id = crypto.randomUUID();
        editDocument((current) => duplicateClip(current, track, clip, id));
        if (useProjectStore.getState().composition?.tracks.find((value) => value.id === track.id)?.clips.some((value) => value.id === id)) select({ trackId: track.id, clipId: id });
      }} split={(frame) => editDocument((current) => splitClip(current, selection, frame, crypto.randomUUID()))}
      remove={() => { editDocument((current) => clipEdit(current, selection, () => null)); select({ trackId: track.id }); }} />
  </div>;
}

function CompositionSettings({ doc }: { doc: Composition }) {
  const label = useStudioLabels();
  const output = useProjectStore((state) => state.output);
  return <div className="min-h-0 overflow-auto p-1">
      <NumberField label={label('duration')} value={doc.durationFrames} min={lastClipEnd(doc)} max={doc.fps * COMPOSITION_MAX_SECONDS}
        onChange={(value) => {
          const durationFrames = Math.round(value);
          editDocument((current) => durationFrames === current.durationFrames ? current : { ...current, durationFrames });
        }} />
      <FieldRow label="FPS">
        <select aria-label="FPS" className={selectClass} value={doc.fps} onChange={(event) => {
          const fps = CompositionFpsSchema.parse(Number(event.target.value));
          editDocument((current) => ({ ...current, fps }));
        }}>
          {[...CompositionFpsSchema.values].map((fps) => <option key={fps} value={fps} disabled={doc.durationFrames > fps * COMPOSITION_MAX_SECONDS}>{fps}</option>)}
        </select>
      </FieldRow>
      <ProfileField value={doc.defaultProfile} onChange={(defaultProfile) => editDocument((current) => ({ ...current, defaultProfile }))} />
      <fieldset className="mt-3 border-t border-divider pt-1">
        <legend className="text-xs text-fg-muted">{label('resolution')}</legend>
        <NumberField label={label('width')} value={output.width} min={16} max={8192} onChange={(width) => useProjectStore.getState().setOutput({ ...output, width: Math.round(width) })} />
        <NumberField label={label('height')} value={output.height} min={16} max={8192} onChange={(height) => useProjectStore.getState().setOutput({ ...output, height: Math.round(height) })} />
      </fieldset>
  </div>;
}
