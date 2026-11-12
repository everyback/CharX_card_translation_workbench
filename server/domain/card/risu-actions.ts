import { parse } from 'luaparse';
import { htmlControlAttributes, nonVisibleMarkupRanges } from './html-controls.js';
import { luaIdentifierNames, missingControlTokens } from './runtime-structure.js';

interface ActionReference {
  pathLabel: string;
  name: string;
}

interface ActionIssue {
  pathLabel: string;
  message: string;
}

export function missingRisuActionCallbacks(module: Record<string, unknown>): ActionReference[] {
  const callbacks = luaCallbackNames(module);
  return staticActionReferences(module).filter((reference) => !callbacks.has(reference.name));
}

function staticActionReferences(module: Record<string, unknown>): ActionReference[] {
  const missing: ActionReference[] = [];
  for (const [pathJson, source] of moduleStrings(module)) {
    for (const attribute of htmlControlAttributes(source)) {
      if (attribute.name !== 'risu-trigger' || !/^[\p{L}_][\p{L}\p{N}_]*$/u.test(attribute.value)) continue;
      missing.push({ pathLabel: modulePathLabel(pathJson), name: attribute.value });
    }
  }
  return missing;
}

export function risuActionIntegrityIssues(
  original: Record<string, unknown>,
  draft: Record<string, unknown>,
  label = '模块',
): ActionIssue[] {
  const issues: ActionIssue[] = [];
  const originalStrings = moduleStrings(original);
  const draftStrings = moduleStrings(draft);
  for (const pathJson of new Set([...originalStrings.keys(), ...draftStrings.keys()])) {
    const pathLabel = `${label}.${(JSON.parse(pathJson) as Array<string | number>).join('.')}`;
    let source = originalStrings.get(pathJson) ?? '';
    if (label === '模块' && typeof original.namespace === 'string' && typeof draft.namespace === 'string'
      && original.namespace && draft.namespace && original.namespace !== draft.namespace) {
      source = source.replace(/(module_?(?:assetlist|enabled)::)([^:}]+)/gu,
        (whole, prefix: string, name: string) => name === original.namespace ? prefix + draft.namespace : whole);
    }
    const candidate = draftStrings.get(pathJson) ?? '';
    const sourceAttributes = htmlControlAttributes(source);
    const draftAttributes = htmlControlAttributes(candidate);
    if (sourceAttributes.length && JSON.stringify(sourceAttributes) !== JSON.stringify(draftAttributes)) {
      issues.push({
        pathLabel,
        message: 'HTML 控制属性发生变化；请只翻译可见文案，保留按钮动作和结构属性。',
      });
    }
    const sourceCode = nonVisibleMarkupRanges(source).map((range) => range.text);
    const draftCode = nonVisibleMarkupRanges(candidate).map((range) => range.text);
    if (sourceCode.length && JSON.stringify(sourceCode) !== JSON.stringify(draftCode)) {
      issues.push({
        pathLabel,
        message: 'HTML 的 script/style 代码块发生变化。',
      });
    }
    if (missingControlTokens(source, candidate).length) {
      issues.push({ pathLabel, message: 'CBS 模板、变量名或插值表达式发生变化；请保留完整程序标记。' });
    }
    const path = JSON.parse(pathJson) as Array<string | number>;
    if (path.at(-1) === 'code' && path.some(part => part === 'effect' || part === 'trigger')) {
      const sourceNames = luaIdentifierNames(source);
      const draftNames = luaIdentifierNames(candidate);
      if (sourceNames && draftNames && [...sourceNames].some(name => !draftNames.has(name))) {
        issues.push({ pathLabel, message: 'Lua 程序标识符丢失或改名；翻译只能修改可见字符串。' });
      }
    }
  }
  const originalMissing = new Set(missingRisuActionCallbacks(original)
    .map((reference) => `${reference.pathLabel}\u0000${reference.name}`));
  for (const reference of missingRisuActionCallbacks(draft)) {
    if (originalMissing.has(`${reference.pathLabel}\u0000${reference.name}`)) continue;
    issues.push({ pathLabel: reference.pathLabel, message: `按钮动作 ${reference.name} 找不到静态 Lua 回调定义。` });
  }
  const originalCallbacks = luaCallbackNames(original);
  const draftCallbacks = luaCallbackNames(draft);
  for (const reference of staticActionReferences(original)) {
    if (originalCallbacks.has(reference.name) && !draftCallbacks.has(reference.name)) {
      issues.push({ pathLabel: reference.pathLabel, message: `按钮动作 ${reference.name} 的 Lua 回调定义已丢失。` });
    }
  }
  return issues;
}

