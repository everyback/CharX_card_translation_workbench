import { isLuaModuleCodePath } from '../card/card.js';

export type PortraitRouterRepairId = 'completion-marker-gate' | 'main-passthrough';

export interface PortraitRouterRepairFinding {
  id: PortraitRouterRepairId;
  title: string;
  message: string;
  pathLabel: string;
  safeToApply: boolean;
}

export interface PortraitRouterRepairReport {
  detected: boolean;
  canApply: boolean;
  findings: PortraitRouterRepairFinding[];
}

export interface PortraitRouterRepairResult {
  draft: Record<string, unknown>;
  report: PortraitRouterRepairReport;
  applied: PortraitRouterRepairFinding[];
  changes: PortraitRouterRepairChange[];
}

export interface PortraitRouterRepairChange {
  id: PortraitRouterRepairId;
  title: string;
  pathLabel: string;
  before: string;
  after: string;
}

export interface PortraitRouterRepairOverride {
  id: PortraitRouterRepairId;
  pathLabel: string;
  before: string;
  after: string;
}

interface LuaCodeNode {
  path: Array<string | number>;
  source: string;
  replace: (source: string) => void;
}

const COMPLETION_MARKER_GATE = /^(\s*)if type\(([_A-Za-z][_A-Za-z0-9]*)\) ~= 'string' or not \2:find\('<!--RISU_COMPLETE:[A-Za-z0-9_.:-]+-->', 1, true\) then return end\s*$/gmu;
const MAIN_ROUTER_FUNCTION = /(^([\t ]*)local function ([A-Za-z_][A-Za-z0-9_]*_run_main)\(([_A-Za-z][_A-Za-z0-9]*)\)\r?\n)([\s\S]*?)(^\2end\b)/gmu;

/**
 * Detect only two exact, cross-card failure patterns.  Both repairs preserve
 * router-owned modes and leave unrelated Lua untouched.
 */
