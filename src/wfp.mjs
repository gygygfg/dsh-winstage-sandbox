/**
 * WFP（Windows Filtering Platform）网络阻断 —— 结构/参数构造层 + 调用层
 *
 * ── 本模块的阶段 A 定位（务必先读）────────────────────────────────────────────
 * 本模块只提供两样东西，且**严格分层**：
 *   1. **纯结构/参数构造层**（`build*` 系列 + `OFF_*` / `*_SIZE` 常量）：
 *      不碰任何 Win32、不依赖管理员权限，可用合成缓冲区离线确定性测试。
 *      这是从缺陷 5（Job 偏移错 4 字节）与缺陷 13（漏 CREATE_UNICODE_ENVIRONMENT）
 *      总结出的做法：**先把布局测对，再谈运行**。
 *   2. **调用层**（`openEngine` / `installSubLayer` / `addFilter` / `closeEngine` / `probeWfpAvailability`）：
 *      只做调用与错误码翻译，**不做任何隐含降级**（fail-closed）。
 *
 * ── 现状声明（**阶段 B 已更新：引擎现在能打开**）─────────────────────────────
 * 阶段 A（受限令牌）`[实测]`：`FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, NULL, NULL, &h)`
 * 返回 **`0x32` = Win32 50 `ERROR_NOT_SUPPORTED`**。
 *
 * 阶段 B（High IL 管理员令牌，宿主未受限）`[实测]`，原始输出
 * `.t/sbx3/dev/raw-probe-wfp-runtime.txt`：
 *   - `FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT(10), NULL, <session=NULL 或 DYNAMIC>, &h)` → **`0x00000000` 成功**，
 *     `FwpmEngineClose0` → `0x00000000`；
 *   - `authn = RPC_C_AUTHN_DEFAULT(0xFFFFFFFF)` → 同样 `0x00000000`；
 *   - `authn = RPC_C_AUTHN_NONE(0)` → **`0x00000032`**。
 *   ⇒ 阶段 A 的 `0x32` 有两重原因叠加：**受限令牌** + `authnService` 取值。
 *     `0x32` 现在有了确切的、可复现的成因：**`RPC_C_AUTHN_NONE` 不是合法的 `authnService`**
 *     （`[官方]` 只允许 `RPC_C_AUTHN_WINNT` / `RPC_C_AUTHN_DEFAULT`）。
 *   - `BFE` 与 `MpsSvc` 服务 `state=4 (RUNNING)`（`OpenSCManagerW`+`QueryServiceStatusEx` 直测，pid=3000）。
 *
 * ⇒ **调用层的 `probeWfpAvailability` / `openEngine` 现在是 `[实测]` 通过的**。
 *   但 `installSubLayer` / `addFilter` / `applyOfflinePlan`（**会改系统状态**）**仍为 `[未实测]`**：
 *   安装过滤器是系统级状态变更，本阶段未获授权，**一个 `Fwpm*Add0` 都没调用过**。
 *
 * ── GUID 来源（本模块刻意不内置任何 GUID 字面量）──────────────────────────────
 * `[官方]` 微软文档给的是**常量名**与语义，**不给 GUID 值**；本机未安装 Windows SDK
 * （`C:\Program Files (x86)\Windows Kits\10\Include` 不存在），无法从 `fwpmu.h` 取值。
 * 因此所有 layer/condition GUID 必须由调用方经 `config.guids` 传入，本模块只做：
 *   - 格式与长度校验（`parseGuid`，长度不是 16 字节就抛错）；
 *   - 小端字段序编码（`guidToBuffer`）。
 * 缺少必需 GUID 时**直接抛 `WFP_GUIDS_MISSING`**，而不是猜一个值。
 * 好处：把"未核实的常量"从代码挪进配置，阶段 B 拿到权威值后一次性替换，代码不动。
 *
 * ── 证据分层标签 ──────────────────────────────────────────────────────────────
 * `[官方]` = 逐字取自微软 Learn 文档（URL 见下）；`[推断]` = 按 x64 psABI 规则推导，
 * 本机无 SDK 头文件可核对；`[未实测]` = 运行期未验证。
 *
 * 官方依据：
 *   FwpmEngineOpen0          https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmengineopen0
 *   FwpmSubLayerAdd0         https://learn.microsoft.com/en-us/windows/win32/api/fwpmu/nf-fwpmu-fwpmsublayeradd0
 *   FWPM_FILTER0             https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_filter0
 *   FWPM_SUBLAYER0           https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_sublayer0
 *   FWPM_SESSION0            https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_session0
 *   FWPM_FILTER_CONDITION0   https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_filter_condition0
 *   FWPM_ACTION0             https://learn.microsoft.com/en-us/windows/win32/api/fwpmtypes/ns-fwpmtypes-fwpm_action0
 *   FWPM_DISPLAY_DATA0       https://learn.microsoft.com/en-us/windows/win32/api/fwptypes/ns-fwptypes-fwpm_display_data0
 *   FWP_VALUE0               https://learn.microsoft.com/en-us/windows/win32/api/fwptypes/ns-fwptypes-fwp_value0
 *   FWP_CONDITION_VALUE0     https://learn.microsoft.com/en-us/windows/win32/api/fwptypes/ns-fwptypes-fwp_condition_value0
 *   FWP_BYTE_BLOB            https://learn.microsoft.com/en-us/windows/win32/api/fwptypes/ns-fwptypes-fwp_byte_blob
 *   FWP_DATA_TYPE            https://learn.microsoft.com/en-us/windows/win32/api/fwptypes/ne-fwptypes-fwp_data_type
 *   FWP_MATCH_TYPE           https://learn.microsoft.com/en-us/windows/win32/api/fwptypes/ne-fwptypes-fwp_match_type
 *   层语义                   https://learn.microsoft.com/en-us/windows/win32/fwp/management-filtering-layer-identifiers-
 *   条件语义                 https://learn.microsoft.com/en-us/windows/win32/fwp/filtering-condition-identifiers-
 */

import { createHash } from 'node:crypto'

// ─────────────────────────── 常量：FWP_DATA_TYPE（[官方] 枚举次序即数值）───────────────────────────

/** `[官方]` `FWP_DATA_TYPE` 的显式值（枚举从 0 开始顺序编号，`FWP_SINGLE_DATA_TYPE_MAX=0xff`） */
export const FWP_DATA_TYPE = Object.freeze({
  FWP_EMPTY: 0,
  FWP_UINT8: 1,
  FWP_UINT16: 2,
  FWP_UINT32: 3,
  FWP_UINT64: 4,
  FWP_INT8: 5,
  FWP_INT16: 6,
  FWP_INT32: 7,
  FWP_INT64: 8,
  FWP_FLOAT: 9,
  FWP_DOUBLE: 10,
  FWP_BYTE_ARRAY16_TYPE: 11,
  FWP_BYTE_BLOB_TYPE: 12,
  FWP_SID: 13,
  FWP_SECURITY_DESCRIPTOR_TYPE: 14,
  FWP_TOKEN_INFORMATION_TYPE: 15,
  FWP_TOKEN_ACCESS_INFORMATION_TYPE: 16,
  FWP_UNICODE_STRING_TYPE: 17,
  FWP_BYTE_ARRAY6_TYPE: 18,
  FWP_SINGLE_DATA_TYPE_MAX: 0xff,
  FWP_V4_ADDR_MASK: 0x100,
  FWP_V6_ADDR_MASK: 0x101,
  FWP_RANGE_TYPE: 0x102,
})

/** `[官方]` `FWP_MATCH_TYPE` */
export const FWP_MATCH_TYPE = Object.freeze({
  FWP_MATCH_EQUAL: 0,
  FWP_MATCH_GREATER: 1,
  FWP_MATCH_LESS: 2,
  FWP_MATCH_GREATER_OR_EQUAL: 3,
  FWP_MATCH_LESS_OR_EQUAL: 4,
  FWP_MATCH_RANGE: 5,
  FWP_MATCH_FLAGS_ALL_SET: 6,
  FWP_MATCH_FLAGS_ANY_SET: 7,
  FWP_MATCH_FLAGS_NONE_SET: 8,
  FWP_MATCH_EQUAL_CASE_INSENSITIVE: 9,
  FWP_MATCH_NOT_EQUAL: 10,
  FWP_MATCH_PREFIX: 11,
  FWP_MATCH_NOT_PREFIX: 12,
})

