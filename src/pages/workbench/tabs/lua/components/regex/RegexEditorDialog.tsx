import { Check, Play, RefreshCw, Search, X } from 'lucide-react';
import { MatchExampleList } from '../shared/MatchExampleList';
import type { RegexRuleTestResult } from '@/shared/types';

export interface RegexEditorState {
  pathLabel: string;
  originalPattern: string;
  currentPattern: string;
  sourceMatchCount: number;
  draftMatchCount: number;
  sourceSamples: string[];
  draftSamples: string[];
  forcePassed: boolean;
  runtimePostprocess: boolean;
  currentOutput: string;
}

export interface RegexEditorDialogProps {
  editor: RegexEditorState;
  pattern: string;
  output: string;
  forcePass: boolean;
  test: RegexRuleTestResult | null;
  candidateNotice: string | null;
  analyzing: boolean;
  testing: boolean;
  saving: boolean;
  onClose: () => void;
  onCancelAnalysis: () => void;
  onPatternChange: (value: string) => void;
  onOutputChange: (value: string) => void;
  onForcePassChange: (value: boolean) => void;
  onAnalyze: () => void;
  onTest: () => void;
  onSave: () => void;
}

export function RegexEditorDialog({
  editor,
  pattern,
  output,
  forcePass,
  test,
  candidateNotice,
  analyzing,
  testing,
  saving,
  onClose,
  onCancelAnalysis,
  onPatternChange,
  onOutputChange,
  onForcePassChange,
  onAnalyze,
  onTest,
  onSave,
}: RegexEditorDialogProps) {
  return (
    <div className="modal-backdrop regex-editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving && !analyzing) onClose(); }}>
      <section className="regex-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="regex-editor-title">
        <header className="dialog-header">
          <div><h2 id="regex-editor-title">{editor.runtimePostprocess ? '人工编辑 Lua 聊天后处理' : '人工编辑正则'}</h2><span>{editor.pathLabel} · 仅保存到 Lua 草稿，导出前仍会执行完整校验。</span></div>
          <button className="icon-button" title="关闭" aria-label="关闭正则编辑" disabled={saving || analyzing} onClick={onClose}><X size={16} /></button>
        </header>
        <div className="regex-editor-body">
          <div className="regex-editor-baseline">
            <div><span>原始规则</span><code>{editor.originalPattern}</code></div>
            <div><span>已保存草稿</span><code>{editor.currentPattern}</code></div>
            {editor.runtimePostprocess && <div><span>已保存替换输出</span><code>{editor.currentOutput || '（空字符串：删除全部匹配内容）'}</code></div>}
            <div><span>基线命中</span><strong>原文 {editor.sourceMatchCount} · 当前稿 {editor.draftMatchCount}</strong></div>
          </div>
          <div className="regex-coverage-rule-samples regex-editor-examples">
            <div><span>原文命中示例</span><MatchExampleList samples={editor.sourceSamples} /></div>
            <div><span>当前稿命中示例</span><MatchExampleList samples={editor.draftSamples} /></div>
          </div>
          <label className="regex-editor-input">
            <span>{editor.runtimePostprocess ? '匹配式（in）' : '待测试规则'}</span>
            <textarea value={pattern} disabled={analyzing} onChange={(event) => onPatternChange(event.target.value)} rows={6} spellCheck={false} aria-label={`编辑 ${editor.pathLabel} 正则`} />
          </label>
          {editor.runtimePostprocess && <>
            <label className="regex-editor-input">
              <span>聊天后处理输出（out）</span>
              <textarea value={output} disabled={analyzing} onChange={(event) => onOutputChange(event.target.value)} rows={6} spellCheck={false} aria-label={`编辑 ${editor.pathLabel} 后处理输出`} />
            </label>
            <div className="regex-editor-postprocess-note">此模板决定匹配后的内容是否保留。空字符串会删除全部匹配内容；保存时会保留 editoutput 类型并检查匹配式可编译。</div>
          </>}
          {candidateNotice && <div className="regex-editor-candidate-notice" role="status"><Check size={14} />{candidateNotice}</div>}
          {!editor.runtimePostprocess && <label className="regex-editor-force-pass">
            <input type="checkbox" checked={forcePass} disabled={analyzing} onChange={(event) => onForcePassChange(event.target.checked)} />
            <span><strong>强制通过本条命中校验</strong><small>放弃这条规则的原文/当前稿命中数一致性检测；只对当前规则文本和当前命中数生效，其他结构校验仍保留。</small></span>
          </label>}
          {analyzing && <div className="regex-editor-analysis-lock" role="status"><RefreshCw className="spin" size={14} />大模型正在修正当前规则，输入框和保存操作已锁定。</div>}
          {test && <div className={`regex-editor-test-result ${test.compiled ? 'compiled' : 'invalid'}`}>
            <div><strong>{test.compiled ? '测试完成' : '编译失败'}</strong><span>{test.message}</span></div>
            {test.compiled && <div className="regex-editor-test-count">候选命中：原文 {test.sourceMatchCount} · 当前稿 {test.draftMatchCount}</div>}
            {test.compiled && <div className="regex-coverage-rule-samples regex-editor-examples">
              <div><span>候选原文命中</span><MatchExampleList samples={test.sourceSamples} /></div>
              <div><span>候选当前稿命中</span><MatchExampleList samples={test.draftSamples} /></div>
            </div>}
          </div>}
        </div>
        <footer className="dialog-actions regex-editor-actions">
          {analyzing ? <button className="secondary-button" onClick={onCancelAnalysis}><X size={16} />取消分析</button> : <button className="secondary-button" disabled={saving} onClick={onClose}><X size={16} />关闭</button>}
          <button className="secondary-button" disabled={analyzing || testing || saving || !pattern.trim()} onClick={onAnalyze}>{analyzing ? <RefreshCw className="spin" size={16} /> : <Search size={16} />}{editor.runtimePostprocess ? '大模型修正匹配式' : '大模型修正'}</button>
          <button className="secondary-button" disabled={analyzing || testing || saving || !pattern.trim()} onClick={onTest}>{testing ? <RefreshCw className="spin" size={16} /> : <Play size={16} />}测试匹配</button>
          <button className={`primary-button${forcePass ? ' danger-button' : ''}`} disabled={analyzing || testing || saving || !pattern.trim()} onClick={onSave}>{saving ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}{forcePass ? '强制通过并保存' : editor.runtimePostprocess ? '保存后处理' : '保存规则'}</button>
        </footer>
      </section>
    </div>
  );
}
