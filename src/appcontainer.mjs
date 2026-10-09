/**
 * AppContainer 执行路径（Windows 原生读取面 & 网络面收敛）
 *
 * ── 现状声明（务必先读）────────────────────────────────────────────────────────
 * 本模块提供 AppContainer 的**结构与调用构造**，并配有无需 Win32 的确定性布局测试。
 *
 * `[实测-阶段B]` 未受限宿主（High IL 管理员令牌，`admin=YES`）下：
 * `CreateAppContainerProfile` **返回 `hr=0x0`**，包 SID 形如 `S-1-15-2-…`，用完即删成功
 * （阶段 A 的 `0x80070005 (E_ACCESSDENIED)` 只出现在**受限令牌**会话里）。
 *
 * `[实测-FIX-B]` **T0 的隔离是真的能生效的**，权威证据（`.t/sbx3/dev/raw-t0-forensics.txt`、
 * `raw-t0-behaviour.txt`）：`CREATE_SUSPENDED` 状态下直查子进程令牌
 * `TokenIsAppContainer(29) = 1`、`TokenAppContainerSid = 期望包 SID`、
 * `TokenIntegrityLevel = S-1-16-4096`（Low）；行为面：子进程真在跑（`exit /b 42` → 42）、
 * 区外写被拒、未声明 `internetClient` 时网络被阻断（`curl` → 7），声明后立即连通。
 *
 * ⚠ 两个**必须**遵守的前置（否则隔离会静默失效或子进程根本不跑）：
 *   1. `SECURITY_CAPABILITIES` 的 `cbSize` 必须是 **24**（见 `SECURITY_CAPABILITIES_SIZE`）；
 *   2. AppContainer 子进程**不能**在没有自有控制台的情况下继承父进程句柄 ——
 *      否则子进程会以 `0xC0000142 (STATUS_DLL_INIT_FAILED)` 静默死亡，见
 *      `src/appcontainer-runtime.mjs` 的 `CREATE_NEW_CONSOLE` 注释。
 *
 * 工程处理：
 *   1. `isAvailable()` 真实探测；拿不到 AppContainer 就**拒绝**，绝不静默退回继承环境；
 *   2. `createAppContainerToken()` 任一步失败即抛错并回收已分配资源（fail-closed）；
 *   3. 结构体布局（`STARTUPINFOEX` / `PROC_THREAD_ATTRIBUTE_LIST`）由
 *      `tests/appcontainer-layout.mjs` 用合成缓冲区确定性校验 —— 这正是
 *      Job 结构体（缺陷 5）与 `CREATE_UNICODE_ENVIRONMENT`（缺陷 13）两次踩坑后总结出的做法：
 *      **先把布局测对，再谈运行**。
 *   4. **"隔离已生效"只能由实测证据判定**：`src/appcontainer-runtime.mjs` 的
 *      `readProcessTokenFacts()` + `assessAppContainerIsolation()` 是唯一入口，
 *      `selectTier()` 至今仍要求 `report.appContainerIsolation.proven === true`。
 *      本模块**不**提供任何硬编码 `true` 的捷径。
 *
 * ── 为什么 AppContainer 值得做（对应手册条款）────────────────────────────────
 *   残余边界 R1：WRITE_RESTRICTED 只交叉写类访问、Low IL 只做 no-write-up，
 *                **两者都不限制读取** → 读取面不收敛。
 *   残余边界 R2：受限令牌与 ACL 均不涉及网络。
 *   `[官方]` AppContainer 同时隔离凭据/设备/文件/网络/进程/窗口，
 *   是 Windows 上**不需要开启可选功能**就能收敛读取面与网络面的唯一原语。
 *   其文件默认拒绝、网络默认阻断（需显式声明 `internetClient` 等能力）。
 *
 * ── 与 T1（受限令牌）的关系 ──────────────────────────────────────────────────
 *   两者不可叠加使用同一个子进程：AppContainer 用**包 SID** 做访问检查，
 *   而 WRITE_RESTRICTED 用**受限 SID 交集**。混用会让访问检查互相削弱、难以推理。
 *   因此本模块是 **T0 档位的独立执行路径**，不是 T1 的增强。
 */

