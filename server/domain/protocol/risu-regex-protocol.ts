import { RegExpParser, type AST } from '@eslint-community/regexpp';
import {
  protocolSignature,
  type ProtocolDiscoveryCluster,
  type ProtocolFieldRule,
  type ProtocolForm,
  type ProtocolReference,
} from './protocol.js';

interface RegexRule {
  index: number;
  comment: string;
  input: string;
  output: string;
  type: string;
}

interface CapturePiece {
  kind: 'capture';
  group: AST.CapturingGroup;
  groupNumber: number;
}

interface LiteralPiece {
  kind: 'literal';
  value: string;
}

interface DynamicPiece {
  kind: 'dynamic';
  raw: string;
  ignorableWhitespace: boolean;
}

type PatternPiece = CapturePiece | LiteralPiece | DynamicPiece;

interface ParsedRegexProtocol {
  name: string;
  form: ProtocolForm;
  opener: string;
  closer: string;
  delimiter: string;
  captures: CapturePiece[];
  labels: string[];
}

const parser = new RegExpParser({ ecmaVersion: 2025 });

export function discoverRisuRegexProtocols(
  module: Record<string, unknown>,
  references: readonly ProtocolReference[] = [],
): ProtocolDiscoveryCluster[] {
  const result: ProtocolDiscoveryCluster[] = [];
  for (const rule of regexRules(module)) {
    const parsed = parseRegexProtocol(rule.input);
    if (!parsed) continue;
    const luaEvidence = references.filter((reference) => (
      reference.kind === 'lua' && referenceMentionsProtocol(reference, parsed)
    ));
    const fieldRules = parsed.captures.map((capture, arrayIndex) => inferRegexField(
      capture, arrayIndex + 1, rule, luaEvidence.length > 0, parsed.labels[arrayIndex],
    ));
    const evidence = [
      `Risu 正则 #${rule.index + 1}${rule.comment ? ` ${rule.comment}` : ''}`,
      rule.input,
      ...(luaEvidence.length ? [`Lua 联合引用 ${luaEvidence.length} 处`] : []),
    ];
    result.push({
      source: 'regex-lua',
      signature: protocolSignature(parsed.form, parsed.name, parsed.delimiter, parsed.captures.length),
      name: parsed.name,
      form: parsed.form,
      opener: parsed.opener,
      closer: parsed.closer,
      delimiter: parsed.delimiter,
      fieldCount: parsed.captures.length,
      status: 'pending',
      fieldRules,
      confidence: averageConfidence(fieldRules),
      occurrenceCount: 0,
      declaration: evidence.join(' · '),
      examples: [rule.input],
      referenceCount: luaEvidence.length + fieldRules.filter((field) => field.hardProtected).length,
      occurrences: [],
    });
  }
  return deduplicateRegexSchemas(result);
}

export function mergeRegexProtocolEvidence(
  local: readonly ProtocolDiscoveryCluster[],
  regex: readonly ProtocolDiscoveryCluster[],
): ProtocolDiscoveryCluster[] {
  const merged = new Map(local.map((cluster) => [cluster.signature, structuredClone(cluster)]));
  for (const regexCluster of regex) {
    const localCluster = merged.get(regexCluster.signature);
    if (!localCluster) {
      merged.set(regexCluster.signature, structuredClone(regexCluster));
      continue;
    }
    const fieldRules = regexCluster.fieldRules.map((regexField) => {
      const localField = localCluster.fieldRules.find((field) => field.index === regexField.index);
      if (localField?.hardProtected) {
        return {
          ...localField,
          reason: combineReasons(regexField.reason, localField.reason),
        };
      }
      return {
        ...regexField,
        role: meaningfulRole(localField?.role) ? String(localField?.role) : regexField.role,
        confidence: Math.max(regexField.confidence, localField?.confidence ?? 0),
        reason: combineReasons(regexField.reason, localField?.reason ?? ''),
      };
    });
    merged.set(regexCluster.signature, {
      ...localCluster,
      source: 'regex-lua',
      fieldRules,
      confidence: averageConfidence(fieldRules),
      declaration: localCluster.source === 'regex-lua'
        ? uniqueStrings([regexCluster.declaration, localCluster.declaration]).join(' / ')
        : regexCluster.declaration,
      examples: uniqueStrings([...localCluster.examples, ...regexCluster.examples]).slice(0, 8),
      referenceCount: Math.max(regexCluster.referenceCount, localCluster.referenceCount),
    });
  }
  return [...merged.values()].sort((left, right) => (
    Number(right.source === 'regex-lua') - Number(left.source === 'regex-lua')
    || right.occurrenceCount - left.occurrenceCount
    || left.name.localeCompare(right.name)
  ));
}

