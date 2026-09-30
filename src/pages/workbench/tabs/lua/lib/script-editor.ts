import type { LuaManagementReport } from '@/shared/types';

type Change = LuaManagementReport['scriptChanges'][number];

// Legacy diagnostics omitted pathJson. Only reconstruct the known indexed module
// code paths; never split arbitrary object keys or card fields into editable paths.
export function editableLuaSource(change: Change): Change {
  if (change.luaPathJson) return change;
  if (!/^\$module\.(?:trigger|triggers)\.\d+\.(?:effect|effects)\.\d+\.code$/.test(change.pathLabel)) return change;
  const path = change.pathLabel.split('.').slice(1).map(part => /^\d+$/.test(part) ? Number(part) : part);
  return { ...change, luaPathJson: JSON.stringify(path) };
}

export function scriptEditorSources(report: Pick<LuaManagementReport, 'scriptSources' | 'scriptChanges'>): Change[] {
  return (report.scriptSources ?? report.scriptChanges ?? []).map(editableLuaSource).filter(source => source.luaPathJson);
}

export function regexChanges(report: Pick<LuaManagementReport, 'scriptChanges'>): Change[] {
  return (report.scriptChanges ?? []).filter(source => /\.(?:regex|customscript)\./.test(source.pathLabel) && /\.(?:in|out)$/.test(source.pathLabel));
}
