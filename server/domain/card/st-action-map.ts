/**
 * SillyTavern in-message action → RisuAI declaration.
 *
 * ST presets drive their panels with page-level calls from inside the message
 * iframe: the script writes the chat input (`send_textarea`), scrolls or resizes
 * the frame (`resizeIframe`), or reaches the host to rewrite the chat record
 * (`SillyTavern.getContext().chat[i].mes = …`). RisuAI runs none of that, and
 * deleting the script silently removes the behaviour.
 *
 * This module names each call site and maps it to something RisuAI can act on:
 *
 * - `fill-send` / `fill` — a declarative bridge action the plugin executes
 * - `details` — expressible with `<details>`, so no script is needed at all
 * - `noop` — pointless under RisuAI (frame resizing: message and page share a
 *   document), so dropping it is correct rather than a loss
 * - `unsupported` — nothing in RisuAI can stand in for it
 *
 * The output is data, not markup: the caller decides how to emit it. That keeps
 * the risky part (rewriting markup) separate from the decision (what the code
 * meant), and lets the review UI explain every mapping before it ships.
 */

export type StActionKind =
  | 'fill-send'
  | 'fill'
  | 'copy'
  | 'details'
  | 'chat-record'
  | 'noop'
  | 'unsupported';

export interface StActionCall {
  kind: StActionKind;
  /** The ST API that was recognised, e.g. `send_textarea`. */
  api: string;
  /** Literal payload when the call site carries one. */
  payload?: string;
  /** Anything referenced but not resolvable at conversion time (e.g. `$1`). */
  payloadExpression?: string;
  reason: string;
}

/**
 * Recognised call sites, checked in order. The first match wins, so specific
 * APIs must come before the generic host-access probes.
 */
interface CallSignature {
  api: string;
  kind: StActionKind;
  test: RegExp;
  /** Extract a literal payload from the match, when the call carries one. */
  payload?: (match: RegExpExecArray) => string | undefined;
  reason: string;
}

const SIGNATURES: readonly CallSignature[] = [
  {
    api: 'send_textarea',
    kind: 'fill-send',
    test: /send_textarea\s*\(\s*(['"])([\s\S]*?)\1/iu,
    payload: (match) => match[2],
    reason: 'ST 的 send_textarea 把文本写进输入框并发送；RisuAI 里由桥接插件执行同一动作。',
  },
  {
    api: 'send_textarea',
    kind: 'fill-send',
    test: /send_textarea\s*\(/iu,
    reason: 'send_textarea 的参数是变量或表达式，转换时无法取值；由桥接插件在点击时读取元素文本。',
  },
  {
    api: 'substituteParams',
    kind: 'fill',
    test: /substituteParams\s*\(/iu,
    reason: 'ST 的 substituteParams 只做宏展开；RisuAI 侧由插件按元素文本填入，无需展开。',
  },
  {
    api: 'copyToClipboard',
    kind: 'copy',
    test: /copyToClipboard|navigator\.clipboard\.writeText/iu,
    reason: '剪贴板写入需要页面级权限，由桥接插件执行。',
  },
  {
    api: 'toggleCollapsible',
    kind: 'details',
    test: /toggleCollapsible\s*\(/iu,
    reason: '折叠切换可用原生 <details>/<summary> 表达，不需要脚本。',
  },
  {
    api: 'SillyTavern.getContext().chat',
    kind: 'chat-record',
    test: /getContext\s*\(\s*\)[\s\S]{0,80}?\.chat\b|\.chat\s*\[[^\]]*\]\s*\.mes\b/iu,
    reason: '改写聊天记录应交给 Lua 触发器（setChat / insertChat），不需要插件。',
  },
  {
    api: 'resizeIframe',
    kind: 'noop',
    test: /resizeIframe|postMessage\s*\(\s*\{[^}]*resize/iu,
    reason: 'RisuAI 的消息与页面同文档，没有 iframe 需要自适应高度，该调用可安全移除。',
  },
  {
    api: 'postMessage',
    kind: 'noop',
    test: /window\.(?:parent|top)\s*\.\s*postMessage\s*\(/iu,
    reason: 'RisuAI 没有宿主窗口可通信，该调用无对应行为。',
  },
  {
    api: 'document.getElementById',
    kind: 'unsupported',
    test: /document\.(?:getElementById|querySelector|body)\b/iu,
    reason: '消息内查不到页面 DOM；该逻辑需要桥接插件或改写为数据属性。',
  },
  {
    api: 'window.parent.document',
    kind: 'unsupported',
    test: /window\.(?:parent|top)\s*\.\s*(?:window\s*\.\s*)?document\b/iu,
    reason: '跨越边界访问宿主文档在 RisuAI 不存在；若意在操作输入框，请改写为桥接声明。',
  },
  {
    api: 'localStorage',
    kind: 'unsupported',
    test: /\blocalStorage\b|\bsessionStorage\b/iu,
    reason: '浏览器存储不在 RisuAI 的可用面内；持久状态请改用聊天变量或 Lua 触发器。',
  },
];

/** Locate every recognised ST action in a fragment or script body. */
export function findStActions(source: string): StActionCall[] {
  const found: StActionCall[] = [];
  const claimed: Array<{ start: number; end: number }> = [];

  for (const signature of SIGNATURES) {
    const pattern = new RegExp(signature.test.source, signature.test.flags.includes('g')
      ? signature.test.flags
      : `${signature.test.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source))) {
      // A broader signature must not re-report a call a narrower one already
      // claimed (`send_textarea('x')` is one action, not two).
      const start = match.index;
      const end = start + match[0].length;
      if (claimed.some((range) => start < range.end && end > range.start)) continue;
      claimed.push({ start, end });
      const payload = signature.payload?.(match);
      found.push({
        kind: signature.kind,
        api: signature.api,
        ...(payload !== undefined ? { payload } : {}),
        reason: signature.reason,
      });
    }
  }

  return found.sort((a, b) => a.api.localeCompare(b.api));
}

/**
 * Bridge actions a fragment needs, given its recognised call sites.
 *
 * Used by the capability report: "this rule needs the plugin, and here is the
 * action list the plugin has to implement for it".
 */
export function requiredBridgeActions(calls: readonly StActionCall[]): string[] {
  const actions = new Set<string>();
  for (const call of calls) {
    if (call.kind === 'fill-send' || call.kind === 'fill' || call.kind === 'copy') {
      actions.add(call.kind);
    }
  }
  return [...actions].sort();
}

/**
 * Emit the declarative markup for one recognised action.
 *
 * Only the `fill` family is emittable: the payload must live in element text,
 * never in an attribute, because RisuAI rewrites curly quotes to ASCII quotes
 * before rendering and `$1` is expanded at run time — a value in an attribute
 * gets terminated by the first quote of the expanded text.
 */
export function bridgeMarkup(label: string, kind: StActionKind): string | null {
  if (kind !== 'fill' && kind !== 'fill-send' && kind !== 'copy') return null;
  return `<button type="button" data-risu-bridge="${kind}">${label}</button>`;
}
