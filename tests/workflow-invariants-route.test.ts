import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { setTimeout as delay } from 'node:timers/promises';

test('workflow invariants through isolated HTTP and mock-model requests', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-invariants-'));
  const previousCwd = process.cwd();
  const savedEnv = { ...process.env };
  process.chdir(directory);
  process.env.WORKBENCH_EMBEDDED = '1';
  process.env.WORKBENCH_DATA_DIR = directory;
  process.env.WORKBENCH_DB_PATH = path.join(directory, 'fixture.sqlite');
  const prompts: string[] = [];
  let notifyFirst!: () => void, releaseFirst!: () => void;
  const firstRequest = new Promise<void>(resolve => { notifyFirst = resolve; });
  const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
  const mock = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    prompts.push(input.messages[0].content);
    if (prompts.length === 1) { notifyFirst(); await firstResponse; }
    const content = input.messages[1].content.replace(/<<<ID:(S\d+)>>>[\s\S]*?<<<END>>>/g,
      (_match: string, id: string) => `<<<ID:${id}>>>\n你好世界\n<<<END>>>`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
  const mockPort = (mock.address() as { port: number }).port;
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const { startWorkbenchServer, stopWorkbenchServer } = await import('../server/routes/api.js');
  const { db } = await import('../server/db.js');
  try {
    const { address } = await startWorkbenchServer({ host: '127.0.0.1', port });
    const request = (url: string, method = 'GET', body?: unknown) => fetch(address + url, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = async (url: string, method = 'GET', body?: unknown) => {
      const response = await request(url, method, body);
      const result = await response.json() as any;
      assert.ok(response.ok, `${url}: ${response.status} ${JSON.stringify(result)}`);
      return result;
    };
    const create = async (card: Record<string, unknown>) => (await json('/api/projects', 'POST', { card })).id as string;
    await json('/api/settings', 'PUT', { apiBaseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: 'fixture-only', model: 'local-fixture',
      sourceLanguage: 'en', fallbackLanguage: 'en', targetLanguage: 'zh-CN', concurrency: 1, batchItems: 1, streamingEnabled: false });

    await t.test('scope changes preserve reviewed worldbook records and enforce the scanned range', async () => {
      const id = await create({ name: 'Fixture', description: 'Hello', character_book: { entries: [{ keys: ['world'], content: 'World story' }] } });
      await json(`/api/projects/${id}/scan`, 'POST', { scope: 'all' });
      const lore = await db.prepare("SELECT id FROM segments WHERE project_id = ? AND category='lorebook' AND kind='field'").get(id) as { id: string };
      await db.prepare("UPDATE segments SET translated_text='世界故事', final_text='世界定稿', review_status='approved', included=0 WHERE id=?").run(lore.id);
      await json(`/api/projects/${id}/scan`, 'POST', { scope: 'core' });
      assert.deepEqual(await db.prepare('SELECT final_text, review_status, included, in_scope FROM segments WHERE id=?').get(lore.id),
        { final_text: '世界定稿', review_status: 'approved', included: 0, in_scope: 0 });
      const mismatch = await request(`/api/projects/${id}/jobs`, 'POST', { scope: 'all' });
      assert.equal(mismatch.status, 409);
      assert.equal((await mismatch.json() as { code: string }).code, 'SCAN_SCOPE_CHANGED');
      const draft = await json(`/api/projects/${id}/export`);
      assert.equal(draft.character_book.entries[0].content, '世界定稿');
      const before = await db.prepare('SELECT * FROM segments WHERE project_id=? ORDER BY id').all(id);
      await db.exec(`CREATE TRIGGER fail_scan BEFORE UPDATE OF in_scope ON segments BEGIN SELECT RAISE(ABORT, 'fixture scan failure'); END;`);
      assert.equal((await request(`/api/projects/${id}/scan`, 'POST', { scope: 'all' })).status, 500);
      assert.deepEqual(await db.prepare('SELECT * FROM segments WHERE project_id=? ORDER BY id').all(id), before);
      await db.exec('DROP TRIGGER fail_scan');
      await json(`/api/projects/${id}/scan`, 'POST', { scope: 'all' });
      assert.equal((await db.prepare('SELECT in_scope FROM segments WHERE id=?').get(lore.id))?.in_scope, 1);
    });

    await t.test('adopted protocols split RISUM lorebook slots and protect delimiters on export', async () => {
      const id = await create({ name: 'Protocol fixture' });
      const module = { name: 'Fixture', lorebook: [{ content: '<news|Visible title|Clear|1|Visible detail>' }] };
      await db.prepare("UPDATE projects SET source_format='risum', original_module_json=?, draft_module_json=? WHERE id=?")
        .run(JSON.stringify(module), JSON.stringify(module), id);
      await json(`/api/projects/${id}/scan`, 'POST', { scope: 'all' });
      const protocols = await json(`/api/projects/${id}/protocols`);
      const schema = (Array.isArray(protocols) ? protocols : protocols.protocols)[0];
      assert.ok(schema);
      await json(`/api/projects/${id}/protocols/${schema.id}`, 'PATCH', { status: 'approved',
        fields: schema.fieldRules.map((field: any) => ({ ...field, policy: field.index === 3 ? 'protect' : 'translate' })) });
      await json(`/api/projects/${id}/scan`, 'POST', { scope: 'all' });
      const slots = await db.prepare("SELECT id, source_text FROM segments WHERE project_id=? AND kind='protocol-field' ORDER BY start_pos").all(id);
      assert.deepEqual(slots.map(s => s.source_text), ['Visible title', 'Clear', 'Visible detail']);
      await db.prepare("UPDATE segments SET final_text='标题|破坏结构', review_status='approved' WHERE id=?").run(slots[0].id);
      assert.equal((await request(`/api/projects/${id}/apply`, 'POST', {})).status, 409);
      assert.deepEqual(JSON.parse(String((await db.prepare('SELECT draft_module_json FROM projects WHERE id=?').get(id))?.draft_module_json)), module);
    });

    await t.test('resource withdrawal rebuilds the archive from original bytes, including when every approval is withdrawn', async () => {
      const source = zipSync({ 'card.json': strToU8(JSON.stringify({ spec: 'chara_card_v3', data: { name: 'Fixture' } })),
        'assets/ui.json': strToU8(JSON.stringify({ id: 'start_button', label: 'Start', description: 'New adventure' })) });
      const form = new FormData(); form.append('file', new Blob([source]), 'fixture.charx');
      const imported = await fetch(address + '/api/projects/import', { method: 'POST', body: form });
      assert.equal(imported.status, 201); const { id } = await imported.json() as { id: string };
      await json(`/api/projects/${id}/scan`, 'POST', { scope: 'all' });
      await db.prepare("UPDATE segments SET final_text=CASE WHEN source_text='Start' THEN '开始' ELSE '新的冒险' END, review_status='approved' WHERE project_id=? AND kind='resource-json'").run(id);
      const resource = async () => {
        const response = await request(`/api/projects/${id}/export`); assert.equal(response.status, 200);
        return JSON.parse(strFromU8(unzipSync(new Uint8Array(await response.arrayBuffer()))['assets/ui.json']));
      };
      assert.equal((await resource()).label, '开始');
      const saved = await db.prepare('SELECT draft_storage_path, draft_storage_sha256 FROM projects WHERE id=?').get(id);
      await db.prepare("UPDATE segments SET review_status='rejected' WHERE project_id=? AND source_text='Start'").run(id);
      await db.exec(`CREATE TRIGGER fail_apply BEFORE UPDATE OF draft_json ON projects BEGIN SELECT RAISE(ABORT, 'fixture apply failure'); END;`);
      assert.equal((await request(`/api/projects/${id}/apply`, 'POST', {})).status, 500);
      assert.deepEqual(await db.prepare('SELECT draft_storage_path, draft_storage_sha256 FROM projects WHERE id=?').get(id), saved);
      const { readStoredFile } = await import('../server/repositories/file-storage.js');
      assert.equal(JSON.parse(strFromU8(unzipSync(await readStoredFile(String(saved?.draft_storage_path)))['assets/ui.json'])).label, '开始');
      await db.exec('DROP TRIGGER fail_apply');
      assert.deepEqual(await resource(), { id: 'start_button', label: 'Start', description: '新的冒险' });
      await db.prepare("UPDATE segments SET review_status='rejected' WHERE project_id=?").run(id);
      assert.deepEqual(await resource(), { id: 'start_button', label: 'Start', description: 'New adventure' });
    });

    await t.test('global language edits cannot change subsequent batches and persisted task language', async () => {
      const id = await create({ name: 'Language fixture', description: 'Hello world', personality: 'Friendly person' });
      await json(`/api/projects/${id}/scan`, 'POST', { scope: 'core' });
      const job = await json(`/api/projects/${id}/jobs`, 'POST', { scope: 'core' });
      await Promise.race([firstRequest, delay(5000).then(() => { throw new Error('Mock model was not called'); })]);
      await json('/api/settings', 'PUT', { targetLanguage: 'ja', sourceLanguage: 'ko', fallbackLanguage: 'fr' });
      assert.equal((await request(`/api/projects/${id}/language-rule`, 'PATCH', { mode: 'preserve' })).status, 409);
      releaseFirst();
      let status = '';
      for (let i = 0; i < 100; i++) {
        status = (await json(`/api/jobs/${job.id}`)).status;
        if (!['queued', 'running'].includes(status)) break;
        await delay(50);
      }
      assert.equal(status, 'review');
      assert.ok(prompts.length >= 2);
      assert.ok(prompts.every(p => p.includes('目标语言：zh-CN') && p.includes('源语言：en') && p.includes('备用语言：en')));
      const stored = await db.prepare('SELECT language_config FROM jobs WHERE id=?').get(job.id);
      assert.deepEqual(JSON.parse(String(stored?.language_config)), { sourceLanguage: 'en', targetLanguage: 'zh-CN', fallbackLanguage: 'en', languageBehaviorMode: 'target' });
      const { loadJobLanguage } = await import('../server/application/translation/job-language.js');
      assert.deepEqual(await loadJobLanguage(db, job.id, { sourceLanguage: 'ko', targetLanguage: 'ja', fallbackLanguage: 'fr', languageBehaviorMode: 'preserve' }),
        JSON.parse(String(stored?.language_config)));
      const exported = await request(`/api/projects/${id}/export`);
      assert.match(exported.headers.get('content-disposition') || '', /zh-CN/);
    });

    await t.test('list, detail and paged responses agree after rescan, withdrawal and stage 2 failure', async () => {
      await json('/api/settings', 'PUT', { targetLanguage: 'zh-CN', sourceLanguage: 'en', fallbackLanguage: 'en' });
      const id = await create({ name: '状态核验', description: 'A traveler', personality: 'Friendly person' });
      await json(`/api/projects/${id}/scan`, 'POST', { scope: 'core' });
      await db.prepare("UPDATE segments SET translated_text='中文译文', review_status='approved' WHERE project_id=?").run(id);
      await json(`/api/projects/${id}/scan`, 'POST', { scope: 'core' });
      const check = async (status: string) => {
        const detail = await json(`/api/projects/${id}`);
        const paged = await json(`/api/projects/${id}?segments=none`);
        const listed = (await json('/api/projects?fresh=1')).find((p: any) => p.id === id);
        assert.equal(detail.status, status); assert.equal(paged.status, status); assert.equal(listed.status, status);
        assert.deepEqual(detail.workflowCounts, listed.workflowCounts);
        assert.deepEqual(detail.workflowCounts, paged.workflowCounts);
        return detail;
      };
      await check('reviewed');
      await json(`/api/projects/${id}/apply`, 'POST', {});
      const saved = await check('ready');
      await json(`/api/segments/${saved.segments[0].id}`, 'PATCH', { reviewStatus: 'pending' });
      const review = await check('review');
      assert.equal(review.workflowCounts.pending, 1);
      assert.equal(review.storedStatus, 'ready');
      await json(`/api/projects/${id}/approve-all`, 'POST', {});
      const timestamp = new Date().toISOString();
      await db.prepare(`INSERT INTO jobs(id, project_id, status, scope, model, total_items, completed_items,
        post_total_items, post_completed_items, post_failed_items, language_config, created_at, updated_at)
        VALUES (?,?,'review_with_errors','core','fixture',2,2,2,1,1,?,?,?)`)
        .run('guidance-fixture', id, JSON.stringify({ sourceLanguage: 'en', targetLanguage: 'zh-CN', fallbackLanguage: 'en', languageBehaviorMode: 'target', apiKey: 'must-not-be-returned' }), timestamp, timestamp);
      const failed = await check('review_with_errors');
      await json('/api/settings', 'PUT', { targetLanguage: 'ja' });
      const task = await json('/api/jobs/guidance-fixture');
      assert.equal(task.languageConfig.targetLanguage, 'zh-CN');
      assert.equal(failed.jobs[0].languageConfig.targetLanguage, 'zh-CN');
      assert.equal(JSON.stringify(task).includes('must-not-be-returned'), false);
      assert.equal(JSON.stringify(failed.jobs).includes('must-not-be-returned'), false);
      await json(`/api/projects/${id}/scan`, 'POST', { scope: 'all' });
      const outdatedRetry = await request('/api/jobs/guidance-fixture/rerun-postprocessing', 'POST', {});
      assert.equal(outdatedRetry.status, 409);
    });

    await t.test('conflicting manual script edits remain inspectable and cannot overwrite the stored draft on export', async () => {
      const id = await create({ name: 'Conflict fixture' });
      const wrap = (code: string) => ({ trigger: [{ effect: [{ code }] }] });
      const base = wrap('return "Hello"'), applied = wrap('return "你好"'), current = wrap('return "人工文字"');
      await db.prepare('UPDATE projects SET original_module_json=?, draft_module_json=?, module_review_state=? WHERE id=?')
        .run(JSON.stringify(base), JSON.stringify(current), JSON.stringify({ base, applied }), id);
      const diagnostics = await json(`/api/projects/${id}/lua/diagnostics`);
      assert.ok(diagnostics.blockerCount > 0);
      assert.ok(diagnostics.scriptChanges.some((c: any) => c.after.includes('人工文字')));
      const result = await request(`/api/projects/${id}/export`);
      assert.equal(result.status, 409);
      assert.equal((await result.json() as { code: string }).code, 'MODULE_REVIEW_CONFLICT');
      assert.equal((await db.prepare('SELECT draft_module_json FROM projects WHERE id=?').get(id))?.draft_module_json, JSON.stringify(current));
      const pathJson = '["trigger",0,"effect",0,"code"]';
      const stale = await request(`/api/projects/${id}/lua/syntax-line`, 'PATCH', {
        pathJson, line: 1, expectedLine: 'outdated', replacement: 'return "Hello"',
      });
      assert.equal(stale.status, 409);
      const edited = await request(`/api/projects/${id}/lua/syntax-line`, 'PATCH', {
        pathJson, line: 1, expectedLine: 'return "人工文字"', replacement: 'return "修订人工文字"',
      });
      assert.equal(edited.status, 200);
      assert.equal((await request(`/api/projects/${id}/export`)).status, 409);
      const restored = await request(`/api/projects/${id}/lua/syntax-line`, 'PATCH', {
        pathJson, line: 1, expectedLine: 'return "修订人工文字"', replacement: 'return "Hello"',
      });
      assert.equal(restored.status, 200);
      assert.equal((await request(`/api/projects/${id}/export`)).status, 200);
    });
  } finally {
    releaseFirst();
    await stopWorkbenchServer();
    mock.closeAllConnections(); await new Promise<void>(resolve => mock.close(() => resolve()));
    process.chdir(previousCwd);
    for (const key of ['WORKBENCH_EMBEDDED', 'WORKBENCH_DATA_DIR', 'WORKBENCH_DB_PATH']) {
      if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 3 }).catch(error => {
      // On Windows the TS compiler child can retain its startup cwd until exit.
      if (error.code !== 'EBUSY') throw error;
      t.diagnostic('Temporary fixture directory retained until the compiler process exits.');
    });
  }
});
