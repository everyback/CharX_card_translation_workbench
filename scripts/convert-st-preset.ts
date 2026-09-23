/**
 * Convert a SillyTavern chat-completion preset into a RisuAI `.risup` preset.
 *
 * Usage:
 *   npx tsx scripts/convert-st-preset.ts <input.json> [output.risup] [--block=N] [--json]
 *
 *   --block=N   convert prompt_order block N instead of the recommended one
 *   --json      accepted for compatibility; report and archive are always written
 *
 * The generated `.risup` imports through RisuAI's normal "import preset" flow.
 * Disabled and unreferenced ST prompts become RisuAI prompt toggles that default
 * to off, so the live prompt is unchanged until a switch is turned on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { analyzeStPreset } from '../server/domain/card/st-preset-convert.js';
import { buildStPresetArtifacts, encodeStPresetBundle } from '../server/domain/card/st-preset-artifacts.js';

const argv = process.argv.slice(2);
const flags = new Map<string, string>();
const positional: string[] = [];
for (const arg of argv) {
  const match = /^--([^=]+)(?:=(.*))?$/u.exec(arg);
  if (match) flags.set(match[1], match[2] ?? 'true');
  else positional.push(arg);
}

const inputPath = positional[0];
if (!inputPath) {
  console.error('用法: npx tsx scripts/convert-st-preset.ts <input.json> [output.risup] [--block=N] [--name=预设名] [--json]');
  process.exit(2);
}

const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as Record<string, unknown>;
const analysis = analyzeStPreset(raw);
if (!analysis.blocks.length && !analysis.promptCount) {
  console.error('该 JSON 不包含 prompts / prompt_order，无法作为 SillyTavern 预设转换。');
  process.exit(1);
}

const blockFlag = flags.get('block');
const declaredName = flags.get('name')?.trim();
const options = {
  ...(blockFlag ? { blockIndex: Number(blockFlag) } : {}),
  // Presets often carry no `name`, so fall back to the file name; `--name` wins.
  name: declaredName || analysis.name || path.basename(inputPath, path.extname(inputPath)),
};
const artifacts = buildStPresetArtifacts(raw, raw, options);
const { report } = artifacts;
const container = artifacts.risup;

const outputPath = positional[1] || `${path.basename(inputPath, path.extname(inputPath))}.risup`;
if (path.resolve(inputPath).toLowerCase() === path.resolve(outputPath).toLowerCase()) {
  throw new Error('输出路径不能覆盖输入预设。');
}
fs.writeFileSync(`${outputPath}.report.json`, JSON.stringify({ analysis, report }, null, 2));
fs.writeFileSync(`${outputPath}.conversion.zip`, encodeStPresetBundle(raw, raw, artifacts));
if (container) fs.writeFileSync(outputPath, container);

console.log(`预设名称      : ${report.name}`);
console.log(`使用块        : #${report.blockIndex} (character_id=${report.blockCharacterId})`);
console.log(`提示词        : 定义 ${analysis.promptCount} / 引用 ${analysis.referencedCount} / 孤儿 ${analysis.orphanCount}`);
console.log(`产出          : ${report.emitted.length} 条（门控 ${report.emitted.filter((item) => item.gated).length}，常驻 ${report.emitted.filter((item) => !item.gated).length}）`);
console.log(`开关          : ${report.toggleKeys.length} 个（首次使用默认关闭）`);
console.log(`未生成条目    : ${report.dropped.length} 条`);
for (const item of report.dropped) console.log(`   - ${item.name}：${item.reason}`);
console.log(`降级          : ${report.degraded.length} 条`);
for (const item of report.degraded) console.log(`   - ${item.name}：${item.reason}`);
console.log(`角色改写      : ${report.roleRemaps.length} 条`);
console.log(`未映射字段    : ${report.unmappedFields.join(', ') || '(无)'}`);
for (const warning of report.warnings) console.log(`注意          : ${warning}`);
if (container) console.log(`输出          : ${outputPath} (${container.length} bytes)`);
else {
  console.error('存在未迁移的运行行为，未写入 .risup；请查看报告及完整存档包。');
  process.exitCode = 1;
}
console.log(`存档          : ${outputPath}.conversion.zip`);

{
  const reportPath = `${outputPath}.report.json`;
  fs.writeFileSync(reportPath, JSON.stringify({ analysis, report }, null, 2));
  console.log(`报告          : ${reportPath}`);
}
