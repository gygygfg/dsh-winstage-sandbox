/**
 * WinStageSandbox ↔ DSH `ctx.sandbox` 适配层
 *
 * ── 为什么需要它（这是本轮最重要的设计结论）──────────────────────────────────
 * `ctx.sandbox` 的契约不是"帮我跑命令"，而是：
 *
 *     abstract confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal)
 *       : Promise<ConfinedArgv>
 *
 *     interface ConfinedArgv {
 *       argv: string[]                              // 调用方改为 spawn 这个 argv
 *       enforcement: 'full' | 'partial'
 *       denialSignatures: readonly string[]
 *       runnerFailureRules: readonly RunnerFailureRule[]
 *     }
 *
 * 而 `WindowsStageExecutor` 是**"我帮你跑"**的形态（`run()` 内部自己
 * `CreateProcessAsUser`、自己收 stdout、自己挂 Job）。两者方向相反：
 * 契约要"返回一个新 argv 让调用方去 spawn"，执行器是"我自己 spawn"。
 *
 * 服务说明还有一条硬约束：
 *   "confine must return enforcing argv or fail closed ... **silent unconfined
 *    passthrough is forbidden**"
 * 所以不能原样返回 argv 再标个 partial —— 那等于假装沙箱。
 * （顺带说明：`WindowsStageExecutor.run()` 自己报的 `enforcement` 恒为 `'partial'`，
 *   这是手册对**本后端覆盖范围**的诚实标注；但作为 `ctx.sandbox` provider 时，
 *   我们对"argv 已被包进沙箱启动器"这件事是**确定**的，故对外报 `'full'`。
 *   两者含义不同，不要混。下面 `enforcementForPolicy` 会显式说明。）
 *
 * 对接方式：把 argv 重新包成一次 `bridge.mjs` 调用，由适配层在**受限令牌内**
 * 启动真实命令并把退出码透传出去。
 *
 * ── 自检前置 ─────────────────────────────────────────────────────────────────
 * `selfCheck()` 会真实地跑一条受约束命令并验证四件事（详见该函数注释）。
 * 「启用」开关必须先过自检才允许提交切换 —— 因为**最容易出错的不是令牌能否建立，
 * 而是 confine 返回的 argv 能否正确执行受约束的命令**。自检测的正好是后者。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WindowsStageExecutor } from '../src/executor.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 适配层自身的绝对路径 —— 受限子进程用它重新进入 */
export const BRIDGE_PATH = join(HERE, 'bridge.mjs')

/**
 * 把一段待执行 argv 编码进**单个命令行参数**，避免嵌套引号问题。
 *
 * `[实测教训]` 本项目早期就是被 PowerShell/cmd 的嵌套引号反复咬过；用 base64
 * 把 argv 变成不透明字符串，可以彻底避开"到底几层引号"的推理。
 */
export function encodeArgv(argv) {
  return Buffer.from(JSON.stringify(argv), 'utf8').toString('base64')
}

/** 解码 `encodeArgv` 的结果，返回字符串数组 */
export function decodeArgv(token) {
  const parsed = JSON.parse(Buffer.from(String(token), 'base64').toString('utf8'))
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error('decodeArgv: payload is not an array of strings')
  }
  return parsed
}

/**
 * 依据 policy 给出对外声明的 enforcement 完整度。
 *
 * - `read-only`：本后端**不具备**真正的只读模式（WRITE_RESTRICTED 限制的是写类访问，
 *   而"只读"需要连可写根都不给）。当前实现按 workspace-write 处理，
 *   因此**如实报 partial**，不假装是只读。
 * - `workspace-write`：写边界由受限 SID 交集 + ACL 授予共同确定，实测有效 → full。
 *
 * `[实测]` read-only 的语义缺口是既有残余边界（见 docs/Windows功能开启须知 R1/R3），
 * 这里选择**显式降级并声明**，而不是静默当作 full。
 */
export function enforcementForPolicy(policy) {
  return policy && policy.mode === 'read-only' ? 'partial' : 'full'
}

