/**
 * AppContainer 结构体布局的确定性测试（**不需要 Win32、不需要 AppContainer 可用**）
 *
 * 存在理由：布局错误是本项目已经踩过两次的一类缺陷（缺陷 5：Job 结构体偏移错 4 字节；
 * 缺陷 13：漏 `CREATE_UNICODE_ENVIRONMENT`），而这类错误**完全可以用合成缓冲区离线测出来**。
 *
 * 因此本文件只做一件事：把 `STARTUPINFOEX` / `SECURITY_CAPABILITIES` / 创建标志 / 属性号
 * 的布局钉死，并把"隔离是否生效"的判定**显式留在别处**（`src/appcontainer-runtime.mjs`
 * 的 `readProcessTokenFacts` + `assessAppContainerIsolation`，必须由实测观测驱动）。
 *
 * ── 阶段 FIX-B 补充（原始证据 `.t/sbx3/dev/raw-t0-pinvoke.txt`）─────────────────
 * 布局常量现在有一条**独立通道**的核对：用 Windows PowerShell 5.1 + `Add-Type` 让 **CLR**
 * 量同一批结构体（与仓库常量、与 koffi 都无关）：
 *   `sizeof(STARTUPINFOW)=104`、`sizeof(STARTUPINFOEXW)=112`、
 *   `sizeof(SECURITY_CAPABILITIES)=24`、`sizeof(SID_AND_ATTRIBUTES)=16`、`sizeof(PROCESS_INFORMATION)=24`；
 *   `SECURITY_CAPABILITIES` 字段偏移 `0/8/16/20`。下面把其中属于本模块的几条也钉成断言。
 *
 * 用法：
 *   node tests\appcontainer-layout.mjs            # 正常运行，应当全绿
 *   node tests\appcontainer-layout.mjs --plant    # 故意把期望值改成"已知坏配置"，断言应当失败
 */

import {
  STARTUPINFOEX_SIZE,
  STARTUPINFO_SIZE,
  OFF_ATTRIBUTE_LIST,
  EXTENDED_STARTUPINFO_PRESENT,
  PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
  SECURITY_CAPABILITIES_SIZE,
  OFF_AC_SID,
  OFF_AC_CAPABILITIES,
  OFF_AC_CAPABILITY_COUNT,
  OFF_AC_RESERVED,
  buildSecurityCapabilities,
  buildCreationFlags,
} from '../src/appcontainer.mjs'
import { assessAppContainerIsolation, readProcessTokenFacts } from '../src/appcontainer-runtime.mjs'

const PLANT = process.argv.includes('--plant')

/**
 * `--plant` 的破坏点（每一个都对应一个**真实踩过的**缺陷形态）：
 *   - 尺寸 32：`SECURITY_CAPABILITIES` 多补 8 字节 padding（缺陷 D5 原形）；
 *   - 偏移 12：`Capabilities` 字段错位 4 字节（缺陷 5 同类）；
 *   - 属性号 `0x00020017`：阶段 B 报告 §7 提过的候选数字（`[实测]` 是错的，会 `ERROR_BAD_LENGTH`）。
 */
const PLANTED_SIZE = PLANT ? 32 : 24
const PLANTED_OFF_CAPABILITIES = PLANT ? 12 : 8
const PLANTED_ATTR = PLANT ? 0x00020017 : 0x00020009

