import type { AsyncDatabase } from '../async-db.js';
import { addColumnIfMissing } from './schema-migration.js';

export async function migrateProjectVersions(database: AsyncDatabase): Promise<void> {
  await addColumnIfMissing(database, 'projects', 'family_id', 'TEXT');
  await addColumnIfMissing(database, 'projects', 'version_number', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnIfMissing(database, 'projects', 'version_label', "TEXT NOT NULL DEFAULT 'V1'");
  await addColumnIfMissing(database, 'projects', 'base_version_id', 'TEXT REFERENCES projects(id) ON DELETE RESTRICT');
  await database.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS projects_family_version_idx ON projects(COALESCE(family_id, id), version_number);
    CREATE TABLE IF NOT EXISTS segment_version_origins (
      segment_id TEXT PRIMARY KEY REFERENCES segments(id) ON DELETE CASCADE,
      base_version_id TEXT NOT NULL,
      base_segment_id TEXT NOT NULL,
      source_text TEXT NOT NULL,
      translation_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
}
