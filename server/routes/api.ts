import { createJobLifecycleService } from '../application/translation/job-lifecycle-service.js';
import { projectJobLanguage } from '../application/translation/job-language.js';
import { registerJobRoutes } from './jobs.js';
import { loadReviewedDraft } from '../application/export/reviewed-draft.js';
import { ModuleReviewConflict } from '../domain/lua/module-review-base.js';
import { saveImageCandidate } from '../application/resources/image-candidate-service.js';
import { validateUploadedImage } from '../domain/resources/image-upload.js';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readWorkflowProgress } from '../repositories/workflow-progress.js';
import { publicJobLanguage } from '../application/translation/job-language.js';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply } from 'fastify';
import { db, id, now } from '../db.js';
import {
  cardName,
  applyRisuRegexAlternativeProposals,
  applyRisuRegexCoverageProposals,
  applyApprovedSegments,
  controlReferencesInText,
  countRegexMatchesInStrings,
  regexMatchSnippetsInStrings,
  isRisuDisplayFormattingRegexRule,
  isRisuOutputPostprocessRegexRule,
  isSafeRisuDisplayFormattingRegexChange,
  isRegexValidationOverrideActive,
  isZeroWidthCardinalityTrigger,
  missingProtectedFragments,
  risuControlReferences,
  risuTranslationControlFragments,
  scanCard,
  scanRisuModule,
  scanStPreset,
  validateRisuControlReferences,
  type RisuControlReference,
  type ApplicableSegment,
  type RisuRegexValidationOverride,
  type RisuRegexValidationOverrides,
  type ScopePreset,
} from '../domain/card/card.js';
import {
  findCharxCover,
  isRisuModuleLorebookMirrorPath,
  parseCharx,
} from '../domain/card/charx.js';
import { parseCardPng } from '../domain/card/png.js';
import { inspectProjectOverview } from '../domain/card/tavern-card.js';
import { parseRisuModule, readRisuModuleAssetFromReader, type RisuModuleSourceReader } from '../domain/card/risum.js';
import { analyzeStPreset, isSillyTavernPreset } from '../domain/card/st-preset.js';
import {
  SETVAR_DEFINITION_REMOVED,
  analyzePresetEditImpact,
  buildPresetProjectView,
  isEditablePresetPath,
  readPresetPath,
  validateEditedText,
  writePresetPath,
} from '../domain/card/st-preset-edit.js';
import { detectRisuRuntimeRisks, validateRisuTemplateChanges } from '../domain/lua/risu-qa.js';
import { buildLuaManagementReport } from '../domain/lua/lua-management.js';
import {
  applyPortraitRouterChangeOverrides,
  applyPortraitRouterRepairs,
  applyPortraitRouterReviewDelta,
  type PortraitRouterRepairChange,
  type PortraitRouterRepairOverride,
} from '../domain/lua/portrait-router-repair.js';
import { applyRisuModuleSegments, detectRisuPortraitRouting, replaceRisuLuaLine, validateRisuLuaChanges } from '../domain/lua/risu-lua.js';
import { inspectCharxResources, inspectRisuModuleResourcesStreaming, readResourceBytes, resourceContentType, scanCharxResourceJson } from '../domain/resources/resources.js';
import { editImageText } from '../domain/resources/image-edit.js';
import { protocolFieldReplacementIssue } from '../domain/protocol/protocol.js';
import {
  approvedProtocolRules,
  discoverAndStoreProtocols,
  listProtocolSchemas,
  protocolSchemasForAnalysis,
  setProtocolAnalysisError,
  updateProtocolAnalysis,
  updateProtocolSchema,
} from '../application/protocol/protocol-service.js';
import { abortJob, analyzeProtocolSemantics, analyzeRisuRegexLanguageCoverage, buildRegexWhitespaceProbe, collectRegexCoveragePairs, collectRegexCoveragePairsWithPatterns, privateImageSettings, publicSettings, recoverInterruptedJobs, regexLanguagePayloadSummary, scheduleJob, segmentRuntimeNames, splitRegexLanguageEntries, translateRuntimeAliases, type RisuRegexLanguageEntry } from '../scheduler.js';
import { languageBehaviorDirectiveIssue } from '../domain/translation/language-directives.js';
import { workbenchConfig } from '../../config/workbench.js';
import { PROJECT_TITLE_COLUMNS, PROJECT_VERSION_COLUMNS } from '../repositories/project-queries.js';
import { createProjectVersionService, ProjectVersionError } from '../application/projects/project-version-service.js';
import { createScanService } from '../application/scanning/scan-service.js';
import { createProjectService } from '../application/projects/project-service.js';
import { createTranslationJobService } from '../application/translation/translation-job-service.js';
import { createExportService, ProjectWorkflowError } from '../application/export/export-service.js';
import { createNamespaceReviewService } from '../application/export/namespace-review-service.js';
import {
  createReviewService,
  describeMissingProtectedFragments,
  protectedTranslationFragments,
} from '../application/review/review-service.js';
import {
  hasLanguageBehaviorConfirmation,
  hasProtectionConfirmation,
  isReviewProblemQaFlag,
  LANGUAGE_BEHAVIOR_CONFIRMATION_FLAG,
  parsePathJson,
  protectionConfirmationFlag,
  PROTECTION_CONFIRMATION_FLAG_PREFIX,
  safeArray,
} from '../application/review/review-metadata.js';
import { registerInspectionRoutes } from './inspection.js';
import { registerSystemRoutes } from './system.js';
import { registerPatchRoutes } from './patches.js';
import { registerRemotePatchRoutes } from './remote-patches.js';
import { readStoredFile, readStoredFileRange, storeFile, projectStoragePath, imageExtension, removeProjectStorage, removeStoredFile } from '../repositories/file-storage.js';
import {
  isUploadTooLargeError,
  uploadLimitBytes,
  uploadTooLargeMessage,
} from '../utils/uploads/upload-limit.js';

const uploadLimitMib = workbenchConfig.uploadLimitMib;
const uploadBytes = uploadLimitBytes(uploadLimitMib);
const app = Fastify({ logger: true, bodyLimit: uploadBytes });
await app.register(multipart, { limits: { fileSize: uploadBytes, files: 1 } });
const controlReferenceCache = new Map<string, RisuControlReference[]>();
const translationJobs = createTranslationJobService({ database: db, createId: id, clock: now,
  captureLanguage: projectId => projectJobLanguage(db, projectId, publicSettings()),
});
const scanService = createScanService({
  database: db,
  createId: id,
  clock: now,
  refreshHistoricalJobsAfterScan: translationJobs.refreshHistoricalJobsAfterScan,
  reuseVersionTranslations: (projectId, ids) => versionService.reuseAfterScan(projectId, ids),
});
const projectService = createProjectService({
  database: db,
  createId: id,
  clock: now,
  languageRoute: publicSettings,
});
const namespaceReviewService = createNamespaceReviewService({ database: db, createId: id, clock: now });
const { createProject } = projectService;
const versionService = createProjectVersionService({ database: db, createProject, createId: id, clock: now,
  removeStorage: removeProjectStorage, controlReferencesForProject });
const reviewService = createReviewService({
  database: db,
  clock: now,
  publicSettings,
  controlReferencesForProject,
  cancelActiveJobItemsForManualReview: translationJobs.cancelActiveJobItemsForManualReview,
  resolveFailedJobItems: translationJobs.resolveFailedJobItems,
});
const exportService = createExportService({
  database: db,
  clock: now,
  targetLanguage: () => publicSettings().targetLanguage,
  review: reviewService,
});

registerJobRoutes(app, createJobLifecycleService({
  database: db, clock: now, jobById: translationJobs.jobById, abortJob, scheduleJob,
}));
registerSystemRoutes(app);
registerPatchRoutes(app);
registerRemotePatchRoutes(app);

app.post('/api/projects', async (request, reply) => {
  const body = asRecord(request.body);
  const card = asRecord(body.card);
  if (!Object.keys(card).length) return reply.code(400).send({ error: '卡片 JSON 必须是对象。' });
  const name = text(body.name) || cardName(card);
  const sourceFormat = text(body.sourceFormat) || 'json';
  try {
    const input = { name, sourceFormat, card };
    const projectId = text(body.baseVersionId)
      ? await versionService.createVersion(text(body.baseVersionId), text(body.versionLabel), input)
      : await createProject(input);
    return reply.code(201).send(await projectById(projectId));
  } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
});

