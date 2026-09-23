/**
 * Editing surface for SillyTavern preset projects.
 *
 * Only copy fields are editable (`name`, `prompts[i].content`, `prompts[i].name`).
 * Everything structural — `role`, `identifier`, `prompt_order`, sampler fields —
 * is read-only: changing them alters preset structure and belongs in SillyTavern.
 *
 * The guard that matters most is `setvar` dependency loss. ST presets keep
 * variable definitions in prompts and read them elsewhere (`{{setvar::x::…}}` /
 * `{{getvar::x}}`). Removing a definition makes every reference silently resolve
 * to an empty string: the preset still imports, still looks fine, and quietly
 * stops working. That case is escalated to a forced confirmation.
 *
 * All analysis runs on the **converted** RisuAI preset rather than the raw ST
 * JSON, because that is the only place where gating is explicit: the converter
 * wraps every disabled/orphan prompt in `{{#when::…}}`, and a definition inside a
 * default-off gate does not execute.
 */
import { analyzeStPreset, convertStPreset, presetControlNamespace, readStPresetPrompts, type StPresetAnalysis, type StPresetConversionReport } from './st-preset-convert.js';
import { analyzePresetCapabilities, type PresetCapabilityReport } from './preset-capability.js';

export type PresetEditPath = Array<string | number>;

export interface SetvarSite {
  /** Index into the converted `promptTemplate`. */
  item: number;
  /** True when the containing prompt is wrapped in a default-off `{{#when::…}}`. */
  gated: boolean;
}

export interface SetvarRemoval {
  name: string;
  /** Variable keeps at least one always-on definition after the edit. */
  stillAlwaysOn: boolean;
  /** Indices (in the edited template) of prompts that still read the variable. */
  references: SetvarSite[];
}

export interface PresetEditImpact {
  /** Loses its last always-on definition while still being referenced — must be confirmed. */
  blocking: SetvarRemoval[];
  /** Loses its last always-on definition but nothing reads it — informational. */
  noted: SetvarRemoval[];
  /** Still defined always-on elsewhere — no action needed. */
  safe: SetvarRemoval[];
  warnings: string[];
}

export interface PresetPromptView {
  /** Path to the editable content field. */
  path: PresetEditPath;
  namePath: PresetEditPath;
  identifier: string;
  name: string;
  content: string;
  source: 'block' | 'orphan';
  enabled: boolean;
  /** `always` = sent every request, `gated` = behind a default-off switch, `dropped` = not representable. */
  state: 'always' | 'gated' | 'dropped' | 'covered' | 'archived';
  dropReason?: string;
  /** Draft differs from the original at this path. */
  edited: boolean;
}

export interface PresetProjectView {
  analysis: StPresetAnalysis;
  report: StPresetConversionReport;
  /** Capability ownership per regex rule, plus preset-level flags. */
  capabilities: PresetCapabilityReport;
  /** Stored per-project selection, or null for automatic. */
  blockIndex: number | null;
  effectiveBlockIndex: number;
  prompts: PresetPromptView[];
  editedCount: number;
}

export const SETVAR_DEFINITION_REMOVED = 'SETVAR_DEFINITION_REMOVED';

/** Paths the editor is allowed to touch. */
export function isEditablePresetPath(path: PresetEditPath): boolean {
  if (path.length === 1 && path[0] === 'name') return true;
  if (path.length !== 3 || path[0] !== 'prompts') return false;
  if (!Number.isInteger(path[1]) || (path[1] as number) < 0) return false;
  return path[2] === 'content' || path[2] === 'name';
}

export function readPresetPath(preset: Record<string, unknown>, path: PresetEditPath): string {
  let cursor: unknown = preset;
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return '';
    cursor = (cursor as Record<string | number, unknown>)[key];
  }
  return typeof cursor === 'string' ? cursor : '';
}

