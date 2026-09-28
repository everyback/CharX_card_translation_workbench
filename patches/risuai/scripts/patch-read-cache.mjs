import fs from 'node:fs'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('usage: node patch-read-cache.mjs <input.js> <output.js>')
}

const ANCHOR = 'async checkAuth(){'
const MARKER = 'assetLocalCache'

const INJECTED =
  'assetLocalCache=caches.open(`risu-assets-v1`);' +
  'assetLocalCachePrimed=false;' +
  'assetLocalCacheNames=new Set();' +
  'async primeAssetLocalCache(){' +
  'if(this.assetLocalCachePrimed)return this.assetLocalCacheNames;' +
  'try{let e=await this.assetLocalCache;' +
  '(await e.keys()).forEach(e=>{try{let t=new URL(e.url).pathname.replace(/^\\//,``);this.assetLocalCacheNames.add(decodeURIComponent(t))}catch{}})' +
  '}catch{}' +
  'this.assetLocalCachePrimed=true;' +
  'return this.assetLocalCacheNames}' +
  'persistAsset(e,t){' +
  'if(!/^assets\\/[0-9a-f]{16,}\\./.test(e))return;' +
  'this.assetLocalCacheNames.add(e);' +
  'try{let n=this.assetLocalCache;' +
  'n.then(n=>n.put(new Request(`/__risu-asset/`+encodeURIComponent(e)),' +
  'new Response(t,{headers:{"content-type":`application/octet-stream`}}))).catch(()=>{})' +
  '}catch{}}' +
  'async getItemCached(e){' +
  'await this.primeAssetLocalCache();' +
  'if(!this.assetLocalCacheNames.has(e))return null;' +
  'try{let t=await this.assetLocalCache;' +
  'let n=await t.match(new Request(`/__risu-asset/`+encodeURIComponent(e)));' +
  'if(!n)return null;' +
  'let r=new Uint8Array(await n.arrayBuffer());' +
  'return r.length>0?r:null' +
  '}catch{return null}}'

let source = fs.readFileSync(inputPath, 'utf8')
const notes = []

if (source.includes(MARKER)) {
  // 已打过：仍然按幂等写出
  fs.writeFileSync(outputPath, source)
  console.log(`already patched, no change: ${inputPath} -> ${outputPath}`)
  process.exit(0)
}

// 1) 插入成员（放在 checkAuth 之前，属于同一个类体）
const first = source.indexOf(ANCHOR)
if (first === -1) throw new Error('anchor not found: async checkAuth(){')
if (source.indexOf(ANCHOR, first + ANCHOR.length) !== -1) throw new Error('anchor is not unique: async checkAuth(){')
source = source.slice(0, first) + INJECTED + source.slice(first)
notes.push('asset local cache members: inserted before checkAuth')

// 2) 把 NodeStorage.getItem 包一层：先查本地持久缓存，未命中再走原逻辑
//    注意：bundle 里 `async getItem(e){` 会出现 4 次（NodeStorage / AccountStorage / OPFS / 插件包装），
//    所以锚点必须带 NodeStorage 特有的一行：`await this.checkAuth();let t=e.startsWith(`remotes/`)`
const GET_ITEM_DECL = 'async getItem(e){await this.checkAuth();let t=e.startsWith(`remotes/`)'
const gi = source.indexOf(GET_ITEM_DECL)
if (gi === -1) throw new Error('anchor not found: NodeStorage getItem (expected `async getItem(e){await this.checkAuth();let t=e.startsWith(`remotes/`)`)')
if (source.indexOf(GET_ITEM_DECL, gi + GET_ITEM_DECL.length) !== -1) {
  throw new Error('anchor is not unique: NodeStorage getItem')
}
const origName = 'getItemUncached'
source =
  source.slice(0, gi) +
  `async getItem(e){` +
  `let t=await this.getItemCached(e);` +
  `if(t)return t;` +
  `let n=await this.${origName}(e);` +
  `if(n&&n.length>0)this.persistAsset(e,n);` +
  `return n}` +
  `async ${origName}(e){await this.checkAuth();let t=e.startsWith(\`remotes/\`)` +
  source.slice(gi + GET_ITEM_DECL.length)
notes.push(`NodeStorage.getItem wrapped: local cache read + persist (original renamed to ${origName})`)

const delta = Buffer.byteLength(source, 'utf8') - Buffer.byteLength(fs.readFileSync(inputPath, 'utf8'), 'utf8')
fs.writeFileSync(outputPath, source)
console.log(`patched ${inputPath} -> ${outputPath} (${delta >= 0 ? '+' : ''}${delta} bytes)`)
for (const n of notes) console.log(`  - ${n}`)
