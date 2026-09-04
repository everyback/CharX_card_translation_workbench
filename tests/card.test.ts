import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyApprovedSegments,
  applyRisuRegexAlternativeProposals,
  applyRisuRegexCoverageProposals,
  bilingualModuleName,
  cardExportName,
  controlReferencesInText,
  countRegexMatchesInStrings,
  findRisuRegexAffectedSegmentIds,
  isRegexValidationOverrideActive,
  isRisuDisplayFormattingRegexRule,
  isRisuOutputPostprocessRegexRule,
  missingProtectionTokens,
  missingProtectedFragments,
  protectText,
  localTranslationControlFragments,
  risuControlLiterals,
  risuControlReferences,
  risuRegexControlLiterals,
  risuTranslationControlFragments,
  regexMatchSnippetsInStrings,
  restoreProtectedText,
  scanCard,
  scanRisuModule,
  validateRisuControlReferences,
} from '../server/domain/card/card.js';
import {
  applyRisuModuleSegments,
  collectRuntimeAliasCandidates,
  detectRisuPortraitRouting,
  inspectRuntimeAliasCoverage,
  inspectTouhouRuntimeAliasCoverage,
  replaceRisuLuaLine,
  validateRisuLuaChanges,
} from '../server/domain/lua/risu-lua.js';
import { normalizeRuntimeNameSegments, normalizeRisuRegexLanguageAlternatives } from '../server/scheduler.js';

const card = {
  name: 'Alice',
  description: 'A detective from London.',
  data: {
    alternate_greetings: ['Good evening, {{user}}.'],
    character_book: {
      entries: [{ name: 'London', content: 'The city is covered in fog.' }],
    },
  },
  customScripts: [{ code: '<button title="Open map">Open map</button>' }],
};

test('scope presets keep script text opt-in', () => {
  const standard = scanCard(card, 'standard');
  const scripted = scanCard(card, 'visible-scripts');

  assert.ok(standard.some((item) => item.category === 'core'));
  assert.ok(standard.some((item) => item.category === 'lorebook'));
  assert.ok(standard.some((item) => item.category === 'greeting'));
  assert.equal(standard.some((item) => item.category === 'script-ui'), false);
  assert.ok(scripted.some((item) => item.category === 'script-ui'));
});

test('Risu view screen enum fields stay protected in all scope', () => {
  const risuCard = {
    viewScreen: 'none',
    data: {
      view_screen: 'emotion',
      extensions: { viewScreen: 'imggen' },
    },
  };

  const segments = scanCard(risuCard, 'all');

  assert.deepEqual(segments, []);
});

test('regex diagnostics use bounded hit snippets', () => {
  const samples = regexMatchSnippetsInStrings({ body: `${'前文 '.repeat(30)}说 后文` }, '说');
  assert.equal(samples.length, 1);
  assert.ok(samples[0].includes('【说】'));
  assert.ok(samples[0].length <= 180);
});

test('all module scope contains each specialized translation scope', () => {
  const module = {
    name: 'Panel suite',
    lorebook: [{ name: 'School', comment: 'School notes', content: 'The academy is closed.' }],
    regex: [{ in: '\\[panel\\]', out: '<button title="Open map">Open map</button>' }],
    trigger: [{ effect: [{ code: [
      'local prompt = "Use Korean for narration."',
      'alertError(triggerId, "No retry target")',
    ].join('\n') }] }],
  };
  const identity = (segment: ReturnType<typeof scanRisuModule>[number]) => JSON.stringify([
    segment.path,
    segment.start,
    segment.end,
    segment.kind,
    segment.sourceText,
  ]);
  const all = new Set(scanRisuModule(module, 'all').map(identity));

  for (const scope of ['core', 'standard', 'visible-scripts', 'all-visible', 'lua-only'] as const) {
    for (const segment of scanRisuModule(module, scope)) {
      assert.equal(all.has(identity(segment)), true, `${scope} segment was omitted from all: ${segment.pathLabel}`);
    }
  }
});

test('all scope includes generic visible card strings but protects structural values', () => {
  const card = {
    spec: 'chara_card_v3',
    data: {
      name: 'Mina',
      custom_ui: { label: '시작하기', id: 'start_button' },
    },
  };
  const segments = scanCard(card, 'all');
  assert.ok(segments.some((segment) => segment.sourceText === '시작하기'));
  assert.equal(segments.some((segment) => segment.sourceText === 'start_button'), false);
  assert.equal(segments.some((segment) => segment.sourceText === 'chara_card_v3'), false);
});

test('Korean lorebook keywords become additive aliases without changing original triggers', () => {
  const keywordCard = {
    data: {
      character_book: {
        entries: [
          {
            keys: ['학교', 'school', '学校'],
            secondary_keys: ['교실'],
            content: '학교 설정',
            constant: false,
            use_regex: false,
          },
          { keys: ['항상'], content: '상시 설정', constant: true, use_regex: false },
          { keys: ['/학교/i'], content: '정규식 설정', constant: false, use_regex: true },
        ],
      },
    },
  };
  const segments = scanCard(keywordCard, 'standard');
  const aliases = segments.filter((segment) => segment.kind === 'lorebook-key-alias');

  assert.deepEqual(aliases.map((segment) => segment.sourceText), ['학교', '교실']);
  const translated = new Map([['학교', '学校'], ['교실', '教室']]);
  const draft = applyApprovedSegments(keywordCard, aliases.map((segment) => ({
    pathJson: JSON.stringify(segment.path),
    sourceText: segment.sourceText,
    start: segment.start,
    end: segment.end,
    translatedText: translated.get(segment.sourceText) ?? null,
    finalText: null,
    reviewStatus: 'approved',
    kind: segment.kind,
  })));
  const entries = ((draft.data as { character_book: { entries: Array<Record<string, unknown>> } })
    .character_book.entries);

  assert.deepEqual(entries[0].keys, ['학교', 'school', '学校']);
  assert.deepEqual(entries[0].secondary_keys, ['교실', '教室']);
  assert.deepEqual(entries[1].keys, ['항상']);
  assert.deepEqual(entries[2].keys, ['/학교/i']);
});

test('explicit source language enables aliases for non-Korean lorebook keywords', () => {
  const sourceCard = {
    data: {
      character_book: {
        entries: [{ keys: ['school'], content: 'School rules', constant: false, use_regex: false }],
      },
    },
  };
  const segments = scanCard(sourceCard, 'standard', [], [], 'en');
  assert.deepEqual(segments.filter((segment) => segment.kind === 'lorebook-key-alias').map((segment) => segment.sourceText), ['school']);
});

test('standard module scanning includes embedded RISUM lorebook text without translating trigger keys', () => {
  const segments = scanRisuModule({
    name: 'Panel',
    lorebook: [{ key: 'school', comment: 'School entry', content: 'The academy is closed.' }],
    trigger: [{ effect: [{ code: 'alertError(triggerId, "Hidden script")' }] }],
  }, 'standard');

  assert.ok(segments.some((segment) => segment.pathLabel === '模块.lorebook.0.comment'));
  assert.ok(segments.some((segment) => segment.pathLabel === '模块.lorebook.0.content'));
  assert.ok(!segments.some((segment) => segment.pathLabel === '模块.lorebook.0.key'));
  assert.ok(!segments.some((segment) => segment.sourceText.includes('Hidden script')));
});

test('card scanning excludes literal markers consumed by Risu regex rules', () => {
  const module = {
    regex: [
      { in: '\\[시나리오선택\\]', out: '<div>Scenario controls</div>' },
      { in: '\\[상태창\\|(.*?)\\]', out: '<div>Dynamic status</div>' },
      { in: '\\[갤러리\\]', out: '<div>Gallery controls</div>' },
    ],
  };
  const controlLiterals = risuRegexControlLiterals(module);
  const markedCard = {
    data: {
      first_mes: `${'첫 장면입니다. '.repeat(900)}\n\n[시나리오선택]\n\n{{#if {{equal::{{getvar::view_gallery}}::1}}}}[갤러리]{{/if}}\n\n이 문장은 번역해야 합니다.`,
    },
  };
  const segments = scanCard(markedCard, 'core', controlLiterals);

  assert.deepEqual(controlLiterals.sort(), ['[갤러리]', '[시나리오선택]'].sort());
  assert.equal(segments.some((segment) => /시나리오선택|갤러리/.test(segment.sourceText)), false);
  assert.equal(segments.some((segment) => segment.sourceText.includes('첫 장면입니다.')), true);
  assert.equal(segments.some((segment) => segment.sourceText.includes('이 문장은 번역해야 합니다.')), true);
});

