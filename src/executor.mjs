/**
 * 沙箱内执行器（受信启动器）
 *
 * 手册依据：
 *   第 6 章   每次执行只采用一条物化与捕获路径
 *   第 8 章   启动边界：继承资源最小化、环境从允许清单构建
 *   #8.1      先关继承句柄，再谈隔离
 *   #8.3      不要用环境变量删除来实现安全控制 → 必须从允许清单**重建**，而非 merge
 *   第 5 章   能力探测 = 真实执行路径验证；不可用则 fail-closed
 *   #14.2     Windows 实测：Job Object KILL_ON_JOB_CLOSE 进程树回收 pass、ACL deny 写 pass
 *   第 17 章  硬验收：未授权的高编号宿主句柄必须不可达
 *
 * ── 为什么不用 AclSandbox.spawn()（重要，属手册第 0 章"环境漂移/能力探测不一致"类问题）──
 * 实测 `@deepseek-ai/dsh-sandbox-windows-acl@0.1.7-rc.2` 的 `spawn()` 走
 *   createProcessAsUserW(token, null, cmdline, null, null, 1, flags, **null**, cwd, ...)
 * 即 lpEnvironment = NULL → 子进程**继承父进程环境**，且接口不提供 env 参数。
 * 这直接违反手册 #8.3（禁止依赖与父环境合并）与第 8 章（环境从允许清单构建）。
 * 因此本执行器不复用它的 spawn，而是：
 *   1. 复用它已经过实测的**令牌构造与 ACL 授予**（AclSandbox.init）——不重复造轮子；
 *   2. 用它在运行时实际绑定的 Win32 绑定表（通过原型镜面探针捕获，不猜私有字段名）；
 *   3. 用 `spawnPipedProcess` 以**显式 lpEnvironment 缓冲区**创建受限于该令牌的子进程；
 *   4. 自行建立 Job Object 并挂 KILL_ON_JOB_CLOSE + ActiveProcessLimit。
 * 原型镜面探针在依赖升级后若失效会**显式抛错**（fail-closed），不会静默降级为无环境控制的 spawn。
 *
 * ── 诚实声明（手册 0.1 证据分层 / 16.10 残余边界必须如实声明）──
 * 本执行器**不限制读取**。WRITE_RESTRICTED 是限制 SID 交集，只交叉**写类**访问；
 * Low 完整性标签只做 no-write-up。因此沙箱内进程仍可读取调用者可读的文件。
 * 读取面收敛依靠 DSH 工具层遮蔽 + 本模块的 --mirror 只读投影，
 * 属**残余边界**，不得声明为硬边界。
 */

import { createRequire } from 'node:module'
import { spawn as spawnChildProcess, spawnSync as spawnSyncChildProcess } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
// ── T0（AppContainer）执行路径的判据与布局**只从这两个模块来** ──────────────────
// 本文件不重写 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` / `STARTUPINFOEXW.cb` /
// cbSize 之类的常量：那正是"探测与执行漂移"（手册 #5.1）的入口。
import { CREATE_NEW_CONSOLE } from './appcontainer-runtime.mjs'
// ── 缺陷③：陈旧 AppContainer 包 SID ACE 的判据只从 `src/appcontainer.mjs` 来 ──────
// 不在本文件重写 SDDL 解析：判据漂移会让"修复"和"测量"对不上。
// Phase 2 / WP1：暂存根授权的**回读判据**用同一个解析器（`parseSddlDaclAces`），
// 不另写一份"某 SID 在不在 DACL 里"的解析 —— 同一份 SDDL 只能有一种读法。
import { findStaleAppContainerAces, listAppContainerSids, parseSddlDaclAces } from './appcontainer.mjs'
// ── Phase 2 / WP1：授权目标**唯一来源 = WP0 的 `resolveStageRoot()`** ─────────────
// WP0 把默认暂存根从工作区 `.dshstage` 搬到 `%LOCALAPPDATA%\Temp\winstage-stage\<会话键>`
// （缓存面）。本文件**绝不自己拼这条路径**（拼一次就会和 WP0 漂移一次）。
// 三个码必须彼此区分，绝不互相顶替：
//   · `STAGE_GUARD_UNAVAILABLE`（WP0，`stage-guard.mjs`）= 这一步**之前**根/守护建不起来；
//   · `STAGE_ROOT_LOST`（WP0，`stage-guard.mjs`）= 建好之后根/哨兵/守护失效（丢失即显形）；
//   · `STAGE_GRANT_FAILED`（WP1，本文件）= 根在、但**没被授权给本次运行的身份**。
import { STAGE_GUARD_UNAVAILABLE, STAGE_ROOT_LOST, resolveStageRoot } from './stage-guard.mjs'
// ── 弹框抑制必须落在**真正创建子进程的那个进程**里 ────────────────────────────────
// `SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOOPENFILEERRORBOX)` 由子进程**继承**，
// 所以只要在"要 spawn 的那个进程"里、在 CreateProcess 之前设置一次，
// 子进程在用户态初始化阶段失败（最典型 `0xC0000142`）时就**不再弹** csrss 的模态
// 「应用程序无法正常启动」框，而是如实变成退出码。
//
// 缺陷背景（2026-09-30 实测）：`src/spawn-window.mjs` 早就存在，但只有
// `capability.mjs`（宿主 import 侧）与两个离线自测入口调用它；**本文件 —— 生产
// 唯一真正 spawn 的地方 —— 没有接**。于是 DSH 宿主进程始终停留在默认错误模式，
// 沙箱探针/受约束子进程一旦以 0xC0000142 死掉，用户桌面上就弹出一个
// 「<exe> - Application Error」模态框（实测抓到连续 14 个：cmd/hostname/whoami/
// curl/ping/reg/sc/net/tasklist/findstr/where/attrib/certutil/tar）。
// 本模块被所有生产入口 import（host-plugin / shell-executor / staging-fs /
// provider / selfcheck / cli），因此在这里落地是覆盖面最大的单点。
import { suppressWindowsCriticalErrorDialogs } from './spawn-window.mjs'
// ── 三轮接线：三个新维度**在这里真的生效**（而不只是存在于库里）──────────────────
//   · `netpolicy`：`OFFLINE` 档位在 `run()` 之前做 fail-closed 判定；能强制时安装 + 回读，
//     拿不到 `state:'enforced'` 就**拒绝执行**（绝不"以为挡住了、其实是通的"）；
//   · `mitigations`：T0 启动时把 `PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY` 写进属性列表
//     （注入点在 `src/appcontainer-runtime.mjs`，本文件只负责把档位传下去并上报摘要）；
//   · `limits`：捕获的 stdout/stderr 按上限**显式**截断（标记 + 机器可检标志），
//     暂存写入前按配额拒绝（统计不完整也拒绝）。
// 默认值全部等于接线前的语义（`OBSERVED_ONLINE` / `none` / `DEFAULT_LIMITS`）。
import { NETWORK_TIER_STATES, resolveNetworkPolicy, installNetworkPolicy, summariseNetworkPolicy } from './netpolicy.mjs'
import { buildMitigationPolicy, summariseMitigations } from './mitigations.mjs'
import { applyOutputCap, checkStagingQuota, measureTree, summariseLimits, wrapLimits } from './limits.mjs'

const require_ = createRequire(import.meta.url)

/**
 * 本进程（= DSH 宿主 / CLI）是否成功压掉了关键错误弹框。
 *
 * 如实暴露：koffi 解析不到时 `suppressWindowsCriticalErrorDialogs()` 返回 `false`，
 * 这里**不谎报** success。`true` = 之后的受约束 spawn 失败只会给退出码，不会弹框。
 */
export const DIALOG_SUPPRESSION_APPLIED = suppressWindowsCriticalErrorDialogs()

export const ACL_PACKAGE = '@deepseek-ai/dsh-sandbox-windows-acl'
export const WIN32_PACKAGE = '@deepseek-ai/dsh-win32-process'

/**
 * 解析承载沙箱后端的 DSH 安装位置。
 *
 * 为什么不能只靠 `require_(pkg)`：本工具是独立工作区程序，不保证与 DSH 同处
 * 一个 node_modules 树。手动拼一堆候选路径会变成"环境漂移"（手册 #0.1）的反面教材，
 * 所以这里按 **DSH 实际加载路径** 顺序解析，并把最终来源记入报告供核对：
 *   1. 显式覆盖 DSH_SANDBOX_NODE_ROOT（可指向任意含 @deepseek-ai/* 的目录）
 *   2. 本模块自身的解析链（同树安装时命中）
 *   3. $DSH_PROFILE_DIR/node_modules（profile 级安装的 bundle）
 *   4. dsh CLI 自身目录（`where dsh` / npm-cache 布局）
 */
export function resolveDshModuleRoot() {
  const candidates = []
  if (process.env.DSH_SANDBOX_NODE_ROOT) candidates.push(process.env.DSH_SANDBOX_NODE_ROOT)
  if (process.env.DSH_PROFILE_DIR) candidates.push(join(process.env.DSH_PROFILE_DIR, 'node_modules'))
  // dsh CLI 自身目录 → 其 node_modules
  // 返回的是包目录 <...>/node_modules/@deepseek-ai/dsh；上溯两级即 node_modules
  // （x1=@deepseek-ai，x2=node_modules，x3=安装根——上溯三级会丢掉作用域目录）
  const cli = resolveDshCliPath()
  if (cli) candidates.push(dirname(dirname(cli)))
  return candidates.filter((value) => typeof value === 'string' && value.length > 0)
}

