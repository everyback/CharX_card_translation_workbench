/**
 * SillyTavern sandbox HTML → RisuAI in-message HTML.
 *
 * SillyTavern renders a fenced `html` block inside a sandboxed iframe: the
 * document gets its own `<head>`/`<body>`, its own JavaScript, and a
 * `postMessage({type:'resizeIframe'})` contract with the parent window.
 *
 * RisuAI does not have an iframe path at all. `ParseMarkdown()` in
 * `src/ts/parser/parser.svelte.ts` runs the message through:
 *
 *   1. `parseThoughtsAndTools()` — `<Thoughts>` becomes `<details>/<summary>`
 *   2. `encodeStyle()`          — every `<style>` body becomes
 *                                 `<risu-style>hex</risu-style>`
 *   3. markdown-it (`html: true`, code fence **disabled**)
 *   4. `DOMPurify.sanitize()`   — with hooks that
 *        - prefix every class with `x-risu-` (unless already `x-risu-`/`hljs`)
 *        - drop every `iframe` that is not a YouTube embed
 *        - drop `script`, `on*` handlers and unknown attributes
 *   5. `decodeStyle()`          — hex back to CSS, then
 *        - prefix every class selector with `x-risu-`
 *        - scope every selector with `.chattext ` (the message container)
 *        - rewrite `@import url(data:…)` to `data:,`
 *
 * So an ST block rendered as-is loses its `<script>`, its `onclick`, its
 * `postMessage` and any rule keyed on `html`/`body`/an `id`. This module
 * converts the block into the subset RisuAI actually honours, and reports
 * everything it had to change so the result can be reviewed instead of
 * silently degraded.
 */
import { encodeRisuStyleBlock } from './risu-style.js';
import { findStActions, type StActionCall, type StActionKind } from './st-action-map.js';
import { BRIDGE_ATTRIBUTE } from './preset-capability.js';

/**
 * ST action kinds the bridge plugin can perform.
 *
 * `details` is rebuilt as markup, `chat-record` belongs to a Lua trigger, and
 * `noop`/`unsupported` have no page to act on — none of those become bridge
 * declarations.
 */
const BRIDGE_ACTIONS: ReadonlySet<StActionKind> = new Set<StActionKind>(['fill', 'fill-send', 'copy']);

export type StHtmlIssueLevel = 'removed' | 'rewritten' | 'note';

export interface StHtmlIssue {
  level: StHtmlIssueLevel;
  code: string;
  message: string;
}

export interface StHtmlIssueCounts {
  removed: number;
  rewritten: number;
  note: number;
}

export interface StHtmlToRisuReport {
  issues: StHtmlIssue[];
  counts: StHtmlIssueCounts;
  /** Class names found in the markup; RisuAI prefixes all of them with `x-risu-`. */
  classes: string[];
  /** True when the ST block lived in its own document (doctype/`<html>`/`<body>`). */
  wasFullDocument: boolean;
  /** True when a `<script>` block was present and therefore dropped. */
  hadScript: boolean;
  /** True when a click-to-expand panel was rebuilt as `<details>/<summary>`. */
  collapsibleRebuilt: boolean;
  /** Number of buttons that received a `risu-btn` hook. */
  buttonsWired: number;
  /**
   * Bridge actions emitted, keyed by action (`fill-send`, `fill`, `copy`).
   *
   * These are the elements whose SillyTavern behaviour cannot exist in RisuAI and
   * is therefore delegated to the plugin. The counts feed the conversion report
   * so the review UI can say "this block needs the plugin, and here is what it
   * must do".
   */
  bridgeActions: Record<string, number>;
  /** Length of the emitted fragment, excluding the `<risu-style>` block. */
  markupLength: number;
  /** Length of the original ST block. */
  sourceLength: number;
}

export interface StHtmlToRisuResult {
  /** `<risu-style>` block plus the sanitised fragment, ready to paste into a regex `out`. */
  html: string;
  /** The same fragment without the style block, for review or diffing. */
  markup: string;
  /** Prefixed/scoped CSS, before hex encoding. */
  css: string;
  report: StHtmlToRisuReport;
}

export interface CollapsibleOptions {
  /** Class on the element that toggles the panel. Defaults to the first inline handler. */
  toggleClass?: string;
  /** Class on the collapsing body. Defaults to the element sharing the toggle's handler. */
  contentClass?: string;
}

export interface StHtmlToRisuOptions extends CollapsibleOptions {
  /** Class that takes over the discarded `<body>` scope. */
  rootClass?: string;
  /**
   * How to treat `<button>` elements whose ST behaviour depended on JavaScript.
   *
   * - `keep` (default): emit a plain `<button>`, which renders styled but inert.
   * - `risu-button`: also set `risu-btn="<button text>"`. RisuAI passes that
   *   string to the character's Lua `onButtonClick(accessKey, data)` trigger, so
   *   a card that defines one gets a working button; without a trigger the
   *   button is inert exactly as in `keep`.
   */
  buttons?: 'keep' | 'risu-button';
}

