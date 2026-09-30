type Edit = { start: number; end: number; text: string };

export class ModuleReviewConflict extends Error {
  constructor(readonly pathLabel: string) {
    super(`脚本人工修改与已应用译文重叠：${pathLabel}。请在脚本管理中核对或恢复该脚本后重新保存；当前人工稿仍保留。`);
  }
}

/** Line alignment keeps independent nearby repairs separate from translations. */
function edits(before: string, after: string, characters = false): Edit[] {
  if (before === after) return [];
  const a = characters ? before.split('') : before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const b = characters ? after.split('') : after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  if (a.length * b.length > 2_000_000) return [trimEdit(before, after, 0)];
  const rows = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1]);
  }
  const result: Edit[] = [];
  let i = 0, j = 0, offset = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { offset += a[i++].length; j++; continue; }
    const start = offset;
    let removed = '', added = '';
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i] === b[j])) {
      if (j < b.length && (i === a.length || rows[i][j + 1] > rows[i + 1][j])) added += b[j++];
      else { removed += a[i]; offset += a[i++].length; }
    }
    const trimmed = trimEdit(removed, added, start);
    if (characters) result.push(trimmed);
    else result.push(...edits(before.slice(trimmed.start, trimmed.end), trimmed.text, true)
      .map(edit => ({ ...edit, start: edit.start + trimmed.start, end: edit.end + trimmed.start })));
  }
  return result;
}

function trimEdit(before: string, after: string, offset: number): Edit {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length, tail = after.length;
  while (end > start && tail > start && before[end - 1] === after[tail - 1]) { end--; tail--; }
  return { start: offset + start, end: offset + end, text: after.slice(start, tail) };
}

function rebaseText(base: string, applied: string, current: string, path: string): string {
  const undo = edits(applied, base);
  const manual = edits(applied, current).filter(edit => !undo.some(revert =>
    edit.start === revert.start && edit.end === revert.end && edit.text === revert.text));
  for (const edit of manual) for (const revert of undo) {
    const overlap = edit.start < revert.end && revert.start < edit.end
      || edit.start === edit.end && edit.start > revert.start && edit.start < revert.end
      || revert.start === revert.end && revert.start > edit.start && revert.start < edit.end
      || edit.start === revert.start;
    if (overlap) throw new ModuleReviewConflict(path);
  }
  let result = applied;
  for (const edit of [...undo, ...manual].sort((x, y) => y.start - x.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  return result;
}

/** Remove the previous reviewed overlay while preserving independent manual repairs. */
export function restoreModuleReviewBase<T>(base: T, applied: T, current: T, path = '$module'): T {
  if (JSON.stringify(current) === JSON.stringify(base)) return structuredClone(base);
  if (JSON.stringify(current) === JSON.stringify(applied)) return structuredClone(base);
  if (JSON.stringify(base) === JSON.stringify(applied)) return structuredClone(current);
  if (typeof base === 'string' && typeof applied === 'string' && typeof current === 'string') {
    return rebaseText(base, applied, current, path) as T;
  }
  if (base && applied && current && typeof base === 'object' && typeof applied === 'object' && typeof current === 'object'
    && Array.isArray(base) === Array.isArray(applied) && Array.isArray(base) === Array.isArray(current)) {
    const result = structuredClone(current) as Record<string, unknown>;
    for (const key of new Set([...Object.keys(base), ...Object.keys(applied), ...Object.keys(current)])) {
      const b = (base as Record<string, unknown>)[key], a = (applied as Record<string, unknown>)[key], c = (current as Record<string, unknown>)[key];
      const value = restoreModuleReviewBase(b, a, c, `${path}.${key}`);
      if (value === undefined) delete result[key]; else result[key] = value;
    }
    return result as T;
  }
  throw new ModuleReviewConflict(path);
}

export interface ModuleReviewState {
  base: Record<string, unknown>;
  applied: Record<string, unknown>;
}
