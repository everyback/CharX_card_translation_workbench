import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowState } from '../src/features/translation/model/workflow-state.js';
import { reconcileTextDraft } from '../src/features/review/lib/text-draft.js';
import { regexSaveState } from '../src/pages/workbench/tabs/lua/lib/regex-save-state.js';
import { regexConflictBaseline } from '../src/pages/workbench/tabs/lua/lib/regex-conflict.js';
import { reconcileProtocolDraft } from '../src/features/protocol/model/protocol-draft.js';
import type { ProjectDetail, ProtocolFieldRule, RegexRuleSaveResult } from '../src/shared/types.js';

const project = (status: string, jobStatus: string, completed = 0) => ({
  status, scope: 'all', segments: Array.from({ length: 4 }, () => ({
    included: true, reviewStatus: status === 'ready' ? 'approved' : jobStatus === 'review' ? 'pending' : 'untranslated',
    translatedText: status === 'ready' || jobStatus === 'review' ? '译文' : null,
  })), jobs: [{ id: 'j', status: jobStatus, totalItems: 4, completedItems: completed, failedItems: 0 }],
} as ProjectDetail);

test('workflow recovers stale translating status after pause, failure and cancellation', () => {
  for (const state of ['paused', 'failed', 'cancelled']) {
    assert.equal(workflowState(project('translating', state)).status, state);
  }
  assert.equal(workflowState(project('translating', 'review')).status, 'review');
  assert.equal(workflowState(project('ready', 'review')).status, 'ready');
  assert.equal(workflowState(project('review', 'cancelled')).status, 'cancelled');
  assert.equal(workflowState(project('review_with_errors', 'failed')).status, 'failed');
  assert.equal(workflowState(project('scanned', 'cancelled')).status, 'scanned');
  assert.equal(workflowState(project('ready', 'cancelled')).status, 'ready');
});

test('conflicting regex outputs refresh the saved baseline without changing the candidate', () => {
  const baseline = { currentPattern: 'Hello', currentOutput: '$1', candidate: '$1 edited' };
  assert.deepEqual(regexConflictBaseline(baseline, { currentOutput: 'changed elsewhere' }), {
    ...baseline, currentOutput: 'changed elsewhere',
  });
  assert.deepEqual(regexConflictBaseline(baseline, { currentPattern: 'World', currentOutput: '' }), {
    ...baseline, currentPattern: 'World', currentOutput: '',
  });
  assert.deepEqual(regexConflictBaseline(baseline, { currentPattern: undefined }), baseline);
});

test('protocol polling preserves edited field policies and updates untouched drafts', () => {
  const previous = [{ index: 0, policy: 'translate', reason: 'visible text' }] as ProtocolFieldRule[];
  const edited = [{ ...previous[0], policy: 'protect' }] as ProtocolFieldRule[];
  const incoming = [{ ...previous[0], reason: 'new model assessment' }];
  assert.deepEqual(reconcileProtocolDraft(structuredClone(previous), previous, incoming), incoming);
  assert.equal(reconcileProtocolDraft(edited, previous, structuredClone(previous)), edited);
  assert.equal(reconcileProtocolDraft(edited, previous, incoming), edited);
  assert.deepEqual(reconcileProtocolDraft(edited, edited, incoming), incoming);
});
test('active jobs override stale project status and expose adaptation stage', () => {
  assert.equal(workflowState(project('review', 'running')).status, 'translating');
  assert.equal(workflowState(project('translating', 'running', 4)).stage, 'adaptation');
  assert.equal(workflowState(project('translating', 'running', 3)).stage, 'text');
});
test('incoming translations update clean editors without discarding manual drafts', () => {
  assert.equal(reconcileTextDraft('', '', '新的译文'), '新的译文');
  assert.equal(reconcileTextDraft('人工修改', '旧的译文', '新的译文'), '人工修改');
  assert.equal(reconcileTextDraft('已保存', '已保存', '更新后的已保存稿'), '更新后的已保存稿');
  assert.equal(reconcileTextDraft(undefined, undefined, '原始载入'), '原始载入');
});
test('saved regex classification uses export baseline rather than candidate self matches', () => {
  const result = { compiled: true, saved: true, sourceMatchCount: 0, draftMatchCount: 0,
    validationSourceMatchCount: 8, validationDraftMatchCount: 0 } as RegexRuleSaveResult;
  assert.equal(regexSaveState(result).status, 'saved-with-issues');
  assert.equal(regexSaveState({ ...result, validationDraftMatchCount: 8 }).status, 'saved');
  assert.equal(regexSaveState({ ...result, runtimePostprocess: true }).status, 'saved');
  assert.equal(regexSaveState({ ...result, forcePassed: true }).status, 'saved');
});
