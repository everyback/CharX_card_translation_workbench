import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RISU_HTML_ROOT_CLASS,
  convertStHtmlToRisu,
  convertStStylesheet,
} from '../server/domain/card/st-html-to-risu.js';
import {
  decodeRisuStyleBlock,
  decodeStyleTags,
  encodeRisuStyleBlock,
  encodeStyleTags,
  hasRawStyleTag,
} from '../server/domain/card/risu-style.js';

/** Minimal ST sandbox block: full document, own CSS, JS toggle, click handler. */
const ST_PANEL = `<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>Panel</title>
    <style>
      * { margin: 0; }
      body { padding: 6px; }
      .panel { border-radius: 8px; }
      .panel.expanded .content { display: block; }
      .content { display: none; }
    </style>
  </head>
  <body>
    <div class="panel" id="panel">
      <div class="panel-header" onclick="toggle()">Title</div>
      <div class="content" id="content">
        <div class="content-inner">$1</div>
        <div class="collapse" onclick="toggle()">收起</div>
      </div>
    </div>
    <script>function toggle() { document.getElementById('panel').classList.toggle('expanded'); }</script>
  </body>
</html>`;

test('risu-style hex transport round-trips CSS', () => {
  const css = '.a { color: #fff }\n.b:hover { content: "→" }';
  const block = encodeRisuStyleBlock(css);
  assert.match(block, /^<risu-style>[0-9a-f]+<\/risu-style>$/u);
  assert.equal(decodeRisuStyleBlock(block.replace(/<\/?risu-style>/gu, '')), css);
  assert.equal(encodeStyleTags('<style>a{}</style>'), `<risu-style>${Buffer.from('a{}').toString('hex')}</risu-style>`);
  assert.equal(decodeStyleTags(encodeStyleTags('<style>a{}</style>')), '<style>a{}</style>');
});

test('risu-style rejects a payload that is not hex', () => {
  assert.throws(() => decodeRisuStyleBlock('not-hex'), /十六进制/u);
});

