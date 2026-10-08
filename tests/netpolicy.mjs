/**
 * 网络策略强制/审计层的确定性测试（**离线、无管理员、无真实 WFP、无网络、不写任何文件**）
 *
 * 存在理由：`src/netpolicy.mjs` 的价值全在"**不许谎称网络已阻断**"这一条不变量上。
 * 而真实 WFP 的安装路径在本机**无法实测**（`[未实测]`：安装过滤器是系统级状态变更，
 * 本阶段未获授权；`src/wfp.mjs:28-30` 逐字声明"一个 `Fwpm*Add0` 都没调用过"），
 * 所以"判定是否正确"只能用**替身绑定表**离线钉死：
 *   - 替身记录**每一次**调用（顺序 / 参数形状 / 缓冲区尺寸），任何形状错误都记进 `violations`；
 *   - 替身维护主机侧状态（已装 filter / 已装 sublayer），用来证明**失败后零残留**；
 *   - 替身提供 pin 回调并把地址→Buffer 记下来，用来**从 filter 缓冲区里把条件数组读回来**核对。
 *
 * 五条硬不变量（逐条有断言）：
 *   1. `OFFLINE` + WFP 不可用 ⇒ `refused` / `enforced:false`，且 reason 点名缺失能力；绝不 `enforced:true`
 *   2. `ENFORCED` 只在"确实装上了"且（绑定表提供回读入口时）回读核对通过时才返回
 *   3. 安装中途失败 ⇒ 主机上零残留规则（best-effort 拆除确实跑了）
 *   4. 非 OFFLINE 档位 ⇒ `not-implemented`，明确、且任何地方都没有 `enforced:true`
 *   5. 同输入 ⇒ 同 `subLayerKey` / 同 filter key（稳定 key）
 *
 * 另有两组"残余加固"控制组（第三轮复核 R3-1 / R3-2，见 §3d / §3e）：
 *   - R3-1：计划指纹必须覆盖**计划真正消费的 GUID / 条件值**（层 GUID / 条件 GUID / `targetValue`），
 *     同一份真证据换 GUID 复判 ⇒ `plan-mismatch`；同一份 `guids` 则仍是 `enforced:true`；
 *   - R3-2：`teardown()` 通过**安装时定住**的引擎凭据关引擎，改写 `result.engine` 也伪造不出
 *     "engineClosed:true"；关闭真失败时 `failures` 如实。
 *
 * 用法：
 *   node tests\netpolicy.mjs            # 正常运行，应当全绿，退出码 0
 *   node tests\netpolicy.mjs --plant    # 故意让一处不变量失效，应当见红（≥3 项），退出码 1
 */

import { readFileSync } from 'node:fs'

import {
  NETWORK_TIER_STATES,
  ENUMERATION_UNAVAILABLE_REASON,
  resolveNetworkPolicy,
  installNetworkPolicy,
  auditNetworkPolicy,
  describeNetworkPolicy,
  summariseNetworkPolicy,
} from '../src/netpolicy.mjs'

import {
  NETWORK_TIERS,
  FWP_DATA_TYPE,
  FWP_MATCH_TYPE,
  FWP_ACTION_TYPE,
  ACTION_TYPE_PROVISIONAL,
  FWPM_SUBLAYER_FLAG_PERSISTENT,
  FWPM_SESSION_FLAG_DYNAMIC,
  FWPM_FILTER0_SIZE,
  FWPM_SUBLAYER0_SIZE,
  FWPM_FILTER_CONDITION0_SIZE,
  OFF_FILTER,
  OFF_SUBLAYER,
  OFF_DISPLAY_DATA,
  OFF_ACTION,
  OFF_VALUE,
  OFF_FILTER_CONDITION,
  OFF_CONDITION_VALUE,
  OFF_SESSION,
  RPC_C_AUTHN_WINNT,
  parseGuid,
  formatGuid,
  planOfflineRules,
} from '../src/wfp.mjs'

// D2：能力报告面的复现需要 `capabilityDimensions()`（正是 verifier 的 D2 攻击面）
import { capabilityDimensions } from '../src/capability.mjs'

const PLANT = process.argv.includes('--plant')

const W = (text) => process.stdout.write(`${text}\n`)
let assertions = 0
let failures = 0

