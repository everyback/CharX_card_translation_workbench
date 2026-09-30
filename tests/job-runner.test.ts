import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { JobRunner } from '../server/application/translation/job-runner.js';

test('resume waits for aborted work to drain and runs exactly once', async () => {
  const first = Promise.withResolvers<void>();
  const signals: AbortSignal[] = [];
  const errors: unknown[] = [];
  const runner = new JobRunner(async (_id, signal) => {
    signals.push(signal);
    if (signals.length === 1) await first.promise;
  }, (error) => errors.push(error));
  runner.schedule('job');
  runner.schedule('job');
  await tick();
  assert.equal(signals.length, 1);
  runner.abort('job');
  runner.schedule('job');
  runner.schedule('job');
  await tick();
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
  first.resolve();
  await tick();
  await tick();
  assert.equal(signals.length, 2);
  assert.equal(signals[1].aborted, false);
  assert.deepEqual(errors, []);
});

test('a second cancellation removes a pending resume', async () => {
  const first = Promise.withResolvers<void>();
  let runs = 0;
  const runner = new JobRunner(async () => { runs++; await first.promise; }, assert.fail);
  runner.schedule('job');
  await tick();
  runner.abort('job');
  runner.schedule('job');
  runner.abort('job');
  first.resolve();
  await tick();
  await tick();
  assert.equal(runs, 1);
});
