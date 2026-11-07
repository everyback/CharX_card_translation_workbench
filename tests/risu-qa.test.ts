import assert from 'node:assert/strict';
import test from 'node:test';
import { detectRisuRuntimeRisks, validateRisuTemplateChanges } from '../server/domain/lua/risu-qa.js';

test('import diagnostics flag static Risu actions without a Lua callback', () => {
  const module = {
    regex: [{ out: '<button risu-trigger="Scene_Start">Start</button><button risu-trigger="Scene_开始">开始</button>' }],
    trigger: [{ effect: [{ code: 'function Scene_Start(id) return id end' }] }],
  };
  const risks = detectRisuRuntimeRisks(module);
  assert.equal(risks.some((risk) => risk.pathLabel === '模块.regex.0.out' && risk.message.includes('Scene_开始')), true);
  assert.equal(risks.some((risk) => risk.message.includes('Scene_Start')), false);
});

test('import diagnostics also flag static actions when no Lua callbacks exist', () => {
  const module = { regex: [{ out: '<button risu-trigger="Scene_Start">Start</button>' }] };
  assert.equal(detectRisuRuntimeRisks(module).some((risk) => risk.message.includes('Scene_Start')), true);
});

test('static callback diagnostics recognize global table registrations', () => {
  const module = {
    regex: [{ out: '<button risu-trigger="Panel77_Open">Open</button>' }],
    trigger: [{ effect: [{ code: '_G["Panel77_Open"] = async(function(id) return id end)' }] }],
  };
  assert.deepEqual(detectRisuRuntimeRisks(module), []);
});

test('static callback diagnostics recognize Lua action dispatch comparisons', () => {
  const module = {
    regex: [{ out: '<button risu-trigger="Panel77_Open">Open</button>' }],
    trigger: [{ effect: [{ code: 'if manualName == "Panel77_Open" then return openPanel(id) end' }] }],
  };
  assert.deepEqual(detectRisuRuntimeRisks(module), []);
});

test('Risu template QA catches newly malformed CSS values', () => {
  const original = {
    trigger: [{ effect: [{ code: 'local html = [[<div style="width: ]] .. value .. [[%;">ok</div>]]' }] }],
  };
  const draft = {
    trigger: [{ effect: [{ code: 'local html = [[<div style="width: ]] .. value .. [[%);">ok</div>]]' }] }],
  };
  const issues = validateRisuTemplateChanges(original, draft);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /width/);
});

test('Risu template QA allows balanced CSS functions', () => {
  const original = {
    trigger: [{ effect: [{ code: 'local html = [[<div style="width: calc(100% - 2px);">ok</div>]]' }] }],
  };
  const draft = structuredClone(original);
  assert.deepEqual(validateRisuTemplateChanges(original, draft), []);
});

test('Risu runtime QA warns about null list state handling', () => {
  const module = {
    trigger: [{ effect: [{ code: 'local ids = getChatVar(triggerId, "prisoner_list") or ""' }] }],
  };
  const risks = detectRisuRuntimeRisks(module);
  assert.equal(risks.length, 1);
  assert.match(risks[0].message, /null/);
});
