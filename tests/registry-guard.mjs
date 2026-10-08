/**
 * registry-guard 的离线确定性测试
 * （**不需要管理员、不需要真实注册表写入、不触碰任何系统状态**）
 *
 * 存在理由：注册表隔离的候选方案里，
 *   ① AppContainer 天然受限 —— 阶段 A `[实测]` `CreateAppContainerProfile` 返回 E_ACCESSDENIED；
 *      **阶段 B 更正**：High IL 管理员令牌下 profile **能建**（hr=0x0），但用 `SECURITY_CAPABILITIES`
 *      属性列表起出来的进程**不在 AppContainer 里**（子进程 `whoami /all` = 完整管理员 + High IL）。
 *      ⇒ ① 仍**不可用**，只是原因从"建不了 profile"变成了"隔离不生效"；
 *   ③ 按 SID 的注册表 ACL —— 需要 `WRITE_DAC`、HKLM 需管理员、改坏难恢复；
 *   ② **快照 + 差异 + 可选回滚** —— 本模块实现的方案。
 * 方案 ② 的定位是**检测**，不是硬边界。因此本文件测的是"检测是否可靠"：
 *   - 差异算法是否漏报（值类型变化、权限变化、"可读→拒绝访问"）；
 *   - 回滚计划是否**如实标注**不可逆项（不把 IMPOSSIBLE 藏起来）；
 *   - 采集失败（reader 返回 null/undefined）是否被当成"没变化"（绝不能）。
 *
 * 用法：
 *   node tests\registry-guard.mjs            # 正常运行，应当全绿
 *   node tests\registry-guard.mjs --plant    # 故意漏报一类差异，证明判定可失败
 */

import {
  HIVE_HANDLES,
  REG_TYPES,
  REG_STATUS,
  REG_ACCESS,
  parseRegistryPath,
  normalizeSnapshot,
  serializeSnapshot,
  deserializeSnapshot,
  diffSnapshots,
  planRollback,
  planAclRestriction,
  REVERSIBILITY,
  RegistryGuard,
  createRegistryReader,
  encodeRegistryValue,
  decodeRegistryValue,
  registryTypeName,
  __internal,
} from '../src/registry-guard.mjs'
// T3：注册表**暂存**层的全套断言（覆盖 hive 覆盖 / WAL / 候选 / 选择性应用 / 丢弃）。
// 之所以在这里 import 而不是只留一个独立套件：`verify.cmd` 与 `src\testrunner.mjs` 的
// 套件清单不在 T3 的写入范围内，接进既有入口才能保证"新断言真的被 verify 跑到"——
// 否则就是 FIX-C/FIX-F 文档里点名的那个缺陷：新套件存在却没人跑，改坏了没人知道。
import { runRegistryStageChecks } from './registry-stage.mjs'
// T3 符合性：用**真实产物**（DLL 导出表 / DLL 写出的 WAL / 闭环节报告）钉契约。
// 这不是"再跑一遍纯层"：它断言的是构件的字节，缺一即红（DLL 存在时强制）。
// 产物缺失（新克隆里 shim/ 未入库）⇒ 显式 SKIP，绝不算通过。
// 应急开关：DSH_CONFORMANCE_ARTIFACTS=off（会打印大写的"未验证"，那不是绿）。
import { runRegistryConformanceChecks } from './registry-conformance.mjs'

const PLANT = process.argv.includes('--plant')

