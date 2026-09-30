import { savePostprocessingDraft } from '../server/application/translation/postprocessing-store.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsyncDatabase } from '../server/async-db.js';
import { createJobLifecycleService } from '../server/application/translation/job-lifecycle-service.js';

async function createJobDatabase(): Promise<{ database: AsyncDatabase; directory: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-job-service-'));
  const database = new AsyncDatabase(path.join(directory, 'test.sqlite'));
  await database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE projects (
      scope TEXT NOT NULL DEFAULT 'all-visible',
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE segments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      translated_text TEXT,
      final_text TEXT,
      review_status TEXT NOT NULL,
      qa_flags TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      status TEXT NOT NULL,
      scope TEXT NOT NULL,
      model TEXT NOT NULL,
      total_items INTEGER NOT NULL,
      completed_items INTEGER NOT NULL DEFAULT 0,
      failed_items INTEGER NOT NULL DEFAULT 0,
      post_total_items INTEGER NOT NULL DEFAULT 0,
      post_completed_items INTEGER NOT NULL DEFAULT 0,
      post_failed_items INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE job_items (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      segment_id TEXT NOT NULL REFERENCES segments(id),
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      cancel_reason TEXT,
      UNIQUE(job_id, segment_id)
    );
    CREATE TABLE job_logs (
      id INTEGER PRIMARY KEY,
      job_id TEXT NOT NULL,
      level TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  return { database, directory };
}


async function fixture() {
  const { database, directory } = await createJobDatabase();
  await database.exec(`
    INSERT INTO projects (id, status, updated_at) VALUES ('p', 'translating', 'before');
    INSERT INTO segments VALUES ('s','p',NULL,NULL,'untranslated','[]','before',0);
    INSERT INTO jobs VALUES ('j','p','running','all-visible','mock',1,0,0,1,0,0,NULL,'before','before');
    INSERT INTO job_items VALUES ('i','j','s','running',1,NULL,'before',NULL);
  `);
  const effects: string[] = [];
  const service = createJobLifecycleService({ database, clock: () => 'after',
    jobById: (id) => database.prepare('SELECT * FROM jobs WHERE id = ?').get(id),
    abortJob: () => effects.push('abort'), scheduleJob: () => effects.push('schedule'),
  });
  return { database, service, effects, close: async () => {
    await database.close(); await rm(directory, { recursive: true, force: true });
  } };
}

test('pause and resume preserve completed work and move job and items together', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.pause('j'))?.status, 'paused');
    assert.equal((await f.database.prepare('SELECT status FROM job_items').get())?.status, 'pending');
    assert.equal((await f.database.prepare('SELECT status FROM projects').get())?.status, 'paused');
    assert.deepEqual(f.effects, ['abort']);
    assert.equal((await f.service.resume('j'))?.status, 'queued');
    assert.equal((await f.database.prepare('SELECT status FROM projects').get())?.status, 'translating');
    assert.deepEqual(f.effects, ['abort', 'schedule']);
    await assert.rejects(f.service.resume('j'), /不能继续/);
    assert.deepEqual(f.effects, ['abort', 'schedule']);
  } finally { await f.close(); }
});

