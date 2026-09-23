import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeStPreset,
  convertStPreset,
  normalizeStRole,
} from '../server/domain/card/st-preset-convert.js';

/**
 * Mirrors the shape of real presets: a small generic order block, a larger
 * content block that references a superset of it, disabled library entries, and
 * prompts no order block references at all.
 */
const PRESET: Record<string, unknown> = {
  name: '测试预设',
  temperature: 1,
  frequency_penalty: 0,
  presence_penalty: 0.5,
  top_p: 0.95,
  top_k: 40,
  openai_max_context: 200000,
  openai_max_tokens: 4096,
  wi_format: '{0}',
  names_behavior: 0,
  assistant_prefill: '继续。',
  prompts: [
    { identifier: 'main', name: '主提示', content: '主内容', role: 'user', system_prompt: true },
    { identifier: 'jailbreak', name: '🛡️ 变量', content: '越狱内容', role: 'user', system_prompt: true },
    { identifier: 'nsfw', name: '📘 字数', content: '字数设置', role: 'system' },
    { identifier: 'worldInfoBefore', name: 'World Info (before)', content: '', role: 'system', marker: true },
    { identifier: 'worldInfoAfter', name: 'World Info (after)', content: '', role: 'system', marker: true },
    { identifier: 'charDescription', name: 'Char Description', content: '', role: 'system', marker: true },
    { identifier: 'personaDescription', name: 'Persona Description', content: '', role: 'system', marker: true },
    { identifier: 'scenario', name: 'Scenario', content: '', role: 'system', marker: true },
    { identifier: 'chatHistory', name: 'Chat History', content: '', role: 'system', marker: true },
    { identifier: 'dialogueExamples', name: 'Chat Examples', content: '', role: 'system', marker: true },
    { identifier: 'style-a', name: '🖋️轻小说（幽默）', content: '幽默风格', role: 'user' },
    { identifier: 'style-b', name: '🖋️古风', content: '古风风格', role: 'user' },
    { identifier: 'lib-a', name: '🌸色情描写', content: '可选库内容', role: 'user' },
    { identifier: 'lib-b', name: '🛡️强破限', content: '预填充内容', role: 'model' },
  ],
  prompt_order: [
    {
      character_id: 100000,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'worldInfoBefore', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'worldInfoAfter', enabled: true },
        { identifier: 'scenario', enabled: true },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'dialogueExamples', enabled: true },
        { identifier: 'jailbreak', enabled: true },
      ],
    },
    {
      character_id: 100001,
      order: [
        { identifier: 'jailbreak', enabled: true },
        { identifier: 'nsfw', enabled: true },
        { identifier: 'style-a', enabled: true },
        { identifier: 'style-b', enabled: false },
        { identifier: 'main', enabled: false },
        { identifier: 'chatHistory', enabled: true },
        { identifier: 'worldInfoBefore', enabled: true },
        { identifier: 'charDescription', enabled: true },
        { identifier: 'personaDescription', enabled: true },
        { identifier: 'scenario', enabled: true },
        { identifier: 'dialogueExamples', enabled: true },
        { identifier: 'worldInfoAfter', enabled: true },
      ],
    },
  ],
};

test('analysis recommends the order block that covers the others', () => {
  const analysis = analyzeStPreset(PRESET);
  assert.equal(analysis.blocks.length, 2);
  assert.equal(analysis.recommendedBlockIndex, 1);
  assert.equal(analysis.promptCount, 14);
  assert.equal(analysis.orphanCount, 2, 'lib-a and lib-b are unreferenced');
  assert.deepEqual(analysis.foreignRoles, []);
  assert.ok(analysis.roleCounts.model === 1);
});

test('conversion preserves the selected block order exactly', () => {
  const { report } = convertStPreset(PRESET);
  assert.equal(report.blockIndex, 1);
  assert.equal(report.blockCharacterId, 100001);
  assert.deepEqual(
    report.emitted.slice(0, 4).map((item) => [item.identifier, item.type, item.gated]),
    [
      ['jailbreak', 'plain', false],
      ['nsfw', 'plain', false],
      ['style-a', 'plain', false],
      ['style-b', 'plain', true],
    ],
  );
});

