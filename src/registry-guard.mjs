/**
 * registry-guard —— 注册表隔离 / 快照 / 差异检测（**检测优先，不假装是硬边界**）
 *
 * ── 方案选择与诚实定位（方案对比见 `.t/sbx3/dev/00-现状与设计.md` §3）────────
 * 三个候选：
 *   ① AppContainer 天然受限（注册表被包 SID 管控）—— 最理想。阶段 A `[实测]`
 *      `CreateAppContainerProfile` = `E_ACCESSDENIED` 故判"不可用"；
 *      **阶段 B 更正**：宿主换成 High IL 管理员令牌后 `CreateAppContainerProfile` **成功**
 *      （`hr=0x0`，包 SID `S-1-15-2-…`，用完即删；原始输出 `.t/sbx3/dev/raw-probe-appcontainer-runtime.txt`）。
 *      但另有**阻断性发现**：用 `SECURITY_CAPABILITIES` 属性列表创建出来的进程
 *      **并不在 AppContainer 里**（子进程 `whoami /all` = 完整管理员 + High IL、无包 SID；
 *      原始输出 `.t/sbx3/dev/raw-probe-ac-token.txt`）。⇒ 在 T0 真正生效之前，
 *      **① 仍不能当作可用的硬边界**，本模块继续以 ② 为默认；
 *   ② **执行前快照 + 执行后差异检测 + 可选回滚** —— 本模块实现的默认方案；
 *   ③ 按 SID 的注册表 ACL（`RegSetKeySecurity`）—— 需要 `WRITE_DAC`，HKLM 需管理员，
 *      且**改坏 ACL 会让系统组件失效**；本模块只提供**计划**（`planAclRestriction`），
 *      **绝不自动执行**。
 *
 * **②的定位必须说清楚**：它**不阻止**写入，它把"看不见的写入"变成"可见且可回滚的差异"。
 * 真正的硬阻断只有 ①（本机不可用）或 ③（需管理员 + 高风险）。任何把 ② 说成"注册表已被隔离"
 * 的表述都是粉饰。这与手册 #16.10「无法消除的残余要写进文档」一致。
 *
 * ── 可离线测试的关键设计 ──────────────────────────────────────────────────────
 * "读注册表"被抽象成可注入的 `reader`，因此：
 *   - 运行期 reader 走 Koffi/`reg.exe`/PowerShell；
 *   - 离线测试注入**确定性替身**（逐字段对齐真实语义，且不"更好用"——例如它同样模拟
 *     `RegOpenKeyExW` 返回 2 时"键不存在"与返回 5 时"拒绝访问"是**两种不同结果**）。
 * 归一化（`normalizeSnapshot`）、差异（`diffSnapshots`）、回滚计划（`planRollback`）、
 * 注册表路径解析（`hiveRoot`）全是**纯函数**，因此差异算法与偏移无关、与权限无关地可验证。
 *
 * 官方/文档依据：
 *   Registry Value Types      https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-value-types
 *   RegOpenKeyExW             https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regopenkeyexw
 *   RegQueryValueExW          https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regqueryvalueexw
 *   RegEnumKeyExW             https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regenumkeyexw
 *   RegSetKeySecurity         https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regsetkeysecurity
 *   Registry Key Security and Access Rights
 *                             https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-key-security-and-access-rights
 */

import { Buffer } from 'node:buffer'

// ─────────────────────────── 常量 ───────────────────────────

/** `[官方]` 预定义根键句柄（`winreg.h` 的固定值，不是"随便取的指针"） */
export const HIVE_HANDLES = Object.freeze({
  HKCR: 0x80000000n,
  HKEY_CLASSES_ROOT: 0x80000000n,
  HKCU: 0x80000001n,
  HKEY_CURRENT_USER: 0x80000001n,
  HKLM: 0x80000002n,
  HKEY_LOCAL_MACHINE: 0x80000002n,
  HKU: 0x80000003n,
  HKEY_USERS: 0x80000003n,
  HKPD: 0x80000004n,
  HKEY_PERFORMANCE_DATA: 0x80000004n,
  HKCC: 0x80000005n,
  HKEY_CURRENT_CONFIG: 0x80000005n,
})

/**
 * 长名 → 短名（`HKxx`）。
 *
 * 阶段 B 实测缺陷：初版 `parseRegistryPath` 用
 * `head.startsWith('HKEY_') ? head.slice(5) : head` 归一化，于是
 * `HKLM\X` → `hive='HKLM'`，而 `HKEY_LOCAL_MACHINE\X` → `hive='LOCAL_MACHINE'`。
 * 两处后果都是真实的：
 *   1. `canonical` 是快照的 `root` 键（见 `normalizeSnapshot` / `serializeSnapshot`）。
 *      同一个注册表位置用两种写法就会得到两个不同的 `root` ⇒ 两次快照**永远比不相等** ⇒
 *      "什么都没变" 的假阴性（这正是本模块开头警告的那一类失效）。
 *   2. `planAclRestriction` / `planRollback` 里的 `hive === 'HKLM'`、`hive !== 'HKCU'`
 *      是按短名写的 ⇒ 用全名传入时会**静默漏掉** `needsElevation`（HKLM 少报管理员需求）
 *      或**误报**（HKCU 被当成需要管理员）。
 * 修法：`hive` 固定为短名集合 `{HKCR,HKCU,HKLM,HKU,HKPD,HKCC}`，全名与短名都映射到同一个。
 */
const SHORT_BY_LONG = Object.freeze({
  HKEY_CLASSES_ROOT: 'HKCR',
  HKEY_CURRENT_USER: 'HKCU',
  HKEY_LOCAL_MACHINE: 'HKLM',
  HKEY_USERS: 'HKU',
  HKEY_PERFORMANCE_DATA: 'HKPD',
  HKEY_CURRENT_CONFIG: 'HKCC',
})

/** 每个可接受拼写（短名与全名） → 规范短名。`hive` 字段取值只能是它的值集。 */
export const HIVE_CANONICAL = Object.freeze(
  Object.fromEntries(
    Object.keys(HIVE_HANDLES).map((spelling) => [
      spelling,
      spelling.startsWith('HKEY_') ? SHORT_BY_LONG[spelling] : spelling,
    ]),
  ),
)

if (Object.values(HIVE_CANONICAL).some((short) => short === undefined)) {
  // 构造期自检：加了新的长名却忘了补 SHORT_BY_LONG 时必须立刻炸，而不是产出 undefined
  throw new Error('registry-guard: SHORT_BY_LONG is missing an entry for one of HIVE_HANDLES; fix the table')
}

/** `[官方]` 注册表数据类型 → 数值（`winreg.h`） */
export const REG_TYPES = Object.freeze({
  REG_NONE: 0,
  REG_SZ: 1,
  REG_EXPAND_SZ: 2,
  REG_BINARY: 3,
  REG_DWORD: 4,
  REG_DWORD_BIG_ENDIAN: 5,
  REG_LINK: 6,
  REG_MULTI_SZ: 7,
  REG_RESOURCE_LIST: 8,
  REG_FULL_RESOURCE_DESCRIPTOR: 9,
  REG_RESOURCE_REQUIREMENTS_LIST: 10,
  REG_QWORD: 11,
})

