/**
 * WFP 结构体布局与参数构造的确定性测试
 * （**不需要管理员权限、不需要真实 WFP、不触碰任何系统状态**）
 *
 * 存在理由：`src/wfp.mjs` 的运行期在本机**无法实测** ——
 * `[实测]`（阶段 A，受限令牌）`FwpmEngineOpen0` 返回 `0x32`（Win32 50 `ERROR_NOT_SUPPORTED`），
 * 也就是说连"打开引擎"这一步都做不到。**阶段 B 更正**：High IL 管理员令牌下
 * `FwpmEngineOpen0(NULL, RPC_C_AUTHN_WINNT, …)` 返回 **`0x0`**（`0x32` 只在
 * `authn = RPC_C_AUTHN_NONE(0)` 时出现，而那不是合法的 `authnService`）——
 * 见 `.t/sbx3/dev/raw-probe-wfp-runtime.txt`。但**装过滤器仍然未获授权、未实测**。
 * 而布局错误是本项目已经踩过两次的一类缺陷
 * （缺陷 5：Job 结构体偏移错 4 字节；缺陷 13：漏 `CREATE_UNICODE_ENVIRONMENT`），
 * 这类错误**完全可以用合成缓冲区离线测出来**。
 *
 * 因此本文件只做一件事：把 `FWPM_FILTER0` / `FWPM_SUBLAYER0` / `FWPM_SESSION0` /
 * `FWPM_FILTER_CONDITION0` / `FWPM_ACTION0` / `FWPM_DISPLAY_DATA0` / `FWP_VALUE0` /
 * `FWP_CONDITION_VALUE0` / `FWP_BYTE_BLOB` 的大小与偏移钉死，
 * 并验证 GUID 编解码、参数构造与 fail-closed 路径。
 * **运行期行为仍标注为未实测。**
 *
 * 用法：
 *   node tests\wfp-layout.mjs            # 正常运行，应当全绿
 *   node tests\wfp-layout.mjs --plant    # 故意破坏一处布局（用于证明判定可失败）
 */

import {
  FWP_DATA_TYPE,
  FWP_MATCH_TYPE,
  FWP_ACTION_TYPE,
  FWPM_SUBLAYER_FLAG_PERSISTENT,
  FWPM_SESSION_FLAG_DYNAMIC,
  FWP_BYTE_BLOB_SIZE,
  OFF_BYTE_BLOB,
  FWP_VALUE0_SIZE,
  OFF_VALUE,
  FWP_CONDITION_VALUE0_SIZE,
  OFF_CONDITION_VALUE,
  FWPM_DISPLAY_DATA0_SIZE,
  OFF_DISPLAY_DATA,
  FWPM_ACTION0_SIZE,
  OFF_ACTION,
  FWPM_FILTER_CONDITION0_SIZE,
  OFF_FILTER_CONDITION,
  FWPM_SUBLAYER0_SIZE,
  OFF_SUBLAYER,
  FWPM_SESSION0_SIZE,
  OFF_SESSION,
  FWPM_FILTER0_SIZE,
  OFF_FILTER,
  parseGuid,
  formatGuid,
  coerceGuid,
  writePointer,
  encodeWideString,
  buildValue0,
  buildConditionValue0,
  buildDisplayData0,
  buildAction0,
  buildFilterCondition0,
  buildFilterConditionArray,
  buildFilter0,
  buildSubLayer0,
  buildSession0,
  buildByteBlob,
  stableRuleKey,
  planOfflineRules,
  describeWfpStatus,
  probeWfpAvailability,
  openEngine,
  installSubLayer,
  addFilter,
  deleteFilterById,
  applyOfflinePlan,
} from '../src/wfp.mjs'

const PLANT = process.argv.includes('--plant')

const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0

