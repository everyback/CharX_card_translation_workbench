import { createHash } from 'node:crypto';

export type ProtocolPolicy = 'translate' | 'protect' | 'manual';
export type ProtocolStatus = 'pending' | 'analyzed' | 'approved' | 'ignored';
export type ProtocolForm = 'angle' | 'square' | 'at-line';
export type ProtocolDiscoverySource = 'local' | 'regex-lua';

export interface ProtocolFieldRule {
  index: number;
  role: string;
  policy: ProtocolPolicy;
  confidence: number;
  reason: string;
  hardProtected: boolean;
}

export interface ProtocolSchemaRule {
  signature: string;
  name: string;
  form: ProtocolForm;
  opener: string;
  closer: string;
  delimiter: string;
  fieldCount: number;
  status: ProtocolStatus;
  fieldRules: ProtocolFieldRule[];
}

export interface ProtocolReference {
  literal: string;
  kind: 'regex' | 'lua';
  pathLabel: string;
  pattern: string;
}

export interface ParsedProtocolField {
  index: number;
  value: string;
  start: number;
  end: number;
  label?: string;
}

export interface ParsedProtocolOccurrence {
  signature: string;
  name: string;
  form: ProtocolForm;
  opener: string;
  closer: string;
  delimiter: string;
  fieldCount: number;
  start: number;
  end: number;
  rawText: string;
  fields: ParsedProtocolField[];
  isDeclaration: boolean;
}

export interface DiscoveredProtocolOccurrence extends ParsedProtocolOccurrence {
  path: Array<string | number>;
  pathLabel: string;
}

export interface ProtocolDiscoveryCluster extends ProtocolSchemaRule {
  source: ProtocolDiscoverySource;
  confidence: number;
  occurrenceCount: number;
  declaration: string;
  examples: string[];
  referenceCount: number;
  occurrences: DiscoveredProtocolOccurrence[];
}

export interface ProtocolTranslationRange {
  signature: string;
  protocolName: string;
  delimiter: string;
  role: string;
  fieldIndex: number;
  start: number;
  end: number;
  sourceText: string;
}

export interface ProtocolMatchSet {
  occupiedRanges: Array<{ start: number; end: number }>;
  translationRanges: ProtocolTranslationRange[];
}

const CONTROL_ROLES = /^(?:id|key|code|type|kind|mode|state|status|flag|action|command|event|path|url|uri|index|count|number|num|lv|level|time|date|hp|health|corruption|danger|risk|priority|order|version|enabled|active)$/i;
const DISPLAY_ROLES = /(?:text|title|headline|weather|content|message|label|caption|description|comment|summary|name|aya|dialog|prompt|display)/i;
const DECLARATION_CONTEXT = /(?:format|syntax|schema|格式|形式|结构|형식|구조|フォーマット)\s*[:：]?\s*$/i;

export function discoverProtocols(
  card: Record<string, unknown>,
  module: Record<string, unknown> | null,
  references: readonly ProtocolReference[] = [],
): ProtocolDiscoveryCluster[] {
  const occurrences: DiscoveredProtocolOccurrence[] = [];
  const visit = (value: unknown, path: Array<string | number>) => {
    if (typeof value === 'string') {
      if (path[0] === '$module' && path.at(-1) === 'code'
        && path.some((part) => part === 'effect' || part === 'trigger')) return;
      const label = readablePath(path);
      occurrences.push(...parseProtocols(value).map((occurrence) => ({ ...occurrence, path, pathLabel: label })));
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, [...path, index]));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const entry = value as Record<string, unknown>;
    // Risu regex rules describe protocol grammar. Parsing regex source/output as
    // ordinary card text creates fake occurrences such as "[^|]+" fields.
    if (typeof entry.in === 'string' && typeof entry.out === 'string') return;
    for (const [key, child] of Object.entries(entry)) visit(child, [...path, key]);
  };

  visit(card, []);
  if (module) visit(module, ['$module']);

  const grouped = new Map<string, DiscoveredProtocolOccurrence[]>();
  for (const occurrence of occurrences) {
    const group = grouped.get(occurrence.signature) ?? [];
    group.push(occurrence);
    grouped.set(occurrence.signature, group);
  }

  return [...grouped.values()]
    .map((group) => buildCluster(group, references))
    .sort((left, right) => right.occurrenceCount - left.occurrenceCount || left.name.localeCompare(right.name));
}

