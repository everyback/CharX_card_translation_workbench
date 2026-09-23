'use strict';
/**
 * 检查预设 out 里的代码围栏，并打印首尾结构。
 * 用法: node probe-preset-out.cjs [名字片段] [--save-dir=/app/save]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const magic = Buffer.from('RISUSAVE\0', 'utf8');
const FENCE = String.fromCharCode(96).repeat(3);
const args = process.argv.slice(2);
const needle = args.find((a) => !a.startsWith('--')) || '';
const saveDir = (args.find((a) => a.startsWith('--save-dir=')) || '').slice('--save-dir='.length) || '/app/save';

const dbPath = path.join(saveDir, Buffer.from('database/database.bin', 'utf8').toString('hex'));
const data = fs.readFileSync(dbPath);
let offset = magic.length;
const blocks = [];
while (offset < data.length) {
  const type = data[offset];
  const compressed = data[offset + 1] === 1;
  offset += 2;
  const nameLength = data[offset];
  offset += 1;
  const name = Buffer.from(data.subarray(offset, offset + nameLength)).toString('utf8');
  offset += nameLength;
  const length = Buffer.from(data.subarray(offset, offset + 4)).readUInt32LE(0);
  offset += 4;
  const payload = Buffer.from(data.subarray(offset, offset + length));
  offset += length;
  let content = payload;
  if (compressed) {
    try {
      content = zlib.gunzipSync(payload);
    } catch {
      /* 原样 */
    }
  }
  blocks.push({ type, name, content });
}

const presets = JSON.parse(blocks.find((b) => b.type === 4).content.toString('utf8'));
for (const preset of presets) {
  if (needle && !preset.name.includes(needle)) continue;
  console.log('=== ' + preset.name + ' ===');
  for (const index of [1, 12, 15]) {
    const rule = (preset.regex || [])[index];
    if (!rule) continue;
    const out = String(rule.out || '');
    const fences = out.split(FENCE).length - 1;
    console.log(`  regex[${index}] ${rule.comment}`);
    console.log(`     out 长度 ${out.length} | 围栏(三反引号)出现 ${fences} 次`);
    console.log(`     开头: ${JSON.stringify(out.slice(0, 70))}`);
    console.log(`     结尾: ${JSON.stringify(out.slice(-50))}`);
    console.log(`     in 开头: ${JSON.stringify(String(rule.in).slice(0, 70))}`);
  }
  console.log('');
}