export function inspectPortraitRouterRepairs(module: Record<string, unknown>): PortraitRouterRepairReport {
  const findings: PortraitRouterRepairFinding[] = [];
  for (const node of luaCodeNodes(module)) {
    if (COMPLETION_MARKER_GATE.test(node.source)) {
      findings.push({
        id: 'completion-marker-gate',
        title: '移除未声明的完成标记门控',
        message: 'onOutput 依赖一个模型没有被要求输出的完成标记，任何模式都可能完全不进入路由器。',
        pathLabel: pathLabel(node.path),
        safeToApply: true,
      });
    }
    COMPLETION_MARKER_GATE.lastIndex = 0;

    for (const match of node.source.matchAll(MAIN_ROUTER_FUNCTION)) {
      const body = match[5] ?? '';
      if (!/build_context\([^\n]*['"]main['"][^\n]*\)/u.test(body)
        || !/\b[A-Za-z_][A-Za-z0-9_]*_commit\s*\(/u.test(body)) continue;
      findings.push({
        id: 'main-passthrough',
        title: 'Main 模式保留模型的精确标签',
        message: 'Main 模式仍会清理并重渲染模型已经输出的精确标签，可能导致标签从正文消失。',
        pathLabel: pathLabel(node.path),
        safeToApply: true,
      });
    }
  }
  return {
    detected: findings.length > 0,
    canApply: findings.some((finding) => finding.safeToApply),
    findings,
  };
}

/** Apply only findings recognized by the exact patterns above. */
export function applyPortraitRouterRepairs(module: Record<string, unknown>): PortraitRouterRepairResult {
  const draft = structuredClone(module);
  const applied: PortraitRouterRepairFinding[] = [];
  const changes: PortraitRouterRepairChange[] = [];

  for (const node of luaCodeNodes(draft)) {
    let source = node.source;
    let gateApplied = false;
    source = source.replace(COMPLETION_MARKER_GATE, (_full, indent: string, variable: string) => {
      gateApplied = true;
      return `${indent}if type(${variable}) ~= 'string' or ${variable}:match('^%s*$') then return end`;
    });
    if (gateApplied) {
      const finding = {
        id: 'completion-marker-gate' as const,
        title: '移除未声明的完成标记门控',
        message: 'onOutput 现在以非空的已完成回复为准，不再等待模型未声明的隐藏标记。',
        pathLabel: pathLabel(node.path),
        safeToApply: true,
      };
      const after = source;
      changes.push({ id: finding.id, title: finding.title, pathLabel: finding.pathLabel, before: node.source, after });
      applied.push({
        ...finding,
      });
    }

    let mainApplied = false;
    const mainBefore = source;
    source = source.replace(MAIN_ROUTER_FUNCTION, (full, header: string, indent: string, _name: string, triggerId: string, body: string, ending: string) => {
      if (!/build_context\([^\n]*['"]main['"][^\n]*\)/u.test(body)
        || !/\b[A-Za-z_][A-Za-z0-9_]*_commit\s*\(/u.test(body)) return full;
      mainApplied = true;
      const diagnostics = source.includes('write_chat_var(')
        ? `${indent}    write_chat_var(${triggerId}, 'th_asset_last_source', 'main-passthrough')\n${indent}    write_chat_var(${triggerId}, 'th_asset_last_count', 'model-owned')\n`
        : '';
      return `${header}${indent}    local idx, original = get_last_message(${triggerId})\n${indent}    if not idx or original == '' then return false end\n${diagnostics}${indent}    return true\n${ending}`;
    });
    if (mainApplied) {
      const finding = {
        id: 'main-passthrough' as const,
        title: 'Main 模式保留模型的精确标签',
        message: 'Main 模式不再清理或重新插入模型已输出的精确标签；Lua 和 Aux 仍按各自路由执行。',
        pathLabel: pathLabel(node.path),
        safeToApply: true,
      };
      changes.push({ id: finding.id, title: finding.title, pathLabel: finding.pathLabel, before: mainBefore, after: source });
      applied.push({
        ...finding,
      });
    }
    if (source !== node.source) node.replace(source);
  }

  return { draft, report: inspectPortraitRouterRepairs(draft), applied, changes };
}

/**
 * Apply edits made in the review dialog to the exact repair result that was previewed.
 * The expected change is checked first so a stale dialog cannot overwrite a newer module.
 */
export function applyPortraitRouterChangeOverrides(
  module: Record<string, unknown>,
  overrides: PortraitRouterRepairOverride[],
  expectedChanges: PortraitRouterRepairChange[],
  options: { requireBefore?: boolean } = {},
): Record<string, unknown> {
  const draft = structuredClone(module);
  const nodes = luaCodeNodes(draft);
  const requested = new Map<string, PortraitRouterRepairOverride>();
  for (const override of overrides) {
    if (!override || typeof override.after !== 'string' || typeof override.before !== 'string') {
      throw new Error('路由修改内容格式无效。');
    }
    const key = `${override.id}:${override.pathLabel}`;
    if (requested.has(key)) throw new Error(`路由修改重复提交：${override.pathLabel}`);
    const expected = expectedChanges.find((change) => change.id === override.id && change.pathLabel === override.pathLabel);
    if (!expected) throw new Error(`路由修改已过期或不在安全修改范围内：${override.pathLabel}`);
    if (options.requireBefore !== false && override.before !== expected.before) {
      throw new Error(`路由原代码已变化，请重新打开修改对比：${override.pathLabel}`);
    }
    if (override.after.length > 2_000_000) throw new Error(`路由修改内容过大：${override.pathLabel}`);
    requested.set(key, override);
  }

  const processedPaths = new Set<string>();
  const workingSources = new Map<string, string>();
  for (const expected of expectedChanges) {
    const key = `${expected.id}:${expected.pathLabel}`;
    const override = requested.get(key);
    const node = nodes.find((candidate) => pathLabel(candidate.path) === expected.pathLabel);
    if (!node) throw new Error(`找不到路由代码位置：${expected.pathLabel}`);
    const desired = override?.after ?? expected.after;
    const current = workingSources.get(expected.pathLabel) ?? node.source;
    if (!processedPaths.has(expected.pathLabel) && current !== expected.before) {
      throw new Error(`路由预览已过期，请重新打开修改对比：${expected.pathLabel}`);
    }
    const next = current === expected.before
      ? desired
      : applyRouterChangeDelta(current, expected.before, expected.after, desired, expected.pathLabel);
    node.replace(next);
    workingSources.set(expected.pathLabel, next);
    processedPaths.add(expected.pathLabel);
  }
  return draft;
}

/**
 * Replays one repair onto a source that may already contain an earlier reviewed
 * edit at the same Lua path. The repair region is located from the preview's
 * before/after pair, so unrelated reviewed text is preserved.
 */
function applyRouterChangeDelta(
  current: string,
  expectedBefore: string,
  expectedAfter: string,
  desiredAfter: string,
  path: string,
): string {
  const { prefix, suffix } = textDiffBounds(expectedBefore, expectedAfter);
  const oldRegion = expectedBefore.slice(prefix, expectedBefore.length - suffix);
  const newRegion = desiredAfter.slice(prefix, desiredAfter.length - suffix);
  if (!oldRegion) {
    if (prefix === expectedBefore.length) return `${current}${newRegion}`;
    if (prefix === 0) return `${newRegion}${current}`;
    const anchorStart = Math.max(0, prefix - 256);
    const anchor = expectedBefore.slice(anchorStart, prefix);
    const anchorIndex = current.indexOf(anchor);
    if (!anchor || anchorIndex < 0 || anchorIndex !== current.lastIndexOf(anchor)) {
      throw new Error(`路由修改无法定位安全修改点：${path}`);
    }
    const insertionPoint = anchorIndex + anchor.length;
    return `${current.slice(0, insertionPoint)}${newRegion}${current.slice(insertionPoint)}`;
  }
  const first = current.indexOf(oldRegion);
  const last = current.lastIndexOf(oldRegion);
  if (first < 0 || first !== last) throw new Error(`路由预览已过期，请重新打开修改对比：${path}`);
  return `${current.slice(0, first)}${newRegion}${current.slice(first + oldRegion.length)}`;
}

/** Apply a reviewed edit from one module's preview result to its translated counterpart. */
export function applyPortraitRouterReviewDelta(
  target: string,
  expected: string,
  desired: string,
  path: string,
): string {
  if (expected === desired) return target;
  const { prefix, suffix } = textDiffBounds(expected, desired);
  const oldRegion = expected.slice(prefix, expected.length - suffix);
  const newRegion = desired.slice(prefix, desired.length - suffix);
  if (!oldRegion) {
    if (prefix === expected.length) return `${target}${newRegion}`;
    if (prefix === 0) return `${newRegion}${target}`;
    const anchorStart = Math.max(0, prefix - 256);
    const anchor = expected.slice(anchorStart, prefix);
    const anchorIndex = target.indexOf(anchor);
    if (!anchor || anchorIndex < 0 || anchorIndex !== target.lastIndexOf(anchor)) {
      throw new Error(`路由修改无法定位安全修改点：${path}`);
    }
    const insertionPoint = anchorIndex + anchor.length;
    return `${target.slice(0, insertionPoint)}${newRegion}${target.slice(insertionPoint)}`;
  }
  const first = target.indexOf(oldRegion);
  const last = target.lastIndexOf(oldRegion);
  if (first < 0 || first !== last) throw new Error(`路由修改无法同步到草稿：${path}`);
  return `${target.slice(0, first)}${newRegion}${target.slice(first + oldRegion.length)}`;
}

function textDiffBounds(source: string, peer: string): { prefix: number; suffix: number } {
  let prefix = 0;
  while (prefix < source.length && prefix < peer.length && source[prefix] === peer[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < source.length - prefix
    && suffix < peer.length - prefix
    && source[source.length - suffix - 1] === peer[peer.length - suffix - 1]
  ) suffix += 1;
  return { prefix, suffix };
}

function luaCodeNodes(module: Record<string, unknown>): LuaCodeNode[] {
  const nodes: LuaCodeNode[] = [];
  const visit = (value: unknown, path: Array<string | number>): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (key === 'code' && typeof child === 'string' && isLuaModuleCodePath(childPath)) {
        nodes.push({
          path: childPath,
          source: child,
          replace: (source) => { (value as Record<string, unknown>)[key] = source; },
        });
      } else visit(child, childPath);
    }
  };
  visit(module, []);
  return nodes;
}

function pathLabel(path: Array<string | number>): string {
  return `模块.${path.join('.')}`;
}