const REG_TYPE_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(REG_TYPES).map(([name, value]) => [value, name])),
)

/** `[官方]` `RegOpenKeyExW` 返回码语义（**必须区分**：不是同一种"没拿到"） */
export const REG_STATUS = Object.freeze({
  ERROR_SUCCESS: 0,
  ERROR_FILE_NOT_FOUND: 2,
  ERROR_PATH_NOT_FOUND: 3,
  ERROR_ACCESS_DENIED: 5,
  ERROR_MORE_DATA: 234,
  ERROR_NO_MORE_ITEMS: 259,
})

/** `[官方]` 注册表访问权（`RegSetKeySecurity` 需要 `WRITE_DAC`） */
export const REG_ACCESS = Object.freeze({
  KEY_QUERY_VALUE: 0x0001,
  KEY_SET_VALUE: 0x0002,
  KEY_CREATE_SUB_KEY: 0x0004,
  KEY_ENUMERATE_SUB_KEYS: 0x0008,
  KEY_NOTIFY: 0x0010,
  KEY_CREATE_LINK: 0x0020,
  // ── 复合掩码（`[官方]` winreg.h "Registry Key Security and Access Rights"）──────
  // 阶段 B 实测缺陷：初版**只有**上面 6 个基本位 + 3 个 STANDARD_RIGHTS 位，**没有 KEY_READ**。
  // 而 `KEY_READ` 是注册表里最常用的授权掩码（也是 `planAclRestriction` 的典型入参），
  // 缺了它会让 `REG_ACCESS.KEY_READ` 是 `undefined` → `accessName` 解析不出来 →
  // 在 `` `0x${access.toString(16)}` `` 里以 TypeError 崩溃（见 planAclRestriction 的入参校验）。
  // 推导（STANDARD_RIGHTS_READ/WRITE 都等于 READ_CONTROL = 0x00020000）：
  //   KEY_READ    = READ_CONTROL | KEY_QUERY_VALUE | KEY_ENUMERATE_SUB_KEYS | KEY_NOTIFY
  //               = 0x20000 | 0x1 | 0x8 | 0x10 = 0x00020019
  //   KEY_WRITE   = READ_CONTROL | KEY_SET_VALUE | KEY_CREATE_SUB_KEY
  //               = 0x20000 | 0x2 | 0x4 = 0x00020006
  //   KEY_EXECUTE = KEY_READ = 0x00020019（官方明确写 "KEY_EXECUTE ... equivalent to KEY_READ"）
  //   KEY_ALL_ACCESS = (STANDARD_RIGHTS_ALL | 上述全部) & ~SYNCHRONIZE
  //                  = (0x001F0000 | 0x003F) & ~0x00100000 = 0x000F003F
  // `accessName` 解析取**第一个**匹配的键名，所以别名顺序有意义：KEY_READ 必须排在 KEY_EXECUTE 之前。
  KEY_READ: 0x00020019,
  KEY_EXECUTE: 0x00020019,
  KEY_WRITE: 0x00020006,
  KEY_ALL_ACCESS: 0x000f003f,
  READ_CONTROL: 0x00020000,
  WRITE_DAC: 0x00040000,
  WRITE_OWNER: 0x00080000,
})

const VALUE_ENCODERS = Object.freeze({
  REG_SZ: (value) => {
    if (typeof value !== 'string') throw new TypeError('REG_SZ value must be a string')
    return Buffer.from(`${value}\u0000`, 'utf16le').toString('hex')
  },
  REG_EXPAND_SZ: (value) => {
    if (typeof value !== 'string') throw new TypeError('REG_EXPAND_SZ value must be a string')
    return Buffer.from(`${value}\u0000`, 'utf16le').toString('hex')
  },
  REG_MULTI_SZ: (value) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new TypeError('REG_MULTI_SZ value must be an array of strings')
    }
    return Buffer.from(`${value.join('\u0000')}\u0000\u0000`, 'utf16le').toString('hex')
  },
  REG_DWORD: (value) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new TypeError('REG_DWORD must be a UINT32')
    return `0x${(value >>> 0).toString(16).padStart(8, '0')}`
  },
  REG_DWORD_BIG_ENDIAN: (value) => {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new TypeError('REG_DWORD_BIG_ENDIAN must be a UINT32')
    return `0x${(value >>> 0).toString(16).padStart(8, '0')}`
  },
  REG_QWORD: (value) => {
    if (typeof value !== 'bigint' || value < 0n || value > 0xffffffffffffffffn) throw new TypeError('REG_QWORD must be a UINT64 bigint')
    return `0x${value.toString(16).padStart(16, '0')}`
  },
  REG_BINARY: (value) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'hex')
    return buffer.toString('hex')
  },
  REG_NONE: (value) => (Buffer.isBuffer(value) ? value.toString('hex') : String(value)),
})

const VALUE_DECODERS = Object.freeze({
  REG_SZ: (hex) => stripTrailingNul(Buffer.from(hex, 'hex').toString('utf16le')),
  REG_EXPAND_SZ: (hex) => stripTrailingNul(Buffer.from(hex, 'hex').toString('utf16le')),
  REG_MULTI_SZ: (hex) => {
    const text = Buffer.from(hex, 'hex').toString('utf16le').replace(/\u0000+$/, '')
    return text.length === 0 ? [] : text.split('\u0000')
  },
  REG_DWORD: (hex) => Number.parseInt(hex, 16) >>> 0,
  REG_DWORD_BIG_ENDIAN: (hex) => Number.parseInt(hex, 16) >>> 0,
  REG_QWORD: (hex) => BigInt(hex),
  REG_BINARY: (hex) => Buffer.from(hex, 'hex').toString('hex'),
  REG_NONE: (hex) => hex,
})

// ─────────────────── F8：非十六进制 `data` 的**静默**误读（已修）───────────────────
//
// `[实测]` 修复前的失败形态（`tests\registry-guard.mjs --plant` 的 plant 目标）：
//   `VALUE_DECODERS.REG_SZ('hello')` → `Buffer.from('hello','hex')` **不抛错**，
//   它在第一个非法字符处**截断**：整串都不合法 ⇒ 得到**空 Buffer** ⇒ `''`（空串）。
//   后果：手工改坏的基准文件被**静默**读成"REG_SZ 的值是空串"，
//   而 `diffSnapshots` 对"两个快照的值都是空串"当然报"没有变化" —— 典型假阴性。
//   同一条路径上 REG_DWORD 也不抛（`parseInt('hello',16)` → NaN → 0），
//   REG_QWORD 抛的却是**语法错**（`SyntaxError`，且**不带 `code`**），
//   调用方无法用统一的错误码把它识别成"基准文件坏了"。
//
// 修法：**在解码之前**做形状校验 —— `data` 必须是
//   (a) 字符串；(b) 只含 `[0-9a-fA-F]`；(c) 长度为偶数（十六进制**字节**串）。
// 违者抛 `REG_SNAPSHOT_INVALID`，错误消息指明"是 data 形状坏了"，而不是"值是空的"。
//
// 为什么**允许空串**（诚实的边界，不夸大修复范围）：
//   `REG_BINARY` 的编码器对空 Buffer 就产出 `''`（`Buffer.from([]).toString('hex') === ''`），
//   即**合法快照里 `data:''` 确实会出现**。若把空串也判非法，
//   就会拒绝本模块自己刚序列化出来的快照（往返契约被破坏）。
//   因此 F8 修的是"**非十六进制**静默变空串"，**不是**"空串非法"。
//   其余类型（REG_SZ/EXPAND_SZ/MULTI_SZ/DWORD/QWORD）编码产物**必非空**，
//   所以空串在它们那里仍然非法（窄口径的额外收紧）。
const HEX_ONLY = /^[0-9a-fA-F]*$/

