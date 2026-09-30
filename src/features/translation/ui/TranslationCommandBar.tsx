import { workflowState } from '../model/workflow-state';
import { ChevronDown, LoaderCircle, Play, Search } from 'lucide-react';
import { SCOPE_OPTIONS } from '../model/scope';
import type { ScopePreset, Settings, ProjectDetail } from '@/shared/types';

export interface TranslationCommandBarProps {
  project: ProjectDetail;
  scope: ScopePreset;
  busy: string;
  settings: Settings | null;
  activeTranslationJob: boolean;
  onScopeChange: (scope: ScopePreset) => void;
  onScan: () => void;
  onStartTranslation: () => void;
  onLanguageRuleChange: (mode: 'target' | 'preserve') => void;
}

export function TranslationCommandBar({
  project,
  scope,
  busy,
  settings,
  activeTranslationJob,
  onScopeChange,
  onScan,
  onStartTranslation,
  onLanguageRuleChange,
}: TranslationCommandBarProps) {
  const workflow = workflowState(project);
  const running = workflow.active && workflow.active.status !== 'paused';
  const scopeChanged = scope !== project.scope;
  return (
    <section className="command-band">
      <label className="select-field">
        <span>翻译范围</span>
        <div className="select-wrap">
          <select value={scope} onChange={(event) => onScopeChange(event.target.value as ScopePreset)}>
            {SCOPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <ChevronDown size={15} />
        </div>
      </label>
      <button
        className="secondary-button"
        onClick={onScan}
        disabled={Boolean(busy) || activeTranslationJob}
        title={activeTranslationJob ? '翻译任务进行中，完成或取消后才能重新扫描' : undefined}
      >
        {busy === 'scan' ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}扫描字段
      </button>
      <button className="primary-button" onClick={onStartTranslation} disabled={Boolean(busy) || !running && (scopeChanged || !workflow.canStart)}>
        {busy === 'start' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}{running ? '查看翻译进度' : workflow.retryAction ? workflow.latest?.failedItems ? '重试失败项与阶段 2' : '重试阶段 2' : workflow.resumable ? '继续翻译' : workflow.canStart ? '开始翻译' : '没有待翻译项'}
      </button>
      {scopeChanged && <span className="scope-change-note" role="status">范围已变化，请重新扫描；已有译文会保留。</span>}
      <div className="command-spacer" />
      <span className="model-name">{settings?.model || '未配置模型'}</span>
      <label className={`language-rule-badge ${project.languageBehaviorMode === 'preserve' ? 'preserve' : ''}`} title="项目级卡片语言设定">
        <span>卡片语言设定</span>
        <select value={project.languageBehaviorMode} onChange={(event) => onLanguageRuleChange(event.target.value as 'target' | 'preserve')}>
          <option value="target">跟随目标语言</option>
          <option value="preserve">保留卡片原设定</option>
        </select>
      </label>
    </section>
  );
}