type AttributeMap = Record<string, string>;

interface ElementNode {
  type: 'element';
  tag: string;
  attrs: AttributeMap;
  children: HtmlNode[];
}

interface TextNode {
  type: 'text';
  value: string;
}

type HtmlNode = ElementNode | TextNode;

/** HTML void elements never take a closing tag. */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** Attributes whose value must survive verbatim (selectors, inline styles, URLs). */
const RAW_ATTRIBUTES = new Set(['style', 'src', 'href', 'srcset', 'poster', 'data', 'action', 'formaction']);

/**
 * Tag names matched case-insensitively but emitted with the exact casing SVG
 * needs. HTML parsers are case-insensitive here, but XML consumers are not, and
 * keeping the source spelling makes the emitted fragment a faithful copy.
 */
const CANONICAL_TAGS = new Map(
  [
    'altGlyph', 'altGlyphDef', 'altGlyphItem', 'animateColor', 'animateMotion', 'animateTransform',
    'clipPath', 'feBlend', 'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix',
    'feDiffuseLighting', 'feDisplacementMap', 'feDistantLight', 'feDropShadow', 'feFlood',
    'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage', 'feMerge', 'feMergeNode',
    'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile',
    'feTurbulence', 'foreignObject', 'glyphRef', 'linearGradient', 'radialGradient', 'textPath',
  ].map((name) => [name.toLowerCase(), name] as const),
);

const STYLE_ATTRIBUTE_RE = /\b(?:background(?:-image)?|border-image|mask|mask-image|list-style|list-style-image|cursor|content)\s*:[^;]*\burl\s*\(/iu;

interface WrapRewrite {
  /** Selector that must be remapped onto the surviving fragment root. */
  dead: RegExp;
  replacement: string;
  note: string;
}

/**
 * Class attached to the fragment root. RisuAI only scopes CSS under `.chattext`,
 * so this is what takes over the role of ST's `<body>`.
 */
export const RISU_HTML_ROOT_CLASS = 'risu-html-scope';

const WRAP_REWRITES: WrapRewrite[] = [
  { dead: /^html\s+body$/u, replacement: '', note: 'html body 选择器改为片段根元素' },
  { dead: /^body$/u, replacement: '', note: 'body 选择器改为片段根元素' },
  { dead: /^html$/u, replacement: '', note: 'html 选择器改为片段根元素' },
];

/** Tags that carry no meaning once the block is inlined into a chat message. */
const DOCUMENT_TAGS = new Set(['!doctype', 'html', 'head', 'body']);

/**
 * Elements whose content survives the ST sandbox but is dead in a message.
 * `link` is listed separately because a CDN stylesheet is a silent loss: RisuAI
 * has no external stylesheet path, so icon-font markup degrades to plain text.
 */
const DEAD_TAGS = new Set(['script', 'base', 'meta', 'title', 'link', 'noscript']);

function escapeAttribute(value: string): string {
  // `&` first, then the three characters that would otherwise terminate the
  // attribute: a payload like `按 <refine> 修改` must not ship a bare `<`.
  return value
    .replace(/&/gu, '&amp;')
    .replace(/"/gu, '&quot;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;');
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (full, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : full;
    }
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0' };
    return named[entity] ?? full;
  });
}

/** Parse the leading tag at `start` (`<`). Returns `null` for comments and doctypes. */
function parseTag(source: string, start: number): { tag: string; attrs: AttributeMap; selfClosing: boolean; end: number } | null {
  let index = start + 1;
  let name = '';
  while (index < source.length && /[a-zA-Z0-9!:_-]/u.test(source[index])) {
    name += source[index];
    index += 1;
  }
  const attrs: AttributeMap = {};
  let selfClosing = false;

  // The attribute loop below must always advance; this cap turns a logic slip
  // into a parse failure instead of hanging RisuAI's message render.
  let guard = source.length + 16;
  while (index < source.length) {
    if (guard-- <= 0) return null;
    while (index < source.length && /\s/u.test(source[index])) index += 1;
    if (index >= source.length) break;
    if (source[index] === '>') {
      index += 1;
      break;
    }
    if (source[index] === '/' && source[index + 1] === '>') {
      selfClosing = true;
      index += 2;
      break;
    }
    let attrName = '';
    while (index < source.length && !/[\s=/>]/u.test(source[index])) {
      attrName += source[index];
      index += 1;
    }
    if (!attrName) {
      // The current character cannot start an attribute name, e.g. `<` in
      // `<div>1 < 2</div>`. That `<` was not a tag opener after all: stop here so
      // the caller emits it as text. Without this the loop cannot advance.
      return null;
    }
    while (index < source.length && /\s/u.test(source[index])) index += 1;
    let attrValue = '';
    if (source[index] === '=') {
      index += 1;
      while (index < source.length && /\s/u.test(source[index])) index += 1;
      const quote = source[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const close = source.indexOf(quote, index);
        const stop = close === -1 ? source.length : close;
        attrValue = source.slice(index, stop);
        index = stop + 1;
      } else {
        while (index < source.length && !/[\s>]/u.test(source[index])) {
          if (source[index] === '/' && source[index + 1] === '>') break;
          attrValue += source[index];
          index += 1;
        }
      }
    }
    // Attribute names keep their source casing: SVG depends on it (`viewBox`,
    // `stdDeviation`, `feGaussianBlur`). Lookups go through attr() instead.
    if (attrName) attrs[attrName] = RAW_ATTRIBUTES.has(attrName.toLowerCase()) ? attrValue : decodeEntities(attrValue);
  }

  if (!name) return null;
  return { tag: canonicalTag(name), attrs, selfClosing, end: index };
}

