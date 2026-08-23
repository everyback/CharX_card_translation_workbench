import {
  ChevronDown,
  CircleAlert,
  FileUp,
  Gauge,
  Braces,
  Link2,
  ListChecks,
  LoaderCircle,
  Play,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { LoadingMask, Stat, UiAlert } from '../components/ui';
import { SCOPE_OPTIONS } from '../constants';
import { ProjectOverviewView } from '../features/card-inspection/ProjectOverviewView';
import { AboutView } from '../features/about/AboutView';
import { GlossaryView } from '../features/glossary/GlossaryView';
import { JobsView } from '../features/jobs/JobsView';
import { ProtocolsView } from '../features/protocols/ProtocolsView';
import { ReferencesView } from '../features/references/ReferencesView';
import { ResourcesView } from '../features/resources/ResourcesView';
import { ReviewView } from '../features/review/ReviewView';
import { SegmentsView } from '../features/segments/SegmentsView';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { GuidedWorkflow } from '../features/workflow/GuidedWorkflow';
import { QuickStartView } from '../features/workflow/QuickStartView';
import type {
  ScopePreset,
  Tab,
} from '../types';
import { WorkbenchHeader } from './components/WorkbenchHeader';
import { WorkbenchSidebar } from './components/WorkbenchSidebar';
import { useGlossaryActions } from './hooks/glossary/useGlossaryActions';
import { useCardImport } from './hooks/import/useCardImport';
import { useProjectActions } from './hooks/projects/useProjectActions';
import { useProjectWorkspace } from './hooks/projects/useProjectWorkspace';
import { useProtocolActions } from './hooks/protocols/useProtocolActions';
import { useReviewActions } from './hooks/review/useReviewActions';
import { useSegmentFilters } from './hooks/segments/useSegmentFilters';
import { useWorkbenchSettings } from './hooks/settings/useWorkbenchSettings';
import { useWorkbenchFeedback } from './hooks/shared/useWorkbenchFeedback';
import { useTranslationTasks } from './hooks/translation/useTranslationTasks';

export function WorkbenchApp() {
  const [tab, setTab] = useState<Tab>('overview');
  const [pendingAutoScanId, setPendingAutoScanId] = useState('');
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
    projectLoading,
    projectLoadProgress,
    selectProject: selectWorkspaceProject,
    refreshProjects,
    refreshProject,
    loadProjectOverview,
    loadResources,
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
  const {
    selectedSegment,
    updateSegment,
    approveSafe,
    approveAll,
    reviewBulk,
    clearAllTranslationResults,
    applyDraft,
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
  });

  const selectProject = useCallback((projectId: string) => {
    clearJobDetail();
    selectWorkspaceProject(projectId);
  }, [clearJobDetail, selectWorkspaceProject]);

  const { scan, updateProjectLanguageRule, deleteProject } = useProjectActions({
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
    statusFilter,
    kindFilter,
    filteredSegments,
    setQuery,
    setStatusFilter,
    setKindFilter,
  } = useSegmentFilters(project?.segments ?? []);

  return (
    <div className="app-shell">
      {draggingFiles && (
        <div className="drop-overlay" role="status" aria-live="polite">
          <div className="drop-target">
            <FileUp size={30} />
            <strong>松开以导入卡片或模块</strong>
            <span>支持 JSON、PNG、CHARX 和 RISUM，可同时拖入多张</span>
          </div>
        </div>
      )}
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

        {error && <div className="error-banner"><CircleAlert size={17} /><span>{error}</span><button onClick={() => setError('')}><X size={16} /></button></div>}
        {notice && <div className="notice-banner"><ShieldCheck size={17} /><span>{notice}</span><button onClick={() => setNotice('')}><X size={16} /></button></div>}
        {projectLoading && (
          <LoadingMask
            label={projectLoadProgress.known ? '正在读取卡片段落' : '正在读取卡片概要'}
            className="project-loading-mask"
            progress={projectLoadProgress.known ? projectLoadProgress : undefined}
          />
        )}

        {tab === 'about' ? (
          <AboutView />
        ) : !project ? (
          <QuickStartView
            settings={settings}
            onImport={() => fileInputRef.current?.click()}
            onOpenSettings={openSettings}
          />
        ) : (
          <>
            <GuidedWorkflow
              project={project}
              settings={settings}
              scope={scope}
              busy={busy}
              onOpenSettings={openSettings}
              onScopeChange={setScope}
              onScan={(nextScope) => void scan(nextScope)}
              onStartTranslation={() => void startTranslation()}
              onOpenJobs={showJobs}
              onOpenReview={showReview}
              onApproveAll={() => void approveAll()}
              onOpenSegments={() => setTab('segments')}
              onApplyDraft={() => void applyDraft()}
              onSaveAndExport={() => void saveAndExport()}
            />
            <section className="stats-band">
              <Stat icon={<ListChecks size={17} />} label="扫描段落" value={project.scanSummary?.totalSegments ?? project.segments.length} />
              <Stat icon={<Gauge size={17} />} label="待人工审核" value={project.scanSummary?.pendingSegments ?? project.segments.filter((item) => item.reviewStatus === 'pending').length} />
              <Stat icon={<ShieldCheck size={17} />} label="已通过" value={project.scanSummary?.approvedSegments ?? project.segments.filter((item) => item.reviewStatus === 'approved').length} />
              <Stat icon={<CircleAlert size={17} />} label="高疑点" value={project.scanSummary?.highRiskSegments ?? project.segments.filter((item) => item.riskLevel === 'high').length} />
              <Stat icon={<Link2 size={17} />} label="脚本引用" value={project.controlReferences.length} />
              <Stat icon={<Braces size={17} />} label="Lua / 协议" value={`${project.scanSummary?.luaSegments ?? 0} / ${project.scanSummary?.protocolSegments ?? 0}`} />
            </section>

            {project.scanSummary?.runtimeRiskCount ? (
              <div className="warning-strip">
                <CircleAlert size={16} />
                <span>发现 {project.scanSummary.runtimeRiskCount} 个运行时状态风险：{project.scanSummary.runtimeRiskMessages.slice(0, 2).join('；')}</span>
              </div>
            ) : null}

            <section className="command-band">
              <label className="select-field">
                <span>翻译范围</span>
                <div className="select-wrap">
                  <select value={scope} onChange={(event) => setScope(event.target.value as ScopePreset)}>
                    {SCOPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                  <ChevronDown size={15} />
                </div>
              </label>
              <button className="secondary-button" onClick={() => void scan()} disabled={Boolean(busy)}>
                {busy === 'scan' ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}扫描字段
              </button>
              <button className="primary-button" onClick={() => void startTranslation()} disabled={!project.segments.length || Boolean(busy)}>
                {busy === 'start' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}开始翻译
              </button>
              <div className="command-spacer" />
              <span className="model-name">{settings?.model || '未配置模型'}</span>
              <label className={`language-rule-badge ${project.languageBehaviorMode === 'preserve' ? 'preserve' : ''}`} title="项目级卡片语言设定">
                <span>卡片语言设定</span>
                <select value={project.languageBehaviorMode} onChange={(event) => void updateProjectLanguageRule(event.target.value as 'target' | 'preserve')}>
                  <option value="target">跟随目标语言</option>
                  <option value="preserve">保留卡片原设定</option>
                </select>
              </label>
            </section>

            <div className="tab-row" role="tablist">
              <button className={tab === 'overview' ? 'active' : ''} onClick={() => setTab('overview')}>概要</button>
              <button className={tab === 'segments' ? 'active' : ''} onClick={() => setTab('segments')}>字段</button>
              <button className={tab === 'jobs' ? 'active' : ''} onClick={() => setTab('jobs')}>任务</button>
              <button className={tab === 'review' ? 'active' : ''} onClick={() => setTab('review')}>审核</button>
              <button className={tab === 'glossary' ? 'active' : ''} onClick={() => setTab('glossary')}>术语库</button>
              <button className={tab === 'references' ? 'active' : ''} onClick={() => setTab('references')}>引用</button>
              <button className={tab === 'protocols' ? 'active' : ''} onClick={() => setTab('protocols')}>协议</button>
              <button className={tab === 'resources' ? 'active' : ''} onClick={() => setTab('resources')}>资源</button>
            </div>

            {tab === 'overview' && (
              <ProjectOverviewView
                info={projectOverview}
                loading={projectOverviewLoading}
                onRefresh={() => void loadProjectOverview(project.id)}
                onViewResources={() => setTab('resources')}
              />
            )}

            {tab === 'segments' && (
              <SegmentsView
                segments={filteredSegments}
                query={query}
                statusFilter={statusFilter}
                kindFilter={kindFilter}
                onQuery={setQuery}
                onStatusFilter={setStatusFilter}
                onKindFilter={setKindFilter}
                onToggle={(segment) => void updateSegment(segment.id, { included: !segment.included })}
                onSelect={(segment) => { setSelectedSegmentId(segment.id); setTab('review'); }}
              />
            )}

            {tab === 'jobs' && (
              <JobsView
                jobs={project.jobs}
                selected={jobDetail}
                onSelect={(job) => void loadJob(job.id)}
                onAction={(jobId, action) => void jobAction(jobId, action)}
                onOpenReview={showReview}
                languageBehaviorMode={project.languageBehaviorMode}
                targetLanguage={settings?.targetLanguage || project.targetLanguage}
              />
            )}

            {tab === 'review' && (
              <ReviewView
                segments={project.segments}
                selected={selectedSegment}
                onSelect={setSelectedSegmentId}
                onUpdate={(changes) => selectedSegment ? updateSegment(selectedSegment.id, changes) : undefined}
                onApproveSafe={() => void approveSafe()}
                onApproveAll={() => void approveAll()}
                onRetranslate={(segmentIds) => void retranslateSegments(segmentIds)}
                onReviewBulk={(action, segmentIds) => void reviewBulk(action, segmentIds)}
                onClearAllResults={() => void clearAllTranslationResults()}
                approving={busy.startsWith('approve-')}
                resetting={busy === 'retranslate' || busy === 'clear-results'}
              />
            )}

            {tab === 'glossary' && (
              <GlossaryView
                terms={glossary}
                busy={busy.startsWith('glossary')}
                onAdd={addGlossaryTerm}
                onDelete={(termId) => void deleteGlossaryTerm(termId)}
              />
            )}

            {tab === 'references' && <ReferencesView references={project.controlReferences} />}

            {tab === 'protocols' && (
              <ProtocolsView
                protocols={protocols}
                busy={busy.startsWith('protocol-')}
                onDiscover={() => void discoverProjectProtocols()}
                onAnalyze={(schemaIds) => void analyzeProjectProtocols(schemaIds)}
                onSave={(schemaId, status, fields) => void saveProtocolRule(schemaId, status, fields)}
                onApproveHighConfidence={(schemaIds) => void approveHighConfidenceProtocols(schemaIds)}
              />
            )}

            {tab === 'resources' && (
              <ResourcesView
                inspection={resources}
                loading={resourcesLoading}
                onRefresh={() => void loadResources(project.id)}
                projectId={project.id}
              />
            )}
          </>
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