function regexRules(module: Record<string, unknown>): RegexRule[] {
  const raw = Array.isArray(module.regex) ? module.regex : [];
  return raw.flatMap((value, index) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const rule = value as Record<string, unknown>;
    if (typeof rule.in !== 'string' || typeof rule.out !== 'string') return [];
    return [{
      index,
      comment: typeof rule.comment === 'string' ? rule.comment : '',
      input: rule.in,
      output: rule.out,
      type: typeof rule.type === 'string' ? rule.type : '',
    }];
  });
}

function parseRegexProtocol(source: string): ParsedRegexProtocol | null {
  let pattern: AST.Pattern;
  try {
    pattern = parser.parsePattern(source, 0, source.length, { unicode: true, unicodeSets: false });
  } catch {
    try {
      pattern = parser.parsePattern(source, 0, source.length, { unicode: false, unicodeSets: false });
    } catch {
      return null;
    }
  }
  if (pattern.alternatives.length !== 1) return null;
  const groupNumbers = captureNumbers(pattern);
  const pieces = flattenAlternative(pattern.alternatives[0], groupNumbers);
  if (!pieces) return null;
  const captures = pieces.filter((piece): piece is CapturePiece => piece.kind === 'capture');
  if (!captures.length) return null;
  const firstCaptureIndex = pieces.findIndex((piece) => piece.kind === 'capture');
  const lastCaptureIndex = previousCaptureIndex(pieces, pieces.length);
  const prefix = protocolLiteral(pieces.slice(0, firstCaptureIndex), true);
  const suffix = protocolLiteral(pieces.slice(lastCaptureIndex + 1), false);
  if (!prefix || !suffix) return null;
  const opener = prefix[0];
  const closer = opener === '<' ? '>' : opener === '[' ? ']' : '';
  if (!closer || !suffix.endsWith(closer)) return null;
  const innerPrefix = prefix.slice(1);
  const delimiter = inferCaptureDelimiter(pieces, firstCaptureIndex, lastCaptureIndex)
    || firstDelimiterPosition(innerPrefix)?.delimiter;
  if (!delimiter) return null;
  const nameSeparator = firstDelimiterPosition(innerPrefix);
  const name = nameSeparator && nameSeparator.delimiter !== delimiter
    ? innerPrefix.slice(0, nameSeparator.index).trim()
    : innerPrefix.endsWith(delimiter)
      ? innerPrefix.slice(0, -delimiter.length).trim()
      : nameSeparator
        ? innerPrefix.slice(0, nameSeparator.index).trim()
        : '';
  if (!/^[\p{L}_][\p{L}\p{N}\p{M}_.-]{0,63}$/u.test(name)) return null;
  const labels = [name];
  for (let index = firstCaptureIndex + 1; index <= lastCaptureIndex; index += 1) {
    if (pieces[index].kind !== 'capture') continue;
    const previousCapture = previousCaptureIndex(pieces, index);
    const separator = protocolLiteral(pieces.slice(previousCapture + 1, index), false);
    const label = captureLabel(separator, delimiter);
    if (label == null) return null;
    labels.push(label);
  }
  const suffixBody = suffix.slice(0, -closer.length);
  if (suffixBody.trim()) return null;
  return {
    name,
    form: opener === '<' ? 'angle' : 'square',
    opener,
    closer,
    delimiter,
    captures,
    labels,
  };
}

function flattenAlternative(
  alternative: AST.Alternative,
  groupNumbers: Map<AST.CapturingGroup, number>,
): PatternPiece[] | null {
  const pieces: PatternPiece[] = [];
  for (const element of alternative.elements) {
    if (element.type === 'Character') {
      appendLiteral(pieces, String.fromCodePoint(element.value));
      continue;
    }
    if (element.type === 'Assertion') {
      if (element.kind === 'start' || element.kind === 'end') continue;
      return null;
    }
    if (element.type === 'CapturingGroup') {
      pieces.push({ kind: 'capture', group: element, groupNumber: groupNumbers.get(element) ?? 0 });
      continue;
    }
    if (element.type === 'Group') {
      if (element.alternatives.length !== 1) return null;
      const nested = flattenAlternative(element.alternatives[0], groupNumbers);
      if (!nested) return null;
      appendPieces(pieces, nested);
      continue;
    }
    if (element.type === 'Quantifier') {
      if (element.element.type === 'CapturingGroup') {
        pieces.push({ kind: 'capture', group: element.element, groupNumber: groupNumbers.get(element.element) ?? 0 });
        continue;
      }
      const literal = fixedQuantifierLiteral(element);
      if (literal != null) appendLiteral(pieces, literal);
      else pieces.push({
        kind: 'dynamic',
        raw: element.raw,
        ignorableWhitespace: /^(?:\\s| )/.test(element.raw),
      });
      continue;
    }
    pieces.push({ kind: 'dynamic', raw: element.raw, ignorableWhitespace: false });
  }
  return pieces;
}

