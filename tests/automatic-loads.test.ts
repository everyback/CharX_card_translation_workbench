import assert from 'node:assert/strict';
import test from 'node:test';
import { AutomaticLoads } from '../src/pages/workbench/model/automatic-loads.js';

test('failed report loads do not repeat when loading state changes', async () => {
  const loads = new AutomaticLoads();
  let calls = 0;
  const fail = async () => { calls++; throw new Error('offline'); };
  await assert.rejects(loads.run('overview:p', fail)!, /offline/);
  assert.equal(loads.run('overview:p', fail), undefined);
  assert.equal(calls, 1);
  loads.invalidate('overview:p');
  await assert.rejects(loads.run('overview:p', fail)!, /offline/);
  assert.equal(calls, 2);
});

test('in-flight duplicate loads are suppressed and switching projects resets attempts', async () => {
  const loads = new AutomaticLoads();
  const deferred = Promise.withResolvers<void>();
  let calls = 0;
  const load = () => { calls++; return deferred.promise; };
  const first = loads.run('resources:p', load);
  assert.equal(loads.run('resources:p', load), undefined);
  assert.equal(calls, 1);
  deferred.resolve();
  await first;
  loads.clear();
  await loads.run('resources:p', load);
  assert.equal(calls, 2);
});
