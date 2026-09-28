import fs from 'node:fs'

const [inputPath, outputPath] = process.argv.slice(2)
if (!inputPath || !outputPath) {
  throw new Error('usage: node patch-read-accounting-server.mjs <input.cjs> <output.cjs>')
}

const MARKER = '__risuReadStats'
const READBATCH_ANCHOR = "app.get('/api/readbatch'"
const READ_STAT_ANCHOR = '        const fileStat = await fs.stat(path.join(savePath, filePath));'
const BATCH_PUSH_ANCHOR = '            out.push({ p: fp, b: buf });'
const LIST_CACHE_ANCHOR = '        __risuListCache = { success: true, content: data };'

const STATS_BLOCK = `// ===== patch: read accounting (2026-09-15) =====
// 目的：把 /api/read 的 N+1 讲清楚——按"目录/扩展名"累计读了多少次、多少字节，
// 并记录 /api/list 的调用次数。只有进程内计数器，每 200 次请求打印一行汇总。
// 这是诊断用的，不影响任何响应内容。
const __risuReadStats = new Map();
let __risuReadStatsTotal = 0;
function __risuReadBump(filePath, bytes) {
    const key = filePath.split('/')[0] + '/' + (filePath.includes('.') ? filePath.split('.').pop() : '(noext)');
    const e = __risuReadStats.get(key) || { n: 0, b: 0 };
    e.n += 1; e.b += bytes || 0;
    __risuReadStats.set(key, e);
    __risuReadStatsTotal += 1;
    if (__risuReadStatsTotal % 200 === 0) {
        const parts = [];
        for (const [k, v] of [...__risuReadStats.entries()].sort((a, b) => b[1].b - a[1].b).slice(0, 12)) {
            parts.push(k + '=' + v.n + 'x/' + (v.b / 1048576).toFixed(1) + 'MB');
        }
        console.log('[risu-read-stats] total=' + __risuReadStatsTotal + '  ' + parts.join('  '));
    }
}

`

let source = fs.readFileSync(inputPath, 'utf8')

if (source.includes(MARKER)) {
  fs.writeFileSync(outputPath, source)
  console.log(`already patched, no change: ${inputPath} -> ${outputPath}`)
  process.exit(0)
}

const notes = []

// 0) 前置条件：批量补丁必须在
if (!source.includes(READBATCH_ANCHOR)) {
  throw new Error('readbatch patch not present — apply patch-read-batch-server.mjs first')
}

// 1) 统计器定义，插在 /api/readbatch 之前（模块顶层）
const bi = source.indexOf(READBATCH_ANCHOR)
source = source.slice(0, bi) + STATS_BLOCK + source.slice(bi)
notes.push('stats helpers: inserted before /api/readbatch')

// 2) /api/read 里记账
const ri = source.indexOf(READ_STAT_ANCHOR)
if (ri === -1) throw new Error('anchor not found: /api/read stat line')
if (source.indexOf(READ_STAT_ANCHOR, ri + READ_STAT_ANCHOR.length) !== -1) {
  throw new Error('anchor is not unique: /api/read stat line')
}
source =
  source.slice(0, ri + READ_STAT_ANCHOR.length) +
  "\n        __risuReadBump(Buffer.from(filePath, 'hex').toString('utf-8'), fileStat.size);" +
  source.slice(ri + READ_STAT_ANCHOR.length)
notes.push('/api/read: accounting added')

// 3) /api/readbatch 里记账
const pi = source.indexOf(BATCH_PUSH_ANCHOR)
if (pi === -1) throw new Error('anchor not found: readbatch out.push')
if (source.indexOf(BATCH_PUSH_ANCHOR, pi + BATCH_PUSH_ANCHOR.length) !== -1) {
  throw new Error('anchor is not unique: readbatch out.push')
}
source =
  source.slice(0, pi) +
  '            __risuReadBump(fp, buf.length);\n' +
  source.slice(pi)
notes.push('/api/readbatch: accounting added')

// 4) /api/list 记录文件数与 payload 体积（只走 cache miss 分支）
const li = source.indexOf(LIST_CACHE_ANCHOR)
if (li === -1) throw new Error('anchor not found: /api/list cache write')
if (source.indexOf(LIST_CACHE_ANCHOR, li + LIST_CACHE_ANCHOR.length) !== -1) {
  throw new Error('anchor is not unique: /api/list cache write')
}
source =
  source.slice(0, li) +
  "        console.log('[risu-list] files=' + data.length + ' payload=' + (JSON.stringify(data).length / 1048576).toFixed(1) + 'MB');\n" +
  source.slice(li)
notes.push('/api/list: size logging added')

const delta = Buffer.byteLength(source, 'utf8') - Buffer.byteLength(fs.readFileSync(inputPath, 'utf8'), 'utf8')
fs.writeFileSync(outputPath, source)
console.log(`patched ${inputPath} -> ${outputPath} (+${delta} bytes)`)
for (const n of notes) console.log(`  - ${n}`)
