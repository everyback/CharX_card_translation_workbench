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
      const result = await database.prepare("UPDATE jobs SET status = 'queued', last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('paused', 'failed', 'cancelled')")
        .run(clock(), jobId);
      if (!result.changes) throw new JobLifecycleError(409, '任务当前不能继续。');
      await database.prepare("UPDATE job_items SET status = 'pending', last_error = NULL, updated_at = ? WHERE job_id = ? AND status IN ('running', 'failed', 'cancelled')")
        .run(clock(), jobId);
      await database.prepare("UPDATE projects SET status = 'translating', updated_at = ? WHERE id = (SELECT project_id FROM jobs WHERE id = ?)")
        .run(clock(), jobId);
      return await jobById(jobId);
    });
    scheduleJob(jobId);
    return result;
  }

  async function retryFailed(jobId: string) {
    const result = await database.transaction(async () => {
      const job = await jobById(jobId);
      if (!job) throw new JobLifecycleError(404, '任务不存在。');
      await database.prepare("UPDATE job_items SET status = 'pending', last_error = NULL, updated_at = ? WHERE job_id = ? AND status = 'failed'")
        .run(clock(), jobId);
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
      await database.prepare("UPDATE job_items SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('pending', 'running')")
        .run(clock(), jobId);
      await updateStoppedProject(jobId, 'cancelled');
      return await jobById(jobId);
    });
    abortJob(jobId);
    return result;
  }
  return { pause, resume, retryFailed, rerunPostprocessing, cancel };
}
