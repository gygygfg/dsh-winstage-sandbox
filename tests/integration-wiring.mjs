/**
 * tests/integration-wiring.mjs — 三轮接线的**集成**测试（套件 id：`integration-wiring`）
 *
 * ── 这个套件存在的唯一理由（本项目反复踩的缺陷形态）──────────────────────────────
 * `src/netpolicy.mjs` / `src/mitigations.mjs` / `src/limits.mjs` 三个模块都"独立全绿"，
 * 但**独立全绿不等于接线**：`src/testrunner.mjs:41-53` 亲自记过这个形态 ——
 * 一个模块写了、测了、进了仓库，却**没有任何生产调用方**，于是能力矩阵上它仍然是 ABSENT，
 * 而报告里看不出差别。本套件只问一个问题：**这三件事在真实运行时路径上真的会发生吗？**
 *
 * 因此每一条断言都打在**生产函数的调用路径**上：
 *   1. `src/capability.mjs::probe()` 的报告里出现三个新维度，且默认档位**一次 WFP 都不调**；
 *   2. `WindowsStageExecutor.run()` 在 `networkTier:'OFFLINE'` 且挡不住时**拒绝执行**
 *      （类型化错误 + 零子进程 + 零暂存写入），能挡住时**真的安装 + 回读 + 记录 + 拆除**；
 *   3. `src/appcontainer-runtime.mjs::spawnSuspendedAppContainer()` 在非 no-op 缓解策略下
 *      `attributeCount===2`，并且 `updateProcThreadAttribute` 的调用序列是
 *      `SECURITY_CAPABILITIES(0x00020009)` → `MITIGATION_POLICY(0x00020010, size 8)`；
 *   4. `Store.putBlob()` 超配额拒绝、统计不完整拒绝、配额内放行（内容寻址语义不变）；
 *   5. `applyOutputCap()` 真的作用在捕获路径上（`outputTruncated`/`outputDroppedBytes` 可见）。
 *
 * ── 离线与确定性（硬要求）──────────────────────────────────────────────────────
 *   · **不**需要管理员、**不**需要真实 Win32、**不**联网、**不** spawn 任何真实子进程；
 *   · 所有读写都发生在 `os.tmpdir()` 下的一个 `mkdtemp` 目录里，测试结束即删除；
 *   · 唯一"真实"的外部调用是 `capability.mjs` 的模块级 `SetErrorMode` 抑制
 *     （`src/spawn-window.mjs`，尽力而为、拿不到 koffi 就静默跳过）——不是本套件的判据。
 *
 * ── 证据分层（本项目强制约定）──────────────────────────────────────────────────
 * `[实测]` = **本次在这台机器上真的执行过**（= 下面这些断言本身）；
 * `[未实测]` = 真实 WFP 过滤器安装 / 真实 `CreateProcess` 的缓解策略注入在本机**没有**跑过
 *   （装过滤器是系统级状态变更，本阶段未获授权；`[官方]` `0x00020010` 目前只有
 *   "winnt.h 宏规则 + 同规则已实测的 `0x00020009`"这一条证据链）。
 *   替身全绿**不等于**真实 BFE / 真实内核行为已验证 —— 不得把本套件的绿读成那个。
 *
 * 用法：
 *   node tests\integration-wiring.mjs            # 正常运行，应当全绿，退出码 0
 *   node tests\integration-wiring.mjs --plant    # 真的绕开 5 处接线点，应当见红（≥10 项），退出码 1
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { capabilityDimensions, selectTier } from '../src/capability.mjs'
import { WindowsStageExecutor } from '../src/executor.mjs'
import { attributeListCountFor, AppContainerRuntime, spawnSuspendedAppContainer } from '../src/appcontainer-runtime.mjs'
import {
  MITIGATION_POLICY_ATTRIBUTE,
  MITIGATION_POLICY_VALUE_SIZE,
  buildMitigationPolicy,
  summariseMitigations,
} from '../src/mitigations.mjs'
import { DEFAULT_LIMITS, applyOutputCap } from '../src/limits.mjs'
import { Store, sha256Buffer } from '../src/store.mjs'

const PLANT = process.argv.includes('--plant')
const W = (text) => process.stdout.write(`${text}\n`)

let assertions = 0
let failures = 0
function check(name, ok, detail) {
  assertions += 1
  if (!ok) failures += 1
  W(`${ok ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${typeof detail === 'string' ? detail : safeJson(detail)}` : ''}`)
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}
const safeJson = (value) => JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? `${item}n` : item))

/**
 * `--plant` 的破坏方式：**真的绕过一个接线点**，然后照样断言"接线本应带来的契约"。
 *
 * 于是红项的含义是"如果这一处没接上，本套件会怎么看"（判定力的证据），
 * 而不是"把期望值改成坏值再假装测到了"。五个被绕开的点逐条对应一个真实缺陷形态：
 *   ① capability 忘了把三个维度写进报告      （本仓库"库写了但没接"的原始形态）
 *   ② executor 忘了 OFFLINE 网络闸门          （以为网络挡住了、其实是通的）
 *   ③ appcontainer 忘了把 attributeCount 算成 2（策略没写进属性列表，子进程静默裸奔）
 *   ④ executor 忘了给捕获输出加上限            （大输出撑爆捕获缓冲）
 *   ⑤ store 忘了查配额                        （磁盘写满才发现）
 */
const WIRE_OFF = PLANT
if (PLANT) {
  W('*** --plant：真的绕开 5 处接线点（capability 维度 / OFFLINE 闸门 / attributeCount=2 / 输出上限 / 暂存配额），下面应当见红 ***')
}

// ═══════════════════════════════════════════════════════════════════════════
// 0. 只在临时目录里工作
// ═══════════════════════════════════════════════════════════════════════════

const ROOT = mkdtempSync(join(tmpdir(), 'winstage-wiring-'))
const STAGING = join(ROOT, 'staging')
const TEMP = join(ROOT, 'temp')
const BIN = join(ROOT, 'bin')
for (const dir of [STAGING, TEMP, BIN]) mkdirSync(dir, { recursive: true })
writeFileSync(join(BIN, 'faketool.exe'), 'x')
const originalPath = process.env.PATH
const originalExt = process.env.PATHEXT

const listTree = (root) => {
  const out = []
  const walk = (dir) => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name)
      out.push(`${entry.isDirectory() ? 'd' : 'f'}:${full.slice(root.length)}:${entry.isDirectory() ? '' : statSync(full).size}`)
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(root)
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 共用替身
// ═══════════════════════════════════════════════════════════════════════════

/** 任意合法 GUID（离线替身用；真值必须来自 SDK 的 fwpmu.h，两个生产模块都刻意不内置 GUID） */
const GUIDS = Object.freeze({
  ALE_AUTH_CONNECT_V4: '11111111-1111-1111-1111-111111111111',
  ALE_AUTH_CONNECT_V6: '22222222-2222-2222-2222-222222222222',
  ALE_AUTH_RECV_ACCEPT_V4: '33333333-3333-3333-3333-333333333333',
  ALE_AUTH_RECV_ACCEPT_V6: '44444444-4444-4444-4444-444444444444',
  ALE_AUTH_LISTEN_V4: '55555555-5555-5555-5555-555555555555',
  ALE_AUTH_LISTEN_V6: '66666666-6666-6666-6666-666666666666',
  ALE_PACKAGE_ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  targetValue: 0x2000n,
})

