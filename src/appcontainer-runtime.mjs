/**
 * AppContainer 运行期模块 —— 把 `src/appcontainer.mjs` 的"布局与调用"接成"可被执行器调用"的形态
 *
 * ── 边界声明（阶段 A）────────────────────────────────────────────────────────
 * 本模块**不修改** `src/appcontainer.mjs`，只复用它已实测钉死的布局常量
 * （`STARTUPINFOEX_SIZE` / `SECURITY_CAPABILITIES_*` / `buildCreationFlags`），
 * 并补上它**刻意留空**的三件事：
 *   1. **能力 SID 的构造**（`DeriveCapabilitySidsFromName` → 打包成 `SID_AND_ATTRIBUTES[]`）；
 *   2. **属性列表的两阶段尺寸协商**（`InitializeProcThreadAttributeList` 的官方调用约定）；
 *   3. **profile 生命周期 + 组合顺序 + fail-closed 回滚**。
 *
 * ── 现状声明（**阶段 B 已大幅更新**）──────────────────────────────────────────
 * 阶段 A：本机 `CreateAppContainerProfile` 返回 `hr=0x80070005`（E_ACCESSDENIED）⇒ 运行期零实测。
 * 阶段 B：宿主换成 High IL 管理员令牌后，本模块**第一次真的跑起来了**，原始输出见
 *   `.t/sbx3/dev/raw-probe-appcontainer-runtime.txt`、`raw-probe-ac-token.txt`：
 *   - `[实测]` **profile 创建成功**：`CreateAppContainerProfile` `hr=0x0`，包 SID 形如
 *     `S-1-15-2-…`；用完 `DeleteAppContainerProfile` 删除成功（`createdHere=true` ⇒ `deletedProfile=true`，
 *     `%LOCALAPPDATA%\Packages` 下无残留）。
 *   - `[实测]` `DeriveAppContainerSidFromAppContainerName` `hr=0x0`（profile 不存在时也能派生）。
 *   - `[实测]` **进程能被创建出来**：`CreateProcessW` 返回 `1`，`si.cb=112`，`lpAttributeList` 非零，
 *     `ResumeThread` 正常，子进程退出码与命令一致（`cmd /c exit /b 42` → 42）。
 *   - `[实测]` **但创建出来的进程不在 AppContainer 里**：子进程 `whoami /all` 显示
 *     `win-dv9kreclbvs\administrator` + `BUILTIN\Administrators` + `Mandatory Label\High Mandatory Level`，
 *     组里**没有** `S-1-15-2-…`；用 `OpenProcessToken`+`GetTokenInformation(TokenUser)` 在
 *     `CREATE_SUSPENDED` 状态直接查，TokenUser 仍是用户 SID `S-1-5-21-…-500`。
 *     行为后果（原始观测）：**区内写成功、区外写也成功、ping/curl 都能通** —— 隔离为零。
 *   - `[实测]` 两个已定位的根因：
 *       1. `SECURITY_CAPABILITIES_SIZE` 曾取 **32**（错误），而 `[官方]` `sizeof(SECURITY_CAPABILITIES)` = **24**。
 *          `cbSize=32` 时 `UpdateProcThreadAttribute` 返回 `false` + `GetLastError()=ERROR_INVALID_PARAMETER(87)`，
 *          属性列表**未被写入**；改成 24 后属性**确实被写进列表**（可在 Buffer 偏移 24 处看到
 *          `09 00 02 00` = `0x00020009`、`18 00 00 00` = 24、以及 value 指针）。
 *          **修复阶段已把 `src/appcontainer.mjs` 的常量改为 24**（原本 32 是被一条循环论证的
 *          布局断言固化下来的），并同步把 `tests/appcontainer-layout.mjs` 的断言改成
 *          独立的官方字段算术 + 末尾无 padding 检查。此后 cbSize 不再是根因。
 *       2. 本模块原来用 `updated === 0` 判定失败，而 koffi 对 C 的 `bool` 返回 **JS boolean `false`**
 *          ⇒ 该检查在真实运行期**永不成立**，失败被静默吞掉。已由 `win32BoolSucceeded()` 修正
 *          （修正后同一调用会**大声抛** `APPCONTAINER_ATTRIBUTE_UPDATE_FAILED` + `win32Code=87`）。
 *   - `[未定位]` 即使 `cbSize=24`（属性已正确写入），子进程 TokenUser **仍然**是用户 SID
 *     ⇒ 还有一个更深的原因未查明。**T0 目前不可用**，接线前必须先解决这一条。
 *     因此 `src/capability.mjs::selectTier()` 对 T0 保持 fail-closed：
 *     需要 `report.appContainerIsolation.proven === true`（真实的"子进程身份/读面/网络面"探针证据）
 *     才允许选 T0，否则一律降到 T1 并在 reasons 里如实写明。
 *     下一步实验见 `.t/sbx3/dev/02-阶段B报告.md` §7。
 *
 * ── FIX-B 结论（**推翻上面那条"原因 3"**，原始证据 `.t/sbx3/dev/raw-t0-forensics.txt`）──
 * 阶段 B 的"原因 3"**不存在**，它是**判据错误**造成的：
 *   - 旧探针把子进程 `TokenUser` 与包 SID 比较，得出"没进 AppContainer"。
 *     `[实测]` AppContainer 令牌的 `TokenUser` **就是用户 SID**
 *     （`S-1-5-21-…-500`），包身份在 `TokenAppContainerSid(31)`；
 *     包 SID 也**不在** `TokenGroups` 里（"组里没有 `S-1-15-2-…`"完全正常）。
 *   - 用 `TokenIsAppContainer(29)` 直查（`CREATE_SUSPENDED` 状态下）：
 *     **`= 1`**，`TokenAppContainerSid` = 期望包 SID，`TokenIntegrityLevel = S-1-16-4096`（Low）。
 *     `cbSize=32` 的坏配置则是 `TokenIsAppContainer = 0` + High IL ⇒ 判据**有分辨力**。
 *   - 行为面也成立（`.t/sbx3/dev/raw-t0-behaviour.txt`）：
 *     子进程真在跑（`cmd /c exit /b 42` → 42）；**区外写被拒**（`C:\Windows\Temp` 与未授权同级目录
 *     都是 `copy` 失败 + 文件不存在，而宿主对照两条都成功）；
 *     **网络被阻断**（`curl` → `CURLE_COULDNT_CONNECT(7)`、`ping` 失败），
 *     声明了 `internetClient`（`S-1-15-3-1`）后 `curl` 立即成功（拿到 Cloudflare 301 页面）。
 *
 * 但 FIX-B 同时抓到 **T0 路径上第三个真缺陷**（会让 T0"看起来完全不可用"）：
 *   `[实测]` `bInheritHandles=TRUE` + 无自有控制台 ⇒ AppContainer 子进程在用户态初始化阶段
 *   直接死亡，退出码 **`0xC0000142`（STATUS_DLL_INIT_FAILED）**，
 *   而 `CreateProcessW` 仍返回成功、令牌也确实在 AppContainer 里 —— 一条命令都没执行。
 *   见 `.t/sbx3/dev/raw-t0-launch-matrix.txt`；修法与契约见 `CREATE_NEW_CONSOLE` 常量注释
 *   （`inheritHandles` 默认改为 `false`，`inheritHandles=true` 时必须带 `CREATE_NEW_CONSOLE`
 *   或 `DETACHED_PROCESS`，否则 fail-closed 抛 `APPCONTAINER_HANDLE_INHERITANCE_UNSAFE`）。
 *
 * ⇒ 现在的状态是：**T0 的隔离可以被证明**（用 `readProcessTokenFacts` + `assessAppContainerIsolation`），
 *   但 `appContainerIsolation.proven` **仍然只能由实测观测驱动**，本模块不会替任何调用方填 `true`。
 *
 * ── 一个必须记录在案的 API 事实（`[实测]` 读依赖源码）────────────────────────
 * `@deepseek-ai/dsh-win32-process@0.1.7-rc.2` 的 `spawnPipedProcess(api, options)`
 * 在 `lib/index.js:449-456` 里**硬编码** `cb: 104`（即 `sizeof(STARTUPINFOW)`），
 * 并在 `:458` 以 `creationFlags = 0` 调用 `CreateProcessAsUserW`。
 * 对 T1 路径这是**正确**的（T1 不需要属性列表）；但对 AppContainer **致命**：
 * AppContainer 必须用 `STARTUPINFOEXW` 且 `cb = sizeof(STARTUPINFOEXW) = 112`，
 * 填 104 会让 `CreateProcess` **静默忽略 `lpAttributeList`** —— 进程照常起来、
 * 返回值照常成功、**但根本不在 AppContainer 里**。
 * ⇒ 结论：**T0 不能复用 `spawnPipedProcess`**，必须另有一条能传 112 字节
 * `STARTUPINFOEXW` 的启动路径。这是 T0 接线清单里最容易被漏掉的一步
 * （见 `.t/sbx3/dev/00-现状与设计.md` §1.2 步骤 6）。
 *
 * ── 本模块给出的启动原语是"可注入"的 ────────────────────────────────────────
 * 本模块不自己调用 Koffi，而是接收一个 `bindings` 对象。这样：
 *   - 运行期可以把真实 Koffi 绑定喂进来；
 *   - 离线测试可以喂**逐字段对齐真实 API 的替身**（手册要求：替身宁可复杂也不要比真对象"更好用"）。
 *
 * 官方依据：
 *   Launch an AppContainer   https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer
 *   DeriveCapabilitySidsFromName
 *                            https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-derivecapabilitysidsfromname
 *   InitializeProcThreadAttributeList
 *                            https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-initializeprocthreadattributelist
 *   CreateAppContainerProfile / DeriveAppContainerSidFromAppContainerName
 *                            （`src/appcontainer.mjs` 顶部已引用）
 */

import {
  STARTUPINFOEX_SIZE,
  OFF_ATTRIBUTE_LIST,
  EXTENDED_STARTUPINFO_PRESENT,
  PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
  SECURITY_CAPABILITIES_SIZE,
  buildCreationFlags,
} from './appcontainer.mjs'
// ── 三轮接线：进程缓解策略（`PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY`）────────────
// 只取本模块真正要用的东西：属性号/尺寸/槽位数/注入函数/构造函数。
// `0x00020010`、8 字节、档位表**不在本模块重复定义** —— 与 `SECURITY_CAPABILITIES`
// 同一取舍（两处定义必然漂移，而漂移的那一处不会报错，只会静默失效）。
import {
  MITIGATION_POLICY_ATTRIBUTE,
  MITIGATION_POLICY_VALUE_SIZE,
  MITIGATION_ATTRIBUTE_LIST_COUNT,
  applyMitigationPolicy,
  buildMitigationPolicy,
} from './mitigations.mjs'

// ─────────────────────────── 常量 ───────────────────────────

/** `[官方]` `SE_GROUP_ENABLED`：能力 SID 必须带这个属性才生效 */
export const SE_GROUP_ENABLED = 0x00000004

/** `[官方]` `SID_AND_ATTRIBUTES { PSID Sid; DWORD Attributes; }`：x64 下 8 + 4 + 4(pad) = 16 */
export const SID_AND_ATTRIBUTES_SIZE = 16
export const OFF_SID_AND_ATTRIBUTES = Object.freeze({ sid: 0, attributes: 8 })

