import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIDGE_ATTRIBUTE,
  RISU_KNOWN_MACROS,
  analyzePresetCapabilities,
  classifyCapability,
  collectMacros,
  declaredBridgeActions,
  hasDynamicAttributePayload,
  summarizeCapabilities,
  unknownMacros,
} from '../server/domain/card/preset-capability.js';

test('plain prompt text needs nothing', () => {
  const report = classifyCapability('你是一位严谨的助手，请按以下格式回复。');
  assert.equal(report.owner, 'direct');
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.bridgeActions, []);
});

test('known RisuAI macros stay direct', () => {
  const text = '{{settempvar::geshi::}}{{#when::{{getglobalvar::toggle_st_2}}}}A{{:else}}{{gettempvar::rencheng}}{{/when}}{{random::a::b}}{{roll:1d6}}';
  const report = classifyCapability(text);
  assert.equal(report.owner, 'direct');
  assert.ok(report.macros.includes('settempvar'));
  assert.ok(report.macros.includes('gettempvar'));
  assert.ok(report.macros.includes('getglobalvar'));
  assert.deepEqual(unknownMacros(text), []);
});

test('gettempvar is recognised as the tempvar alias, not an unknown macro', () => {
  assert.ok(RISU_KNOWN_MACROS.has('tempvar'));
  assert.ok(RISU_KNOWN_MACROS.has('gettempvar'));
  assert.deepEqual(unknownMacros('{{gettempvar::x}}'), []);
});

test('a third-party extension macro is reported as unmigratable', () => {
  assert.deepEqual(unknownMacros('{{myextension::value}}'), ['myextension']);
  const report = classifyCapability('{{myextension::value}}');
  assert.equal(report.owner, 'impossible');
  assert.equal(report.findings[0].code, 'UNKNOWN_MACRO');
});

test('writing the chat input is the bridge case', () => {
  const text = "const input = window.parent.document.querySelector('#send_textarea'); input.value += text;";
  const report = classifyCapability(text);
  assert.equal(report.owner, 'bridge');
  assert.deepEqual(report.bridgeActions, ['fill-send']);
  assert.ok(report.findings.some((finding) => finding.code === 'BRIDGE_INPUT'));
  // `window.parent` alone also signals page-level access; either way the rule
  // needs the plugin, so the headline owner must stay `bridge`.
  assert.ok(report.findings.some((finding) => finding.code === 'BRIDGE_DOM'));
});

test('a message that only resizes its frame is a bridge note, not a blocker', () => {
  // `postMessage({type:'resizeIframe'})` cannot work, but the same script also
  // reaches the page, so the actionable answer is "needs the plugin".
  const report = classifyCapability("window.parent.postMessage({ type: 'resizeIframe', height: 1 }, '*');");
  assert.equal(report.owner, 'bridge');
});

test('a slash command line is unmigratable STscript', () => {
  const report = classifyCapability('/send 你好');
  assert.equal(report.owner, 'impossible');
  assert.ok(report.findings.some((finding) => finding.code === 'IMPOSSIBLE_STSCRIPT'));
});

test('DOM queries and event binding are bridge cases', () => {
  const report = classifyCapability("document.getElementById('panel').addEventListener('click', fn);");
  assert.equal(report.owner, 'bridge');
  assert.deepEqual(report.bridgeActions, ['fill-send']);
});

test('rewriting the chat record is a conversion, not a bridge', () => {
  const text = 'const ctx = window.top.window.SillyTavern.getContext(); ctx.chat[ctx.chat.length - 1].mes = fixed;';
  const report = classifyCapability(text);
  assert.ok(report.findings.some((finding) => finding.code === 'CONVERT_CHAT_RECORD'));
  assert.deepEqual(report.bridgeActions, [], 'no plugin is needed to rewrite the chat record');
});

test('a collapsible driven by an inline handler is a conversion', () => {
  const report = classifyCapability('<div class="head" onclick="toggleCollapsible()">Aether</div>');
  assert.equal(report.owner, 'convert');
  assert.ok(report.findings.some((finding) => finding.code === 'CONVERT_INLINE_HANDLER'));
  assert.deepEqual(report.bridgeActions, []);
});

