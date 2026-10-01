import { workflowState } from '@/features/translation/model/workflow-state';
import { AutomaticLoads } from './automatic-loads';
import { loadSegmentPages } from './load-segment-pages';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/shared/api/http';
import type {
  Dashboard,
  GlossaryTerm,
  ProjectDetail,
  ProjectOverview,
  ProjectSegmentsPage,
  ProjectSummary,
  ProtocolSchema,
  ResourceInspection,
  ScopePreset,
  Segment,
  Settings,
  Tab,
  LuaManagementReport,
} from '@/shared/types';
import { DEFAULT_SCOPE } from '@/features/translation/model/scope';
import { LOADING_MASK_MINIMUM_MS, PROJECT_SEGMENT_PAGE_SIZE } from './workspace-constants';
import { isIndependentTab } from './routing';
import type { ShowWorkbenchError } from '@/shared/model/workbench-actions';

interface UseProjectWorkspaceOptions {
  tab: Tab;
  onError: ShowWorkbenchError;
  onSettingsLoaded: (settings: Settings) => void;
  clearError: () => void;
}

export function useProjectWorkspace({
  tab,
  onError,
  onSettingsLoaded,
  clearError,
}: UseProjectWorkspaceOptions) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [selectedSegmentId, setSelectedSegmentId] = useState('');
  const [scope, setScope] = useState<ScopePreset>(DEFAULT_SCOPE);
  const [glossary, setGlossary] = useState<GlossaryTerm[]>([]);
  const [protocols, setProtocols] = useState<ProtocolSchema[]>([]);
  const [projectOverview, setProjectOverview] = useState<ProjectOverview | null>(null);
  const [projectOverviewLoading, setProjectOverviewLoading] = useState(false);
  const [resources, setResources] = useState<ResourceInspection | null>(null);
  const [resourcesLoading, setResourcesLoading] = useState(false);
  const [luaReport, setLuaReport] = useState<LuaManagementReport | null>(null);
  const [luaReportLoading, setLuaReportLoading] = useState(false);
  const [projectLoading, setProjectLoading] = useState(false);
  const [projectLoadProgress, setProjectLoadProgress] = useState({ current: 0, total: 0, known: false });
  const automaticLoads = useRef(new AutomaticLoads());
  const selectedProjectIdRef = useRef('');
  const projectListRequest = useRef(0);
  const projectRequestRef = useRef(0);
  const loadController = useRef<AbortController | null>(null);
  const loadedProjectIdRef = useRef(project?.id);
  loadedProjectIdRef.current = project?.id;
  const projectOverviewRequestRef = useRef(0);
  const resourcesRequestRef = useRef(0);
  const luaReportRequestRef = useRef(0);

  const selectProject = useCallback((projectId: string) => {
    // Clicking the active project does not change selectedProjectId, so its loading effect
    // will not rerun. Avoid turning the mask on without a request that can clear it.
    if (selectedProjectIdRef.current === projectId) return;
    automaticLoads.current.clear();
    loadController.current?.abort();
    projectRequestRef.current += 1;
    setProjectLoading(Boolean(projectId));
    setProjectLoadProgress({ current: 0, total: 0, known: false });
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
    setProject(null);
    setGlossary([]);
    setProtocols([]);
    setSelectedSegmentId('');
    setProjectOverview(null);
    projectOverviewRequestRef.current += 1;
    setProjectOverviewLoading(false);
    setResources(null);
    resourcesRequestRef.current += 1;
    setResourcesLoading(false);
    setLuaReport(null);
    luaReportRequestRef.current += 1;
    setLuaReportLoading(false);
  }, []);

  const refreshProjects = useCallback(async (syncSettings = true) => {
    const requestId = ++projectListRequest.current;
    const selectionAtStart = selectedProjectIdRef.current;
    const refreshQuery = syncSettings ? '?fresh=1' : '';
    const [summary, list] = await Promise.all([
      api<Dashboard>('/api/dashboard' + refreshQuery),
      api<ProjectSummary[]>('/api/projects?fresh=1'),
    ]);
    if (requestId !== projectListRequest.current) return;
    if (syncSettings) onSettingsLoaded(summary.settings);
    setProjects(list);
    const currentProjectExists = list.some((item) => item.id === selectedProjectIdRef.current);
    if (!currentProjectExists && selectionAtStart === selectedProjectIdRef.current) selectProject(list[0]?.id || '');
  }, [onSettingsLoaded, selectProject]);

  const refreshProject = useCallback(async (projectId: string) => {
    // A save from the previous project must not supersede the new project's load.
    if (!projectId || selectedProjectIdRef.current !== projectId) return;
    const requestId = ++projectRequestRef.current;
    const [detail, terms, protocolSchemas] = await Promise.all([
      api<ProjectDetail>(`/api/projects/${projectId}`),
      api<GlossaryTerm[]>(`/api/projects/${projectId}/glossary`),
      api<ProtocolSchema[]>(`/api/projects/${projectId}/protocols`),
    ]);
    if (selectedProjectIdRef.current !== projectId || requestId !== projectRequestRef.current) return;
    setProject({ ...detail, status: workflowState(detail).status });
    setProjectLoading(false);
    setGlossary(terms);
    setProtocols(protocolSchemas);
    setSelectedSegmentId((current) => current && detail.segments.some((segment) => segment.id === current)
      ? current
      : detail.segments.find((segment) => segment.reviewStatus === 'pending')?.id || detail.segments[0]?.id || '');
  }, []);

  const loadProjectProgressively = useCallback(async (projectId: string, requestId: number) => {
    loadController.current?.abort();
    const controller = new AbortController();
    loadController.current = controller;
    const { signal } = controller;
    const detailPromise = api<ProjectDetail>(`/api/projects/${projectId}?segments=none`, { signal });
    const segmentsPromise = detailPromise.then(async detail => {
      const total = detail.scanSummary?.totalSegments ?? 0;
      signal.throwIfAborted();
      setProjectLoadProgress({ current: 0, total, known: true });
      return loadSegmentPages<Segment>(total, PROJECT_SEGMENT_PAGE_SIZE,
        (offset, limit) => api<ProjectSegmentsPage>(`/api/projects/${projectId}/segments?offset=${offset}&limit=${limit}`, { signal }),
        current => { if (!signal.aborted) setProjectLoadProgress({ current, total, known: true }); }, signal);
    });
    let result;
    try {
      result = await Promise.all([detailPromise, segmentsPromise,
        api<GlossaryTerm[]>(`/api/projects/${projectId}/glossary`, { signal }),
        api<ProtocolSchema[]>(`/api/projects/${projectId}/protocols`, { signal })]);
    } catch (error) { controller.abort(); throw error; }
    const [detail, segments, terms, protocolSchemas] = result;
    if (projectRequestRef.current !== requestId || selectedProjectIdRef.current !== projectId) return;
    setProject({ ...detail, segments, status: workflowState({ ...detail, segments }).status });
    setGlossary(terms);
    setProtocols(protocolSchemas);
    setScope(detail.scope);
    setSelectedSegmentId((current) => current && segments.some((segment) => segment.id === current)
      ? current
      : segments.find((segment) => segment.reviewStatus === 'pending')?.id || segments[0]?.id || '');
  }, []);

  const loadProjectOverview = useCallback(async (projectId = project?.id) => {
    if (!projectId || selectedProjectIdRef.current !== projectId) return;
    const requestId = ++projectOverviewRequestRef.current;
    const loadingStartedAt = Date.now();
    setProjectOverviewLoading(true);
    clearError();
    try {
      const overview = await api<ProjectOverview>(`/api/projects/${projectId}/overview`);
      if (projectOverviewRequestRef.current === requestId && selectedProjectIdRef.current === projectId) {
        setProjectOverview(overview);
      }
    } catch (overviewError) {
      if (projectOverviewRequestRef.current === requestId && selectedProjectIdRef.current === projectId) onError(overviewError);
    } finally {
      const remaining = LOADING_MASK_MINIMUM_MS - (Date.now() - loadingStartedAt);
      if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      if (projectOverviewRequestRef.current === requestId && selectedProjectIdRef.current === projectId) {
        setProjectOverviewLoading(false);
      }
    }
  }, [clearError, onError, project?.id]);

  const loadResources = useCallback(async (projectId = project?.id) => {
    if (!projectId || selectedProjectIdRef.current !== projectId) return;
    const requestId = ++resourcesRequestRef.current;
    const loadingStartedAt = Date.now();
    setResourcesLoading(true);
    clearError();
    try {
      const inspection = await api<ResourceInspection>(`/api/projects/${projectId}/resources`);
      if (resourcesRequestRef.current === requestId && selectedProjectIdRef.current === projectId) {
        setResources(inspection);
      }
    } catch (resourceError) {
      if (resourcesRequestRef.current === requestId && selectedProjectIdRef.current === projectId) onError(resourceError);
    } finally {
      const remaining = LOADING_MASK_MINIMUM_MS - (Date.now() - loadingStartedAt);
      if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      if (resourcesRequestRef.current === requestId && selectedProjectIdRef.current === projectId) {
        setResourcesLoading(false);
      }
    }
  }, [clearError, onError, project?.id]);

  const loadLuaReport = useCallback(async (projectId = project?.id): Promise<LuaManagementReport | null> => {
    if (!projectId || selectedProjectIdRef.current !== projectId) return null;
    const requestId = ++luaReportRequestRef.current;
    setLuaReportLoading(true);
    clearError();
    let loadedReport: LuaManagementReport | null = null;
    try {
      const report = await api<LuaManagementReport>(`/api/projects/${projectId}/lua/diagnostics`);
      if (luaReportRequestRef.current === requestId && selectedProjectIdRef.current === projectId) {
        setLuaReport(report);
        loadedReport = report;
      }
    } catch (reportError) {
      if (luaReportRequestRef.current === requestId && selectedProjectIdRef.current === projectId) onError(reportError);
    } finally {
      if (luaReportRequestRef.current === requestId && selectedProjectIdRef.current === projectId) {
        setLuaReportLoading(false);
      }
    }
    return loadedReport;
  }, [clearError, onError, project?.id]);

  const invalidateProjectOverview = useCallback(() => {
    automaticLoads.current.clear();
    setProjectOverview(null);
  }, []);

  useEffect(() => {
    void refreshProjects().catch(onError);
  }, [onError, refreshProjects]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
    if (!selectedProjectId || isIndependentTab(tab)) {
      projectRequestRef.current += 1;
      loadController.current?.abort();
      setProjectLoading(false);
      return;
    }
    if (project?.id === selectedProjectId) return;
    const expectedProjectId = selectedProjectId;
    const requestId = ++projectRequestRef.current;
    setProjectLoading(true);
    setProjectLoadProgress({ current: 0, total: 0, known: false });
    void loadProjectProgressively(expectedProjectId, requestId)
      .catch((error) => {
        if (projectRequestRef.current === requestId) onError(error);
      })
      .finally(() => {
        if (projectRequestRef.current === requestId && selectedProjectIdRef.current === expectedProjectId) {
          setProjectLoading(false);
        }
      });
  }, [loadProjectProgressively, onError, project?.id, selectedProjectId, tab]);

  useEffect(() => {
    if (tab !== 'overview' || !project?.id || project.id !== selectedProjectId) return;
    void automaticLoads.current.run('overview:' + project.id + ':' + project.updatedAt, () => loadProjectOverview(project.id));
  }, [project?.updatedAt, loadProjectOverview, project?.id, projectOverview, selectedProjectId, tab]);

  useEffect(() => {
    if (tab !== 'resources' || !project?.id || project.id !== selectedProjectId) return;
    void automaticLoads.current.run('resources:' + project.id + ':' + project.updatedAt, () => loadResources(project.id));
  }, [project?.updatedAt, loadResources, project?.id, resources, selectedProjectId, tab]);

  useEffect(() => {
    if (tab !== 'lua' || !project?.id || project.id !== selectedProjectId) return;
    void automaticLoads.current.run('lua:' + project.id + ':' + project.updatedAt, () => loadLuaReport(project.id));
  }, [project?.updatedAt, loadLuaReport, luaReport, project?.id, selectedProjectId, tab]);


  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        await refreshProjects(false);
        if (stopped) return;
        const currentId = selectedProjectIdRef.current;
        // Allow the first paginated load to finish, including large cards.
        if (currentId && loadedProjectIdRef.current === currentId && !isIndependentTab(tab)) await refreshProject(currentId);
      } catch (error) {
        onError(error);
      } finally {
        if (!stopped) timer = window.setTimeout(poll, 5000);
      }
    };
    timer = window.setTimeout(poll, 5000);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [onError, refreshProjects, refreshProject, tab]);

  return {
    projects,
    project,
    setProject,
    selectedProjectId,
    selectedProjectIdRef,
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
    selectProject,
    refreshProjects,
    refreshProject,
    loadProjectOverview,
    loadResources,
    loadLuaReport,
    invalidateProjectOverview,
  };
}
