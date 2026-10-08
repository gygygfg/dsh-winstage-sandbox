/**
 * stage-guard.mjs —— 会话工作根（Phase 1 / WP0）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 接口契约（WP2 / WP4 依赖，**名字与语义已冻结**）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   export const STAGE_ROOT_LOST = 'STAGE_ROOT_LOST'
 *     —— 稳定错误码。根/哨兵消失、被外部清理、守护失效时**只抛这一个码**。
 *
 *   export function resolveStageRoot({ sessionKey, workspaceRoot, env, override }) -> string
 *     —— **纯函数、无副作用、不建目录**。返回该会话的工作根绝对路径。
 *        · override 给出时逐字采用（测试/显式配置）；
 *        · 否则 `<stageBaseDir(env)>\<会话键>`，`stageBaseDir` 默认
 *          `%LOCALAPPDATA%\Temp\winstage-stage`；
 *        · 会话键 = sessionKey → env.DSH_SESSION_ID → `ws-<工作区路径 sha256 前 16 位>`。
 *        · **不再返回工作区内的 `<workspaceRoot>\.dshstage`**（Phase 1 硬约束）。
 *
 *   export function acquireStageGuard(root) -> { root, sentinelPath, keeperPid, assertAlive(), release() }
 *     —— 幂等：同一 root 在同一进程内只建立一个守护，重复调用返回同一对象。
 *        · root            规范化后的根绝对路径
 *        · sentinelPath    根下被"钉住"的哨兵文件绝对路径
 *        · keeperPid       持有句柄的守护进程 pid（进程内模式 = 本进程 pid）
 *        · assertAlive()   活着 ⇒ 返回 { alive:true }；死了/丢了 ⇒ **抛 StageRootLostError**
 *        · release()       正常释放：守护释放句柄并清空该根；成功 ⇒ { removed:true, ... }
 *
 *   export function verifyStageRootAlive(root) -> { alive: boolean, reason?: string }
 *     —— **纯查询、无副作用、不抛**。判据（全部成立才算 alive）：
 *        root 存在 + 标记文件可解析 + 哨兵存在且内容 == 标记里的 token + 持有者 pid 仍存活。
 *
 *   export function sweepOrphanStageRoots({ baseDir, ttlMs, keep }) -> { removed: string[], skipped: string[] }
 *     —— 启动时清扫孤儿。`keep` 里的条目不碰（绝对路径或裸目录名均可）。
 *        判据：有标记但持有者已死 ⇒ 孤儿；无标记 ⇒ 仅当目录年龄 > ttlMs 才当孤儿。
 *        删除失败（例如仍有活守护钉着目录）⇒ 进 skipped，**不抛**。
 *
 *   export class StageRootLostError extends Error   // .code === STAGE_ROOT_LOST
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 抗外部清理的机制（**owner 已定，本文件是唯一实现**）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 关键实测结论：**Node 的 `fs` 做不到这件事**。
 *   · libuv 的 `uv_fs_open` 三个 share 位（READ|WRITE|DELETE）**全给**，调用方无法收窄
 *     （`fs.open` / `fs.constants` 里没有 `FILE_SHARE_*`）；`O_EXCL` 只管创建不管共享。
 *   · 因此"只给 FILE_SHARE_READ 的哨兵句柄""不给 FILE_SHARE_DELETE 的目录句柄"在纯 Node
 *     里**无法表达**，必须在进程外用能指定 dwShareMode 的 Win32 调用持有。
 *   · 本机实测 `koffi` 不在任何可解析的 `node_modules` 里（工作区没有 node_modules，
 *     DSH 的 npx 缓存也不在工作区解析链上）⇒ FFI 这条路本轮**不可用**。
 *   · 最终选路：**Windows PowerShell 5.1 守护进程 + Add-Type P/Invoke**（本机
 *     `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` 可用，实测可用）。
 *
 * 守护进程做的事（脚本见下方 KEEPER_SCRIPT，经 `-EncodedCommand` 传入，不落盘）：
 *   1. 哨兵 `<root>\.winstage-guard`：`CreateFileW(GENERIC_READ, FILE_SHARE_READ, OPEN_EXISTING)`
 *      ⇒ 只给共享读。DSH 存活期间该文件**不能被写、不能被删、不能被改名**。
 *   2. 目录 `<root>`：`CreateFileW(GENERIC_READ, FILE_SHARE_READ|FILE_SHARE_WRITE,
 *      OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS)` ⇒ 不给共享删。目录**不能被删/改名**；
 *      但其**子项**的新建与删除不受影响（共享位只约束"目录对象自身"），所以 DSH 照常写暂存。
 *   3. 其余文件只在 I/O 时打开，本模块从不主动给任何人 FILE_SHARE_DELETE。
 *      **诚实声明**：这层保护**只覆盖哨兵与根目录自身**，根下的兄弟文件**不**受保护
 *      （实测：守护在位期间覆写/删除兄弟文件均成功，见 wp0-test 的 E-C 段）。
 *   4. 守护用 `OpenProcess(SYNCHRONIZE)` + `WaitForSingleObject` **阻塞等待 DSH 进程**；
 *      DSH 一退出（含被强杀）守护立即醒来，释放句柄并**清空该根** —— 退出即清理。
 *   5. pid/根路径/token 写进标记文件 `<root>\.winstage-owner.json`，供
 *      `verifyStageRootAlive()` 与 `sweepOrphanStageRoots()` 使用。
 *
 * 为什么"丢失即显形"成立：根或哨兵一旦消失/被篡改、或守护进程死了，
 * `verifyStageRootAlive()` 立刻返回 not-alive，`assertAlive()` 抛 `STAGE_ROOT_LOST`。
 * **绝不静默回退写真实盘、绝不静默丢数据**：本模块不提供任何"换个地方继续写"的分支。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 透明性（硬约束）
 * ═══════════════════════════════════════════════════════════════════════════
 * 本模块产出的**模型可见文案**（即 Error.message）里不得出现
 * 「沙箱」「暂存」「替代路径」「sandbox」「stage」「staging」「shadow」等字样。
 * 因此：所有 message 都是**不含路径、不含内部行话**的普通失败描述
 * （例：`the session working directory is no longer available (keeper-dead)`）；
 * 路径等诊断信息一律挂在**非 message 属性**上（`error.root` / `error.detail`），
 * 只有代码与日志看得见。契约要求 `.code === 'STAGE_ROOT_LOST'`，故 code 保留原样
 * （`.code` 是机器标识，不是文案）。`assertTransparentMessages()` 是这条约束的自检。
 *
 * 平台：Windows。非 win32 平台上退化为**进程内守卫**（写标记+哨兵，无外置守护），
 * 语义接口逐字不变，但抗外部清理能力不成立（如实记录，不假装）。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 谁可以创建默认根（**实测，接线前必读**）
 * ═══════════════════════════════════════════════════════════════════════════
 * `%LOCALAPPDATA%\Temp` 对**被沙箱收窄的命令行子进程**是只读的：`mkdir` 直接 `EPERM`
 * （本机 pwsh 与 node 双通道一致）。但**宿主进程**（DSH 插件所在进程）可以创建并写入
 * `%LOCALAPPDATA%\Temp\winstage-stage`（已用 pwsh + node 双通道核实落到真实盘）。
 * ⇒ 默认根**必须由宿主进程（插件）创建**。受限档里的测试/脚本要显式传 `override`。
 * ⇒ 建不出根时 `acquireStageGuard` **fail-closed** 抛 `STAGE_GUARD_UNAVAILABLE`，
 *   **不静默回落**到工作区，也不"无守护地继续"。
 *
 * 另外两条本机踩过的坑（都写进代码注释了，这里留索引）：
 *   · 守护是宿主的子进程，**必须 `child.unref()`**；用 `detached: true` 会让
 *     powershell 子进程静默死掉，不 unref 则会与宿主互相等待而**死锁**。
 *   · PowerShell 变量名**不区分大小写**（`$Marker` 与 `$marker` 是同一个变量），
 *     守护脚本里的参数名因此刻意取成不会互相踩的 `$MarkerPath` / `$markerJson`。
 */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, resolve as pathResolve, sep } from 'node:path'
