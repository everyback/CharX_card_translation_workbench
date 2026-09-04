import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileScannedSegments } from '../server/application/scanning/scan-service.js';
import type { ScannedSegment } from '../server/domain/card/card.js';

function scanned(path: string[], sourceText: string, start: number | null, end: number | null): ScannedSegment {
  return {
    path,
    pathLabel: path.join('.'),
    category: 'core',
    kind: 'field',
    sourceText,
    start,
    end,
    risk: 'low',
  };
}

test('scan reconciliation preserves reviewed segments across source position changes', () => {
  const previous = [
    {
      id: 'exact', path_json: '["data","description"]', kind: 'field', source_text: '保持位置', start_pos: 0, end_pos: 4,
      final_text: '保留译文', review_status: 'approved', included: 1, qa_flags: '[]', translated_text: null,
    },
    {
      id: 'shifted', path_json: '["data","description"]', kind: 'field', source_text: '位置改变但原文相同', start_pos: 30, end_pos: 39,
      final_text: '继续保留', review_status: 'approved', included: 1, qa_flags: '[]', translated_text: null,
    },
    {
      id: 'obsolete', path_json: '["data","personality"]', kind: 'field', source_text: '已删除原文', start_pos: null, end_pos: null,
      final_text: '不应保留', review_status: 'approved', included: 1, qa_flags: '[]', translated_text: null,
    },
    {
      id: 'namespace-decision', path_json: '["$module","namespace"]', kind: 'field', source_text: 'mahou_shoujo_ni_akogarete', start_pos: null, end_pos: null,
      final_text: 'mahou_shoujo_ni_akogarete', review_status: 'approved', included: 1, qa_flags: '[]', translated_text: 'mahou_shoujo_ni_akogarete',
    },
  ];

  const plan = reconcileScannedSegments([
    scanned(['data', 'description'], '保持位置', 0, 4),
    scanned(['data', 'description'], '位置改变但原文相同', 300, 309),
    scanned(['data', 'scenario'], '新增段落', null, null),
  ], previous);

  assert.deepEqual(plan.retained.map((item) => item.previousId), ['exact', 'shifted', undefined]);
  assert.equal(plan.preservedCount, 2);
  assert.deepEqual(plan.obsoleteIds, ['obsolete']);
});
