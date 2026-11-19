import { parse, type Node, type Token } from 'acorn';
import { applyExecutionTracePlan, MAX_EXECUTION_TRACE_EDITS, type ExecutionTracePlan } from '@allay/template-sdk';

type AstNode = Node & Record<string, unknown>;
type Insertion = ExecutionTracePlan['insertions'][number];

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string';
}

function children(node: AstNode): AstNode[] {
  return Object.values(node).flatMap((value: unknown) => Array.isArray(value) ? value.filter(isNode) : isNode(value) ? [value] : []);
}

function anonymousDefinition(node: AstNode): boolean {
  while (node.type === 'ParenthesizedExpression') node = node.expression as AstNode;
  return node.type === 'ArrowFunctionExpression' ||
    ((node.type === 'FunctionExpression' || node.type === 'ClassExpression') && !node.id);
}

function declarationOnly(node: AstNode): boolean {
  if (node.type === 'ClassDeclaration') return true;
  return node.type === 'VariableDeclaration' && (node.declarations as AstNode[]).every((declarator) => {
    let initializer = declarator.init;
    while (isNode(initializer) && initializer.type === 'ParenthesizedExpression') initializer = initializer.expression;
    return !isNode(initializer) || initializer.type === 'FunctionExpression' || initializer.type === 'ArrowFunctionExpression';
  });
}

/** 只插入探针，不替换源字符或换行。调用前仍须对原始模板做常规模块预检。 */
export function planExecutionTrace(source: string): ExecutionTracePlan | null {
  try {
    const tokens: Token[] = [];
    const program = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, preserveParens: true, onToken: tokens }) as unknown as AstNode;
    const identifiers = new Set<string>();
    const scan = (node: AstNode): void => {
      if (node.type === 'Identifier') identifiers.add(node.name as string);
      if (node.type === 'MetaProperty' && (node.meta as AstNode).name === 'import') throw new Error('module identity is observable');
      children(node).forEach(scan);
    };
    scan(program);
    let stem = '__allayTrace0';
    for (let index = 1; ['', 'Sink', 'Bind'].some((suffix) => identifiers.has(stem + suffix)); index++) stem = `__allayTrace${index}`;

    const insertions: Insertion[] = [];
    const insert = (...edit: Insertion) => {
      if (insertions.length >= MAX_EXECUTION_TRACE_EDITS) throw new Error('too many trace probes');
      insertions.push(edit);
    };
    const lineOf = (node: AstNode) => node.loc!.start.line;
    const mark = (offset: number, node: AstNode) => insert(offset, 'mark', lineOf(node));
    const expression = (node: AstNode) => {
      insert(node.start, 'expression', lineOf(node));
      visit(node);
      insert(node.end, 'end-expression');
    };
    const bareBody = (node: AstNode) => {
      if (node.type === 'BlockStatement') {
        list(node.body as AstNode[], { offset: node.start + 1, node });
      } else {
        insert(node.start, 'block', lineOf(node));
        visit(node);
        insert(node.end, 'end-block');
      }
    };
    const list = (nodes: AstNode[], entry?: { offset: number; node: AstNode; functionEntry?: boolean }) => {
      let index = 0;
      while (typeof nodes[index]?.directive === 'string') index++;
      if (entry) insert(index > 0 ? nodes[index - 1]!.end : entry.offset, entry.functionEntry ? 'entry' : 'mark', lineOf(entry.node));
      for (; index < nodes.length; index++) {
        const node = nodes[index]!;
        if (!['BlockStatement', 'EmptyStatement', 'FunctionDeclaration'].includes(node.type)) {
          if (declarationOnly(node)) insert(node.start, 'entry', lineOf(node));
          else mark(node.start, node);
        }
        visit(node);
      }
    };
    const colonAfter = (offset: number): number => {
      let first = 0;
      let last = tokens.length;
      while (first < last) {
        const middle = (first + last) >>> 1;
        if (tokens[middle]!.start < offset) first = middle + 1;
        else last = middle;
      }
      const colon = tokens[first];
      if (colon?.type.label !== ':') throw new Error('missing case colon');
      return colon.end;
    };

    function visit(node: AstNode): void {
      switch (node.type) {
        case 'Program':
          (node.body as AstNode[]).forEach(visit);
          return;
        case 'BlockStatement':
        case 'StaticBlock':
          list(node.body as AstNode[]);
          return;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression': {
          (node.params as AstNode[]).forEach(visit);
          const body = node.body as AstNode;
          if (body.type === 'BlockStatement') list(body.body as AstNode[], { offset: body.start + 1, node, functionEntry: true });
          else expression(body);
          return;
        }
        case 'IfStatement':
        case 'WhileStatement':
        case 'DoWhileStatement':
        case 'ForStatement':
        case 'ForOfStatement':
        case 'ForInStatement':
          for (const child of children(node)) {
            if (child === node.consequent || child === node.alternate || child === node.body) bareBody(child);
            else if (child === node.test || child === node.update || child === node.right || (child === node.init && child.type !== 'VariableDeclaration')) expression(child);
            else visit(child);
          }
          return;
        case 'SwitchCase': {
          const test = node.test as AstNode | null;
          if (test) visit(test);
          list(node.consequent as AstNode[], { offset: colonAfter(test?.end ?? node.start + 'default'.length), node });
          return;
        }
        case 'LabeledStatement': {
          const body = node.body as AstNode;
          if (['LabeledStatement', 'WhileStatement', 'DoWhileStatement', 'ForStatement', 'ForOfStatement', 'ForInStatement'].includes(body.type)) visit(body);
          else bareBody(body);
          return;
        }
        case 'CatchClause': {
          if (isNode(node.param)) visit(node.param);
          const body = node.body as AstNode;
          list(body.body as AstNode[], { offset: body.start + 1, node });
          return;
        }
        case 'ConditionalExpression':
        case 'LogicalExpression':
        case 'AssignmentExpression':
        case 'AssignmentPattern':
          for (const child of children(node)) {
            const logicalAssignment = node.type === 'AssignmentExpression' && ['&&=', '||=', '??='].includes(String(node.operator));
            const namedEvaluation = logicalAssignment || node.type === 'AssignmentPattern';
            if (child === node.right && namedEvaluation && anonymousDefinition(child)) {
              if (logicalAssignment) throw new Error('logical assignment infers a function or class name');
              visit(child);
            } else if (child === node.consequent || child === node.alternate || (child === node.right && (namedEvaluation || node.type === 'LogicalExpression'))) expression(child);
            else visit(child);
          }
          return;
        default:
          children(node).forEach(visit);
      }
    }

    visit(program);
    if (insertions.length === 0) return null;
    insertions.sort((left, right) => left[0] - right[0]);
    const plan = { stem, insertions };
    parse(applyExecutionTracePlan(source, plan), { ecmaVersion: 'latest', sourceType: 'module' });
    return plan;
  } catch {
    return null;
  }
}
