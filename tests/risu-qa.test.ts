import assert from 'node:assert/strict';
import test from 'node:test';
import { detectRisuRuntimeRisks, validateRisuTemplateChanges } from '../server/domain/risu-qa.js';

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
