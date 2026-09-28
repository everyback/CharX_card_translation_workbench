import fs from 'node:fs'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('usage: node patch-read-batch-server.mjs <input.cjs> <output.cjs>')
}

const LIST_ROUTE_ANCHOR = "app.get('/api/list', authenticatedRouteLimiter, async (req, res, next) => {"
const READBATCH_MARKER = "app.get('/api/readbatch'"
const LIST_CACHE_MARKER = '__risuListCache'

const READBATCH_ROUTE = `// ===== patch: batch-read (2026-09-15) =====
// Why: /api/read handles exactly one file per request, so a client that needs N
// files pays N round trips. On a high-latency uplink (this host serves ~3 Mbps)
// the round trips dominate: 82 reads over 43 MB spent most of their wall time
// waiting, not transferring. This route returns several files in one response.
//
// Request:  header file-path = hex( "path1\$\$path2\$\$..." ), max 256 entries.
// Response: application/octet-stream, entries concatenated in request order as
//           [uint32BE headLen][head JSON][uint32BE bodyLen][body].
//           head JSON is {"p":"<path>"} on success, or {"p":"<path>","e":1}
//           for a non-hex path and {"p":"<path>","e":2} for a missing file.
//           A failing entry never fails the whole batch.
//
// Caching: remotes/ and assets/ are content-addressed and treated as immutable,
// so their bodies are cached in memory keyed by path and validated against
// stat(size, mtimeMs). database/ is deliberately NOT cached because it is
// rewritten on every save. Cache cap 512 MB with insertion-order eviction.
const __risuBatchCache = new Map();
const __risuBatchCacheMax = 512 * 1024 * 1024;
let __risuBatchCacheBytes = 0;
const __risuStaleOk = new Set(['remotes/', 'assets/']);

function __risuCacheGet(fp) {
    const e = __risuBatchCache.get(fp);
    if (!e) return null;
    try {
        const st = fs.statSync(path.join(savePath, fp));
        if (st.size === e.size && Math.trunc(st.mtimeMs) === e.mtime) return e.buf;
    } catch { }
    __risuBatchCache.delete(fp);
    __risuBatchCacheBytes -= e.buf.length;
    return null;
}

function __risuCachePut(fp, buf, st) {
    const prev = __risuBatchCache.get(fp);
    if (prev) __risuBatchCacheBytes -= prev.buf.length;
    __risuBatchCache.set(fp, { buf, size: st.size, mtime: Math.trunc(st.mtimeMs) });
    __risuBatchCacheBytes += buf.length;
    while (__risuBatchCacheBytes > __risuBatchCacheMax && __risuBatchCache.size > 1) {
        const k = __risuBatchCache.keys().next().value;
        if (k === undefined) break;
        __risuBatchCacheBytes -= __risuBatchCache.get(k).buf.length;
        __risuBatchCache.delete(k);
    }
}

app.get('/api/readbatch', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) return;
    let decoded;
    try {
        decoded = Buffer.from(String(req.headers['file-path'] || ''), 'hex').toString('utf-8');
    } catch { decoded = ''; }
    const reqs = decoded.split('\$\$').map((s) => s.trim()).filter(Boolean);
    if (reqs.length === 0) { res.status(400).send({ error: 'File path required' }); return; }
    if (reqs.length > 256) { res.status(400).send({ error: 'Too many files (max 256)' }); return; }
    const out = [];
    try {
        for (const fp of reqs) {
            if (!isHex(fp)) { out.push({ p: fp, e: 1 }); continue; }
            const full = path.join(savePath, fp);
            if (!existsSync(full)) { out.push({ p: fp, e: 2 }); continue; }
            let buf = __risuStaleOk.has(fp.slice(0, 8)) ? __risuCacheGet(fp) : null;
            if (!buf) {
                buf = await fs.promises.readFile(full);
                const st = await fs.promises.stat(full);
                __risuCachePut(fp, buf, st);
            }
            out.push({ p: fp, b: buf });
        }
        const parts = [];
        for (const e of out) {
            const head = Buffer.from(JSON.stringify(e), 'utf-8');
            const len = Buffer.alloc(4);
            len.writeUInt32BE(head.length, 0);
            const body = e.b ? e.b : Buffer.alloc(0);
            const blen = Buffer.alloc(4);
            blen.writeUInt32BE(body.length, 0);
            parts.push(len, head, blen, body);
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'private, no-cache');
        res.end(Buffer.concat(parts));
    } catch (error) { next(error); }
});
`