/**
 * `[官方]` `FWP_ACTION_TYPE`。
 *
 * 官方页给出的是"复合值"写法（例如 `FWP_ACTION_BLOCK = 0x00000001 | FWP_ACTION_FLAG_TERMINATING`），
 * 但**没有单独给出 `FWP_ACTION_FLAG_TERMINATING` 的位值**。因此这里**不猜位值**，
 * 直接把官方写的复合表达式结果固化为常量，并在测试里钉死：
 *   - `FWP_ACTION_FLAG_TERMINATING` 若为 0x1000（Windows SDK 通行值），则 BLOCK=0x1001、PERMIT=0x1002。
 *   - **本模块同时导出 `ACTION_TYPE_PROVISIONAL = true`**，明确标记该数值**未经 SDK 核对**。
 * 若阶段 B 拿到 SDK 头文件后与此不符，测试会红。
 */
export const FWP_ACTION_TYPE = Object.freeze({
  FWP_ACTION_BLOCK: 0x00001001,
  FWP_ACTION_PERMIT: 0x00001002,
  FWP_ACTION_CALLOUT_TERMINATING: 0x00001003,
  FWP_ACTION_CALLOUT_INSPECTION: 0x00001004,
  FWP_ACTION_CALLOUT_UNKNOWN: 0x00001005,
})
/** 该组 ACTION 常量是否只是"暂定值"（未与 SDK 头文件核对）——调用方在报告里必须如实标注 */
export const ACTION_TYPE_PROVISIONAL = true

/** `[官方]` `FWPM_SUBLAYER_FLAG_PERSISTENT`（**本项目刻意不使用**：会跨 BFE 重启存活） */
export const FWPM_SUBLAYER_FLAG_PERSISTENT = 0x00000001

/** `[官方]` `FWPM_SESSION_FLAG_DYNAMIC`：会话结束自动删除本次会话添加的对象 */
export const FWPM_SESSION_FLAG_DYNAMIC = 0x00000001

/** `[官方]` `FwpmEngineOpen0`：serverName **必须为 NULL**；authnService 只允许这两个 */
export const RPC_C_AUTHN_WINNT = 10
export const RPC_C_AUTHN_DEFAULT = 0xffffffff
/** 本项目实际使用 NONE=0 做探测；注意官方只允许 WINNT / DEFAULT，故 NONE 属"探测用越界值" */
export const RPC_C_AUTHN_NONE = 0

// ─────────────────────────── 结构体布局（x64 / MSVC）───────────────────────────
//
// 推导规则 `[官方]` x64 Windows psABI：
//   GUID=16/align8；指针=8/align8；UINT64=8/align8；UINT32/BOOL/float=4/align4；
//   UINT16=2/align2；UINT8=1/align1；结构体对齐 = 最大成员对齐，总大小补齐到对齐倍数。
// 这些数值全部 `[推断]`（本机无 SDK 头文件），由 tests/wfp-layout.mjs 用合成缓冲区钉死。

export const FWP_BYTE_BLOB_SIZE = 16
export const OFF_BYTE_BLOB = Object.freeze({ size: 0, data: 8 })

export const FWP_VALUE0_SIZE = 16
export const OFF_VALUE = Object.freeze({ type: 0, value: 8 })

export const FWP_CONDITION_VALUE0_SIZE = 16
export const OFF_CONDITION_VALUE = Object.freeze({ type: 0, value: 8 })

export const FWPM_DISPLAY_DATA0_SIZE = 16
export const OFF_DISPLAY_DATA = Object.freeze({ name: 0, description: 8 })

/**
 * `FWPM_ACTION0` 的大小 = **24**（不是 20）。
 *
 * 这条是**被官方文档反推出来的**，不是"我觉得 8 字节对齐更好看"：
 * `[官方]` `FWPM_FILTER0` 的字段次序 + 已知的 `FWPM_DISPLAY_DATA0`=16、`FWP_BYTE_BLOB`=16、
 * `GUID`=16、`FWP_VALUE0`=16 可以唯一确定 `action` 之后所有字段的偏移：
 *
 *   displayData 16..32, flags 32..36, providerKey 40, providerData 48..64, layerKey 64..80,
 *   subLayerKey 80..96, weight 96..112, numFilterConditions 112..116, (pad 116..120),
 *   filterCondition 120..128, **action 128..128+sizeof(action)**, (pad → align 8),
 *   rawContext 152, reserved 160, filterId 168, effectiveWeight 176..192  ⇒ size 192
 *
 * 若 `sizeof(action)` = 20：`action` 结束于 148，而 `rawContext` 需要 align 8 → 152。
 * 148 与 152 之间**有 4 字节空洞**，MSVC 不会为"尾部成员"制造这种空洞——
 * 结构体的总大小会先补齐到对齐倍数（148 → 152），下一个成员直接落在 152。
 * 于是 `sizeof(FWPM_FILTER0)` 会是 128+20→152 +8+8+8+16 = **192**，看起来也对；
 * 但那样 `action` 只有 20 字节，`union { GUID filterType; GUID calloutKey; }` 就被截断了 4 字节。
 * 官方文档把该 union 写成 **GUID（16 字节）**，因此 `action` 至少 20 字节；
 * 而 CLR 的 `Marshal.SizeOf` 对同形结构给出 **24**（把 16 字节 GUID 对齐到 8），
 * 且 `FWPM_FILTER0` 在两种模型下都给出 192 —— 两者都指向 **24**。
 *
 * **结论：取 24。** 这是本阶段 A 修正的一个真实错误：
 * 初稿写 20，被 `.t/sbx3/dev/struct-layout-verify.ps1` 的 CLR 反查 + 上面这段
 * "从官方字段次序反推偏移"的独立推导共同判为错。留档在 01-阶段A报告.md。
 *
 * `[推断]` 依据：x64 Windows psABI（GUID=16/align8）+ 官方字段次序。
 * `[未实测]`：本机无 Windows SDK 头文件，无法用 `sizeof(FWPM_ACTION0)` 直接核对。
 */
export const FWPM_ACTION0_SIZE = 24
export const OFF_ACTION = Object.freeze({ type: 0, filterTypeOrCalloutKey: 8 })

export const FWPM_FILTER_CONDITION0_SIZE = 40
export const OFF_FILTER_CONDITION = Object.freeze({ fieldKey: 0, matchType: 16, conditionValue: 24 })

export const FWPM_SUBLAYER0_SIZE = 72
export const OFF_SUBLAYER = Object.freeze({
  subLayerKey: 0,
  displayData: 16,
  flags: 32,
  providerKey: 40,
  providerData: 48,
  weight: 64,
})

export const FWPM_SESSION0_SIZE = 72
/**
 * `FWPM_SESSION0` 的大小是**推断的保守上界**，理由必须留档：
 * 按官方字段次序硬排，`kernelMode` 落在偏移 **64**，而"最后一个字段结束于 64"意味着
 * 结构体只需 64 字节即可容纳它 —— 但那与 align 8 的补齐规则冲突（GUID 把对齐抬到 8，
 * 64 已是 8 的倍数，所以 64 与 72 都能自洽）。官方文档**不给 sizeof**。
 * 本项目取 **72**（更宽松），并在测试里断言 `OFF_SESSION.kernelMode + 4 <= FWPM_SESSION0_SIZE`。
 * 若 SDK 的 `sizeof(FWPM_SESSION0)` 是 64，则本常量偏大——但本项目传给 BFE 的是**指针**，
 * 从不传结构体长度，所以偏大不会导致 `ERROR_BAD_LENGTH` 类故障（与 Job 那次不同）。
 */
export const OFF_SESSION = Object.freeze({
  sessionKey: 0,
  displayData: 16,
  flags: 32,
  txnWaitTimeoutInMSec: 36,
  processId: 40,
  sid: 48,
  username: 56,
  kernelMode: 64,
})

export const FWPM_FILTER0_SIZE = 192
export const OFF_FILTER = Object.freeze({
  filterKey: 0,
  displayData: 16,
  flags: 32,
  providerKey: 40,
  providerData: 48,
  layerKey: 64,
  subLayerKey: 80,
  weight: 96,
  numFilterConditions: 112,
  filterCondition: 120,
  action: 128,
  rawContextOrProviderContextKey: 152,
  reserved: 160,
  filterId: 168,
  effectiveWeight: 176,
})