import { tmpdir } from 'node:os'

// ═══════════════════════════════════════════════════════════════════════════
// 常量（对外契约）
// ═══════════════════════════════════════════════════════════════════════════

/** 稳定错误码：根/哨兵/守护任一失效都只抛这一个码 */
export const STAGE_ROOT_LOST = 'STAGE_ROOT_LOST'

/** 守护无法建立（例如本机没有 powershell.exe）——fail-closed，不降级成"无守护暂存" */
export const STAGE_GUARD_UNAVAILABLE = 'STAGE_GUARD_UNAVAILABLE'

/** 标记文件（可写、可解析；清扫与探活都读它） */
export const STAGE_MARKER_NAME = '.winstage-owner.json'
/** 哨兵文件（守护在位期间**不可写/不可删/不可改名**） */
export const STAGE_SENTINEL_NAME = '.winstage-guard'
/** 正常释放信号（守护轮询它） */
export const STAGE_RELEASE_NAME = '.winstage-release'
/** 守护失败时留下的原因文件 */
export const STAGE_ERROR_NAME = '.winstage-keeper.error'

/** 缓存根目录名：`%LOCALAPPDATA%\Temp\<这个名字>\<会话键>` */
export const STAGE_BASE_NAME = 'winstage-stage'
/** 守护日志目录（在缓存根之下、会话根之外，**不能**放进会话根，否则日志句柄会挡住清理） */
export const GUARD_LOG_DIR = '.guard-logs'

