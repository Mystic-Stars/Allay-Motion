import type { CodeInspectorAction, CodeInspectorPacket } from '../../../../shared/code-inspector';

type PacketOf<Type extends CodeInspectorPacket['type']> = Extract<CodeInspectorPacket, { type: Type }>;
type DocumentPacket = PacketOf<'document'>;
type Files = Pick<DocumentPacket, 'source' | 'manifest'>;
export type File = keyof Files;
type Draft = Files & { base: Files & Pick<DocumentPacket, 'baseVersion'> };
type DocumentAction = Extract<CodeInspectorAction, { token: number }>;
type Pending = { key: string; action: DocumentAction };

export interface InspectorState {
  document?: DocumentPacket;
  empty?: PacketOf<'empty'>;
  params?: PacketOf<'params'>;
  frame?: PacketOf<'frame'>;
  setup?: PacketOf<'setup'>;
  drafts: ReadonlyMap<string, Draft>;
  results: ReadonlyMap<string, PacketOf<'result'>>;
  submitted: ReadonlyMap<string, Extract<CodeInspectorAction, { type: 'save' }>>;
  pending?: Pending;
}

type Event =
  | { type: 'packet'; packet: CodeInspectorPacket }
  | { type: 'edit'; token: number; key: string; file: File; value: string }
  | { type: 'discard'; key: string }
  | { type: 'action'; action: DocumentAction };

export const initialState: InspectorState = { drafts: new Map(), results: new Map(), submitted: new Map() };

export function documentKey({ id, version, clipId }: DocumentPacket): string {
  return JSON.stringify([id, version, clipId]);
}

function sameFiles(left: Files, right: Files): boolean {
  return left.source === right.source && left.manifest === right.manifest;
}

export function hasConflict(document: DocumentPacket, draft: Draft): boolean {
  return draft.base.baseVersion !== document.baseVersion || !sameFiles(draft.base, document);
}

export function saveAction(document: DocumentPacket, draft: Draft | undefined): DocumentAction | undefined {
  if (!document.editable || !draft || !draft.base.baseVersion || hasConflict(document, draft)) return;
  return { type: 'save', token: document.token, source: draft.source, manifest: draft.manifest, baseVersion: draft.base.baseVersion };
}

function mergeDocument(state: InspectorState, document: DocumentPacket): InspectorState {
  const key = documentKey(document);
  const drafts = new Map(state.drafts);
  const draft = drafts.get(key);
  const sent = state.submitted.get(key);
  const applied = !!sent && sameFiles(sent, document);
  const submitted = new Map(state.submitted);
  if (applied) submitted.delete(key);
  if (draft) {
    if (sameFiles(draft, document) && (!sent || applied)) drafts.delete(key);
    else if (applied) drafts.set(key, { ...draft, base: document });
  }
  const previous = state.document;
  const sameRuntime = previous?.token === document.token && documentKey(previous) === key &&
    previous.baseVersion === document.baseVersion && sameFiles(previous, document);
  const pending = state.pending?.key === key && state.pending.action.token === document.token && !applied && sameRuntime ? state.pending : undefined;
  return { ...state, document, empty: undefined, drafts, pending, submitted,
    frame: sameRuntime ? state.frame : undefined, setup: sameRuntime ? state.setup : undefined, params: sameRuntime ? state.params : undefined };
}

function receiveResult(state: InspectorState, packet: PacketOf<'result'>): InspectorState {
  if (state.document?.token !== packet.token) return state;
  const key = documentKey(state.document);
  const pending = state.pending;
  const submitted = new Map(state.submitted);
  const drafts = new Map(state.drafts);
  if (!packet.ok && submitted.get(key)?.token === packet.token) submitted.delete(key);
  const draft = drafts.get(key);
  if (!packet.ok && draft && sameFiles(draft, state.document)) drafts.delete(key);
  return { ...state, pending: packet.ok && pending?.action.type === 'save' ? pending : undefined,
    submitted, drafts, results: new Map(state.results).set(key, packet) };
}

export function reduceInspector(state: InspectorState, event: Event): InspectorState {
  switch (event.type) {
    case 'packet': {
      const { packet } = event;
      switch (packet.type) {
        case 'document': return mergeDocument(state, packet);
        case 'empty': return { ...state, document: undefined, frame: undefined, setup: undefined, params: undefined, pending: undefined, empty: packet };
        case 'frame': return state.document?.token === packet.token ? { ...state, frame: packet } : state;
        case 'setup': return state.document?.token === packet.token ? { ...state, setup: packet } : state;
        case 'params': return state.document?.token === packet.token ? { ...state, params: packet } : state;
        case 'result': return receiveResult(state, packet);
      }
      break;
    }
    case 'edit': {
      const { document } = state;
      if (!document?.editable || document.token !== event.token || documentKey(document) !== event.key) return state;
      const drafts = new Map(state.drafts);
      const draft = drafts.get(event.key) ?? { source: document.source, manifest: document.manifest, base: document };
      const baseText = draft.base[event.file];
      const text = normalizeNewlines(baseText) === event.value ? baseText : applyTextareaEdit(draft[event.file], event.value);
      const next = { ...draft, [event.file]: text };
      const saveInProgress = state.pending?.key === event.key && state.pending.action.type === 'save';
      if (!saveInProgress && sameFiles(next, document)) drafts.delete(event.key);
      else drafts.set(event.key, next);
      return { ...state, drafts };
    }
    case 'discard': {
      const drafts = new Map(state.drafts);
      const results = new Map(state.results);
      const submitted = new Map(state.submitted);
      drafts.delete(event.key);
      results.delete(event.key);
      submitted.delete(event.key);
      return { ...state, drafts, results, submitted };
    }
    case 'action': {
      const { document } = state;
      if (state.pending || !document || document.token !== event.action.token) return state;
      const key = documentKey(document);
      const results = new Map(state.results);
      results.delete(key);
      const submitted = new Map(state.submitted);
      if (event.action.type === 'save') submitted.set(key, event.action);
      return { ...state, pending: { key, action: event.action }, results, submitted };
    }
  }
  return state;
}

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function rawOffset(raw: string, normalizedOffset: number): number {
  let offset = 0;
  for (let index = 0; index < normalizedOffset; index++) {
    if (raw[offset] === '\r' && raw[offset + 1] === '\n') offset++;
    offset++;
  }
  return offset;
}

export function applyTextareaEdit(raw: string, value: string): string {
  const before = normalizeNewlines(raw);
  if (before === value) return raw;
  if (!raw.includes('\r')) return value;
  let start = 0;
  let oldEnd = before.length;
  let newEnd = value.length;
  while (start < oldEnd && start < newEnd && before[start] === value[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === value[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const newline = /\r\n|\r|\n/.exec(raw)?.[0] ?? '\n';
  return raw.slice(0, rawOffset(raw, start)) + value.slice(start, newEnd).replaceAll('\n', newline) + raw.slice(rawOffset(raw, oldEnd));
}
