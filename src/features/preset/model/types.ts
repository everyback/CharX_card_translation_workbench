/** Mirrors the preset project view returned by `/api/projects/:id/preset-report`. */

export interface PresetAnalysisBlock {
  index: number;
  characterId: string | number | null;
  entries: Array<{ identifier: string; enabled: boolean }>;
}

export interface PresetAnalysis {
  name: string;
  blocks: PresetAnalysisBlock[];
  promptCount: number;
  referencedCount: number;
  orphanCount: number;
  roleCounts: Record<string, number>;
  foreignRoles: string[];
  suggestedBlockIndex: number;
  recommendedBlockIndex: number;
  warnings: string[];
}

export interface PresetConversionReport {
  schemaVersion: 1;
  targetRevision: string;
  controlNamespace: string;
  covered: Array<{ identifier: string; name: string; reason: string }>;
  archived: Array<{ identifier: string; name: string; reason: string }>;
  issues: Array<{ code: string; path: string; severity: 'error' | 'warning'; message: string }>;
  blockIndex: number;
  blockCharacterId: string | number | null;
  name: string;
  toggleKeys: string[];
  emitted: Array<{ identifier: string; name: string; source: 'block' | 'orphan'; enabled: boolean; gated: boolean; type: string; toggleKey?: string }>;
  dropped: Array<{ identifier: string; name: string; reason: string }>;
  degraded: Array<{ identifier: string; name: string; reason: string }>;
  roleRemaps: Array<{ identifier: string; name: string; from: string; to: string }>;
  promotedToAlwaysOn: Array<{ identifier: string; name: string }>;
  regexConverted: Array<{ name: string; mode: string }>;
  regexSkipped: Array<{ name: string; reason: string }>;
  unmappedFields: string[];
  warnings: string[];
}

export interface PresetPromptView {
  path: Array<string | number>;
  namePath: Array<string | number>;
  identifier: string;
  name: string;
  content: string;
  source: 'block' | 'orphan';
  enabled: boolean;
  state: 'always' | 'gated' | 'dropped' | 'covered' | 'archived';
  dropReason?: string;
  edited: boolean;
}

/** Mirrors `server/domain/card/preset-capability.ts`. */
export type CapabilityOwner = 'direct' | 'convert' | 'bridge' | 'impossible';

export interface CapabilityFinding {
  code: string;
  owner: CapabilityOwner;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

/** One regex rule's ownership after conversion. */
export interface RuleCapability {
  index: number;
  comment: string;
  type: string;
  owner: CapabilityOwner;
  /** True when the rule stops working unless the bridge plugin is installed. */
  requiresBridge: boolean;
  bridgeActions: string[];
  findings: CapabilityFinding[];
}

export interface PresetCapabilityReport {
  rules: RuleCapability[];
  summary: {
    counts: Record<CapabilityOwner, number>;
    needsBridge: number;
    requiresPlugin: boolean;
    hasImpossible: boolean;
  };
  /** `toggle_*` keys referenced by `{{#when::{{getglobalvar::…}}}}` gates. */
  switchGates: string[];
  /** Macros RisuAI does not register (third-party extension macros). */
  unknownMacros: string[];
  /** True when `{{setvar::}}` appears: it does not execute in the display pipeline. */
  usesSetvar: boolean;
  /** Preset-level cautions to show above the rule list. */
  notices: string[];
}

export interface PresetProjectView {
  analysis: PresetAnalysis;
  report: PresetConversionReport;
  capabilities: PresetCapabilityReport;
  blockIndex: number | null;
  effectiveBlockIndex: number;
  prompts: PresetPromptView[];
  editedCount: number;
}

export interface PresetEditResult extends PresetProjectView {
  ok: true;
  warnings: string[];
  appliedRemovals: string[];
}

export interface SetvarRemovalNotice {
  name: string;
  /** Indices into the converted prompt template that still read the variable. */
  references: number[];
}
