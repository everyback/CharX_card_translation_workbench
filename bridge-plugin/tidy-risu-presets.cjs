#!/usr/bin/env node
'use strict';

/**
 * 整理 RisuAI 预设列表：重命名一条、删除若干条。只动 preset 块。
 *
 * 用法:
 *   node tidy-risu-presets.cjs --rename="旧名=>新名" --delete="名字A" --delete="名字B" [--save-dir /app/save]
 *
 * 安全措施：
 *   - 写盘前先把原始字节存成 dbbackup-*.bin
 *   - 删除是按**精确名字**匹配，不做前缀/包含匹配
 *   - 任何一条匹配不到（改名源或待删项）就整体放弃，不写盘
 *   - 改完打印最终列表，便于核对
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const magic = Buffer.from('RISUSAVE\0', 'utf8');
const args = process.argv.slice(2);

const renameArg = (args.find((a) => a.startsWith('--rename=')) || '').slice(9);
const deleteArgs = args.filter((a) => a.startsWith('--delete=')).map((a) => a.slice(9));
const saveDir = (args.find((a) => a.startsWith('--save-dir=')) || '').slice('--save-dir='.length) || '/app/save';

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
        /* 原样 */
      }
    }
    out.push({ type, compressed, name, content });
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
const blocks = parse(dbData);
const presetBlock = blocks.find((b) => b.type === 4);
if (!presetBlock) throw new Error('没有 preset 块');

let presets = JSON.parse(presetBlock.content);

// --- 先做全部校验，任何一项不满足就退出，不写盘 ---
const problems = [];
let renameFrom = '';
let renameTo = '';
if (renameArg) {
  const parts = renameArg.split('=>');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('--rename 格式应为 "旧名=>新名"');
  renameFrom = parts[0];
  renameTo = parts[1];
  if (!presets.some((p) => p.name === renameFrom)) problems.push(`找不到要改名的预设：“${renameFrom}”`);
  if (presets.some((p) => p.name === renameTo)) problems.push(`目标名字已存在：“${renameTo}”`);
}
for (const name of deleteArgs) {
  if (!presets.some((p) => p.name === name)) problems.push(`找不到要删除的预设：“${name}”`);
}
if (problems.length) {
  console.error('未做任何修改：');
  problems.forEach((p) => console.error('  - ' + p));
  process.exit(1);
}

// --- 备份 ---
const backupKey = `database/dbbackup-${Math.floor(Date.now() / 100)}.bin`;
fs.writeFileSync(storagePath(saveDir, backupKey), dbData);

// --- 执行 ---
const before = presets.map((p) => p.name);
if (renameFrom) {
  presets = presets.map((p) => (p.name === renameFrom ? { ...p, name: renameTo } : p));
}
const deleteSet = new Set(deleteArgs);
presets = presets.filter((p) => !deleteSet.has(p.name));

presetBlock.content = JSON.stringify(presets);
const next = Buffer.concat([magic, ...blocks.map(encode)]);
fs.writeFileSync(dbPath, next);

console.log(JSON.stringify({
  ok: true,
  backupKey,
  renamed: renameFrom ? `${renameFrom} => ${renameTo}` : null,
  deleted: deleteArgs,
  before,
  after: presets.map((p) => p.name),
  countBefore: before.length,
  countAfter: presets.length,
  bytesBefore: dbData.length,
  bytesAfter: next.length,
}, null, 2));
