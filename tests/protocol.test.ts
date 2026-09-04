import assert from 'node:assert/strict';
import test from 'node:test';
import { applyApprovedSegments, risuControlReferences, scanCard } from '../server/domain/card/card.js';
import {
  discoverProtocols,
  parseProtocols,
  protocolFieldReplacementIssue,
  type ProtocolSchemaRule,
} from '../server/domain/protocol/protocol.js';
import { discoverRisuRegexProtocols, mergeRegexProtocolEvidence } from '../server/domain/protocol/risu-regex-protocol.js';
import { discoverRisuLuaProtocols, mergeLuaProtocolEvidence } from '../server/domain/protocol/risu-lua-protocol.js';

test('custom angle protocols are parsed into stable field ranges', () => {
  const source = '<news|Village Signboard Smashed Again|Clear / busy|1|Fourth incident this month.>';
  const parsed = parseProtocols(source);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'news');
  assert.equal(parsed[0].delimiter, '|');
  assert.deepEqual(parsed[0].fields.map((field) => field.value), [
    'Village Signboard Smashed Again',
    'Clear / busy',
    '1',
    'Fourth incident this month.',
  ]);
  for (const field of parsed[0].fields) {
    assert.equal(source.slice(field.start, field.end), field.value);
  }
});

test('protocol tokenizer ignores delimiters inside quoted or nested values', () => {
  const parsed = parseProtocols('<notice|"A|B"|call(foo|bar)|Visible message>');
  assert.equal(parsed.length, 1);
  assert.deepEqual(parsed[0].fields.map((field) => field.value), [
    '"A|B"',
    'call(foo|bar)',
    'Visible message',
  ]);
});

test('protocol tokenizer accepts localized protocol names', () => {
  const source = '[상태창|없음]';
  const parsed = parseProtocols(source);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, '상태창');
  assert.equal(parsed[0].fields[0].value, '없음');
});

test('labelled status protocols keep the pipe shell and expose only values', () => {
  const source = '[LV:15|Time:10:00 PM|Location:시작의 마을 근처 숲|Tools:녹슨 칼,지도|Magic:없음]';
  const parsed = parseProtocols(source);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'LV');
  assert.equal(parsed[0].delimiter, '|');
  assert.deepEqual(parsed[0].fields.map((field) => field.label), [
    'LV', 'Time', 'Location', 'Tools', 'Magic',
  ]);
  assert.deepEqual(parsed[0].fields.map((field) => field.value), [
    '15', '10:00 PM', '시작의 마을 근처 숲', '녹슨 칼,지도', '없음',
  ]);
  assert.equal(source.slice(parsed[0].start, parsed[0].end), source);
});

test('format declarations and hard references guide local protocol inference', () => {
  const card = {
    description: [
      'Format: <news|headline|weather|danger|aya>',
      '<news|Village Signboard Smashed Again|Clear|1|Fourth incident this month.>',
    ].join('\n'),
  };
  const clusters = discoverProtocols(card, null, [{
    literal: '1',
    kind: 'lua',
    pathLabel: '模块.trigger.0.code',
    pattern: 'state == "1"',
  }]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].fieldRules.map((field) => field.policy), [
    'translate', 'translate', 'protect', 'translate',
  ]);
  assert.equal(clusters[0].fieldRules[2].hardProtected, true);
  assert.equal(clusters[0].occurrenceCount, 1);
});

test('Risu regex grammar takes priority and Lua confirms protocol usage', () => {
  const module = {
    regex: [{
      comment: 'Donation renderer',
      in: '\\[donation\\|([^|]+)\\|(\\d+)\\|([^\\]]*)\\]',
      out: '<b>$1</b><span data-count="$2">$3</span>',
      type: 'editdisplay',
    }],
    trigger: [{ effect: [{ code: 'local value = string.match(text, "%[donation%|")' }] }],
  };
  const references = risuControlReferences(module).map((reference) => ({
    literal: reference.literal,
    kind: reference.kind,
    pathLabel: reference.pathLabel,
    pattern: reference.pattern,
  }));
  const card = { description: '[donation|Alice|100|Thank you!]' };
  const local = discoverProtocols(card, module, references);
  const regex = discoverRisuRegexProtocols(module, references);
  const merged = mergeRegexProtocolEvidence(local, regex);

  assert.equal(local[0].occurrenceCount, 1);
  assert.equal(regex.length, 1);
  assert.equal(merged[0].source, 'regex-lua');
  assert.match(merged[0].declaration, /Lua 联合引用/);
  assert.deepEqual(merged[0].fieldRules.map((field) => field.policy), [
    'translate', 'protect', 'translate',
  ]);
  assert.equal(merged[0].fieldRules[1].hardProtected, true);
});

