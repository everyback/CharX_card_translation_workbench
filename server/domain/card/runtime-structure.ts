import { parse } from 'luaparse';

/** Balanced CBS tokens, including nested operands. Button labels are copy. */
export function templateControlTokens(source: string): string[] {
  const tokens: string[] = [];
  for (let cursor = 0; cursor < source.length;) {
    const start = source.indexOf('{{', cursor);
    if (start < 0) break;
    let end = start + 2;
    let depth = 1;
    while (end < source.length && depth) {
      if (source.startsWith('{{', end)) { depth++; end += 2; }
      else if (source.startsWith('}}', end)) { depth--; end += 2; }
      else end++;
    }
    if (depth) break; // Incomplete source syntax cannot establish an invariant.
    const token = source.slice(start, end);
    tokens.push(token.replace(/^(\{\{button::)[^{}]*?(::[^{}]*\}\})$/u, '$1$2'));
    cursor = end;
  }
  // JavaScript interpolation also carries variable references in prose/templates.
  tokens.push(...source.match(/\$\{[^{}]+\}/gu) ?? []);
  return tokens;
}

export function missingControlTokens(source: string, candidate: string): string[] {
  const available = new Map<string, number>();
  for (const token of templateControlTokens(candidate)) available.set(token, (available.get(token) ?? 0) + 1);
  return templateControlTokens(source).filter(token => {
    const count = available.get(token) ?? 0;
    if (!count) return true;
    available.set(token, count - 1);
    return false;
  });
}

/** Compare executable names independently of translated literals and comments. */
export function luaIdentifierNames(source: string): Set<string> | null {
  try {
    const names = new Set<string>();
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (node.type === 'Identifier' && typeof node.name === 'string') names.add(node.name);
      for (const [key, child] of Object.entries(node)) {
        if (!['raw', 'loc', 'range', 'comments'].includes(key)) visit(child);
      }
    };
    visit(parse(source, { luaVersion: '5.3' }));
    return names;
  } catch { return null; }
}
