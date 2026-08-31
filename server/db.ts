import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { AsyncDatabase } from './async-db.js';
import { workbenchConfig } from './config.js';
import { migrateLegacyStorage } from './storage-migration.js';

mkdirSync(workbenchConfig.paths.dataRoot, { recursive: true });

export const db = new AsyncDatabase(workbenchConfig.paths.database, workbenchConfig.databaseWorkers);
await db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

const sqliteRuntime = await db.prepare<{ journalMode: string; synchronous: number }>(`
  SELECT
    (SELECT journal_mode FROM pragma_journal_mode) AS journalMode,
    (SELECT synchronous FROM pragma_synchronous) AS synchronous
`).get();
if (sqliteRuntime?.journalMode !== 'wal' || Number(sqliteRuntime.synchronous) !== 1) {
  throw new Error(`SQLite WAL/NORMAL 初始化失败：${JSON.stringify(sqliteRuntime)}`);
}

await db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_format TEXT NOT NULL DEFAULT 'json',
    source_language TEXT NOT NULL DEFAULT 'auto',
    target_language TEXT NOT NULL DEFAULT 'zh-CN',
    scope TEXT NOT NULL DEFAULT 'all',
    status TEXT NOT NULL DEFAULT 'new',
    original_hash TEXT NOT NULL,
    original_json TEXT NOT NULL,
    draft_json TEXT NOT NULL,
    original_module_json TEXT,
    draft_module_json TEXT,
    source_filename TEXT,
    source_blob BLOB,
    source_storage_path TEXT,
    source_storage_bytes INTEGER,
    source_storage_sha256 TEXT,
    draft_storage_path TEXT,
    draft_storage_bytes INTEGER,
    draft_storage_sha256 TEXT,
    source_metadata_keys TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS segments (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    path_json TEXT NOT NULL,
    path_label TEXT NOT NULL,
    category TEXT NOT NULL,
    kind TEXT NOT NULL,
    protocol_delimiter TEXT,
    source_text TEXT NOT NULL,
    translated_text TEXT,
    final_text TEXT,
    start_pos INTEGER,
    end_pos INTEGER,
    risk_level TEXT NOT NULL,
    review_status TEXT NOT NULL DEFAULT 'untranslated',
    included INTEGER NOT NULL DEFAULT 1,
    qa_flags TEXT NOT NULL DEFAULT '[]',
    sort_order INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS segments_project_idx ON segments(project_id, sort_order);

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    scope TEXT NOT NULL,
    model TEXT NOT NULL,
    total_items INTEGER NOT NULL DEFAULT 0,
    completed_items INTEGER NOT NULL DEFAULT 0,
    failed_items INTEGER NOT NULL DEFAULT 0,
    post_total_items INTEGER NOT NULL DEFAULT 0,
    post_completed_items INTEGER NOT NULL DEFAULT 0,
    post_failed_items INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS job_items (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TEXT NOT NULL,
    UNIQUE(job_id, segment_id)
  );

  CREATE INDEX IF NOT EXISTS job_items_job_idx ON job_items(job_id, status);
  CREATE INDEX IF NOT EXISTS job_items_segment_idx ON job_items(segment_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS protocol_schemas (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    signature TEXT NOT NULL,
    name TEXT NOT NULL,
    form TEXT NOT NULL,
    opener TEXT NOT NULL,
    closer TEXT NOT NULL,
    delimiter TEXT NOT NULL,
    field_count INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    source TEXT NOT NULL DEFAULT 'local',
    confidence REAL NOT NULL DEFAULT 0,
    field_rules_json TEXT NOT NULL DEFAULT '[]',
    declaration TEXT NOT NULL DEFAULT '',
    examples_json TEXT NOT NULL DEFAULT '[]',
    occurrence_count INTEGER NOT NULL DEFAULT 0,
    reference_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, signature)
  );

  CREATE INDEX IF NOT EXISTS protocol_schemas_project_idx
    ON protocol_schemas(project_id, occurrence_count DESC);

  CREATE TABLE IF NOT EXISTS protocol_occurrences (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    schema_id TEXT NOT NULL REFERENCES protocol_schemas(id) ON DELETE CASCADE,
    path_json TEXT NOT NULL,
    path_label TEXT NOT NULL,
    start_pos INTEGER NOT NULL,
    end_pos INTEGER NOT NULL,
    raw_preview TEXT NOT NULL,
    fields_json TEXT NOT NULL DEFAULT '[]',
    is_declaration INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS protocol_occurrences_schema_idx
    ON protocol_occurrences(schema_id, path_label, start_pos);

  CREATE TABLE IF NOT EXISTS job_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS glossary_terms (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    source_text TEXT NOT NULL,
    target_text TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    case_sensitive INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS glossary_project_idx ON glossary_terms(project_id, source_text);

  CREATE TABLE IF NOT EXISTS resource_ocr_candidates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    resource_path TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    confidence REAL,
    engine TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, resource_path)
  );

  CREATE INDEX IF NOT EXISTS resource_ocr_project_idx
    ON resource_ocr_candidates(project_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS resource_image_candidates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    resource_path TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    image_blob BLOB NOT NULL,
    storage_path TEXT,
    storage_bytes INTEGER,
    storage_sha256 TEXT,
    prompt TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(project_id, resource_path)
  );

  CREATE INDEX IF NOT EXISTS resource_image_project_idx
    ON resource_image_candidates(project_id, updated_at DESC);
`);

await addColumnIfMissing('projects', 'source_filename', 'TEXT');
await addColumnIfMissing('projects', 'source_blob', 'BLOB');
await addColumnIfMissing('projects', 'source_metadata_keys', "TEXT NOT NULL DEFAULT '[]'");
await addColumnIfMissing('projects', 'original_module_json', 'TEXT');
await addColumnIfMissing('projects', 'draft_module_json', 'TEXT');
await addColumnIfMissing('projects', 'draft_source_blob', 'BLOB');
await addColumnIfMissing('projects', 'source_storage_path', 'TEXT');
await addColumnIfMissing('projects', 'source_storage_bytes', 'INTEGER');
await addColumnIfMissing('projects', 'source_storage_sha256', 'TEXT');
await addColumnIfMissing('projects', 'draft_storage_path', 'TEXT');
await addColumnIfMissing('projects', 'draft_storage_bytes', 'INTEGER');
await addColumnIfMissing('projects', 'draft_storage_sha256', 'TEXT');
await addColumnIfMissing('resource_image_candidates', 'storage_path', 'TEXT');
await addColumnIfMissing('resource_image_candidates', 'storage_bytes', 'INTEGER');
await addColumnIfMissing('resource_image_candidates', 'storage_sha256', 'TEXT');
await addColumnIfMissing('segments', 'protocol_delimiter', 'TEXT');
await addColumnIfMissing('projects', 'language_behavior_mode', "TEXT NOT NULL DEFAULT 'target'");
await addColumnIfMissing('jobs', 'post_total_items', 'INTEGER NOT NULL DEFAULT 0');
await addColumnIfMissing('jobs', 'post_completed_items', 'INTEGER NOT NULL DEFAULT 0');
await addColumnIfMissing('jobs', 'post_failed_items', 'INTEGER NOT NULL DEFAULT 0');

await db.prepare(`
  UPDATE projects
  SET language_behavior_mode = 'target'
  WHERE language_behavior_mode IS NULL OR TRIM(language_behavior_mode) = ''
`).run();

await db.exec(`
  UPDATE segments
  SET protocol_delimiter = (
    SELECT ps.delimiter
    FROM protocol_occurrences po
    JOIN protocol_schemas ps ON ps.id = po.schema_id
    WHERE po.project_id = segments.project_id
      AND po.path_json = segments.path_json
      AND segments.start_pos >= po.start_pos
      AND segments.end_pos <= po.end_pos
    ORDER BY (po.end_pos - po.start_pos) ASC
    LIMIT 1
  )
  WHERE kind = 'protocol-field'
    AND COALESCE(protocol_delimiter, '') = ''
`);

await db.prepare("UPDATE jobs SET status = 'paused', updated_at = ? WHERE status = 'running'").run(now());

await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
await migrateLegacyStorage(db);
await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

export function id(): string {
  return randomUUID();
}

export function now(): string {
  return new Date().toISOString();
}

const settingsCache = new Map(
  (await db.prepare<{ key: string; value: string }>('SELECT key, value FROM settings').all())
    .map((row) => [row.key, row.value]),
);

export function setting(key: string): string | undefined {
  return settingsCache.get(key);
}

export async function saveSetting(key: string, value: string): Promise<void> {
  await db.prepare(`
    INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now());
  settingsCache.set(key, value);
}

async function addColumnIfMissing(table: string, column: string, definition: string): Promise<void> {
  const columns = await db.prepare<{ name: string }>(`PRAGMA table_info(${table})`).all();
  if (!columns.some((entry) => entry.name === column)) {
    await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export { resolveDatabaseWorkerCount } from './config.js';