test('Risu labelled regex protocols bind named slots without changing the shell', () => {
  const module = {
    regex: [{
      comment: 'Status renderer',
      in: '\\[LV:(.+?)\\|Time:(.+?)\\|Location:(.+?)\\|Tools:(.+?)\\|Magic:(.+?)\\]',
      out: '<b>$1</b><span>$2</span><span>$3</span><span>$4</span><span>$5</span>',
      type: 'editdisplay',
    }],
  };
  const regex = discoverRisuRegexProtocols(module);
  assert.equal(regex.length, 1);
  assert.equal(regex[0].delimiter, '|');
  assert.deepEqual(regex[0].fieldRules.map((field) => field.role), [
    'LV', 'Time', 'Location', 'Tools', 'Magic',
  ]);
  assert.deepEqual(regex[0].fieldRules.map((field) => field.policy), [
    'protect', 'protect', 'translate', 'translate', 'translate',
  ]);
  const source = '[LV:15|Time:10:00 PM|Location:森林|Tools:短剑|Magic:无]';
  const local = discoverProtocols({ description: source }, module);
  const merged = mergeRegexProtocolEvidence(local, regex);
  assert.equal(merged[0].signature, regex[0].signature);
  assert.equal(merged[0].fieldRules[0].role, 'LV');
});

test('generic protocol discovery does not treat regex source as a card occurrence', () => {
  const module = {
    regex: [{
      comment: 'News renderer',
      in: '<news\\|([^|]+)\\|([^>]+)>',
      out: '<h2>$1</h2><p>$2</p>',
      type: 'editdisplay',
    }],
    trigger: [{ effect: [{ code: 'local pattern = "<news|([^|]+)|([^>]+)>"' }] }],
  };
  assert.equal(discoverProtocols({}, module).length, 0);
  const regex = discoverRisuRegexProtocols(module);
  assert.equal(regex.length, 1);
  assert.equal(regex[0].occurrenceCount, 0);
  assert.deepEqual(regex[0].fieldRules.map((field) => field.policy), ['translate', 'translate']);
});

test('Lua-only wrapped patterns create protocol slots and protect numeric captures', () => {
  const references = [{
    literal: '%[quest%|([^|]+)|(%d+)%]',
    kind: 'lua' as const,
    pathLabel: '模块.trigger.0.effect.0.code',
    pattern: 'Lua string.match 模式',
  }];
  const local = discoverProtocols({ description: '[quest|Visible title|3]' }, null, references);
  const lua = discoverRisuLuaProtocols(references);
  const merged = mergeLuaProtocolEvidence(local, lua);

  assert.equal(lua.length, 1);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'regex-lua');
  assert.match(merged[0].declaration, /Lua 匹配/);
  assert.equal(merged[0].fieldRules[0].policy, 'translate');
  assert.equal(merged[0].fieldRules[1].policy, 'protect');
  assert.equal(merged[0].fieldRules[1].hardProtected, true);
});

test('Lua protocol discovery ignores ordinary argument matches and wrapper-only captures', () => {
  const references = [
    {
      literal: '^removeItem(%d+)$',
      kind: 'lua' as const,
      pathLabel: '模块.trigger.0.effect.0.code',
      pattern: 'Lua string.match 模式',
    },
    {
      literal: '(%[panel%|.-%])',
      kind: 'lua' as const,
      pathLabel: '模块.trigger.0.effect.0.code',
      pattern: 'Lua string.match 模式',
    },
  ];
  assert.equal(discoverRisuLuaProtocols(references).length, 0);
});

test('Risu regex overrides Lua inference without duplicating the protocol', () => {
  const module = {
    regex: [{
      in: '\\[notice\\|([^\\]]+)\\]',
      out: '<strong>$1</strong>',
      type: 'editdisplay',
    }],
  };
  const references = [{
    literal: '%[notice%|(.*)%]',
    kind: 'lua' as const,
    pathLabel: '模块.trigger.0.effect.0.code',
    pattern: 'Lua string.match 模式',
  }];
  const lua = discoverRisuLuaProtocols(references);
  const regex = discoverRisuRegexProtocols(module, references);
  const merged = mergeRegexProtocolEvidence(mergeLuaProtocolEvidence([], lua), regex);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].fieldRules[0].policy, 'translate');
  assert.match(merged[0].declaration, /Risu 正则/);
  assert.match(merged[0].declaration, /Lua 匹配/);
});

