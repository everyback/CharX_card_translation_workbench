import type { Dispatch, SetStateAction } from 'react';
import { ApiError, api, jsonBody } from '../../../api';
import type { ProjectDetail, Segment } from '../../../types';
import {
  isLanguageConfirmationRequired,
  isProtectionConfirmationRequired,
  languageConfirmationPrompt,
  protectionConfirmationPrompt,
  sameReviewProblemFamily,
} from '../../review-alerts';
import { locateLuaSyntaxSegment } from '../../review-navigation';
import type { RunWorkbenchAction, ShowUiConfirm } from '../contracts';

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
}: UseReviewActionsOptions) {
  const selectedSegment = project?.segments.find((segment) => segment.id === selectedSegmentId) ?? null;

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
      title: '通过全部已有译文',
      message: `确认通过全部 ${pending.length} 条已有译文的待审核项？${warning}\n此操作不会通过未翻译项。`,
      confirmLabel: '全部通过',
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
        : `已通过全部 ${result.approved} 条已有译文。`);
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
      message: `确认删除当前项目全部 ${resultCount} 条翻译、人工定稿和审核结果？\n已生成的审核稿也会恢复为原始卡内容，此操作不可撤销。`,
      confirmLabel: '全部删除',
      tone: 'danger',
    })) return;

    await runAction('clear-results', async () => {
      const result = await api<{ cleared: number }>(`/api/projects/${project.id}/clear-results`, {
        method: 'POST',
        ...jsonBody({}),
      });
      setSelectedSegmentId('');
      onNotice(`已删除全部 ${result.cleared} 条翻译结果，原始卡内容保持不变。`);
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
  }

  async function applyDraft() {
    if (!project) return;
    await runAction('apply', async () => {
      try {
        const result = await api<{ ignoredLuaSegments: number }>(`/api/projects/${project.id}/apply`, {
          method: 'POST',
          ...jsonBody({}),
        });
        onNotice(result.ignoredLuaSegments > 0
          ? `审核稿已生成并通过 Lua 语法校验；已忽略 ${result.ignoredLuaSegments} 条会改动 Lua 代码的旧扫描译文。`
          : '审核稿已生成，并通过 Risu Lua 语法校验。');
        await Promise.all([refreshProject(project.id), refreshProjects()]);
      } catch (applyError) {
        const related = locateLuaSyntaxSegment(
          project.segments,
          applyError instanceof Error ? applyError.message : String(applyError),
        );
        if (related) {
          setSelectedSegmentId(related.id);
          onShowReview();
          onNotice(`已定位到最接近 Lua 报错行的审核项：${related.pathLabel}`);
        }
        throw applyError;
      }
    });
  }

  return {
    selectedSegment,
    updateSegment,
    approveSafe,
    approveAll,
    reviewBulk,
    clearAllTranslationResults,
    applyDraft,
  };
}
