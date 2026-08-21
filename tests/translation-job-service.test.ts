import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsyncDatabase } from '../server/async-db.js';
import { createTranslationJobService } from '../server/application/translation-job-service.js';

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
    const jobId = await service.createTranslationJob('project-1', 'all-visible', 'test-model', ['segment-1'], false);

    assert.equal(jobId, 'job-1');
    assert.deepEqual(await database.prepare('SELECT status, total_items AS totalItems FROM jobs').all(), [
      { status: 'queued', totalItems: 1 },
    ]);
    assert.deepEqual(await database.prepare('SELECT job_id AS jobId, segment_id AS segmentId, status FROM job_items').all(), [
      { jobId: 'job-1', segmentId: 'segment-1', status: 'pending' },
    ]);
    assert.deepEqual(await database.prepare('SELECT status FROM projects WHERE id = ?').get('project-1'), { status: 'translating' });
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

    const ids = ['job-rollback', 'item-1', 'item-2'];
    const service = createTranslationJobService({
      database,
      createId: () => ids.shift() || 'unexpected-id',
      clock: () => '2026-08-21T00:00:00.000Z',
    });

    await assert.rejects(
      service.createTranslationJob('project-1', 'all-visible', 'test-model', ['segment-1', 'segment-1'], true),
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
