// WinStageSandbox 审批链路取证：解压会话 jsonl.zstd，统计 approval/asked 与 approval/decided 配对。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const sessionsRoot = path.join(process.env.USERPROFILE, '.dsh', 'sessions', '--C-Users-Administrator-Desktop-dsh-winstage-sandbox--')

function findLogs (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) findLogs(p, out)
    else if (e.name.endsWith('.jsonl.zstd')) out.push(p)
  }
  return out
}

let logs
try { logs = findLogs(sessionsRoot) } catch (error) { console.log('ERR sessionsRoot: ' + error.message); process.exit(0) }

for (const log of logs) {
  const buf = fs.readFileSync(log)
  let text
  try { text = zlib.zstdDecompressSync(buf).toString('utf8') } catch (error) { console.log(`${path.basename(path.dirname(log))}: DECOMPRESS_FAIL ${error.message}`); continue }
  const asked = []
  const decided = new Map()
  const outcomes = new Map()
  const toolCalls = new Map()
  let lines = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    lines += 1
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    const type = ev.type
    if (type === 'approval/asked') asked.push(ev.data)
    else if (type === 'approval/decided') {
      decided.set(ev.data.id, ev.data.outcome)
      outcomes.set(ev.data.outcome, (outcomes.get(ev.data.outcome) ?? 0) + 1)
    } else if (type === 'tool/call') {
      const n = ev.data?.name ?? '?'
      toolCalls.set(n, (toolCalls.get(n) ?? 0) + 1)
    }
  }
  const sid = path.basename(path.dirname(log)).slice(0, 8)
  console.log(`\n=== session ${sid}  bytes=${buf.length} lines=${lines} ===`)
  console.log(`asked=${asked.length} decided=${decided.size}  outcomes=${JSON.stringify([...outcomes])}`)
  const unmatched = asked.filter((a) => !decided.has(a.id))
  console.log(`asked-without-decided(bare ask / crash tail)=${unmatched.length}`)
  const names = new Map()
  for (const a of asked) names.set(a.toolName, (names.get(a.toolName) ?? 0) + 1)
  console.log('asked toolNames=' + JSON.stringify([...names]))
  console.log('tool/call totals=' + JSON.stringify([...toolCalls].sort((a, b) => b[1] - a[1])))
  for (const a of asked.slice(0, 6)) console.log('  ask: ' + JSON.stringify({ toolName: a.toolName, reason: (a.reason ?? '').slice(0, 90) }))
}