test('every prompt reaches a destination: emitted, dropped with a reason, or degraded', () => {
  const { report } = convertStPreset(PRESET);
  const accounted = new Set([
    ...report.emitted.map((item) => item.identifier),
    ...report.dropped.map((item) => item.identifier),
    ...report.covered.map((item) => item.identifier),
    ...report.archived.map((item) => item.identifier),
  ]);
  for (const prompt of PRESET.prompts as Array<{ identifier: string }>) {
    assert.ok(accounted.has(prompt.identifier), `${prompt.identifier} was silently lost`);
  }
  // A prompt that produces no RisuAI item must land in `dropped`, never only in `degraded`.
  for (const item of report.dropped) assert.ok(item.reason.trim().length > 0, `${item.identifier} has no reason`);
  assert.deepEqual(
    report.covered.map((item) => item.identifier).sort(),
    ['dialogueExamples', 'scenario', 'worldInfoAfter'],
  );
});

test('disabled and unreferenced prompts become default-off toggles', () => {
  const { preset, report } = convertStPreset(PRESET);
  // style-b (disabled in block) + main (disabled in block) + lib-a + lib-b (orphans)
  assert.equal(report.toggleKeys.length, 4);
  const declarations = String(preset.customPromptTemplateToggle).split('\n');
  assert.equal(declarations.length, 4);
  for (const line of declarations) assert.match(line, /^[A-Za-z0-9_]+=.+/u);
  // The declaration keys must match the macro names embedded in the prompt text.
  const template = preset.promptTemplate as Array<Record<string, unknown>>;
  const gatedKeys = template
    .filter((item) => typeof item.text === 'string' && String(item.text).includes('{{#when::'))
    .map((item) => /\{\{#when::\{\{getglobalvar::toggle_([A-Za-z0-9_]+)\}\}\}\}/u.exec(String(item.text))?.[1]);
  assert.equal(gatedKeys.length, 4);
  for (const key of gatedKeys) {
    assert.ok(key && report.toggleKeys.includes(key), `toggle ${key} has no declaration`);
  }
});

test('toggle gating uses the RisuAI block syntax that resolves inner macros first', () => {
  const { preset } = convertStPreset(PRESET);
  const template = preset.promptTemplate as Array<Record<string, unknown>>;
  const gated = template.find((item) => typeof item.text === 'string' && String(item.text).includes('{{#when::'));
  assert.ok(gated, 'expected at least one gated prompt');
  assert.match(String(gated.text), /^\{\{#when::\{\{getglobalvar::toggle_[A-Za-z0-9_]+\}\}\}\}\n/u);
  assert.match(String(gated.text), /\n\{\{\/when\}\}$/u);
});

test('enabled prompts are emitted verbatim without gating', () => {
  const { preset } = convertStPreset(PRESET);
  const template = preset.promptTemplate as Array<Record<string, unknown>>;
  const nsfw = template.find((item) => item.text === '字数设置');
  assert.deepEqual(nsfw, { type: 'plain', type2: 'normal', text: '字数设置', role: 'system' });
});

/**
 * RisuAI skips every `type: 'jailbreak'` template entry while `db.jailbreakToggle`
 * is false, which is its default (`storage/database.svelte.ts`). ST presets keep
 * critical content — often variable definitions referenced elsewhere — in their
 * `jailbreak` slot, so emitting that type would silently drop it.
 */
test('no emitted entry uses the toggle-gated jailbreak type', () => {
  const { preset, report } = convertStPreset(PRESET);
  const template = preset.promptTemplate as Array<Record<string, unknown>>;
  assert.equal(
    template.filter((item) => item.type === 'jailbreak').length,
    0,
    'a jailbreak-typed entry would be dropped by default and lose its content',
  );
  assert.deepEqual(
    report.promotedToAlwaysOn.map((item) => item.identifier).sort(),
    ['jailbreak', 'nsfw'],
  );
  assert.ok(report.warnings.some((warning) => warning.includes('常驻')));
});

test('variables defined in ST jailbreak entries survive as always-sent prompts', () => {
  const source = {
    name: '变量预设',
    prompts: [
      { identifier: 'jailbreak', name: '🛡️ 变量', content: '{{setvar::JailbreakPrompt::You are helpful}}', role: 'user' },
      { identifier: 'core', name: '核心', content: '{{trim}}{{getvar::JailbreakPrompt}}', role: 'user' },
    ],
    prompt_order: [{
      character_id: 1,
      order: [{ identifier: 'jailbreak', enabled: true }, { identifier: 'core', enabled: true }],
    }],
  };
  const { preset } = convertStPreset(source, { compileVariables: false });
  const template = preset.promptTemplate as Array<Record<string, unknown>>;
  for (const item of template) {
    assert.notEqual(item.type, 'jailbreak', 'variable definitions must never be toggle-gated');
  }
  assert.ok(template.some((item) => String(item.text).includes('{{setvar::JailbreakPrompt::')));
  assert.ok(template.some((item) => String(item.text).includes('{{getvar::JailbreakPrompt}}')));
});

test('ST role=model maps to bot, not RisuAI default of system', () => {
  assert.deepEqual(normalizeStRole('model', false), { role: 'bot', remapped: true });
  assert.deepEqual(normalizeStRole('assistant', false), { role: 'bot', remapped: true });
  assert.deepEqual(normalizeStRole('user', false), { role: 'user', remapped: false });
  const { report } = convertStPreset(PRESET);
  assert.ok(report.roleRemaps.some((item) => item.identifier === 'lib-b' && item.from === 'model' && item.to === 'bot'));
});

test('marker prompts map onto RisuAI built-in prompt item types', () => {
  const { preset } = convertStPreset(PRESET);
  const template = preset.promptTemplate as Array<Record<string, unknown>>;
  const types = template.map((item) => item.type);
  assert.ok(types.includes('chat'));
  assert.ok(types.includes('lorebook'));
  assert.ok(types.includes('description'));
  assert.ok(types.includes('persona'));
});

test('samplers map with RisuAI conventions', () => {
  const { preset } = convertStPreset(PRESET);
  assert.equal(preset.temperature, 100);
  assert.equal(preset.frequencyPenalty, 0);
  assert.equal(preset.PresensePenalty, 35, '0.5 * 0.7 * 100, matching RisuAI importer');
  assert.equal(preset.top_p, 0.95);
  assert.equal(preset.top_k, 40);
  assert.equal(preset.maxContext, 200000);
  assert.equal(preset.maxResponse, 4096);
});

test('fields RisuAI cannot represent are reported rather than dropped quietly', () => {
  const { report } = convertStPreset(PRESET);
  assert.ok(report.unmappedFields.includes('wi_format'));
  assert.ok(report.unmappedFields.includes('names_behavior'));
  assert.ok(report.warnings.some((warning) => warning.includes('尚未映射')));
});

test('assistant_prefill is emitted the same way RisuAI itself does it', () => {
  const { preset } = convertStPreset(PRESET);
  const template = preset.promptTemplate as Array<Record<string, unknown>>;
  const tail = template.slice(-2);
  assert.deepEqual(tail[0], { type: 'postEverything' });
  assert.equal(tail[1]?.role, 'bot');
  assert.equal(tail[1]?.text, '{{#if {{prefill_supported}}}}继续。{{/if}}');
});

test('selecting the other block changes the emitted order', () => {
  const { report } = convertStPreset(PRESET, { blockIndex: 0 });
  assert.equal(report.blockCharacterId, 100000);
  assert.deepEqual(
    report.emitted.slice(0, 2).map((item) => item.identifier),
    ['main', 'worldInfoBefore'],
  );
});

test('optional prompts can be dropped instead of turned into toggles', () => {
  const { preset, report } = convertStPreset(PRESET, { preserveOptionalPrompts: false });
  assert.equal(report.toggleKeys.length, 0);
  assert.equal(preset.customPromptTemplateToggle, '');
  const template = preset.promptTemplate as Array<Record<string, unknown>>;
  assert.ok(!template.some((item) => typeof item.text === 'string' && String(item.text).includes('{{#when::')));
});

const REGEX_PRESET: Record<string, unknown> = {
  name: '正则预设',
  prompts: [{ identifier: 'main', name: '主提示', content: '正文', role: 'user' }],
  prompt_order: [{ character_id: 1, order: [{ identifier: 'main', enabled: true }] }],
  extensions: {
    regex_scripts: [
      { scriptName: '输入包裹', findRegex: '/^([\\s\\S]*)$/', replaceString: '<in>\n$1\n</in>', placement: [1], disabled: false },
      { scriptName: '输出清理', findRegex: '/<tag>[\\s\\S]*?<\\/tag>/gs', replaceString: '', placement: [2], disabled: false },
      { scriptName: '双向', findRegex: '/abc/', replaceString: 'xyz', placement: [1, 2], disabled: false },
      { scriptName: '已禁用', findRegex: '/nope/', replaceString: '', placement: [2], disabled: true },
      { scriptName: '世界书阶段', findRegex: '/wi/', replaceString: '', placement: [4], disabled: false },
    ],
  },
};

test('ST regex scripts map onto RisuAI preset regex rules', () => {
  const { preset, report } = convertStPreset(REGEX_PRESET);
  const rules = preset.regex as Array<Record<string, unknown>>;
  // 1 input + 1 output + (双向 expands to input AND output) = 4 rules
  assert.equal(rules.length, 4);
  assert.deepEqual(report.regexConverted.map((item) => item.mode).sort(), ['editinput', 'editinput', 'editoutput', 'editoutput']);
  for (const rule of rules) {
    assert.equal(typeof rule.comment, 'string');
    assert.equal(typeof rule.in, 'string');
    assert.equal(typeof rule.out, 'string');
    assert.ok(['editinput', 'editoutput'].includes(String(rule.type)), 'type must be a RisuAI ScriptMode');
  }
});

test('ST regex pattern and flags are split the way RisuAI stores them', () => {
  const { preset } = convertStPreset(REGEX_PRESET);
  const rules = preset.regex as Array<Record<string, unknown>>;
  const cleanup = rules.find((rule) => rule.comment === '输出清理');
  assert.equal(cleanup?.in, '<tag>[\\s\\S]*?<\\/tag>', 'slashes must be stripped');
  assert.equal(cleanup?.flag, 'gs');
  assert.equal(cleanup?.ableFlag, true);
  const wrapper = rules.find((rule) => rule.comment === '输入包裹');
  assert.equal(wrapper?.in, '^([\\s\\S]*)$');
  assert.equal(wrapper?.flag, 'd<no_end_nl>', 'no flags must not inherit Risu global replacement or trailing newline');
});

test('a rule placed on both input and output becomes two RisuAI rules', () => {
  const { preset } = convertStPreset(REGEX_PRESET);
  const rules = preset.regex as Array<Record<string, unknown>>;
  assert.deepEqual(
    rules.filter((rule) => rule.comment === '双向').map((rule) => rule.type).sort(),
    ['editinput', 'editoutput'],
  );
});

test('disabled and unsupported-placement regex scripts are reported, never silently activated', () => {
  const { preset, report } = convertStPreset(REGEX_PRESET);
  const rules = preset.regex as Array<Record<string, unknown>>;
  // A disabled ST rule must NOT appear: RisuAI regex has no enable switch, so
  // emitting it would turn an inactive rule on.
  assert.ok(!rules.some((rule) => rule.comment === '已禁用'));
  assert.ok(!rules.some((rule) => rule.comment === '世界书阶段'));
  assert.deepEqual(report.regexSkipped.map((item) => item.name).sort(), ['世界书阶段', '已禁用']);
  for (const item of report.regexSkipped) assert.ok(item.reason.trim().length > 0);
});

test('a preset without regex scripts emits no regex array', () => {
  const { preset, report } = convertStPreset(PRESET);
  assert.equal(preset.regex, undefined);
  assert.equal(report.regexConverted.length, 0);
  assert.equal(report.regexSkipped.length, 0);
});
