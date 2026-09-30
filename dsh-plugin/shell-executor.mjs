/**
 * WinStage 沙箱 shell 执行器 —— `ctx.shell` 的一个**替代**提供方。
 *
 * ── 它做什么 ────────────────────────────────────────────────────────────────
 * 继承 `@deepseek-ai/dsh-shell` 的 `ShellExecutor`（**运行时那一份**），把 DSH 的
 * `pwsh` 工具的每一次调用**真的关进 WinStage 沙箱**里执行：
 *
 *   dsh-tool-pwsh ──resolve/execute──▶ 本文件 ──▶ WindowsStageExecutor
 *                                                  （受限令牌 / ACL / Job Object）
 *                                                       │
 *                                                       ▼
 *                                      cwd = 暂存树；产出被捕获回清单 → 候选
 *
 * 命令的 **cwd 是暂存树**（`<store>/staged`），不是真实工作区；命令在暂存树里写下
 * 或删掉的东西由 `captureAfterExecution()` 抓回来，经 `ingestCapturedChanges()`
 * 并入清单、`freezeIfNeeded()` 冻结成待审候选 —— 与 `src/cli.mjs` 的 `exec` 分支
 * **同一条链、同一顺序**（那里的用法是这条流程的唯一权威）：
 *
 *   materializeForExecution → snapshotStagedTree → run(cwd=stagedDir)
 *     → captureAfterExecution → ingestCapturedChanges → freezeIfNeeded → dispose
 *
 * ── 为什么 `sandboxMode` 必须报 `undefined`（刻意，不是"没实现"）──────────────
 * `dsh-tool-pwsh` 在装配时读 `ctx.shell.sandboxMode`（dsh-tool-pwsh/lib/index.js:314-317）：
 *   `const defaultMode = ctx.shell.sandboxMode`
 *   `const escalationModes = defaultMode === void 0 ? [] : ESCALATION_TARGETS`
 *   `const sandboxPolicy = defaultMode === void 0 ? void 0 : ctx.get('sandboxPolicy')`
 *   `if (defaultMode !== void 0 && sandboxPolicy === void 0) throw new Error(...)`
 * 一旦我们报出一个模式，工具就：①**要求** `ctx.sandboxPolicy` 存在（拿不到整条插件
 * 加载失败）；②向模型广告 `sandbox_permissions`/`justification` 并走 `ctx.approval`
 * 的"升权"路径；③把 `sandboxPolicy` 塞进 `ShellExecRequest`，期望执行器**按它围栏**。
 * 而本设计里"升权"= 允许直写**主机**，与"绝不在主机上直接执行"直接冲突；
 * 围栏由 `WindowsStageExecutor` 的受限令牌 + ACL 提供，我们不接受任何更大权限的请求。
 * 所以这里如实报 `undefined`：不广告、不升权、不要 `ctx.sandboxPolicy`。
 * （与 `staging-fs.mjs` 在暂存面 `get sandboxMode() { return undefined }` 同一口径。）
 *
 * ── 三条必须遵守的契约（读 DSH 源码得到，违反会静默劣化）──────────────────────
 *   1. **fail-closed 是绝对的**：能力不可用 / `init()` 抛错 / 物化失败 / 拿不到
 *      `WindowsStageExecutor` / 定位不到暂存树 ⇒ **抛错**。任何情况下都**不退回**
 *      "在主机上直接跑" —— 那正是本插件存在的理由。错误文案必须明说
 *      "本次命令**没有执行**"，不许伪装成命令自身失败。
 *   2. `execute()` 返回**已结算**的句柄：契约明写"Expiry during preparation returns
 *      a **settled** timed-out handle without output"
 *      （dsh-shell/lib/types/index.d.ts:40），所以"跑完再构造句柄"是合法的。
 *      `status`/`exitCode`/`signal`/`done`/`result()`/`readOutput()`/`observed`/`kill()`
 *      逐项按 `ShellExecution` 填。
 *   3. 错误必须是**可归因**的：`dsh-tool-pwsh` 用 `result.aborted` / `isError` 判别。
 *      这里不 import 任何 DSH 核心包，只 import **本仓库**的 `src/executor.mjs`，
 *      并在运行时按 `resolveDshModuleRoot()` 找到的**绝对路径** import `dsh-shell`
 *      （与 `staging-fs.mjs:59-72` 同一写法，避免第二份 Service 基类实例问题）。
 *
 * ── 与同目录另一份 `shell-executor.mjs` 草稿的关系（如实说明）──────────────────
 * 写入前磁盘上已存在一份**别的写入者**留下的草稿（顶层 `await import(dsh-shell)` +
 * 要求 `options.workspaceRoot` + 固定起 `powershell -NoProfile -Command`）。本文件
 * 按派工单重写，与那份草稿的差异是**刻意的**：
 *   - 顶层 await → 移到 `execute()` 内（`loadBaseClass()`）：拿不到 DSH 包时给出
 *     **可读的 fail-closed 错误**，而不是让 loader 行加载失败；
 *   - `workspace` 由**构造时的字面值**改为**每次现读**（函数/带 `reload()` 的服务/
 *     实例三种形态都接受）：跨进程改动可见，装配方也能构造之后再挂；
 *   - `pwsh` 路径**显式解析**（PATH 上的 pwsh.exe → Windows PowerShell 5.1 兜底），
 *     不再硬编码 `powershell`；
 *   - 输出按 `CollectedOutput` 形状**有界捕获**（`truncated` 如实标注、不伪造 spillPath）；
 *   - 捕获/冻结的失败信息**随返回带出**（`winstage.capture.failures` + stderr 注记），
 *     不只是写日志。
 *
 * ── 如实声明的残余边界（不得读成"已经解决"）────────────────────────────────
 *   - **读取面不设限**：受限令牌只约束**写类**访问（WRITE_RESTRICTED + Low 完整性
 *     标签只做 no-write-up），沙箱内进程仍可读调用者可读的文件
 *     （`src/executor.mjs` 文件头"诚实声明"一节）。读取收敛仍靠 DSH 工具层遮蔽。
 *   - **命令字符串的解析**：DSH 的 pwsh 工具把整条 PowerShell 脚本放进 `spec.command`。
 *     这里只识别 `pwsh`/`powershell` 开头的**显式前缀**（含 `-NoLogo -NoProfile …` 这类
 *     开关）并剥掉，取 `-Command` 之后的**全部文本**作为**一个**参数（PowerShell 自己
 *     解析脚本，中间没有第二层 shell ⇒ 没有引号转义问题）。`-EncodedCommand` / `-File` /
 *     `-Version` 等其它形态**不解析**，原样留在参数里（不静默改写语义）。
 *   - **stdin 不支持**：`WindowsStageExecutor` 走 `CreateProcessAsUserW` + 管道，没有通到
 *     子进程 stdin 的通道。`spec.stdin` 被如实记入 error 级注记（不静默丢弃、不报成功）。
 *   - **没有"当场 kill"**：`execute()` 等 `executor.run()` 跑完才返回句柄，句柄一出生就是
 *     终态，`kill()` 只能返回 `false`；超时/中止是**跑完后如实分类**，真正的时限由
 *     `WindowsStageExecutor.run()` 自己的 timeout + `terminate(124)` 执行。
 *   - **环境**：子进程环境按执行器的允许清单**重建**（绝不 merge 父环境），另加
 *     `dshEnv` / `env` 覆盖与 `NO_COLOR`/`PAGER`/`GIT_PAGER`。名字像凭据的覆盖项会被
 *     执行器拒绝（`envRejected`），这里只如实记一条注记。
 */

