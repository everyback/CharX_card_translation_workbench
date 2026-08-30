import { Link2, Search } from 'lucide-react';
import { RiskBadge } from '../../components/ui';
import { CATEGORY_LABELS, KIND_LABELS, STATUS_LABELS } from '../../constants';
import type { Segment } from '../../types';
import type { SegmentSearchScope } from '../../app/hooks/segments/useSegmentFilters';

export function SegmentsView({
  segments,
  query,
  searchScope,
  statusFilter,
  kindFilter,
  onQuery,
  onSearchScope,
  onStatusFilter,
  onKindFilter,
  onToggle,
  onSelect,
}: {
  segments: Segment[];
  query: string;
  searchScope: SegmentSearchScope;
  statusFilter: string;
  kindFilter: string;
  onQuery: (value: string) => void;
  onSearchScope: (value: SegmentSearchScope) => void;
  onStatusFilter: (value: string) => void;
  onKindFilter: (value: string) => void;
  onToggle: (segment: Segment) => void;
  onSelect: (segment: Segment) => void;
}) {
  return (
    <section className="table-section">
      <div className="table-toolbar">
        <div className="search-input"><Search size={15} /><input value={query} onChange={(event) => onQuery(event.target.value)} placeholder={searchScope === 'translation' ? '搜索译文' : '搜索字段'} /></div>
        <select aria-label="搜索范围" value={searchScope} onChange={(event) => onSearchScope(event.target.value as SegmentSearchScope)}>
          <option value="all">全部内容</option>
          <option value="translation">仅译文</option>
          <option value="source">仅原文</option>
          <option value="path">仅路径</option>
        </select>
        <select value={statusFilter} onChange={(event) => onStatusFilter(event.target.value)}>
          <option value="all">全部状态</option>
          <option value="untranslated">未翻译</option>
          <option value="pending">待审核</option>
          <option value="approved">已通过</option>
          <option value="rejected">已退回</option>
        </select>
        <select aria-label="文字格式" value={kindFilter} onChange={(event) => onKindFilter(event.target.value)}>
          <option value="all">全部格式</option>
          {Object.entries(KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <span className="result-count">{segments.length} 条</span>
      </div>
      <div className="data-table">
        <div className="table-head">
          <span>选择</span><span>字段</span><span>原文</span><span>译文</span><span>风险</span><span>状态</span>
        </div>
        {segments.map((segment) => (
          <div className="table-row" key={segment.id} onDoubleClick={() => onSelect(segment)}>
            <span><input type="checkbox" checked={segment.included} onChange={() => onToggle(segment)} aria-label={`选择 ${segment.pathLabel}`} /></span>
            <span className="field-cell">
              <strong>{CATEGORY_LABELS[segment.category] || segment.category}</strong>
              <small>{KIND_LABELS[segment.kind] || segment.kind} · {segment.pathLabel}</small>
              {segment.controlReferences.length > 0 && (
                <span className="control-reference-badge" title={segment.controlReferences.map((reference) => `${reference.literal} → ${reference.pathLabel}`).join('\n')}>
                  <Link2 size={11} />引用 {segment.controlReferences.length}
                </span>
              )}
            </span>
            <span className="clamped-text">{segment.sourceText}</span>
            <span className={`clamped-text ${segment.finalText || segment.translatedText ? '' : 'muted-text'}`}>{segment.finalText || segment.translatedText || '尚未翻译'}</span>
            <span><RiskBadge risk={segment.riskLevel} /></span>
            <span><button className="status-link" onClick={() => onSelect(segment)}>{STATUS_LABELS[segment.reviewStatus]}</button></span>
          </div>
        ))}
        {!segments.length && <div className="table-empty">没有符合条件的字段</div>}
      </div>
    </section>
  );
}
