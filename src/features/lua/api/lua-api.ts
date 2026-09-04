import { api, jsonBody } from '@/shared/api/http';
import type {
  RegexCoveragePreview,
  RegexCoverageRuleResult,
  RegexRuleSaveResult,
  RegexRuleTestResult,
} from '@/shared/types';

export function saveLuaSyntaxLine(
  projectId: string,
  pathJson: string,
  line: number,
  replacement: string,
  expectedLine?: string,
) {
  return api<{ syntaxOk: boolean; remainingSyntaxIssues?: unknown[] }>(`/api/projects/${projectId}/lua/syntax-line`, {
    method: 'PATCH',
    ...jsonBody({ pathJson, line, replacement, ...(expectedLine !== undefined ? { expectedLine } : {}) }),
  });
}

export function confirmLuaNamespace(projectId: string, targetNamespace: string) {
  return api<{ sourceNamespace: string; targetNamespace: string }>(`/api/projects/${projectId}/lua/namespace-decision`, {
    method: 'POST',
    ...jsonBody({ targetNamespace }),
  });
}

export function saveLuaRuntimeAliases(projectId: string, ownerId: string, aliases: string[]) {
  return api(`/api/projects/${projectId}/lua/runtime-aliases`, {
    method: 'POST',
    ...jsonBody({ ownerId, aliases }),
  });
}

export function previewRegexCoverage(projectId: string) {
  return api<RegexCoveragePreview>(`/api/projects/${projectId}/lua/regex-coverage/preview`, { method: 'POST' });
}

export function analyzeRegexCoverageRule(projectId: string, pathLabel: string, signal?: AbortSignal, pattern?: string) {
  return api<RegexCoverageRuleResult>(`/api/projects/${projectId}/lua/regex-coverage/rule`, {
    method: 'POST',
    signal,
    ...jsonBody({ pathLabel, ...(pattern !== undefined ? { pattern } : {}) }),
  });
}

export function testRegexRule(projectId: string, pathLabel: string, pattern: string) {
  return api<RegexRuleTestResult>(`/api/projects/${projectId}/lua/regex-test`, {
    method: 'POST',
    ...jsonBody({ pathLabel, pattern }),
  });
}

export function saveRegexRule(
  projectId: string,
  pathLabel: string,
  pattern: string,
  expectedPattern: string,
  forcePass: boolean,
  out?: string,
  expectedOut?: string,
) {
  return api<RegexRuleSaveResult>(`/api/projects/${projectId}/lua/regex-rule`, {
    method: 'PATCH',
    ...jsonBody({
      pathLabel,
      pattern,
      expectedPattern,
      forcePass,
      ...(out !== undefined ? { out } : {}),
      ...(expectedOut !== undefined ? { expectedOut } : {}),
    }),
  });
}
