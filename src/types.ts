export type ScopePreset = 'core' | 'standard' | 'visible-scripts' | 'all-visible' | 'all' | 'lua-only';
export type Tab = 'overview' | 'segments' | 'jobs' | 'review' | 'glossary' | 'references' | 'protocols' | 'lua' | 'resources' | 'about';

export interface ControlReference {
  literal: string;
  kind: 'regex' | 'lua';
  pathLabel: string;
  pattern: string;
}

export type ProtocolPolicy = 'translate' | 'protect' | 'manual';
export type ProtocolStatus = 'pending' | 'analyzed' | 'approved' | 'ignored';

export interface ProtocolFieldRule {
  index: number;
  role: string;
  policy: ProtocolPolicy;
  confidence: number;
  reason: string;
  hardProtected: boolean;
}

export interface ProtocolOccurrence {
  pathLabel: string;
  start: number;
  end: number;
  rawPreview: string;
  fields: Array<{ index: number; value: string }>;
  isDeclaration: boolean;
}

export interface ProtocolSchema {
  id: string;
  projectId: string;
  signature: string;
  name: string;
  form: 'angle' | 'square' | 'at-line';
  opener: string;
  closer: string;
  delimiter: string;
  fieldCount: number;
  status: ProtocolStatus;
  source: 'local' | 'regex-lua' | 'model' | 'manual';
  confidence: number;
  fieldRules: ProtocolFieldRule[];
  declaration: string;
  examples: string[];
  occurrenceCount: number;
  referenceCount: number;
  lastError: string | null;
  occurrences: ProtocolOccurrence[];
  updatedAt: string;
}

export interface Settings {
  apiBaseUrl: string;
  apiKeyConfigured: boolean;
  model: string;
  sourceLanguage: string;
  fallbackLanguage: string;
  targetLanguage: string;
  languageBehaviorMode: 'target' | 'preserve';
  concurrency: number;
  batchItems: number;
  batchChars: number;
  requestTimeoutSeconds: number;
  imageApiUrl: string;
  imageApiKeyConfigured: boolean;
  imageModel: string;
}

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
  controlReferences: Array<ControlReference & { fullPattern?: string; originalMatches?: number; draftMatches?: number; originalSamples?: string[]; draftSamples?: string[]; forcePassed?: boolean; dynamicDisplay?: boolean }>;
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

export interface Job {
  id: string;
  projectId: string;
  status: string;
  scope: ScopePreset;
  model: string;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  postTotalItems: number;
  postCompletedItems: number;
  postFailedItems: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  logs?: JobLog[];
}

export interface JobLog {
  id: number;
  level: string;
  message: string;
  createdAt: string;
}

export interface ProjectDetail extends ProjectSummary {
  sourceFilename: string | null;
  sourceLanguage: string;
  targetLanguage: string;
  languageBehaviorMode: 'target' | 'preserve';
  originalHash: string;
  createdAt: string;
  segments: Segment[];
  controlReferences: Array<ControlReference & { originalMatches?: number; draftMatches?: number; originalSamples?: string[]; draftSamples?: string[]; forcePassed?: boolean }>;
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
  sourceSamples: string[];
  draftSamples: string[];
  message?: string;
}

export interface RegexRuleSaveResult extends RegexRuleTestResult {
  saved: boolean;
  previousPattern: string;
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
  kind: 'syntax' | 'template' | 'runtime' | 'control' | 'portrait' | 'router';
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
  segments: LuaManagementSegment[];
  controlReferences: Array<ControlReference & { fullPattern?: string; originalPattern?: string; addedAlternatives?: string[]; originalMatches?: number; draftMatches?: number; originalSamples?: string[]; draftSamples?: string[]; forcePassed?: boolean; dynamicDisplay?: boolean }>;
  issues: LuaManagementIssue[];
  steps: LuaManagementStep[];
}

export interface GlossaryTerm {
  id: string;
  sourceText: string;
  targetText: string;
  notes: string;
  caseSensitive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type CharxEntryCategory = 'card' | 'module' | 'asset' | 'metadata' | 'other';

export interface CharxEntryInfo {
  path: string;
  size: number;
  category: CharxEntryCategory;
}

export interface UnpackInspection {
  sessionId: string;
  filename: string;
  cardName: string;
  spec: string;
  hybrid: boolean;
  fileCount: number;
  totalBytes: number;
  cardLorebookEntries: number;
  modulePresent: boolean;
  moduleName: string | null;
  moduleLorebookEntries: number;
  moduleAssetCount: number;
  entries: CharxEntryInfo[];
}

export interface TavernCardFieldSummary {
  path: string;
  label: string;
  type: 'text' | 'list' | 'object' | 'value';
  size: number;
  summary: string;
  preview: string;
}

export interface TavernCardInspection {
  sessionId: string;
  filename: string;
  sourceFormat: 'png' | 'json';
  fileBytes: number;
  previewAvailable: boolean;
  cardName: string;
  spec: string;
  specVersion: string;
  creator: string;
  characterVersion: string;
  metadataKeys: string[];
  jsonBytes: number;
  alternateGreetings: number;
  groupOnlyGreetings: number;
  lorebookEntries: number;
  regexScripts: number;
  assets: number;
  tags: string[];
  extensionKeys: string[];
  topLevelKeys: string[];
  dataKeys: string[];
  fields: TavernCardFieldSummary[];
  warnings: string[];
}

export interface ProjectOverview extends Omit<TavernCardInspection, 'sessionId' | 'filename' | 'sourceFormat'> {
  projectId: string;
  filename: string | null;
  sourceFormat: string;
  modulePresent: boolean;
  moduleName: string;
  moduleLorebookEntries: number;
  moduleRegexScripts: number;
  moduleTriggers: number;
  moduleAssets: number;
  moduleJsonBytes: number;
  moduleKeys: string[];
}

export type ResourceKind = 'image' | 'audio' | 'video' | 'font' | 'data' | 'other';
export type ResourceTextRisk = 'none' | 'path' | 'unknown';
export type ResourceOcrStatus = 'draft' | 'confirmed';

export interface ResourceOcrCandidate {
  text: string;
  confidence: number | null;
  engine: string;
  status: ResourceOcrStatus;
  updatedAt: string;
}

export interface ResourceImageCandidate {
  mimeType: string;
  model: string;
  prompt: string;
  status: ResourceOcrStatus;
  updatedAt: string;
}

export interface ResourceReference {
  pathLabel: string;
  sample: string;
}

export interface ResourceItem {
  path: string;
  displayName: string;
  kind: ResourceKind;
  mimeType: string;
  detectedFormat: string;
  declaredType: string | null;
  embeddedIndex: number | null;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  textRisk: ResourceTextRisk;
  languageHint: string | null;
  references: ResourceReference[];
  previewable: boolean;
  ocrCandidate?: ResourceOcrCandidate;
  imageCandidate?: ResourceImageCandidate;
}

export interface ResourceInspection {
  sourceFormat: string;
  sourceFilename: string | null;
  resources: ResourceItem[];
  summary: {
    total: number;
    images: number;
    suspectedText: number;
    referenced: number;
  };
}