function resolveDshCliPath() {
  // npm 全局安装：%APPDATA%\npm\node_modules\@deepseek-ai\dsh
  const direct = join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh')
  if (existsSync(direct)) return direct
  // npm 的 _npx 缓存布局：<cache>/_npx/<hash>/node_modules/@deepseek-ai/dsh
  const caches = [process.env.LOCALAPPDATA, process.env.APPDATA]
    .filter(Boolean)
    .map((base) => join(base, 'npm-cache', '_npx'))
  for (const cache of caches) {
    if (!existsSync(cache)) continue
    let entries = []
    try {
      entries = readdirSync(cache)
    } catch {
      continue
    }
    for (const entry of entries) {
      const candidate = join(cache, entry, 'node_modules', '@deepseek-ai', 'dsh')
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * 在候选 node_modules 根中解析一个包。
 * @returns {{module: unknown, from: string}} from 记录**实际命中**的根，
 *   便于报告中核对"跑的是哪份代码"（手册 #0.1/#0.2 证据分层）。
 */
function requireFromRoots(spec, roots) {
  const errors = []
  for (const root of roots) {
    try {
      const scoped = createRequire(join(root, 'noop.js'))
      const loaded = scoped(spec)
      // 明确标注命中来源，避免把"自身解析链"误报成候选根
      return { module: loaded, from: root }
    } catch (error) {
      errors.push(`${root}: ${error.code || error.message}`)
    }
  }
  try {
    return { module: require_(spec), from: 'self' }
  } catch (error) {
    const failure = new Error(`cannot resolve ${spec}\n  tried:\n    ${errors.join('\n    ')}\n  self: ${error.message}`)
    failure.code = 'MODULE_NOT_FOUND'
    throw failure
  }
}

/** 唯一加载入口：探测与真实执行必须走同一份实现（手册 #5.1） */
export function loadWindowsSandboxModules() {
  const roots = resolveDshModuleRoot()
  const out = { __roots: roots }
  for (const spec of [ACL_PACKAGE, WIN32_PACKAGE]) {
    try {
      out[spec] = requireFromRoots(spec, roots)
    } catch (error) {
      out[spec] = { error }
    }
  }
  return out
}

/** 从允许清单构造子进程环境变量（#8.3：绝不 merge 父环境） */
export const ENV_ALLOWLIST = [
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT',
  // PATH 必须保留：CreateProcessAsUserW 不做 PATHEXT 解析，我们靠它在宿主侧
  // 把裸命令名解析成绝对路径（`[实测]` 缺陷 6）；不保留则任何工具都找不到。
  'PATH',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL', 'PROCESSOR_REVISION', 'OS',
  'USERNAME', 'USERDOMAIN', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)',
  'ProgramW6432', 'CommonProgramFiles', 'PUBLIC',
  'TZ', 'LANG', 'LC_ALL', 'TERM', 'DSH_PROFILE',
]

/** 敏感名模式：即使调用方显式传入也默认拒绝（手册第 10 章三阶段拆分） */
export const ENV_DENYLIST_PATTERNS = [
  /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i,
  /^AWS_|^AZURE_|^GOOGLE_|^GCP_|^GITHUB_|^GH_|^NPM_TOKEN|^DOCKER_/i,
  /^HTTP_PROXY$|^HTTPS_PROXY$|^ALL_PROXY$|^NO_PROXY$/i,
  /^NODE_OPTIONS$|^NODE_PATH$/,
]

export function isSensitiveEnvName(name) {
  return ENV_DENYLIST_PATTERNS.some((pattern) => pattern.test(name))
}

export function buildChildEnvironment(overrides = {}, options = {}) {
  const env = {}
  for (const name of ENV_ALLOWLIST) {
    const value = process.env[name]
    if (typeof value === 'string') env[name] = value
  }
  const rejected = []
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue
    if (!options.allowSensitive && isSensitiveEnvName(name)) {
      rejected.push(name)
      continue
    }
    env[name] = String(value)
  }
  if (options.tempDir) {
    env.TMP = options.tempDir
    env.TEMP = options.tempDir
  }
  if (options.cwd) env.PWD = options.cwd
  // ── 沙箱痕迹（真实缺陷，已删除）──────────────────────────────────────────────
  // 这里曾注入 DSH_SANDBOX / DSH_SANDBOX_TIER / DSH_SANDBOX_ENFORCEMENT /
  // DSH_SANDBOX_NOTE。那是"用环境变量当指纹"：沙箱内的任何进程（包括 agent 自己
  // 跑的子进程）都能一眼看出自己被关了，而且这份指纹还泄漏了执行档位与边界细节。
  // 安全控制**不得**依赖"删掉环境变量"（手册 #8.3 讲的是从允许清单**重建**环境），
  // 同理"表明沙箱存在"也不该靠注入变量。删除后由
  // `tests/executor-stub.mjs` 与 `src/capability-probe.mjs` 双向断言：
  // 子进程环境里**不得**再出现任何 `DSH_SANDBOX*`。
  return { env, rejected }
}

// ─────────────────────────── Win32 常量与结构布局 ───────────────────────────
//
// 偏移量与结构大小按 **实测** 确定，而不是只按头文件"核算"。
// 教训来源（本仓库审计阶段真实踩到）：`QueryInformationJobObject` 要求传入的
// 长度**恰好等于**结构大小，多一个字节都返回 Win32 24（ERROR_BAD_LENGTH）。
// 因此把精确大小固化为常量，并保留实测依据。

const JOB_OBJECT_LIMIT_PROCESS_TIME = 0x00000002
const JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x00000008
const JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100
const JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400
const JobObjectExtendedLimitInformation = 9
const JobObjectBasicAccountingInformation = 1

/**
 * `CREATE_UNICODE_ENVIRONMENT`。
 *
 * `[官方]`/`[实测]` 必须与 `lpEnvironment` 同时使用：环境块是 UTF-16LE 时若不置该位，
 * `CreateProcessAsUserW` 返回 Win32 87（ERROR_INVALID_PARAMETER），**子进程完全创建不出来**。
 * 这是本项目最隐蔽的一个缺陷（缺陷 13）：库内部以 `creationFlags = 0` 调用，
 * 我们只是"补上环境块"，于是丢掉了这个必须成对出现的标志。
 */
export const CREATE_UNICODE_ENVIRONMENT = 0x00000400

/**
 * JOBOBJECT_BASIC_ACCOUNTING_INFORMATION 的精确大小与字段偏移。
 *
 * `[实测]` **大小 = 48**：只有 48 能通过 QueryInformationJobObject(cls=1)；
 * 40/44/52/56/64/72/80 全部返回 Win32 24（ERROR_BAD_LENGTH）。
 *
 * `[官方+实测]` 偏移（本文件曾把三者整体写错 4 字节，导致越界读取）：
 *   LARGE_INTEGER TotalUserTime              @0
 *   LARGE_INTEGER TotalKernelTime            @8
 *   LARGE_INTEGER ThisPeriodTotalUserTime    @16
 *   LARGE_INTEGER ThisPeriodTotalKernelTime  @24
 *   DWORD         TotalPageFaultCount        @32
 *   DWORD         TotalProcesses             @36
 *   DWORD         ActiveProcesses            @40
 *   DWORD         TotalTerminatedProcesses   @44   <-- 最后一个合法偏移（48-4）
 *
 * 交叉验证：DSH 自身的 `@deepseek-ai/dsh-win32-process` 的 `isJobEmpty()` 读的就是
 * `information.readUInt32LE(40)`（活跃进程数），与本表一致。
 */
export const JOB_BASIC_ACCOUNTING_SIZE = 48

export const OFF_ACCOUNTING = {
  totalPageFaultCount: 32,
  totalProcesses: 36,
  activeProcesses: 40,
  totalTerminatedProcesses: 44,
}

const OFF = {
  basicLimitInformation: 0,
  perProcessUserTimeLimit: 0,
  perJobUserTimeLimit: 8,
  limitFlags: 16,
  minimumWorkingSetSize: 24,
  maximumWorkingSetSize: 32,
  activeProcessLimit: 36,
  affinity: 40,
  priorityClass: 48,
  // IO_COUNTERS: 64..112
  processMemoryLimit: 112,
  jobMemoryLimit: 120,
  peakProcessMemoryUsed: 128,
  peakJobMemoryUsed: 136,
  size: 144,
}

export function buildExtendedLimitInformation(options = {}) {
  const buffer = Buffer.alloc(OFF.size)
  let flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
  // 注意（真实缺陷 14）：这里**默认不设** JOB_OBJECT_LIMIT_ACTIVE_PROCESS。
  // 该限制是"Job 内活跃进程数上限"，而我们还要把沙箱子进程挂进同一个 Job；
  // 一旦把一个偏小的上限（曾用 32）与"把自身进程也挂进去"叠加，
  // AssignProcessToJobObject 就会返回 1816（ERROR_NO_SYSTEM_RESOURCES，Job 配额耗尽），
  // 表现为**任何命令都起不来**。要限流请显式传 activeProcessLimit，并留足余量。
  if (options.activeProcessLimit) flags |= JOB_OBJECT_LIMIT_ACTIVE_PROCESS
  if (options.processMemoryLimit) flags |= JOB_OBJECT_LIMIT_PROCESS_MEMORY
  if (options.jobMemoryLimit) flags |= JOB_OBJECT_LIMIT_JOB_MEMORY
  if (options.perProcessTimeLimitMs) flags |= JOB_OBJECT_LIMIT_PROCESS_TIME
  buffer.writeUInt32LE(flags >>> 0, OFF.limitFlags)
  if (options.perProcessTimeLimitMs) {
    // LARGE_INTEGER，100ns 单位
    buffer.writeBigInt64LE(BigInt(options.perProcessTimeLimitMs) * 10000n, OFF.perProcessUserTimeLimit)
  }
  if (options.activeProcessLimit) buffer.writeUInt32LE(options.activeProcessLimit >>> 0, OFF.activeProcessLimit)
  if (options.processMemoryLimit) buffer.writeBigUInt64LE(BigInt(options.processMemoryLimit), OFF.processMemoryLimit)
  if (options.jobMemoryLimit) buffer.writeBigUInt64LE(BigInt(options.jobMemoryLimit), OFF.jobMemoryLimit)
  return { buffer, flags }
}

/**
 * 解析 JOBOBJECT_BASIC_ACCOUNTING_INFORMATION。
 *
 * 抽成纯函数是刻意的：这样"偏移/大小写错"这类 bug 可以用**合成缓冲区**在
 * 任何环境（包括受限会话）里被确定性测出来，而不必真的建 Job 跑子进程。
 * 本仓库正是因为在受限会话里测不到，才让偏移错误连过两轮。
 */
export function parseBasicAccounting(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('accounting buffer must be a Buffer')
  if (buffer.length !== JOB_BASIC_ACCOUNTING_SIZE) {
    throw new Error(`accounting buffer must be exactly ${JOB_BASIC_ACCOUNTING_SIZE} bytes, got ${buffer.length}`)
  }
  const readField = (name) => {
    const offset = OFF_ACCOUNTING[name]
    if (offset + 4 > buffer.length) {
      throw new Error(
        `accounting field ${name} at offset ${offset} exceeds the ${buffer.length}-byte struct; offsets are wrong`,
      )
    }
    return buffer.readUInt32LE(offset)
  }
  return {
    totalProcesses: readField('totalProcesses'),
    activeProcesses: readField('activeProcesses'),
    terminatedProcesses: readField('totalTerminatedProcesses'),
    totalPageFaultCount: readField('totalPageFaultCount'),
  }
}

// ─────────────────────── T0：AppContainer 执行路径（本轮接线）───────────────────────
//
// ── 为什么 T0 不能复用 T1 的 `spawnPipedProcess`（`[实测]` 读依赖源码）──────────────
// `@deepseek-ai/dsh-win32-process` 的 `spawnPipedProcess()` 在内部硬编码
// `cb: 104`（= `sizeof(STARTUPINFOW)`）且 `creationFlags = 0`。
// 对 T1 这是**正确**的；对 AppContainer 是**致命**的：
//   ① `cb` 必须是 112（`sizeof(STARTUPINFOEXW)`），填 104 会让 `CreateProcess`
//      **静默忽略 `lpAttributeList`** —— 进程照常起来、返回值照常成功、**根本不在 AppContainer 里**；
//   ② 少了 `EXTENDED_STARTUPINFO_PRESENT`，就算 cb 对了也白搭。
// 这正是本项目最怕的"看起来成功、实际边界没生效"，因此 T0 **必须**有一条自己的启动路径。
//
// ── stdio 怎么办（T0 的额外难点）──────────────────────────────────────────────
// `inheritHandles=false`（FIX-B 实测唯一稳的组合之一）之下**拿不到子进程输出**；
// 而 `inheritHandles=true` 又不许配"附着在父控制台"（子进程 `0xC0000142`）。
// 本实现的组合是三者同时满足：
//   `inheritHandles=TRUE` + `CREATE_NEW_CONSOLE` + `STARTF_USESTDHANDLES` 指向**暂存根内的文件**。
// 为什么用文件而不是匿名管道：`CreateProcessW` 的管道方式要求父进程持有可继承的写端句柄并
// 在 `drainPipe` 里异步轮询；而 T0 的 `CreateProcessW` 调用发生在原生代码里（同步），
// 把"排水"这一步交给文件系统可以完全绕开"父进程不读 ⇒ 子进程写满管道缓冲 ⇒ 互等"
// 那个 D11 死锁形态。代价是输出不是流式的（T0 档位下可接受，且**如实记录在报告里**）。

/** `[官方]` `STARTF_USESTDHANDLES` = 0x100：用了 `hStdInput/Output/Error` 就必须置位 */
export const STARTF_USESTDHANDLES = 0x00000100
/** `[官方]` `CreateFileW` 的 `dwDesiredAccess` / `dwCreationDisposition` */
const GENERIC_READ = 0x80000000
const GENERIC_WRITE = 0x40000000
const OPEN_EXISTING = 3
const CREATE_ALWAYS = 2

/**
 * 把 `argv` 拼成 `CreateProcessW` 要的命令行（含引号规则）。
 *
 * `[官方]` 规则（CommandLineToArgvW 的约定）：
 *   - 反斜杠**只在后面紧跟引号时**才有特殊含义；
 *   - 因此"恰好位于结尾引号之前"的连续反斜杠必须**翻倍**。
 * 写错的症状不是报错，而是**参数被静默拆错**（例如 `a\"b` 变成 `a"b`），
 * 属于本项目"看起来成功"那一类，所以这里逐字符处理并配单元测试。
 */
export function quoteWindowsArgument(value) {
  const text = String(value)
  if (text.length > 0 && !/[\s"]/.test(text)) return text
  let out = '"'
  let backslashes = 0
  for (const ch of text) {
    if (ch === '\\') {
      backslashes += 1
      continue
    }
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  out += '\\'.repeat(backslashes * 2) + '"'
  return out
}

export function buildWindowsCommandLine(applicationName, args = []) {
  return [quoteWindowsArgument(applicationName), ...args.map(quoteWindowsArgument)].join(' ')
}

/**
 * T0 启动器：把 `AppContainerRuntime`（profile/能力/属性列表）+ Job 归属 + 文件式捕获
 * 收成一个 `launch()`，与 `RestrictedLauncher.launch()` 同签名、同返回语义。
 *
 * **fail-closed**：任一步失败都抛结构化错误，绝不"降级为普通进程"继续跑。
 * 这一点是本文件最重要的契约 —— 阶段 B 的教训是"属性列表写法错也会静默退化成普通进程"，
 * 那种失败**不会**在 `CreateProcessW` 的返回值里体现。
 */
export class AppContainerLauncher {
  /**
   * @param {object} koffi 已加载的 koffi
   * @param {object} api 低层绑定表（`createJobObjectW` / `assignProcessToJobObject` / `closeHandle`…）
   * @param {{profileName?:string, capabilities?:string[], tempDir?:string, grantPaths?:string[], job?:unknown}} options
   */
  constructor(koffi, api, options = {}) {
    if (!koffi || typeof koffi.load !== 'function') throw fail('T0_UNAVAILABLE', 'koffi is required for the AppContainer launch path')
    this.koffi = koffi
    this.api = api
    this.options = options
    this.profileName = options.profileName || `dsh.stage.t0.${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
    this.capabilities = options.capabilities ?? []
    this.kernel32 = koffi.load('kernel32.dll')
    this.ResumeThread = this.kernel32.func('uint32 ResumeThread(void *thread)')
    this.TerminateProcess = this.kernel32.func('bool TerminateProcess(void *process, uint32 code)')
    this.WaitForSingleObject = this.kernel32.func('uint32 WaitForSingleObject(void *handle, uint32 ms)')
    this.GetExitCodeProcess = this.kernel32.func('bool GetExitCodeProcess(void *process, _Out_ uint32 *code)')
    this.CloseHandleRaw = this.kernel32.func('bool CloseHandle(void *handle)')
    this.CreateFileW = this.kernel32.func(
      'void *CreateFileW(const char16_t *name, uint32 access, uint32 share, void *sa, uint32 disposition, uint32 flags, void *template)',
    )
    // `[官方]` BOOL CreatePipe(PHANDLE hReadPipe, PHANDLE hWritePipe, LPSECURITY_ATTRIBUTES sa, DWORD size)
    this.CreatePipe = this.kernel32.func('bool CreatePipe(_Out_ void **readPipe, _Out_ void **writePipe, void *sa, uint32 size)')
    // `[官方]` BOOL PeekNamedPipe(HANDLE, LPVOID buf, DWORD bufSize, LPDWORD read, LPDWORD avail, LPDWORD leftThisMessage)
    this.PeekNamedPipe = this.kernel32.func(
      'bool PeekNamedPipe(void *pipe, void *buffer, uint32 bufferSize, void *bytesRead, _Out_ uint32 *totalAvailable, void *bytesLeftThisMessage)',
    )
    this.ReadFile = this.kernel32.func(
      'bool ReadFile(void *file, _Out_ uint8 *buffer, uint32 toRead, _Out_ uint32 *read, void *overlapped)',
    )
    this.GetCurrentProcess = this.kernel32.func('void *GetCurrentProcess()')
    this.GetStdHandle = this.kernel32.func('void *GetStdHandle(int which)')
    this.runtime = undefined
    this.sidString = undefined
    this.granted = []
    /** 缺陷③的退出兜底监听器（`attachRuntime()` 注册，`dispose()` 摘除） */
    this.exitHook = undefined
    this.lastLaunch = undefined
  }

  /** 由 `createAppContainerLauncher()`（异步工厂）注入 runtime 并立即做 ACL 授权 */
  attachRuntime(runtime, sidString) {
    this.runtime = runtime
    this.sidString = sidString
    const grants = []
    for (const entry of this.options.grantPaths ?? []) {
      // T2 契约：`grantPaths` 允许 `{path, rights}` 形式。shim DLL 所在目录必须
      // 授权为**读+执行**（默认 `M` 已包含），否则包 SID 读不到 DLL 会让注入以
      // 「找不到模块」失败，而不是权限错误，极难归因。
      const target = typeof entry === 'string' ? entry : entry?.path
      const rights = typeof entry === 'string' ? 'M' : entry?.rights ?? 'M'
      if (typeof target !== 'string' || target.length === 0) continue
      grants.push({ target, ...grantPathToAppContainerSid(target, sidString, rights) })
    }
    this.granted = grants
    const failed = grants.filter((grant) => !grant.ok)
    if (failed.length > 0) {
      throw fail(
        'T0_UNAVAILABLE',
        `icacls could not grant the package SID access to: ${failed.map((g) => `${g.target} (${g.detail})`).join('; ')}. ` +
          'Without that grant the AppContainer child cannot even write inside the staged root, so the staged root would be ' +
          'unusable — refusing to start a T0 run (fail-closed).',
      )
    }
    // ── 缺陷③（Fix C）：退出兜底撤销，防止包 SID ACE 留在暂存根上 ────────────────
    //
    // `[实测]` `src/cli.mjs:257` 在 `try` 块里直接 `process.exit(exitCode)`，因此
    // `finally { executor.dispose() }`（`src/cli.mjs:258-260`）**根本不会执行** ——
    // `process.exit()` 不跑 `finally`（用同形状脚本实测：`finally` 一行都没打印）。
    // 后果：T0 每次运行都把 `S-1-15-2-…:(OI)(CI)(M)` 留在暂存根上（从不撤销），
    // 而**只要这一条 ACE 在，之后所有 T1 运行都写不进暂存根**（`Access is denied.`），
    // 且重跑 `init` 不自愈。审计把它记成"T0 污染"（`raw/B0-B3`、`raw/81-83`）。
    //
    // 兜底钩子：`process.exit()` **会**触发 `exit` 事件，而 `icaclsRun()` 是同步的
    // （`spawnSync` + 文件重定向），所以退出路径上能完成撤销。
    // 正常走 `dispose()` 时钩子会被摘掉（幂等，不会二次撤销）。
    if (this.exitHook) process.removeListener('exit', this.exitHook)
    this.exitHook = () => this._revokeGrantsOnExit()
    process.once('exit', this.exitHook)
    return { profileName: this.profileName, sid: sidString, grants }
  }

  /**
   * 退出兜底：只做**同步**的 ACL 撤销。任何失败都只能"少做"，
   * 绝不把异常抛进退出路径（那会把 exit code 弄脏）；漏掉的由 `init()` 的修复路径兜底。
   */
  _revokeGrantsOnExit() {
    for (const grant of this.granted ?? []) {
      try {
        icaclsRun([grant.target, '/remove:g', `*${this.sidString}`])
      } catch {
        /* 退出路径：失败留给下一次 init 的修复路径 */
      }
    }
    this.granted = []
  }

  /** 撤销 `attachRuntime()` 建立的全部 ACL 授权（dispose 调用；失败如实返回） */
  revokeGrants() {
    const failures = []
    for (const grant of this.granted) {
      const result = icaclsRun([grant.target, '/remove:g', `*${this.sidString}`])
      if (!result.ok) failures.push(`${grant.target}: ${result.detail}`)
    }
    this.granted = []
    return failures
  }

  /**
   * 启动一个 T0 子进程并**等到它退出**，输出从可继承的匿名管道读回。
   *
   * 顺序（与 `planCombinationOrder()` 一致）：建属性列表 → `CREATE_SUSPENDED` →
   * `AssignProcessToJobObject` → `ResumeThread` → **边等边排空管道** → 取退出码。
   */
  launch({ command, args = [], cwd, job, timeoutMs = 120000, env = null, beforeResume }) {
    if (!this.runtime) throw fail('T0_UNAVAILABLE', 'launcher was not attached to an AppContainerRuntime (fail-closed)')
    const commandLine = buildWindowsCommandLine(command, args)
    const environmentBlock = env === null || env === undefined ? null : encodeEnvironmentBlock(env)
    // stdin=NUL + stdout/stderr = 可继承匿名管道（见 openT0StdioPipes 的实测注释）
    const stdio = openT0StdioPipes(this.CreatePipe, this.CreateFileW)
    const startupInfoStdio = buildT0StdioHandles(this.koffi, stdio)
    let child
    try {
      child = this.runtime.spawn({
        commandLine,
        applicationName: command,
        cwd,
        // `[实测-阶段FIX-B]` 继承句柄 + 自有控制台：见文件顶部说明。
        inheritHandles: true,
        extraCreationFlags: CREATE_NEW_CONSOLE,
        startupInfoStdio,
        // 环境块（手册 #8.3：从允许清单**重建**，绝不继承父环境）。
        // 必须与 `CREATE_UNICODE_ENVIRONMENT` 成对（`buildCreationFlags` 会加那一位）——
        // 漏掉它 `CreateProcess` 返回 Win32 87，子进程根本创建不出来（缺陷 13）。
        environmentBlock: environmentBlock ?? null,
      })
    } finally {
      // 父进程必须**立刻**关掉自己那一份写端：否则子进程退出后管道也不会 EOF
      // （父进程永远读不到结尾 ⇒ 表现为"挂住"，而不是报错）。
      try {
        this.CloseHandleRaw(stdio.write)
      } catch {
        /* 忽略 */
      }
    }
    try {
      return this._runChild({ child, job, timeoutMs, stdio, beforeResume })
    } finally {
      closeT0Stdio({ stdin: stdio.stdin, read: stdio.read }, this.CloseHandleRaw)
    }
  }

  _runChild({ child, job, timeoutMs, stdio, beforeResume }) {
    try {
      if (job) {
        if (this.api.assignProcessToJobObject(job, child.process) === 0) {
          throw win32Error(this.api, 'AssignProcessToJobObject', `pid=${child.pid} (T0 path)`)
        }
      }
      // ★ T4 shim 注入点（T2 契约）：进程已建但**主线程未恢复**。AppInit_DLLs 类
      // 注入对 AppContainer 无效，必须在 `runtime.resume(child)` 之前做
      // `CREATE_SUSPENDED → 注入 → ResumeThread`。未提供时行为逐字不变。
      // 注入失败必须抛错（外层会 TerminateProcess + 归还句柄），绝不"带着未注入的
      // 子进程继续跑" —— 那会让报告声称的强制边界根本没生效。
      if (typeof beforeResume === 'function') {
        beforeResume({ pid: child.pid, process: child.process, thread: child.thread })
      }
      this.runtime.resume(child)
      const drained = this._waitAndDrain(child.process, timeoutMs, stdio)
      const codeSlot = [0]
      const got = this.GetExitCodeProcess(child.process, codeSlot)
      const exitCode = got === true || got === 1 ? codeSlot[0] : null
      if (drained.timedOut) safeTerminate(this.TerminateProcess, child.process)
      this.lastLaunch = {
        pid: child.pid,
        jobAssigned: job !== undefined && job !== null,
        waited: drained.lastWait,
        timedOut: drained.timedOut,
        capturedBytes: drained.captured.length,
        stdioKind: 'single-inheritable-pipe (stdout+stderr merged)',
        inheritance: 'inherit-handles+create-new-console+pipe-stdio',
        streamsSeparable: false,
      }
      // `[实测]` T0 下两条流**共用同一个写端**（见 `openT0StdioPipes` 的三条结论），
      // 因此捕获到的内容一律计入 `stdout`、`stderr` 留空。**不**假装能区分：
      // 把合并内容复制到两个字段里，会让"命令写没写 stderr"这种判断出现假证据。
      return { pid: child.pid, exitCode, timedOut: drained.timedOut, stdout: drained.captured, stderr: Buffer.alloc(0) }
    } catch (error) {
      safeTerminate(this.TerminateProcess, child.process)
      throw error
    } finally {
      // 无论成败都必须归还这两个句柄（"忘了关"在进程退出前不报任何错）
      try {
        this.CloseHandleRaw(child.thread)
      } catch {
        /* 句柄已失效即视为已释放 */
      }
      try {
        this.CloseHandleRaw(child.process)
      } catch {
        /* 同上 */
      }
    }
  }

  /**
   * 有界等待 + **持续排空管道**。
   *
   * ── 为什么不能"先等退出再读"（这是 D11 的同一类死锁）──────────────────────────
   * 匿名管道缓冲区写满后，子进程会阻塞在 `WriteFile` 上等待有人读；而父进程若先
   * `WaitForSingleObject(INFINITE)`，就再也没有人去读 ⇒ 双方互等，直到外层超时。
   * 实测表征与小输出无关：**只有输出超过管道缓冲才会触发**（本仓库 D11 的教训）。
   * 因此这里每睡 `T0_WAIT_SLICE_MS` 就排空一次两条管道，直到进程退出或超时。
   *
   * 排空用 `PeekNamedPipe` 先问"有多少可读"，再按这个长度 `ReadFile`：
   * 直接用阻塞 `ReadFile` 会在"子进程还活着但暂时没输出"时把我们自己挂住。
   */
  _waitAndDrain(processHandle, timeoutMs, stdio) {
    const deadline = Date.now() + timeoutMs
    const captured = []
    let lastWait = null
    let timedOut = false
    for (;;) {
      lastWait = this.WaitForSingleObject(processHandle, T0_WAIT_SLICE_MS)
      drainPipeAvailable(this.PeekNamedPipe, this.ReadFile, stdio.read, captured)
      if (lastWait === 0) break // WAIT_OBJECT_0：已退出，读走剩余数据
      if (Date.now() >= deadline) {
        timedOut = true
        break
      }
    }
    // 收尾再排一次：进程已退出时管道里可能还有最后一块（此时读端能读到 EOF）
    drainPipeAvailable(this.PeekNamedPipe, this.ReadFile, stdio.read, captured)
    return { captured: Buffer.concat(captured), timedOut, lastWait }
  }

  dispose() {
    const failures = []
    if (this.runtime) {
      try {
        const result = this.runtime.dispose()
        for (const item of result?.failures ?? []) failures.push(`runtime: ${item}`)
      } catch (error) {
        failures.push(`runtime.dispose threw: ${error.message}`)
      }
    }
    failures.push(...this.revokeGrants())
    // 授权已经显式撤销了，摘掉退出兜底（幂等：不能二次撤销别人的 ACE）
    if (this.exitHook) {
      process.removeListener('exit', this.exitHook)
      this.exitHook = undefined
    }
    this.runtime = undefined
    return failures
  }
}

function safeTerminate(TerminateProcess, process) {
  try {
    TerminateProcess(process, 1)
  } catch {
    /* 已在收尾路径 */
  }
}

function safeUnlink(path) {
  try {
    if (existsSync(path)) {
      unlinkSync(path)
      return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * 打开 T0 子进程的 stdio 管道。
 *
 * ── `[实测]` 三条硬结论（原始证据在 `.t\sbx3\wire\`）────────────────────────────
 * 1. **句柄必须可继承**。`CreateFileW()`（不可继承）或 `CreatePipe(..., sa=NULL)`
 *    （不可继承）的句柄填进 `STARTF_USESTDHANDLES` ⇒ AppContainer 子进程**一律**
 *    以 `0xC0000142`（STATUS_DLL_INIT_FAILED）死掉（`node.exe` 与 `cmd.exe` 都是）。
 *    见 `t0-stdio-matrix.out.txt`（C/G 行）与 `t0-pipe-stdio.out.txt`（P4 行）。
 *    `bInheritHandles=TRUE` 会把这批"不可继承"的句柄**过滤掉**，子进程启动时
 *    标准句柄指向无效值 ⇒ 用户态初始化失败。这也是为什么"继承句柄 + 文件 stdio"
 *    在本机根本走不通，只能走管道。
 *
 * 2. **两条管道分别承载 stdout/stderr 时，本机会把子进程的输出与错误接反**
 *    （`t0-stream-routing.out.txt` 的 `two-pipes` 行：`cmd /c echo CMD-OUT` 出现在
 *    **stderr** 管道里，stdout 管道 0 字节）。这不是我们的接线错误：同一份缓冲区里
 *    `hStdOutput`/`hStdError` 的值与父进程打开的写端**逐位一致**（探针把这两个字段
 *    原样打印出来了）。因此"分成两条流"在本机不可靠。
 *
 * 3. **两条流共用同一个写端时路由稳定**：`same-pipe` 行里 `cmd /c echo CMD-OUT`
 *    确实出现在 stdout 管道里。所以 T0 采用**单管道**：`stdout` 与 `stderr` 写同一个
 *    管道，父进程把读到的内容计入 `stdout`、`stderr` 留空。
 *
 * ── 诚实声明（必须随报告一起给出）────────────────────────────────────────────
 * T0 档位下**无法区分 stdout 与 stderr**（合并成一条流）。这是本机实测的限制，
 * 不是"没实现"。要区分必须先把上面第 2 条的成因查清（已超出本轮范围）。
 * 判据层面不受影响：退出码、区外写被拒、网络被阻断都由**独立**观测给出。
 *
 * ── 为什么 stdin 用 NUL ────────────────────────────────────────────────────
 * 子进程不应从我们的控制台读（读走父进程 stdin 会变成说不清的挂起）。
 *
 * @returns {{read:unknown, write:unknown, stdin:unknown, merged:boolean}}
 */
function openT0StdioPipes(CreatePipe, CreateFileW) {
  const securityAttributes = makeInheritableSecurityAttributes()
  const readSlot = [null]
  const writeSlot = [null]
  const ok = CreatePipe(readSlot, writeSlot, securityAttributes, 0)
  if (!win32Succeeded(ok) || !readSlot[0] || !writeSlot[0]) {
    throw fail('T0_UNAVAILABLE', 'CreatePipe failed; without an inheritable pipe the AppContainer child has no usable stdout/stderr')
  }
  // stdin = NUL（同一个可继承 SECURITY_ATTRIBUTES）
  const stdin = CreateFileW('NUL', GENERIC_READ, 0x00000001 | 0x00000002, securityAttributes, OPEN_EXISTING, 0, null)
  if (!stdin) throw fail('T0_UNAVAILABLE', 'CreateFileW(NUL) failed for the T0 child stdin')
  return { read: readSlot[0], write: writeSlot[0], stdin, merged: true }
}

/**
 * `[官方]` `SECURITY_ATTRIBUTES { DWORD nLength; LPVOID lpSecurityDescriptor; BOOL bInheritHandle; }`
 * x64：4 + 4(pad) + 8 + 4 + 4(pad) = 24 字节。
 *
 * `bInheritHandle=TRUE` 是**必须**的：`[实测]` 不可继承的管道写端会让 AppContainer 子进程
 * 以 `0xC0000142` 死掉（见 `openT0StdioPipes` 的注释）。
 */
export function makeInheritableSecurityAttributes() {
  const buffer = Buffer.alloc(24)
  buffer.writeUInt32LE(24, 0)
  buffer.writeBigUInt64LE(0n, 8)
  buffer.writeUInt32LE(1, 16)
  return buffer
}

/** 关闭 T0 stdio 的全部句柄（父进程这一侧两端都要关，否则管道永远不会 EOF） */
function closeT0Stdio(stdio, closeHandle) {
  for (const handle of [stdio?.stdin, stdio?.read, stdio?.write]) {
    if (!handle) continue
    try {
      closeHandle(handle)
    } catch {
      /* 关闭失败只影响句柄泄漏，不影响判定 */
    }
  }
}

/** 把打开的句柄地址交给 `STARTUPINFOEXW`（`koffi.address` 对 koffi 句柄返回 bigint） */
function buildT0StdioHandles(koffi, stdio) {
  const address = koffi.address(stdio.write)
  if (typeof address !== 'bigint') throw fail('T0_UNAVAILABLE', 'koffi.address(handle) did not return a bigint')
  return {
    stdInput: ((value) => {
      const input = koffi.address(value)
      if (typeof input !== 'bigint') throw fail('T0_UNAVAILABLE', 'koffi.address(stdin) did not return a bigint')
      return input
    })(stdio.stdin),
    // 两条流共用同一个写端：见 openT0StdioPipes 的第 3 条结论
    stdOutput: address,
    stdError: address,
  }
}

/**
 * 读走一条管道里**当前所有可读**的数据（非阻塞）。
 *
 * 先 `PeekNamedPipe` 问"有多少可读"：这一句是必需的，因为 `ReadFile` 在"子进程活着但
 * 暂时没输出"时会**阻塞**——那会把父进程挂住，重现"父进程不排水"的同类死锁。
 */
function drainPipeAvailable(PeekNamedPipe, ReadFile, pipe, sink) {
  if (!pipe) return
  const available = [0]
  const peeked = PeekNamedPipe(pipe, null, 0, null, available, null)
  if (!win32Succeeded(peeked)) return
  let remaining = available[0] >>> 0
  if (remaining === 0) return
  const buffer = Buffer.alloc(Math.min(remaining, 65536))
  const readSlot = [0]
  while (remaining > 0) {
    const ok = ReadFile(pipe, buffer, buffer.length, readSlot, null)
    if (!win32Succeeded(ok) || (readSlot[0] >>> 0) === 0) break
    const count = readSlot[0] >>> 0
    sink.push(Buffer.from(buffer.subarray(0, count)))
    remaining -= count
  }
}

/** `[实测]` 单个 exe 的 T0 等待切片：够短以便及时排空管道，又不至于空转烧 CPU */
export const T0_WAIT_SLICE_MS = 20

/** 与 `src/appcontainer-runtime.mjs::win32BoolSucceeded` 同语义（真实 koffi 的 `bool` 是 JS boolean） */
function win32Succeeded(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return false
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 2 / WP1：收窄档（受限令牌）在暂存根上的**写授权**——目标解析 + fail-closed 闸门
// ═══════════════════════════════════════════════════════════════════════════
//
// ── 要解决的问题（WP0 实测）────────────────────────────────────────────────
// WP0 把默认暂存根从工作区 `.dshstage\staged`（工作区内、模型可见）搬到
// `%LOCALAPPDATA%\Temp\winstage-stage\<会话键>`（缓存面）。但**能力 SID 的写授权
// （ACE）此前只落在工作区那棵树上**；迁移之后：
//   · 受限令牌下的子进程**连 `mkdir` 都 EPERM**（WP0 实测，pwsh 与 node 双通道一致）；
//   · 宿主进程能建、能写这个缓存根。
// ⇒ 若授权目标仍是老的工作区树，收窄档在缓存模型下**根本写不进暂存**，整条沙箱失效。
//
// ── 本段做的四件事（顺序即语义，不得调换）─────────────────────────────────────
//   ① **目标解析**（`stageGrantTarget`）：显式 override 逐字采用（测试/单实例通道）；
//      否则**只**认 WP0 的 `resolveStageRoot()`。本文件不拼任何默认暂存路径。
//   ② **宿主先建根**（`ensureStageGrant` 的第 1 步）：子进程建不出 ⇒ 建不出即
//      `STAGE_GRANT_FAILED`（`root-not-creatable:<code>`），**绝不静默回落工作区**。
//   ③ **授权**：把 `writeSid`（能力 SID，本仓库形如 `S-1-4-…`）连同目标根交给 ACL 后端；
//      这一步抛错或回报失败 ⇒ `STAGE_GRANT_FAILED`（`grant-call-failed`）。
//   ④ **回读验证**：读目标根的 DACL，确认那条允许 ACE 真的在。**读得到但查不到 ⇒
//      直接失败**（`ace-not-verified`）；**压根读不到 / 那个 writeSid 不是合法 SID
//      ⇒ 如实报 `verified:false`（unmeasured），不冒充已验证**（下游 Fix A 闸门对
//      "测不出来"一律按未通过处置，因此这里不制造假的 pass）。
//   ⑤ **授权成功后才允许派发命令**：`assertStagingWriteEnforceable()` 里有一道
//      **不可被 `stagingWriteCheck` 覆盖**的授权门（见该函数 ③ 段）。
//
// ── 透明性（硬约束，与 `src/stage-guard.mjs` 同一口径）──────────────────────────
// 本段产出的 Error.message 里**不得**出现「沙箱」「暂存」「替代路径」「sandbox」
// 「staging」「stage」「shadow」。因此 message 一律是普通的失败描述，路径/SID/后端
// 返回原文全部挂在**非 message 属性**（`.root` / `.writeSid` / `.detail` / `.steps`），
// 只有代码与日志看得见（`.code` 是机器标识，不算文案）。

/** WP1 稳定错误码：根在、但**没被授权给本次运行的身份**（与两个 WP0 码明确区分） */
export const STAGE_GRANT_FAILED = 'STAGE_GRANT_FAILED'

/**
 * `STAGE_GRANT_FAILED` 的机读原因（每条都可归因到唯一一步）。
 * 注意：这些字符串会出现在 message 的括号里，因此**都过透明性机检**（见 wp1-test 的阳性对照）。
 */
export const STAGE_GRANT_REASONS = Object.freeze({
  /** 没有可用的授权目标（调用方既没给 override，`resolveStageRoot` 也没给出根） */
  NO_TARGET: 'no-grant-target',
  /** 宿主进程都建不出这个根（WP0 的典型形态：受限子进程建缓存根 ⇒ EPERM） */
  ROOT_NOT_CREATABLE: 'root-not-creatable',
  /** 拿不到本次运行要授权的写身份（能力 SID） */
  WRITE_SID_UNAVAILABLE: 'write-sid-unavailable',
  /** 授权调用本身抛错 / 后端回报失败 */
  GRANT_CALL_FAILED: 'grant-call-failed',
  /** 回读 DACL 成功，但里面**没有**那条允许 ACE（确定的失败，不是"测不出来"） */
  ACE_NOT_VERIFIED: 'ace-not-verified',
  /** 回读不了 DACL、或 writeSid 不是合法 SID ⇒ **如实报未验证**（不是"已验证通过"） */
  ACE_NOT_VERIFIABLE: 'ace-not-verifiable',
})

/** 合法 SID 的字符串形态（`S-<rev>-<authority>-<sub>…`，只允许十进制子授权） */
const SID_TEXT_PATTERN = /^S-1-\d+(?:-\d+)+$/

/** 这个字符串是不是一个**可以按名字在 DACL 里找**的合法 SID */
export function isSidString(value) {
  return typeof value === 'string' && SID_TEXT_PATTERN.test(value)
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value === undefined || value === null) continue
    if (String(value).trim() === '') continue
    return String(value)
  }
  return undefined
}

/**
 * ── 授权目标的**唯一解析点**（纯函数，不碰 fs，不建目录）──────────────────────
 *
 * 优先级：显式 override（`stagingRoot` / `override`）> `resolveStageRoot(...)`。
 *   · override 是**向后兼容通道**（离线测试、单实例自检、`storeDir` 注入），逐字采用；
 *   · 没有 override 时**只**认 WP0 的 `resolveStageRoot()` —— 即缓存根
 *     `%LOCALAPPDATA%\Temp\winstage-stage\<会话键>`。
 *   · **绝不再回落**到工作区里的 `<workspaceRoot>\.dshstage\staged`：那正是 WP1 要拆掉的
 *     老默认（迁移后它不再是暂存面，授权落在那里等于没授权）。
 *
 * `source` 是机读字段，供测试与报告断言"这次到底是从哪来的根"：
 *   `'explicit-override'` | `'resolve-stage-root'`。
 *
 * @param {{stagingRoot?:string, override?:string, sessionKey?:string,
 *          workspaceRoot?:string, env?:object}} options
 * @returns {{root:string, source:string, override:boolean}}
 */
export function stageGrantTarget(options = {}) {
  const explicit = firstNonEmpty(options.stagingRoot, options.override)
  if (explicit !== undefined) {
    return { root: normalize(resolve(explicit)), source: 'explicit-override', override: true, keyed: true }
  }
  const env = options.env
  const keyed =
    firstNonEmpty(options.sessionKey, options.workspaceRoot, env?.DSH_SESSION_ID, env?.WINSTAGE_SESSION_ID, env?.DSH_SESSION, process.env.DSH_SESSION_ID, process.env.WINSTAGE_SESSION_ID, process.env.DSH_SESSION) !==
    undefined
  return {
    root: resolveStageRoot({ sessionKey: options.sessionKey, workspaceRoot: options.workspaceRoot, env }),
    source: 'resolve-stage-root',
    override: false,
    /**
     * `keyed`：这条缓存根是不是**按会话/工作区定键**的。
     *
     * 为什么需要它：`resolveStageRoot()` 在既没有会话键、也没有工作区根时返回的是
     * 通用的 `<baseDir>\default` —— **所有无键调用方会共用同一个根**。那不是"会话根"，
     * 拿它当暂存面会把两个会话的暂存混在一起。因此未定键时调用方（`WindowsStageExecutor`）
     * **照旧拒绝启动**（`SANDBOX_UNAVAILABLE: stagingRoot is required`，与接线前逐字一致），
     * 而不是悄悄用上这个共享根。注意这与"授权失败"是两件事：那是**配置缺失**，这是
     * `STAGE_GRANT_FAILED` 的范畴（根有了却没授权上）。
     */
    keyed,
  }
}

/**
 * 构造 `STAGE_GRANT_FAILED`。message 刻意**不含路径、不含内部行话**（透明性硬约束）；
 * 诊断信息全部在非 message 属性上：
 *   `.root` / `.writeSid` / `.detail` / `.steps` / `.distinctFrom`
 * `distinctFrom` 明确写出它与两个 WP0 码的分工，避免下游把三者混成一个"暂存坏了"。
 */
export function stageGrantError(reason, detail = {}) {
  const error = new Error(`the protected session directory could not be prepared for writing (${reason})`)
  error.name = 'StageGrantError'
  error.code = STAGE_GRANT_FAILED
  error.reason = reason
  if (detail.root !== undefined) error.root = detail.root
  if (detail.writeSid !== undefined) error.writeSid = detail.writeSid
  if (detail.detail !== undefined) error.detail = detail.detail
  if (detail.steps !== undefined) error.steps = detail.steps
  error.policyDenial = false
  error.distinctFrom = {
    [STAGE_ROOT_LOST]: '根/哨兵/守护在建立**之后**失效（丢失即显形，WP0）',
    [STAGE_GUARD_UNAVAILABLE]: '根/守护在本次运行**之前**就建不起来（WP0）',
    [STAGE_GRANT_FAILED]: '根在，但**没被授权给本次运行的身份** —— 授权链未接通（WP1）',
  }
  return error
}

/**
 * ── 回读验证：目标根的 DACL 里到底有没有那条允许 ACE ──────────────────────────
 *
 * 三条判据，**缺一不猜**：
 *   ① `writeSid` 必须是合法 SID 形态，否则"按名字在 DACL 里找"这件事本身不成立
 *      ⇒ `measured:false`（未验证）。这一条同时让离线替身（形如 `S-1-4-1-1-fake(<path>)`
 *      的注入值）不会被误判成"授权失败"，也不会去 spawn 真 `icacls`。
 *   ② 读不到 DACL ⇒ `measured:false`（未验证）。**"读不到"绝不等于"干净"**（与
 *      `repairStaleAppContainerAces` 同一纪律）。
 *   ③ 读到了：ACE 在 ⇒ `verified:true`；不在 ⇒ `verified:false, measured:true`（确定失败）。
 *
 * 继承来的 ACE 也算（`inherited:true` 一并回传）：写权限确实存在才是判据，
 * "是不是本次显式写进去的"是另一个问题（那个判据属于 `repairStaleAppContainerAces`）。
 *
 * 注入缝：`readSddl` / `parseSddl`（离线确定性测试用；生产不传即走真实 `icacls` + 真解析器）。
 */
export function verifyStageGrantAce(options = {}) {
  const root = options.root
  const writeSid = options.writeSid
  if (!isSidString(writeSid)) {
    return {
      verified: false,
      measured: false,
      reason: STAGE_GRANT_REASONS.ACE_NOT_VERIFIABLE,
      root,
      writeSid,
      detail: `the write identity is not a syntactically valid SID, so no access entry can be looked up by name: ${String(writeSid)}`,
    }
  }
  const read = options.readSddl ?? ((target) => readDaclSddl(target, options))
  let readBack
  try {
    readBack = read(root)
  } catch (error) {
    return {
      verified: false,
      measured: false,
      reason: STAGE_GRANT_REASONS.ACE_NOT_VERIFIABLE,
      root,
      writeSid,
      detail: `reading back the access control list threw: ${error.code ?? ''} ${error.message}`.trim(),
    }
  }
  if (!readBack || readBack.ok !== true) {
    return {
      verified: false,
      measured: false,
      reason: STAGE_GRANT_REASONS.ACE_NOT_VERIFIABLE,
      root,
      writeSid,
      detail: `could not read back the access control list of ${root}: ${readBack?.detail ?? '(no detail)'}`,
    }
  }
  const parse = options.parseSddl ?? parseSddlDaclAces
  let aces = []
  let unparsed = []
  try {
    const parsed = parse(readBack.sddl)
    aces = Array.isArray(parsed?.aces) ? parsed.aces : []
    unparsed = Array.isArray(parsed?.unparsed) ? parsed.unparsed : []
  } catch (error) {
    return {
      verified: false,
      measured: false,
      reason: STAGE_GRANT_REASONS.ACE_NOT_VERIFIABLE,
      root,
      writeSid,
      detail: `the access control list could not be parsed: ${error.message}`,
    }
  }
  const wanted = String(writeSid).toUpperCase()
  const match = aces.find((ace) => ace.type === 0 && String(ace.sid).toUpperCase() === wanted)
  if (!match) {
    return {
      verified: false,
      measured: true,
      reason: STAGE_GRANT_REASONS.ACE_NOT_VERIFIED,
      root,
      writeSid,
      sddl: readBack.sddl,
      present: aces.map((ace) => ace.sid),
      unparsed,
      detail:
        `the access control list of ${root} has no ACCESS_ALLOWED entry for ${writeSid}` +
        (unparsed.length > 0 ? ` (${unparsed.length} entry/entries could not be parsed)` : ''),
    }
  }
  return {
    verified: true,
    measured: true,
    reason: 'ace-present',
    root,
    writeSid,
    inherited: match.inherited === true,
    rights: match.rights,
    detail: `ACCESS_ALLOWED entry for ${writeSid} is present on ${root}${match.inherited === true ? ' (inherited)' : ''}`,
  }
}

/**
 * ── 闸门本体：**宿主建根 → 授权 → 回读验证**（顺序即语义）──────────────────────
 *
 * 任一步失败 ⇒ 抛 `STAGE_GRANT_FAILED`（fail-closed）。判据：
 *   · 建不出根（宿主也建不出）⇒ `root-not-creatable`（**绝不换地方继续**）；
 *   · 拿不到写身份 ⇒ `write-sid-unavailable`；
 *   · `runGrant()` 抛错或回报 `{ok:false}` ⇒ `grant-call-failed`
 *     （只读档没有授权这回事，后端自身的异常**原样抛出**，不套这个码）；
 *   · 回读查不到 ACE ⇒ `ace-not-verified`；回读不了 DACL ⇒ `ace-not-verifiable`。
 *     **两者都失败** —— "测不出来"与"测出来没有"在处置上是同一件事：不许跑。
 *   · 唯一例外是 `injectedBackend:true`（调用方注入了 `overrides.AclSandbox` 替身）：
 *     替身不写真实 ACE，回读注定测不到 ⇒ 如实记录 `verified:false` 而不抛，
 *     由下游 `stagingWriteEnforceability()` 按"未测量"处置（离线套件必须显式注入
 *     `stagingWriteCheck` 才能拿到 pass —— 既有约定，本函数不改变它）。
 *
 * 注入缝（离线测试用）：`runGrant` / `resolveWriteSid` / `readSddl` / `parseSddl`
 * / `verifyStageGrantAce` / `injectedBackend`。
 *
 * @returns {Promise<{target:object, writeSid?:string, created:boolean, hostCreated:boolean,
 *                    granted:boolean, writable:boolean, verification:object,
 *                    steps:Array, value:unknown}>}
 */
export async function ensureStageGrant(options = {}) {
  const target = options.target ?? stageGrantTarget(options)
  const steps = []
  const root = target?.root
  if (typeof root !== 'string' || root.length === 0) {
    throw stageGrantError(STAGE_GRANT_REASONS.NO_TARGET, {
      detail: 'neither an explicit override nor resolveStageRoot() produced a directory to authorise',
      steps,
    })
  }
  // ① 根必须**先由宿主进程创建**：受限令牌下的子进程连 mkdir 都是 EPERM（WP0 实测）。
  //    做成目录句柄？不需要 —— 抗外部清理由 WP0 的守护负责，这里只保证"根先存在"。
  let created = false
  try {
    created = !existsSync(root)
    mkdirSync(root, { recursive: true })
    steps.push({ step: 'host-create-root', ok: true, by: 'host-process', created, root })
  } catch (error) {
    steps.push({ step: 'host-create-root', ok: false, by: 'host-process', root, detail: `${error.code ?? 'ERR'}: ${error.message}` })
    throw stageGrantError(STAGE_GRANT_REASONS.ROOT_NOT_CREATABLE, {
      root,
      detail: `${error.code ?? 'ERR'}: ${error.message}`,
      steps,
    })
  }

  const writable = options.writable !== false

  // ② 写身份（能力 SID）必须拿得到；拿不到就**不许**开始授权，更不许继续跑命令。
  //    只读档没有可授权的写面（`writableDirs: []`），因此不解析身份 —— 但**照样**要
  //    走 ③ 的 `runGrant`，因为那一步同时负责"构造受限令牌"（`AclSandbox.init()`），
  //    跳过它会让只读档根本没有沙箱实例（与接线前的行为不符）。
  let writeSid
  if (writable) {
    const resolveWriteSid = options.resolveWriteSid ?? options.workspaceWriteSid
    try {
      writeSid = options.writeSid !== undefined ? options.writeSid : resolveWriteSid?.(root)
    } catch (error) {
      steps.push({ step: 'resolve-write-identity', ok: false, root, detail: `${error.code ?? 'ERR'}: ${error.message}` })
      throw stageGrantError(STAGE_GRANT_REASONS.WRITE_SID_UNAVAILABLE, {
        root,
        detail: `${error.code ?? 'ERR'}: ${error.message}`,
        steps,
      })
    }
    if (typeof writeSid !== 'string' || writeSid.length === 0) {
      steps.push({ step: 'resolve-write-identity', ok: false, root, detail: String(writeSid) })
      throw stageGrantError(STAGE_GRANT_REASONS.WRITE_SID_UNAVAILABLE, {
        root,
        detail: `resolving the write identity returned ${JSON.stringify(writeSid ?? null)}`,
        steps,
      })
    }
    steps.push({ step: 'resolve-write-identity', ok: true, root, writeSid })
  } else {
    steps.push({ step: 'resolve-write-identity', ok: true, skipped: 'read-only-mode', root })
  }

  // ③ 授权。`runGrant` 的返回值原样透传给调用方（例如已经初始化的 ACL 后端实例）。
  let value
  if (typeof options.runGrant === 'function') {
    let outcome
    try {
      outcome = await options.runGrant(root, writeSid)
    } catch (error) {
      steps.push({ step: 'authorise', ok: false, root, writeSid, detail: `${error.code ?? 'ERR'}: ${error.message}` })
      // 只读档没有"授权"这件事：后端自身的错误**原样抛出**（与接线前逐字一致），
      // 不把它包装成一个关于授权的码 —— 那会把"令牌建不出来"误报成"授权失败"。
      if (!writable) throw error
      throw stageGrantError(STAGE_GRANT_REASONS.GRANT_CALL_FAILED, {
        root,
        writeSid,
        detail: `${error.code ?? 'ERR'}: ${error.message}`,
        steps,
      })
    }
    if (outcome && outcome.ok === false) {
      steps.push({ step: 'authorise', ok: false, root, writeSid, detail: String(outcome.detail ?? '(no detail)') })
      throw stageGrantError(STAGE_GRANT_REASONS.GRANT_CALL_FAILED, {
        root,
        writeSid,
        detail: String(outcome.detail ?? '(no detail)'),
        steps,
      })
    }
    value = outcome?.value !== undefined ? outcome.value : outcome
    steps.push({ step: 'authorise', ok: true, root, writeSid, skipped: writable ? undefined : 'read-only-mode' })
  } else {
    value = options.grantedValue
    steps.push({ step: 'authorise', ok: true, root, writeSid, skipped: 'no-grant-callback' })
  }

  // ④ 回读验证（判据全在 `verifyStageGrantAce` 里；这里只决定"要不要因此失败"）。
  let verification
  if (!writable) {
    verification = { verified: false, measured: false, reason: 'read-only-mode', root }
  } else if (options.verifyStageGrantAce === false) {
    verification = { verified: false, measured: false, reason: 'verification-disabled-by-caller', root, writeSid }
  } else {
    const verify = options.verifyStageGrantAce ?? verifyStageGrantAce
    verification = verify({ root, writeSid, readSddl: options.readSddl, parseSddl: options.parseSddl, captureDir: options.captureDir })
  }
  steps.push({
    step: 'verify-access-entry',
    ok: verification.verified === true,
    measured: verification.measured === true,
    root,
    writeSid,
    reason: verification.reason,
  })
  /**
   * 失败判据（**这是 fail-closed 的落点**）：
   *   · 默认（生产路径 / 真实 ACL 后端）⇒ **`verified !== true` 一律失败**。
   *     查不到 ACE ⇒ `ace-not-verified`（确定失败）；DACL 读不到 ⇒ `ace-not-verifiable`
   *     （"测不出来"同样不许当作通过 —— 那正是本项目反复出现的"静默降级"形态）。
   *   · `options.injectedBackend === true`（调用方显式注入了 `overrides.AclSandbox` 替身）
   *     ⇒ 替身不写真实 ACE，回读注定测不到。此时**如实记录 `verified:false` 而不抛**：
   *     这不是放行 —— 下游 `stagingWriteEnforceability()` 对"未测量"一律按未通过处置，
   *     离线套件必须显式注入 `stagingWriteCheck` 才能拿到 pass（既有约定，未改动）。
   */
  const strict = options.injectedBackend !== true
  if (strict && verification.verified !== true) {
    const reason = verification.measured === true ? STAGE_GRANT_REASONS.ACE_NOT_VERIFIED : STAGE_GRANT_REASONS.ACE_NOT_VERIFIABLE
    throw stageGrantError(reason, {
      root,
      writeSid,
      detail: verification.detail,
      steps,
    })
  }

  return {
    target,
    created,
    hostCreated: true,
    granted: writable,
    writable,
    writeSid,
    verification,
    steps,
    value,
  }
}

/** 撤销一项 ACL 授权（`icacls <dir> /remove:g *<sid>`） */
function grantPathToAppContainerSid(target, sidString, rights = 'M') {
  const result = icaclsRun([target, '/grant', `*${sidString}:(OI)(CI)${rights}`])
  return { ok: result.ok, detail: result.detail, rights }
}

/**
 * `[实测]` 用 `icacls` 而不是自己拼 ACL：包 SID 的字符串形式必须带 `*` 前缀（否则被当账户名解析）。
 *
 * ── 缺陷（T2 报告，2026-09-30）：**不能**用命名管道捕获 ─────────────────────────
 * 原实现是 `execFileSync('icacls', args, { stdio: ['ignore','pipe','pipe'] })`。
 * 在受限令牌 + DSH file sandbox 的会话里，命名管道被拒 ⇒ 恒
 * `EPERM spawnSync icacls EPERM` ⇒ `attachRuntime()` 抛 `T0_UNAVAILABLE`，
 * 于是 **T0 的 ACL 授权成功路径在该会话完全不可用**（`tests/appcontainer-runtime.mjs`
 * §13 因此只能如实 SKIP，而不是通过）。这正是 README §1.1 / 残余边界 R10：
 * `run.cmd` / `autotest.cmd` 早已改用**文件描述符重定向**绕过它。
 *
 * 本机实测对照（同一会话）：
 *   `icacls . > file`（PS 重定向）⇒ 文件 **0 字节**（静默丢数据）
 *   `runCapturedToFiles('icacls', ['.'])`（fd 重定向）⇒ exit=0 且拿到完整 DACL 文本
 *
 * 语义不变：成功返回 `{ok:true, detail}`，失败返回 `{ok:false, detail}`（绝不抛进调用方）。
 */
function icaclsRun(args) {
  const captureDir = join(tmpdir(), 'dsh-icacls-capture')
  try {
    const result = runCapturedToFiles('icacls', args, { captureDir, timeoutMs: 30000 })
    const text = `${result.out}${result.err ? ` | ${result.err}` : ''}`.replace(/\r?\n/g, ' | ').trim()
    if (result.code === 0) return { ok: true, detail: text }
    return { ok: false, detail: `${result.error ?? `exit=${result.code}`}${text ? ` | ${text.slice(0, 300)}` : ''}`.trim() }
  } catch (error) {
    // 连"用文件采集"都做不到时，退回旧的管道实现并如实记下原因
    try {
      const { execFileSync } = require_('node:child_process')
      const text = String(execFileSync('icacls', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
        .replace(/\r?\n/g, ' | ')
        .trim()
      return { ok: true, detail: `${text} (fd capture unavailable: ${error.message})` }
    } catch (pipeError) {
      return { ok: false, detail: `${pipeError.code ?? ''} ${String(pipeError.message).slice(0, 200)}`.trim() }
    }
  }
}

/**
 * 读取一个目录的 DACL SDDL（只读；失败如实返回 `ok:false`，绝不猜）。
 *
 * `[实测]` 走 `icacls <dir> /save <file>` 再读文件，而不是 `Get-Acl | Format-List`：
 *   - `Get-Acl` 需要 PowerShell 子进程 + 结构化输出解析，本仓库的测试面禁止子进程管道捕获；
 *   - `/save` 的落盘内容是**标准 SDDL**（`D:AI(A;OICI;…)`），可以用纯函数解析，
 *     离线套件因此能直接喂合成 SDDL 给同一套判据（`src/appcontainer.mjs`）。
 */
export function readDaclSddl(dir, options = {}) {
  const captureDir = options.captureDir ?? join(tmpdir(), 'dsh-icacls-save')
  try {
    mkdirSync(captureDir, { recursive: true })
  } catch {
    return { ok: false, detail: `cannot create capture dir ${captureDir}` }
  }
  const file = join(captureDir, `dacl-${randomUUID().slice(0, 8)}.sddl`)
  try {
    const result = icaclsRun([dir, '/save', file])
    if (!result.ok) return { ok: false, detail: result.detail }
    // `[实测]` `icacls /save` 落盘的是 **UTF-16LE 且无 BOM**：
    //   原始头 16 字节 = 115,0,116,0,97,0,…（"staged\r\nD:AI…"）。
    // 用 utf8 读出来会得到 `s\0t\0a\0g\0e\0d\0…`，于是 `includes('D:')` 恒为 false —
    // 这正是"读不到 DACL"的真相（第一版就踩了这个坑，B1/B6 才没检出真 ACE）。
    const buffer = readFileSync(file)
    const utf16 = buffer.length >= 2 && buffer[1] === 0
    const text = buffer.toString(utf16 ? 'utf16le' : 'utf8')
    // `icacls /save` 每个条目一行：`<name> <SDDL>`，要的是 SDDL 那一列。
    const line = text.split(/\r?\n/).find((l) => l.includes('D:'))
    if (!line) return { ok: false, detail: `no SDDL in /save output for ${dir}` }
    const sddl = line.slice(line.indexOf('D:'))
    return { ok: true, sddl, detail: sddl }
  } catch (error) {
    return { ok: false, detail: `readDaclSddl failed: ${error.message}` }
  } finally {
    try {
      if (existsSync(file)) unlinkSync(file)
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

/**
 * **修复路径**（缺陷③）：摘掉暂存目录树上"被显式写进去的 AppContainer 包 SID ACE"。
 *
 * ── 为什么它必须存在 ─────────────────────────────────────────────────────────
 * `[实测]` 跑过一次 `--tier T0` 之后，暂存根上会残留
 * `S-1-15-2-…:(OI)(CI)(M)`（T0 为了包 SID 能写暂存根而授予的）；
 * 只要这一条在，**之后任何 T1 运行都写不进暂存根**（`Access is denied.`），
 * 而且重跑 `init` 不会自愈（审计 `raw/82-reinit.txt`）。
 *
 * ── 为什么可以安全删 ─────────────────────────────────────────────────────────
 * 判据（`findStaleAppContainerAces`）三条同时成立才删：
 *   ① **非继承**（`INHERITED_ACE` 未置位）—— 继承来的不是"被写进去的"，删了会动到祖先目录；
 *   ② `ACCESS_ALLOWED` —— DENY ACE 不碰；
 *   ③ 受托者是 AppContainer 包 SID（`S-1-15-2-*`）—— 不是普通用户/组/能力 SID。
 * 作用域**只有调用方给的那一个目录**（生产是暂存根），不下钻、不碰父目录。
 * T0 自己在运行时需要这条 ACE 时才授予，运行结束应当撤销；本函数只清理**遗留**。
 *
 * @returns {{repaired: boolean, removed: string[], remaining: string[], present: string[],
 *            sddlAvailable: boolean, verifyAvailable: boolean, reason?: string, commands: string[]}}
 */
export function repairStaleAppContainerAces(dir, options = {}) {
  const read = options.readSddl ?? ((target) => readDaclSddl(target, options))
  const run = options.runIcacls ?? icaclsRun
  const before = read(dir)
  if (!before.ok) {
    // 测不出来 ≠ 干净。如实返回"不可判定"，由调用方决定是拒绝还是继续。
    return {
      repaired: false,
      removed: [],
      remaining: [],
      present: [],
      sddlAvailable: false,
      verifyAvailable: false,
      reason: `cannot read the DACL of ${dir}: ${before.detail}`,
      commands: [],
    }
  }
  const found = findStaleAppContainerAces(before.sddl)
  const present = listAppContainerSids(before.sddl)
  if (found.stale.length === 0) {
    return {
      repaired: false,
      removed: [],
      remaining: [],
      present,
      sddlAvailable: true,
      verifyAvailable: true,
      reason:
        found.unparsed.length > 0
          ? `no stale package-SID allow ACE, but ${found.unparsed.length} ACE(s) could not be parsed (${found.unparsed
              .slice(0, 3)
              .join('')})`
          : 'no stale AppContainer package-SID ACE',
      commands: [],
    }
  }
  const commands = []
  const removed = []
  const failed = []
  for (const ace of found.stale) {
    // `icacls <dir> /remove:g *<sid>`：移除该受托者的全部显式授权（继承来的不受影响）。
    const command = `icacls "${dir}" /remove:g *${ace.sid}`
    commands.push(command)
    const result = run([dir, '/remove:g', `*${ace.sid}`])
    if (result.ok) removed.push(ace.sid)
    else failed.push(`${ace.sid}: ${result.detail}`)
  }
  const after = read(dir)
  const remaining = after.ok ? findStaleAppContainerAces(after.sddl).stale.map((a) => a.sid) : [...failed]
  const repaired = failed.length === 0 && remaining.length === 0
  return {
    repaired,
    removed,
    remaining,
    present: after.ok ? listAppContainerSids(after.sddl) : present,
    sddlAvailable: true,
    verifyAvailable: after.ok,
    commands,
    reason: repaired
      ? `removed ${removed.length} stale AppContainer package-SID ACE(s)`
      : `could not fully remove stale package-SID ACE(s): ${[...failed, ...remaining].join('; ')}`,
  }
}

/**
 * 构造一个**已就绪**的 T0 启动器（异步工厂）。
 *
 * 为什么必须是异步：`appcontainer-runtime.mjs` 是 ESM，`createRequire` 解析不了 `.mjs`，
 * 因此 `import()` 是唯一能在"已经跑起来的代码路径"里拿到它的方式。把 `.mjs` 的加载失败
 * **在装配期**暴露成清晰的 `T0_UNAVAILABLE`，而不是等到 `CreateProcess` 时才以一个
 * 说不清的错误冒出来。
 *
 * 任何一步失败都抛 `T0_UNAVAILABLE`（fail-closed），由调用方决定"退回 T1"还是"拒绝执行"；
 * 本函数**绝不**返回一个"看起来能用"的降级对象。
 */
export async function createAppContainerLauncher(options = {}) {
  const api = options.api
  if (!api || typeof api.assignProcessToJobObject !== 'function') {
    throw fail('T0_UNAVAILABLE', 'the merged binding table has no assignProcessToJobObject; T0 cannot enforce job ownership')
  }
  let runtimeModule
  try {
    runtimeModule = await import('./appcontainer-runtime.mjs')
  } catch (error) {
    throw fail('T0_UNAVAILABLE', `cannot load src/appcontainer-runtime.mjs: ${error.message}`)
  }
  const koffi = loadKoffiModule()
  if (!koffi) {
    throw fail(
      'T0_UNAVAILABLE',
      'koffi FFI is not resolvable from either the DSH install tree or $DSH_PROFILE_DIR\\node_modules; ' +
        'the AppContainer path needs it for CreateProcessW with a STARTUPINFOEXW',
    )
  }
  const bindings = runtimeModule.createKoffiAppContainerBindings(koffi)
  const launcher = new AppContainerLauncher(koffi, api, {
    profileName: options.profileName,
    capabilities: options.capabilities ?? [],
    grantPaths: options.grantPaths ?? [],
  })
  const runtime = new runtimeModule.AppContainerRuntime(bindings, {
    profileName: launcher.profileName,
    capabilities: launcher.capabilities,
    jobAvailable: true,
    // 三轮接线：进程缓解策略。缺省/`none` ⇒ `null` ⇒ 属性列表 1 个槽位、不写 MITIGATION_POLICY，
    // 与接线前的字节行为一致（`AppContainerRuntime` 内部用 attributeListCountFor 判定）。
    mitigationPolicy: options.mitigationPolicy ?? null,
  })
  const initReport = runtime.init()
  // `[实测]` 陷阱：`AppContainerRuntime.init()` 返回的 `sid` 是**原生 SID 指针**（不是字符串）。
  // 把它当字符串交给 `icacls` 时，错误信息是 `*2928003896448: The security ID structure is invalid.`
  // —— 一个看似"ACL 失败"、实则"类型搞错"的故障（本仓库"替身/真对象形状不一致"那一类）。
  // 因此这里必须显式过一遍 `ConvertSidToStringSidW`，拿不到字符串就 fail-closed。
  const sidString = typeof bindings.sidToString === 'function' ? bindings.sidToString(initReport.sid) : null
  if (typeof sidString !== 'string' || sidString.length === 0) {
    throw fail(
      'T0_UNAVAILABLE',
      'ConvertSidToStringSidW could not turn the package SID into a string; without it the staged root cannot be ' +
        'granted to the AppContainer (and comparing TokenAppContainerSid would be impossible)',
    )
  }
  const grantReport = launcher.attachRuntime(runtime, sidString)
  return {
    launcher,
    runtime,
    bindings,
    profileName: initReport.profileName,
    sid: sidString,
    createdProfile: initReport.createdHere,
    grants: grantReport.grants,
    attributeListSize: initReport.attributeListSize,
    // 三轮接线：如实回报"这次 T0 启动器带了什么缓解策略"（null = 没带）
    mitigation: initReport.mitigation ?? null,
    attributeCount: initReport.attributeCount ?? 1,
  }
}

/**
 * 解析 koffi（T0 用的 FFI）。
 *
 * 候选顺序与 `src/capability.mjs::loadFfi()` 保持一致（**同一份实现只能有一个来源**，
 * 否则"探测说能跑、执行说不能跑"就是必然的）。这里只做解析，不做任何 Win32 调用。
 */
export function loadKoffiModule() {
  const candidates = [...resolveDshModuleRoot().map((root) => join(root, 'koffi'))]
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0) {
    candidates.push(join(process.env.DSH_PROFILE_DIR, 'node_modules', 'koffi'))
  }
  candidates.push('koffi')
  for (const spec of candidates) {
    try {
      const loaded = require_(spec)
      if (loaded && typeof loaded.load === 'function') return loaded
    } catch {
      /* 下一个候选 */
    }
  }
  return undefined
}

/** 受限令牌启动器：绑定表 + 令牌 + Job 的组合 */
export class RestrictedLauncher {
  constructor(api, token, spawnPipedProcess, options = {}) {
    this.api = api
    this.token = token
    this.spawnPipedProcess = spawnPipedProcess
    this.options = options
    this.jobs = new Set()
  }

  /** 建立 Job 并把子进程挂进去（进程树回收 / 资源上限） */
  createJob(options = {}) {
    const job = this.api.createJobObjectW(null, null)
    if (!job) throw win32Error(this.api, 'CreateJobObjectW', 'sandbox job creation')
    const config = {
      // 默认**不设**活跃进程上限：本 Job 要承载沙箱内的整棵进程树，
      // 设一个小上限会以 1816（Job 配额耗尽）让所有命令起不来（真实缺陷 14）。
      activeProcessLimit: options.activeProcessLimit ?? this.options.activeProcessLimit,
      processMemoryLimit: options.processMemoryLimit ?? this.options.processMemoryLimit,
      jobMemoryLimit: options.jobMemoryLimit ?? this.options.jobMemoryLimit,
      perProcessTimeLimitMs: options.perProcessTimeLimitMs,
    }
    const { buffer, flags } = buildExtendedLimitInformation(config)
    if (this.api.setInformationJobObject(job, JobObjectExtendedLimitInformation, buffer, buffer.length) === 0) {
      const code = this.api.getLastError()
      try {
        this.api.closeHandle(job)
      } catch {
        /* 清理失败不掩盖原错误 */
      }
      throw win32Error(this.api, 'SetInformationJobObject', `flags=0x${flags.toString(16)}`)
    }
    this.jobs.add(job)
    return { job, flags, config }
  }

  /**
   * 查询 Job 内活跃进程数（用于验证分配确实生效，而不是"看起来成功"）。
   *
   * 每个字段读取前都做边界断言：这个类曾经因为偏移写错 4 字节而越界抛
   * `ERR_OUT_OF_RANGE`，把"Job 不可用"变成假故障。宁可在这里大声失败，
   * 也不要静默读到错位的数字。
   */
  activeProcesses(job) {
    const buffer = Buffer.alloc(JOB_BASIC_ACCOUNTING_SIZE)
    if (
      this.api.queryInformationJobObject(job, JobObjectBasicAccountingInformation, buffer, buffer.length, null) === 0
    ) {
      throw win32Error(this.api, 'QueryInformationJobObject', `basic accounting (len=${buffer.length})`)
    }
    return parseBasicAccounting(buffer)
  }

  /**
   * 启动受限子进程：显式环境块 + 匿名管道 stdio + Job 归属。
   * 任一 Win32 失败都抛错并回收已分配资源（fail-closed）。
   *
   * 环境注入方式（重要）：`spawnPipedProcess` 内部的受限路径固定以
   * lpEnvironment = NULL 调用 CreateProcessAsUserW（即继承父环境，违反手册 #8.3）。
   * 由于绑定表是可写普通对象，这里在启动窗口内把 `createProcessAsUserW` 换成
   * 显式传入环境块的版本；窗口结束后立即还原，不做长期 monkey patch。
   */
  launch({ command, args = [], cwd, env, job }) {
    const environmentBlock = encodeEnvironmentBlock(env)
    const original = this.api.createProcessAsUserW
    if (typeof original !== 'function') {
      throw fail('SANDBOX_UNAVAILABLE', 'binding table has no createProcessAsUserW; cannot launch a confined child')
    }
    this.api.createProcessAsUserW = function patched(
      token,
      applicationName,
      commandLine,
      processAttributes,
      threadAttributes,
      inheritHandles,
      creationFlags,
      lpEnvironment,
      currentDirectory,
      startupInfo,
      processInfo,
    ) {
      // 只在调用方没有自带环境块时替换（保持对库内部其它调用的语义）
      const providesEnv = lpEnvironment === null || lpEnvironment === undefined
      const chosen = providesEnv ? environmentBlock : lpEnvironment
      // **必须**同时置 CREATE_UNICODE_ENVIRONMENT (0x00000400)。
      // 实测证据：库内部以 creationFlags=0 调用（CreateProcessAsUserW），
      // 再注入 UTF-16LE 环境块会得到 Win32 87 (ERROR_INVALID_PARAMETER) —— 子进程根本创建不出来。
      // 对照：win32-process 自己的 createProcessW 路径用的是 0x404
      // （CREATE_UNICODE_ENVIRONMENT 0x400 | CREATE_NO_WINDOW 0x08000000 的 0x4 位）。
      // SDK 亦规定：lpEnvironment 非 NULL 时需标记环境块为 Unicode。
      let flags = creationFlags
      if (providesEnv && chosen !== null && chosen !== undefined) {
        flags = (flags | CREATE_UNICODE_ENVIRONMENT) >>> 0
      }
      return original.call(
        this,
        token,
        applicationName,
        commandLine,
        processAttributes,
        threadAttributes,
        inheritHandles,
        flags,
        chosen,
        currentDirectory,
        startupInfo,
        processInfo,
      )
    }

    let child
    try {
      // 模块级函数签名：spawnPipedProcess(api, options)
      child = this.spawnPipedProcess(this.api, { token: this.token, command, args, cwd })
    } finally {
      this.api.createProcessAsUserW = original
    }

    // Job 归属：必须在子进程继续执行前完成，因此分配失败立即终止，绝不留下未纳管进程。
    // 已知竞态：spawnPipedProcess 创建后即 resume，子进程理论上可在挂 Job 前派生孙进程。
    // 该窗口极短且探针不派生；若要完全消除，需要在挂 Job 后才 ResumeThread（libuv 路径无法暂停）。
    if (job) {
      if (this.api.assignProcessToJobObject(job, child.process) === 0) {
        const code = this.api.getLastError()
        try {
          this.api.terminateProcess(child.process, 1)
        } catch {
          /* 已在终止路径上 */
        }
        throw win32Error(this.api, 'AssignProcessToJobObject', `pid=${child.pid}`, code)
      }
    }
    return child
  }

  terminateJob(job, exitCode = 1) {
    try {
      return this.api.terminateJobObject(job, exitCode)
    } catch {
      return 0
    }
  }

  dispose() {
    const failures = []
    for (const job of this.jobs) {
      try {
        this.api.closeHandle(job)
      } catch (error) {
        failures.push(error.message)
      }
    }
    this.jobs.clear()
    return failures
  }
}

/** 把 env 对象编码成 CreateProcess 需要的 UTF-16LE 双 NUL 结尾环境块（键名不区分大小写排序） */
export function encodeEnvironmentBlock(env) {
  const strings = Object.entries(env)
    .sort(([a], [b]) => (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
  return Buffer.from(`${strings.join('\u0000')}\u0000\u0000`, 'utf16le')
}

function win32Error(api, name, detail, code) {
  const win32Code = code ?? api.getLastError()
  let text = ''
  try {
    const buffer = Buffer.alloc(1024)
    const length = api.formatMessageW(0x1000, null, win32Code, 0, buffer, buffer.length / 2, null)
    if (length > 0) text = buffer.toString('utf16le', 0, (length - 1) * 2).trim()
  } catch {
    /* 文本不可得不影响错误码 */
  }
  const error = new Error(`${name} failed (${win32Code}${text ? `: ${text}` : ''})${detail ? ` — ${detail}` : ''}`)
  error.code = 'WIN32_FAILURE'
  error.win32Code = win32Code
  error.api = name
  return error
}

/**
 * 合成启动所需的**低层**绑定表。
 *
 * 契约（这里曾把两件事搞混，导致审计报"sandbox-init 拒绝建立"）：
 *   - `loadWin32ProcessBindings()` 返回的是**低层原语表**，内容是
 *     `createProcessAsUserW` / `createPipe` / `assignProcessToJobObject` / …
 *     它**从来不含** `spawnPipedProcess`。
 *   - `spawnPipedProcess(api, options)` 是 **模块级函数**，第一个参数就是那张低层表。
 * 因此 spawn 原语要单独从模块上取，不能指望出现在绑定表里。
 *
 * 合成规则：以低层表为**基底**，只把 ACL 后端私有表独有的安全扩展补进来
 * （`ConvertStringSidToSidW` / `LocalFree` / `SetNamedSecurityInfoW` 等），
 * 不覆盖基底已有实现。
 */
export function mergeBindingTables(lowLevel, captured) {
  const merged = { ...lowLevel }
  const added = []
  const skipped = []
  for (const [name, value] of Object.entries(captured ?? {})) {
    if (typeof merged[name] === 'function') {
      skipped.push(name)
      continue
    }
    merged[name] = value
    added.push(name)
  }
  return { merged, added, skipped }
}

/**
 * 从**已初始化的** AclSandbox 实例上取回它实际使用的绑定表与受限令牌。
 *
 * 为什么不猜字段名、也不包装 spawn()：实测该包的 init() **不会**调用 spawn()，
 * 因此"包装 spawn 捕获实参"的探针永远不会命中；而硬编码 `this.token`/`this.api`
 * 会在依赖升级/压缩后静默拿到 undefined（手册 #0.1 环境漂移类问题）。
 * 这里改为对实例自有属性做**结构化发现**：
 *   - 绑定表的唯一标识是它带 createProcessAsUserW（结构特征，可靠）
 *   - 令牌按字段名匹配（Koffi 句柄可能是 bigint/对象/字符串，不做类型假设；
 *     真正证明令牌有效的是随后 spawn 成功，而不是这里的类型判断）
 * 找不到就显式抛错，绝不退回"继承父环境"的 spawn。
 */
export function captureLaunchState(instance) {
  const entries = Object.entries(instance).map(([name, value]) => ({ name, value }))
  const api = entries.find(
    ({ value }) => value && typeof value === 'object' && typeof value.createProcessAsUserW === 'function',
  )
  // 令牌按字段名匹配；不假设其类型（真实 Koffi 句柄可能是 bigint / 对象 / 字符串）。
  // 真正的校验是"随后能带着它 spawn 成功"，而不是此处的类型判断。
  const token = entries.find(({ name, value }) => {
    if (value === null || value === undefined) return false
    return /token/i.test(name) && name !== 'tokenType'
  })
  if (!api || !token) return undefined
  return { api: api.value, token: token.value, fieldNames: { api: api.name, token: token.name } }
}

export async function initAclSandboxWithTokenCapture(AclSandbox, options) {
  const sandbox = new AclSandbox(options)
  await sandbox.init() // 任何 Win32 失败在此抛出（fail-closed）
  const captured = captureLaunchState(sandbox)
  if (!captured) {
    // 拿不到令牌就不能控制环境块与 Job 归属；此时**拒绝启动**，
    // 而不是退回继承父环境的 spawn（手册 #8.3 / #1.2）。
    try {
      sandbox.dispose()
    } catch {
      /* 清理失败不掩盖原因 */
    }
    throw new Error(
      'SANDBOX_UNAVAILABLE: could not discover the restricted token/binding table on an initialized AclSandbox. ' +
        'Refusing to fall back to an environment-inheriting spawn (manual §8.3).',
    )
  }
  return { sandbox, ...captured }
}

// ─────────────────────────── 执行器 ───────────────────────────

/**
 * 取子进程退出码，且**不饿死事件循环**（缺陷 D11 的修复核心）。
 *
 * ── 为什么不能直接用 `waitForProcessExit(api, process)` ─────────────────────
 * 该库函数的实现是 `WaitForSingleObject(process, INFINITE)` —— 一次**同步阻塞**
 * 的 FFI 调用（实测该包 lib/index.js:528）。在 Node 里这意味着：从进入该调用到
 * 子进程退出为止，**整个事件循环停摆**，所有定时器（包括 `run()` 的超时定时器）
 * 与微任务/宏任务都无法推进。而 `drainPipe` 是**异步轮询**实现
 * （`PeekNamedPipe` + `await setTimeout(1)`，同文件 :494-518）。
 * 两者一旦按"先 await 一次排水、再同步等退出"的顺序组合，就构成真实死锁（缺陷 D11）：
 *
 *   1. 父进程在 `drainPipe` 上 `await` 一次后让出执行权（管道里此时可能只有一小块）；
 *   2. 同步阻塞的 `waitForProcessExit` 抢到事件循环 → 定时器再也跑不起来；
 *   3. `drainPipe` 的轮询定时器永不触发 ⇒ 管道再也没人读；
 *   4. 匿名管道缓冲区写满后，子进程阻塞在 `WriteFile` 上，**永不退出**；
 *   5. 父进程在 `WaitForSingleObject(INFINITE)` 上永远等下去 ⇒ 一路挂到外层超时。
 *
 * 实测表征：300KB 输出的探针卡在 `BEGIN-WRITE`（**永远等不到 `AFTER-WRITE`**），
 * 小输出（约 1.6KB）则正常完成。即"输出量超过管道缓冲"才是触发条件。
 *
 * ── 修法 ─────────────────────────────────────────────────────────────────
 * 用**有界等待轮询**替代一次无限等待：每次只 `WaitForSingleObject(process, 50ms)`，
 * `WAIT_TIMEOUT(258)` 就 `await` 让出一次事件循环，于是 `drainPipe` 的轮询定时器
 * 能在两次等待之间持续把管道抽干，子进程得以写完并退出。
 * 子进程运行**期间**排水由此真正持续进行，而不是"等它退出后再读"。
 *
 * 语义不回退：退出码仍取自 `GetExitCodeProcess`；进程句柄仍由
 * `waitForProcessExit` 关闭（保留"退出码唯一来源"这一保证）。
 * `WAIT_FAILED` 等极端情形退回库的阻塞实现，保证"如实报错"而不是"空转"。
 *
 * 对照实现：`tests\executor-stub.mjs` 的"大输出不死锁"断言（`DSH_STUB_LEGACY_COLLECT=1`
 * 可复现修复前行为），以及 `.t\sbx3\fixA\` 下的真实 cli exec 复现与修复后对照。
 */
export const EXIT_WAIT_SLICE_MS = 50

export async function waitForExitWithoutStarvingEventLoop(api, process, waitForProcessExit) {
  let exitCode
  for (;;) {
    const waited = api.waitForSingleObject(process, EXIT_WAIT_SLICE_MS)
    if (waited === 0) {
      const slot = typeof api.allocUint32 === 'function' ? api.allocUint32() : undefined
      try {
        // 退出码的唯一来源仍与库一致：GetExitCodeProcess
        const readInto = slot ?? Buffer.alloc(4)
        if (api.getExitCodeProcess(process, readInto) === 0) break // 读不到 ⇒ 交给库的版本报错
        exitCode = slot !== undefined ? api.decodeUint32(slot) : readInto.readUInt32LE(0)
      } finally {
        if (slot !== undefined && typeof api.freeNative === 'function') api.freeNative(slot)
      }
      break
    }
    if (waited === 258) {
      // WAIT_TIMEOUT：让出事件循环，drainPipe 才有机会继续抽管道（这正是修复点）
      await new Promise((resolve) => setTimeout(resolve, 0))
      continue
    }
    break // WAIT_FAILED(0xFFFFFFFF) 或未知返回值：交给库的阻塞实现如实报错
  }
  // 拿到退出码 → 此时进程确已退出，库调用立即返回，只负责关闭进程句柄（不重复关句柄）。
  // 没拿到 → 由库调用阻塞等待并抛错，保持"出错要大声"的语义。
  if (exitCode !== undefined) {
    waitForProcessExit(api, process)
    return exitCode
  }
  return waitForProcessExit(api, process)
}

/**
 * 三轮接线：`WindowsStageExecutor.capabilities()` 用的**只读**维度快照。
 *
 * 与 `src/capability.mjs::capabilityDimensions()`（报告侧）同一口径，但**不接 WFP 绑定表**：
 * `capabilities()` 是"本机/本进程能做什么"的查询，不是安装路径；真正的"能不能装上"
 * 由 `init()` → `prepareNetworkPolicy()` 用调用方给的绑定表判定。
 * 任何一步抛错都降级成显式 `state:'unknown'`，绝不把异常抛进一个查询函数。
 */
function capabilityDimensionSnapshot(options = {}) {
  const networkTier = options.networkTier ?? 'OBSERVED_ONLINE'
  const mitigationProfile = options.mitigationProfile ?? 'none'
  let networkPolicy
  try {
    networkPolicy = summariseNetworkPolicy(resolveNetworkPolicy({ requested: networkTier }))
  } catch (error) {
    networkPolicy = { tier: networkTier, state: 'unknown', enforced: false, verified: false, reason: `网络策略判定抛错：${error.code ?? ''} ${error.message}`.trim() }
  }
  let mitigations
  try {
    mitigations = summariseMitigations(buildMitigationPolicy({ profile: mitigationProfile }))
  } catch (error) {
    mitigations = { profile: mitigationProfile, flags: null, names: [], attribute: null, size: null, noop: null, state: 'unknown', reason: `缓解策略构造失败：${error.code ?? ''} ${error.message}`.trim() }
  }
  let limits
  try {
    limits = summariseLimits(wrapLimits(options.limits))
  } catch (error) {
    limits = { stagingBytes: null, stagingGiB: null, maxOutputBytes: null, maxOutputLines: null, source: 'unknown', stagingSource: null, outputSource: null, state: 'unknown', reason: `资源上限解析失败：${error.code ?? ''} ${error.message}`.trim() }
  }
  return { networkPolicy, mitigations, limits }
}

export class WindowsStageExecutor {
  constructor(options = {}) {
    this.options = options
    /**
     * ── Phase 2 / WP1：暂存根的**来源**在这里定死，且默认**不再是工作区暂存树** ──────
     * 唯一解析点是 `stageGrantTarget()`：
     *   · `options.stagingRoot` 给出 ⇒ 逐字采用（**显式 override 通道**：离线测试、
     *     单实例自检、`dsh-plugin` / `cli.mjs` 的注入缝）——行为与接线前逐字一致；
     *   · 否则 ⇒ WP0 的 `resolveStageRoot({sessionKey, workspaceRoot, env})`，
     *     即缓存根 `%LOCALAPPDATA%\Temp\winstage-stage\<会话键>`。
     * WP1 之后**没有任何一条默认路径**会把暂存根落在工作区里的 `.dshstage` 上。
     * 老的工作区暂存树只可能通过**显式 override** 进来（那是调用方的显式声明，
     * 不是默认值）；读取侧对历史布局的识别不在本车道范围内。
     *
     * 未定键（既没 override，也没有会话键/工作区根）时 `stagingRoot` 仍是 `undefined`
     * ⇒ `init()` 照旧抛 `SANDBOX_UNAVAILABLE`，与接线前**逐字一致**（见 `keyed` 注释）。
     */
    this.stageGrantPlan = stageGrantTarget({
      stagingRoot: options.stagingRoot,
      sessionKey: options.sessionKey ?? options.sessionId,
      workspaceRoot: options.workspaceRoot,
      env: options.env,
    })
    this.stagingRoot = options.stagingRoot
      ? canonicalDir(options.stagingRoot)
      : this.stageGrantPlan.keyed
        ? this.stageGrantPlan.root
        : undefined
    /** 暂存根的实际来源（机读）：`'explicit-override'` | `'resolve-stage-root'` | `'unresolved'` */
    this.stagingRootSource = this.stagingRoot === undefined ? 'unresolved' : this.stageGrantPlan.source
    /** 授权结果（`init()` 填充；`assertStagingWriteEnforceable()` 把它当**不可覆盖**的闸门读） */
    this.stageGrant = undefined
    this.mirrorRoot = options.mirrorRoot ? canonicalDir(options.mirrorRoot) : undefined
    this.mode = options.mode || 'workspace-write'
    this.tier = options.tier || 'T1'
    this.sandbox = undefined
    this.launcher = undefined
    this.api = undefined
    this.token = undefined
    this.tempDir = undefined
    this.initReport = undefined
    this.job = undefined
    // ── BUG-3 / BUG-4：可查询的诊断状态（绝不只活在一条日志里）────────────────────
    // `stagingRootAudit`：暂存根的生命周期事件（失根 / 漂移 / 档位漂移）；
    // `stagingWriteGate`：闸门最近一次判定的**逐条命令**决定（含"只读已豁免"）。
    this.stagingRootAudit = {
      configuredAtConstruction: this.stagingRoot,
      configuredWasSet: Boolean(this.stagingRoot),
      envAtConstruction: readStageRootEnv(),
      events: [],
      rootLost: false,
      rootLostCount: 0,
      tierDrift: false,
    }
    this.stagingWriteGate = {
      trips: [],
      lastDecision: undefined,
      latchClearedBy: undefined,
    }
    /** T0 专用（只有显式 tier=T0 且装配成功时才非空；见 init()） */
    this.appContainer = undefined
    this.appContainerInfo = undefined
    /**
     * 生效的运行模式（`docs/T1-启动器修复报告.md` 的判据）：
     *   'restricted-token' —— WRITE_RESTRICTED 受限令牌 + Low IL（T1 档）
     *   'shim'             —— 去令牌化：普通令牌 + 正常完整性，强制/暂存交给 shim
     *   'appcontainer'     —— AppContainer（T0 档）
     * **绝不**存在"既没受限令牌、又没经过 shim"的第四种。
     */
    this.launchMode = undefined
    /** 请求的档位（原样保留，便于区分"请求 TS、实际回退 T1"） */
    this.tierRequested = undefined
    /** 实际生效的档位 */
    this.tierEffective = undefined
    /** 因真实可用性探测失败而回退时的原因（诚实字段，不能吞） */
    this.fallbackReason = undefined
    /** 去令牌化可用性探测的完整结果（含逐级 checks） */
    this.transparent = undefined
    this.shimLauncher = undefined
    /**
     * ── 三轮接线：三个新维度（全部保持接线前的默认语义）──────────────────────────
     *   · `networkTier`        默认 `'OBSERVED_ONLINE'`：`resolveNetworkPolicy()` 对非 OFFLINE
     *     档位连绑定表都不碰 ⇒ 不安装、不阻断、不上报任何强制。
     *     只有显式 `'OFFLINE'` 才会走"判定 → 安装 → 回读 → 拒绝/放行"那条路。
     *   · `mitigationProfile`  默认 `'none'`：**刻意不用** `mitigations.mjs` 的
     *     `DEFAULT_MITIGATION_PROFILE='baseline'`（那是那个模块自己的保守默认），
     *     因为本执行器的默认必须与接线前逐字一致；`baseline`/`hardened`/`untrusted` 是 opt-in。
     *   · `limits`             默认 `DEFAULT_LIMITS`（暂存 64 GiB / 输出 4 MiB / 200000 行）。
     * 注入缝（离线确定性测试用；生产不传即走真实实现）：
     *   `networkBindings` / `networkProbe` / `networkGuids` / `networkPin` / `networkRetainPointer`
     *   / `measureStaging` / `stagingQuotaBytes`。
     */
    this.networkTier = options.networkTier ?? 'OBSERVED_ONLINE'
    this.mitigationProfileRequested = options.mitigationProfile ?? 'none'
    this.mitigationPolicyBuilt = buildMitigationPolicy({ profile: this.mitigationProfileRequested })
    this.limits =
      options.limits && options.limits.staging && options.limits.output && Object.isFrozen(options.limits)
        ? options.limits
        : wrapLimits(options.limits)
    /** 网络策略解析结果与摘要（`prepareNetworkPolicy()` 填充；`undefined` = 还没准备） */
    this.networkPolicyResult = undefined
    this.networkPolicy = undefined
    this.networkPolicyPrepared = false
    /** 安装证据 / 回读证据 / 拆除句柄（只有 OFFLINE 且真的装上时才有） */
    this.networkInstallEvidence = undefined
    this.networkInstallAudit = undefined
    this.networkTeardown = undefined
    this.networkTeardownResult = undefined
    // 构造那一刻就采一次样：后面的采样才有"曾经有值 / 曾经存在"可比对，
    // 否则"有值 → 空"这种失根会被读成"从来就没设过"。
    this.noteStagingRootSampling('construction')
  }

  /**
   * ── 缺陷③（Fix A 的核心）：`init()` 自检结果的二次判定 ─────────────────────────
   *
   * 为什么需要它：自检**已经**测出了"暂存根写不进去"，但 `enforcement` 只被放进
   * `sandboxInit` 报告里，`exec` 照常跑命令并返回 0（审计 `raw/70-t0-json.txt`、
   * `raw/81-a3`：`inside-staging-write-allowed=fail` + `enforcement=degraded` + 退出码 0）。
   * 于是"工作区外写入被捕获进暂存"的招牌保证在该工作区**静默失效**。
   *
   * 判定只看**实测观测**（`checks` / `observed`），不看"档位声明"：
   *   - 实测缺项 ⇒ `verdict='unmeasured'`（**不是 pass**；测不出来就不许说测过了）
   *   - 任一判据 `fail` ⇒ `verdict='fail'` + 把触发项列进 `failedChecks`
   *
   * 静态方法（纯函数）以便离线套件直接喂合成报告：`WindowsStageExecutor.stagingWriteEnforceability(...)`。
   *
   * @param {object} report 形如 `{checks: [{name,status,detail}], enforcement, observed}`
   * @param {object} [options] `{lane: 'sandbox'|'shim'}`
   * @returns {{verdict:'pass'|'fail'|'unmeasured', lane:string, enforcement:string|undefined,
   *            failedChecks:Array, measuredChecks:Array, missingChecks:string[], reason:string}}
   */
  static stagingWriteEnforceability(report, options = {}) {
    const lane = options.lane ?? 'sandbox'
    const checks = Array.isArray(report?.checks) ? report.checks : []
    const measuredNames = lane === 'shim' ? SHIM_STAGING_WRITE_CHECKS : SANDBOX_STAGING_WRITE_CHECKS
    const relevant = checks.filter((c) => isStagingWriteCheckName(c?.name))
    const measuredChecks = relevant.map((c) => ({ name: c.name, status: c.status, detail: c.detail }))
    const failedChecks = measuredChecks.filter((c) => c.status !== 'pass' && c.status !== 'documented-residual')
    const missingChecks = []
    if (!report || typeof report !== 'object') missingChecks.push('(no self-test report was produced)')
    else if (measuredChecks.length === 0) missingChecks.push('(no staging-write check was executed)')
    for (const name of measuredNames) {
      if (!measuredChecks.some((c) => c.name === name)) missingChecks.push(name)
    }
    const base = { lane, enforcement: report?.enforcement, failedChecks, measuredChecks, missingChecks }
    if (failedChecks.length > 0) {
      return {
        ...base,
        verdict: 'fail',
        reason:
          `${failedChecks.length} staging-write check(s) failed: ` +
          failedChecks.map((c) => `${c.name}=${c.status} (${String(c.detail ?? '').slice(0, 120)})`).join('; '),
      }
    }
    if (missingChecks.length > 0) {
      return { ...base, verdict: 'unmeasured', reason: `staging-write enforcement was not fully measured: missing ${missingChecks.join(', ')}` }
    }
    return { ...base, verdict: 'pass', reason: 'every staging-write check passed under the identity this run uses' }
  }

  /**
   * 实例侧入口：读取自身自检结果算判定（不触系统状态）。
   * 自检还没跑过时返回 `unmeasured` —— 绝不默认放行。
   */
  stagingWriteEnforceability(options = {}) {
    return WindowsStageExecutor.stagingWriteEnforceability(this.initReport, {
      lane: options.lane ?? (this.launchMode === 'shim' ? 'shim' : 'sandbox'),
    })
  }

  /**
   * ── Fix A：运行前闸门（**BUG-4 修复后：单命令级，绝不闩锁整段会话**）─────────────
   *
   * 修复前：`initReport` 的自检探针只要**瞬时**失败一次（`0xC0000005` / `0xE0434352` /
   * exit 127 / >25s 挂死四种形态实测都出现过），整段会话里**每一条**命令都被同一门文本
   * 拒绝 —— 连 `Write-Output "x"` 都拒，持续数分钟且没有解除提示。
   *
   * 修复后，判定只回答"**这一条**命令的问题"：
   *   · **授权未建立**（Phase 2 / WP1，`this.stageGrant.granted !== true` 且本档确实靠
   *     ACL 写授权）⇒ 拒绝，码 `STAGE_GRANT_FAILED`。这条**优先于下面三条**、也不吃
   *     只读豁免：它是本次运行身份的**结构事实**（与 ① 的失根同级），不是一次测量，
   *     因此调用方注入的 `stagingWriteCheck` 替身**不能**把它改写成放行。
   *   · `read-only`      ⇒ **不拦**（只读命令没有可被静默降级的写入面）。判定写进
   *                        `this.stagingWriteGate`，下游可机检"这次豁免是因为只读"。
   *   · `write-capable`  ⇒ 拒绝，码 `STAGING_WRITE_UNVERIFIED`，并带**可重试**文案
   *                        （`retryable:true` + `retryHint`：本次命令未执行、文件未变）。
   *   · `indeterminate`  ⇒ 也拒绝（fail-closed 不变），码
   *                        `STAGING_WRITE_UNVERIFIED_INDETERMINATE`，**逐条说明为什么判不出来**。
   *
   * 仍然**绝不**在 `enforcement` 降级时让一条**可能写**的命令照常跑并返回 0。
   * 拒绝时抛**带 code 的**结构化错误，由 CLI 走它既有的人读通道
   * （`src/cli.mjs:196-198` 的 `fail()` → stderr）呈现；**本函数不写 stdout/stderr**，
   * 模型可见输出（命令自己的输出）因此一个字节都不被污染（与
   * `dsh-plugin/shell-executor.mjs:1320-1335` 的"模型可见输出 vs 人工通道"同一纪律）。
   */
  assertStagingWriteEnforceable(context = {}) {
    const override = this.options.stagingWriteCheck
    const report = typeof override?.evaluate === 'function' ? override.evaluate(this) : this.stagingWriteEnforceability()
    this.stagingWriteCheckReport = report
    const risk = this.commandRisk(context)
    const decisionBase = {
      at: Date.now(),
      command: typeof context.command === 'string' ? context.command : undefined,
      risk: risk.risk,
      riskReasons: risk.reasons,
      verdict: report.verdict,
      lane: report.lane,
    }
    // ── ① 失根优先于"暂存不可信"：两者必须给出**不同**的结论 ────────────────────
    const rootState = this.assertStagingRootPresent('staging-write-gate')
    // ── ①b Phase 2 / WP1：**授权门**（不可被 `stagingWriteCheck` 覆盖）──────────────
    // "授权成功后才允许派发命令"在这里落地：`init()` 已经把"根被授权给本次运行的身份"
    // 记进 `this.stageGrant`（`granted` + `enforcement`）。它不是一次**测量**，而是本次
    // 运行身份的**结构性事实**，因此与 ① 的失根判定同级、排在 `report.verdict === 'pass'`
    // **之前**：调用方注入的 `stagingWriteCheck` 替身**不能**把"没授权上"改写成放行。
    // 同理它也不吃 ② 的只读豁免 —— 那条例外是为**瞬时测量失败**（BUG-4：探针偶发
    // 0xC0000005/超时不该闩锁整段会话）设计的，而这里是一个确定的结构事实。
    const grantRecord = this.stageGrant
    if (grantRecord && grantRecord.writable === true && grantRecord.enforcement === 'acl-write-sid' && grantRecord.granted !== true) {
      const grantError = stageGrantError(STAGE_GRANT_REASONS.ACE_NOT_VERIFIED, {
        root: grantRecord.root,
        writeSid: grantRecord.writeSid,
        detail: 'the write authorisation for this run was never established (granted !== true)',
        steps: grantRecord.steps,
      })
      grantError.refusedCommand = decisionBase.command
      grantError.commandRisk = risk.risk
      grantError.retryable = true
      grantError.retryHint = '内部暂存授权未建立，本次命令未执行（not executed）、文件未变（files unchanged）'
      this.stagingWriteGate.trips.push({ ...decisionBase, action: 'refused', code: STAGE_GRANT_FAILED })
      this.stagingWriteGate.lastDecision = { ...decisionBase, action: 'refused', code: STAGE_GRANT_FAILED }
      throw grantError
    }
    if (report.verdict === 'pass') {
      decisionBase.action = 'allowed'
      this.stagingWriteGate.lastDecision = decisionBase
      return { allowed: true, ...report, risk }
    }
    // ── ② 只读/无副作用 ⇒ 这类门**不该**拦它 ───────────────────────────────────
    if (risk.risk === COMMAND_RISK.READ_ONLY) {
      decisionBase.action = 'allowed-read-only-bypass'
      decisionBase.bypassReason =
        '本条命令被正向判定为只读/无副作用：暂存根此刻是否可写不影响它的结果，' +
        '因此闸门只记录、不拒绝（BUG-4：拒绝面只覆盖有风险的那一条命令）'
      this.stagingWriteGate.lastDecision = decisionBase
      this.stagingWriteGate.trips.push(decisionBase)
      this.stagingWriteGate.latchClearedBy = 'read-only-command'
      return { allowed: true, bypassed: 'read-only', ...report, risk, decision: decisionBase }
    }
    const indeterminate = risk.risk === COMMAND_RISK.INDETERMINATE
    const code = indeterminate ? 'STAGING_WRITE_UNVERIFIED_INDETERMINATE' : 'STAGING_WRITE_UNVERIFIED'
    const riskLine = indeterminate
      ? `本条命令**无法判定**（cannot determine）是否会产生副作用，因此 fail-closed 拒绝（而不是把"不知道"说成"策略拒绝"）。判不出来的原因：${risk.reasons.join('；')}。`
      : `本条命令被判定为**可能写入**，因此拒绝。理由：${risk.reasons.join('；')}。`
    const error = fail(
      code,
      `refusing to run THIS command: the staged root is not verified writable by the identity this run uses ` +
        `(${report.verdict === 'unmeasured' ? 'measurement unavailable/incomplete' : 'measured as not writable'}). ` +
        `reason: ${report.reason}. ` +
        `${riskLine} ` +
        `If the command ran, writes outside the workspace would NOT be captured into staging while the caller still sees ` +
        `exit code 0 — that is the silent-degradation shape this gate exists to prevent. ` +
        `这次拒绝**只作用于这一条命令**：本次命令未执行、文件未变，请修复后重试；同一会话里的只读命令不会被本闸门拦下。`,
    )
    error.report = report
    error.risk = risk
    // ── 可重试文案：明确"命令未执行、文件未变"，并给出稳定错误码 ─────────────────
    error.retryable = true
    error.retryHint =
      '内部暂存校验未通过（internal staging error），本次命令未执行（not executed）、文件未变（files unchanged），请重试（please retry）；' +
      '重试前可先跑只读命令确认环境。'
    error.policyDenial = false
    error.remediation = [
      'retry the same command — this refusal is scoped to that one command and never latches the session (BUG-4)',
      'run `dsh-stage init --workspace <dir>` — it now detects and removes the stale AppContainer package-SID ACE a previous `--tier T0` run left on the staged root',
      'if the ACE is still present, inspect it with: icacls <staged>  (look for an explicit `S-1-15-2-*:(OI)(CI)(M)` entry)',
      'if the message says unmeasured, the in-sandbox self-test could not run at all (missing PowerShell / restricted token / ACL backend) — fix that first; the gate deliberately does not guess',
      'if a read-only command was refused as indeterminate, re-issue it with a plain read-only verb (Get-*/Test-*/Write-Output) or pass `commandRisk` — the gate explains exactly which token it could not judge',
    ]
    error.humanChannel = {
      code,
      verdict: report.verdict,
      lane: report.lane,
      enforcement: report.enforcement,
      failedChecks: report.failedChecks,
      missingChecks: report.missingChecks,
      reason: report.reason,
      commandRisk: risk.risk,
      commandRiskReasons: risk.reasons,
      retryable: true,
      retryHint: error.retryHint,
      remediation: error.remediation,
    }
    this.stagingWriteGate.trips.push({ ...decisionBase, action: 'refused', code })
    this.stagingWriteGate.lastDecision = { ...decisionBase, action: 'refused', code }
    throw error
  }

  /**
   * 判定"这一条命令"的风险（可被 `options.commandRisk` 显式覆盖 —— 与
   * `stagingWriteCheck` 同一约定：依赖注入缝必须显式声明，不改变生产默认行为）。
   */
  commandRisk(context = {}) {
    const override = this.options.commandRisk
    if (typeof override === 'function') return override(context.command, context.args ?? [], context)
    if (override && typeof override === 'object' && typeof override.risk === 'string') return override
    return classifyCommandRisk(context.command, context.args ?? [], context)
  }

  /**
   * ── BUG-3：失根的**采样 + 判定 + 可查询状态** ─────────────────────────────────
   *
   * 每次 `init()` / `run()` 进来都采一次样，检测三件事：
   *   ① `this.stagingRoot` 从"有值"变成"空"（失根）；
   *   ② 暂存根此前存在、现在不存在（失联）；
   *   ③ 环境契约 `WINSTAGE_STAGE_ROOT` 变成空值（现场 ENV-01 的形态）。
   * 任一命中 ⇒ 抛**独立错误码**（`STAGING_ROOT_*`，`policyDenial:false`），
   * 并把事件记进 `this.stagingRootAudit`，由 `stagingRootDiagnostics()` 查询。
   */
  noteStagingRootSampling(where) {
    const audit = this.stagingRootAudit
    const env = readStageRootEnv()
    const configured = this.stagingRoot
    const configuredWasSet = Boolean(configured)
    let exists = false
    let isDirectory = false
    try {
      const stat = configured ? statSync(configured) : undefined
      exists = Boolean(stat)
      isDirectory = Boolean(stat?.isDirectory?.())
    } catch {
      exists = false
    }
    const previous = audit.events.length > 0 ? audit.events[audit.events.length - 1] : undefined
    const previouslyExisted = previous ? previous.exists === true : false
    const sample = {
      at: Date.now(),
      where,
      configured,
      configuredWasSet,
      envStageRoot: env.present ? env.value : undefined,
      envPresent: env.present,
      exists,
      isDirectory,
      previouslyExisted,
    }
    // ① 失根：有值 → 空（判据取"构造时或此前的任一次采样曾经有值"）
    const wasEverSet = audit.configuredWasSet || audit.events.some((e) => e.configuredWasSet)
    if (wasEverSet && !configuredWasSet) {
      audit.events.push({ ...sample, kind: 'root-lost', severity: 'critical' })
      audit.rootLost = true
      audit.rootLostCount += 1
    } else if (previous?.envPresent === true && env.present === true && String(previous.envStageRoot ?? '').length > 0 && String(env.value ?? '').trim() === '') {
      // ③ 环境契约变空：与"实例字段还在"并存时同样按失根记录（shim 子进程拿不到暂存根）
      audit.events.push({ ...sample, kind: 'env-stage-root-blanked', severity: 'critical' })
      audit.rootLost = true
      audit.rootLostCount += 1
    } else if (previouslyExisted && !exists) {
      audit.events.push({ ...sample, kind: 'root-vanished', severity: 'critical' })
      audit.rootLost = true
      audit.rootLostCount += 1
    } else {
      audit.events.push({ ...sample, kind: 'sample' })
    }
    // ── 档位漂移（BUG-3 的"会话漂移"）：请求档位 ≠ 生效档位 ⇒ 记录一次 ──────────
    if (this.tierRequested !== undefined && this.tierEffective !== undefined && this.tierRequested !== this.tierEffective) {
      if (!audit.tierDrift) {
        audit.tierDrift = true
        audit.events.push({
          at: Date.now(),
          where,
          kind: 'tier-drift',
          severity: 'warning',
          tierRequested: this.tierRequested,
          tierEffective: this.tierEffective,
          fallbackReason: this.fallbackReason,
        })
      }
    }
    // 事件表有界（防长会话无界增长）
    if (audit.events.length > 200) audit.events.splice(0, audit.events.length - 200)
    return sample
  }

  /**
   * 失根判定（采样 → 纯函数判定）。失根时抛**独立错误码**，
   * 结论里明确写"这不是策略拒绝"。
   */
  assertStagingRootPresent(where = 'preflight') {
    const audit = this.stagingRootAudit
    const sample = this.noteStagingRootSampling(where)
    const env = readStageRootEnv()
    const configured = this.stagingRoot
    let exists = sample.exists
    let isDirectory = sample.isDirectory
    // 没记录过"曾经存在"且当前不存在 ⇒ 不直接判失根（可能是新建工作区），
    // 与既有行为一致地**先建出来**；建不出来才是故障。
    if (configured && !exists && !sample.previouslyExisted && configured === audit.configuredAtConstruction) {
      try {
        mkdirSync(configured, { recursive: true })
        const stat = statSync(configured)
        exists = true
        isDirectory = Boolean(stat.isDirectory?.())
      } catch (error) {
        throw this.rootLossError(
          {
            status: 'lost',
            code: STAGING_ROOT_CODES.ABSENT,
            category: 'root-loss',
            policyDenial: false,
            distinctFromPolicyDenial: true,
            retryable: true,
            summary: `暂存根 ${configured} 不存在且无法创建：${error.message} —— 这是**沙箱自身故障**，不是策略拒绝。`,
            action: '检查路径权限/磁盘后重新 `dsh-stage init --workspace <dir>`。',
            evidence: { configured, where },
          },
          where,
        )
      }
    }
    const state = classifyStagingRootState({
      where,
      configured,
      configuredWasSet: audit.configuredWasSet || Boolean(configured),
      envStageRoot: env.present ? env.value : undefined,
      envWasSet: env.present,
      previouslyExisted: sample.previouslyExisted,
      exists,
      isDirectory,
    })
    this.stagingRootState = state
    if (state.status === 'ok') return state
    throw this.rootLossError(state, where)
  }

  /** 把"失根"结论做成结构化错误（**与策略拒绝可区分**：独立码 + 一句话 + 建议动作） */
  rootLossError(state, where) {
    const error = fail(state.code, `[${state.category}] ${state.summary} 建议动作：${state.action}`)
    error.category = state.category
    // 关键：机检字段 —— 失根**不是**策略拒绝
    error.policyDenial = false
    error.distinctFromPolicyDenial = true
    error.retryable = state.retryable === true
    error.retryHint = '这是失根（暂存根失联），不是权限不足：请先重建暂存根再重跑，不要反复重试同一条命令。'
    error.summary = state.summary
    error.action = state.action
    error.where = where
    error.evidence = state.evidence
    error.remediation = [state.action, '查询可诊断状态：`stagingRootDiagnostics()`（含本次会话是否曾失根 / 档位漂移）']
    error.humanChannel = {
      code: state.code,
      category: state.category,
      policyDenial: false,
      summary: state.summary,
      action: state.action,
      where,
      remediation: error.remediation,
    }
    return error
  }

  /**
   * ── BUG-3：可查询的失根 / 漂移状态 ───────────────────────────────────────────
   *
   * "是否曾发生失根 / 档位漂移"必须能被查询，而不是只活在一条误导性报错里。
   */
  stagingRootDiagnostics() {
    const audit = this.stagingRootAudit
    const critical = audit.events.filter((e) => e.severity === 'critical')
    return {
      code: audit.rootLost ? (critical[critical.length - 1]?.kind ?? 'root-lost') : STAGING_ROOT_CODES.OK,
      rootLost: audit.rootLost,
      rootLostCount: audit.rootLostCount,
      rootLostEvents: critical.map((e) => ({ at: e.at, where: e.where, kind: e.kind, configured: e.configured, envStageRoot: e.envStageRoot, exists: e.exists })),
      tierDrift: audit.tierDrift,
      tierRequested: this.tierRequested,
      tierEffective: this.tierEffective,
      configured: this.stagingRoot,
      configuredWasSet: audit.configuredWasSet,
      envStageRoot: readStageRootEnv().value,
      // ── Phase 2 / WP1：根**从哪来**（`explicit-override` / `resolve-stage-root`）────
      // 与"授权上了没有"。失根（本函数的主判据）与"没授权上"是两件事，必须分开查。
      rootSource: this.stagingRootSource,
      grant: this.stageGrant,
      currentState: this.stagingRootState?.code ?? undefined,
      summary: audit.rootLost
        ? `本次会话曾发生**失根**（${audit.rootLostCount} 次，最近一次：${critical[critical.length - 1]?.kind}）—— ` +
          '这不是策略拒绝；此前已暂存的工作可能已随旧会话消失。'
        : audit.tierDrift
          ? `未失根，但发生**档位漂移**（请求 ${this.tierRequested} → 生效 ${this.tierEffective}）。`
          : '未失根、未发生档位漂移。',
      events: audit.events.slice(-50),
    }
  }

  /**
   * 能力与依赖解析。
   *
   * 可通过 `options.overrides` 注入替身，用于**不依赖 Win32 的确定性测试**：
   *   { AclSandbox, processBindings, spawnPipedProcess, workspaceWriteSid, tempWriteSid,
   *     assertPrivateTempDisjoint }
   * 这是正常的依赖注入缝，不改变生产路径行为（不注入时完全走真实加载）。
   */
  static capabilities(overrides = {}) {
    const modules = loadWindowsSandboxModules()
    const acl = modules[ACL_PACKAGE]
    const win32 = modules[WIN32_PACKAGE]
    const aclModule = acl?.module
    const win32Module = win32?.module
    const resolved = {
      aclAvailable: typeof aclModule?.AclSandbox === 'function',
      aclError: acl?.error?.message,
      aclFrom: acl?.from,
      aclVersion: safeVersion(acl?.from, ACL_PACKAGE),
      win32Available: typeof win32Module?.spawnPipedProcess === 'function',
      win32Error: win32?.error?.message,
      win32From: win32?.from,
      win32Version: safeVersion(win32?.from, WIN32_PACKAGE),
      resolutionRoots: modules.__roots,
      AclSandbox: aclModule?.AclSandbox,
      // 低层原语表（不含 spawnPipedProcess —— 那是模块级函数，单独取）
      processBindings: win32Module && typeof win32Module.loadWin32ProcessBindings === 'function'
        ? safeLoadProcessBindings(win32Module)
        : undefined,
      // 模块级 spawn 函数：spawnPipedProcess(api, options)
      spawnPipedProcess: win32Module?.spawnPipedProcess,
      // 收集子进程结果所需的库函数（drainPipe / waitForProcessExit）
      processLibrary: win32Module
        ? { drainPipe: win32Module.drainPipe, waitForProcessExit: win32Module.waitForProcessExit }
        : undefined,
      workspaceWriteSid: aclModule?.workspaceWriteSid,
      tempWriteSid: aclModule?.tempWriteSid,
      assertPrivateTempDisjoint: aclModule?.assertPrivateTempDisjoint,
      // ── 去令牌化（透明 shim）耦合点 ───────────────────────────────────────────
      // 与 AclSandbox / spawnPipedProcess 一样，这是**显式依赖注入缝**：
      // 离线测试可以注入"shim 可用 / 不可用"的替身，从而确定性覆盖模式判定与
      // fail-closed 回退，而不改变生产路径行为（不注入时走真实探测）。
      probeTransparentShim,
      resolveShimArtifacts,
      // 去令牌化启动的**进程级**原语（文件描述符重定向，绝不用管道）。
      // 同样可被替身覆盖：离线测试要能断言"启动确实走了注入器、环境里没有 DSH_SANDBOX*"。
      spawnTransparentProcess: spawnCapturedAsync,
    }
    // 替身覆盖：仅覆盖显式提供的键，避免把未提供的项变成 undefined
    const merged = { ...resolved }
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) merged[key] = value
    }
    if (overrides.AclSandbox) merged.aclAvailable = true
    if (overrides.spawnPipedProcess) merged.win32Available = true
    // 显式模拟：用于测试"后端缺失/不可用"等无法在真实环境稳定复现的分支。
    // 必须显式声明，避免把"未提供"误当成"故意置空"（手册 #16.4 空表语义冲突）。
    if (overrides.simulate) {
      for (const [key, value] of Object.entries(overrides.simulate)) merged[key] = value
    }
    // ── 三轮接线：三个维度的**只读**摘要 ─────────────────────────────────────────
    // 刻意不在这里带 WFP 绑定表：`capabilities()` 回答的是"本机能做什么"，不是安装路径。
    // 因此 `OFFLINE` 会如实报 `refused`（缺绑定表），真正能不能装由
    // `init()` → `prepareNetworkPolicy()` 用调用方给的绑定表判定。
    // 任何异常都降级成显式 unknown（一个能力查询不该因为配置写错就把调用方抛崩）。
    merged.capabilityDimensions = capabilityDimensionSnapshot(overrides)
    return merged
  }

  /**
   * 去令牌化（透明 shim）初始化：**不建受限令牌**，只装配注入器与暂存根。
   *
   * 与受限令牌路径的差别（必须如实记录）：
   *   - 不调用 `AclSandbox.init()` ⇒ 没有 `CreateRestrictedToken`、没有 Low IL 标签；
   *   - 不建 Job Object ⇒ `terminate()` 用 `taskkill /T /F` 回收注入器进程树；
   *   - 强制 + 暂存由 shim 的用户态 IAT 钩子承担（T4 的语义，见探测器 checks）。
   */
  async initTransparent(cap) {
    const started = Date.now()
    const lowLevel = cap.processBindings
    if (!lowLevel || typeof lowLevel.createJobObjectW !== 'function') {
      throw fail(
        'SANDBOX_UNAVAILABLE',
        'loadWin32ProcessBindings() did not return the Win32 process primitive table; the transparent mode refuses to start without it',
      )
    }
    const writable = this.mode === 'workspace-write'
    const tempDir = this.options.tempDir || defaultPrivateTemp()
    mkdirSync(tempDir, { recursive: true })
    if (writable && typeof cap.assertPrivateTempDisjoint === 'function') {
      cap.assertPrivateTempDisjoint([this.stagingRoot], tempDir)
    }
    this.api = { ...lowLevel }
    this.tempDir = writable ? tempDir : undefined

    /* ★ WP13 §4 修复：日志路径**必须**由本 launcher 自己的 `stagingRoot` 推导，
     * 不能沿用 `this.transparent?.logPath` —— 后者是**上一次**（可能另一本 stageRoot /
     * 另一个会话）留下的值。实测后果：探针按自己写的 config/env 去查
     * `<probe stageRoot>\shim.log`，而 shim 按这里的 env 写到别处 ⇒ `shim-log-observed`
     * 恒 BAD ⇒ 由于 `available = checks.every(ok)`，**整条档位回落**（本会话死档的机制）。 */
    const logPath = join(this.stagingRoot, 'shim.log')
    const { configPath, config } = writeShimConfig({
      stageRoot: this.stagingRoot,
      logPath,
      extraPassthrough: this.options.shimPassthrough ?? [],
    })
    /* ★ Method A（主线）：结构化操作审计。shim 把**整条进程树**的每一次被 hook 的
     * 文件/注册表操作写成一个 JSONL（`WINSTAGE_AUDIT_LOG`），供宿主侧聚合/分类/呈现。
     * 路径**必须落在暂存树之外**：`shim.log`/`overlay.hive*` 已经教会我们，暂存层自己的
     * 状态文件若在 `<stagingRoot>` 内会被 `captureAfterExecution` 当成用户改动摄取
     * （自指条目）。因此优先放会话存储根（与 manifest/queue 同处），否则放与暂存根
     * **互斥**的私有 temp。`options.audit === false` 可显式关闭（性能）。 */
    const auditPath = typeof this.options.auditLogPath === 'string' && this.options.auditLogPath.length > 0
      ? this.options.auditLogPath
      : join(
          typeof this.options.registryStageDir === 'string' && this.options.registryStageDir.length > 0
            ? this.options.registryStageDir
            : tempDir,
          'audit.jsonl',
        )
    this.auditPath = this.options.audit === false ? undefined : auditPath
    this.shimLauncher = new ShimLauncher(this.api, {
      artifacts: this.transparent.artifacts,
      // shim 的环境契约（T4 `winstage_shim.h`）：STAGE_ROOT / CONFIG / LOG。
      // **不设** WINSTAGE_SHIM_DISABLE —— 设了 shim 就完全不生效，等于裸跑。
      env: {
        WINSTAGE_STAGE_ROOT: this.stagingRoot,
        WINSTAGE_SHIM_LOG: logPath,
        WINSTAGE_SHIM_CONFIG: configPath,
        ...(this.auditPath ? { WINSTAGE_AUDIT_LOG: this.auditPath } : {}),
        // ── 注册表覆盖层**不得**落在暂存树里（本轮修复）─────────────────────────
        // `WINSTAGE_STAGE_ROOT` 同时是文件族的重定向根**和**注册表 overlay 的默认
        // sessionDir（`ws_entry.c` 的取值顺序：REGSTAGE_SESSION_DIR > DSH_REGSTAGE_ROOT
        // > STAGE_ROOT）。而 `stagingRoot` 就是**暂存树**本身 —— 于是 shim 把
        // `registry/overlay.hive*`/`overlay.journal` 写进暂存树，宿主执行后的
        // "提取暂存树变化"（`workspace.captureAfterExecution` / `ingestCapturedChanges`）
        // 立刻把它们当成**工作区变更**去摄取，并在文件仍被持有/独占时抛
        // `EPERM ... overlay.<pid>.hive.LOG1`（本机实测：`cli exec --tier auto` 正是
        // 这样崩的）。这是"自指条目"的老形态：暂存层自己的状态文件被当成用户改动。
        // 把 sessionDir 指到**会话存储根**（`<store>/`，即 manifest/review/queue 所在处）
        // 一次解决两件事：① overlay/WAL 不再进暂存树；② 覆盖层与候选队列同在
        // `<sessionDir>/` 下，正是 `src/registry-stage.mjs::createRegistryStage()`
        // 读取 WAL、写 `candidates/` + `queue.json` 的契约布局。
        ...(typeof this.options.registryStageDir === 'string' && this.options.registryStageDir.length > 0
          ? {
              WINSTAGE_REGSTAGE_SESSION_DIR: this.options.registryStageDir,
              DSH_REGSTAGE_ROOT: this.options.registryStageDir,
            }
          : {}),
      },
      captureDir: this.stagingRoot,
      spawn: typeof cap.spawnTransparentProcess === 'function' ? cap.spawnTransparentProcess : spawnCapturedAsync,
    })

    this.initReport = await this.selfTest()
    // ── Phase 2 / WP1：去令牌化档不写 ACL（没有能力 SID 要授权）────────────────────
    // 如实记一条**不同强制机制**的记录，而不是伪造一条"授权成功"：
    //   · `granted:false` + `enforcement:'shim-user-mode'` ⇒ `assertStagingWriteEnforceable()`
    //     的 ACL 授权门**不适用**（该档的"根可写"证据来自 shim 自检 + Fix A 闸门）；
    //   · `hostCreated` 仍为真 —— 根同样由宿主进程在 `init()` 顶部先建出来。
    this.stageGrant = {
      root: this.stagingRoot,
      source: this.stagingRootSource,
      override: this.stageGrantPlan.override === true,
      writable: this.mode === 'workspace-write',
      enforcement: 'shim-user-mode',
      granted: false,
      verified: false,
      reason: 'this mode enforces staging writes in user space; no capability-SID entry is written',
      hostCreated: existsSync(this.stagingRoot),
    }
    // 三轮接线：去令牌化模式同样要过网络策略闸门（WFP 是内核层，与启动方式无关）：
    // OFFLINE 能强制就安装并记录，强制不了就由 run() 的 assertNetworkPolicyEnforceable()
    // 拒绝执行。默认 OBSERVED_ONLINE 下这里是纯查询。
    this.prepareNetworkPolicy()
    Object.assign(this.initReport, {
      initMs: Date.now() - started,
      mode: this.mode,
      stagingRoot: this.stagingRoot,
      tempDir: this.tempDir,
      // 缺陷③（Fix B）：本次 init 在暂存根上做的陈旧包 SID ACE 修复
      // （修复发生在 `init()` 顶部，早于通道判定，因此这里读实例字段）
      staleAppContainerAces: this.staleAceRepair,
      // Phase 2 / WP1：本档的写授权记录（机制 = shim 用户态，非 ACL）
      stagingGrant: this.stageGrant,
      tier: this.tier,
      tierRequested: this.tierRequested,
      tierEffective: this.tierEffective,
      launchMode: this.launchMode,
      fallbackReason: this.fallbackReason,
      // 三轮接线的三个维度摘要
      ...this.dimensionSummaries(),
      backend: 'winstage-shim-iat',
      enforcement: 'shim-user-mode',
      jobEnabled: false,
      jobAccounting: null,
      treeReclaim: 'taskkill /T /F (transparent mode has no Job Object)',
      transparentShim: this.transparent
        ? {
            available: this.transparent.available,
            reason: this.transparent.reason,
            artifacts: this.transparent.artifacts,
            transport: this.transparent.transport,
            checks: this.transparent.checks,
            abiVersion: this.transparent.abiVersion,
            canary: this.transparent.canary,
            canaryJudge: this.transparent.canaryJudge,
          }
        : undefined,
      shimConfig: config,
      shimConfigPath: configPath,
    })
    return this.initReport
  }

  /** fail-closed 初始化：任何 Win32 失败都抛错，绝不降级为无沙箱（手册 1.2 / 5.2） */
  async init() {
    if (this.sandbox || this.launchMode === 'shim') return this.initReport
    if (process.platform !== 'win32') {
      throw fail('SANDBOX_UNAVAILABLE', 'the Windows stage sandbox requires process.platform === "win32"')
    }
    if (!this.stagingRoot) throw fail('SANDBOX_UNAVAILABLE', 'stagingRoot is required — refusing to confine an unspecified root')
    // ── Phase 2 / WP1 ①：根**必须先由宿主进程创建** ────────────────────────────────
    // WP0 实测：缓存面上的暂存根对被收窄的命令行子进程是**只读**的（连 `mkdir` 都 EPERM），
    // 只有宿主进程建得出。因此这里（宿主侧、授权之前）就是创建点；建不出 ⇒
    // `STAGE_GRANT_FAILED(root-not-creatable)`，**绝不静默回落到工作区**、
    // 也绝不放行到"授权"那一步（那只会得到一个更晚、更难归因的 `Access is denied`）。
    try {
      mkdirSync(this.stagingRoot, { recursive: true })
    } catch (error) {
      throw stageGrantError(STAGE_GRANT_REASONS.ROOT_NOT_CREATABLE, {
        root: this.stagingRoot,
        detail: `${error.code ?? 'ERR'}: ${error.message}`,
        steps: [{ step: 'host-create-root', ok: false, by: 'host-process', root: this.stagingRoot }],
      })
    }
    // ── BUG-3：把"初始化那一刻的暂存根 / 环境契约"记进可查询状态 ─────────────────
    // 后面 `run()` 每次采样都与这里比对，"有值 → 空"才会被判成失根（而不是"从没设过"）。
    this.noteStagingRootSampling('init')
    // ── 缺陷③（Fix B）：修复与通道无关，两条初始化路径都要先摘陈旧包 SID ACE ──────
    // 放在这里（通道判定之前）保证 `init` 对"被 T0 污染过的工作区"总是先修再测。
    // 结果挂在实例上（`this.staleAceRepair`），因为 `initTransparent()` 是另一个方法。
    const staleRepair = this.repairStaleStagingAces()

    const cap = WindowsStageExecutor.capabilities(this.options.overrides)

    // ── 模式判定：去令牌化（透明 shim）优先，但**只认真实可用性** ─────────────
    // `tier: 'TS'`（或 'auto'）会先跑三级探测；探测不过一律 fail-closed 回退
    // 受限令牌模式。绝不因为"配置开关打开"就换成普通令牌。
    const requested = this.options.tier ?? process.env.WINSTAGE_TIER ?? 'T1'
    this.tierRequested = requested
    const wantsTransparent = String(requested).toUpperCase() === TRANSPARENT_TIER || String(requested).toLowerCase() === 'auto'
    if (wantsTransparent && typeof cap.probeTransparentShim === 'function') {
      this.transparent = cap.probeTransparentShim({
        stagingRoot: this.stagingRoot,
        tempDir: this.options.tempDir,
        passthrough: this.options.shimPassthrough,
        timeoutMs: this.options.shimProbeTimeoutMs,
        captureDir: this.stagingRoot,
        registryStageDir: this.options.registryStageDir,
        ...(this.options.shimOptions ?? {}),
      })
    }
    const selected = selectLaunchMode(requested, this.transparent)
    this.launchMode = selected.mode
    this.tierEffective = selected.tierEffective
    this.tier = selected.tierEffective
    this.fallbackReason = selected.fallbackReason
    if (this.launchMode === 'shim') return this.initTransparent(cap)

    if (!cap.aclAvailable) {
      throw fail(
        'SANDBOX_UNAVAILABLE',
        `@deepseek-ai/dsh-sandbox-windows-acl is not loadable (${cap.aclError}). Refusing to run unconfined — binding the workspace writable without an enforcing backend is forbidden (manual §1.2/§5.2).`,
      )
    }

    const tempDir = this.options.tempDir || defaultPrivateTemp()
    mkdirSync(tempDir, { recursive: true })
    if (typeof cap.assertPrivateTempDisjoint === 'function') {
      cap.assertPrivateTempDisjoint([this.stagingRoot], tempDir)
    }

    const writable = this.mode === 'workspace-write'
    const started = Date.now()
    // ── 缺陷③（Fix B）：修复已在 `init()` 顶部完成（通道判定之前）───────────────
    // 这里只保留引用，供下面的 `initReport` 如实记录本次修复结果。
    // ── Phase 2 / WP1 ②③④：宿主建根 → 授权 → **回读确认 ACE 真的在**（fa​il-closed）────
    // 这是"给当次运行的能力 SID（`S-1-4-…`）在暂存根上授予写权限"的**唯一入口**，
    // 目标根 = `stageGrantTarget()`（显式 override 或 `resolveStageRoot` 的缓存根）。
    // 授权目标**逐字**就是下面 `writableDirs` / `writeSid` 用的那个根 —— 三者同源，
    // 不存在"授权落在一个目录、子进程 cwd 在另一个目录"的漂移。
    const grant = await ensureStageGrant({
      target: { ...this.stageGrantPlan, root: this.stagingRoot },
      writable,
      resolveWriteSid: (root) => cap.workspaceWriteSid(root),
      // 授权动作本身仍由 ACL 后端做（令牌构造 + ACE 写入），本文件不重写它；
      // 后端抛错 / 回报失败一律被 `ensureStageGrant` 归因成 `STAGE_GRANT_FAILED`。
      runGrant: async (root, writeSid) => ({
        value: await initAclSandboxWithTokenCapture(cap.AclSandbox, {
          writableDirs: writable ? [root] : [],
          tempDir: writable ? tempDir : null,
          writeSid,
          tempWriteSid: writable && tempDir ? cap.tempWriteSid(tempDir) : undefined,
          mode: this.mode,
        }),
      }),
      readSddl: this.options.readSddl,
      parseSddl: this.options.parseSddl,
      captureDir: this.options.icaclsCaptureDir,
      verifyStageGrantAce: this.options.verifyStageGrantAce,
      // 调用方注入了 `overrides.AclSandbox` 替身 ⇒ 替身不写真实 ACE，回读注定测不到。
      // 显式声明这条缝（而不是靠"writeSid 长得像假的"之类猜测），语义与
      // `assertPrivateTempDisjoint` 等替身缝一致：生产不注入即走严格判据。
      injectedBackend: Boolean(this.options.overrides?.AclSandbox),
    })
    // 授权记录挂在实例上：`assertStagingWriteEnforceable()` 与 `initReport` 都读它。
    this.stageGrant = {
      root: this.stagingRoot,
      source: this.stagingRootSource,
      override: this.stageGrantPlan.override === true,
      writable,
      // 本档的强制机制：能力 SID（`S-1-4-…`）在暂存根上的写 ACE。闸门只对这条档生效。
      enforcement: 'acl-write-sid',
      granted: grant.granted === true,
      writeSid: grant.writeSid,
      verified: grant.verification?.verified === true,
      verification: grant.verification,
      hostCreated: grant.hostCreated === true,
      created: grant.created === true,
      steps: grant.steps,
    }
    const { sandbox, api: capturedApi, token, fieldNames } = grant.value

    // 关键：低层原语表（基底）+ 模块级 spawn 函数 + ACL 安全扩展，三者都要。
    const lowLevel = cap.processBindings
    if (!lowLevel || typeof lowLevel.createProcessAsUserW !== 'function') {
      safeDispose(sandbox)
      throw fail(
        'SANDBOX_UNAVAILABLE',
        'loadWin32ProcessBindings() did not return a usable low-level table (createProcessAsUserW missing)',
      )
    }
    if (typeof cap.spawnPipedProcess !== 'function') {
      safeDispose(sandbox)
      throw fail(
        'SANDBOX_UNAVAILABLE',
        'the win32-process module did not export spawnPipedProcess; cannot launch a confined child with an explicit environment block (manual §8.3).',
      )
    }
    const { merged, added, skipped } = mergeBindingTables(lowLevel, capturedApi)
    for (const required of ['createProcessAsUserW', 'createPipe', 'assignProcessToJobObject', 'setInformationJobObject']) {
      if (typeof merged[required] !== 'function') {
        safeDispose(sandbox)
        throw fail('SANDBOX_UNAVAILABLE', `the merged binding table lacks the required primitive ${required}`)
      }
    }
    this.spawnPipedProcess = cap.spawnPipedProcess

    this.sandbox = sandbox
    this.api = merged
    this.token = token
    this.tempDir = writable ? tempDir : undefined
    this.launcher = new RestrictedLauncher(merged, token, cap.spawnPipedProcess, this.options)
    // collectChild 需要库提供的 drainPipe / waitForProcessExit
    this.processLibrary = cap.processLibrary
    if (typeof this.processLibrary?.drainPipe !== 'function' || typeof this.processLibrary?.waitForProcessExit !== 'function') {
      safeDispose(sandbox)
      throw fail(
        'SANDBOX_UNAVAILABLE',
        'the process library did not expose drainPipe/waitForProcessExit; confined child output cannot be collected',
      )
    }

    // 建立常驻 Job：所有沙箱内子进程共享，进程退出即整树回收
    const jobInfo = this.launcher.createJob()
    this.job = jobInfo.job

    // Job 结构自检：用**临时 Job** 反证结构与查询长度正确，然后立刻释放。
    //
    // 曾经的做法是"把宿主自身进程挂进常驻 Job 再查询"，那是错的（真实缺陷 14）：
    // 自己进了 Job 会占用一个活跃进程名额，再叠加 ACTIVE_PROCESS 上限时，
    // 后续 AssignProcessToJobObject 直接返回 1816（Job 配额耗尽），
    // 表现为所有命令都起不来。自检不应改变运行期状态。
    let jobAccounting
    const probe = this.launcher.createJob()
    try {
      jobAccounting = this.launcher.activeProcesses(probe.job)
      if (jobAccounting.activeProcesses !== 0 || jobAccounting.totalProcesses !== 0) {
        throw new Error(
          `fresh job reports active=${jobAccounting.activeProcesses} total=${jobAccounting.totalProcesses}, expected zeros`,
        )
      }
    } catch (error) {
      try {
        this.api.closeHandle(probe.job)
      } catch {
        /* 清理失败不掩盖原因 */
      }
      try {
        this.api.closeHandle(this.job)
      } catch {
        /* 同上 */
      }
      safeDispose(this.sandbox)
      throw fail(
        'SANDBOX_UNAVAILABLE',
        `Job Object self-check failed (${error.message}); refusing to run with an unverified job structure`,
      )
    }
    this.launcher.jobs.delete(probe.job)
    safeClose(this.api, probe.job)

    // 常驻 Job 必须为空：确认我们没有把宿主自身挂进去
    const resident = this.launcher.activeProcesses(this.job)
    if (resident.totalProcesses !== 0 || resident.activeProcesses !== 0) {
      safeDispose(this.sandbox)
      throw fail(
        'SANDBOX_UNAVAILABLE',
        `the resident job is not empty at startup (active=${resident.activeProcesses} total=${resident.totalProcesses}); ` +
          'the host process must not be assigned to it',
      )
    }

    this.initReport = await this.selfTest()
    // ── T0（AppContainer）执行路径的接线（本轮）──────────────────────────────
    // 只在**显式要求 T0** 时装配。任何一步失败都 fail-closed（抛 SANDBOX_UNAVAILABLE），
    // **绝不**降级成 T1 继续跑 —— 那会让调用方以为自己在 T0 里，而实际只是一个普通进程
    // （这正是阶段 B 抓到的"看起来成功、实际边界没生效"）。
    let appContainer = null
    if (String(this.tier).toUpperCase() === 'T0') {
      try {
        appContainer = await createAppContainerLauncher({
          api: this.api,
          grantPaths: [this.stagingRoot, this.tempDir].filter(Boolean),
          capabilities: this.options.capabilities ?? [],
          profileName: this.options.profileName,
          // 三轮接线：把进程缓解策略传进 T0 启动路径。默认 `none` ⇒ 构造出的策略
          // `flags === 0n` ⇒ 属性列表仍是 1 个槽位、一次 `UpdateProcThreadAttribute`，
          // 与接线前**逐字一致**（判据在 appcontainer-runtime 的 attributeListCountFor）。
          mitigationPolicy: this.mitigationPolicyBuilt,
        })
        this.appContainer = appContainer.launcher
        this.appContainerInfo = {
          profileName: appContainer.profileName,
          sid: appContainer.sid,
          createdProfile: appContainer.createdProfile,
          grants: appContainer.grants,
          attributeListSize: appContainer.attributeListSize,
          mitigation: appContainer.mitigation ?? null,
        }
      } catch (error) {
        try {
          this.launcher?.dispose()
        } catch {
          /* 清理失败不掩盖原因 */
        }
        safeClose(this.api, this.job)
        safeDispose(this.sandbox)
        throw fail(
          'SANDBOX_UNAVAILABLE',
          `tier=T0 was requested but the AppContainer launch path could not be established (${error.code ?? ''} ${error.message}). ` +
            'Refusing to fall back to T1: the report would then claim T0 while the child is an ordinary process.',
        )
      }
    }
    // ── 三轮接线：网络策略（OFFLINE 才安装）+ 三个维度写进 initReport ─────────────
    // 位置刻意放在 T0 装配**之后**：上面任何一条 fail-closed 抛出路径都还没安装 WFP
    // 过滤器，因此不存在"抛在半路、过滤器留在系统上"的窗口。装上之后由 dispose()
    // 的 teardownNetworkPolicy() 负责拆除（显式删 filter → 删 sublayer → 关引擎）。
    this.prepareNetworkPolicy()
    Object.assign(this.initReport, {
      initMs: Date.now() - started,
      mode: this.mode,
      stagingRoot: this.stagingRoot,
      tempDir: this.tempDir,
      capturedFields: fieldNames,
      bindingTable: { addedFromAcl: added, keptFromProcessLibrary: skipped.length },
      jobFlags: `0x${jobInfo.flags.toString(16)}`,
      jobConfig: jobInfo.config,
      jobAccounting,
      // 缺陷③（Fix B）：本次 init 在暂存根上做的陈旧包 SID ACE 修复（含"没发现"这一如实结论）
      staleAppContainerAces: staleRepair,
      // ── Phase 2 / WP1：本次运行在暂存根上做的**写授权**（目标来源 + 回读结论）──────
      // `source` 让人一眼看出根是显式 override 来的还是 `resolveStageRoot()` 解析的；
      // `verified` 是回读 DACL 的结论。失败不会走到这里（上面已经 fail-closed 抛错）。
      stagingGrant: this.stageGrant,
      tier: this.tier,
      tierRequested: this.tierRequested,
      tierEffective: this.tierEffective,
      launchMode: this.launchMode,
      fallbackReason: this.fallbackReason,
      // 三轮接线的三个维度摘要（同一份口径也出现在 run() 结果里）
      ...this.dimensionSummaries(),
      transparentShim: this.transparent
        ? {
            available: this.transparent.available,
            reason: this.transparent.reason,
            artifacts: this.transparent.artifacts,
            transport: this.transparent.transport,
            checks: this.transparent.checks,
            abiVersion: this.transparent.abiVersion,
          }
        : undefined,
      appContainer: this.appContainerInfo,
    })
    return this.initReport
  }

  /**
   * ── 缺陷③（Fix B）：`init` 侧的**修复路径** ─────────────────────────────────────
   *
   * 检测暂存根上"被显式写进去的 AppContainer 包 SID 允许 ACE"
   * （`S-1-15-2-…:(OI)(CI)(M)`，上一次 T0 运行为了包 SID 能写暂存根而授予、却没撤销），
   * 并把它们摘掉，让之后的 T1 暂存写重新可用。
   *
   * 三条纪律：
   *   ① **只碰暂存根**（`this.stagingRoot`）：不下钻、不碰父目录、不碰 tempDir，
   *      因为判据（`findStaleAppContainerAces`）只对"显式写入"的 ACE 成立，
   *      而本仓库唯一会往树里写这种 ACE 的地方就是 T0 的 `grantPaths`；
   *   ② 测不出来就说测不出来（`sddlAvailable:false`）—— **不**把"读不到 DACL"读成"干净"；
   *   ③ 摘不干净也如实报（`repaired:false` + `remaining`），由 Fix A 闸门拒绝运行，
   *      而不是"假装修好了"继续跑。
   *
   * 人读通道：`init` 的格式化输出会打印 `⚠ 清理…`（见 `src/capability.mjs::formatReport`），
   * 模型可见的 `exec` stdout 不受影响（本函数什么都不打印）。
   */
  repairStaleStagingAces() {
    if (this.options.repairStaleAces === false) {
      return { checked: false, repaired: false, removed: [], remaining: [], present: [], skipped: 'disabled-by-option' }
    }
    if (!this.stagingRoot) {
      return { checked: false, repaired: false, removed: [], remaining: [], present: [], skipped: 'no-staging-root' }
    }
    let result
    try {
      result = (this.options.repairStaleAcesImpl ?? repairStaleAppContainerAces)(this.stagingRoot, {
        captureDir: this.options.icaclsCaptureDir,
      })
    } catch (error) {
      return {
        checked: true,
        repaired: false,
        removed: [],
        remaining: [],
        present: [],
        sddlAvailable: false,
        verifyAvailable: false,
        reason: `stale-ACE repair threw: ${error.message}`,
      }
    }
    this.staleAceRepair = result
    return { checked: true, ...result }
  }

  /**
   * 实例级实测（手册 #5.5：缓存成功不能替代实例启动后的必要检查）。
   * 关键：必须从**沙箱内部**发起真实攻击探针，而不是从宿主侧推断。
   */
  async selfTest() {
    // 去令牌化模式的判据完全不同：工作区外写入**不是被拒**，而是"报告成功 + 真实
    // 磁盘不变 + 进了暂存树"。用受限令牌那套断言去测它只会得到假失败。
    if (this.launchMode === 'shim') return this.selfTestTransparent()
    const checks = []
    const stamp = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
    const inside = join(this.stagingRoot, `.dsh-selfcheck-${stamp}.txt`)
    const outside = join(dirname(this.stagingRoot), `.dsh-selfcheck-outside-${stamp}.txt`)
    const system = `C:\\Windows\\dsh-selfcheck-${stamp}.txt`

    const script = [
      "$r=[ordered]@{}",
      `try{Set-Content -LiteralPath '${ps(inside)}' -Value 'x' -ErrorAction Stop;$r.inside='ok'}catch{$r.inside='denied'}`,
      `try{Set-Content -LiteralPath '${ps(outside)}' -Value 'x' -ErrorAction Stop;$r.outside='ok'}catch{$r.outside='denied'}`,
      `try{Set-Content -LiteralPath '${ps(system)}' -Value 'x' -ErrorAction Stop;$r.system='ok'}catch{$r.system='denied'}`,
      `try{[void](Get-Content -LiteralPath 'C:\\Windows\\win.ini' -ErrorAction Stop);$r.readSystem='ok'}catch{$r.readSystem='denied'}`,
      "$r.temp=$env:TEMP",
      "$r.user=$env:USERNAME",
      "$r.secret=$($null -eq $env:DSH_TEST_SECRET)",
      "[Console]::Out.Write(($r|ConvertTo-Json -Compress))",
    ].join(';')

    let outcome
    try {
      // 不硬编码 pwsh：本机只有 Windows PowerShell 5.1（实测缺陷 7）
      const shell = resolvePowerShell(process.env, this.stagingRoot)
      outcome = await this.run({
        command: shell.name,
        args: ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', script],
        cwd: this.stagingRoot,
        timeoutMs: this.options.selfTestTimeoutMs ?? 90000,
        env: { DSH_TEST_SECRET: 'should-not-appear' },
        // 自检就是产出"暂存根能不能写"这条证据的那次运行 —— Fix A 的闸门必须豁免它，
        // 否则会在证据存在之前拒绝自己（先有鸡还是先有蛋）。
        skipStagingWritePreflight: true,
      })
    } catch (error) {
      checks.push({ name: 'self-test-spawn', status: 'fail', detail: error.message, evidence: '[实测]' })
      cleanupTargets([inside, outside, system])
      return { checks, enforcement: 'unknown' }
    }

    let parsed
    const lastLine = outcome.stdout.trim().split(/\r?\n/).filter(Boolean).pop()
    try {
      parsed = JSON.parse(lastLine || '{}')
    } catch {
      parsed = undefined
    }

    const pass = (name, condition, detail) =>
      checks.push({ name, status: condition ? 'pass' : 'fail', detail, evidence: '[实测] 从沙箱内部发起' })

    pass('inside-staging-write-allowed', parsed?.inside === 'ok', parsed?.inside ?? outcome.stderr.slice(0, 300))
    pass('outside-staging-write-denied', parsed?.outside === 'denied', parsed?.outside ?? 'no result')
    pass('system-dir-write-denied', parsed?.system === 'denied', parsed?.system ?? 'no result')
    pass('temp-rewritten-to-private', typeof parsed?.temp === 'string' && sameDir(parsed.temp, this.tempDir), `TEMP=${parsed?.temp}`)
    pass('sensitive-env-not-inherited', parsed?.secret === true, `DSH_TEST_SECRET present=${parsed?.secret === false}`)
    checks.push({
      name: 'system-file-read',
      status: parsed?.readSystem === 'denied' ? 'pass' : 'documented-residual',
      detail:
        parsed?.readSystem === 'denied'
          ? '读取被拒（超出预期，可能由宿主 ACL 而非本沙箱造成）'
          : '读取成功 —— WRITE_RESTRICTED 与 Low IL 均不限制读取（手册 #16.10 残余边界，不得声明为硬边界）',
      evidence: '[实测] 从沙箱内部发起',
    })

    // Job 归属实测：子进程应已被纳管
    try {
      const accounting = this.launcher.activeProcesses(this.job)
      checks.push({
        name: 'job-object-accounting',
        status: 'pass',
        detail: `totalProcesses=${accounting.totalProcesses} active=${accounting.activeProcesses} terminated=${accounting.terminatedProcesses}`,
        evidence: '[实测]',
      })
    } catch (error) {
      checks.push({ name: 'job-object-accounting', status: 'fail', detail: error.message, evidence: '[实测]' })
    }

    cleanupTargets([inside, outside, system])
    const enforcement = checks.every((c) => c.status === 'pass' || c.status === 'documented-residual') ? 'partial' : 'degraded'
    return { checks, enforcement, observed: parsed, exitCode: outcome.exitCode }
  }

  /**
   * 去令牌化模式的实例自检（手册 #5.5：缓存"探测通过"不能替代实例启动后的检查）。
   *
   * 判据与受限令牌模式**不同**，这一点必须写死在两条路径里而不是复用：
   *   - 工作区外写入「报告成功」是**预期**（被 shim 重定向进暂存），
   *     因此判据是「报成功 + 宿主侧真实磁盘没有它 + 暂存树里有它」；
   *   - 另加金丝雀结论（四类能力真的恢复）与痕迹断言（无 `DSH_SANDBOX*`）。
   */
  async selfTestTransparent() {
    const checks = []
    const stamp = `${Date.now().toString(36)}${randomUUID().slice(0, 4)}`
    const outside = `C:\\Windows\\Temp\\winstage-shim-selfcheck-${stamp}.txt`
    const judge = this.transparent?.canaryJudge
    checks.push({
      name: 'transparent-capability-canary',
      status: judge?.ok ? 'pass' : 'fail',
      detail: `经注入器启动的金丝雀子进程: ${judge?.reason ?? '无金丝雀结果'}; items=${JSON.stringify(judge?.items ?? {})}`,
      evidence: '[实测] winstage-inject.exe → 金丝雀 PowerShell',
    })

    const script = [
      "$ErrorActionPreference='Continue'",
      `try { Set-Content -LiteralPath '${ps(outside)}' -Value 'winstage-shim' -ErrorAction Stop; 'SHIM-WRITE=ok' } catch { 'SHIM-WRITE=denied:' + $_.Exception.GetType().Name }`,
      `try { [void](Get-Content -LiteralPath '${ps(outside)}' -ErrorAction Stop); 'SHIM-READBACK=ok' } catch { 'SHIM-READBACK=denied' }`,
    ].join('\r\n')

    let outcome
    try {
      const shell = resolvePowerShell(process.env, this.stagingRoot)
      outcome = await this.run({
        command: shell.name,
        args: ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', script],
        cwd: this.stagingRoot,
        timeoutMs: this.options.selfTestTimeoutMs ?? 90000,
        // 与受限令牌路径同理：自检自己产出判据，Fix A 闸门豁免它。
        skipStagingWritePreflight: true,
      })
    } catch (error) {
      checks.push({ name: 'transparent-self-test-spawn', status: 'fail', detail: error.message, evidence: '[实测]' })
      return { checks, enforcement: 'degraded' }
    }

    const reported = /SHIM-WRITE=ok/.test(outcome.stdout)
    const realExists = existsSync(outside) // 宿主侧（未受限）看到的**真实磁盘**
    let staged
    try {
      staged = findFileUnder(this.stagingRoot, `winstage-shim-selfcheck-${stamp}.txt`)
    } catch {
      staged = undefined
    }
    checks.push({
      name: 'outside-write-staged-not-real',
      status: reported && !realExists && staged ? 'pass' : 'fail',
      detail: `child-reported-ok=${reported} real-disk-has-file=${realExists} staged=${staged ?? 'not-found'} exit=${outcome.exitCode}`,
      evidence: '[实测] 从沙箱内部发起写、宿主侧核对真实磁盘与暂存树',
    })
    if (realExists) {
      try {
        unlinkSync(outside)
      } catch {
        /* 清理失败不影响判定 */
      }
    }
    checks.push({
      name: 'no-dsh-sandbox-trace',
      status: this.transparent?.canary?.dshSandboxCount === 0 ? 'pass' : 'fail',
      detail: `子进程里的 DSH_SANDBOX* 变量: ${JSON.stringify(this.transparent?.canary?.dshSandboxVars ?? null)}`,
      evidence: '[实测] 金丝雀子进程环境扫描',
    })
    const enforcement = checks.every((check) => check.status === 'pass' || check.status === 'documented-residual')
      ? 'shim-user-mode'
      : 'degraded'
    return { checks, enforcement, observed: this.transparent?.canary, exitCode: outcome.exitCode }
  }

  /**
   * 解析可执行文件的绝对路径。
   *
   * 为什么必须自己做（`[实测]` 缺陷 6）：`CreateProcessAsUserW` **不做** shell 式的
   * 可执行文件解析 —— 它不会补 `PATHEXT`（`.exe`/`.cmd`/…），也不走 App Paths 注册表。
   * 传 `pwsh` 这种裸名字会直接失败，Win32 错误 2（ERROR_FILE_NOT_FOUND）。
   * 因此必须在宿主侧把命令解析成绝对路径，再用受限令牌启动。
   *
   * 解析顺序（与 CreateProcess 的搜索顺序一致）：
   *   1. 已是绝对路径且存在 → 直接用
   *   2. 含目录分隔符 → 相对 cwd / PATH 各目录拼接
   *   3. 裸名字 → 依次尝试 pathExt 里的每个扩展名，逐个 PATH 目录查找
   *   4. 都找不到 → 抛 ENOENT，并附上搜过哪些位置（不要静默失败）
   */
  static resolveExecutable(command, options = {}) {
    return resolveExecutable(command, options)
  }

  /**
   * 收集已启动子进程的结果。
   *
   * **真实的 API 形状**（真实缺陷 15）：`spawnPipedProcess` 返回的是
   * `{ pid, process, stdoutRead, stderrRead }` —— 它**没有** `wait()` 方法。
   * 管道必须用 `drainPipe(api, handle)` 读完，退出码要用
   * `waitForProcessExit(api, process)` 取。
   *
   * 早先的实现照搬了 `AclSandbox.spawn()` 的 `{ pid, wait() }` 形状，
   * 于是运行期报 `child.wait is not a function`；
   * 而**替身当时伪造了 `wait()`**，所以这个错误在离线测试里漏过了 ——
   * 替身失真比没有替身更危险，因为它给出虚假的通过。
   *
   * @param {{pid:number, process:unknown, stdoutRead:unknown, stderrRead:unknown}} child
   * @returns {Promise<{stdout: Buffer, stderr: Buffer, exitCode: number}>}
   */
  async collectChild(child) {
    const { drainPipe, waitForProcessExit } = this.processLibrary ?? {}
    if (typeof drainPipe !== 'function' || typeof waitForProcessExit !== 'function') {
      throw fail(
        'SANDBOX_UNAVAILABLE',
        'the process library did not expose drainPipe/waitForProcessExit; cannot collect confined child output',
      )
    }
    const api = this.api
    // ★ 缺陷 D11 修复（本函数是修复点，配合 waitForExitWithoutStarvingEventLoop）：
    //   三条任务必须**并发**跑，且"等退出"必须**让出事件循环而不是同步阻塞**。
    //
    //   1) drainPipe × 2 先发起：让子进程一开始就有人在读它的 stdout/stderr。
    //      注意 drainPipe 是异步轮询（await setTimeout），所以它必然先让出一次执行权；
    //      若此时紧接着同步阻塞等退出，轮询定时器就再也跑不起来（这曾导致 300KB 死锁）。
    //   2) 退出等待用 queueMicrotask 延后一个微任务：确保两条管道都已进入
    //      "已发起读取"状态，不会有任何一次"父进程停下、管道没人读"的窗口。
    //   3) waitForExitWithoutStarvingEventLoop 用 50ms 有界等待轮询代替
    //      WaitForSingleObject(INFINITE)，每次 WAIT_TIMEOUT 都让出事件循环，
    //      排水轮询因此能在子进程运行**期间**持续推进，缓冲区不会写满。
    const exitWait = new Promise((resolve, reject) => {
      queueMicrotask(() => {
        // 让出一次事件循环，给排水轮询一个先手（这才是"并发排水"的实质）
        setTimeout(() => {
          try {
            resolve(waitForExitWithoutStarvingEventLoop(api, child.process, waitForProcessExit))
          } catch (error) {
            reject(error)
          }
        }, 0)
      })
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      drainPipe(api, child.stdoutRead),
      drainPipe(api, child.stderrRead),
      exitWait,
    ])
    return {
      stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout ?? '')),
      stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(String(stderr ?? '')),
      exitCode,
    }
  }

  /**
   * ── 三轮接线：网络策略准备（判定 → 仅 OFFLINE 时安装/回读 → 记录）────────────────
   *
   * 幂等：第一次调用做完就缓存（`networkPolicyPrepared`）。三件事必须一起看：
   *   1. **判定**：`resolveNetworkPolicy()` 不因"计划能构造出来"就报 `ENFORCED`；
   *      它要求"安装证据 + 回读核对"（或本机确实没有回读入口）。
   *   2. **安装**：只有 OFFLINE、且判定结果里 `plan` 非空（= 绑定表/pin/探测/引擎/计划
   *      五步全过，唯一缺的就是安装证据）时才真的装。装的过程由 `netpolicy` 自己
   *      best-effort 回滚；本函数把 `teardown` 收好，`dispose()` 时拆。
   *   3. **失败不吞**：安装/回读失败 ⇒ 记 `not-enforced` 并把底层 code 拼进 reason，
   *      绝不改写成 enforced。
   *
   * 默认档位 `OBSERVED_ONLINE` 下本函数是**纯判定**：不安装、不改系统状态
   * （`resolveNetworkPolicy` 对非 OFFLINE 档位不碰绑定表）。
   */
  prepareNetworkPolicy() {
    if (this.networkPolicyPrepared) return this.networkPolicy
    this.networkPolicyPrepared = true
    const requested = this.networkTier
    const api = this.options.networkBindings ?? this.api ?? null
    const resolveInput = {
      requested,
      api,
      probe: this.options.networkProbe ?? null,
      guids: this.options.networkGuids ?? null,
      target: this.options.networkTarget ?? 'appcontainer',
      pin: this.options.networkPin ?? null,
    }
    let result = resolveNetworkPolicy({
      ...resolveInput,
      install: this.networkInstallEvidence ?? null,
      audit: this.networkInstallAudit ?? null,
    })
    if (requested === 'OFFLINE' && result.state !== NETWORK_TIER_STATES.ENFORCED && result.plan) {
      try {
        const installed = installNetworkPolicy({
          api,
          plan: result.plan,
          guids: resolveInput.guids,
          pin: resolveInput.pin,
          retainPointer: this.options.networkRetainPointer,
        })
        this.networkInstallEvidence = installed
        this.networkInstallAudit = installed.audit
        this.networkTeardown = typeof installed.teardown === 'function' ? installed.teardown : undefined
        result = resolveNetworkPolicy({ ...resolveInput, install: installed, audit: installed.audit })
      } catch (error) {
        result = {
          ...result,
          state: NETWORK_TIER_STATES.NOT_ENFORCED,
          enforced: false,
          verified: false,
          reason:
            `${result.reason}；安装/回读失败（${error.code ?? 'NETWORK_POLICY_INSTALL_FAILED'}）：${error.message} —— ` +
            '网络没有被挡住，因此不得声称已强制',
        }
      }
    }
    this.networkPolicyResult = result
    this.networkPolicy = summariseNetworkPolicy(result)
    return this.networkPolicy
  }

  /**
   * ── 三轮接线：网络 fail-closed 闸门（`run()` 的第一道门）─────────────────────────
   *
   * `OFFLINE` 档位若拿不到 `state:'enforced'`，**拒绝执行任何命令**：
   * 错误码 `SANDBOX_NETWORK_POLICY_UNENFORCED`，message 里带 netpolicy 的 `reason`。
   * 这是"绝不悄悄放行网络"的唯一落地点 —— 判定说挡不住就不跑，而不是照跑不误。
   */
  assertNetworkPolicyEnforceable() {
    const summary = this.prepareNetworkPolicy()
    if (this.networkTier === 'OFFLINE' && summary.state !== NETWORK_TIER_STATES.ENFORCED) {
      throw fail(
        'SANDBOX_NETWORK_POLICY_UNENFORCED',
        `networkTier=OFFLINE 但网络策略没有真正生效（state=${summary.state}, enforced=${summary.enforced}, verified=${summary.verified}）：` +
          `${summary.reason} —— 拒绝在"以为网络已阻断、实际是通的"状态下执行任何命令（fail-closed）`,
      )
    }
    return summary
  }

  /**
   * ── 三轮接线：暂存配额闸门 ──────────────────────────────────────────────────────
   *
   * fail-closed 两条：
   *   1. `checkStagingQuota()` 判定超配额 ⇒ `STAGING_QUOTA_EXCEEDED`（写入之前就拒绝，
   *      而不是写完再量）；
   *   2. **统计不完整**（`truncated` 或 `errors` 非空）⇒ `STAGING_QUOTA_MEASUREMENT_INCOMPLETE`。
   *      这一条是硬要求：统计不了的树等于配额的洞，宁可拒绝写入。
   *      （`limits.mjs` 的"接线契约"把这条判断留给调用方 —— 本方法就是那个调用方。）
   *
   * 默认配额 = `options.limits.stagingBytes`（= 64 GiB）；`stagingQuotaBytes: null` 显式关闭。
   */
  assertStagingQuota(incomingBytes = 0, where = 'staging-write') {
    const quotaBytes = this.options.stagingQuotaBytes !== undefined ? this.options.stagingQuotaBytes : this.limits.stagingBytes
    if (quotaBytes === null) return { allowed: true, reason: 'staging quota explicitly disabled (stagingQuotaBytes:null)' }
    // 根不存在不是"统计不完整"，而是"空树"：先建出来，免得把 ENOENT 读成配额洞。
    if (this.stagingRoot && !existsSync(this.stagingRoot)) mkdirSync(this.stagingRoot, { recursive: true })
    const measure = typeof this.options.measureStaging === 'function' ? this.options.measureStaging : measureTree
    const decision = checkStagingQuota({
      root: this.stagingRoot,
      quotaBytes,
      incomingBytes,
      measure,
      measureOptions: this.options.measureStagingOptions ?? {},
    })
    if (decision.measure && decision.measure.complete === false) {
      const error = fail(
        'STAGING_QUOTA_MEASUREMENT_INCOMPLETE',
        `暂存配额统计不完整（truncated=${decision.measure.truncated}, errors=${decision.measure.errors}）；拒绝写入 ${where}：` +
          `${decision.reason} —— 统计不了的树等于配额的洞（fail-closed）`,
      )
      error.quota = decision
      throw error
    }
    if (!decision.allowed) {
      const error = fail('STAGING_QUOTA_EXCEEDED', `暂存配额不足，拒绝写入 ${where}：${decision.reason}`)
      error.quota = decision
      throw error
    }
    return decision
  }

  /**
   * ── 三轮接线：三个维度的报告摘要（`initReport` 与 `run()` 结果共用同一份口径）────
   * 合在一处是为了"报告只有一份投影"：任何消费方读到的都是同一组字段。
   */
  dimensionSummaries() {
    return {
      networkPolicy: this.prepareNetworkPolicy(),
      mitigations: summariseMitigations(this.mitigationPolicyBuilt),
      limits: summariseLimits(this.limits),
    }
  }

  /**
   * 拆除本次安装的 WFP 策略（幂等；**从不抛错**，失败如实返回给调用方）。
   *
   * 顺序与语义由 `netpolicy.installNetworkPolicy().teardown()` 承担（删 filter 逆序 →
   * 删 sublayer → 关引擎；DYNAMIC 会话是兜底）。本方法只负责调用一次并记账。
   */
  teardownNetworkPolicy() {
    if (!this.networkTeardown) return []
    const teardown = this.networkTeardown
    this.networkTeardown = undefined
    this.networkInstallEvidence = undefined
    this.networkInstallAudit = undefined
    try {
      const result = teardown()
      this.networkTeardownResult = result
      return (result?.failures ?? []).map((text) => `network teardown: ${text}`)
    } catch (error) {
      return [`network teardown threw: ${error.message}`]
    }
  }

/** 在受限令牌下执行一次命令，返回结构化结果（手册第 4 章返回契约） */
  async run(options) {
    // 去令牌化模式没有 AclSandbox（它本来就不是"受限令牌 + ACL"那套），
    // 因此初始化判据必须按模式区分，否则会在 shim 模式下误报"未初始化"。
    if (!this.sandbox && this.launchMode !== 'shim') {
      throw fail('SANDBOX_UNAVAILABLE', 'executor is not initialised; call init() first (fail-closed)')
    }
    // ── 三轮接线①：网络策略 fail-closed 闸门 ─────────────────────────────────────
    // 必须在**任何**暂存写入/子进程创建之前。默认 `OBSERVED_ONLINE` 下这只是纯查询
    // （state:'not-implemented'），不拦任何东西；只有显式 `OFFLINE` 才可能拒绝。
    this.assertNetworkPolicyEnforceable()
    // ── 三轮接线②：暂存配额闸门（默认 64 GiB，对既有流程无感）───────────────────
    // 统计不完整一律拒绝；超配额在写入之前拒绝（见 assertStagingQuota 的注释）。
    this.assertStagingQuota(0, 'run-preflight')
    // ── BUG-3：暂存根生命周期采样 + 失根判定 ─────────────────────────────────────
    // 必须在任何暂存写入/子进程之前。失根抛**独立错误码**（`STAGING_ROOT_*`，
    // `policyDenial:false`），因此不会再被读成一句无归因的 `Access is denied`。
    // 自检自己豁免：它就是产出"暂存根可写"证据的那次运行。
    if (options.skipStagingWritePreflight !== true) this.assertStagingRootPresent('run-preflight')
    // ── 缺陷③（Fix A）+ BUG-4：降级强制 fail-closed 闸门 ─────────────────────────
    // 必须在**任何**子进程/暂存写入之前。`init()` 的自检已经在**同一个身份**下
    // 实测过"暂存根能不能写"；这里只拒绝"测出来不行却照跑"，而且判定是**逐条命令**的：
    // 只读/无副作用命令不被本闸门拦下（见 assertStagingWriteEnforceable）。
    // 自检自身必须豁免：它正是产出这条证据的那次运行。
    if (options.skipStagingWritePreflight !== true) {
      this.assertStagingWriteEnforceable({ command: options.command, args: options.args })
    }
    const cwd = options.cwd || this.stagingRoot
    if (!sameDirOrInside(this.stagingRoot, cwd)) {
      throw fail('CWD_OUTSIDE_STAGING', `cwd ${cwd} is outside the staged root ${this.stagingRoot}`)
    }
    // CreateProcess 的 lpCurrentDirectory 必须真实存在，否则同样是 Win32 2。
    // 新建工作区在首次执行前可能还没有暂存目录，这里补上受控目录（手册 #3.5）。
    if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true })

    const { env, rejected } = buildChildEnvironment(options.env, {
      tempDir: this.tempDir,
      cwd,
      tier: this.tier,
    })

    // ── WP7′：限制即失败 —— 明文出站请求里出现密钥形态 ⇒ **普通失败**，不许静默放行 ──
    //  必须在解析/启动子进程**之前**：这一刻就能判定"这个请求不被允许"。
    //  机读码 `CLEARTEXT_CREDENTIAL_IN_REQUEST`（policy 族）；返回确定性拒绝、
    //  不提供替代路径、也不假装拦住了检测不到的东西（TLS 正文见 detectCleartextSecret 注释）。
    const cleartext = detectCleartextSecret([options.command, ...(options.args || [])].join(' '))
    if (cleartext.matched) {
      const denial = fail(CLEARTEXT_SECRET_FAILURE.code, CLEARTEXT_SECRET_FAILURE.message)
      denial.category = CLEARTEXT_SECRET_FAILURE.category
      denial.secretKind = cleartext.kind
      denial.secretSnippet = cleartext.snippet
      throw denial
    }

    // 关键：CreateProcessAsUserW 不补 PATHEXT，裸名字必然 Win32 2。
    // 必须在宿主侧解析成绝对路径（`[实测]` 缺陷 6）。
    const resolvedCommand = resolveExecutable(options.command, { cwd, env })

    const startedAt = Date.now()
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 120000

    // 启动失败必须变成**结构化结果**，而不是让异常冒泡：
    // 手册第 4 章要求区分"沙箱自身故障"与"命令被拒"，调用方拿不到结果就无法分类。
    // （这是替身测试抓到的真实缺陷 8。）
    let child
    let launchFailure
    // ── T0 与 T1 的唯一分叉点 ───────────────────────────────────────────────
    // T0 走 AppContainerLauncher（`STARTUPINFOEXW` + SECURITY_CAPABILITIES + 文件式 stdio，
    // 且它**自己**同步等到退出），因此不需要 `collectChild()`（那条路要求 `spawnPipedProcess`
    // 的管道句柄，而 T0 拿不到）。两条路都返回同一形状的结果，调用方无需知道区别。
    const t0 = this.launchMode === 'appcontainer' && this.appContainer !== undefined && this.appContainer !== null
    const transparent = this.launchMode === 'shim'
    try {
      if (t0) {
        child = this.appContainer.launch({
          command: resolvedCommand,
          args: options.args || [],
          cwd,
          job: this.job,
          timeoutMs,
          env,
        })
      } else if (transparent) {
        // 去令牌化：普通令牌 + 正常完整性，强制/暂存交给已被注入的 shim。
        // 输出经文件描述符重定向读回（注入器只继承 stdio），因此这条路径**不依赖管道**。
        child = await this.shimLauncher.launch({
          command: resolvedCommand,
          args: options.args || [],
          cwd,
          env,
          timeoutMs,
        })
      } else {
        child = this.launcher.launch({
          command: resolvedCommand,
          args: options.args || [],
          cwd,
          env,
          job: this.job,
        })
      }
    } catch (error) {
      launchFailure = error
    }

    let timedOut = false
    const timeoutPromise = new Promise((resolve) => {
      const handle = setTimeout(() => {
        timedOut = true
        resolve({ stdout: Buffer.alloc(0), stderr: Buffer.from(`dsh-stage: timeout after ${timeoutMs}ms`), exitCode: 124 })
      }, timeoutMs)
      if (typeof handle.unref === 'function') handle.unref()
    })

    let settled
    if (launchFailure) {
      settled = {
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(`dsh-stage: sandbox launch failed: ${launchFailure.message}`),
        exitCode: 127,
      }
    } else if (t0) {
      // T0 的 launch() 已经等到退出并读回输出（含超时判定），因此不再走 `collectChild`。
      timedOut = child.timedOut === true
      settled = {
        stdout: Buffer.isBuffer(child.stdout) ? child.stdout : Buffer.from(String(child.stdout ?? '')),
        stderr: Buffer.isBuffer(child.stderr) ? child.stderr : Buffer.from(String(child.stderr ?? '')),
        exitCode: child.exitCode,
      }
    } else if (transparent) {
      // 去令牌化路径同理：注入器已经把子进程等到退出，输出已按文件描述符重定向读回。
      timedOut = child.timedOut === true
      settled = {
        stdout: Buffer.isBuffer(child.stdout) ? child.stdout : Buffer.from(String(child.stdout ?? '')),
        stderr: Buffer.isBuffer(child.stderr) ? child.stderr : Buffer.from(String(child.stderr ?? '')),
        exitCode: child.exitCode,
      }
    } else {
      try {
        // 用真实的库 API 收集结果（drainPipe + waitForProcessExit），
        // 而不是假定返回对象带 wait()（真实缺陷 15）。
        settled = await Promise.race([this.collectChild(child), timeoutPromise])
      } catch (error) {
        settled = { stdout: Buffer.alloc(0), stderr: Buffer.from(`dsh-stage: ${error.message}`), exitCode: 127 }
      }
    }
    if (timedOut) this.terminate(124)

    const stdoutRaw = settled.stdout.toString('utf8')
    const stderrRaw = settled.stderr.toString('utf8')
    // ── 三轮接线③：输出上限（**绝不静默截断**）────────────────────────────────────
    // 超限时保留"逐字节前缀"+ 纯 ASCII 标记，并把 `truncated` 提升成结果字段；
    // 下游（审批面/日志/模型可见通道）因此可以机检"这条输出被截过、丢了多少"。
    // 默认上限 4 MiB / 200000 行：对既有小输出用例逐字节不变（`truncated:false`、原文返回）。
    const cappedStdout = applyOutputCap(stdoutRaw, { maxBytes: this.limits.maxOutputBytes, maxLines: this.limits.maxOutputLines })
    const cappedStderr = applyOutputCap(stderrRaw, { maxBytes: this.limits.maxOutputBytes, maxLines: this.limits.maxOutputLines })
    const stdout = cappedStdout.text
    const stderr = cappedStderr.text
    const outputTruncated = cappedStdout.truncated || cappedStderr.truncated
    const capSummary = (capped) => ({
      truncated: capped.truncated,
      droppedBytes: capped.droppedBytes,
      droppedLines: capped.droppedLines,
      keptBytes: capped.keptBytes,
      keptLines: capped.keptLines,
      byteTruncated: capped.byteTruncated,
      lineTruncated: capped.lineTruncated,
      marker: capped.marker,
    })
    const startupFailureReport = classifyStartupFailure({
      exitCode: settled.exitCode,
      stdout,
      stderr,
      launchFailure,
      sideEffectsObserved: options.sideEffectsObserved === true,
    })
    return {
      argv: [options.command, ...(options.args || [])],
      command: options.command,
      // 展示解析结果：便于区分"命令名找不到"与"命令自身失败"（手册第 4 章）
      resolvedCommand,
      args: options.args || [],
      cwd,
      logicalCwd: options.logicalCwd,
      exitCode: settled.exitCode,
      stdout,
      stderr,
      timedOut,
      launchFailed: launchFailure !== undefined,
      launchFailureCode: launchFailure?.win32Code,
      // ── BUG-9：启动失败归一分类（真实 NTSTATUS 原样带出）─────────────────────
      // 只要有启动失败特征就带上；`denialClaimContradicted` 明确回答
      // "报 Access is denied 但子进程其实已经运行"这类与事实相反的结论。
      startupFailure: startupFailureReport,
      durationMs: Date.now() - startedAt,
      envKeys: Object.keys(env).sort(),
      envRejected: rejected,
      classification: classifyOutcome({ exitCode: settled.exitCode, stdout, stderr, launchFailure, startupFailure: startupFailureReport }),
      enforcement: transparent ? 'shim-user-mode' : 'partial',
      backend: transparent ? 'winstage-shim-iat' : t0 ? 'windows-appcontainer' : 'windows-acl-restricted-token',
      launchMode: this.launchMode,
      tier: this.tier,
      hasOutput: stdout.length > 0 || stderr.length > 0,
      // #4.2：退出码 0 且无输出 = 执行完成无输出，不是"没执行"
      completedWithoutOutput: settled.exitCode === 0 && stdout.length === 0 && stderr.length === 0,
      // ── BUG-3 / BUG-4：可查询的诊断面（逐条命令的闸门判定 + 失根状态）──────────
      stagingWriteGate: this.stagingWriteGate.lastDecision,
      stagingRoot: this.stagingRootDiagnostics(),
      // ── 三轮接线的报告面（同一份摘要口径，见 dimensionSummaries）──────────────
      outputTruncated,
      outputDroppedBytes: cappedStdout.droppedBytes + cappedStderr.droppedBytes,
      outputCap: { stdout: capSummary(cappedStdout), stderr: capSummary(cappedStderr) },
      ...this.dimensionSummaries(),
    }
  }

  terminate(exitCode = 1) {
    if (this.launchMode === 'shim') {
      const failures = this.shimLauncher ? this.shimLauncher.terminateAll(exitCode) : []
      return { terminated: true, failures }
    }
    if (!this.job || !this.launcher) return { terminated: false }
    const result = this.launcher.terminateJob(this.job, exitCode)
    return { terminated: result !== 0 }
  }

  dispose() {
    const failures = []
    // 三轮接线：先拆网络策略（幂等）。顺序放在最前 —— 网络面恢复不该等 Job/令牌清理。
    failures.push(...this.teardownNetworkPolicy())
    // 去令牌化模式：没有 Job、没有 AclSandbox，只有注射器起的进程树。
    if (this.launchMode === 'shim') {
      if (this.shimLauncher) failures.push(...this.shimLauncher.dispose())
      if (this.tempDir && this.options.keepTemp !== true) {
        try {
          if (existsSync(this.tempDir)) rmSync(this.tempDir, { recursive: true, force: true })
        } catch (error) {
          failures.push(`temp cleanup (${this.tempDir}): ${error.message}`)
        }
      }
      this.shimLauncher = undefined
      this.launchMode = undefined
      return { disposed: true, failures }
    }
    // T0 先回收：撤销暂存根/temp 的包 SID 授权、删除本次创建的 profile。
    // 顺序放在 Job/令牌之前，因为属性列表与 profile 的生命周期只属于 T0 那一次运行。
    if (this.appContainer) {
      try {
        failures.push(...this.appContainer.dispose())
      } catch (error) {
        failures.push(`appcontainer dispose: ${error.message}`)
      }
      this.appContainer = undefined
    }
    if (this.launcher) failures.push(...this.launcher.dispose())
    if (this.sandbox) {
      try {
        this.sandbox.dispose()
      } catch (error) {
        failures.push(error instanceof AggregateError ? error.errors.map((e) => e.message).join('; ') : error.message)
      }
    }
    // 会话私有 temp：退出即销毁（手册 #6.5 生命周期显式构造）
    if (this.tempDir && this.options.keepTemp !== true) {
      try {
        if (existsSync(this.tempDir)) rmSync(this.tempDir, { recursive: true, force: true })
      } catch (error) {
        failures.push(`temp cleanup (${this.tempDir}): ${error.message}`)
      }
    }
    this.sandbox = undefined
    this.launcher = undefined
    this.job = undefined
    return { disposed: true, failures }
  }
}

/**
 * 选择可用的 PowerShell 解释器。
 *
 * `[实测]` 缺陷 7：本机**没有安装** `pwsh`（PowerShell 7）；只有 Windows PowerShell 5.1。
 * 早先自检与审计都硬编码 `pwsh`，于是即使 PATHEXT 解析修好了，仍然
 * `CreateProcessAsUserW failed (Win32 2)`。命令名必须**探测后再用**，
 * 不能假定某个 shell 存在（与手册第 5 章"能力探测 = 真实执行路径验证"同一原则）。
 *
 * 两者的 `-NoLogo -NonInteractive -NoProfile -Command` 参数兼容，脚本可通用。
 */
let cachedShell
export function resolvePowerShell(env = process.env, cwd = process.cwd()) {
  if (cachedShell) return cachedShell
  const candidates = ['pwsh', 'powershell']
  const failures = []
  for (const candidate of candidates) {
    try {
      const resolved = resolveExecutable(candidate, { cwd, env })
      cachedShell = { command: resolved, name: candidate }
      return cachedShell
    } catch (error) {
      failures.push(`${candidate}: ${error.message}`)
    }
  }
  const error = fail('ENOENT', `no PowerShell interpreter found (tried ${candidates.join(', ')})`)
  error.failures = failures
  throw error
}

/**
 * 把命令解析成绝对路径（模块级实现；类上有同名的静态转发方法）。
 *
 * `CreateProcessAsUserW` 不会补 `PATHEXT`，也不查 App Paths 注册表，
 * 因此裸命令名必然以 Win32 2（ERROR_FILE_NOT_FOUND）失败 —— 这是实测缺陷 6。
 */
export function resolveExecutable(command, options = {}) {
  if (typeof command !== 'string' || command.length === 0) {
    throw fail('ENOENT', 'command must be a non-empty string')
  }
  const cwd = options.cwd
  const env = options.env ?? process.env

  if (isAbsolute(command)) {
    if (existsSync(command)) return command
    const error = fail('ENOENT', `executable not found: ${command}`)
    error.searched = [command]
    throw error
  }

  const pathExt = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  // 末尾补一个空扩展名，这样"命令本身已带扩展名"或"PATH 里有精确文件名"也能命中
  const extensions = [...pathExt, '']
  const hasSeparator = /[\\/]/.test(command)
  const pathDirs = (env.PATH || '')
    .split(';')
    .map((dir) => dir.trim())
    .filter(Boolean)
  const searchDirs = hasSeparator ? [cwd, ...pathDirs] : [...(cwd ? [cwd] : []), ...pathDirs]

  const tried = []
  for (const dir of searchDirs) {
    if (!dir) continue
    const base = join(dir, command)
    for (const ext of extensions) {
      // 只对""（精确名）跳过追加；其余一律真追加，不要因为"基名已以该扩展名结尾"
      // 就提前返回 —— 那会在大小写不同的盘上给出 tool.EXE 这类非预期路径。
      const candidate = ext === '' ? base : base + ext
      tried.push(candidate)
      if (existsSync(candidate)) return candidate
    }
  }
  const error = fail('ENOENT', `cannot resolve executable "${command}"`)
  error.searched = tried.slice(0, 40)
  error.pathExt = pathExt
  throw error
}

/**
 * ── 缺陷③（Fix A）：运行前"降级强制"闸门的判据词汇 ───────────────────────────
 *
 * 这四类检查**不是**可接受的残余，而是"招牌保证还成不成立"的实测判据。
 * 它们由 `selfTest()` / `selfTestTransparent()` **在沙箱内部真实发起**（同一个身份），
 * 因此可以直接当作"即将运行的那个身份能不能写暂存根"的证据。
 */
export const STAGING_WRITE_CHECK_NAMES = Object.freeze([
  'inside-staging-write-allowed',
  'outside-write-staged-not-real',
  'transparent-capability-canary',
  'no-dsh-sandbox-trace',
])

export function isStagingWriteCheckName(name) {
  return STAGING_WRITE_CHECK_NAMES.includes(name)
}

/**
 * 两条运行通道**各自必须**测到项的清单。
 *
 * 为什么分开写死而不是取交集：受限令牌/AppContainer 通道的招牌保证是
 * "沙箱内能写暂存根"（`inside-staging-write-allowed`），
 * 去令牌化（shim）通道的招牌保证是"区外写被重定向进暂存且真实磁盘不变"
 * （`outside-write-staged-not-real`）。用错通道的清单会把"没测"读成"通过"。
 */
export const SANDBOX_STAGING_WRITE_CHECKS = Object.freeze(['inside-staging-write-allowed'])
export const SHIM_STAGING_WRITE_CHECKS = Object.freeze([
  'transparent-capability-canary',
  'outside-write-staged-not-real',
  'no-dsh-sandbox-trace',
])

// ═════════════════════════════════════════════════════════════════════════════
// BUG-4：「暂存不可信」闸门的判定必须是**命令级**的，绝不是会话级闩锁
// ═════════════════════════════════════════════════════════════════════════════
//
// 现场（`session-97132a99` CH-05 / `session-d6e30323`）：`init()` 的沙箱内自检探针有
// 四种瞬时失败形态（`0xC0000005` / `0xE0434352` / exit 127 / >25s 挂死）。只要**一次**
// 探针瞬时失败，`initReport` 就被钉在 fail 上，随后**同一门文本**对整段会话里的每一条
// 命令一律拒绝 —— 连 `Write-Output "x"` 这种只读命令都拒，持续数分钟，且没有任何
// 解除提示（同一段文本还配了三种互不相同的退出码 3762504530 / 2 / 127）。
//
// 闸门真正要回答的是**这一条命令**的问题："这条命令有没有可能写？"
// 而不是"这个会话的暂存根此刻能不能写？"。因此判定三分：
//   · 正向证明"只读/无副作用" ⇒ 不拦（只读命令没有可被静默降级的写入面）；
//   · 正向证明"有写" ⇒ 拒绝（fail-closed 方向不变）；
//   · 判不出来 ⇒ 也拒绝，但**必须说清为什么判不出来**（绝不把"不知道"说成"策略拒绝"）。
export const COMMAND_RISK = Object.freeze({
  READ_ONLY: 'read-only',
  WRITE: 'write-capable',
  INDETERMINATE: 'indeterminate',
})

/** PowerShell 动词前缀里"写/变"的那一半（未知 Verb-Noun 落到这里就按有风险处理） */
const WRITE_VERB_PREFIXES = Object.freeze([
  'set', 'new', 'remove', 'add', 'copy', 'move', 'rename', 'clear', 'out', 'export', 'invoke',
  'start', 'stop', 'install', 'uninstall', 'register', 'unregister', 'update', 'enable', 'disable',
  'restore', 'backup', 'save', 'publish', 'send', 'receive', 'mount', 'dismount', 'lock', 'unlock',
  'grant', 'revoke', 'block', 'unblock', 'reset', 'restart', 'resume', 'suspend', 'submit', 'undo',
  'switch', 'open', 'close', 'format', 'optimize', 'repair', 'kill', 'redo', 'rollback', 'commit',
])

/** PowerShell 动词前缀里"读/无副作用"的那一半（可以落在 READ_ONLY_VERBS 里的那些） */
const READ_ONLY_VERB_PREFIXES = Object.freeze([
  'get', 'read', 'test', 'select', 'where', 'foreach', 'sort', 'measure', 'format', 'convertto',
  'convertfrom', 'join', 'split', 'resolve', 'compare', 'group', 'show', 'find', 'search', 'trace',
  'debug', 'watch', 'wait', 'write',
])

/** 一个 token 是否"看起来是一个 Verb-Noun 动词" */
const PS_VERB_NOUN_RE = /^([a-z]+)-([a-z][a-z0-9]*)$/

/**
 * 只有"动词前缀是**真实 PowerShell 动词**"的 token 才算 Verb-Noun。
 *
 * 为什么必须这么窄：`still-alive` / `my-get-thing` 这类普通连字符单词也满足
 * `^[a-z]+-[a-z]+$`，若一律当动词就会把 `cmd /c echo still-alive` 这种纯只读命令
 * 读成"判不出来"。判据宁可窄：窄了只是"少认一个动词"（落到写判据/判不出来），
 * 宽了会把只读命令误拒 —— 那正是 BUG-4 要消灭的形态。
 */
const KNOWN_PS_VERB_PREFIXES = new Set([...WRITE_VERB_PREFIXES, ...READ_ONLY_VERB_PREFIXES])

/** 裸动词 / 别名（无 `-Noun`），全部**只读**；表里没有的裸词一律不算动词。 */
export const READ_ONLY_BARE_VERBS = Object.freeze([
  'echo', 'write', 'dir', 'ls', 'cat', 'type', 'pwd', 'whoami', 'hostname', 'ver', 'tasklist',
  'findstr', 'find', 'more', 'tree', 'fc', 'comp', 'cd', 'chdir', 'pushd', 'popd', 'cls', 'clear',
  'sleep', 'sls', 'select', 'where', 'foreach', 'sort', 'measure', 'compare', 'diff', 'gci', 'gi',
  'gc', 'gl', 'gps', 'ps', 'gcm', 'gm', 'gv', 'gdr', 'gsv', 'gp', 'gal', 'gh', 'ft', 'fl', 'fw',
  'oh', 'gcb', 'gjb', 'gwmi', 'gcim', 'curl', 'wget', 'ipconfig', 'systeminfo', 'where.exe',
])
// 注：`curl`/`wget` 出现在这里是因为它们**默认只写 stdout**；带 `-o`/`-O` 的写法会被
//     WRITE_OPERATORS 的 `-o`/`-O` 判据拦下（见下），不会被这条误放行。

/** 已知只读可执行文件（裸名字，小写） */
export const READ_ONLY_EXES = Object.freeze([
  'whoami', 'whoami.exe', 'hostname', 'hostname.exe', 'ver', 'ver.exe', 'tasklist', 'tasklist.exe',
  'findstr', 'findstr.exe', 'find', 'find.exe', 'ipconfig', 'ipconfig.exe', 'systeminfo',
  'systeminfo.exe', 'where', 'where.exe',
])

/**
 * 只读 Verb-Noun / 别名（小写）。判定是**正向**的：全部动词都落在这张表里才敢说
 * "无副作用"；表外的 Verb-Noun 一律不会被误当只读（读前缀 ⇒ 判不出来，写前缀 ⇒ 有风险）。
 */
export const READ_ONLY_VERBS = Object.freeze([
  // ── 读/查询 ───────────────────────────────────────────────────────────────
  'get-childitem', 'get-item', 'get-content', 'get-location', 'get-date', 'get-process',
  'get-command', 'get-member', 'get-variable', 'get-host', 'get-psdrive', 'get-help', 'get-module',
  'get-service', 'get-itemproperty', 'get-acl', 'get-filehash', 'get-ciminstance', 'get-wmiobject',
  'get-eventlog', 'get-winevent', 'get-counter', 'get-alias', 'get-history', 'get-job',
  'get-runspace', 'get-type', 'get-random', 'get-unique', 'get-culture', 'get-uiculture',
  'get-timezone', 'get-computerinfo', 'get-volume', 'get-disk', 'get-partition', 'get-netadapter',
  'get-netipaddress', 'get-netipconfiguration', 'get-netfirewallprofile', 'get-netfirewallrule',
  'get-nettcpconnection', 'get-smbshare', 'get-localuser', 'get-localgroup', 'get-hotfix',
  'get-package', 'get-childitem', 'get-filehash', 'get-psprovider', 'get-verb', 'get-process',
  'test-path', 'test-connection', 'test-netconnection', 'test-modulemanifest', 'test-json',
  'resolve-path', 'join-path', 'split-path', 'read-host',
  // ── 投影/格式化（无副作用） ────────────────────────────────────────────────
  'select-object', 'where-object', 'foreach-object', 'sort-object', 'measure-object',
  'format-table', 'format-list', 'format-wide', 'format-custom', 'out-string', 'out-host',
  'out-null', 'out-gridview', 'convertto-json', 'convertfrom-json', 'convertto-csv',
  'convertto-xml', 'convertto-html', 'write-output', 'write-host', 'write-verbose', 'write-debug',
  'write-information', 'write-warning', 'write-progress', 'compare-object', 'group-object',
  'start-sleep', 'wait-event', 'wait-process', 'select-string',
  // ── 只读别名 ──────────────────────────────────────────────────────────────
  'gci', 'gi', 'gc', 'gl', 'gps', 'gcm', 'gm', 'gv', 'gdr', 'gsv', 'gp', 'gal', 'gh', 'gcb', 'gjb',
  'gwmi', 'gcim', 'ft', 'fl', 'fw', 'oh', 'select', 'where', 'foreach', 'sort', 'measure',
  'compare', 'diff', 'sls', 'sleep', 'echo', 'write',
  ...READ_ONLY_BARE_VERBS,
  ...READ_ONLY_EXES,
])

/** 写类 Verb-Noun / 别名 / 可执行文件（小写）。命中任意一个 ⇒ 有风险。 */
export const WRITE_VERBS = Object.freeze([
  // ── 文件/内容 ─────────────────────────────────────────────────────────────
  'set-content', 'add-content', 'clear-content', 'new-item', 'remove-item', 'move-item',
  'copy-item', 'rename-item', 'out-file', 'tee-object', 'export-csv', 'export-clixml',
  'expand-archive', 'compress-archive', 'set-item', 'set-itemproperty', 'new-itemproperty',
  'remove-itemproperty', 'clear-item', 'set-acl', 'new-psdrive', 'remove-psdrive',
  'new-variable', 'set-variable', 'remove-variable', 'clear-variable', 'new-alias', 'set-alias',
  'remove-alias', 'import-module', 'install-module', 'save-module', 'install-package',
  'install-script', 'save-script', 'update-module', 'register-scheduledtask', 'unregister-scheduledtask',
  'new-scheduledtask', 'set-scheduledtask', 'start-scheduledtask', 'new-service', 'set-service',
  'write-eventlog', 'clear-eventlog',
  'remove-service', 'start-service', 'stop-service', 'restart-service', 'suspend-service',
  'resume-service', 'new-webserviceproxy', 'invoke-webrequest', 'invoke-restmethod',
  'invoke-expression', 'start-process', 'start-job', 'stop-process', 'stop-job', 'remove-job',
  'debug-process', 'new-localuser', 'remove-localuser', 'set-localuser', 'add-localgroupmember',
  'new-netfirewallrule', 'remove-netfirewallrule', 'set-netfirewallprofile', 'new-smbshare',
  'remove-smbshare', 'mount-diskimage', 'dismount-diskimage', 'format-volume', 'set-volume',
  'new-partition', 'clear-disk', 'initialize-disk', 'set-executionpolicy', 'restore-computer',
  'checkpoint-computer', 'enable-computerrestore', 'disable-computerrestore', 'new-selfsignedcertificate',
  'export-pfxcertificate', 'import-pfxcertificate',
  // ── 写类别名 / 内建 ───────────────────────────────────────────────────────
  'sc', 'ac', 'clc', 'ni', 'ri', 'rm', 'del', 'erase', 'rmdir', 'rd', 'mi', 'move', 'mv', 'cpi',
  'cp', 'copy', 'rni', 'ren', 'rename', 'si', 'sp', 'spps', 'kill', 'taskkill', 'mkdir', 'md',
  'touch', 'tee', 'out', 'sv', 'rv', 'nv', 'sal', 'ipal', 'iex', 'iwr', 'irm', 'saps', 'sa',
  'start', 'npx', 'npm', 'pnpm', 'yarn', 'pip', 'pip3', 'choco', 'winget', 'install', 'reg',
  'reg.exe', 'sc.exe', 'net', 'net.exe', 'schtasks', 'schtasks.exe', 'takeown', 'icacls',
  'cacls', 'attrib', 'robocopy', 'xcopy', 'format', 'diskpart', 'shutdown', 'bcdedit', 'wusa',
  'msiexec', 'dd', 'truncate', 'chmod', 'chown', 'ln',
])

/** 解释器：它自己的风险由**载荷**的动词决定（`cmd /c echo x` 只读；`cmd /c del x` 有风险） */
export const INTERPRETER_COMMANDS = Object.freeze([
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh', 'pwsh.exe', 'wsl', 'wsl.exe',
  'bash', 'bash.exe', 'sh', 'sh.exe',
])

/** `git` 只读子命令（窄集合：只收"确定不改工作区/不写仓库"的那些） */
export const GIT_READ_ONLY_SUBCOMMANDS = Object.freeze([
  'status', 'log', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree', 'describe', 'blame',
  'shortlog', 'cat-file', 'symbolic-ref', 'whatchanged', 'grep',
])

/** 写入型操作符 / 写法（刻意保守：宁可把可疑写法读成"有风险"） */
export const WRITE_OPERATORS = Object.freeze([
  // `>`（含 `>>`）落盘；但 `2>&1` / `1>&2` 这类**只重定向控制台**的写法不算写文件。
  { label: 'file redirection', pattern: /(?:^|[^>])>(?!&)/ },
  { label: 'pipe-to-file-cmdlet', pattern: /\|\s*(out-file|set-content|add-content|export-csv|export-clixml|tee-object|tee)\b/i },
  { label: 'out-file', pattern: /\bout-file\b/i },
  { label: 'tee', pattern: /\btee(-object)?\b/i },
  { label: 'curl-download-flag', pattern: /(^|\s)-[oO]\b/ },
  { label: 'git-mutating-subcommand', pattern: /\bgit(\.exe)?\s+(commit|push|pull|checkout|switch|reset|clean|apply|add|rm|mv|stash|merge|rebase|tag|init|clone|fetch)\b/i },
])

/** 只读判定**读不懂**载荷的写法：一律落到 indeterminate，绝不猜。 */
export const OPAQUE_PAYLOAD_OPERATORS = Object.freeze([
  { label: 'pwsh -EncodedCommand（载荷是 base64，读不懂）', pattern: /-(enc|encodedcommand)\b/i },
  { label: 'pwsh -File（载荷在文件里，本次判定看不到）', pattern: /(^|\s)-file\s+\S+/i },
])

function tokenizeCommandLine(text) {
  const out = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = re.exec(String(text ?? ''))) !== null) {
    out.push(match[1] ?? match[2] ?? match[3])
  }
  return out
}

export { tokenizeCommandLine }

function baseNameLower(token) {
  const text = String(token ?? '').toLowerCase()
  const cut = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
  return cut >= 0 ? text.slice(cut + 1) : text
}

/**
 * 单命令级风险判定（纯函数，离线可测）。
 *
 * @param {string} command      可执行文件或 shell 内建动词
 * @param {string[]} [args]     参数（`-Command "<脚本>"` 的脚本正文也在里面）
 * @param {object} [options]    `{ assumeInterpreterPayload: boolean }`
 * @returns {{risk:'read-only'|'write-capable'|'indeterminate', reasons:string[], evidence:object}}
 */
export function classifyCommandRisk(command, args = [], options = {}) {
  const argv = [command, ...(Array.isArray(args) ? args : [])].filter((v) => v !== undefined && v !== null)
  const joined = argv.map((v) => String(v)).join(' ')
  const tokens = tokenizeCommandLine(joined)
  const lowerTokens = tokens.map((t) => t.toLowerCase())
  const reasons = []

  // ① 写入型操作符（重定向 / 落盘管道 / 下载落盘 / git 变更子命令）
  for (const operator of WRITE_OPERATORS) {
    const hit = operator.pattern.exec(joined)
    if (hit) {
      reasons.push(`写入型操作符「${operator.label}」命中：${JSON.stringify(hit[0]).slice(0, 40)}`)
    }
  }
  // ② 写类动词 / 别名
  const writeHits = lowerTokens.filter((t) => WRITE_VERBS.includes(t))
  if (writeHits.length > 0) reasons.push(`写类动词命中：${[...new Set(writeHits)].join(', ')}`)
  // ③ 未知 Verb-Noun：写前缀 ⇒ 有风险；读前缀但不在只读表里 ⇒ 判不出来
  //    （前缀不是真实 PowerShell 动词的连字符单词只是普通参数，比如 `still-alive`）
  const unknownVerbNoun = []
  let readOnlyHitCount = 0
  for (const lower of lowerTokens) {
    const verbNoun = PS_VERB_NOUN_RE.exec(lower)
    if (verbNoun && KNOWN_PS_VERB_PREFIXES.has(verbNoun[1])) {
      if (READ_ONLY_VERBS.includes(lower)) {
        readOnlyHitCount += 1
        continue
      }
      if (WRITE_VERB_PREFIXES.includes(verbNoun[1])) {
        reasons.push(`写类 Verb-Noun（未在只读表内）：${lower}`)
        continue
      }
      unknownVerbNoun.push(lower)
      continue
    }
    if (READ_ONLY_BARE_VERBS.includes(lower)) readOnlyHitCount += 1
  }
  if (reasons.length > 0) {
    return {
      risk: COMMAND_RISK.WRITE,
      reasons,
      evidence: { command: String(command ?? ''), args: Array.isArray(args) ? args.length : 0, tokens: lowerTokens },
    }
  }
  if (unknownVerbNoun.length > 0) {
    return {
      risk: COMMAND_RISK.INDETERMINATE,
      reasons: [
        `无法判定副作用（cannot determine side effects）：出现未知 Verb-Noun ${[...new Set(unknownVerbNoun)].join(', ')}；` +
          `它既不在只读表里，也不在写表里 —— 判不出来时拒绝，且如实说明判不出来的原因`,
      ],
      evidence: { command: String(command ?? ''), tokens: lowerTokens },
    }
  }
  // ③b 载荷读不懂（base64 / 脚本文件）⇒ indeterminate，绝不按只读放行
  const opaque = OPAQUE_PAYLOAD_OPERATORS.filter((entry) => entry.pattern.test(joined))
  if (opaque.length > 0) {
    return {
      risk: COMMAND_RISK.INDETERMINATE,
      reasons: opaque.map((entry) => `无法判定副作用：${entry.label}`),
      evidence: { command: String(command ?? ''), opaque: opaque.map((e) => e.label) },
    }
  }
  // ④ 首个 token 是不是一个"认识"的程序
  const head = baseNameLower(tokens[0] ?? command ?? '')
  const headIsInterpreter = INTERPRETER_COMMANDS.includes(head)
  const headIsGit = head === 'git' || head === 'git.exe'
  const headKnown =
    headIsInterpreter ||
    headIsGit ||
    READ_ONLY_VERBS.includes(head) ||
    READ_ONLY_EXES.includes(head) ||
    WRITE_VERBS.includes(head)
  if (!headKnown) {
    return {
      risk: COMMAND_RISK.INDETERMINATE,
      reasons: [
        `无法判定副作用：可执行文件「${tokens[0] ?? command}」不在已知的只读/写类清单里，` +
          `因此无法证明它不会写 —— 判不出来时拒绝，且如实说明判不出来的原因`,
      ],
      evidence: { command: String(command ?? ''), head, tokens: lowerTokens },
    }
  }
  if (headIsGit) {
    const sub = lowerTokens.slice(1).find((t) => !t.startsWith('-'))
    if (sub !== undefined && GIT_READ_ONLY_SUBCOMMANDS.includes(sub)) {
      return { risk: COMMAND_RISK.READ_ONLY, reasons: [`git 只读子命令：${sub}`], evidence: { head, sub } }
    }
    return {
      risk: COMMAND_RISK.INDETERMINATE,
      reasons: [
        `无法判定副作用：git 子命令「${sub ?? '(none)'}」不在只读子命令清单里（` +
          `${GIT_READ_ONLY_SUBCOMMANDS.join('/')}）`,
      ],
      evidence: { head, sub },
    }
  }
  if (readOnlyHitCount === 0) {
    return {
      risk: COMMAND_RISK.INDETERMINATE,
      reasons: [
        `无法判定副作用：「${command}」这次调用里没有任何已登记的只读动词（可能是 -File 脚本、` +
          `交互式解释器、或纯参数），因此无法证明它不会写`,
      ],
      evidence: { command: String(command ?? ''), tokens: lowerTokens, assumeInterpreterPayload: options.assumeInterpreterPayload === true },
    }
  }
  return {
    risk: COMMAND_RISK.READ_ONLY,
    reasons: [`全部动词都在只读表内（${readOnlyHitCount} 个），且没有任何写入型操作符${headIsInterpreter ? `；解释器载荷已按动词逐条核对` : ''}`],
    evidence: { command: String(command ?? ''), head, readOnlyHitCount, tokens: lowerTokens },
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// BUG-3：失根（staging root lost）必须与"策略拒绝"可区分，且可查询
// ═════════════════════════════════════════════════════════════════════════════
//
// 现场（`session-d6e30323` CRITICAL / `session-73feedf7` ENV-01）：运行中途
// `WINSTAGE_STAGE_ROOT` 变空、短时间内冒出多个新会话、**所有写入全部失败、之前已暂存的
// 工作消失**，而报文只有一句 `Access is denied` —— 与"策略拒绝"完全无法区分。
// 真实磁盘保持干净（fail-closed 正确），但 agent 在误导性报错后面静默丢掉一切。
//
// 因此：失根走**独立错误码 + 独立分类 + 一句话结论 + 建议动作**，
// 并把"本次会话是否曾发生失根 / 档位漂移"记进可查询状态（`stagingRootDiagnostics()`）。
/**
 * 读"暂存根"的环境契约。现场（BUG-3）里 `WINSTAGE_STAGE_ROOT` 会在运行中途变空，
 * 因此这里返回 `{present, value}` 两件事而不是一个字符串：**"没设置"与"设成了空"是
 * 两个不同的故障**，后者才是失根。
 */
export function readStageRootEnv(env = process.env) {
  const names = ['WINSTAGE_STAGE_ROOT', 'DSH_STAGE_ROOT']
  for (const name of names) {
    if (env && Object.prototype.hasOwnProperty.call(env, name)) {
      const value = env[name]
      return { name, present: true, value: value === undefined || value === null ? '' : String(value) }
    }
  }
  return { name: names[0], present: false, value: undefined }
}

export const STAGING_ROOT_CODES = Object.freeze({
  OK: 'STAGING_ROOT_OK',
  LOST: 'STAGING_ROOT_LOST',
  VANISHED: 'STAGING_ROOT_VANISHED',
  ENV_BLANKED: 'STAGING_ROOT_ENV_BLANKED',
  ABSENT: 'STAGING_ROOT_ABSENT',
  NOT_A_DIRECTORY: 'STAGING_ROOT_NOT_A_DIRECTORY',
})

/**
 * 失根判定（纯函数）。
 *
 * @param {object} state
 *   `{ configured, configuredWasSet, envStageRoot, envWasSet, previouslyExisted, exists, isDirectory, where }`
 * @returns {{status:'ok'|'lost', code:string, category:'ok'|'root-loss', summary:string,
 *            action:string, retryable:boolean, policyDenial:boolean, evidence:object}}
 */
export function classifyStagingRootState(state = {}) {
  const evidence = {
    where: state.where,
    configured: state.configured,
    configuredWasSet: state.configuredWasSet === true,
    envStageRoot: state.envStageRoot,
    envWasSet: state.envWasSet === true,
    previouslyExisted: state.previouslyExisted === true,
    exists: state.exists === true,
    isDirectory: state.isDirectory === true,
  }
  const lost = (code, summary, action) => ({
    status: 'lost',
    code,
    category: 'root-loss',
    // 关键：这一位给下游机检用 —— "失根"**不是**策略拒绝
    policyDenial: false,
    distinctFromPolicyDenial: true,
    retryable: true,
    summary,
    action,
    evidence,
  })
  if (evidence.envWasSet && (evidence.envStageRoot === undefined || String(evidence.envStageRoot).trim() === '')) {
    return lost(
      STAGING_ROOT_CODES.ENV_BLANKED,
      '本次会话中 WINSTAGE_STAGE_ROOT 变成了空值 —— 这是**失根**（暂存根失联），不是策略拒绝；' +
        '此后所有写入都会失败，且此前已暂存的工作可能已随旧会话消失。',
      '重新执行 `dsh-stage init --workspace <dir>` 重建暂存根，再重跑刚才那条命令；不要把它当成"权限不足"重试。',
    )
  }
  if (evidence.configuredWasSet && (evidence.configured === undefined || evidence.configured === null || String(evidence.configured).trim() === '')) {
    return lost(
      STAGING_ROOT_CODES.LOST,
      '暂存根从"有值"变成了"空" —— 这是**失根**（暂存根失联），不是策略拒绝（NOT a policy denial）。',
      '停止在当前会话里继续写入；用 `dsh-stage init --workspace <dir>` 重建暂存根，并核对已暂存的工作是否还在。',
    )
  }
  if (evidence.configuredWasSet && evidence.exists !== true) {
    return lost(
      STAGING_ROOT_CODES.VANISHED,
      `暂存根 ${evidence.configured} 在本次会话中**已经失联**（此前存在，现在不存在）—— 这是**失根**，不是策略拒绝。`,
      '用 `dsh-stage init --workspace <dir>` 重建暂存根；`Get-ChildItem <dir>` 确认目录还在，再重跑命令。',
    )
  }
  if (evidence.exists === true && evidence.isDirectory !== true) {
    return lost(
      STAGING_ROOT_CODES.NOT_A_DIRECTORY,
      `暂存根 ${evidence.configured} 存在但不是目录 —— 暂存层无法工作，这是**沙箱自身故障**，不是策略拒绝。`,
      '检查该路径是否被同名文件占用，改为一个真实目录后重新 `dsh-stage init`。',
    )
  }
  if (evidence.exists !== true) {
    return lost(
      STAGING_ROOT_CODES.ABSENT,
      `暂存根 ${evidence.configured ?? '(未设置)'} 不存在，且本次会话没有它曾存在的记录 —— 这是**配置/初始化缺失**，不是策略拒绝。`,
      '先 `dsh-stage init --workspace <dir>` 创建暂存根，再重跑命令。',
    )
  }
  return {
    status: 'ok',
    code: STAGING_ROOT_CODES.OK,
    category: 'ok',
    policyDenial: false,
    distinctFromPolicyDenial: false,
    retryable: false,
    summary: `暂存根就绪：${evidence.configured}`,
    action: 'none',
    evidence,
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// BUG-9：启动失败分类（把 NTSTATUS 归一成可读分类，并原样带出真实值）
// ═════════════════════════════════════════════════════════════════════════════
//
// 现场（`session-16192a87` FS-07）：`CreateNoWindow=$true` 时子进程一律
// `exit=0xC0000142`（STATUS_DLL_INIT_FAILED）；`Start-Process` 抛 "Access is denied"
// 而子进程其实**已经成功运行**；另有 `0x8007054F System.Data.dll`、
// `spawn UNKNOWN(127)` 等间歇启动失败。全部都被压成一句无法归因的文本。
export const STARTUP_FAILURE_CATEGORIES = Object.freeze({
  DLL_INIT_FAILED: 'dll-init-failed',
  INTERNAL_ERROR: 'internal-error',
  SPAWN_UNKNOWN: 'spawn-unknown',
  CLR_EXCEPTION: 'clr-exception',
  ACCESS_VIOLATION: 'access-violation',
  DLL_NOT_FOUND: 'dll-not-found',
  STACK_BUFFER_OVERRUN: 'stack-buffer-overrun',
  ACCESS_DENIED: 'access-denied',
  FILE_NOT_FOUND: 'file-not-found',
  NO_CREDENTIALS: 'no-credentials',
  ALREADY_EXISTS: 'already-exists',
  NONE: 'none',
})

// ═════════════════════════════════════════════════════════════════════════════
// WP6：**错误语义分层**（策略拒绝 / 环境故障 / 普通失败）—— 三分类必须互不混淆
// ═════════════════════════════════════════════════════════════════════════════
//
// ── 为什么必须分层（本仓库反复踩到的形态）──────────────────────────────────────
// ① **策略拒绝**（本就不允许的操作：越界写、提权、敏感路径写…）与
// ② **环境故障**（执行载体起不来、暂存根丢失、依赖装配失败…）在旧口径下会共用同一句
//    `Access is denied` ⇒ 用户/AI 只能猜。猜错的代价是真实的：
//    把"环境坏了、重试就好"读成"你的操作不被允许"，或者反过来把"策略拒绝"读成"重试"。
// ③ **故障伪装成防护**：`SEC_E_NO_CREDENTIALS`（Schannel 取不到凭据）在受限令牌下必然出现，
//    它**不是安全拦截**，而是**令牌能力缺失**；`0xC0000142`（STATUS_DLL_INIT_FAILED）、
//    `0x8007054F`、`0x800700B7` 同理 —— 全是**载体/依赖**问题，不是"你被拦了"。
//
// ── 透明性契约（与 `dsh-plugin/shell-executor.mjs` 同一口径，硬要求）────────────
// 面向 AI 的文案里**零沙箱痕迹**：不出现 `沙箱` / `暂存` / `stage` / `staging` /
// `替代路径` / `sandbox` / `overlay` 任何字样，也不提供"替代路径"。
// 沙箱细节只出现在**用户侧**（`/winstage status`、面板、error 级日志、本文件的诊断字段）。
export const FAILURE_SEMANTICS = Object.freeze({
  /** ① 本就不允许的操作（越界写 / 提权 / 敏感路径写 / 明文外泄密钥形态） */
  POLICY: 'policy',
  /** ② 环境故障：可重试；**不得**与策略拒绝共用文案 */
  ENVIRONMENT: 'environment',
  /** ③ 普通失败：命令自己失败，或"到底跑没跑"无法判定 */
  COMMAND: 'command',
})

/**
 * 三分类的**机读码表**：每类一个稳定前缀，且**互不相同**（可机检）。
 * `policy` 族只用于"这个操作不被允许"；`environment` 族只用于"环境坏了、可重试"。
 * ⚠ 一张表里两族的码**不得**重叠 —— 这正是本任务要消灭的混淆面。
 *
 * 键是**分类字面值**（`'policy'` / `'environment'` / `'command'`，`'policy' in 表` 可查），
 * 另附 `POLICY` / `ENVIRONMENT` / `COMMAND` 三个大写别名，便于调用方按类取码。
 * （`FAILURE_CATEGORY_CODES.POLICY` 这种写法必须真的能取到值 —— 曾经漏了别名，
 *  于是判定虽然在、**取码却是 undefined**，是本轮实测抓到的缺陷。）
 */
export const FAILURE_CODE_POLICY = 'DENIED_ACTION_NOT_PERMITTED'
export const FAILURE_CODE_ENVIRONMENT = 'ENV_FAULT_RETRYABLE'
export const FAILURE_CODE_COMMAND = 'COMMAND_FAILED'

export const FAILURE_CODE_FAMILY = Object.freeze({
  [FAILURE_SEMANTICS.POLICY]: [FAILURE_CODE_POLICY],
  [FAILURE_SEMANTICS.ENVIRONMENT]: [FAILURE_CODE_ENVIRONMENT],
  [FAILURE_SEMANTICS.COMMAND]: [FAILURE_CODE_COMMAND],
})

/** 每一类的机读码（三类互不相同；断言按这三个常量比对） */
export const FAILURE_CATEGORY_CODES = Object.freeze({
  [FAILURE_SEMANTICS.POLICY]: FAILURE_CODE_POLICY,
  [FAILURE_SEMANTICS.ENVIRONMENT]: FAILURE_CODE_ENVIRONMENT,
  [FAILURE_SEMANTICS.COMMAND]: FAILURE_CODE_COMMAND,
  POLICY: FAILURE_CODE_POLICY,
  ENVIRONMENT: FAILURE_CODE_ENVIRONMENT,
  COMMAND: FAILURE_CODE_COMMAND,
})

/** 每一类的**中性一句话**（不含沙箱措辞；`retryable` 只有环境故障为 true） */
export const FAILURE_CATEGORY_TEXT = Object.freeze({
  [FAILURE_SEMANTICS.POLICY]: {
    classification: 'not-permitted',
    message: '请求的操作不被允许（权限/策略判定），本次未执行。',
    retryable: false,
  },
  [FAILURE_SEMANTICS.ENVIRONMENT]: {
    classification: 'environment-fault',
    message: '执行环境故障，命令没有运行；这是可重试的环境问题。',
    retryable: true,
  },
  [FAILURE_SEMANTICS.COMMAND]: {
    classification: 'command-failure',
    message: '命令失败。',
    retryable: false,
  },
})

/**
 * **面向 AI 的透明性禁用词**（大小写不敏感）。`transparencyViolations()` 用它对
 * "模型可见文案"做机检；`tests`/`_r3` 的断言复用同一份清单，避免两处口径漂移。
 *
 * ⚠ `stage` 是**子串**匹配：`staged` / `staging` / `stage-root` 一并命中（这正是要的效果）。
 * 因此本文件里所有"给 AI 看"的句子都不能含这些子串 —— 命中即视为透明性破坏。
 */
export const TRANSPARENCY_FORBIDDEN_TOKENS = Object.freeze([
  '沙箱',
  '暂存',
  '替代路径',
  'sandbox',
  'staging',
  // ⚠ `stage` 单独列出（不要以为 `staging` 能顺带覆盖它）：按**子串**匹配，
  //   因此 `staged` / `stage-root` / `overlay-stage` 一并命中。
  //   代价必须如实声明：英文 `execute` / `message` 里也含 `stage` 子串 ⇒
  //   模型可见文案里**不要**用这些英文词（中文文案不受影响）。
  'stage',
  'overlay',
])

/**
 * 机检"这段文案是否泄漏了沙箱机制"（纯函数）。返回命中的 token（空数组 = 干净）。
 * @param {string} text 模型可见文案
 */
export function transparencyViolations(text) {
  const value = String(text ?? '').toLowerCase()
  return TRANSPARENCY_FORBIDDEN_TOKENS.filter((token) => value.includes(token.toLowerCase()))
}

/** 该分类是否可重试（环境故障 true；策略拒绝/普通失败 false） */
export function isRetryableCategory(category) {
  return category === FAILURE_SEMANTICS.ENVIRONMENT
}

/** 分类字面值机器可读：来自 `FAILURE_CATEGORY_CODES` 的键集合 */
export function isKnownFailureCategory(category) {
  return Object.prototype.hasOwnProperty.call(FAILURE_CATEGORY_CODES, String(category))
}

/**
 * 把任意失败观察归一成**三层语义**（纯函数，离线可测）。
 *
 * 判定顺序（先具体后一般，避免"策略拒绝"吃掉"环境故障"）：
 *   ① 环境故障证据（失根 / 执行载体不可用 / 启动期 NTSTATUS）⇒ `environment`；
 *   ② 显式策略信号（越界写、提权、敏感路径、明文密钥形态）⇒ `policy`；
 *   ③ 其余 ⇒ `command`（含"报 Access is denied 但子进程其实跑过"⇒ 判定不确定，
 *      由 `indeterminate:true` 如实标注，**不给"命令未执行"这种与事实相反的结论**）。
 *
 * @returns {{
 *   category: string, code: string, classification: string, message: string,
 *   retryable: boolean, indeterminate: boolean, evidence: string[],
 *   technicalCode: string|undefined, violations: string[]
 * }}
 */
export function classifyFailureSemantics(input = {}) {
  const text = [input.code, input.errorCode, input.message, input.stderr, input.stdout, input.detail]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => String(part))
    .join('\n')
  const code = input.code ?? input.errorCode
  const evidence = []

  // ── ⓪ 上游给出的**显式分类提示**优先（例如 `shell-executor` 的 fail-closed 口径表）──
  //   为什么必须有这条：那些失败只有一个技术码、没有可读散文，靠文本正则去猜会把
  //   "环境故障"猜成"策略拒绝"（正是本任务要消灭的混淆面）。显式提示让判定**确定**。
  if (isKnownFailureCategory(input.category)) {
    const hint = String(input.category)
    const base = FAILURE_CATEGORY_TEXT[hint]
    evidence.push('explicit-category-hint')
    const mapped = startupFailureInsightFromText(text)
    return {
      category: hint,
      code: FAILURE_CATEGORY_CODES[hint],
      classification: base.classification,
      message: base.message,
      retryable: base.retryable === true,
      indeterminate: hint === FAILURE_SEMANTICS.COMMAND && input.denialClaimContradicted === true,
      evidence,
      technicalCode: typeof code === 'string' ? code : undefined,
      userDetail: mapped?.message,
      violations: transparencyViolations(base.message),
    }
  }

  // ── ① 环境故障：失根 / 载体不可用 / 启动期 NTSTATUS ──────────────────────────
  const environmentText =
    /STAGING_ROOT_LOST|STAGING_ROOT_VANISHED|STAGING_ROOT_ENV_BLANKED|STAGING_ROOT_ABSENT|STAGING_ROOT_NOT_A_DIRECTORY|staging root[^\n]{0,60}(lost|vanished|no longer exists)|SANDBOX_UNAVAILABLE|SANDBOX_NETWORK_POLICY_UNENFORCED|carrier-init-failed|injector exit|spawn UNKNOWN|STATUS_DLL_INIT_FAILED|0xc0000142|0x8007054f|0x800700b7|SEC_E_NO_CREDENTIALS|No credentials are available/i.test(
      text,
    )
  const environmentCode =
    typeof code === 'string' &&
    /SANDBOX_UNAVAILABLE|SANDBOX_NETWORK_POLICY_UNENFORCED|STAGING_ROOT_|EXECUTOR_INVALID|INIT_FAILED|MATERIALIZE_FAILED|BASE_MISSING|BASE_LOAD_FAILED/.test(code)
  if (environmentText) evidence.push('environment-fault-signature')
  if (environmentCode) evidence.push('environment-fault-code')
  if (environmentText || environmentCode) {
    // ⚠ 先判环境：`Access is denied` 既可能是策略拒绝，也可能是"载体起不来"的伪装。
    //   只有在**没有**环境证据时才落到策略判定（下面的 ②）。
    const mapped = startupFailureInsightFromText(text)
    const base = FAILURE_CATEGORY_TEXT[FAILURE_SEMANTICS.ENVIRONMENT]
    const violation = transparencyViolations(base.message)
    return {
      category: FAILURE_SEMANTICS.ENVIRONMENT,
      code: FAILURE_CATEGORY_CODES[FAILURE_SEMANTICS.ENVIRONMENT],
      classification: base.classification,
      message: base.message,
      retryable: true,
      indeterminate: false,
      evidence,
      technicalCode: typeof code === 'string' ? code : undefined,
      /** 用户侧附加说明（可含机制措辞；**不进**模型可见通道） */
      userDetail: mapped?.message,
      violations: violation,
    }
  }

  // ── ② 策略拒绝：越界写 / 提权 / 敏感路径 / 明文密钥形态 ───────────────────────
  const policyText =
    /CWD_OUTSIDE_STAGING|outside the staged root|privilege not held|requires elevation|elevation|SeDebugPrivilege|SeTakeOwnershipPrivilege|sensitive|protected path|CLEARTEXT_CREDENTIAL|cleartext/i.test(
      text,
    )
  const policyCode =
    typeof code === 'string' && /CWD_OUTSIDE_STAGING|FORBIDDEN|DENIED|POLICY|NOT_PERMITTED|ELEVATION/.test(code)
  if (policyText) evidence.push('policy-signature')
  if (policyCode) evidence.push('policy-code')
  if (policyText || policyCode) {
    const base = FAILURE_CATEGORY_TEXT[FAILURE_SEMANTICS.POLICY]
    return {
      category: FAILURE_SEMANTICS.POLICY,
      code: FAILURE_CATEGORY_CODES[FAILURE_SEMANTICS.POLICY],
      classification: base.classification,
      message: base.message,
      retryable: false,
      indeterminate: false,
      evidence,
      technicalCode: typeof code === 'string' ? code : undefined,
      violations: transparencyViolations(base.message),
    }
  }

  // ── ③ 普通失败（含"拒绝声明与执行证据相矛盾"⇒ 明确标注不确定）────────────────
  const base = FAILURE_CATEGORY_TEXT[FAILURE_SEMANTICS.COMMAND]
  const contradicted = input.denialClaimContradicted === true || input.childRan === true
  if (contradicted) evidence.push('denial-claim-contradicted-by-execution-evidence')
  return {
    category: FAILURE_SEMANTICS.COMMAND,
    code: FAILURE_CATEGORY_CODES[FAILURE_SEMANTICS.COMMAND],
    classification: base.classification,
    message: contradicted
      ? '命令结果不确定：执行通道报了拒绝，但同时存在进程已运行的证据；' +
        '因此**不能**断言命令未执行，也无法确认它是否完整执行。请以实际产出为准。'
      : base.message,
    retryable: false,
    indeterminate: contradicted,
    evidence,
    technicalCode: typeof code === 'string' ? code : undefined,
    violations: transparencyViolations(base.message),
  }
}

/**
 * ── WP7′：**限制即失败** —— 明文出站请求里出现密钥形态 ⇒ 普通失败（不静默成功）──────
 *
 * 能力边界（必须与实现一起读，**不得**读成"已拦住"）：
 *   ✅ 能检测：命令文本里**同时**出现 ①出站/网络动词 与 ②密钥形态
 *      （PEM 私钥块 / `AKIA…` / `ghp_…` / `xox?-…` / `sk-…` / JWT / `Authorization: Bearer …`）。
 *   ❌ 检测不到：**TLS 正文**（加密后肉眼与正则都看不见），以及"运行期才从文件/环境变量
 *      读出来、再拼进请求体"的密钥（命令文本里根本没有那个字面量）。
 *      ⇒ 因此本检测是**尽力而为的正向证据**，不构成"出站凭据不会泄漏"的保证；
 *        用户侧（`/winstage status` / README）必须如实说明这一点。
 *
 * 为什么必须先有网络动词：否则任何"读一个 .pem 文件"或"注释里提到 key"的普通命令都会被
 * 误判成外泄 ⇒ 假阳性会让"限制即失败"变成"什么都不能做"（比不检测更糟）。
 *
 * @param {string} text 命令文本（`command` + `args` 拼起来的原文）
 * @returns {{matched: boolean, kind?: string, snippet?: string}}
 *   `snippet` 只回**掩码后的形态**（不把密钥原文带进任何日志/返回值）。
 */
export function detectCleartextSecret(text) {
  const value = String(text ?? '')
  if (value.length === 0) return { matched: false }
  const outbound =
    /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget|HttpClient|WebClient|UploadString|UploadData|Send-MailMessage|smtp|ftp|ssh|scp|nc|netcat|Test-NetConnection|System\.Net\.)\b/i.test(
      value,
    ) || /https?:\/\//i.test(value)
  if (!outbound) return { matched: false }
  const patterns = [
    { kind: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
    { kind: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
    { kind: 'github-token', re: /\bghp_[A-Za-z0-9]{20,}\b/ },
    { kind: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
    { kind: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
    { kind: 'bearer-credential', re: /\bAuthorization\s*:\s*Bearer\s+\S{8,}/i },
    { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  ]
  for (const pattern of patterns) {
    const hit = pattern.re.exec(value)
    if (hit !== null) {
      // 掩码：只留前 4 字符 + 长度，绝不把密钥原文带出去
      const raw = hit[0]
      const masked = `${raw.slice(0, 4)}***(${raw.length} chars)`
      return { matched: true, kind: pattern.kind, snippet: masked }
    }
  }
  return { matched: false }
}

/**
 * 明文密钥形态的**普通失败**结果（机读码 + 一句话 + **不给替代路径**）。
 * 文案里零沙箱痕迹：它就是"操作本身失败"，不是"你被沙箱拦了"。
 */
export const CLEARTEXT_SECRET_FAILURE = Object.freeze({
  code: 'CLEARTEXT_CREDENTIAL_IN_REQUEST',
  category: FAILURE_SEMANTICS.POLICY,
  message:
    '请求里出现了明文形态的私钥/访问令牌，已按"该请求不被允许"处理：本次未发出。' +
    '凭据不得通过明文出站通道发送。',
})

/**
 * 从一段失败文本里取"已知启动失败码"的用户侧说明（内部用）。
 * 只走 `STARTUP_FAILURE_TABLE`，认不出就返回 undefined（不许编）。
 */
function startupFailureInsightFromText(text) {
  const value = String(text ?? '').toLowerCase()
  // 先认长码（0x8007054f 这类 8 位），再认状态名，避免被短码抢先
  const hex = Object.keys(STARTUP_FAILURE_TABLE)
    .filter((key) => key.length === 10)
    .filter((key) => value.includes(key))
  const named =
    /status_dll_init_failed/.test(value) ? '0xc0000142' : /sec_e_no_credentials|no credentials are available/.test(value) ? '0x8009030e' : undefined
  const key = hex[0] ?? named
  const entry = key === undefined ? undefined : STARTUP_FAILURE_TABLE[key]
  if (entry === undefined) return undefined
  return { code: key, category: entry.category, label: entry.label, kind: entry.kind, message: entry.hint }
}

/** 归一表：NTSTATUS / HRESULT → 可读分类。键是**无符号 32 位小写十六进制**。 */
export const STARTUP_FAILURE_TABLE = Object.freeze({
  '0xc0000142': { category: STARTUP_FAILURE_CATEGORIES.DLL_INIT_FAILED, label: 'STATUS_DLL_INIT_FAILED', kind: 'runner-failure', hint: '子进程在用户态初始化阶段就死了（DLL 初始化失败）：多为桌面/窗口站、会话 0、受限令牌或 CreateNoWindow 组合导致；不是命令自身失败，也不是策略拒绝。' },
  '0xc0000135': { category: STARTUP_FAILURE_CATEGORIES.DLL_NOT_FOUND, label: 'STATUS_DLL_NOT_FOUND', kind: 'runner-failure', hint: '子进程缺少依赖 DLL（PATH/工作目录不对，或依赖未安装）。' },
  '0xc0000005': { category: STARTUP_FAILURE_CATEGORIES.ACCESS_VIOLATION, label: 'STATUS_ACCESS_VIOLATION', kind: 'runner-failure', hint: '子进程访问违例（崩溃）。探针/启动器自身故障，不构成对命令的策略判定。' },
  '0xc0000409': { category: STARTUP_FAILURE_CATEGORIES.STACK_BUFFER_OVERRUN, label: 'STATUS_STACK_BUFFER_OVERRUN', kind: 'runner-failure', hint: '子进程被 __fastfail 终止（栈溢出/缓解措施触发）。' },
  '0xe0434352': { category: STARTUP_FAILURE_CATEGORIES.CLR_EXCEPTION, label: 'CLR unhandled exception (0xE0434352)', kind: 'runner-failure', hint: '托管运行时抛出了未处理异常。**注意**：它既可能是启动器/CLI 崩溃，也可能是被测命令自身崩溃 —— 只看退出码无法区分，须结合是否有子进程输出。' },
  '0x8007054f': { category: STARTUP_FAILURE_CATEGORIES.INTERNAL_ERROR, label: 'HRESULT 0x8007054F (ERROR_INTERNAL_ERROR)', kind: 'runner-failure', hint: 'Win32 内部错误（实测出现在 System.Data.dll 加载路径上）：环境/依赖装配问题，不是策略拒绝。' },
  // `0x80070549`（ERROR_NO_SUCH_LOGON_SESSION = 1312）—— 现场里"`ERROR_INTERNAL_ERROR` 那条
  // 栈经常把内层码写成 0x8007054F，而**归一化后真正落到 stdout/stderr 的**是 0x80070549"。
  // 两者同族（都是装配期的 Win32 内部错误），因此**同一分类、同一句结论**，只是机读码原样带出。
  '0x80070549': { category: STARTUP_FAILURE_CATEGORIES.INTERNAL_ERROR, label: 'HRESULT 0x80070549 (ERROR_NO_SUCH_LOGON_SESSION)', kind: 'runner-failure', hint: 'Win32 内部错误（同 0x8007054F 一族，实测出现在 System.Data.dll 加载路径上）：环境/依赖装配问题，不是策略拒绝、也不是安全拦截。' },
  '0x80070005': { category: STARTUP_FAILURE_CATEGORIES.ACCESS_DENIED, label: 'HRESULT 0x80070005 (E_ACCESSDENIED / ERROR_ACCESS_DENIED)', kind: 'denied', hint: '真的是访问被拒（ACL / 令牌权限）。' },
  // ── WP6：**故障伪装成防护**必须被拆穿（否则会被读成"安全拦截"，从而掩盖真实故障）──
  '0x8009030e': { category: STARTUP_FAILURE_CATEGORIES.NO_CREDENTIALS, label: 'SEC_E_NO_CREDENTIALS (0x8009030E)', kind: 'environment-fault', hint: 'Schannel/Security Support Provider 取不到凭据：这是**令牌能力缺失**（受限令牌下没有可用凭据句柄），**不是安全拦截**，也不是策略拒绝 —— 不要把它读成"被安全策略挡住"。属环境故障，可重试。' },
  '0x800700b7': { category: STARTUP_FAILURE_CATEGORIES.ALREADY_EXISTS, label: 'HRESULT 0x800700B7 (ERROR_ALREADY_EXISTS)', kind: 'environment-fault', hint: '目标对象已存在（实测出现在 profile/容器目录装配路径上）：属**环境/装配**问题，不是策略拒绝、也不是安全拦截。' },
  '0x0000007f': { category: STARTUP_FAILURE_CATEGORIES.SPAWN_UNKNOWN, label: 'spawn UNKNOWN (127)', kind: 'runner-failure', hint: 'libuv 的 `spawn UNKNOWN`：CreateProcess 没给出可用错误码，可执行文件/依赖/权限三者之一。' },
  '0x00000002': { category: STARTUP_FAILURE_CATEGORIES.FILE_NOT_FOUND, label: 'Win32 2 (ERROR_FILE_NOT_FOUND)', kind: 'runner-failure', hint: '可执行文件没找到：CreateProcessAsUserW 不补 PATHEXT、不查 App Paths，裸命令名必然走到这里。' },
})

/** 退出码 → `{ signed, unsigned, hex }`（同时接受有符号与无符号表示） */
export function normalizeExitCode(value) {
  if (value === undefined || value === null || typeof value !== 'number' || Number.isNaN(value)) return undefined
  const signed = value > 0x7fffffff ? value - 0x100000000 : Math.trunc(value)
  const unsigned = value >>> 0
  return { signed, unsigned, hex: `0x${unsigned.toString(16).padStart(8, '0')}` }
}

/**
 * 启动/退出失败的归一分类（纯函数）。真实 NTSTATUS 原样带出（`ntstatusHex` / `ntstatus`）。
 *
 * `childRan` 只在有**执行证据**时才为 true：有子进程输出，或观测到干净的退出码，
 * 或调用方显式报告了副作用。用于回答"报 Access is denied 但子进程其实已经运行"这类
 * 与事实相反的结论。
 */
export function classifyStartupFailure(input = {}) {
  const exit = normalizeExitCode(input.exitCode)
  const text = `${input.stderr ?? ''}\n${input.stdout ?? ''}\n${input.launchFailure?.message ?? input.error ?? ''}`
  const spawned = (() => {
    const match = /spawn\s+UNKNOWN(?:\s*\((\d+)\))?/i.exec(text)
    if (match) return { matched: true, raw: match[0], code: match[1] }
    return { matched: false }
  })()
  // 刻意不用 `a && b ?? c` 这种写法：`false ?? undefined` 是 `false` 而不是 `undefined`，
  // 会把"没识别到"读成"识别到了"（本文件实测踩到过）。
  let entry
  if (exit !== undefined && STARTUP_FAILURE_TABLE[exit.hex]) entry = STARTUP_FAILURE_TABLE[exit.hex]
  else if (spawned.matched) entry = STARTUP_FAILURE_TABLE['0x0000007f']
  const stdoutText = String(input.stdout ?? '')
  const stderrText = String(input.stderr ?? '')
  // ── 执行证据（这个判据必须诚实，否则会给出与事实相反的结论）──────────────────
  // **只看 stdout**：stderr 上那句 `Access is denied` 正是"被拒"这个断言本身，
  // 把它当"子进程运行过"的证据就成了循环论证（本文件实测踩到过）。
  // 另外"干净退出码 0"与调用方观测到的副作用同样算执行证据。
  const stdoutReal = stdoutText
    .split(/\r?\n/)
    .filter((line) => line.length > 0 && !/^dsh-stage:/.test(line))
    .join('\n')
    .trim()
  const producedOutput = stdoutReal.length > 0
  const cleanExit = exit !== undefined && exit.unsigned === 0
  const observedSideEffects = input.sideEffectsObserved === true
  const childRan = producedOutput || cleanExit || observedSideEffects
  const accessDeniedText = /access is denied|0x80070005|E_ACCESSDENIED|UnauthorizedAccessException|PermissionDenied/i.test(text)
  const codes = []
  if (exit) codes.push(exit.hex)
  if (spawned.matched) codes.push('spawn UNKNOWN')
  const recognized = entry !== undefined
  const conclusion = recognized
    ? {
        category: entry.category,
        label: entry.label,
        kind: entry.kind,
        message: entry.hint,
      }
    : {
        category: STARTUP_FAILURE_CATEGORIES.NONE,
        label: 'no startup-failure signature recognized',
        kind: undefined,
        message: '没有识别到已知的启动失败特征（按普通命令结果处理）。',
      }
  const contradicted = accessDeniedText && childRan
  return {
    // ── 归一分类（可读）
    category: conclusion.category,
    label: conclusion.label,
    classificationKind: conclusion.kind,
    message: conclusion.message,
    // ── 真实值原样带出
    ntstatus: exit?.signed,
    ntstatusHex: exit?.hex,
    ntstatusUnsigned: exit?.unsigned,
    rawSignature: spawned.matched ? spawned.raw : undefined,
    recognizedCodes: codes,
    // ── 事实性检查（stderr 不算执行证据，理由见上）────────────────────────────
    stdoutBytes: stdoutReal.length,
    stderrPresent: stderrText.trim().length > 0,
    evidenceOfExecution: { producedOutput, cleanExit, observedSideEffects },
    childRan,
    // ── "报错与事实相反"的显式结论
    denialClaimContradicted: contradicted,
    conclusion: contradicted
      ? 'denial-claim-contradicted-by-evidence'
      : conclusion.category === STARTUP_FAILURE_CATEGORIES.NONE
        ? 'no-startup-failure'
        : 'classified',
    diagnosis: contradicted
      ? '启动/执行通道报的是 access-denied 形态的拒绝，但**同时存在执行证据**（stdout 有输出 / 干净退出码 / 调用方报的副作用）—— ' +
        '因此**不得**据此下"命令未执行"或"命令被拒"的结论；到底跑没跑、跑完没有，仅凭这条报错**无法判定**，' +
        '请以实际产出为准。该拒绝声明**不构成**策略判定。'
      : conclusion.message,
  }
}

/**
 * 结果分类：必须区分"策略拒绝""沙箱自身故障""命令自身失败"（手册第 4 章 / 第 9 章），
 * 另外还要区分 **BUG-3 的"失根"** 与 **BUG-9 的启动失败形态**：
 *   · `kind:'root-loss'`   —— 暂存根失联/漂移，**不是**策略拒绝，绝不许被读成 `denied`；
 *   · `kind:'runner-failure'` + `startupFailure` —— 启动期 NTSTATUS 归一分类；
 *   · 报错说 `Access is denied` 但**子进程确实运行过** ⇒ 不给与事实相反的结论。
 */
export function classifyOutcome({ exitCode, stdout, stderr, launchFailure, startupFailure }) {
  const text = `${stderr}\n${stdout}`
  // 顺序很重要：`dsh-stage:` 是我们自己的前缀，既用于"沙箱启动失败"也用于"超时"。
  // 若先匹配裸前缀，超时会被误判成 runner-failure（真实的分类缺陷 9）。
  // 因此先认最具体的标记，再认通用前缀。
  if (/dsh-stage: timeout after|^timeout after/m.test(text)) {
    return { kind: 'timeout', reason: 'execution exceeded the configured timeout' }
  }
  // ── BUG-3：失根必须先于"策略拒绝"被认出来 ──────────────────────────────────
  // 现场里失根只留下一句 `Access is denied`，于是和策略拒绝无法区分。失根有独立的
  // 错误码与措辞，任何一处出现都按"失根"归类。
  if (
    /STAGING_ROOT_LOST|STAGING_ROOT_VANISHED|STAGING_ROOT_ENV_BLANKED|STAGING_ROOT_ABSENT|STAGING_ROOT_NOT_A_DIRECTORY/.test(text) ||
    /WINSTAGE_STAGE_ROOT\b[^\n]{0,40}(变成空|is empty|blanked)/i.test(text) ||
    /staging root[^\n]{0,60}(lost|vanished|no longer exists)/i.test(text)
  ) {
    return {
      kind: 'root-loss',
      reason:
        'the staging root was LOST (it went empty or vanished mid-session) — this is a sandbox/root lifecycle failure, ' +
        'NOT a policy denial; earlier staged work may already be gone',
      policyDenial: false,
    }
  }
  if (/dsh-stage: sandbox launch failed|windows-acl-run:|SANDBOX_UNAVAILABLE/.test(text)) {
    return { kind: 'runner-failure', reason: 'sandbox runner/launcher refused — classify as a broken sandbox, not a policy denial' }
  }
  // ── BUG-9：启动失败按 NTSTATUS 归类，并把真实值带出来 ────────────────────────
  const startup = startupFailure ?? classifyStartupFailure({ exitCode, stdout, stderr, launchFailure })
  if (
    startup.denialClaimContradicted ||
    (startup.category !== STARTUP_FAILURE_CATEGORIES.NONE && STARTUP_FAILURE_TABLE[startup.ntstatusHex])
  ) {
    return {
      kind: startup.denialClaimContradicted ? 'command-failed' : (startup.classificationKind ?? 'runner-failure'),
      reason: startup.diagnosis,
      startupFailure: startup,
      // 供机检：这一条**不是**策略拒绝
      policyDenial: startup.category === STARTUP_FAILURE_CATEGORIES.ACCESS_DENIED && !startup.denialClaimContradicted,
      contradictedDenialClaim: startup.denialClaimContradicted === true,
    }
  }
  if (/Access is denied|UnauthorizedAccessException|PermissionDenied|0x80070005|EPERM|EACCES/i.test(text)) {
    return { kind: 'denied', reason: 'the confined action was denied by the write boundary / ACL', policyDenial: true }
  }
  if (exitCode === 0) return { kind: 'ok', reason: 'completed' }
  if (exitCode === 124) return { kind: 'timeout', reason: 'execution exceeded the configured timeout' }
  if (exitCode === 127) return { kind: 'runner-failure', reason: 'runner exit 127 — documented broken-sandbox signal' }
  return { kind: 'command-failed', reason: `command exited ${exitCode}` }
}

function fail(code, message) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  return error
}

/** 尽力释放一个 AclSandbox（失败不得掩盖原始错误） */
function safeDispose(sandbox) {
  try {
    sandbox?.dispose()
  } catch {
    /* 清理失败只影响残留，不改变 fail-closed 结论 */
  }
}

/** 加载公开进程绑定表；失败返回 undefined 让调用方 fail-closed */
function safeLoadProcessBindings(win32Module) {
  try {
    return win32Module.loadWin32ProcessBindings()
  } catch {
    return undefined
  }
}

/** 尽力关闭一个句柄（失败只影响残留，不改变结论） */
function safeClose(api, handle) {
  try {
    if (handle !== undefined && handle !== null) api.closeHandle(handle)
  } catch {
    /* 忽略 */
  }
}

function safeVersion(from, packageName) {
  if (!from || from === 'self') return undefined
  try {
    return createRequire(join(from, 'noop.js'))(`${packageName}/package.json`).version
  } catch {
    return undefined
  }
}

function cleanupTargets(targets) {
  for (const target of targets) {
    try {
      if (existsSync(target)) rmSync(target, { force: true })
    } catch {
      /* 宿主侧清理失败不影响判定 */
    }
  }
}

export function defaultPrivateTemp() {
  const base = join(tmpdir(), 'dsh-stage-temp')
  mkdirSync(base, { recursive: true })
  return join(base, randomUUID())
}

export function canonicalDir(target) {
  const absolute = normalize(target)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

export function sameDir(left, right) {
  if (!left || !right) return false
  return canonicalDir(left).toLowerCase().replace(/[\\/]+$/, '') === canonicalDir(right).toLowerCase().replace(/[\\/]+$/, '')
}

export function sameDirOrInside(parent, child) {
  if (!parent || !child) return false
  const p = canonicalDir(parent).toLowerCase().replace(/[\\/]+$/, '')
  const c = canonicalDir(child).toLowerCase().replace(/[\\/]+$/, '')
  return c === p || c.startsWith(p + sep)
}

function ps(value) {
  return value.replace(/'/g, "''")
}

// ═══════════════════ 去令牌化运行模式（透明 shim；T4 契约）═══════════════════
//
// ── 为什么需要它（Lead 2026-09-30 实测 + `docs/T1-启动器修复报告.md` §3）──────
// 平台 ACL 沙箱的 WRITE_RESTRICTED 受限令牌，restricting list 只有
// `[logon SID, EVERYONE]`（workspace-write 再加 workspace/temp 两个 capability SID），
// 因此沙箱内：
//   ① 子进程 stdout/stderr 管道（DACL 只授予**用户 SID**）写不进去
//      ⇒ `& node --version | Out-String` 报
//        `Program 'node.exe' failed to run: Access is denied`；
//        `& node --version > f` **不报错**但文件是空的（静默丢数据，比报错更坏）。
//   ② SChannel 取不到凭据（`SEC_E_NO_CREDENTIALS` /
//      "No credentials are available in the security package"）⇒ TLS 全灭。
//   ③ `whoami /user`、`whoami /groups`、`tasklist`、`Get-CimInstance`、
//      `Get-NetFirewallProfile`、`Get-NetTCPConnection` 全部 `Access is denied`
//      （而 `whoami /priv` 正常 —— 因为读取特权不涉及子对象 DACL）。
//
// ── 为什么不能靠"把用户 SID 加进 restricting list"修（关键约束）───────────────
// 那样确实能同时修好 ①②③，但 `C:\Program Files`、`HKCU`、`%APPDATA%` 等
// **一切授予该用户写权限**的对象会立刻重新可写 ⇒ 写边界当场崩塌。
// 所以在保留 WRITE_RESTRICTED 的前提下这条路不可接受，本项目不采用。
//
// ── 本模式的做法 ────────────────────────────────────────────────────────────
// 当 T4 的 `winstage-shim.dll` **真实可用**时，子进程以**普通令牌 + 正常完整性**
// 启动（不 `CreateRestrictedToken`、不加 Low IL 标签），强制 + 暂存交给 shim。
// 三类能力之所以恢复，不是"我们放宽了边界"，而是**根本没有受限令牌**。
//
// ── 安全契约（必须与任何"通过"一起读）────────────────────────────────────────
//   1. shim 是**用户态 IAT 补丁**级重定向，不是内核级强制（T4 声明）。未覆盖
//      `ntdll!Nt*` 直调、`\\?\GLOBALROOT\Device\...` 设备路径、`CopyFile2`、
//      `SHFileOperation`/`IFileOperation`、内存映射写入、其它进程代写等路径。
//   2. 探测必须由**真实可用性**决定（DLL 存在且 PE 导出齐全 → 一次性进程里能加载
//      且 `initialized=true` → 注入器金丝雀退出 0 → **经注入器启动的金丝雀子进程里
//      四类能力真的恢复了**）。任一环失败一律 fail-closed 回退受限令牌模式。
//   3. **绝不裸跑**：本文件不会产生"既无受限令牌、又没经过 shim"的进程。
//      （探测失败时的回退目标是受限令牌模式，不是普通进程。）
//   4. 去令牌化模式要求**启动方自身是未受限进程**：受限父进程派生出的子进程继承
//      受限令牌，此时 shim 金丝雀里的四类能力仍然失败 ⇒ 探测不通过 ⇒ 自动回退。
//      这条由 `src/capability-probe.mjs` 的 `mode.hostConfined` 如实报告。

/** 去令牌化档位标签（`tier: 'TS'`；`tier: 'auto'` 表示"能用就用"） */
export const TRANSPARENT_TIER = 'TS'
/** T4 `shim/include/winstage_shim.h`：`WINSTAGE_SHIM_ABI_VERSION` */
export const SHIM_ABI_VERSION = 1
/** T4 注入器的失败退出码（`shim/out/winstage-inject.exe`） */
export const SHIM_INJECT_FAILURE_EXIT = 111
/** DLL 必须导出的符号（PE 导出表里核对，不靠"文件存在"） */
export const SHIM_REQUIRED_EXPORTS = ['WinstageShimInit', 'WinstageShimAbiVersion', 'WinstageShimStatsJson']
/** T4 约定的产物相对路径（可用 WINSTAGE_SHIM_* 环境变量覆盖） */
export const SHIM_RELATIVE_PATHS = {
  dll: join('shim', 'out', 'winstage-shim.dll'),
  injector: join('shim', 'out', 'winstage-inject.exe'),
  probe: join('shim', 'out', 'winstage-probe.exe'),
}
/** 金丝雀/能力探针的输出哨兵（capability-probe 与 TS 可用性探测共用同一份脚本） */
export const CAPABILITY_MARKER = 'WINSTAGE-CAPABILITY:'

/** 本仓库根目录（`src/executor.mjs` 的上两级） */
export function repoRootPath() {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** 解析 T4 的三个产物路径（环境变量优先，其次仓库内规范位置） */
/** 把产物路径规范成绝对路径（子进程的 cwd 可能与宿主不同，相对路径必错） */
export function resolveShimArtifacts(options = {}) {
  const shimDir = resolve(options.shimDir || process.env.WINSTAGE_SHIM_DIR || join(repoRootPath(), 'shim', 'out'))
  return {
    shimDir,
    dllPath: resolve(options.dllPath || process.env.WINSTAGE_SHIM_DLL || join(shimDir, 'winstage-shim.dll')),
    injectorPath: resolve(options.injectorPath || process.env.WINSTAGE_SHIM_INJECTOR || join(shimDir, 'winstage-inject.exe')),
    probePath: resolve(options.probePath || process.env.WINSTAGE_SHIM_PROBE || join(shimDir, 'winstage-probe.exe')),
  }
}

/**
 * 解析 PE32+ 的导出表符号名（纯函数，可在任何环境离线测试）。
 *
 * 为什么不用 `LoadLibrary` 探测：把 shim 加载进**宿主进程**会让 shim 的 DllMain
 * 在自己的进程里装 IAT 钩子 —— 那正是"用探测动作改变运行期状态"（手册第 17.2 节）。
 * T4 也明确要求"在一次性短命进程里跑 probe，不要加载进宿主"。
 */
export function parsePeExports(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x40) return { ok: false, detail: 'file too small' }
  if (buffer.readUInt16LE(0) !== 0x5a4d) return { ok: false, detail: 'no MZ header' }
  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset <= 0 || peOffset + 0x18 > buffer.length) return { ok: false, detail: `bogus e_lfanew ${peOffset}` }
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) return { ok: false, detail: 'no PE signature' }
  // `[实测]` COFF 头从**签名之后**开始（peOffset + 4），因此
  // SizeOfOptionalHeader 在 coff + 16 = peOffset + **20**。
  // 这里曾错写成 peOffset + 16（把签名的 4 字节算漏了），于是真实 DLL 的
  // `SizeOfOptionalHeader` 被读成 0 ⇒ 节表起点落到可选头上 ⇒ 节表全成垃圾 ⇒
  // 导出表解析失败。**合成 PE 的单元测试当时也用了同一个错偏移，所以测试是绿的**
  // —— 这正是 README 缺陷 15（"替身/夹具与真实对象形状不一致比没有替身更危险"）的
  // 又一实例：直到 T4 交付出真实 DLL（7 个节、SizeOfOptionalHeader=0xF0）才暴露。
  const coff = peOffset + 4
  const machine = buffer.readUInt16LE(coff)
  const numberOfSections = buffer.readUInt16LE(coff + 2)
  const sizeOfOptionalHeader = buffer.readUInt16LE(coff + 16)
  const optional = coff + 20
  if (optional + 2 > buffer.length) return { ok: false, detail: 'truncated optional header' }
  const magic = buffer.readUInt16LE(optional)
  if (magic !== 0x20b) return { ok: false, detail: `not PE32+ (magic=0x${magic.toString(16)})` }
  if (optional + 116 > buffer.length) return { ok: false, detail: 'truncated data directories' }
  const exportRva = buffer.readUInt32LE(optional + 112)
  const sections = []
  const sectionTable = optional + sizeOfOptionalHeader
  for (let index = 0; index < numberOfSections; index += 1) {
    const at = sectionTable + index * 40
    if (at + 40 > buffer.length) break
    sections.push({
      virtualSize: buffer.readUInt32LE(at + 8),
      virtualAddress: buffer.readUInt32LE(at + 12),
      sizeOfRawData: buffer.readUInt32LE(at + 16),
      pointerToRawData: buffer.readUInt32LE(at + 20),
    })
  }
  const rvaToOffset = (rva) => {
    for (const section of sections) {
      const span = Math.max(section.virtualSize, section.sizeOfRawData)
      if (rva >= section.virtualAddress && rva < section.virtualAddress + span) {
        return section.pointerToRawData + (rva - section.virtualAddress)
      }
    }
    return -1
  }
  if (exportRva === 0) return { ok: true, machine, names: [], detail: 'no export directory' }
  const exportOffset = rvaToOffset(exportRva)
  if (exportOffset < 0 || exportOffset + 40 > buffer.length) return { ok: false, detail: 'export directory RVA out of range' }
  const nameCount = buffer.readUInt32LE(exportOffset + 24)
  const namesRva = buffer.readUInt32LE(exportOffset + 32)
  const namesOffset = rvaToOffset(namesRva)
  if (namesOffset < 0 || nameCount > 65535) return { ok: false, detail: 'export name table out of range' }
  const names = []
  for (let index = 0; index < nameCount; index += 1) {
    const at = namesOffset + index * 4
    if (at + 4 > buffer.length) break
    const nameOffset = rvaToOffset(buffer.readUInt32LE(at))
    if (nameOffset < 0) continue
    const end = buffer.indexOf(0, nameOffset)
    if (end < 0) continue
    names.push(buffer.toString('ascii', nameOffset, end))
  }
  return { ok: true, machine, names }
}

/** 核对 DLL：存在 + x64 PE + 必需导出符号齐全（不加载、不执行） */
export function probeShimDll(dllPath) {
  if (!dllPath) return { ok: false, detail: 'no candidate shim DLL path' }
  if (!existsSync(dllPath)) return { ok: false, detail: `not found: ${dllPath}` }
  let buffer
  try {
    buffer = readFileSync(dllPath)
  } catch (error) {
    return { ok: false, detail: `unreadable: ${error.message}` }
  }
  const pe = parsePeExports(buffer)
  if (!pe.ok) return { ok: false, detail: `PE parse failed: ${pe.detail}` }
  if (pe.machine !== 0x8664) return { ok: false, detail: `machine 0x${pe.machine.toString(16)} is not x64 (0x8664)` }
  const missing = SHIM_REQUIRED_EXPORTS.filter((name) => !pe.names.includes(name))
  if (missing.length > 0) {
    return { ok: false, detail: `missing exports: ${missing.join(', ')} (found: ${pe.names.slice(0, 8).join(', ') || 'none'})` }
  }
  return {
    ok: true,
    detail: `x64 PE, ${buffer.length} bytes, ${pe.names.length} exports incl. ${SHIM_REQUIRED_EXPORTS.join('/')}`,
    exports: pe.names,
    size: buffer.length,
  }
}

/**
 * 写 shim 配置 JSON（T4 契约：默认位置 `<stageRoot>\winstage-shim.config.json`）。
 *
 * `passthrough` 必须包含暂存根本身：否则 shim 会把"往暂存树里写文件"这件事
 * 再暂存一次（自指递归）。
 */
export function writeShimConfig({ stageRoot, logPath, extraPassthrough = [] }) {
  const configPath = join(stageRoot, 'winstage-shim.config.json')
  const passthrough = [...new Set([stageRoot, ...extraPassthrough].filter((value) => typeof value === 'string' && value.length > 0))]
  const config = {
    stageRoot,
    logPath: logPath ?? join(stageRoot, 'shim.log'),
    failClosed: true,
    readThrough: true,
    verbose: false,
    traceStagedOps: true,
    passthrough,
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return { configPath, config }
}

/**
 * 用**文件描述符重定向**采集子进程输出（**绝不使用命名管道**）。
 *
 * 为什么必须这样：受限令牌下 `spawnSync`/`spawn` 默认的 `stdio: 'pipe'` 走
 * 命名/匿名管道，客户端打开请求需要受限 SID 未被授予的写权限，子进程创建直接
 * EPERM（README §1.1 / 残余边界 R10）。本项目已有先例：`run.cmd` /
 * `run.capture.mjs`。探针要在**修复前**也能跑，所以它自身不能依赖管道。
 */
export function runCapturedToFiles(file, args, options = {}) {
  // ★ 路径必须是**绝对**的：子进程的 cwd 由 options.cwd 决定，若这里给出相对
  // captureDir，子进程（以及我们把路径写进它 argv 的那些参数）会按**它自己的 cwd**
  // 解析，于是"文件写不出来/写到别处"。实测代价：T4 的 probe 因此返回 exit=3 且
  // 不产出 JSON，被误读成"shim 不可用"。
  const captureDir = resolve(options.captureDir || options.cwd || tmpdir())
  mkdirSync(captureDir, { recursive: true })
  const stamp = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
  const outPath = join(captureDir, `.winstage-cap-${stamp}.out`)
  const errPath = join(captureDir, `.winstage-cap-${stamp}.err`)
  let outFd
  let errFd
  let status = null
  let signal = null
  let failure
  try {
    outFd = openSync(outPath, 'w')
    errFd = openSync(errPath, 'w')
    const result = spawnSyncChildProcess(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', outFd, errFd],
      timeout: options.timeoutMs ?? 60000,
      windowsHide: false,
    })
    status = result.status
    signal = result.signal
    failure = result.error?.message
  } catch (error) {
    failure = error.message
  } finally {
    for (const fd of [outFd, errFd]) {
      if (typeof fd === 'number') {
        try {
          closeSync(fd)
        } catch {
          /* 关闭失败只影响残留句柄 */
        }
      }
    }
  }
  const read = (path) => {
    try {
      return existsSync(path) ? readFileSync(path, 'utf8') : ''
    } catch {
      return ''
    }
  }
  const out = read(outPath)
  const err = read(errPath)
  if (options.keepCaptureFiles !== true) {
    for (const path of [outPath, errPath]) {
      try {
        unlinkSync(path)
      } catch {
        /* 清理失败不影响判定 */
      }
    }
  }
  return { code: status, signal, timedOut: status === null && signal === 'SIGTERM', error: failure, out, err }
}

/** 从哨兵行里解析 JSON（哨兵行必须是最后一行之一） */
export function parseMarkerJson(text, marker = CAPABILITY_MARKER) {
  if (typeof text !== 'string') return undefined
  const lines = text.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const at = lines[index].indexOf(marker)
    if (at < 0) continue
    try {
      return JSON.parse(lines[index].slice(at + marker.length).trim())
    } catch {
      /* 继续往前找 */
    }
  }
  return undefined
}

/**
 * 能力金丝雀脚本（PowerShell 5.1 兼容；纯 ASCII）。
 *
 * 一次跑完并把结果作为 JSON 打在最后一行（哨兵 `WINSTAGE-CAPABILITY:`）：
 *   pipeOk / redirectOk / whoamiUser / whoamiGroups / tasklist / cim / firewall /
 *   tcpConnection / tlsCredentials / tlsDetail / dshSandboxVars
 *
 * 为什么用 PowerShell 而不是 node：`& node --version | Out-String` 与 `> file`
 * 正是被破坏的两个能力本身；用 node 自测等于用被测对象去测它自己。
 */
export function buildCapabilityCanaryScript() {
  return [
    "$ErrorActionPreference = 'Continue'",
    '$r = [ordered]@{}',
    // ① 管道：跑不通时管道内容为空（错误是非终止性的）
    "$pipeText = ''",
    'try { $pipeText = (& node --version | Out-String) } catch { $pipeText = "" }',
    "$r.pipeOk = [bool]($pipeText -match '^v\\d+\\.')",
    "$r.pipeText = ($pipeText + '').Trim()",
    // ② 重定向：受限令牌下文件会被创建但**内容为空**（静默丢数据）
    "$f = Join-Path $env:TEMP ('winstage-canary-' + [guid]::NewGuid().ToString('n') + '.txt')",
    'try { & node --version > $f } catch { }',
    "$redirText = ''",
    'try { if (Test-Path -LiteralPath $f) { $redirText = ((Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue) + "").Trim() } } catch { }',
    "$r.redirectOk = [bool]($redirText -match '^v\\d+\\.')",
    "$r.redirectText = $redirText",
    'Remove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue',
    // ③ 系统查询（不重定向：让子进程直接继承脚本自身的标准句柄，靠退出码判定）
    '& whoami.exe /user',
    '$r.whoamiUser = ($LASTEXITCODE -eq 0)',
    '& whoami.exe /groups',
    '$r.whoamiGroups = ($LASTEXITCODE -eq 0)',
    '& tasklist.exe /FI "IMAGENAME eq node.exe"',
    '$r.tasklist = ($LASTEXITCODE -eq 0)',
    'try { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop | Out-Null; $r.cim = $true } catch { $r.cim = $false }',
    'try { Get-NetFirewallProfile -ErrorAction Stop | Out-Null; $r.firewall = $true } catch { $r.firewall = $false }',
    'try { $tc = Get-NetTCPConnection -ErrorAction Stop; $r.tcpConnection = ($null -ne $tc) } catch { $r.tcpConnection = $false }',
    // ④ TLS：SChannel 的失败发生在**取凭据**这一步，因此用回环自连即可把它逼出来
    '$r.tlsCredentials = $false',
    "$r.tlsDetail = ''",
    '$listener = $null',
    'try {',
    '  $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)',
    '  $listener.Start()',
    '  $client = New-Object Net.Sockets.TcpClient',
    '  $client.ReceiveTimeout = 4000',
    "  $client.Connect('127.0.0.1', $listener.LocalEndpoint.Port)",
    '  $ssl = New-Object Net.Security.SslStream($client.GetStream(), $false, [System.Net.Security.RemoteCertificateValidationCallback]{ $true })',
    '  try { $ssl.AuthenticateAsClient("localhost"); $r.tlsCredentials = $true; $r.tlsDetail = "handshake-ok" }',
    '  catch {',
    '    $m = $_.Exception.Message',
    '    if ($_.Exception.InnerException) { $m = $_.Exception.InnerException.Message }',
    '    $r.tlsDetail = $m',
    "    $r.tlsCredentials = [bool]($m -notmatch 'credentials are available')",
    '  }',
    '  $client.Close()',
    '} catch { $r.tlsDetail = $_.Exception.Message }',
    'finally { if ($listener) { $listener.Stop() } }',
    // ⑤ 沙箱痕迹：子进程环境里不得有任何 DSH_SANDBOX*
    '$r.dshSandboxVars = @([System.Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -like "DSH_SANDBOX*" })',
    '$r.dshSandboxCount = $r.dshSandboxVars.Count',
    // ⑤b 去令牌化模式的**已知可见痕迹**：shim 的环境契约变量（如实上报，不当成没发生）
    '$r.winstageVars = @([System.Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -like "WINSTAGE_*" })',
    '$r.winstageCount = $r.winstageVars.Count',
    "[Console]::Out.Write('" + CAPABILITY_MARKER + "' + ($r | ConvertTo-Json -Compress))",
  ].join('\r\n')
}

/**
 * 四类能力（+ 痕迹）的共同判定：金丝雀 JSON → 通过/失败与证据。
 *
 * ── 为什么把 `firewall` / `tlsCredentials` 降为**参考项**（本轮定因，附实测证据）──
 * 这两个探针测的不是"去令牌化通道是否成立"，而是"这台机器此刻能不能跑那两个
 * 系统 cmdlet"。实测（本机 2026-10-02）：
 *   · 同一个金丝雀脚本、同一份 DLL，在**宿主进程内**跑：
 *     `{"pipeOk":true,"redirectOk":true,"whoamiUser":true,"whoamiGroups":true,
 *       "tasklist":true,"cim":true,"firewall":false,"tcpConnection":true,
 *       "tlsCredentials":true,...}`（`firewall` 假）；
 *   · 在**子进程/普通终端**里跑同一份脚本：10 项全真。
 * 于是"透明 shim 可用"这条结论会被一个与沙箱无关的 cmdlet 环境问题**翻转**，
 * 后果是 `tier:'auto'` 静默退回受限令牌档 —— 那一档**没有 shim**：
 *   · 注册表写只剩内核硬拒（用户报障"注册表更改直接失败"的成因）；
 *   · 命令的文件产出也不进暂存。
 * 这不是"放宽安全门"，而是**把门装回它本来守的地方**：判据收窄为
 * "受限令牌一定会破坏、而去令牌化一定恢复"的那些项
 * （`pipe` / `redirect` / `whoami` / `tasklist` / `cim` / `tcpConnection` / 无 `DSH_SANDBOX*` 痕迹）
 * —— 其中 `pipe` 与 `redirect` 正是受限令牌档**反复实测**过会坏的两种能力。
 * **参考项仍然如实上报**（`advisory`），绝不隐藏：报告里看得见它们当时的值，
 * 将来若某个参考项在所有环境下都恒假，也能被这条记录抓住。
 */
export function judgeCanary(canary) {
  if (!canary || typeof canary !== 'object') {
    return { ok: false, reason: 'canary produced no parsable marker JSON', items: {}, advisory: {} }
  }
  const items = {
    pipe: canary.pipeOk === true,
    redirect: canary.redirectOk === true,
    whoamiUser: canary.whoamiUser === true,
    whoamiGroups: canary.whoamiGroups === true,
    tasklist: canary.tasklist === true,
    cim: canary.cim === true,
    tcpConnection: canary.tcpConnection === true,
    noDshSandboxTrace: (canary.dshSandboxCount ?? 1) === 0,
  }
  /** 参考项：环境相关，不参与"是否走去令牌化通道"的判定，但必须被记录 */
  const advisory = {
    firewall: canary.firewall === true,
    tlsCredentials: canary.tlsCredentials === true,
  }
  const failed = Object.entries(items).filter(([, ok]) => !ok).map(([name]) => name)
  const advisoryFailed = Object.entries(advisory).filter(([, ok]) => !ok).map(([name]) => name)
  const reason =
    failed.length === 0
      ? `all capabilities present${advisoryFailed.length > 0 ? ` (advisory failed: ${advisoryFailed.join(', ')})` : ''}`
      : `failed: ${failed.join(', ')}${advisoryFailed.length > 0 ? ` (advisory failed: ${advisoryFailed.join(', ')})` : ''}`
  return { ok: failed.length === 0, reason, items, advisory, advisoryFailed }
}

/**
 * 真实可用性探测（三级门）。同步、无副作用（除写暂存根里的探测产物）。
 *
 *   门 1 产物层：DLL 存在 + x64 PE + 必需导出；injector / probe 可执行文件存在。
 *   门 2 激活层：一次性进程里 `winstage-probe.exe selftest` 能加载 DLL 且
 *               `stats.initialized=true`；注入器对 `cmd /c exit 0` 金丝雀退出 0。
 *   门 3 能力层：**经注入器启动的金丝雀子进程**里四类能力真的恢复。
 *
 * 只有三级全过才返回 `available: true`。任何一环失败都如实记入 `checks` 并给出
 * `reason` —— 调用方据此 fail-closed 回退受限令牌模式。
 */
/** 载体初始化失败的**机器可读前缀**（`probe.reason` / `fallbackReason` 的开头） */
export const CARRIER_INIT_FAILED_PREFIX = 'carrier-init-failed'

/** 32 位退出码的十六进制形态（`4294901760` → `0xFFFF0000`；非整数如实返回字符串） */
export function formatExitCode(code) {
  if (typeof code !== 'number' || !Number.isFinite(code)) return String(code)
  return `0x${(code >>> 0).toString(16).toUpperCase().padStart(8, '0')}`
}

/**
 * 诊断文本的**头+尾**裁剪（替代裸 `.slice(0, 200)`）。
 *
 * 为什么（BUG-carrier-init-failure §0 / §6.1-4，实测）：`:4444` 原来的 `.slice(0, 200)`
 * 恰好把最关键的内层码切掉 —— `(Exception from HRESULT: 0x8007054F)` 被切成
 * `(Exception from HRESUL`，于是日志里再也看不到 HRESULT，排查只能靠猜。
 * 那不是日志写入截断，是**这一行的切片**。
 *
 * 保留**尾部**是有意的：Win32 / CLR 的 HRESULT、退出码、异常码按惯例出现在消息**结尾**
 * （`… (Exception from HRESULT: 0x8007054F)`），只保头部必然把它们切掉。
 * 中间被省略的字符数如实写出来，不假装文本是完整的。
 */
export function clipDiagnostic(text, head = 320, tail = 160) {
  const value = String(text ?? '')
  if (value.length <= head + tail) return value
  return `${value.slice(0, head)} … [+${value.length - head - tail} chars elided] … ${value.slice(-tail)}`
}

/**
 * 进程内透明档位探测缓存。
 *
 * 为什么要缓存：`probeTransparentShim()` 要跑**金丝雀**（注入 shim 到子进程、跑三级能力脚本），
 * 而 `dsh-plugin/shell-executor.mjs` 是**每条命令新建一个执行器**的 ⇒ 不缓存就等于每条命令
 * 都交一次金丝雀的钱（实测约 1~2 s）。金丝雀的结论只取决于（产物 stat + 暂存根 + 环境能力），
 * 在同一个进程内不会变。
 *
 * 键里带**产物 stat**，所以 `tools/build-shim.mjs` 重建之后同进程再探测不会拿到旧结论；
 * `options.refresh === true` 或 `options.cache === false` 可强制重跑（能力探测/自测用）。
 */
const transparentProbeCache = new Map()

function transparentProbeCacheKey(options, artifacts, stageRoot, captureDir) {
  if (options.cache === false || options.refresh === true) return undefined
  const stat = (p) => {
    try {
      const s = statSync(p)
      return `${s.size}@${Math.trunc(s.mtimeMs)}`
    } catch {
      return 'missing'
    }
  }
  return JSON.stringify([
    artifacts.dllPath,
    stat(artifacts.dllPath),
    artifacts.injectorPath,
    stat(artifacts.injectorPath),
    artifacts.probePath,
    stat(artifacts.probePath),
    stageRoot,
    captureDir,
    options.timeoutMs ?? 60000,
    options.extraPassthrough ?? null,
  ])
}

/**
 * 透明档位探测（带进程内缓存）。见 `transparentProbeCache` 的说明。
 *
 * @param {object} [options] 透传给 `probeTransparentShimUncached()`；另有
 *   `cache:false` / `refresh:true` 强制不走缓存。
 */
export function probeTransparentShim(options = {}) {
  const artifacts = options.artifacts ?? resolveShimArtifacts(options)
  const stageRoot = typeof options.stagingRoot === 'string' && options.stagingRoot.length > 0 ? resolve(options.stagingRoot) : options.stagingRoot
  const captureDir = resolve(options.captureDir || stageRoot || tmpdir())
  const key = transparentProbeCacheKey(options, artifacts, stageRoot, captureDir)
  if (key !== undefined) {
    const hit = transparentProbeCache.get(key)
    if (hit !== undefined) return hit
  }
  const result = probeTransparentShimUncached({ ...options, artifacts, stagingRoot: stageRoot, captureDir })
  /**
   * ── C2（BUG-carrier-init-failure §5）：**只缓存成功**，失败结论绝不入缓存 ─────────
   *
   * 旧实现（`:4277` 无条件 `set`）把**失败**结论也缓存 ⇒ 金丝雀抖一次就被**同一个宿主
   * 进程永久钉死**：`dsh-plugin/shell-executor.mjs:1195` 每条命令新建执行器，但探测缓存是
   * **宿主进程级**的，于是后续每条命令都直接复用那次失败的 `restricted-token` 回退。
   * 实测旁证：某 session 尾部**连续 27 次** `restricted-token`（报告 §3.4 确证 14 / I6）。
   *
   * 反向（成功入缓存）必须保留：金丝雀成本实测约 1~2 s，且结论只取决于
   * （产物 stat + 暂存根 + 环境能力），同进程内不会变（见上面 `transparentProbeCache` 注释）。
   * 代价说明（诚实声明）：载体**稳定**失败时（例如这台机器的 PowerShell 每次都起不来），
   * 缓存不再兜住 ⇒ 每条命令都会重新付一次探测成本（最坏 `1 + carrierRetries` 次金丝雀）。
   * 这是有意的取舍：**宁可慢，不可静默粘住**。
   */
  if (key !== undefined && result?.available === true) transparentProbeCache.set(key, result)
  return result
}

function probeTransparentShimUncached(options = {}) {
  const checks = []
  const record = (name, ok, detail) => {
    checks.push({ name, ok, detail })
    return ok
  }
  const artifacts = options.artifacts ?? resolveShimArtifacts(options)
  const stageRoot = typeof options.stagingRoot === 'string' && options.stagingRoot.length > 0 ? resolve(options.stagingRoot) : options.stagingRoot
  const captureDir = resolve(options.captureDir || stageRoot || tmpdir())
  const timeoutMs = options.timeoutMs ?? 60000
  const done = (available, reason, extra = {}) => ({
    available,
    reason,
    artifacts,
    checks,
    abiVersion: extra.abiVersion,
    stats: extra.stats,
    canary: extra.canary,
    canaryJudge: extra.canaryJudge,
    configPath: extra.configPath,
    logPath: extra.logPath,
    transport: 'winstage-inject.exe (remote LoadLibraryW; T4 contract)',
  })

  const dll = probeShimDll(artifacts.dllPath)
  record('shim-dll', dll.ok, dll.detail)
  const injectorOk = existsSync(artifacts.injectorPath)
  record('shim-injector', injectorOk, injectorOk ? artifacts.injectorPath : `not found: ${artifacts.injectorPath}`)
  const probeOk = existsSync(artifacts.probePath)
  record('shim-probe-exe', probeOk, probeOk ? artifacts.probePath : `not found: ${artifacts.probePath}`)
  if (!dll.ok || !injectorOk || !probeOk) {
    return done(false, checks.find((entry) => !entry.ok)?.detail ?? 'shim artifacts incomplete')
  }
  if (typeof stageRoot !== 'string' || stageRoot.length === 0) {
    record('shim-stage-root', false, 'stagingRoot is required for the transparent mode')
    return done(false, 'stagingRoot is required for the transparent mode')
  }

  try {
    mkdirSync(stageRoot, { recursive: true })
  } catch (error) {
    record('shim-stage-root', false, `cannot create ${stageRoot}: ${error.message}`)
    return done(false, `cannot create ${stageRoot}: ${error.message}`)
  }
  const logPath = options.logPath || join(stageRoot, 'shim.log')
  let configPath
  try {
    configPath = writeShimConfig({ stageRoot, logPath, extraPassthrough: options.passthrough ?? [] }).configPath
    record('shim-config', true, configPath)
  } catch (error) {
    record('shim-config', false, `cannot write ${stageRoot}\\winstage-shim.config.json: ${error.message}`)
    return done(false, `cannot write the shim config: ${error.message}`)
  }
  // 只传递 shim 自己的契约变量 + 允许清单环境（**不设** WINSTAGE_SHIM_DISABLE ——
  // 设了就等于"shim 完全不生效"，那是裸跑）。
  // 环境用允许清单构造而不是随手拼：金丝雀要跑 PowerShell 与 node，缺 TEMP/PATHEXT
  // 之类会让它们自己先失败，从而把"环境没配好"误判成"shim 不可用"。
  const canaryTemp = options.tempDir ? resolve(options.tempDir) : join(stageRoot, '.canary-temp')
  mkdirSync(canaryTemp, { recursive: true })
  const allowlisted = buildChildEnvironment({}, { tempDir: canaryTemp, cwd: stageRoot }).env
  const shimEnv = {
    ...allowlisted,
    WINSTAGE_STAGE_ROOT: stageRoot,
    WINSTAGE_SHIM_LOG: logPath,
    WINSTAGE_SHIM_CONFIG: configPath,
    // The canary must use the SAME overlay location as the real runs, otherwise the
    // probe's own `registry/overlay*.hive` lands inside the staged tree and the
    // host's "collect staged-tree changes" step tries to ingest it (self-referential
    // entry; observed as `EPERM ... overlay.<pid>.hive.LOG1`).
    ...(typeof options.registryStageDir === 'string' && options.registryStageDir.length > 0
      ? {
          WINSTAGE_REGSTAGE_SESSION_DIR: options.registryStageDir,
          DSH_REGSTAGE_ROOT: options.registryStageDir,
        }
      : {}),
  }

  // ── 门 2a：一次性短命进程里加载 DLL（T4 明确要求不要在宿主里 LoadLibrary）──
  const selftestPath = join(captureDir, `.winstage-selftest-${randomUUID().slice(0, 6)}.json`)
  const selftestRun = runCapturedToFiles(artifacts.probePath, ['selftest', artifacts.dllPath, selftestPath], {
    cwd: stageRoot,
    env: shimEnv,
    timeoutMs,
    captureDir,
  })
  let selftest
  try {
    selftest = existsSync(selftestPath) ? JSON.parse(readFileSync(selftestPath, 'utf8')) : undefined
  } catch {
    selftest = undefined
  }
  const abiVersion = selftest?.abiVersion ?? selftest?.abi
  const abiOk = abiVersion === SHIM_ABI_VERSION
  // T4 的 probe 把 StatsJson 作为**字符串**放在 `statsRaw` 里（不是嵌套对象）。
  // 曾经按 `selftest.stats.initialized` 读 ⇒ 永远 undefined ⇒ 把"已初始化"误判成
  // "不可用"，TS 模式会永久回退（假失败）。两种形态都支持，并把原始统计留证据。
  const stats = parseJsonMaybe(selftest?.statsRaw) ?? selftest?.stats ?? selftest?.selftestStats
  const initialized = stats?.initialized === true || selftest?.initialized === true
  const hooksInstalled = stats?.hooksInstalled === true
  record(
    'shim-selftest',
    abiOk && initialized,
    `probe exit=${selftestRun.code}; loaded=${selftest?.loaded} abi=${abiVersion} initReturn=${selftest?.initReturn} ` +
      `initialized=${initialized} hooksInstalled=${hooksInstalled} iatSites=${stats?.hooks?.iatSites ?? 'n/a'} modules=${stats?.hooks?.modules ?? 'n/a'}; ${String(selftestRun.err).slice(0, 200)}`,
  )
  try {
    unlinkSync(selftestPath)
  } catch {
    /* 清理失败不影响判定 */
  }
  if (!abiOk || !initialized) {
    return done(false, `shim selftest did not prove an initialized ABI ${SHIM_ABI_VERSION} DLL`, { abiVersion, configPath, logPath, stats })
  }

  // ── 门 2b + 门 3：经注入器跑能力金丝雀 ─────────────────────────────────────
  const canaryScriptPath = join(stageRoot, '.winstage-canary.ps1')
  try {
    writeFileSync(canaryScriptPath, `\uFEFF${buildCapabilityCanaryScript()}\r\n`, 'utf8')
  } catch (error) {
    record('shim-canary-script', false, `cannot write ${canaryScriptPath}: ${error.message}`)
    return done(false, `cannot write the canary script: ${error.message}`, { abiVersion, configPath, logPath })
  }
  const reportPath = join(captureDir, `.winstage-inject-report-${randomUUID().slice(0, 6)}.json`)
  // ★ 目标必须是**绝对路径**：T4 的注入器把目标传给 `lpApplicationName`，不做
  // PATH/PATHEXT 解析 ⇒ 裸名字（`powershell.exe`）会以 Win32 2 失败、注入器退出 111、
  // 报告 `cannot create the target process`。这与本项目"缺陷 6"是同一类错误。
  let canaryTarget = options.canaryTarget
  if (!canaryTarget) {
    try {
      canaryTarget = resolveExecutable('powershell', { env: shimEnv, cwd: stageRoot })
    } catch {
      canaryTarget = 'powershell.exe'
    }
  }
  let canaryRun
  let injectReport
  /**
   * ── C1 + C2：把"注入器健康"与"载体存活"解耦，并对**载体**失败做有限重试 ──────────
   *
   * `shim/injector/winstage-inject.c:491-492` 把**被注入子进程**的退出码原样当注入器自己的
   * 退出码（`GetExitCodeProcess(pi.hProcess, &childExit); rc = (int)childExit;`），而报告里的
   * `ok:true`（`:498-504`）只表示远程 `LoadLibraryW` 成功。⇒ `injector exit=4294901760
   * report.ok=true` **不是自相矛盾**，它说的是两个不同进程：注入器成功，载体（`powershell.exe`）
   * 自己在 CLR/.NET 初始化期退出（`0xFFFF0000`，同族还有 `0x8007054F` / `0x800700b7` /
   * `0xE0434352` / `0xC0000142`）。旧判据只有 `canaryRun.code === 0`，于是这条路径与
   * "注入器坏"混成同一个 `shim-inject-canary` fail，下游只能靠正则猜（报告 §1.2 / §4）。
   *
   * 重试**只针对** `注入器 ok && 子进程非 0`：产物缺件与注入器自身失败都是**稳定**失败，
   * 重试纯浪费（报告 §5 C2 风险③）。超时也不重试 —— 把 60 s 超时放大成 3×60 s 只会让命令
   * 挂得更久，而载体初始化失败是**快速退出**、不是挂住。
   * 重试的副作用面：金丝雀脚本只读系统信息 + 在 `TEMP` 下写一个自己删掉的临时文件
   * （`buildCapabilityCanaryScript()`）；且载体在初始化期就死了，脚本根本没执行。
   * **失败仍然 fail-closed**：`available` 仍由 `checks.every(ok)` 决定，重试只影响"判几次"，
   * 不影响"判成什么"，也不放宽任何 `available` / 安全判据。
   */
  const maxCarrierAttempts = Math.max(1, Math.min(5, Number.isInteger(options.carrierRetries) ? options.carrierRetries : 3))
  const carrierAttempts = []
  for (let attempt = 1; attempt <= maxCarrierAttempts; attempt += 1) {
    // 报告文件每轮先删：注入器是否截断旧报告未在源码级确认，读到上一轮的报告会把
    // "本轮注入器没写报告"误判成"注入器 ok"。
    try {
      unlinkSync(reportPath)
    } catch {
      /* 不存在即目标状态 */
    }
    canaryRun = runCapturedToFiles(
      artifacts.injectorPath,
      [
        '--dll',
        artifacts.dllPath,
        '--report',
        reportPath,
        '--',
        canaryTarget,
        '-NoLogo',
        '-NonInteractive',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        canaryScriptPath,
      ],
      { cwd: stageRoot, env: shimEnv, timeoutMs, captureDir },
    )
    try {
      injectReport = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : undefined
    } catch {
      injectReport = undefined
    }
    const attemptInjectorHealthy = injectReport?.ok === true
    const attemptChildStarted = canaryRun.code === 0
    carrierAttempts.push({
      attempt,
      exit: canaryRun.code,
      injectorOk: attemptInjectorHealthy,
      childStarted: attemptChildStarted,
      timedOut: canaryRun.timedOut === true,
    })
    const carrierOnlyFailure = attemptInjectorHealthy && !attemptChildStarted && canaryRun.timedOut !== true
    if (carrierOnlyFailure && attempt < maxCarrierAttempts) continue
    break
  }
  /** 注入器**自身**健康：只读它报告的 `ok`（远程 `LoadLibraryW` 结果），与载体存活无关 */
  const injectorHealthy = injectReport?.ok === true
  /** 载体**存活/可用**：注入器把子进程退出码透传上来，所以这一位才是"载体起没起来" */
  const childStarted = canaryRun.code === 0
  const carrierInitFailed = injectorHealthy && !childStarted
  /**
   * `available` 的判据**逐字保持原样**（旧写法 `code === 0 && report.ok !== false && code !== 111`；
   * `code === 0` 已蕴含 `code !== 111`，两条等价）。本次只改分类与文案，不放宽安全判据。
   */
  const injectionOk = childStarted && injectReport?.ok !== false
  const attemptsNote =
    carrierAttempts.length > 1
      ? ` carrierAttempts=${carrierAttempts.length}/${maxCarrierAttempts} carrierExits=[${carrierAttempts.map((entry) => formatExitCode(entry.exit)).join(', ')}]`
      : ''
  const injectorDetail = `injector exit=${canaryRun.code} (${formatExitCode(canaryRun.code)}) (111=injection failure) report.ok=${injectReport?.ok ?? 'n/a'}${attemptsNote}`
  record(
    'shim-inject-canary',
    injectionOk,
    carrierInitFailed
      ? `${CARRIER_INIT_FAILED_PREFIX}: injectorOk=true childExit=${canaryRun.code} (${formatExitCode(canaryRun.code)}); the injector succeeded but the carrier process (target=${canaryTarget}) died during its own initialization; ${injectorDetail} ${clipDiagnostic(injectReport?.error ?? canaryRun.err)}`
      : `${injectorDetail} ${clipDiagnostic(injectReport?.error ?? canaryRun.err)}`,
  )
  const logExists = existsSync(logPath)
  let logTail = ''
  try {
    logTail = logExists ? readFileSync(logPath, 'utf8').slice(-400) : ''
  } catch {
    logTail = ''
  }
  record('shim-log-observed', logExists, logExists ? `${logPath}: ${logTail.replace(/\s+/g, ' ').slice(0, 200)}` : `no shim log at ${logPath}`)
  const canary = parseMarkerJson(canaryRun.out)
  const canaryJudge = judgeCanary(canary)
  record(
    'shim-canary-capabilities',
    canaryJudge.ok,
    `${canaryJudge.reason}; target=${canaryTarget}; stderr=${String(canaryRun.err).replace(/\u0000/g, '').replace(/\s+/g, ' ').slice(0, 300)}; raw=${JSON.stringify(canary ?? {}).slice(0, 300)}`,
  )
  for (const path of [reportPath, canaryScriptPath]) {
    try {
      unlinkSync(path)
    } catch {
      /* 清理失败不影响判定 */
    }
  }
  /* ★ WP13 §4 修复（第二半）：`shim-log-observed` 是**诊断证据**，不是能力证明 ——
   * 能力已由 `shim-selftest`（同进程 ABI + init）、`shim-inject-canary`（注入成功且载体
   * 起得来）与 `shim-canary-capabilities`（金丝雀回传 marker）三项证明。把它算进闸门，
   * 会让"日志落点"这类**观测口径**问题直接降档（实测：整个会话被钉死在 restricted-token）。
   * 因此它仍然**报告**（保留机检证据），但不参与 `available` 判定。 */
  const available = checks.filter((entry) => entry.name !== 'shim-log-observed').every((entry) => entry.ok)
  return done(available, available ? 'transparent shim is available and capability-proven' : (checks.find((entry) => !entry.ok)?.detail ?? 'transparent shim not proven'), {
    abiVersion,
    canary,
    canaryJudge,
    configPath,
    logPath,
  })
}

/**
 * 去令牌化启动器：经 T4 的 `winstage-inject.exe` 启动子进程。
 *
 * stdout/stderr 由**调用方**用文件描述符重定向（注入器只负责继承），
 * 因此这条路径在"管道修复前"也能采集输出（README §1.1 / R10）。
 *
 * 诚实声明（已知缺口）：这里的子进程**不在 Job Object 里**——注入器是它自己
 * `CreateProcess` 出来的目标进程，宿主拿不到那个进程句柄。因此进程树回收用
 * `taskkill /T /F <injectorPid>`，而不是 Job 的 KILL_ON_JOB_CLOSE。
 * 这条限制不得被读成"进程树回收仍然成立"。
 */
export class ShimLauncher {
  constructor(api, options = {}) {
    this.api = api
    this.options = options
    this.artifacts = options.artifacts
    this.env = options.env ?? {}
    this.captureDir = options.captureDir
    this.spawn = typeof options.spawn === 'function' ? options.spawn : spawnCapturedAsync
    this.tracked = new Set()
    this.lastLaunch = undefined
  }

  /** 启动一个去令牌化子进程并等它退出（输出经文件描述符重定向读回） */
  async launch({ command, args = [], cwd, env, timeoutMs = 120000 }) {
    if (!this.artifacts?.injectorPath || !this.artifacts?.dllPath) {
      throw fail('TS_UNAVAILABLE', 'transparent launcher has no injector/DLL (fail-closed; refusing to run unconfined)')
    }
    const captureDir = resolve(this.captureDir || cwd || tmpdir())
    mkdirSync(captureDir, { recursive: true })
    const reportPath = join(captureDir, `.winstage-inject-${randomUUID().slice(0, 6)}.json`)
    const argv = ['--dll', this.artifacts.dllPath, '--report', reportPath, '--', command, ...args]
    const started = Date.now()
    const outcome = await this.spawn(this.artifacts.injectorPath, argv, {
      cwd,
      env: { ...this.env, ...(env ?? {}) },
      timeoutMs,
      captureDir,
    })
    this.tracked.delete(outcome.pid)
    let report
    try {
      report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : undefined
    } catch {
      report = undefined
    }
    try {
      unlinkSync(reportPath)
    } catch {
      /* 清理失败不影响判定 */
    }
    this.lastLaunch = {
      pid: outcome.pid,
      injectorExit: outcome.code,
      timedOut: outcome.timedOut,
      injectionReport: report,
      durationMs: Date.now() - started,
      dllPath: this.artifacts.dllPath,
      injectorPath: this.artifacts.injectorPath,
      streamsKind: 'file-descriptor-redirect (no named pipes)',
      jobAssigned: false,
    }
    if (outcome.code === SHIM_INJECT_FAILURE_EXIT || report?.ok === false) {
      throw fail(
        'TS_INJECTION_FAILED',
        `winstage-inject.exe refused to start the child (exit ${outcome.code}, report.ok=${report?.ok}): ` +
          `${report?.error ?? outcome.err.slice(0, 300)} — refusing to continue unconfined (fail-closed)`,
      )
    }
    return {
      pid: outcome.pid,
      exitCode: outcome.code,
      timedOut: outcome.timedOut,
      stdout: outcome.out,
      stderr: outcome.err,
      injectionReport: report,
    }
  }

  /** 回收：杀掉仍被跟踪的注入器进程树（尽力而为，失败如实返回） */
  terminateAll(exitCode = 1) {
    const failures = []
    for (const pid of [...this.tracked]) {
      const killed = killProcessTree(pid)
      this.tracked.delete(pid)
      if (!killed.ok) failures.push(`${pid}: ${killed.detail}`)
    }
    return failures
  }

  dispose() {
    return this.terminateAll()
  }
}

/**
 * 异步版"文件描述符重定向"启动：绝不使用管道。
 * 超时用 `taskkill /T /F` 回收整棵树（注入器 + 它的目标进程）。
 */
export async function spawnCapturedAsync(file, args, options = {}) {
  const captureDir = options.captureDir || options.cwd || tmpdir()
  mkdirSync(captureDir, { recursive: true })
  const stamp = `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
  const outPath = join(captureDir, `.winstage-run-${stamp}.out`)
  const errPath = join(captureDir, `.winstage-run-${stamp}.err`)
  const outFd = openSync(outPath, 'w')
  const errFd = openSync(errPath, 'w')
  let child
  try {
    child = spawnChildProcess(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', outFd, errFd],
      windowsHide: false,
    })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const pid = child.pid
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killProcessTree(pid)
  }, options.timeoutMs ?? 120000)
  if (typeof timer.unref === 'function') timer.unref()
  const settled = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, failure: error.message }))
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timer)
  const out = readTextFile(outPath)
  const err = readTextFile(errPath)
  for (const path of [outPath, errPath]) {
    try {
      unlinkSync(path)
    } catch {
      /* 清理失败不影响判定 */
    }
  }
  return { pid, code: settled.code, signal: settled.signal, timedOut, error: settled.failure, out, err }
}