import { existsSync } from 'node:fs'

// ─────────────────────────── 结构体布局（确定性可测）───────────────────────────

/**
 * `STARTUPINFOEXW` 布局。
 *
 * `[官方]` 定义：
 *   STARTUPINFOW StartupInfo;   // 104 字节（cb=104）
 *   PPROC_THREAD_ATTRIBUTE_LIST lpAttributeList;
 * 64 位下指针 8 字节 → 总 112 字节。
 *
 * 注意 `cb` 必须填 `sizeof(STARTUPINFOEXW)`（112），**不是** 104 ——
 * 填错会让 `CreateProcess` 静默忽略属性列表，于是"以为进了 AppContainer 其实没有"，
 * 属于最危险的一类错误（看起来成功、实则无隔离）。
 */
export const STARTUPINFOEX_SIZE = 112
export const STARTUPINFO_SIZE = 104
export const OFF_STARTUP_INFO = 0
export const OFF_ATTRIBUTE_LIST = 104

/** `EXTENDED_STARTUPINFO_PRESENT`：创建进程时必须置位，否则 lpAttributeList 被忽略 */
export const EXTENDED_STARTUPINFO_PRESENT = 0x00080000

/** `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 的属性号
 *
 * ── 依据（不凭记忆，三处独立来源 + 一次实测）───────────────────────────────────
 * 1. `[文档]` winnt.h 的宏：`PROC_THREAD_ATTRIBUTE_x = ProcThreadAttributeValue(Number, Thread, Input, Additive)`
 *    `= Number | (Thread?0x10000:0) | (Input?0x20000:0) | (Additive?0x40000:0)`（Number 掩码 `0xFFFF`）。
 *    真实的头文件镜像（Mozilla `security/sandbox/chromium-shim/base/win/sdkdecls.h`）里写着：
 *      `#define ProcThreadAttributeSecurityCapabilities 9`
 *      `#define PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES \`
 *          `ProcThreadAttributeValue (ProcThreadAttributeSecurityCapabilities, FALSE, TRUE, FALSE)`
 *    ⇒ `9 | 0x00020000 = 0x00020009`。
 * 2. `[文档]` windows-sys（由官方 Win32 元数据生成）：
 *    `pub const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES: u32 = 131081`，而 `131081 = 0x00020009`。
 * 3. `[文档]` `UpdateProcThreadAttribute` 官方页对该属性的语义原文：
 *    "The lpValue parameter is a pointer to a SECURITY_CAPABILITIES structure that defines the security
 *     capabilities of an app container. **If this attribute is set the new process will be created as an
 *     AppContainer process.**"
 * 4. `[实测]` 把不同属性号喂给同一个 `UpdateProcThreadAttribute`（值都是 24 字节 `SECURITY_CAPABILITIES`）：
 *    `0x00020009` → `true`（属性列表确实被写入）；`0x0002000A` / `0x00020017` → `false` + `ERROR_BAD_LENGTH(24)`。
 *    （`0x00020017`（Number=23）是阶段 B 报告 §7 提过的候选，**实测否定**。）
 *    原始输出：`.t/sbx3/dev/raw-t0-forensics.txt` §1 与 `raw-t0-pinvoke.txt` §3（独立 P/Invoke 通道同样结论）。
 */
export const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009

