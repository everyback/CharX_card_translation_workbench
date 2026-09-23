'use strict';
/**
 * 列出 RisuAI database.bin 里的角色，并搜索指定关键词。
 * 用法: node list-risu-chars.cjs [关键词] [--save-dir /app/save]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const magic = Buffer.from('RISUSAVE\0', 'utf8');
const args = process.argv.slice(2);
const keyword = args.find((a) => !a.startsWith('--')) || '';
const saveDirArg = args.find((a) => a.startsWith('--save-dir='));
const saveDir = saveDirArg ? saveDirArg.slice('--save-dir='.length) : '/app/save';

function storagePath(saveDir, key) {
  return path.join(saveDir, Buffer.from(key, 'utf8').toString('hex'));
}

function blocks(data) {
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
        /* 保持原样，下面按需处理 */
      }
    }
    out.push({ type, name, content });
  }
  return out;
}

const dbPath = storagePath(saveDir, 'database/database.bin');
const all = blocks(fs.readFileSync(dbPath));
const chars = all.filter((b) => b.type === 6);
console.log('角色块数:', chars.length);
console.log('');

for (const block of chars) {
  let text = block.content.toString('utf8');
  let note = '';
  // 可能是二次压缩的字符数据
  if (!/[\u4e00-\u9fa5]/.test(text) && !/"name"/.test(text)) {
    try {
      text = zlib.gunzipSync(block.content).toString('utf8');
      note = '(二次解压)';
    } catch {
      note = '(无法解出文本)';
    }
  }
  const nameMatch = /"name"\s*:\s*"((?:[^"\\]|\\.){1,60})"/.exec(text);
  const name = nameMatch ? nameMatch[1] : '';
  const hit = keyword && text.includes(keyword);
  const mark = hit ? '  <<< 命中 ' + keyword : '';
  if (keyword) {
    if (!hit) continue;
  }
  console.log(
    `${block.name.slice(0, 12)}  ${(name || '(无 name 字段)').padEnd(28)} ${String(block.content.length).padStart(9)} B ${note}${mark}`,
  );
}

if (keyword) {
  const hits = chars.filter((b) => {
    let t = b.content.toString('utf8');
    if (!t.includes(keyword)) {
      try {
        t = zlib.gunzipSync(b.content).toString('utf8');
      } catch {
        return false;
      }
    }
    return t.includes(keyword);
  });
  console.log('');
  console.log(`关键词 "${keyword}" 命中 ${hits.length} 个角色块`);
}
