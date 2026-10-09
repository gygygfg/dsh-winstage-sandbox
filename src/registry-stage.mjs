/**
 * registry-stage —— 注册表**写入暂存**层（覆盖 hive + WAL 日志 + 候选 + 选择性应用）
 *
 * ── 它解决的是什么（与 registry-guard 的分工，务必分清）───────────────────────
 * `src/registry-guard.mjs` 的定位是**检测**：执行前快照、执行后差异、可选回滚**计划**。
 * 它**不阻止**写入（见该文件头注释）。`[实测]` 沙箱内
 * `New-Item HKCU:\Software\X` → `UnauthorizedAccessException`，归因见
 * `docs/dsh2-越界与注册表-实测诊断.md` §3：`HKCU:\Software` 的 SD 里
 * `NT AUTHORITY\RESTRICTED` 只有 `ReadKey`，而受限令牌确含该 SID ——
 * **拒绝由受限令牌本身引入**，且发生在**内核**，不是"没捕获"。
 *
 * 本模块把那类"内核硬拒"改成**暂存**：
 *   1. 每个沙箱会话一个**私有覆盖区**（`<sessionDir>/registry/`），核心是一个
 *      `RegLoadAppKeyW` 能加载的 **app hive** 文件 `overlay.hive`；
 *      写入落在覆盖区 ⇒ 调用方**看到成功**、能**读回自己写的值**，**真实 hive 一个字节都不动**；
 *   2. 覆盖区里的变更被冻结成**候选**（与文件候选同构，落进同一个 `candidates/<id>.json`、
 *      同一个 `queue.json`，因此进**同一个审批面板**）；
 *   3. 候选可**选择性应用**（宿主令牌、逐路径）或**丢弃**；未应用前真实 hive 不变。
 *
 * ── 两条诚实的边界声明（不得被读成"注册表已被隔离"）───────────────────────────
 *   a) 覆盖层是**逻辑重定向**，不是内核边界：它只对**被 hook 的 8 个 Reg* API** 生效。
 *      凡是绕过这些 API 的写入路径（`NtSetValueKey`、直接写 `NTUSER.DAT`/`SYSTEM`、
 *      未注入的 `reg.exe`/`regedit`）**照样命中真实 hive**，在受限令牌下照样是原始的内核硬拒。
 *      逐条清单见 `REGISTERED_HARD_DENIALS` 与 `docs/T3-注册表暂存设计.md`。
 *   b) "写进覆盖层"**不等于**"系统认得这个写入"。服务/COM/驱动/启动项读的是真实 hive。
 *      覆盖层让**沙箱内的程序**自洽（写进去、读回来），但 `HKCU\...\Run` 之类不会真的生效。
 *      这是覆盖方案的**固有残余**，不是缺陷；把它说成"已隔离"才是粉饰。
 *
 * ── 纯函数与 Win32 调用的分离（本文件的结构骨架）─────────────────────────────
 *   纯层（无 fs / 无 Win32，任何会话可离线验证）：
 *     `resolveRegistryStagePath` / `overlaySubKeyFor` / `classifyRegistryOperation` /
 *     `createOverlayState` / `applyOverlayOperation` / `overlayView` / `overlayQueryValue` /
 *     `diffOverlay` / `overlayChangesToCandidateChanges` / `encodeJournalRecord` /
 *     `decodeJournalRecords` / `replayJournal`
 *   fs 层：`open()` / `appendRecord()` / `freezeCandidate()` / `apply()` / `discard()`
 *   Win32 层：`createRegistryWriter(bindings)`（`[未实测]`，形状与 `createRegistryReader` 一致）
 *
 * ── 与 T4（shim DLL）的接口 ──────────────────────────────────────────────────
 * 覆盖层需要的 hive 生命周期（`[官方]`，见
 * https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regloadappkeyw）：
 *   · `RegLoadAppKeyW(file, &root, samDesired, REG_PROCESS_APPKEY=0x1, 0)`
 *     —— **文件不存在时自动创建空 hive**，因此不需要先 `RegSaveKey`；
 *   · hive 挂在**特殊根**下，**无法用绝对路径枚举/访问** ⇒ 天然私有；
 *   · 同一文件被两个进程加载时，第二个 `RegLoadAppKey` 拿到的是**同一个** hive 的句柄；
 *     `REG_PROCESS_APPKEY` 阻止**同一进程**重复加载（`ERROR_SHARING_VIOLATION=32`）；
 *   · 卸载**没有** `RegUnLoadKey`：**最后一个句柄 `RegCloseKey` 后自动卸载**；
 *   · hive 内所有键**必须共享同一个安全描述符**，且**禁止** `RegSetKeySecurity`
 *     ⇒ **安全描述符变更无法暂存**（硬拒）。
 * 覆盖层内的路径映射：真实 `HKLM\Software\X` ⇒ 覆盖 hive 内的子键 `HKLM\Software\X`
 * （即 `overlaySubKeyFor()`，逐字符相同，只保留短 hive 名）。因此宿主侧
 * 不需要任何 IPC：DLL 把每次调用**先追加**到 WAL（`overlay.journal`，见下），
 * 宿主解析同一份日志就能产出候选。
 *
 * ── WAL（`overlay.journal`）为什么是二进制定长头 ─────────────────────────────
 * 日志是**跨语言**接口（C/JS 都要读写），所以形状必须钉死：32 字节小端头 + 变长负载，
 * 字段偏移在 `REG_STAGE_RECORD_OFFSETS` 里逐字段写出，`tests/registry-stage.mjs`
 * 会**断言这些偏移**，从而让 "C 结构体" 与 "JS 解析器" 不可能悄悄漂移。
 * 顺序是 **WAL-first**：DLL 必须先追加并落盘、再改覆盖 hive；追加失败就必须**让调用失败**，
 * 否则宿主会看到"写入成功但候选里没有它"的分叉（正是本项目最忌讳的那类不一致）。
 *
 * 官方/文档依据：
 *   RegLoadAppKeyW  https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regloadappkeyw
 *   RegCreateKeyExW https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regcreatekeyexw
 *   RegDeleteKeyExW https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regdeletekeyexw
 *   RegSetValueExW  https://learn.microsoft.com/en-us/windows/win32/api/winreg/nf-winreg-regsetvalueexw
 *   Registry Hives  https://learn.microsoft.com/en-us/windows/win32/sysinfo/registry-hives
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import {
  HIVE_CANONICAL,
  REG_ACCESS,
  REG_STATUS,
  REG_TYPES,
  decodeRegistryValue,
  diffSnapshots,
  encodeRegistryValue,
  normalizeSnapshot,
  parseRegistryPath,
  planRollback,
  registryTypeName,
  serializeSnapshot,
} from './registry-guard.mjs'
import { CANDIDATE_STATUS, newCandidateId } from './store.mjs'

// ─────────────────────────────── 常量 ───────────────────────────────

/** 覆盖层状态版本（与 `<sessionDir>/registry/` 的落盘形状绑定） */
export const REGISTRY_STAGE_VERSION = 1

/** 暂存子目录名（`<sessionDir>/registry/`） */
export const REGISTRY_STAGE_SUBDIR = 'registry'
export const OVERLAY_HIVE_NAME = 'overlay.hive'
export const OVERLAY_JOURNAL_NAME = 'overlay.journal'
export const OVERLAY_STATE_NAME = 'overlay.state.json'
export const OVERLAY_DISCARDED_NAME = 'overlay.discarded.journal'

/** 候选来源标记：审批面板据此区分"文件候选"与"注册表候选"（顶层形状同构，只有 changes 不同） */
export const REGISTRY_CANDIDATE_SOURCE = 'registry-stage'
export const REGISTRY_CANDIDATE_ORIGIN = 'registry'

/**
 * 暂存操作类别（WAL 的 `kind` 字段）。
 * `HARD_DENY` 是**如实记录被拒调用**的那一类：shim 把返回给调用方的 LSTATUS
 * 一起写进日志，于是"哪些操作仍然是硬拒"成为**可审计的数据**，而不是文档里的承诺。
 *
 * `UNSTAGED`（kind 6，**契约 v1.4 追加，向后兼容**：1..5 的数值一个都没动）是
 * "覆盖层**根本无法复现**这次调用"那一类：这类调用**不再是** `ERROR_ACCESS_DENIED`
 * —— 硬拒会把"沙箱表示不了"伪装成"你没有权限"，而调用方对此无能为力。
 * 正确行为是 **透传真实 API**（真实系统自己决定成败），并留一条 UNSTAGED 审计记录，
 * 让"哪些写入从覆盖层漏到了真实 hive"成为可查的数据。
 * 为什么单独一类而不是复用 `HARD_DENY`：`HARD_DENY` 的 `status` 是**拒给调用方的
 * LSTATUS**（必须非 0），而 UNSTAGED 的 `status` 恒为 0（没有被拒）—— 两者混在一起，
 * 审计就分不清"被我们拒了"和"绕过我们直接生效了"。
 */
export const REG_STAGE_KIND = Object.freeze({
  CREATE_KEY: 1,
  DELETE_KEY: 2,
  SET_VALUE: 3,
  DELETE_VALUE: 4,
  HARD_DENY: 5,
  UNSTAGED: 6,
})

const KIND_NAME = Object.freeze(
  Object.fromEntries(Object.entries(REG_STAGE_KIND).map(([name, value]) => [value, name])),
)

/** WAL 记录标志位 */
export const REG_STAGE_FLAGS = Object.freeze({
  HARD_DENY: 0x0001,
  HAS_VALUE_NAME: 0x0002,
  HAS_DATA: 0x0004,
  VOLATILE: 0x0008,
  /** 这是一条"透传真实 API"的记录（kind=UNSTAGED 必须置位） */
  UNSTAGED: 0x0010,
})

/** `'DSRG'` 的小端 uint32（读出来等于 0x47525344） */
export const REG_STAGE_JOURNAL_MAGIC = 0x47525344

/**
 * WAL 定长头大小与逐字段偏移（**小端**）。
 *
 * C 侧对应结构体（`docs/T3-注册表暂存设计.md` §4 有逐字段表）：
 * ```c
 * #pragma pack(push, 4)
 * typedef struct DSH_REG_STAGE_RECORD {
 *     UINT32 magic;       //  0  'DSRG'
 *     UINT16 version;     //  4
 *     UINT16 kind;        //  6  REG_STAGE_KIND
 *     UINT16 type;        //  8  winreg.h REG_* （仅 SET_VALUE）
 *     UINT16 flags;       // 10
 *     UINT32 pathChars;   // 12  UTF-16 码元数（不含 NUL）
 *     UINT32 nameChars;   // 16  UTF-16 码元数（不含 NUL）
 *     UINT32 dataBytes;   // 20  原始字节数
 *     UINT32 status;      // 24  LSTATUS（HARD_DENY 时=返回给调用方的值）
 *     UINT32 reserved;    // 28  必须为 0
 * } DSH_REG_STAGE_RECORD; // 总大小 32
 * #pragma pack(pop)
 * ```
 * 负载紧跟头部：`path`(UTF-16LE) → `name`(UTF-16LE) → `data`(原始字节)。
 */
export const REG_STAGE_RECORD_OFFSETS = Object.freeze({
  magic: 0,
  version: 4,
  kind: 6,
  type: 8,
  flags: 10,
  pathChars: 12,
  nameChars: 16,
  dataBytes: 20,
  status: 24,
  reserved: 28,
  total: 32,
})

export const REG_STAGE_RECORD_SIZE = REG_STAGE_RECORD_OFFSETS.total

/** C ABI 版本（`DshRegStageAbiVersion()` 的返回值） */
export const REG_STAGE_ABI_VERSION = 1

/** 硬拒时返回给调用方的 LSTATUS（与原始沙箱行为一致：`ERROR_ACCESS_DENIED`） */
export const HARD_DENY_STATUS = REG_STATUS.ERROR_ACCESS_DENIED

/** 覆盖 hive 的加载选项（`[官方]` winreg.h） */
export const REG_LOAD_APP_KEY_FLAGS = Object.freeze({
  REG_PROCESS_APPKEY: 0x00000001,
  REG_USE_CURRENT_SECURITY_CONTEXT: 0x00000002,
})

/** `RegCreateKeyExW` 的 `dwOptions`（`[官方]` winreg.h） */
export const REG_OPTIONS = Object.freeze({
  REG_OPTION_NON_VOLATILE: 0x00000000,
  REG_OPTION_VOLATILE: 0x00000001,
  REG_OPTION_CREATE_LINK: 0x00000002,
  REG_OPTION_BACKUP_RESTORE: 0x00000004,
  REG_OPTION_OPEN_LINK: 0x00000008,
})

/** `RegDeleteKeyExW`/`RegOpenKeyExW` 的 WOW64 视图位（`[官方]` winreg.h） */
export const KEY_WOW64 = Object.freeze({
  KEY_WOW64_64KEY: 0x0100,
  KEY_WOW64_32KEY: 0x0200,
})

/** 可暂存的 hive（其余走硬拒） */
export const REG_HIVES_STAGEABLE = Object.freeze(['HKCR', 'HKCU', 'HKLM', 'HKU', 'HKCC'])

/**
 * 无法重定向的 hive → 理由。
 * `HKEY_PERFORMANCE_DATA` **没有后备配置单元文件**（它是性能计数器的伪 hive），
 * 没有可以挂载覆盖层的地方；`HKEY_PERFORMANCE_TEXT`/`NLSTEXT` 连
 * `registry-guard` 的 `HIVE_HANDLES` 都没有（`parseRegistryPath` 会抛 `REG_HIVE_UNKNOWN`）。
 */
export const REG_HIVES_HARD_DENY = Object.freeze({
  HKPD: 'HKEY_PERFORMANCE_DATA 是性能计数器伪 hive（无后备配置单元文件），没有可挂载覆盖层的位置',
})

/**
 * **合法但本模块没有编解码器**的值类型 ⇒ 硬拒。
 * 静默当成 `REG_BINARY` 会把语义改掉（例如 `REG_LINK` 是符号链接值）。
 * 该清单与 `registry-guard` 的编解码表**必须一致**；测试会逐个断言它们真的抛
 * `REG_TYPE_UNSUPPORTED`，因此清单不会漂移成"文档说拒、代码其实收"。
 */
export const REG_STAGE_UNSUPPORTED_TYPES = Object.freeze([
  'REG_LINK',
  'REG_RESOURCE_LIST',
  'REG_FULL_RESOURCE_DESCRIPTOR',
  'REG_RESOURCE_REQUIREMENTS_LIST',
])

/** 被 hook 的 8 个 API（T3 契约要求的最小集合） */
export const REG_STAGE_HOOKED_APIS = Object.freeze([
  'RegCreateKeyExW',
  'RegOpenKeyExW',
  'RegSetValueExW',
  'RegQueryValueExW',
  'RegDeleteKeyExW',
  'RegDeleteValueW',
  'RegEnumKeyExW',
  'RegEnumValueW',
])

/**
 * 明确**不**支持、且必须 fail-closed 的 API。
 *
 * 为什么不能"尽力而为"地放过：这些调用的语义覆盖层复现不了
 * （整棵 hive 的加载/保存/替换、事务、重命名、SD 改写、远程 hive），
 * 放过它们会让"暂存成功"与"真实结果"分叉 —— 比直接失败更糟。
 */
export const REG_STAGE_HARD_DENY_APIS = Object.freeze({
  RegSetKeySecurity:
    'app hive 内所有键共享同一个安全描述符，且 [官方] 明确禁止对 app hive 内的键调用 RegSetKeySecurity ⇒ SD 变更无法暂存',
  RegLoadKey: '整棵 hive 的加载不在覆盖范围内（会改变全局命名空间）',
  RegUnLoadKey: '整棵 hive 的卸载不在覆盖范围内',
  RegSaveKey: '整棵 hive 的导出不在覆盖范围内（会把覆盖层当成真实 hive 落盘）',
  RegSaveKeyEx: '整棵 hive 的导出不在覆盖范围内',
  RegRestoreKey: '整棵 hive 的还原不在覆盖范围内',
  RegReplaceKey: '整棵 hive 的替换不在覆盖范围内',
  RegRenameKey: '键重命名没有对应的暂存语义（覆盖层按路径索引，重命名会破坏候选的路径身份）',
  RegCopyTree: '跨键整树复制不在覆盖范围内（RegCopyTreeW 未被 hook）',
  RegCreateKeyTransactedW: '事务注册表 API 与覆盖层的事务语义不同，暂存会给出虚假的原子性',
  RegDeleteKeyTransactedW: '事务注册表 API 与覆盖层的事务语义不同',
  RegOpenKeyTransactedW: '事务注册表 API 与覆盖层的事务语义不同',
  RegConnectRegistryW: '远程注册表句柄不可能被重定向到本地覆盖层',
  RegConnectRegistryExW: '远程注册表句柄不可能被重定向到本地覆盖层',
  RegOverridePredefKey:
    '预定义键重定向会把覆盖层的路径映射整体打乱（它是"另一个 8.3 级别的重定向器"，与覆盖层叠加无法推理）',
  RegOpenUserClassesRoot: '按令牌打开的 HKCR 视图没有稳定的可暂存路径身份',
  RegOpenCurrentUser: '按令牌打开的 HKCU 视图没有稳定的可暂存路径身份',
  NtCreateKey: '原生 API 绕过 Reg* 层；覆盖层只 hook winreg 的 8 个入口，必须 fail-closed',
  NtOpenKey: '原生 API 绕过 Reg* 层（见 NtCreateKey）',
  NtSetValueKey: '原生 API 绕过 Reg* 层（见 NtCreateKey）',
  NtDeleteKey: '原生 API 绕过 Reg* 层（见 NtCreateKey）',
  NtDeleteValueKey: '原生 API 绕过 Reg* 层（见 NtCreateKey）',
  ZwCreateKey: '原生 API 的 Zw 别名，同样绕过 Reg* 层',
  ZwOpenKey: '原生 API 的 Zw 别名，同样绕过 Reg* 层',
  ZwSetValueKey: '原生 API 的 Zw 别名，同样绕过 Reg* 层',
})

/** `dwOptions` 里无法暂存的位 ⇒ 硬拒 */
export const REG_STAGE_HARD_DENY_OPTIONS = Object.freeze([
  {
    flag: REG_OPTIONS.REG_OPTION_CREATE_LINK,
    name: 'REG_OPTION_CREATE_LINK',
    reason: '符号链接键（REG_OPTION_CREATE_LINK）在覆盖层里没有等价物；暂存它会让"链接"变成"普通键"',
  },
  {
    flag: REG_OPTIONS.REG_OPTION_BACKUP_RESTORE,
    name: 'REG_OPTION_BACKUP_RESTORE',
    reason: 'REG_OPTION_BACKUP_RESTORE 会绕过 ACL 并改变句柄语义，覆盖层无法忠实复现',
  },
  {
    flag: REG_OPTIONS.REG_OPTION_OPEN_LINK,
    name: 'REG_OPTION_OPEN_LINK',
    reason: 'REG_OPTION_OPEN_LINK 要求打开链接本身而非目标，覆盖层没有链接对象',
  },
])

/**
 * `samDesired` 里**仍然是硬拒**的位 ⇒ **空集**（契约 v1.4）。
 *
 * 为什么空了：WOW64 视图位**不是**"我们不给你做"的权限问题，而是"这个位置覆盖层
 * 里不存在"的**表示问题**，两者必须分开（见 §8.3 与 `REG_STAGE_UNSTAGED_SAM`）。
 * 这个导出仍然保留（空数组），因此引用它的代码/文档不会断。
 */
export const REG_STAGE_HARD_DENY_SAM = Object.freeze([])

