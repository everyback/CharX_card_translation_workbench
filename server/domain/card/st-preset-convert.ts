import { createHash } from 'node:crypto';
import { compileLiteralPresetVariables } from './st-preset-variables.js';
import { RISU_KNOWN_MACROS } from './preset-capability.js';
import { normalizeStMacros } from './st-macro-map.js';
/**
 * SillyTavern chat-completion preset → RisuAI preset conversion.
 *
 * RisuAI's own importer (`importPreset` in `storage/database.svelte.ts`) reads
 * only `prompt_order[0]`, skips every `enabled: false` entry, ignores
 * `scenario` / `charPersonality` / `dialogueExamples`, and drops all prompts that
 * no order block references. Real presets keep most of their content in a second
 * order block and in unreferenced "library" prompts, so that importer loses the
 * bulk of a preset.
 *
 * This module instead:
 *   - converts a caller-selected `prompt_order` block, preserving order exactly;
 *   - keeps disabled and unreferenced prompts as RisuAI prompt toggles
 *     (`customPromptTemplateToggle` + `{{#when::{{getglobalvar::toggle_…}}}}`),
 *     defaulting to off so they cost nothing until switched on;
 *   - reports everything dropped or degraded instead of silently discarding it.
 *
 * Toggle gating relies on RisuAI's block parser, which resolves inner macros
 * before matching the block tag (`parser.svelte.ts`, `blockStartMatcher`), so
 * `{{#when::{{getglobalvar::toggle_x}}}}` becomes `#when::1` when the toggle is
 * on and `#when::` (falsy, no `{{:else}}`, therefore empty) when it is off.
 */

export interface StPresetPrompt {
  identifier: string;
  name: string;
  content: string;
  role: string;
  marker: boolean;
  systemPrompt: boolean;
  index: number;
  injectionPosition: number;
}

export interface StPresetBlock {
  index: number;
  characterId: string | number | null;
  entries: Array<{ identifier: string; enabled: boolean }>;
}

export interface StPresetAnalysis {
  name: string;
  blocks: StPresetBlock[];
  promptCount: number;
  referencedCount: number;
  orphanCount: number;
  roleCounts: Record<string, number>;
  /** Roles that RisuAI does not accept verbatim. */
  foreignRoles: string[];
  /** Index of the block whose referenced set is a superset of the others. */
  suggestedBlockIndex: number;
  recommendedBlockIndex: number;
  warnings: string[];
}

export interface StPresetConversionOptions {
  /** Which `prompt_order` block to convert. Defaults to the recommended block. */
  blockIndex?: number;
  name?: string;
  /** Keep disabled/orphan prompts as default-off toggles. Defaults to true. */
  preserveOptionalPrompts?: boolean;
  /** Identity derived from the original source, stable across copy edits. */
  controlNamespace?: string;
  /** Used by edit dependency analysis to retain source variable sites. */
  compileVariables?: boolean;
}

export interface StPresetEmittedPrompt {
  identifier: string;
  name: string;
  source: 'block' | 'orphan';
  enabled: boolean;
  gated: boolean;
  type: string;
  toggleKey?: string;
}

export interface StPresetConversionReport {
  schemaVersion: 1;
  targetRevision: string;
  controlNamespace: string;
  covered: Array<{ identifier: string; name: string; reason: string }>;
  archived: Array<{ identifier: string; name: string; reason: string }>;
  issues: Array<{ code: string; path: string; severity: 'error' | 'warning' | 'info'; message: string }>;
  blockIndex: number;
  blockCharacterId: string | number | null;
  name: string;
  toggleKeys: string[];
  emitted: StPresetEmittedPrompt[];
  dropped: Array<{ identifier: string; name: string; reason: string }>;
  degraded: Array<{ identifier: string; name: string; reason: string }>;
  roleRemaps: Array<{ identifier: string; name: string; from: string; to: string }>;
  /**
   * ST `jailbreak` / `nsfw` prompts emitted as always-sent `plain` entries.
   * RisuAI would drop them as `type: 'jailbreak'` because that type is gated by
   * `db.jailbreakToggle`, which defaults to false.
   */
  promotedToAlwaysOn: Array<{ identifier: string; name: string }>;
  /** SillyTavern regex scripts mapped onto RisuAI preset regex rules. */
  regexConverted: Array<{ name: string; mode: string }>;
  /** Regex scripts that could not be represented, with the reason. */
  regexSkipped: Array<{ name: string; reason: string }>;
  /** Converted regex scripts whose editor-time or depth behaviour differs. */
  regexApproximated: Array<{ name: string; reason: string }>;
  unmappedFields: string[];
  warnings: string[];
}

export interface StPresetConversion {
  /** A RisuAI `botPreset`. Merged over RisuAI's own template on import. */
  preset: Record<string, unknown>;
  report: StPresetConversionReport;
}

