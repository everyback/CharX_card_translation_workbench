import { useCallback, useEffect, useRef, useState } from 'react';
import { UiAlert } from '@/shared/ui';
import { AboutPage } from '@/pages/about/AboutPage';
import { SettingsDialog } from '@/features/settings/ui/SettingsDialog';
import { QuickStartView } from './components/workflow/QuickStartView';
import type {
  ReviewFocus,
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
import { readWorkbenchRoute, writeWorkbenchRoute } from './model/routing';
import { WorkbenchHeader } from '@/layouts/workbench/components/WorkbenchHeader';
import { WorkbenchSidebar } from '@/layouts/workbench/components/WorkbenchSidebar';
import { DropOverlay } from '@/layouts/workbench/components/DropOverlay';
import { GlobalNoticeBanners } from '@/layouts/workbench/components/GlobalNoticeBanners';
import { ProjectLoadingMask } from '@/layouts/workbench/components/ProjectLoadingMask';
import { ProjectWorkspace } from './components/ProjectWorkspace';
import { useGlossaryActions } from '@/features/glossary/model/useGlossaryActions';
import { useCardImport } from '@/features/card-import/model/useCardImport';
import { useProjectActions } from '@/features/project/model/useProjectActions';
import { useProjectWorkspace } from './model/useProjectWorkspace';
import { useProtocolActions } from '@/features/protocol/model/useProtocolActions';
import { useReviewActions } from '@/features/review/model/useReviewActions';
import { useSegmentFilters } from '@/features/segment-filter/model/useSegmentFilters';
import { useWorkbenchSettings } from '@/features/settings/model/useWorkbenchSettings';
import { useWorkbenchFeedback } from './model/useWorkbenchFeedback';
import { useTranslationTasks } from '@/features/translation/model/useTranslationTasks';

export function WorkbenchPage() {
  const initialRouteRef = useRef(readWorkbenchRoute());
  const [tab, setTab] = useState<Tab>(initialRouteRef.current.tab);
  const historyReadyRef = useRef(false);
  const historyApplyingRef = useRef(false);
  const historyKeyRef = useRef('');
  const [pendingAutoScanId, setPendingAutoScanId] = useState('');
  const [reviewFocus, setReviewFocus] = useState<ReviewFocus | null>(null);
  const {
    busy,
    error,
    notice,
    uiAlert,
    setError,
    setNotice,
    closeUiAlert,
    showUiConfirm,
    showError,
    runAction,
  } = useWorkbenchFeedback();
  const {
    settings,
    settingsOpen,
    applyLoadedSettings,
    openSettings,
    closeSettings,
    saveSettings,
  } = useWorkbenchSettings(runAction);

  const clearError = useCallback(() => setError(''), [setError]);
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
    onError: showError,
    onSettingsLoaded: applyLoadedSettings,
    clearError,
  });

  const showOverview = useCallback(() => setTab('overview'), []);
  const showJobs = useCallback(() => setTab('jobs'), []);
  const { draggingFiles, fileInputRef, importCards } = useCardImport({
    busy,
    runAction,
    refreshProjects,
    selectProject: selectWorkspaceProject,
    onError: showError,
    onNotice: setNotice,
    onShowOverview: showOverview,
    onImportedProject: setPendingAutoScanId,
  });
  const {
    jobDetail,
    clearJobDetail,
    loadJob,
    startTranslation,
    jobAction,
    retranslateSegments,
  } = useTranslationTasks({
    project,
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
  const showLua = useCallback(() => setTab('lua'), []);
  const activeTranslationJob = Boolean(project?.jobs.some((job) => ['queued', 'running'].includes(job.status)));
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

  const saveLuaAndExport = useCallback(async () => {
    if (!project?.id) return;
    // The Lua page can still hold the report from before a syntax-line save.
    // Refresh it before choosing between re-checking and exporting so the
    // button never branches on a stale blocker count.
    const latestLuaReport = await loadLuaReport(project.id, true);
    if (latestLuaReport?.blockerCount) {
      await applyDraftQuiet();
      return;
    }
    await saveAndExport(false);
  }, [applyDraftQuiet, loadLuaReport, project?.id, saveAndExport]);

  const selectProject = useCallback((projectId: string) => {
    clearJobDetail();
    setReviewFocus(null);
    selectWorkspaceProject(projectId);
  }, [clearJobDetail, selectWorkspaceProject]);

  useEffect(() => {
    if (!initialRouteRef.current.projectId || selectedProjectId) return;
    selectWorkspaceProject(initialRouteRef.current.projectId);
  }, [selectedProjectId, selectWorkspaceProject]);

  useEffect(() => {
    const onPopState = () => {
      const route = readWorkbenchRoute();
      historyApplyingRef.current = true;
      setTab(route.tab);
      if (route.projectId !== selectedProjectId) selectWorkspaceProject(route.projectId);
      setSelectedSegmentId(route.segmentId);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [selectedProjectId, selectWorkspaceProject, setSelectedSegmentId]);

  useEffect(() => {
    const routeProjectId = selectedProjectId || (!historyReadyRef.current ? initialRouteRef.current.projectId : '');
    const routeSegmentId = selectedSegmentId || (!historyReadyRef.current ? initialRouteRef.current.segmentId : '');
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

  const { scan, updateProjectLanguageRule, previewPortraitRouter, repairPortraitRouter, resetLuaDraft, deleteProject } = useProjectActions({
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
        selectedProjectId={selectedProjectId}
        busy={busy}
        settings={settings}
        fileInputRef={fileInputRef}
        onSelectProject={selectProject}
        onImportFiles={(files) => void importCards(files)}
        onOpenSettings={openSettings}
        onOpenAbout={() => setTab('about')}
        aboutActive={tab === 'about'}
      />

      <main className={`workspace ${tab === 'review' ? 'workspace-review' : ''}`}>
        <WorkbenchHeader
          project={project}
          busy={busy}
          aboutActive={tab === 'about'}
          onDeleteProject={() => void deleteProject()}
          onApplyDraft={() => void applyDraft()}
          onSaveAndExport={() => void saveAndExport()}
        />

        <GlobalNoticeBanners
          error={error}
          notice={notice}
          onClearError={() => setError('')}
          onClearNotice={() => setNotice('')}
        />
        <ProjectLoadingMask loading={projectLoading} progress={projectLoadProgress} />

        {tab === 'about' ? (
          <AboutPage />
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
                onToggle: (segment) => void updateSegment(segment.id, { included: !segment.included }),
                onSelect: (segment) => {
                  setSelectedSegmentId(segment.id);
                  setTab('review');
                },
              },
              jobs: {
                jobs: project.jobs,
                selected: jobDetail,
                onSelect: (job) => void loadJob(job.id),
                onAction: (jobId, action) => void jobAction(jobId, action),
                onOpenReview: showReview,
                languageBehaviorMode: project.languageBehaviorMode,
                targetLanguage: settings?.targetLanguage || project.targetLanguage,
              },
              review: {
                segments: project.segments,
                selected: selectedSegment,
                onSelect: setSelectedSegmentId,
                onUpdate: (changes) => selectedSegment ? updateSegment(selectedSegment.id, changes) : undefined,
                onApproveSafe: () => void approveSafe(),
                onApproveAll: () => void approveAll(),
                onRetranslate: (segmentIds) => void retranslateSegments(segmentIds),
                onReviewBulk: (action, segmentIds) => void reviewBulk(action, segmentIds),
                onClearAllResults: () => void clearAllTranslationResults(),
                reviewFocus,
                onClearReviewFocus: () => setReviewFocus(null),
                approving: busy.startsWith('approve-'),
                resetting: busy === 'retranslate' || busy === 'clear-results',
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
                onScan: () => void scan('lua-only'),
                onPreviewRouterRepair: previewPortraitRouter,
                onApplyRouterRepair: repairPortraitRouter,
                onResetLuaDraft: resetLuaDraft,
                onPreviewError: showError,
                onSaveLuaSyntaxLine: async (pathJson, line, replacement, expectedLine) => {
                  const result = await saveLuaSyntaxLine(project.id, pathJson, line, replacement, expectedLine);
                  await loadLuaReport(project.id, true);
                  return result;
                },
                onOpenExport: () => void saveLuaAndExport(),
                onConfirmNamespace: async (targetNamespace) => {
                  const result = await confirmLuaNamespace(project.id, targetNamespace);
                  setNotice(result.sourceNamespace === result.targetNamespace
                    ? '已人工确认保留原始 namespace；未跳转审核页，也未改写资源引用。'
                    : `已人工确认 namespace 为「${result.targetNamespace}」，并同步已识别的模块内部引用。`);
                  await Promise.all([loadLuaReport(project.id, true), refreshProject(project.id), refreshProjects()]);
                },
                reviewFocus,
                onClearReviewFocus: () => setReviewFocus(null),
                onSaveAliases: async (ownerId, aliases) => {
                  await saveLuaRuntimeAliases(project.id, ownerId, aliases);
                  setNotice(`已将 ${ownerId} 的目标语言别名一次合并到 Lua 匹配目录。`);
                  await loadLuaReport(project.id);
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
                  await loadLuaReport(project.id);
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
            onTabChange={setTab}
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
