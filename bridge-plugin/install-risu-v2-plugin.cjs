#!/usr/bin/env node
'use strict';

/**
 * 安装 **API 2.1** 版 RisuAI 插件。
 *
 * 仓库里已有的 install-risu-v3-plugin.cjs 只接受 //@api 3.0，而桥接插件必须是
 * 2.1：3.0 插件跑在独立 iframe 沙箱里，拿不到宿主 DOM；2.1 插件在主上下文执行，
 * 且 checkCodeSafety 会把 document 重写成 safeDocument（真实页面 DOM 的包装）。
 * 所以另外写这一个，其余逻辑与既有安装器一致。
 *
 * 用法:
 *   node install-risu-v2-plugin.cjs --plugin /path/risu-bridge.plugin.js [--save-dir /app/save]
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RisuSaveType = {
  ROOT: 1,
  PLUGINS: 9,
};

const magicRisuSaveHeader = Buffer.from('RISUSAVE\0', 'utf8');

function parseArgs(argv) {
  const args = { saveDir: process.env.RISU_SAVE_DIR || '/app/save', plugin: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--plugin') args.plugin = argv[++i];
    else if (arg === '--save-dir') args.saveDir = argv[++i];
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node install-risu-v2-plugin.cjs --plugin /path/plugin.js [--save-dir /app/save]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.plugin) throw new Error('Missing --plugin /path/plugin.js');
  return args;
}

function storagePath(saveDir, key) {
  return path.join(saveDir, Buffer.from(key, 'utf8').toString('hex'));
}

function checkModern(data) {
  return data.subarray(0, magicRisuSaveHeader.length).equals(magicRisuSaveHeader);
}

function decodePayload(payload, compression) {
  const data = compression ? zlib.gunzipSync(payload) : payload;
  return Buffer.from(data).toString('utf8');
}

function encodePayload(content, compression) {
  const data = Buffer.from(content || '', 'utf8');
  return compression ? zlib.gzipSync(data) : data;
}

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
  if (name.length > 255) throw new Error(`Block name too long: ${block.name}`);
  const payload = encodePayload(block.content, block.compression);
  const header = Buffer.alloc(3 + name.length + 4);
  header[0] = block.type;
  header[1] = block.compression ? 1 : 0;
  header[2] = name.length;
  name.copy(header, 3);
  header.writeUInt32LE(payload.length, 3 + name.length);
  return Buffer.concat([header, payload]);
}

function encodeModern(blocks) {
  return Buffer.concat([magicRisuSaveHeader, ...blocks.map(encodeModernBlock)]);
}

function headerValue(line, key) {
  return line.startsWith(key) ? line.slice(key.length).trim() : null;
}

/** 解析插件头。与前端 loadPlugins 的字段保持一致。 */
function parsePlugin(code) {
  const args = {};
  const realArg = {};
  const argMeta = {};
  const customLink = [];
  let name = '';
  let displayName = '';
  let apiVersion = '';
  let versionOfPlugin = '';

  for (const rawLine of code.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    const gotName = headerValue(line, '//@name');
    const gotDisplay = headerValue(line, '//@display-name');
    const gotApi = headerValue(line, '//@api');
    const gotVersion = headerValue(line, '//@version');
    const gotLink = headerValue(line, '//@link');

    if (gotName !== null) name = gotName;
    else if (gotDisplay !== null) displayName = gotDisplay;
    else if (gotApi !== null) apiVersion = gotApi.split(/\s+/)[0] || '';
    else if (gotVersion !== null) versionOfPlugin = gotVersion;
    else if (gotLink !== null) {
      const [link, ...hover] = gotLink.split(/\s+/);
      if (link) customLink.push({ link, hoverText: hover.join(' ') || undefined });
    } else if (line.startsWith('//@arg') || line.startsWith('//@risu-arg')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 3 && (parts[2] === 'int' || parts[2] === 'string')) {
        args[parts[1]] = parts[2];
        realArg[parts[1]] = parts[2] === 'int' ? 0 : '';
        const description = parts.slice(3).join(' ').trim();
        if (description) argMeta[parts[1]] = { description };
      }
    }
  }

  if (!name) throw new Error('插件缺少 //@name 头');
  if (apiVersion !== '2.1') {
    throw new Error(`本安装器只装 API 2.1 插件，当前是 "${apiVersion || '未声明'}"。`
      + '（3.0 插件在 iframe 沙箱里，拿不到宿主 DOM）');
  }

  return {
    name,
    script: code.replace(/^\uFEFF/, ''),
    realArg,
    arguments: args,
    displayName: displayName || name,
    version: '2.1',
    customLink,
    argMeta,
    versionOfPlugin,
    updateURL: '',
    allowedIPC: [],
    enabled: true,
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const plugin = parsePlugin(fs.readFileSync(args.plugin, 'utf8'));
  const dbPath = storagePath(args.saveDir, 'database/database.bin');
  const dbData = fs.readFileSync(dbPath);

  if (!checkModern(dbData)) throw new Error('只支持现代 RISUSAVE 数据库格式。');

  const backupKey = `database/dbbackup-${Math.floor(Date.now() / 100)}.bin`;
  fs.writeFileSync(storagePath(args.saveDir, backupKey), dbData);

  const blocks = parseModernBlocks(dbData);
  let pluginsBlock = blocks.find((b) => b.type === RisuSaveType.PLUGINS && b.name === 'plugins');
  let addedBlock = false;
  if (!pluginsBlock) {
    pluginsBlock = { type: RisuSaveType.PLUGINS, compression: false, name: 'plugins', content: '[]' };
    blocks.push(pluginsBlock);
    addedBlock = true;
    const root = blocks.find((b) => b.type === RisuSaveType.ROOT && b.name === 'root');
    if (root) {
      const rootData = JSON.parse(root.content);
      rootData.__directory = Array.isArray(rootData.__directory) ? rootData.__directory : [];
      if (!rootData.__directory.includes('plugins')) rootData.__directory.push('plugins');
      root.content = JSON.stringify(rootData);
    }
  }

  const plugins = JSON.parse(pluginsBlock.content || '[]');
  const existingIndex = plugins.findIndex((item) => item && item.name === plugin.name);
  const existing = existingIndex >= 0 ? plugins[existingIndex] : null;
  // 保留用户已经填过的插件参数，重装不覆盖
  if (existing && existing.realArg) plugin.realArg = { ...plugin.realArg, ...existing.realArg };
  if (existingIndex >= 0) plugins[existingIndex] = plugin;
  else plugins.push(plugin);
  pluginsBlock.content = JSON.stringify(plugins);

  const nextDbData = encodeModern(blocks);
  fs.writeFileSync(dbPath, nextDbData);

  console.log(JSON.stringify({
    ok: true,
    backupKey,
    plugin: {
      name: plugin.name,
      displayName: plugin.displayName,
      version: plugin.version,
      versionOfPlugin: plugin.versionOfPlugin,
      action: existingIndex >= 0 ? 'updated' : 'inserted',
      addedPluginsBlock: addedBlock,
    },
    pluginCount: plugins.length,
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
