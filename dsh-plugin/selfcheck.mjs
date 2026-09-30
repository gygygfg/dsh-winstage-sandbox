/**
 * 在"当前进程"里真实尝试建立 WinStageSandbox 沙箱 —— 用于回答一个决定性问题：
 * **这个进程能否创建受限令牌？**
 *
 * 这是"把 DSH 的沙箱后端换成 WinStageSandbox"能否成立的前提。
 * 若本进程已被沙箱化，`CreateRestrictedToken` 会因缺少
 * TOKEN_ADJUST_DEFAULT / TOKEN_ADJUST_SESSIONID 失败（残余边界 R6），
 * 那时换沙箱会让 DSH 的所有命令执行失效。
 *
 * 只在临时目录里建工作区，不触碰任何现有目录。
 *
 * ── FIX-E：本文件原来是"顶层直接执行 + 无守卫 process.exit"───────────────
 * 整段自检写在**模块顶层**，末尾一句 `process.exit(ok ? 0 : 2)` 没有任何守卫。
 * 于是**任何 import 它的上下文都会被它劫持**：自跑一遍（会真实调用
 * `probeWin32Abi()`、真实 `init()`），打印一堆东西，然后用 exit(0)/exit(2)
 * 打断调用者。这不只是"多打几行"——`exit(0)` 会让调用者看起来**成功**。
 *   [实测] `.t\sbx3\logs\import-pkg-selfcheck.out` 只有 `PID = 11540`（12 字节）：
 *   逐模块 import 探测（`.t\sbx3\diag-import.mjs`）在它这里拿不到 `IMPORT-OK`。
 * 现在照 `provider.mjs:265` 的守卫写法：只有"本文件就是入口脚本"时才执行。
 * 影响面：import 本模块变成**零副作用**（无 stdout、无 exit、无临时目录）。
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WindowsStageExecutor } from '../src/executor.mjs'
import { probeWin32Abi } from '../src/capability.mjs'

async function main() {
  const line = (s) => process.stdout.write(`${s}\n`)
  line(`PID = ${process.pid}`)

  // 1) 令牌权限
  const abi = probeWin32Abi()
  const rights = abi?.checks?.tokenRights?.granted ?? {}
  line(`tokenRights: ${JSON.stringify(rights)}`)
  const missing = Object.entries(rights).filter(([, g]) => !g).map(([k]) => k)
  line(`缺少的权限: ${missing.length ? missing.join(', ') : '（无）'}`)

  /**
   * 2) 真实 init。
   *
   * 注意 `stagingRoot` 是**必需**选项（与 workspaceRoot 不同）：它是受限进程唯一
   * 被允许写入的暂存根。缺少它时 `init()` 会在参数校验阶段直接抛
   * `SANDBOX_UNAVAILABLE: stagingRoot is required` —— 那**不会**触及受限令牌创建，
   * 因此不能用来判断"本进程能否建沙箱"。（第一次就是这么误判的。）
   */
  const root = mkdtempSync(join(tmpdir(), 'winstage-swaptest-'))
  const staging = join(root, '.dshstage')
  line(`临时工作区: ${root}`)
  line(`暂存根    : ${staging}`)
  let ok = false
  let detail = ''
  try {
    const ex = new WindowsStageExecutor({ stagingRoot: staging, workspaceRoot: root, sessionId: 'swaptest' })
    const caps = WindowsStageExecutor.capabilities()
    line(`capabilities: aclAvailable=${caps.aclAvailable} aclError=${caps.aclError ?? 'none'}`)
    await ex.init()
    ok = true
    line('init 成功 ✓  —— 说明本进程真的建立了受限令牌')
    try { await ex.dispose?.() } catch { /* 忽略 */ }
  } catch (error) {
    detail = `${error?.code ?? error?.name}: ${error?.message}`
    line(`init 失败 ✗  ${detail}`)
  }
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 忽略 */ }

  line('')
  line(ok ? '结论: 本进程可以建立 WinStageSandbox —— 换沙箱在技术上可行' : `结论: 本进程无法建立 —— ${detail}`)
  return ok ? 0 : 2
}

// 允许直接 `node selfcheck.mjs` 运行（照 provider.mjs:265 的守卫写法）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exit(await main())
}