test('embedded Risu control markers are protected without changing surrounding text', () => {
  const source = '장면 설명 [시나리오선택] 다음 문장 {{user}}';
  const controls = ['[시나리오선택]'];
  const protectedValue = protectText(source, controls);

  assert.equal(protectedValue.tokens.includes('[시나리오선택]'), true);
  assert.equal(protectedValue.protectedText.includes('[시나리오선택]'), false);
  assert.equal(restoreProtectedText(protectedValue.protectedText, protectedValue.tokens), source);
  assert.deepEqual(missingProtectedFragments(source, '场景说明 [情景选择] 下一句 {{user}}', controls), ['[시나리오선택]']);
});

test('card-local image command prefixes are protected without treating ordinary headings as controls', () => {
  const source = [
    '<Image Commands>',
    '[통상] : Use for normal scenes.',
    '[섹스] : Use for NSFW scenes.',
    'Select the matching [Prefix].',
    'Tag format: <img src=[Prefix].keyword>',
    'Example: <img src=[통상].happy>',
    '[대화] Translate this ordinary heading.',
    '</Image Commands>',
  ].join('\n');
  const controls = localTranslationControlFragments(source);
  const protectedValue = protectText(source, controls);

  assert.deepEqual(controls.sort(), ['[통상]', '[섹스]'].sort());
  assert.equal(protectedValue.protectedText.includes('[통상]'), false);
  assert.equal(protectedValue.protectedText.includes('[섹스]'), false);
  assert.equal(protectedValue.protectedText.includes('[Prefix]'), true);
  assert.equal(controls.includes('[Prefix]'), false);
  assert.equal(protectedValue.protectedText.includes('[대화]'), true);
});

test('explicit Korean runtime declarations are protected while surrounding prose stays translatable', () => {
  const source = [
    'Fixed Korean Speech Tokens: only say "샹하이".',
    'Korean flashback markers: 회상, 추억, 그날.',
    'The ordinary term 한국어 in this sentence is not a runtime token.',
    'replace(/#[\\wㄱ-ㅎㅏ-ㅣ가-힣]+/g, value);',
  ].join('\n');
  const controls = localTranslationControlFragments(source);
  const protectedValue = protectText(source, controls);

  assert.equal(controls.includes('샹하이'), true);
  assert.equal(controls.includes('회상'), true);
  assert.equal(controls.includes('추억'), true);
  assert.equal(controls.includes('[\\wㄱ-ㅎㅏ-ㅣ가-힣]'), true);
  assert.equal(protectedValue.protectedText.includes('한국어'), true);
});

test('bare asset filenames and Korean underscored runtime ids are protected', () => {
  const source = [
    'Available Keyword List: 포로_이오네_기본.png, 배경_고블린 동굴.png',
    'First choice = 이벤트_탁란수녀원세례',
    'Display template: 이벤트_[이벤트명]',
  ].join('\n');
  const controls = localTranslationControlFragments(source);
  const protectedValue = protectText(source, controls);

  assert.equal(controls.includes('포로_이오네_기본.png'), true);
  assert.equal(controls.includes('배경_고블린 동굴.png'), true);
  assert.equal(controls.includes('이벤트_탁란수녀원세례'), true);
  assert.equal(controls.includes('이벤트_[이벤트명]'), false);
  assert.equal(protectedValue.protectedText.includes('포로_이오네_기본.png'), false);
});

test('chunked asset-only lists protect a trailing filename split before its extension', () => {
  const source = ',포로_이오네_기본.png,병사_로사리오 임신_기본.png,적_카일_기본.png,적_카일_삭풍 순풍';
  const controls = localTranslationControlFragments(source);

  assert.equal(controls.includes(source), true);
  assert.equal(localTranslationControlFragments('图片：a.png,b.png,c.png，以及需要翻译的说明。').includes('图片：a.png,b.png,c.png，以及需要翻译的说明。'), false);
});

test('Unicode identifiers in code spans are protected without hiding prose spans', () => {
  const source = 'Status constants: `병사`, `적_`, `포로_`. Visible example: `이 문장은 번역한다`.';
  const protectedValue = protectText(source);

  assert.equal(protectedValue.tokens.includes('`병사`'), true);
  assert.equal(protectedValue.tokens.includes('`적_`'), true);
  assert.equal(protectedValue.tokens.includes('`포로_`'), true);
  assert.equal(protectedValue.protectedText.includes('`이 문장은 번역한다`'), true);
});

test('runtime declaration protects complete Korean examples and speech endings', () => {
  const source = 'Forbidden examples: "샤이이샹". Formal Korean speech endings: ~해요, ~지요.';
  const controls = localTranslationControlFragments(source);
  assert.equal(controls.includes('샤이이샹'), true);
  assert.equal(controls.includes('~해요'), true);
  assert.equal(controls.includes('~지요'), true);
  const protectedValue = protectText(source, controls);
  assert.equal(protectedValue.protectedText.includes('샤이이샹'), false);
  assert.equal(protectedValue.protectedText.includes('~해요'), false);
  assert.equal(protectedValue.protectedText.includes('~지요'), false);
  assert.equal(restoreProtectedText(protectedValue.protectedText, protectedValue.tokens), source);
});

test('Korean original-language declaration protects the following example list', () => {
  const source = [
    'The profanity must be rendered in its original Korean (Hangul).',
    '- Common Curses: 씨발, 좆까, 좆같다.',
    '- Common Insults: 개새끼, 씹새끼, 새끼.',
    '- Dynamic and Contextual Application: translate ordinary prose normally.',
  ].join('\n');
  const controls = localTranslationControlFragments(source);
  assert.equal(controls.includes('씨발'), true);
  assert.equal(controls.includes('개새끼'), true);
  assert.equal(controls.includes('translate'), false);
});

test('Lua match patterns protect localized protocol names while leaving payload text translatable', () => {
  const module = {
    trigger: [{
      effect: [{
        code: `local found = chat:match('(%[상태창%|.-%])')\nlocal optional = chat:find('%[상태창2?%|.-%]')\nlocal replaced = chat:gsub('%[상태창%|.-%]', '[상태창2|접힘]')\nlocal empty = '[상태창|없음]'`,
      }],
    }],
  };
  const references = risuControlReferences(module);
  const controls = risuTranslationControlFragments(module);
  assert.equal(controls.includes('[상태창|'), true);
  assert.equal(controls.includes('[상태창2|'), true);
  assert.equal(references.some((reference) => reference.literal === '[상태창|' && reference.embedded), true);
  assert.equal(references.some((reference) => reference.literal === '[상태창2|접힘]' && reference.embedded), false);
  assert.equal(controlReferencesInText('[상태창|없음]', references).some((reference) => reference.literal === '[상태창|'), true);

  const protectedValue = protectText('[상태창|없음]', controls);
  assert.equal(protectedValue.protectedText.includes('상태창'), false);
  assert.equal(restoreProtectedText(protectedValue.protectedText.replace('없음', '无'), protectedValue.tokens), '[상태창|无]');

  const segments = scanRisuModule(module, 'all-visible');
  assert.equal(segments.some((segment) => segment.sourceText.includes('%[상태창')), false);
  assert.equal(segments.some((segment) => segment.sourceText === '[상태창|없음]'), true);
});

test('Risu HTML text extraction keeps visible labels between nested template macros', () => {
  const module = {
    regex: [{
      in: 'STATUS_PANEL',
      out: '<div class="status" data-tooltip="관찰 모드 {{#if {{equal::{{getvar::mode}}::1}}}}[활성화중]{{/if}}{{#if {{not::{{getvar::mode}}}}}}[비활성화중]{{/if}}">{{#if {{equal::{{getvar::mode}}::1}}}}시작 시나리오: 최면 모드{{/if}}{{#if {{not::{{getvar::mode}}}}}}시작 시나리오: 없음 (기본 모드){{/if}}</div>',
    }],
  };
  const segments = scanRisuModule(module, 'all-visible');
  assert.deepEqual(
    segments.filter((segment) => segment.kind === 'text-node').map((segment) => segment.sourceText),
    ['시작 시나리오: 최면 모드', '시작 시나리오: 없음 (기본 모드)'],
  );
  assert.deepEqual(
    segments.filter((segment) => segment.kind === 'attribute').map((segment) => segment.sourceText),
    ['관찰 모드', '[활성화중]', '[비활성화중]'],
  );
});

