import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReviewedDraft } from '../server/application/export/reviewed-draft.js';
import { ModuleReviewConflict } from '../server/domain/lua/module-review-base.js';
import { scanRisuModule, type ApplicableSegment } from '../server/domain/card/card.js';

test('withdrawing Lua approval removes the old translation while preserving a nearby manual repair', () => {
  const source = 'local label = "Hello world"\nlocal count = 1\nreturn label';
  const original = { name: 'Fixture', trigger: [{ effect: [{ code: source }] }] };
  const scanned = scanRisuModule(original, 'all').find(s => s.sourceText === 'Hello world')!;
  assert.ok(scanned);
  const segment: ApplicableSegment = { ...scanned, pathJson: JSON.stringify(scanned.path), translatedText: '你好世界', finalText: null, reviewStatus: 'approved' };
  const first = buildReviewedDraft({}, original, original, [segment], 'risum');
  const current = structuredClone(first.draftModule!);
  (current.trigger as typeof original.trigger)[0].effect[0].code = String((current.trigger as typeof original.trigger)[0].effect[0].code).replace('count = 1', 'count = 2');
  const withdrawn = buildReviewedDraft({}, original, current, [{ ...segment, reviewStatus: 'rejected' }], 'risum', { base: first.moduleBase!, applied: first.draftModule! });
  assert.equal((withdrawn.draftModule!.trigger as typeof original.trigger)[0].effect[0].code, source.replace('count = 1', 'count = 2'));
  const again = buildReviewedDraft({}, original, withdrawn.draftModule, [{ ...segment, reviewStatus: 'rejected' }], 'risum', { base: withdrawn.moduleBase!, applied: withdrawn.draftModule! });
  assert.deepEqual(again.draftModule, withdrawn.draftModule);
});

test('legacy translated module fields are removed after rejection or clearing without losing regex repairs', () => {
  const original = { name: 'Hello', lorebook: [{ content: 'World' }], regex: [{ in: 'foo', out: 'bar' }] };
  const segments: ApplicableSegment[] = [
    { pathJson: '["$module","name"]', sourceText: 'Hello', start: null, end: null, translatedText: '你好', finalText: null, reviewStatus: 'rejected', kind: 'field' },
  ];
  const current = { ...original, name: '你好', regex: [{ in: '(?:foo|bar)', out: 'bar' }] };
  const rebuilt = buildReviewedDraft({}, original, current, segments, 'risum');
  assert.equal(rebuilt.draftModule!.name, 'Hello');
  assert.deepEqual(rebuilt.draftModule!.regex, current.regex);
  const cleared = buildReviewedDraft({}, original, current, [], 'risum', { base: original, applied: { ...original, name: '你好' } });
  assert.equal(cleared.draftModule!.name, 'Hello');
  assert.deepEqual(cleared.draftModule!.regex, current.regex);
});

test('overlapping manual edits block rebuilding and leave the input intact', () => {
  const base = { name: 'Hello' }, applied = { name: '你好' }, current = { name: '人工改名' };
  assert.throws(() => buildReviewedDraft({}, base, current, [], 'risum', { base, applied }), ModuleReviewConflict);
  assert.deepEqual(current, { name: '人工改名' });
});

test('withdrawn legacy writes cannot persist in protected module trigger fields', () => {
  const original = { trigger: [{ effect: [{ type: 'v2Impersonate', role: 'user', value: 'key', valueType: 'var' }] }] };
  const current = structuredClone(original);
  current.trigger[0].effect[0].role = '用户';
  const segment: ApplicableSegment = { pathJson: '["$module","trigger",0,"effect",0,"role"]', kind: 'field',
    sourceText: 'user', start: null, end: null, translatedText: '用户', finalText: null, reviewStatus: 'rejected' };
  const result = buildReviewedDraft({}, original, current, [segment], 'risum');
  assert.deepEqual(result.draftModule, original);
});