/**
 * `SECURITY_CAPABILITIES` 布局：`{ PSID AppContainerSid; PSID_AND_ATTRIBUTES Capabilities; DWORD CapabilityCount; DWORD Reserved; }`
 *
 * `[官方]` x64 大小 = **24**：PSID(8) + PSID_AND_ATTRIBUTES(8) + DWORD(4) + DWORD(4)。
 * 结构体按 8 对齐，24 已是 8 的倍数 → **没有尾部填充**。
 *
 * ── 缺陷 D5 留档（32 是怎么来的，以及它为什么危险）────────────────────────────
 * 本常量曾取 **32**，理由是"再补 8 字节 padding"。那 8 字节在官方定义里**不存在**：
 * 初版用"先加 padding 再把缓冲区量回 32"的写法把错误固化成了测试断言（循环论证），
 * 于是测试全绿、而真实调用 `UpdateProcThreadAttribute` 因 cbSize 错误
 * 返回 false + `ERROR_INVALID_PARAMETER(87)`（阶段 B `[实测]`，
 * 见 `.t\sbx3\dev\02-阶段B报告.md` §4/§11 与 `.t/sbx3/dev/raw-probe-ac-token.txt`）。
 * 教训：布局常量必须来自**独立的官方算术**，不能用"实现量出来的数"反过来证明实现正确。
 *
 * ⚠ 如实声明（`[实测]`，阶段 B → **FIX-B 已推翻其结论**）──
 * 阶段 B 曾写："只把 32 改成 24 并不能让 T0 生效；cbSize=24 时属性确已写入成功，
 * 但派生出的子进程 `TokenUser` 仍是用户 SID —— 隔离为零"。
 * **这条结论是错的，错在判据**：AppContainer 令牌的 `TokenUser` **本来就是用户 SID**，
 * 包身份在 `TokenAppContainerSid(31)`；包 SID 也**不在** `TokenGroups` 里。
 * 用 `TokenIsAppContainer(29)` 直查（`CREATE_SUSPENDED` 状态）：`cbSize=24` ⇒ **`1`**（真的在
 * AppContainer 里，IL=Low），`cbSize=32` ⇒ `0`（High IL）。行为面同样成立（区外写被拒、网络被阻断）。
 * 原始证据：`.t/sbx3/dev/raw-t0-forensics.txt`、`raw-t0-behaviour.txt`。
 * 教训：**判据本身必须能被"已知坏配置"证伪** —— 我们正是靠 `cbSize=32` 那组对照
 * （`TokenIsAppContainer=0`）才确认 `TokenIsAppContainer` 这个判据有分辨力。
 *
 * ⚠ 但"改成 24"**只是必要条件之一**：FIX-B 还发现 `bInheritHandles=TRUE` + 无自有控制台会让
 * AppContainer 子进程以 `0xC0000142 (STATUS_DLL_INIT_FAILED)` 静默死亡
 * （`CreateProcessW` 仍返回成功），见 `src/appcontainer-runtime.mjs` 的 `CREATE_NEW_CONSOLE` 注释。
 */
export const SECURITY_CAPABILITIES_SIZE = 24
export const OFF_AC_SID = 0
export const OFF_AC_CAPABILITIES = 8
export const OFF_AC_CAPABILITY_COUNT = 16
export const OFF_AC_RESERVED = 20

/** `PROC_THREAD_ATTRIBUTE_LIST` 的头部（不透明结构，但前 8 字节可读） */
export const ATTRIBUTE_LIST_HEADER_SIZE = 8

/**
 * 构造 `SECURITY_CAPABILITIES` 缓冲区。
 *
 * @param {bigint|object|null} appContainerSid 包 SID 指针
 * @param {Array<{sid: bigint|object, attributes: number}>} capabilities 能力 SID 列表
 *   （**不含** internetClient；要联网必须显式加入）
 * @returns {Buffer} 24 字节（= `[官方]` sizeof(SECURITY_CAPABILITIES)，无尾部填充）
 */
export function buildSecurityCapabilities(appContainerSid, capabilities = []) {
  const buffer = Buffer.alloc(SECURITY_CAPABILITIES_SIZE)
  // 指针字段按 64 位写入；用 Buffer 承载而非 JS number，避免精度丢失
  writePointer(buffer, OFF_AC_SID, appContainerSid)
  // Capabilities 数组需要调用方另行分配并传入指针；这里只支持"无能力"，
  // 因为把 SID_AND_ATTRIBUTES 数组的生命周期管好应当由调用方显式负责。
  if (capabilities.length > 0) {
    if (capabilities.length !== 1 || !capabilities[0]?.pointer) {
      throw new Error(
        'buildSecurityCapabilities: capabilities must be pre-allocated; pass [{ pointer, count }] via buildSecurityCapabilitiesWithArray',
      )
    }
    writePointer(buffer, OFF_AC_CAPABILITIES, capabilities[0].pointer)
    buffer.writeUInt32LE(capabilities[0].count ?? 1, OFF_AC_CAPABILITY_COUNT)
  } else {
    writePointer(buffer, OFF_AC_CAPABILITIES, null)
    buffer.writeUInt32LE(0, OFF_AC_CAPABILITY_COUNT)
  }
  buffer.writeUInt32LE(0, OFF_AC_RESERVED)
  return buffer
}

