import type { ProjectDetail } from '@/shared/types';
import { countWorkflowSegments, deriveWorkflow } from '../../../../shared/workflow-progress.js';

export function workflowState(project: ProjectDetail) {
  const counts = project.segments.length === (project.scanSummary?.totalSegments ?? project.segments.length)
    ? countWorkflowSegments(project.segments)
    : project.workflowCounts ?? countWorkflowSegments(project.segments);
  return deriveWorkflow(project.storedStatus ?? project.status, project.scope, counts, project.jobs);
}
