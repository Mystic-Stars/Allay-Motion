import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@allay/ui/components/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@allay/ui/components/tabs';
import { localize, type TemplateDiagnostic } from '@allay/template-sdk';
import type { SourceReadResult } from '@allay/host-api';
import { saveCurrentSource } from '../../app/editorHost';
import { sameRef, useDevStore } from '../../stores/devStore';
import { clearHistory, useProjectStore } from '../../stores/projectStore';
import { useTemplateStore } from '../../stores/templateStore';
import { useTransportStore } from '../../stores/transportStore';
import { readTemplate } from '../../templates/catalog';
import { previewEngine } from '../preview/previewEngine';
import { askConfirm } from '../project/confirm';
import { CompositionEditor, CompositionLibraryPanel } from './CompositionEditor';
import { authoringMessages, type AuthoringMessages } from './messages';
import { codeFieldClass, confirmReplace } from './controls';

function Diagnostics({ diagnostics }: { diagnostics: readonly TemplateDiagnostic[] }) {
  if (!diagnostics.length) return null;
  return <ul role="alert" className="max-h-32 overflow-auto break-words text-xs text-destructive">
    {diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`}>
      {diagnostic.code === 'manifest-invalid' ? 'manifest.json' : 'template.js'}
      {diagnostic.line ? `:${diagnostic.line}:${diagnostic.column ?? 1}` : ''} — {diagnostic.message}
    </li>)}
  </ul>;
}

function SourceEditor({ messages, locale }: { messages: AuthoringMessages; locale: string }) {
  const template = useProjectStore((state) => state.template);
  const composition = useProjectStore((state) => state.composition);
  const entry = useTemplateStore((state) => state.entries.find((item) => sameRef(item, template?.ref)));
  const externalDiagnostics = useDevStore((state) => sameRef(state.watching, template?.ref) ? state.diagnostics : undefined);
  const [base, setBase] = useState<Extract<SourceReadResult, { ok: true }> | null>(null);
  const [source, setSource] = useState('');
  const [manifest, setManifest] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [external, setExternal] = useState(false);
  const [diagnostics, setDiagnostics] = useState<TemplateDiagnostic[]>([]);
  const fieldId = useId();
  const ref = template?.ref;
  const id = ref?.id;
  const version = ref?.version;
  const dirty = base !== null && (base.source !== source || base.manifest !== manifest);
  const editable = !!ref && !composition && entry?.source !== 'builtin' && entry?.kind !== 'derived';

  useEffect(() => {
    if (!id || !version) return;
    return window.allay.templates.onChanged((change) => {
      if (sameRef(change, { id, version })) setExternal(true);
    });
  }, [id, version]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setStatus('');
    setDiagnostics([]);
    try { await action(); }
    catch (error) { setStatus(`${messages.failed}: ${String(error)}`); }
    finally { setBusy(false); }
  };

  const load = async () => {
    if (!ref || (dirty && !await askConfirm({ title: messages.studio, body: messages.discard, confirm: messages.openSource }))) return;
    const result = await window.allay.templates.readSource(ref);
    if (!result.ok) { setStatus(messages.io); return; }
    setBase(result);
    setSource(result.source);
    setManifest(result.manifest);
    setExternal(false);
  };

  const save = async () => {
    if (!ref || !base) return;
    const result = await saveCurrentSource(ref, { source, manifest }, base.version);
    if (result.ok) {
      setBase({ ok: true, version: result.version, source, manifest });
      setExternal(false);
      setStatus(messages.saved);
      await useTemplateStore.getState().refresh();
    } else if (result.error === 'invalid') setDiagnostics(result.diagnostics);
    else setStatus(result.error === 'conflict' ? messages.conflict : messages.io);
  };

  const createBlank = async () => {
    const before = useProjectStore.getState();
    if (!await confirmReplace(messages, dirty)) return;
    const made = await window.allay.templates.createBlank(messages.blankName);
    if (!made) return;
    const next = await readTemplate(made.id, made.version);
    if (!next || useProjectStore.getState().revision !== before.revision) return;
    useProjectStore.getState().reset({ template: next, name: null, handle: null, output: before.output, locale });
    clearHistory();
    useTransportStore.getState().setPlaying(false);
    useTransportStore.getState().setTime(0);
    previewEngine.retry();
    await useTemplateStore.getState().refresh();
  };

  const copy = async () => {
    if (!ref || !template) return;
    const before = useProjectStore.getState();
    const result = await window.allay.templates.copyBuiltin({ ...ref });
    if (!result.ok) { setStatus(messages.io); return; }
    const next = await readTemplate(result.entry.id, result.entry.version);
    if (!next || useProjectStore.getState().revision !== before.revision) return;
    const trial = await previewEngine.trySwap(next, before.params);
    if (!trial.ok) { setStatus(messages.failed); return; }
    if (useProjectStore.getState().revision !== before.revision) { trial.discard(); return; }
    trial.commit(() => useProjectStore.getState().setTemplate(next, before.params, locale));
    await useTemplateStore.getState().refresh();
  };

  return <div className="flex flex-col gap-2">
    {template && !composition && <p className="text-sm">{localize(template.manifest.name, locale)} · <code>{template.ref.version}</code></p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(createBlank)}>{messages.blank}</Button>
      {!composition && entry?.source === 'builtin' && <Button size="sm" disabled={busy} onClick={() => void run(copy)}>{messages.copy}</Button>}
      {editable && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(load)}>{messages.openSource}</Button>}
      {editable && ref && <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
        const result = await window.allay.templates.openFolder(ref.id, ref.version);
        if (!result.ok) setStatus(messages.io);
      })}>{messages.folder}</Button>}
    </div>
    <p className="text-xs text-muted-foreground">{editable ? messages.sourceHelp : entry?.source === 'builtin' && !composition ? messages.copyRequired : messages.scriptRequired}</p>
    {external && <p role="status" className="text-sm">{messages.externalChange}</p>}
    {base && editable && <>
      <label htmlFor={`${fieldId}-js`} className="font-mono text-xs">template.js</label>
      <textarea id={`${fieldId}-js`} className={codeFieldClass} spellCheck={false} wrap="off" disabled={busy} value={source} onChange={(event) => setSource(event.currentTarget.value)} />
      <label htmlFor={`${fieldId}-manifest`} className="font-mono text-xs">manifest.json</label>
      <textarea id={`${fieldId}-manifest`} className={codeFieldClass} spellCheck={false} wrap="off" disabled={busy} value={manifest} onChange={(event) => setManifest(event.currentTarget.value)} />
      <Button size="sm" className="self-start" disabled={busy || !dirty} onClick={() => void run(save)}>{messages.save}</Button>
    </>}
    <Diagnostics diagnostics={diagnostics.length ? diagnostics : externalDiagnostics ?? []} />
    {status && <p role="status" className="break-words text-sm">{status}</p>}
  </div>;
}

export function CodeStudio() {
  const { i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? 'en';
  const messages = authoringMessages(locale);
  const identity = useProjectStore((state) => state.composition ? 'composition' : `${state.template?.ref.id ?? ''}@${state.template?.ref.version ?? ''}:${state.handle ?? ''}`);
  return <section aria-label={messages.studio} className="flex h-full min-h-0 flex-col gap-2 overflow-auto p-3">
    <Tabs defaultValue={identity === 'composition' ? 'composition' : 'source'}>
      <TabsList className="max-w-full flex-wrap">
        <TabsTrigger value="source">{messages.source}</TabsTrigger>
        <TabsTrigger value="composition">{messages.composition}</TabsTrigger>
        <TabsTrigger value="library">{messages.library}</TabsTrigger>
      </TabsList>
      <TabsContent value="source" keepMounted><SourceEditor key={identity} messages={messages} locale={locale} /></TabsContent>
      <TabsContent value="composition" keepMounted><CompositionEditor messages={messages} locale={locale} /></TabsContent>
      <TabsContent value="library" keepMounted><CompositionLibraryPanel messages={messages} locale={locale} /></TabsContent>
    </Tabs>
  </section>;
}
