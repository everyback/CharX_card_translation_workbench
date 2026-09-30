import type { AsyncDatabase } from '../../async-db.js';

/** Version and job state are checked in the same write, including after cancellation. */
export function savePostprocessingDraft(database: AsyncDatabase, input: {
  jobId: string;
  projectId: string;
  expectedUpdatedAt: string;
  updatedAt: string;
  module: Record<string, unknown>;
  card?: Record<string, unknown>;
}) {
  const cardUpdate = input.card === undefined ? '' : 'draft_json = ?, ';
  const values: unknown[] = [JSON.stringify(input.module)];
  if (input.card !== undefined) values.push(JSON.stringify(input.card));
  values.push(input.updatedAt, input.projectId, input.expectedUpdatedAt, input.jobId);
  return database.prepare(`
    UPDATE projects SET draft_module_json = ?, ${cardUpdate}updated_at = ?
    WHERE id = ? AND updated_at = ?
      AND EXISTS (SELECT 1 FROM jobs WHERE id = ? AND project_id = projects.id
        AND status IN ('queued', 'running'))
  `).run(...values);
}
