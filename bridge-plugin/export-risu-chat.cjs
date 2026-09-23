'use strict';
/**
 * 拉取指定角色的某个 chat 存档，导出为 JSON。
 * 用法: node export-risu-chat.cjs <remotes/key> --out=/tmp/chat.json [--save-dir=/app/save]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith('--'));
const out = (args.find((a) => a.startsWith('--out=')) || '--out=/tmp/chat.json').slice(6);
const saveDir = (args.find((a) => a.startsWith('--save-dir=')) || '').slice('--save-dir='.length) || '/app/save';

const file = path.join(saveDir, Buffer.from(key, 'utf8').toString('hex'));
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
const report = {
  name: json.name,
  chatPage: json.chatPage,
  messageCount: (json.chats?.[json.chatPage]?.message || []).length,
};
fs.writeFileSync(out, JSON.stringify(json.chats[json.chatPage].message, null, 2));
console.log(JSON.stringify({ ...report, exported: out, bytes: fs.statSync(out).size }, null, 2));
