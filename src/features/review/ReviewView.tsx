import { Check, CheckCheck, CircleAlert, Copy, FilterX, Link2, RefreshCw, Save, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { RiskBadge } from '../../components/ui';
import { CATEGORY_LABELS, KIND_LABELS, STATUS_LABELS } from '../../constants';
import type { ReviewFocus, Segment } from '../../types';

export function ReviewView({
  segments,
  selected,
  onSelect,
  onUpdate,
  onApproveSafe,
  onApproveAll,
  onRetranslate,
  onReviewBulk,
  onClearAllResults,
  reviewFocus,
  onClearReviewFocus,
  approving,
  resetting,
}: {
  segments: Segment[];
  selected: Segment | null;
  onSelect: (id: string) => void;
  onUpdate: (changes: Partial<Pick<Segment, 'finalText' | 'reviewStatus'>>) => Promise<void> | undefined;
  onApproveSafe: () => void;
  onApproveAll: () => void;
  onRetranslate: (segmentIds: string[]) => void;
  onReviewBulk: (action: 'copy-machine' | 'clear-manual', segmentIds: string[]) => void;
  onClearAllResults: () => void;
  reviewFocus: ReviewFocus | null;
  onClearReviewFocus: () => void;
  approving: boolean;
  resetting: boolean;
}) {
  const [reviewStatusFilter, setReviewStatusFilter] = useState<'all' | 'unapproved' | 'failed' | 'approved'>('all');
  const [reviewProblemFilter, setReviewProblemFilter] = useState<'all' | 'issues' | 'clear'>('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [reviewKindFilter, setReviewKindFilter] = useState('all');
  const [qaFlagFilter, setQaFlagFilter] = useState('all');
  const [reviewQuery, setReviewQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const reviewFocusIds = useMemo(() => new Set(reviewFocus?.segmentIds ?? []), [reviewFocus]);
  const reviewable = useMemo(() => segments.filter((segment) => (
    segment.reviewStatus !== 'untranslated'
    || Boolean(segment.translationError)
    || Boolean(segment.finalText?.trim() || segment.translatedText?.trim())
  )), [segments]);
  const qaFlagOptions = useMemo(() => {
    const counts = new Map<string, number>();
    for (const segment of reviewable) {
      for (const flag of segment.qaFlags) counts.set(flag, (counts.get(flag) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([flag, count]) => ({ flag, count }))
      .sort((left, right) => left.flag.localeCompare(right.flag, 'zh-CN'));
  }, [reviewable]);
  const filteredReviewable = useMemo(() => {
    const normalizedQuery = reviewQuery.trim().toLowerCase();
    return reviewable.filter((segment) => {
      const matchesFocus = !reviewFocus || reviewFocusIds.has(segment.id);
      const matchesStatus = reviewStatusFilter === 'all'
        || (reviewStatusFilter === 'unapproved' && segment.reviewStatus !== 'approved')
        || (reviewStatusFilter === 'failed' && Boolean(segment.translationError) && segment.reviewStatus !== 'approved')
        || (reviewStatusFilter === 'approved' && segment.reviewStatus === 'approved');
      const hasProblem = Boolean(segment.translationError) || segment.qaFlags.length > 0;
      const matchesProblem = reviewProblemFilter === 'all'
        || (reviewProblemFilter === 'issues' && hasProblem)
        || (reviewProblemFilter === 'clear' && !hasProblem);
      const matchesCategory = categoryFilter === 'all' || segment.category === categoryFilter;
      const matchesKind = reviewKindFilter === 'all' || segment.kind === reviewKindFilter;
      const matchesQaFlag = qaFlagFilter === 'all'
        || (qaFlagFilter === 'flagged' && segment.qaFlags.length > 0)
        || (qaFlagFilter === 'protected' && segment.controlReferences.length > 0)
        || segment.qaFlags.includes(qaFlagFilter);
      const matchesQuery = !normalizedQuery || [
        segment.pathLabel,
        segment.sourceText,
        segment.translatedText,
        segment.finalText,
        segment.translationError,
        ...segment.qaFlags,
        ...segment.controlReferences.flatMap((reference) => [reference.literal, reference.pathLabel, reference.pattern]),
      ].some((value) => String(value ?? '').toLowerCase().includes(normalizedQuery));
      return matchesFocus && matchesStatus && matchesProblem && matchesCategory && matchesKind && matchesQaFlag && matchesQuery;
    });
  }, [reviewable, reviewFocus, reviewFocusIds, reviewStatusFilter, reviewProblemFilter, categoryFilter, reviewKindFilter, qaFlagFilter, reviewQuery]);
  useEffect(() => {
    if (qaFlagFilter !== 'all' && qaFlagFilter !== 'flagged' && qaFlagFilter !== 'protected'
      && !qaFlagOptions.some(({ flag }) => flag === qaFlagFilter)) {
      setQaFlagFilter('all');
    }
  }, [qaFlagFilter, qaFlagOptions]);
  const pendingWithText = segments.filter((segment) => (
    segment.reviewStatus === 'pending'
    && Boolean(segment.finalText?.trim() || segment.translatedText?.trim())
  ));
  const safePending = pendingWithText.filter((segment) => segment.riskLevel === 'low' && segment.qaFlags.length === 0);
  const [draft, setDraft] = useState('');
  const selectedRowRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setDraft(selected?.finalText ?? selected?.translatedText ?? ''), [selected?.id, selected?.finalText, selected?.translatedText]);
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selected?.id]);
  useEffect(() => {
    if (!filteredReviewable.some((segment) => segment.id === selected?.id)) {
      onSelect(filteredReviewable[0]?.id ?? '');
    }
  }, [filteredReviewable, selected?.id, onSelect]);
  useEffect(() => {
    const visible = new Set(filteredReviewable.map((segment) => segment.id));
    setSelectedIds((current) => new Set([...current].filter((id) => visible.has(id))));
  }, [filteredReviewable]);
  const selectedVisibleIds = filteredReviewable.filter((segment) => selectedIds.has(segment.id)).map((segment) => segment.id);
  const allVisibleSelected = filteredReviewable.length > 0 && selectedVisibleIds.length === filteredReviewable.length;
  return (
    <section className="review-layout">
      <aside className="review-queue">
        <div className="review-queue-controls">
          {reviewFocus && (
            <div className="review-focus-banner">
              <FilterX size={15} />
              <div className="review-focus-copy">
                <strong>命中问题</strong>
                <span>{reviewFocus.problem}</span>
                {reviewFocus.pattern && (
                  <details className="review-focus-rule">
                    <summary>查看实际正则规则</summary>
                    <code>{reviewFocus.pattern}</code>
                  </details>
                )}
                <strong>修正方案</strong>
                <span>{reviewFocus.fixSuggestion}</span>
                <small>已过滤 {reviewFocus.segmentIds.length} 条待人工检查文本；处理完成后点击“保存修改”或再次保存导出。</small>
              </div>
              <button type="button" title="显示全部审核项" onClick={onClearReviewFocus}>显示全部</button>
            </div>
          )}
          <div className="review-queue-header">
            <div className="review-queue-heading">
              <strong>审核队列</strong>
              <span>{filteredReviewable.length} / {reviewable.length}</span>
            </div>
            <div className="review-bulk-actions">
              <button className="review-bulk-button" disabled={resetting || selectedVisibleIds.length === 0} onClick={() => onReviewBulk('copy-machine', selectedVisibleIds)} title="将选中项的机器译文载入人工定稿框">
                <Copy size={14} /><span>载入机翻</span><small>{selectedVisibleIds.length}</small>
              </button>
              <button className="review-bulk-button" disabled={resetting || selectedVisibleIds.length === 0} onClick={() => onReviewBulk('clear-manual', selectedVisibleIds)} title="清除选中项人工定稿，保留机器译文">
                <X size={14} /><span>清除人工稿</span><small>{selectedVisibleIds.length}</small>
              </button>
              <button className="review-bulk-button" title={`通过 ${safePending.length} 条无警告的低疑点项`} disabled={approving || safePending.length === 0} onClick={onApproveSafe}>
                <ShieldCheck size={14} /><span>通过低疑点</span><small>{safePending.length}</small>
              </button>
              <button className="review-bulk-button review-bulk-all" title={`确认无误后通过全部 ${pendingWithText.length} 条已有译文的待审核项`} disabled={approving || pendingWithText.length === 0} onClick={onApproveAll}>
                <CheckCheck size={14} /><span>确认无误后通过</span><small>{pendingWithText.length}</small>
              </button>
            </div>
          </div>
          <div className="review-filter-bar">
            <label className="review-search-filter">
              <span>文字搜索</span>
              <div className="search-input">
                <Search size={14} />
                <input aria-label="审核文字搜索" value={reviewQuery} onChange={(event) => setReviewQuery(event.target.value)} placeholder="原文、译文或路径" />
              </div>
            </label>
            <label>
              <span>审核状态</span>
              <select aria-label="审核状态" value={reviewStatusFilter} onChange={(event) => setReviewStatusFilter(event.target.value as 'all' | 'unapproved' | 'failed' | 'approved')}>
                <option value="all">全部</option>
                <option value="unapproved">未通过</option>
                <option value="failed">翻译失败</option>
                <option value="approved">已通过</option>
              </select>
            </label>
            <label>
              <span>问题状态</span>
              <select aria-label="问题状态" value={reviewProblemFilter} onChange={(event) => setReviewProblemFilter(event.target.value as 'all' | 'issues' | 'clear')}>
                <option value="all">全部</option>
                <option value="issues">有问题（{reviewable.filter((segment) => Boolean(segment.translationError) || segment.qaFlags.length > 0).length}）</option>
                <option value="clear">无问题</option>
              </select>
            </label>
            <label>
              <span>内容分类</span>
              <select aria-label="内容分类" value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
                <option value="all">全部分类</option>
                {Object.entries(CATEGORY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>文字格式</span>
              <select aria-label="文字格式" value={reviewKindFilter} onChange={(event) => setReviewKindFilter(event.target.value)}>
                <option value="all">全部格式</option>
                {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>质量提示</span>
              <select aria-label="质量提示" value={qaFlagFilter} onChange={(event) => setQaFlagFilter(event.target.value)}>
                <option value="all">不限提示</option>
                <option value="flagged">有质量提示（{reviewable.filter((segment) => segment.qaFlags.length > 0).length}）</option>
                <option value="protected">受保护脚本引用（{reviewable.filter((segment) => segment.controlReferences.length > 0).length}）</option>
                {qaFlagOptions.map(({ flag, count }) => <option key={flag} value={flag}>{flag}（{count}）</option>)}
              </select>
            </label>
            <label className="review-select-all">
              <span><input type="checkbox" checked={allVisibleSelected} onChange={(event) => setSelectedIds(event.target.checked ? new Set(filteredReviewable.map((segment) => segment.id)) : new Set())} />选择当前结果</span>
              <small>{selectedVisibleIds.length} / {filteredReviewable.length}</small>
            </label>
            <div className="review-result-actions">
              <button
                type="button"
                disabled={resetting || filteredReviewable.length === 0}
                title={`删除当前筛选的 ${filteredReviewable.length} 条结果并重新翻译`}
                onClick={() => onRetranslate(filteredReviewable.map((segment) => segment.id))}
              >
                <RefreshCw size={14} /><span>重译筛选</span><small>{filteredReviewable.length}</small>
              </button>
              <button
                type="button"
                className="danger-action"
                disabled={resetting || reviewable.length === 0}
                title={`删除当前项目全部 ${reviewable.length} 条翻译结果`}
                onClick={onClearAllResults}
              >
                <Trash2 size={14} /><span>全部删除</span><small>{reviewable.length}</small>
              </button>
            </div>
          </div>
        </div>
        {filteredReviewable.map((segment) => (
          <button
            key={segment.id}
            ref={selected?.id === segment.id ? selectedRowRef : undefined}
            className={selected?.id === segment.id ? 'active' : ''}
            onClick={() => onSelect(segment.id)}
          >
            <input
              type="checkbox"
              checked={selectedIds.has(segment.id)}
              onChange={(event) => {
                event.stopPropagation();
                setSelectedIds((current) => {
                  const next = new Set(current);
                  if (event.target.checked) next.add(segment.id); else next.delete(segment.id);
                  return next;
                });
              }}
              onClick={(event) => event.stopPropagation()}
              aria-label={`选择第 ${segment.sortOrder + 1} 条审核项`}
            />
            <span className={`review-dot ${segment.translationError && segment.reviewStatus !== 'approved' ? 'review-failed' : `review-${segment.reviewStatus}`}`} />
            <span className="review-row-copy">
              <strong title={segment.sourceText}>#{segment.sortOrder + 1} {segmentSummary(segment.sourceText)}</strong>
              <small>{CATEGORY_LABELS[segment.category] || segment.category} · {KIND_LABELS[segment.kind] || segment.kind} · {segment.pathLabel}</small>
            </span>
            {segment.controlReferences.length > 0
              ? <Link2 size={15} />
              : (segment.translationError || segment.qaFlags.length > 0) && <CircleAlert size={15} />}
          </button>
        ))}
        {!filteredReviewable.length && <div className="table-empty">当前筛选无内容</div>}
      </aside>
      <div className="review-editor">
        {selected ? <>
          <div className="review-editor-header">
            <div><span>{CATEGORY_LABELS[selected.category] || selected.category} · {KIND_LABELS[selected.kind] || selected.kind}</span><strong>{selected.pathLabel}</strong></div>
            <div><RiskBadge risk={selected.riskLevel} /><span className="review-status">{selected.translationError && selected.reviewStatus !== 'approved' ? '翻译失败' : STATUS_LABELS[selected.reviewStatus]}</span></div>
          </div>
          {reviewFocus && reviewFocusIds.has(selected.id) && (
            <div className="review-focus-detail-banner">
              <div className="review-focus-detail-heading"><CircleAlert size={16} /><strong>本条文本命中脚本完整性问题</strong></div>
              <div><b>命中问题：</b>{reviewFocus.problem}</div>
              <div><b>修正方案：</b>{reviewFocus.fixSuggestion}</div>
              <small>校验路径：{reviewFocus.pathLabel} · 匹配数 {reviewFocus.originalMatches} → {reviewFocus.draftMatches}</small>
              {reviewFocus.pattern && (
                <details className="review-focus-detail-rule">
                  <summary>查看本次校验使用的正则</summary>
                  <code>{reviewFocus.pattern}</code>
                </details>
              )}
            </div>
          )}
          {selected.translationError && selected.reviewStatus !== 'approved' && (
            <div className="translation-error-banner">
              <CircleAlert size={16} />
              <div>
                <strong>模型翻译失败，可人工接管</strong>
                <span>{selected.translationError}</span>
                <small>请先载入原文，只修改其中的可见文字；通过后会作为最终译文写入审核稿。</small>
              </div>
            </div>
          )}
          {selected.controlReferences.length > 0 && (
            <div className="control-reference-banner">
              <Link2 size={16} />
              <div>
                <strong>受保护脚本引用</strong>
                {selected.controlReferences.map((reference) => (
                  <span key={`${reference.kind}:${reference.pathLabel}:${reference.literal}`}>
                    <code>{reference.literal}</code><b>→</b>{reference.pathLabel}
                  </span>
                ))}
              </div>
            </div>
          )}
          {selected.qaFlags.length > 0 && <div className="qa-banner"><CircleAlert size={16} />{selected.qaFlags.join('、')}</div>}
          <div className="review-columns">
            <label><span>原文</span><textarea readOnly value={selected.sourceText} /></label>
            <label><span>机器译文</span><textarea readOnly value={selected.translatedText ?? ''} /></label>
            <label><span>人工定稿</span><textarea value={draft} onChange={(event) => setDraft(event.target.value)} /></label>
          </div>
          <div className="review-actions">
            {selected.translationError && selected.reviewStatus !== 'approved' && <button className="secondary-button" onClick={() => setDraft(selected.sourceText)}><Copy size={16} />载入原文</button>}
            <button className="secondary-button danger-ghost" disabled={resetting} onClick={() => onRetranslate([selected.id])}><RefreshCw size={16} />删除并重译</button>
            <button className="secondary-button" onClick={() => void onUpdate({ finalText: draft, reviewStatus: 'rejected' })}><X size={16} />退回</button>
            <button className="secondary-button" onClick={() => void onUpdate({ finalText: draft, reviewStatus: selected.reviewStatus })}><Save size={16} />保存修改</button>
            <button className="primary-button" disabled={!draft.trim()} onClick={() => void onUpdate({ finalText: draft, reviewStatus: 'approved' })}><Check size={16} />通过</button>
          </div>
        </> : <div className="table-empty">从左侧选择一个段落</div>}
      </div>
    </section>
  );
}
function segmentSummary(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return '空文本';
  return compact.length > 42 ? `${compact.slice(0, 42)}...` : compact;
}
