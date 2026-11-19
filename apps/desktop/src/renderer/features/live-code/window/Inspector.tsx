import { memo, useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useReducer, useRef, useState, type Dispatch } from 'react';
import { isReservedId, MAX_TEMPLATE_CODE_BYTES } from '@allay/template-sdk';
import type { CodeInspectorAction, CodeInspectorPacket } from '../../../../shared/code-inspector';
import { MAX_SOURCE_MANIFEST_BYTES } from '../../../../shared/template-authoring';
import { documentKey, hasConflict, initialState, normalizeNewlines, reduceInspector, saveAction, type File, type InspectorState } from './model';
import { messagesFor, type Messages } from './messages';
import { SourceEditor, type TraceEditor } from './SourceEditor';
import { activeMatch, findMatches, lineStarts, parseLine } from './text-navigation';

type TraceMode = 'frame' | 'setup';
type NavigationMode = 'find' | 'line';

type Bridge = Window['allayCodeInspector'];
type HandleAction = (action: CodeInspectorAction) => void;
const utf8 = new TextEncoder();
type InspectorDocument = Extract<CodeInspectorPacket, { type: 'document' }> & { copyable?: boolean };

const ParamsPanel = memo(function ParamsPanel({ params, messages }: { params: InspectorState['params']; messages: Messages }) {
  const values = params && Object.entries(params.params);
  return <details className="inspector-params" data-testid="code-inspector-params" open>
    <summary>
      <span>{messages.params} <code>ctx.params</code></span>
      <span className="inspector-param-count">{values?.length ?? '—'}</span>
    </summary>
    {values?.length ? <dl className="inspector-param-list">
      {values.map(([name, value]) => <div key={name} className="inspector-param" data-param={name}>
        <dt>{name}</dt><dd><code>{JSON.stringify(value, null, 2)}</code></dd>
      </div>)}
    </dl> : <p className="inspector-param-empty">{params ? messages.noParams : messages.waitingParams}</p>}
  </details>;
});

function FrameStatus({ frame, params, trace, messages }: {
  frame: InspectorState['frame']; params: InspectorState['params']; trace: string; messages: Messages;
}) {
  return <footer className="inspector-footer" data-testid="code-inspector-frame">
    <span>{frame ? frame.playing ? messages.playing : messages.paused : messages.waitingFrame}</span>
    <span className="inspector-numeric" data-testid="code-inspector-frame-number">{messages.frame} {frame?.frame ?? '—'}</span>
    <span className="inspector-numeric" data-testid="code-inspector-time">{messages.time} {frame ? `${frame.time.toFixed(3)} s` : '—'}</span>
    {params && <span className="inspector-numeric">{params.fps} fps</span>}
    {trace && <span className="inspector-trace-status" data-testid="code-inspector-trace-status">{trace}</span>}
  </footer>;
}

