import { textAttributes, escapeTextAttribute, MARKUP_TOKEN_SOURCE } from './text-attributes.js';
import { createHash } from 'node:crypto';
import { parse } from 'luaparse';
import { parseProtocols, protocolMatchesForText, type ProtocolSchemaRule } from '../protocol/protocol.js';

export type ScopePreset = 'core' | 'standard' | 'visible-scripts' | 'all-visible' | 'all' | 'lua-only';
export type SegmentCategory = 'core' | 'lorebook' | 'greeting' | 'name' | 'script-ui' | 'background-ui' | 'resource-json';
export type SegmentKind = 'field' | 'button' | 'attribute' | 'text-node' | 'runtime-message'
  | 'lua-string' | 'lua-formatted' | 'lua-long-string' | 'lua-language'
  | 'lua-button' | 'lua-attribute' | 'lua-text-node' | 'structured-text' | 'protocol-field'
  | 'lorebook-key-alias' | 'resource-json';

export interface ScannedSegment {
  path: Array<string | number>;
  pathLabel: string;
  category: SegmentCategory;
  sourceText: string;
  start: number | null;
  end: number | null;
  risk: 'low' | 'medium' | 'high';
  kind: SegmentKind;
  protocolDelimiter?: string | null;
}

export interface ApplicableSegment {
  id?: string;
  pathLabel?: string;
  pathJson: string;
  sourceText?: string;
  start: number | null;
  end: number | null;
  translatedText: string | null;
  finalText: string | null;
  reviewStatus: string;
  kind?: ScannedSegment['kind'];
}

export interface RisuControlReference {
  literal: string;
  kind: 'regex' | 'lua';
  /** Replacement template for a Risu regex rule, when the rule has one. */
  out?: string;
  embedded?: boolean;
  /** Runtime-only display formatting rules cannot be proven from static card text. */
  dynamicDisplay?: boolean;
  /** Runtime post-processing rules run on generated chat output, not card text. */
  runtimePostprocess?: boolean;
  path: Array<string | number>;
  pathLabel: string;
  pattern: string;
}

export interface RisuControlIssue {
  pathLabel: string;
  message: string;
  code?: 'REGEX_MATCH_COUNT_CHANGED';
  pattern?: string;
  originalMatches?: number;
  draftMatches?: number;
}

export interface RisuRegexValidationOverride {
  pattern: string;
  originalMatchCount: number;
  draftMatchCount: number;
  confirmedAt: string;
}

export type RisuRegexValidationOverrides = Readonly<Record<string, RisuRegexValidationOverride>>;

export function isRegexValidationOverrideActive(
  overrides: RisuRegexValidationOverrides | undefined,
  pathLabel: string,
  pattern: string,
  originalMatchCount: number,
  draftMatchCount: number,
): boolean {
  const override = overrides?.[pathLabel];
  return Boolean(
    override
    && override.pattern === pattern
    && override.originalMatchCount === originalMatchCount
    && override.draftMatchCount === draftMatchCount,
  );
}

/** A model-approved, additive set of literal alternatives for one regex input. */
export interface RisuRegexAlternativeProposal {
  pathLabel: string;
  anchorAlternatives: string[];
  additions: string[];
  /** Coverage-stage candidate that may adjust target-language structure. */
  pattern?: string;
}

export interface RisuRegexAlternativeChange {
  pathLabel: string;
  addedAlternatives: string[];
}

/** Return the first top-level non-capturing alternation used by a regex rule. */
export function extractRegexAlternatives(pattern: string): string[] {
  for (const group of findNonCapturingGroups(pattern)) {
    const alternatives = splitTopLevelRegexAlternatives(pattern.slice(group.bodyStart, group.end));
    if (alternatives.length > 1) return alternatives;
  }
  return [];
}

interface RisuRegexInput {
  path: Array<string | number>;
  pathLabel: string;
  pattern: string;
  type: string;
  out: string;
  dynamicDisplay: boolean;
  runtimePostprocess: boolean;
}

const CORE_KEYS = new Set([
  'desc',
  'description',
  'personality',
  'scenario',
  'firstMessage',
  'first_mes',
  'exampleMessage',
  'mes_example',
  'creatorNotes',
  'creator_notes',
  'systemPrompt',
  'system_prompt',
  'replaceGlobalNote',
  'post_history_instructions',
  'additionalText',
]);

const GREETING_KEYS = new Set([
  'alternateGreetings',
  'alternate_greetings',
  'group_only_greetings',
]);

const LARGE_FIELD_THRESHOLD = 8_000;
const STRUCTURED_TEXT_CHUNK_SIZE = 3_000;

const SKIP_KEYS = new Set([
  'chaId',
  'id',
  'creator',
  'character_version',
  'version',
  'source',
  'tags',
  'assets',
  'chats',
  'chat',
  'chatPage',
  'sdData',
  'vits',
]);

export function cardHash(card: unknown): string {
  return createHash('sha256').update(JSON.stringify(card)).digest('hex');
}

export function cardName(card: Record<string, unknown>): string {
  const data = asRecord(card.data);
  return firstText(card.name, data.name, '未命名卡片');
}

export function cardExportName(
  card: Record<string, unknown>,
  originalName: string,
  preferredTranslatedName = '',
): string {
  const translatedName = preferredTranslatedName.trim() || cardName(card);
  const normalizedOriginal = originalName.trim();
  if (!normalizedOriginal || translatedName === normalizedOriginal) return translatedName;
  if (translatedName.endsWith(` - ${normalizedOriginal}`)) return translatedName;
  return `${translatedName} - ${normalizedOriginal}`;
}

export function bilingualModuleName(translatedName: string, originalName: string): string {
  const translated = translatedName.trim();
  const original = originalName.trim();
  if (!translated) return original;
  if (!original || translated === original) return translated || original;
  if (original.startsWith(`${translated} - `) || translated.endsWith(` - ${original}`)) {
    return original.startsWith(`${translated} - `) ? original : translated;
  }
  return `${translated} - ${original}`;
}

export function scanCard(
  card: Record<string, unknown>,
  scope: ScopePreset,
  controlLiterals: readonly string[] = [],
  protocolSchemas: readonly ProtocolSchemaRule[] = [],
  sourceLanguage = 'auto',
): ScannedSegment[] {
  if (scope === 'lua-only') return [];
  const segments: ScannedSegment[] = [];
  const seen = new Set<string>();

  const add = (segment: ScannedSegment) => {
    if (isControlLiteralSegment(segment.sourceText, controlLiterals)) return;
    if (!likelyNeedsTranslation(segment.sourceText)
      && !(segment.kind === 'protocol-field' && likelyProtocolValueNeedsTranslation(segment.sourceText))) return;
    const key = `${segment.pathLabel}:${segment.start ?? 'field'}:${segment.end ?? 'field'}`;
    if (seen.has(key)) return;
    seen.add(key);
    segments.push(segment);
  };

  const addField = (
    path: Array<string | number>,
    source: string,
    category: SegmentCategory,
    risk: ScannedSegment['risk'],
  ) => {
    const baseSegments = source.length >= LARGE_FIELD_THRESHOLD
      ? extractStructuredFieldText(source, path, category, risk)
      : [fieldSegment(path, source, category, risk)];
    const extracted = protocolAwareSegments(source, path, category, risk, splitTextAttributes(source, path, category, risk, baseSegments), protocolSchemas);
    extracted.forEach(add);
  };

  const visit = (value: unknown, path: Array<string | number>) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        const entryPath = [...path, index];
        if (typeof entry === 'string' && isGreetingPath(entryPath)) {
          if (scope !== 'core') addField(entryPath, entry, 'greeting', 'low');
          return;
        }
        visit(entry, entryPath);
      });
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;

    for (const [key, child] of Object.entries(record)) {
      if (SKIP_KEYS.has(key)) continue;
      const nextPath = [...path, key];
      const label = pathLabel(nextPath);

      if (
        scope !== 'core'
        && Array.isArray(child)
        && isLorebookKeywordPath(nextPath)
        && !isAlwaysActiveLorebookEntry(record)
        && !isRegexLorebookEntry(record)
      ) {
        child.forEach((keyword, index) => {
          if (typeof keyword !== 'string' || !keywordMayNeedAlias(keyword, sourceLanguage)) return;
          add({
            path: [...nextPath, index],
            pathLabel: pathLabel([...nextPath, index]),
            category: 'lorebook',
            sourceText: keyword,
            start: null,
            end: null,
            risk: 'medium',
            kind: 'lorebook-key-alias',
          });
        });
        continue;
      }

      if (typeof child !== 'string') {
        visit(child, nextPath);
        continue;
      }

      if (isBackgroundPath(nextPath)) {
        if (scope === 'all-visible' || scope === 'all') {
          extractVisibleText(child, nextPath, 'background-ui').forEach(add);
        }
        continue;
      }

      if (isScriptPath(nextPath)) {
        if (scope === 'visible-scripts' || scope === 'all-visible' || scope === 'all') {
          extractVisibleText(child, nextPath, 'script-ui').forEach(add);
        }
        continue;
      }

      if (CORE_KEYS.has(key)) {
        addField(nextPath, child, 'core', 'low');
        continue;
      }

      if (isGreetingPath(nextPath)) {
        if (scope !== 'core') addField(nextPath, child, 'greeting', 'low');
        continue;
      }

      if (isLorebookPath(nextPath) && (key === 'content' || key === 'comment' || key === 'name')) {
        if (scope !== 'core') addField(nextPath, child, key === 'name' ? 'name' : 'lorebook', 'medium');
        continue;
      }

      if (key === 'name' && scope !== 'core') {
        addField(nextPath, child, 'name', 'low');
        continue;
      }

      if (scope === 'all' && !isGenericProtectedPath(nextPath, key)) {
        addField(nextPath, child, 'core', 'medium');
      }
    }
  };

  visit(card, []);
  return segments;
}

