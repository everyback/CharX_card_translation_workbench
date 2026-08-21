import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AsyncDatabase } from '../server/async-db.js';

test('slow SQLite queries do not block the main event loop', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-async-db-'));
  const database = new AsyncDatabase(path.join(directory, 'test.sqlite'));
  try {
    const slowQuery = database.prepare(`
      WITH RECURSIVE counter(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM counter WHERE value < 2000000
      )
      SELECT SUM(value) AS total FROM counter
    `).get<{ total: number }>();
    const winner = await Promise.race([
      slowQuery.then(() => 'query'),
      delay(10).then(() => 'timer'),
    ]);
    assert.equal(winner, 'timer');
    assert.equal(Number((await slowQuery)?.total), 2000001000000);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('async transactions commit atomically and roll back on failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-async-db-'));
  const database = new AsyncDatabase(path.join(directory, 'test.sqlite'));
  try {
    await database.exec('CREATE TABLE values_table(value TEXT NOT NULL)');
    await database.transaction(async () => {
      await database.prepare('INSERT INTO values_table(value) VALUES (?)').run('committed');
    });
    await assert.rejects(database.transaction(async () => {
      await database.prepare('INSERT INTO values_table(value) VALUES (?)').run('rolled-back');
      throw new Error('rollback');
    }), /rollback/);
    const rows = await database.prepare<{ value: string }>('SELECT value FROM values_table ORDER BY rowid').all();
    assert.deepEqual(rows, [{ value: 'committed' }]);
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('SQLite accepts WAL with NORMAL synchronous mode on the worker connection', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-async-db-'));
  const database = new AsyncDatabase(path.join(directory, 'test.sqlite'));
  try {
    await database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    const runtime = await database.prepare<{ journalMode: string; synchronous: number }>(`
      SELECT
        (SELECT journal_mode FROM pragma_journal_mode) AS journalMode,
        (SELECT synchronous FROM pragma_synchronous) AS synchronous
    `).get();
    assert.deepEqual(runtime, { journalMode: 'wal', synchronous: 1 });
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('three workers allow WAL reads while the writer owns a transaction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-async-db-'));
  const database = new AsyncDatabase(path.join(directory, 'test.sqlite'));
  try {
    assert.equal(database.workerCount, 3);
    await database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE values_table(value TEXT NOT NULL);
      INSERT INTO values_table(value) VALUES ('before');
    `);

    let releaseWriter!: () => void;
    let writerStarted!: () => void;
    const writerReleased = new Promise<void>((resolve) => { releaseWriter = resolve; });
    const writerIsRunning = new Promise<void>((resolve) => { writerStarted = resolve; });
    const transaction = database.transaction(async () => {
      await database.prepare('INSERT INTO values_table(value) VALUES (?)').run('uncommitted');
      writerStarted();
      await writerReleased;
    });

    await writerIsRunning;
    const readResult = await Promise.race([
      database.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM values_table').get(),
      delay(500).then(() => 'timeout' as const),
    ]);
    assert.notEqual(readResult, 'timeout');
    assert.deepEqual(readResult, { count: 1 });

    releaseWriter();
    await transaction;
    assert.deepEqual(
      await database.prepare<{ count: number }>('SELECT COUNT(*) AS count FROM values_table').get(),
      { count: 2 },
    );
  } finally {
    await database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
