import type { AsyncDatabase } from '../../async-db.js';

export class JobLifecycleError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

export function createJobLifecycleService({ database, clock, jobById, abortJob, scheduleJob }: {
  database: AsyncDatabase;
  clock: () => string;
  jobById: (jobId: string) => Promise<Record<string, unknown> | undefined>;
  abortJob: (jobId: string) => void;
  scheduleJob: (jobId: string) => void;
}) {
  async function assertCurrentScope(jobId: string) {
    const row = await database.prepare(`SELECT j.scope AS jobScope, p.scope AS projectScope FROM jobs j
      JOIN projects p ON p.id = j.project_id WHERE j.id = ?`).get(jobId) as { jobScope: string; projectScope: string } | undefined;
    if (row && row.jobScope !== row.projectScope) throw new JobLifecycleError(409, '项目已按新范围扫描，请启动新任务。');
  }

  async function retireSupersededItems(jobId: string) {
    await database.prepare(`UPDATE job_items SET status = 'cancelled', cancel_reason = 'transferred',
      last_error = '片段已转移到新的翻译任务', updated_at = ?
      WHERE job_id = ? AND status IN ('pending', 'running', 'failed', 'cancelled')
        AND EXISTS (SELECT 1 FROM job_items newer JOIN jobs owner ON owner.id = newer.job_id
          WHERE newer.segment_id = job_items.segment_id AND newer.job_id <> job_items.job_id
            AND (newer.rowid > job_items.rowid OR (owner.status IN ('queued', 'running', 'paused') AND newer.status <> 'cancelled')))`)
      .run(clock(), jobId);
  }

  async function refreshCounts(jobId: string) {
    await database.prepare(`UPDATE jobs SET
      total_items = (SELECT COUNT(*) FROM job_items WHERE job_id = ? AND status <> 'cancelled'),
      completed_items = (SELECT COUNT(*) FROM job_items WHERE job_id = ? AND status = 'completed'),
      failed_items = (SELECT COUNT(*) FROM job_items WHERE job_id = ? AND status = 'failed')
      WHERE id = ?`).run(jobId, jobId, jobId, jobId);
  }

  async function updateStoppedProject(jobId: string, status: 'paused' | 'cancelled') {
    await database.prepare(`UPDATE projects SET status = ?, updated_at = ?
      WHERE id = (SELECT project_id FROM jobs WHERE id = ?)
        AND status IN ('translating', 'paused')
        AND NOT EXISTS (SELECT 1 FROM jobs other
          WHERE other.project_id = projects.id AND other.id <> ?
            AND other.status IN ('queued', 'running', 'paused'))`)
      .run(status, clock(), jobId, jobId);
  }

  async function pause(jobId: string) {
    const result = await database.transaction(async () => {
      const result = await database.prepare("UPDATE jobs SET status = 'paused', updated_at = ? WHERE id = ? AND status IN ('queued', 'running')")
        .run(clock(), jobId);
      if (!result.changes) throw new JobLifecycleError(409, '任务当前不能暂停。');
      await database.prepare("UPDATE job_items SET status = 'pending', updated_at = ? WHERE job_id = ? AND status = 'running'")
        .run(clock(), jobId);
      await updateStoppedProject(jobId, 'paused');
      return await jobById(jobId);
    });
    abortJob(jobId);
    return result;
  }

  async function resume(jobId: string) {
    const result = await database.transaction(async () => {
      await assertCurrentScope(jobId);
      const result = await database.prepare("UPDATE jobs SET status = 'queued', last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('paused', 'failed', 'cancelled')")
        .run(clock(), jobId);
      if (!result.changes) throw new JobLifecycleError(409, '任务当前不能继续。');
      await retireSupersededItems(jobId);
      await database.prepare(`UPDATE job_items SET status = 'pending', cancel_reason = NULL, last_error = NULL, updated_at = ?
        WHERE job_id = ? AND (status IN ('running', 'failed') OR (status = 'cancelled' AND cancel_reason = 'user'))`)
        .run(clock(), jobId);
      const remaining = await database.prepare("SELECT COUNT(*) AS count FROM job_items WHERE job_id = ? AND status <> 'cancelled'").get(jobId) as { count: number };
      if (!Number(remaining.count)) throw new JobLifecycleError(409, '任务片段已转移或由人工接管，请使用当前任务。');
      await refreshCounts(jobId);
      await database.prepare("UPDATE projects SET status = 'translating', updated_at = ? WHERE id = (SELECT project_id FROM jobs WHERE id = ?)")
        .run(clock(), jobId);
      return await jobById(jobId);
    });
    scheduleJob(jobId);
    return result;
  }

  async function retryFailed(jobId: string) {
    const result = await database.transaction(async () => {
      await assertCurrentScope(jobId);
      const job = await jobById(jobId);
      if (!job) throw new JobLifecycleError(404, '任务不存在。');
      if (!['failed', 'review_with_errors'].includes(String(job.status))) throw new JobLifecycleError(409, '任务当前不能重试失败项。');
      await retireSupersededItems(jobId);
      const owned = await database.prepare("SELECT COUNT(*) AS count FROM job_items WHERE job_id = ? AND status <> 'cancelled'").get(jobId) as { count: number };
      if (!Number(owned.count)) throw new JobLifecycleError(409, '任务片段已转移或由人工接管，请使用当前任务。');
      await database.prepare("UPDATE job_items SET status = 'pending', last_error = NULL, updated_at = ? WHERE job_id = ? AND status = 'failed'")
        .run(clock(), jobId);
      await refreshCounts(jobId);
      await database.prepare("UPDATE jobs SET status = 'queued', failed_items = 0, post_completed_items = 0, post_failed_items = 0, last_error = NULL, updated_at = ? WHERE id = ?")
        .run(clock(), jobId);
      await database.prepare("UPDATE projects SET status = 'translating', updated_at = ? WHERE id = (SELECT project_id FROM jobs WHERE id = ?)")
        .run(clock(), jobId);
      return await jobById(jobId);
    });
    scheduleJob(jobId);
    return result;
  }

  async function rerunPostprocessing(jobId: string) {
    const result = await database.transaction(async () => {
      await assertCurrentScope(jobId);
      const result = await database.prepare(`
        UPDATE jobs
        SET status = 'queued', post_completed_items = 0, post_failed_items = 0,
          last_error = NULL, updated_at = ?
        WHERE id = ? AND status IN ('review', 'review_with_errors')
          AND (COALESCE(post_failed_items, 0) > 0 OR COALESCE(post_completed_items, 0) < COALESCE(post_total_items, 0))
      `).run(clock(), jobId);
      if (!result.changes) throw new JobLifecycleError(409, '阶段 2 已完成或当前没有可重试的失败项，无需重复执行。');
      await database.prepare("UPDATE projects SET status = 'translating', updated_at = ? WHERE id = (SELECT project_id FROM jobs WHERE id = ?)")
        .run(clock(), jobId);
      await database.prepare('INSERT INTO job_logs(job_id, level, message, created_at) VALUES (?, ?, ?, ?)')
        .run(jobId, 'info', '已请求重新执行阶段 2：正文译文保持不变，只复核 Lua 正则与关键词适配。', clock());
      return await jobById(jobId);
    });
    scheduleJob(jobId);
    return result;
  }

  async function cancel(jobId: string) {
    const result = await database.transaction(async () => {
      const result = await database.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?")
        .run(clock(), jobId);
      if (!result.changes) throw new JobLifecycleError(404, '任务不存在。');
      await database.prepare("UPDATE job_items SET status = 'cancelled', cancel_reason = 'user', updated_at = ? WHERE job_id = ? AND status IN ('pending', 'running')")
        .run(clock(), jobId);
      await updateStoppedProject(jobId, 'cancelled');
      return await jobById(jobId);
    });
    abortJob(jobId);
    return result;
  }
  return { pause, resume, retryFailed, rerunPostprocessing, cancel };
}