test('Risu control references include regex triggers and scoped Lua control strings', () => {
  const module = {
    regex: [{ in: '\\[시나리오선택\\]', out: '<div>{{button::열기::OpenScenario}}</div>' }],
    trigger: [{ effect: [{
      code: 'if mode == "시나리오선택" then setChatVar(triggerId, "story_mode", "화면에 표시할 자연스러운 문장") end',
    }] }],
  };
  const references = risuControlReferences(module);
  const literals = risuControlLiterals(module);
  const codePath = ['$module', 'trigger', 0, 'effect', 0, 'code'];
  const scenarioReference = controlReferencesInText('시나리오선택', references, codePath);
  const keyReference = controlReferencesInText('story_mode', references, codePath);
  const segments = scanRisuModule(module, 'all-visible');

  assert.equal(literals.includes('[시나리오선택]'), true);
  assert.equal(literals.includes('시나리오선택'), true);
  assert.equal(literals.includes('story_mode'), true);
  assert.deepEqual(scenarioReference.map((reference) => reference.literal), ['시나리오선택']);
  assert.deepEqual(keyReference.map((reference) => reference.literal), ['story_mode']);
  assert.equal(controlReferencesInText('story_mode', references).length, 0);
  assert.equal(controlReferencesInText('story_mode', references, codePath, 'lorebook-key-alias').length, 0);
  assert.deepEqual(missingProtectedFragments(
    '시나리오선택', '情景选择', scenarioReference.map((reference) => reference.literal),
  ), ['시나리오선택']);
  assert.equal(segments.some((segment) => segment.sourceText === '시나리오선택'), false);
  assert.equal(segments.some((segment) => segment.sourceText === '화면에 표시할 자연스러운 문장'), true);
});

test('Risu control validation blocks broken markers, rules, and button actions', () => {
  const originalCard = { data: { first_mes: '장면\n[시나리오선택]' } };
  const originalModule = {
    regex: [{ in: '\\[시나리오선택\\]', out: '<div>{{button::열기::OpenScenario}}</div>' }],
    trigger: [{ effect: [{ code: 'if mode == "시나리오선택" then return true end' }] }],
  };
  const translatedCard = { data: { first_mes: '场景\n[시나리오선택]' } };
  const translatedModule = structuredClone(originalModule);
  translatedModule.regex[0].out = '<div>{{button::打开::OpenScenario}}</div>';

  assert.deepEqual(validateRisuControlReferences(
    originalCard, translatedCard, originalModule, translatedModule,
  ), []);

  const brokenCard = { data: { first_mes: '场景\n[情景选择]' } };
  assert.match(validateRisuControlReferences(
    originalCard, brokenCard, originalModule, translatedModule,
  )[0].message, /脚本触发标记/);

  const brokenRule = structuredClone(translatedModule);
  brokenRule.regex[0].in = '\\[情景选择\\]';
  assert.match(validateRisuControlReferences(
    originalCard, translatedCard, originalModule, brokenRule,
  )[0].message, /正则触发规则/);

  const brokenButton = structuredClone(translatedModule);
  brokenButton.regex[0].out = '<div>{{button::打开::OpenScenarioZh}}</div>';
  assert.match(validateRisuControlReferences(
    originalCard, translatedCard, originalModule, brokenButton,
  )[0].message, /按钮动作 ID/);

});

test('Risu control validation catches status protocol match loss', () => {
  const originalCard = {
    data: { first_mes: '[LV:15|Time:10:00 PM|Location:숲|Tools:칼|Magic:없음]' },
  };
  const draftCard = {
    data: { first_mes: '[LV:15|Time:10:00 PM|Location:숲 Tools:칼|Magic:없음]' },
  };
  const originalModule = {
    regex: [{
      in: '\\[LV:(.+?)\\|Time:(.+?)\\|Location:(.+?)\\|Tools:(.+?)\\|Magic:(.+?)\\]',
      out: '<div>$1</div>',
    }],
  };

  const issues = validateRisuControlReferences(
    originalCard, draftCard, originalModule, structuredClone(originalModule),
  );
  assert.match(issues.map((issue) => issue.message).join('\n'), /正则协议匹配数量/);
});

test('Risu display-formatting rules accept Chinese no-space replies without static-card cardinality', () => {
  const pattern = '([”"」])[ \\t]+(?!(?:하고|하는|라고|라며|라는|이라고|이라는|라니|と|って)(?![가-힣]))(?![A-Za-z-]+=)(?=[“"「『]?[0-9A-Za-z가-힣ぁ-ヺ一-鿿*(])';
  const originalCard = { data: { first_mes: '"안녕" 다음 장면' } };
  const draftCard = { data: { first_mes: '“你好”下一幕' } };
  const originalModule = {
    regex: [{ type: 'editdisplay', in: pattern, out: '$1\n' }],
  };
  const draftModule = structuredClone(originalModule);
  draftModule.regex[0].in = pattern.replace('[ \\t]+', '[ \\t]*');

  const issues = validateRisuControlReferences(
    originalCard, draftCard, originalModule, draftModule,
  );
  assert.deepEqual(issues, []);
});

test('Risu display-formatting rules retain their capture-only replacement contract', () => {
  const pattern = '([”"」])[ \\t]+';
  const originalModule = { regex: [{ type: 'editdisplay', in: pattern, out: '$1\n' }] };
  const draftModule = structuredClone(originalModule);
  draftModule.regex[0].out = '$1\n中文文本';

  const issues = validateRisuControlReferences(
    { data: { first_mes: '“你好” 下一幕' } },
    { data: { first_mes: '“你好”下一幕' } },
    originalModule,
    draftModule,
  );
  assert.match(issues.map((issue) => issue.message).join('\n'), /动态展示正则/);
});

test('Risu HTML injection editdisplay rules are not mistaken for reply formatting rules', () => {
  assert.equal(isRisuDisplayFormattingRegexRule({ type: 'editdisplay', in: 'marker', out: '<div>状态栏</div>' }), false);
  assert.equal(isRisuDisplayFormattingRegexRule({ type: 'editdisplay', in: '([”"」])', out: '$1\n' }), true);
});

test('Risu editoutput rules are runtime post-processors even with an empty replacement', () => {
  const originalCard = { data: { first_mes: '卡片静态文本' } };
  const draftCard = { data: { first_mes: '已翻译的静态文本' } };
  const originalModule = { regex: [{ type: 'editoutput', in: '<img cmd="([^"]+)">', out: '' }] };
  const draftModule = structuredClone(originalModule);
  draftModule.regex[0].in = '<img(?:\\s+)cmd="([^"]+)">';
  draftModule.regex[0].out = '<img cmd="$1">';

  assert.equal(isRisuOutputPostprocessRegexRule(originalModule.regex[0]), true);
  assert.deepEqual(validateRisuControlReferences(
    originalCard, draftCard, originalModule, draftModule,
  ), []);
});

test('Risu regex cardinality can be explicitly force-passed for the exact saved rule', () => {
  const pattern = '([”"」])[ \\t]+(?!(?:하고|하는|라고|라며|라는|이라고|이라는|라니|と|って)(?![가-힣]))';
  const originalCard = { data: { first_mes: '"안녕" 다음 장면' } };
  const draftCard = { data: { first_mes: '“你好”下一幕' } };
  const module = { regex: [{ in: pattern, out: '$1' }] };
  const override = {
    '模块.regex.0.in': {
      pattern,
      originalMatchCount: 1,
      draftMatchCount: 0,
      confirmedAt: '2026-09-01T00:00:00.000Z',
    },
  };
  assert.equal(isRegexValidationOverrideActive(override, '模块.regex.0.in', pattern, 1, 0), true);
  assert.deepEqual(validateRisuControlReferences(originalCard, draftCard, module, structuredClone(module), override), []);
  assert.equal(isRegexValidationOverrideActive(override, '模块.regex.0.in', `${pattern}x`, 1, 0), false);
});

test('Risu regex force-pass stores the original-pattern baseline for adapted drafts', () => {
  const originalPattern = '\\|\\s*name:\\s*([^|]+?)\\s*\\|\\s*title:\\s*([^|]+?)\\s*\\|';
  const draftPattern = '\\|\\s*[^|:]+:\\s*([^|]+?)\\s*\\|\\s*[^|:]+:\\s*([^|]+?)\\s*\\|';
  const originalCard = { data: { first_mes: '| name: Alice | title: Noble |' } };
  const draftCard = { data: { first_mes: '| 姓名: Alice | 爵位: Noble |\n| 姓名: Bob | 爵位: Commoner |' } };
  const originalMatchCount = countRegexMatchesInStrings(originalCard, originalPattern);
  const draftMatchCount = countRegexMatchesInStrings(draftCard, draftPattern);
  assert.equal(originalMatchCount, 1);
  assert.equal(draftMatchCount, 2);

  const override = {
    '模块.regex.0.in': {
      pattern: draftPattern,
      originalMatchCount,
      draftMatchCount,
      confirmedAt: '2026-09-03T00:00:00.000Z',
    },
  };
  const originalModule = { regex: [{ in: originalPattern, out: '$1' }] };
  const draftModule = { regex: [{ in: draftPattern, out: '$1' }] };
  assert.equal(isRegexValidationOverrideActive(
    override, '模块.regex.0.in', draftPattern, originalMatchCount, draftMatchCount,
  ), true);
  assert.deepEqual(validateRisuControlReferences(
    originalCard, draftCard, originalModule, draftModule, override,
  ), []);
});

