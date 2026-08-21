import type { AsyncDatabase } from '../async-db.js';
import { cardHash } from '../domain/card.js';

export interface CreateProjectInput {
  name: string;
  sourceFormat: string;
  card: Record<string, unknown>;
  module?: Record<string, unknown> | null;
  filename?: string;
  blob?: Uint8Array;
  metadataKeys?: string[];
}

export interface ProjectLanguageRoute {
  sourceLanguage: string;
  targetLanguage: string;
  languageBehaviorMode: string;
}

export interface ProjectServiceDependencies {
  database: AsyncDatabase;
  createId: () => string;
  clock: () => string;
  languageRoute: () => ProjectLanguageRoute;
}

export function createProjectService({
  database,
  createId,
  clock,
  languageRoute,
}: ProjectServiceDependencies) {
  async function createProject(options: CreateProjectInput): Promise<string> {
    const projectId = createId();
    const timestamp = clock();
    const route = languageRoute();
    await database.prepare(`
      INSERT INTO projects(
        id, name, source_format, source_language, target_language, language_behavior_mode, scope, status,
        original_hash, original_json, draft_json, original_module_json, draft_module_json,
        source_filename, source_blob, source_metadata_keys, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'all', 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      projectId, options.name, options.sourceFormat,
      route.sourceLanguage, route.targetLanguage, route.languageBehaviorMode, cardHash(options.card),
      JSON.stringify(options.card), JSON.stringify(options.card),
      options.module ? JSON.stringify(options.module) : null,
      options.module ? JSON.stringify(options.module) : null,
      options.filename || null,
      options.blob ? Buffer.from(options.blob) : null, JSON.stringify(options.metadataKeys || []), timestamp, timestamp,
    );
    return projectId;
  }

  return { createProject };
}