/** Lower-case the tag for matching, then restore SVG's required casing. */
function canonicalTag(name: string): string {
  const lower = name.toLowerCase();
  return CANONICAL_TAGS.get(lower) ?? lower;
}

/** Build a node tree for an ST fragment. Comments are dropped, whitespace is kept. */
function parseFragment(source: string): HtmlNode[] {
  const roots: HtmlNode[] = [];
  const stack: Array<{ node: ElementNode; tag: string }> = [];

  const push = (node: HtmlNode) => {
    const owner = stack[stack.length - 1]?.node;
    if (owner) owner.children.push(node);
    else roots.push(node);
  };

  let index = 0;
  // Guard against a non-advancing branch: this parser must never spin, because a
  // single stalled index would hang RisuAI's message render.
  let guard = source.length * 2 + 16;
  while (index < source.length) {
    if (guard-- <= 0) throw new Error('HTML 片段解析未推进，可能存在未闭合的尖括号。');
    const lt = source.indexOf('<', index);
    if (lt === -1) {
      push({ type: 'text', value: source.slice(index) });
      break;
    }
    if (lt > index) push({ type: 'text', value: source.slice(index, lt) });

    if (source.startsWith('<!--', lt)) {
      const close = source.indexOf('-->', lt + 4);
      index = close === -1 ? source.length : close + 3;
      continue;
    }
    if (source.startsWith('<!', lt) || source.startsWith('<?', lt)) {
      const close = source.indexOf('>', lt);
      index = close === -1 ? source.length : close + 1;
      continue;
    }
    if (source.startsWith('</', lt)) {
      const parsed = parseTag(source, lt + 1);
      if (!parsed) {
        // `</` that is not a real close tag, e.g. an escaped `<\/refine>` inside
        // a script body. Emit the `<` as text and move on: leaving the index
        // untouched here would spin forever.
        push({ type: 'text', value: '<' });
        index = lt + 1;
        continue;
      }
      // Tolerate unmatched closing tags: pop until the matching open tag.
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth].tag === parsed.tag) {
          stack.length = depth;
          break;
        }
      }
      index = parsed.end;
      continue;
    }

    const parsed = parseTag(source, lt);
    if (!parsed) {
      push({ type: 'text', value: '<' });
      index = lt + 1;
      continue;
    }
    const node: ElementNode = { type: 'element', tag: parsed.tag, attrs: parsed.attrs, children: [] };
    push(node);
    index = parsed.end;
    if (!parsed.selfClosing && !VOID_TAGS.has(parsed.tag)) stack.push({ node, tag: parsed.tag });
  }

  return roots;
}

function findElement(nodes: HtmlNode[], match: string | ((node: ElementNode) => boolean)): ElementNode | null {
  const test = typeof match === 'string' ? (node: ElementNode) => hasClass(node, match) : match;
  for (const node of nodes) {
    if (node.type !== 'element') continue;
    if (test(node)) return node;
    const nested = findElement(node.children, match);
    if (nested) return nested;
  }
  return null;
}

/** The first `<style>`-free descendant carrying an inline `on*` handler. */
function findControl(nodes: HtmlNode[], wanted?: Set<string>): ElementNode | null {
  for (const node of nodes) {
    if (node.type !== 'element') continue;
    const names = handlerNames(node);
    if (names.length && (!wanted || names.some((name) => wanted.has(name)))) return node;
    const nested = findControl(node.children, wanted);
    if (nested) return nested;
  }
  return null;
}

function classNames(node: ElementNode): string[] {
  return (attr(node, 'class') ?? '').split(/\s+/u).filter(Boolean);
}

