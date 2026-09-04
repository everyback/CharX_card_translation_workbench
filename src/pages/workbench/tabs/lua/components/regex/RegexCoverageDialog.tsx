import { Check, Play, RefreshCw, Search, X } from 'lucide-react';
import type { RegexCoveragePreview, RegexCoverageRule, RegexCoverageRuleStatus, RegexRuleTestResult } from '@/shared/types';
import { summarizeMatchSamples } from '../../lib/match-samples';

function statusLabel(status?: RegexCoverageRuleStatus): string {
  switch (status) {
    case 'queued': return '排队中';
    case 'processing': return '分析中';
    case 'returned': return '已返回';
    case 'validated': return '候选通过（未保存）';
    case 'no-change': return '无可安全修改';
    case 'rejected': return '校验未通过';
    case 'failed': return '请求失败';
    case 'cancelled': return '已取消';
    default: return '可编辑';
  }
}

function proposalSummary(proposals?: Array<Record<string, unknown>>): string {
  const proposal = proposals?.[0];
  if (!proposal) return '模型未提出可安全应用的修改。';
  const pattern = typeof proposal.pattern === 'string' ? proposal.pattern : '';
  if (pattern) return `候选规则：${pattern}`;
  const additions = Array.isArray(proposal.additions)
    ? proposal.additions.filter((value): value is string => typeof value === 'string')
    : [];
  return additions.length ? `新增并列项：${additions.join('、')}` : '模型未提出可安全应用的修改。';
}

export interface RegexCoverageDialogProps {
  preview: RegexCoveragePreview;
  currentPaths: string[];
  queuedPaths: string[];
  concurrencyLimit: number;
  running: boolean;
  drafts: Record<string, string>;
  tests: Record<string, RegexRuleTestResult>;
  testingPath: string | null;
  savingPath: string | null;
  onClose: () => void;
  onCancelAll: () => void;
  onDraftChange: (rule: RegexCoverageRule, value: string) => void;
  onQueueAnalysis: (rule: RegexCoverageRule) => void;
  onCancelAnalysis: (rule: RegexCoverageRule) => void;
  onTestRule: (rule: RegexCoverageRule) => void;
  onSaveRule: (rule: RegexCoverageRule) => void;
}

