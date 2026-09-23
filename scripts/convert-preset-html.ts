/**
 * Rewrite the SillyTavern-format HTML blocks inside a RisuAI `.risup` preset
 * into RisuAI-compatible markup.
 *
 * Usage:
 *   npx tsx scripts/convert-preset-html.ts <input.risup> <output.risup> [--bridge]
 *
 *   --bridge   rewrite buttons into `data-risu-bridge` declarations handled by
 *              the bridge plugin — the only path that can reach the chat input
 *
 * A preset can carry SillyTavern-style HTML in its regex `out` fields, where ST
 * renders a fenced `html` block inside a sandboxed iframe: its own document, its
 * own JavaScript, `postMessage` resizing. RisuAI has no iframe path — the markup
 * goes straight into the chat message and through markdown-it + DOMPurify — so
 * scripts, inline handlers, `html`/`body` scoping and `@media` selectors all
 * stop working. This script rewrites those blocks and reports every change.
 *
 * Only regex `out` fields are touched; every other preset field is copied
 * through unchanged. Outputs:
 *
 *   <output.risup>.html             the converted snippets, concatenated
 *   <output.risup>.report.json      per-block conversion report
 *   <output.risup>.regex-N-*.html   one snippet per converted block
 */
import fs from 'node:fs';
import path from 'node:path';
import { convertStHtmlToRisu } from '../server/domain/card/st-html-to-risu.js';
import { decodeRisuPreset } from '../server/domain/card/risup.js';

/**
 * 按钮点击怎么落地。预设只**声明**要做什么，不自己实现：
 *
 * - `none`      纯静态按钮，点了没反应
 * - `bridge`    交给桥接插件（bridge-plugin/risu-bridge.plugin.js，API 2.1）：
 *               预设写 data-risu-bridge 声明，插件负责执行 —— 包括写输入框。
 *
 * 方案已统一到桥接插件。RisuAI 的消息内 Lua 触发器白名单里没有 DOM
 * （process/scriptings.ts 的 declareAPI 只有 setChatVar/addChat/reloadChat…），
 * 所以那条路线永远够不到输入框；为了不让预设出现「一半走插件、一半走触发器」
 * 的分裂状态，这里不再生成 risu-btn，转换脚本也不再支持该模式。
 */
type ButtonHook = 'none' | 'bridge';

/**
 * ST 的润色脚本靠写宿主聊天对象 + 点 SillyTavern 的编辑按钮完成替换，RisuAI 两条都没有。
 * 这里把「应用润色」重新表达成桥接动作：把 <refine> 的 JSON 写进输入框并发送，
 * 由模型/卡自己按它执行修改。插件只负责「写输入框 + 发送」，不知道润色是什么。
 *
 * 片段走与 ST 块相同的转换管线，所以 CSS 会被编成 <risu-style>，
 * 直接写裸 <style> 会在渲染时被剥掉。
 */
const REFINE_FRAGMENT = `<div class="refine-panel">
  <style>
    .refine-panel { margin-top: 6px; }
    .refine-panel .refine-apply {
      display: block; width: 100%; padding: 8px 12px;
      font-size: 13px; cursor: pointer; color: #e9e3ff;
      background: linear-gradient(135deg, rgba(141,121,222,0.35), rgba(109,97,184,0.25));
      border: 1px solid rgba(180,160,255,0.35); border-radius: 10px;
    }
    .refine-panel .refine-apply:hover {
      background: linear-gradient(135deg, rgba(141,121,222,0.5), rgba(109,97,184,0.4));
    }
  </style>
  <button class="refine-apply" data-risu-bridge="fill-send" data-risu-value="应用润色：请按上一条消息里 &lt;refine&gt; 的 original/corrected 逐条修改正文。">应用润色</button>
</div>`;

/**
 * 把 FATE 这类「点一下把选项写进输入框」的按钮改成桥接声明。
 *
 * 刻意**不写 data-risu-value**。原因是一个实测踩到的坑：
 * 把 `$1` 回填进 HTML 属性时会被**引号截断**——
 *   RisuAI 渲染前会做 `replace(/[“”]/g, '"')` 把弯引号转成直角引号，
 *   而 `$1` 是运行时插入，模板侧无法预转义，属性值就在 `"` 处终止。
 * 例：`【…定金额度，“就它了”】` 回填后属性只剩到 `“` 之前。
 *
 * 同一段文字作为按钮**文本**是完整的，所以内容只放文本，属性只放固定的动作名。
 * 详见 docs/预设HTML翻译与桥接实现方案.md 的风险 1。
 */
