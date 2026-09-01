import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../api';
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
} from '../../../types';
import { DEFAULT_SCOPE } from '../../../constants';
import { LOADING_MASK_MINIMUM_MS, PROJECT_SEGMENT_PAGE_SIZE } from '../../constants';
import type { ShowWorkbenchError } from '../contracts';

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
  const selectedProjectIdRef = useRef('');
  const projectRequestRef = useRef(0);
  const projectOverviewRequestRef = useRef(0);
  const resourcesRequestRef = useRef(0);
  const luaReportRequestRef = useRef(0);

  const selectProject = useCallback((projectId: string) => {
    // Clicking the active project does not change selectedProjectId, so its loading effect
    // will not rerun. Avoid turning the mask on without a request that can clear it.
    if (selectedProjectIdRef.current === projectId) return;
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
    const [summary, list] = await Promise.all([
      api<Dashboard>('/api/dashboard'),
      api<ProjectSummary[]>('/api/projects'),
    ]);
    if (syncSettings) onSettingsLoaded(summary.settings);
    setProjects(list);
    const currentProjectExists = list.some((item) => item.id === selectedProjectIdRef.current);
    if (!currentProjectExists) selectProject(list[0]?.id || '');
  }, [onSettingsLoaded, selectProject]);

  const refreshProject = useCallback(async (projectId: string) => {
    if (!projectId) {
      setProject(null);
      return;
    }
    const [detail, terms, protocolSchemas] = await Promise.all([
      api<ProjectDetail>(`/api/projects/${projectId}`),
      api<GlossaryTerm[]>(`/api/projects/${projectId}/glossary`),
      api<ProtocolSchema[]>(`/api/projects/${projectId}/protocols`),
    ]);
    if (selectedProjectIdRef.current !== projectId) return;
    setProject(detail);
    setGlossary(terms);
    setProtocols(protocolSchemas);
    setScope(detail.scope);
    setSelectedSegmentId((current) => current && detail.segments.some((segment) => segment.id === current)
      ? current
      : detail.segments.find((segment) => segment.reviewStatus === 'pending')?.id || detail.segments[0]?.id || '');
  }, []);

  const loadProjectProgressively = useCallback(async (projectId: string, requestId: number) => {
    const [detail, terms, protocolSchemas] = await Promise.all([
      api<ProjectDetail>(`/api/projects/${projectId}?segments=none`),
      api<GlossaryTerm[]>(`/api/projects/${projectId}/glossary`),
      api<ProtocolSchema[]>(`/api/projects/${projectId}/protocols`),
    ]);
    if (projectRequestRef.current !== requestId || selectedProjectIdRef.current !== projectId) return;

    let total = detail.scanSummary?.totalSegments ?? 0;
    const segments: Segment[] = [];
    setProjectLoadProgress({ current: 0, total, known: true });
    for (let offset = 0; offset < total; offset += PROJECT_SEGMENT_PAGE_SIZE) {
      const page = await api<ProjectSegmentsPage>(
        `/api/projects/${projectId}/segments?offset=${offset}&limit=${PROJECT_SEGMENT_PAGE_SIZE}`,
      );
      if (projectRequestRef.current !== requestId || selectedProjectIdRef.current !== projectId) return;
      segments.push(...page.segments);
      total = page.total;
      setProjectLoadProgress({ current: segments.length, total, known: true });
      if (!page.segments.length && segments.length < total) {
        throw new Error(`卡片段落读取中断：已读取 ${segments.length} / ${total} 段。`);
      }
      if (!page.segments.length) break;
    }

    if (projectRequestRef.current !== requestId || selectedProjectIdRef.current !== projectId) return;
    if (segments.length !== total) {
      throw new Error(`卡片段落数量不一致：已读取 ${segments.length} / ${total} 段。`);
    }
    setProject({ ...detail, segments });
    setGlossary(terms);
    setProtocols(protocolSchemas);
    setScope(detail.scope);
    setSelectedSegmentId((current) => current && segments.some((segment) => segment.id === current)
      ? current
      : segments.find((segment) => segment.reviewStatus === 'pending')?.id || segments[0]?.id || '');
  }, []);

  const loadProjectOverview = useCallback(async (projectId = project?.id) => {
    if (!projectId || projectOverviewLoading) return;
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
      onError(overviewError);
    } finally {
      const remaining = LOADING_MASK_MINIMUM_MS - (Date.now() - loadingStartedAt);
      if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      if (projectOverviewRequestRef.current === requestId && selectedProjectIdRef.current === projectId) {
        setProjectOverviewLoading(false);
      }
    }
  }, [clearError, onError, project?.id, projectOverviewLoading]);

  const loadResources = useCallback(async (projectId = project?.id) => {
    if (!projectId || resourcesLoading) return;
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
      onError(resourceError);
    } finally {
      const remaining = LOADING_MASK_MINIMUM_MS - (Date.now() - loadingStartedAt);
      if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      if (resourcesRequestRef.current === requestId && selectedProjectIdRef.current === projectId) {
        setResourcesLoading(false);
      }
    }
  }, [clearError, onError, project?.id, resourcesLoading]);

  const loadLuaReport = useCallback(async (projectId = project?.id, force = false): Promise<LuaManagementReport | null> => {
    if (!projectId || (!force && luaReportLoading)) return null;
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
      onError(reportError);
    } finally {
      if (luaReportRequestRef.current === requestId && selectedProjectIdRef.current === projectId) {
        setLuaReportLoading(false);
      }
    }
    return loadedReport;
  }, [clearError, luaReportLoading, onError, project?.id]);

  const invalidateProjectOverview = useCallback(() => setProjectOverview(null), []);

  useEffect(() => {
    void refreshProjects().catch(onError);
  }, [onError, refreshProjects]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
    if (!selectedProjectId) {
      setProjectLoading(false);
      return;
    }
    const expectedProjectId = selectedProjectId;
    const requestId = ++projectRequestRef.current;
    const loadingStartedAt = Date.now();
    setProjectLoading(true);
    setProjectLoadProgress({ current: 0, total: 0, known: false });
    void loadProjectProgressively(expectedProjectId, requestId)
      .catch(onError)
      .finally(async () => {
        const remaining = LOADING_MASK_MINIMUM_MS - (Date.now() - loadingStartedAt);
        if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
        if (projectRequestRef.current === requestId && selectedProjectIdRef.current === expectedProjectId) {
          setProjectLoading(false);
        }
      });
  }, [loadProjectProgressively, onError, selectedProjectId]);

  useEffect(() => {
    if (tab !== 'overview' || !project?.id || project.id !== selectedProjectId || projectOverview) return;
    void loadProjectOverview(project.id);
  }, [loadProjectOverview, project?.id, projectOverview, selectedProjectId, tab]);

  useEffect(() => {
    if (tab !== 'resources' || !project?.id || project.id !== selectedProjectId || resources) return;
    void loadResources(project.id);
  }, [loadResources, project?.id, resources, selectedProjectId, tab]);

  useEffect(() => {
    if (tab !== 'lua' || !project?.id || project.id !== selectedProjectId || luaReport) return;
    void loadLuaReport(project.id);
  }, [loadLuaReport, luaReport, project?.id, selectedProjectId, tab]);

  useEffect(() => {
    // Scans, approvals, and exports refresh the project timestamp. Drop the
    // cached report so the Lua tab observes the new draft on its next render.
    setLuaReport(null);
  }, [project?.updatedAt]);

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    const poll = async () => {
      try {
        await refreshProjects(false);
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
  }, [onError, refreshProjects]);

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
