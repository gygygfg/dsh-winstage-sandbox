/**
 * mitigations.mjs 的离线确定性测试（**不需要 Win32、不需要管理员、不创建任何进程**）
 *
 * 存在理由：`src/mitigations.mjs` 是"seccomp denylist 的 Windows 等价物"，它的危险形态
 * 与 `SECURITY_CAPABILITIES.cbSize` 那类缺陷**完全同族**（见 `src/appcontainer.mjs` 的
 * 缺陷 D5 留档）：属性号写错、位号写错、失败被当成功 —— 三者都会得到
 * "看起来加固了、实际裸奔"的子进程。这类错误**全部可以用合成缓冲区离线测出来**。
 *
 * 本文件只做三件事：
 *   1. 把属性号、每个标志的位号、8 字节小端编码**钉死**（期望值由独立算术重算，
 *      不是把源码常量抄一遍 —— 抄常量的话常量写错也全绿）；
 *   2. 用**记录型假 binding** 断言 `applyMitigationPolicy` 的**逐参数**调用契约与
 *      fail-closed 行为（返回 false / 抛异常 / GetLastError 抛异常都不得静默）；
 *   3. 覆盖档位集合运算、include/exclude、未知名报错、buffer 往返。
 *
 * ⚠ 诚实声明：本文件跑的是**离线替身**，不是真实 `UpdateProcThreadAttribute`。
 * 因此本文件**不产生**任何 `[实测]` 级别的 Windows 行为结论；`src/mitigations.mjs`
 * 里的运行期陈述一律是 `[官方]`/`[推断]`/`[未实测]`。
 *
 * 用法：
 *   node tests\mitigations.mjs            # 正常运行，应当全绿（exit 0）
 *   node tests\mitigations.mjs --plant    # 破坏一个标志位 + 属性号期望值，若干条断言应当变红（exit 1）
 */

import {
  MITIGATION_POLICY_ATTRIBUTE,
  MITIGATION_POLICY_VALUE_SIZE,
  MITIGATION_ATTRIBUTE_LIST_COUNT,
  MITIGATION_FLAGS,
  MITIGATION_MASKS,
  MITIGATION_MAP,
  MITIGATION_PROFILES,
  MITIGATION_PROFILE_NAMES,
  DEFAULT_MITIGATION_PROFILE,
  BLOCK_NON_MICROSOFT_BINARIES_ALLOW_STORE,
  PROHIBIT_DYNAMIC_CODE_ALLOW_OPT_OUT,
  buildMitigationPolicy,
  describeMitigationPolicy,
  validateMitigationFlags,
  isNoop,
  applyMitigationPolicy,
  probeMitigationSupport,
  summariseMitigations,
} from '../src/mitigations.mjs'

const PLANT = process.argv.includes('--plant')

/**
 * `--plant` 的破坏点（每个都对应一种**真实可能发生**的缺陷形态）：
 *   - 属性号 `0x00020000`（漏掉 `Input` 位 0x20000 的直方图写法）：
 *     这正是"宏推导写错"最容易得到的结果 —— 少了 Input 位就变成"属性号 0"，
 *     而 `UpdateProcThreadAttribute` 收到未定义属性号时的行为不可依赖；
 *   - `WIN32K_SYSTEM_CALL_DISABLE` 位号从 28 挪到 27：位号写错一位，
 *     语句上完全合法、编译通过、测试若不按位号复核就发现不了；
 *   - `BOTTOM_UP_ASLR` 位号从 16 挪到 15：同上（栈/MAP 随机化是常见"顺手写错"处）。
 *
 * 三点都是"期望值 vs 实现值"的对照：`--plant` 把**期望值**换成坏值，
 * 于是断言变红 —— 这证明这些断言真的在约束实现，而不是恒真。
 */
const PLANTED_ATTRIBUTE = PLANT ? 0x00020000 : 0x00020010
const PLANTED_WIN32K_SHIFT = PLANT ? 27n : 28n
const PLANTED_BOTTOM_UP_SHIFT = PLANT ? 15n : 16n

const W = (s) => process.stdout.write(`${s}\n`)
if (PLANT) {
  W('*** --plant 模式：把属性号 0x20000、WIN32K 位号 27、BOTTOM_UP_ASLR 位号 15 当成期望值，')
  W('*** 因此属性号推导、位号复核相关的断言应当变红（它们确实在约束实现） ***')
}

