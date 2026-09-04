import type { AsyncDatabase } from '../../async-db.js';
import {
  applyApprovedSegments,
  bilingualModuleName,
  cardExportName,
  findRisuRegexAffectedSegmentIds,
  type ApplicableSegment,
  type RisuRegexValidationOverrides,
  validateRisuControlReferences,
} from '../../domain/card/card.js';
import { synchronizeRisuModuleLorebook, writeCardCharx } from '../../domain/card/charx.js';
import { writeCardPng } from '../../domain/card/png.js';
import { writeRisuModule } from '../../domain/card/risum.js';
import {
  applyRisuModuleSegments,
  collectRuntimeAliasCandidates,
  collectRuntimeAliasTranslationCandidates,
  detectRisuPortraitRouting,
  staleRisuModuleNamespaceProtocolPaths,
  validateRisuLuaChanges,
} from '../../domain/lua/risu-lua.js';
import { validateRisuTemplateChanges } from '../../domain/lua/risu-qa.js';
import { applyApprovedResourceJson, replaceResourceBytes } from '../../domain/resources/resources.js';
import { PROJECT_TITLE_COLUMNS } from '../../repositories/project-queries.js';
import { safeArray } from '../review/review-metadata.js';
import { formatMissingProtectionDetails, type ApprovedProtectionIssue } from '../review/review-service.js';
import { fileExtension, projectStoragePath, readStoredFile, storeFile } from '../../repositories/file-storage.js';

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
  segmentRuntimeNames?: (input: Array<{ ownerId: string; name: string }>) => Promise<Record<string, string[]>>;
  translateRuntimeAliases?: (input: Array<{ ownerId: string; aliases: string[] }>, targetLanguage: string) => Promise<Record<string, string[]>>;
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

function isModuleNamespaceSegment(
  segment: ApplicableSegment,
  path: Array<string | number>,
  originalModule: Record<string, unknown> | null,
): boolean {
  return path.length === 1
    && path[0] === 'namespace'
    && typeof originalModule?.namespace === 'string'
    && segment.sourceText === originalModule.namespace;
}

function findModuleNamespaceSegment(
  segments: readonly ApplicableSegment[],
  sourceNamespace: string,
): ApplicableSegment | undefined {
  return segments.find((segment) => {
    try {
      const path = JSON.parse(segment.pathJson) as unknown;
      return Array.isArray(path)
        && ((path.length === 2 && path[0] === '$module' && path[1] === 'namespace')
          || (path.length === 1 && path[0] === 'namespace'))
        && segment.sourceText === sourceNamespace;
    } catch {
      return false;
    }
  });
}

function assertRisuModuleNamespaceIntegrity(
  originalModule: Record<string, unknown> | null,
  draftModule: Record<string, unknown> | null,
  segments: readonly ApplicableSegment[],
  exporting: boolean,
): void {
  const sourceNamespace = typeof originalModule?.namespace === 'string' ? originalModule.namespace.trim() : '';
  if (!sourceNamespace) return;

  const namespaceSegment = findModuleNamespaceSegment(segments, sourceNamespace);
  const targetNamespace = (namespaceSegment?.finalText || namespaceSegment?.translatedText || '').trim();
  const segmentIds = namespaceSegment?.id ? [namespaceSegment.id] : [];
  const action = exporting ? '导出' : '应用';
  if (namespaceSegment?.reviewStatus !== 'approved' || !targetNamespace) {
    throw new ProjectWorkflowError(`模块命名空间「${sourceNamespace}」尚未审核。请先在审核页翻译或人工确认后再${action}。`, 409, {
      code: 'RISU_NAMESPACE_UNREVIEWED',
      pathLabel: '$module.namespace',
      affectedSegmentIds: segmentIds,
    });
  }

  const actualNamespace = typeof draftModule?.namespace === 'string' ? draftModule.namespace.trim() : '';
  if (actualNamespace !== targetNamespace) {
    throw new ProjectWorkflowError(`已审核的模块命名空间目标为「${targetNamespace}」，但当前 Lua 草稿仍为「${actualNamespace || '未设置'}」。请重新应用审核结果。`, 409, {
      code: 'RISU_NAMESPACE_NOT_APPLIED',
      pathLabel: '$module.namespace',
      affectedSegmentIds: segmentIds,
      expectedNamespace: targetNamespace,
      actualNamespace,
    });
  }

  // Keeping an internal namespace unchanged leaves its existing protocol
  // references correct. They are stale only after an approved rename.
  const stalePaths = targetNamespace !== sourceNamespace && draftModule
    ? staleRisuModuleNamespaceProtocolPaths(draftModule, sourceNamespace)
    : [];
  if (stalePaths.length) {
    throw new ProjectWorkflowError(`当前 Lua 草稿仍有 ${stalePaths.length} 处模块内部协议引用旧名称「${sourceNamespace}」。请重新应用审核结果。`, 409, {
      code: 'RISU_NAMESPACE_REFERENCE_STALE',
      pathLabel: '$module.namespace',
      affectedSegmentIds: segmentIds,
      stalePaths,
    });
  }
}