export function scanRisuModule(module: Record<string, unknown>, scope: ScopePreset, protocolSchemas: readonly ProtocolSchemaRule[] = []): ScannedSegment[] {
  const segments: ScannedSegment[] = [];
  const seen = new Set<string>();
  const controlLiterals = risuControlLiterals(module);
  const add = (segment: ScannedSegment) => {
    if (segment.kind !== 'lua-language' && isControlLiteralSegment(segment.sourceText, controlLiterals)) return;
    if (!likelyNeedsTranslation(segment.sourceText)
      && !(segment.kind === 'protocol-field' && likelyProtocolValueNeedsTranslation(segment.sourceText))) return;
    const key = `${segment.pathLabel}:${segment.start}:${segment.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    segments.push(segment);
  };

  if (scope !== 'lua-only' && typeof module.name === 'string') {
    add(fieldSegment(['$module', 'name'], module.name, 'name', 'low'));
  }
  // A namespace is an internal runtime key, not ordinary card copy. It is
  // handled by Lua management: retain it by default, or explicitly create a
  // review item only when the author confirms it is user-visible.
  if (scope !== 'core' && scope !== 'lua-only' && Array.isArray(module.lorebook)) {
    module.lorebook.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
      for (const key of ['comment', 'name', 'content']) {
        const value = (entry as Record<string, unknown>)[key];
        if (typeof value !== 'string') continue;
        const path = ['$module', 'lorebook', index, key];
        const category: SegmentCategory = key === 'content' ? 'lorebook' : 'name';
        const extracted = value.length >= LARGE_FIELD_THRESHOLD
          ? extractStructuredFieldText(value, path, category, 'medium')
          : [fieldSegment(path, value, category, 'medium')];
        protocolAwareSegments(value, path, category, 'medium',
          splitTextAttributes(value, path, category, 'medium', extracted), protocolSchemas).forEach(add);
      }
    });
  }
  if (scope !== 'visible-scripts' && scope !== 'all-visible' && scope !== 'all' && scope !== 'lua-only') return segments;

  const visit = (value: unknown, path: Array<string | number>) => {
    if (typeof value === 'string') {
      const luaCode = isLuaModuleCodePath(path);
      if (scope === 'lua-only' && !luaCode) return;
      const background = isBackgroundPath(path);
      const script = isScriptPath(path);
      // RisuAI trigger copy. `trigger` makes `isGenericProtectedPath()` reject the
      // generic branch below, and the message usually carries no markup for
      // `extractVisibleText()` to find, so without this branch player-visible text
      // is dropped at every scope. Only allowlisted effect fields qualify: a bare
      // `value` on any other effect type is runtime data, not copy.
      if (isRisuTriggerEffectFieldPath(path) && !luaCode) {
        if (risuTriggerEffectCopyField(module, path)) extractRisuTriggerCopy(value, path).forEach(add);
        return;
      }
      if (scope === 'all' && !luaCode && !background && !script
        && !isGenericProtectedPath(path, String(path.at(-1) ?? ''))) {
        add(fieldSegment(path, value, 'core', 'medium'));
        return;
      }
      if (!background || scope === 'all-visible' || scope === 'all' || scope === 'lua-only') {
        const category = background ? 'background-ui' : 'script-ui';
        const extracted = luaCode
          ? extractLuaCodeText(value, path, category, scope === 'all-visible' || scope === 'all' || scope === 'lua-only')
          : extractVisibleText(value, path, category);
        (luaCode ? addSourceLocations(value, extracted) : extracted).forEach(add);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (path.length === 1 && path[0] === '$module' && key === 'name') continue;
      if (path.length === 1 && path[0] === '$module' && key === 'lorebook') continue;
      // Namespace is an internal runtime key. Lua management owns its explicit
      // preserve-or-review decision, so the generic text scan must not create
      // a second, opaque translation candidate for it.
      if (path.length === 1 && path[0] === '$module' && key === 'namespace') continue;
      visit(child, [...path, key]);
    }
  };

  visit(module, ['$module']);
  return segments;
}

/**
 * Scan a SillyTavern chat-completion preset.
 *
 * `scanCard` cannot be used here: a preset also carries `role`, `identifier`,
 * `system_prompt`, `injection_*` and sampler fields whose values are runtime
 * keywords ("user", "main", "disabled"), and the generic walker would offer them
 * for translation. Rewriting those breaks the preset, so this scanner uses an
 * explicit allowlist of the only two fields that hold user-visible copy.
 */
export function scanStPreset(preset: Record<string, unknown>, scope: ScopePreset): ScannedSegment[] {
  if (scope === 'lua-only') return [];
  const segments: ScannedSegment[] = [];
  const seen = new Set<string>();
  const add = (segment: ScannedSegment) => {
    if (!likelyNeedsTranslation(segment.sourceText)) return;
    if (seen.has(segment.pathLabel)) return;
    seen.add(segment.pathLabel);
    segments.push(segment);
  };

  const addField = (
    path: Array<string | number>,
    value: string,
    category: SegmentCategory,
  ) => {
    const extracted = value.length >= LARGE_FIELD_THRESHOLD
      ? extractStructuredFieldText(value, path, category, 'low')
      : [fieldSegment(path, value, category, 'low')];
    extracted.forEach(add);
  };

  if (scope !== 'core' && typeof preset.name === 'string') {
    addField(['name'], preset.name, 'name');
  }

  const prompts = Array.isArray(preset.prompts) ? preset.prompts : [];
  prompts.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const record = entry as Record<string, unknown>;
    if (typeof record.content === 'string' && record.content.length) {
      addField(['prompts', index, 'content'], record.content, 'core');
    }
    // Names are display-only, but they also become the RisuAI toggle labels, so
    // translating them is what makes the generated switch panel readable.
    if (typeof record.name === 'string') {
      addField(['prompts', index, 'name'], record.name, 'name');
    }
  });

  return segments;
}

export function risuRegexControlLiterals(module: Record<string, unknown>): string[] {
  return uniqueControlLiterals(risuControlReferences(module).filter((reference) => reference.kind === 'regex'));
}

export function risuControlLiterals(module: Record<string, unknown>): string[] {
  return uniqueControlLiterals(risuControlReferences(module));
}

export function risuTranslationControlFragments(module: Record<string, unknown>): string[] {
  return uniqueControlLiterals(risuControlReferences(module).filter((reference) => (
    reference.kind === 'regex' || reference.embedded
  )));
}

export function risuControlReferences(module: Record<string, unknown>): RisuControlReference[] {
  const references: RisuControlReference[] = [];
  const seen = new Set<string>();
  const add = (reference: RisuControlReference) => {
    const key = JSON.stringify([reference.kind, reference.path, reference.literal]);
    if (!reference.literal || seen.has(key)) return;
    seen.add(key);
    references.push(reference);
  };
  const visit = (value: unknown, path: Array<string | number>) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const entry = value as Record<string, unknown>;
    if (typeof entry.in === 'string' && typeof entry.out === 'string') {
      const literal = literalRegexSource(entry.in);
      if (literal) {
        const inputPath = [...path, 'in'];
        add({
          literal,
          kind: 'regex',
          path: inputPath,
          pathLabel: pathLabel(['$module', ...inputPath]),
          pattern: entry.in,
          out: entry.out,
          dynamicDisplay: isRisuDisplayFormattingRegexRule(entry),
          runtimePostprocess: isRisuOutputPostprocessRegexRule(entry),
        });
      }
    }
    for (const [key, child] of Object.entries(entry)) {
      const childPath = [...path, key];
      if (typeof child === 'string' && isLuaModuleCodePath(childPath)) {
        for (const control of luaControlStrings(child)) {
          const reference = {
            literal: control.literal,
            kind: 'lua',
            path: childPath,
            pathLabel: pathLabel(['$module', ...childPath]),
            pattern: control.context,
          } satisfies RisuControlReference;
          add(reference);
          if (control.context.endsWith('模式')) {
            for (const literal of luaPatternProtocolPrefixes(control.literal)) {
              add({ ...reference, literal, embedded: true, pattern: `${control.context}：${control.literal}` });
            }
          }
        }
      } else {
        visit(child, childPath);
      }
    }
  };
  visit(module, []);
  return references;
}

export function controlReferencesInText(
  text: string,
  references: readonly RisuControlReference[],
  segmentPath: readonly (string | number)[] | null = null,
  segmentKind = '',
): RisuControlReference[] {
  // Lorebook aliases are additive: the referenced source keyword remains in place.
  if (segmentKind === 'lorebook-key-alias') return [];
  return references.filter((reference) => {
    if (reference.kind === 'regex' || reference.embedded) return text.includes(reference.literal);
    return Boolean(
      segmentKind !== 'lua-language'
      && text.trim() === reference.literal
      && segmentPath
      && JSON.stringify(segmentPath) === JSON.stringify(['$module', ...reference.path]),
    );
  });
}

export function validateRisuControlReferences(
  originalCard: Record<string, unknown>,
  draftCard: Record<string, unknown>,
  originalModule: Record<string, unknown>,
  draftModule: Record<string, unknown>,
  regexValidationOverrides: RisuRegexValidationOverrides = {},
): RisuControlIssue[] {
  const issues: RisuControlIssue[] = [];
  const references = risuControlReferences(originalModule);
  const reported = new Set<string>();
  const report = (issue: RisuControlIssue) => {
    const key = `${issue.pathLabel}:${issue.message}`;
    if (reported.has(key)) return;
    reported.add(key);
    issues.push(issue);
  };

  for (const reference of references) {
    const originalValue = String(getAt(originalModule, reference.path) ?? '');
    const draftValue = String(getAt(draftModule, reference.path) ?? '');
    if (reference.kind === 'regex' && !reference.dynamicDisplay && !reference.runtimePostprocess && originalValue !== draftValue
      && !isAdditiveRegexExtension(originalValue, draftValue)
      && !isSafeRegexLanguageAdaptation(originalValue, draftValue, originalCard)) {
      report({ pathLabel: reference.pathLabel, message: `正则触发规则已改动：${reference.literal}` });
    }
  }

  // Capture-group regex rules are not literal control references, but their
  // input pattern is still executable structure. Runtime display rules are
  // checked structurally; static card cardinality applies to other rules.
  const originalRegexInputs = collectRisuRegexInputs(originalModule);
  const draftRegexInputs = new Map(collectRisuRegexInputs(draftModule).map((entry) => [JSON.stringify(entry.path), entry]));
  for (const reference of originalRegexInputs) {
    const draftInput = draftRegexInputs.get(JSON.stringify(reference.path));
    const draftPattern = draftInput?.pattern;
    if (reference.dynamicDisplay) {
      if (!draftInput || !isSafeRisuDisplayFormattingInputChange(reference, draftInput)) {
        report({
          pathLabel: reference.pathLabel,
          message: '动态展示正则只能保留 editdisplay 类型、捕获组和仅由捕获组/换行组成的替换模板。',
        });
      }
      // editdisplay runs when Risu renders message text. Static card strings
      // are diagnostic samples only, so Chinese no-space writing must not be
      // blocked by a source/draft cardinality comparison.
      continue;
    }
    if (reference.runtimePostprocess) {
      if (!draftInput || !isSafeRisuOutputPostprocessInputChange(reference, draftInput)) {
        report({
          pathLabel: reference.pathLabel,
          message: '聊天后处理正则必须保留 editoutput 类型、有效匹配正则和有效替换输出。',
        });
      }
      // editoutput runs against generated chat output. Static card counts are
      // useful diagnostics only and must not block a valid runtime rule.
      continue;
    }
    const languageAdapted = draftPattern !== reference.pattern
      && !isAdditiveRegexExtension(reference.pattern, draftPattern || '')
      && isSafeRegexLanguageAdaptation(reference.pattern, draftPattern || '', originalCard);
    if (draftPattern !== reference.pattern && !isAdditiveRegexExtension(reference.pattern, draftPattern || '')
      && !languageAdapted) {
      report({ pathLabel: reference.pathLabel, message: '正则输入模式已改动，协议外壳必须保留原格式。' });
      continue;
    }
    if (references.some((candidate) => candidate.kind === 'regex'
      && JSON.stringify(candidate.path) === JSON.stringify(reference.path))) continue;

    // Rules such as `$` append UI without consuming card text. Their total
    // match count is the number of strings in the card, so adding a safe
    // lorebook alias legitimately changes it even though the rule is intact.
    if (isZeroWidthCardinalityTrigger(reference.pattern)) continue;

    const originalMatches = countRegexMatchesInStrings(originalCard, reference.pattern);
    const draftMatches = countRegexMatchesInStrings(draftCard, languageAdapted ? (draftPattern || reference.pattern) : reference.pattern);
    if (originalMatches > 0 && draftMatches !== originalMatches) {
      const effectivePattern = languageAdapted ? (draftPattern || reference.pattern) : reference.pattern;
      const overrideActive = isRegexValidationOverrideActive(
        regexValidationOverrides, reference.pathLabel, effectivePattern, originalMatches, draftMatches,
      ) || Boolean(
        draftPattern
        && isAdditiveRegexExtension(reference.pattern, draftPattern)
        && isRegexValidationOverrideActive(regexValidationOverrides, reference.pathLabel, draftPattern, originalMatches, draftMatches),
      );
      if (overrideActive) continue;
      report({
        pathLabel: reference.pathLabel,
        code: 'REGEX_MATCH_COUNT_CHANGED',
        pattern: reference.pattern,
        originalMatches,
        draftMatches,
        message: `正则协议匹配数量由 ${originalMatches} 变为 ${draftMatches}，请保留键名、分隔符和字段顺序。`,
      });
    }
  }

  for (const literal of uniqueControlLiterals(references.filter((reference) => reference.kind === 'regex'))) {
    const expected = countOccurrencesInStrings(originalCard, literal);
    if (!expected) continue;
    const actual = countOccurrencesInStrings(draftCard, literal);
    if (actual !== expected) {
      report({ pathLabel: '卡片正文', message: `脚本触发标记 ${literal} 数量由 ${expected} 变为 ${actual}` });
    }
  }

  for (const literal of uniqueControlLiterals(references.filter((reference) => reference.kind === 'lua' && reference.embedded))) {
    const expected = countOccurrencesInStrings(originalCard, literal) + countOccurrencesInStrings(originalModule, literal);
    if (!expected) continue;
    const actual = countOccurrencesInStrings(draftCard, literal) + countOccurrencesInStrings(draftModule, literal);
    if (actual !== expected) {
      report({ pathLabel: 'Lua 协议', message: `Lua 控制前缀 ${literal} 数量由 ${expected} 变为 ${actual}` });
    }
  }

  const originalButtons = collectButtonActions(originalModule);
  const draftButtons = collectButtonActions(draftModule);
  for (const [pathJson, actions] of originalButtons) {
    const candidate = draftButtons.get(pathJson) ?? [];
    if (JSON.stringify(actions) !== JSON.stringify(candidate)) {
      report({
        pathLabel: pathLabel(['$module', ...(JSON.parse(pathJson) as Array<string | number>)]),
        message: '按钮动作 ID 或顺序发生变化',
      });
    }
  }
  return issues;
}

export function findRisuRegexAffectedSegmentIds(
  pattern: string,
  segments: readonly ApplicableSegment[],
): string[] {
  const affected: string[] = [];
  for (const segment of segments) {
    if (!segment.id || segment.reviewStatus !== 'approved') continue;
    const translation = segment.finalText?.trim() || segment.translatedText?.trim();
    if (!translation || typeof segment.sourceText !== 'string') continue;
    if (countRegexMatchesInStrings(segment.sourceText, pattern) !== countRegexMatchesInStrings(translation, pattern)) {
      affected.push(segment.id);
    }
  }
  return affected;
}

/**
 * Apply only validated literal alternatives to a regex rule. The original
 * alternatives and ordering remain untouched; malformed or ambiguous model
 * output is ignored.
 */
export function applyRisuRegexAlternativeProposals(
  module: Record<string, unknown>,
  proposals: readonly RisuRegexAlternativeProposal[],
): RisuRegexAlternativeChange[] {
  if (!proposals.length || !Array.isArray(module.regex)) return [];
  const byPath = new Map<string, RisuRegexAlternativeProposal>();
  for (const proposal of proposals) {
    if (!proposal || typeof proposal.pathLabel !== 'string') continue;
    if (!byPath.has(proposal.pathLabel)) byPath.set(proposal.pathLabel, proposal);
  }
  const changes: RisuRegexAlternativeChange[] = [];
  module.regex.forEach((rawEntry, index) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return;
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.in !== 'string') return;
    const pathLabelValue = pathLabel(['$module', 'regex', index, 'in']);
    const proposal = byPath.get(pathLabelValue);
    if (!proposal) return;
    const result = appendRegexLiteralAlternatives(entry.in, proposal.anchorAlternatives, proposal.additions);
    if (!result.added.length) return;
    entry.in = result.pattern;
    changes.push({ pathLabel: pathLabelValue, addedAlternatives: result.added });
  });
  return changes;
}

/** Apply complete patterns returned by the full-coverage language check. */
export function applyRisuRegexCoverageProposals(
  module: Record<string, unknown>,
  proposals: readonly RisuRegexAlternativeProposal[],
  originalCard?: Record<string, unknown>,
): RisuRegexAlternativeChange[] {
  if (!Array.isArray(module.regex)) return [];
  const byPath = new Map(proposals.filter((proposal) => typeof proposal?.pattern === 'string').map((proposal) => [proposal.pathLabel, proposal]));
  const changes: RisuRegexAlternativeChange[] = [];
  module.regex.forEach((rawEntry, index) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return;
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.in !== 'string') return;
    // Runtime rules (`editdisplay` / `editoutput`) execute on generated chat text, so a
    // full-pattern replacement cannot be proven safe from static card strings: the
    // coverage guard only measures static hits and happily accepts a quantifier change
    // that breaks rendering. These rules may still gain additive `|literal` alternatives
    // through `applyRisuRegexAlternativeProposals`; only the whole-pattern rewrite is refused.
    if (isRuntimeScopeRegexRule(entry)) return;
    const pathLabelValue = pathLabel(['$module', 'regex', index, 'in']);
    const proposal = byPath.get(pathLabelValue);
    if (!proposal?.pattern || proposal.pattern === entry.in) return;
    if (!isSafeRegexLanguageAdaptation(entry.in, proposal.pattern, originalCard ?? {})) return;
    // A later complete-pattern proposal must retain aliases already added by
    // the translation-stage pass, otherwise the two stages can regress each
    // other when the Lua page is run repeatedly.
    const currentAlternatives = extractRegexAlternatives(entry.in);
    const candidateAlternatives = extractRegexAlternatives(proposal.pattern);
    if (currentAlternatives.length && !currentAlternatives.every((value) => candidateAlternatives.includes(value))) return;
    entry.in = proposal.pattern;
    changes.push({ pathLabel: pathLabelValue, addedAlternatives: [] });
  });
  return changes;
}

function appendRegexLiteralAlternatives(
  pattern: string,
  anchors: readonly string[],
  additions: readonly string[],
): { pattern: string; added: string[] } {
  const cleanAnchors = [...new Set(anchors.map((value) => value.trim()).filter(Boolean))];
  const cleanAdditions = [...new Set(additions.map((value) => value.trim()).filter(isSafeRegexLiteral))];
  if (!cleanAnchors.length || !cleanAdditions.length) return { pattern, added: [] };
  for (const group of findNonCapturingGroups(pattern)) {
    const body = pattern.slice(group.bodyStart, group.end);
    const alternatives = splitTopLevelRegexAlternatives(body);
    // A focused proposal may cite only the relevant subset of a large group.
    if (!cleanAnchors.some((anchor) => alternatives.includes(anchor))) continue;
    const present = new Set(alternatives);
    const added = cleanAdditions.filter((value) => !present.has(value));
    if (!added.length) return { pattern, added: [] };
    const nextBody = `${body}|${added.map(escapeRegExp).join('|')}`;
    return { pattern: `${pattern.slice(0, group.bodyStart)}${nextBody}${pattern.slice(group.end)}`, added };
  }
  return { pattern, added: [] };
}

function isAdditiveRegexExtension(original: string, draft: string): boolean {
  if (original === draft) return true;
  const allowedClosings = new Set(findNonCapturingGroups(draft).map((group) => group.end));
  let originalCursor = 0;
  let draftCursor = 0;
  let inserted = false;
  while (originalCursor < original.length) {
    if (original[originalCursor] === draft[draftCursor]) {
      originalCursor += 1;
      draftCursor += 1;
      continue;
    }
    if (draft[draftCursor] !== '|') return false;
    const close = draft.indexOf(')', draftCursor + 1);
    if (close < 0 || !allowedClosings.has(close)) return false;
    const additions = draft.slice(draftCursor + 1, close).split('|');
    if (!additions.length || additions.some((value) => !isSafeRegexEncodedLiteral(value))) return false;
    inserted = true;
    draftCursor = close;
  }
  return inserted && draftCursor === draft.length;
}

function isSafeRegexLanguageAdaptation(original: string, candidate: string, originalCard: Record<string, unknown>): boolean {
  if (!candidate) return false;
  if (isZeroWidthCardinalityTrigger(original)) return false;
  try { new RegExp(candidate); } catch { return false; }
  if (countCapturingGroups(original) !== countCapturingGroups(candidate)) return false;
  const originalMatches = countRegexMatchesInStrings(originalCard, original);
  if (originalMatches <= 0) return false;
  if (countRegexMatchesInStrings(originalCard, candidate) < originalMatches) return false;
  return true;
}

export function isRisuDisplayFormattingRegexRule(rule: Record<string, unknown> | null | undefined): boolean {
  const pattern = typeof rule?.in === 'string' ? rule.in : '';
  const output = typeof rule?.out === 'string' ? rule.out : '';
  return String(rule?.type ?? '').trim().toLowerCase() === 'editdisplay'
    && Boolean(pattern)
    && isDisplayFormattingReplacement(output, countCapturingGroups(pattern));
}

/** Risu rules that post-process generated chat output after the model reply. */
export function isRisuOutputPostprocessRegexRule(rule: Record<string, unknown> | null | undefined): boolean {
  const pattern = typeof rule?.in === 'string' ? rule.in : '';
  return String(rule?.type ?? '').trim().toLowerCase() === 'editoutput'
    && Boolean(pattern)
    && typeof rule?.out === 'string';
}

/**
 * Rules that Risu executes against generated chat text rather than against card copy.
 *
 * Their behaviour cannot be measured from static card strings, so a rewrite that keeps
 * the capture groups, the output template and the static hit count identical can still
 * change what the rule does at render time. `[ \t]+` -> `[ \t]*` is exactly such a change:
 * it leaves every static match untouched but starts swallowing the quote inside an
 * `<img="...">` tag, which silently breaks every downstream asset-display rule.
 *
 * Only additive alternations (`|literal`) are safe for these rules; see
 * `applyRisuRegexCoverageProposals`.
 */
export function isRuntimeScopeRegexRule(rule: Record<string, unknown> | null | undefined): boolean {
  return isRisuDisplayFormattingRegexRule(rule) || isRisuOutputPostprocessRegexRule(rule);
}

/** A structural change inside a runtime regex that static hit counts cannot reveal. */
export interface RisuRegexStructuralDrift {
  pathLabel: string;
  kind: 'quantifier' | 'character-class' | 'escape' | 'assertion';
  message: string;
  removed: string[];
  added: string[];
}

function collectRisuRegexInputRules(
  module: Record<string, unknown>,
  rootLabel = '$module',
): Array<{ rule: Record<string, unknown>; pathLabel: string }> {
  const rules: Array<{ rule: Record<string, unknown>; pathLabel: string }> = [];
  const visit = (value: unknown, path: Array<string | number>) => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.in === 'string' && typeof record.out === 'string') {
      rules.push({ rule: record, pathLabel: pathLabel([rootLabel, ...path, 'in']) });
    }
    for (const [key, child] of Object.entries(record)) visit(child, [...path, key]);
  };
  visit(module, []);
  return rules;
}

/**
 * Build a token fingerprint for one regular expression.
 *
 * The point is to see the things that decide *which characters a pattern consumes*,
 * because those are invisible to a static hit count: `[ \t]+` and `[ \t]*` score
 * identically against every card string yet behave differently at render time.
 */
export function regexStructureFingerprint(pattern: string): {
  quantifiers: string[];
  characterClasses: string[];
  escapes: string[];
  assertions: string[];
} {
  const quantifiers = new Set<string>();
  const characterClasses = new Set<string>();
  const escapes = new Set<string>();
  const assertions = new Set<string>();
  const source = String(pattern ?? '');
  let previousAtom: string | null = null;
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (char === '\\') {
      const next = source[index + 1];
      if (next === undefined) { escapes.add('\\'); index += 1; continue; }
      escapes.add(`\\${next}`);
      previousAtom = `\\${next}`;
      index += 2;
      continue;
    }

    if (char === '[') {
      let end = index + 1;
      if (source[end] === '^') end += 1;
      if (source[end] === ']') end += 1;
      while (end < source.length && source[end] !== ']') {
        if (source[end] === '\\') end += 1;
        end += 1;
      }
      const body = source.slice(index, Math.min(end + 1, source.length));
      characterClasses.add(body);
      previousAtom = body;
      index = Math.min(end + 1, source.length);
      continue;
    }

    if (char === '(') {
      if (source.startsWith('(?:', index)) { previousAtom = null; index += 3; continue; }
      if (source.startsWith('(?<=', index)) { assertions.add('(?<='); previousAtom = null; index += 4; continue; }
      if (source.startsWith('(?<!', index)) { assertions.add('(?<!'); previousAtom = null; index += 4; continue; }
      if (source.startsWith('(?=', index)) { assertions.add('(?='); previousAtom = null; index += 3; continue; }
      if (source.startsWith('(?!', index)) { assertions.add('(?!'); previousAtom = null; index += 3; continue; }
      if (source.startsWith('(?<', index)) {
        const close = source.indexOf('>', index);
        previousAtom = close < 0 ? null : `(?<${source.slice(index + 3, close)}>`;
        index = close < 0 ? index + 2 : close + 1;
        continue;
      }
      if (source.startsWith('(?', index)) {
        const close = source.indexOf(')', index);
        previousAtom = null;
        index = close < 0 ? index + 2 : close + 1;
        continue;
      }
      previousAtom = null;
      index += 1;
      continue;
    }

    if (char === '*' || char === '+' || char === '?') {
      const suffix = source[index + 1] === '?' ? '?' : source[index + 1] === '+' ? '+' : '';
      quantifiers.add(`${previousAtom ?? ''}${char}${suffix}`);
      index += 1 + (suffix ? 1 : 0);
      continue;
    }

    if (char === '{') {
      const match = /^\{(\d+)(?:,(\d*))?\}/u.exec(source.slice(index));
      if (match) {
        quantifiers.add(`${previousAtom ?? ''}${match[0]}`);
        index += match[0].length;
        continue;
      }
      index += 1;
      continue;
    }

    if (char === '|' || char === ')' || char === '^' || char === '$') { previousAtom = null; index += 1; continue; }
    previousAtom = char;
    index += 1;
  }

  return {
    quantifiers: [...quantifiers].sort(),
    characterClasses: [...characterClasses].sort(),
    escapes: [...escapes].sort(),
    assertions: [...assertions].sort(),
  };
}

function diffSorted(original: readonly string[], draft: readonly string[]): { removed: string[]; added: string[] } {
  const originalSet = new Set(original);
  const draftSet = new Set(draft);
  return {
    removed: original.filter((value) => !draftSet.has(value)),
    added: draft.filter((value) => !originalSet.has(value)),
  };
}

/**
 * Report structural drift inside runtime-scope regex rules (`editdisplay` / `editoutput`).
 *
 * This is deliberately advisory. A runtime rule may legitimately need a new character
 * range for the target language, so these findings must reach a human reviewer rather
 * than block a job or an export. The blocking gate lives in
 * `applyRisuRegexCoverageProposals`, which refuses whole-pattern rewrites outright.
 *
 * `rootLabel` names the container the draft rules live in (`$module` for a Risu module,
 * `卡片` for a card's `customscript`), so a finding points at the surface it came from.
 */
export function collectRisuRuntimeRegexStructuralDrift(
  originalModule: Record<string, unknown>,
  draftModule: Record<string, unknown> | null | undefined,
  rootLabel = '$module',
): RisuRegexStructuralDrift[] {
  if (!draftModule) return [];
  const originalRules = collectRisuRegexInputRules(originalModule, rootLabel);
  if (!originalRules.length) return [];
  const draftByPath = new Map(collectRisuRegexInputRules(draftModule, rootLabel).map((entry) => [entry.pathLabel, entry.rule]));
  const drifts: RisuRegexStructuralDrift[] = [];

  for (const { rule, pathLabel: ruleLabel } of originalRules) {
    if (!isRuntimeScopeRegexRule(rule)) continue;
    const draftRule = draftByPath.get(ruleLabel);
    if (!draftRule) continue;
    const originalPattern = String(rule.in ?? '');
    const draftPattern = String(draftRule.in ?? '');
    if (!draftPattern || originalPattern === draftPattern) continue;
    const before = regexStructureFingerprint(originalPattern);
    const after = regexStructureFingerprint(draftPattern);

    const checks: Array<{ kind: RisuRegexStructuralDrift['kind']; label: string; before: string[]; after: string[] }> = [
      { kind: 'quantifier', label: '量词', before: before.quantifiers, after: after.quantifiers },
      { kind: 'character-class', label: '字符类', before: before.characterClasses, after: after.characterClasses },
      { kind: 'escape', label: '转义序列', before: before.escapes, after: after.escapes },
      { kind: 'assertion', label: '零宽断言', before: before.assertions, after: after.assertions },
    ];
    for (const check of checks) {
      const { removed, added } = diffSorted(check.before, check.after);
      if (!removed.length && !added.length) continue;
      const parts: string[] = [];
      if (removed.length) parts.push(`移除 ${removed.map((value) => JSON.stringify(value)).join('、')}`);
      if (added.length) parts.push(`新增 ${added.map((value) => JSON.stringify(value)).join('、')}`);
      drifts.push({
        pathLabel: ruleLabel,
        kind: check.kind,
        removed,
        added,
        message: `${check.label}发生变化（${parts.join('，')}）。运行期正则的这类改动不会改变静态卡片命中数，但会改变渲染期行为，请对照原文人工确认。`,
      });
    }
  }
  return drifts;
}

/**
 * Apply validated literal alternatives to a plain character card's `customscript` regex rules.
 *
 * Cards keep their regex rules in `customscript` rather than in a module `regex` array, and
 * that surface previously received no language adaptation at all: a rule written around
 * source-language trigger words (`하고|하는|라고`) never gained target-language equivalents,
 * so authors patched the patterns by hand — which is exactly how the Madoka Magica card lost
 * its portraits (a hand edit loosened `[ \t]+` inside a display regex).
 *
 * This adapter is deliberately additive-only: it reuses `appendRegexLiteralAlternatives`, so
 * only `|literal` items may appear inside an existing non-capturing alternation group. It
 * never rewrites quantifiers, groups, anchors or assertions, and it never touches `out`.
 * Whole-pattern adaptation stays exclusive to `applyRisuRegexCoverageProposals` for module
 * rules, which have a coverage guard; card rules have no comparable guard, so they must not
 * receive one.
 */
export function applyCardCustomscriptRegexAlternatives(
  card: Record<string, unknown>,
  proposals: readonly RisuRegexAlternativeProposal[],
): RisuRegexAlternativeChange[] {
  if (!proposals.length || !Array.isArray(card.customscript)) return [];
  const byPath = new Map<string, RisuRegexAlternativeProposal>();
  for (const proposal of proposals) {
    if (!proposal || typeof proposal.pathLabel !== 'string') continue;
    if (!byPath.has(proposal.pathLabel)) byPath.set(proposal.pathLabel, proposal);
  }
  const changes: RisuRegexAlternativeChange[] = [];
  card.customscript.forEach((rawEntry, index) => {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) return;
    const entry = rawEntry as Record<string, unknown>;
    if (typeof entry.in !== 'string' || !entry.in) return;
    const pathLabelValue = cardCustomscriptRegexPathLabel(index);
    const proposal = byPath.get(pathLabelValue);
    if (!proposal) return;
    // Ambiguity guard. A hand-edited card can contain the same literal in several alternation
    // groups (the Madoka card carries `说` in the trigger list *and* in the dialogue-verb list),
    // and appending to the wrong group would silently change matching. Refuse rather than guess;
    // the author can still add the literal through the manual rule editor.
    if (isAmbiguousRegexAlternativeAnchor(entry.in, proposal.anchorAlternatives)) return;
    const result = appendRegexLiteralAlternatives(entry.in, proposal.anchorAlternatives, proposal.additions);
    if (!result.added.length) return;
    entry.in = result.pattern;
    changes.push({ pathLabel: pathLabelValue, addedAlternatives: result.added });
  });
  return changes;
}

/**
 * True when the proposal's anchor literals do not identify a safe, unambiguous extension point.
 *
 * The guard accepts an anchor only when it is a **top-level literal alternative** of exactly one
 * non-capturing group. A nested body such as the inner `(?:하고|하는)` of `^(?:a|(?:하고|하는))$`
 * is correctly extended by `appendRegexLiteralAlternatives` — the nested group is its own
 * alternation — but only because the anchor happens to be the innermost match, which is hard to
 * reason about from the outside. Restricting the accepted shape to a single top-level group keeps
 * the behaviour predictable; a refused rule is left for the manual editor, whereas an unexpected
 * extension silently changes matching.
 *
 * Also refused: more than one group qualifying, and an anchor that is a strict prefix of a sibling
 * alternative (`说` vs `说道`). The latter is meant to match as text, but would then only match
 * when not followed by the longer alternative; RisuAI has no suffix-alternative syntax, so leaving
 * the rule untouched is safer than silently narrowing it.
 */
function isAmbiguousRegexAlternativeAnchor(pattern: string, anchors: readonly string[]): boolean {
  const cleanAnchors = [...new Set(anchors.map((value) => value.trim()).filter(Boolean))];
  if (!cleanAnchors.length) return false;
  const groups = findNonCapturingGroups(pattern);
  // The appender extends the innermost group whose top-level alternatives contain the anchor, so
  // a nested body is a legitimate target (`^(?:a|(?:하고|하는))$` -> `^(?:a|(?:하고|하는|新增))$`).
  // Refuse only when no group qualifies at all, when several qualify, or when the anchor would
  // silently narrow a sibling literal.
  let matchingGroups = 0;
  let ambiguousInsideGroup = false;
  for (const group of groups) {
    const alternatives = splitTopLevelRegexAlternatives(pattern.slice(group.bodyStart, group.end));
    if (!cleanAnchors.some((anchor) => alternatives.includes(anchor))) continue;
    matchingGroups += 1;
    if (cleanAnchors.some((anchor) => alternatives.some((value) => value !== anchor && value.startsWith(anchor)))) {
      ambiguousInsideGroup = true;
    }
  }
  return matchingGroups === 0 || matchingGroups > 1 || ambiguousInsideGroup;
}

/** Stable path label for one card `customscript` regex input. */
export function cardCustomscriptRegexPathLabel(index: number): string {
  return pathLabel(['卡片', 'customscript', index, 'in']);
}

/**
 * Card `customscript` rules that consume generated chat text rather than card copy.
 *
 * Used to tell the model which card rules may only gain additive alternatives, mirroring the
 * `dynamicDisplay` / `runtimePostprocess` flags carried for module rules.
 */
export function cardCustomscriptRegexFlags(entry: Record<string, unknown> | null | undefined): {
  dynamicDisplay: boolean;
  runtimePostprocess: boolean;
} {
  return {
    dynamicDisplay: isRisuDisplayFormattingRegexRule(entry),
    runtimePostprocess: isRisuOutputPostprocessRegexRule(entry),
  };
}

/** A protocol tag that survives the card's own display rules and would render as literal text. */
export interface RisuUnconsumedProtocolTag {
  pathLabel: string;
  tag: string;
  count: number;
  unconsumed: number;
  message: string;
}

/** Matches a whole pseudo-tag such as `<img="kyoko_normal_smug">`, quoted or bare. */
const PROTOCOL_TAG_PATTERN = /<([a-zA-Z][a-zA-Z0-9_-]{0,30})\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)\s*\/?>/gu;

function protocolTagKind(tag: string): string {
  const match = /^<([a-zA-Z][a-zA-Z0-9_-]{0,30})\s*=/u.exec(tag);
  return match ? match[1].toLowerCase() : '';
}

/**
 * Detect protocol tags that the card emits but no display rule consumes.
 *
 * Cards express inline artwork with a self-closing pseudo-tag such as `<img="name">` and rely
 * on `editdisplay` regex rules to turn it into real markup. When one of those rules stops
 * matching, the tag either survives verbatim and Risu renders it as visible text, or it is
 * mangled by an earlier rule (a line-break rule firing *inside* the tag does exactly that) so
 * that no display pattern matches it any more. A third failure mode is silent: the card's own
 * "hide old artwork" rule still matches the mangled tag and deletes it, leaving a blank gap.
 * None of these produce an error anywhere, so this runs the card's own display rules over
 * representative text and compares how many pseudo-tags the text emitted against how many the
 * rules actually consumed.
 *
 * Only `editdisplay` rules participate, because those are the rules Risu runs while rendering a
 * message. Rules whose pattern needs CBS expansion (`<cbs>` flag) and rules that emit control
 * directives (`@@…`) are skipped rather than guessed at. A sample is reported only when the
 * rules demonstrably consumed something, so an unusable simulation stays silent instead of
 * flagging every tag.
 */
export function collectRisuUnconsumedProtocolTags(
  card: Record<string, unknown>,
  samples: readonly { pathLabel: string; text: string }[],
): RisuUnconsumedProtocolTag[] {
  const scripts = Array.isArray(card.customscript) ? card.customscript : [];
  const displayRules: Array<{ in: string; out: string; flag: string }> = [];
  for (const rawRule of scripts) {
    if (!rawRule || typeof rawRule !== 'object' || Array.isArray(rawRule)) continue;
    const rule = rawRule as Record<string, unknown>;
    if (String(rule.type ?? '').trim().toLowerCase() !== 'editdisplay') continue;
    if (typeof rule.in !== 'string' || !rule.in) continue;
    if (typeof rule.out !== 'string') continue;
    // `<cbs>` patterns are expanded by the Risu parser before the rule runs; without that
    // expansion the regex would not match and the simulation would be misleading.
    if (typeof rule.flag === 'string' && rule.flag.includes('cbs')) continue;
    const out = rule.out.replaceAll('$n', '\n');
    if (/@@/u.test(out)) continue;
    const rawFlag = rule.ableFlag ? (typeof rule.flag === 'string' ? rule.flag : 'g') : 'g';
    const flag = rawFlag.trim().replace(/[^dgimsuvy]/gu, '').split('')
      .filter((value: string, index: number, all: string[]) => all.indexOf(value) === index).join('') || 'u';
    displayRules.push({ in: rule.in, out, flag });
  }

  const findings = new Map<string, RisuUnconsumedProtocolTag>();
  const reported = new Set<string>();
  for (const sample of samples) {
    const text = String(sample.text ?? '');
    if (!text) continue;
    const emitted = [...text.matchAll(PROTOCOL_TAG_PATTERN)].filter((match) => protocolTagKind(match[0]) !== '');
    if (!emitted.length) continue;

    let data = text;
    let matchedAnything = false;
    for (const rule of displayRules) {
      let regex: RegExp;
      try { regex = new RegExp(rule.in, rule.flag); } catch { continue; }
      if (!regex.test(data)) continue;
      matchedAnything = true;
      if (regex.global) regex.lastIndex = 0;
      try { data = data.replace(regex, rule.out); } catch { /* unusable replacement is skipped */ }
    }
    // Nothing matched at all: the simulation proved nothing about this sample, so stay silent
    // rather than flagging every tag. This is the guard that keeps CBS-dependent rules and
    // unusual inputs from producing noise.
    if (!matchedAnything) continue;

    const survivors = [...data.matchAll(PROTOCOL_TAG_PATTERN)]
      .filter((match) => protocolTagKind(match[0]) !== '')
      .map((match) => match[0])
      .filter((tag, index, all) => all.indexOf(tag) === index);
    if (!survivors.length) continue;
    if (reported.has(sample.pathLabel)) continue;
    reported.add(sample.pathLabel);

    // Only tags that are still intact pseudo-tags count as unconsumed. A rule that mangles a
    // tag is reported through its own mangled-tag survivor, and a rule that merely fires on
    // ordinary quotes elsewhere in the prose cannot produce a survivor here.
    const survivorCount = [...data.matchAll(PROTOCOL_TAG_PATTERN)].filter((match) => protocolTagKind(match[0]) !== '').length;
    findings.set(sample.pathLabel, {
      pathLabel: sample.pathLabel,
      tag: survivors[0],
      count: emitted.length,
      unconsumed: survivorCount,
      message: `这段文本发出 ${emitted.length} 个 <名称="值"> 形式的协议标签，但卡片自身的“修改显示”规则跑完后仍有 ${survivorCount} 个以标签形式残留（例如 ${survivors[0]}）。渲染时这些标签会当成普通文字显示，或按旧消息规则被整段删除而只剩空白。请检查对应的 editdisplay 正则是否仍然匹配卡片实际发出的标签。`,
    });
  }
  return [...findings.values()];
}

function isDisplayFormattingReplacement(output: string, captureCount: number): boolean {
  if (!output || !/^(?:\$\d+|\r?\n)+$/u.test(output)) return false;
  const references = [...output.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]));
  return references.length === captureCount
    && references.every((reference, index) => reference === index + 1);
}

export function isSafeRisuDisplayFormattingRegexChange(
  originalRule: Record<string, unknown> | null | undefined,
  candidateRule: Record<string, unknown> | null | undefined,
): boolean {
  if (!isRisuDisplayFormattingRegexRule(originalRule) || !isRisuDisplayFormattingRegexRule(candidateRule)) return false;
  const originalType = typeof originalRule?.type === 'string' ? originalRule.type : '';
  const candidateType = typeof candidateRule?.type === 'string' ? candidateRule.type : '';
  const originalOutput = typeof originalRule?.out === 'string' ? originalRule.out : '';
  const candidateOutput = typeof candidateRule?.out === 'string' ? candidateRule.out : '';
  const originalPattern = typeof originalRule?.in === 'string' ? originalRule.in : '';
  const candidatePattern = typeof candidateRule?.in === 'string' ? candidateRule.in : '';
  if (originalType !== candidateType || originalOutput !== candidateOutput) return false;
  if (!originalPattern || !candidatePattern) return false;
  const captureCount = countCapturingGroups(originalPattern);
  if (captureCount !== countCapturingGroups(candidatePattern)) return false;
  if (!isDisplayFormattingReplacement(candidateOutput, captureCount)) return false;
  try { new RegExp(candidatePattern); } catch { return false; }
  return true;
}

function isSafeRisuDisplayFormattingInputChange(original: RisuRegexInput, candidate: RisuRegexInput): boolean {
  return isSafeRisuDisplayFormattingRegexChange(
    { type: original.type, in: original.pattern, out: original.out },
    { type: candidate.type, in: candidate.pattern, out: candidate.out },
  );
}

function isSafeRisuOutputPostprocessInputChange(original: RisuRegexInput, candidate: RisuRegexInput): boolean {
  const originalRule = { type: original.type, in: original.pattern, out: original.out };
  const candidateRule = { type: candidate.type, in: candidate.pattern, out: candidate.out };
  if (!isRisuOutputPostprocessRegexRule(originalRule) || !isRisuOutputPostprocessRegexRule(candidateRule)) return false;
  if (original.type.trim().toLowerCase() !== candidate.type.trim().toLowerCase()) return false;
  // An editoutput template is exactly the part a user needs to repair when it
  // removes a generated image tag. Empty output remains valid: it deliberately
  // deletes a match in Risu's own rule format.
  if (candidate.out.length > 16_000) return false;
  if (!candidate.pattern) return false;
  try { new RegExp(candidate.pattern); } catch { return false; }
  return true;
}

function countCapturingGroups(pattern: string): number {
  let count = 0;
  let escaped = false;
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (inClass || char !== '(') continue;
    const next = pattern[index + 1];
    if (next !== '?') count += 1;
    else if (pattern[index + 2] === '<' && pattern[index + 3] !== '=' && pattern[index + 3] !== '!') count += 1;
  }
  return count;
}

function isSafeRegexLiteral(value: string): boolean {
  return value.length >= 1 && value.length <= 40
    && !/[\\()[\]{}*+?|^$\r\n]/u.test(value);
}

function isSafeRegexEncodedLiteral(value: string): boolean {
  const decoded = value.replace(/\\([.*+?^${}()|[\]\\])/gu, '$1');
  return isSafeRegexLiteral(decoded) && escapeRegExp(decoded) === value;
}

function findNonCapturingGroups(pattern: string): Array<{ bodyStart: number; end: number }> {
  const groups: Array<{ bodyStart: number; end: number }> = [];
  const stack: Array<{ start: number; bodyStart: number; nonCapturing: boolean }> = [];
  let inClass = false;
  let escaped = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (char === '(') {
      const nonCapturing = pattern.startsWith('(?:', index);
      stack.push({ start: index, bodyStart: index + (nonCapturing ? 3 : 1), nonCapturing });
    } else if (char === ')' && stack.length) {
      const group = stack.pop()!;
      if (group.nonCapturing) groups.push({ bodyStart: group.bodyStart, end: index });
    }
  }
  return groups;
}

function splitTopLevelRegexAlternatives(body: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let inClass = false;
  let escaped = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (escaped) { escaped = false; continue; }
    if (char === '\\') { escaped = true; continue; }
    if (char === '[') { inClass = true; continue; }
    if (char === ']' && inClass) { inClass = false; continue; }
    if (inClass) continue;
    if (char === '(') depth += 1;
    else if (char === ')' && depth > 0) depth -= 1;
    else if (char === '|' && depth === 0) {
      parts.push(body.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
}

export function isLuaModuleCodePath(path: Array<string | number>): boolean {
  return path.at(-1) === 'code' && path.some((part) => part === 'effect' || part === 'trigger');
}

/**
 * RisuAI trigger effect fields that hold **player-visible copy**.
 *
 * A generic walk cannot tell `v2Impersonate.value` (the message a trigger posts)
 * from `v2SetRequestStateRole.value` (`"user"` — an enum the runtime compares
 * against), `v2Command.value` (`/setvar …` — command syntax) or `v2SetVar.value`
 * with `valueType: "var"` (a variable name the runtime resolves with `getVar()`).
 * Translating any of those changes behaviour silently, so this scanner uses an
 * explicit allowlist keyed by effect type, exactly like `scanStPreset()` does for
 * SillyTavern presets. Effect shapes follow `kwaroran/RisuAI`
 * `src/ts/process/triggers.ts`, which keeps the v1 (`triggerEffectV1`) and v2
 * (`triggerEffectV2`) unions side by side, so the three v1 spellings of the same
 * copy-bearing effects are listed as well.
 *
 * `v2GetAlertSelect` is listed by `display`, not `value`: its `value` is the
 * `|`-joined option list whose selected entry is stored as the trigger result, so
 * replacing it would rewrite runtime data instead of a label.
 *
 * Deliberately excluded, because they are not shown to the player:
 * `v2Comment`, `v2ModifyChat`, `v2ImgGen`, `v2RunLLM`, `v1 setvar/command/
 * runtrigger/cutchat/modifychat/extractRegex/checkSimilarity/runImgGen/
 * runLLM/runAxLLM`, and every `…Type: "var"` literal.
 */
const RISU_TRIGGER_COPY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  v2Impersonate: ['value'],
  v2SystemPrompt: ['value'],
  v2ShowAlert: ['value'],
  v2SetAuthorNote: ['value'],
  v2SetReplaceGlobalNote: ['value'],
  v2GetAlertSelect: ['display'],
  v2GetAlertInput: ['display'],
  // v1 spellings of the same player-visible effects. RisuAI still ships both
  // unions, and older cards carry `type: "impersonate"` rather than the v2 form.
  impersonate: ['value'],
  systemprompt: ['value'],
  showAlert: ['value'],
};

/** Shape of a `$module.trigger[n].effect[m].<field>` path, with or without the module root. */
export function isRisuTriggerEffectFieldPath(path: Array<string | number>): boolean {
  const parts = path[0] === '$module' ? path.slice(1) : path;
  return parts.length === 5
    && parts[0] === 'trigger'
    && typeof parts[1] === 'number'
    && parts[2] === 'effect'
    && typeof parts[3] === 'number'
    && typeof parts[4] === 'string';
}

/**
 * Resolve the copy field a RisuAI trigger effect exposes at `path`, or null.
 *
 * Returns the field name only when the effect type is on the copy allowlist *and*
 * the literal is not a variable reference: a sibling `valueType` / `displayType`
 * flag of `"var"` means the value is a variable **name** the runtime resolves
 * with `getVar()`, so it stays data even when the field is named `value`.
 */
export function risuTriggerEffectCopyField(
  module: Record<string, unknown>,
  path: Array<string | number>,
): string | null {
  if (!isRisuTriggerEffectFieldPath(path)) return null;
  const parts = path[0] === '$module' ? path.slice(1) : path;
  const effect = getAt(module, ['trigger', parts[1], 'effect', parts[3]]);
  if (!effect || typeof effect !== 'object' || Array.isArray(effect)) return null;
  const record = effect as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  const field = String(parts[4]);
  const fields = Object.hasOwn(RISU_TRIGGER_COPY_FIELDS, type) ? RISU_TRIGGER_COPY_FIELDS[type] : undefined;
  if (!fields || !fields.includes(field)) return null;
  if (record[`${field}Type`] === 'var') return null;
  return field;
}

/** Keep plain prose around CBS macros without offering macro operands for translation. */
function extractRisuTriggerCopy(source: string, path: Array<string | number>): ScannedSegment[] {
  // Check outer macro boundaries before accepting candidates from the generic
  // extractor. It recognizes button syntax even inside a comparison operand.
  const macros = templateMacros(source, true);
  const extracted = extractVisibleText(source, path, 'script-ui').filter((segment) => {
    if (segment.start == null || segment.end == null) return false;
    const overlapping = macros.filter((macro) => segment.start! < macro.end && segment.end! > macro.start);
    if (!overlapping.length) return true;
    if (overlapping.length !== 1 || segment.kind !== 'button') return false;
    const macro = overlapping[0];
    if (macro.incomplete) return false;
    const button = /^\{\{button::([^{}]*?)::[\w.-]+\}\}$/u.exec(source.slice(macro.start, macro.end));
    if (!button) return false;
    const labelStart = macro.start + '{{button::'.length;
    return segment.start >= labelStart && segment.end <= labelStart + button[1].length;
  });
  if (/[<>]/u.test(source)) return extracted;
  if (!source.includes('{{') && !source.includes('}}') && !extracted.length) {
    return [fieldSegment(path, source, 'script-ui', 'medium')];
  }
  const excluded = [...macros, ...extracted.map((segment) => ({
    start: segment.start!, end: segment.end!,
  }))];
  for (const range of subtractRanges([{ start: 0, end: source.length }], excluded)) {
    const raw = source.slice(range.start, range.end);
    // An incomplete macro is ambiguous; never turn its remaining operands into copy.
    if (/\{\{|\}\}/u.test(raw)) continue;
    const text = raw.trim();
    if (!text) continue;
    const start = range.start + raw.length - raw.trimStart().length;
    extracted.push({ ...fieldSegment(path, text, 'script-ui', 'medium'), kind: 'text-node', start, end: start + text.length });
  }
  return removeOverlaps(extracted);
}

export function applyApprovedSegments(card: Record<string, unknown>, segments: ApplicableSegment[]): Record<string, unknown> {
  const draft = structuredClone(card);
  const ranged = new Map<string, ApplicableSegment[]>();

  for (const segment of segments) {
    if (segment.reviewStatus !== 'approved') continue;
    const translation = segment.finalText?.trim() || segment.translatedText?.trim();
    if (!translation) continue;
    const path = JSON.parse(segment.pathJson) as Array<string | number>;
    if (isRisuTriggerEffectFieldPath(path) && isProtectedStoredPath(segment.kind, path, card)) continue;
    if (segment.kind === 'lorebook-key-alias') {
      appendLorebookKeywordAlias(draft, path, translation);
      continue;
    }
    if (segment.start == null || segment.end == null) {
      const original = String(getAt(card, path) ?? '');
      setAt(draft, path, preserveProtocolShells(original, translation));
      continue;
    }
    const key = JSON.stringify(path);
    const group = ranged.get(key) ?? [];
    group.push(segment);
    ranged.set(key, group);
  }

  for (const [pathJson, group] of ranged) {
    const path = JSON.parse(pathJson) as Array<string | number>;
    let source = String(getAt(draft, path) ?? '');
    const resolved = resolveSegmentRanges(source, group, isLuaModuleCodePath(path) ? luaLiteralRanges(source) : undefined);
    resolved.sort((a, b) => b.start - a.start);
    for (const { segment, start, end } of resolved) {
      const translation = segment.finalText?.trim() || segment.translatedText?.trim() || '';
      const attribute = segment.kind === 'attribute' ? textAttributes(source).find(attr => attr.start <= start && attr.end >= end) : undefined;
      const replacement = attribute ? escapeTextAttribute(translation, attribute.quote) : segment.kind === 'lua-long-string'
        ? encodeLuaLongString(
            preserveBoundaryWhitespace(segment.sourceText ?? '', translation),
            luaLongStringEquals(source.slice(start, end)),
          )
        : isEncodedLiteralSegment(segment.kind)
          ? encodeRuntimeLiteral(translation, enclosingQuote(source, start))
          : translation;
      source = source.slice(0, start) + replacement + source.slice(end);
    }
    const original = String(getAt(card, path) ?? '');
    setAt(draft, path, preserveProtocolShells(original, source));
  }

  return draft;
}

/**
 * Keep protocol syntax from the source while accepting translated slot values.
 * This handles translators inserting spaces around delimiters (for example
 * `<news|...>` becoming `<news | ...>`) without changing the visible payload.
 */
function preserveProtocolShells(original: string, candidate: string): string {
  const sourceOccurrences = parseProtocols(original);
  const candidateOccurrences = parseProtocols(candidate);
  if (!sourceOccurrences.length || !candidateOccurrences.length) return candidate;

  const sourceGroups = groupProtocolOccurrences(sourceOccurrences);
  const candidateGroups = groupProtocolOccurrences(candidateOccurrences);
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const [signature, sourceGroup] of sourceGroups) {
    const candidateGroup = candidateGroups.get(signature);
    if (!candidateGroup || candidateGroup.length !== sourceGroup.length) continue;
    sourceGroup.forEach((sourceOccurrence, index) => {
      const candidateOccurrence = candidateGroup[index];
      if (candidateOccurrence.fields.length !== sourceOccurrence.fields.length) return;
      let rebuilt = sourceOccurrence.rawText;
      for (let fieldIndex = sourceOccurrence.fields.length - 1; fieldIndex >= 0; fieldIndex -= 1) {
        const sourceField = sourceOccurrence.fields[fieldIndex];
        const candidateField = candidateOccurrence.fields[fieldIndex];
        const start = sourceField.start - sourceOccurrence.start;
        const end = sourceField.end - sourceOccurrence.start;
        rebuilt = `${rebuilt.slice(0, start)}${candidateField.value}${rebuilt.slice(end)}`;
      }
      replacements.push({ start: candidateOccurrence.start, end: candidateOccurrence.end, value: rebuilt });
    });
  }

  replacements.sort((left, right) => right.start - left.start);
  let output = candidate;
  for (const replacement of replacements) {
    output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  }
  return output;
}

function groupProtocolOccurrences<T extends { signature: string }>(
  occurrences: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const occurrence of occurrences) {
    const group = groups.get(occurrence.signature) ?? [];
    group.push(occurrence);
    groups.set(occurrence.signature, group);
  }
  return groups;
}

export function protectText(text: string, extraFragments: readonly string[] = []): { protectedText: string; tokens: string[] } {
  const tokens: string[] = [];
  const keep = (match: string) => {
    const token = `__CTW_KEEP_${tokens.length}__`;
    tokens.push(match);
    return token;
  };

  const structuredText = protectNaturalStatusPayloads(text, keep);
  const protectedText = structuredText.replace(protectedPattern(extraFragments), (fragment) => {
    const attributes = textAttributes(fragment);
    if (!attributes.length || extraFragments.includes(fragment)) return keep(fragment);
    let result = '';
    let cursor = 0;
    for (const attr of attributes) {
      result += keep(fragment.slice(cursor, attr.start));
      result += attr.text.replace(protectedPattern(extraFragments), keep);
      cursor = attr.end;
    }
    return result + keep(fragment.slice(cursor));
  });
  return { protectedText, tokens };
}

export function localTranslationControlFragments(text: string): string[] {
  const direct = new Set<string>();

  if (isAssetListChunk(text)) direct.add(text);

  // Asset names and underscored identifiers are runtime values even when a
  // card lists them as bare text instead of wrapping them in code or HTML.
  for (const match of text.matchAll(/(?:^|[,，\s:：("'`])([\p{L}\p{N}_./-]+(?: [\p{L}\p{N}_./-]+)*\.(?:png|jpe?g|webp|gif|json|lua|charx|risum))(?=$|[,，\s)"'`>])/gimu)) {
    direct.add(match[1]);
  }
  for (const match of text.matchAll(/[\p{L}\p{N}]+_[\p{L}\p{N}]+(?:_[\p{L}\p{N}]+)*/gu)) {
    if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/u.test(match[0])) direct.add(match[0]);
  }

  let hasImageCommandSyntax = false;
  for (const match of text.matchAll(/\bsrc\s*=\s*(\[[^\]\r\n]{1,80}\])(?=[.\s)>])/gim)) {
    hasImageCommandSyntax = true;
    if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/u.test(match[1])) direct.add(match[1]);
  }
  if (hasImageCommandSyntax && /(?:image commands?|list of commands?|tag format|prefix)/i.test(text)) {
    // Image-command cards commonly declare several sibling prefixes but show
    // an example for only one. Their declaration labels are runtime identifiers too.
    for (const match of text.matchAll(/^\s*(\[[^\]\r\n]{1,80}\])\s*[:：]/gm)) {
      if (/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/u.test(match[1])) direct.add(match[1]);
    }
  }

  // Preserve Korean tokens explicitly declared as runtime markers, speech
  // literals, language-specific examples, or regex character classes.
  let declaredExampleLines = 0;
  for (const line of text.split(/\r?\n/u)) {
    const declaration = /(?:fixed\s+korean|original\s+korean|do\s+not\s+translate|forbidden\s+examples?|korean\s+(?:flashback\s+)?markers?|korean\s+(?:particles?|dialogue|speech)|formal\s+korean|speech\s+(?:examples?|endings?)|official\s+dialogue|blunt\s+casual\s+phrasing|address\s*\(kr\)|when\s+\w+_lang\s*=\s*ko|hangul|refer\s+to\s+the\s+local\s+counterpart|in\s+korean\s+repl(?:ies|y)|exact\s+speech\s+register|honorific|speaks\s+casually|tone\s+examples?|vocabulary\s*:\s*speaks)/iu.test(line);
    if (declaration) declaredExampleLines = 8;
    const exampleLine = /^\s*(?:[-*•]|["“])/u.test(line);
    if (declaration || (declaredExampleLines > 0 && exampleLine)) {
      for (const token of line.match(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]+/gu) ?? []) direct.add(token);
      for (const match of line.matchAll(/~[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]+/gu)) direct.add(match[0]);
      for (const match of line.matchAll(/["“]([^"”\r\n]*[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f][^"”\r\n]*)["”]/gu)) direct.add(match[1]);
      if (!declaration) declaredExampleLines -= 1;
    }
  }
  if (/(?:replace|regexp|regex|character\s+class)/iu.test(text)) {
    for (const match of text.matchAll(/\[[^\]\r\n]*(?:ㄱ|ㅎ|ㅏ|ㅣ|가-힣)[^\]\r\n]*\]/gu)) direct.add(match[0]);
  }
  return [...direct];
}

