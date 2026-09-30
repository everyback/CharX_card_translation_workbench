import type { AsyncDatabase } from '../../async-db.js';

export interface JobLanguage {
  sourceLanguage: string;
  fallbackLanguage: string;
  targetLanguage: string;
  languageBehaviorMode: 'target' | 'preserve';
}

/** Return only the policy fields, never arbitrary persisted configuration. */
export function publicJobLanguage(value: unknown): JobLanguage | null {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object') return null;
    const row = parsed as Record<string, unknown>;
    if (![row.sourceLanguage, row.fallbackLanguage, row.targetLanguage].every(v => typeof v === 'string' && v.trim())
      || !['target', 'preserve'].includes(String(row.languageBehaviorMode))) return null;
    return { sourceLanguage: String(row.sourceLanguage), fallbackLanguage: String(row.fallbackLanguage),
      targetLanguage: String(row.targetLanguage), languageBehaviorMode: row.languageBehaviorMode as JobLanguage['languageBehaviorMode'] };
  } catch { return null; }
}

/** Only language policy is persisted here; provider credentials stay in settings. */
export async function projectJobLanguage(database: AsyncDatabase, projectId: string, defaults: JobLanguage): Promise<JobLanguage> {
  const project = await database.prepare(`SELECT source_language AS sourceLanguage, target_language AS targetLanguage,
    language_behavior_mode AS languageBehaviorMode FROM projects WHERE id = ?`).get(projectId) as Partial<JobLanguage> | undefined;
  return {
    sourceLanguage: project?.sourceLanguage || defaults.sourceLanguage,
    fallbackLanguage: defaults.fallbackLanguage,
    targetLanguage: project?.targetLanguage || defaults.targetLanguage,
    languageBehaviorMode: project?.languageBehaviorMode || defaults.languageBehaviorMode,
  };
}

export async function loadJobLanguage(database: AsyncDatabase, jobId: string, defaults: JobLanguage): Promise<JobLanguage> {
  return database.transaction(async () => {
    const job = await database.prepare('SELECT project_id AS projectId, language_config AS languageConfig FROM jobs WHERE id = ?')
      .get(jobId) as { projectId: string; languageConfig: string | null } | undefined;
    if (!job) throw new Error('任务不存在。');
    if (job.languageConfig) return JSON.parse(job.languageConfig) as JobLanguage;
    const language = await projectJobLanguage(database, job.projectId, defaults);
    await database.prepare('UPDATE jobs SET language_config = ? WHERE id = ?').run(JSON.stringify(language), jobId);
    return language;
  });
}
