import { luaSourceReference } from '../server/domain/lua/syntax-context.js';
import { buildReviewedDraft } from '../server/application/export/reviewed-draft.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceRisuLuaLine, validateRisuLuaChanges } from '../server/domain/lua/risu-lua.js';

test('syntax context locates original function after inserted draft lines', () => {
  const source = 'local marker = 1\nlocal function starts_any(text)\n  return text\nend';
  const draft = '-- extra\n\nlocal marker = 1\nlocal function starts_用_any(text)\n  return text\nend';
  const wrap = (code: string) => ({ trigger: [{ effect: [{ code }] }] });
  const [issue] = validateRisuLuaChanges(wrap(source), wrap(draft));
  assert.equal(issue.line, 4);
  assert.equal(issue.sourceLineNumber, 2);
  assert.equal(issue.sourceLine, 'local function starts_any(text)');
  assert.equal(issue.sourceContextLines?.[0].line, 1);
  assert.equal(issue.contextLines?.find(row => row.errorLine)?.line, 4);
});

test('new invalid code has no fabricated original counterpart', () => {
  const wrap = (code: string) => ({ trigger: [{ effect: [{ code }] }] });
  const [issue] = validateRisuLuaChanges(wrap('local x = 1\nreturn x'), wrap('local x = 1\nlocal 用 = 2\nreturn x'));
  assert.equal(issue.sourceLine, undefined);
  assert.equal(issue.sourceLineNumber, undefined);
});


test('manual syntax save uses the displayed reviewed draft after translated text shifts lines', () => {
  const wrap = (code: string) => ({ trigger: [{ effect: [{ code }] }] });
  const source = 'local text = [[hello]]\nlocal function starts_any(text)\n  return text\nend';
  const original = wrap(source);
  const stored = wrap(source.replace('starts_any', 'starts_用_any'));
  const segments = [{ pathJson: '["$module","trigger",0,"effect",0,"code"]', kind: 'lua-long-string' as const,
    sourceText: 'hello', translatedText: '第一行\n第二行\n第三行', finalText: null,
    reviewStatus: 'approved', start: source.indexOf('[['), end: source.indexOf(']]') + 2 }];
  const candidate = buildReviewedDraft({}, original, stored, segments, 'risum');
  const [issue] = validateRisuLuaChanges(original, candidate.draftModule!);
  assert.equal(issue.line, 4);
  assert.equal(replaceRisuLuaLine(structuredClone(stored), issue.pathJson, issue.line!,
    'local function starts_any(text)', issue.draftLine).ok, false);
  assert.equal(replaceRisuLuaLine(candidate.draftModule!, issue.pathJson, issue.line!,
    'local function starts_any(text)', issue.draftLine).ok, true);
  assert.deepEqual(validateRisuLuaChanges(original, candidate.draftModule!), []);
  const refreshed = buildReviewedDraft({}, original, candidate.draftModule, segments, 'risum');
  assert.deepEqual(validateRisuLuaChanges(original, refreshed.draftModule!), []);
  assert.match(JSON.stringify(refreshed.draftModule), /第二行/);
  // Reject an old editor snapshot instead of overwriting the user's new line.
  assert.equal(replaceRisuLuaLine(refreshed.draftModule!, issue.pathJson, issue.line!,
    'local function other(text)', issue.draftLine).ok, false);
});


test('rebuilding reviewed Lua cannot translate with inside a repaired function name', () => {
  const code = 'local html = [[<span>with</span>]]\nlocal function ssv1_starts_with_any_plain(text, prefixes)\nreturn text\nend';
  const wrap = (value: string) => ({ trigger: [{ effect: [{ code: value }] }] });
  const original = wrap(code);
  const stored = wrap(code.replace('>with<', '>用<'));
  const segments = [{ pathJson: '["$module","trigger",0,"effect",0,"code"]', kind: 'lua-text-node' as const,
    sourceText: 'with', translatedText: '用', finalText: null, reviewStatus: 'approved',
    start: code.indexOf('with'), end: code.indexOf('with') + 4 }];
  const first = buildReviewedDraft({}, original, original, segments, 'risum');
  assert.deepEqual(first.draftModule, stored);
  const next = buildReviewedDraft({}, original, stored, segments, 'risum');
  assert.deepEqual(next.draftModule, stored);
  assert.deepEqual(validateRisuLuaChanges(original, next.draftModule!), []);
});

test('ambiguous line alignment still offers original function context as a reference', () => {
  const source = ['local x = 1', 'local function ssv1_starts_with_any_plain(text, prefixes)', 'return text', 'end'];
  const draft = ['-- inserted', 'local x = 2', 'local function ssv1_starts_用_any_plain(text, prefixes)', '', 'return text', 'end'];
  assert.equal(luaSourceReference(source, draft, 3), 2);
});