/** Fields consumed by this converter. Everything else is explicitly reported. */
const MAPPED_FIELDS = new Set([
  'name', 'prompts', 'prompt_order', 'temperature', 'frequency_penalty', 'presence_penalty',
  'top_p', 'top_k', 'min_p', 'top_a', 'repetition_penalty', 'openai_max_context',
  'openai_max_tokens', 'assistant_prefill',
]);
export const RISU_PRESET_TARGET_REVISION = 'cad8595aa39620df4246f56918f0962c2aa0263a';

export function presetControlNamespace(input: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex').slice(0, 20);
}

/** ST blocks that RisuAI models as dedicated prompt item types. */
const AVAILABLE_TEXT_MACROS = new Set([
  'user', 'char', 'description', 'personality', 'scenario', 'persona', 'exampledialogue',
  'trim', 'newline', 'space', 'random', 'pick', 'roll', 'date', 'time', 'isotime', 'isodate',
  'equal', 'not_equal', 'greater', 'less', 'and', 'or', 'any', 'all', 'not', 'calc',
  'getvar', 'setvar', 'getglobalvar', 'setglobalvar', 'gettempvar', 'settempvar',
]);

const MARKER_TYPES: Record<string, string> = {
  chatHistory: 'chat',
  worldInfoBefore: 'lorebook',
  charDescription: 'description',
  personaDescription: 'persona',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function isSillyTavernPreset(input: unknown): input is Record<string, unknown> {
  if (!isRecord(input)) return false;
  if ('spec' in input || 'data' in input || 'character_version' in input) return false;
  return Array.isArray(input.prompts) || Array.isArray(input.prompt_order)
    || typeof input.instruct_mode === 'boolean'
    || typeof input.system_prompt === 'string'
    || typeof input.context_template === 'string';
}

export function readStPresetPrompts(input: Record<string, unknown>): StPresetPrompt[] {
  const prompts = Array.isArray(input.prompts) ? input.prompts : [];
  const result: StPresetPrompt[] = [];
  prompts.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    result.push({
      identifier: text(raw.identifier) || `prompt_${index}`,
      name: text(raw.name) || text(raw.identifier) || `Prompt ${index + 1}`,
      content: text(raw.content) || text(raw.prompt) || text(raw.text),
      role: text(raw.role).toLowerCase(),
      marker: raw.marker === true,
      systemPrompt: raw.system_prompt === true,
      index,
      injectionPosition: optionalNumber(raw.injection_position) ?? 0,
    });
  });
  return result;
}

export function readStPresetBlocks(input: Record<string, unknown>): StPresetBlock[] {
  const orders = Array.isArray(input.prompt_order) ? input.prompt_order : [];
  return orders.flatMap((raw, index) => {
    if (!isRecord(raw)) return [];
    const entries = Array.isArray(raw.order) ? raw.order : [];
    return [{
      index,
      characterId: typeof raw.character_id === 'string' || typeof raw.character_id === 'number'
        ? raw.character_id
        : null,
      entries: entries.flatMap((entry) => isRecord(entry) && typeof entry.identifier === 'string'
        ? [{ identifier: entry.identifier, enabled: entry.enabled === true }]
        : []),
    }];
  });
}

export function analyzeStPreset(input: Record<string, unknown>): StPresetAnalysis {
  const prompts = readStPresetPrompts(input);
  const blocks = readStPresetBlocks(input);
  const byId = new Map(prompts.map((prompt) => [prompt.identifier, prompt]));
  const referenced = new Set<string>();
  for (const block of blocks) for (const entry of block.entries) referenced.add(entry.identifier);

  const roleCounts: Record<string, number> = {};
  for (const prompt of prompts) roleCounts[prompt.role || '(none)'] = (roleCounts[prompt.role || '(none)'] ?? 0) + 1;
  const foreignRoles = Object.keys(roleCounts).filter((role) => !['user', 'system', 'assistant', 'model', 'char', 'bot', ''].includes(role));

  const warnings: string[] = [];
  if (!blocks.length) warnings.push('预设没有 prompt_order，无法还原提示词顺序；只能按 prompts 定义顺序转换。');
  if (blocks.length > 1) warnings.push(`预设包含 ${blocks.length} 个 prompt_order 块；RisuAI 预设只有一份提示词模板，需要选择其中一个。`);
  if (roleCounts.model) warnings.push(`存在 ${roleCounts.model} 条 role=model 的提示词：ST 用它表示 assistant，将映射为 RisuAI 的 bot。`);

  // Prefer the block whose referenced set covers the others (usually the "real" content block).
  const suggestedBlockIndex = pickSupersetBlock(blocks);
  return {
    name: text(input.name),
    blocks,
    promptCount: prompts.length,
    referencedCount: referenced.size,
    orphanCount: prompts.filter((prompt) => !referenced.has(prompt.identifier)).length,
    roleCounts,
    foreignRoles,
    suggestedBlockIndex,
    recommendedBlockIndex: suggestedBlockIndex,
    warnings,
  };
}

