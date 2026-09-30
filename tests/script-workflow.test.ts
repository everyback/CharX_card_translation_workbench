import assert from 'node:assert/strict';
import test from 'node:test';
import { scriptChanges } from '../server/domain/lua/script-changes.js';
import { buildLuaManagementReport } from '../server/domain/lua/lua-management.js';
import { diagnosticState } from '../src/pages/workbench/tabs/lua/lib/diagnostic-state.js';
import { validateRisuLuaChanges } from '../server/domain/lua/risu-lua.js';

const wrap = (code: string) => ({ trigger: [{ effect: [{ code }] }] });

test('expanded syntax context supplies editable nearby lines and matching source context', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `local value${index + 1} = ${index + 1}`);
  const changed = [...lines];
  changed[19] = 'local invalid变量 = 1';
  const [issue] = validateRisuLuaChanges(wrap(lines.join('\n')), wrap(changed.join('\n')));
  assert.equal(issue.line, 20);
  assert.ok(issue.contextLines!.length > 11);
  assert.ok(issue.contextLines!.some(row => row.line === 10 && row.draftLine === lines[9]));
  assert.ok(issue.sourceContextLines!.some(row => row.line === 10 && row.text === lines[9]));
});

test('script comparison survives successful syntax repair and covers regex outputs', () => {
  const original = { ...wrap('return "Hello"'), regex: [{ in: '(Hello)', out: '$1' }], description: 'private non-script text' };
  const draft = { ...wrap('return "你好"'), regex: [{ in: '(Hello|你好)', out: '<b>$1</b>' }], description: 'changed non-script text' };
  const report = buildLuaManagementReport({ originalCard: {}, originalModule: original, draftModule: draft });
  assert.equal(report.syntaxStatus, 'passed');
  assert.equal(report.issues.some(issue => issue.kind === 'syntax'), false);
  assert.equal(report.scriptChanges.length, 3);
  assert.equal(report.scriptChanges[0].before, 'return "Hello"');
  assert.equal(report.scriptChanges[0].after, 'return "你好"');
  assert.equal(report.scriptChanges.some(change => change.pathLabel.includes('description')), false);
  assert.equal(JSON.stringify(original).includes('你好'), false);
});

test('script comparison represents additions, removals, plain card regex and exact long lines', () => {
  const long = 'x'.repeat(20000);
  assert.deepEqual(scriptChanges({}, wrap(long), '$module'), [{ pathLabel: '$module.trigger.0.effect.0.code', before: '', after: long }]);
  assert.equal(scriptChanges(wrap(long), {}, '$module')[0].before, long);
  assert.equal(scriptChanges({ customscript: [{ in: 'a', out: 'b' }] }, { customscript: [{ in: 'a', out: 'c' }] }, '卡片')[0].after, 'c');
  assert.deepEqual(scriptChanges(wrap(long), wrap(long), '$module'), []);
  assert.deepEqual(scriptChanges(wrap(long), null, '$module'), []);
});

test('no errors before draft validation is pending rather than passed', () => {
  const report = buildLuaManagementReport({ originalCard: {}, originalModule: wrap('return 1') });
  assert.equal(report.syntaxStatus, 'pending');
  assert.equal(diagnosticState(report).syntax, '待校验');
  assert.equal(diagnosticState(report).syntaxPassed, false);
  assert.equal(diagnosticState(report).export, '保存审核稿后回验');
  const withoutModule = buildLuaManagementReport({ originalCard: {} });
  assert.equal(diagnosticState(withoutModule).syntax, '不适用');
});

test('syntax failure and review readiness remain distinct', () => {
  const originalModule = wrap('return "hello"');
  const failed = buildLuaManagementReport({ originalCard: {}, originalModule, draftModule: wrap('return "') });
  assert.equal(failed.syntaxStatus, 'failed');
  assert.equal(diagnosticState(failed).syntaxPassed, false);
  const passed = buildLuaManagementReport({ originalCard: {}, originalModule, draftModule: originalModule, projectStatus: 'review' });
  assert.equal(diagnosticState(passed).syntax, '语法通过');
  assert.equal(diagnosticState(passed).export, '保存审核稿后回验');
});