function inferRegexField(
  capture: CapturePiece,
  index: number,
  rule: RegexRule,
  luaLinked: boolean,
  label?: string,
): ProtocolFieldRule {
  const usage = replacementUsage(rule.output, capture.groupNumber);
  const structural = structuralCapture(capture.group);
  const luaReason = luaLinked ? '；Lua 同时生成或匹配该协议' : '';
  const role = capture.group.name || label || `field_${index}`;
  if (structural) {
    return {
      index, role, policy: 'protect', confidence: 1,
      reason: `正则捕获组只接受控制值 ${capture.group.raw}${luaReason}`,
      hardProtected: true,
    };
  }
  if (rule.type !== 'editdisplay') {
    return {
      index, role, policy: 'protect', confidence: 0.98,
      reason: `Risu ${rule.type || '非显示'} 正则消费此槽位${luaReason}`,
      hardProtected: true,
    };
  }
  if (/^(?:id|key|code|type|kind|mode|state|status|flag|action|command|event|path|url|uri|index|count|number|num|lv|level|time|date|hp|health|corruption|danger|risk|priority|order|version|enabled|active)$/iu.test(role)) {
    return {
      index, role, policy: 'protect', confidence: 0.96,
      reason: `协议标签 ${role} 表示数值或运行时控制字段${luaReason}`,
      hardProtected: false,
    };
  }
  if (usage.visible && usage.control) {
    return {
      index, role, policy: 'manual', confidence: 0.9,
      reason: `捕获组 $${capture.groupNumber} 同时用于显示和模板控制${luaReason}`,
      hardProtected: false,
    };
  }
  if (usage.visible) {
    return {
      index, role, policy: 'translate', confidence: 0.98,
      reason: `Risu 正则输出将捕获组 $${capture.groupNumber} 渲染为可见文字${luaReason}`,
      hardProtected: false,
    };
  }
  if (luaLinked) {
    return {
      index, role, policy: 'manual', confidence: 0.92,
      reason: `捕获组 $${capture.groupNumber} 不直接输出，由 Lua 继续读取或处理`,
      hardProtected: false,
    };
  }
  return {
    index, role, policy: 'protect', confidence: 0.99,
    reason: `捕获组 $${capture.groupNumber} 未作为可见文字输出${luaReason}`,
    hardProtected: true,
  };
}

function replacementUsage(output: string, groupNumber: number): { visible: boolean; control: boolean } {
  const marker = `$${groupNumber}`;
  let offset = 0;
  let visible = false;
  let control = false;
  while ((offset = output.indexOf(marker, offset)) >= 0) {
    const macroOpen = output.lastIndexOf('{{', offset);
    const macroClose = output.lastIndexOf('}}', offset);
    const tagOpen = output.lastIndexOf('<', offset);
    const tagClose = output.lastIndexOf('>', offset);
    if (macroOpen > macroClose || tagOpen > tagClose) control = true;
    else visible = true;
    offset += marker.length;
  }
  return { visible, control };
}

