type Edit = { start: number; end: number; text: string };

export class ModuleReviewConflict extends Error {
  constructor(readonly pathLabel: string) {
    super(`脚本人工修改与已应用译文重叠：${pathLabel}。请在脚本管理中核对或恢复该脚本后重新保存；当前人工稿仍保留。`);
  }
}

/** Unique unchanged lines partition long scripts without a quadratic matrix. */
function lineAnchors(a: string[], b: string[]): Array<[number, number]> {
  const unique = (lines: string[]) => {
    const positions = new Map<string, number>();
    lines.forEach((line, index) => positions.set(line, positions.has(line) ? -1 : index));
    return positions;
  };
  const left = unique(a), right = unique(b);
  const pairs: Array<[number, number]> = [];
  for (const [line, i] of left) {
    const j = right.get(line);
    if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j]);
  }
  // Longest increasing subsequence keeps anchors in order even after moves.
  const tails: number[] = [], previous = new Int32Array(pairs.length).fill(-1);
  pairs.forEach((pair, index) => {
    let low = 0, high = tails.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (pairs[tails[mid]][1] < pair[1]) low = mid + 1; else high = mid;
    }
    if (low) previous[index] = tails[low - 1];
    tails[low] = index;
  });
  const result: Array<[number, number]> = [];
  for (let index = tails.at(-1) ?? -1; index >= 0; index = previous[index]) result.push(pairs[index]);
  return result.reverse();
}

/** Line alignment keeps independent nearby repairs separate from translations. */
function edits(before: string, after: string, mode: 'lines' | 'tokens' | 'characters' = 'lines'): Edit[] {
  if (before === after) return [];
  const split = (text: string) => mode === 'characters' ? text.split('')
    : mode === 'tokens' ? text.match(/[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]/gu) ?? []
      : text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const a = split(before), b = split(after);
  if (a.length * b.length > 2_000_000) {
    // A minified HTML/JS string inside Lua can itself be hundreds of KB.
    if (mode === 'characters') return edits(before, after, 'tokens');
    const anchors = lineAnchors(a, b);
    if (!anchors.length) return [trimEdit(before, after, 0)];
    const result: Edit[] = [];
    let ai = 0, bi = 0, offset = 0;
    for (const [i, j] of [...anchors, [a.length, b.length]]) {
      const removed = a.slice(ai, i).join(''), added = b.slice(bi, j).join('');
      result.push(...edits(removed, added, mode).map(edit => ({ ...edit, start: edit.start + offset, end: edit.end + offset })));
      offset += removed.length + (a[i]?.length ?? 0);
      ai = i + 1; bi = j + 1;
    }
    return result;
  }
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
    if (mode === 'characters' || (mode === 'tokens' && (trimmed.end - trimmed.start) * trimmed.text.length > 2_000_000)) result.push(trimmed);
    else result.push(...edits(before.slice(trimmed.start, trimmed.end), trimmed.text, 'characters')
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
