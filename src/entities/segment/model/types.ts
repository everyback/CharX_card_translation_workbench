import type { ControlReference } from '@/shared/model/control-reference';

export interface Segment {
  id: string;
  pathLabel: string;
  category: string;
  kind: string;
  sourceText: string;
  translatedText: string | null;
  finalText: string | null;
  start: number | null;
  end: number | null;
  riskLevel: 'low' | 'medium' | 'high';
  reviewStatus: 'untranslated' | 'pending' | 'approved' | 'rejected';
  included: boolean;
  qaFlags: string[];
  controlReferences: Array<ControlReference & {
    fullPattern?: string;
    originalMatches?: number;
    draftMatches?: number;
    originalSamples?: string[];
    draftSamples?: string[];
    forcePassed?: boolean;
    dynamicDisplay?: boolean;
    runtimePostprocess?: boolean;
  }>;
  translationError: string | null;
  sortOrder: number;
  updatedAt: string;
}

export interface ReviewFocus {
  pathLabel: string;
  pattern?: string;
  originalMatches?: number;
  draftMatches?: number;
  line?: number;
  column?: number;
  sourceLine?: string;
  draftLine?: string;
  segmentIds: string[];
  problem: string;
  fixSuggestion: string;
}