function isAssetListChunk(text: string): boolean {
  if (/\r|\n/u.test(text)) return false;
  const parts = text.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 4) return false;
  const assetName = /^[\p{L}\p{N}_./ -]+\.(?:png|jpe?g|webp|gif|json|lua|charx|risum)$/iu;
  const assetStem = /^[\p{L}\p{N}_./ -]+$/u;
  const complete = parts.filter((part) => assetName.test(part)).length;
  return complete >= 3
    && complete >= parts.length - 2
    && parts.every((part) => assetName.test(part) || assetStem.test(part));
}

export function unchangedCodeSpanFragments(source: string, candidate: string): string[] {
  const unchanged = new Set<string>();
  for (const match of source.matchAll(/`[^`\r\n]+`/g)) {
    if (candidate.includes(match[0])) unchanged.add(match[0]);
  }
  return [...unchanged];
}

export function unchangedFilePathFragments(source: string, candidate: string): string[] {
  const unchanged = new Set<string>();
  const filePath = /[\p{L}\p{N}_.@+-]+(?:[\\/][\p{L}\p{N}_.@+-]+)+\.[A-Za-z0-9]{1,12}/gu;
  for (const match of source.matchAll(filePath)) {
    if (candidate.includes(match[0])) unchanged.add(match[0]);
  }
  return [...unchanged];
}

export function missingProtectedFragments(
  source: string,
  candidate: string,
  extraFragments: readonly string[] = [],
): string[] {
  const required = new Map<string, number>();
  for (const fragment of protectText(source, extraFragments).tokens) {
    required.set(fragment, (required.get(fragment) ?? 0) + 1);
  }

  const missing: string[] = [];
  for (const [fragment, count] of required) {
    const deficit = count - countOccurrences(candidate, fragment);
    for (let index = 0; index < deficit; index += 1) missing.push(fragment);
  }
  return missing;
}

function protectNaturalStatusPayloads(text: string, keep: (fragment: string) => string): string {
  return text.replace(/<rp-status\b[^<>\r\n]{0,2000}>/giu, (tag) => {
    const ranges: Array<{ start: number; end: number }> = [];
    for (const match of tag.matchAll(/\b(?:bm|em)\s*=\s*(["'])([\s\S]*?)\1/giu)) {
      const value = match[2];
      if (!value || /^[A-Z][A-Z0-9_]*$/u.test(value)) continue;
      const relativeStart = match[0].indexOf(value);
      const start = (match.index ?? 0) + relativeStart;
      ranges.push({ start, end: start + value.length });
    }
    if (!ranges.length) return keep(tag);

    let result = '';
    let cursor = 0;
    for (const range of ranges) {
      result += keep(tag.slice(cursor, range.start));
      result += tag.slice(range.start, range.end);
      cursor = range.end;
    }
    result += keep(tag.slice(cursor));
    return result;
  });
}

export function missingLiteralFragments(
  source: string,
  candidate: string,
  fragments: readonly string[],
): string[] {
  const missing: string[] = [];
  for (const fragment of new Set(fragments.filter(Boolean))) {
    const deficit = countOccurrences(source, fragment) - countOccurrences(candidate, fragment);
    for (let index = 0; index < deficit; index += 1) missing.push(fragment);
  }
  return missing;
}

export function restoreProtectedText(text: string, tokens: string[]): string {
  let restored = text;
  tokens.forEach((value, index) => {
    restored = restored.replaceAll(`__CTW_KEEP_${index}__`, value);
  });
  return restored.trim();
}

export function missingProtectionTokens(text: string, tokenCount: number): string[] {
  const missing: string[] = [];
  for (let index = 0; index < tokenCount; index += 1) {
    const token = `__CTW_KEEP_${index}__`;
    if (!text.includes(token)) missing.push(token);
  }
  return missing;
}

function protectedPatterns(): RegExp[] {
  return [
    /```[\s\S]*?```/g,
    /`(?=[\p{L}\p{N}_./:-]+(?: [\p{L}\p{N}_./:-]+)*\.(?:png|jpe?g|webp|gif|json|lua|charx|risum)\b)[^`\n]*`/giu,
    /`(?=[\p{L}_][\p{L}\p{N}_.:-]{0,120}`)[^`\n]*`/gu,
    /<!--[\s\S]*?-->/g,
    /<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)\s*>/gi,
    /https?:\/\/[^\s<>"')]+/g,
    /\{\{[\s\S]*?\}\}/g,
    /\$\{[^}]+\}/g,
    new RegExp(MARKUP_TOKEN_SOURCE, 'g'),
    /^@@[^\n]*/gm,
  ];
}