function DocumentWorkspace({ document, state, messages, onAction, dispatch }: {
  document: InspectorDocument;
  state: InspectorState;
  messages: Messages;
  onAction: HandleAction;
  dispatch: Dispatch<Parameters<typeof reduceInspector>[1]>;
}) {
  const [file, setFile] = useState<File>('source');
  const [viewRuntime, setViewRuntime] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [follow, setFollow] = useState(false);
  const [traceMode, setTraceMode] = useState<TraceMode>('frame');
  const [location, setLocation] = useState<{ token: number; mode: TraceMode; line: number }>();
  const [navigation, setNavigation] = useState<NavigationMode>();
  const [query, setQuery] = useState('');
  const [anchor, setAnchor] = useState(0);
  const [step, setStep] = useState(0);
  const [lineInput, setLineInput] = useState('');
  const [invalidLine, setInvalidLine] = useState(false);
  const sourceEditor = useRef<TraceEditor>(null);
  const manifestEditor = useRef<TraceEditor>(null);
  const navigationInput = useRef<HTMLInputElement>(null);
  const navigationLeft = useRef(0);
  const editor = file === 'source' ? sourceEditor : manifestEditor;
  const key = documentKey(document);
  const { token } = document;
  const draft = state.drafts.get(key);
  const pending = state.pending?.key === key ? state.pending.action : undefined;
  const result = state.results.get(key);
  const conflict = !!draft && hasConflict(document, draft);
  const showingRuntime = !!draft && viewRuntime;
  const readOnly = !document.editable || showingRuntime;
  const files = showingRuntime ? document : draft ?? document;
  const allowTrace = !draft || showingRuntime;
  const canNavigate = file === 'source' && allowTrace;
  const canCopy = !document.editable && (document.copyable ?? isReservedId(document.id));
  const record = traceMode === 'frame' ? state.frame : state.setup;
  const lines = allowTrace ? record?.lines : undefined;
  const sourceText = useMemo(() => normalizeNewlines(files.source), [files.source]);
  const sourceTotal = useMemo(() => lineStarts(sourceText).length, [sourceText]);
  const hits = useMemo(() => lines && new Set(lines.filter((line) => Number.isInteger(line) && line > 0 && line <= sourceTotal)), [lines, sourceTotal]);
  const located = canNavigate && location?.token === token && location.mode === traceMode && hits?.has(location.line) ? location.line : undefined;
  const editorText = file === 'source' ? sourceText : normalizeNewlines(files.manifest);
  const starts = useMemo(() => lineStarts(editorText), [editorText]);
  const matches = useMemo(() => navigation === 'find' ? findMatches(editorText, query) : [], [editorText, navigation, query]);
  const matchIndex = matches.length ? ((activeMatch(matches, anchor) + step) % matches.length + matches.length) % matches.length : -1;
  const match = matches[matchIndex];
  const tooLarge = useMemo(() => draft && (
    utf8.encode(draft.source).byteLength > MAX_TEMPLATE_CODE_BYTES || utf8.encode(draft.manifest).byteLength > MAX_SOURCE_MANIFEST_BYTES
  ), [draft]);
  const save = !state.pending && !showingRuntime && !tooLarge ? saveAction(document, draft) : undefined;
  const trace = !allowTrace ? messages.draftNoTrace : file === 'manifest' ? messages.manifestNoTrace : traceMode === 'setup'
    ? !record ? messages.noSetupRecord : hits?.size ? `${messages.setupHits}: ${hits.size}` : messages.noSetupHits
    : !record ? messages.noFrameRecord : hits?.size ? `${messages.hits}: ${hits.size}` : messages.noHits;

  const stopFollow = useCallback(() => setFollow(false), []);
  useLayoutEffect(() => {
    if (!navigation) return;
    navigationInput.current?.focus();
    navigationInput.current?.select();
  }, [navigation]);
  const openNavigation = (mode: NavigationMode) => {
    stopFollow();
    if (navigation === mode) {
      navigationInput.current?.focus();
      navigationInput.current?.select();
      return;
    }
    const caret = editor.current?.caret();
    setAnchor(caret?.offset ?? 0);
    if (!navigation) navigationLeft.current = caret?.scrollLeft ?? 0;
    setStep(0);
    setLineInput('');
    setInvalidLine(false);
    setNavigation(mode);
  };
  const closeNavigation = () => {
    setNavigation(undefined);
    editor.current?.focus(undefined, navigationLeft.current);
  };
  const setActiveFile = (next: File) => {
    if (next === file) return;
    stopFollow();
    setNavigation(undefined);
    setFile(next);
  };
  const editSource = useCallback((value: string) => {
    stopFollow();
    setViewRuntime(false);
    dispatch({ type: 'edit', token, key, file: 'source', value });
  }, [dispatch, token, key, stopFollow]);
  const editManifest = useCallback((value: string) => {
    stopFollow();
    setViewRuntime(false);
    dispatch({ type: 'edit', token, key, file: 'manifest', value });
  }, [dispatch, token, key, stopFollow]);
  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape' && navigation) {
      event.preventDefault();
      closeNavigation();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
    const shortcut = event.key.toLowerCase();
    if (shortcut === 'f' || shortcut === 'g') {
      event.preventDefault();
      if (!event.repeat) openNavigation(shortcut === 'f' ? 'find' : 'line');
    } else if (shortcut === 's') {
      event.preventDefault();
      if (save && !event.repeat) onAction(save);
    }
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => onKeyDown(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  return <main className="inspector" data-testid="code-inspector">
    <header className="inspector-toolbar">
      <div className="inspector-identity">
        <h1 title={document.title}>{document.title}</h1>
        <span className="inspector-version">{document.version}</span>
        <span className="inspector-mode" data-testid="code-inspector-mode">
          {showingRuntime ? messages.runtime : !document.editable ? messages.readonly : draft ? messages.unsaved : messages.editable}
        </span>
      </div>
      <div className="inspector-actions">
        {document.editable ? <button type="button" data-testid="code-inspector-save" aria-keyshortcuts="Control+S Meta+S"
          disabled={!save} onClick={() => save && onAction(save)}>{pending?.type === 'save' && !result?.ok ? messages.saving : messages.save}</button> : canCopy &&
          <button type="button" data-testid="code-inspector-copy" disabled={!!state.pending}
            onClick={() => onAction({ type: 'copy', token })}>{pending ? messages.copying : messages.copy}</button>}
        <button type="button" data-testid="code-inspector-authoring" onClick={() => onAction({ type: 'authoring' })}>{messages.authoring}</button>
      </div>
    </header>
    <div className="inspector-deck">
      <div className="inspector-source-panel">
        <div className="inspector-files">
          <div className="inspector-file-buttons" role="group" aria-label={messages.name}>
            <button type="button" className="inspector-file" data-testid="code-inspector-source-tab" aria-pressed={file === 'source'} onClick={() => setActiveFile('source')}>template.js</button>
            <button type="button" className="inspector-file" data-testid="code-inspector-manifest-tab" aria-pressed={file === 'manifest'} onClick={() => setActiveFile('manifest')}>manifest.json</button>
          </div>
          <div className="inspector-file-buttons" role="group" aria-label={messages.navigation}>
            <button type="button" data-testid="code-inspector-find" title={`${messages.find} · Ctrl/⌘+F`} aria-keyshortcuts="Control+F Meta+F"
              aria-expanded={navigation === 'find'} onClick={() => openNavigation('find')}>{messages.find}</button>
            <button type="button" data-testid="code-inspector-go-line" title={`${messages.goLine} · Ctrl/⌘+G`} aria-keyshortcuts="Control+G Meta+G"
              aria-expanded={navigation === 'line'} onClick={() => openNavigation('line')}>{messages.goLine}</button>
          </div>
        </div>
        <div className="inspector-files">
          <div className="inspector-trace-actions" role="group" aria-label={messages.hits}>
            {(['frame', 'setup'] as const).map((mode) => <button type="button" key={mode} data-testid={`code-inspector-trace-${mode}`}
              disabled={file !== 'source'} aria-pressed={traceMode === mode} onClick={() => {
                stopFollow();
                setTraceMode(mode);
              }}>{mode === 'frame' ? messages.currentFrame : messages.setup}</button>)}
            <button type="button" data-testid="code-inspector-locate" title={messages.locateHint} disabled={!canNavigate || !hits?.size || !!navigation}
              onClick={() => {
                stopFollow();
                const line = sourceEditor.current?.locate();
                if (line !== undefined) setLocation({ token, mode: traceMode, line });
              }}>{messages.locate}</button>
            <button type="button" data-testid="code-inspector-follow" title={messages.followHint} disabled={!canNavigate || traceMode !== 'frame' || !!navigation}
              aria-pressed={follow && canNavigate} onClick={() => {
                setLocation(undefined);
                setFollow(!follow);
              }}>{messages.follow}</button>
            <span className="inspector-sr-only" role="status">{located !== undefined ? `${messages.located} ${located}` : ''}</span>
          </div>
          {draft && <div className="inspector-draft-actions">
            <button type="button" data-testid="code-inspector-runtime" onClick={() => {
              stopFollow();
              setNavigation(undefined);
              setViewRuntime(!showingRuntime);
            }}>
              {showingRuntime ? messages.showDraft : messages.showRuntime}
            </button>
            <button type="button" disabled={!!pending} onClick={() => setConfirmDiscard(true)}>{messages.discard}</button>
          </div>}
        </div>
        {navigation && <form className="inspector-navigation" aria-label={navigation === 'find' ? messages.find : messages.goLine} onSubmit={(event) => {
          event.preventDefault();
          if (navigation === 'find') { setStep((value) => value + 1); return; }
          const line = parseLine(lineInput, starts.length);
          if (line === undefined) { setInvalidLine(true); return; }
          const start = starts[line - 1]!;
          setNavigation(undefined);
          editor.current?.focus({ start, end: start });
        }}>
          {navigation === 'find' ? <>
            <input key="find" ref={navigationInput} data-testid="code-inspector-find-input" aria-label={messages.find}
              placeholder={messages.find} spellCheck={false} value={query} onChange={(event) => { setQuery(event.currentTarget.value); setStep(0); }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'Enter') {
                  event.preventDefault();
                  setStep((value) => value + (event.key === 'ArrowUp' || (event.key === 'Enter' && event.shiftKey) ? -1 : 1));
                }
              }} />
            <span className="inspector-navigation-status" data-testid="code-inspector-find-count" role="status">{matches.length ? `${matchIndex + 1} / ${matches.length}` : query ? messages.noMatches : '—'}</span>
            <button type="button" className="inspector-icon-button" aria-label={messages.previousMatch} title={messages.previousMatch} disabled={!match} onClick={() => setStep((value) => value - 1)}>↑</button>
            <button type="button" className="inspector-icon-button" aria-label={messages.nextMatch} title={messages.nextMatch} disabled={!match} onClick={() => setStep((value) => value + 1)}>↓</button>
          </> : <>
            <input key="line" ref={navigationInput} data-testid="code-inspector-line-input" aria-label={messages.lineNumber} inputMode="numeric"
              placeholder={`1–${starts.length}`} value={lineInput} aria-invalid={invalidLine} onChange={(event) => { setInvalidLine(false); setLineInput(event.currentTarget.value); }} />
            <button type="submit">{messages.goLine}</button>
            {invalidLine && <span className="inspector-navigation-status" role="status">{messages.lineRange} 1–{starts.length}</span>}
          </>}
          <button type="button" className="inspector-icon-button" aria-label={messages.closeNavigation} title={`${messages.closeNavigation} · Esc`} onClick={closeNavigation}>×</button>
        </form>}
        {draft && confirmDiscard && <div className="inspector-notice" role="group" aria-label={messages.discardPrompt}>
          <span>{messages.discardPrompt}</span>
          <button type="button" onClick={() => setConfirmDiscard(false)}>{messages.cancel}</button>
          <button type="button" onClick={() => {
            dispatch({ type: 'discard', key });
            stopFollow();
            setConfirmDiscard(false);
            setViewRuntime(false);
          }}>{messages.confirmDiscard}</button>
        </div>}
        <SourceEditor fileName="template.js" text={files.source} readOnly={readOnly} active={file === 'source'} hits={hits}
          traceToken={token} traceMode={traceMode} traceRef={sourceEditor} follow={follow && canNavigate && traceMode === 'frame'}
          located={located} searching={!!navigation} match={file === 'source' ? match : undefined} onManual={stopFollow} onChange={editSource} />
        <SourceEditor fileName="manifest.json" text={files.manifest} readOnly={readOnly} active={file === 'manifest'} traceRef={manifestEditor}
          match={file === 'manifest' ? match : undefined} onChange={editManifest} />
        {(result || conflict || tooLarge || (draft && !document.baseVersion)) && <div className="inspector-feedback" data-testid="code-inspector-result" role="status">
          {result && <p data-ok={result.ok}>{result.message}</p>}
          {conflict && <p>{messages.conflict}</p>}
          {tooLarge && <p data-ok={false}>{messages.sizeLimit}</p>}
          {draft && !document.baseVersion && <p>{messages.missingBase}</p>}
        </div>}
      </div>
      <ParamsPanel params={state.params} messages={messages} />
    </div>
    <FrameStatus frame={state.frame} params={state.params} trace={trace} messages={messages} />
  </main>;
}