/**
 * `[官方]` `PROCESS_INFORMATION { HANDLE hProcess; HANDLE hThread; DWORD dwProcessId; DWORD dwThreadId; }`
 * x64：8 + 8 + 4 + 4 = **24** 字节，无尾部 padding。
 *
 * 阶段 B 实测缺陷：koffi 绑定层原来把 `PROCESS_INFORMATION *pi` 声明成 `void *`，
 * 而模块契约要求"可写对象"，于是真实调用抛 `Unexpected Object value, expected void *`。
 * 修法是在绑定层用 24 字节 Buffer 接出参（`_Out_ uint8 *`）再逐字段读回，
 * 因此这两个布局常量必须与 SDK 一致（错了会读到别人的句柄）。
 */
export const PROCESS_INFORMATION_SIZE = 24
export const OFF_PROCESS_INFORMATION = Object.freeze({ hProcess: 0, hThread: 8, dwProcessId: 16, dwThreadId: 20 })

/** `[官方]` `CREATE_SUSPENDED`：先挂 Job 再 resume，消除"挂 Job 前的竞态"（本仓库 R9） */
export const CREATE_SUSPENDED = 0x00000004

/**
 * `[官方]` `DETACHED_PROCESS` / `CREATE_NEW_CONSOLE`。
 *
 * ── 为什么 T0 必须显式用其中之一（`[实测-阶段FIX-B]`）────────────────────────
 * 原始证据：`.t/sbx3/dev/raw-t0-launch-matrix.txt`。同一个 `cmd.exe`、同一份已正确写入的
 * 属性列表（`cbSize=24`、`TokenIsAppContainer=1` 已证明属性生效），只改创建标志：
 *
 *   | 配置 | 子进程退出码 |
 *   |---|---|
 *   | `EXT|SUSPENDED`，`bInheritHandles=TRUE`（模块旧默认） | **`0xC0000142` = `STATUS_DLL_INIT_FAILED`** |
 *   | 同上 + `CREATE_NEW_CONSOLE` | `42`（= `cmd /c exit /b 42`，真的跑到底） |
 *   | 同上 + `DETACHED_PROCESS` | `42` |
 *   | 同上但 `bInheritHandles=FALSE` | `42` |
 *
 * 也就是说：**AppContainer 子进程继承父进程的句柄时，若同时附着在父进程的控制台上，
 * 用户态初始化会失败并直接死掉**（进程创建成功、令牌也确实是 AppContainer，
 * 但一条命令都不执行）。这个失败不会在 `CreateProcessW` 的返回值里体现 ——
 * 属于本项目反复警告的"看起来成功、实际什么都没跑"。
 * ⇒ 契约：`inheritHandles=TRUE` 时**必须**同时给 `CREATE_NEW_CONSOLE` 或 `DETACHED_PROCESS`，
 * 否则本模块 fail-closed 抛 `APPCONTAINER_HANDLE_INHERITANCE_UNSAFE`。
 */
export const DETACHED_PROCESS = 0x00000008
export const CREATE_NEW_CONSOLE = 0x00000010

/** `[实测]` AppContainer 子进程在"继承句柄 + 无自有控制台"时的退出码 */
export const STATUS_DLL_INIT_FAILED = 0xc0000142

/** `[官方]` `SeAssignPrimaryTokenPrivilege` 相关：`CreateProcessAsUserW` 需要的令牌访问掩码 */
export const TOKEN_QUERY_ACCESS = 0x00000008
export const TOKEN_DUPLICATE_ACCESS = 0x00000002

/** 通用错误码（`GetLastError` 值） */
export const ERROR_INSUFFICIENT_BUFFER = 122
export const ERROR_ALREADY_EXISTS = 183

/** `[官方]` `HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)` = 0x800700B7：profile 已存在，应改用派生 */
export const HR_ALREADY_EXISTS = 0x800700b7

/**
 * OFFLINE 默认能力集 = **空**。
 *
 * `[官方]`："without the network capability, an AppContainer cannot access the network"。
 * 也就是说"不声明 `internetClient`"本身就是网络阻断的**正向**手段，
 * 而不是"我们忘了配"。
 */
export const DEFAULT_CAPABILITIES = Object.freeze([])

/** 需要联网时才显式加入的能力（默认**不**加入） */
export const NETWORK_CAPABILITY = 'internetClient'

/**
 * Win32 `BOOL` 返回值 → 成功？
 *
 * ── 这一条是阶段 B 最重要的实测结论（原始证据见 .t/sbx3/dev/raw-probe-ac-token.txt）──
 * koffi 把 C 的 `bool` 返回成 JS **boolean**（`true`/`false`），而离线替身一律返回数字 `1`/`0`。
 * 模块原来把失败判断写成 `updated === 0` / `created === 0` / `second === 0`：
 * 在替身下成立，在**真实运行期对 `false` 永远不成立** ⇒ **所有 BOOL 失败检查都是死代码**。
 *
 * 实测后果（不是推理）：`UpdateProcThreadAttribute` 返回 `false` 且
 * `GetLastError() = ERROR_INVALID_PARAMETER(87)`，代码却当成功继续往下走，
 * 结果 `CreateProcessW` 返回 `1`、子进程正常创建、退出码正常 ——
 * **但子进程的令牌是完整的管理员 High IL，组里没有包 SID**：根本没有隔离。
 * 这正是本模块开头警告的"看起来成功、实际边界没生效"的最坏形态。
 *
 * 因此统一用本函数判定：boolean 直接取用；数字按 `!= 0`；`null`/`undefined`/其它一律视为失败（fail-closed）。
 */
export function win32BoolSucceeded(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return false
}

// ─────────────────────────── 纯构造 ───────────────────────────

function runtimeError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  Object.assign(error, extra)
  return error
}

/**
 * 打包 `SID_AND_ATTRIBUTES[]`。
 *
 * `[官方]` `SID_AND_ATTRIBUTES = { PSID Sid; DWORD Attributes; }`；AppContainer 样例里
 * `Attributes = SE_GROUP_ENABLED`。
 *
 * 刻意**不**接受"裸 SID 数组再自动补属性"：官方样例是显式写 `SE_GROUP_ENABLED`，
 * 而"默认补上"会在"将来需要 `SE_GROUP_USE_FOR_DENY_ONLY`"时静默做错事。
 *
 * @param {Array<{sid: unknown, attributes?: number}>} capabilities
 * @returns {{buffer: Buffer, count: number}}
 */
export function buildSidAndAttributesArray(capabilities = []) {
  if (!Array.isArray(capabilities)) throw new TypeError('buildSidAndAttributesArray: capabilities must be an array')
  const buffer = Buffer.alloc(capabilities.length * SID_AND_ATTRIBUTES_SIZE)
  capabilities.forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw runtimeError('APPCONTAINER_CAPABILITY_INVALID', `capability[${index}] must be an object {sid, attributes?}`)
    }
    if (entry.sid === null || entry.sid === undefined) {
      throw runtimeError('APPCONTAINER_CAPABILITY_INVALID', `capability[${index}].sid is null — refusing to build a capability entry without a SID`)
    }
    const attributes = entry.attributes ?? SE_GROUP_ENABLED
    if (!Number.isInteger(attributes) || attributes < 0) {
      throw runtimeError('APPCONTAINER_CAPABILITY_INVALID', `capability[${index}].attributes must be a non-negative integer`)
    }
    const base = index * SID_AND_ATTRIBUTES_SIZE
    writePointerLe(buffer, base + OFF_SID_AND_ATTRIBUTES.sid, entry.sid, `capability[${index}].sid`)
    buffer.writeUInt32LE(attributes >>> 0, base + OFF_SID_AND_ATTRIBUTES.attributes)
  })
  return { buffer, count: capabilities.length }
}

/**
 * 与 `src/appcontainer.mjs::writePointer` 同语义的本地实现。
 *
 * 为什么不 import 那个内部的 `writePointer`：它只通过 `__internal` 暴露，
 * 而 `__internal` 是"测试用"出口；跨模块依赖测试出口会让依赖升级时的破坏面变大。
 * 这里只重复 20 行纯逻辑，换来"只依赖公开常量"的稳定性。
 */
function writePointerLe(buffer, offset, value, what = 'pointer') {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('writePointerLe: buffer must be a Buffer')
  if (offset < 0 || offset + 8 > buffer.length) {
    throw runtimeError('APPCONTAINER_LAYOUT_OVERFLOW', `${what}: offset ${offset}+8 exceeds buffer length ${buffer.length}`)
  }
  if (value === null || value === undefined) {
    buffer.writeBigUInt64LE(0n, offset)
    return
  }
  if (typeof value === 'bigint') {
    buffer.writeBigUInt64LE(value, offset)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      throw runtimeError('APPCONTAINER_POINTER_INVALID', `${what}: numeric pointer must be a non-negative integer, got ${value}`)
    }
    buffer.writeBigUInt64LE(BigInt(value), offset)
    return
  }
  if (typeof value === 'object' && typeof value.address === 'function') {
    const address = value.address()
    if (typeof address !== 'bigint') {
      throw runtimeError('APPCONTAINER_POINTER_INVALID', `${what}: address() returned ${typeof address}, expected bigint`)
    }
    buffer.writeBigUInt64LE(address, offset)
    return
  }
  throw runtimeError('APPCONTAINER_POINTER_INVALID', `${what}: cannot encode pointer of type ${typeof value}`)
}

/**
 * 构造 `STARTUPINFOEXW` 缓冲区。
 *
 * **`cb` 必须是 112**（`sizeof(STARTUPINFOEXW)`），不是 104。
 * 官方 `[Launch an AppContainer]` 样例写的是 `si.StartupInfo.cb = sizeof(si);` ——
 * `si` 的类型是 `STARTUPINFOEX`，所以 `sizeof(si)` = 112。填 104 的后果是
 * `lpAttributeList` 被**静默忽略**，进程仍然启动成功但不在 AppContainer 里。
 * 本函数把这个不变量**在构造期**钉死（不是靠调用方自觉）。
 *
 * @param {{attributeListPointer?: unknown, cb?: number}} options
 * @returns {Buffer} 112 字节
 */
/**
 * `[官方]` `STARTUPINFOW` 的字段偏移（x64）。只列本模块要写的三个标准句柄 + `dwFlags`。
 *
 * 之所以要在这里补上"文件式 stdio"：T0 的 `inheritHandles=false` 拿不到子进程输出，
 * 而 `inheritHandles=true` 又必须配 `CREATE_NEW_CONSOLE`/`DETACHED_PROCESS`（否则子进程
 * `0xC0000142`）。`STARTF_USESTDHANDLES` + 三个文件句柄是唯一能同时满足两边的组合。
 * 不写 `cb`/`lpAttributeList` 之外任何字节的旧实现，等于**没有**标准句柄这条路。
 */
export const OFF_STARTUP_INFO_FLAGS = 60
export const OFF_STD_INPUT = 72
export const OFF_STD_OUTPUT = 80
export const OFF_STD_ERROR = 88
/** `[官方]` `STARTF_USESTDHANDLES` */
export const STARTF_USESTDHANDLES = 0x00000100

