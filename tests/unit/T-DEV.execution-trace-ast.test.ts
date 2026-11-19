import { expect, it } from 'vitest';
import { planExecutionTrace } from '../../apps/desktop/src/shared/execution-trace';
import { analyzeTemplateCode } from '../../apps/desktop/src/shared/template-code';
import { ExecutionTraceRecorder } from '../../packages/engine/src/execution-trace';
import { applyExecutionTracePlan, MAX_EXECUTION_TRACE_LINES, originalTraceLocation } from '../../packages/template-sdk/src/protocol';

it('T-DEV-TRACE 保留 directive、ASI、标签和匿名函数名称推断，只插入原始行的探针', () => {
  const source = [
    '#!/usr/bin/env node',
    '"use strict"',
    'const __allayTrac\\u00650 = 1;',
    'export default { setup() {',
    '  const factory = (helper = () => 0) => helper.name;',
    '  return { duration: 1, update(t) {',
    '    "trace directive"',
    '    outer: for (let index = 0; index < 3; index++)',
    '      if (index === t) continue outer',
    '      else if (factory()) break outer',
    '    return',
    '    (t < 1 ? 1 : 2)',
    '  } };',
    '} }; // 文件末尾没有换行',
  ].join('\r\n');
  const plan = planExecutionTrace(source)!;
  expect(plan.stem).toBe('__allayTrace1');
  const rewritten = applyExecutionTracePlan(source, plan);
  expect(rewritten).toContain('"trace directive";__allayTrace1(6,true);');
  expect(rewritten).toContain('outer: for');
  expect(rewritten).toContain('continue outer;}');
  expect(rewritten).toContain('helper = () => (__allayTrace1(5),(0))');
  expect(rewritten).toContain('return\r\n');
  const column = rewritten.split('\r\n')[8]!.indexOf('continue') + 1;
  expect(originalTraceLocation(source, plan, { line: 9, column })).toEqual({ line: 9, column: source.split('\r\n')[8]!.indexOf('continue') + 1 });
});

it('T-DEV-TRACE 无法安全改写时不提供追踪；原始导入预检仍禁止动态导入', async () => {
  expect(planExecutionTrace('export default { setup() { return import.meta.url; } }')).toBeNull();
  expect(planExecutionTrace('export default { setup() { let next; next ||= () => 1; } }')).toBeNull();
  expect(planExecutionTrace('export default { setup() {')).toBeNull();
  await expect(analyzeTemplateCode('export default { setup() { return import("./extra.js"); } }')).rejects.toMatchObject({ problem: 'has-import' });
});

it('T-DEV-TRACE 记录器逐帧重置、合并实际命中，超过上限不返回不完整的行号', () => {
  let hit: ((line: number) => void) | undefined;
  const recorder = new ExecutionTraceRecorder((record) => { hit = record; });
  recorder.begin();
  recorder.run(() => { hit?.(3); hit?.(7); });
  recorder.run(() => { hit?.(4); hit?.(7); });
  expect(hit).toBeUndefined();
  expect(recorder.finish()).toEqual([3, 4, 7]);
  recorder.begin();
  expect(() => recorder.run(() => {
    for (let line = 1; line <= MAX_EXECUTION_TRACE_LINES + 1; line++) hit?.(line);
    throw new Error('update fixture');
  })).toThrow('update fixture');
  expect(hit).toBeUndefined();
  expect(recorder.finish()).toBeUndefined();
  recorder.begin();
  recorder.run(() => hit?.(2));
  expect(recorder.finish()).toEqual([2]);
});
