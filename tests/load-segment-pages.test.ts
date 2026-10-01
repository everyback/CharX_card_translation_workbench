import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSegmentPages } from '../src/pages/workbench/model/load-segment-pages';

test('segment pages overlap requests while preserving field order and monotonic progress', async () => {
  const pending = new Map<number, (value: { total: number; segments: number[] }) => void>();
  const progress: number[] = [];
  const result = loadSegmentPages(5, 2, offset => new Promise(resolve => pending.set(offset, resolve)), value => progress.push(value), new AbortController().signal);
  assert.deepEqual([...pending.keys()], [0, 2, 4]);
  pending.get(4)!({ total: 5, segments: [4] });
  pending.get(2)!({ total: 5, segments: [2, 3] });
  pending.get(0)!({ total: 5, segments: [0, 1] });
  assert.deepEqual(await result, [0, 1, 2, 3, 4]);
  assert.deepEqual(progress, [1, 3, 5]);
});

test('segment loading rejects incomplete or changing datasets and cancelled responses', async () => {
  for (const page of [{ total: 3, segments: [0, 1] }, { total: 2, segments: [0] }]) {
    await assert.rejects(loadSegmentPages(2, 2, async () => page, () => {}, new AbortController().signal), /不完整/);
  }
  const controller = new AbortController();
  await assert.rejects(loadSegmentPages(2, 2, async () => {
    controller.abort(); return { total: 2, segments: [0, 1] };
  }, () => { throw new Error('cancelled response must not update progress'); }, controller.signal), { name: 'AbortError' });
  assert.deepEqual(await loadSegmentPages(0, 2, async () => { throw new Error('empty project must not fetch'); }, () => {}, new AbortController().signal), []);
});
