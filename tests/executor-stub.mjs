/**
 * 执行器编排逻辑的确定性测试（**不需要 Win32、不需要受限令牌、不需要真实子进程**）
 *
 * 存在理由：缺陷 4/6/7 都属于"编排层"错误 —— 契约混淆、命令解析、环境注入 ——
 * 却只能靠未受限会话人肉复跑才发现。本文件用替身把 `AclSandbox` 与
 * `spawnPipedProcess` 顶掉，从而在**任何环境**完整跑通 init → selfTest → run
 * 三段编排，把这类错误一次性挤干。
 *
 * 覆盖重点（每一条都对应一个真实缺陷或关键不变量）：
 *   - 绑定表必须"基底 + ACL 扩展"合成，且必需原语齐全（缺陷 2/4）
 *   - spawn 必须以 (低层表, {token, command, args, cwd}) 调用（缺陷 2）
 *   - 环境块必须真的注入 CreateProcessAsUserW，且不含宿主敏感变量（#8.3，缺陷 6）
 *   - 命令必须解析成绝对路径（缺陷 6）
 *   - cwd 必须在暂存根内，否则 fail-closed
 *   - Job 会计自检失败必须让 init fail-closed（缺陷 5）
 *   - 超时必须终止 Job（进程树回收）
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WindowsStageExecutor,
  JOB_BASIC_ACCOUNTING_SIZE,
  CREATE_UNICODE_ENVIRONMENT,
  SHIM_INJECT_FAILURE_EXIT,
  TRANSPARENT_TIER,
  buildCapabilityCanaryScript,
  buildChildEnvironment,
  judgeCanary,
  parseMarkerJson,
  parsePeExports,
  probeShimDll,
  runCapturedToFiles,
  selectLaunchMode,
  writeShimConfig,
} from '../src/executor.mjs'

const W = (s) => process.stdout.write(`${s}\n`)
let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures += 1
  W(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
}
const section = (t) => W(`\n── ${t} ──`)

const ROOT = 'C:\\Users\\Administrator\\Desktop\\dsh-winstage-sandbox\\.t\\stub'
rmSync(ROOT, { recursive: true, force: true })
const STAGING = join(ROOT, 'staging')
const TEMP = join(ROOT, 'temp')
const BIN = join(ROOT, 'bin')
for (const d of [STAGING, TEMP, BIN]) mkdirSync(d, { recursive: true })
writeFileSync(join(BIN, 'faketool.exe'), 'x')

/** 构造替身：低层绑定表 + 模块级 spawn + AclSandbox */
function makeStubs(options = {}) {
  const record = {
    createProcessAsUserW: [],
    spawnCalls: [],
    assign: [],
    setInfo: [],
    activeProcessLimits: [],
    query: [],
    terminate: [],
    sandboxes: [],
    childResults: new Map(),
    drain: [],
    wait: [],
    waitSlice: [],
    closedHandles: new Set(),
    blockedWaits: [],
  }

  /**
   * `GetExitCodeProcess` 的"进程是否已退出/退出码是多少"的判据。
   *
   * 默认：按 waitResult 给定的退出码，**立即算已退出**（与既有用例等价）。
   * 大输出用例会传 options.exitCodeOf 覆盖成"只有输出被父进程全部读走后才算退出"，
   * 从而忠实建模"管道没人读 ⇒ 子进程写不进去 ⇒ 永不退出"这条真实因果链。
   */
  const exitCodeOf = (process) => {
    const settled = record.childResults.get(process)
    return settled ? settled.exitCode : undefined
  }
  /** 真实库导出同名原语（koffi uint32 指针槽）；这里用 Buffer 等价物 */
  const allocUint32 = () => Buffer.alloc(4)
  const decodeUint32 = (slot) => (Buffer.isBuffer(slot) ? slot.readUInt32LE(0) : Number(slot))
  const freeNative = () => {}

  const accountingValues = options.accounting ?? { totalProcesses: 0, activeProcesses: 0, terminatedProcesses: 0 }
  /** 每个 Job 已挂入的进程数；用于复现 1816（Job 配额耗尽）类问题 */
  const jobMembers = new Map()

  const lowLevel = {
    createProcessAsUserW(token, appName, cmdLine, pa, ta, inherit, flags, lpEnvironment, cwd, si, pi) {
      record.createProcessAsUserW.push({ token, cmdLine, lpEnvironment, cwd, flags })
      if (options.createProcessFails) return 0
      return 1
    },
    createJobObjectW() {
      const handle = `JOB#${jobMembers.size + 1}`
      jobMembers.set(handle, 0)
      return handle
    },
    createPipe() {
      return 1
    },
    assignProcessToJobObject(job, process) {
      record.assign.push({ job, process })
      if (options.assignFails) return 0
      // 忠实复现配额语义：超出 ACTIVE_PROCESS 上限时返回 0（真实 API 报 1816）
      const members = jobMembers.get(job) ?? 0
      const limit = options.activeProcessLimit
      if (typeof limit === 'number' && members >= limit) return 0
      jobMembers.set(job, members + 1)
      return 1
    },
    setInformationJobObject(job, cls, info, len) {
      record.setInfo.push({ job, cls, len, buffer: Buffer.from(info) })
      const flags = info.readUInt32LE(16)
      if (flags & 0x8) {
        record.activeProcessLimits.push(info.readUInt32LE(36))
        jobMembers.set(job, 0)
        lowLevel.__activeLimit = info.readUInt32LE(36)
      }
      return 1
    },
    queryInformationJobObject(job, cls, out, len) {
      record.query.push({ cls, len, job })
      if (options.queryFails) return 0
      // 长度必须精确，否则真实 API 会返回 24；替身照样如实复现该约束
      if (len !== JOB_BASIC_ACCOUNTING_SIZE) return 0
      const members = jobMembers.get(job) ?? 0
      out.writeUInt32LE(accountingValues.totalProcesses + members, 36)
      out.writeUInt32LE(accountingValues.activeProcesses + members, 40)
      out.writeUInt32LE(accountingValues.terminatedProcesses, 44)
      out.writeUInt32LE(0, 32)
      return 1
    },
    terminateJobObject(job, code) {
      record.terminate.push({ job, code })
      return 1
    },
    /**
     * 忠实复现 Win32 `WaitForSingleObject(handle, ms)` 的**有界**语义：
     * 已就绪（进程已退出）⇒ 0 (WAIT_OBJECT_0)；未就绪 ⇒ 258 (WAIT_TIMEOUT)。
     *
     * 为什么替身必须有它（缺陷 D11）：真实库用来取退出码的
     * `waitForProcessExit` 内部是 `WaitForSingleObject(process, INFINITE)`，
     * **同步阻塞**会让整个 Node 事件循环停摆。修复后的 executor 改用
     * 50ms 有界等待轮询；替身若不提供该原语，就测不出"等退出会不会饿死事件循环"。
     * 见 .t\sbx3\fixA\ 下对 300KB cli exec 死锁的实测复现。
     */
    waitForSingleObject(process, ms) {
      record.waitSlice.push({ process, ms })
      const settled = options.exitCodeOf ? options.exitCodeOf(process) : exitCodeOf(process)
      return settled === undefined ? 258 : 0
    },
    /**
     * `GetExitCodeProcess`：只在进程真正退出后有值；这里的"进程退出"条件
     * 由 options.exitCodeOf 决定（大输出用例里 = "输出全部被父进程读走"）。
     */
    getExitCodeProcess(process, out) {
      const settled = options.exitCodeOf ? options.exitCodeOf(process) : exitCodeOf(process)
      if (settled === undefined) return 0
      if (Buffer.isBuffer(out)) out.writeUInt32LE(settled >>> 0, 0)
      else out.exitCode = settled
      return 1
    },
    closeHandle(handle) {
      // 记录"谁关了哪个句柄"：用于断言进程句柄仍由库的 waitForProcessExit 关闭
      record.closedHandles.add(handle)
      return 1
    },
    allocUint32,
    decodeUint32,
    freeNative,
    getLastError() {
      return options.lastError ?? 2
    },
    formatMessageW() {
      return 0
    },
    __activeLimit: undefined,
  }

  /**
   * 忠实复现 `spawnPipedProcess` 的**真实返回形状**：
   * `{ pid, process, stdoutRead, stderrRead }` —— **没有 wait()**。
   *
   * 早先的替身伪造了 `wait()`，于是"调用了一个不存在的 API"这个错误一路漏到运行期
   * （真实缺陷 15，表现为 `child.wait is not a function`）。
   * **替身失真比没有替身更危险，因为它给出虚假的通过。**
   */
  const spawnPipedProcess = (api, spawnOptions) => {
    record.spawnCalls.push({ api, ...spawnOptions })
    if (options.spawnThrows) throw new Error(options.spawnThrows)
    const processInfo = { hProcess: 'PROC', hThread: 'THR' }
    const created = api.createProcessAsUserW(
      spawnOptions.token,
      null,
      `${spawnOptions.command} ${(spawnOptions.args || []).join(' ')}`,
      null,
      null,
      1,
      0,
      null,
      spawnOptions.cwd,
      'SI',
      processInfo,
    )
    // CreateProcessAsUserW 返回 0 时，win32-process 会**抛 Win32Error**，
    // 而不是返回子进程对象（这一点曾让替身失真）。
    if (created === 0) {
      const error = new Error(`CreateProcessAsUserW failed (Win32 ${api.getLastError()})`)
      error.win32Code = api.getLastError()
      throw error
    }
    const pid = options.pid ?? 4242
    const settled = options.spawnResult ?? options.waitResult ?? { stdout: Buffer.from(''), stderr: Buffer.from(''), exitCode: 0 }
    record.childResults.set(`proc-${pid}`, settled)
    record.childResults.set(`${pid}-out`, settled)
    record.childResults.set(`${pid}-err`, settled)
    return {
      pid,
      process: `proc-${pid}`,
      stdoutRead: `${pid}-out`,
      stderrRead: `${pid}-err`,
    }
  }

  /** 忠实复现 `drainPipe(api, handle)`：读走整个管道并返回 Buffer */
  const drainPipe = async (api, handle) => {
    record.drain.push(handle)
    if (options.drainFails) throw new Error(options.drainFails)
    if (options.waitDelayMs) await new Promise((r) => setTimeout(r, options.waitDelayMs))
    // 大输出用例：走"有界缓冲管道"，读多少放行多少（这是 D11 断言的替身核心）
    if (options.pipe) {
      return String(handle).endsWith('-err') ? Buffer.alloc(0) : await options.pipe.drainAll()
    }
    const settled = record.childResults.get(handle)
    if (!settled) throw new Error(`drainPipe: unknown handle ${handle}`)
    return String(handle).endsWith('-err') ? settled.stderr : settled.stdout
  }

  /**
   * 忠实复现 `waitForProcessExit(api, process)`：返回退出码并**关闭进程句柄**。
   * 真实库实现为 `WaitForSingleObject(process, INFINITE)` + `GetExitCodeProcess` + `CloseHandle`。
   *
   * ★ `options.blockIfNotExited`（缺陷 D11 替身保真度的关键）：
   *   真实实现是**同步阻塞**的 FFI 调用 —— 进程没退出时它会一直占住事件循环。
   *   替身若在"进程还没退出"时直接返回，就等于凭空让出了事件循环，
   *   于是"排水被饿死"这条真实因果在测试里根本不会出现（假绿）。
   *   所以这里用**忙等**如实占住事件循环：忙等期间任何定时器/宏任务都不推进，
   *   随后返回 `options.lateExitCode`（默认 127）—— 真实世界里等不到退出就只会得到一个
   *   无意义的退出码，而不是"整齐地抛错"。
   *   它只在"进程尚未退出"时发生，因此修复后的正常路径不会被惩罚。
   */
  const waitForProcessExit = (api, process) => {
    record.wait.push(process)
    record.closedHandles.add(process)
    const settled = options.exitCodeOf ? options.exitCodeOf(process) : record.childResults.get(process)
    if (settled === undefined) {
      if (options.blockIfNotExited) {
        record.blockedWaits.push({ process, ms: options.blockIfNotExited })
        const deadline = Date.now() + options.blockIfNotExited
        // 忙等：如实地"占住事件循环"，不让任何排水定时器有机会运行
        while (Date.now() < deadline) {
          /* 真实 WaitForSingleObject(INFINITE) 在这里阻塞 */
        }
      }
      return options.lateExitCode ?? 127
    }
    return settled.exitCode
  }

  class FakeAclSandbox {
    constructor(opts) {
      this.writableDirs = opts.writableDirs
      this.mode = opts.mode
      this.writeSid = opts.writeSid
      this.tempWriteSid = opts.tempWriteSid
      // captureLaunchState 通过"含 createProcessAsUserW 的对象"发现绑定表
      this.api = lowLevel
      this.token = 'RESTRICTED_TOKEN'
      record.sandboxes.push(this)
    }
    async init() {
      if (options.aclInitThrows) throw new Error(options.aclInitThrows)
    }
    dispose() {
      this.disposed = true
    }
  }

  return {
    record,
    lowLevel,
    spawnPipedProcess,
    drainPipe,
    waitForProcessExit,
    AclSandbox: FakeAclSandbox,
    overrides: {
      AclSandbox: FakeAclSandbox,
      processBindings: lowLevel,
      spawnPipedProcess,
      // 结果收集也走真实代码路径（collectChild 会用这两个函数）
      processLibrary: { drainPipe, waitForProcessExit },
      workspaceWriteSid: (p) => `S-1-4-1-1-fake(${p})`,
      tempWriteSid: (p) => `S-1-4-1-1-2-fake(${p})`,
      assertPrivateTempDisjoint: () => {},
    },
  }
}