test('failed lifecycle transaction rolls back all changes without aborting a running job', async () => {
  const f = await fixture();
  try {
    await f.database.exec(`CREATE TRIGGER fail_update BEFORE UPDATE ON job_items BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    await assert.rejects(f.service.pause('j'), /injected failure/);
    assert.equal((await f.database.prepare('SELECT status FROM jobs').get())?.status, 'running');
    assert.equal((await f.database.prepare('SELECT status FROM projects').get())?.status, 'translating');
    assert.deepEqual(f.effects, []);
  } finally { await f.close(); }
});

test('cancellation is atomic and postprocessing cannot restart a cancelled job', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.service.cancel('j'))?.status, 'cancelled');
    assert.equal((await f.database.prepare('SELECT status FROM job_items').get())?.status, 'cancelled');
    assert.equal((await f.database.prepare('SELECT status FROM projects').get())?.status, 'cancelled');
    await assert.rejects(f.service.rerunPostprocessing('j'), /阶段 2/);
    assert.deepEqual(f.effects, ['abort']);
    await assert.rejects(f.service.cancel('missing'), /不存在/);
  } finally { await f.close(); }
});

test('cancelling one job does not hide another active job in the project list', async () => {
  const f = await fixture();
  try {
    await f.database.exec(`INSERT INTO jobs VALUES ('other','p','running','all-visible','mock',1,0,0,1,0,0,NULL,'later','later');`);
    await f.service.cancel('j');
    assert.equal((await f.database.prepare('SELECT status FROM projects').get())?.status, 'translating');
  } finally { await f.close(); }
});

test('retry and postprocessing reset counters and schedule only after commit', async () => {
  const f = await fixture();
  try {
    await f.database.exec("UPDATE jobs SET status='review_with_errors', failed_items=1, post_failed_items=1; UPDATE job_items SET status='failed';");
    const retried = await f.service.retryFailed('j');
    assert.equal(retried?.status, 'queued'); assert.equal(retried?.failed_items, 0);
    await f.database.exec("UPDATE jobs SET status='review_with_errors', post_failed_items=1;");
    assert.equal((await f.service.rerunPostprocessing('j'))?.status, 'queued');
    assert.deepEqual(f.effects, ['schedule', 'schedule']);
  } finally { await f.close(); }
});

test('postprocessing writes reject cancelled jobs, stale versions and foreign projects', async () => {
  const f = await fixture();
  try {
    await f.database.exec("ALTER TABLE projects ADD COLUMN draft_module_json TEXT; ALTER TABLE projects ADD COLUMN draft_json TEXT;");
    const input = { jobId: 'j', projectId: 'p', expectedUpdatedAt: 'before', updatedAt: 'v2', module: { name: 'review candidate' }, card: { name: 'card draft' } };
    assert.equal((await savePostprocessingDraft(f.database, input)).changes, 1);
    assert.equal((await savePostprocessingDraft(f.database, input)).changes, 0);
    await f.service.cancel('j');
    assert.equal((await savePostprocessingDraft(f.database, { ...input, expectedUpdatedAt: 'v2' })).changes, 0);
    const draft = await f.database.prepare('SELECT draft_module_json, draft_json FROM projects').get();
    assert.deepEqual(JSON.parse(String(draft?.draft_module_json)), input.module);
    assert.deepEqual(JSON.parse(String(draft?.draft_json)), input.card);
    await f.database.exec("INSERT INTO projects(id,status,updated_at) VALUES ('other','review','v2'); UPDATE jobs SET status='running', project_id='other';");
    assert.equal((await savePostprocessingDraft(f.database, { ...input, expectedUpdatedAt: 'v2' })).changes, 0);
  } finally { await f.close(); }
});

test('resume cannot resurrect transferred or manually reviewed items, including after the successor completes', async () => {
  const f = await fixture();
  try {
    await f.service.pause('j');
    await f.database.exec(`
      INSERT INTO segments VALUES ('keep','p',NULL,NULL,'untranslated','[]','before',1);
      INSERT INTO job_items VALUES ('keep-item','j','keep','pending',0,NULL,'before',NULL);
      INSERT INTO jobs VALUES ('next','p','review','all-visible','mock',1,1,0,0,0,0,NULL,'later','later');
      INSERT INTO job_items VALUES ('next-item','next','s','completed',1,NULL,'later',NULL);
      UPDATE job_items SET status = 'cancelled', cancel_reason = 'transferred' WHERE id = 'i';
    `);
    await f.service.resume('j');
    assert.equal((await f.database.prepare("SELECT status FROM job_items WHERE id='i'").get())?.status, 'cancelled');
    assert.equal((await f.database.prepare("SELECT total_items FROM jobs WHERE id='j'").get())?.total_items, 1);
    await f.service.pause('j');
    await f.database.exec("UPDATE job_items SET status='cancelled', cancel_reason='manual-review' WHERE id='keep-item'");
    await assert.rejects(f.service.resume('j'), /已转移或由人工接管/);
    assert.equal((await f.database.prepare("SELECT status FROM jobs WHERE id='j'").get())?.status, 'paused');
  } finally { await f.close(); }
});