function toBridgeAttributes(html: string): { html: string; bridged: number } {
  let bridged = 0;
  const rewritten = html.replace(/<button\b([^>]*)>([\s\S]*?)<\/button>/giu, (full, attrs: string, inner: string) => {
    const value = inner.replace(/<[^>]*>/gu, '').trim();
    if (!value) return full;
    bridged += 1;
    return `<button${attrs} data-risu-bridge="fill-send">${inner}</button>`;
  });
  return { html: rewritten, bridged };
}

function refineAction(hook: ButtonHook): string {
  if (hook === 'bridge') return `${convertStHtmlToRisu(REFINE_FRAGMENT).html}\n`;
  return '<!-- 润色写回未接：RisuAI 不执行消息内 JS；加 --bridge 由桥接插件写输入框 -->\n';
}

interface BlockReport {
  index: number;
  comment: string;
  type: string;
  sourceLength: number;
  markupLength: number;
  wasFullDocument: boolean;
  hadScript: boolean;
  collapsibleRebuilt: boolean;
  buttonsWired: number;
  refineActionAdded: boolean;
  counts: { removed: number; rewritten: number; note: number };
  issues: Array<{ level: string; code: string; message: string }>;
}

const argv = process.argv.slice(2);
const buttonHook: ButtonHook = argv.includes('--bridge') ? 'bridge' : 'none';
const dropFence = argv.includes('--no-fence');
const positional = argv.filter((arg) => !arg.startsWith('--'));
const inputPath = positional[0];
const outputPath = positional[1];
if (!inputPath || !outputPath) {
  console.error('用法: npx tsx scripts/convert-preset-html.ts <input.risup> <output.risup> [--bridge] [--no-fence]');
  console.error('  --bridge    按钮改写成 data-risu-bridge 声明，由桥接插件执行（唯一能写输入框的路径）');
  console.error('  --no-fence  去掉 ```html 代码围栏，让标记直接内联进消息（RisuAI 可能把围栏渲染成代码块）');
  process.exit(2);
}
if (path.resolve(inputPath).toLowerCase() === path.resolve(outputPath).toLowerCase()) {
  throw new Error('输出路径不能覆盖输入预设。');
}

/** Strip an ST block down to the fragment that still carries content. */
function isRefineCarrier(out: string): boolean {
  return /<div[^>]*\bid="refine"/iu.test(out) && /<script/iu.test(out);
}

/**
 * Replace the body of the ```html fence, leaving the fence intact. The body runs
 * to the last fence; a preset rule holds exactly one block.
 */
function rewriteFencedBlock(raw: string): { out: string; result: ReturnType<typeof convertStHtmlToRisu>; refineActionAdded: boolean; bridged: number } | null {
  const open = /^[ \t]*```html[ \t]*\r?\n/u.exec(raw);
  if (!open) return null;
  const close = raw.lastIndexOf('```');
  if (close < open[0].length) return null;
  const html = raw.slice(open[0].length, close).replace(/\r?\n$/u, '');
  const result = convertStHtmlToRisu(html);
  // 桥接模式：把按钮改写成声明式动作，插件只负责执行
  const bridged = buttonHook === 'bridge' ? toBridgeAttributes(result.html) : { html: result.html, bridged: 0 };
  const body = bridged.html;
  // The refine carrier keeps its hidden JSON div; the action is re-attached on
  // top of the converted fragment rather than through a parsed element.
  const addsRefineAction = isRefineCarrier(html);
  const suffix = addsRefineAction ? refineAction(buttonHook) : '';
  // ST wrapped the block in a ```html fence because ST renders fenced blocks as
  // HTML. RisuAI does not necessarily: a fence can come out as a real code
  // block. `--no-fence` drops the fence so the markup is inline in the message.
  const fence = dropFence ? { open: '', close: '' } : { open: open[0], close: raw.slice(close) };
  return { out: `${fence.open}${body}\n${suffix}${fence.close}`, result, refineActionAdded: addsRefineAction, bridged: bridged.bridged };
}