test('style, media and fence are conversion notes', () => {
  const report = classifyCapability('<style>.a{color:red}@media (max-width:480px){.a{color:blue}}</style>');
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes('CONVERT_STYLE'));
  assert.ok(codes.includes('CONVERT_MEDIA'));
  assert.equal(report.owner, 'convert');
  assert.equal(classifyCapability('```html\n<div>x</div>\n```').owner, 'convert');
});

test('script tags outrank everything as impossible', () => {
  const report = classifyCapability('<script>alert(1)</script><style>.a{}</style>');
  assert.equal(report.owner, 'impossible');
});

test('setvar is flagged as a silent no-op in the display pipeline', () => {
  const report = classifyCapability('{{setvar::counter::1}}');
  assert.equal(report.owner, 'convert');
  const finding = report.findings.find((item) => item.code === 'CONVERT_VAR_WRITE');
  assert.ok(finding, 'setvar must be reported');
  assert.match(finding.message, /runVar/u);
  assert.ok(report.mitigations.some((hint) => hint.includes('settempvar')));
});

test('ST regex metadata that RisuAI cannot express is reported', () => {
  const report = classifyCapability('plain', {
    minDepth: 2,
    runOnEdit: 1,
    substituteRegex: 1,
    trimStrings: ['\n'],
    placements: [1, 3],
  });
  const codes = report.findings.map((finding) => finding.code);
  assert.ok(codes.includes('IMPOSSIBLE_REGEX_DEPTH'));
  assert.ok(codes.includes('IMPOSSIBLE_REGEX_EDIT'));
  assert.equal(report.owner, 'impossible', 'placement 3 has no RisuAI stage');
  assert.ok(report.mitigations.some((hint) => hint.includes('chatindex')));
});

test('ST script metadata that maps cleanly reports nothing', () => {
  const report = classifyCapability('plain replacement', { placements: [1, 2], substituteRegex: 0 });
  assert.equal(report.owner, 'direct');
  assert.deepEqual(report.findings, []);
});

test('dynamic payloads in HTML attributes are detected', () => {
  // This is the shape that broke in production: `$1` inside an attribute value
  // gets terminated by the first ASCII quote of the expanded content.
  assert.equal(hasDynamicAttributePayload('<button data-risu-value="$1">$1</button>'), true);
  assert.equal(hasDynamicAttributePayload('<a title="$2">x</a>'), true);
  assert.equal(hasDynamicAttributePayload('<button data-risu-value="固定文案">固定</button>'), false);
  assert.equal(hasDynamicAttributePayload('<button data-risu-bridge="fill-send">$1</button>'), false);
});

test('bridge attribute contract is exposed for the converter and plugin', () => {
  assert.equal(BRIDGE_ATTRIBUTE, 'data-risu-bridge');
});

test('summarize rolls per-rule owners into preset-level flags', () => {
  const summary = summarizeCapabilities([
    classifyCapability('plain'),
    classifyCapability('<style>.a{}</style>'),
    classifyCapability("querySelector('#send_textarea')"),
    classifyCapability('<script>x</script>'),
  ]);
  assert.deepEqual(summary.counts, { direct: 1, convert: 1, bridge: 1, impossible: 1 });
  assert.equal(summary.needsBridge, 1);
  assert.equal(summary.requiresPlugin, true);
  assert.equal(summary.hasImpossible, true);
});

test('a preset with no page interaction does not require the plugin', () => {
  const summary = summarizeCapabilities([
    classifyCapability('{{settempvar::a::}}{{gettempvar::a}}'),
    classifyCapability('<style>.a{}</style>'),
  ]);
  assert.equal(summary.requiresPlugin, false);
});