/**
 * 允许 `0x` 前缀的类型：`VALUE_ENCODERS` 对 REG_DWORD/REG_QWORD 正是产出
 * `0x` + 补零十六进制（见上表）。**这一点是首版 F8 修复当场踩到的坑**：
 * 只用"纯十六进制"校验会把模块**自己**序列化出来的 `0x0000002a` 判成非法，
 * 于是往返测试直接抛错 —— 修 F8 必须先看清"合法 `data` 的既有形状"，
 * 而不是先想一个"看起来更严格"的形状。
 */
const HEX_PREFIXED_TYPES = new Set(['REG_DWORD', 'REG_DWORD_BIG_ENDIAN', 'REG_QWORD'])

/** 允许空 `data` 的类型：`REG_BINARY` 的编码器对空 Buffer 就产出 `''`（见上） */
const EMPTY_DATA_ALLOWED = new Set(['REG_BINARY'])

/**
 * 校验 `data` 的形状（**不**解码、**不**触碰注册表）。
 * 形状口径**逐字对齐** `VALUE_ENCODERS` 的产物，不另立一套：
 *   · 数值类（DWORD/DWORD_BE/QWORD）：`0x` + 纯十六进制，长度必须是偶数（9/17 字符）；
 *   · 其余（SZ/EXPAND_SZ/MULTI_SZ/BINARY/NONE）：纯十六进制，长度偶数；
 *   · 空串只对 REG_BINARY 合法。
 * @throws {Error} `code = 'REG_SNAPSHOT_INVALID'`
 */
function assertShape(valueName, typeName, data) {
  const reject = (why) => {
    const error = new Error(`deserializeSnapshot: value ${JSON.stringify(valueName)} (${typeName}) ${why}`)
    error.code = 'REG_SNAPSHOT_INVALID'
    throw error
  }
  if (typeof data !== 'string') {
    reject(`has non-string data ${JSON.stringify(data)}; data must be an encoded string`)
  }
  const prefixed = HEX_PREFIXED_TYPES.has(typeName)
  const body = prefixed && /^0x/i.test(data) ? data.slice(2) : data
  if (prefixed && !/^0x/i.test(data)) {
    reject(`has data ${JSON.stringify(data)} without the required "0x" prefix`)
  }
  if (!HEX_ONLY.test(body)) {
    const shown = data.length > 48 ? `${data.slice(0, 48)}…` : data
    reject(
      `has non-hexadecimal data ${JSON.stringify(shown)}; refusing to decode ` +
        '(Buffer.from(bad,"hex") silently truncates at the first bad character, which would be read as an empty value)',
    )
  }
  if (body.length % 2 !== 0) {
    reject(`has odd-length hexadecimal data (${body.length} hex chars); hex must encode whole bytes`)
  }
  if (body.length === 0 && !EMPTY_DATA_ALLOWED.has(typeName)) {
    reject('has empty data; only REG_BINARY may legitimately serialise to the empty string')
  }
}

/**
 * 对外导出的形状校验（`tests\registry-guard.mjs` 直接断言它，避免"只测间接路径"）。
 * 生产代码内部走 `assertShape`，两者是同一个实现。
 */
export function assertHexEncodedData(valueName, typeName, data) {
  assertShape(valueName, typeName, data)
}

/**
 * 测试出口。
 *
 * `decodeGuard` 是 F8 的**可关闭开关**，存在的唯一理由是让
 * `tests\registry-guard.mjs --plant` 能恢复"静默把非十六进制读成空串"的旧行为，
 * 从而证明新增的断言**真的能失败**（"永远绿"的断言不构成保证）。
 * 生产路径上没有任何代码会把它设为 false。
 *
 * ⚠ 声明位置在 `guardedDecoder` **之前**：它在调用时刻读 `__internal.decodeGuard`，
 * 若声明挪到文件末尾，模块求值完成前的任何解码都会撞上 TDZ
 * （`Cannot access '__internal' before initialization`）—— 那是比 F8 更难查的一类缺陷。
 */
export const __internal = { compareName, stripTrailingNul, REG_TYPE_NAMES, decodeGuard: true }

/**
 * 守卫的开关**在调用时刻**从 `__internal` 读取（不在闭包创建时捕获）：
 * `--plant` 会在断言之间切换它，读当前值才能保证"开关一变，下一次解码立刻按新语义走"。
 */
function guardedDecoder(valueName, typeName, decoder) {
  return (data) => {
    // `--plant` 专用开关：设成 false 即恢复"静默空串"的旧行为，
    // 用来证明本测试**真的能失败**（"永远绿"的断言不构成保证）。生产路径恒为 true。
    if (__internal.decodeGuard) assertShape(valueName, typeName, data)
    try {
      return decoder(data)
    } catch (error) {
      // 把解码器自身的异常（例如 REG_QWORD 的 `SyntaxError: Cannot convert … to a BigInt`）
      // 统一成同一个错误码，调用方才能可靠区分"基准坏了"与"别的错"。
      const wrapped = new Error(
        `deserializeSnapshot: value ${JSON.stringify(valueName)} (${typeName}) failed to decode: ${error.message}`,
      )
      wrapped.code = 'REG_SNAPSHOT_INVALID'
      throw wrapped
    }
  }
}

function stripTrailingNul(text) {
  return text.endsWith('\u0000') ? text.slice(0, -1) : text
}

// ─────────────────────────── 注册表路径解析（纯函数）───────────────────────────

/**
 * 解析 `HKLM\Software\X` 形式的路径。
 *
 * 刻意**不做**"猜测根键"：没有已知前缀就抛错。原因见手册 #16.4（空表语义冲突）——
 * "把 `Software\X` 当成 `HKCU\Software\X`"会让快照悄悄记错位置，
 * 而"记错位置"在差异检测里的表现是"什么都没变"，是最危险的假阴性。
 *
 * @param {string} fullPath
 * @returns {{hive: string, handle: bigint, subKey: string, canonical: string}}
 *   `hive` 是**规范短名**（`HKCU`/`HKLM`/…），与调用方写的是短名还是 `HKEY_` 全名无关；
 *   `canonical` = `hive` + `\` + `subKey`（`subKey` 保留原始大小写），因此
 *   `HKLM\Software\X` 与 `HKEY_LOCAL_MACHINE\Software\X` 的 `canonical` **逐字符相同**。
 */