/** PowerShell 可执行文件（本机实测存在的 Windows PowerShell 5.1） */
const POWERSHELL = process.env.WINSTAGE_POWERSHELL || 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 模块级单例：同一 root 只建一个守护 */
const LIVE_GUARDS = new Map()

// ═══════════════════════════════════════════════════════════════════════════
// 错误类型
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 根丢失 / 守护失效。`.code === STAGE_ROOT_LOST`。
 * message 刻意不含路径与内部行话（透明性硬约束）；路径在 `.root`，细节在 `.detail`。
 */
export class StageRootLostError extends Error {
  constructor(reason, detail = {}) {
    super(`the session working directory is no longer available (${reason})`)
    this.name = 'StageRootLostError'
    this.code = STAGE_ROOT_LOST
    this.reason = reason
    if (detail.root !== undefined) this.root = detail.root
    if (detail.keeperPid !== undefined) this.keeperPid = detail.keeperPid
    if (detail.status !== undefined) this.status = detail.status
  }
}

function guardUnavailableError(reason, detail = {}) {
  const error = new Error(`the protected session directory could not be established (${reason})`)
  error.name = 'StageGuardUnavailableError'
  error.code = STAGE_GUARD_UNAVAILABLE
  error.reason = reason
  if (detail.root !== undefined) error.root = detail.root
  return error
}

// ═══════════════════════════════════════════════════════════════════════════
// 根位置
// ═══════════════════════════════════════════════════════════════════════════

/** 会话键里不允许出现的字符（路径分隔符、Windows 非法字符、控制字符） */
function sanitizeKey(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  const cleaned = text
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
  return cleaned.slice(0, 120) || ''
}

/** 会话键：显式 > 环境变量 > 工作区路径哈希（纯函数，不碰 fs） */
export function stageSessionKey({ sessionKey, workspaceRoot, env } = {}) {
  const e = env || process.env
  const explicit = sanitizeKey(sessionKey)
  if (explicit) return explicit
  const fromEnv = sanitizeKey(e?.DSH_SESSION_ID || e?.WINSTAGE_SESSION_ID || e?.DSH_SESSION)
  if (fromEnv) return fromEnv
  if (workspaceRoot) {
    const digest = createHash('sha256').update(normalize(String(workspaceRoot)).toLowerCase(), 'utf8').digest('hex')
    return `ws-${digest.slice(0, 16)}`
  }
  return 'default'
}

/**
 * 缓存根：`%LOCALAPPDATA%\Temp\winstage-stage`。
 * **刻意不用 `os.tmpdir()`**：在 DSH 之下 `%TEMP%` 会被逐命令虚拟化成
 * `<...>\dsh-stage-temp\<每次新 uuid>`（实测每次调用都不同），拿它当根等于每命令一个新根。
 * 因此从 `LOCALAPPDATA` 显式拼 `Temp`；只有 LOCALAPPDATA 缺失时才退回 `os.tmpdir()`。
 */
export function stageBaseDir(env) {
  const e = env || process.env
  const local = e?.LOCALAPPDATA || e?.LocalAppData
  return local ? join(String(local), 'Temp', STAGE_BASE_NAME) : join(tmpdir(), STAGE_BASE_NAME)
}

/** 见文件头契约。纯函数、无副作用、不建目录。 */
export function resolveStageRoot({ sessionKey, workspaceRoot, env, override } = {}) {
  if (override !== undefined && override !== null && String(override).trim() !== '') {
    return normalize(pathResolve(String(override)))
  }
  const key = stageSessionKey({ sessionKey, workspaceRoot, env })
  return normalize(join(stageBaseDir(env), key))
}

export const stageMarkerPath = (root) => join(normalize(String(root)), STAGE_MARKER_NAME)
export const stageSentinelPath = (root) => join(normalize(String(root)), STAGE_SENTINEL_NAME)
export const stageReleasePath = (root) => join(normalize(String(root)), STAGE_RELEASE_NAME)
export const stageErrorPath = (root) => join(normalize(String(root)), STAGE_ERROR_NAME)

