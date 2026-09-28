import assert from 'node:assert/strict';
import test from 'node:test';
import { readWorkbenchRoute, writeWorkbenchRoute } from '../src/pages/workbench/model/routing';

test('independent pages omit card selection from their URL and preserve card routes', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let currentUrl = new URL('http://127.0.0.1:18983/?tab=plugins&project=old-card&segment=old-segment');
  const browser = {
    location: { get href() { return currentUrl.href; }, get search() { return currentUrl.search; } },
    history: {
      pushState(_state: unknown, _title: string, url: URL) { currentUrl = new URL(url); },
      replaceState(_state: unknown, _title: string, url: URL) { currentUrl = new URL(url); },
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browser });
  try {
    assert.deepEqual(readWorkbenchRoute(), { tab: 'plugins', projectId: '', segmentId: '' });
    writeWorkbenchRoute({ tab: 'plugins', projectId: 'card-1', segmentId: 'segment-1' });
    assert.equal(currentUrl.search, '?tab=plugins');

    writeWorkbenchRoute({ tab: 'review', projectId: 'card-1', segmentId: 'segment-1' });
    assert.equal(currentUrl.search, '?tab=review&project=card-1&segment=segment-1');
    assert.deepEqual(readWorkbenchRoute(), { tab: 'review', projectId: 'card-1', segmentId: 'segment-1' });
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