export function parseRegistryPath(fullPath) {
  if (typeof fullPath !== 'string' || fullPath.length === 0) {
    throw new TypeError('registry path must be a non-empty string')
  }
  const normalized = fullPath.trim().replace(/\//g, '\\')
  const separator = normalized.indexOf('\\')
  const head = (separator === -1 ? normalized : normalized.slice(0, separator)).toUpperCase()
  const rest = separator === -1 ? '' : normalized.slice(separator + 1)
  const handle = HIVE_HANDLES[head]
  if (handle === undefined) {
    const error = new Error(
      `unknown registry root ${JSON.stringify(head)} in ${JSON.stringify(fullPath)}; ` +
        `expected one of ${Object.keys(HIVE_HANDLES).join(', ')}`,
    )
    error.code = 'REG_HIVE_UNKNOWN'
    throw error
  }
  const canonicalName = HIVE_CANONICAL[head]
  const subKey = rest.replace(/\\+$/, '')
  return { hive: canonicalName, handle, subKey, canonical: subKey.length > 0 ? `${canonicalName}\\${subKey}` : canonicalName }
}

// ─────────────────────────── 快照归一化 ───────────────────────────

/**
 * 归一化 reader 的原始输出成**确定性**快照。
 *
 * 为什么必须归一化：`RegEnumValueW` 的返回顺序**不保证**稳定，二进制值在不同读取路径下
 * 可能表现为 Buffer 或十六进制字符串。不归一化就会得到"每次快照都不一样"的假差异，
 * 而假差异会让人开始忽略差异 —— 那比不做差异检测更糟。
 *
 * @param {object} raw `{ root, exists, accessDenied?, errorCode?, subKeys?: string[], values?: Record<string, {type, data}>, sddl? }`
 * @returns {object} 冻结的规范化快照（`subKeys`/`values` 键均排序）
 */
export function normalizeSnapshot(raw = {}) {
  const root = typeof raw.root === 'string' && raw.root.length > 0 ? raw.root.trim().replace(/\//g, '\\') : undefined
  if (!root) {
    const error = new Error('normalizeSnapshot: raw.root must be a non-empty registry path')
    error.code = 'REG_SNAPSHOT_INVALID'
    throw error
  }
  // 归一化 root 的大小写只到"根键 + 路径分隔符"层：注册表键名大小写不敏感，
  // 但保留原始大小写更利于人工核对，因此这里只做"统一分隔符 + 去尾部分隔符"。
  const { canonical } = parseRegistryPath(root)
  const exists = raw.exists === true
  const accessDenied = raw.accessDenied === true
  if (!exists && !accessDenied) {
    // 明确区分"不存在"与"拒绝访问"（手册第 4 章：空/不存在/无权限是不同结果）
    return Object.freeze({
      root: canonical,
      exists: false,
      accessDenied: false,
      errorCode: raw.errorCode ?? REG_STATUS.ERROR_FILE_NOT_FOUND,
      subKeys: Object.freeze([]),
      values: Object.freeze({}),
      sddl: undefined,
    })
  }
  if (accessDenied) {
    return Object.freeze({
      root: canonical,
      exists: true, // 无法证明不存在；保守记为"存在但读不到"
      accessDenied: true,
      errorCode: raw.errorCode ?? REG_STATUS.ERROR_ACCESS_DENIED,
      subKeys: Object.freeze([]),
      values: Object.freeze({}),
      sddl: undefined,
    })
  }

  // 去重必须**不区分大小写**：Windows 注册表的子键名不区分大小写，`a` 与 `A` 是**同一个**子键。
  // 阶段 B 实测缺陷：初版用 `new Set(...)`（区分大小写）去重，却用不区分大小写的比较器排序 ——
  // 于是 `['a','A','b']` 产出 3 个"子键"，而真实注册表里只有 2 个。
  // 多出来的那一个会在 diff 里表现成反复增删（幻影差异），而幻影差异会让人开始忽略差异。
  const seenSubKeys = new Set()
  const subKeys = Object.freeze(
    [...(raw.subKeys ?? [])]
      .filter((name) => typeof name === 'string' && name.length > 0)
      .sort(compareName)
      .filter((name) => {
        const folded = name.toLowerCase()
        if (seenSubKeys.has(folded)) return false
        seenSubKeys.add(folded)
        return true
      }),
  )
  const values = {}
  // 值的名字同样不区分大小写（`RegSetValueEx` 里 `Zeta` 与 `zeta` 是同一个值）。
  // 先按不区分大小写的顺序排序再取第一个，保证"哪一个代表这个值"是**确定**的。
  const seenValueNames = new Set()
  for (const [name, entry] of Object.entries(raw.values ?? {}).sort(([left], [right]) => compareName(left, right))) {
    const folded = name.toLowerCase()
    if (seenValueNames.has(folded)) continue
    seenValueNames.add(folded)
    if (entry === null || typeof entry !== 'object') {
      const error = new Error(`normalizeSnapshot: value ${JSON.stringify(name)} must be {type, data}`)
      error.code = 'REG_SNAPSHOT_INVALID'
      throw error
    }
    const typeName = typeof entry.type === 'number' ? REG_TYPE_NAMES[entry.type] : entry.type
    if (typeof typeName !== 'string' || !(typeName in REG_TYPES)) {
      const error = new Error(
        `normalizeSnapshot: value ${JSON.stringify(name)} has unknown type ${JSON.stringify(entry.type)}`,
      )
      error.code = 'REG_SNAPSHOT_INVALID'
      throw error
    }
    const encoder = VALUE_ENCODERS[typeName]
    let encoded
    try {
      encoded = encoder(entry.data)
    } catch (error) {
      const wrapped = new Error(`normalizeSnapshot: value ${JSON.stringify(name)} (${typeName}): ${error.message}`)
      wrapped.code = 'REG_SNAPSHOT_INVALID'
      throw wrapped
    }
    values[name] = Object.freeze({ type: typeName, data: encoded })
  }
  const sortedValues = Object.freeze(
    Object.fromEntries(
      Object.keys(values)
        .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
        .map((key) => [key, values[key]]),
    ),
  )
  return Object.freeze({
    root: canonical,
    exists: true,
    accessDenied: false,
    errorCode: REG_STATUS.ERROR_SUCCESS,
    subKeys,
    values: sortedValues,
    sddl: typeof raw.sddl === 'string' ? raw.sddl : undefined,
  })
}

/** 快照 → 稳定 JSON 文本（用于落盘与哈希；键序已定，因此同内容必得同文本） */
export function serializeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('serializeSnapshot: snapshot must be an object')
  return JSON.stringify(
    {
      root: snapshot.root,
      exists: snapshot.exists === true,
      accessDenied: snapshot.accessDenied === true,
      errorCode: snapshot.errorCode ?? 0,
      subKeys: [...(snapshot.subKeys ?? [])],
      values: Object.fromEntries(
        Object.entries(snapshot.values ?? {}).map(([name, entry]) => [name, { type: entry.type, data: entry.data }]),
      ),
      sddl: snapshot.sddl,
    },
    null,
    2,
  )
}

/** 从序列化文本还原（`deserializeSnapshot(serializeSnapshot(x))` 必须与 `x` 语义等价） */
export function deserializeSnapshot(text) {
  if (typeof text !== 'string') throw new TypeError('deserializeSnapshot: text must be a string')
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    const wrapped = new Error(`deserializeSnapshot: not valid JSON (${error.message})`)
    wrapped.code = 'REG_SNAPSHOT_INVALID'
    throw wrapped
  }
  const values = {}
  for (const [name, entry] of Object.entries(raw.values ?? {})) {
    if (entry === null || typeof entry !== 'object') {
      const error = new Error(`deserializeSnapshot: value ${JSON.stringify(name)} must be {type, data}`)
      error.code = 'REG_SNAPSHOT_INVALID'
      throw error
    }
    const decoder = VALUE_DECODERS[entry.type]
    if (!decoder) {
      const error = new Error(`deserializeSnapshot: unknown value type ${JSON.stringify(entry.type)} for ${JSON.stringify(name)}`)
      error.code = 'REG_SNAPSHOT_INVALID'
      throw error
    }
    // F8：形状校验必须在解码**之前**（`Buffer.from(bad,'hex')` 会静默截断成空串）
    values[name] = { type: entry.type, data: guardedDecoder(name, entry.type, decoder)(entry.data) }
  }
  // 注意：这里刻意**不**直接采用文件里的 `subKeys`/`values` 顺序，
  // 而是重新走一遍 normalizeSnapshot，保证"从文件读回来的快照"与"实时采集的快照"形态一致。
  return normalizeSnapshot({
    root: raw.root,
    exists: raw.exists,
    accessDenied: raw.accessDenied,
    errorCode: raw.errorCode,
    subKeys: raw.subKeys ?? [],
    values,
    sddl: raw.sddl,
  })
}