function writePointer(buffer, offset, value) {
  if (value === null || value === undefined) {
    buffer.writeBigUInt64LE(0n, offset)
    return
  }
  if (typeof value === 'bigint') {
    buffer.writeBigUInt64LE(value, offset)
    return
  }
  if (typeof value === 'number') {
    buffer.writeBigUInt64LE(BigInt(value), offset)
    return
  }
  // Koffi 指针：写出其地址
  const asBig = typeof value.address === 'function' ? value.address() : undefined
  if (typeof asBig === 'bigint') {
    buffer.writeBigUInt64LE(asBig, offset)
    return
  }
  throw new TypeError(`cannot encode pointer of type ${typeof value} at offset ${offset}`)
}

/**
 * 需要置位的创建标志。
 *
 * `[官方]`/`[实测教训]` 两条都必须：
 *   - `EXTENDED_STARTUPINFO_PRESENT`：不置位则 `lpAttributeList` 被**静默忽略**；
 *   - `CREATE_UNICODE_ENVIRONMENT`：与显式环境块成对出现（缺陷 13：漏掉它会 Win32 87）。
 */
export function buildCreationFlags(hasEnvironmentBlock) {
  let flags = EXTENDED_STARTUPINFO_PRESENT
  if (hasEnvironmentBlock) flags |= 0x00000400 // CREATE_UNICODE_ENVIRONMENT
  return flags >>> 0
}

// ─────────────────────────── 可用性探测（真实调用）───────────────────────────

/**
 * 真实探测 AppContainer 是否可用：调用 `CreateAppContainerProfile` 并立即删除。
 *
 * `[实测-阶段B/FIX-B]` 本机（High IL 管理员令牌）**成功**：`hr=0x0`，profile 用完即删。
 * `0x80070005 (E_ACCESSDENIED)` 只在**受限令牌**会话里出现（阶段 A 的观测）。
 * 探测失败**不降级**为 T1 —— 由调用方决定是否换档；本函数只如实回报。
 *
 * ⚠ 本函数返回 `available: true` **只说明 profile 能建**，**不代表**隔离已生效。
 * "隔离是否生效"必须用 `src/appcontainer-runtime.mjs` 的
 * `readProcessTokenFacts()` + `assessAppContainerIsolation()` 采实测证据来判定。
 *
 * @param {object} koffi 已加载的 koffi 模块
 * @returns {{available: boolean, hr?: number, sid?: string, detail: string}}
 */
export function probeAppContainerAvailability(koffi) {
  let userenv
  try {
    userenv = koffi.load('userenv.dll')
  } catch (error) {
    return { available: false, detail: `userenv.dll load failed: ${error.message}` }
  }
  try {
    const CreateAppContainerProfile = userenv.func(
      'long CreateAppContainerProfile(const char16_t *name, const char16_t *displayName, const char16_t *description, void *capabilities, uint32 capabilityCount, _Out_ void **sid)',
    )
    const DeleteAppContainerProfile = userenv.func('long DeleteAppContainerProfile(const char16_t *name)')
    const name = `dsh.stage.${Date.now().toString(36)}`
    const sidSlot = [null]
    const hr = CreateAppContainerProfile(name, name, 'WinStageSandbox AppContainer probe', null, 0, sidSlot)
    if (hr === 0) {
      DeleteAppContainerProfile(name)
      return { available: true, hr: 0, detail: 'CreateAppContainerProfile succeeded' }
    }
    return {
      available: false,
      hr: hr >>> 0,
      detail: `CreateAppContainerProfile failed hr=0x${(hr >>> 0).toString(16)}${
        (hr >>> 0) === 0x80070005 ? ' (E_ACCESSDENIED)' : ''
      }`,
    }
  } catch (error) {
    return { available: false, detail: `AppContainer probe threw: ${error.message}` }
  }
}