// ═══════════════════════════════════════════════════════════════════════════
// 小工具
// ═══════════════════════════════════════════════════════════════════════════

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** 进程是否存活。EPERM = 进程在但本进程无权查询 ⇒ 仍算存活。 */
export function processAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** 删树（带重试）；成功或"本来就不在"⇒ true */
function removeTreeRetry(target, attempts = 25, delayMs = 120) {
  for (let i = 0; i < attempts; i += 1) {
    if (!existsSync(target)) return true
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 2 })
    } catch {
      /* 下面统一判定 */
    }
    if (!existsSync(target)) return true
    sleepSync(delayMs)
  }
  return !existsSync(target)
}

// ═══════════════════════════════════════════════════════════════════════════
// 探活（纯查询）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 见文件头契约。**无副作用、不抛**。
 * `reason` 取值（全部不含内部行话）：`root-missing` / `marker-missing` / `marker-invalid`
 * / `sentinel-missing` / `sentinel-unreadable` / `sentinel-tampered` / `keeper-dead` / `guarded`。
 */
export function verifyStageRootAlive(root) {
  const abs = normalize(String(root))
  if (!existsSync(abs)) return { alive: false, reason: 'root-missing', root: abs }
  let info
  try {
    info = statSync(abs)
  } catch {
    return { alive: false, reason: 'root-missing', root: abs }
  }
  if (!info.isDirectory()) return { alive: false, reason: 'root-not-directory', root: abs }

  const marker = readJsonFile(stageMarkerPath(abs))
  if (!marker) {
    return { alive: false, reason: existsSync(stageMarkerPath(abs)) ? 'marker-invalid' : 'marker-missing', root: abs }
  }
  const sentinelPath = typeof marker.sentinel === 'string' && marker.sentinel ? marker.sentinel : stageSentinelPath(abs)
  if (!existsSync(sentinelPath)) return { alive: false, reason: 'sentinel-missing', root: abs, keeperPid: marker.keeperPid }
  const token = readTextFile(sentinelPath)
  if (token === undefined) return { alive: false, reason: 'sentinel-unreadable', root: abs, keeperPid: marker.keeperPid }
  // 哨兵内容在守护在位期间**不可改**（只给 FILE_SHARE_READ）；对不上 ⇒ 锁已经不在。
  if (String(token) !== String(marker.token)) {
    return { alive: false, reason: 'sentinel-tampered', root: abs, keeperPid: marker.keeperPid }
  }
  if (!processAlive(marker.keeperPid)) {
    return { alive: false, reason: 'keeper-dead', root: abs, keeperPid: marker.keeperPid }
  }
  return { alive: true, reason: 'guarded', root: abs, keeperPid: marker.keeperPid, sentinelPath }
}

// ═══════════════════════════════════════════════════════════════════════════
// 守护进程脚本（PowerShell 5.1）
// ═══════════════════════════════════════════════════════════════════════════
//
// 注意：这段脚本会被 `-EncodedCommand` 原样执行，**不含反引号**（反引号会撕裂 JS 模板串，
// 且 PS 的转义反引号在跨层传递时极易出错）；换行一律用 [Environment]::NewLine。
// 参数以单引号字符串内联替换（psQuote），不用 $args，避免 EncodedCommand 的传参歧义。

const KEEPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root        = @@ROOT@@
$Sentinel    = @@SENTINEL@@
$MarkerPath  = @@MARKER@@
$Ready       = @@READY@@
$ErrorFile   = @@ERRORFILE@@
$ReleaseFile = @@RELEASEFILE@@
$ParentPid   = @@PARENTPID@@
$Token       = @@TOKEN@@
$Version     = @@VERSION@@
$StartedAt   = @@STARTEDAT@@

$hSent = $null
$hDir = $null
$hProc = [System.IntPtr]::Zero
$established = $false
$utf8 = New-Object System.Text.UTF8Encoding($false)

