import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsyncDatabase } from '../server/async-db.js';
import { createReviewService } from '../server/application/review/review-service.js';

async function createReviewDatabase(): Promise<{ database: AsyncDatabase; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-review-service-'));
  const database = new AsyncDatabase(path.join(directory, 'test.sqlite'));
  await database.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      target_language TEXT NOT NULL,
      language_behavior_mode TEXT NOT NULL,
      source_format TEXT NOT NULL,
      original_json TEXT NOT NULL
    );
    CREATE TABLE segments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path_label TEXT NOT NULL,
      path_json TEXT NOT NULL,
      kind TEXT NOT NULL,
      protocol_delimiter TEXT,
      source_text TEXT NOT NULL,
      translated_text TEXT,
      final_text TEXT,
      review_status TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      qa_flags TEXT NOT NULL,
      sort_order INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return { database, directory };
}

test('review approval rolls back all segment updates when one approval is rejected', async () => {
  const { database, directory } = await createReviewDatabase();
  try {
    await database.prepare(`
      INSERT INTO projects(id, target_language, language_behavior_mode, source_format, original_json)
      VALUES (?, ?, ?, ?, ?)
    `).run('project-1', 'zh-CN', 'preserve', 'json', '{}');
    for (const [id, sourceText, translatedText, sortOrder] of [
      ['segment-1', 'First entry', '第一项', 0],
      ['segment-2', 'Second entry', '第二项', 1],
    ]) {
      await database.prepare(`
        INSERT INTO segments(
          id, project_id, path_label, path_json, kind, source_text, translated_text,
          review_status, risk_level, qa_flags, sort_order, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 'low', ?, ?, ?)
      `).run(id, 'project-1', id, '["data","description"]', 'field', sourceText, translatedText, '["保留标记"]', sortOrder, 'before');
    }
    await database.exec(`
      CREATE TRIGGER reject_second_approval
      BEFORE UPDATE OF review_status ON segments
      WHEN NEW.id = 'segment-2' AND NEW.review_status = 'approved'
      BEGIN
        SELECT RAISE(ABORT, 'approval blocked');
      END;
    `);
    const service = createReviewService({
      database,
      clock: () => '2026-08-21T00:00:00.000Z',
      publicSettings: () => ({ sourceLanguage: 'en', fallbackLanguage: 'ko', targetLanguage: 'zh-CN' }),
      controlReferencesForProject: async () => [],
      resolveFailedJobItems: async () => {},
    });

    await assert.rejects(service.approveValidatedSegments('project-1', false), /approval blocked/u);
    assert.deepEqual(await database.prepare(`
      SELECT id, review_status AS reviewStatus, qa_flags AS qaFlags, updated_at AS updatedAt
      FROM segments ORDER BY sort_order
    `).all(), [
      { id: 'segment-1', reviewStatus: 'pending', qaFlags: '["保留标记"]', updatedAt: 'before' },
      { id: 'segment-2', reviewStatus: 'pending', qaFlags: '["保留标记"]', updatedAt: 'before' },
    ]);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