function protectedPattern(extraFragments: readonly string[] = []): RegExp {
  const literals = [...new Set(extraFragments.filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .map((literal) => escapeRegExp(literal));
  const sources = [...protectedPatterns().map((pattern) => pattern.source), ...literals];
  return new RegExp(sources.map((source) => `(?:${source})`).join('|'), 'gmu');
}

function countOccurrences(text: string, fragment: string): number {
  let count = 0;
  let offset = 0;
  while ((offset = text.indexOf(fragment, offset)) >= 0) {
    count += 1;
    offset += fragment.length || 1;
  }
  return count;
}

function uniqueControlLiterals(references: readonly RisuControlReference[]): string[] {
  return [...new Set(references.map((reference) => reference.literal).filter(Boolean))]
    .sort((left, right) => right.length - left.length);
}

function countOccurrencesInStrings(value: unknown, literal: string): number {
  if (typeof value === 'string') return countOccurrences(value, literal);
  if (Array.isArray(value)) return value.reduce((total, entry) => total + countOccurrencesInStrings(entry, literal), 0);
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value).reduce((total, entry) => total + countOccurrencesInStrings(entry, literal), 0);
}

export function isZeroWidthCardinalityTrigger(pattern: string): boolean {
  try {
    const match = new RegExp(pattern).exec('');
    // RegExpExecArray contains one element when the rule has no capture groups.
    // Capturing protocols keep the stricter match-count validation below.
    return Boolean(match && match.index === 0 && match[0] === '' && match.length === 1);
  } catch {
    return false;
  }
}

export function regexMatchSamplesInStrings(value: unknown, pattern: string, limit = 40): string[] {
  const samples: string[] = [];
  let regex: RegExp;
  try { regex = new RegExp(pattern, 'u'); } catch { return samples; }
  const visit = (child: unknown) => {
    if (samples.length >= limit) return;
    if (typeof child === 'string') {
      regex.lastIndex = 0;
      if (regex.test(child)) samples.push(child);
      return;
    }
    if (Array.isArray(child)) { child.forEach(visit); return; }
    if (child && typeof child === 'object') Object.values(child).forEach(visit);
  };
  visit(value);
  return samples;
}

/** Return bounded context around each regex hit for diagnostics, rather than whole card strings. */
export function regexMatchSnippetsInStrings(value: unknown, pattern: string, limit = 40): string[] {
  const samples: string[] = [];
  let regex: RegExp;
  try { regex = new RegExp(pattern, 'gu'); } catch { return samples; }
  const clip = (text: string, max = 80) => text.length <= max ? text : `${text.slice(0, max)}…`;
  const visit = (child: unknown) => {
    if (samples.length >= limit) return;
    if (typeof child === 'string') {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while (samples.length < limit && (match = regex.exec(child))) {
        const start = Math.max(0, match.index - 55);
        const end = Math.min(child.length, match.index + match[0].length + 55);
        const before = child.slice(start, match.index);
        const hit = match[0] ? `【${clip(match[0])}】` : '【空匹配】';
        const after = child.slice(match.index + match[0].length, end);
        const snippet = `${start > 0 ? '…' : ''}${before}${hit}${after}${end < child.length ? '…' : ''}`
          .replace(/\s+/gu, ' ')
          .trim();
        samples.push(snippet.length > 180 ? `${snippet.slice(0, 179)}…` : snippet);
        if (!match[0].length) regex.lastIndex = match.index + 1;
      }
      return;
    }
    if (Array.isArray(child)) { child.forEach(visit); return; }
    if (child && typeof child === 'object') Object.values(child).forEach(visit);
  };
  visit(value);
  return samples;
}

export function countRegexMatchesInStrings(value: unknown, pattern: string): number {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, 'g');
  } catch {
    return 0;
  }
  const countText = (text: string): number => {
    regex.lastIndex = 0;
    let count = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text))) {
      count += 1;
      if (count > 100_000) break;
      if (!match[0].length) regex.lastIndex += 1;
    }
    return count;
  };
  if (typeof value === 'string') return countText(value);
  if (Array.isArray(value)) return value.reduce((total, entry) => total + countRegexMatchesInStrings(entry, pattern), 0);
  if (!value || typeof value !== 'object') return 0;
  return Object.values(value).reduce((total, entry) => total + countRegexMatchesInStrings(entry, pattern), 0);
}