function WriteFileText([string]$path, [string]$text) {
  $dir = [System.IO.Path]::GetDirectoryName($path)
  if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  [System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

try {
  Add-Type -Namespace WinStageGuard -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true, CharSet=System.Runtime.InteropServices.CharSet.Unicode, EntryPoint="CreateFileW")]
public static extern Microsoft.Win32.SafeHandles.SafeFileHandle CreateFileW(string lpFileName, uint dwDesiredAccess, uint dwShareMode, System.IntPtr lpSecurityAttributes, uint dwCreationDisposition, uint dwFlagsAndAttributes, System.IntPtr hTemplateFile);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern System.IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)]
public static extern uint WaitForSingleObject(System.IntPtr hHandle, uint dwMilliseconds);
'@

  $GENERIC_READ               = [uint32]2147483648
  $FILE_SHARE_READ            = [uint32]1
  $FILE_SHARE_WRITE           = [uint32]2
  $OPEN_EXISTING              = [uint32]3
  $FILE_ATTRIBUTE_NORMAL      = [uint32]128
  $FILE_FLAG_BACKUP_SEMANTICS = [uint32]33554432
  $SYNCHRONIZE                = [uint32]1048576
  $WAIT_OBJECT_0              = [uint32]0
  $WAIT_SLICE                 = [uint32]250

  if (-not (Test-Path -LiteralPath $Root)) { New-Item -ItemType Directory -Force -Path $Root | Out-Null }
  if (-not (Test-Path -LiteralPath $Sentinel)) { WriteFileText $Sentinel $Token }

  # ① 哨兵：GENERIC_READ + **只给 FILE_SHARE_READ**（不给 WRITE / DELETE）
  $hSent = [WinStageGuard.Native]::CreateFileW($Sentinel, $GENERIC_READ, $FILE_SHARE_READ, [System.IntPtr]::Zero, $OPEN_EXISTING, $FILE_ATTRIBUTE_NORMAL, [System.IntPtr]::Zero)
  if ($hSent.IsInvalid) { throw ('sentinel-open-failed:' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()) }

  # ② 根目录：GENERIC_READ + FILE_SHARE_READ|FILE_SHARE_WRITE（**不给 FILE_SHARE_DELETE**）
  $hDir = [WinStageGuard.Native]::CreateFileW($Root, $GENERIC_READ, ($FILE_SHARE_READ -bor $FILE_SHARE_WRITE), [System.IntPtr]::Zero, $OPEN_EXISTING, $FILE_FLAG_BACKUP_SEMANTICS, [System.IntPtr]::Zero)
  if ($hDir.IsInvalid) { throw ('root-open-failed:' + [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()) }

  # ③ 等父进程死（拿不到句柄就退化成轮询，绝不因此提前清理）
  $hProc = [WinStageGuard.Native]::OpenProcess($SYNCHRONIZE, $false, $ParentPid)

  # ⚠ PowerShell 变量名**不区分大小写**：$Marker 与 $marker 是同一个变量。
  # 这里因此把"路径"和"JSON 文本"取成两个不会互相踩的名字（$MarkerPath / $markerJson）——
  # 曾经写成 $Marker + $marker，于是路径被 JSON 文本覆盖，
  # GetDirectoryName 拿到 JSON 直接抛 "Illegal characters in path."（已由 wp0dbg4 定位）。
  # 本段脚本**不允许出现反引号**：它会撕裂 JS 模板串，也会让 PS 转义跨层失真。
  $markerJson = '{"version":' + $Version + ',"keeperPid":' + $PID + ',"parentPid":' + $ParentPid + ',"root":' + (ConvertTo-Json $Root -Compress) + ',"sentinel":' + (ConvertTo-Json $Sentinel -Compress) + ',"token":' + (ConvertTo-Json $Token -Compress) + ',"startedAt":' + (ConvertTo-Json $StartedAt -Compress) + ',"sentinelHandle":"' + $hSent.DangerousGetHandle().ToString() + '","dirHandle":"' + $hDir.DangerousGetHandle().ToString() + '"}'
  WriteFileText $MarkerPath $markerJson
  $established = $true
  WriteFileText $Ready 'ready'

  while ($true) {
    if ($hProc -ne [System.IntPtr]::Zero) {
      $w = [WinStageGuard.Native]::WaitForSingleObject($hProc, $WAIT_SLICE)
      if ($w -eq $WAIT_OBJECT_0) { break }
    } else {
      Start-Sleep -Milliseconds 250
      $p = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
      if ($null -eq $p) { break }
    }
    if (Test-Path -LiteralPath $ReleaseFile) { break }
  }
} catch {
  try { WriteFileText $ErrorFile ($_ | Out-String) } catch { }
} finally {
  try { if ($hSent -ne $null) { $hSent.Dispose() } } catch { }
  try { if ($hDir -ne $null) { $hDir.Dispose() } } catch { }
  if ($established) {
    for ($i = 0; $i -lt 60; $i++) {
      try {
        if (-not (Test-Path -LiteralPath $Root)) { break }
        Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction Stop
        break
      } catch { Start-Sleep -Milliseconds 120 }
    }
  }
}
`

/** PowerShell 单引号字符串字面量（`'` 双写转义） */
const psQuote = (value) => `'${String(value).replace(/'/g, "''")}'`

const KEEPER_VERSION = 1

