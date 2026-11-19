import { useId, useState } from 'react';
import { localize, type Composition } from '@allay/template-sdk';
import { Button } from '@allay/ui/components/button';
import type { CompositionPackage, CompositionPackageEntry, FreezeCompositionRequest } from '../../../shared/template-authoring';
import type { SkinEntry, SkinModel } from '../../../shared/skins';
import { clearHistory, useProjectStore } from '../../stores/projectStore';
import { useResourceStore } from '../../stores/resourceStore';
import { useTransportStore } from '../../stores/transportStore';
import { readCompositionClip } from '../../templates/catalog';
import { codeFieldClass, confirmReplace } from './controls';
import { instantiateComposition, parseCompositionDocument, trialComposition } from './compositionDraft';
import type { AuthoringMessages } from './messages';

interface PanelProps { messages: AuthoringMessages; locale: string }
interface Choice { clipId: string; key: string; label: string }

function useOperation(messages: AuthoringMessages) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setStatus('');
    try { await action(); }
    catch (error) { setStatus(`${messages.failed}: ${String(error).slice(0, 1000)}`); }
    finally { setBusy(false); }
  };
  return { busy, status, setStatus, run };
}

export function CompositionEditor({ messages, locale }: PanelProps) {
  const current = useProjectStore((state) => state.composition);
  const [draft, setDraft] = useState<{ base: Composition | null; text: string } | null>(null);
  const [name, setName] = useState('');
  const [choices, setChoices] = useState<{ base: Composition; items: Choice[] } | null>(null);
  const [checked, setChecked] = useState<number[]>([]);
  const { busy, status, setStatus, run } = useOperation(messages);
  const fieldId = useId();
  const document = current ?? { formatVersion: 1, fps: 60, durationFrames: 120, tracks: [] };
  const text = draft?.text ?? JSON.stringify(document, null, 2);

  const apply = async () => {
    const before = useProjectStore.getState();
    if (draft && draft.base !== current) throw new Error(messages.discard);
    const next = parseCompositionDocument(text);
    await trialComposition(next, before.output, locale, useTransportStore.getState().time);
    if (useProjectStore.getState().revision !== before.revision) return;
    useProjectStore.getState().setComposition(next);
    setDraft(null);
    setStatus(messages.applied);
  };

  const chooseExposure = async () => {
    if (!current) return;
    const sources = new Map<string, ReturnType<typeof readCompositionClip>>();
    const items: Choice[] = [];
    for (const track of current.tracks) for (const clip of track.clips) {
      const { id, version } = clip.template;
      const identity = `${id}@${version}`;
      const pending = sources.get(identity) ?? readCompositionClip(clip.template);
      sources.set(identity, pending);
      const source = await pending;
      if (!source) throw new Error(identity);
      for (const definition of source.params) {
        if (source.hidden.includes(definition.key)) continue;
        items.push({ clipId: clip.id, key: definition.key, label: `${track.name} / ${clip.id} · ${localize(definition.label, locale)}` });
      }
    }
    setChecked([]);
    setChoices({ base: current, items });
  };

  const freeze = async () => {
    if (!current || choices?.base !== current) return;
    const { width, height } = useProjectStore.getState().output;
    const request: FreezeCompositionRequest = {
      document: JSON.stringify(current), name, canvas: { width, height },
      expose: checked.map((index) => { const { clipId, key } = choices.items[index]!; return { clipId, key }; }),
    };
    const result = await window.allay.templates.freezeComposition(request);
    if ('canceled' in result) return;
    setStatus(result.ok ? messages.frozen : `${messages.failed}: ${result.error}`);
  };

  return <div className="flex flex-col gap-2">
    {!current && <p className="text-xs text-muted-foreground">{messages.empty}</p>}
    <label htmlFor={`${fieldId}-json`} className="text-sm">{messages.composition}</label>
    <textarea id={`${fieldId}-json`} className={codeFieldClass} spellCheck={false} wrap="off" disabled={busy} value={text} onChange={(event) => setDraft({ base: draft ? draft.base : current, text: event.currentTarget.value })} />
    <div className="flex flex-wrap gap-2">
      <Button size="sm" disabled={busy || (!!current && !draft)} onClick={() => void run(apply)}>{messages.applyJson}</Button>
      {draft && <Button size="sm" variant="outline" disabled={busy} onClick={() => setDraft(null)}>{messages.discardDraft}</Button>}
      <Button size="sm" variant="outline" disabled={busy || !current || !!draft} onClick={() => void run(chooseExposure)}>{messages.chooseExposure}</Button>
    </div>
    {current && choices?.base === current && !draft && <>
      <p className="text-xs text-muted-foreground">{messages.freezeHelp}</p>
      <fieldset disabled={busy} className="max-h-48 overflow-auto rounded-md border p-2">
        <legend className="text-xs">{messages.chooseExposure}</legend>
        {choices.items.map((choice, index) => <label key={`${index}-${choice.key}`} className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={checked.includes(index)} disabled={checked.length >= 128 && !checked.includes(index)} onChange={(event) => {
            const enabled = event.currentTarget.checked;
            setChecked((previous) => enabled ? [...previous, index] : previous.filter((value) => value !== index));
          }} />{choice.label}
        </label>)}
      </fieldset>
      <label className="flex flex-col gap-1 text-sm">{messages.packageName}<input className="rounded-md border bg-background p-2" maxLength={60} disabled={busy} value={name} onChange={(event) => setName(event.currentTarget.value)} /></label>
      <Button size="sm" disabled={busy || !name.trim()} className="self-start" onClick={() => void run(freeze)}>{messages.freeze}</Button>
    </>}
    {status && <p role="status" className="break-words text-sm">{status}</p>}
  </div>;
}

