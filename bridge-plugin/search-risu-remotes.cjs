'use strict';
/**
 * 在 RisuAI save/remotes/*.local.bin 里按关键词搜索。
 * 用法: node search-risu-remotes.cjs <关键词> [--save-dir=/app/save] [--limit=40]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const args = process.argv.slice(2);
const keyword = args.find((a) => !a.startsWith('--')) || '';
const saveDir = (args.find((a) => a.startsWith('--save-dir=')) || '').slice('--save-dir='.length) || '/app/save';
const limit = Number((args.find((a) => a.startsWith('--limit=')) || '').slice('--limit='.length)) || 40;

if (!keyword) {
  console.error('用法: node search-risu-remotes.cjs <关键词>');
  process.exit(2);
}

const files = fs.readdirSync(saveDir);
const entries = [];
for (const file of files) {
  if (!/^[0-9a-f]+$/.test(file)) continue;
  let key;
  try {
    key = Buffer.from(file, 'hex').toString('utf8');
  } catch {
    continue;
  }
  if (!key.startsWith('remotes/') || key.endsWith('.meta')) continue;
  entries.push({ key, file });
}

console.log('remotes 数据文件:', entries.length);
console.log('');

let hits = 0;
for (const entry of entries) {
  const raw = fs.readFileSync(path.join(saveDir, entry.file));
  let text = raw.toString('utf8');
  if (!text.includes(keyword)) {
    // 可能是压缩的
    try {
      text = zlib.gunzipSync(raw).toString('utf8');
    } catch {
      continue;
    }
    if (!text.includes(keyword)) continue;
  }
  hits += 1;
  const nameMatch = /"name"\s*:\s*"((?:[^"\\]|\\.){1,80})"/.exec(text);
  const occurrences = text.split(keyword).length - 1;
  console.log('命中:', entry.key);
  console.log('   字节:', raw.length, '| name字段:', nameMatch ? nameMatch[1] : '-', '| 关键词出现', occurrences, '次');
  if (hits >= limit) break;
}
console.log('');
console.log('命中文件数:', hits);
