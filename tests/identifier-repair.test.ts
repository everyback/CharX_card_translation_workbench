import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { strToU8, zipSync } from 'fflate';
import { previewIdentifierRepair, exportIdentifierRepair } from '../server/application/export/identifier-repair-service.js';
import { planIdentifierRepair, applyIdentifierRepair } from '../server/domain/card/identifier-repair.js';
import { parseCharx, readCharxEntries } from '../server/domain/card/charx.js';
import { createRisuModule, readRisuModuleAssets } from '../server/domain/card/risum.js';
import { missingProtectedFragments, protectText, restoreProtectedText, validateRisuControlReferences } from '../server/domain/card/card.js';
import { missingRisuActionCallbacks } from '../server/domain/card/risu-actions.js';
import { registerIdentifierRepairRoutes } from '../server/routes/identifier-repair.js';

const pairs = [
  ['WALP_SetHostile规模_small', 'WALP_SetHostileScale_small'],
  ['WALP_SetHostile规模_medium', 'WALP_SetHostileScale_medium'],
  ['WALP_SetHostile规模_large', 'WALP_SetHostileScale_large'],
  ['WALP_Loop重置', 'WALP_LoopReset'],
  ['WALP_Set故事_canon', 'WALP_SetStory_canon'],
  ['WALP_Set故事_free', 'WALP_SetStory_free'],
] as const;
const fixture = (prefix = '') => {
  const html = pairs.map(([_, name]) => `<button class="choice" risu-trigger="${prefix}${name}" data-action="mode">Choose mode</button>`).join('');
  return { regex: [{ in: 'PANEL_MARKER', type: 'editdisplay', out: html }],
    trigger: [{ effect: [{ code: pairs.map(([_, name]) => `function ${prefix}${name}(id) return id end`).join('\n') }] }] };
};
const archive = (module: Record<string, unknown>, card: Record<string, unknown> = { data: { description: 'Story' } }) => zipSync({
  'card.json': strToU8(JSON.stringify(card)),
  'module.risum': createRisuModule(module, [new Uint8Array([9, 8, 7, 6])]),
  'assets/scene.png': new Uint8Array([1, 2, 3, 4]),
  'metadata.json': strToU8('{"preserve":true}'),
});

test('nested CBS inside HTML round-trips with flat protection tokens', () => {
  const source = '<button class="choice {{#if {{equal::{{getvar::mode}}::small}}}}on{{/if}}" risu-trigger="Panel77_Mode" title="Choose {{getvar::label}}">Story</button>';
  const result = protectText(source);
  assert.equal(result.tokens.some(token => /__CTW_KEEP_\d+__/u.test(token)), false);
  assert.equal(restoreProtectedText(result.protectedText, result.tokens), source);
  assert.deepEqual(missingProtectedFragments(source, source), []);
  const translated = restoreProtectedText(result.protectedText.replace('Choose', '选择').replace('Story', '故事'), result.tokens);
  assert.match(translated, /title="选择 \{\{getvar::label\}\}"/u);
  assert.deepEqual(missingProtectedFragments(source, translated), []);
});

test('real failed identifiers repair only from exact original structure after explicit review', () => {
  const original = fixture();
  const translated = structuredClone(original);
  for (const [broken, correct] of pairs) translated.regex[0].out = translated.regex[0].out.replace(correct, broken);
  translated.regex[0].out = translated.regex[0].out.replaceAll('Choose mode', '选择模式');
  assert.equal(missingRisuActionCallbacks(translated).length, 6);
  assert.ok(validateRisuControlReferences({}, {}, original, translated).length);
  const originalArchive = archive(original), translatedArchive = archive(translated);
  const preview = previewIdentifierRepair(originalArchive, translatedArchive);
  assert.equal(preview.changes.length, 6);
  assert.ok(preview.changes.every(change => change.callbackVerified));
  assert.throws(() => exportIdentifierRepair(originalArchive, translatedArchive, { planId: preview.planId, approvedIds: [] }), /审核/u);
  const partial = exportIdentifierRepair(originalArchive, translatedArchive, { planId: preview.planId, approvedIds: [preview.changes[0].id] });
  assert.equal(partial.diagnostics.length, 5);
  const result = exportIdentifierRepair(originalArchive, translatedArchive, { planId: preview.planId, approvedIds: preview.changes.map(c => c.id) });
  const parsed = parseCharx(result.output);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(validateRisuControlReferences({}, {}, original, parsed.module!), []);
  assert.match((parsed.module!.regex as typeof original.regex)[0].out, /选择模式/u);
  const files = readCharxEntries(result.output), sourceFiles = readCharxEntries(translatedArchive);
  assert.deepEqual(Object.keys(files).sort(), Object.keys(sourceFiles).sort());
  assert.deepEqual(files['assets/scene.png'], sourceFiles['assets/scene.png']);
  assert.deepEqual(readRisuModuleAssets(files['module.risum']), readRisuModuleAssets(sourceFiles['module.risum']));
  assert.deepEqual(parsed.card, parseCharx(translatedArchive).card);
  assert.throws(() => exportIdentifierRepair(originalArchive, archive(fixture('Different_')), { planId: preview.planId, approvedIds: preview.changes.map(c => c.id) }), /变化/u);
});

test('repair is name independent and refuses ambiguous rule, layout, and stale mappings', () => {
  const original = fixture('Arbitrary99_'), translated = structuredClone(original);
  translated.regex[0].out = translated.regex[0].out.replace('Arbitrary99_WALP_LoopReset', 'UnexpectedName');
  const plan = planIdentifierRepair({}, original, {}, translated);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].after, 'Arbitrary99_WALP_LoopReset');
  assert.throws(() => applyIdentifierRepair({}, translated, plan, ['invented']), /审核/u);
  translated.regex[0].out = 'shift' + translated.regex[0].out;
  assert.throws(() => applyIdentifierRepair({}, translated, plan, [plan.changes[0].id]), /变化/u);
  original.regex.push(structuredClone(original.regex[0]));
  assert.equal(planIdentifierRepair({}, original, {}, translated).changes.length, 0);
  original.regex.pop(); translated.regex[0].out += '<hr>';
  assert.equal(planIdentifierRepair({}, original, {}, translated).changes.length, 0);
});

test('runtime protection covers card HTML, CBS operands, CSS, JS and Lua names without blocking visible copy', () => {
  const html = '<style>#panel .choice{color:red}</style><script>function openPanel(){return window.mode}</script><button id="panel" risu-btn="openPanel" data-action="start" title="Hello">Hello {{getvar::state}}</button>';
  const card = { data: { first_mes: html } };
  assert.deepEqual(validateRisuControlReferences(card, { data: { first_mes: html.replaceAll('Hello', '你好') } }, {}, {}), []);
  for (const [from, to] of [['data-action="start"', 'data-action="开始"'], ['risu-btn="openPanel"', 'risu-btn="开启"'], ['getvar::state', 'getvar::状态'], ['#panel .choice', '#面板 .choice'], ['window.mode', 'window.模式']]) {
    assert.ok(validateRisuControlReferences(card, { data: { first_mes: html.replace(from, to) } }, {}, {}).length, from);
  }
  const original = { trigger: [{ effect: [{ code: 'local panelMode = "Hello"\nreturn panelMode' }] }] };
  const translated = structuredClone(original);
  translated.trigger[0].effect[0].code = original.trigger[0].effect[0].code.replace('Hello', '你好');
  assert.deepEqual(validateRisuControlReferences({}, {}, original, translated), []);
  translated.trigger[0].effect[0].code = translated.trigger[0].effect[0].code.replaceAll('panelMode', 'otherMode');
  assert.match(validateRisuControlReferences({}, {}, original, translated).map(i => i.message).join('\n'), /Lua 程序标识符/u);
});

test('repair HTTP workflow requires two files, current preview and selected approvals', async () => {
  const app = Fastify();
  await app.register(multipart, { limits: { files: 1, fileSize: 1024 * 1024 } });
  registerIdentifierRepairRoutes(app, 1024 * 1024);
  const original = fixture(), translated = structuredClone(original);
  translated.regex[0].out = translated.regex[0].out.replace('WALP_LoopReset', 'WALP_Loop重置');
  const originalBytes = archive(original), translatedBytes = archive(translated);
  const { address, port } = await app.listen({ host: '127.0.0.1', port: 0 }).then(() => {
    const a = app.server.address(); if (!a || typeof a === 'string') throw Error('missing address'); return a;
  });
  const request = (action: string, approval?: unknown) => {
    const form = new FormData();
    form.append('original', new Blob([originalBytes]), 'original.charx');
    form.append('translated', new Blob([translatedBytes]), 'translated.charx');
    if (approval) form.append('approval', JSON.stringify(approval));
    return fetch(`http://${address}:${port}/api/identifier-repair/${action}`, { method: 'POST', body: form });
  };
  try {
    const response = await request('preview'); assert.equal(response.status, 200);
    const preview = await response.json() as ReturnType<typeof previewIdentifierRepair>;
    assert.equal(preview.changes.length, 1);
    assert.equal((await request('export')).status, 400);
    const exported = await request('export', { planId: preview.planId, approvedIds: preview.changes.map(c => c.id) });
    assert.equal(exported.status, 200);
    assert.equal(exported.headers.get('X-Unresolved-Actions'), '0');
    assert.deepEqual(missingRisuActionCallbacks(parseCharx(new Uint8Array(await exported.arrayBuffer())).module!), []);
  } finally { await app.close(); }
});
