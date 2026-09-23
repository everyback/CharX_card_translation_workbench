'use strict';
/**
 * 在 RisuAI database.bin 的**全部**块里搜关键词，并打印命中块的名字与大小。
 * 用法: node find-risu-entry.cjs <关键词> [--save-dir=/app/save] [--dump=块名]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const magic = Buffer.from('RISUSAVE\0', 'utf8');
const args = process.argv.slice(2);
const keyword = args.find((a) => !a.startsWith('--')) || '';
const saveDir = (args.find((a) => a.startsWith('--save-dir=')) || '').slice('--save-dir='.length) || '/app/save';
const dump = (args.find((a) => a.startsWith('--dump=')) || '').slice('--dump='.length);

const storagePath = (dir, key) => path.join(dir, Buffer.from(key, 'utf8').toString('hex'));

function parse(data) {
  let offset = magic.length;
  const out = [];
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
        /* 原样保留 */
      }
    }
    out.push({ type, name, content });
  }
  return out;
}

const all = parse(fs.readFileSync(storagePath(saveDir, 'database/database.bin')));
console.log('块总数:', all.length);
console.log('按 type 统计:', Object.entries(all.reduce((acc, b) => ((acc[b.type] = (acc[b.type] || 0) + 1), acc), {})).map(([k, v]) => `${k}:${v}`).join(' '));
console.log('');

if (dump) {
  const blocks = all.filter((b) => b.name === dump);
  console.log(`--dump=${dump} 命中块数:`, blocks.length);
  blocks.forEach((b, i) => {
    const text = b.content.toString('utf8');
    console.log(`--- 块[${i}] type=${b.type} name=${b.name} 字节=${b.content.length}`);
    console.log(text.slice(0, 4000));
  });
}

if (keyword) {
  console.log(`搜索关键词: ${keyword}`);
  let hits = 0;
  for (const b of all) {
    const text = b.content.toString('utf8');
    if (!text.includes(keyword)) continue;
    hits += 1;
    // 尝试取出 name 字段，判断是不是角色
    const m = /"name"\s*:\s*"((?:[^"\\]|\\.){1,60})"/.exec(text);
    const occurrences = text.split(keyword).length - 1;
    console.log(
      `  type=${String(b.type).padStart(2)}  ${b.name.slice(0, 42).padEnd(44)} ${String(b.content.length).padStart(9)} B  命中 ${occurrences} 次  name=${m ? m[1] : '-'}`,
    );
  }
  console.log('');
  console.log('命中块数:', hits);
}