export function moduleStrings(module: Record<string, unknown>): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (value: unknown, path: Array<string | number>): void => {
    if (typeof value === 'string') {
      result.set(JSON.stringify(path), value);
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, entry]) => visit(entry, [...path, key]));
    }
  };
  visit(module, []);
  return result;
}

function modulePathLabel(pathJson: string): string {
  return `模块.${(JSON.parse(pathJson) as Array<string | number>).join('.')}`;
}

export function luaCallbackNames(module: Record<string, unknown>): Set<string> {
  const names = new Set<string>();
  for (const [pathJson, source] of moduleStrings(module)) {
    const path = JSON.parse(pathJson) as Array<string | number>;
    if (path.at(-1) !== 'code' || !path.some((part) => part === 'effect' || part === 'trigger')) continue;
    try {
      const ast = parse(source, { luaVersion: '5.3', ranges: true }) as unknown;
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        if (!value || typeof value !== 'object') return;
        const node = value as Record<string, unknown>;
        if (node.type === 'FunctionDeclaration') {
          const name = callbackName(node.identifier, source);
          if (name) names.add(name);
        } else if (node.type === 'AssignmentStatement' && Array.isArray(node.variables) && Array.isArray(node.init)) {
          node.variables.forEach((variable, index) => {
            if (!isCallableValue((node.init as unknown[])[index])) return;
            const name = callbackName(variable, source);
            if (name) names.add(name);
          });
        } else if (node.type === 'BinaryExpression' && ['==', '~='].includes(String(node.operator))) {
          for (const side of [node.left, node.right]) {
            const name = stringLiteralValue(side, source);
            if (name) names.add(name);
          }
        }
        for (const [key, child] of Object.entries(node)) {
          if (key !== 'range' && key !== 'loc' && key !== 'raw') visit(child);
        }
      };
      visit(ast);
    } catch {
      // An unsupported Lua dialect cannot supply a reliable callback table.
    }
  }
  return names;
}

function isCallableValue(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const node = value as Record<string, unknown>;
  if (node.type === 'FunctionDeclaration') return true;
  return node.type === 'CallExpression'
    && Array.isArray(node.arguments)
    && node.arguments.some(isCallableValue);
}

function callbackName(value: unknown, source: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const node = value as Record<string, unknown>;
  if (node.type === 'Identifier') return String(node.name ?? '') || null;
  if (node.type !== 'IndexExpression' && node.type !== 'MemberExpression') return null;
  const base = node.base as Record<string, unknown> | undefined;
  if (base?.type !== 'Identifier' || base.name !== '_G') return null;
  const index = node.index ?? node.identifier;
  if (!index || typeof index !== 'object') return null;
  const member = index as Record<string, unknown>;
  if (member.type === 'Identifier') return String(member.name ?? '') || null;
  return stringLiteralValue(member, source);
}

function stringLiteralValue(value: unknown, source: string): string | null {
  if (!value || typeof value !== 'object') return null;
  const node = value as Record<string, unknown>;
  if (node.type !== 'StringLiteral' || !Array.isArray(node.range)) return null;
  const raw = source.slice(Number(node.range[0]), Number(node.range[1]));
  return raw.length >= 2 ? raw.slice(1, -1) : null;
}