test('Risu regex cardinality reports the translated segments needing manual review', () => {
  const pattern = '([”"」])[ \\t]+(?!(?:하고|하는|라고|라며|라는|이라고|이라는|라니|と|って)(?![가-힣]))(?![A-Za-z-]+=)(?=[“"「『]?[0-9A-Za-z가-힣ぁ-ヺ一-鿿*(])';
  const segments = [
    {
      id: 'affected', pathJson: '["data","first_mes"]', sourceText: '"안녕" 다음 장면',
      translatedText: '“你好”下一幕', finalText: null, reviewStatus: 'approved', start: null, end: null,
    },
    {
      id: 'unchanged', pathJson: '["data","scenario"]', sourceText: '일반 문장',
      translatedText: '普通句子', finalText: null, reviewStatus: 'approved', start: null, end: null,
    },
  ];
  assert.deepEqual(findRisuRegexAffectedSegmentIds(pattern, segments), ['affected']);
});

test('LLM regex proposals append only context-approved literal alternatives', () => {
  const pattern = '([”"」])[ \\t]+(?!(?:하고|하는|라고|라며|라는|이라고|이라는|라니|と|って)(?![가-힣]))';
  const module = { regex: [{ in: pattern, out: '$1' }] };
  const changes = applyRisuRegexAlternativeProposals(module, [{
    pathLabel: '模块.regex.0.in',
    anchorAlternatives: ['하고', 'と'],
    additions: ['的话', 'と', '(dangerous)'],
  }]);
  assert.deepEqual(changes, [{ pathLabel: '模块.regex.0.in', addedAlternatives: ['的话'] }]);
  assert.match(module.regex[0].in, /\|的话\)/u);
  assert.match(module.regex[0].in, /하고\|하는\|라고/u);
  assert.doesNotMatch(module.regex[0].in, /dangerous/u);
  assert.deepEqual(validateRisuControlReferences(
    { data: { first_mes: '"안녕" 다음 장면' } },
    { data: { first_mes: '"你好" 下一幕' } },
    { regex: [{ in: pattern, out: '$1' }] },
    module,
  ), []);
});

test('LLM regex proposals can cite a focused subset of a large alternation group', () => {
  const module = { regex: [{ in: '(?:하고|하는|라고|と|って)' }] };
  const changes = applyRisuRegexAlternativeProposals(module, [{
    pathLabel: '模块.regex.0.in',
    anchorAlternatives: ['하고'],
    additions: ['并且'],
  }]);
  assert.deepEqual(changes[0]?.addedAlternatives, ['并且']);
  assert.equal(module.regex[0].in, '(?:하고|하는|라고|と|って|并且)');
});

test('LLM regex proposal normalization requires known paths and plain literals', () => {
  const input = {
    targetLanguage: 'zh-CN',
    entries: [{ pathLabel: '模块.regex.41.in', pattern: 'x', type: 'editdisplay', out: '', sourceSamples: [], draftSamples: [] }],
  };
  assert.deepEqual(normalizeRisuRegexLanguageAlternatives(JSON.stringify({ proposals: [
    { pathLabel: '模块.regex.999.in', anchorAlternatives: ['x'], additions: ['y'] },
    { pathLabel: '模块.regex.41.in', anchorAlternatives: ['x'], additions: ['“并列项”', 'bad|syntax'] },
  ] }), input), [{
    pathLabel: '模块.regex.41.in', anchorAlternatives: ['x'], additions: ['“并列项”'],
  }]);
});

test('coverage regex adaptation may change target-language spacing without losing captures', () => {
  const original = '([”"」])[ \\t]+(?=[“"「『]?[0-9A-Za-z가-힣])';
  const module = { regex: [{ in: original, out: '$1' }] };
  const candidate = '([”"」])[ \\t]*(?=[“"「『]?[0-9A-Za-z가-힣一-鿿])';
  const changes = applyRisuRegexCoverageProposals(module, [{
    pathLabel: '模块.regex.0.in', anchorAlternatives: [], additions: [], pattern: candidate,
  }], { data: { first_mes: '"안녕" 다음' } });
  assert.equal(changes.length, 1);
  assert.equal(module.regex[0].in, candidate);
  assert.deepEqual(validateRisuControlReferences(
    { data: { first_mes: '"안녕" 다음' } },
    { data: { first_mes: '“你好”下一幕' } },
    { regex: [{ in: original, out: '$1' }] },
    module,
  ), []);
});

test('coverage regex adaptation keeps aliases added during stage 2', () => {
  const current = '(?:하고|并且)[ \\t]+';
  const module = { regex: [{ in: current, out: '$1' }] };
  const changes = applyRisuRegexCoverageProposals(module, [{
    pathLabel: '模块.regex.0.in', anchorAlternatives: [], additions: [], pattern: '(?:하고)[ \\t]*',
  }], { text: '하고 ' });
  assert.equal(changes.length, 0);
  assert.equal(module.regex[0].in, current);
});

test('Risu control validation allows additive aliases with zero-width UI render rules', () => {
  const originalCard = {
    data: {
      first_mes: '환상향에 오신 것을 환영합니다.',
      character_book: { entries: [{ keys: ['환상향'] }] },
    },
  };
  const draftCard = structuredClone(originalCard);
  draftCard.data.character_book.entries[0].keys.push('幻想乡');
  const originalModule = {
    regex: [{
      in: '(?:$|(?={{getvar::th_ui_rev}})(?!))',
      out: '<aside>동방 통합 사이드바 UI</aside>',
    }],
  };

  assert.deepEqual(validateRisuControlReferences(
    originalCard, draftCard, originalModule, structuredClone(originalModule),
  ), []);

  const changedModule = structuredClone(originalModule);
  changedModule.regex[0].in = '$';
  assert.match(validateRisuControlReferences(
    originalCard, draftCard, originalModule, changedModule,
  )[0].message, /正则输入模式已改动/);
});

test('approved replacements preserve protocol shells while translating slots', () => {
  const source = '报道：<news|村庄招牌再次损坏|晴朗|1|这是本月第四次损坏。>';
  const candidate = '报道：<news | 村庄招牌再次碎裂 | 晴朗 | 1 | 这是本月第四次损坏。>';
  const draft = applyApprovedSegments(
    { data: { first_mes: source } },
    [{
      pathJson: JSON.stringify(['data', 'first_mes']),
      sourceText: source,
      start: null,
      end: null,
      translatedText: candidate,
      finalText: candidate,
      reviewStatus: 'approved',
      kind: 'field',
    }],
  );
  assert.equal(
    (draft.data as Record<string, unknown>).first_mes,
    '报道：<news|村庄招牌再次碎裂|晴朗|1|这是本月第四次损坏。>',
  );
});

test('protected structures round-trip exactly', () => {
  const source = 'Hello {{user}}, open <b>https://example.com</b>.';
  const protectedValue = protectText(source);
  assert.equal(missingProtectionTokens(protectedValue.protectedText, protectedValue.tokens.length).length, 0);
  assert.equal(restoreProtectedText(protectedValue.protectedText, protectedValue.tokens), source);
});

test('rp-status protects its protocol shell while exposing natural mind text for translation', () => {
  const source = '<rp-status bm="이 사람, 괜찮네." em="같이 있고 싶어!" ba="+1" ea="0" td="day"/>';
  const protectedValue = protectText(source);

  assert.equal(protectedValue.protectedText.includes('이 사람, 괜찮네.'), true);
  assert.equal(protectedValue.protectedText.includes('같이 있고 싶어!'), true);
  assert.equal(protectedValue.protectedText.includes('<rp-status'), false);

  const translated = protectedValue.protectedText
    .replace('이 사람, 괜찮네.', '这个人，还不错。')
    .replace('같이 있고 싶어!', '想和你待在一起！');
  const restored = restoreProtectedText(translated, protectedValue.tokens);
  assert.equal(restored, '<rp-status bm="这个人，还不错。" em="想和你待在一起！" ba="+1" ea="0" td="day"/>');
  assert.deepEqual(missingProtectedFragments(source, restored), []);
});

test('URLs nested in HTML tags do not create unreachable protection tokens', () => {
  const source = 'Support me on <a href="https://ko-fi.com/aukaru">Ko-fi</a> or <a href="https://patreon.com/Aukaru">Patreon</a>';
  const protectedValue = protectText(source);

  assert.equal(protectedValue.tokens.length, 4);
  assert.equal(protectedValue.tokens.some((token) => token.includes('__CTW_KEEP_')), false);
  assert.equal(missingProtectionTokens(protectedValue.protectedText, protectedValue.tokens.length).length, 0);
  assert.equal(restoreProtectedText(protectedValue.protectedText, protectedValue.tokens), source);
});

test('manual validation accepts preserved tags with nested URLs', () => {
  const source = '<button style="background:url(\'https://example.com/a.png\')">Open {{user}}</button>';
  const translated = '<button style="background:url(\'https://example.com/a.png\')">打开 {{user}}</button>';
  assert.deepEqual(missingProtectedFragments(source, translated), []);
  assert.ok(missingProtectedFragments(source, '打开').length > 0);
});

