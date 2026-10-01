import type { Dispatch, SetStateAction } from 'react';
import { api, jsonBody } from '@/shared/api/http';
import type { ProjectDetail, ProjectSummary, ScopePreset, PortraitRouterRepairPreview } from '@/shared/types';
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
    await scanProject(project.id, scopeOverride, 'scan');
  }

  async function scanProject(projectId: string, scopeOverride?: ScopePreset, actionLabel = `scan-${projectId}`) {
    await runAction(actionLabel, async () => {
      const result = await api<{
        preservedCount: number;
        newCount: number;
        protocolCount: number;
        pendingProtocolCount: number;
        runtimeRiskCount?: number;
        runtimeRiskPaths?: string[];
        reusedCount?: number;
      }>(`/api/projects/${projectId}/scan`, { method: 'POST', ...jsonBody({ scope: scopeOverride ?? scope }) });
      const runtimeNotice = result.runtimeRiskCount
        ? `；发现 ${result.runtimeRiskCount} 个运行时状态风险（${(result.runtimeRiskPaths ?? []).slice(0, 2).join('；')}）`
        : '';
      onNotice(`扫描完成：保留 ${result.preservedCount} 条，新扫描 ${result.newCount} 条${result.reusedCount ? `，其中复用旧版译文 ${result.reusedCount} 条（待审核，无需再次翻译）` : ''}；发现 ${result.protocolCount} 种协议，${result.pendingProtocolCount} 种待确认${runtimeNotice}。`);
      invalidateProjectOverview();
      await Promise.all([refreshProject(projectId), refreshProjects()]);
    });
  }

  async function updateProjectLanguageRule(mode: 'target' | 'preserve') {
    if (!project || project.languageBehaviorMode === mode) return;
    await runAction('language-rule', async () => {
      const updated = await api<ProjectDetail>(`/api/projects/${project.id}/language-rule`, {
        method: 'PATCH', ...jsonBody({ mode }),
      });
      setProject((current) => current?.id === project.id ? { ...current, languageBehaviorMode: updated.languageBehaviorMode } : current);
      onNotice(mode === 'target' ? '已启用“卡片语言设定：跟随目标语言”。' : '已切换为“卡片语言设定：保留卡片原设定”。');
    });
  }

  async function reuseVersionTranslations() {
    if (!project) return;
    await runAction('reuse-version', async () => {
      const result = await api<{ reusedCount: number }>(`/api/projects/${project.id}/versions/reuse`, { method: 'POST' });
      onNotice(result.reusedCount
        ? `已补用 ${result.reusedCount} 条旧版译文，进入当前版本待审核。`
        : '没有可补用的译文；当前已有译文和人工修改均已保留。');
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
  }

  async function previewPortraitRouter(): Promise<PortraitRouterRepairPreview> {
    if (!project) throw new Error('请先选择项目。');
    return api<PortraitRouterRepairPreview>(`/api/projects/${project.id}/lua/router-repair/preview`);
  }

  async function repairPortraitRouter(changes?: PortraitRouterRepairPreview['changes']) {
    if (!project) return;
    let saved = false;
    await runAction('router-repair', async () => {
      const result = await api<{ applied: Array<{ title: string }> }>(`/api/projects/${project.id}/lua/router-repair`, {
        method: 'POST', ...jsonBody({ changes: changes ?? [] }),
      });
      saved = true;
      onNotice(result.applied.length
        ? `已将 ${result.applied.length} 项路由修复写入当前翻译稿模块；原始模块保持不变。`
        : '当前模块没有可应用的已知路由修复。');
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
    return saved;
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
      title: '删除当前版本',
      message: `删除“${project.name}”的 ${project.versionLabel || 'V1'} 版本及其译文？\n作为后续版本基础的版本需要保留。你在工作台外的原始文件不受影响。`,
      confirmLabel: '删除当前版本',
      tone: 'danger',
    })) return;
    await runAction('delete', async () => {
      await api(`/api/projects/${project.id}`, { method: 'DELETE' });
      selectProject('');
      await refreshProjects();
    });
  }

  async function deleteProjectFamily(target: ProjectSummary) {
    const count = target.versionCount || 1;
    if (!await showUiConfirm({ title: '删除整个项目',
      message: `永久删除“${target.translatedName || target.originalName || target.name}”及其全部 ${count} 个版本？\n工作台内的原始导入副本、译文、审核记录、任务和资源都会删除，无法撤销。工作台外的原始文件和已导出文件不受影响。`,
      confirmLabel: `删除项目及 ${count} 个版本`, tone: 'danger' })) return;
    await runAction('delete-family', async () => {
      const result = await api<{ cleanupFailed: number }>(`/api/projects/${target.id}/family`, { method: 'DELETE', ...jsonBody({ expectedVersionCount: count }) });
      onNotice(result.cleanupFailed ? '项目记录已删除，但部分本地资源清理失败。' : '已删除整个项目及其所有版本。');
      await refreshProjects();
    });
  }

  return { scan, scanProject, updateProjectLanguageRule, reuseVersionTranslations, previewPortraitRouter, repairPortraitRouter, resetLuaDraft, deleteProject, deleteProjectFamily };
}
