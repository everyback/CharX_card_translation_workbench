import { readFileSync } from 'node:fs';
import { decodeRisuPreset } from './server/domain/card/risup.js';

const files = [
  'temp/out-sample.risup',
  'temp/clean-baseline.risup',
];
const report: string[] = [];
for (const file of files) {
  const decoded = decodeRisuPreset(readFileSync(file));
  const preset = decoded.preset;
  const regex = Array.isArray(preset.regex) ? preset.regex as Array<Record<string, unknown>> : [];
  report.push(`===== ${file} version=${decoded.presetVersion} rpack=${decoded.rpackWrapped} =====`);
  report.push('keys: ' + Object.keys(preset).sort().join(', '));
  report.push('defaultVariables: ' + JSON.stringify(preset.defaultVariables ?? null));
  report.push('regex count: ' + regex.length);
  for (const rule of regex.slice(0, 6)) {
    report.push('  rule keys: ' + Object.keys(rule).join(','));
    report.push('  ' + JSON.stringify({ comment: rule.comment, type: rule.type, flag: rule.flag, ableFlag: rule.ableFlag, in: String(rule.in).slice(0, 60), out: String(rule.out).slice(0, 60) }));
  }
  report.push('promptTemplate len: ' + (Array.isArray(preset.promptTemplate) ? preset.promptTemplate.length : 'n/a'));
  report.push('');
}
writeFileSyncSafe(report.join('\n'));
function writeFileSyncSafe(text: string) {
  process.stdout.write(text + '\n');
}
