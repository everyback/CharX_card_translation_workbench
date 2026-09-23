import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzePresetEditImpact,
  buildPresetProjectView,
  indexSetvars,
  isEditablePresetPath,
  readPresetPath,
  validateEditedText,
  writePresetPath,
} from '../server/domain/card/st-preset-edit.js';
import { convertStPreset } from '../server/domain/card/st-preset-convert.js';

function preset(prompts: Array<Record<string, unknown>>, order?: Array<{ identifier: string; enabled: boolean }>) {
  return {
    name: '测试预设',
    prompts: prompts.map((prompt, index) => ({
      identifier: `p${index}`,
      name: `提示词 ${index}`,
      role: 'user',
      ...prompt,
    })),
    prompt_order: [{
      character_id: 1,
      order: order ?? prompts.map((_, index) => ({ identifier: `p${index}`, enabled: true })),
    }],
  };
}

test('only copy fields are editable', () => {
  assert.equal(isEditablePresetPath(['name']), true);
  assert.equal(isEditablePresetPath(['prompts', 3, 'content']), true);
  assert.equal(isEditablePresetPath(['prompts', 3, 'name']), true);
  for (const path of [
    ['prompts', 3, 'role'],
    ['prompts', 3, 'identifier'],
    ['prompts', 3, 'enabled'],
    ['prompt_order', 0, 'order', 2, 'enabled'],
    ['temperature'],
    ['extensions', 'regex_scripts', 0, 'replaceString'],
    ['prompts', -1, 'content'],
    ['prompts', 1.5, 'content'],
    ['prompts', '0', 'content'],
  ]) {
    assert.equal(isEditablePresetPath(path as never), false, `${JSON.stringify(path)} must not be editable`);
  }
});

test('writePresetPath clones and rejects structural paths', () => {
  const source = preset([{ content: '原文' }, { content: '第二' }]);
  const updated = writePresetPath(source, ['prompts', 1, 'content'], '改过');
  assert.equal(readPresetPath(updated, ['prompts', 1, 'content']), '改过');
  // The original must not be mutated: it is the fallback for "restore".
  assert.equal(readPresetPath(source, ['prompts', 1, 'content']), '第二');
  assert.throws(() => writePresetPath(source, ['prompts', 1, 'role'], 'user'), /只允许编辑/u);
  assert.throws(() => writePresetPath(source, ['prompts', 9, 'content'], 'x'), /没有该路径/u);
});

test('indexSetvars reports gating per definition site', () => {
  const converted = convertStPreset(preset([
    { content: '{{setvar::always::值}}' },
    { content: '{{setvar::gated::值}}' },
  ], [
    { identifier: 'p0', enabled: true },
    { identifier: 'p1', enabled: false },
  ])).preset;
  const { definitions } = indexSetvars(converted);
  assert.deepEqual(definitions.get('always')?.map((site) => site.gated), [false]);
  assert.deepEqual(definitions.get('gated')?.map((site) => site.gated), [true]);
});

/* ---------------------------------------------- the four confirmation branches */

test('branch 1: keeping another always-on definition is silent', () => {
  const before = preset([{ content: '{{setvar::x::a}}' }, { content: '{{setvar::x::b}}' }, { content: '{{getvar::x}}' }]);
  const after = writePresetPath(before, ['prompts', 0, 'content'], '删掉了定义');
  const impact = analyzePresetEditImpact(before, after);
  assert.deepEqual(impact.blocking, []);
  assert.deepEqual(impact.noted, []);
  assert.deepEqual(impact.safe.map((item) => item.name), ['x']);
});

test('branch 2: losing the last always-on definition while referenced must be confirmed', () => {
  const before = preset([{ content: '{{setvar::JailbreakPrompt::内容}}' }, { content: '{{trim}}{{getvar::JailbreakPrompt}}' }]);
  const after = writePresetPath(before, ['prompts', 0, 'content'], '没有定义了');
  const impact = analyzePresetEditImpact(before, after);
  assert.deepEqual(impact.blocking.map((item) => item.name), ['JailbreakPrompt']);
  assert.equal(impact.blocking[0]?.stillAlwaysOn, false);
  assert.equal(impact.blocking[0]?.references.length, 1, 'must point at the prompt that goes empty');
});

test('branch 3: losing the last definition with no readers is informational only', () => {
  const before = preset([{ content: '{{setvar::unused::内容}}' }, { content: '普通内容' }]);
  const after = writePresetPath(before, ['prompts', 0, 'content'], '没有定义了');
  const impact = analyzePresetEditImpact(before, after);
  assert.deepEqual(impact.blocking, []);
  assert.deepEqual(impact.noted.map((item) => item.name), ['unused']);
});

test('branch 4: a definition that only ever lived inside a gate is not a new loss', () => {
  const before = preset([
    { content: '{{setvar::onlyGated::值}}' },
    { content: '{{getvar::onlyGated}}' },
  ], [
    { identifier: 'p0', enabled: false },
    { identifier: 'p1', enabled: true },
  ]);
  const after = writePresetPath(before, ['prompts', 0, 'content'], '删掉了');
  const impact = analyzePresetEditImpact(before, after);
  assert.deepEqual(impact.blocking, [], 'it was already conditional before the edit');
  assert.deepEqual(impact.noted, []);
});