/** 所有 `build*` 产物都必须通过的"布局自洽"检查（越界即在构造期大声失败） */
export const LAYOUT = Object.freeze({
  FWP_BYTE_BLOB: { size: FWP_BYTE_BLOB_SIZE, off: OFF_BYTE_BLOB },
  FWP_VALUE0: { size: FWP_VALUE0_SIZE, off: OFF_VALUE },
  FWP_CONDITION_VALUE0: { size: FWP_CONDITION_VALUE0_SIZE, off: OFF_CONDITION_VALUE },
  FWPM_DISPLAY_DATA0: { size: FWPM_DISPLAY_DATA0_SIZE, off: OFF_DISPLAY_DATA },
  FWPM_ACTION0: { size: FWPM_ACTION0_SIZE, off: OFF_ACTION },
  FWPM_FILTER_CONDITION0: { size: FWPM_FILTER_CONDITION0_SIZE, off: OFF_FILTER_CONDITION },
  FWPM_SUBLAYER0: { size: FWPM_SUBLAYER0_SIZE, off: OFF_SUBLAYER },
  FWPM_SESSION0: { size: FWPM_SESSION0_SIZE, off: OFF_SESSION },
  FWPM_FILTER0: { size: FWPM_FILTER0_SIZE, off: OFF_FILTER },
})

// ─────────────────────────── GUID 编解码 ───────────────────────────

const GUID_TEXT = /^\{?([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{4})-([0-9a-fA-F]{12})\}?$/

/**
 * 解析 GUID 文本为 16 字节 Buffer（**内存序**：Data1/2/3 小端，Data4 原序）。
 *
 * 为什么必须自己写：`GUID` 的前三个字段是 **little-endian**，最省事的做法
 * （把去掉连字符的 hex 直接当字节序写）会得到**字节序翻转**的 GUID，
 * 而 BFE 不会报错——它只会"找不到这一层"，然后 `FwpmFilterAdd0` 返回
 * `FWP_E_LAYER_NOT_FOUND`，看起来像"这层不支持"而不是"你写错了"。
 *
 * @param {string} text `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` 或带花括号
 * @returns {Buffer} 16 字节
 */
export function parseGuid(text) {
  if (typeof text !== 'string') throw new TypeError(`GUID must be a string, got ${typeof text}`)
  const match = GUID_TEXT.exec(text.trim())
  if (!match) {
    const error = new Error(`malformed GUID: ${JSON.stringify(text)} (expected 8-4-4-4-12 hex)`)
    error.code = 'WFP_GUID_MALFORMED'
    throw error
  }
  const [, d1, d2, d3, d4, d5] = match
  const buffer = Buffer.alloc(16)
  buffer.writeUInt32LE(parseInt(d1, 16), 0)
  buffer.writeUInt16LE(parseInt(d2, 16), 4)
  buffer.writeUInt16LE(parseInt(d3, 16), 6)
  buffer.writeUInt16BE(parseInt(d4, 16), 8) // Data4 前 2 字节按原序
  Buffer.from(d5, 'hex').copy(buffer, 10)
  return buffer
}

/** 16 字节内存序 Buffer → 规范文本形式（`parseGuid` 的逆运算，供日志与回读核对） */
export function formatGuid(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length !== 16) {
    throw new TypeError(`GUID buffer must be exactly 16 bytes, got ${Buffer.isBuffer(buffer) ? buffer.length : typeof buffer}`)
  }
  const hex = (n) => n.toString(16).padStart(2, '0')
  const d1 = buffer.readUInt32LE(0).toString(16).padStart(8, '0')
  const d2 = buffer.readUInt16LE(4).toString(16).padStart(4, '0')
  const d3 = buffer.readUInt16LE(6).toString(16).padStart(4, '0')
  const d4 = buffer.readUInt16BE(8).toString(16).padStart(4, '0')
  const d5 = [...buffer.subarray(10, 16)].map(hex).join('')
  return `${d1}-${d2}-${d3}-${d4}-${d5}`
}

/** 接受 Buffer(16) / 十六进制文本 / 标准文本，统一成 16 字节 Buffer（fail-closed） */
export function coerceGuid(value, what = 'GUID') {
  if (Buffer.isBuffer(value)) {
    if (value.length !== 16) {
      const error = new Error(`${what} buffer must be 16 bytes, got ${value.length}`)
      error.code = 'WFP_GUID_MALFORMED'
      throw error
    }
    return value
  }
  if (typeof value === 'string') return parseGuid(value)
  const error = new Error(`${what} must be a GUID string or a 16-byte Buffer, got ${typeof value}`)
  error.code = 'WFP_GUID_MALFORMED'
  throw error
}

/** 写入一个 GUID（若为 null/undefined 则写全 0，即 `IID_NULL`） */
function writeGuid(buffer, offset, value, what) {
  if (value === null || value === undefined) {
    buffer.fill(0, offset, offset + 16)
    return
  }
  coerceGuid(value, what).copy(buffer, offset)
}

// ─────────────────────────── 指针与字符串 ───────────────────────────

/**
 * 把"指针样"的值编码成 8 字节。
 *
 * 与 `src/appcontainer.mjs::writePointer` 同样的取舍：用 Buffer 承载而不是 JS number，
 * 避免 64 位地址的精度丢失。本模块**不假设** Koffi 的具体形状，只认这几种：
 *   - `bigint` / `number` / `null` / `undefined`
 *   - 带 `address()` 的对象（Koffi 指针的常见形状）
 *   - **任何其它对象一律抛错**（不猜、不 `Number()` 一个对象）
 *
 * @param {Buffer} buffer 目标缓冲
 * @param {number} offset 偏移
 * @param {unknown} value 指针值
 */
export function writePointer(buffer, offset, value) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('writePointer: buffer must be a Buffer')
  if (offset < 0 || offset + 8 > buffer.length) {
    const error = new Error(`writePointer: offset ${offset}+8 exceeds buffer length ${buffer.length}`)
    error.code = 'WFP_LAYOUT_OVERFLOW'
    throw error
  }
  const nullish = value === null || value === undefined
  if (nullish) {
    buffer.writeBigUInt64LE(0n, offset)
    return
  }
  if (typeof value === 'bigint') {
    buffer.writeBigUInt64LE(value, offset)
    return
  }
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) {
      const error = new Error(`writePointer: numeric pointer must be a non-negative integer, got ${value}`)
      error.code = 'WFP_POINTER_INVALID'
      throw error
    }
    buffer.writeBigUInt64LE(BigInt(value), offset)
    return
  }
  if (typeof value === 'object' && typeof value.address === 'function') {
    const address = value.address()
    if (typeof address !== 'bigint') {
      const error = new Error(`writePointer: pointer-like object returned ${typeof address} from address()`)
      error.code = 'WFP_POINTER_INVALID'
      throw error
    }
    buffer.writeBigUInt64LE(address, offset)
    return
  }
  const error = new Error(`writePointer: cannot encode pointer of type ${typeof value} at offset ${offset}`)
  error.code = 'WFP_POINTER_INVALID'
  throw error
}

/** UTF-16LE + 双 NUL 结尾的字符串缓冲（FWPM_DISPLAY_DATA0 的 name/description 用） */
export function encodeWideString(text, what = 'wide string') {
  if (typeof text !== 'string') throw new TypeError(`${what} must be a string, got ${typeof text}`)
  if (text.includes('\u0000')) {
    const error = new Error(`${what} must not contain an embedded NUL`)
    error.code = 'WFP_STRING_INVALID'
    throw error
  }
  return Buffer.from(`${text}\u0000`, 'utf16le')
}

// ─────────────────────────── 纯结构构造 ───────────────────────────

/**
 * `FWP_VALUE0`。
 *
 * `[官方]`：`uint64` / `double64` / `byteArray16` / `byteBlob` / `sd` / `tokenAccessInformation` /
 * `unicodeString` 这些成员在并集里是**指针**，且官方对 `FWP_CONDITION_VALUE0` 明确写
 * "This value cannot be null"（`uint64` / `int64` / `double64` / `byteArray16` / `byteBlob` /
 * `tokenAccessInformation` / `unicodeString` / `byteArray6`）。
 * `uint8/uint16/uint32/int8/int16/int32/float` 是**按值内联**。
 *
 * 本函数按数据类型自动区分"内联"还是"指针"，并且：
 *   - 内联类型传了 `bigint`/对象 → 抛错（不静默转 0）；
 *   - 指针类型传了 `number`/`bigint` 之外的原始值（除 null）→ 抛错；
 *   - `FWP_EMPTY` 时并集必须为 0（构造出来就是全 0）。
 *
 * @returns {Buffer} 16 字节
 */
