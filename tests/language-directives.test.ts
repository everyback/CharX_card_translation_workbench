import assert from 'node:assert/strict';
import test from 'node:test';
import {
  languageBehaviorDirectiveIssue,
  languageDisplayName,
  normalizeLanguageBehaviorDirectives,
  reviewLanguageBehaviorDirectives,
} from '../server/domain/language-directives.js';

test('language behavior directives follow the selected Chinese target', () => {
  const source = '人物内心使用韩语思考。人物书写韩文，人物使用한국어交流。';
  const result = normalizeLanguageBehaviorDirectives(source, 'zh-CN');
  assert.equal(result.text, '人物内心使用简体中文思考。人物书写简体中文，人物使用简体中文交流。');
  assert.equal(result.replacements.length, 3);
  assert.equal(result.remaining.length, 0);
});

test('English and Korean directive forms are normalized without changing ordinary facts', () => {
  const source = 'The character thinks in Korean and speaks Korean. 角色使用한국어交流。 그녀는 한국어로 생각하고 한국어로 대화한다. 她学习过韩语。';
  const result = normalizeLanguageBehaviorDirectives(source, 'zh-CN');
  assert.match(result.text, /thinks in 简体中文 and speaks 简体中文/u);
  assert.match(result.text, /角色使用简体中文交流/u);
  assert.match(result.text, /그녀는 한국어로 생각하고 한국어로 대화한다/u);
  assert.match(result.text, /她学习过韩语/u);
  assert.ok(result.remaining.length >= 1);
});

test('ordinary language facts and code-like conditions are not rewritten', () => {
  const source = '她学习过韩语。if language == "ko" then return "Korean" end';
  const result = normalizeLanguageBehaviorDirectives(source, 'zh-CN');
  assert.equal(result.text, source);
  assert.equal(languageBehaviorDirectiveIssue(result.text, 'zh-CN'), null);
});

test('same-family targets keep their original behavior language', () => {
  const source = '人物使用韩语思考。';
  const result = normalizeLanguageBehaviorDirectives(source, 'ko-KR');
  assert.equal(result.text, source);
  assert.equal(result.changed, false);
});

test('target display labels are stable for prompts and review', () => {
  assert.equal(languageDisplayName('zh-CN'), '简体中文');
  assert.equal(languageDisplayName('zh-TW'), '繁体中文');
  assert.equal(languageDisplayName('ja'), '日语');
  assert.equal(languageDisplayName('English'), '英语');
});

test('review metadata reports automatic replacements and unresolved directives', () => {
  const review = reviewLanguageBehaviorDirectives(
    '人物使用韩语思考。',
    '人物使用韩语思考。',
    'zh-CN',
    'target',
  );
  assert.equal(review.targetLabel, '简体中文');
  assert.equal(review.replacements.length, 1);
  assert.equal(review.remaining.length, 0);
});
