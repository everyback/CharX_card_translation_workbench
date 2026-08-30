import { parse } from 'luaparse';
import {
  applyApprovedSegments,
  isLuaModuleCodePath,
  type ApplicableSegment,
} from './card.js';

export interface LuaSyntaxIssue {
  pathLabel: string;
  message: string;
}

export interface RisuModuleApplyResult {
  draft: Record<string, unknown>;
  ignoredLuaSegments: number;
  runtimeAliasAdditions: number;
  syntaxIssues: LuaSyntaxIssue[];
}

export interface RisuRuntimeAliasIssue {
  pathLabel: string;
  ownerId: string;
  alias: string;
}

export interface RisuPortraitFeatureDetection {
  detected: boolean;
  signals: string[];
  codePaths: string[];
}

/** Detect the optional image-routing layer before presenting name candidates. */
export function detectRisuPortraitRouting(module: Record<string, unknown>): RisuPortraitFeatureDetection {
  const codeValues: Array<{ path: string; text: string }> = [];
  const visit = (value: unknown, path: Array<string | number>): void => {
    if (typeof value === 'string') {
      if (path.includes('code')) codeValues.push({ path: path.join('.'), text: value });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, child]) => visit(child, [...path, key]));
  };
  visit(module, ['$module']);
  const source = codeValues.map((entry) => entry.text).join('\n');
  const signals: string[] = [];
  const imagePattern = /<img\b|\bimg\s+src\b|\b(?:portrait|立绘|character[_ -]?image|character[_ -]?sprite)\b|\bth[_ -]?(?:asset|image|portrait)\b|\b(?:sfw|nsfw)[_-][A-Za-z0-9]/iu;
  const catalogPattern = /\b(?:aliases?|nameAliases?|owner(?:Id)?|character(?:Id)?|runtime(?:Roster|Catalog)?|asset(?:Index|Router)|TouhouAsset(?:Index|Operation))\b/iu;
  if (imagePattern.test(source)) signals.push('发现图片 / 立绘输出标记');
  if (catalogPattern.test(source)) signals.push('发现角色名称或资源目录');
  const detected = imagePattern.test(source) && catalogPattern.test(source);
  return { detected, signals, codePaths: codeValues.map((entry) => entry.path) };
}

export type RuntimeAliasMap = Record<string, string[]>;

export interface RuntimeAliasTranslationCandidate {
  ownerId: string;
  aliases: string[];
}

export function collectRuntimeAliasCandidates(
  module: Record<string, unknown>,
  targetLanguage: string,
  additionalAliasSource?: Record<string, unknown>,
): Array<{ ownerId: string; name: string }> {
  const aliases = collectRuntimeOwnerAliases(targetLanguage, module, additionalAliasSource);
  return [...aliases.entries()].flatMap(([ownerId, names]) => names
    .filter((name) => name.length >= 2 && /\p{L}/u.test(name))
    .map((name) => ({ ownerId, name })));
}

/**
 * Find catalog owners that have no names in the selected output language.
 * The provider receives only these names, never arbitrary Lua or asset keys.
 */
export function collectRuntimeAliasTranslationCandidates(
  module: Record<string, unknown>,
  targetLanguage: string,
): RuntimeAliasTranslationCandidate[] {
  if (!targetLanguage.trim()) return [];
  const result = new Map<string, RuntimeAliasTranslationCandidate>();
  visitLuaCode(module, (source) => {
    forEachRuntimeCatalog(source, (catalog) => {
      for (const entry of catalog) {
        const ownerId = runtimeEntryIdentity(entry);
        const aliasField = runtimeEntryAliasField(entry);
        if (!ownerId || !aliasField || aliasField.values.some((alias) => isLikelyTargetAlias(alias, targetLanguage))) continue;
        const aliases = aliasField.values
          .map((alias) => alias.trim())
          .filter((alias) => alias.length >= 2 && alias.length <= 80 && /\p{L}/u.test(alias))
          .filter((alias, index, all) => all.findIndex((item) => aliasKey(item) === aliasKey(alias)) === index)
          .slice(0, 12);
        if (aliases.length) result.set(ownerId.toLocaleLowerCase(), { ownerId, aliases });
      }
    });
  });
  return [...result.values()].sort((left, right) => left.ownerId.localeCompare(right.ownerId));
}

