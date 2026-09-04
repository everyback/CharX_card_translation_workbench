import type { ControlReference } from '@/shared/model/control-reference';

export type LuaManagementStepStatus = 'complete' | 'needs-review' | 'blocked' | 'not-applicable';

export interface LuaManagementStep {
  id: 'scan' | 'classify' | 'repair' | 'review' | 'validate' | 'export';
  title: string;
  status: LuaManagementStepStatus;
  message: string;
}

export type RegexCoverageRuleStatus = 'pending' | 'queued' | 'processing' | 'returned' | 'validated' | 'no-change' | 'rejected' | 'failed' | 'cancelled';

export interface RegexCoverageValidation {
  passed: boolean;
  sourceMatchCount: number;
  draftMatchCount: number;
  dynamicDisplay?: boolean;
  runtimePostprocess?: boolean;
  syntaxIssues?: string[];
  message?: string;
}

export interface RegexLanguagePayloadSummary {
  totalRecords: number;
  totalUniqueRecords: number;
  selectedRecords: number;
  totalSourceMatches: number;
  totalDraftMatches: number;
  selectedSourceMatches: number;
  selectedDraftMatches: number;
  truncated: boolean;
  sampling: string;
  budgetChars: number;
  contextChars: number;
  dynamicDisplay?: boolean;
  runtimePostprocess?: boolean;
  strata: { coverageDifference: number; textDifference: number; stable: number };
  formatProbe?: {
    kind: string;
    sourceMatchCount: number;
    draftMatchCount: number;
    baselineSourceMatchCount: number;
    baselineDraftMatchCount: number;
    totalRecords: number;
    selectedRecords: number;
    truncated: boolean;
  };
}

export interface RegexCoverageChange {
  pathLabel: string;
  addedAlternatives: string[];
}

export interface RegexCoverageRule {
  pathLabel: string;
  originalPattern?: string;
  pattern: string;
  type: string;
  out: string;
  dynamicDisplay?: boolean;
  runtimePostprocess?: boolean;
  sourceSamples: string[];
  draftSamples: string[];
  sourceMatches?: string[];
  draftMatches?: string[];
  coveragePaths?: string[];
  sourceMatchCount: number;
  draftMatchCount: number;
  status?: RegexCoverageRuleStatus;
  proposals?: Array<Record<string, unknown>>;
  changes?: RegexCoverageChange[];
  validation?: RegexCoverageValidation;
  candidatePattern?: string;
  modelContext?: RegexLanguagePayloadSummary;
  error?: string;
}

export interface RegexCoveragePreview {
  ok: boolean;
  checked: number;
  rules: RegexCoverageRule[];
}

export interface RegexCoverageRuleResult {
  ok: boolean;
  pathLabel: string;
  status: RegexCoverageRuleStatus;
  applied: number;
  proposals: Array<Record<string, unknown>>;
  changes: RegexCoverageChange[];
  validation: RegexCoverageValidation;
  candidatePattern?: string;
  modelContext?: RegexLanguagePayloadSummary;
  message?: string;
}

export interface RegexRuleTestResult {
  ok: boolean;
  pathLabel: string;
  pattern: string;
  compiled: boolean;
  sourceMatchCount: number;
  draftMatchCount: number;
  dynamicDisplay?: boolean;
  runtimePostprocess?: boolean;
  sourceSamples: string[];
  draftSamples: string[];
  message?: string;
}

export interface RegexRuleSaveResult extends RegexRuleTestResult {
  validationSourceMatchCount?: number;
  validationDraftMatchCount?: number;
  saved: boolean;
  previousPattern: string;
  out?: string;
  previousOut?: string;
  forcePassed: boolean;
}

export interface LuaManagementSegment {
  id: string;
  pathLabel: string;
  kind: string;
  sourceText: string;
  start: number | null;
  end: number | null;
  risk: 'low' | 'medium' | 'high';
  reviewStatus: string;
  finalText: string | null;
  translatedText: string | null;
  sourceCodeLine?: string;
  sourceCodeLineNumber?: number;
}

export interface LuaManagementIssue {
  kind: 'syntax' | 'template' | 'runtime' | 'control' | 'portrait' | 'router' | 'namespace';
  pathJson?: string;
  pathLabel: string;
  message: string;
  blocking: boolean;
  segmentIds: string[];
  line?: number;
  column?: number;
  sourceLine?: string;
  draftLine?: string;
  contextLines?: Array<{ line: number; sourceLine: string; draftLine: string; errorLine: boolean }>;
}

export interface LuaPortraitCandidate {
  ownerId: string;
  names: string[];
  missingAliases: string[];
  pathLabels: string[];
  status: 'covered' | 'needs-alias';
  segmentIds: string[];
  targetAliases?: string[];
}

export interface PortraitRouterRepairFinding {
  id: 'completion-marker-gate' | 'main-passthrough';
  title: string;
  message: string;
  pathLabel: string;
  safeToApply: boolean;
}

export interface PortraitRouterRepairReport {
  detected: boolean;
  canApply: boolean;
  findings: PortraitRouterRepairFinding[];
}

export interface PortraitRouterRepairChange {
  id: PortraitRouterRepairFinding['id'];
  title: string;
  pathLabel: string;
  before: string;
  after: string;
}

export interface PortraitRouterRepairPreview {
  ok: boolean;
  report: PortraitRouterRepairReport;
  applied: PortraitRouterRepairFinding[];
  changes: PortraitRouterRepairChange[];
}

export interface LuaManagementReport {
  generatedAt: string;
  hasModule: boolean;
  sourceCount: number;
  visibleCount: number;
  controlReferenceCount: number;
  regexCount: number;
  pendingCount: number;
  approvedCount: number;
  blockerCount: number;
  warningCount: number;
  portraitCandidateCount: number;
  portraitCoveredCount: number;
  portraitMissingCount: number;
  portraitCandidates: LuaPortraitCandidate[];
  portraitFeatureDetected: boolean;
  portraitFeatureSignals: string[];
  routerRepair: PortraitRouterRepairReport;
  namespaceHandling: 'unconfirmed' | 'preserved' | 'review' | 'translated';
  segments: LuaManagementSegment[];
  controlReferences: Array<ControlReference & {
    fullPattern?: string;
    originalPattern?: string;
    addedAlternatives?: string[];
    originalMatches?: number;
    draftMatches?: number;
    originalSamples?: string[];
    draftSamples?: string[];
    forcePassed?: boolean;
    dynamicDisplay?: boolean;
    runtimePostprocess?: boolean;
  }>;
  regexRules: Array<ControlReference & {
    kind: 'regex';
    fullPattern?: string;
    originalPattern?: string;
    addedAlternatives?: string[];
    originalMatches?: number;
    draftMatches?: number;
    originalSamples?: string[];
    draftSamples?: string[];
    forcePassed?: boolean;
    dynamicDisplay?: boolean;
    runtimePostprocess?: boolean;
  }>;
  issues: LuaManagementIssue[];
  steps: LuaManagementStep[];
}
