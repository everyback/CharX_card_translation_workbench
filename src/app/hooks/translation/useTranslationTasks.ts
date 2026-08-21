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
    await runAction('start', async () => {
      const job = await api<Job>(`/api/projects/${project.id}/jobs`, { method: 'POST', ...jsonBody({}) });
      setJobDetail(job);
      onShowJobs();
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
  }, [onOpenSettings, onShowJobs, project, refreshProject, refreshProjects, runAction, settings]);

  const jobAction = useCallback(async (
    jobId: string,
    action: 'pause' | 'resume' | 'retry-failed' | 'cancel',
  ) => {
    const expectedProjectId = selectedProjectIdRef.current;
    await runAction(action, async () => {
      const detail = await api<Job>(`/api/jobs/${jobId}/${action}`, { method: 'POST', ...jsonBody({}) });
      if (selectedProjectIdRef.current === expectedProjectId && detail.projectId === expectedProjectId) {
        setJobDetail(detail);
      }
      await Promise.all([refreshProject(expectedProjectId), refreshProjects()]);
    });
  }, [refreshProject, refreshProjects, runAction]);

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
