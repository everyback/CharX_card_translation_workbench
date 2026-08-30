import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleAlert,
  Code2,
  ExternalLink,
  FileCheck2,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  X,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { LuaManagementReport, LuaManagementStepStatus, PortraitRouterRepairPreview } from '../../types';

const STATUS_LABELS: Record<LuaManagementStepStatus, string> = {
  complete: '已完成',
  'needs-review': '待处理',
  blocked: '已阻断',
  'not-applicable': '不适用',
};

const ISSUE_LABELS = {
  syntax: 'Lua 语法',
  template: '模板结构',
  runtime: '运行时提醒',
  control: '控制引用',
  portrait: '立绘别名',
  router: '路由修复',
} as const;

export function LuaManagementView({
  report,
  loading,
  onRefresh,
  onScan,
  onPreviewRouterRepair,
  onApplyRouterRepair,
  onPreviewError,
  onOpenReview,
  onOpenExport,
}: {
  report: LuaManagementReport | null;
  loading: boolean;
  onRefresh: () => void;
  onScan: () => void;
  onPreviewRouterRepair: () => Promise<PortraitRouterRepairPreview>;
  onApplyRouterRepair: () => Promise<void> | void;
  onPreviewError: (error: unknown) => void;
  onOpenReview: (pathLabel?: string) => void;
  onOpenExport: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(null);
  const [routerPreview, setRouterPreview] = useState<PortraitRouterRepairPreview | null>(null);
  const [routerPreviewLoading, setRouterPreviewLoading] = useState(false);
  const [routerApplying, setRouterApplying] = useState(false);

  const filteredCandidates = useMemo(() => {
    if (!report) return [];
    const normalized = query.trim().toLocaleLowerCase();
    return report.portraitCandidates.filter((candidate) => (
      !normalized || [candidate.ownerId, ...candidate.names, ...candidate.missingAliases]
        .some((value) => value.toLocaleLowerCase().includes(normalized))
    ));
  }, [query, report]);

  async function openRouterPreview() {
    setRouterPreviewLoading(true);
    try {
      setRouterPreview(await onPreviewRouterRepair());
    } catch (error) {
      onPreviewError(error);
    } finally {
      setRouterPreviewLoading(false);
    }
  }

  async function applyRouterPreview() {
    setRouterApplying(true);
    try {
      await onApplyRouterRepair();
      setRouterPreview(null);
    } finally {
      setRouterApplying(false);
    }
  }

  if (!report && loading) {
    return <section className="lua-management-section"><div className="table-empty">正在读取立绘匹配诊断…</div></section>;
  }
  if (!report) {
    return <section className="lua-management-section"><div className="table-empty">暂时无法读取立绘匹配诊断，请重试。</div></section>;
  }

  return (
    <section className="lua-management-section">
      <header className="lua-management-header">
        <div>
          <span className="section-kicker">RisuAI / Lua</span>
          <h1>立绘匹配管理</h1>
          <p>这里只管理会影响立绘插入的专有名词别名。普通对白、说明和战斗结果不会进入这张清单。</p>
        </div>
        <div className="lua-management-actions">
          <button className="secondary-button" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={loading ? 'spin' : ''} size={16} />刷新诊断
          </button>
          <button className="secondary-button" onClick={onScan}><Search size={16} />重新扫描 Lua</button>
          <button className="primary-button" onClick={() => onOpenReview()}><FileCheck2 size={16} />进入审核</button>
        </div>
      </header>

      <div className={`lua-feature-check ${report.portraitFeatureDetected ? 'detected' : 'not-detected'}`}>
        <div className="lua-onboarding-title"><SlidersHorizontal size={17} /><strong>{report.portraitFeatureDetected ? '已检测到立绘匹配功能' : '未检测到立绘匹配功能'}</strong></div>
        <p>{report.portraitFeatureDetected
          ? '只处理人名、地名、组织名和称号等运行时名称。翻译任务完成时会先调用名称模型补齐目标语言别名，再生成可匹配的短称并写入 Lua 名称目录；导出阶段仅作兜底。'
          : '当前模块没有同时出现图片输出和角色名称目录信号，因此不会自动翻译或匹配普通 Lua 文本。'}
        </p>
        {report.portraitFeatureSignals.length > 0 && <div className="lua-feature-signals">{report.portraitFeatureSignals.map((signal) => <span key={signal}>{signal}</span>)}</div>}
        <div className="lua-onboarding-actions">
          <button className="link-button" onClick={onScan}>重新检测 <ArrowRight size={13} /></button>
          {report.portraitFeatureDetected && <button className="link-button" onClick={() => onOpenReview()}>查看译文审核 <ArrowRight size={13} /></button>}
        </div>
      </div>

      {report.routerRepair.detected && (
        <div className="lua-router-repair">
          <div>
            <div className="lua-onboarding-title"><Wrench size={17} /><strong>路由修复已就绪</strong></div>
            <p>只会处理已精确识别的阻断模式，不会改动资源索引、按钮、世界书或普通 Lua。</p>
            <ul>
              {report.routerRepair.findings.map((finding) => <li key={`${finding.id}:${finding.pathLabel}`}><strong>{finding.title}</strong><span>{finding.message}</span></li>)}
            </ul>
          </div>
          <button className="primary-button" onClick={() => void openRouterPreview()} disabled={!report.routerRepair.canApply || loading || routerPreviewLoading}>
            {routerPreviewLoading ? <RefreshCw className="spin" size={16} /> : <Wrench size={16} />}查看修改对比
          </button>
        </div>
      )}
      {!report.routerRepair.detected && report.hasModule && (
        <div className="lua-router-status">
          <div className="lua-onboarding-title"><ShieldCheck size={17} /><strong>路由修复检查完成</strong></div>
          <p>已检查模块中的 Lua 输出处理器、完成标记门控和 Main 路由提交逻辑，当前没有匹配到已知阻断模式。</p>
        </div>
      )}

      {routerPreview && (
        <div className="modal-backdrop router-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !routerApplying) setRouterPreview(null); }}>
          <section className="router-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="router-preview-title">
            <header className="dialog-header">
              <div><h2 id="router-preview-title">路由修复修改对比</h2><span>请人工检查疑似代码和建议修改，确认后才会写入卡片。</span></div>
              <button className="icon-button" title="关闭" aria-label="关闭修改对比" disabled={routerApplying} onClick={() => setRouterPreview(null)}><X size={16} /></button>
            </header>
            <div className="router-preview-body">
              {routerPreview.changes.map((change, index) => (
                <article className="router-change" key={`${change.id}:${change.pathLabel}:${index}`}>
                  <div className="router-change-heading"><strong>{change.title}</strong><code>{change.pathLabel}</code></div>
                  <p>修改方案：仅替换这一段已识别的路由代码，保留其他脚本结构。</p>
                  <div className="router-diff-columns">
                    <label><span>疑似原代码</span><pre>{change.before}</pre></label>
                    <label><span>建议修改</span><pre>{change.after}</pre></label>
                  </div>
                </article>
              ))}
              {!routerPreview.changes.length && <div className="table-empty">预览时未发现仍可修改的路由代码，可能已被其他操作处理。</div>}
            </div>
            <footer className="dialog-actions router-preview-actions">
              <button className="secondary-button" disabled={routerApplying} onClick={() => setRouterPreview(null)}><X size={16} />取消</button>
              <button className="primary-button" disabled={routerApplying || !routerPreview.changes.length} onClick={() => void applyRouterPreview()}>{routerApplying ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}人工检查通过，应用修改</button>
            </footer>
          </section>
        </div>
      )}

      <div className="lua-kpi-grid">
        <div><span>匹配候选</span><strong>{report.portraitCandidateCount}</strong><small>人名 / 地名 / 称号</small></div>
        <div><span>已有别名</span><strong>{report.portraitCoveredCount}</strong><small>可直接参与匹配</small></div>
        <div className={report.portraitMissingCount ? 'warning' : ''}><span>待补别名</span><strong>{report.portraitMissingCount}</strong><small>导出时自动尝试补齐</small></div>
        <div className={report.blockerCount ? 'danger' : ''}><span>导出阻断</span><strong>{report.blockerCount}</strong><small>{report.warningCount} 条提醒</small></div>
      </div>

      <div className="lua-stepper" aria-label="立绘匹配处理流程">
        {report.steps.map((step, index) => (
          <div className={`lua-step lua-step-${step.status}`} key={step.id}>
            <div className="lua-step-mark">{step.status === 'complete' ? <Check size={14} /> : index + 1}</div>
            <div><strong>{step.title}</strong><span>{STATUS_LABELS[step.status]}</span><p>{step.message}</p></div>
            {index < report.steps.length - 1 && <div className="lua-step-line" aria-hidden="true" />}
          </div>
        ))}
      </div>

      <div className="lua-management-grid">
        <div className="lua-panel lua-segment-panel">
          <div className="lua-panel-header">
            <div><h2>专有名词匹配候选</h2><span>点击候选只展开详情，不会离开本页</span></div>
            <button className="link-button" onClick={() => onOpenReview()}><ExternalLink size={13} />打开完整审核</button>
          </div>
          <div className="lua-filter-bar">
            <div className="search-input"><Search size={14} /><input aria-label="搜索专有名词候选" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="人名、地名或 ownerId" /></div>
            <span className="result-count">{filteredCandidates.length} 个</span>
          </div>
          <div className="lua-segment-table">
            <div className="lua-segment-head lua-candidate-head"><span>ownerId</span><span>名称 / 别名</span><span>状态</span><span /></div>
            {filteredCandidates.map((candidate) => {
              const selected = selectedOwnerId === candidate.ownerId;
              return (
                <div className={`lua-candidate-wrap ${selected ? 'selected' : ''}`} key={candidate.ownerId}>
                  <button className="lua-segment-row lua-candidate-row" onClick={() => setSelectedOwnerId(selected ? null : candidate.ownerId)} aria-expanded={selected}>
                    <span title={candidate.ownerId}>{candidate.ownerId}</span>
                    <span title={candidate.names.join('、')}>{candidate.names.join('、') || '待从卡片译文生成'}</span>
                    <span className={`lua-review-status ${candidate.status === 'covered' ? 'approved' : ''}`}>{candidate.status === 'covered' ? '已覆盖' : '待补别名'}</span>
                    <ArrowRight size={14} />
                  </button>
                  {selected && (
                    <div className="lua-segment-detail">
                      <div><strong>当前名称</strong><span>{candidate.names.join('、') || '暂无目标语言名称'}</span></div>
                      <div><strong>缺少的匹配别名</strong><span>{candidate.missingAliases.join('、') || '无'}</span></div>
                      {candidate.pathLabels.length > 0 && <div><strong>运行时位置</strong><code>{candidate.pathLabels.join('、')}</code></div>}
                      <div className="lua-segment-detail-actions">
                        <span>{candidate.status === 'covered' ? '名称目录已覆盖，可参与立绘匹配。' : '翻译完成时会自动生成并写回目标语言别名和短称；导出仅作兜底。'}</span>
                        <button className="secondary-button" onClick={() => onOpenReview(candidate.pathLabels[0])}><FileCheck2 size={14} />去审核相关译文</button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {!filteredCandidates.length && <div className="table-empty">{report.portraitFeatureDetected ? '未发现可安全判定的专有名词候选' : '未检测到立绘匹配功能，不处理普通 Lua 文本'}</div>}
          </div>
        </div>

        <aside className="lua-side-column">
          <div className="lua-panel">
            <div className="lua-panel-header"><div><h2>匹配控制引用</h2><span>这些内容改动会影响路由</span></div><ShieldCheck size={17} /></div>
            <div className="lua-reference-list">
              {report.controlReferences.slice(0, 30).map((reference) => (
                <div className="lua-reference" key={`${reference.pathLabel}:${reference.literal}`}><code>{reference.literal}</code><span>{reference.kind === 'regex' ? '正则' : 'Lua'} · {reference.pathLabel}</span></div>
              ))}
              {!report.controlReferences.length && <p className="lua-empty-copy">未发现登记的控制引用。</p>}
              {report.controlReferences.length > 30 && <p className="lua-empty-copy">还有 {report.controlReferences.length - 30} 条，请到“引用”页查看。</p>}
            </div>
          </div>

          <div className="lua-panel">
            <div className="lua-panel-header"><div><h2>问题与提醒</h2><span>阻断项必须在导出前处理</span></div><AlertTriangle size={17} /></div>
            <div className="lua-issue-list">
              {report.issues.map((issue, index) => (
                <div className={`lua-issue ${issue.blocking ? 'blocking' : ''}`} key={`${issue.kind}:${issue.pathLabel}:${index}`}><CircleAlert size={14} /><div><strong>{ISSUE_LABELS[issue.kind]} · {issue.pathLabel}</strong><span>{issue.message}</span></div></div>
              ))}
              {!report.issues.length && <p className="lua-empty-copy">当前没有发现问题，可以继续导出。</p>}
            </div>
            <button className="primary-button lua-export-button" onClick={onOpenExport} disabled={Boolean(report.blockerCount)}><FileCheck2 size={16} />{report.blockerCount ? '修复阻断后导出' : '去保存并导出'}</button>
          </div>
        </aside>
      </div>

      <div className="lua-footnote"><Code2 size={15} /><span>仅“应用安全修复”会修改精确识别的路由代码；普通 Lua 可见文字仍按原审核流程处理。</span></div>
    </section>
  );
}