export function parseProtocols(source: string): ParsedProtocolOccurrence[] {
  const result: ParsedProtocolOccurrence[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const char = source[cursor];
    if (char === '<' || char === '[') {
      const form: ProtocolForm = char === '<' ? 'angle' : 'square';
      const closer = char === '<' ? '>' : ']';
      const end = findWrappedEnd(source, cursor, char, closer);
      if (end > cursor) {
        const parsed = parseCandidate(source, cursor, end, form, char, closer);
        if (parsed) result.push(parsed);
        cursor = end;
        continue;
      }
    }
    if (source.startsWith('@@', cursor) && (cursor === 0 || source[cursor - 1] === '\n')) {
      const lineEnd = source.indexOf('\n', cursor);
      const end = lineEnd < 0 ? source.length : lineEnd;
      const parsed = parseCandidate(source, cursor, end, 'at-line', '@@', '');
      if (parsed) result.push(parsed);
      cursor = end;
      continue;
    }
    cursor += 1;
  }
  return result;
}

export function protocolMatchesForText(
  source: string,
  schemas: readonly ProtocolSchemaRule[],
): ProtocolMatchSet {
  const approved = new Map(schemas.filter((schema) => schema.status === 'approved').map((schema) => [schema.signature, schema]));
  if (!approved.size) return { occupiedRanges: [], translationRanges: [] };

  const occupiedRanges: Array<{ start: number; end: number }> = [];
  const translationRanges: ProtocolTranslationRange[] = [];
  for (const occurrence of parseProtocols(source)) {
    const schema = approved.get(occurrence.signature);
    if (!schema) continue;
    occupiedRanges.push({ start: occurrence.start, end: occurrence.end });
    if (occurrence.isDeclaration) continue;
    for (const field of occurrence.fields) {
      const rule = schema.fieldRules.find((candidate) => candidate.index === field.index);
      if (!rule || rule.policy !== 'translate' || rule.hardProtected || !field.value) continue;
      translationRanges.push({
        signature: occurrence.signature,
        protocolName: occurrence.name,
        delimiter: occurrence.delimiter,
        role: rule.role || `field_${field.index}`,
        fieldIndex: field.index,
        start: field.start,
        end: field.end,
        sourceText: field.value,
      });
    }
  }
  return { occupiedRanges: mergeRanges(occupiedRanges), translationRanges };
}

export function protocolFieldReplacementIssue(
  candidate: string,
  delimiter?: string | null,
  source = '',
): string | null {
  if (/[\r\n]/.test(candidate)) return '协议槽位译文不能包含换行。';
  const candidateBoundaries = candidate.match(/[<>\[\]]/g) ?? [];
  const sourceBoundaries = source.match(/[<>\[\]]/g) ?? [];
  if (candidateBoundaries.join('') !== sourceBoundaries.join('')) {
    return '协议槽位译文包含新增、缺失或改写的结构边界符。';
  }
  const activeDelimiter = delimiter || null;
  if (activeDelimiter && countOccurrences(candidate, activeDelimiter) > countOccurrences(source, activeDelimiter)) {
    return `协议槽位译文包含未转义的分隔符 ${activeDelimiter}。`;
  }
  // Older segment rows do not carry their delimiter. Keep legacy validation conservative
  // until the database migration can recover it from the stored protocol occurrence.
  if (!activeDelimiter && ['|', ':'].some((value) => (
    countOccurrences(candidate, value) > countOccurrences(source, value)
  ))) return '协议槽位译文包含未转义的协议分隔符。';
  return null;
}

function countOccurrences(value: string, fragment: string): number {
  if (!fragment) return 0;
  return value.split(fragment).length - 1;
}

function parseCandidate(
  source: string,
  start: number,
  end: number,
  form: ProtocolForm,
  opener: string,
  closer: string,
): ParsedProtocolOccurrence | null {
  const contentStart = start + opener.length;
  const contentEnd = end - closer.length;
  const content = source.slice(contentStart, contentEnd);
  if (!content || /[\r\n]/.test(content)) return null;
  const labelled = parseLabelledProtocol(content, contentStart);
  const delimiter = labelled?.delimiter ?? firstTopLevelDelimiter(content);
  if (!delimiter) return null;
  const parts = labelled?.parts ?? splitTopLevel(content, delimiter);
  if (parts.length < 2) return null;
  const name = labelled?.name ?? parts[0].value.trim();
  if (!/^[\p{L}_][\p{L}\p{N}\p{M}_.-]{0,63}$/u.test(name)) return null;

  const fields = (labelled?.fields ?? parts.slice(1).map((part, fieldIndex) => {
    const leading = part.value.length - part.value.trimStart().length;
    const trailing = part.value.length - part.value.trimEnd().length;
    const fieldStart = contentStart + part.start + leading;
    const fieldEnd = contentStart + part.end - trailing;
    return {
      index: fieldIndex + 1,
      value: source.slice(fieldStart, fieldEnd),
      start: fieldStart,
      end: fieldEnd,
    };
  }));
  const signature = protocolSignature(form, name, delimiter, fields.length);
  const context = source.slice(Math.max(0, start - 100), start);
  return {
    signature,
    name,
    form,
    opener,
    closer,
    delimiter,
    fieldCount: fields.length,
    start,
    end,
    rawText: source.slice(start, end),
    fields,
    isDeclaration: DECLARATION_CONTEXT.test(context),
  };
}

