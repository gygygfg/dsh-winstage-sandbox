#!/usr/bin/env node
/**
 * WinStage shell 交还/降级修复 —— 离线验证器（零依赖，不启动任何进程，不写产品目录）
 *
 * 为什么需要它：本会话的 shell 只有"暂存树"可写（`.t`/`src`/`docs` 全被 ACL 拒），
 * 因此 `autotest.cmd --skip-audit`（要写 `.t\run-selftest.txt`）与任何需要子进程的
 * 套件**无法在沙箱内运行**。本验证器只做**静态 + 纯函数**层面的判定，
 * 可以被沙箱内的 node 直接执行，用来在"回归门由用户在外部跑"之前先兜住一次。
 *
 * 覆盖（对应本轮实际发生的失败链）：
 *   S1  `execute()` 不再存在"档位不匹配 ⇒ throw"的分支（那正是 shell 整条失效的原因）
 *   S2  `execute()` 仍把档位不匹配**报响**（error 级日志 + degradeNote）——不许静默
 *   S3  交还平台的死代码已标注为"不再调用"，且 `execute()` 不再引用它
 *   S4  `publish()` 委托 `writeFileAtomic`，且不再自写 `${target}.tmp-${pid}`
 *   S5  语法自检：三个文件能被 `node --check` 通过（由调用方保证；这里只报文件存在）
 *
 * 跑法：node docs/dsh2-shell-fallback-verify.mjs
 * 退出码：0 = 全 PASS；1 = 有 FAIL
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox'
const SHELL = join(REPO, 'dsh-plugin', 'shell-executor.mjs')
const REVIEW = join(REPO, 'dsh-plugin', 'review-service.mjs')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: ok === true })
  console.log(`  [ ${ok ? 'PASS' : 'FAIL'} ] ${name}${detail ? `  —— ${detail}` : ''}`)
}

console.log('='.repeat(64))
console.log(' WinStage shell 交还/降级 + 2b —— 离线验证')
console.log('='.repeat(64))

for (const f of [SHELL, REVIEW]) {
  check(`文件存在：${f.replace(REPO + '\\', '')}`, existsSync(f))
}
if (!existsSync(SHELL) || !existsSync(REVIEW)) process.exit(1)

const shell = readFileSync(SHELL, 'utf8')
const review = readFileSync(REVIEW, 'utf8')

// 为把断言限定在 execute() 方法体内，先切出它
const execStart = shell.indexOf('async execute(spec) {')
const execEnd = shell.indexOf('async executeConfined(spec, context = {}) {')
const execBody = execStart >= 0 && execEnd > execStart ? shell.slice(execStart, execEnd) : ''
check('S0 能切出 execute() 方法体', execBody.length > 0, `len=${execBody.length}`)

// ── S1：不再有"档位不匹配 ⇒ throw"分支 ──────────────────────────────
{
  const hasThrowOnMode = /requestedMode\s*!==\s*undefined[\s\S]{0,120}?throw shellFailure\(/.test(execBody)
  check('S1 execute() 内不再因档位不匹配而抛错', !hasThrowOnMode)
  check(
    'S1b ESCALATION_NOT_SUPPORTED 不再是 execute() 的控制流',
    !execBody.includes("'WINSTAGE_SHELL_ESCALATION_NOT_SUPPORTED'"),
    '（该常量可在注释/历史里出现，但不得在 execute() 内 throw）',
  )
}

// ── S2：档位不匹配必须"报响" ────────────────────────────────────────
{
  check('S2 存在 mismatched 判定', /const mismatched\s*=/.test(execBody))
  check('S2 不匹配走 error 级日志', /mismatched[\s\S]{0,200}?this\.logError\(/.test(execBody))
  check('S2 不匹配随返回带出 degradeNote', /degradeNote/.test(execBody))
  check(
    'S2b 降级注记在 executeConfined 里进 notes（可见）',
    /context\.degradeNote[\s\S]{0,120}?warn\(context\.degradeNote\)/.test(shell),
  )
}

// ── S3：交还死代码不再参与执行路径 ──────────────────────────────────
{
  check('S3 execute() 不再调用 nativeExecutorFor()', !execBody.includes('nativeExecutorFor'))
  check(
    'S3b nativeExecutorFor 已标注为"不再调用/不可行"',
    /保留但不再调用|已无调用点|不再调用/.test(shell),
  )
  check(
    'S3c 三次失败取证已记录（服务名重复注册 / subprocess / 逸出）',
    /has been registered/.test(shell) && /without inject/.test(shell),
  )
}

// ── S4：2b publish() 委托 writeFileAtomic ───────────────────────────
{
  const pubStart = review.indexOf('  publish() {')
  const pubEnd = review.indexOf('\n  }', pubStart)
  const pubBody = pubStart >= 0 && pubEnd > pubStart ? review.slice(pubStart, pubEnd) : ''
  check('S4 能切出 publish() 方法体', pubBody.length > 0, `len=${pubBody.length}`)
  check('S4 publish() 调用 writeFileAtomic', /writeFileAtomic\(this\.reviewPath\(\)/.test(pubBody))
  check(
    'S4b publish() 不再自写 tmp + renameSync',
    !/writeFileSync\(temp/.test(pubBody) && !/renameSync\(temp, target\)/.test(pubBody),
  )
  check(
    'S4c writeFileAtomic 已从 store.mjs 导入',
    /import \{[^}]*writeFileAtomic[^}]*\} from '\.\.\/src\/store\.mjs'/.test(review),
  )
}

console.log('\n' + '='.repeat(64))
const pass = results.filter((r) => r.ok).length
const fail = results.length - pass
console.log(` 总判定: ${fail === 0 ? 'PASS' : 'FAIL'}   断言 ${pass} ok / ${fail} bad`)
console.log('='.repeat(64))
process.exit(fail === 0 ? 0 : 1)
