import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, jsonBody } from '@/shared/api/http';
import type { ShowUiConfirm, ShowWorkbenchError } from '@/shared/model/workbench-actions';
import type { PresetEditResult, PresetProjectView, SetvarRemovalNotice } from './types';

interface UsePresetProjectOptions {
  projectId: string;
  onError: ShowWorkbenchError;
  onNotice: (notice: string) => void;
  confirm: ShowUiConfirm;
}

type EditPath = Array<string | number>;

const SETVAR_DEFINITION_REMOVED = 'SETVAR_DEFINITION_REMOVED';

/** Reads back the `confirmRemovals` payload the API attaches to a refused edit. */
function readRemovals(payload: Record<string, unknown>): SetvarRemovalNotice[] {
  if (payload.code !== SETVAR_DEFINITION_REMOVED) return [];
  const raw = payload.removals;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== 'string') return [];
    const references = Array.isArray(record.references)
      ? record.references.filter((value): value is number => typeof value === 'number')
      : [];
    return [{ name: record.name, references }];
  });
}

function describeRemovals(removals: readonly SetvarRemovalNotice[]): string {
  return removals
    .map((removal) => {
      const where = removal.references.length
        ? `第 ${removal.references.map((index) => index + 1).join('、')} 条提示词会取到空字符串`
        : '当前没有引用处';
      return `• 删除变量 ${removal.name} 的定义后，${where}。`;
    })
    .join('\n');
}

/**
 * Loads and mutates a SillyTavern preset project.
 *
 * Edits are written straight through — the draft is a separate column and the
 * original is never touched, so "restore" is always available and there is no
 * reason to stage changes behind a save button.
 */
export function usePresetProject({ projectId, onError, onNotice, confirm }: UsePresetProjectOptions) {
  const [view, setView] = useState<PresetProjectView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    if (!projectId) {
      setView(null);
      return;
    }
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const result = await api<PresetProjectView>(`/api/projects/${projectId}/preset-report`);
      if (requestId === requestRef.current) setView(result);
    } catch (error) {
      if (requestId === requestRef.current) onError(error);
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [projectId, onError]);

  useEffect(() => {
    setWarnings([]);
    void load();
  }, [load]);

  const applyResult = useCallback((result: PresetEditResult) => {
    setView(result);
    setWarnings(result.warnings ?? []);
    return result;
  }, []);

  /** Writes one field. Prompts for explicit confirmation before dropping a live variable definition. */
  const saveText = useCallback(async (path: EditPath, text: string): Promise<boolean> => {
    setSaving(true);
    try {
      const result = await api<PresetEditResult>(`/api/projects/${projectId}/preset-prompt`, {
        method: 'PUT',
        ...jsonBody({ path, text }),
      });
      applyResult(result);
      return true;
    } catch (error) {
      const removals = error instanceof ApiError ? readRemovals(error.payload) : [];
      if (!removals.length) {
        onError(error);
        return false;
      }
      const accepted = await confirm({
        title: '这会删除仍在使用的变量定义',
        message: `${describeRemovals(removals)}\n\n这些提示词在 RisuAI 里会变成空字符串，而预设看起来仍然正常。确定继续吗？`,
        confirmLabel: '仍然删除',
        cancelLabel: '取消',
        tone: 'danger',
      });
      if (!accepted) return false;
      try {
        const forced = await api<PresetEditResult>(`/api/projects/${projectId}/preset-prompt`, {
          method: 'PUT',
          ...jsonBody({ path, text, confirmRemovals: removals.map((removal) => removal.name) }),
        });
        applyResult(forced);
        onNotice(`已删除 ${removals.length} 个变量定义，请确认相关提示词仍然成立。`);
        return true;
      } catch (retryError) {
        onError(retryError);
        return false;
      }
    } finally {
      setSaving(false);
    }
  }, [applyResult, confirm, onError, onNotice, projectId]);

  const reset = useCallback(async (path?: EditPath) => {
    setSaving(true);
    try {
      const result = await api<PresetProjectView>(`/api/projects/${projectId}/preset-reset`, {
        method: 'POST',
        ...jsonBody(path ? { path } : {}),
      });
      setView(result);
      setWarnings([]);
      onNotice(path ? '已恢复该条原文。' : '已恢复全部原文。');
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      setSaving(false);
    }
  }, [onError, onNotice, projectId]);

  const selectBlock = useCallback(async (blockIndex: number | null) => {
    setSaving(true);
    try {
      await api(`/api/projects/${projectId}/preset-block`, {
        method: 'PUT',
        ...jsonBody({ blockIndex }),
      });
      await load();
      return true;
    } catch (error) {
      onError(error);
      return false;
    } finally {
      setSaving(false);
    }
  }, [load, onError, projectId]);

  return { view, loading, saving, warnings, setWarnings, saveText, reset, selectBlock, reload: load };
}
