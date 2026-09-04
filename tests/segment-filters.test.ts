import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesSegmentSearch } from '../src/features/segment-filter/model/useSegmentFilters.js';
import type { Segment } from '../src/shared/types.js';

const segment: Segment = {
  id: 'segment-1',
  pathLabel: '世界书 / 红魔馆',
  category: 'worldbook',
  kind: 'text',
  sourceText: 'Scarlet Devil Mansion',
  translatedText: '红魔馆草稿译文',
  finalText: '红魔馆最终译文',
  start: null,
  end: null,
  riskLevel: 'low',
  reviewStatus: 'approved',
  included: true,
  qaFlags: [],
  controlReferences: [],
  translationError: null,
  sortOrder: 0,
  updatedAt: '2026-08-27T00:00:00.000Z',
};

test('translation search includes machine and final translations only', () => {
  assert.equal(matchesSegmentSearch(segment, '最终译文', 'translation'), true);
  assert.equal(matchesSegmentSearch({ ...segment, finalText: null }, '草稿译文', 'translation'), true);
  assert.equal(matchesSegmentSearch(segment, 'Scarlet', 'translation'), false);
});

test('search scopes keep source and path matches separate', () => {
  assert.equal(matchesSegmentSearch(segment, 'Scarlet', 'source'), true);
  assert.equal(matchesSegmentSearch(segment, '世界书', 'path'), true);
  assert.equal(matchesSegmentSearch(segment, '最终译文', 'all'), true);
});