function keeperScript({ root, sentinel, marker, ready, errorFile, releaseFile, parentPid, token }) {
  return KEEPER_SCRIPT
    .replace('@@ROOT@@', psQuote(root))
    .replace('@@SENTINEL@@', psQuote(sentinel))
    .replace('@@MARKER@@', psQuote(marker))
    .replace('@@READY@@', psQuote(ready))
    .replace('@@ERRORFILE@@', psQuote(errorFile))
    .replace('@@RELEASEFILE@@', psQuote(releaseFile))
    .replace('@@PARENTPID@@', String(Number(parentPid)))
    .replace('@@TOKEN@@', psQuote(token))
    .replace('@@VERSION@@', String(KEEPER_VERSION))
    .replace('@@STARTEDAT@@', psQuote(new Date().toISOString()))
}

// ═══════════════════════════════════════════════════════════════════════════
// 守护
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 进程内退化版（非 win32）：写标记+哨兵，语义接口逐字不变。
 * 抗外部清理**不成立**（Node 的 fs 无法收窄 share 位）—— 如实标注，不假装。
 */
function acquireInProcessGuard(root) {
  mkdirSync(root, { recursive: true })
  const token = randomUUID()
  const sentinel = stageSentinelPath(root)
  if (!existsSync(sentinel)) writeFileSync(sentinel, token)
  const marker = {
    version: KEEPER_VERSION,
    keeperPid: process.pid,
    parentPid: process.pid,
    root,
    sentinel,
    token,
    startedAt: new Date().toISOString(),
    inProcess: true,
  }
  writeFileSync(stageMarkerPath(root), JSON.stringify(marker, null, 2))
  return makeGuard({ root, sentinelPath: sentinel, keeperPid: process.pid, token, inProcess: true })
}

function makeGuard({ root, sentinelPath, keeperPid, token, inProcess }) {
  const state = { released: false }
  const guard = {
    root,
    sentinelPath,
    keeperPid,
    markerPath: stageMarkerPath(root),
    token,
    inProcess: Boolean(inProcess),
    status() {
      return verifyStageRootAlive(root)
    },
    assertAlive() {
      if (state.released) {
        throw new StageRootLostError('guard-released', { root, keeperPid })
      }
      const status = verifyStageRootAlive(root)
      if (!status.alive) {
        throw new StageRootLostError(status.reason, { root, keeperPid: status.keeperPid ?? keeperPid, status })
      }
      return status
    },
    release(options = {}) {
      if (state.released) return { root, removed: !existsSync(root), alreadyReleased: true }
      state.released = true
      LIVE_GUARDS.delete(root)
      const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 20000
      if (inProcess) {
        // 进程内守卫：句柄本来就不存在，直接删（但**本进程还活着**时这个根仍可能被自己写）
        const removed = removeTreeRetry(root, 20, 100)
        return { root, removed, leftover: existsSync(root) }
      }
      try {
        if (existsSync(root)) writeFileSync(stageReleasePath(root), 'release\n')
      } catch {
        /* 根可能已被守护删掉；下面统一判定 */
      }
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (!processAlive(keeperPid) || !existsSync(root)) break
        sleepSync(60)
      }
      // 守护已释放句柄；兜底再删一次（失败也不算错，留给启动清扫）
      const removed = removeTreeRetry(root, 3, 60)
      return { root, removed, keeperAlive: processAlive(keeperPid) }
    },
  }
  return guard
}

/**
 * 见文件头契约。同步建立守护（实测本机 ~0.6 s，会话内只做一次）。
 *
 * `options`：
 *   · `allowInProcess`  （默认 false）非 win32 或显式要求时退化为进程内守卫；
 *   · `readyTimeoutMs`  （默认 20000）等守护报到；
 *   · `parentPid`       （默认 process.pid）守护等待的进程 —— 它一死守护就清理。
 */
