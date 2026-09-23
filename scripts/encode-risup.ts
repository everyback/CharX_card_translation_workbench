/**
 * Pack a RisuAI preset JSON into a `.risup` container.
 *
 * Usage:
 *   npx tsx scripts/encode-risup.ts <preset.json> <output.risup> [--name=预设名]
 *
 * Kept separate from `convert-preset-html.ts`: converting and packing are two
 * independent steps, so a preset JSON can be reviewed (or hand-edited) between
 * them, and a packing failure can never leave a half-converted preset behind.
 * `encodeRisuPreset()` fills `name` when the JSON object has none.
 */
import fs from 'node:fs';
import path from 'node:path';
import { encodeRisuPreset } from '../server/domain/card/risup.js';

const argv = process.argv.slice(2);
const nameFlag = argv.find((arg) => arg.startsWith('--name='))?.slice('--name='.length);
const positional = argv.filter((arg) => !arg.startsWith('--'));
const inputPath = positional[0];
const outputPath = positional[1];
if (!inputPath || !outputPath) {
  console.error('用法: npx tsx scripts/encode-risup.ts <preset.json> <output.risup> [--name=预设名]');
  process.exit(2);
}

const preset = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as Record<string, unknown>;
if (!preset || typeof preset !== 'object' || Array.isArray(preset)) {
  throw new Error('预设 JSON 的根节点必须是对象。');
}
if (nameFlag) preset.name = nameFlag;
if (!Array.isArray(preset.promptTemplate)) {
  throw new Error('预设 JSON 缺少 promptTemplate 数组，不能作为 RisuAI 预设打包。');
}

const container = encodeRisuPreset(preset);
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(outputPath, container);
console.log(`预设名称 : ${String(preset.name ?? '(未命名)')}`);
console.log(`提示词   : ${(preset.promptTemplate as unknown[]).length} 条，正则 ${Array.isArray(preset.regex) ? (preset.regex as unknown[]).length : 0} 条`);
console.log(`输出预设 : ${outputPath} (${container.length} bytes)`);