export function RegexCoverageDialog({
  preview,
  currentPaths,
  queuedPaths,
  concurrencyLimit,
  running,
  drafts,
  tests,
  testingPath,
  savingPath,
  onClose,
  onCancelAll,
  onDraftChange,
  onQueueAnalysis,
  onCancelAnalysis,
  onTestRule,
  onSaveRule,
}: RegexCoverageDialogProps) {
  return (
    <div className="modal-backdrop regex-coverage-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !running) onClose(); }}>
      <section className="regex-coverage-dialog" role="dialog" aria-modal="true" aria-labelledby="regex-coverage-title">
        <header className="dialog-header">
          <div><h2 id="regex-coverage-title">正则规则逐条分析</h2><span>{running ? `正在修正 ${currentPaths.length} 行，排队 ${queuedPaths.length} 行（共享模型通道 ${concurrencyLimit} 路）；其他行仍可编辑。` : '每行都可以先人工编辑，再单独点击“大模型修正”；模型处理期间只锁定当前行。'}</span></div>
          <button className="icon-button" title="关闭" aria-label="关闭正则规则逐条分析" disabled={running} onClick={onClose}><X size={16} /></button>
        </header>
        <div className="regex-coverage-body">
          <div className="regex-coverage-summary">
            <strong>发现 {preview.checked} 条需要处理的规则</strong>
            {(currentPaths.length > 0 || queuedPaths.length > 0) && <span>分析中：{currentPaths.join('、') || '无'}{queuedPaths.length ? ` · 排队中：${queuedPaths.join('、')}` : ''}</span>}
          </div>
          <div className="regex-coverage-progress" aria-label="正则修复进度"><span style={{ width: `${preview.rules.length ? (preview.rules.filter((rule) => rule.status && !['pending', 'queued', 'processing'].includes(rule.status)).length / preview.rules.length) * 100 : 100}%` }} /></div>
          <div className="regex-coverage-list">
            {preview.rules.map((rule, index) => {
              const pattern = drafts[rule.pathLabel] ?? rule.candidatePattern ?? rule.pattern;
              const disabled = rule.status === 'queued' || rule.status === 'processing' || testingPath === rule.pathLabel || savingPath === rule.pathLabel || !pattern.trim();
              const test = tests[rule.pathLabel];
              return (
                <article className={`regex-coverage-rule status-${rule.status ?? 'pending'}`} key={rule.pathLabel}>
                  <div className="regex-coverage-rule-head"><div><strong>{index + 1}. {rule.pathLabel}</strong><span className={`regex-coverage-rule-status status-${rule.status ?? 'pending'}`}>{statusLabel(rule.status)}</span></div><span>{rule.runtimePostprocess ? 'Lua 聊天后处理规则' : rule.dynamicDisplay ? '运行时回复规则' : `命中 ${rule.sourceMatchCount} → ${rule.draftMatchCount}`}</span></div>
                  <div className="regex-coverage-rule-compare"><div><span>原始规则</span><code>{rule.originalPattern || rule.pattern}</code></div><div><span>{rule.candidatePattern ? '模型候选（可人工修改）' : '当前规则（可人工修改）'}</span><textarea value={drafts[rule.pathLabel] ?? rule.pattern} disabled={rule.status === 'queued' || rule.status === 'processing'} onChange={(event) => onDraftChange(rule, event.target.value)} rows={3} spellCheck={false} aria-label={`编辑 ${rule.pathLabel} 候选正则`} /></div></div>
                  {rule.dynamicDisplay || rule.runtimePostprocess ? <div className="regex-coverage-context">{rule.runtimePostprocess ? '此规则会在生成回复后执行（editoutput），不读取或发送卡片素材命中片段。此处可修正匹配式；完整的 in / out 人工编辑在上方“聊天后处理”检测项中完成，保存会校验正则编译、规则类型和替换输出。' : '此规则用于运行时模型回复展示，不读取或发送卡片素材命中片段。大模型仅依据当前正则、替换模板和目标语言处理中文无空格、引号与标点边界。'}</div> : <div className="regex-coverage-rule-samples"><div><span>原文命中片段</span><p>{summarizeMatchSamples(rule.sourceSamples?.length ? rule.sourceSamples : rule.sourceMatches)}</p></div><div><span>当前稿命中片段</span><p>{summarizeMatchSamples(rule.draftSamples?.length ? rule.draftSamples : rule.draftMatches)}</p></div></div>}
                  {rule.modelContext && !rule.dynamicDisplay && !rule.runtimePostprocess && <div className="regex-coverage-context">发送上下文：扫描记录 {rule.modelContext.totalRecords}（去重 {rule.modelContext.totalUniqueRecords}）→ 采样 {rule.modelContext.selectedRecords} 条；分组命中差异 {rule.modelContext.strata.coverageDifference}、文本变化 {rule.modelContext.strata.textDifference}、稳定 {rule.modelContext.strata.stable}。命中样本 {rule.modelContext.selectedSourceMatches} / {rule.modelContext.selectedDraftMatches}，载荷 {rule.modelContext.contextChars} / {rule.modelContext.budgetChars} 字符{rule.modelContext.truncated ? '，已按预算裁剪' : ''}{rule.modelContext.formatProbe ? `；空白探针 ${rule.modelContext.formatProbe.sourceMatchCount} → ${rule.modelContext.formatProbe.draftMatchCount}（严格基线 ${rule.modelContext.formatProbe.baselineSourceMatchCount} → ${rule.modelContext.formatProbe.baselineDraftMatchCount}），采样 ${rule.modelContext.formatProbe.selectedRecords} / ${rule.modelContext.formatProbe.totalRecords} 条` : ''}。</div>}
                  {rule.status && !['pending', 'queued', 'processing'].includes(rule.status) && <div className="regex-coverage-model-result">模型返回：{proposalSummary(rule.proposals)}</div>}
                  {rule.validation && <div className={`regex-coverage-validation ${rule.validation.passed ? 'passed' : 'failed'}`}>{rule.validation.message || (rule.validation.passed ? `校验通过：候选命中 ${rule.validation.draftMatchCount}，满足原文 ${rule.validation.sourceMatchCount}` : '本地校验未通过，未写入。')}</div>}
                  {rule.error && <div className="regex-coverage-validation failed">{rule.error}</div>}
                  <div className="regex-coverage-rule-actions"><button type="button" className="secondary-button" disabled={disabled} onClick={() => onQueueAnalysis(rule)}>{rule.status === 'queued' ? <RefreshCw className="spin" size={14} /> : <Search size={14} />}大模型修正</button>{(rule.status === 'queued' || rule.status === 'processing') && <button type="button" className="secondary-button" onClick={() => onCancelAnalysis(rule)}><X size={14} />取消本行</button>}<button type="button" className="secondary-button" disabled={disabled} onClick={() => onTestRule(rule)}>{testingPath === rule.pathLabel ? <RefreshCw className="spin" size={14} /> : <Play size={14} />}测试匹配</button><button type="button" className="primary-button" disabled={disabled} onClick={() => onSaveRule(rule)}>{savingPath === rule.pathLabel ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}保存这条规则</button></div>
                  {test && <div className={`regex-coverage-validation ${test.compiled ? 'passed' : 'failed'}`}>当前输入测试：命中 {test.sourceMatchCount} → {test.draftMatchCount}；{test.message || '规则可编译。'}</div>}
                </article>
              );
            })}
            {!preview.rules.length && <div className="table-empty">当前没有静态命中变化或聊天后处理规则，无需全量修复。</div>}
          </div>
        </div>
        <footer className="dialog-actions regex-coverage-actions">
          {running ? <button className="secondary-button" onClick={onCancelAll}><X size={16} />取消全部分析</button> : <button className="secondary-button" onClick={onClose}><X size={16} />关闭</button>}
        </footer>
      </section>
    </div>
  );
}
