import './helpers/isolated-runtime.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { isSafeRisuDisplayFormattingRegexChange } from '../server/domain/card/card.js';
import { normalizeRisuRegexLanguageAlternatives } from '../server/scheduler.js';

test('regex review accepts long multiline patterns while retaining syntax and capture checks', () => {
  const original = { type: 'editdisplay', in: '(a)', out: '$1\n' };
  const pattern = `(${ 'a'.repeat(4100) })\r\nend`;
  assert.equal(isSafeRisuDisplayFormattingRegexChange(original, { ...original, in: pattern }), true);
  assert.equal(isSafeRisuDisplayFormattingRegexChange(original, { ...original, in: '(' }), false);
  assert.equal(isSafeRisuDisplayFormattingRegexChange(original, { ...original, in: 'a\nb' }), false);
});

test('coverage candidates preserve long rules and literal boundary newlines', () => {
  const pattern = `\n${'x'.repeat(4100)}\r\n`;
  const proposals = normalizeRisuRegexLanguageAlternatives(JSON.stringify({ proposals: [
    { pathLabel: '模块.regex.0.in', pattern },
  ] }), {
    targetLanguage: 'zh-CN', mode: 'coverage',
    entries: [{ pathLabel: '模块.regex.0.in', pattern: 'x', type: 'normal', out: '', sourceSamples: [], draftSamples: [] }],
  });
  assert.equal(proposals[0]?.pattern, pattern);
});
