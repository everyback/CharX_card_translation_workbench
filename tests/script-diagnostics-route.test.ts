import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('script diagnostics preserve project scope and reviewed text; nearby lines remain editable', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-script-diagnostics-'));
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  process.chdir(directory);
  process.env.WORKBENCH_EMBEDDED = '1';
  process.env.WORKBENCH_DATA_DIR = directory;
  process.env.WORKBENCH_DB_PATH = path.join(directory, 'test.sqlite');
  // Select a free temporary port, never the user's development listener.
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const { startWorkbenchServer, stopWorkbenchServer } = await import('../server/routes/api.js');
  const { db } = await import('../server/db.js');
  try {
    const { address } = await startWorkbenchServer({ host: '127.0.0.1', port });
    const request = async (url: string, method = 'GET', body?: unknown) => fetch(address + url, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const created = await request('/api/projects', 'POST', { card: { name: 'Fixture', description: 'Hello', character_book: { entries: [{ content: 'World', keys: ['world'] }] } } });
    assert.equal(created.status, 201);
    const project = await created.json() as { id: string };
    assert.equal((await request(`/api/projects/${project.id}/scan`, 'POST', { scope: 'all' })).status, 200);
    await db.prepare("UPDATE segments SET translated_text = '人工译文', final_text = '人工译文', review_status = 'approved' WHERE project_id = ?").run(project.id);
    const wrap = (code: string) => ({ trigger: [{ effect: [{ code }] }] });
    await db.prepare('UPDATE projects SET original_module_json = ?, draft_module_json = ? WHERE id = ?')
      .run(JSON.stringify(wrap('local message = "hello"\nlocal count = 1\nreturn message')), JSON.stringify(wrap('local message = "hello"\nlocal count = 1\nreturn message(')), project.id);
    const before = await db.prepare('SELECT * FROM segments WHERE project_id = ? ORDER BY id').all(project.id);
    const reportResponse = await request(`/api/projects/${project.id}/lua/diagnostics`);
    assert.equal(reportResponse.status, 200);
    const report = await reportResponse.json() as { syntaxStatus: string; issues: Array<{ kind: string; pathJson: string }> };
    assert.equal(report.syntaxStatus, 'failed');
    const issue = report.issues.find(item => item.kind === 'syntax')!;
    const nearby = await request(`/api/projects/${project.id}/lua/syntax-line`, 'PATCH', { pathJson: issue.pathJson, line: 2, expectedLine: 'local count = 1', replacement: 'local count = 2' });
    assert.equal(nearby.status, 200);
    assert.equal((await nearby.json() as { syntaxOk: boolean }).syntaxOk, false);
    const stale = await request(`/api/projects/${project.id}/lua/syntax-line`, 'PATCH', { pathJson: issue.pathJson, line: 2, expectedLine: 'local count = 1', replacement: 'local count = 3' });
    assert.equal(stale.status, 409);
    const protectedPath = await request(`/api/projects/${project.id}/lua/syntax-line`, 'PATCH', { pathJson: '["$module","namespace"]', line: 1, replacement: 'changed' });
    assert.equal(protectedPath.status, 400);
    const fixed = await request(`/api/projects/${project.id}/lua/syntax-line`, 'PATCH', { pathJson: issue.pathJson, line: 3, expectedLine: 'return message(', replacement: 'return message' });
    assert.equal(fixed.status, 200);
    const after = await (await request(`/api/projects/${project.id}/lua/diagnostics`)).json() as { syntaxStatus: string; scriptChanges: Array<{ after: string }> };
    assert.equal(after.syntaxStatus, 'passed');
    assert.ok(after.scriptChanges.some(change => change.after.includes('local count = 2')));
    assert.deepEqual(await db.prepare('SELECT * FROM segments WHERE project_id = ? ORDER BY id').all(project.id), before);
    assert.equal((await db.prepare('SELECT scope FROM projects WHERE id = ?').get(project.id) as { scope: string }).scope, 'all');
    await db.prepare("INSERT INTO jobs (id, project_id, status, scope, model, created_at, updated_at) VALUES ('paused', ?, 'paused', 'all', 'fixture', 'now', 'now')").run(project.id);
    assert.equal((await request(`/api/projects/${project.id}/protocols/any`, 'PATCH', { status: 'approved', fields: [] })).status, 409);
  } finally {
    await stopWorkbenchServer();
    process.chdir(previousCwd);
    for (const key of ['WORKBENCH_EMBEDDED', 'WORKBENCH_DATA_DIR', 'WORKBENCH_DB_PATH']) {
      if (previousEnv[key] === undefined) delete process.env[key]; else process.env[key] = previousEnv[key];
    }
    await rm(directory, { recursive: true, force: true });
  }
});
