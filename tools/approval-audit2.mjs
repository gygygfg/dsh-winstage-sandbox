// WinStageSandbox 审批链路取证（多帧 zstd 版本）
// 会话 jsonl 是 704 个连续 zstd 帧；Z_SYNC_FLUSH 会在结尾留 4 字节 "00 00 FF FF" 尾巴，
// 因此按“完整帧”切分后逐帧解压。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const sessionsRoot = path.join(process.env.USERPROFILE, '.dsh', 'sessions', '--C-Users-Administrator-Desktop-WinStageSandbox--')

function findLogs (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) findLogs(p, out)
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

/** 逐帧解压：返回 { text, frames, failures } */
function decompressAll (buf) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const starts = []
  let idx = buf.indexOf(MAGIC, 0)
  while (idx !== -1) { starts.push(idx); idx = buf.indexOf(MAGIC, idx + 4) }
  let text = ''
  let failures = 0
  for (let i = 0; i < starts.length; i += 1) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length
    let frame = buf.subarray(starts[i], end)
    // 去掉尾部 00 00 FF FF
    if (frame.length >= 4 && frame[frame.length - 2] === 0xff && frame[frame.length - 1] === 0xff) frame = frame.subarray(0, frame.length - 4)
    try { text += zlib.zstdDecompressSync(frame).toString('utf8') } catch { failures += 1 }
  }
  return { text, frames: starts.length, failures }
}

const outFile = process.argv[3] ?? path.join(process.cwd(), '_approval_audit2.txt')
const lines = []
const log = (...a) => lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))

for (const file of findLogs(sessionsRoot)) {
  const buf = fs.readFileSync(file)
  const { text, frames, failures } = decompressAll(buf)
  const asked = []
  const decided = new Map()
  const outcomes = new Map()
  const toolCalls = new Map()
  let total = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    total += 1
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev.type === 'approval/asked') asked.push(ev.data)
    else if (ev.type === 'approval/decided') {
      decided.set(ev.data.id, ev.data.outcome)
      outcomes.set(ev.data.outcome, (outcomes.get(ev.data.outcome) ?? 0) + 1)
    } else if (ev.type === 'tool/call') {
      const n = ev.data?.name ?? '?'
      toolCalls.set(n, (toolCalls.get(n) ?? 0) + 1)
    }
  }
  const sid = path.basename(path.dirname(file)).slice(0, 8)
  log(`\n=== session ${sid} bytes=${buf.length} frames=${frames} frameFailures=${failures} events=${total} ===`)
  log(`asked=${asked.length} decided=${decided.size} outcomes=${JSON.stringify([...outcomes])}`)
  log(`asked-without-decided=${asked.filter((a) => !decided.has(a.id)).length}`)
  const names = new Map()
  for (const a of asked) names.set(a.toolName, (names.get(a.toolName) ?? 0) + 1)
  log('asked.toolNames=' + JSON.stringify([...names]))
  log('tool/call totals=' + JSON.stringify([...toolCalls].sort((a, b) => b[1] - a[1])))
  for (const a of asked.slice(0, 8)) log('  ask: ' + JSON.stringify({ toolName: a.toolName, reason: (a.reason ?? '').slice(0, 100) }))
}

fs.writeFileSync(outFile, lines.join('\n'), 'utf8')
