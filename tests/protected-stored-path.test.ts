/**
 * Regression coverage for re-applying scan-time protection to stored rows.
 *
 * A project keeps its scan rows until it is scanned again, so a key that joined
 * the protected list later — `viewScreen` did, in `2bd6d8e` — stays approved in
 * older projects. Applying or exporting those rows wrote `viewScreen: "无"` into
 * an already translated card, so apply/export now re-checks the path.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsyncDatabase } from '../server/async-db.js';
import { createExportService, ProjectWorkflowError } from '../server/application/export/export-service.js';
import { isProtectedStoredPath, staleProtectedDraftPaths } from '../server/domain/card/card.js';
import { isProtectedResourceJsonSegment } from '../server/domain/resources/resources.js';

async function createDatabase(): Promise<{ database: AsyncDatabase; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-protected-path-'));
  const database = new AsyncDatabase(path.join(directory, 'test.sqlite'));
  await database.exec(`
    CREATE TABLE projects (
      source_language TEXT NOT NULL DEFAULT 'en',
      id TEXT PRIMARY KEY,
      name TEXT,
      original_json TEXT NOT NULL,
      draft_json TEXT NOT NULL,
      original_module_json TEXT,
      draft_module_json TEXT,
      module_review_state TEXT,
      preset_review_state TEXT,
      target_language TEXT,
      source_format TEXT NOT NULL,
      source_filename TEXT,
      regex_validation_overrides TEXT,
      source_blob BLOB,
      preset_block_index INTEGER,
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
      in_scope INTEGER NOT NULL DEFAULT 1,
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
      updated_at TEXT NOT NULL DEFAULT '2026-09-12T00:00:00.000Z'
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

function createService(database: AsyncDatabase) {
  return createExportService({
    database,
    clock: () => '2026-09-12T00:00:00.000Z',
    targetLanguage: () => 'zh-CN',
    review: {
      projectLanguageBehaviorIssue: async () => null,
      approvedSegmentProtectionIssue: async () => null,
      resolveMirroredModuleLorebookFailures: async () => {},
    },
  });
}

test('stored rows re-check the path protection that scanning applies', () => {
  assert.equal(isProtectedStoredPath('field', ['data', 'extensions', 'risuai', 'viewScreen']), true);
  assert.equal(isProtectedStoredPath('field', ['view_screen']), true);
  assert.equal(isProtectedStoredPath('structured-text', ['data', 'extensions', 'risuai', 'viewScreen']), true);
  assert.equal(isProtectedStoredPath('protocol-field', ['data', 'extensions', 'risuai', 'viewScreen']), true);

  // Ordinary copy fields stay translatable.
  assert.equal(isProtectedStoredPath('field', ['data', 'first_mes']), false);
  assert.equal(isProtectedStoredPath('field', ['data', 'character_book', 'entries', 0, 'content']), false);

  // Script, Lua and resource rows live under protected-looking paths on purpose.
  assert.equal(isProtectedStoredPath('script-ui', ['data', 'extensions', 'risuai', 'customscript', 0, 'out']), false);
  assert.equal(isProtectedStoredPath('lua-string', ['$module', 'trigger', 0, 'effect', 0, 'code']), false);
  assert.equal(isProtectedStoredPath('resource-json', ['$resource', 'a.json', 'name']), false);
  assert.equal(isProtectedStoredPath(undefined, ['data', 'extensions', 'risuai', 'viewScreen']), false);

  // Missing module context fails closed; actual copy is checked against the effect schema.
  const module = { trigger: [{ effect: [
    { type: 'v2Impersonate', value: 'Hello', valueType: 'value' },
    { type: 'v2GetAlertInput', display: 'Your name', displayType: 'value' },
  ] }] };
  assert.equal(isProtectedStoredPath('field', ['$module', 'trigger', 0, 'effect', 0, 'value']), true);
  assert.equal(isProtectedStoredPath('field', ['$module', 'trigger', 0, 'effect', 0, 'value'], module), false);
  assert.equal(isProtectedStoredPath('text-node', ['trigger', 0, 'effect', 1, 'display'], module), false);
  for (const field of ['type', 'role', 'valueType', 'code']) {
    assert.equal(isProtectedStoredPath('field', ['trigger', 0, 'effect', 0, field], module), true);
  }
  module.trigger[0].effect[0].valueType = 'var';
  assert.equal(isProtectedStoredPath('text-node', ['trigger', 0, 'effect', 0, 'value'], module), true);
  // Everything outside an `effect` stays protected.
  assert.equal(isProtectedStoredPath('field', ['$module', 'trigger', 1, 'conditions', 0, 'value']), true);
  assert.equal(isProtectedStoredPath('field', ['$module', 'regex', 0, 'in']), true);
});

test('resource JSON rows re-check the resource allowlist', () => {
  assert.equal(isProtectedResourceJsonSegment('resource-json', ['$resource', 'a.json', 'mode'], 'none'), true);
  assert.equal(isProtectedResourceJsonSegment('resource-json', ['$resource', 'a.json', 'type'], 'image'), true);
  assert.equal(isProtectedResourceJsonSegment('resource-json', ['$resource', 'a.json', 'url'], 'assets/a.png'), true);
  assert.equal(isProtectedResourceJsonSegment('resource-json', ['$resource', 'a.json', 'description'], '一场漫长的旅程'), false);
  assert.equal(isProtectedResourceJsonSegment('field', ['$resource', 'a.json', 'mode'], 'none'), false);
});

test('module apply repairs stale protected writes, preserves draft work, and export checks module rows', async () => {
  const { database, directory } = await createDatabase();
  const card = { name: 'Synthetic trigger fixture', description: 'Hello' };
  const original = { trigger: [{ effect: [
    { type: 'v2Impersonate', role: 'user', value: '<b>변수 이름</b>', valueType: 'var' },
    { type: 'v2GetAlertInput', display: '이름을 입력하세요.', displayType: 'value' },
  ] }], editorNote: 'Original note' };
  const stale = structuredClone(original);
  stale.trigger[0].effect[0].role = '用户';
  stale.trigger[0].effect[0].value = '<b>变量名</b>';
  stale.editorNote = 'Retained draft edit';
  try {
    await database.prepare(`
      INSERT INTO projects(id, original_json, draft_json, original_module_json, draft_module_json, source_format, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('trigger', JSON.stringify(card), JSON.stringify(card), JSON.stringify(original), JSON.stringify(stale), 'json', 'ready', '2026-09-14');
    const insert = database.prepare(`
      INSERT INTO segments(id, project_id, path_json, path_label, kind, source_text, start_pos, end_pos, translated_text, review_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    await insert.run('role', 'trigger', JSON.stringify(['$module', 'trigger', 0, 'effect', 0, 'role']), 'module.role', 'field', 'user', null, null, '用户', 'approved');
    await insert.run('variable', 'trigger', JSON.stringify(['$module', 'trigger', 0, 'effect', 0, 'value']), 'module.variable', 'text-node', '변수 이름', 3, 8, '变量名', 'approved');
    await insert.run('display', 'trigger', JSON.stringify(['$module', 'trigger', 0, 'effect', 1, 'display']), 'module.display', 'field', '이름을 입력하세요.', null, null, '请输入姓名。', 'approved');
    const service = createService(database);
    await assert.rejects(service.exportProject('trigger'), (error: unknown) =>
      error instanceof ProjectWorkflowError && error.payload.code === 'PROTECTED_PATH_STALE_DRAFT');
    // A failed save must not persist a partially repaired module or card.
    await database.exec(`CREATE TRIGGER reject_trigger_save BEFORE UPDATE ON projects
      BEGIN SELECT RAISE(ABORT, 'synthetic save failure'); END;`);
    await assert.rejects(service.applyProject('trigger'), /synthetic save failure/);
    const unchanged = await database.prepare<{ card: string; module: string }>(
      'SELECT draft_json AS card, draft_module_json AS module FROM projects WHERE id = ?',
    ).get('trigger');
    assert.deepEqual(JSON.parse(unchanged!.card), card);
    assert.deepEqual(JSON.parse(unchanged!.module), stale);
    await database.exec('DROP TRIGGER reject_trigger_save');
    const result = await service.applyProject('trigger');
    assert.deepEqual(result.ignoredProtectedPaths, ['module.role', 'module.variable']);
    const row = await database.prepare<{ draft: string }>('SELECT draft_module_json AS draft FROM projects WHERE id = ?').get('trigger');
    const expected = structuredClone(original);
    expected.editorNote = stale.editorNote;
    expected.trigger[0].effect[1].display = '请输入姓名。';
    assert.deepEqual(JSON.parse(row!.draft), expected);
    assert.equal((await service.exportProject('trigger')).contentType, 'application/json; charset=utf-8');
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('a module draft without a stored original module survives a save', async () => {
  const { database, directory } = await createDatabase();
  const card = { name: 'Draft-only module fixture' };
  const draftModule = { name: 'Already translated module', trigger: [] };
  try {
    await database.prepare(`
      INSERT INTO projects(id, original_json, draft_json, original_module_json, draft_module_json, source_format, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'draft-only', JSON.stringify(card), JSON.stringify(card),
      null, JSON.stringify(draftModule), 'json', 'ready', '2026-09-14',
    );
    const service = createService(database);

    // Saving rebuilds the module from `original_module_json`. When that row is
    // absent the stored draft is the only copy of the translation, so falling
    // back to the (null) original would write `draft_module_json = null` and
    // silently discard it.
    await service.applyProject('draft-only');
    const row = await database.prepare<{ module: string | null }>(
      'SELECT draft_module_json AS module FROM projects WHERE id = ?',
    ).get('draft-only');
    assert.notEqual(row!.module, null);
    assert.deepEqual(JSON.parse(row!.module!), draftModule);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('stale draft paths are the approved rows that still override a protected field', () => {
  const original = { data: { extensions: { risuai: { viewScreen: 'none' } } } };
  const row = {
    pathJson: JSON.stringify(['data', 'extensions', 'risuai', 'viewScreen']),
    pathLabel: 'data.extensions.risuai.viewScreen',
    kind: 'field' as const,
    reviewStatus: 'approved',
  };

  assert.deepEqual(
    staleProtectedDraftPaths(original, { data: { extensions: { risuai: { viewScreen: '无' } } } }, [row]),
    ['data.extensions.risuai.viewScreen'],
  );
  assert.deepEqual(staleProtectedDraftPaths(original, structuredClone(original), [row]), []);
  assert.deepEqual(
    staleProtectedDraftPaths(original, { data: { extensions: { risuai: { viewScreen: '无' } } } }, [
      { ...row, reviewStatus: 'pending' },
    ]),
    [],
  );
});

test('apply ignores stored rows on protected paths and exports refuse a stale draft', async () => {
  const { database, directory } = await createDatabase();
  const card = {
    name: 'Walpurgisnacht: A Madoka Magica RP',
    data: { first_mes: 'Hello', extensions: { risuai: { viewScreen: 'none' } } },
  };
  try {
    await database.prepare(`
      INSERT INTO projects(id, original_json, draft_json, source_format, status, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('madoka', JSON.stringify(card), JSON.stringify(card), 'json', 'ready', '2026-09-12T00:00:00.000Z');
    const insertSegment = database.prepare(`
      INSERT INTO segments(
        id, project_id, path_json, path_label, kind, source_text,
        start_pos, end_pos, translated_text, final_text, review_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    await insertSegment.run(
      'viewscreen-row', 'madoka', JSON.stringify(['data', 'extensions', 'risuai', 'viewScreen']),
      'data.extensions.risuai.viewScreen', 'field', 'none', null, null, '无', '', 'approved',
    );
    await insertSegment.run(
      'first-mes-row', 'madoka', JSON.stringify(['data', 'first_mes']),
      'data.first_mes', 'field', 'Hello', null, null, '你好', '', 'approved',
    );

    const service = createService(database);

    // An untouched draft is exportable: the guard only reacts to a stale write.
    const clean = await service.exportProject('madoka');
    assert.equal(clean.contentType, 'application/json; charset=utf-8');

    const applied = await service.applyProject('madoka');
    assert.equal(applied.ignoredProtectedSegments, 1);
    assert.deepEqual(applied.ignoredProtectedPaths, ['data.extensions.risuai.viewScreen']);
    const afterApply = JSON.parse(String((await database.prepare<{ draftJson: string }>(
      'SELECT draft_json AS draftJson FROM projects WHERE id = ?',
    ).get('madoka'))?.draftJson)) as typeof card;
    assert.equal(afterApply.data.extensions.risuai.viewScreen, 'none');
    assert.equal(afterApply.data.first_mes, '你好');

    // A draft saved before the protection list grew keeps the stale write, even
    // though applying would no longer produce it.
    await database.prepare('UPDATE projects SET draft_json = ? WHERE id = ?').run(
      JSON.stringify({ ...card, data: { ...card.data, extensions: { risuai: { viewScreen: '无' } } } }),
      'madoka',
    );
    await assert.rejects(
      service.exportProject('madoka'),
      (error: unknown) => error instanceof ProjectWorkflowError
        && error.payload.code === 'PROTECTED_PATH_STALE_DRAFT'
        && error.payload.pathLabel === 'data.extensions.risuai.viewScreen',
    );

    // Saving rebuilds the draft from the original, so the export passes again
    // without deleting the stored row (only a re-scan removes it).
    await service.applyProject('madoka');
    const exported = await service.exportProject('madoka');
    const payload = JSON.parse(String(exported.body)) as typeof card;
    assert.equal(payload.data.extensions.risuai.viewScreen, 'none');
    assert.equal(payload.data.first_mes, '你好');
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
