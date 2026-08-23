import { createHash } from 'node:crypto';
import type { AsyncDatabase } from './async-db.js';
import { fileExtension, imageExtension, projectStoragePath, readStoredFile, storeFile, storedFileExists } from './storage.js';

interface LegacyProjectRow {
  id: string;
  sourceFormat: string;
  sourceFilename: string | null;
  sourceStoragePath: string | null;
  draftStoragePath: string | null;
}

interface LegacyImageRow {
  id: string;
  projectId: string;
  resourcePath: string;
  mimeType: string;
  storagePath: string | null;
}

export async function migrateLegacyStorage(database: AsyncDatabase): Promise<{ projects: number; images: number }> {
  let projects = 0;
  let images = 0;
  const projectRows = await database.prepare<LegacyProjectRow>(`
    SELECT id, source_format AS sourceFormat, source_filename AS sourceFilename,
      source_storage_path AS sourceStoragePath, draft_storage_path AS draftStoragePath
    FROM projects
    WHERE source_blob IS NOT NULL OR draft_source_blob IS NOT NULL
      OR (source_storage_path IS NOT NULL AND source_storage_bytes IS NULL)
  `).all();
  for (const project of projectRows) {
    const blobs = await database.prepare<{ sourceBlob: Uint8Array | null; draftSourceBlob: Uint8Array | null }>(`
      SELECT source_blob AS sourceBlob, draft_source_blob AS draftSourceBlob FROM projects WHERE id = ?
    `).get(project.id);
    const sourceBlob = blobs?.sourceBlob || null;
    const draftSourceBlob = blobs?.draftSourceBlob || null;
    const source = sourceBlob
      ? await storeFile(project.sourceStoragePath || projectStoragePath(project.id, 'source', fileExtension(project.sourceFilename, project.sourceFormat)), sourceBlob)
      : project.sourceStoragePath && await storedFileExists(project.sourceStoragePath)
        ? await storedFileMeta(project.sourceStoragePath)
        : null;
    const draft = draftSourceBlob
      ? await storeFile(project.draftStoragePath || projectStoragePath(project.id, 'draft', fileExtension(project.sourceFilename, project.sourceFormat)), draftSourceBlob)
      : project.draftStoragePath && await storedFileExists(project.draftStoragePath)
        ? await storedFileMeta(project.draftStoragePath)
        : null;
    await database.prepare(`
      UPDATE projects
      SET source_blob = NULL, draft_source_blob = NULL,
        source_storage_path = COALESCE(?, source_storage_path),
        source_storage_bytes = COALESCE(?, source_storage_bytes),
        source_storage_sha256 = COALESCE(?, source_storage_sha256),
        draft_storage_path = COALESCE(?, draft_storage_path),
        draft_storage_bytes = COALESCE(?, draft_storage_bytes),
        draft_storage_sha256 = COALESCE(?, draft_storage_sha256)
      WHERE id = ?
    `).run(
      source?.path || null, source?.bytes || null, source?.sha256 || null,
      draft?.path || null, draft?.bytes || null, draft?.sha256 || null, project.id,
    );
    projects += 1;
  }

  const imageRows = await database.prepare<LegacyImageRow>(`
    SELECT id, project_id AS projectId, resource_path AS resourcePath, mime_type AS mimeType,
      storage_path AS storagePath
    FROM resource_image_candidates
    WHERE length(image_blob) > 0 OR (storage_path IS NOT NULL AND storage_bytes IS NULL)
  `).all();
  for (const image of imageRows) {
    const blob = await database.prepare<{ imageBlob: Uint8Array | null }>(
      'SELECT image_blob AS imageBlob FROM resource_image_candidates WHERE id = ?',
    ).get(image.id);
    const stored = blob?.imageBlob && blob.imageBlob.byteLength > 0
      ? await storeFile(
        image.storagePath || projectStoragePath(image.projectId, 'image', imageExtension(image.mimeType), image.resourcePath),
        blob.imageBlob,
      )
      : image.storagePath && await storedFileExists(image.storagePath)
        ? await storedFileMeta(image.storagePath)
        : null;
    await database.prepare(`
      UPDATE resource_image_candidates
      SET image_blob = zeroblob(0),
        storage_path = COALESCE(?, storage_path), storage_bytes = COALESCE(?, storage_bytes),
        storage_sha256 = COALESCE(?, storage_sha256)
      WHERE id = ?
    `).run(stored?.path || null, stored?.bytes || null, stored?.sha256 || null, image.id);
    images += 1;
  }
  return { projects, images };
}

async function storedFileMeta(relativePath: string): Promise<{ path: string; bytes: number; sha256: string }> {
  const bytes = await readStoredFile(relativePath);
  return { path: relativePath, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') };
}
