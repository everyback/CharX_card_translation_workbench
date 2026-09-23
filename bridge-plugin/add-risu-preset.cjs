#!/usr/bin/env node
'use strict';

/**
 * 把一份预设 JSON **追加**为一条新预设（不覆盖同名条目），用于绕开
 * 「客户端内存里还留着旧预设」的情况：重载后直接选新名字那条即可。
 *
 * 用法:
 *   node add-risu-preset.cjs --preset p.json --name "新名字" [--save-dir /app/save]
 *
 * 若新名字已存在，则原地替换那一条（保持幂等，重复执行不会堆一堆副本）。
 * 写盘前先把原始字节存成 dbbackup-*.bin。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RisuSaveType = { PRESET: 4 };
const magic = Buffer.from('RISUSAVE\0', 'utf8');

function parseArgs(argv) {
  const args = { saveDir: process.env.RISU_SAVE_DIR || '/app/save', preset: '', name: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--preset') args.preset = argv[++i];
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--save-dir') args.saveDir = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('用法: node add-risu-preset.cjs --preset p.json --name "新名字" [--save-dir /app/save]');
      process.exit(0);
    } else throw new Error(`未知参数: ${a}`);
  }
  if (!args.preset) throw new Error('缺少 --preset');
  if (!args.name) throw new Error('缺少 --name');
  return args;
}

const storagePath = (dir, key) => path.join(dir, Buffer.from(key, 'utf8').toString('hex'));

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
    out.push({ type, compressed, name, content });
  }
  return out;
}

function encodeBlock(block) {
  const name = Buffer.from(block.name, 'utf8');
  const payloadRaw = Buffer.from(block.content, 'utf8');
  const payload = block.compressed ? zlib.gzipSync(payloadRaw) : payloadRaw;
  const header = Buffer.alloc(3 + name.length + 4);
  header[0] = block.type;
  header[1] = block.compressed ? 1 : 0;
  header[2] = name.length;
  name.copy(header, 3);
  header.writeUInt32LE(payload.length, 3 + name.length);
  return Buffer.concat([header, payload]);
}

const args = parseArgs(process.argv.slice(2));
const incoming = JSON.parse(fs.readFileSync(args.preset, 'utf8'));
const dbPath = storagePath(args.saveDir, 'database/database.bin');
const dbData = fs.readFileSync(dbPath);

const backupKey = `database/dbbackup-${Math.floor(Date.now() / 100)}.bin`;
fs.writeFileSync(storagePath(args.saveDir, backupKey), dbData);

const blocks = parseBlocks(dbData);
const presetBlock = blocks.find((b) => b.type === RisuSaveType.PRESET);
if (!presetBlock) throw new Error('数据库里没有 preset 块');

const presets = JSON.parse(presetBlock.content);
if (!Array.isArray(presets)) throw new Error('preset 块不是数组');

const clean = { ...incoming, name: args.name };
const existingIndex = presets.findIndex((p) => p && p.name === args.name);
let action;
if (existingIndex >= 0) {
  presets[existingIndex] = clean;
  action = 'replaced';
} else {
  presets.push(clean);
  action = 'appended';
}

presetBlock.content = JSON.stringify(presets);
const next = Buffer.concat([
  magic,
  ...blocks.map((b) => encodeBlock(b)),
]);
fs.writeFileSync(dbPath, next);

const regexBridgeAttrs = (clean.regex || []).reduce(
  (sum, r) => sum + String(r.out || '').split('data-risu-bridge=').length - 1,
  0,
);

console.log(JSON.stringify({
  ok: true,
  backupKey,
  action,
  index: presets.findIndex((p) => p.name === args.name),
  name: args.name,
  regexCount: (clean.regex || []).length,
  promptTemplateCount: (clean.promptTemplate || []).length,
  bridgeAttributes: regexBridgeAttrs,
  totalPresets: presets.length,
  allNames: presets.map((p) => p.name),
  bytesBefore: dbData.length,
  bytesAfter: next.length,
}, null, 2));
