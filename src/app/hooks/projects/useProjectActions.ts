import type { Dispatch, SetStateAction } from 'react';
import { api, jsonBody } from '../../../api';
import type { ProjectDetail, ScopePreset, PortraitRouterRepairPreview } from '../../../types';
import type { RunWorkbenchAction, ShowUiConfirm } from '../contracts';

interface UseProjectActionsOptions {
  project: ProjectDetail | null;
  scope: ScopePreset;
  setProject: Dispatch<SetStateAction<ProjectDetail | null>>;
  refreshProject: (projectId: string) => Promise<void>;
  refreshProjects: (syncSettings?: boolean) => Promise<void>;
  selectProject: (projectId: string) => void;
  invalidateProjectOverview: () => void;
  runAction: RunWorkbenchAction;
  showUiConfirm: ShowUiConfirm;
  onNotice: (notice: string) => void;
}

export function useProjectActions({
  project,
  scope,
  setProject,
  refreshProject,
  refreshProjects,
  selectProject,
  invalidateProjectOverview,
  runAction,
  showUiConfirm,
  onNotice,
}: UseProjectActionsOptions) {
  async function scan(scopeOverride?: ScopePreset) {
    if (!project) return;
    await runAction('scan', async () => {
      const result = await api<{
        preservedCount: number;
        newCount: number;
        protocolCount: number;
        pendingProtocolCount: number;
        runtimeRiskCount?: number;
        runtimeRiskPaths?: string[];
      }>(`/api/projects/${project.id}/scan`, { method: 'POST', ...jsonBody({ scope: scopeOverride ?? scope }) });
      const runtimeNotice = result.runtimeRiskCount
        ? `；发现 ${result.runtimeRiskCount} 个运行时状态风险（${(result.runtimeRiskPaths ?? []).slice(0, 2).join('；')}）`
        : '';
      onNotice(`扫描完成：保留 ${result.preservedCount} 条，新增 ${result.newCount} 条；发现 ${result.protocolCount} 种协议，${result.pendingProtocolCount} 种待确认${runtimeNotice}。`);
      invalidateProjectOverview();
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
  }

  async function updateProjectLanguageRule(mode: 'target' | 'preserve') {
    if (!project || project.languageBehaviorMode === mode) return;
    await runAction('language-rule', async () => {
      const updated = await api<ProjectDetail>(`/api/projects/${project.id}/language-rule`, {
        method: 'PATCH', ...jsonBody({ mode }),
      });
      setProject((current) => current ? { ...current, languageBehaviorMode: updated.languageBehaviorMode } : current);
      onNotice(mode === 'target' ? '已启用“卡片语言设定：跟随目标语言”。' : '已切换为“卡片语言设定：保留卡片原设定”。');
    });
  }

  async function previewPortraitRouter(): Promise<PortraitRouterRepairPreview> {
    if (!project) throw new Error('请先选择项目。');
    return api<PortraitRouterRepairPreview>(`/api/projects/${project.id}/lua/router-repair/preview`);
  }

  async function repairPortraitRouter() {
    if (!project) return;
    await runAction('router-repair', async () => {
      const result = await api<{ applied: Array<{ title: string }> }>(`/api/projects/${project.id}/lua/router-repair`, {
        method: 'POST', ...jsonBody({}),
      });
      onNotice(result.applied.length
        ? `已固化 ${result.applied.length} 项路由修复到模块基线和当前草稿；后续保存不会覆盖它。`
        : '当前模块没有可应用的已知路由修复。');
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
  }

  async function deleteProject() {
    if (!project || !await showUiConfirm({
      title: '删除项目',
      message: `删除项目“${project.name}”？\n原始导入文件不会被删除。`,
      confirmLabel: '删除项目',
      tone: 'danger',
    })) return;
    await runAction('delete', async () => {
      await api(`/api/projects/${project.id}`, { method: 'DELETE' });
      selectProject('');
      await refreshProjects();
    });
  }

  return { scan, updateProjectLanguageRule, previewPortraitRouter, repairPortraitRouter, deleteProject };
}
