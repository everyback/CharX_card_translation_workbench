import { cardHash } from '../../domain/card/card.js';

export const LANGUAGE_BEHAVIOR_CONFIRMATION_FLAG = '已人工确认卡片语言设定';
export const PROTECTION_CONFIRMATION_FLAG_PREFIX = '已人工确认受保护内容变更：';
export const REVIEW_PROBLEM_QA_PREFIXES = ['保护结构缺失', '卡片语言设定待确认'] as const;

export function safeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parsePathJson(value: string): Array<string | number> {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as Array<string | number> : [];
  } catch {
    return [];
  }
}

export function hasLanguageBehaviorConfirmation(value: unknown): boolean {
  return safeArray(value).some((flag) => String(flag) === LANGUAGE_BEHAVIOR_CONFIRMATION_FLAG);
}

export function protectionConfirmationFlag(effectiveText: string): string {
  return `${PROTECTION_CONFIRMATION_FLAG_PREFIX}${cardHash(effectiveText.trim())}`;
}

export function hasProtectionConfirmation(value: unknown, effectiveText: string): boolean {
  const expected = protectionConfirmationFlag(effectiveText);
  return safeArray(value).some((flag) => String(flag) === expected);
}

export function isReviewProblemQaFlag(value: string): boolean {
  return REVIEW_PROBLEM_QA_PREFIXES.some((prefix) => value.startsWith(prefix));
}

export function reviewProblemQaFamily(value: string): string | null {
  return REVIEW_PROBLEM_QA_PREFIXES.find((prefix) => value.startsWith(prefix)) ?? null;
}