/** 在 `root` 下递归找一个文件名（去令牌化自检用：确认写入真的落进暂存树） */
export function findFileUnder(root, name, depth = 0) {
  if (depth > 12) return undefined
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = findFileUnder(full, name, depth + 1)
      if (nested) return nested
      continue
    }
    if (entry.name === name) return full
  }
  return undefined
}

function readTextFile(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : ''
  } catch {
    return ''
  }
}

/** 解析"可能是 JSON 字符串、也可能已是对象"的值（T4 的 `statsRaw` 是字符串） */
export function parseJsonMaybe(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'object') return value
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** `taskkill /T /F` 回收整棵进程树（失败如实返回，不抛） */
export function killProcessTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return { ok: false, detail: 'invalid pid' }
  try {
    const result = spawnSyncChildProcess('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    return { ok: result.status === 0, detail: `taskkill exit=${result.status}` }
  } catch (error) {
    return { ok: false, detail: error.message }
  }
}

/**
 * 档位 → 运行模式的**纯函数**判定（离线可测）。
 *
 *   T0            → appcontainer（AppContainer 执行路径）
 *   TS / auto     → 探测通过则 shim，否则 **fail-closed 回退 restricted-token**
 *   其它（T1/…）  → restricted-token
 *
 * 注意"回退"指的是**回退到受限令牌模式**（仍然被强制），不是"裸跑"。
 */