/**
 * Mark elements whose inline handler calls a recognised SillyTavern action.
 *
 * Must run **before** `sanitizeAttributes` strips the `on*` attributes, because
 * the handler body is the only place the original intent is recorded. The
 * payload itself is never copied into an attribute: it stays in the element
 * text, since RisuAI rewrites curly quotes to ASCII quotes before rendering and
 * `$1` expands at run time — either would terminate an attribute value.
 */
function markBridgeActions(nodes: HtmlNode[], report: ReportBuilder): void {
  for (const node of nodes) {
    if (node.type !== 'element') continue;
    const bridged = inlineActions(node).find((action) => BRIDGE_ACTIONS.has(action.kind));
    if (bridged) {
      setAttr(node, BRIDGE_ATTRIBUTE, bridged.kind);
      report.flags.bridgeActions[bridged.kind] = (report.flags.bridgeActions[bridged.kind] ?? 0) + 1;
    }
    markBridgeActions(node.children, report);
  }
}

/**
 * Attach `risu-btn` to buttons so a card-level Lua trigger can act on the
 * click. RisuAI reads the attribute value in `onButtonClick(accessKey, data)`,
 * which makes the button text the payload the trigger receives.
 *
 * Elements already claimed by a bridge action are skipped: the plugin performs
 * those, so a Lua hook would be a second, competing handler.
 */
function annotateButtons(nodes: HtmlNode[], report: ReportBuilder): void {
  for (const node of nodes) {
    if (node.type !== 'element') continue;
    if (node.tag === 'button' && !attr(node, 'risu-btn') && !attr(node, BRIDGE_ATTRIBUTE)) {
      const label = plainText(node).trim();
      if (label) {
        setAttr(node, 'risu-btn', label);
        report.flags.buttonsWired += 1;
      }
    }
    annotateButtons(node.children, report);
  }
}

/** Inline handler attribute names, e.g. `onclick`. */
function handlerAttributes(node: ElementNode): string[] {
  return Object.keys(node.attrs).filter((key) => key.toLowerCase().startsWith('on'));
}

/**
 * Recognised ST actions declared by an element's inline handlers.
 *
 * Only `fill`-family actions are relevant here: collapsing is rewritten to
 * `<details>` elsewhere, chat-record edits belong to a Lua trigger, and frame
 * resizing has no meaning when the message shares the page's document.
 */
function inlineActions(node: ElementNode): StActionCall[] {
  const calls: StActionCall[] = [];
  for (const name of handlerAttributes(node)) {
    const body = node.attrs[name];
    if (!body) continue;
    calls.push(...findStActions(body));
  }
  return calls;
}

function plainText(node: HtmlNode): string {
  if (node.type === 'text') return node.value;
  return node.children.map(plainText).join('');
}

/** Attribute names are case-sensitive in the DOM, so match them case-insensitively. */
function attrName(node: ElementNode, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.keys(node.attrs).find((key) => key.toLowerCase() === wanted);
}

function attr(node: ElementNode, name: string): string | undefined {
  const key = attrName(node, name);
  return key === undefined ? undefined : node.attrs[key];
}

function setAttr(node: ElementNode, name: string, value: string): void {
  const existing = attrName(node, name);
  if (existing !== undefined && existing !== name) delete node.attrs[existing];
  node.attrs[name] = value;
}

function hasClass(node: ElementNode, className: string): boolean {
  return (attr(node, 'class') ?? '').split(/\s+/u).includes(className);
}

function collectClasses(nodes: HtmlNode[], into: Set<string>): void {
  for (const node of nodes) {
    if (node.type !== 'element') continue;
    for (const name of (attr(node, 'class') ?? '').split(/\s+/u)) if (name) into.add(name);
    collectClasses(node.children, into);
  }
}

