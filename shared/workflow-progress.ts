export interface WorkflowCounts {
  total: number;
  untranslated: number;
  pending: number;
  reviewable: number;
  approved: number;
}

export interface WorkflowJob {
  status: string;
  scope?: string;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  postTotalItems?: number;
  postCompletedItems?: number;
  postFailedItems?: number;
}

export function deriveWorkflow<T extends WorkflowJob>(storedStatus: string, scope: string, counts: WorkflowCounts, jobs: readonly T[]) {
  const active = jobs.find(job => ['queued', 'running', 'paused'].includes(job.status));
  const latest = active ?? jobs.find(job => !job.scope || job.scope === scope);
  const postIncomplete = Boolean(latest && ((latest.postFailedItems ?? 0) > 0
    || (latest.postCompletedItems ?? 0) < (latest.postTotalItems ?? 0)));
  const hasFailures = Boolean(latest && (latest.status === 'review_with_errors' || latest.failedItems > 0 || postIncomplete));
  const resumable = Boolean(latest && ['paused', 'failed', 'cancelled'].includes(latest.status)
    && (storedStatus !== 'scanned' || latest.status === 'paused')
    && latest.totalItems > 0 && (counts.untranslated > 0 || postIncomplete || latest.status === 'paused'));
  let status: string;
  if (active) status = active.status === 'paused' ? 'paused' : 'translating';
  else if (storedStatus === 'new') status = 'new';
  else if (resumable) status = latest!.status;
  else if (hasFailures) status = 'review_with_errors';
  else if (counts.untranslated > 0) status = 'scanned';
  else if (counts.pending > 0) status = 'review';
  else if (counts.approved > 0) status = storedStatus === 'ready' ? 'ready' : 'reviewed';
  else status = 'empty';

  const stage: 'text' | 'adaptation' = latest && latest.completedItems + latest.failedItems >= latest.totalItems
    ? 'adaptation' : 'text';
  const retryAction = latest?.status === 'review' && postIncomplete ? 'rerun-postprocessing'
    : latest?.status === 'review_with_errors' ? 'retry-failed' : null;
  const canStart = counts.untranslated > 0 || resumable || Boolean(retryAction);
  const flowStep = status === 'new' ? 1
    : active || hasFailures || resumable || counts.untranslated > 0 ? 2
      : counts.pending > 0 ? 3 : counts.approved > 0 ? 4 : 1;
  return { status, stage, active, latest, counts, postIncomplete, hasFailures, resumable, retryAction, canStart, flowStep };
}

export function countWorkflowSegments(segments: readonly {
  reviewStatus: string; included: boolean; translatedText?: string | null; finalText?: string | null; pathLabel?: string;
}[]): WorkflowCounts {
  const counts = { total: segments.length, untranslated: 0, pending: 0, reviewable: 0, approved: 0 };
  for (const segment of segments) {
    const text = Boolean(segment.finalText?.trim() || segment.translatedText?.trim());
    if (segment.included && segment.pathLabel !== '$module.namespace' && ['untranslated', 'rejected'].includes(segment.reviewStatus)) counts.untranslated++;
    if (segment.reviewStatus === 'pending') {
      counts.pending++;
      if (text && segment.pathLabel !== '$module.namespace') counts.reviewable++;
    }
    if (segment.reviewStatus === 'approved' && text) counts.approved++;
  }
  return counts;
}
