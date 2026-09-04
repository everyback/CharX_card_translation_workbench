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
      <button className="secondary-button" onClick={onScan} disabled={Boolean(busy)}>
        {busy === 'scan' ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}扫描字段
      </button>
      <button className="primary-button" onClick={onStartTranslation} disabled={!project.segments.length || Boolean(busy) || activeTranslationJob} title={activeTranslationJob ? '翻译任务进行中，完成或失败后才能再次执行' : undefined}>
        {busy === 'start' ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}开始翻译
      </button>
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