export function applyRisuModuleSegments(
  original: Record<string, unknown>,
  segments: ApplicableSegment[],
  targetLanguage = '',
  additionalAliasSource?: Record<string, unknown>,
  runtimeAliases?: RuntimeAliasMap,
): RisuModuleApplyResult {
  let ignoredLuaSegments = 0;
  const safeSegments = segments.filter((segment) => {
    const path = parsePath(segment.pathJson);
    if (!isLuaModuleCodePath(path)
      || segment.kind === 'runtime-message'
      || segment.kind === 'lua-string'
      || segment.kind === 'lua-formatted'
      || segment.kind === 'lua-long-string'
      || segment.kind === 'lua-language') return true;
    if (segment.kind === 'lua-button'
      || segment.kind === 'lua-attribute'
      || segment.kind === 'lua-text-node') return true;
    if (wouldChangeSource(segment)) ignoredLuaSegments += 1;
    return false;
  });
  const draft = applySelectedLanguagePromptBridge(applyApprovedSegments(original, safeSegments));
  const runtimeAliasAdditions = synchronizeTouhouRuntimeAliases(draft, targetLanguage, additionalAliasSource)
    + synchronizeRuntimeAliasMap(draft, runtimeAliases);
  return {
    draft,
    ignoredLuaSegments,
    runtimeAliasAdditions,
    syntaxIssues: validateRisuLuaChanges(original, draft),
  };
}

export function synchronizeRuntimeAliasMap(module: Record<string, unknown>, aliases?: RuntimeAliasMap): number {
  if (!aliases || !Object.keys(aliases).length) return 0;
  const normalized = new Map<string, string[]>(Object.entries(aliases)
    .map(([ownerId, values]) => [ownerId.toLocaleLowerCase(), values] as const));
  return synchronizeRuntimeAliases(module, normalized);
}