export function CompositionLibraryPanel({ messages, locale }: PanelProps) {
  const [entries, setEntries] = useState<CompositionPackageEntry[] | null>(null);
  const [selected, setSelected] = useState<CompositionPackage | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const [assets, setAssets] = useState<Record<string, string>>({});
  const [profiles, setProfiles] = useState<Record<string, string>>({});
  const [skins, setSkins] = useState<SkinEntry[]>([]);
  const [skinModel, setSkinModel] = useState<SkinModel>('classic');
  const localProfiles = useResourceStore((state) => state.state?.library?.profiles);
  const profileRefs = selected ? [...new Set([selected.composition.defaultProfile, ...selected.composition.tracks.flatMap((track) => track.clips.map((clip) => clip.profile))].filter((value): value is string => !!value))] : [];
  const missingAssets = selected && [...selected.externalImages, ...selected.externalSkins].some((ref) => !assets[ref]);
  const missingProfiles = profileRefs.some((ref) => !localProfiles?.some((profile) => profile.id === (Object.hasOwn(profiles, ref) ? profiles[ref] : ref) && !profile.missing));
  const { busy, status, setStatus, run } = useOperation(messages);
  const refresh = async () => setEntries(await window.allay.templates.listCompositions());

  const open = async (id: string) => {
    const result = await window.allay.templates.openComposition(id);
    if (!result.ok) { setStatus(`${messages.failed}: ${result.error}`); return; }
    const pkg = result.package;
    setSelected(pkg);
    const localSkins = pkg.externalSkins.length ? await window.allay.skins?.list() ?? [] : [];
    setSkins(localSkins);
    setAssets(Object.fromEntries(pkg.externalSkins.filter((ref) => localSkins.some((skin) => skin.ref === ref)).map((ref) => [ref, ref])));
    setProfiles({});
    setValues(pkg.exposed.map(({ clipId, key }) => {
      const clip = pkg.composition.tracks.flatMap((track) => track.clips).find((item) => item.id === clipId);
      const value = clip?.params[key];
      return typeof value === 'string' && pkg.externalImages.includes(value.toLowerCase()) ? '' : JSON.stringify(value) ?? '';
    }));
  };

  const instantiate = async () => {
    if (!selected || !await confirmReplace(messages)) return;
    const before = useProjectStore.getState();
    const verified = await window.allay.templates.openComposition(selected.id);
    if (!verified.ok) throw new Error(verified.error);
    if (JSON.stringify(verified.package) !== JSON.stringify(selected)) throw new Error(messages.externalChange);
    const composition = instantiateComposition(verified.package, values, assets, profiles, locale);
    const output = { ...verified.package.canvas, fps: composition.fps };
    await trialComposition(composition, output, locale, 0);
    if (useProjectStore.getState().revision !== before.revision) return;
    useProjectStore.getState().reset({ template: null, composition, output, name: selected.name, handle: null, locale });
    clearHistory();
    useTransportStore.getState().setPlaying(false);
    useTransportStore.getState().setTime(0);
    setStatus(messages.applied);
  };

  return <div className="flex flex-col gap-2">
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(refresh)}>{messages.refresh}</Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
        const result = await window.allay.templates.importComposition();
        if ('canceled' in result) return;
        if (!result.ok) throw new Error(result.error);
        await refresh();
        await open(result.entry.id);
      })}>{messages.import}</Button>
    </div>
    {entries?.length === 0 && <p className="text-xs text-muted-foreground">{messages.none}</p>}
    <ul className="flex max-h-44 flex-col gap-1 overflow-auto">
      {entries?.map((entry) => <li key={entry.id}><Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => open(entry.id))}>{entry.name} · {messages.open}</Button></li>)}
    </ul>
    {selected && <>
      <h3 className="text-sm font-semibold">{selected.name}</h3>
      <details className="text-xs"><summary>{messages.included}</summary>
        <ul>{selected.dependencies.map((dep) => <li key={`${dep.id}@${dep.version}`}><code>{dep.id}@{dep.version}</code></li>)}</ul>
      </details>
      {selected.exposed.length > 0 && <fieldset className="flex flex-col gap-1" disabled={busy}>
        <legend className="text-xs">{messages.overrides}</legend>
        {selected.exposed.map((entry, index) => <label key={index} className="flex flex-col gap-1 text-xs">{entry.clipId} · {localize(entry.definition.label, locale)}
          <input className="rounded-md border bg-background p-2 font-mono" value={values[index] ?? ''} placeholder={JSON.stringify(entry.definition.default)} onChange={(event) => {
            const value = event.currentTarget.value;
            setValues((previous) => previous.map((item, pos) => pos === index ? value : item));
          }} />
        </label>)}
      </fieldset>}
      {(selected.externalImages.length > 0 || selected.externalSkins.length > 0 || profileRefs.length > 0) && <p className="text-xs text-muted-foreground">{messages.reconnectHelp}</p>}
      {selected.externalImages.map((ref) => <div key={ref} className="flex flex-wrap items-center gap-2">
        <code className="break-all text-xs">{ref}</code><Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
          const picked = await window.allay.files.pickImage();
          if (picked) setAssets((current) => ({ ...current, [ref]: `file:${picked.ref}` }));
        })}>{assets[ref] ? messages.linked : messages.reconnect}</Button>
      </div>)}
      {selected.externalSkins.map((ref) => <div key={ref} className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex flex-col gap-1"><code>{ref}</code>
          <select className="rounded-md border bg-background p-1" aria-label={messages.chooseSkin} disabled={busy} value={assets[ref] ?? ''} onChange={(event) => {
            const value = event.currentTarget.value;
            setAssets((current) => ({ ...current, [ref]: value }));
          }}><option value="">{messages.chooseSkin}</option>{skins.map((skin) => <option key={skin.ref} value={skin.ref}>{skin.name}</option>)}</select>
        </label>
        {window.allay.skins && <>
          <select className="rounded-md border bg-background p-1" aria-label={messages.importSkin} disabled={busy} value={skinModel} onChange={(event) => setSkinModel(event.currentTarget.value === 'slim' ? 'slim' : 'classic')}>
            <option value="classic">{messages.classic}</option><option value="slim">{messages.slim}</option>
          </select>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
            const result = await window.allay.skins?.importPng(skinModel);
            if (result?.status === 'error') throw new Error(result.code);
            if (result?.status === 'added') {
              setSkins(await window.allay.skins?.list() ?? []);
              setAssets((current) => ({ ...current, [ref]: result.entry.ref }));
            }
          })}>{messages.importSkin}</Button>
        </>}
      </div>)}
      {profileRefs.map((ref) => <label key={ref} className="flex flex-col gap-1 text-xs"><code className="break-all">{ref}</code>
        <select className="rounded-md border bg-background p-1" aria-label={messages.chooseProfile} disabled={busy} value={Object.hasOwn(profiles, ref) ? profiles[ref] : ref} onChange={(event) => {
          const value = event.currentTarget.value;
          setProfiles((current) => ({ ...current, [ref]: value }));
        }}>
          <option value="">{messages.chooseProfile}</option>
          {localProfiles?.filter((profile) => !profile.missing).map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.versionId}</option>)}
        </select>
      </label>)}
      <Button size="sm" className="self-start" disabled={busy || !!missingAssets || missingProfiles} onClick={() => void run(instantiate)}>{messages.instantiate}</Button>
    </>}
    {status && <p role="status" className="break-words text-sm">{status}</p>}
  </div>;
}