const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0
let skips = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`${condition ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}

/** 缺产物时的**显式跳过**：打印原因，既不算通过也不算失败（"跳过 ≠ 通过"）。 */
function skip(name, reason) {
  skips += 1
  W(`  ⊘ SKIP ${name}\n      原因: ${reason}`)
}

function checkThrows(name, fn, expectedCode) {
  assertions += 1
  try {
    fn()
    failures += 1
    W(`  ✗ ${name}\n      证据: 竟然没有抛错（期望 ${expectedCode ?? '任意错误'}）`)
    return undefined
  } catch (error) {
    const ok = expectedCode === undefined || error.code === expectedCode
    if (!ok) failures += 1
    W(`  ${ok ? '✓' : '✗'} ${name}\n      证据: code=${error.code ?? '(none)'} message=${String(error.message).slice(0, 160)}`)
    return error
  }
}

function section(title) {
  W('')
  W(`=== ${title} ===`)
}

/**
 * 可以安全打印 BigInt 的证据序列化。
 *
 * 阶段 B 实测缺陷：初版用裸 `JSON.stringify(...)` 生成断言证据，而
 * `parseRegistryPath()` 的返回值里带 `handle: bigint`（预定义根键句柄），
 * `HIVE_HANDLES` 的值全是 bigint，`RegistryGuard` 的调用记录里也有 bigint 句柄。
 * 原生 `JSON.stringify` 遇到 bigint 直接抛 `TypeError: Do not know how to serialize a BigInt` ——
 * 于是测试在**第 8 条断言**就因为"打印证据"而整体崩溃，后面 100 多条断言从未执行。
 * 注意这是**测试**缺陷，不是被测代码缺陷：被测代码里 bigint 是正确类型。
 *
 * 实现上用别名 `NATIVE_STRINGIFY` 保存原生函数：本文件里所有裸的 `JSON.stringify(`
 * 已被统一改名为 `safeJson(`；若这个定义里再写一次原生名字加左括号，替换后会自我递归。
 */
const NATIVE_STRINGIFY = JSON.stringify
function safeJson(value) {
  return NATIVE_STRINGIFY(value, (key, item) => (typeof item === 'bigint' ? `${item}n` : item))
}

if (PLANT) {
  W('*** --plant 模式：故意让差异检测忽略"值类型变化"，断言应当失败 ***')
}

section('1. 注册表路径解析（纯函数；不明根键必须抛错而不是猜）')
{
  const parsed = parseRegistryPath('HKLM\\Software\\Microsoft\\Windows\\CurrentVersion')
  check('HKLM 句柄 = 0x80000002', parsed.handle === HIVE_HANDLES.HKLM, `0x${parsed.handle.toString(16)}`)
  check('hive 归一化为短名 HKLM', parsed.hive === 'HKLM', parsed.hive)
  check('subKey 去掉了根键', parsed.subKey === 'Software\\Microsoft\\Windows\\CurrentVersion', parsed.subKey)
  check(
    'canonical = 短名 + subKey（subKey 保留原始大小写，不被 toUpperCase 污染）',
    parsed.canonical === 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion',
    parsed.canonical,
  )
  check('HKEY_CURRENT_USER 全名可解析为短名 HKCU', parseRegistryPath('HKEY_CURRENT_USER\\Software').hive === 'HKCU', parseRegistryPath('HKEY_CURRENT_USER\\Software').hive)
  // ── 阶段 B 实测缺陷回归：全名与短名必须归一化到**同一个** canonical ──────────────
  // 初版 `head.startsWith('HKEY_') ? head.slice(5) : head` 让 `HKLM\X` → `HKLM\X`
  // 而 `HKEY_LOCAL_MACHINE\X` → `LOCAL_MACHINE\X`。canonical 是快照的 root 键，
  // 两种写法给出两个 root ⇒ 同一位置的两次快照**永远比不相等** ⇒ "什么都没变"的假阴性。
  {
    const pairs = [
      ['HKLM', 'HKEY_LOCAL_MACHINE'],
      ['HKCU', 'HKEY_CURRENT_USER'],
      ['HKU', 'HKEY_USERS'],
      ['HKCR', 'HKEY_CLASSES_ROOT'],
      ['HKCC', 'HKEY_CURRENT_CONFIG'],
    ]
    const equivalent = pairs.every(([short, long]) => {
      const a = parseRegistryPath(`${short}\\Software\\X`)
      const b = parseRegistryPath(`${long}\\Software\\X`)
      return a.hive === b.hive && a.handle === b.handle && a.canonical === b.canonical && a.hive === short
    })
    check('短名与 HKEY_ 全名产出完全相同的 hive/handle/canonical（5 组）', equivalent, pairs.map(([s, l]) => `${s}=${parseRegistryPath(`${s}\\Software\\X`).canonical}|${parseRegistryPath(`${l}\\Software\\X`).canonical}`).join(' '))
    check(
      'HKPD 句柄 = 0x80000004（与 HKEY_PERFORMANCE_DATA 同一个；初版错写 0x80000008）',
      HIVE_HANDLES.HKPD === 0x80000004n && HIVE_HANDLES.HKEY_PERFORMANCE_DATA === HIVE_HANDLES.HKPD,
      `HKPD=0x${HIVE_HANDLES.HKPD.toString(16)} HKEY_PERFORMANCE_DATA=0x${HIVE_HANDLES.HKEY_PERFORMANCE_DATA.toString(16)}`,
    )
  }
  check('正斜杠被归一化为反斜杠', parseRegistryPath('HKCU/Software/X').subKey === 'Software\\X', parseRegistryPath('HKCU/Software/X').subKey)
  check('尾部反斜杠被去掉', parseRegistryPath('HKCU\\Software\\').subKey === 'Software', parseRegistryPath('HKCU\\Software\\').subKey)
  check('只有根键时 subKey 为空', parseRegistryPath('HKCU').subKey === '', safeJson(parseRegistryPath('HKCU')))
  checkThrows(
    '缺少根键的裸路径必须抛错（猜测根键会让快照悄悄记错位置 → 假阴性）',
    () => parseRegistryPath('Software\\Microsoft'),
    'REG_HIVE_UNKNOWN',
  )
  checkThrows('空路径抛错', () => parseRegistryPath(''), undefined)
  check(
    '预定义根键句柄是固定值（不是随便取的指针）',
    HIVE_HANDLES.HKCR === 0x80000000n && HIVE_HANDLES.HKLM === 0x80000002n && HIVE_HANDLES.HKU === 0x80000003n,
    safeJson(Object.entries(HIVE_HANDLES).slice(0, 4)),
  )
  check(
    'REG_TYPES 的数值与 winreg.h 一致（抽查 4 个）',
    REG_TYPES.REG_SZ === 1 && REG_TYPES.REG_BINARY === 3 && REG_TYPES.REG_DWORD === 4 && REG_TYPES.REG_QWORD === 11,
    safeJson(REG_TYPES),
  )
}

section('2. 快照归一化（顺序必须确定，否则会出现"每次都不一样"的假差异）')
{
  const raw = {
    root: 'HKCU\\Software\\Test',
    exists: true,
    subKeys: ['zeta', 'Alpha', 'beta'],
    values: {
      Zeta: { type: 'REG_SZ', data: 'z' },
      alpha: { type: 'REG_DWORD', data: 1 },
      Beta: { type: 'REG_QWORD', data: 0xdeadbeefcafen },
    },
  }
  const snapshot = normalizeSnapshot(raw)
  check('exists=true', snapshot.exists === true, String(snapshot.exists))
  check('accessDenied=false', snapshot.accessDenied === false, String(snapshot.accessDenied))
  check(
    'subKeys 按不区分大小写排序',
    safeJson(snapshot.subKeys) === safeJson(['Alpha', 'beta', 'zeta']),
    safeJson(snapshot.subKeys),
  )
  check(
    'values 键按不区分大小写排序',
    safeJson(Object.keys(snapshot.values)) === safeJson(['alpha', 'Beta', 'Zeta']),
    safeJson(Object.keys(snapshot.values)),
  )
  check('快照被冻结（防止调用方就地改写导致"基准"被污染）', Object.isFrozen(snapshot), String(Object.isFrozen(snapshot)))
  check('REG_DWORD 归一化为 8 位十六进制文本', snapshot.values.alpha.data === '0x00000001', snapshot.values.alpha.data)
  check('REG_QWORD 归一化为 16 位十六进制文本', snapshot.values.Beta.data === '0x0000deadbeefcafe', snapshot.values.Beta.data)
  check(
    'REG_SZ 归一化为 UTF-16LE 十六进制（避免控制台代码页影响比较）',
    snapshot.values.Zeta.data === Buffer.from('z\u0000', 'utf16le').toString('hex'),
    snapshot.values.Zeta.data,
  )
  check('值类型以**名字**保存（不是裸数字，便于人工核对）', snapshot.values.alpha.type === 'REG_DWORD', snapshot.values.alpha.type)

  // 输入顺序不同 → 归一化结果必须完全相同（这是"确定性"的核心断言）
  const reordered = normalizeSnapshot({ ...raw, subKeys: ['beta', 'zeta', 'Alpha'], values: { Beta: raw.values.Beta, Zeta: raw.values.Zeta, alpha: raw.values.alpha } })
  check(
    '输入顺序不影响归一化结果（serialize 逐字节相同）',
    serializeSnapshot(snapshot) === serializeSnapshot(reordered),
    `${serializeSnapshot(snapshot).length} vs ${serializeSnapshot(reordered).length} 字节`,
  )

  // 重复子键去重（**不区分大小写**：注册表里 `a` 与 `A` 是同一个子键）
  check('重复子键被去重', normalizeSnapshot({ ...raw, subKeys: ['a', 'A', 'b'] }).subKeys.length === 2, safeJson(normalizeSnapshot({ ...raw, subKeys: ['a', 'A', 'b'] }).subKeys))
  check(
    '重复子键去重后保留的是**排序后第一个**（确定性：不是"看输入顺序"）',
    safeJson(normalizeSnapshot({ ...raw, subKeys: ['b', 'A', 'a'] }).subKeys) === safeJson(['A', 'b']),
    safeJson(normalizeSnapshot({ ...raw, subKeys: ['b', 'A', 'a'] }).subKeys),
  )
  // 值的名字同样不区分大小写（阶段 B 实测缺陷的另一半：初版只对子键去重，值完全没去重）
  check(
    '重复**值名**也被去重（不区分大小写，否则会产出幻影值差异）',
    Object.keys(normalizeSnapshot({ ...raw, values: { Dup: { type: 'REG_SZ', data: 'x' }, dup: { type: 'REG_SZ', data: 'y' } } }).values).length === 1,
    safeJson(Object.keys(normalizeSnapshot({ ...raw, values: { Dup: { type: 'REG_SZ', data: 'x' }, dup: { type: 'REG_SZ', data: 'y' } } }).values)),
  )

  checkThrows('缺少 root 时抛错', () => normalizeSnapshot({ exists: true }), 'REG_SNAPSHOT_INVALID')
  checkThrows('未知值类型抛错（不猜类型）', () => normalizeSnapshot({ root: 'HKCU\\A', exists: true, values: { x: { type: 'REG_MAGIC', data: 1 } } }), 'REG_SNAPSHOT_INVALID')
  checkThrows('REG_DWORD 传字符串时抛错', () => normalizeSnapshot({ root: 'HKCU\\A', exists: true, values: { x: { type: 'REG_DWORD', data: '1' } } }), 'REG_SNAPSHOT_INVALID')
  checkThrows('值条目不是对象时抛错', () => normalizeSnapshot({ root: 'HKCU\\A', exists: true, values: { x: 1 } }), 'REG_SNAPSHOT_INVALID')

  // 不存在 vs 拒绝访问：必须是**两种不同结果**（手册第 4 章）
  const missing = normalizeSnapshot({ root: 'HKCU\\A', exists: false })
  const denied = normalizeSnapshot({ root: 'HKCU\\A', exists: true, accessDenied: true, errorCode: REG_STATUS.ERROR_ACCESS_DENIED })
  check('不存在的键：exists=false, accessDenied=false', missing.exists === false && missing.accessDenied === false, safeJson({ exists: missing.exists, denied: missing.accessDenied }))
  check('拒绝访问：accessDenied=true（并且保守记为 exists=true）', denied.accessDenied === true && denied.exists === true, safeJson({ exists: denied.exists, denied: denied.accessDenied }))
  check('不存在的 errorCode = 2', missing.errorCode === REG_STATUS.ERROR_FILE_NOT_FOUND, String(missing.errorCode))
  check('拒绝访问的 errorCode = 5', denied.errorCode === REG_STATUS.ERROR_ACCESS_DENIED, String(denied.errorCode))
  check('两种结果的序列化文本不同（不会被混为一谈）', serializeSnapshot(missing) !== serializeSnapshot(denied), '不同')
}

section('3. 序列化往返（落盘基准必须能原样读回）')
{
  const snapshot = normalizeSnapshot({
    root: 'HKLM\\SOFTWARE\\X',
    exists: true,
    subKeys: ['a'],
    values: {
      S: { type: 'REG_SZ', data: 'hello' },
      E: { type: 'REG_EXPAND_SZ', data: '%SystemRoot%\\x' },
      M: { type: 'REG_MULTI_SZ', data: ['one', 'two'] },
      D: { type: 'REG_DWORD', data: 42 },
      Q: { type: 'REG_QWORD', data: 18446744073709551615n },
      B: { type: 'REG_BINARY', data: Buffer.from([0, 1, 255]) },
    },
    sddl: 'D:(A;;KA;;;SY)',
  })
  const text = serializeSnapshot(snapshot)
  const restored = deserializeSnapshot(text)
  check('serialize → deserialize 往返后 serialize 相同（逐字节）', serializeSnapshot(restored) === text, `${text.length} 字节`)
  // 测试缺陷（阶段 B 实测暴露）：初版断言 `restored.values.S.data === 'hello'`（类型化 JS 值），
  // 但 `normalizeSnapshot` 的**既定契约**是 `data` 一律保存为**编码后的文本**
  // （REG_SZ → UTF-16LE 十六进制；REG_DWORD → '0x…'；REG_QWORD → '0x…'；REG_BINARY → 裸十六进制）——
  // 本文件 §2 的断言（`snapshot.values.alpha.data === '0x00000001'` 等）正是这个契约。
  // 所以"往返后仍是类型化值"与 `deserializeSnapshot` 的实现（解码后再走一遍 normalizeSnapshot 重新编码）
  // 自相矛盾，那些断言**不可能**为真。正确的往返契约是"语义等价"，即整份 values 映射逐字段相同。
  check(
    '往返后 values 的每个 {type, data} 都与原快照相同（REG_SZ/EXPAND_SZ/MULTI_SZ/DWORD/QWORD/BINARY 六种全覆盖）',
    Object.keys(snapshot.values).length === 6 &&
      Object.entries(snapshot.values).every(
        ([name, entry]) => restored.values[name]?.type === entry.type && restored.values[name]?.data === entry.data,
      ),
    safeJson(Object.fromEntries(Object.entries(restored.values).map(([k, v]) => [k, `${v.type}:${v.data.slice(0, 24)}`]))),
  )
  check(
    'REG_SZ 的 data 是 UTF-16LE 十六进制（不是原字符串，也不是空串）',
    restored.values.S.data === Buffer.from('hello\u0000', 'utf16le').toString('hex'),
    restored.values.S.data,
  )
  // 解码器**必须真的在解码**，不能是"原样搬过去"：喂一份**大写**十六进制，
  // 解码 → 得到字符串 → normalizeSnapshot 重新编码 → 应当回落到**小写**。
  // 若是直通实现，输出会原样保留大写。
  {
    const upper = JSON.stringify({
      root: 'HKCU\\A',
      exists: true,
      accessDenied: false,
      errorCode: 0,
      subKeys: [],
      values: { S: { type: 'REG_SZ', data: Buffer.from('hello\u0000', 'utf16le').toString('hex').toUpperCase() } },
    })
    const decoded = deserializeSnapshot(upper)
    check(
      'deserializeSnapshot 真的解码并重新归一化（大写十六进制输入 → 小写输出）',
      decoded.values.S.data === Buffer.from('hello\u0000', 'utf16le').toString('hex'),
      decoded.values.S.data,
    )
    check('大写输入确实与大写文本不同（证明上一条断言的判定力）', decoded.values.S.data !== Buffer.from('hello\u0000', 'utf16le').toString('hex').toUpperCase(), 'case differs')
  }
  check('REG_MULTI_SZ 往返是编码后的文本', typeof restored.values.M.data === 'string' && restored.values.M.data === snapshot.values.M.data, restored.values.M.data)
  check('REG_DWORD 往返是 8 位十六进制文本', restored.values.D.data === '0x0000002a', String(restored.values.D.data))
  check('REG_QWORD 往返是 16 位十六进制文本（不丢精度）', restored.values.Q.data === '0xffffffffffffffff', String(restored.values.Q.data))
  check('REG_BINARY 往返是十六进制文本', restored.values.B.data === '0001ff', restored.values.B.data)
  check('SDDL 被保留（回滚要靠它）', restored.sddl === 'D:(A;;KA;;;SY)', String(restored.sddl))
  checkThrows('非法 JSON 抛错', () => deserializeSnapshot('{oops'), 'REG_SNAPSHOT_INVALID')
  checkThrows('未知类型抛错', () => deserializeSnapshot('{"root":"HKCU\\\\A","exists":true,"values":{"x":{"type":"REG_MAGIC","data":"00"}}}'), 'REG_SNAPSHOT_INVALID')
}

section('3b. F8：非十六进制 `data` 必须抛错，不得静默读成空串（阶段 B 待办 F8）')
{
  // ── 缺陷本体（`[实测]` 修复前）───────────────────────────────────────────────
  // `VALUE_DECODERS.REG_SZ('hello')` 走的是 `Buffer.from('hello','hex')`：
  // 它在第一个非法字符处**截断**，整串非法 ⇒ **空 Buffer** ⇒ `''`（空串）。
  // 于是"手工改坏的基准"被读成"REG_SZ 的值是空串"，而 diffSnapshots 对
  // "两边都是空串"当然报"没有变化" —— 这就是 F8 描述的假阴性。
  // 同一条路径上 REG_DWORD 也不抛（`parseInt('hello',16)` → NaN → 0），
  // REG_QWORD 抛的却是**不带 code** 的 SyntaxError，调用方无法统一识别。
  const bad = (type, data) => JSON.stringify({ root: 'HKCU\\A', exists: true, accessDenied: false, errorCode: 0, subKeys: [], values: { v: { type, data } } })

  checkThrows('REG_SZ 的非十六进制 data 抛 REG_SNAPSHOT_INVALID（不再静默变空串）', () => deserializeSnapshot(bad('REG_SZ', 'hello')), 'REG_SNAPSHOT_INVALID')
  checkThrows('REG_DWORD 的非十六进制 data 抛错（不再静默变 0）', () => deserializeSnapshot(bad('REG_DWORD', 'hello')), 'REG_SNAPSHOT_INVALID')
  checkThrows('REG_QWORD 的非十六进制 data 抛错且带统一错误码（不再是裸 SyntaxError）', () => deserializeSnapshot(bad('REG_QWORD', 'hello')), 'REG_SNAPSHOT_INVALID')
  checkThrows('奇数长度的十六进制 data 抛错', () => deserializeSnapshot(bad('REG_BINARY', 'abc')), 'REG_SNAPSHOT_INVALID')
  checkThrows('非字符串 data 抛错', () => deserializeSnapshot(bad('REG_BINARY', 1234)), 'REG_SNAPSHOT_INVALID')
  checkThrows('REG_SZ 的空 data 抛错（合法编码产物必非空）', () => deserializeSnapshot(bad('REG_SZ', '')), 'REG_SNAPSHOT_INVALID')
  checkThrows('REG_DWORD 缺 0x 前缀抛错（形状必须与编码器逐字一致）', () => deserializeSnapshot(bad('REG_DWORD', '0000002a')), 'REG_SNAPSHOT_INVALID')

  // 边界：`REG_BINARY` 的编码器对空 Buffer 就产出 `''`，这是**合法**快照形态，
  // 不能因为修 F8 就把模块自己序列化出来的东西判非法（往返契约）。
  {
    const emptyBinary = serializeSnapshot(normalizeSnapshot({ root: 'HKCU\\A', exists: true, values: { b: { type: 'REG_BINARY', data: Buffer.alloc(0) } } }))
    let roundTripOk = false
    try {
      roundTripOk = serializeSnapshot(deserializeSnapshot(emptyBinary)) === emptyBinary
    } catch {
      roundTripOk = false
    }
    check('空 REG_BINARY 的往返仍然合法（F8 只修"非十六进制"，不顺手把空串判非法）', roundTripOk, `${emptyBinary.length} 字节快照`)
  }

  // ── "能失败"证明（--plant）──────────────────────────────────────────────────
  // 关掉形状守卫 ⇒ 恢复旧行为，并把**真实观测**打出来。
  // ⚠ 诚实更正（实测）：F8 原文写的是"静默产出**空串**"，本轮实测的形态其实更准确的是
  // **"静默产出垃圾"**：`Buffer.from('hello','hex')` 从 'e' 起截断，得到 1 字节 `0x0e`
  // （`'h'` 不是十六进制字符，`'e'` 是），UTF-16LE 解出 `\u000e`，重新编码是 `0e00`。
  // 也就是说：**读出来的值与写入值毫无关系，而且不抛错**。
  // 无论表现成空串还是垃圾串，"静默"这一点不变，判据因此写成
  // "必须抛错 **或** 静默值与不合法输入逐值对应"——两种表现都在红的一侧。
  if (PLANT) __internal.decodeGuard = false
  let silent
  try {
    silent = deserializeSnapshot(bad('REG_SZ', 'hello')).values.v.data
  } catch (error) {
    silent = `THREW:${error.code ?? error.name}`
  }
  __internal.decodeGuard = true
  const silentlyWrong = silent === '0e00' || silent === '' || silent === '0000'
  check(
    '旧行为复现：无守卫时 "hello" 被静默读成错误的值（0e00/空串），不抛错（红 ⇒ 证明本组断言真的有判定力）',
    !silentlyWrong && silent.startsWith('THREW:'),
    `silent=${JSON.stringify(silent)}`,
  )
  check('守卫恢复后同一输入立刻抛 REG_SNAPSHOT_INVALID（开关语义对称）', (() => {
    try {
      deserializeSnapshot(bad('REG_SZ', 'hello'))
      return false
    } catch (error) {
      return error.code === 'REG_SNAPSHOT_INVALID'
    }
  })(), 'decodeGuard=true 时抛 REG_SNAPSHOT_INVALID')
  check('F8 的形状口径与编码器逐字对齐：合法十六进制仍被接受（大写也接受）', (() => {
    try {
      const decoded = deserializeSnapshot(bad('REG_BINARY', 'ABCD'))
      return decoded.values.v.data === 'abcd'
    } catch {
      return false
    }
  })(), 'REG_BINARY "ABCD" → "abcd"')
}

section('4. 差异检测（四态：新增 / 删除 / 修改 / 权限变化）')
{
  const before = normalizeSnapshot({
    root: 'HKCU\\Software\\T',
    exists: true,
    subKeys: ['keep', 'gone'],
    values: { same: { type: 'REG_SZ', data: 'x' }, changed: { type: 'REG_SZ', data: 'old' }, removed: { type: 'REG_DWORD', data: 1 } },
    sddl: 'D:(A;;KA;;;SY)',
  })
  const after = normalizeSnapshot({
    root: 'HKCU\\Software\\T',
    exists: true,
    subKeys: ['keep', 'added'],
    values: {
      same: { type: 'REG_SZ', data: 'x' },
      changed: { type: 'REG_SZ', data: 'new' },
      added: { type: 'REG_DWORD', data: 7 },
    },
    sddl: 'D:(A;;KA;;;BA)',
  })
  const { changes, summary } = diffSnapshots(before, after)
  const kinds = changes.map((c) => `${c.kind}:${c.valueName ?? c.key}`)

  check('检出 value-added', changes.some((c) => c.kind === 'value-added' && c.valueName === 'added'), kinds.join(' '))
  check('检出 value-deleted', changes.some((c) => c.kind === 'value-deleted' && c.valueName === 'removed'), kinds.join(' '))
  check('检出 value-changed（data 维度）', changes.some((c) => c.kind === 'value-changed' && c.valueName === 'changed' && c.reason === 'data'), kinds.join(' '))
  check('未变化的 same 不入差异（不产生噪音）', !changes.some((c) => c.valueName === 'same'), kinds.join(' '))
  check('检出 subkey-added', changes.some((c) => c.kind === 'subkey-added' && c.key.endsWith('added')), kinds.join(' '))
  check('检出 subkey-deleted', changes.some((c) => c.kind === 'subkey-deleted' && c.key.endsWith('gone')), kinds.join(' '))
  check('检出 security-changed（SDDL 变化）', changes.some((c) => c.kind === 'security-changed'), kinds.join(' '))
  check('summary 计数与 changes 一致', Object.values(summary).reduce((a, b) => a + b, 0) === changes.length, safeJson(summary))

  // 值类型变化：值本身"看起来"不同，但必须归因为 type，而不是普通 data 变化
  const typeBefore = normalizeSnapshot({ root: 'HKCU\\A', exists: true, values: { v: { type: 'REG_SZ', data: 'x' } } })
  const typeAfter = normalizeSnapshot({ root: 'HKCU\\A', exists: true, values: { v: { type: 'REG_BINARY', data: Buffer.from([0x78, 0x00]) } } })
  const typeDiff = diffSnapshots(typeBefore, typeAfter)
  if (PLANT) {
    // 故意漏报：把 type 变化从差异里抹掉（模拟"只比较 data 的十六进制"这个真实会犯的错）
    typeDiff.changes = typeDiff.changes.filter((c) => c.reason !== 'type')
  }
  check(
    '值类型变化被检出且 reason=type',
    typeDiff.changes.some((c) => c.kind === 'value-changed' && c.valueName === 'v' && c.reason === 'type'),
    safeJson(typeDiff.changes),
  )

  // 可读 → 拒绝访问：这是"有人改了它的安全描述符"的最强信号，绝不能报成空差异
  const readable = normalizeSnapshot({ root: 'HKCU\\A', exists: true, values: { v: { type: 'REG_SZ', data: 'x' } } })
  const locked = normalizeSnapshot({ root: 'HKCU\\A', exists: true, accessDenied: true })
  const lockDiff = diffSnapshots(readable, locked)
  check(
    '可读 → 拒绝访问 必须产生 key-access-changed（不能报空差异）',
    lockDiff.changes.some((c) => c.kind === 'key-access-changed'),
    safeJson(lockDiff.changes),
  )

  // 键从不存在 → 出现
  const absent = normalizeSnapshot({ root: 'HKCU\\A', exists: false })
  const present = normalizeSnapshot({ root: 'HKCU\\A', exists: true })
  check('key-created 被检出', diffSnapshots(absent, present).changes.some((c) => c.kind === 'key-created'), 'ok')
  check('key-deleted 被检出', diffSnapshots(present, absent).changes.some((c) => c.kind === 'key-deleted'), 'ok')

  check('无变化时 changes 为空数组', diffSnapshots(before, before).changes.length === 0, String(diffSnapshots(before, before).changes.length))
  checkThrows('比较不同 root 的快照时抛错（无意义的比较必须拒绝）', () => diffSnapshots(before, normalizeSnapshot({ root: 'HKCU\\Other', exists: true })), 'REG_DIFF_ROOT_MISMATCH')
}

section('5. 回滚计划（必须如实标注不可逆项）')
{
  const before = normalizeSnapshot({
    root: 'HKCU\\Software\\T',
    exists: true,
    values: { changed: { type: 'REG_SZ', data: 'old' }, removed: { type: 'REG_DWORD', data: 1 } },
    sddl: 'D:(A;;KA;;;SY)',
  })
  const after = normalizeSnapshot({
    root: 'HKCU\\Software\\T',
    exists: true,
    values: { changed: { type: 'REG_SZ', data: 'new' }, added: { type: 'REG_DWORD', data: 7 } },
    sddl: 'D:(A;;KA;;;BA)',
  })
  const { changes } = diffSnapshots(before, after)
  const plan = planRollback(changes, { rootPath: 'HKCU\\Software\\T' })

  check('value-added → delete-value（EXACT）', plan.operations.some((op) => op.op === 'delete-value' && op.valueName === 'added' && op.reversibility === REVERSIBILITY.EXACT), safeJson(plan.operations.map((o) => `${o.op}/${o.reversibility}`)))
  check('value-changed → set-value（EXACT，带回原值）', plan.operations.some((op) => op.op === 'set-value' && op.valueName === 'changed' && op.reversibility === REVERSIBILITY.EXACT), 'ok')
  check('value-deleted → set-value（EXACT，带回原值）', plan.operations.some((op) => op.op === 'set-value' && op.valueName === 'removed' && op.type === 'REG_DWORD'), 'ok')
  check('security-changed → restore-sddl（EXACT）', plan.operations.some((op) => op.op === 'restore-sddl' && op.reversibility === REVERSIBILITY.EXACT && op.sddl === 'D:(A;;KA;;;SY)'), 'ok')
  check('统计：exact=4, lossy=0, impossible=0', plan.exact === 4 && plan.lossy === 0 && plan.impossible === 0, safeJson({ exact: plan.exact, lossy: plan.lossy, impossible: plan.impossible }))
  check('执行顺序：删除类在写入类之前（避免刚写回就被删）', (() => {
    const order = { 'delete-value': 0, 'delete-key': 1, 'recreate-key': 2, 'set-value': 3, 'restore-sddl': 4 }
    // 测试缺陷（阶段 B 实测暴露）：初版写的是 `order[op]`，而回调参数 `op` 是**操作对象**不是操作名，
    // 于是 `order[op]` 恒为 `undefined`、`0 <= undefined` 恒为 false —— 这条断言**永远红**，
    // 无论实现顺序对不对。正确的索引是 `op.op`。
    return plan.operations.every((op, index) => index === 0 || order[plan.operations[index - 1].op] <= order[op.op])
  })(), plan.operations.map((o) => o.op).join(','))
  check('HKCU 的操作不标 needsElevation', plan.operations.every((op) => op.needsElevation === false), safeJson(plan.operations.map((o) => o.needsElevation)))

  // HKLM → needsElevation=true；键被删除 → IMPOSSIBLE 且有 warning
  const hklmBefore = normalizeSnapshot({ root: 'HKLM\\SOFTWARE\\X', exists: false })
  const hklmAfter = normalizeSnapshot({ root: 'HKLM\\SOFTWARE\\X', exists: true, values: { v: { type: 'REG_DWORD', data: 1 } } })
  const hklmPlan = planRollback(diffSnapshots(hklmBefore, hklmAfter).changes, { rootPath: 'HKLM\\SOFTWARE\\X' })
  check('HKLM 的操作标 needsElevation=true', hklmPlan.operations.every((op) => op.needsElevation === true), safeJson(hklmPlan.operations.map((o) => o.needsElevation)))

  const deletedPlan = planRollback(diffSnapshots(hklmAfter, hklmBefore).changes, { rootPath: 'HKLM\\SOFTWARE\\X' })
  check(
    'key-deleted → recreate-key 标 IMPOSSIBLE（内容不可恢复，不许粉饰）',
    deletedPlan.operations.some((op) => op.op === 'recreate-key' && op.reversibility === REVERSIBILITY.IMPOSSIBLE),
    safeJson(deletedPlan.operations.map((o) => `${o.op}/${o.reversibility}`)),
  )
  check('IMPOSSIBLE 必然带 warning', deletedPlan.warnings.some((w) => /不可恢复|IMPOSSIBLE/.test(w)), deletedPlan.warnings.join(' | ').slice(0, 140))
  check('impossible 计数正确', deletedPlan.impossible === 1, String(deletedPlan.impossible))

  // accessDenied 且无原始 SDDL → restore-sddl 必须标 IMPOSSIBLE
  const readable = normalizeSnapshot({ root: 'HKCU\\A', exists: true })
  const locked = normalizeSnapshot({ root: 'HKCU\\A', exists: true, accessDenied: true })
  const aclPlan = planRollback(diffSnapshots(readable, locked).changes, { rootPath: 'HKCU\\A' })
  check(
    '"可读 → 拒绝访问"且无原始 SDDL 时，restore-sddl 标 IMPOSSIBLE',
    aclPlan.operations.some((op) => op.op === 'restore-sddl' && op.reversibility === REVERSIBILITY.IMPOSSIBLE),
    safeJson(aclPlan.operations.map((o) => `${o.op}/${o.reversibility}`)),
  )
  check('并且给出 warning', aclPlan.warnings.some((w) => /SDDL|无法还原/.test(w)), aclPlan.warnings.join(' | ').slice(0, 140))

  checkThrows('未知变更类别抛错', () => planRollback([{ kind: 'nonsense', key: 'HKCU\\A' }]), 'REG_ROLLBACK_INVALID')
  checkThrows('变更项缺少 key 路径时抛错', () => planRollback([{ kind: 'value-added' }]), 'REG_ROLLBACK_INVALID')
}

section('6. 注册表 ACL：只出计划，不执行')
{
  const plan = planAclRestriction({
    keys: ['HKCU\\Software\\X', 'HKLM\\SOFTWARE\\Y'],
    principal: 'appcontainer',
    principalSid: 'S-1-15-2-1-2-3-4-5-6-7',
    access: REG_ACCESS.KEY_READ,
    backupPath: 'C:\\stage\\registry-sddl-backup.json',
  })
  check('产出两步（两个键）', plan.steps.length === 2, String(plan.steps.length))
  check('access 名字被解析为 KEY_READ', plan.steps[0].accessName === 'KEY_READ', plan.steps[0].accessName)
  check('**绝不使用 Deny ACE**（deny 优先且会连带拒绝宿主自身）', plan.steps.every((step) => step.useDenyAce === false), safeJson(plan.steps.map((s) => s.useDenyAce)))
  check('**强制要求先落盘原始 SDDL**', plan.steps.every((step) => step.requireBackup === true && step.backupPath === 'C:\\stage\\registry-sddl-backup.json'), 'requireBackup=true')
  check('回滚操作名固定为 restore-sddl', plan.steps.every((step) => step.restoreOp === 'restore-sddl'), 'restore-sddl')
  check('HKLM 项标 needsElevation=true，HKCU 项为 false', plan.steps[0].needsElevation === false && plan.steps[1].needsElevation === true, safeJson(plan.steps.map((s) => s.needsElevation)))
  check('总体 requiresElevation=true', plan.requiresElevation === true, String(plan.requiresElevation))
  check(
    '计划自带"这只是计划"与"ACL 不是硬边界（属主可夺回）"两条警告',
    plan.warnings.some((w) => /PLAN ONLY/.test(w)) && plan.warnings.some((w) => /hard boundary|WRITE_OWNER/.test(w)),
    plan.warnings.length + ' 条',
  )
  checkThrows('缺少 backupPath 时抛错（不允许"先改了再想备份"）', () => planAclRestriction({ keys: ['HKCU\\A'], principal: 'appcontainer', principalSid: 'S-1-15-2-1', backupPath: '' }), 'REG_ACL_PLAN_INVALID')
  checkThrows('未知 principal 抛错', () => planAclRestriction({ keys: ['HKCU\\A'], principal: 'everyone', principalSid: 'S-1-1-0', backupPath: 'x' }), 'REG_ACL_PLAN_INVALID')
  checkThrows('keys 为空抛错', () => planAclRestriction({ keys: [], principal: 'appcontainer', principalSid: 'S-1-15-2-1', backupPath: 'x' }), 'REG_ACL_PLAN_INVALID')
}

section('7. RegistryGuard 门面：采集失败绝不等于"没变化"')
{
  // 确定性替身：逐字段对齐真实语义，且**不更好用** ——
  // 它保留"RegOpenKeyExW 返回 2 = 不存在"与"返回 5 = 拒绝访问"是两种不同结果这一点。
  function makeReader(sequence) {
    let index = 0
    return {
      read(path) {
        const entry = sequence[Math.min(index, sequence.length - 1)]
        index += 1
        if (typeof entry === 'function') return entry(path)
        return entry
      },
      get calls() {
        return index
      },
    }
  }

  const before = { exists: true, subKeys: [], values: { a: { type: 'REG_DWORD', data: 1 } } }
  const after = { exists: true, subKeys: [], values: { a: { type: 'REG_DWORD', data: 2 } } }
  const reader = makeReader([before, after])
  const guard = new RegistryGuard(reader, { namespaces: [{ root: 'HKCU\\Software\\T' }] })
  guard.markBefore()
  const report = guard.markAfter()
  check('报告合计 1 项变化', report.totalChanges === 1, String(report.totalChanges))
  check('verdict = changed-reversible', report.verdict === 'changed-reversible', report.verdict)
  check('report 带"这是检测而非硬边界"的说明', /DETECTION, not a hard boundary/.test(report.note), report.note.slice(0, 90))
  const change = report.roots['HKCU\\Software\\T'].changes[0]
  check('变化细节包含 before/after 原值', change.before.data === '0x00000001' && change.after.data === '0x00000002', safeJson(change))

  // 无变化
  const sameReader = makeReader([before, before])
  const guard2 = new RegistryGuard(sameReader, { namespaces: [{ root: 'HKCU\\Software\\T' }] })
  guard2.markBefore()
  const report2 = guard2.markAfter()
  check('无变化时 verdict = no-observed-change', report2.verdict === 'no-observed-change', report2.verdict)
  check('无变化时 totalChanges = 0', report2.totalChanges === 0, String(report2.totalChanges))

  // 不可逆变化 → verdict 必须反映出来
  const deletedReader = makeReader([
    { exists: true, subKeys: ['child'], values: {} },
    { exists: true, subKeys: [], values: {} },
  ])
  const guard3 = new RegistryGuard(deletedReader, { namespaces: [{ root: 'HKCU\\Software\\T' }] })
  guard3.markBefore()
  const report3 = guard3.markAfter()
  check('存在不可逆项时 verdict = changed-not-fully-reversible', report3.verdict === 'changed-not-fully-reversible', report3.verdict)
  check('不可逆项计入 rollback.impossible', report3.rollback.impossible >= 1, String(report3.rollback.impossible))

  // reader 返回 null/undefined → 必须抛错，**不能**当成"没变化"
  const nullReader = makeReader([null])
  const guard4 = new RegistryGuard(nullReader, { namespaces: [{ root: 'HKCU\\Software\\T' }] })
  checkThrows(
    'reader 返回 null 时抛错（空结果不是拒绝、也不是"没变化"）',
    () => guard4.markBefore(),
    'REG_READ_EMPTY',
  )
  const undefinedReader = makeReader([undefined])
  const guard5 = new RegistryGuard(undefinedReader, { namespaces: [{ root: 'HKCU\\Software\\T' }] })
  checkThrows('reader 返回 undefined 时抛错', () => guard5.markBefore(), 'REG_READ_EMPTY')

  checkThrows('未 markBefore 就 markAfter 时抛错', () => new RegistryGuard(makeReader([before]), { namespaces: [{ root: 'HKCU\\A' }] }).markAfter(), 'REG_ORDER_VIOLATION')
  checkThrows('未采集就 report 时抛错', () => new RegistryGuard(makeReader([before]), { namespaces: [{ root: 'HKCU\\A' }] }).report(), 'REG_ORDER_VIOLATION')
  checkThrows('缺少 reader 时构造抛错', () => new RegistryGuard({}, { namespaces: [{ root: 'HKCU\\A' }] }), 'REG_READER_MISSING')
  checkThrows('缺少 namespaces 时构造抛错', () => new RegistryGuard(makeReader([before]), {}), 'REG_NAMESPACES_MISSING')
  checkThrows('namespaces 里有非法根键时构造即抛错（早失败）', () => new RegistryGuard(makeReader([before]), { namespaces: [{ root: 'Software\\X' }] }), 'REG_HIVE_UNKNOWN')
}

section('8. 运行期 reader 的调用契约（用替身验证状态码语义）')
{
  const calls = []
  const bindings = {
    regOpenKeyExW(handle, subKey, options, sam) {
      calls.push(['open', subKey, sam])
      if (subKey === 'Software\\Denied') return { status: REG_STATUS.ERROR_ACCESS_DENIED }
      if (subKey === 'Software\\Missing') return { status: REG_STATUS.ERROR_FILE_NOT_FOUND }
      return { status: 0, handle: 0x77n }
    },
    regEnumKeyExW(handle, index) {
      if (index === 0) return { status: 0, name: 'child' }
      return { status: REG_STATUS.ERROR_NO_MORE_ITEMS }
    },
    regEnumValueW(handle, index) {
      if (index === 0) return { status: 0, name: 'v', type: 'REG_DWORD', data: 9 }
      return { status: REG_STATUS.ERROR_NO_MORE_ITEMS }
    },
    regCloseKey(handle) {
      calls.push(['close', handle])
    },
    regGetKeySecurity() {
      return { sddl: 'D:(A;;KA;;;SY)' }
    },
  }
  const reader = createRegistryReader(bindings)
  const ok = reader.read('HKCU\\Software\\Ok')
  check('成功读取：exists=true 且拿到子键与值', ok.exists === true && ok.subKeys[0] === 'child' && ok.values.v.data === 9, safeJson(ok))
  check('把 READ_CONTROL 一起请求（回滚要靠 SDDL）', (calls[0][2] & REG_ACCESS.READ_CONTROL) !== 0, `0x${calls[0][2].toString(16)}`)
  check('句柄被关闭', calls.some((c) => c[0] === 'close' && c[1] === 0x77n), safeJson(calls.filter((c) => c[0] === 'close')))
  check('SDDL 被带回', ok.sddl === 'D:(A;;KA;;;SY)', String(ok.sddl))

  const denied = reader.read('HKCU\\Software\\Denied')
  check('拒绝访问 → accessDenied=true（不是 exists=false）', denied.accessDenied === true && denied.exists === true, safeJson(denied))
  const missing = reader.read('HKCU\\Software\\Missing')
  check('不存在 → exists=false 且 accessDenied=false', missing.exists === false && missing.accessDenied === false, safeJson(missing))
  checkThrows('缺少 regOpenKeyExW 绑定时构造抛错', () => createRegistryReader({}), 'REG_BINDINGS_MISSING')
  checkThrows(
    '其它错误码（非 2/3/5）必须上抛，不能当成"不存在"',
    () => createRegistryReader({ ...bindings, regOpenKeyExW: () => ({ status: 87 }) }).read('HKCU\\A'),
    'REG_OPEN_FAILED',
  )
}

section('8b. T3：registry-guard 导出的编解码出口（暂存层复用同一套，不许两处漂移）')
{
  check(
    'encodeRegistryValue / decodeRegistryValue 与 normalizeSnapshot 逐字同源（REG_SZ 抽查）',
    encodeRegistryValue('REG_SZ', 'x') === Buffer.from('x\u0000', 'utf16le').toString('hex') &&
      decodeRegistryValue('REG_SZ', encodeRegistryValue('REG_SZ', 'x'), 'v') === 'x',
    `${encodeRegistryValue('REG_SZ', 'x')}`,
  )
  check(
    '类型可用名字（大小写不敏感）或 winreg.h 数值给出',
    registryTypeName('reg_dword') === 'REG_DWORD' && registryTypeName(4) === 'REG_DWORD' && registryTypeName(REG_TYPES.REG_QWORD) === 'REG_QWORD',
    `${registryTypeName('reg_dword')}/${registryTypeName(4)}`,
  )
  checkThrows('未知类型数值抛 REG_TYPE_UNKNOWN（不猜类型）', () => registryTypeName(99), 'REG_TYPE_UNKNOWN')
  checkThrows('未知类型名抛 REG_TYPE_UNKNOWN', () => registryTypeName('REG_MAGIC'), 'REG_TYPE_UNKNOWN')
  checkThrows('合法但无编解码器的类型抛 REG_TYPE_UNSUPPORTED（与"未知"分开）', () => encodeRegistryValue('REG_LINK', 'x'), 'REG_TYPE_UNSUPPORTED')
  checkThrows('解码侧同样抛 REG_TYPE_UNSUPPORTED', () => decodeRegistryValue('REG_LINK', '00', 'v'), 'REG_TYPE_UNSUPPORTED')
  checkThrows('解码非十六进制文本抛 REG_SNAPSHOT_INVALID（F8 口径被出口继承）', () => decodeRegistryValue('REG_BINARY', 'hello', 'v'), 'REG_SNAPSHOT_INVALID')
  check(
    '零长度 REG_NONE 合法（winreg.h 允许无类型数据；编码器对空 Buffer 就产出空串）',
    encodeRegistryValue('REG_NONE', Buffer.alloc(0)) === '' && decodeRegistryValue('REG_NONE', '', 'v') === '',
    'empty REG_NONE round-trips',
  )
  check(
    'REG_STATUS 追加的两个码是 winerror.h 的值（暂存层要用它们如实表达两种失败）',
    REG_STATUS.ERROR_KEY_HAS_CHILDREN === 1020 && REG_STATUS.ERROR_SHARING_VIOLATION === 32,
    `${REG_STATUS.ERROR_KEY_HAS_CHILDREN}/${REG_STATUS.ERROR_SHARING_VIOLATION}`,
  )
}

runRegistryStageChecks({ check, checkThrows, section, safeJson })

// T3 符合性：真实 DLL / 真实 WAL / 真实闭环节报告。DLL 存在时**强制**（缺一即红）。
await runRegistryConformanceChecks({ check, checkThrows, section, skip })

section('9. 现状声明（不得被读成"注册表已被隔离"）')
check(
  '本模块定位为**检测**而非硬边界（报告 note 里逐字声明）',
  true,
  'registry-guard is DETECTION, not a hard boundary',
)
check(
  'ACL 方案只产出计划、不执行（无任何 RegSetKeySecurity 调用）',
  true,
  'planAclRestriction 返回纯数据；本模块不 import 任何 Win32',
)
check(
  'AppContainer 方案（注册表天然受限）**现在能建 profile 了，但隔离未生效** ⇒ 仍不可用',
  true,
  '[实测] 阶段 A：hr=0x80070005（受限令牌）；阶段 B：hr=0x0 但子进程不在 AppContainer 里 —— .t/sbx3/dev/raw-probe-ac-token.txt',
)

W('')
W('='.repeat(72))
W(
  PLANT
    ? `registry-guard 测试（--plant 模式，应当失败）：断言 ${assertions} 项，失败 ${failures} 项，跳过 ${skips} 项`
    : `registry-guard 测试：断言 ${assertions} 项，失败 ${failures} 项，跳过 ${skips} 项`,
)
if (skips > 0) {
  W(`（跳过 ${skips} 项 ≠ 通过：原因见上方 SKIP 行。真实产物缺失时符合性无法判定。）`)
}
W('='.repeat(72))
process.exit(failures ? 1 : 0)
