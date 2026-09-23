/**
 * RisuAI `<risu-style>` hex transport.
 *
 * Mirrors `encodeStyle()` / `decodeStyle()` in RisuAI
 * `src/ts/parser/parser.svelte.ts`. A `<style>` block written by a model or a
 * preset regex would be destroyed by markdown-it and DOMPurify, so RisuAI
 * rewrites the CSS body in place as:
 *
 *   <risu-style>68656c6c6f207b7d</risu-style>
 *
 * `decodeStyle()` turns it back into `<style>…</style>` after sanitising, runs
 * `risuChatParser` over the CSS text (so `{{getvar::…}}` works inside styles),
 * and then prefixes every class selector with `x-risu-` and scopes every
 * selector under `.chattext`.
 */

const STYLE_TAG_RE = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/giu;
const RISU_STYLE_TAG_RE = /<risu-style>([\s\S]*?)<\/risu-style>/giu;

/** Wrap CSS in a `<risu-style>` block the RisuAI parser will decode. */
export function encodeRisuStyleBlock(css: string): string {
  return `<risu-style>${Buffer.from(css, 'utf8').toString('hex')}</risu-style>`;
}

/** Decode a `<risu-style>` block back to CSS. Throws when the payload is not hex. */
export function decodeRisuStyleBlock(payload: string): string {
  const hex = payload.trim();
  if (!/^[0-9a-fA-F]*$/u.test(hex) || hex.length % 2 !== 0) {
    throw new Error('risu-style 内容不是有效的十六进制。');
  }
  return Buffer.from(hex, 'hex').toString('utf8');
}

/**
 * Rewrite `<style>` blocks into `<risu-style>` blocks, exactly like RisuAI's
 * `encodeStyle()`. Useful when checking that generated markup will survive the
 * render pipeline. The regex is dotted-all (`s`) so multi-line CSS is captured.
 */
export function encodeStyleTags(html: string): string {
  return html.replace(STYLE_TAG_RE, (_full, css: string) => encodeRisuStyleBlock(css));
}

/** Rewrite `<risu-style>` blocks back into `<style>` blocks. */
export function decodeStyleTags(html: string): string {
  return html.replace(RISU_STYLE_TAG_RE, (_full, payload: string) => {
    try {
      return `<style>${decodeRisuStyleBlock(payload)}</style>`;
    } catch {
      return '';
    }
  });
}

/** True when the markup still carries ST-style `<style>` blocks. */
export function hasRawStyleTag(html: string): boolean {
  STYLE_TAG_RE.lastIndex = 0;
  return STYLE_TAG_RE.test(html);
}
