import { memo, useLayoutEffect, useRef, useState } from 'react';
import { CircleAlert, Link2 } from 'lucide-react';
import { CATEGORY_LABELS, KIND_LABELS } from '@/entities/segment/model/labels';
import type { Segment } from '@/shared/types';
import { segmentSummary } from './lib/review-utils';

const ROW_HEIGHT = 62;
const OVERSCAN = 6;

export const ReviewQueueList = memo(function ReviewQueueList({ segments, selectedId, selectedIds, onSelect, onSelectedIdsChange }: {
  segments: Segment[];
  selectedId?: string;
  selectedIds: Set<string>;
  onSelect: (id: string) => void;
  onSelectedIdsChange: (ids: Set<string>) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ top: 0, height: 620 });
  useLayoutEffect(() => {
    const node = viewport.current!;
    const measure = () => setMetrics({ top: node.scrollTop, height: node.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const node = viewport.current!;
    const index = segments.findIndex(segment => segment.id === selectedId);
    if (index < 0 || !node.clientHeight) return;
    const top = index * ROW_HEIGHT;
    if (top < node.scrollTop) node.scrollTop = top;
    else if (top + ROW_HEIGHT > node.scrollTop + node.clientHeight) node.scrollTop = top + ROW_HEIGHT - node.clientHeight;
    setMetrics({ top: node.scrollTop, height: node.clientHeight });
  }, [selectedId, segments]);
  const start = Math.max(0, Math.min(segments.length - 1, Math.floor(metrics.top / ROW_HEIGHT)) - OVERSCAN);
  const end = Math.min(segments.length, start + Math.ceil(metrics.height / ROW_HEIGHT) + OVERSCAN * 2);
  const visible = segments.slice(start, end);
  return <div className="review-queue-viewport" ref={viewport} aria-label="审核条目列表"
    onScroll={event => setMetrics({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}
    onKeyDown={event => {
      if (event.target instanceof HTMLInputElement || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = segments.findIndex(segment => segment.id === selectedId);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? segments.length - 1 : Math.max(0, Math.min(segments.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)));
      if (segments[index]) { event.currentTarget.focus(); onSelect(segments[index].id); }
    }} tabIndex={0}>
    <div style={{ height: segments.length * ROW_HEIGHT, position: 'relative' }}>
        {visible.map((segment, index) => (
          <button
            key={segment.id}
            type="button"
            style={{ position: 'absolute', top: (start + index) * ROW_HEIGHT, height: ROW_HEIGHT }}
            className={selectedId === segment.id ? 'review-virtual-row active' : 'review-virtual-row'}
            onClick={() => onSelect(segment.id)}
          >
            <input
              type="checkbox"
              checked={selectedIds.has(segment.id)}
              onChange={(event) => {
                event.stopPropagation();
                const next = new Set(selectedIds);
                if (event.target.checked) next.add(segment.id); else next.delete(segment.id);
                onSelectedIdsChange(next);
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
    </div>
  </div>;
});