interface LabelledProtocolParts {
  delimiter: string;
  name: string;
  parts: Array<{ value: string; start: number; end: number }>;
  fields: ParsedProtocolField[];
}

/**
 * Handles protocols such as `[LV:15|Time:10:00|Location:... ]`.
 * The pipe is the record separator while each record also has a display label
 * followed by a colon. Treating the first colon as the delimiter loses the
 * labels and makes the original regex impossible to preserve.
 */
function parseLabelledProtocol(content: string, contentStart: number): LabelledProtocolParts | null {
  for (const delimiter of ['|', ';']) {
    const parts = splitTopLevel(content, delimiter);
    if (parts.length < 2) continue;
    const parsed = parts.map((part) => {
      const leading = part.value.length - part.value.trimStart().length;
      const trailing = part.value.length - part.value.trimEnd().length;
      const partStart = part.start + leading;
      const partEnd = part.end - trailing;
      const trimmed = content.slice(partStart, partEnd);
      const separator = topLevelIndexOf(trimmed, ':');
      if (separator <= 0) return null;
      const label = trimmed.slice(0, separator).trim();
      if (!/^[\p{L}_][\p{L}\p{N}\p{M}_.-]{0,63}$/u.test(label)) return null;
      const valueStart = partStart + separator + 1;
      const valueRaw = content.slice(valueStart, partEnd);
      const valueLeading = valueRaw.length - valueRaw.trimStart().length;
      const valueTrailing = valueRaw.length - valueRaw.trimEnd().length;
      const start = contentStart + valueStart + valueLeading;
      const end = contentStart + partEnd - valueTrailing;
      return {
        label,
        value: content.slice(valueStart + valueLeading, partEnd - valueTrailing),
        start,
        end,
        part: { value: part.value, start: part.start, end: part.end },
      };
    });
    if (!parsed.every(Boolean)) continue;
    const entries = parsed as Array<NonNullable<(typeof parsed)[number]>>;
    const labels = new Set(entries.map((entry) => entry.label));
    if (labels.size !== entries.length) continue;
    return {
      delimiter,
      name: entries[0].label,
      parts: entries.map((entry) => entry.part),
      fields: entries.slice(0).map((entry, index) => ({
        index: index + 1,
        label: entry.label,
        value: entry.value,
        start: entry.start,
        end: entry.end,
      })),
    };
  }
  return null;
}

function buildCluster(
  occurrences: DiscoveredProtocolOccurrence[],
  references: readonly ProtocolReference[],
): ProtocolDiscoveryCluster {
  const first = occurrences[0];
  const declarationOccurrence = occurrences.find((occurrence) => occurrence.isDeclaration);
  const declarationRoles = declarationOccurrence?.fields.every((field) => /^[A-Za-z_][\w.-]{0,63}$/.test(field.value))
    ? declarationOccurrence.fields.map((field) => field.value)
    : [];
  const fieldRules: ProtocolFieldRule[] = [];
  for (let index = 1; index <= first.fieldCount; index += 1) {
    const values = occurrences
      .filter((occurrence) => !occurrence.isDeclaration)
      .map((occurrence) => occurrence.fields[index - 1]?.value.trim() ?? '')
      .filter(Boolean);
    const role = declarationRoles[index - 1]
      || occurrences.find((occurrence) => occurrence.fields[index - 1]?.label)?.fields[index - 1]?.label
      || `field_${index}`;
    const referenceCandidates = references.filter((reference) => values.some((value) => value === reference.literal));
    const distinctValues = new Set(values);
    const referencedValues = new Set(referenceCandidates.map((reference) => reference.literal));
    const referenceCoverage = distinctValues.size ? referencedValues.size / distinctValues.size : 0;
    const fieldReferences = CONTROL_ROLES.test(role) || referenceCoverage >= 0.5 ? referenceCandidates : [];
    fieldRules.push(inferFieldRule(index, role, values, fieldReferences));
  }
  const confidence = fieldRules.length
    ? fieldRules.reduce((total, rule) => total + rule.confidence, 0) / fieldRules.length
    : 0;
  const referenceCount = fieldRules.filter((field) => field.hardProtected).length;
  const examples = occurrences
    .filter((occurrence) => !occurrence.isDeclaration)
    .slice(0, 5)
    .map((occurrence) => occurrence.rawText.slice(0, 1_000));
  return {
    source: 'local',
    signature: first.signature,
    name: first.name,
    form: first.form,
    opener: first.opener,
    closer: first.closer,
    delimiter: first.delimiter,
    fieldCount: first.fieldCount,
    status: 'pending',
    fieldRules,
    occurrenceCount: occurrences.filter((occurrence) => !occurrence.isDeclaration).length,
    declaration: declarationOccurrence?.rawText ?? '',
    examples,
    referenceCount,
    confidence,
    occurrences,
  };
}

