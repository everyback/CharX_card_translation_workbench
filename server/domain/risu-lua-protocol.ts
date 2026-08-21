import {
  protocolSignature,
  type ProtocolDiscoveryCluster,
  type ProtocolFieldRule,
  type ProtocolForm,
  type ProtocolReference,
} from './protocol.js';

interface LuaCapture {
  raw: string;
}

interface ParsedLuaProtocol {
  name: string;
  form: ProtocolForm;
  opener: string;
  closer: string;
  delimiter: string;
  captures: LuaCapture[];
}

interface CaptureRange extends LuaCapture {
  start: number;
  end: number;
}

export function discoverRisuLuaProtocols(
  references: readonly ProtocolReference[],
): ProtocolDiscoveryCluster[] {
  const clusters: ProtocolDiscoveryCluster[] = [];
  for (const reference of references) {
    if (reference.kind !== 'lua' || !reference.pattern.endsWith('模式')) continue;
    for (const parsed of parseLuaProtocolPattern(reference.literal)) {
      const fieldRules = parsed.captures.map((capture, index) => inferLuaField(capture, index + 1));
      clusters.push({
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
        declaration: `Lua 匹配 ${reference.pattern} · ${reference.literal}`,
        examples: [reference.literal],
        referenceCount: 1 + fieldRules.filter((field) => field.hardProtected).length,
        occurrences: [],
      });
    }
  }
  return deduplicateLuaSchemas(clusters);
}

export function mergeLuaProtocolEvidence(
  local: readonly ProtocolDiscoveryCluster[],
  lua: readonly ProtocolDiscoveryCluster[],
): ProtocolDiscoveryCluster[] {
  const merged = new Map(local.map((cluster) => [cluster.signature, structuredClone(cluster)]));
  for (const luaCluster of lua) {
    const localCluster = merged.get(luaCluster.signature);
    if (!localCluster) {
      merged.set(luaCluster.signature, structuredClone(luaCluster));
      continue;
    }
    const fieldRules = localCluster.fieldRules.map((localField) => {
      const luaField = luaCluster.fieldRules.find((field) => field.index === localField.index);
      if (!luaField) return localField;
      if (luaField.hardProtected) {
        return {
          ...luaField,
          role: meaningfulRole(localField.role) ? localField.role : luaField.role,
          reason: combineReasons(luaField.reason, localField.reason),
        };
      }
      return {
        ...localField,
        confidence: Math.max(localField.confidence, luaField.confidence),
        reason: combineReasons(luaField.reason, localField.reason),
      };
    });
    merged.set(luaCluster.signature, {
      ...localCluster,
      source: 'regex-lua',
      fieldRules,
      confidence: averageConfidence(fieldRules),
      declaration: luaCluster.declaration,
      examples: uniqueStrings([...localCluster.examples, ...luaCluster.examples]).slice(0, 8),
      referenceCount: Math.max(luaCluster.referenceCount, localCluster.referenceCount),
    });
  }
  return [...merged.values()];
}

// Lua patterns are not JavaScript regular expressions. This scanner accepts
// only wrapped protocols with top-level captures and uniform field separators.
function parseLuaProtocolPattern(pattern: string): ParsedLuaProtocol[] {
  const wrapper = wrapperBounds(pattern);
  if (!wrapper) return [];
  const inner = pattern.slice(wrapper.contentStart, wrapper.contentEnd);
  const captures = captureRanges(inner);
  if (!captures.length) return [];

  const prefix = inner.slice(0, captures[0].start);
  const delimiterPosition = firstLuaDelimiter(prefix);
  if (!delimiterPosition) return [];
  const namePattern = prefix.slice(0, delimiterPosition.index);
  const betweenNameAndCapture = prefix.slice(delimiterPosition.end);
  if (!luaWhitespaceOnly(betweenNameAndCapture)) return [];

  for (let index = 1; index < captures.length; index += 1) {
    const separator = inner.slice(captures[index - 1].end, captures[index].start);
    if (!sameLuaDelimiter(separator, delimiterPosition.delimiter)) return [];
  }
  if (!luaWhitespaceOnly(inner.slice(captures.at(-1)?.end ?? inner.length))) return [];

  const names = luaProtocolNames(namePattern);
  if (!names.length) return [];
  return names.map((name) => ({
    name,
    form: wrapper.opener === '<' ? 'angle' : 'square',
    opener: wrapper.opener,
    closer: wrapper.closer,
    delimiter: delimiterPosition.delimiter,
    captures: captures.map(({ raw }) => ({ raw })),
  }));
}

function wrapperBounds(pattern: string): {
  opener: string;
  closer: string;
  contentStart: number;
  contentEnd: number;
} | null {
  const candidates = [
    { token: '%[', opener: '[', closerToken: '%]', closer: ']' },
    { token: '<', opener: '<', closerToken: '>', closer: '>' },
  ];
  for (const candidate of candidates) {
    const start = pattern.indexOf(candidate.token);
    if (start < 0 || !luaOuterPrefix(pattern.slice(0, start))) continue;
    const end = pattern.lastIndexOf(candidate.closerToken);
    if (end <= start || !luaOuterSuffix(pattern.slice(end + candidate.closerToken.length))) continue;
    return {
      opener: candidate.opener,
      closer: candidate.closer,
      contentStart: start + candidate.token.length,
      contentEnd: end,
    };
  }
  return null;
}