import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WindowsStageExecutor, resolveDshModuleRoot } from '../src/executor.mjs'

// ==================== 常量 ====================

/**
 * 与 `@deepseek-ai/dsh-pwsh-local` 的同名配置**同值**（那边 lib/index.js:142-145
 * 的 `12e4 / 6e5 / 64e3`）。同值不是为了好看：`dsh-tool-pwsh` 会
 * `await handle.result()`，超时/输出预算一旦不一致，"同一台机器上换个执行器就换了行为"。
 */
export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_TIMEOUT_MS = 600_000
export const DEFAULT_MAX_OUTPUT_BYTES = 64_000

/**
 * 与 `dsh-pwsh-local` 逐字相同的两个事实源（那边 lib/index.js:87-100）：
 *   - 环境覆盖：`NO_COLOR`/`PAGER`/`GIT_PAGER`（不让分页器把命令挂住）；
 *   - UTF-8 前导：Windows PowerShell 5.1 默认按控制台代码页输出，非 ASCII 会乱码。
 * 这里**复制字面值**而不是 import `dsh-pwsh-local`：那份模块会把
 * `@deepseek-ai/schemastery` 与 `dsh-subprocess` 拉进加载图，而本插件只需要两个常量；
 * 值有变时以 `dsh-pwsh-local/lib/index.js` 为准（行号已钉在上面）。
 */