/**
 * `samDesired` 里**覆盖层无法复现**的视图位 ⇒ 记 `UNSTAGED` **透传真实 API**（契约 v1.4）。
 *
 * 逐条理由（这是本条契约最容易想当然的地方）：
 *   · `KEY_WOW64_64KEY` 在 **64 位进程里是[官方]文档化的 no-op**（winreg.h：
 *     "this flag has no effect on a 64-bit process"）。把它当硬拒，会让任何
 *     "创建一个还不存在的键（`RegCreateKeyExW` + `KEY_WOW64_64KEY`）"的调用拿到
 *     `ERROR_ACCESS_DENIED(5)` —— 实测受害者是 CLR（`0x80070005` ⇒ "Starting the
 *     CLR failed"）与 node 的 Winsock 启动。因此默认进程模型（`wow64Process: false`，
 *     也就是本 x64 shim 唯一能加载的模型）下它是**弃位**：既不拒、也不是视图请求，
 *     走**正常暂存**路径。
 *   · `KEY_WOW64_32KEY` 指向的是**另一个 hive 位置**（32 位视图）。app hive 没有
 *     "视图"概念，混成一个会**写到错误的位置** ⇒ 不可暂存。但"不可暂存"≠"没权限"：
 *     真实 API 知道该去哪，所以**透传** + `UNSTAGED` 记录。
 *   · WOW64 进程里两个位都真的指向另一个视图 ⇒ 都按不可暂存处理。本 DLL 是 x64，
 *     不会被注入 WOW64 进程；这一条属于契约自身的完备性（`wow64Process: true`）。
 */
export const REG_STAGE_UNSTAGED_SAM = Object.freeze([
  {
    flag: KEY_WOW64.KEY_WOW64_64KEY,
    name: 'KEY_WOW64_64KEY',
    appliesTo: 'wow64-process',
    reason:
      'KEY_WOW64_64KEY 在 64 位进程里是文档化的 no-op（不是视图请求 ⇒ 必须走正常暂存路径）；' +
      '只有 WOW64 进程里它才真的指向另一个 hive 位置，那时按 unstaged 透传（x64 shim 不会被注入 WOW64 进程）',
  },
  {
    flag: KEY_WOW64.KEY_WOW64_32KEY,
    name: 'KEY_WOW64_32KEY',
    appliesTo: 'any',
    reason:
      'KEY_WOW64_32KEY 指向**另一个 hive 位置**（32 位视图），覆盖层没有视图概念：暂存它会把值写到错的位置 ⇒ ' +
      '不可暂存 ⇒ 透传真实 API 并记 UNSTAGED（不再是 ERROR_ACCESS_DENIED 硬拒）',
  },
])

/**
 * `UNSTAGED` 记录的 `type` 字段 = 不可暂存的**原因码**（契约 v1.4，C 侧数值必须一致）。
 * 为什么用 `type` 而不是把原因塞进 `path`：`path` 必须留成**规范路径**，
 * 否则"哪个键被透传了"就查不到了；而 `type` 对非 `SET_VALUE` 记录本来就是 0（无意义）。
 */
export const REG_STAGE_UNSTAGED_REASON = Object.freeze({
  WOW64_32KEY: 1,
  WOW64_VIEW_IN_WOW64_PROCESS: 2,
  UNRESOLVABLE_BASE_HANDLE: 3,
  BARE_HIVE_ROOT: 4,
})

const UNSTAGED_REASON_NAME = Object.freeze(
  Object.fromEntries(Object.entries(REG_STAGE_UNSTAGED_REASON).map(([name, value]) => [value, name])),
)

/** 暂存操作名（纯层用字符串，便于落盘与人类核对） */
export const REG_STAGE_OP = Object.freeze({
  CREATE_KEY: 'create-key',
  DELETE_KEY: 'delete-key',
  SET_VALUE: 'set-value',
  DELETE_VALUE: 'delete-value',
})

const API_BY_OP = Object.freeze({
  'create-key': 'RegCreateKeyExW',
  'delete-key': 'RegDeleteKeyExW',
  'set-value': 'RegSetValueExW',
  'delete-value': 'RegDeleteValueW',
})

const KIND_BY_OP = Object.freeze({
  'create-key': REG_STAGE_KIND.CREATE_KEY,
  'delete-key': REG_STAGE_KIND.DELETE_KEY,
  'set-value': REG_STAGE_KIND.SET_VALUE,
  'delete-value': REG_STAGE_KIND.DELETE_VALUE,
})

const OP_BY_KIND = Object.freeze({
  [REG_STAGE_KIND.CREATE_KEY]: 'create-key',
  [REG_STAGE_KIND.DELETE_KEY]: 'delete-key',
  [REG_STAGE_KIND.SET_VALUE]: 'set-value',
  [REG_STAGE_KIND.DELETE_VALUE]: 'delete-value',
})

/** 候选变更单元里表示"未命名（默认）值"的显示后缀（regedit 显示为 `(默认)`） */
export const DEFAULT_VALUE_SUFFIX = '\\@'

// ─────────────────────────── 错误构造 ───────────────────────────

function stageError(code, message, extra = {}) {
  const error = Object.assign(new Error(message), { code }, extra)
  return error
}

function policyRejection(verdict) {
  return stageError('REG_STAGE_HARD_DENY', `registry-stage refuses this operation: ${verdict.reason}`, {
    policyCode: verdict.code,
    status: verdict.status,
    api: verdict.api,
    path: verdict.canonical,
  })
}

// ─────────────────────── 纯函数：路径与映射 ───────────────────────

function assertNonEmptyString(value, what) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`registry-stage: ${what} must be a non-empty string`)
  }
  return value
}

/** `<sessionDir>/registry`（覆盖区根） */
export function resolveRegistryStageRoot(sessionDir) {
  return join(assertNonEmptyString(sessionDir, 'sessionDir'), REGISTRY_STAGE_SUBDIR)
}

/** **shim 契约的核心纯函数**：覆盖 hive 文件的绝对路径 */
export function resolveRegistryStagePath(sessionDir) {
  return join(resolveRegistryStageRoot(sessionDir), OVERLAY_HIVE_NAME)
}

/** WAL 日志的绝对路径（DLL 追加、宿主解析，双方必须用同一个） */
export function resolveRegistryStageJournalPath(sessionDir) {
  return join(resolveRegistryStageRoot(sessionDir), OVERLAY_JOURNAL_NAME)
}

/** 宿主侧"已解决状态"（applied/partially-applied/discarded）的落盘路径 */
export function resolveRegistryStageStatePath(sessionDir) {
  return join(resolveRegistryStageRoot(sessionDir), OVERLAY_STATE_NAME)
}

/** 丢弃后 WAL 的审计副本路径 */
export function resolveRegistryStageDiscardedPath(sessionDir) {
  return join(resolveRegistryStageRoot(sessionDir), OVERLAY_DISCARDED_NAME)
}

/**
 * 真实路径 → 覆盖 hive 内的子键路径。
 *
 * **映射恒等**（只做规范名归一）：`HKEY_LOCAL_MACHINE\Software\X` → `HKLM\Software\X`。
 * 之所以能恒等，是因为覆盖 hive 每个会话独占、其根句柄本身就是"特殊的根"，
 * 所以真实 hive 的根名可以直接当成覆盖 hive 的**第一层子键名**，
 * 不需要任何编码/转义（`software\...` 之类的相对路径永远不会被当成根）。
 *
 * @throws `REG_HIVE_UNKNOWN` 当根键不是已知预定义键时（**不猜**）
 */
export function overlaySubKeyFor(registryPath) {
  return parseRegistryPath(registryPath).canonical
}

/** 逆映射（与 `overlaySubKeyFor` 互为往返；两侧都走同一个规范化） */
export function canonicalFromOverlaySubKey(overlaySubKey) {
  return parseRegistryPath(overlaySubKey).canonical
}

/**
 * 覆盖 hive 内需要逐级创建/打开的容器链（**不含裸 hive 根**，含目标自身）。
 * DLL 用它决定"要在 app hive 里先建哪几层"；宿主用它决定 diff 要覆盖哪些路径。
 * `HKLM\Software\X` → `['HKLM\\Software', 'HKLM\\Software\\X']`。
 */
export function overlayContainerChain(registryPath) {
  const { canonical } = parseRegistryPath(registryPath)
  const parts = canonical.split('\\')
  const chain = []
  for (let index = 1; index < parts.length; index += 1) chain.push(parts.slice(0, index + 1).join('\\'))
  return chain
}

function fold(value) {
  return String(value).toLowerCase()
}

function lastSegment(registryPath) {
  const index = registryPath.lastIndexOf('\\')
  return index === -1 ? registryPath : registryPath.slice(index + 1)
}

function segmentsOf(registryPath) {
  return registryPath.split('\\').filter((part) => part.length > 0)
}

function isDirectChildFold(parentFold, childFold) {
  if (!childFold.startsWith(`${parentFold}\\`)) return false
  return !childFold.slice(parentFold.length + 1).includes('\\')
}

function isDescendantFold(parentFold, childFold) {
  return childFold.startsWith(`${parentFold}\\`)
}

function ancestorFolds(canonical) {
  const parts = canonical.split('\\')
  const ancestors = []
  for (let index = 1; index < parts.length; index += 1) ancestors.push(fold(parts.slice(0, index).join('\\')))
  return ancestors
}

/** 变更单元路径：值单元带名字，未命名（默认）值用 `\@` 约定 */
export function registryValueUnitPath(keyPath, valueName) {
  return typeof valueName === 'string' && valueName.length > 0 ? `${keyPath}\\${valueName}` : `${keyPath}${DEFAULT_VALUE_SUFFIX}`
}

// ──────────────────── 纯函数：策略（哪些仍是硬拒）────────────────────

/**
 * 判定一次注册表操作能否被暂存。
 *
 * 返回值永远是**数据**（不抛错）：`{ stageable, code, status, reason, ... }`，
 * 因为 shim 需要把 `status` 原样返回给调用方（LSTATUS），
 * 而审批面需要人可读的 `reason`。
 *
 * 三种结论（契约 v1.4；调用方**必须**三分支处理，不能再把 `stageable === false`
 * 一律当成"返回 status 拒绝"）：
 *   1. `stageable: true`                  ⇒ 暂存进覆盖层；
 *   2. `stageable: false, unstaged: true` ⇒ 覆盖层**无法复现**这次调用：**透传真实 API**
 *      （`status` 取真实 API 的返回值；`status` 字段本身是 `ERROR_SUCCESS`，因为
 *      "我们没拒你"），并记一条 `UNSTAGED` 审计记录；
 *   3. 其余 `stageable: false`            ⇒ 硬拒：把 `verdict.status` 返回给调用方。
 *
 * @param {{api: string, path?: string, type?: string|number, dwOptions?: number, samDesired?: number, wow64Process?: boolean}} operation
 *   `wow64Process`：调用方是否运行在 WOW64 进程里。默认 `false`（= 64 位进程），
 *   这正是本 x64 shim 唯一可能出现的形态。
 */
export function classifyRegistryOperation(operation = {}) {
  const api = operation.api
  if (typeof api !== 'string' || api.length === 0) {
    throw stageError('REG_STAGE_POLICY_INVALID', 'classifyRegistryOperation: operation.api is required')
  }
  const deny = (code, reason, extra = {}) => ({
    stageable: false,
    code,
    status: HARD_DENY_STATUS,
    reason,
    api,
    ...extra,
  })
  /** 不可暂存但**不是**权限问题：透传真实 API（见函数头 2.） */
  const unstaged = (code, reason, unstagedReason, extra = {}) => ({
    stageable: false,
    unstaged: true,
    code,
    status: REG_STATUS.ERROR_SUCCESS,
    unstagedReason,
    reason,
    api,
    ...extra,
  })

  const knownDeny = REG_STAGE_HARD_DENY_APIS[api]
  if (knownDeny !== undefined) return deny('REG_STAGE_API_HARD_DENY', `${api}: ${knownDeny}`)
  if (!REG_STAGE_HOOKED_APIS.includes(api)) {
    return deny(
      'REG_STAGE_API_NOT_HOOKED',
      `${api} 不在被 hook 的 ${REG_STAGE_HOOKED_APIS.length} 个 API 之内；未 hook 的调用无法被暂存，必须 fail-closed`,
    )
  }

  const dwOptions = operation.dwOptions ?? 0
  if (!Number.isInteger(dwOptions) || dwOptions < 0) {
    throw stageError('REG_STAGE_POLICY_INVALID', `dwOptions must be a non-negative integer, got ${String(operation.dwOptions)}`)
  }
  for (const option of REG_STAGE_HARD_DENY_OPTIONS) {
    if ((dwOptions & option.flag) !== 0) return deny('REG_STAGE_OPTION_HARD_DENY', `${api}: ${option.reason}`, { flag: option.name })
  }
  const samDesired = operation.samDesired ?? 0
  if (!Number.isInteger(samDesired) || samDesired < 0) {
    throw stageError('REG_STAGE_POLICY_INVALID', `samDesired must be a non-negative integer, got ${String(operation.samDesired)}`)
  }
  for (const sam of REG_STAGE_HARD_DENY_SAM) {
    if ((samDesired & sam.flag) !== 0) return deny('REG_STAGE_SAM_HARD_DENY', `${api}: ${sam.reason}`, { flag: sam.name })
  }
  const wow64Process = operation.wow64Process === true
  for (const sam of REG_STAGE_UNSTAGED_SAM) {
    if ((samDesired & sam.flag) === 0) continue
    if (sam.appliesTo === 'wow64-process' && !wow64Process) continue // 64 位进程里它是 no-op，不构成视图请求
    return unstaged('REG_STAGE_SAM_UNSTAGED', `${api}: ${sam.reason}`, sam.name === 'KEY_WOW64_32KEY' ? 'WOW64_32KEY' : 'WOW64_VIEW_IN_WOW64_PROCESS', {
      flag: sam.name,
      samDesired,
    })
  }

  let parsed
  try {
    parsed = parseRegistryPath(operation.path)
  } catch (error) {
    if (error.code === 'REG_HIVE_UNKNOWN') {
      // 非预定义根的句柄（例如原生 API 拿到的句柄、或相对路径）：**不猜**，直接硬拒。
      return deny('REG_STAGE_ROOT_UNKNOWN', `${api}: ${error.message}`)
    }
    throw error
  }

  const hiveDeny = REG_HIVES_HARD_DENY[parsed.hive]
  if (hiveDeny !== undefined) return deny('REG_STAGE_HIVE_HARD_DENY', `${api}: ${hiveDeny}`, { hive: parsed.hive })
  if (!REG_HIVES_STAGEABLE.includes(parsed.hive)) {
    return deny('REG_STAGE_HIVE_HARD_DENY', `${api}: ${parsed.hive} 不在可暂存 hive 列表内`, { hive: parsed.hive })
  }

  let typeName
  if (operation.type !== undefined && operation.type !== null) {
    try {
      typeName = registryTypeName(operation.type)
    } catch (error) {
      return deny('REG_TYPE_UNKNOWN', `${api}: ${error.message}`, { hive: parsed.hive, canonical: parsed.canonical })
    }
    if (REG_STAGE_UNSUPPORTED_TYPES.includes(typeName)) {
      return deny(
        'REG_TYPE_UNSUPPORTED',
        `${api}: ${typeName} 在本模块没有编解码器；静默当成 REG_BINARY 会改掉语义，因此硬拒`,
        { hive: parsed.hive, canonical: parsed.canonical, type: typeName },
      )
    }
  }

  return {
    stageable: true,
    code: 'REG_STAGE_OK',
    status: REG_STATUS.ERROR_SUCCESS,
    reason: 'stageable',
    api,
    hive: parsed.hive,
    subKey: parsed.subKey,
    canonical: parsed.canonical,
    type: typeName,
    flags: {
      volatile: (dwOptions & REG_OPTIONS.REG_OPTION_VOLATILE) !== 0,
      /** 裸 hive 根（`HKCU` 自身）：永远存在 ⇒ create-key 是净变化为零的"打开已有键" */
      bareRoot: parsed.subKey.length === 0,
    },
  }
}

/**
 * "仍然是硬拒"的**数据化清单**（文档与测试都引用它，避免两处漂移）。
 * 分为四类：hive / API / 选项掩码 / 值类型；`semantic` 一栏是第五类，
 * 它不是 API 级的拒绝，而是"即使暂存成功、系统也不认"的**固有残余**。
 */
export const REGISTERED_HARD_DENIALS = Object.freeze({
  hives: Object.freeze(
    Object.entries(REG_HIVES_HARD_DENY).map(([hive, reason]) => ({ hive, reason })),
  ),
  apis: Object.freeze(
    Object.entries(REG_STAGE_HARD_DENY_APIS).map(([api, reason]) => ({ api, reason })),
  ),
  options: Object.freeze(REG_STAGE_HARD_DENY_OPTIONS.map((entry) => ({ name: entry.name, reason: entry.reason }))),
  sam: Object.freeze(REG_STAGE_HARD_DENY_SAM.map((entry) => ({ name: entry.name, reason: entry.reason }))),
  /**
   * **不可暂存 ⇒ 透传** 的清单（契约 v1.4）。与上面四类并列，因为它是**第三类结论**：
   * 既不是"暂存成功"，也不是"被拒"—— 调用被交给真实 API，只留一条 `UNSTAGED` 审计记录。
   * 把这些混进 `apis`/`sam`（硬拒）里，就是把"沙箱表示不了"说成"你没权限"。
   */
  unstaged: Object.freeze([
    ...REG_STAGE_UNSTAGED_SAM.map((entry) => ({ kind: 'sam', name: entry.name, reason: entry.reason })),
    {
      kind: 'handle',
      name: 'REG_STAGE_ROOT_UNKNOWN',
      reason:
        '无法从预定义根派生规范路径的句柄（原生 API 句柄 / RegConnectRegistry 句柄 / 跨进程裸句柄）：覆盖层给不出路径，就**不猜**；' +
        '真实 API 认识这个句柄，所以透传真实调用（旧行为是硬拒 5 —— 那是在回答一个调用方没问的问题）',
    },
    {
      kind: 'handle',
      name: 'BARE_HIVE_ROOT_VALUE_WRITE',
      reason:
        '裸 hive 根（`HKCU` 自身）上的 set-value/delete-value/delete-key：覆盖层里"根"不是可写目标（app hive 的根不能当路径用），' +
        '但真实 API 上这些调用是合法的 ⇒ 透传真实根句柄；create-key 对裸根仍是纯打开（净变化为零，不入 WAL）',
    },
  ]),
  types: Object.freeze(
    REG_STAGE_UNSUPPORTED_TYPES.map((type) => ({
      type,
      reason: `${type} 没有编解码器（registry-guard 的 VALUE_ENCODERS/DECODERS 不含它）`,
    })),
  ),
  /**
   * **语义级**残余：不是"调用被拒"，而是"调用成功但系统不认"。
   * 诚实性要求把它与上面四类并列写出，而不是藏在某一节里。
   */
  semantic: Object.freeze([
    '覆盖层只影响被 hook 的 Reg* 调用；NtSetValueKey/ZwSetValueKey、直接写 NTUSER.DAT/SYSTEM、未注入的 reg.exe/regedit 照样命中真实 hive',
    '写进覆盖层 ≠ 系统生效：服务/COM/驱动/启动项读的是真实 hive（例如 HKCU\\...\\Run 不会真的开机自启）',
    '安全描述符变更无法暂存（app hive 全键共享一个 SD，且禁止 RegSetKeySecurity）',
    'HKEY_USERS\\<其他用户> 的候选可以冻结，但应用时需要加载对方的 hive（管理员；否则 apply 报失败）',
    'REG_OPTION_VOLATILE 键在覆盖层里是文件型 hive，"重启即失"的语义要等应用时按 volatile 选项重建才成立',
    '读取面没有被覆盖：覆盖层只覆盖"本会话暂存过的路径"，其余读取仍走真实 hive（受限令牌下可能读不到）',
  ]),
})

// ──────────────────── 纯函数：覆盖层状态（WAL 模型）────────────────────

