import { createHash } from 'node:crypto';

export interface VersionField {
  id: string;
  path_json: string;
  path_label: string;
  kind: string;
  source_text: string;
  translated_text: string | null;
  final_text: string | null;
  review_status: string;
  start_pos: number | null;
  end_pos: number | null;
  protocol_delimiter: string | null;
}

export interface VersionSource { card: Record<string, unknown>; module: Record<string, unknown> | null }
export interface VersionMatch {
  current?: VersionField;
  previous?: VersionField;
  status: 'unchanged' | 'changed' | 'added' | 'removed' | 'ambiguous';
}

/** Object keys are stable even if the importer reorders JSON properties. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function createStablePath(source: VersionSource) {
  const arrayIdentities = new WeakMap<object, Map<string, number>>();
  const objectHashes = new WeakMap<object, string>();
  const identityKeys = ['id', 'uid', 'identifier', 'uuid'];
  const identityToken = (key: string, value: unknown) => JSON.stringify([key, value]);
  return (field: VersionField): { key: string; ambiguous: boolean } => {
    const path = JSON.parse(field.path_json) as Array<string | number>;
    let node: unknown = path[0] === '$module' ? source.module : source.card;
    const output: unknown[] = path[0] === '$module' ? ['$module'] : [];
    let ambiguous = false;
    for (const part of path.slice(path[0] === '$module' ? 1 : 0)) {
      if (typeof part === 'number' && Array.isArray(node)) {
        const entry = node[part];
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
          const record = entry as Record<string, unknown>;
          const idKey = identityKeys.find(key => ['string', 'number'].includes(typeof record[key]) && record[key] !== '');
          if (idKey) {
            let counts = arrayIdentities.get(node);
            if (!counts) {
              counts = new Map();
              for (const item of node) if (item && typeof item === 'object') {
                for (const key of identityKeys) {
                  const value = (item as Record<string, unknown>)[key];
                  if (!['string', 'number'].includes(typeof value) || value === '') continue;
                  const token = identityToken(key, value);
                  counts.set(token, (counts.get(token) ?? 0) + 1);
                }
              }
              arrayIdentities.set(node, counts);
            }
            // Duplicate IDs cannot establish identity across versions.
            if (counts.get(identityToken(idKey, record[idKey])) !== 1) ambiguous = true;
            output.push({ [idKey]: record[idKey] });
          } else {
            // Without an ID, only identical objects can move safely. This deliberately
            // avoids treating an array index as the identity of a worldbook entry.
            let hash = objectHashes.get(entry);
            if (!hash) { hash = createHash('sha256').update(canonical(entry)).digest('hex'); objectHashes.set(entry, hash); }
            output.push({ object: hash });
          }
        } else output.push(part);
        node = entry;
      } else {
        output.push(part);
        node = node && typeof node === 'object' ? (node as Record<string | number, unknown>)[part] : undefined;
      }
    }
    return { key: JSON.stringify([output, field.kind, field.protocol_delimiter]), ambiguous };
  };
}

export function matchVersionFields(current: readonly VersionField[], previous: readonly VersionField[], currentSource: VersionSource, previousSource: VersionSource): VersionMatch[] {
  const groups = new Map<string, VersionField[]>();
  const previousPath = createStablePath(previousSource);
  const currentPath = createStablePath(currentSource);
  const ambiguousKeys = new Set<string>();
  for (const field of previous) {
    const { key, ambiguous } = previousPath(field);
    if (ambiguous) ambiguousKeys.add(key);
    const group = groups.get(key) ?? [];
    group.push(field); groups.set(key, group);
  }
  const currentKeys = new Map<string, VersionField[]>();
  const fieldKeys = new Map<string, string>();
  for (const field of current) {
    const { key, ambiguous } = currentPath(field);
    if (ambiguous) ambiguousKeys.add(key);
    fieldKeys.set(field.id, key);
    const group = currentKeys.get(key) ?? [];
    group.push(field); currentKeys.set(key, group);
  }
  const used = new Set<string>();
  const uncertain = new Set<string>();
  const matches: VersionMatch[] = current.map(field => {
    const key = fieldKeys.get(field.id)!;
    const candidates = (groups.get(key) ?? []).filter(candidate => !used.has(candidate.id));
    const ambiguous = (): VersionMatch => {
      for (const candidate of candidates) uncertain.add(candidate.id);
      return { current: field, status: 'ambiguous' };
    };
    if (ambiguousKeys.has(key)) return ambiguous();
    const exact = candidates.filter(candidate => candidate.source_text === field.source_text);
    // Repeated identical text within the same field is ambiguous, even if offsets
    // happen to line up after an edit. Never guess which translation belongs here.
    const sameCurrent = (currentKeys.get(key) ?? []).filter(item => item.source_text === field.source_text);
    if (exact.length === 1 && sameCurrent.length === 1) {
      used.add(exact[0].id);
      return { current: field, previous: exact[0], status: 'unchanged' };
    }
    if (exact.length > 0 || candidates.length > 1 || (candidates.length && (currentKeys.get(key)?.length ?? 0) > 1)) return ambiguous();
    if (candidates.length === 1) {
      used.add(candidates[0].id);
      return { current: field, previous: candidates[0], status: 'changed' };
    }
    return { current: field, status: 'added' };
  });
  return [...matches, ...previous.filter(field => !used.has(field.id) && !uncertain.has(field.id)).map(previous => ({ previous, status: 'removed' as const }))];
}
