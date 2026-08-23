import type { AsyncDatabase } from '../async-db.js';
import {
  applyApprovedSegments,
  bilingualModuleName,
  cardExportName,
  type ApplicableSegment,
  validateRisuControlReferences,
} from '../domain/card.js';
import { synchronizeRisuModuleLorebook, writeCardCharx } from '../domain/charx.js';
import { writeCardPng } from '../domain/png.js';
import { writeRisuModule } from '../domain/risum.js';
import { applyRisuModuleSegments, validateRisuLuaChanges } from '../domain/risu-lua.js';
import { validateRisuTemplateChanges } from '../domain/risu-qa.js';
import { applyApprovedResourceJson, replaceResourceBytes } from '../domain/resources.js';
import { PROJECT_TITLE_COLUMNS } from '../repositories/project-queries.js';
import { safeArray } from './review-metadata.js';
import { formatMissingProtectionDetails, type ApprovedProtectionIssue } from './review-service.js';

export interface ReviewValidationService {
  projectLanguageBehaviorIssue(projectId: string): Promise<string | null>;
  approvedSegmentProtectionIssue(projectId: string): Promise<ApprovedProtectionIssue | null>;
  resolveMirroredModuleLorebookFailures(projectId: string, card: Record<string, unknown>): Promise<void>;
}

export interface ExportServiceDependencies {
  database: AsyncDatabase;
  clock: () => string;
  targetLanguage: () => string;
  review: ReviewValidationService;
}

export class ProjectWorkflowError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly payload: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export interface ExportPayload {
  contentType: string;
  filename: string;
  body: Uint8Array | string;
}

