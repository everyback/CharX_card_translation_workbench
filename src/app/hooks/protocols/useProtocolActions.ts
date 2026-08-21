import type { Dispatch, SetStateAction } from 'react';
import { api, jsonBody } from '../../../api';
import type {
  ProjectDetail,
  ProtocolFieldRule,
  ProtocolSchema,
  ProtocolStatus,
  ScopePreset,
  Settings,
} from '../../../types';
import type { RunWorkbenchAction, ShowUiConfirm } from '../contracts';

interface UseProtocolActionsOptions {
  project: ProjectDetail | null;
  protocols: ProtocolSchema[];
  scope: ScopePreset;
  settings: Settings | null;
  setProtocols: Dispatch<SetStateAction<ProtocolSchema[]>>;
  refreshProject: (projectId: string) => Promise<void>;
  refreshProjects: (syncSettings?: boolean) => Promise<void>;
  runAction: RunWorkbenchAction;
  showUiConfirm: ShowUiConfirm;
  onNotice: (notice: string) => void;
  onOpenSettings: () => void;
}

export function useProtocolActions({
  project,
  protocols,
  scope,
  settings,
  setProtocols,
  refreshProject,
  refreshProjects,
  runAction,
  showUiConfirm,
  onNotice,
  onOpenSettings,
}: UseProtocolActionsOptions) {
  async function discoverProjectProtocols() {
    if (!project) return;
    await runAction('protocol-discover', async () => {
      const result = await api<{
        schemaCount: number;
        occurrenceCount: number;
        pendingCount: number;
        protocols: ProtocolSchema[];
      }>(`/api/projects/${project.id}/protocols/discover`, { method: 'POST', ...jsonBody({}) });
      setProtocols(result.protocols);
      onNotice(`发现 ${result.schemaCount} 种协议、${result.occurrenceCount} 个实例；${result.pendingCount} 种等待确认。`);
    });
  }

  async function analyzeProjectProtocols(schemaIds: string[]) {
    if (!project || !schemaIds.length) return;
    if (!settings?.apiKeyConfigured || !settings.model) {
      onOpenSettings();
      return;
    }
    await runAction('protocol-analyze', async () => {
      const result = await api<{
        analyzed: number;
        failed: number;
        protocols: ProtocolSchema[];
      }>(`/api/projects/${project.id}/protocols/analyze`, {
        method: 'POST',
        ...jsonBody({ schemaIds }),
      });
      setProtocols(result.protocols);
      onNotice(result.failed
        ? `模型完成 ${result.analyzed} 种协议判断，${result.failed} 种失败，可查看错误后重试。`
        : `模型完成 ${result.analyzed} 种协议的槽位判断。`);
    });
  }

  async function saveProtocolRule(schemaId: string, status: ProtocolStatus, fields: ProtocolFieldRule[]) {
    if (!project) return;
    await runAction('protocol-save', async () => {
      await api<ProtocolSchema>(`/api/projects/${project.id}/protocols/${schemaId}`, {
        method: 'PATCH',
        ...jsonBody({ status, fields }),
      });
      const result = await api<{ preservedCount: number; newCount: number }>(`/api/projects/${project.id}/scan`, {
        method: 'POST',
        ...jsonBody({ scope }),
      });
      onNotice(status === 'approved'
        ? `协议规则已采用并重新扫描：保留 ${result.preservedCount} 条，新增 ${result.newCount} 条协议槽位或文本片段。`
        : '协议已忽略，并按原有字段规则重新扫描。');
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
  }

  async function approveHighConfidenceProtocols(schemaIds: string[]) {
    if (!project || !schemaIds.length) return;
    const selected = protocols.filter((protocol) => schemaIds.includes(protocol.id));
    if (!await showUiConfirm({
      title: '采用协议规则',
      message: `采用 ${selected.length} 种高置信度协议规则并重新扫描字段？\n与这些协议重叠的旧整段译文可能需要重新翻译。`,
      confirmLabel: '采用并重新扫描',
      tone: 'warning',
    })) return;
    await runAction('protocol-approve', async () => {
      await Promise.all(selected.map((protocol) => api<ProtocolSchema>(
        `/api/projects/${project.id}/protocols/${protocol.id}`,
        { method: 'PATCH', ...jsonBody({ status: 'approved', fields: protocol.fieldRules }) },
      )));
      const result = await api<{ preservedCount: number; newCount: number }>(`/api/projects/${project.id}/scan`, {
        method: 'POST',
        ...jsonBody({ scope }),
      });
      onNotice(`已采用 ${selected.length} 种高置信度规则并重新扫描，新增 ${result.newCount} 条协议槽位或文本片段。`);
      await Promise.all([refreshProject(project.id), refreshProjects()]);
    });
  }

  return {
    discoverProjectProtocols,
    analyzeProjectProtocols,
    saveProtocolRule,
    approveHighConfidenceProtocols,
  };
}
