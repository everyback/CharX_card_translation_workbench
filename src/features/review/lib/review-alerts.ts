import { ApiError } from '@/shared/api/http';

const REVIEW_PROBLEM_QA_PREFIXES = ['保护结构缺失', '卡片语言设定待确认'] as const;

export function sameReviewProblemFamily(left: string, right: string): boolean {
  return REVIEW_PROBLEM_QA_PREFIXES.some((prefix) => left.startsWith(prefix) && right.startsWith(prefix));
}

export function isLanguageConfirmationRequired(error: unknown): error is ApiError {
  return error instanceof ApiError && error.payload.code === 'LANGUAGE_BEHAVIOR_CONFIRM_REQUIRED';
}

export function isProtectionConfirmationRequired(error: unknown): error is ApiError {
  return error instanceof ApiError && error.payload.code === 'PROTECTED_FRAGMENTS_CONFIRM_REQUIRED';
}

export function languageConfirmationPrompt(error: ApiError, fallback: string): string {
  const items = Array.isArray(error.payload.items)
    ? error.payload.items.slice(0, 5).map((item) => {
        if (!item || typeof item !== 'object') return '';
        const record = item as Record<string, unknown>;
        return `${String(record.pathLabel || record.id)}：${String(record.issue || '')}`;
      }).filter(Boolean)
    : [];
  const detail = items.length
    ? `\n\n${items.join('\n')}${Number(error.payload.total) > items.length ? `\n……另有 ${Number(error.payload.total) - items.length} 条` : ''}`
    : '';
  return `${fallback}\n${error.message}${detail}\n\n这些内容可能是卡片明确指定的专用语言，或属于语言选择项目。确认后将保留该条原设定并通过。`;
}

export function protectionConfirmationPrompt(error: ApiError, fallback: string): string {
  const items = Array.isArray(error.payload.items)
    ? error.payload.items.slice(0, 5).map((item) => {
        if (!item || typeof item !== 'object') return '';
        const record = item as Record<string, unknown>;
        const fragments = Array.isArray(record.missingFragments)
          ? record.missingFragments.slice(0, 3).map((fragment) => {
              if (!fragment || typeof fragment !== 'object') return '';
              return String((fragment as Record<string, unknown>).value || '');
            }).filter(Boolean)
          : [];
        return `${String(record.pathLabel || record.id)}：缺少 ${Number(record.missingCount) || 0} 项${fragments.length ? `（${fragments.join('、')}）` : ''}`;
      }).filter(Boolean)
    : [];
  const total = Number(error.payload.total) || items.length;
  const detail = items.length
    ? `\n\n${items.join('\n')}${total > items.length ? `\n……另有 ${total - items.length} 条` : ''}`
    : '';
  return `${fallback}\n${error.message}${detail}\n\n确认后会按当前人工译文保存为已通过，并记录与当前译文绑定的确认；以后再次修改时会重新询问。`;
}