/**
 * WFP 替身绑定表：记录**每一次**调用（顺序 + 参数形状），并维护主机侧状态。
 * 它不是"比真对象更好用的替身"：`FwpmFilterAdd0` 的 `id` 是 OUT 参数（真实 API 如此），
 * 必须由替身写进出参对象，否则 `wfp.mjs` 会以 `WFP_FILTER_ID_MISSING` 如实拒绝。
 */
function makeWfpSpy() {
  const calls = []
  let filterSeq = 1
  const api = {
    pin(buffer) {
      calls.push({ fn: 'pin', length: buffer.length })
      return 0x30000000n + BigInt(buffer.length) + BigInt(calls.length)
    },
    fwpmEngineOpen0(server, authn, identity, session, slot) {
      calls.push({ fn: 'engine-open' })
      slot[0] = 'ENGINE-1'
      return 0
    },
    fwpmEngineClose0(handle) {
      calls.push({ fn: 'engine-close', handle })
      return 0
    },
    fwpmSubLayerAdd0(handle, buffer, out) {
      calls.push({ fn: 'sublayer-add', size: buffer.length })
      return 0
    },
    fwpmFilterAdd0(handle, buffer, out, idOut) {
      calls.push({ fn: 'filter-add', size: buffer.length })
      idOut.id = BigInt(filterSeq)
      filterSeq += 1
      return 0
    },
    fwpmFilterDeleteById0(handle, id) {
      calls.push({ fn: 'filter-delete', id: String(id) })
      return 0
    },
    fwpmSubLayerDeleteByKey0(handle, key) {
      calls.push({ fn: 'sublayer-delete', key: Buffer.isBuffer(key) ? key.length : typeof key })
      return 0
    },
  }
  return {
    api,
    calls,
    count: (fn) => calls.filter((call) => call.fn === fn).length,
  }
}

/** 统计替身：返回指定的 `measureTree` 形状（用于确定性复现"截断 / 出错"） */
const measureStub = (overrides = {}) => () => ({
  bytes: 0,
  files: 0,
  dirs: 1,
  entries: 1,
  skipped: [],
  errors: [],
  notes: [],
  truncated: false,
  ...overrides,
})

/**
 * executor 替身（与 `tests/executor-stub.mjs` 同一形状，只保留本套件需要的部分）：
 * 忠实复现 `spawnPipedProcess` 的真实返回形状 `{pid, process, stdoutRead, stderrRead}`（**没有** `wait()`）。
 */
function makeExecutorStubs(options = {}) {
  const record = { createProcessAsUserW: [], spawnCalls: [], assign: [] }
  const stdout = Buffer.from(options.stdout ?? '')
  const stderr = Buffer.from(options.stderr ?? '')
  const exitCode = options.exitCode ?? 0
  const lowLevel = {
    createProcessAsUserW() {
      record.createProcessAsUserW.push(1)
      return 1
    },
    createJobObjectW() {
      return `JOB#${record.assign.length + 1}`
    },
    createPipe() {
      return 1
    },
    assignProcessToJobObject(job, process) {
      record.assign.push({ job, process })
      return 1
    },
    setInformationJobObject() {
      return 1
    },
    queryInformationJobObject(job, cls, out, len) {
      if (len !== 48) return 0
      out.writeUInt32LE(0, 32)
      out.writeUInt32LE(0, 36)
      out.writeUInt32LE(0, 40)
      out.writeUInt32LE(0, 44)
      return 1
    },
    terminateJobObject() {
      return 1
    },
    waitForSingleObject() {
      return 0 // 进程已退出（WAIT_OBJECT_0）
    },
    getExitCodeProcess(process, out) {
      if (Buffer.isBuffer(out)) out.writeUInt32LE(exitCode, 0)
      else out.exitCode = exitCode
      return 1
    },
    closeHandle() {
      return 1
    },
    allocUint32: () => Buffer.alloc(4),
    decodeUint32: (slot) => (Buffer.isBuffer(slot) ? slot.readUInt32LE(0) : Number(slot)),
    freeNative() {},
    getLastError: () => 2,
    formatMessageW: () => 0,
  }
  const spawnPipedProcess = (api, spawnOptions) => {
    record.spawnCalls.push({ command: spawnOptions.command, args: spawnOptions.args, cwd: spawnOptions.cwd })
    api.createProcessAsUserW(spawnOptions.token, null, String(spawnOptions.command), null, null, 1, 0, null, spawnOptions.cwd, 'SI', {})
    return { pid: 4242, process: 'proc-4242', stdoutRead: '4242-out', stderrRead: '4242-err' }
  }
  const drainPipe = async (api, handle) => (String(handle).endsWith('-err') ? stderr : stdout)
  const waitForProcessExit = () => exitCode
  class FakeAclSandbox {
    constructor(opts) {
      this.writableDirs = opts.writableDirs
      this.writeSid = opts.writeSid
      this.tempWriteSid = opts.tempWriteSid
      this.api = lowLevel
      this.token = 'RESTRICTED_TOKEN'
    }
    async init() {}
    dispose() {
      this.disposed = true
    }
  }
  return {
    record,
    lowLevel,
    spawnPipedProcess,
    overrides: {
      AclSandbox: FakeAclSandbox,
      processBindings: lowLevel,
      spawnPipedProcess,
      processLibrary: { drainPipe, waitForProcessExit },
      workspaceWriteSid: (p) => `S-1-4-1-1-fake(${p})`,
      tempWriteSid: (p) => `S-1-4-1-1-2-fake(${p})`,
      assertPrivateTempDisjoint: () => {},
    },
  }
}

function makeExecutor(stubs, options = {}) {
  return new WindowsStageExecutor({
    stagingRoot: STAGING,
    tempDir: TEMP,
    // ── 缺陷③（Fix A）的测试缝（与 tests/executor-stub.mjs 同一约定）─────────────
    // 替身 spawn 不产生自检 JSON，也不以受限令牌真写暂存根 ⇒ 判据是 `unmeasured`。
    // 生产上"测不出来"必须拒绝运行；本套件测的是网络策略/输出上限/配额接线，
    // 因此显式注入判定，绝不让"没测"悄悄变成"通过"。
    ...(options.stagingWriteCheck === undefined
      ? {
          stagingWriteCheck: {
            evaluate: () => ({
              verdict: 'pass',
              lane: 'sandbox',
              enforcement: 'partial',
              failedChecks: [],
              measuredChecks: [{ name: 'inside-staging-write-allowed', status: 'pass', detail: 'stub: injected by tests/integration-wiring.mjs' }],
              missingChecks: [],
              reason: 'stub-injected pass (see the comment above)',
            }),
          },
        }
      : {}),
    ...options,
    overrides: { ...stubs.overrides, ...(options.overrides ?? {}) },
  })
}

