import { describe, expect, it } from 'vitest';
import type { CodeInspectorPacket } from '../../../../shared/code-inspector';
import { applyTextareaEdit, documentKey, hasConflict, initialState, reduceInspector, saveAction, type InspectorState } from './model';

const first = {
  type: 'document', token: 1, id: 'test.template', version: '1.0.0', clipId: 'first', title: 'Template',
  source: 'const text = "原样";\r\n\treturn text;\r\n', manifest: '{\r\n  "name": "Test"\r\n}\r\n',
  editable: true, language: 'en', theme: 'dark', baseVersion: 'revision-1',
} satisfies CodeInspectorPacket;
const second = { ...first, token: 2, clipId: 'second' };
const key = documentKey(first);

function receive(state: InspectorState, packet: CodeInspectorPacket) {
  return reduceInspector(state, { type: 'packet', packet });
}

function edit(state: InspectorState, value: string, file: 'source' | 'manifest' = 'source') {
  const document = state.document!;
  return reduceInspector(state, { type: 'edit', token: document.token, key: documentKey(document), file, value });
}

describe('T-STUDIO 独立代码窗口', () => {
  it('初始化追踪与帧分开，只接受当前文档，设置变化保留记录', () => {
    const setup = { type: 'setup', token: 1, lines: [1] } as const;
    const packet = { ...setup, lines: [...setup.lines] };
    let state = receive(initialState, first);
    state = reduceInspector(state, { type: 'packet', packet });
    state = receive(state, { type: 'frame', token: 1, time: 0, frame: 0, playing: false, lines: [2] });
    expect(state.setup?.lines).toEqual([1]);
    expect(state.frame?.lines).toEqual([2]);
    state = receive(state, { ...first, theme: 'light' });
    expect(state.setup).toBe(packet);
    state = receive(state, second);
    expect(state.setup).toBeUndefined();
    expect(reduceInspector(state, { type: 'packet', packet })).toBe(state);
  });

  it('只接收匹配文档的帧和参数；设置更新不清空当前帧', () => {
    const frame = { type: 'frame', token: 1, time: 0.25, frame: 15, playing: false, lines: [2] } as const;
    const framePacket = { ...frame, lines: [...frame.lines] };
    const params = { type: 'params', token: 1, params: { text: '当前值' }, fps: 60 } as const;
    let state = receive(receive(receive(initialState, first), framePacket), params);
    state = receive(state, { ...first, language: 'zh-CN', theme: 'light' });
    expect(state.frame).toBe(framePacket);
    expect(state.params).toBe(params);
    state = receive(state, second);
    expect(receive(receive(state, framePacket), params)).toBe(state);
    expect(state.frame).toBeUndefined();
    expect(state.params).toBeUndefined();
  });

  it('切换对象或收到空文档时保留独立草稿，切回后用新 token 保存', () => {
    let state = edit(receive(initialState, first), '// 中文\n');
    state = edit(receive(state, second), '{"name":"第二个"}\n', 'manifest');
    state = receive(state, { type: 'empty', language: 'en', theme: 'dark', message: '' });
    const returned = { ...first, token: 3 };
    state = receive(state, returned);
    expect(state.drafts.size).toBe(2);
    expect(saveAction(returned, state.drafts.get(key))).toEqual({
      type: 'save', token: 3, source: '// 中文\r\n', manifest: first.manifest, baseVersion: first.baseVersion,
    });
    expect(state.drafts.get(documentKey(second))?.manifest).toBe('{"name":"第二个"}\r\n');
  });

  it('外部更新保留草稿，不允许提交过时版本或编辑锁定文档', () => {
    let state = edit(receive(initialState, first), 'draft');
    const external = { ...first, token: 3, source: 'external', baseVersion: 'revision-2' };
    state = receive(state, external);
    const draft = state.drafts.get(key)!;
    expect(draft.source).toBe('draft');
    expect(hasConflict(external, draft)).toBe(true);
    expect(saveAction(external, draft)).toBeUndefined();
    state = receive(state, { ...external, editable: false });
    expect(edit(state, 'overwrite')).toBe(state);
  });

  it('试渲失败保留草稿；保存结果先到不清草稿，新版本到后保留后续输入', () => {
    let state = edit(receive(initialState, first), 'saved');
    const action = saveAction(first, state.drafts.get(key))!;
    state = reduceInspector(state, { type: 'action', action });
    const failed = { type: 'result', token: 1, ok: false, message: '试渲失败' } as const;
    state = receive(state, failed);
    expect(state.results.get(key)).toBe(failed);
    expect(state.pending).toBeUndefined();
    expect(state.drafts.get(key)?.source).toBe('saved');
    state = reduceInspector(state, { type: 'action', action });
    state = receive(state, { type: 'result', token: 1, ok: true, message: '保存成功' });
    expect(state.drafts.get(key)?.source).toBe('saved');
    state = edit(state, 'continued');
    const applied = { ...first, token: 3, source: 'saved', baseVersion: 'revision-2' };
    state = receive(state, applied);
    expect(state.pending).toBeUndefined();
    expect(saveAction(applied, state.drafts.get(key))).toMatchObject({ source: 'continued', baseVersion: 'revision-2' });
  });

  it('切换对象不会被旧保存请求卡住；返回时确认已应用的源码', () => {
    let state = edit(receive(initialState, first), 'updated');
    const action = saveAction(first, state.drafts.get(key))!;
    state = reduceInspector(state, { type: 'action', action });
    state = edit(receive(state, second), 'other');
    expect(state.pending).toBeUndefined();
    const original = state;
    state = receive(state, { type: 'result', token: 1, ok: true, message: 'OK' });
    expect(state).toBe(original);
    state = receive(state, { ...first, token: 4, source: 'updated', baseVersion: 'revision-2' });
    expect(state.drafts.has(key)).toBe(false);
    expect(state.drafts.get(documentKey(second))?.source).toBe('other');
  });

  it('保存试渲期间撤销文本，随后收到新运行版本时仍保留撤销后的内容', () => {
    let state = edit(receive(initialState, first), 'updated');
    const action = saveAction(first, state.drafts.get(key))!;
    state = reduceInspector(state, { type: 'action', action });
    state = edit(state, first.source.replaceAll('\r\n', '\n'));
    state = receive(state, { ...first, theme: 'light' });
    expect(state.drafts.get(key)?.source).toBe(first.source);
    const applied = { ...first, token: 3, source: 'updated', baseVersion: 'revision-2' };
    state = receive(state, applied);
    expect(saveAction(applied, state.drafts.get(key))).toMatchObject({ source: first.source, baseVersion: 'revision-2' });
  });

  it('不改写 BOM、未编辑的换行、缩进与结尾空白', () => {
    const raw = '\uFEFF首行\r\n\t第二行\n第三行  \r';
    expect(applyTextareaEdit(raw, '\uFEFF首行\n\t第二行\n第三行  \n')).toBe(raw);
    expect(applyTextareaEdit(raw, '\uFEFF首行\n\t编辑\n第三行  \n')).toBe('\uFEFF首行\r\n\t编辑\n第三行  \r');
  });
});