function collectRisuRegexInputs(module: Record<string, unknown>): RisuRegexInput[] {
  const inputs: RisuRegexInput[] = [];
  const rules = Array.isArray(module.regex) ? module.regex : [];
  rules.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
    const rule = entry as Record<string, unknown>;
    const input = rule.in;
    if (typeof input !== 'string' || !input) return;
    const path: Array<string | number> = ['regex', index, 'in'];
    inputs.push({
      path,
      pathLabel: pathLabel(['$module', ...path]),
      pattern: input,
      type: typeof rule.type === 'string' ? rule.type : '',
      out: typeof rule.out === 'string' ? rule.out : '',
      dynamicDisplay: isRisuDisplayFormattingRegexRule(rule),
      runtimePostprocess: isRisuOutputPostprocessRegexRule(rule),
    });
  });
  return inputs;
}

export function risuRegexControlReferences(module: Record<string, unknown>): Array<{ literal: string; kind: 'regex'; pathLabel: string; pattern: string; out: string; dynamicDisplay: boolean; runtimePostprocess: boolean }> {
  return collectRisuRegexInputs(module).map((entry) => ({
    literal: entry.pattern,
    kind: 'regex' as const,
    pathLabel: entry.pathLabel,
    pattern: entry.pattern,
    out: entry.out,
    dynamicDisplay: entry.dynamicDisplay,
    runtimePostprocess: entry.runtimePostprocess,
  }));
}

