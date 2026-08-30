import { existsSync } from 'node:fs';
import path from 'node:path';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply } from 'fastify';
import { db, id, now } from './db.js';
import {
  cardName,
  controlReferencesInText,
  missingProtectedFragments,
  risuControlReferences,
  risuTranslationControlFragments,
  scanCard,
  scanRisuModule,
  validateRisuControlReferences,
  type RisuControlReference,
  type ScopePreset,
} from './domain/card.js';
import {
  findCharxCover,
  isRisuModuleLorebookMirrorPath,
  parseCharx,
} from './domain/charx.js';
import { parseCardPng } from './domain/png.js';
import { inspectProjectOverview } from './domain/tavern-card.js';
import { parseRisuModule, readRisuModuleAssetFromReader, type RisuModuleSourceReader } from './domain/risum.js';
import { detectRisuRuntimeRisks, validateRisuTemplateChanges } from './domain/risu-qa.js';
import { buildLuaManagementReport } from './domain/lua-management.js';
import { applyPortraitRouterRepairs } from './domain/portrait-router-repair.js';
import { validateRisuLuaChanges } from './domain/risu-lua.js';
import { inspectCharxResources, inspectRisuModuleResourcesStreaming, readResourceBytes, resourceContentType, scanCharxResourceJson } from './domain/resources.js';
import { recognizeImage, type OcrLanguage } from './domain/ocr.js';
import { editImageText } from './domain/image-edit.js';
import { protocolFieldReplacementIssue } from './domain/protocol.js';
import {
  approvedProtocolRules,
  discoverAndStoreProtocols,
  listProtocolSchemas,
  protocolSchemasForAnalysis,
  setProtocolAnalysisError,
  updateProtocolAnalysis,
  updateProtocolSchema,
} from './protocol-service.js';
import { abortJob, analyzeProtocolSemantics, privateImageSettings, publicSettings, scheduleJob, segmentRuntimeNames, translateRuntimeAliases } from './scheduler.js';
import { languageBehaviorDirectiveIssue } from './domain/language-directives.js';
import { workbenchConfig } from './config.js';
import { PROJECT_TITLE_COLUMNS } from './repositories/project-queries.js';
import { createScanService } from './application/scan-service.js';
import { createProjectService } from './application/project-service.js';
import { createTranslationJobService } from './application/translation-job-service.js';
import { createExportService, ProjectWorkflowError } from './application/export-service.js';
import {
  createReviewService,
  describeMissingProtectedFragments,
  protectedTranslationFragments,
} from './application/review-service.js';
import {
  hasLanguageBehaviorConfirmation,
  hasProtectionConfirmation,
  isReviewProblemQaFlag,
  LANGUAGE_BEHAVIOR_CONFIRMATION_FLAG,
  parsePathJson,
  protectionConfirmationFlag,
  PROTECTION_CONFIRMATION_FLAG_PREFIX,
  safeArray,
} from './application/review-metadata.js';
import { registerSessionToolRoutes } from './routes/session-tools.js';
import { registerSystemRoutes } from './routes/system.js';
import { readStoredFile, readStoredFileRange, storeFile, projectStoragePath, imageExtension, removeProjectStorage, removeStoredFile } from './storage.js';
import {
  isUploadTooLargeError,
  uploadLimitBytes,
  uploadTooLargeMessage,
} from './upload-limit.js';

const uploadLimitMib = workbenchConfig.uploadLimitMib;
const uploadBytes = uploadLimitBytes(uploadLimitMib);
const app = Fastify({ logger: true, bodyLimit: uploadBytes });
await app.register(multipart, { limits: { fileSize: uploadBytes, files: 1 } });
const controlReferenceCache = new Map<string, RisuControlReference[]>();
const translationJobs = createTranslationJobService({ database: db, createId: id, clock: now });
const scanService = createScanService({
  database: db,
  createId: id,
  clock: now,
  refreshHistoricalJobsAfterScan: translationJobs.refreshHistoricalJobsAfterScan,
});
const projectService = createProjectService({
  database: db,
  createId: id,
  clock: now,
  languageRoute: publicSettings,
});
const { createProject } = projectService;
const reviewService = createReviewService({
  database: db,
  clock: now,
  publicSettings,
  controlReferencesForProject,
  resolveFailedJobItems: translationJobs.resolveFailedJobItems,
});
const exportService = createExportService({
  database: db,
  clock: now,
  targetLanguage: () => publicSettings().targetLanguage,
  review: reviewService,
  segmentRuntimeNames,
  translateRuntimeAliases,
});