/**
 * 构造 `STARTUPINFOEXW` 缓冲区（可选写入标准句柄）。
 *
 * **`cb` 必须是 112**（`sizeof(STARTUPINFOEXW)`），不是 104。
 * 官方 `[Launch an AppContainer]` 样例写的是 `si.StartupInfo.cb = sizeof(si);` ——
 * `si` 的类型是 `STARTUPINFOEX`，所以 `sizeof(si)` = 112。填 104 的后果是
 * `lpAttributeList` 被**静默忽略**，进程仍然启动成功但不在 AppContainer 里。
 * 本函数把这个不变量**在构造期**钉死（不是靠调用方自觉）。
 *
 * @param {{attributeListPointer?: unknown, cb?: number,
 *          stdInput?: unknown, stdOutput?: unknown, stdError?: unknown,
 *          useStdHandles?: boolean}} options
 * @returns {Buffer} 112 字节
 */
export function buildStartupInfoExBuffer({
  attributeListPointer = null,
  cb = STARTUPINFOEX_SIZE,
  stdInput = null,
  stdOutput = null,
  stdError = null,
  useStdHandles = false,
} = {}) {
  if (cb !== STARTUPINFOEX_SIZE) {
    throw runtimeError(
      'APPCONTAINER_CB_INVALID',
      `STARTUPINFOEXW.cb must be ${STARTUPINFOEX_SIZE} (sizeof(STARTUPINFOEXW)), got ${cb}. ` +
        'Passing sizeof(STARTUPINFOW)=104 makes CreateProcess silently ignore lpAttributeList — ' +
        'the child starts successfully but is NOT in an AppContainer.',
    )
  }
  const buffer = Buffer.alloc(STARTUPINFOEX_SIZE)
  buffer.writeUInt32LE(STARTUPINFOEX_SIZE >>> 0, 0) // cb 位于 STARTUPINFOW 的首字段
  writePointerLe(buffer, OFF_ATTRIBUTE_LIST, attributeListPointer, 'lpAttributeList')
  // `STARTF_USESTDHANDLES` 必须与三个句柄**成对**出现：只写句柄不置位 ⇒ 句柄被忽略（子进程
  // 的 stdout 会被悄悄接到父控制台，而我们以为在文件里）；只置位不写句柄 ⇒ 子进程的
  // stdout 变成一个无效句柄（写入直接失败）。两种都是"看起来成功"的形态，故成对写。
  if (useStdHandles) {
    writePointerLe(buffer, OFF_STD_INPUT, stdInput, 'hStdInput')
    writePointerLe(buffer, OFF_STD_OUTPUT, stdOutput, 'hStdOutput')
    writePointerLe(buffer, OFF_STD_ERROR, stdError, 'hStdError')
    buffer.writeUInt32LE(STARTF_USESTDHANDLES >>> 0, OFF_STARTUP_INFO_FLAGS)
  }
  return buffer
}

// ─────────────────────────── 属性列表两阶段协商 ───────────────────────────

/**
 * `InitializeProcThreadAttributeList` 的两阶段协商（`[官方]` 调用约定）。
 *
 * 官方原文："First, call this function with the `dwAttributeCount` parameter set to the maximum
 * number of attributes you will be using and the `lpAttributeList` to NULL. […] **Note** This initial
 * call will return an error by design. This is expected behavior."
 *
 * 因此**不能**把第一次调用的"失败"当成错误。唯一合法的"第一次失败"原因是
 * `GetLastError() === ERROR_INSUFFICIENT_BUFFER(122)`；**任何其它错误码都必须上抛**
 * （否则"属性列表根本没建起来"会被静默当成"拿到了尺寸"）。
 *
 * @param {object} bindings 需提供 `initializeProcThreadAttributeList(listPtrOrNull, count, flags, sizeSlot)`、
 *   `getLastError()`。`sizeSlot` 是出参槽位（Koffi 风格数组）。
 * @param {number} attributeCount 属性个数（AppContainer=1，LPAC=2）
 * @returns {{size: number, buffer: Buffer}} `buffer` 是已初始化的属性列表
 */
export function allocateAttributeList(bindings, attributeCount) {
  if (!bindings || typeof bindings.initializeProcThreadAttributeList !== 'function') {
    throw runtimeError('APPCONTAINER_BINDINGS_MISSING', 'bindings.initializeProcThreadAttributeList is required')
  }
  if (!Number.isInteger(attributeCount) || attributeCount < 1) {
    throw runtimeError('APPCONTAINER_ATTRIBUTE_COUNT_INVALID', `attributeCount must be a positive integer, got ${attributeCount}`)
  }
  const sizeSlot = [0]
  const first = bindings.initializeProcThreadAttributeList(null, attributeCount, 0, sizeSlot)
  const firstError = typeof bindings.getLastError === 'function' ? bindings.getLastError() : 0
  if (!win32BoolSucceeded(first) && firstError !== ERROR_INSUFFICIENT_BUFFER) {
    throw runtimeError(
      'APPCONTAINER_ATTRIBUTE_LIST_SIZE_FAILED',
      `InitializeProcThreadAttributeList(NULL, ${attributeCount}, 0, &size) failed with ${firstError}; ` +
        'only ERROR_INSUFFICIENT_BUFFER(122) is expected on the size-probing call',
      { win32Code: firstError },
    )
  }
  const size = sizeSlot[0]
  if (!Number.isInteger(size) || size <= 0) {
    throw runtimeError('APPCONTAINER_ATTRIBUTE_LIST_SIZE_FAILED', `size probe returned ${size}; expected a positive size`)
  }
  const buffer = Buffer.alloc(size)
  const second = bindings.initializeProcThreadAttributeList(buffer, attributeCount, 0, sizeSlot)
  const secondError = typeof bindings.getLastError === 'function' ? bindings.getLastError() : 0
  if (!win32BoolSucceeded(second)) {
    throw runtimeError(
      'APPCONTAINER_ATTRIBUTE_LIST_INIT_FAILED',
      `InitializeProcThreadAttributeList(buffer, ${attributeCount}, 0, &size) failed with ${secondError}`,
      { win32Code: secondError },
    )
  }
  return { size, buffer }
}

/**
 * 把"策略"归一成"要不要占一个属性槽位 + 用哪一份 buffer"。
 *
 * 三种输入都接受（与 `src/mitigations.mjs` 的公开契约一致）：
 *   · `null` / `undefined`      → `null`（不占槽位，一次 API 都不调）；
 *   · 档位名 / `{profile,...}`  → 本函数**就地构造**（返回的对象由调用方持有 ⇒ buffer 活到
 *     属性列表销毁为止；`[官方]`：属性值指针必须存活到属性列表被销毁）；
 *   · `buildMitigationPolicy()` 的产物 → 原样使用（同一 flags、同一 buffer）。
 *
 * `flags === 0n`（= `none` 档）在语义上就是"无事可做"，归一成 `null`：
 * 于是"槽位数"与"是否调用 `UpdateProcThreadAttribute`"**永远由同一个判据决定**，
 * 不会出现"算 2 个槽位却只写 1 条"（`ERROR_INSUFFICIENT_BUFFER(122)` 的成因）。
 */
function resolveMitigationPolicy(policy) {
  if (policy === null || policy === undefined) return null
  const built =
    typeof policy === 'object' && typeof policy.flags === 'bigint' && Buffer.isBuffer(policy.buffer) && Array.isArray(policy.names)
      ? policy
      : buildMitigationPolicy(policy)
  return built.flags === 0n ? null : built
}

/**
 * `InitializeProcThreadAttributeList` 的 `dwAttributeCount`。
 *
 * `[官方]` 该计数必须 ≥ 实际 `UpdateProcThreadAttribute` 次数，否则更新返回
 * `ERROR_INSUFFICIENT_BUFFER(122)`（`src/mitigations.mjs` 文件头已留档）。
 *   · 无缓解策略 / `none` ⇒ **1**（只有 `SECURITY_CAPABILITIES`）—— 与接线前逐字一致；
 *   · 非 no-op 策略       ⇒ **2**（`SECURITY_CAPABILITIES` + `MITIGATION_POLICY`）。
 *
 * 导出是为了让集成方与离线测试能**读同一个判据**，而不是各自数数。
 * `[未实测]` 本机没有真实跑过 `0x00020010` 的写入（无 SDK、未做真实 CreateProcess）：
 * 该属性号目前只有"winnt.h 宏规则 + 同规则已实测的 0x00020009"这一条证据链。
 */
export function attributeListCountFor(mitigationPolicy) {
  return resolveMitigationPolicy(mitigationPolicy) === null ? 1 : 1 + MITIGATION_ATTRIBUTE_LIST_COUNT
}

// ─────────────────────────── 启动原语（可注入）───────────────────────────

/**
 * 用 `STARTUPINFOEXW` + 属性列表启动一个 AppContainer 进程。
 *
 * `dwCreationFlags` 由 `buildCreationFlags()` 给出（含 `EXTENDED_STARTUPINFO_PRESENT`），
 * 并**强制**加上 `CREATE_SUSPENDED`（见 `launchAppContainer` 的顺序理由）。
 *
 * `bindings` 需要的函数（全部按 Win32 签名）：
 *   - `initializeProcThreadAttributeList(listPtrOrNull, count, flags, sizeSlot)`
 *   - `updateProcThreadAttribute(listPtr, flags, attribute, valuePtr, valueSize, prevValue, returnSize)`
 *   - `createProcessW(applicationName, commandLine, pa, ta, inheritHandles, flags, envPtr, cwd, siPtr, piPtr)`
 *   - `resumeThread(threadHandle)` / `getLastError()`
 *   - `pin(buffer, what) -> address`（可选；见下）
 *
 * ── 两个内嵌指针都不能靠"把 Buffer 当指针"蒙过去（阶段 B 实测缺陷）────────────
 * **缺陷 1（本次实测暴露）**：`STARTUPINFOEXW.lpAttributeList`。初版写成
 *   `buildStartupInfoExBuffer({ attributeListPointer: attributeList })`，
 *   `attributeList` 是 `Buffer.alloc()` 出来的 JS 堆内存 → `writePointerLe` 抛
 *   `APPCONTAINER_POINTER_INVALID: lpAttributeList: cannot encode pointer of type object`。
 *   **每一次启动都需要它**，所以 `pin` 实际上是必需的（除非显式给 `attributeListPointer`）。
 *   缺失即抛 `APPCONTAINER_PIN_REQUIRED`。
 *
 * **缺陷 2（同类）**：`SECURITY_CAPABILITIES.Capabilities`。初版写成
 *   `writePointerLe(securityCapabilities, 8, capabilityArray.count > 0 ? capabilityArray.buffer : null, 'Capabilities')`，
 *   把一个 **Buffer** 当指针传进去 → `APPCONTAINER_POINTER_INVALID`（`typeof Buffer === 'object'`）。
 *   它只在"声明了能力 SID"时才需要。缺失即抛 `APPCONTAINER_CAPABILITY_POINTER_MISSING`。
 *
 * 两处的根因相同：JS Buffer 没有 Node 公开 API 可查的原生地址，所以**必须由调用方提供地址**。
 * 按优先级解析：
 *   1. 显式 `options.attributeListPointer` / `options.capabilityArrayPointer`；
 *   2. `options.pin(buffer, what)`；
 *   3. `bindings.pin(buffer, what)` —— `createKoffiAppContainerBindings()` 已内置
 *      `(buffer) => koffi.address(buffer)`（`[实测]` koffi 3.3.2 提供 `address()`）。
 * `capabilities` 为空时 `Capabilities` 就是 `NULL`、`CapabilityCount=0`
 * —— 这也正是 OFFLINE 档位的默认形态（不声明能力 ⇒ 无网络）。
 *
 * **刻意不提供"写个假非零值占位"的退化路径**：假指针一旦真被送进 `CreateProcess`，
 * 要么失败在一个说不清的地方，要么**成功但静默忽略属性列表**（=进程根本不在 AppContainer 里）。
 * 后者正是本项目最想避免的失败模式。
 *
 * @returns {{pid: number, process: unknown, thread: unknown, attributeList: Buffer, startupInfo: Buffer,
 *            attributeCount: number, mitigationPolicy: object|null}}
 */
