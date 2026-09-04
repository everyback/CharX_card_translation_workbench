import assert from 'node:assert/strict';
import test from 'node:test';
import { lorebookAliasIssue, residualHangulIssue, residualLanguageIssue, shouldSplitTranslationBatch } from '../server/domain/translation-errors.js';
import { localTranslationControlFragments, protectText, unchangedCodeSpanFragments, unchangedFilePathFragments } from '../server/domain/card.js';
import {
  chatCompletionsEndpoint,
  readStreamingMessageContent,
  buildRegexWhitespaceProbe,
  collectRegexSamplePairs,
  collectRegexCoveragePairs,
  collectRegexLanguageEntries,
  MAX_REGEX_MODEL_CONTEXT_CHARS,
  relaxedRegexWhitespacePattern,
  regexLanguagePayloadEntry,
  regexLanguagePayloadSummary,
  risuRegexLanguageSystemPrompt,
  modelRequestTimeoutMilliseconds,
  normalizeModelRequestTimeoutSeconds,
  normalizeRisuRegexLanguageAlternatives,
  splitRegexLanguageEntries,
} from '../server/scheduler.js';

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

test('streaming model responses accumulate SSE deltas across UTF-8 chunks', async () => {
  const payload = [
    'data: {"choices":[{"delta":{"content":"<<<ID:1>>>"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"译"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"文<<<END>>>"}}]}\n\n',
    'data: [DONE]\n\n',
  ].join('');
  const bytes = new TextEncoder().encode(payload);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice(0, 19));
      controller.enqueue(bytes.slice(19, 23));
      controller.enqueue(bytes.slice(23));
      controller.close();
    },
  });
  assert.equal(await readStreamingMessageContent(stream), '<<<ID:1>>>译文<<<END>>>');
});

test('streaming model responses surface provider errors from SSE events', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"error":{"message":"upstream unavailable"}}\n\n'));
      controller.close();
    },
  });
  await assert.rejects(readStreamingMessageContent(stream), /模型接口流式错误.*upstream unavailable/u);
});

test('translation throughput settings have no product-specific upper bound', () => {
  const entries = Array.from({ length: 32 }, (_, index) => ({
    pathLabel: `模块.regex.${index}.in`,
    pattern: 'a',
    type: 'normal',
    out: 'b',
    sourceSamples: [],
    draftSamples: [],
  }));
  assert.equal(splitRegexLanguageEntries(entries, 1_000_000, 1_000_000).length, 1);
});

test('coverage regex prompt permits language-specific word-boundary syntax adaptation', () => {
  const prompt = risuRegexLanguageSystemPrompt('coverage');
  assert.match(prompt, /中文等连续书写语言通常无词间空格/u);
  assert.match(prompt, /英语\/韩语等依赖空格分词/u);
  assert.match(prompt, /零宽断言、分组和量词/u);
  assert.match(prompt, /必须在 pattern 中准确修改对应正则语法/u);
  assert.match(prompt, /所有已有并列项，以及捕获组的数量和顺序/u);
  const samplePrompt = risuRegexLanguageSystemPrompt('sample');
  assert.match(samplePrompt, /当前任务模式：sample/u);
  assert.match(samplePrompt, /绝不能修改完整 pattern/u);
  assert.doesNotMatch(samplePrompt, /fullCoverage/u);
  assert.doesNotMatch(samplePrompt, /分词与边界语法差异/u);
  assert.doesNotMatch(samplePrompt, /完整候选正则/u);
});

test('Lua regex adaptation follows the configured batch size', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({
    pathLabel: `模块.regex.${index}.in`,
    pattern: 'a'.repeat(1_500),
    type: 'normal',
    out: 'b'.repeat(1_500),
    sourceSamples: ['s'.repeat(600), 's'.repeat(600), 's'.repeat(600)],
    draftSamples: ['d'.repeat(600), 'd'.repeat(600), 'd'.repeat(600)],
  }));
  const batches = splitRegexLanguageEntries(entries, 8, 40_000);

  assert.equal(batches.length, 2);
  assert.equal(batches.flat().length, entries.length);
  assert.ok(batches.every((batch) => batch.length <= 8));
  assert.ok(batches.every((batch) => batch.reduce((chars, entry) => chars + JSON.stringify(regexLanguagePayloadEntry(entry)).length, 0) <= 40_000));
});

