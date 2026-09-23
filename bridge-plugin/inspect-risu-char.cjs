'use strict';
/**
 * 解析一个 RisuAI remotes/*.local.bin 角色文件，打印结构概览。
 * 用法: node inspect-risu-char.cjs <hex文件名或remotes/key> [--save-dir=/app/save]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const magic = Buffer.from('RISUSAVE\0', 'utf8');
const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
const saveDir = (args.find((a) => a.startsWith('--save-dir=')) || '').slice('--save-dir='.length) || '/app/save';

function storagePath(key) {
  return path.join(saveDir, Buffer.from(key, 'utf8').toString('hex'));
}

function parseBlocks(data) {
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
        /* 原样 */
      }
    }
    out.push({ type, name, content, wasCompressed: compressed });
  }
  return out;
}

let filePath = target;
if (!target) {
  console.error('用法: node inspect-risu-char.cjs <hex文件名>');
  process.exit(2);
}
if (!fs.existsSync(filePath)) filePath = storagePath(target);
const raw = fs.readFileSync(filePath);
console.log('文件:', filePath, '字节:', raw.length);
console.log('RISUSAVE 头:', raw.subarray(0, magic.length).equals(magic));
console.log('');

// remotes 文件可能是 RISUSAVE 容器，也可能直接是 JSON
if (raw.subarray(0, magic.length).equals(magic)) {
  const blocks = parseBlocks(raw);
  console.log('块数:', blocks.length);
  for (const b of blocks) {
    console.log(`  type=${b.type} name=${b.name} 字节=${b.content.length} 压缩=${b.wasCompressed}`);
  }
} else {
  let text = raw.toString('utf8');
  let parseable = true;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {
    parseable = false;
    try {
      text = zlib.gunzipSync(raw).toString('utf8');
      json = JSON.parse(text);
      parseable = true;
      console.log('(gzip 解压后是 JSON)');
    } catch (e2) {
      console.log('既不是 RISUSAVE 也不是 JSON:', String(e.message).slice(0, 80));
    }
  }
  if (parseable && json) {
    console.log('顶层键:', Object.keys(json).join(', '));
    const show = (key, value) => {
      if (typeof value === 'string') console.log(`  ${key}: ${value.length} 字符`);
      else if (Array.isArray(value)) console.log(`  ${key}: 数组(${value.length})`);
      else if (value && typeof value === 'object') console.log(`  ${key}: 对象(${Object.keys(value).join(',')})`);
      else console.log(`  ${key}: ${JSON.stringify(value)}`);
    };
    for (const [k, v] of Object.entries(json)) {
      if (['data', 'chat', 'chats', 'message'].includes(k)) continue;
      show(k, v);
    }
    // 聊天/消息部分单独看
    for (const key of ['chat', 'chats', 'message', 'data']) {
      const v = json[key];
      if (!v) continue;
      console.log('');
      if (Array.isArray(v)) {
        console.log(`${key}: 数组(${v.length})`);
        v.slice(0, 3).forEach((item, i) => {
          if (typeof item === 'string') console.log(`   [${i}] 字符串 ${item.length} 字符: ${JSON.stringify(item.slice(0, 120))}`);
          else console.log(`   [${i}] 键=${Object.keys(item || {}).join(',')}`);
        });
      } else if (typeof v === 'object') {
        console.log(`${key}: 对象 键=${Object.keys(v).join(',')}`);
        if (Array.isArray(v.message)) {
          console.log(`   message: 数组(${v.message.length})`);
          v.message.slice(0, 4).forEach((m, i) => {
            console.log(`   [${i}] role=${m.role} data=${(m.data || '').length} 字符: ${JSON.stringify(String(m.data || '').slice(0, 100))}`);
          });
        }
      }
    }
  }
}