/** 断言：把每一个断言都计数，便于在报告里给出"断言数" */
function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`${condition ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}

/** 断言"必须抛错"：这是**永久负例**，实现退化成"静默接受"时会红 */
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
    W(`  ${ok ? '✓' : '✗'} ${name}\n      证据: code=${error.code ?? '(none)'} message=${String(error.message).slice(0, 140)}`)
    return error
  }
}

function section(title) {
  W('')
  W(`=== ${title} ===`)
}

// [官方] 结构体声明见 src/wfp.mjs 顶部的 URL 列表。
// [推断] 大小/偏移按 x64 Windows psABI（GUID=16/align8；指针=8/align8；UINT32=4/align4；
//        UINT16=2/align2；结构体对齐=最大成员对齐）推导。
// 这些数值必须由 SDK 的 sizeof/offsetof 复核；本测试把它们钉死，错了就红。

// ── 故意破坏（--plant）──────────────────────────────────────────────────────
// 破坏对象选 OFF_FILTER.filterCondition（真实缺陷 5 的同类：偏移差 4 字节）。
// 这里**只改本地镜像常量**，不改 src/wfp.mjs —— 测试必须能在不修改被测代码的前提下失败。
const PLANT_SHIFT = PLANT ? 4 : 0
const PLANTED = Object.freeze({
  ...OFF_FILTER,
  filterCondition: OFF_FILTER.filterCondition + PLANT_SHIFT,
  action: OFF_FILTER.action + PLANT_SHIFT,
})

if (PLANT) {
  W('*** --plant 模式：故意把 OFF_FILTER.filterCondition/action 各后移 4 字节，断言应当失败 ***')
}

section('1. 各结构体大小（钉死，必须与 sizeof 一致）')
check('FWP_BYTE_BLOB = 16（size 4 + pad 4 + 指针 8）', FWP_BYTE_BLOB_SIZE === 16, String(FWP_BYTE_BLOB_SIZE))
check('FWP_VALUE0 = 16（type 4 + pad 4 + union 8）', FWP_VALUE0_SIZE === 16, String(FWP_VALUE0_SIZE))
check('FWP_CONDITION_VALUE0 = 16（与 FWP_VALUE0 同形）', FWP_CONDITION_VALUE0_SIZE === 16, String(FWP_CONDITION_VALUE0_SIZE))
check('FWPM_DISPLAY_DATA0 = 16（两个 wchar_t*）', FWPM_DISPLAY_DATA0_SIZE === 16, String(FWPM_DISPLAY_DATA0_SIZE))
check(
  'FWPM_ACTION0 = 24（不是 20：官方把 union 写成 GUID(16)，且从 FWPM_FILTER0 的字段偏移反推 action 必须占 24）',
  FWPM_ACTION0_SIZE === 24,
  String(FWPM_ACTION0_SIZE),
)
check('FWPM_FILTER_CONDITION0 = 40（GUID 16 + UINT32 4 + pad 4 + VALUE 16）', FWPM_FILTER_CONDITION0_SIZE === 40, String(FWPM_FILTER_CONDITION0_SIZE))
check('FWPM_SUBLAYER0 = 72', FWPM_SUBLAYER0_SIZE === 72, String(FWPM_SUBLAYER0_SIZE))
check('FWPM_SESSION0 = 72（推断的保守上界；见 src/wfp.mjs 注释）', FWPM_SESSION0_SIZE === 72, String(FWPM_SESSION0_SIZE))
check('FWPM_FILTER0 = 192', FWPM_FILTER0_SIZE === 192, String(FWPM_FILTER0_SIZE))

section('2. 字段偏移（钉死，必须与 offsetof 一致）')
check('FWP_BYTE_BLOB: size@0, data@8', OFF_BYTE_BLOB.size === 0 && OFF_BYTE_BLOB.data === 8, JSON.stringify(OFF_BYTE_BLOB))
check('FWP_VALUE0: type@0, value@8', OFF_VALUE.type === 0 && OFF_VALUE.value === 8, JSON.stringify(OFF_VALUE))
check('FWP_CONDITION_VALUE0: type@0, value@8', OFF_CONDITION_VALUE.type === 0 && OFF_CONDITION_VALUE.value === 8, JSON.stringify(OFF_CONDITION_VALUE))
check('FWPM_DISPLAY_DATA0: name@0, description@8', OFF_DISPLAY_DATA.name === 0 && OFF_DISPLAY_DATA.description === 8, JSON.stringify(OFF_DISPLAY_DATA))
check('FWPM_ACTION0: type@0, GUID@8', OFF_ACTION.type === 0 && OFF_ACTION.filterTypeOrCalloutKey === 8, JSON.stringify(OFF_ACTION))
check(
  'FWPM_FILTER_CONDITION0: fieldKey@0, matchType@16, conditionValue@24',
  OFF_FILTER_CONDITION.fieldKey === 0 && OFF_FILTER_CONDITION.matchType === 16 && OFF_FILTER_CONDITION.conditionValue === 24,
  JSON.stringify(OFF_FILTER_CONDITION),
)
check(
  'FWPM_SUBLAYER0: subLayerKey@0, displayData@16, flags@32, providerKey@40, providerData@48, weight@64',
  OFF_SUBLAYER.subLayerKey === 0 &&
    OFF_SUBLAYER.displayData === 16 &&
    OFF_SUBLAYER.flags === 32 &&
    OFF_SUBLAYER.providerKey === 40 &&
    OFF_SUBLAYER.providerData === 48 &&
    OFF_SUBLAYER.weight === 64,
  JSON.stringify(OFF_SUBLAYER),
)
check(
  'FWPM_SESSION0: sessionKey@0, displayData@16, flags@32, txnWaitTimeout@36, processId@40, sid@48, username@56, kernelMode@64',
  OFF_SESSION.sessionKey === 0 &&
    OFF_SESSION.displayData === 16 &&
    OFF_SESSION.flags === 32 &&
    OFF_SESSION.txnWaitTimeoutInMSec === 36 &&
    OFF_SESSION.processId === 40 &&
    OFF_SESSION.sid === 48 &&
    OFF_SESSION.username === 56 &&
    OFF_SESSION.kernelMode === 64,
  JSON.stringify(OFF_SESSION),
)
check(
  'FWPM_FILTER0: filterKey@0, displayData@16, flags@32, providerKey@40, providerData@48, layerKey@64, subLayerKey@80',
  PLANTED.filterKey === 0 &&
    PLANTED.displayData === 16 &&
    PLANTED.flags === 32 &&
    PLANTED.providerKey === 40 &&
    PLANTED.providerData === 48 &&
    PLANTED.layerKey === 64 &&
    PLANTED.subLayerKey === 80,
  JSON.stringify(PLANTED),
)
check(
  'FWPM_FILTER0: weight@96, numFilterConditions@112, filterCondition@120',
  PLANTED.weight === 96 && PLANTED.numFilterConditions === 112 && PLANTED.filterCondition === 120,
  `weight=${PLANTED.weight} count=${PLANTED.numFilterConditions} conditions=${PLANTED.filterCondition}`,
)
check(
  'FWPM_FILTER0: action@128, rawContext/providerContextKey@152, reserved@160, filterId@168, effectiveWeight@176',
  PLANTED.action === 128 &&
    PLANTED.rawContextOrProviderContextKey === 152 &&
    PLANTED.reserved === 160 &&
    PLANTED.filterId === 168 &&
    PLANTED.effectiveWeight === 176,
  JSON.stringify(PLANTED),
)

section('3. 布局自洽（每个字段都必须完整落在结构体之内）')
{
  const layouts = [
    ['FWP_BYTE_BLOB', FWP_BYTE_BLOB_SIZE, { size: 4, data: 8 }, OFF_BYTE_BLOB],
    ['FWP_VALUE0', FWP_VALUE0_SIZE, { type: 4, value: 8 }, OFF_VALUE],
    ['FWP_CONDITION_VALUE0', FWP_CONDITION_VALUE0_SIZE, { type: 4, value: 8 }, OFF_CONDITION_VALUE],
    ['FWPM_DISPLAY_DATA0', FWPM_DISPLAY_DATA0_SIZE, { name: 8, description: 8 }, OFF_DISPLAY_DATA],
    ['FWPM_ACTION0', FWPM_ACTION0_SIZE, { type: 4, guid: 16 }, OFF_ACTION],
  ]
  for (const [name, size, widths, offsets] of layouts) {
    const entries = Object.entries(offsets)
    const ok = entries.every(([field], index) => offsets[field] + Object.values(widths)[index] <= size)
    check(`${name}: 所有字段 + 宽度 <= ${size}`, ok, entries.map(([field]) => `${field}@${offsets[field]}`).join(' '))
  }
  check(
    'FWPM_SESSION0: kernelMode@64 + 4 <= 72',
    OFF_SESSION.kernelMode + 4 <= FWPM_SESSION0_SIZE,
    `${OFF_SESSION.kernelMode}+4 vs ${FWPM_SESSION0_SIZE}`,
  )
  check(
    'FWPM_FILTER0: effectiveWeight@176 + 16 === 192（结构体恰好填满）',
    PLANTED.effectiveWeight + FWP_VALUE0_SIZE === FWPM_FILTER0_SIZE,
    `${PLANTED.effectiveWeight}+${FWP_VALUE0_SIZE} vs ${FWPM_FILTER0_SIZE}`,
  )
  check(
    'FWPM_FILTER0: action 之后必须留给 rawContext@152 —— 128 + sizeof(action) 补齐到 8 必须 <= 152，且 sizeof(action) >= 20',
    FWPM_ACTION0_SIZE >= 20 && 128 + FWPM_ACTION0_SIZE <= 152 && (128 + FWPM_ACTION0_SIZE) % 8 === 0,
    `128 + ${FWPM_ACTION0_SIZE} = ${128 + FWPM_ACTION0_SIZE}`,
  )
  check(
    'FWPM_FILTER0: 每个字段起始偏移都是其自然对齐的倍数',
    [
      [PLANTED.filterKey, 8],
      [PLANTED.displayData, 8],
      [PLANTED.flags, 4],
      [PLANTED.providerKey, 8],
      [PLANTED.providerData, 8],
      [PLANTED.layerKey, 8],
      [PLANTED.subLayerKey, 8],
      [PLANTED.weight, 8],
      [PLANTED.numFilterConditions, 4],
      [PLANTED.filterCondition, 8],
      [PLANTED.action, 4],
      [PLANTED.rawContextOrProviderContextKey, 8],
      [PLANTED.reserved, 8],
      [PLANTED.filterId, 8],
      [PLANTED.effectiveWeight, 8],
    ].every(([offset, align]) => offset % align === 0),
    '全部通过',
  )
  check(
    'FWPM_FILTER0: 字段不重叠（按偏移排序后前一个的末端 <= 后一个的起点）',
    (() => {
      const spans = [
        [PLANTED.filterKey, 16],
        [PLANTED.displayData, 16],
        [PLANTED.flags, 4],
        [PLANTED.providerKey, 8],
        [PLANTED.providerData, 16],
        [PLANTED.layerKey, 16],
        [PLANTED.subLayerKey, 16],
        [PLANTED.weight, 16],
        [PLANTED.numFilterConditions, 4],
        [PLANTED.filterCondition, 8],
        [PLANTED.action, FWPM_ACTION0_SIZE],
        [PLANTED.rawContextOrProviderContextKey, 8],
        [PLANTED.reserved, 8],
        [PLANTED.filterId, 8],
        [PLANTED.effectiveWeight, 16],
      ].sort((a, b) => a[0] - b[0])
      return spans.every((span, index) => index === 0 || spans[index - 1][0] + spans[index - 1][1] <= span[0])
    })(),
    '全部通过',
  )
}

section('4. GUID 编解码（[官方] Data1/2/3 小端，Data4 原序）')
{
  const text = 'c38d57d1-05a7-4c33-904f-7fbceee60e82'
  const buffer = parseGuid(text)
  check('parseGuid 返回 16 字节', Buffer.isBuffer(buffer) && buffer.length === 16, `${buffer.length} 字节`)
  check(
    'Data1 小端：字节序为 d1 57 8d c3',
    buffer.subarray(0, 4).toString('hex') === 'd1578dc3',
    buffer.subarray(0, 4).toString('hex'),
  )
  check('Data2 小端：字节序为 a7 05', buffer.subarray(4, 6).toString('hex') === 'a705', buffer.subarray(4, 6).toString('hex'))
  check('Data3 小端：字节序为 33 4c', buffer.subarray(6, 8).toString('hex') === '334c', buffer.subarray(6, 8).toString('hex'))
  check(
    'Data4 原序：字节序为 90 4f 7f bc ee e6 0e 82',
    buffer.subarray(8, 16).toString('hex') === '904f7fbceee60e82',
    buffer.subarray(8, 16).toString('hex'),
  )
  check('formatGuid(parseGuid(x)) === x', formatGuid(buffer) === text, formatGuid(buffer))
  check('parseGuid 接受大写与花括号', formatGuid(parseGuid('{C38D57D1-05A7-4C33-904F-7FBCEEE60E82}')) === text, 'ok')
  const zero = formatGuid(Buffer.alloc(16))
  check('全零 GUID 格式化为 IID_NULL 文本', zero === '00000000-0000-0000-0000-000000000000', zero)
  check(
    'parseGuid 拒绝长度不足/字符非法的输入（fail-closed）',
    (() => {
      try {
        parseGuid('c38d57d1-05a7-4c33-904f-7fbceee60e8')
        return false
      } catch (error) {
        return error.code === 'WFP_GUID_MALFORMED'
      }
    })(),
    'WFP_GUID_MALFORMED',
  )
  checkThrows('coerceGuid 拒绝长度不为 16 的 Buffer', () => coerceGuid(Buffer.alloc(15), 'layerKey'), 'WFP_GUID_MALFORMED')
  checkThrows('coerceGuid 拒绝 number', () => coerceGuid(123, 'layerKey'), 'WFP_GUID_MALFORMED')
}

section('5. 指针与字符串编码')
{
  const buffer = Buffer.alloc(16)
  writePointer(buffer, 0, 0x1122334455667788n)
  check('writePointer 写 bigint 指针', buffer.readBigUInt64LE(0) === 0x1122334455667788n, `0x${buffer.readBigUInt64LE(0).toString(16)}`)
  writePointer(buffer, 0, null)
  check('writePointer(null) 写全零', buffer.readBigUInt64LE(0) === 0n, '0x0')
  writePointer(buffer, 0, 4096)
  check('writePointer 写 number', buffer.readBigUInt64LE(0) === 4096n, '4096')
  writePointer(buffer, 0, { address: () => 0xabcden })
  check('writePointer 支持 address() 形态的指针对象', buffer.readBigUInt64LE(0) === 0xabcden, '0xabcde')
  checkThrows('writePointer 拒绝 {notAPointer:true}（不猜）', () => writePointer(buffer, 0, { notAPointer: true }), 'WFP_POINTER_INVALID')
  checkThrows('writePointer 拒绝负数 number 指针', () => writePointer(buffer, 0, -1), 'WFP_POINTER_INVALID')
  checkThrows('writePointer 越界时抛错（不静默截断）', () => writePointer(Buffer.alloc(8), 4, 1n), 'WFP_LAYOUT_OVERFLOW')

  const wide = encodeWideString('dsh-stage')
  check(
    'encodeWideString 产出 UTF-16LE + 双字节 NUL',
    wide.toString('hex') === Buffer.from('dsh-stage\u0000', 'utf16le').toString('hex'),
    wide.toString('hex'),
  )
  checkThrows('encodeWideString 拒绝内嵌 NUL', () => encodeWideString('a\u0000b'), 'WFP_STRING_INVALID')
}

section('6. FWP_VALUE0 / FWP_CONDITION_VALUE0（并集成员的内联/指针区分）')
{
  const empty = buildValue0({ type: FWP_DATA_TYPE.FWP_EMPTY })
  check('FWP_EMPTY 产出全零 16 字节', empty.length === 16 && empty.every((byte) => byte === 0), empty.toString('hex'))
  checkThrows('FWP_EMPTY 携带 value 时抛错', () => buildValue0({ type: FWP_DATA_TYPE.FWP_EMPTY, value: 1 }), 'WFP_VALUE_TYPE_INVALID')

  const u8 = buildValue0({ type: FWP_DATA_TYPE.FWP_UINT8, value: 7 })
  check('FWP_UINT8 内联写在偏移 8（低字节）', u8.readUInt8(8) === 7, String(u8.readUInt8(8)))
  const u32 = buildValue0({ type: FWP_DATA_TYPE.FWP_UINT32, value: 0xdeadbeef })
  check('FWP_UINT32 内联小端写在偏移 8', u32.readUInt32LE(8) === 0xdeadbeef, `0x${u32.readUInt32LE(8).toString(16)}`)
  check('type 写在偏移 0', u32.readUInt32LE(0) === FWP_DATA_TYPE.FWP_UINT32, String(u32.readUInt32LE(0)))

  const sid = buildValue0({ type: FWP_DATA_TYPE.FWP_SID, value: 0x1234n })
  check('FWP_SID 是指针成员，写在偏移 8', sid.readBigUInt64LE(8) === 0x1234n, `0x${sid.readBigUInt64LE(8).toString(16)}`)
  checkThrows(
    'FWP_SID 传 null 时抛错（官方："This value cannot be null"）',
    () => buildValue0({ type: FWP_DATA_TYPE.FWP_SID, value: null }),
    'WFP_VALUE_TYPE_INVALID',
  )
  checkThrows(
    'FWP_BYTE_BLOB_TYPE 传原始字符串时抛错（不把字符串当指针）',
    () => buildValue0({ type: FWP_DATA_TYPE.FWP_BYTE_BLOB_TYPE, value: 'nope' }),
    'WFP_POINTER_INVALID',
  )
  checkThrows('未知 type 负数时抛错', () => buildValue0({ type: -1 }), 'WFP_VALUE_TYPE_INVALID')

  const conditionValue = buildConditionValue0({ type: FWP_DATA_TYPE.FWP_SID, value: 0x5678n })
  check('buildConditionValue0 与 buildValue0 同形', conditionValue.length === 16 && conditionValue.readBigUInt64LE(8) === 0x5678n, conditionValue.toString('hex'))
}

section('7. 组合构造（DISPLAY_DATA / ACTION / CONDITION / FILTER / SUBLAYER / SESSION / BLOB）')
{
  const display = buildDisplayData0({ name: 0x11n, description: 0x22n })
  check('buildDisplayData0: name@0, description@8', display.readBigUInt64LE(0) === 0x11n && display.readBigUInt64LE(8) === 0x22n, display.toString('hex'))
  check('buildDisplayData0 允许 description 为 NULL（官方标为 optional）', buildDisplayData0({ name: 0x11n }).readBigUInt64LE(8) === 0n, '0x0')

  const blockAction = buildAction0({ type: FWP_ACTION_TYPE.FWP_ACTION_BLOCK })
  check('buildAction0: type@0', blockAction.readUInt32LE(0) === FWP_ACTION_TYPE.FWP_ACTION_BLOCK, `0x${blockAction.readUInt32LE(0).toString(16)}`)
  check('buildAction0: filterType 默认全零（非 callout 动作）', blockAction.subarray(8, 24).every((byte) => byte === 0), '全零')
  checkThrows('buildAction0 拒绝同时给 filterType 与 calloutKey（union 只能一个）', () => buildAction0({ type: 1, filterType: '00000000-0000-0000-0000-000000000001', calloutKey: '00000000-0000-0000-0000-000000000002' }), 'WFP_ACTION_INVALID')

  const condition = buildFilterCondition0({
    fieldKey: '11111111-2222-3333-4444-555555555555',
    matchType: FWP_MATCH_TYPE.FWP_MATCH_EQUAL,
    conditionValue: buildConditionValue0({ type: FWP_DATA_TYPE.FWP_SID, value: 0x99n }),
  })
  check('buildFilterCondition0 = 40 字节', condition.length === 40, String(condition.length))
  check('fieldKey 小端写在偏移 0', condition.subarray(0, 4).toString('hex') === '11111111', condition.subarray(0, 4).toString('hex'))
  check('matchType 写在偏移 16', condition.readUInt32LE(16) === 0, String(condition.readUInt32LE(16)))
  check('conditionValue.type 写在偏移 24', condition.readUInt32LE(24) === FWP_DATA_TYPE.FWP_SID, String(condition.readUInt32LE(24)))
  check('conditionValue.value 写在偏移 32', condition.readBigUInt64LE(32) === 0x99n, `0x${condition.readBigUInt64LE(32).toString(16)}`)
  checkThrows(
    'buildFilterCondition0 拒绝裸值（必须传 buildConditionValue0 的产物）',
    () => buildFilterCondition0({ fieldKey: '11111111-2222-3333-4444-555555555555', matchType: 0, conditionValue: 0x99n }),
    'WFP_CONDITION_INVALID',
  )

  const array = buildFilterConditionArray([condition, condition])
  check('buildFilterConditionArray: 长度为 count*40', array.buffer.length === 80 && array.count === 2, `${array.buffer.length}/${array.count}`)
  checkThrows('buildFilterConditionArray 拒绝尺寸不对的元素', () => buildFilterConditionArray([Buffer.alloc(39)]), 'WFP_CONDITION_INVALID')

  // `FWPM_FILTER0.filterCondition` 是**内嵌指针**，`buildFilter0` 不会替调用方猜它的值
  // （阶段 B 实测缺陷：初版把条件数组的 Buffer 直接当指针传 → writePointer 抛 WFP_POINTER_INVALID，
  //  因为 typeof Buffer === 'object' 且 Node 没有公开 API 能给出 Buffer 的原生地址）。
  const CONDITION_POINTER = 0xfeedf00dn
  const filter = buildFilter0({
    filterKey: '22222222-2222-3333-4444-555555555555',
    displayData: display,
    layerKey: '33333333-2222-3333-4444-555555555555',
    subLayerKey: '44444444-2222-3333-4444-555555555555',
    weight: buildValue0({ type: FWP_DATA_TYPE.FWP_EMPTY }),
    conditions: [condition],
    action: blockAction,
    conditionPointer: CONDITION_POINTER,
  })
  check('buildFilter0.buffer = 192 字节', filter.buffer.length === 192, String(filter.buffer.length))
  check('buildFilter0 回填 count=1', filter.count === 1, String(filter.count))
  check(
    'numFilterConditions 写在偏移 112',
    filter.buffer.readUInt32LE(112) === 1,
    String(filter.buffer.readUInt32LE(112)),
  )
  check(
    'filterCondition 指针写在偏移 120 且非零',
    filter.buffer.readBigUInt64LE(120) !== 0n,
    `0x${filter.buffer.readBigUInt64LE(120).toString(16)}`,
  )
  check(
    'filterCondition 指针 === conditionPointer 传入的地址（不只是"非零"）',
    filter.buffer.readBigUInt64LE(120) === CONDITION_POINTER,
    `0x${filter.buffer.readBigUInt64LE(120).toString(16)} vs 0x${CONDITION_POINTER.toString(16)}`,
  )
  check(
    'buildFilter0 把解析后的指针也回传给调用方（便于登记生命周期）',
    filter.conditionPointer === CONDITION_POINTER,
    `0x${String(filter.conditionPointer)}`,
  )
  check('action.type 写在偏移 128', filter.buffer.readUInt32LE(128) === FWP_ACTION_TYPE.FWP_ACTION_BLOCK, `0x${filter.buffer.readUInt32LE(128).toString(16)}`)
  check('layerKey 写在偏移 64', filter.buffer.subarray(64, 68).toString('hex') === '33333333', filter.buffer.subarray(64, 68).toString('hex'))
  check('subLayerKey 写在偏移 80', filter.buffer.subarray(80, 84).toString('hex') === '44444444', filter.buffer.subarray(80, 84).toString('hex'))
  check(
    'reserved / filterId / effectiveWeight 必须全零（BFE 回填字段）',
    filter.buffer.subarray(160, 192).every((byte) => byte === 0),
    filter.buffer.subarray(160, 192).toString('hex'),
  )
  checkThrows(
    'buildFilter0 在 subLayerKey 缺失时抛错（默认 sublayer 无法整组删除）',
    () =>
      buildFilter0({
        displayData: display,
        layerKey: '33333333-2222-3333-4444-555555555555',
        weight: buildValue0({ type: FWP_DATA_TYPE.FWP_EMPTY }),
        conditions: [condition],
        action: blockAction,
      }),
    'WFP_FILTER_INVALID',
  )
  checkThrows(
    'buildFilter0 在零条件且未显式允许时抛错（官方：无条件=动作对所有流量执行）',
    () =>
      buildFilter0({
        displayData: display,
        layerKey: '33333333-2222-3333-4444-555555555555',
        subLayerKey: '44444444-2222-3333-4444-555555555555',
        weight: buildValue0({ type: FWP_DATA_TYPE.FWP_EMPTY }),
        conditions: [],
        action: blockAction,
      }),
    'WFP_FILTER_UNCONDITIONAL_REFUSED',
  )
  check(
    'buildFilter0 显式 allowUnconditional 时才接受零条件',
    buildFilter0({
      displayData: display,
      layerKey: '33333333-2222-3333-4444-555555555555',
      subLayerKey: '44444444-2222-3333-4444-555555555555',
      weight: buildValue0({ type: FWP_DATA_TYPE.FWP_EMPTY }),
      conditions: [],
      action: blockAction,
      allowUnconditional: true,
    }).count === 0,
    'count=0',
  )

  // ── 内嵌指针的 fail-closed 回归（阶段 B 实测暴露的真实缺陷）──────────────────
  const filterBase = {
    displayData: display,
    layerKey: '33333333-2222-3333-4444-555555555555',
    subLayerKey: '44444444-2222-3333-4444-555555555555',
    weight: buildValue0({ type: FWP_DATA_TYPE.FWP_EMPTY }),
    conditions: [condition],
    action: blockAction,
  }
  checkThrows(
    '有条件但没给条件数组地址时必须抛 WFP_CONDITION_POINTER_MISSING（不写假指针占位）',
    () => buildFilter0({ ...filterBase }),
    'WFP_CONDITION_POINTER_MISSING',
  )
  checkThrows(
    '把条件数组 Buffer 当指针时必须抛 WFP_POINTER_INVALID（阶段 B 实测缺陷的永久回归）',
    () => buildFilter0({ ...filterBase, conditionPointer: condition }),
    'WFP_POINTER_INVALID',
  )
  check(
    'pinConditionArray 回调可提供地址（运行期即 koffi.address）',
    buildFilter0({ ...filterBase, pinConditionArray: (buffer, count) => BigInt(0x1000 + buffer.length + count) }).buffer.readBigUInt64LE(120) ===
      BigInt(0x1000 + FWPM_FILTER_CONDITION0_SIZE + 1),
    `0x${buildFilter0({ ...filterBase, pinConditionArray: (buffer, count) => BigInt(0x1000 + buffer.length + count) })
      .buffer.readBigUInt64LE(120)
      .toString(16)}`,
  )
  check(
    '零条件时不要求地址（没有内嵌指针要填）',
    buildFilter0({ ...filterBase, conditions: [], allowUnconditional: true }).conditionPointer === null,
    'null',
  )
  check(
    'pinConditionArray 收到的 buffer 长度 = count * 40（不是空 Buffer）',
    (() => {
      let seen = null
      buildFilter0({
        ...filterBase,
        conditions: [condition, condition],
        pinConditionArray: (buffer, count) => {
          seen = { length: buffer.length, count }
          return 0x1n
        },
      })
      return seen?.length === 2 * FWPM_FILTER_CONDITION0_SIZE && seen?.count === 2
    })(),
    '80 / 2',
  )

  const subLayer = buildSubLayer0({ subLayerKey: '55555555-2222-3333-4444-555555555555', displayData: display })
  check('buildSubLayer0 = 72 字节', subLayer.length === 72, String(subLayer.length))
  check('sublayer flags 默认 0（非持久）', subLayer.readUInt32LE(32) === 0, String(subLayer.readUInt32LE(32)))
  check('sublayer weight UINT16 写在偏移 64（默认 0x100）', subLayer.readUInt16LE(64) === 0x100, `0x${subLayer.readUInt16LE(64).toString(16)}`)
  check(
    'sublayer 尾部 6 字节是对齐 padding（必须为零，否则 BFE 读到垃圾）',
    subLayer.subarray(66, 72).every((byte) => byte === 0),
    subLayer.subarray(66, 72).toString('hex'),
  )
  checkThrows(
    'buildSubLayer0 拒绝 FWPM_SUBLAYER_FLAG_PERSISTENT（跨 BFE 重启的状态泄漏）',
    () => buildSubLayer0({ displayData: display, flags: FWPM_SUBLAYER_FLAG_PERSISTENT }),
    'WFP_SUBLAYER_PERSISTENT_REFUSED',
  )
  checkThrows('buildSubLayer0 拒绝越界 weight', () => buildSubLayer0({ displayData: display, weight: 0x10000 }), 'WFP_SUBLAYER_INVALID')

  const session = buildSession0({})
  check('buildSession0 = 72 字节', session.length === 72, String(session.length))
  check(
    'session flags 默认 FWPM_SESSION_FLAG_DYNAMIC（会话结束自动清理）',
    session.readUInt32LE(32) === FWPM_SESSION_FLAG_DYNAMIC,
    `0x${session.readUInt32LE(32).toString(16)}`,
  )
  check('session.txnWaitTimeoutInMSec@36 = 0', session.readUInt32LE(36) === 0, String(session.readUInt32LE(36)))
  check(
    'session.processId/sid/username/kernelMode 全零（官方：由 BFE 填写，不由客户端提供）',
    session.subarray(40, 72).every((byte) => byte === 0),
    session.subarray(40, 72).toString('hex'),
  )
  checkThrows('buildSession0 拒绝未支持的 flags', () => buildSession0({ flags: 0x2 }), 'WFP_SESSION_INVALID')

  const blob = buildByteBlob({ size: 32, data: 0xaaaabbbbccccddddn })
  check('buildByteBlob: size@0, data@8', blob.readUInt32LE(0) === 32 && blob.readBigUInt64LE(8) === 0xaaaabbbbccccddddn, blob.toString('hex'))
  checkThrows('buildByteBlob 拒绝 size>0 但 data 为 null', () => buildByteBlob({ size: 1, data: null }), 'WFP_BYTE_BLOB_INVALID')
  check('buildByteBlob size=0 时 data 为 NULL', buildByteBlob({ size: 0 }).readBigUInt64LE(8) === 0n, '0x0')
}

section('8. 规则计划（纯函数；缺少 GUID 必须抛错而不是猜值）')
{
  const keyA = stableRuleKey('dsh-stage/wfp', 'a')
  const keyB = stableRuleKey('dsh-stage/wfp', 'b')
  check('stableRuleKey 确定性（同输入同输出）', stableRuleKey('dsh-stage/wfp', 'a') === keyA, keyA)
  check('stableRuleKey 区分不同输入', keyA !== keyB, `${keyA} vs ${keyB}`)
  check('stableRuleKey 形如 GUID（8-4-4-4-12）', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(keyA), keyA)
  check(
    'stableRuleKey 设置 RFC4122 version=5 与 variant 位',
    keyA[14] === '5' && ['8', '9', 'a', 'b'].includes(keyA[19]),
    `version=${keyA[14]} variant=${keyA[19]}`,
  )

  const missing = checkThrows(
    'planOfflineRules 缺少 GUID 时抛 WFP_GUIDS_MISSING（本模块不内置任何 GUID 字面量）',
    () => planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: {} }),
    'WFP_GUIDS_MISSING',
  )
  check(
    'WFP_GUIDS_MISSING 会列出缺哪些键（便于阶段 B 一次补齐）',
    Array.isArray(missing?.missing) && missing.missing.includes('ALE_PACKAGE_ID') && missing.missing.includes('ALE_AUTH_CONNECT_V4'),
    JSON.stringify(missing?.missing ?? []),
  )

  const guids = {
    ALE_PACKAGE_ID: '00000000-0000-0000-0000-0000000000a1',
    ALE_APP_ID: '00000000-0000-0000-0000-0000000000a2',
    ALE_AUTH_CONNECT_V4: '00000000-0000-0000-0000-0000000000b1',
    ALE_AUTH_CONNECT_V6: '00000000-0000-0000-0000-0000000000b2',
    ALE_AUTH_RECV_ACCEPT_V4: '00000000-0000-0000-0000-0000000000b3',
    ALE_AUTH_RECV_ACCEPT_V6: '00000000-0000-0000-0000-0000000000b4',
    ALE_AUTH_LISTEN_V4: '00000000-0000-0000-0000-0000000000b5',
    ALE_AUTH_LISTEN_V6: '00000000-0000-0000-0000-0000000000b6',
    targetValue: 0x1n,
  }
  const plan = planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids })
  check('计划覆盖 6 个 ALE 层（含 IPv6 与 listen，不能只拦 IPv4 connect）', plan.filters.length === 6, String(plan.filters.length))
  check(
    '计划里每一层都出现且不重复',
    new Set(plan.filters.map((f) => f.layerKey)).size === 6,
    plan.filters.map((f) => f.layerKey).join(','),
  )
  check('所有 filter 的动作都是 BLOCK', plan.filters.every((f) => f.action === FWP_ACTION_TYPE.FWP_ACTION_BLOCK), 'BLOCK')
  check('target=appcontainer 时条件键是 ALE_PACKAGE_ID', plan.filters.every((f) => f.conditionKey === 'ALE_PACKAGE_ID'), 'ALE_PACKAGE_ID')
  check('计划带 subLayerKey 且形如 GUID', /^[0-9a-f-]{36}$/.test(plan.subLayerKey), plan.subLayerKey)
  check('计划带 warnings（不粉饰：必须提示"已建立连接不会被重新评估"）', plan.warnings.some((w) => /already established|first packet/i.test(w)), plan.warnings.length + ' 条')

  const appIdPlan = planOfflineRules({ tier: 'OFFLINE', target: 'app-identifier', guids })
  check('target=app-identifier 时条件键是 ALE_APP_ID', appIdPlan.filters.every((f) => f.conditionKey === 'ALE_APP_ID'), 'ALE_APP_ID')
  check(
    'target=app-identifier 必须带"会误伤/可改名绕过"的警告（否则就是把近似当精确）',
    appIdPlan.warnings.some((w) => /renamed|unrelated processes/i.test(w)),
    appIdPlan.warnings.join(' | ').slice(0, 160),
  )
  checkThrows('未实现的网络档位必须抛错（不许假装支持 CONTROLLED_ONLINE）', () => planOfflineRules({ tier: 'CONTROLLED_ONLINE', guids }), 'WFP_TIER_NOT_IMPLEMENTED')
  checkThrows('未知档位抛错', () => planOfflineRules({ tier: 'NOPE', guids }), 'WFP_TIER_INVALID')
  checkThrows('未知匹配目标抛错', () => planOfflineRules({ tier: 'OFFLINE', target: 'pid', guids }), 'WFP_TARGET_INVALID')
}

section('9. 调用层的 fail-closed 与错误码翻译（用替身，不碰真实 WFP）')
{
  check('describeWfpStatus 翻译 0x32 为 ERROR_NOT_SUPPORTED', describeWfpStatus(0x32).startsWith('ERROR_NOT_SUPPORTED'), describeWfpStatus(0x32))
  check('describeWfpStatus 翻译 5 为 ERROR_ACCESS_DENIED', describeWfpStatus(5).includes('ERROR_ACCESS_DENIED'), describeWfpStatus(5))
  check('describeWfpStatus 对未记录的错误码明确说"未记录"而不是编一个', describeWfpStatus(0x7f).includes('unknown/undocumented'), describeWfpStatus(0x7f))

  const noEngine = probeWfpAvailability({})
  check('无绑定表时 probeWfpAvailability 报不可用（不抛、也不假装可用）', noEngine.available === false, noEngine.detail)

  const failing = {
    fwpmEngineOpen0: () => 0x32,
    fwpmEngineClose0: () => 0,
  }
  const probe = probeWfpAvailability(failing)
  check('engine 打不开时如实回报原始状态码 0x32', probe.available === false && probe.status === 0x32, JSON.stringify(probe))

  checkThrows('openEngine 失败时抛 WFP_UNAVAILABLE（不返回半可用对象）', () => openEngine(failing), 'WFP_UNAVAILABLE')

  const working = {
    fwpmEngineOpen0: (server, authn, identity, session, slot) => {
      if (slot) slot[0] = 0x1234
      return 0
    },
    fwpmEngineClose0: () => 0,
  }
  const engine = openEngine(working)
  check('openEngine 成功时返回 handle', engine.handle === 0x1234, String(engine.handle))
  check('engine.close() 无失败项', engine.close().failures.length === 0, '0 项')

  // 绑定表要求（回滚能力缺一不可）：必须在改状态之前拒绝
  //
  // 测试缺陷（阶段 B 实测暴露）：初版把 `{ targetValue: 0x1n }` 直接当 `guids` 传给
  // `applyOfflinePlan`，而计划里的 6 个层 GUID 一个都没有 ⇒ 第一个 filter 还没走到
  // `fwpmFilterAdd0` 就先抛 `WFP_GUIDS_MISSING`。于是"回滚路径"用例**从未真正执行过回滚**，
  // 却在断言里期待 `WFP_FILTER_ADD_FAILED`（必然红）。这里把完整的 guids 提成一个变量复用。
  const offlineGuids = {
    ALE_PACKAGE_ID: '00000000-0000-0000-0000-0000000000a1',
    ALE_APP_ID: '00000000-0000-0000-0000-0000000000a2',
    ALE_AUTH_CONNECT_V4: '00000000-0000-0000-0000-0000000000b1',
    ALE_AUTH_CONNECT_V6: '00000000-0000-0000-0000-0000000000b2',
    ALE_AUTH_RECV_ACCEPT_V4: '00000000-0000-0000-0000-0000000000b3',
    ALE_AUTH_RECV_ACCEPT_V6: '00000000-0000-0000-0000-0000000000b4',
    ALE_AUTH_LISTEN_V4: '00000000-0000-0000-0000-0000000000b5',
    ALE_AUTH_LISTEN_V6: '00000000-0000-0000-0000-0000000000b6',
    targetValue: 0x1n,
  }
  checks: {
    const partial = { fwpmSubLayerAdd0: () => 0, fwpmFilterAdd0: () => 0 }
    const plan = planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: offlineGuids })
    checkThrows(
      'applyOfflinePlan 在"无法回滚"的绑定表上直接拒绝（改状态之前）',
      () => applyOfflinePlan(partial, { handle: 1n }, plan, { targetValue: 0x1n }),
      'WFP_UNAVAILABLE',
    )
    // 内嵌指针的来源缺失时也必须在**改状态之前**拒绝（同一条 fail-closed 理由，顺序在回滚能力之后）
    const pinProbeCalls = []
    const rollbackCapable = {
      fwpmSubLayerAdd0: () => {
        pinProbeCalls.push('subLayerAdd')
        return 0
      },
      fwpmFilterAdd0: (handle, filter, sd, out) => {
        pinProbeCalls.push('filterAdd')
        out.id = BigInt(0x700 + pinProbeCalls.filter((c) => c === 'filterAdd').length)
        return 0
      },
      fwpmFilterDeleteById0: () => {
        pinProbeCalls.push('filterDelete')
        return 0
      },
      fwpmSubLayerDeleteByKey0: () => {
        pinProbeCalls.push('subLayerDelete')
        return 0
      },
    }
    checkThrows(
      'applyOfflinePlan 缺少 pin 时抛 WFP_PIN_REQUIRED（且必须发生在装 sublayer 之前）',
      () => applyOfflinePlan(rollbackCapable, { handle: 1n }, plan, { targetValue: 0x1n }),
      'WFP_PIN_REQUIRED',
    )
    check(
      'WFP_PIN_REQUIRED 时一次 Win32 调用都没发生（证明是"改状态之前"拒绝）',
      pinProbeCalls.length === 0,
      `calls=[${pinProbeCalls.join(',')}]`,
    )
    check(
      '绑定表自带 pin 时可省略第 6 个参数（koffi 绑定层只需一处声明）',
      applyOfflinePlan(
        { ...rollbackCapable, pin: (buffer) => BigInt(0x6000 + buffer.length) },
        { handle: 1n },
        plan,
        offlineGuids,
      ).filters.length === 6,
      `6 个 filter，calls=[${pinProbeCalls.join(',')}]`,
    )
  }

  // 回滚路径：第 2 个 filter 添加失败时，必须删掉第 1 个 filter 与 sublayer
  const calls = []
  const flaky = {
    fwpmSubLayerAdd0: () => {
      calls.push('subLayerAdd')
      return 0
    },
    fwpmFilterAdd0: (handle, filter, sd, out) => {
      calls.push('filterAdd')
      if (calls.filter((c) => c === 'filterAdd').length === 2) return 0x80320003 // 假装第二个失败
      // 真 BFE 一定会回填 filterId（`FwpmFilterAdd0` 的 id 是 **OUT** 参数）。
      // 替身初版漏了这个出参 → 回滚时 filterId=null → `BigInt(null)` 抛 TypeError，
      // 于是"回滚路径"用例其实**从未删过任何 filter**（阶段 B 实测暴露的替身缺陷）。
      out.id = BigInt(0x900 + calls.filter((c) => c === 'filterAdd').length)
      return 0
    },
    fwpmFilterDeleteById0: () => {
      calls.push('filterDelete')
      return 0
    },
    fwpmSubLayerDeleteByKey0: () => {
      calls.push('subLayerDelete')
      return 0
    },
  }
  const rollbackPlan = planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: offlineGuids })
  const error = checkThrows(
    'applyOfflinePlan 中途失败必须抛错（不静默留下半套过滤器）',
    () => applyOfflinePlan(flaky, { handle: 1n }, rollbackPlan, offlineGuids, () => {}, (buffer) => BigInt(0x5000 + buffer.length)),
    'WFP_FILTER_ADD_FAILED',
  )
  check(
    '失败后按逆序回滚：先删已装的 filter（第 1 个），再删 sublayer',
    calls.join(',') === 'subLayerAdd,filterAdd,filterAdd,filterDelete,subLayerDelete',
    calls.join(','),
  )
  check('回滚自身的失败被记录在 error.rollbackFailures（不掩盖原错误）', Array.isArray(error?.rollbackFailures), JSON.stringify(error?.rollbackFailures ?? null))
  check(
    '回滚成功时 rollbackFailures 必须为空（否则"回滚了"是假象）',
    Array.isArray(error?.rollbackFailures) && error.rollbackFailures.length === 0,
    JSON.stringify(error?.rollbackFailures ?? null),
  )
  checkThrows(
    'FwpmFilterAdd0 成功但不回填 filterId 时必须抛 WFP_FILTER_ID_MISSING（否则装了一个删不掉的过滤器）',
    () => addFilter({ fwpmFilterAdd0: () => 0 }, 1n, Buffer.alloc(FWPM_FILTER0_SIZE)),
    'WFP_FILTER_ID_MISSING',
  )

  // 幂等语义
  check('installSubLayer 把 FWP_E_ALREADY_EXISTS 视为幂等成功', installSubLayer({ fwpmSubLayerAdd0: () => 0x80320003 }, 1n, buildSubLayer0({ displayData: buildDisplayData0({ name: 1n }) })).idempotent === true, 'idempotent')
  check('deleteFilterById 把 FWP_E_FILTER_NOT_FOUND 视为幂等成功', deleteFilterById({ fwpmFilterDeleteById0: () => 0x80320007 }, 1n, 5n).idempotent === true, 'idempotent')
  checkThrows(
    'addFilter 对其它错误码一律上抛（不吞）',
    () =>
      addFilter({ fwpmFilterAdd0: () => 5 }, 1n, Buffer.alloc(FWPM_FILTER0_SIZE)),
    'WFP_FILTER_ADD_FAILED',
  )
  checkThrows(
    'installSubLayer 对尺寸不对的 buffer 抛错',
    () => installSubLayer({ fwpmSubLayerAdd0: () => 0 }, 1n, Buffer.alloc(71)),
    'WFP_SUBLAYER_INVALID',
  )
}

section('10. 现状声明（不得被读成"已实测"）')
check(
  '调用层已实测到"引擎可开"这一步（阶段 B：FwpmEngineOpen0 hr=0x0，authn=WINNT/DEFAULT）',
  true,
  '见 src/wfp.mjs 顶部"现状声明（阶段 B 已更新）"与 .t/sbx3/dev/raw-probe-wfp-runtime.txt',
)
check(
  '但"装过滤器"仍未实测：本阶段一个 Fwpm*Add0 都没调用过（系统级状态变更需单独授权）',
  true,
  'raw-probe-wfp-runtime.txt 第 4 节逐字声明；installSubLayer/addFilter/applyOfflinePlan 均 [未实测]',
)
check(
  'ACTION 常量被标记为暂定（官方未给 flag 位值，本机无 SDK 头文件核对）',
  true,
  'FWP_ACTION_BLOCK=0x1001 / FWP_ACTION_PERMIT=0x1002，标 ACTION_TYPE_PROVISIONAL',
)

W('')
W('='.repeat(72))
W(
  PLANT
    ? `WFP 布局测试（--plant 模式，应当失败）：断言 ${assertions} 项，失败 ${failures} 项`
    : `WFP 布局测试：断言 ${assertions} 项，失败 ${failures} 项`,
)
W('='.repeat(72))
process.exit(failures ? 1 : 0)
