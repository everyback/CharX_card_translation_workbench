import { useCallback, useEffect, useRef, useState } from 'react';
import { api, jsonBody } from '@/shared/api/http';
import { workflowState } from './workflow-state';
import type { Job, ProjectDetail, Settings, ScopePreset } from '@/shared/types';
import type { RunWorkbenchAction, ShowUiConfirm, ShowWorkbenchError } from '@/shared/model/workbench-actions';

interface UseTranslationTasksOptions {
  project: ProjectDetail | null;
  scope: ScopePreset;
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
  scope,
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
  selectedProjectIdRef.current = selectedProjectId;
  const jobRequestRef = useRef(0);
  const clearJobDetail = useCallback(() => setJobDetail(null), []);

  const loadJob = useCallback(async (jobId: string, expectedProjectId = selectedProjectIdRef.current) => {
    const request = ++jobRequestRef.current;
    const detail = await api<Job>(`/api/jobs/${jobId}`);
    if (request !== jobRequestRef.current || selectedProjectIdRef.current !== expectedProjectId || detail.projectId !== expectedProjectId) return;
    setJobDetail(detail);
  }, []);

  const startTranslation = useCallback(async () => {
    if (!project) return;
    const workflow = workflowState(project);
    if (workflow.active && workflow.active.status !== 'paused') {
      onShowJobs();
      return;
    }
    if (scope !== project.scope || project.status === 'new') {
      onNotice('翻译范围已变化，请先按所选范围重新扫描。已有译文和审核记录会保留。');
      return;
    }
    if (!workflow.canStart) {
      onShowJobs();
      onNotice('当前没有待执行的翻译项，请按引导检查审核结果或扫描范围。');
      return;
    }
    if (!settings?.apiKeyConfigured || !settings.model) {
      onOpenSettings();
      return;
    }

    const latestJob = workflow.latest;
    const followUpAction = workflow.retryAction;
    const resumeAction = workflow.resumable && latestJob && latestJob.scope === project.scope
      ? 'resume'
      : null;
    await runAction('start', async () => {
      const action = followUpAction || resumeAction;
      const job = action
        ? await api<Job>(`/api/jobs/${latestJob!.id}/${action}`, { method: 'POST', ...jsonBody({}) })
        : await api<Job>(`/api/projects/${project.id}/jobs`, { method: 'POST', ...jsonBody({ scope }) });
      if (selectedProjectIdRef.current !== project.id) return;
      jobRequestRef.current += 1;
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
  }, [onNotice, onOpenSettings, onShowJobs, project, scope, refreshProject, refreshProjects, runAction, settings]);

  const jobAction = useCallback(async (
    jobId: string,
    action: 'pause' | 'resume' | 'retry-failed' | 'rerun-postprocessing' | 'cancel',
  ) => {
    const expectedProjectId = selectedProjectIdRef.current;
    jobRequestRef.current += 1;
    await runAction(action, async () => {
      const detail = await api<Job>(`/api/jobs/${jobId}/${action}`, { method: 'POST', ...jsonBody({}) });
      if (selectedProjectIdRef.current === expectedProjectId && detail.projectId === expectedProjectId) {
        jobRequestRef.current += 1;
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

    let changed = false;
    await runAction('retranslate', async () => {
      const job = await api<Job>(`/api/projects/${project.id}/retranslate`, {
        method: 'POST',
        ...jsonBody({ segmentIds: uniqueIds }),
      });
      changed = true;
      if (selectedProjectIdRef.current !== project.id) return;
      jobRequestRef.current += 1;
      setJobDetail(job);
      onNotice(`已清空 ${selected.length} 条结果并重新加入翻译队列。`);
      onShowJobs();
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
    return changed;
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
    jobRequestRef.current += 1;
    setJobDetail((current) => current && current.projectId === selectedProjectId ? current : null);
  }, [selectedProjectId]);

  useEffect(() => {
    // Keep the selected job fresh, including its final response after a pause
    // or completion. Polling the active job must not replace a history selection.
    const jobId = project?.id === selectedProjectId ? jobDetail?.id ?? project.jobs[0]?.id : undefined;
    if (!jobId) return;
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        await loadJob(jobId, selectedProjectId);
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
  }, [jobDetail?.id, loadJob, onError, project?.id, project?.jobs[0]?.id, selectedProjectId]);

  return {
    jobDetail,
    clearJobDetail,
    loadJob,
    startTranslation,
    jobAction,
    retranslateSegments,
  };
}
