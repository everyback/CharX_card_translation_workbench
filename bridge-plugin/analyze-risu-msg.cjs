'use strict';
/**
 * 分析某条消息的 data：判定它里面嵌的是哪一代预设产物。
 * 用法: node analyze-risu-msg.cjs <remotes/key> [--chat=0] [--index=9] [--show=500]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith('--'));
const chatIndex = Number((args.find((a) => a.startsWith('--chat=')) || '--chat=0').slice(7));
const msgIndex = Number((args.find((a) => a.startsWith('--index=')) || '--index=0').slice(8));
const show = Number((args.find((a) => a.startsWith('--show=')) || '--show=600').slice(7));
const saveDir = (args.find((a) => a.startsWith('--save-dir=')) || '').slice('--save-dir='.length) || '/app/save';

const file = path.join(saveDir, Buffer.from(key, 'utf8').toString('hex'));
const json = JSON.parse(fs.readFileSync(file, 'utf8'));
const chat = (json.chats || [])[chatIndex];
if (!chat) {
  console.error('没有该聊天存档');
  process.exit(1);
}
const msg = (chat.message || [])[msgIndex];
if (!msg) {
  console.error('没有该消息');
  process.exit(1);
}

const data = String(msg.data || '');
console.log(`消息 [${msgIndex}] role=${msg.role} 共 ${data.length} 字符`);
console.log('');

const marks = {
  '老 ST 折叠（onclick=toggleCollapsible）': 'toggleCollapsible',
  '老 ST 脚本（send_textarea）': 'send_textarea',
  '老 ST 脚本（postMessage resizeIframe）': 'resizeIframe',
  '<script> 标签': '<script',
  'onclick 属性': 'onclick=',
  '裸 <style> 块': '<style>',
  'risu-style（已转换）': '<risu-style>',
  'risu-btn（Lua 路线）': 'risu-btn',
  'data-risu-bridge（桥接路线）': 'data-risu-bridge',
  'era-actions-container（FATE 面板）': 'era-actions-container',
  'aether-collapsible（折叠面板）': 'aether-collapsible',
  'details/summary（已改写折叠）': '<details',
  '<行动选项> 原始区块': '<行动选项>',
  '```html 代码围栏': '```html',
};
for (const [label, needle] of Object.entries(marks)) {
  const n = data.split(needle).length - 1;
  if (n) console.log(`  ${String(n).padStart(3)} ×  ${label}`);
}
console.log('');
console.log(`=== 前 ${show} 字符 ===`);
console.log(data.slice(0, show));
console.log('');
console.log(`=== 后 ${show} 字符 ===`);
console.log(data.slice(-show));
