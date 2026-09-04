import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLuaManagementReport } from '../server/domain/lua/lua-management.js';
import { applyPortraitRouterRepairs } from '../server/domain/lua/portrait-router-repair.js';

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

test('Lua management extracts regex rules even before a draft module exists', () => {
  const module = {
    namespace: 'mahou_shoujo_ni_akogarete',
    regex: [{
      in: '<img cmd="([^"]+)">',
      out: '<img cmd="$1">',
      type: 'editoutput',
    }],
  };
  const report = buildLuaManagementReport({
    originalCard: { description: '<img cmd="utena_nude_fellatio1">' },
    originalModule: module,
  });

  assert.equal(report.regexCount, 1);
  assert.equal(report.regexRules.length, 1);
  assert.equal(report.controlReferenceCount, 1);
  assert.equal(report.regexRules[0]?.pathLabel, '模块.regex.0.in');
  assert.equal(report.regexRules[0]?.fullPattern, '<img cmd="([^\"]+)">');
  assert.equal(report.regexRules[0]?.out, '<img cmd="$1">');
  assert.equal(report.controlReferences[0]?.kind, 'regex');
  assert.equal(report.regexRules[0]?.runtimePostprocess, true);
});

test('Lua management exposes a module namespace for an explicit human decision', () => {
  const report = buildLuaManagementReport({
    originalCard: {},
    originalModule: { namespace: 'mahou_shoujo_ni_akogarete' },
  });

  const namespace = report.segments.find((segment) => segment.pathLabel === '$module.namespace');
  assert.equal(namespace?.sourceText, 'mahou_shoujo_ni_akogarete');
  assert.equal(namespace?.risk, 'high');
  assert.equal(report.namespaceHandling, 'unconfirmed');
  assert.match(report.issues.find((issue) => issue.kind === 'namespace')?.message ?? '', /人工核对命名空间/u);
});

test('Lua management keeps a confirmed internal Mahou Shoujo namespace unchanged', () => {
  const originalModule = {
    namespace: 'mahou_shoujo_ni_akogarete',
    trigger: [{ effect: [{ code: 'return {{module_assetlist::mahou_shoujo_ni_akogarete}}' }] }],
  };
  const report = buildLuaManagementReport({
    originalCard: {},
    originalModule,
    draftModule: structuredClone(originalModule),
    storedSegments: [{
      id: 'module-namespace',
      pathJson: '["$module","namespace"]',
      pathLabel: '$module.namespace',
      kind: 'field',
      sourceText: originalModule.namespace,
      reviewStatus: 'approved',
      finalText: originalModule.namespace,
      translatedText: originalModule.namespace,
    }],
  });

  assert.equal(report.namespaceHandling, 'preserved');
  assert.equal(report.issues.some((issue) => issue.kind === 'namespace' && issue.blocking), false);
});

test('Lua management flags the Mahou Shoujo namespace until a visible-name translation is approved and applied', () => {
  const originalModule = {
    namespace: 'mahou_shoujo_ni_akogarete',
    trigger: [{ effect: [{ code: 'return {{module_assetlist::mahou_shoujo_ni_akogarete}}' }] }],
  };
  const storedNamespace = {
    id: 'module-namespace',
    pathJson: '["namespace"]',
    pathLabel: '$module.namespace',
    kind: 'field',
    sourceText: originalModule.namespace,
    reviewStatus: 'approved',
    finalText: '憧憬魔法少女',
    translatedText: '憧憬魔法少女',
  };

  const untranslated = buildLuaManagementReport({ originalCard: {}, originalModule });
  const untranslatedNamespace = untranslated.issues.find((issue) => issue.kind === 'namespace');
  assert.equal(untranslatedNamespace?.blocking, true);
  assert.match(untranslatedNamespace?.message ?? '', /人工核对命名空间/u);

  const staleDraft = buildLuaManagementReport({
    originalCard: {},
    originalModule,
    draftModule: { ...originalModule },
    storedSegments: [storedNamespace],
  });
  const staleNamespace = staleDraft.issues.find((issue) => issue.kind === 'namespace');
  assert.equal(staleNamespace?.blocking, true);
  assert.match(staleNamespace?.message ?? '', /当前 Lua 草稿仍为/u);

  const staleProtocol = buildLuaManagementReport({
    originalCard: {},
    originalModule,
    draftModule: { ...originalModule, namespace: '憧憬魔法少女' },
    storedSegments: [storedNamespace],
  });
  const staleProtocolIssue = staleProtocol.issues.find((issue) => issue.kind === 'namespace');
  assert.equal(staleProtocolIssue?.blocking, true);
  assert.match(staleProtocolIssue?.message ?? '', /内部协议仍引用旧名称/u);

  const synchronized = buildLuaManagementReport({
    originalCard: {},
    originalModule,
    draftModule: {
      namespace: '憧憬魔法少女',
      trigger: [{ effect: [{ code: 'return {{module_assetlist::憧憬魔法少女}}' }] }],
    },
    storedSegments: [storedNamespace],
  });
  assert.equal(synchronized.issues.some((issue) => issue.kind === 'namespace'), false);
});

test('Lua management reports router repairs from the current draft', () => {
  const originalModule = {
    trigger: [{ effect: [{ code: `
onOutput = async(function(id)
    local _, _completion_text = get_last_message(id)
    if type(_completion_text) ~= 'string' or not _completion_text:find('<!--RISU_COMPLETE:WALP-->', 1, true) then return end
    return true
end)

local function walp_run_main(id)
    local idx, original = get_last_message(id)
    local context = WALP_PIPELINE.build_context(id, original, 'main')
    return walp_commit(id, idx, original, context, 'main')
end
` }] }],
  };
  const repairedDraft = applyPortraitRouterRepairs(originalModule).draft;
  const report = buildLuaManagementReport({ originalCard: {}, originalModule, draftModule: repairedDraft });

  assert.equal(report.routerRepair.detected, false);
  assert.equal(report.steps.find((step) => step.id === 'repair')?.status, 'complete');
});
