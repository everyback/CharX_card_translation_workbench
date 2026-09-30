import type { AsyncDatabase } from '../async-db.js';
import { deriveWorkflow, type WorkflowCounts, type WorkflowJob } from '../../shared/workflow-progress.js';

/** Batch projection shared by list and detail endpoints, without mutating state on reads. */
export async function readWorkflowProgress(database: AsyncDatabase, projectId?: string) {
  const filter = projectId ? 'WHERE p.id = ?' : '';
  const params = projectId ? [projectId] : [];
  const rows = await database.prepare<WorkflowCounts & { id: string; storedStatus: string; scope: string }>(`
    SELECT p.id, p.status AS storedStatus, p.scope, COUNT(s.id) AS total,
      COALESCE(SUM(CASE WHEN s.included=1 AND s.path_label <> '$module.namespace' AND s.review_status IN ('untranslated','rejected') THEN 1 ELSE 0 END),0) AS untranslated,
      COALESCE(SUM(CASE WHEN s.review_status='pending' THEN 1 ELSE 0 END),0) AS pending,
      COALESCE(SUM(CASE WHEN s.review_status='pending' AND s.path_label <> '$module.namespace' AND LENGTH(TRIM(COALESCE(NULLIF(TRIM(s.final_text),''),s.translated_text,'')))>0 THEN 1 ELSE 0 END),0) AS reviewable,
      COALESCE(SUM(CASE WHEN s.review_status='approved' AND LENGTH(TRIM(COALESCE(NULLIF(TRIM(s.final_text),''),s.translated_text,'')))>0 THEN 1 ELSE 0 END),0) AS approved
    FROM projects p LEFT JOIN segments s ON s.project_id=p.id AND s.in_scope=1
    ${filter} GROUP BY p.id
  `).all(...params);
  const jobs = await database.prepare<WorkflowJob & { projectId: string }>(`
    SELECT * FROM (
      SELECT j.project_id AS projectId, j.status, j.scope, j.total_items AS totalItems,
        j.completed_items AS completedItems, j.failed_items AS failedItems,
        j.post_total_items AS postTotalItems, j.post_completed_items AS postCompletedItems, j.post_failed_items AS postFailedItems,
        ROW_NUMBER() OVER (PARTITION BY p.id ORDER BY CASE WHEN j.status IN ('queued','running','paused') THEN 0 ELSE 1 END, j.created_at DESC, j.rowid DESC) AS position
      FROM projects p JOIN jobs j ON j.project_id=p.id
        AND (j.scope=p.scope OR j.status IN ('queued','running','paused')) ${filter}
    ) WHERE position=1
  `).all(...params);
  const byProject = new Map(jobs.map(job => [job.projectId, job]));
  return new Map(rows.map(row => {
    const counts = { total: row.total, untranslated: row.untranslated, pending: row.pending, reviewable: row.reviewable, approved: row.approved };
    const job = byProject.get(row.id);
    return [row.id, { storedStatus: row.storedStatus, workflowCounts: counts,
      status: deriveWorkflow(row.storedStatus, row.scope, counts, job ? [job] : []).status }];
  }));
}
