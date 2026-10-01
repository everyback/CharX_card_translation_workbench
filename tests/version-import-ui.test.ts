import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VersionImportForm } from '../src/pages/workbench/components/ProjectVersionBar.js';
import type { ProjectDetail } from '../src/shared/types.js';

test('version import submits through the form and uses a custom file picker', () => {
  const html = renderToStaticMarkup(React.createElement(VersionImportForm, {
    project: { id: 'fixture', versionLabel: 'V1' } as ProjectDetail,
    busy: '', onImport: async () => {}, onCancel: () => {},
  }));
  assert.match(html, /<button[^>]*type="submit"[^>]*>导入并比较<\/button>/);
  assert.match(html, /<input[^>]*hidden=""[^>]*type="file"/);
  assert.match(html, /<button[^>]*type="button"[^>]*>[\s\S]*?选择文件<\/button>/);
  assert.match(html, /拖动文件到这里/);
  assert.doesNotMatch(html, /required=""/); // Dropped files live in React state, not the native input.
});