export function spawnSuspendedAppContainer(bindings, options = {}) {
  const {
    appContainerSid,
    capabilities = [],
    commandLine,
    applicationName = null,
    cwd = null,
    environmentBlock = null,
    capabilityArrayPointer = null,
    // `[实测-阶段FIX-B]` 见 CREATE_NEW_CONSOLE 的注释：默认**不**继承句柄。
    inheritHandles = false,
    extraCreationFlags = 0,
    // 文件式 stdio：调用方打开的原生句柄地址（`{stdInput,stdOutput,stdError}`）。
    // 只有 `inheritHandles=true` 时才有意义 —— 句柄要能被继承。
    startupInfoStdio = null,
    // 三轮接线：进程缓解策略。`null`/`undefined`/`none` ⇒ 行为与接线前**逐字一致**。
    mitigationPolicy = null,
  } = options

  for (const required of ['initializeProcThreadAttributeList', 'updateProcThreadAttribute', 'createProcessW', 'resumeThread', 'getLastError']) {
    if (!bindings || typeof bindings[required] !== 'function') {
      throw runtimeError('APPCONTAINER_BINDINGS_MISSING', `bindings.${required} is required to launch an AppContainer process`)
    }
  }
  if (appContainerSid === null || appContainerSid === undefined) {
    throw runtimeError('APPCONTAINER_SID_MISSING', 'appContainerSid is required; refusing to launch without a package SID')
  }
  if (typeof commandLine !== 'string' || commandLine.length === 0) {
    throw runtimeError('APPCONTAINER_COMMAND_MISSING', 'commandLine must be a non-empty string')
  }

  // ── 属性列表容量（三轮接线：缓解策略占第 2 个槽位）──────────────────────────
  // 无策略 / `none` ⇒ 仍是 1，与接线前逐字一致；非 no-op ⇒ 2。
  const mitigation = resolveMitigationPolicy(mitigationPolicy)
  const attributeCount = mitigation === null ? 1 : 1 + MITIGATION_ATTRIBUTE_LIST_COUNT
  const { buffer: attributeList } = allocateAttributeList(bindings, attributeCount)
  const capabilityArray = buildSidAndAttributesArray(capabilities)

  // 内嵌指针的来源：options.pin 优先，其次 bindings.pin（createKoffiAppContainerBindings 已内置 koffi.address）。
  const pin = typeof options.pin === 'function' ? options.pin : typeof bindings.pin === 'function' ? bindings.pin : null
  const resolvePointer = (explicit, buffer, what) => {
    let resolved = explicit
    if ((resolved === null || resolved === undefined) && pin) resolved = pin(buffer, what)
    if (Buffer.isBuffer(resolved)) {
      // 阶段 B 实测缺陷的**永久回归断言**：Buffer 是 JS 堆内存，不是地址。
      throw runtimeError(
        'APPCONTAINER_POINTER_INVALID',
        `${what}: expected an address (bigint / non-negative number / object with address()), got a Buffer. ` +
          'A Buffer has no exposed native address in Node, so passing one is always a bug.',
      )
    }
    return resolved
  }

  // lpAttributeList 是**每次启动都必须**的内嵌指针（SECURITY_CAPABILITIES 那一个只在有能力 SID 时才需要）。
  const attributeListPointer = resolvePointer(options.attributeListPointer ?? null, attributeList, 'lpAttributeList')
  if (attributeListPointer === null || attributeListPointer === undefined) {
    throw runtimeError(
      'APPCONTAINER_PIN_REQUIRED',
      'STARTUPINFOEXW.lpAttributeList is an embedded pointer and must be supplied: pass pin (a ' +
        '(buffer, what) => address callback; with koffi use (b) => koffi.address(b), which ' +
        'createKoffiAppContainerBindings() already wires up as bindings.pin) or attributeListPointer explicitly. ' +
        'This module will not invent a placeholder pointer: CreateProcess would then either fail or, worse, ' +
        'succeed while silently ignoring the attribute list.',
    )
  }

  // 内嵌指针解析（必须在 updateProcThreadAttribute 之前完成：失败就不该改任何东西）
  let resolvedCapabilityPointer = null
  if (capabilityArray.count > 0) {
    resolvedCapabilityPointer = resolvePointer(capabilityArrayPointer, capabilityArray.buffer, 'Capabilities')
    if (resolvedCapabilityPointer === null || resolvedCapabilityPointer === undefined) {
      throw runtimeError(
        'APPCONTAINER_CAPABILITY_POINTER_MISSING',
        `${capabilityArray.count} capability SID(s) were supplied, so SECURITY_CAPABILITIES.Capabilities must point at ` +
          'their native SID_AND_ATTRIBUTES array — but no address was given. Pass capabilityArrayPointer (explicit ' +
          'address) or pin (a (buffer, what) => address callback; with koffi: (b) => koffi.address(b)). ' +
          'This module will not invent a placeholder pointer.',
      )
    }
  }

  // SECURITY_CAPABILITIES 的布局沿用 src/appcontainer.mjs 的常量（本模块不重复定义，避免两处漂移）。
  const securityCapabilities = Buffer.alloc(SECURITY_CAPABILITIES_SIZE)
  // 字段次序：{ PSID AppContainerSid; PSID_AND_ATTRIBUTES Capabilities; DWORD CapabilityCount; DWORD Reserved; }
  writePointerLe(securityCapabilities, 0, appContainerSid, 'AppContainerSid')
  writePointerLe(securityCapabilities, 8, resolvedCapabilityPointer, 'Capabilities')
  securityCapabilities.writeUInt32LE(capabilityArray.count >>> 0, 16)
  securityCapabilities.writeUInt32LE(0, 20)

  const updated = bindings.updateProcThreadAttribute(
    attributeList,
    0,
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    securityCapabilities,
    SECURITY_CAPABILITIES_SIZE,
    null,
    null,
  )
  if (!win32BoolSucceeded(updated)) {
    const code = bindings.getLastError()
    throw runtimeError(
      'APPCONTAINER_ATTRIBUTE_UPDATE_FAILED',
      `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES) failed with ${code}. ` +
        `Attr id=0x${PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES.toString(16)}, value size=${SECURITY_CAPABILITIES_SIZE}. ` +
        `[实测] 本机 cbSize=32 时该调用返回 false + ERROR_INVALID_PARAMETER(87)：官方 sizeof(SECURITY_CAPABILITIES) 是 24 ` +
        `（PSID 8 + PSID_AND_ATTRIBUTES 8 + DWORD 4 + DWORD 4），见 .t/sbx3/dev/raw-probe-ac-token.txt 第 B 节。` +
        `修复阶段已把 src/appcontainer.mjs 的常量改成 24；若这里仍看到 87，说明失败原因不是 cbSize。`,
      { win32Code: code },
    )
  }

  // ── 进程缓解策略（三轮接线；默认 `null` ⇒ 这一整段不执行）──────────────────────
  // 顺序与官方样例一致：先 `SECURITY_CAPABILITIES`，再 `MITIGATION_POLICY`。
  // `applyMitigationPolicy()` **绝不吞失败**：属性没写进列表就抛
  // `MITIGATION_ATTRIBUTE_UPDATE_FAILED`（带 `win32Code`）。这里把它改写成与上面
  // SECURITY_CAPABILITIES 失败**同一风格**的 `APPCONTAINER_ATTRIBUTE_UPDATE_FAILED`，
  // 并保留底层 code + win32Code —— 让启动中止（fail-closed），
  // 而不是得到一个"看起来被加固、实际裸奔"的子进程。
  if (mitigation !== null) {
    try {
      applyMitigationPolicy({ api: bindings, attrList: attributeList, policy: mitigation, pin })
    } catch (error) {
      const win32Code = error?.win32Code ?? null
      throw runtimeError(
        'APPCONTAINER_ATTRIBUTE_UPDATE_FAILED',
        `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY) failed with ${win32Code ?? '(no GetLastError)'}. ` +
          `Attr id=0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}, value size=${MITIGATION_POLICY_VALUE_SIZE}, ` +
          `profile=${mitigation.profile}, flags=0x${mitigation.flags.toString(16).padStart(16, '0')}, ` +
          `win32Code=${win32Code ?? 'null'}, mitigationCode=${error?.code ?? 'MITIGATION_ATTRIBUTE_UPDATE_FAILED'}. ` +
          'The attribute list was NOT written, so the child would silently run WITHOUT these mitigations; ' +
          `aborting the launch (fail-closed). 底层错误：${error?.message ?? String(error)}`,
        {
          win32Code,
          mitigationCode: error?.code ?? null,
          attribute: MITIGATION_POLICY_ATTRIBUTE,
          size: MITIGATION_POLICY_VALUE_SIZE,
          profile: mitigation.profile,
        },
      )
    }
  }

  const startupInfo = buildStartupInfoExBuffer(
    startupInfoStdio
      ? {
          attributeListPointer,
          useStdHandles: true,
          stdInput: startupInfoStdio.stdInput,
          stdOutput: startupInfoStdio.stdOutput,
          stdError: startupInfoStdio.stdError,
        }
      : { attributeListPointer },
  )
  const flags = (buildCreationFlags(environmentBlock !== null && environmentBlock !== undefined) | CREATE_SUSPENDED | (extraCreationFlags >>> 0)) >>> 0
  if ((flags & EXTENDED_STARTUPINFO_PRESENT) === 0) {
    throw runtimeError('APPCONTAINER_FLAGS_INVALID', 'EXTENDED_STARTUPINFO_PRESENT is missing; the attribute list would be ignored')
  }
  // `[实测-阶段FIX-B]` 见 CREATE_NEW_CONSOLE 的注释：继承句柄 + 无自有控制台 ⇒ 子进程 0xC0000142。
  // 这个组合**必须拒绝**，否则调用方会拿到一个"创建成功但一条命令都不执行"的子进程。
  if (inheritHandles && (flags & (CREATE_NEW_CONSOLE | DETACHED_PROCESS)) === 0) {
    throw runtimeError(
      'APPCONTAINER_HANDLE_INHERITANCE_UNSAFE',
      'inheritHandles=true without CREATE_NEW_CONSOLE or DETACHED_PROCESS makes an AppContainer child die during ' +
        'user-mode initialization with STATUS_DLL_INIT_FAILED (0xC0000142): CreateProcessW still reports success and ' +
        'the token IS an AppContainer token, but the child never runs a single instruction of the command. ' +
        'Pass inheritHandles=false, or add CREATE_NEW_CONSOLE / DETACHED_PROCESS via extraCreationFlags. ' +
        '[实测] raw evidence: .t/sbx3/dev/raw-t0-launch-matrix.txt',
      { win32Code: STATUS_DLL_INIT_FAILED, flags },
    )
  }
  // 反向的同一类错误：给了标准句柄却不继承 ⇒ 子进程的 stdout 会被悄悄接到父控制台，
  // 而调用方以为自己在文件里读输出。两边都是"看起来成功"，所以两边都要拒绝。
  if (startupInfoStdio && !inheritHandles) {
    throw runtimeError(
      'APPCONTAINER_STDIO_WITHOUT_INHERITANCE',
      'startupInfoStdio was supplied but inheritHandles=false: the handles cannot be inherited, so the child would ' +
        'write to the parent console (or to an invalid handle) while the caller reads an empty file. ' +
        'Pass inheritHandles=true together with CREATE_NEW_CONSOLE / DETACHED_PROCESS.',
      { flags },
    )
  }

  const out = { process: null, thread: null, pid: 0 }
  const created = bindings.createProcessW(
    applicationName,
    commandLine,
    null,
    null,
    // `[实测-阶段FIX-B]` 默认 **false**：AppContainer 子进程继承父进程句柄会 0xC0000142（见上）。
    // 需要匿名管道 stdio 时，显式传 inheritHandles=true **并且** extraCreationFlags|=DETACHED_PROCESS。
    inheritHandles,
    flags,
    environmentBlock,
    cwd,
    startupInfo,
    out,
  )
  if (!win32BoolSucceeded(created)) {
    const code = bindings.getLastError()
    throw runtimeError(
      'APPCONTAINER_CREATE_PROCESS_FAILED',
      `CreateProcessW failed with ${code} (flags=0x${flags.toString(16)}, cb=112). ` +
        'Note: console programs (node.exe / powershell.exe) may fail inside an AppContainer ' +
        'for reasons unrelated to this call — see .t/sbx3/dev/00-现状与设计.md §7.2 F1.',
      { win32Code: code },
    )
  }
  if (!out.process || !out.thread) {
    if (out.process) {
      try {
        bindings.terminateProcess?.(out.process, 1)
      } catch {
        /* 已在失败路径上 */
      }
    }
    throw runtimeError('APPCONTAINER_CREATE_PROCESS_FAILED', 'CreateProcessW reported success but returned a null process/thread handle')
  }

  return {
    pid: out.pid,
    process: out.process,
    thread: out.thread,
    attributeList,
    startupInfo,
    securityCapabilities,
    capabilityArray: capabilityArray.buffer,
    capabilityArrayPointer: resolvedCapabilityPointer,
    attributeListPointer,
    // 三轮接线：属性列表实际按几个槽位初始化，以及那份**必须活到列表销毁**的
    // 缓解策略对象（调用方持有它 = 持有 `buffer`；`[官方]` 属性值指针的生命周期要求）。
    attributeCount,
    mitigationPolicy: mitigation,
  }
}

