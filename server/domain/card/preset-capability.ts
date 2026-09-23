/**
 * Preset/card capability ownership for the RisuAI target.
 *
 * Answers one question per rule or script: after conversion, does this work
 * directly, need rewriting, need a page-level bridge plugin, or has no RisuAI
 * equivalent at all? The judgement rule is deliberately narrow:
 *
 *   Everything textual (macros, variables, conditions, random) works directly.
 *   HTML display needs rewriting. Regex replacement works directly.
 *   Only "the message must reach back into the page UI" needs a bridge.
 *
 * The module is pure: it classifies a string and returns findings, so the scan
 * stage can label segments and the review UI can warn about the consequences of
 * a missing bridge plugin without any RisuAI instance involved.
 *
 * Evidence for the rulings lives in `docs/预设HTML翻译与桥接实现方案.md` §2.
 */

/** How one rule lands in RisuAI. */
export type CapabilityOwner = 'direct' | 'convert' | 'bridge' | 'impossible';

export type CapabilityFindingCode =
  | 'BRIDGE_INPUT'
  | 'BRIDGE_DOM'
  | 'BRIDGE_CLIPBOARD'
  | 'CONVERT_INLINE_HANDLER'
  | 'CONVERT_STYLE'
  | 'CONVERT_MEDIA'
  | 'CONVERT_FENCE'
  | 'CONVERT_CHAT_RECORD'
  | 'CONVERT_VAR_WRITE'
  | 'IMPOSSIBLE_SCRIPT'
  | 'IMPOSSIBLE_STSCRIPT'
  | 'IMPOSSIBLE_REGEX_DEPTH'
  | 'IMPOSSIBLE_REGEX_EDIT'
  | 'UNKNOWN_MACRO';

export type CapabilitySeverity = 'info' | 'warning' | 'error';

export interface CapabilityFinding {
  code: CapabilityFindingCode;
  owner: CapabilityOwner;
  severity: CapabilitySeverity;
  /** Chinese, user-facing: what was found and what it means. */
  message: string;
}

export interface CapabilityReport {
  owner: CapabilityOwner;
  findings: CapabilityFinding[];
  /** Bridge actions required, e.g. `['fill-send']`. Empty when no bridge is needed. */
  bridgeActions: string[];
  /** Macros referenced by the text. */
  macros: string[];
  /** Mitigation hints the review UI can show next to the rule. */
  mitigations: string[];
}

/**
 * Macros RisuAI actually registers (`registerFunction` in `src/ts/cbs.ts`,
 * enumerated from the deployed bundle: 163 entries).
 *
 * `gettempvar` is listed because it is an *alias* of `tempvar`, not a separate
 * registration.
 */
export const RISU_KNOWN_MACROS: ReadonlySet<string> = new Set([
  '__', 'abs', 'addvar', 'all', 'and', 'any', 'arrayassert', 'arrayelement', 'arraylength',
  'arraypop', 'arraypush', 'arrayshift', 'arraysplice', 'asset', 'assetlist', 'audio',
  'authornote', 'average', 'axmodel', 'bc', 'bg', 'bgm', 'bkspc', 'blank', 'bo', 'br',
  'button', 'calc', 'capitalize', 'cbr', 'ceil', 'char', 'chardisplayasset', 'charhistory',
  'chatindex', 'codeblock', 'comment', 'contains', 'crypt', 'date', 'decbc', 'decbo',
  'declare', 'description', 'dice', 'dictelement', 'displayescapedanglebracketclose',
  'displayescapedanglebracketopen', 'displayescapedbracketclose', 'displayescapedbracketopen',
  'displayescapedcolon', 'displayescapedsemicolon', 'element', 'emotion', 'emotionlist',
  'endswith', 'equal', 'erase', 'exampledialogue', 'file', 'filter', 'firstmsgindex',
  'fixnum', 'floor', 'fromhex', 'getglobalvar', 'gettempvar', 'getvar', 'globalnote',
  'greater', 'greaterequal', 'hash', 'hiddenkey', 'history', 'idleduration', 'image', 'img',
  'inlay', 'inlayed', 'inlayeddata', 'iserror', 'isfirstmsg', 'isodate', 'isotime', 'jb',
  'jbtoggled', 'join', 'lastmessage', 'lastmessageid', 'length', 'less', 'lessequal',
  'lorebook', 'lower', 'mainprompt', 'makearray', 'makedict', 'max', 'maxcontext',
  'messagedate', 'messageidleduration', 'messagetime', 'messageunixtimearray', 'metadata',
  'min', 'model', 'moduleassetlist', 'moduleenabled', 'not', 'notequal', 'objectassert',
  'or', 'path', 'persona', 'personality', 'pick', 'position', 'pow', 'prefillsupported',
  'previouscharchat', 'previouschatlog', 'previoususerchat', 'randint', 'random', 'range',
  'remaind', 'replace', 'return', 'reverse', 'risu', 'role', 'roll', 'rollp', 'round',
  'ruby', 'scenario', 'screenheight', 'screenwidth', 'setdefaultvar', 'settempvar', 'setvar',
  'slot', 'source', 'split', 'spread', 'startswith', 'sum', 'tempvar', 'tex', 'time',
  'tohex', 'tonumber', 'trigger_id', 'trim', 'ue', 'unicodedecode', 'unicodeencode',
  'unixtime', 'upper', 'user', 'userhistory', 'video', 'xor', 'xordecrypt',
]);

