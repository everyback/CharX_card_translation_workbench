import assert from 'node:assert/strict';
import test from 'node:test';
import { lorebookAliasIssue, residualHangulIssue, residualLanguageIssue, shouldSplitTranslationBatch } from '../server/domain/translation-errors.js';
import { localTranslationControlFragments, protectText, unchangedCodeSpanFragments, unchangedFilePathFragments } from '../server/domain/card.js';
import { chatCompletionsEndpoint, modelRequestTimeoutMilliseconds, normalizeModelRequestTimeoutSeconds } from '../server/scheduler.js';

test('chat completions endpoint accepts either a base URL or a full endpoint', () => {
  assert.equal(
    chatCompletionsEndpoint('https://api.example.com/v1'),
    'https://api.example.com/v1/chat/completions',
  );
  assert.equal(
    chatCompletionsEndpoint('https://api.example.com/v1/chat/completions/'),
    'https://api.example.com/v1/chat/completions',
  );
});

test('model request timeout accepts seconds and stays within safe bounds', () => {
  assert.equal(normalizeModelRequestTimeoutSeconds(undefined), 120);
  assert.equal(normalizeModelRequestTimeoutSeconds(45), 45);
  assert.equal(normalizeModelRequestTimeoutSeconds(0), 120);
  assert.equal(normalizeModelRequestTimeoutSeconds(90_000), 86_400);
  assert.equal(modelRequestTimeoutMilliseconds(45), 45_000);
});

test('translation batches split on size-sensitive and malformed batch responses', () => {
  assert.equal(shouldSplitTranslationBatch(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), true);
  assert.equal(shouldSplitTranslationBatch(new Error('模型漏翻 S17')), true);
  assert.equal(shouldSplitTranslationBatch(new Error('S2 缺少保护占位符：__CTW_KEEP_4__')), true);
  assert.equal(shouldSplitTranslationBatch(new Error('S2 世界书中文别名无效：译文仍含韩文')), true);
  assert.equal(shouldSplitTranslationBatch(new Error('S2 翻译质量不合格：可能残留韩文：엄마')), true);
  assert.equal(shouldSplitTranslationBatch(new Error('模型接口 400：maximum context length exceeded')), true);
});

test('translation batches keep ordinary provider failures on the retry path', () => {
  assert.equal(shouldSplitTranslationBatch(new Error('模型接口 429：rate limit exceeded')), false);
  assert.equal(shouldSplitTranslationBatch(new Error('模型接口 500：internal server error')), false);
  assert.equal(shouldSplitTranslationBatch(new Error('network connection reset')), false);
});

test('Korean lorebook aliases must produce concise Chinese triggers', () => {
  assert.equal(lorebookAliasIssue('알리사', '艾丽莎'), null);
  assert.equal(lorebookAliasIssue('알리사', '알리사'), '译文与韩文原词相同');
  assert.equal(lorebookAliasIssue('학교', 'school'), '译文不含中文汉字');
  assert.equal(lorebookAliasIssue('학교', '学校\n校园'), '译文包含换行');
  assert.equal(lorebookAliasIssue('학교', 'がっこう', { sourceLanguage: 'ko', targetLanguage: 'ja' }), null);
  assert.equal(lorebookAliasIssue('school', 'école', { sourceLanguage: 'en', targetLanguage: 'fr' }), null);
  assert.equal(lorebookAliasIssue('school', 'school', { sourceLanguage: 'English', targetLanguage: '英语' }), null);
});

test('residual Korean QA ignores protected controls but catches untranslated dialogue', () => {
  const source = [
    '<!-- keys: 엘피, Elpi reaction -->',
    'Tag format and List of commands:',
    '[통상] : Use for normal scenes.',
    '[섹스] : Use for NSFW scenes.',
    'Example: <img src=[통상].happy>',
    'Dialogue: "엄마 괜찮아?"',
  ].join('\n');
  const protectedValue = protectText(source, localTranslationControlFragments(source));
  const valid = '<!-- keys: 엘피, Elpi reaction -->\n[통상]：普通场景。\n[섹스]：成人场景。\n<img src=[통상].happy>\n对白：“妈妈，没事吧？”';
  const invalid = `${valid}\n口头禅："엄마 괜찮아?"`;

  assert.equal(residualHangulIssue(valid, protectedValue.tokens), null);
  assert.equal(residualHangulIssue(invalid, protectedValue.tokens), '可能残留韩文：엄마、괜찮아');
  assert.equal(residualHangulIssue('她哭了ㅠㅠ，又笑了ㅋㅋ。'), null);
  assert.equal(residualHangulIssue('空白占位ㅤㅤ。'), null);
  assert.equal(residualHangulIssue('熟悉后改用반말。'), '可能残留韩文：반말');
  assert.equal(residualHangulIssue('이/도/만/에/로/에서/처럼/같이/보다/까지', [
    '이', '도', '만', '에', '로', '에서', '처럼', '같이', '보다', '까지',
  ]), null);
  assert.match(residualLanguageIssue('Привет мир', [], 'ru', 'en', 'zh-CN') ?? '', /残留源语言/);
  assert.match(residualLanguageIssue('Привет мир', [], 'auto', 'Russian', 'zh-CN') ?? '', /残留源语言/);
  assert.equal(residualLanguageIssue('안녕하세요', [], 'ko', 'en', 'ko-KR'), null);
});

test('residual Korean QA ignores unchanged backtick terms without making them required controls', () => {
  const source = 'Location `모래바람 요새`; dialogue 엄마';
  const candidate = '`모래바람 요새`（沙暴要塞），对白：妈妈。';

  assert.deepEqual(unchangedCodeSpanFragments(source, candidate), ['`모래바람 요새`']);
  assert.equal(residualHangulIssue(candidate, unchangedCodeSpanFragments(source, candidate)), null);
  assert.deepEqual(unchangedCodeSpanFragments(source, '沙暴要塞'), []);
});

test('residual Korean QA ignores unchanged file paths but still catches prose', () => {
  const source = 'After editing, run python 로어북/빌드.py; dialogue 엄마.';
  const candidate = '编辑后运行 python 로어북/빌드.py；对白仍是 엄마。';
  const paths = unchangedFilePathFragments(source, candidate);

  assert.deepEqual(paths, ['로어북/빌드.py']);
  assert.equal(residualHangulIssue(candidate, paths), '可能残留韩文：엄마');
  assert.equal(residualHangulIssue('编辑后运行 python 로어북/빌드.py。', paths), null);
  assert.deepEqual(unchangedFilePathFragments(source, '编辑后运行 python 世界书/构建.py。'), []);
});
