import assert from 'node:assert/strict';
import test from 'node:test';
import { textAttributes } from '../server/domain/card/text-attributes.js';
import { applyApprovedSegments, missingProtectedFragments, protectText, restoreProtectedText, scanCard } from '../server/domain/card/card.js';
import { residualLanguageIssue } from '../server/domain/translation/translation-errors.js';

const tag = '<portrait chara="alistair" state="suspcious" description="{{user}}에게 인사하는 알리스테어">';

test('portrait description is separately reviewed and exported without modifying tag keys', () => {
  const source = { data: { first_mes: `안녕하세요.\n${tag}\n학교에 왔습니다.` } };
  const scanned = scanCard(source, 'all');
  const attr = scanned.find(segment => segment.kind === 'attribute');
  assert.ok(attr);
  assert.equal(attr.sourceText, '{{user}}에게 인사하는 알리스테어');
  assert.match(attr.pathLabel, /<portrait> @description/);
  const approved = { ...attr, pathJson: JSON.stringify(attr.path), reviewStatus: 'approved', finalText: '向{{user}}说"你好"的阿利斯泰尔', translatedText: null };
  const draft = applyApprovedSegments(source, [approved]) as typeof source;
  assert.equal(draft.data.first_mes, source.data.first_mes.replace(attr.sourceText, '向{{user}}说&quot;你好&quot;的阿利斯泰尔'));
  assert.deepEqual(applyApprovedSegments(source, [{ ...approved, reviewStatus: 'pending' }]), source);
  assert.deepEqual(missingProtectedFragments(attr.sourceText, approved.finalText), []);
  assert.deepEqual(missingProtectedFragments(attr.sourceText, '向玩家打招呼'), ['{{user}}']);
  for (const other of scanned.filter(segment => segment !== attr && segment.pathLabel.startsWith('data.first_mes'))) {
    assert.ok((other.end ?? Infinity) <= attr.start! || (other.start ?? 0) >= attr.end!);
  }
});

test('whole-field protection exposes prose attributes while preserving templates and unknown attributes', () => {
  const source = tag.replace(' state=', ' custom="원본키" state=');
  const protectedValue = protectText(source);
  assert.ok(protectedValue.protectedText.includes('에게 인사하는 알리스테어'));
  assert.ok(!protectedValue.protectedText.includes('원본키'));
  const translated = restoreProtectedText(protectedValue.protectedText.replace('에게 인사하는 알리스테어', '打招呼的阿利斯泰尔'), protectedValue.tokens);
  assert.equal(translated, source.replace('에게 인사하는 알리스테어', '打招呼的阿利斯泰尔'));
  assert.deepEqual(missingProtectedFragments(source, translated), []);
  assert.ok(missingProtectedFragments(source, translated.replace('suspcious', 'suspicious')).length);
});

test('quoted markup attributes support custom tags, whitespace, multiline and opposite quotes', () => {
  const source = `<x-card TITLE = 'hello "world" > here\nnext' description="안녕" state="안녕" onclick="alert('안녕')">`;
  const attrs = textAttributes(source);
  assert.deepEqual(attrs.map(attr => attr.name), ['title', 'description']);
  assert.equal(attrs[0].text, 'hello "world" > here\nnext');
  for (const attr of attrs) assert.equal(source.slice(attr.start, attr.end), attr.text);
  assert.equal(textAttributes('<!-- <x description="안녕"> -->').length, 0);
  assert.equal(textAttributes(`<script>const x = '<x description="안녕">'</script>`).length, 0);
  assert.equal(textAttributes('```html\n<x description="안녕">\n```').length, 0);
});

test('attribute policy supports tag-specific additions while refusing protected keys', () => {
  const policy = { common: ['chara', 'onclick'], byTag: { custom: ['caption'] } };
  assert.deepEqual(textAttributes('<custom caption="hello" chara="alice" onclick="hello">', policy).map(attr => attr.name), ['caption']);
  assert.equal(textAttributes('<other caption="hello">', policy).length, 0);
});

test('residual checks name the attribute even when old QA treated its entire tag as protected', () => {
  const issue = residualLanguageIssue(tag, [tag], 'ko', 'en', 'zh-CN');
  assert.match(issue ?? '', /<portrait> @description/);
  assert.equal(residualLanguageIssue(tag, [tag], 'ko', 'en', 'ko'), null);
  const translated = tag.replace('에게 인사하는 알리스테어', '打招呼的阿利斯泰尔');
  assert.equal(residualLanguageIssue(translated, [translated], 'ko', 'en', 'zh-CN'), null);
  const japanese = '<custom title="こんにちは" state="原始キー">';
  assert.match(residualLanguageIssue(japanese, [japanese], 'ja', 'en', 'en') ?? '', /@title/);
});


test('script and style blocks remain opaque to whole-field translation protection', () => {
  const script = `<script>const markup = '<portrait description="안녕">';</script>`;
  assert.equal(protectText(script).protectedText, '__CTW_KEEP_0__');
  assert.equal(textAttributes('<input type="hidden" value="내부키">').length, 0);
  assert.equal(textAttributes('<input type="submit" value="제출">').length, 1);
});