function collectButtonActions(value: unknown): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const visit = (child: unknown, path: Array<string | number>) => {
    if (typeof child === 'string') {
      const actions = [...child.matchAll(/\{\{button::[\s\S]*?::([A-Za-z0-9_.:-]+)\}\}/g)].map((match) => match[1]);
      if (actions.length) result.set(JSON.stringify(path), actions);
      return;
    }
    if (Array.isArray(child)) {
      child.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!child || typeof child !== 'object') return;
    for (const [key, entry] of Object.entries(child)) visit(entry, [...path, key]);
  };
  visit(value, []);
  return result;
}

function luaControlStrings(source: string): Array<{ literal: string; context: string }> {
  const result: Array<{ literal: string; context: string }> = [];
  const seen = new Set<string>();
  try {
    const ast = parse(source, { luaVersion: '5.3', ranges: true }) as unknown;
    const walk = (
      value: unknown,
      parent: Record<string, unknown> | null = null,
      key = '',
      index: number | null = null,
    ): void => {
      if (Array.isArray(value)) {
        value.forEach((entry, entryIndex) => walk(entry, parent, key, entryIndex));
        return;
      }
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (node.type === 'StringLiteral' && Array.isArray(node.range) && parent) {
        const range = node.range as [number, number];
        const parsed = parseLuaLiteral(source.slice(range[0], range[1]), range);
        const context = luaControlContext(parent, key, index);
        if (parsed?.decoded && context) {
          const identity = `${context}:${parsed.decoded}`;
          if (!seen.has(identity)) {
            seen.add(identity);
            result.push({ literal: parsed.decoded, context });
          }
        }
      }
      for (const [childKey, child] of Object.entries(node)) {
        if (childKey === 'range' || childKey === 'loc' || childKey === 'raw') continue;
        if (Array.isArray(child)) child.forEach((entry, entryIndex) => walk(entry, node, childKey, entryIndex));
        else walk(child, node, childKey, null);
      }
    };
    walk(ast);
  } catch {
    return [];
  }
  return result;
}

function luaControlContext(parent: Record<string, unknown>, key: string, index: number | null): string | null {
  if (parent.type === 'BinaryExpression' && ['==', '~='].includes(String(parent.operator))) return 'Lua 比较值';
  if (parent.type === 'IndexExpression' && key === 'index') return 'Lua 表索引';
  if (parent.type !== 'CallExpression' || key !== 'arguments' || index == null) return null;
  const name = luaCallName(parent.base).replace(/[^A-Za-z]/g, '').toLowerCase();
  const argumentsList = Array.isArray(parent.arguments) ? parent.arguments : [];
  if (/^(?:get|read|has)(?:chat|global|local)?(?:var|state|mode|flag|key)$/.test(name)) return `Lua ${name}`;
  if (/^(?:set|write)(?:chat|global|local)?(?:var|state|mode|flag|key)$/.test(name) && index < argumentsList.length - 1) {
    return `Lua ${name}`;
  }
  const methodCall = Boolean(
    parent.base
    && typeof parent.base === 'object'
    && (parent.base as Record<string, unknown>).type === 'MemberExpression'
    && (parent.base as Record<string, unknown>).indexer === ':',
  );
  const patternIndex = methodCall ? 0 : 1;
  if (/(?:find|match|gsub)$/.test(name) && index === patternIndex) return `Lua ${name} 模式`;
  return null;
}

function luaCallName(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const node = value as Record<string, unknown>;
  if (node.type === 'Identifier') return String(node.name ?? '');
  if (node.type === 'MemberExpression') {
    const base = luaCallName(node.base);
    const identifier = luaCallName(node.identifier);
    return [base, identifier].filter(Boolean).join('.');
  }
  return '';
}