let failures = 0
let assertions = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  W(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}`)
}

const hex64 = (v) => `0x${v.toString(16).padStart(16, '0')}`

// ─────────────────────────── 假 binding（记录型）───────────────────────────

/**
 * 记录型假 binding。
 * `updateProcThreadAttribute` 的返回形态可注入：`true`/`false`/`0`/`1`/`null`/抛异常
 * （`[实测]` 依据见 `src/appcontainer-runtime.mjs:181-201`：真实 koffi 返回 JS boolean，
 * 离线替身返回数字 —— 两种形态都必须被正确处理）。
 */
function makeApi({ returns = true, throws = null, getLastErrorValue = 0, getLastErrorThrows = false, withGetLastError = true } = {}) {
  const calls = []
  const api = {
    calls,
    updateProcThreadAttribute(...args) {
      calls.push({ fn: 'updateProcThreadAttribute', args })
      if (throws) throw throws
      return returns
    },
  }
  if (withGetLastError) {
    api.getLastError = () => {
      calls.push({ fn: 'getLastError', args: [] })
      if (getLastErrorThrows) throw new Error('getLastError blew up')
      return getLastErrorValue
    }
  }
  return api
}

/** 把记录的参数渲染成可比对的一行（BigInt 明确标注，避免 `1n` 与 `1` 混淆） */
const renderCall = (call) =>
  `${call.fn}(${call.args
    .map((a) => {
      if (typeof a === 'bigint') return `${a}n`
      if (a === null) return 'null'
      if (Buffer.isBuffer(a)) return `Buffer[${a.length}]`
      return String(a)
    })
    .join(', ')})`
const ATTR_LIST = Buffer.from('attr-list-marker')

W('')
W('=== 1. 属性号与宏推导（ProcThreadAttributeValue(16, FALSE, TRUE, FALSE)）===')
// `[官方]` winnt.h：PROC_THREAD_ATTRIBUTE_x = ProcThreadAttributeValue(Number, Thread, Input, Additive)
//   = Number | (Thread?0x10000:0) | (Input?0x20000:0) | (Additive?0x40000:0)，Number 掩码 0xFFFF。
// 下面**自己算一遍宏**，不抄常量。
const procThreadAttributeValue = (number, thread, input, additive) =>
  ((number & 0xffff) | (thread ? 0x10000 : 0) | (input ? 0x20000 : 0) | (additive ? 0x40000 : 0)) >>> 0
const derivedMitigation = procThreadAttributeValue(16, false, true, false)
check(
  `MITIGATION_POLICY_ATTRIBUTE === ${hex64(BigInt(PLANTED_ATTRIBUTE))}`,
  MITIGATION_POLICY_ATTRIBUTE === PLANTED_ATTRIBUTE,
  `常量 0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}（期望 0x${PLANTED_ATTRIBUTE.toString(16)}）`,
)
check(
  '属性号 === 宏算术算出的值（不是抄来的常量）',
  MITIGATION_POLICY_ATTRIBUTE === derivedMitigation,
  `宏算得 0x${derivedMitigation.toString(16)}，常量 0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}`,
)
check('宏算术的输入是 属性编号 16 / Thread=FALSE / Input=TRUE / Additive=FALSE', derivedMitigation === 16 | 0x20000, `16 | 0x20000 = 0x${(16 | 0x20000).toString(16)}`)
// 与已实测的属性号互证：同一条宏规则、同一个 Input 分支、同一段编号空间
const derivedSecurityCapabilities = procThreadAttributeValue(9, false, true, false)
check(
  '互证：同一宏规则对属性 9 得到已实测的 0x00020009（SECURITY_CAPABILITIES）',
  derivedSecurityCapabilities === 0x00020009,
  `宏算得 0x${derivedSecurityCapabilities.toString(16)}；[实测] 依据 src/appcontainer.mjs:94 与 .t/sbx3/dev/raw-t0-forensics.txt §1`,
)
check(
  '缓解策略属性号 ≠ AppContainer 属性号（两个属性必须能同时写进同一个列表）',
  MITIGATION_POLICY_ATTRIBUTE !== 0x00020009,
  `0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)} vs 0x00020009`,
)
check('属性号的 Input 位（0x00020000）确实被置上', (MITIGATION_POLICY_ATTRIBUTE & 0x00020000) === 0x00020000, `0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}`)
check('属性号的 Thread 位（0x00010000）未被置上', (MITIGATION_POLICY_ATTRIBUTE & 0x00010000) === 0, `0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}`)
check('属性号的 Additive 位（0x00040000）未被置上', (MITIGATION_POLICY_ATTRIBUTE & 0x00040000) === 0, `0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}`)
check('属性号落在 32 位内且高 16 位恰为 0x0002', MITIGATION_POLICY_ATTRIBUTE >>> 16 === 0x0002, `高 16 位 = 0x${(MITIGATION_POLICY_ATTRIBUTE >>> 16).toString(16)}`)
check('MITIGATION_POLICY_VALUE_SIZE === 8（DWORD64）', MITIGATION_POLICY_VALUE_SIZE === 8, String(MITIGATION_POLICY_VALUE_SIZE))
check(
  'MITIGATION_ATTRIBUTE_LIST_COUNT === 1（集成方须把这条算进 InitializeProcThreadAttributeList 容量，否则 122）',
  MITIGATION_ATTRIBUTE_LIST_COUNT === 1,
  `${MITIGATION_ATTRIBUTE_LIST_COUNT}（AppContainer 已有 1 条 ⇒ 合计 2）`,
)

W('')
W('=== 2. 每个标志的位号复核（独立算术，不抄常量）===')
/**
 * 位号表：这是**独立**的期望来源（官方文档的 `0x1 << n` 写法直读，见 src/mitigations.mjs
 * 文件头与 MITIGATION_MAP 的 source）。实现改了位号、这里就会红。
 */
const EXPECTED_FLAG_SHIFTS = {
  DEP_ENABLE: 0n,
  DEP_ATL_THUNK_ENABLE: 1n,
  SEHOP_ENABLE: 2n,
  FORCE_RELOCATE_IMAGES: 8n,
  HEAP_TERMINATE: 12n,
  BOTTOM_UP_ASLR: PLANTED_BOTTOM_UP_SHIFT,
  HIGH_ENTROPY_ASLR: 20n,
  STRICT_HANDLE_CHECKS: 24n,
  WIN32K_SYSTEM_CALL_DISABLE: PLANTED_WIN32K_SHIFT,
  EXTENSION_POINT_DISABLE: 32n,
  PROHIBIT_DYNAMIC_CODE: 36n,
  CONTROL_FLOW_GUARD: 40n,
  BLOCK_NON_MICROSOFT_BINARIES: 44n,
  FONT_DISABLE: 48n,
  IMAGE_LOAD_NO_REMOTE: 52n,
  IMAGE_LOAD_NO_LOW_LABEL: 56n,
  IMAGE_LOAD_PREFER_SYSTEM32: 60n,
}
for (const [name, shift] of Object.entries(EXPECTED_FLAG_SHIFTS)) {
  const expected = 0x1n << shift
  const actual = MITIGATION_FLAGS[name]
  check(
    `${name} === 0x1 << ${shift} = ${hex64(expected)}`,
    actual === expected,
    `实现 ${hex64(actual ?? -1n)}（期望 ${hex64(expected)}）`,
  )
}
check(
  '标志表覆盖了任务要求的全部 17 个名字',
  Object.keys(EXPECTED_FLAG_SHIFTS).every((n) => Object.prototype.hasOwnProperty.call(MITIGATION_FLAGS, n)),
  `实现有 ${Object.keys(MITIGATION_FLAGS).length} 个：${Object.keys(MITIGATION_FLAGS).join(', ')}`,
)
check(
  '每个标志都是单一位（2 的幂）',
  Object.values(MITIGATION_FLAGS).every((v) => v > 0n && (v & (v - 1n)) === 0n),
  Object.entries(MITIGATION_FLAGS).filter(([, v]) => (v & (v - 1n)) !== 0n).map(([k]) => k).join(',') || '全部单位',
)
check('标志值互不重复', new Set(Object.values(MITIGATION_FLAGS).map(String)).size === Object.keys(MITIGATION_FLAGS).length, `${new Set(Object.values(MITIGATION_FLAGS).map(String)).size} 个不同值`)
check('全部标志都在 64 位内', Object.values(MITIGATION_FLAGS).every((v) => v <= 0xffffffffffffffffn), 'DWORD64')
check('MAX 标志 = IMAGE_LOAD_PREFER_SYSTEM32 = bit 60（最高的 ALWAYS_ON 位）', MITIGATION_FLAGS.IMAGE_LOAD_PREFER_SYSTEM32 === 0x1n << 60n, hex64(MITIGATION_FLAGS.IMAGE_LOAD_PREFER_SYSTEM32))
check('DEP_ATL_THUNK_ENABLE 与 DEP_ENABLE 是相邻位（官方要求同开）', MITIGATION_FLAGS.DEP_ATL_THUNK_ENABLE === MITIGATION_FLAGS.DEP_ENABLE << 1n, 'bit0/bit1')
check('标志表与掩码表同名族一致（MASK = 0x3 << 同一位号）', Object.keys(MITIGATION_MASKS).every((n) => MITIGATION_MASKS[n] === 0x3n << EXPECTED_FLAG_SHIFTS[n]), Object.entries(MITIGATION_MASKS).map(([k, v]) => `${k}=${hex64(v)}`).join(' '))
check(
  '负例：0x2 不是"开启"值（同一 MASK 的 ALWAYS_OFF 位）—— 单一位判定必须能区分',
  (MITIGATION_FLAGS.WIN32K_SYSTEM_CALL_DISABLE & (0x2n << 28n)) === 0n,
  `WIN32K = ${hex64(MITIGATION_FLAGS.WIN32K_SYSTEM_CALL_DISABLE)}`,
)
check('BLOCK_NON_MICROSOFT_BINARIES_ALLOW_STORE = 0x3 << 44（官方例外，单独导出）', BLOCK_NON_MICROSOFT_BINARIES_ALLOW_STORE === 0x3n << 44n, hex64(BLOCK_NON_MICROSOFT_BINARIES_ALLOW_STORE))
check('PROHIBIT_DYNAMIC_CODE_ALLOW_OPT_OUT = 0x3 << 36（官方例外，单独导出）', PROHIBIT_DYNAMIC_CODE_ALLOW_OPT_OUT === 0x3n << 36n, hex64(PROHIBIT_DYNAMIC_CODE_ALLOW_OPT_OUT))

W('')
W('=== 3. 8 字节小端编码 ===')
{
  const p = buildMitigationPolicy({ include: ['DEP_ENABLE', 'SEHOP_ENABLE'] })
  check('flags === 0x5n（DEP bit0 | SEHOP bit2）', p.flags === 0x5n, hex64(p.flags))
  check('buffer 是 Buffer 且长度恰为 8', Buffer.isBuffer(p.buffer) && p.buffer.length === 8, `${p.buffer?.length} 字节`)
  check('字节 0 = 0x05（小端最低字节）', p.buffer[0] === 0x05, `0x${p.buffer[0].toString(16)}`)
  check('字节 1..7 全为 0（不写脏字节）', p.buffer.subarray(1).every((b) => b === 0), [...p.buffer].join(' '))
  check('readBigUInt64LE(0) 回读等于 flags', p.buffer.readBigUInt64LE(0) === p.flags, hex64(p.buffer.readBigUInt64LE(0)))
}
{
  const p = buildMitigationPolicy({ flags: 0xffffffffffffffffn })
  check('flags=全 1 时 8 字节全为 0xff（高半部分真的写得进去）', [...p.buffer].every((b) => b === 0xff), [...p.buffer].join(' '))
  check('全 1 回读仍是 0xffffffffffffffffn', p.buffer.readBigUInt64LE(0) === 0xffffffffffffffffn, hex64(p.buffer.readBigUInt64LE(0)))
}
{
  const p = buildMitigationPolicy('none')
  check('none 档 buffer 全 0（未注入任何策略）', [...p.buffer].every((b) => b === 0), [...p.buffer].join(' '))
}
{
  const p = buildMitigationPolicy({ include: ['IMAGE_LOAD_PREFER_SYSTEM32'] })
  check('bit 60 单独置位时字节 7 的高半字节为 0x1（不落进低 32 位）', p.buffer[7] === 0x10 && p.buffer.readUInt32LE(0) === 0, [...p.buffer].join(' '))
}
{
  const p = buildMitigationPolicy({ flags: '0x100000000000' })
  check('flags 接受十六进制字符串（审计/配置面便利），且值正确', p.flags === 0x100000000000n, hex64(p.flags))
}
{
  const p = buildMitigationPolicy({ flags: 0x5 })
  check('flags 接受安全整数', p.flags === 5n, hex64(p.flags))
  check('flags 非 0 时 isNoop 为 false（no-op 判定不能恒真）', isNoop(p) === false, `flags=${hex64(p.flags)}`)
  check('flags === 0 时 isNoop 为 true（调用方可跳过 Update）', isNoop(buildMitigationPolicy({ flags: 0 })) === true, 'no-op 语义')
}

W('')
W('=== 4. 档位（预设）与集合关系 ===')
check('MITIGATION_PROFILES / MITIGATION_FLAG 表都是冻结的', Object.isFrozen(MITIGATION_PROFILES) && Object.isFrozen(MITIGATION_FLAGS), 'frozen')
check('MITIGATION_MAP 是冻结的对照表', Object.isFrozen(MITIGATION_MAP), 'frozen')
check(
  '对照表覆盖每一个标志（评审读的表不能有洞）',
  Object.keys(MITIGATION_FLAGS).every((n) => MITIGATION_MAP[n] && MITIGATION_MAP[n].linuxControl && MITIGATION_MAP[n].substitutes),
  Object.keys(MITIGATION_FLAGS).filter((n) => !MITIGATION_MAP[n]).join(',') || '无缺项',
)
check(
  '对照表把 W^X/ACG/CIG/win32k 四条语义写清（这是本模块对 seccomp 的核心替代声明）',
  /W\^X|mprotect/.test(MITIGATION_MAP.PROHIBIT_DYNAMIC_CODE.linuxControl) &&
    /签名/.test(MITIGATION_MAP.BLOCK_NON_MICROSOFT_BINARIES.linuxControl) &&
    /seccomp/.test(MITIGATION_MAP.WIN32K_SYSTEM_CALL_DISABLE.equivalentTo) &&
    /CET|CFI/.test(MITIGATION_MAP.CONTROL_FLOW_GUARD.equivalentTo),
  'PROHIBIT_DYNAMIC_CODE↔mprotect(PROT_EXEC)/W^X；BLOCK_NON_MICROSOFT_BINARIES↔未签名二进制',
)
check('none 档 = 0 个名字且 flags = 0n', MITIGATION_PROFILES.none.length === 0 && buildMitigationPolicy('none').flags === 0n, hex64(buildMitigationPolicy('none').flags))
check('none 档 isNoop === true（调用方可整条跳过）', isNoop(buildMitigationPolicy('none')) === true, 'isNoop')
check('默认档是 baseline 而不是 none（fail-closed：不点名也要有基线加固）', DEFAULT_MITIGATION_PROFILE === 'baseline', DEFAULT_MITIGATION_PROFILE)
check('默认参数与显式 baseline 等价', buildMitigationPolicy(undefined).flags === buildMitigationPolicy('baseline').flags, hex64(buildMitigationPolicy().flags))
{
  const base = buildMitigationPolicy('baseline')
  const hard = buildMitigationPolicy('hardened')
  const untrusted = buildMitigationPolicy('untrusted')
  check(
    'baseline 含 DEP/SEHOP/堆终止/ASLR/严格句柄/CFG（任务要求的那组）',
    ['DEP_ENABLE', 'DEP_ATL_THUNK_ENABLE', 'SEHOP_ENABLE', 'HEAP_TERMINATE', 'BOTTOM_UP_ASLR', 'HIGH_ENTROPY_ASLR', 'STRICT_HANDLE_CHECKS', 'CONTROL_FLOW_GUARD'].every((n) => base.names.includes(n)),
    base.names.join(', '),
  )
  check('baseline 不含 WIN32K_SYSTEM_CALL_DISABLE 与 EXTENSION_POINT_DISABLE', !base.names.includes('WIN32K_SYSTEM_CALL_DISABLE') && !base.names.includes('EXTENSION_POINT_DISABLE'), base.names.join(', '))
  check('hardened 严格包含 baseline（真超集，不是相等）', (hard.flags & base.flags) === base.flags && hard.flags !== base.flags, `${hex64(base.flags)} ⊂ ${hex64(hard.flags)}`)
  check('hardened = baseline + WIN32K_SYSTEM_CALL_DISABLE + EXTENSION_POINT_DISABLE', hard.flags === (base.flags | MITIGATION_FLAGS.WIN32K_SYSTEM_CALL_DISABLE | MITIGATION_FLAGS.EXTENSION_POINT_DISABLE), hex64(hard.flags))
  check('untrusted 严格包含 hardened', (untrusted.flags & hard.flags) === hard.flags && untrusted.flags !== hard.flags, `${hex64(hard.flags)} ⊂ ${hex64(untrusted.flags)}`)
  check(
    'untrusted = hardened + PROHIBIT_DYNAMIC_CODE + BLOCK_NON_MICROSOFT_BINARIES + FONT_DISABLE + IMAGE_LOAD_NO_REMOTE（任务要求的四项 opt-in）',
    untrusted.flags ===
      (hard.flags |
        MITIGATION_FLAGS.PROHIBIT_DYNAMIC_CODE |
        MITIGATION_FLAGS.BLOCK_NON_MICROSOFT_BINARIES |
        MITIGATION_FLAGS.FONT_DISABLE |
        MITIGATION_FLAGS.IMAGE_LOAD_NO_REMOTE),
    hex64(untrusted.flags),
  )
  check(
    '破坏普通工具链的四个"禁止型"标志只在 untrusted 出现（不泄漏进 baseline/hardened）',
    ['PROHIBIT_DYNAMIC_CODE', 'BLOCK_NON_MICROSOFT_BINARIES', 'FONT_DISABLE', 'IMAGE_LOAD_NO_REMOTE'].every(
      (n) => !base.names.includes(n) && !hard.names.includes(n) && untrusted.names.includes(n),
    ),
    'untrusted 是 opt-in：ACG 会让 JIT（Node/V8）无法启动，CIG 会拒绝未签名二进制',
  )
  check('档位名字清单与预设表一致', MITIGATION_PROFILE_NAMES.join(',') === Object.keys(MITIGATION_PROFILES).join(','), MITIGATION_PROFILE_NAMES.join(', '))
  check('预设里的每个名字都存在于标志表（没有拼写漂移）', MITIGATION_PROFILE_NAMES.every((p) => MITIGATION_PROFILES[p].every((n) => Object.prototype.hasOwnProperty.call(MITIGATION_FLAGS, n))), '全部命中')
}

W('')
W('=== 5. include / exclude / flags 形态与未知名 fail-closed ===')
{
  const p = buildMitigationPolicy({ profile: 'baseline', include: ['WIN32K_SYSTEM_CALL_DISABLE'], exclude: ['HEAP_TERMINATE'] })
  check('include 生效：WIN32K_SYSTEM_CALL_DISABLE 已置位', (p.flags & MITIGATION_FLAGS.WIN32K_SYSTEM_CALL_DISABLE) !== 0n, hex64(p.flags))
  check('exclude 生效：HEAP_TERMINATE 已清除', (p.flags & MITIGATION_FLAGS.HEAP_TERMINATE) === 0n, hex64(p.flags))
  check('其余 baseline 位保持不变（只动点名的两位）', p.flags === ((buildMitigationPolicy('baseline').flags | MITIGATION_FLAGS.WIN32K_SYSTEM_CALL_DISABLE) & ~MITIGATION_FLAGS.HEAP_TERMINATE), hex64(p.flags))
  check('names 与 flags 自洽（describe(flags) === names）', describeMitigationPolicy(p.flags).join(',') === p.names.join(','), p.names.join(', '))
}
{
  const p = buildMitigationPolicy({ include: ['SEHOP_ENABLE'] })
  check('只给 include（缺 profile）时以 none 为底：结果**恰好**是那一条（不静默带上 baseline 的 9 条）', p.flags === MITIGATION_FLAGS.SEHOP_ENABLE, `${hex64(p.flags)} / names=${p.names.join(',')}`)
  check('该形态不冒充某个档位名（profile = custom-ish 的 none，报告里读得出来）', p.profile === 'none', p.profile)
}
{
  const p = buildMitigationPolicy({ profile: 'baseline', include: ['SEHOP_ENABLE'] })
  check('显式给 profile 时它才是底面（{profile:baseline, include:[SEHOP]} = baseline 的 9 条）', p.flags === buildMitigationPolicy('baseline').flags, hex64(p.flags))
}
{
  let error = null
  try {
    buildMitigationPolicy('hardenedd')
  } catch (e) {
    error = e
  }
  check('未知档位名抛 MITIGATION_PROFILE_UNKNOWN（不静默降级为默认档）', error?.code === 'MITIGATION_PROFILE_UNKNOWN', error ? `${error.code}: ${error.message.slice(0, 90)}` : '竟然没抛')
}
{
  let error = null
  try {
    buildMitigationPolicy({ include: ['DEP_ENABLE', 'NO_SUCH_FLAG'] })
  } catch (e) {
    error = e
  }
  check('未知标志名抛 MITIGATION_FLAG_UNKNOWN（绝不静默丢弃）', error?.code === 'MITIGATION_FLAG_UNKNOWN', error ? `${error.code}: ${error.message.slice(0, 90)}` : '竟然没抛')
  check('报错里带出那个未知名字（可定位）', error?.unknown === 'NO_SUCH_FLAG', String(error?.unknown))
}
{
  let error = null
  try {
    buildMitigationPolicy({ exclude: ['NOT_A_FLAG'] })
  } catch (e) {
    error = e
  }
  check('exclude 里的未知名同样抛错（不是"排除不存在的项就忽略"）', error?.code === 'MITIGATION_FLAG_UNKNOWN', error?.code ?? '未抛')
}
{
  let error = null
  try {
    buildMitigationPolicy({ profile: 'baseline', include: ['SEHOP_ENABLE'], exclude: ['SEHOP_ENABLE'] })
  } catch (e) {
    error = e
  }
  check('同名同时出现在 include 与 exclude 抛 MITIGATION_SPEC_CONFLICT（不猜哪边赢）', error?.code === 'MITIGATION_SPEC_CONFLICT', error?.code ?? '未抛')
}
{
  let error = null
  try {
    buildMitigationPolicy({ flags: 0x5n, profile: 'baseline' })
  } catch (e) {
    error = e
  }
  check('flags 与 profile 混用抛 MITIGATION_SPEC_INVALID（表达式唯一）', error?.code === 'MITIGATION_SPEC_INVALID', error?.code ?? '未抛')
}
{
  let error = null
  try {
    buildMitigationPolicy({ flags: 1.5 })
  } catch (e) {
    error = e
  }
  check('flags 传非安全整数抛错（不静默取整）', error?.code === 'MITIGATION_FLAGS_INVALID', error?.code ?? '未抛')
}
{
  let error = null
  try {
    buildMitigationPolicy({ flags: 'nonsense' })
  } catch (e) {
    error = e
  }
  check('flags 传非十六进制字符串抛错', error?.code === 'MITIGATION_FLAGS_INVALID', error?.code ?? '未抛')
}
{
  let error = null
  try {
    buildMitigationPolicy({ flags: 1n << 70n })
  } catch (e) {
    error = e
  }
  check('flags 超出 64 位抛错（DWORD64 边界）', error?.code === 'MITIGATION_FLAGS_INVALID', error?.code ?? '未抛')
}
{
  let error = null
  try {
    buildMitigationPolicy({ include: 'DEP_ENABLE' })
  } catch (e) {
    error = e
  }
  check('include 传非数组抛 MITIGATION_SPEC_INVALID', error?.code === 'MITIGATION_SPEC_INVALID', error?.code ?? '未抛')
}
{
  const p = buildMitigationPolicy({ profile: 'untrusted' })
  const v = validateMitigationFlags(p.flags)
  check('untrusted 的 validateMitigationFlags 无警告（没在 MASK 族里置错位）', v.warnings.length === 0, v.warnings.join(' | ') || '无警告')
  check('validateMitigationFlags 的 names 与策略 names 一致', v.names.join(',') === p.names.join(','), v.names.join(', '))
}
{
  const v = validateMitigationFlags(MITIGATION_FLAGS.DEP_ATL_THUNK_ENABLE)
  check('审计：只置 DEP_ATL_THUNK 而缺 DEP 时给出警告（官方前提）', v.warnings.some((w) => w.includes('DEP_ENABLE')), v.warnings[0] ?? '无警告')
}
{
  const v = validateMitigationFlags(MITIGATION_FLAGS.HIGH_ENTROPY_ASLR)
  check('审计：只置 HIGH_ENTROPY_ASLR 而缺 BOTTOM_UP_ASLR 时给出警告', v.warnings.some((w) => w.includes('BOTTOM_UP_ASLR')), v.warnings[0] ?? '无警告')
}
{
  const v = validateMitigationFlags(PROHIBIT_DYNAMIC_CODE_ALLOW_OPT_OUT)
  check('审计：ACG 的 ALLOW_OPT_OUT 组合被报"不是严格的 ALWAYS_ON"', v.warnings.some((w) => w.includes('PROHIBIT_DYNAMIC_CODE')), v.warnings[0] ?? '无警告')
}
{
  const v = validateMitigationFlags(BLOCK_NON_MICROSOFT_BINARIES_ALLOW_STORE)
  check('审计：CIG 的 ALLOW_STORE 组合被报出来（不假装它是严格签名策略）', v.warnings.some((w) => w.includes('BLOCK_NON_MICROSOFT_BINARIES')), v.warnings[0] ?? '无警告')
}
{
  const v = validateMitigationFlags(1n << 63n)
  check('审计：标志表之外的位（如 bit63 / MITIGATION_POLICY2 段）被报出来', v.warnings.some((w) => w.includes('0x8000000000000000')), v.warnings[0] ?? '无警告')
}

W('')
W('=== 6. buffer → describe 往返 ===')
for (const name of MITIGATION_PROFILE_NAMES) {
  const p = buildMitigationPolicy(name)
  const roundTrip = describeMitigationPolicy(p.buffer.readBigUInt64LE(0))
  check(`往返（${name}）：从 buffer 解码出的名字集合与策略 names 一致`, roundTrip.join(',') === p.names.join(','), `${roundTrip.join(',')} vs ${p.names.join(',')}`)
}
{
  const p = buildMitigationPolicy('untrusted')
  check('describe 接受策略结果对象', describeMitigationPolicy(p).join(',') === p.names.join(','), '接受 {flags}')
  check('describe 接受裸 BigInt', describeMitigationPolicy(p.flags).join(',') === p.names.join(','), '接受 bigint')
  check('describe 接受十六进制字符串', describeMitigationPolicy(p.hex).join(',') === p.names.join(','), `接受 ${p.hex}`)
  check('describe 接受安全整数（低 32 位内）', describeMitigationPolicy(0x5).join(',') === 'DEP_ENABLE,SEHOP_ENABLE', describeMitigationPolicy(0x5).join(','))
}
{
  const all = Object.values(MITIGATION_FLAGS).reduce((a, b) => a | b, 0n)
  check('describe(全部标志置位) 返回全部 17 个名字', describeMitigationPolicy(all).length === Object.keys(MITIGATION_FLAGS).length, `${describeMitigationPolicy(all).length} 个`)
}
check('describe 对 0 返回空表（none 档）', describeMitigationPolicy(0n).length === 0, describeMitigationPolicy(0n).join(',') || '空')
{
  let error = null
  try {
    describeMitigationPolicy(true)
  } catch (e) {
    error = e
  }
  check('describe 对非法输入（boolean）抛 MITIGATION_FLAGS_INVALID', error?.code === 'MITIGATION_FLAGS_INVALID', error?.code ?? '未抛')
}

W('')
W('=== 7. applyMitigationPolicy 的调用契约（逐参数）===')
{
  const api = makeApi({ returns: true })
  const policy = buildMitigationPolicy('hardened')
  const out = applyMitigationPolicy({ api, attrList: ATTR_LIST, policy })
  check('返回 applied:true', out.applied === true, 'applied')
  check('恰好调用一次 updateProcThreadAttribute（不重复写）', api.calls.filter((c) => c.fn === 'updateProcThreadAttribute').length === 1, String(api.calls.length))
  check(
    '调用契约逐字：updateProcThreadAttribute(attrList, 0, 0x00020010, value, 8, null, null)',
    api.calls[0].fn === 'updateProcThreadAttribute' && api.calls[0].args.length === 7 && api.calls[0].args[2] === 0x00020010 && api.calls[0].args[4] === 8,
    renderCall(api.calls[0]),
  )
  const args = api.calls[0].args
  check('第 1 个参数是属性列表本身（对象同一性）', args[0] === ATTR_LIST, 'attrList 同一性')
  check('第 2 个参数 dwFlags === 0（官方保留位，必须为 0）', args[1] === 0, String(args[1]))
  check('第 3 个参数 Attribute === MITIGATION_POLICY_ATTRIBUTE', args[2] === MITIGATION_POLICY_ATTRIBUTE, `0x${Number(args[2]).toString(16)}`)
  check('第 4 个参数是策略 buffer（同一性 + 内容 = flags 小端）', args[3] === policy.buffer && args[3].readBigUInt64LE(0) === policy.flags, hex64(args[3].readBigUInt64LE(0)))
  check('第 5 个参数 cbSize === 8（不是 4、不是 16）', args[4] === MITIGATION_POLICY_VALUE_SIZE && args[4] === 8, String(args[4]))
  check('第 6/7 个参数 lpPreviousValue / lpReturnSize 均为 null（官方保留）', args[5] === null && args[6] === null, `${String(args[5])}, ${String(args[6])}`)
  check('调用顺序：先写属性再取错误码（成功时不调 getLastError）', api.calls.length === 1, api.calls.map((c) => c.fn).join(' → '))
  check('返回值带上 flags/names/profile（供报告直接用）', out.flags === policy.flags && out.profile === 'hardened' && out.names.join(',') === policy.names.join(','), out.profile)
}
{
  const api = makeApi({ returns: true })
  const out = applyMitigationPolicy({ api, attrList: ATTR_LIST, policy: 'none' })
  check('none 档也能被"成功写入"，但 out.noop === true（调用方可据此跳过）', out.noop === true && api.calls[0].args[3].readBigUInt64LE(0) === 0n, 'flags=0')
}
{
  // 注意：pin 的记录数组与 API 实参的记录数组**必须分开** —— 共用一个数组会让
  // 下标语义随调用顺序漂移（本测试初版就踩了这个坑：calls[4] 变成了属性号而不是地址）。
  const pinCalls = []
  const apiCalls = []
  const pinned = 0xdeadbeefn
  const api = { calls: apiCalls, updateProcThreadAttribute: (...args) => (apiCalls.push(args), true) }
  const out = applyMitigationPolicy({ api, attrList: ATTR_LIST, policy: 'baseline', pin: (buffer, what) => (pinCalls.push(buffer, what), pinned) })
  check('pin 是函数时被调用且传入 (buffer, what)（与 appcontainer-runtime 的 pin 语义一致）', pinCalls[1] === 'PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY' && Buffer.isBuffer(pinCalls[0]), `${String(pinCalls[1])}`)
  check('lpValue 用 pin 返回的原生地址（不是 JS Buffer）', out.value === pinned && apiCalls[0][3] === pinned, `out.value = 0x${out.value.toString(16)}；实参 = 0x${apiCalls[0][3].toString(16)}`)
  check('pin 收到的 buffer 就是策略 buffer（同一性，不是拷贝）', pinCalls[0].readBigUInt64LE(0) === out.flags, hex64(pinCalls[0].readBigUInt64LE(0)))
}
{
  const calls = []
  const api = { calls, updateProcThreadAttribute: (...args) => (calls.push(args), true) }
  const address = 0x1234n
  const out = applyMitigationPolicy({ api, attrList: ATTR_LIST, policy: 'baseline', pin: address })
  check('pin 传非函数值时原样透传（内联指针/已解析地址）', out.value === address && calls[0][3] === address, `0x${address.toString(16)}`)
}
{
  let error = null
  try {
    applyMitigationPolicy({ api: makeApi(), attrList: ATTR_LIST, policy: 'baseline', pin: () => null })
  } catch (e) {
    error = e
  }
  check('pin 返回空值时抛 MITIGATION_PIN_FAILED（不用不可解析的缓冲区继续）', error?.code === 'MITIGATION_PIN_FAILED', error?.code ?? '未抛')
}

W('')
W('=== 8. applyMitigationPolicy 失败必须抛（fail-closed）===')
{
  const api = makeApi({ returns: false, getLastErrorValue: 87 })
  let error = null
  try {
    applyMitigationPolicy({ api, attrList: ATTR_LIST, policy: 'baseline' })
  } catch (e) {
    error = e
  }
  check('返回 false ⇒ 抛 MITIGATION_ATTRIBUTE_UPDATE_FAILED', error?.code === 'MITIGATION_ATTRIBUTE_UPDATE_FAILED', error?.code ?? '未抛')
  check('异常带 GetLastError 的码 87（ERROR_INVALID_PARAMETER）', error?.win32Code === 87, String(error?.win32Code))
  check('异常信息里带属性号与尺寸（可定位）', /0x20010/.test(error?.message ?? '') && /size=8/.test(error?.message ?? ''), (error?.message ?? '').slice(0, 140))
  check('失败路径确实先调用 updateProcThreadAttribute 再调用 getLastError（顺序固定）', api.calls.map((c) => c.fn).join(' → ') === 'updateProcThreadAttribute → getLastError', api.calls.map((c) => c.fn).join(' → '))
}
{
  const api = makeApi({ returns: 0, getLastErrorValue: 122 })
  let error = null
  try {
    applyMitigationPolicy({ api, attrList: ATTR_LIST, policy: 'baseline' })
  } catch (e) {
    error = e
  }
  check('[实测教训同类] 数字 0 也判失败（离线替身形态），带码 122 ERROR_INSUFFICIENT_BUFFER', error?.code === 'MITIGATION_ATTRIBUTE_UPDATE_FAILED' && error?.win32Code === 122, `${error?.code}/${error?.win32Code}`)
}
{
  const api = makeApi({ returns: null, getLastErrorValue: 87 })
  let error = null
  try {
    applyMitigationPolicy({ api, attrList: ATTR_LIST, policy: 'baseline' })
  } catch (e) {
    error = e
  }
  check('返回 null 也判失败（非法类型一律视为失败，不乐观）', error?.code === 'MITIGATION_ATTRIBUTE_UPDATE_FAILED', error?.code ?? '未抛')
}
{
  const api = makeApi({ returns: false, getLastErrorThrows: true })
  let error = null
  try {
    applyMitigationPolicy({ api, attrList: ATTR_LIST, policy: 'baseline' })
  } catch (e) {
    error = e
  }
  check('GetLastError 自身抛异常时仍然抛出（win32Code=null，不吞失败）', error?.code === 'MITIGATION_ATTRIBUTE_UPDATE_FAILED' && error?.win32Code === null, `${error?.code}/${String(error?.win32Code)}`)
}
{
  const api = makeApi({ returns: false, withGetLastError: false })
  let error = null
  try {
    applyMitigationPolicy({ api, attrList: ATTR_LIST, policy: 'baseline' })
  } catch (e) {
    error = e
  }
  check('绑定表没有 getLastError 时仍然抛出（码为 null）', error?.code === 'MITIGATION_ATTRIBUTE_UPDATE_FAILED' && error?.win32Code === null, `${error?.code}/${String(error?.win32Code)}`)
}
{
  const api = makeApi({ throws: Object.assign(new Error('bad pointer'), { code: 'KOFFI_ARG_ERROR' }) })
  let error = null
  try {
    applyMitigationPolicy({ api, attrList: ATTR_LIST, policy: 'baseline' })
  } catch (e) {
    error = e
  }
  check('api 抛异常时原样向上传播（不被包装成"成功"）', error?.code === 'KOFFI_ARG_ERROR', error?.code ?? '未抛')
}
{
  let error = null
  try {
    applyMitigationPolicy({ api: {}, attrList: ATTR_LIST })
  } catch (e) {
    error = e
  }
  check('缺 updateProcThreadAttribute 绑定 ⇒ 抛 MITIGATION_BINDINGS_INVALID', error?.code === 'MITIGATION_BINDINGS_INVALID', error?.code ?? '未抛')
}
{
  let error = null
  try {
    applyMitigationPolicy({ api: makeApi(), attrList: null })
  } catch (e) {
    error = e
  }
  check('attrList 为空 ⇒ 抛 MITIGATION_ATTRLIST_INVALID（不传 null 给 Win32）', error?.code === 'MITIGATION_ATTRLIST_INVALID', error?.code ?? '未抛')
}
{
  const api = makeApi({ returns: true })
  let error = null
  try {
    applyMitigationPolicy({ api, attrList: ATTR_LIST, policy: 'nope' })
  } catch (e) {
    error = e
  }
  check('策略本身非法时不发起任何 Win32 调用（先校验后调用）', error?.code === 'MITIGATION_PROFILE_UNKNOWN' && api.calls.length === 0, `${error?.code}/${api.calls.length} 次调用`)
}

W('')
W('=== 9. probeMitigationSupport（任何异常/假值都不得报 true）===')
{
  const api = makeApi({ returns: true })
  const r = probeMitigationSupport({ api, attributeList: ATTR_LIST, policy: 'baseline' })
  check('正常替身 ⇒ supported:true 且 errorCode:null', r.supported === true && r.errorCode === null, r.reason)
  check('探测也用同一个属性号与尺寸（不另造常量）', r.attribute === MITIGATION_POLICY_ATTRIBUTE && r.size === 8, `0x${r.attribute.toString(16)}/${r.size}`)
  check('探测的调用参数与 apply 一致（0, attr, buffer, 8, null, null）', api.calls[0].args.length === 7 && api.calls[0].args[2] === MITIGATION_POLICY_ATTRIBUTE && api.calls[0].args[4] === 8 && api.calls[0].args[5] === null && api.calls[0].args[6] === null, renderCall(api.calls[0]))
}
{
  const api = { updateProcThreadAttribute: () => { throw new Error('binding exploded') } }
  const r = probeMitigationSupport({ api, attributeList: ATTR_LIST, policy: 'baseline' })
  check('绑定表抛异常 ⇒ supported:false', r.supported === false, r.reason)
  check('绑定表抛异常时 reason 里带出异常原文（可定位）', /binding exploded/.test(r.reason), r.reason)
  check('绑定表抛异常时 errorCode 为 null（拿不到 Win32 码就如实写 null）', r.errorCode === null, String(r.errorCode))
}
{
  const api = { updateProcThreadAttribute: () => { throw Object.assign(new Error('koffi'), { code: 'KOFFI_INVALID' }) } }
  const r = probeMitigationSupport({ api, attributeList: ATTR_LIST })
  check('异常带 code 时 errorCode 取该 code（不丢信息）', r.supported === false && r.errorCode === 'KOFFI_INVALID', String(r.errorCode))
}
{
  const api = makeApi({ returns: false, getLastErrorValue: 87 })
  const r = probeMitigationSupport({ api, attributeList: ATTR_LIST })
  check('返回 false + 87 ⇒ supported:false，errorCode=87', r.supported === false && r.errorCode === 87, String(r.errorCode))
}
{
  const api = makeApi({ returns: false, getLastErrorThrows: true })
  const r = probeMitigationSupport({ api, attributeList: ATTR_LIST })
  check('返回 false 且 GetLastError 抛异常 ⇒ supported:false，errorCode=null', r.supported === false && r.errorCode === null, `${r.supported}/${String(r.errorCode)}`)
}
{
  const api = { getLastError: () => 87 }
  const r = probeMitigationSupport({ api, attributeList: ATTR_LIST })
  check('绑定表缺 updateProcThreadAttribute ⇒ supported:false + MITIGATION_BINDINGS_INVALID', r.supported === false && r.errorCode === 'MITIGATION_BINDINGS_INVALID', r.reason)
}
{
  const api = makeApi({ returns: true })
  const r = probeMitigationSupport({ api })
  check('既没给 attributeList 也没开 ownAttributeList ⇒ 明确不支持并说明原因（不猜测平台）', r.supported === false && r.errorCode === 'MITIGATION_ATTRLIST_REQUIRED', r.reason)
}
{
  const api = makeApi({ returns: true })
  const r = probeMitigationSupport({ api, ownAttributeList: true })
  check('ownAttributeList 且无初始化绑定 ⇒ 用 8 字节假列表仍能探测替身', r.supported === true && r.notes.length > 0, r.notes.join(' | '))
  check('探测不修改策略语义：仍写 8 字节值', api.calls[0].args[4] === 8, String(api.calls[0].args[4]))
}
{
  const sizes = []
  const api = {
    initializeProcThreadAttributeList: (list, count, flags, sizeSlot) => (sizes.push([list === null, count, flags, sizeSlot[0]]), (sizeSlot[0] = sizeSlot[0] || 48), true),
    updateProcThreadAttribute: () => true,
  }
  const r = probeMitigationSupport({ api, ownAttributeList: true })
  check('ownAttributeList + 有初始化绑定时走官方两阶段协商（先问尺寸再建列表）', r.supported === true && sizes.length === 2 && sizes[0][0] === true && sizes[1][0] === false, JSON.stringify(sizes))
  check('协商用的属性计数是 1（探测只写一个属性）', sizes[0][1] === 1, String(sizes[0][1]))
}
{
  const api = { initializeProcThreadAttributeList: () => { throw new Error('no init') }, updateProcThreadAttribute: () => true }
  const r = probeMitigationSupport({ api, ownAttributeList: true })
  check('初始化阶段抛异常 ⇒ supported:false（初始化失败不得继续探测成功）', r.supported === false && /no init/.test(r.reason), r.reason)
}

W('')
W('=== 10. summariseMitigations（报告投影）===')
{
  const p = buildMitigationPolicy('untrusted')
  const s = summariseMitigations(p)
  check('摘要含 profile 名', s.profile === 'untrusted', s.profile)
  check('flags 是 16 位定宽的十六进制字符串', typeof s.flags === 'string' && /^0x[0-9a-f]{16}$/.test(s.flags), s.flags)
  check('flags 字符串与 flags 数值一致', BigInt(s.flags) === p.flags, `${s.flags} vs ${hex64(p.flags)}`)
  check('names 与策略一致（报告不另算一套）', s.names.join(',') === p.names.join(','), s.names.join(', '))
  check('摘要带上属性号与尺寸（报告可直接引用）', s.attribute === '0x00020010' && s.size === 8, `${s.attribute}/${s.size}`)
  check('none 档摘要 noop:true 且 flags 全 0', summariseMitigations(buildMitigationPolicy('none')).noop === true && summariseMitigations(buildMitigationPolicy('none')).flags === '0x0000000000000000', summariseMitigations(buildMitigationPolicy('none')).flags)
  check('摘要接受档位名（不必先 build）', summariseMitigations('baseline').profile === 'baseline', summariseMitigations('baseline').profile)
  check('摘要 names 是**拷贝**（改动它不会污染预设表）', (() => { const a = summariseMitigations('baseline'); a.names.push('X'); return !MITIGATION_PROFILES.baseline.includes('X') })(), 'MITIGATION_PROFILES.baseline 未被污染')
}
check('buildMitigationPolicy 的返回对象整体冻结（防止下游改 flags 而 buffer 不同步）', Object.isFrozen(buildMitigationPolicy('baseline')), 'frozen')
check('buildMitigationPolicy 的 names 是冻结数组', Object.isFrozen(buildMitigationPolicy('baseline').names), 'frozen')

W('')
W('=== 11. 现状声明（不得被读成"已实测生效"）===')
check(
  '本模块只保证"注入或不启动"；策略是否真的生效不在本模块判定（集成方需子进程侧证据）',
  typeof summariseMitigations === 'function' && PLANT === false,
  '[未实测] 本机无 SDK 头文件、未做真实 CreateProcess；常量证据为 [官方]，运行期后果为 [推断]',
)
check(
  '负例：绝不存在"未知档位回退为 none"的行为（回退会把 denylist 悄悄变空）',
  (() => {
    try {
      buildMitigationPolicy('definitely-not-a-profile')
      return false
    } catch {
      return true
    }
  })(),
  '未知档位必须抛错',
)

W('')
W('='.repeat(64))
W(
  failures === 0
    ? `进程缓解策略测试：断言 ${assertions} 项，失败 0 项，全部通过`
    : `进程缓解策略测试${PLANT ? '（--plant 模式，应当失败）' : ''}：断言 ${assertions} 项，失败 ${failures} 项`,
)
W('='.repeat(64))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failed=${failures}${PLANT ? ' mode=--plant' : ''}`)
process.exit(failures ? 1 : 0)
