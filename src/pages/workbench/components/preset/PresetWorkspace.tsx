import { Button } from '@/shared/ui/button/Button';
import { AlertTriangle, Download, FileJson, Plug, RotateCcw } from 'lucide-react';
import { usePresetProject } from '@/features/preset/model/usePresetProject';
import type { ShowUiConfirm, ShowWorkbenchError } from '@/shared/model/workbench-actions';
import { LoadingMask } from '@/shared/ui';
import { PresetConversionPanel } from './PresetConversionPanel';
import { PresetPromptList } from './PresetPromptList';

export interface PresetWorkspaceProps {
  projectId: string;
  projectName: string;
  onError: ShowWorkbenchError;
  onNotice: (notice: string) => void;
  confirm: ShowUiConfirm;
  onOpenPlugins: () => void;
}

/**
 * Dedicated workspace for SillyTavern preset projects.
 *
 * Converting a preset is a format change, not a translation: there is nothing to
 * scan, translate or approve. The flow is import → (optional edit) → export, and
 * the export reads the draft directly, so no apply step is involved.
 */
export function PresetWorkspace({ projectId, projectName, onError, onNotice, confirm, onOpenPlugins }: PresetWorkspaceProps) {
  const { view, loading, saving, warnings, saveText, reset, selectBlock } = usePresetProject({
    projectId,
    onError,
    onNotice,
    confirm,
  });

  if (!view) {
    return (
      <section className="preset-workspace">
        {loading && <LoadingMask label="正在读取预设转换状态" />}
      </section>
    );
  }

  return (
    <section className="preset-workspace">
      {loading && <LoadingMask label="正在更新预设转换状态" />}

      <div className="preset-hero">
        <div>
          <span className="preset-eyebrow">SillyTavern 预设 → RisuAI 预设</span>
          <h1>{projectName}</h1>
          <p>这里只做格式转换：按兼容性报告转换提示词与开关；无法等价迁移的内容可完整存档，正文可人工微调。不需要翻译就不必进入翻译流程。</p>
        </div>
        <div className="preset-hero-actions">
          {view.report.issues.some((item) => item.severity === 'error') ? (
            <Button variant="default" disabled title="请先处理下方报告中的运行兼容问题">.risup 待迁移</Button>
          ) : <a className="primary-button" href={`/api/projects/${projectId}/export`} download>
            <Download size={16} />下载 .risup
          </a>}
          <a className="secondary-button" href={`/api/projects/${projectId}/export?presetBundle=true`} download>
            <Download size={16} />下载完整存档包
          </a>
          <a className="secondary-button" href={`/api/projects/${projectId}/preset-report`} target="_blank" rel="noreferrer">
            <FileJson size={15} />查看报告 JSON
          </a>
          {view.capabilities.summary.requiresPlugin && <Button variant="outline" type="button" onClick={onOpenPlugins}>
            <Plug size={15} />插件与补丁
          </Button>}
          <Button
            variant="outline"
            type="button"
            disabled={saving || !view.editedCount}
            onClick={() => void reset()}
          >
            <RotateCcw size={15} />恢复全部原文
          </Button>
        </div>
      </div>

      {view.editedCount > 0 && (
        <div className="preset-note">
          <AlertTriangle size={14} />
          <div><span>已改动 {view.editedCount} 条提示词。导出的 .risup 使用改动后的内容；原始文件始终保留，可随时恢复。</span></div>
        </div>
      )}

      {warnings.length > 0 && (
        <div className="preset-note warn">
          <AlertTriangle size={14} />
          <div>{warnings.map((warning) => <span key={warning}>{warning}</span>)}</div>
        </div>
      )}

      <PresetConversionPanel view={view} busy={saving} onSelectBlock={(blockIndex) => void selectBlock(blockIndex)} />

      <PresetPromptList
        prompts={view.prompts}
        busy={saving}
        onSave={saveText}
        onReset={(path) => reset(path)}
      />
    </section>
  );
}