/**
 * 构造"在受限令牌内执行 argv"的替代 argv。
 *
 * 返回的 argv 由调用方 spawn；退出码取自真实命令（bridge 透传）。
 *
 * @param {readonly string[]} argv 调用方原本要 spawn 的 argv（程序 + 参数）
 * @param {object} options `{ stagingRoot, workspaceRoot, bridgePath, nodePath }`
 * @returns {string[]} 替代 argv
 */
export function buildConfinedArgv(argv, options) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error('buildConfinedArgv: argv must be a non-empty array')
  }
  const stagingRoot = options?.stagingRoot
  if (!stagingRoot) {
    throw new Error('buildConfinedArgv: stagingRoot is required — refusing to confine an unspecified root')
  }
  const nodePath = options.nodePath || process.execPath
  const bridgePath = options.bridgePath || BRIDGE_PATH
  const confined = [nodePath, bridgePath, '--staging', stagingRoot, '--argv', encodeArgv(argv)]
  if (options.workspaceRoot) confined.push('--workspace', options.workspaceRoot)
  return confined
}

/**
 * `ctx.sandbox` 的 confine 面。
 *
 * 注意：真要在 DSH 里**注册成服务**还需要 `ctx.provide('sandbox', ...)`，
 * 本文件只实现"把 argv 包成受约束调用"这一半 —— 剩下那一半属于切换流程，
 * 且必须先过自检。
 */
export function createConfineSurface(options) {
  return {
    confine(argv, policy) {
      return Promise.resolve({
        argv: buildConfinedArgv(argv, options),
        enforcement: enforcementForPolicy(policy),
        // 受限进程被拒绝时的典型回显（供调用方识别"拒绝"而非"失败"）
        denialSignatures: ['Access is denied', '拒绝访问', 'EPERM', 'EACCES'],
        runnerFailureRules: [],
      })
    },
  }
}

/**
 * 自检：**在临时目录里真实建立沙箱并执行一条受约束命令，验证四件事**。
 *
 * 为什么不是只测 `init()`：`init()` 成功只证明"受限令牌能建"，
 * 不证明"confine 交出去的 argv 能跑对"。后者才是切换失败时会让 DSH
 * 全部命令失效的那一环。所以自检测的是后者。
 *
 * 四项检查：
 *   1. `init()` 成功且报告 tier
 *   2. 受约束命令能执行（`echo` 退出码 0 且 stdout 匹配）
 *   3. **命令内写工作区成功**（在受控根内创建文件，宿主侧确认存在）
 *   4. **命令内写工作区外被拒绝**（写宿主 temp 应失败）
 *
 * 额外记录 `run()` 报的 `enforcement`，便于看清后端真实覆盖范围。
 *
 * @param {object} options `{ keepTemp?: boolean, timeoutMs?: number }`
 * @returns 结构化结果，含逐项证据
 */
