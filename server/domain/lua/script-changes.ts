import { isLuaModuleCodePath } from '../card/card.js';

export interface ScriptChange {
  pathLabel: string;
  before: string;
  after: string;
}

/** Compare complete script fields, independently of outstanding diagnostics. */
export function scriptChanges(original: unknown, draft: unknown, root: string): ScriptChange[] {
  if (draft == null) return [];
  const collect = (value: unknown, path: Array<string | number>, result: Map<string, string>) => {
    if (typeof value === 'string') {
      if (isLuaModuleCodePath(path) || (path.some(part => part === 'regex' || part === 'customscript')
        && ['in', 'out'].includes(String(path.at(-1))))) result.set(JSON.stringify(path), value);
    } else if (Array.isArray(value)) {
      value.forEach((child, index) => collect(child, [...path, index], result));
    } else if (value && typeof value === 'object') {
      Object.entries(value).forEach(([key, child]) => collect(child, [...path, key], result));
    }
  };
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  collect(original, [root], before);
  collect(draft, [root], after);
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter(path => before.get(path) !== after.get(path))
    .map(path => ({ pathLabel: (JSON.parse(path) as Array<string | number>).join('.'), before: before.get(path) ?? '', after: after.get(path) ?? '' }));
}