test('a remaining definition inside a gate does NOT count as still defined', () => {
  // This is the trap: "defined twice" looks safe, but the surviving definition
  // sits in a default-off prompt, so the variable still resolves to empty.
  const before = preset([
    { content: '{{setvar::x::常驻}}' },
    { content: '{{setvar::x::门控}}' },
    { content: '{{getvar::x}}' },
  ], [
    { identifier: 'p0', enabled: true },
    { identifier: 'p1', enabled: false },
    { identifier: 'p2', enabled: true },
  ]);
  const after = writePresetPath(before, ['prompts', 0, 'content'], '删掉了常驻定义');
  const impact = analyzePresetEditImpact(before, after);
  assert.deepEqual(impact.blocking.map((item) => item.name), ['x'], 'the gated survivor must not mask the loss');
  assert.deepEqual(impact.safe, []);
});

test('clearing a prompt body entirely is detected as a definition loss', () => {
  const before = preset([{ content: '{{setvar::x::值}}' }, { content: '{{getvar::x}}' }]);
  const after = writePresetPath(before, ['prompts', 0, 'content'], '');
  const impact = analyzePresetEditImpact(before, after);
  // An empty body makes the converter drop the prompt altogether, so the
  // definition disappears and the reader goes empty.
  assert.deepEqual(impact.blocking.map((item) => item.name), ['x']);
});

test('editing a value rather than removing a definition is silent', () => {
  const before = preset([{ content: '{{setvar::x::旧值}}' }, { content: '{{getvar::x}}' }]);
  const after = writePresetPath(before, ['prompts', 0, 'content'], '{{setvar::x::新值}}');
  const impact = analyzePresetEditImpact(before, after);
  assert.deepEqual(impact.blocking, []);
  assert.deepEqual(impact.safe.map((item) => item.name), ['x']);
});

/* ------------------------------------------------------------ structural checks */

test('validateEditedText flags unbalanced gates', () => {
  assert.deepEqual(validateEditedText('{{setvar::x::1}}'), []);
  assert.match(validateEditedText('{{#when::1}}\n内容\n{{/when}}').join(), /^$/u);
  assert.match(validateEditedText('{{#when::1}}\n内容').join(), /不配对/u);
});

test('validateEditedText flags a gate on an undeclared switch', () => {
  const body = '{{#when::{{getglobalvar::toggle_st_7}}}}\n内容\n{{/when}}';
  assert.deepEqual(validateEditedText(body, ['st_7']), []);
  assert.match(validateEditedText(body, ['st_9']).join(), /未声明的开关 toggle_st_7/u);
});

/* --------------------------------------------------------------- project view */

test('project view lists block prompts then orphans, with conversion state', () => {
  const source = preset([
    { content: '常驻内容' },
    { content: '门控内容' },
    { content: '孤儿内容' },
    { content: '' },
  ], [
    { identifier: 'p0', enabled: true },
    { identifier: 'p1', enabled: false },
  ]);
  const view = buildPresetProjectView(source, source, null);
  assert.equal(view.effectiveBlockIndex, 0);
  const byId = new Map(view.prompts.map((item) => [item.identifier, item]));
  assert.equal(byId.get('p0')?.state, 'always');
  assert.equal(byId.get('p1')?.state, 'gated');
  assert.equal(byId.get('p1')?.enabled, false);
  assert.equal(byId.get('p2')?.state, 'gated', 'unreferenced prompts become default-off switches');
  assert.equal(byId.get('p2')?.source, 'orphan');
  assert.equal(byId.get('p2')?.enabled, false);
  assert.equal(byId.get('p3')?.state, 'dropped');
  assert.ok(byId.get('p3')?.dropReason);
  assert.equal(view.editedCount, 0);
});

test('project view marks edited prompts and counts them', () => {
  const source = preset([{ content: '原文' }, { content: '第二' }]);
  const draft = writePresetPath(source, ['prompts', 0, 'content'], '改过');
  const view = buildPresetProjectView(source, draft, null);
  assert.equal(view.editedCount, 1);
  assert.equal(view.prompts.find((item) => item.identifier === 'p0')?.edited, true);
  assert.equal(view.prompts.find((item) => item.identifier === 'p1')?.edited, false);
});

test('project view recomputes conversion for the selected block', () => {
  const source = {
    name: '双块',
    prompts: [
      { identifier: 'a', name: 'A', content: '内容 A', role: 'user' },
      { identifier: 'b', name: 'B', content: '内容 B', role: 'user' },
    ],
    prompt_order: [
      { character_id: 100000, order: [{ identifier: 'a', enabled: true }] },
      { character_id: 100001, order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: true }] },
    ],
  };
  const automatic = buildPresetProjectView(source, source, null);
  assert.equal(automatic.effectiveBlockIndex, 1);
  const explicit = buildPresetProjectView(source, source, 0);
  assert.equal(explicit.effectiveBlockIndex, 0);
  assert.equal(explicit.blockIndex, 0);
});