/**
 * `ResumeThread` 包装：**必须**被调用，否则 `CREATE_SUSPENDED` 起来的子进程永远不执行
 * （症状是"超时"而不是"启动失败"，极易误分类为 timeout）。
 */
export function resumeSuspendedProcess(bindings, handle) {
  const result = bindings.resumeThread(handle)
  if ((result >>> 0) === 0xffffffff) {
    const code = bindings.getLastError()
    throw runtimeError('APPCONTAINER_RESUME_FAILED', `ResumeThread failed with ${code}`, { win32Code: code })
  }
  return { previousSuspendCount: result }
}

// ─────────────────── 隔离证据采集 / 判定（阶段 FIX-B 新增）───────────────────
//
// 阶段 B 的教训：**判据选错会把"已经生效的隔离"读成"没生效"**。
// 旧探针用 `TokenUser` 与包 SID 比较，得出"没进 AppContainer" ——
// 但 `[官方]`/`[实测]` AppContainer 令牌的 `TokenUser` **本来就是用户 SID**，
// 包身份在 `TokenAppContainerSid(31)` 与 `TokenIsAppContainer(29)` 里；
// 包 SID 也**不在**令牌组里（`TokenGroups` 里没有 `S-1-15-2-…` 是正常的）。
// 权威判据必须直查令牌（`OpenProcessToken` + `GetTokenInformation`），不能只看 `whoami`。

/** `[官方]` `TOKEN_INFORMATION_CLASS`：本模块用到的取值 */
export const TOKEN_INFORMATION_CLASS = Object.freeze({
  TokenUser: 1,
  TokenGroups: 2,
  TokenType: 8,
  TokenElevation: 20,
  TokenIntegrityLevel: 25,
  TokenIsAppContainer: 29,
  TokenCapabilities: 30,
  TokenAppContainerSid: 31,
})

/** `[实测]` AppContainer 进程的完整性级别：`S-1-16-4096`（Low） */
export const SID_LOW_INTEGRITY = 'S-1-16-4096'

/** `TOKEN_GROUPS` 头：`DWORD GroupCount` + 4 字节对齐填充，条目从偏移 8 开始，每条 16 字节 */
export const SID_AND_ATTRIBUTES_OFFSET = 8
export const TOKEN_GROUPS_HEADER_SIZE = 8

function sidPointerFromBuffer(buffer, offset) {
  const pointer = buffer.readBigUInt64LE(offset)
  return pointer === 0n ? null : pointer
}

/**
 * 采集一个**进程句柄**的令牌事实（`CREATE_SUSPENDED` 状态下也能查，因为令牌在创建时就定了）。
 *
 * fail-closed：`TokenIsAppContainer` 查不出来就抛错 —— 宁可不判，也不把"查不到"当成"没隔离"或"已隔离"。
 *
 * @param {object} bindings 需提供 `openProcessToken` / `getTokenInformation` / `closeHandle`，
 *   以及可选的 `sidToString(sidPointer) -> string|null`
 * @param {unknown} processHandle `PROCESS_INFORMATION.hProcess`
 */
export function readProcessTokenFacts(bindings, processHandle) {
  for (const required of ['openProcessToken', 'getTokenInformation', 'closeHandle']) {
    if (!bindings || typeof bindings[required] !== 'function') {
      throw runtimeError('APPCONTAINER_BINDINGS_MISSING', `bindings.${required} is required to read token facts`)
    }
  }
  const tokenSlot = [null]
  if (!win32BoolSucceeded(bindings.openProcessToken(processHandle, TOKEN_QUERY_ACCESS, tokenSlot))) {
    const code = typeof bindings.getLastError === 'function' ? bindings.getLastError() : null
    throw runtimeError('APPCONTAINER_TOKEN_OPEN_FAILED', `OpenProcessToken(TOKEN_QUERY) failed with ${code}`, { win32Code: code })
  }
  const token = tokenSlot[0]
  const failures = []
  const read = (infoClass, size) => {
    const buffer = Buffer.alloc(size)
    const needed = [0]
    const ok = win32BoolSucceeded(bindings.getTokenInformation(token, infoClass, buffer, buffer.length, needed))
    if (!ok) failures.push({ infoClass, needed: needed[0] })
    return { ok, buffer }
  }
  const sidToString = typeof bindings.sidToString === 'function' ? bindings.sidToString : () => null
  const readSid = (infoClass) => {
    const result = read(infoClass, 256)
    if (!result.ok) return null
    const pointer = sidPointerFromBuffer(result.buffer, 0)
    return pointer === null ? null : sidToString(pointer)
  }
  const readGroups = (infoClass) => {
    const result = read(infoClass, 8192)
    if (!result.ok) return { count: null, sids: [] }
    const count = result.buffer.readUInt32LE(0)
    const sids = []
    for (let index = 0; index < count; index += 1) {
      const base = TOKEN_GROUPS_HEADER_SIZE + index * SID_AND_ATTRIBUTES_SIZE
      if (base + SID_AND_ATTRIBUTES_SIZE > result.buffer.length) break
      const pointer = sidPointerFromBuffer(result.buffer, base)
      if (pointer !== null) sids.push(sidToString(pointer))
    }
    return { count, sids }
  }
  try {
    const isAppContainer = read(TOKEN_INFORMATION_CLASS.TokenIsAppContainer, 4)
    if (!isAppContainer.ok) {
      throw runtimeError(
        'APPCONTAINER_TOKEN_QUERY_FAILED',
        'GetTokenInformation(TokenIsAppContainer=29) failed — refusing to guess whether the child is confined',
        { details: failures },
      )
    }
    const type = read(TOKEN_INFORMATION_CLASS.TokenType, 4)
    const elevation = read(TOKEN_INFORMATION_CLASS.TokenElevation, 4)
    const facts = {
      isAppContainer: isAppContainer.buffer.readUInt32LE(0) === 1,
      appContainerSid: readSid(TOKEN_INFORMATION_CLASS.TokenAppContainerSid),
      tokenUser: readSid(TOKEN_INFORMATION_CLASS.TokenUser),
      integrityLevel: readSid(TOKEN_INFORMATION_CLASS.TokenIntegrityLevel),
      capabilities: readGroups(TOKEN_INFORMATION_CLASS.TokenCapabilities),
      groups: readGroups(TOKEN_INFORMATION_CLASS.TokenGroups),
      tokenType: type.ok ? type.buffer.readUInt32LE(0) : null,
      elevated: elevation.ok ? elevation.buffer.readUInt32LE(0) === 1 : null,
      failedQueries: failures,
      evidence: '[实测] OpenProcessToken + GetTokenInformation 直查子进程令牌',
    }
    return facts
  } finally {
    try {
      bindings.closeHandle(token)
    } catch {
      /* 关闭失败不影响已读到的证据 */
    }
  }
}

/**
 * 把**已实测的原始观测**判定成 `appContainerIsolation` 报告。
 *
 * ── 为什么必须有这个函数（而不是在 executor 里写 `proven = true`）────────────
 * `src/capability.mjs::selectTier()` 的 fail-closed 闸门读的是
 * `report.appContainerIsolation?.proven === true`。如果没有任何地方**真的去测**，
 * 这个字段永远是 `undefined`，T0 就永远不可选 —— 那是安全的，但 T0 也就永远落不了地。
 * 反过来，若为了让 T0"跑起来"而硬写 `proven: true`，就把整个项目最想避免的
 * "看起来隔离了、其实没有"重新引进来。
 * 因此：**`proven` 只能由本函数依据调用方实测出来的原始观测给出**，且**缺任何一项即 false**。
 *
 * 需要的原始观测（缺一即 fail-closed）：
 *   - `tokenFacts`：`readProcessTokenFacts()` 的返回值（令牌层面的身份证据）
 *   - `expectedSid`：本次启动期望的包 SID 字符串
 *   - `outsideWrite`：`{ attempted: true, blocked: true, detail? }` —— 子进程往**未授权路径**写的结果
 *   - `network`：`{ attempted: true, blocked: true, detail? }` —— 子进程发起网络连接的结果
 *
 * @returns {{proven: boolean, checks: Array<{name: string, ok: boolean, detail: string, evidence: string}>, blocking: string[]}}
 */
