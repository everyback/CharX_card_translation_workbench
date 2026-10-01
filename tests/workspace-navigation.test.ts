import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProjectDetail, ProjectSummary, Segment } from '../src/shared/types';
import { filterLibraryProjects, matchesLibraryFilter } from '../src/pages/workbench/model/project-library';
import { WorkbenchSidebar } from '../src/layouts/workbench/components/WorkbenchSidebar';
import { WorkbenchHeader } from '../src/layouts/workbench/components/WorkbenchHeader';
import { WorkbenchTabs } from '../src/layouts/workbench/components/WorkbenchTabs';
import { latestProjectVersions } from '../src/pages/workbench/model/project-library';
import { ExportPage } from '../src/pages/workbench/tabs/export/ExportPage';
import { readWorkbenchRoute, writeWorkbenchRoute } from '../src/pages/workbench/model/routing';

const noop = () => {};
const summary = (id: string, changes: Partial<ProjectSummary> = {}): ProjectSummary => ({ id, name: 'Forest', originalName: 'Forest Library', translatedName: '森林图书馆', scope: 'standard', status: 'review', sourceFormat: 'json', segmentCount: 2, approvedCount: 1, pendingReviewCount: 1, updatedAt: '2026-10-01T00:00:00Z', ...changes });
const project = (changes: Partial<ProjectDetail> = {}): ProjectDetail => ({ ...summary('p'), sourceFilename: 'forest.json', sourceLanguage: 'en', targetLanguage: 'zh-CN', languageBehaviorMode: 'target', originalHash: 'fixture', createdAt: '2026-10-01', segments: [{ included: true, reviewStatus: 'approved', finalText: '已确认', pathLabel: 'name' }, { included: true, reviewStatus: 'pending', finalText: '待审核', pathLabel: 'description' }] as Segment[], controlReferences: [], jobs: [], ...changes });

test('project library combines translated/original name search, status, format and sort without mutating input', () => {
  const items = [summary('old'), summary('new', { updatedAt: '2026-10-02T00:00:00Z', sourceFormat: 'charx' }), summary('ready', { status: 'reviewed', pendingReviewCount: 0 })];
  assert.deepEqual(filterLibraryProjects(items, ' forest ', 'review', 'all', 'updated').map(item => item.id), ['new', 'old']);
  assert.deepEqual(filterLibraryProjects(items, ' 森林 ', 'review', 'charx', 'updated').map(item => item.id), ['new']);
  assert.deepEqual(items.map(item => item.id), ['old', 'new', 'ready']);
  assert.equal(matchesLibraryFilter(summary('failed', { status: 'review_with_errors', pendingReviewCount: 0 }), 'review'), true);
  assert.equal(matchesLibraryFilter(summary('paused', { status: 'paused' }), 'active'), true);
  assert.equal(matchesLibraryFilter(items[2], 'ready'), true);
  assert.equal(matchesLibraryFilter(items[0], 'ready'), false);
});

test('project navigation separates project tools from global pages and excludes translation tools for ST presets', () => {
  const sidebar = (item: ProjectSummary) => renderToStaticMarkup(React.createElement(WorkbenchSidebar, { projects: [item], selectedProjectId: item.id, tab: 'review', busy: '', settings: null, fileInputRef: { current: null }, onSelectProject: noop, onTabChange: noop, onImportFiles: noop, onOpenSettings: noop }));
  const card = sidebar(summary('p'));
  assert.match(card, /我的项目/);
  assert.doesNotMatch(card, /对照审核|导出成品|协议规则|脚本管理|翻译流程/);
  const tabs = renderToStaticMarkup(React.createElement(WorkbenchTabs, { tab: 'review', onChange: noop }));
  assert.match(tabs, /aria-current="page"[^>]*>对照审核/);
  assert.match(tabs, /版本记录/);
  assert.match(tabs, /项目工具/);
  assert.doesNotMatch(tabs, /<details|<summary/);
  assert.doesNotMatch(tabs, /术语库|资源管理|脚本管理|协议规则|引用检查/);
  const tools = renderToStaticMarkup(React.createElement(WorkbenchTabs, { tab: 'glossary', onChange: noop }));
  for (const title of ['术语库', '资源管理', '脚本管理', '协议规则', '引用检查']) assert.match(tools, new RegExp(title));
  assert.doesNotMatch(tools, /对照审核|翻译任务|导出成品/);
  const preset = sidebar(summary('s', { sourceFormat: 'st-preset' }));
  assert.doesNotMatch(preset, /对照审核|导出成品|协议规则|脚本管理/);
  const presetTabs = renderToStaticMarkup(React.createElement(WorkbenchTabs, { tab: 'overview', preset: true, onChange: noop }));
  assert.match(presetTabs, /预设转换/);
  assert.doesNotMatch(presetTabs, /对照审核|导出成品|协议规则|脚本管理/);
  const header = renderToStaticMarkup(React.createElement(WorkbenchHeader, { project: project(), tab: 'library', busy: '', onOpenLibrary: noop, onOpenExport: noop, onDeleteProject: noop }));
  assert.doesNotMatch(header, /森林图书馆|删除项目|>导出</);
});

test('the library shows one latest version per family without grouping cards by their names', () => {
  const versions = [summary('a', { familyId: 'a', versionNumber: 1 }), summary('b', { familyId: 'a', versionNumber: 2 }), summary('c', { versionNumber: 1 })];
  assert.deepEqual(latestProjectVersions(versions).map(item => item.id), ['b', 'c']);
});

test('export page describes pending work and defers syntax validation to the existing save action', () => {
  const render = (p: ProjectDetail) => renderToStaticMarkup(React.createElement(ExportPage, { project: p, busy: '', onReview: noop, onJobs: noop, onScripts: noop, onApplyDraft: noop, onSaveAndExport: noop }));
  const html = render(project());
  assert.match(html, /还有译文等待确认/);
  assert.match(html, /未通过的内容保留原文/);
  assert.doesNotMatch(html, /语法检查通过|可安全导出/);
  const active = render(project({ jobs: [{ status: 'paused', totalItems: 2, completedItems: 1, failedItems: 0 }] as ProjectDetail['jobs'] }));
  assert.match(active, /翻译任务尚未结束/);
  assert.match(active, /disabled=""[^>]*>[\s\S]*?保存并导出/);
});

test('library is the landing page while legacy project links and export history remain addressable', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let url = new URL('http://localhost/');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { get href() { return url.href; }, get search() { return url.search; } }, history: { pushState(_state: unknown, _title: string, next: URL) { url = new URL(next); }, replaceState(_state: unknown, _title: string, next: URL) { url = new URL(next); } } } });
  try {
    assert.equal(readWorkbenchRoute().tab, 'library');
    url = new URL('http://localhost/?project=p');
    assert.equal(readWorkbenchRoute().tab, 'overview');
    writeWorkbenchRoute({ tab: 'export', projectId: 'p', segmentId: 's' });
    assert.deepEqual(readWorkbenchRoute(), { tab: 'export', projectId: 'p', segmentId: 's' });
    writeWorkbenchRoute({ tab: 'library', projectId: 'p', segmentId: 's' });
    assert.deepEqual(readWorkbenchRoute(), { tab: 'library', projectId: '', segmentId: '' });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window');
  }
});
