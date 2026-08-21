import { useMemo, useState } from 'react';
import type { Segment } from '../../../types';

export function useSegmentFilters(segments: Segment[]) {
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');

  const filteredSegments = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return segments.filter((segment) => {
      const matchesStatus = statusFilter === 'all' || segment.reviewStatus === statusFilter;
      const matchesKind = kindFilter === 'all' || segment.kind === kindFilter;
      const matchesQuery = !normalized || [segment.pathLabel, segment.sourceText, segment.finalText, segment.translatedText]
        .some((value) => String(value || '').toLowerCase().includes(normalized));
      return matchesStatus && matchesKind && matchesQuery;
    });
  }, [kindFilter, query, segments, statusFilter]);

  return {
    query,
    statusFilter,
    kindFilter,
    filteredSegments,
    setQuery,
    setStatusFilter,
    setKindFilter,
  };
}