/**
 * AppContainer 替身绑定表：逐字段对齐真实 Win32 的别扭之处
 * （`InitializeProcThreadAttributeList(NULL,...)` 第一次必须返回 0；`GetLastError` 是另一次调用；
 * `CreateProcessW` 的出参是可写对象）。本套件的判据是 `updateCalls` 的**序列与参数**。
 */
function makeAppContainerBindings(options = {}) {
  const state = { lastError: 0, initCalls: [], updateCalls: [], createProcessCalls: [], pinCalls: [] }
  const bindings = {
    createAppContainerProfile: () => ({ hr: 0, sid: 0xac5d0001n }),
    deriveAppContainerSidFromAppContainerName: () => ({ hr: 0, sid: 0xac5d0002n }),
    deleteAppContainerProfile: () => 0,
    deriveCapabilitySidsFromName: (name) => ({ capabilitySids: [`cap:${name}`], capabilitySidCount: 1 }),
    initializeProcThreadAttributeList(list, count, flags, sizeSlot) {
      state.initCalls.push({ listIsNull: list === null, count, flags })
      sizeSlot[0] = 64
      if (list === null) {
        state.lastError = 122 // ERROR_INSUFFICIENT_BUFFER：官方要求的第一步
        return 0
      }
      state.lastError = 0
      return 1
    },
    updateProcThreadAttribute(list, flags, attribute, value, size, prev, returnSize) {
      state.updateCalls.push({ attribute, size, value })
      if (options.failAttribute === attribute) {
        state.lastError = options.failErrorCode ?? 87
        return 0
      }
      state.lastError = 0
      return 1
    },
    deleteProcThreadAttributeList() {},
    createProcessW(app, cmd, pa, ta, inherit, flags, env, cwd, si, pi) {
      state.createProcessCalls.push({ app, cmd, inherit, flags })
      pi.process = 0x1000n
      pi.thread = 0x2000n
      pi.pid = 4242
      state.lastError = 0
      return 1
    },
    resumeThread: () => 1,
    terminateProcess: () => 1,
    getLastError: () => state.lastError,
    pin(buffer, what) {
      // 忠实记录被钉住的**字节内容**：真实 koffi `address()` 只给地址，但属性值的内容
      // 必须在这里可核对（否则"写进去的到底是哪个策略"只能靠读生产代码来相信）。
      state.pinCalls.push({ what, length: buffer.length, bytes: Buffer.from(buffer) })
      return 0xa0000000n + BigInt(buffer.length * 0x100 + state.pinCalls.length)
    },
  }
  return { bindings, state }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. capability.mjs：三个维度进了报告，且默认档位一次 WFP 都不调
// ═══════════════════════════════════════════════════════════════════════════

section('1. capability 报告：三个维度 + 默认档位零 WFP 调用')
{
  const spy = makeWfpSpy()
  // --plant①：模拟"库写了但报告没接"（capabilityDimensions 根本没被调用）
  const dimensions = WIRE_OFF ? {} : capabilityDimensions({ networkBindings: spy.api })

  check('报告含 networkPolicy 维度', Boolean(dimensions.networkPolicy), safeJson(Object.keys(dimensions)))
  check('报告含 mitigations 维度', Boolean(dimensions.mitigations), safeJson(Object.keys(dimensions)))
  check('报告含 limits 维度', Boolean(dimensions.limits), safeJson(Object.keys(dimensions)))
  check('默认网络档位 state=not-implemented（不作任何阻断声明）', dimensions.networkPolicy?.state === 'not-implemented', dimensions.networkPolicy?.state)
  check('默认网络档位 enforced=false', dimensions.networkPolicy?.enforced === false, String(dimensions.networkPolicy?.enforced))
  check('默认网络档位 verified=false（没核对过就不许说核对过）', dimensions.networkPolicy?.verified === false, String(dimensions.networkPolicy?.verified))
  check(
    '默认档位对 WFP 绑定表零调用（非 OFFLINE 档位连绑定表都不碰）',
    spy.calls.length === 0,
    `spy 调用=${safeJson(spy.calls.slice(0, 3))} 共 ${spy.calls.length} 次`,
  )
  check('默认档位 tier 原样回显 OBSERVED_ONLINE', dimensions.networkPolicy?.tier === 'OBSERVED_ONLINE', dimensions.networkPolicy?.tier)

  // 同一份报告口径下的 OFFLINE：缺绑定表必须 refused，绝不 enforced
  const refused = capabilityDimensions({ networkTier: 'OFFLINE' })
  check('OFFLINE 且无 WFP 绑定时 state=refused', refused.networkPolicy?.state === 'refused', refused.networkPolicy?.state)
  check('OFFLINE 且无绑定时 enforced=false', refused.networkPolicy?.enforced === false, String(refused.networkPolicy?.enforced))
  check('OFFLINE 且无绑定时 reason 点名 WFP_UNAVAILABLE', String(refused.networkPolicy?.reason).includes('WFP_UNAVAILABLE'), String(refused.networkPolicy?.reason).slice(0, 160))

  // 同一份报告口径下的 OFFLINE + 完整绑定表：**计划能构造 ≠ 已强制**（没有安装证据）
  const spy2 = makeWfpSpy()
  const planned = capabilityDimensions({ networkTier: 'OFFLINE', networkBindings: spy2.api, networkGuids: GUIDS })
  check('OFFLINE + 完整绑定表：判定阶段真的调用了绑定表（替身活着）', spy2.count('engine-open') >= 1, `engine-open=${spy2.count('engine-open')}`)
  check('OFFLINE + 完整绑定表：无安装证据时 state=not-enforced（不得谎报 enforced）', planned.networkPolicy?.state === 'not-enforced', planned.networkPolicy?.state)
  check('OFFLINE + 完整绑定表：enforced 仍为 false', planned.networkPolicy?.enforced === false, String(planned.networkPolicy?.enforced))
  check('判定阶段不安装过滤器（capability 报告是只读面）', spy2.count('filter-add') === 0, `filter-add=${spy2.count('filter-add')}`)

  check('默认缓解档位 profile=none（opt-in，默认不注入）', dimensions.mitigations?.profile === 'none', dimensions.mitigations?.profile)
  check('默认缓解档位 noop=true', dimensions.mitigations?.noop === true, String(dimensions.mitigations?.noop))
  check('默认缓解档位 flags 全 0', dimensions.mitigations?.flags === '0x0000000000000000', dimensions.mitigations?.flags)
  const baseline = capabilityDimensions({ mitigationProfile: 'baseline' })
  check('opt-in baseline：profile=baseline', baseline.mitigations?.profile === 'baseline', baseline.mitigations?.profile)
  check('opt-in baseline：noop=false 且 flags 非 0', baseline.mitigations?.noop === false && baseline.mitigations?.flags !== '0x0000000000000000', baseline.mitigations?.flags)
  check('opt-in baseline：属性号 0x00020010、值 8 字节', baseline.mitigations?.attribute === '0x00020010' && baseline.mitigations?.size === MITIGATION_POLICY_VALUE_SIZE, `${baseline.mitigations?.attribute}/${baseline.mitigations?.size}`)
  const badProfile = capabilityDimensions({ mitigationProfile: 'no-such-profile' })
  check('未知缓解档位降级为 unknown（不抛进报告构建）', badProfile.mitigations?.state === 'unknown', badProfile.mitigations?.state)

  check('默认上限 stagingBytes=64GiB', dimensions.limits?.stagingBytes === DEFAULT_LIMITS.stagingBytes, String(dimensions.limits?.stagingBytes))
  check('默认上限 stagingGiB=64', dimensions.limits?.stagingGiB === 64, String(dimensions.limits?.stagingGiB))
  check('默认上限 maxOutputBytes=4MiB / maxOutputLines=200000', dimensions.limits?.maxOutputBytes === 4 * 1024 * 1024 && dimensions.limits?.maxOutputLines === 200000, `${dimensions.limits?.maxOutputBytes}/${dimensions.limits?.maxOutputLines}`)
  check('默认上限 source=defaults（区分"默认值"与"显式配置"）', dimensions.limits?.source === 'defaults', dimensions.limits?.source)
  const badLimits = capabilityDimensions({ limits: { maxOutputByte: 1 } })
  check('非法上限降级为 unknown（拼错的键不得静默失效）', badLimits.limits?.state === 'unknown', badLimits.limits?.state)

  // T0 闸门不受影响：三个维度既不进 selectTier 的输入，也不改它的输出
  const bare = { volume: { writable: true }, win32: { checks: {} }, appContainer: { status: 'pass' } }
  const withDimensions = { ...bare, ...(WIRE_OFF ? {} : capabilityDimensions({})) }
  check('selectTier 结果与"没有三个维度"时逐字一致（T0 闸门未松动）', safeJson(selectTier(bare)) === safeJson(selectTier(withDimensions)), safeJson(selectTier(withDimensions)))
  check('T0 仍被隔离证据闸门挡住（appContainerIsolation 缺失 ⇒ 不给 T0）', selectTier(withDimensions).tier !== 'T0', selectTier(withDimensions).tier)
  check('T0 闸门字面量仍是 proven===true（源码级断言）', readFileSync(new URL('../src/capability.mjs', import.meta.url), 'utf8').includes('report.appContainerIsolation?.proven === true'))

  // `probe()` 全量执行会做真实 Win32 探测 + 在 TEMP 父目录写实例探针（本套件的约束不允许），
  // 因此"报告里真的有这三个键"用**源码顺序断言**补证：维度必须在 selectTier **之前**写入，
  // 否则它们进不了落盘的报告与 CLI 输出（"接线了但报告里看不到"的形态）。
  const capabilitySource = readFileSync(new URL('../src/capability.mjs', import.meta.url), 'utf8')
  const probeBody = capabilitySource.slice(capabilitySource.indexOf('export function probe('))
  check('probe() 真的调用 capabilityDimensions（不是只导出了函数）', probeBody.includes('capabilityDimensions(options)'), 'probe() 函数体内检索')
  check(
    '三个维度在 report.tier = selectTier(report) 之前写入（顺序断言）',
    probeBody.indexOf('capabilityDimensions(options)') >= 0 &&
      probeBody.indexOf('capabilityDimensions(options)') < probeBody.indexOf('report.tier = selectTier(report)'),
    `dimensions@${probeBody.indexOf('capabilityDimensions(options)')} < selectTier@${probeBody.indexOf('report.tier = selectTier(report)')}`,
  )
  check('缓存命中路径也补算三个维度（旧缓存不得让维度消失）', probeBody.slice(0, probeBody.indexOf('const report = {')).includes('...capabilityDimensions(options)'), '缓存分支内检索')
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. executor：OFFLINE 挡不住 ⇒ 拒绝执行（类型化错误 + 零子进程 + 零暂存写入）
// ═══════════════════════════════════════════════════════════════════════════

process.env.PATH = BIN
process.env.PATHEXT = '.EXE'

try {
  section('2. executor：OFFLINE 档位挡不住 ⇒ 拒绝运行（fail-closed）')
  {
    const stubs = makeExecutorStubs({ stdout: 'should-not-run' })
    const ex = makeExecutor(stubs, {
      // --plant②：模拟"executor 没有接 OFFLINE 闸门"（档位被悄悄降级成不阻断的默认档）
      networkTier: WIRE_OFF ? 'OBSERVED_ONLINE' : 'OFFLINE',
    })
    const initReport = await ex.init()
    check('init 记录网络策略=refused（缺 WFP 绑定表）', initReport.networkPolicy?.state === 'refused', initReport.networkPolicy?.state)
    check('init 记录的 enforced=false', initReport.networkPolicy?.enforced === false, String(initReport.networkPolicy?.enforced))
    check('init 后没有安装任何过滤器 ⇒ 没有拆除句柄', ex.networkTeardown === undefined, String(typeof ex.networkTeardown))

    const before = listTree(STAGING)
    let refusedError
    try {
      await ex.run({ command: 'faketool', cwd: STAGING })
    } catch (error) {
      refusedError = error
    }
    check('run() 抛类型化错误 SANDBOX_NETWORK_POLICY_UNENFORCED', refusedError?.code === 'SANDBOX_NETWORK_POLICY_UNENFORCED', `${refusedError?.code}`)
    check('错误 message 含 netpolicy 的 reason（WFP_UNAVAILABLE）', String(refusedError?.message).includes('WFP_UNAVAILABLE'), String(refusedError?.message).slice(0, 200))
    check('错误 message 点名 state=refused', String(refusedError?.message).includes('state=refused'), String(refusedError?.message).slice(0, 120))
    check('拒绝发生在 spawn 之前：零子进程', stubs.record.spawnCalls.length === 0, `spawnCalls=${stubs.record.spawnCalls.length}`)
    check('拒绝发生在 spawn 之前：零 CreateProcessAsUserW', stubs.record.createProcessAsUserW.length === 0, `createProcess=${stubs.record.createProcessAsUserW.length}`)
    check('拒绝发生在暂存写入之前：暂存树逐项不变', safeJson(listTree(STAGING)) === safeJson(before), safeJson(listTree(STAGING)))
    check('classifyOutcome 之外的路径：run 不返回结构化结果而是抛错（不得静默放行）', refusedError instanceof Error, typeof refusedError)
    ex.dispose()

    // 源码顺序锚点：两道闸门必须都在"解析命令/启动子进程"**之前**
    const executorSource = readFileSync(new URL('../src/executor.mjs', import.meta.url), 'utf8')
    const runBody = executorSource.slice(executorSource.indexOf('async run(options) {'))
    const atNetwork = runBody.indexOf('this.assertNetworkPolicyEnforceable()')
    const atQuota = runBody.indexOf('this.assertStagingQuota(0')
    const atSpawnResolution = runBody.indexOf('resolveExecutable(options.command')
    check('run() 真的调用 assertNetworkPolicyEnforceable()', atNetwork >= 0, `@${atNetwork}`)
    check('run() 真的调用 assertStagingQuota()', atQuota >= 0, `@${atQuota}`)
    check('网络闸门在命令解析之前（拒绝时不解析、不启动）', atNetwork >= 0 && atNetwork < atSpawnResolution, `network@${atNetwork} < resolve@${atSpawnResolution}`)
    check('配额闸门在命令解析之前（拒绝时不解析、不启动）', atQuota >= 0 && atQuota < atSpawnResolution, `quota@${atQuota} < resolve@${atSpawnResolution}`)
    check('捕获路径真的调用 applyOutputCap()', runBody.includes('applyOutputCap(stdoutRaw'), 'run() 函数体内检索')
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 3. executor：OFFLINE 可强制 ⇒ 真的安装 + 回读 + 记录 + 拆除
  // ═════════════════════════════════════════════════════════════════════════

  section('3. executor：OFFLINE 可强制 ⇒ 安装 + 回读 + 记录 + dispose 拆除')
  {
    const spy = makeWfpSpy()
    const stubs = makeExecutorStubs({ stdout: 'offline-run-ok' })
    const ex = makeExecutor(stubs, {
      networkTier: 'OFFLINE',
      networkBindings: spy.api,
      networkGuids: GUIDS,
    })
    const initReport = await ex.init()
    check('init 记录 state=enforced（安装 + 回读证据齐了）', initReport.networkPolicy?.state === 'enforced', initReport.networkPolicy?.state)
    check('init 记录 enforced=true', initReport.networkPolicy?.enforced === true, String(initReport.networkPolicy?.enforced))
    check('回读入口缺失时 verified=false（如实：已强制但未独立验证）', initReport.networkPolicy?.verified === false, String(initReport.networkPolicy?.verified))
    check('reason 点名 enumeration-unavailable（不得读成"已核对"）', String(initReport.networkPolicy?.reason).includes('enumeration-unavailable'), String(initReport.networkPolicy?.reason).slice(0, 200))
    check('真的建了 sublayer（1 次）', spy.count('sublayer-add') === 1, `sublayer-add=${spy.count('sublayer-add')}`)
    check('真的装了 6 条过滤器（6 个 ALE 层）', spy.count('filter-add') === 6, `filter-add=${spy.count('filter-add')}`)
    check('安装前先开引擎并探过可用性', spy.count('engine-open') >= 2, `engine-open=${spy.count('engine-open')}`)

    const runResult = await ex.run({ command: 'faketool', cwd: STAGING })
    check('OFFLINE 可强制时 run 正常放行', runResult.exitCode === 0 && runResult.launchFailed !== true, safeJson({ exitCode: runResult.exitCode, launchFailed: runResult.launchFailed }))
    check('run 结果带着 networkPolicy.enforced=true', runResult.networkPolicy?.enforced === true, safeJson(runResult.networkPolicy))
    check('run 结果里的三个维度齐全', Boolean(runResult.mitigations) && Boolean(runResult.limits) && Boolean(runResult.networkPolicy), safeJson(Object.keys(runResult).filter((k) => ['networkPolicy', 'mitigations', 'limits'].includes(k))))
    check('放行时确实 spawn 了一次', stubs.record.spawnCalls.length === 1, `spawnCalls=${stubs.record.spawnCalls.length}`)

    const disposeResult = ex.dispose()
    check('dispose 拆除过滤器（6 次逆序删除）', spy.count('filter-delete') === 6, `filter-delete=${spy.count('filter-delete')}`)
    check('dispose 拆除 sublayer（1 次）', spy.count('sublayer-delete') === 1, `sublayer-delete=${spy.count('sublayer-delete')}`)
    check('dispose 关闭引擎', spy.count('engine-close') >= 1, `engine-close=${spy.count('engine-close')}`)
    check('拆除零失败（failures 为空）', (ex.networkTeardownResult?.failures ?? ['no-teardown']).length === 0, safeJson(ex.networkTeardownResult?.failures))
    check('dispose 不报告网络拆除失败', disposeResult.failures.filter((text) => text.includes('network teardown')).length === 0, safeJson(disposeResult.failures))
  }

  // ═════════════════════════════════════════════════════════════════════════
  // 4. executor：非 OFFLINE 不阻断 + 输出上限 + 暂存配额
  // ═════════════════════════════════════════════════════════════════════════

  section('4. executor：非 OFFLINE 不阻断、输出上限、暂存配额')
  {
    const stubs = makeExecutorStubs({ stdout: 'hello-stdout' })
    const ex = makeExecutor(stubs)
    await ex.init()
    const result = await ex.run({ command: 'faketool', cwd: STAGING })
    check('默认（OBSERVED_ONLINE）不阻断：run 正常完成', result.exitCode === 0, String(result.exitCode))
    check('默认档位 networkPolicy.state=not-implemented', result.networkPolicy?.state === 'not-implemented', result.networkPolicy?.state)
    check('默认档位 enforced=false', result.networkPolicy?.enforced === false, String(result.networkPolicy?.enforced))
    check('默认档位仍 spawn 了一次（非 OFFLINE 不拦执行）', stubs.record.spawnCalls.length === 1, String(stubs.record.spawnCalls.length))
    check('默认缓解策略 profile=none', result.mitigations?.profile === 'none', result.mitigations?.profile)
    check('默认上限摘要带 64GiB 暂存配额', result.limits?.stagingBytes === DEFAULT_LIMITS.stagingBytes, String(result.limits?.stagingBytes))
    check('小输出不触发截断（默认行为不变）', result.outputTruncated === false && result.outputDroppedBytes === 0, safeJson({ truncated: result.outputTruncated, dropped: result.outputDroppedBytes }))
    check('小输出逐字节原样', result.stdout === 'hello-stdout', safeJson(result.stdout))
    ex.dispose()
  }
  {
    // --plant④：模拟"捕获路径没接 applyOutputCap"（用不会触发上限的默认配置）
    const stubs = makeExecutorStubs({ stdout: 'x'.repeat(100) })
    const ex = makeExecutor(stubs, WIRE_OFF ? {} : { limits: { maxOutputBytes: 32 } })
    await ex.init()
    const result = await ex.run({ command: 'faketool', cwd: STAGING })
    check('超上限：outputTruncated=true（绝不静默截断）', result.outputTruncated === true, String(result.outputTruncated))
    check('超上限：outputDroppedBytes=68（100 保留 32）', result.outputDroppedBytes === 68, String(result.outputDroppedBytes))
    check('超上限：保留段里出现 ASCII 截断标记', result.stdout.includes('[WinStageSandbox][OUTPUT-TRUNCATED]'), safeJson(result.stdout.slice(30, 90)))
    check('超上限：outputCap.stdout.byteTruncated=true', result.outputCap?.stdout?.byteTruncated === true, safeJson(result.outputCap?.stdout))
    check('超上限：keptBytes 等于上限（32）', result.outputCap?.stdout?.keptBytes === 32, String(result.outputCap?.stdout?.keptBytes))
    check('超上限：保留部分是原文的逐字节前缀', result.stdout.startsWith('x'.repeat(32)), safeJson(result.stdout.slice(0, 40)))
    ex.dispose()
  }
  {
    // --plant⑤：模拟"store/executor 没接配额闸门"（配额关掉）
    writeFileSync(join(STAGING, 'quota-probe.bin'), 'y'.repeat(16))
    const stubs = makeExecutorStubs({ stdout: 'quota' })
    const ex = makeExecutor(stubs, WIRE_OFF ? { stagingQuotaBytes: null } : { stagingQuotaBytes: 8 })
    await ex.init()
    let quotaError
    try {
      await ex.run({ command: 'faketool', cwd: STAGING })
    } catch (error) {
      quotaError = error
    }
    check('超配额：run 抛 STAGING_QUOTA_EXCEEDED', quotaError?.code === 'STAGING_QUOTA_EXCEEDED', String(quotaError?.code))
    check('超配额：拒绝发生在 spawn 之前', stubs.record.spawnCalls.length === 0, String(stubs.record.spawnCalls.length))
    check('超配额：错误带完整判定（error.quota.allowed=false）', quotaError?.quota?.allowed === false, safeJson(quotaError?.quota))
    ex.dispose()
    rmSync(join(STAGING, 'quota-probe.bin'), { force: true })
  }
  {
    const stubs = makeExecutorStubs({ stdout: 'incomplete' })
    const ex = makeExecutor(stubs, {
      // 统计不完整（条目出错）必须 fail-closed —— 统计不了的树等于配额的洞
      measureStaging: measureStub({ bytes: 1, errors: [{ path: 'x', code: 'EPERM', message: 'denied' }] }),
      stagingQuotaBytes: DEFAULT_LIMITS.stagingBytes,
    })
    await ex.init()
    let incompleteError
    try {
      await ex.run({ command: 'faketool', cwd: STAGING })
    } catch (error) {
      incompleteError = error
    }
    check('统计不完整：抛 STAGING_QUOTA_MEASUREMENT_INCOMPLETE', incompleteError?.code === 'STAGING_QUOTA_MEASUREMENT_INCOMPLETE', String(incompleteError?.code))
    check('统计不完整：拒绝发生在 spawn 之前', stubs.record.spawnCalls.length === 0, String(stubs.record.spawnCalls.length))
    ex.dispose()
  }
  {
    const stubs = makeExecutorStubs({ stdout: 'zero-headroom' })
    const ex = makeExecutor(stubs, {
      // 恰好用满（used==quota）必须**放行**（limits.mjs 的硬不变式 #2）
      measureStaging: measureStub({ bytes: 8 }),
      stagingQuotaBytes: 8,
    })
    await ex.init()
    const result = await ex.run({ command: 'faketool', cwd: STAGING })
    check('恰好用满配额：放行（零余量，不是拒绝）', result.exitCode === 0 && stubs.record.spawnCalls.length === 1, safeJson({ exitCode: result.exitCode, spawn: stubs.record.spawnCalls.length }))
    ex.dispose()
  }
} finally {
  process.env.PATH = originalPath
  if (originalExt === undefined) delete process.env.PATHEXT
  else process.env.PATHEXT = originalExt
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. appcontainer-runtime：attributeCount=2 与 updateProcThreadAttribute 调用序列
// ═══════════════════════════════════════════════════════════════════════════

section('5. AppContainer：缓解策略占第 2 个属性槽位 + 精确调用序列')
{
  {
    const { bindings, state } = makeAppContainerBindings()
    const child = spawnSuspendedAppContainer(bindings, { appContainerSid: 1n, commandLine: 'x.exe' })
    check('缺省（无策略）：attributeCount=1', child.attributeCount === 1, String(child.attributeCount))
    check('缺省：InitializeProcThreadAttributeList 两次都用 count=1', state.initCalls.length === 2 && state.initCalls.every((call) => call.count === 1), safeJson(state.initCalls.map((c) => c.count)))
    check('缺省：updateProcThreadAttribute 只调用一次（行为与接线前逐字一致）', state.updateCalls.length === 1, String(state.updateCalls.length))
    check('缺省：唯一那次是 SECURITY_CAPABILITIES(0x00020009)', state.updateCalls[0]?.attribute === 0x00020009, `0x${(state.updateCalls[0]?.attribute ?? 0).toString(16)}`)
    check('缺省：mitigationPolicy 为 null（没有"半套策略"）', child.mitigationPolicy === null, String(child.mitigationPolicy))
    check('缺省：CreateProcessW 被调用（启动没有被无端中止）', state.createProcessCalls.length === 1, String(state.createProcessCalls.length))
  }
  {
    const policy = buildMitigationPolicy('hardened')
    const { bindings, state } = makeAppContainerBindings()
    // --plant③：模拟"忘了把 attributeCount 算成 2"（策略压根没进属性列表）
    const child = spawnSuspendedAppContainer(bindings, {
      appContainerSid: 1n,
      commandLine: 'x.exe',
      mitigationPolicy: WIRE_OFF ? null : policy,
    })
    check('非 no-op 策略：attributeCount=2', child.attributeCount === 2, String(child.attributeCount))
    check('非 no-op：InitializeProcThreadAttributeList 两次都用 count=2', state.initCalls.length === 2 && state.initCalls.every((call) => call.count === 2), safeJson(state.initCalls.map((c) => c.count)))
    check('非 no-op：updateProcThreadAttribute 恰好两次', state.updateCalls.length === 2, String(state.updateCalls.length))
    check('调用序列[0]=SECURITY_CAPABILITIES(0x00020009, size 24)', state.updateCalls[0]?.attribute === 0x00020009 && state.updateCalls[0]?.size === 24, safeJson({ attr: state.updateCalls[0]?.attribute, size: state.updateCalls[0]?.size }))
    check('调用序列[1]=MITIGATION_POLICY(0x00020010, size 8)', state.updateCalls[1]?.attribute === MITIGATION_POLICY_ATTRIBUTE && state.updateCalls[1]?.size === MITIGATION_POLICY_VALUE_SIZE, safeJson({ attr: state.updateCalls[1]?.attribute, size: state.updateCalls[1]?.size }))
    // 属性值指针指向被 pin 住的 8 字节缓冲区：内容必须逐字节等于策略 buffer
    const pinnedPolicy = state.pinCalls.find((call) => String(call.what).includes('MITIGATION_POLICY'))
    check('属性值指针已 pin（bigint 地址，不是 Buffer 冒充指针）', typeof state.updateCalls[1]?.value === 'bigint', `${typeof state.updateCalls[1]?.value}=${state.updateCalls[1]?.value}`)
    check('pinned 缓冲区就是策略的 8 字节 buffer（逐字节相等）', pinnedPolicy !== undefined && Buffer.compare(pinnedPolicy.bytes, policy.buffer) === 0, safeJson(pinnedPolicy?.bytes))
    check('pinned 缓冲区按小端写 flags', pinnedPolicy?.bytes?.readBigUInt64LE(0) === policy.flags, `${pinnedPolicy?.bytes?.readBigUInt64LE(0)}n vs ${policy.flags}n`)
    check('返回对象带着策略（调用方据此持有 buffer 到属性列表销毁）', child.mitigationPolicy?.flags === policy.flags, String(child.mitigationPolicy?.flags))
    check('非 no-op 时仍完成 CreateProcessW（策略写成功才继续）', state.createProcessCalls.length === 1, String(state.createProcessCalls.length))
  }
  {
    const policy = buildMitigationPolicy('untrusted')
    const { bindings, state } = makeAppContainerBindings({ failAttribute: MITIGATION_POLICY_ATTRIBUTE, failErrorCode: 87 })
    let failure
    try {
      spawnSuspendedAppContainer(bindings, { appContainerSid: 1n, commandLine: 'x.exe', mitigationPolicy: policy })
    } catch (error) {
      failure = error
    }
    check('策略写失败：抛 APPCONTAINER_ATTRIBUTE_UPDATE_FAILED', failure?.code === 'APPCONTAINER_ATTRIBUTE_UPDATE_FAILED', String(failure?.code))
    check('策略写失败：错误带 win32Code=87', failure?.win32Code === 87, String(failure?.win32Code))
    check('策略写失败：message 里同时出现属性号与 win32Code', /0x0*20010/.test(String(failure?.message)) && String(failure?.message).includes('87'), String(failure?.message).slice(0, 220))
    check('策略写失败：**没有**启动子进程（绝不带着未施加的策略继续）', state.createProcessCalls.length === 0, String(state.createProcessCalls.length))
  }
  {
    check('attributeListCountFor(undefined)=1', attributeListCountFor(undefined) === 1, String(attributeListCountFor(undefined)))
    check('attributeListCountFor("none")=1', attributeListCountFor('none') === 1, String(attributeListCountFor('none')))
    check('attributeListCountFor("hardened")=2', attributeListCountFor('hardened') === 2, String(attributeListCountFor('hardened')))
    check('MITIGATION_POLICY_ATTRIBUTE=0x00020010（winnt.h 宏规则）', MITIGATION_POLICY_ATTRIBUTE === 0x00020010, `0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}`)
    check('attributeListCountFor("untrusted")=2（所有非 no-op 档都占 2 个槽位）', attributeListCountFor('untrusted') === 2, String(attributeListCountFor('untrusted')))
  }
  {
    // 端到端：AppContainerRuntime 构造期配置策略 ⇒ init/spawn 都按 2 个槽位
    const { bindings, state } = makeAppContainerBindings()
    const runtime = new AppContainerRuntime(bindings, { profileName: 'wiring-test', mitigationPolicy: 'hardened' })
    const initReport = runtime.init()
    check('AppContainerRuntime.init()：attributeCount=2', initReport.attributeCount === 2, String(initReport.attributeCount))
    check('AppContainerRuntime.init()：报告里带策略 flags', typeof initReport.mitigation?.flags === 'string' && initReport.mitigation.flags === buildMitigationPolicy('hardened').hex, safeJson(initReport.mitigation))
    const afterInit = state.initCalls.length
    const child = runtime.spawn({ commandLine: 'x.exe' })
    check('AppContainerRuntime.spawn()：新属性列表按 count=2 初始化', state.initCalls.slice(afterInit).every((call) => call.count === 2), safeJson(state.initCalls.slice(afterInit).map((c) => c.count)))
    check('AppContainerRuntime.spawn()：写入 MITIGATION_POLICY 属性', state.updateCalls.some((call) => call.attribute === MITIGATION_POLICY_ATTRIBUTE), safeJson(state.updateCalls.map((c) => c.attribute)))
    check('AppContainerRuntime.spawn()：spawn 出来的 child 带策略', child.mitigationPolicy !== null && child.mitigationPolicy !== undefined, String(child.mitigationPolicy?.profile))
    runtime.dispose()
  }
  {
    // 回归：默认 none 时运行期行为与接线前一致（只写 SECURITY_CAPABILITIES）
    const { bindings, state } = makeAppContainerBindings()
    const runtime = new AppContainerRuntime(bindings, { profileName: 'wiring-none', mitigationPolicy: 'none' })
    const initReport = runtime.init()
    runtime.spawn({ commandLine: 'x.exe' })
    check('mitigationProfile=none：attributeCount=1', initReport.attributeCount === 1, String(initReport.attributeCount))
    check('mitigationProfile=none：属性列表只按 1 个槽位初始化', state.initCalls.every((call) => call.count === 1), safeJson(state.initCalls.map((c) => c.count)))
    check('mitigationProfile=none：只写 SECURITY_CAPABILITIES 一个属性', state.updateCalls.length === 1 && state.updateCalls[0].attribute === 0x00020009, safeJson(state.updateCalls.map((c) => c.attribute)))
    check('mitigationProfile=none：init 报告 mitigation=null', initReport.mitigation === null, safeJson(initReport.mitigation))
    runtime.dispose()
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. store.mjs：putBlob 的配额闸门
// ═══════════════════════════════════════════════════════════════════════════

section('6. store.putBlob：超配额拒绝 / 统计不完整拒绝 / 配额内放行')
{
  const storeRoot = join(ROOT, 'store-under')
  const store = new Store(storeRoot, { storeDir: join(storeRoot, '.dshstage') })
  check('默认配额 = DEFAULT_LIMITS.stagingBytes（64GiB，默认就生效）', store.stagingQuotaBytes === DEFAULT_LIMITS.stagingBytes, String(store.stagingQuotaBytes))
  let measurements = 0
  const countingMeasure = (root, options) => {
    measurements += 1
    return { bytes: 0, files: 0, dirs: 1, entries: 1, skipped: [], errors: [], notes: [], truncated: false }
  }
  const store2 = new Store(storeRoot, { storeDir: join(storeRoot, '.dshstage'), measureStaging: countingMeasure })
  const payload = Buffer.from('under-quota-payload')
  const hash = store2.putBlob(payload)
  check('配额内：putBlob 返回 sha256', hash === sha256Buffer(payload), hash)
  check('配额内：blob 真的落盘', existsSync(store2.blobPath(hash)), store2.blobPath(hash))
  check('配额内：统计被调用一次（接线真的走到了 checkStagingQuota）', measurements === 1, String(measurements))
  check('内容寻址：同一内容第二次 putBlob 返回同一 hash', store2.putBlob(payload) === hash, hash)
  check('内容寻址：重复内容不再统计（hash 已存在 ⇒ 去重、不消耗配额）', measurements === 1, String(measurements))
}
{
  const storeRoot = join(ROOT, 'store-over')
  const store = new Store(storeRoot, { storeDir: join(storeRoot, '.dshstage'), stagingQuotaBytes: 8 })
  let error
  try {
    store.putBlob(Buffer.from('0123456789ABCDEF'))
  } catch (thrown) {
    error = thrown
  }
  check('超配额：抛 STAGING_QUOTA_EXCEEDED', error?.code === 'STAGING_QUOTA_EXCEEDED', String(error?.code))
  check('超配额：错误带完整判定（quotaBytes=8）', error?.quota?.quotaBytes === 8 && error?.quota?.allowed === false, safeJson(error?.quota))
  const blobsDir = join(storeRoot, '.dshstage', 'blobs')
  check('超配额：blob 没有落盘（写入前就拒绝）', !existsSync(blobsDir) || readdirSync(blobsDir).length === 0, existsSync(blobsDir) ? safeJson(readdirSync(blobsDir)) : 'blobs 目录未创建')
}
{
  const storeRoot = join(ROOT, 'store-incomplete')
  const store = new Store(storeRoot, {
    storeDir: join(storeRoot, '.dshstage'),
    measureStaging: measureStub({ bytes: 0, errors: [{ path: 'x', code: 'EACCES', message: 'denied' }] }),
  })
  let error
  try {
    store.putBlob(Buffer.from('x'))
  } catch (thrown) {
    error = thrown
  }
  check('统计出错：抛 STAGING_QUOTA_MEASUREMENT_INCOMPLETE', error?.code === 'STAGING_QUOTA_MEASUREMENT_INCOMPLETE', String(error?.code))
  check('统计出错：blob 没有落盘', !existsSync(join(storeRoot, '.dshstage', 'blobs')), 'blobs 目录不存在或为空')
}
{
  const storeRoot = join(ROOT, 'store-truncated')
  const store = new Store(storeRoot, {
    storeDir: join(storeRoot, '.dshstage'),
    measureStaging: measureStub({ bytes: 0, truncated: true }),
  })
  let error
  try {
    store.putBlob(Buffer.from('x'))
  } catch (thrown) {
    error = thrown
  }
  check('统计截断（下界）：同样 fail-closed 拒绝', error?.code === 'STAGING_QUOTA_MEASUREMENT_INCOMPLETE', String(error?.code))
}
{
  const storeRoot = join(ROOT, 'store-exact')
  const store = new Store(storeRoot, {
    storeDir: join(storeRoot, '.dshstage'),
    stagingQuotaBytes: 4,
    // used=0 + incoming=4 == quota=4：**恰好用满必须放行**（limits.mjs 硬不变式 #2）
    measureStaging: measureStub({ bytes: 0 }),
  })
  let error
  try {
    store.putBlob(Buffer.from('abcd'))
  } catch (thrown) {
    error = thrown
  }
  check('恰好用满配额：放行（零余量，与 limits.mjs 口径一致）', error === undefined, String(error?.code))
}
{
  const storeRoot = join(ROOT, 'store-off')
  const store = new Store(storeRoot, { storeDir: join(storeRoot, '.dshstage'), stagingQuotaBytes: null })
  let error
  try {
    store.putBlob(Buffer.from('z'.repeat(64)))
  } catch (thrown) {
    error = thrown
  }
  check('stagingQuotaBytes:null 是显式关闭开关（文档化的唯一关闭方式）', error === undefined && store.stagingQuotaBytes === null, String(error?.code))
  check('显式关闭时返回值仍是普通判定对象', store.assertStagingQuota(1)?.allowed === true, safeJson(store.assertStagingQuota(1)))

  // 源码锚点：闸门必须在 putBlob 的**写入之前**（"写完再量"只能事后发现超了）
  const storeSource = readFileSync(new URL('../src/store.mjs', import.meta.url), 'utf8')
  const putBlobBody = storeSource.slice(storeSource.indexOf('putBlob(buffer) {'), storeSource.indexOf('putBlobFromFile('))
  const atQuota = putBlobBody.indexOf('this.assertStagingQuota(buffer.length)')
  const atWrite = putBlobBody.indexOf('writeFileSync(path, buffer)')
  check('putBlob 真的调用 assertStagingQuota(buffer.length)', atQuota >= 0, `@${atQuota}`)
  check('配额闸门在 writeFileSync 之前（写入前拒绝）', atQuota >= 0 && atQuota < atWrite, `quota@${atQuota} < write@${atWrite}`)
  check('putBlob 的早退路径（hash 已存在）不消耗配额', putBlobBody.indexOf('if (!existsSync(path))') < atQuota, 'existsSync 判断在闸门之前')
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. 截断标记契约（捕获路径依赖的 limits.mjs 语义）
// ═══════════════════════════════════════════════════════════════════════════

section('7. 输出截断契约（ASCII 标记 / 前缀逐字节 / 丢弃量守恒）')
{
  const original = 'a'.repeat(10) + '\n' + 'b'.repeat(10)
  const capped = applyOutputCap(original, { maxBytes: 6 })
  check('超限：truncated=true', capped.truncated === true, String(capped.truncated))
  check('截断标记是纯 ASCII', /^[\x09\x0d\x0a\x20-\x7e]+$/.test(capped.marker ?? ''), safeJson(capped.marker))
  check('保留段是原文前缀（逐字节）', original.startsWith(capped.text.slice(0, capped.keptBytes)), safeJson(capped.text.slice(0, 20)))
  check('丢弃量守恒：keptBytes + droppedBytes === 原文总字节', capped.keptBytes + capped.droppedBytes === Buffer.byteLength(original), `${capped.keptBytes}+${capped.droppedBytes} vs ${Buffer.byteLength(original)}`)
  check('标记在末尾（保留段仍可被 grep 命中）', capped.text.endsWith(capped.marker), safeJson(capped.text.slice(-40)))
  const untouched = applyOutputCap('small', {})
  check('未超限：原文返回、truncated=false、marker=null', untouched.text === 'small' && untouched.truncated === false && untouched.marker === null, safeJson({ text: untouched.text, truncated: untouched.truncated, marker: untouched.marker }))
  check('默认上限就是 4MiB/200000 行（与报告摘要同一来源）', DEFAULT_LIMITS.maxOutputBytes === 4 * 1024 * 1024 && DEFAULT_LIMITS.maxOutputLines === 200000, `${DEFAULT_LIMITS.maxOutputBytes}/${DEFAULT_LIMITS.maxOutputLines}`)
  check('截断后的标志位可机检（byteTruncated=true）', capped.byteTruncated === true, safeJson({ byte: capped.byteTruncated, line: capped.lineTruncated }))
}

// ═══════════════════════════════════════════════════════════════════════════
// 收尾
// ═══════════════════════════════════════════════════════════════════════════

rmSync(ROOT, { recursive: true, force: true })
W('')
W('='.repeat(72))
W(`集成接线测试：断言 ${assertions} 项，失败 ${failures} 项${PLANT ? '（--plant：应当见红）' : ''}`)
W('='.repeat(72))
W(`RESULT: ${failures === 0 ? 'PASS' : 'FAIL'} checks=${assertions} failures=${failures} mode=${PLANT ? 'plant' : 'normal'}`)
process.exit(failures ? 1 : 0)
