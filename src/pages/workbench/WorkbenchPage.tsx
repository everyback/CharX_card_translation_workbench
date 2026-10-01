import { reconcileTextDraft } from '@/features/review/lib/text-draft';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { UiAlert } from '@/shared/ui';
import { AboutPage } from '@/pages/about/AboutPage';
import { SettingsDialog } from '@/features/settings/ui/SettingsDialog';
import { QuickStartView } from './components/workflow/QuickStartView';
import { ProjectLibrary } from './components/ProjectLibrary';
import { api } from '@/shared/api/http';
import type {
  ReviewFocus,
  Segment,
  ScopePreset,
  Tab,
} from '@/shared/types';
import {
  analyzeRegexCoverageRule,
  confirmLuaNamespace,
  previewRegexCoverage,
  saveLuaRuntimeAliases,
  saveLuaSyntaxLine,
  saveRegexRule,
  testRegexRule,
} from '@/features/lua/api/lua-api';
import { isIndependentTab, readWorkbenchRoute, writeWorkbenchRoute } from './model/routing';
import { WorkbenchHeader } from '@/layouts/workbench/components/WorkbenchHeader';
import { WorkbenchSidebar } from '@/layouts/workbench/components/WorkbenchSidebar';
import { DropOverlay } from '@/layouts/workbench/components/DropOverlay';
import { GlobalNoticeBanners } from '@/layouts/workbench/components/GlobalNoticeBanners';
import { ProjectLoadingMask } from '@/layouts/workbench/components/ProjectLoadingMask';
import { ProjectWorkspace } from './components/ProjectWorkspace';
import { useGlossaryActions } from '@/features/glossary/model/useGlossaryActions';
import { useCardImport, type CardImportResult } from '@/features/card-import/model/useCardImport';
import { ImportSummary } from '@/features/card-import/ui/ImportSummary';
import { useProjectActions } from '@/features/project/model/useProjectActions';
import { useProjectWorkspace } from './model/useProjectWorkspace';
import { useProtocolActions } from '@/features/protocol/model/useProtocolActions';
import { useReviewActions } from '@/features/review/model/useReviewActions';
import { useSegmentFilters } from '@/features/segment-filter/model/useSegmentFilters';
import { useWorkbenchSettings } from '@/features/settings/model/useWorkbenchSettings';
import { useWorkbenchFeedback } from './model/useWorkbenchFeedback';
import { useTranslationTasks } from '@/features/translation/model/useTranslationTasks';
import type { ReviewProblemFilter, ReviewStatusFilter } from './tabs/review/ReviewPage';

const PluginManagerPage = lazy(() => import('@/pages/plugins/PluginManagerPage').then((module) => ({ default: module.PluginManagerPage })));

