import { useCallback, useEffect, useRef, useState } from 'react';
import { api, jsonBody } from '../../../api';
import type { Job, ProjectDetail, Settings } from '../../../types';
import type { RunWorkbenchAction, ShowUiConfirm, ShowWorkbenchError } from '../contracts';

interface UseTranslationTasksOptions {
  project: ProjectDetail | null;
  selectedProjectId: string;
  settings: Settings | null;
  refreshProject: (projectId: string) => Promise<void>;
  refreshProjects: (syncSettings?: boolean) => Promise<void>;
  runAction: RunWorkbenchAction;
  showUiConfirm: ShowUiConfirm;
  onError: ShowWorkbenchError;
  onNotice: (notice: string) => void;
  onOpenSettings: () => void;
  onShowJobs: () => void;
}

export function useTranslationTasks({
  project,
  selectedProjectId,
  settings,
  refreshProject,
  refreshProjects,
  runAction,
  showUiConfirm,
  onError,
  onNotice,
  onOpenSettings,
  onShowJobs,
}: UseTranslationTasksOptions) {
  const [jobDetail, setJobDetail] = useState<Job | null>(null);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const clearJobDetail = useCallback(() => setJobDetail(null), []);

  const loadJob = useCallback(async (jobId: string, expectedProjectId = selectedProjectIdRef.current) => {
    const detail = await api<Job>(`/api/jobs/${jobId}`);
    if (selectedProjectIdRef.current !== expectedProjectId || detail.projectId !== expectedProjectId) return;
    setJobDetail(detail);
  }, []);

  const startTranslation = useCallback(async () => {
    if (!project) return;
    if (!settings?.apiKeyConfigured || !settings.model) {
      onOpenSettings();
      return;
    }

    const latestJob = project.jobs[0];
    const hasPendingSegments = project.segments.some((segment) => (
      segment.included && ['untranslated', 'rejected'].includes(segment.reviewStatus)
    ));
    if (latestJob && ['queued', 'running'].includes(latestJob.status)) {
      onShowJobs();
      onNotice('当前翻译任务仍在进行中，已打开任务进度。');
      return;
    }

    // The top-level button also controls the follow-up stage. Once the text
    // queue is empty, reuse the latest completed job instead of creating an
    // empty text-translation job that would fail with "没有待翻译段落".
    const postTotal = latestJob ? Math.max(0, latestJob.postTotalItems ?? 0) : 0;
    const postCompleted = latestJob ? Math.max(0, latestJob.postCompletedItems ?? 0) : 0;
    const postFailed = latestJob ? Math.max(0, latestJob.postFailedItems ?? 0) : 0;
    const followUpNeedsRetry = postFailed > 0 || (postTotal > 0 && postCompleted < postTotal);
    const followUpAction: 'retry-failed' | 'rerun-postprocessing' | null = !hasPendingSegments && latestJob?.status === 'review' && followUpNeedsRetry
      ? 'rerun-postprocessing'
      : !hasPendingSegments && latestJob?.status === 'review_with_errors' && (followUpNeedsRetry || latestJob.failedItems > 0)
        ? 'retry-failed'
        : null;
    if (!hasPendingSegments && latestJob && ['review', 'review_with_errors'].includes(latestJob.status) && !followUpAction) {
      onShowJobs();
      onNotice('当前翻译和阶段 2 均已完成，没有需要重复执行的内容。');
      return;
    }
    const resumeAction = latestJob && ['paused', 'failed', 'cancelled'].includes(latestJob.status)
      ? 'resume'
      : null;
    await runAction('start', async () => {
      const action = followUpAction || resumeAction;
      const job = action
        ? await api<Job>(`/api/jobs/${latestJob!.id}/${action}`, { method: 'POST', ...jsonBody({}) })
        : await api<Job>(`/api/projects/${project.id}/jobs`, { method: 'POST', ...jsonBody({}) });
      setJobDetail(job);
      if (action === 'rerun-postprocessing') {
        onNotice('已从顶部按钮启动阶段 2：正文译文保持不变，开始处理 Lua 正则与关键词适配。');
      } else if (action === 'retry-failed') {
        onNotice('已从顶部按钮重试失败项与阶段 2。');
      } else if (action === 'resume') {
        onNotice('已从顶部按钮继续翻译：未完成段落会从上次中断处继续处理。');
      }
      onShowJobs();
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
  }, [onNotice, onOpenSettings, onShowJobs, project, refreshProject, refreshProjects, runAction, settings]);

  const jobAction = useCallback(async (
    jobId: string,
    action: 'pause' | 'resume' | 'retry-failed' | 'rerun-postprocessing' | 'cancel',
  ) => {
    const expectedProjectId = selectedProjectIdRef.current;
    await runAction(action, async () => {
      const detail = await api<Job>(`/api/jobs/${jobId}/${action}`, { method: 'POST', ...jsonBody({}) });
      if (selectedProjectIdRef.current === expectedProjectId && detail.projectId === expectedProjectId) {
        setJobDetail(detail);
      }
      if (action === 'retry-failed') {
        onNotice('已重新加入重试队列：失败段落和阶段 2 的 Lua/关键词适配会再次处理。');
      } else if (action === 'rerun-postprocessing') {
        onNotice('已重新执行阶段 2：正文译文保持不变，只复核 Lua 正则与关键词适配。');
      } else if (action === 'resume') {
        onNotice('已继续翻译：未完成段落会从上次中断处继续处理。');
      }
      await Promise.all([refreshProject(expectedProjectId), refreshProjects()]);
    });
  }, [onNotice, refreshProject, refreshProjects, runAction]);

  const retranslateSegments = useCallback(async (segmentIds: string[]) => {
    if (!project || !segmentIds.length) return;
    if (!settings?.apiKeyConfigured || !settings.model) {
      onOpenSettings();
      return;
    }
    const uniqueIds = [...new Set(segmentIds)];
    const selectedIds = new Set(uniqueIds);
    const selected = project.segments.filter((segment) => selectedIds.has(segment.id));
    const manualCount = selected.filter((segment) => Boolean(segment.finalText?.trim())).length;
    const approvedCount = selected.filter((segment) => segment.reviewStatus === 'approved').length;
    const warning = [
      manualCount ? `其中 ${manualCount} 条包含人工定稿。` : '',
      approvedCount ? `其中 ${approvedCount} 条已经通过审核。` : '',
    ].filter(Boolean).join('\n');
    if (!await showUiConfirm({
      title: '删除结果并重新翻译',
      message: `确认删除 ${selected.length} 条现有结果并立即重新翻译？${warning ? `\n${warning}` : ''}\n原文和项目文件不会被删除。`,
      confirmLabel: '删除并重新翻译',
      tone: 'danger',
    })) return;

    await runAction('retranslate', async () => {
      const job = await api<Job>(`/api/projects/${project.id}/retranslate`, {
        method: 'POST',
        ...jsonBody({ segmentIds: uniqueIds }),
      });
      setJobDetail(job);
      onNotice(`已清空 ${selected.length} 条结果并重新加入翻译队列。`);
      onShowJobs();
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
  }, [
    onNotice,
    onOpenSettings,
    onShowJobs,
    project,
    refreshProject,
    refreshProjects,
    runAction,
    settings,
    showUiConfirm,
  ]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
    setJobDetail((current) => current && current.projectId === selectedProjectId ? current : null);
  }, [selectedProjectId]);

  useEffect(() => {
    const active = project?.id === selectedProjectId
      ? project.jobs.find((job) => ['queued', 'running'].includes(job.status))
      : undefined;
    if (!active) return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        await Promise.all([
          refreshProject(selectedProjectId),
          loadJob(active.id, selectedProjectId),
        ]);
      } catch (error) {
        onError(error);
      } finally {
        if (!stopped) timer = window.setTimeout(poll, 2500);
      }
    };
    timer = window.setTimeout(poll, 2500);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [loadJob, onError, project?.id, project?.jobs, refreshProject, selectedProjectId]);

  return {
    jobDetail,
    clearJobDetail,
    loadJob,
    startTranslation,
    jobAction,
    retranslateSegments,
  };
}