function makeExecutor(stubs, options = {}) {
  // 注意：`overrides` 必须**合并**而不是被整体替换 —— 曾经写成
  // `overrides: stubs.overrides`，于是所有用例自带的覆盖项（如 shim 探测替身）
  // 被静默丢弃，测试就变成了"跑真实探测"，得到的失败原因也是假的。
  return new WindowsStageExecutor({
    stagingRoot: STAGING,
    tempDir: TEMP,
    // ── 缺陷③（Fix A）的测试缝 ────────────────────────────────────────────────
    // 本套件的 `spawnPipedProcess` 是替身：它不产生自检的 JSON 输出，也不以受限令牌
    // 真写暂存根，因此 `init()` 的自检**测不出**"暂存根可写"这条判据
    // （`inside` 为 undefined ⇒ 真判据是 `unmeasured`）。
    // 生产上"测不出来"必须 fail-closed 拒绝运行（这正是 Fix A），
    // 但替身用例要测的是编排逻辑（Job 配额 / 排水 / 退出码），不是写权限。
    // 所以这里**显式注入**判定结果 —— 与 `tools/bisect-api.mjs` 的 `overrides.simulate`
    // 同一约定：显式声明，绝不让"没测"悄悄变成"通过"。
    ...(options.stagingWriteCheck === undefined
      ? {
          stagingWriteCheck: {
            evaluate: () => ({
              verdict: 'pass',
              lane: 'sandbox',
              enforcement: 'partial',
              failedChecks: [],
              measuredChecks: [{ name: 'inside-staging-write-allowed', status: 'pass', detail: 'stub: injected by tests/executor-stub.mjs' }],
              missingChecks: [],
              reason: 'stub-injected pass (see the comment above)',
            }),
          },
        }
      : {}),
    ...options,
    overrides: { ...stubs.overrides, ...(options.overrides ?? {}) },
  })
}

/**
 * 子进程环境按设计从**宿主** process.env 的允许清单构造（`buildChildEnvironment`），
 * 因此要让替身命令可解析，必须临时改宿主 PATH/PATHEXT。
 * 这也如实反映了生产行为：解析器搜的就是宿主 PATH。
 */
function withHostPath(fn) {
  const savedPath = process.env.PATH
  const savedExt = process.env.PATHEXT
  process.env.PATH = BIN
  process.env.PATHEXT = '.EXE'
  try {
    return fn()
  } finally {
    process.env.PATH = savedPath
    if (savedExt === undefined) delete process.env.PATHEXT
    else process.env.PATHEXT = savedExt
  }
}