test('approved protocol rules expose only translatable leaf fields', () => {
  const source = 'Opening narration.\n<news|Village Signboard Smashed Again|Clear|1|Fourth incident this month.>\nClosing narration.';
  const discovered = discoverProtocols({ description: source }, null)[0];
  const schema: ProtocolSchemaRule = {
    signature: discovered.signature,
    name: discovered.name,
    form: discovered.form,
    opener: discovered.opener,
    closer: discovered.closer,
    delimiter: discovered.delimiter,
    fieldCount: discovered.fieldCount,
    status: 'approved',
    fieldRules: discovered.fieldRules.map((field) => ({
      ...field,
      policy: field.index === 3 ? 'protect' : 'translate',
    })),
  };
  const segments = scanCard({ data: { description: source } }, 'core', [], [schema]);
  const protocolFields = segments.filter((segment) => segment.kind === 'protocol-field');
  assert.deepEqual(protocolFields.map((segment) => segment.sourceText), [
    'Village Signboard Smashed Again',
    'Clear',
    'Fourth incident this month.',
  ]);
  assert.deepEqual(protocolFields.map((segment) => segment.protocolDelimiter), ['|', '|', '|']);
  assert.equal(segments.some((segment) => segment.sourceText.includes('<news|')), false);
  assert.equal(segments.filter((segment) => segment.kind === 'structured-text').length, 2);
});

test('protocol declarations keep role placeholders out of the translation queue', () => {
  const source = '[SOLDIER_CREATE:soldier_1:name:gender:species:42:180:pregnancy_status:description]\n'
    + '[SOLDIER_CREATE:soldier_1:가비엘:남:고블린 프린스:42:180:임신 중:왕자의 설명]';
  const discovered = discoverProtocols({ description: source }, null)[0];
  const schema: ProtocolSchemaRule = {
    signature: discovered.signature,
    name: discovered.name,
    form: discovered.form,
    opener: discovered.opener,
    closer: discovered.closer,
    delimiter: discovered.delimiter,
    fieldCount: discovered.fieldCount,
    status: 'approved',
    fieldRules: discovered.fieldRules.map((field) => ({
      ...field,
      role: ['id', 'name', 'gender', 'species', 'level', 'health', 'pregnancy', 'description'][field.index - 1],
      policy: [2, 3, 4, 7, 8].includes(field.index) ? 'translate' : 'protect',
    })),
  };
  const fields = scanCard({ data: { description: source } }, 'core', [], [schema])
    .filter((segment) => segment.kind === 'protocol-field')
    .map((segment) => segment.sourceText);

  assert.deepEqual(fields, ['가비엘', '남', '고블린 프린스', '임신 중', '왕자의 설명']);
});

test('protocol field replacements reject structural delimiters', () => {
  assert.equal(protocolFieldReplacementIssue('天气: 晴朗', '|', '天气: Clear'), null);
  assert.match(protocolFieldReplacementIssue('标题|正文', '|', 'Headline') ?? '', /分隔符/);
  assert.equal(protocolFieldReplacementIssue('标题|正文', ':', 'Title|Body'), null);
  assert.match(protocolFieldReplacementIssue('天气: 晴朗', ':', 'Weather') ?? '', /分隔符/);
  assert.match(protocolFieldReplacementIssue('line one\nline two', '|') ?? '', /换行/);
});

test('protocol field replacements may translate source placeholders but cannot change their shell', () => {
  const source = '"이벤트_[이벤트명]을 시작합니다." OR NORMAL';
  assert.equal(protocolFieldReplacementIssue('"开始 이벤트_[이벤트명]。" OR NORMAL', null, source), null);
  assert.equal(protocolFieldReplacementIssue('"开始[事件名称]事件。" OR NORMAL', null, source), null);
  assert.match(protocolFieldReplacementIssue('"开始 [[이벤트명]]。" OR NORMAL', null, source) ?? '', /结构边界符/);
});

test('approved protocol leaf translations rebuild the original wrapper exactly', () => {
  const source = '<news|Village Signboard Smashed Again|Clear|1|Fourth incident this month.>';
  const card = { data: { description: source } };
  const discovered = discoverProtocols(card, null)[0];
  const schema: ProtocolSchemaRule = {
    signature: discovered.signature,
    name: discovered.name,
    form: discovered.form,
    opener: discovered.opener,
    closer: discovered.closer,
    delimiter: discovered.delimiter,
    fieldCount: discovered.fieldCount,
    status: 'approved',
    fieldRules: discovered.fieldRules.map((field) => ({ ...field, policy: field.index === 3 ? 'protect' : 'translate' })),
  };
  const translations = new Map([
    ['Village Signboard Smashed Again', '村里招牌又被砸烂'],
    ['Clear', '晴'],
    ['Fourth incident this month.', '这是本月第四次事件。'],
  ]);
  const applicable = scanCard(card, 'core', [], [schema])
    .filter((segment) => segment.kind === 'protocol-field')
    .map((segment) => ({
      pathJson: JSON.stringify(segment.path),
      sourceText: segment.sourceText,
      start: segment.start,
      end: segment.end,
      translatedText: translations.get(segment.sourceText) ?? null,
      finalText: null,
      reviewStatus: 'approved',
      kind: segment.kind,
    }));
  const draft = applyApprovedSegments(card, applicable);
  assert.equal(
    (draft.data as Record<string, unknown>).description,
    '<news|村里招牌又被砸烂|晴|1|这是本月第四次事件。>',
  );
});
