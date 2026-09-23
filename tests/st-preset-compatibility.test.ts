import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { unzipSync, strFromU8 } from 'fflate';
import { convertStPreset, presetControlNamespace } from '../server/domain/card/st-preset-convert.js';
import { buildPresetProjectView } from '../server/domain/card/st-preset-edit.js';
import { buildStPresetArtifacts, encodeStPresetBundle } from '../server/domain/card/st-preset-artifacts.js';
import { decodeRisuPreset } from '../server/domain/card/risup.js';

function fixture(contents = ['正文', '可选正文']) {
  return {
    name: '兼容性 fixture',
    prompts: contents.map((content, index) => ({ identifier: `p${index}`, name: `条目 ${index}`, content, role: 'system' })),
    prompt_order: [{ order: contents.map((_, index) => ({ identifier: `p${index}`, enabled: index === 0 })) }],
  };
}

test('disabled optional content is archived instead of becoming active when switches are omitted', () => {
  const { preset, report } = convertStPreset(fixture(), { preserveOptionalPrompts: false });
  assert.equal(report.emitted.length, 1);
  assert.equal(report.archived[0].identifier, 'p1');
  assert.ok(!JSON.stringify(preset).includes('可选正文'));
});

test('native composite slots cover examples without a second full history', () => {
  const identifiers = ['dialogueExamples', 'scenario', 'charPersonality', 'chatHistory', 'charDescription'];
  const source = {
    prompts: identifiers.map((identifier) => ({ identifier, marker: true, content: '' })),
    prompt_order: [{ order: identifiers.map((identifier) => ({ identifier, enabled: true })) }],
  };
  const result = convertStPreset(source);
  assert.equal((result.preset.promptTemplate as Array<{ type: string }>).filter((item) => item.type === 'chat').length, 1);
  assert.deepEqual(result.report.covered.map((item) => item.identifier), identifiers.slice(0, 3));
  const view = buildPresetProjectView(source, source, null);
  assert.equal(view.prompts[0].state, 'covered');
});

test('examples without enabled chat history use their field instead of importing all history', () => {
  const source = { prompts: [{ identifier: 'dialogueExamples', marker: true, content: '' }] };
  const { preset } = convertStPreset(source);
  assert.deepEqual((preset.promptTemplate as Array<{ text: string }>).map((item) => item.text), ['{{exampledialogue}}']);
});

test('toggle identity stays stable through edits and reorder, isolated from other source presets', () => {
  const source = fixture();
  const draft = structuredClone(source);
  draft.prompts[1].name = '重命名';
  draft.prompts[1].content = '编辑正文';
  draft.prompts.reverse();
  const before = buildPresetProjectView(source, source, null).report;
  const after = buildPresetProjectView(source, draft, null).report;
  assert.deepEqual(after.toggleKeys, before.toggleKeys);
  assert.equal(buildStPresetArtifacts(source, draft).report.controlNamespace, after.controlNamespace);
  assert.notEqual(presetControlNamespace(source), presetControlNamespace({ ...source, name: '另一个预设' }));
});

test('literal variable compilation preserves sequential reassignment without mutating source', () => {
  const source = fixture(['{{setvar::style::简短}}', '{{getvar::style}}', '{{setvar::style::详细}}{{getvar::style}}']);
  source.prompt_order[0].order.forEach((item) => { item.enabled = true; });
  const snapshot = structuredClone(source);
  const result = buildStPresetArtifacts(source, source);
  assert.equal(result.runnable, true);
  assert.deepEqual((result.preset.promptTemplate as Array<{ text: string }>).map((item) => item.text), ['简短', '详细']);
  assert.deepEqual(source, snapshot);
  assert.equal(result.report.covered[0].identifier, 'p0');
});