function structuralCapture(group: AST.CapturingGroup): boolean {
  const raw = group.raw;
  if (/\\d|\[0-9|\\p\{Number\}/u.test(raw) && !/\.\*|\[\^/.test(raw)) return true;
  if (group.alternatives.length > 1) {
    return group.alternatives.every((alternative) => alternative.elements.every((element) => (
      element.type === 'Character'
    )));
  }
  return false;
}

function referenceMentionsProtocol(reference: ProtocolReference, protocol: ParsedRegexProtocol): boolean {
  const normalized = `${reference.literal} ${reference.pattern}`
    .replaceAll('\\', '')
    .replaceAll('%', '')
    .toLowerCase();
  return normalized.includes(`${protocol.opener}${protocol.name.toLowerCase()}`)
    && normalized.includes(protocol.delimiter);
}

function protocolLiteral(pieces: PatternPiece[], allowNameDynamic: boolean): string | null {
  let result = '';
  for (const piece of pieces) {
    if (piece.kind === 'literal') result += piece.value;
    else if (piece.kind === 'dynamic') {
      if (piece.ignorableWhitespace) continue;
      if (allowNameDynamic && result.length > 1 && !/[|:]/.test(result)) continue;
      return null;
    } else return null;
  }
  return result;
}

function captureNumbers(pattern: AST.Pattern): Map<AST.CapturingGroup, number> {
  const groups: AST.CapturingGroup[] = [];
  const visitAlternative = (alternative: AST.Alternative) => {
    for (const element of alternative.elements) {
      const target = element.type === 'Quantifier' ? element.element : element;
      if (target.type === 'CapturingGroup') {
        groups.push(target);
        target.alternatives.forEach(visitAlternative);
      } else if (target.type === 'Group' || (target.type === 'Assertion' && 'alternatives' in target)) {
        target.alternatives.forEach(visitAlternative);
      }
    }
  };
  pattern.alternatives.forEach(visitAlternative);
  groups.sort((left, right) => left.start - right.start);
  return new Map(groups.map((group, index) => [group, index + 1]));
}

function fixedQuantifierLiteral(quantifier: AST.Quantifier): string | null {
  if (quantifier.min !== quantifier.max || quantifier.max > 16) return null;
  if (quantifier.element.type !== 'Character') return null;
  return String.fromCodePoint(quantifier.element.value).repeat(quantifier.min);
}

function firstDelimiterPosition(value: string): { delimiter: string; index: number } | null {
  const choices = ['|', ':']
    .map((delimiter) => ({ delimiter, index: value.indexOf(delimiter) }))
    .filter((choice) => choice.index >= 1)
    .sort((left, right) => left.index - right.index);
  return choices[0] ?? null;
}

function inferCaptureDelimiter(pieces: PatternPiece[], firstCapture: number, lastCapture: number): string | null {
  let previous = firstCapture;
  for (let index = firstCapture + 1; index <= lastCapture; index += 1) {
    if (pieces[index]?.kind !== 'capture') continue;
    const literal = protocolLiteral(pieces.slice(previous + 1, index), false);
    if (!literal) continue;
    const match = literal.match(/^[\s]*([|;:])[\s\S]*$/u);
    if (match) return match[1];
    previous = index;
  }
  return null;
}

function captureLabel(separator: string | null, delimiter: string): string | null {
  if (!separator || !separator.startsWith(delimiter)) return null;
  const suffix = separator.slice(delimiter.length).trim();
  if (!suffix) return '';
  const match = suffix.match(/^([\p{L}_][\p{L}\p{N}\p{M}_.-]{0,63}):\s*$/u);
  return match?.[1] ?? null;
}

function previousCaptureIndex(pieces: PatternPiece[], before: number): number {
  for (let index = before - 1; index >= 0; index -= 1) {
    if (pieces[index].kind === 'capture') return index;
  }
  return -1;
}

function appendLiteral(pieces: PatternPiece[], value: string): void {
  const previous = pieces.at(-1);
  if (previous?.kind === 'literal') previous.value += value;
  else pieces.push({ kind: 'literal', value });
}

function appendPieces(target: PatternPiece[], values: PatternPiece[]): void {
  for (const value of values) {
    if (value.kind === 'literal') appendLiteral(target, value.value);
    else target.push(value);
  }
}

function deduplicateRegexSchemas(clusters: ProtocolDiscoveryCluster[]): ProtocolDiscoveryCluster[] {
  const result = new Map<string, ProtocolDiscoveryCluster>();
  for (const cluster of clusters) {
    const existing = result.get(cluster.signature);
    if (!existing) result.set(cluster.signature, cluster);
    else result.set(cluster.signature, {
      ...existing,
      declaration: uniqueStrings([existing.declaration, cluster.declaration]).join(' / '),
      examples: uniqueStrings([...existing.examples, ...cluster.examples]).slice(0, 8),
      referenceCount: Math.max(existing.referenceCount, cluster.referenceCount),
    });
  }
  return [...result.values()];
}

function meaningfulRole(value?: string): boolean {
  return Boolean(value && !/^field_\d+$/.test(value));
}

function combineReasons(primary: string, secondary: string): string {
  return uniqueStrings([primary, secondary]).filter(Boolean).join('；');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function averageConfidence(fields: ProtocolFieldRule[]): number {
  return fields.length ? fields.reduce((sum, field) => sum + field.confidence, 0) / fields.length : 0;
}
