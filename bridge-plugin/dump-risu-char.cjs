'use strict';
/** 打印卡的对话相关字段。用法: node dump-risu-char.cjs <remotes/key> [--what=all|first|greet|chats|lore|example] */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const key = args.find((a) => !a.startsWith('--'));
const what = (args.find((a) => a.startsWith('--what=')) || '--what=all').slice(7);
const saveDir = (args.find((a) => a.startsWith('--save-dir=')) || '').slice('--save-dir='.length) || '/app/save';
const limit = Number((args.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 12;

const file = path.join(saveDir, Buffer.from(key, 'utf8').toString('hex'));
const json = JSON.parse(fs.readFileSync(file, 'utf8'));

const show = (title, text, max = 1200) => {
  console.log(`=== ${title} ===`);
  if (text === undefined || text === null || text === '') {
    console.log('(空)');
    console.log('');
    return;
  }
  const s = String(text);
  console.log(s.length > max ? s.slice(0, max) + `\n…（共 ${s.length} 字符，已截断）` : s);
  console.log('');
};

if (what === 'all' || what === 'first') {
  show('firstMessage', json.firstMessage, 4000);
  json.alternateGreetings?.forEach((g, i) => show(`alternateGreetings[${i}]`, g, 2000));
  show('exampleMessage', json.exampleMessage, 1500);
  console.log('firstMsgIndex:', json.firstMsgIndex, '| chatPage:', json.chatPage, '| defaultVariables:', JSON.stringify(json.defaultVariables));
  console.log('');
}

if (what === 'all' || what === 'chats') {
  const chats = json.chats || [];
  console.log(`=== chats: ${chats.length} 个存档 ===`);
  chats.forEach((chat, ci) => {
    const msgs = chat.message || [];
    console.log(`  [${ci}] 消息 ${msgs.length} 条 | fmIndex=${chat.fmIndex} | 键=${Object.keys(chat).join(',')}`);
    msgs.slice(0, limit).forEach((m, mi) => {
      const d = String(m.data || '');
      console.log(`      [${mi}] ${m.role} ${d.length} 字符 :: ${JSON.stringify(d.slice(0, 90))}`);
    });
  });
  console.log('');
}

if (what === 'all' || what === 'lore') {
  const lore = json.globalLore || [];
  console.log(`=== globalLore: ${lore.length} 条 ===`);
  lore.slice(0, limit).forEach((entry, i) => {
    console.log(`  [${i}] keys=${JSON.stringify(entry.key || entry.keys)} | ${String(entry.content || '').length} 字符`);
  });
  console.log('');
}

if (what === 'all' || what === 'script') {
  console.log(`=== customscript: ${(json.customscript || []).length} 条正则 ===`);
  (json.customscript || []).slice(0, limit).forEach((s, i) => {
    console.log(`  [${i}] ${s.type} | ${String(s.comment || '').slice(0, 40)} | out ${String(s.out || '').length} 字符`);
  });
  console.log(`=== triggerscript: ${(json.triggerscript || []).length} 条触发器 ===`);
  (json.triggerscript || []).forEach((t, i) => {
    console.log(`  [${i}] ${t.comment || ''} | effect=${(t.effect || []).map((e) => e.type).join(',')}`);
  });
}