// ─────────────────────────── 差异检测（纯函数）───────────────────────────

/** 差异条目类别 */
export const CHANGE_KINDS = Object.freeze(['key-created', 'key-deleted', 'key-access-changed', 'value-added', 'value-deleted', 'value-changed', 'security-changed'])

/**
 * 计算两份快照之间的差异。
 *
 * 设计要点：
 *   1. **"拒绝访问"必须成为一等差异，而不是空差异。** 若执行前可读、执行后 `accessDenied`，
 *      那正是"有人（或某程序）改了它的安全描述符"的最强信号 —— 报空差异会把最严重的变更藏起来。
 *   2. 输出顺序确定（先 key 级、再 value 级、再安全级；同类内按名称排序），便于落盘 diff。
 *   3. **不解释原因**：只报"变了什么"，归因留给调用方（避免把"我们的探针自己写的"说成攻击）。
 *
 * @param {object} before
 * @param {object} after
 * @returns {{changes: Array<object>, summary: object}}
 */
export function diffSnapshots(before, after) {
  if (!before || !after) throw new TypeError('diffSnapshots requires two snapshots')
  if (before.root !== after.root) {
    const error = new Error(`diffSnapshots: root mismatch (${before.root} vs ${after.root}) — comparing different keys is meaningless`)
    error.code = 'REG_DIFF_ROOT_MISMATCH'
    throw error
  }
  const changes = []

  if (!before.exists && after.exists) changes.push({ kind: 'key-created', key: after.root })
  if (before.exists && !after.exists) changes.push({ kind: 'key-deleted', key: before.root })
  if (before.accessDenied !== after.accessDenied) {
    changes.push({
      kind: 'key-access-changed',
      key: after.root,
      // `before` / `after` 是"可读性"标签，**不是** SDDL。
      // 阶段 B 实测缺陷：初版只给了这两个标签，而 `planRollback` 却把 `change.before`
      // 当 SDDL 用（`sddl: change.before`, `reversibility: EXACT`），于是产出一条
      // `{op:'restore-sddl', sddl:'readable', reversibility:'EXACT'}` ——
      // 一个"承诺精确回滚"却携带无意义 SDDL 的计划。要还原权限必须有**执行前的 SDDL**，
      // 所以这里把快照里真实存在的 SDDL 一并带上（没有就是 null，由 planRollback 标 IMPOSSIBLE）。
      before: before.accessDenied ? 'access-denied' : 'readable',
      after: after.accessDenied ? 'access-denied' : 'readable',
      sddlBefore: typeof before.sddl === 'string' && before.sddl.length > 0 ? before.sddl : null,
      sddlAfter: typeof after.sddl === 'string' && after.sddl.length > 0 ? after.sddl : null,
    })
  }

  const beforeSub = new Set(before.subKeys ?? [])
  const afterSub = new Set(after.subKeys ?? [])
  for (const name of [...afterSub].filter((n) => !beforeSub.has(n)).sort(compareName)) {
    changes.push({ kind: 'subkey-added', key: `${after.root}\\${name}` })
  }
  for (const name of [...beforeSub].filter((n) => !afterSub.has(n)).sort(compareName)) {
    changes.push({ kind: 'subkey-deleted', key: `${before.root}\\${name}` })
  }

  const beforeValues = before.values ?? {}
  const afterValues = after.values ?? {}
  for (const name of Object.keys(afterValues).sort(compareName)) {
    if (!(name in beforeValues)) {
      changes.push({ kind: 'value-added', key: after.root, valueName: name, after: { ...afterValues[name] } })
      continue
    }
    const left = beforeValues[name]
    const right = afterValues[name]
    if (left.type !== right.type) {
      changes.push({
        kind: 'value-changed',
        key: after.root,
        valueName: name,
        reason: 'type',
        before: { ...left },
        after: { ...right },
      })
      continue
    }
    if (left.data !== right.data) {
      changes.push({
        kind: 'value-changed',
        key: after.root,
        valueName: name,
        reason: 'data',
        before: { ...left },
        after: { ...right },
      })
    }
  }
  for (const name of Object.keys(beforeValues).sort(compareName)) {
    if (!(name in afterValues)) {
      changes.push({ kind: 'value-deleted', key: before.root, valueName: name, before: { ...beforeValues[name] } })
    }
  }

  if ((before.sddl ?? null) !== (after.sddl ?? null)) {
    changes.push({ kind: 'security-changed', key: after.root, before: before.sddl, after: after.sddl })
  }

  const summary = changes.reduce((acc, change) => {
    acc[change.kind] = (acc[change.kind] ?? 0) + 1
    return acc
  }, {})
  return { changes, summary }
}

function compareName(a, b) {
  const left = a.toLowerCase()
  const right = b.toLowerCase()
  return left < right ? -1 : left > right ? 1 : 0
}

// ─────────────────────────── 回滚计划（纯函数）───────────────────────────