function parseRegexValidationOverrides(value: string | null | undefined): RisuRegexValidationOverrides {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, RisuRegexValidationOverrides[string]> = {};
    for (const [pathLabel, raw] of Object.entries(parsed)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      const originalMatchCount = Number(item.originalMatchCount);
      const draftMatchCount = Number(item.draftMatchCount);
      if (typeof item.pattern !== 'string' || !item.pattern) continue;
      if (!Number.isSafeInteger(originalMatchCount) || originalMatchCount < 0) continue;
      if (!Number.isSafeInteger(draftMatchCount) || draftMatchCount < 0) continue;
      result[pathLabel] = {
        pattern: item.pattern,
        originalMatchCount,
        draftMatchCount,
        confirmedAt: typeof item.confirmedAt === 'string' ? item.confirmedAt : '',
      };
    }
    return result;
  } catch {
    return {};
  }
}

export function createExportService({ database, clock, targetLanguage, review, segmentRuntimeNames, translateRuntimeAliases }: ExportServiceDependencies) {
  async function applyProject(projectId: string): Promise<{
    ok: true;
    approvedCount: number;
    ignoredLuaSegments: number;
    runtimeAliasAdditions: number;
    runtimeAliasTranslationError?: string;
    runtimeAliasSegmentationError?: string;
  }> {
    const project = await database.prepare(`
      SELECT original_json, original_module_json, draft_module_json AS draftModuleJson, source_format AS sourceFormat, source_filename AS sourceFilename,
        regex_validation_overrides AS regexValidationOverrides,
        source_blob, source_storage_path AS sourceStoragePath,
        draft_source_blob AS draftSourceBlob, draft_storage_path AS draftStoragePath
      FROM projects WHERE id = ?
    `).get(projectId) as {
      original_json: string;
      original_module_json: string | null;
      draftModuleJson: string | null;
      regexValidationOverrides: string | null;
      sourceFormat: string;
      sourceFilename: string | null;
      source_blob: Uint8Array | null;
      sourceStoragePath: string | null;
      draftSourceBlob: Uint8Array | null;
      draftStoragePath: string | null;
    } | undefined;
    if (!project) throw new ProjectWorkflowError('项目不存在。', 404);

    await assertProjectCanApply(projectId, false);
    const segments = await database.prepare(`
      SELECT id, path_json AS pathJson, path_label AS pathLabel, kind, source_text AS sourceText, start_pos AS start, end_pos AS end,
        translated_text AS translatedText, final_text AS finalText, review_status AS reviewStatus
      FROM segments WHERE project_id = ?
    `).all(projectId) as unknown as ApplicableSegment[];
    const originalModule = project.original_module_json
      ? JSON.parse(project.original_module_json) as Record<string, unknown>
      : null;
    const existingDraftModule = project.draftModuleJson
      ? JSON.parse(project.draftModuleJson) as Record<string, unknown>
      : null;
    const cardSegments: ApplicableSegment[] = [];
    const moduleSegments: ApplicableSegment[] = [];
    const resourceSegments: ApplicableSegment[] = [];
    for (const segment of segments) {
      const path = JSON.parse(segment.pathJson) as Array<string | number>;
      if (path[0] === '$resource') resourceSegments.push(segment);
      else if (path[0] === '$module' || isModuleNamespaceSegment(segment, path, originalModule)) {
        moduleSegments.push({ ...segment, pathJson: JSON.stringify(path[0] === '$module' ? path.slice(1) : path) });
      }
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
      existingDraftSourceBlob = project.draftSourceBlob || (project.draftStoragePath ? await readStoredFile(project.draftStoragePath) : null);
    }
    const originalSourceBlob = project.source_blob || (project.sourceStoragePath ? await readStoredFile(project.sourceStoragePath) : null);
    let draftSourceBlob: Uint8Array | null = sourceChanges
      ? (existingDraftSourceBlob || originalSourceBlob)
      : null;
    if (sourceChanges && draftSourceBlob) {
      if (approvedResourceSegments.length > 0) {
        draftSourceBlob = applyApprovedResourceJson(draftSourceBlob, approvedResourceSegments);
      }
      for (const replacement of confirmedReplacements) {
        draftSourceBlob = replaceResourceBytes(project.sourceFormat, draftSourceBlob, replacement.resourcePath, replacement.imageBlob);
      }
    }
    if (moduleSegments.length && !originalModule) {
      throw new ProjectWorkflowError('项目缺少原始 Risu 模块，无法应用模块译文。请重新扫描项目。', 409);
    }
    const currentTargetLanguage = targetLanguage();
    let runtimeAliases: Record<string, string[]> = {};
    let runtimeAliasTranslationError: string | undefined;
    let runtimeAliasSegmentationError: string | undefined;
    const portraitFeatureDetected = originalModule ? detectRisuPortraitRouting(originalModule).detected : false;
    if (originalModule && portraitFeatureDetected && /zh|中文|简体|繁体/iu.test(currentTargetLanguage)) {
      if (translateRuntimeAliases) {
        try {
          runtimeAliases = await translateRuntimeAliases(
            collectRuntimeAliasTranslationCandidates(existingDraftModule || originalModule, currentTargetLanguage),
            currentTargetLanguage,
          );
        } catch (error) {
          runtimeAliasTranslationError = error instanceof Error ? error.message : String(error);
        }
      }
      const candidates = [
        ...collectRuntimeAliasCandidates(originalModule, currentTargetLanguage, draft),
        ...Object.entries(runtimeAliases).flatMap(([ownerId, names]) => names.map((name) => ({ ownerId, name }))),
      ]
        .filter((candidate, index, all) => /[\u3400-\u9fff]/u.test(candidate.name) && candidate.name.length >= 4
          && all.findIndex((item) => item.ownerId === candidate.ownerId && item.name === candidate.name) === index)
        .slice(0, 80);
      try {
        const segments = segmentRuntimeNames ? await segmentRuntimeNames(candidates) : {};
        runtimeAliases = mergeRuntimeAliases(runtimeAliases, segments);
      } catch (error) {
        runtimeAliasSegmentationError = error instanceof Error ? error.message : String(error);
      }
    }
    // Stage 2 (Lua regex/keyword adaptation) writes additive changes directly
    // to draft_module_json. Rebuild from that draft so applying reviewed text
    // does not silently discard those changes.
    const moduleBase = existingDraftModule || originalModule;
    const moduleResult = moduleBase ? applyRisuModuleSegments(
      moduleBase,
      moduleSegments,
      portraitFeatureDetected ? currentTargetLanguage : '',
      portraitFeatureDetected ? draft : undefined,
      runtimeAliases,
    ) : null;
    if (moduleResult?.syntaxIssues.length) {
      const issue = moduleResult.syntaxIssues[0];
      throw new ProjectWorkflowError(`Risu Lua 语法校验失败：${issue.pathLabel} ${issue.message}`, 409, {
        code: 'RISU_LUA_SYNTAX_INVALID', pathLabel: issue.pathLabel,
        // Lua parser diagnostics point to a raw code line. Do not pretend a
        // nearby translated text segment is the failing line; the client opens
        // Lua management and uses pathJson + line for the direct editor.
        affectedSegmentIds: [],
        ...(issue.line ? { line: issue.line } : {}),
        ...(issue.column ? { column: issue.column } : {}),
        ...(issue.sourceLine ? { sourceLine: issue.sourceLine.slice(0, 500) } : {}),
        ...(issue.draftLine ? { draftLine: issue.draftLine.slice(0, 500) } : {}),
        problem: `Lua 语法错误：${issue.message}`,
        fixSuggestion: '请打开 脚本管理页，展开这条语法错误，按行号和列号人工检查当前稿错误行；只修改确认后的整行，保留 Lua 代码、引号、括号和字段分隔符，再保存并重新校验。系统不会自动改写这行。',
      });
    }
    const appliedModule = moduleResult?.draft ?? null;
    const draftModule = appliedModule && project.sourceFormat === 'charx'
      ? synchronizeRisuModuleLorebook(draft, appliedModule)
      : appliedModule;
    assertRisuModuleNamespaceIntegrity(originalModule, draftModule, segments, false);
    assertRisuIntegrity(
      JSON.parse(project.original_json) as Record<string, unknown>,
      draft,
      originalModule,
      draftModule,
      false,
      [...cardSegments, ...moduleSegments],
      parseRegexValidationOverrides(project.regexValidationOverrides),
    );

    let storedDraft: Awaited<ReturnType<typeof storeFile>> | null = null;
    if (sourceChanges && draftSourceBlob) {
      storedDraft = await storeFile(
        projectStoragePath(projectId, 'draft', fileExtension(project.sourceFilename, project.sourceFormat)),
        draftSourceBlob,
      );
    }
    if (sourceChanges) {
      await database.prepare(`
        UPDATE projects
        SET draft_json = ?, draft_module_json = ?, draft_source_blob = NULL,
          draft_storage_path = ?, draft_storage_bytes = ?, draft_storage_sha256 = ?,
          status = 'ready', updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(draft),
        draftModule ? JSON.stringify(draftModule) : null,
        storedDraft?.path || null, storedDraft?.bytes || null, storedDraft?.sha256 || null,
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
      runtimeAliasAdditions: moduleResult?.runtimeAliasAdditions ?? 0,
      ...(runtimeAliasTranslationError ? { runtimeAliasTranslationError } : {}),
      ...(runtimeAliasSegmentationError ? { runtimeAliasSegmentationError } : {}),
    };
  }

  async function exportProject(projectId: string): Promise<ExportPayload> {
    const project = await database.prepare(`
      SELECT p.name, p.source_format AS sourceFormat, p.source_filename AS sourceFilename, p.source_blob AS sourceBlob,
        p.source_storage_path AS sourceStoragePath, p.source_storage_bytes AS sourceBytes,
        source_metadata_keys AS sourceMetadataKeys, original_json AS originalJson, draft_json AS draftJson,
        original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson,
        regex_validation_overrides AS regexValidationOverrides,
        draft_source_blob AS draftSourceBlob, p.draft_storage_path AS draftStoragePath,
        ${PROJECT_TITLE_COLUMNS}
      FROM projects p WHERE p.id = ?
    `).get(projectId) as {
      name?: string;
      sourceFormat?: string;
      sourceFilename?: string | null;
      sourceBlob?: Uint8Array;
      sourceStoragePath?: string | null;
      sourceBytes?: number | null;
      sourceMetadataKeys?: string;
      originalJson?: string;
      draftJson?: string;
      originalModuleJson?: string | null;
      draftModuleJson?: string | null;
      regexValidationOverrides?: string | null;
      draftSourceBlob?: Uint8Array | null;
      draftStoragePath?: string | null;
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
    const namespaceSegments = await database.prepare(`
      SELECT id, path_json AS pathJson, path_label AS pathLabel, source_text AS sourceText,
        start_pos AS start, end_pos AS end, translated_text AS translatedText,
        final_text AS finalText, review_status AS reviewStatus
      FROM segments
      WHERE project_id = ? AND path_json IN (?, ?)
    `).all(
      projectId,
      JSON.stringify(['$module', 'namespace']),
      JSON.stringify(['namespace']),
    ) as unknown as ApplicableSegment[];
    assertRisuModuleNamespaceIntegrity(originalModule, draftModule, namespaceSegments, true);
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
      [],
      parseRegexValidationOverrides(project.regexValidationOverrides),
    );
    const sourceBlob = project.sourceBlob || (project.sourceStoragePath ? await readStoredFile(project.sourceStoragePath) : null);
    const draftSourceBlob = project.draftSourceBlob || (project.draftStoragePath ? await readStoredFile(project.draftStoragePath) : null);
    if (project.sourceFormat === 'png' && sourceBlob) {
      const metadataKeys = safeArray(project.sourceMetadataKeys).map(String);
      return {
        contentType: 'image/png',
        filename: `${exportName}.${exportLanguage}.png`,
        body: writeCardPng(sourceBlob, draft, metadataKeys),
      };
    }
    if (project.sourceFormat === 'charx' && sourceBlob) {
      const resourceSource = await applyImageReplacements('charx', projectId, draftSourceBlob || sourceBlob);
      return {
        contentType: 'application/zip',
        filename: `${exportName}.${exportLanguage}.charx`,
        body: writeCardCharx(resourceSource, draft, exportModule),
      };
    }
    if (project.sourceFormat === 'risum' && sourceBlob && exportModule) {
      const resourceSource = await applyImageReplacements('risum', projectId, draftSourceBlob || sourceBlob);
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
    cardSegments: readonly ApplicableSegment[] = [],
    regexValidationOverrides: RisuRegexValidationOverrides = {},
  ): void {
    if (!originalModule || !draftModule) return;
    if (exporting) {
      const issues = validateRisuLuaChanges(originalModule, draftModule);
      if (issues.length) {
        const issue = issues[0];
        throw new ProjectWorkflowError(`拒绝导出存在语法错误的 Risu Lua：${issue.pathLabel} ${issue.message}`, 409, {
          code: 'RISU_LUA_SYNTAX_INVALID',
          pathLabel: issue.pathLabel,
          affectedSegmentIds: [],
          ...(issue.line ? { line: issue.line } : {}),
          ...(issue.column ? { column: issue.column } : {}),
          ...(issue.sourceLine ? { sourceLine: issue.sourceLine.slice(0, 500) } : {}),
          ...(issue.draftLine ? { draftLine: issue.draftLine.slice(0, 500) } : {}),
          problem: `Lua 语法错误：${issue.message}`,
          fixSuggestion: '请在 脚本管理页展开对应错误，按错误行和列人工检查当前稿错误行，保留 Lua 代码、引号、括号和字段分隔符，只修正确认后的整行后再保存。系统不会自动改写这行。',
        });
      }
    }
    const controlIssues = validateRisuControlReferences(originalCard, draft, originalModule, draftModule, regexValidationOverrides);
    if (controlIssues.length) {
      const issue = controlIssues[0];
      const prefix = exporting ? '拒绝导出脚本引用不完整的卡片：' : '脚本引用完整性校验失败：';
      const payload = issue.code === 'REGEX_MATCH_COUNT_CHANGED'
        ? {
            code: issue.code,
            pathLabel: issue.pathLabel,
            pattern: issue.pattern,
            originalMatches: issue.originalMatches,
            draftMatches: issue.draftMatches,
            affectedSegmentIds: findRisuRegexAffectedSegmentIds(issue.pattern || '', cardSegments),
            problem: `${issue.pathLabel} 的正则实际命中数由 ${issue.originalMatches} 变为 ${issue.draftMatches}，当前稿中有部分文本不再符合该正则的输入格式。`,
            fixSuggestion: quoteSpacingRequired(issue.pattern || '')
              ? '这条规则首先要求“闭引号 + 至少一个空格”。请先在右侧“人工定稿”中把原文每个符合条件的闭引号后的空格保留下来，例如“你好” 下一句；中文排版不能压成“你好”下一句。只有空格和引号结构恢复后，才根据实际语义判断是否需要追加“说、说道、表示”等目标语言并列项；并列项不能补回已经删掉的空格命中。'
              : '翻译阶段会结合本卡片的原文、译文和正则上下文，由模型判断是否需要追加目标语言并列项；只追加模型确认的字面量，不会删除或重排原有规则。若模型判断不确定或命中数仍不一致，请在右侧“人工定稿”框对照左侧原文，保留同样的引号、空格、键名、分隔符和字段顺序后再保存。',
          }
        : {
            code: issue.code || 'RISU_SCRIPT_INTEGRITY_INVALID', pathLabel: issue.pathLabel,
            affectedSegmentIds: findIntegrityAffectedSegmentIds(issue.pathLabel, cardSegments),
            problem: issue.message,
            fixSuggestion: '请按已过滤的错误行逐条检查，保留原有键名、分隔符和字段顺序，只修正对应的可见文本后再保存。',
          };
      throw new ProjectWorkflowError(`${prefix}${issue.pathLabel} ${issue.message}`, 409, payload);
    }
    const templateIssues = validateRisuTemplateChanges(originalModule, draftModule);
    if (templateIssues.length) {
      const prefix = exporting ? '拒绝导出模板结构异常的卡片：' : 'Risu 模板结构校验失败：';
      const issue = templateIssues[0];
      throw new ProjectWorkflowError(`${prefix}${issue.pathLabel} ${issue.message}`, 409, {
        code: 'RISU_TEMPLATE_INVALID', pathLabel: issue.pathLabel,
        affectedSegmentIds: findIntegrityAffectedSegmentIds(issue.pathLabel, cardSegments),
        problem: issue.message,
        fixSuggestion: '请按已过滤的错误行检查模板标记、括号和属性值，只修改可见文本后再保存。',
      });
    }
  }

  function quoteSpacingRequired(pattern: string): boolean {
    return /\(\[”"」\]\)\[ \\t\]\+/.test(pattern);
  }

  function findIntegrityAffectedSegmentIds(pathLabel: string, segments: readonly ApplicableSegment[]): string[] {
    const errorLine = Number(pathLabel.match(/\[(\d+):\d+\]/u)?.[1] || 0) || null;
    const path = pathLabel.replace(/\s*\[\d+:\d+\].*$/u, '').trim();
    const matches = segments.filter((segment) => segment.id && (() => {
      try {
        const parsed = JSON.parse(segment.pathJson) as Array<string | number>;
        const raw = parsed.join('.');
        const labels = parsed[0] === '$module' ? [`模块.${parsed.slice(1).join('.')}`, raw] : [raw, `模块.${raw}`];
        return labels.some((label) => label === path);
      } catch { return false; }
    })());
    if (matches.length) {
      if (errorLine != null) {
        const nearest = matches.map((segment) => ({ segment, distance: Math.abs(Number(segment.pathLabel?.match(/行\s*(\d+)/u)?.[1] || 0) - errorLine) }))
          .sort((a, b) => a.distance - b.distance)[0];
        if (nearest) return [nearest.segment.id as string];
      }
      return matches.map((segment) => segment.id as string);
    }
    return segments.filter((segment) => segment.id && (() => {
      try {
        const parsed = JSON.parse(segment.pathJson) as Array<string | number>;
        const raw = parsed.join('.');
        const labels = parsed[0] === '$module' ? [`模块.${parsed.slice(1).join('.')}`, raw] : [raw, `模块.${raw}`];
        return labels.some((label) => label.startsWith(`${path}.`));
      } catch { return false; }
    })()).map((segment) => segment.id as string);
  }

  async function confirmedImageReplacements(projectId: string): Promise<Array<{ resourcePath: string; imageBlob: Uint8Array }>> {
    const rows = await database.prepare(`
      SELECT resource_path AS resourcePath, image_blob AS imageBlob, storage_path AS storagePath
      FROM resource_image_candidates
      WHERE project_id = ? AND status = 'confirmed' ORDER BY resource_path
    `).all(projectId) as Array<{ resourcePath: string; imageBlob: Uint8Array | null; storagePath: string | null }>;
    return await Promise.all(rows.map(async (row) => ({
      resourcePath: row.resourcePath,
      imageBlob: row.imageBlob || (row.storagePath ? await readStoredFile(row.storagePath) : (() => { throw new Error('图片替换稿文件不存在。'); })()),
    })));
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

function mergeRuntimeAliases(
  primary: Record<string, string[]>,
  secondary: Record<string, string[]>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  for (const [ownerId, aliases] of [...Object.entries(primary), ...Object.entries(secondary)]) {
    const current = merged[ownerId] ?? [];
    for (const alias of aliases) {
      if (!current.some((item) => item.toLocaleLowerCase() === alias.toLocaleLowerCase())) current.push(alias);
    }
    merged[ownerId] = current;
  }
  return merged;
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
