import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDatabaseWorkerCount } from '../config/validation.js';

test('database worker configuration defaults to three and accepts arbitrary positive counts', () => {
  assert.equal(resolveDatabaseWorkerCount(undefined), 3);
  assert.equal(resolveDatabaseWorkerCount('1'), 1);
  assert.equal(resolveDatabaseWorkerCount('400'), 400);
});

test('invalid database worker configuration is rejected', () => {
  assert.throws(() => resolveDatabaseWorkerCount('0'), /大于 0 的整数/);
  assert.throws(() => resolveDatabaseWorkerCount('-1'), /大于 0 的整数/);
  assert.throws(() => resolveDatabaseWorkerCount('1.5'), /大于 0 的整数/);
  assert.throws(() => resolveDatabaseWorkerCount('abc'), /大于 0 的整数/);
});
