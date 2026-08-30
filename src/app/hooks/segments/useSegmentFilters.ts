import { useMemo, useState } from 'react';
import type { Segment } from '../../../types';

export type SegmentSearchScope = 'all' | 'translation' | 'source' | 'path';

function includesQuery(value: string | null | undefined, query: string) {
  return String(value || '').toLowerCase().includes(query);
}

export function matchesSegmentSearch(segment: Segment, query: string, scope: SegmentSearchScope) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return true;

  switch (scope) {
    case 'translation':
      return includesQuery(segment.finalText, normalizedQuery) || includesQuery(segment.translatedText, normalizedQuery);
    case 'source':
      return includesQuery(segment.sourceText, normalizedQuery);
    case 'path':
      return includesQuery(segment.pathLabel, normalizedQuery);
    default:
      return [segment.pathLabel, segment.sourceText, segment.finalText, segment.translatedText]
        .some((value) => includesQuery(value, normalizedQuery));
  }
}

export function useSegmentFilters(segments: Segment[]) {
  const [query, setQuery] = useState('');
  const [searchScope, setSearchScope] = useState<SegmentSearchScope>('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [kindFilter, setKindFilter] = useState('all');

  const filteredSegments = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return segments.filter((segment) => {
      const matchesStatus = statusFilter === 'all' || segment.reviewStatus === statusFilter;
      const matchesKind = kindFilter === 'all' || segment.kind === kindFilter;
      const matchesQuery = matchesSegmentSearch(segment, normalized, searchScope);
      return matchesStatus && matchesKind && matchesQuery;
    });
  }, [kindFilter, query, searchScope, segments, statusFilter]);

  return {
    query,
    searchScope,
    statusFilter,
    kindFilter,
    filteredSegments,
    setQuery,
    setSearchScope,
    setStatusFilter,
    setKindFilter,
  };
}
