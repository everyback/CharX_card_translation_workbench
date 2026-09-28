import fs from 'node:fs'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('usage: node patch-read-cache-evict.mjs <input.js> <output.js>')
}

const MARKER = 'forgetAsset'
const ANCHOR = 'async removeItem(e){await this.checkAuth();let t=await JB(`/api/remove`'

const INJECTED_MEMBERS =
  'assetLocalCacheForgotten=new Set();' +
  'async forgetAsset(e){' +
  'if(!/^assets\\/[0-9a-f]{16,}\\./.test(e))return;' +
  'this.assetLocalCacheForgotten.add(e);' +
  'if(this.assetLocalCacheNames)this.assetLocalCacheNames.delete(e);' +
  'try{let t=await this.assetLocalCache;' +
  'await t.delete(new Request(`/__risu-asset/`+encodeURIComponent(e)))}catch{}}'

let source = fs.readFileSync(inputPath, 'utf8')

if (source.includes(MARKER)) {
  fs.writeFileSync(outputPath, source)
  console.log(`already patched, no change: ${inputPath} -> ${outputPath}`)
  process.exit(0)
}

const notes = []

// 1) 在 checkAuth 之前插入 forgetAsset 成员（与 assetLocalCache 同一类体）
const CA = 'async checkAuth(){'
const ci = source.indexOf(CA)
if (ci === -1) throw new Error('anchor not found: async checkAuth(){')
if (source.indexOf(CA, ci + CA.length) !== -1) throw new Error('anchor is not unique: async checkAuth(){')
source = source.slice(0, ci) + INJECTED_MEMBERS + source.slice(ci)
notes.push('forgetAsset member: inserted')

// 2) removeItem 声明改名，并插入一层会清缓存的包装
const ri = source.indexOf(ANCHOR)
if (ri === -1) throw new Error('anchor not found: NodeStorage.removeItem')
if (source.indexOf(ANCHOR, ri + ANCHOR.length) !== -1) throw new Error('anchor is not unique: NodeStorage.removeItem')
const ORIG = 'removeItemUncached'
source =
  source.slice(0, ri) +
  'async removeItem(e){' +
  'let t=Array.isArray(e)?e:[e];' +
  'for(let n of t)try{await this.forgetAsset(n)}catch{}' +
  `return await this.${ORIG}(e)}` +
  `async ${ORIG}(e){await this.checkAuth();let t=await JB(\`/api/remove\`` +
  source.slice(ri + ANCHOR.length)
notes.push(`removeItem wrapped: asset cache eviction (original renamed to ${ORIG})`)

// 3) getItemCached 必须尊重"已遗忘"标记，避免删掉后又从内存名单里命中
const GC_OLD = 'if(!this.assetLocalCacheNames.has(e))return null;'
const GC_NEW = 'if(!this.assetLocalCacheNames.has(e)||this.assetLocalCacheForgotten.has(e))return null;'
if (!source.includes(GC_OLD)) throw new Error('anchor not found: getItemCached membership check')
if (source.indexOf(GC_OLD) !== source.lastIndexOf(GC_OLD)) throw new Error('anchor is not unique: getItemCached membership check')
source = source.replace(GC_OLD, GC_NEW)
notes.push('getItemCached: honours the forgotten set')

const delta = Buffer.byteLength(source, 'utf8') - Buffer.byteLength(fs.readFileSync(inputPath, 'utf8'), 'utf8')
fs.writeFileSync(outputPath, source)
console.log(`patched ${inputPath} -> ${outputPath} (${delta >= 0 ? '+' : ''}${delta} bytes)`)
for (const n of notes) console.log(`  - ${n}`)