test('stateful macros convert with a warning instead of blocking the export', () => {
  // Deliberate relaxation. RisuAI *does* register these macros: `settempvar` and
  // `gettempvar` share the `vars` scope inside one parse, and `setvar` is backed
  // by a chat variable the engine writes when `runVar` is set. The previous
  // blanket `error` made any preset using them non-exportable, which blocked
  // generalising the conversion. Only cross-entry ordering stays a caveat, so
  // the issue is reported as a warning and the `.risup` is still produced.
  for (const contents of [
    ['{{getvar::x}}', '{{setvar::x::A}}'],
    ['{{setvar::x::{{random::A::B}}}}', '{{getvar::x}}'],
    ['{{setvar::x::A}}', '{{getvar::x}}'],
  ]) {
    const source = fixture(contents);
    const result = buildStPresetArtifacts(source, source);
    assert.notEqual(result.risup, null, 'a runtime caveat must not block the export');
    assert.equal(result.runnable, true);
    const issue = result.report.issues.find((item) => item.code === 'VARIABLE_SEMANTICS');
    assert.ok(issue, 'the caveat must still be reported');
    assert.equal(issue.severity, 'warning');
    const files = unzipSync(encodeStPresetBundle(source, source, result));
    assert.notEqual(files['converted.risup'], undefined);
    assert.deepEqual(JSON.parse(strFromU8(files['original.st.json'])), source);
    assert.deepEqual(JSON.parse(strFromU8(files['conversion.report.json'])), result.report);
  }
});

test('a genuinely unsupported runtime still blocks the export', () => {
  // The relaxation must not turn every error into a warning: things RisuAI
  // cannot represent at all still refuse to produce a runnable preset.
  const source = {
    ...fixture(['正文']),
    prompts: [
      { identifier: 'p0', name: '条目 0', content: '正文', role: 'system', injection_position: 1 },
    ],
    prompt_order: [{ order: [{ identifier: 'p0', enabled: true }] }],
  };
  const result = buildStPresetArtifacts(source, source);
  assert.equal(result.risup, null);
  assert.ok(result.report.issues.some((issue) => issue.code === 'INJECTION_POSITION' && issue.severity === 'error'));
});

test('plugin settings are archived; unknown fields and macros are not silently accepted', () => {
  const source = { ...fixture(['{{plugin_helper::x}}']), future_setting: false,
    extensions: { future_plugin: { enabled: false } } };
  source.prompts.push({ identifier: 'SPresetSettings', name: 'SPresetSettings', content: '{"valuable":true}', role: 'system' });
  const result = buildStPresetArtifacts(source, source);
  assert.ok(result.report.archived.some((item) => item.identifier === 'SPresetSettings'));
  assert.ok(!JSON.stringify(result.preset).includes('valuable'));
  assert.ok(result.report.unmappedFields.includes('future_setting'));
  assert.ok(result.report.unmappedFields.includes('extensions.future_plugin'));
  assert.ok(result.report.issues.some((item) => item.code === 'UNVERIFIED_MACRO'));
});

test('regex display/send scopes are separate and unknown role contexts cannot match', () => {
  const source = { ...fixture(), extensions: { regex_scripts: [
    { scriptName: '显示', findRegex: '/x/g', replaceString: 'y', placement: [2], markdownOnly: true },
    { scriptName: '发送', findRegex: '/x/', replaceString: 'z', placement: [1], promptOnly: true },
  ] } };
  const result = convertStPreset(source);
  const rules = result.preset.regex as Array<{ type: string; in: string; flag: string }>;
  assert.deepEqual(rules.map((item) => item.type), ['editdisplay', 'editprocess']);
  assert.match(rules[0].in, /equal::\{\{role\}\}::char/u);
  assert.match(rules[1].in, /equal::\{\{role\}\}::user/u);
  for (const rule of rules) {
    assert.ok(rule.in.endsWith('{{:else}}(?!){{/when}}'));
    assert.ok(rule.flag.includes('<cbs>'));
  }
});