export function acquireStageGuard(root, options = {}) {
  const abs = normalize(String(root))
  const existing = LIVE_GUARDS.get(abs)
  if (existing) {
    existing.assertAlive()
    return existing
  }

  const allowInProcess = options.allowInProcess === true
  if (process.platform !== 'win32') {
    if (!allowInProcess) throw guardUnavailableError('unsupported-platform', { root: abs })
    const guard = acquireInProcessGuard(abs)
    LIVE_GUARDS.set(abs, guard)
    return guard
  }

  // ── 根建不出来时 **fail-closed**：绝不"换个地方继续写" ──────────────────────────
  // 本机实测（见 wp0 实证 #3）：宿主进程能建 `%LOCALAPPDATA%\Temp\winstage-stage`，
  // 但**被沙箱收窄的命令行子进程**不能（连在该目录里建文件/删文件都是 EPERM）。
  // 生产路径上本模块跑在宿主进程里、守护也是宿主的子进程，所以默认根可用；
  // 受限档里的调用方必须显式传 `override`（`resolveStageRoot({override})`）。
  // 无论如何**不静默回落到工作区**——那会把暂存重新变成模型可见的东西。
  try {
    mkdirSync(abs, { recursive: true })
  } catch (error) {
    throw guardUnavailableError(`root-not-creatable:${error?.code || 'ERR'}`, { root: abs })
  }
  const sentinel = stageSentinelPath(abs)
  const markerPath = stageMarkerPath(abs)
  const readyPath = join(abs, `.winstage-keeper.ready`)
  const errorPath = stageErrorPath(abs)
  const releasePath = stageReleasePath(abs)
  const token = randomUUID()
  const parentPid = Number(options.parentPid) || process.pid

  // 上一轮的残留：清掉 ready/error/release，避免把旧文件当成"这一轮已就绪"
  for (const stale of [readyPath, errorPath, releasePath]) {
    try {
      if (existsSync(stale)) rmSync(stale, { force: true })
    } catch {
      /* 清不掉就让下面的就绪判定超时，失败是显式的 */
    }
  }

  const script = keeperScript({
    root: abs,
    sentinel,
    marker: markerPath,
    ready: readyPath,
    errorFile: errorPath,
    releaseFile: releasePath,
    parentPid,
    token,
  })
  const encoded = Buffer.from(script, 'utf16le').toString('base64')

  // 守护日志**必须放在会话根之外**：它的句柄会挡住根目录的删除。
  // 放在根的**同级** `.guard-logs\` 里 —— 这样"根可写 ⇒ 日志可写"，
  // 既不依赖默认缓存根可写，又天然被启动清扫跳过（以 `.` 开头）。
  const logDir = options.logDir ? String(options.logDir) : join(dirname(abs), GUARD_LOG_DIR)
  let logFd
  try {
    mkdirSync(logDir, { recursive: true })
    logFd = openSync(join(logDir, `${abs.slice(abs.lastIndexOf(sep) + 1)}-${Date.now()}.log`), 'a')
  } catch {
    logFd = undefined
  }

  let child
  try {
    child = spawn(POWERSHELL, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
      windowsHide: true,
    })
  } catch (error) {
    if (logFd !== undefined) { try { closeSync(logFd) } catch { /* 无关紧要 */ } }
    throw guardUnavailableError('spawn-failed', { root: abs })
  }
  if (logFd !== undefined) { try { closeSync(logFd) } catch { /* 子进程已持有自己的副本 */ } }
  // ── 守护**不得**把宿主进程钉在事件循环里 ────────────────────────────────────────
  // `spawn()` 返回的 ChildProcess 默认是 ref 的：只要守护还活着，Node 就**不退出**。
  // 而守护恰恰在等"宿主进程退出"才结束 —— 两边互等 ⇒ 死锁（实测：wp0-test 跑完全部
  // 断言后仍不返回，10 分钟超时）。`unref()` 把子进程句柄从事件循环摘掉：
  // 宿主该退就退，守护随即由 WaitForSingleObject 唤醒并清理。**不要**用 detached ——
  // 本机实测 detached 的 powershell 子进程会静默死掉（见 wp0 实证记录）。
  child.unref()

  // 等守护报到（同步轮询；会话内一次，~0.6 s）
  const deadline = Date.now() + (Number.isFinite(options.readyTimeoutMs) ? options.readyTimeoutMs : 20000)
  let ready = false
  while (Date.now() < deadline) {
    if (existsSync(readyPath) && readJsonFile(markerPath)) { ready = true; break }
    if (existsSync(errorPath)) break
    if (child.exitCode !== null) break
    sleepSync(50)
  }

  if (!ready) {
    const detail = readTextFile(errorPath) || readTextFile(readyPath) || (child.exitCode !== null ? `keeper-exit-${child.exitCode}` : 'keeper-timeout')
    try { child.kill() } catch { /* 已经没了 */ }
    // 建不起来的根留着没用：清掉（这是我们刚建/刚接手的缓存目录，不是用户数据）。
    removeTreeRetry(abs, 5, 100)
    throw guardUnavailableError(String(detail).split(/\r?\n/)[0].slice(0, 120) || 'keeper-failed', { root: abs })
  }

  const marker = readJsonFile(markerPath) || {}
  const guard = makeGuard({ root: abs, sentinelPath: sentinel, keeperPid: marker.keeperPid ?? child.pid, token })
  LIVE_GUARDS.set(abs, guard)
  return guard
}

