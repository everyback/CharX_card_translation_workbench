import type { Dispatch, SetStateAction } from 'react';
import { ApiError, api, jsonBody } from '@/shared/api/http';
import type { ProjectDetail, ReviewFocus, Segment } from '@/shared/types';
import {
  isLanguageConfirmationRequired,
  isProtectionConfirmationRequired,
  languageConfirmationPrompt,
  protectionConfirmationPrompt,
  sameReviewProblemFamily,
} from '../lib/review-alerts';
import { integrityIssueDestination } from '../lib/review-navigation';
import type { RunWorkbenchAction, ShowUiConfirm } from '@/shared/model/workbench-actions';

interface UseReviewActionsOptions {
  project: ProjectDetail | null;
  selectedProjectId: string;
  selectedSegmentId: string;
  setProject: Dispatch<SetStateAction<ProjectDetail | null>>;
  setSelectedSegmentId: Dispatch<SetStateAction<string>>;
  refreshProject: (projectId: string) => Promise<void>;
  refreshProjects: (syncSettings?: boolean) => Promise<void>;
  runAction: RunWorkbenchAction;
  showUiConfirm: ShowUiConfirm;
  onNotice: (notice: string) => void;
  onShowReview: () => void;
  onOpenLuaManagement: () => void;
  onFocusReview: (focus: ReviewFocus) => void;
  onClearReviewFocus: () => void;
}

interface ApplyProjectResult {
  ignoredLuaSegments: number;
  runtimeAliasAdditions: number;
  runtimeAliasTranslationError?: string;
  runtimeAliasSegmentationError?: string;
}