test('editor-time and depth metadata convert with a reported approximation', () => {
  // Deliberate relaxation. SillyTavern writes `runOnEdit: true` on every rule by
  // default, and treats depth/substitution/trim as optional refinements. Refusing
  // to convert them skipped **all 11** rules of a real preset and blocked the
  // export entirely, so they are now carried over with a caveat instead.
  for (const extra of [{ minDepth: 0 }, { maxDepth: 3 }, { runOnEdit: false }, { runOnEdit: true },
    { trimStrings: ['a'] }, { substituteRegex: 1 }]) {
    const source = { ...fixture(), extensions: { regex_scripts: [
      { findRegex: 'x', replaceString: '', placement: [2], ...extra },
    ] } };
    const result = buildStPresetArtifacts(source, source);
    assert.notEqual(result.preset.regex, undefined, `${JSON.stringify(extra)} must still convert`);
    assert.equal(result.runnable, true);
    assert.equal(result.report.regexSkipped.length, 0);
    assert.equal(result.report.regexApproximated.length, 1);
    assert.ok(result.report.regexApproximated[0].reason);
    assert.ok(result.report.warnings.some((warning) => warning.includes('编辑时机或深度窗口')));
  }
});

test('a placement RisuAI has no stage for is still refused', () => {
  // The relaxation must not become "convert anything": placement 4 (world info)
  // has no RisuAI counterpart, so the rule cannot run and must be reported.
  const source = { ...fixture(), extensions: { regex_scripts: [
    { findRegex: 'x', replaceString: '', placement: [2, 4] },
  ] } };
  const result = buildStPresetArtifacts(source, source);
  assert.equal(result.runnable, false);
  assert.ok(result.report.regexSkipped[0].reason.includes('placement'));
});

test('malformed references, depth injection and regex definitions fail with concrete diagnostics', () => {
  assert.throws(() => convertStPreset(fixture(), { blockIndex: 9 }), /不存在/u);
  const source = fixture();
  Object.assign(source.prompts[0], { injection_position: 1, injection_depth: 2 });
  const result = buildStPresetArtifacts(source, source);
  assert.equal(result.runnable, false);
  assert.ok(result.report.issues.some((issue) => issue.code === 'INJECTION_POSITION'));
  const invalid = buildStPresetArtifacts(source, { ...fixture(), extensions: { regex_scripts: [{ findRegex: '' }] } });
  assert.ok(invalid.report.issues.some((issue) => issue.code === 'INVALID_REGEX'));
});

test('CLI always writes a matching report and complete archive, and does not overwrite a valid output on failure', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'st-preset-p0-'));
  try {
    const input = path.join(directory, 'source.json');
    const output = path.join(directory, 'result.risup');
    const source = fixture();
    await writeFile(input, JSON.stringify(source));
    const args = ['--import', 'tsx', 'scripts/convert-st-preset.ts', input, output];
    const success = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(success.status, 0, success.stderr);
    const prior = await readFile(output);
    assert.deepEqual(decodeRisuPreset(prior).preset, buildStPresetArtifacts(source, source).preset);
    const report = JSON.parse(await readFile(`${output}.report.json`, 'utf8'));
    assert.deepEqual(report.report, buildStPresetArtifacts(source, source).report);
    // A *genuinely* unconvertible input: chat-depth injection has no RisuAI
    // equivalent, so the CLI must fail and leave the previously written output
    // untouched. An earlier version of this test relied on `{{getvar::missing}}`
    // failing, which no longer holds now that stateful macros convert with a
    // warning rather than blocking the export.
    const failing = fixture();
    Object.assign(failing.prompts[0], { injection_position: 1, injection_depth: 2 });
    await writeFile(input, JSON.stringify(failing));
    const failed = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(failed.status, 1, failed.stderr);
    assert.deepEqual(await readFile(output), prior);
    const files = unzipSync(await readFile(`${output}.conversion.zip`));
    assert.equal(files['converted.risup'], undefined);
    assert.ok(files['draft.st.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('target regex flags retain single-match and non-Unicode replacement semantics', () => {
  const source = { ...fixture(), extensions: { regex_scripts: [{ findRegex: '/./', replaceString: 'X', placement: [2] }] } };
  const result = convertStPreset(source);
  const rule = (result.preset.regex as Array<{ in: string; flag: string; out: string }>)[0];
  const actual = '😀ab'.replace(new RegExp(rule.in, rule.flag), rule.out);
  assert.equal(actual, '😀ab'.replace(/./, 'X'));
  assert.notEqual(actual, '😀ab'.replace(/./u, 'X'));
  assert.notEqual(actual, '😀ab'.replace(/./g, 'X'));
});
