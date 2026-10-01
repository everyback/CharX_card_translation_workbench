import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { matchVersionFields, type VersionField } from '../server/domain/card/version-matching.js';
import { zipSync, strToU8 } from 'fflate';

const field = (id: string, path: Array<string | number>, text: string, changes: Partial<VersionField> = {}): VersionField => ({
  id, path_json: JSON.stringify(path), path_label: path.join('.'), kind: 'field', source_text: text,
  translated_text: '旧译文', final_text: null, review_status: 'approved', start_pos: null, end_pos: null, protocol_delimiter: null, ...changes,
});

test('version matching follows stable worldbook IDs across reordering, never equal text in other fields', () => {
  const previous = { card: { entries: [{ id: 0, content: 'Same' }, { id: 2, content: 'Same' }] }, module: null };
  const current = { card: { entries: [{ id: 2, content: 'Same' }, { id: 0, content: 'Changed' }] }, module: null };
  const matches = matchVersionFields([field('new2', ['entries', 0, 'content'], 'Same'), field('new0', ['entries', 1, 'content'], 'Changed'), field('added', ['description'], 'Same')],
    [field('old0', ['entries', 0, 'content'], 'Same'), field('old2', ['entries', 1, 'content'], 'Same')], current, previous);
  assert.deepEqual(matches.map(m => [m.current?.id, m.previous?.id, m.status]), [['new2', 'old2', 'unchanged'], ['new0', 'old0', 'changed'], ['added', undefined, 'added']]);
});

test('repeated fragments and duplicate entry IDs cannot silently reuse a translation', () => {
  const source = { card: { description: '<b>Same</b><i>Same</i>', entries: [{ id: 1 }, { id: 1 }] }, module: null };
  const old = [field('a', ['description'], 'Same', { start_pos: 3, kind: 'text-node' }), field('b', ['description'], 'Same', { start_pos: 14, kind: 'text-node' }), field('c', ['entries', 0, 'content'], 'Same')];
  const next = old.map(item => ({ ...item, id: `next-${item.id}` }));
  const matches = matchVersionFields(next, old, source, source);
  assert.ok(matches.filter(m => m.current).every(m => m.status === 'ambiguous'));
  assert.equal(matches.filter(m => m.status === 'removed').length, 0, 'uncertain matching is not evidence of deletion');
});

test('duplicate IDs in the previous version remain ambiguous after the duplicate is removed', () => {
  const previous = { card: { entries: [{ id: 1, content: 'Same' }, { id: 1, content: 'Other' }] }, module: null };
  const current = { card: { entries: [{ id: 1, content: 'Same' }] }, module: null };
  const matches = matchVersionFields([field('n', ['entries', 0, 'content'], 'Same')],
    [field('p1', ['entries', 0, 'content'], 'Same'), field('p2', ['entries', 1, 'content'], 'Other')], current, previous);
  assert.equal(matches.length, 1); assert.equal(matches[0].status, 'ambiguous');
});

test('anonymous objects can move only when the complete object is unchanged', () => {
  const oldSource = { card: { entries: [{ keys: ['one'], content: 'Story' }, { keys: ['two'], content: 'Story' }] }, module: null };
  const newSource = { card: { entries: [...oldSource.card.entries].reverse() }, module: null };
  const matches = matchVersionFields([field('n', ['entries', 0, 'content'], 'Story')], [field('o1', ['entries', 0, 'content'], 'Story'), field('o2', ['entries', 1, 'content'], 'Story')], newSource, oldSource);
  assert.equal(matches[0].previous?.id, 'o2');
});