export function createExportService({ database, clock, targetLanguage, review }: ExportServiceDependencies) {
  async function applyProject(projectId: string): Promise<{
    ok: true;
    approvedCount: number;
    ignoredLuaSegments: number;
  }> {
    const project = await database.prepare(`
      SELECT original_json, original_module_json, source_format AS sourceFormat, source_blob
      FROM projects WHERE id = ?
    `).get(projectId) as {
      original_json: string;
      original_module_json: string | null;
      sourceFormat: string;
      source_blob: Uint8Array | null;
    } | undefined;
    if (!project) throw new ProjectWorkflowError('项目不存在。', 404);

    await assertProjectCanApply(projectId, false);
    const segments = await database.prepare(`
      SELECT path_json AS pathJson, kind, source_text AS sourceText, start_pos AS start, end_pos AS end,
        translated_text AS translatedText, final_text AS finalText, review_status AS reviewStatus
      FROM segments WHERE project_id = ?
    `).all(projectId) as unknown as ApplicableSegment[];
    const cardSegments: ApplicableSegment[] = [];
    const moduleSegments: ApplicableSegment[] = [];
    const resourceSegments: ApplicableSegment[] = [];
    for (const segment of segments) {
      const path = JSON.parse(segment.pathJson) as Array<string | number>;
      if (path[0] === '$resource') resourceSegments.push(segment);
      else if (path[0] === '$module') moduleSegments.push({ ...segment, pathJson: JSON.stringify(path.slice(1)) });
      else cardSegments.push(segment);
    }

    const draft = applyApprovedSegments(JSON.parse(project.original_json), cardSegments);
    // Keep the large original archive out of SQLite when only card/module text
    // changed. Export falls back to source_blob in that case.
    const confirmedReplacements = await confirmedImageReplacements(projectId);
    const approvedResourceSegments = resourceSegments.filter((segment) => segment.reviewStatus === 'approved');
    const sourceChanges = approvedResourceSegments.length > 0 || confirmedReplacements.length > 0;
    let existingDraftSourceBlob: Uint8Array | null = null;
    if (sourceChanges) {
      const sourceRow = await database.prepare<{ draftSourceBlob: Uint8Array | null }>(
        'SELECT draft_source_blob AS draftSourceBlob FROM projects WHERE id = ?',
      ).get(projectId);
      existingDraftSourceBlob = sourceRow?.draftSourceBlob || null;
    }
    let draftSourceBlob: Uint8Array | null = sourceChanges
      ? (existingDraftSourceBlob || project.source_blob)
      : null;
    if (sourceChanges && draftSourceBlob) {
      if (approvedResourceSegments.length > 0) {
        draftSourceBlob = applyApprovedResourceJson(draftSourceBlob, approvedResourceSegments);
      }
      for (const replacement of confirmedReplacements) {
        draftSourceBlob = replaceResourceBytes(project.sourceFormat, draftSourceBlob, replacement.resourcePath, replacement.imageBlob);
      }
    }
    const originalModule = project.original_module_json
      ? JSON.parse(project.original_module_json) as Record<string, unknown>
      : null;
    if (moduleSegments.length && !originalModule) {
      throw new ProjectWorkflowError('项目缺少原始 Risu 模块，无法应用模块译文。请重新扫描项目。', 409);
    }
    const moduleResult = originalModule ? applyRisuModuleSegments(originalModule, moduleSegments) : null;
    if (moduleResult?.syntaxIssues.length) {
      const issue = moduleResult.syntaxIssues[0];
      throw new ProjectWorkflowError(`Risu Lua 语法校验失败：${issue.pathLabel} ${issue.message}`, 409);
    }
    const appliedModule = moduleResult?.draft ?? null;
    const draftModule = appliedModule && project.sourceFormat === 'charx'
      ? synchronizeRisuModuleLorebook(draft, appliedModule)
      : appliedModule;
    assertRisuIntegrity(JSON.parse(project.original_json) as Record<string, unknown>, draft, originalModule, draftModule, false);

    if (sourceChanges) {
      await database.prepare(`
        UPDATE projects
        SET draft_json = ?, draft_module_json = ?, draft_source_blob = ?, status = 'ready', updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(draft),
        draftModule ? JSON.stringify(draftModule) : null,
        draftSourceBlob ? Buffer.from(draftSourceBlob) : null,
        clock(),
        projectId,
      );
    } else {
      // Do not bind the existing archive again. SQLite can read a very large
      // BLOB, but rebinding it in the same UPDATE can exceed its value limit.
      await database.prepare(`
        UPDATE projects
        SET draft_json = ?, draft_module_json = ?, status = 'ready', updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(draft),
        draftModule ? JSON.stringify(draftModule) : null,
        clock(),
        projectId,
      );
    }
    if (project.sourceFormat === 'charx') await review.resolveMirroredModuleLorebookFailures(projectId, draft);
    return {
      ok: true,
      approvedCount: segments.filter((segment) => segment.reviewStatus === 'approved').length,
      ignoredLuaSegments: moduleResult?.ignoredLuaSegments ?? 0,
    };
  }

  async function exportProject(projectId: string): Promise<ExportPayload> {
    const project = await database.prepare(`
      SELECT p.name, p.source_format AS sourceFormat, p.source_blob AS sourceBlob,
        source_metadata_keys AS sourceMetadataKeys, original_json AS originalJson, draft_json AS draftJson,
        original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson,
        draft_source_blob AS draftSourceBlob,
        ${PROJECT_TITLE_COLUMNS}
      FROM projects p WHERE p.id = ?
    `).get(projectId) as {
      name?: string;
      sourceFormat?: string;
      sourceBlob?: Uint8Array;
      sourceMetadataKeys?: string;
      originalJson?: string;
      draftJson?: string;
      originalModuleJson?: string | null;
      draftModuleJson?: string | null;
      draftSourceBlob?: Uint8Array | null;
      originalName?: string | null;
      translatedName?: string | null;
    } | undefined;
    if (!project) throw new ProjectWorkflowError('项目不存在。', 404);

    await assertProjectCanApply(projectId, true);
    const draft = JSON.parse(project.draftJson || '{}') as Record<string, unknown>;
    const originalModule = project.originalModuleJson
      ? JSON.parse(project.originalModuleJson) as Record<string, unknown>
      : null;
    const storedDraftModule = project.draftModuleJson
      ? JSON.parse(project.draftModuleJson) as Record<string, unknown>
      : null;
    const draftModule = storedDraftModule && project.sourceFormat === 'charx'
      ? synchronizeRisuModuleLorebook(draft, storedDraftModule)
      : storedDraftModule;
    const exportCard = project.sourceFormat === 'risum' && draftModule
      ? { name: text(draftModule.name) || project.name || '' }
      : draft;
    const exportName = sanitizeFilename(cardExportName(
      exportCard,
      project.originalName || project.name || '',
      project.translatedName || '',
    ));
    const exportLanguage = exportLanguageTag(targetLanguage());
    const exportModule = draftModule && originalModule
      ? { ...draftModule, name: bilingualModuleName(text(draftModule.name), text(originalModule.name)) }
      : draftModule;
    assertRisuIntegrity(
      JSON.parse(project.originalJson || '{}') as Record<string, unknown>,
      draft,
      originalModule,
      draftModule,
      true,
    );

    if (project.sourceFormat === 'png' && project.sourceBlob) {
      const metadataKeys = safeArray(project.sourceMetadataKeys).map(String);
      return {
        contentType: 'image/png',
        filename: `${exportName}.${exportLanguage}.png`,
        body: writeCardPng(project.sourceBlob, draft, metadataKeys),
      };
    }
    if (project.sourceFormat === 'charx' && project.sourceBlob) {
      const resourceSource = await applyImageReplacements('charx', projectId, project.draftSourceBlob || project.sourceBlob);
      return {
        contentType: 'application/zip',
        filename: `${exportName}.${exportLanguage}.charx`,
        body: writeCardCharx(resourceSource, draft, exportModule),
      };
    }
    if (project.sourceFormat === 'risum' && project.sourceBlob && exportModule) {
      const resourceSource = await applyImageReplacements('risum', projectId, project.draftSourceBlob || project.sourceBlob);
      return {
        contentType: 'application/octet-stream',
        filename: `${exportName}.${exportLanguage}.risum`,
        body: writeRisuModule(resourceSource, exportModule),
      };
    }
    return {
      contentType: 'application/json; charset=utf-8',
      filename: `${exportName}.${exportLanguage}.json`,
      body: project.draftJson || '{}',
    };
  }

  async function assertProjectCanApply(projectId: string, exporting: boolean): Promise<void> {
    const languageIssue = await review.projectLanguageBehaviorIssue(projectId);
    if (languageIssue) throw new ProjectWorkflowError(languageIssue, 409);
    const approvedProtectionIssue = await review.approvedSegmentProtectionIssue(projectId);
    if (!approvedProtectionIssue) return;
    const detail = approvedProtectionIssue.details?.length
      ? ` 缺少内容：${formatMissingProtectionDetails(approvedProtectionIssue.details)}`
      : '';
    const prefix = exporting ? '拒绝导出' : '';
    const error = approvedProtectionIssue.reason
      ? `${prefix}${exporting ? '协议结构无效的卡片：' : ''}${approvedProtectionIssue.pathLabel}${exporting ? ' ' : '：'}${approvedProtectionIssue.reason}`
      : `${prefix}${exporting ? '受保护引用不完整的卡片：' : '受保护引用校验失败：'}${approvedProtectionIssue.pathLabel} 缺少 ${approvedProtectionIssue.missingCount} 个结构或脚本引用。${detail} 请回到审核项载入原文，只修改可见文字。`;
    throw new ProjectWorkflowError(error, 409, {
      code: approvedProtectionIssue.reason ? 'APPROVED_PROTECTION_INVALID' : 'PROTECTED_FRAGMENTS_MISSING',
      pathLabel: approvedProtectionIssue.pathLabel,
      missingFragments: approvedProtectionIssue.details ?? [],
    });
  }

  function assertRisuIntegrity(
    originalCard: Record<string, unknown>,
    draft: Record<string, unknown>,
    originalModule: Record<string, unknown> | null,
    draftModule: Record<string, unknown> | null,
    exporting: boolean,
  ): void {
    if (!originalModule || !draftModule) return;
    if (exporting) {
      const issues = validateRisuLuaChanges(originalModule, draftModule);
      if (issues.length) {
        throw new ProjectWorkflowError(`拒绝导出存在语法错误的 Risu Lua：${issues[0].pathLabel} ${issues[0].message}`, 409);
      }
    }
    const controlIssues = validateRisuControlReferences(originalCard, draft, originalModule, draftModule);
    if (controlIssues.length) {
      const prefix = exporting ? '拒绝导出脚本引用不完整的卡片：' : '脚本引用完整性校验失败：';
      throw new ProjectWorkflowError(`${prefix}${controlIssues[0].pathLabel} ${controlIssues[0].message}`, 409);
    }
    const templateIssues = validateRisuTemplateChanges(originalModule, draftModule);
    if (templateIssues.length) {
      const prefix = exporting ? '拒绝导出模板结构异常的卡片：' : 'Risu 模板结构校验失败：';
      throw new ProjectWorkflowError(`${prefix}${templateIssues[0].pathLabel} ${templateIssues[0].message}`, 409);
    }
  }

  async function confirmedImageReplacements(projectId: string): Promise<Array<{ resourcePath: string; imageBlob: Uint8Array }>> {
    return await database.prepare(`
      SELECT resource_path AS resourcePath, image_blob AS imageBlob FROM resource_image_candidates
      WHERE project_id = ? AND status = 'confirmed' ORDER BY resource_path
    `).all(projectId) as Array<{ resourcePath: string; imageBlob: Uint8Array }>;
  }

  async function applyImageReplacements(sourceFormat: string, projectId: string, source: Uint8Array): Promise<Uint8Array> {
    let replacementSource = source;
    for (const replacement of await confirmedImageReplacements(projectId)) {
      replacementSource = replaceResourceBytes(sourceFormat, replacementSource, replacement.resourcePath, replacement.imageBlob);
    }
    return replacementSource;
  }

  return { applyProject, exportProject };
}

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'translated-card';
}

function exportLanguageTag(value: string): string {
  return sanitizeFilename(value.trim() || 'target').replace(/\s+/g, '-');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