app.post<{ Querystring: { baseVersionId?: string; versionLabel?: string } }>('/api/projects/import', async (request, reply) => {
  const importProject: typeof createProject = input => request.query.baseVersionId
    ? versionService.createVersion(request.query.baseVersionId, request.query.versionLabel || '', input)
    : createProject(input);
  let part: multipart.MultipartFile | undefined;
  let buffer: Buffer;
  try {
    part = await request.file();
    if (!part) return reply.code(400).send({ error: '请选择 JSON、PNG、CHARX 或 RISUM 文件。' });
    buffer = await part.toBuffer();
  } catch (error) {
    if (isUploadTooLargeError(error)) {
      return reply.code(413).send({ error: uploadTooLargeMessage(uploadLimitMib) });
    }
    throw error;
  }
  const extension = path.extname(part.filename).toLowerCase();
  try {
    if (extension === '.json' || part.mimetype === 'application/json') {
      const parsedJson = JSON.parse(buffer.toString('utf8'));
      const card = asRecord(parsedJson);
      if (!Object.keys(card).length) return reply.code(400).send({ error: 'JSON 卡片必须是对象。' });
      if (isSillyTavernPreset(card)) {
        // Stored as the raw ST preset so segment paths stay `["prompts", N, "content"]`
        // and the approved-translation pipeline applies without adaptation. The
        // `.risup` container is produced at export time from the translated draft.
        const presetName = text(card.name) || path.basename(part.filename, extension) || 'SillyTavern 预设';
        const analysis = analyzeStPreset(card);
        const projectId = await importProject({
          name: presetName, sourceFormat: 'st-preset', card, filename: part.filename, blob: buffer,
        });
        return reply.code(201).send({
          ...(await projectById(projectId)),
          conversion: {
            warnings: analysis.warnings,
            blocks: analysis.blocks,
            recommendedBlockIndex: analysis.recommendedBlockIndex,
            promptCount: analysis.promptCount,
            orphanCount: analysis.orphanCount,
          },
        });
      }
      const projectId = await importProject({ name: cardName(card), sourceFormat: 'json', card, filename: part.filename });
      return reply.code(201).send(await projectById(projectId));
    }
    if (extension === '.png' || part.mimetype === 'image/png') {
      const parsed = parseCardPng(buffer);
      const projectId = await importProject({
        name: cardName(parsed.card), sourceFormat: 'png', card: parsed.card,
        filename: part.filename, blob: buffer, metadataKeys: parsed.metadataKeys,
      });
      return reply.code(201).send(await projectById(projectId));
    }
    if (extension === '.charx') {
      const parsed = parseCharx(buffer);
      const projectId = await importProject({
        name: cardName(parsed.card), sourceFormat: 'charx', card: parsed.card,
        module: parsed.module, filename: part.filename, blob: buffer,
      });
      return reply.code(201).send(await projectById(projectId));
    }
    if (extension === '.risum') {
      const parsed = parseRisuModule(buffer);
      const name = text(parsed.module.name) || path.basename(part.filename, extension) || '未命名模块';
      const projectId = await importProject({
        name, sourceFormat: 'risum', card: { name }, module: parsed.module,
        filename: part.filename, blob: buffer,
      });
      return reply.code(201).send(await projectById(projectId));
    }
    return reply.code(415).send({ error: '当前支持 JSON、PNG、CHARX 和 RISUM 模块。' });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

registerInspectionRoutes(app, uploadLimitMib, { createProject, projectById, cardName });

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/versions/reuse', async (request, reply) => {
  try { return await versionService.reuseFromBase(request.params.projectId); }
  catch (error) {
    if (error instanceof ProjectVersionError) return reply.code(error.statusCode).send({ error: error.message });
    throw error;
  }
});

app.get<{ Params: { projectId: string }; Querystring: { offset?: string; filter?: string } }>('/api/projects/:projectId/versions', async (request, reply) => {
  if (!await projectById(request.params.projectId)) return reply.code(404).send({ error: '项目不存在。' });
  const offset = Number(request.query.offset || 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return reply.code(400).send({ error: '分页偏移无效。' });
  return versionService.describe(request.params.projectId, offset, request.query.filter);
});

app.get<{ Params: { projectId: string }; Querystring: { segments?: string } }>('/api/projects/:projectId', async (request, reply) => {
  await namespaceReviewService.ensureReviewItem(request.params.projectId);
  const project = await projectById(request.params.projectId);
  if (!project) return reply.code(404).send({ error: '项目不存在。' });
  const controlReferences = await controlReferencesForProject(request.params.projectId);
  const includeSegments = request.query.segments !== 'none';
  const segments = includeSegments
    ? await projectSegments(request.params.projectId, controlReferences)
    : [];
  const jobs = await db.prepare(`
    SELECT
      id, project_id AS projectId, status, scope, model, language_config AS languageConfig,
      total_items AS totalItems,
      completed_items AS completedItems,
      failed_items AS failedItems,
      post_total_items AS postTotalItems,
      post_completed_items AS postCompletedItems,
      post_failed_items AS postFailedItems,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM jobs WHERE project_id = ? ORDER BY CASE WHEN status IN ('queued','running','paused') THEN 0 ELSE 1 END, created_at DESC, rowid DESC LIMIT 20
  `).all(request.params.projectId);
  const originalModuleRow = await db.prepare('SELECT original_module_json AS originalModuleJson FROM projects WHERE id = ?')
    .get(request.params.projectId) as { originalModuleJson?: string | null } | undefined;
  let runtimeRisks: ReturnType<typeof detectRisuRuntimeRisks> = [];
  if (originalModuleRow?.originalModuleJson) {
    try {
      runtimeRisks = detectRisuRuntimeRisks(JSON.parse(originalModuleRow.originalModuleJson) as Record<string, unknown>);
    } catch {
      runtimeRisks = [];
    }
  }
  const scanSummary = includeSegments
    ? scanSummaryFromSegments(segments)
    : await projectSegmentSummary(request.params.projectId);
  const progress = (await readWorkflowProgress(db, request.params.projectId)).get(request.params.projectId);
  return {
    ...project,
    ...progress,
    controlReferences: controlReferences.map((reference) => ({
      literal: reference.literal,
      kind: reference.kind,
      pathLabel: reference.pathLabel,
      pattern: reference.pattern,
    })),
    segments,
    jobs: jobs.map(job => ({ ...job, languageConfig: publicJobLanguage(job.languageConfig) })),
    scanSummary: {
      ...scanSummary,
      runtimeRiskCount: runtimeRisks.length,
      runtimeRiskMessages: runtimeRisks.map((risk) => `${risk.pathLabel}：${risk.message}`),
    },
  };
});

app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/overview', async (request, reply) => {
  const row = await db.prepare(`
    SELECT source_format AS sourceFormat, source_filename AS sourceFilename,
      source_metadata_keys AS sourceMetadataKeys,
      COALESCE(source_storage_bytes, length(source_blob)) AS sourceBytes,
      source_blob AS sourceBlob, source_storage_path AS sourceStoragePath,
      original_json AS originalJson, original_module_json AS originalModuleJson
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as {
    sourceFormat?: string;
    sourceFilename?: string | null;
    sourceMetadataKeys?: string;
    sourceBytes?: number | null;
    sourceBlob?: Uint8Array | null;
    sourceStoragePath?: string | null;
    originalJson?: string;
    originalModuleJson?: string | null;
  } | undefined;
  if (!row?.originalJson) return reply.code(404).send({ error: '项目不存在或缺少原始卡片数据。' });
  try {
    const card = JSON.parse(row.originalJson) as Record<string, unknown>;
    const module = row.originalModuleJson
      ? JSON.parse(row.originalModuleJson) as Record<string, unknown>
      : null;
    const sourceFormat = row.sourceFormat || 'json';
    const sourceBlob = sourceFormat === 'charx'
      ? (row.sourceBlob && row.sourceBlob.length > 0
        ? row.sourceBlob
        : row.sourceStoragePath ? await readStoredFile(row.sourceStoragePath) : null)
      : null;
    const inspection = inspectProjectOverview(
      card,
      module,
      sourceFormat,
      safeArray(row.sourceMetadataKeys).map(String),
    );
    return reply.header('Cache-Control', 'private, max-age=300').send({
      projectId: request.params.projectId,
      filename: row.sourceFilename ?? null,
      sourceFormat,
      fileBytes: Number(row.sourceBytes) || inspection.jsonBytes + inspection.moduleJsonBytes,
      previewAvailable: sourceFormat === 'png' && Number(row.sourceBytes) > 0
        || sourceFormat === 'charx' && Boolean(sourceBlob && findCharxCover(sourceBlob)),
      ...inspection,
    });
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/cover', async (request, reply) => {
  const row = await db.prepare(`
    SELECT source_format AS sourceFormat, source_blob AS sourceBlob, source_storage_path AS sourceStoragePath
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as { sourceFormat?: string; sourceBlob?: Uint8Array | null; sourceStoragePath?: string | null } | undefined;
  if (!row) return reply.code(404).send({ error: '项目不存在。' });
  const sourceBlob = row.sourceBlob && row.sourceBlob.length > 0
    ? row.sourceBlob
    : row.sourceStoragePath ? await readStoredFile(row.sourceStoragePath) : null;
  if (row.sourceFormat === 'charx' && sourceBlob) {
    const cover = findCharxCover(sourceBlob);
    if (cover) {
      return reply.header('Content-Type', cover.mimeType)
        .header('Cache-Control', 'private, max-age=3600')
        .send(cover.bytes);
    }
  }
  if (row.sourceFormat !== 'png' || !sourceBlob) {
    return reply.code(404).send({ error: '当前项目没有可直接显示的封面。' });
  }
  return reply
    .header('Content-Type', 'image/png')
    .header('Cache-Control', 'private, max-age=3600')
    .send(sourceBlob);
});

app.get<{
  Params: { projectId: string };
  Querystring: { offset?: string; limit?: string };
}>('/api/projects/:projectId/segments', async (request, reply) => {
  const project = await projectById(request.params.projectId);
  if (!project) return reply.code(404).send({ error: '项目不存在。' });
  await namespaceReviewService.ensureReviewItem(request.params.projectId);
  const offset = nonNegativeInteger(request.query.offset, 0);
  const limit = Math.min(1000, positiveIntegerQuery(request.query.limit, 500));
  const controlReferences = await controlReferencesForProject(request.params.projectId);
  const [segments, summary] = await Promise.all([
    projectSegments(request.params.projectId, controlReferences, limit, offset),
    projectSegmentSummary(request.params.projectId),
  ]);
  return { offset, limit, total: summary.totalSegments, segments };
});

app.patch<{ Params: { projectId: string } }>('/api/projects/:projectId/language-rule', async (request, reply) => {
  if (!await projectById(request.params.projectId)) return reply.code(404).send({ error: '项目不存在。' });
  if (await translationJobs.hasActiveTranslationJob(request.params.projectId)) return reply.code(409).send({ error: '请先完成或取消当前任务，再修改项目语言设定。' });
  const body = asRecord(request.body);
  const mode = body.mode === 'preserve' ? 'preserve' : body.mode === 'target' ? 'target' : '';
  if (!mode) return reply.code(400).send({ error: '卡片语言设定模式无效。' });
  await db.prepare('UPDATE projects SET language_behavior_mode = ?, updated_at = ? WHERE id = ?')
    .run(mode, now(), request.params.projectId);
  return await projectById(request.params.projectId);
});

app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/resources', async (request, reply) => {
  const row = await db.prepare(`
    SELECT source_format AS sourceFormat, source_filename AS sourceFilename,
      CASE WHEN source_format = 'risum' THEN NULL ELSE source_blob END AS sourceBlob,
      source_storage_path AS sourceStoragePath,
      COALESCE(source_storage_bytes, length(source_blob)) AS sourceBytes,
      original_json AS originalJson, original_module_json AS originalModuleJson
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as {
    sourceFormat?: string;
    sourceFilename?: string | null;
    sourceBlob?: Uint8Array | null;
    sourceStoragePath?: string | null;
    sourceBytes?: number | null;
    originalJson?: string;
    originalModuleJson?: string | null;
  } | undefined;
  if (!row) return reply.code(404).send({ error: '项目不存在。' });
  try {
    const card = JSON.parse(row.originalJson || '{}') as Record<string, unknown>;
    const module = row.originalModuleJson ? JSON.parse(row.originalModuleJson) as Record<string, unknown> : null;
    let inspection;
    const sourceBlob = row.sourceBlob || (row.sourceStoragePath ? await readStoredFile(row.sourceStoragePath) : null);
    if (row.sourceFormat === 'charx' && sourceBlob) {
      inspection = inspectCharxResources(sourceBlob, card, module, row.sourceFilename ?? null);
    } else if (row.sourceFormat === 'risum' && module) {
      inspection = await inspectRisuModuleResourcesStreaming(
        module,
        row.sourceFilename ?? null,
        projectRisuSourceReader(request.params.projectId, Number(row.sourceBytes) || 0),
      );
    } else {
      inspection = {
      sourceFormat: row.sourceFormat || 'unknown',
      sourceFilename: row.sourceFilename ?? null,
      resources: [],
      summary: { total: 0, images: 0, suspectedText: 0, referenced: 0 },
      };
    }
    const imageCandidates = await db.prepare(`
      SELECT resource_path AS resourcePath, mime_type AS mimeType, model, prompt, status, updated_at AS updatedAt
      FROM resource_image_candidates WHERE project_id = ?
    `).all(request.params.projectId) as Array<{
      resourcePath: string;
      mimeType: string;
      model: string;
      prompt: string;
      status: 'draft' | 'confirmed';
      updatedAt: string;
    }>;
    const imageCandidateMap = new Map(imageCandidates.map((candidate) => [candidate.resourcePath, candidate]));
    return {
      ...inspection,
      resources: inspection.resources.map((resource) => {
        const imageCandidate = imageCandidateMap.get(resource.path);
        return imageCandidate ? {
          ...resource,
          ...(imageCandidate ? { imageCandidate: {
            mimeType: imageCandidate.mimeType,
            model: imageCandidate.model,
            prompt: imageCandidate.prompt,
            status: imageCandidate.status,
            updatedAt: imageCandidate.updatedAt,
          } } : {}),
        } : resource;
      }),
    };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { projectId: string }; Querystring: { path?: string } }>('/api/projects/:projectId/resources/image-edit', async (request, reply) => {
  const manualUpload = request.isMultipart();
  const resourcePath = manualUpload ? text(request.query.path) : text(asRecord(request.body).path);
  if (!resourcePath) return reply.code(400).send({ error: '缺少资源路径。' });
  const row = await db.prepare(`
    SELECT source_format AS sourceFormat,
      CASE WHEN source_format = 'risum' THEN NULL ELSE source_blob END AS sourceBlob,
      source_storage_path AS sourceStoragePath,
      COALESCE(source_storage_bytes, length(source_blob)) AS sourceBytes, target_language AS targetLanguage
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as { sourceFormat?: string; sourceBlob?: Uint8Array | null; sourceStoragePath?: string | null; sourceBytes?: number; targetLanguage?: string } | undefined;
  if (!row) return reply.code(404).send({ error: '项目不存在。' });
  if (!row.sourceFormat || (!row.sourceBlob && !row.sourceBytes)) return reply.code(409).send({ error: '当前项目没有保存原始资源。' });
  try {
    const bytes = await projectResourceBytes(request.params.projectId, row.sourceFormat, row.sourceBlob, row.sourceBytes, resourcePath);
    const mimeType = resourceContentType(resourcePath, bytes);
    if (!mimeType.startsWith('image/')) return reply.code(400).send({ error: '只有图片资源支持 AI 图片汉化。' });
    let result: { bytes: Buffer; mimeType: string };
    let model: string;
    let prompt: string;
    if (manualUpload) {
      const part = await request.file();
      if (!part) return reply.code(400).send({ error: '请选择要上传的图片。' });
      result = validateUploadedImage(await part.toBuffer());
      model = 'manual-upload';
      prompt = '手动上传替换图片';
    } else {
      const imageSettings = privateImageSettings();
      const targetLanguage = row.targetLanguage || publicSettings().targetLanguage;
      result = await editImageText(bytes, mimeType, targetLanguage, imageSettings);
      model = imageSettings.model;
      prompt = `仅将画面文字替换为 ${targetLanguage}，保持其他视觉内容不变。`;
    }
    return await saveImageCandidate({ database: db, id, now, storeFile, removeStoredFile }, {
      projectId: request.params.projectId, resourcePath, ...result, model, prompt,
    });
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.patch<{ Params: { projectId: string } }>('/api/projects/:projectId/resources/image-edit', async (request, reply) => {
  const body = asRecord(request.body);
  const resourcePath = text(body.path);
  const status = body.status === 'confirmed' ? 'confirmed' : 'draft';
  if (!resourcePath) return reply.code(400).send({ error: '缺少资源路径。' });
  const timestamp = now();
  const result = await db.prepare(`UPDATE resource_image_candidates SET status = ?, updated_at = ? WHERE project_id = ? AND resource_path = ?`)
    .run(status, timestamp, request.params.projectId, resourcePath);
  if (!result.changes) return reply.code(404).send({ error: '请先生成或上传图片替换稿。' });
  return { ok: true, path: resourcePath, status, updatedAt: timestamp };
});

app.get<{ Params: { projectId: string }; Querystring: { path?: string } }>('/api/projects/:projectId/resources/image-edit/file', async (request, reply) => {
  const resourcePath = text(request.query.path);
  const row = await db.prepare(`
    SELECT mime_type AS mimeType, image_blob AS imageBlob, storage_path AS storagePath FROM resource_image_candidates
    WHERE project_id = ? AND resource_path = ?
  `).get(request.params.projectId, resourcePath) as { mimeType?: string; imageBlob?: Uint8Array | null; storagePath?: string | null } | undefined;
  const imageBlob = row?.storagePath ? await readStoredFile(row.storagePath) : row?.imageBlob;
  if (!imageBlob) return reply.code(404).send({ error: '图片替换稿不存在。' });
  return reply.header('Content-Type', row?.mimeType || 'image/png').send(Buffer.from(imageBlob));
});

app.get<{ Params: { projectId: string }; Querystring: { path?: string; name?: string } }>(
  '/api/projects/:projectId/resources/file',
  async (request, reply) => {
    const entryPath = text(request.query.path);
    if (!entryPath) return reply.code(400).send({ error: '缺少资源路径。' });
    const row = await db.prepare(`SELECT source_format AS sourceFormat,
      CASE WHEN source_format = 'risum' THEN NULL ELSE source_blob END AS sourceBlob,
      source_storage_path AS sourceStoragePath,
      COALESCE(source_storage_bytes, length(source_blob)) AS sourceBytes FROM projects WHERE id = ?`)
      .get(request.params.projectId) as { sourceFormat?: string; sourceBlob?: Uint8Array | null; sourceStoragePath?: string | null; sourceBytes?: number } | undefined;
    if (!row) return reply.code(404).send({ error: '项目不存在。' });
    if (!row.sourceBlob && !row.sourceBytes) return reply.code(404).send({ error: '当前项目没有保存原始资源。' });
    try {
      const output = await projectResourceBytes(request.params.projectId, row.sourceFormat || '', row.sourceBlob, row.sourceBytes, entryPath);
      return reply
        .header('Content-Type', resourceContentType(entryPath, output))
        .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(text(request.query.name) || entryPath))}`)
        .send(output);
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  },
);

app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/protocols', async (request, reply) => {
  if (!await projectById(request.params.projectId)) return reply.code(404).send({ error: '项目不存在。' });
  return await listProtocolSchemas(request.params.projectId);
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/protocols/discover', async (request, reply) => {
  const source = await protocolSourceByProject(request.params.projectId);
  if (!source) return reply.code(404).send({ error: '项目不存在。' });
  const result = await discoverAndStoreProtocols(request.params.projectId, source.card, source.module);
  return { ok: true, ...result, protocols: await listProtocolSchemas(request.params.projectId) };
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/protocols/analyze', async (request, reply) => {
  if (!await projectById(request.params.projectId)) return reply.code(404).send({ error: '项目不存在。' });
  const settings = publicSettings();
  if (!settings.apiKeyConfigured || !settings.model) {
    return reply.code(400).send({ error: '请先在模型设置中配置 API Key 和模型名称。' });
  }
  const body = asRecord(request.body);
  const schemaIds = Array.isArray(body.schemaIds) ? body.schemaIds.map(text).filter(Boolean) : [];
  const schemas = await protocolSchemasForAnalysis(request.params.projectId, schemaIds);
  if (!schemas.length) return reply.code(400).send({ error: '没有可分析的协议。' });
  if (schemas.length > 100) return reply.code(400).send({ error: '单次最多分析 100 种协议，请先筛选。' });

  let analyzed = 0;
  let failed = 0;
  await Promise.all(schemas.map(async (schema) => {
    try {
      const result = await analyzeProtocolSemantics({
        name: schema.name,
        form: schema.form,
        delimiter: schema.delimiter,
        fieldCount: schema.fieldCount,
        declaration: schema.declaration,
        examples: schema.examples,
        fieldRules: schema.fieldRules,
      });
      await updateProtocolAnalysis(schema.id, result);
      analyzed += 1;
    } catch (error) {
      failed += 1;
      await setProtocolAnalysisError(schema.id, error instanceof Error ? error.message : String(error));
    }
  }));
  return { ok: true, analyzed, failed, protocols: await listProtocolSchemas(request.params.projectId) };
});

app.patch<{ Params: { projectId: string; schemaId: string } }>(
  '/api/projects/:projectId/protocols/:schemaId',
  async (request, reply) => {
    const active = await db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE project_id = ? AND status IN ('queued', 'running', 'paused')")
      .get(request.params.projectId) as { count: number };
    if (Number(active.count) > 0) return reply.code(409).send({ error: '请先结束当前翻译任务，再调整协议规则并重新扫描。' });
    try {
      return await updateProtocolSchema(request.params.projectId, request.params.schemaId, asRecord(request.body));
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : String(error) });
    }
  },
);

app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/diagnostics', async (request, reply) => {
  const row = await db.prepare(`
    SELECT status, source_language AS sourceLanguage, target_language AS targetLanguage,
      original_json AS originalJson, draft_json AS draftJson,
      original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson,
      regex_validation_overrides AS regexValidationOverrides
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as {
    status?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    originalJson?: string;
    draftJson?: string | null;
    originalModuleJson?: string | null;
    draftModuleJson?: string | null;
    regexValidationOverrides?: string | null;
  } | undefined;
  if (!row?.originalJson) return reply.code(404).send({ error: '项目不存在或缺少原始卡片数据。' });
  try {
    const segments = await db.prepare(`
      SELECT id, path_json AS pathJson, path_label AS pathLabel, kind, source_text AS sourceText,
        start_pos AS start, end_pos AS end, review_status AS reviewStatus, final_text AS finalText, translated_text AS translatedText
      FROM segments
      WHERE project_id = ? AND (
        kind LIKE 'lua-%'
        OR kind = 'runtime-message'
        OR path_json = '[\"$module\",\"namespace\"]'
        OR path_json = '[\"namespace\"]'
      )
      ORDER BY sort_order, path_label
    `).all(request.params.projectId) as Array<{
      id: string;
      pathJson: string;
      pathLabel: string;
      kind: string;
      sourceText: string;
      start: number | null;
      end: number | null;
      reviewStatus: string;
      finalText: string | null;
      translatedText: string | null;
    }>;
    const originalCard = JSON.parse(row.originalJson) as Record<string, unknown>;
    let draftCard: Record<string, unknown>, draftModule: Record<string, unknown> | null;
    let reviewConflict: ModuleReviewConflict | undefined;
    try { ({ draftCard, draftModule } = await loadReviewedDraft(db, request.params.projectId)); }
    catch (error) {
      if (!(error instanceof ModuleReviewConflict)) throw error;
      reviewConflict = error;
      draftCard = JSON.parse(row.draftJson || row.originalJson);
      draftModule = row.draftModuleJson ? JSON.parse(row.draftModuleJson) : null;
    }
    const originalModule = row.originalModuleJson
      ? JSON.parse(row.originalModuleJson) as Record<string, unknown>
      : null;

    const report = buildLuaManagementReport({
      originalCard,
      draftCard,
      originalModule,
      draftModule,
      storedSegments: segments,
      projectStatus: row.status,
      targetLanguage: row.targetLanguage,
      regexValidationOverrides: parseRegexValidationOverrides(row.regexValidationOverrides),
    });
    if (reviewConflict) {
      report.blockerCount += 1;
      report.issues.push({ kind: 'control', pathLabel: reviewConflict.pathLabel, message: reviewConflict.message, blocking: true, segmentIds: [] });
      report.steps = report.steps.map(step => ['validate', 'export'].includes(step.id)
        ? { ...step, status: 'blocked' as const, message: reviewConflict!.message } : step);
    }
    return report;
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/namespace-decision', async (request, reply) => {
  const body = asRecord(request.body);
  const targetNamespace = text(body.targetNamespace).trim();
  if (!targetNamespace) {
    return reply.code(400).send({ error: '请填写确认后的模块命名空间。' });
  }
  try {
    return await namespaceReviewService.confirm(request.params.projectId, targetNamespace);
  } catch (error) {
    return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Save one explicitly edited Lua syntax-error line from the Lua management page. */
app.patch<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/syntax-line', async (request, reply) => {
  const body = asRecord(request.body);
  const pathJson = typeof body.pathJson === 'string' ? body.pathJson : '';
  const line = typeof body.line === 'number' ? body.line : Number(body.line);
  const replacement = typeof body.replacement === 'string' ? body.replacement : null;
  const expectedLine = typeof body.expectedLine === 'string' ? body.expectedLine : undefined;
  if (!pathJson || !Number.isInteger(line) || line < 1 || replacement == null) {
    return reply.code(400).send({ error: '请提供 Lua 路径、有效行号和人工修改后的整行文本。' });
  }
  const row = await db.prepare(`
    SELECT original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as { originalModuleJson?: string | null; draftModuleJson?: string | null } | undefined;
  if (!row?.originalModuleJson) return reply.code(404).send({ error: '项目不存在或缺少原始 Risu Lua 模块。' });
  try {
    const originalModule = JSON.parse(row.originalModuleJson) as Record<string, unknown>;
    let draftModule: Record<string, unknown> | null;
    try { ({ draftModule } = await loadReviewedDraft(db, request.params.projectId)); }
    catch (error) {
      // Diagnostics display the retained manual draft when rebase conflicts.
      // Edit that same draft so the user can resolve it, retaining the review
      // baseline so unresolved overlaps still block apply and export.
      if (!(error instanceof ModuleReviewConflict)) throw error;
      draftModule = row.draftModuleJson ? JSON.parse(row.draftModuleJson) : null;
    }
    if (!draftModule) return reply.code(404).send({ error: '项目缺少 Risu Lua 模块。' });
    const result = replaceRisuLuaLine(draftModule, pathJson, line, replacement, expectedLine);
    if (!result.ok) {
      if (result.reason === 'stale') {
        return reply.code(409).send({ error: '当前 Lua 行已被其他操作更新，请刷新诊断后再提交。', currentLine: result.currentLine });
      }
      const messages = {
        'invalid-path': 'Lua 路径无效，无法定位代码。',
        'not-code': '指定路径不是可编辑的 Lua 代码块。',
        'line-out-of-range': '指定行号超出当前 Lua 代码范围。',
        stale: '当前 Lua 行已被其他操作更新，请刷新诊断后再提交。',
      } as const;
      return reply.code(400).send({ error: messages[result.reason] });
    }
    const remainingSyntaxIssues = validateRisuLuaChanges(originalModule, draftModule);
    await db.prepare('UPDATE projects SET draft_module_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(draftModule), now(), request.params.projectId);
    return {
      ok: true,
      pathJson,
      line,
      previousLine: result.previousLine,
      currentLine: replacement,
      syntaxOk: !remainingSyntaxIssues.length,
      remainingSyntaxIssues,
    };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

type RegexCoverageEntry = RisuRegexLanguageEntry & {
  originalPattern: string;
  sourceMatches: string[];
  draftMatches: string[];
  coveragePaths: string[];
  coverageRecords: ReturnType<typeof collectRegexCoveragePairs>;
  sourceMatchCount: number;
  draftMatchCount: number;
  modelContext?: ReturnType<typeof regexLanguagePayloadSummary>;
};

interface RegexCoverageContext {
  targetLanguage: string;
  originalCard: Record<string, unknown>;
  draftCard: Record<string, unknown>;
  originalModule: Record<string, unknown>;
  draftModule: Record<string, unknown>;
  activeCard: Record<string, unknown>;
  activeModule: Record<string, unknown>;
  entries: RegexCoverageEntry[];
}

async function loadRegexCoverageContext(projectId: string, includePathLabel?: string): Promise<RegexCoverageContext | null> {
  const row = await db.prepare(`
    SELECT target_language AS targetLanguage, original_json AS originalJson, draft_json AS draftJson,
      original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson
    FROM projects WHERE id = ?
  `).get(projectId) as {
    targetLanguage?: string;
    originalJson?: string;
    draftJson?: string | null;
    originalModuleJson?: string | null;
    draftModuleJson?: string | null;
  } | undefined;
  if (!row?.originalJson || !row.originalModuleJson) return null;

  const originalCard = JSON.parse(row.originalJson) as Record<string, unknown>;
  const { draftCard, draftModule } = await loadReviewedDraft(db, projectId);
  if (!draftModule) throw new Error('项目缺少 Risu 模块。');
  const originalModule = JSON.parse(row.originalModuleJson) as Record<string, unknown>;

  // Check the same reviewed candidate that apply will validate before saving.
  const activeCard = draftCard;
  const activeModule = draftModule;
  const originalRules = Array.isArray(originalModule.regex) ? originalModule.regex : [];
  const entries: RegexCoverageEntry[] = [];
  for (const [index, rawRule] of originalRules.entries()) {
    if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) continue;
    const rule = rawRule as Record<string, unknown>;
    if (typeof rule.in !== 'string' || !rule.in) continue;
    if (isZeroWidthCardinalityTrigger(rule.in)) continue;
    const draftRule = Array.isArray(draftModule.regex) && draftModule.regex[index] && typeof draftModule.regex[index] === 'object'
      ? draftModule.regex[index] as Record<string, unknown>
      : undefined;
    const currentPattern = typeof draftRule?.in === 'string' && draftRule.in ? draftRule.in : rule.in;
    const originalMatches = countRegexMatchesInStrings(originalCard, rule.in);
    const draftMatches = countRegexMatchesInStrings(activeCard, currentPattern);
    const dynamicDisplay = isRisuDisplayFormattingRegexRule(rule);
    const runtimePostprocess = isRisuOutputPostprocessRegexRule(rule);
    const runtimeRule = dynamicDisplay || runtimePostprocess;
    const pathLabel = `模块.regex.${index}.in`;
    if (!runtimeRule && (!originalMatches || (originalMatches === draftMatches && pathLabel !== includePathLabel))) continue;
    const pairs = runtimeRule ? [] : collectRegexCoveragePairsWithPatterns(originalCard, activeCard, rule.in, currentPattern);
    const sourceMatchCount = originalMatches;
    const draftMatchCount = draftMatches;
    entries.push({
      pathLabel,
      originalPattern: rule.in,
      pattern: currentPattern,
      type: typeof rule.type === 'string' ? rule.type : '',
      out: typeof rule.out === 'string' ? rule.out : '',
      dynamicDisplay,
      runtimePostprocess,
      sourceSamples: pairs.slice(0, 8).map((pair) => pair.sourceText),
      draftSamples: pairs.slice(0, 8).map((pair) => pair.draftText),
      sourceMatches: pairs.flatMap((pair) => pair.sourceMatches).slice(0, 2_000),
      draftMatches: pairs.flatMap((pair) => pair.draftMatches).slice(0, 2_000),
      coveragePaths: pairs.map((pair) => pair.pathLabel),
      coverageRecords: pairs,
      formatProbe: runtimeRule ? undefined : buildRegexWhitespaceProbe(originalCard, activeCard, rule.in, currentPattern),
      sourceMatchCount,
      draftMatchCount,
    });
  }
  return { targetLanguage: row.targetLanguage || 'zh-CN', originalCard, draftCard, originalModule, draftModule, activeCard, activeModule, entries };
}

function regexRuleIndexFromPathLabel(pathLabel: string): number | null {
  const match = pathLabel.match(/^模块\.regex\.(\d+)\.in$/u);
  if (!match) return null;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index >= 0 ? index : null;
}

function regexRuleAt(module: Record<string, unknown>, index: number): Record<string, unknown> | null {
  if (!Array.isArray(module.regex)) return null;
  const rule = module.regex[index];
  return rule && typeof rule === 'object' && !Array.isArray(rule) ? rule as Record<string, unknown> : null;
}

function parseRegexValidationOverrides(value: string | null | undefined): RisuRegexValidationOverrides {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result: Record<string, RisuRegexValidationOverride> = {};
    for (const [pathLabel, raw] of Object.entries(parsed)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const item = raw as Record<string, unknown>;
      if (typeof item.pattern !== 'string' || !item.pattern) continue;
      const originalMatchCount = Number(item.originalMatchCount);
      const draftMatchCount = Number(item.draftMatchCount);
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

function publicRegexCoverageEntry(entry: RegexCoverageEntry): RegexCoverageEntry {
  return {
    ...entry,
    // The confirmation dialog needs representative hits, not the full payload
    // that is reserved for the one-rule model request.
    sourceMatches: entry.sourceMatches.slice(0, 24),
    draftMatches: entry.draftMatches.slice(0, 24),
    coverageRecords: entry.coverageRecords.slice(0, 24),
    modelContext: regexLanguagePayloadSummary(entry),
  };
}

function regexCoverageValidation(
  entry: RegexCoverageEntry,
  candidateModule: Record<string, unknown>,
  activeCard: Record<string, unknown>,
  activeModule: Record<string, unknown>,
  originalModule: Record<string, unknown>,
): { passed: boolean; sourceMatchCount: number; draftMatchCount: number; dynamicDisplay: boolean; runtimePostprocess: boolean; syntaxIssues: string[]; message?: string } {
  const match = entry.pathLabel.match(/^模块\.regex\.(\d+)\.in$/u);
  const index = match ? Number(match[1]) : -1;
  const candidateRule = Array.isArray(candidateModule.regex) && index >= 0
    ? candidateModule.regex[index]
    : undefined;
  const candidatePattern = candidateRule && typeof candidateRule === 'object' && !Array.isArray(candidateRule)
    ? (candidateRule as Record<string, unknown>).in
    : undefined;
  const syntaxIssues = validateRisuLuaChanges(originalModule, candidateModule).map((issue) => issue.message);
  if (typeof candidatePattern !== 'string' || !candidatePattern) {
    return { passed: false, sourceMatchCount: entry.sourceMatchCount, draftMatchCount: 0, dynamicDisplay: false, runtimePostprocess: false, syntaxIssues, message: '候选结果没有保留有效的正则规则。' };
  }
  let compiled = true;
  try { new RegExp(candidatePattern); } catch { compiled = false; }
  // Runtime display rules process future model replies. Their static card
  // counts are shown as diagnostics only; ordinary protocol rules still use
  // the source/draft cardinality check below.
  const draftMatchCount = countRegexMatchesInStrings(activeCard, candidatePattern);
  const originalRule = regexRuleAt(originalModule, index);
  const dynamicDisplay = isRisuDisplayFormattingRegexRule(originalRule);
  const runtimePostprocess = isRisuOutputPostprocessRegexRule(originalRule);
  const candidateIsDynamicDisplay = isRisuDisplayFormattingRegexRule(candidateRule as Record<string, unknown> | null);
  const dynamicDisplaySafe = dynamicDisplay && candidateIsDynamicDisplay && isSafeRisuDisplayFormattingRegexChange(
    originalRule,
    candidateRule as Record<string, unknown> | null,
  );
  const candidateIsRuntimePostprocess = isRisuOutputPostprocessRegexRule(candidateRule as Record<string, unknown> | null);
  const candidateOutput = candidateRule && typeof candidateRule === 'object' && !Array.isArray(candidateRule)
    ? (candidateRule as Record<string, unknown>).out
    : undefined;
  const runtimePostprocessSafe = runtimePostprocess && candidateIsRuntimePostprocess
    && candidateRule && typeof candidateRule === 'object' && typeof (candidateRule as Record<string, unknown>).type === 'string'
    && typeof candidateOutput === 'string'
    && (candidateRule as Record<string, unknown>).type === originalRule?.type
    && candidateOutput.length <= 16_000;
  const passed = compiled && !syntaxIssues.length && (dynamicDisplay ? dynamicDisplaySafe : runtimePostprocess ? runtimePostprocessSafe : draftMatchCount === entry.sourceMatchCount);
  return {
    passed,
    sourceMatchCount: entry.sourceMatchCount,
    draftMatchCount,
    dynamicDisplay,
    runtimePostprocess,
    syntaxIssues,
    message: passed
      ? (dynamicDisplay ? '动态展示规则已通过编译与结构校验；静态卡片命中仅作样本参考。' : runtimePostprocess ? '聊天后处理规则已通过编译与 editoutput 结构校验；静态卡片命中仅作样本参考。' : undefined)
      : dynamicDisplay && !dynamicDisplaySafe
        ? '动态展示规则必须保留 editdisplay 类型、捕获组和仅由捕获组/换行组成的替换模板。'
      : runtimePostprocess && !runtimePostprocessSafe ? '聊天后处理规则必须保留 editoutput 类型和有效替换输出。'
      : compiled ? `候选命中 ${draftMatchCount}，与原文 ${entry.sourceMatchCount} 不一致。` : '候选正则无法编译。',
  };
}

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/regex-coverage/preview', async (request, reply) => {
  try {
    const context = await loadRegexCoverageContext(request.params.projectId);
    if (!context) return reply.code(409).send({ error: '当前卡片没有可检查的 Risu Lua 模块。' });
    return { ok: true, checked: context.entries.length, rules: context.entries.map(publicRegexCoverageEntry) };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

/**
 * A quick-flow escape hatch for rules the model could not reconcile.  This
 * records an exact, current-pattern/current-count acknowledgement; it does
 * not alter the Lua module or disable any other integrity checks.
 */
app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/regex-validation/force-pass', async (request, reply) => {
  try {
    const row = await db.prepare(`
      SELECT original_json AS originalJson, original_module_json AS originalModuleJson,
        draft_module_json AS draftModuleJson, target_language AS targetLanguage,
        regex_validation_overrides AS regexValidationOverrides
      FROM projects WHERE id = ?
    `).get(request.params.projectId) as {
      originalJson?: string;
      originalModuleJson?: string | null;
      draftModuleJson?: string | null;
      targetLanguage?: string;
      regexValidationOverrides?: string | null;
    } | undefined;
    if (!row?.originalJson || !row.originalModuleJson) {
      return reply.code(404).send({ error: '当前卡片没有可检查的 Risu Lua 模块。' });
    }
    const originalCard = JSON.parse(row.originalJson) as Record<string, unknown>;
    const originalModule = JSON.parse(row.originalModuleJson) as Record<string, unknown>;
    const { draftCard, draftModule } = await loadReviewedDraft(db, request.params.projectId);
    if (!draftModule) throw new Error('项目缺少 Risu 模块。');
    const overrides = { ...parseRegexValidationOverrides(row.regexValidationOverrides) } as Record<string, RisuRegexValidationOverride>;
    const forcedPaths: string[] = [];
    const originalRules = Array.isArray(originalModule.regex) ? originalModule.regex : [];
    for (const [index, rawRule] of originalRules.entries()) {
      if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) continue;
      const originalRule = rawRule as Record<string, unknown>;
      const originalPattern = typeof originalRule.in === 'string' ? originalRule.in : '';
      if (!originalPattern || isZeroWidthCardinalityTrigger(originalPattern)) continue;
      const draftRule = regexRuleAt(draftModule, index);
      const currentPattern = typeof draftRule?.in === 'string' && draftRule.in ? draftRule.in : originalPattern;
      const originalMatchCount = countRegexMatchesInStrings(originalCard, originalPattern);
      const draftMatchCount = countRegexMatchesInStrings(draftCard, currentPattern);
      if (!originalMatchCount || originalMatchCount === draftMatchCount) continue;
      const pathLabel = `模块.regex.${index}.in`;
      overrides[pathLabel] = {
        pattern: currentPattern,
        originalMatchCount,
        draftMatchCount,
        confirmedAt: now(),
      };
      forcedPaths.push(pathLabel);
    }
    if (forcedPaths.length) {
      await db.prepare('UPDATE projects SET regex_validation_overrides = ?, updated_at = ? WHERE id = ?')
        .run(JSON.stringify(overrides), now(), request.params.projectId);
    }
    return { ok: true, forcedCount: forcedPaths.length, paths: forcedPaths };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/regex-coverage/rule', async (request, reply) => {
  const body = asRecord(request.body);
  const pathLabel = typeof body.pathLabel === 'string' ? body.pathLabel.trim() : '';
  const requestedPattern = typeof body.pattern === 'string' ? body.pattern : undefined;
  if (!pathLabel) return reply.code(400).send({ error: '请提供要分析的正则规则路径。' });
  if (requestedPattern !== undefined && !requestedPattern) {
    return reply.code(400).send({ error: '请提供非空的正则规则。' });
  }
  const clientAbort = new AbortController();
  const abortWhenClientDisconnects = () => clientAbort.abort();
  reply.raw.once('close', abortWhenClientDisconnects);
  try {
    const context = await loadRegexCoverageContext(request.params.projectId, pathLabel);
    if (!context) return reply.code(409).send({ error: '当前卡片没有可检查的 Risu Lua 模块。' });
    const baseEntry = context.entries.find((candidate) => candidate.pathLabel === pathLabel);
    if (!baseEntry) return reply.code(404).send({ error: '该规则已不再需要全量修复，预览可能已经过期。' });
    const entry = requestedPattern && requestedPattern !== baseEntry.pattern
      ? (() => {
          const runtimeRule = baseEntry.dynamicDisplay || baseEntry.runtimePostprocess;
          const pairs = runtimeRule ? [] : collectRegexCoveragePairsWithPatterns(
            context.originalCard,
            context.activeCard,
            baseEntry.originalPattern,
            requestedPattern,
          );
          return {
            ...baseEntry,
            pattern: requestedPattern,
            draftMatchCount: countRegexMatchesInStrings(context.activeCard, requestedPattern),
            draftSamples: pairs.slice(0, 8).map((pair) => pair.draftText),
            draftMatches: pairs.flatMap((pair) => pair.draftMatches).slice(0, 2_000),
            coveragePaths: pairs.map((pair) => pair.pathLabel),
            coverageRecords: pairs,
            formatProbe: runtimeRule ? undefined : buildRegexWhitespaceProbe(context.originalCard, context.activeCard, baseEntry.originalPattern, requestedPattern),
          };
        })()
      : baseEntry;
    const proposals = await analyzeRisuRegexLanguageCoverage(context.targetLanguage, [entry], clientAbort.signal);
    // Model analysis is deliberately read-only. The UI must show the complete
    // candidate pattern to a human before a separate explicit save can write it.
    const candidateModule = JSON.parse(JSON.stringify(context.draftModule)) as Record<string, unknown>;
    if (requestedPattern) {
      const editableRule = regexRuleAt(candidateModule, regexRuleIndexFromPathLabel(pathLabel) ?? -1);
      if (editableRule) editableRule.in = requestedPattern;
    }
    const coverageChanges = applyRisuRegexCoverageProposals(candidateModule, proposals, context.originalCard);
    const changes = [
      ...coverageChanges,
      ...applyRisuRegexAlternativeProposals(candidateModule, proposals.filter((proposal) => !coverageChanges.some((change) => change.pathLabel === proposal.pathLabel))),
    ];
    const candidatePattern = regexRuleAt(candidateModule, regexRuleIndexFromPathLabel(pathLabel) ?? -1)?.in;
    const validation = regexCoverageValidation(entry, candidateModule, context.activeCard, context.activeModule, context.originalModule);
    const status = !changes.length ? 'no-change' : validation.passed ? 'validated' : 'rejected';
    return {
      ok: true,
      pathLabel,
      status,
      applied: 0,
      proposals,
      changes,
      validation,
      candidatePattern: typeof candidatePattern === 'string' ? candidatePattern : undefined,
      modelContext: regexLanguagePayloadSummary(entry),
    };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    reply.raw.removeListener('close', abortWhenClientDisconnects);
  }
});

/** Re-check changed regex rules with the complete before/after hit set. */
app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/regex-coverage', async (request, reply) => {
  const row = await db.prepare(`
    SELECT target_language AS targetLanguage, original_json AS originalJson, draft_json AS draftJson,
      original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as {
    targetLanguage?: string;
    originalJson?: string;
    draftJson?: string | null;
    originalModuleJson?: string | null;
    draftModuleJson?: string | null;
  } | undefined;
  if (!row?.originalJson || !row.originalModuleJson) return reply.code(409).send({ error: '当前卡片没有可检查的 Risu Lua 模块。' });
  try {
    const originalCard = JSON.parse(row.originalJson) as Record<string, unknown>;
    const { draftCard, draftModule } = await loadReviewedDraft(db, request.params.projectId);
    if (!draftModule) throw new Error('项目缺少 Risu 模块。');
    const originalModule = JSON.parse(row.originalModuleJson) as Record<string, unknown>;

    // Keep this legacy full-pass endpoint aligned with export as well.
    const activeCard = draftCard;
    const activeModule = draftModule;
    const originalRules = Array.isArray(originalModule.regex) ? originalModule.regex : [];
    const entries = [] as Array<{
      pathLabel: string;
      pattern: string;
      type: string;
      out: string;
      sourceSamples: string[];
      draftSamples: string[];
      sourceMatches: string[];
      draftMatches: string[];
      coveragePaths: string[];
      coverageRecords: ReturnType<typeof collectRegexCoveragePairs>;
      formatProbe?: ReturnType<typeof buildRegexWhitespaceProbe>;
      sourceMatchCount: number;
      draftMatchCount: number;
      dynamicDisplay?: boolean;
      runtimePostprocess?: boolean;
    }>;
    for (const [index, rawRule] of originalRules.entries()) {
      if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) continue;
      const rule = rawRule as Record<string, unknown>;
      if (typeof rule.in !== 'string' || !rule.in) continue;
      if (isZeroWidthCardinalityTrigger(rule.in)) continue;
      const draftRule = Array.isArray(draftModule.regex) && draftModule.regex[index] && typeof draftModule.regex[index] === 'object'
        ? draftModule.regex[index] as Record<string, unknown>
        : undefined;
      const currentPattern = typeof draftRule?.in === 'string' && draftRule.in ? draftRule.in : rule.in;
      const originalMatches = countRegexMatchesInStrings(originalCard, rule.in);
      const draftMatches = countRegexMatchesInStrings(activeCard, currentPattern);
      const dynamicDisplay = isRisuDisplayFormattingRegexRule(rule);
      const runtimePostprocess = isRisuOutputPostprocessRegexRule(rule);
      const runtimeRule = dynamicDisplay || runtimePostprocess;
      if (!runtimeRule && (!originalMatches || originalMatches === draftMatches)) continue;
      const pairs = runtimeRule ? [] : collectRegexCoveragePairsWithPatterns(originalCard, activeCard, rule.in, currentPattern);
      const sourceMatchCount = originalMatches;
      const draftMatchCount = draftMatches;
      entries.push({
        pathLabel: `模块.regex.${index}.in`,
        pattern: currentPattern,
        type: typeof rule.type === 'string' ? rule.type : '',
        out: typeof rule.out === 'string' ? rule.out : '',
        dynamicDisplay,
        runtimePostprocess,
        sourceSamples: pairs.slice(0, 8).map((pair) => pair.sourceText),
        draftSamples: pairs.slice(0, 8).map((pair) => pair.draftText),
        sourceMatches: pairs.flatMap((pair) => pair.sourceMatches).slice(0, 2_000),
        draftMatches: pairs.flatMap((pair) => pair.draftMatches).slice(0, 2_000),
        coveragePaths: pairs.map((pair) => pair.pathLabel),
        coverageRecords: pairs,
        formatProbe: runtimeRule ? undefined : buildRegexWhitespaceProbe(originalCard, activeCard, rule.in, currentPattern),
        sourceMatchCount,
        draftMatchCount,
      });
    }
    if (!entries.length) return { ok: true, checked: 0, changedRules: 0, applied: 0, proposals: [] };
    const batches = splitRegexLanguageEntries(entries);
    const proposalBatches = await Promise.all(batches.map((batch) => analyzeRisuRegexLanguageCoverage(row.targetLanguage || 'zh-CN', batch)));
    const proposals = proposalBatches.flat();
    const coverageChanges = applyRisuRegexCoverageProposals(draftModule, proposals, originalCard);
    const changes = [
      ...coverageChanges,
      ...applyRisuRegexAlternativeProposals(draftModule, proposals.filter((proposal) => !coverageChanges.some((change) => change.pathLabel === proposal.pathLabel))),
    ];
    return {
      ok: true,
      checked: entries.length,
      changedRules: changes.length,
      applied: 0,
      proposals,
      changes,
    };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

type RegexRuleCardContext = {
  originalCard: Record<string, unknown>;
  draftCard: Record<string, unknown>;
  originalPattern: string;
  currentPattern: string;
  currentOutput: string;
  dynamicDisplay: boolean;
  runtimePostprocess: boolean;
};

async function loadRegexRuleCardContext(projectId: string, pathLabel: string): Promise<RegexRuleCardContext | null> {
  const index = regexRuleIndexFromPathLabel(pathLabel);
  if (index == null) return null;
  const row = await db.prepare(`
    SELECT original_json AS originalJson, draft_json AS draftJson,
      original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson
    FROM projects WHERE id = ?
  `).get(projectId) as {
    originalJson?: string;
    draftJson?: string | null;
    originalModuleJson?: string | null;
    draftModuleJson?: string | null;
  } | undefined;
  if (!row?.originalJson || !row.originalModuleJson) return null;
  const originalCard = JSON.parse(row.originalJson) as Record<string, unknown>;
  const { draftCard, draftModule } = await loadReviewedDraft(db, projectId);
  if (!draftModule) throw new Error('项目缺少 Risu 模块。');
  const originalModule = JSON.parse(row.originalModuleJson) as Record<string, unknown>;

  const originalRule = regexRuleAt(originalModule, index);
  const draftRule = regexRuleAt(draftModule, index);
  const originalPattern = typeof originalRule?.in === 'string' ? originalRule.in : '';
  const currentPattern = typeof draftRule?.in === 'string' && draftRule.in ? draftRule.in : originalPattern;
  const originalOutput = typeof originalRule?.out === 'string' ? originalRule.out : '';
  const currentOutput = typeof draftRule?.out === 'string' ? draftRule.out : originalOutput;
  if (!originalPattern || !draftRule) return null;
  return {
    originalCard,
    draftCard,
    originalPattern,
    currentPattern,
    currentOutput,
    dynamicDisplay: isRisuDisplayFormattingRegexRule(originalRule) && isRisuDisplayFormattingRegexRule(draftRule),
    runtimePostprocess: isRisuOutputPostprocessRegexRule(originalRule) && isRisuOutputPostprocessRegexRule(draftRule),
  };
}

function testRegexRuleOnCards(pathLabel: string, pattern: string, context: RegexRuleCardContext) {
  let compiled = true;
  let compileMessage: string | undefined;
  try { new RegExp(pattern); } catch (error) {
    compiled = false;
    compileMessage = error instanceof Error ? error.message : String(error);
  }
  const sourceMatchCount = compiled ? countRegexMatchesInStrings(context.originalCard, pattern) : 0;
  const draftMatchCount = compiled ? countRegexMatchesInStrings(context.draftCard, pattern) : 0;
  return {
    ok: compiled,
    pathLabel,
    pattern,
    compiled,
    sourceMatchCount,
    draftMatchCount,
    dynamicDisplay: context.dynamicDisplay,
    runtimePostprocess: context.runtimePostprocess,
    sourceSamples: compiled ? regexMatchSnippetsInStrings(context.originalCard, pattern, 12) : [],
    draftSamples: compiled ? regexMatchSnippetsInStrings(context.draftCard, pattern, 12) : [],
    ...(compileMessage ? { message: `正则无法编译：${compileMessage}` } : {
      message: context.dynamicDisplay
        ? '动态展示规则已通过编译；静态卡片命中仅作样本参考。'
        : context.runtimePostprocess
        ? '聊天后处理规则已通过编译；静态卡片命中仅作样本参考。'
        : sourceMatchCount === draftMatchCount
        ? '原文与当前稿命中数一致。'
        : `原文与当前稿命中数不同：${sourceMatchCount} → ${draftMatchCount}。`,
    }),
  };
}

/** Test a manually edited regex without changing the project draft. */
app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/regex-test', async (request, reply) => {
  const body = asRecord(request.body);
  const pathLabel = typeof body.pathLabel === 'string' ? body.pathLabel.trim() : '';
  const pattern = typeof body.pattern === 'string' ? body.pattern : '';
  if (!pathLabel || !pattern) {
    return reply.code(400).send({ error: '请提供有效的正则路径和非空的规则。' });
  }
  try {
    const context = await loadRegexRuleCardContext(request.params.projectId, pathLabel);
    if (!context) return reply.code(404).send({ error: '找不到该正则规则或当前卡片没有 Lua 模块。' });
    return testRegexRuleOnCards(pathLabel, pattern, context);
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

/** Save a manually edited regex input into draft_module_json after syntax validation. */
app.patch<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/regex-rule', async (request, reply) => {
  const body = asRecord(request.body);
  const pathLabel = typeof body.pathLabel === 'string' ? body.pathLabel.trim() : '';
  const pattern = typeof body.pattern === 'string' ? body.pattern : '';
  const expectedPattern = typeof body.expectedPattern === 'string' ? body.expectedPattern : undefined;
  const hasOutput = Object.prototype.hasOwnProperty.call(body, 'out');
  const output = typeof body.out === 'string' ? body.out : undefined;
  const expectedOutput = typeof body.expectedOut === 'string' ? body.expectedOut : undefined;
  const forcePass = body.forcePass === true;
  if (!pathLabel || !pattern) {
    return reply.code(400).send({ error: '请提供有效的正则路径和非空的规则。' });
  }
  if ((hasOutput && output === undefined) || (output !== undefined && output.length > 16_000)) {
    return reply.code(400).send({ error: '聊天后处理替换输出必须是长度不超过 16000 的文本。' });
  }
  try {
    const context = await loadRegexRuleCardContext(request.params.projectId, pathLabel);
    if (!context) return reply.code(404).send({ error: '找不到该正则规则或当前卡片没有 Lua 模块。' });
    if (expectedPattern !== undefined && expectedPattern !== context.currentPattern) {
      return reply.code(409).send({ error: '当前正则已被其他操作更新，请刷新诊断后再保存。', currentPattern: context.currentPattern });
    }
    if (expectedOutput !== undefined && expectedOutput !== context.currentOutput) {
      return reply.code(409).send({ error: '当前聊天后处理输出已被其他操作更新，请刷新诊断后再保存。', currentOutput: context.currentOutput });
    }
    const test = testRegexRuleOnCards(pathLabel, pattern, context);
    if (!test.compiled) return reply.code(400).send({ error: test.message || '正则无法编译。' });
    const row = await db.prepare('SELECT draft_module_json AS draftModuleJson, original_module_json AS originalModuleJson, regex_validation_overrides AS regexValidationOverrides FROM projects WHERE id = ?')
      .get(request.params.projectId) as { draftModuleJson?: string | null; originalModuleJson?: string | null; regexValidationOverrides?: string | null } | undefined;
    if (!row?.originalModuleJson) return reply.code(404).send({ error: '项目不存在或缺少原始 Risu Lua 模块。' });
    const originalModule = JSON.parse(row.originalModuleJson) as Record<string, unknown>;
    const draftModule = row.draftModuleJson ? JSON.parse(row.draftModuleJson) as Record<string, unknown> : structuredClone(originalModule);
    const index = regexRuleIndexFromPathLabel(pathLabel);
    const rule = index == null ? null : regexRuleAt(draftModule, index);
    const originalRule = index == null ? null : regexRuleAt(originalModule, index);
    if (!rule) return reply.code(404).send({ error: '找不到可保存的正则规则。' });
    const dynamicDisplay = isRisuDisplayFormattingRegexRule(originalRule);
    const runtimePostprocess = isRisuOutputPostprocessRegexRule(originalRule);
    if (hasOutput && !runtimePostprocess) {
      return reply.code(400).send({ error: '只有 editoutput 聊天后处理规则可以修改替换输出。' });
    }
    const candidateRule: Record<string, unknown> = { ...rule, in: pattern, ...(output !== undefined ? { out: output } : {}) };
    if (dynamicDisplay && !isSafeRisuDisplayFormattingRegexChange(originalRule, candidateRule)) {
      return reply.code(400).send({ error: '动态展示规则必须保留 editdisplay 类型、捕获组和仅由捕获组/换行组成的替换模板。' });
    }
    if (runtimePostprocess && (candidateRule.type !== originalRule?.type || !isRisuOutputPostprocessRegexRule(candidateRule))) {
      return reply.code(400).send({ error: '聊天后处理规则必须保留 editoutput 类型、有效匹配正则和有效替换输出。' });
    }
    // Validation compares the original protocol pattern with the saved draft
    // pattern. A language-adapted candidate can match the original card a
    // different number of times, so the override must retain the true
    // original-pattern baseline rather than the candidate test count.
    const validationSourceMatchCount = countRegexMatchesInStrings(context.originalCard, context.originalPattern);
    const validationDraftMatchCount = countRegexMatchesInStrings(context.draftCard, pattern);
    const previousPattern = typeof rule.in === 'string' ? rule.in : context.currentPattern;
    const previousOut = typeof rule.out === 'string' ? rule.out : context.currentOutput;
    rule.in = pattern;
    if (output !== undefined) rule.out = output;
    const overrides = { ...parseRegexValidationOverrides(row.regexValidationOverrides) } as Record<string, RisuRegexValidationOverride>;
    const forcePassed = !dynamicDisplay && !runtimePostprocess && forcePass && validationSourceMatchCount !== validationDraftMatchCount;
    if (forcePassed) {
      overrides[pathLabel] = {
        pattern,
        originalMatchCount: validationSourceMatchCount,
        draftMatchCount: validationDraftMatchCount,
        confirmedAt: now(),
      };
    } else {
      delete overrides[pathLabel];
    }
    await db.prepare('UPDATE projects SET draft_module_json = ?, regex_validation_overrides = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(draftModule), JSON.stringify(overrides), now(), request.params.projectId);
    return {
      ...test,
      validationSourceMatchCount,
      validationDraftMatchCount,
      saved: true,
      previousPattern,
      previousOut,
      out: typeof rule.out === 'string' ? rule.out : context.currentOutput,
      forcePassed,
    };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/runtime-aliases', async (request, reply) => {
  const row = await db.prepare(`SELECT original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson,
    target_language AS targetLanguage FROM projects WHERE id = ?`).get(request.params.projectId) as {
    originalModuleJson?: string | null;
    draftModuleJson?: string | null;
    targetLanguage?: string;
  } | undefined;
  if (!row?.originalModuleJson) return reply.code(409).send({ error: '当前卡片没有可修改的 Risu Lua 模块。' });
  const body = asRecord(request.body);
  const ownerId = typeof body.ownerId === 'string' ? body.ownerId.trim() : '';
  const aliases = Array.isArray(body.aliases)
    ? body.aliases.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean)
    : [];
  if (!ownerId || !aliases.length) return reply.code(400).send({ error: '请提供 ownerId 和至少一个目标语言别名。' });
  try {
    const originalModule = JSON.parse(row.originalModuleJson) as Record<string, unknown>;
    const draftModule = row.draftModuleJson ? JSON.parse(row.draftModuleJson) as Record<string, unknown> : structuredClone(originalModule);
    const result = applyRisuModuleSegments(draftModule, [], row.targetLanguage || '', undefined, { [ownerId]: aliases });
    if (!result.runtimeAliasAdditions) return reply.code(409).send({ error: '没有发现可合并的新别名，请检查 ownerId 或重复项。' });
    await db.prepare('UPDATE projects SET draft_module_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(result.draft), now(), request.params.projectId);
    return { ok: true, ownerId, aliases, added: result.runtimeAliasAdditions };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/router-repair/preview', async (request, reply) => {
  const row = await db.prepare(`
    SELECT original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as {
    originalModuleJson?: string | null;
    draftModuleJson?: string | null;
  } | undefined;
  if (!row?.originalModuleJson) return reply.code(409).send({ error: '当前卡片没有可预览的 Risu Lua 模块。' });
  try {
    const originalModule = JSON.parse(row.originalModuleJson) as Record<string, unknown>;
    const preview = applyPortraitRouterRepairs(originalModule);
    return { ok: true, report: preview.report, applied: preview.applied, changes: preview.changes };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/router-repair', async (request, reply) => {
  const row = await db.prepare(`
    SELECT original_json AS originalJson, draft_json AS draftJson,
      original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as {
    originalJson?: string;
    draftJson?: string | null;
    originalModuleJson?: string | null;
    draftModuleJson?: string | null;
  } | undefined;
  if (!row?.originalJson) return reply.code(404).send({ error: '项目不存在或缺少原始卡片数据。' });
  if (!row.originalModuleJson) return reply.code(409).send({ error: '当前卡片没有可修复的 Risu Lua 模块。' });

  try {
    const body = asRecord(request.body);
    const requestedChanges = parseRouterRepairOverrides(body.changes);
    const originalCard = JSON.parse(row.originalJson) as Record<string, unknown>;
    const draftCard = row.draftJson ? JSON.parse(row.draftJson) as Record<string, unknown> : originalCard;
    const originalModule = JSON.parse(row.originalModuleJson) as Record<string, unknown>;
    const draftModule = row.draftModuleJson
      ? JSON.parse(row.draftModuleJson) as Record<string, unknown>
      : originalModule;
    const repairedOriginal = applyPortraitRouterRepairs(originalModule);
    const repairedDraft = applyPortraitRouterRepairs(draftModule);
    if (!repairedOriginal.applied.length && !repairedDraft.applied.length) {
      return { ok: true, applied: [], report: repairedDraft.report };
    }
    const draftChanges = requestedChanges.flatMap((override) => {
      const sourceChange = repairedOriginal.changes.find((change) => change.id === override.id && change.pathLabel === override.pathLabel);
      const targetChange = repairedDraft.changes.find((change) => change.id === override.id && change.pathLabel === override.pathLabel);
      if (!sourceChange || !targetChange) return [];
      return [{
        ...override,
        before: targetChange.before,
        after: applyPortraitRouterReviewDelta(targetChange.after, sourceChange.after, override.after, targetChange.pathLabel),
      }];
    });
    const finalDraft = applyPortraitRouterChangeOverrides(draftModule, draftChanges, repairedDraft.changes, { requireBefore: false });
    const syntaxIssues = validateRisuLuaChanges(originalModule, finalDraft);
    if (syntaxIssues.length) return reply.code(409).send({ error: `路由修复后的 Lua 语法校验失败：${syntaxIssues[0].pathLabel} ${syntaxIssues[0].message}` });
    const templateIssues = validateRisuTemplateChanges(originalModule, finalDraft);
    if (templateIssues.length) return reply.code(409).send({ error: `路由修复破坏了模板结构：${templateIssues[0].pathLabel} ${templateIssues[0].message}` });
    const controlIssues = validateRisuControlReferences(originalCard, draftCard, originalModule, finalDraft);
    if (controlIssues.length) return reply.code(409).send({ error: `路由修复破坏了控制引用：${controlIssues[0].pathLabel} ${controlIssues[0].message}` });

    await db.prepare(`
      UPDATE projects
      SET draft_module_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(finalDraft),
      now(),
      request.params.projectId,
    );
    return {
      ok: true,
      applied: repairedDraft.applied,
      changes: mergeRouterRepairChanges(repairedDraft.changes, requestedChanges),
      report: applyPortraitRouterRepairs(finalDraft).report,
    };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/lua/reset-draft', async (request, reply) => {
  const row = await db.prepare(`
    SELECT original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson,
      regex_validation_overrides AS regexValidationOverrides
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as {
    originalModuleJson?: string | null;
    draftModuleJson?: string | null;
    regexValidationOverrides?: string | null;
  } | undefined;
  if (!row) return reply.code(404).send({ error: '项目不存在。' });
  if (!row.originalModuleJson) return reply.code(409).send({ error: '当前卡片没有可恢复的原始 Risu Lua 模块。' });

  const hasDraftChanges = row.draftModuleJson !== row.originalModuleJson || Boolean(row.regexValidationOverrides);
  if (!hasDraftChanges) return { ok: true, reset: false };
  await db.prepare(`
    UPDATE projects
    SET draft_module_json = original_module_json, module_review_state = NULL, regex_validation_overrides = NULL, updated_at = ?
    WHERE id = ?
  `).run(now(), request.params.projectId);
  return { ok: true, reset: true };
});

app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId/family', async (request, reply) => {
  const count = asRecord(request.body).expectedVersionCount;
  if (!Number.isInteger(count) || Number(count) < 1) return reply.code(400).send({ error: '请确认要删除的版本数量。' });
  try {
    const result = await versionService.deleteFamily(request.params.projectId, Number(count));
    for (const id of result.deletedIds) controlReferenceCache.delete(id);
    return { ok: true, deletedCount: result.deletedIds.length, cleanupFailed: result.cleanupFailed };
  } catch (error) {
    if (error instanceof ProjectVersionError) return reply.code(error.statusCode).send({ error: error.message });
    throw error;
  }
});

app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
  if (await db.prepare('SELECT id FROM projects WHERE base_version_id = ? LIMIT 1').get(request.params.projectId)) {
    return reply.code(409).send({ error: '后续版本仍以此版本为基础，请保留它以便追溯字段和译文来源。' });
  }
  await namespaceReviewService.ensureReviewItem(request.params.projectId);
  const active = await db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE project_id = ? AND status IN ('queued', 'running')")
    .get(request.params.projectId) as { count: number };
  if (Number(active.count) > 0) return reply.code(409).send({ error: '项目仍有运行中的任务。' });
  const result = await db.prepare('DELETE FROM projects WHERE id = ?').run(request.params.projectId);
  if (!result.changes) return reply.code(404).send({ error: '项目不存在。' });
  await removeProjectStorage(request.params.projectId);
  controlReferenceCache.delete(request.params.projectId);
  return { ok: true };
});

app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/glossary', async (request, reply) => {
  if (!await projectById(request.params.projectId)) return reply.code(404).send({ error: '项目不存在。' });
  return (await db.prepare(`
    SELECT id, source_text AS sourceText, target_text AS targetText,
      notes, case_sensitive AS caseSensitive, created_at AS createdAt, updated_at AS updatedAt
    FROM glossary_terms WHERE project_id = ? ORDER BY source_text COLLATE NOCASE
  `).all(request.params.projectId)).map((row) => ({ ...row, caseSensitive: Boolean((row as Record<string, unknown>).caseSensitive) }));
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/glossary', async (request, reply) => {
  if (!await projectById(request.params.projectId)) return reply.code(404).send({ error: '项目不存在。' });
  const body = asRecord(request.body);
  const sourceText = text(body.sourceText);
  const targetText = text(body.targetText);
  if (!sourceText || !targetText) return reply.code(400).send({ error: '原词和译词不能为空。' });
  if (sourceText.length > 200 || targetText.length > 200) return reply.code(400).send({ error: '术语长度不能超过 200 个字符。' });
  const termId = id();
  await db.prepare(`
    INSERT INTO glossary_terms(id, project_id, source_text, target_text, notes, case_sensitive, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(termId, request.params.projectId, sourceText, targetText, text(body.notes), body.caseSensitive === true ? 1 : 0, now(), now());
  return reply.code(201).send({ id: termId, sourceText, targetText, notes: text(body.notes), caseSensitive: body.caseSensitive === true });
});

app.delete<{ Params: { termId: string } }>('/api/glossary/:termId', async (request, reply) => {
  const result = await db.prepare('DELETE FROM glossary_terms WHERE id = ?').run(request.params.termId);
  if (!result.changes) return reply.code(404).send({ error: '术语不存在。' });
  return { ok: true };
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/scan', async (request, reply) => {
  const body = asRecord(request.body);
  const scope = normalizeScope(text(body.scope));
  const row = await db.prepare(`
    SELECT original_json, original_module_json, source_format, source_blob, source_language AS sourceLanguage,
      source_storage_path AS sourceStoragePath
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as {
    original_json: string;
    original_module_json: string | null;
    source_format: string;
    source_blob: Uint8Array | null;
    sourceLanguage: string;
    sourceStoragePath: string | null;
  } | undefined;
  if (!row) return reply.code(404).send({ error: '项目不存在。' });
  const active = await db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE project_id = ? AND status IN ('queued', 'running', 'paused')")
    .get(request.params.projectId) as { count: number };
  if (Number(active.count) > 0) return reply.code(409).send({ error: '请先结束当前翻译任务再重新扫描。' });

  const card = JSON.parse(row.original_json) as Record<string, unknown>;
  let module = row.original_module_json
    ? JSON.parse(row.original_module_json) as Record<string, unknown>
    : null;
  const sourceBlob = row.source_blob || (row.sourceStoragePath ? await readStoredFile(row.sourceStoragePath) : null);
  if (!module && row.source_format === 'charx' && sourceBlob) {
    module = parseCharx(sourceBlob).module;
    if (module) {
      const serialized = JSON.stringify(module);
      await db.prepare('UPDATE projects SET original_module_json = ?, draft_module_json = ? WHERE id = ?')
        .run(serialized, serialized, request.params.projectId);
    }
  }
  const controlLiterals = module ? risuTranslationControlFragments(module) : [];
  const protocolDiscovery = await discoverAndStoreProtocols(request.params.projectId, card, module);
  const protocolRules = await approvedProtocolRules(request.params.projectId);
  const runtimeRisks = module ? detectRisuRuntimeRisks(module) : [];
  const scanInventory = (scanScope: ScopePreset) => {
    const moduleSegments = module
      ? scanRisuModule(module, scanScope, protocolRules).filter((segment) => !(
          row.source_format === 'charx' && isRisuModuleLorebookMirrorPath(card, segment.path)
        ))
      : [];
    const segments = [
      ...(row.source_format === 'risum'
        ? []
        : row.source_format === 'st-preset'
          // The generic walker would also offer `role` / `identifier` / sampler
          // keywords for translation, which corrupts the preset.
          ? scanStPreset(card, scanScope)
          : scanCard(card, scanScope, controlLiterals, protocolRules, row.sourceLanguage)),
      ...moduleSegments,
      ...(row.source_format === 'charx' && sourceBlob
        ? scanCharxResourceJson(sourceBlob, scanScope === 'all')
        : []),
    ];
    return segments;
  };
  const segments = scanInventory(scope);
  const replacement = await scanService.replaceScannedSegments(request.params.projectId, scope, segments,
    scope === 'all' ? segments : scanInventory('all'));
  await namespaceReviewService.ensureReviewItem(request.params.projectId);
  return {
    ok: true,
    scope,
    ...replacement,
    protocolCount: protocolDiscovery.schemaCount,
    pendingProtocolCount: protocolDiscovery.pendingCount,
    runtimeRiskCount: runtimeRisks.length,
    runtimeRiskPaths: runtimeRisks.map((risk) => `${risk.pathLabel}：${risk.message}`),
  };
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/jobs', async (request, reply) => {
  const project = await projectById(request.params.projectId);
  if (!project) return reply.code(404).send({ error: '项目不存在。' });
  const expectedScope = text(asRecord(request.body).scope);
  if (project.status === 'new' || (expectedScope && expectedScope !== project.scope)) {
    return reply.code(409).send({ error: '翻译范围已变化，请先按所选范围重新扫描。', code: 'SCAN_SCOPE_CHANGED' });
  }
  const settings = publicSettings();
  if (!settings.apiKeyConfigured || !settings.model) {
    return reply.code(400).send({ error: '请先在模型设置中配置 API Key 和模型名称。' });
  }

  const segmentRows = await db.prepare(`
    SELECT id FROM segments
    WHERE project_id = ? AND in_scope = 1 AND included = 1 AND review_status IN ('untranslated', 'rejected')
      AND path_label <> '$module.namespace'
    ORDER BY sort_order
  `).all(request.params.projectId) as Array<{ id: string }>;
  if (!segmentRows.length) return reply.code(400).send({ error: '没有待翻译的已选段落。' });

  const creation = await translationJobs.createTranslationJob(
    request.params.projectId,
    String(project.scope),
    settings.model,
    segmentRows.map((segment) => segment.id),
    false,
  );
  if (creation.created) scheduleJob(creation.jobId);
  return reply.code(creation.created ? 201 : 200).send(await translationJobs.jobById(creation.jobId));
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/retranslate', async (request, reply) => {
  const project = await projectById(request.params.projectId);
  if (!project) return reply.code(404).send({ error: '项目不存在。' });
  const settings = publicSettings();
  if (!settings.apiKeyConfigured || !settings.model) {
    return reply.code(400).send({ error: '请先在模型设置中配置 API Key 和模型名称。' });
  }
  const body = asRecord(request.body);
  const requestedIds = Array.isArray(body.segmentIds) ? body.segmentIds.map(text).filter(Boolean) : [];
  if (!requestedIds.length) return reply.code(400).send({ error: '请选择需要重新翻译的段落。' });
  const segmentIds = await translationJobs.existingProjectSegmentIds(request.params.projectId, requestedIds);
  if (!segmentIds.length) return reply.code(400).send({ error: '所选段落不属于当前项目。' });

  const creation = await translationJobs.createTranslationJob(
    request.params.projectId,
    String(project.scope),
    settings.model,
    segmentIds,
    true,
  );
  if (creation.created) scheduleJob(creation.jobId);
  return reply.code(creation.created ? 201 : 200).send(await translationJobs.jobById(creation.jobId));
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/clear-results', async (request, reply) => {
  if (!await projectById(request.params.projectId)) return reply.code(404).send({ error: '项目不存在。' });
  if (await translationJobs.hasActiveTranslationJob(request.params.projectId)) {
    return reply.code(409).send({ error: '项目仍在翻译中，请等待完成或先取消任务。' });
  }
  const segmentIds = await translationJobs.projectResultSegmentIds(request.params.projectId);
  if (!segmentIds.length) return { ok: true, cleared: 0 };

  const timestamp = now();
  const draftRow = await db.prepare('SELECT draft_storage_path AS draftStoragePath FROM projects WHERE id = ?')
    .get(request.params.projectId) as { draftStoragePath?: string | null } | undefined;
  await db.transaction(async () => {
    await translationJobs.clearTranslationResults(segmentIds, timestamp);
    await db.prepare(`
      UPDATE projects SET
        draft_json = original_json,
        draft_source_blob = NULL,
        draft_storage_path = NULL,
        draft_storage_bytes = NULL,
        draft_storage_sha256 = NULL,
        status = 'scanned',
        updated_at = ?
      WHERE id = ?
    `).run(timestamp, request.params.projectId);
  });
  await removeStoredFile(draftRow?.draftStoragePath);
  return { ok: true, cleared: segmentIds.length };
});

app.get<{ Params: { jobId: string } }>('/api/jobs/:jobId', async (request, reply) => {
  const job = await translationJobs.jobById(request.params.jobId);
  if (!job) return reply.code(404).send({ error: '任务不存在。' });
  const logs = (await db.prepare(`
    SELECT id, level, message, created_at AS createdAt
    FROM job_logs WHERE job_id = ? ORDER BY id DESC LIMIT 80
  `).all(request.params.jobId)).reverse();
  return { ...job, logs };
});

app.patch<{ Params: { segmentId: string } }>('/api/segments/:segmentId', async (request, reply) => {
  const body = asRecord(request.body);
  const current = await db.prepare('SELECT * FROM segments WHERE id = ?').get(request.params.segmentId) as Record<string, unknown> | undefined;
  if (!current) return reply.code(404).send({ error: '段落不存在。' });
  const finalText = typeof body.finalText === 'string'
    ? body.finalText
    : typeof current.final_text === 'string' ? current.final_text : null;
  const reviewStatusValue = text(body.reviewStatus);
  const reviewStatusProvided = ['untranslated', 'pending', 'approved', 'rejected'].includes(reviewStatusValue);
  const reviewStatus = reviewStatusProvided
    ? reviewStatusValue
    : String(current.review_status);
  const included = typeof body.included === 'boolean' ? Number(body.included) : Number(current.included);
  const effectiveText = String(finalText || current.translated_text || '').trim();
  const currentEffectiveText = String(current.final_text || current.translated_text || '').trim();
  const confirmLanguageIssue = body.confirmLanguageIssue === true;
  const confirmProtectionIssue = body.confirmProtectionIssue === true;
  let languageBehaviorConfirmed = false;
  let protectionIssueConfirmed = false;
  if (reviewStatus === 'approved' && !effectiveText) {
    return reply.code(400).send({ error: '通过前请填写人工定稿或机器译文。' });
  }
  if (reviewStatus === 'approved' && String(current.kind) === 'protocol-field') {
    const issue = protocolFieldReplacementIssue(
      effectiveText,
      String(current.protocol_delimiter || ''),
      String(current.source_text),
    );
    if (issue) return reply.code(400).send({ error: issue });
  }
  if (reviewStatus === 'approved') {
    const project = await db.prepare('SELECT target_language AS targetLanguage, language_behavior_mode AS mode FROM projects WHERE id = ?')
      .get(String(current.project_id)) as { targetLanguage?: string; mode?: string } | undefined;
    if (project?.mode !== 'preserve') {
      const issue = languageBehaviorDirectiveIssue(effectiveText, String(project?.targetLanguage || 'zh-CN'));
      if (issue) {
        const sameText = effectiveText === currentEffectiveText;
        const alreadyConfirmed = String(current.review_status) === 'approved'
          && sameText
          && hasLanguageBehaviorConfirmation(current.qa_flags);
        if (!confirmLanguageIssue && !alreadyConfirmed) {
          const qaFlag = `卡片语言设定待确认：${issue}`;
          await reviewService.appendSegmentQaFlag(request.params.segmentId, qaFlag);
          return reply.code(409).send({
            code: 'LANGUAGE_BEHAVIOR_CONFIRM_REQUIRED',
            error: `${issue}。这条内容可能是卡片明确指定的专用语言，或属于语言选择项目；确认后可保留原设定并通过。`,
            issue,
            qaFlag,
          });
        }
        languageBehaviorConfirmed = true;
      }
    }
  }
  if (reviewStatus === 'approved') {
    const references = await controlReferencesForProject(String(current.project_id));
    const segmentPath = parsePathJson(String(current.path_json));
    const protectedLiterals = protectedTranslationFragments(
      String(current.source_text), references, segmentPath, String(current.kind),
    );
    const missingFragments = missingProtectedFragments(
      String(current.source_text), effectiveText, protectedLiterals,
    );
    if (missingFragments.length > 0) {
      const missingDetails = describeMissingProtectedFragments(missingFragments, references);
      const shownDetails = missingDetails.slice(0, 8)
        .map((item) => `- ${item.kind}：${item.value}${item.count > 1 ? ` ×${item.count}` : ''}${item.referencePaths.length ? `（引用：${item.referencePaths.join('、')}）` : ''}`)
        .join('\n');
      const omitted = missingDetails.length - Math.min(missingDetails.length, 8);
      const qaFlag = `保护结构缺失（${missingFragments.length} 项）：${missingDetails.slice(0, 3).map((item) => item.value).join('、')}`;
      const alreadyConfirmed = String(current.review_status) === 'approved'
        && effectiveText === currentEffectiveText
        && hasProtectionConfirmation(current.qa_flags, effectiveText);
      if (!confirmProtectionIssue && !alreadyConfirmed) {
        await reviewService.appendSegmentQaFlag(request.params.segmentId, qaFlag);
        return reply.code(409).send({
          code: 'PROTECTED_FRAGMENTS_CONFIRM_REQUIRED',
          error: `人工定稿与原文的受保护内容不一致：${current.path_label} 缺少 ${missingFragments.length} 个受保护结构或脚本引用。\n缺少内容：\n${shownDetails}${omitted > 0 ? `\n- 另有 ${omitted} 项未展开` : ''}\n建议先载入原文并只修改可见文字；如果这些内容确实需要翻译或删除，可以确认本次变更后通过。`,
          pathLabel: String(current.path_label),
          missingFragments: missingDetails,
          qaFlag,
        });
      }
      protectionIssueConfirmed = true;
    }
  }
  const qaFlags = safeArray(current.qa_flags).map(String)
    .filter((flag) => flag !== LANGUAGE_BEHAVIOR_CONFIRMATION_FLAG)
    .filter((flag) => !flag.startsWith(PROTECTION_CONFIRMATION_FLAG_PREFIX))
    .filter((flag) => reviewStatus !== 'approved' || !isReviewProblemQaFlag(flag));
  if (reviewStatus === 'approved' && languageBehaviorConfirmed) qaFlags.push(LANGUAGE_BEHAVIOR_CONFIRMATION_FLAG);
  if (reviewStatus === 'approved' && protectionIssueConfirmed) qaFlags.push(protectionConfirmationFlag(effectiveText));
  if (typeof body.finalText === 'string' || reviewStatusProvided) {
    await translationJobs.cancelActiveJobItemsForManualReview(request.params.segmentId, String(current.path_label));
  }
  await db.prepare('UPDATE segments SET final_text = ?, review_status = ?, included = ?, qa_flags = ?, updated_at = ? WHERE id = ?')
    .run(finalText, reviewStatus, included, JSON.stringify(qaFlags), now(), request.params.segmentId);
  if (reviewStatus === 'approved') await translationJobs.resolveFailedJobItems(request.params.segmentId, String(current.path_label));
  const references = await controlReferencesForProject(String(current.project_id));
  return normalizeSegment(await db.prepare(`
    SELECT s.id, s.path_json AS pathJson, s.path_label AS pathLabel, s.category, s.kind, s.source_text AS sourceText,
      s.protocol_delimiter AS protocolDelimiter,
      s.translated_text AS translatedText, s.final_text AS finalText, s.start_pos AS start,
      s.end_pos AS end, s.risk_level AS riskLevel, s.review_status AS reviewStatus,
      s.included, s.qa_flags AS qaFlags, s.sort_order AS sortOrder, s.updated_at AS updatedAt,
      (
        SELECT CASE WHEN ji.status = 'failed' THEN ji.last_error ELSE NULL END
        FROM job_items ji
        WHERE ji.segment_id = s.id
        ORDER BY ji.updated_at DESC, ji.rowid DESC
        LIMIT 1
      ) AS translationError
    FROM segments s WHERE s.id = ?
  `).get(request.params.segmentId) as Record<string, unknown>, references);
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/review-bulk', async (request, reply) => {
  if (!await projectById(request.params.projectId)) return reply.code(404).send({ error: '项目不存在。' });
  const body = asRecord(request.body);
  const action = text(body.action);
  const ids = await translationJobs.existingProjectSegmentIds(
    request.params.projectId,
    Array.isArray(body.segmentIds) ? body.segmentIds.map(text).filter(Boolean) : [],
  );
  if (!ids.length) return reply.code(400).send({ error: '请选择审核条目。' });
  if (action !== 'copy-machine' && action !== 'clear-manual') {
    return reply.code(400).send({ error: '批量审核操作无效。' });
  }
  for (const segmentId of ids) {
    await translationJobs.cancelActiveJobItemsForManualReview(segmentId, '批量审核操作');
  }
  const timestamp = now();
  const copyMachine = db.prepare(`
    UPDATE segments
    SET final_text = translated_text,
        review_status = CASE WHEN translated_text IS NULL OR TRIM(translated_text) = '' THEN review_status ELSE 'pending' END,
        qa_flags = CASE WHEN translated_text IS NULL OR TRIM(translated_text) = '' THEN qa_flags ELSE json_insert(CASE WHEN json_valid(qa_flags) THEN qa_flags ELSE '[]' END, '$[#]', '已批量载入机器译文，待人工确认') END,
        updated_at = ?
    WHERE id = ? AND project_id = ?
  `);
  const clearManual = db.prepare("UPDATE segments SET final_text = NULL, review_status = CASE WHEN translated_text IS NULL OR TRIM(translated_text) = '' THEN 'untranslated' ELSE 'pending' END, updated_at = ? WHERE id = ? AND project_id = ?");
  await db.transaction(async () => {
    for (const idValue of ids) {
      if (action === 'copy-machine') await copyMachine.run(timestamp, idValue, request.params.projectId);
      else await clearManual.run(timestamp, idValue, request.params.projectId);
    }
  });
  return { ok: true, updated: ids.length, action };
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/approve-safe', async (request, reply) => {
  const body = asRecord(request.body);
  const result = await reviewService.approveValidatedSegments(
    request.params.projectId,
    true,
    body.confirmLanguageIssues === true,
    body.confirmProtectionIssues === true,
  );
  if (result.languageConfirmationRequired?.length) {
    return reply.code(409).send({
      code: 'LANGUAGE_BEHAVIOR_CONFIRM_REQUIRED',
      error: `有 ${result.languageConfirmationRequired.length} 条内容包含非目标语言的卡片语言设定，需要确认后才能批量通过。`,
      items: result.languageConfirmationRequired.slice(0, 12),
      total: result.languageConfirmationRequired.length,
    });
  }
  if (result.protectionConfirmationRequired?.length) {
    return reply.code(409).send({
      code: 'PROTECTED_FRAGMENTS_CONFIRM_REQUIRED',
      error: `有 ${result.protectionConfirmationRequired.length} 条人工译文修改或删除了受保护结构或脚本引用。确认后将按当前译文保存并通过，不再跳过。`,
      items: result.protectionConfirmationRequired.slice(0, 12),
      total: result.protectionConfirmationRequired.length,
    });
  }
  return reply.send({ ok: true, ...result });
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/approve-all', async (request, reply) => {
  const body = asRecord(request.body);
  const result = await reviewService.approveValidatedSegments(
    request.params.projectId,
    false,
    body.confirmLanguageIssues === true,
    body.confirmProtectionIssues === true,
  );
  if (result.languageConfirmationRequired?.length) {
    return reply.code(409).send({
      code: 'LANGUAGE_BEHAVIOR_CONFIRM_REQUIRED',
      error: `有 ${result.languageConfirmationRequired.length} 条内容包含非目标语言的卡片语言设定，需要确认后才能批量通过。`,
      items: result.languageConfirmationRequired.slice(0, 12),
      total: result.languageConfirmationRequired.length,
    });
  }
  if (result.protectionConfirmationRequired?.length) {
    return reply.code(409).send({
      code: 'PROTECTED_FRAGMENTS_CONFIRM_REQUIRED',
      error: `有 ${result.protectionConfirmationRequired.length} 条人工译文修改或删除了受保护结构或脚本引用。确认后将按当前译文保存并通过，不再跳过。`,
      items: result.protectionConfirmationRequired.slice(0, 12),
      total: result.protectionConfirmationRequired.length,
    });
  }
  return reply.send({ ok: true, ...result });
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/apply', async (request, reply) => {
  try {
    return await exportService.applyProject(request.params.projectId);
  } catch (error) {
    return sendWorkflowError(reply, error);
  }
});

app.get<{ Params: { projectId: string }; Querystring: { presetBundle?: string } }>('/api/projects/:projectId/export', async (request, reply) => {
  try {
    const output = await exportService.exportProject(request.params.projectId, { presetBundle: request.query.presetBundle === 'true' });
    return reply
      .header('Content-Type', output.contentType)
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(output.filename)}`)
      .send(output.body);
  } catch (error) {
    return sendWorkflowError(reply, error);
  }
});

/**
 * Choose which SillyTavern `prompt_order` block a preset project converts.
 * `blockIndex: null` restores the automatic (superset) block.
 */
app.put<{ Params: { projectId: string }; Body: { blockIndex?: unknown } }>(
  '/api/projects/:projectId/preset-block',
  async (request, reply) => {
    const row = await db.prepare('SELECT source_format AS sourceFormat, original_json AS originalJson FROM projects WHERE id = ?')
      .get(request.params.projectId) as { sourceFormat?: string; originalJson?: string } | undefined;
    if (!row) return reply.code(404).send({ error: '项目不存在。' });
    if (row.sourceFormat !== 'st-preset') return reply.code(409).send({ error: '该项目不是 SillyTavern 预设。' });

    const body = asRecord(request.body);
    const requested = body.blockIndex;
    if (requested !== null && requested !== undefined && (!Number.isInteger(requested) || Number(requested) < 0)) {
      return reply.code(400).send({ error: 'blockIndex 必须是非负整数或 null。' });
    }
    const preset = JSON.parse(row.originalJson || '{}') as Record<string, unknown>;
    const analysis = analyzeStPreset(preset);
    const blockIndex = requested === null || requested === undefined ? null : Number(requested);
    if (blockIndex !== null && !analysis.blocks.some((block) => block.index === blockIndex)) {
      return reply.code(400).send({ error: `预设中不存在 prompt_order 块 ${blockIndex}。` });
    }

    await db.prepare('UPDATE projects SET preset_block_index = ?, updated_at = ? WHERE id = ?')
      .run(blockIndex, now(), request.params.projectId);
    return {
      ok: true,
      blockIndex,
      effectiveBlockIndex: blockIndex ?? analysis.recommendedBlockIndex,
      blocks: analysis.blocks,
      recommendedBlockIndex: analysis.recommendedBlockIndex,
    };
  },
);

interface PresetProjectRow {
  sourceFormat?: string;
  originalJson?: string;
  draftJson?: string;
  presetBlockIndex?: number | null;
}

async function readPresetProjectRow(projectId: string): Promise<PresetProjectRow | undefined> {
  return await db.prepare(`
    SELECT source_format AS sourceFormat, original_json AS originalJson,
      draft_json AS draftJson, preset_block_index AS presetBlockIndex
    FROM projects WHERE id = ?
  `).get(projectId) as PresetProjectRow | undefined;
}

function presetBlockOption(row: PresetProjectRow): { blockIndex?: number } {
  return typeof row.presetBlockIndex === 'number' ? { blockIndex: row.presetBlockIndex } : {};
}

/**
 * Current conversion state of a preset project: analysis, conversion report and
 * every prompt with its live draft text. Computed on demand — conversion is a
 * pure function, so this needs no table of its own.
 */
app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/preset-report', async (request, reply) => {
  const row = await readPresetProjectRow(request.params.projectId);
  if (!row) return reply.code(404).send({ error: '项目不存在。' });
  if (row.sourceFormat !== 'st-preset') return reply.code(409).send({ error: '该项目不是 SillyTavern 预设。' });
  const original = JSON.parse(row.originalJson || '{}') as Record<string, unknown>;
  const draft = JSON.parse(row.draftJson || row.originalJson || '{}') as Record<string, unknown>;
  const blockIndex = typeof row.presetBlockIndex === 'number' ? row.presetBlockIndex : null;
  return buildPresetProjectView(original, draft, blockIndex);
});

/**
 * Edit one copy field of a preset project.
 *
 * When the edit removes the last always-on `{{setvar::…}}` definition of a
 * variable that is still read elsewhere, the write is refused with
 * `SETVAR_DEFINITION_REMOVED` until the caller echoes the variable names back in
 * `confirmRemovals`. Every reference to a variable with no definition resolves to
 * an empty string, which silently breaks the preset without breaking the import.
 */
app.put<{ Params: { projectId: string }; Body: { path?: unknown; text?: unknown; confirmRemovals?: unknown } }>(
  '/api/projects/:projectId/preset-prompt',
  async (request, reply) => {
    const row = await readPresetProjectRow(request.params.projectId);
    if (!row) return reply.code(404).send({ error: '项目不存在。' });
    if (row.sourceFormat !== 'st-preset') return reply.code(409).send({ error: '该项目不是 SillyTavern 预设。' });

    const body = asRecord(request.body);
    const path = body.path;
    if (!Array.isArray(path) || !isEditablePresetPath(path as Array<string | number>)) {
      return reply.code(400).send({ error: '只允许编辑预设名称与提示词的名称/正文。' });
    }
    if (typeof body.text !== 'string') return reply.code(400).send({ error: 'text 必须是字符串。' });

    const original = JSON.parse(row.originalJson || '{}') as Record<string, unknown>;
    const draft = JSON.parse(row.draftJson || row.originalJson || '{}') as Record<string, unknown>;

    let next: Record<string, unknown>;
    try {
      next = writePresetPath(draft, path as Array<string | number>, body.text);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }

    const options = presetBlockOption(row);
    const impact = analyzePresetEditImpact(draft, next, options);
    const confirmed = new Set(
      Array.isArray(body.confirmRemovals)
        ? body.confirmRemovals.filter((value): value is string => typeof value === 'string')
        : [],
    );
    const unconfirmed = impact.blocking.filter((removal) => !confirmed.has(removal.name));
    if (unconfirmed.length) {
      return reply.code(409).send({
        code: SETVAR_DEFINITION_REMOVED,
        error: `这次编辑会删除 ${unconfirmed.length} 个仍被引用的变量定义，删除后引用处会变成空字符串。`,
        removals: unconfirmed.map((removal) => ({
          name: removal.name,
          references: removal.references.map((site) => site.item),
        })),
      });
    }

    await db.prepare('UPDATE projects SET draft_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(next), now(), request.params.projectId);

    const view = buildPresetProjectView(original, next, typeof row.presetBlockIndex === 'number' ? row.presetBlockIndex : null);
    const warnings = [
      ...validateEditedText(body.text, view.report.toggleKeys),
      ...impact.noted.map((removal) => `变量 ${removal.name} 已无定义，但当前没有任何地方引用它。`),
    ];
    return { ok: true, ...view, warnings, appliedRemovals: impact.blocking.map((removal) => removal.name) };
  },
);

/** Restore the whole draft, or a single path, from the untouched original. */
app.post<{ Params: { projectId: string }; Body: { path?: unknown } }>(
  '/api/projects/:projectId/preset-reset',
  async (request, reply) => {
    const row = await readPresetProjectRow(request.params.projectId);
    if (!row) return reply.code(404).send({ error: '项目不存在。' });
    if (row.sourceFormat !== 'st-preset') return reply.code(409).send({ error: '该项目不是 SillyTavern 预设。' });

    const original = JSON.parse(row.originalJson || '{}') as Record<string, unknown>;
    const body = asRecord(request.body);
    let next: Record<string, unknown>;

    if (Array.isArray(body.path)) {
      if (!isEditablePresetPath(body.path as Array<string | number>)) {
        return reply.code(400).send({ error: '只允许恢复预设名称与提示词的名称/正文。' });
      }
      const draft = JSON.parse(row.draftJson || row.originalJson || '{}') as Record<string, unknown>;
      try {
        next = writePresetPath(draft, body.path as Array<string | number>, readPresetPath(original, body.path as Array<string | number>));
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    } else {
      next = original;
    }

    await db.prepare('UPDATE projects SET draft_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(next), now(), request.params.projectId);
    const blockIndex = typeof row.presetBlockIndex === 'number' ? row.presetBlockIndex : null;
    return { ok: true, ...buildPresetProjectView(original, next, blockIndex) };
  },
);

const webRoot = workbenchConfig.paths.webRoot;
if (existsSync(webRoot)) {
  // Keep the SPA fallback below, but let the static plugin claim built assets first.
  await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((request, reply) => {
    if (request.method === 'GET' && !request.url.startsWith('/api/')) return reply.sendFile('index.html');
    return reply.code(404).send({ error: 'Not found' });
  });
}

let serverAddress: string | null = null;

export async function startWorkbenchServer(options: { host?: string; port?: number } = {}): Promise<{
  address: string;
  host: string;
  port: number;
}> {
  if (serverAddress) {
    return {
      address: serverAddress,
      host: options.host || workbenchConfig.host,
      port: options.port || workbenchConfig.port,
    };
  }
  const host = options.host || workbenchConfig.host;
  const port = options.port || workbenchConfig.port;
  serverAddress = await app.listen({ host, port });
  // Reattach persisted jobs after the process has restarted. Without this,
  // queued/running rows remain visible forever even though their items may
  // already be complete.
  await recoverInterruptedJobs();
  return { address: serverAddress, host, port };
}

export async function stopWorkbenchServer(): Promise<void> {
  if (serverAddress) {
    await app.close();
    serverAddress = null;
  }
  await db.close();
}

if (process.env.WORKBENCH_EMBEDDED !== '1') {
  await startWorkbenchServer();
}

async function protocolSourceByProject(projectId: string): Promise<{
  card: Record<string, unknown>;
  module: Record<string, unknown> | null;
} | null> {
  const row = await db.prepare(`
    SELECT original_json AS originalJson, original_module_json AS originalModuleJson,
      source_format AS sourceFormat, source_blob AS sourceBlob,
      source_storage_path AS sourceStoragePath
    FROM projects WHERE id = ?
  `).get(projectId) as {
    originalJson?: string;
    originalModuleJson?: string | null;
    sourceFormat?: string;
    sourceBlob?: Uint8Array | null;
    sourceStoragePath?: string | null;
  } | undefined;
  if (!row?.originalJson) return null;
  const card = JSON.parse(row.originalJson) as Record<string, unknown>;
  let module = row.originalModuleJson
    ? JSON.parse(row.originalModuleJson) as Record<string, unknown>
    : null;
  const sourceBlob = row.sourceBlob || (row.sourceStoragePath ? await readStoredFile(row.sourceStoragePath) : null);
  if (!module && row.sourceFormat === 'charx' && sourceBlob) {
    module = parseCharx(sourceBlob).module;
  }
  return { card, module };
}

async function projectById(projectId: string): Promise<Record<string, unknown> | undefined> {
  return await db.prepare(`
    SELECT
      p.id, p.name, ${PROJECT_TITLE_COLUMNS}, ${PROJECT_VERSION_COLUMNS},
      p.source_format AS sourceFormat, p.source_language AS sourceLanguage,
      p.target_language AS targetLanguage, p.language_behavior_mode AS languageBehaviorMode, p.scope, p.status, p.original_hash AS originalHash,
      p.source_filename AS sourceFilename,
      p.created_at AS createdAt, p.updated_at AS updatedAt
    FROM projects p WHERE p.id = ?
  `).get(projectId) as Record<string, unknown> | undefined;
}

function projectRisuSourceReader(projectId: string, length: number): RisuModuleSourceReader {
  const windowSize = 64 * 1024 * 1024;
  let cachedOffset = -1;
  let cachedBytes: Uint8Array<ArrayBufferLike> = new Uint8Array();
  return {
    length,
    async read(offset, byteLength) {
      if (byteLength === 0) return new Uint8Array();
      if (cachedOffset >= 0 && offset >= cachedOffset && offset + byteLength <= cachedOffset + cachedBytes.length) {
        return cachedBytes.subarray(offset - cachedOffset, offset - cachedOffset + byteLength);
      }
      const readOffset = Math.floor(offset / windowSize) * windowSize;
      const readLength = Math.min(length - readOffset, Math.max(windowSize, offset + byteLength - readOffset));
      const row = await db.prepare('SELECT source_storage_path AS sourceStoragePath FROM projects WHERE id = ?')
        .get(projectId) as { sourceStoragePath?: string | null } | undefined;
      const chunk = row?.sourceStoragePath
        ? await readStoredFileRange(row.sourceStoragePath, readOffset, readLength)
        : (await db.prepare('SELECT substr(source_blob, ?, ?) AS chunk FROM projects WHERE id = ?')
          .get(readOffset + 1, readLength, projectId) as { chunk?: Uint8Array | null } | undefined)?.chunk;
      if (!chunk) throw new Error('当前项目没有保存原始资源。');
      cachedOffset = readOffset;
      cachedBytes = chunk;
      return cachedBytes.subarray(offset - cachedOffset, offset - cachedOffset + byteLength);
    },
  };
}

async function projectResourceBytes(
  projectId: string,
  sourceFormat: string,
  sourceBlob: Uint8Array | null | undefined,
  sourceBytes: number | null | undefined,
  resourcePath: string,
): Promise<Buffer> {
  if (sourceFormat !== 'risum') {
    const source = sourceBlob || (await projectStoragePathForRead(projectId));
    if (!source) throw new Error('当前项目没有保存原始资源。');
    return readResourceBytes(sourceFormat, source, resourcePath);
  }
  const match = resourcePath.match(/^module-assets\/(\d+)\.bin$/u);
  if (!match) throw new Error('RISUM 资源路径无效。');
  return readRisuModuleAssetFromReader(
    projectRisuSourceReader(projectId, Number(sourceBytes) || 0),
    Number(match[1]) - 1,
  );
}

async function projectStoragePathForRead(projectId: string): Promise<Buffer | null> {
  const row = await db.prepare('SELECT source_storage_path AS sourceStoragePath FROM projects WHERE id = ?')
    .get(projectId) as { sourceStoragePath?: string | null } | undefined;
  return row?.sourceStoragePath ? await readStoredFile(row.sourceStoragePath) : null;
}

async function controlReferencesForProject(projectId: string): Promise<RisuControlReference[]> {
  const cached = controlReferenceCache.get(projectId);
  if (cached) return cached;
  const row = await db.prepare('SELECT original_module_json AS originalModuleJson FROM projects WHERE id = ?')
    .get(projectId) as { originalModuleJson?: string | null } | undefined;
  if (!row?.originalModuleJson) return [];
  try {
    const references = risuControlReferences(JSON.parse(row.originalModuleJson) as Record<string, unknown>);
    controlReferenceCache.set(projectId, references);
    return references;
  } catch {
    return [];
  }
}

function normalizeSegment(
  row: Record<string, unknown>,
  references: readonly RisuControlReference[] = [],
): Record<string, unknown> {
  const path = parsePathJson(String(row.pathJson ?? '[]'));
  const { pathJson: _pathJson, ...segment } = row;
  return {
    ...segment,
    included: Boolean(row.included),
    qaFlags: safeArray(row.qaFlags).map(String)
      .filter((flag) => flag !== LANGUAGE_BEHAVIOR_CONFIRMATION_FLAG)
      .filter((flag) => !flag.startsWith(PROTECTION_CONFIRMATION_FLAG_PREFIX)),
    controlReferences: controlReferencesInText(
      String(row.sourceText ?? ''), references, path, String(row.kind ?? ''),
    ).map((reference) => ({
      literal: reference.literal,
      kind: reference.kind,
      pathLabel: reference.pathLabel,
      pattern: reference.pattern,
    })),
  };
}

async function projectSegments(
  projectId: string,
  references: readonly RisuControlReference[],
  limit?: number,
  offset = 0,
): Promise<Array<Record<string, unknown>>> {
  const pagination = limit === undefined ? '' : ' LIMIT ? OFFSET ?';
  const params = limit === undefined ? [projectId] : [projectId, limit, offset];
  const rows = await db.prepare(`
    SELECT
      s.id,
      s.path_json AS pathJson,
      s.path_label AS pathLabel,
      s.category,
      s.kind,
      s.protocol_delimiter AS protocolDelimiter,
      s.source_text AS sourceText,
      s.translated_text AS translatedText,
      s.final_text AS finalText,
      s.start_pos AS start,
      s.end_pos AS end,
      s.risk_level AS riskLevel,
      s.review_status AS reviewStatus,
      s.included,
      s.qa_flags AS qaFlags,
      s.sort_order AS sortOrder,
      s.updated_at AS updatedAt,
      (
        SELECT CASE WHEN ji.status = 'failed' THEN ji.last_error ELSE NULL END
        FROM job_items ji
        WHERE ji.segment_id = s.id
        ORDER BY ji.updated_at DESC, ji.rowid DESC
        LIMIT 1
      ) AS translationError
    FROM segments s
    WHERE s.project_id = ? AND s.in_scope = 1
    ORDER BY s.sort_order, s.id${pagination}
  `).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => normalizeSegment(row, references));
}

async function projectSegmentSummary(projectId: string): Promise<{
  totalSegments: number;
  pendingSegments: number;
  approvedSegments: number;
  highRiskSegments: number;
  protocolSegments: number;
  luaSegments: number;
}> {
  const row = await db.prepare(`
    SELECT
      COUNT(*) AS totalSegments,
      COALESCE(SUM(CASE WHEN review_status = 'pending' THEN 1 ELSE 0 END), 0) AS pendingSegments,
      COALESCE(SUM(CASE WHEN review_status = 'approved' THEN 1 ELSE 0 END), 0) AS approvedSegments,
      COALESCE(SUM(CASE WHEN risk_level = 'high' THEN 1 ELSE 0 END), 0) AS highRiskSegments,
      COALESCE(SUM(CASE WHEN kind = 'protocol-field' THEN 1 ELSE 0 END), 0) AS protocolSegments,
      COALESCE(SUM(CASE WHEN kind LIKE 'lua-%' OR kind = 'runtime-message' THEN 1 ELSE 0 END), 0) AS luaSegments
    FROM segments
    WHERE project_id = ? AND in_scope = 1
  `).get(projectId) as Record<string, unknown>;
  return {
    totalSegments: Number(row.totalSegments) || 0,
    pendingSegments: Number(row.pendingSegments) || 0,
    approvedSegments: Number(row.approvedSegments) || 0,
    highRiskSegments: Number(row.highRiskSegments) || 0,
    protocolSegments: Number(row.protocolSegments) || 0,
    luaSegments: Number(row.luaSegments) || 0,
  };
}

function scanSummaryFromSegments(segments: Array<Record<string, unknown>>) {
  return {
    totalSegments: segments.length,
    pendingSegments: segments.filter((segment) => String(segment.reviewStatus) === 'pending').length,
    approvedSegments: segments.filter((segment) => String(segment.reviewStatus) === 'approved').length,
    highRiskSegments: segments.filter((segment) => String(segment.riskLevel) === 'high').length,
    protocolSegments: segments.filter((segment) => String(segment.kind) === 'protocol-field').length,
    luaSegments: segments.filter((segment) => String(segment.kind).startsWith('lua-') || String(segment.kind) === 'runtime-message').length,
  };
}

function sendWorkflowError(reply: FastifyReply, error: unknown) {
  if (error instanceof ProjectWorkflowError) {
    return reply.code(error.statusCode).send({ error: error.message, ...error.payload });
  }
  throw error;
}

function nonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveIntegerQuery(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeScope(value: string): ScopePreset {
  return ['core', 'standard', 'visible-scripts', 'all-visible', 'all', 'lua-only'].includes(value)
    ? value as ScopePreset
    : 'all';
}

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'translated-card';
}

function exportLanguageTag(value: string): string {
  return sanitizeFilename(value.trim() || 'target').replace(/\s+/g, '-');
}

function parseRouterRepairOverrides(value: unknown): PortraitRouterRepairOverride[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('路由修改列表格式无效。');
  return value.map((entry) => {
    const item = asRecord(entry);
    const id = text(item.id);
    if (id !== 'completion-marker-gate' && id !== 'main-passthrough') throw new Error('路由修改类型不在安全范围内。');
    const pathLabel = text(item.pathLabel);
    const before = typeof item.before === 'string' ? item.before : '';
    const after = typeof item.after === 'string' ? item.after : '';
    if (!pathLabel || !before || !after) throw new Error('路由修改缺少位置或代码内容。');
    return { id, pathLabel, before, after };
  });
}

function mergeRouterRepairChanges(
  changes: PortraitRouterRepairChange[],
  overrides: PortraitRouterRepairOverride[],
): PortraitRouterRepairChange[] {
  return changes.map((change) => {
    const override = overrides.find((item) => item.id === change.id && item.pathLabel === change.pathLabel);
    return override ? { ...change, after: override.after } : change;
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
