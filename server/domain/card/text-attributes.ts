import { TEXT_ATTRIBUTE_POLICY } from '../../../config/text-attributes.js';

export interface TextAttribute {
  tag: string;
  name: string;
  start: number;
  end: number;
  quote: string;
  text: string;
}

// Quoted values may contain >, newlines and quotes of the opposite kind.
export const MARKUP_TOKEN_SOURCE = '<!--[\\s\\S]*?-->|<(?:"[^"\\x00]*"|\'[^\'\\x00]*\'|[^<>"\'])+>';

export function textAttributes(source: string, policy = TEXT_ATTRIBUTE_POLICY): TextAttribute[] {
  const result: TextAttribute[] = [];
  const tokens = new RegExp('```[\\s\\S]*?```|<script\\b[^>]*>[\\s\\S]*?<\\/script\\s*>|<style\\b[^>]*>[\\s\\S]*?<\\/style\\s*>|' + MARKUP_TOKEN_SOURCE, 'giu');
  for (const token of source.matchAll(tokens)) {
    const head = token[0].match(/^<([a-z][\w:-]*)\b/iu);
    if (!head || /^(script|style)$/iu.test(head[1])) continue;
    const tag = head[1].toLowerCase();
    // Only whitespace-separated quoted assignments are eligible.
    const attrs = /\s+([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/gu;
    for (const attr of token[0].matchAll(attrs)) {
      const name = attr[1].toLowerCase();
      if (/^(?:on|data-on)/u.test(name) || /^(?:id|chara|state|src|href|class|style|path|url|key|type|name)$/u.test(name)) continue;
      if (name === 'value' && tag === 'input'
        && !/\btype\s*=\s*(["'])(?:button|submit|reset)\1/iu.test(token[0])) continue;
      if (!policy.common.includes(name) && !policy.byTag[tag]?.includes(name)) continue;
      const start = token.index + attr.index + attr[0].indexOf(attr[2]) + 1;
      result.push({ tag, name, start, end: start + attr[3].length, quote: attr[2], text: attr[3] });
    }
  }
  return result;
}

export function escapeTextAttribute(value: string, quote: string): string {
  // Preserve existing entities, encode only characters capable of breaking markup.
  return value.replace(/&(?!(?:#\d+|#x[\da-f]+|[a-z][\da-z]+);)/giu, '&amp;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll(quote, quote === '"' ? '&quot;' : '&#39;');
}
