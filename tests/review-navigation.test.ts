import assert from 'node:assert/strict';
import test from 'node:test';
import { integrityIssueDestination } from '../src/app/review-navigation.js';

test('routes Risu structural failures to Lua management', () => {
  for (const code of ['RISU_LUA_SYNTAX_INVALID', 'RISU_SCRIPT_INTEGRITY_INVALID', 'RISU_TEMPLATE_INVALID']) {
    assert.equal(integrityIssueDestination({ code }), 'lua');
  }
  assert.equal(integrityIssueDestination({}, 'Risu Lua 语法校验失败：模块.trigger.0.effect.0.code [796:56]'), 'lua');
});

test('keeps text-bound validation failures in the review queue', () => {
  assert.equal(integrityIssueDestination({ code: 'REGEX_MATCH_COUNT_CHANGED' }), 'review');
  assert.equal(integrityIssueDestination({ code: 'PROTECTED_FRAGMENTS_MISSING' }), 'review');
});