/**
 * 拿到可用于 `CreateProcess` 的 AppContainer 包 SID 指针。
 *
 * **fail-closed**：任何一步失败都抛错，绝不返回一个"看起来像"的 SID。
 * 调用方必须先 `probeAppContainerAvailability()` 确认可用。
 */
export function createAppContainerProfile(koffi, profileName) {
  const userenv = koffi.load('userenv.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const kernel32 = koffi.load('kernel32.dll')

  const CreateAppContainerProfile = userenv.func(
    'long CreateAppContainerProfile(const char16_t *name, const char16_t *displayName, const char16_t *description, void *capabilities, uint32 capabilityCount, _Out_ void **sid)',
  )
  const DeriveAppContainerSidFromAppContainerName = userenv.func(
    'long DeriveAppContainerSidFromAppContainerName(const char16_t *name, _Out_ void **sid)',
  )
  const DeleteAppContainerProfile = userenv.func('long DeleteAppContainerProfile(const char16_t *name)')
  const ConvertSidToStringSidW = advapi32.func('bool ConvertSidToStringSidW(void *sid, _Out_ void **str)')
  const LocalFree = kernel32.func('void *LocalFree(void *h)')

  const name = profileName ?? `dsh.stage.${Date.now().toString(36)}`
  const sidSlot = [null]
  let hr = CreateAppContainerProfile(name, name, 'WinStageSandbox AppContainer', null, 0, sidSlot)
  let sid = sidSlot[0]
  if (hr !== 0) {
    // 已存在同名 profile 时派生即可（幂等，避免每次运行都新建）
    const derived = [null]
    const hr2 = DeriveAppContainerSidFromAppContainerName(name, derived)
    if (hr2 !== 0) {
      const error = new Error(
        `CreateAppContainerProfile failed hr=0x${(hr >>> 0).toString(16)} and DeriveAppContainerSidFromAppContainerName failed hr=0x${(hr2 >>> 0).toString(16)}`,
      )
      error.code = 'APPCONTAINER_UNAVAILABLE'
      throw error
    }
    sid = derived[0]
  }

  // 转成字符串形式便于日志与授权（SDDL 里要用）
  let sidString
  const strSlot = [null]
  if (ConvertSidToStringSidW(sid, strSlot) && strSlot[0]) {
    // Koffi 字符串指针：调用方负责解读；这里只做尽力提取
    sidString = strSlot[0]
    try {
      LocalFree(strSlot[0])
    } catch {
      /* 释放失败不影响主流程 */
    }
  }

  return {
    name,
    sid,
    sidString,
    /** 移除 profile（清理用；失败只记录不抛） */
    dispose() {
      try {
        DeleteAppContainerProfile(name)
      } catch {
        /* 忽略 */
      }
    },
  }
}

/** 本模块是否具备运行条件（快速、非权威；权威判断用 probeAppContainerAvailability） */
export function isAvailable(koffi) {
  if (!koffi || typeof koffi.load !== 'function') return false
  try {
    if (!existsSync('C:\\Windows\\System32\\userenv.dll')) return false
  } catch {
    return false
  }
  return probeAppContainerAvailability(koffi).available
}

// ─────────────────── 陈旧包 SID ACE 的检测与修复（缺陷③）─────────────────────

/**
 * `[官方]` AppContainer 包 SID 的形状：`S-1-15-2-<段1>-…-<段7>`，
 * 即前缀之后还有 **7** 个十进制段（`[实测]` 与真实包 SID 逐段核对过：
 * `S-1-15-2-2541843839-1445201769-316974988-186645399-2929155336-2163906706-1690789193`
 * 的 `rest.split('-').length === 7`）。
 * `S-1-15-3-*` 是**能力** SID，不属于包身份，因此不在此列。
 *
 * ⚠ 本函数第一版把段数写成 `{7}`（= 8 段），于是**真实包 SID 一律被判成"不是包 SID"**，
 * 修复路径因此在真机上一条 ACE 都摘不到 —— 而离线用例当时也没覆盖，
 * 是本套件的 A1 段把这条 off-by-one 抓出来的（这正是"判据必须有断言"的理由）。
 */
export const APPCONTAINER_PACKAGE_SID_PREFIX = 'S-1-15-2-'

/** `[官方]` `ACE_HEADER.AceType`：`ACCESS_ALLOWED_ACE_TYPE` = 0 */
const ACCESS_ALLOWED_ACE_TYPE = 0
/** `[官方]` `ACE_HEADER.AceFlags`：`INHERITED_ACE` = 0x10（继承来的不算"被谁写进去的"） */
const INHERITED_ACE_FLAG = 0x10

/** 一个 SID 字符串是否形如 AppContainer 包 SID（只做字符串判据，不查系统） */
export function isAppContainerPackageSid(sid) {
  if (typeof sid !== 'string') return false
  if (!sid.startsWith(APPCONTAINER_PACKAGE_SID_PREFIX)) return false
  const rest = sid.slice(APPCONTAINER_PACKAGE_SID_PREFIX.length)
  // 前缀之后 7 个十进制段：首段 + 再 6 段
  return /^[0-9]+(-[0-9]+){6}$/.test(rest)
}

/**
 * 把 `icacls <dir> /save` 风格的 SDDL 里的 ACE 段拆成结构化列表。
 *
 * 为什么自己拆而不用 `Get-Acl`：`[实测]` 本仓库的测试面**禁止子进程管道捕获**
 * （残余边界 R10，`node child_process` 默认 `stdio:'pipe'` 在受限会话里 EPERM），
 * 因此"解析"这一步必须是**纯函数**，这样离线套件可以直接喂合成 SDDL 给它。
 *
 * 解析规则（`[官方]` SDDL 语法）：
 *   - `D:` 段里的 ACE 形如 `(AceType;AceFlags;Rights;ObjectGuid;InheritObjectGuid;AccountSid)`；
 *   - 段内 `;` 不转义（本函数只处理 6 段形式，多余段一律判为不可解析并记 `unparsed`）；
 *   - `D:AI(...)…` 的 `AI`、`D:P` 的 `P` 是 DACL 控制位，不是 ACE。
 *
 * @returns {{aces: Array<{type:number,flags:number,rights:string,sid:string,inherited:boolean,source:string}>, unparsed: string[]}}
 */
/**
 * `[官方]` `ACE_HEADER.AceType` 的 mnemonic 映射（SDDL 里是字母，不是数字）。
 * ⚠ 踩过的坑：第一版直接 `Number.parseInt(parts[0], 16)`，
 * 于是 `'A'`→10 侥幸对、"OICI" 这种**flag** 却变成 `NaN` 被当成"不可解析"丢掉 ——
 * 结果是**真机上一条陈旧 ACE 都摘不到**。见本文件 `isAppContainerPackageSid()` 的同族注释。
 */
const ACE_TYPE_BY_MNEMONIC = Object.freeze({
  A: 0x00, // ACCESS_ALLOWED
  D: 0x01, // ACCESS_DENIED
  OA: 0x05, // ACCESS_ALLOWED_OBJECT
  OD: 0x06, // ACCESS_DENIED_OBJECT
  AU: 0x09, // SYSTEM_AUDIT
  AL: 0x11, // SYSTEM_ALARM
  OAII: 0x05,
})
/** `[官方]` `ACE_HEADER.AceFlags` 的 mnemonic 映射 */
const ACE_FLAG_BITS = Object.freeze({
  OI: 0x01, // OBJECT_INHERIT
  CI: 0x02, // CONTAINER_INHERIT
  NP: 0x04, // NO_PROPAGATE_INHERIT
  IO: 0x08, // INHERIT_ONLY
  ID: 0x10, // INHERITED
  SA: 0x40, // SUCCESSFUL_ACCESS
  FA: 0x80, // FAILED_ACCESS
})

function aceTypeOf(token) {
  const text = String(token ?? '').toUpperCase()
  if (text in ACE_TYPE_BY_MNEMONIC) return ACE_TYPE_BY_MNEMONIC[text]
  const numeric = Number.parseInt(text, 16)
  return Number.isFinite(numeric) ? numeric : NaN
}

function aceFlagsOf(token) {
  const text = String(token ?? '').toUpperCase()
  if (text.length === 0) return 0
  if (/^[0-9A-F]+$/.test(text) && /[0-9]/.test(text)) {
    const numeric = Number.parseInt(text, 16)
    if (Number.isFinite(numeric)) return numeric
  }
  let bits = 0
  for (let i = 0; i < text.length; i += 2) {
    const pair = text.slice(i, i + 2)
    if (!(pair in ACE_FLAG_BITS)) return NaN
    bits |= ACE_FLAG_BITS[pair]
  }
  return bits
}

export function parseSddlDaclAces(sddl) {
  const text = String(sddl ?? '')
  const marker = text.indexOf('D:')
  if (marker < 0) return { aces: [], unparsed: [] }
  const body = text.slice(marker + 2)
  const aces = []
  const unparsed = []
  for (const raw of body.split('(')) {
    const end = raw.indexOf(')')
    if (end < 0) continue
    const inner = raw.slice(0, end)
    if (inner.length === 0) continue
    const parts = inner.split(';')
    if (parts.length !== 6) {
      unparsed.push(`(${inner})`)
      continue
    }
    const type = aceTypeOf(parts[0])
    const flags = aceFlagsOf(parts[1])
    if (!Number.isFinite(type) || !Number.isFinite(flags)) {
      unparsed.push(`(${inner})`)
      continue
    }
    aces.push({
      type,
      flags,
      rights: parts[2],
      sid: parts[5],
      inherited: (flags & INHERITED_ACE_FLAG) !== 0,
      source: `(${inner})`,
    })
  }
  return { aces, unparsed }
}

/**
 * 找出"被显式写进 DACL 的 AppContainer 包 SID 允许 ACE"。
 *
 * ── 为什么这些 ACE 必须被清掉（缺陷③的根因）──────────────────────────────────
 * `[实测]` 本会话可控三步实验（`.t\fix3-repro\`，见
 * `docs\边界缺陷修复-③T0污染与静默降级.md`）：
 *   1. 新工作区 `--tier T1` 写暂存根 → `t1_inside=OK`（DACL 里没有任何 `S-1-15-2-*`）
 *   2. 只跑**一次** `--tier T0` → 暂存根顶部被插入
 *      `S-1-15-2-…:(OI)(CI)(M)`（`icacls <staged> /grant *<sid>:(OI)(CI)M`）
 *   3. 同一工作区再用 `--tier T1` 写 → `Access is denied.`
 *   A/B 翻转实验：删掉**这一条** ACE ⇒ `OK`；把**同一条** ACE 加回 ⇒ 再次 `denied`。
 *   对照实验排除了"巧合"：把同样权限 `(M)` 授予一个**非** `S-1-15-2-*` 的
 *   不存在 SID ⇒ T1 仍然 `OK`。
 *
 * ⇒ 判据是"**非继承** + `ACCESS_ALLOWED` + 受托者是 AppContainer 包 SID"。
 *   继承来的包 SID ACE（例如上层目录本来就有的）不动 —— 那不属于本次污染，
 *   而且删了会改到调用方没让我们碰的祖先目录。
 */
export function findStaleAppContainerAces(sddl) {
  const { aces, unparsed } = parseSddlDaclAces(sddl)
  const stale = aces.filter(
    (ace) => !ace.inherited && ace.type === ACCESS_ALLOWED_ACE_TYPE && isAppContainerPackageSid(ace.sid),
  )
  return { stale, unparsed, total: aces.length }
}

/**
 * 从 SDDL 里抽出**全部**出现过的 AppContainer 包 SID（含继承 ACE）。
 * 用于"报告里如实写出这个目录树被哪个包 SID 标记过"。
 */
export function listAppContainerSids(sddl) {
  const { aces } = parseSddlDaclAces(sddl)
  const seen = new Set()
  for (const ace of aces) if (isAppContainerPackageSid(ace.sid)) seen.add(ace.sid)
  return [...seen]
}

export const __internal = { writePointer }