test('Lua regex adaptation sends only matching, source-draft paired context to the model', () => {
  const pattern = '([”"])\\s+(?=[\\u4e00-\\u9fff])';
  const samples = collectRegexSamplePairs(
    { ignored: '含有引号“但不命中', matched: '原文” 中文' },
    { ignored: '同样有引号“但不命中', matched: '译文” 中文' },
    pattern,
  );

  assert.deepEqual(samples, [{ source: '原文” 中文', draft: '译文” 中文' }]);
});

test('runtime display regex analysis does not send static card materials', () => {
  const payload = regexLanguagePayloadEntry({
    pathLabel: '模块.regex.41.in',
    originalPattern: '([”"」])[ \\t]+',
    pattern: '([”"」])[ \\t]*',
    type: 'editdisplay',
    out: '$1\n',
    dynamicDisplay: true,
    sourceSamples: ['卡片原文素材'],
    draftSamples: ['卡片译文素材'],
    sourceMatchCount: 59,
    draftMatchCount: 2,
    coverageRecords: [],
  });
  assert.equal(payload.dynamicDisplay, true);
  assert.equal(Object.hasOwn(payload, 'samples'), false);
  assert.equal(Object.hasOwn(payload, 'fullCoverage'), false);
  assert.equal(JSON.stringify(payload).includes('卡片原文素材'), false);
  assert.match(String(payload.runtimeRequirement), /中文无空格/);
});

test('runtime editoutput analysis does not require card matches or expose card samples', () => {
  const payload = regexLanguagePayloadEntry({
    pathLabel: '模块.regex.9.in',
    originalPattern: '<img cmd="([^"]+)">',
    pattern: '<img(?:\\s+)cmd="([^"]+)">',
    type: 'editoutput',
    out: '',
    runtimePostprocess: true,
    sourceSamples: ['卡片原文素材'],
    draftSamples: ['卡片译文素材'],
    sourceMatchCount: 0,
    draftMatchCount: 0,
  });
  assert.equal(payload.runtimePostprocess, true);
  assert.equal(Object.hasOwn(payload, 'samples'), false);
  assert.equal(Object.hasOwn(payload, 'fullCoverage'), false);
  assert.equal(JSON.stringify(payload).includes('卡片原文素材'), false);
  assert.match(String(payload.runtimeScope), /后处理/);
});

