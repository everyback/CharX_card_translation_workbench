import type { AsyncDatabase } from '../async-db.js';

export interface TranslationJobServiceDependencies {
  database: AsyncDatabase;
  createId: () => string;
  clock: () => string;
}

export interface TranslationJobService {
  jobById(jobId: string): Promise<Record<string, unknown> | undefined>;
  hasActiveTranslationJob(projectId: string): Promise<boolean>;
  existingProjectSegmentIds(projectId: string, requestedIds: readonly string[]): Promise<string[]>;
  projectResultSegmentIds(projectId: string): Promise<string[]>;
  createTranslationJob(
    projectId: string,
    scope: string,
    model: string,
    segmentIds: readonly string[],
    resetResults: boolean,
  ): Promise<string>;
  clearTranslationResults(segmentIds: readonly string[], timestamp?: string): Promise<void>;
  resolveFailedJobItems(segmentId: string, pathLabel: string): Promise<void>;
  refreshHistoricalJobsAfterScan(projectId: string, timestamp?: string): Promise<void>;
}

export function createTranslationJobService(
  { database, createId, clock }: TranslationJobServiceDependencies,
): TranslationJobService {
  async function jobById(jobId: string): Promise<Record<string, unknown> | undefined> {
    return await database.prepare(`
      SELECT
        id, project_id AS projectId, status, scope, model,
        total_items AS totalItems, completed_items AS completedItems,
        failed_items AS failedItems, last_error AS lastError,
        created_at AS createdAt, updated_at AS updatedAt
      FROM jobs WHERE id = ?
    `).get(jobId) as Record<string, unknown> | undefined;
  }

  async function hasActiveTranslationJob(projectId: string): Promise<boolean> {
    return Boolean(await database.prepare(`
      SELECT id FROM jobs
      WHERE project_id = ? AND status IN ('queued', 'running', 'paused')
      LIMIT 1
    `).get(projectId));
  }

  async function existingProjectSegmentIds(projectId: string, requestedIds: readonly string[]): Promise<string[]> {
    const requested = new Set(requestedIds);
    return (await database.prepare('SELECT id FROM segments WHERE project_id = ? ORDER BY sort_order').all(projectId) as Array<{ id: string }>)
      .map((row) => row.id)
      .filter((segmentId) => requested.has(segmentId));
  }

  async function projectResultSegmentIds(projectId: string): Promise<string[]> {
    return (await database.prepare(`
      SELECT s.id
      FROM segments s
      WHERE s.project_id = ?
        AND (
          s.translated_text IS NOT NULL
          OR s.final_text IS NOT NULL
          OR s.review_status <> 'untranslated'
          OR EXISTS (
            SELECT 1 FROM job_items ji
            WHERE ji.segment_id = s.id AND ji.status = 'failed'
          )
        )
      ORDER BY s.sort_order
    `).all(projectId) as Array<{ id: string }>).map((row) => row.id);
  }

  async function createTranslationJob(
    projectId: string,
    scope: string,
    model: string,
    segmentIds: readonly string[],
    resetResults: boolean,
  ): Promise<string> {
    const jobId = createId();
    const timestamp = clock();
    const insertItem = database.prepare(`
      INSERT INTO job_items(id, job_id, segment_id, status, attempt_count, updated_at)
      VALUES (?, ?, ?, 'pending', 0, ?)
    `);
    await database.transaction(async () => {
      if (resetResults) await clearTranslationResults(segmentIds, timestamp);
      await database.prepare(`
        INSERT INTO jobs(id, project_id, status, scope, model, total_items, created_at, updated_at)
        VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)
      `).run(jobId, projectId, scope, model, segmentIds.length, timestamp, timestamp);
      for (const segmentId of segmentIds) await insertItem.run(createId(), jobId, segmentId, timestamp);
      await database.prepare("UPDATE projects SET status = 'translating', updated_at = ? WHERE id = ?")
        .run(timestamp, projectId);
    });
    return jobId;
  }

  async function clearTranslationResults(segmentIds: readonly string[], timestamp = clock()): Promise<void> {
    const resetSegment = database.prepare(`
      UPDATE segments SET
        translated_text = NULL,
        final_text = NULL,
        review_status = 'untranslated',
        qa_flags = '[]',
        updated_at = ?
      WHERE id = ?
    `);
    const failedJobs = database.prepare(`
      SELECT DISTINCT job_id AS jobId FROM job_items
      WHERE segment_id = ? AND status = 'failed'
    `);
    const clearFailedItems = database.prepare(`
      UPDATE job_items SET status = 'cancelled', last_error = NULL, updated_at = ?
      WHERE segment_id = ? AND status = 'failed'
    `);
    const affectedJobs = new Set<string>();

    for (const segmentId of segmentIds) {
      const rows = await failedJobs.all(segmentId) as Array<{ jobId: string }>;
      rows.forEach((row) => affectedJobs.add(row.jobId));
      await resetSegment.run(timestamp, segmentId);
      await clearFailedItems.run(timestamp, segmentId);
    }

    for (const jobId of affectedJobs) {
      await database.prepare(`
        UPDATE jobs SET
          completed_items = (SELECT COUNT(*) FROM job_items WHERE job_id = ? AND status = 'completed'),
          failed_items = (SELECT COUNT(*) FROM job_items WHERE job_id = ? AND status = 'failed'),
          status = CASE
            WHEN status IN ('failed', 'review_with_errors')
              AND NOT EXISTS (SELECT 1 FROM job_items WHERE job_id = ? AND status = 'failed')
            THEN 'review'
            ELSE status
          END,
          last_error = CASE
            WHEN NOT EXISTS (SELECT 1 FROM job_items WHERE job_id = ? AND status = 'failed')
            THEN NULL
            ELSE last_error
          END,
          updated_at = ?
        WHERE id = ?
      `).run(jobId, jobId, jobId, jobId, timestamp, jobId);
    }
  }

  async function resolveFailedJobItems(segmentId: string, pathLabel: string): Promise<void> {
    const jobs = await database.prepare(`
      SELECT DISTINCT ji.job_id AS jobId
      FROM job_items ji
      WHERE ji.segment_id = ? AND ji.status = 'failed'
    `).all(segmentId) as Array<{ jobId: string }>;
    if (!jobs.length) return;

    const timestamp = clock();
    await database.transaction(async () => {
      for (const { jobId } of jobs) {
        await database.prepare(`
          UPDATE job_items SET status = 'completed', last_error = NULL, updated_at = ?
          WHERE job_id = ? AND segment_id = ? AND status = 'failed'
        `).run(timestamp, jobId, segmentId);
        await database.prepare(`
          UPDATE jobs SET
            completed_items = (SELECT COUNT(*) FROM job_items WHERE job_id = ? AND status = 'completed'),
            failed_items = (SELECT COUNT(*) FROM job_items WHERE job_id = ? AND status = 'failed'),
            updated_at = ?
          WHERE id = ?
        `).run(jobId, jobId, timestamp, jobId);
        const counts = await database.prepare(`
          SELECT
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status IN ('pending', 'running') THEN 1 ELSE 0 END) AS remaining
          FROM job_items WHERE job_id = ?
        `).get(jobId) as { failed: number; remaining: number };
        if (Number(counts.remaining) === 0) {
          const status = Number(counts.failed) > 0 ? 'review_with_errors' : 'review';
          await database.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status NOT IN ('cancelled', 'paused')")
            .run(status, timestamp, jobId);
          await database.prepare("UPDATE projects SET status = 'review', updated_at = ? WHERE id = (SELECT project_id FROM jobs WHERE id = ?)")
            .run(timestamp, jobId);
        }
        await database.prepare('INSERT INTO job_logs(job_id, level, message, created_at) VALUES (?, ?, ?, ?)')
          .run(jobId, 'info', `人工定稿已解决失败段落：${pathLabel}`, timestamp);
      }
    });
  }

  async function refreshHistoricalJobsAfterScan(projectId: string, timestamp = clock()): Promise<void> {
    const jobs = await database.prepare('SELECT id, status FROM jobs WHERE project_id = ?').all(projectId) as Array<{
      id: string;
      status: string;
    }>;
    const countsStatement = database.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM job_items WHERE job_id = ?
    `);
    const update = database.prepare(`
      UPDATE jobs SET status = ?, total_items = ?, completed_items = ?, failed_items = ?, updated_at = ?
      WHERE id = ?
    `);
    for (const job of jobs) {
      const counts = await countsStatement.get(job.id) as { total: number; completed: number | null; failed: number | null };
      const failed = Number(counts.failed) || 0;
      const status = failed === 0 && (job.status === 'review_with_errors' || job.status === 'failed')
        ? 'review'
        : job.status;
      await update.run(status, Number(counts.total), Number(counts.completed) || 0, failed, timestamp, job.id);
    }
  }

  return {
    jobById,
    hasActiveTranslationJob,
    existingProjectSegmentIds,
    projectResultSegmentIds,
    createTranslationJob,
    clearTranslationResults,
    resolveFailedJobItems,
    refreshHistoricalJobsAfterScan,
  };
}
