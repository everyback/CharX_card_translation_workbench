import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPortraitRouterChangeOverrides, applyPortraitRouterRepairs, applyPortraitRouterReviewDelta, inspectPortraitRouterRepairs } from '../server/domain/portrait-router-repair.js';

const vulnerableRouter = `
onOutput = async(function(id)
    local _, _completion_text = get_last_message(id)
    if type(_completion_text) ~= 'string' or not _completion_text:find('<!--RISU_COMPLETE:WALP-->', 1, true) then return end
    return true
end)

local function walp_run_main(id)
    local idx, original = get_last_message(id)
    local snapshot_length = tonumber(getChatLength(id)) or 0
    if not idx or original == '' then return false end
    local context = WALP_PIPELINE.build_context(id, original, 'main')
    context.snapshot_length = snapshot_length
    return walp_commit(id, idx, original, context, 'main', walp_main_candidates(id, context))
end
`;

test('detects and repairs exact cross-card portrait router blockers', () => {
  const module = { trigger: [{ effect: [{ code: vulnerableRouter }] }] };
  const report = inspectPortraitRouterRepairs(module);
  assert.equal(report.canApply, true);
  assert.deepEqual(report.findings.map((item) => item.id), ['completion-marker-gate', 'main-passthrough']);

  const result = applyPortraitRouterRepairs(module);
  const code = String((result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code);
  assert.equal(result.applied.length, 2);
  assert.match(code, /_completion_text:match\('\^%s\*\$'\)/u);
  assert.doesNotMatch(code, /RISU_COMPLETE:WALP/u);
  assert.match(code, /local function walp_run_main\(id\)[\s\S]*return true\nend/u);
  assert.doesNotMatch(code, /walp_commit\(id, idx, original, context, 'main'/u);
  assert.equal(inspectPortraitRouterRepairs(result.draft).detected, false);
});

test('does not modify unrelated Lua output handlers', () => {
  const module = { trigger: [{ effect: [{ code: "onOutput = async(function(id) return 'ok' end)" }] }] };
  const result = applyPortraitRouterRepairs(module);
  assert.equal(result.applied.length, 0);
  assert.deepEqual(result.draft, module);
});

test('detects main routers whose context builder has a snapshot argument', () => {
  const module = { trigger: [{ effect: [{ code: `
local function thv2_run_main(id)
    local idx, original, snapshot_length = get_last_message(id)
    if not idx or original == '' then return false end
    local context = THV2_PIPELINE.build_context(id, original, 'main', snapshot_length)
    return thv2_commit(id, idx, original, context, 'main', thv2_main_candidates(id, context))
end
` }] }] };
  const report = inspectPortraitRouterRepairs(module);
  assert.deepEqual(report.findings.map((item) => item.id), ['main-passthrough']);
});

test('applies only reviewed router edits from the preview result', () => {
  const module = { trigger: [{ effect: [{ code: vulnerableRouter }] }] };
  const preview = applyPortraitRouterRepairs(module);
  const mainChange = preview.changes.find((change) => change.id === 'main-passthrough');
  assert.ok(mainChange);
  const edited = applyPortraitRouterChangeOverrides(
    module,
    [{ ...mainChange, after: `${mainChange.after}\n-- reviewed` }],
    preview.changes,
  );
  const code = String((edited.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code);
  assert.match(code, /-- reviewed$/u);
  assert.throws(() => applyPortraitRouterChangeOverrides(
    module,
    [{ ...mainChange, before: `${mainChange.before}\nchanged` }],
    preview.changes,
  ), /原代码已变化/u);
});

test('replays consecutive repairs from the original source without stale-preview errors', () => {
  const module = { trigger: [{ effect: [{ code: vulnerableRouter }] }] };
  const preview = applyPortraitRouterRepairs(module);
  const repaired = applyPortraitRouterChangeOverrides(module, [], preview.changes);
  const code = String((repaired.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code);
  assert.match(code, /_completion_text:match\('\^%s\*\$'\)/u);
  assert.match(code, /local function walp_run_main\(id\)[\s\S]*return true\nend/u);
});

test('preserves an earlier reviewed edit when a later repair shares the same path', () => {
  const module = { trigger: [{ effect: [{ code: vulnerableRouter }] }] };
  const preview = applyPortraitRouterRepairs(module);
  const gateChange = preview.changes.find((change) => change.id === 'completion-marker-gate');
  const mainChange = preview.changes.find((change) => change.id === 'main-passthrough');
  assert.ok(gateChange);
  assert.ok(mainChange);
  const editedGate = `${gateChange.after}\n-- reviewed`;
  const repaired = applyPortraitRouterChangeOverrides(module, [
    { ...gateChange, after: editedGate },
    { ...mainChange },
  ], preview.changes);
  const code = String((repaired.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code);
  assert.match(code, /-- reviewed/u);
  assert.match(code, /local function walp_run_main\(id\)[\s\S]*return true\nend/u);
});

test('transfers a reviewed local edit to a translated module without replacing its surrounding code', () => {
  const source = 'prefix\nold\nsuffix';
  const target = 'prefix\nold\ntranslated-suffix';
  assert.equal(applyPortraitRouterReviewDelta(target, source, 'prefix\nnew\nsuffix', '模块.trigger.0.effect.0.code'), 'prefix\nnew\ntranslated-suffix');
});