/**
 * 覆盖层状态 = **只追加的操作日志**（+ 头部）。
 *
 * 为什么不是"最终键值快照"：真实 API 是**有顺序**的
 * （`delete-key X` 之后再 `create-key X` 得到的是一棵**空**的 X，而不是原来的 X）。
 * 只有保留顺序、并且**应用时逐条重放**，真实 hive 的终态才与沙箱内观察到的终态一致。
 * 键值快照会把这个顺序信息压掉，从而产生"沙箱里是空的、应用后还是旧的"这类分叉。
 */
export function createOverlayState(options = {}) {
  return {
    version: REGISTRY_STAGE_VERSION,
    sessionId: typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : null,
    createdAt: typeof options.createdAt === 'string' ? options.createdAt : null,
    seq: 0,
    ops: [],
  }
}

function cloneState(state) {
  return { ...state, ops: [...state.ops] }
}

/**
 * 把一次操作追加进覆盖层（**返回新状态**，不就地改）。
 *
 * `create-key` 会**补齐容器链**（对齐 `RegCreateKeyExW` 创建中间键的语义），
 * 且跳过"已经被记录为存在"的层级，避免日志膨胀。
 *
 * @throws `REG_STAGE_HARD_DENY`（policy 失败，带 `status`）/ `REG_STAGE_OP_UNKNOWN`
 *   `unstaged`（覆盖层无法复现）**不抛错**：返回**原状态**（覆盖层里什么都没发生）。
 */
export function applyOverlayOperation(state, operation = {}) {
  if (!state || state.version !== REGISTRY_STAGE_VERSION) {
    throw stageError('REG_STAGE_STATE_INVALID', 'applyOverlayOperation: state must come from createOverlayState()')
  }
  const op = operation.op
  const api = API_BY_OP[op]
  if (api === undefined) {
    throw stageError('REG_STAGE_OP_UNKNOWN', `applyOverlayOperation: unknown op ${JSON.stringify(op)}`)
  }
  const verdict = classifyRegistryOperation({
    api,
    path: operation.path,
    type: operation.type,
    dwOptions: operation.dwOptions,
    samDesired: operation.samDesired,
    wow64Process: operation.wow64Process,
  })
  if (verdict.unstaged === true) {
    // 覆盖层**无法复现**这次调用（例如 KEY_WOW64_32KEY 的另一个视图）：
    // 结论是"覆盖层里什么都不该发生"—— 既不加条目，也**不抛错**（抛错会被上游当成"被拒"，
    // 而真实 API 才是这次调用的裁决者）。审计记录由 `journalUnstagedRecord()` 单独产出。
    return cloneState(state)
  }
  if (!verdict.stageable) throw policyRejection(verdict)

  const canonical = verdict.canonical
  const next = cloneState(state)
  const push = (entry) => {
    next.seq += 1
    next.ops.push({ seq: next.seq, ...entry })
  }

  if (op === 'create-key') {
    // 裸 hive 根（`HKCU` / `HKLM` …）**永远存在**，`RegCreateKeyExW` 对它只可能是
    // "打开已有键" ⇒ 净变化为零 ⇒ **不入 WAL**。
    // （实测由来：`RegOpenKeyExW overlay hit ` 那条空键名日志，以及
    //  `HKCU\Software` 被一个空壳 create-key 遮蔽后枚举只剩覆盖层子键的阻塞级缺陷。）
    if (overlayContainerChain(canonical).length === 0) return next
    // 逐级补齐容器链（对齐 RegCreateKeyExW 创建中间键的语义）；已记录为存在的层级跳过，
    // 因此重复的 create-key 不会把日志撑大。
    // `REG_OPTION_VOLATILE` 只标在**目标键**上：中间键由 API 隐式创建，不继承调用方的 volatile 选项。
    const volatile = (operation.dwOptions ?? 0) & REG_OPTIONS.REG_OPTION_VOLATILE ? true : false
    const chain = overlayContainerChain(canonical)
    for (const level of chain) {
      if (overlayKeyExists(next, level) === true) continue
      push({ op, path: level, volatile: volatile && fold(level) === fold(canonical) })
    }
    return next
  }

  if (op === 'delete-key') {
    if (overlayContainerChain(canonical).length === 0) {
      // 预定义根不能被删除：这不是"暂存不了"，而是**语义上无意义**（真实 API 也会失败）。
      throw stageError(
        'REG_STAGE_ROOT_READONLY',
        `delete-key on the predefined root ${canonical} is meaningless: the root always exists and cannot be removed`,
        { status: HARD_DENY_STATUS, path: canonical },
      )
    }
    push({ op, path: canonical })
    return next
  }

  // set-value / delete-value
  const valueName = typeof operation.valueName === 'string' ? operation.valueName : ''
  if (op === 'set-value') {
    const entry = { op, path: canonical, valueName, typeName: verdict.type }
    entry.data = encodeRegistryValue(verdict.type, operation.value)
    push(entry)
    return next
  }
  push({ op, path: canonical, valueName })
  return next
}

/**
 * 逐条判定 WAL 操作是否**有净变化**（纯函数；需要"真实 hive 视图" `baselineFor`）。
 *
 * 为什么要有这一层（`[实测]` 2026-09-30 的阻塞级缺陷的**根因之一**）：
 * `RegCreateKeyExW` 是"打开或创建"。.NET / PowerShell 会对**已存在**的真实键
 * （例如 `HKCU\Software\Microsoft\SystemCertificates\CA\Certificates`）调用它；
 * 若 DLL 把它当成"创建"写进覆盖层，就留下一个**空壳**，而覆盖层一旦有键目录，
 * "只列覆盖层"的枚举就会把真实子键全部遮掉 ⇒ 证书存储读空 ⇒ PowerShell 起不来。
 * 所以契约要求：**净变化为零的操作不得产生覆盖层条目、不得入候选**（与文件侧
 * "内容与基线相同 ⇒ 不入候选" 同一纪律）。
 *
 * 判定口径（逐条对齐真实 API，不看"调用发生过"而看"状态变没变"）：
 *   · `create-key`：真实（或本次 WAL 到此为止的）视图里**已存在** ⇒ `no-op`；
 *   · `delete-key`：视图里**不存在** ⇒ `no-op`；
 *   · `set-value`：类型与数据都与现值**逐字节相同** ⇒ `no-op`；
 *   · `delete-value`：值不存在 ⇒ `no-op`；
 *   · 基线**读不到**（`accessDenied`）⇒ `unknown`，既不算 net 也不算 no-op（不猜）。
 *
 * @returns {{operations: Array<{index:number, seq:number, op:string, path:string, effect:'net'|'no-op'|'unknown', reason:string}>, summary:{total:number,net:number,noop:number,unknown:number}, hasNetChange:boolean}}
 */
export function classifyOverlayNetEffect({ state, baselineFor }) {
  if (!state || state.version !== REGISTRY_STAGE_VERSION) {
    throw stageError('REG_STAGE_STATE_INVALID', 'classifyOverlayNetEffect: state must come from createOverlayState()')
  }
  if (typeof baselineFor !== 'function') {
    throw stageError(
      'REG_READER_MISSING',
      'classifyOverlayNetEffect requires baselineFor(path): without the real hive you cannot tell an open from a create',
    )
  }
  const snapshotCache = new Map()
  const base = (canonical) => {
    const key = fold(canonical)
    if (!snapshotCache.has(key)) snapshotCache.set(key, baselineFor(canonical))
    return snapshotCache.get(key)
  }
  const exists = new Map() // fold -> true | false | 'unknown'
  const values = new Map() // fold -> { foldName: {name,type,data} } | 'unknown'
  const unreadableReason = new Map() // fold -> 为什么判不了（WP12：未知必须带可读原因）
  const ensure = (canonical) => {
    const key = fold(canonical)
    if (!exists.has(key)) {
      const snapshot = base(canonical)
      if (snapshot.accessDenied === true || snapshot.unreadable === true) {
        exists.set(key, 'unknown')
        values.set(key, 'unknown')
        unreadableReason.set(
          key,
          snapshot.unreadableReason ??
            (snapshot.accessDenied === true ? 'the baseline read was denied (ERROR_ACCESS_DENIED)' : 'the baseline could not be read'),
        )
      } else {
        exists.set(key, snapshot.exists === true)
        const map = {}
        for (const [name, entry] of Object.entries(snapshot.values ?? {})) map[fold(name)] = { name, type: entry.type, data: entry.data }
        values.set(key, map)
      }
    }
    return key
  }
  const why = (key) => {
    const reason = unreadableReason.get(key)
    return reason === undefined ? '' : ` (${reason})`
  }

  const operations = []
  for (const [index, entry] of state.ops.entries()) {
    const canonical = parseRegistryPath(entry.path).canonical
    const key = ensure(canonical)
    const valueName = typeof entry.valueName === 'string' ? entry.valueName : ''
    let effect = 'net'
    let reason = 'state changes relative to the real hive'

    if (entry.op === REG_STAGE_OP.CREATE_KEY) {
      if (exists.get(key) === 'unknown') {
        effect = 'unknown'
        reason = `baseline is unreadable: cannot tell whether this is an open or a create${why(key)}`
      } else if (exists.get(key) === true) {
        effect = 'no-op'
        reason = 'key already exists in the real hive: RegCreateKeyExW is "open or create", a pure open must not create an overlay entry'
      } else {
        exists.set(key, true)
        values.set(key, {})
      }
    } else if (entry.op === REG_STAGE_OP.DELETE_KEY) {
      if (exists.get(key) === 'unknown') {
        effect = 'unknown'
        reason = `baseline is unreadable${why(key)}`
      } else if (exists.get(key) === false) {
        effect = 'no-op'
        reason = 'key does not exist in the real hive: nothing to delete'
      } else {
        exists.set(key, false)
        values.set(key, {})
      }
    } else if (entry.op === REG_STAGE_OP.SET_VALUE) {
      const map = values.get(key)
      if (map === 'unknown') {
        effect = 'unknown'
        reason = `baseline is unreadable${why(key)}`
      } else {
        const current = map[fold(valueName)]
        if (current && current.type === entry.typeName && current.data === entry.data) {
          effect = 'no-op'
          reason = 'the value already has exactly this type and data'
        } else {
          map[fold(valueName)] = { name: valueName, type: entry.typeName, data: entry.data }
          if (exists.get(key) === false) exists.set(key, true)
        }
      }
    } else if (entry.op === REG_STAGE_OP.DELETE_VALUE) {
      const map = values.get(key)
      if (map === 'unknown') {
        effect = 'unknown'
        reason = `baseline is unreadable${why(key)}`
      } else if (!map[fold(valueName)]) {
        effect = 'no-op'
        reason = 'value does not exist in the real hive: nothing to delete'
      } else {
        delete map[fold(valueName)]
      }
    } else {
      effect = 'unknown'
      reason = `unknown op ${entry.op}`
    }
    operations.push({ index, seq: entry.seq, op: entry.op, path: canonical, valueName: valueName || undefined, effect, reason })
  }

  const summary = operations.reduce(
    (acc, operation) => {
      acc[operation.effect === 'no-op' ? 'noop' : operation.effect] += 1
      return acc
    },
    { total: operations.length, net: 0, noop: 0, unknown: 0 },
  )
  return { operations, summary, hasNetChange: summary.net > 0 }
}

/**
 * 单条操作的净变化判定 + "只保留净变化"的**过滤后状态**。
 *
 * 这是宿主侧参考实现，也是给 DLL 的口径：**由净变化决定要不要 Append**。
 * `create-key` 会展开容器链，其中"真实已存在"的层级是 no-op，必须**丢弃**
 * （否则 WAL 里会留下一堆空操作，候选/应用两边都会被它们污染）。
 *
 * @returns {{effect: 'net'|'no-op'|'unknown', reason: string, added: object[], state: object}}
 *   `state` 是"原状态 + 仅净变化的那几条 op"
 */
export function filterOverlayNetOperations({ state, baselineFor, operation }) {
  const before = classifyOverlayNetEffect({ state, baselineFor })
  const expanded = applyOverlayOperation(state, operation)
  const after = classifyOverlayNetEffect({ state: expanded, baselineFor })
  const added = after.operations.slice(before.operations.length)
  if (added.length === 0) {
    return { effect: 'no-op', reason: 'the operation produced no overlay entry (net change is zero)', added: [], state }
  }
  const netAdded = added.filter((entry) => entry.effect === 'net')
  const unknownAdded = added.filter((entry) => entry.effect === 'unknown')
  const keptOps = netAdded.map((entry) => expanded.ops[entry.index])
  const ops = [...state.ops, ...keptOps]
  const seq = ops.reduce((max, entry) => Math.max(max, entry.seq ?? 0), state.seq)
  const nextState = { ...state, ops, seq }
  const effect = netAdded.length > 0 ? 'net' : unknownAdded.length > 0 ? 'unknown' : 'no-op'
  const reason = netAdded.length > 0 ? `kept ${netAdded.length} net operation(s)` : unknownAdded.length > 0 ? unknownAdded[0].reason : added[0].reason
  return { effect, reason, added, state: nextState }
}

/** 某路径**自身**最后一条操作（`undefined` = 覆盖层没有表过态，交给基线） */export function lastOperationFor(state, registryPath) {
  const target = fold(parseRegistryPath(registryPath).canonical)
  for (let index = state.ops.length - 1; index >= 0; index -= 1) {
    if (fold(state.ops[index].path) === target) return state.ops[index]
  }
  return undefined
}

/**
 * 覆盖层是否已能判定"这个键存在/不存在"；`undefined` 表示**覆盖层没表态**。
 * 注意：祖先被暂存删除时，后代一律判**不存在**（真实 API 也是如此）。
 */
export function overlayKeyExists(state, registryPath) {
  const canonical = parseRegistryPath(registryPath).canonical
  const target = fold(canonical)
  for (const ancestor of ancestorFolds(canonical)) {
    const last = lastOperationForFold(state, ancestor)
    if (last && last.op === REG_STAGE_OP.DELETE_KEY) return false
  }
  const last = lastOperationForFold(state, target)
  if (!last) return undefined
  return last.op !== REG_STAGE_OP.DELETE_KEY
}

function lastOperationForFold(state, targetFold) {
  for (let index = state.ops.length - 1; index >= 0; index -= 1) {
    if (fold(state.ops[index].path) === targetFold) return state.ops[index]
  }
  return undefined
}

/** 某键**自身**最后一次 set-value/delete-value（`undefined` = 覆盖层没表态） */
export function lastValueOperationFor(state, registryPath, valueName) {
  const target = fold(parseRegistryPath(registryPath).canonical)
  const wanted = fold(valueName ?? '')
  for (let index = state.ops.length - 1; index >= 0; index -= 1) {
    const entry = state.ops[index]
    if (entry.op !== REG_STAGE_OP.SET_VALUE && entry.op !== REG_STAGE_OP.DELETE_VALUE) continue
    if (fold(entry.path) !== target) continue
    if (fold(entry.valueName ?? '') !== wanted) continue
    return entry
  }
  return undefined
}

/**
 * 需要做差异/进候选的全部路径：每条操作的**路径自身与其所有祖先**
 * （祖先必须一起比，因为"子键增删"体现为祖先的 `subKeys` 变化）。
 * 裸 hive 根（`HKCU`）**不**入列：它不是任何操作的目标，比较它只会产生噪音。
 */
export function overlayTouchedPaths(state) {
  const levels = new Map()
  for (const op of state.ops) {
    for (const level of overlayContainerChain(op.path)) {
      if (!levels.has(fold(level))) levels.set(fold(level), level)
    }
  }
  return [...levels.values()].sort((left, right) => (fold(left) < fold(right) ? -1 : fold(left) > fold(right) ? 1 : 0))
}

// ──────────────────── 纯函数：覆盖视图与查询语义 ────────────────────

function withBaselineChecked(baseline, canonical) {
  const base = baseline ?? normalizeSnapshot({ root: canonical, exists: false })
  if (fold(base.root) !== fold(canonical)) {
    throw stageError(
      'REG_STAGE_BASELINE_ROOT_MISMATCH',
      `baseline root ${base.root} does not match requested path ${canonical}; comparing different keys is meaningless`,
    )
  }
  if (base.accessDenied === true) {
    throw stageError(
      'REG_BASELINE_UNREADABLE',
      `baseline for ${canonical} is unreadable (ERROR_ACCESS_DENIED): the overlay cannot pretend the ` +
        'pre-existing values are empty, so this path is NOT frozen into a candidate',
      { root: canonical },
    )
  }
  if (base.unreadable === true) {
    // WP12：读取器**没跑起来/超时/错误无法识别**是第三种结果（既不是"存在"也不是"不存在"）。
    // 把它当成"不存在"会直接产出 `key-created` ⇒ 真实 hive 上 `reg add <已存在键> /f`。
    throw stageError(
      'REG_BASELINE_UNREADABLE',
      `baseline for ${canonical} could not be read: ${base.unreadableReason ?? 'reader did not report a usable answer'}` +
        ' — refusing to treat "not read" as "does not exist / is empty"',
      { root: canonical },
    )
  }
  return base
}

/**
 * 把"读取器**没报**什么"显式记进快照（WP12）。
 *
 * 为什么必须有这一层：`registry-guard.mjs::normalizeSnapshot` 用 `raw.subKeys ?? []`（第 539 行）
 * 把"没报子键"折成"已知为空 `[]`"，`exists === true` 又把"没报存在性"折成"不存在"。
 * 两个**不同**的事实被抹平之后，覆盖层就会把**真实已存在**的父键算成净变化
 * （`subkey-added` ⇒ `mkdir` 单元，或 `key-created` ⇒ 真写），apply 于是去
 * `reg add <已存在键> /f` —— 在写保护/受限令牌下返回 ERROR_ACCESS_DENIED(5)，
 * 整批批不动（`[实测]` 本机复现见 `$STAGE\_r3\p4-repro.mjs` 的输出）。
 *
 * 口径（只**补记**，绝不编造）：
 *   · `raw.unreadable === true` ⇒ 快照标 `unreadable`（走"读不到"通道，不进候选）；
 *   · `exists` 既不是 `true` 也不是 `false` ⇒ 同样按"读不到"处理（不许当成"不存在"）；
 *   · 存在但 `subKeys` **不是数组**且没有 `subKeysKnown:true` ⇒ `subKeysKnown:false`
 *     （"未知"≠"空"）。已知为空的快照**不**加任何字段（既有断言/序列化不受影响）。
 */
function withBaselineKnowledge(snapshot, raw, canonical) {
  if (raw.unreadable === true) {
    return Object.freeze({
      ...snapshot,
      exists: true,
      unreadable: true,
      subKeysKnown: false,
      unreadableReason:
        typeof raw.unreadableReason === 'string' && raw.unreadableReason.length > 0
          ? raw.unreadableReason
          : `reader could not read ${canonical}`,
    })
  }
  if (raw.exists !== true && raw.exists !== false && raw.accessDenied !== true) {
    return Object.freeze({
      ...snapshot,
      exists: true,
      unreadable: true,
      subKeysKnown: false,
      unreadableReason:
        `reader did not report "exists" for ${canonical}: refusing to treat a missing answer as ` +
        '"the key does not exist" (that answer would become a real `reg add <key> /f`)',
    })
  }
  if (snapshot.exists !== true || snapshot.accessDenied === true) return snapshot
  if (Array.isArray(raw.subKeys) || raw.subKeysKnown === true) return snapshot
  return Object.freeze({
    ...snapshot,
    subKeysKnown: false,
    subKeysUnknownReason:
      `reader did not report subKeys for ${canonical}: the sub-key enumeration is UNKNOWN, not known-empty`,
  })
}

/** 基线的子键枚举是否**已知**（`false` = 读取器没报/报成未知）。 */
function baselineSubKeysKnown(baseline) {
  if (baseline.exists !== true) return true // 不存在 ⇒ 没有子键，是**已知**的事实
  if (baseline.subKeysKnown === false) return false
  if (baseline.subKeysKnown === true) return true
  return Array.isArray(baseline.subKeys)
}

