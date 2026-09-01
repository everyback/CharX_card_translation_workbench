import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLuaManagementReport } from '../server/domain/lua-management.js';

test('Lua management report observes visible text, controls, and blockers', () => {
  const sourceCode = 'if mode == "场景" then alertError(triggerId, "请选择角色") end';
  const sourceStart = sourceCode.indexOf('请选择角色');
  const module = {
    trigger: [{ effect: [{ code: sourceCode }] }],
  };
  const report = buildLuaManagementReport({
    originalCard: { description: '场景' },
    draftCard: { description: '场景' },
    originalModule: module,
    draftModule: { trigger: [{ effect: [{ code: 'if mode == "场景" then alertError(triggerId, "请选择角色" end' }] }] },
    storedSegments: [{
      id: 'lua-segment-1',
      pathJson: '["$module","trigger",0,"effect",0,"code"]',
      pathLabel: '模块.trigger.0.effect.0.code · 行 1，列 47',
      kind: 'runtime-message',
      sourceText: '请选择角色',
      start: sourceStart,
      end: sourceStart + '请选择角色'.length,
      reviewStatus: 'pending',
      finalText: null,
      translatedText: '请选择角色',
    }],
  });

  assert.equal(report.hasModule, true);
  assert.equal(report.sourceCount, 1);
  assert.equal(report.visibleCount, 1);
  assert.equal(report.controlReferenceCount, 1);
  assert.equal(report.pendingCount, 1);
  assert.equal(report.segments[0]?.sourceCodeLine, sourceCode);
  assert.equal(report.segments[0]?.sourceCodeLineNumber, 1);
  assert.ok(report.blockerCount >= 1);
  assert.equal(report.steps.find((step) => step.id === 'validate')?.status, 'blocked');
  const syntaxIssue = report.issues.find((issue) => issue.kind === 'syntax');
  assert.deepEqual(syntaxIssue?.segmentIds, []);
  assert.equal(syntaxIssue?.contextLines?.[0]?.draftLine, 'if mode == "场景" then alertError(triggerId, "请选择角色" end');
});

test('Lua management hides stored text when its range cannot map to original code', () => {
  const report = buildLuaManagementReport({
    originalCard: {},
    originalModule: { trigger: [{ effect: [{ code: 'return "原始代码"' }] }] },
    storedSegments: [{
      id: 'missing-source-range',
      pathJson: '["$module","trigger",0,"effect",0,"code"]',
      pathLabel: '模块.trigger.0.effect.0.code · 片段 1',
      kind: 'runtime-message',
      sourceText: '翻译后的错误摘录',
      start: null,
      end: null,
      reviewStatus: 'approved',
      finalText: '翻译后的错误摘录',
      translatedText: '翻译后的错误摘录',
    }],
  });
  assert.equal(report.segments.length, 0);
  assert.equal(report.visibleCount, 0);
});

test('Lua management report marks cards without a module as not applicable', () => {
  const report = buildLuaManagementReport({ originalCard: { name: '普通卡片' } });
  assert.equal(report.hasModule, false);
  assert.equal(report.sourceCount, 0);
  assert.equal(report.steps[0].status, 'not-applicable');
  assert.equal(report.steps[2].status, 'not-applicable');
});

test('Lua management report does not process ordinary Lua when portrait routing is absent', () => {
  const report = buildLuaManagementReport({
    originalCard: { name: '普通卡片' },
    originalModule: { trigger: [{ effect: [{ code: 'return "角色走进房间并开始对话"' }] }] },
    targetLanguage: 'zh-CN',
  });
  assert.equal(report.portraitFeatureDetected, false);
  assert.equal(report.portraitCandidateCount, 0);
  assert.equal(report.steps.find((step) => step.id === 'classify')?.status, 'not-applicable');
  assert.equal(report.steps.find((step) => step.id === 'review')?.status, 'not-applicable');
});
