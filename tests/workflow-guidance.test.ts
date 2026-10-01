import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { GuidedWorkflow } from '../src/pages/workbench/components/workflow/GuidedWorkflow.js';
import { TranslationCommandBar } from '../src/features/translation/ui/TranslationCommandBar.js';
import { JobsPage } from '../src/pages/workbench/tabs/jobs/JobsPage.js';
import { workflowState } from '../src/features/translation/model/workflow-state.js';
import { publicJobLanguage } from '../server/application/translation/job-language.js';
import type { Job, ProjectDetail, Segment, Settings } from '../src/shared/types.js';

const noop = () => {};
const segment = (reviewStatus: string) => ({ included: true, reviewStatus, translatedText: reviewStatus === 'untranslated' ? null : '译文', pathLabel: 'description' } as Segment);
const job = (status = 'review') => ({ id: 'j', projectId: 'p', scope: 'core', status, model: 'fixture', totalItems: 2, completedItems: 2,
  failedItems: 0, postTotalItems: 0, postCompletedItems: 0, postFailedItems: 0, createdAt: '2026-01-01', logs: [],
  languageConfig: { sourceLanguage: 'en', targetLanguage: 'zh-CN', fallbackLanguage: 'en', languageBehaviorMode: 'target' },
} as Job);
const project = (status: string, segments: Segment[], task = job()) => ({ id: 'p', status, storedStatus: status, scope: 'core', sourceFormat: 'json',
  segments, jobs: [task], controlReferences: [], sourceLanguage: 'en', targetLanguage: 'zh-CN', languageBehaviorMode: 'target',
} as unknown as ProjectDetail);
const settings = { model: 'fixture', apiKeyConfigured: true } as Settings;
function guide(p: ProjectDetail, scope = p.scope) {
  return renderToStaticMarkup(React.createElement(GuidedWorkflow, { project: p, settings, scope, busy: '', protocols: [],
    onOpenSettings: noop, onScopeChange: noop, onScan: noop, onStartTranslation: noop, onOpenJobs: noop,
    onOpenReview: noop, onOpenLuaManagement: noop, onOpenProtocols: noop, onApproveAll: noop,
    onOpenSegments: noop, onApplyDraft: noop, onSaveAndExport: noop }));
}
function command(p: ProjectDetail, scope = p.scope) {
  return renderToStaticMarkup(React.createElement(TranslationCommandBar, { project: p, settings, scope, busy: '',
    activeTranslationJob: Boolean(workflowState(p).active), onScopeChange: noop, onScan: noop, onStartTranslation: noop, onLanguageRuleChange: noop }));
}
function jobs(task: Job, scope = 'core') {
  return renderToStaticMarkup(React.createElement(JobsPage, { jobs: [task], selected: task, onSelect: noop, onAction: noop,
    onOpenReview: noop, languageBehaviorMode: 'preserve', targetLanguage: 'ja', currentScope: scope }));
}

test('withdrawn approval overrides a previously saved project in the guide and command bar', () => {
  const p = project('ready', [segment('pending'), segment('approved')]);
  assert.equal(workflowState(p).status, 'review');
  assert.equal(workflowState(p).flowStep, 3);
  assert.match(guide(p), /当前还有 1 条待审核/);
  assert.doesNotMatch(guide(p), /审核稿已保存|当前范围审核已通过/);
  assert.match(command(p), /disabled=""[^>]*>.*?没有待翻译项/);
});

test('rescan with preserved approvals goes directly to export rather than an empty translation', () => {
  const p = project('scanned', [segment('approved'), segment('approved')]);
  assert.equal(workflowState(p).flowStep, 4);
  assert.equal(workflowState(p).canStart, false);
  assert.match(guide(p), /当前范围审核已通过/);
  assert.doesNotMatch(guide(p), /开始翻译/);
});

test('stage 2 failures take priority over complete text approvals, including regex-only failures', () => {
  for (const counters of [{ postTotalItems: 2, postCompletedItems: 1, postFailedItems: 1 }, {}]) {
    const task = { ...job('review_with_errors'), ...counters };
    const p = project('ready', [segment('approved'), segment('approved')], task);
    assert.equal(workflowState(p).status, 'review_with_errors');
    assert.equal(workflowState(p).retryAction, 'retry-failed');
    assert.match(guide(p), /阶段 2 尚未完成，需要处理/);
    assert.doesNotMatch(guide(p), /当前范围审核已通过/);
    assert.match(command(p), /重试阶段 2/);
  }
});

test('paused, cancelled and failed jobs never claim that unfinished stage 2 is executing', () => {
  for (const status of ['paused', 'cancelled', 'failed']) {
    const html = jobs({ ...job(status), postTotalItems: 2 });
    assert.match(html, /剩余未完成/);
    assert.match(html, /阶段 2 尚未完成/);
    assert.doesNotMatch(html, /正在处理 Lua|翻译中|翻译已完成，下一步/);
  }
});

test('job details display saved task languages instead of later global or project defaults', () => {
  assert.match(jobs(job()), /en → zh-CN/);
  assert.doesNotMatch(jobs(job()), /保留卡片原设定|跟随ja/);
  assert.match(jobs({ ...job(), languageConfig: null }), /旧任务未记录语言快照/);
  const safe = publicJobLanguage(JSON.stringify({ ...job().languageConfig, apiKey: 'not-a-real-key' }));
  assert.deepEqual(safe, job().languageConfig);
  assert.equal(publicJobLanguage('{invalid'), null);
});

test('history in another scope cannot expose retry/resume controls or override current review', () => {
  const task = { ...job('review_with_errors'), scope: 'all', postTotalItems: 1, postFailedItems: 1 } as Job;
  const p = project('scanned', [segment('approved')], task);
  assert.equal(workflowState(p).hasFailures, false);
  assert.equal(workflowState(p).flowStep, 4);
  assert.doesNotMatch(jobs(task), />重试阶段 2<|>继续翻译</);
});

test('scope changes keep active task navigation available and cannot silently scan a different preset', () => {
  const p = project('translating', [segment('untranslated')], job('running'));
  assert.match(guide(p, 'standard'), /当前任务仍按原范围执行/);
  assert.match(guide(p, 'standard'), /查看任务进度/);
  assert.match(command(p, 'standard'), /class="primary-button"><.*查看翻译进度/);
  const empty = project('scanned', []);
  assert.match(guide(empty), /没有待处理的翻译项/);
  assert.doesNotMatch(guide(empty), /开始翻译/);
});


test('large task history mounts one page while a selected task outside that page keeps its detail', () => {
  const history = Array.from({ length: 2000 }, (_, i) => ({ ...job(), id: `job-${i}`, model: `model-${i}` }));
  const html = renderToStaticMarkup(React.createElement(JobsPage, {
    jobs: history, selected: history[1999], loadingJobId: history[1999].id,
    onSelect: noop, onAction: noop, onOpenReview: noop,
    languageBehaviorMode: 'target', targetLanguage: 'zh-CN',
  }));
  assert.equal((html.match(/class="job-list-item /g) ?? []).length, 50);
  assert.match(html, /共 2000 个任务/);
  assert.match(html, /model-1999/);
  assert.match(html, /正在读取任务详情与运行日志/);
  assert.match(html, /aria-busy="true"/);
});
