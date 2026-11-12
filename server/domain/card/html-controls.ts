import { TEXT_ATTRIBUTE_POLICY } from '../../../config/text-attributes.js';
import { MARKUP_TOKEN_SOURCE } from './text-attributes.js';

export interface MarkupControlAttribute {
  tag: string;
  name: string;
  value: string;
}

export interface MarkupControlRange extends MarkupControlAttribute {
  start: number;
  end: number;
  element: number;
}

export interface MarkupRange {
  start: number;
  end: number;
  text: string;
}

export function nonVisibleMarkupRanges(source: string): MarkupRange[] {
  return [...source.matchAll(/<(script|style)\b(?:"[^"]*"|'[^']*'|[^'">])*?>[\s\S]*?<\/\1\s*>/giu)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length, text: match[0] }));
}

export function htmlControlAttributes(source: string): MarkupControlAttribute[] {
  return htmlControlAttributeRanges(source).map(({ tag, name, value }) => ({ tag, name, value }));
}

export function htmlControlAttributeRanges(source: string): MarkupControlRange[] {
  const result: MarkupControlRange[] = [];
  let element = 0;
  const hidden = nonVisibleMarkupRanges(source);
  for (const token of source.matchAll(new RegExp(MARKUP_TOKEN_SOURCE, 'gu'))) {
    if (hidden.some(range => token.index > range.start && token.index < range.end)) continue;
    const head = /^<([a-z][\w:-]*)\b/iu.exec(token[0]);
    if (!head) continue;
    const tag = head[1].toLowerCase();
    for (const attribute of tagAttributes(token[0], head[0].length)) {
      if (isVisibleCopyAttribute(tag, attribute.name, token[0])) continue;
      result.push({ tag, name: attribute.name, value: attribute.value,
        start: token.index + attribute.start, end: token.index + attribute.end, element });
    }
    element++;
  }
  return result;
}

function isVisibleCopyAttribute(tag: string, name: string, token: string): boolean {
  if (TEXT_ATTRIBUTE_POLICY.common.includes(name)) return true;
  if (!TEXT_ATTRIBUTE_POLICY.byTag[tag]?.includes(name)) return false;
  return name !== 'value' || tag !== 'input'
    || /\btype\s*=\s*(["'])(?:button|submit|reset)\1/iu.test(token);
}

function tagAttributes(token: string, start: number): Array<{ name: string; value: string; start: number; end: number }> {
  const attributes: Array<{ name: string; value: string; start: number; end: number }> = [];
  let cursor = start;
  while (cursor < token.length) {
    while (/\s/u.test(token[cursor] ?? '')) cursor += 1;
    if (token[cursor] === '>' || token[cursor] === '/' || cursor >= token.length) break;
    const nameStart = cursor;
    while (cursor < token.length && !/[\s=/>]/u.test(token[cursor])) cursor += 1;
    if (cursor === nameStart) { cursor += 1; continue; }
    const name = token.slice(nameStart, cursor).toLowerCase();
    while (/\s/u.test(token[cursor] ?? '')) cursor += 1;
    if (token[cursor] !== '=') {
      attributes.push({ name, value: '', start: cursor, end: cursor });
      continue;
    }
    cursor += 1;
    while (/\s/u.test(token[cursor] ?? '')) cursor += 1;
    const quote = token[cursor] === '"' || token[cursor] === "'" ? token[cursor++] : '';
    const valueStart = cursor;
    if (quote) {
      while (cursor < token.length && token[cursor] !== quote) cursor += 1;
    } else {
      while (cursor < token.length && !/[\s>]/u.test(token[cursor])) cursor += 1;
    }
    attributes.push({ name, value: token.slice(valueStart, cursor), start: valueStart, end: cursor });
    if (quote && token[cursor] === quote) cursor += 1;
  }
  return attributes;
}