export function WorkbenchPage() {
  const initialRouteRef = useRef(readWorkbenchRoute());
  const [tab, setTab] = useState<Tab>(initialRouteRef.current.tab);
  const historyReadyRef = useRef(false);
  const historyApplyingRef = useRef(false);
  const historyKeyRef = useRef('');
  const [pendingAutoScanId, setPendingAutoScanId] = useState('');
  const [importResults, setImportResults] = useState<CardImportResult[] | null>(null);
  const [reviewFocus, setReviewFocus] = useState<ReviewFocus | null>(null);
  const [reviewStatusFilter, setReviewStatusFilter] = useState<ReviewStatusFilter>('all');
  const [reviewProblemFilter, setReviewProblemFilter] = useState<ReviewProblemFilter>('all');
  const [reviewCategoryFilter, setReviewCategoryFilter] = useState('all');
  const [reviewKindFilter, setReviewKindFilter] = useState('all');
  const [reviewQaFlagFilter, setReviewQaFlagFilter] = useState('all');
  const [reviewQuery, setReviewQuery] = useState('');
  const [reviewSelectedIds, setReviewSelectedIds] = useState<Set<string>>(new Set());
  const [reviewFiltersCollapsed, setReviewFiltersCollapsed] = useState(true);
  const reviewBases = useRef<Record<string, string>>({});
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, string>>({});
  const feedback = useWorkbenchFeedback();
  const { busy, closeUiAlert } = feedback;
  const globalFeedback = useMemo(() => feedback.bindContext(null), [feedback.bindContext]);
  const {
    settings,
    settingsOpen,
    applyLoadedSettings,
    openSettings,
    closeSettings,
    saveSettings,
  } = useWorkbenchSettings(globalFeedback.runAction);

  const clearError = useCallback(() => globalFeedback.setError(''), [globalFeedback]);
  const {
    projects,
    project,
    setProject,
    selectedProjectId,
    selectedSegmentId,
    setSelectedSegmentId,
    scope,
    setScope,
    glossary,
    setGlossary,
    protocols,
    setProtocols,
    projectOverview,
    projectOverviewLoading,
    resources,
    resourcesLoading,
    luaReport,
    luaReportLoading,
    projectLoading,
    projectLoadProgress,
    selectProject: selectWorkspaceProject,
    refreshProjects,
    refreshProject,
    loadProjectOverview,
    loadResources,
    loadLuaReport,
    invalidateProjectOverview,
  } = useProjectWorkspace({
    tab,
    onError: globalFeedback.showError,
    onSettingsLoaded: applyLoadedSettings,
    clearError,
  });

  const feedbackContextId = isIndependentTab(tab) ? null : selectedProjectId;
  const { error, notice, uiAlert } = feedback.selectContext(feedbackContextId ?? '');
  const { setError, setNotice, showError, showUiConfirm, runAction } = useMemo(
    () => feedback.bindContext(feedbackContextId), [feedback.bindContext, feedbackContextId]);

  const showOverview = useCallback(() => setTab('overview'), []);
  const showJobs = useCallback(() => setTab('jobs'), []);
  const {
    jobDetail,
    clearJobDetail,
    selectJob,
    loadingJobId,
    startTranslation,
    jobAction,
    retranslateSegments,
  } = useTranslationTasks({
    project,
    scope,
    selectedProjectId,
    settings,
    refreshProject,
    refreshProjects,
    runAction,
    showUiConfirm,
    onError: showError,
    onNotice: setNotice,
    onOpenSettings: openSettings,
    onShowJobs: showJobs,
  });

  const showReview = useCallback(() => setTab('review'), []);
  const openReviewField = useCallback((id: string) => {
    setReviewFocus(null);
    setReviewQuery('');
    setReviewProblemFilter('all');
    setReviewCategoryFilter('all');
    setReviewKindFilter('all');
    setReviewQaFlagFilter('all');
    setReviewStatusFilter(project?.segments.find(segment => segment.id === id)?.reviewStatus === 'untranslated' ? 'untranslated' : 'all');
    setSelectedSegmentId(id);
    setTab('review');
  }, [project, setSelectedSegmentId]);
  const showLua = useCallback(() => setTab('lua'), []);
  const activeTranslationJob = Boolean(project?.jobs.some((job) => ['queued', 'running', 'paused'].includes(job.status)));
  const {
    selectedSegment,
    updateSegment,
    approveSafe,
    approveAll,
    reviewBulk,
    clearAllTranslationResults,
    applyDraft,
    applyDraftQuiet,
    saveAndExport,
  } = useReviewActions({
    project,
    selectedProjectId,
    selectedSegmentId,
    setProject,
    setSelectedSegmentId,
    refreshProject,
    refreshProjects,
    runAction,
    showUiConfirm,
    onNotice: setNotice,
    onShowReview: showReview,
    onOpenLuaManagement: showLua,
    onFocusReview: setReviewFocus,
    onClearReviewFocus: () => setReviewFocus(null),
  });

  useEffect(() => {
    if (!selectedSegment) return;
    const id = selectedSegment.id;
    const incoming = selectedSegment.finalText ?? selectedSegment.translatedText ?? '';
    const previous = reviewBases.current[id];
    reviewBases.current[id] = incoming;
    setReviewDrafts((current) => ({ ...current, [id]: reconcileTextDraft(current[id], previous, incoming) }));
  }, [selectedSegment?.id, selectedSegment?.finalText, selectedSegment?.translatedText]);

  const clearReviewDrafts = useCallback((segmentIds: string[]) => {
    if (!segmentIds.length) return;
    setReviewDrafts((current) => {
      const next = { ...current };
      for (const segmentId of segmentIds) { delete next[segmentId]; delete reviewBases.current[segmentId]; }
      return next;
    });
  }, []);

  const contentActionsRef = useRef({ updateSegment, openReviewField });
  useLayoutEffect(() => { contentActionsRef.current = { updateSegment, openReviewField }; });
  const toggleContentSegment = useCallback((segment: Segment) => {
    void contentActionsRef.current.updateSegment(segment.id, { included: !segment.included });
  }, []);
  const selectContentSegment = useCallback((segment: Segment) => contentActionsRef.current.openReviewField(segment.id), []);

  const updateReviewSegment = useCallback(async (changes: Parameters<typeof updateSegment>[1]) => {
    if (!selectedSegment) return;
    if (changes.finalText !== undefined) {
      setReviewDrafts((current) => ({ ...current, [selectedSegment.id]: changes.finalText ?? '' }));
    }
    await updateSegment(selectedSegment.id, changes);
  }, [selectedSegment, updateSegment]);

  const retranslateReviewSegments = useCallback((segmentIds: string[]) => {
    void retranslateSegments(segmentIds).then((changed) => { if (changed) clearReviewDrafts(segmentIds); });
  }, [clearReviewDrafts, retranslateSegments]);

  const bulkReviewSegments = useCallback((action: 'copy-machine' | 'clear-manual', segmentIds: string[]) => {
    void reviewBulk(action, segmentIds).then((changed) => { if (changed) clearReviewDrafts(segmentIds); });
  }, [clearReviewDrafts, reviewBulk]);

  const saveLuaAndExport = useCallback(async () => {
    if (!project?.id) return;
    // The Lua page can still hold the report from before a syntax-line save.
    // Refresh it before choosing between re-checking and exporting so the
    // button never branches on a stale blocker count.
    const latestLuaReport = await loadLuaReport(project.id);
    if (!latestLuaReport) return;
    if (latestLuaReport.blockerCount) {
      if (!await applyDraftQuiet()) return;
    }
    await saveAndExport(false);
  }, [applyDraftQuiet, loadLuaReport, project?.id, saveAndExport]);

  const selectProject = useCallback((projectId: string) => {
    if (projectId === selectedProjectId) return;
    clearJobDetail();
    setReviewFocus(null);
    setReviewSelectedIds(new Set());
    setReviewDrafts({});
    selectWorkspaceProject(projectId);
  }, [clearJobDetail, selectedProjectId, selectWorkspaceProject]);

  const openProject = useCallback((projectId: string) => {
    selectProject(projectId);
    setTab('overview');
  }, [selectProject]);

  useEffect(() => {
    if (!initialRouteRef.current.projectId || selectedProjectId) return;
    selectWorkspaceProject(initialRouteRef.current.projectId);
  }, [selectedProjectId, selectWorkspaceProject]);

  useEffect(() => {
    const onPopState = () => {
      const route = readWorkbenchRoute();
      historyApplyingRef.current = true;
      setTab(route.tab);
      if (!isIndependentTab(route.tab)) {
        if (route.projectId !== selectedProjectId) selectWorkspaceProject(route.projectId);
        setSelectedSegmentId(route.segmentId);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [selectedProjectId, selectWorkspaceProject, setSelectedSegmentId]);

  useEffect(() => {
    const routeProjectId = isIndependentTab(tab) ? '' : selectedProjectId || (!historyReadyRef.current ? initialRouteRef.current.projectId : '');
    const routeSegmentId = isIndependentTab(tab) ? '' : selectedSegmentId || (!historyReadyRef.current ? initialRouteRef.current.segmentId : '');
    const key = `${tab}|${routeProjectId}|${routeSegmentId}`;
    if (!historyReadyRef.current) {
      historyReadyRef.current = true;
      historyKeyRef.current = key;
      writeWorkbenchRoute({ tab, projectId: routeProjectId, segmentId: routeSegmentId }, true);
      return;
    }
    if (historyApplyingRef.current) {
      historyApplyingRef.current = false;
      historyKeyRef.current = key;
      return;
    }
    if (historyKeyRef.current === key) return;
    historyKeyRef.current = key;
    writeWorkbenchRoute({ tab, projectId: routeProjectId, segmentId: routeSegmentId });
  }, [selectedProjectId, selectedSegmentId, tab]);

  const { scan, scanProject, updateProjectLanguageRule, reuseVersionTranslations, previewPortraitRouter, repairPortraitRouter, resetLuaDraft, deleteProject, deleteProjectFamily } = useProjectActions({
    project,
    scope,
    setProject,
    refreshProject,
    refreshProjects,
    selectProject,
    invalidateProjectOverview,
    runAction,
    showUiConfirm,
    onNotice: setNotice,
  });

  useEffect(() => {
    if (!pendingAutoScanId || project?.id !== pendingAutoScanId || project.status !== 'new' || projectLoading || busy) return;
    setPendingAutoScanId('');
    void scan();
  }, [busy, pendingAutoScanId, project, projectLoading, scan]);

  const scanImportedProject = useCallback((projectId: string) => {
    void scanProject(projectId, 'all');
  }, [scanProject]);

  const scanAllImportedProjects = useCallback(async () => {
    const ids = (importResults ?? []).flatMap((item) => item.status === 'imported' && item.projectId ? [item.projectId] : []);
    for (const projectId of ids) await scanProject(projectId, 'all');
  }, [importResults, scanProject]);

  const { draggingFiles, fileInputRef, importCards } = useCardImport({
    busy,
    runAction,
    refreshProjects,
    selectProject: selectWorkspaceProject,
    onError: showError,
    onNotice: setNotice,
    onShowOverview: showOverview,
    onImportedProject: setPendingAutoScanId,
    onImportResults: setImportResults,
  });
  const { addGlossaryTerm, deleteGlossaryTerm } = useGlossaryActions({
    project,
    setGlossary,
    runAction,
  });
  const {
    discoverProjectProtocols,
    analyzeProjectProtocols,
    saveProtocolRule,
    approveHighConfidenceProtocols,
  } = useProtocolActions({
    project,
    protocols,
    scope,
    settings,
    setProtocols,
    refreshProject,
    refreshProjects,
    runAction,
    showUiConfirm,
    onNotice: setNotice,
    onOpenSettings: openSettings,
  });
  const {
    query,
    searchScope,
    statusFilter,
    kindFilter,
    filteredSegments,
    setQuery,
    setSearchScope,
    setStatusFilter,
    setKindFilter,
  } = useSegmentFilters(project?.segments ?? []);

  return (
    <div className="app-shell">
      <DropOverlay visible={Boolean(draggingFiles)} />
      <WorkbenchSidebar
        projects={projects}
        selectedProjectId={isIndependentTab(tab) ? '' : selectedProjectId}
        tab={tab}
        busy={busy}
        settings={settings}
        fileInputRef={fileInputRef}
        onSelectProject={openProject}
        onDeleteProjectFamily={target => void deleteProjectFamily(target)}
        onImportFiles={(files) => void importCards(files)}
        onOpenSettings={openSettings}
        onTabChange={setTab}
      />

      <main className={`workspace ${tab === 'review' ? 'workspace-review' : tab === 'resources' ? 'workspace-resources' : ''}`}>
        <WorkbenchHeader
          project={project}
          tab={tab}
          busy={busy}
          onOpenLibrary={() => setTab('library')}
          onOpenExport={() => setTab('export')}
          onDeleteProject={() => void deleteProject()}
        />

        <GlobalNoticeBanners
          error={error}
          notice={notice}
          onClearError={() => setError('')}
          onClearNotice={() => setNotice('')}
        />
        {!isIndependentTab(tab) && importResults && (
          <ImportSummary
            results={importResults}
            busy={busy}
            onSelectProject={selectProject}
            onScanProject={scanImportedProject}
            onScanAll={scanAllImportedProjects}
            onClose={() => setImportResults(null)}
            conversionFormats={['st-preset']}
          />
        )}
        {!isIndependentTab(tab) && <ProjectLoadingMask loading={projectLoading} progress={projectLoadProgress} />}
        {tab === 'library' ? (
          <ProjectLibrary projects={projects} settings={settings} busy={busy} onOpenProject={openProject} onImport={() => fileInputRef.current?.click()} onOpenSettings={openSettings} />
        ) : tab === 'plugins' ? (
          <Suspense fallback={<div className="plugin-manager">正在读取插件与补丁清单...</div>}><PluginManagerPage /></Suspense>
        ) : tab === 'about' ? (
          <AboutPage />
        ) : !project && projectLoading ? (
          <div className="workspace-loading-space" aria-hidden="true" />
        ) : !project ? (
          <QuickStartView
            settings={settings}
            onImport={() => fileInputRef.current?.click()}
            onOpenSettings={openSettings}
          />
        ) : (
          <ProjectWorkspace
            project={project}
            settings={settings}
            scope={scope}
            busy={busy}
            activeTranslationJob={activeTranslationJob}
            tab={tab}
            onTabChange={setTab}
            onReviewField={openReviewField}
            onReuseVersionTranslations={reuseVersionTranslations}
            versions={{
              projects, busy,
              onSelect: selectProject,
              onImport: async (file, label) => {
                await runAction('import-version', async () => {
                  const form = new FormData(); form.append('file', file);
                  const query = new URLSearchParams({ baseVersionId: project.id, versionLabel: label });
                  const imported = await api<{ id: string }>(`/api/projects/import?${query}`, { method: 'POST', body: form });
                  await refreshProjects();
                  selectProject(imported.id);
                  setPendingAutoScanId(imported.id);
                  setTab('versions');
                });
              },
            }}
            workflow={{
              project,
              settings,
              scope,
              busy,
              onOpenSettings: openSettings,
              onScopeChange: setScope,
              onScan: (nextScope) => void scan(nextScope),
              onStartTranslation: () => void startTranslation(),
              onOpenJobs: showJobs,
              onOpenReview: showReview,
              onOpenLuaManagement: showLua,
              protocols,
              onOpenProtocols: () => setTab('protocols'),
              onApproveAll: () => void approveAll(),
              onOpenSegments: () => setTab('segments'),
              onApplyDraft: () => void applyDraft(),
              onSaveAndExport: () => void saveAndExport(),
            }}
            commandBar={{
              project,
              scope,
              busy,
              settings,
              activeTranslationJob,
              onScopeChange: setScope,
              onScan: () => void scan(),
              onStartTranslation: () => void startTranslation(),
              onLanguageRuleChange: (mode) => void updateProjectLanguageRule(mode),
            }}
            content={{
              overview: {
                info: projectOverview,
                loading: projectOverviewLoading,
                onRefresh: () => void loadProjectOverview(project.id),
                onViewResources: () => setTab('resources'),
              },
              segments: {
                segments: filteredSegments,
                query,
                searchScope,
                statusFilter,
                kindFilter,
                onQuery: setQuery,
                onSearchScope: setSearchScope,
                onStatusFilter: setStatusFilter,
                onKindFilter: setKindFilter,
                onToggle: toggleContentSegment,
                onSelect: selectContentSegment,
              },
              jobs: {
                jobs: project.jobs,
                selected: jobDetail,
                onSelect: selectJob,
                loadingJobId,
                onAction: (jobId, action) => void jobAction(jobId, action),
                onOpenReview: showReview,
                languageBehaviorMode: project.languageBehaviorMode,
                targetLanguage: project.targetLanguage,
                currentScope: project.scope,
              },
              review: {
                segments: project.segments,
                selected: selectedSegment,
                onSelect: setSelectedSegmentId,
                onUpdate: updateReviewSegment,
                onApproveSafe: () => void approveSafe(),
                onApproveAll: () => void approveAll(),
                onRetranslate: retranslateReviewSegments,
                onReviewBulk: bulkReviewSegments,
                onClearAllResults: () => void clearAllTranslationResults(),
                reviewStatusFilter,
                onReviewStatusFilterChange: setReviewStatusFilter,
                reviewProblemFilter,
                onReviewProblemFilterChange: setReviewProblemFilter,
                categoryFilter: reviewCategoryFilter,
                onCategoryFilterChange: setReviewCategoryFilter,
                reviewKindFilter,
                onReviewKindFilterChange: setReviewKindFilter,
                qaFlagFilter: reviewQaFlagFilter,
                onQaFlagFilterChange: setReviewQaFlagFilter,
                reviewQuery,
                onReviewQueryChange: setReviewQuery,
                selectedIds: reviewSelectedIds,
                onSelectedIdsChange: setReviewSelectedIds,
                reviewFiltersCollapsed,
                onReviewFiltersCollapsedChange: setReviewFiltersCollapsed,
                draft: selectedSegment ? reviewDrafts[selectedSegment.id] ?? selectedSegment.finalText ?? selectedSegment.translatedText ?? '' : '',
                onDraftChange: (value) => {
                  if (selectedSegment) setReviewDrafts((current) => ({ ...current, [selectedSegment.id]: value }));
                },
                reviewFocus,
                onClearReviewFocus: () => setReviewFocus(null),
                approving: busy.startsWith('approve-'),
                resetting: busy === 'retranslate' || busy === 'clear-results',
                updating: busy === 'segment-update',
              },
              glossary: {
                terms: glossary,
                busy: busy.startsWith('glossary'),
                onAdd: addGlossaryTerm,
                onDelete: (termId) => void deleteGlossaryTerm(termId),
              },
              references: {
                references: project.controlReferences,
              },
              protocols: {
                protocols,
                activeTranslationJob,
                busy: busy.startsWith('protocol-'),
                onDiscover: () => void discoverProjectProtocols(),
                onAnalyze: (schemaIds) => void analyzeProjectProtocols(schemaIds),
                onSave: (schemaId, status, fields) => void saveProtocolRule(schemaId, status, fields),
                onApproveHighConfidence: (schemaIds) => void approveHighConfidenceProtocols(schemaIds),
              },
              lua: {
                report: luaReport,
                loading: luaReportLoading || busy.startsWith('router-repair'),
                onRefresh: () => void loadLuaReport(project.id),
                onScan: () => void loadLuaReport(project.id),
                onPreviewRouterRepair: previewPortraitRouter,
                onApplyRouterRepair: repairPortraitRouter,
                onResetLuaDraft: resetLuaDraft,
                onPreviewError: showError,
                onSaveLuaSyntaxLine: async (pathJson, line, replacement, expectedLine) => {
                  const result = await saveLuaSyntaxLine(project.id, pathJson, line, replacement, expectedLine);
                  setReviewFocus(null);
                  void Promise.all([loadLuaReport(project.id), refreshProject(project.id), refreshProjects(false)]).catch(showError);
                  return result;
                },
                onOpenExport: () => void saveLuaAndExport(),
                onConfirmNamespace: async (targetNamespace) => {
                  const result = await confirmLuaNamespace(project.id, targetNamespace);
                  setNotice(result.sourceNamespace === result.targetNamespace
                    ? '已人工确认保留原始 namespace；未跳转审核页，也未改写资源引用。'
                    : `已人工确认 namespace 为「${result.targetNamespace}」，并同步已识别的模块内部引用。`);
                  void Promise.all([loadLuaReport(project.id), refreshProject(project.id), refreshProjects(false)]).catch(showError);
                },
                reviewFocus,
                onClearReviewFocus: () => setReviewFocus(null),
                onSaveAliases: async (ownerId, aliases) => {
                  await saveLuaRuntimeAliases(project.id, ownerId, aliases);
                  setNotice(`已将 ${ownerId} 的目标语言别名一次合并到 Lua 匹配目录。`);
                  void Promise.all([loadLuaReport(project.id), refreshProject(project.id), refreshProjects(false)]).catch(showError);
                },
                onPreviewRegexCoverage: () => previewRegexCoverage(project.id),
                regexConcurrency: settings?.concurrency ?? 1,
                onAnalyzeRegexRule: async (pathLabel, signal, pattern) => {
                  const result = await analyzeRegexCoverageRule(project.id, pathLabel, signal, pattern);
                  return result;
                },
                onTestRegexRule: (pathLabel, pattern) => testRegexRule(project.id, pathLabel, pattern),
                onSaveRegexRule: async (pathLabel, pattern, expectedPattern, forcePass, out, expectedOut) => {
                  const result = await saveRegexRule(project.id, pathLabel, pattern, expectedPattern, forcePass, out, expectedOut);
                  void Promise.all([loadLuaReport(project.id), refreshProject(project.id), refreshProjects(false)]).catch(showError);
                  return result;
                },
              },
              resources: {
                inspection: resources,
                loading: resourcesLoading,
                onRefresh: () => void loadResources(project.id),
                projectId: project.id,
              },
            }}
            preset={{
              onError: showError,
              onNotice: setNotice,
              confirm: showUiConfirm,
              onOpenPlugins: () => setTab('plugins'),
            }}
          />
        )}
      </main>

      {settingsOpen && settings && (
        <SettingsDialog
          settings={settings}
          onClose={closeSettings}
          onSave={saveSettings}
        />
      )}
      {uiAlert && <UiAlert options={uiAlert} onResolve={closeUiAlert} />}
    </div>
  );
}