/** 释放某个根的守护（没建立过就是 no-op）。便于测试与收尾。 */
export function releaseStageGuard(root, options = {}) {
  const abs = normalize(String(root))
  const guard = LIVE_GUARDS.get(abs)
  if (guard) return guard.release(options)
  return { root: abs, removed: !existsSync(abs), alreadyReleased: true }
}

// ═══════════════════════════════════════════════════════════════════════════
// 启动清扫
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 见文件头契约。**不抛**；删不掉的进 `skipped`。
 * `keep` 每项可以是绝对路径，也可以是裸目录名（会话键）。
 */
export function sweepOrphanStageRoots({ baseDir, ttlMs = 6 * 60 * 60 * 1000, keep = [] } = {}) {
  const base = normalize(String(baseDir || stageBaseDir()))
  const removed = []
  const skipped = []
  if (!existsSync(base)) return { baseDir: base, removed, skipped }

  const keepPaths = new Set()
  const keepNames = new Set()
  for (const item of keep || []) {
    const text = String(item ?? '').trim()
    if (!text) continue
    keepPaths.add(normalize(pathResolve(text)))
    keepNames.add(text)
    keepNames.add(normalize(text))
  }

  const now = Date.now()
  let entries = []
  try {
    entries = readdirSync(base)
  } catch {
    return { baseDir: base, removed, skipped }
  }

  for (const name of entries) {
    if (name.startsWith('.')) continue // `.guard-logs` 这类内部目录不是会话根
    const abs = join(base, name)
    if (keepPaths.has(normalize(abs)) || keepNames.has(name)) {
      skipped.push(abs)
      continue
    }
    let info
    try {
      info = statSync(abs)
    } catch {
      continue
    }
    if (!info.isDirectory()) {
      if (now - info.mtimeMs > ttlMs && removeTreeRetry(abs, 2, 50)) removed.push(abs)
      else skipped.push(abs)
      continue
    }

    const status = verifyStageRootAlive(abs)
    if (status.alive) {
      skipped.push(abs)
      continue
    }
    const marked = existsSync(stageMarkerPath(abs))
    // 有标记但持有者已死 ⇒ 确定是孤儿，立刻清；完全无标记 ⇒ 只按年龄判定（可能是无关目录）
    const orphan = marked ? true : now - info.mtimeMs > ttlMs
    if (!orphan) {
      skipped.push(abs)
      continue
    }
    // 有活守护钉着时这里会失败 ⇒ skipped（句柄保护顺带兜住了误判）
    if (removeTreeRetry(abs, 2, 80)) removed.push(abs)
    else skipped.push(abs)
  }
  return { baseDir: base, removed, skipped }
}

// ═══════════════════════════════════════════════════════════════════════════
// 透明性自检
// ═══════════════════════════════════════════════════════════════════════════

/** 模型可见文案里**不得**出现的字样（含英文同义词与内部行话） */
export const FORBIDDEN_MODEL_TEXT = Object.freeze(['沙箱', '暂存', '替代路径', 'sandbox', 'staging', 'stage', 'shadow'])

/**
 * 对一批文案做透明性检查（`.code` 不算文案，契约要求它保持 `STAGE_ROOT_LOST`）。
 * 返回 `{ ok, violations: [{ text, word }] }`。
 */
export function checkTransparentMessages(texts = []) {
  const violations = []
  for (const text of texts) {
    const lower = String(text).toLowerCase()
    for (const word of FORBIDDEN_MODEL_TEXT) {
      if (lower.includes(word.toLowerCase())) violations.push({ text: String(text), word })
    }
  }
  return { ok: violations.length === 0, violations }
}

/** 自检：本模块能产出的全部 message 模板都过透明性检查 */
export function assertTransparentMessages() {
  const samples = []
  for (const reason of ['root-missing', 'marker-missing', 'marker-invalid', 'sentinel-missing', 'sentinel-unreadable', 'sentinel-tampered', 'keeper-dead', 'guard-released']) {
    samples.push(new StageRootLostError(reason, { root: 'C:\\x' }).message)
  }
  for (const reason of ['unsupported-platform', 'spawn-failed', 'keeper-timeout']) {
    samples.push(guardUnavailableError(reason, { root: 'C:\\x' }).message)
  }
  const result = checkTransparentMessages(samples)
  if (!result.ok) {
    throw new Error(`transparency violation: ${JSON.stringify(result.violations)}`)
  }
  return { ok: true, checked: samples.length }
}

export const __internal = { sanitizeKey, removeTreeRetry, keeperScript, POWERSHELL, KEEPER_VERSION }