function baselineSubKeysArray(baseline) {
  return Array.isArray(baseline.subKeys) ? baseline.subKeys : []
}

/** 快照形状的变更计数（`diffSnapshots` 的 summary 同口径；差异被剔除后必须重算）。 */
function summarizeChangeKinds(changes) {
  return changes.reduce((acc, change) => {
    acc[change.kind] = (acc[change.kind] ?? 0) + 1
    return acc
  }, {})
}

function setEntryCaseInsensitive(map, name, entry) {
  const wanted = fold(name)
  const next = {}
  for (const [key, value] of Object.entries(map)) {
    if (fold(key) === wanted) continue
    next[key] = value
  }
  next[name] = entry
  return next
}

function removeEntryCaseInsensitive(map, name) {
  const wanted = fold(name)
  const next = {}
  for (const [key, value] of Object.entries(map)) {
    if (fold(key) === wanted) continue
    next[key] = value
  }
  return next
}

function addNameCaseInsensitive(list, name) {
  if (list.some((entry) => fold(entry) === fold(name))) return list
  return [...list, name]
}

function removeNameCaseInsensitive(list, name) {
  return list.filter((entry) => fold(entry) !== fold(name))
}

/**
 * 覆盖层的**有效视图**：基线 + WAL 重放（`normalizeSnapshot` 形状）。
 *
 * 语义要点（逐条对齐真实 API）：
 *   · `create-key` 在"当前不存在"时得到**空键**（不恢复基线里的值/子键）；
 *   · `delete-key` 清空该键的值与子键，且其后代一律不存在；
 *   · 子键列表随 `create-key`/`delete-key` 对**直接子级**的操作增删；
 *   · 键名/值名**不区分大小写**（注册表语义），保留写者给的最后一种大小写。
 *
 * @throws `REG_BASELINE_UNREADABLE` 基线是"拒绝访问"时**拒绝**合成视图
 *   （否则会把"读不到"粉饰成"里面什么都没有"）
 */
export function overlayView({ state, path, baseline }) {
  if (!state || state.version !== REGISTRY_STAGE_VERSION) {
    throw stageError('REG_STAGE_STATE_INVALID', 'overlayView: state must come from createOverlayState()')
  }
  const canonical = parseRegistryPath(path).canonical
  const target = fold(canonical)
  const base = withBaselineChecked(baseline, canonical)

  if (overlayKeyExists(state, canonical) === false) {
    return normalizeSnapshot({ root: canonical, exists: false, errorCode: REG_STATUS.ERROR_FILE_NOT_FOUND })
  }

  // ── 枚举/视图的**合并语义**（契约 v1.2；`[实测]` 2026-09-30 的阻塞级缺陷）──────────
  // 只返回覆盖层的做法被证明对真实负载是致命的：.NET 的 `RegCreateKeyExW`（"打开或创建"）
  // 会在覆盖层留下一个**空壳**键（例如 `HKCU\Software\Microsoft\SystemCertificates\CA\Certificates`），
  // 之后枚举 `HKCU\Software` 若只列覆盖层，真实 Software 下成千上万个子键会**全部消失**
  // ⇒ 证书存储读空 ⇒ `InitialSessionState` 类型初始化失败 ⇒ 任何 PowerShell 子进程直接死
  // （`childExitCode = 0xFFFF0000`）。因此视图/枚举**必须**是 `覆盖层 ∪ 真实`：
  //   · 同名以覆盖层为准；
  //   · 覆盖层里记了删除（白障）的名字从并集里**剔除**；
  //   · 名字不区分大小写去重，按名字排序（保证 index→name 在多次调用间稳定）。
  // `__internal.enumerationMerge = false` 只用于**变异体自证**（把并集退化成"只返回覆盖层"），
  // 生产路径上没有任何代码会把它设为 false。
  const mergeEnumeration = __internal.enumerationMerge !== false
  let exists = base.exists
  let values = mergeEnumeration ? { ...base.values } : {}
  // WP12：**未知 ≠ 空**。读取器没报 `subKeys` 时，`[]` 只能当作"枚举答案拿不到"，
  // 不能当作"确定没有子键"。这一位会被 `diffOverlay` 用来**拒绝**产出
  // `subkey-added`/`subkey-deleted`（那两类会变成 `mkdir`/`delete` 单元去真实 hive 上动
  // 一个**已经存在**的键）。`subKeys` 本身仍然给出（枚举 API 需要一张表），但诚实性由这一位承担。
  let subKeysKnown = baselineSubKeysKnown(base)
  let subKeys = mergeEnumeration ? [...baselineSubKeysArray(base)] : []
  let subKeysUnknownReason =
    typeof base.subKeysUnknownReason === 'string' && base.subKeysUnknownReason.length > 0
      ? base.subKeysUnknownReason
      : `baseline for ${canonical} did not report a sub-key enumeration: "unknown" must not be read as "empty"`

  for (const entry of state.ops) {
    const entryFold = fold(entry.path)
    if (entryFold === target) {
      if (entry.op === REG_STAGE_OP.CREATE_KEY) {
        if (!exists) {
          // 真实 hive 里不存在 ⇒ 新键是空的（不恢复任何"真实内容"）。
          // 这一条是**确定**的：键是新建的，所以它的子键**已知为空**。
          exists = true
          values = {}
          subKeys = []
          subKeysKnown = true
        }
        // 真实 hive 里已存在 ⇒ **净变化为零**：什么都不做（尤其**不能**清空真实的值/子键）
      } else if (entry.op === REG_STAGE_OP.DELETE_KEY) {
        exists = false
        values = {}
        subKeys = []
        // 删掉的键没有子键 ⇒ 同样是**已知**为空。
        subKeysKnown = true
      } else if (entry.op === REG_STAGE_OP.SET_VALUE) {
        exists = true
        values = setEntryCaseInsensitive(values, entry.valueName ?? '', { type: entry.typeName, data: entry.data })
      } else if (entry.op === REG_STAGE_OP.DELETE_VALUE) {
        values = removeEntryCaseInsensitive(values, entry.valueName ?? '')
      }
      continue
    }
    if (isDirectChildFold(target, entryFold)) {
      const name = lastSegment(entry.path)
      if (entry.op === REG_STAGE_OP.CREATE_KEY) subKeys = addNameCaseInsensitive(subKeys, name)
      else if (entry.op === REG_STAGE_OP.DELETE_KEY) subKeys = removeNameCaseInsensitive(subKeys, name)
      // 注意：覆盖层只**增删它自己动过的名字**，真实 hive 里其余子键仍在"未知"里 ⇒
      // `subKeysKnown` 保持 false（不能因为"我加了一个名字"就说整张表已知）。
    }
  }

  if (!exists) return normalizeSnapshot({ root: canonical, exists: false, errorCode: REG_STATUS.ERROR_FILE_NOT_FOUND })

  // 视图里的 `data` 是**编码后的文本**，而 `normalizeSnapshot` 收的是类型化值：
  // 这里必须先解码再交给它重新编码。两者共用同一套编解码（见 registry-guard 的导出），
  // 因此"覆盖层写进去的"与"diff 读出来的"不可能漂移。
  const typed = {}
  for (const [name, entry] of Object.entries(values)) {
    typed[name] = { type: entry.type, data: decodeRegistryValue(entry.type, entry.data, name) }
  }
  const view = normalizeSnapshot({ root: canonical, exists: true, subKeys, values: typed, sddl: base.sddl })
  if (subKeysKnown) return view
  return Object.freeze({ ...view, subKeysKnown: false, subKeysUnknownReason })
}

/** `RegQueryValueExW` 的暂存语义（返回 LSTATUS + 编码后的数据，供 shim 直接拷贝字节） */
export function overlayQueryValue({ state, path, valueName = '', baseline }) {
  const canonical = parseRegistryPath(path).canonical
  if (overlayKeyExists(state, canonical) === false) return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, reason: 'key does not exist in the overlay' }
  const base = baseline ?? normalizeSnapshot({ root: canonical, exists: false })
  if (fold(base.root) !== fold(canonical)) {
    throw stageError('REG_STAGE_BASELINE_ROOT_MISMATCH', `baseline root ${base.root} does not match ${canonical}`)
  }
  if (base.accessDenied === true) {
    // 基线读不到：只有"本会话明确写过这个值"才敢回答，否则如实报拒绝访问。
    const staged = lastValueOperationFor(state, canonical, valueName)
    if (!staged || staged.op !== REG_STAGE_OP.SET_VALUE) {
      return { status: REG_STATUS.ERROR_ACCESS_DENIED, reason: 'baseline is unreadable and this value was not staged' }
    }
    return {
      status: REG_STATUS.ERROR_SUCCESS,
      type: staged.typeName,
      data: staged.data,
      value: decodeRegistryValue(staged.typeName, staged.data, valueName),
      source: 'overlay',
    }
  }
  const view = overlayView({ state, path: canonical, baseline: base })
  if (!view.exists) return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, reason: 'key does not exist' }
  const wanted = fold(valueName)
  const found = Object.entries(view.values).find(([name]) => fold(name) === wanted)
  if (!found) return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, reason: 'value does not exist' }
  const [name, entry] = found
  return {
    status: REG_STATUS.ERROR_SUCCESS,
    name,
    type: entry.type,
    data: entry.data,
    value: decodeRegistryValue(entry.type, entry.data, name),
    source: 'overlay-view',
  }
}

/** `RegOpenKeyExW` 的暂存语义（只回答存在性/子键/值名，不打开真实句柄） */
export function overlayQueryKey({ state, path, baseline }) {
  const canonical = parseRegistryPath(path).canonical
  if (overlayKeyExists(state, canonical) === false) {
    return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, exists: false, subKeys: [], valueNames: [], subKeysKnown: true }
  }
  const base = baseline ?? normalizeSnapshot({ root: canonical, exists: false })
  if (base.accessDenied === true) {
    return {
      status: REG_STATUS.ERROR_ACCESS_DENIED,
      exists: true,
      subKeys: [],
      valueNames: [],
      subKeysKnown: false,
      reason: base.unreadableReason ?? 'baseline is unreadable (ERROR_ACCESS_DENIED)',
    }
  }
  if (base.unreadable === true) {
    return {
      status: REG_STATUS.ERROR_ACCESS_DENIED,
      exists: true,
      subKeys: [],
      valueNames: [],
      subKeysKnown: false,
      reason: base.unreadableReason ?? 'baseline could not be read',
    }
  }
  const view = overlayView({ state, path: canonical, baseline: base })
  if (!view.exists) {
    return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, exists: false, subKeys: [], valueNames: [], subKeysKnown: true }
  }
  const subKeysKnown = view.subKeysKnown !== false
  return {
    status: REG_STATUS.ERROR_SUCCESS,
    exists: true,
    subKeys: [...view.subKeys],
    valueNames: Object.keys(view.values),
    // WP12：枚举**未知**时必须显式说出来，别让调用方把 `subKeys: []` 读成"这个键没有子键"
    // （`[实测]` 2026-09-30：把枚举说成空 ⇒ .NET 证书存储读空 ⇒ PowerShell 起不来）。
    subKeysKnown,
    reason: subKeysKnown ? undefined : view.subKeysUnknownReason,
  }
}

/** `RegEnumKeyExW` 的暂存语义（有序、确定；`ERROR_NO_MORE_ITEMS` 由 shim 在末尾返回） */
export function overlayEnumKeys({ state, path, baseline }) {
  const query = overlayQueryKey({ state, path, baseline })
  if (query.status === REG_STATUS.ERROR_SUCCESS && query.subKeysKnown === false) {
    // 枚举**就是**这个 API 的全部答案：拿不到就得**如实失败**，不能交一张空表
    // （"未知伪装成空"正是 `[实测]` 2026-09-30 的阻塞级缺陷形态）。
    return { status: REG_STATUS.ERROR_ACCESS_DENIED, names: [], subKeysKnown: false, reason: query.reason }
  }
  return { status: query.status, names: query.status === REG_STATUS.ERROR_SUCCESS ? query.subKeys : [] }
}

/** `RegEnumValueW` 的暂存语义 */
export function overlayEnumValues({ state, path, baseline }) {
  const canonical = parseRegistryPath(path).canonical
  if (overlayKeyExists(state, canonical) === false) return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, values: [] }
  const base = baseline ?? normalizeSnapshot({ root: canonical, exists: false })
  if (base.accessDenied === true || base.unreadable === true) {
    return {
      status: REG_STATUS.ERROR_ACCESS_DENIED,
      values: [],
      reason: base.unreadableReason ?? 'baseline is unreadable',
    }
  }
  const view = overlayView({ state, path: canonical, baseline: base })
  if (!view.exists) return { status: REG_STATUS.ERROR_FILE_NOT_FOUND, values: [] }
  return {
    status: REG_STATUS.ERROR_SUCCESS,
    values: Object.entries(view.values).map(([name, entry]) => ({ name, type: entry.type, data: entry.data })),
  }
}

// ──────────────────── 纯函数：差异与候选 ────────────────────

/**
 * 覆盖层差异：对每个被触碰路径做 `基线 vs 覆盖视图` 的 `diffSnapshots`。
 *
 * ── WP12：基线的子键枚举**未知**时不许产出子键类差异 ─────────────────────────────
 * `baseline.subKeys` 缺失（读取器没报/读取器只报了存在性）时，`[]` 只是"拿不到答案"。
 * 若把它当成"确定没有子键"，就会对**已经存在**的子键伪造 `subkey-added`，
 * 而 `subkey-added` 会变成 `mkdir` 单元进候选、被 apply 拿去真实 hive
 * （`reg add <已存在键> /f`；写保护/受限令牌下 = ERROR_ACCESS_DENIED(5) ⇒ 整批批不动）。
 * 反过来报 `subkey-deleted` 也会把没删的说成删了。两类**都是猜**，因此这里：
 *   · 剔除 `subkey-added`/`subkey-deleted`（只剔除猜的那两类，其余照常）；
 *   · 把"为什么没判定"显式记进 `subKeysUnknown` + `warnings` + `roots[path].subKeysKnown`
 *     （绝不静默改语义：调用方/审批面板能看到这个维度**没被冻结**）。
 *
 * @param {{state: object, baselineFor: (path: string) => object}} options
 * @returns {{paths: string[], roots: object, changes: object[], totalChanges: number,
 *            unreadable: string[], subKeysUnknown: string[], warnings: string[]}}
 */
export function diffOverlay({ state, baselineFor }) {
  if (typeof baselineFor !== 'function') {
    throw stageError('REG_READER_MISSING', 'diffOverlay requires baselineFor(path) — refusing to diff against an assumed-empty baseline')
  }
  const paths = overlayTouchedPaths(state)
  const roots = {}
  const changes = []
  const unreadable = []
  const subKeysUnknown = []
  const warnings = []

  for (const path of paths) {
    const baseline = baselineFor(path)
    if (baseline.accessDenied === true || baseline.unreadable === true) {
      // 基线读不到 ⇒ **不**产出差异：把"读不到"说成"没有值"是假阴性。
      unreadable.push(path)
      warnings.push(
        `${path}: 基线读取失败（${baseline.accessDenied === true ? 'ERROR_ACCESS_DENIED' : baseline.unreadableReason ?? 'reader did not report a usable answer'}），` +
          '该路径**不**进入候选 —— 候选必须冻结一个可验证的 before（手册 #12.6），读不到就不许假装读到',
      )
      continue
    }
    const after = overlayView({ state, path, baseline })
    const rawDiff = diffSnapshots(baseline, after)
    let rootChanges = rawDiff.changes
    const subKeysKnown = baselineSubKeysKnown(baseline)
    if (!subKeysKnown) {
      const undecidable = rootChanges.filter((change) => change.kind === 'subkey-added' || change.kind === 'subkey-deleted')
      rootChanges = rootChanges.filter((change) => change.kind !== 'subkey-added' && change.kind !== 'subkey-deleted')
      subKeysUnknown.push(path)
      warnings.push(
        `${path}: 基线**没有报子键枚举**（未知，不是空）⇒ 无法判定"子键增删"。` +
          `已剔除 ${undecidable.length} 条猜出来的子键变更（${undecidable.map((change) => `${change.kind}:${change.key}`).join(', ') || 'none'}）——` +
          '否则 `subkey-added` 会变成 `mkdir` 单元，让 apply 去真实 hive 上创建**已存在**的键' +
          '（`reg add <已存在键> /f` 在写保护/受限令牌下被拒 ⇒ 整批批不动）。' +
          '该路径的**值与存在性**变更照常保留。',
      )
    }
    if (rootChanges.length === 0) continue
    roots[path] = {
      changes: rootChanges,
      // summary 必须按**剔除后**的差异重算，否则候选里的计数会与变更单元对不上。
      summary: subKeysKnown ? rawDiff.summary : summarizeChangeKinds(rootChanges),
      subKeysKnown,
      rollback: planRollback(rootChanges, { rootPath: path }),
      baselineFrozen: serializeSnapshot(baseline),
    }
    for (const change of rootChanges) changes.push({ ...change, registryPath: path })
  }

  const lostValues = changes.filter((change) => change.kind === 'value-deleted' || change.kind === 'key-deleted').length
  if (lostValues > 0) {
    warnings.push(
      `${lostValues} 项变更涉及"删除/覆盖既有数据"：应用前请确认候选里冻结的 before 是你要覆盖的状态`,
    )
  }
  return { paths, roots, changes, totalChanges: changes.length, unreadable, subKeysUnknown, warnings }
}

const OP_BY_DIFF_KIND = Object.freeze({
  'key-created': 'mkdir',
  'subkey-added': 'mkdir',
  'key-deleted': 'delete',
  'subkey-deleted': 'delete',
  'value-added': 'create',
  'value-changed': 'modify',
  'value-deleted': 'delete',
  'key-access-changed': 'unsupported',
  'security-changed': 'unsupported',
})

/**
 * 差异 → 与**文件候选同构**的变更单元。
 *
 * 同构到什么程度（这样审批面板与 `store.mjs` 的候选读写可以原样复用）：
 *   · 顶层字段名与文件候选一致（`version/id/createdAt/sessionId/status/changes/summary/...`）；
 *   · 每个变更单元有 `path`/`op`/`kind`/`before`/`after`/`frozen`；
 *   · 额外 `external: true`（与 `store.mjs` 的工作区**外**条目同一约定）+ `registry: true`，
 *     于是"注册表变更"在面板里是"外部的、需要审批的一类单元"，而不是另一套语义。
 */