registerSystemRoutes(app);

app.post('/api/projects', async (request, reply) => {
  const body = asRecord(request.body);
  const card = asRecord(body.card);
  if (!Object.keys(card).length) return reply.code(400).send({ error: '卡片 JSON 必须是对象。' });
  const name = text(body.name) || cardName(card);
  const sourceFormat = text(body.sourceFormat) || 'json';
  return reply.code(201).send(await projectById(await createProject({ name, sourceFormat, card })));
});

app.post('/api/projects/import', async (request, reply) => {
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
      const card = asRecord(JSON.parse(buffer.toString('utf8')));
      if (!Object.keys(card).length) return reply.code(400).send({ error: 'JSON 卡片必须是对象。' });
      const projectId = await createProject({ name: cardName(card), sourceFormat: 'json', card, filename: part.filename });
      return reply.code(201).send(await projectById(projectId));
    }
    if (extension === '.png' || part.mimetype === 'image/png') {
      const parsed = parseCardPng(buffer);
      const projectId = await createProject({
        name: cardName(parsed.card), sourceFormat: 'png', card: parsed.card,
        filename: part.filename, blob: buffer, metadataKeys: parsed.metadataKeys,
      });
      return reply.code(201).send(await projectById(projectId));
    }
    if (extension === '.charx') {
      const parsed = parseCharx(buffer);
      const projectId = await createProject({
        name: cardName(parsed.card), sourceFormat: 'charx', card: parsed.card,
        module: parsed.module, filename: part.filename, blob: buffer,
      });
      return reply.code(201).send(await projectById(projectId));
    }
    if (extension === '.risum') {
      const parsed = parseRisuModule(buffer);
      const name = text(parsed.module.name) || path.basename(part.filename, extension) || '未命名模块';
      const projectId = await createProject({
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

registerSessionToolRoutes(app, uploadLimitMib, { createProject, projectById, cardName });

app.get<{ Params: { projectId: string }; Querystring: { segments?: string } }>('/api/projects/:projectId', async (request, reply) => {
  const project = await projectById(request.params.projectId);
  if (!project) return reply.code(404).send({ error: '项目不存在。' });
  const controlReferences = await controlReferencesForProject(request.params.projectId);
  const includeSegments = request.query.segments !== 'none';
  const segments = includeSegments
    ? await projectSegments(request.params.projectId, controlReferences)
    : [];
  const jobs = await db.prepare(`
    SELECT
      id, status, scope, model,
      total_items AS totalItems,
      completed_items AS completedItems,
      failed_items AS failedItems,
      last_error AS lastError,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM jobs WHERE project_id = ? ORDER BY created_at DESC LIMIT 20
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
  return {
    ...project,
    controlReferences: controlReferences.map((reference) => ({
      literal: reference.literal,
      kind: reference.kind,
      pathLabel: reference.pathLabel,
      pattern: reference.pattern,
    })),
    segments,
    jobs,
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
    const candidates = await db.prepare(`
      SELECT resource_path AS resourcePath, text, confidence, engine, status, updated_at AS updatedAt
      FROM resource_ocr_candidates WHERE project_id = ?
    `).all(request.params.projectId) as Array<{
      resourcePath: string;
      text: string;
      confidence: number | null;
      engine: string;
      status: 'draft' | 'confirmed';
      updatedAt: string;
    }>;
    const candidateMap = new Map(candidates.map((candidate) => [candidate.resourcePath, candidate]));
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
        const candidate = candidateMap.get(resource.path);
        const imageCandidate = imageCandidateMap.get(resource.path);
        return candidate || imageCandidate ? {
          ...resource,
          ...(candidate ? { ocrCandidate: {
            text: candidate.text,
            confidence: candidate.confidence,
            engine: candidate.engine,
            status: candidate.status,
            updatedAt: candidate.updatedAt,
          } } : {}),
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

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/resources/image-edit', async (request, reply) => {
  const resourcePath = text(asRecord(request.body).path);
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
    const imageSettings = privateImageSettings();
    const targetLanguage = row.targetLanguage || publicSettings().targetLanguage;
    const result = await editImageText(bytes, mimeType, targetLanguage, imageSettings);
    const prompt = `仅将画面文字替换为 ${targetLanguage}，保持其他视觉内容不变。`;
    const timestamp = now();
    const storedImage = await storeFile(
      projectStoragePath(request.params.projectId, 'image', imageExtension(result.mimeType), resourcePath),
      result.bytes,
    );
    await db.prepare(`
      INSERT INTO resource_image_candidates(
        id, project_id, resource_path, mime_type, image_blob, storage_path, storage_bytes, storage_sha256,
        prompt, model, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, zeroblob(0), ?, ?, ?, ?, ?, 'draft', ?, ?)
      ON CONFLICT(project_id, resource_path) DO UPDATE SET mime_type = excluded.mime_type, image_blob = zeroblob(0),
        storage_path = excluded.storage_path, storage_bytes = excluded.storage_bytes, storage_sha256 = excluded.storage_sha256,
        prompt = excluded.prompt, model = excluded.model, status = 'draft', updated_at = excluded.updated_at
    `).run(id(), request.params.projectId, resourcePath, result.mimeType, storedImage.path, storedImage.bytes, storedImage.sha256, prompt, imageSettings.model, timestamp, timestamp);
    return { path: resourcePath, mimeType: result.mimeType, model: imageSettings.model, prompt, status: 'draft', updatedAt: timestamp };
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
  if (!result.changes) return reply.code(404).send({ error: '请先生成 AI 图片替换稿。' });
  return { ok: true, path: resourcePath, status, updatedAt: timestamp };
});

app.get<{ Params: { projectId: string }; Querystring: { path?: string } }>('/api/projects/:projectId/resources/image-edit/file', async (request, reply) => {
  const resourcePath = text(request.query.path);
  const row = await db.prepare(`
    SELECT mime_type AS mimeType, image_blob AS imageBlob, storage_path AS storagePath FROM resource_image_candidates
    WHERE project_id = ? AND resource_path = ?
  `).get(request.params.projectId, resourcePath) as { mimeType?: string; imageBlob?: Uint8Array | null; storagePath?: string | null } | undefined;
  const imageBlob = row?.imageBlob || (row?.storagePath ? await readStoredFile(row.storagePath) : null);
  if (!imageBlob) return reply.code(404).send({ error: 'AI 图片替换稿不存在。' });
  return reply.header('Content-Type', row?.mimeType || 'image/png').send(Buffer.from(imageBlob));
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/resources/ocr', async (request, reply) => {
  const body = asRecord(request.body);
  const resourcePath = text(body.path);
  const language = body.language === 'zh-CN' || body.language === 'ko' || body.language === 'ja' || body.language === 'en' ? body.language as OcrLanguage : 'auto';
  if (!resourcePath) return reply.code(400).send({ error: '缺少资源路径。' });
  const row = await db.prepare(`
    SELECT source_format AS sourceFormat,
      CASE WHEN source_format = 'risum' THEN NULL ELSE source_blob END AS sourceBlob,
      source_storage_path AS sourceStoragePath,
      COALESCE(source_storage_bytes, length(source_blob)) AS sourceBytes
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as { sourceFormat?: string; sourceBlob?: Uint8Array | null; sourceStoragePath?: string | null; sourceBytes?: number } | undefined;
  if (!row) return reply.code(404).send({ error: '项目不存在。' });
  if (!row.sourceFormat || (!row.sourceBlob && !row.sourceBytes)) return reply.code(409).send({ error: '当前项目没有保存原始资源。' });
  try {
    const bytes = await projectResourceBytes(request.params.projectId, row.sourceFormat, row.sourceBlob, row.sourceBytes, resourcePath);
    const mimeType = resourceContentType(resourcePath, bytes);
    if (!mimeType.startsWith('image/')) return reply.code(400).send({ error: '只有图片资源支持 OCR 候选。' });
    const result = await recognizeImage(bytes, resourcePath, language);
    const timestamp = now();
    await db.prepare(`
      INSERT INTO resource_ocr_candidates(id, project_id, resource_path, text, confidence, engine, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
      ON CONFLICT(project_id, resource_path) DO UPDATE SET text = excluded.text, confidence = excluded.confidence,
        engine = excluded.engine, status = 'draft', updated_at = excluded.updated_at
    `).run(id(), request.params.projectId, resourcePath, result.text, result.confidence, result.engine, timestamp, timestamp);
    return {
      path: resourcePath,
      text: result.text,
      confidence: result.confidence,
      engine: result.engine,
      language: result.language,
      status: 'draft',
      updatedAt: timestamp,
    };
  } catch (error) {
    return reply.code(422).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.patch<{ Params: { projectId: string } }>('/api/projects/:projectId/resources/ocr', async (request, reply) => {
  const body = asRecord(request.body);
  const resourcePath = text(body.path);
  const candidateText = typeof body.text === 'string' ? body.text.replace(/\r\n?/gu, '\n').trim() : '';
  const status = body.status === 'confirmed' ? 'confirmed' : 'draft';
  if (!resourcePath) return reply.code(400).send({ error: '缺少资源路径。' });
  if (!candidateText) return reply.code(400).send({ error: 'OCR 候选不能为空。' });
  const existing = await db.prepare(`
    SELECT id, confidence, engine FROM resource_ocr_candidates WHERE project_id = ? AND resource_path = ?
  `).get(request.params.projectId, resourcePath) as { id: string; confidence: number | null; engine: string } | undefined;
  if (!existing) return reply.code(404).send({ error: '请先生成 OCR 候选。' });
  const timestamp = now();
  await db.prepare(`UPDATE resource_ocr_candidates SET text = ?, status = ?, updated_at = ? WHERE project_id = ? AND resource_path = ?`)
    .run(candidateText, status, timestamp, request.params.projectId, resourcePath);
  return { path: resourcePath, text: candidateText, confidence: existing.confidence, engine: existing.engine, status, updatedAt: timestamp };
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
  if (await translationJobs.hasActiveTranslationJob(request.params.projectId)) {
    return reply.code(409).send({ error: '请先结束当前翻译任务再重新判断协议。' });
  }
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
    if (await translationJobs.hasActiveTranslationJob(request.params.projectId)) {
      return reply.code(409).send({ error: '请先结束当前翻译任务再修改协议规则。' });
    }
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
      original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as {
    status?: string;
    sourceLanguage?: string;
    targetLanguage?: string;
    originalJson?: string;
    draftJson?: string | null;
    originalModuleJson?: string | null;
    draftModuleJson?: string | null;
  } | undefined;
  if (!row?.originalJson) return reply.code(404).send({ error: '项目不存在或缺少原始卡片数据。' });
  try {
    const segments = await db.prepare(`
      SELECT path_label AS pathLabel, kind, source_text AS sourceText,
        review_status AS reviewStatus, final_text AS finalText, translated_text AS translatedText
      FROM segments
      WHERE project_id = ? AND (kind LIKE 'lua-%' OR kind = 'runtime-message')
      ORDER BY sort_order, path_label
    `).all(request.params.projectId) as Array<{
      pathLabel: string;
      kind: string;
      sourceText: string;
      reviewStatus: string;
      finalText: string | null;
      translatedText: string | null;
    }>;
    const originalCard = JSON.parse(row.originalJson) as Record<string, unknown>;
    const draftCard = row.draftJson ? JSON.parse(row.draftJson) as Record<string, unknown> : null;
    const originalModule = row.originalModuleJson
      ? JSON.parse(row.originalModuleJson) as Record<string, unknown>
      : null;
    const draftModule = row.draftModuleJson
      ? JSON.parse(row.draftModuleJson) as Record<string, unknown>
      : null;
    return buildLuaManagementReport({
      originalCard,
      draftCard,
      originalModule,
      draftModule,
      storedSegments: segments,
      projectStatus: row.status,
      targetLanguage: row.targetLanguage,
    });
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
  const active = await db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE project_id = ? AND status IN ('queued', 'running', 'paused')")
    .get(request.params.projectId) as { count: number };
  if (Number(active.count) > 0) return reply.code(409).send({ error: '请先结束当前翻译任务，再应用路由修复。' });

  try {
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
    const syntaxIssues = validateRisuLuaChanges(repairedOriginal.draft, repairedDraft.draft);
    if (syntaxIssues.length) return reply.code(409).send({ error: `路由修复后的 Lua 语法校验失败：${syntaxIssues[0].pathLabel} ${syntaxIssues[0].message}` });
    const templateIssues = validateRisuTemplateChanges(repairedOriginal.draft, repairedDraft.draft);
    if (templateIssues.length) return reply.code(409).send({ error: `路由修复破坏了模板结构：${templateIssues[0].pathLabel} ${templateIssues[0].message}` });
    const controlIssues = validateRisuControlReferences(originalCard, draftCard, repairedOriginal.draft, repairedDraft.draft);
    if (controlIssues.length) return reply.code(409).send({ error: `路由修复破坏了控制引用：${controlIssues[0].pathLabel} ${controlIssues[0].message}` });

    await db.prepare(`
      UPDATE projects
      SET original_module_json = ?, draft_module_json = ?, updated_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(repairedOriginal.draft),
      JSON.stringify(repairedDraft.draft),
      now(),
      request.params.projectId,
    );
    return {
      ok: true,
      applied: repairedDraft.applied,
      changes: repairedDraft.changes,
      report: repairedDraft.report,
    };
  } catch (error) {
    return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.delete<{ Params: { projectId: string } }>('/api/projects/:projectId', async (request, reply) => {
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
    SELECT original_json, original_module_json, source_format, source_blob,
      source_storage_path AS sourceStoragePath
    FROM projects WHERE id = ?
  `).get(request.params.projectId) as {
    original_json: string;
    original_module_json: string | null;
    source_format: string;
    source_blob: Uint8Array | null;
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
  const moduleSegments = module
    ? scanRisuModule(module, scope).filter((segment) => !(
        row.source_format === 'charx' && isRisuModuleLorebookMirrorPath(card, segment.path)
      ))
    : [];
  const segments = [
    ...(row.source_format === 'risum'
      ? []
      : scanCard(card, scope, controlLiterals, protocolRules, publicSettings().sourceLanguage)),
    ...moduleSegments,
    ...(row.source_format === 'charx' && sourceBlob
      ? scanCharxResourceJson(sourceBlob, scope === 'all')
      : []),
  ];
  const replacement = await scanService.replaceScannedSegments(request.params.projectId, scope, segments);
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
  if (await translationJobs.hasActiveTranslationJob(request.params.projectId)) {
    return reply.code(409).send({ error: '该项目已有活动任务。' });
  }
  const settings = publicSettings();
  if (!settings.apiKeyConfigured || !settings.model) {
    return reply.code(400).send({ error: '请先在模型设置中配置 API Key 和模型名称。' });
  }

  const segmentRows = await db.prepare(`
    SELECT id FROM segments
    WHERE project_id = ? AND included = 1 AND review_status IN ('untranslated', 'rejected')
    ORDER BY sort_order
  `).all(request.params.projectId) as Array<{ id: string }>;
  if (!segmentRows.length) return reply.code(400).send({ error: '没有待翻译的已选段落。' });

  const jobId = await translationJobs.createTranslationJob(
    request.params.projectId,
    String(project.scope),
    settings.model,
    segmentRows.map((segment) => segment.id),
    false,
  );
  scheduleJob(jobId);
  return reply.code(201).send(await translationJobs.jobById(jobId));
});

app.post<{ Params: { projectId: string } }>('/api/projects/:projectId/retranslate', async (request, reply) => {
  const project = await projectById(request.params.projectId);
  if (!project) return reply.code(404).send({ error: '项目不存在。' });
  if (await translationJobs.hasActiveTranslationJob(request.params.projectId)) {
    return reply.code(409).send({ error: '该项目已有活动任务，请等待完成或先取消任务。' });
  }
  const settings = publicSettings();
  if (!settings.apiKeyConfigured || !settings.model) {
    return reply.code(400).send({ error: '请先在模型设置中配置 API Key 和模型名称。' });
  }
  const body = asRecord(request.body);
  const requestedIds = Array.isArray(body.segmentIds) ? body.segmentIds.map(text).filter(Boolean) : [];
  if (!requestedIds.length) return reply.code(400).send({ error: '请选择需要重新翻译的段落。' });
  const segmentIds = await translationJobs.existingProjectSegmentIds(request.params.projectId, requestedIds);
  if (!segmentIds.length) return reply.code(400).send({ error: '所选段落不属于当前项目。' });

  const jobId = await translationJobs.createTranslationJob(
    request.params.projectId,
    String(project.scope),
    settings.model,
    segmentIds,
    true,
  );
  scheduleJob(jobId);
  return reply.code(201).send(await translationJobs.jobById(jobId));
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
        draft_module_json = original_module_json,
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

app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/pause', async (request, reply) => {
  const result = await db.prepare("UPDATE jobs SET status = 'paused', updated_at = ? WHERE id = ? AND status IN ('queued', 'running')")
    .run(now(), request.params.jobId);
  if (!result.changes) return reply.code(409).send({ error: '任务当前不能暂停。' });
  abortJob(request.params.jobId);
  await db.prepare("UPDATE job_items SET status = 'pending', updated_at = ? WHERE job_id = ? AND status = 'running'")
    .run(now(), request.params.jobId);
  return await translationJobs.jobById(request.params.jobId);
});

app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/resume', async (request, reply) => {
  const result = await db.prepare("UPDATE jobs SET status = 'queued', last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('paused', 'failed')")
    .run(now(), request.params.jobId);
  if (!result.changes) return reply.code(409).send({ error: '任务当前不能继续。' });
  await db.prepare("UPDATE job_items SET status = 'pending', last_error = NULL, updated_at = ? WHERE job_id = ? AND status IN ('running', 'failed')")
    .run(now(), request.params.jobId);
  scheduleJob(request.params.jobId);
  return await translationJobs.jobById(request.params.jobId);
});

app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/retry-failed', async (request, reply) => {
  const job = await translationJobs.jobById(request.params.jobId);
  if (!job) return reply.code(404).send({ error: '任务不存在。' });
  await db.prepare("UPDATE job_items SET status = 'pending', last_error = NULL, updated_at = ? WHERE job_id = ? AND status = 'failed'")
    .run(now(), request.params.jobId);
  await db.prepare("UPDATE jobs SET status = 'queued', failed_items = 0, last_error = NULL, updated_at = ? WHERE id = ?")
    .run(now(), request.params.jobId);
  scheduleJob(request.params.jobId);
  return await translationJobs.jobById(request.params.jobId);
});

app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/cancel', async (request, reply) => {
  abortJob(request.params.jobId);
  const result = await db.prepare("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ?")
    .run(now(), request.params.jobId);
  if (!result.changes) return reply.code(404).send({ error: '任务不存在。' });
  await db.prepare("UPDATE job_items SET status = 'cancelled', updated_at = ? WHERE job_id = ? AND status IN ('pending', 'running')")
    .run(now(), request.params.jobId);
  return await translationJobs.jobById(request.params.jobId);
});

app.patch<{ Params: { segmentId: string } }>('/api/segments/:segmentId', async (request, reply) => {
  const body = asRecord(request.body);
  const current = await db.prepare('SELECT * FROM segments WHERE id = ?').get(request.params.segmentId) as Record<string, unknown> | undefined;
  if (!current) return reply.code(404).send({ error: '段落不存在。' });
  const finalText = typeof body.finalText === 'string'
    ? body.finalText
    : typeof current.final_text === 'string' ? current.final_text : null;
  const reviewStatus = ['untranslated', 'pending', 'approved', 'rejected'].includes(text(body.reviewStatus))
    ? text(body.reviewStatus)
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

app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/export', async (request, reply) => {
  try {
    const output = await exportService.exportProject(request.params.projectId);
    return reply
      .header('Content-Type', output.contentType)
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(output.filename)}`)
      .send(output.body);
  } catch (error) {
    return sendWorkflowError(reply, error);
  }
});

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
      p.id, p.name, ${PROJECT_TITLE_COLUMNS},
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
    WHERE s.project_id = ?
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
    WHERE project_id = ?
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