export function assessAppContainerIsolation(observations = {}) {
  const { tokenFacts = null, expectedSid = null, outsideWrite = null, network = null } = observations
  const checks = []
  const push = (name, ok, detail, evidence) => {
    checks.push({ name, ok: ok === true, detail, evidence })
    return ok === true
  }

  push(
    'token-is-app-container',
    tokenFacts?.isAppContainer === true,
    tokenFacts ? `TokenIsAppContainer=${tokenFacts.isAppContainer}` : 'no token facts were collected',
    tokenFacts?.evidence ?? '[未实测]',
  )
  const actualSid = tokenFacts?.appContainerSid ?? null
  push(
    'package-sid-matches',
    typeof actualSid === 'string' && typeof expectedSid === 'string' && actualSid.toLowerCase() === expectedSid.toLowerCase(),
    `TokenAppContainerSid=${actualSid ?? '(null)'} expected=${expectedSid ?? '(none)'}`,
    tokenFacts?.evidence ?? '[未实测]',
  )
  push(
    'low-integrity',
    tokenFacts?.integrityLevel === SID_LOW_INTEGRITY,
    `TokenIntegrityLevel=${tokenFacts?.integrityLevel ?? '(null)'} expected=${SID_LOW_INTEGRITY}`,
    tokenFacts?.evidence ?? '[未实测]',
  )
  push(
    'outside-write-blocked',
    outsideWrite?.attempted === true && outsideWrite?.blocked === true,
    outsideWrite
      ? `attempted=${outsideWrite.attempted === true} blocked=${outsideWrite.blocked === true} ${outsideWrite.detail ?? ''}`.trim()
      : 'no outside-write measurement was supplied — AppContainer file confinement is NOT proven',
    outsideWrite?.evidence ?? '[未实测]',
  )
  push(
    'network-blocked',
    network?.attempted === true && network?.blocked === true,
    network
      ? `attempted=${network.attempted === true} blocked=${network.blocked === true} ${network.detail ?? ''}`.trim()
      : 'no network measurement was supplied — AppContainer network confinement is NOT proven',
    network?.evidence ?? '[未实测]',
  )

  const proven = checks.every((check) => check.ok)
  return {
    proven,
    checks,
    blocking: checks.filter((check) => !check.ok).map((check) => check.name),
    note:
      'proven=true 只代表"这一次实测观测到了隔离"；它不缓存、不跨配置复用。' +
      '包 SID 是 per-profile 的：换 profile、换能力集、换启动参数都必须重新测。',
  }
}

// ─────────────────────────── 组合顺序（纯决策）───────────────────────────

/**
 * 决定 T0 启动的"组合顺序"，并把**理由**一起返回（便于报告引用，而不是只给一个数组）。
 *
 * `[官方]` "AppContainers run with a Low Integrity Level" —— 所以 T0 **不需要**再额外
 * `SetTokenInformation(TokenIntegrityLevel)`：
 *   ① 那需要 `TOKEN_ADJUST_DEFAULT`（本机 `[实测]` 缺失，见 `docs/Windows功能开启清单.md` §2.2）；
 *   ② 叠加两层 no-write-up 会让访问检查难以推理（失败模式变得不可归因）。
 *
 * @param {{jobAvailable: boolean, lowIntegrityAlreadyPresent?: boolean}} facts
 */
export function planCombinationOrder(facts = {}) {
  const { jobAvailable = false } = facts
  const steps = [
    { step: 'derive-or-create-profile', required: true, reason: '包 SID 是 AppContainer 身份的唯一来源' },
    { step: 'build-security-capabilities', required: true, reason: 'SECURITY_CAPABILITIES 必须由调用方持有生命周期' },
    { step: 'initialize-attribute-list', required: true, reason: '官方两阶段协商；首次调用按设计返回 ERROR_INSUFFICIENT_BUFFER' },
    { step: 'update-proc-thread-attribute', required: true, reason: 'PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES 决定子进程身份' },
    { step: 'create-process-suspended', required: true, reason: 'CREATE_SUSPENDED 是消除"挂 Job 前竞态"(R9) 的唯一手段' },
  ]
  if (jobAvailable) {
    steps.push({ step: 'assign-to-job', required: true, reason: '进程树回收与资源上限；官方无替代手段' })
    steps.push({ step: 'resume-thread', required: true, reason: 'CREATE_SUSPENDED 后不 resume 子进程永不执行（症状=超时）' })
  } else {
    steps.push({ step: 'no-job', required: true, reason: '无 Job 时进程树回收不可保证 —— 必须在报告里声明为残余边界' })
  }
  steps.push({
    step: 'skip-explicit-low-integrity',
    required: false,
    reason: 'AppContainer 自带 Low IL；额外 SetTokenInformation 需要 TOKEN_ADJUST_DEFAULT（本机缺失）且叠加两层 no-write-up',
  })
  const residuals = []
  if (!jobAvailable) residuals.push('process-tree reclamation (KILL_ON_JOB_CLOSE) is NOT enforced without a Job Object')
  residuals.push(
    'filesystem access inside the AppContainer is granted by the package SID DACL: the staged root must be explicitly ' +
      'granted to the AppContainer SID, otherwise even the staged root becomes unwritable',
  )
  return { steps, residuals }
}

// ─────────────────────────── 运行期门面 ───────────────────────────

/**
 * `AppContainerRuntime`：把 profile / 能力 / 属性列表 / 组合顺序收束成一个对象，
 * 并保证**构造失败即抛错**、**dispose 逆序且逐项失败聚合**。
 *
 * 这个类的存在理由与 `WindowsStageExecutor` 一样：把"多步原生调用 + 资源回收"
 * 关进一个 fail-closed 的门面里，避免调用方漏掉某一步（尤其是 `ResumeThread`
 * 与 `DeleteProcThreadAttributeList` 这两个"忘了也不报错"的步骤）。
 */
export class AppContainerRuntime {
  /**
   * @param {object} bindings 见 `spawnSuspendedAppContainer` 的说明，另需
   *   `deriveAppContainerSidFromAppContainerName` / `createAppContainerProfile` /
   *   `deleteAppContainerProfile` / `deriveCapabilitySidsFromName` /
   *   `deleteProcThreadAttributeList`（可选但强烈建议）
   * @param {{profileName: string, capabilities?: Array<{name: string, sid?: unknown}>, jobAvailable?: boolean, retainPointer?: Function}} options
   */
  constructor(bindings, options = {}) {
    if (!bindings || typeof bindings !== 'object') throw new TypeError('AppContainerRuntime requires a bindings object')
    this.bindings = bindings
    this.options = options
    this.profileName = options.profileName
    if (typeof this.profileName !== 'string' || this.profileName.length === 0) {
      throw runtimeError('APPCONTAINER_PROFILE_NAME_INVALID', 'options.profileName must be a non-empty string')
    }
    /** 本次实例**自己创建**的 profile 才允许删除（不要删别人的） */
    this.createdHere = false
    this.sid = null
    this.sidString = null
    this.capabilities = []
    /**
     * 由本实例**自己派生**出来的能力 SID（`DeriveCapabilitySidsFromName` 的产物）。
     * `[官方]` 这些 SID 的所有权在调用方，必须 `LocalFree`；调用方显式传入的 SID 不归我们管。
     * 阶段 FIX-B 新增：旧实现既没记录也没释放，"派生一次泄漏一个"（而且释放错的那个是悬垂指针）。
     */
    this.derivedCapabilitySids = []
    this.attributeList = null
    this.disposed = false
    this.retainPointer = typeof options.retainPointer === 'function' ? options.retainPointer : () => {}
    /**
     * 三轮接线：实例级进程缓解策略（`null` = 不注入，行为与接线前逐字一致）。
     *
     * 归一化放在构造期：坏档位名/坏 flags 在这里就抛（fail-closed），而不是等到
     * `spawn()` 改了一半状态才发现策略构造不出来。`spawn()` 仍允许按次覆盖。
     */
    this.mitigationPolicy = resolveMitigationPolicy(options.mitigationPolicy ?? null)
    // 内嵌指针的来源：options.pin 优先，其次 bindings.pin（createKoffiAppContainerBindings 已内置 koffi.address）。
    // 两者都没有时**不报错**——只在"真的声明了能力 SID"时才会需要它（见 spawnSuspendedAppContainer）。
    this.pin = typeof options.pin === 'function' ? options.pin : typeof bindings.pin === 'function' ? bindings.pin : null
  }