export function overlayChangesToCandidateChanges(diffResult) {
  const units = []
  const seen = new Set()
  for (const change of diffResult.changes) {
    const op = OP_BY_DIFF_KIND[change.kind]
    if (op === undefined) {
      throw stageError('REG_STAGE_DIFF_KIND_UNKNOWN', `unknown diff kind ${JSON.stringify(change.kind)}`)
    }
    const unitPath = change.valueName !== undefined ? registryValueUnitPath(change.key, change.valueName) : change.key
    const dedupeKey = `${op}|${fold(unitPath)}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    const unit = {
      kind: 'registry',
      registry: true,
      external: true,
      path: unitPath,
      registryPath: change.key,
      hive: parseRegistryPath(change.key).hive,
      op,
      diffKind: change.kind,
      before: change.before ?? null,
      after: change.after ?? null,
      frozen: true,
    }
    if (change.valueName !== undefined) unit.valueName = change.valueName
    if (change.reason !== undefined) unit.reason = change.reason

    if (op === 'unsupported') {
      // 可读性/安全描述符的"变化"是覆盖层**合成视图**的产物，不是真实写入：
      // 保留它（不隐藏信息），但明确标注**不可应用**。
      unit.appliable = false
      unit.unsupportedReason =
        '安全描述符/可读性变更无法在覆盖层暂存：app hive 内所有键共享一个 SD，且禁止 RegSetKeySecurity'
    } else {
      unit.appliable = true
    }
    units.push(unit)
  }
  return units
}

/** 与 `workspace.mjs` 的 `summarize()` 同口径：`files` = 变更单元数 */
export function summarizeRegistryChanges(changes) {
  const byOp = {}
  for (const change of changes) byOp[change.op] = (byOp[change.op] || 0) + 1
  return {
    files: changes.length,
    hostOperations: 0,
    byOp,
    bytes: 0,
    keys: new Set(changes.map((change) => change.registryPath)).size,
    values: changes.filter((change) => change.valueName !== undefined).length,
    unsupported: changes.filter((change) => change.appliable === false).length,
  }
}

// ──────────────────── 纯函数：WAL 记录编解码 ────────────────────

function assertJournalRecord(record) {
  if (!record || typeof record !== 'object') throw new TypeError('registry-stage: journal record must be an object')
  const kind = record.kind
  if (KIND_NAME[kind] === undefined) {
    throw stageError('REG_STAGE_JOURNAL_INVALID', `unknown journal record kind ${JSON.stringify(kind)}`)
  }
  assertNonEmptyString(record.path, 'journal record path')
}

/**
 * 一条操作 → WAL 记录（DLL 侧必须产出**同一种**记录；见文件头的 C ABI 约定）。
 * `data` 收编码后的十六进制文本（与快照同口径），编码进记录时还原成**原始字节**。
 */
export function journalRecordForOperation(operation = {}) {
  const op = operation.op
  const kind = KIND_BY_OP[op]
  if (kind === undefined) throw stageError('REG_STAGE_OP_UNKNOWN', `journalRecordForOperation: unknown op ${JSON.stringify(op)}`)
  const canonical = parseRegistryPath(operation.path).canonical
  const record = { kind, path: canonical, flags: 0, type: 0, valueName: null, data: null, status: 0 }
  if (op === 'set-value') {
    record.type = REG_TYPES[registryTypeName(operation.type)]
    record.valueName = typeof operation.valueName === 'string' ? operation.valueName : ''
    record.data = encodeRegistryValue(operation.type, operation.value)
    record.flags |= REG_STAGE_FLAGS.HAS_VALUE_NAME | REG_STAGE_FLAGS.HAS_DATA
  }
  if (op === 'delete-value') {
    record.valueName = typeof operation.valueName === 'string' ? operation.valueName : ''
    record.flags |= REG_STAGE_FLAGS.HAS_VALUE_NAME
  }
  if (operation.dwOptions && (operation.dwOptions & REG_OPTIONS.REG_OPTION_VOLATILE) !== 0) {
    record.flags |= REG_STAGE_FLAGS.VOLATILE
  }
  return record
}

/** 硬拒记录（`kind = HARD_DENY`，保留原始 LSTATUS，供审计） */
export function journalHardDenyRecord({ api, path, status = HARD_DENY_STATUS, reason }) {
  const record = {
    kind: REG_STAGE_KIND.HARD_DENY,
    path: typeof path === 'string' && path.length > 0 ? path : `<unknown:${api ?? 'unknown'}>`,
    flags: REG_STAGE_FLAGS.HARD_DENY,
    type: 0,
    valueName: null,
    data: null,
    status: status >>> 0,
    api: api ?? null,
    reason: reason ?? null,
  }
  return record
}

/**
 * 透传记录（`kind = UNSTAGED`，契约 v1.4）。
 *
 * 语义：这次调用**没有被暂存**，因为覆盖层根本复现不了它；真实 API 已经收到了这次调用，
 * 成败由真实系统决定（因此 `status` 恒为 0 = "我们**没有**拒你"）。
 *
 * 因此这类记录**绝不能被重放**：apply/候选路径必须忽略它们。实现上是结构性的 ——
 * `replayJournal()` 把它们收进 `unstaged[]` 而不是 `state.ops`，而候选（`diffOverlay`）
 * 与 `applyUnits()` 都只读 `state.ops`，所以它们**不可能**出现在候选或应用单元里
 * （重复应用一条"已经到达真实系统"的调用就是双重写入）。
 *
 * `path`：知道规范路径时**写真实路径**（审计必须能回答"哪个键被透传了"）；
 * 路径不可知时用占位名（`<unstaged:API>`），与硬拒记录同一约定（占位名不是可解析路径）。
 * 不可暂存的原因码进 `type`（`REG_STAGE_UNSTAGED_REASON`）。
 */
export function journalUnstagedRecord({ api, path, reason, unstagedReason = 'UNRESOLVABLE_BASE_HANDLE' }) {
  if (REG_STAGE_UNSTAGED_REASON[unstagedReason] === undefined) {
    throw stageError(
      'REG_STAGE_JOURNAL_INVALID',
      `journalUnstagedRecord: unknown unstagedReason ${JSON.stringify(unstagedReason)} (expected one of ${Object.keys(REG_STAGE_UNSTAGED_REASON).join('/')})`,
    )
  }
  return {
    kind: REG_STAGE_KIND.UNSTAGED,
    path: typeof path === 'string' && path.length > 0 ? path : `<unstaged:${api ?? 'unknown'}>`,
    flags: REG_STAGE_FLAGS.UNSTAGED,
    type: REG_STAGE_UNSTAGED_REASON[unstagedReason],
    valueName: null,
    data: null,
    status: 0,
    api: api ?? null,
    reason: reason ?? null,
    unstagedReason,
  }
}

// ── 快照口径（十六进制文本） ↔ WAL 口径（**原始字节**）────────────────────────
//
// 为什么必须有一个类型感知的转换层（这是本模块自己踩到的 F8 同族缺陷）：
// 快照里 `REG_DWORD`/`REG_QWORD` 的 `data` 是 `0x` + 补零十六进制**文本**
// （见 `registry-guard` 的 `VALUE_ENCODERS`）。若把它直接喂给
// `Buffer.from(data,'hex')`，`'0x…'` 里的 `x` 会被当成非法字符、**静默截断成空 Buffer** ——
// 结果就是"值写进去了、WAL 里是空的、重放后值消失"，而且**不抛错**。
// 因此：数值类型的文本先校验形状（走 `decodeRegistryValue` = `assertShape` 的同一口径），
// 再按类型转成真正的线格式字节（DWORD/QWORD 小端、DWORD_BIG_ENDIAN 大端）。
//
// 为什么 WAL 存**原始字节**而不是十六进制文本：DLL 手里拿到的就是
// `RegSetValueExW(hKey, name, 0, type, lpData, cbData)` 的 `lpData`/`cbData`，
// 原样落盘才能做到"zero-copy 语义"，也才让 C 侧不需要任何编解码器。

/**
 * 快照口径 `data`（十六进制文本）→ WAL 线格式字节（= 真实 API 的 `lpData`）。
 * @throws `REG_SNAPSHOT_INVALID`（形状坏）/ `REG_TYPE_UNKNOWN` / `REG_TYPE_UNSUPPORTED`
 */
export function registryWireBytes(type, dataHex) {
  const typeName = registryTypeName(type)
  const text = typeof dataHex === 'string' ? dataHex : ''
  // 形状校验：与反序列化同一口径（F8）。**先校验再 Buffer.from(...,'hex')**，
  // 否则静默截断会把"值"变成"空"。
  decodeRegistryValue(typeName, text, '<wire>')
  if (typeName === 'REG_DWORD' || typeName === 'REG_DWORD_BIG_ENDIAN' || typeName === 'REG_QWORD') {
    // ⚠ 这里**不能** `Buffer.from(body,'hex')`：快照里的 `0x0000002a` 是**数值**的十六进制
    // 文本（高位在前），直接当字节序读会得到 `00 00 00 2a`，而线格式要求
    // `REG_DWORD` 是**小端** `2a 00 00 00`。必须显式按类型写入字节序。
    const body = /^0x/i.test(text) ? text.slice(2) : text
    if (typeName === 'REG_QWORD') {
      const buffer = Buffer.alloc(8)
      buffer.writeBigUInt64LE(BigInt(`0x${body}`), 0)
      return buffer
    }
    const value = Number.parseInt(body, 16) >>> 0
    const buffer = Buffer.alloc(4)
    if (typeName === 'REG_DWORD_BIG_ENDIAN') buffer.writeUInt32BE(value, 0)
    else buffer.writeUInt32LE(value, 0)
    return buffer
  }
  return Buffer.from(text, 'hex')
}

/**
 * WAL 线格式字节 → 快照口径 `data`（十六进制文本）。
 * 与 `registryWireBytes` 互为往返（`registryDataHex(t, registryWireBytes(t, d)) === d`）。
 */
export function registryDataHex(type, wireBuffer) {
  const typeName = registryTypeName(type)
  if (!Buffer.isBuffer(wireBuffer)) throw new TypeError('registryDataHex: wireBuffer must be a Buffer')
  if (typeName === 'REG_DWORD' || typeName === 'REG_DWORD_BIG_ENDIAN') {
    if (wireBuffer.length !== 4) {
      throw stageError('REG_STAGE_WIRE_LENGTH', `registryDataHex: ${typeName} expects 4 bytes, got ${wireBuffer.length}`)
    }
    const value = typeName === 'REG_DWORD_BIG_ENDIAN' ? wireBuffer.readUInt32BE(0) : wireBuffer.readUInt32LE(0)
    return `0x${value.toString(16).padStart(8, '0')}`
  }
  if (typeName === 'REG_QWORD') {
    if (wireBuffer.length !== 8) {
      throw stageError('REG_STAGE_WIRE_LENGTH', `registryDataHex: REG_QWORD expects 8 bytes, got ${wireBuffer.length}`)
    }
    return `0x${wireBuffer.readBigUInt64LE(0).toString(16).padStart(16, '0')}`
  }
  return wireBuffer.toString('hex')
}

/**
 * WAL 记录 → Buffer（纯函数；测试与宿主都能用，DLL 侧必须逐字节一致）。
 * 布局：32 字节小端头 + `path`(UTF-16LE) + `name`(UTF-16LE) + `data`(原始字节)。
 */
export function encodeJournalRecord(record) {
  assertJournalRecord(record)
  const pathBuffer = Buffer.from(record.path, 'utf16le')
  const nameBuffer = Buffer.from(record.valueName ?? '', 'utf16le')
  const dataHex = record.data ?? ''
  // 只有 SET_VALUE 携带数据；其余记录的数据字段长度恒为 0（结构里逐字节写明，不进歧义）。
  const dataBuffer =
    record.kind === REG_STAGE_KIND.SET_VALUE
      ? registryWireBytes(record.typeName ?? record.type, dataHex)
      : Buffer.alloc(0)
  const flags =
    record.flags ??
    ((record.valueName !== null && record.valueName !== undefined ? REG_STAGE_FLAGS.HAS_VALUE_NAME : 0) |
      (record.data !== null && record.data !== undefined ? REG_STAGE_FLAGS.HAS_DATA : 0))

  // UNSTAGED（kind 6）的字段组合在**编码时**就钉死，别等宿主解析时才判红：
  //   · 必须置 UNSTAGED 位（否则这条记录与"暂存成功"无法区分）；
  //   · `type` = 不可暂存的原因码（1..4）；`status` 恒为 0（没有被拒）；
  //   · 不携带 valueName/data：它不是一条可重放的操作，只是一条"这次调用去了真实系统"的审计。
  if (record.kind === REG_STAGE_KIND.UNSTAGED) {
    if ((flags & REG_STAGE_FLAGS.UNSTAGED) === 0) {
      throw stageError('REG_STAGE_JOURNAL_INVALID', 'kind=UNSTAGED must set REG_STAGE_FLAGS.UNSTAGED')
    }
    if (UNSTAGED_REASON_NAME[record.type] === undefined) {
      throw stageError(
        'REG_STAGE_JOURNAL_INVALID',
        `kind=UNSTAGED needs type = a REG_STAGE_UNSTAGED_REASON code (1..${Object.keys(REG_STAGE_UNSTAGED_REASON).length}), got ${String(record.type)}`,
      )
    }
    if ((flags & (REG_STAGE_FLAGS.HAS_VALUE_NAME | REG_STAGE_FLAGS.HAS_DATA)) !== 0 || (record.status ?? 0) !== 0) {
      throw stageError(
        'REG_STAGE_JOURNAL_INVALID',
        'kind=UNSTAGED must not carry valueName/data and must keep status=0 (nothing was denied and nothing was staged)',
      )
    }
  }

  const buffer = Buffer.alloc(REG_STAGE_RECORD_SIZE + pathBuffer.length + nameBuffer.length + dataBuffer.length)
  const O = REG_STAGE_RECORD_OFFSETS
  buffer.writeUInt32LE(REG_STAGE_JOURNAL_MAGIC, O.magic)
  buffer.writeUInt16LE(record.version ?? REGISTRY_STAGE_VERSION, O.version)
  buffer.writeUInt16LE(record.kind, O.kind)
  buffer.writeUInt16LE(record.type ?? 0, O.type)
  buffer.writeUInt16LE(flags, O.flags)
  buffer.writeUInt32LE(pathBuffer.length / 2, O.pathChars)
  buffer.writeUInt32LE(nameBuffer.length / 2, O.nameChars)
  buffer.writeUInt32LE(dataBuffer.length, O.dataBytes)
  buffer.writeUInt32LE((record.status ?? 0) >>> 0, O.status)
  buffer.writeUInt32LE(0, O.reserved)
  let offset = REG_STAGE_RECORD_SIZE
  pathBuffer.copy(buffer, offset)
  offset += pathBuffer.length
  nameBuffer.copy(buffer, offset)
  offset += nameBuffer.length
  dataBuffer.copy(buffer, offset)
  return buffer
}

/**
 * Buffer → 记录数组（纯函数）。
 *
 * 尾部**撕裂**必须被报出来（`torn: true`），不能静默忽略：
 * "最后一条记录只写了一半"与"这条操作根本没发生"是两种不同事实，
 * 而 WAL 的价值就在于把这两种事实分开。
 */
export function decodeJournalRecords(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('decodeJournalRecords: buffer must be a Buffer')
  const records = []
  const O = REG_STAGE_RECORD_OFFSETS
  let offset = 0
  let torn = false

  while (offset + REG_STAGE_RECORD_SIZE <= buffer.length) {
    const magic = buffer.readUInt32LE(offset + O.magic)
    if (magic !== REG_STAGE_JOURNAL_MAGIC) {
      throw stageError(
        'REG_STAGE_JOURNAL_CORRUPT',
        `journal record at byte ${offset} has magic 0x${magic.toString(16)} (expected 0x${REG_STAGE_JOURNAL_MAGIC.toString(16)} 'DSRG')`,
        { offset },
      )
    }
    const version = buffer.readUInt16LE(offset + O.version)
    if (version !== REGISTRY_STAGE_VERSION) {
      throw stageError('REG_STAGE_JOURNAL_VERSION', `journal record version ${version} is not ${REGISTRY_STAGE_VERSION}`, {
        offset,
      })
    }
    const kind = buffer.readUInt16LE(offset + O.kind)
    if (KIND_NAME[kind] === undefined) {
      throw stageError('REG_STAGE_JOURNAL_CORRUPT', `journal record kind ${kind} is unknown`, { offset })
    }
    const type = buffer.readUInt16LE(offset + O.type)
    const flags = buffer.readUInt16LE(offset + O.flags)
    const pathChars = buffer.readUInt32LE(offset + O.pathChars)
    const nameChars = buffer.readUInt32LE(offset + O.nameChars)
    const dataBytes = buffer.readUInt32LE(offset + O.dataBytes)
    const status = buffer.readUInt32LE(offset + O.status)
    // `reserved` 必须读出来并向上暴露：符合性校验要断言它恒为 0
    // （上一版把它写进了返回值却忘了在这里读取 ⇒ 直接 ReferenceError 崩掉整个套件）。
    const reserved = buffer.readUInt32LE(offset + O.reserved)

    const bodyStart = offset + REG_STAGE_RECORD_SIZE
    const bodyBytes = pathChars * 2 + nameChars * 2 + dataBytes
    if (bodyStart + bodyBytes > buffer.length) {
      torn = true
      break
    }
    const path = pathChars === 0 ? '' : buffer.toString('utf16le', bodyStart, bodyStart + pathChars * 2)
    const nameStart = bodyStart + pathChars * 2
    const rawName = nameChars === 0 ? '' : buffer.toString('utf16le', nameStart, nameStart + nameChars * 2)
    const dataStart = nameStart + nameChars * 2
    const wireBytes = dataBytes === 0 ? Buffer.alloc(0) : Buffer.from(buffer.subarray(dataStart, dataStart + dataBytes))
    const typeName = kind === REG_STAGE_KIND.SET_VALUE ? registryTypeName(type) : undefined

    records.push({
      kind,
      kindName: KIND_NAME[kind],
      op: OP_BY_KIND[kind],
      version,
      type,
      typeName,
      flags,
      path,
      pathChars,
      nameChars,
      dataBytes,
      reserved,
      valueName: (flags & REG_STAGE_FLAGS.HAS_VALUE_NAME) !== 0 ? rawName : null,
      // `wireBytes` 是线格式原样字节（DLL 视角）；`data` 是快照口径的十六进制文本（宿主视角）。
      // 两者必须由同一对函数互转，否则"沙箱里写的"与"候选里记的"会分叉。
      wireBytes,
      data: (flags & REG_STAGE_FLAGS.HAS_DATA) !== 0 && typeName !== undefined ? registryDataHex(typeName, wireBytes) : null,
      status,
      volatile: (flags & REG_STAGE_FLAGS.VOLATILE) !== 0,
    })
    offset = bodyStart + bodyBytes
  }

  if (offset < buffer.length && !torn) torn = true // 剩余字节不足一个定长头
  return { records, bytesConsumed: offset, torn, trailingBytes: buffer.length - offset }
}

/**
 * 记录 → 覆盖层状态（纯函数；宿主侧产候选的唯一入口）。
 *
 * 硬拒记录（`kind = HARD_DENY`）**不进状态**：它们是被拒的调用，
 * 收集到 `hardDenied` 里，让"哪些仍是硬拒"成为可审计的数据。
 * 透传记录（`kind = UNSTAGED`）同样**不进状态**，收集到 `unstaged` 里：这些调用
 * **已经到达真实系统**，把它们当成覆盖层操作重放就是**双重写入**（§8.3）。
 * 任何无法应用的记录（例如策略拒绝）同样收集进 `rejected`，不静默丢弃。
 */
export function replayJournal(records) {
  if (!Array.isArray(records)) throw new TypeError('replayJournal: records must be an array')
  let state = createOverlayState({})
  const hardDenied = []
  const rejected = []
  const unstaged = []
  for (const record of records) {
    if (record.kind === REG_STAGE_KIND.HARD_DENY) {
      hardDenied.push({ path: record.path, status: record.status, api: record.api ?? null, reason: record.reason ?? null })
      continue
    }
    if (record.kind === REG_STAGE_KIND.UNSTAGED) {
      unstaged.push({
        path: record.path,
        reasonCode: record.type,
        reasonName: UNSTAGED_REASON_NAME[record.type] ?? null,
        api: record.api ?? null,
        reason: record.reason ?? null,
      })
      continue
    }
    try {
      state = applyOverlayOperation(state, {
        op: record.op,
        path: record.path,
        type: record.typeName ?? record.type,
        valueName: record.valueName ?? '',
        value: record.data === null ? undefined : decodeRegistryValue(record.typeName ?? record.type, record.data, record.valueName ?? ''),
        dwOptions: record.volatile ? REG_OPTIONS.REG_OPTION_VOLATILE : 0,
      })
    } catch (error) {
      rejected.push({ path: record.path, op: record.op, code: error.code ?? 'ERR', message: String(error.message) })
    }
  }
  return { state, hardDenied, rejected, unstaged }
}

// ──────────────────────── fs：WAL 读写 ────────────────────────

/** 读取并解析 WAL；文件不存在时返回空结果（**不是**错误） */
export function readRegistryJournal(journalPath) {
  if (!existsSync(journalPath)) return { records: [], bytesConsumed: 0, torn: false, trailingBytes: 0, missing: true }
  return { ...decodeJournalRecords(readFileSync(journalPath)), missing: false }
}

/** 把记录数组写成 WAL 文件（宿主/测试用；**DLL 侧是追加**，见文件头） */
export function writeRegistryJournal(journalPath, records) {
  mkdirSync(dirname(journalPath), { recursive: true })
  const buffers = records.map((record) => encodeJournalRecord(record))
  writeFileSync(journalPath, Buffer.concat(buffers))
  return { bytes: buffers.reduce((sum, buffer) => sum + buffer.length, 0), records: buffers.length }
}

// ──────────────────────── 宿主侧门面 ────────────────────────

function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function queueFileName() {
  return 'queue.json'
}

function emptyQueue() {
  return { version: 1, order: [], candidates: {}, supersededBy: {}, discarded: [] }
}

/**
 * 创建宿主侧暂存门面。
 *
 * @param {{
 *   sessionDir: string,
 *   sessionId?: string,
 *   reader?: {read: (path: string) => object},
 *   writer?: object,
 *   now?: () => string,
 *   workspaceRoot?: string,
 * }} options
 *   `reader` 必须是**宿主令牌**下的读取器（`createRegistryReader(bindings)`）：
 *   候选要冻结可验证的 before，用受限令牌读会把"可读的键"误报成拒绝访问。
 *   `writer` 是应用候选时的真实写入器（`createRegistryWriter(bindings)`）；**不传就不许 apply**。
 */
export function createRegistryStage(options = {}) {
  const sessionDir = assertNonEmptyString(options.sessionDir, 'options.sessionDir')
  const stageRoot = resolveRegistryStageRoot(sessionDir)
  const hivePath = resolveRegistryStagePath(sessionDir)
  const journalPath = resolveRegistryStageJournalPath(sessionDir)
  const statePath = resolveRegistryStageStatePath(sessionDir)
  const discardedPath = resolveRegistryStageDiscardedPath(sessionDir)
  const candidateDir = join(sessionDir, 'candidates')
  const queuePath = join(sessionDir, queueFileName())
  const now = typeof options.now === 'function' ? options.now : () => new Date().toISOString()
  const sessionId = typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : null

  let reader = options.reader ?? null
  let writer = options.writer ?? null
  let state = createOverlayState({ sessionId })
  let resolution = { version: REGISTRY_STAGE_VERSION, status: 'open', candidateId: null, appliedPaths: [], discardedAt: null, discardReason: null }
  let candidate = null
  let opened = false
  const baselines = new Map()

  function baselineFor(path) {
    if (!reader || typeof reader.read !== 'function') {
      throw stageError(
        'REG_READER_MISSING',
        'registry-stage has no reader: refusing to diff against an assumed-empty baseline ' +
          '(attach a host-token reader with setReader()/options.reader)',
      )
    }
    const canonical = parseRegistryPath(path).canonical
    const key = fold(canonical)
    if (!baselines.has(key)) baselines.set(key, readBaselineFresh(canonical))
    return baselines.get(key)
  }

  /**
   * **不走缓存**地读一次真实 hive。
   *
   * 缓存是给 diff/候选用的（冻结的 before 必须与候选一致）；而 `apply()` 的
   * 陈旧性检查要的恰恰是"现在真实 hive 是什么样" —— 用缓存做这个检查
   * 会让检查**永远通过**（缓存里就是冻结值），从而把"真实 hive 已经变了"藏起来。
   */
  function readBaselineFresh(path) {
    if (!reader || typeof reader.read !== 'function') {
      throw stageError('REG_READER_MISSING', 'registry-stage has no reader (see baselineFor)')
    }
    const canonical = parseRegistryPath(path).canonical
    const raw = reader.read(canonical)
    if (raw === undefined || raw === null) {
      throw stageError(
        'REG_READ_EMPTY',
        `reader returned ${raw === null ? 'null' : 'undefined'} for ${canonical}; an empty result is NOT ` +
          '"unchanged" and NOT a denial (manual ch.4)',
      )
    }
    // WP12：`normalizeSnapshot` 会把"读取器没报"折成"确定为空/确定不存在"（见 `withBaselineKnowledge`），
    // 这里在归一化**之后**把"哪些维度其实没被报过"补记回快照，供 diffOverlay/overlayView 保守判定。
    return withBaselineKnowledge(normalizeSnapshot({ root: canonical, ...raw }), raw, canonical)
  }

  function saveResolution() {
    mkdirSync(stageRoot, { recursive: true })
    writeJson(statePath, resolution)
  }

  function appendRecord(record) {
    mkdirSync(stageRoot, { recursive: true })
    const buffer = encodeJournalRecord(record)
    appendFileSync(journalPath, buffer)
    return buffer.length
  }

  function requireOpen() {
    if (!opened) open()
  }

  /** 打开/恢复：解析既有 WAL、恢复已解决状态。返回可审计的摘要。 */
  function open() {
    mkdirSync(stageRoot, { recursive: true })
    let resumedRecords = 0
    let torn = false
    let hardDenied = []
    let rejected = []
    let unstaged = []
    if (existsSync(journalPath)) {
      const decoded = decodeJournalRecords(readFileSync(journalPath))
      const replay = replayJournal(decoded.records)
      state = replay.state
      hardDenied = replay.hardDenied
      rejected = replay.rejected
      unstaged = replay.unstaged
      resumedRecords = replay.state.ops.length
      torn = decoded.torn
    }
    const persisted = readJsonIfExists(statePath)
    if (persisted && typeof persisted === 'object') resolution = { ...resolution, ...persisted }
    opened = true
    return {
      sessionDir,
      stageRoot,
      hivePath,
      journalPath,
      statePath,
      sessionId,
      resumed: resumedRecords,
      torn,
      hardDenied,
      rejected,
      unstaged,
      status: resolution.status,
      hiveLoaded: false,
      note:
        'overlay.hive 由 shim 用 RegLoadAppKeyW 加载（本模块**不**加载它）；' +
        '宿主只读 WAL（overlay.journal）产候选，因此不需要跨进程 IPC',
    }
  }

  function persistOperation(operation) {
    const canonical = parseRegistryPath(operation.path).canonical
    const policy = classifyRegistryOperation({
      api: API_BY_OP[operation.op],
      path: canonical,
      type: operation.type,
      dwOptions: operation.dwOptions,
      samDesired: operation.samDesired,
      wow64Process: operation.wow64Process,
    })
    if (policy.unstaged === true) {
      // ── 不可暂存 ⇒ 透传（契约 v1.4）──────────────────────────────────────────────
      // 覆盖层复现不了这次调用（例如 KEY_WOW64_32KEY 的 32 位视图）。**不抛错、不写覆盖层**：
      // 真实 API 才是裁决者。这里只落一条 UNSTAGED 审计记录，让"这次写入去了真实系统"
      // 成为可查数据；候选/应用面看不到它（`state.ops` 里根本没有它）。
      const record = journalUnstagedRecord({
        api: API_BY_OP[operation.op],
        path: policy.code === 'REG_STAGE_SAM_UNSTAGED' ? canonical : undefined,
        reason: policy.reason,
        unstagedReason: policy.unstagedReason ?? 'UNRESOLVABLE_BASE_HANDLE',
      })
      const bytes = appendRecord(record)
      return {
        status: REG_STATUS.ERROR_SUCCESS,
        path: canonical,
        op: operation.op,
        seq: state.seq,
        bytes,
        record,
        net: false,
        staged: false,
        unstaged: true,
        unstagedReason: policy.unstagedReason ?? null,
        netEffect: 'unstaged',
        reason: policy.reason,
        note:
          'overlay cannot represent this call: it was passed through to the real API (this facade only journals ' +
          'the audit record; the DLL performs the passthrough) and is NOT part of any candidate',
      }
    }
    if (!policy.stageable) throw policyRejection(policy)

    // ── 净变化闸门（契约 v1.2，`[实测]` 阻塞级缺陷的根因）───────────────────────────
    // 只读地"打开或创建"一个**真实已存在**的键必须**零覆盖层条目**：
    // 否则覆盖层会出现空壳，而"只列覆盖层"的枚举会把真实子键全部遮掉
    // （.NET 证书存储 ⇒ PowerShell 起不来）。同值写入同理（与文件侧"内容相同不入候选"一致）。
    // 这一层是**宿主侧参考实现**：DLL 必须按同一规则决定"要不要 Append"。
    const net = filterOverlayNetOperations({ state, baselineFor, operation })
    if (net.effect === 'unknown') {
      // 基线读不到 ⇒ 连"这是打开还是创建"都判不了。此时**失败**比静默不暂存诚实。
      throw stageError(
        'REG_BASELINE_UNREADABLE',
        `${API_BY_OP[operation.op]}(${canonical}): ${net.reason}`,
        { status: REG_STATUS.ERROR_ACCESS_DENIED, path: canonical },
      )
    }
    if (net.effect !== 'net') {
      return {
        status: REG_STATUS.ERROR_SUCCESS,
        path: canonical,
        op: operation.op,
        seq: state.seq,
        bytes: 0,
        record: null,
        net: false,
        netEffect: net.effect,
        reason: net.reason,
      }
    }

    const record = journalRecordForOperation({ ...operation, path: canonical })
    // 只把**净变化**的那几条记录进 WAL（容器链里"真实已存在"的层级是 no-op，必须丢掉）
    const kept = net.state.ops.slice(state.ops.length)
    const bytes = kept.reduce((sum, entry) => sum + appendRecord(recordForOpEntry(entry, operation)), 0)
    state = net.state
    return {
      status: REG_STATUS.ERROR_SUCCESS,
      path: canonical,
      op: operation.op,
      seq: state.seq,
      bytes,
      record,
      net: true,
      netEffect: 'net',
      reason: net.reason,
      entries: kept.length,
    }
  }

  /** 净变化过滤后留下的 op 条目 → 它的 WAL 记录（容器链层级的 volatile 位保持原样） */
  function recordForOpEntry(entry, operation) {
    if (entry.op === REG_STAGE_OP.CREATE_KEY && fold(entry.path) !== fold(parseRegistryPath(operation.path).canonical)) {
      return journalRecordForOperation({ op: 'create-key', path: entry.path, dwOptions: entry.volatile ? REG_OPTIONS.REG_OPTION_VOLATILE : 0 })
    }
    return journalRecordForOperation({ ...operation, path: entry.path })
  }

  /**
   * 这次调用是否"覆盖层无法复现"（视图位等）⇒ 必须**透传真实 API**。
   *
   * 判定必须发生在任何覆盖层存在性检查**之前**：这类调用的目标根本不在覆盖层里，
   * 拿覆盖层视图去判它"不存在"就是把一个我们无权回答的问题当成答案
   * （正是 `RegDeleteKeyExW(HKLM\X, KEY_WOW64_32KEY)` 这类调用会被错判的场景）。
   */
  function isUnstageable(op, path, opts = {}, type) {
    return (
      classifyRegistryOperation({
        api: API_BY_OP[op],
        path: parseRegistryPath(path).canonical,
        type,
        dwOptions: opts.dwOptions,
        samDesired: opts.samDesired,
        wow64Process: opts.wow64Process,
      }).unstaged === true
    )
  }

  /** 暂存"创建/打开键"（对齐 `RegCreateKeyExW`：中间键一并创建） */
  function stageCreateKey(path, opts = {}) {
    requireOpen()
    return persistOperation({
      op: REG_STAGE_OP.CREATE_KEY,
      path,
      dwOptions: opts.dwOptions ?? 0,
      samDesired: opts.samDesired ?? 0,
      wow64Process: opts.wow64Process,
    })
  }

  /** 暂存"删除键"（对齐 `RegDeleteKeyExW`：**有子键就失败**，除非 `recursive`） */
  function stageDeleteKey(path, opts = {}) {
    requireOpen()
    const canonical = parseRegistryPath(path).canonical
    const operation = {
      op: REG_STAGE_OP.DELETE_KEY,
      path: canonical,
      samDesired: opts.samDesired ?? 0,
      wow64Process: opts.wow64Process,
    }
    if (isUnstageable(REG_STAGE_OP.DELETE_KEY, canonical, opts)) return persistOperation(operation)
    const exists = effectiveExists(canonical)
    if (!exists) {
      throw stageError('REG_STAGE_KEY_NOT_FOUND', `RegDeleteKeyExW(${canonical}): 键不存在（ERROR_FILE_NOT_FOUND）`, {
        status: REG_STATUS.ERROR_FILE_NOT_FOUND,
        path: canonical,
      })
    }
    if (opts.recursive !== true) {
      const view = overlayView({ state, path: canonical, baseline: baselineFor(canonical) })
      if (view.subKeys.length > 0) {
        throw stageError(
          'REG_STAGE_KEY_HAS_CHILDREN',
          `RegDeleteKeyExW(${canonical}): 键仍有子键（${view.subKeys.join(', ')}）⇒ ERROR_KEY_HAS_CHILDREN；` +
            '真实 API 同样会拒绝，暂存**不许**假装删掉了一整棵子树',
          { status: REG_STATUS.ERROR_KEY_HAS_CHILDREN, path: canonical, subKeys: [...view.subKeys] },
        )
      }
    }
    return persistOperation(operation)
  }

  /** 暂存"写值"（对齐 `RegSetValueExW`：键不存在时失败） */
  function stageSetValue(path, valueName, type, value, opts = {}) {
    requireOpen()
    const canonical = parseRegistryPath(path).canonical
    const operation = {
      op: REG_STAGE_OP.SET_VALUE,
      path: canonical,
      valueName: typeof valueName === 'string' ? valueName : '',
      type,
      value,
      dwOptions: opts.dwOptions ?? 0,
      samDesired: opts.samDesired ?? 0,
      wow64Process: opts.wow64Process,
    }
    if (isUnstageable(REG_STAGE_OP.SET_VALUE, canonical, opts, type)) return persistOperation(operation)
    if (!effectiveExists(canonical)) {
      throw stageError('REG_STAGE_KEY_NOT_FOUND', `RegSetValueExW(${canonical}): 键不存在（ERROR_FILE_NOT_FOUND）`, {
        status: REG_STATUS.ERROR_FILE_NOT_FOUND,
        path: canonical,
      })
    }
    return persistOperation(operation)
  }

  /** 暂存"删值"（对齐 `RegDeleteValueW`：值不存在时失败） */
  function stageDeleteValue(path, valueName, opts = {}) {
    requireOpen()
    const canonical = parseRegistryPath(path).canonical
    const operation = {
      op: REG_STAGE_OP.DELETE_VALUE,
      path: canonical,
      valueName: valueName ?? '',
      samDesired: opts.samDesired ?? 0,
      wow64Process: opts.wow64Process,
    }
    if (isUnstageable(REG_STAGE_OP.DELETE_VALUE, canonical, opts)) return persistOperation(operation)
    if (!effectiveExists(canonical)) {
      throw stageError('REG_STAGE_KEY_NOT_FOUND', `RegDeleteValueW(${canonical}): 键不存在`, {
        status: REG_STATUS.ERROR_FILE_NOT_FOUND,
        path: canonical,
      })
    }
    const view = overlayView({ state, path: canonical, baseline: baselineFor(canonical) })
    const wanted = fold(valueName ?? '')
    if (!Object.keys(view.values).some((name) => fold(name) === wanted)) {
      throw stageError('REG_STAGE_VALUE_NOT_FOUND', `RegDeleteValueW(${canonical}\\${valueName}): 值不存在`, {
        status: REG_STATUS.ERROR_FILE_NOT_FOUND,
        path: canonical,
        valueName,
      })
    }
    return persistOperation(operation)
  }

  function effectiveExists(canonical) {
    const overlay = overlayKeyExists(state, canonical)
    if (overlay !== undefined) return overlay
    const base = baselineFor(canonical)
    if (base.accessDenied === true) {
      // 读不到 ≠ 不存在。把"拒绝访问"报成"键不存在"会让调用方去创建它，
      // 而真实原因可能是它确实存在、只是宿主也读不到。
      throw stageError(
        'REG_BASELINE_UNREADABLE',
        `baseline for ${canonical} is unreadable (ERROR_ACCESS_DENIED); refusing to guess whether it exists`,
        { status: REG_STATUS.ERROR_ACCESS_DENIED, path: canonical },
      )
    }
    return base.exists === true
  }

  /** 覆盖层视图快照：带路径 → 该键；不带 → 所有被触碰路径 */
  function snapshot(path) {
    requireOpen()
    if (path !== undefined) {
      const canonical = parseRegistryPath(path).canonical
      return overlayView({ state, path: canonical, baseline: baselineFor(canonical) })
    }
    const paths = overlayTouchedPaths(state)
    const baseline = {}
    const overlay = {}
    for (const entry of paths) {
      const base = baselineFor(entry)
      baseline[entry] = base
      overlay[entry] = overlayView({ state, path: entry, baseline: base })
    }
    return { paths, baseline, overlay }
  }

  function diff() {
    requireOpen()
    return diffOverlay({ state, baselineFor })
  }

  function enqueueCandidate(frozen) {
    const existing = readJsonIfExists(queuePath)
    if (existing !== undefined && existing.version !== 1) {
      throw stageError('REG_STAGE_QUEUE_VERSION', `unsupported queue version ${String(existing.version)} at ${queuePath}`)
    }
    const queue = existing ?? emptyQueue()
    queue.order = Array.isArray(queue.order) ? queue.order : []
    queue.candidates = queue.candidates ?? {}
    queue.supersededBy = queue.supersededBy ?? {}
    queue.discarded = queue.discarded ?? []
    queue.order.push(frozen.id)
    queue.candidates[frozen.id] = { id: frozen.id, status: CANDIDATE_STATUS.PENDING, createdAt: frozen.createdAt, files: frozen.summary.files }

    // 取代：同一会话、同一路径的旧待审（与 workspace.freezeCandidate 同口径）
    const unitPaths = new Set(frozen.changes.map((change) => fold(change.path)))
    for (const otherId of queue.order) {
      if (otherId === frozen.id) continue
      const other = readJsonIfExists(join(candidateDir, `${otherId}.json`))
      if (!other || other.status !== CANDIDATE_STATUS.PENDING) continue
      if (other.origin !== REGISTRY_CANDIDATE_ORIGIN) continue
      if (other.sessionId !== frozen.sessionId) continue
      if (!other.changes.some((change) => unitPaths.has(fold(change.path)))) continue
      other.status = CANDIDATE_STATUS.SUPERSEDED
      other.supersededBy = frozen.id
      other.supersededAt = frozen.createdAt
      writeJson(join(candidateDir, `${otherId}.json`), other)
      queue.candidates[otherId] = { ...queue.candidates[otherId], status: CANDIDATE_STATUS.SUPERSEDED, supersededBy: frozen.id }
      queue.supersededBy[otherId] = frozen.id
    }
    writeJson(queuePath, queue)
    return queue
  }

  /**
   * 冻结候选：把当前覆盖层变更写成**与文件候选同构**的 `candidates/<id>.json`
   * 并登记进 `queue.json`（因此进同一个审批面板）。无净变化时**不**入队。
   */
  function freezeCandidate(opts = {}) {
    requireOpen()
    const result = diff()
    const changes = overlayChangesToCandidateChanges(result)
    if (changes.length === 0) {
      return {
        enqueued: false,
        reason: result.unreadable.length > 0 ? 'no-freezable-change' : 'no-net-change',
        changes: [],
        unreadable: result.unreadable,
        subKeysUnknown: result.subKeysUnknown,
        warnings: result.warnings,
      }
    }
    const queue = readJsonIfExists(queuePath)
    const sequence = (queue?.order?.length ?? 0) + 1
    const id = typeof opts.id === 'string' && opts.id.length > 0 ? opts.id : newCandidateId(sequence)
    const createdAt = now()
    const frozen = {
      version: 1,
      id,
      createdAt,
      sessionId,
      workspaceRoot: opts.workspaceRoot ?? options.workspaceRoot ?? null,
      revision: null,
      source: opts.source ?? REGISTRY_CANDIDATE_SOURCE,
      origin: REGISTRY_CANDIDATE_ORIGIN,
      status: CANDIDATE_STATUS.PENDING,
      supersededBy: undefined,
      changes,
      hostOperations: [],
      summary: summarizeRegistryChanges(changes),
      baselines: Object.fromEntries(
        Object.entries(result.roots).map(([path, root]) => [path, root.baselineFrozen]),
      ),
      unfrozen: result.unreadable,
      // WP12：这些路径的**子键维度**没能冻结（读取器没报枚举）。如实落盘，别让"没冻结"
      // 看起来像"冻结了一个空表"。
      unfrozenSubKeys: result.subKeysUnknown,
      warnings: result.warnings,
      note:
        '注册表候选：before 来自宿主令牌下的真实 hive 快照，after 来自覆盖层视图。' +
        '应用前真实 hive 不会被本候选改动；丢弃即回到"什么都没发生"。',
    }
    mkdirSync(candidateDir, { recursive: true })
    writeJson(join(candidateDir, `${id}.json`), frozen)
    if (opts.enqueue !== false) enqueueCandidate(frozen)
    candidate = frozen
    resolution = { ...resolution, status: CANDIDATE_STATUS.PENDING, candidateId: id }
    saveResolution()
    return {
      enqueued: opts.enqueue !== false,
      candidate: frozen,
      changes,
      unreadable: result.unreadable,
      subKeysUnknown: result.subKeysUnknown,
      warnings: result.warnings,
    }
  }

  /** 覆盖层最终意图 → 应用单元（**按 WAL 顺序**，因为真实 API 是有顺序的） */
  function applyUnits() {
    const units = []
    for (const entry of state.ops) {
      if (entry.op === REG_STAGE_OP.CREATE_KEY) {
        units.push({
          op: 'create-key',
          path: entry.path,
          keyPath: entry.path,
          // 保留 volatile 选项（WAL 里记了 VOLATILE 位）：否则"重启即失"的真实语义会在应用时丢失，
          // 而文档说"应用时保留该选项"就成了一句不成立的承诺。
          dwOptions: entry.volatile ? REG_OPTIONS.REG_OPTION_VOLATILE : 0,
        })
      } else if (entry.op === REG_STAGE_OP.DELETE_KEY) units.push({ op: 'delete-key', path: entry.path, keyPath: entry.path })
      else if (entry.op === REG_STAGE_OP.SET_VALUE) {
        units.push({
          op: 'set-value',
          path: registryValueUnitPath(entry.path, entry.valueName ?? ''),
          keyPath: entry.path,
          valueName: entry.valueName ?? '',
          type: entry.typeName,
          data: entry.data,
        })
      } else if (entry.op === REG_STAGE_OP.DELETE_VALUE) {
        units.push({
          op: 'delete-value',
          path: registryValueUnitPath(entry.path, entry.valueName ?? ''),
          keyPath: entry.path,
          valueName: entry.valueName ?? '',
        })
      }
    }
    return units
  }

  function frozenBaselineFor(canonical) {
    if (!candidate || !candidate.baselines) return undefined
    const wanted = fold(canonical)
    const found = Object.entries(candidate.baselines).find(([path]) => fold(path) === wanted)
    return found ? found[1] : undefined
  }

  /** 成功应用一个单元后，把该键的冻结基线刷新成现状（见 apply() 里的理由） */
  function refreshFrozenBaseline(canonical) {
    if (!candidate || !candidate.baselines) return
    const fresh = serializeSnapshot(readBaselineFresh(canonical))
    const wanted = fold(canonical)
    const existing = Object.keys(candidate.baselines).find((path) => fold(path) === wanted)
    if (existing !== undefined) candidate.baselines[existing] = fresh
    else candidate.baselines[canonical] = fresh
  }

  /**
   * 选择性应用：`paths` 为空 = 应用全部；否则只应用路径命中的单元。
   *
   * 三条 fail-closed 规则：
   *   1. 没有 writer ⇒ 抛 `REG_WRITER_MISSING`（**绝不**假装应用成功）；
   *   2. 冻结后的真实 hive 变了 ⇒ 该单元标 `stale` 且**不写**（除非 `force: true`）；
   *   3. writer 返回非 0 LSTATUS ⇒ 该单元标 `failed` 并带上原始状态码。
   */
  function apply(opts = {}) {
    requireOpen()
    if (resolution.status === CANDIDATE_STATUS.DISCARDED) {
      throw stageError('REG_CANDIDATE_DISCARDED', `registry candidate ${resolution.candidateId} was discarded`, {
        id: resolution.candidateId,
      })
    }
    const activeWriter = opts.writer ?? writer
    if (!activeWriter || typeof activeWriter !== 'object') {
      throw stageError(
        'REG_WRITER_MISSING',
        'registry-stage.apply() needs a writer (host token). Without one we cannot apply, and pretending ' +
          'to apply would be exactly the dishonesty this project forbids',
      )
    }
    const frozen = candidate ?? freezeCandidate({ enqueue: false }).candidate
    if (!frozen) return { status: 'no-net-change', applied: [], failed: [], skipped: [], stale: [], note: 'no changes to apply' }

    const selected = Array.isArray(opts.paths) && opts.paths.length > 0 ? new Set(opts.paths.map((path) => fold(path))) : null
    // ── 只应用**候选里冻结过**的单元（契约 v1.2）──────────────────────────────────
    // 覆盖层的 WAL 可能含净变化为零的操作（例如"打开或创建"了一个真实已存在的键、
    // 或写入与现值相同的值）。候选是从 diff 出来的**净变化**，因此应用时必须以候选为准：
    // 不能把没被审批过的空操作也重放到真实 hive 上。
    const approved = new Set((frozen.changes ?? []).map((change) => fold(change.path)))
    const units = applyUnits()
    const applied = []
    const failed = []
    const skipped = []
    const stale = []
    const blocked = []
    const appliedSet = new Set(resolution.appliedPaths.map((path) => fold(path)))
    /** 本次 apply 里**已成功建立**的键（小写规范路径），用于父键依赖判定 */
    const createdHere = new Set()

    for (const unit of units) {
      if (!approved.has(fold(unit.path))) {
        skipped.push({ path: unit.path, op: unit.op, reason: 'not-in-candidate' })
        continue
      }
      if (selected && !selected.has(fold(unit.path))) {
        skipped.push({ path: unit.path, op: unit.op, reason: 'not-selected' })
        continue
      }
      if (appliedSet.has(fold(unit.path))) {
        skipped.push({ path: unit.path, op: unit.op, reason: 'already-applied' })
        continue
      }
      // ── 父键依赖（契约 v1.3）──────────────────────────────────────────────
      // `RegSetValueExW`/`RegDeleteValueW`/`RegDeleteKeyExW` 都要求"目标键存在"，
      // 否则真实 API 返回 ERROR_FILE_NOT_FOUND(2)。**只批准子单元、不批准父键的 mkdir** 时，
      // 要么"替用户顺手建父键"（等于应用了没被批准的单元），要么"如实失败"。
      // 这里选**如实失败**：`blocked` 带 status=2 与明确 reason，且**一个字节都不写**。
      // 判定依据：本次 apply 刚建出来的键（`createdHere`）或真实 hive 里本来就有。
      if (unit.op === 'set-value' || unit.op === 'delete-value' || unit.op === 'delete-key') {
        let keyPresent = createdHere.has(fold(unit.keyPath))
        if (!keyPresent) {
          try {
            keyPresent = readBaselineFresh(unit.keyPath).exists === true
          } catch (error) {
            blocked.push({
              path: unit.path,
              op: unit.op,
              status: REG_STATUS.ERROR_ACCESS_DENIED,
              reason: `cannot determine whether the parent key exists: ${error.code ?? error.name}`,
            })
            continue
          }
        }
        if (!keyPresent) {
          blocked.push({
            path: unit.path,
            op: unit.op,
            status: REG_STATUS.ERROR_FILE_NOT_FOUND,
            reason:
              `parent key ${unit.keyPath} does not exist in the real hive and its create-key unit was not applied ` +
              '(approve the mkdir unit too; apply() never silently creates an unapproved key)',
          })
          continue
        }
      }
      // ── 幂等创建：已存在的键不得让整批失败（WP12）────────────────────────────
      // `RegCreateKeyExW` 是"打开或创建"：落在**真实已存在**的键上时，这一步的真实效果为零。
      // 但 `reg add <已存在键> /f` 在写保护/受限令牌下会返回 ERROR_ACCESS_DENIED(5)
      // （`[实测]` 本机：`reg add HKCU\Software /f` = Access is denied），
      // 于是一条"什么都没改"的单元把整批打成 partially-applied（"整批批不动"）。
      // 口径：**只有读到"确实存在"才跳过**；读不到（accessDenied/unreadable）一律不跳，
      // 交给真实 API 裁决 —— 不猜、也不静默跳过真正的创建。
      if (unit.op === 'create-key') {
        let alreadyThere = false
        try {
          const current = readBaselineFresh(unit.keyPath)
          alreadyThere = current.exists === true && current.accessDenied !== true && current.unreadable !== true
        } catch {
          alreadyThere = false // 读不到就照常走真实写入，失败也如实记账
        }
        if (alreadyThere) {
          skipped.push({
            path: unit.path,
            op: unit.op,
            noop: true,
            reason:
              'already-exists-in-real-hive: RegCreateKeyExW is "open or create", so this unit is a no-op; ' +
              'a no-op create must not block the batch (and must not trigger `reg add <existing key> /f`)',
          })
          // 目标状态已经成立 ⇒ 不留在 `remaining` 里（否则整批会被一条空操作拖成 partially-applied）。
          appliedSet.add(fold(unit.path))
          continue
        }
      }
      const baselineFrozen = frozenBaselineFor(unit.keyPath)
      if (baselineFrozen !== undefined && opts.force !== true) {
        // 必须**现读**真实 hive（不用缓存），否则这个检查永远通过。
        const current = serializeSnapshot(readBaselineFresh(unit.keyPath))
        if (current !== baselineFrozen) {
          stale.push({
            path: unit.path,
            op: unit.op,
            reason: 'real hive changed after the candidate was frozen; refusing to apply a stale before',
          })
          continue
        }
      }
      let result
      try {
        if (unit.op === 'create-key') result = activeWriter.createKey(unit.path, { dwOptions: unit.dwOptions ?? 0 })
        else if (unit.op === 'delete-key') result = activeWriter.deleteKey(unit.path, { recursive: true })
        else if (unit.op === 'set-value') result = activeWriter.setValue(unit.keyPath, unit.valueName, unit.type, unit.data)
        else result = activeWriter.deleteValue(unit.keyPath, unit.valueName)
      } catch (error) {
        failed.push({ path: unit.path, op: unit.op, status: error.status ?? REG_STATUS.ERROR_ACCESS_DENIED, reason: String(error.message) })
        continue
      }
      const status = (result?.status ?? result ?? 0) >>> 0
      if (status === REG_STATUS.ERROR_SUCCESS) {
        applied.push({ path: unit.path, op: unit.op })
        appliedSet.add(fold(unit.path))
        if (unit.op === 'create-key') createdHere.add(fold(unit.path))
        if (unit.op === 'delete-key') createdHere.delete(fold(unit.path))
        // 我们自己的写入**合法地**改变了真实 hive（例如先应用了 B，再应用 A 时该键已经多了一个值）。
        // 若不放宽这一点，同一候选的第二个单元会被我们自己的第一个单元判成 stale。
        // 因此：每个成功单元之后，把该键的冻结基线刷新成"写入后的现状"。
        // 代价（如实声明）：同一候选内、对**同一个键**的两次写入之间发生的外部改动，
        // 不会再被 stale 检查捕获；跨候选/首次触碰该键时仍然照常检查。
        refreshFrozenBaseline(unit.keyPath)
      } else {
        failed.push({ path: unit.path, op: unit.op, status, reason: `writer returned LSTATUS ${status}` })
      }
    }

    resolution.appliedPaths = [...new Set([...resolution.appliedPaths, ...applied.map((unit) => unit.path)])]
    const remaining = units.filter((unit) => !appliedSet.has(fold(unit.path)))
    if (failed.length === 0 && remaining.length === 0 && applied.length > 0) resolution.status = CANDIDATE_STATUS.APPLIED
    else if (applied.length > 0) resolution.status = CANDIDATE_STATUS.PARTIALLY_APPLIED
    else if (stale.length > 0 && failed.length === 0) resolution.status = CANDIDATE_STATUS.STALE
    saveResolution()
    // 候选文件是审计对象：应用后把"已应用了什么 + 刷新后的 before"落盘，
    // 否则磁盘上的候选会长期停在冻结那一刻，与真实发生的应用不一致。
    if (candidate) writeJson(join(candidateDir, `${candidate.id}.json`), candidate)
    // 应用后真实 hive 变了：基线缓存立刻失效，否则后续 diff() 会拿"应用前"的基线
    // 与覆盖层比，报出已经不存在的差异（幻影差异）。
    baselines.clear()

    return {
      id: frozen.id,
      status: resolution.status,
      applied,
      failed,
      skipped,
      stale,
      blocked,
      remaining: remaining.map((unit) => unit.path),
      note:
        'apply() 在**宿主令牌**下逐条重放 WAL（保持顺序）：未选中的单元仍留在覆盖层，' +
        '真实 hive 只被已 applied 的单元触碰；父键未批准时子单元进 `blocked`（status=2），不会被静默补建；' +
        '`RegCreateKeyExW` 落在**真实已存在**的键上时进 `skipped`（noop=true, WP12）——空操作创建不许把整批打成失败',
    }
  }

  /** 丢弃：真实 hive 从未被本候选触碰；覆盖层被清空，WAL 改名保留为审计副本 */
  function discard(opts = {}) {
    requireOpen()
    resolution.status = CANDIDATE_STATUS.DISCARDED
    resolution.discardedAt = now()
    resolution.discardReason = typeof opts.reason === 'string' && opts.reason.length > 0 ? opts.reason : 'user'
    saveResolution()

    let auditPath = null
    if (existsSync(journalPath)) {
      if (existsSync(discardedPath)) rmSync(discardedPath, { force: true })
      renameSync(journalPath, discardedPath)
      auditPath = discardedPath
    }
    let hiveRemoved = false
    if (existsSync(hivePath)) {
      rmSync(hivePath, { force: true })
      hiveRemoved = true
    }

    const id = resolution.candidateId
    if (id) {
      const queue = readJsonIfExists(queuePath)
      if (queue && queue.version === 1 && queue.candidates?.[id]) {
        queue.candidates[id] = { ...queue.candidates[id], status: CANDIDATE_STATUS.DISCARDED }
        queue.discarded = [...(queue.discarded ?? []), { id, at: resolution.discardedAt, reason: resolution.discardReason }]
        writeJson(queuePath, queue)
      }
    }

    state = createOverlayState({ sessionId })
    baselines.clear()
    candidate = null
    return {
      discarded: true,
      id: id ?? null,
      auditPath,
      hiveRemoved,
      note:
        '丢弃只清理覆盖层：真实 hive 之所以没变，是因为 apply() 从未运行过 —— ' +
        '而不是因为"我们把改动撤回来了"',
    }
  }

  return {
    // 只读元信息
    sessionDir,
    stageRoot,
    hivePath,
    journalPath,
    statePath,
    discardedPath,
    sessionId,
    // 生命周期
    open,
    snapshot,
    diff,
    freezeCandidate,
    apply,
    discard,
    // 暂存写入（宿主侧参考实现；DLL 走同一份 WAL 协议）
    stageCreateKey,
    stageDeleteKey,
    stageSetValue,
    stageDeleteValue,
    // 查询（shim 语义的参考实现）
    readKey: (path) => {
      requireOpen()
      return overlayQueryKey({ state, path, baseline: baselineFor(path) })
    },
    readValue: (path, valueName = '') => {
      requireOpen()
      return overlayQueryValue({ state, path, valueName, baseline: baselineFor(path) })
    },
    enumKeys: (path) => {
      requireOpen()
      return overlayEnumKeys({ state, path, baseline: baselineFor(path) })
    },
    enumValues: (path) => {
      requireOpen()
      return overlayEnumValues({ state, path, baseline: baselineFor(path) })
    },
    // 注入与内部状态
    setReader: (next) => {
      reader = next
      baselines.clear()
      return next
    },
    setWriter: (next) => {
      writer = next
      return next
    },
    getState: () => state,
    getResolution: () => ({ ...resolution }),
    getCandidate: () => candidate,
    hardDenials: () => REGISTERED_HARD_DENIALS,
  }
}

// ──────────────────── Win32 写适配器（[未实测]）────────────────────

/**
 * 用 Koffi 形状的绑定构造**宿主侧**写入器（`apply()` 用）。
 *
 * `[未实测]`：与 `createRegistryReader` 同样，本机没有跑过完整写入（需要宿主令牌 + 真实 hive），
 * 这里只集中"调用形状"并把非零 LSTATUS **如实返回**（绝不吞掉）。
 *
 * 绑定契约（JS 形状，不是 C ABI）：
 *   `regCreateKeyExW(rootHandle, subKey, reserved, class, dwOptions, samDesired)` → `{status, handle}`
 *   `regOpenKeyExW(rootHandle, subKey, options, samDesired)`                     → `{status, handle}`
 *   `regSetValueExW(keyHandle, valueName, reserved, type, dataBuffer)`           → `{status}`
 *   `regDeleteValueW(keyHandle, valueName)`                                      → `{status}`
 *   `regDeleteKeyExW(rootHandle, subKey, samDesired, reserved)`                  → `{status}`
 *   `regCloseKey(handle)`                                                        → 任意
 */
export function createRegistryWriter(bindings) {
  if (!bindings || typeof bindings.regCreateKeyExW !== 'function' || typeof bindings.regSetValueExW !== 'function') {
    throw stageError('REG_BINDINGS_MISSING', 'createRegistryWriter requires bindings.regCreateKeyExW and regSetValueExW')
  }
  if (typeof bindings.regDeleteValueW !== 'function' || typeof bindings.regDeleteKeyExW !== 'function') {
    throw stageError('REG_BINDINGS_MISSING', 'createRegistryWriter requires bindings.regDeleteValueW and regDeleteKeyExW')
  }
  const close = (handle) => {
    try {
      if (handle !== undefined && handle !== null && typeof bindings.regCloseKey === 'function') bindings.regCloseKey(handle)
    } catch {
      /* 关闭失败只影响句柄残留，不掩盖主结果 */
    }
  }
  const openForWrite = (path, sam) => {
    const { handle, subKey } = parseRegistryPath(path)
    const opened = bindings.regOpenKeyExW(handle, subKey, 0, sam)
    const status = (opened?.status ?? opened) >>> 0
    if (status !== REG_STATUS.ERROR_SUCCESS) {
      throw stageError('REG_OPEN_FAILED', `RegOpenKeyExW(${path}) -> ${status}`, { status })
    }
    return opened.handle
  }

  return {
    createKey(path, opts = {}) {
      const { handle, subKey } = parseRegistryPath(path)
      const created = bindings.regCreateKeyExW(handle, subKey, 0, null, opts.dwOptions ?? 0, REG_ACCESS.KEY_ALL_ACCESS)
      const status = (created?.status ?? created) >>> 0
      if (status === REG_STATUS.ERROR_SUCCESS) close(created.handle)
      return { status }
    },
    setValue(path, valueName, type, dataHex) {
      const keyHandle = openForWrite(path, REG_ACCESS.KEY_SET_VALUE)
      try {
        const typeNumber = REG_TYPES[registryTypeName(type)]
        // `dataHex` 是**快照口径**（`0x…` 文本或裸十六进制），必须走类型感知的线格式转换。
        // 这里若写 `Buffer.from(dataHex,'hex')`，`'0x…'` 的 `x` 会被静默截断成**空数据**
        // —— 那正是本模块在 WAL 编码处踩到过的同一个 F8 同族缺陷（本例由测试当场抓到）。
        const data = registryWireBytes(registryTypeName(type), typeof dataHex === 'string' ? dataHex : '')
        const result = bindings.regSetValueExW(keyHandle, valueName ?? '', 0, typeNumber, data)
        return { status: (result?.status ?? result ?? 0) >>> 0 }
      } finally {
        close(keyHandle)
      }
    },
    deleteValue(path, valueName) {
      const keyHandle = openForWrite(path, REG_ACCESS.KEY_SET_VALUE)
      try {
        const result = bindings.regDeleteValueW(keyHandle, valueName ?? '')
        return { status: (result?.status ?? result ?? 0) >>> 0 }
      } finally {
        close(keyHandle)
      }
    },
    deleteKey(path, opts = {}) {
      // RegDeleteKeyExW 收的是**父键句柄 + 子键名**（不是自身句柄）—— 传错会把父键删掉。
      const { canonical } = parseRegistryPath(path)
      const parent = canonical.includes('\\') ? canonical.slice(0, canonical.lastIndexOf('\\')) : canonical
      const child = canonical.includes('\\') ? canonical.slice(canonical.lastIndexOf('\\') + 1) : ''
      if (child.length === 0) return { status: REG_STATUS.ERROR_INVALID_PARAMETER }
      const { handle, subKey } = parseRegistryPath(parent)
      const result = bindings.regDeleteKeyExW(handle, subKey.length > 0 ? `${subKey}\\${child}` : child, opts.samDesired ?? 0, 0)
      return { status: (result?.status ?? result ?? 0) >>> 0 }
    },
  }
}

// ──────────────── 符合性（契约用**真实产物**来钉，不靠约定）────────────────
//
// 为什么把符合性判定做成**纯函数 + 机器可读清单**，而不是写在文档里：
// 2026-09-30 的集成实测给出了反例 —— shim DLL 自创了 `reg\<HIVE>\<Key>\values.wsv`
// 单键一个文件，**没有导出 `DshRegStage*`、没有写 `registry/overlay.journal`**，
// 于是"沙箱内注册表写成功"与"审批面板看得到这条改动"断成了两半（19/21）。
// 光靠消息对齐抓不住这类漂移；把契约变成**可执行的判定**才能。
// 因此这里给出三件事，供 `tests/registry-conformance.mjs` 在**真实 DLL 与真实报告**上执行：
//   1. `REG_STAGE_ABI_REQUIRED_EXPORTS` / `REG_STAGE_CONFORMANCE`：契约的机器可读形态；
//   2. `validateJournalBuffer()`：真实 WAL 字节流是否符合 §4.3（含 reserved、字节序、kind/flags 组合）；
//   3. `validateReadbackEvidence()` / `validateEvidenceFreshness()`：证据本身是否成立
//      （"queryRc==0 却没有内容"与"报告比 DLL 旧"都必须判红 —— 前者是 README 缺陷 11 那一类
//       伪装成证据，后者会让一个已经修好的实现永远显示为坏、或让一个坏实现显示为已修好）。

/**
 * DLL **必须**导出的符号（缺一即红）。
 *
 * 参数语义（这一条上次就是漂移点，所以写进契约本身）：
 * `DshRegStageAttach(stageRoot, sessionId)` 的第一个参数是**会话暂存根**
 * （= shim 现有的 `WINSTAGE_STAGE_ROOT`），`registry/` 子目录由 DLL 自己拼
 * ⇒ journal 落在 `<stageRoot>\registry\overlay.journal`。
 */
export const REG_STAGE_ABI_REQUIRED_EXPORTS = Object.freeze([
  'DshRegStageAbiVersion',
  'DshRegStageAttach',
  'DshRegStageDetach',
  'DshRegStageJournalAppend',
])

/** 可选导出（有更好；缺了不算违约） */
export const REG_STAGE_ABI_OPTIONAL_EXPORTS = Object.freeze(['DshRegStageAttachState'])

/**
 * 契约的**机器可读**形态：文档、测试、DLL 三方引用同一份，避免"文档改了、代码没改"。
 */
export const REG_STAGE_CONFORMANCE = Object.freeze({
  abiVersion: REG_STAGE_ABI_VERSION,
  requiredExports: REG_STAGE_ABI_REQUIRED_EXPORTS,
  optionalExports: REG_STAGE_ABI_OPTIONAL_EXPORTS,
  /** 暂存根（shim 现有环境变量）；`registry/` 由 DLL 拼在其下 */
  stageRootEnv: 'WINSTAGE_STAGE_ROOT',
  /** 兼容别名：DshRegStageAttach 的显式参数优先于任何环境变量 */
  stageRootAliasEnv: 'DSH_REGSTAGE_ROOT',
  stageSubdir: REGISTRY_STAGE_SUBDIR,
  journalName: OVERLAY_JOURNAL_NAME,
  /** RECOMMENDED：shim 自用的读回存储（宿主**不**读它）；用不用 app hive 是 T4 的实现自由 */
  hiveName: OVERLAY_HIVE_NAME,
  stateName: OVERLAY_STATE_NAME,
  recordSize: REG_STAGE_RECORD_SIZE,
  recordOffsets: REG_STAGE_RECORD_OFFSETS,
  magic: REG_STAGE_JOURNAL_MAGIC,
  hookedApis: REG_STAGE_HOOKED_APIS,
  hardDenyStatus: HARD_DENY_STATUS,
  walFirst: true,
  /** T4 的闭环节 runner 必须满足的四条（否则 E3/E5 永远证明不了闭环） */
  runnerRequirements: Object.freeze([
    'E3.overlay-has-value 必须改成读 <stageRoot>/registry/overlay.journal 并断言 SET_VALUE 记录（path/name/type/data 逐字段），不再比较 values.wsv 的十六进制文本',
    '新增 E3.host-can-freeze-candidate：宿主 createRegistryStage({sessionDir, reader}) → freezeCandidate() 必须包含该写入（这是"走审批面板"的闭环）',
    'E5.registry-read-back 必须要求 queryRc==0 时回传内容（data 为字符串，或 bytes>0），且 type 是合法 REG_*（0..11）',
    '闭环节报告必须比 winstage-shim.dll 新：否则证据过期，必须重跑 node tools/run-shim-closedloop.mjs',
  ]),
  note:
    '覆盖层是**逻辑重定向**：宿主只需要 registry/overlay.journal；overlay.hive 是 shim 内部读回存储的推荐实现，' +
    '宿主不读它。真实 hive 在 apply() 之前不得被触碰。',
})

function addProblem(problems, code, detail, index) {
  problems.push(index === undefined ? { code, detail } : { code, detail, index })
}

/**
 * 判定一段真实 WAL 字节流是否符合契约（纯函数）。
 *
 * @param {Buffer} buffer
 * @returns {{ok: boolean, problems: Array<{code: string, detail: string, index?: number}>, records: object[], summary: object}}
 */
export function validateJournalBuffer(buffer) {
  const problems = []
  if (!Buffer.isBuffer(buffer)) {
    addProblem(problems, 'NOT_A_BUFFER', `expected a Buffer, got ${typeof buffer}`)
    return { ok: false, problems, records: [], summary: {} }
  }
  let decoded
  try {
    decoded = decodeJournalRecords(buffer)
  } catch (error) {
    addProblem(problems, 'DECODE_FAILED', `${error.code ?? error.name}: ${error.message}`)
    return { ok: false, problems, records: [], summary: {} }
  }
  if (decoded.records.length === 0) {
    addProblem(problems, 'EMPTY_JOURNAL', 'journal has zero complete records: the DLL did not implement the WAL (or wrote nothing)')
  }
  if (decoded.torn === true) {
    addProblem(
      problems,
      'TORN_TAIL',
      `${decoded.trailingBytes} trailing byte(s) are not a complete record: a finished run must not leave a half-written record`,
    )
  }

  for (const [index, record] of decoded.records.entries()) {
    if (record.version !== REGISTRY_STAGE_VERSION) addProblem(problems, 'BAD_VERSION', `version=${record.version}`, index)
    if (record.reserved !== 0) addProblem(problems, 'RESERVED_NONZERO', `reserved=${record.reserved} must be 0`, index)
    if (record.pathChars === 0) addProblem(problems, 'EMPTY_PATH', 'pathChars=0', index)
    // 占位名（`<unstaged:RegSetValueExW>`、`<unknown:NtSetValueKey>`、`<RegCreateKeyExW:unsupported-option>`）
    // 是**审计标签**，不是可解析路径：硬拒/透传记录的路径可能根本派生不出来
    // （那正是它们被拒/被透传的原因）。对这些记录做"必须是规范路径"的判定，等于要求
    // "把不可解析的东西解析出来"—— 于是把真实 WAL 判红。因此只对**可暂存**记录做路径判定。
    const isPlaceholder = record.path.startsWith('<')
    const auditable = record.kind === REG_STAGE_KIND.HARD_DENY || record.kind === REG_STAGE_KIND.UNSTAGED
    if (isPlaceholder && !auditable) {
      addProblem(problems, 'PLACEHOLDER_PATH', `${record.path} looks like an audit placeholder but kind=${record.kindName} must name a real key`, index)
    }
    if (!isPlaceholder) {
      try {
        const parsed = parseRegistryPath(record.path)
        if (!REG_HIVES_STAGEABLE.includes(parsed.hive)) {
          addProblem(problems, 'HIVE_NOT_STAGEABLE', `${record.path} resolves to hive ${parsed.hive}`, index)
        }
        if (parsed.canonical !== record.path) {
          addProblem(problems, 'PATH_NOT_CANONICAL', `${record.path} is not the canonical form (${parsed.canonical})`, index)
        }
        // 裸 hive 根（`HKCU`）永远存在：create-key/delete-key 记在它身上一定是空操作或非法操作
        // （`RegOpenKeyExW(HKCU, NULL)` 属于这一类）。`SET_VALUE` 不在此列：根键上确实可能有值。
        if ((record.kind === REG_STAGE_KIND.CREATE_KEY || record.kind === REG_STAGE_KIND.DELETE_KEY) && parsed.canonical === parsed.hive) {
          addProblem(
            problems,
            'PATH_IS_BARE_ROOT',
            `${record.path} is a predefined hive root: it always exists, so create/delete on it is either a no-op or illegal`,
            index,
          )
        }
      } catch (error) {
        addProblem(problems, 'PATH_UNPARSEABLE', `${error.code ?? error.name}: ${error.message}`, index)
      }
    }

    if (record.kind === REG_STAGE_KIND.SET_VALUE) {
      if ((record.flags & REG_STAGE_FLAGS.HAS_VALUE_NAME) === 0) {
        addProblem(problems, 'SET_VALUE_WITHOUT_NAME_FLAG', 'SET_VALUE must set HAS_VALUE_NAME (the default value has an empty name, not a missing one)', index)
      }
      if ((record.flags & REG_STAGE_FLAGS.HAS_DATA) === 0) {
        addProblem(problems, 'SET_VALUE_WITHOUT_DATA_FLAG', 'SET_VALUE must set HAS_DATA', index)
      }
      if (record.typeName === undefined) {
        addProblem(problems, 'SET_VALUE_BAD_TYPE', `type=${record.type} is not a known winreg.h REG_* value`, index)
      } else if (REG_STAGE_UNSUPPORTED_TYPES.includes(record.typeName)) {
        addProblem(problems, 'SET_VALUE_UNSUPPORTED_TYPE', `${record.typeName} has no codec and must be hard-denied, not staged`, index)
      }
      if (record.data === null) addProblem(problems, 'SET_VALUE_DATA_NULL', 'SET_VALUE carried no data payload', index)
    }
    if (record.kind === REG_STAGE_KIND.DELETE_VALUE && (record.flags & REG_STAGE_FLAGS.HAS_VALUE_NAME) === 0) {
      addProblem(problems, 'DELETE_VALUE_WITHOUT_NAME_FLAG', 'DELETE_VALUE must set HAS_VALUE_NAME', index)
    }
    if ((record.kind === REG_STAGE_KIND.CREATE_KEY || record.kind === REG_STAGE_KIND.DELETE_KEY) && record.dataBytes !== 0) {
      addProblem(problems, 'KEY_RECORD_WITH_DATA', `dataBytes=${record.dataBytes} must be 0 for key records`, index)
    }
    if (record.kind === REG_STAGE_KIND.HARD_DENY) {
      if ((record.flags & REG_STAGE_FLAGS.HARD_DENY) === 0) {
        addProblem(problems, 'HARD_DENY_WITHOUT_FLAG', 'kind=HARD_DENY must set the HARD_DENY flag', index)
      }
      if (record.status === 0) {
        addProblem(problems, 'HARD_DENY_STATUS_ZERO', 'a hard-denied call must carry the real non-zero LSTATUS', index)
      }
    }
    if (record.kind === REG_STAGE_KIND.UNSTAGED) {
      // 透传记录的三条硬性约束（契约 v1.4）：置 UNSTAGED 位、`type` 是原因码、**没有**被拒的 LSTATUS。
      // 少了任何一条，"透传"就会与"暂存成功"或"硬拒"混在一起 —— 那正是这条契约要消灭的歧义。
      if ((record.flags & REG_STAGE_FLAGS.UNSTAGED) === 0) {
        addProblem(problems, 'UNSTAGED_WITHOUT_FLAG', 'kind=UNSTAGED must set the UNSTAGED flag', index)
      }
      if (UNSTAGED_REASON_NAME[record.type] === undefined) {
        addProblem(
          problems,
          'UNSTAGED_BAD_REASON',
          `kind=UNSTAGED needs type = a REG_STAGE_UNSTAGED_REASON code (1..${Object.keys(REG_STAGE_UNSTAGED_REASON).length}), got ${String(record.type)}`,
          index,
        )
      }
      if (record.status !== 0) {
        addProblem(problems, 'UNSTAGED_STATUS_NONZERO', `kind=UNSTAGED must keep status=0 (nothing was denied), got ${record.status}`, index)
      }
      if (record.nameChars !== 0 || record.dataBytes !== 0) {
        addProblem(problems, 'UNSTAGED_WITH_PAYLOAD', 'kind=UNSTAGED is an audit marker, not a replayable operation: it must not carry a value', index)
      }
    }
  }

  const summary = {
    records: decoded.records.length,
    byKind: decoded.records.reduce((acc, record) => {
      acc[record.kindName] = (acc[record.kindName] ?? 0) + 1
      return acc
    }, {}),
    paths: [...new Set(decoded.records.map((record) => record.path))],
    hardDenied: decoded.records.filter((record) => record.kind === REG_STAGE_KIND.HARD_DENY).length,
    unstaged: decoded.records.filter((record) => record.kind === REG_STAGE_KIND.UNSTAGED).length,
  }
  return { ok: problems.length === 0, problems, records: decoded.records, summary }
}

/**
 * 判定"读回自己的值"这条证据是否成立（纯函数）。
 *
 * 核心不变量（README 缺陷 11 的同一类）：**`queryRc == 0` 必须带回内容**。
 * `queryRc=0` 只说明状态码是成功；若既没有 `data` 也没有正的 `bytes`，
 * 这次"成功"就没有证明任何东西，必须判红（实测反例：`queryRc=0 / type=0xFFFFFFFF / data=undefined`）。
 */
export function validateReadbackEvidence(evidence = {}) {
  const problems = []
  const probe = evidence && typeof evidence === 'object' && evidence.probe && typeof evidence.probe === 'object' ? evidence.probe : evidence
  if (!probe || typeof probe !== 'object') {
    addProblem(problems, 'NO_PROBE', 'no probe object to judge')
    return { ok: false, problems }
  }
  const openRc = probe.openRc
  const queryRc = probe.queryRc
  if (typeof openRc !== 'number' || typeof queryRc !== 'number') {
    addProblem(problems, 'MISSING_RC', `openRc=${String(openRc)} queryRc=${String(queryRc)} are not both numbers`)
    return { ok: false, problems }
  }
  const expectedAll = openRc === 0 && queryRc === 0
  if (typeof probe.allCallsSucceeded === 'boolean' && probe.allCallsSucceeded !== expectedAll) {
    addProblem(
      problems,
      'ALL_CALLS_INCONSISTENT',
      `allCallsSucceeded=${probe.allCallsSucceeded} but (openRc===0 && queryRc===0) === ${expectedAll}`,
    )
  }
  if (queryRc !== 0) return { ok: problems.length === 0, problems }

  const typeValid = Number.isInteger(probe.type) && probe.type >= 0 && probe.type <= 11
  if (!typeValid) {
    addProblem(
      problems,
      'INVALID_TYPE',
      `queryRc=0 but type=${String(probe.type)} is not a valid winreg.h REG_* value (0..11)`,
    )
  }
  const hasData = typeof probe.data === 'string'
  const hasBytes = typeof probe.bytes === 'number' && probe.bytes > 0
  if (!hasData && !hasBytes) {
    addProblem(
      problems,
      'SUCCESS_WITHOUT_CONTENT',
      'queryRc=0 but neither `data` (string) nor a positive `bytes` was returned: a successful status with no ' +
        'content proves nothing and must not be reported as evidence',
    )
  }
  if (probe.queryOk === false) addProblem(problems, 'QUERY_OK_INCONSISTENT', 'queryRc=0 but queryOk=false')
  return { ok: problems.length === 0, problems }
}

/**
 * 判定闭环节证据是否**仍然描述当前产物**（纯函数）。
 * 报告比 DLL 旧 ⇒ 读过期的结论（实测反例：报告 13:05:38 vs DLL 13:06:19）。
 */
export function validateEvidenceFreshness({ reportMtimeMs, dllMtimeMs, toleranceMs = 0 } = {}) {
  const problems = []
  if (typeof reportMtimeMs !== 'number' || typeof dllMtimeMs !== 'number') {
    addProblem(problems, 'NO_TIMESTAMPS', 'both reportMtimeMs and dllMtimeMs are required to judge staleness')
    return { ok: false, problems }
  }
  const delta = dllMtimeMs - reportMtimeMs - toleranceMs
  if (delta > 0) {
    addProblem(
      problems,
      'STALE_EVIDENCE',
      `the closed-loop report is ${delta} ms OLDER than winstage-shim.dll: re-run node tools/run-shim-closedloop.mjs ` +
        'before trusting any of its checks',
    )
  }
  return { ok: problems.length === 0, problems }
}

// ──────────────────────── 测试出口 ────────────────────────

export const __internal = {
  API_BY_OP,
  KIND_BY_OP,
  OP_BY_KIND,
  KIND_NAME,
  fold,
  lastSegment,
  isDirectChildFold,
  ancestorFolds,
  stageError,
  HIVE_CANONICAL,
  /**
   * 枚举合并开关（**只供变异体自证**，生产路径恒为 true）。
   *
   * 设成 false 即恢复"覆盖层里有键目录就只列覆盖层"的旧行为 —— 也就是 2026-09-30
   * 实测到的阻塞级缺陷（`HKCU\Software` 下真实子键全部消失 ⇒ PowerShell 起不来）。
   * `tests/registry-stage.mjs` 用它证明"并集断言真的有判定力"（把并集退化 ⇒ 断言必须红）。
   * ⚠ 与 registry-guard 的 `decodeGuard` 同一条纪律：**读取时机在调用点**（不捕获快照），
   * 因此声明位置不影响语义，但任何"模块求值期间就调用 overlayView"的代码会撞 TDZ。
   */
  enumerationMerge: true,
}