interface Signature {
  code: CapabilityFindingCode;
  owner: CapabilityOwner;
  severity: CapabilitySeverity;
  test: RegExp;
  message: string;
  action?: string;
  mitigation?: string;
}

/**
 * Ordered most-severe-first so the report's headline owner is the strongest
 * requirement present. `impossible` beats `bridge` beats `convert` beats `direct`.
 */
const SIGNATURES: readonly Signature[] = [
  {
    code: 'IMPOSSIBLE_SCRIPT',
    owner: 'impossible',
    severity: 'error',
    test: /<script\b|javascript:/iu,
    message: '含 <script>：RisuAI 会剥离脚本且消息内不执行 JS，这段逻辑无法迁移。',
    mitigation: '把脚本承担的功能拆开：折叠改 <details>，改聊天记录改 Lua 触发器，写输入框改桥接插件。',
  },
  {
    code: 'BRIDGE_INPUT',
    owner: 'bridge',
    severity: 'warning',
    test: /send_textarea|#send_butt|querySelector\(['"]#send/iu,
    message: '要往聊天输入框写字（或点发送键）：RisuAI 的消息与 Lua 触发器都够不到输入框，只有页面级插件能写。',
    action: 'fill-send',
    mitigation: '安装桥接插件（API 2.1），按钮写成 data-risu-bridge="fill-send"；插件没装则该按钮点了没反应。',
  },
  {
    code: 'BRIDGE_DOM',
    owner: 'bridge',
    severity: 'warning',
    test: /getElementById|document\.(querySelector|body|createElement)|addEventListener|window\.parent\b/iu,
    message: '需要页面级 DOM 访问（查询元素 / 绑事件 / 与宿主通信）：消息内做不到，只能由插件执行。',
    action: 'fill-send',
    mitigation: '由桥接插件用事件委托完成，预设侧只保留声明（data-risu-bridge）；纯自适应高度（resizeIframe）可直接放弃——消息与页面同文档。',
  },
  {
    code: 'BRIDGE_CLIPBOARD',
    owner: 'bridge',
    severity: 'warning',
    test: /navigator\.clipboard|execCommand\(['"]copy/iu,
    message: '使用剪贴板：需要页面级插件执行。',
    action: 'copy',
  },
  {
    code: 'IMPOSSIBLE_STSCRIPT',
    owner: 'impossible',
    severity: 'error',
    // STscript only appears as a line-leading command. Requiring whitespace or
    // end-of-line after the name matters: `{{/when}}` is a macro terminator, not
    // a `/when` command.
    test: /^[ \t]*\/(?:send|inject|setvar|getvar|trigger|sys|gen|continue|stop|abort|reroll|echo|pass|run|comment)(?=[ \t]|$)/imu,
    message: '含 STscript 斜杠指令：RisuAI 消息内不执行 STscript。',
    mitigation: '用 Lua 触发器或桥接插件替代该指令的副作用。',
  },
  {
    code: 'CONVERT_CHAT_RECORD',
    owner: 'convert',
    severity: 'warning',
    test: /SillyTavern|\.getContext\(|\.mes\b|mes_edit|chat\[\s*\w+\s*\]/iu,
    message: '直接改聊天记录或触发界面刷新：改用 Lua 触发器即可，不需要插件。',
    mitigation: '改写为 Lua 触发器的 setChat / insertChat / reloadChat。',
  },
  {
    code: 'CONVERT_INLINE_HANDLER',
    owner: 'convert',
    severity: 'warning',
    test: /\son[a-z]+\s*=\s*["']/iu,
    message: '含内联事件属性（onclick 等）：RisuAI 会剥离。',
    mitigation: '折叠类改写成 <details>/<summary>；需要执行动作的改走桥接声明。',
  },
  {
    code: 'CONVERT_MEDIA',
    owner: 'convert',
    severity: 'info',
    test: /@media\b/iu,
    message: '含 @media：RisuAI 进入断点后不给内部选择器加 x-risu- 前缀，断点里的规则会静默失效。',
    mitigation: '转换时把断点展开到同级。',
  },
  {
    code: 'CONVERT_STYLE',
    owner: 'convert',
    severity: 'info',
    test: /<style\b/iu,
    message: '含 <style>：需转成 <risu-style> 十六进制块，否则会被 markdown 吃掉。',
    mitigation: '交给转换器处理；CSS 里不要自己写 x-risu- 前缀或 .chattext 作用域。',
  },
  {
    code: 'CONVERT_FENCE',
    owner: 'convert',
    severity: 'info',
    test: /^\s*```/mu,
    message: '含 ```html 围栏：RisuAI 会把围栏渲染成代码块，面板会显示成源码。',
    mitigation: '面向 RisuAI 时去掉围栏（转换器 --no-fence）。',
  },
];

const SEVERITY_ORDER: Record<CapabilityOwner, number> = {
  impossible: 3,
  bridge: 2,
  convert: 1,
  direct: 0,
};

/**
 * Macros referenced by `{{name::…}}`.
 *
 * Block keywords (`{{#when::…}}`, `{{:else}}`, `{{/when}}`) are deliberately
 * excluded: they are control flow, not registered macros, so treating them as
 * unknowns would flag every conditional preset as unmigratable.
 */
export function collectMacros(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{([#/]?)([a-zA-Z_][a-zA-Z0-9_]*)/gu)) {
    if (match[1]) continue;
    found.add(match[2].toLowerCase());
  }
  return [...found].sort();
}

/**
 * Lowercased ST macro name → the RisuAI name it rewrites to.
 *
 * Kept here as data rather than imported from `st-macro-map.ts`, because that
 * module imports this one for the macro registry — importing back would create a
 * cycle. Both sides must stay in sync; a test asserts they agree.
 */
export const ST_MACRO_ALIASES: ReadonlyMap<string, string> = new Map([
  ['not_equal', 'notequal'],
  ['notequals', 'notequal'],
  ['newline', 'br'],
  ['new_line', 'br'],
  ['linebreak', 'br'],
  ['space', 'blank'],
  ['noop', 'blank'],
  ['dice', 'roll'],
  ['lastusermessage', 'previoususerchat'],
  ['lastuserchat', 'previoususerchat'],
  ['lastcharmessage', 'previouscharchat'],
  ['lastcharchat', 'previouscharchat'],
]);

/** `{{incvar::x}}` / `{{decvar::x}}` become `{{addvar::x::±1}}`. */
export const ST_ARITHMETIC_MACROS: ReadonlySet<string> = new Set(['incvar', 'decvar']);

/**
 * Macros that RisuAI does not know: third-party extension macros, i.e. unmigratable.
 *
 * Names that only differ by case, or that have a known ST→RisuAI alias, are
 * resolvable by the macro rewriter and therefore not reported here.
 */
export function unknownMacros(text: string): string[] {
  return collectMacros(text).filter((name) => {
    const lower = name.toLowerCase();
    if (RISU_KNOWN_MACROS.has(lower)) return false;
    return !ST_MACRO_ALIASES.has(lower) && !ST_ARITHMETIC_MACROS.has(lower);
  });
}

/**
 * Options for preset-regex specific checks that depend on script metadata rather
 * than the replacement text alone.
 */
export interface ScriptCapabilityOptions {
  /** SillyTavern `minDepth` / `maxDepth` (non-negative means "set"). */
  minDepth?: number | null;
  maxDepth?: number | null;
  /** SillyTavern `runOnEdit`. */
  runOnEdit?: number | null;
  /** SillyTavern `substituteRegex`. */
  substituteRegex?: number | null;
  /** SillyTavern `trimStrings`. */
  trimStrings?: readonly string[];
  /** SillyTavern placements; only 1 (input) and 2 (output) map onto RisuAI. */
  placements?: readonly number[];
  /** SillyTavern `disabled`. */
  disabled?: boolean;
}

/**
 * Classify one replacement template (a regex `out`, a card script body, or an
 * HTML fragment) plus optional ST script metadata.
 */
export function classifyCapability(
  text: string,
  options: ScriptCapabilityOptions = {},
): CapabilityReport {
  const findings: CapabilityFinding[] = [];
  const bridgeActions = new Set<string>();
  const mitigations: string[] = [];

  for (const signature of SIGNATURES) {
    if (!signature.test.test(text)) continue;
    findings.push({
      code: signature.code,
      owner: signature.owner,
      severity: signature.severity,
      message: signature.message,
    });
    if (signature.action) bridgeActions.add(signature.action);
    if (signature.mitigation) mitigations.push(signature.mitigation);
  }

  if (options.minDepth != null && options.minDepth >= 0 || options.maxDepth != null && options.maxDepth >= 0) {
    findings.push({
      code: 'IMPOSSIBLE_REGEX_DEPTH',
      owner: 'convert',
      severity: 'warning',
      message: '使用了 minDepth / maxDepth 深度过滤：RisuAI 正则没有对应字段。',
    });
    mitigations.push('在模式内用 {{chatindex}} + {{#when}} 表达"最近 N 条消息"。');
  }
  if (options.runOnEdit != null) {
    findings.push({
      code: 'IMPOSSIBLE_REGEX_EDIT',
      owner: 'impossible',
      severity: 'warning',
      message: '声明了 runOnEdit：RisuAI 正则没有编辑时机。',
    });
  }
  if (options.substituteRegex != null && options.substituteRegex !== 0) {
    findings.push({
      code: 'IMPOSSIBLE_REGEX_EDIT',
      owner: 'convert',
      severity: 'info',
      message: 'substituteRegex 语义与 RisuAI 的 flag <cbs> 不同，需人工确认。',
    });
  }
  if (options.trimStrings?.length) {
    findings.push({
      code: 'IMPOSSIBLE_REGEX_EDIT',
      owner: 'convert',
      severity: 'info',
      message: 'trimStrings 无直接对应；末尾多换行可用 flag <no_end_nl> 处理。',
    });
  }
  if (options.placements?.some((placement) => placement !== 1 && placement !== 2)) {
    findings.push({
      code: 'IMPOSSIBLE_REGEX_EDIT',
      owner: 'impossible',
      severity: 'warning',
      message: 'placement 3/4（斜杠命令、世界书）在 RisuAI 没有对应处理阶段。',
    });
  }

  // Macro-level checks: unknown macros cannot run, and `setvar` silently no-ops
  // in the display pipeline (`runVar` defaults to false).
  const macros = collectMacros(text);
  for (const name of unknownMacros(text)) {
    findings.push({
      code: 'UNKNOWN_MACRO',
      owner: 'impossible',
      severity: 'warning',
      message: `宏 {{${name}::}} 不在 RisuAI 的宏表里（第三方扩展宏），迁移后不会展开。`,
    });
  }
  if (macros.includes('setvar')) {
    findings.push({
      code: 'CONVERT_VAR_WRITE',
      owner: 'convert',
      severity: 'warning',
      message: '使用了 {{setvar::}}：它只在上下文 runVar 为真时写入，而显示管线默认 runVar=false，所以不会生效。',
    });
    mitigations.push('单条消息内的临时状态改用 {{settempvar::}}；跨消息持久状态改用 Lua 触发器的 setChatVar。');
  }

  const owner = findings.reduce<CapabilityOwner>(
    (worst, finding) => (SEVERITY_ORDER[finding.owner] > SEVERITY_ORDER[worst] ? finding.owner : worst),
    'direct',
  );

  return {
    owner,
    findings,
    bridgeActions: [...bridgeActions],
    macros,
    mitigations: [...new Set(mitigations)],
  };
}

export interface CapabilitySummary {
  counts: Record<CapabilityOwner, number>;
  /** Rules that stop working when the bridge plugin is absent. */
  needsBridge: number;
  /** True when the preset or card depends on a page-level plugin at all. */
  requiresPlugin: boolean;
  /** True when something simply cannot be migrated and needs a design change. */
  hasImpossible: boolean;
}

/** Roll up per-rule reports into a preset/card-level summary for the review UI. */
export function summarizeCapabilities(reports: readonly CapabilityReport[]): CapabilitySummary {
  const counts: Record<CapabilityOwner, number> = { direct: 0, convert: 0, bridge: 0, impossible: 0 };
  for (const report of reports) counts[report.owner] += 1;
  return {
    counts,
    needsBridge: counts.bridge,
    requiresPlugin: counts.bridge > 0,
    hasImpossible: counts.impossible > 0,
  };
}

/** Card-level bridge contract: the attribute the plugin reacts to. */
export const BRIDGE_ATTRIBUTE = 'data-risu-bridge';
export const BRIDGE_VALUE_ATTRIBUTE = 'data-risu-value';

/**
 * Bridge actions declared in already-converted markup, e.g.
 * `data-risu-bridge="fill-send"` → `['fill-send']`.
 *
 * This is the authoritative signal for a converted preset: the converter strips
 * the SillyTavern selectors (`#send_textarea` and friends) and replaces them
 * with this declaration, so signature-matching the ST text would miss it.
 */
export function declaredBridgeActions(text: string): string[] {
  const actions = new Set<string>();
  const pattern = new RegExp(`${BRIDGE_ATTRIBUTE}\\s*=\\s*["']([^"']+)["']`, 'giu');
  for (const match of text.matchAll(pattern)) {
    const action = match[1].trim();
    if (action) actions.add(action);
  }
  return [...actions].sort();
}

/** One regex rule's ownership, keyed for the review UI. */
export interface RuleCapability {
  index: number;
  comment: string;
  type: string;
  owner: CapabilityOwner;
  /** True when the rule stops working unless the bridge plugin is installed. */
  requiresBridge: boolean;
  bridgeActions: string[];
  findings: CapabilityFinding[];
}

export interface PresetCapabilityReport {
  rules: RuleCapability[];
  summary: CapabilitySummary;
  /**
   * Switch-gated prompts found in the template. Their gate value must be `1` or
   * `true`, because `{{#when::X}}` treats anything else as false.
   */
  switchGates: string[];
  /** Macros used anywhere in the preset that RisuAI does not register. */
  unknownMacros: string[];
  /** True when `{{setvar::}}` appears: it does not execute in the display pipeline. */
  usesSetvar: boolean;
  /** Human-readable cautions the review UI shows above the rule list. */
  notices: string[];
}

/**
 * Preset-level cautions that are not tied to a single rule.
 *
 * These are the failure modes that produce a preset which imports cleanly, looks
 * correct, and quietly does nothing.
 */
export function presetCapabilityNotices(report: {
  switchGates: readonly string[];
  unknownMacros: readonly string[];
  usesSetvar: boolean;
  needsBridge: number;
}): string[] {
  const notices: string[] = [];
  if (report.needsBridge > 0) {
    notices.push(
      `有 ${report.needsBridge} 条规则需要桥接插件：未安装时这些按钮点了没反应，不会报错。`,
    );
  }
  if (report.switchGates.length > 0) {
    notices.push(
      `${report.switchGates.length} 个开关门控用 {{#when::{{getglobalvar::…}}}} 判断，`
      + '该宏只把 "1" / "true" 当作真值；开关初值必须是这两者之一，否则门控内容不会进入提示词。',
    );
  }
  if (report.usesSetvar) {
    notices.push(
      '使用了 {{setvar::}}：显示管线里 runVar 默认为 false，该宏不会写入。'
      + '单条消息内的临时状态请改 {{settempvar::}}，跨消息持久状态请用 Lua 触发器的 setChatVar。',
    );
  }
  if (report.unknownMacros.length > 0) {
    notices.push(
      `发现 ${report.unknownMacros.length} 个 RisuAI 未注册的宏（${report.unknownMacros.slice(0, 5).join('、')}`
      + `${report.unknownMacros.length > 5 ? ' 等' : ''}）：多为第三方扩展宏，迁移后不会展开。`,
    );
  }
  return notices;
}

/**
 * Classify a **converted RisuAI preset** (`regex` + `promptTemplate`).
 *
 * Runs on the converted form, not the raw ST JSON, because that is what ships:
 * the converter is what turns inline handlers into `<details>` and adds bridge
 * declarations, so classifying the converted text is what predicts real
 * behaviour.
 */
export function analyzePresetCapabilities(preset: Record<string, unknown>): PresetCapabilityReport {
  const rules: RuleCapability[] = [];
  const regex = Array.isArray(preset.regex) ? (preset.regex as Array<Record<string, unknown>>) : [];

  regex.forEach((rule, index) => {
    const out = typeof rule.out === 'string' ? rule.out : '';
    const input = typeof rule.in === 'string' ? rule.in : '';
    const report = classifyCapability(`${out}\n${input}`);
    // A converted rule carries no ST selector any more, so the declaration in
    // the markup is what tells the UI this rule depends on the plugin.
    const declared = declaredBridgeActions(out);
    const bridgeActions = [...new Set([...report.bridgeActions, ...declared])].sort();
    rules.push({
      index,
      comment: String(rule.comment ?? ''),
      type: String(rule.type ?? ''),
      owner: bridgeActions.length ? 'bridge' : report.owner,
      requiresBridge: bridgeActions.length > 0,
      bridgeActions,
      findings: report.findings,
    });
  });

  const prompts = Array.isArray(preset.promptTemplate)
    ? (preset.promptTemplate as Array<Record<string, unknown>>)
    : [];
  const template = prompts.map((item) => String(item.text ?? '')).join('\n');

  const switchGates = [
    ...new Set(
      [...template.matchAll(/getglobalvar::(toggle_[A-Za-z0-9_]+)/gu)].map((match) => match[1]),
    ),
  ].sort();

  const summary = summarizeCapabilities(rules.map((rule) => ({
    owner: rule.owner,
    findings: rule.findings,
    bridgeActions: rule.bridgeActions,
    macros: [],
    mitigations: [],
  })));

  return {
    rules,
    summary,
    switchGates,
    unknownMacros: unknownMacros(template),
    usesSetvar: collectMacros(template).includes('setvar'),
    notices: presetCapabilityNotices({
      switchGates,
      unknownMacros: unknownMacros(template),
      usesSetvar: collectMacros(template).includes('setvar'),
      needsBridge: summary.needsBridge,
    }),
  };
}

/**
 * Why content must never travel through an HTML attribute.
 *
 * RisuAI rewrites curly quotes to ASCII quotes before rendering
 * (`data.replace(/[“”]/g, '"')`), and `$1` is expanded at run time, so a
 * template such as `data-risu-value="$1"` gets terminated by the first quote in
 * the model output. The converter therefore emits the payload as element text.
 */
export function hasDynamicAttributePayload(text: string): boolean {
  return /\bdata-[\w-]+="[^"]*\$[0-9&<]/u.test(text) || /\b\w+="[^"]*\$[0-9]/u.test(text);
}