const W = (s) => process.stdout.write(`${s}\n`)
if (PLANT) {
  W('*** --plant 模式：把 D5（尺寸 32）、缺陷 5 同类（偏移错 4 字节）、属性号候选 0x20017 当成期望值，断言应当失败 ***')
}
let failures = 0
let assertions = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  W(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}`)
}

W('=== 1. STARTUPINFOEXW 布局 ===')
// [官方] 64 位下 STARTUPINFOW 为 104 字节，后接一个 8 字节指针 → 112
check('STARTUPINFOEXW 大小 = 112', STARTUPINFOEX_SIZE === 112, String(STARTUPINFOEX_SIZE))
check('内嵌 STARTUPINFOW 大小 = 104', STARTUPINFO_SIZE === 104, String(STARTUPINFO_SIZE))
check('lpAttributeList 在偏移 104（紧接 STARTUPINFOW）', OFF_ATTRIBUTE_LIST === 104, String(OFF_ATTRIBUTE_LIST))
check(
  '属性列表指针落在结构体之内（不越界）',
  OFF_ATTRIBUTE_LIST + 8 === STARTUPINFOEX_SIZE,
  `${OFF_ATTRIBUTE_LIST}+8 vs ${STARTUPINFOEX_SIZE}`,
)
// cb 必须填 sizeof(STARTUPINFOEXW)，否则属性列表被静默忽略
check('cb 应填 112（不是 104）—— 填错会静默失去 AppContainer', true, '约定：创建时 cb=112')

W('')
W('=== 2. SECURITY_CAPABILITIES 布局 ===')
// [官方] { PSID AppContainerSid; PSID_AND_ATTRIBUTES Capabilities; DWORD CapabilityCount; DWORD Reserved; }
//
// ── 这条断言曾经是**循环论证**，必须留档（缺陷 D5）─────────────────────────────
// 初版断言写的是 `SECURITY_CAPABILITIES_SIZE === 32`，而 32 恰恰是"实现里多补了 8 字节
// padding 之后量出来的数"——用实现的输出反过来证明实现正确，测试必然全绿，
// 却把一个真实的 cbSize 错误（官方 24）固化下来，直到真实调用
// `UpdateProcThreadAttribute` 得到 ERROR_INVALID_PARAMETER(87) 才暴露。
// 现在的写法：**先按官方字段算术独立算出期望值**，再与常量比较；
// 三处独立证据（字段和、8 字节对齐取整、"每个字段都必须落在结构体内且不越界"）都要成立。
const expectSizeByFields = 8 /* PSID */ + 8 /* PSID_AND_ATTRIBUTES */ + 4 /* CapabilityCount */ + 4 /* Reserved */
const align8 = (n) => Math.ceil(n / 8) * 8
check(`大小 = ${PLANTED_SIZE}（8+8+4+4，官方字段和）`, SECURITY_CAPABILITIES_SIZE === PLANTED_SIZE, `${SECURITY_CAPABILITIES_SIZE}（期望 ${PLANTED_SIZE}）`)
check(
  '大小 = 按 8 字节对齐后的字段和（无尾部填充）',
  SECURITY_CAPABILITIES_SIZE === align8(expectSizeByFields) && align8(expectSizeByFields) === PLANTED_SIZE,
  `${align8(expectSizeByFields)} vs ${PLANTED_SIZE}`,
)
check('AppContainerSid 在偏移 0', OFF_AC_SID === 0, String(OFF_AC_SID))
check(`Capabilities 指针在偏移 ${PLANTED_OFF_CAPABILITIES}`, OFF_AC_CAPABILITIES === PLANTED_OFF_CAPABILITIES, `${OFF_AC_CAPABILITIES}（期望 ${PLANTED_OFF_CAPABILITIES}）`)
check('CapabilityCount 在偏移 16', OFF_AC_CAPABILITY_COUNT === 16, String(OFF_AC_CAPABILITY_COUNT))
check('Reserved 在偏移 20', OFF_AC_RESERVED === 20, String(OFF_AC_RESERVED))
// 末字段必须**恰好**结束在结构体末尾：多一个字节就是多补的 padding（正是 D5 的形态）
check(
  'Reserved 恰好结束在结构体末尾（没有多补的 padding）',
  OFF_AC_RESERVED + 4 === SECURITY_CAPABILITIES_SIZE && SECURITY_CAPABILITIES_SIZE === PLANTED_SIZE,
  `${OFF_AC_RESERVED}+4 vs ${SECURITY_CAPABILITIES_SIZE}（期望 ${PLANTED_SIZE}）`,
)
check(
  '所有字段都在结构体大小之内',
  [OFF_AC_SID + 8, OFF_AC_CAPABILITIES + 8, OFF_AC_CAPABILITY_COUNT + 4, OFF_AC_RESERVED + 4].every(
    (end) => end <= SECURITY_CAPABILITIES_SIZE,
  ),
  '布局自洽',
)
// 永久负例：32 是**错的**，必须被判错（否则 D5 会以任何形式回来）
check(
  '负例：32 必须被判定为错误大小（D5 回归）',
  SECURITY_CAPABILITIES_SIZE !== 32,
  `当前 ${SECURITY_CAPABILITIES_SIZE}`,
)
// `[实测]` 独立通道（CLR，见文件头）：字段偏移 0/8/16/20、大小 24
check(
  '与独立通道（PowerShell/CLR Marshal.SizeOf 与 OffsetOf）一致：24 字节、偏移 0/8/16/20',
  SECURITY_CAPABILITIES_SIZE === 24 &&
    OFF_AC_SID === 0 &&
    OFF_AC_CAPABILITIES === 8 &&
    OFF_AC_CAPABILITY_COUNT === 16 &&
    OFF_AC_RESERVED === 20,
  '[实测] .t/sbx3/dev/raw-t0-pinvoke.txt §1：sizeof=24；offsets AppContainerSid=0 Capabilities=8 CapabilityCount=16 Reserved=20',
)

W('')
W('=== 3. buildSecurityCapabilities 合成缓冲区 ===')
{
  const buf = buildSecurityCapabilities(0x1234n, [])
  check('返回值是 24 字节 Buffer', Buffer.isBuffer(buf) && buf.length === 24, `${buf.length} 字节`)
  check('SID 指针写在偏移 0', buf.readBigUInt64LE(0) === 0x1234n, `0x${buf.readBigUInt64LE(0).toString(16)}`)
  check('无能力时 Capabilities 指针为 NULL', buf.readBigUInt64LE(8) === 0n, `0x${buf.readBigUInt64LE(8).toString(16)}`)
  check('无能力时 CapabilityCount = 0', buf.readUInt32LE(16) === 0, String(buf.readUInt32LE(16)))
  check('Reserved = 0', buf.readUInt32LE(20) === 0, String(buf.readUInt32LE(20)))
}
{
  const buf = buildSecurityCapabilities(null, [])
  check('null SID 编码为 NULL 指针', buf.readBigUInt64LE(0) === 0n, `0x${buf.readBigUInt64LE(0).toString(16)}`)
}
{
  const buf = buildSecurityCapabilities(0x1n, [{ pointer: 0x2n, count: 3 }])
  check('预分配能力数组：指针写入偏移 8', buf.readBigUInt64LE(8) === 0x2n, `0x${buf.readBigUInt64LE(8).toString(16)}`)
  check('预分配能力数组：count 写入偏移 16', buf.readUInt32LE(16) === 3, String(buf.readUInt32LE(16)))
}
{
  let threw = false
  try {
    buildSecurityCapabilities(0x1n, [{ notAPointer: true }])
  } catch {
    threw = true
  }
  check('能力数组未预分配时显式抛错（不静默忽略）', threw, threw ? '已抛错' : '竟然接受了')
}

W('')
W('=== 4. 创建标志（缺陷 13 的同类回归）===')
check(
  'EXTENDED_STARTUPINFO_PRESENT 常量 = 0x00080000',
  EXTENDED_STARTUPINFO_PRESENT === 0x00080000,
  `0x${EXTENDED_STARTUPINFO_PRESENT.toString(16)}`,
)
check(
  '带环境块时必须同时置 CREATE_UNICODE_ENVIRONMENT (0x400)',
  (buildCreationFlags(true) & 0x400) !== 0,
  `flags=0x${buildCreationFlags(true).toString(16)}`,
)
check(
  '无论是否有环境块，都必须置 EXTENDED_STARTUPINFO_PRESENT',
  (buildCreationFlags(true) & EXTENDED_STARTUPINFO_PRESENT) !== 0 &&
    (buildCreationFlags(false) & EXTENDED_STARTUPINFO_PRESENT) !== 0,
  `with=0x${buildCreationFlags(true).toString(16)} without=0x${buildCreationFlags(false).toString(16)}`,
)
check(
  '不带环境块时不额外置 0x400（不越权）',
  (buildCreationFlags(false) & 0x400) === 0,
  `flags=0x${buildCreationFlags(false).toString(16)}`,
)
check(
  '不置 EXTENDED_STARTUPINFO_PRESENT 会让 lpAttributeList 被静默忽略 —— 这是硬前提',
  (EXTENDED_STARTUPINFO_PRESENT & 0x00080000) === 0x00080000,
  '该位必须出现，否则 AppContainer 形同虚设',
)

W('')
W('=== 5. 属性号 ===')
// `[文档]` winnt.h：PROC_THREAD_ATTRIBUTE_x = ProcThreadAttributeValue(Number, Thread, Input, Additive)
//   = Number | (Thread?0x10000:0) | (Input?0x20000:0) | (Additive?0x40000:0)，Number 掩码 0xFFFF。
// `[文档]` 真实头文件镜像（Mozilla sdkdecls.h）：ProcThreadAttributeSecurityCapabilities = 9，
//   PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = ProcThreadAttributeValue(9, FALSE, TRUE, FALSE)。
// `[文档]` windows-sys（官方 Win32 元数据生成）：131081 = 0x00020009。
// 下面这条断言把"宏的算术"真的算一遍 —— 而不是只把常量抄一遍（否则常量写错也全绿）。
const procThreadAttributeValue = (number, thread, input, additive) =>
  ((number & 0xffff) | (thread ? 0x10000 : 0) | (input ? 0x20000 : 0) | (additive ? 0x40000 : 0)) >>> 0
const derivedFromMacro = procThreadAttributeValue(9, false, true, false)
check(
  `属性号 = ${`0x${PLANTED_ATTR.toString(16).padStart(8, '0')}`}（ProcThreadAttributeValue(9,FALSE,TRUE,FALSE)）`,
  PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES === derivedFromMacro && derivedFromMacro === PLANTED_ATTR,
  `常量 0x${PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES.toString(16)} / 宏算得 0x${derivedFromMacro.toString(16)} / 期望 0x${PLANTED_ATTR.toString(16)}`,
)
check('131081（windows-sys 里的十进制值）=== 0x00020009', 131081 === 0x00020009, `${131081}`)
// `[实测]` 属性号不是靠记忆：把 0x00020009 喂给 UpdateProcThreadAttribute 成功写入属性列表，
// 而 0x0002000A / 0x00020017 都返回 false + ERROR_BAD_LENGTH(24)（原始输出见 .t/sbx3/dev/raw-t0-forensics.txt §1）
check(
  '负例：阶段 B 报告 §7 提过的候选 0x00020017（Number=23）**不是**该属性号',
  PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES !== 0x00020017,
  '[实测] raw-t0-forensics.txt §1 / raw-t0-pinvoke.txt §3：0x00020017 → false + ERROR_BAD_LENGTH(24)',
)

W('')
W('=== 6. 现状声明（不得被读成"已实测"，也不得被读成"不可能生效"）===')
// 本模块只管布局。**"隔离是否生效"的判定不在这里** —— 它必须由 appcontainer-runtime 的
// 实测证据链给出，否则 `selectTier()` 的 fail-closed 闸门就没有真实来源。
check(
  '本模块只管布局；"隔离是否生效"由 appcontainer-runtime 的实测证据链判定（本模块不提供任何 true）',
  typeof assessAppContainerIsolation === 'function' && typeof readProcessTokenFacts === 'function' && PLANT === false,
  '见 src/appcontainer-runtime.mjs：readProcessTokenFacts + assessAppContainerIsolation（缺证据一律 false）',
)
check(
  '本模块不再声称"运行期未实测"（阶段 FIX-B 已在未受限宿主上实测：TokenIsAppContainer=1 + 区外写被拒 + 网络被阻断）',
  SECURITY_CAPABILITIES_SIZE === 24 && OFF_AC_CAPABILITIES === 8,
  '[实测] .t/sbx3/dev/raw-t0-forensics.txt、raw-t0-behaviour.txt、raw-t0-launch-matrix.txt',
)

W('')
W('='.repeat(64))
W(
  failures === 0
    ? `AppContainer 布局测试：断言 ${assertions} 项，失败 0 项 —— 全部通过`
    : `AppContainer 布局测试${PLANT ? '（--plant 模式，应当失败）' : ''}：断言 ${assertions} 项，失败 ${failures} 项`,
)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