function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`${condition ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
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

const JSON_TEXT = (value) => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item))

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

// ── 测试替身用的 GUID ───────────────────────────────────────────────────────
// 这些是**任意合法 GUID**，只用于离线替身；真值必须由 SDK 的 fwpmu.h 提供，
// `src/wfp.mjs` 与 `src/netpolicy.mjs` 都刻意不内置任何 GUID 字面量。
// 证据分层：`[推断]`（本机无 Windows SDK，`C:\Program Files (x86)\Windows Kits\10\Include` 不存在）。
const GUIDS = Object.freeze({
  ALE_AUTH_CONNECT_V4: '11111111-1111-1111-1111-111111111111',
  ALE_AUTH_CONNECT_V6: '22222222-2222-2222-2222-222222222222',
  ALE_AUTH_RECV_ACCEPT_V4: '33333333-3333-3333-3333-333333333333',
  ALE_AUTH_RECV_ACCEPT_V6: '44444444-4444-4444-4444-444444444444',
  ALE_AUTH_LISTEN_V4: '55555555-5555-5555-5555-555555555555',
  ALE_AUTH_LISTEN_V6: '66666666-6666-6666-6666-666666666666',
  ALE_PACKAGE_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  targetValue: 0x2000n, // 替身指针：真实值是 AppContainer 包 SID 指针（target=appcontainer）
})
const WRONG_LAYER_GUID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
// `target:'app-identifier'` 的计划要的是 ALE_APP_ID（不是 ALE_PACKAGE_ID）。
// N2 用例靠它构造"另一个计划"，用来证明安装记录比的是**安装时的指纹**，不是活计划对象。
const GUIDS_APP_IDENTIFIER = Object.freeze({
  ...GUIDS,
  ALE_APP_ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  targetValue: 0x3000n,
})
const BASE_ADDRESS = 0x10000000

const NETPOLICY_SOURCE = readFileSync(new URL('../src/netpolicy.mjs', import.meta.url), 'utf8')

// ── 替身 WFP 绑定表 ─────────────────────────────────────────────────────────
/**
 * 记录每一次调用并校验参数形状的假绑定表。
 *
 * 刻意与 `src/wfp.mjs` 的调用约定对齐（返回值给 status，出参走数组槽位），
 * 但**同时**支持 `{ status, handle }` / `{ status, filter }` 这种返回值对象约定 ——
 * `src/wfp.mjs` 自己就显式区分了这两种，替身也必须两边都覆盖，否则测的是替身不是被测代码。
 */
function makeFakeWfp(options = {}) {
  const {
    engineOpenStatus = 0,
    openThrows = false,
    closeThrows = false,
    omit = [],
    failFilterAddAt = 0,
    enumeration = 'get-by-key', // 'get-by-key' | 'enum' | 'none'
    enumReturnsEmpty = false,
    enumOmitFields = false,
    enumWrongLayer = false,
    enumThrows = false,
    hideFilterKeyFromEnum = null,
  } = options

  const calls = []
  const violations = []
  const pins = []
  const filterRecords = []
  const subLayerRecords = []
  const deleteOrder = []
  const deleteArgs = []
  const subLayerDeleteArgs = []
  const addedOrder = []
  const addressToBuffer = new Map()
  const host = { filters: new Map(), subLayers: new Set(), nextFilterId: 0x901n }
  let pinCounter = 0

  const pin = (buffer) => {
    if (!Buffer.isBuffer(buffer)) throw new Error(`fake pin: 期望 Buffer，收到 ${typeof buffer}`)
    const address = BASE_ADDRESS + pinCounter++ * 0x100
    pins.push({ address, length: buffer.length, buffer })
    addressToBuffer.set(address, buffer)
    return BigInt(address)
  }

  const api = {
    pin,
    fwpmEngineOpen0(serverName, authnService, authIdentity, session, out) {
      calls.push('engineOpen')
      if (openThrows) throw new Error('fake FwpmEngineOpen0 抛错（注入故障）')
      if (serverName !== null) violations.push('FwpmEngineOpen0: serverName 必须为 null（[官方] 要求）')
      if (authnService !== RPC_C_AUTHN_WINNT) {
        violations.push(`FwpmEngineOpen0: authnService=${authnService}，期望 RPC_C_AUTHN_WINNT(${RPC_C_AUTHN_WINNT})`)
      }
      if (authIdentity !== null) violations.push('FwpmEngineOpen0: authIdentity 必须为 null')
      if (session !== null && session !== undefined) {
        if (!Buffer.isBuffer(session) || session.length !== 72) {
          violations.push(`FwpmEngineOpen0: session 缓冲 ${Buffer.isBuffer(session) ? session.length : typeof session} 不是 72 字节`)
        } else if (session.readUInt32LE(OFF_SESSION.flags) !== FWPM_SESSION_FLAG_DYNAMIC) {
          violations.push('FwpmEngineOpen0: session.flags 必须是 FWPM_SESSION_FLAG_DYNAMIC')
        }
      }
      if (engineOpenStatus !== 0) return engineOpenStatus
      if (!Array.isArray(out)) {
        violations.push('FwpmEngineOpen0: 出参槽位不是数组')
        return 0x57
      }
      out[0] = { fake: 'engine' }
      return 0
    },
    fwpmEngineClose0(handle) {
      calls.push('engineClose')
      if (closeThrows) throw new Error('fake FwpmEngineClose0 抛错（注入故障）')
      if (!handle || handle.fake !== 'engine') violations.push('FwpmEngineClose0: 句柄形状不对')
      return 0
    },
    fwpmSubLayerAdd0(handle, subLayer) {
      calls.push('subLayerAdd')
      if (!Buffer.isBuffer(subLayer) || subLayer.length !== FWPM_SUBLAYER0_SIZE) {
        violations.push(`FwpmSubLayerAdd0: ${Buffer.isBuffer(subLayer) ? subLayer.length : typeof subLayer} != ${FWPM_SUBLAYER0_SIZE} 字节`)
        return 0x57
      }
      const record = {
        key: formatGuid(subLayer.subarray(OFF_SUBLAYER.subLayerKey, OFF_SUBLAYER.subLayerKey + 16)),
        flags: subLayer.readUInt32LE(OFF_SUBLAYER.flags),
        displayNamePointer: subLayer.readBigUInt64LE(OFF_SUBLAYER.displayData + OFF_DISPLAY_DATA.name),
        length: subLayer.length,
      }
      subLayerRecords.push(record)
      host.subLayers.add(record.key)
      return 0
    },
    fwpmFilterAdd0(handle, filter, sd, out) {
      calls.push('filterAdd')
      const index = calls.filter((c) => c === 'filterAdd').length
      if (!Buffer.isBuffer(filter) || filter.length !== FWPM_FILTER0_SIZE) {
        violations.push(`FwpmFilterAdd0: ${Buffer.isBuffer(filter) ? filter.length : typeof filter} != ${FWPM_FILTER0_SIZE} 字节`)
        return 0x57
      }
      const record = {
        index,
        length: filter.length,
        key: formatGuid(filter.subarray(OFF_FILTER.filterKey, OFF_FILTER.filterKey + 16)),
        layerKey: formatGuid(filter.subarray(OFF_FILTER.layerKey, OFF_FILTER.layerKey + 16)),
        subLayerKey: formatGuid(filter.subarray(OFF_FILTER.subLayerKey, OFF_FILTER.subLayerKey + 16)),
        numConditions: filter.readUInt32LE(OFF_FILTER.numFilterConditions),
        conditionPointer: filter.readBigUInt64LE(OFF_FILTER.filterCondition),
        actionType: filter.readUInt32LE(OFF_FILTER.action + OFF_ACTION.type),
        actionGuidIsZero: filter
          .subarray(OFF_FILTER.action + OFF_ACTION.filterTypeOrCalloutKey, OFF_FILTER.action + OFF_ACTION.filterTypeOrCalloutKey + 16)
          .every((byte) => byte === 0),
        weightType: filter.readUInt32LE(OFF_FILTER.weight + OFF_VALUE.type),
        flags: filter.readUInt32LE(OFF_FILTER.flags),
        reserved: filter.readBigUInt64LE(OFF_FILTER.reserved),
        filterIdField: filter.readBigUInt64LE(OFF_FILTER.filterId),
        effectiveWeight: filter.readBigUInt64LE(OFF_FILTER.effectiveWeight),
      }
      filterRecords.push(record)
      if (failFilterAddAt === index) return 0x80320003 // FWP_E_ALREADY_EXISTS：让第 index 条真的失败
      if (!out || typeof out !== 'object') {
        violations.push('FwpmFilterAdd0: 出参槽位不是对象')
        return 0x57
      }
      const id = host.nextFilterId++
      host.filters.set(id, { key: record.key, layerKey: record.layerKey, subLayerKey: record.subLayerKey })
      addedOrder.push(id)
      out.id = id // [官方] filterId 是 OUT 参数，是 FwpmFilterDeleteById0 唯一接受的删除凭据
      return 0
    },
    fwpmFilterDeleteById0(handle, id) {
      calls.push('filterDelete')
      deleteArgs.push(id)
      deleteOrder.push(id)
      const existed = host.filters.delete(id)
      return existed ? 0 : 0x80320007 // 幂等：FWP_E_FILTER_NOT_FOUND
    },
    fwpmSubLayerDeleteByKey0(handle, key) {
      calls.push('subLayerDelete')
      subLayerDeleteArgs.push(key)
      if (!Buffer.isBuffer(key) || key.length !== 16) violations.push('FwpmSubLayerDeleteByKey0: key 不是 16 字节 Buffer')
      const existed = host.subLayers.delete(formatGuid(key))
      return existed ? 0 : 0x8032000a // 幂等：FWP_E_SUBLAYER_NOT_FOUND
    },
  }

  // 回读入口 1：[官方] FwpmFilterGetByKey0 —— 按 filterKey 精确回读，不依赖安装时记下的 id
  if (enumeration === 'get-by-key') {
    api.fwpmFilterGetByKey0 = (handle, key, out) => {
      calls.push('filterGetByKey')
      if (enumThrows) throw new Error('fake FwpmFilterGetByKey0 抛错（注入故障）')
      if (!Buffer.isBuffer(key) || key.length !== 16) violations.push('FwpmFilterGetByKey0: key 不是 16 字节 Buffer')
      const keyText = formatGuid(key)
      if (enumReturnsEmpty || keyText === hideFilterKeyFromEnum) return 0x80320007 // FWP_E_FILTER_NOT_FOUND
      let found = null
      for (const record of host.filters.values()) if (record.key === keyText) found = record
      if (!found) return 0x80320007
      out[0] = {
        filterKey: parseGuid(found.key),
        ...(enumOmitFields
          ? {}
          : {
              layerKey: parseGuid(enumWrongLayer ? WRONG_LAYER_GUID : found.layerKey),
              subLayerKey: parseGuid(found.subLayerKey),
            }),
      }
      return 0
    }
  }

  // 回读入口 2：[官方] FwpmFilterEnum0 —— 整表枚举
  if (enumeration === 'enum') {
    api.fwpmFilterEnum0 = (handle, template, out) => {
      calls.push('filterEnum')
      if (enumThrows) throw new Error('fake FwpmFilterEnum0 抛错（注入故障）')
      if (!Array.isArray(out)) {
        violations.push('FwpmFilterEnum0: 出参槽位不是数组')
        return 0x57
      }
      if (enumReturnsEmpty) {
        out[0] = []
        return 0
      }
      const entries = []
      for (const record of host.filters.values()) {
        if (record.key === hideFilterKeyFromEnum) continue
        entries.push({
          filterKey: parseGuid(record.key),
          ...(enumOmitFields
            ? {}
            : {
                layerKey: parseGuid(enumWrongLayer ? WRONG_LAYER_GUID : record.layerKey),
                subLayerKey: parseGuid(record.subLayerKey),
              }),
        })
      }
      out[0] = entries
      return 0
    }
  }

  for (const name of omit) delete api[name]

  /**
   * 直接往替身的主机状态里塞入"之前某个会话已装好"的过滤器。
   *
   * 用途：只测 `auditNetworkPolicy()` 的回读逻辑时，不必先跑一遍安装
   * （否则枚举类用例测的就变成了安装路径）。真值来自 `planOfflineRules()`，
   * 因为 `plan.filters[].layerKey` 是**语义键名**，需要 `guids` 才能翻成 GUID。
   */
  const seed = (plan, guids) => {
    for (const rule of plan.filters) {
      const id = host.nextFilterId++
      host.filters.set(id, {
        key: rule.key,
        layerKey: formatGuid(parseGuid(guids[rule.layerKey])),
        subLayerKey: plan.subLayerKey,
      })
    }
    host.subLayers.add(plan.subLayerKey)
  }

  return {
    api,
    seed,
    calls,
    violations,
    pins,
    filterRecords,
    subLayerRecords,
    deleteOrder,
    deleteArgs,
    subLayerDeleteArgs,
    addedOrder,
    addressToBuffer,
    host,
  }
}

// ── --plant：故意破坏"不变量 1"，且**只动测试这一侧**，绝不修改 src/netpolicy.mjs ──
// 破坏方式：让 OFFLINE 档位在"明知挡不住"的情况下返回 enforced:true（正是本项目最想避免的
// 失败模式）。这样"OFFLINE + WFP 不可用 ⇒ refused/enforced:false"这一族断言会整片见红。
const plantedResolve = (options = {}) => {
  const result = resolveNetworkPolicy(options)
  if (result.tier === 'OFFLINE') {
    return {
      ...result,
      state: NETWORK_TIER_STATES.ENFORCED,
      enforced: true,
      reason: 'planted: 无视能力缺口直接宣称网络已强制（这条断言必须判红）',
    }
  }
  return result
}
const resolvePolicy = PLANT ? plantedResolve : resolveNetworkPolicy

if (PLANT) {
  W('*** --plant 模式：故意让 OFFLINE 的"能力缺口"伪装成"已强制"，不变量 1 的断言应当见红 ***')
}

W('网络策略强制/审计层测试（离线替身绑定表；不装任何真实过滤器、不写任何文件）')

// ═══════════════════════ 1. 模块表面 ═══════════════════════
section('1. 模块表面与导出')

check(
  'NETWORK_TIER_STATES 冻结且取值恰为 enforced / not-enforced / refused / not-implemented',
  Object.isFrozen(NETWORK_TIER_STATES) &&
    NETWORK_TIER_STATES.ENFORCED === 'enforced' &&
    NETWORK_TIER_STATES.NOT_ENFORCED === 'not-enforced' &&
    NETWORK_TIER_STATES.REFUSED === 'refused' &&
    NETWORK_TIER_STATES.NOT_IMPLEMENTED === 'not-implemented',
  JSON_TEXT(NETWORK_TIER_STATES),
)
check(
  '四态互不相同（不允许含混表述）',
  new Set(Object.values(NETWORK_TIER_STATES)).size === 4,
  Object.values(NETWORK_TIER_STATES).join(','),
)
check(
  '五个必需导出都是函数',
  [resolveNetworkPolicy, installNetworkPolicy, auditNetworkPolicy, describeNetworkPolicy, summariseNetworkPolicy].every(
    (fn) => typeof fn === 'function',
  ),
)
check(
  '默认档位是 OBSERVED_ONLINE（不得回归成"默认阻断"）',
  resolvePolicy({}).tier === 'OBSERVED_ONLINE',
  `tier=${resolvePolicy({}).tier}`,
)
checkThrows('未知档位抛 NETWORK_TIER_INVALID（不把未知当成"不阻断"）', () => resolvePolicy({ requested: 'LAN_ONLY' }), 'NETWORK_TIER_INVALID')
check(
  'NETWORK_TIERS 仍是 planOfflineRules 定义的三档（本模块没有另立档位表）',
  NETWORK_TIERS.length === 3 && NETWORK_TIERS.includes('OFFLINE'),
  NETWORK_TIERS.join(','),
)
check(
  'netpolicy.mjs 不重复任何结构布局字面量（OFF_* / *_SIZE 只应存在于 src/wfp.mjs）',
  !/FWPM_FILTER0_SIZE|FWPM_SUBLAYER0_SIZE|FWPM_ACTION0_SIZE|OFF_FILTER\b|OFF_SUBLAYER\b|OFF_SESSION\b/.test(NETPOLICY_SOURCE),
  '源码扫描：无 OFF_*/SIZE 标识符',
)
check(
  'netpolicy.mjs 不内置任何 GUID 字面量，全部经 guids 传入',
  !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(NETPOLICY_SOURCE) &&
    /from '\.\/wfp\.mjs'/.test(NETPOLICY_SOURCE),
  '源码扫描：无 8-4-4-4-12 GUID 文本，且从 ./wfp.mjs 取值',
)

// ═══════════════════════ 2. 不变量 1：缺口 ⇒ REFUSED ═══════════════════════
section('2. 不变量 1：OFFLINE + WFP 不可用 ⇒ refused / enforced:false（绝不谎称已阻断）')

const refusedResults = []

// (a) 连绑定表都没有
const rNoApi = resolvePolicy({ requested: 'OFFLINE' })
refusedResults.push(rNoApi)
check('1a api=null ⇒ state=refused', rNoApi.state === 'refused', `state=${rNoApi.state}`)
check('1a api=null ⇒ enforced=false', rNoApi.enforced === false, `enforced=${rNoApi.enforced}`)
check(
  '1a api=null ⇒ reason 点名缺失能力（WFP_UNAVAILABLE + 具体缺少的函数）',
  rNoApi.reason.includes('WFP_UNAVAILABLE') && rNoApi.reason.includes('fwpmFilterAdd0') && rNoApi.reason.includes('绑定表'),
  rNoApi.reason,
)
check('1a api=null ⇒ plan=null（没有可安装的计划）', rNoApi.plan === null, `plan=${rNoApi.plan}`)

// (b) 绑定表缺关键函数
const fakeMissing = makeFakeWfp({ omit: ['fwpmFilterAdd0'] })
const rMissing = resolvePolicy({ requested: 'OFFLINE', api: fakeMissing.api, guids: GUIDS })
refusedResults.push(rMissing)
check('1b 绑定表缺 fwpmFilterAdd0 ⇒ state=refused', rMissing.state === 'refused', `state=${rMissing.state}`)
check(
  '1b reason 点名 fwpmFilterAdd0（缺哪个报哪个）',
  rMissing.reason.includes('fwpmFilterAdd0') && rMissing.missingBindings.includes('fwpmFilterAdd0'),
  rMissing.reason,
)
check('1b 缺绑定表时一次 Win32 调用都没发生（改状态之前就拒绝）', fakeMissing.calls.length === 0, `calls=[${fakeMissing.calls.join(',')}]`)

// (c) 引擎打开返回 0x32 = ERROR_NOT_SUPPORTED
const fakeNotSupported = makeFakeWfp({ engineOpenStatus: 0x32 })
const r32 = resolvePolicy({ requested: 'OFFLINE', api: fakeNotSupported.api, guids: GUIDS })
refusedResults.push(r32)
check('1c FwpmEngineOpen0 -> 0x32 ⇒ state=refused', r32.state === 'refused', `state=${r32.state}`)
check('1c enforced=false', r32.enforced === false, `enforced=${r32.enforced}`)
check(
  '1c reason 含 0x32 与 ERROR_NOT_SUPPORTED（精确点名缺失能力，而不是含糊说"失败"）',
  r32.reason.includes('0x32') && r32.reason.includes('ERROR_NOT_SUPPORTED'),
  r32.reason,
)
check('1c verified=false', r32.verified === false, `verified=${r32.verified}`)

// (d) 引擎打开返回访问被拒
const fakeDenied = makeFakeWfp({ engineOpenStatus: 0x80320005 })
const rDenied = resolvePolicy({ requested: 'OFFLINE', api: fakeDenied.api, guids: GUIDS })
refusedResults.push(rDenied)
check(
  '1d FwpmEngineOpen0 -> 0x80320005 ⇒ refused 且 reason 点名该状态码',
  rDenied.state === 'refused' && rDenied.enforced === false && rDenied.reason.includes('0x80320005'),
  rDenied.reason,
)

// (e) 引擎打开直接抛错
const fakeThrows = makeFakeWfp({ openThrows: true })
const rThrows = resolvePolicy({ requested: 'OFFLINE', api: fakeThrows.api, guids: GUIDS })
refusedResults.push(rThrows)
check(
  '1e FwpmEngineOpen0 抛错 ⇒ refused 且 reason 保留原始抛错信息',
  rThrows.state === 'refused' && rThrows.enforced === false && rThrows.reason.includes('threw'),
  rThrows.reason,
)

// (f) 注入的 probe 报告不可用（健康绑定表）—— 证明判定真的取用了 probe
const fakeProbeFalse = makeFakeWfp()
const rProbeFalse = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeProbeFalse.api,
  guids: GUIDS,
  probe: { available: false, status: 0x80320005, detail: '替身 probe：ACCESS_DENIED' },
})
refusedResults.push(rProbeFalse)
check(
  '1f 注入 probe 报告不可用 ⇒ refused（不因为绑定表"看起来齐"就放行）',
  rProbeFalse.state === 'refused' && rProbeFalse.enforced === false && rProbeFalse.reason.includes('ACCESS_DENIED'),
  rProbeFalse.reason,
)
check('1f 注入 probe 已判定不可用 ⇒ 不再发生任何 Win32 调用', fakeProbeFalse.calls.length === 0, `calls=[${fakeProbeFalse.calls.join(',')}]`)

// (g) probe 通过但引擎打不开（探测结果被伪造时的兜底）
const fakeOpenFail = makeFakeWfp({ openThrows: true })
const rOpenFail = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeOpenFail.api,
  guids: GUIDS,
  probe: { available: true, detail: '替身 probe：假装通过' },
})
refusedResults.push(rOpenFail)
check(
  '1g probe 说可用但引擎打不开 ⇒ refused（不信任单一探测结论）',
  rOpenFail.state === 'refused' && rOpenFail.enforced === false && rOpenFail.reason.includes('引擎无法打开'),
  rOpenFail.reason,
)

// (h) 缺 pin 回调
const fakeNoPin = makeFakeWfp({ omit: ['pin'] })
const rNoPin = resolvePolicy({ requested: 'OFFLINE', api: fakeNoPin.api, guids: GUIDS })
refusedResults.push(rNoPin)
check(
  '1h 缺 pin 回调 ⇒ refused 且 reason=WFP_PIN_REQUIRED（计划不可安装）',
  rNoPin.state === 'refused' && rNoPin.enforced === false && rNoPin.reason.includes('WFP_PIN_REQUIRED'),
  rNoPin.reason,
)
check('1h 缺 pin 时一次 Win32 调用都没发生', fakeNoPin.calls.length === 0, `calls=[${fakeNoPin.calls.join(',')}]`)

// (i) 缺 GUID（计划构造不出来）
const fakeNoGuids = makeFakeWfp()
const rNoGuids = resolvePolicy({ requested: 'OFFLINE', api: fakeNoGuids.api, guids: {} })
refusedResults.push(rNoGuids)
check(
  '1i 缺 GUID ⇒ refused 且 reason 点名 WFP_GUIDS_MISSING',
  rNoGuids.state === 'refused' && rNoGuids.enforced === false && rNoGuids.reason.includes('WFP_GUIDS_MISSING'),
  rNoGuids.reason,
)
check(
  '1i 缺 GUID 之前确实探测过引擎（探测在计划构造之前，顺序确定）',
  fakeNoGuids.calls.join(',') === 'engineOpen,engineClose,engineOpen,engineClose',
  `calls=[${fakeNoGuids.calls.join(',')}]`,
)

// (i2) 显式 guids:null / undefined（文档默认形状）⇒ 必须落在本模块自己的**类型化**错误码上，
//      不得把原生 TypeError 包装成 WFP_PLAN_FAILED（本轮修复点：normaliseGuids）。
const fakeNullGuids = makeFakeWfp()
const rNullGuids = resolvePolicy({ requested: 'OFFLINE', api: fakeNullGuids.api, guids: null })
refusedResults.push(rNullGuids)
check(
  '1i2 guids:null ⇒ 仍是 state=refused / enforced=false / plan=null（归一不改变判定）',
  rNullGuids.state === 'refused' && rNullGuids.enforced === false && rNullGuids.plan === null,
  `state=${rNullGuids.state} enforced=${rNullGuids.enforced} plan=${rNullGuids.plan}`,
)
check(
  '1i2 guids:null ⇒ reason 是类型化 WFP_GUIDS_MISSING，不含 TypeError / Cannot read properties of null / WFP_PLAN_FAILED',
  rNullGuids.reason.includes('WFP_GUIDS_MISSING') &&
    !rNullGuids.reason.includes('WFP_PLAN_FAILED') &&
    !rNullGuids.reason.includes('TypeError') &&
    !rNullGuids.reason.includes('Cannot read properties of null'),
  rNullGuids.reason,
)
check(
  '1i2 guids:null ⇒ 类型化错误自带的 missing 列表如实列出缺哪些 GUID（机器可读，不猜）',
  Array.isArray(rNullGuids.missing) && rNullGuids.missing.includes('ALE_PACKAGE_ID'),
  JSON_TEXT(rNullGuids.missing),
)
const fakeUndefinedGuids = makeFakeWfp()
const rUndefinedGuids = resolvePolicy({ requested: 'OFFLINE', api: fakeUndefinedGuids.api, guids: undefined })
refusedResults.push(rUndefinedGuids)
check(
  '1i2 guids:undefined 与 guids:null 归一成同一种类型化拒绝（同 missing 列表、同拒绝语义）',
  rUndefinedGuids.state === 'refused' &&
    rUndefinedGuids.enforced === false &&
    rUndefinedGuids.reason.includes('WFP_GUIDS_MISSING') &&
    JSON_TEXT(rUndefinedGuids.missing) === JSON_TEXT(rNullGuids.missing),
  `state=${rUndefinedGuids.state} missing=${JSON_TEXT(rUndefinedGuids.missing)}`,
)

check(
  '1(总) 所有 REFUSED 结果都不含 "enforced":true（fail-closed 的机器可判定形式）',
  refusedResults.every((result) => result.state === 'refused' && result.enforced === false && !JSON_TEXT(result).includes('"enforced":true')),
  `共 ${refusedResults.length} 个 REFUSED 结果`,
)

// ═══════════════════════ 3. 不变量 2：ENFORCED 的充分条件 ═══════════════════════
section('3. 不变量 2：ENFORCED 只在"确实装上了"且（能回读时）核对通过时才返回')

const planA = planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS })

// (a) 前置条件全满足，但没有安装证据 ⇒ 不得 ENFORCED
const fakeHealthy = makeFakeWfp()
const rNotApplied = resolvePolicy({ requested: 'OFFLINE', api: fakeHealthy.api, guids: GUIDS })
check('2a 前置条件全满足但无安装证据 ⇒ state=not-enforced', rNotApplied.state === 'not-enforced', `state=${rNotApplied.state}`)
check('2a enforced=false（"计划能构造"≠"已强制"）', rNotApplied.enforced === false, `enforced=${rNotApplied.enforced}`)
check('2a verified=false', rNotApplied.verified === false, `verified=${rNotApplied.verified}`)
check('2a plan 已解析出 6 条规则（计划仍在，只是没装）', rNotApplied.plan?.filters?.length === 6, `filters=${rNotApplied.plan?.filters?.length}`)
check('2a reason 明说"没有任何安装证据"', rNotApplied.reason.includes('安装证据'), rNotApplied.reason)

// (b) 真安装（含回读核对）⇒ ENFORCED
const fakeInstall = makeFakeWfp()
const installedA = installNetworkPolicy({ api: fakeInstall.api, plan: planA, guids: GUIDS })
const rApplied = resolvePolicy({ requested: 'OFFLINE', api: fakeInstall.api, guids: GUIDS, install: installedA })
check('2b installNetworkPolicy 成功安装 6 条过滤器', installedA.installed.length === 6, `installed=${installedA.installed.length}`)
check('2b filterIds 6 个且 subLayerKey 与计划一致', installedA.filterIds.length === 6 && installedA.subLayerKey === planA.subLayerKey, `subLayerKey=${installedA.subLayerKey}`)
check('2b audit.verified=true（从引擎按 filterKey 回读核对通过）', installedA.audit?.verified === true, `audit=${JSON_TEXT(installedA.audit)}`)
check(
  '2b audit.layerChecked=true（给了 guids，所以"层是否一致"确实被核对过）',
  installedA.audit?.layerChecked === true,
  `layerChecked=${installedA.audit?.layerChecked}`,
)
check('2b 带着安装证据再解析 ⇒ state=enforced', rApplied.state === 'enforced', `state=${rApplied.state}`)
check('2b enforced=true 且 verified=true', rApplied.enforced === true && rApplied.verified === true, `enforced=${rApplied.enforced} verified=${rApplied.verified}`)

// (c) 绑定表没有回读入口：已安装但无法核对 ⇒ ENFORCED 但 verified=false，reason 必须写明
const fakeNoEnum = makeFakeWfp({ enumeration: 'none' })
const installedUnverified = installNetworkPolicy({ api: fakeNoEnum.api, plan: planA, guids: GUIDS })
check(
  '2c 绑定表无回读入口时安装仍成功（"不知情"不等于"失败"）',
  installedUnverified.filterIds.length === 6,
  `filterIds=${installedUnverified.filterIds.length}`,
)
check(
  `2c audit 如实返回 verified=false 且 reason 恰为 '${ENUMERATION_UNAVAILABLE_REASON}'（绝不猜）`,
  installedUnverified.audit.verified === false && installedUnverified.audit.reason === ENUMERATION_UNAVAILABLE_REASON,
  `audit=${JSON_TEXT(installedUnverified.audit)}`,
)
const rUnverified = resolvePolicy({ requested: 'OFFLINE', api: fakeNoEnum.api, guids: GUIDS, install: installedUnverified })
check(
  '2c 已安装但无法回读 ⇒ state=enforced 且 verified=false（必要条件是"装上了"）',
  rUnverified.state === 'enforced' && rUnverified.enforced === true && rUnverified.verified === false,
  `state=${rUnverified.state} enforced=${rUnverified.enforced} verified=${rUnverified.verified}`,
)
check('2c reason 明说"未独立验证"（不得读成"已核对"）', rUnverified.reason.includes('未独立验证'), rUnverified.reason)

// (d) 回读说缺过滤器 ⇒ 不得 ENFORCED
const rReadbackMissing = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeHealthy.api,
  guids: GUIDS,
  install: { installed: installedA.installed, audit: { verified: false, reason: 'filters-missing:5/6' } },
})
check(
  '2d 回读说缺过滤器 ⇒ state=not-enforced / enforced=false',
  rReadbackMissing.state === 'not-enforced' && rReadbackMissing.enforced === false,
  `state=${rReadbackMissing.state} reason=${rReadbackMissing.reason}`,
)

// (e) 部分安装 ⇒ 不得 ENFORCED
const rPartial = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeHealthy.api,
  guids: GUIDS,
  install: { installed: installedA.installed.slice(0, 3), filterIds: installedA.filterIds.slice(0, 3) },
})
check(
  '2e 只装了 3/6 ⇒ state=not-enforced / enforced=false',
  rPartial.state === 'not-enforced' && rPartial.enforced === false,
  `state=${rPartial.state} reason=${rPartial.reason}`,
)

// (f) 有安装证据但没有 audit ⇒ fail-closed
const rNoAudit = resolvePolicy({ requested: 'OFFLINE', api: fakeHealthy.api, guids: GUIDS, install: { installed: installedA.installed } })
check(
  '2f 有安装证据但没有任何 audit ⇒ state=not-enforced（fail-closed）',
  rNoAudit.state === 'not-enforced' && rNoAudit.enforced === false,
  `state=${rNoAudit.state} reason=${rNoAudit.reason}`,
)

// ═══════════════════════ 3b. D2：安装证据必须**来源可信** ═══════════════════════
// 修复前（**独立验证会话**的 D2 复现，`[实测]` 于那一次会话、记录见
// `docs/NeoAI-差距补齐-实施与验证报告.md` §2.1 A5/§3 D2）：调用方自造的
// `{ installed: [6 条] }` + `{ verified: true }` 就能让报告面报
// `enforced:true / verified:true`，而底层 `FwpmFilterAdd0` **调用 0 次**。
// 修复后（本轮 `[实测]`，即下面 2g–2l）：只有 `installNetworkPolicy()` 亲自产出、
// 且与本 api/本计划同源的证据被采信。
section('3b. D2：伪造/转发安装证据不得铸出 enforced:true（fail-closed）')

// (a) 形状完全正确的自造 install + 伪造 audit ⇒ 不得 enforced
const forgedInstall = { installed: installedA.installed, filterIds: installedA.filterIds }
const rForged = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeInstall.api,
  guids: GUIDS,
  install: forgedInstall,
  audit: { verified: true },
})
check(
  '2g(D2) 自造 install（形状正确）+ 伪造 audit ⇒ state=not-enforced / enforced=false',
  rForged.state === 'not-enforced' && rForged.enforced === false && rForged.verified === false,
  `state=${rForged.state} enforced=${rForged.enforced} reason=${rForged.reason}`,
)
check(
  '2g(D2) reason 明说证据不被采信（不是"没有证据"，而是"来源不可信"）',
  /安装证据不被采信/.test(rForged.reason),
  rForged.reason,
)

// (b) 把真实证据展开拷贝一份也不是证据（品牌符号非枚举 + WeakMap 认对象同一性）
const clonedInstall = { ...installedA }
const rCloned = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeInstall.api,
  guids: GUIDS,
  install: clonedInstall,
  audit: installedA.audit,
})
check(
  '2h(D2) `{...真证据}` 的拷贝件不再是证据 ⇒ enforced=false（品牌不可通过展开拷贝）',
  rCloned.enforced === false && rCloned.state === 'not-enforced' && /安装证据不被采信/.test(rCloned.reason),
  `state=${rCloned.state} enforced=${rCloned.enforced} reason=${rCloned.reason}`,
)

// (c) 真证据 + **另一个** audit 对象（伪造"已核对"）⇒ 整条证据降级
const rForgedAudit = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeNoEnum.api,
  guids: GUIDS,
  install: installedUnverified,
  audit: { verified: true, reason: 'forged' },
})
check(
  '2i(D2) 真证据 + 伪造 audit ⇒ 降级（不得把"已强制但未独立验证"升级成"已核对"）',
  rForgedAudit.enforced === false && rForgedAudit.verified === false && /audit-mismatch/.test(rForgedAudit.reason),
  `state=${rForgedAudit.state} enforced=${rForgedAudit.enforced} reason=${rForgedAudit.reason}`,
)

// (d) teardown() 之后证据作废：过滤器已经删了，不得再声称"网络已强制"
const fakeTorn = makeFakeWfp()
const installedTorn = installNetworkPolicy({ api: fakeTorn.api, plan: planA, guids: GUIDS })
installedTorn.teardown()
const rTorn = resolvePolicy({ requested: 'OFFLINE', api: fakeTorn.api, guids: GUIDS, install: installedTorn })
check(
  '2j(D2) teardown() 之后同一证据作废 ⇒ enforced=false / state=not-enforced',
  rTorn.enforced === false && rTorn.state === 'not-enforced' && /evidence-torn-down/.test(rTorn.reason),
  `state=${rTorn.state} enforced=${rTorn.enforced} reason=${rTorn.reason}`,
)

// (e) 能力报告面：verifier 的原始复现（这才是 D2 的攻击面）
const fakeReport = makeFakeWfp()
let forgedReport = null
let forgedReportError = null
try {
  forgedReport = capabilityDimensions({
    networkTier: 'OFFLINE',
    networkBindings: fakeReport.api,
    networkGuids: GUIDS,
    networkProbe: { available: true, status: 0, detail: '离线替身：引擎可开' },
    networkInstall: { installed: installedA.installed },
    networkAudit: { verified: true },
  })
} catch (error) {
  forgedReportError = error
}
check(
  '2k(D2) capabilityDimensions + 伪造 install/audit ⇒ state=not-enforced / enforced=false（verifier 的 D2 复现）',
  forgedReportError === null &&
    forgedReport.networkPolicy.state === 'not-enforced' &&
    forgedReport.networkPolicy.enforced === false &&
    forgedReport.networkPolicy.verified === false,
  forgedReportError ? `抛错：${forgedReportError.message}` : JSON_TEXT(forgedReport.networkPolicy),
)
check(
  '2k(D2) 该次判定底层 FwpmFilterAdd0 调用 0 次（报告面只判定、不安装 —— 与"没了过滤器还报已强制"对照）',
  fakeReport.calls.filter((name) => name === 'filterAdd').length === 0,
  `calls=[${fakeReport.calls.join(',')}]`,
)
check(
  '2k(D2) 该次判定也没有把伪造的 {installed:[6]} 当成 enforced 的理由（结果 JSON 里没有 enforced true）',
  !JSON_TEXT(forgedReport).includes('"enforced":true'),
  JSON_TEXT(forgedReport),
)

// (f) 正例：真证据经能力报告面仍然能到 enforced:true（证明上面的降级不是"恒 false"）
const fakeReportGenuine = makeFakeWfp()
const installedReport = installNetworkPolicy({ api: fakeReportGenuine.api, plan: planA, guids: GUIDS })
const genuineReport = capabilityDimensions({
  networkTier: 'OFFLINE',
  networkBindings: fakeReportGenuine.api,
  networkGuids: GUIDS,
  networkProbe: { available: true, status: 0, detail: '离线替身：引擎可开' },
  networkInstall: installedReport,
  networkAudit: installedReport.audit,
})
check(
  '2l(D2) 真证据经能力报告面 ⇒ enforced=true / verified=true（唯一的 enforced 路径仍然存在）',
  genuineReport.networkPolicy.enforced === true && genuineReport.networkPolicy.verified === true,
  JSON_TEXT(genuineReport.networkPolicy),
)
check(
  '2l(D2) 正例确实调用了 6 次 FwpmFilterAdd0（"已强制"有真实安装动作背书）',
  fakeReportGenuine.calls.filter((name) => name === 'filterAdd').length === 6,
  `filterAdd=${fakeReportGenuine.calls.filter((name) => name === 'filterAdd').length}`,
)

// ═══════════════════════ 3c. N1/N2：安装记录是不可变证据（指纹 + 冻结快照）═══════════════════════
// 第二轮独立审计发现（`[实测]` 于那一次会话，本文件修复前也已在本机复现，见修复注释）：
//   N1：记录里存活 `audit` 对象 ⇒ 真实安装（无枚举入口，verified:false）之后
//       执行 `inst.audit.verified = true`，再 resolve 就变成 verified:true（fail-open）。
//   N2：记录里存活 `plan` 对象 ⇒ 就地改 `inst.plan.*` 成另一个计划，就能让
//       "同计划"校验通过并报 enforced:true（那个计划从未被安装过）。
// 修复：记录只存**计划指纹**（安装时算好的字符串）与**审计冻结快照**，并按内容比对调用方回传的 audit。
section('3c. N1/N2：记录按指纹 + 冻结快照判定，事后篡改活对象不得升级/冒名')

// (a) N1：无枚举入口的真实安装（audit.verified=false）之后篡改 inst.audit
const fakeN1 = makeFakeWfp({ enumeration: 'none' })
const planN1 = planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS })
const installedN1 = installNetworkPolicy({ api: fakeN1.api, plan: planN1, guids: GUIDS })
check(
  '2m(N1) 前置：无枚举入口的真实安装 ⇒ audit.verified=false / reason=enumeration-unavailable',
  installedN1.audit.verified === false && installedN1.audit.reason === ENUMERATION_UNAVAILABLE_REASON,
  JSON_TEXT(installedN1.audit),
)
const n1BeforeWithAudit = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeN1.api,
  guids: GUIDS,
  install: installedN1,
  audit: installedN1.audit,
})
check(
  '2m(N1) 篡改前（带 audit）⇒ enforced=true / verified=false（已强制但未独立验证）',
  n1BeforeWithAudit.state === NETWORK_TIER_STATES.ENFORCED &&
    n1BeforeWithAudit.enforced === true &&
    n1BeforeWithAudit.verified === false,
  JSON_TEXT({ state: n1BeforeWithAudit.state, enforced: n1BeforeWithAudit.enforced, verified: n1BeforeWithAudit.verified }),
)
// 篡改活对象：verified 与 reason 一起改，证明判定读的是冻结快照而不是这个对象
installedN1.audit.verified = true
installedN1.audit.reason = 'forged-verified'
const n1AfterWithAudit = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeN1.api,
  guids: GUIDS,
  install: installedN1,
  audit: installedN1.audit,
})
check(
  '2m(N1) 篡改 inst.audit.verified=true 后带 audit 再解析 ⇒ verified 仍是 false（不得升级成"已核对"）',
  n1AfterWithAudit.verified === false,
  `verified=${n1AfterWithAudit.verified} reason=${n1AfterWithAudit.reason}`,
)
check(
  '2m(N1) 该次判定 fail-closed 到 not-enforced / enforced=false，且 reason=audit-mismatch（篡改被识破）',
  n1AfterWithAudit.state === NETWORK_TIER_STATES.NOT_ENFORCED &&
    n1AfterWithAudit.enforced === false &&
    /audit-mismatch/.test(n1AfterWithAudit.reason),
  `state=${n1AfterWithAudit.state} enforced=${n1AfterWithAudit.enforced} reason=${n1AfterWithAudit.reason}`,
)
const n1AfterNoAudit = resolvePolicy({ requested: 'OFFLINE', api: fakeN1.api, guids: GUIDS, install: installedN1 })
check(
  '2m(N1) 不带 audit 再解析 ⇒ 判定仍来自冻结快照（enforced=true / verified=false），活对象篡改不改判定来源',
  n1AfterNoAudit.state === NETWORK_TIER_STATES.ENFORCED &&
    n1AfterNoAudit.enforced === true &&
    n1AfterNoAudit.verified === false,
  JSON_TEXT({ state: n1AfterNoAudit.state, enforced: n1AfterNoAudit.enforced, verified: n1AfterNoAudit.verified }),
)

// (b) N1：把 inst.audit **整个换掉**（换成另一个对象）
const fakeN1b = makeFakeWfp({ enumeration: 'none' })
const installedN1b = installNetworkPolicy({
  api: fakeN1b.api,
  plan: planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS }),
  guids: GUIDS,
})
installedN1b.audit = { verified: true, reason: 'forged', installed: true, filterCount: 6 }
const n1bForged = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeN1b.api,
  guids: GUIDS,
  install: installedN1b,
  audit: installedN1b.audit,
})
check(
  '2n(N1) 用另一个 {verified:true} 对象替换 inst.audit ⇒ not-enforced / enforced=false / verified=false',
  n1bForged.state === NETWORK_TIER_STATES.NOT_ENFORCED && n1bForged.enforced === false && n1bForged.verified === false,
  `state=${n1bForged.state} enforced=${n1bForged.enforced} reason=${n1bForged.reason}`,
)
// 换成一个"判定字段与快照一致"的对象：不报 mismatch，但判定仍只读快照（verified=false）
const fakeN1c = makeFakeWfp({ enumeration: 'none' })
const installedN1c = installNetworkPolicy({
  api: fakeN1c.api,
  plan: planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS }),
  guids: GUIDS,
})
installedN1c.audit = {
  verified: false,
  reason: ENUMERATION_UNAVAILABLE_REASON,
  installed: false,
  filterCount: 0,
}
const n1cSwapped = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeN1c.api,
  guids: GUIDS,
  install: installedN1c,
  audit: installedN1c.audit,
})
check(
  '2n(N1) 替换成"判定字段与快照一致"的 audit ⇒ 仍按快照判定（enforced=true / verified=false，快照是唯一权威）',
  n1cSwapped.enforced === true && n1cSwapped.verified === false,
  JSON_TEXT({ state: n1cSwapped.state, enforced: n1cSwapped.enforced, verified: n1cSwapped.verified }),
)

// (c) N2：把 inst.plan 就地改成 app-identifier 计划，再按 target:'app-identifier' 解析
const fakeN2 = makeFakeWfp()
const installedN2 = installNetworkPolicy({
  api: fakeN2.api,
  plan: planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS }),
  guids: GUIDS,
})
const appIdentifierPlan = planOfflineRules({ tier: 'OFFLINE', target: 'app-identifier', guids: GUIDS_APP_IDENTIFIER })
const n2Unmutated = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeN2.api,
  guids: GUIDS_APP_IDENTIFIER,
  target: 'app-identifier',
  install: installedN2,
  audit: installedN2.audit,
})
check(
  '2o(N2) 计划未被篡改时按 app-identifier 解析 ⇒ plan-mismatch / not-enforced（没装过的计划不得被采信）',
  n2Unmutated.state === NETWORK_TIER_STATES.NOT_ENFORCED &&
    n2Unmutated.enforced === false &&
    /plan-mismatch/.test(n2Unmutated.reason),
  `state=${n2Unmutated.state} enforced=${n2Unmutated.enforced} reason=${n2Unmutated.reason}`,
)
installedN2.plan.filters = appIdentifierPlan.filters
installedN2.plan.target = 'app-identifier'
installedN2.plan.subLayerKey = appIdentifierPlan.subLayerKey
const n2Mutated = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeN2.api,
  guids: GUIDS_APP_IDENTIFIER,
  target: 'app-identifier',
  install: installedN2,
  audit: installedN2.audit,
})
check(
  '2o(N2) 就地篡改 inst.plan.filters/target/subLayerKey 后同 target 再解析 ⇒ 仍是 plan-mismatch，绝不 enforced:true',
  n2Mutated.state === NETWORK_TIER_STATES.NOT_ENFORCED &&
    n2Mutated.enforced === false &&
    n2Mutated.verified === false &&
    /plan-mismatch/.test(n2Mutated.reason),
  `state=${n2Mutated.state} enforced=${n2Mutated.enforced} verified=${n2Mutated.verified} reason=${n2Mutated.reason}`,
)
const n2MutatedOriginalTarget = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeN2.api,
  guids: GUIDS,
  install: installedN2,
  audit: installedN2.audit,
})
check(
  '2o(N2) 同一份被篡改的活计划按**原 target** 解析 ⇒ 判定只认请求侧计划（enforced=true / verified=true，篡改既不冒名也不破坏）',
  n2MutatedOriginalTarget.state === NETWORK_TIER_STATES.ENFORCED &&
    n2MutatedOriginalTarget.enforced === true &&
    n2MutatedOriginalTarget.verified === true,
  JSON_TEXT({
    state: n2MutatedOriginalTarget.state,
    enforced: n2MutatedOriginalTarget.enforced,
    verified: n2MutatedOriginalTarget.verified,
  }),
)

// (d) 正例：未篡改的真实证据仍然能到 enforced:true / verified:true
const fakePositive = makeFakeWfp()
const installedPositive = installNetworkPolicy({
  api: fakePositive.api,
  plan: planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS }),
  guids: GUIDS,
})
const positive = resolvePolicy({
  requested: 'OFFLINE',
  api: fakePositive.api,
  guids: GUIDS,
  install: installedPositive,
  audit: installedPositive.audit,
})
check(
  '2p(正例) 未篡改的真实证据仍能到 enforced=true / verified=true（证明上面的拒绝不是"恒 false"）',
  positive.state === NETWORK_TIER_STATES.ENFORCED && positive.enforced === true && positive.verified === true,
  JSON_TEXT({ state: positive.state, enforced: positive.enforced, verified: positive.verified }),
)
check(
  '2p(正例) 正例确实调用过 6 次 FwpmFilterAdd0（enforced 有真实安装动作背书）',
  fakePositive.calls.filter((name) => name === 'filterAdd').length === 6,
  `filterAdd=${fakePositive.calls.filter((name) => name === 'filterAdd').length}`,
)
// 冻结快照的第二个方向：调用方清空返回值上的 installed/filterIds 也改不动"已装上 6 条"
const fakeImmutable = makeFakeWfp()
const installedImmutable = installNetworkPolicy({
  api: fakeImmutable.api,
  plan: planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS }),
  guids: GUIDS,
})
installedImmutable.installed.length = 0
installedImmutable.filterIds.length = 0
const stillEnforced = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeImmutable.api,
  guids: GUIDS,
  install: installedImmutable,
  audit: installedImmutable.audit,
})
check(
  '2p(正例) 调用方清空返回值上的 installed/filterIds 也改不动计数（记录用冻结快照，不是那个数组）',
  stillEnforced.enforced === true && stillEnforced.verified === true,
  JSON_TEXT({ state: stillEnforced.state, enforced: stillEnforced.enforced, verified: stillEnforced.verified }),
)

// (g) 直接测 auditNetworkPolicy：按 key 回读全部落空
const fakeEmptyReadback = makeFakeWfp({ enumReturnsEmpty: true })
fakeEmptyReadback.seed(planA, GUIDS)
const auditEmpty = auditNetworkPolicy({ api: fakeEmptyReadback.api, engine: { handle: 1n }, plan: planA, guids: GUIDS })
check(
  '2g 按 key 回读全部落空 ⇒ installed=false / verified=false',
  auditEmpty.installed === false && auditEmpty.verified === false,
  `installed=${auditEmpty.installed} verified=${auditEmpty.verified}`,
)
check('2g reason=filters-missing:0/6（缺多少说多少）', auditEmpty.reason.startsWith('filters-missing:0/6'), auditEmpty.reason)

// (h) 枚举返回 0 条过滤器
const fakeEnumEmpty = makeFakeWfp({ enumeration: 'enum', enumReturnsEmpty: true })
fakeEnumEmpty.seed(planA, GUIDS)
const auditEnumEmpty = auditNetworkPolicy({ api: fakeEnumEmpty.api, engine: { handle: 1n }, plan: planA, guids: GUIDS })
check(
  '2h FwpmFilterEnum0 返回 0 条过滤器 ⇒ verified=false / filterCount=0',
  auditEnumEmpty.verified === false && auditEnumEmpty.filterCount === 0,
  `verified=${auditEnumEmpty.verified} filterCount=${auditEnumEmpty.filterCount}`,
)

// (i) 无引擎
const auditNoEngine = auditNetworkPolicy({ api: fakeEnumEmpty.api, engine: null, plan: planA })
check(
  "2i 没有引擎 ⇒ reason='no-engine' / verified=false",
  auditNoEngine.verified === false && auditNoEngine.reason === 'no-engine',
  auditNoEngine.reason,
)

// (j) 回读项缺 layerKey ⇒ installed 但 verified=false
const fakeOmitFields = makeFakeWfp({ enumOmitFields: true })
fakeOmitFields.seed(planA, GUIDS)
const auditOmitFields = auditNetworkPolicy({ api: fakeOmitFields.api, engine: { handle: 1n }, plan: planA, guids: GUIDS })
check(
  "2j 回读项缺 layerKey ⇒ installed=true 但 verified=false / reason='enumeration-fields-incomplete'（不猜）",
  auditOmitFields.installed === true && auditOmitFields.verified === false && auditOmitFields.reason === 'enumeration-fields-incomplete',
  `installed=${auditOmitFields.installed} reason=${auditOmitFields.reason}`,
)

// (k) 回读层 GUID 不一致
const fakeWrongLayer = makeFakeWfp({ enumWrongLayer: true })
fakeWrongLayer.seed(planA, GUIDS)
const auditWrongLayer = auditNetworkPolicy({ api: fakeWrongLayer.api, engine: { handle: 1n }, plan: planA, guids: GUIDS })
check(
  "2k 回读的 layerKey 与 guids 不一致 ⇒ verified=false / reason='filter-fields-mismatch'",
  auditWrongLayer.verified === false && auditWrongLayer.reason === 'filter-fields-mismatch',
  `verified=${auditWrongLayer.verified} reason=${auditWrongLayer.reason}`,
)

// (k2) 不给 guids 时不得假装核对过层
const fakeNoGuidsAudit = makeFakeWfp()
fakeNoGuidsAudit.seed(planA, GUIDS)
const auditNoGuids = auditNetworkPolicy({ api: fakeNoGuidsAudit.api, engine: { handle: 1n }, plan: planA })
check(
  '2k2 不给 guids 时 layerChecked=false（语义键名翻不成 GUID，就不声称核对过层）',
  auditNoGuids.layerChecked === false && auditNoGuids.verified === true,
  `layerChecked=${auditNoGuids.layerChecked} verified=${auditNoGuids.verified}`,
)

// (l) 回读抛错
const fakeEnumThrows = makeFakeWfp({ enumThrows: true })
const auditThrows = auditNetworkPolicy({ api: fakeEnumThrows.api, engine: { handle: 1n }, plan: planA })
check(
  '2l 回读抛错 ⇒ verified=false 且 reason 以 enumeration-failed 开头（不吞错、不当作通过）',
  auditThrows.verified === false && auditThrows.reason.startsWith('enumeration-failed'),
  auditThrows.reason,
)

// ═══════════════════════ 3d. R3-1：指纹覆盖计划真正消费的 GUID / 条件值 ═══════════════════════
// 第三轮复核 R3-1（`[实测]` 于那一次复核会话，脚本已按该报告删除）：以 GA 的 guids
// （`ALE_PACKAGE_ID=aaaa…` / `targetValue=0x2000`）真安装后，再以 GB 的 guids（`dddd…` /
// `0x9999`，层 GUID 也不同）解析**同一份证据**，仍得 `enforced:true / verified:true` ——
// 旧指纹只覆盖计划结构，不覆盖会写进 BFE 的 GUID 值。下面 2q/2r 把修复后的判定钉死。
section('3d. R3-1：计划指纹覆盖 guids（层 GUID / 条件 GUID / targetValue），换 GUID 即 plan-mismatch')

const fakeR31 = makeFakeWfp()
const planR31 = planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS })
const installedR31 = installNetworkPolicy({ api: fakeR31.api, plan: planR31, guids: GUIDS })
const r31ConditionBuffers = fakeR31.filterRecords.map((record) => fakeR31.addressToBuffer.get(Number(record.conditionPointer)))
check(
  '2q(R3-1) 前提：安装字节里的条件 fieldKey 确为 GA 的 ALE_PACKAGE_ID（换 GUID 的复判比的是真装过的值）',
  r31ConditionBuffers.length === 6 &&
    r31ConditionBuffers.every(
      (buffer) =>
        Buffer.isBuffer(buffer) &&
        formatGuid(buffer.subarray(OFF_FILTER_CONDITION.fieldKey, OFF_FILTER_CONDITION.fieldKey + 16)) ===
          formatGuid(parseGuid(GUIDS.ALE_PACKAGE_ID)),
    ),
  `fieldKey=${GUIDS.ALE_PACKAGE_ID}`,
)
const r31Positive = resolvePolicy({
  requested: 'OFFLINE',
  api: fakeR31.api,
  guids: GUIDS,
  install: installedR31,
  audit: installedR31.audit,
})
check(
  '2q(R3-1) 正例：安装与复判用**同一份 guids** ⇒ enforced=true / verified=true（指纹不误伤真安装）',
  r31Positive.state === NETWORK_TIER_STATES.ENFORCED && r31Positive.enforced === true && r31Positive.verified === true,
  JSON_TEXT({ state: r31Positive.state, enforced: r31Positive.enforced, verified: r31Positive.verified }),
)

// 三个维度各换一处（条件 GUID / 层 GUID / targetValue），以及三者齐换（R3-1 的原始复现形状）
const R31_SWAPPED_CONDITION_GUID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
const r31Variants = [
  ['条件 GUID（ALE_PACKAGE_ID aaaa… → dddd…）', { ...GUIDS, ALE_PACKAGE_ID: R31_SWAPPED_CONDITION_GUID }],
  ['层 GUID（ALE_AUTH_CONNECT_V4 → eeee…）', { ...GUIDS, ALE_AUTH_CONNECT_V4: WRONG_LAYER_GUID }],
  ['targetValue（0x2000 → 0x9999）', { ...GUIDS, targetValue: 0x9999n }],
  [
    '三者齐换（dddd… / eeee… / 0x9999）',
    { ...GUIDS, ALE_PACKAGE_ID: R31_SWAPPED_CONDITION_GUID, ALE_AUTH_CONNECT_V4: WRONG_LAYER_GUID, targetValue: 0x9999n },
  ],
]
for (const [label, swappedGuids] of r31Variants) {
  const r31Swapped = resolvePolicy({
    requested: 'OFFLINE',
    api: fakeR31.api,
    guids: swappedGuids,
    install: installedR31,
    audit: installedR31.audit,
  })
  check(
    `2r(R3-1) 真安装后换成「${label}」再解析 ⇒ plan-mismatch / not-enforced / enforced=false`,
    r31Swapped.state === NETWORK_TIER_STATES.NOT_ENFORCED &&
      r31Swapped.enforced === false &&
      r31Swapped.verified === false &&
      /plan-mismatch/.test(r31Swapped.reason),
    `state=${r31Swapped.state} enforced=${r31Swapped.enforced} verified=${r31Swapped.verified}`,
  )
}
check(
  '2r(R3-1) 四个换 GUID 的变体里没有任何一个结果含 "enforced":true（机器可判定的 fail-closed 形式）',
  r31Variants.every(([, swappedGuids]) => {
    const result = resolvePolicy({
      requested: 'OFFLINE',
      api: fakeR31.api,
      guids: swappedGuids,
      install: installedR31,
      audit: installedR31.audit,
    })
    return !JSON_TEXT(result).includes('"enforced":true')
  }),
  `变体数=${r31Variants.length}`,
)

// ═══════════════════════ 3e. R3-2：拆除走安装时定住的引擎凭据 ═══════════════════════
// 第三轮复核 R3-2（`[实测]` 于那一次复核会话）：改写 `result.engine.close` 后 `teardown()`
// 报 `engineClosed:true / failures:[]`，而真实 `FwpmEngineClose0` **调用 0 次**（只影响拆除
// 报告的真实性）。修复后拆除走安装时 `bind` 并 `Object.freeze` 的 `engineCloser`，
// **不读**可变的 `result.engine`；关闭真失败时 `failures` 必须如实。
section('3e. R3-2：teardown 走安装时定住的引擎凭据（改写 inst.engine 不得伪造"已关闭"）')

const fakeR32 = makeFakeWfp()
const installedR32 = installNetworkPolicy({
  api: fakeR32.api,
  plan: planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS }),
  guids: GUIDS,
})
const r32RealCloseCallsBefore = fakeR32.calls.filter((name) => name === 'engineClose').length
let r32ForgedCloseCalls = 0
const forgedClose = () => {
  r32ForgedCloseCalls += 1
  return { failures: [] }
}
// 攻击：改写返回值上的关闭函数，再把句柄置空、最后整体替换 engine 对象（三种都试一遍）
installedR32.engine.close = forgedClose
installedR32.engine.handle = null
installedR32.engine = { handle: null, close: forgedClose }
const teardownR32 = installedR32.teardown()
const r32RealCloseCallsAfter = fakeR32.calls.filter((name) => name === 'engineClose').length
check(
  '2s(R3-2) 改写 inst.engine.close / 整体替换 inst.engine 后 teardown() 仍真实调用 FwpmEngineClose0（假函数一次都没跑）',
  r32ForgedCloseCalls === 0 && r32RealCloseCallsAfter === r32RealCloseCallsBefore + 1 && teardownR32.engineClosed === true,
  `forged=${r32ForgedCloseCalls} realClose=${r32RealCloseCallsAfter} engineClosed=${teardownR32.engineClosed}`,
)
check(
  '2s(R3-2) 同一份拆除仍保持"删 6 条 + 删 sublayer + 关引擎"且 failures 诚实为空、主机零残留',
  teardownR32.removed.length === 6 &&
    teardownR32.subLayerRemoved === true &&
    teardownR32.failures.length === 0 &&
    fakeR32.host.filters.size === 0 &&
    fakeR32.host.subLayers.size === 0,
  JSON_TEXT({
    removed: teardownR32.removed.length,
    subLayerRemoved: teardownR32.subLayerRemoved,
    failures: teardownR32.failures,
    filters: fakeR32.host.filters.size,
    subLayers: fakeR32.host.subLayers.size,
  }),
)
check(
  '2s(R3-2) 删除顺序仍是安装顺序的逆序（修复没有打乱拆除次序）',
  fakeR32.deleteOrder.map(String).join(',') === [...fakeR32.addedOrder].reverse().map(String).join(','),
  `delete=${fakeR32.deleteOrder.map(String).join(',')}`,
)
const teardownR32Again = installedR32.teardown()
check(
  '2s(R3-2) 修复后 teardown 仍幂等（第二次 skipped 且不再新增任何引擎关闭调用）',
  teardownR32Again.skipped === true && fakeR32.calls.filter((name) => name === 'engineClose').length === r32RealCloseCallsAfter,
  `skipped=${teardownR32Again.skipped} realClose=${fakeR32.calls.filter((name) => name === 'engineClose').length}`,
)

// 诚实性方向：真实关闭失败时不得报"已关闭"
const fakeR32Fail = makeFakeWfp({ closeThrows: true })
const installedR32Fail = installNetworkPolicy({
  api: fakeR32Fail.api,
  plan: planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS }),
  guids: GUIDS,
})
const teardownR32Fail = installedR32Fail.teardown()
check(
  '2t(R3-2) FwpmEngineClose0 真的抛错 ⇒ engineClosed=false 且 failures 如实点名（拆除报告不撒谎）',
  teardownR32Fail.engineClosed === false &&
    teardownR32Fail.failures.some((text) => text.includes('FwpmEngineClose0')) &&
    teardownR32Fail.removed.length === 6,
  JSON_TEXT({ engineClosed: teardownR32Fail.engineClosed, failures: teardownR32Fail.failures }),
)

// ═══════════════════════ 4. 不变量 3：失败 ⇒ 零残留 ═══════════════════════
section('4. 不变量 3：安装中途失败 ⇒ 主机零残留（best-effort 拆除确实跑了）')

// (a) 第 3 条 filter 添加失败
const fakeMidFail = makeFakeWfp({ failFilterAddAt: 3 })
let midFailError = null
try {
  installNetworkPolicy({ api: fakeMidFail.api, plan: planA, guids: GUIDS })
} catch (error) {
  midFailError = error
}
check(
  '3a 中途失败抛类型化错误 NETWORK_POLICY_INSTALL_FAILED',
  midFailError?.code === 'NETWORK_POLICY_INSTALL_FAILED',
  `code=${midFailError?.code}`,
)
check(
  '3a stage=apply 且 originalCode=WFP_FILTER_ADD_FAILED（保留根因）',
  midFailError?.stage === 'apply' && midFailError?.originalCode === 'WFP_FILTER_ADD_FAILED',
  `stage=${midFailError?.stage} originalCode=${midFailError?.originalCode}`,
)
check('3a 主机上零残留过滤器', fakeMidFail.host.filters.size === 0, `filters=${fakeMidFail.host.filters.size}`)
check('3a 主机上零残留 sublayer', fakeMidFail.host.subLayers.size === 0, `subLayers=${fakeMidFail.host.subLayers.size}`)
check(
  '3a 引擎已关闭（DYNAMIC 会话清理这道兜底也执行了）',
  fakeMidFail.calls.includes('engineClose'),
  `calls=[${fakeMidFail.calls.join(',')}]`,
)
check(
  '3a error.installed 为空（applyOfflinePlan 已自行回滚，拆除阶段没有遗留 id）',
  Array.isArray(midFailError?.installed) && midFailError.installed.length === 0,
  JSON_TEXT(midFailError?.installed),
)
check(
  '3a error.teardownFailures 为空（拆除本身没有失败）',
  Array.isArray(midFailError?.teardownFailures) && midFailError.teardownFailures.length === 0,
  JSON_TEXT(midFailError?.teardownFailures),
)
check(
  '3a 拆除阶段确实又删了一次 sublayer（幂等：applyOfflinePlan 已删过，返回 NOT_FOUND 视为成功）',
  fakeMidFail.subLayerDeleteArgs.length === 2,
  `subLayerDelete 次数=${fakeMidFail.subLayerDeleteArgs.length}`,
)
check(
  '3a policyTeardown 里 engineClosed=true、failures 为空',
  midFailError?.policyTeardown?.engineClosed === true && midFailError.policyTeardown.failures.length === 0,
  JSON_TEXT(midFailError?.policyTeardown),
)

// (b) 安装成功但回读核对发现少了一条 ⇒ 立即全量拆除
const fakeVerifyFail = makeFakeWfp({ hideFilterKeyFromEnum: planA.filters[2].key })
let verifyFailError = null
try {
  installNetworkPolicy({ api: fakeVerifyFail.api, plan: planA, guids: GUIDS })
} catch (error) {
  verifyFailError = error
}
check(
  '3b 回读核对失败 ⇒ 抛 NETWORK_POLICY_VERIFY_FAILED（不留下"看起来装上了"的过滤器）',
  verifyFailError?.code === 'NETWORK_POLICY_VERIFY_FAILED',
  `code=${verifyFailError?.code} reason=${verifyFailError?.audit?.reason}`,
)
check(
  '3b 6 个已知 filterId 被逐个删除（有 id 就必须按 id 删）',
  fakeVerifyFail.deleteOrder.length === 6,
  `deletes=${fakeVerifyFail.deleteOrder.length}`,
)
check(
  '3b 删除顺序 = 安装顺序的逆序',
  fakeVerifyFail.deleteOrder.map(String).join(',') === [...fakeVerifyFail.addedOrder].reverse().map(String).join(','),
  `delete=${fakeVerifyFail.deleteOrder.map(String).join(',')} add=${fakeVerifyFail.addedOrder.map(String).join(',')}`,
)
check(
  '3b 主机零残留且引擎已关闭',
  fakeVerifyFail.host.filters.size === 0 && fakeVerifyFail.host.subLayers.size === 0 && fakeVerifyFail.calls.includes('engineClose'),
  `filters=${fakeVerifyFail.host.filters.size} subLayers=${fakeVerifyFail.host.subLayers.size}`,
)
check(
  '3b error.installed 记录 6 个已回滚的 id（拆除过程可审计）',
  verifyFailError?.installed?.length === 6,
  JSON_TEXT(verifyFailError?.installed),
)

// (c) 成功路径的 teardown 幂等
const fakeTeardown = makeFakeWfp()
const installedT = installNetworkPolicy({ api: fakeTeardown.api, plan: planA, guids: GUIDS })
const teardown1 = installedT.teardown()
check(
  '3c teardown() 清空主机状态',
  fakeTeardown.host.filters.size === 0 && fakeTeardown.host.subLayers.size === 0,
  `filters=${fakeTeardown.host.filters.size} subLayers=${fakeTeardown.host.subLayers.size}`,
)
check(
  '3c teardown() 报告 removed=6 / engineClosed=true / failures 为空',
  teardown1.removed.length === 6 && teardown1.engineClosed === true && teardown1.failures.length === 0,
  JSON_TEXT({ removed: teardown1.removed.length, engineClosed: teardown1.engineClosed, failures: teardown1.failures }),
)
const teardown2 = installedT.teardown()
check(
  '3c teardown() 幂等：第二次 skipped 且不新增删除调用',
  teardown2.skipped === true && fakeTeardown.deleteOrder.length === 6,
  `skipped=${teardown2.skipped} deletes=${fakeTeardown.deleteOrder.length}`,
)

// (d) 缺"关闭引擎"能力 ⇒ 连装都不装
const fakeNoClose = makeFakeWfp({ omit: ['fwpmEngineClose0'] })
let noCloseError = null
try {
  installNetworkPolicy({ api: fakeNoClose.api, plan: planA, guids: GUIDS })
} catch (error) {
  noCloseError = error
}
check(
  '3d 缺 fwpmEngineClose0 ⇒ 拒绝开始安装（stage=precondition）',
  noCloseError?.code === 'NETWORK_POLICY_INSTALL_FAILED' && noCloseError?.stage === 'precondition',
  `code=${noCloseError?.code} stage=${noCloseError?.stage}`,
)
check('3d 拒绝时一次 Win32 调用都没有', fakeNoClose.calls.length === 0, `calls=[${fakeNoClose.calls.join(',')}]`)

// ═══════════════════════ 5. 不变量 4：非 OFFLINE ⇒ NOT_IMPLEMENTED ═══════════════════════
section('5. 不变量 4：CONTROLLED_ONLINE / OBSERVED_ONLINE ⇒ not-implemented（明确，且不阻断）')

for (const tier of ['CONTROLLED_ONLINE', 'OBSERVED_ONLINE']) {
  const result = resolvePolicy({ requested: tier })
  check(`4 ${tier} ⇒ state=not-implemented`, result.state === 'not-implemented', `state=${result.state}`)
  check(`4 ${tier} ⇒ enforced=false（不作阻断声明，故允许执行）`, result.enforced === false, `enforced=${result.enforced}`)
  check(
    `4 ${tier} ⇒ reason 点名"未实现"与 WFP_TIER_NOT_IMPLEMENTED`,
    result.reason.includes('未实现') && result.reason.includes('WFP_TIER_NOT_IMPLEMENTED'),
    result.reason,
  )
  check(
    `4 ${tier} ⇒ plan=null 且 JSON 里没有 enforced true`,
    result.plan === null && !JSON_TEXT(result).includes('"enforced":true'),
    `plan=${result.plan}`,
  )
  checkThrows(
    `4 ${tier} ⇒ planOfflineRules 确实抛 WFP_TIER_NOT_IMPLEMENTED（本模块只如实转述，不吞也不静默放行）`,
    () => planOfflineRules({ tier, guids: GUIDS }),
    'WFP_TIER_NOT_IMPLEMENTED',
  )
}

// ═══════════════════════ 6. 不变量 5：稳定 key ═══════════════════════
section('6. 不变量 5：同输入 ⇒ 同 subLayerKey / 同 filter key')

const planStable1 = planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS })
const planStable2 = planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS })
check('5 subLayerKey 稳定', planStable1.subLayerKey === planStable2.subLayerKey, planStable1.subLayerKey)
check(
  '5 六个 filter key 稳定且两两不同',
  planStable1.filters.map((f) => f.key).join(',') === planStable2.filters.map((f) => f.key).join(',') &&
    new Set(planStable1.filters.map((f) => f.key)).size === 6,
  planStable1.filters.map((f) => f.key).join(','),
)

const fakeStable1 = makeFakeWfp()
const fakeStable2 = makeFakeWfp()
const installedS1 = installNetworkPolicy({ api: fakeStable1.api, plan: planStable1, guids: GUIDS })
const installedS2 = installNetworkPolicy({ api: fakeStable2.api, plan: planStable2, guids: GUIDS })
check(
  '5 两次安装的 subLayerKey 相同且等于计划值',
  installedS1.subLayerKey === installedS2.subLayerKey && installedS1.subLayerKey === planStable1.subLayerKey,
  installedS1.subLayerKey,
)
check(
  '5 两次安装送进 FwpmFilterAdd0 的 filterKey 序列完全相同',
  fakeStable1.filterRecords.map((r) => r.key).join(',') === fakeStable2.filterRecords.map((r) => r.key).join(','),
  fakeStable1.filterRecords.map((r) => r.key).join(','),
)
check(
  '5 送进引擎的 filterKey 序列 === planOfflineRules 的 key 序列（证明没有另写一套规划）',
  fakeStable1.filterRecords.map((r) => r.key).join(',') === planStable1.filters.map((f) => f.key).join(','),
  'filterKey 序列逐项一致',
)
check(
  '5 installNetworkPolicy 回显的 plan 与 planOfflineRules 输出逐字节一致（JSON 相等）',
  JSON_TEXT(installedS1.plan) === JSON_TEXT(planStable1),
  `bytes=${JSON_TEXT(installedS1.plan).length}`,
)
const frozenPlan = deepFreeze(planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS }))
const fakeFrozen = makeFakeWfp()
let frozenError = null
try {
  installNetworkPolicy({ api: fakeFrozen.api, plan: frozenPlan, guids: GUIDS })
} catch (error) {
  frozenError = error
}
check(
  '5 深冻结的计划仍能安装 ⇒ 安装路径不修改计划（严格模式下改动会抛错）',
  frozenError === null && fakeFrozen.filterRecords.length === 6,
  frozenError === null ? '6 条已安装' : frozenError.message,
)

// ═══════════════════════ 7. 调用顺序 / 参数形状 / 缓冲区尺寸 ═══════════════════════
section('7. 调用顺序、参数形状与缓冲区尺寸（逐项与 src/wfp.mjs 的布局常量对齐）')

const fakeOrder = makeFakeWfp()
const planOrder = planOfflineRules({ tier: 'OFFLINE', target: 'appcontainer', guids: GUIDS })
resolvePolicy({ requested: 'OFFLINE', api: fakeOrder.api, guids: GUIDS })
check(
  '7 resolve 只用 open/close 探测引擎（探测 + 引擎可开性确认），不改任何系统状态',
  fakeOrder.calls.join(',') === 'engineOpen,engineClose,engineOpen,engineClose',
  `calls=[${fakeOrder.calls.join(',')}]`,
)

fakeOrder.calls.length = 0
const installedOrder = installNetworkPolicy({ api: fakeOrder.api, plan: planOrder, guids: GUIDS })
check(
  '7 安装顺序 = engineOpen → subLayerAdd → filterAdd×6 → filterGetByKey×6（先建 sublayer，再逐条装，最后回读）',
  fakeOrder.calls.join(',') ===
    ['engineOpen', 'subLayerAdd', ...Array(6).fill('filterAdd'), ...Array(6).fill('filterGetByKey')].join(','),
  `calls=[${fakeOrder.calls.join(',')}]`,
)
fakeOrder.calls.length = 0
installedOrder.teardown()
check(
  '7 拆除顺序 = filterDelete×6 → subLayerDelete → engineClose（先摘过滤器，再删组，最后关会话）',
  fakeOrder.calls.join(',') === [...Array(6).fill('filterDelete'), 'subLayerDelete', 'engineClose'].join(','),
  `calls=[${fakeOrder.calls.join(',')}]`,
)
check('7 全程所有调用的参数形状校验通过（violations 为空）', fakeOrder.violations.length === 0, JSON_TEXT(fakeOrder.violations))

const shapeRecords = fakeOrder.filterRecords
check(
  `7 每条 filter 缓冲区 = ${FWPM_FILTER0_SIZE} 字节（FWPM_FILTER0）`,
  shapeRecords.length === 6 && shapeRecords.every((r) => r.length === FWPM_FILTER0_SIZE),
  `lengths=[${shapeRecords.map((r) => r.length).join(',')}]`,
)
check(
  '7 每条 filter 的 filterKey === plan.filters[i].key（顺序一致）',
  shapeRecords.every((r, i) => r.key === planOrder.filters[i].key),
  shapeRecords.map((r) => r.key).join(','),
)
check(
  '7 每条 filter 的 layerKey === guids[rule.layerKey]',
  shapeRecords.every((r, i) => r.layerKey === formatGuid(parseGuid(GUIDS[planOrder.filters[i].layerKey]))),
  shapeRecords.map((r) => r.layerKey).join(','),
)
check(
  '7 每条 filter 的 subLayerKey === plan.subLayerKey（不落进默认 sublayer，否则整组删不掉）',
  shapeRecords.every((r) => r.subLayerKey === planOrder.subLayerKey),
  planOrder.subLayerKey,
)
check(
  '7 numFilterConditions=1 且 filterCondition 指针非 0、能解析回一个 40 字节条件数组',
  shapeRecords.every(
    (r) =>
      r.numConditions === 1 &&
      r.conditionPointer !== 0n &&
      Buffer.isBuffer(fakeOrder.addressToBuffer.get(Number(r.conditionPointer))) &&
      fakeOrder.addressToBuffer.get(Number(r.conditionPointer)).length === FWPM_FILTER_CONDITION0_SIZE,
  ),
  `counts=[${shapeRecords.map((r) => r.numConditions).join(',')}]`,
)
check(
  '7 action.type === FWP_ACTION_BLOCK 且 action 的 filterType/calloutKey 并集为 0',
  shapeRecords.every((r) => r.actionType === FWP_ACTION_TYPE.FWP_ACTION_BLOCK && r.actionGuidIsZero === true),
  `actions=[${shapeRecords.map((r) => `0x${r.actionType.toString(16)}`).join(',')}]`,
)
check(
  '7 weight 的 data type === FWP_EMPTY（权重交给 BFE 决定，不写死）',
  shapeRecords.every((r) => r.weightType === FWP_DATA_TYPE.FWP_EMPTY),
  `weightTypes=[${shapeRecords.map((r) => r.weightType).join(',')}]`,
)
check(
  '7 flags=0、reserved@160=0、filterId@168=0、effectiveWeight@176=0（BFE 回填字段必须留空）',
  shapeRecords.every((r) => r.flags === 0 && r.reserved === 0n && r.filterIdField === 0n && r.effectiveWeight === 0n),
  `flags=[${shapeRecords.map((r) => r.flags).join(',')}]`,
)

const conditionBuffers = shapeRecords.map((r) => fakeOrder.addressToBuffer.get(Number(r.conditionPointer)))
check(
  '7 条件数组里 fieldKey === guids.ALE_PACKAGE_ID',
  conditionBuffers.every(
    (buf) => formatGuid(buf.subarray(OFF_FILTER_CONDITION.fieldKey, OFF_FILTER_CONDITION.fieldKey + 16)) === formatGuid(parseGuid(GUIDS.ALE_PACKAGE_ID)),
  ),
  GUIDS.ALE_PACKAGE_ID,
)
check(
  '7 条件 matchType === FWP_MATCH_EQUAL',
  conditionBuffers.every((buf) => buf.readUInt32LE(OFF_FILTER_CONDITION.matchType) === FWP_MATCH_TYPE.FWP_MATCH_EQUAL),
  `matchTypes=[${conditionBuffers.map((b) => b.readUInt32LE(OFF_FILTER_CONDITION.matchType)).join(',')}]`,
)
check(
  '7 条件值 data type === FWP_SID（target=appcontainer）且 SID 指针 === guids.targetValue',
  conditionBuffers.every((buf) => {
    const type = buf.readUInt32LE(OFF_FILTER_CONDITION.conditionValue + OFF_CONDITION_VALUE.type)
    const pointer = buf.readBigUInt64LE(OFF_FILTER_CONDITION.conditionValue + OFF_CONDITION_VALUE.value)
    return type === FWP_DATA_TYPE.FWP_SID && pointer === BigInt(GUIDS.targetValue)
  }),
  `types=[${conditionBuffers.map((b) => b.readUInt32LE(OFF_FILTER_CONDITION.conditionValue + OFF_CONDITION_VALUE.type)).join(',')}]`,
)

const subLayerRecord = fakeOrder.subLayerRecords[0]
check(
  `7 sublayer 缓冲区 = ${FWPM_SUBLAYER0_SIZE} 字节且 subLayerKey === plan.subLayerKey`,
  fakeOrder.subLayerRecords.length === 1 && subLayerRecord.length === FWPM_SUBLAYER0_SIZE && subLayerRecord.key === planOrder.subLayerKey,
  JSON_TEXT(subLayerRecord),
)
check(
  '7 sublayer 未带 FWPM_SUBLAYER_FLAG_PERSISTENT（不得跨 BFE 重启存活）',
  (subLayerRecord.flags & FWPM_SUBLAYER_FLAG_PERSISTENT) === 0,
  `flags=${subLayerRecord.flags}`,
)
check('7 sublayer displayData.name 指针非 0（宽字符串已 pin）', subLayerRecord.displayNamePointer !== 0n, String(subLayerRecord.displayNamePointer))

const pinnedBuffers = fakeOrder.pins.map((p) => p.buffer)
const wideStrings = pinnedBuffers.filter((buf) => ![16, 24, 40, 72, 192].includes(buf.length))
// pin 只用于**内嵌指针**：FWPM_FILTER0.filterCondition 指向的 40 字节条件数组，
// 以及 FWPM_DISPLAY_DATA0.name/description 指向的宽字符串。action/weight/displayData 是
// 内嵌结构体（字节拷贝进父结构），filter/sublayer 缓冲区本身由 retainPointer 持有 ——
// 它们**不应该**也不需要 pin（[官方] FWPM_FILTER0/FWPM_SUBLAYER0 的字段是内嵌还是指针）。
check(
  '7 pin 恰好 20 次：6 个 40 字节条件数组 + 14 个宽字符串；内嵌结构体一律不 pin',
  fakeOrder.pins.length === 20 && pinnedBuffers.filter((buf) => buf.length === 40).length === 6 && wideStrings.length === 14,
  `pins=${fakeOrder.pins.length} cond40=${pinnedBuffers.filter((buf) => buf.length === 40).length} wide=${wideStrings.length}`,
)
check(
  '7 宽字符串（displayData.name/description）共 14 个，且都以 NUL(0x0000) 结尾',
  wideStrings.length === 14 && wideStrings.every((buf) => buf.length % 2 === 0 && buf.readUInt16LE(buf.length - 2) === 0),
  `count=${wideStrings.length}`,
)
check(
  '7 FwpmFilterDeleteById0 收到 BigInt（filterId 是唯一删除凭据）',
  fakeOrder.deleteArgs.length === 6 && fakeOrder.deleteArgs.every((value) => typeof value === 'bigint'),
  `types=[${[...new Set(fakeOrder.deleteArgs.map((v) => typeof v))].join(',')}]`,
)
check(
  '7 FwpmSubLayerDeleteByKey0 收到 16 字节 key Buffer === plan.subLayerKey',
  fakeOrder.subLayerDeleteArgs.length === 1 &&
    Buffer.isBuffer(fakeOrder.subLayerDeleteArgs[0]) &&
    fakeOrder.subLayerDeleteArgs[0].length === 16 &&
    formatGuid(fakeOrder.subLayerDeleteArgs[0]) === planOrder.subLayerKey,
  `keys=${fakeOrder.subLayerDeleteArgs.length}`,
)

const retained = []
const fakeRetain = makeFakeWfp()
installNetworkPolicy({
  api: fakeRetain.api,
  plan: planOrder,
  guids: GUIDS,
  retainPointer: (kind, value) => retained.push({ kind, value }),
})
const retainedBuffers = retained.filter((item) => Buffer.isBuffer(item.value))
const retainedWrappers = retained.filter((item) => !Buffer.isBuffer(item.value))
check(
  "7 retainPointer 登记全部 keep() 产物（52 项，kind 均为 'wfp'）",
  retained.length === 52 && retained.every((item) => item.kind === 'wfp'),
  `retained=${retained.length}`,
)
check(
  '7 retainPointer 覆盖内嵌结构体（16/24/40/72 字节），并覆盖被 keep 的 buildFilter0 包装对象（其 .buffer 为 192 字节）',
  [16, 24, 40, 72].every((size) => retainedBuffers.some((item) => item.value.length === size)) &&
    retainedWrappers.length === 6 &&
    retainedWrappers.every((item) => item.value.buffer?.length === FWPM_FILTER0_SIZE),
  `buffers=${retainedBuffers.length} wrappers=${retainedWrappers.length}`,
)

// ═══════════════════════ 8. 报告层 ═══════════════════════
section('8. 报告层（日志一行摘要 / 能力报告结构化摘要）')

const descRefused = describeNetworkPolicy(rNoApi)
check(
  '8 describeNetworkPolicy 是一行中文摘要且含状态与 enforced',
  typeof descRefused === 'string' && !descRefused.includes('\n') && descRefused.includes('状态=refused') && descRefused.includes('enforced=false'),
  descRefused,
)
const descJunk = describeNetworkPolicy(null)
check(
  '8 describeNetworkPolicy(垃圾输入) 不抛错且落到 not-enforced（fail-closed 贯到报告面）',
  typeof descJunk === 'string' && descJunk.includes('not-enforced'),
  descJunk,
)
const summary = summariseNetworkPolicy(rApplied)
check(
  '8 summariseNetworkPolicy 恰好返回 tier/state/enforced/verified/reason 五个键',
  JSON_TEXT(Object.keys(summary).sort()) === JSON_TEXT(['enforced', 'reason', 'state', 'tier', 'verified']),
  Object.keys(summary).join(','),
)
check(
  '8 summariseNetworkPolicy(垃圾输入) ⇒ enforced=false（绝不制造虚假的"已强制"）',
  summariseNetworkPolicy(undefined).enforced === false && summariseNetworkPolicy(null).verified === false,
  JSON_TEXT(summariseNetworkPolicy(undefined)),
)
check(
  '8 summarise 只认布尔 true：字符串 "true" / 真值对象一律不放行',
  summariseNetworkPolicy({ enforced: 'true', verified: 'true' }).enforced === false &&
    summariseNetworkPolicy({ enforced: 1, verified: 1 }).enforced === false &&
    summariseNetworkPolicy({ enforced: true, verified: true }).enforced === true,
  'boolean-only',
)
check(
  '8 audit 结果能被 JSON.stringify 直接序列化（报告面安全：附注 id 已转字符串，BigInt 不会炸报告）',
  typeof JSON.stringify(installedA.audit) === 'string' && installedA.audit.filterIds.every((id) => typeof id === 'string'),
  `filterIds types=[${[...new Set(installedA.audit.filterIds.map((id) => typeof id))].join(',')}]`,
)
check(
  '8 installNetworkPolicy 的 filterIds 仍是 UINT64 原样（BigInt），因为它是唯一的删除凭据',
  installedA.filterIds.every((id) => typeof id === 'bigint'),
  `types=[${[...new Set(installedA.filterIds.map((id) => typeof id))].join(',')}]`,
)

// ═══════════════════════ 9. 现状声明（不得被读成"已实测"） ═══════════════════════
section('9. 现状声明（诚实性）')

check(
  '9 本套件全程只用替身绑定表：真实 WFP 过滤器安装仍是 [未实测]（无管理员、无网络、未改系统状态）',
  true,
  '未调用任何真实 Fwpm*Add0；与 src/wfp.mjs:28-30 的现状声明一致',
)
check(
  '9 FWP_ACTION_* 仍是暂定值（官方未给 flag 位值，本机无 SDK 头文件核对）',
  ACTION_TYPE_PROVISIONAL === true,
  'ACTION_TYPE_PROVISIONAL=true；BLOCK=0x1001',
)
check(
  '9 替身用的 GUID 是任意合法值：真值必须来自 SDK fwpmu.h，本模块与测试都不内置真值',
  Object.values(GUIDS).filter((v) => typeof v === 'string').every((text) => Buffer.isBuffer(parseGuid(text))),
  '测试替身 GUID 可解析为 16 字节',
)

// ═══════════════════════ 收尾 ═══════════════════════
if (PLANT) {
  check('--plant 模式下失败项 ≥3（证明本套件的判定真的能红，而不是恒绿）', failures >= 3, `failures=${failures}`)
}

W('')
W('='.repeat(72))
W(
  PLANT
    ? `网络策略测试（--plant 模式：故意让 OFFLINE 的能力缺口伪装成"已强制"，应当失败）：断言 ${assertions} 项，失败 ${failures} 项`
    : `网络策略测试（离线替身绑定表）：断言 ${assertions} 项，失败 ${failures} 项`,
)
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=${PLANT ? 'plant' : 'normal'}`)

process.exitCode = failures > 0 ? 1 : 0
