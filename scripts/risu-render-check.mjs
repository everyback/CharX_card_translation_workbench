/**
 * Local mirror of RisuAI's message render pipeline, used to verify that
 * converted markup really survives it.
 *
 * Mirrors `ParseMarkdown()` in RisuAI `src/ts/parser/parser.svelte.ts`:
 * markdown-it (html:true, breaks:true, code fence disabled) → DOMPurify with
 * RisuAI's class/iframe hooks → `<style>` ↔ `<risu-style>` hex round trip →
 * class prefixing and `.chattext` scoping by `decodeStyleRule()`.
 *
 * Usage: node scripts/risu-render-check.mjs <fragment.html> [outDir]
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import MarkdownIt from 'markdown-it';
import createDOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

const { encodeRisuStyleBlock, decodeRisuStyleBlock } = await import(
  pathToFileURL(path.join(process.cwd(), 'tmp/build/server/domain/card/risu-style.js')).href
);

const markdownItOptions = {
  html: true,
  breaks: true,
  linkify: false,
  typographer: true,
  quotes: '\u{E9b0}\u{E9b1}\u{E9b2}\u{E9b3}',
};

const md = MarkdownIt({ ...markdownItOptions, highlight: (str, lang) => `<pre-hljs-placeholder lang="${lang}">${str}</pre-hljs-placeholder>` });
md.disable(['code']);

const dom = new JSDOM('<!doctype html><html><body><div id="chat" class="text chat chattext prose"></div></body></html>');
const DOMPurify = createDOMPurify(dom.window);

DOMPurify.addHook('uponSanitizeElement', (node, data) => {
  if (data.tagName === 'iframe') {
    const src = node.getAttribute('src') || '';
    if (!src.startsWith('https://www.youtube.com/embed/')) return node.parentNode.removeChild(node);
  }
  if (data.tagName === 'img') {
    if (!node.getAttribute('loading')) node.setAttribute('loading', 'lazy');
  }
});

DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  if (data.attrName !== 'class') return;
  if (!data.attrValue) return;
  data.attrValue = data.attrValue
    .split(' ')
    .map((v) => (v.startsWith('hljs') || v.startsWith('x-risu-') ? v : 'x-risu-' + v))
    .join(' ');
});

const styleRegex = /<style>([\s\S]*?)<\/style>/gims;
const styleDecodeRegex = /<risu-style>([\s\S]*?)<\/risu-style>/gims;

function encodeStyle(txt) {
  return txt.replace(styleRegex, (_f, c1) => encodeRisuStyleBlock(c1));
}

/** Mirrors decodeStyleRule(): prefix classes, then scope under `.chattext`. */
function decodeStyleRule(selectorList) {
  return selectorList
    .split(',')
    .map((raw) => {
      const selector = raw.trim();
      if (!selector) return '';
      const prefixed = selector.replace(/\.(-?[_a-zA-Z][\w-]*)/g, (full, name) =>
        name.startsWith('x-risu-') ? full : `.x-risu-${name}`,
      );
      return `.chattext ${prefixed}`;
    })
    .filter(Boolean)
    .join(',');
}

/**
 * Mirrors decodeStyle(): hex payload back to CSS, then every rule's selector
 * prelude is prefixed and scoped. At-rule blocks recurse (RisuAI walks
 * `media`/`supports`/`document`/`host`/`container` and leaves `@keyframes`
 * selectors alone).
 */
function decodeStyle(text) {
  return text.replace(styleDecodeRegex, (_full, payload) => {
    const css = decodeRisuStyleBlock(payload);
    let out = '';
    let index = 0;
    while (index < css.length) {
      const brace = css.indexOf('{', index);
      if (brace === -1) {
        out += css.slice(index);
        break;
      }
      const prelude = css.slice(index, brace);
      const body = matchBrace(css, brace);
      const atRule = /^\s*@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase();
      if (!atRule) {
        out += `${decodeStyleRule(prelude)}{${body}}`;
      } else if (['media', 'supports', 'container', 'layer'].includes(atRule)) {
        out += `${prelude}{${decodeStyle(body)}}`;
      } else {
        out += `${prelude}{${body}}`;
      }
      index = brace + 1 + body.length + 1;
    }
    return `<style>${out}</style>`;
  });
}

function matchBrace(css, open) {
  let depth = 0;
  let index = open;
  while (index < css.length) {
    if (css[index] === '{') depth += 1;
    else if (css[index] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
    index += 1;
  }
  return css.slice(open + 1);
}

function trimMarkdown(data) {
  const sant = DOMPurify.sanitize(data, {
    ADD_TAGS: ['iframe', 'style', 'risu-style', 'x-em'],
    ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'scrolling', 'risu-ctrl', 'risu-btn', 'risu-trigger', 'risu-mark', 'risu-id', 'x-hl-lang', 'x-hl-text'],
  });
  const decoded = decodeStyle(sant);
  if (decoded !== sant) {
    return DOMPurify.sanitize(decoded, {
      ADD_TAGS: ['iframe', 'style', 'risu-style', 'x-em'],
      ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'scrolling', 'risu-ctrl', 'risu-btn', 'risu-trigger', 'risu-mark', 'risu-id', 'x-hl-lang', 'x-hl-text'],
      FORCE_BODY: true,
    });
  }
  return decoded;
}

function parseThoughtsAndTools(data) {
  let result = '';
  let i = 0;
  while (i < data.length) {
    if (data.slice(i, i + 10) === '<Thoughts>') {
      let j = i + 10;
      let depth = 1;
      while (j < data.length && depth > 0) {
        if (data.slice(j, j + 10) === '<Thoughts>') depth += 1;
        if (data.slice(j, j + 11) === '</Thoughts>') depth -= 1;
        j += 1;
      }
      if (depth === 0) {
        result += `<details><summary>Thoughts</summary>${data.substring(i + 10, j - 1)}</details>`;
        i = j + 10;
        continue;
      }
    }
    result += data[i++];
  }
  return result;
}

/** Full pipeline for one message body. */
export function parseMarkdown(data) {
  let out = parseThoughtsAndTools(data ?? '');
  out = encodeStyle(out);
  out = md.render(out.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"));
  return trimMarkdown(out);
}

/** Convenience: render into a jsdom document so computed structure can be asserted. */
export function renderIntoDocument(messageText) {
  const html = parseMarkdown(messageText);
  const doc = new JSDOM(`<!doctype html><html><head><meta charset="utf-8"></head><body>
<div class="text chat chattext prose" id="chat">${html}</div></body></html>`);
  return { html, document: doc.window.document, window: doc.window };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const input = process.argv[2];
  if (!input) {
    console.error('用法: node scripts/risu-render-check.mjs <fragment.html> [outDir]');
    process.exit(2);
  }
  const source = fs.readFileSync(input, 'utf8');
  const { html } = renderIntoDocument(source);
  const outDir = process.argv[3] ?? 'tmp/render';
  fs.mkdirSync(outDir, { recursive: true });
  const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>body{background:#101018;margin:0;padding:12px;font-family:'Microsoft YaHei',Arial,sans-serif;color:#ddd;}
.chattext{max-width:760px;margin:0 auto;background:#15131f;border-radius:12px;padding:10px;}</style>
</head><body><div class="chattext prose" id="chat">${html}</div></body></html>`;
  fs.writeFileSync(path.join(outDir, 'rendered-message.html'), html);
  fs.writeFileSync(path.join(outDir, 'rendered-page.html'), page);
  console.log('rendered html length:', html.length);
  console.log('wrote', path.join(outDir, 'rendered-message.html'));
  console.log('wrote', path.join(outDir, 'rendered-page.html'));
}