export function useReviewActions({
  project,
  selectedProjectId,
  selectedSegmentId,
  setProject,
  setSelectedSegmentId,
  refreshProject,
  refreshProjects,
  runAction,
  showUiConfirm,
  onNotice,
  onShowReview,
  onOpenLuaManagement,
  onFocusReview,
  onClearReviewFocus,
}: UseReviewActionsOptions) {
  const selectedSegment = project?.segments.find((segment) => segment.id === selectedSegmentId) ?? null;

  function aliasFailures(result: ApplyProjectResult): string[] {
    return [result.runtimeAliasTranslationError, result.runtimeAliasSegmentationError]
      .filter((value): value is string => Boolean(value?.trim()));
  }

  function isRegexCoverageBlocker(error: unknown): error is ApiError {
    return error instanceof ApiError && error.payload.code === 'REGEX_MATCH_COUNT_CHANGED';
  }

  async function chooseLuaFallback(message: string, kind: 'regex' | 'alias' = 'regex'): Promise<boolean> {
    const detail = kind === 'regex'
      ? '选择“跳过并继续”会只对当前检测到的正则命中差异建立精确豁免，其他 Lua 语法、模板和脚本完整性检查仍会保留。'
      : '选择“跳过并继续”会跳过本次别名自动处理并继续保存/导出；其他 Lua 语法、模板和脚本完整性检查仍会保留。';
    const skip = await showUiConfirm({
      title: 'Lua 自动处理未完成',
      message: `${message}\n\n模型已经无法继续处理。${detail}选择“去 脚本管理检查”可人工检查后再保存。`,
      confirmLabel: kind === 'regex' ? '跳过并继续' : '跳过别名并继续',
      cancelLabel: '去 脚本管理检查',
      tone: 'warning',
    });
    if (!skip) onOpenLuaManagement();
    return skip;
  }

  async function forceRegexValidation(): Promise<number> {
    const result = await api<{ forcedCount: number }>(`/api/projects/${project?.id || selectedProjectId}/lua/regex-validation/force-pass`, {
      method: 'POST',
      ...jsonBody({}),
    });
    return Number(result.forcedCount) || 0;
  }

  async function applyWithLuaFallback(navigateOnError: boolean): Promise<ApplyProjectResult | null> {
    if (!project) return null;
    let regexSkipAttempted = false;
    let aliasPrompted = false;
    while (true) {
      try {
        const result = await api<ApplyProjectResult>(`/api/projects/${project.id}/apply`, {
          method: 'POST',
          ...jsonBody({}),
        });
        const failures = aliasFailures(result);
        if (navigateOnError && failures.length && !aliasPrompted) {
          aliasPrompted = true;
          const skip = await chooseLuaFallback(`运行时名称别名自动处理失败：${failures.join('；')}`, 'alias');
          if (!skip) return null;
          onNotice('已按确认跳过本次别名自动处理；其余 Lua 和卡片完整性检查仍会继续。');
        }
        return result;
      } catch (error) {
        if (navigateOnError && !regexSkipAttempted && isRegexCoverageBlocker(error)) {
          regexSkipAttempted = true;
          const skip = await chooseLuaFallback(
            `${String(error.payload.pathLabel || 'Lua 正则')} 命中数由 ${String(error.payload.originalMatches ?? '?')} 变为 ${String(error.payload.draftMatches ?? '?')}。`,
          );
          if (!skip) return null;
          const forcedCount = await forceRegexValidation();
          onNotice(forcedCount
            ? `已为 ${forcedCount} 条当前正则命中差异建立精确豁免，正在重新执行 Lua 检测。`
            : '没有找到仍然失配的正则规则，正在重新执行 Lua 检测。');
          continue;
        }
        throw error;
      }
    }
  }

  async function updateSegment(
    segmentId: string,
    changes: Partial<Pick<Segment, 'finalText' | 'reviewStatus' | 'included'>>,
  ) {
    const expectedProjectId = selectedProjectId;
    await runAction('segment-update', async () => {
      const confirmations = { language: false, protection: false };
      const update = () => api<Segment>(`/api/segments/${segmentId}`, {
        method: 'PATCH',
        ...jsonBody({
          ...changes,
          ...(confirmations.language ? { confirmLanguageIssue: true } : {}),
          ...(confirmations.protection ? { confirmProtectionIssue: true } : {}),
        }),
      });
      let updated: Segment | null = null;
      const confirmedLabels: string[] = [];
      while (!updated) {
        try {
          updated = await update();
        } catch (updateError) {
          if (updateError instanceof ApiError && typeof updateError.payload.qaFlag === 'string') {
            const qaFlag = updateError.payload.qaFlag;
            setProject((current) => current ? {
              ...current,
              segments: current.segments.map((segment) => segment.id === segmentId
                ? { ...segment, qaFlags: [...segment.qaFlags.filter((flag) => !sameReviewProblemFamily(flag, qaFlag)), qaFlag] }
                : segment),
            } : current);
          }
          if (changes.reviewStatus === 'approved'
            && isLanguageConfirmationRequired(updateError)
            && !confirmations.language) {
            if (!await showUiConfirm({
              title: '卡片语言设定需要确认',
              message: languageConfirmationPrompt(updateError, `审核项“${selectedSegment?.pathLabel || segmentId}”需要确认`),
              confirmLabel: '保留并通过',
              tone: 'warning',
            })) return;
            confirmations.language = true;
            confirmedLabels.push('卡片语言设定');
            continue;
          }
          if (changes.reviewStatus === 'approved'
            && isProtectionConfirmationRequired(updateError)
            && !confirmations.protection) {
            if (!await showUiConfirm({
              title: '受保护内容变更需要确认',
              message: `${updateError.message}\n\n确认只对当前人工定稿有效；后续再次修改文字时需要重新确认。`,
              confirmLabel: '确认变更并通过',
              tone: 'warning',
            })) return;
            confirmations.protection = true;
            confirmedLabels.push('受保护内容变更');
            continue;
          }
          throw updateError;
        }
      }
      if (confirmedLabels.length) onNotice(`已确认${confirmedLabels.join('和')}，并通过审核。`);
      setProject((current) => current ? {
        ...current,
        segments: current.segments.map((segment) => segment.id === segmentId ? updated : segment),
      } : current);
      if (expectedProjectId) {
        await Promise.all([refreshProject(expectedProjectId), refreshProjects()]);
      }
    });
  }

  async function approveSafe() {
    if (!project) return;
    await runAction('approve-safe', async () => {
      const confirmations = { language: false, protection: false };
      const approve = () => api<{ approved: number; skipped: number }>(`/api/projects/${project.id}/approve-safe`, {
        method: 'POST',
        ...jsonBody({
          ...(confirmations.language ? { confirmLanguageIssues: true } : {}),
          ...(confirmations.protection ? { confirmProtectionIssues: true } : {}),
        }),
      });
      let result: { approved: number; skipped: number } | null = null;
      while (!result) {
        try {
          result = await approve();
        } catch (approveError) {
          if (isLanguageConfirmationRequired(approveError) && !confirmations.language) {
            if (!await showUiConfirm({
              title: '批量审核需要确认',
              message: languageConfirmationPrompt(approveError, '低疑点批量审核中发现需要确认的卡片语言设定'),
              confirmLabel: '保留并通过',
              tone: 'warning',
            })) return;
            confirmations.language = true;
            continue;
          }
          if (isProtectionConfirmationRequired(approveError) && !confirmations.protection) {
            if (!await showUiConfirm({
              title: '批量受保护内容变更需要确认',
              message: protectionConfirmationPrompt(approveError, '低疑点批量审核中发现受保护内容变更'),
              confirmLabel: '确认并通过',
              tone: 'warning',
            })) return;
            confirmations.protection = true;
            continue;
          }
          throw approveError;
        }
      }
      onNotice(result.skipped
        ? `已通过 ${result.approved} 条；仍有 ${result.skipped} 条因协议结构无效或残留源语言而未通过。`
        : `已通过 ${result.approved} 条低疑点译文${result.approved ? '' : '（没有可通过项）'}。`);
      await refreshProject(project.id);
    });
  }

  async function approveAll() {
    if (!project) return;
    const pending = project.segments.filter((segment) => (
      segment.reviewStatus === 'pending'
      && Boolean(segment.finalText?.trim() || segment.translatedText?.trim())
    ));
    if (!pending.length) return;
    const needsAttention = pending.filter((segment) => segment.riskLevel !== 'low' || segment.qaFlags.length > 0).length;
    const warning = needsAttention
      ? `\n其中 ${needsAttention} 条属于高疑点或带质量警告。`
      : '';
    if (!await showUiConfirm({
      title: '确认批量通过译文',
      message: `请确认 ${pending.length} 条已有译文都可以通过审核。${warning}\n此操作不会通过未翻译项。`,
      confirmLabel: '确认并通过全部',
      tone: needsAttention ? 'warning' : 'default',
    })) return;
    await runAction('approve-all', async () => {
      const confirmations = { language: false, protection: false };
      const approve = () => api<{ approved: number; skipped: number }>(`/api/projects/${project.id}/approve-all`, {
        method: 'POST',
        ...jsonBody({
          ...(confirmations.language ? { confirmLanguageIssues: true } : {}),
          ...(confirmations.protection ? { confirmProtectionIssues: true } : {}),
        }),
      });
      let result: { approved: number; skipped: number } | null = null;
      while (!result) {
        try {
          result = await approve();
        } catch (approveError) {
          if (isLanguageConfirmationRequired(approveError) && !confirmations.language) {
            if (!await showUiConfirm({
              title: '批量审核需要确认',
              message: languageConfirmationPrompt(approveError, '批量审核中发现需要确认的卡片语言设定'),
              confirmLabel: '保留并通过',
              tone: 'warning',
            })) return;
            confirmations.language = true;
            continue;
          }
          if (isProtectionConfirmationRequired(approveError) && !confirmations.protection) {
            if (!await showUiConfirm({
              title: '批量受保护内容变更需要确认',
              message: protectionConfirmationPrompt(approveError, '批量审核中发现受保护内容变更'),
              confirmLabel: '确认并通过',
              tone: 'warning',
            })) return;
            confirmations.protection = true;
            continue;
          }
          throw approveError;
        }
      }
     onNotice(result.skipped
       ? `已通过 ${result.approved} 条；仍有 ${result.skipped} 条因协议结构无效或残留源语言而未通过。`
        : `已通过全部 ${result.approved} 条已有译文。下一步请点击“保存并导出”，完成校验后下载卡片。`);
      await refreshProject(project.id);
    });
  }

  async function reviewBulk(action: 'copy-machine' | 'clear-manual', segmentIds: string[]) {
    if (!project || !segmentIds.length) return;
    await runAction('review-bulk', async () => {
      await api(`/api/projects/${project.id}/review-bulk`, {
        method: 'POST', ...jsonBody({ action, segmentIds }),
      });
      onNotice(action === 'copy-machine' ? `已载入 ${segmentIds.length} 条机器译文，等待审核。` : `已清除 ${segmentIds.length} 条人工定稿。`);
      await refreshProject(project.id);
    });
  }

  async function clearAllTranslationResults() {
    if (!project) return;
    const resultCount = project.segments.filter((segment) => (
      segment.reviewStatus !== 'untranslated'
      || Boolean(segment.translationError)
      || Boolean(segment.finalText?.trim() || segment.translatedText?.trim())
    )).length;
    if (!resultCount) return;
    if (!await showUiConfirm({
      title: '删除全部翻译结果',
      message: `确认删除当前项目全部 ${resultCount} 条翻译、人工定稿和审核结果？\n卡片正文和资源审核稿会恢复为原始内容，但 Lua 草稿不受影响；此操作不可撤销。`,
      confirmLabel: '全部删除',
      tone: 'danger',
    })) return;

    await runAction('clear-results', async () => {
      const result = await api<{ cleared: number }>(`/api/projects/${project.id}/clear-results`, {
        method: 'POST',
        ...jsonBody({}),
      });
      setSelectedSegmentId('');
      onNotice(`已删除全部 ${result.cleared} 条翻译结果；卡片正文和资源草稿已恢复，Lua 草稿保持不变。`);
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
  }

  async function applyDraft() {
    if (!project) return;
    await runAction('apply', async () => {
      try {
        const result = await applyWithLuaFallback(true);
        if (!result) return;
        const failures = aliasFailures(result);
        onNotice(result.ignoredLuaSegments > 0
          ? `审核稿已保存并通过 Lua 语法校验；已忽略 ${result.ignoredLuaSegments} 条会改动 Lua 代码的旧扫描译文。${failures.length ? ' 别名自动处理未完成，已按确认继续。' : ''}`
          : failures.length ? '审核稿已保存；别名自动处理未完成，已按确认继续，其余完整性校验已完成。'
            : result.runtimeAliasAdditions > 0
              ? `审核稿已保存，并通过 Risu Lua 语法校验；已自动补充 ${result.runtimeAliasAdditions} 个名称别名。`
              : '审核稿已保存，并通过 Risu Lua 语法校验。');
        await Promise.all([refreshProject(project.id), refreshProjects()]);
        onClearReviewFocus();
      } catch (applyError) {
        focusIntegrityIssue(applyError);
        throw applyError;
      }
    });
  }

  async function applyDraftQuiet() {
    if (!project) return;
    await runAction('apply', async () => {
      try {
        await api(`/api/projects/${project.id}/apply`, { method: 'POST', ...jsonBody({}) });
        onNotice('Lua 修改已保存，完整性校验已重新执行。');
        await Promise.all([refreshProject(project.id), refreshProjects()]);
        onClearReviewFocus();
      } catch (error) {
        focusIntegrityIssue(error, false);
        throw error;
      }
    });
  }

  async function saveAndExport(navigateOnError = true) {
    if (!project) return;
    await runAction('apply-export', async () => {
      try {
        const result = await applyWithLuaFallback(navigateOnError);
        if (!result) return;
        const failures = aliasFailures(result);
        let response: Response;
        let exportRegexSkipAttempted = false;
        while (true) {
          response = await fetch('/api/projects/' + project.id + '/export');
          if (response.ok) break;
          const body = await response.json().catch(() => ({ error: response.statusText })) as Record<string, unknown>;
          const exportError = new ApiError(String(body.error || '请求失败：' + response.status), response.status, body);
          if (navigateOnError && !exportRegexSkipAttempted && isRegexCoverageBlocker(exportError)) {
            exportRegexSkipAttempted = true;
            const skip = await chooseLuaFallback(
              `${String(exportError.payload.pathLabel || 'Lua 正则')} 命中数由 ${String(exportError.payload.originalMatches ?? '?')} 变为 ${String(exportError.payload.draftMatches ?? '?')}。`,
            );
            if (!skip) return;
            const forcedCount = await forceRegexValidation();
            onNotice(forcedCount
              ? `已为 ${forcedCount} 条当前正则命中差异建立精确豁免，正在重试导出。`
              : '没有找到仍然失配的正则规则，正在重试导出。');
            continue;
          }
          throw exportError;
        }
        const disposition = response.headers.get('Content-Disposition') || '';
        const encodedFilename = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
        const plainFilename = disposition.match(/filename="([^"]+)"/i)?.[1];
        let filename = plainFilename || 'translated-card';
        if (encodedFilename) {
          try {
            filename = decodeURIComponent(encodedFilename);
          } catch {
            // Keep the server fallback name when a malformed header cannot be decoded.
          }
        }
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
        onNotice(result.ignoredLuaSegments > 0
          ? '审核稿已保存，已通过导出前语法检查并开始下载；已忽略 ' + result.ignoredLuaSegments + ' 条会改动 Lua 代码的旧扫描译文。'
          : failures.length
            ? '审核稿已保存，已按确认跳过别名自动处理并开始下载。'
            : result.runtimeAliasAdditions > 0
              ? `审核稿已保存，已自动补充 ${result.runtimeAliasAdditions} 个名称别名并开始下载。`
              : '审核稿已保存，已通过导出前语法检查并开始下载。');
        await Promise.all([refreshProject(project.id), refreshProjects()]);
        onClearReviewFocus();
      } catch (exportError) {
        focusIntegrityIssue(exportError, navigateOnError);
        throw exportError;
      }
    });
  }

  function focusIntegrityIssue(error: unknown, navigate = true): void {
    if (!(error instanceof ApiError)) return;
    const pathLabel = String(error.payload.pathLabel || '正则协议');
    const originalMatches = Number(error.payload.originalMatches);
    const draftMatches = Number(error.payload.draftMatches);
    const segmentIds = Array.isArray(error.payload.affectedSegmentIds)
      ? error.payload.affectedSegmentIds.map(String).filter(Boolean)
      : [];
    const destination = integrityIssueDestination(error.payload, error.message);
    if (!segmentIds.length && destination !== 'lua') return;
    onFocusReview({
      pathLabel,
      pattern: String(error.payload.pattern || ''),
      ...(Number.isFinite(originalMatches) && Number.isFinite(draftMatches) ? { originalMatches, draftMatches } : {}),
      ...(Number.isFinite(Number(error.payload.line)) ? { line: Number(error.payload.line) } : {}),
      ...(Number.isFinite(Number(error.payload.column)) ? { column: Number(error.payload.column) } : {}),
      ...(typeof error.payload.sourceLine === 'string' ? { sourceLine: error.payload.sourceLine } : {}),
      ...(typeof error.payload.draftLine === 'string' ? { draftLine: error.payload.draftLine } : {}),
      segmentIds,
      problem: String(error.payload.problem || `${pathLabel} 的正则实际命中数由 ${originalMatches} 变为 ${draftMatches}，当前稿中有部分文本不再符合该正则的输入格式。`),
      fixSuggestion: String(error.payload.fixSuggestion || '翻译阶段会结合本卡片的原文、译文和正则上下文，由模型判断是否需要追加目标语言并列项；只追加模型确认的字面量，不会删除或重排原有规则。若模型判断不确定或命中数仍不一致，请在右侧“人工定稿”框对照左侧原文，保留同样的引号、空格、键名、分隔符和字段顺序后再保存。'),
    });
    if (navigate) {
      if (destination === 'lua') onOpenLuaManagement();
      else onShowReview();
    }
    const targetPage = destination === 'lua' ? '脚本管理页' : '审核页';
    onNotice(destination === 'lua'
      ? `已提取脚本错误位置：${pathLabel}。请在${targetPage}展开对应项后人工修改并重新校验。`
      : Number.isFinite(originalMatches) && Number.isFinite(draftMatches)
        ? `已定位 ${segmentIds.length} 条受影响文本：${pathLabel} 命中数 ${originalMatches} → ${draftMatches}。请按${targetPage}中的修正方案逐条处理后再保存。`
        : `已过滤 ${segmentIds.length} 条错误行：${pathLabel}。请按${targetPage}中的修正方案逐条处理后再保存。`);
  }

  return {
    selectedSegment,
    updateSegment,
    approveSafe,
    approveAll,
    reviewBulk,
    clearAllTranslationResults,
    applyDraft,
    applyDraftQuiet,
    saveAndExport,
  };
}
