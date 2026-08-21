import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsyncDatabase } from '../server/async-db.js';
import { createProjectService } from '../server/application/project-service.js';

async function createProjectDatabase(): Promise<{ database: AsyncDatabase; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-project-service-'));
  const database = new AsyncDatabase(path.join(directory, 'test.sqlite'));
  await database.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_format TEXT NOT NULL,
      source_language TEXT NOT NULL,
      target_language TEXT NOT NULL,
      language_behavior_mode TEXT NOT NULL,
      scope TEXT NOT NULL,
      status TEXT NOT NULL,
      original_hash TEXT NOT NULL,
      original_json TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      original_module_json TEXT,
      draft_module_json TEXT,
      source_filename TEXT,
      source_blob BLOB,
      source_metadata_keys TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return { database, directory };
}

test('project service creates a complete import record', async () => {
  const { database, directory } = await createProjectDatabase();
  try {
    const service = createProjectService({
      database,
      createId: () => 'project-1',
      clock: () => '2026-08-21T00:00:00.000Z',
      languageRoute: () => ({
        sourceLanguage: 'ko',
        targetLanguage: 'zh-CN',
        languageBehaviorMode: 'follow-target',
      }),
    });
    const card = { data: { name: '导入验证卡', description: '原始内容' } };

    assert.equal(await service.createProject({
      name: '导入验证卡',
      sourceFormat: 'charx',
      card,
      module: { name: '关联模块' },
      filename: 'import.charx',
      blob: new Uint8Array([1, 2, 3]),
      metadataKeys: ['creator', 'character_version'],
    }), 'project-1');

    const row = await database.prepare<{
      id: string;
      scope: string;
      status: string;
      sourceLanguage: string;
      targetLanguage: string;
      languageBehaviorMode: string;
      originalJson: string;
      draftJson: string;
      sourceFilename: string;
      metadataKeys: string;
      sourceBlob: Buffer;
    }>(`
      SELECT id, scope, status, source_language AS sourceLanguage, target_language AS targetLanguage,
        language_behavior_mode AS languageBehaviorMode, original_json AS originalJson, draft_json AS draftJson,
        source_filename AS sourceFilename, source_metadata_keys AS metadataKeys, source_blob AS sourceBlob
      FROM projects WHERE id = ?
    `).get('project-1');

    assert.ok(row);
    assert.equal(row.scope, 'all');
    assert.equal(row.status, 'new');
    assert.equal(row.sourceLanguage, 'ko');
    assert.equal(row.targetLanguage, 'zh-CN');
    assert.equal(row.languageBehaviorMode, 'follow-target');
    assert.deepEqual(JSON.parse(row.originalJson), card);
    assert.deepEqual(JSON.parse(row.draftJson), card);
    assert.equal(row.sourceFilename, 'import.charx');
    assert.deepEqual(JSON.parse(row.metadataKeys), ['creator', 'character_version']);
    assert.deepEqual([...row.sourceBlob], [1, 2, 3]);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