export function buildValue0({ type, value = null } = {}) {
  if (!Number.isInteger(type) || type < 0) {
    const error = new Error(`buildValue0: type must be a non-negative integer, got ${type}`)
    error.code = 'WFP_VALUE_TYPE_INVALID'
    throw error
  }
  const buffer = Buffer.alloc(FWP_VALUE0_SIZE)
  buffer.writeUInt32LE(type >>> 0, OFF_VALUE.type)

  const inline = {
    [FWP_DATA_TYPE.FWP_UINT8]: 'writeUInt8',
    [FWP_DATA_TYPE.FWP_UINT16]: 'writeUInt16LE',
    [FWP_DATA_TYPE.FWP_UINT32]: 'writeUInt32LE',
    [FWP_DATA_TYPE.FWP_INT8]: 'writeInt8',
    [FWP_DATA_TYPE.FWP_INT16]: 'writeInt16LE',
    [FWP_DATA_TYPE.FWP_INT32]: 'writeInt32LE',
    [FWP_DATA_TYPE.FWP_FLOAT]: 'writeFloatLE',
  }[type]

  if (type === FWP_DATA_TYPE.FWP_EMPTY) {
    if (value !== null && value !== undefined) {
      const error = new Error('buildValue0: FWP_EMPTY must not carry a value (the union must stay zeroed)')
      error.code = 'WFP_VALUE_TYPE_INVALID'
      throw error
    }
    return buffer
  }

  if (inline) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      const error = new Error(`buildValue0: data type ${type} is inline and needs a finite JS number, got ${typeof value}`)
      error.code = 'WFP_VALUE_TYPE_INVALID'
      throw error
    }
    buffer[inline](value, OFF_VALUE.value)
    return buffer
  }

  // 其余全是并集里的指针成员：写入偏移 8（uint64/int64/double64 在并集里也是**指针**）
  if (value === null || value === undefined) {
    const error = new Error(
      `buildValue0: data type ${type} is a pointer member and must not be null ` +
        '(官方 FWP_CONDITION_VALUE0 逐字要求 "This value cannot be null")',
    )
    error.code = 'WFP_VALUE_TYPE_INVALID'
    throw error
  }
  writePointer(buffer, OFF_VALUE.value, value)
  return buffer
}

/** `FWP_CONDITION_VALUE0`：与 `FWP_VALUE0` 同形（官方文档结构一致），复用同一实现并显式断言大小相同 */
export function buildConditionValue0(spec) {
  if (FWP_CONDITION_VALUE0_SIZE !== FWP_VALUE0_SIZE || OFF_CONDITION_VALUE.value !== OFF_VALUE.value) {
    const error = new Error('FWP_CONDITION_VALUE0 layout diverged from FWP_VALUE0 — layout constants are inconsistent')
    error.code = 'WFP_LAYOUT_INCONSISTENT'
    throw error
  }
  return buildValue0(spec)
}

/** `FWPM_DISPLAY_DATA0`：`{ wchar_t *name; wchar_t *description; }` */
export function buildDisplayData0({ name = null, description = null } = {}) {
  const buffer = Buffer.alloc(FWPM_DISPLAY_DATA0_SIZE)
  writePointer(buffer, OFF_DISPLAY_DATA.name, name)
  writePointer(buffer, OFF_DISPLAY_DATA.description, description)
  return buffer
}

/** `FWPM_ACTION0`：`{ FWP_ACTION_TYPE type; union { GUID filterType; GUID calloutKey; }; }` */
export function buildAction0({ type, filterType = null, calloutKey = null } = {}) {
  if (!Number.isInteger(type) || type < 0) {
    const error = new Error(`buildAction0: type must be a non-negative integer, got ${type}`)
    error.code = 'WFP_ACTION_INVALID'
    throw error
  }
  if (filterType && calloutKey) {
    const error = new Error('buildAction0: filterType and calloutKey are a union — only one may be set')
    error.code = 'WFP_ACTION_INVALID'
    throw error
  }
  const buffer = Buffer.alloc(FWPM_ACTION0_SIZE)
  buffer.writeUInt32LE(type >>> 0, OFF_ACTION.type)
  writeGuid(buffer, OFF_ACTION.filterTypeOrCalloutKey, filterType ?? calloutKey, 'action GUID')
  return buffer
}

/**
 * `FWPM_FILTER_CONDITION0`。
 *
 * @param {{fieldKey: string|Buffer, matchType: number, conditionValue: Buffer}} spec
 *   `conditionValue` 必须是 `buildConditionValue0()` 的产物（大小精确 16），
 *   本函数**不再**接受"裸值"，避免"谁负责分配"的歧义（手册 #8.1 同精神：所有权必须显式）。
 */
export function buildFilterCondition0({ fieldKey, matchType, conditionValue } = {}) {
  if (!Number.isInteger(matchType) || matchType < 0) {
    const error = new Error(`buildFilterCondition0: matchType must be a non-negative integer, got ${matchType}`)
    error.code = 'WFP_CONDITION_INVALID'
    throw error
  }
  if (!Buffer.isBuffer(conditionValue) || conditionValue.length !== FWP_CONDITION_VALUE0_SIZE) {
    const error = new Error(
      `buildFilterCondition0: conditionValue must be a ${FWP_CONDITION_VALUE0_SIZE}-byte Buffer from buildConditionValue0(), ` +
        `got ${Buffer.isBuffer(conditionValue) ? `${conditionValue.length} bytes` : typeof conditionValue}`,
    )
    error.code = 'WFP_CONDITION_INVALID'
    throw error
  }
  const buffer = Buffer.alloc(FWPM_FILTER_CONDITION0_SIZE)
  writeGuid(buffer, OFF_FILTER_CONDITION.fieldKey, fieldKey, 'condition fieldKey')
  buffer.writeUInt32LE(matchType >>> 0, OFF_FILTER_CONDITION.matchType)
  conditionValue.copy(buffer, OFF_FILTER_CONDITION.conditionValue)
  return buffer
}

/** 把条件数组拼成连续内存（`FWPM_FILTER0.filterCondition` 指向它，`numFilterConditions` 计数） */
export function buildFilterConditionArray(conditions) {
  if (!Array.isArray(conditions)) throw new TypeError('buildFilterConditionArray: conditions must be an array')
  const blocks = conditions.map((condition, index) => {
    if (!Buffer.isBuffer(condition) || condition.length !== FWPM_FILTER_CONDITION0_SIZE) {
      const error = new Error(
        `buildFilterConditionArray: element ${index} must be a ${FWPM_FILTER_CONDITION0_SIZE}-byte Buffer`,
      )
      error.code = 'WFP_CONDITION_INVALID'
      throw error
    }
    return condition
  })
  return { buffer: Buffer.concat(blocks), count: blocks.length }
}

/**
 * `FWPM_FILTER0`。
 *
 * 关键点（每一条都是"看起来能跑但其实没生效"的典型）：
 *   1. `numFilterConditions` 与 `filterCondition` **必须成对**：官方原文
 *      "If no conditions are specified, the action is always performed" ——
 *      即"忘了写条件"等于"无条件阻断/放行**所有**流量"，这是最危险的失败模式。
 *      因此本函数在不给条件时**要求显式 `allowUnconditional: true`**。
 *   2. `subLayerKey` 为 `IID_NULL` 时 filter 落进**默认 sublayer**；本项目**要求显式 sublayer**，
 *      否则无法整组删除（清理时会漏）。
 *   3. `effectiveWeight` / `filterId` 是 BFE 回填字段，添加时必须为 0。
 *   4. **`filterCondition` 是内嵌指针，本函数不会替你猜它的值。**
 *      阶段 B 实测缺陷：初版写成 `writePointer(buffer, OFF_FILTER.filterCondition, conditionBuffer)`，
 *      把一个 **Buffer** 当指针传进去 → `writePointer` 抛 `WFP_POINTER_INVALID`（`typeof Buffer === 'object'`）。
 *      根因不是笔误，而是"纯构造"与"内嵌指针"之间的契约缺失：`conditionBuffer` 是
 *      `Buffer.concat()` 出来的 **JS 堆内存**，Node 没有公开 API 能给出它的原生地址，
 *      所以 `buildFilter0` **无法**自己算出这个指针。因此现在要求调用方二选一：
 *        - `conditionPointer`：显式给地址（`bigint` / 非负 `number` / 带 `address()` 的对象）；
 *        - `pinConditionArray`：回调 `(conditionBuffer, count) => pointer`，
 *          运行期用 koffi 时就是 `(buf) => koffi.address(buf)`（`[实测]` koffi 3.3.2 提供 `address()`）。
 *      两者都不给且 `count > 0` → 抛 `WFP_CONDITION_POINTER_MISSING`（fail-closed）。
 *      **刻意不提供"写个假非零值占位"的退化路径**：假指针一旦真被送进 `FwpmFilterAdd0`，
 *      行为不可预测，而"看起来成功了但过滤器没生效"正是本项目最想避免的失败模式。
 */
