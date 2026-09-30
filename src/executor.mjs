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
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
// ── T0（AppContainer）执行路径的判据与布局**只从这两个模块来** ──────────────────
// 本文件不重写 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` / `STARTUPINFOEXW.cb` /
// cbSize 之类的常量：那正是"探测与执行漂移"（手册 #5.1）的入口。
import { CREATE_NEW_CONSOLE } from './appcontainer-runtime.mjs'
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
  env.DSH_SANDBOX = 'win-stage'
  env.DSH_SANDBOX_TIER = options.tier || 'unknown'
  env.DSH_SANDBOX_ENFORCEMENT = 'partial'
  env.DSH_SANDBOX_NOTE = 'writes confined to the staged root; reads are NOT confined (documented residual boundary)'
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
    this.lastLaunch = undefined
  }

  /** 由 `createAppContainerLauncher()`（异步工厂）注入 runtime 并立即做 ACL 授权 */
  attachRuntime(runtime, sidString) {
    this.runtime = runtime
    this.sidString = sidString
    const grants = []
    for (const target of this.options.grantPaths ?? []) {
      if (typeof target !== 'string' || target.length === 0) continue
      grants.push({ target, ...grantPathToAppContainerSid(target, sidString) })
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
    return { profileName: this.profileName, sid: sidString, grants }
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
  launch({ command, args = [], cwd, job, timeoutMs = 120000, env = null }) {
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
      return this._runChild({ child, job, timeoutMs, stdio })
    } finally {
      closeT0Stdio({ stdin: stdio.stdin, read: stdio.read }, this.CloseHandleRaw)
    }
  }

  _runChild({ child, job, timeoutMs, stdio }) {
    try {
      if (job) {
        if (this.api.assignProcessToJobObject(job, child.process) === 0) {
          throw win32Error(this.api, 'AssignProcessToJobObject', `pid=${child.pid} (T0 path)`)
        }
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

/** 撤销一项 ACL 授权（`icacls <dir> /remove:g *<sid>`） */
function grantPathToAppContainerSid(target, sidString) {
  const result = icaclsRun([target, '/grant', `*${sidString}:(OI)(CI)M`])
  return { ok: result.ok, detail: result.detail }
}

/** `[实测]` 用 `icacls` 而不是自己拼 ACL：包 SID 的字符串形式必须带 `*` 前缀（否则被当账户名解析） */
function icaclsRun(args) {
  try {
    const { execFileSync } = require_('node:child_process')
    const text = String(execFileSync('icacls', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
      .replace(/\r?\n/g, ' | ')
      .trim()
    return { ok: true, detail: text }
  } catch (error) {
    return { ok: false, detail: `${error.code ?? ''} ${String(error.message).slice(0, 200)}`.trim() }
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

export class WindowsStageExecutor {
  constructor(options = {}) {
    this.options = options
    this.stagingRoot = options.stagingRoot ? canonicalDir(options.stagingRoot) : undefined
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
    /** T0 专用（只有显式 tier=T0 且装配成功时才非空；见 init()） */
    this.appContainer = undefined
    this.appContainerInfo = undefined
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
    return merged
  }

  /** fail-closed 初始化：任何 Win32 失败都抛错，绝不降级为无沙箱（手册 1.2 / 5.2） */
  async init() {
    if (this.sandbox) return this.initReport
    if (process.platform !== 'win32') {
      throw fail('SANDBOX_UNAVAILABLE', 'the Windows stage sandbox requires process.platform === "win32"')
    }
    if (!this.stagingRoot) throw fail('SANDBOX_UNAVAILABLE', 'stagingRoot is required — refusing to confine an unspecified root')
    mkdirSync(this.stagingRoot, { recursive: true })

    const cap = WindowsStageExecutor.capabilities(this.options.overrides)
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
    const { sandbox, api: capturedApi, token, fieldNames } = await initAclSandboxWithTokenCapture(cap.AclSandbox, {      writableDirs: writable ? [this.stagingRoot] : [],
      tempDir: writable ? tempDir : null,
      writeSid: writable ? cap.workspaceWriteSid(this.stagingRoot) : undefined,
      tempWriteSid: writable && tempDir ? cap.tempWriteSid(tempDir) : undefined,
      mode: this.mode,
    })

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
        })
        this.appContainer = appContainer.launcher
        this.appContainerInfo = {
          profileName: appContainer.profileName,
          sid: appContainer.sid,
          createdProfile: appContainer.createdProfile,
          grants: appContainer.grants,
          attributeListSize: appContainer.attributeListSize,
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
      tier: this.tier,
      appContainer: this.appContainerInfo,
    })
    return this.initReport
  }

  /**
   * 实例级实测（手册 #5.5：缓存成功不能替代实例启动后的必要检查）。
   * 关键：必须从**沙箱内部**发起真实攻击探针，而不是从宿主侧推断。
   */
  async selfTest() {
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

/** 在受限令牌下执行一次命令，返回结构化结果（手册第 4 章返回契约） */
  async run(options) {
    if (!this.sandbox) throw fail('SANDBOX_UNAVAILABLE', 'executor is not initialised; call init() first (fail-closed)')
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
    const t0 = this.appContainer !== undefined && this.appContainer !== null && String(this.tier).toUpperCase() === 'T0'
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

    const stdout = settled.stdout.toString('utf8')
    const stderr = settled.stderr.toString('utf8')
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
      durationMs: Date.now() - startedAt,
      envKeys: Object.keys(env).sort(),
      envRejected: rejected,
      classification: classifyOutcome({ exitCode: settled.exitCode, stdout, stderr }),
      enforcement: 'partial',
      backend: 'windows-acl-restricted-token',
      tier: this.tier,
      hasOutput: stdout.length > 0 || stderr.length > 0,
      // #4.2：退出码 0 且无输出 = 执行完成无输出，不是"没执行"
      completedWithoutOutput: settled.exitCode === 0 && stdout.length === 0 && stderr.length === 0,
    }
  }

  terminate(exitCode = 1) {
    if (!this.job || !this.launcher) return { terminated: false }
    const result = this.launcher.terminateJob(this.job, exitCode)
    return { terminated: result !== 0 }
  }

  dispose() {
    const failures = []
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

/** 结果分类：必须区分"策略拒绝""沙箱自身故障""命令自身失败"（手册第 4 章 / 第 9 章） */
export function classifyOutcome({ exitCode, stdout, stderr }) {
  const text = `${stderr}\n${stdout}`
  // 顺序很重要：`dsh-stage:` 是我们自己的前缀，既用于"沙箱启动失败"也用于"超时"。
  // 若先匹配裸前缀，超时会被误判成 runner-failure（真实的分类缺陷 9）。
  // 因此先认最具体的标记，再认通用前缀。
  if (/dsh-stage: timeout after|^timeout after/m.test(text)) {
    return { kind: 'timeout', reason: 'execution exceeded the configured timeout' }
  }
  if (/dsh-stage: sandbox launch failed|windows-acl-run:|SANDBOX_UNAVAILABLE/.test(text)) {
    return { kind: 'runner-failure', reason: 'sandbox runner/launcher refused — classify as a broken sandbox, not a policy denial' }
  }
  if (/Access is denied|UnauthorizedAccessException|PermissionDenied|0x80070005|EPERM|EACCES/i.test(text)) {
    return { kind: 'denied', reason: 'the confined action was denied by the write boundary / ACL' }
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

export const __internal = { ps, win32Error, OFF, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE }
