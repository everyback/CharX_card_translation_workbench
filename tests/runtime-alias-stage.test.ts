import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRuntimeAliasDraft } from '../server/application/translation/runtime-alias-stage.js';

test('translation stage collects translated text names even when the catalog already has a target alias', async () => {
  const module = { trigger: [{ effect: [{ code: 'local roster = [==[[{"id":"cirno","aliases":["Cirno","琪露诺"],"sfw":["cirno_angry"]}]]==]' }] }] };
  const source = { character_book: { entries: [{ content: '<TouhouAssetIndexV2>\n- `cirno` = 冰之妖精 [SFW:G1]\n</TouhouAssetIndexV2>' }] } };
  const before = JSON.stringify(module);
  const result = await buildRuntimeAliasDraft(module, source, 'zh-CN', async () => { throw new Error('should not translate existing names'); }, async (names) => {
    assert.ok(names.some((item) => item.ownerId === 'cirno' && item.name === '冰之妖精'));
    return { cirno: ['冰妖'] };
  });
  const code = JSON.stringify(result.draft);
  assert.ok(code.includes('冰之妖精'));
  assert.ok(code.includes('冰妖'));
  assert.equal(JSON.stringify(module), before);
  await assert.rejects(buildRuntimeAliasDraft(module, source, 'zh-CN', async () => ({}), async () => { throw new Error('provider failed'); }), /provider failed/);
  assert.equal(JSON.stringify(module), before);
});


test('cancellation after name translation prevents segmentation and preserves the module', async () => {
  const controller = new AbortController();
  const module = { trigger: [{ effect: [{ code: 'local roster = [==[[{"id":"cirno","aliases":["Cirno"],"sfw":["cirno_angry"]}]]==]' }] }] };
  const before = JSON.stringify(module);
  let segmented = false;
  await assert.rejects(buildRuntimeAliasDraft(module, {}, 'zh-CN', async () => {
    controller.abort(); return { cirno: ['琪露诺'] };
  }, async () => { segmented = true; return {}; }, controller.signal), { name: 'AbortError' });
  assert.equal(segmented, false);
  assert.equal(JSON.stringify(module), before);
});