  /**
   * 解析/创建 profile 与能力 SID。
   *
   * 顺序（`[官方]` `[Launch an AppContainer]` 的 `CreateProfileForAppContainer` 样例）：
   *   1. 先 `CreateAppContainerProfile`；
   *   2. 若 `hr === HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)`（0x800700B7），
   *      再 `DeriveAppContainerSidFromAppContainerName`；
   *   3. 若第 1 步是**其它**失败码，直接抛 —— **不**"顺手派生一个试试"。
   *
   * 为什么第 3 条重要：阶段 A `[实测]` 受限令牌下 `CreateAppContainerProfile` 返回
   * `E_ACCESSDENIED(0x80070005)`，而 `DeriveAppContainerSidFromAppContainerName`
   * **返回 hr=0 且给出一个 SID**（阶段 B 复测同样如此：profile 不存在也能派生）。
   * 如果按"失败就派生"的逻辑写，就会拿到一个**指向不存在 profile 的 SID**，
   * 然后 `CreateProcess` 失败在别处 —— 故障点被推远，根因报告会变成"说不清哪里坏了"。
   * 因此本实现把"派生"严格限制在 `ALREADY_EXISTS` 这一种情况。
   *
   * ── 阶段 B 实测缺陷：本方法**不能**是 `async` ──────────────────────────────────
   * 初版写成 `async init()`，但方法体内**一个 `await` 都没有**（全部是同步 Win32 调用）。
   * 后果不是"多一层包装"，而是**把 fail-closed 路径整体变成不可观测**：
   *   - `init()` 返回 Promise 而不是报告对象 ⇒ 同步调用方拿到 `undefined`；
   *   - 更严重的是**抛错变成 rejected promise** ⇒ `try { runtime.init() } catch (e)` 捕获不到，
   *     所有"打不开 profile 就必须抛"的断言全部退化为"没抛错"，
   *     而 rejection 若无人 `await` 还会变成 unhandledRejection（在 Node 里默认是致命错误）。
   * 这正是本模块开头警告的那一类"看起来正常、实际边界没生效"的失效，故**去掉 `async`**，
   * 与同类中的 `spawn()` / `resume()` / `dispose()` 保持一致（它们本来就是同步的）。
   */
  init() {
    const b = this.bindings
    if (typeof b.createAppContainerProfile !== 'function' && typeof b.deriveAppContainerSidFromAppContainerName !== 'function') {
      throw runtimeError(
        'APPCONTAINER_BINDINGS_MISSING',
        'bindings must provide createAppContainerProfile and/or deriveAppContainerSidFromAppContainerName',
      )
    }

    // 1) profile / 包 SID
    if (typeof b.createAppContainerProfile === 'function') {
      const hr = b.createAppContainerProfile(this.profileName, this.profileName, 'WinStageSandbox AppContainer', null, 0)
      const status = hrStatus(hr)
      if (status === 0) {
        this.createdHere = true
        this.sid = extractSid(hr)
      } else if (status === HR_ALREADY_EXISTS) {
        this.createdHere = false
      } else {
        throw runtimeError(
          'APPCONTAINER_PROFILE_CREATE_FAILED',
          `CreateAppContainerProfile(${this.profileName}) failed hr=0x${status.toString(16)}${status === 0x80070005 ? ' (E_ACCESSDENIED)' : ''}. ` +
            'Refusing to fall back to DeriveAppContainerSidFromAppContainerName: deriving a SID for a profile that does not ' +
            'exist yields a SID that no access check will ever match (the failure would move somewhere else).',
          { hr: status },
        )
      }
    }
    if (this.sid === null) {
      if (typeof b.deriveAppContainerSidFromAppContainerName !== 'function') {
        throw runtimeError('APPCONTAINER_BINDINGS_MISSING', 'profile already existed but deriveAppContainerSidFromAppContainerName is not bound')
      }
      const derived = b.deriveAppContainerSidFromAppContainerName(this.profileName)
      const status = hrStatus(derived)
      if (status !== 0) {
        throw runtimeError('APPCONTAINER_SID_DERIVE_FAILED', `DeriveAppContainerSidFromAppContainerName failed hr=0x${status.toString(16)}`, {
          hr: status,
        })
      }
      this.sid = extractSid(derived)
    }
    if (this.sid === null || this.sid === undefined) {
      throw runtimeError('APPCONTAINER_SID_MISSING', 'no package SID was produced by create/derive')
    }

    // 2) 能力 SID（默认空 ⇒ 网络默认阻断）
    const requested = this.options.capabilities ?? DEFAULT_CAPABILITIES
    if (!Array.isArray(requested)) throw new TypeError('options.capabilities must be an array')
    if (requested.length > 0 && typeof b.deriveCapabilitySidsFromName !== 'function') {
      throw runtimeError(
        'APPCONTAINER_BINDINGS_MISSING',
        'capabilities were requested but bindings.deriveCapabilitySidsFromName is not bound',
      )
    }
    this.capabilities = []
    for (const capability of requested) {
      const name = typeof capability === 'string' ? capability : capability?.name
      if (typeof name !== 'string' || name.length === 0) {
        throw runtimeError('APPCONTAINER_CAPABILITY_INVALID', `capability entry must be a name string or {name}, got ${JSON.stringify(capability)}`)
      }
      const givenSid = capability?.sid ?? null
      const sid = givenSid ?? deriveOneCapabilitySid(b, name)
      if (sid === null || sid === undefined) {
        throw runtimeError('APPCONTAINER_CAPABILITY_INVALID', `DeriveCapabilitySidsFromName(${name}) produced no capability SID`)
      }
      const derivedHere = givenSid === null || givenSid === undefined
      if (derivedHere) this.derivedCapabilitySids.push(sid)
      this.capabilities.push({ name, sid, attributes: SE_GROUP_ENABLED, derivedHere })
    }

    // 3) 属性列表（提前建好，便于 dispose 逆序释放）
    // ⚠ 容量必须与 `spawnSuspendedAppContainer()` 里那次真正的分配**同一判据**
    //   （`attributeListCountFor`）：这里算 1、那里算 2 就会让上报的
    //   `attributeListSize` 与真实启动用的容量不一致（那是"报告与执行漂移"）。
    this.attributeList = allocateAttributeList(b, attributeListCountFor(this.mitigationPolicy)).buffer
    this.order = planCombinationOrder({ jobAvailable: this.options.jobAvailable === true })
    return {
      profileName: this.profileName,
      createdHere: this.createdHere,
      sid: this.sid,
      capabilities: this.capabilities.map((c) => c.name),
      attributeListSize: this.attributeList.length,
      order: this.order,
      // 三轮接线：报告里如实给出"策略档位 + 16 个十六进制标志位 + 是否 no-op"，
      // 免得只写一句"已启用缓解策略"（`mitigations.mjs` 的摘要口径）。
      mitigation: this.mitigationPolicy === null ? null : { profile: this.mitigationPolicy.profile, flags: this.mitigationPolicy.hex, names: [...this.mitigationPolicy.names] },
      attributeCount: attributeListCountFor(this.mitigationPolicy),
    }
  }

  /** 启动一个挂起的 AppContainer 进程（调用方必须随后挂 Job 并 `resume()`） */
  spawn(options = {}) {
    if (this.disposed) throw runtimeError('APPCONTAINER_DISPOSED', 'runtime already disposed')
    if (!this.attributeList) throw runtimeError('APPCONTAINER_NOT_INITIALIZED', 'call init() before spawn()')
    const child = spawnSuspendedAppContainer(this.bindings, {
      pin: this.pin,
      // 实例级策略（`null` ⇒ spawnSuspendedAppContainer 完全不碰该属性）。
      // 刻意放在 `...options` **之前**：单次启动可以覆盖它，但默认继承实例配置。
      mitigationPolicy: this.mitigationPolicy,
      ...options,
      appContainerSid: this.sid,
      capabilities: this.capabilities,
    })
    this.retainPointer('appcontainer', child.attributeList)
    this.retainPointer('appcontainer', child.securityCapabilities)
    this.retainPointer('appcontainer', child.capabilityArray)
    // 策略 buffer 也必须活到属性列表销毁（`[官方]` 属性值指针的生命周期要求）：
    // 调用方拿到 child 就等于拿到了这份引用，这里把它一并登记进 retainPointer 容器。
    if (child.mitigationPolicy) this.retainPointer('appcontainer', child.mitigationPolicy.buffer)
    return child
  }

  /** 恢复挂起的子进程（必须调用；见 `planCombinationOrder`） */
  resume(child) {
    return resumeSuspendedProcess(this.bindings, child.thread)
  }

  /**
   * 逆序释放：属性列表 → 能力 SID 数组 → profile。
   *
   * **只删自己创建的 profile**（`createdHere`）。删别人的 profile 会破坏同机其它 AppContainer
   * 应用的 `LOCALAPPDATA` 重定向目录，是典型的"清理越权"。
   */
  dispose() {
    this.disposed = true
    const failures = []
    if (this.attributeList && typeof this.bindings.deleteProcThreadAttributeList === 'function') {
      try {
        const rc = this.bindings.deleteProcThreadAttributeList(this.attributeList)
        if (rc === 0 && typeof this.bindings.getLastError === 'function') {
          failures.push(`DeleteProcThreadAttributeList reported failure (GetLastError=${this.bindings.getLastError()})`)
        }
      } catch (error) {
        failures.push(`DeleteProcThreadAttributeList threw: ${error.message}`)
      }
    }
    if (this.createdHere && typeof this.bindings.deleteAppContainerProfile === 'function') {
      try {
        const hr = this.bindings.deleteAppContainerProfile(this.profileName)
        const status = hrStatus(hr)
        if (status !== 0) failures.push(`DeleteAppContainerProfile(${this.profileName}) failed hr=0x${status.toString(16)}`)
      } catch (error) {
        failures.push(`DeleteAppContainerProfile threw: ${error.message}`)
      }
    }
    // 释放本实例自己派生出来的能力 SID（`[官方]`：调用方负责 LocalFree）。
    // 调用方显式传入的 SID **不**在这里释放 —— 所有权不是我们的。
    for (const sid of this.derivedCapabilitySids) {
      if (typeof this.bindings.localFree !== 'function') {
        failures.push('derived capability SIDs were not freed: bindings.localFree is not available')
        break
      }
      try {
        if (this.bindings.localFree(sid) !== true) failures.push(`LocalFree(derived capability SID) reported failure`)
      } catch (error) {
        failures.push(`LocalFree(derived capability SID) threw: ${error.message}`)
      }
    }
    this.derivedCapabilitySids = []
    this.capabilities = []
    this.attributeList = null
    return { disposed: true, failures, deletedProfile: this.createdHere }
  }
}

function hrStatus(value) {
  if (typeof value === 'number') return value >>> 0
  if (value !== null && typeof value === 'object' && typeof value.hr === 'number') return value.hr >>> 0
  if (value !== null && typeof value === 'object' && typeof value.status === 'number') return value.status >>> 0
  return 0
}

function extractSid(value) {
  if (value === null || value === undefined) return null
  if (typeof value === 'object') {
    if ('sid' in value) return value.sid
    if ('value' in value) return value.value
    return value
  }
  return value
}

/** 从 `DeriveCapabilitySidsFromName` 的两种常见返回形状里取出"capability SID 数组的第一个" */
function deriveOneCapabilitySid(bindings, name) {
  const out = bindings.deriveCapabilitySidsFromName(name)
  if (!out) return null
  const capabilitySids = out.capabilitySids ?? out.capabilitySid ?? out.capability
  if (Array.isArray(capabilitySids)) return capabilitySids[0] ?? null
  return capabilitySids ?? null
}

/**
 * 用真实 Koffi 形状的绑定构造一个 `bindings` 对象（**运行期**用；离线测试用替身）。
 *
 * `[实测-阶段B]`：本函数**已经在阶段 B 成功执行到底过** ——
 * `createKoffiAppContainerBindings()` 被真实 koffi 3.3.2 调用，完成 profile 创建、能力 SID 解析、
 * 属性列表协商、`CreateProcess` 启动与 `dispose` 删除 profile（原始输出
 * `.t/sbx3/dev/raw-probe-appcontainer-runtime.txt`）。
 * **但阶段 B 也在这里抓到一个致命缺陷**：初版返回对象里写的是裸标识符
 * `initializeProcThreadAttributeList`（小写 i），而局部变量叫 `InitializeProcThreadAttributeList`
 * ⇒ 整个工厂函数在返回对象求值时就抛 `ReferenceError`，即**从未成功执行过一次**。
 * 换句话说阶段 A 的"运行期零实测"不是"测了没过"，而是"入口本身就是死的"。
 * 因此它只是"调用形状的集中处"，不是"已验证的实现"。
 *
 * @param {object} koffi 已加载的 koffi 模块
 * @param {{userenv?: object, kernel32?: object, kernelBase?: object}} [libs]
 */
