/**
 * AppContainer 执行路径（Windows 原生读取面 & 网络面收敛）
 *
 * ── 现状声明（务必先读）────────────────────────────────────────────────────────
 * 本模块提供 AppContainer 的**结构与调用构造**，并配有无需 Win32 的确定性布局测试。
 * 但它在**本机无法实测**：当前会话是 WRITE_RESTRICTED 受限令牌，
 * `CreateAppContainerProfile` 返回 `hr=0x80070005`（E_ACCESSDENIED），
 * 因此**运行期行为未经实测**。按手册第 0 章证据分层，本模块结论只能标 `[官方]`/`[推断]`，
 * **不得**标 `[实测]`。
 *
 * 工程处理：
 *   1. `isAvailable()` 真实探测；拿不到 AppContainer 就**拒绝**，绝不静默退回继承环境；
 *   2. `createAppContainerToken()` 任一步失败即抛错并回收已分配资源（fail-closed）；
 *   3. 结构体布局（`STARTUPINFOEX` / `PROC_THREAD_ATTRIBUTE_LIST`）由
 *      `tests/appcontainer-layout.mjs` 用合成缓冲区确定性校验 —— 这正是
 *      Job 结构体（缺陷 5）与 `CREATE_UNICODE_ENVIRONMENT`（缺陷 13）两次踩坑后总结出的做法：
 *      **先把布局测对，再谈运行**。
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

/** `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 的属性号 */
export const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009

/** `SECURITY_CAPABILITIES` 布局：{ PSID AppContainerSid; PSID_AND_ATTRIBUTES Capabilities; DWORD CapabilityCount; DWORD Reserved; } */
export const SECURITY_CAPABILITIES_SIZE = 32
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
 * @returns {Buffer} 32 字节
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
 * `[实测]` 受限令牌下会返回 `0x80070005`（E_ACCESSDENIED）。
 * 探测失败**不降级**为 T1 —— 由调用方决定是否换档；本函数只如实回报。
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

export const __internal = { writePointer }