function pickSupersetBlock(blocks: StPresetBlock[]): number {
  if (!blocks.length) return 0;
  let best = 0;
  let bestSize = -1;
  for (const block of blocks) {
    const unique = new Set(block.entries.map((entry) => entry.identifier));
    const coversAll = blocks.every((other) => other.entries.every((entry) => unique.has(entry.identifier)));
    const score = unique.size + (coversAll ? 1000 : 0);
    if (score > bestSize) {
      bestSize = score;
      best = block.index;
    }
  }
  return best;
}

/**
 * Map an ST role onto a RisuAI role.
 *
 * `assistant`/`char` collapse to `bot`, matching RisuAI's own
 * `normalizePromptRole`. `model` also collapses to `bot` — deliberately
 * diverging from RisuAI, which would fall through to `system`. In ST presets
 * `role: model` marks assistant-side prefill text, so mapping it to `system`
 * would change what the model sees.
 */
export function normalizeStRole(role: string, systemPrompt: boolean): { role: 'user' | 'bot' | 'system'; remapped: boolean } {
  if (role === 'user') return { role: 'user', remapped: false };
  if (role === 'system') return { role: 'system', remapped: false };
  if (role === 'assistant' || role === 'char' || role === 'bot') return { role: 'bot', remapped: role !== 'bot' };
  if (role === 'model') return { role: 'bot', remapped: true };
  return { role: 'system', remapped: Boolean(role) || systemPrompt };
}

/** Labels and array positions must not determine persistent toggle identity. */
function toggleKeyFor(prompt: StPresetPrompt, context: ConversionContext): string {
  const id = createHash('sha256').update(prompt.identifier).digest('hex').slice(0, 20);
  return `st_${context.report.controlNamespace}_${id}`;
}

function gateContent(content: string, key: string): string {
  return `{{#when::{{getglobalvar::toggle_${key}}}}}\n${content}\n{{/when}}`;
}

function plainItem(content: string, role: 'user' | 'bot' | 'system', type2: 'normal' | 'main' = 'normal') {
  return { type: 'plain', type2, text: content, role };
}

interface ConversionContext {
  report: StPresetConversionReport;
  activeMarkers: Set<string>;
  toggles: string[];
  preserveOptional: boolean;
}