const LIST_CACHE_HEADER = `        res.setHeader('Cache-Control', 'private, no-cache');
        if (__risuListCache && Date.now() - __risuListCacheAt < 10000) {
            res.setHeader('X-Risu-List-Cache', 'hit');
            res.send(__risuListCache);
            return;
        }`

let source = fs.readFileSync(inputPath, 'utf8')
const original = source
const notes = []

// 1) 注入 /api/readbatch（放在 /api/list 之前）
if (source.includes(READBATCH_MARKER)) {
  notes.push('readbatch route: already present, skipped')
} else {
  const first = source.indexOf(LIST_ROUTE_ANCHOR)
  if (first === -1) throw new Error('readbatch route: /api/list anchor not found')
  if (source.indexOf(LIST_ROUTE_ANCHOR, first + LIST_ROUTE_ANCHOR.length) !== -1) {
    throw new Error('readbatch route: /api/list anchor is not unique')
  }
  source = source.slice(0, first) + READBATCH_ROUTE + '\n' + source.slice(first)
  notes.push('readbatch route: inserted before /api/list')
}

// 2) /api/list 加 10 秒缓存
if (source.includes(LIST_CACHE_MARKER)) {
  notes.push('list cache: already present, skipped')
} else {
  const routeAt = source.indexOf(LIST_ROUTE_ANCHOR)
  if (routeAt === -1) throw new Error('list cache: /api/list anchor not found')
  // 路由体内第一条 Cache-Control 设置为锚点
  const bodyStart = routeAt
  const bodyEnd = source.indexOf('\n});', routeAt)
  if (bodyEnd === -1) throw new Error('list cache: could not locate route body end')
  let body = source.slice(bodyStart, bodyEnd)
  const cc = "        res.setHeader('Cache-Control', 'private, no-cache');"
  const ccAt = body.indexOf(cc)
  if (ccAt === -1) throw new Error('list cache: Cache-Control line not found in /api/list body')
  body = body.slice(0, ccAt) + LIST_CACHE_HEADER + body.slice(ccAt + cc.length)
  // 缓存写入：res.send 之前先赋值
  const sendAt = body.indexOf('        res.send({')
  if (sendAt === -1) throw new Error('list cache: res.send({ not found in /api/list body')
  const assign =
    '        __risuListCache = { success: true, content: data };\n' +
    '        __risuListCacheAt = Date.now();\n'
  body = body.slice(0, sendAt) + assign + body.slice(sendAt)
  source = source.slice(0, bodyStart) + body + source.slice(bodyEnd)
  // 变量声明放在路由之前，保证模块作用域内可见
  const decl = 'let __risuListCache = null;\nlet __risuListCacheAt = 0;\n'
  const routeAt2 = source.indexOf(LIST_ROUTE_ANCHOR)
  source = source.slice(0, routeAt2) + decl + source.slice(routeAt2)
  notes.push('list cache: read path, write path and declarations inserted')
}

if (source === original) {
  // 已经打过补丁：按幂等处理，原样写出（与 patch-read-batch.mjs 行为一致）
  fs.writeFileSync(outputPath, source)
  console.log(`already patched, no change: ${inputPath} -> ${outputPath}`)
  for (const n of notes) console.log(`  - ${n}`)
  process.exit(0)
}

fs.writeFileSync(outputPath, source)
const delta = Buffer.byteLength(source, 'utf8') - Buffer.byteLength(original, 'utf8')
console.log(`patched ${inputPath} -> ${outputPath} (+${delta} bytes)`)
for (const n of notes) console.log(`  - ${n}`)
