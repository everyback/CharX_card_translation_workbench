import assert from 'node:assert/strict';
import test from 'node:test';
import { applyPortraitRouterRepairs, inspectPortraitRouterRepairs } from '../server/domain/portrait-router-repair.js';

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