export function selectLaunchMode(requested, probe) {
  const want = String(requested ?? 'T1').toUpperCase()
  if (want === 'T0') return { mode: 'appcontainer', tierEffective: 'T0', fallbackReason: undefined }
  if (want === TRANSPARENT_TIER || want === 'AUTO') {
    if (probe?.available === true) {
      return { mode: 'shim', tierEffective: TRANSPARENT_TIER, fallbackReason: undefined }
    }
    const reason = probe?.reason ?? 'not probed'
    /**
     * ★ C1（BUG-carrier-init-failure §4.2 / §4.3(a)）：探测原因已带**机器可读前缀**
     * （形如 `carrier-init-failed: …`）时，**不再**把它套进 `transparent shim unavailable (…)`。
     *
     * 为什么这不是文案口味问题：实测 347 字符的原始 `fallbackReason` 被
     * `classifyLaneFallback` 归成 `probe-failed`，而**唯一命中项是外壳词 `unavailable`**
     * —— 分类结果是**外壳措辞的函数**，不是真实原因的函数；剥掉外壳后同一条原因立刻退化成
     * `unclassified`。前缀一旦被外壳包住，分类器就只能靠正则猜，前缀也就白加了。
     * 后果描述（fail-closed 回退目标）仍然保留在尾部，且分类器本来就会剥掉它。
     */
    return {
      mode: 'restricted-token',
      tierEffective: 'T1',
      fallbackReason: /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:/.test(reason)
        ? `${reason} — fail-closed fallback to the restricted-token mode`
        : `transparent shim unavailable (${reason}) — fail-closed fallback to the restricted-token mode`,
    }
  }
  return { mode: 'restricted-token', tierEffective: want || 'T1', fallbackReason: undefined }
}

export const __internal = { ps, win32Error, OFF, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE }
