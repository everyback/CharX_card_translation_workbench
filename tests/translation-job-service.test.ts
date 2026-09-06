import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsyncDatabase } from '../server/async-db.js';
import { createTranslationJobService } from '../server/application/translation/translation-job-service.js';

async function createJobDatabase(): Promise<{ database: AsyncDatabase; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-job-service-'));
  const database = new AsyncDatabase(path.join(directory, 'test.sqlite'));
  await database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE segments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      translated_text TEXT,
      final_text TEXT,
      review_status TEXT NOT NULL,
      qa_flags TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      status TEXT NOT NULL,
      scope TEXT NOT NULL,
      model TEXT NOT NULL,
      total_items INTEGER NOT NULL,
      completed_items INTEGER NOT NULL DEFAULT 0,
      failed_items INTEGER NOT NULL DEFAULT 0,
      post_total_items INTEGER NOT NULL DEFAULT 0,
      post_completed_items INTEGER NOT NULL DEFAULT 0,
      post_failed_items INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE job_items (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      segment_id TEXT NOT NULL REFERENCES segments(id),
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      UNIQUE(job_id, segment_id)
    );
    CREATE TABLE job_logs (
      id INTEGER PRIMARY KEY,
      job_id TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return { database, directory };
}

test('translation job service creates every job item and advances the project in one transaction', async () => {
  const { database, directory } = await createJobDatabase();
  try {
    await database.prepare('INSERT INTO projects(id, status, updated_at) VALUES (?, ?, ?)')
      .run('project-1', 'scanned', 'before');
    await database.prepare(`
      INSERT INTO segments(id, project_id, review_status, qa_flags, updated_at, sort_order)
      VALUES (?, ?, 'untranslated', '[]', 'before', ?)
    `).run('segment-1', 'project-1', 0);

    const ids = ['job-1', 'item-1'];
    const service = createTranslationJobService({
      database,
      createId: () => ids.shift() || 'unexpected-id',
      clock: () => '2026-08-21T00:00:00.000Z',
    });
    const creation = await service.createTranslationJob('project-1', 'all-visible', 'test-model', ['segment-1'], false);

    assert.deepEqual(creation, {
      jobId: 'job-1',
      created: true,
      transferredJobIds: [],
      requestedSegmentCount: 1,
      scheduledSegmentCount: 1,
      deduplicatedSegmentCount: 0,
    });
    assert.deepEqual(await database.prepare('SELECT status, total_items AS totalItems FROM jobs').all(), [
      { status: 'queued', totalItems: 1 },
    ]);
    assert.deepEqual(await service.jobById(creation.jobId), {
      id: 'job-1',
      projectId: 'project-1',
      status: 'queued',
      scope: 'all-visible',
      model: 'test-model',
      totalItems: 1,
      completedItems: 0,
      failedItems: 0,
      postTotalItems: 0,
      postCompletedItems: 0,
      postFailedItems: 0,
      lastError: null,
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
    });
    assert.deepEqual(await database.prepare('SELECT job_id AS jobId, segment_id AS segmentId, status FROM job_items').all(), [
      { jobId: 'job-1', segmentId: 'segment-1', status: 'pending' },
    ]);
    assert.deepEqual(await database.prepare('SELECT status FROM projects WHERE id = ?').get('project-1'), { status: 'translating' });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('translation job service transfers active segments while allowing same-project concurrent jobs', async () => {
  const { database, directory } = await createJobDatabase();
  try {
    await database.prepare('INSERT INTO projects(id, status, updated_at) VALUES (?, ?, ?)')
      .run('project-1', 'scanned', 'before');
    await database.prepare(`
      INSERT INTO segments(id, project_id, review_status, qa_flags, updated_at, sort_order)
      VALUES (?, ?, 'untranslated', '[]', 'before', ?)
    `).run('segment-1', 'project-1', 0);
    await database.prepare(`
      INSERT INTO segments(id, project_id, review_status, qa_flags, updated_at, sort_order)
      VALUES (?, ?, 'untranslated', '[]', 'before', ?)
    `).run('segment-2', 'project-1', 1);

    const ids = ['job-1', 'item-1', 'job-2', 'item-2a', 'item-2b', 'job-3', 'item-3'];
    const service = createTranslationJobService({
      database,
      createId: () => ids.shift() || 'unexpected-id',
      clock: () => '2026-08-21T00:00:00.000Z',
    });

    const first = await service.createTranslationJob('project-1', 'all-visible', 'test-model', ['segment-1'], false);
    const second = await service.createTranslationJob('project-1', 'all-visible', 'test-model', ['segment-1', 'segment-2'], false);
    const duplicate = await service.createTranslationJob('project-1', 'all-visible', 'test-model', ['segment-1'], true);

    assert.equal(first.created, true);
    assert.deepEqual(second, {
      jobId: 'job-2',
      created: true,
      transferredJobIds: ['job-1'],
      requestedSegmentCount: 2,
      scheduledSegmentCount: 2,
      deduplicatedSegmentCount: 1,
    });
    assert.deepEqual(duplicate, {
      jobId: 'job-3',
      created: true,
      transferredJobIds: ['job-2'],
      requestedSegmentCount: 1,
      scheduledSegmentCount: 1,
      deduplicatedSegmentCount: 1,
    });
    assert.deepEqual(await database.prepare('SELECT job_id AS jobId, segment_id AS segmentId, status FROM job_items ORDER BY job_id, segment_id').all(), [
      { jobId: 'job-1', segmentId: 'segment-1', status: 'cancelled' },
      { jobId: 'job-2', segmentId: 'segment-1', status: 'cancelled' },
      { jobId: 'job-2', segmentId: 'segment-2', status: 'pending' },
      { jobId: 'job-3', segmentId: 'segment-1', status: 'pending' },
    ]);
    assert.deepEqual(await database.prepare('SELECT id, status, total_items AS totalItems FROM jobs ORDER BY id').all(), [
      { id: 'job-1', status: 'cancelled', totalItems: 0 },
      { id: 'job-2', status: 'queued', totalItems: 1 },
      { id: 'job-3', status: 'queued', totalItems: 1 },
    ]);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('translation job service serializes concurrent overlap transfers inside the writer transaction', async () => {
  const { database, directory } = await createJobDatabase();
  try {
    await database.prepare('INSERT INTO projects(id, status, updated_at) VALUES (?, ?, ?)')
      .run('project-1', 'scanned', 'before');
    await database.prepare(`
      INSERT INTO segments(id, project_id, review_status, qa_flags, updated_at, sort_order)
      VALUES (?, ?, 'untranslated', '[]', 'before', ?)
    `).run('segment-1', 'project-1', 0);

    const ids = ['job-a', 'job-b', 'item-a', 'item-b'];
    const service = createTranslationJobService({
      database,
      createId: () => ids.shift() || 'unexpected-id',
      clock: () => '2026-08-21T00:00:00.000Z',
    });

    const [first, second] = await Promise.all([
      service.createTranslationJob('project-1', 'all-visible', 'test-model', ['segment-1'], false),
      service.createTranslationJob('project-1', 'all-visible', 'test-model', ['segment-1'], false),
    ]);

    assert.equal(first.created, true);
    assert.equal(second.created, true);
    assert.equal(first.deduplicatedSegmentCount + second.deduplicatedSegmentCount, 1);
    assert.deepEqual(await database.prepare(`
      SELECT job_id AS jobId, status FROM job_items ORDER BY job_id
    `).all(), [
      { jobId: 'job-a', status: 'cancelled' },
      { jobId: 'job-b', status: 'pending' },
    ]);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('translation job service rolls back result clearing when an item insert fails', async () => {
  const { database, directory } = await createJobDatabase();
  try {
    await database.prepare('INSERT INTO projects(id, status, updated_at) VALUES (?, ?, ?)')
      .run('project-1', 'scanned', 'before');
    await database.prepare(`
      INSERT INTO segments(
        id, project_id, translated_text, final_text, review_status, qa_flags, updated_at, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('segment-1', 'project-1', '机器译文', '人工译文', 'approved', '["人工确认"]', 'before', 0);
    await database.prepare(`
      INSERT INTO segments(id, project_id, review_status, qa_flags, updated_at, sort_order)
      VALUES (?, ?, 'untranslated', '[]', 'before', ?)
    `).run('segment-2', 'project-1', 1);

    const ids = ['job-rollback', 'item-1', 'item-1'];
    const service = createTranslationJobService({
      database,
      createId: () => ids.shift() || 'unexpected-id',
      clock: () => '2026-08-21T00:00:00.000Z',
    });

    await assert.rejects(
      service.createTranslationJob('project-1', 'all-visible', 'test-model', ['segment-1', 'segment-2'], true),
      /UNIQUE constraint failed/u,
    );

    assert.deepEqual(await database.prepare('SELECT COUNT(*) AS count FROM jobs').get(), { count: 0 });
    assert.deepEqual(await database.prepare('SELECT COUNT(*) AS count FROM job_items').get(), { count: 0 });
    assert.deepEqual(await database.prepare(`
      SELECT translated_text AS translatedText, final_text AS finalText, review_status AS reviewStatus, qa_flags AS qaFlags
      FROM segments WHERE id = ?
    `).get('segment-1'), {
      translatedText: '机器译文',
      finalText: '人工译文',
      reviewStatus: 'approved',
      qaFlags: '["人工确认"]',
    });
    assert.deepEqual(await database.prepare('SELECT status, updated_at AS updatedAt FROM projects WHERE id = ?').get('project-1'), {
      status: 'scanned',
      updatedAt: 'before',
    });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
