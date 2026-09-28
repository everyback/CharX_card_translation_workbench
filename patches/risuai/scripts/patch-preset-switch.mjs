import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const helper = 'function __codexPresetExists(e,t){return Array.isArray(e)&&(typeof t==="number"||typeof t==="string"&&/^\\d+$/.test(t))&&Number.isInteger(+t)&&+t>=0&&e[t]!==null&&typeof e[t]==="object"&&!Array.isArray(e[t])}';
const edits = [
  ['function LQ(){let e=Q.db,t=e.botPresets;if(e.botPresetsId===-1)return;', helper + 'function LQ(){let e=Q.db,t=e.botPresets;if(!__codexPresetExists(t,e.botPresetsId))return;'],
  ['function zQ(e=0,t=!0){t&&LQ();let n=Q.db,r=n.botPresets[e];', 'function zQ(e=0,t=!0){if(!__codexPresetExists(Q.db.botPresets,e))return;t&&LQ();let n=Q.db,r=n.botPresets[e];'],
];

export function patchPresetSwitch(source) {
  if (edits.every(([, replacement]) => source.split(replacement).length === 2) && edits.every(([old]) => !source.includes(old))) return source;
  if (source.includes('__codexPresetExists')) throw new Error('Incomplete existing preset patch');
  for (const [old] of edits) {
    if (source.split(old).length !== 2) throw new Error('Expected exactly one preset anchor: ' + old);
  }
  for (const [old, replacement] of edits) source = source.replace(old, replacement);
  return source;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || path.resolve(input) === path.resolve(output)) throw new Error('usage: node patch-preset-switch.mjs <input.js> <new-output.js>');
  fs.writeFileSync(output, patchPresetSwitch(fs.readFileSync(input, 'utf8')), { flag: 'wx' });
  console.log('Preset guards applied.');
}