/** 回滚可逆性分级 */
export const REVERSIBILITY = Object.freeze({
  EXACT: 'exact', // 有原值，可精确还原
  LOSSY: 'lossy', // 能还原到"记录到的状态"，但记录本身可能不完整（例如只读了值没读权限）
  IMPOSSIBLE: 'impossible', // 无原值 → 只能删除
})

/**
 * 由差异生成**回滚操作计划**（纯数据，不执行任何注册表调用）。
 *
 * 每条操作显式带 `reversibility` 与 `needsElevation`，让调用方在**执行前**就能看到
 * "哪些回滚是不可逆的"。这是本模块最重要的一条诚实性设计：
 * 如果回滚计划里藏着一个 `impossible` 项却不告诉调用方，那"可回滚"就是一句空话。
 *
 * @param {Array<object>} changes `diffSnapshots()` 的 `changes`
 * @param {{rootPath?: string, targetHive?: string}} [options]
 * @returns {{operations: Array<object>, warnings: string[], exact: number, lossy: number, impossible: number}}
 */
export function planRollback(changes, options = {}) {
  if (!Array.isArray(changes)) throw new TypeError('planRollback: changes must be an array')
  const operations = []
  const warnings = []

  for (const change of changes) {
    const fullPath = change.key ?? options.rootPath
    if (typeof fullPath !== 'string' || fullPath.length === 0) {
      const error = new Error(`planRollback: change without a key path: ${JSON.stringify(change)}`)
      error.code = 'REG_ROLLBACK_INVALID'
      throw error
    }
    const { hive, subKey, canonical } = parseRegistryPath(fullPath)
    const needsElevation = hive === 'HKLM' || hive === 'HKU' || hive === 'HKCR' || hive === 'HKCC'

    switch (change.kind) {
      case 'key-created':
        operations.push({
          op: 'delete-key',
          hive,
          subKey,
          path: canonical,
          reversibility: REVERSIBILITY.LOSSY,
          needsElevation,
          reason: '整个键在执行期间被创建；删除它会连同其中未被快照记录的值一起丢失',
        })
        break
      case 'key-deleted':
        operations.push({
          op: 'recreate-key',
          hive,
          subKey,
          path: canonical,
          reversibility: REVERSIBILITY.IMPOSSIBLE,
          needsElevation,
          reason: '键的原值不在快照中（快照只记录它的存在性）；仅能重建空键，内容不可恢复',
        })
        warnings.push(`key-deleted ${canonical}: 内容不可恢复（IMPOSSIBLE），只能重建空键`)
        break
      case 'key-access-changed': {
        // `change.before` / `change.after` 是"可读性"标签（'readable' / 'access-denied'），**不是** SDDL。
        // 唯一的可还原来源是 `diffSnapshots` 带上的 `sddlBefore`（阶段 B 实测缺陷修正）。
        const sddlBefore = typeof change.sddlBefore === 'string' && change.sddlBefore.length > 0 ? change.sddlBefore : null
        operations.push({
          op: 'restore-sddl',
          hive,
          subKey,
          path: canonical,
          sddl: sddlBefore,
          readabilityBefore: change.before,
          readabilityAfter: change.after,
          reversibility: sddlBefore === null ? REVERSIBILITY.IMPOSSIBLE : REVERSIBILITY.EXACT,
          // 不写死 true：HKCU 的键通常由当前用户拥有（WRITE_DAC 已持有），只有 HKLM/HKU/HKCR/HKCC 才需要管理员。
          // 阶段 B 实测缺陷：初版这里写死 `true`，与同一分支 reason 里写的"HKLM 需管理员"自相矛盾，
          // 会让纯 HKCU 的回滚计划也报 requiresElevation=true（诱导无谓的提权）。
          needsElevation,
          reason: sddlBefore === null
            ? '执行前后"可读性"发生了变化，但差异记录里没有执行前的 SDDL（需要执行前带 READ_CONTROL 落盘 SDDL），因此权限无法还原'
            : '用执行前记录的 SDDL 通过 RegSetKeySecurity 还原（需要 WRITE_DAC）',
        })
        if (sddlBefore === null) {
          warnings.push(`key-access-changed ${canonical}: 无可还原的原始 SDDL —— 差异记录里的 before/after 是"可读性"标签，不是 SDDL`)
        }
        break
      }
      case 'security-changed':
        operations.push({
          op: 'restore-sddl',
          hive,
          subKey,
          path: canonical,
          sddl: change.before,
          reversibility: change.before === undefined || change.before === null ? REVERSIBILITY.IMPOSSIBLE : REVERSIBILITY.EXACT,
          // 同上：needsElevation 由 hive 决定，不写死 true（HKCU 的 WRITE_DAC 不需要提权）
          needsElevation,
          reason: '按执行前记录的 SDDL 还原安全描述符（需要 WRITE_DAC；HKLM 需管理员）',
        })
        break
      case 'value-added':
        operations.push({
          op: 'delete-value',
          hive,
          subKey,
          path: canonical,
          valueName: change.valueName,
          reversibility: REVERSIBILITY.EXACT,
          needsElevation,
          reason: '该值在执行期间出现，删除它即回到原状',
        })
        break
      case 'value-deleted':
        operations.push({
          op: 'set-value',
          hive,
          subKey,
          path: canonical,
          valueName: change.valueName,
          type: change.before?.type,
          data: change.before?.data,
          reversibility: change.before === undefined ? REVERSIBILITY.IMPOSSIBLE : REVERSIBILITY.EXACT,
          needsElevation,
          reason: change.before === undefined
            ? '没有原值的记录，无法还原'
            : '用执行前记录的类型与数据写回',
        })
        if (change.before === undefined) warnings.push(`value-deleted ${canonical}\\${change.valueName}: 无原值记录，不可还原`)
        break
      case 'value-changed':
        operations.push({
          op: 'set-value',
          hive,
          subKey,
          path: canonical,
          valueName: change.valueName,
          type: change.before?.type,
          data: change.before?.data,
          reversibility: change.before === undefined ? REVERSIBILITY.IMPOSSIBLE : REVERSIBILITY.EXACT,
          needsElevation,
          reason: `还原被修改的值（变更维度：${change.reason ?? 'unknown'}）`,
        })
        break
      case 'subkey-added':
        operations.push({
          op: 'delete-key',
          hive,
          subKey,
          path: canonical,
          reversibility: REVERSIBILITY.LOSSY,
          needsElevation,
          reason: '子键在执行期间出现；只记录了名字，未递归快照其内容',
        })
        warnings.push(`subkey-added ${canonical}: 只记录了名字，递归回滚需要先递归快照（当前实现不递归）`)
        break
      case 'subkey-deleted':
        operations.push({
          op: 'recreate-key',
          hive,
          subKey,
          path: canonical,
          reversibility: REVERSIBILITY.IMPOSSIBLE,
          needsElevation,
          reason: '子键被删除且没有递归快照，内容不可恢复',
        })
        warnings.push(`subkey-deleted ${canonical}: 内容不可恢复（IMPOSSIBLE）`)
        break
      default:
        throw Object.assign(new Error(`planRollback: unknown change kind ${JSON.stringify(change.kind)}`), {
          code: 'REG_ROLLBACK_INVALID',
        })
    }
  }

  // 回滚顺序：删除类**先**做（从深到浅），写入类**后**做（从浅到深）。
  // 理由：先删后写可以避免"刚写回的值被随后的删除键操作连带删掉"。
  const order = { 'delete-value': 0, 'delete-key': 1, 'recreate-key': 2, 'set-value': 3, 'restore-sddl': 4 }
  operations.sort((a, b) => (order[a.op] ?? 9) - (order[b.op] ?? 9))

  const count = (level) => operations.filter((op) => op.reversibility === level).length
  if (count(REVERSIBILITY.IMPOSSIBLE) > 0) {
    warnings.push(
      `${count(REVERSIBILITY.IMPOSSIBLE)} 项回滚是不可能的（IMPOSSIBLE）—— 不要把这份计划描述为"可完全回滚"`,
    )
  }
  if (count(REVERSIBILITY.LOSSY) > 0) {
    warnings.push(`${count(REVERSIBILITY.LOSSY)} 项回滚是 LOSSY 的（能执行但可能丢失未记录的内容）`)
  }
  return {
    operations,
    warnings,
    exact: count(REVERSIBILITY.EXACT),
    lossy: count(REVERSIBILITY.LOSSY),
    impossible: count(REVERSIBILITY.IMPOSSIBLE),
  }
}