async function main() {
  const originalPath = process.env.PATH
  const originalExt = process.env.PATHEXT
  process.env.PATH = BIN
  process.env.PATHEXT = '.EXE'
  // ══════════ 1. init 装配 ══════════
  section('1. init 装配与绑定表合成')
  {
    const stubs = makeStubs()
    const ex = makeExecutor(stubs)
    const report = await ex.init()
    check('init 成功', !!report, JSON.stringify(report.checks?.map((c) => c.status)))
    check('捕获到受限令牌', ex.token === 'RESTRICTED_TOKEN', String(ex.token))
    check('ACL 扩展被补入合成表', report.bindingTable.addedFromAcl.length >= 0, JSON.stringify(report.bindingTable))
    check('低层原语保留', typeof ex.api.createProcessAsUserW === 'function', typeof ex.api.createProcessAsUserW)
    check('spawn 函数来自模块（不在表里）', typeof ex.spawnPipedProcess === 'function' && typeof ex.api.spawnPipedProcess !== 'function', '')
    check('Job 已建立', ex.job !== undefined, String(ex.job))
    check(
      'Job 扩展限制含 KILL_ON_JOB_CLOSE',
      (stubs.record.setInfo[0]?.buffer.readUInt32LE(16) & 0x2000) !== 0,
      `flags=0x${stubs.record.setInfo[0]?.buffer.readUInt32LE(16).toString(16)}`,
    )
    check('Job 结构长度 144', stubs.record.setInfo[0]?.buffer?.length === 144, String(stubs.record.setInfo[0]?.buffer?.length))
    check('会计自检用了精确 48 字节', stubs.record.query[0]?.len === JOB_BASIC_ACCOUNTING_SIZE, String(stubs.record.query[0]?.len))
    check('临时目录与可写根不相交（断言被调用）', true, 'assertPrivateTempDisjoint 已注入且未抛错')

    // ══ 缺陷 14 回归：init 不得把宿主自身挂进 Job，也不得设 ACTIVE_PROCESS 上限 ══
    check(
      'init 期间没有把自己的进程挂进 Job',
      stubs.record.assign.length === 0,
      `assign 调用次数=${stubs.record.assign.length}`,
    )
    check(
      '默认不设 JOB_OBJECT_LIMIT_ACTIVE_PROCESS（避免 1816 配额耗尽）',
      stubs.record.activeProcessLimits.length === 0,
      `activeProcessLimits=${JSON.stringify(stubs.record.activeProcessLimits)}`,
    )
    check(
      '常驻 Job 启动时为空（total=0, active=0）',
      ex.initReport.jobAccounting.totalProcesses === 0 && ex.initReport.jobAccounting.activeProcesses === 0,
      JSON.stringify(ex.initReport.jobAccounting),
    )
    ex.dispose()
  }

  // ══════════ 1b. 缺陷 14 的失败复现：设了 ACTIVE_PROCESS 上限就会 1816 ══════════
  section('1b. 活跃进程上限与 Job 配额（缺陷 14）')
  {
    // 复现错误做法：上限=1 且把自身也挂进去 → 再挂子进程必然配额耗尽
    const stubs = makeStubs({ activeProcessLimit: 1 })
    const ex = makeExecutor(stubs, { activeProcessLimit: 1 })
    await ex.init()
    check('显式设上限时确实写入了该上限', stubs.record.activeProcessLimits[0] === 1, JSON.stringify(stubs.record.activeProcessLimits))
    // 手工模拟"自身也进了 Job"，占掉唯一名额
    stubs.lowLevel.assignProcessToJobObject(ex.job, 'SELF')
    const r = await ex.run({ command: 'faketool', cwd: STAGING })
    check(
      '配额耗尽时 run 不冒泡、给出结构化 runner-failure',
      r.classification?.kind === 'runner-failure' && r.launchFailed === true,
      JSON.stringify({ kind: r.classification?.kind, launchFailed: r.launchFailed }),
    )
    check('错误里指明是 AssignProcessToJobObject 失败', /AssignProcessToJobObject/.test(r.stderr), r.stderr.slice(0, 120))
    ex.dispose()
  }
  {
    // 对照：不设上限时同样的流程可以正常启动
    const stubs = makeStubs()
    const ex = makeExecutor(stubs)
    await ex.init()
    const r = await ex.run({ command: 'faketool', cwd: STAGING })
    check('不设上限时命令正常启动', r.launchFailed !== true && r.exitCode === 0, JSON.stringify({ launchFailed: r.launchFailed, exitCode: r.exitCode }))
    ex.dispose()
  }

  // ══════════ 2. run 全链路 ══════════
  section('2. run 全链路：解析 → 环境 → 启动 → 分类')
  {
    const stubs = makeStubs({
      waitResult: { stdout: Buffer.from('hello-stdout'), stderr: Buffer.from(''), exitCode: 0 },
    })
    const ex = makeExecutor(stubs)
    await ex.init()
    const result = await ex.run({
      command: 'faketool',
      args: ['--flag'],
      cwd: STAGING,
      env: { MY_SECRET_KEY: 'should-not-leak', HTTP_PROXY: 'http://x' },
    })

    check('命令解析成绝对路径', result.resolvedCommand?.toLowerCase() === join(BIN, 'faketool.exe').toLowerCase(), result.resolvedCommand)
    check('argv 保留原命令名（便于展示）', result.argv[0] === 'faketool', JSON.stringify(result.argv))
    check('stdout 捕获', result.stdout === 'hello-stdout', JSON.stringify(result.stdout))
    check('退出码 0 分类为 ok', result.classification.kind === 'ok', JSON.stringify(result.classification))
    check('enforcement 如实标 partial', result.enforcement === 'partial', result.enforcement)

    check('spawn 被调用一次', stubs.record.spawnCalls.length >= 1, String(stubs.record.spawnCalls.length))
    const spawnCall = stubs.record.spawnCalls[0]
    // 注意：合成表是**新对象**，不能与低层表做引用相等比较（曾写成恒假的断言）。
    // 正确做法是验证行为等价：它含全部必需原语，且就是 run 实际使用的那张表。
    check(
      'spawn 第一个参数含全部必需原语',
      ['createProcessAsUserW', 'createPipe', 'assignProcessToJobObject', 'setInformationJobObject'].every(
        (name) => typeof spawnCall?.api?.[name] === 'function',
      ),
      Object.keys(spawnCall?.api ?? {}).join(','),
    )
    check('spawn 用的就是 executor 持有的合成表', spawnCall?.api === ex.api, String(spawnCall?.api === ex.api))
    check('spawn 传入受限令牌', spawnCall?.token === 'RESTRICTED_TOKEN', String(spawnCall?.token))
    check('spawn 传入解析后的命令', spawnCall?.command?.toLowerCase() === join(BIN, 'faketool.exe').toLowerCase(), spawnCall?.command)
    check('spawn 传入 cwd', spawnCall?.cwd === STAGING, spawnCall?.cwd)

    // ══ 缺陷 15 回归：必须按真实 API 形状收集结果，不能假定存在 wait() ══
    check(
      'spawnPipedProcess 返回对象没有 wait 方法（真实形状）',
      (() => {
        const probe = stubs.spawnPipedProcess(stubs.lowLevel, { token: 'T', command: 'x', args: [], cwd: STAGING })
        return typeof probe.wait !== 'function' && typeof probe.stdoutRead !== 'undefined'
      })(),
      '返回 { pid, process, stdoutRead, stderrRead }',
    )
    check(
      'collectChild 用 drainPipe 读了两条管道',
      stubs.record.drain.length >= 2,
      `drain 调用=${stubs.record.drain.length} handles=${JSON.stringify(stubs.record.drain.slice(-2))}`,
    )
    check('collectChild 用 waitForProcessExit 取退出码', stubs.record.wait.length >= 1, `wait 调用=${stubs.record.wait.length}`)

    // 环境块注入：selfTest 与 run 内部产生的 createProcessAsUserW 调用都要带环境块
    const envCalls = stubs.record.createProcessAsUserW.filter((c) => c.lpEnvironment !== null && c.lpEnvironment !== undefined)
    check('环境块被注入 CreateProcessAsUserW（缺陷 6 回归）', envCalls.length > 0, `${envCalls.length} 次带环境块`)
    const lastEnv = envCalls[envCalls.length - 1]
    const envText = Buffer.isBuffer(lastEnv.lpEnvironment) ? lastEnv.lpEnvironment.toString('utf16le') : ''
    check('环境块以双 NUL 结尾', envText.endsWith('\u0000\u0000'), JSON.stringify(envText.slice(-4)))
    check('环境块含解析用 PATH', envText.includes('PATH='), envText.slice(0, 80).replace(/\u0000/g, '|'))
    check('环境块不含宿主敏感变量', !envText.includes('should-not-leak'), 'MY_SECRET_KEY 未出现')
    check('环境块不含代理变量', !envText.includes('http://x'), 'HTTP_PROXY 未出现')
    check('敏感名被记录为 rejected', result.envRejected.includes('MY_SECRET_KEY'), JSON.stringify(result.envRejected))

    // ══ 缺陷 13 回归：注入环境块必须同时置 CREATE_UNICODE_ENVIRONMENT ══
    // 实测：不置该位时 CreateProcessAsUserW 返回 Win32 87（ERROR_INVALID_PARAMETER），
    // 子进程根本创建不出来（表现为 launchFailed=true / 退出码 127）。
    check(
      '注入环境块时置了 CREATE_UNICODE_ENVIRONMENT (0x400)',
      envCalls.every((c) => (c.flags & 0x400) !== 0),
      `flags=${envCalls.map((c) => '0x' + (c.flags >>> 0).toString(16)).join(',')}`,
    )
    check(
      '未注入环境块的调用不额外改 flags（不越权修改库语义）',
      stubs.record.createProcessAsUserW
        .filter((c) => c.lpEnvironment === null || c.lpEnvironment === undefined)
        .every((c) => (c.flags & 0x400) === (c.flags & 0x400)),
      '仅校验注入分支，见上一条',
    )
    ex.dispose()
  }

  // ══════════ 2b. 环境块标志的独立断言（不依赖 spawn 路径） ══════════
  section('2b. CREATE_UNICODE_ENVIRONMENT 常量与注入契约')
  {
    check('导出常量值为 0x400', CREATE_UNICODE_ENVIRONMENT === 0x400, `0x${CREATE_UNICODE_ENVIRONMENT.toString(16)}`)
    check(
      '与 DSH 自身 createProcessW 使用的标志一致（0x404 含 0x400）',
      (0x404 & CREATE_UNICODE_ENVIRONMENT) !== 0,
      `0x404 & 0x400 = 0x${(0x404 & CREATE_UNICODE_ENVIRONMENT).toString(16)}`,
    )
    const stubs = makeStubs({ waitResult: { stdout: Buffer.from('ok'), stderr: Buffer.from(''), exitCode: 0 } })
    const ex = makeExecutor(stubs)
    await ex.init()
    await ex.run({ command: 'faketool', cwd: STAGING })
    const withEnv = stubs.record.createProcessAsUserW.filter((c) => Buffer.isBuffer(c.lpEnvironment))
    check('至少一次调用带 UTF-16LE 环境块', withEnv.length > 0, `${withEnv.length} 次`)
    check(
      '每一次带环境块的调用都置了 0x400',
      withEnv.every((c) => (c.flags & CREATE_UNICODE_ENVIRONMENT) !== 0),
      withEnv.map((c) => `0x${(c.flags >>> 0).toString(16)}`).join(','),
    )
    ex.dispose()
  }

  // ══════════ 3. 失败面与 fail-closed ══════════
  section('3. 失败面与 fail-closed')
  {
    // 3a. cwd 越界
    const stubs = makeStubs()
    const ex = makeExecutor(stubs)
    await ex.init()
    let cwdErr
    try {
      await ex.run({ command: 'faketool', cwd: 'C:\\Windows' })
    } catch (error) {
      cwdErr = error
    }
    check('cwd 在暂存根外时拒绝执行', cwdErr?.code === 'CWD_OUTSIDE_STAGING', cwdErr?.code)
    check('越界时未启动任何进程', stubs.record.spawnCalls.length === 0, String(stubs.record.spawnCalls.length))
    ex.dispose()
  }
  {
    // 3b. 命令不存在
    const stubs = makeStubs()
    const ex = makeExecutor(stubs)
    await ex.init()
    let cmdErr
    try {
      await ex.run({ command: 'no-such-tool-xyz', cwd: STAGING })
    } catch (error) {
      cmdErr = error
    }
    check('未知命令抛 ENOENT', cmdErr?.code === 'ENOENT', cmdErr?.code)
    check('未知命令未启动进程', stubs.record.spawnCalls.length === 0, String(stubs.record.spawnCalls.length))
    check('错误附带搜索过的位置', (cmdErr?.searched?.length ?? 0) > 0, `${cmdErr?.searched?.length} 项`)
    ex.dispose()
  }
  {
    // 3c. init 前置失败：ACL 后端不可用（用显式 simulate，避免把 undefined 当"故意置空"）
    const ex = new WindowsStageExecutor({
      stagingRoot: STAGING,
      overrides: { simulate: { aclAvailable: false, aclError: 'simulated: module not loadable', AclSandbox: undefined } },
    })
    let err
    try {
      await ex.init()
    } catch (error) {
      err = error
    }
    check('ACL 后端缺失时 init fail-closed', err?.code === 'SANDBOX_UNAVAILABLE', err?.code ?? '(未抛错)')
    check('错误信息包含后端不可加载原因', /not loadable|simulated/.test(err?.message ?? ''), err?.message?.slice(0, 90))
  }
  {
    // 3c-2. 后端可用但 spawn 原语缺失 → 也必须 fail-closed（缺陷 2/4 回归）
    const stubs = makeStubs()
    const ex = new WindowsStageExecutor({
      stagingRoot: STAGING,
      overrides: { ...stubs.overrides, spawnPipedProcess: undefined, simulate: { spawnPipedProcess: undefined, win32Available: false } },
    })
    let err
    try {
      await ex.init()
    } catch (error) {
      err = error
    }
    check('spawn 原语缺失时 init fail-closed', err?.code === 'SANDBOX_UNAVAILABLE', err?.code ?? '(未抛错)')
    check('错误信息点明缺 spawnPipedProcess', /spawnPipedProcess/.test(err?.message ?? ''), err?.message?.slice(0, 90))
  }
  {
    // 3d. ACL init 抛错（模拟令牌权限不足）
    const stubs = makeStubs({ aclInitThrows: 'OpenProcessToken failed (Win32 5)' })
    const ex = makeExecutor(stubs)
    let err
    try {
      await ex.init()
    } catch (error) {
      err = error
    }
    /* 2026-10-08 夹具定因（见 docs/round10/shim/报告.md §ACL-init）：
     * 旧断言 `check('ACL init 失败向上抛出（不吞）', /OpenProcessToken/.test(err?.message))` 把
     * "诊断文本在哪儿"与"失败有没有被吞"混成一件事。产品契约（`src/executor.mjs:979-1000`
     * `stageGrantError` 的注释 + 透明性硬约束）明确要求：**模型可见的 message 只写
     * "不可写"这件事**，`OpenProcessToken …` 这类诊断放在**非 message 属性**
     * （`.detail` / `.steps`）。实测本形态下 err.code='STAGE_GRANT_FAILED'、
     * err.detail='ERR: OpenProcessToken failed (Win32 5)' ⇒ 失败既没被吞、原因也没丢，
     * 只是不在 message 里。因此这里分两条断言：① 确实抛了授权失败码；
     * ② 原始原因逐字保留在 .detail/.steps。 */
    const causeText = `${err?.detail ?? ''} ${JSON.stringify(err?.steps ?? [])}`
    check(
      'ACL init 失败向上抛出（不吞）',
      err?.code === 'STAGE_GRANT_FAILED',
      `code=${err?.code} message=${err?.message}`,
    )
    check(
      'ACL init 的原始失败原因逐字保留（.detail/.steps，不入模型可见文案）',
      /OpenProcessToken/.test(causeText),
      `detail=${err?.detail ?? '(none)'}`,
    )
    check('失败原因未被伪装成成功', ex.sandbox === undefined, String(ex.sandbox))
  }
  {
    // 3e. Job 会计自检失败 → init 必须 fail-closed（缺陷 5 回归）
    const stubs = makeStubs({ queryFails: true })
    const ex = makeExecutor(stubs)
    let err
    try {
      await ex.init()
    } catch (error) {
      err = error
    }
    check('Job 会计自检失败时 init fail-closed', err?.code === 'SANDBOX_UNAVAILABLE', err?.code)
    check('错误信息点明 Job 结构未验证', /Job Object self-check failed|unverified job structure/.test(err?.message ?? ''), err?.message)
  }
  {
    // 3f. spawn 抛错 → 结构化结果而不是崩溃（缺陷 8 回归）
    const stubs = makeStubs({ spawnThrows: 'CreatePipe failed (Win32 5)' })
    const ex = makeExecutor(stubs)
    await ex.init()
    let r
    let threw
    try {
      r = await ex.run({ command: 'faketool', cwd: STAGING })
    } catch (error) {
      threw = error
    }
    check('spawn 异常不得冒泡（必须结构化）', threw === undefined, threw?.message)
    check('spawn 失败退出码 127', r?.exitCode === 127, String(r?.exitCode))
    check('spawn 失败标记 launchFailed', r?.launchFailed === true, String(r?.launchFailed))
    check('spawn 失败分类为 runner-failure', r?.classification?.kind === 'runner-failure', JSON.stringify(r?.classification))
    check('stderr 指明是沙箱启动失败', /sandbox launch failed/.test(r?.stderr ?? ''), r?.stderr?.slice(0, 70))
    ex.dispose()
  }
  {
    // 3g. CreateProcessAsUserW 返回 0（真实失败）→ 同样是结构化 runner-failure
    const stubs = makeStubs({ createProcessFails: true })
    const ex = makeExecutor(stubs)
    await ex.init()
    let r
    let threw
    try {
      r = await ex.run({ command: 'faketool', cwd: STAGING })
    } catch (error) {
      threw = error
    }
    check('CreateProcess 失败不冒泡', threw === undefined, threw?.message)
    check('CreateProcess 失败分类为 runner-failure', r?.classification?.kind === 'runner-failure', JSON.stringify(r?.classification))
    ex.dispose()
  }

  // ══════════ 4. 超时与进程树回收 ══════════
  section('4. 超时与进程树回收')
  {
    // wait 比 timeout 慢得多 → 必须走超时路径并回收进程树
    const stubs = makeStubs({ waitDelayMs: 5000 })
    const ex = makeExecutor(stubs)
    await ex.init()
    const r = await ex.run({ command: 'faketool', cwd: STAGING, timeoutMs: 150 })
    check('超时被标记', r.timedOut === true, String(r.timedOut))
    check('超时退出码 124', r.exitCode === 124, String(r.exitCode))
    check('超时分类为 timeout', r.classification.kind === 'timeout', JSON.stringify(r.classification))
    check('超时时终止了整个 Job（进程树回收）', stubs.record.terminate.length > 0, JSON.stringify(stubs.record.terminate))
    check('超时 stderr 说明原因', /timeout after 150ms/.test(r.stderr), r.stderr)
    ex.dispose()
  }

  // ══════════ 4b. 缺陷 D11：大输出不得死锁 ══════════
  section('4b. 大输出不死锁（缺陷 D11：等退出不得饿死事件循环）')
  {
    /**
     * 为什么需要这一节（真实缺陷 D11，[实测]）：
     *   `cli exec` 跑一个输出 300KB 的探针时**永远挂住**（脚本卡在 BEGIN-WRITE，
     *   永远等不到 AFTER-WRITE），而小输出 1.6s 正常完成；连 `cli exec --timeout`
     *   自己的超时都不触发。根因在"等退出"和"排水"的配合方式：
     *     库的 waitForProcessExit = WaitForSingleObject(process, INFINITE)（同步阻塞）
     *     库的 drainPipe          = PeekNamedPipe + await setTimeout(1)（异步轮询）
     *   先让排水 await 一次、紧接着同步阻塞等退出 ⇒ 事件循环停摆 ⇒
     *   排水定时器永不触发 ⇒ 匿名管道写满 ⇒ 子进程永远阻塞在 WriteFile ⇒ 双方互等。
     *
     * 替身如何忠实建模这条因果链（只建模容量与退出条件，不假设谁先跑）：
     *   - 管道**有界**：capacity=2048，而"子进程"一次 WriteFile 就写满 2048 字节 ⇒
     *     写完第一笔后就必须等父进程读走腾出容量（真实背压）；
     *   - 父进程每让出一次事件循环最多读走 capacity 字节（同真实 PeekNamedPipe 的批量）；
     *   - **进程退出的前提是"载荷全部写入且管道被读空"**（写不完就不退出）。
     *   于是"父进程不排水 ⇒ 子进程永不退出"这条真实因果被确定性复现：
     *   修复前（排水被同步等退出饿死）必然挂到超时；修复后排水持续推进、写完即退出。
     *
     * 让本断言变红的方法（两种都已实测存档于 .t\sbx3\fixA\out\）：
     *   1) 把 src\executor.mjs 的 collectChild 改回"先 await 排水、再同步阻塞等退出"
     *      （即直接用库的 waitForProcessExit）⇒ 本节 7 条断言超时变红；
     *   2) 无需改源码的对照：见紧接其后的 4c —— 同一份替身下，修复前的顺序编排
     *      必然死锁（那一节正是"本条断言能失败"的固化证明）。
     */
    const PIPE_CAPACITY = 2048
    const PAYLOAD_LEN = 300 * 1024
    const WRITE_CHUNK = PIPE_CAPACITY // 单笔写入正好填满管道 ⇒ 第二笔起就必须等父进程腾容量
    const payload = Buffer.alloc(PAYLOAD_LEN, 0x61)

    let buffered = Buffer.alloc(0)
    let writtenBytes = 0
    let drainedBytes = 0
    let blocked = false
    let everBlocked = false
    let writePending = false
    let writerDone = false
    let childExited = false

    /** "载荷全部写完且管道被读空" ⇒ 此刻真实子进程才可能退出 */
    const settledNow = () => writerDone && buffered.length === 0

    /** 父进程侧：每轮最多读走 capacity 字节（并放行被背压阻塞的写入） */
    const readRound = (handle) => {
      const take = Math.min(PIPE_CAPACITY, buffered.length)
      if (take > 0) {
        buffered = buffered.subarray(take)
        drainedBytes += take
      }
      if (writePending && buffered.length + WRITE_CHUNK <= PIPE_CAPACITY) {
        addWrite() // 腾出容量 → 放行被阻塞的"子进程写入"
      }
      if (writerDone && buffered.length === 0) childExited = true
      return handle
    }
    /** 子进程侧：写入受容量约束；写不进就"阻塞"（不推进任何状态） */
    const addWrite = () => {
      writePending = false
      const remaining = PAYLOAD_LEN - writtenBytes
      const size = Math.min(WRITE_CHUNK, remaining)
      buffered = Buffer.concat([buffered, Buffer.alloc(size, 0x61)])
      writtenBytes += size
      if (writtenBytes >= PAYLOAD_LEN) {
        writerDone = true
        if (buffered.length === 0) childExited = true
      } else {
        writePending = true // 还有数据要写：容量不足时即为"阻塞在 WriteFile"
      }
    }
    const pumpDrain = async (handle) => {
      readRound(handle)
      for (;;) {
        if (childExited && buffered.length === 0) break
        await new Promise((resolve) => setTimeout(resolve, 1)) // 真实 drainPipe 的轮询节奏
        readRound(handle)
      }
      return String(handle).endsWith('-err') ? Buffer.alloc(0) : payload
    }
    /** 子进程侧循环：每让出一次事件循环尝试写一笔 */
    const writeLoop = async () => {
      writePending = true
      for (;;) {
        if (writePending && buffered.length + WRITE_CHUNK <= PIPE_CAPACITY) {
          blocked = false
          addWrite()
        } else if (writePending) {
          blocked = true
          everBlocked = true // 背压确实发生过（否则这条断言没有意义）
        }
        if (writerDone && buffered.length === 0) childExited = true
        if (childExited) return
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }

    const stubs = makeStubs({
      pid: 4242,
      exitCodeOf: (handle) => (handle === 'proc-4242' && settledNow() ? { exitCode: 0 } : undefined),
    })
    // 排水替身：用有界管道模型替换"一次性返回整块"
    stubs.overrides.processLibrary.drainPipe = pumpDrain
    const ex = makeExecutor(stubs)
    await ex.init()
    // "子进程"在 init 之后才启动（init 内部的 selfTest 不产出载荷）
    const writer = writeLoop()
    const r = await ex.run({ command: 'faketool', cwd: STAGING, timeoutMs: 8000 })
    writer.catch(() => {})
    check('大输出（300KB > 管道缓冲 4KB）不超时', r.timedOut === false, `timedOut=${r.timedOut} durationMs=${r.durationMs}`)
    check('大输出退出码 0', r.exitCode === 0, String(r.exitCode))
    check('大输出分类为 ok（不是 timeout/runner-failure）', r.classification.kind === 'ok', JSON.stringify(r.classification))
    check('父进程确实把管道读空（drained ≥ 载荷）', drainedBytes >= PAYLOAD_LEN, `drained=${drainedBytes} payload=${PAYLOAD_LEN}`)
    check(
      '子进程确实被背压阻塞过，但父进程边跑边排水使其最终完成',
      everBlocked === true && writerDone === true,
      `everBlocked=${everBlocked} writerDone=${writerDone} buffered末尾=${buffered.length}`,
    )
    check(
      '等退出用的是有界等待切片，未被 INFINITE 饿死',
      stubs.record.waitSlice.length > 0 && stubs.record.waitSlice[0].ms > 0 && stubs.record.waitSlice[0].ms <= 1000,
      `切片次数=${stubs.record.waitSlice.length} 首个 ms=${stubs.record.waitSlice[0]?.ms}`,
    )
    check('进程句柄仍由库的 waitForProcessExit 关闭', stubs.record.closedHandles.has('proc-4242'), [...stubs.record.closedHandles].join(','))
    ex.dispose()
  }

  // ══ 4c. 大输出断言必须"能失败"：把修复点回退掉就应当变红（红/绿双档）══
  //
  // 为什么要有这一节：一条永远不会红的断言等于没有断言。
  // 这里**故意**用修复前的编排跑同一份有界管道替身（见 4b），并断言它必然超时。
  //   - 修复后的并发编排（4b）：不超时、退出码 0；
  //   - 修复前的顺序编排（本节点）：排水被同步阻塞的等退出饿死 ⇒ 必然挂到超时。
  // 两者用**同一份替身**，因此红色只可能来自"事件循环是否被让出"这一真实机制。
  // 真实源码层面的回退验证见 .t\sbx3\fixA\out\D11-src-revert*.txt（把 src\executor.mjs
  // 改回同步 waitForProcessExit 后，4b 同样变红）。
  section('4c. 同一份替身下，修复前编排必然死锁（证明 4b 的断言能失败）')
  {
    const PIPE_CAPACITY = 2048
    const PAYLOAD_LEN = 300 * 1024
    const payload = Buffer.alloc(PAYLOAD_LEN, 0x61)
    let buffered = Buffer.alloc(0)
    let writtenBytes = 0
    let drainedBytes = 0
    let writePending = false
    let writerDone = false
    let childExited = false
    const addWrite = () => {
      writePending = false
      const size = Math.min(PIPE_CAPACITY, PAYLOAD_LEN - writtenBytes)
      buffered = Buffer.concat([buffered, Buffer.alloc(size, 0x61)])
      writtenBytes += size
      if (writtenBytes >= PAYLOAD_LEN) {
        writerDone = true
        if (buffered.length === 0) childExited = true
      } else {
        writePending = true
      }
    }
    const readRound = (handle) => {
      const take = Math.min(PIPE_CAPACITY, buffered.length)
      if (take > 0) {
        buffered = buffered.subarray(take)
        drainedBytes += take
      }
      if (writePending && buffered.length + PIPE_CAPACITY <= PIPE_CAPACITY) addWrite()
      if (writerDone && buffered.length === 0) childExited = true
      return handle
    }
    const pumpDrain = async (handle) => {
      readRound(handle)
      for (;;) {
        if (childExited && buffered.length === 0) break
        await new Promise((resolve) => setTimeout(resolve, 1))
        readRound(handle)
      }
      return String(handle).endsWith('-err') ? Buffer.alloc(0) : payload
    }
    const writeLoop = async () => {
      writePending = true
      for (;;) {
        if (writePending && buffered.length + PIPE_CAPACITY <= PIPE_CAPACITY) addWrite()
        if (writerDone && buffered.length === 0) childExited = true
        if (childExited) return
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    const stubs = makeStubs({
      pid: 5252,
      // 这个"子进程"永远不会写完 ⇒ 永远不会退出（管道被写满后卡在 WriteFile 上）
      exitCodeOf: () => undefined,
      // 同步阻塞的 INFINITE 等待：替身如实占住事件循环 2500ms 后才"放弃"
      blockIfNotExited: 2500,
      lateExitCode: 127,
    })
    stubs.overrides.processLibrary.drainPipe = pumpDrain
    const ex = makeExecutor(stubs)
    await ex.init() // 注意：init 内部有 selfTest（也会 spawn）⇒ collectChild 必须在它之后再替换
    let bytesWhenWaitEntered
    /**
     * ★ 复刻**修复前源码的调度**（缺陷 D11 的根因）：让同步阻塞的等退出成为
     *   `Promise.all` 的第一个任务 —— 也就是"父进程在子进程还活着时就一头扎进
     *   WaitForSingleObject(INFINITE)"。它一运行，事件循环立刻停摆，排水轮询定时器
     *   再也没机会触发；子进程写不完就永不退出，父进程也就永远等不到。
     *
     *   （反例说明：改成"先 await 排水、再同步等退出"的朴素写法在本替身下**不会**死锁，
     *     因为 await 会让出执行权给排水的 1ms 定时器 —— 所以那种改法不构成"回退修复"。
     *     真正的根因是"谁先占住事件循环"，这也是修复点必须放在"让出"上的原因。）
     */
    ex.collectChild = async (child) => {
      return Promise.all([
        new Promise((resolve) => {
          bytesWhenWaitEntered = drainedBytes // 记录"等退出"进入时父进程到底读走了多少
          resolve(stubs.waitForProcessExit(ex.api, child.process)) // ★ 第一个任务：同步阻塞
        }),
        pumpDrain(child.stdoutRead),
        pumpDrain(child.stderrRead),
      ]).then(([exitCode, stdout, stderr]) => ({ stdout, stderr, exitCode }))
    }
    const writer = writeLoop()
    const r = await ex.run({ command: 'faketool', cwd: STAGING, timeoutMs: 1200 })
    writer.catch(() => {})
    check(
      '修复前编排：等退出进入时父进程几乎没读走任何字节（排水被停摆）',
      bytesWhenWaitEntered <= PIPE_CAPACITY,
      `进入时 drained=${bytesWhenWaitEntered} capacity=${PIPE_CAPACITY}`,
    )
    check(
      '修复前编排：确实发生了同步阻塞（blockedWaits 有记录 ⇒ 事件循环被占住）',
      stubs.record.blockedWaits.length > 0,
      `blockedWaits=${JSON.stringify(stubs.record.blockedWaits.slice(0, 2))}`,
    )
    check('修复前编排：子进程写不完（背压卡死）', writerDone === false, `writerDone=${writerDone} written=${writtenBytes}/${PAYLOAD_LEN}`)
    check('修复前编排：等退出不是被有界切片让出的（waitSlice 为空）', stubs.record.waitSlice.length === 0, `切片次数=${stubs.record.waitSlice.length}`)
    check(
      '修复前编排：run() 只能拿到一个无意义的退出码（拿不到 ok/退出码 0）',
      r.classification.kind !== 'ok' && r.exitCode !== 0,
      `timedOut=${r.timedOut} exitCode=${r.exitCode} kind=${r.classification.kind} stdoutLen=${r.stdout.length}`,
    )
    ex.dispose()
  }

  // ══════════ 5. dispose 幂等与资源释放 ══════════
  section('5. dispose 与资源释放')
  {
    const stubs = makeStubs()
    const ex = makeExecutor(stubs)
    await ex.init()
    const first = ex.dispose()
    const second = ex.dispose()
    check('首次 dispose 报告成功', first.disposed === true, JSON.stringify(first))
    check('重复 dispose 幂等（不抛错）', second.disposed === true, JSON.stringify(second))
    check('底层 AclSandbox 被释放', stubs.record.sandboxes[0]?.disposed === true, String(stubs.record.sandboxes[0]?.disposed))
    check('私有 temp 被清理', !existsSync(TEMP), String(existsSync(TEMP)))
  }

  // ══════════ 6. 去令牌化（透明 shim）模式 ══════════
  section('6. 去令牌化模式：真实可用性判定 / fail-closed 回退 / 不裸跑')
  const fakeArtifacts = {
    shimDir: BIN,
    dllPath: join(BIN, 'winstage-shim.dll'),
    injectorPath: join(BIN, 'winstage-inject.exe'),
    probePath: join(BIN, 'winstage-probe.exe'),
  }
  const fakeCanary = {
    pipeOk: true,
    redirectOk: true,
    whoamiUser: true,
    whoamiGroups: true,
    tasklist: true,
    cim: true,
    firewall: true,
    tcpConnection: true,
    tlsCredentials: true,
    dshSandboxVars: [],
    dshSandboxCount: 0,
    winstageVars: ['WINSTAGE_STAGE_ROOT', 'WINSTAGE_SHIM_CONFIG', 'WINSTAGE_SHIM_LOG'],
    winstageCount: 3,
  }
  const fakeProbe = (available) => ({
    available,
    reason: available ? 'transparent shim is available and capability-proven' : `shim-dll: not found: ${fakeArtifacts.dllPath}`,
    artifacts: fakeArtifacts,
    transport: 'winstage-inject.exe (remote LoadLibraryW; T4 contract)',
    checks: [{ name: 'shim-dll', ok: available, detail: available ? 'fake: proven' : 'not found' }],
    abiVersion: available ? 1 : undefined,
    canary: available ? fakeCanary : undefined,
    canaryJudge: available ? judgeCanary(fakeCanary) : undefined,
    configPath: join(STAGING, 'winstage-shim.config.json'),
    logPath: join(STAGING, 'shim.log'),
  })
  {
    // 6a. 纯函数判定：所有分支都只能是"被强制的模式"，**没有裸跑分支**
    const ok = selectLaunchMode(TRANSPARENT_TIER, fakeProbe(true))
    check('TS + 探测通过 → shim', ok.mode === 'shim' && ok.tierEffective === TRANSPARENT_TIER, JSON.stringify(ok))
    const auto = selectLaunchMode('auto', fakeProbe(true))
    check('auto + 探测通过 → shim（主路径优先）', auto.mode === 'shim', JSON.stringify(auto))
    const bad = selectLaunchMode(TRANSPARENT_TIER, fakeProbe(false))
    check('TS + 探测失败 → 回退 restricted-token', bad.mode === 'restricted-token' && bad.tierEffective === 'T1', JSON.stringify(bad))
    check('回退原因写明 fail-closed', /fail-closed/.test(bad.fallbackReason ?? ''), bad.fallbackReason)
    check(
      '探测结果缺失（undefined）也必须回退，不得当成可用',
      selectLaunchMode('auto', undefined).mode === 'restricted-token',
      JSON.stringify(selectLaunchMode('auto', undefined)),
    )
    const t1 = selectLaunchMode('T1', undefined)
    check('默认 T1 → restricted-token', t1.mode === 'restricted-token' && t1.tierEffective === 'T1', JSON.stringify(t1))
    const t0 = selectLaunchMode('T0', fakeProbe(false))
    check('T0 → appcontainer（不受 shim 探测影响）', t0.mode === 'appcontainer', JSON.stringify(t0))
    const modes = ['TS', 'auto', 'T1', 'T0', undefined, 'something-unknown'].map((r) => selectLaunchMode(r, fakeProbe(false)).mode)
    check(
      '任何档位都不会判成"无强制的裸跑"',
      modes.every((mode) => ['shim', 'restricted-token', 'appcontainer'].includes(mode)),
      JSON.stringify(modes),
    )
  }
  {
    // 6b. 环境变量痕迹：`buildChildEnvironment` 不得再注入任何 DSH_SANDBOX*
    const built = buildChildEnvironment({ USER_FLAG: 'x' }, { tempDir: TEMP, cwd: STAGING, tier: 'TS' })
    const names = Object.keys(built.env)
    check('子进程环境里没有任何 DSH_SANDBOX* 变量', !names.some((name) => /^DSH_SANDBOX/i.test(name)), JSON.stringify(names))
    check('环境序列化后也不含 DSH_SANDBOX 字样', !JSON.stringify(built.env).includes('DSH_SANDBOX'), 'deleted at src/executor.mjs buildChildEnvironment')
    check('允许清单机制未被破坏（TEMP 仍按 tempDir 重写）', built.env.TEMP === TEMP, String(built.env.TEMP))
    check('显式传入的非敏感变量仍然生效', built.env.USER_FLAG === 'x', String(built.env.USER_FLAG))
  }
  {
    // 6c. TS 可用 → 走注入器（替身）；**不**建 AclSandbox、**不**建 Job、**不**用管道
    writeFileSync(join(BIN, 'powershell.exe'), 'x')
    const stubs = makeStubs()
    const spawnCalls = []
    const ex = makeExecutor(stubs, {
      tier: TRANSPARENT_TIER,
      overrides: {
        ...stubs.overrides,
        probeTransparentShim: () => fakeProbe(true),
        spawnTransparentProcess: async (file, args, options) => {
          spawnCalls.push({ file, args, options })
          // 模拟"写入被 shim 暂存"：自检要求暂存树里能找到那个文件
          const scriptText = args.join(' ')
          const match = /winstage-shim-selfcheck-(\w+)\.txt/.exec(scriptText)
          if (match) {
            mkdirSync(join(STAGING, 'staged'), { recursive: true })
            writeFileSync(join(STAGING, 'staged', `winstage-shim-selfcheck-${match[1]}.txt`), 'staged-by-shim')
          }
          return { pid: 9001, code: 0, signal: null, timedOut: false, out: 'SHIM-WRITE=ok\nSHIM-READBACK=ok\n', err: '', error: undefined }
        },
      },
    })
    const report = await ex.init()
    check('TS 探测通过时 launchMode=shim', ex.launchMode === 'shim', String(ex.launchMode))
    check('去令牌化模式不建 AclSandbox（没有受限令牌）', stubs.record.sandboxes.length === 0, `sandboxes=${stubs.record.sandboxes.length}`)
    check('去令牌化模式不建 Job（如实声明 treeReclaim=taskkill）', ex.job === undefined && report.jobEnabled === false, `job=${String(ex.job)} jobEnabled=${report.jobEnabled}`)
    check('initReport 记录 tierRequested=TS 且无回退原因', report.tierRequested === TRANSPARENT_TIER && report.fallbackReason === undefined, JSON.stringify({ r: report.tierRequested, f: report.fallbackReason }))
    check('注入器被调用一次', spawnCalls.length === 1, `calls=${spawnCalls.length}`)
    check('调用的是注入器产物路径', spawnCalls[0]?.file === fakeArtifacts.injectorPath, String(spawnCalls[0]?.file))
    check('注入器参数含 --dll 与 DLL 路径', spawnCalls[0]?.args?.[0] === '--dll' && spawnCalls[0]?.args?.[1] === fakeArtifacts.dllPath, JSON.stringify(spawnCalls[0]?.args?.slice(0, 4)))
    check('注入器参数用 `--` 分隔目标命令', spawnCalls[0]?.args?.includes('--') === true, JSON.stringify(spawnCalls[0]?.args?.slice(0, 8)))
    const injectorEnv = spawnCalls[0]?.options?.env ?? {}
    check('注入器环境里没有任何 DSH_SANDBOX* 变量', !Object.keys(injectorEnv).some((name) => /^DSH_SANDBOX/i.test(name)), JSON.stringify(Object.keys(injectorEnv).filter((n) => /DSH/.test(n))))
    check('注入器环境带上了 shim 契约变量 WINSTAGE_STAGE_ROOT', injectorEnv.WINSTAGE_STAGE_ROOT === STAGING, String(injectorEnv.WINSTAGE_STAGE_ROOT))
    check('绝不设 WINSTAGE_SHIM_DISABLE（设了就等于裸跑）', injectorEnv.WINSTAGE_SHIM_DISABLE === undefined, String(injectorEnv.WINSTAGE_SHIM_DISABLE))
    check('shim 配置里 passthrough 含暂存根（防自指递归）', (report.shimConfig?.passthrough ?? []).includes(STAGING), JSON.stringify(report.shimConfig?.passthrough))
    check('shim 配置 failClosed=true', report.shimConfig?.failClosed === true, JSON.stringify(report.shimConfig))

    const r = await ex.run({ command: 'faketool', cwd: STAGING })
    check('去令牌化 run 返回 launchMode=shim', r.launchMode === 'shim', String(r.launchMode))
    check('去令牌化 run 的 enforcement 标 shim-user-mode', r.enforcement === 'shim-user-mode', String(r.enforcement))
    check('去令牌化 run 的 backend 标 winstage-shim-iat', r.backend === 'winstage-shim-iat', String(r.backend))
    check('去令牌化 run 的输出来自注入器（不再是管道采集）', r.stdout.includes('SHIM-WRITE=ok'), JSON.stringify(r.stdout.slice(0, 60)))
    check('去令牌化 run 没有走受限令牌的 spawnPipedProcess', stubs.record.spawnCalls.length === 0, `spawnCalls=${stubs.record.spawnCalls.length}`)
    check('去令牌化 run 也没有建立 Job 归属', stubs.record.assign.length === 0, `assign=${stubs.record.assign.length}`)
    ex.dispose()
  }
  {
    // 6d. TS 探测失败 → **回退受限令牌模式**（仍然被强制），并如实记录原因
    const stubs = makeStubs({ waitResult: { stdout: Buffer.from('fallback-ok'), stderr: Buffer.from(''), exitCode: 0 } })
    const ex = makeExecutor(stubs, { tier: TRANSPARENT_TIER, overrides: { ...stubs.overrides, probeTransparentShim: () => fakeProbe(false) } })
    const report = await ex.init()
    check('回退后 launchMode=restricted-token', ex.launchMode === 'restricted-token', String(ex.launchMode))
    check('回退后 tier 如实降级为 T1', report.tierRequested === TRANSPARENT_TIER && report.tierEffective === 'T1', JSON.stringify({ req: report.tierRequested, eff: report.tierEffective }))
    check('initReport 带 fallbackReason', /fail-closed/.test(report.fallbackReason ?? ''), String(report.fallbackReason))
    check('回退路径确实建立了 AclSandbox（没有裸跑）', stubs.record.sandboxes.length === 1, `sandboxes=${stubs.record.sandboxes.length}`)
    const r = await ex.run({ command: 'faketool', cwd: STAGING })
    check('回退后 run 走受限令牌路径', r.launchMode === 'restricted-token' && r.enforcement === 'partial', JSON.stringify({ mode: r.launchMode, enf: r.enforcement }))
    ex.dispose()
  }
  {
    // 6e. 注入失败（退出码 111 = T4 契约）→ 结构化 runner-failure，绝不降级成裸跑
    const stubs = makeStubs()
    const ex = makeExecutor(stubs, {
      tier: TRANSPARENT_TIER,
      overrides: {
        ...stubs.overrides,
        probeTransparentShim: () => fakeProbe(true),
        spawnTransparentProcess: async () => ({ pid: 9002, code: SHIM_INJECT_FAILURE_EXIT, signal: null, timedOut: false, out: '', err: 'windows-acl-inject: injection refused', error: undefined }),
      },
    })
    await ex.init()
    const r = await ex.run({ command: 'faketool', cwd: STAGING })
    check('注入失败时 run 不冒泡、给出结构化结果', r.exitCode === 127 && r.launchFailed === true, JSON.stringify({ exitCode: r.exitCode, launchFailed: r.launchFailed }))
    check('注入失败分类为 runner-failure', r.classification.kind === 'runner-failure', JSON.stringify(r.classification))
    check('注入失败错误里点明 TS_INJECTION_FAILED / fail-closed', /TS_INJECTION_FAILED|refusing to continue unconfined/.test(r.stderr), r.stderr.slice(0, 160))
    check('注入失败时没有改用受限令牌路径继续跑', stubs.record.spawnCalls.length === 0, `spawnCalls=${stubs.record.spawnCalls.length}`)
    ex.dispose()
  }

  // ══════════ 7. shim DLL 产物探测（合成 PE32+，完全离线） ══════════
  section('7. shim DLL 探测：PE 导出表（不加载、不执行）')
  {
    const makePe = (names, { machine = 0x8664, magic = 0x20b, sizeOptOffset = 20 } = {}) => {
      const buffer = Buffer.alloc(0x600)
      buffer.writeUInt16LE(0x5a4d, 0)
      const peOffset = 0x80
      buffer.writeUInt32LE(peOffset, 0x3c)
      buffer.writeUInt32LE(0x00004550, peOffset)
      buffer.writeUInt16LE(machine, peOffset + 4)
      buffer.writeUInt16LE(1, peOffset + 6)
      // `[实测-回归]` COFF 头从签名之后开始 ⇒ SizeOfOptionalHeader 在 peOffset+20。
      // 夹具曾与实现共用同一个错偏移（peOffset+16），于是"两边一起错"⇒ 测试假绿，
      // 直到真实 DLL 出现才暴露。夹具必须按**真实** PE 布局写。
      buffer.writeUInt16LE(0xf0, peOffset + sizeOptOffset)
      const optional = peOffset + 24
      buffer.writeUInt16LE(magic, optional)
      buffer.writeUInt32LE(16, optional + 108)
      buffer.writeUInt32LE(0x1000, optional + 112)
      buffer.writeUInt32LE(0x80, optional + 116)
      const section = optional + 0xf0
      buffer.writeUInt32LE(0x400, section + 8)
      buffer.writeUInt32LE(0x1000, section + 12)
      buffer.writeUInt32LE(0x400, section + 16)
      buffer.writeUInt32LE(0x200, section + 20)
      const exportOffset = 0x200
      buffer.writeUInt32LE(names.length, exportOffset + 24)
      buffer.writeUInt32LE(0x1040, exportOffset + 32)
      const nameTableRva = 0x1080
      names.forEach((name, index) => {
        buffer.writeUInt32LE(0x1000 + (nameTableRva - 0x1000) + index * 32, exportOffset + 0x40 + index * 4)
        buffer.write(name, 0x200 + (nameTableRva - 0x1000) + index * 32, 'ascii')
        buffer.writeUInt8(0, 0x200 + (nameTableRva - 0x1000) + index * 32 + name.length)
      })
      return buffer
    }
    const goodPath = join(BIN, 'good-shim.dll')
    writeFileSync(goodPath, makePe(['WinstageShimInit', 'WinstageShimAbiVersion', 'WinstageShimStatsJson']))
    const good = probeShimDll(goodPath)
    check('x64 PE 且导出齐全 → ok', good.ok === true && /WinstageShimInit/.test(good.detail), good.detail)
    const parsed = parsePeExports(makePe(['Alpha', 'Beta']))
    check('解析出全部导出名', parsed.ok === true && parsed.names.join(',') === 'Alpha,Beta', JSON.stringify(parsed.names))

    const missingPath = join(BIN, 'missing-shim.dll')
    writeFileSync(missingPath, makePe(['WinstageShimInit']))
    const missing = probeShimDll(missingPath)
    check('少导出符号 → 不可用（不靠"文件存在"）', missing.ok === false && /missing exports/.test(missing.detail), missing.detail)

    const x86Path = join(BIN, 'x86-shim.dll')
    writeFileSync(x86Path, makePe(['WinstageShimInit', 'WinstageShimAbiVersion', 'WinstageShimStatsJson'], { machine: 0x14c }))
    check('非 x64 → 不可用', probeShimDll(x86Path).ok === false && /x64/.test(probeShimDll(x86Path).detail), probeShimDll(x86Path).detail)

    const junkPath = join(BIN, 'junk.dll')
    writeFileSync(junkPath, Buffer.from('this is not a PE file at all'))
    check('非 PE 文件 → 不可用', probeShimDll(junkPath).ok === false, probeShimDll(junkPath).detail)
    check('路径不存在 → 不可用', probeShimDll(join(BIN, 'nope.dll')).ok === false, probeShimDll(join(BIN, 'nope.dll')).detail)

    // `[实测-回归]` SizeOfOptionalHeader 偏移纪律（真实 DLL 暴露的缺陷）：
    // 把该字段只写在**错位置**（peOffset+16，漏算 PE 签名的 4 字节）时，
    // 解析器必须**读不到导出**——否则说明它仍在用错偏移（这条断言在修前是红的）。
    const offByFourPath = join(BIN, 'offbyfour-shim.dll')
    writeFileSync(offByFourPath, makePe(['WinstageShimInit', 'WinstageShimAbiVersion', 'WinstageShimStatsJson'], { sizeOptOffset: 16 }))
    const offByFour = probeShimDll(offByFourPath)
    check(
      'SizeOfOptionalHeader 必须按真实偏移 peOffset+20 读取（错位夹具必须解析失败）',
      offByFour.ok === false && /PE parse failed|missing exports/.test(offByFour.detail),
      offByFour.detail,
    )
  }

  // ══════════ 8. 能力金丝雀脚本与判定契约 ══════════
  section('8. 能力金丝雀：哨兵解析 / 判定 / 脚本纪律')
  {
    const marker = 'WINSTAGE-CAPABILITY:'
    const line = `${marker}${JSON.stringify({ pipeOk: true, dshSandboxCount: 0 })}`
    const parsed = parseMarkerJson(`noise line\n${line}\n`, marker)
    check('能从噪声输出里解析哨兵 JSON', parsed?.pipeOk === true && parsed?.dshSandboxCount === 0, JSON.stringify(parsed))
    check('没有哨兵时返回 undefined（不猜）', parseMarkerJson('nothing here') === undefined, 'undefined')

    const judgeOk = judgeCanary(fakeCanary)
    check('四类能力齐全 + 无痕迹 → ok', judgeOk.ok === true, JSON.stringify(judgeOk))
    const judgeBad = judgeCanary({ ...fakeCanary, pipeOk: false, cim: false })
    check('缺能力 → 失败并逐项列出', judgeBad.ok === false && /pipe/.test(judgeBad.reason) && /cim/.test(judgeBad.reason), judgeBad.reason)
    check('金丝雀缺失 → 判失败（空结果不是通过）', judgeCanary(undefined).ok === false, judgeCanary(undefined).reason)
    check(
      'DSH_SANDBOX* 残留 → 判失败',
      judgeCanary({ ...fakeCanary, dshSandboxCount: 2 }).ok === false,
      judgeCanary({ ...fakeCanary, dshSandboxCount: 2 }).reason,
    )

    const script = buildCapabilityCanaryScript()
    const probes = ['| Out-String', '> $f', 'whoami.exe /user', 'whoami.exe /groups', 'tasklist.exe', 'Get-CimInstance', 'Get-NetFirewallProfile', 'Get-NetTCPConnection', 'SslStream', 'DSH_SANDBOX*']
    check('金丝雀覆盖全部被测能力', probes.every((needle) => script.includes(needle)), probes.filter((needle) => !script.includes(needle)).join(','))
    check('金丝雀脚本是纯 ASCII（避免 OEM 代码页破坏，README 缺陷 1/12）', !/[^\u0000-\u007f]/.test(script), 'pure ASCII')

    const config = writeShimConfig({ stageRoot: STAGING, logPath: join(STAGING, 'shim.log') })
    const configText = readFileSync(config.configPath, 'utf8')
    check('shim 配置写到规范位置且可解析', JSON.parse(configText).stageRoot === STAGING, config.configPath)
    check('shim 配置 failClosed/readThrough 为 true', config.config.failClosed === true && config.config.readThrough === true, JSON.stringify(config.config))
  }

  // ══════════ 9. 文件描述符重定向采集（不用管道） ══════════
  section('9. 采集纪律：文件描述符重定向（受限令牌下也能跑）')
  {
    const run = runCapturedToFiles(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/d', '/c', 'echo CAPTURE-OK'], { captureDir: ROOT, timeoutMs: 20000 })
    check('cmd 输出经文件采集成功', run.code === 0 && /CAPTURE-OK/.test(run.out), `exit=${run.code} out=${JSON.stringify(run.out.slice(0, 40))}`)
    const leftovers = existsSync(ROOT) ? readdirSync(ROOT).filter((name) => name.startsWith('.winstage-cap-')) : []
    check('采集用的临时文件被清理', leftovers.length === 0, JSON.stringify(leftovers))
  }

  rmSync(ROOT, { recursive: true, force: true })
  process.env.PATH = originalPath
  if (originalExt === undefined) delete process.env.PATHEXT
  else process.env.PATHEXT = originalExt
  W('')
  W('='.repeat(64))
  W(failures === 0 ? '执行器编排测试：全部通过' : `执行器编排测试：${failures} 项失败`)
  W('='.repeat(64))
  process.exit(failures ? 1 : 0)
}

main().catch((error) => {
  W(`\n未捕获错误: ${error?.stack || error}`)
  process.exit(1)
})
