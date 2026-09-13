import type { AsyncDatabase } from '../../async-db.js';
import { projectStoragePath, imageExtension, type StoredFile } from '../../repositories/file-storage.js';

interface Dependencies {
  database: AsyncDatabase;
  id: () => string;
  now: () => string;
  storeFile: (path: string, bytes: Uint8Array) => Promise<StoredFile>;
  removeStoredFile: (path: string) => Promise<void>;
}

export async function saveImageCandidate(deps: Dependencies, input: {
  projectId: string; resourcePath: string; bytes: Buffer; mimeType: string; model: string; prompt: string;
}) {
  const candidateId = deps.id();
  const timestamp = deps.now();
  // A fresh file prevents a failed database write from changing an approved candidate.
  const stored = await deps.storeFile(projectStoragePath(input.projectId, 'image', imageExtension(input.mimeType), `${input.resourcePath}:${candidateId}`), input.bytes);
  try {
    await deps.database.prepare(`
      INSERT INTO resource_image_candidates(
        id, project_id, resource_path, mime_type, image_blob, storage_path, storage_bytes, storage_sha256,
        prompt, model, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, zeroblob(0), ?, ?, ?, ?, ?, 'draft', ?, ?)
      ON CONFLICT(project_id, resource_path) DO UPDATE SET mime_type = excluded.mime_type, image_blob = zeroblob(0),
        storage_path = excluded.storage_path, storage_bytes = excluded.storage_bytes, storage_sha256 = excluded.storage_sha256,
        prompt = excluded.prompt, model = excluded.model, status = 'draft', updated_at = excluded.updated_at
    `).run(candidateId, input.projectId, input.resourcePath, input.mimeType, stored.path, stored.bytes, stored.sha256, input.prompt, input.model, timestamp, timestamp);
  } catch (error) {
    await deps.removeStoredFile(stored.path).catch(() => undefined);
    throw error;
  }
  return { path: input.resourcePath, mimeType: input.mimeType, model: input.model, prompt: input.prompt, status: 'draft' as const, updatedAt: timestamp };
}