function luaOuterPrefix(value: string): boolean {
  return /^(?:\^|%s[*+-]?|\s|\()*$/.test(value);
}

function luaOuterSuffix(value: string): boolean {
  return /^(?:\)|%s[*+-]?|\s|\$)*$/.test(value);
}

function captureRanges(value: string): CaptureRange[] {
  const captures: CaptureRange[] = [];
  let classDepth = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '%') {
      index += 1;
      continue;
    }
    if (value[index] === '[') {
      classDepth = true;
      continue;
    }
    if (value[index] === ']' && classDepth) {
      classDepth = false;
      continue;
    }
    if (classDepth || value[index] !== '(') continue;
    const end = closingCapture(value, index);
    if (end < 0) return [];
    captures.push({ start: index, end: end + 1, raw: value.slice(index, end + 1) });
    index = end;
  }
  return captures;
}

function closingCapture(value: string, start: number): number {
  let depth = 0;
  let inClass = false;
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === '%') {
      index += 1;
      continue;
    }
    if (value[index] === '[') inClass = true;
    else if (value[index] === ']' && inClass) inClass = false;
    else if (!inClass && value[index] === '(') depth += 1;
    else if (!inClass && value[index] === ')' && --depth === 0) return index;
  }
  return -1;
}

function firstLuaDelimiter(value: string): { delimiter: string; index: number; end: number } | null {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '%' && index + 1 < value.length) {
      const literal = value[index + 1];
      if (literal === '|' || literal === ':') return { delimiter: literal, index, end: index + 2 };
      index += 1;
      continue;
    }
    if (value[index] === '|' || value[index] === ':') {
      return { delimiter: value[index], index, end: index + 1 };
    }
  }
  return null;
}

function sameLuaDelimiter(value: string, delimiter: string): boolean {
  const normalized = value.replace(/%s[*+-]?/g, '').replace(/\s/g, '');
  return normalized === delimiter || normalized === `%${delimiter}`;
}

function luaWhitespaceOnly(value: string): boolean {
  return /^(?:%s[*+-]?|\s)*$/.test(value);
}

function luaProtocolNames(value: string): string[] {
  const optional = value.match(/^(.*?)([^%])\?$/u);
  const variants = optional ? [optional[1], `${optional[1]}${optional[2]}`] : [value];
  return uniqueStrings(variants.map((variant) => variant
    .replace(/\.\-$/, '')
    .replace(/\.\*$/, '')
    .replace(/%(.)/g, '$1')
    .trim()))
    .filter((name) => /^[\p{L}_][\p{L}\p{N}\p{M}_.-]{0,63}$/u.test(name));
}

function inferLuaField(capture: LuaCapture, index: number): ProtocolFieldRule {
  if (luaStructuralCapture(capture.raw)) {
    return {
      index,
      role: `field_${index}`,
      policy: 'protect',
      confidence: 1,
      reason: `Lua 捕获槽位只接受数字或控制值 ${capture.raw}`,
      hardProtected: true,
    };
  }
  return {
    index,
    role: `field_${index}`,
    policy: 'manual',
    confidence: 0.9,
    reason: `Lua 匹配模式捕获槽位 ${capture.raw}，未发现 Risu 显示模板`,
    hardProtected: false,
  };
}

function luaStructuralCapture(raw: string): boolean {
  const body = raw.slice(1, -1).trim();
  return /^(?:%d|%x|\[\^?0-9A-Fa-f-]+\])[*+?-]*$/.test(body);
}

function deduplicateLuaSchemas(clusters: ProtocolDiscoveryCluster[]): ProtocolDiscoveryCluster[] {
  const result = new Map<string, ProtocolDiscoveryCluster>();
  for (const cluster of clusters) {
    const existing = result.get(cluster.signature);
    if (!existing) {
      result.set(cluster.signature, cluster);
      continue;
    }
    result.set(cluster.signature, {
      ...existing,
      declaration: uniqueStrings([existing.declaration, cluster.declaration]).join(' / '),
      examples: uniqueStrings([...existing.examples, ...cluster.examples]).slice(0, 8),
      referenceCount: existing.referenceCount + cluster.referenceCount,
    });
  }
  return [...result.values()];
}

function meaningfulRole(value?: string): boolean {
  return Boolean(value && !/^field_\d+$/.test(value));
}

function combineReasons(primary: string, secondary: string): string {
  return uniqueStrings([primary, secondary]).join('；');
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function averageConfidence(fields: ProtocolFieldRule[]): number {
  return fields.length ? fields.reduce((sum, field) => sum + field.confidence, 0) / fields.length : 0;
}