const decoded = decodeRisuPreset(fs.readFileSync(inputPath));
const preset = decoded.preset;
const regex = Array.isArray(preset.regex) ? (preset.regex as Array<Record<string, unknown>>) : [];

const reports: BlockReport[] = [];
const snippets: string[] = [];
const snippetFiles: Array<{ name: string; body: string }> = [];

for (let index = 0; index < regex.length; index += 1) {
  const rule = regex[index];
  const out = rule.out;
  if (typeof out !== 'string' || !/<html|<!doctype|<style/iu.test(out)) continue;
  const converted = rewriteFencedBlock(out);
  if (!converted) {
    console.log(`跳过 regex[${index}]：out 不是 \`\`\`html 代码块。`);
    continue;
  }
  const { result } = converted;
  rule.out = converted.out;
  const refineActionAdded = converted.refineActionAdded;
  reports.push({
    index,
    comment: String(rule.comment ?? ''),
    type: String(rule.type ?? ''),
    sourceLength: result.report.sourceLength,
    markupLength: result.report.markupLength,
    wasFullDocument: result.report.wasFullDocument,
    hadScript: result.report.hadScript,
    collapsibleRebuilt: result.report.collapsibleRebuilt,
    buttonsWired: converted.bridged,
    refineActionAdded,
    counts: { ...result.report.counts },
    issues: result.report.issues.map((issue) => ({ ...issue })),
  });
  // The report and the reviewable snippet describe the regex body that ships,
  // which for the refine block includes the re-attached action button.
  const body = converted.out.slice(converted.out.indexOf('\n') + 1, converted.out.lastIndexOf('\n```'));
  const slug = /[A-Za-z0-9]+/u.exec(String(rule.comment ?? ''))?.[0] ?? 'block';
  snippetFiles.push({ name: `${outputPath}.regex-${index}-${slug}.html`, body });
  snippets.push(`<!-- regex[${index}] ${rule.comment ?? ''} -->\n${body}\n`);
  const hookNote = `桥接按钮=${converted.bridged}`;
  console.log(`regex[${index}] ${rule.comment ?? ''}`);
  console.log(`  体积 ${result.report.sourceLength} -> ${result.report.markupLength} 字节；移除 ${result.report.counts.removed}，改写 ${result.report.counts.rewritten}，提示 ${result.report.counts.note}`);
  console.log(`  ST 文档壳=${result.report.wasFullDocument} 脚本=${result.report.hadScript} 折叠改写=${result.report.collapsibleRebuilt} ${hookNote}${refineActionAdded ? ' 润色写回=已接回按钮' : ''}`);
}

if (!reports.length) {
  console.error('未找到包含 ST 专用 HTML 的正则规则。');
  process.exit(1);
}

// Everything is written only after every block converted: a half-rewritten
// preset is worse than none, because the regex output feeds straight into the
// chat. The JSON is the reviewable artefact; `scripts/encode-risup.ts` turns it
// into the importable container.
const presetJsonPath = `${outputPath}.preset.json`;
fs.writeFileSync(presetJsonPath, JSON.stringify(preset, null, 2));
fs.writeFileSync(`${outputPath}.html`, snippets.join('\n\n'));
fs.writeFileSync(`${outputPath}.report.json`, JSON.stringify({ name: preset.name, blocks: reports }, null, 2));
for (const file of snippetFiles) fs.writeFileSync(file.name, file.body);

console.log('');
console.log(`预设名称 : ${String(preset.name ?? '(未命名)')}`);
console.log(`转换片段 : ${outputPath}.html`);
console.log(`转换报告 : ${outputPath}.report.json`);
console.log(`预设 JSON: ${presetJsonPath}`);
console.log('');
console.log(`下一步   : npx tsx scripts/encode-risup.ts "${presetJsonPath}" "${outputPath}"`);
if (buttonHook === 'bridge') {
  console.log('按钮落地 : 桥接插件（bridge-plugin/risu-bridge.plugin.js）需已安装，否则按钮点了没反应。');
  console.log('           预设只声明 data-risu-bridge 动作，执行全在插件里。');
} else {
  console.log('按钮落地 : 无 —— 按钮是静态的。加 --bridge 交给桥接插件。');
}

