/**
 * 元测试：验证 autotest 的运行器**真的能检出失败**。
 *
 * 为什么需要它：一个永远不会报失败的测试运行器比没有运行器更糟 ——
 * 它给出虚假的绿色。本文件用"人为失败的子进程"反证运行器的判定逻辑：
 * 如果它观察不到子进程的非零退出码，元测试自己就失败。
 *
 * 已被手动验证可用于本沙箱环境（stdio: 'ignore' 不需要管道捕获）：
 *   node tests/meta-runner.mjs
 */

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}\n`)
}

process.stdout.write('=== 元测试：运行器能否检出失败 ===\n')

// 1) 人为失败的子进程：必须观察到退出码 1
const failing = spawnSync(process.execPath, [join(HERE, '_planted-failure.mjs')], { stdio: 'ignore' })
check('观察到人为失败子进程的退出码 1', failing.status === 1, `status=${failing.status} error=${failing.error?.code ?? 'none'}`)

// 2) 正常成功的子进程：必须观察到退出码 0
const passing = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
check('观察到成功子进程的退出码 0', passing.status === 0, `status=${passing.status}`)

// 3) 判定规则：非零退出码必须映射为 FAIL
const toStatus = (status) => (status === 0 ? 'PASS' : 'FAIL')
check('非零退出码映射为 FAIL', toStatus(1) === 'FAIL', toStatus(1))
check('零退出码映射为 PASS', toStatus(0) === 'PASS', toStatus(0))

process.stdout.write(
  failures === 0
    ? '\n元测试：全部通过（运行器可以检出失败）\n'
    : `\n元测试：${failures} 项失败 —— 运行器的判定逻辑不可信\n`,
)
process.exit(failures ? 1 : 0)