test('version import, reuse, isolation, protection and rollback through HTTP', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-versions-'));
  const previousCwd = process.cwd();
  const savedEnv = { ...process.env };
  process.chdir(directory);
  process.env.WORKBENCH_EMBEDDED = '1';
  process.env.WORKBENCH_DATA_DIR = directory;
  process.env.WORKBENCH_DB_PATH = path.join(directory, 'fixture.sqlite');
  const { startWorkbenchServer, stopWorkbenchServer } = await import('../server/routes/api.js');
  const { db } = await import('../server/db.js');
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const { address } = await startWorkbenchServer({ host: '127.0.0.1', port });
  const request = async (url: string, method = 'GET', payload?: unknown) => {
    const response = await fetch(address + url, { method, headers: payload === undefined ? undefined : { 'content-type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    const body = await response.text(); return { statusCode: response.status, body, json: () => JSON.parse(body) };
  };
  const json = async (url: string, method = 'GET', payload?: unknown) => {
    const response = await request(url, method, payload);
    assert.ok(response.statusCode < 300, `${url}: ${response.body}`);
    return response.json();
  };
  const create = async (card: unknown, baseVersionId?: string, versionLabel?: string) => (await json('/api/projects', 'POST', { card, baseVersionId, versionLabel })).id as string;
  const scan = (id: string) => json(`/api/projects/${id}/scan`, 'POST', { scope: 'all' });
  try {
    let base = '', updated = '';
    const original = { name: 'Forest Library', description: 'Hello {{user}}', personality: 'Calm', scenario: 'Old scene', creator_notes: 'Removed', character_book: { entries: [{ id: 10, keys: ['forest'], content: 'Forest story' }, { id: 20, keys: ['river'], content: 'River story' }] } };
    await t.test('unchanged fields reuse drafts, changed fields remain untranslated, original versions are untouched', async () => {
      base = await create(original);
      await scan(base);
      await db.prepare(`UPDATE segments SET final_text = CASE source_text WHEN 'Hello {{user}}' THEN '你好 {{user}}' WHEN 'Forest story' THEN '森林故事' WHEN 'River story' THEN '河流故事' ELSE '旧版译文' END,
        review_status = 'approved' WHERE project_id = ? AND kind = 'field'`).run(base);
      await json(`/api/projects/${base}/glossary`, 'POST', { sourceText: 'Forest', targetText: '森林' });
      const before = await db.prepare('SELECT * FROM projects WHERE id = ?').get(base);
      const segmentsBefore = await db.prepare('SELECT * FROM segments WHERE project_id = ? ORDER BY id').all(base);
      updated = await create({ ...original, personality: 'Calm and kind', creator_notes: undefined, first_mes: 'Welcome', character_book: { entries: [...original.character_book.entries].reverse() } }, base, '2.0 世界书更新');
      const unscanned = await json(`/api/projects/${updated}/versions`);
      assert.equal(unscanned.scanned, false); assert.equal(unscanned.counts.removed, 0);
      const result = await scan(updated);
      assert.ok(result.reusedCount >= 4);
      assert.deepEqual(await db.prepare('SELECT * FROM projects WHERE id = ?').get(base), before);
      assert.deepEqual(await db.prepare('SELECT * FROM segments WHERE project_id = ? ORDER BY id').all(base), segmentsBefore);
      const detail = await json(`/api/projects/${updated}`);
      const greeting = detail.segments.find((s: any) => s.sourceText === 'Hello {{user}}');
      assert.equal(greeting.translatedText, '你好 {{user}}'); assert.equal(greeting.finalText, null); assert.equal(greeting.reviewStatus, 'pending');
      const changed = detail.segments.find((s: any) => s.sourceText === 'Calm and kind');
      assert.equal(changed.translatedText, null); assert.equal(changed.reviewStatus, 'untranslated');
      const lore = detail.segments.find((s: any) => s.sourceText === 'River story');
      assert.equal(lore.translatedText, '河流故事'); assert.match(lore.pathLabel, /0/);
      assert.equal((await json(`/api/projects/${updated}/glossary`))[0].targetText, '森林');
      const report = await json(`/api/projects/${updated}/versions`);
      assert.equal(report.versions.length, 2); assert.equal(report.counts.changed, 1); assert.ok(report.counts.added > 0); assert.ok(report.counts.removed > 0);
      assert.equal(report.fields.find((f: any) => f.sourceText === 'Calm and kind').previousTranslation, '旧版译文');
      assert.equal((await json(`/api/projects/${updated}/export`)).description, original.description, 'pending reused text must not export');
      await json(`/api/segments/${greeting.id}`, 'PATCH', { finalText: '你好 {{user}}', reviewStatus: 'approved' });
      assert.equal((await json(`/api/projects/${updated}/export`)).description, '你好 {{user}}');
      const secondScan = await scan(updated); assert.equal(secondScan.reusedCount, 0);
      assert.equal((await json(`/api/projects/${updated}`)).segments.find((s: any) => s.id === greeting.id).reviewStatus, 'approved');
      assert.equal((await request(`/api/projects/${base}`, 'DELETE')).statusCode, 409);
    });
    await t.test('multipart CHARX version upload preserves the base and supports comparison', async () => {
      const before = await db.prepare('SELECT * FROM projects WHERE id = ?').get(base);
      const form = new FormData();
      const archive = zipSync({ 'card.json': strToU8(JSON.stringify({ ...original, description: 'Updated archive story' })) });
      form.append('file', new Blob([new Uint8Array(archive)], { type: 'application/octet-stream' }), 'New version.charx');
      const query = new URLSearchParams({ baseVersionId: base, versionLabel: '2.1 世界书更新' });
      const response = await fetch(`${address}/api/projects/import?${query}`, { method: 'POST', body: form });
      const result = await response.json() as { id: string; familyId: string; versionLabel: string };
      assert.equal(response.status, 201, JSON.stringify(result));
      assert.equal(result.familyId, base);
      assert.equal(result.versionLabel, '2.1 世界书更新');
      await scan(result.id);
      const report = await json(`/api/projects/${result.id}/versions`);
      assert.equal(report.baseVersionId, base);
      assert.ok(report.counts.changed > 0);
      assert.deepEqual(await db.prepare('SELECT * FROM projects WHERE id = ?').get(base), before);
    });
    await t.test('protection failures and language changes prevent reuse', async () => {
      await db.prepare("UPDATE segments SET final_text = '丢失变量', review_status = 'approved' WHERE project_id = ? AND source_text = 'Hello {{user}}'").run(base);
      const unsafe = await create(original, base); await scan(unsafe);
      const text = (await json(`/api/projects/${unsafe}`)).segments.find((s: any) => s.sourceText === 'Hello {{user}}');
      assert.equal(text.reviewStatus, 'untranslated'); assert.equal(text.translatedText, null);
      const differentLanguage = await create(original, base);
      await db.prepare("UPDATE projects SET target_language = 'ja' WHERE id = ?").run(differentLanguage);
      assert.equal((await scan(differentLanguage)).reusedCount, 0);
      assert.equal((await json(`/api/projects/${differentLanguage}/versions`)).compatible, false);
    });
    await t.test('import transactions roll back version metadata and preserve monotonic numbering on concurrent updates', async () => {
      const before = await db.prepare('SELECT COUNT(*) AS count FROM projects').get();
      await db.exec("CREATE TRIGGER fail_version BEFORE UPDATE OF version_number ON projects BEGIN SELECT RAISE(ABORT, 'version failure'); END;");
      assert.equal((await request('/api/projects', 'POST', { card: original, baseVersionId: base })).statusCode, 400);
      assert.deepEqual(await db.prepare('SELECT COUNT(*) AS count FROM projects').get(), before);
      await db.exec('DROP TRIGGER fail_version');
      const ids = await Promise.all([create(original, updated), create(original, base)]);
      const versions = await Promise.all(ids.map(id => json(`/api/projects/${id}`)));
      assert.equal(versions[0].familyId, base); assert.equal(versions[1].familyId, base);
      assert.notEqual(versions[0].versionNumber, versions[1].versionNumber);
      assert.equal((await request('/api/projects', 'POST', { card: original, sourceFormat: 'risum', baseVersionId: base })).statusCode, 400);
      assert.equal((await request('/api/projects', 'POST', { card: original, baseVersionId: 'missing' })).statusCode, 400);
    });
    await t.test('failed reuse rolls back the complete scan, including provenance', async () => {
      const id = await create(original, updated);
      await db.exec("CREATE TRIGGER fail_origin BEFORE INSERT ON segment_version_origins BEGIN SELECT RAISE(ABORT, 'origin failure'); END;");
      assert.equal((await request(`/api/projects/${id}/scan`, 'POST', { scope: 'all' })).statusCode, 500);
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM segments WHERE project_id = ?').get(id))?.count, 0);
      assert.equal((await db.prepare('SELECT status FROM projects WHERE id = ?').get(id))?.status, 'new');
      await db.exec('DROP TRIGGER fail_origin');
      assert.ok((await scan(id)).reusedCount > 0);
    });
    await t.test('default translation sends only changed fields to the model and keeps reused drafts', async () => {
      const prompts: string[] = [];
      const mock = createServer(async (req, res) => {
        let body = ''; for await (const chunk of req) body += chunk;
        const input = JSON.parse(body); const prompt = input.messages[1].content;
        prompts.push(prompt);
        const content = prompt.replace(/<<<ID:(S\d+)>>>[\s\S]*?<<<END>>>/g, (_match: string, id: string) => `<<<ID:${id}>>>\n新的故事\n<<<END>>>`);
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      });
      await new Promise<void>(resolve => mock.listen(0, '127.0.0.1', resolve));
      try {
        const source = await create({ name: 'Sailor', description: 'Old story' }); await scan(source);
        await db.prepare("UPDATE segments SET final_text = CASE source_text WHEN 'Sailor' THEN '水手' ELSE '旧故事' END, review_status = 'approved' WHERE project_id = ?").run(source);
        const target = await create({ name: 'Sailor', description: 'New story' }, source); assert.equal((await scan(target)).reusedCount, 1);
        await json('/api/settings', 'PUT', { apiBaseUrl: `http://127.0.0.1:${(mock.address() as { port: number }).port}/v1`, apiKey: 'fixture-only', model: 'fixture', streamingEnabled: false });
        const job = await json(`/api/projects/${target}/jobs`, 'POST', { scope: 'all' }); assert.equal(job.totalItems, 1);
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (!['queued', 'running'].includes((await json(`/api/jobs/${job.id}`)).status)) break;
          await delay(20);
        }
        const completed = await json(`/api/jobs/${job.id}`); assert.equal(completed.completedItems, 1);
        assert.ok(prompts.some(prompt => prompt.includes('New story')));
        const current = await json(`/api/projects/${target}`);
        assert.equal(current.segments.find((s: any) => s.sourceText === 'Sailor').translatedText, '水手');
        assert.equal(current.segments.find((s: any) => s.sourceText === 'New story').translatedText, '新的故事');
      } finally { await new Promise<void>(resolve => mock.close(() => resolve())); }
    });
    await t.test('whole project deletion is bounded to the family, checks active tasks and rolls back failures', async () => {
      const first = await create({ name: 'Deletion fixture' }); await scan(first);
      const second = await create({ name: 'Deletion fixture v2' }, first); await scan(second);
      const remove = (count = 2) => request(`/api/projects/${first}/family`, 'DELETE', { expectedVersionCount: count });
      assert.equal((await remove(1)).statusCode, 409);
      for (const status of ['queued', 'running', 'paused']) {
        await db.prepare("INSERT INTO jobs(id, project_id, status, scope, model, created_at, updated_at) VALUES (?, ?, ?, 'all', 'fixture', 'now', 'now')").run(`delete-${status}`, second, status);
        assert.equal((await remove()).statusCode, 409);
        await db.prepare('DELETE FROM jobs WHERE id = ?').run(`delete-${status}`);
      }
      await db.exec(`CREATE TRIGGER fail_family_delete BEFORE DELETE ON projects WHEN OLD.id = '${first}' BEGIN SELECT RAISE(ABORT, 'fixture deletion failure'); END;`);
      assert.equal((await remove()).statusCode, 500);
      assert.equal((await json(`/api/projects/${second}`)).baseVersionId, first);
      await db.exec('DROP TRIGGER fail_family_delete');
      const result = await remove(); assert.equal(result.statusCode, 200); assert.equal(result.json().deletedCount, 2);
      assert.equal((await request(`/api/projects/${first}`)).statusCode, 404);
      assert.equal((await request(`/api/projects/${second}`)).statusCode, 404);
      assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM segments WHERE project_id IN (?, ?)').get(first, second))?.count, 0);
      assert.equal((await request(`/api/projects/${base}`)).statusCode, 200, 'unrelated family survives');
      assert.equal((await remove()).statusCode, 404);
    });
    await t.test('later base translations can be reused explicitly without overwriting edits or review decisions', async () => {
      const card = { name: 'Late', description: 'Hello {{user}}', personality: 'Calm', scenario: 'Scene', first_mes: 'Hi', mes_example: 'Example', creator_notes: 'Notes' };
      const source = await create(card); await scan(source);
      const target = await create(card, source);
      assert.equal((await request(`/api/projects/${target}/versions/reuse`, 'POST')).statusCode, 409);
      await scan(target);
      assert.equal((await json(`/api/projects/${target}/versions`)).reusableCount, 0);
      await db.prepare("UPDATE segments SET final_text = '后来完成的译文', review_status = 'approved' WHERE project_id = ?").run(source);
      await db.prepare("UPDATE segments SET final_text = '本版人工稿', review_status = 'pending' WHERE project_id = ? AND source_text = 'Calm'").run(target);
      await db.prepare("UPDATE segments SET review_status = 'rejected' WHERE project_id = ? AND source_text = 'Scene'").run(target);
      await db.prepare("UPDATE segments SET final_text = '已确认的开场', review_status = 'approved' WHERE project_id = ? AND source_text = 'Hi'").run(target);
      await db.prepare("UPDATE segments SET final_text = '' WHERE project_id = ? AND source_text = 'Example'").run(target);
      assert.equal((await json(`/api/projects/${target}/versions`)).reusableCount, 2, 'protected variables and existing decisions excluded');
      const before = await db.prepare('SELECT * FROM segments WHERE project_id = ? ORDER BY id').all(target);
      await db.exec("CREATE TRIGGER fail_manual_origin BEFORE INSERT ON segment_version_origins BEGIN SELECT RAISE(ABORT, 'manual origin failure'); END;");
      assert.equal((await request(`/api/projects/${target}/versions/reuse`, 'POST')).statusCode, 500);
      assert.deepEqual(await db.prepare('SELECT * FROM segments WHERE project_id = ? ORDER BY id').all(target), before);
      await db.exec('DROP TRIGGER fail_manual_origin');
      for (const status of ['queued', 'running', 'paused']) {
        await db.prepare("INSERT INTO jobs(id, project_id, status, scope, model, created_at, updated_at) VALUES (?, ?, ?, 'all', 'fixture', 'now', 'now')").run(`manual-${status}`, target, status);
        assert.equal((await json(`/api/projects/${target}/versions`)).activeJob, true);
        assert.equal((await request(`/api/projects/${target}/versions/reuse`, 'POST')).statusCode, 409);
        await db.prepare('DELETE FROM jobs WHERE id = ?').run(`manual-${status}`);
      }
      assert.equal((await json(`/api/projects/${target}/versions/reuse`, 'POST')).reusedCount, 2);
      assert.equal((await json(`/api/projects/${target}/versions/reuse`, 'POST')).reusedCount, 0, 'retries are idempotent');
      const after = await json(`/api/projects/${target}`);
      const get = (sourceText: string) => after.segments.find((segment: any) => segment.sourceText === sourceText);
      assert.equal(get('Late').reviewStatus, 'pending'); assert.equal(get('Late').translatedText, '后来完成的译文');
      assert.equal(get('Calm').finalText, '本版人工稿'); assert.equal(get('Scene').reviewStatus, 'rejected');
      assert.equal(get('Hi').finalText, '已确认的开场'); assert.equal(get('Example').finalText, '');
      assert.equal(get('Hello {{user}}').translatedText, null);
      assert.equal((await json(`/api/projects/${target}/export`)).name, 'Late');
      await db.prepare("UPDATE projects SET target_language = 'ja' WHERE id = ?").run(target);
      assert.equal((await request(`/api/projects/${target}/versions/reuse`, 'POST')).statusCode, 409);
      assert.equal((await request('/api/projects/missing/versions/reuse', 'POST')).statusCode, 404);
    });
  } finally {
    await stopWorkbenchServer(); process.chdir(previousCwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(directory, { recursive: true, force: true });
  }
});