export function buildFilter0(spec = {}) {
  const {
    filterKey = null,
    displayData,
    flags = 0,
    providerKey = null,
    providerData = null,
    layerKey,
    subLayerKey,
    weight,
    conditions = [],
    action,
    rawContext = null,
    allowUnconditional = false,
    conditionPointer = null,
    pinConditionArray = null,
  } = spec

  if (!Buffer.isBuffer(displayData) || displayData.length !== FWPM_DISPLAY_DATA0_SIZE) {
    const error = new Error(`buildFilter0: displayData must be a ${FWPM_DISPLAY_DATA0_SIZE}-byte Buffer from buildDisplayData0()`)
    error.code = 'WFP_FILTER_INVALID'
    throw error
  }
  if (!Buffer.isBuffer(action) || action.length !== FWPM_ACTION0_SIZE) {
    const error = new Error(`buildFilter0: action must be a ${FWPM_ACTION0_SIZE}-byte Buffer from buildAction0()`)
    error.code = 'WFP_FILTER_INVALID'
    throw error
  }
  if (!Buffer.isBuffer(weight) || weight.length !== FWP_VALUE0_SIZE) {
    const error = new Error(`buildFilter0: weight must be a ${FWP_VALUE0_SIZE}-byte Buffer from buildValue0()`)
    error.code = 'WFP_FILTER_INVALID'
    throw error
  }
  if (subLayerKey === null || subLayerKey === undefined) {
    const error = new Error(
      'buildFilter0: subLayerKey is required — a filter in the default sublayer cannot be removed as a group (IID_NULL maps to the default sublayer)',
    )
    error.code = 'WFP_FILTER_INVALID'
    throw error
  }
  const { buffer: conditionBuffer, count } = buildFilterConditionArray(conditions)
  if (count === 0 && allowUnconditional !== true) {
    const error = new Error(
      'buildFilter0: zero conditions means "the action is always performed" (官方原文) — pass allowUnconditional:true to mean it deliberately',
    )
    error.code = 'WFP_FILTER_UNCONDITIONAL_REFUSED'
    throw error
  }
  if (count > 0 && conditionBuffer.length !== count * FWPM_FILTER_CONDITION0_SIZE) {
    const error = new Error('buildFilter0: condition buffer size does not match the condition count')
    error.code = 'WFP_LAYOUT_INCONSISTENT'
    throw error
  }

  // 内嵌指针的解析：见函数头第 4 条。**必须在写缓冲区之前**决定，失败即抛（不留下半构造的 buffer）。
  let resolvedConditionPointer = null
  if (count > 0) {
    resolvedConditionPointer = conditionPointer
    if (resolvedConditionPointer === null || resolvedConditionPointer === undefined) {
      if (typeof pinConditionArray === 'function') {
        resolvedConditionPointer = pinConditionArray(conditionBuffer, count)
      }
    }
    if (resolvedConditionPointer === null || resolvedConditionPointer === undefined) {
      const error = new Error(
        `buildFilter0: ${count} condition(s) were supplied, so FWPM_FILTER0.filterCondition must point at ` +
          'their native memory — but no pointer was given. Pass conditionPointer (an explicit address) or ' +
          'pinConditionArray (a (buffer, count) => pointer callback, e.g. (b) => koffi.address(b)). ' +
          'This module will not invent a placeholder pointer: a bogus pointer handed to FwpmFilterAdd0 ' +
          'fails unpredictably, and "looks like it worked but the filter is not active" is the worst outcome here.',
      )
      error.code = 'WFP_CONDITION_POINTER_MISSING'
      throw error
    }
    if (Buffer.isBuffer(resolvedConditionPointer)) {
      // 阶段 B 实测缺陷的**永久回归断言**：Buffer 是 JS 堆内存，不是地址。
      const error = new Error(
        'buildFilter0: conditionPointer must be an address (bigint / non-negative number / object with address()), ' +
          'not a Buffer. A Buffer has no exposed native address in Node, so passing one is always a bug.',
      )
      error.code = 'WFP_POINTER_INVALID'
      throw error
    }
  }

  const buffer = Buffer.alloc(FWPM_FILTER0_SIZE)
  writeGuid(buffer, OFF_FILTER.filterKey, filterKey, 'filterKey')
  displayData.copy(buffer, OFF_FILTER.displayData)
  buffer.writeUInt32LE(flags >>> 0, OFF_FILTER.flags)
  writeGuid(buffer, OFF_FILTER.providerKey, providerKey, 'providerKey')
  if (providerData !== null && providerData !== undefined) {
    if (!Buffer.isBuffer(providerData) || providerData.length !== FWP_BYTE_BLOB_SIZE) {
      const error = new Error(`buildFilter0: providerData must be a ${FWP_BYTE_BLOB_SIZE}-byte Buffer from buildByteBlob()`)
      error.code = 'WFP_FILTER_INVALID'
      throw error
    }
    providerData.copy(buffer, OFF_FILTER.providerData)
  }
  writeGuid(buffer, OFF_FILTER.layerKey, layerKey, 'layerKey')
  writeGuid(buffer, OFF_FILTER.subLayerKey, subLayerKey, 'subLayerKey')
  weight.copy(buffer, OFF_FILTER.weight)
  buffer.writeUInt32LE(count >>> 0, OFF_FILTER.numFilterConditions)
  if (count > 0) writePointer(buffer, OFF_FILTER.filterCondition, resolvedConditionPointer)
  action.copy(buffer, OFF_FILTER.action)
  writePointer(buffer, OFF_FILTER.rawContextOrProviderContextKey, rawContext)
  // reserved / filterId / effectiveWeight 由 BFE 使用，添加时必须为 0（alloc 已置零）

  return { buffer, count, conditions: conditionBuffer, conditionPointer: resolvedConditionPointer }
}

/** `FWPM_SUBLAYER0`。`displayData.name` 官方标为 required（`FwpmSubLayerAdd0` 样例同时给了 name 与 description） */
export function buildSubLayer0(spec = {}) {
  const { subLayerKey = null, displayData, flags = 0, providerKey = null, providerData = null, weight = 0x100 } = spec
  if (!Buffer.isBuffer(displayData) || displayData.length !== FWPM_DISPLAY_DATA0_SIZE) {
    const error = new Error(`buildSubLayer0: displayData must be a ${FWPM_DISPLAY_DATA0_SIZE}-byte Buffer from buildDisplayData0()`)
    error.code = 'WFP_SUBLAYER_INVALID'
    throw error
  }
  if (!Number.isInteger(weight) || weight < 0 || weight > 0xffff) {
    const error = new Error(`buildSubLayer0: weight must be a UINT16 (0..65535), got ${weight}`)
    error.code = 'WFP_SUBLAYER_INVALID'
    throw error
  }
  if ((flags & FWPM_SUBLAYER_FLAG_PERSISTENT) !== 0) {
    const error = new Error(
      'buildSubLayer0: FWPM_SUBLAYER_FLAG_PERSISTENT is refused — a persistent sublayer survives BFE restart and is a state leak across sessions',
    )
    error.code = 'WFP_SUBLAYER_PERSISTENT_REFUSED'
    throw error
  }
  const buffer = Buffer.alloc(FWPM_SUBLAYER0_SIZE)
  writeGuid(buffer, OFF_SUBLAYER.subLayerKey, subLayerKey, 'subLayerKey')
  displayData.copy(buffer, OFF_SUBLAYER.displayData)
  buffer.writeUInt32LE(flags >>> 0, OFF_SUBLAYER.flags)
  writeGuid(buffer, OFF_SUBLAYER.providerKey, providerKey, 'providerKey')
  if (providerData !== null && providerData !== undefined) {
    if (!Buffer.isBuffer(providerData) || providerData.length !== FWP_BYTE_BLOB_SIZE) {
      const error = new Error(`buildSubLayer0: providerData must be a ${FWP_BYTE_BLOB_SIZE}-byte Buffer`)
      error.code = 'WFP_SUBLAYER_INVALID'
      throw error
    }
    providerData.copy(buffer, OFF_SUBLAYER.providerData)
  }
  buffer.writeUInt16LE(weight, OFF_SUBLAYER.weight)
  return buffer
}

/**
 * `FWPM_SESSION0`。
 *
 * 本项目固定用 `FWPM_SESSION_FLAG_DYNAMIC`：会话结束自动删对象，
 * **绝不留下跨会话存活的过滤器**。其余字段留 0 —— 官方明确
 * `processId` / `sid` / `username` / `kernelMode` 由 BFE 填写，不由客户端提供。
 */
