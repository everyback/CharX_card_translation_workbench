import type { Job } from '@/entities/job/model/types';
import type { Segment } from '@/entities/segment/model/types';
import type { Settings } from '@/features/settings/model/types';
import type { ControlReference } from '@/shared/model/control-reference';
import type { ScopePreset } from '@/shared/model/workbench-types';

export interface Dashboard {
  projects: number;
  pendingReview: number;
  activeJobs: number;
  settings: Settings;
}

export interface ProjectSummary {
  id: string;
  name: string;
  originalName: string;
  translatedName: string | null;
  scope: ScopePreset;
  status: string;
  sourceFormat: string;
  segmentCount: number;
  approvedCount: number;
  pendingReviewCount: number;
  updatedAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  sourceFilename: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  languageBehaviorMode: 'target' | 'preserve';
  originalHash: string;
  createdAt: string;
  segments: Segment[];
  controlReferences: Array<ControlReference & {
    originalMatches?: number;
    draftMatches?: number;
    originalSamples?: string[];
    draftSamples?: string[];
    forcePassed?: boolean;
  }>;
  jobs: Job[];
  scanSummary?: ScanSummary;
}

export interface ProjectSegmentsPage {
  offset: number;
  limit: number;
  total: number;
  segments: Segment[];
}

export interface ScanSummary {
  totalSegments: number;
  pendingSegments: number;
  approvedSegments: number;
  highRiskSegments: number;
  protocolSegments: number;
  luaSegments: number;
  runtimeRiskCount: number;
  runtimeRiskMessages: string[];
}
