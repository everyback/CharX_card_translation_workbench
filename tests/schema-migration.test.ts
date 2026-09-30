import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AsyncDatabase } from '../server/async-db.js';
import { addColumnIfMissing } from '../server/repositories/schema-migration.js';

test('independent cold-start connections serialize the same migration and preserve existing rows', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ctw-schema-race-'));
  const databases = Array.from({ length: 3 }, () => new AsyncDatabase(path.join(directory, 'fixture.sqlite')));
  try {
    await databases[0].exec("CREATE TABLE segments (id TEXT PRIMARY KEY); INSERT INTO segments VALUES ('retained');");
    await Promise.all(databases.map(db => addColumnIfMissing(db, 'segments', 'in_scope', 'INTEGER NOT NULL DEFAULT 1')));
    await Promise.all(databases.map(db => addColumnIfMissing(db, 'segments', 'in_scope', 'INTEGER NOT NULL DEFAULT 1')));
    assert.deepEqual(await databases[0].prepare('SELECT * FROM segments').all(), [{ id: 'retained', in_scope: 1 }]);
    await assert.rejects(addColumnIfMissing(databases[0], 'missing_table', 'value', 'TEXT'), /no such table/);
    await addColumnIfMissing(databases[0], 'segments', 'value', 'TEXT');
    assert.equal((await databases[0].prepare('PRAGMA table_info(segments)').all()).length, 3);
  } finally {
    await Promise.all(databases.map(db => db.close()));
    await rm(directory, { recursive: true, force: true });
  }
});
