import fs from 'node:fs'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('usage: node patch-list-local-cache.mjs <input.js> <output.js>')
}

const MARKER = 'keysCacheStore'
const GETITEM_ANCHOR = 'async getItem(e){let t=await this.getItemCached(e);'
const KEYS_ANCHOR = 'async keys(){if(await this.checkAuth(),this.keysCache&&Date.now()-this.keysCacheAt<300*1e3)return this.keysCache;'

const MEMBERS =
  'keysCacheStore=caches.open(`risu-list-v1`);' +
  // 从持久化的列表里判断某个路径是否存在：这能替掉大量"先 keys() 再 includes"的调用
  'async localListHas(e){' +
  'try{let t=await this.readListCache();if(!t)return null;return t.list.includes(e)?true:null}catch{return null}}' +
  'async readListCache(){' +
  'try{let e=await this.keysCacheStore;' +
  'let t=await e.match(new Request(`/__risu-list/keys.json`));' +
  'if(!t)return null;' +
  'let n=await t.json();' +
  'return n&&Array.isArray(n.list)&&n.list.length>0?n:null' +
  '}catch{return null}}' +
  'async writeListCache(){' +
  'try{let e=this.keysCache;' +
  'if(!Array.isArray(e)||e.length===0)return;' +
  'let t=await this.keysCacheStore;' +
  'await t.put(new Request(`/__risu-list/keys.json`),' +
  'new Response(JSON.stringify({savedAt:Date.now(),list:e}),' +
  '{headers:{"content-type":`application/json`}}))' +
  '}catch{}}'

let source = fs.readFileSync(inputPath, 'utf8')

if (source.includes(MARKER)) {
  fs.writeFileSync(outputPath, source)
  console.log(`already patched, no change: ${inputPath} -> ${outputPath}`)
  process.exit(0)
}

if (!source.includes('assetLocalCache')) {
  throw new Error('asset cache patch not present — apply patch-read-cache.mjs first')
}

const notes = []

// ---------- 1) 成员方法 ----------
const ci = source.indexOf('async checkAuth(){')
if (ci === -1) throw new Error('anchor not found: async checkAuth(){')
if (source.indexOf('async checkAuth(){', ci + 17) !== -1) throw new Error('anchor is not unique: async checkAuth(){')
source = source.slice(0, ci) + MEMBERS + source.slice(ci)
notes.push('keysCacheStore + localListHas/readListCache/writeListCache inserted')

// ---------- 2) getItem：本地列表说"这个路径不存在"就直接返回 null，不用发请求 ==========
const gi = source.indexOf(GETITEM_ANCHOR)
if (gi === -1) throw new Error('anchor not found: patched NodeStorage.getItem')
if (source.indexOf(GETITEM_ANCHOR, gi + GETITEM_ANCHOR.length) !== -1) throw new Error('anchor is not unique: patched NodeStorage.getItem')
source =
  source.slice(0, gi) +
  'async getItem(e){' +
  'if(e.startsWith(`assets/`)&&await this.localListHas(e)===null)return null;' +
  'let t=await this.getItemCached(e);' +
  source.slice(gi + 'async getItem(e){let t=await this.getItemCached(e);'.length)
notes.push('getItem: missing-asset short circuit via local list')

// ---------- 3) keys()：包装一层持久化 ----------
// 注意：bundle 里 `async keys(){` 出现多次（NodeStorage / AccountStorage / OPFS / 插件包装），
// 必须用 NodeStorage 特有的形式作锚点。
const ki = source.indexOf(KEYS_ANCHOR)
if (ki === -1) throw new Error('anchor not found: NodeStorage keys()')
if (source.indexOf(KEYS_ANCHOR, ki + KEYS_ANCHOR.length) !== -1) throw new Error('anchor is not unique: NodeStorage keys()')
source =
  source.slice(0, ki) +
  'async keys(){' +
  'if(this.keysCache&&Date.now()-this.keysCacheAt<300*1e3)return this.keysCache;' +
  'return await this.keysUncached()}' +
  'async keysUncached(){' +
  'if(await this.checkAuth(),this.keysCache&&Date.now()-this.keysCacheAt<300*1e3)return this.keysCache;' +
  source.slice(ki + KEYS_ANCHOR.length)
notes.push('keys() wrapped as keys()/keysUncached()')

// ---------- 4) 原 keys() 体里：拉完立刻写进 Cache Storage ----------
const KS = 'keysCacheAt=Date.now(),this.keysCache}'
const ksi = source.indexOf(KS)
if (ksi === -1) throw new Error('anchor not found: keys() cache assignment')
if (source.indexOf(KS, ksi + KS.length) !== -1) throw new Error('anchor is not unique: keys() cache assignment')
source =
  source.slice(0, ksi) +
  'keysCacheAt=Date.now(),this.writeListCache(),this.keysCache}' +
  source.slice(ksi + KS.length)
notes.push('keysUncached: persists the list into Cache Storage after a full fetch')

const delta = Buffer.byteLength(source, 'utf8') - Buffer.byteLength(fs.readFileSync(inputPath, 'utf8'), 'utf8')
fs.writeFileSync(outputPath, source)
console.log(`patched ${inputPath} -> ${outputPath} (${delta >= 0 ? '+' : ''}${delta} bytes)`)
for (const n of notes) console.log(`  - ${n}`)