export function buildSession0({ flags = FWPM_SESSION_FLAG_DYNAMIC, txnWaitTimeoutInMSec = 0 } = {}) {
  if ((flags & ~FWPM_SESSION_FLAG_DYNAMIC) !== 0) {
    const error = new Error(
      `buildSession0: only FWPM_SESSION_FLAG_DYNAMIC is supported here, got flags=0x${(flags >>> 0).toString(16)}`,
    )
    error.code = 'WFP_SESSION_INVALID'
    throw error
  }
  if (!Number.isInteger(txnWaitTimeoutInMSec) || txnWaitTimeoutInMSec < 0) {
    const error = new Error(`buildSession0: txnWaitTimeoutInMSec must be a non-negative integer`)
    error.code = 'WFP_SESSION_INVALID'
    throw error
  }
  const buffer = Buffer.alloc(FWPM_SESSION0_SIZE)
  buffer.writeUInt32LE(flags >>> 0, OFF_SESSION.flags)
  buffer.writeUInt32LE(txnWaitTimeoutInMSec >>> 0, OFF_SESSION.txnWaitTimeoutInMSec)
  return buffer
}

/** `FWP_BYTE_BLOB`：`{ UINT32 size; UINT8 *data; }`（`data` 由调用方持有生命周期） */
export function buildByteBlob({ size, data }) {
  if (!Number.isInteger(size) || size < 0) {
    const error = new Error(`buildByteBlob: size must be a non-negative integer, got ${size}`)
    error.code = 'WFP_BYTE_BLOB_INVALID'
    throw error
  }
  if (size > 0 && (data === null || data === undefined)) {
    const error = new Error('buildByteBlob: size > 0 requires a non-null data pointer')
    error.code = 'WFP_BYTE_BLOB_INVALID'
    throw error
  }
  const buffer = Buffer.alloc(FWP_BYTE_BLOB_SIZE)
  buffer.writeUInt32LE(size >>> 0, OFF_BYTE_BLOB.size)
  writePointer(buffer, OFF_BYTE_BLOB.data, size > 0 ? data : null)
  return buffer
}

// ─────────────────────────── 规则计划（纯函数）───────────────────────────

/** 由命名空间 + 名字派生确定性规则 key：同一条规则重复添加可被识别（幂等） */
export function stableRuleKey(namespace, name) {
  if (typeof namespace !== 'string' || namespace.length === 0) throw new TypeError('stableRuleKey: namespace must be a non-empty string')
  if (typeof name !== 'string' || name.length === 0) throw new TypeError('stableRuleKey: name must be a non-empty string')
  const digest = createHash('sha1').update(`${namespace}\u0000${name}`).digest()
  // 设置 RFC 4122 variant/version 位，避免生成"看起来像 GUID 但不是"的东西
  digest[6] = (digest[6] & 0x0f) | 0x50
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.subarray(0, 16).toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** 网络档位（手册第 9 章）：本模块只实现 OFFLINE 的硬阻断计划 */
export const NETWORK_TIERS = Object.freeze(['OFFLINE', 'CONTROLLED_ONLINE', 'OBSERVED_ONLINE'])

/** 需要下阻断 filter 的层（语义键名；GUID 由 config.guids 提供） */
export const OFFLINE_LAYER_KEYS = Object.freeze([
  'ALE_AUTH_CONNECT_V4',
  'ALE_AUTH_CONNECT_V6',
  'ALE_AUTH_RECV_ACCEPT_V4',
  'ALE_AUTH_RECV_ACCEPT_V6',
  'ALE_AUTH_LISTEN_V4',
  'ALE_AUTH_LISTEN_V6',
])

/** 条件键名（语义键名；GUID 由 config.guids 提供） */
export const CONDITION_KEYS = Object.freeze(['ALE_PACKAGE_ID', 'ALE_APP_ID'])

/** 匹配目标的选择：按 AppContainer 包 SID（推荐）或按应用路径（近似） */
export const MATCH_TARGETS = Object.freeze(['appcontainer', 'app-identifier'])

/**
 * 生成 OFFLINE 档位的**纯计划**（不调用任何 Win32）。
 *
 * 为什么"计划"要与"执行"分开：计划是完全确定的纯数据，可以在无管理员、无 WFP 的会话里
 * 逐字段验证（层数、条件键、动作、是否漏了 IPv6、是否漏了 listen）。执行层只负责把计划喂给 BFE。
 *
 * @param {{tier: 'OFFLINE', target: 'appcontainer'|'app-identifier', guids: object}} options
 * @returns {{tier: string, target: string, subLayerKey: string, filters: Array<object>, warnings: string[]}}
 */
export function planOfflineRules(options = {}) {
  const { tier = 'OFFLINE', target = 'appcontainer', guids = {} } = options
  if (!NETWORK_TIERS.includes(tier)) {
    const error = new Error(`planOfflineRules: unknown network tier ${JSON.stringify(tier)}`)
    error.code = 'WFP_TIER_INVALID'
    throw error
  }
  if (!MATCH_TARGETS.includes(target)) {
    const error = new Error(`planOfflineRules: unknown match target ${JSON.stringify(target)}`)
    error.code = 'WFP_TARGET_INVALID'
    throw error
  }
  if (tier !== 'OFFLINE') {
    const error = new Error(
      `planOfflineRules: tier ${tier} is not implemented — only OFFLINE is a hard block. ` +
        'CONTROLLED_ONLINE/OBSERVED_ONLINE require an allow-list model and are NOT implemented here (manual §9.1).',
    )
    error.code = 'WFP_TIER_NOT_IMPLEMENTED'
    throw error
  }

  const conditionKey = target === 'appcontainer' ? 'ALE_PACKAGE_ID' : 'ALE_APP_ID'
  const missing = []
  if (!guids[conditionKey]) missing.push(conditionKey)
  for (const layer of OFFLINE_LAYER_KEYS) if (!guids[layer]) missing.push(layer)
  if (missing.length > 0) {
    const error = new Error(
      `WFP_GUIDS_MISSING: no GUID literals are embedded in this module (no Windows SDK on this host); ` +
        `the caller must supply them. Missing: ${missing.join(', ')}`,
    )
    error.code = 'WFP_GUIDS_MISSING'
    error.missing = missing
    throw error
  }

  const subLayerKey = stableRuleKey('dsh-stage/wfp', `sublayer/${tier}/${target}`)
  const filters = OFFLINE_LAYER_KEYS.map((layer) => ({
    key: stableRuleKey('dsh-stage/wfp', `filter/${tier}/${target}/${layer}`),
    layerKey: layer,
    conditionKey,
    matchType: FWP_MATCH_TYPE.FWP_MATCH_EQUAL,
    action: FWP_ACTION_TYPE.FWP_ACTION_BLOCK,
    description: `dsh-stage OFFLINE: block ${layer} for ${conditionKey}`,
  }))

  const warnings = []
  if (target === 'app-identifier') {
    warnings.push(
      'target=app-identifier matches by executable path (FWPM_CONDITION_ALE_APP_ID). ' +
        'It misses a renamed/copied copy of the same binary and can affect unrelated processes ' +
        'that run the same executable. WFP has NO process-id or restricted-SID condition key, ' +
        'so this is the only approximation available for the T1 (restricted-token) tier.',
    )
  }
  warnings.push(
    'The ALE layer set covers connect/recv-accept/listen. Traffic already established before the ' +
      'filters were added is NOT re-evaluated by a block filter at ALE_AUTH_CONNECT (official: ALE ' +
      'authorizes on the first packet / connection). Treat "blocked" as verified only by an ' +
      'attacker probe launched from inside the sandbox AFTER the filters are installed.',
  )
  if (ACTION_TYPE_PROVISIONAL) {
    warnings.push(
      `FWP_ACTION_* values (BLOCK=0x${FWP_ACTION_TYPE.FWP_ACTION_BLOCK.toString(16)}) are provisional: ` +
        'the official page gives the composite expression but not the flag bit values, and no Windows ' +
        'SDK header is available on this host to confirm them.',
    )
  }
  return { tier, target, subLayerKey, filters, warnings }
}

// ─────────────────────────── 调用层 ───────────────────────────

function wfpError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  Object.assign(error, extra)
  return error
}

