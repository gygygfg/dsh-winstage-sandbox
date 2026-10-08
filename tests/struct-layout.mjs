/**
 * 结构体布局的确定性测试（**不需要任何 Win32 调用**）
 *
 * 存在理由：偏移/长度写错这类缺陷，在受限会话里无法通过"真跑一个 Job"暴露出来，
 * 于是本仓库让同一个错误连过两轮审计。用合成缓冲区就能在任何环境确定性测出来。
 *
 * 依据：DSH 自身的 `@deepseek-ai/dsh-win32-process` 的 `isJobEmpty()` 读
 * `information.readUInt32LE(40)` 判活跃进程数，与本表一致。
 */

import {
  JOB_BASIC_ACCOUNTING_SIZE,
  OFF_ACCOUNTING,
  parseBasicAccounting,
  buildExtendedLimitInformation,
  encodeEnvironmentBlock,
} from '../src/executor.mjs'

const W = (s) => process.stdout.write(`${s}\n`)
let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  W(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}`)
}

W('=== 1. 会计结构大小与偏移 ===')
check('大小精确为 48', JOB_BASIC_ACCOUNTING_SIZE === 48, String(JOB_BASIC_ACCOUNTING_SIZE))
check(
  'ActiveProcesses 在偏移 40（与 DSH isJobEmpty 一致）',
  OFF_ACCOUNTING.activeProcesses === 40,
  `activeProcesses=${OFF_ACCOUNTING.activeProcesses}`,
)
check('TotalProcesses 在偏移 36', OFF_ACCOUNTING.totalProcesses === 36, `totalProcesses=${OFF_ACCOUNTING.totalProcesses}`)
check(
  'TotalTerminatedProcesses 在偏移 44（最后一个合法偏移）',
  OFF_ACCOUNTING.totalTerminatedProcesses === 44,
  `totalTerminatedProcesses=${OFF_ACCOUNTING.totalTerminatedProcesses}`,
)
check('TotalPageFaultCount 在偏移 32', OFF_ACCOUNTING.totalPageFaultCount === 32, `totalPageFaultCount=${OFF_ACCOUNTING.totalPageFaultCount}`)
check(
  '所有字段都在 48 字节之内（读过界就是上一轮的 bug）',
  Object.values(OFF_ACCOUNTING).every((off) => off + 4 <= JOB_BASIC_ACCOUNTING_SIZE),
  JSON.stringify(OFF_ACCOUNTING),
)

W('')
W('=== 2. parseBasicAccounting 合成缓冲区解析 ===')
// 造一个"Total=5, Active=2, Terminated=3, PageFaults=7"的缓冲区
const buf = Buffer.alloc(JOB_BASIC_ACCOUNTING_SIZE)
buf.writeUInt32LE(7, 32)
buf.writeUInt32LE(5, 36)
buf.writeUInt32LE(2, 40)
buf.writeUInt32LE(3, 44)
const parsed = parseBasicAccounting(buf)
check('totalProcesses = 5', parsed.totalProcesses === 5, JSON.stringify(parsed))
check('activeProcesses = 2', parsed.activeProcesses === 2, JSON.stringify(parsed))
check('terminatedProcesses = 3', parsed.terminatedProcesses === 3, JSON.stringify(parsed))
check('totalPageFaultCount = 7', parsed.totalPageFaultCount === 7, JSON.stringify(parsed))

W('')
W('=== 3. 尺寸不匹配必须显式拒绝（不得静默读错位） ===')
for (const size of [40, 44, 52, 64, 144]) {
  let threw = false
  try {
    parseBasicAccounting(Buffer.alloc(size))
  } catch {
    threw = true
  }
  check(`拒绝 ${size} 字节缓冲区`, threw, threw ? '已抛错' : '竟然接受了')
}

W('')
W('=== 4. 上一轮真实 bug 的回归断言 ===')
// 旧实现读 48 偏移；48+4 > 48 必须被挡住
const oldOffsets = { totalProcesses: 40, activeProcesses: 44, totalTerminatedProcesses: 48 }
const outOfRange = Object.entries(oldOffsets).filter(([, off]) => off + 4 > JOB_BASIC_ACCOUNTING_SIZE)
check(
  '旧偏移表确实会越界（证明该 bug 可被本测试捕获）',
  outOfRange.length === 1 && outOfRange[0][0] === 'totalTerminatedProcesses',
  JSON.stringify(outOfRange),
)

W('')
W('=== 5. 扩展限制信息结构 ===')
const { buffer: ext, flags } = buildExtendedLimitInformation({ activeProcessLimit: 16 })
check('KILL_ON_JOB_CLOSE 已置位', (flags & 0x2000) !== 0, `flags=0x${flags.toString(16)}`)
check('ACTIVE_PROCESS 已置位', (flags & 0x8) !== 0, `flags=0x${flags.toString(16)}`)
check('LimitFlags 写在偏移 16', ext.readUInt32LE(16) === (flags >>> 0), `read=${ext.readUInt32LE(16)}`)
check('ActiveProcessLimit 写在偏移 36 且值为 16', ext.readUInt32LE(36) === 16, String(ext.readUInt32LE(36)))
check('结构大小 144', ext.length === 144, String(ext.length))

W('')
W('=== 6. 环境块编码 ===')
const block = encodeEnvironmentBlock({ PATH: 'C:\\x', TEMP: 'C:\\y', a: 'b' })
const text = block.toString('utf16le')
check('以双 NUL 结尾', text.endsWith('\u0000\u0000'), JSON.stringify(text.slice(-4)))
check('UTF-16LE 双字节编码', block.length === text.length * 2, `${block.length} vs ${text.length * 2}`)
check('键名按不区分大小写排序', text.indexOf('a=b') < text.indexOf('PATH'), text.replace(/\u0000/g, '|'))

W('')
W('='.repeat(60))
W(failures === 0 ? '结构体布局测试：全部通过' : `结构体布局测试：${failures} 项失败`)
W('='.repeat(60))
process.exit(failures ? 1 : 0)