function luaPatternProtocolPrefixes(pattern: string): string[] {
  const prefixes = new Set<string>();
  for (const match of pattern.matchAll(/%\[([^|\r\n]{1,80}?)%?\|/g)) {
    for (const name of expandLuaPatternOptionals(match[1])) {
      if (/^[\p{L}_][\p{L}\p{N}\p{M}_]{0,63}$/u.test(name)) prefixes.add(`[${name}|`);
    }
  }
  return [...prefixes];
}

function expandLuaPatternOptionals(value: string): string[] {
  const optional = value.match(/^(.*)(.)\?([^?]*)$/u);
  if (!optional) return value.includes('?') ? [] : [value.replace(/%(.)/g, '$1')];
  const prefix = optional[1].replace(/%(.)/g, '$1');
  const suffix = optional[3].replace(/%(.)/g, '$1');
  return [`${prefix}${suffix}`, `${prefix}${optional[2]}${suffix}`];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractVisibleText(
  source: string,
  path: Array<string | number>,
  category: 'script-ui' | 'background-ui',
): ScannedSegment[] {
  const segments: ScannedSegment[] = [];
  const risk = category === 'script-ui' ? 'high' : 'medium';
  const hiddenRanges = hiddenContentRanges(source);
  const patterns: Array<{ kind: ScannedSegment['kind']; regex: RegExp; group: number }> = [
    { kind: 'button', regex: /\{\{button::([\s\S]*?)::[\w.-]+\}\}/g, group: 1 },
    { kind: 'text-node', regex: />([^<>]*[A-Za-z\u3040-\u30ff\uac00-\ud7af][^<>]*)</g, group: 1 },
    // A long string may end immediately after a dynamic concatenation:
    // `[[<div class="name">名称: ]] .. name .. [[</div>]]`. In that case
    // there is no closing `<` in the first fragment, so the normal text-node
    // expression cannot see the label. These boundary patterns cover only
    // the static edge of the fragment and never cross an HTML tag.
    { kind: 'text-node', regex: />([^<>]*[A-Za-z\u3040-\u30ff\uac00-\ud7af][^<>]*)$/g, group: 1 },
    { kind: 'text-node', regex: /^([^<>]*[A-Za-z\u3040-\u30ff\uac00-\ud7af][^<>]*)</g, group: 1 },
  ];

  segments.push(...extractRuntimeMessages(source, path, category));
  for (const attr of textAttributes(source)) {
    if (hiddenRanges.some(range => attr.start >= range.start && attr.end <= range.end)) continue;
    if (!likelyNeedsTranslation(attr.text)) continue;
    for (const range of subtractRanges([{ start: 0, end: attr.text.length }], templateMacros(attr.text))) {
      const value = attr.text.slice(range.start, range.end);
      const sourceText = value.trim();
      if (!likelyNeedsTranslation(sourceText)) continue;
      const start = attr.start + range.start + value.length - value.trimStart().length;
      segments.push({ path, pathLabel: `${pathLabel(path)} · <${attr.tag}> @${attr.name}`, category, risk,
        sourceText, start, end: start + sourceText.length, kind: 'attribute' });
    }
  }

  for (const definition of patterns) {
    let match: RegExpExecArray | null;
    while ((match = definition.regex.exec(source))) {
      const text = match[definition.group];
      if (!text || /<|>/.test(text)) continue;
      const relativeStart = match[0].indexOf(text);
      const baseStart = match.index + relativeStart;
      const ranges = definition.kind === 'text-node' || definition.kind === 'attribute'
        ? subtractRanges([{ start: 0, end: text.length }], templateMacros(text))
        : [{ start: 0, end: text.length }];
      for (const range of ranges) {
        const raw = text.slice(range.start, range.end);
        const leading = raw.length - raw.trimStart().length;
        const trailing = raw.length - raw.trimEnd().length;
        const sourceText = text.slice(range.start + leading, range.end - trailing);
        if (!sourceText || sourceText.length > 500 || /\{\{|\}\}/.test(sourceText)
          || looksLikeLuaCodeLiteral(sourceText) || !likelyNeedsTranslation(sourceText)) continue;
        const start = baseStart + range.start + leading;
        const end = start + sourceText.length;
        if (hiddenRanges.some((hidden) => start >= hidden.start && end <= hidden.end)) continue;
        segments.push({
          path,
          pathLabel: pathLabel(path),
          category,
          sourceText,
          start,
          end,
          risk,
          kind: definition.kind,
        });
      }
    }
  }

  return removeOverlaps(segments);
}

interface SourceRange {
  start: number;
  end: number;
}

interface TemplateMacro extends SourceRange {
  content: string;
  incomplete?: boolean;
}


function splitTextAttributes(source: string, path: Array<string | number>, category: SegmentCategory,
  risk: ScannedSegment['risk'], base: ScannedSegment[]): ScannedSegment[] {
  const hidden = hiddenContentRanges(source);
  const preferred = preferredLanguageRanges(source);
  const attributes = textAttributes(source).filter(attr => likelyNeedsTranslation(attr.text)
    && !hidden.some(range => attr.start >= range.start && attr.end <= range.end)
    && (!preferred.length || preferred.some(range => attr.start >= range.start && attr.end <= range.end)));
  if (!attributes.length) return base;
  const tags = [...source.matchAll(new RegExp(MARKUP_TOKEN_SOURCE, 'gu'))]
    .filter(tag => attributes.some(attr => attr.start >= tag.index && attr.end <= tag.index + tag[0].length))
    .map(tag => ({ start: tag.index, end: tag.index + tag[0].length }));
  const prose = base.flatMap(segment => subtractRanges([{ start: segment.start ?? 0, end: segment.end ?? source.length }], tags)
    .filter(range => likelyNeedsTranslation(stripTemplateControls(source.slice(range.start, range.end))))
    .map(range => ({ ...segment, start: range.start, end: range.end, sourceText: source.slice(range.start, range.end),
      pathLabel: `${pathLabel(path)} · 正文 ${range.start}`, kind: 'structured-text' as const })));
  return [...prose, ...attributes.map(attr => ({ path, pathLabel: `${pathLabel(path)} · <${attr.tag}> @${attr.name} · ${attr.start}`,
    category, risk, sourceText: attr.text, start: attr.start, end: attr.end, kind: 'attribute' as const }))]
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

function extractStructuredFieldText(
  source: string,
  path: Array<string | number>,
  category: SegmentCategory,
  risk: ScannedSegment['risk'],
): ScannedSegment[] {
  const languageRanges = preferredLanguageRanges(source);
  const sourceRanges = languageRanges.length ? languageRanges : [{ start: 0, end: source.length }];
  const visibleRanges = subtractRanges(sourceRanges, hiddenContentRanges(source));
  const textRanges = visibleRanges.flatMap((range) => naturalTextRanges(source, range));
  const label = pathLabel(path);

  return textRanges
    .map((range) => ({ range, sourceText: source.slice(range.start, range.end) }))
    .filter((entry) => likelyNeedsTranslation(stripTemplateControls(entry.sourceText)))
    .map((entry, index) => ({
      path,
      pathLabel: `${label} · 片段 ${index + 1}`,
      category,
      sourceText: entry.sourceText,
      start: entry.range.start,
      end: entry.range.end,
      risk,
      kind: 'structured-text',
    }));
}

function protocolAwareSegments(
  source: string,
  path: Array<string | number>,
  category: SegmentCategory,
  risk: ScannedSegment['risk'],
  baseSegments: ScannedSegment[],
  schemas: readonly ProtocolSchemaRule[],
): ScannedSegment[] {
  const matches = protocolMatchesForText(source, schemas);
  if (!matches.occupiedRanges.length) return baseSegments;

  const label = pathLabel(path);
  const outside: ScannedSegment[] = [];
  for (const segment of baseSegments) {
    const included = [{ start: segment.start ?? 0, end: segment.end ?? source.length }];
    const ranges = subtractRanges(included, matches.occupiedRanges);
    for (const range of ranges) {
      const raw = source.slice(range.start, range.end);
      const leading = raw.length - raw.trimStart().length;
      const trailing = raw.length - raw.trimEnd().length;
      const start = range.start + leading;
      const end = range.end - trailing;
      const sourceText = source.slice(start, end);
      if (!sourceText || !likelyNeedsTranslation(stripTemplateControls(sourceText))) continue;
      outside.push({
        path,
        pathLabel: `${label} · 协议外文字 ${outside.length + 1}`,
        category,
        sourceText,
        start,
        end,
        risk,
        kind: 'structured-text',
      });
    }
  }

  const preferredRanges = source.length >= LARGE_FIELD_THRESHOLD ? preferredLanguageRanges(source) : [];
  const counters = new Map<string, number>();
  const protocolFields = matches.translationRanges
    .filter((range) => !preferredRanges.length || preferredRanges.some((allowed) => range.start >= allowed.start && range.end <= allowed.end))
    .filter((range) => !isProtocolPlaceholder(range.sourceText, range.role))
    .filter((range) => likelyProtocolValueNeedsTranslation(range.sourceText))
    .map((range): ScannedSegment => {
      const counterKey = `${range.protocolName}:${range.role}`;
      const occurrence = (counters.get(counterKey) ?? 0) + 1;
      counters.set(counterKey, occurrence);
      return {
        path,
        pathLabel: `${label} · ${range.protocolName}.${range.role} ${occurrence}`,
        category,
        sourceText: range.sourceText,
        start: range.start,
        end: range.end,
        risk: risk === 'low' ? 'medium' : risk,
        kind: 'protocol-field',
        protocolDelimiter: range.delimiter,
      };
    });

  return [...outside, ...protocolFields].sort((left, right) => (left.start ?? 0) - (right.start ?? 0));
}

function isProtocolPlaceholder(sourceText: string, role: string): boolean {
  const value = sourceText.trim();
  if (/^(?:N\/?A|null|undefined|\.\.\.)$/iu.test(value)) return true;
  if (/^(?:\{[^{}]+\}\s*,?\s*)+(?:\.\.\.)?$/u.test(value)) return true;
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,80}$/u.test(value)) return false;
  const normalizedValue = value.toLowerCase().replace(/^(?:current|absolute)_/u, '').replace(/_status$/u, '');
  const normalizedRole = role.toLowerCase().replace(/^(?:current|absolute)_/u, '').replace(/_status$/u, '');
  return normalizedValue === normalizedRole;
}

function likelyProtocolValueNeedsTranslation(sourceText: string): boolean {
  const value = sourceText.trim();
  return likelyNeedsTranslation(value) || /^[\u3040-\u30ff\uac00-\ud7af]$/u.test(value);
}

function preferredLanguageRanges(source: string): SourceRange[] {
  const stack: Array<{ macro: TemplateMacro; variable?: string; language?: string }> = [];
  const branches: Array<SourceRange & { variable: string; language: string }> = [];

  for (const macro of templateMacros(source)) {
    if (macro.content.startsWith('#if ')) {
      const condition = macro.content.match(/^#if\s+\{\{equal::\{\{getvar::([^}]+)\}\}::([^}]+)\}\}$/);
      const variable = condition?.[1].trim();
      const language = condition?.[2].trim();
      stack.push({
        macro,
        variable: variable && /lang/i.test(variable) ? variable : undefined,
        language: variable && /lang/i.test(variable) ? language : undefined,
      });
      continue;
    }
    if (macro.content !== '/if') continue;
    const opening = stack.pop();
    if (opening?.variable && opening.language) {
      branches.push({
        variable: opening.variable,
        language: opening.language,
        start: opening.macro.end,
        end: macro.start,
      });
    }
  }

  const byVariable = new Map<string, Array<(typeof branches)[number]>>();
  for (const branch of branches) {
    const group = byVariable.get(branch.variable) ?? [];
    group.push(branch);
    byVariable.set(branch.variable, group);
  }

  const selected: SourceRange[] = [];
  for (const group of byVariable.values()) {
    const languages = new Set(group.map((branch) => branch.language));
    if (languages.size < 2) continue;
    const preferred = group.reduce((earliest, branch) => branch.start < earliest.start ? branch : earliest).language;
    selected.push(...group.filter((branch) => branch.language === preferred));
  }
  return mergeRanges(selected);
}

function templateMacros(source: string, includeIncomplete = false): TemplateMacro[] {
  const macros: TemplateMacro[] = [];
  let index = 0;
  while (index < source.length - 1) {
    const start = source.indexOf('{{', index);
    if (start < 0) break;
    let cursor = start;
    let depth = 0;
    let end = -1;
    while (cursor < source.length - 1) {
      if (source.startsWith('{{', cursor)) {
        depth += 1;
        cursor += 2;
        continue;
      }
      if (source.startsWith('}}', cursor)) {
        depth -= 1;
        cursor += 2;
        if (depth === 0) {
          end = cursor;
          break;
        }
        continue;
      }
      cursor += 1;
    }
    if (end < 0) {
      if (includeIncomplete) macros.push({ start, end: source.length, content: source.slice(start + 2).trim(), incomplete: true });
      break;
    }
    macros.push({ start, end, content: source.slice(start + 2, end - 2).trim() });
    index = end;
  }
  return macros;
}

function hiddenContentRanges(source: string): SourceRange[] {
  const custom = [...source.matchAll(/<GKS_HIDDEN\b[^>]*>[\s\S]*?<\/GKS_HIDDEN>/gi)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const displayNone = [...source.matchAll(/<([A-Za-z][\w:-]*)\b(?=[^>]*\bstyle\s*=\s*["'][^"']*\bdisplay\s*:\s*none\b)[^>]*>[\s\S]*?<\/\1\s*>/gi)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }));
  return mergeRanges([...custom, ...displayNone]);
}

function literalRegexSource(source: string): string | null {
  let pattern = source;
  if (pattern.startsWith('^')) pattern = pattern.slice(1);
  if (pattern.endsWith('$') && !pattern.endsWith('\\$')) pattern = pattern.slice(0, -1);
  if (!pattern) return null;

  let literal = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '\\') {
      const escaped = pattern[++index];
      if (!escaped) return null;
      if ('\\^$.*+?()[]{}|/<>-'.includes(escaped)) literal += escaped;
      else if (escaped === 'n') literal += '\n';
      else if (escaped === 'r') literal += '\r';
      else if (escaped === 't') literal += '\t';
      else return null;
      continue;
    }
    if ('.^$*+?()[]{}|'.includes(char)) return null;
    literal += char;
  }
  return literal || null;
}

function subtractRanges(included: SourceRange[], excluded: SourceRange[]): SourceRange[] {
  let result = [...included];
  for (const blocked of excluded) {
    result = result.flatMap((range) => {
      if (blocked.end <= range.start || blocked.start >= range.end) return [range];
      const remaining: SourceRange[] = [];
      if (blocked.start > range.start) remaining.push({ start: range.start, end: blocked.start });
      if (blocked.end < range.end) remaining.push({ start: blocked.end, end: range.end });
      return remaining;
    });
  }
  return result;
}

function naturalTextRanges(source: string, range: SourceRange): SourceRange[] {
  const ranges: SourceRange[] = [];
  let block: SourceRange | null = null;
  const flush = () => {
    if (!block) return;
    ranges.push(...splitSourceRange(source, block, STRUCTURED_TEXT_CHUNK_SIZE));
    block = null;
  };

  let cursor = range.start;
  while (cursor < range.end) {
    const newline = source.indexOf('\n', cursor);
    const lineBoundary = newline < 0 || newline >= range.end ? range.end : newline;
    const rawEnd = lineBoundary > cursor && source[lineBoundary - 1] === '\r' ? lineBoundary - 1 : lineBoundary;
    const line = source.slice(cursor, rawEnd);
    const leading = line.length - line.trimStart().length;
    const trailing = line.length - line.trimEnd().length;
    const contentStart = cursor + leading;
    const contentEnd = rawEnd - trailing;
    const content = source.slice(contentStart, contentEnd);

    if (!content || !likelyNeedsTranslation(stripTemplateControls(content))) {
      flush();
    } else if (block && contentEnd - block.start > STRUCTURED_TEXT_CHUNK_SIZE) {
      flush();
      block = { start: contentStart, end: contentEnd };
    } else if (block) {
      block.end = contentEnd;
    } else {
      block = { start: contentStart, end: contentEnd };
    }
    cursor = newline < 0 || newline >= range.end ? range.end : newline + 1;
  }
  flush();
  return ranges;
}

function splitSourceRange(source: string, range: SourceRange, maxChars: number): SourceRange[] {
  const ranges: SourceRange[] = [];
  let start = range.start;
  while (range.end - start > maxChars) {
    const target = start + maxChars;
    const minimum = start + Math.floor(maxChars * 0.55);
    const fragment = source.slice(minimum, target);
    let relativeBreak = Math.max(
      fragment.lastIndexOf('\n'),
      fragment.lastIndexOf('。'),
      fragment.lastIndexOf('！'),
      fragment.lastIndexOf('？'),
      fragment.lastIndexOf('. '),
    );
    if (relativeBreak < 0) relativeBreak = fragment.lastIndexOf(' ');
    const end = relativeBreak >= 0 ? minimum + relativeBreak + 1 : target;
    ranges.push({ start, end });
    start = end;
    while (start < range.end && /\s/.test(source[start])) start += 1;
  }
  if (start < range.end) ranges.push({ start, end: range.end });
  return ranges;
}

function stripTemplateControls(source: string): string {
  let output = '';
  let cursor = 0;
  for (const macro of templateMacros(source)) {
    output += source.slice(cursor, macro.start);
    cursor = macro.end;
  }
  output += source.slice(cursor);
  return output
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[^<>\n]{1,500}>/g, ' ')
    .replace(/\[-[^\]\n]*\]/g, ' ')
    .trim();
}

function isControlLiteralSegment(source: string, literals: readonly string[]): boolean {
  if (!literals.length) return false;
  const raw = source.trim();
  const visible = stripTemplateControls(source).trim();
  return literals.some((literal) => raw === literal || visible === literal);
}

function mergeRanges(ranges: SourceRange[]): SourceRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: SourceRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

function extractRuntimeMessages(
  source: string,
  path: Array<string | number>,
  category: 'script-ui' | 'background-ui',
): ScannedSegment[] {
  const segments: ScannedSegment[] = [];
  const callPattern = /\b(?:alertError|alertNormal|alertSuccess|alertWarning|alertConfirm|alert|confirm|prompt|toast|notify|showToast|showAlert|showError|showMessage|popup|toastr\.(?:error|info|success|warning))\s*\(/g;
  let call: RegExpExecArray | null;
  while ((call = callPattern.exec(source))) {
    const open = call.index + call[0].lastIndexOf('(');
    const close = findCallEnd(source, open);
    if (close < 0 || close - open > 10_000) continue;
    const argumentsText = source.slice(open + 1, close);
    const literalPattern = /(["'])((?:\\[\s\S]|(?!\1)[^\\\r\n])*)\1/g;
    let literal: RegExpExecArray | null;
    while ((literal = literalPattern.exec(argumentsText))) {
      const decoded = decodeRuntimeLiteral(literal[2]);
      if (!likelyNeedsTranslation(decoded) || decoded.length > 500) continue;
      const start = open + 1 + literal.index + 1;
      segments.push({
        path,
        pathLabel: pathLabel(path),
        category,
        sourceText: decoded,
        start,
        end: start + literal[2].length,
        risk: 'high',
        kind: 'runtime-message',
      });
    }
    callPattern.lastIndex = close + 1;
  }
  return segments;
}

function extractLuaCodeText(
  source: string,
  path: Array<string | number>,
  category: 'script-ui' | 'background-ui',
  includePromptStrings: boolean,
): ScannedSegment[] {
  const runtime = extractRuntimeMessages(source, path, category);
  const literals: ScannedSegment[] = [];

  try {
    parse(source, {
      luaVersion: '5.3',
      ranges: true,
      onCreateNode(node) {
        const ranged = node as typeof node & { range?: [number, number]; raw?: string };
        if (ranged.type !== 'StringLiteral' || !ranged.range) return;
        const raw = source.slice(ranged.range[0], ranged.range[1]);
        const literal = parseLuaLiteral(raw, ranged.range);
        if (!literal) return;
        literals.push(...extractLuaLiteralText(source, literal, ranged.range[0], path, category, includePromptStrings));
      },
    });
  } catch {
    // Risu cards can contain Lua dialect extensions or a pre-existing syntax
    // error outside the UI template. Do not abandon every visible label in
    // that code block: recover only complete quoted/long literals, then apply
    // the same HTML and natural-text filters used by the AST path.
    return removeOverlaps([
      ...runtime,
      ...recoverLuaLiteralText(source, path, category, includePromptStrings),
    ]);
  }

  return removeOverlaps([...runtime, ...literals]);
}

function extractLuaLiteralText(
  source: string,
  literal: ParsedLuaLiteral,
  literalStart: number,
  path: Array<string | number>,
  category: 'script-ui' | 'background-ui',
  includePromptStrings: boolean,
): ScannedSegment[] {
  const { decoded } = literal;
  if (isStoryLanguageDefault(source, literalStart, decoded)) {
    return [luaLiteralSegment(path, category, decoded, literal.contentStart, literal.contentEnd, 'lua-language')];
  }

  const formatted = extractLuaFormattedSegment(literal, path, category);
  if (formatted) return [formatted];

  // Risu modules commonly build one HTML template from several Lua long
  // strings around dynamic values (`[[label: ]] .. value .. [[...]]`).
  // Long strings are still source containers, not opaque code: extract their
  // visible nodes/attributes before considering natural-language prompts.
  if (literal.encoded === decoded && looksLikeEmbeddedVisibleText(decoded)) {
    const visible = extractVisibleText(decoded, path, category).map((segment) => ({
      ...segment,
      start: literal.contentStart + (segment.start ?? 0),
      end: literal.contentStart + (segment.end ?? 0),
      kind: luaVisibleKind(segment.kind),
    }));
    if (visible.length) return visible;
  }

  if (!includePromptStrings || looksLikeLuaCodeLiteral(decoded)) return [];
  if (!likelyLuaNaturalText(decoded, literal.long ? 12_000 : 2000)) return [];
  return [{
    path,
    pathLabel: pathLabel(path),
    category,
    sourceText: decoded,
    start: literal.long ? literalStart : literal.contentStart,
    end: literal.long ? literalStart + literal.rawLength : literal.contentEnd,
    risk: 'high',
    kind: literal.long ? 'lua-long-string' : 'lua-string',
  }];
}

/**
 * A small lexical recovery path for malformed or extended Lua. It deliberately
 * recognizes only complete quoted and long-bracket literals, skipping comments
 * and unterminated values, so malformed code cannot turn arbitrary source spans
 * into translation candidates.
 */
function recoverLuaLiteralText(
  source: string,
  path: Array<string | number>,
  category: 'script-ui' | 'background-ui',
  includePromptStrings: boolean,
): ScannedSegment[] {
  const segments: ScannedSegment[] = [];
  let index = 0;
  while (index < source.length) {
    if (source.startsWith('--', index)) {
      const block = luaLongBracketAt(source, index + 2);
      if (block) {
        const close = source.indexOf(block.close, block.contentStart);
        index = close < 0 ? source.length : close + block.close.length;
        continue;
      }
      const newline = source.indexOf('\n', index + 2);
      index = newline < 0 ? source.length : newline + 1;
      continue;
    }

    const long = luaLongBracketAt(source, index);
    if (long) {
      const close = source.indexOf(long.close, long.contentStart);
      if (close < 0) {
        index += long.open.length;
        continue;
      }
      const end = close + long.close.length;
      const literal = parseLuaLiteral(source.slice(index, end), [index, end]);
      if (literal) segments.push(...extractLuaLiteralText(source, literal, index, path, category, includePromptStrings));
      index = end;
      continue;
    }

    const quote = source[index];
    if (quote === '"' || quote === "'") {
      const end = luaQuotedLiteralEnd(source, index, quote);
      if (end < 0) {
        index += 1;
        continue;
      }
      const literal = parseLuaLiteral(source.slice(index, end), [index, end]);
      if (literal) segments.push(...extractLuaLiteralText(source, literal, index, path, category, includePromptStrings));
      index = end;
      continue;
    }
    index += 1;
  }
  return segments;
}

function luaLongBracketAt(source: string, start: number): { open: string; close: string; contentStart: number } | null {
  const match = source.slice(start).match(/^\[(=*)\[/u);
  if (!match) return null;
  const open = match[0];
  return { open, close: `]${match[1]}]`, contentStart: start + open.length };
}

function luaQuotedLiteralEnd(source: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === quote) return index + 1;
    if (char === '\n' || char === '\r') return -1;
  }
  return -1;
}

function likelyLuaNaturalText(value: string, maxLength = 2000): boolean {
  const text = value.trim();
  if (text.length > maxLength || !likelyNeedsTranslation(text)) return false;
  if (looksLikeLuaCodeLiteral(text) || /^<\/?[A-Za-z!]/.test(text)) return false;
  if (/^[\w./:#-]+$/.test(text)) return false;
  return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text)
    || (text.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0) >= 2;
}

function looksLikeLuaCodeLiteral(value: string): boolean {
  const text = value.trim();
  return /^<!--[^\n]*-->$/.test(text)
    || /%[-acdlpsuwxz%]|\[\^|\[%[a-z]/i.test(text);
}

interface ParsedLuaLiteral {
  encoded: string;
  decoded: string;
  contentStart: number;
  contentEnd: number;
  long: boolean;
  rawLength: number;
}

function parseLuaLiteral(raw: string, range: [number, number]): ParsedLuaLiteral | null {
  const quote = raw[0];
  if ((quote === '"' || quote === "'") && raw.at(-1) === quote) {
    const encoded = raw.slice(1, -1);
    return {
      encoded,
      decoded: decodeRuntimeLiteral(encoded),
      contentStart: range[0] + 1,
      contentEnd: range[1] - 1,
      long: false,
      rawLength: range[1] - range[0],
    };
  }
  const long = raw.match(/^\[(=*)\[([\s\S]*)\]\1\]$/);
  if (!long) return null;
  const delimiterLength = long[1].length + 2;
  return {
    encoded: long[2],
    decoded: long[2],
    contentStart: range[0] + delimiterLength,
    contentEnd: range[1] - delimiterLength,
    long: true,
    rawLength: range[1] - range[0],
  };
}

function extractLuaFormattedSegment(
  literal: ParsedLuaLiteral,
  path: Array<string | number>,
  category: 'script-ui' | 'background-ui',
): ScannedSegment | null {
  if (literal.long) return null;
  const separator = literal.encoded.lastIndexOf('|');
  if (separator < 1 || separator === literal.encoded.length - 1) return null;
  const prefix = decodeRuntimeLiteral(literal.encoded.slice(0, separator));
  const suffix = decodeRuntimeLiteral(literal.encoded.slice(separator + 1));
  if (!/^[A-Za-z0-9_.:-]+$/.test(prefix) || !likelyLuaNaturalText(suffix)) return null;
  return luaLiteralSegment(
    path,
    category,
    suffix,
    literal.contentStart + separator + 1,
    literal.contentEnd,
    'lua-formatted',
  );
}

function luaLiteralSegment(
  path: Array<string | number>,
  category: 'script-ui' | 'background-ui',
  sourceText: string,
  start: number,
  end: number,
  kind: SegmentKind,
): ScannedSegment {
  return { path, pathLabel: pathLabel(path), category, sourceText, start, end, risk: 'high', kind };
}

function looksLikeEmbeddedVisibleText(value: string): boolean {
  return /\{\{button::|<\/?[A-Za-z][^>]*>/.test(value);
}

function luaVisibleKind(kind: SegmentKind): SegmentKind {
  if (kind === 'button') return 'lua-button';
  if (kind === 'attribute') return 'lua-attribute';
  if (kind === 'text-node') return 'lua-text-node';
  return kind;
}

function isStoryLanguageDefault(source: string, literalStart: number, value: string): boolean {
  if (value !== 'ko') return false;
  const prefix = source.slice(Math.max(0, literalStart - 100), literalStart);
  return /writeVar\s*\(\s*triggerId\s*,\s*["']th_story_lang["']\s*,\s*$/.test(prefix);
}

function findCallEnd(source: string, open: number): number {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === '\n' || char === '\r') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')' && --depth === 0) return index;
  }
  return -1;
}

function decodeRuntimeLiteral(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== '\\' || index + 1 >= value.length) {
      output += value[index];
      continue;
    }
    const escaped = value[++index];
    const simple: Record<string, string> = {
      n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0',
      '\\': '\\', '"': '"', "'": "'",
    };
    if (Object.hasOwn(simple, escaped)) {
      output += simple[escaped];
      continue;
    }
    if ((escaped === 'u' || escaped === 'x')) {
      const length = escaped === 'u' ? 4 : 2;
      const digits = value.slice(index + 1, index + 1 + length);
      if (new RegExp(`^[0-9a-fA-F]{${length}}$`).test(digits)) {
        output += String.fromCharCode(Number.parseInt(digits, 16));
        index += length;
        continue;
      }
    }
    if (escaped !== '\n' && escaped !== '\r') output += escaped;
  }
  return output;
}

function isEncodedLiteralSegment(kind: SegmentKind | undefined): boolean {
  return kind === 'runtime-message'
    || kind === 'lua-string'
    || kind === 'lua-formatted'
    || kind === 'lua-language'
    || kind === 'lua-button'
    || kind === 'lua-attribute'
    || kind === 'lua-text-node';
}

function requiresQuotedLiteralContext(kind: SegmentKind | undefined): boolean {
  return kind === 'runtime-message'
    || kind === 'lua-string'
    || kind === 'lua-formatted'
    || kind === 'lua-language';
}

function enclosingQuote(source: string, start: number): string {
  const lineStart = source.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  let quote = '';
  let escaped = false;
  for (let index = lineStart; index < start; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    }
  }
  return quote;
}

function encodeRuntimeLiteral(value: string, quote: string): string {
  if (quote !== '"' && quote !== "'") return value;
  let output = value
    .replaceAll('\\', '\\\\')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n')
    .replaceAll('\t', '\\t')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  if (quote === '"' || quote === "'") output = output.replaceAll(quote, `\\${quote}`);
  return output;
}

function encodeLuaLongString(value: string, preferredEquals = ''): string {
  let equals = preferredEquals;
  // A value ending with the delimiter prefix would close the long string one
  // character early after concatenation, e.g. JSON `}]` + `]]` => `}]]]`.
  while (value.includes(`]${equals}]`) || value.endsWith(`]${equals}`)) equals += '=';
  return `[${equals}[${value}]${equals}]`;
}

// Scan even syntactically broken Lua: stale translated ranges must never land
// inside identifiers. Embedded HTML may live in long strings, not just quotes.
function luaLiteralRanges(source: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let index = 0;
  while (index < source.length) {
    const comment = source.startsWith('--', index);
    const open = index + (comment ? 2 : 0);
    const long = source.slice(open, open + 100).match(/^\[(=*)\[/u);
    if (long) {
      const close = `]${long[1]}]`;
      const closeAt = source.indexOf(close, open + long[0].length);
      const end = closeAt < 0 ? source.length : closeAt + close.length;
      if (!comment) ranges.push({ start: open, end });
      index = end;
    } else if (comment) {
      const end = source.indexOf('\n', index);
      index = end < 0 ? source.length : end + 1;
    } else if (source[index] === '"' || source[index] === "'") {
      const quote = source[index++];
      const start = index;
      while (index < source.length && source[index] !== quote) {
        index += source[index] === '\\' ? 2 : 1;
      }
      ranges.push({ start, end: Math.min(index, source.length) });
      index++;
    } else index++;
  }
  return ranges;
}

function resolveSegmentRanges(
  source: string,
  segments: ApplicableSegment[],
  literalRanges?: Array<{ start: number; end: number }>,
): Array<{ segment: ApplicableSegment; start: number; end: number }> {
  const used: Array<{ start: number; end: number }> = [];
  const resolved: Array<{ segment: ApplicableSegment; start: number; end: number }> = [];
  const overlaps = (start: number, end: number) => used.some((range) => start < range.end && end > range.start);

  for (const segment of [...segments].sort((a, b) => (a.start ?? 0) - (b.start ?? 0))) {
    const originalStart = segment.start ?? 0;
    const originalEnd = segment.end ?? originalStart;
    if (!overlaps(originalStart, originalEnd)
      && (!literalRanges || literalRanges.some(range => originalStart >= range.start && originalEnd <= range.end))
      && segmentRangeMatches(source, segment, originalStart, originalEnd)) {
      used.push({ start: originalStart, end: originalEnd });
      resolved.push({ segment, start: originalStart, end: originalEnd });
      continue;
    }

    // Long strings include their delimiters in the replacement range. Without a
    // trustworthy old range, guessing their boundaries is more dangerous than
    // leaving the approved translation unapplied.
    if (segment.kind === 'lua-long-string') continue;
    const candidates = segmentRangeCandidates(source, segment)
      .filter((candidate) => !overlaps(candidate.start, candidate.end)
        && (!literalRanges || literalRanges.some(range => candidate.start >= range.start && candidate.end <= range.end)))
      .sort((a, b) => Math.abs(a.start - originalStart) - Math.abs(b.start - originalStart));
    const candidate = candidates[0];
    if (!candidate) continue;
    used.push(candidate);
    resolved.push({ segment, ...candidate });
  }
  return resolved;
}

function segmentRangeMatches(
  source: string,
  segment: ApplicableSegment,
  start: number,
  end: number,
): boolean {
  if (start < 0 || end < start || end > source.length) return false;
  if (segment.sourceText == null) return true;
  // Regular Lua literal scans store offsets for the content inside quotes.
  // When an older scan is replayed against a translated draft, the same text
  // can occur inside an identifier (for example `flashback then`). Never
  // replace that code token just because the stale offset happens to match.
  if (requiresQuotedLiteralContext(segment.kind) && !enclosingQuote(source, start)) return false;
  const raw = source.slice(start, end);
  if (segment.kind === 'lua-long-string') {
    return raw.startsWith('[') && raw.endsWith(']') && raw.includes(segment.sourceText ?? '');
  }
  return isEncodedLiteralSegment(segment.kind)
    ? decodeRuntimeLiteral(raw) === (segment.sourceText ?? '')
    : raw === (segment.sourceText ?? '');
}

function segmentRangeCandidates(
  source: string,
  segment: ApplicableSegment,
): Array<{ start: number; end: number }> {
  const sourceText = segment.sourceText ?? '';
  if (!sourceText) return [];
  const needles = isEncodedLiteralSegment(segment.kind)
    ? [...new Set([sourceText, encodeRuntimeLiteral(sourceText, '"'), encodeRuntimeLiteral(sourceText, "'")])]
    : [sourceText];
  const candidates: Array<{ start: number; end: number }> = [];
  for (const needle of needles) {
    if (!needle) continue;
    let index = source.indexOf(needle);
    while (index >= 0) {
      const end = index + needle.length;
      if (segmentRangeMatches(source, segment, index, end)) candidates.push({ start: index, end });
      index = source.indexOf(needle, index + Math.max(1, needle.length));
    }
  }
  return candidates;
}

function luaLongStringEquals(raw: string): string {
  return raw.match(/^\[(=*)\[/)?.[1] ?? '';
}

function preserveBoundaryWhitespace(original: string, translated: string): string {
  const leading = original.match(/^\s*/)?.[0] ?? '';
  const trailing = original.match(/\s*$/)?.[0] ?? '';
  return `${leading}${translated.trim()}${trailing}`;
}

function addSourceLocations(source: string, segments: ScannedSegment[]): ScannedSegment[] {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') lineStarts.push(index + 1);
  }
  return segments.map((segment) => {
    if (segment.start == null) return segment;
    let low = 0;
    let high = lineStarts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineStarts[middle] <= segment.start) low = middle;
      else high = middle;
    }
    const line = low + 1;
    const column = segment.start - lineStarts[low] + 1;
    return { ...segment, pathLabel: `${segment.pathLabel} · 行 ${line}，列 ${column}` };
  });
}

function removeOverlaps(segments: ScannedSegment[]): ScannedSegment[] {
  const sorted = [...segments].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const accepted: ScannedSegment[] = [];
  for (const segment of sorted) {
    if (accepted.some((entry) => overlaps(entry, segment))) continue;
    accepted.push(segment);
  }
  return accepted;
}

function overlaps(left: ScannedSegment, right: ScannedSegment): boolean {
  return (left.start ?? 0) < (right.end ?? 0) && (left.end ?? 0) > (right.start ?? 0);
}

function fieldSegment(
  path: Array<string | number>,
  text: string,
  category: SegmentCategory,
  risk: ScannedSegment['risk'],
): ScannedSegment {
  return { path, pathLabel: pathLabel(path), category, sourceText: text, start: null, end: null, risk, kind: 'field' };
}

function isLorebookPath(path: Array<string | number>): boolean {
  return path.some((part) => /(lore|book|character_book|world_info|entries)/i.test(String(part)));
}

function isLorebookKeywordPath(path: Array<string | number>): boolean {
  const key = String(path.at(-1) ?? '').replaceAll('-', '_').toLowerCase();
  return isLorebookPath(path.slice(0, -1))
    && ['key', 'keys', 'keywords', 'secondary_keys', 'secondarykeys'].includes(key);
}

function isAlwaysActiveLorebookEntry(value: Record<string, unknown>): boolean {
  return Boolean(value.constant ?? value.forceActivation ?? value.alwaysActive ?? value.always_active);
}

function isRegexLorebookEntry(value: Record<string, unknown>): boolean {
  return Boolean(value.use_regex ?? value.useRegex);
}

function appendLorebookKeywordAlias(
  draft: Record<string, unknown>,
  sourcePath: Array<string | number>,
  alias: string,
): void {
  const source = getAt(draft, sourcePath);
  if (typeof source !== 'string') return;
  const keywords = getAt(draft, sourcePath.slice(0, -1));
  if (!Array.isArray(keywords)) return;
  const normalized = alias.trim();
  if (!normalized || normalized === source.trim()) return;
  const folded = normalized.toLocaleLowerCase();
  if (keywords.some((keyword) => typeof keyword === 'string' && keyword.trim().toLocaleLowerCase() === folded)) return;
  keywords.push(normalized);
}

function isScriptPath(path: Array<string | number>): boolean {
  return path.some((part) => /^(customscripts?|triggerscripts?|scripts?|regexscripts?|regex|virtualscript|cjs)$/i.test(
    String(part).replaceAll('_', '').replaceAll('-', ''),
  ));
}

function isBackgroundPath(path: Array<string | number>): boolean {
  return path.some((part) => /^backgroundhtml$/i.test(String(part)));
}

function isGenericProtectedPath(path: Array<string | number>, key: string): boolean {
  if (/^(?:id|uuid|guid|key|code|type|state|status|mode|viewScreen|view_screen|class|className|style|path|file|filename|asset|url|src|href|regex|pattern|script|lua|css|html|version|spec|spec_version|format|hash|sha|mime|extension|language|lang|targetLanguage|sourceLanguage|trigger|action|enabled|probability|order|count|index)$/iu.test(key)) return true;
  return path.some((part) => /^(?:assets?|chats?|chatPage|sdData|vits|regex|triggers?|customscripts?|scripts?|virtualscript|cjs)$/iu.test(String(part)));
}

/**
 * Segment kinds that copy plain card/module text through the generic scan.
 *
 * Script, Lua and resource rows live under the very paths this protection list
 * rejects (`customscript`, `regex`, `assets`) and follow their own extraction
 * rules instead, so re-checking them here would drop legitimate translations.
 */
const GENERIC_COPY_KINDS = new Set(['field', 'structured-text', 'protocol-field']);

/**
 * Re-apply scan-time path protection to a stored segment.
 *
 * `isGenericProtectedPath()` only runs while scanning, so a row created before
 * a key joined the protected list stays in the database, stays approved, and
 * is written back by `applyApprovedSegments()`. That is how a Risu card's
 * `viewScreen: "none"` became `无` in an already translated project. Applying
 * and exporting therefore re-check the path instead of trusting the stored
 * review state; the row is ignored until the project is scanned again.
 */
export function isProtectedStoredPath(
  kind: string | undefined,
  path: Array<string | number>,
  module?: Record<string, unknown> | null,
): boolean {
  // Revalidate even ranged HTML/button rows: a variable reference may look like HTML.
  // Lua code retains its dedicated literal extraction and writeback rules.
  if (isRisuTriggerEffectFieldPath(path) && !isLuaModuleCodePath(path)) {
    return !module || !risuTriggerEffectCopyField(module, path);
  }
  if (!GENERIC_COPY_KINDS.has(String(kind))) return false;
  return isGenericProtectedPath(path, String(path.at(-1) ?? ''));
}

/**
 * Draft paths where a stored approved row still overrides a now-protected
 * field. Drafts saved before the protection list grew keep the stale write even
 * after the row is gone, so exporting them is refused until the project is saved
 * again: saving rebuilds the draft from the original plus the rows that are
 * still translatable.
 */
export function staleProtectedDraftPaths(
  original: Record<string, unknown>,
  draft: Record<string, unknown>,
  segments: ReadonlyArray<Pick<ApplicableSegment, 'pathJson' | 'pathLabel' | 'kind' | 'reviewStatus'>>,
): string[] {
  const stale: string[] = [];
  for (const segment of segments) {
    if (segment.reviewStatus !== 'approved') continue;
    const path = parseSegmentPath(segment.pathJson);
    if (!path || !isProtectedStoredPath(segment.kind, path, original)) continue;
    const source = getAt(original, path);
    const candidate = getAt(draft, path);
    if (typeof source === 'string' && typeof candidate === 'string' && candidate !== source) {
      stale.push(segment.pathLabel || segment.pathJson);
    }
  }
  return stale;
}

/** Repair only stored writes that now fail trigger protection, retaining unrelated draft work. */
export function restoreProtectedModuleDraft(
  original: Record<string, unknown>,
  draft: Record<string, unknown>,
  segments: ReadonlyArray<Pick<ApplicableSegment, 'pathJson' | 'kind' | 'reviewStatus'>>,
): Record<string, unknown> {
  const restored = structuredClone(draft);
  for (const segment of segments) {
    const raw = parseSegmentPath(segment.pathJson);
    if (!raw || raw[0] !== '$module') continue;
    const path = raw.slice(1);
    if (!isRisuTriggerEffectFieldPath(path) || !isProtectedStoredPath(segment.kind, path, original)) continue;
    const source = getAt(original, path);
    if (typeof source === 'string') setAt(restored, path, source);
  }
  return restored;
}

function parseSegmentPath(pathJson: string): Array<string | number> | null {
  try {
    const parsed = JSON.parse(pathJson) as unknown;
    return Array.isArray(parsed) ? parsed as Array<string | number> : null;
  } catch {
    return null;
  }
}

function isGreetingPath(path: Array<string | number>): boolean {
  return path.some((part) => GREETING_KEYS.has(String(part)));
}

function likelyNeedsTranslation(text: string): boolean {
  const value = text.trim();
  if (value.length < 2 || /^[\s\d_./:#?&=%-]+$/.test(value)) return false;
  const sourceScriptCount = (value.match(/\p{L}/gu) ?? []).length;
  const chineseCount = (value.match(/[\u3400-\u9fff]/g) ?? []).length;
  return sourceScriptCount > 1 && sourceScriptCount > chineseCount * 0.5;
}

export function isLikelyTranslatableText(text: string): boolean {
  return likelyNeedsTranslation(text);
}

function keywordMayNeedAlias(keyword: string, sourceLanguage: string): boolean {
  if (!likelyNeedsTranslation(keyword)) return false;
  const language = sourceLanguage.trim().toLowerCase();
  if (!language || language === 'auto') return /[\uac00-\ud7af]/u.test(keyword);
  if (language.startsWith('zh') || /chinese|中文|简体|繁体/.test(language)) return /[\u3400-\u9fff]/u.test(keyword);
  if (language.startsWith('ko') || /korean|韩/.test(language)) return /[\uac00-\ud7af]/u.test(keyword);
  if (language.startsWith('ja') || /japanese|日语|日本語/.test(language)) return /[\u3040-\u30ff\u3400-\u9fff]/u.test(keyword);
  return true;
}

function pathLabel(path: Array<string | number>): string {
  return path.map((part) => part === '$module' ? '模块' : String(part)).join('.');
}

function getAt(root: Record<string, unknown>, path: Array<string | number>): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[part];
  }
  return current;
}

function setAt(root: Record<string, unknown>, path: Array<string | number>, value: unknown): void {
  let current: Record<string | number, unknown> = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    current = current[path[index]] as Record<string | number, unknown>;
  }
  current[path[path.length - 1]] = value;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}