/** WFP 错误码 → 人可读文本（只翻译本项目会遇到的几个；其余原样回报，不猜） */
export function describeWfpStatus(status) {
  const value = status >>> 0
  const table = {
    0x00000000: 'ERROR_SUCCESS',
    0x00000005: 'ERROR_ACCESS_DENIED (FWPM_ACTRL_OPEN / FWPM_ACTRL_ADD 不足，或需要管理员)',
    0x00000032:
      'ERROR_NOT_SUPPORTED (阶段 B 实测的**确切**成因：authnService 传了 RPC_C_AUTHN_NONE(0)。' +
      '官方只允许 RPC_C_AUTHN_WINNT / RPC_C_AUTHN_DEFAULT，两者在本机都返回 0。' +
      '与"WFP 需要管理员"无关，与 BFE 是否运行也无关 —— BFE 实测 RUNNING)',
    0x00000057: 'ERROR_INVALID_PARAMETER',
    0x000006b5: 'EPT_S_NOT_REGISTERED (RPC 端点不可用；常见于 BFE 服务未运行)',
    0x80320003: 'FWP_E_ALREADY_EXISTS',
    0x80320007: 'FWP_E_FILTER_NOT_FOUND',
    0x80320008: 'FWP_E_LAYER_NOT_FOUND (常见根因：layer GUID 字节序写错或该层不存在)',
    0x80320009: 'FWP_E_ALREADY_EXISTS (sessionKey 重复)',
    0x8032000a: 'FWP_E_SUBLAYER_NOT_FOUND',
    0x8032000b: 'FWP_E_NOT_FOUND',
    0x80320010: 'FWP_E_INCOMPATIBLE_TXN (只读事务中不可调用)',
  }
  return table[value] ?? `unknown/undocumented WFP status 0x${value.toString(16)}`
}

/**
 * 探测 WFP 是否可用：真实调用 `FwpmEngineOpen0` + `FwpmEngineClose0`。
 *
 * **不降级**：失败就如实回报 `0x……` 原始码，绝不返回"可用"。
 * @param {{fwpmEngineOpen0: Function, fwpmEngineClose0: Function}} api 低层绑定表
 */
export function probeWfpAvailability(api) {
  if (!api || typeof api.fwpmEngineOpen0 !== 'function') {
    return { available: false, detail: 'binding table has no fwpmEngineOpen0' }
  }
  // 两种调用约定都要支持（本仓库在用 Koffi，低层表是 `func()` 直接返回值，
  // 出参用数组槽位；但替身/未来绑定可能返回 {status, handle}）。这里**显式**区分，
  // 而不是"猜一个"：先看返回值形状，再看槽位。
  const slot = [null]
  let returned
  try {
    returned = api.fwpmEngineOpen0(null, RPC_C_AUTHN_WINNT, null, null, slot)
  } catch (error) {
    return { available: false, detail: `FwpmEngineOpen0 threw: ${error.message}` }
  }
  let status
  let engine
  if (returned !== null && typeof returned === 'object' && ('status' in returned || 'handle' in returned)) {
    status = (returned.status ?? 0) >>> 0
    engine = returned.handle ?? null
  } else {
    status = (typeof returned === 'number' ? returned : 0) >>> 0
    engine = slot[0] ?? null
  }
  if (status !== 0 || !engine) {
    return {
      available: false,
      status: status >>> 0,
      detail: `FwpmEngineOpen0 -> 0x${(status >>> 0).toString(16)} (${status >>> 0}): ${describeWfpStatus(status)}`,
    }
  }
  try {
    if (typeof api.fwpmEngineClose0 === 'function') api.fwpmEngineClose0(engine)
  } catch {
    /* 关闭失败不影响"可用"判定，但调用方应记录 */
  }
  return { available: true, status: 0, detail: 'FwpmEngineOpen0 succeeded and the engine was closed again' }
}

/**
 * 打开一个 WFP 会话语义的对象。
 *
 * `session` 固定为 `FWPM_SESSION_FLAG_DYNAMIC`（见 `buildSession0`）。
 * 失败即抛 `WFP_UNAVAILABLE`，**不返回半可用对象**。
 *
 * @param {object} api 低层绑定表：`fwpmEngineOpen0(serverName, authnService, authIdentity, sessionPtr)`、
 *   `fwpmEngineClose0(handle)`
 */
export function openEngine(api) {
  if (!api || typeof api.fwpmEngineOpen0 !== 'function') {
    throw wfpError('WFP_UNAVAILABLE', 'binding table has no fwpmEngineOpen0; refusing to pretend the network is blocked')
  }
  const sessionBuffer = buildSession0({})
  let engine
  const slot = [null]
  try {
    engine = api.fwpmEngineOpen0(null, RPC_C_AUTHN_WINNT, null, sessionBuffer, slot)
  } catch (error) {
    throw wfpError('WFP_UNAVAILABLE', `FwpmEngineOpen0 threw: ${error.message}`, { cause: error })
  }
  let status
  let handle
  if (engine !== null && typeof engine === 'object' && ('status' in engine || 'handle' in engine)) {
    status = ((engine.status ?? 0) >>> 0)
    handle = engine.handle ?? null
  } else {
    status = (typeof engine === 'number' ? engine : 0) >>> 0
    handle = slot[0] ?? null
  }
  if (status !== 0 || !handle) {
    throw wfpError('WFP_UNAVAILABLE', `FwpmEngineOpen0 -> 0x${status.toString(16)}: ${describeWfpStatus(status)}`, {
      wfpStatus: status,
    })
  }
  return {
    handle,
    sessionBuffer,
    /** 关闭引擎（幂等；失败只记录不抛，因为此时已无补救手段） */
    close() {
      const failures = []
      try {
        if (typeof api.fwpmEngineClose0 === 'function') {
          const rc = api.fwpmEngineClose0(handle)
          if (((rc ?? 0) >>> 0) !== 0) failures.push(`FwpmEngineClose0 -> 0x${(rc >>> 0).toString(16)}`)
        } else {
          failures.push('binding table has no fwpmEngineClose0')
        }
      } catch (error) {
        failures.push(`FwpmEngineClose0 threw: ${error.message}`)
      }
      return { failures }
    },
  }
}

/** 安装 sublayer；`FWP_E_ALREADY_EXISTS`(0x80320003) 视为幂等成功 */
export function installSubLayer(api, engineHandle, subLayerBuffer) {
  if (!Buffer.isBuffer(subLayerBuffer) || subLayerBuffer.length !== FWPM_SUBLAYER0_SIZE) {
    throw wfpError('WFP_SUBLAYER_INVALID', `subLayer must be a ${FWPM_SUBLAYER0_SIZE}-byte Buffer from buildSubLayer0()`)
  }
  const status = (api.fwpmSubLayerAdd0(engineHandle, subLayerBuffer, null) ?? 0) >>> 0
  if (status === 0 || status === 0x80320003) return { status, idempotent: status === 0x80320003 }
  throw wfpError('WFP_SUBLAYER_ADD_FAILED', `FwpmSubLayerAdd0 -> 0x${status.toString(16)}: ${describeWfpStatus(status)}`, {
    wfpStatus: status,
  })
}

/** 添加 filter；返回 BFE 分配的 filterId（**必须回读核对**，不能只看返回值） */
export function addFilter(api, engineHandle, filterBuffer) {
  if (!Buffer.isBuffer(filterBuffer) || filterBuffer.length !== FWPM_FILTER0_SIZE) {
    throw wfpError('WFP_FILTER_INVALID', `filter must be a ${FWPM_FILTER0_SIZE}-byte Buffer from buildFilter0()`)
  }
  const out = { id: null, status: 0 }
  const status = (api.fwpmFilterAdd0(engineHandle, filterBuffer, null, out) ?? 0) >>> 0
  if (status !== 0) {
    throw wfpError('WFP_FILTER_ADD_FAILED', `FwpmFilterAdd0 -> 0x${status.toString(16)}: ${describeWfpStatus(status)}`, {
      wfpStatus: status,
    })
  }
  // 阶段 B 实测缺陷：初版只看返回值就认为"装上了"。`FwpmFilterAdd0` 的 `id` 是 **OUT** 参数，
  // 而 filterId 是**唯一**的删除凭据（`FwpmFilterDeleteById0` 只按 id 删）。
  // 没有 id 就等于"装了一个删不掉的过滤器" —— 回滚保证在此处静默失效，
  // 而且下游会以 `BigInt(null)` 的 TypeError 形式爆出来（看不出根因）。
  if (out.id === null || out.id === undefined) {
    throw wfpError(
      'WFP_FILTER_ID_MISSING',
      'FwpmFilterAdd0 reported success but returned no filterId. filterId is the only handle FwpmFilterDeleteById0 ' +
        'accepts, so the filter could never be rolled back — refusing to treat this as a successful install.',
    )
  }
  return { status, filterId: out.id }
}

/** 删除 filter（幂等：`FWP_E_FILTER_NOT_FOUND` 视为成功；其它错误码一律上抛） */
export function deleteFilterById(api, engineHandle, filterId) {
  const status = (api.fwpmFilterDeleteById0(engineHandle, BigInt(filterId)) ?? 0) >>> 0
  if (status === 0 || status === 0x80320007) return { status, idempotent: status !== 0 }
  throw wfpError('WFP_FILTER_DELETE_FAILED', `FwpmFilterDeleteById0 -> 0x${status.toString(16)}: ${describeWfpStatus(status)}`, {
    wfpStatus: status,
  })
}

