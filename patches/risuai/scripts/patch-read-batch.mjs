import fs from 'node:fs'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('usage: node patch-read-batch.mjs <input.js> <output.js>')
}

const CONCURRENCY_FROM = 'assetReadActive>=6'
const CONCURRENCY_TO = 'assetReadActive>=24'

const SLOT_ANCHOR = 'async withAssetReadSlot(e){'
const DEDUP_ANCHOR = 'if(t)return await t;'
const RETRY_ANCHOR = 'async readAssetWithRetry(e){'

const INJECTED_MEMBERS =
  'assetReadBatchCache=new Map();' +
  'assetReadBatchPending=new Map();' +
  'async getItemsBatch(e){' +
  'let t=await JB(`/api/readbatch`,{method:`GET`,headers:{"file-path":Buffer.from(e.join(`$$`),`utf-8`).toString(`hex`),"risu-auth":await this.createAuth()}});' +
  'if(t.status<200||t.status>=300)throw new Error(`batch read `+t.status);' +
  'let n=Buffer.from(await t.arrayBuffer()),r=new Map(),i=0;' +
  'while(i+4<=n.length){' +
  'let a=n.readUInt32BE(i);i+=4;' +
  'if(i+a+4>n.length)break;' +
  'let o=JSON.parse(n.slice(i,i+a).toString(`utf-8`));i+=a;' +
  'let s=n.readUInt32BE(i);i+=4;' +
  'let l=n.slice(i,i+s);i+=s;' +
  'l.length>0&&!o.e&&r.set(o.p,new Uint8Array(l))' +
  '}' +
  'for(const[a,o]of r)this.assetReadBatchCache.set(a,o);' +
  'return r}' +
  'async prefetchRemoteBlocks(){' +
  'if(this.assetReadBatchPending.has(`__remotes__`))return this.assetReadBatchPending.get(`__remotes__`);' +
  'let e=(async()=>{try{' +
  'let t=await this.keys(),n=t.filter(e=>e.startsWith(`remotes/`)&&e.endsWith(`.local.bin`)&&!this.assetReadBatchCache.has(e));' +
  'for(let t=0;t<n.length;t+=200)await this.getItemsBatch(n.slice(t,t+200))' +
  '}catch(e){console.warn(`prefetch remote blocks failed`,e)}})();' +
  'this.assetReadBatchPending.set(`__remotes__`,e);' +
  'return e}'

let source = fs.readFileSync(inputPath, 'utf8')
const notes = []

function replaceOnce(anchor, replacement, label, { allowMissing = false } = {}) {
  const first = source.indexOf(anchor)
  if (first === -1) {
    if (allowMissing) {
      notes.push(`${label}: anchor not found, skipped`)
      return
    }
    throw new Error(`${label}: anchor not found: ${JSON.stringify(anchor.slice(0, 60))}`)
  }
  if (source.indexOf(anchor, first + anchor.length) !== -1) {
    throw new Error(`${label}: anchor is not unique`)
  }
  source = source.slice(0, first) + replacement + source.slice(first + anchor.length)
  notes.push(`${label}: applied`)
}

// 1) 并发闸门 6 -> 24
if (source.includes(CONCURRENCY_TO)) {
  notes.push('concurrency gate: already at 24, skipped')
} else if (source.includes(CONCURRENCY_FROM)) {
  const count = source.split(CONCURRENCY_FROM).length - 1
  if (count !== 1) throw new Error(`concurrency gate: expected 1 occurrence, found ${count}`)
  source = source.replace(CONCURRENCY_FROM, CONCURRENCY_TO)
  notes.push('concurrency gate: 6 -> 24')
} else {
  throw new Error('concurrency gate: neither the 6 nor the 24 form was found (bundle layout changed)')
}

// 2) 注入批量读取成员
if (source.includes('getItemsBatch')) {
  notes.push('batch members: already present, skipped')
} else {
  replaceOnce(SLOT_ANCHOR, INJECTED_MEMBERS + SLOT_ANCHOR, 'batch members')
}

// 3) getItem 命中批量缓存
if (source.includes('this.assetReadBatchCache.get(e)')) {
  notes.push('getItem cache read: already present, skipped')
} else {
  replaceOnce(DEDUP_ANCHOR, DEDUP_ANCHOR + '{let c=this.assetReadBatchCache.get(e);if(c)return c}', 'getItem cache read')
}

// 4) readAssetWithRetry 触发一次预取
if (source.includes('this.prefetchRemoteBlocks();')) {
  notes.push('prefetch trigger: already present, skipped')
} else {
  replaceOnce(RETRY_ANCHOR, RETRY_ANCHOR + 'this.prefetchRemoteBlocks();', 'prefetch trigger')
}

const delta = Buffer.byteLength(source, 'utf8') - Buffer.byteLength(fs.readFileSync(inputPath, 'utf8'), 'utf8')
fs.writeFileSync(outputPath, source)
console.log(`patched ${inputPath} -> ${outputPath} (${delta >= 0 ? '+' : ''}${delta} bytes)`)
for (const n of notes) console.log(`  - ${n}`)
