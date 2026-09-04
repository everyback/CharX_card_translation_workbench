import type { Dispatch, SetStateAction } from 'react';
import { api, jsonBody } from '@/shared/api/http';
import type { ProjectDetail, ScopePreset, PortraitRouterRepairPreview } from '@/shared/types';
import type { RunWorkbenchAction, ShowUiConfirm } from '@/shared/model/workbench-actions';

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

  async function repairPortraitRouter(changes?: PortraitRouterRepairPreview['changes']) {
    if (!project) return;
    await runAction('router-repair', async () => {
      const result = await api<{ applied: Array<{ title: string }> }>(`/api/projects/${project.id}/lua/router-repair`, {
        method: 'POST', ...jsonBody({ changes: changes ?? [] }),
      });
      onNotice(result.applied.length
        ? `已将 ${result.applied.length} 项路由修复写入当前翻译稿模块；原始模块保持不变。`
        : '当前模块没有可应用的已知路由修复。');
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
  }

  async function resetLuaDraft() {
    if (!project || !await showUiConfirm({
      title: '恢复原始 Lua 草稿',
      message: '这只会恢复 Lua 模块草稿，并清除 Lua 页面已保存的语法修复、正则覆盖、名称别名和路由修复。卡片正文、翻译结果、资源草稿和原始模块不会被修改。',
      confirmLabel: '恢复 Lua 草稿',
      tone: 'danger',
    })) return;
    await runAction('lua-reset', async () => {
      const result = await api<{ reset: boolean }>(`/api/projects/${project.id}/lua/reset-draft`, {
        method: 'POST', ...jsonBody({}),
      });
      onNotice(result.reset ? '已恢复原始 Lua 草稿；原始模块保持不变。' : '当前 Lua 草稿已经是原始模块，无需恢复。');
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

  return { scan, updateProjectLanguageRule, previewPortraitRouter, repairPortraitRouter, resetLuaDraft, deleteProject };
}
