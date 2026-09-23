'use strict';
/**
 * 只更新「已存在」的插件正文（保持 enabled 与用户已填参数），
 * 用于修改插件后重新部署。相比 install-risu-v2-plugin.cjs 少了首次插入分支。
 * 用法: node update-risu-plugin.cjs --name risu-bridge --script /tmp/p.js [--save-dir /app/save]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const magic = Buffer.from('RISUSAVE\0', 'utf8');
const args = process.argv.slice(2);
const name = (args.find((a) => a.startsWith('--name=')) || '').slice(7);
const scriptPath = (args.find((a) => a.startsWith('--script=')) || '').slice(9);
const saveDir = (args.find((a) => a.startsWith('--save-dir=')) || '').slice('--save-dir='.length) || '/app/save';
if (!name || !scriptPath) {
  console.error('用法: node update-risu-plugin.cjs --name=risu-bridge --script=/tmp/p.js');
  process.exit(2);
}

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
    const blockName = Buffer.from(data.subarray(offset, offset + nameLength)).toString('utf8');
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
    out.push({ type, compressed, name: blockName, content });
  }
  return out;
}

function encode(block) {
  const nameBuf = Buffer.from(block.name, 'utf8');
  const raw = Buffer.from(block.content, 'utf8');
  const payload = block.compressed ? zlib.gzipSync(raw) : raw;
  const header = Buffer.alloc(3 + nameBuf.length + 4);
  header[0] = block.type;
  header[1] = block.compressed ? 1 : 0;
  header[2] = nameBuf.length;
  nameBuf.copy(header, 3);
  header.writeUInt32LE(payload.length, 3 + nameBuf.length);
  return Buffer.concat([header, payload]);
}

const dbPath = storagePath(saveDir, 'database/database.bin');
const dbData = fs.readFileSync(dbPath);
const backupKey = `database/dbbackup-${Math.floor(Date.now() / 100)}.bin`;
fs.writeFileSync(storagePath(saveDir, backupKey), dbData);

const blocks = parse(dbData);
const pluginBlock = blocks.find((b) => b.type === 9 && b.name === 'plugins');
if (!pluginBlock) throw new Error('没有 plugins 块');
const plugins = JSON.parse(pluginBlock.content);
const index = plugins.findIndex((p) => p && p.name === name);
if (index < 0) throw new Error(`没有名为 ${name} 的插件`);

const before = plugins[index];
const script = fs.readFileSync(scriptPath, 'utf8');
plugins[index] = { ...before, script };
pluginBlock.content = JSON.stringify(plugins);
const next = Buffer.concat([magic, ...blocks.map(encode)]);
fs.writeFileSync(dbPath, next);

console.log(JSON.stringify({
  ok: true,
  backupKey,
  name,
  version: before.version,
  enabled: before.enabled,
  scriptBytesBefore: (before.script || '').length,
  scriptBytesAfter: script.length,
  bytesBefore: dbData.length,
  bytesAfter: next.length,
}, null, 2));