test('whitespace probes keep prose spacing evidence ahead of CSS quote noise', () => {
  const sourcePattern = '([”"])\\s+(?=[A-Za-z一-鿿])';
  const draftPattern = '([”"])[ \\t]+(?=[A-Za-z一-鿿])';
  assert.equal(relaxedRegexWhitespacePattern(draftPattern), '([”"])[ \\t]*(?=[A-Za-z一-鿿])');

  const probe = buildRegexWhitespaceProbe(
    { css: '<style>.x{content:"A"}</style>', dialogue: '原文" Next' },
    { css: '<style>.x{content:"A"}</style>', dialogue: '译文”下一句' },
    sourcePattern,
    draftPattern,
  );
  assert.ok(probe);
  assert.equal(probe.sourceMatchCount, 2);
  assert.equal(probe.draftMatchCount, 2);
  assert.equal(probe.baselineSourceMatchCount, 1);
  assert.equal(probe.baselineDraftMatchCount, 0);
  const dialogueRecord = probe.coverageRecords.find((record) => record.pathLabel === '$.dialogue');
  assert.match(dialogueRecord?.sourceText ?? '', /【" 】/u);
  assert.match(dialogueRecord?.draftText ?? '', /【”】/u);

  const payload = regexLanguagePayloadEntry({
    pathLabel: '模块.regex.41.in',
    pattern: draftPattern,
    type: 'normal',
    out: '$1',
    sourceSamples: [],
    draftSamples: [],
    coverageRecords: [],
    sourceMatchCount: 1,
    draftMatchCount: 0,
    formatProbe: probe,
  });
  const formatProbe = payload.formatProbe as { records: Array<{ path: string }> };
  assert.equal(formatProbe.records[0]?.path, '$.dialogue');
  assert.ok(JSON.stringify(payload).length <= MAX_REGEX_MODEL_CONTEXT_CHARS);
});

test('regex model payload is deduplicated, difference-first, stable, and hard-bounded', () => {
  const duplicate = {
    pathLabel: '$.same',
    sourceText: '原文字段'.repeat(120),
    draftText: '译文字段'.repeat(120),
    sourceMatches: ['原文命中', '原文命中'],
    draftMatches: [],
  };
  const records = [
    ...Array.from({ length: 120 }, (_, index) => ({
      pathLabel: `$.field.${index}`,
      sourceText: `原文 ${index} `.repeat(120),
      draftText: `译文 ${index} `.repeat(120),
      sourceMatches: index % 2 ? [`命中${index}`, `命中${index}`] : [`命中${index}`],
      draftMatches: index % 2 ? [] : [`命中${index}`],
    })),
    duplicate,
    duplicate,
  ];
  const entry = {
    pathLabel: '模块.regex.9.in',
    pattern: '([”"])[ \\t]+(?=[0-9A-Za-z])',
    type: 'normal',
    out: '$1',
    sourceSamples: [],
    draftSamples: [],
    coverageRecords: records,
    sourceMatchCount: 5_000,
    draftMatchCount: 4_000,
  };
  const payload = regexLanguagePayloadEntry(entry);
  const summary = regexLanguagePayloadSummary(entry);
  assert.ok(JSON.stringify(payload).length <= MAX_REGEX_MODEL_CONTEXT_CHARS);
  assert.equal(summary.totalRecords, records.length);
  assert.equal(summary.totalUniqueRecords, records.length - 1);
  assert.equal(summary.totalSourceMatches, 5_000);
  assert.equal(summary.totalDraftMatches, 4_000);
  assert.equal(summary.truncated, true);
  assert.ok(summary.strata.coverageDifference > 0);
  const coverage = payload.fullCoverage as { records: Array<{ sourceMatches: string[]; draftMatches: string[] }> };
  assert.equal(coverage.records.length, summary.selectedRecords);
  assert.ok(coverage.records.some((record) => record.sourceMatches.length !== record.draftMatches.length));
  assert.equal(Object.hasOwn(coverage, 'sourceMatches'), false);
  assert.equal(Object.hasOwn(coverage, 'draftMatches'), false);
  assert.deepEqual(regexLanguagePayloadEntry(entry), regexLanguagePayloadEntry(entry));
});

test('regex grouping is language-agnostic and compares structure rather than a word list', () => {
  const payload = regexLanguagePayloadEntry({
    pathLabel: '模块.regex.10.in',
    pattern: '["”」]\\s+',
    type: 'normal',
    out: '$&',
    sourceSamples: [],
    draftSamples: [],
    coverageRecords: [
      { pathLabel: '$.english', sourceText: 'He said " next', draftText: '他说"下一句', sourceMatches: ['" '], draftMatches: ['"'] },
      { pathLabel: '$.japanese', sourceText: '彼は「 次」と言った', draftText: '彼は「次」と言った', sourceMatches: ['「 '], draftMatches: ['「'] },
      { pathLabel: '$.stable', sourceText: 'status: ready', draftText: 'status: ready', sourceMatches: ['ready'], draftMatches: ['ready'] },
    ],
  });
  const coverage = payload.fullCoverage as { strata: { coverageDifference: number; textDifference: number; stable: number } };
  assert.deepEqual(coverage.strata, { coverageDifference: 2, textDifference: 0, stable: 1 });
});

test('Lua regex coverage collects every before/after hit with its field path', () => {
  const pairs = collectRegexCoveragePairs(
    { first: 'A" B" C', nested: ['none', 'D" E'] },
    { first: '甲”乙', nested: ['无', '丁” 戊'] },
    '["”]\\s*',
  );
  assert.equal(pairs.length, 2);
  assert.deepEqual(pairs.map((pair) => pair.pathLabel), ['$.first', '$.nested.1']);
  assert.deepEqual(pairs[0].sourceMatches, ['" ', '" ']);
  assert.deepEqual(pairs[0].draftMatches, ['”']);
});

test('Lua regex coverage ignores regex protocol definitions', () => {
  const pairs = collectRegexCoveragePairs(
    { regex: [{ in: '"', out: '"' }], text: '原文" 后续' },
    { regex: [{ in: '"', out: '"' }], text: '译文"后续' },
    '"',
  );
  assert.deepEqual(pairs.map((pair) => pair.pathLabel), ['$.text']);
});

test('stage 2 regex entries retain the current rule and complete paired hit coverage', () => {
  const originalPattern = '([”"])\\s+(?=[0-9A-Za-z])';
  const currentPattern = '([”"])\\s*(?=[0-9A-Za-z一-鿿])';
  const entries = collectRegexLanguageEntries(
    { regex: [{ in: originalPattern, out: '$1' }] },
    { regex: [{ in: currentPattern, out: '$1' }] },
    { first: '原文" A', second: '又" B' },
    { first: '译文”后续', second: '再”文' },
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].originalPattern, originalPattern);
  assert.equal(entries[0].pattern, currentPattern);
  assert.equal(entries[0].sourceMatchCount, 2);
  // Stage 2 coverage uses the translated/current rule for the draft side.
  assert.equal(entries[0].draftMatchCount, 2);
  assert.deepEqual(entries[0].coverageRecords?.map((record) => record.pathLabel), ['$.first', '$.second']);
});