/** 删除 sublayer（幂等：`FWP_E_SUBLAYER_NOT_FOUND` 视为成功） */
export function deleteSubLayerByKey(api, engineHandle, subLayerKey) {
  const status = (api.fwpmSubLayerDeleteByKey0(engineHandle, coerceGuid(subLayerKey, 'subLayerKey')) ?? 0) >>> 0
  if (status === 0 || status === 0x8032000a) return { status, idempotent: status !== 0 }
  throw wfpError('WFP_SUBLAYER_DELETE_FAILED', `FwpmSubLayerDeleteByKey0 -> 0x${status.toString(16)}: ${describeWfpStatus(status)}`, {
    wfpStatus: status,
  })
}

/**
 * 把一份 `planOfflineRules()` 计划真正装到 BFE 上。
 *
 * 顺序刻意如此：先建 sublayer，再逐个加 filter；**每个 filter 加完记录 filterId**，
 * 任何一步失败就**逆序回滚已装的东西**（fail-closed，不留半套过滤器）。
 * 注意：动态会话本身也会在 `close()` 时清理，但"显式回滚"与"依赖会话清理"是两件事，
 * 前者能在同一进程内继续运行时立刻恢复网络，后者要等进程退出。
 *
 * @param {object} api 低层绑定表（含 `fwpmSubLayerAdd0` / `fwpmFilterAdd0` / `fwpmFilterDeleteById0` / `fwpmSubLayerDeleteByKey0`）
 * @param {object} engine `openEngine()` 的产物
 * @param {object} plan `planOfflineRules()` 的产物
 * @param {object} guids 语义键名 → GUID 文本/Buffer
 * @param {(target: unknown, pointer: unknown) => unknown} [retainPointer] 生命周期托管回调
 *   （把 `build*` 产物登记到调用方的"活到 API 返回为止"容器里；本函数不假设 GC 行为）
 * @param {(buffer: Buffer) => unknown} [pin] **必需**：把一个 JS Buffer 的原生地址返回给本函数，
 *   用来填写三个**内嵌指针**：`FWPM_FILTER0.filterCondition`（条件数组）、
 *   `FWPM_DISPLAY_DATA0.name` / `.description`（宽字符串）、`FWPM_SUBLAYER0.displayData`。
 *   运行期用 koffi 时传 `(buffer) => koffi.address(buffer)`
 *   （`[实测]` koffi 3.3.2 提供 `address()` 且返回 bigint；见 `.t/sbx3/dev/raw-probe-koffi.txt`）。
 *   也可以只把它挂在绑定表上（`api.pin`），本函数会自动取用。
 *   缺失即抛 `WFP_PIN_REQUIRED`，且**在安装 sublayer 之前**抛 —— 不允许"改了一半状态才发现没法构造 filter"。
 */
export function applyOfflinePlan(api, engine, plan, guids, retainPointer = () => {}, pin = null) {
  if (!engine || !engine.handle) throw wfpError('WFP_UNAVAILABLE', 'applyOfflinePlan requires an open engine')
  if (!plan || plan.tier !== 'OFFLINE') {
    throw wfpError('WFP_TIER_NOT_IMPLEMENTED', 'applyOfflinePlan only implements the OFFLINE tier')
  }
  // 回滚能力必须在**改任何状态之前**确认：否则"装了一半发现删不掉"是最坏的结果。
  for (const required of ['fwpmSubLayerAdd0', 'fwpmFilterAdd0', 'fwpmFilterDeleteById0', 'fwpmSubLayerDeleteByKey0']) {
    if (typeof api[required] !== 'function') {
      throw wfpError(
        'WFP_UNAVAILABLE',
        `binding table lacks ${required}; refusing to install filters that could not be rolled back`,
      )
    }
  }
  // 内嵌指针的来源也必须在**改任何状态之前**确认（同一条 fail-closed 理由）。
  // 允许绑定表自带 `pin`（与 appcontainer-runtime 的 `bindings.pin` 同一约定），
  // 这样 koffi 绑定层只需在一处声明 `(b) => koffi.address(b)`。
  const resolvedPin = typeof pin === 'function' ? pin : typeof api?.pin === 'function' ? api.pin : null
  if (typeof resolvedPin !== 'function') {
    throw wfpError(
      'WFP_PIN_REQUIRED',
      'applyOfflinePlan requires pin(buffer) -> native address (or a pin function on the binding table). ' +
        'FWPM_FILTER0.filterCondition, FWPM_DISPLAY_DATA0.name/description and FWPM_SUBLAYER0.displayData are all ' +
        'embedded pointers that cannot be derived from a JS Buffer. With koffi pass (b) => koffi.address(b).',
    )
  }
  const installed = { filters: [], subLayerKey: plan.subLayerKey }
  const keep = (buffer) => {
    retainPointer('wfp', buffer)
    return buffer
  }
  /**
   * 把一段文本放进原生内存并返回它的地址。
   *
   * 阶段 B 实测缺陷：初版 `applyOfflinePlan` 直接写
   * `buildDisplayData0({ name: 'dsh-stage', description: '…' })`，
   * 而 `buildDisplayData0` 要的是**指针**（`wchar_t*`），于是 `writePointer` 抛
   * `WFP_POINTER_INVALID: cannot encode pointer of type string at offset 0`。
   * 这条路径此前从未被执行过（阶段 A 只静态检查过），所以缺陷一直没暴露。
   */
  const pinWideString = (text, what) => resolvedPin(keep(encodeWideString(text, what)))

  try {
    const subLayer = keep(
      buildSubLayer0({
        subLayerKey: plan.subLayerKey,
        displayData: keep(
          buildDisplayData0({
            name: pinWideString('dsh-stage', 'sublayer displayData.name'),
            description: pinWideString('dsh-stage network isolation sublayer', 'sublayer displayData.description'),
          }),
        ),
        weight: 0x100,
      }),
    )
    installSubLayer(api, engine.handle, subLayer)

    for (const rule of plan.filters) {
      const layerGuid = guids[rule.layerKey]
      const conditionGuid = guids[rule.conditionKey]
      const targetValue = guids.targetValue
      if (!layerGuid) throw wfpError('WFP_GUIDS_MISSING', `missing layer GUID for ${rule.layerKey}`)
      if (!conditionGuid) throw wfpError('WFP_GUIDS_MISSING', `missing condition GUID for ${rule.conditionKey}`)
      if (targetValue === undefined || targetValue === null) {
        throw wfpError(
          'WFP_TARGET_VALUE_MISSING',
          `guids.targetValue is required: the SID pointer (target=appcontainer) or the ALE_APP_ID blob pointer (target=app-identifier)`,
        )
      }
      const conditionValueType =
        plan.target === 'appcontainer' ? FWP_DATA_TYPE.FWP_SID : FWP_DATA_TYPE.FWP_BYTE_BLOB_TYPE
      const condition = keep(
        buildFilterCondition0({
          fieldKey: conditionGuid,
          matchType: rule.matchType,
          conditionValue: keep(buildConditionValue0({ type: conditionValueType, value: targetValue })),
        }),
      )
      const filter = keep(
        buildFilter0({
          filterKey: rule.key,
          displayData: keep(
            buildDisplayData0({
              name: pinWideString(rule.key, 'filter displayData.name'),
              description: pinWideString(rule.description, 'filter displayData.description'),
            }),
          ),
          layerKey: layerGuid,
          subLayerKey: plan.subLayerKey,
          weight: keep(buildValue0({ type: FWP_DATA_TYPE.FWP_EMPTY })),
          conditions: [condition],
          action: keep(buildAction0({ type: rule.action })),
          pinConditionArray: (buffer) => resolvedPin(buffer),
        }),
      )
      const { filterId } = addFilter(api, engine.handle, filter.buffer)
      installed.filters.push({ key: rule.key, layerKey: rule.layerKey, filterId })
    }
    return installed
  } catch (error) {
    // 逆序回滚：先删 filter，再删 sublayer。回滚自身的失败必须一并报告，不能掩盖原错误。
    const rollbackFailures = []
    for (const item of [...installed.filters].reverse()) {
      try {
        deleteFilterById(api, engine.handle, item.filterId)
      } catch (rollbackError) {
        rollbackFailures.push(rollbackError.message)
      }
    }
    try {
      deleteSubLayerByKey(api, engine.handle, plan.subLayerKey)
    } catch (rollbackError) {
      rollbackFailures.push(rollbackError.message)
    }
    error.rollbackFailures = rollbackFailures
    throw error
  }
}

export const __internal = { writeGuid, wfpError }
