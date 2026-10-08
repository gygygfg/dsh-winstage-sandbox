// 检查会话日志的真实结构：解压后看首部/尾部与行的形状。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const sessionsRoot = path.join(process.env.USERPROFILE, '.dsh', 'sessions', '--C-Users-Administrator-Desktop-WinStageSandbox--')
const sub = process.argv[2]
const outFile = process.argv[3] ?? path.join(process.cwd(), '_sess_inspect.txt')
if (outFile !== undefined) {
  const chunks = []
  const orig = console.log
  console.log = (...a) => { chunks.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
  process.on('exit', () => { try { fs.writeFileSync(outFile, chunks.join('\n'), 'utf8') } catch {} })
}

function findLogs (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) findLogs(p, out)
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

const logs = findLogs(sessionsRoot)
console.log('logs=' + logs.length)
const target = sub === undefined ? logs[0] : logs.find((l) => l.includes(sub))
console.log('target=' + target)
const buf = fs.readFileSync(target)
console.log('compressed=' + buf.length + ' magic=' + buf.subarray(0, 4).toString('hex'))
const out = zlib.zstdDecompressSync(buf)
console.log('decompressed=' + out.length)
const text = out.toString('utf8')
console.log('--- HEAD 1200 ---')
console.log(JSON.stringify(text.slice(0, 1200)))
console.log('--- TAIL 600 ---')
console.log(JSON.stringify(text.slice(-600)))
console.log('newlineCount=' + (text.match(/\n/g) ?? []).length)
// 尝试按 zstd 帧魔数切分
let frames = 0
for (let i = 0; i + 4 <= buf.length; i += 1) if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd) frames += 1
console.log('zstdFrameMagicOccurrences=' + frames)
