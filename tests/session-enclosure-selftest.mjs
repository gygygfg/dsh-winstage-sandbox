/**
 * session-enclosure-selftest —— "子 agent 必须在**同一个**沙箱与审批面里"的离线回归。
 *
 * ── 它守的是什么（用户报障"子 agent 没有包含在沙箱里"）──────────────────────────
 * DSH 给每一次委派一个**自己的**子会话 id（会话头 `parentSession` / `origin:'subagent'`
 * / `delegationDepth`）。而 WinStage 的暂存与审批面是**按会话**分键的
 * （`getReviewService()` 的键 = `canonical(root)#sessionKey`）。两者一撞，就出现：
 *   · 主 agent 的改动落在主会话的 `queue.json`/`review.json` ⇒ 面板看得见；
 *   · 子 agent 的改动落在子会话的存储里 ⇒ **面板一行都不显示**，`/winstage approve`
 *     也批不到 —— 既批不了也拒不了，等于**静默**；
 *   · 身份在 ambient 通道拿不到时还会落到**共享** `.dshstage/`，同样与面板脱节。
 *
 * 本套件把"归属哪个审批面"钉成可执行断言：
 *   A. 纯函数：子会话（任意深度）**逐级向上**归到顶层祖先；拿不到父对象时退回父 id；
 *      未知 id **原样保留**（不猜）；成环要终止。
 *   B. 接线：两个 provider（`ctx.fs` 的 `staging-fs`、`ctx.shell` 的 `shell-executor`）
 *      **都必须**经 `session-identity` 归并，且 `shell-executor` 必须真的读取
 *      `sandboxPolicy.sessionId`（旧代码写"刻意不读"，那正是身份丢失的一半成因）。
 *   C. 变异自证：把归并换成"原样返回子会话 id"，A 段断言必须能红。
 *
 * 零子进程、零注册表、零网络 ⇒ 离线档，任何会话都能跑。
 *
 * 用法：node tests\session-enclosure-selftest.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rootSessionIdFor, rootSessionIdOf } from '../dsh-plugin/session-identity.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

let checks = 0
let failures = 0
function ok(condition, label, detail) {
  checks += 1
  if (condition) {
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    failures += 1
    process.stdout.write(`  ✗ ${label}${detail === undefined ? '' : ` — ${detail}`}\n`)
  }
}

/** 假 ctx：只有 `sessions` 注册表 */
function makeCtx(table) {
  return {
    get: (name) => (name === 'sessions' ? { get: (id) => table.get(id) } : undefined),
  }
}

const root = { id: 'session-root', header: {} }
const mid = { id: 'mid', header: { parentSession: 'session-root', origin: 'subagent', delegationDepth: 1 } }
const child = { id: 'child', header: { parentSession: 'mid', origin: 'subagent', delegationDepth: 2 } }
const ctx = makeCtx(
  new Map([
    ['session-root', root],
    ['mid', mid],
    ['child', child],
  ]),
)

process.stdout.write('=== session-enclosure-selftest ===\n\n[A] 纯函数：归到顶层祖先\n')
ok(rootSessionIdOf(ctx, root) === 'session-root', 'A1 顶层会话返回自身')
ok(rootSessionIdOf(ctx, mid) === 'session-root', 'A2 一级子会话归到顶层')
ok(rootSessionIdOf(ctx, child) === 'session-root', 'A3 二级子会话**逐级**归到顶层（不是只抄一层）')
ok(rootSessionIdFor(ctx, 'child') === 'session-root', 'A4 只给 id（sandboxPolicy.sessionId）也能归到顶层')
ok(rootSessionIdFor(ctx, 'nobody') === 'nobody', 'A5 未知 id **原样保留**（不猜、不改身份）')
ok(rootSessionIdOf(ctx, undefined) === undefined, 'A6 没有会话对象 ⇒ undefined（调用方走共享存储）')
{
  const orphan = { id: 'orphan', header: { parentSession: 'gone' } }
  ok(rootSessionIdOf(makeCtx(new Map()), orphan) === 'gone', 'A7 父对象拿不到 ⇒ 退回父 id（比停在子 id 更接近审批面）')
}
{
  const a = { id: 'a', header: { parentSession: 'b' } }
  const b = { id: 'b', header: { parentSession: 'a' } }
  const cyclic = rootSessionIdOf(makeCtx(new Map([['a', a], ['b', b]])), a)
  ok(typeof cyclic === 'string' && cyclic.length > 0, 'A8 身份成环时终止并给出一个确定 id（不死循环）', String(cyclic))
}

process.stdout.write('\n[B] 接线：两个 provider 都必须归并身份\n')
const stagingFs = readFileSync(join(REPO, 'dsh-plugin', 'staging-fs.mjs'), 'utf8')
const shellExecutor = readFileSync(join(REPO, 'dsh-plugin', 'shell-executor.mjs'), 'utf8')
const identity = readFileSync(join(REPO, 'dsh-plugin', 'session-identity.mjs'), 'utf8')

ok(/from '\.\/session-identity\.mjs'/.test(stagingFs), 'B1 `ctx.fs` 面 import 了 session-identity')
ok(/from '\.\/session-identity\.mjs'/.test(shellExecutor), 'B2 `ctx.shell` 面 import 了 session-identity')
ok(/rootSessionIdFor\(this\.ctx, sandboxPolicy\.sessionId\)/.test(stagingFs), 'B3 `ctx.fs` 对 sandboxPolicy.sessionId 做归并')
ok(/rootSessionIdFor\(this\.ctx, fromSpec\)/.test(shellExecutor), 'B4 `ctx.shell` 对 sandboxPolicy.sessionId 做归并')
ok(/rootSessionIdOf\(ctx, session\)/.test(shellExecutor), 'B5 `ctx.shell` 对 ambient initiator 做归并')
ok(
  !/刻意\**不读 `sandboxPolicy\.sessionId`/.test(shellExecutor),
  'B6 旧的"刻意不读 sandboxPolicy.sessionId"注释不得复活（那正是身份丢失的一半）',
)
ok(/parentSession/.test(identity), 'B7 session-identity 确实按 `parentSession` 向上走')

process.stdout.write('\n[C] 变异自证（负面对照）\n')
{
  // 变异体 = 修复前的行为：原样返回传入的子会话 id。
  const mutated = (session) => session?.id
  const wouldBeChild = mutated(child)
  ok(
    wouldBeChild === 'child' && rootSessionIdOf(ctx, child) === 'session-root',
    'C1 "原样返回子会话 id"的变异体与修好的口径**结果不同** ⇒ A 段断言有分辨力',
    `mutated=${wouldBeChild}`,
  )
  const childKeys = new Set([wouldBeChild])
  const rootKeys = new Set([rootSessionIdOf(ctx, child)])
  ok(!childKeys.has('session-root') && rootKeys.has('session-root'), 'C2 两种口径确实落在不同的审批面键上')
}

const failed = failures > 0
process.stdout.write(`\n断言 ${checks} 项，失败 ${failures} 项\n`)
process.stdout.write(`RESULT: ${failed ? 'FAIL' : 'PASS'} (${checks} checks)\n`)
process.exit(failed ? 1 : 0)