function renderNodes(nodes: HtmlNode[]): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') {
      out += node.value;
      continue;
    }
    const attrs = Object.entries(node.attrs)
      .map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`))
      .join('');
    if (VOID_TAGS.has(node.tag)) {
      out += `<${node.tag}${attrs}>`;
      continue;
    }
    out += `<${node.tag}${attrs}>${renderNodes(node.children)}</${node.tag}>`;
  }
  return out;
}

/** Strip dead wrappers down to their children. */
function unwrapDeadTags(nodes: HtmlNode[], report: ReportBuilder): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      out.push(node);
      continue;
    }
    if (DEAD_TAGS.has(node.tag)) {
      const label = node.tag === 'script' ? 'ST 沙箱脚本（含 postMessage / 事件绑定）' : `<${node.tag}>`;
      report.issue('removed', 'DEAD_TAG', `已删除 ${label}：RisuAI 的 DOMPurify 会剥离该标签。`);
      continue;
    }
    const children = unwrapDeadTags(node.children, report);
    // `html`/`head`/`body` are dropped by DOMPurify while their children are
    // kept, so unwrap them here: keeping the tags would both hide the fragment
    // root and leave the scope class on an element that never renders.
    if (DOCUMENT_TAGS.has(node.tag)) {
      report.flags.wasFullDocument = true;
      out.push(...children);
      continue;
    }
    out.push({ ...node, children });
  }
  return out;
}

/** Drop ST-only attributes and report what was lost. */
function sanitizeAttributes(nodes: HtmlNode[], report: ReportBuilder): void {
  for (const node of nodes) {
    if (node.type !== 'element') continue;
    for (const name of Object.keys(node.attrs)) {
      const lower = name.toLowerCase();
      if (lower.startsWith('on')) {
        delete node.attrs[name];
        report.flags.hadScript = true;
        report.issue('removed', 'INLINE_HANDLER', `已删除内联事件属性 ${name}：RisuAI 不允许脚本执行。`);
        continue;
      }
      if (lower.startsWith('aria-')) continue;
      if (lower === 'style' && STYLE_ATTRIBUTE_RE.test(node.attrs[name] ?? '')) {
        report.issue('note', 'INLINE_URL_STYLE', '内联 style 含 url()，RisuAI 关闭外链图片时会被改写。');
      }
    }
    sanitizeAttributes(node.children, report);
  }
}

/** Handler identifiers referenced by an inline `on*` attribute, in source order. */
function handlerNames(node: ElementNode): string[] {
  const names: string[] = [];
  for (const [name, value] of Object.entries(node.attrs)) {
    if (!name.toLowerCase().startsWith('on')) continue;
    for (const match of value.matchAll(/([A-Za-z_$][\w$]*)\s*\(/gu)) names.push(match[1]);
  }
  return names;
}

function classNameOr(node: ElementNode, fallback: string): string {
  return attr(node, 'class') ?? fallback;
}

/**
 * Rebuild a click-to-expand panel as `<details>/<summary>`, which is the only
 * disclosure mechanism RisuAI offers (it already uses it for `<Thoughts>`).
 *
 * ST panels toggle with `onclick="toggleX()"`, hide the body behind an
 * `.expanded` class and re-measure with `postMessage`. None of that survives
 * DOMPurify, so the toggle control becomes the `<summary>`, the container that
 * holds it and the body becomes the `<details>` element, and every class is
 * kept so the original CSS still applies.
 *
 * The inline handler is the signal, not a class name: the control is the first
 * element still carrying `on*`, and the body is its next element sibling. The
 * ST shape is `container > [control, body]`, where the body itself repeats the
 * same handler on a "collapse" row. {@link CollapsibleOptions} pins the
 * classes down when a block does not follow that shape.
 */
function rebuildCollapsible(roots: HtmlNode[], report: ReportBuilder, options: CollapsibleOptions): HtmlNode[] {
  return walk(roots);

  function walk(nodes: HtmlNode[]): HtmlNode[] {
    const converted = convert(nodes);
    if (converted) return converted;
    return nodes.map((node) => (node.type === 'element' ? { ...node, children: walk(node.children) } : node));
  }

  /**
   * Build the `<details>` element: it replaces the toggle control in the tree,
   * carrying the toggle's classes so the header CSS (the visible bar the user
   * clicks) still applies, and holding the body's children.
   */
  function convert(nodes: HtmlNode[]): HtmlNode[] | null {
    const control = options.toggleClass
      ? nodes.find((node): node is ElementNode => node.type === 'element' && hasClass(node, options.toggleClass as string))
      : nodes.find((node): node is ElementNode => node.type === 'element' && handlerNames(node).length > 0);
    if (!control) return null;

    const controlIndex = nodes.indexOf(control);
    // The source is pretty-printed, so the body is the next *element* sibling,
    // not necessarily the next node.
    let contentIndex = -1;
    for (let cursor = controlIndex + 1; cursor < nodes.length; cursor += 1) {
      const node = nodes[cursor];
      if (node.type !== 'element') continue;
      if (!options.contentClass || hasClass(node, options.contentClass)) contentIndex = cursor;
      break;
    }
    if (contentIndex === -1) return null;
    const content = nodes[contentIndex] as ElementNode;

    // The "collapse" row duplicates what <summary> now does.
    const handlers = new Set([...handlerNames(control), ...handlerNames(content)]);
    const footer = findElement(content.children, (node) => handlerNames(node).some((name) => handlers.has(name)));

    const summary: ElementNode = {
      type: 'element',
      tag: 'summary',
      attrs: { class: classNameOr(control, 'risu-toggle') },
      children: control.children,
    };
    const details: ElementNode = {
      tag: 'details',
      type: 'element',
      attrs: { ...control.attrs, class: classNameOr(control, 'risu-toggle') },
      children: [summary, ...content.children.filter((child) => child !== footer)],
    };
    for (const name of ['aria-expanded', 'aria-controls', 'role', 'tabindex']) {
      const key = attrName(details, name);
      if (key) delete details.attrs[key];
    }

    report.flags.collapsibleRebuilt = true;
    report.issue('rewritten', 'COLLAPSIBLE_DETAILS', '点击展开的面板已改写为 <details>/<summary>，用原生开关替代被剥离的 JS。');
    return [...nodes.slice(0, controlIndex), details, ...nodes.slice(controlIndex + 1, contentIndex), ...nodes.slice(contentIndex + 1)];
  }
}

/**
 * Whitespace-only text between block elements would each become an empty `<p>`
 * once markdown-it runs, padding the panel with blank lines.
 */
function trimEdgeText(nodes: HtmlNode[]): HtmlNode[] {
  const blank = (node: HtmlNode | undefined): boolean => node?.type === 'text' && !node.value.trim();
  let start = 0;
  let end = nodes.length;
  while (start < end && blank(nodes[start])) start += 1;
  while (end > start && blank(nodes[end - 1])) end -= 1;
  return nodes.slice(start, end);
}

/**
 * Tags whose surrounding whitespace is not rendered, so the newlines of a
 * pretty-printed HTML block can be dropped from between them.
 */
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'button', 'cite', 'code', 'data', 'del', 'dfn', 'em',
  'i', 'img', 'input', 'ins', 'kbd', 'label', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp',
  'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr',
]);

/**
 * RisuAI renders messages with markdown-it `breaks: true`, so every newline that
 * survives into the message body becomes a `<br>`. The ST block is written as an
 * indented document, which would otherwise inject `<br>` between every sibling
 * element and break flex/grid containers.
 */
function stripStructuralWhitespace(nodes: HtmlNode[]): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.value.trim()) out.push(node);
      continue;
    }
    const children = stripStructuralWhitespace(node.children);
    // Inside `<summary>` the text is inline content, and whitespace-only runs
    // are not separating block siblings there.
    out.push({
      ...node,
      children: node.tag === 'summary' ? node.children : children,
    });
  }

  const kept: HtmlNode[] = [];
  for (let index = 0; index < out.length; index += 1) {
    const node = out[index];
    if (node.type === 'text' && !node.value.trim()) {
      const previous = kept[kept.length - 1];
      const next = out[index + 1];
      const blockBefore = previous?.type === 'element' && !INLINE_TAGS.has(previous.tag);
      const blockAfter = next === undefined || (next.type === 'element' && !INLINE_TAGS.has(next.tag));
      if (blockBefore && blockAfter) continue;
    }
    kept.push(node);
  }
  return kept;
}

class ReportBuilder {
  readonly issues: StHtmlIssue[] = [];
  readonly flags = {
    wasFullDocument: false,
    hadScript: false,
    collapsibleRebuilt: false,
    buttonsWired: 0,
    bridgeActions: {} as Record<string, number>,
  };

  issue(level: StHtmlIssueLevel, code: string, message: string): void {
    this.issues.push({ level, code, message });
  }

  counts(): StHtmlIssueCounts {
    return {
      removed: this.issues.filter((issue) => issue.level === 'removed').length,
      rewritten: this.issues.filter((issue) => issue.level === 'rewritten').length,
      note: this.issues.filter((issue) => issue.level === 'note').length,
    };
  }
}

/* ------------------------------------------------------------------ CSS --- */

interface CssScan {
  /** Comment text, or `null` for a string literal. */
  kind: 'comment' | 'string' | 'other';
  text: string;
  end: number;
}

function scanCssToken(source: string, start: number): CssScan | null {
  if (source.startsWith('/*', start)) {
    const close = source.indexOf('*/', start + 2);
    const end = close === -1 ? source.length : close + 2;
    return { kind: 'comment', text: source.slice(start, end), end };
  }
  const char = source[start];
  if (char === '"' || char === "'") {
    let index = start + 1;
    while (index < source.length) {
      if (source[index] === '\\') {
        index += 2;
        continue;
      }
      if (source[index] === char) {
        index += 1;
        break;
      }
      index += 1;
    }
    return { kind: 'string', text: source.slice(start, index), end: index };
  }
  return null;
}

function normalizeSelector(selector: string): string {
  return selector
    .replace(/\s*([>+~,])\s*/gu, ' $1 ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function splitSelectorList(selector: string, out: string[]): void {
  let depth = 0;
  let buffer = '';
  for (const char of selector) {
    if (char === '(' || char === '[') depth += 1;
    if (char === ')' || char === ']') depth -= 1;
    if (char === ',' && depth === 0) {
      out.push(buffer);
      buffer = '';
      continue;
    }
    buffer += char;
  }
  out.push(buffer);
}

/**
 * Rewrite a stylesheet so it is correct *before* RisuAI encodes it into
 * `<risu-style>`.
 *
 * This deliberately does **not** add the `x-risu-` prefix or the `.chattext`
 * scope: RisuAI's `decodeStyleRule()` does both on the way back out, so adding
 * them here would double-prefix every selector into `.x-risu-aether-…`.
 * What it does do is repair the selectors RisuAI cannot repair itself —
 * `html` / `body`, which the markdown parser drops — by remapping them onto the
 * fragment root element.
 */
export function convertStStylesheet(source: string, rootClass = RISU_HTML_ROOT_CLASS): { css: string; notes: string[] } {
  const rootSelector = `.${rootClass}`;

  function rewriteSelector(rawSelector: string): string {
    const parts: string[] = [];
    splitSelectorList(rawSelector, parts);
    return parts
      .map((part) => {
        let selector = normalizeSelector(part);
        if (!selector) return selector;
        for (const rewrite of WRAP_REWRITES) {
          const next = selector.replace(rewrite.dead, rewrite.replacement).trim();
          if (next !== selector) {
            selector = next;
            if (!selector) selector = rootSelector;
          }
        }
        return selector;
      })
      .filter(Boolean)
      .join(', ');
  }

  const mediaRules: string[] = [];
  let flattenedMedia = 0;

  function walk(chunk: string): string {
    let out = '';
    let index = 0;
    while (index < chunk.length) {
      const brace = chunk.indexOf('{', index);
      const terminator = chunk.indexOf(';', index);
      const isDeclaration = terminator !== -1 && (brace === -1 || terminator < brace);
      if (isDeclaration) {
        out += chunk.slice(index, terminator + 1);
        index = terminator + 1;
        continue;
      }
      if (brace === -1) {
        out += chunk.slice(index);
        break;
      }
      const prelude = chunk.slice(index, brace);
      const close = matchBrace(chunk, brace);
      const body = chunk.slice(brace + 1, close);
      const atRule = /^\s*@([\w-]+)/u.exec(prelude)?.[1]?.toLowerCase();
      if (!atRule) {
        out += `${rewriteSelector(prelude)}{${body}}`;
      } else if (atRule === 'media') {
        // RisuAI recurses into @media but never prefixes or scopes the inner
        // selectors, so those rules would silently stop matching the x-risu-
        // classes. Re-declare them alongside the base rules instead; identical
        // selectors keep their source order, so they still win by specificity
        // tie-break and apply on every viewport.
        mediaRules.push(walk(body));
        flattenedMedia += 1;
      } else if (['supports', 'container', 'layer', 'scope'].includes(atRule)) {
        out += `${prelude}{${walk(body)}}`;
      } else if (atRule === 'import') {
        out += prelude.replace(/url\(\s*(['"]?)data:[^)]*\1\s*\)/giu, 'url(data:,)') + `{${body}}`;
      } else {
        // @keyframes, @font-face, @property … hold no element selectors.
        out += `${prelude}{${body}}`;
      }
      index = close + 1;
    }
    return out;
  }

  function matchBrace(chunk: string, open: number): number {
    let depth = 0;
    let index = open;
    while (index < chunk.length) {
      const token = scanCssToken(chunk, index);
      if (token) {
        index = token.end;
        continue;
      }
      if (chunk[index] === '{') depth += 1;
      else if (chunk[index] === '}') {
        depth -= 1;
        if (depth === 0) return index;
      }
      index += 1;
    }
    return chunk.length;
  }

  const stripped = stripComments(source);
  const base = walk(stripped);
  const css = [base, ...mediaRules].join('\n').replace(/\s*\n\s*/gu, '\n').trim();
  const notes = [
    'html / body 选择器已改写到片段根元素，避免被 markdown 解析阶段丢弃。',
    'CSS 未加 x-risu- 前缀也未加 .chattext 作用域：RisuAI 的 decodeStyle 会统一补上。',
  ];
  if (flattenedMedia) {
    notes.push(
      `已展开 ${flattenedMedia} 个 @media 断点：RisuAI 进入 @media 后不会给内部选择器加 x-risu- 前缀，留在断点里会全部失效。`,
    );
  }
  return { css, notes };
}

function stripComments(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const token = scanCssToken(source, index);
    if (token) {
      if (token.kind !== 'comment') out += token.text;
      index = token.end;
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}

/** Pull every `<style>` body out of the ST block. */
function collectStyles(nodes: HtmlNode[], into: string[], report: ReportBuilder): HtmlNode[] {
  const out: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.type === 'text') {
      out.push(node);
      continue;
    }
    if (node.tag === 'style') {
      into.push(node.children.map((child) => (child.type === 'text' ? child.value : '')).join(''));
      report.issue('rewritten', 'STYLE_ENCODED', '样式表已转为 <risu-style> 十六进制块，避免被 markdown / DOMPurify 处理。');
      continue;
    }
    out.push({ ...node, children: collectStyles(node.children, into, report) });
  }
  return out;
}

/**
 * Convert one ST sandbox HTML block into RisuAI-compatible markup.
 *
 * The returned `html` is what a RisuAI preset regex `out` (or a card
 * `editdisplay` script) should emit. Backreferences such as `$1` are preserved
 * because RisuAI's `string.replace` expands them before the markup is parsed.
 */
export function convertStHtmlToRisu(source: string, options: StHtmlToRisuOptions = {}): StHtmlToRisuResult {
  const rootClass = options.rootClass ?? RISU_HTML_ROOT_CLASS;
  const report = new ReportBuilder();
  const styles: string[] = [];

  let nodes = parseFragment(source);
  nodes = collectStyles(nodes, styles, report);
  nodes = unwrapDeadTags(nodes, report);
  // Must run before the handlers are stripped: the inline `onclick` is what
  // identifies the toggle control and the body it drives.
  nodes = rebuildCollapsible(nodes, report, options);
  // Detect bridge actions while the inline handlers still exist.
  if (options.buttons === 'risu-button') markBridgeActions(nodes, report);
  sanitizeAttributes(nodes, report);
  if (options.buttons === 'risu-button') {
    annotateButtons(nodes, report);
    if (report.flags.buttonsWired) {
      report.issue(
        'rewritten',
        'BUTTON_HOOK',
        `${report.flags.buttonsWired} 个按钮已加 risu-btn：RisuAI 点击时把该值交给角色的 Lua onButtonClick(accessKey, data) 触发器。`,
      );
    }
    const bridgeTotal = Object.values(report.flags.bridgeActions).reduce((sum, count) => sum + count, 0);
    if (bridgeTotal) {
      const detail = Object.entries(report.flags.bridgeActions)
        .map(([action, count]) => `${action} × ${count}`)
        .join('、');
      report.issue(
        'rewritten',
        'BRIDGE_ACTION',
        `${bridgeTotal} 个元素的原 SillyTavern 动作已改写为桥接声明（${detail}）：`
        + 'RisuAI 的消息内脚本写不到聊天输入框，这些动作由桥接插件代为执行；未安装插件时点了不会有反应。'
        + '内容取自元素文本，不写入 HTML 属性（属性值会被引号截断）。',
      );
    }
  }
  nodes = stripStructuralWhitespace(nodes);
  nodes = trimEdgeText(nodes);

  if (!nodes.some((node) => node.type === 'element')) {
    report.issue('note', 'NO_ELEMENT', '片段中没有元素节点，转换结果可能不是可视面板。');
  }

  // The ST block's <body> is gone, so its own root gets the scope class that
  // the rewritten `body { … }` rules now target.
  const firstElement = nodes.find((node): node is ElementNode => node.type === 'element');
  if (!firstElement) {
    report.issue('removed', 'EMPTY_FRAGMENT', '未找到可承载样式的根元素。');
  } else {
    const classes = (attr(firstElement, 'class') ?? '').split(/\s+/u).filter(Boolean);
    if (!classes.includes(rootClass)) classes.push(rootClass);
    setAttr(firstElement, 'class', classes.join(' '));
    if (report.flags.wasFullDocument) {
      report.issue('rewritten', 'BODY_SCOPE', `原 <body> 的样式已改由根元素 .${rootClass} 承载。`);
    }
  }

  const markup = renderNodes(nodes).trim();
  const { css, notes } = convertStStylesheet(styles.join('\n'), rootClass);
  for (const note of notes) report.issue('rewritten', 'CSS_SCOPE', note);

  const classes = new Set<string>();
  collectClasses(nodes, classes);

  const styleBlock = css.trim() ? `${encodeRisuStyleBlock(css)}\n` : '';
  report.issue(
    'note',
    'NO_JS',
    'RisuAI 内消息不执行 JavaScript：折叠、自动高度与父窗口通信都不会运行，已用纯 HTML/CSS 方案替代。',
  );

  return {
    html: `${styleBlock}${markup}`,
    markup,
    css,
    report: {
      issues: report.issues,
      counts: report.counts(),
      classes: [...classes].sort(),
      wasFullDocument: report.flags.wasFullDocument,
      hadScript: report.flags.hadScript,
      collapsibleRebuilt: report.flags.collapsibleRebuilt,
      buttonsWired: report.flags.buttonsWired,
      bridgeActions: report.flags.bridgeActions,
      markupLength: markup.length,
      sourceLength: source.length,
    },
  };
}
