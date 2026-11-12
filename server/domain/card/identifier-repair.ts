import { createHash } from 'node:crypto';
import { htmlControlAttributeRanges } from './html-controls.js';
import { luaCallbackNames, missingRisuActionCallbacks, moduleStrings } from './risu-actions.js';
import { MARKUP_TOKEN_SOURCE } from './text-attributes.js';

type Path = Array<string | number>;
export interface IdentifierRepairChange {
  id: string;
  owner: 'card' | 'module';
  path: Path;
  pathLabel: string;
  attribute: string;
  element: number;
  start: number;
  end: number;
  before: string;
  after: string;
  callbackVerified: boolean;
}

export interface IdentifierRepairPlan {
  changes: IdentifierRepairChange[];
  unresolved: Array<{ pathLabel: string; message: string }>;
}

function shape(text: string): string {
  // Both the complete element order and control attribute layout must match.
  const tags = [...text.matchAll(new RegExp(MARKUP_TOKEN_SOURCE, 'gu'))]
    .map(m => /^<(\/?[\w:-]+)/u.exec(m[0])?.[1]).filter(Boolean);
  return JSON.stringify([tags, htmlControlAttributeRanges(text).map(a => [a.element, a.tag, a.name])]);
}

function ruleKey(rule: unknown): string | null {
  if (!rule || typeof rule !== 'object') return null;
  const r = rule as Record<string, unknown>;
  return typeof r.in === 'string' ? JSON.stringify([r.in, r.type, r.flag, r.ableFlag]) : null;
}

function originalPath(owner: string, path: Path, original: Record<string, unknown>, translated: Record<string, unknown>): Path | null {
  if (path.some(part => typeof part === 'number') && path[0] !== 'regex') return null;
  if (owner !== 'module' || path[0] !== 'regex') return path;
  // A different version or duplicate regex key is ambiguous: never use nearest
  // text, a translated comment, an index alone, or an edit-distance guess.
  if (path.length !== 3 || path[2] !== 'out' || !Array.isArray(original.regex) || !Array.isArray(translated.regex)) return null;
  const key = ruleKey(translated.regex[Number(path[1])]);
  if (!key || translated.regex.filter(r => ruleKey(r) === key).length !== 1) return null;
  const matches = original.regex.flatMap((r, i) => ruleKey(r) === key ? [i] : []);
  return matches.length === 1 ? ['regex', matches[0], 'out'] : null;
}

export function planIdentifierRepair(
  originalCard: Record<string, unknown>, originalModule: Record<string, unknown> | null,
  translatedCard: Record<string, unknown>, translatedModule: Record<string, unknown> | null,
): IdentifierRepairPlan {
  const changes: IdentifierRepairChange[] = [];
  const unresolved: IdentifierRepairPlan['unresolved'] = [];
  const callbacks = luaCallbackNames(translatedModule ?? {});
  for (const owner of ['card', 'module'] as const) {
    const original = (owner === 'card' ? originalCard : originalModule) ?? {};
    const translated = (owner === 'card' ? translatedCard : translatedModule) ?? {};
    const baseline = moduleStrings(original);
    for (const [pathJson, candidate] of moduleStrings(translated)) {
      const path = JSON.parse(pathJson) as Path;
      // Executable code must be repaired separately; never overwrite a script
      // or its string fragments using a markup position heuristic.
      if (path.includes('code') || (path[0] === 'regex' && path.at(-1) !== 'out')) continue;
      const attrs = htmlControlAttributeRanges(candidate);
      if (!attrs.length) continue;
      const label = `${owner === 'card' ? '卡片' : '模块'}.${path.join('.')}`;
      const basePath = originalPath(owner, path, original, translated);
      const source = basePath ? baseline.get(JSON.stringify(basePath)) : undefined;
      if (source == null || shape(source) !== shape(candidate)) {
        unresolved.push({ pathLabel: label, message: '原件规则或 HTML 结构无法唯一对齐，未生成修复映射。' });
        continue;
      }
      const sourceAttrs = htmlControlAttributeRanges(source);
      attrs.forEach((attr, i) => {
        const expected = sourceAttrs[i];
        if (attr.value === expected.value) return;
        // Presence/absence and quoting changes need manual source review.
        if (attr.start === attr.end || expected.start === expected.end
          || candidate[attr.start - 1] !== source[expected.start - 1]
          || candidate[attr.end] !== source[expected.end]) {
          unresolved.push({ pathLabel: label, message: `属性 ${attr.name} 的语法不一致，未生成替换。` });
          return;
        }
        const details = { owner, path, pathLabel: label, attribute: attr.name, element: attr.element,
          start: attr.start, end: attr.end, before: attr.value, after: expected.value,
          callbackVerified: attr.name === 'risu-trigger' && callbacks.has(expected.value) };
        changes.push({ id: createHash('sha256').update(JSON.stringify(details)).digest('hex'), ...details });
      });
    }
  }
  return { changes, unresolved };
}

export function applyIdentifierRepair(
  card: Record<string, unknown>, module: Record<string, unknown> | null,
  plan: IdentifierRepairPlan, approvedIds: readonly string[],
): { card: Record<string, unknown>; module: Record<string, unknown> | null } {
  const selected = new Set(approvedIds);
  if (!selected.size || selected.size !== approvedIds.length
    || [...selected].some(id => !plan.changes.some(c => c.id === id))) throw new Error('请选择当前清单中明确审核通过的修复项。');
  const result = { card: structuredClone(card), module: module ? structuredClone(module) : null };
  const groups = new Map<string, IdentifierRepairChange[]>();
  for (const change of plan.changes.filter(c => selected.has(c.id))) {
    const key = JSON.stringify([change.owner, change.path]);
    groups.set(key, [...groups.get(key) ?? [], change]);
  }
  for (const changes of groups.values()) {
    const change = changes[0];
    let target: unknown = result[change.owner];
    for (const part of change.path.slice(0, -1)) target = (target as Record<string, unknown>)?.[part];
    if (!target || typeof target !== 'object') throw new Error('修复位置已变化，请重新生成清单。');
    const parent = target as Record<string, unknown>;
    const key = String(change.path.at(-1));
    const current = parent[key];
    if (typeof current !== 'string') throw new Error('修复位置不是文本。');
    let text: string = current;
    for (const item of changes.sort((a, b) => b.start - a.start)) {
      if (text.slice(item.start, item.end) !== item.before) throw new Error('待修复内容已变化，请重新生成清单。');
      text = text.slice(0, item.start) + item.after + text.slice(item.end);
    }
    parent[key] = text;
  }
  return result;
}

export function identifierRepairDiagnostics(module: Record<string, unknown> | null) {
  return missingRisuActionCallbacks(module ?? {}).map(r => ({ ...r,
    message: '无法静态确认此动作的 Lua 回调；动态注册需要人工验证。' }));
}
