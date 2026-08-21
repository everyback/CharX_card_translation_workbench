import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { workbenchConfig } from '../config.js';
import { id } from '../db.js';
import type { CreateProjectInput } from '../application/project-service.js';
import { inspectCharx, packCharxEntries, readCharxEntry } from '../domain/charx.js';
import { parseCardPng } from '../domain/png.js';
import { inspectTavernCard } from '../domain/tavern-card.js';
import { isUploadTooLargeError, uploadTooLargeMessage } from '../upload-limit.js';

interface SessionToolDependencies {
  createProject(options: CreateProjectInput): Promise<string>;
  projectById(projectId: string): Promise<Record<string, unknown> | undefined>;
  cardName(card: Record<string, unknown>): string;
}

interface TavernCardSession {
  filename: string;
  path: string;
  sourceFormat: 'png' | 'json';
  metadataKeys: string[];
  createdAt: number;
}

const unpackSessions = new Map<string, { filename: string; path: string; createdAt: number }>();
const tavernCardSessions = new Map<string, TavernCardSession>();
const SESSION_TTL_MS = 30 * 60 * 1000;

mkdirSync(workbenchConfig.paths.unpackSessions, { recursive: true });
mkdirSync(workbenchConfig.paths.tavernCardSessions, { recursive: true });