function inferFieldRule(
  index: number,
  role: string,
  values: string[],
  references: readonly ProtocolReference[],
): ProtocolFieldRule {
  if (references.length) {
    const referenceKinds = [...new Set(references.map((reference) => reference.kind === 'lua' ? 'Lua' : '正则'))];
    return {
      index,
      role,
      policy: 'protect',
      confidence: 1,
      reason: `被 ${referenceKinds.join('/')} 精确引用`,
      hardProtected: true,
    };
  }
  if (CONTROL_ROLES.test(role)) {
    return { index, role, policy: 'protect', confidence: 0.96, reason: `格式声明将槽位标记为控制字段 ${role}`, hardProtected: false };
  }
  if (DISPLAY_ROLES.test(role)) {
    return { index, role, policy: 'translate', confidence: 0.94, reason: `格式声明将槽位标记为显示文字 ${role}`, hardProtected: false };
  }
  if (values.length && values.every(isControlValue)) {
    return { index, role, policy: 'protect', confidence: 0.9, reason: '样本均为数字、布尔值、路径或标识符', hardProtected: false };
  }
  const naturalRatio = values.length ? values.filter(likelyNaturalLanguage).length / values.length : 0;
  if (naturalRatio >= 0.7) {
    return { index, role, policy: 'translate', confidence: 0.82, reason: '大多数样本为自然语言', hardProtected: false };
  }
  return { index, role, policy: 'manual', confidence: 0.45, reason: '本地规则无法可靠判断槽位用途', hardProtected: false };
}

function isControlValue(value: string): boolean {
  return /^(?:-?\d+(?:\.\d+)?|true|false|null|#[0-9a-f]{3,8}|[A-Za-z_][\w.-]{0,80}|https?:\/\/\S+)$/i.test(value);
}

function likelyNaturalLanguage(value: string): boolean {
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(value)) return true;
  if (/[.!?,;:'" ]/.test(value) && /[A-Za-z]{2}/.test(value)) return true;
  return value.length >= 16 && /[A-Za-z]/.test(value);
}

function firstTopLevelDelimiter(content: string): string | null {
  const positions = ['|', ':']
    .map((delimiter) => ({ delimiter, index: topLevelIndexOf(content, delimiter) }))
    .filter((candidate) => candidate.index >= 0)
    .sort((left, right) => left.index - right.index);
  return positions[0]?.delimiter ?? null;
}

function splitTopLevel(content: string, delimiter: string): Array<{ value: string; start: number; end: number }> {
  const parts: Array<{ value: string; start: number; end: number }> = [];
  let start = 0;
  walkSyntax(content, (index, char, depth) => {
    if (char !== delimiter || depth !== 0) return;
    parts.push({ value: content.slice(start, index), start, end: index });
    start = index + 1;
  });
  parts.push({ value: content.slice(start), start, end: content.length });
  return parts;
}

function topLevelIndexOf(content: string, delimiter: string): number {
  let result = -1;
  walkSyntax(content, (index, char, depth) => {
    if (result < 0 && char === delimiter && depth === 0) result = index;
  });
  return result;
}

function walkSyntax(content: string, visit: (index: number, char: string, depth: number) => void): void {
  const stack: string[] = [];
  let quote = '';
  let escaped = false;
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    const depth = stack.length;
    visit(index, char, depth);
    if (pairs[char]) stack.push(pairs[char]);
    else if (stack.at(-1) === char) stack.pop();
  }
}

function findWrappedEnd(source: string, start: number, opener: string, closer: string): number {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (index > start && (char === '\n' || char === '\r')) return -1;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === opener) depth += 1;
    if (char === closer) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

export function protocolSignature(form: ProtocolForm, name: string, delimiter: string, fieldCount: number): string {
  return createHash('sha256').update(JSON.stringify([form, name.toLowerCase(), delimiter, fieldCount])).digest('hex').slice(0, 24);
}

function mergeRanges(ranges: Array<{ start: number; end: number }>): Array<{ start: number; end: number }> {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const result: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else result.push({ ...range });
  }
  return result;
}

function readablePath(path: Array<string | number>): string {
  if (path[0] === '$module') {
    const [, ...rest] = path;
    return `模块.${rest.map(String).join('.')}`;
  }
  return path.length ? path.map(String).join('.') : '卡片根节点';
}
