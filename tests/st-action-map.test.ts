import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeMarkup, findStActions, requiredBridgeActions } from '../server/domain/card/st-action-map.js';

test('send_textarea with a literal becomes one fill-send action carrying the payload', () => {
  const calls = findStActions("send_textarea('你好');");
  assert.equal(calls.length, 1, 'a narrow and a broad signature must not both fire');
  assert.equal(calls[0].api, 'send_textarea');
  assert.equal(calls[0].kind, 'fill-send');
  assert.equal(calls[0].payload, '你好');
});

test('send_textarea with an expression becomes fill-send without a payload', () => {
  const calls = findStActions('send_textarea(optionText);');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'fill-send');
  assert.equal(calls[0].payload, undefined);
});

test('frame resizing is a no-op, not a loss', () => {
  const calls = findStActions("window.parent.postMessage({ type: 'resizeIframe', height: 900 }, '*');");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'noop');
  assert.match(calls[0].reason, /同文档/u);
});

test('a collapsible toggle maps onto details instead of a plugin', () => {
  const calls = findStActions("toggleCollapsible('head-1');");
  assert.equal(calls[0].kind, 'details');
  assert.deepEqual(requiredBridgeActions(calls), [], 'details needs no plugin');
});

test('rewriting the chat record is routed to Lua, not to the plugin', () => {
  const calls = findStActions('const ctx = SillyTavern.getContext(); ctx.chat[ctx.chat.length - 1].mes = fixed;');
  assert.ok(calls.some((call) => call.kind === 'chat-record'));
  assert.deepEqual(requiredBridgeActions(calls), [], 'Lua triggers handle the chat record');
});

test('host-document access is reported as unsupported rather than silently dropped', () => {
  const calls = findStActions("const el = window.parent.document.getElementById('refine');");
  const unsupported = calls.filter((call) => call.kind === 'unsupported');
  assert.ok(unsupported.length >= 1);
  assert.ok(unsupported.some((call) => call.api === 'document.getElementById'));
});

test('browser storage is reported as unsupported', () => {
  const calls = findStActions("localStorage.setItem('k', 'v');");
  assert.equal(calls[0].kind, 'unsupported');
});

test('the real refine script is classified into a bridge or Lua plan', () => {
  // Trimmed from the actual ST preset rule that applies a polish pass.
  const script = [
    "(function() {",
    "  const refineHtml = document.getElementById('refine').innerHTML;",
    "  const stCtx = window.top.window.SillyTavern.getContext();",
    "  const lastMsgIndex = stCtx.chat.length - 1;",
    "  stCtx.chat[lastMsgIndex].mes = chat_mes;",
    "  window.parent.postMessage({ type: 'resizeIframe' }, '*');",
    "})();",
  ].join('\n');
  const calls = findStActions(script);
  const kinds = new Set(calls.map((call) => call.kind));
  assert.ok(kinds.has('chat-record'), 'the message rewrite must be recognised');
  assert.ok(kinds.has('noop'), 'the resize call must be recognised as removable');
  assert.ok(kinds.has('unsupported'), 'the DOM read must be reported');
  assert.deepEqual(requiredBridgeActions(calls), [], 'the record rewrite goes through Lua');
});

test('bridge markup puts the payload in element text, never in an attribute', () => {
  const markup = bridgeMarkup('选项一', 'fill-send');
  assert.equal(markup, '<button type="button" data-risu-bridge="fill-send">选项一</button>');
  assert.ok(!/data-risu-value/u.test(markup as string), 'a value attribute would be truncated by quotes');
  assert.equal(bridgeMarkup('标签', 'details'), null, 'only fill family is emittable');
  assert.equal(bridgeMarkup('标签', 'unsupported'), null);
});

test('required actions are de-duplicated and sorted', () => {
  const calls = findStActions("send_textarea('a'); copyToClipboard('b'); send_textarea('c');");
  assert.deepEqual(requiredBridgeActions(calls), ['copy', 'fill-send']);
});

test('text without any recognised call site yields nothing', () => {
  assert.deepEqual(findStActions('<div class="panel">纯展示</div>'), []);
});