test('stage 2 retains every eligible regex rule without a fixed rule-count cap', () => {
  const rules = Array.from({ length: 81 }, (_, index) => ({ in: `pattern-${index}`, out: '$1' }));
  const entries = collectRegexLanguageEntries(
    { regex: rules },
    { regex: rules },
    {},
    {},
  );

  assert.equal(entries.length, 81);
});

test('stage 2 uses complete match counts even when its evidence is bounded', () => {
  const text = Array.from({ length: 250 }, () => '" a').join(' ');
  const entries = collectRegexLanguageEntries(
    { regex: [{ in: '"\\s+a', out: '$1' }] },
    { regex: [{ in: '"\\s+a', out: '$1' }] },
    { text },
    { text },
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].sourceMatchCount, 250);
  assert.equal(entries[0].draftMatchCount, 250);
  assert.equal(entries[0].coverageRecords?.[0]?.sourceMatches.length, 200);
});

test('stage 2 skips zero-width display rules that cannot have a stable cardinality', () => {
  const entries = collectRegexLanguageEntries(
    { regex: [{ in: '(?:)', out: '' }] },
    { regex: [{ in: '(?:)', out: '' }] },
    { text: '原文' },
    { text: '译文' },
  );

  assert.deepEqual(entries, []);
});

test('coverage normalization accepts a complete candidate pattern', () => {
  const input = {
    targetLanguage: 'zh-CN',
    mode: 'coverage' as const,
    entries: [{ pathLabel: '模块.regex.1.in', pattern: 'x+', type: 'normal', out: '$1', sourceSamples: [], draftSamples: [] }],
  };
  assert.deepEqual(normalizeRisuRegexLanguageAlternatives(JSON.stringify({ proposals: [
    { pathLabel: '模块.regex.1.in', pattern: 'x*', reason: '中文无空格' },
  ] }), input), [{
    pathLabel: '模块.regex.1.in', anchorAlternatives: [], additions: [], pattern: 'x*',
  }]);
});

test('translation batches split on size-sensitive and malformed batch responses', () => {
  assert.equal(shouldSplitTranslationBatch(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), true);
  assert.equal(shouldSplitTranslationBatch(new Error('模型漏翻 S17')), true);
  assert.equal(shouldSplitTranslationBatch(new Error('S2 缺少保护占位符：__CTW_KEEP_4__')), true);
  assert.equal(shouldSplitTranslationBatch(new Error('S2 世界书中文别名无效：译文仍含韩文')), true);
  assert.equal(shouldSplitTranslationBatch(new Error('S2 翻译质量不合格：可能残留韩文：엄마')), true);
  assert.equal(shouldSplitTranslationBatch(new Error('模型接口 400：maximum context length exceeded')), true);
  assert.equal(shouldSplitTranslationBatch(new Error('模型接口 524：{"error":{"message":"Upstream model provider is temporarily unavailable.","type":"server_error"}}')), true);
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
