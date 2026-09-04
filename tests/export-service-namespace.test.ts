import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsyncDatabase } from '../server/async-db.js';
import { createExportService, ProjectWorkflowError } from '../server/application/export/export-service.js';
import { createNamespaceReviewService } from '../server/application/export/namespace-review-service.js';

async function createNamespaceDatabase(): Promise<{ database: AsyncDatabase; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-export-namespace-'));
  const database = new AsyncDatabase(path.join(directory, 'test.sqlite'));
  await database.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT,
      original_json TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      original_module_json TEXT,
      draft_module_json TEXT,
      source_format TEXT NOT NULL,
      source_filename TEXT,
      regex_validation_overrides TEXT,
      source_blob BLOB,
      source_storage_path TEXT,
      source_storage_bytes INTEGER,
      source_metadata_keys TEXT,
      draft_source_blob BLOB,
      draft_storage_path TEXT,
      draft_storage_bytes INTEGER,
      draft_storage_sha256 TEXT,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE segments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      path_json TEXT NOT NULL,
      path_label TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'core',
      kind TEXT NOT NULL,
      protocol_delimiter TEXT,
      source_text TEXT NOT NULL,
      start_pos INTEGER,
      end_pos INTEGER,
      translated_text TEXT,
      final_text TEXT,
      risk_level TEXT NOT NULL DEFAULT 'low',
      review_status TEXT NOT NULL,
      included INTEGER NOT NULL DEFAULT 1,
      qa_flags TEXT NOT NULL DEFAULT '[]',
      sort_order INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT '2026-09-03T00:00:00.000Z'
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE resource_image_candidates (
      project_id TEXT NOT NULL,
      resource_path TEXT NOT NULL,
      image_blob BLOB,
      storage_path TEXT,
      status TEXT NOT NULL
    );
  `);
  return { database, directory };
}

test('application blocks an unreviewed Mahou Shoujo namespace stored without the module path prefix', async () => {
  const { database, directory } = await createNamespaceDatabase();
  const module = {
    namespace: 'mahou_shoujo_ni_akogarete',
    trigger: [{ effect: [{ code: 'return {{module_assetlist::mahou_shoujo_ni_akogarete}}' }] }],
  };
  try {
    await database.prepare(`
      INSERT INTO projects(
        id, original_json, draft_json, original_module_json, draft_module_json,
        source_format, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'mahou-shoujo', '{}', '{}', JSON.stringify(module), JSON.stringify(module),
      'risum', 'ready', '2026-09-03T00:00:00.000Z',
    );
    await database.prepare(`
      INSERT INTO segments(
        id, project_id, path_json, path_label, kind, source_text,
        start_pos, end_pos, translated_text, final_text, review_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'module-namespace', 'mahou-shoujo', JSON.stringify(['namespace']), '$module.namespace', 'field', module.namespace,
      null, null, '憧憬魔法少女', '憧憬魔法少女', 'pending',
    );

    const service = createExportService({
      database,
      clock: () => '2026-09-03T00:00:00.000Z',
      targetLanguage: () => 'zh-CN',
      review: {
        projectLanguageBehaviorIssue: async () => null,
        approvedSegmentProtectionIssue: async () => null,
        resolveMirroredModuleLorebookFailures: async () => {},
      },
    });

    await assert.rejects(
      service.applyProject('mahou-shoujo'),
      (error: unknown) => error instanceof ProjectWorkflowError
        && error.payload.code === 'RISU_NAMESPACE_UNREVIEWED'
        && error.payload.pathLabel === '$module.namespace',
    );
    await assert.rejects(
      service.exportProject('mahou-shoujo'),
      (error: unknown) => error instanceof ProjectWorkflowError
        && error.payload.code === 'RISU_NAMESPACE_UNREVIEWED'
        && error.payload.pathLabel === '$module.namespace',
    );
    const row = await database.prepare<{ draftModule: string }>(
      'SELECT draft_module_json AS draftModule FROM projects WHERE id = ?',
    ).get('mahou-shoujo');
    assert.equal(row?.draftModule, JSON.stringify(module));

    await database.prepare('UPDATE segments SET review_status = ? WHERE id = ?')
      .run('approved', 'module-namespace');
    await service.applyProject('mahou-shoujo');
    const applied = await database.prepare<{ draftModule: string }>(
      'SELECT draft_module_json AS draftModule FROM projects WHERE id = ?',
    ).get('mahou-shoujo');
    const appliedModule = JSON.parse(applied?.draftModule || '{}') as typeof module;
    assert.equal(appliedModule.namespace, '憧憬魔法少女');
    assert.match(appliedModule.trigger[0].effect[0].code, /module_assetlist::憧憬魔法少女/u);

    const exportPayload = await service.exportProject('mahou-shoujo');
    assert.equal(exportPayload.contentType, 'application/json; charset=utf-8');
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('manual namespace confirmation preserves an internal key or applies a confirmed rename', async () => {
  const { database, directory } = await createNamespaceDatabase();
  const module = {
    namespace: 'mahou_shoujo_ni_akogarete',
    trigger: [{ effect: [{ code: 'return {{module_assetlist::mahou_shoujo_ni_akogarete}}' }] }],
  };
  try {
    await database.prepare(`
      INSERT INTO projects(
        id, original_json, draft_json, original_module_json, draft_module_json,
        source_format, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'mahou-shoujo', '{}', '{}', JSON.stringify(module), JSON.stringify(module),
      'risum', 'ready', '2026-09-03T00:00:00.000Z',
    );
    const confirmations = createNamespaceReviewService({
      database,
      createId: () => 'namespace-decision',
      clock: () => '2026-09-03T00:00:00.000Z',
    });

    await confirmations.confirm('mahou-shoujo', module.namespace);
    const preserved = await database.prepare<{
      pathJson: string; reviewStatus: string; finalText: string | null; translatedText: string | null;
    }>(`
      SELECT path_json AS pathJson, review_status AS reviewStatus, final_text AS finalText,
        translated_text AS translatedText
      FROM segments WHERE id = ?
    `).get('namespace-decision');
    assert.deepEqual(JSON.parse(preserved?.pathJson ?? '[]'), ['$module', 'namespace']);
    assert.equal(preserved?.reviewStatus, 'approved');
    assert.equal(preserved?.finalText, module.namespace);
    assert.equal(preserved?.translatedText, module.namespace);

    const service = createExportService({
      database,
      clock: () => '2026-09-03T00:00:00.000Z',
      targetLanguage: () => 'zh-CN',
      review: {
        projectLanguageBehaviorIssue: async () => null,
        approvedSegmentProtectionIssue: async () => null,
        resolveMirroredModuleLorebookFailures: async () => {},
      },
    });
    const exportPayload = await service.exportProject('mahou-shoujo');
    assert.equal(exportPayload.contentType, 'application/json; charset=utf-8');

    await confirmations.confirm('mahou-shoujo', '憧憬魔法少女');
    const renamed = await database.prepare<{
      reviewStatus: string; finalText: string | null; translatedText: string | null;
    }>('SELECT review_status AS reviewStatus, final_text AS finalText, translated_text AS translatedText FROM segments WHERE id = ?')
      .get('namespace-decision');
    assert.equal(renamed?.reviewStatus, 'approved');
    assert.equal(renamed?.finalText, '憧憬魔法少女');
    assert.equal(renamed?.translatedText, '憧憬魔法少女');

    const renamedProject = await database.prepare<{ draftModule: string }>(`
      SELECT draft_module_json AS draftModule FROM projects WHERE id = ?
    `).get('mahou-shoujo');
    const renamedModule = JSON.parse(renamedProject?.draftModule ?? '{}') as typeof module;
    assert.equal(renamedModule.namespace, '憧憬魔法少女');
    assert.match(renamedModule.trigger[0].effect[0].code, /module_assetlist::憧憬魔法少女/u);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