const ENV_OVERRIDES = { NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' }
const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

// ==================== 依赖定位 ====================

/**
 * 在候选 node_modules 根中定位**真实文件**（包的 exports 映射不作用于绝对 file: URL）。
 * 与 `staging-fs.mjs:44-57` 的 `locatePackageFile()` 同一写法 —— 同一个仓库里
 * "怎么找 DSH 的运行时那一份"只应该有一处口径。
 *
 * @param {string} relativePath 相对候选根的路径
 * @param {string[]} [rootsOverride] 仅自测注入（断言"定位不到 ⇒ fail-closed"时用）
 */
export function locatePackageFile(relativePath, rootsOverride) {
  let roots = []
  try {
    roots = rootsOverride ?? resolveDshModuleRoot() ?? []
  } catch {
    roots = []
  }
  for (const root of roots) {
    if (!root) continue
    const candidate = join(root, relativePath)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 没有基类时用的**中性**基类（自测/装配诊断用）。
 *
 * 为什么不让 `Base === undefined` 去 `extends undefined`：那会得到
 * `TypeError: Class extends value undefined is not a constructor or null` ——
 * 一个**加载期**的崩溃，而本模块承诺"拿不到 `dsh-shell` 是一条**可读的
 * fail-closed 错误**"（见 `loadBaseClass()`）。所以这里给一个中性基类：
 * 它什么都不做，于是 `execute()` 会照常走到 `loadBaseClass()` 并抛出
 * `WINSTAGE_SHELL_BASE_MISSING`。**生产装配不传 `base`**，这条只服务诊断路径。
 */
class NeutralShellExecutorBase {
  constructor() {}
}

// ==================== 依赖定位 ====================

/** 默认的 `@deepseek-ai/dsh-shell` 入口解析：拿不到返回 undefined（调用方 fail-closed） */
function defaultResolveShellModule() {
  return locatePackageFile(join('@deepseek-ai', 'dsh-shell', 'lib', 'index.js'))
}

/**
 * 平台**原生**执行器的入口：WinStage 开关关闭时用它把执行面**交还**给平台。
 *
 * 为什么必须有这条路径（这是一个实测出来的装配缺口）：
 *   `winstage-shell` 是拿 `ctx.shell` 这个**单例服务名**的**整体替换**提供方
 *   （profile 里 `pwsh-sandbox` 被 `disabled: true`）。与 `staging-fs` 不同 ——
 *   fs 侧 `extends LocalFileSystem` 可以靠 `super.writeText(...)` 回退，
 *   而 shell 侧**没有 `super` 可退**（基类 `ShellExecutor` 本身不执行任何东西）。
 *   于是"关掉开关"之后，本执行器仍占着服务名并继续按 `workspace-write` 围栏——
 *   实测后果：会话档位一旦是 `danger-full-access`，**每一条 pwsh 都被
 *   `WINSTAGE_SHELL_ESCALATION_NOT_SUPPORTED` 拒掉**，用户感知为"关了沙箱 shell 全废"。
 *   这与 `staging-fs.sandboxMode`（关闭时报 `super.sandboxMode`，行为与"没装插件"
 *   逐字一致）是同一个设计意图，只是 shell 侧必须**显式装载**平台实现才能兑现。
 */
const NATIVE_PWSH_MODULE = '@deepseek-ai/dsh-pwsh-local/lib/index.js'

/**
 * 解析本进程应当使用的 `pwsh` 可执行文件**绝对路径**。
 *
 * 为什么必须自己解析：`CreateProcessAsUserW` 不做 PATHEXT 解析，裸名字能不能命中
 * 完全取决于 PATH 形状（`src/executor.mjs` 的"[实测] 缺陷 6"）。解析顺序与
 * `dsh-pwsh-local` 的 `resolvePwshPath()` 一致：
 *   1. 配置里的 `pwshPath`（信任原值）；
 *   2. PATH 上的 `pwsh.exe`（含 Microsoft Store 的 alias —— 用 `lstatSync` 看入口本身，
 *      不跟随重解析点，否则会撞 Store alias 目标的 ACL）；
 *   3. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`（最后手段）。
 * 都不在 ⇒ 交回裸 `'pwsh'` 让执行器自己解析（失败会是一个明确的 exitCode=127，
 * 而不是静默换一个解释器）。
 */
export function resolvePwshPath(configured, env = process.env) {
  if (typeof configured === 'string' && configured.length > 0) return configured
  const spawnable = (candidate) => {
    try {
      const stat = lstatSync(candidate)
      return stat.isFile() || stat.isSymbolicLink()
    } catch {
      return false
    }
  }
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files'
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const candidates = [join(programFiles, 'PowerShell', '7', 'pwsh.exe')]
  for (const entry of String(env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    candidates.push(join(trimmed, 'pwsh.exe'))
  }
  candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  for (const candidate of candidates) if (spawnable(candidate)) return candidate
  return 'pwsh'
}

/**
 * `spec.command` → `{ command, args, recognized }`（**host 侧**解析，绝不经过 shell）。
 * 规则见文件头"命令字符串的解析"。
 *
 * 正则的三个细节都是**实测踩出来的**（自测 S4.10 / S4.10b 抓到过）：
 *   1. 开关与 `-Command` 之间的分隔 `\s+` **必须**存在，且开关模式自身以 `\s+` 收尾
 *      （`(?:-\S+\s+)*?`）。否则回溯会把 `-Command` 自己吸进 flags。
 *   2. `launcher` 用**预读** `(?=\s)` 而不是吞一个空格，并**排除**以 `-` 开头的 token：
 *      否则 `-NoLogo -NoProfile -Command x` 会把 `-NoLogo` 当成 launcher。
 *   3. 引号包裹的 launcher（`"C:\Program Files\PowerShell\7\pwsh.exe"`）单独一条分支。
 */
const PWSH_LEADING =
  /^(?:(?<launcher>"[^"]+"|(?!-)\S+)(?=\s)\s+)?(?<flags>(?:-\S+\s+)*?)-command\s+(?<script>[\s\S]+)$/i
const PWSH_EXE = /(?:^|[\\/])pwsh(?:\.exe)?$/i
const LEGACY_POWERSHELL_EXE = /(?:^|[\\/])powershell(?:\.exe)?$/i

export function buildCommandArgv(command, pwshPath) {
  const text = String(command ?? '')
  const match = PWSH_LEADING.exec(text)
  if (match?.groups?.script !== undefined) {
    const script = match.groups.script
    // launcher 可能是带引号的路径（`"C:\Program Files\PowerShell\7\pwsh.exe"`）——
    // 比较前**必须**把包裹引号脱掉，否则 `PWSH_EXE` 永远匹配不上（自测 S4.10c 抓到过）。
    const launcher = (match.groups.launcher ?? '').trim().replace(/^"|"$/g, '')
    const flags = String(match.groups.flags ?? '')
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0)
    // 只有"确实是 pwsh/powershell"才承认这是 shell 调用；否则按裸程序处理
    // （防止把 `foo.exe -Command x` 这种真实程序误当成解释器）
    if (launcher.length === 0 || PWSH_EXE.test(launcher) || LEGACY_POWERSHELL_EXE.test(launcher)) {
      return {
        command: pwshPath,
        args: [...flags, '-Command', `${ENCODING_PREAMBLE}${script}`],
        recognized: true,
      }
    }
  }
  // 三种落地形态（DSH pwsh 工具只会用第一种；后两种是"别人也调 ctx.shell"时的稳健性）：
  //   (a) 显式 `-Command` + 非 pwsh launcher（`foo.exe -Command x`）
  //       ⇒ 按"裸程序 + 参数"照原样跑。**绝不**给它塞一个 `-Command`（那是语义篡改）。
  //   (b) 其余一切 ⇒ 文本就是**一段 PowerShell 脚本**（DSH 工具的正常形态：
  //       `New-Item -ItemType File -Path create.txt`）。交给 `pwsh -Command <整段>`，
  //       PowerShell 自己解析。**不能**把它当程序名去 spawn —— 那是一个 100% 失败
  //       且语义错误的降级（自测 S4.10b 抓到过）。
  const foreignCommand = /^(?:"[^"]+"|(?!-)\S+)(?=\s)\s+(?:-\S+\s+)*-command\s+[\s\S]+$/i.test(text)
  if (!foreignCommand) {
    return { command: pwshPath, args: ['-Command', `${ENCODING_PREAMBLE}${text}`], recognized: true }
  }
  const tokens = text.match(/"[^"]*"|\S+/g) ?? []
  const first = (tokens[0] ?? '').replace(/^"|"$/g, '')
  if (first.length === 0) return { command: pwshPath, args: ['-Command', ENCODING_PREAMBLE], recognized: false }
  return {
    command: first,
    args: tokens.slice(1).map((token) => token.replace(/^"|"$/g, '')),
    recognized: false,
  }
}

// ==================== 小工具 ====================

/** 从 config 取一个数值（兼容 schemastery 的 `.get()` 与纯对象两种形态） */
function numericOption(raw, key, fallback) {
  const slot = raw?.[key]
  const value = slot && typeof slot === 'object' && typeof slot.get === 'function' ? slot.get() : slot
  return Number.isFinite(value) && value > 0 ? Number(value) : fallback
}

function stringOption(raw, key) {
  const slot = raw?.[key]
  const value = slot && typeof slot === 'object' && typeof slot.get === 'function' ? slot.get() : slot
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 有界捕获一条输出流，返回 `CollectedOutput` **形状**（`{text, truncated}`）。
 * 与 `dsh-subprocess` 的 `CollectedOutput` 逐字对齐：`text` 是**尾部**，`truncated`
 * 表示丢过字节。`spillPath` 只在真有完整落盘文件时才出现 —— 这里没有（见文件头
 * 残余边界），因此**不伪造** spill 路径（宁可少一个字段，也不给一个读不到的文件名）。
 */
function boundedOutput(text, maxBytes) {
  const buffer = Buffer.from(text ?? '', 'utf8')
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_OUTPUT_BYTES
  if (buffer.length <= cap) return { text: buffer.toString('utf8'), truncated: false }
  return { text: buffer.subarray(buffer.length - cap).toString('utf8'), truncated: true }
}

/**
 * 一个最小可用的 offset reader（`SubprocessOutputReader` 契约）。
 *
 * ⚠ 字段名以 DSH 源码为准（本单曾让我确认）：`SubprocessOutputRead` 的
 * "下一个偏移"字段是 **`nextOffset`**（不是 `next`/`offset`），见
 * `dsh-subprocess/lib/types/types.d.ts:113-123`。`dsh-tool-pwsh:69-77` 就是照它写的。
 */
export function makeOffsetReader(text) {
  const buffer = Buffer.from(String(text ?? ''), 'utf8')
  return {
    readFrom(fromByte) {
      const from = Number.isFinite(fromByte) && fromByte > 0 ? Math.floor(fromByte) : 0
      const lossy = from > buffer.length
      return {
        text: buffer.subarray(lossy ? 0 : from).toString('utf8'),
        nextOffset: buffer.length,
        lossy,
      }
    },
  }
}

/** 结构化错误：每个 fail-closed 分支都要能被人一眼归因（并明说"没有执行"） */
export function shellFailure(code, message) {
  const error = new Error(`winstage-shell: ${message}`)
  error.code = code
  error.winstage = { code, executed: false }
  return error
}

/**
 * 从各种可接受的 `workspace` 注入形态里取出**当前**的 `Workspace`。
 *   1. 函数 ⇒ `() => Workspace`（生产：`getReviewService(...).reload().workspace`）
 *   2. 有 `reload()` 的服务对象 ⇒ 重新读一遍再取 `.workspace`（跨进程改动可见）
 *   3. 直接就是 Workspace 实例
 */
export function currentWorkspaceOf(source) {
  if (!source) return undefined
  if (typeof source === 'function') return currentWorkspaceOf(source())
  if (typeof source === 'object' && typeof source.reload === 'function') {
    try {
      source.reload()
    } catch {
      /* reload 失败不致命：下面照常读 .workspace */
    }
    return source.workspace ?? source
  }
  return source
}

// ==================== 工厂 ====================

/**
 * 构造 WinStage 沙箱 shell 执行器类。
 *
 * @param {object} [options]
 * @param {object|Function} [options.workspace] 生产：`Workspace` 实例、`() => Workspace`，
 *   或带 `reload()` 的审阅服务对象。自测：注入替身即可（不需要真实工作区/沙箱）。
 * @param {object} [options.store] 退路：只给 store（至少有 `stagedDir`）。
 * @param {Function} [options.base] **仅自测**：`ShellExecutor` 基类替身。生产不要传。
 * @param {Function} [options.resolveShellModule] **仅自测**：返回 `dsh-shell` 入口绝对路径。
 * @param {Function} [options.createExecutor] **仅自测**：`(opts) => {init, run, dispose, capabilities}`。
 * @param {Function} [options.log] 信息级日志。
 * @param {Function} [options.logError] error 级日志（"失败必须响"）。
 * @param {object} [options.config] 默认配置（行 config 并入）。
 */
export function createWinStageShellExecutor(options = {}) {
  /**
   * `injectedBase` = 调用方**显式**给的基类（只该是离线自测/装配诊断）。
   * 生产走 `NeutralShellExecutorBase` 让类能构造出来，真正的基类由
   * `loadBaseClass()` 在**第一次 execute()** 时解析 —— 于是"拿不到 dsh-shell"
   * 是一条可读的 fail-closed 错误，而不是加载期崩溃。
   */
  const injectedBase = options.base
  if (injectedBase !== undefined && typeof injectedBase !== 'function') {
    throw new TypeError('createWinStageShellExecutor: options.base must be a class when supplied')
  }
  const Base = injectedBase ?? NeutralShellExecutorBase
  const resolveShellModule = options.resolveShellModule ?? defaultResolveShellModule
  const createExecutor = options.createExecutor
  const configDefaults = options.config ?? {}
  /**
   * 会话感知的工作区工厂（装配方注入）：`(sessionId) => Workspace`。
   * 生产里 = `getReviewService({ workspaceRoot, sessionId }).reload().workspace`。
   *
   * 为什么必须带 `sessionId`：`staging-fs.mjs` 的每一次写都按**调用方会话**解析
   * 存 储根（`sessionIdOf()` → `getReviewService`），而 `getReviewService` 是按
   * `root#sessionKey` 做进程内单例的。shell 这一侧若不按同一个会话 id 取工作区，
   * 就会出现"文件工具写进会话 A 的暂存树、命令跑在会话 B 的暂存树"——
   * 面板与 approve 永远看不到命令产出的那一半。
   */
  const workspaceFor = typeof options.workspaceFor === 'function' ? options.workspaceFor : undefined

  return class WinStageShellExecutor extends Base {
    /**
     * ★ **刻意不声明 `static Config`** —— 这是一个实测出来的**激活阻断**，不是遗漏。
     *
     * 曾经这里是普通对象 `{ cwd:'', timeoutMs:… }`，注释还写着"普通对象也是合法 schema"。
     * 那句话是**错的**：cordis 的 `resolveConfig` 会调 `Config['~standard'].validate(...)`
     * （`cordis/lib/index.js:958`），普通对象没有 `~standard` ⇒ 抛
     *   `TypeError: Cannot read properties of undefined (reading 'validate')`
     * ⇒ 本行**根本没激活**（`ctx.shell` 不存在）⇒ `tool-pwsh` 永远
     *   `pending (waiting for service: shell)` ⇒ **会话里连 pwsh 工具都没有**。
     * 实测证据：`.t/shell-e2e.log` 的 `dsh: warning: 3 entries did not activate`；
     * `dsh-plugin/schema.js` 的文件头逐字记着同一个失败形态（那里是为了另一个行解决的）。
     *
     * 基类 `ShellExecutor` 本身**没有** `Config`，行 config 依然会被传进构造函数，
     * 所以"不声明"既不丢功能也不改变契约。若将来确实要 schema 校验，必须用
     * `schema.js` 那套自带 `~standard.validate` + `toJSON()` 的节点，**不能**用普通对象。
     */

    static inject = []

    constructor(ctx, config) {
      super(ctx, 'shell', config)
      // ★ 把行 `config` 交给装配方（`shell-entry.mjs`）现读 —— 补上一条此前**不存在的**
      //   通路：入口的 `declaredWorkspaceRoot()` 只看 显式装配值 > `WINSTAGE_SHELL_WORKSPACE` > cwd，
      //   而行 `config.workspaceRoot` **根本没人读** ⇒ 只能靠环境变量，一旦它与
      //   `winstage-fs` 行的 `cwd` 不同根，`getReviewService` 会分叉、面板看不到命令产出。
      //   没传 `onConfig` 时是空操作，不改变任何既有行为。
      try {
        options.onConfig?.(config ?? undefined)
      } catch (error) {
        try {
          console.error(`[winstage-shell] onConfig 失败（行 config 未能交给装配方）：${error?.message ?? error}`)
        } catch {
          /* best effort */
        }
      }
      const raw = { ...configDefaults, ...(config ?? {}) }
      /** 原样留一份行 config：关闭开关交还平台时要把它透传给原生执行器 */
      this.rawConfig = raw
      this.log =
        options.log ??
        ((message) => {
          try {
            const logger = ctx?.logger
            if (logger && typeof logger.info === 'function') return logger.info(message)
          } catch {
            /* best effort */
          }
          try {
            console.log(`[winstage-shell] ${message}`)
          } catch {
            /* best effort */
          }
        })
      this.logError =
        options.logError ??
        ((message) => {
          const line = `[winstage-shell] ${message}`
          try {
            const logger = ctx?.logger
            if (logger && typeof logger.warn === 'function') return logger.warn(line)
            if (logger && typeof logger.error === 'function') return logger.error(line)
          } catch {
            /* best effort */
          }
          try {
            console.error(line)
          } catch {
            /* best effort */
          }
        })

      this.timeoutMs = numericOption(raw, 'timeoutMs', DEFAULT_TIMEOUT_MS)
      this.maxTimeoutMs = Math.max(numericOption(raw, 'maxTimeoutMs', DEFAULT_MAX_TIMEOUT_MS), this.timeoutMs)
      this.stdoutMaxBytes = numericOption(raw, 'maxOutputBytes', DEFAULT_MAX_OUTPUT_BYTES)
      this.pwshPathConfig = stringOption(raw, 'pwshPath')
      this.mode = stringOption(raw, 'mode') ?? 'workspace-write'
      this.tier = stringOption(raw, 'tier') ?? 'T1'

      /**
       * 工作区来源：**每次 execute() 现读**（见 `currentWorkspaceOf`），
       * 于是"另一个进程/会话刚改过暂存树"能被看到（与 `cli exec` 每次新建
       * Workspace 同一效果），装配方也可以构造之后再挂。
       */
      this.workspaceSource = options.workspace ?? options.store
      /** 固定的会话身份（装配/自测显式注入）；生产不传，按每次调用现解析 */
      this.fixedSessionId = stringOption(options, 'sessionId')
      this.resolveShellModule = resolveShellModule
      this.executorFactory = createExecutor
      /** 延迟解析并缓存：拿不到 `dsh-shell` 时给出**可读的 fail-closed 错误**，
       *  而不是让整条 loader 行加载失败（那会让用户看到一堆无法归因的启动错误）。 */
      this.resolvedBasePromise = undefined
      /** 自测用：强制"定位不到 dsh-shell" */
      this.baseUnavailable = false
      /**
       * **本插件自己的** loader entry —— 构造时抓住，用于现读开关。
       *
       * 与 `staging-fs.mjs:220` 同一写法与同一理由：`ctx.<service>` 拿到的是 cordis 的
       * traceable 代理，`ctx.fiber.entry` 在**调用方**那边会指向工具自己的 fiber，
       * 不是 loader 根 include 的条目表 ⇒ 开关会永远读错。构造期 `fiber.entry`
       * 由 loader 的 internal/plugin 处理器设好（cordis/lib/index.js:129-135）。
       */
      this.rootEntry = ctx?.fiber?.entry
      /** 平台原生执行器实例 —— **绕过**其构造期 `ctx.provide('shell', …)` 后独立持有 */
      this.nativeExecutor = undefined
      this.nativeExecutorPromise = undefined
    }

    // ==================== 能力/围栏事实 ====================

    /**
     * WinStage **此刻**是否应当接管执行面 —— 与 `staging-fs.stagingEnabled()`
     * **同一个真源、同一套读法**：读 loader 行 `winstage-sandbox` 的 `config.enabled`，
     * 每次调用现读（`rootEntry.parent.data` 是 patch 组合后的那一份，改开关即时生效）。
     *
     * 树里找不到该行（离线自测、行被移除）时默认 `true`：保持"接管"这一历史行为，
     * 与 `staging-fs` 的 fail-open 口径一致（关不掉比静默不管更安全）。
     */
    winStageEnabled() {
      try {
        const data = (this.rootEntry ?? this.ctx?.fiber?.entry)?.parent?.data
        if (!Array.isArray(data)) return true
        const row = data.find((item) => item && item.id === 'winstage-sandbox')
        if (!row || !row.config) return true
        return row.config.enabled !== false
      } catch {
        return true
      }
    }

    /**
     * ⚠ **保留但不再调用** —— "把执行面交还平台原生执行器"这条路已实测**不可行**。
     *
     * 三次实测的原始报错（按此顺序）：
     *   ① `new PwshLocalExecutor(ctx, cfg)` ⇒
     *      `service "shell" has been registered at <WinStageShellExecutor>`
     *      （`ShellExecutor extends Service`，构造即 `ctx.provide('shell', this)`，
     *      与本行占用的单例名冲突；`cordis/lib/index.js:813`）
     *   ② 用 no-op `provide` 的替身 ctx 绕过注册 ⇒ 构造通过，但原生 `execute()`
     *      经 `this.ctx.subprocess.spawn(...)`（`dsh-pwsh-local/lib/index.js:306`）⇒
     *      `cannot get property "subprocess" without inject`
     *      （`subprocess` 未注入本 fiber；替身 ctx 不改变 Cordis 的属性访问门）
     *   ③ 捕获②并降级执行 ⇒ 该报错仍从 try 之外逸出（根因在 ctx 属性访问层，未定位）
     *
     * ⇒ 现行语义（`execute()`）：**不交还**；档位不匹配时按本执行器自己的
     * `workspace-write` 围栏执行，并把不匹配**显式报响**（error 级日志 + 返回注记）。
     * 本方法连同 `NATIVE_PWSH_MODULE` 已无调用点，**不再删除**只为保留上述取证位置；
     * 它已不参与任何执行路径。
     */
    async nativeExecutorFor() {
      if (this.nativeExecutor) return this.nativeExecutor
      if (!this.nativeExecutorPromise) {
        this.nativeExecutorPromise = (async () => {
          const modulePath = locatePackageFile(NATIVE_PWSH_MODULE)
          if (!modulePath) {
            throw shellFailure(
              'WINSTAGE_SHELL_NATIVE_MISSING',
              `无法定位 ${NATIVE_PWSH_MODULE}；` +
                '请设置 DSH_SANDBOX_NODE_ROOT 指向含 @deepseek-ai/* 的 node_modules。',
            )
          }
          let loaded
          try {
            loaded = await import(pathToFileURL(modulePath).href)
          } catch (error) {
            throw shellFailure(
              'WINSTAGE_SHELL_NATIVE_LOAD_FAILED',
              `无法 import ${modulePath}：${error?.message ?? error}。`,
            )
          }
          const klass = loaded?.PwshLocalExecutor ?? loaded?.default
          if (typeof klass !== 'function') {
            throw shellFailure(
              'WINSTAGE_SHELL_NATIVE_LOAD_FAILED',
              `${modulePath} 没有导出 PwshLocalExecutor。`,
            )
          }
          const nativeProps = {}
          try {
            if (klass.Config && typeof klass.Config === 'function') {
              nativeProps.config = klass.Config(this.rawConfig ?? {})
            }
          } catch {
            nativeProps.config = this.rawConfig ?? {}
          }
          const stubCtx = Object.create(this.ctx)
          stubCtx.provide = () => {}
          const instance = new klass(stubCtx, nativeProps.config ?? this.rawConfig ?? {})
          instance.ctx = this.ctx
          this.nativeExecutor = instance
          return instance
        })()
      }
      return this.nativeExecutorPromise
    }

    /**
     * ★ 必须报出一个模式，**不能**报 `undefined` —— 这是实测出来的装配阻断。
     *
     * 原先这里刻意报 `undefined`（理由：我们自己就是围栏，不广告升权）。但
     * `dsh-permission-presets`（在 `dsh-base` 里、**默认必装**）会拒绝装配：
     *   `permission: the mounted bash executor does not confine (no sandboxMode)
     *    — presets bundle a sandbox mode, so composing this plugin over an
     *      unconfined executor is a misconfiguration`
     * 实测：`.t/e2e2.log` 的 `1 entry did not activate`（那 1 条就是 `permission`）。
     *
     * ⇒ 报 `'workspace-write'`，并在 `execute()` 里**明确拒绝任何更宽的请求**
     *   （见那里的 `WINSTAGE_SHELL_ESCALATION_NOT_SUPPORTED`）。这样"用户批准了更宽权限"
     *   绝不会变成一次**静默无效**的批准 —— 那是唯一诚实的处理方式。
     */
    get sandboxMode() {
      return 'workspace-write'
    }

    /**
     * 当前工作区（可能来自函数/服务/实例三种形态）。
     *
     * `resolve()` 用 `{ bestEffort: true }` 调用：那一步承诺**不碰磁盘**，
     * 而 `getReviewService` 会做 `adoptLegacyStore`/`absorbSharedStore` 这类
     * "认领别处内容"的动作 —— 在填默认值的时候顺手搬存储是意外副作用。
     * `execute()` 用严格模式：拿不到工作区就是 fail-closed 抛错。
     */
    currentWorkspace({ bestEffort = false } = {}) {
      if (workspaceFor) {
        let resolved
        try {
          resolved = workspaceFor(this.sessionIdOf())
        } catch (error) {
          if (bestEffort) return undefined
          throw shellFailure(
            'WINSTAGE_SHELL_WORKSPACE_FAILED',
            `could not resolve the WinStage workspace for session ${this.sessionIdOf() ?? '(none)'}: ` +
              `${error?.message ?? error}. 本次命令没有执行。`,
          )
        }
        return resolved
      }
      try {
        return currentWorkspaceOf(this.workspaceSource)
      } catch (error) {
        if (bestEffort) return undefined
        throw shellFailure(
          'WINSTAGE_SHELL_WORKSPACE_FAILED',
          `could not resolve the WinStage workspace: ${error?.message ?? error}. 本次命令没有执行。`,
        )
      }
    }

    /**
     * 调用方的**会话身份** —— 与 `staging-fs.mjs:309-332` 同一优先级：
     *   1. 构造时显式注入的 `sessionId`（装配/自测）；
     *   2. ambient initiator（`ctx.agents.currentInitiator()`）：agent loop 用
     *      `withInitiator` 包住整轮驱动，所以没有 policy 参数的调用也能拿到身份。
     * 拿不到 ⇒ `undefined` ⇒ 落到分享存储（与 `staging-fs` 的降级行为一致）。
     *
     * 这里**刻意**不读 `sandboxPolicy.sessionId`：shell 工具会把策略塞进
     * `ShellExecRequest`，但本执行器不接受升权，也就不需要策略里的任何东西。
     */
    sessionIdOf() {
      if (this.fixedSessionId) return this.fixedSessionId
      try {
        const ctx = this.ctx
        const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : ctx?.agents
        const id = agents?.currentInitiator?.()?.session?.id
        if (typeof id === 'string' && id.length > 0) return id
      } catch {
        /* 读不到 initiator ⇒ undefined */
      }
      return undefined
    }

    // ==================== resolve：纯计算 ====================

    /**
     * 填默认值与封顶。**不碰磁盘**：不建目录、不建沙箱、不物化
     * （物化只在 `execute()` 里做，因为那才是"真的要执行"的时刻）。
     */
    resolve(request) {
      const workspace = this.currentWorkspace({ bestEffort: true })
      const logicalRoot =
        (typeof request?.workdir === 'string' && request.workdir.length > 0 ? request.workdir : undefined) ??
        (typeof workspace?.root === 'string' && workspace.root.length > 0 ? workspace.root : undefined) ??
        process.cwd()
      const requested = request?.timeoutMs
      if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
        throw new Error('winstage-shell: request.timeoutMs must be a positive finite number')
      }
      const requestedStdout = request?.stdoutMaxBytes
      if (requestedStdout !== undefined && (!Number.isFinite(requestedStdout) || requestedStdout <= 0)) {
        throw new Error('winstage-shell: request.stdoutMaxBytes must be a positive finite number')
      }
      return {
        command: String(request?.command ?? ''),
        // 逻辑 workdir：**展示**与"相对路径的解析基准"用这里；真实执行 cwd 在
        // `execute()` 里换成暂存树（并在 stderr 注记里说明）。
        workdir: logicalRoot,
        timeoutMs: Math.min(requested ?? this.timeoutMs, this.maxTimeoutMs),
        onExpiry: request?.onExpiry ?? 'kill',
        stdoutMaxBytes: Math.min(requestedStdout ?? this.stdoutMaxBytes, this.stdoutMaxBytes),
        ...(request?.signal ? { signal: request.signal } : {}),
        ...(request?.stdin !== undefined ? { stdin: request.stdin } : {}),
        ...(request?.env !== undefined ? { env: request.env } : {}),
        ...(request?.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
        // ★ 把策略**带下去**，不要丢掉：`execute()` 要据它**拒绝任何更宽的请求**。
        //   丢弃它会让"用户批准了更宽权限"变成一次**静默无效**的批准 —— 那是说谎。
        sandboxPolicy: request?.sandboxPolicy,
      }
    }

    // ==================== execute：要么在沙箱里跑完，要么抛错 ====================

    /**
     * @param {object} spec `resolve()` 的返回值
     * @returns {Promise<object>} 已结算的 `ShellExecution`
     */
    async execute(spec) {
      /**
       * ── "档位不匹配不再让 shell 整条失效"（本轮实测后的最终裁定）──────────────
       *
       * 历史行为：请求档位 ≠ `workspace-write` ⇒ **抛错、命令不执行**。
       * 实测后果：会话档位一旦是 `danger-full-access`，**每一条 pwsh 都不可用**
       * （`winstage-shell` 占着 `ctx.shell` 这个单例名，用户没有别的执行面可退）。
       * 这被用户判定为不可接受："关闭沙箱后应该完全恢复原来的 shell 行为"。
       *
       * 曾尝试"交还平台原生执行器"，**三次实测均不可行**（均已留下原始报错）：
       *   ① `new PwshLocalExecutor(ctx)` ⇒ `service "shell" has been registered
       *      at <WinStageShellExecutor>`（`Service` 构造即注册，单例名冲突）；
       *   ② 用 no-op `provide` 的替身 ctx 绕过注册 ⇒ 构造通过，但原生 `execute()`
       *      经 `this.ctx.subprocess.spawn(...)` ⇒ `cannot get property "subprocess"
       *      without inject`（该服务未注入本 fiber）；
       *   ③ 捕获②并降级 ⇒ 报错仍从 try 之外逸出（根因在 `ctx` 属性访问层，未定位）。
       * ⇒ **不交还**：只在本执行器**自己的围栏内**执行，并把档位不匹配**如实报响**。
       *
       * 这不是"放开权限"：本执行器的可写面**始终**是暂存树（`workspace-write`），
       * 请求更宽档位只会得到"实际按 workspace-write 执行"的 error 级日志 + 返回注记。
       * 也**不是静默**：档位不匹配是显式告警（本仓库最忌讳静默失效）。
       */
      const requestedMode = spec?.sandboxPolicy?.mode
      const mismatched = requestedMode !== undefined && requestedMode !== 'workspace-write'
      if (mismatched) {
        this.logError(
          `请求的档位 "${requestedMode}" 比本执行器实现的宽（"workspace-write"）；` +
            '本次**在 WinStage 围栏内执行**（可写 = 暂存树），权限未被放大。' +
            (this.winStageEnabled() ? '' : '（注意：WinStage 开关当前为关闭态。）'),
        )
      }
      return this.executeConfined(spec, {
        requestedMode,
        ...(mismatched
          ? {
              degradeNote:
                `请求档位 "${requestedMode}" 宽于本执行器实现的 "workspace-write"；` +
                '已按 WinStage 围栏执行（可写 = 暂存树），权限未放大。',
            }
          : {}),
      })
    }

    /**
     * **在 WinStage 围栏内**执行（可写 = 暂存树）。`execute()` 的两条路径共用它，
     * 避免"交还分支"与"接管分支"各写一份执行体。
     *
     * @param {object} spec `resolve()` 的返回值
     * @param {{requestedMode?: string, degradeNote?: string}} context
     *   `degradeNote` 非空表示这是"交还失败后的降级执行"⇒ 进 error 级日志 + 注记。
     */
    async executeConfined(spec, context = {}) {
      const notes = []
      const warn = (message) => {
        notes.push(message)
        this.logError(message)
      }

      // ★ "交还失败后的降级执行"必须随返回带出：用户与断言都能看见
      //   "请求了 X、实际按 workspace-write 跑"—— 这是"失败必须响"的落点。
      if (typeof context.degradeNote === 'string' && context.degradeNote.length > 0) {
        warn(context.degradeNote)
      }

      if (!spec || typeof spec.command !== 'string' || spec.command.trim().length === 0) {
        throw shellFailure('WINSTAGE_SHELL_BAD_COMMAND', 'command must be a non-empty string; 本次命令没有执行。')
      }

      // ── ① 运行时基类：拿不到 ⇒ fail-closed（绝不换一个基类顶替）──────────────
      await this.loadBaseClass()

      // ── ② 工作区与暂存树 ─────────────────────────────────────────────────────
      const workspace = this.currentWorkspace()
      if (!workspace || typeof workspace !== 'object') {
        throw shellFailure(
          'WINSTAGE_SHELL_NO_WORKSPACE',
          'no WinStage workspace is attached to the shell executor; 本次命令没有执行' +
            '（拒绝在主机上直接跑）。',
        )
      }
      const stagedDir = this.stagedDirOf(workspace)

      // ── ③ 准备执行器 + 能力探测 + init（任一失败 ⇒ fail-closed）────────────
      const factory =
        this.executorFactory ??
        ((opts) => {
          // ★ 必须把**静态**的 `WindowsStageExecutor.capabilities` 转发到实例上。
          //   下面的能力闸门问的是 `executor.capabilities()`，而静态方法在实例上取不到
          //   ⇒ 闸门永远看到 `{aclAvailable:false}` ⇒ **每条命令都被 fail-closed 拒掉**，
          //   而表面上像是"环境里 ACL 不可用"（实测：`.t/e2e6.log`、
          //   `"the WinStage sandbox backend reported itself unavailable (aclAvailable=false)"`）。
          //   真正的能力侧在本机是 `aclAvailable:true, canMintRestrictedToken:true`
          //   （`.t/shell-plan-probe.txt`），能力探针与 `DSH_SANDBOX_NODE_ROOT` 都证明它可解析。
          const instance = new WindowsStageExecutor(opts)
          instance.capabilities = () => WindowsStageExecutor.capabilities()
          return instance
        })
      const executor = factory({
        stagingRoot: stagedDir,
        mode: this.mode,
        tier: this.tier,
        timeoutMs: spec.timeoutMs,
      })

      try {
        const capabilities =
          typeof executor.capabilities === 'function' ? executor.capabilities() : { aclAvailable: false }
        if (!capabilities || capabilities.aclAvailable !== true) {
          throw shellFailure(
            'WINSTAGE_SHELL_SANDBOX_UNAVAILABLE',
            'the WinStage sandbox backend is unavailable ' +
              `(aclAvailable=${JSON.stringify(capabilities?.aclAvailable ?? null)}` +
              `${capabilities?.aclError ? `, ${capabilities.aclError}` : ''}). ` +
              '本次命令没有执行 —— 本设计不允许退回"在主机上直接跑"。',
          )
        }
        if (typeof executor.init !== 'function' || typeof executor.run !== 'function') {
          throw shellFailure(
            'WINSTAGE_SHELL_EXECUTOR_INVALID',
            'the injected executor does not expose init()/run(); 本次命令没有执行。',
          )
        }
        try {
          await executor.init()
        } catch (error) {
          throw shellFailure(
            'WINSTAGE_SHELL_INIT_FAILED',
            `the WinStage sandbox failed to initialise (${error?.code ?? 'no-code'} ${error?.message ?? error}). ` +
              '本次命令没有执行 —— 本设计不允许退回"在主机上直接跑"。',
          )
        }

        // ── ④ 执行前：物化当前工作区版本 + 取内容戳（与 cli exec 同序）─────────
        try {
          workspace.materializeForExecution()
        } catch (error) {
          throw shellFailure(
            'WINSTAGE_SHELL_MATERIALIZE_FAILED',
            `could not materialise the workspace into the staged tree: ${error?.message ?? error}. ` +
              '本次命令没有执行。',
          )
        }
        const before = workspace.snapshotStagedTree()

        // ── ⑤ 准备期就已 abort ⇒ 不产生任何进程（契约：合法地返回已结算句柄）──
        if (spec.signal?.aborted === true) {
          return this.settledExecution({
            spec,
            workspace,
            stagedDir,
            notes,
            execution: { exitCode: null, stdout: '', stderr: '', timedOut: false, envRejected: [] },
            aborted: true,
            capture: undefined,
          })
        }

        // ── ⑥ 在沙箱内执行：cwd = **暂存树** ─────────────────────────────────
        const argv = buildCommandArgv(spec.command, resolvePwshPath(this.pwshPathConfig))
        if (!argv.recognized) {
          this.log(
            `命令未带 pwsh/powershell 前缀，按"裸程序 + 参数"处理：${argv.command}（args=${argv.args.length}）；不做任何 shell 展开。`,
          )
        }
        const environment = { ...ENV_OVERRIDES, ...(spec.dshEnv ?? {}), ...(spec.env ?? {}) }
        if (spec.stdin !== undefined && spec.stdin !== null && String(spec.stdin).length > 0) {
          warn(
            'spec.stdin 被传进来了，但无法接进 WinStage 沙箱（CreateProcessAsUserW 没有 stdin 通道）；' +
              '它被**丢弃**了 —— 如实记在这里，不静默消费、也不假装成功。',
          )
        }

        let execution
        try {
          execution = await executor.run({
            command: argv.command,
            args: argv.args,
            cwd: stagedDir,
            logicalCwd: workspace.root,
            timeoutMs: spec.timeoutMs,
            env: environment,
          })
        } catch (error) {
          throw shellFailure(
            'WINSTAGE_SHELL_RUN_FAILED',
            `the WinStage sandbox could not run the command: ${error?.message ?? error}.`,
          )
        }

        const timedOut = execution?.timedOut === true
        // 调用方的信号若在我们跑完之后才触发：如实记为 aborted（或 timedOut，取先到者），
        // 但**不谎称**"我们当场掐断了进程"（见文件头残余边界）。
        const aborted = !timedOut && spec.signal?.aborted === true

        // ── ⑦ 执行后：捕获 → 并入清单 → 冻结候选（失败必须响，并随返回带出）──
        const capture = this.captureStagedChanges(workspace, before, warn)

        const envRejected = Array.isArray(execution?.envRejected) ? execution.envRejected : []
        for (const name of envRejected) {
          warn(`环境变量 ${name} 被沙箱执行器拒绝（名字像凭据），未进入子进程。`)
        }

        this.log(
          `沙箱内执行完毕 exit=${execution?.exitCode ?? '?'} timedOut=${timedOut}；` +
            `捕获 ${capture.captured} 条、并入 ${capture.ingested} 条、删除 ${capture.deletions} 条、` +
            `候选=${capture.candidate?.frozen === true ? capture.candidate.candidate?.id : `未新建(${capture.candidate?.reason ?? 'n/a'})`}`,
        )

        return this.settledExecution({
          spec,
          workspace,
          stagedDir,
          notes,
          execution: {
            exitCode: execution?.exitCode ?? null,
            stdout: execution?.stdout,
            stderr: execution?.stderr,
            timedOut,
            envRejected,
          },
          aborted,
          capture,
        })
      } finally {
        // 每个命令一套令牌/ACL/Job：跑完立刻拆，绝不跨命令复用
        try {
          executor.dispose?.()
        } catch (error) {
          this.logError(`executor.dispose() 失败（不掩盖命令结果）：${error?.message ?? error}`)
        }
      }
    }

    // ==================== 内部：装配 ====================

    /**
     * 取到运行时那一份 `ShellExecutor` **基类**。
     *
     * 只在**第一次 execute()** 时 import：
     *   - 拿不到包 ⇒ 可读的 fail-closed 错误（而不是整条 loader 行加载失败）；
     *   - 包在、但不够格 ⇒ cordis 会直接报"重复的 shell 服务"，用户能看见。
     * 绝不用 `ShellExecutor` 之外的替身冒充基类（那会注册出一个假的 `ctx.shell` 变体）。
     */
    async loadBaseClass() {
      if (injectedBase) return injectedBase
      if (this.baseUnavailable) {
        throw shellFailure(
          'WINSTAGE_SHELL_BASE_MISSING',
          'cannot locate @deepseek-ai/dsh-shell; 本次命令没有执行。' +
            '请设置 DSH_SANDBOX_NODE_ROOT 指向含 @deepseek-ai/* 的 node_modules。',
        )
      }
      if (!this.resolvedBasePromise) {
        this.resolvedBasePromise = (async () => {
          const modulePath = this.resolveShellModule()
          if (!modulePath) {
            throw shellFailure(
              'WINSTAGE_SHELL_BASE_MISSING',
              'cannot locate @deepseek-ai/dsh-shell; 本次命令没有执行。' +
                '请设置 DSH_SANDBOX_NODE_ROOT 指向含 @deepseek-ai/* 的 node_modules。',
            )
          }
          let loaded
          try {
            loaded = await import(pathToFileURL(modulePath).href)
          } catch (error) {
            throw shellFailure(
              'WINSTAGE_SHELL_BASE_LOAD_FAILED',
              `cannot import ${modulePath}: ${error?.message ?? error}; 本次命令没有执行。`,
            )
          }
          const klass = loaded?.ShellExecutor ?? loaded?.default
          if (typeof klass !== 'function') {
            throw shellFailure(
              'WINSTAGE_SHELL_BASE_LOAD_FAILED',
              `${modulePath} did not export a ShellExecutor class; 本次命令没有执行。`,
            )
          }
          return klass
        })()
      }
      return this.resolvedBasePromise
    }

    /**
     * 暂存树根 = 命令的真实 cwd。
     * 优先 `workspace.store.stagedDir`（与 `src/cli.mjs` 的 `exec` 分支逐字一致）。
     */
    stagedDirOf(workspace) {
      const stagedDir = workspace?.store?.stagedDir
      if (typeof stagedDir !== 'string' || stagedDir.length === 0) {
        throw shellFailure(
          'WINSTAGE_SHELL_NO_STAGED_ROOT',
          'the WinStage workspace does not expose store.stagedDir; 本次命令没有执行' +
            '（拒绝用一个未指定的工作目录去跑）。',
        )
      }
      return stagedDir
    }

    /**
     * 执行后的捕获链：`captureAfterExecution` → `ingestCapturedChanges` → `freezeIfNeeded`。
     * 与 `src/cli.mjs` 的 `exec` 分支同一顺序（那里是唯一权威）。
     * **任何一步失败都走 error 级日志**，并把失败信息如实带回（绝不静默）。
     */
    captureStagedChanges(workspace, before, warn) {
      const report = { captured: 0, ingested: 0, deletions: 0, skipped: [], candidate: undefined, failures: [] }
      if (typeof workspace.captureAfterExecution !== 'function') {
        report.failures.push('captureAfterExecution is not available on this workspace')
        warn('工作区没有 captureAfterExecution()：命令产出**不会**进入清单（本次执行结果仍然如实返回）。')
        return report
      }
      let captured
      try {
        captured = workspace.captureAfterExecution(before)
        report.captured = Array.isArray(captured) ? captured.length : 0
      } catch (error) {
        report.failures.push(`captureAfterExecution: ${error?.message ?? error}`)
        warn(`捕获沙箱内变更失败：${error?.message ?? error}（命令已执行，但产出没有被并入清单）`)
        return report
      }
      try {
        const ingested = workspace.ingestCapturedChanges(captured)
        report.ingested = ingested?.ingested ?? 0
        report.deletions = ingested?.deletions ?? 0
        for (const skip of ingested?.skipped ?? []) {
          report.skipped.push(skip)
          warn(`并入清单时跳过 ${skip.path}：${skip.reason}`)
        }
      } catch (error) {
        report.failures.push(`ingestCapturedChanges: ${error?.message ?? error}`)
        warn(`把捕获结果并入清单失败：${error?.message ?? error}`)
        return report
      }
      try {
        report.candidate = workspace.freezeIfNeeded({ source: 'shell' })
      } catch (error) {
        report.failures.push(`freezeIfNeeded: ${error?.message ?? error}`)
        warn(`冻结待审候选失败：${error?.message ?? error}（变更已在清单里，但没有生成候选）`)
      }
      return report
    }

    // ==================== 内部：返回形状 ====================

    /**
     * 构造**已结算**的 `ShellExecution`（契约允许：dsh-shell/lib/types/index.d.ts:40
     * "Expiry during preparation returns a settled timed-out handle without output"）。
     *
     * 形状逐项对齐：status / exitCode / signal / done / sandbox? / readOutput() /
     * observed / kill() / result()。另有 `winstage` 这个**附加**可观测面（不属于契约，
     * 便于诊断：暂存树路径、捕获计数、候选 id、失败原因）。
     */
    settledExecution({ spec, workspace, stagedDir, notes, execution, aborted, capture }) {
      const timedOut = execution.timedOut === true
      // cli exec 的超时口径：exitCode 124（`WindowsStageExecutor` 的 terminate(124)）。
      // 中止（信号）没有退出码可言 ⇒ null，与"被信号杀死"同形。
      const exitCode = timedOut ? 124 : aborted ? null : execution.exitCode ?? null

      const stdoutOut = boundedOutput(execution.stdout, spec.stdoutMaxBytes)
      const stderrOut = boundedOutput(execution.stderr, spec.stdoutMaxBytes)

      /** 本插件的注记走 **stderr**：与命令输出可区分，且不污染 stdout 的解析 */
      const stderrNotes = [
        `[winstage] executed inside the sandbox; real cwd = ${stagedDir} (real workspace: ${workspace.root})`,
      ]
      if (capture && capture.failures.length > 0) {
        for (const failure of capture.failures) stderrNotes.push(`[winstage] CAPTURE FAILED: ${failure}`)
      } else if (capture) {
        stderrNotes.push(
          `[winstage] captured ${capture.captured} change(s), ingested ${capture.ingested}, deletions ${capture.deletions}` +
            (capture.candidate?.frozen === true
              ? `; frozen candidate ${capture.candidate.candidate?.id ?? '(unknown)'}`
              : `; no new candidate (${capture.candidate?.reason ?? 'n/a'})`),
        )
      }
      for (const note of notes) stderrNotes.push(`[winstage] ${note}`)

      const stderrJoined =
        `${stderrOut.text}${stderrOut.text.length > 0 && !stderrOut.text.endsWith('\n') ? '\n' : ''}` +
        `${stderrNotes.join('\n')}\n`
      const stderrFinal = boundedOutput(stderrJoined, spec.stdoutMaxBytes)

      const runResult = {
        exitCode,
        signal: null,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout: { text: stdoutOut.text, truncated: stdoutOut.truncated },
        stderr: { text: stderrFinal.text, truncated: stderrOut.truncated || stderrFinal.truncated },
        // sandbox 事实**刻意不报**：本执行器已经广告 sandboxMode === undefined，
        // 报出 mode 会让 dsh-tool-pwsh 走 sandboxDenialMarker(mode) 渲染路径
        // （tool-pwsh/lib/index.js:165-168）—— 一个我们并不使用的模式。
      }

      let drained = false
      return {
        status: 'completed',
        exitCode,
        signal: null,
        done: Promise.resolve(),
        /** 前台投影（契约：只在基础设施故障时 reject；这里总是 resolve） */
        result: () => Promise.resolve(runResult),
        /** 消费式读：首次给全文，之后给空（连续读不重复投递） */
        readOutput() {
          if (drained) return { delta: '', lossy: false }
          drained = true
          return {
            delta: `${stdoutOut.text}${stderrOut.text.length > 0 ? `\n[stderr]\n${stderrOut.text}` : ''}`,
            lossy: false,
          }
        },
        /** 非消费式偏移读：两个流各一个 reader，独立于 readOutput 的游标 */
        observed: {
          stdout: makeOffsetReader(execution.stdout),
          stderr: makeOffsetReader(stderrJoined),
        },
        /** 已结算 ⇒ 没有可终止的区间（契约里"已经结束 ⇒ no-op"的语义） */
        kill() {
          return false
        },
        // —— 附加可观测面（不属于 ShellExecution 契约）——
        winstage: {
          kind: 'win-stage-sandbox',
          stagedDir,
          logicalWorkspaceRoot: workspace.root,
          capture: capture
            ? {
                captured: capture.captured,
                ingested: capture.ingested,
                deletions: capture.deletions,
                skipped: capture.skipped,
                frozen: capture.candidate?.frozen === true,
                candidateId: capture.candidate?.candidate?.id,
                reason: capture.candidate?.reason,
                failures: capture.failures,
              }
            : { available: false, failures: ['captureAfterExecution unavailable'] },
          envRejected: execution.envRejected ?? [],
          notes,
        },
      }
    }
  }
}

export default createWinStageShellExecutor