/** Returns a copy of `preset` with `path` set to `text`. */
export function writePresetPath(
  preset: Record<string, unknown>,
  path: PresetEditPath,
  text: string,
): Record<string, unknown> {
  if (!isEditablePresetPath(path)) throw new Error('只允许编辑预设名称与提示词的名称/正文。');
  const clone = structuredClone(preset);
  let cursor: Record<string | number, unknown> = clone;
  for (const key of path.slice(0, -1)) {
    const next = cursor[key];
    if (next === null || typeof next !== 'object') throw new Error('预设结构中没有该路径。');
    cursor = next as Record<string | number, unknown>;
  }
  const last = path[path.length - 1];
  if (!(last in cursor)) throw new Error('预设结构中没有该路径。');
  cursor[last] = text;
  return clone;
}

const SETVAR_PATTERN = /\{\{setvar::([^:}]+)::/gu;
const GETVAR_PATTERN = /\{\{getvar::([^:}]+)/gu;
const GATE_OPEN_PATTERN = /\{\{#when::/gu;
const GATE_CLOSE_PATTERN = /\{\{\/when\}\}/gu;

interface SetvarIndex {
  definitions: Map<string, SetvarSite[]>;
  references: Map<string, SetvarSite[]>;
}

function push(map: Map<string, SetvarSite[]>, name: string, site: SetvarSite): void {
  const list = map.get(name);
  if (list) list.push(site);
  else map.set(name, [site]);
}

/** Index `setvar` definitions and `getvar` reads across a converted preset template. */
export function indexSetvars(convertedPreset: Record<string, unknown>): SetvarIndex {
  const definitions = new Map<string, SetvarSite[]>();
  const references = new Map<string, SetvarSite[]>();
  const template = Array.isArray(convertedPreset.promptTemplate) ? convertedPreset.promptTemplate : [];
  template.forEach((raw, item) => {
    if (!raw || typeof raw !== 'object') return;
    const text = (raw as Record<string, unknown>).text;
    if (typeof text !== 'string' || !text) return;
    // The converter gates a whole prompt, so a leading gate means the entire
    // content is behind a default-off switch.
    const gated = text.startsWith('{{#when::');
    for (const match of text.matchAll(SETVAR_PATTERN)) push(definitions, match[1], { item, gated });
    for (const match of text.matchAll(GETVAR_PATTERN)) push(references, match[1], { item, gated });
  });
  return { definitions, references };
}

function alwaysOnCount(sites: SetvarSite[] | undefined): number {
  return (sites ?? []).filter((site) => !site.gated).length;
}

/**
 * Compare two versions of the same preset and report which `setvar` definitions
 * the edit removes. Only definitions that lost their **last always-on** site are
 * treated as removals — a variable that keeps an always-on definition is fine,
 * and one that only ever existed inside gates was already conditional.
 */
export function analyzePresetEditImpact(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  options: { blockIndex?: number; name?: string } = {},
): PresetEditImpact {
  const convertedBefore = convertStPreset(before, { ...options, compileVariables: false }).preset;
  const convertedAfter = convertStPreset(after, { ...options, compileVariables: false }).preset;
  const previous = indexSetvars(convertedBefore);
  const current = indexSetvars(convertedAfter);

  const blocking: SetvarRemoval[] = [];
  const noted: SetvarRemoval[] = [];
  const safe: SetvarRemoval[] = [];

  for (const [name, beforeSites] of previous.definitions) {
    if (alwaysOnCount(beforeSites) === 0) continue;
    const afterSites = current.definitions.get(name);
    if (alwaysOnCount(afterSites) > 0) {
      safe.push({ name, stillAlwaysOn: true, references: current.references.get(name) ?? [] });
      continue;
    }
    const entry: SetvarRemoval = {
      name,
      stillAlwaysOn: false,
      references: current.references.get(name) ?? [],
    };
    if (entry.references.length) blocking.push(entry);
    else noted.push(entry);
  }

  blocking.sort((left, right) => left.name.localeCompare(right.name));
  noted.sort((left, right) => left.name.localeCompare(right.name));
  safe.sort((left, right) => left.name.localeCompare(right.name));
  return { blocking, noted, safe, warnings: [] };
}

/** Structural checks on a single edited text field. Never throws. */
export function validateEditedText(text: string, declaredToggleKeys: readonly string[] = []): string[] {
  const warnings: string[] = [];
  const opens = [...text.matchAll(GATE_OPEN_PATTERN)].length;
  const closes = [...text.matchAll(GATE_CLOSE_PATTERN)].length;
  if (opens !== closes) {
    warnings.push(`门控宏不配对：{{#when::}} 出现 ${opens} 次，{{/when}} 出现 ${closes} 次。`);
  }
  const declared = new Set(declaredToggleKeys);
  // The macro reads `toggle_<key>` while `customPromptTemplateToggle` declares
  // bare `<key>`, so strip the prefix before comparing.
  for (const match of text.matchAll(/\{\{#when::\{\{getglobalvar::toggle_([A-Za-z0-9_]+)\}\}\}\}/gu)) {
    if (!declared.has(match[1])) {
      warnings.push(`门控引用了未声明的开关 toggle_${match[1]}，该开关不会出现在 RisuAI 的开关面板里。`);
    }
  }
  return warnings;
}

/**
 * Shape the preset for the conversion UI: the selected block's prompts in order,
 * followed by unreferenced library prompts, each with its current draft text and
 * how it will be represented in the exported `.risup`.
 */
export function buildPresetProjectView(
  original: Record<string, unknown>,
  draft: Record<string, unknown>,
  blockIndex: number | null,
  name?: string,
): PresetProjectView {
  const analysis = analyzeStPreset(original);
  const effectiveBlockIndex = blockIndex ?? analysis.recommendedBlockIndex;
  const options = { controlNamespace: presetControlNamespace(original), blockIndex: effectiveBlockIndex, ...(name ? { name } : {}) };
  const { report, preset: converted } = convertStPreset(draft, options);
  // Ownership is judged on the **converted** preset's regex `out` fields, because
  // those are what ship. Classifying the raw ST text would miss the bridge
  // declarations and the `<details>` rewrites the converter introduces.
  const capabilities = analyzePresetCapabilities(converted);

  const draftPrompts = readStPresetPrompts(draft);
  const byIdentifier = new Map(draftPrompts.map((prompt) => [prompt.identifier, prompt]));
  const emittedByIdentifier = new Map(report.emitted.map((item) => [item.identifier, item]));
  const dropReasons = new Map([...report.dropped, ...report.covered, ...report.archived].map((item) => [item.identifier, item.reason]));

  const prompts: PresetPromptView[] = [];
  const seen = new Set<string>();
  const append = (identifier: string, enabled: boolean, source: 'block' | 'orphan') => {
    if (seen.has(identifier)) return;
    const prompt = byIdentifier.get(identifier);
    if (!prompt) return;
    seen.add(identifier);
    const emitted = emittedByIdentifier.get(identifier);
    const reason = dropReasons.get(identifier);
    const state: PresetPromptView['state'] = emitted ? (emitted.gated ? 'gated' : 'always') : report.covered.some((item) => item.identifier === identifier) ? 'covered' : report.archived.some((item) => item.identifier === identifier) ? 'archived' : 'dropped';
    const path: PresetEditPath = ['prompts', prompt.index, 'content'];
    const namePath: PresetEditPath = ['prompts', prompt.index, 'name'];
    prompts.push({
      path,
      namePath,
      identifier,
      name: prompt.name,
      content: prompt.content,
      source,
      enabled,
      state,
      ...(reason ? { dropReason: reason } : {}),
      edited: prompt.content !== readPresetPath(original, path) || prompt.name !== readPresetPath(original, namePath),
    });
  };

  const block = analysis.blocks.find((candidate) => candidate.index === effectiveBlockIndex);
  if (block) for (const entry of block.entries) append(entry.identifier, entry.enabled, 'block');
  else for (const prompt of draftPrompts) append(prompt.identifier, true, 'block');
  for (const prompt of draftPrompts) append(prompt.identifier, false, 'orphan');

  return {
    analysis,
    report,
    capabilities,
    blockIndex,
    effectiveBlockIndex,
    prompts,
    editedCount: prompts.filter((prompt) => prompt.edited).length,
  };
}