// ─────────────────────────── ACL 限制：只出计划，不执行 ───────────────────────────

/** 允许限制的目标 SID 形态（语义名 → 说明）；实际 SID 由调用方提供 */
export const ACL_PRINCIPALS = Object.freeze(['appcontainer', 'restricted', 'users'])

/**
 * 生成"按 SID 限制注册表访问"的**计划**。
 *
 * **本函数不执行任何注册表操作，也不构造安全描述符。** 刻意如此：
 * 手册第 10 章要求"计划与执行分离"，而注册表 ACL 是**改坏就难以恢复**的一类操作。
 *
 * 计划本身必须回答三个问题（否则就是在鼓励盲改）：
 *   1. 原 SDDL 有没有先落盘？（`requireBackup` 恒为 true）
 *   2. 用不用 `Deny` ACE？（**恒为 false** —— Deny 优先且会连带拒绝宿主自身）
 *   3. 回滚走哪条路？（必须是同一个 `restore-sddl` 操作，且用落盘的原始 SDDL）
 *
 * @param {{keys: string[], principal: string, principalSid: string, access?: number, backupPath: string}} options
 */
export function planAclRestriction(options = {}) {
  const { keys, principal, principalSid, access = REG_ACCESS.KEY_READ, backupPath } = options
  if (!Array.isArray(keys) || keys.length === 0) {
    throw Object.assign(new Error('planAclRestriction: keys must be a non-empty array'), { code: 'REG_ACL_PLAN_INVALID' })
  }
  if (!ACL_PRINCIPALS.includes(principal)) {
    throw Object.assign(
      new Error(`planAclRestriction: principal must be one of ${ACL_PRINCIPALS.join(', ')}, got ${JSON.stringify(principal)}`),
      { code: 'REG_ACL_PLAN_INVALID' },
    )
  }
  if (typeof principalSid !== 'string' || principalSid.length === 0) {
    throw Object.assign(new Error('planAclRestriction: principalSid is required (we do not derive SIDs here)'), {
      code: 'REG_ACL_PLAN_INVALID',
    })
  }
  if (typeof backupPath !== 'string' || backupPath.length === 0) {
    throw Object.assign(
      new Error('planAclRestriction: backupPath is required — the original SDDL MUST be persisted before any change'),
      { code: 'REG_ACL_PLAN_INVALID' },
    )
  }
  // 阶段 B 实测缺陷：初版没有校验 `access`。传进来的掩码若既不是数字、又不在 REG_ACCESS 里，
  // 就会在下面的 `` `0x${access.toString(16)}` `` 里以
  // `TypeError: Cannot read properties of undefined (reading 'toString')` 崩溃 ——
  // 报错点在一个模板字符串里，根因（入参非法）完全看不出来。
  // fail-closed 的做法是在**改任何状态之前**明确拒绝非数字掩码。
  if (!Number.isInteger(access) || access < 0 || access > 0xffffffff) {
    throw Object.assign(
      new Error(
        `planAclRestriction: access must be a UINT32 registry access mask (e.g. REG_ACCESS.KEY_READ=0x${REG_ACCESS.KEY_READ.toString(16)}), ` +
          `got ${typeof access} ${JSON.stringify(access)}`,
      ),
      { code: 'REG_ACL_PLAN_INVALID' },
    )
  }
  const steps = []
  const warnings = []
  for (const key of keys) {
    const { hive, subKey, canonical } = parseRegistryPath(key)
    const needsElevation = hive !== 'HKCU'
    steps.push({
      path: canonical,
      op: 'set-key-security',
      hive,
      subKey,
      principal,
      principalSid,
      access,
      accessName: Object.entries(REG_ACCESS).find(([, value]) => value === access)?.[0] ?? `0x${access.toString(16)}`,
      needsElevation,
      requireBackup: true,
      useDenyAce: false,
      backupPath,
      restoreOp: 'restore-sddl',
      reason:
        'Grant read-only to the principal and REMOVE it from any write-bearing ACE. ' +
        'A Deny ACE is refused: deny wins over grant and can lock out the host itself.',
    })
    if (needsElevation) warnings.push(`${canonical}: 位于 ${hive}，需要管理员（WRITE_DAC）`)
  }
  warnings.push(
    'This is a PLAN ONLY. No registry call is made by registry-guard. Executing it changes system state and ' +
      'requires the original SDDL to have been persisted first.',
  )
  warnings.push(
    'A registry ACL narrows access but does NOT make the registry a hard boundary: the same user can often ' +
      're-take ownership of a key it owns (WRITE_OWNER) — treat the result as a residual boundary, not isolation.',
  )
  return { steps, warnings, requiresElevation: steps.some((step) => step.needsElevation) }
}

// ─────────────────────────── 运行期门面 ───────────────────────────

/**
 * `RegistryGuard`：采集 → 差异 → 回滚计划。
 *
 * **不提供自动回滚执行**（`applyRollback` 刻意不实现）：回滚注册表是高风险写操作，
 * 必须由调用方在拿到用户的明确批准后自行执行。本模块只保证"计划是可判定的、失败模式是写明的"。
 */
