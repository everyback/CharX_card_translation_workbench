// Compatibility facade for cross-module contracts. New code should import from the owning module.
export type { ScopePreset, Tab } from './model/workbench-types';
export type { ControlReference } from './model/control-reference';

export type {
  ProtocolFieldRule,
  ProtocolOccurrence,
  ProtocolPolicy,
  ProtocolSchema,
  ProtocolStatus,
} from '@/features/protocol/model/types';
export type { Settings } from '@/features/settings/model/types';
export type { GlossaryTerm } from '@/features/glossary/model/types';

export type {
  Dashboard,
  ProjectDetail,
  ProjectSegmentsPage,
  ProjectSummary,
  ScanSummary,
} from '@/entities/project/model/types';
export type { Job, JobLog } from '@/entities/job/model/types';
export type { ReviewFocus, Segment } from '@/entities/segment/model/types';

export type {
  LuaManagementIssue,
  LuaManagementReport,
  LuaManagementSegment,
  LuaManagementStep,
  LuaManagementStepStatus,
  LuaPortraitCandidate,
  PortraitRouterRepairChange,
  PortraitRouterRepairFinding,
  PortraitRouterRepairPreview,
  PortraitRouterRepairReport,
  RegexCoverageChange,
  RegexCoveragePreview,
  RegexCoverageRule,
  RegexCoverageRuleResult,
  RegexCoverageRuleStatus,
  RegexCoverageValidation,
  RegexLanguagePayloadSummary,
  RegexRuleSaveResult,
  RegexRuleTestResult,
} from '@/features/lua/model/types';

export type {
  CharxEntryCategory,
  CharxEntryInfo,
  ProjectOverview,
  TavernCardFieldSummary,
  TavernCardInspection,
  UnpackInspection,
} from '@/pages/workbench/tabs/overview/model/types';

export type {
  ResourceImageCandidate,
  ResourceInspection,
  ResourceItem,
  ResourceKind,
  ResourceOcrCandidate,
  ResourceOcrStatus,
  ResourceReference,
  ResourceTextRisk,
} from '@/entities/resource/model/types';
