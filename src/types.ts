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
  controlReferences: ControlReference[];
  translationError: string | null;
  sortOrder: number;
  updatedAt: string;
}

export interface ReviewFocus {
  pathLabel: string;
  pattern: string;
  originalMatches: number;
  draftMatches: number;
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
  controlReferences: ControlReference[];
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

export interface LuaManagementSegment {
  pathLabel: string;
  kind: string;
  sourceText: string;
  start: number | null;
  end: number | null;
  risk: 'low' | 'medium' | 'high';
  reviewStatus: string;
  finalText: string | null;
  translatedText: string | null;
}

export interface LuaManagementIssue {
  kind: 'syntax' | 'template' | 'runtime' | 'control' | 'portrait' | 'router';
  pathLabel: string;
  message: string;
  blocking: boolean;
}

export interface LuaPortraitCandidate {
  ownerId: string;
  names: string[];
  missingAliases: string[];
  pathLabels: string[];
  status: 'covered' | 'needs-alias';
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
  controlReferences: ControlReference[];
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