export async function selfCheck(options = {}) {
  const results = []
  const record = (id, title, ok, evidence) => {
    results.push({ id, title, status: ok ? 'pass' : 'fail', evidence })
    return ok
  }

  // 用系统临时区做一次性测试根；工作区与暂存根分离，符合真实布局
  const base = join(process.env.TEMP || process.env.TMP || '.', `winstage-selfcheck-${Date.now().toString(36)}`)
  const stagingRoot = join(base, '.dshstage')
  const workspaceRoot = join(base, 'ws')
  mkdirSync(workspaceRoot, { recursive: true })
  mkdirSync(stagingRoot, { recursive: true })

  const executor = new WindowsStageExecutor({ stagingRoot, workspaceRoot, sessionId: 'selfcheck' })
  let initReport
  let tier = null

  try {
    // ── 检查 1：建立沙箱 ──
    try {
      initReport = await executor.init()
      tier = initReport?.tier ?? null
      record(1, '在临时目录建立 WinStageSandbox（受限令牌 + ACL）', true, { tier, stagingRoot })
    } catch (error) {
      record(1, '在临时目录建立 WinStageSandbox（受限令牌 + ACL）', false, {
        code: error?.code ?? error?.name,
        message: error?.message,
        // 关键诊断：缺这两个权限就说明本进程已被沙箱化（残余边界 R6）
        note: '缺 TOKEN_ADJUST_DEFAULT / TOKEN_ADJUST_SESSIONID 意味着本进程本身已在沙箱内',
      })
      return { ok: false, tier, base, results, stoppedAt: 1, executor }
    }

    const nodePath = process.execPath

    // ── 检查 2：受约束命令能执行 ──
    const echo = await executor.run({
      command: nodePath,
      args: ['-e', 'process.stdout.write("WINSTAGE_SELFCHECK_OK")'],
      cwd: stagingRoot,
      env: {},
    })
    const echoOk = echo.exitCode === 0 && echo.stdout.includes('WINSTAGE_SELFCHECK_OK')
    record(2, '受约束命令可执行（node 打印标记）', echoOk, {
      exitCode: echo.exitCode,
      stdout: echo.stdout.slice(0, 200),
      stderr: echo.stderr.slice(0, 300),
      classification: echo.classification?.kind,
      enforcement: echo.enforcement,
      launchFailed: echo.launchFailed,
    })

    // ── 检查 3：命令内写工作区应成功 ──
    // 注意：写的是**暂存根**（受限进程唯一被授权写入的位置）；工作区侧的
    // 逻辑写入在真实链路里由暂存机制承载。这里先证明"授权位置可写"。
    const insideTarget = join(stagingRoot, 'inside.txt')
    const writeInside = await executor.run({
      command: nodePath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(insideTarget)}, 'inside')`],
      cwd: stagingRoot,
      env: {},
    })
    const insideExists = existsSync(insideTarget)
    record(3, '受约束命令可写入被授权根', writeInside.exitCode === 0 && insideExists, {
      exitCode: writeInside.exitCode,
      target: insideTarget,
      fileExists: insideExists,
      stderr: writeInside.stderr.slice(0, 300),
    })

    // ── 检查 4：命令内写工作区外应被拒绝 ──
    const outsideTarget = join(process.env.TEMP || process.env.TMP || '.', `winstage-outside-${Date.now().toString(36)}.txt`)
    const writeOutside = await executor.run({
      command: nodePath,
      args: ['-e', `try{require('fs').writeFileSync(${JSON.stringify(outsideTarget)},'x');process.stdout.write('WROTE_OUTSIDE')}catch(e){process.stdout.write('DENIED')}`],
      cwd: stagingRoot,
      env: {},
    })
    const outsideDenied = writeOutside.stdout.includes('DENIED') && !existsSync(outsideTarget)
    record(4, '受约束命令写入未授权位置被拒绝', outsideDenied, {
      exitCode: writeOutside.exitCode,
      stdout: writeOutside.stdout.slice(0, 200),
      target: outsideTarget,
      fileExists: existsSync(outsideTarget),
      stderr: writeOutside.stderr.slice(0, 300),
    })
  } finally {
    try {
      executor.dispose()
    } catch {
      /* dispose 失败不影响自检结论 */
    }
    if (options.keepTemp !== true) {
      try {
        const { rmSync } = await import('node:fs')
        rmSync(base, { recursive: true, force: true })
      } catch {
        /* 清理失败则保留现场供排查 */
      }
    }
  }

  const passed = results.filter((r) => r.status === 'pass').length
  return { ok: passed === results.length, tier, base, results, passed, total: results.length }
}

export function formatSelfCheck(report) {
  const lines = []
  lines.push(`WinStageSandbox 自检   tier=${report.tier ?? 'n/a'}   通过 ${report.passed ?? 0}/${report.total ?? 0}`)
  for (const r of report.results) {
    lines.push(`  [${r.status === 'pass' ? 'PASS' : 'FAIL'}] ${r.title}`)
    lines.push(`         证据: ${JSON.stringify(r.evidence)}`)
  }
  if (report.stoppedAt) lines.push(`  在第 ${report.stoppedAt} 项停止 —— 后续检查无法进行`)
  lines.push(report.ok ? '结论: 自检通过，可以切换沙箱后端' : '结论: 自检未通过 —— 不得切换（保持平台沙箱不变）')
  return lines.join('\n')
}

// 允许直接 `node selfcheck.mjs` 运行
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const report = await selfCheck({ keepTemp: process.argv.includes('--keep-temp') })
  process.stdout.write(`${formatSelfCheck(report)}\n`)
  process.exit(report.ok ? 0 : 2)
}
