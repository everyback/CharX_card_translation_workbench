#!/usr/bin/env node
'use strict';

/**
 * 把一份预设 JSON 写进 RisuAI 的 database.bin。
 *
 *   --preset 预设 JSON（单个预设对象）
 *   --name   目标预设名；同名则原地替换，不存在则追加
 *
 * 只动 preset 块，其余块原样保留；写前先把原始字节存成 dbbackup-*.bin。
 * 与 install-risu-v2-plugin.cjs 共用 RISUSAVE 块格式。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RisuSaveType = { ROOT: 1, PRESET: 4 };
const magicRisuSaveHeader = Buffer.from('RISUSAVE\0', 'utf8');

function parseArgs(argv) {
  const args = { saveDir: process.env.RISU_SAVE_DIR || '/app/save', preset: '', name: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--preset') args.preset = argv[++i];
    else if (arg === '--name') args.name = argv[++i];
    else if (arg === '--save-dir') args.saveDir = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node install-risu-preset.cjs --preset preset.json [--name 预设名] [--save-dir /app/save]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.preset) throw new Error('Missing --preset preset.json');
  return args;
}

const storagePath = (saveDir, key) => path.join(saveDir, Buffer.from(key, 'utf8').toString('hex'));
const checkModern = (data) => data.subarray(0, magicRisuSaveHeader.length).equals(magicRisuSaveHeader);
const decodePayload = (payload, compression) =>
  Buffer.from(compression ? zlib.gunzipSync(payload) : payload).toString('utf8');
const encodePayload = (content, compression) => {
  const data = Buffer.from(content || '', 'utf8');
  return compression ? zlib.gzipSync(data) : data;
};

function parseModernBlocks(data) {
  let offset = magicRisuSaveHeader.length;
  const blocks = [];
  while (offset < data.length) {
    const type = data[offset];
    const compression = data[offset + 1] === 1;
    offset += 2;
    const nameLength = data[offset];
    offset += 1;
    const name = Buffer.from(data.subarray(offset, offset + nameLength)).toString('utf8');
    offset += nameLength;
    const length = Buffer.from(data.subarray(offset, offset + 4)).readUInt32LE(0);
    offset += 4;
    const payload = Buffer.from(data.subarray(offset, offset + length));
    offset += length;
    blocks.push({ type, compression, name, content: decodePayload(payload, compression) });
  }
  return blocks;
}

function encodeModernBlock(block) {
  const name = Buffer.from(block.name, 'utf8');
  const payload = encodePayload(block.content, block.compression);
  const header = Buffer.alloc(3 + name.length + 4);
  header[0] = block.type;
  header[1] = block.compression ? 1 : 0;
  header[2] = name.length;
  name.copy(header, 3);
  header.writeUInt32LE(payload.length, 3 + name.length);
  return Buffer.concat([header, payload]);
}

const encodeModern = (blocks) =>
  Buffer.concat([magicRisuSaveHeader, ...blocks.map(encodeModernBlock)]);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const incoming = JSON.parse(fs.readFileSync(args.preset, 'utf8'));
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    throw new Error('预设 JSON 必须是单个预设对象。');
  }
  const targetName = args.name || incoming.name;
  if (!targetName) throw new Error('无法确定预设名：JSON 里没有 name，也没给 --name。');

  const dbPath = storagePath(args.saveDir, 'database/database.bin');
  const dbData = fs.readFileSync(dbPath);
  if (!checkModern(dbData)) throw new Error('只支持现代 RISUSAVE 数据库格式。');

  const backupKey = `database/dbbackup-${Math.floor(Date.now() / 100)}.bin`;
  fs.writeFileSync(storagePath(args.saveDir, backupKey), dbData);

  const blocks = parseModernBlocks(dbData);
  const presetBlock = blocks.find((b) => b.type === RisuSaveType.PRESET);
  if (!presetBlock) throw new Error('数据库里没有 preset 块。');

  const presets = JSON.parse(presetBlock.content || '[]');
  if (!Array.isArray(presets)) throw new Error('preset 块不是数组。');

  // 以“名字 + 正则条数”双重判据定位，避免同名不同版本误判
  const incomingRegex = Array.isArray(incoming.regex) ? incoming.regex.length : 0;
  let index = presets.findIndex((p) => p && p.name === targetName);
  let action = index >= 0 ? 'replaced' : 'appended';
  if (index >= 0) {
    const before = presets[index];
    const beforeRegex = Array.isArray(before.regex) ? before.regex.length : 0;
    console.log(`找到同名预设 [${index}]：原 regex ${beforeRegex} 条 → 新 ${incomingRegex} 条`);
    presets[index] = { ...before, ...incoming, name: targetName };
  } else {
    presets.push({ ...incoming, name: targetName });
    index = presets.length - 1;
    action = 'appended';
  }

  presetBlock.content = JSON.stringify(presets);
  const nextDbData = encodeModern(blocks);
  fs.writeFileSync(dbPath, nextDbData);

  console.log(JSON.stringify({
    ok: true,
    backupKey,
    action,
    index,
    presetName: targetName,
    regexCount: incomingRegex,
    totalPresets: presets.length,
    databaseBytesBefore: dbData.length,
    databaseBytesAfter: nextDbData.length,
  }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  process.exitCode = 1;
}
