import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

test('explicit list and dashboard refresh sees imports and deletions within the cache window', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-system-refresh-'));
  const previousCwd = process.cwd();
  const previousData = process.env.WORKBENCH_DATA_DIR;
  const previousDatabase = process.env.WORKBENCH_DB_PATH;
  // Import runtime dependencies only after selecting a disposable configuration.
  process.chdir(directory);
  process.env.WORKBENCH_DATA_DIR = directory;
  process.env.WORKBENCH_DB_PATH = path.join(directory, 'test.sqlite');
  const { db } = await import('../server/db.js');
  const { registerSystemRoutes } = await import('../server/routes/system.js');
  const app = Fastify();
  try {
    registerSystemRoutes(app);
    assert.deepEqual((await app.inject('/api/projects')).json(), []);
    assert.equal((await app.inject('/api/dashboard')).json().projects, 0);

    await db.prepare(`INSERT INTO projects
      (id, name, original_hash, original_json, draft_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run('demo', 'Demo', 'fixture', '{}', '{}', '2026-01-01', '2026-01-01');
    assert.deepEqual((await app.inject('/api/projects')).json(), []);
    assert.equal((await app.inject('/api/projects?fresh=1')).json()[0].id, 'demo');
    assert.equal((await app.inject('/api/dashboard?fresh=1')).json().projects, 1);

    await db.prepare('DELETE FROM projects WHERE id = ?').run('demo');
    assert.equal((await app.inject('/api/projects')).json().length, 1);
    assert.deepEqual((await app.inject('/api/projects?fresh=1')).json(), []);
    assert.equal((await app.inject('/api/dashboard?fresh=1')).json().projects, 0);
  } finally {
    await app.close();
    await db.close();
    process.chdir(previousCwd);
    if (previousData === undefined) delete process.env.WORKBENCH_DATA_DIR;
    else process.env.WORKBENCH_DATA_DIR = previousData;
    if (previousDatabase === undefined) delete process.env.WORKBENCH_DB_PATH;
    else process.env.WORKBENCH_DB_PATH = previousDatabase;
    assert.ok(directory.startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(directory, { recursive: true, force: true });
  }
});
