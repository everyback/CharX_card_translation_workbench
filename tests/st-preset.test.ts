import test from 'node:test';
import assert from 'node:assert/strict';
import { convertStPreset, isSillyTavernPreset } from '../server/domain/card/st-preset.js';
import { applyApprovedSegments, scanStPreset } from '../server/domain/card/card.js';
import { decodeRisuPreset, encodeRisuPreset } from '../server/domain/card/risup.js';

test('detects a SillyTavern preset', () => {
  assert.equal(isSillyTavernPreset({ name: 'demo', prompts: [{ name: 'System', content: 'Be concise' }] }), true);
  assert.equal(isSillyTavernPreset({ prompt_order: [] }), true);
  assert.equal(isSillyTavernPreset({ instruct_mode: false }), true);
});

test('does not classify a normal character card as a preset', () => {
  assert.equal(isSillyTavernPreset({ spec: 'chara_card_v2', data: { name: 'Mina' } }), false);
  assert.equal(isSillyTavernPreset({ character_version: '2' }), false);
  assert.equal(isSillyTavernPreset(null), false);
  assert.equal(isSillyTavernPreset([]), false);
  assert.equal(isSillyTavernPreset('preset'), false);
});

test('the public entry converts a preset into a RisuAI preset, not a module', () => {
  const source = {
    name: 'demo',
    temperature: 0.7,
    prompts: [
      { identifier: 'main', name: '主提示', content: '主内容', role: 'user' },
      { identifier: 'extra', name: '可选项', content: '可选内容', role: 'user' },
    ],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }, { identifier: 'extra', enabled: false }] }],
  };
  const { preset, report } = convertStPreset(source);
  assert.equal(preset.name, 'demo');
  assert.equal(preset.temperature, 70);
  assert.ok(Array.isArray(preset.promptTemplate), 'must emit a RisuAI promptTemplate');
  assert.equal(report.emitted.length, 2);
  assert.equal(report.toggleKeys.length, 1, 'the disabled prompt becomes a toggle');
  // Regression guard: the old implementation wrapped presets into a risum module.
  assert.equal('module' in preset, false);
  assert.equal('extensions' in preset, false);
});

test('preset scanning ignores runtime keyword fields', () => {
  const source = {
    name: 'demo',
    temperature: 1,
    prompts: [
      { identifier: 'main', name: '主提示', content: '正文内容', role: 'user', system_prompt: true, injection_depth: 4 },
    ],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }],
  };
  const segments = scanStPreset(source, 'all');
  const labels = segments.map((segment) => segment.pathLabel);
  assert.deepEqual(labels.sort(), ['prompts.0.content', 'prompts.0.name', 'name'].sort());
  // These must never be offered for translation: rewriting them breaks the preset.
  for (const field of ['role', 'identifier', 'system_prompt', 'injection_depth', 'temperature', 'character_id', 'enabled']) {
    assert.ok(!labels.some((label) => label.endsWith(`.${field}`)), `${field} must not be scanned`);
  }
});

/**
 * Walks the real workbench pipeline the way the export service does:
 * scan → approve translations → apply to the draft → build the `.risup`.
 */
test('end-to-end: approved translations reach the exported .risup intact', () => {
  const source = {
    name: '演示预设',
    temperature: 0.8,
    prompts: [
      { identifier: 'main', name: '主提示', content: '你是{{char}}。{{setvar::words::1000}}', role: 'user', system_prompt: true },
      { identifier: 'style', name: '🖋️古风', content: '使用古风文风。', role: 'user' },
    ],
    prompt_order: [{
      character_id: 100000,
      order: [{ identifier: 'main', enabled: true }, { identifier: 'style', enabled: false }],
    }],
  };

  const scanned = scanStPreset(source, 'all');
  assert.equal(scanned.length, 5, 'preset name + 2 contents + 2 prompt names');

  const translations = new Map([
    ['["name"]', '演示预设（已译）'],
    ['["prompts",0,"content"]', '你是{{char}}。{{setvar::words::1000}}'],
    ['["prompts",0,"name"]', '主提示（已译）'],
    ['["prompts",1,"content"]', '请使用古风文风。'],
    ['["prompts",1,"name"]', '🖋️古风（已译）'],
  ]);

  const approved = scanned.flatMap((segment) => {
    const translated = translations.get(JSON.stringify(segment.path));
    if (translated === undefined) return [];
    return [{
      pathJson: JSON.stringify(segment.path),
      sourceText: segment.sourceText,
      start: segment.start,
      end: segment.end,
      translatedText: translated,
      finalText: translated,
      reviewStatus: 'approved',
      kind: segment.kind,
    }];
  });
  assert.equal(approved.length, 5, 'every scanned segment has a translation');

  const draft = applyApprovedSegments(source, approved);
  const { preset } = convertStPreset(draft);
  const decoded = decodeRisuPreset(encodeRisuPreset(preset)).preset;
  const template = decoded.promptTemplate as Array<Record<string, unknown>>;

  // 1) Translated text landed in the exported preset.
  const main = template.find((item) => item.type2 === 'main' && typeof item.text === 'string');
  assert.equal(main?.text, '你是{{char}}。{{setvar::words::1000}}');

  // 2) ST macros survived the whole pipeline untouched.
  assert.ok(String(main?.text).includes('{{setvar::words::1000}}'));
  assert.ok(String(main?.text).includes('{{char}}'));

  // 3) The disabled prompt is still gated, and its translated body is inside the gate.
  const gated = template.find((item) => typeof item.text === 'string' && String(item.text).includes('{{#when::'));
  assert.ok(gated, 'the disabled prompt must stay gated');
  assert.ok(String(gated.text).includes('请使用古风文风。'), 'translated body must sit inside the gate');
  assert.match(String(gated.text), /^\{\{#when::\{\{getglobalvar::toggle_[A-Za-z0-9_]+\}\}\}\}\n/u);
  assert.match(String(gated.text), /\n\{\{\/when\}\}$/u);

  // 4) The toggle label uses the translated prompt name, so the switch panel is readable.
  assert.ok(String(decoded.customPromptTemplateToggle).includes('🖋️古风（已译）'));
});