const OWNER_INDEX_LINE = /^[\t ]*(?:[-*][\t ]*)?[`"“']?([A-Za-z][A-Za-z0-9_.:-]{0,127})[`"”']?[\t ]*(?:=|:|是|为|->|=>)[\t ]*([^\[\r\n<]{1,160})/gmu;
const TARGET_ALIAS_RECORD = /\{\s*label\s*=\s*(["'])(.*?)\1\s*,\s*aliases\s*=\s*\{([\s\S]*?)\}\s*\}/gu;
const OWNER_ID_FIELDS = ['id', 'entity_id', 'entityId', 'owner_id', 'ownerId', 'bucket', 'character_id', 'characterId'];
const ALIAS_ARRAY_FIELDS = ['aliases', 'alias', 'names', 'name_aliases', 'nameAliases', 'triggers', 'keywords'];
const DISPLAY_NAME_FIELDS = [
  'name', 'display_name', 'displayName', 'localized_name', 'localizedName',
  'character_name', 'characterName', 'label', 'translation', 'translated_name', 'translatedName',
];

/**
 * A translated attachment index names each runtime owner id, while the
 * Lua renderer routes a response only through that owner's aliases. Keep both
 * registries aligned without inventing translations or touching resource keys.
 */
export function inspectRuntimeAliasCoverage(
  module: Record<string, unknown>,
  targetLanguage: string,
  additionalAliasSource?: Record<string, unknown>,
): RisuRuntimeAliasIssue[] {
  const localizedAliases = collectRuntimeOwnerAliases(targetLanguage, module, additionalAliasSource);
  if (!localizedAliases.size) return [];

  const issues: RisuRuntimeAliasIssue[] = [];
  const seen = new Set<string>();
  visitLuaCode(module, (source, path) => {
    forEachRuntimeCatalog(source, (catalog) => {
      for (const entry of catalog) {
        const identity = runtimeEntryIdentity(entry);
        const aliasField = runtimeEntryAliasField(entry);
        if (!identity || !aliasField) continue;
        const aliases = localizedAliases.get(identity.toLocaleLowerCase()) ?? [];
        for (const alias of aliases) {
          if (aliasField.values.some((existing) => aliasKey(existing) === aliasKey(alias))) continue;
          const key = `${JSON.stringify(path)}\u0000${identity}\u0000${alias}`;
          if (seen.has(key)) continue;
          seen.add(key);
          issues.push({
            pathLabel: `模块.${path.join('.')}`,
            ownerId: identity,
            alias,
          });
        }
      }
    });
  });
  return issues;
}

// Kept as a compatibility alias for integrations that used the initial name.
export const inspectTouhouRuntimeAliasCoverage = inspectRuntimeAliasCoverage;

function synchronizeTouhouRuntimeAliases(
  module: Record<string, unknown>,
  targetLanguage: string,
  additionalAliasSource?: Record<string, unknown>,
): number {
  const localizedAliases = collectRuntimeOwnerAliases(targetLanguage, module, additionalAliasSource);
  return synchronizeRuntimeAliases(module, localizedAliases);
}

function synchronizeRuntimeAliases(
  module: Record<string, unknown>,
  localizedAliases: Map<string, string[]>,
): number {
  if (!localizedAliases.size) return 0;

  let additions = 0;
  visitLuaCode(module, (source, _path, replace) => {
    let result = source;
    let changed = false;
    for (const node of collectLuaStringNodes(source).sort((left, right) => right.start - left.start)) {
      const decoded = decodeLuaString(node.raw);
      if (decoded == null) continue;
      const updated = updateRuntimeCatalogText(decoded, localizedAliases);
      if (!updated.changed) continue;
      result = `${result.slice(0, node.start)}${encodeLuaString(updated.text, node.raw)}${result.slice(node.end)}`;
      additions += updated.additions;
      changed = true;
    }
    if (changed) replace(result);
  });
  return additions;
}

function collectRuntimeOwnerAliases(targetLanguage: string, module: unknown, additionalAliasSource?: unknown): Map<string, string[]> {
  if (!targetLanguage.trim()) return new Map();
  const result = new Map<string, string[]>();
  const derived = new Map<string, Map<string, Set<string>>>();
  const knownOwnerIds = collectRuntimeOwnerIds(module);
  if (additionalAliasSource) collectRuntimeOwnerIds(additionalAliasSource, knownOwnerIds);
  collectRuntimeOwnerAliasesFromSource(module, targetLanguage, result, knownOwnerIds, false, derived);
  if (additionalAliasSource) collectRuntimeOwnerAliasesFromSource(additionalAliasSource, targetLanguage, result, knownOwnerIds, true, derived);
  appendUniqueDerivedAliases(result, derived);
  return result;
}

function collectRuntimeOwnerAliasesFromSource(
  source: unknown,
  targetLanguage: string,
  output: Map<string, string[]>,
  knownOwnerIds: Set<string>,
  parseStructuredStrings: boolean,
  derived: Map<string, Map<string, Set<string>>>,
): void {
  const visit = (value: unknown, path: string[]): void => {
    if (typeof value === 'string') {
      if (path.includes('code')) collectTargetAliasTableAliases(value, targetLanguage, output, derived);
      else collectOwnerIndexAliases(value, targetLanguage, output, knownOwnerIds, derived);
      if (parseStructuredStrings && !path.includes('code')) {
        const parsed = tryParseJson(value);
        if (parsed !== undefined) collectStructuredOwnerAliases(parsed, targetLanguage, output, knownOwnerIds, derived);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, String(index)]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) visit(child, [...path, key]);
  };
  visit(source, []);
  if (parseStructuredStrings) collectStructuredOwnerAliases(source, targetLanguage, output, knownOwnerIds, derived);
}

function collectOwnerIndexAliases(
  value: string,
  targetLanguage: string,
  output: Map<string, string[]>,
  knownOwnerIds: Set<string>,
  derived: Map<string, Map<string, Set<string>>>,
): void {
  const isSpellIndex = /THGY_SIGNATURE_SPELL_INDEX|TouhouUniqueSpellIndexV2|签名符卡索引|独特符卡索引/iu.test(value);
  for (const match of value.matchAll(OWNER_INDEX_LINE)) {
    if (!knownOwnerIds.has(match[1].toLocaleLowerCase())) continue;
    // Spell/unique-spell indexes name effects, not character identities. They
    // must never become portrait routing aliases.
    if (isSpellIndex || /(?:->|<img\s*=|\bspell\b|符卡|弹幕|弾幕|스펠)/iu.test(match[2])) continue;
    for (const alias of normalizeOwnerAliases(match[2])) {
      if (isLikelyTargetAlias(alias, targetLanguage)) addLocalizedRuntimeAlias(output, derived, match[1], alias, targetLanguage);
    }
  }
}

/**
 * The Touhou module keeps its character/place roster in a Lua table rather
 * than JSON. Read that table as the authoritative portrait-name source.
 */
function collectTargetAliasTableAliases(
  source: string,
  targetLanguage: string,
  output: Map<string, string[]>,
  derived: Map<string, Map<string, Set<string>>>,
): void {
  for (const record of source.matchAll(TARGET_ALIAS_RECORD)) {
    const aliases = [...record[3].matchAll(/["']([^"']+)["']/gu)].map((match) => match[1].trim());
    // The first alias in this table is the stable owner id. Some canonical
    // ids (for example `chen` or `cirno`) do not contain an underscore.
    const ownerId = aliases.find((alias) => /^[A-Za-z][A-Za-z0-9_.:-]{1,127}$/u.test(alias));
    if (!ownerId) continue;
    const names = [record[2].trim(), ...aliases]
      .filter((name) => name.length >= 2 && isLikelyTargetAlias(name, targetLanguage));
    for (const name of names) addLocalizedRuntimeAlias(output, derived, ownerId, name, targetLanguage);
  }
}

function collectStructuredOwnerAliases(
  value: unknown,
  targetLanguage: string,
  output: Map<string, string[]>,
  knownOwnerIds: Set<string>,
  derived: Map<string, Map<string, Set<string>>>,
): void {
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== 'object') return;
    const record = current as Record<string, unknown>;
    const ownerId = runtimeEntryIdentity(record);
    if (ownerId && knownOwnerIds.has(ownerId.toLocaleLowerCase())) {
      for (const key of DISPLAY_NAME_FIELDS) {
        const candidate = record[key];
        if (typeof candidate === 'string' && isLikelyTargetAlias(candidate, targetLanguage)) {
          addLocalizedRuntimeAlias(output, derived, ownerId, candidate.trim(), targetLanguage);
        }
      }
    }
    Object.values(record).forEach(visit);
  };
  visit(value);
}

function addLocalizedRuntimeAlias(
  output: Map<string, string[]>,
  derived: Map<string, Map<string, Set<string>>>,
  ownerId: string,
  alias: string,
  targetLanguage: string,
): void {
  addRuntimeOwnerAlias(output, ownerId, alias);
  for (const shorthand of derivedTargetAliases(alias, targetLanguage)) {
    const key = aliasKey(shorthand);
    const owners = derived.get(key) ?? new Map<string, Set<string>>();
    const ownerAliases = owners.get(ownerId.toLocaleLowerCase()) ?? new Set<string>();
    ownerAliases.add(shorthand);
    owners.set(ownerId.toLocaleLowerCase(), ownerAliases);
    derived.set(key, owners);
  }
}

function derivedTargetAliases(alias: string, targetLanguage: string): string[] {
  const language = targetLanguage.toLowerCase().replaceAll('_', '-');
  if (!(language.startsWith('zh') || language.includes('chinese') || /中文|简体|繁体/u.test(language))) return [];
  const compact = alias.replace(/[\s·・⋅]/gu, '');
  const characters = [...compact];
  // Names with three or fewer Han characters are already short enough. For
  // longer names, derive the given-name portion from a word boundary when the
  // runtime has Intl.Segmenter, then fall back to the final two characters.
  if (characters.length <= 3) return [];
  const candidates = new Set<string>();
  const add = (value: string) => {
    if (value !== compact && /^[\u3400-\u9fff]{2,}$/u.test(value)) candidates.add(value);
  };
  const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new (Intl as typeof Intl & { Segmenter: new (locale: string, options: { granularity: 'word' }) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter('zh', { granularity: 'word' })
    : null;
  const parts = segmenter ? [...segmenter.segment(compact)].map((item) => item.segment).filter((part) => part.length > 0) : [];
  let offset = 0;
  for (const part of parts) {
    offset += [...part].length;
    const remainder = characters.slice(offset).join('');
    if (characters.slice(0, offset).length >= 2 && [...remainder].length >= 2) add(remainder);
  }
  const shorthand = characters.slice(-2).join('');
  add(shorthand);
  return [...candidates];
}

function appendUniqueDerivedAliases(
  output: Map<string, string[]>,
  derived: Map<string, Map<string, Set<string>>>,
): void {
  for (const [shortKey, owners] of derived) {
    if (owners.size !== 1) continue;
    const [[ownerId, aliases]] = [...owners.entries()];
    const existingOwner = [...output.entries()].find(([, values]) => values.some((value) => aliasKey(value) === shortKey))?.[0];
    if (existingOwner && existingOwner !== ownerId) continue;
    for (const alias of aliases) addRuntimeOwnerAlias(output, ownerId, alias);
  }
}

function addRuntimeOwnerAlias(output: Map<string, string[]>, ownerId: string, alias: string): void {
  const key = ownerId.toLocaleLowerCase();
  const aliases = output.get(key) ?? [];
  if (!aliases.some((existing) => aliasKey(existing) === aliasKey(alias))) aliases.push(alias);
  output.set(key, aliases);
}

function collectRuntimeOwnerIds(source: unknown, output = new Set<string>()): Set<string> {
  const visit = (value: unknown, path: string[]): void => {
    if (typeof value === 'string') {
      if (path.includes('code')) {
        for (const node of collectLuaStringNodes(value)) {
          const decoded = decodeLuaString(node.raw);
          const parsed = decoded == null ? undefined : tryParseJson(decoded);
          if (parsed !== undefined) collectRuntimeOwnerIdsFromParsed(parsed, output);
        }
      } else {
        const parsed = tryParseJson(value);
        if (parsed !== undefined) collectRuntimeOwnerIdsFromParsed(parsed, output);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, String(index)]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (runtimeEntryIdentity(record) && runtimeEntryAliasField(record)) output.add(runtimeEntryIdentity(record)!.toLocaleLowerCase());
    for (const [key, child] of Object.entries(record)) visit(child, [...path, key]);
  };
  visit(source, []);
  return output;
}

function collectRuntimeOwnerIdsFromParsed(value: unknown, output: Set<string>): void {
  for (const catalog of discoverRuntimeCatalogs(value)) {
    for (const entry of catalog) {
      const ownerId = runtimeEntryIdentity(entry);
      if (ownerId && runtimeEntryAliasField(entry)) output.add(ownerId.toLocaleLowerCase());
    }
  }
}

function isLikelyTargetAlias(alias: string, targetLanguage: string): boolean {
  const language = targetLanguage.toLowerCase().replaceAll('_', '-');
  if (!alias || alias.length > 80 || !/\p{L}/u.test(alias)) return false;
  if (language.startsWith('zh') || language.includes('chinese') || /中文|简体|繁体/u.test(language)) {
    // Japanese display names often contain shared Kanji. A name that still
    // contains Kana is not a Chinese runtime alias and must be localized.
    return /[\u3400-\u9fff]/u.test(alias) && !/[\u3040-\u30ff]/u.test(alias);
  }
  if (language.startsWith('ko') || language.includes('korean') || /韩语|韩文/u.test(language)) return /[\uac00-\ud7af]/u.test(alias);
  if (language.startsWith('ja') || language.includes('japanese') || /日语|日本語/u.test(language)) return /[\u3040-\u30ff]/u.test(alias);
  if (language.startsWith('ar')) return /[\u0600-\u06ff]/u.test(alias);
  if (language.startsWith('he')) return /[\u0590-\u05ff]/u.test(alias);
  if (language.startsWith('th')) return /[\u0e00-\u0e7f]/u.test(alias);
  if (language.startsWith('ru') || language.startsWith('uk') || language.startsWith('bg')) return /[\u0400-\u052f]/u.test(alias);
  return true;
}

function normalizeOwnerAliases(value: string): string[] {
  return value
    .split(/[\/,，、;；]/u)
    .map((alias) => alias.replace(/[*`]/gu, '').trim().replace(/[：:。.!！?？]+$/u, ''))
    .filter((alias) => !/^(?:[-*]\s*)?[A-Za-z][A-Za-z0-9_.:-]{0,127}\s*(?:->|=>)\s*/u.test(alias))
    .filter((alias) => alias.length > 0 && alias.length <= 80);
}

function aliasKey(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase();
}

function runtimeEntryIdentity(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const field of OWNER_ID_FIELDS) {
    const candidate = record[field];
    if (typeof candidate === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/u.test(candidate.trim())) return candidate.trim();
  }
  return null;
}

function runtimeEntryAliasField(value: unknown): { key: string; values: string[] } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ALIAS_ARRAY_FIELDS) {
    const aliases = record[key];
    if (Array.isArray(aliases) && aliases.every((alias) => typeof alias === 'string')) return { key, values: aliases as string[] };
  }
  return null;
}

function discoverRuntimeCatalogs(value: unknown): unknown[][] {
  const catalogs: unknown[][] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      if (current.some((entry) => runtimeEntryIdentity(entry) && runtimeEntryAliasField(entry))) catalogs.push(current);
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== 'object') return;
    Object.values(current).forEach(visit);
  };
  visit(value);
  return catalogs;
}

function forEachRuntimeCatalog(source: string, callback: (catalog: unknown[]) => void): void {
  for (const node of collectLuaStringNodes(source)) {
    const decoded = decodeLuaString(node.raw);
    const parsed = decoded == null ? undefined : tryParseJson(decoded);
    if (parsed === undefined) continue;
    discoverRuntimeCatalogs(parsed).forEach(callback);
  }
}

function updateRuntimeCatalogText(text: string, localizedAliases: Map<string, string[]>): { text: string; additions: number; changed: boolean } {
  const parsed = tryParseJson(text);
  if (parsed === undefined) return { text, additions: 0, changed: false };
  const catalogs = discoverRuntimeCatalogs(parsed);
  if (!catalogs.length) return { text, additions: 0, changed: false };

  let additions = 0;
  for (const catalog of catalogs) {
    for (const entry of catalog) {
      const ownerId = runtimeEntryIdentity(entry);
      const aliasField = runtimeEntryAliasField(entry);
      if (!ownerId || !aliasField) continue;
      for (const alias of localizedAliases.get(ownerId.toLocaleLowerCase()) ?? []) {
        if (aliasField.values.some((existing) => aliasKey(existing) === aliasKey(alias))) continue;
        aliasField.values.push(alias);
        additions += 1;
      }
    }
  }
  return additions ? { text: JSON.stringify(parsed), additions, changed: true } : { text, additions: 0, changed: false };
}

interface LuaStringNode { start: number; end: number; raw: string }

function collectLuaStringNodes(source: string): LuaStringNode[] {
  const nodes: LuaStringNode[] = [];
  try {
    const ast = parse(source, { luaVersion: '5.3', ranges: true }) as unknown;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(visit);
        return;
      }
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (node.type === 'StringLiteral' && Array.isArray(node.range)
        && typeof node.range[0] === 'number' && typeof node.range[1] === 'number') {
        const start = node.range[0];
        const end = node.range[1];
        nodes.push({ start, end, raw: source.slice(start, end) });
      }
      Object.values(node).forEach(visit);
    };
    visit(ast);
  } catch {
    for (const match of source.matchAll(/\[(=*)\[([\s\S]*?)\]\1\]/gu)) {
      const start = match.index ?? 0;
      nodes.push({ start, end: start + match[0].length, raw: match[0] });
    }
  }
  return nodes;
}

function tryParseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value.trim());
  } catch {
    return undefined;
  }
}

function decodeLuaString(raw: string): string | null {
  const long = raw.match(/^\[(=*)\[([\s\S]*)\]\1\]$/u);
  if (long) return long[2];
  if (raw.length < 2 || !/^['"]$/u.test(raw[0]) || raw.at(-1) !== raw[0]) return null;
  const body = raw.slice(1, -1);
  const escapes: Record<string, string> = { a: '\u0007', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\u000b', '\\': '\\', '"': '"', "'": "'" };
  let output = '';
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] !== '\\') {
      output += body[index];
      continue;
    }
    const next = body[++index];
    if (next == null) return null;
    if (escapes[next] != null) output += escapes[next];
    else if (next === 'x' && /^[0-9a-f]{2}$/iu.test(body.slice(index + 1, index + 3))) {
      output += String.fromCharCode(Number.parseInt(body.slice(index + 1, index + 3), 16));
      index += 2;
    } else if (/\d/u.test(next)) {
      const digits = `${next}${body.slice(index + 1).match(/^\d{0,2}/u)?.[0] ?? ''}`;
      output += String.fromCharCode(Number.parseInt(digits, 10));
      index += digits.length - 1;
    } else if (next === '\r' || next === '\n') {
      if (next === '\r' && body[index + 1] === '\n') index += 1;
      output += '\n';
    } else output += next;
  }
  return output;
}

function encodeLuaString(value: string, raw: string): string {
  const long = raw.match(/^\[(=*)\[[\s\S]*\]\1\]$/u);
  if (long) return toLuaLongString(value, long[1]);
  const quote = raw[0];
  return `${quote}${value.replaceAll('\\', '\\\\').replaceAll(quote, `\\${quote}`).replaceAll('\r', '\\r').replaceAll('\n', '\\n')}${quote}`;
}

function toLuaLongString(value: string, initialEquals: string): string {
  let equals = initialEquals;
  while (value.includes(`]${equals}]`)) equals += '=';
  return `[${equals}[${value}]${equals}]`;
}

function visitLuaCode(
  module: Record<string, unknown>,
  callback: (source: string, path: Array<string | number>, replace: (source: string) => void) => void,
): void {
  const visit = (value: unknown, path: Array<string | number>): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key];
      if (key === 'code' && typeof child === 'string' && isLuaModuleCodePath(childPath)) {
        callback(child, childPath, (source) => { (value as Record<string, unknown>)[key] = source; });
      } else {
        visit(child, childPath);
      }
    }
  };
  visit(module, []);
}

function applySelectedLanguagePromptBridge(module: Record<string, unknown>): Record<string, unknown> {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'code' && typeof child === 'string') {
        (value as Record<string, unknown>)[key] = bridgeTouhouSelectedLanguage(child);
      } else {
        visit(child);
      }
    }
  };
  visit(module);
  return module;
}

function bridgeTouhouSelectedLanguage(source: string): string {
  if (!source.includes('TH_IsValidUILang') || !source.includes('TH_NewsAuxUpdate')) return source;
  let lines = source.split('\n');
  const helperMarker = 'function set_tab_work(triggerId)';
  const helperIndex = lines.findIndex((line) => line.trim().startsWith(helperMarker));
  if (helperIndex >= 0 && !source.includes('local function TH_SelectedOutputLanguageCode(')) {
    lines.splice(helperIndex, 0, ...SELECTED_LANGUAGE_HELPERS.split('\n'), '');
  }

  const output: string[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (trimmed === 'writeVar(triggerId, "th_story_lang", lang)'
      || trimmed === 'writeVar(triggerId, "th_sidebar_lang", lang)') {
      output.push(line);
      if (lines[index + 1]?.trim() !== 'setChatVar(triggerId, "news_init", "false")') {
        output.push(`${line.match(/^\s*/)?.[0] ?? ''}setChatVar(triggerId, "news_init", "false")`);
      }
      continue;
    }
    if (trimmed.startsWith('parts[#parts + 1] = "SYSTEM EVENT BANNER:')) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}parts[#parts + 1] = "SYSTEM EVENT BANNER: When you actually stage this encounter in the current response (not when merely foreshadowing), mark its onset on its own line with exactly one inline tag. This event side is " .. ev.side .. ", so use " .. evTag .. ". HEADLINE must be one short line in " .. TH_SelectedOutputLanguage(triggerId) .. " (about 10 to 40 characters), announcing the event and fitting the scene, with no < > | characters. Emit at most one such tag per response, and only if the encounter actually occurs this turn."`);
      continue;
    }
    if (trimmed.startsWith('"Use concise Korean if the scene is Korean.')
      || trimmed.startsWith('"无论场景使用何种语言，headline、weather 和 aya')) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}"Use only " .. TH_SelectedOutputLanguage(triggerId) .. " for headline, weather, and aya. Do not add markdown. Headline <= 40 characters. Aya comment <= 80 characters.",`);
      continue;
    }
    if (trimmed.startsWith('parts[#parts + 1] = "中文输出标准：')
      || trimmed.startsWith('parts[#parts + 1] = "한국어 출력 기준:')) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}parts[#parts + 1] = "Selected-language output rule: after the introduction, the narrator must keep speaking. Do not turn non-dialogue paragraphs into neutral novel prose. Keep the selected narrator's voice, judgment, and reactions visible, and use " .. TH_SelectedOutputLanguage(triggerId) .. " consistently."`);
      continue;
    }
    if (trimmed.startsWith('parts[#parts + 1] = "角色对白应保持')
      || (trimmed.startsWith('parts[#parts + 1] = "Character dialogue remains') && trimmed.includes('Korean voice'))) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}parts[#parts + 1] = "Character dialogue must use each speaker's natural voice in " .. TH_SelectedOutputLanguage(triggerId) .. ". The narrator must not hijack dialogue, define {{user}}'s identity, or reveal secrets they could not know."`);
      continue;
    }
    if (trimmed.startsWith('"Rules: Write in Korean if the scene is Korean.')
      || trimmed.startsWith('"规则：只用简体中文书写。')) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}"Rules: Write only in " .. TH_SelectedOutputLanguage(triggerId) .. ". Each line is a first-person inner monologue, <= 40 characters, with no quotation marks or markdown.",`);
      continue;
    }
    if (trimmed.startsWith('"Output JSON only: {\\"thoughts\\"')
      || trimmed.startsWith('"只输出 JSON：{\\"thoughts\\"')) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}"Output JSON only: {\\"thoughts\\":[{\\"name\\":\\"character name in the selected language\\",\\"line\\":\\"inner thought\\"}]}",`);
      continue;
    }
    if (trimmed.startsWith('"你是射命丸文，正在为东方角色扮演聊天撰写')) {
      output.push(`${line.match(/^\s*/)?.[0] ?? ''}"You are Aya Shameimaru writing a compact Bunbunmaru Newspaper status panel for a Touhou RP chat.",`);
      continue;
    }
    if (trimmed.startsWith('"只返回 JSON：{\\"headline\\"')) {
      output.push(`${line.match(/^\s*/)?.[0] ?? ''}"Return only JSON: {\\"headline\\":string,\\"weather\\":string,\\"danger\\":1-5,\\"aya\\":string}",`);
      continue;
    }
    if (trimmed.startsWith('"概括当前场景的实际状态')) {
      output.push(`${line.match(/^\s*/)?.[0] ?? ''}"Summarize the current scene state, not a generic default. If nothing happened, report that calmly.",`);
      continue;
    }
    if (trimmed.startsWith('_parts[#_parts+1] = "隐私模式：')) {
      const indent = line.match(/^\s*/)?.[0] ?? '';
      output.push(`${indent}_parts[#_parts+1] = "PRIVACY MODE: This is a public newspaper. Never describe, imply, or gossip about adult or intimate scenes. Report such scenes only in neutral, vague terms and move on. Prohibit explicit words and descriptions of body parts or sexual acts. Keep a restrained newspaper tone."`);
      continue;
    }
    output.push(line);
  }
  lines = output;

  const initIndex = lines.findIndex((line) => line.trim() === 'local function TH_NewsInit(triggerId)');
  if (initIndex >= 0 && !lines[initIndex + 1]?.includes('TH_SelectedNewsDefaults')) {
    lines.splice(initIndex + 1, 0, '  local defaultHeadline, defaultWeather, defaultAya = TH_SelectedNewsDefaults(triggerId)');
  }
  const applyIndex = lines.findIndex((line) => line.trim() === 'local function TH_NewsApply(triggerId, headline, weather, dangerRaw, aya)');
  if (applyIndex >= 0 && !lines[applyIndex + 1]?.includes('TH_SelectedNewsDefaults')) {
    lines.splice(applyIndex + 1, 0, '  local defaultHeadline, defaultWeather, defaultAya = TH_SelectedNewsDefaults(triggerId)');
  }

  return lines.map((line) => {
    if (line.includes('TH_NewsSet(triggerId, "news_headline", "')) {
      return `${line.match(/^\s*/)?.[0] ?? ''}TH_NewsSet(triggerId, "news_headline", defaultHeadline)`;
    }
    if (line.includes('TH_NewsSet(triggerId, "news_weather", "')) {
      return `${line.match(/^\s*/)?.[0] ?? ''}TH_NewsSet(triggerId, "news_weather", defaultWeather)`;
    }
    if (line.includes('TH_NewsSet(triggerId, "news_aya_comment", "')) {
      return `${line.match(/^\s*/)?.[0] ?? ''}TH_NewsSet(triggerId, "news_aya_comment", defaultAya)`;
    }
    return line
      .replace(/TH_NewsCleanText\(headline,\s*"[^"]*",\s*80\)/, 'TH_NewsCleanText(headline, defaultHeadline, 80)')
      .replace(/TH_NewsCleanText\(weather,\s*"[^"]*",\s*40\)/, 'TH_NewsCleanText(weather, defaultWeather, 40)')
      .replace(/TH_NewsCleanText\(aya,\s*"[^"]*",\s*160\)/, 'TH_NewsCleanText(aya, defaultAya, 160)');
  }).join('\n');
}

const SELECTED_LANGUAGE_HELPERS = `local function TH_SelectedOutputLanguageCode(triggerId)
  local lang = tostring(readVar(triggerId, "th_sidebar_lang") or "")
  if not TH_IsValidUILang(lang) then
    lang = tostring(readVar(triggerId, "th_story_lang") or "")
  end
  if not TH_IsValidUILang(lang) then lang = "zh" end
  return lang
end

local function TH_SelectedOutputLanguage(triggerId)
  local labels = { ko = "Korean", en = "English", zh = "Simplified Chinese", ja = "Japanese" }
  return labels[TH_SelectedOutputLanguageCode(triggerId)] or labels.zh
end

local function TH_SelectedNewsDefaults(triggerId)
  local defaults = {
    ko = { "환상향, 오늘도 평화", "맑음", "특별한 사건은 없습니다. 한가롭군요." },
    en = { "Gensokyo, Peaceful Today", "Clear", "No special incidents. Rather quiet today." },
    zh = { "幻想乡，今日和平", "晴朗", "没有特别事件。今天还真清闲。" },
    ja = { "幻想郷、本日も平和", "晴れ", "特別な事件はありません。今日はのどかですね。" },
  }
  local selected = defaults[TH_SelectedOutputLanguageCode(triggerId)] or defaults.zh
  return selected[1], selected[2], selected[3]
end`;

export function validateRisuLuaChanges(
  original: Record<string, unknown>,
  draft: Record<string, unknown>,
): LuaSyntaxIssue[] {
  const originalCode = collectLuaCode(original);
  const draftCode = collectLuaCode(draft);
  const issues: LuaSyntaxIssue[] = [];

  for (const [pathJson, source] of originalCode) {
    const candidate = draftCode.get(pathJson);
    if (candidate == null || candidate === source || !parsesAsLua(source)) continue;
    try {
      parse(candidate, { luaVersion: '5.3' });
    } catch (error) {
      issues.push({
        pathLabel: `模块.${(JSON.parse(pathJson) as Array<string | number>).join('.')}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return issues;
}

function collectLuaCode(value: unknown): Map<string, string> {
  const result = new Map<string, string>();
  const visit = (child: unknown, path: Array<string | number>) => {
    if (typeof child === 'string') {
      if (isLuaModuleCodePath(path)) result.set(JSON.stringify(path), child);
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

function parsesAsLua(source: string): boolean {
  try {
    parse(source, { luaVersion: '5.3' });
    return true;
  } catch {
    return false;
  }
}

function parsePath(pathJson: string): Array<string | number> {
  try {
    return JSON.parse(pathJson) as Array<string | number>;
  } catch {
    return [];
  }
}

function wouldChangeSource(segment: ApplicableSegment): boolean {
  if (segment.reviewStatus !== 'approved') return false;
  const output = segment.finalText?.trim() || segment.translatedText?.trim();
  return Boolean(output && output !== segment.sourceText);
}