function convertPrompt(
  prompt: StPresetPrompt,
  enabled: boolean,
  source: 'block' | 'orphan',
  context: ConversionContext,
): Record<string, unknown> | null {
  const { report } = context;
  /**
   * Fold ST macro names onto RisuAI's registry before anything else looks at the
   * content. Without this a camelCase name such as `{{lastMessageId}}` fails the
   * registry check and the whole preset becomes non-exportable, even though the
   * only difference is letter case. Rewrites are reported so the export summary
   * can show what changed.
   */
  const normalized = normalizeStMacros(prompt.content);
  const content = normalized.text;
  if (normalized.rewrites.length) {
    report.issues.push({
      code: 'MACRO_RENAMED',
      path: `prompts[${prompt.index}].content`,
      severity: 'info',
      message: `${prompt.name} 的宏名已按 RisuAI 注册表改写：`
        + normalized.rewrites.map((rewrite) => `${rewrite.from} → ${rewrite.to}（${rewrite.count} 处）`).join('、'),
    });
  }
  if (!enabled && !context.preserveOptional) {
    report.archived.push({ identifier: prompt.identifier, name: prompt.name, reason: '未启用且不保留可选开关；原始定义保留在源文件中。' });
    return null;
  }
  if (prompt.identifier === 'SPresetSettings' || /^SPresetSettings$/iu.test(prompt.name.trim())) {
    report.archived.push({ identifier: prompt.identifier, name: prompt.name, reason: 'ST 插件配置，不是模型提示词；保留原始定义供后续迁移。' });
    report.issues.push({ code: 'PLUGIN_SETTINGS', path: `prompts[${prompt.index}]`, severity: 'warning', message: 'SPresetSettings 插件开关与选择项尚未迁移，配置不会发送给模型。' });
    return null;
  }
  if (prompt.injectionPosition !== 0) {
    report.issues.push({ code: 'INJECTION_POSITION', path: `prompts[${prompt.index}].injection_position`, severity: 'error', message: `${prompt.name} 使用聊天深度注入，尚不能按普通顺序条目导出。` });
  }
  // RisuAI *does* register these macros, so the old blanket error is wrong: the
  // assignment runs during the same parse that reads it (`settempvar`/`gettempvar`
  // share the `vars` scope inside one render). Only cross-*message* state is not
  // guaranteed — that needs `setvar` or a Lua trigger — so this is a warning.
  if (/\{\{\s*(?:(?:set|get|add|inc|dec|flush)(?:global)?var|settempvar|gettempvar)(?:::|\s)/iu.test(content)) {
    report.issues.push({ code: 'VARIABLE_SEMANTICS', path: `prompts[${prompt.index}].content`, severity: 'warning', message: `${prompt.name} 含状态变量宏；RisuAI 支持同一次解析内的赋值与读取，但跨消息持久状态请改用 {{setvar::}} 或 Lua 触发器。正文保留用于迁移。` });
  }
  // After normalization every macro name is in RisuAI's register; anything left
  // over is a third-party extension macro, which simply will not expand.
  const unknownMacros = [...new Set([...content.matchAll(/\{\{\s*([A-Za-z_][\w-]*)(?=\s*(?:::|\}\}))/gu)]
    .map((match) => match[1]).filter((name) => !RISU_KNOWN_MACROS.has(name.toLowerCase())))];
  if (unknownMacros.length) report.issues.push({ code: 'UNVERIFIED_MACRO', path: `prompts[${prompt.index}].content`, severity: 'warning', message: `${prompt.name} 含 RisuAI 未注册的宏：${unknownMacros.join('、')}。这些宏不会展开，其余内容照常导出。` });
  const gate = !enabled && context.preserveOptional;
  let toggleKey: string | undefined;

  const role = normalizeStRole(prompt.role, prompt.systemPrompt);
  if (role.remapped) {
    report.roleRemaps.push({
      identifier: prompt.identifier,
      name: prompt.name,
      from: prompt.role || '(none)',
      to: role.role,
    });
  }

  let item: Record<string, unknown> | null = null;
  let emittedType = 'plain';

  if (prompt.marker && !prompt.content.trim()) {
    const markerType = MARKER_TYPES[prompt.identifier];
    if (markerType) {
      item = markerType === 'chat'
        ? { type: 'chat', rangeStart: 0, rangeEnd: 'end' }
        : { type: markerType };
      emittedType = markerType;
    } else {
      const coverage: Record<string, [string, string]> = {
        dialogueExamples: ['chatHistory', 'chat 已包含角色对话示例，不再重复插入历史。'],
        scenario: ['charDescription', 'description 已包含场景。'],
        charPersonality: ['charDescription', 'description 已包含性格。'],
        worldInfoAfter: ['worldInfoBefore', '合并到 lorebook；前后位置不能分别控制。'],
      };
      const covered = coverage[prompt.identifier];
      if (enabled && covered && context.activeMarkers.has(covered[0])) {
        report.covered.push({ identifier: prompt.identifier, name: prompt.name, reason: covered[1] });
        report.degraded.push({ identifier: prompt.identifier, name: prompt.name, reason: '由原生块承载，ST 中独立位置与格式不再单独保留。' });
        return null;
      }
      if (prompt.identifier === 'worldInfoAfter') {
        item = { type: 'lorebook' };
        emittedType = 'lorebook';
      } else {
        const macros: Record<string, string> = { scenario: 'scenario', charPersonality: 'personality', dialogueExamples: 'exampledialogue' };
        if (macros[prompt.identifier]) {
          item = plainItem(`{{${macros[prompt.identifier]}}}`, role.role);
          report.degraded.push({ identifier: prompt.identifier, name: prompt.name, reason: '无启用的原生承载块，使用角色字段宏；格式与示例角色拆分需复核。' });
        }
      }
    }
  }

  if (!item) {
    // Use the normalized text: macro names were folded onto RisuAI's registry
    // above, and the exported item must carry that form.
    if (!content.trim()) {
      report.dropped.push({
        identifier: prompt.identifier,
        name: prompt.name,
        reason: '提示词内容为空，没有可转换的文本。',
      });
      return null;
    }
    if (prompt.identifier === 'main') {
      item = plainItem(content, role.role, 'main');
      emittedType = 'plain/main';
    } else if (prompt.identifier === 'jailbreak' || prompt.identifier === 'nsfw') {
      // Deliberately NOT RisuAI's `jailbreak` type. RisuAI skips every
      // `type: 'jailbreak'` template entry while `db.jailbreakToggle` is false
      // (its default), so mapping these here would silently drop the prompt —
      // and ST presets routinely keep their variable definitions in `jailbreak`.
      // `plain` keeps the exact position from prompt_order and is always sent,
      // matching ST, where an enabled jailbreak entry is unconditional.
      item = plainItem(content, role.role);
      emittedType = 'plain';
      if (enabled) report.promotedToAlwaysOn.push({ identifier: prompt.identifier, name: prompt.name });
    } else {
      item = plainItem(content, role.role);
      emittedType = 'plain';
    }
    if (prompt.identifier === 'scenario' || prompt.identifier === 'charPersonality') {
      report.degraded.push({
        identifier: prompt.identifier,
        name: prompt.name,
        reason: 'RisuAI 没有对应的预设提示词槽位，已保留为普通提示词以便内容不丢失。',
      });
    }
  }

  if (gate) {
    if (typeof item.text === 'string') {
      // Register the declaration only once the gated text exists, otherwise
      // RisuAI would render a switch that controls nothing.
      toggleKey = toggleKeyFor(prompt, context);
      context.toggles.push(`${toggleKey}=${sanitizeToggleLabel(prompt.name)}`);
      item = { ...item, text: gateContent(item.text, toggleKey) };
    } else {
      // A typed built-in block has no text carrier, so it cannot be gated.
      // ST had it disabled; omitting it keeps the live prompt identical.
      report.archived.push({
        identifier: prompt.identifier,
        name: prompt.name,
        reason: '该条目是 RisuAI 内建块，没有文本载体，无法用开关门控；它在 ST 中被禁用，因此省略以保持行为一致。',
      });
      return null;
    }
  }

  report.emitted.push({
    identifier: prompt.identifier,
    name: prompt.name,
    source,
    enabled,
    gated: Boolean(toggleKey),
    type: emittedType,
    ...(toggleKey ? { toggleKey } : {}),
  });
  return item;
}

/** RisuAI splits toggle declarations on `=`, so labels must not contain it. */
function sanitizeToggleLabel(name: string): string {
  const cleaned = name.replace(/[=\r\n]+/gu, ' ').trim();
  return cleaned || '未命名提示词';
}

/** ST regex placements that map onto a RisuAI script mode. */
const PLACEMENT_TO_MODE: Record<number, string> = {
  1: 'editinput',
  2: 'editoutput',
};

export interface StRegexScript {
  name: string;
  find: string;
  replace: string;
  flags: string;
  placements: number[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  minDepth: number | null;
  maxDepth: number | null;
  runOnEdit: boolean | null;
  substituteRegex: number;
  trimStrings: unknown[];
}

export interface RegexConversionResult {
  rules: Array<Record<string, unknown>>;
  converted: Array<{ name: string; mode: string }>;
  skipped: Array<{ name: string; reason: string }>;
  /** Converted, but with a behavioural difference the user should know about. */
  approximated: Array<{ name: string; reason: string }>;
}

/** Read ST `extensions.regex_scripts` into a neutral shape. */
export function readStRegexScripts(input: Record<string, unknown>): StRegexScript[] {
  const extensions = input.extensions;
  if (!isRecord(extensions)) return [];
  const scripts = extensions.regex_scripts;
  if (!Array.isArray(scripts)) return [];
  return scripts.flatMap((raw, index) => {
    if (!isRecord(raw)) return [];
    const find = text(raw.findRegex) || text(raw.find_regex);
    if (!find) return [];
    const unwrapped = unwrapRegexLiteral(find);
    return [{
      name: text(raw.scriptName) || text(raw.script_name) || `正则 ${index + 1}`,
      find: unwrapped.pattern,
      replace: text(raw.replaceString) || text(raw.replace_string),
      flags: unwrapped.flags,
      placements: Array.isArray(raw.placement)
        ? raw.placement.filter((value): value is number => typeof value === 'number')
        : [],
      disabled: raw.disabled === true,
      markdownOnly: raw.markdownOnly === true,
      promptOnly: raw.promptOnly === true,
      minDepth: optionalNumber(raw.minDepth),
      maxDepth: optionalNumber(raw.maxDepth),
      runOnEdit: typeof raw.runOnEdit === 'boolean' ? raw.runOnEdit : null,
      substituteRegex: optionalNumber(raw.substituteRegex) ?? 0,
      trimStrings: Array.isArray(raw.trimStrings) ? raw.trimStrings : [],
    }];
  });
}

/** ST stores patterns as `/body/flags`; RisuAI keeps pattern and flags apart. */
function unwrapRegexLiteral(value: string): { pattern: string; flags: string } {
  const match = /^\/([\s\S]*)\/([a-z]*)$/u.exec(value);
  if (!match) return { pattern: value, flags: '' };
  return { pattern: match[1], flags: match[2] };
}

/**
 * Convert ST regex scripts into the RisuAI preset `regex` array.
 *
 * RisuAI's `customscript` has no enabled flag (`script.type === mode` is the only
 * gate), so a disabled ST rule cannot be represented as inactive. Emitting it
 * would silently change behaviour, so disabled rules are skipped and reported —
 * their definition survives in the project's original JSON.
 */
export function convertStRegexScripts(scripts: readonly StRegexScript[]): RegexConversionResult {
  const rules: Array<Record<string, unknown>> = [];
  const converted: Array<{ name: string; mode: string }> = [];
  const skipped: Array<{ name: string; reason: string }> = [];
  const approximated: Array<{ name: string; reason: string }> = [];

  for (const script of scripts) {
    if (script.disabled) {
      skipped.push({ name: script.name, reason: 'SillyTavern 中该正则已禁用；RisuAI 正则没有启用开关，导入会改变行为，故跳过。' });
      continue;
    }
    const unsupported = [
      script.placements.some((placement) => !PLACEMENT_TO_MODE[placement]) ? '混合或不支持的 placement' : '',
      /\{\{|\$n|^@@/u.test(script.replace) || /\{\{/u.test(script.find) ? '动态宏或替换指令' : '',
    ].filter(Boolean);
    // Editor-time behaviour and depth limits are *approximated*, not dropped:
    // RisuAI re-runs its regex on every render, so `runOnEdit` (which ST defaults
    // to `true` on every rule) needs no equivalent, and a depth window is reported
    // as a caveat instead of discarding an otherwise working rule. Treating these
    // as blockers skipped **all 11** rules of a real preset and made the export
    // impossible, which defeated the point of converting at all.
    const approximations = [
      script.minDepth !== null && script.minDepth >= 0 ? `minDepth=${script.minDepth}` : '',
      script.maxDepth !== null && script.maxDepth >= 0 ? `maxDepth=${script.maxDepth}` : '',
      script.runOnEdit !== null ? 'runOnEdit' : '',
      script.substituteRegex !== 0 ? 'substituteRegex' : '',
      script.trimStrings.length ? 'trimStrings' : '',
    ].filter(Boolean);
    if (unsupported.length) {
      skipped.push({ name: script.name, reason: `不能等价映射 ${unsupported.join('、')}，保留源规则，未扩大作用范围。` });
      continue;
    }
    try { new RegExp(script.find, script.flags); } catch {
      skipped.push({ name: script.name, reason: '源正则语法或标志无效。' });
      continue;
    }
    const scoped = script.markdownOnly || script.promptOnly;
    const modes = scoped
      ? [...(script.markdownOnly ? ['editdisplay'] : []), ...(script.promptOnly ? ['editprocess'] : [])]
      : [...new Set(script.placements.map((placement) => PLACEMENT_TO_MODE[placement]).filter(Boolean))];
    if (!modes.length || !script.placements.length) {
      const shown = script.placements.length ? script.placements.join('/') : '未声明';
      skipped.push({ name: script.name, reason: `placement ${shown} 在 RisuAI 中没有对应的处理阶段（仅支持 1=输入、2=输出）。` });
      continue;
    }
    for (const mode of modes) {
      // Unknown/system context must fail closed instead of broadening to every message.
      const roles = [...new Set(script.placements)].map((placement) => placement === 1 ? 'user' : 'char');
      const condition = roles.length === 1 ? `{{equal::{{role}}::${roles[0]}}}` : '{{any::{{equal::{{role}}::user}}::{{equal::{{role}}::char}}}}';
      const pattern = scoped ? `{{#when::${condition}}}${script.find}{{:else}}(?!){{/when}}` : script.find;
      rules.push({
        comment: script.name,
        in: pattern,
        out: script.replace,
        type: mode,
        // RisuAI defaults absent flags to global and empty flags to Unicode.
        // d only adds match indices; string replacement keeps ST non-global/non-Unicode behavior.
        flag: `${script.flags || 'd'}${scoped ? '<cbs>' : ''}${script.replace.endsWith('>') ? '<no_end_nl>' : ''}`, ableFlag: true,
      });
      converted.push({ name: script.name, mode });
    }
    if (approximations.length) approximated.push({ name: script.name, reason: approximations.join('、') });
  }
  return { rules, converted, skipped, approximated };
}

export function convertStPreset(
  input: Record<string, unknown>,
  options: StPresetConversionOptions = {},
): StPresetConversion {
  const analysis = analyzeStPreset(input);
  const prompts = readStPresetPrompts(input);
  const byId = new Map(prompts.map((prompt) => [prompt.identifier, prompt]));
  const blockIndex = options.blockIndex ?? analysis.recommendedBlockIndex;
  const block = analysis.blocks.find((candidate) => candidate.index === blockIndex) ?? null;

  if (!Number.isInteger(blockIndex) || blockIndex < 0 || (analysis.blocks.length > 0 && !block)) {
    throw new Error('选择的 prompt_order 块不存在。');
  }
  const report: StPresetConversionReport = {
    schemaVersion: 1,
    targetRevision: RISU_PRESET_TARGET_REVISION,
    controlNamespace: options.controlNamespace || presetControlNamespace(input),
    covered: [], archived: [], issues: [],
    blockIndex,
    blockCharacterId: block?.characterId ?? null,
    name: options.name || analysis.name || 'SillyTavern 预设',
    toggleKeys: [],
    emitted: [],
    dropped: [],
    degraded: [],
    roleRemaps: [],
    promotedToAlwaysOn: [],
    regexConverted: [],
    regexSkipped: [],
    regexApproximated: [],
    unmappedFields: Object.keys(input).filter((field) => !MAPPED_FIELDS.has(field) && field !== 'extensions'),
    warnings: [...analysis.warnings],
  };

  const promptFields = new Set(['identifier', 'name', 'content', 'prompt', 'text', 'role', 'marker', 'system_prompt']);
  if (Array.isArray(input.prompts)) input.prompts.forEach((raw, index) => {
    if (!isRecord(raw)) {
      report.issues.push({ code: 'INVALID_PROMPT', path: `prompts[${index}]`, severity: 'error', message: '提示词定义不是对象。' });
      return;
    }
    for (const field of Object.keys(raw)) if (!promptFields.has(field)) report.unmappedFields.push(`prompts[${index}].${field}`);
    if (Array.isArray(raw.injection_trigger) && raw.injection_trigger.length) report.issues.push({ code: 'INJECTION_TRIGGER', path: `prompts[${index}].injection_trigger`, severity: 'error', message: '注入触发条件尚未迁移。' });
  });

  const context: ConversionContext = {
    report,
    activeMarkers: new Set((block?.entries ?? prompts.map((prompt) => ({ identifier: prompt.identifier, enabled: true })))
      .filter((entry) => entry.enabled && byId.get(entry.identifier)?.marker && !byId.get(entry.identifier)?.content.trim())
      .map((entry) => entry.identifier)),
    toggles: [],
    preserveOptional: options.preserveOptionalPrompts !== false,
  };

  for (const [carrier, included] of [['charDescription', ['scenario', 'charPersonality']], ['chatHistory', ['dialogueExamples']]] as const) {
    if (context.activeMarkers.has(carrier) && included.some((id) => !context.activeMarkers.has(id))) {
      report.issues.push({ code: 'COMPOSITE_MARKER', path: 'prompt_order', severity: 'warning', message: `${carrier} 原生块会同时包含 ${included.join(' / ')}，这些内容不能继续按 ST 独立开关控制。` });
    }
  }
  const template: Array<Record<string, unknown>> = [];
  const consumed = new Set<string>();

  const orderedEntries = block
    ? block.entries
    : prompts.map((prompt) => ({ identifier: prompt.identifier, enabled: true }));

  const sequence = [
    ...orderedEntries.flatMap((entry) => {
      const prompt = byId.get(entry.identifier);
      return prompt ? [{ identifier: prompt.identifier, content: prompt.content, enabled: entry.enabled && prompt.injectionPosition === 0 }] : [];
    }),
    ...prompts.filter((prompt) => !orderedEntries.some((entry) => entry.identifier === prompt.identifier))
      .map((prompt) => ({ identifier: prompt.identifier, content: prompt.content, enabled: false })),
  ];
  const compiled = options.compileVariables === false ? null : compileLiteralPresetVariables(sequence);
  if (compiled?.size) {
    for (const [identifier, content] of compiled) {
      const prompt = byId.get(identifier)!;
      report.degraded.push({ identifier, name: prompt.name, reason: '按请求内顺序静态展开无条件字面量变量；不保留聊天持久状态或变量供外部脚本读取。' });
      prompt.content = content;
    }
  }

  for (const entry of orderedEntries) {
    const prompt = byId.get(entry.identifier);
    if (!prompt) {
      report.dropped.push({ identifier: entry.identifier, name: entry.identifier, reason: 'prompt_order 引用了不存在的提示词。' });
      if (entry.enabled) report.issues.push({ code: 'MISSING_PROMPT', path: 'prompt_order', severity: 'error', message: `启用的提示词 ${entry.identifier} 没有定义。` });
      continue;
    }
    if (consumed.has(prompt.identifier)) {
      report.issues.push({ code: 'DUPLICATE_REFERENCE', path: 'prompt_order', severity: 'error', message: `重复引用 ${prompt.identifier}，不能无声去重后导出。` });
      continue;
    }
    consumed.add(prompt.identifier);
    if (compiled?.has(prompt.identifier) && !prompt.content.trim()) {
      report.covered.push({ identifier: prompt.identifier, name: prompt.name, reason: '字面量变量定义已展开到后续读取位置，无须单独发送。' });
      continue;
    }
    const item = convertPrompt(prompt, entry.enabled, 'block', context);
    if (item) template.push(item);
  }

  // Prompts no order block references have no position in ST either; append them
  // as default-off toggles so the library survives without changing live output.
  for (const prompt of prompts) {
    if (consumed.has(prompt.identifier)) continue;
    consumed.add(prompt.identifier);
    const item = convertPrompt(prompt, false, 'orphan', context);
    if (item) template.push(item);
  }

  const preset: Record<string, unknown> = {
    name: report.name,
    promptTemplate: template,
    customPromptTemplateToggle: context.toggles.join('\n'),
  };

  const temperature = optionalNumber(input.temperature);
  if (temperature !== null) preset.temperature = temperature * 100;
  const frequencyPenalty = optionalNumber(input.frequency_penalty);
  if (frequencyPenalty !== null) preset.frequencyPenalty = frequencyPenalty * 100;
  const presencePenalty = optionalNumber(input.presence_penalty);
  if (presencePenalty !== null) preset.PresensePenalty = presencePenalty * 0.7 * 100;
  const topP = optionalNumber(input.top_p);
  if (topP !== null) preset.top_p = topP;
  for (const [target, source] of [['top_k', 'top_k'], ['min_p', 'min_p'], ['top_a', 'top_a'], ['repetition_penalty', 'repetition_penalty']] as const) {
    const value = optionalNumber(input[source]);
    if (value !== null) preset[target] = value;
  }
  const maxContext = optionalNumber(input.openai_max_context);
  if (maxContext !== null) preset.maxContext = maxContext;
  const maxTokens = optionalNumber(input.openai_max_tokens);
  if (maxTokens !== null) preset.maxResponse = maxTokens;

  const prefill = text(input.assistant_prefill);
  if (prefill) {
    if (/\{\{\s*(?:set|get|add|inc|dec|flush)(?:global|temp)?var(?:::|\s)/iu.test(prefill)) report.issues.push({ code: 'VARIABLE_SEMANTICS', path: 'assistant_prefill', severity: 'error', message: '预填充包含未迁移的状态变量，不能直接导出。' });
    const unknown = [...prefill.matchAll(/\{\{\s*([A-Za-z_][\w-]*)(?=\s*(?:::|\}\}))/gu)].map((match) => match[1]).filter((name) => !AVAILABLE_TEXT_MACROS.has(name));
    if (unknown.length) report.issues.push({ code: 'UNVERIFIED_MACRO', path: 'assistant_prefill', severity: 'error', message: `预填充包含未验证宏：${[...new Set(unknown)].join('、')}。` });
    // Mirrors RisuAI's own ST importer so the prefill behaves identically there.
    template.push({ type: 'postEverything' });
    template.push({
      type: 'plain',
      type2: 'main',
      text: `{{#if {{prefill_supported}}}}${prefill}{{/if}}`,
      role: 'bot',
    });
  }

  if (context.toggles.length) report.warnings.push('可选开关首次使用默认关闭；重新导入相同源预设会沿用 RisuAI 已保存的同名开关状态。');
  report.toggleKeys = context.toggles.map((line) => line.split('=')[0] ?? line);

  if (report.promotedToAlwaysOn.length) {
    report.warnings.push(
      `有 ${report.promotedToAlwaysOn.length} 条 jailbreak/nsfw 提示词按“常驻”转换：RisuAI 的 jailbreak 类型默认被关闭，照搬会导致内容（含变量定义）不发送。`,
    );
  }

  if (byId.size !== prompts.length) report.issues.push({ code: 'DUPLICATE_ID', path: 'prompts', severity: 'error', message: '提示词 identifier 重复，无法可靠确定引用。' });
  const extensions = isRecord(input.extensions) ? input.extensions : null;
  if (extensions) report.unmappedFields.push(...Object.keys(extensions).filter((key) => key !== 'regex_scripts').map((key) => `extensions.${key}`));
  else if ('extensions' in input) report.unmappedFields.push('extensions');
  if (extensions && 'regex_scripts' in extensions) {
    if (!Array.isArray(extensions.regex_scripts)) report.issues.push({ code: 'INVALID_REGEX', path: 'extensions.regex_scripts', severity: 'error', message: '正则定义必须是数组。' });
    else extensions.regex_scripts.forEach((raw, index) => {
      if (!isRecord(raw) || !(text(raw.findRegex) || text(raw.find_regex))) report.issues.push({ code: 'INVALID_REGEX', path: `extensions.regex_scripts[${index}]`, severity: 'error', message: '正则规则缺少有效的匹配表达式，原始定义仅存档。' });
    });
  }
  const regexScripts = readStRegexScripts(input);
  if (regexScripts.length) {
    const regex = convertStRegexScripts(regexScripts);
    if (regex.rules.length) {
      preset.regex = regex.rules;
      report.regexConverted = regex.converted;
    }
    report.regexSkipped = regex.skipped;
    report.regexApproximated = regex.approximated;
    if (regex.approximated.length) {
      report.warnings.push(
        `有 ${regex.approximated.length} 条正则已转换，但编辑时机或深度窗口与 SillyTavern 不同：`
        + regex.approximated.map((item) => `${item.name}（${item.reason}）`).join('、'),
      );
    }
    if (regex.skipped.some((item) => !item.reason.startsWith('SillyTavern 中该正则已禁用'))) {
      report.issues.push({ code: 'REGEX_SEMANTICS', path: 'extensions.regex_scripts', severity: 'error', message: '存在不能等价转换的启用正则；具体范围与原因见正则报告。' });
    }
    if (regex.skipped.length) {
      report.warnings.push(`有 ${regex.skipped.length} 条 SillyTavern 正则未转换，已记录原因。`);
    }
    if (regex.converted.length) {
      report.warnings.push(`已将 ${regex.converted.length} 条正则转换为 RisuAI 预设正则，建议在 RisuAI 中复核。`);
    }
  }

  if (report.dropped.length) report.warnings.push(`有 ${report.dropped.length} 条提示词未生成目标条目，已记录空内容或无法映射的原因。`);
  if (report.degraded.length) report.warnings.push(`有 ${report.degraded.length} 条提示词语义降级，请在 RisuAI 中复核。`);
  if (report.unmappedFields.length) report.warnings.push(`有 ${report.unmappedFields.length} 个 ST 字段尚未映射；源值保留在完整存档中，不代表目标一定没有对应能力。`);

  for (const issue of report.issues) report.warnings.push(issue.message);
  return { preset, report };
}