test('converted block carries no raw <style> tag and decodes back to CSS', () => {
  const result = convertStHtmlToRisu(ST_PANEL);
  assert.equal(hasRawStyleTag(result.html), false);
  assert.ok(result.html.startsWith('<risu-style>'));
  const decoded = decodeStyleTags(result.html);
  assert.match(decoded, /<style>/u);
  assert.match(decoded, /\.panel\{/u);
});

test('RisuAI pipeline handles prefixing, so the emitted CSS stays unprefixed', () => {
  const { css } = convertStStylesheet('.panel { color: red }');
  assert.equal(css, '.panel{ color: red }');
  assert.ok(!css.includes('x-risu-'), 'CSS must not pre-apply the x-risu- prefix');
  assert.ok(!css.includes('.chattext'), 'CSS must not pre-apply the .chattext scope');
});

test('body and html rules are remapped onto the fragment root', () => {
  const { css } = convertStStylesheet('body { padding: 6px } html { height: 100% } html body { margin: 0 }');
  assert.match(css, new RegExp(`\\.${RISU_HTML_ROOT_CLASS}\\{`, 'u'));
  assert.ok(!/(^|[^-\w])body\s*\{/u.test(css), 'no bare body selector may survive');
  assert.ok(!/(^|[^-\w])html\s*\{/u.test(css), 'no bare html selector may survive');
  const result = convertStHtmlToRisu(ST_PANEL);
  assert.match(result.markup, new RegExp(`class="[^"]*${RISU_HTML_ROOT_CLASS}`, 'u'));
});

test('@media rules are flattened because RisuAI never prefixes their selectors', () => {
  const { css } = convertStStylesheet('.a { color: red } @media (max-width: 480px) { .a { color: blue } }');
  assert.ok(!css.includes('@media'), 'responsive rules must be hoisted out of the at-rule');
  assert.equal(css.match(/\.a\{/gu)?.length, 2);
});

test('@keyframes and @font-face bodies are preserved verbatim', () => {
  const source = '@keyframes fade { from { opacity: 0 } to { opacity: 1 } } @font-face { font-family: X; src: url(x.woff2) }';
  const { css } = convertStStylesheet(source);
  assert.match(css, /@keyframes fade \{ from \{ opacity: 0 \} to \{ opacity: 1 \} \}/u);
  assert.match(css, /@font-face \{ font-family: X; src: url\(x\.woff2\) \}/u);
});

test('script tags, inline handlers and document wrappers are removed', () => {
  const result = convertStHtmlToRisu(ST_PANEL);
  assert.equal(result.report.hadScript, true);
  assert.equal(result.report.wasFullDocument, true);
  assert.ok(!/<script/iu.test(result.html));
  assert.ok(!/onclick/iu.test(result.html));
  assert.ok(!/<html|<body|<head|<!DOCTYPE/iu.test(result.markup), 'surviving wrappers would hide the fragment root');
  const removed = result.report.issues.filter((issue) => issue.level === 'removed').map((issue) => issue.code);
  assert.ok(removed.includes('INLINE_HANDLER'));
  assert.ok(removed.includes('DEAD_TAG'));
});

test('a click-to-expand panel becomes details/summary with its classes intact', () => {
  const result = convertStHtmlToRisu(ST_PANEL);
  assert.equal(result.report.collapsibleRebuilt, true);
  // The panel wrapper is kept and the toggle control becomes the <details>,
  // so the header CSS (the bar the user clicks) keeps applying.
  assert.match(result.markup, /^<div class="panel risu-html-scope" id="panel"><details class="panel-header">/u);
  assert.match(result.markup, /<summary class="panel-header">Title<\/summary>/u);
  assert.match(result.markup, /<div class="content-inner">\$1<\/div><\/details>/u);
  // The abandoned click targets must not survive as dead markup.
  assert.ok(!result.markup.includes('class="collapse"'));
  assert.ok(!result.markup.includes('onclick'));
  assert.ok(result.markup.includes('$1'), 'regex backreferences must be preserved');
});

test('SVG element and attribute casing survives the rewrite', () => {
  const svg = `<body><svg viewBox="0 0 64 64"><defs><radialGradient id="g"><stop offset="0%" /></radialGradient>
    <filter><feGaussianBlur stdDeviation="2.8" result="blur" /><feMerge><feMergeNode in="blur" /></feMerge></filter>
  </defs></svg></body>`;
  const { markup } = convertStHtmlToRisu(svg);
  for (const name of ['viewBox', 'radialGradient', 'feGaussianBlur', 'stdDeviation', 'feMergeNode']) {
    assert.ok(markup.includes(name), `${name} must keep its casing`);
  }
});

test('whitespace between block elements is removed so breaks:true adds no <br>', () => {
  const source = `<body>
    <div class="buttons">
      <button>a</button>
      <button>b</button>
    </div>
  </body>`;
  const { markup } = convertStHtmlToRisu(source);
  assert.ok(!/>\s+</u.test(markup), 'no newline may survive between block siblings');
  assert.match(markup, /<button>a<\/button><button>b<\/button>/u);
});

test('a bare < in text does not stall the parser', () => {
  // A `<` that starts no tag used to make the attribute scanner spin forever,
  // which would hang the whole message render.
  const cases = [
    '<div>1 < 2</div>',
    '<p>a < b</p>',
    '<div>a <</div>',
    '<div>&lt; kept</div>',
    '<div>script: mes.replace(/<\\/refine>/g, "")</div>',
    'a <',
    '<div>1 <2</div>',
  ];
  for (const source of cases) {
    const result = convertStHtmlToRisu(source);
    assert.ok(result.markup.includes('<'), `${source} must keep its angle bracket`);
    assert.ok(!result.markup.includes('<div>'), `${source} markup must be rebuilt`);
  }
  assert.equal(convertStHtmlToRisu('<div>1 < 2</div>').markup, '<div class="risu-html-scope">1 < 2</div>');
});

test('a partial fragment without document wrappers is still converted', () => {
  const result = convertStHtmlToRisu('<div class="card"><span style="color:red">hi</span></div>');
  assert.equal(result.report.wasFullDocument, false);
  assert.match(result.markup, /^<div class="card risu-html-scope">/u);
  assert.equal(result.report.collapsibleRebuilt, false);
});

test('report flags every removed or rewritten construct', () => {
  const result = convertStHtmlToRisu(ST_PANEL);
  const codes = result.report.issues.map((issue) => issue.code);
  for (const code of ['STYLE_ENCODED', 'DEAD_TAG', 'INLINE_HANDLER', 'COLLAPSIBLE_DETAILS', 'BODY_SCOPE', 'CSS_SCOPE', 'NO_JS']) {
    assert.ok(codes.includes(code), `${code} must be reported`);
  }
  assert.equal(result.report.counts.removed + result.report.counts.rewritten + result.report.counts.note, result.report.issues.length);
  assert.ok(result.report.sourceLength > result.report.markupLength, 'the ST wrapper is bulky and should shrink');
});

test('a recognised ST input action becomes a bridge declaration with the payload in element text', () => {
  const result = convertStHtmlToRisu(
    '<div class="panel"><button onclick="send_textarea(\'【选项一】台词在这里\')">【选项一】台词在这里</button></div>',
    { buttons: 'risu-button' },
  );
  // The action is what RisuAI cannot perform, so it is declared for the plugin.
  assert.match(result.markup, /data-risu-bridge="fill-send"/u);
  // The payload must NOT be an attribute: RisuAI turns curly quotes into ASCII
  // quotes before rendering, which would terminate the value mid-text.
  assert.doesNotMatch(result.markup, /data-risu-value/u);
  assert.match(result.markup, /【选项一】台词在这里<\/button>/u);
  // The inline handler cannot survive: RisuAI strips it.
  assert.doesNotMatch(result.markup, /onclick/u);
  assert.equal(result.report.bridgeActions['fill-send'], 1);
  // A bridged element must not also get a competing Lua hook.
  assert.doesNotMatch(result.markup, /risu-btn/u);
});

test('an unrecognised inline handler is stripped without claiming a bridge action', () => {
  const result = convertStHtmlToRisu(
    '<div class="panel"><button onclick="doSomethingCustom()">按钮</button></div>',
    { buttons: 'risu-button' },
  );
  assert.doesNotMatch(result.markup, /onclick/u);
  assert.doesNotMatch(result.markup, /data-risu-bridge/u);
  assert.deepEqual(result.report.bridgeActions, {});
  // Without a bridge action the button falls back to the Lua hook.
  assert.match(result.markup, /risu-btn/u);
});

test('a resize call is dropped without claiming a bridge action', () => {
  const result = convertStHtmlToRisu(
    '<div class="panel" onclick="window.parent.postMessage({type:\'resizeIframe\'},\'*\')">内容</div>',
    { buttons: 'risu-button' },
  );
  assert.doesNotMatch(result.markup, /onclick|data-risu-bridge/u);
  assert.deepEqual(result.report.bridgeActions, {});
});

test('the bridge requirement is reported so the review UI can warn about it', () => {
  const result = convertStHtmlToRisu(
    '<div class="panel"><p><button onclick="send_textarea(\'a\')">A</button></p><p><button onclick="copyToClipboard(\'b\')">B</button></p></div>',
    { buttons: 'risu-button' },
  );
  assert.equal(result.report.bridgeActions['fill-send'], 1);
  assert.equal(result.report.bridgeActions.copy, 1);
  const issue = result.report.issues.find((item) => item.code === 'BRIDGE_ACTION');
  assert.ok(issue, 'the block must report that it needs the plugin');
  assert.match(issue.message, /桥接插件/u);
  assert.match(issue.message, /引号截断/u);
});