export function registerSessionToolRoutes(
  app: FastifyInstance,
  uploadLimitMib: number | null,
  dependencies: SessionToolDependencies,
): void {
  app.post('/api/tavern-card/inspect', async (request, reply) => {
    cleanupTavernCardSessions();
    let part: multipart.MultipartFile | undefined;
    let buffer: Buffer;
    try {
      part = await request.file();
      if (!part) return reply.code(400).send({ error: '请选择酒馆卡 PNG 或 JSON 文件。' });
      buffer = await part.toBuffer();
    } catch (error) {
      if (isUploadTooLargeError(error)) return reply.code(413).send({ error: uploadTooLargeMessage(uploadLimitMib) });
      throw error;
    }

    const extension = path.extname(part.filename).toLowerCase();
    if (extension !== '.png' && extension !== '.json') {
      return reply.code(415).send({ error: '酒馆卡解析当前支持 PNG 和 JSON 文件。' });
    }
    try {
      const sourceFormat = extension.slice(1) as 'png' | 'json';
      const parsed = sourceFormat === 'png'
        ? parseCardPng(buffer)
        : { card: parseTavernCardJson(buffer), metadataKeys: [] as string[] };
      const inspection = inspectTavernCard(parsed.card, parsed.metadataKeys);
      const sessionId = id();
      const sessionPath = path.join(workbenchConfig.paths.tavernCardSessions, `${sessionId}.${sourceFormat}`);
      writeFileSync(sessionPath, buffer);
      tavernCardSessions.set(sessionId, {
        filename: part.filename,
        path: sessionPath,
        sourceFormat,
        metadataKeys: parsed.metadataKeys,
        createdAt: Date.now(),
      });
      return reply.code(201).send({
        sessionId,
        filename: part.filename,
        sourceFormat,
        fileBytes: buffer.byteLength,
        previewAvailable: sourceFormat === 'png',
        ...inspection,
      });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { sessionId: string } }>('/api/tavern-card/:sessionId/image', async (request, reply) => {
    const session = tavernCardSession(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: '酒馆卡解析会话已过期，请重新选择文件。' });
    if (session.sourceFormat !== 'png') return reply.code(404).send({ error: '当前酒馆卡没有 PNG 封面。' });
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'private, max-age=1800').send(readFileSync(session.path));
  });

  app.get<{ Params: { sessionId: string } }>('/api/tavern-card/:sessionId/json', async (request, reply) => {
    const session = tavernCardSession(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: '酒馆卡解析会话已过期，请重新选择文件。' });
    try {
      const card = readTavernCardSession(session).card;
      const basename = sanitizeFilename(path.basename(session.filename, path.extname(session.filename)));
      return reply
        .header('Content-Type', 'application/json; charset=utf-8')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${basename}.card.json`)}`)
        .send(JSON.stringify(card, null, 2));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post<{ Params: { sessionId: string } }>('/api/tavern-card/:sessionId/import', async (request, reply) => {
    const session = tavernCardSession(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: '酒馆卡解析会话已过期，请重新选择文件。' });
    try {
      const source = readFileSync(session.path);
      const parsed = readTavernCardSession(session, source);
      const projectId = await dependencies.createProject({
        name: dependencies.cardName(parsed.card),
        sourceFormat: session.sourceFormat,
        card: parsed.card,
        filename: session.filename,
        blob: session.sourceFormat === 'png' ? source : undefined,
        metadataKeys: parsed.metadataKeys,
      });
      return reply.code(201).send(await dependencies.projectById(projectId));
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete<{ Params: { sessionId: string } }>('/api/tavern-card/:sessionId', async (request, reply) => {
    const session = tavernCardSessions.get(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: '酒馆卡解析会话不存在或已经清理。' });
    rmSync(session.path, { force: true });
    tavernCardSessions.delete(request.params.sessionId);
    return { ok: true };
  });

  app.post('/api/unpack/inspect', async (request, reply) => {
    cleanupUnpackSessions();
    let part: multipart.MultipartFile | undefined;
    let buffer: Buffer;
    try {
      part = await request.file();
      if (!part) return reply.code(400).send({ error: '请选择 CHARX 文件。' });
      buffer = await part.toBuffer();
    } catch (error) {
      if (isUploadTooLargeError(error)) return reply.code(413).send({ error: uploadTooLargeMessage(uploadLimitMib) });
      throw error;
    }
    if (path.extname(part.filename).toLowerCase() !== '.charx') {
      return reply.code(415).send({ error: '独立解包当前只支持 CHARX 文件。' });
    }
    try {
      const inspection = inspectCharx(buffer);
      const sessionId = id();
      const sessionPath = path.join(workbenchConfig.paths.unpackSessions, `${sessionId}.charx`);
      writeFileSync(sessionPath, buffer);
      unpackSessions.set(sessionId, { filename: part.filename, path: sessionPath, createdAt: Date.now() });
      return reply.code(201).send({ sessionId, filename: part.filename, ...inspection });
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { sessionId: string } }>('/api/unpack/:sessionId/archive', async (request, reply) => {
    const session = unpackSession(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: '解包会话已过期，请重新选择文件。' });
    try {
      const output = packCharxEntries(readFileSync(session.path));
      const basename = sanitizeFilename(path.basename(session.filename, path.extname(session.filename)));
      return reply
        .header('Content-Type', 'application/zip')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${basename}.unpacked.zip`)}`)
        .send(output);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { sessionId: string }; Querystring: { path?: string } }>('/api/unpack/:sessionId/file', async (request, reply) => {
    const session = unpackSession(request.params.sessionId);
    if (!session) return reply.code(404).send({ error: '解包会话已过期，请重新选择文件。' });
    const entryPath = text(request.query.path);
    if (!entryPath) return reply.code(400).send({ error: '缺少包内文件路径。' });
    try {
      const output = readCharxEntry(readFileSync(session.path), entryPath);
      return reply
        .header('Content-Type', contentTypeForEntry(entryPath))
        .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(entryPath))}`)
        .send(output);
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function unpackSession(sessionId: string): { filename: string; path: string; createdAt: number } | null {
  cleanupUnpackSessions();
  const session = unpackSessions.get(sessionId);
  return session && existsSync(session.path) ? session : null;
}

function cleanupUnpackSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, session] of unpackSessions) {
    if (session.createdAt >= cutoff && existsSync(session.path)) continue;
    rmSync(session.path, { force: true });
    unpackSessions.delete(sessionId);
  }
}

function tavernCardSession(sessionId: string): TavernCardSession | null {
  cleanupTavernCardSessions();
  const session = tavernCardSessions.get(sessionId);
  return session && existsSync(session.path) ? session : null;
}

function cleanupTavernCardSessions(): void {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [sessionId, session] of tavernCardSessions) {
    if (session.createdAt >= cutoff && existsSync(session.path)) continue;
    rmSync(session.path, { force: true });
    tavernCardSessions.delete(sessionId);
  }
}

function readTavernCardSession(
  session: TavernCardSession,
  source = readFileSync(session.path),
): { card: Record<string, unknown>; metadataKeys: string[] } {
  return session.sourceFormat === 'png'
    ? parseCardPng(source)
    : { card: parseTavernCardJson(source), metadataKeys: session.metadataKeys };
}

function parseTavernCardJson(source: Uint8Array): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(source).toString('utf8').replace(/^\uFEFF/u, '')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('酒馆卡 JSON 必须是对象。');
  return parsed as Record<string, unknown>;
}

function contentTypeForEntry(entryPath: string): string {
  const extension = path.extname(entryPath).toLowerCase();
  return ({
    '.json': 'application/json; charset=utf-8',
    '.risum': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.lua': 'text/plain; charset=utf-8',
  } as Record<string, string>)[extension] || 'application/octet-stream';
}

function sanitizeFilename(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'translated-card';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