export class RegistryGuard {
  /**
   * @param {{read: (path: string) => object}} reader 采集器（见 `normalizeSnapshot` 的 `raw` 契约）
   * @param {{namespaces: Array<{root: string, recursive?: boolean}>}} options
   */
  constructor(reader, options = {}) {
    if (!reader || typeof reader.read !== 'function') {
      throw Object.assign(new Error('RegistryGuard requires a reader with a read(path) method'), {
        code: 'REG_READER_MISSING',
      })
    }
    this.reader = reader
    this.options = options
    const namespaces = options.namespaces ?? []
    if (!Array.isArray(namespaces) || namespaces.length === 0) {
      throw Object.assign(new Error('RegistryGuard requires options.namespaces (a non-empty array of {root})'), {
        code: 'REG_NAMESPACES_MISSING',
      })
    }
    for (const namespace of namespaces) parseRegistryPath(namespace.root) // 早失败：非法根键在这里就报
    this.before = null
    this.after = null
  }

  /** 采集一份快照（`reader` 抛错即上抛 —— 不把"读不到"当成"没变化"） */
  capture() {
    const snapshots = {}
    for (const namespace of this.options.namespaces) {
      const raw = this.reader.read(namespace.root)
      if (raw === undefined || raw === null) {
        throw Object.assign(
          new Error(
            `reader returned ${raw === null ? 'null' : 'undefined'} for ${namespace.root}; ` +
              'an empty result is NOT a denial and NOT "unchanged" (manual ch.4)',
          ),
          { code: 'REG_READ_EMPTY' },
        )
      }
      snapshots[namespace.root] = normalizeSnapshot({ root: namespace.root, ...raw })
    }
    return snapshots
  }

  /** 记录执行前状态 */
  markBefore() {
    this.before = this.capture()
    return this.before
  }

  /** 记录执行后状态并计算差异 */
  markAfter() {
    if (!this.before) {
      throw Object.assign(new Error('markAfter() called before markBefore(); the "before" snapshot is the whole point'), {
        code: 'REG_ORDER_VIOLATION',
      })
    }
    this.after = this.capture()
    return this.report()
  }

  /** 汇总报告（含回滚计划的不可逆项统计） */
  report() {
    if (!this.before || !this.after) {
      throw Object.assign(new Error('report() requires both markBefore() and markAfter()'), { code: 'REG_ORDER_VIOLATION' })
    }
    const perRoot = {}
    let totalChanges = 0
    let exact = 0
    let lossy = 0
    let impossible = 0
    const warnings = []
    for (const root of Object.keys(this.before)) {
      const { changes, summary } = diffSnapshots(this.before[root], this.after[root])
      const rollback = changes.length > 0 ? planRollback(changes, { rootPath: root }) : { operations: [], warnings: [], exact: 0, lossy: 0, impossible: 0 }
      perRoot[root] = { changes, summary, rollback }
      totalChanges += changes.length
      exact += rollback.exact
      lossy += rollback.lossy
      impossible += rollback.impossible
      warnings.push(...rollback.warnings)
    }
    return {
      roots: perRoot,
      totalChanges,
      rollback: { exact, lossy, impossible },
      warnings,
      verdict: totalChanges === 0 ? 'no-observed-change' : impossible > 0 ? 'changed-not-fully-reversible' : 'changed-reversible',
      note:
        'registry-guard is DETECTION, not a hard boundary. A "no-observed-change" verdict only means this reader ' +
        'saw no difference in the captured namespaces — it does not mean nothing was written.',
    }
  }
}

/**
 * 用 Koffi 形状的绑定构造一个运行期 reader。
 *
 * `[未实测]`：本模块新增的注册表读取路径**没有**在本机跑过完整采集（本机注册表键缺失、
 * 且没有可用的 `reg.exe` 子进程路径）。此处只集中"调用形状"。
 *
 * 需要的低层绑定：`regOpenKeyExW(root, subKey, options, samDesired)` →
 * `{status, handle}`；`regEnumKeyExW(handle, index)` → `{status, name}`；
 * `regEnumValueW(handle, index)` → `{status, name, type, data}`；`regCloseKey(handle)`；
 * 可选 `regGetKeySecurity(handle)` → `{status, sddl}`。
 */
export function createRegistryReader(bindings, options = {}) {
  if (!bindings || typeof bindings.regOpenKeyExW !== 'function') {
    throw Object.assign(new Error('createRegistryReader requires bindings.regOpenKeyExW'), { code: 'REG_BINDINGS_MISSING' })
  }
  const maxSubKeys = options.maxSubKeys ?? 4096
  const maxValues = options.maxValues ?? 4096
  return {
    read(path) {
      const { handle, subKey } = parseRegistryPath(path)
      const opened = bindings.regOpenKeyExW(handle, subKey, 0, REG_ACCESS.KEY_QUERY_VALUE | REG_ACCESS.KEY_ENUMERATE_SUB_KEYS | REG_ACCESS.READ_CONTROL)
      const status = (opened?.status ?? opened) >>> 0
      if (status === REG_STATUS.ERROR_ACCESS_DENIED) return { exists: true, accessDenied: true, errorCode: status }
      if (status === REG_STATUS.ERROR_FILE_NOT_FOUND || status === REG_STATUS.ERROR_PATH_NOT_FOUND) {
        return { exists: false, accessDenied: false, errorCode: status }
      }
      if (status !== REG_STATUS.ERROR_SUCCESS) {
        throw Object.assign(new Error(`RegOpenKeyExW(${path}) -> ${status}`), { code: 'REG_OPEN_FAILED', regStatus: status })
      }
      const keyHandle = opened.handle
      try {
        const subKeys = []
        for (let index = 0; index < maxSubKeys; index += 1) {
          const enumerated = bindings.regEnumKeyExW(keyHandle, index)
          const enumStatus = (enumerated?.status ?? 0) >>> 0
          if (enumStatus === REG_STATUS.ERROR_NO_MORE_ITEMS) break
          if (enumStatus !== REG_STATUS.ERROR_SUCCESS) {
            throw Object.assign(new Error(`RegEnumKeyExW(${path}, ${index}) -> ${enumStatus}`), { code: 'REG_ENUM_FAILED', regStatus: enumStatus })
          }
          subKeys.push(enumerated.name)
        }
        const values = {}
        for (let index = 0; index < maxValues; index += 1) {
          const enumerated = bindings.regEnumValueW(keyHandle, index)
          const enumStatus = (enumerated?.status ?? 0) >>> 0
          if (enumStatus === REG_STATUS.ERROR_NO_MORE_ITEMS) break
          if (enumStatus !== REG_STATUS.ERROR_SUCCESS) {
            throw Object.assign(new Error(`RegEnumValueW(${path}, ${index}) -> ${enumStatus}`), { code: 'REG_ENUM_FAILED', regStatus: enumStatus })
          }
          values[enumerated.name] = { type: enumerated.type, data: enumerated.data }
        }
        const sddl = typeof bindings.regGetKeySecurity === 'function' ? bindings.regGetKeySecurity(keyHandle)?.sddl : undefined
        return { exists: true, accessDenied: false, errorCode: 0, subKeys, values, sddl }
      } finally {
        try {
          bindings.regCloseKey(keyHandle)
        } catch {
          /* 关闭失败只影响句柄残留 */
        }
      }
    },
  }
}

// 测试出口见文件上方（`decodeGuard` 必须早于 `decodeGuarded` 声明）