export function Inspector({ bridge }: { bridge?: Bridge }) {
  const [state, dispatch] = useReducer(reduceInspector, initialState);
  const dirty = state.drafts.size > 0;
  const language = state.document?.language ?? state.empty?.language ?? 'en';
  const theme = state.document?.theme ?? state.empty?.theme ?? 'dark';
  const messages = messagesFor(language);

  useEffect(() => {
    if (!bridge) return;
    const unsubscribe = bridge.onPacket((packet) => dispatch({ type: 'packet', packet }));
    bridge.ready();
    return unsubscribe;
  }, [bridge]);

  useLayoutEffect(() => { bridge?.setDirty(dirty); }, [bridge, dirty]);
  useLayoutEffect(() => {
    window.document.documentElement.lang = language;
    window.document.documentElement.dataset.theme = theme;
    window.document.title = messages.name;
  }, [language, messages.name, theme]);

  const onAction: HandleAction = (action) => {
    if (!bridge) return;
    if (action.type !== 'authoring') dispatch({ type: 'action', action });
    bridge.action(action);
  };

  if (state.document) return <DocumentWorkspace key={documentKey(state.document)} document={state.document}
    state={state} messages={messages} onAction={onAction} dispatch={dispatch} />;
  return <main className="inspector inspector-empty" data-testid="code-inspector">
    <header className="inspector-toolbar">
      <h1>{messages.name}</h1>
      <button type="button" data-testid="code-inspector-authoring" onClick={() => onAction({ type: 'authoring' })}>{messages.authoring}</button>
    </header>
    <p role="status">{state.empty?.message || messages.waiting}</p>
  </main>;
}