test('analyzePresetCapabilities labels each rule of a converted preset', () => {
  const preset = {
    regex: [
      { comment: '纯文本', type: 'editprocess', in: 'a', out: 'b' },
      { comment: '行动选项', type: 'editdisplay', in: '<行动选项>', out: '<button data-risu-bridge="fill-send">$1</button>' },
      { comment: '折叠', type: 'editdisplay', in: 'x', out: '<details><summary>$1</summary></details>' },
      { comment: '旧脚本', type: 'editdisplay', in: 'y', out: '<script>toggle()</script>' },
    ],
    promptTemplate: [
      { type: 'plain', text: '{{#when::{{getglobalvar::toggle_st_2}}}}A{{:else}}B{{/when}}' },
      { type: 'plain', text: '{{settempvar::geshi::}}{{setvar::counter::1}}' },
      { type: 'plain', text: '{{myplugin::value}}' },
    ],
  };

  const report = analyzePresetCapabilities(preset);
  assert.equal(report.rules.length, 4);
  assert.equal(report.rules[0].owner, 'direct');
  // The bridge declaration itself must not be mistaken for a script; only the
  // plugin requirement is reported.
  assert.equal(report.rules[1].requiresBridge, true);
  assert.equal(report.rules[1].owner, 'bridge');
  assert.deepEqual(report.rules[1].bridgeActions, ['fill-send']);
  assert.equal(report.rules[2].owner, 'direct', 'a converted <details> needs nothing');
  assert.equal(report.rules[3].owner, 'impossible', '<script> cannot be migrated');

  assert.deepEqual(report.switchGates, ['toggle_st_2']);
  assert.deepEqual(report.unknownMacros, ['myplugin']);
  assert.equal(report.usesSetvar, true, 'setvar must be surfaced as a silent no-op');
  assert.equal(report.summary.requiresPlugin, true);
  assert.equal(report.summary.hasImpossible, true);
  assert.equal(report.summary.counts.direct, 2);
});

test('analyzePresetCapabilities tolerates a preset without regex or template', () => {
  const report = analyzePresetCapabilities({});
  assert.deepEqual(report.rules, []);
  assert.deepEqual(report.switchGates, []);
  assert.deepEqual(report.unknownMacros, []);
  assert.equal(report.usesSetvar, false);
  assert.equal(report.summary.requiresPlugin, false);
  assert.equal(report.summary.hasImpossible, false);
  assert.deepEqual(report.notices, []);
});

test('preset-level notices explain the silent failure modes', () => {
  const withBridge = analyzePresetCapabilities({
    regex: [{ comment: 'b', type: 'editdisplay', in: 'x', out: '<button data-risu-bridge="fill-send">a</button>' }],
    promptTemplate: [
      { type: 'plain', text: '{{#when::{{getglobalvar::toggle_st_2}}}}A{{/when}}{{setvar::c::1}}{{foreign::x}}' },
    ],
  });
  const joined = withBridge.notices.join('\n');
  assert.match(joined, /1 条规则需要桥接插件/u);
  assert.match(joined, /只把 "1" \/ "true" 当作真值/u);
  assert.match(joined, /runVar 默认为 false/u);
  assert.match(joined, /未注册的宏/u);
  assert.equal(withBridge.notices.length, 4);
});

test('a clean preset produces no notices', () => {
  const clean = analyzePresetCapabilities({
    regex: [{ comment: 'ok', type: 'editprocess', in: 'a', out: 'b' }],
    promptTemplate: [{ type: 'plain', text: '{{settempvar::a::1}}{{gettempvar::a}}' }],
  });
  assert.deepEqual(clean.notices, []);
  assert.equal(clean.summary.requiresPlugin, false);
});

test('declaredBridgeActions reads the converted declaration', () => {
  assert.deepEqual(declaredBridgeActions('<button data-risu-bridge="fill-send">x</button>'), ['fill-send']);
  assert.deepEqual(declaredBridgeActions('<a data-risu-bridge=\'copy\'>x</a>'), ['copy']);
  assert.deepEqual(
    declaredBridgeActions('<i data-risu-bridge="fill-send"></i><i data-risu-bridge="copy"></i>'),
    ['copy', 'fill-send'],
  );
  assert.deepEqual(declaredBridgeActions('<div>no declaration</div>'), []);
});
