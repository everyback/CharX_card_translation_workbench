'use strict';
/**
 * 调查 RisuAI 卡自身脚本用的是什么机制：RisuAI 原生，还是酒馆残留。
 * 用法: node inspect-card-scripts.cjs [--save-dir=/app/save] [--limit=200]
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const saveDir = (args.find((a) => a.startsWith('--save-dir=')) || '').slice('--save-dir='.length) || '/app/save';

const NATIVE = ['risu-btn', 'risu-trigger', 'data-risu-', 'x-risu-', 'risu-ctrl'];
const ST_REMNANT = ['send_textarea', 'window.parent', 'window.top', 'SillyTavern', 'postMessage', 'resizeIframe', 'toggleCollapsible', '#send_butt', 'getContext'];

const files = fs.readdirSync(saveDir);
let cardCount = 0;
const nativeHits = {};
const remnantHits = {};
let withCustomscript = 0;
let withTrigger = 0;
const remnantCards = [];

for (const file of files) {
  if (!/^[0-9a-f]+$/.test(file)) continue;
  let key;
  try {
    key = Buffer.from(file, 'hex').toString('utf8');
  } catch {
    continue;
  }
  if (!key.startsWith('remotes/') || key.endsWith('.meta')) continue;
  let json;
  try {
    json = JSON.parse(fs.readFileSync(path.join(saveDir, file), 'utf8'));
  } catch {
    continue;
  }
  cardCount += 1;
  const custom = Array.isArray(json.customscript) ? json.customscript : [];
  const triggers = Array.isArray(json.triggerscript) ? json.triggerscript : [];
  if (custom.length) withCustomscript += 1;
  if (triggers.length) withTrigger += 1;

  // 只看脚本承载字段，避免把正文/世界书里的文字算进来
  const bodies = [
    ...custom.map((rule) => `${rule.in || ''}\n${rule.out || ''}`),
    ...triggers.map((trigger) => JSON.stringify(trigger.effect || trigger)),
    String(json.backgroundHTML || ''),
  ].join('\n');

  const nativeFound = NATIVE.filter((n) => bodies.includes(n));
  const remnantFound = ST_REMNANT.filter((n) => bodies.includes(n));
  for (const n of nativeFound) nativeHits[n] = (nativeHits[n] || 0) + 1;
  for (const n of remnantFound) remnantHits[n] = (remnantHits[n] || 0) + 1;
  if (remnantFound.length) {
    remnantCards.push({ name: json.name, remnantFound, customCount: custom.length, triggerCount: triggers.length });
  }
}

console.log('扫描卡数:', cardCount);
console.log('含 customscript:', withCustomscript, '| 含 triggerscript:', withTrigger);
console.log('');
console.log('=== 脚本里出现的 RisuAI 原生机制（卡数）===');
for (const [k, v] of Object.entries(nativeHits).sort((a, b) => b[1] - a[1])) console.log('  ' + String(v).padStart(3), k);
if (!Object.keys(nativeHits).length) console.log('  （无）');
console.log('');
console.log('=== 脚本里出现的酒馆残留（卡数）===');
for (const [k, v] of Object.entries(remnantHits).sort((a, b) => b[1] - a[1])) console.log('  ' + String(v).padStart(3), k);
if (!Object.keys(remnantHits).length) console.log('  （无）');
console.log('');
console.log('=== 含酒馆残留的卡 ===');
for (const card of remnantCards.slice(0, 20)) {
  console.log(`  ${card.name} | customscript=${card.customCount} trigger=${card.triggerCount} | ${card.remnantFound.join(', ')}`);
}