test('only approved translations are applied to a draft', () => {
  const result = applyApprovedSegments(card, [
    {
      pathJson: JSON.stringify(['description']),
      start: null,
      end: null,
      translatedText: '一位来自伦敦的侦探。',
      finalText: null,
      reviewStatus: 'approved',
    },
    {
      pathJson: JSON.stringify(['name']),
      start: null,
      end: null,
      translatedText: '爱丽丝',
      finalText: null,
      reviewStatus: 'pending',
    },
  ]);

  assert.equal(result.description, '一位来自伦敦的侦探。');
  assert.equal(result.name, 'Alice');
  assert.equal(card.description, 'A detective from London.');
});

test('large multilingual fields only expose chunked text from the first language branch', () => {
  const korean = '한국어로 작성된 번역 대상 문장입니다. '.repeat(450);
  const english = 'This duplicate English branch should stay untouched. '.repeat(220);
  const source = [
    '{{#if {{equal::{{getvar::story_lang}}::ko}}}}',
    '<img="portrait">',
    korean,
    '<GKS_HIDDEN>Do not translate this hidden instruction.</GKS_HIDDEN>',
    '{{/if}}',
    '{{#if {{equal::{{getvar::story_lang}}::en}}}}',
    english,
    '{{/if}}',
  ].join('\n');
  const largeCard = { data: { first_mes: source } };
  const segments = scanCard(largeCard, 'core');

  assert.ok(segments.length > 1);
  assert.ok(segments.every((segment) => segment.kind === 'structured-text'));
  assert.ok(segments.every((segment) => segment.sourceText.includes('한국어')));
  assert.ok(segments.every((segment) => !segment.sourceText.includes('English')));
  assert.ok(segments.every((segment) => segment.sourceText.length <= 3_000));

  const first = segments[0];
  const translated = applyApprovedSegments(largeCard, [{
    pathJson: JSON.stringify(first.path),
    sourceText: first.sourceText,
    start: first.start,
    end: first.end,
    translatedText: '已翻译的可见文本。',
    finalText: null,
    reviewStatus: 'approved',
    kind: first.kind,
  }]);
  const result = translated.data.first_mes;
  assert.match(result, /已翻译的可见文本/);
  assert.match(result, /This duplicate English branch should stay untouched/);
  assert.match(result, /<GKS_HIDDEN>Do not translate this hidden instruction\.<\/GKS_HIDDEN>/);
  assert.match(result, /\{\{#if \{\{equal::\{\{getvar::story_lang\}\}::ko\}\}\}\}/);
});

test('export filename starts with the translated card name', () => {
  const translated = structuredClone(card);
  translated.name = '爱丽丝';

  assert.equal(cardExportName(translated, 'Alice'), '爱丽丝 - Alice');
  assert.equal(cardExportName(card, 'Alice'), 'Alice');
  assert.equal(cardExportName(card, 'Alice', '爱丽丝'), '爱丽丝 - Alice');
  assert.equal(cardExportName(card, 'Alice', '爱丽丝 - Alice'), '爱丽丝 - Alice');
});

test('module export names keep the translated title before the original title', () => {
  assert.equal(bilingualModuleName('美少女宇宙', 'Bishoujo Universe'), '美少女宇宙 - Bishoujo Universe');
  assert.equal(bilingualModuleName('美少女宇宙', '美少女宇宙 - Bishoujo Universe'), '美少女宇宙 - Bishoujo Universe');
  assert.equal(bilingualModuleName('中文原版', '中文原版'), '中文原版');
});

test('Risu module names are included outside script-only scopes', () => {
  const segments = scanRisuModule({ name: 'UnderArrest Extra Assets' }, 'standard');

  assert.equal(segments.length, 1);
  assert.deepEqual(segments[0].path, ['$module', 'name']);
  assert.equal(segments[0].category, 'name');
  assert.equal(segments[0].sourceText, 'UnderArrest Extra Assets');
});

test('Risu module namespace stays out of ordinary translation candidates', () => {
  const segments = scanRisuModule({
    namespace: 'mahou_shoujo_ni_akogarete',
    metadata: 'Translatable metadata',
  }, 'all');

  const namespace = segments.find((segment) => segment.path.at(-1) === 'namespace');
  assert.equal(namespace, undefined);
  assert.equal(segments.some((segment) => segment.sourceText === 'Translatable metadata'), true);
});

test('Risu module runtime prompts are opt-in script segments', () => {
  const module = {
    trigger: [{ effect: [{ code: 'alertError(triggerId, "패널 리롤 대상 없음")' }] }],
  };

  assert.deepEqual(scanRisuModule(module, 'standard'), []);
  const segments = scanRisuModule(module, 'visible-scripts');
  const prompt = segments.find((segment) => segment.sourceText === '패널 리롤 대상 없음');

  assert.ok(prompt);
  assert.equal(prompt.kind, 'runtime-message');
  assert.equal(prompt.category, 'script-ui');
  assert.match(prompt.pathLabel, /^模块\.trigger\.0\.effect\.0\.code · 行 \d+，列 \d+$/);
});

test('Risu Lua scanning does not treat code around angle brackets as visible HTML', () => {
  const module = {
    trigger: [{ effect: [{ code: [
      'local block = "<THGY_HIDDEN>"',
      '-- wrapper such as <THGY_HIDDEN>; cleanup must never',
      "block = block:gsub('<[^>\\r\\n]+>', function(tag)",
      '  return tag',
      'end)',
      'alertError(triggerId, "패널 리롤 대상 없음")',
    ].join('\n') }] }],
  };

  const segments = scanRisuModule(module, 'visible-scripts');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, 'runtime-message');
});

test('complete scanning extracts Lua prompt strings by AST range', () => {
  const code = [
    'local parts = {',
    '  "Use concise Korean if the scene is Korean. Do not add markdown.",',
    '}',
    'alertError(triggerId, "패널 리롤 대상 없음")',
  ].join('\n');
  const module = { trigger: [{ effect: [{ code }] }] };
  const segments = scanRisuModule(module, 'all-visible');
  const prompt = segments.find((segment) => segment.kind === 'lua-string');

  assert.equal(prompt?.sourceText, 'Use concise Korean if the scene is Korean. Do not add markdown.');
  assert.equal(code.slice(prompt?.start ?? 0, prompt?.end ?? 0), prompt?.sourceText);
  assert.ok(segments.some((segment) => segment.kind === 'runtime-message'));
});

test('complete scanning exposes Korean story-language defaults', () => {
  const code = 'if value == "0" then writeVar(triggerId, "th_story_lang", "ko") end';
  const module = { trigger: [{ effect: [{ code }] }] };
  const language = scanRisuModule(module, 'all-visible').find((segment) => segment.kind === 'lua-language');

  assert.equal(language?.sourceText, 'ko');
  assert.equal(code.slice(language?.start ?? 0, language?.end ?? 0), 'ko');
});

test('Lua-only scanning extracts text formats without card or module markup fields', () => {
  const longText = 'Write the scene in Korean.\nKeep the character voice consistent.';
  const code = [
    'local spell = "hakurei_reimu|Fantasy Seal"',
    `local prompt = [=[${longText}]=]`,
    'local pattern = "%s*<!%-%- THGY_START %-%->[%s%S]-THGY_END"',
    'local html = \'<button title="Open map">Open map</button>\'',
    'alertError(triggerId, "패널 리롤 대상 없음")',
  ].join('\n');
  const module = {
    trigger: [{ effect: [{ code }] }],
    regex: [{ out: '<div>Background label</div>' }],
  };
  const segments = scanRisuModule(module, 'lua-only');

  assert.deepEqual(scanCard(card, 'lua-only'), []);
  assert.equal(segments.some((segment) => segment.sourceText === 'Background label'), false);
  assert.equal(segments.some((segment) => segment.sourceText.includes('THGY_START')), false);
  assert.equal(segments.some((segment) => segment.sourceText.includes('%s')), false);

  const formatted = segments.find((segment) => segment.kind === 'lua-formatted');
  assert.equal(formatted?.sourceText, 'Fantasy Seal');
  assert.equal(code.slice(formatted?.start ?? 0, formatted?.end ?? 0), 'Fantasy Seal');

  const long = segments.find((segment) => segment.kind === 'lua-long-string');
  assert.equal(long?.sourceText, longText);
  assert.equal(code.slice(long?.start ?? 0, long?.end ?? 0), `[=[${longText}]=]`);
  assert.ok(segments.some((segment) => segment.kind === 'lua-attribute' && segment.sourceText === 'Open map'));
  assert.ok(segments.some((segment) => segment.kind === 'lua-text-node' && segment.sourceText === 'Open map'));
  assert.ok(segments.some((segment) => segment.kind === 'runtime-message'));
});

test('Lua long-string HTML fragments expose labels split around dynamic values', () => {
  const module = {
    trigger: [{ effect: [{ code: [
      'local name = "Alice"',
      'local panel = [[<div class="card-name">이름: ]] .. name .. [[</div>]]',
      'local empty = [[<div class="empty-state">현재 포로가 없습니다.</div>]]',
      'local button = [[<img alt="도구"><button risu-btn="keep_action">저장</button>]]',
    ].join('\n') }] }],
  };
  const segments = scanRisuModule(module, 'all-visible');
  assert.ok(segments.some((segment) => segment.kind === 'lua-text-node' && segment.sourceText === '이름:'));
  assert.ok(segments.some((segment) => segment.kind === 'lua-text-node' && segment.sourceText === '현재 포로가 없습니다.'));
  assert.ok(segments.some((segment) => segment.kind === 'lua-attribute' && segment.sourceText === '도구'));
  assert.ok(segments.some((segment) => segment.kind === 'lua-text-node' && segment.sourceText === '저장'));
});

test('string.format long-string HTML exposes visible labels without translating percent placeholders', () => {
  const module = {
    trigger: [{ effect: [{ code: [
      'local panel = string.format([[',
      '<div style="width: 100%%"><h3 style="color: %s">조교 완급조절</h3>',
      '<span style="display:none">(OOC: corruption_turbo_mode=OFF)</span>',
      '<span class="btn-desktop">포로의 고통을 즐긴다</span></div>',
      ']], color)',
      'local pattern = "<Scene%s+seed=.->%s*(.-)%s*</Scene>"',
    ].join('\n') }] }],
  };
  const segments = scanRisuModule(module, 'all-visible');

  assert.ok(segments.some((segment) => segment.kind === 'lua-text-node' && segment.sourceText === '조교 완급조절'));
  assert.ok(segments.some((segment) => segment.kind === 'lua-text-node' && segment.sourceText === '포로의 고통을 즐긴다'));
  assert.equal(segments.some((segment) => segment.sourceText.includes('%s') || segment.sourceText.includes('%%')), false);
  assert.equal(segments.some((segment) => segment.sourceText.includes('corruption_turbo_mode')), false);
});

test('dynamic Lua HTML labels translate without changing concatenation structure', () => {
  const module = {
    trigger: [{ effect: [{ code: 'local panel = [[<div class="card-name">이름: ]] .. name .. [[</div>]]' }] }],
  };
  const label = scanRisuModule(module, 'all-visible').find((segment) => segment.sourceText === '이름:');
  assert.ok(label);
  const result = applyRisuModuleSegments(module, [{
    pathJson: JSON.stringify(label.path.slice(1)),
    start: label.start,
    end: label.end,
    sourceText: label.sourceText,
    translatedText: '名称:',
    finalText: null,
    reviewStatus: 'approved',
    kind: label.kind,
  }]);
  const code = (result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;

  assert.equal(code, 'local panel = [[<div class="card-name">名称: ]] .. name .. [[</div>]]');
  assert.deepEqual(result.syntaxIssues, []);
});

test('Risu module application accepts scanner-owned module paths', () => {
  const module = { name: 'Original module name' };
  const result = applyRisuModuleSegments(module, [{
    pathJson: JSON.stringify(['$module', 'name']),
    sourceText: 'Original module name',
    start: null,
    end: null,
    translatedText: '翻译后的模块名',
    finalText: null,
    reviewStatus: 'approved',
  }]);

  assert.equal(result.draft.name, '翻译后的模块名');
});

test('Risu module application translates namespace and synchronizes internal asset protocols', () => {
  const module = {
    namespace: 'mahou_shoujo_ni_akogarete',
    trigger: [{ effect: [{ code: 'return {{module_assetlist::mahou_shoujo_ni_akogarete}}' }] }],
  };
  const result = applyRisuModuleSegments(module, [{
    pathJson: JSON.stringify(['namespace']),
    sourceText: module.namespace,
    start: null,
    end: null,
    translatedText: '憧憬魔法少女',
    finalText: null,
    reviewStatus: 'approved',
  }]);

  assert.equal(result.draft.namespace, '憧憬魔法少女');
  assert.equal((result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code, 'return {{module_assetlist::憧憬魔法少女}}');
});

test('Risu module reconstruction starts from the original before replaying stored ranges', () => {
  const original = {
    trigger: [{ effect: [{ code: 'local label = "Open map"\nlocal marker = "keep"' }] }],
  };
  const segment = scanRisuModule(original, 'lua-only').find((entry) => entry.sourceText === 'Open map');
  assert.ok(segment);
  const storedSegment = {
    pathJson: JSON.stringify(segment.path.slice(1)),
    start: segment.start,
    end: segment.end,
    sourceText: segment.sourceText,
    translatedText: '打开地图并显示路线',
    finalText: null,
    reviewStatus: 'approved' as const,
    kind: segment.kind,
  };
  const draft = applyRisuModuleSegments(original, [storedSegment]).draft;
  const rebuilt = applyRisuModuleSegments(original, [storedSegment]);

  assert.notEqual((draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code, original.trigger[0].effect[0].code);
  assert.deepEqual(rebuilt.draft, draft);
  assert.deepEqual(rebuilt.syntaxIssues, []);
});

test('Lua formatted and long strings write back without changing code structure', () => {
  const code = [
    'local spell = "hakurei_reimu|Fantasy Seal"',
    'local prompt = [[Write the scene in Korean.]]',
    'local html = \'<button title="Open map">Open map</button>\'',
  ].join('\n');
  const module = { trigger: [{ effect: [{ code }] }] };
  const scanned = scanRisuModule(module, 'lua-only');
  const segments = scanned.map((segment) => ({
    pathJson: JSON.stringify(segment.path.slice(1)),
    sourceText: segment.sourceText,
    start: segment.start,
    end: segment.end,
    translatedText: segment.kind === 'lua-formatted' ? '幻想封印'
      : segment.kind === 'lua-long-string' ? '中文 ]] 长文本'
        : segment.kind === 'lua-attribute' ? "Bob's map"
          : '打开 "地图"',
    finalText: null,
    reviewStatus: 'approved',
    kind: segment.kind,
  }));
  const result = applyRisuModuleSegments(module, segments);
  const translated = (result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;

  assert.match(translated, /"hakurei_reimu\|幻想封印"/);
  assert.match(translated, /\[=\[中文 \]\] 长文本\]=\]/);
  assert.ok(translated.includes('title="Bob\\\'s map">打开 "地图"</button>'));
  assert.deepEqual(result.syntaxIssues, []);
});

test('Lua long strings ending in a closing bracket use a non-overlapping delimiter', () => {
  const code = 'local prompt = [=[Original JSON example]=]';
  const module = { trigger: [{ effect: [{ code }] }] };
  const segment = scanRisuModule(module, 'lua-only').find((entry) => entry.kind === 'lua-long-string');
  assert.ok(segment);
  const result = applyRisuModuleSegments(module, [{
    pathJson: JSON.stringify(segment.path.slice(1)),
    sourceText: segment.sourceText,
    start: segment.start,
    end: segment.end,
    translatedText: '正确：[{\"line\":1}]',
    finalText: null,
    reviewStatus: 'approved',
    kind: segment.kind,
  }]);
  const translated = (result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;

  assert.match(translated, /\[=\[正确：\[\{\"line\":1\}\]\]=\]/);
  assert.deepEqual(result.syntaxIssues, []);
});

test('Lua long strings preserve original boundary newlines and delimiter when safe', () => {
  const code = 'local prompt = [[Original JSON example: [{"line":1}]\n]]';
  const module = { trigger: [{ effect: [{ code }] }] };
  const segment = scanRisuModule(module, 'lua-only').find((entry) => entry.kind === 'lua-long-string');
  assert.ok(segment);
  const result = applyRisuModuleSegments(module, [{
    pathJson: JSON.stringify(segment.path.slice(1)),
    sourceText: segment.sourceText,
    start: segment.start,
    end: segment.end,
    translatedText: '正确：[{"line":1}]',
    finalText: null,
    reviewStatus: 'approved',
    kind: segment.kind,
  }]);
  const translated = (result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;

  assert.equal(translated, 'local prompt = [[正确：[{"line":1}]\n]]');
  assert.deepEqual(result.syntaxIssues, []);
});

test('legacy generic translations inside Lua code are ignored', () => {
  const code = [
    'local block = "<THGY_HIDDEN>"',
    "block = block:gsub('<[^>\\r\\n]+>', function(tag)",
    '  return tag',
    'end)',
  ].join('\n');
  const module = { trigger: [{ effect: [{ code }] }] };
  const result = applyRisuModuleSegments(module, [{
    pathJson: JSON.stringify(['trigger', 0, 'effect', 0, 'code']),
    sourceText: '; cleanup must never\nblock = block:gsub(\'',
    start: 30,
    end: 80,
    translatedText: '清理绝不能删除受保护内容。',
    finalText: null,
    reviewStatus: 'approved',
    kind: 'text-node',
  }]);

  assert.equal(result.ignoredLuaSegments, 1);
  assert.equal((result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code, code);
  assert.deepEqual(result.syntaxIssues, []);
});

test('changed Risu Lua is syntax checked before export', () => {
  const original = { trigger: [{ effect: [{ code: 'local value = 1\nreturn value' }] }] };
  const broken = { trigger: [{ effect: [{ code: 'local value = 1\nend)' }] }] };
  const issues = validateRisuLuaChanges(original, broken);

  assert.equal(issues.length, 1);
  assert.equal(issues[0].pathLabel, '模块.trigger.0.effect.0.code');
});

test('Risu Lua syntax diagnostics include the source and draft error line', () => {
  const original = { trigger: [{ effect: [{ code: 'local depicted_flashback = true\nreturn depicted_flashback' }] }] };
  const broken = { trigger: [{ effect: [{ code: 'local depicted_flashback = true\n那 return depicted_flashback' }] }] };
  const [issue] = validateRisuLuaChanges(original, broken);

  assert.equal(issue.line, 2);
  assert.equal(issue.column, 1);
  assert.equal(issue.sourceLine, 'return depicted_flashback');
  assert.equal(issue.draftLine, '那 return depicted_flashback');
  assert.equal(issue.pathJson, JSON.stringify(['trigger', 0, 'effect', 0, 'code']));
});

test('Risu Lua diagnostics identify a Chinese character inserted into an identifier', () => {
  const sourceLine = 'if direct_reference and not fact.depicted_flashback then return end';
  const original = { trigger: [{ effect: [{ code: `local fact = { depicted_flashback = true }\n${sourceLine}` }] }] };
  const broken = { trigger: [{ effect: [{ code: `local fact = { depicted_flashback = true }\n${sourceLine.replace('depicted_flashback', 'depicted_flash那back')}` }] }] };
  const [issue] = validateRisuLuaChanges(original, broken);

  assert.equal(issue.line, 2);
  assert.equal(issue.column, 48);
  assert.equal(issue.message, "[2:48] unexpected symbol '那' near 'depicted_flash'");
  assert.equal(issue.draftLine, 'if direct_reference and not fact.depicted_flash那back then return end');
  assert.deepEqual(issue.contextLines, [
    { line: 1, sourceLine: 'local fact = { depicted_flashback = true }', draftLine: 'local fact = { depicted_flashback = true }', errorLine: false },
    { line: 2, sourceLine, draftLine: 'if direct_reference and not fact.depicted_flash那back then return end', errorLine: true },
  ]);
});

test('Risu Lua syntax context keeps bounded nearby lines for expandable editing', () => {
  const sourceLines = [
    'local fact = { depicted_flashback = true }',
    'local a = 2',
    'local b = 3',
    'local c = 4',
    'if direct_reference and not fact.depicted_flashback then return end',
    'local f = 6',
    'local g = 7',
    'local h = 8',
    'local i = 9',
  ];
  const original = { trigger: [{ effect: [{ code: sourceLines.join('\n') }] }] };
  const broken = { trigger: [{ effect: [{ code: sourceLines.map((line, index) => index === 4 ? line.replace('depicted_flashback', 'depicted_flash那back') : line).join('\n') }] }] };
  const [issue] = validateRisuLuaChanges(original, broken);

  assert.equal(issue.line, 5);
  assert.equal(issue.contextLines?.length, 9);
  assert.equal(issue.contextLines?.[0]?.line, 1);
  assert.equal(issue.contextLines?.at(-1)?.line, 9);
  assert.equal(issue.contextLines?.find((line) => line.errorLine)?.draftLine, 'if direct_reference and not fact.depicted_flash那back then return end');
});

test('manual Lua syntax line replacement changes only the requested line', () => {
  const module = { trigger: [{ effect: [{ code: 'local value = 1\n那 return value\nprint(value)' }] }] };
  const pathJson = JSON.stringify(['trigger', 0, 'effect', 0, 'code']);
  const result = replaceRisuLuaLine(module, pathJson, 2, 'return value', '那 return value');

  assert.equal(result.ok, true);
  assert.equal(result.previousLine, '那 return value');
  assert.equal((module.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code, 'local value = 1\nreturn value\nprint(value)');
});

test('manual Lua syntax line replacement rejects a stale line', () => {
  const module = { trigger: [{ effect: [{ code: 'return value' }] }] };
  const result = replaceRisuLuaLine(module, JSON.stringify(['trigger', 0, 'effect', 0, 'code']), 1, 'return other', 'old line');

  assert.deepEqual(result, { ok: false, reason: 'stale', currentLine: 'return value' });
  assert.equal((module.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code, 'return value');
});

test('translated Touhou asset indexes supply missing Chinese runtime aliases', () => {
  const code = [
    'local runtimeRoster = [==[[{"id":"cirno","aliases":["チルノ","Cirno"],"sfw":["cirno_angry"]}]]==]',
    'local function thv2_detect_response_owners(text) return text end',
  ].join('\n');
  const module = {
    trigger: [{ effect: [{ code }] }],
  };
  const translatedCard = {
    character_book: {
      entries: [{ content: '<TouhouAssetIndexV2>\n- `cirno` = 琪露诺 [SFW:G1, NSFW, Spell]\n</TouhouAssetIndexV2>' }],
    },
  };

  assert.deepEqual(inspectRuntimeAliasCoverage(module, 'zh-CN'), []);
  assert.deepEqual(inspectRuntimeAliasCoverage(module, 'zh-CN', translatedCard), [{
    pathLabel: '模块.trigger.0.effect.0.code',
    ownerId: 'cirno',
    alias: '琪露诺',
  }]);

  const result = applyRisuModuleSegments(module, [], 'zh-CN', translatedCard);
  const repaired = (result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;
  assert.match(repaired, /"aliases":\["チルノ","Cirno","琪露诺"\]/);
  assert.equal(result.runtimeAliasAdditions, 1);
  assert.deepEqual(inspectRuntimeAliasCoverage(result.draft, 'zh-CN', translatedCard), []);
  assert.deepEqual(result.syntaxIssues, []);

  const reapplied = applyRisuModuleSegments(result.draft, [], 'zh-CN', translatedCard);
  assert.equal(reapplied.runtimeAliasAdditions, 0);
  assert.equal((reapplied.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code, repaired);
});

test('portrait routing detection gates proper-name candidates and ignores spell indexes', () => {
  const code = [
    'local THGY_TW_TARGET_ALIASES = {',
    '  { label = "이자요이 사쿠야", aliases = {"izayoi_sakuya", "十六夜咲夜", "咲夜"} },',
    '}',
    'local runtimeRoster = [==[[{"id":"izayoi_sakuya","aliases":["이자요이 사쿠야"]}]]==]',
    'local spellIndex = "THGY_SIGNATURE_SPELL_INDEX\\n- izayoi_sakuya: 幻想风靡 -> <img=\\\"izayoi_sakuya_unique_spell\\\">"',
    'return "<img=\\\"izayoi_sakuya_default\\\">"',
  ].join('\\n');
  const module = { trigger: [{ effect: [{ code }] }] };

  assert.equal(detectRisuPortraitRouting(module).detected, true);
  const candidates = collectRuntimeAliasCandidates(module, 'zh-CN', {
    character_book: { entries: [{ content: 'izayoi_sakuya: 十六夜咲夜 [SFW:G1]' }] },
  });
  assert.ok(candidates.some((candidate) => candidate.ownerId === 'izayoi_sakuya' && candidate.name === '十六夜咲夜'));
  assert.equal(candidates.some((candidate) => candidate.name.includes('幻想风靡')), false);
});

test('portrait routing detection stays off for ordinary Lua text', () => {
  const module = { trigger: [{ effect: [{ code: 'return "角色走进房间并开始对话"' }] }] };
  assert.equal(detectRisuPortraitRouting(module).detected, false);
});

test('translated Chinese full names add unique short runtime aliases', () => {
  const code = 'local roster = [==[[{"id":"izayoi_sakuya","aliases":["十六夜咲夜"],"sfw":["izayoi_sakuya_default"]}]]==]';
  const module = { trigger: [{ effect: [{ code }] }] };
  const translatedCard = {
    character_book: {
      entries: [{ content: '<TouhouAssetIndexV2>\n- `izayoi_sakuya` = 十六夜咲夜 [SFW:G1, NSFW, Spell]\n</TouhouAssetIndexV2>' }],
    },
  };

  const result = applyRisuModuleSegments(module, [], 'zh-CN', translatedCard);
  const codeAfter = (result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;
  assert.match(codeAfter, /十六夜咲夜/);
  assert.match(codeAfter, /咲夜/);
  assert.equal(result.runtimeAliasAdditions, 1);
  assert.deepEqual(inspectRuntimeAliasCoverage(result.draft, 'zh-CN', translatedCard), []);
});

test('ambiguous Chinese short aliases are not added to runtime catalogs', () => {
  const code = 'local roster = [==[[{"id":"one","aliases":["十六夜咲夜"]},{"id":"two","aliases":["红魔咲夜"]}]]==]';
  const module = { trigger: [{ effect: [{ code }] }] };
  const translatedCard = {
    character_book: {
      entries: [
        { content: 'one = 十六夜咲夜 [SFW:G1]' },
        { content: 'two = 红魔咲夜 [SFW:G1]' },
      ],
    },
  };

  const result = applyRisuModuleSegments(module, [], 'zh-CN', translatedCard);
  const codeAfter = (result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;
  assert.equal(codeAfter.includes('"咲夜"'), false);
  assert.equal(result.runtimeAliasAdditions, 0);
});

test('LLM runtime name segmentation keeps only contiguous valid tokens', () => {
  const result = normalizeRuntimeNameSegments(JSON.stringify({ segments: [
    { ownerId: 'izayoi_sakuya', tokens: ['咲夜', '十六夜', '不存在', 'Sakuya'] },
    { ownerId: 'bad id', tokens: ['坏'] },
  ] }), [
    { ownerId: 'izayoi_sakuya', name: '十六夜咲夜' },
  ]);
  assert.deepEqual(result, { izayoi_sakuya: ['咲夜', '十六夜'] });
});

test('runtime catalog discovery handles nested JSON and ordinary quoted Lua strings', () => {
  const catalog = JSON.stringify({ roster: [{ id: 'reimu', aliases: ['Reimu'] }], unrelated: [{ id: 'x', value: 1 }] });
  const module = { trigger: [{ effect: [{ code: `local roster = ${JSON.stringify(catalog)}` }] }] };
  const card = { character_book: { entries: [{ content: 'characters:\n- reimu -> 博丽灵梦 [SFW:G1]' }] } };

  const result = applyRisuModuleSegments(module, [], 'zh-CN', card);
  const code = (result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;
  assert.equal(code.includes('\\"id\\":\\"reimu\\"') && code.includes('\\"博丽灵梦\\"'), true);
  assert.equal(code.includes('\\"id\\":\\"x\\"') && code.includes('\\"value\\":1'), true);
  assert.equal(result.runtimeAliasAdditions, 2);
  assert.deepEqual(inspectRuntimeAliasCoverage(result.draft, 'zh-CN', card), []);
});

test('recognized Touhou prompts follow the selected sidebar language', () => {
  const code = [
    'local function readVar(triggerId, key) return "" end',
    'local function writeVar(triggerId, key, value) end',
    'local function TH_IsValidUILang(lang)',
    '  return lang == "ko" or lang == "en" or lang == "zh" or lang == "ja"',
    'end',
    'local function TH_SetStoryLang(triggerId, lang)',
    '  writeVar(triggerId, "th_story_lang", lang)',
    'end',
    'local function TH_SetSidebarLang(triggerId, lang)',
    '  writeVar(triggerId, "th_sidebar_lang", lang)',
    'end',
    'function set_tab_work(triggerId) end',
    'local function TH_NewsInit(triggerId)',
    '  local init = getChatVar(triggerId, "news_init")',
    '  TH_NewsSet(triggerId, "news_headline", "환상향, 오늘도 평화")',
    '  TH_NewsSet(triggerId, "news_weather", "맑음")',
    '  TH_NewsSet(triggerId, "news_aya_comment", "특별한 사건은 없습니다. 한가롭군요.")',
    'end',
    'local function TH_NewsApply(triggerId, headline, weather, dangerRaw, aya)',
    '  TH_NewsSet(triggerId, "news_headline", TH_NewsCleanText(headline, "환상향, 오늘도 평화", 80))',
    '  TH_NewsSet(triggerId, "news_weather", TH_NewsCleanText(weather, "맑음", 40))',
    '  TH_NewsSet(triggerId, "news_aya_comment", TH_NewsCleanText(aya, "특별한 사건은 없습니다. 한가롭군요.", 160))',
    'end',
    'local function TH_NewsAuxUpdate(triggerId)',
    '  local _parts = {',
    '    "Use concise Korean if the scene is Korean. Do not add markdown. Headline <= 40 Korean chars. Aya comment <= 80 Korean chars.",',
    '  }',
    'end',
  ].join('\n');
  const module = { trigger: [{ effect: [{ code }] }] };
  const result = applyRisuModuleSegments(module, []);
  const bridged = (result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;

  assert.match(bridged, /readVar\(triggerId, "th_sidebar_lang"\)/);
  assert.match(bridged, /TH_SelectedOutputLanguage\(triggerId\).*headline, weather, and aya/);
  assert.match(bridged, /TH_SelectedNewsDefaults\(triggerId\)/);
  assert.match(bridged, /setChatVar\(triggerId, "news_init", "false"\)/);
  assert.deepEqual(result.syntaxIssues, []);

  const reapplied = applyRisuModuleSegments(result.draft, []);
  const reappliedCode = (reapplied.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;
  assert.equal(reappliedCode, bridged);
  assert.deepEqual(reapplied.syntaxIssues, []);
});

test('runtime prompt translations are escaped before script replacement', () => {
  const module = {
    trigger: [{ effect: [{ code: 'alertError(triggerId, "패널 리롤 대상 없음")' }] }],
  };
  const prompt = scanRisuModule(module, 'visible-scripts')[0];
  const result = applyApprovedSegments(module, [{
    pathJson: JSON.stringify(prompt.path.slice(1)),
    start: prompt.start,
    end: prompt.end,
    translatedText: null,
    finalText: '没有可供"面板"\n重试的目标',
    reviewStatus: 'approved',
    kind: prompt.kind,
  }]);
  const code = (result.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;

  assert.equal(code, 'alertError(triggerId, "没有可供\\"面板\\"\\n重试的目标")');
});

test('Lua prompt translations are escaped before script replacement', () => {
  const module = {
    trigger: [{ effect: [{ code: 'local prompt = "Use concise Korean for the headline."' }] }],
  };
  const prompt = scanRisuModule(module, 'all-visible').find((segment) => segment.kind === 'lua-string');
  assert.ok(prompt);
  const result = applyApprovedSegments(module, [{
    pathJson: JSON.stringify(prompt.path.slice(1)),
    start: prompt.start,
    end: prompt.end,
    translatedText: null,
    finalText: '标题只用简体中文，不要使用"韩文"。',
    reviewStatus: 'approved',
    kind: prompt.kind,
  }]);
  const code = (result.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;

  assert.equal(code, 'local prompt = "标题只用简体中文，不要使用\\"韩文\\"。"');
});

test('approved Lua translations relocate when stored source ranges become stale', () => {
  const original = {
    trigger: [{ effect: [{ code: 'local name = alertInput(triggerId, "방송에서 사용할 닉네임을 설정해주세요."):await()' }] }],
  };
  const prompt = scanRisuModule(original, 'all-visible').find((segment) => segment.sourceText === '방송에서 사용할 닉네임을 설정해주세요.');
  assert.ok(prompt);
  const shifted = {
    trigger: [{ effect: [{ code: `reloadDisplay(triggerId)\n${original.trigger[0].effect[0].code}` }] }],
  };
  const result = applyRisuModuleSegments(shifted, [{
    pathJson: JSON.stringify(prompt.path.slice(1)),
    start: prompt.start,
    end: prompt.end,
    sourceText: prompt.sourceText,
    translatedText: '请设置要在直播中使用的昵称。',
    finalText: null,
    reviewStatus: 'approved',
    kind: prompt.kind,
  }]);
  const code = (result.draft.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code;

  assert.match(code, /alertInput\(triggerId, "请设置要在直播中使用的昵称。"\)/);
  assert.deepEqual(result.syntaxIssues, []);
});

test('stale Lua literal offsets cannot replace identifier text', () => {
  const module = {
    trigger: [{ effect: [{ code: 'if direct_reference and not fact.depicted_flashback then reference_ttl = 8 end' }] }],
  };
  const code = module.trigger[0].effect[0].code;
  const start = code.indexOf('back then');
  const result = applyApprovedSegments(module, [{
    pathJson: JSON.stringify(['trigger', 0, 'effect', 0, 'code']),
    start,
    end: start + 'back then'.length,
    sourceText: 'back then',
    translatedText: '那时',
    finalText: null,
    reviewStatus: 'approved',
    kind: 'lua-string',
  }]);

  assert.equal((result.trigger as Array<{ effect: Array<{ code: string }> }>)[0].effect[0].code, code);
});
