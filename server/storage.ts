import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workbenchConfig } from './config.js';

export interface StoredFile {
  path: string;
  bytes: number;
  sha256: string;
}

const storageRoot = workbenchConfig.paths.storage;

export function storageFilePath(relativePath: string): string {
  const normalized = path.normalize(relativePath);
  if (!normalized || normalized === '.' || path.isAbsolute(normalized) || normalized.startsWith(`..${path.sep}`) || normalized === '..') {
    throw new Error('存储文件路径无效。');
  }
  return path.join(storageRoot, normalized);
}

export function projectStoragePath(projectId: string, kind: 'source' | 'draft' | 'image', extension: string, resourceKey = ''): string {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/gu, '_');
  const safeExtension = extension.replace(/[^a-zA-Z0-9]/gu, '').toLowerCase() || 'bin';
  if (kind === 'image') {
    const key = createHash('sha256').update(resourceKey).digest('hex').slice(0, 24);
    return path.join('projects', safeProjectId, 'resources', `${key}.${safeExtension}`);
  }
  return path.join('projects', safeProjectId, `${kind}.${safeExtension}`);
}

export async function storeFile(relativePath: string, bytes: Uint8Array): Promise<StoredFile> {
  const destination = storageFilePath(relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const digest = createHash('sha256').update(bytes).digest('hex');
  try {
    await writeFile(temporary, bytes);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return { path: relativePath, bytes: bytes.byteLength, sha256: digest };
}

export async function readStoredFile(relativePath: string): Promise<Buffer> {
  return await readFile(storageFilePath(relativePath));
}

export async function readStoredFileRange(relativePath: string, offset: number, byteLength: number): Promise<Buffer> {
  const handle = await open(storageFilePath(relativePath), 'r');
  try {
    const output = Buffer.allocUnsafe(byteLength);
    const result = await handle.read(output, 0, byteLength, offset);
    return result.bytesRead === byteLength ? output : output.subarray(0, result.bytesRead);
  } finally {
    await handle.close();
  }
}

export async function storedFileExists(relativePath: string | null | undefined): Promise<boolean> {
  if (!relativePath) return false;
  try {
    await stat(storageFilePath(relativePath));
    return true;
  } catch {
    return false;
  }
}

export async function removeStoredFile(relativePath: string | null | undefined): Promise<void> {
  if (!relativePath) return;
  await rm(storageFilePath(relativePath), { force: true });
}

export async function removeProjectStorage(projectId: string): Promise<void> {
  const safeProjectId = projectId.replace(/[^a-zA-Z0-9_-]/gu, '_');
  await rm(storageFilePath(path.join('projects', safeProjectId)), { recursive: true, force: true });
}

export function fileExtension(filename: string | null | undefined, fallback: string): string {
  const extension = filename ? path.extname(filename).replace(/^\./u, '') : '';
  return extension || fallback;
}

export function imageExtension(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  if (normalized.includes('jpeg')) return 'jpg';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('svg')) return 'svg';
  return 'png';
}

export { storageRoot };
