import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AsyncDatabase } from '../server/async-db.js';
import { saveRejectedTranslation } from '../server/application/review/rejected-translation.js';
import { RejectedTranslationError, shouldSplitTranslationBatch } from '../server/domain/translation/translation-errors.js';

test('quality failure retains rejected output without marking success and ignores stale jobs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-rejected-translation-'));
  const database = new AsyncDatabase(path.join(directory, 'test.sqlite'));
  try {
    await database.exec(`
      CREATE TABLE segments (id TEXT PRIMARY KEY, translated_text TEXT, final_text TEXT, review_status TEXT, qa_flags TEXT, updated_at TEXT);
      CREATE TABLE job_items (id TEXT PRIMARY KEY, job_id TEXT, segment_id TEXT, status TEXT);
      INSERT INTO segments VALUES ('s1', NULL, NULL, 'pending', '[]', '');
      INSERT INTO job_items VALUES ('i1', 'j1', 's1', 'running');
    `);
    const error = new RejectedTranslationError('S1 翻译质量不合格：残留韩文', 's1', '你好 엄마', ['残留韩文']);
    assert.equal(shouldSplitTranslationBatch(error), true);
    await saveRejectedTranslation(database, () => 'now', 'j1', 'i1', error);
    const row = await database.prepare('SELECT * FROM segments').get() as Record<string, unknown>;
    assert.equal(row.translated_text, '你好 엄마');
    assert.equal(row.final_text, null);
    assert.equal(row.review_status, 'pending');
    assert.deepEqual(JSON.parse(String(row.qa_flags)), ['残留韩文']);
    assert.equal((await database.prepare('SELECT status FROM job_items').get() as { status: string }).status, 'running');
    await database.exec("UPDATE job_items SET status = 'failed'");
    await saveRejectedTranslation(database, () => 'later', 'j1', 'i1', new RejectedTranslationError('失败', 's1', '过期译文', []));
    assert.equal((await database.prepare('SELECT translated_text FROM segments').get() as { translated_text: string }).translated_text, '你好 엄마');
    await database.exec("UPDATE job_items SET status = 'running'");
    await saveRejectedTranslation(database, () => 'later', 'other-job', 'i1', new RejectedTranslationError('失败', 's1', '其他任务', []));
    assert.equal((await database.prepare('SELECT translated_text FROM segments').get() as { translated_text: string }).translated_text, '你好 엄마');
    await database.exec("CREATE TRIGGER reject_write BEFORE UPDATE ON segments BEGIN SELECT RAISE(ABORT, 'write failed'); END;");
    await assert.rejects(saveRejectedTranslation(database, () => 'later', 'j1', 'i1', error), /write failed/);
    assert.deepEqual(await database.prepare('SELECT * FROM segments').get(), row);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
