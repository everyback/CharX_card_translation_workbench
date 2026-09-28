import fs from 'node:fs'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('usage: node patch-list-etag-server.mjs <input.cjs> <output.cjs>')
}

const MARKER = '__risuListEtag'
const LIST_ANCHOR = "app.get('/api/list', authenticatedRouteLimiter, async (req, res, next) => {"
const WRITE_ANCHOR = "app.post('/api/write', authenticatedRouteLimiter, async (req, res, next) => {"
const REMOVE_ANCHOR = "app.get('/api/remove', authenticatedRouteLimiter, async (req, res, next) => {"

const INVALIDATE = "    __risuListInvalidate();\n"

let source = fs.readFileSync(inputPath, 'utf8')

if (source.includes(MARKER)) {
  fs.writeFileSync(outputPath, source)
  console.log(`already patched, no change: ${inputPath} -> ${outputPath}`)
  process.exit(0)
}

// 前置条件：批量补丁必须已在（list 缓存块由它引入）
if (!source.includes('__risuListCache')) {
  throw new Error('list cache block not present — apply patch-read-batch-server.mjs first')
}

const notes = []

// ---------- 1) 用带 ETag/304 与失效机制的版本替换整个 /api/list 路由 ----------
const li = source.indexOf(LIST_ANCHOR)
if (li === -1) throw new Error('anchor not found: /api/list route')
if (source.indexOf(LIST_ANCHOR, li + LIST_ANCHOR.length) !== -1) throw new Error('anchor is not unique: /api/list route')
const listEnd = source.indexOf('\n});', li)
if (listEnd === -1) throw new Error('could not find end of /api/list route')
const listEndAbs = listEnd + '\n});'.length

const NEW_LIST = `// ===== patch: list ETag + cache invalidation (2026-09-15) =====
// 为什么：/api/list 返回 119k 个文件名的 JSON（8.5 MB）。在此之前它没有 ETag，
// 客户端每次都得收全量；而且旧的 10 秒进程内缓存从不失效，write/remove 之后
// 最长 10 秒会返回过期列表。
// 现在：列表内容变化时重算一个强 ETag，客户端带 If-None-Match 且未变化时
// 直接回 304（几百字节）；任何 write/remove 都会立刻让缓存与 ETag 失效。
const __risuListEtag = { tag: null, files: 0, bytes: 0, builtAt: 0 };
let __risuListRevision = 0;

function __risuListInvalidate() {
    __risuListCache = null;
    __risuListCacheAt = 0;
    __risuListEtag.tag = null;
    __risuListRevision += 1;
}

async function __risuListBuild() {
    const entries = (await fs.readdir(path.join(savePath))).sort();
    const content = entries.map((v) => Buffer.from(v, 'hex').toString('utf-8'));
    const hash = crypto.createHash('sha1');
    for (const v of entries) hash.update(v);
    __risuListEtag.tag = '"' + hash.digest('hex') + '-' + __risuListRevision + '"';
    __risuListEtag.files = content.length;
    __risuListEtag.bytes = 0;
    __risuListEtag.builtAt = Date.now();
    __risuListCache = { success: true, content };
    __risuListCacheAt = Date.now();
    return __risuListEtag;
}

app.get('/api/list', authenticatedRouteLimiter, async (req, res, next) => {
    if (!await checkAuth(req, res)) {
        return;
    }
    try {
        res.setHeader('Cache-Control', 'private, no-cache');
        // 进程内缓存 5 分钟（与客户端 keysCache 的窗口一致），并且只有内容来自同一 revision 时才复用
        if (!__risuListCache || !__risuListEtag.tag || Date.now() - __risuListCacheAt > 300000) {
            await __risuListBuild();
        }
        res.setHeader('ETag', __risuListEtag.tag);
        res.setHeader('X-Risu-List-Files', String(__risuListEtag.files));
        res.setHeader('X-Risu-List-Revision', String(__risuListRevision));
        if (req.headers['if-none-match'] && req.headers['if-none-match'].split(',').map((v) => v.trim()).includes(__risuListEtag.tag)) {
            res.status(304).end();
            return;
        }
        console.log('[risu-list] files=' + __risuListEtag.files + ' serving full payload');
        res.send(__risuListCache);
    } catch (error) {
        next(error);
    }
});`

source = source.slice(0, li) + NEW_LIST + source.slice(listEndAbs)
notes.push('/api/list: replaced with ETag + 304 + 5-minute coherent cache')

// ---------- 2) write 后失效 ----------
function insertInvalidate(anchor, label) {
  const i = source.indexOf(anchor)
  if (i === -1) throw new Error(`anchor not found: ${label}`)
  if (source.indexOf(anchor, i + anchor.length) !== -1) throw new Error(`anchor is not unique: ${label}`)
  source = source.slice(0, i) + anchor + '\n' + INVALIDATE + source.slice(i + anchor.length)
  notes.push(`${label}: list cache invalidation added`)
}
insertInvalidate(WRITE_ANCHOR, '/api/write')
insertInvalidate(REMOVE_ANCHOR, '/api/remove')

const delta = Buffer.byteLength(source, 'utf8') - Buffer.byteLength(fs.readFileSync(inputPath, 'utf8'), 'utf8')
fs.writeFileSync(outputPath, source)
console.log(`patched ${inputPath} -> ${outputPath} (${delta >= 0 ? '+' : ''}${delta} bytes)`)
for (const n of notes) console.log(`  - ${n}`)
