import { isLuaModuleCodePath } from './card.js';

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
