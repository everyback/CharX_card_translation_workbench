export interface RisuTemplateIssue {
  pathLabel: string;
  message: string;
}

export interface RisuRuntimeRisk {
  pathLabel: string;
  message: string;
}

/**
 * Validate the parts of a Risu module that Lua syntax alone cannot validate.
 * A translated string can still produce invalid CSS or remove an HTML node
 * while remaining perfectly valid Lua, so compare the candidate with the
 * original and only report newly introduced problems.
 */
export function validateRisuTemplateChanges(
  original: Record<string, unknown>,
  draft: Record<string, unknown>,
): RisuTemplateIssue[] {
  const originalCode = collectLuaCode(original);
  const draftCode = collectLuaCode(draft);
  const issues: RisuTemplateIssue[] = [];

  for (const [pathJson, candidate] of draftCode) {
    const source = originalCode.get(pathJson) ?? '';
    const originalIssues = templateIssues(source);
    const candidateIssues = templateIssues(candidate);
    for (const message of candidateIssues) {
      if (!originalIssues.includes(message)) {
        issues.push({ pathLabel: labelForPath(JSON.parse(pathJson)), message });
      }
    }
  }
  return uniqueIssues(issues);
}

/**
 * These are non-blocking warnings shown after scanning. The workbench cannot
 * know a card's runtime storage contract with certainty, but it can identify
 * the common `"null"`/`"undefined"` list failure that renders phantom cards.
 */
export function detectRisuRuntimeRisks(module: Record<string, unknown>): RisuRuntimeRisk[] {
  const risks: RisuRuntimeRisk[] = [];
  for (const [pathJson, source] of collectLuaCode(module)) {
    const reads = [...source.matchAll(/getChatVar\s*\([^\n]*["'](?:prisoner_list|soldier_list)["'][^\n]*\)/gu)];
    if (!reads.length) continue;
    const guarded = reads.every((read) => {
      const nearby = source.slice(read.index ?? 0, (read.index ?? 0) + 900);
      return /\b(?:null|undefined)\b/iu.test(nearby)
        && /(?:==|~=|not\s+|lower\s*\(|tostring\s*\()/iu.test(nearby);
    });
    if (!guarded) risks.push({
      pathLabel: labelForPath(JSON.parse(pathJson)),
      message: '列表状态未显式过滤字符串 null/undefined，运行时可能生成空白卡片。',
    });
  }
  return risks;
}

function templateIssues(source: string): string[] {
  const issues: string[] = [];
  for (const match of source.matchAll(/\b(width|height|min-width|max-width|min-height|max-height)\s*:\s*([^;{}\r\n]*)\s*;/giu)) {
    if (!hasBalancedParentheses(match[2])) {
      issues.push(`CSS 属性 ${match[1]} 的值疑似被翻译破坏（括号不平衡）。`);
    }
  }
  return issues;
}

function hasBalancedParentheses(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')' && --depth < 0) return false;
  }
  return depth === 0;
}

function collectLuaCode(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (child: unknown, path: Array<string | number>) => {
    if (typeof child === 'string') {
      if (path.at(-1) === 'code' && path.some((part) => part === 'effect' || part === 'trigger')) {
        result.set(JSON.stringify(path), child);
      }
      return;
    }
    if (Array.isArray(child)) {
      child.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!child || typeof child !== 'object') return;
    for (const [key, entry] of Object.entries(child)) visit(entry, [...path, key]);
  };
  visit(value, []);
  return result;
}

function labelForPath(path: Array<string | number>): string {
  return path.map((part) => String(part)).join('.');
}

function uniqueIssues(issues: RisuTemplateIssue[]): RisuTemplateIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.pathLabel}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