export function createKoffiAppContainerBindings(koffi, libs = {}) {
  if (!koffi || typeof koffi.load !== 'function') throw new TypeError('createKoffiAppContainerBindings requires the koffi module')
  const userenv = libs.userenv ?? koffi.load('userenv.dll')
  const kernel32 = libs.kernel32 ?? koffi.load('kernel32.dll')
  const advapi32 = libs.advapi32 ?? koffi.load('advapi32.dll')
  // [官方] DeriveCapabilitySidsFromName 的 DLL 是 KernelBase.dll（不是 advapi32）。
  // 本机实测 DeriveCapabilitySidsFromName **未**被调用过（缺 koffi 之外的原因），标 [未实测]。
  const kernelBase = libs.kernelBase ?? koffi.load('kernelbase.dll')

  const CreateAppContainerProfile = userenv.func(
    'long CreateAppContainerProfile(const char16_t *name, const char16_t *displayName, const char16_t *description, void *capabilities, uint32 capabilityCount, _Out_ void **sid)',
  )
  const DeriveAppContainerSidFromAppContainerName = userenv.func(
    'long DeriveAppContainerSidFromAppContainerName(const char16_t *name, _Out_ void **sid)',
  )
  const DeleteAppContainerProfile = userenv.func('long DeleteAppContainerProfile(const char16_t *name)')
  const DeriveCapabilitySidsFromName = kernelBase.func(
    'bool DeriveCapabilitySidsFromName(const char16_t *capName, _Out_ void **groupSids, _Out_ uint32 *groupSidCount, _Out_ void **capabilitySids, _Out_ uint32 *capabilitySidCount)',
  )
  const LocalFree = kernel32.func('void *LocalFree(void *h)')
  const InitializeProcThreadAttributeList = kernel32.func(
    'bool InitializeProcThreadAttributeList(void *list, uint32 count, uint32 flags, _Inout_ size_t *size)',
  )
  const UpdateProcThreadAttribute = kernel32.func(
    'bool UpdateProcThreadAttribute(void *list, uint32 flags, size_t attribute, void *value, size_t size, void *prev, void *returnSize)',
  )
  const DeleteProcThreadAttributeList = kernel32.func('void DeleteProcThreadAttributeList(void *list)')
  const GetLastError = kernel32.func('uint32 GetLastError()')
  const ResumeThread = kernel32.func('uint32 ResumeThread(void *thread)')
  const TerminateProcess = kernel32.func('bool TerminateProcess(void *process, uint32 code)')
  const CloseHandleRaw = kernel32.func('bool CloseHandle(void *handle)')
  const ConvertSidToStringSidW = advapi32.func('bool ConvertSidToStringSidW(void *sid, _Out_ void **str)')
  // 阶段 FIX-B：`readProcessTokenFacts()` 需要这三个入口才能直查子进程令牌
  // （旧绑定表**没有**任何查令牌的能力，这正是"判据只能看 whoami"的根因）。
  const OpenProcessToken = advapi32.func('bool OpenProcessToken(void *process, uint32 access, _Out_ void **token)')
  const GetTokenInformation = advapi32.func('bool GetTokenInformation(void *token, int infoClass, _Out_ uint8 *info, uint32 len, _Out_ uint32 *needed)')
  // 阶段 B 实测缺陷：初版把 `PROCESS_INFORMATION *pi` 声明成 `void *pi`，
  // 而模块契约（以及离线替身）要求传一个**可写 JS 对象**。koffi 对"对象 → void *"的编组会抛
  //   `Unexpected Object value, expected void *`
  // （`[实测]` 见 .t/sbx3/dev/raw-probe-koffi-pointer.txt 第 7 节，用 GetSystemInfo 复现了同一条报错）。
  // 因此这里把 `pi` 声明成 `_Out_ uint8 *`（一个 Buffer），由下面的包装函数把字段填回对象。
  // `[实测]` 同一份探针第 1/3/4 节确认：`GetCurrentProcess()` 在 koffi 里就是 **bigint**，
  // 且 bigint 可以同时用作 `void *` 与 `uint64` 形参 ⇒ 句柄在模块内一律用 bigint 传递是安全的。
  const CreateProcessWRaw = kernel32.func(
    'bool CreateProcessW(const char16_t *app, const char16_t *cmd, void *pa, void *ta, bool inherit, uint32 flags, void *env, const char16_t *cwd, void *si, _Out_ uint8 *pi)',
  )

  // ── 阶段 FIX-B 实测缺陷：`DeriveCapabilitySidsFromName` 的 `PSID **` 被当成 PSID 用 ──────
  // `[官方]` 签名是 `BOOL DeriveCapabilitySidsFromName(LPCWSTR, PSID **GroupSids, DWORD *,
  // PSID **CapabilitySids, DWORD *)` —— 出参是**指向"指针数组"的指针**。
  // 旧实现把出参本身当 SID：`ConvertSidToStringSidW(出参)` 返回
  // FALSE + `GetLastError()=1337 (ERROR_INVALID_SID)`；更糟的是它随后把**要交还调用方的那个 SID**
  // 也 `LocalFree` 掉了，调用方拿到的是**悬垂指针**，实测后果是本进程整进程死于
  // `STATUS_HEAP_CORRUPTION (0xC0000374)`（原始证据：`.t/sbx3/dev/raw-probe-capability-derive.txt`）。
  //
  // 修法：出参一律**解引用**成"指针数组"，逐项才是 SID；释放时**只释放不交还的那些**。
  const readSidPointerArray = (arrayAddress, count) => {
    if (arrayAddress === null || arrayAddress === undefined || !Number.isFinite(count) || count <= 0) return []
    const address = typeof arrayAddress === 'bigint' ? arrayAddress : BigInt(arrayAddress)
    // `[实测]` koffi.decode(地址,'uint64',n) 返回的是 koffi 自己的数组对象（不是 JS Array）：
    // 只保证 `length` 与下标访问；`Array.isArray()` 为 false，`JSON.stringify` 会因 BigInt 抛错。
    const decoded = koffi.decode(address, 'uint64', count)
    const out = []
    for (let index = 0; index < count; index += 1) out.push(decoded[index])
    return out
  }
  const freeNative = (pointer) => {
    if (pointer === null || pointer === undefined) return false
    try {
      LocalFree(pointer)
      return true
    } catch {
      return false
    }
  }

  return {
    createAppContainerProfile(name, displayName, description) {
      const slot = [null]
      const hr = CreateAppContainerProfile(name, displayName, description, null, 0, slot)
      return { hr: hr >>> 0, sid: slot[0] }
    },
    deriveAppContainerSidFromAppContainerName(name) {
      const slot = [null]
      const hr = DeriveAppContainerSidFromAppContainerName(name, slot)
      return { hr: hr >>> 0, sid: slot[0] }
    },
    deleteAppContainerProfile(name) {
      return DeleteAppContainerProfile(name) >>> 0
    },
    deriveCapabilitySidsFromName(name) {
      const groupSidsSlot = [null] // PSID ** 出参：**指针数组的地址**
      const groupCountSlot = [0]
      const capabilitySidsSlot = [null] // PSID ** 出参
      const capabilityCountSlot = [0]
      const ok = DeriveCapabilitySidsFromName(name, groupSidsSlot, groupCountSlot, capabilitySidsSlot, capabilityCountSlot)
      if (!win32BoolSucceeded(ok)) return null
      const groupSidCount = Number(groupCountSlot[0] ?? 0)
      const capabilitySidCount = Number(capabilityCountSlot[0] ?? 0)
      const groupSids = readSidPointerArray(groupSidsSlot[0], groupSidCount)
      const capabilitySids = readSidPointerArray(capabilitySidsSlot[0], capabilitySidCount)
      const first = capabilitySids[0] ?? null
      // `[官方]` Remarks：调用方必须对**每个 SID** 与**两个数组本身**调用 LocalFree。
      // ⚠ 但**不能**释放要交还给调用方的 `capabilitySids[0]`（旧实现正是在这里制造了悬垂指针）。
      // 交还的那个 SID 由调用方持有；`AppContainerRuntime` 在 `dispose()` 里用
      // `bindings.localFree` 释放它（见 dispose）。
      for (let index = 1; index < capabilitySids.length; index += 1) freeNative(capabilitySids[index])
      for (const sid of groupSids) freeNative(sid)
      freeNative(capabilitySidsSlot[0])
      freeNative(groupSidsSlot[0])
      return { capabilitySids: first === null ? [] : [first], capabilitySidCount, groupSids: groupSids[0] ?? null, groupSidCount }
    },
    // 阶段 B 实测缺陷：初版这里写的是裸标识符 `initializeProcThreadAttributeList`（小写 i），
    // 而真正的局部变量叫 `InitializeProcThreadAttributeList`（大写 I，对齐 Win32 名字）。
    // 于是**整个工厂函数**在返回对象字面量求值时就抛
    // `ReferenceError: initializeProcThreadAttributeList is not defined` ——
    // 也就是说 `createKoffiAppContainerBindings` 从来成功执行过一次都没有，
    // 这正是"T0 运行期零实测"的具体形态：不是"测了没过"，而是"入口本身就是死的"。
    // （`updateProcThreadAttribute` 那一行反而是对的，所以只看名字很难发现。）
    initializeProcThreadAttributeList: InitializeProcThreadAttributeList,
    updateProcThreadAttribute: UpdateProcThreadAttribute,
    deleteProcThreadAttributeList: DeleteProcThreadAttributeList,
    /**
     * 把 koffi 的 `_Out_ uint8 *` 形态适配回模块契约的"可写对象"形态。
     * 返回 `1`/`0`（与替身一致的整数），但模块侧**不**用 `=== 0` 判定 ——
     * 统一走 `win32BoolSucceeded()`，因为真实 koffi 对 `bool` 返回的是 JS boolean。
     */
    createProcessW(app, cmd, pa, ta, inherit, flags, env, cwd, si, out) {
      const pi = Buffer.alloc(PROCESS_INFORMATION_SIZE)
      const ok = CreateProcessWRaw(app, cmd, pa, ta, inherit, flags, env, cwd, si, pi)
      if (ok && out) {
        out.process = pi.readBigUInt64LE(OFF_PROCESS_INFORMATION.hProcess)
        out.thread = pi.readBigUInt64LE(OFF_PROCESS_INFORMATION.hThread)
        out.pid = pi.readUInt32LE(OFF_PROCESS_INFORMATION.dwProcessId)
      }
      return ok ? 1 : 0
    },
    resumeThread: ResumeThread,
    terminateProcess: TerminateProcess,
    /**
     * 关闭句柄。阶段 B 补上：`spawnSuspendedAppContainer` 会把 `PROCESS_INFORMATION` 的
     * 两个句柄交还给调用方，而**原来的绑定表没有关闭它们的入口** —— 泄漏是必然的，
     * 而且"忘了关"在进程退出前不会报任何错（与 `ResumeThread` 同一类静默缺陷）。
     */
    closeHandle: (handle) => CloseHandleRaw(handle) === true,
    getLastError: GetLastError,
    /** 供 `readProcessTokenFacts()` 直查子进程令牌（阶段 FIX-B 新增） */
    openProcessToken: OpenProcessToken,
    getTokenInformation: GetTokenInformation,
    /**
     * `[官方]` `LocalFree`：释放 `DeriveCapabilitySidsFromName` 交还的能力 SID。
     * 阶段 FIX-B 补上 —— 正确的所有权模型是"调用方持有派生出的能力 SID，用完后释放"，
     * 而旧实现在绑定层内部就把它释放了（悬垂指针）。
     */
    localFree: (pointer) => {
      try {
        LocalFree(pointer)
        return true
      } catch {
        return false
      }
    },
    /** SID 指针 → `S-1-…` 字符串（失败返回 null，绝不返回半成品字符串） */
    sidToString: (sid) => {
      if (sid === null || sid === undefined) return null
      const slot = [null]
      if (!win32BoolSucceeded(ConvertSidToStringSidW(sid, slot))) return null
      let text = null
      try {
        text = koffi.decode(slot[0], 'char16_t', -1)
      } catch {
        text = null
      }
      freeNative(slot[0])
      return typeof text === 'string' ? text.replace(/\u0000+$/, '') : null
    },
    // `[实测]` koffi 3.3.2 的导出里含 `address`，且 `koffi.address(buffer)` 返回 bigint
    // （见 .t/sbx3/dev/raw-probe-koffi.txt）。显式包一层：koffi 若换掉这个 API，这里会**在构造期**
    // 就变成 undefined，而不是等到启动 AppContainer 时抛一个"指针类型不对"的间接错误。
    pin: typeof koffi.address === 'function' ? (buffer) => koffi.address(buffer) : undefined,
    // 供上层核对；advapi32 目前未被使用（保留以便将来需要 ConvertSidToStringSidW）
    __libs: { userenv, kernel32, advapi32, kernelBase },
  }
}

export const __internal = { writePointerLe, hrStatus, extractSid }
