import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AsyncDatabase } from '../server/async-db.js';
import { validateUploadedImage } from '../server/domain/resources/image-upload.js';
import { saveImageCandidate } from '../server/application/resources/image-candidate-service.js';

test('manual images use byte signatures and reject empty, SVG and disguised text', () => {
  const png = Buffer.alloc(24);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(validateUploadedImage(png).mimeType, 'image/png');
  assert.equal(validateUploadedImage(Buffer.from([255, 216, 255, 224])).mimeType, 'image/jpeg');
  assert.equal(validateUploadedImage(Buffer.from('RIFF1234WEBP12345678!')).mimeType, 'image/webp');
  assert.equal(validateUploadedImage(Buffer.from('GIF89a1234567')).mimeType, 'image/gif');
  for (const bytes of [Buffer.alloc(0), Buffer.from('<svg onload="alert(1)"/>'), Buffer.from('fake.png'), png.subarray(0, 8)]) {
    assert.throws(() => validateUploadedImage(bytes), /有效/);
  }
});

test('replacement resets approval and a failed write preserves the previous image', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-image-upload-'));
  const database = new AsyncDatabase(path.join(directory, 'test.sqlite'));
  try {
    await database.exec(`CREATE TABLE resource_image_candidates (
      id TEXT PRIMARY KEY, project_id TEXT, resource_path TEXT, mime_type TEXT, image_blob BLOB,
      storage_path TEXT, storage_bytes INTEGER, storage_sha256 TEXT, prompt TEXT, model TEXT,
      status TEXT, created_at TEXT, updated_at TEXT, UNIQUE(project_id, resource_path));`);
    const files = new Map<string, Uint8Array>();
    let sequence = 0;
    const deps = {
      database, id: () => `candidate-${++sequence}`, now: () => '2026-09-13T00:00:00Z',
      storeFile: async (key: string, bytes: Uint8Array) => {
        files.set(key, bytes);
        return { path: key, bytes: bytes.length, sha256: 'test' };
      },
      removeStoredFile: async (key: string) => { files.delete(key); },
    };
    const input = { projectId: 'project', resourcePath: 'assets/icon.png', bytes: Buffer.from('first'), mimeType: 'image/png', model: 'manual-upload', prompt: '手动上传替换图片' };
    await saveImageCandidate(deps, input);
    await database.exec("UPDATE resource_image_candidates SET status = 'confirmed'");
    const saved = await saveImageCandidate(deps, { ...input, bytes: Buffer.from('second') });
    assert.equal(saved.status, 'draft');
    const row = await database.prepare('SELECT * FROM resource_image_candidates').get() as { status: string; storage_path: string; resource_path: string };
    assert.equal(row.status, 'draft');
    assert.equal(row.resource_path, input.resourcePath);
    assert.equal(Buffer.from(files.get(row.storage_path)!).toString(), 'second');
    await database.exec("CREATE TRIGGER fail_update BEFORE UPDATE ON resource_image_candidates BEGIN SELECT RAISE(ABORT, 'write failed'); END;");
    const before = files.size;
    await assert.rejects(saveImageCandidate(deps, { ...input, bytes: Buffer.from('third') }), /write failed/);
    assert.equal(files.size, before);
    assert.equal(Buffer.from(files.get(row.storage_path)!).toString(), 'second');
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
