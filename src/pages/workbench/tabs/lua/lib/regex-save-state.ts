import type { RegexRuleSaveResult } from '@/shared/types';

export function regexSaveState(result: RegexRuleSaveResult) {
  const source = result.validationSourceMatchCount ?? result.sourceMatchCount;
  const draft = result.validationDraftMatchCount ?? result.draftMatchCount;
  const passed = result.compiled && Boolean(result.dynamicDisplay || result.runtimePostprocess || result.forcePassed || source === draft);
  return { source, draft, passed, status: passed ? 'saved' as const : 'saved-with-issues' as const,
    message: passed ? '已保存到草稿。导出前仍会执行完整校验。' : `已保存到草稿；原始规则命中 ${source}，当前规则命中 ${draft}，仍需处理命中差异。` };
}
