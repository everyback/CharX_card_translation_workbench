import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { scriptEditorSources, regexChanges } from '../src/pages/workbench/tabs/lua/lib/script-editor.js';
import { LuaPage } from '../src/pages/workbench/tabs/lua/LuaPage.js';
import { ScriptChanges } from '../src/pages/workbench/tabs/lua/components/diagnostics/ScriptChanges.js';
import { buildLuaManagementReport } from '../server/domain/lua/lua-management.js';
import type { LuaManagementReport } from '../src/shared/types.js';

test('valid Lua changes remain editable and large reports render only the selected code block', () => {
  const wrap = (value: string) => ({ trigger: [{ effect: [{ code: value }] }] });
  const report = buildLuaManagementReport({ originalCard: {}, originalModule: wrap('return 1'), draftModule: wrap('return 2') });
  assert.equal(report.syntaxStatus, 'passed');
  const changes = Array.from({ length: 200 }, (_, i) => ({ ...report.scriptChanges[0], pathLabel: `script-${i}`, after: `return ${i + 2}` }));
  const html = renderToStaticMarkup(React.createElement(ScriptChanges, { changes, onSaveLine: async () => true }));
  assert.match(html, /点击代码行编辑/);
  assert.match(html, /编辑 Lua 第 1 行/);
  assert.equal((html.match(/aria-label="编辑 Lua 第 1 行"/g) ?? []).length, 1);
  assert.match(html, /下一页/);
  assert.doesNotMatch(html, /script-199/);
  assert.match(html, /原始文件（只读）/);
});

test('changed regex output opens the matching rule instead of exposing a Lua save action', () => {
  const html = renderToStaticMarkup(React.createElement(ScriptChanges, {
    mode: 'regex',
    changes: [{ pathLabel: '$module.regex.4.out', before: '$1', after: '<b>$1</b>' }],
    regexRules: [{ pathLabel: '模块.regex.4.in' }] as LuaManagementReport['regexRules'],
    onOpenRegex: () => {}, onSaveLine: async () => true,
  }));
  assert.match(html, /编辑正则输入 \/ 输出/);
  assert.doesNotMatch(html, /编辑 Lua 第/);
});


test('script editor includes unchanged Lua and keeps regex comparisons separate', () => {
  const original = { trigger: [{ effect: [{ code: 'value = 1\nreturn value' }] }], regex: [{ in: 'Hello', out: '$1' }] };
  const draft = { ...original, regex: [{ in: 'Hello', out: '<b>$1</b>' }] };
  const report = buildLuaManagementReport({ originalCard: {}, originalModule: original, draftModule: draft });
  assert.equal(report.scriptChanges.length, 1);
  const sources = scriptEditorSources(report);
  assert.equal(sources.length, 1);
  assert.equal(regexChanges(report).length, 1);
  const html = renderToStaticMarkup(React.createElement(ScriptChanges, { changes: sources, onSaveLine: async () => true }));
  assert.match(html, /编辑 Lua 第 1 行/);
  assert.match(html, /编辑 Lua 第 2 行/);
  assert.doesNotMatch(html, /编辑正则输入|regex\.0/);
  const pending = buildLuaManagementReport({ originalCard: {}, originalModule: original });
  assert.equal(scriptEditorSources(pending).length, 1);
});

test('legacy Lua comparison reconstructs only exact known module code paths', () => {
  const report = { scriptChanges: [
    { pathLabel: '$module.trigger.0.effect.0.code', before: 'return 1', after: 'return 2' },
    { pathLabel: '$module.regex.0.in', before: 'a', after: 'b' },
    { pathLabel: '卡片.trigger.0.effect.0.code', before: 'a', after: 'b' },
  ] };
  const sources = scriptEditorSources(report);
  assert.equal(sources.length, 1);
  assert.deepEqual(JSON.parse(sources[0].luaPathJson!), ['trigger', 0, 'effect', 0, 'code']);
});

test('diagnostics is the first and initially selected workspace tab', () => {
  const report = buildLuaManagementReport({ originalCard: {}, originalModule: { trigger: [{ effect: [{ code: 'return 1' }] }] } });
  const props = { report, loading: false, reviewFocus: null, regexConcurrency: 1 } as unknown as React.ComponentProps<typeof LuaPage>;
  const html = renderToStaticMarkup(React.createElement(LuaPage, props));
  assert.ok(html.indexOf('id="lua-tab-overview"') < html.indexOf('id="lua-tab-changes"'));
  assert.match(html, /id="lua-tab-overview"[^>]*aria-selected="true"/);
  assert.match(html, /id="lua-tab-changes"[^>]*>脚本编辑/);
});
