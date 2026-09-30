import type { ProjectDetail } from '@/shared/types';

export function workflowState(project: ProjectDetail) {
  const active = project.jobs.find((job) => ['queued', 'running', 'paused'].includes(job.status));
  const latest = active ?? project.jobs[0];
  const status = active
    ? active.status === 'paused' ? 'paused' : 'translating'
    : !['new', 'scanned', 'ready'].includes(project.status) && ['failed', 'cancelled'].includes(latest?.status ?? '')
      ? latest!.status
    : project.status === 'translating'
      ? latest?.status === 'failed' || latest?.status === 'cancelled' ? latest.status
        : latest?.status === 'review_with_errors' ? 'review_with_errors' : 'review'
      : project.status;
  const stage = active && active.completedItems + active.failedItems >= active.totalItems
    ? 'adaptation' : 'text';
  return { status, stage, active, latest } as const;
}
