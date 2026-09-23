import test from 'node:test';
import assert from 'node:assert/strict';
import { hasUnsupportedMacros, normalizeStMacros } from '../server/domain/card/st-macro-map.js';
import { unknownMacros as unknownMacrosOf } from '../server/domain/card/preset-capability.js';

test('camelCase ST macro names are folded onto RisuAI lowercase names', () => {
  const result = normalizeStMacros('{{lastMessageId}} {{maxContext}} {{idleDuration}}');
  assert.equal(result.text, '{{lastmessageid}} {{maxcontext}} {{idleduration}}');
  assert.equal(result.changed, true);
  assert.equal(result.unsupported.length, 0);
  assert.deepEqual(result.rewrites.map((rewrite) => rewrite.kind), ['case', 'case', 'case']);
  assert.equal(result.rewrites[0].from, 'lastMessageId');
  assert.equal(result.rewrites[0].to, 'lastmessageid');
});

test('already-valid RisuAI macros pass through untouched', () => {
  const source = '{{settempvar::a::1}}{{gettempvar::a}}{{getvar::x}}{{random::a::b}}{{roll:1d6}}';
  const result = normalizeStMacros(source);
  assert.equal(result.text, source);
  assert.equal(result.changed, false);
  assert.deepEqual(result.rewrites, []);
  assert.deepEqual(result.unsupported, []);
});

test('spelling differences are mapped', () => {
  assert.equal(normalizeStMacros('{{not_equal::a::b}}').text, '{{notequal::a::b}}');
  assert.equal(normalizeStMacros('{{newline}}').text, '{{br}}');
  assert.equal(normalizeStMacros('{{dice:2d6}}').text, '{{roll:2d6}}');
});

test('previous-turn macros map onto their RisuAI equivalents', () => {
  // Found in a real ST preset (`夏瑾 天琴座`): `{{lastUserMessage}}` and
  // `{{lastCharMessage}}` are not in RisuAI's registry and would silently not
  // expand. Both spellings map onto the verified `previous*chat` macros.
  assert.equal(normalizeStMacros('{{lastUserMessage}}').text, '{{previoususerchat}}');
  assert.equal(normalizeStMacros('{{lastCharMessage}}').text, '{{previouscharchat}}');
  assert.equal(normalizeStMacros('{{lastusermessage}}').text, '{{previoususerchat}}');
  assert.deepEqual(normalizeStMacros('{{lastUserMessage}}').unsupported, []);
  assert.deepEqual(unknownMacrosOf('{{lastUserMessage}}'), []);
});

test('{{input}} is deliberately left alone rather than guessed at', () => {
  // RisuAI has no exact equivalent for ST's "current user input"; mapping it to
  // something similar would change behaviour silently, so it must be reported.
  const result = normalizeStMacros('{{input}}');
  assert.equal(result.text, '{{input}}');
  assert.deepEqual(result.unsupported, ['input']);
});

test('incvar and decvar become addvar expressions', () => {
  const inc = normalizeStMacros('{{incvar::counter}}');
  assert.equal(inc.text, '{{addvar::counter::1}}');
  assert.equal(inc.rewrites[0].kind, 'expression');
  assert.equal(normalizeStMacros('{{decvar::counter}}').text, '{{addvar::counter::-1}}');
});

test('block control flow is never touched', () => {
  const source = '{{#when::{{getvar::x}}::gte::1}}A{{:else}}B{{/when}}';
  const result = normalizeStMacros(source);
  assert.equal(result.text, source, '#when / :else / /when must stay verbatim');
  // The nested `getvar` is already canonical, so nothing changes at all.
  assert.equal(result.changed, false);
});

test('nested macros are normalised and counted', () => {
  const result = normalizeStMacros('{{#when::{{getvar::toggleX}}}}on{{/when}}');
  // `toggleX` is an argument, not a macro; nothing to rename here.
  assert.equal(result.text, '{{#when::{{getvar::toggleX}}}}on{{/when}}');

  const nested = normalizeStMacros('{{#when::{{lastMessageId}}}}x{{/when}}');
  assert.equal(nested.text, '{{#when::{{lastmessageid}}}}x{{/when}}');
  assert.equal(nested.rewrites.length, 1);
  assert.equal(nested.rewrites[0].count, 1);
});

test('unknown macros are preserved and reported, never dropped', () => {
  const result = normalizeStMacros('A{{myExtension::x}}B');
  assert.equal(result.text, 'A{{myExtension::x}}B');
  assert.deepEqual(result.unsupported, ['myExtension']);
  assert.equal(result.changed, false);
  assert.deepEqual(result.rewrites, []);
  assert.equal(hasUnsupportedMacros('{{myExtension::x}}'), true);
  assert.equal(hasUnsupportedMacros('{{getvar::x}}'), false);
});

test('repeated occurrences are counted once per rewrite', () => {
  const result = normalizeStMacros('{{lastMessageId}}-{{lastMessageId}}');
  assert.equal(result.rewrites.length, 1);
  assert.equal(result.rewrites[0].count, 2);
});

test('arguments are copied byte for byte', () => {
  const source = '{{setvar::中文键::带 空格 与「引号」的值}}';
  assert.equal(normalizeStMacros(source).text, source);
});

test('text without macros and unterminated macros survive', () => {
  assert.equal(normalizeStMacros('普通正文，没有宏').text, '普通正文，没有宏');
  assert.equal(normalizeStMacros('结尾有个 {{getvar::x').text, '结尾有个 {{getvar::x');
  assert.equal(normalizeStMacros('{{}}').text, '{{}}');
});

test('a realistic ST preset snippet normalises end to end', () => {
  const source = [
    '{{#when::{{getvar::style}}::eq::dark}}',
    '当前时间 {{time}}，上下文 {{maxContext}} tokens，最后一条 #{{lastMessageId}}',
    '{{newline}}',
    '{{incvar::turn}}',
    '{{/when}}',
  ].join('\n');
  const result = normalizeStMacros(source);
  assert.match(result.text, /\{\{maxcontext\}\}/u);
  assert.match(result.text, /\{\{lastmessageid\}\}/u);
  assert.match(result.text, /\{\{br\}\}/u);
  assert.match(result.text, /\{\{addvar::turn::1\}\}/u);
  assert.equal(result.unsupported.length, 0);
  assert.equal(result.changed, true);
});
