import type { AsyncDatabase } from '../../async-db.js';
import type { CreateProjectInput } from './project-service.js';
import { matchVersionFields, type VersionField, type VersionMatch, type VersionSource } from '../../domain/card/version-matching.js';
import { missingProtectedFragments, type RisuControlReference } from '../../domain/card/card.js';
import { protectedTranslationFragments } from '../review/review-service.js';
import { protocolFieldReplacementIssue } from '../../domain/protocol/protocol.js';

interface VersionRow {
  id: string; familyId: string; versionNumber: number; versionLabel: string; baseVersionId: string | null;
  source_format: string; source_language: string; target_language: string; language_behavior_mode: string;
  scope: string; status: string; original_json: string; original_module_json: string | null;
}

export class ProjectVersionError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

interface ReusableField { current: VersionField; previous: VersionField; translation: string }

export function createProjectVersionService(deps: {
  database: AsyncDatabase;
  createProject(input: CreateProjectInput): Promise<string>;
  createId(): string;
  clock(): string;
  removeStorage(projectId: string): Promise<void>;
  controlReferencesForProject(projectId: string): Promise<RisuControlReference[]>;
}) {
  const { database, clock } = deps;
  const version = (id: string) => database.prepare<VersionRow>(`SELECT id, source_format, source_language, target_language, language_behavior_mode,
    scope, status, original_json, original_module_json, COALESCE(family_id, id) AS familyId,
    version_number AS versionNumber, version_label AS versionLabel, base_version_id AS baseVersionId FROM projects WHERE id = ?`).get(id);
  const fields = (id: string) => database.prepare<VersionField>('SELECT * FROM segments WHERE project_id = ? ORDER BY sort_order').all(id);
  const source = (row: VersionRow): VersionSource => ({ card: JSON.parse(row.original_json), module: row.original_module_json ? JSON.parse(row.original_module_json) : null });

  async function createVersion(baseId: string, label: string, input: CreateProjectInput): Promise<string> {
    if (label.trim().length > 80) throw new Error('版本名称最多 80 个字符。');
    let createdId: string | undefined;
    try {
      return await database.transaction(async () => {
        const base = await version(baseId);
        if (!base) throw new Error('作为基础的版本不存在。');
        const category = (format: string) => format === 'st-preset' ? 'preset' : format === 'risum' ? 'module' : 'card';
        if (category(base.source_format) !== category(input.sourceFormat)) throw new Error('新版本必须与当前项目类型一致（卡片、模块或预设）。');
        const latest = await database.prepare<{ maximum: number }>('SELECT MAX(version_number) AS maximum FROM projects WHERE COALESCE(family_id, id) = ?').get(base.familyId);
        const number = Number(latest?.maximum ?? 0) + 1;
        createdId = await deps.createProject(input);
        await database.prepare(`UPDATE projects SET family_id = ?, version_number = ?, version_label = ?, base_version_id = ?,
          source_language = ?, target_language = ?, language_behavior_mode = ?, scope = ? WHERE id = ?`).run(
          base.familyId, number, label.trim() || `V${number}`, baseId, base.source_language, base.target_language, base.language_behavior_mode, base.scope, createdId);
        const terms = await database.prepare('SELECT * FROM glossary_terms WHERE project_id = ?').all(baseId);
        for (const term of terms) await database.prepare(`INSERT INTO glossary_terms(id, project_id, source_text, target_text, notes, case_sensitive, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(deps.createId(), createdId, term.source_text, term.target_text, term.notes, term.case_sensitive, clock(), clock());
        return createdId;
      });
    } catch (error) {
      if (createdId) await deps.removeStorage(createdId);
      throw error;
    }
  }

  async function comparison(projectId: string, duringScan = false) {
    const current = await version(projectId);
    if (!current) throw new Error('版本不存在。');
    const previous = current.baseVersionId ? await version(current.baseVersionId) : undefined;
    if (!previous) return { current, previous, matches: [], compatible: true };
    const compatible = current.source_language === previous.source_language && current.target_language === previous.target_language
      && current.language_behavior_mode === previous.language_behavior_mode;
    const matches = current.status === 'new' && !duringScan ? []
      : matchVersionFields(await fields(projectId), await fields(previous.id), source(current), source(previous));
    return { current, previous, matches, compatible };
  }

  function reuseIssue(field: VersionField, translation: string, references: RisuControlReference[]): string | null {
    if (field.path_label === '$module.namespace' || field.path_label === 'namespace') return '内部命名空间需要单独确认';
    const path = JSON.parse(field.path_json) as Array<string | number>;
    if (missingProtectedFragments(field.source_text, translation, protectedTranslationFragments(field.source_text, references, path, field.kind)).length) return '旧译文缺少当前版本的保护内容';
    if (field.kind === 'protocol-field' && protocolFieldReplacementIssue(translation, field.protocol_delimiter || '', field.source_text)) return '旧译文不符合当前协议结构';
    return null;
  }

  function reusableFields(matches: VersionMatch[], references: RisuControlReference[]): ReusableField[] {
    return matches.flatMap(({ current, previous, status }) => {
      if (!current || !previous || status !== 'unchanged' || current.review_status !== 'untranslated'
        || current.translated_text !== null || current.final_text !== null) return [];
      const translation = previous.final_text?.trim() ? previous.final_text : previous.translated_text;
      if (!translation?.trim() || !['pending', 'approved'].includes(previous.review_status) || reuseIssue(current, translation, references)) return [];
      return [{ current, previous, translation }];
    });
  }

  async function writeReusedFields(baseVersionId: string, candidates: ReusableField[]): Promise<number> {
    let count = 0;
    for (const { current, previous, translation } of candidates) {
      const updated = await database.prepare(`UPDATE segments SET translated_text = ?, review_status = 'pending', updated_at = ?
        WHERE id = ? AND review_status = 'untranslated' AND translated_text IS NULL AND final_text IS NULL`).run(translation, clock(), current.id);
      if (!updated.changes) continue;
      await database.prepare(`INSERT INTO segment_version_origins(segment_id, base_version_id, base_segment_id, source_text, translation_text, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(segment_id) DO UPDATE SET base_version_id = excluded.base_version_id, base_segment_id = excluded.base_segment_id,
          source_text = excluded.source_text, translation_text = excluded.translation_text, created_at = excluded.created_at`)
        .run(current.id, baseVersionId, previous.id, previous.source_text, translation, clock());
      count += 1;
    }
    return count;
  }

  /** Called inside the scan transaction; only brand-new rows may receive reused drafts. */
  async function reuseAfterScan(projectId: string, newSegmentIds: readonly string[]): Promise<number> {
    if (!newSegmentIds.length) return 0;
    const result = await comparison(projectId, true);
    if (!result.previous || !result.compatible) return 0;
    const eligible = new Set(newSegmentIds);
    const references = await deps.controlReferencesForProject(projectId);
    return writeReusedFields(result.previous.id, reusableFields(result.matches, references).filter(item => eligible.has(item.current.id)));
  }

  async function reuseFromBase(projectId: string): Promise<{ reusedCount: number }> {
    return database.transaction(async () => {
      const current = await version(projectId);
      if (!current) throw new ProjectVersionError(404, '版本不存在。');
      if (current.status === 'new') throw new ProjectVersionError(409, '请先扫描当前版本，再补用旧版译文。');
      const active = await database.prepare("SELECT id FROM jobs WHERE project_id = ? AND status IN ('queued', 'running', 'paused') LIMIT 1").get(projectId);
      if (active) throw new ProjectVersionError(409, '请先结束当前翻译任务，再补用旧版译文。');
      const result = await comparison(projectId);
      if (!result.previous) throw new ProjectVersionError(409, '当前版本没有基础版本。');
      if (!result.compatible) throw new ProjectVersionError(409, '两个版本的语言设置不同，无法复用旧版译文。');
      const references = await deps.controlReferencesForProject(projectId);
      const reusedCount = await writeReusedFields(result.previous.id, reusableFields(result.matches, references));
      if (reusedCount) await database.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(clock(), projectId);
      return { reusedCount };
    });
  }

  async function describe(projectId: string, offset = 0, filter = 'all') {
    const { current, previous, matches, compatible } = await comparison(projectId);
    const versions = await database.prepare(`SELECT id, version_number AS versionNumber, version_label AS versionLabel,
      base_version_id AS baseVersionId, source_filename AS sourceFilename, created_at AS createdAt
      FROM projects WHERE COALESCE(family_id, id) = ? ORDER BY version_number DESC`).all(current.familyId);
    const origins = new Map((await database.prepare<{ segment_id: string; translation_text: string }>(`SELECT o.segment_id, o.translation_text FROM segment_version_origins o JOIN segments s ON s.id = o.segment_id WHERE s.project_id = ?`).all(projectId)).map(row => [row.segment_id, row.translation_text]));
    const reusableCount = compatible && previous && current.status !== 'new'
      ? reusableFields(matches, await deps.controlReferencesForProject(projectId)).length : 0;
    const activeJob = Boolean(await database.prepare("SELECT id FROM jobs WHERE project_id = ? AND status IN ('queued', 'running', 'paused') LIMIT 1").get(projectId));
    const counts = { unchanged: 0, changed: 0, added: 0, removed: 0, ambiguous: 0, reused: origins.size };
    for (const match of matches) counts[match.status] += 1;
    const filtered = matches.filter(match => filter === 'all' || (filter === 'reused' ? origins.has(match.current?.id || '') : filter === match.status));
    return { familyId: current.familyId, versions, baseVersionId: previous?.id ?? null, baseVersionLabel: previous?.versionLabel ?? null,
      compatible, scanned: current.status !== 'new', baseScanned: previous ? previous.status !== 'new' : false,
      counts, reusableCount, activeJob, total: filtered.length, offset, limit: 50,
      fields: filtered.slice(offset, offset + 50).map(match => ({ segmentId: match.current?.id ?? null,
        pathLabel: (match.current ?? match.previous)!.path_label, status: match.status, reused: origins.has(match.current?.id || ''),
        sourceText: match.current?.source_text ?? null, previousSourceText: match.previous?.source_text ?? null,
        previousTranslation: origins.get(match.current?.id || '') || match.previous?.final_text || match.previous?.translated_text || null })) };
  }

  async function deleteFamily(projectId: string, expectedVersionCount: number) {
    const ids = await database.transaction(async () => {
      const current = await version(projectId);
      if (!current) throw new ProjectVersionError(404, '项目不存在。');
      const versions = await database.prepare<{ id: string }>('SELECT id FROM projects WHERE COALESCE(family_id, id) = ? ORDER BY version_number DESC').all(current.familyId);
      if (versions.length !== expectedVersionCount) throw new ProjectVersionError(409, '项目版本数量已变化，请刷新后重新确认删除范围。');
      const active = await database.prepare(`SELECT j.id FROM jobs j JOIN projects p ON p.id = j.project_id
        WHERE COALESCE(p.family_id, p.id) = ? AND j.status IN ('queued', 'running', 'paused') LIMIT 1`).get(current.familyId);
      if (active) throw new ProjectVersionError(409, '项目仍有未结束的翻译任务，请先完成或取消所有版本的任务。');
      // Clear internal links together; external references still prevent deletion.
      await database.prepare('UPDATE projects SET base_version_id = NULL WHERE COALESCE(family_id, id) = ?').run(current.familyId);
      for (const row of versions) await database.prepare('DELETE FROM projects WHERE id = ?').run(row.id);
      return versions.map(row => row.id);
    });
    const cleanup = await Promise.allSettled(ids.map(id => deps.removeStorage(id)));
    return { deletedIds: ids, cleanupFailed: cleanup.filter(result => result.status === 'rejected').length };
  }

  return { createVersion, reuseAfterScan, reuseFromBase, describe, deleteFamily };
}
