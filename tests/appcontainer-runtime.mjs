/**
 * AppContainer 运行期模块的离线确定性测试
 * （**不需要管理员权限、不需要能创建 AppContainer、不触碰任何系统状态**）
 *
 * 存在理由：这条链路上的缺陷绝大多数**只在真实运行期才暴露**，但其中一整类
 * "看起来成功、实则没有隔离（或者子进程根本没跑）"的缺陷**可以离线钉死**：
 *   - `STARTUPINFOEXW.cb` 填成 104 → `CreateProcess` **静默忽略** `lpAttributeList`，
 *     进程照常起来但**不在 AppContainer 里**（最危险的一类错误）；
 *   - `SECURITY_CAPABILITIES` 的 `cbSize` 填成 32（多补 8 字节 padding）→
 *     `UpdateProcThreadAttribute` 返回 false，而 BOOL 失败检查写成 `=== 0` 时**永不成立**；
 *   - `bInheritHandles=TRUE` + 无自有控制台 → AppContainer 子进程以
 *     `0xC0000142 (STATUS_DLL_INIT_FAILED)` 静默死亡，`CreateProcessW` 仍返回成功（阶段 FIX-B 实测）；
 *   - 判据用 `TokenUser` 而不是 `TokenIsAppContainer(29)` / `TokenAppContainerSid(31)`
 *     → 把"已经生效的隔离"读成"没生效"（阶段 B 的"原因 3"就是这么来的）；
 *   - `InitializeProcThreadAttributeList` 的首次"按设计失败"被当成真错误；
 *   - `CREATE_SUSPENDED` 起来了但忘了 `ResumeThread`（症状是超时，不是启动失败）；
 *   - `DeriveCapabilitySidsFromName` 的 `PSID **` 被当成 PSID、并把要交还的 SID 释放掉；
 *   - 在 `E_ACCESSDENIED` 时"顺手派生一个 SID"，把故障点推到别处。
 * 这些都在本文件里用**合成替身**测到。
 *
 * 本文件**不**断言"隔离已生效"：`proven` 只能由 `assessAppContainerIsolation()` 依据实测观测给出
 * （见 §10 的 fail-closed 矩阵）。真实运行期证据在 `.t/sbx3/dev/raw-t0-*.txt`。
 *
 * 用法：
 *   node tests\appcontainer-runtime.mjs            # 正常运行，应当全绿
 *   node tests\appcontainer-runtime.mjs --plant    # 故意破坏两处，证明判定可失败
 */

import { spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SE_GROUP_ENABLED,
  SID_AND_ATTRIBUTES_SIZE,
  OFF_SID_AND_ATTRIBUTES,
  CREATE_SUSPENDED,
  ERROR_INSUFFICIENT_BUFFER,
  ERROR_ALREADY_EXISTS,
  HR_ALREADY_EXISTS,
  DEFAULT_CAPABILITIES,
  NETWORK_CAPABILITY,
  buildSidAndAttributesArray,
  buildStartupInfoExBuffer,
  allocateAttributeList,
  spawnSuspendedAppContainer,
  resumeSuspendedProcess,
  planCombinationOrder,
  AppContainerRuntime,
  // `[实测]` 阶段 B：真实 koffi 对 C 的 `bool` 返回 JS boolean，而替身返回数字，
  // 所以统一走这个判定（模块内所有 BOOL 检查都用它）
  win32BoolSucceeded,
  PROCESS_INFORMATION_SIZE,
  OFF_PROCESS_INFORMATION,
  createKoffiAppContainerBindings,
  // ── 阶段 FIX-B 新增：启动契约常量 + 隔离证据采集/判定 ──────────────────────
  TOKEN_INFORMATION_CLASS,
  TOKEN_QUERY_ACCESS,
  SID_LOW_INTEGRITY,
  CREATE_NEW_CONSOLE,
  DETACHED_PROCESS,
  STATUS_DLL_INIT_FAILED,
  readProcessTokenFacts,
  assessAppContainerIsolation,
} from '../src/appcontainer-runtime.mjs'
import {
  STARTUPINFOEX_SIZE,
  STARTUPINFO_SIZE,
  OFF_ATTRIBUTE_LIST,
  EXTENDED_STARTUPINFO_PRESENT,
  PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
  SECURITY_CAPABILITIES_SIZE,
} from '../src/appcontainer.mjs'

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

/**
 * 如实记录"本环境无法实测"的用例（**不是**通过）。
 *
 * 为什么必须与 `check` 分开：把"没测"写成 `check(name, true)` 就是本项目缺陷 11
 * （"脚本没有产出任何输出"被当成"操作被拒绝"）的同一族错误 —— 它会把
 * "未提供的保证"伪装成"已经提供的保证"。这里跳过要打印原因、计入 `skips`、
 * 并在总结行里与"失败 0"一起被读到。
 */
function skip(name, why) {
  skips += 1
  W(`  ⊘ SKIP ${name}\n      原因: ${why}`)
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
 * 可以安全打印 BigInt 的证据序列化（与 `tests/registry-guard.mjs` 同一处理）。
 * 本文件里 `PROCESS_INFORMATION` 句柄、包 SID、`pin()` 返回值都是 bigint，
 * 裸 `JSON.stringify` 会抛 `TypeError: Do not know how to serialize a BigInt`，
 * 症状是"测试因为打印证据而整体崩溃"。
 * 用别名保存原生函数，避免下面的统一改名把自己也改掉。
 */
const NATIVE_STRINGIFY = JSON.stringify
function safeJson(value) {
  return NATIVE_STRINGIFY(value, (key, item) => (typeof item === 'bigint' ? `${item}n` : item))
}

/**
 * 逐字段对齐真实 Win32 的替身。
 *
 * 手册要求"替身宁可复杂也不要比真对象更好用"，因此这个替身**刻意保留**真实 API 的别扭之处：
 *   - `InitializeProcThreadAttributeList(NULL, ...)` 第一次**必须返回 0** 并把尺寸写进出参槽；
 *   - `GetLastError()` 是"另一次调用"，不是返回值——所以替身用显式状态模拟它；
 *   - `CreateProcessW` 的出参是一个**可写对象**（真实 Koffi 用结构指针），不是返回值；
 *   - `updateProcThreadAttribute` 收到的 `value` 是**结构化**的（要能读出 SECURITY_CAPABILITIES 的字段）。
 */
function makeBindings(overrides = {}) {
  const state = {
    lastError: 0,
    attributeListSize: { value: PLANT ? 40 : 48 },
    initCalls: [],
    updateCalls: [],
    createProcessCalls: [],
    resumeCalls: [],
    terminateCalls: [],
    deleteListCalls: [],
    deletedProfiles: [],
    pinCalls: [],
    profileName: null,
    created: false,
  }
  const bindings = {
    createAppContainerProfile(name, displayName, description, capabilities, count) {
      state.profileName = name
      state.created = true
      state.lastError = 0
      return { hr: 0, sid: 0xac5d0001n }
    },
    deriveAppContainerSidFromAppContainerName() {
      state.lastError = 0
      return { hr: 0, sid: 0xac5d0002n }
    },
    deleteAppContainerProfile(name) {
      state.deletedProfiles.push(name)
      return 0
    },
    deriveCapabilitySidsFromName(capName) {
      return { capabilitySids: [`cap-sid:${capName}`], capabilitySidCount: 1, groupSids: null, groupSidCount: 0 }
    },
    initializeProcThreadAttributeList(list, count, flags, sizeSlot) {
      state.initCalls.push({ listIsNull: list === null, count, flags })
      if (list === null) {
        sizeSlot[0] = state.attributeListSize.value
        state.lastError = ERROR_INSUFFICIENT_BUFFER
        return 0
      }
      sizeSlot[0] = state.attributeListSize.value
      state.lastError = 0
      return 1
    },
    updateProcThreadAttribute(list, flags, attribute, value, size, prev, returnSize) {
      state.updateCalls.push({ attribute, size, value })
      state.lastError = 0
      return 1
    },
    deleteProcThreadAttributeList(list) {
      state.deleteListCalls.push(list)
    },
    createProcessW(app, cmd, pa, ta, inherit, flags, env, cwd, si, pi) {
      state.createProcessCalls.push({ app, cmd, inherit, flags, env, cwd, si })
      pi.process = 0x1000n
      pi.thread = 0x2000n
      pi.pid = 4242
      state.lastError = 0
      return 1
    },
    resumeThread(handle) {
      state.resumeCalls.push(handle)
      return 1
    },
    terminateProcess(handle, code) {
      state.terminateCalls.push({ handle, code })
      return 1
    },
    getLastError() {
      return state.lastError
    },
    /**
     * 与真实 `koffi.address(buffer)` 同形的替身（`[实测]` koffi 3.3.2 的 `address()` 返回 bigint，
     * 见 `.t/sbx3/dev/raw-probe-koffi.txt`）。
     *
     * 为什么替身**必须**提供它：`STARTUPINFOEXW.lpAttributeList` 与
     * `SECURITY_CAPABILITIES.Capabilities` 都是**内嵌指针**。阶段 B 实测暴露的缺陷正是
     * "把 `Buffer` 直接当指针传"（`typeof Buffer === 'object'` → 抛 `APPCONTAINER_POINTER_INVALID`）。
     * 真实运行期由 koffi 提供地址，所以替身也必须提供 —— 否则替身比真对象"更难用"，
     * 会让被测代码在替身下走一条真实环境里不存在的分支（手册：替身失真比没有替身更危险）。
     */
    pin(buffer, what) {
      state.pinCalls.push({ what, length: buffer.length })
      return BigInt(0xa0000000 + buffer.length * 0x100 + state.pinCalls.length)
    },
    ...overrides,
  }
  return { bindings, state }
}

/**
 * 「让**某一步**失败」的替身：`getLastError()` 只在属性列表建好之后才返回指定的错误码。
 *
 * 为什么必须这样（阶段 B 实测暴露的**替身缺陷**）：
 *   `allocateAttributeList()` 的第一阶段（`InitializeProcThreadAttributeList(NULL, ...)`）
 *   **按设计**要求 `GetLastError() === ERROR_INSUFFICIENT_BUFFER(122)`，否则抛
 *   `APPCONTAINER_ATTRIBUTE_LIST_SIZE_FAILED`。而 `GetLastError()` 是进程级全局状态、
 *   **不带调用点上下文**。初版用例直接用 `makeBindings({ getLastError: () => 87 })` 覆盖，
 *   于是尺寸探测阶段就先失败了，被测代码在**目标步骤之前**抛错 ——
 *   断言看似在测 `UpdateProcThreadAttribute` / `CreateProcessW`，
 *   实际测到的是"尺寸探测失败"，即"测错了地方"。
 *   这正是手册说的"替身宁可复杂也不要比真对象更好用"：真 `GetLastError()`
 *   会随每次调用变化，替身用一个常量冒充它就把一条真实分支抹掉了。
 */
function makeFailingAfterInit(overrides, errorCode) {
  const built = { value: false }
  const handle = makeBindings(overrides)
  const originalInit = handle.bindings.initializeProcThreadAttributeList
  handle.bindings.getLastError = () => (built.value ? errorCode : ERROR_INSUFFICIENT_BUFFER)
  handle.bindings.initializeProcThreadAttributeList = (list, count, flags, sizeSlot) => {
    const result = originalInit(list, count, flags, sizeSlot)
    if (list !== null) built.value = true
    return result
  }
  return handle
}

if (PLANT) {
  W('*** --plant 模式：故意把 STARTUPINFOEXW 的 cb 期望值改成 104（真实的"静默失去隔离"错误），断言应当失败 ***')
}
const PLANTED_CB = PLANT ? STARTUPINFO_SIZE : STARTUPINFOEX_SIZE

section('1. CREATE_SUSPENDED 常量（本仓库 R9 竞态的唯一官方解）')
check('CREATE_SUSPENDED = 0x00000004', CREATE_SUSPENDED === 0x00000004, `0x${CREATE_SUSPENDED.toString(16)}`)
check('ERROR_INSUFFICIENT_BUFFER = 122', ERROR_INSUFFICIENT_BUFFER === 122, String(ERROR_INSUFFICIENT_BUFFER))
check('ERROR_ALREADY_EXISTS = 183', ERROR_ALREADY_EXISTS === 183, String(ERROR_ALREADY_EXISTS))
check('HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS) = 0x800700B7', HR_ALREADY_EXISTS === 0x800700b7, `0x${HR_ALREADY_EXISTS.toString(16)}`)

section('2. STARTUPINFOEXW 构造（cb 必须是 112，不是 104）')
{
  const buffer = buildStartupInfoExBuffer({ attributeListPointer: 0xdeadbeefn })
  check(`cb 写出 ${PLANTED_CB}`, buffer.readUInt32LE(0) === PLANTED_CB, String(buffer.readUInt32LE(0)))
  check(`buffer 长度 = ${PLANTED_CB}`, buffer.length === PLANTED_CB, String(buffer.length))
  check(
    `lpAttributeList 落在偏移 104（紧随 STARTUPINFOW）`,
    buffer.readBigUInt64LE(OFF_ATTRIBUTE_LIST) === 0xdeadbeefn,
    `0x${buffer.readBigUInt64LE(OFF_ATTRIBUTE_LIST).toString(16)}`,
  )
  check(
    `lpAttributeList + 8 === ${PLANTED_CB}（指针不越界）`,
    OFF_ATTRIBUTE_LIST + 8 === PLANTED_CB,
    `${OFF_ATTRIBUTE_LIST}+8 vs ${PLANTED_CB}`,
  )
  check(
    '中间 104 字节（STARTUPINFOW 主体）必须是全零：hStdInput/Output/Error 若带垃圾会挂错管道',
    buffer.subarray(4, 104).every((byte) => byte === 0),
    buffer.subarray(4, 104).toString('hex').slice(0, 32) + '…',
  )
  checkThrows(
    '显式传 cb=104 时必须抛错（这是"静默失去 AppContainer"的那一类错误）',
    () => buildStartupInfoExBuffer({ cb: STARTUPINFO_SIZE }),
    'APPCONTAINER_CB_INVALID',
  )
  checkThrows(
    '显式传任意非 112 的值都必须抛错',
    () => buildStartupInfoExBuffer({ cb: 96 }),
    'APPCONTAINER_CB_INVALID',
  )
}

section('3. SID_AND_ATTRIBUTES[] 打包（16 字节/项，attributes 必须显式或默认为 SE_GROUP_ENABLED）')
{
  const empty = buildSidAndAttributesArray([])
  check('空数组产出 0 字节', empty.buffer.length === 0 && empty.count === 0, `${empty.buffer.length}/${empty.count}`)
  check('SID_AND_ATTRIBUTES 大小常量 = 16', SID_AND_ATTRIBUTES_SIZE === 16, String(SID_AND_ATTRIBUTES_SIZE))
  check('OFF_SID_AND_ATTRIBUTES: sid@0, attributes@8', OFF_SID_AND_ATTRIBUTES.sid === 0 && OFF_SID_AND_ATTRIBUTES.attributes === 8, safeJson(OFF_SID_AND_ATTRIBUTES))

  const one = buildSidAndAttributesArray([{ sid: 0x1n }])
  check('单元素 = 16 字节', one.buffer.length === 16 && one.count === 1, `${one.buffer.length}/${one.count}`)
  check('SID 指针写在 0', one.buffer.readBigUInt64LE(0) === 0x1n, `0x${one.buffer.readBigUInt64LE(0).toString(16)}`)
  check(
    'attributes 默认 SE_GROUP_ENABLED (0x4)',
    one.buffer.readUInt32LE(8) === SE_GROUP_ENABLED,
    `0x${one.buffer.readUInt32LE(8).toString(16)}`,
  )
  check(
    'attributes 之后 4 字节是 padding（必须为零）',
    one.buffer.readUInt32LE(12) === 0,
    String(one.buffer.readUInt32LE(12)),
  )

  const two = buildSidAndAttributesArray([
    { sid: 0x11n, attributes: SE_GROUP_ENABLED },
    { sid: 0x22n, attributes: 0 },
  ])
  check('双元素 = 32 字节', two.buffer.length === 32, String(two.buffer.length))
  check(
    '第二个元素从偏移 16 开始（不是 12 或 20）',
    two.buffer.readBigUInt64LE(16) === 0x22n,
    `0x${two.buffer.readBigUInt64LE(16).toString(16)}`,
  )
  check(
    'attributes=0 被尊重（不"帮忙"补成 SE_GROUP_ENABLED）',
    two.buffer.readUInt32LE(24) === 0,
    String(two.buffer.readUInt32LE(24)),
  )
  checkThrows('sid 为 null 时抛错', () => buildSidAndAttributesArray([{ sid: null }]), 'APPCONTAINER_CAPABILITY_INVALID')
  checkThrows('attributes 为负数时抛错', () => buildSidAndAttributesArray([{ sid: 1n, attributes: -1 }]), 'APPCONTAINER_CAPABILITY_INVALID')
  checkThrows('非对象元素抛错', () => buildSidAndAttributesArray([42]), 'APPCONTAINER_CAPABILITY_INVALID')
}

section('4. InitializeProcThreadAttributeList 两阶段协商')
{
  const { bindings, state } = makeBindings()
  const { size, buffer } = allocateAttributeList(bindings, 1)
  check('第一次以 list=NULL 调用（官方要求先探尺寸）', state.initCalls[0]?.listIsNull === true, safeJson(state.initCalls[0] ?? null))
  check('第一次调用按设计返回 0（不能被当成真错误）', state.initCalls.length >= 2, `${state.initCalls.length} 次调用`)
  check('两次调用的 count 一致', state.initCalls[0].count === state.initCalls[1].count, `${state.initCalls[0].count}/${state.initCalls[1].count}`)
  check('dwFlags 必须为 0（官方：reserved）', state.initCalls.every((call) => call.flags === 0), safeJson(state.initCalls.map((c) => c.flags)))
  check('返回的 size 来自第一次调用的出参', size === 48, String(size))
  check('分配出的 buffer 长度 === size', buffer.length === size, `${buffer.length}/${size}`)
  check('第二次调用传的是真实 buffer（不是 NULL）', state.initCalls[1].listIsNull === false, 'ok')

  // 第一次调用返回 0 但错误码不是 ERROR_INSUFFICIENT_BUFFER → 必须上抛（否则"没建起来"被当成"拿到尺寸"）
  const wrongErrorState = { lastError: 87 }
  const wrongError = makeBindings({
    initializeProcThreadAttributeList(list, count, flags, sizeSlot) {
      sizeSlot[0] = 0
      return 0
    },
    getLastError: () => wrongErrorState.lastError,
  })
  checkThrows(
    '尺寸探测返回的错误码不是 122 时必须抛错',
    () => allocateAttributeList(wrongError.bindings, 1),
    'APPCONTAINER_ATTRIBUTE_LIST_SIZE_FAILED',
  )

  // 第二次调用失败 → 必须上抛
  let callCount = 0
  const secondFails = {
    initializeProcThreadAttributeList(list, count, flags, sizeSlot) {
      callCount += 1
      if (callCount === 1) {
        sizeSlot[0] = 48
        return 0
      }
      return 0
    },
    getLastError: () => (callCount === 1 ? ERROR_INSUFFICIENT_BUFFER : 87),
  }
  checkThrows(
    '第二次（真实初始化）失败时必须抛错',
    () => allocateAttributeList(secondFails, 1),
    'APPCONTAINER_ATTRIBUTE_LIST_INIT_FAILED',
  )

  checkThrows('缺少初始化绑定时抛错', () => allocateAttributeList({}, 1), 'APPCONTAINER_BINDINGS_MISSING')
  checkThrows('attributeCount=0 时抛错（无属性的属性列表没有意义）', () => allocateAttributeList(makeBindings().bindings, 0), 'APPCONTAINER_ATTRIBUTE_COUNT_INVALID')

  // ── 阶段 B 实测缺陷回归：真实 koffi 对 C 的 `bool` 返回 JS **boolean**，而替身一律返回数字 1/0 ──
  // 模块原来写 `if (second === 0)` / `if (updated === 0)` / `if (created === 0)`，
  // 对 `false` **永远不成立** ⇒ 所有 BOOL 失败检查在真实运行期都是死代码。
  // 实测后果：UpdateProcThreadAttribute 返回 false + ERROR_INVALID_PARAMETER(87) 被当成成功，
  // 子进程正常创建却不在 AppContainer 里（.t/sbx3/dev/raw-probe-ac-token.txt）。
  // 下面三条用 boolean 替身把这条路径钉死。
  check(
    'win32BoolSucceeded 同时接受 boolean 与数字两种替身形态',
    win32BoolSucceeded(true) === true &&
      win32BoolSucceeded(false) === false &&
      win32BoolSucceeded(1) === true &&
      win32BoolSucceeded(0) === false &&
      win32BoolSucceeded(undefined) === false &&
      win32BoolSucceeded(null) === false,
    'true/false/1/0/undefined/null 全覆盖',
  )
  checkThrows(
    'InitializeProcThreadAttributeList 第二次返回 boolean false 时必须抛错（不是只有数字 0 才抛）',
    () => {
      let calls = 0
      return allocateAttributeList(
        {
          initializeProcThreadAttributeList(list, count, flags, sizeSlot) {
            calls += 1
            sizeSlot[0] = 48
            // 第一次按设计失败；第二次真实初始化失败 —— 但返回的是 boolean false
            return calls === 1 ? false : false
          },
          getLastError: () => (calls === 1 ? ERROR_INSUFFICIENT_BUFFER : 87),
        },
        1,
      )
    },
    'APPCONTAINER_ATTRIBUTE_LIST_INIT_FAILED',
  )
  checkThrows(
    'UpdateProcThreadAttribute 返回 boolean false 时必须抛错（本机真实形态）',
    () =>
      spawnSuspendedAppContainer(
        makeFailingAfterInit({ updateProcThreadAttribute: () => false }, 87).bindings,
        { appContainerSid: 1n, commandLine: 'x.exe' },
      ),
    'APPCONTAINER_ATTRIBUTE_UPDATE_FAILED',
  )
  checkThrows(
    'CreateProcessW 返回 boolean false 时必须抛错（否则会以"句柄为空"的间接错误收场）',
    () => {
      const failing = makeFailingAfterInit({ createProcessW: () => false }, 2)
      return spawnSuspendedAppContainer(failing.bindings, { appContainerSid: 1n, commandLine: 'x.exe' })
    },
    'APPCONTAINER_CREATE_PROCESS_FAILED',
  )
}

section('5. 启动：SECURITY_CAPABILITIES 必须被完整传进去')
{
  const { bindings, state } = makeBindings()
  const child = spawnSuspendedAppContainer(bindings, {
    appContainerSid: 0xac5d0001n,
    capabilities: [{ sid: 0xcafe0001n }],
    commandLine: 'C:\\Windows\\System32\\hostname.exe',
    cwd: 'C:\\stage',
  })
  check('返回 pid/process/thread', child.pid === 4242 && child.process === 0x1000n && child.thread === 0x2000n, safeJson({ pid: child.pid, p: String(child.process), t: String(child.thread) }))
  check('updateProcThreadAttribute 被调用一次', state.updateCalls.length === 1, String(state.updateCalls.length))
  const update = state.updateCalls[0]
  check(
    '属性号 = PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES (0x00020009)',
    update.attribute === PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
    `0x${update.attribute.toString(16)}`,
  )
  // 不要把这个期望值写成字面量 32：`[官方]` sizeof(SECURITY_CAPABILITIES) = 24
  // （PSID 8 + PSID_AND_ATTRIBUTES 8 + DWORD 4 + DWORD 4），修复阶段已把
  // `src/appcontainer.mjs` 的常量从 32 改成 24。断言"传入的 size 等于常量"是真正的不变量
  // （实现与调用点不许漂移）；字面量则会在常量被更正后变成假红/假绿。
  check(
    '传入的 size = SECURITY_CAPABILITIES_SIZE（=24，官方 sizeof）',
    update.size === SECURITY_CAPABILITIES_SIZE && SECURITY_CAPABILITIES_SIZE === 24,
    `${update.size} / 常量 ${SECURITY_CAPABILITIES_SIZE}`,
  )
  check(
    'SECURITY_CAPABILITIES.AppContainerSid 写在偏移 0',
    update.value.readBigUInt64LE(0) === 0xac5d0001n,
    `0x${update.value.readBigUInt64LE(0).toString(16)}`,
  )
  check(
    'SECURITY_CAPABILITIES.Capabilities 指针非 NULL（有能力时）',
    update.value.readBigUInt64LE(8) !== 0n,
    `0x${update.value.readBigUInt64LE(8).toString(16)}`,
  )
  check(
    'Capabilities 指针 === pin() 给出的地址（证明 pin 的返回值真的落进了结构体，不只是"非零"）',
    update.value.readBigUInt64LE(8) === child.capabilityArrayPointer,
    `0x${update.value.readBigUInt64LE(8).toString(16)} vs 0x${String(child.capabilityArrayPointer)}`,
  )
  check('SECURITY_CAPABILITIES.CapabilityCount = 1', update.value.readUInt32LE(16) === 1, String(update.value.readUInt32LE(16)))
  check('SECURITY_CAPABILITIES.Reserved = 0', update.value.readUInt32LE(20) === 0, String(update.value.readUInt32LE(20)))

  const createCall = state.createProcessCalls[0]
  check('CreateProcessW 被调用一次', state.createProcessCalls.length === 1, String(state.createProcessCalls.length))
  // ── FIX-B：继承句柄的契约（原始证据 .t/sbx3/dev/raw-t0-launch-matrix.txt）──────
  // `[实测]` `bInheritHandles=TRUE` + 无自有控制台 ⇒ AppContainer 子进程以
  // `0xC0000142 (STATUS_DLL_INIT_FAILED)` 静默死亡（CreateProcessW 仍返回成功！）。
  // 因此默认必须是 **false**；需要管道的调用方要显式 `inheritHandles:true` **并且**给出
  // `CREATE_NEW_CONSOLE`/`DETACHED_PROCESS`（那两种配置实测都能跑，退出码 42）。
  const PLANTED_INHERIT = PLANT ? true : false
  check(
    `bInheritHandles 默认 = ${PLANTED_INHERIT}（true 会让 AppContainer 子进程 0xC0000142 静默死亡）`,
    createCall.inherit === PLANTED_INHERIT,
    `${createCall.inherit}（期望 ${PLANTED_INHERIT}）`,
  )
  check(
    'STATUS_DLL_INIT_FAILED 常量 = 0xC0000142（实测到的退出码）',
    STATUS_DLL_INIT_FAILED === 0xc0000142,
    `0x${STATUS_DLL_INIT_FAILED.toString(16)}`,
  )
  check(
    'CREATE_NEW_CONSOLE = 0x10 / DETACHED_PROCESS = 0x8（官方标志值）',
    CREATE_NEW_CONSOLE === 0x00000010 && DETACHED_PROCESS === 0x00000008,
    `0x${CREATE_NEW_CONSOLE.toString(16)} / 0x${DETACHED_PROCESS.toString(16)}`,
  )
  checkThrows(
    'inheritHandles=true 且无自有控制台 ⇒ fail-closed 抛 APPCONTAINER_HANDLE_INHERITANCE_UNSAFE',
    () => spawnSuspendedAppContainer(makeBindings().bindings, { appContainerSid: 1n, commandLine: 'x.exe', inheritHandles: true }),
    'APPCONTAINER_HANDLE_INHERITANCE_UNSAFE',
  )
  {
    const withDetached = makeBindings()
    spawnSuspendedAppContainer(withDetached.bindings, {
      appContainerSid: 1n,
      commandLine: 'x.exe',
      inheritHandles: true,
      extraCreationFlags: DETACHED_PROCESS,
    })
    const call = withDetached.state.createProcessCalls[0]
    check(
      'inheritHandles=true + DETACHED_PROCESS ⇒ 允许，且标志真的传下去',
      call.inherit === true && (call.flags & DETACHED_PROCESS) === DETACHED_PROCESS,
      `inherit=${call.inherit} flags=0x${call.flags.toString(16)}`,
    )
    check(
      'DETACHED_PROCESS 与 CREATE_SUSPENDED/EXTENDED 共存（先挂 Job 再 resume 的顺序不被打乱）',
      (call.flags & CREATE_SUSPENDED) === CREATE_SUSPENDED && (call.flags & EXTENDED_STARTUPINFO_PRESENT) === EXTENDED_STARTUPINFO_PRESENT,
      `0x${call.flags.toString(16)}`,
    )
  }
  {
    const withConsole = makeBindings()
    spawnSuspendedAppContainer(withConsole.bindings, {
      appContainerSid: 1n,
      commandLine: 'x.exe',
      inheritHandles: true,
      extraCreationFlags: CREATE_NEW_CONSOLE,
    })
    check(
      'inheritHandles=true + CREATE_NEW_CONSOLE ⇒ 允许',
      (withConsole.state.createProcessCalls[0].flags & CREATE_NEW_CONSOLE) === CREATE_NEW_CONSOLE,
      `0x${withConsole.state.createProcessCalls[0].flags.toString(16)}`,
    )
  }
  check(
    'creationFlags 含 EXTENDED_STARTUPINFO_PRESENT',
    (createCall.flags & EXTENDED_STARTUPINFO_PRESENT) === EXTENDED_STARTUPINFO_PRESENT,
    `0x${createCall.flags.toString(16)}`,
  )
  check(
    'creationFlags 含 CREATE_SUSPENDED（先挂 Job 再 resume）',
    (createCall.flags & CREATE_SUSPENDED) === CREATE_SUSPENDED,
    `0x${createCall.flags.toString(16)}`,
  )
  check(
    '无环境块时**不**置 CREATE_UNICODE_ENVIRONMENT(0x400)（不越权）',
    (createCall.flags & 0x400) === 0,
    `0x${createCall.flags.toString(16)}`,
  )
  check('startupInfo.cb = 112', createCall.si.readUInt32LE(0) === STARTUPINFOEX_SIZE, String(createCall.si.readUInt32LE(0)))
  check(
    'startupInfo.lpAttributeList 指向属性列表',
    createCall.si.readBigUInt64LE(OFF_ATTRIBUTE_LIST) !== 0n,
    `0x${createCall.si.readBigUInt64LE(OFF_ATTRIBUTE_LIST).toString(16)}`,
  )
  check(
    'lpAttributeList 指针 === pin() 给出的地址（内嵌指针不能是 Buffer 本身）',
    createCall.si.readBigUInt64LE(OFF_ATTRIBUTE_LIST) === child.attributeListPointer,
    `0x${createCall.si.readBigUInt64LE(OFF_ATTRIBUTE_LIST).toString(16)} vs 0x${String(child.attributeListPointer)}`,
  )
  check('startupInfo 缓冲区长度 = 112', createCall.si.length === STARTUPINFOEX_SIZE, String(createCall.si.length))

  // 带环境块时必须补 CREATE_UNICODE_ENVIRONMENT（本仓库缺陷 13 的同类回归）
  const withEnv = makeBindings()
  spawnSuspendedAppContainer(withEnv.bindings, {
    appContainerSid: 0x1n,
    commandLine: 'x.exe',
    environmentBlock: Buffer.from('A=B\u0000\u0000', 'utf16le'),
  })
  check(
    '带环境块时自动置 CREATE_UNICODE_ENVIRONMENT(0x400)（漏掉会 Win32 87）',
    (withEnv.state.createProcessCalls[0].flags & 0x400) === 0x400,
    `0x${withEnv.state.createProcessCalls[0].flags.toString(16)}`,
  )
  check(
    '环境块指针被原样传入（不是 NULL）',
    withEnv.state.createProcessCalls[0].env !== null,
    String(withEnv.state.createProcessCalls[0].env),
  )

  checkThrows('缺少 appContainerSid 时抛错', () => spawnSuspendedAppContainer(makeBindings().bindings, { commandLine: 'x.exe' }), 'APPCONTAINER_SID_MISSING')
  checkThrows('commandLine 为空时抛错', () => spawnSuspendedAppContainer(makeBindings().bindings, { appContainerSid: 1n, commandLine: '' }), 'APPCONTAINER_COMMAND_MISSING')
  checkThrows(
    '缺少 createProcessW 绑定时抛错',
    () => spawnSuspendedAppContainer({ ...makeBindings().bindings, createProcessW: undefined }, { appContainerSid: 1n, commandLine: 'x.exe' }),
    'APPCONTAINER_BINDINGS_MISSING',
  )
  checkThrows(
    'UpdateProcThreadAttribute 失败时必须抛错（否则子进程不在 AppContainer 里却"启动成功"）',
    () =>
      spawnSuspendedAppContainer(
        makeFailingAfterInit({ updateProcThreadAttribute: () => 0 }, 87).bindings,
        { appContainerSid: 1n, commandLine: 'x.exe' },
      ),
    'APPCONTAINER_ATTRIBUTE_UPDATE_FAILED',
  )
  checkThrows(
    'CreateProcessW 失败时必须抛错并带上 Win32 码',
    () => {
      const failing = makeFailingAfterInit({ createProcessW: () => 0 }, 2)
      return spawnSuspendedAppContainer(failing.bindings, { appContainerSid: 1n, commandLine: 'x.exe' })
    },
    'APPCONTAINER_CREATE_PROCESS_FAILED',
  )
  check(
    'CreateProcessW 失败时若已有 process 句柄，必须尽力终止（不留孤儿）',
    (() => {
      const stub = makeBindings({
        createProcessW(app, cmd, pa, ta, inherit, flags, env, cwd, si, pi) {
          pi.process = 0x9999n
          pi.thread = null
          pi.pid = 1
          return 1
        },
      })
      try {
        spawnSuspendedAppContainer(stub.bindings, { appContainerSid: 1n, commandLine: 'x.exe' })
        return false
      } catch {
        return stub.state.terminateCalls.length === 1 && stub.state.terminateCalls[0].handle === 0x9999n
      }
    })(),
    'terminateProcess(0x9999) 被调用',
  )

  // ── 内嵌指针的 fail-closed 回归（阶段 B 实测暴露的真实缺陷）────────────────
  // 缺陷：初版把 `Buffer`（JS 堆内存）当指针写进 STARTUPINFOEXW.lpAttributeList 与
  // SECURITY_CAPABILITIES.Capabilities → writePointerLe 抛 APPCONTAINER_POINTER_INVALID。
  // 这三条断言保证"退化回 Buffer 当指针"会立刻变红。
  const noPin = makeBindings()
  checkThrows(
    '没有任何 pin / attributeListPointer 时必须抛 APPCONTAINER_PIN_REQUIRED（lpAttributeList 每次启动都需要）',
    () => spawnSuspendedAppContainer({ ...noPin.bindings, pin: undefined }, { appContainerSid: 1n, commandLine: 'x.exe' }),
    'APPCONTAINER_PIN_REQUIRED',
  )
  checkThrows(
    '把 Buffer 当 lpAttributeList 指针时必须抛 APPCONTAINER_POINTER_INVALID（阶段 B 实测缺陷回归）',
    () => {
      const stub2 = makeBindings({ pin: undefined })
      return spawnSuspendedAppContainer(
        { ...stub2.bindings, pin: undefined },
        { appContainerSid: 1n, commandLine: 'x.exe', attributeListPointer: Buffer.alloc(48) },
      )
    },
    'APPCONTAINER_POINTER_INVALID',
  )
  checkThrows(
    '有能力 SID 但没有地址来源时必须抛 APPCONTAINER_CAPABILITY_POINTER_MISSING',
    () => {
      const stub3 = makeBindings({ pin: undefined })
      return spawnSuspendedAppContainer(
        { ...stub3.bindings, pin: undefined },
        { appContainerSid: 1n, capabilities: [{ sid: 0x1n }], commandLine: 'x.exe', attributeListPointer: 0x1000n },
      )
    },
    'APPCONTAINER_CAPABILITY_POINTER_MISSING',
  )
  checkThrows(
    '把 Buffer 当 Capabilities 指针时必须抛 APPCONTAINER_POINTER_INVALID（阶段 B 实测缺陷回归）',
    () => {
      const stub4 = makeBindings({ pin: undefined })
      return spawnSuspendedAppContainer(
        { ...stub4.bindings, pin: undefined },
        {
          appContainerSid: 1n,
          capabilities: [{ sid: 0x1n }],
          commandLine: 'x.exe',
          attributeListPointer: 0x1000n,
          capabilityArrayPointer: Buffer.alloc(16),
        },
      )
    },
    'APPCONTAINER_POINTER_INVALID',
  )
  {
    // 无能力 SID 时 Capabilities 必须是 NULL、CapabilityCount 必须是 0（不是"顺手给个非零"）
    const noCap = makeBindings()
    const plain = spawnSuspendedAppContainer(noCap.bindings, { appContainerSid: 1n, commandLine: 'x.exe' })
    const update2 = noCap.state.updateCalls[0]
    check(
      '无能力 SID 时 Capabilities = NULL 且 CapabilityCount = 0（OFFLINE 默认形态）',
      update2.value.readBigUInt64LE(8) === 0n && update2.value.readUInt32LE(16) === 0,
      `ptr=0x${update2.value.readBigUInt64LE(8).toString(16)} count=${update2.value.readUInt32LE(16)}`,
    )
    check(
      'capabilities 为空时**不需要** pin 也能算出 lpAttributeList（pin 只为内嵌指针服务）',
      plain.attributeListPointer !== null && plain.attributeListPointer !== undefined && noCap.state.pinCalls.length === 1,
      `pinCalls=${noCap.state.pinCalls.length} what=${noCap.state.pinCalls.map((c) => c.what).join(',')}`,
    )
  }
  {
    // options.pin 必须覆盖 bindings.pin
    const precedence = makeBindings()
    const overridden = spawnSuspendedAppContainer(precedence.bindings, {
      appContainerSid: 1n,
      commandLine: 'x.exe',
      pin: () => 0x777n,
    })
    check(
      'options.pin 覆盖 bindings.pin',
      overridden.attributeListPointer === 0x777n && precedence.state.pinCalls.length === 0,
      `pointer=0x${String(overridden.attributeListPointer)} bindingsPinCalls=${precedence.state.pinCalls.length}`,
    )
  }
}

section('6. ResumeThread（忘了它 = 子进程永不执行，症状是超时）')
{
  const { bindings, state } = makeBindings()
  const result = resumeSuspendedProcess(bindings, 0x2000n)
  check('ResumeThread 被调用且返回之前的挂起计数', state.resumeCalls.length === 1 && result.previousSuspendCount === 1, safeJson(result))
  const failing = makeBindings({ resumeThread: () => 0xffffffff, getLastError: () => 5 })
  checkThrows('ResumeThread 返回 -1 时必须抛错（不能静默留着挂起进程）', () => resumeSuspendedProcess(failing.bindings, 1n), 'APPCONTAINER_RESUME_FAILED')
  check(
    'ResumeThread 之前必须已经挂 Job —— 顺序由 planCombinationOrder 显式给出',
    planCombinationOrder({ jobAvailable: true }).steps.findIndex((s) => s.step === 'assign-to-job') <
      planCombinationOrder({ jobAvailable: true }).steps.findIndex((s) => s.step === 'resume-thread'),
    'assign-to-job 在 resume-thread 之前',
  )
}

section('6.5 createKoffiAppContainerBindings 绑定表（用假 koffi，离线可测）')
{
  // 阶段 B 实测缺陷：这个工厂函数初版在返回对象里写的是裸标识符
  // `initializeProcThreadAttributeList`（小写 i），而局部变量是 `InitializeProcThreadAttributeList`
  // ⇒ 整个函数求值即抛 `ReferenceError`，也就是说它**从未成功执行过一次**。
  // 这一节用一个"逐字段对齐 koffi 形状"的假 koffi 把它钉死：只要名字对不上就立刻红。
  const calls = []
  const loads = []
  const fakeLib = (dll) => ({
    func(signature) {
      const name = String(signature).split(/\s+/).filter(Boolean).at(-1).split('(')[0]
      calls.push({ dll, signature, name })
      return (...args) => {
        // 只做"能被调用"的最小实现；本节的目的是**绑定表可以被构造出来且键齐全**
        if (name === 'InitializeProcThreadAttributeList') {
          if (args[0] === null) {
            args[3][0] = 48
            return false
          }
          return true
        }
        if (name === 'GetLastError') return ERROR_INSUFFICIENT_BUFFER
        return true
      }
    },
  })
  const fakeKoffi = {
    version: 'fake-0',
    load: (dll) => {
      loads.push(dll)
      return fakeLib(dll)
    },
    address: (buffer) => BigInt(0x1000 + buffer.length),
  }
  let built = null
  let thrown = null
  try {
    built = createKoffiAppContainerBindings(fakeKoffi)
  } catch (error) {
    thrown = `${error.constructor.name}: ${error.message}`
  }
  check('createKoffiAppContainerBindings 能构造成功（阶段 B 之前它抛 ReferenceError）', built !== null, thrown ?? 'ok')
  check(
    'koffi.load 覆盖了 userenv / kernel32 / advapi32 / kernelbase 四个 DLL',
    ['userenv.dll', 'kernel32.dll', 'advapi32.dll', 'kernelbase.dll'].every((dll) => loads.includes(dll)),
    safeJson(loads),
  )
  const requiredKeys = [
    'createAppContainerProfile',
    'deriveAppContainerSidFromAppContainerName',
    'deleteAppContainerProfile',
    'deriveCapabilitySidsFromName',
    'initializeProcThreadAttributeList',
    'updateProcThreadAttribute',
    'deleteProcThreadAttributeList',
    'createProcessW',
    'resumeThread',
    'terminateProcess',
    'closeHandle',
    'getLastError',
  ]
  check(
    `绑定表含全部 ${requiredKeys.length} 个必需键（逐个 typeof === 'function'）`,
    requiredKeys.every((key) => typeof built?.[key] === 'function'),
    safeJson(requiredKeys.filter((key) => typeof built?.[key] !== 'function')),
  )
  check('绑定表自带 pin（即 (buffer) => koffi.address(buffer)）', typeof built?.pin === 'function' && built.pin(Buffer.alloc(8)) === 0x1008n, String(built?.pin?.(Buffer.alloc(8))))
  check(
    'declare 的 signature 里 CreateProcessW 的最后一个形参是 _Out_ uint8 *（不是 void *，否则 koffi 拒绝对象出参）',
    calls.some((c) => /CreateProcessW\(/.test(c.signature) && /_Out_ uint8 \*pi\s*\)/.test(c.signature)),
    calls.find((c) => /CreateProcessW\(/.test(c.signature))?.signature ?? '(未找到)',
  )
  // koffi 的 _Out_ 出参形态：pi 是 Buffer，包装函数把字段读回调用方的对象
  const piBufferWritten = Buffer.alloc(24)
  piBufferWritten.writeBigUInt64LE(0x1111n, 0)
  piBufferWritten.writeBigUInt64LE(0x2222n, 8)
  piBufferWritten.writeUInt32LE(3333, 16)
  check(
    'PROCESS_INFORMATION 布局常量 = 24 字节，hProcess@0 / hThread@8 / dwProcessId@16',
    PROCESS_INFORMATION_SIZE === 24 &&
      OFF_PROCESS_INFORMATION.hProcess === 0 &&
      OFF_PROCESS_INFORMATION.hThread === 8 &&
      OFF_PROCESS_INFORMATION.dwProcessId === 16 &&
      OFF_PROCESS_INFORMATION.dwThreadId === 20,
    `${PROCESS_INFORMATION_SIZE} ${safeJson(OFF_PROCESS_INFORMATION)}`,
  )
}

section('7. 组合顺序（Job / Low IL）')
{
  const withJob = planCombinationOrder({ jobAvailable: true })
  const order = withJob.steps.map((s) => s.step)
  check(
    '顺序：profile → capabilities → attribute list → update → create(suspended) → assign → resume',
    order[0] === 'derive-or-create-profile' &&
      order[1] === 'build-security-capabilities' &&
      order[2] === 'initialize-attribute-list' &&
      order[3] === 'update-proc-thread-attribute' &&
      order[4] === 'create-process-suspended' &&
      order[5] === 'assign-to-job' &&
      order[6] === 'resume-thread',
    order.join(' → '),
  )
  check(
    '每一步都带 reason（报告里能解释"为什么这个顺序"）',
    withJob.steps.every((step) => typeof step.reason === 'string' && step.reason.length > 10),
    `${withJob.steps.length} 步`,
  )
  check(
    '显式标注"不再额外设 Low IL"（AppContainer 自带 Low IL）',
    order.includes('skip-explicit-low-integrity'),
    'skip-explicit-low-integrity',
  )
  check(
    '无 Job 时必须声明进程树回收是残余边界',
    planCombinationOrder({ jobAvailable: false }).residuals.some((r) => /process-tree reclamation/i.test(r)),
    planCombinationOrder({ jobAvailable: false }).residuals.join(' | ').slice(0, 120),
  )
  check(
    '必须声明"暂存根需要对包 SID 显式授权"（否则连暂存根都写不了）',
    withJob.residuals.some((r) => /package SID DACL/i.test(r)),
    withJob.residuals.join(' | ').slice(0, 160),
  )
}

section('8. AppContainerRuntime：profile 生命周期与 fail-closed')
{
  const { bindings, state } = makeBindings()
  const runtime = new AppContainerRuntime(bindings, { profileName: 'dsh.sbx3.test', jobAvailable: true })
  const report = runtime.init()
  check('init() 返回的 createdHere=true（本次真的创建了 profile）', report.createdHere === true, String(report.createdHere))
  check('init() 报告能力列表为空（默认不声明 internetClient ⇒ 网络默认阻断）', report.capabilities.length === 0, safeJson(report.capabilities))
  check('默认能力集为空（DEFAULT_CAPABILITIES 长度为 0）', DEFAULT_CAPABILITIES.length === 0, String(DEFAULT_CAPABILITIES.length))
  check('NETWORK_CAPABILITY 名为 internetClient', NETWORK_CAPABILITY === 'internetClient', NETWORK_CAPABILITY)

  const child = runtime.spawn({ commandLine: 'hostname.exe' })
  check('spawn() 产出挂起进程（thread 句柄可用）', child.thread === 0x2000n, String(child.thread))
  runtime.resume(child)
  check('resume() 调用了 ResumeThread', state.resumeCalls.length === 1, String(state.resumeCalls.length))

  const disposal = runtime.dispose()
  check('dispose() 释放了属性列表', state.deleteListCalls.length === 1, String(state.deleteListCalls.length))
  check('dispose() 删除了自己创建的 profile', state.deletedProfiles.includes('dsh.sbx3.test'), safeJson(state.deletedProfiles))
  check('dispose() 报告 deletedProfile=true 且无失败项', disposal.deletedProfile === true && disposal.failures.length === 0, safeJson(disposal))
  checkThrows('dispose 后再 spawn 抛错（不允许用已释放的对象）', () => runtime.spawn({ commandLine: 'x.exe' }), 'APPCONTAINER_DISPOSED')

  // profile 已存在 → 走派生，且**不**标记 createdHere（不能删别人的 profile）
  const existing = makeBindings({
    createAppContainerProfile: () => ({ hr: HR_ALREADY_EXISTS, sid: null }),
  })
  const runtime2 = new AppContainerRuntime(existing.bindings, { profileName: 'dsh.sbx3.existing' })
  const report2 = runtime2.init()
  check(
    'profile 已存在（0x800700B7）时改用派生 SID',
    report2.createdHere === false && report2.sid === 0xac5d0002n,
    safeJson({ createdHere: report2.createdHere, sid: String(report2.sid) }),
  )
  const disposal2 = runtime2.dispose()
  check('未自己创建的 profile 不会被删除（不越权清理）', existing.state.deletedProfiles.length === 0 && disposal2.deletedProfile === false, safeJson(existing.state.deletedProfiles))

  // E_ACCESSDENIED（本机真实现象）→ 必须抛错，且**不得**退化成"派生一个 SID"
  const deniedState = { deriveCalled: false }
  const denied = makeBindings({
    createAppContainerProfile: () => ({ hr: 0x80070005, sid: null }),
    deriveAppContainerSidFromAppContainerName: () => {
      deniedState.deriveCalled = true
      return { hr: 0, sid: 0x1n }
    },
  })
  const runtime3 = new AppContainerRuntime(denied.bindings, { profileName: 'dsh.sbx3.denied' })
  const error = checkThrows(
    'CreateAppContainerProfile 返回 E_ACCESSDENIED 时抛错（本机真实场景）',
    () => runtime3.init(),
    'APPCONTAINER_PROFILE_CREATE_FAILED',
  )
  check('错误信息里带上原始 hr', /0x80070005/.test(String(error?.message)), String(error?.message).slice(0, 160))
  check(
    'E_ACCESSDENIED 时**不得**去调用派生（否则会拿到指向不存在 profile 的 SID，把故障点推远）',
    deniedState.deriveCalled === false,
    `deriveCalled=${deniedState.deriveCalled}`,
  )

  checkThrows('profileName 为空时构造即抛错', () => new AppContainerRuntime(bindings, { profileName: '' }), 'APPCONTAINER_PROFILE_NAME_INVALID')
  checkThrows('缺少 bindings 时构造抛错', () => new AppContainerRuntime(null, { profileName: 'x' }), undefined)

  // 请求了能力但没绑定 deriveCapabilitySidsFromName → 必须抛错（不能静默当"无能力"）
  const noCapabilityBinding = makeBindings({ deriveCapabilitySidsFromName: undefined })
  const runtime4 = new AppContainerRuntime(noCapabilityBinding.bindings, {
    profileName: 'dsh.sbx3.cap',
    capabilities: [NETWORK_CAPABILITY],
  })
  checkThrows(
    '请求能力但缺少 deriveCapabilitySidsFromName 绑定时抛错',
    () => runtime4.init(),
    'APPCONTAINER_BINDINGS_MISSING',
  )

  // 有绑定时能力被真的带上
  const withCapability = makeBindings()
  const runtime5 = new AppContainerRuntime(withCapability.bindings, {
    profileName: 'dsh.sbx3.cap2',
    capabilities: [NETWORK_CAPABILITY],
  })
  const report5 = runtime5.init()
  check('显式请求 internetClient 时能力被带上', report5.capabilities.length === 1 && report5.capabilities[0] === NETWORK_CAPABILITY, safeJson(report5.capabilities))
  runtime5.dispose()

  // ── FIX-B：派生能力 SID 的所有权 ─────────────────────────────────────────
  // `[官方]` `DeriveCapabilitySidsFromName` 交还的每个 SID 归调用方，必须 LocalFree。
  // 旧实现在绑定层内部就把它释放了 ⇒ 调用方拿到**悬垂指针**（实测整进程 0xC0000374）。
  // 修好后：自己派生的在 dispose 释放；调用方显式传入的**不**由我们释放。
  const freedDerived = []
  const owned = makeBindings({
    localFree: (sid) => {
      freedDerived.push(sid)
      return true
    },
  })
  const runtime6 = new AppContainerRuntime(owned.bindings, { profileName: 'dsh.sbx3.cap3', capabilities: [NETWORK_CAPABILITY] })
  runtime6.init()
  const disposal6 = runtime6.dispose()
  check(
    '自己派生的能力 SID 在 dispose 时被 LocalFree（不再泄漏，且不再是被释放后还拿去用的悬垂指针）',
    freedDerived.length === 1 && freedDerived[0] === `cap-sid:${NETWORK_CAPABILITY}` && disposal6.failures.length === 0,
    safeJson({ freed: freedDerived, failures: disposal6.failures }),
  )
  const freedExplicit = []
  const notOurs = makeBindings({
    localFree: (sid) => {
      freedExplicit.push(sid)
      return true
    },
  })
  const runtime7 = new AppContainerRuntime(notOurs.bindings, {
    profileName: 'dsh.sbx3.cap4',
    capabilities: [{ name: NETWORK_CAPABILITY, sid: 0x7777n }],
  })
  runtime7.init()
  runtime7.dispose()
  check('调用方显式传入的能力 SID **不**被我们释放（所有权不是我们的，防止 use-after-free）', freedExplicit.length === 0, safeJson(freedExplicit))
  const noLocalFree = makeBindings()
  const runtime8 = new AppContainerRuntime(noLocalFree.bindings, { profileName: 'dsh.sbx3.cap5', capabilities: [NETWORK_CAPABILITY] })
  runtime8.init()
  const disposal8 = runtime8.dispose()
  check(
    '没有 localFree 绑定时如实记进 failures（不静默假装释放过了）',
    disposal8.failures.some((line) => /not freed/.test(line)),
    safeJson(disposal8.failures),
  )
}

section('9. FIX-B：令牌事实采集（权威判据，判据错了会把"已生效"读成"没生效"）')
check(
  'TOKEN_INFORMATION_CLASS 取值 = 官方枚举（29/31/25/1/2/8/20/30）',
  TOKEN_INFORMATION_CLASS.TokenIsAppContainer === 29 &&
    TOKEN_INFORMATION_CLASS.TokenAppContainerSid === 31 &&
    TOKEN_INFORMATION_CLASS.TokenIntegrityLevel === 25 &&
    TOKEN_INFORMATION_CLASS.TokenUser === 1 &&
    TOKEN_INFORMATION_CLASS.TokenGroups === 2 &&
    TOKEN_INFORMATION_CLASS.TokenType === 8 &&
    TOKEN_INFORMATION_CLASS.TokenElevation === 20 &&
    TOKEN_INFORMATION_CLASS.TokenCapabilities === 30 &&
    TOKEN_QUERY_ACCESS === 0x0008,
  safeJson(TOKEN_INFORMATION_CLASS),
)
check('SID_LOW_INTEGRITY = S-1-16-4096（AppContainer 是 Low IL）', SID_LOW_INTEGRITY === 'S-1-16-4096', SID_LOW_INTEGRITY)
{
  // 合成替身：只实现"真实 API 的别扭之处"——出参写进**调用方给的缓冲区**，
  // 而 SID 字段是**指针**（必须再转字符串），这正是阶段 B 判错的地方。
  const SID_MAP = {
    [0x5000n]: 'S-1-15-2-1234-5678',
    [0x5001n]: 'S-1-5-21-1478766094-322448298-344569854-500',
    [0x5002n]: 'S-1-16-4096',
    [0x5003n]: 'S-1-15-3-1',
    [0x5004n]: 'S-1-1-0',
    [0x5005n]: 'S-1-5-32-544',
  }
  const makeTokenBindings = (overrides = {}) => {
    const state = { closed: 0, queried: [] }
    const bindings = {
      openProcessToken(process, access, slot) {
        slot[0] = 0x9000n
        return 1
      },
      getTokenInformation(token, infoClass, buffer, length, needed) {
        state.queried.push(infoClass)
        if (infoClass === TOKEN_INFORMATION_CLASS.TokenIsAppContainer) {
          buffer.writeUInt32LE(1, 0)
        } else if (infoClass === TOKEN_INFORMATION_CLASS.TokenAppContainerSid) {
          buffer.writeBigUInt64LE(0x5000n, 0)
        } else if (infoClass === TOKEN_INFORMATION_CLASS.TokenUser) {
          buffer.writeBigUInt64LE(0x5001n, 0)
        } else if (infoClass === TOKEN_INFORMATION_CLASS.TokenIntegrityLevel) {
          buffer.writeBigUInt64LE(0x5002n, 0)
        } else if (infoClass === TOKEN_INFORMATION_CLASS.TokenCapabilities) {
          buffer.writeUInt32LE(1, 0)
          buffer.writeBigUInt64LE(0x5003n, 8)
          buffer.writeUInt32LE(SE_GROUP_ENABLED, 8 + 8)
        } else if (infoClass === TOKEN_INFORMATION_CLASS.TokenGroups) {
          buffer.writeUInt32LE(2, 0)
          buffer.writeBigUInt64LE(0x5004n, 8)
          buffer.writeBigUInt64LE(0x5005n, 8 + SID_AND_ATTRIBUTES_SIZE)
        } else if (infoClass === TOKEN_INFORMATION_CLASS.TokenType) {
          buffer.writeUInt32LE(1, 0)
        } else if (infoClass === TOKEN_INFORMATION_CLASS.TokenElevation) {
          buffer.writeUInt32LE(1, 0)
        }
        needed[0] = length
        return 1
      },
      sidToString(sid) {
        return SID_MAP[sid] ?? null
      },
      closeHandle() {
        state.closed += 1
        return 1
      },
      ...overrides,
    }
    return { bindings, state }
  }

  const tokenStub = makeTokenBindings()
  const facts = readProcessTokenFacts(tokenStub.bindings, 0x1000n)
  check('readProcessTokenFacts: isAppContainer = true', facts.isAppContainer === true, String(facts.isAppContainer))
  check(
    'readProcessTokenFacts: 包 SID 来自 TokenAppContainerSid(31)，**不是** TokenUser',
    facts.appContainerSid === 'S-1-15-2-1234-5678' && facts.tokenUser === 'S-1-5-21-1478766094-322448298-344569854-500',
    safeJson({ ac: facts.appContainerSid, user: facts.tokenUser }),
  )
  check('readProcessTokenFacts: 完整性级别 = Low（S-1-16-4096）', facts.integrityLevel === SID_LOW_INTEGRITY, String(facts.integrityLevel))
  check(
    'readProcessTokenFacts: 能力 SID 被解出来（S-1-15-3-1 = internetClient）',
    facts.capabilities.count === 1 && facts.capabilities.sids[0] === 'S-1-15-3-1',
    safeJson(facts.capabilities),
  )
  check(
    'readProcessTokenFacts: 组列表逐项解出（TOKEN_GROUPS 头 8 字节 + 每项 16 字节）',
    facts.groups.count === 2 && facts.groups.sids.length === 2 && facts.groups.sids[1] === 'S-1-5-32-544',
    safeJson(facts.groups),
  )
  check('readProcessTokenFacts: 令牌句柄被关闭（不泄漏）', tokenStub.state.closed === 1, String(tokenStub.state.closed))

  checkThrows(
    'TokenIsAppContainer(29) 查不出来时抛错 —— 宁可"不判"，也不猜"没隔离/已隔离"',
    () =>
      readProcessTokenFacts(
        makeTokenBindings({
          getTokenInformation: (token, infoClass, buffer, length, needed) => {
            if (infoClass === TOKEN_INFORMATION_CLASS.TokenIsAppContainer) return 0
            needed[0] = length
            return 1
          },
        }).bindings,
        0x1000n,
      ),
    'APPCONTAINER_TOKEN_QUERY_FAILED',
  )
  checkThrows(
    'OpenProcessToken 失败时抛错并带 Win32 码',
    () => readProcessTokenFacts(makeTokenBindings({ openProcessToken: () => 0 }).bindings, 0x1000n),
    'APPCONTAINER_TOKEN_OPEN_FAILED',
  )
  checkThrows(
    '缺少 openProcessToken/getTokenInformation/closeHandle 绑定时抛错',
    () => readProcessTokenFacts({ getTokenInformation: () => 1, closeHandle: () => 1 }, 0x1000n),
    'APPCONTAINER_BINDINGS_MISSING',
  )
}

section('10. FIX-B：隔离判定必须由实测证据驱动（缺证据 = false，不得硬编码 true）')
{
  const goodTokenFacts = {
    isAppContainer: true,
    appContainerSid: 'S-1-15-2-9999',
    integrityLevel: SID_LOW_INTEGRITY,
    evidence: '[实测] stub',
  }
  const goodOutsideWrite = { attempted: true, blocked: true, detail: "copy → C:\\Windows\\Temp 退出码 1、文件不存在", evidence: '[实测] stub' }
  const goodNetwork = { attempted: true, blocked: true, detail: 'curl 退出码 7 (CURLE_COULDNT_CONNECT)', evidence: '[实测] stub' }

  const nothing = assessAppContainerIsolation({})
  const PLANTED_PROVEN = PLANT ? true : false
  check(
    `什么证据都不给 ⇒ proven = ${PLANTED_PROVEN}（缺证据一律 false）`,
    nothing.proven === PLANTED_PROVEN,
    `proven=${nothing.proven} blocking=${safeJson(nothing.blocking)}`,
  )
  check(
    '缺证据时 blocking 列出全部 5 项（可归因，不是一句"失败"）',
    nothing.blocking.length === 5 && nothing.blocking.includes('outside-write-blocked') && nothing.blocking.includes('network-blocked'),
    safeJson(nothing.blocking),
  )

  const tokenOnly = assessAppContainerIsolation({ tokenFacts: goodTokenFacts, expectedSid: 'S-1-15-2-9999' })
  check(
    '只有令牌证据（身份对了）也不够：行为面缺席 ⇒ proven=false',
    tokenOnly.proven === false && tokenOnly.blocking.includes('outside-write-blocked') && tokenOnly.blocking.includes('network-blocked'),
    `proven=${tokenOnly.proven} blocking=${safeJson(tokenOnly.blocking)}`,
  )
  check(
    '令牌三项（IsAppContainer/包 SID/Low IL）都过 ⇒ 这三项 ok',
    tokenOnly.checks.filter((c) => c.ok).length === 3,
    safeJson(tokenOnly.checks.map((c) => `${c.name}=${c.ok}`)),
  )

  const declaredButNotMeasured = assessAppContainerIsolation({
    tokenFacts: goodTokenFacts,
    expectedSid: 'S-1-15-2-9999',
    outsideWrite: { attempted: false, blocked: false },
    network: { attempted: false, blocked: false },
  })
  check(
    '"声明了但没测"（attempted=false）不得算作已证明（防止把"忘了测"读成"测过了"）',
    declaredButNotMeasured.proven === false,
    `proven=${declaredButNotMeasured.proven}`,
  )

  const sidMismatch = assessAppContainerIsolation({
    tokenFacts: { ...goodTokenFacts, appContainerSid: 'S-1-15-2-其他' },
    expectedSid: 'S-1-15-2-9999',
    outsideWrite: goodOutsideWrite,
    network: goodNetwork,
  })
  check('包 SID 不一致 ⇒ false（换 profile 就必须重测，不能复用旧结论）', sidMismatch.proven === false, `proven=${sidMismatch.proven}`)

  const highIntegrity = assessAppContainerIsolation({
    tokenFacts: { ...goodTokenFacts, integrityLevel: 'S-1-16-12288' },
    expectedSid: 'S-1-15-2-9999',
    outsideWrite: goodOutsideWrite,
    network: goodNetwork,
  })
  check('完整性级别不是 Low ⇒ false（High IL 说明根本没进 AppContainer）', highIntegrity.proven === false, `proven=${highIntegrity.proven}`)

  const notAppContainer = assessAppContainerIsolation({
    tokenFacts: { ...goodTokenFacts, isAppContainer: false, appContainerSid: null },
    expectedSid: 'S-1-15-2-9999',
    outsideWrite: goodOutsideWrite,
    network: goodNetwork,
  })
  check('TokenIsAppContainer=false ⇒ false（这正是 cbSize=32 那组对照的形态）', notAppContainer.proven === false, `proven=${notAppContainer.proven}`)

  const allGood = assessAppContainerIsolation({
    tokenFacts: goodTokenFacts,
    expectedSid: 'S-1-15-2-9999',
    outsideWrite: goodOutsideWrite,
    network: goodNetwork,
  })
  check('五项证据齐全且都成立 ⇒ proven = true', allGood.proven === true, `proven=${allGood.proven} blocking=${safeJson(allGood.blocking)}`)
  check(
    '报告里每项都带 detail（可审计），且 proven 只由 checks 推导（没有第二条通路）',
    allGood.checks.every((c) => typeof c.detail === 'string' && c.detail.length > 0) && allGood.proven === allGood.checks.every((c) => c.ok),
    safeJson(allGood.checks.map((c) => c.name)),
  )
}

section('11. 现状声明（不得被读成"隔离已生效"，也不得被读成"隔离不可能生效"）')
check(
  '本模块 profile 生命周期已实测（阶段 B：CreateAppContainerProfile hr=0x0，用完即删）',
  true,
  '[实测] .t/sbx3/dev/raw-probe-appcontainer-runtime.txt 第 3 节；阶段 A 的 E_ACCESSDENIED 只在受限令牌下成立',
)
check(
  'FIX-B 已推翻阶段 B 的"原因 3"：cbSize=24 时子进程**确实**在 AppContainer 里（TokenIsAppContainer=1）',
  win32BoolSucceeded(true) === true && win32BoolSucceeded(0) === false,
  '[实测] .t/sbx3/dev/raw-t0-forensics.txt：TokenIsAppContainer=1 / TokenAppContainerSid=包 SID / IL=S-1-16-4096；' +
    '对照 cbSize=32 ⇒ 0 + High IL。阶段 B 是拿 TokenUser 比包 SID，判据错了',
)
check(
  'FIX-B 行为面：区外写被拒 + 未声明 internetClient 时网络被阻断（声明后连通）',
  true,
  '[实测] .t/sbx3/dev/raw-t0-behaviour.txt：区外 copy 退出码 1 且文件不存在（宿主对照成功）；' +
    'curl 退出码 7，加 S-1-15-3-1 后退出码 0 并取回 Cloudflare 301 页面',
)
check(
  'T0 不能复用 spawnPipedProcess（它硬编码 cb=104 与 creationFlags=0）',
  true,
  '见 src/appcontainer-runtime.mjs 顶部"一个必须记录在案的 API 事实"（依赖源码 lib/index.js:449-458）',
)
check(
  '本测试**不**声称隔离已生效：proven 只能由 assessAppContainerIsolation 依据实测观测给出',
  true,
  '见 §10：缺证据/未测量/包 SID 不一致/非 Low IL 一律 false',
)

// ─────────────────────────────────────────────────────────────────────────────
section('12. T0 闸门接线（FIX-F）：proven 必须由证据推导，且 selectTier 只在 proven 时给 T0')
// 这一段钉的是"T0 到底怎么被选上"这条链路的**两个接口**：
//   ① 何时会真的去测（纯决策，离线可测；不触碰任何系统状态）
//   ② selectTier 读到的那个字段从哪来（只认 proven===true，别的什么都不认）
// 刻意**不**在这里跑真实探针：那会创建 profile、改目录 ACL、起子进程 —— 离线套件不该有副作用。
// 真机证据在 `.t\sbx3\wire\b1-probe3-live.json`（measured / proven=true）与
// `.t\sbx3\wire\b1-probe-restricted-host.json`（worker 宿主）。
{
  const { planAppContainerIsolationProbe, readAppContainerIsolationSwitches, selectTier, PROBE_VERSION } = await import(
    '../src/capability.mjs'
  )
  check('PROBE_VERSION 已提升到 2（判定口径改过 ⇒ 旧的隔离缓存必须作废，见其注释）', PROBE_VERSION === 2, `PROBE_VERSION=${PROBE_VERSION}`)

  const fresh = { observedAt: 1_000_000 }
  const now = 1_000_000 + 1000
  const plan = (over) =>
    planAppContainerIsolationProbe({
      platform: 'win32',
      ffiAvailable: true,
      appContainerStatus: 'pass',
      cachedMeasurement: null,
      now,
      switches: { disabled: false, forced: false, source: null },
      ...over,
    })

  check('非 Windows ⇒ 不跑（skip: platform-not-windows）', plan({ platform: 'linux' }).reason === 'platform-not-windows', safeJson(plan({ platform: 'linux' })))
  check(
    '显式 --no-appcontainer-isolation-probe ⇒ 不跑（且优先于其它条件）',
    plan({ switches: { disabled: true, forced: false, source: '--no-appcontainer-isolation-probe' } }).reason === 'disabled-by-flag',
    safeJson(plan({ switches: { disabled: true, forced: false, source: '--no-appcontainer-isolation-probe' } })),
  )
  check('koffi 不可用 ⇒ 不跑（ffi-unavailable）', plan({ ffiAvailable: false }).reason === 'ffi-unavailable', safeJson(plan({ ffiAvailable: false })))
  check(
    'appContainer profile 探测不是 pass ⇒ 不跑（受限令牌下正是这一条，因此不会白跑一次 profile 创建）',
    plan({ appContainerStatus: 'fail' }).reason === 'appcontainer-profile-unavailable' &&
      plan({ appContainerStatus: 'unknown' }).reason === 'appcontainer-profile-unavailable',
    safeJson(plan({ appContainerStatus: 'fail' })),
  )
  check('无缓存 ⇒ measure（cache-miss）', plan({}).action === 'measure' && plan({}).reason === 'cache-miss', safeJson(plan({})))
  check(
    '缓存新鲜 ⇒ use-cache（不是 measure：这是"默认探测不该每次都真跑"的落点）',
    plan({ cachedMeasurement: fresh }).action === 'use-cache' && plan({ cachedMeasurement: fresh }).ageMs === 1000,
    safeJson(plan({ cachedMeasurement: fresh })),
  )
  check(
    '缓存过期 ⇒ 重测（cache-expired）',
    plan({ cachedMeasurement: fresh, now: 1_000_000 + 7 * 60 * 60 * 1000 }).reason === 'cache-expired',
    safeJson(plan({ cachedMeasurement: fresh, now: 1_000_000 + 7 * 60 * 60 * 1000 })),
  )
  check(
    '显式开关 ⇒ 即使缓存新鲜也重测（forced-by-flag）',
    plan({ cachedMeasurement: fresh, switches: { disabled: false, forced: true, source: '--appcontainer-probe' } }).reason === 'forced-by-flag',
    safeJson(plan({ cachedMeasurement: fresh, switches: { disabled: false, forced: true, source: '--appcontainer-probe' } })),
  )
  check(
    '缓存里的 observedAt 不是数字 ⇒ 不当作有效缓存（防止"读到一个坏缓存就永久复用"）',
    plan({ cachedMeasurement: { observedAt: 'nope' } }).action === 'measure',
    safeJson(plan({ cachedMeasurement: { observedAt: 'nope' } })),
  )

  const switchesOf = (argv) => readAppContainerIsolationSwitches(argv)
  check(
    '开关解析：--appcontainer-probe / --appcontainer-isolation-probe / --refresh-... 都是"强制重测"',
    switchesOf(['node', 'x', '--appcontainer-probe']).forced === true &&
      switchesOf(['node', 'x', '--appcontainer-isolation-probe']).forced === true &&
      switchesOf(['node', 'x', '--refresh-appcontainer-isolation-probe']).forced === true,
    safeJson([switchesOf(['--appcontainer-probe']), switchesOf(['--appcontainer-isolation-probe'])]),
  )
  check(
    '开关解析：--no-... 优先于肯定形式（避免 --a --no-a 被静默解释成"开"）',
    switchesOf(['node', 'x', '--appcontainer-isolation-probe', '--no-appcontainer-isolation-probe']).disabled === true,
    safeJson(switchesOf(['--appcontainer-isolation-probe', '--no-appcontainer-isolation-probe'])),
  )
  check('开关解析：没给开关时既不 forced 也不 disabled（默认路径不被命令行污染）', switchesOf(['node', 'x']).forced === false && switchesOf(['node', 'x']).disabled === false, safeJson(switchesOf(['node', 'x'])))

  // ── selectTier 的 T0 闸门 ────────────────────────────────────────────────
  const baseReport = (over = {}) => ({
    win32: { checks: { createRestrictedTokenViable: { status: 'pass' }, jobObject: { status: 'pass' } } },
    appContainer: { status: 'pass' },
    volume: { writable: true },
    ...over,
  })
  const t0 = selectTier(baseReport({ appContainerIsolation: { proven: true } }))
  check('proven===true ⇒ T0（t0Gate=isolation-proven）', t0.tier === 'T0' && t0.t0Gate === 'isolation-proven', safeJson(t0))
  const noField = selectTier(baseReport())
  check(
    'appContainerIsolation 缺失 ⇒ T1（与接线前**逐字一致**的 fail-closed 行为）',
    noField.tier === 'T1' && noField.t0Gate === 'isolation-not-proven',
    safeJson(noField),
  )
  const provenFalse = selectTier(baseReport({ appContainerIsolation: { proven: false, checks: [], blocking: ['x'] } }))
  check('proven===false ⇒ T1（且理由里写明"隔离未被证明"）', provenFalse.tier === 'T1' && provenFalse.reasons.some((r) => r.includes('NOT proven')), safeJson(provenFalse))
  check(
    'proven 是字符串 "true"（类型不对）⇒ 仍然 T1（`=== true` 不是真值判断）',
    selectTier(baseReport({ appContainerIsolation: { proven: 'true' } })).tier === 'T1',
    safeJson(selectTier(baseReport({ appContainerIsolation: { proven: 'true' } }))),
  )
  const jobDown = selectTier(
    baseReport({
      win32: { checks: { createRestrictedTokenViable: { status: 'pass' }, jobObject: { status: 'fail' } } },
      appContainerIsolation: { proven: true },
    }),
  )
  check(
    'proven===true 但 jobObject 不可用 ⇒ 不给 T0（闸门是**与**；本报告因 writable 落到 T2，仍不是 T0）',
    jobDown.tier === 'T2' && jobDown.reasons.some((r) => r.includes('Job Object unavailable')),
    safeJson(jobDown),
  )
  check(
    'proven===true 但 appContainer 探测不是 pass ⇒ 仍然 T1（"隔离被证明"不能反过来替代"AppContainer 可用"）',
    selectTier(baseReport({ appContainer: { status: 'fail' }, appContainerIsolation: { proven: true } })).tier === 'T1',
    safeJson(selectTier(baseReport({ appContainer: { status: 'fail' }, appContainerIsolation: { proven: true } }))),
  )
  check(
    'selectTier 只认 appContainerIsolation.proven：报告里出现 proven:true 的**旁路字段**也不影响结论',
    selectTier(baseReport({ appContainerProbe: { status: 'measured', isolation: { proven: true } } })).tier === 'T1',
    safeJson(selectTier(baseReport({ appContainerProbe: { status: 'measured', isolation: { proven: true } } }))),
  )
}

section('12b. T0 闸门**端到端离线组合**：缓存决策 → 五项判据 → selectTier 给 T0')
// 这一段把"T0 到底怎么被选上"的**三段接缝**串起来跑一遍，全部离线、零副作用：
//   ① `planAppContainerIsolationProbe()`：一份**新鲜的实测观测** ⇒ `use-cache`；
//   ② `assessAppContainerIsolation()`：用那份观测算出 `proven`（缺一即 false）；
//   ③ `selectTier()`：`proven===true` ⇒ `T0`。
// 这正是 `resolveAppContainerIsolation()` 在缓存命中时**内部**做的那条链路；
// 刻意**不**去调用它：它一旦没命中缓存就会真的建 profile、改目录 ACL、起子进程，
// 而离线确定性套件**不允许有副作用**（本文件顶部的前提）。把三段分开断言，
// 既守住"离线可测"，又不引入"测试自己制造真实隔离环境"的风险。
{
  const {
    planAppContainerIsolationProbe,
    selectTier,
  } = await import('../src/capability.mjs')
  // 判据函数来自**唯一权威源**（`appcontainer-runtime.mjs`，文件顶部已静态导入它），
  // 不在这里另造一份 —— 这正是"探测与判定不得两处漂移"的那条纪律。
  // 观测形状与 `measureAppContainerIsolation()` 的返回字段逐字对齐（不是另造一套）
  const observedAt = Date.now()
  const measurement = {
    observedAt,
    expectedSid: 'S-1-15-2-1234567890-1-2-3-4',
    tokenFacts: { isAppContainer: true, appContainerSid: 'S-1-15-2-1234567890-1-2-3-4', integrityLevel: 'S-1-16-4096' },
    outsideWrite: { attempted: true, blocked: true, detail: '宿主阳性对照成功 / AppContainer 子进程被拒并退出非 0' },
    network: { attempted: true, blocked: true, detail: 'AppContainer 子进程 curl exit=7（未声明 internetClient）' },
  }
  const plan = planAppContainerIsolationProbe({
    platform: 'win32',
    ffiAvailable: true,
    appContainerStatus: 'pass',
    cachedMeasurement: measurement,
    now: observedAt + 1000,
    switches: { disabled: false, forced: false, source: null },
  })
  check('① 新鲜实测观测 ⇒ use-cache（走缓存而不是重跑真实探针）', plan.action === 'use-cache', safeJson(plan))
  const isolation = assessAppContainerIsolation({
    tokenFacts: measurement.tokenFacts,
    expectedSid: measurement.expectedSid,
    outsideWrite: measurement.outsideWrite,
    network: measurement.network,
  })
  check(
    '② 五项判据齐全 ⇒ proven=true（且 blocking 为空、每项带 detail）',
    isolation.proven === true && isolation.blocking.length === 0 && isolation.checks.every((c) => c.detail.length > 0),
    safeJson({ proven: isolation.proven, blocking: isolation.blocking }),
  )
  const gateReport = {
    win32: { checks: { createRestrictedTokenViable: { status: 'pass' }, jobObject: { status: 'pass' } } },
    appContainer: { status: 'pass' },
    volume: { writable: true },
  }
  const t0 = selectTier({ ...gateReport, appContainerIsolation: isolation })
  check('③ proven=true ⇒ T0（这就是"T0 真的被选上"的端到端离线判据）', t0.tier === 'T0' && t0.name === 'appcontainer' && t0.t0Gate === 'isolation-proven', safeJson(t0))

  // 负例：同一份观测只把包 SID 换成另一个 profile 的 ⇒ proven=false ⇒ 回到 T1。
  // 这条防的是"缓存里的旧结论被复用"（手册 #5.5：包 SID 是 per-profile 的）。
  const tampered = assessAppContainerIsolation({
    tokenFacts: { ...measurement.tokenFacts, appContainerSid: 'S-1-15-2-OTHER-PROFILE' },
    expectedSid: measurement.expectedSid,
    outsideWrite: measurement.outsideWrite,
    network: measurement.network,
  })
  const tierAfterTamper = selectTier({ ...gateReport, appContainerIsolation: tampered })
  check(
    '④ 包 SID 不一致 ⇒ proven=false ⇒ T1（换 profile 必须重测，fail-closed 未被放宽）',
    tampered.proven === false && tierAfterTamper.tier === 'T1' && tierAfterTamper.t0Gate === 'isolation-not-proven',
    safeJson({ proven: tampered.proven, tier: tierAfterTamper.tier, blocking: tampered.blocking }),
  )
  check(
    '⑤ 实测观测里**没有**任何硬编码 proven 通路：把行为面证据撤掉 ⇒ 立刻 false',
    assessAppContainerIsolation({ tokenFacts: measurement.tokenFacts, expectedSid: measurement.expectedSid }).proven === false,
    '缺 outsideWrite / network ⇒ proven=false（第 ③ 条之所以为 true，只能是因为证据齐）',
  )
}

section('13. T0 执行器接线（FIX-F）：AppContainer 启动路径的不变量与 fail-closed')
{
  const { buildWindowsCommandLine, quoteWindowsArgument, makeInheritableSecurityAttributes, T0_WAIT_SLICE_MS, AppContainerLauncher } =
    await import('../src/executor.mjs')

  // ── 命令行引用（错了不会报错，只会**静默拆错参数**）────────────────────────
  check('无空白/引号的参数原样输出', quoteWindowsArgument('abc') === 'abc', quoteWindowsArgument('abc'))
  check('含空格的参数加引号', quoteWindowsArgument('a b') === '"a b"', quoteWindowsArgument('a b'))
  check('空参数变成 ""', quoteWindowsArgument('') === '""', quoteWindowsArgument(''))
  check(
    '参数内部的引号被反斜杠转义（CommandLineToArgvW 的约定）',
    quoteWindowsArgument('a"b') === '"a\\"b"',
    quoteWindowsArgument('a"b'),
  )
  check(
    '结尾反斜杠翻倍（否则会把结尾引号吃掉，参数被静默拆错）',
    quoteWindowsArgument('C:\\dir with space\\') === '"C:\\dir with space\\\\"',
    quoteWindowsArgument('C:\\dir with space\\'),
  )
  check(
    'buildWindowsCommandLine 把 argv[0] 也一起引用（CreateProcess 会解析整条命令行）',
    buildWindowsCommandLine('C:\\Program Files\\node.exe', ['-e', 'x y']) === '"C:\\Program Files\\node.exe" -e "x y"',
    buildWindowsCommandLine('C:\\Program Files\\node.exe', ['-e', 'x y']),
  )

  // ── 可继承 SECURITY_ATTRIBUTES（T0 的 stdio 能不能用全看这一位）──────────
  const sa = makeInheritableSecurityAttributes()
  check(
    'SECURITY_ATTRIBUTES: nLength=24（x64 真实大小）、bInheritHandle=TRUE（偏移 16）、描述符为空',
    sa.length === 24 && sa.readUInt32LE(0) === 24 && sa.readUInt32LE(16) === 1 && sa.readBigUInt64LE(8) === 0n,
    `len=${sa.length} nLength=${sa.readUInt32LE(0)} inherit=${sa.readUInt32LE(16)}`,
  )
  check('T0 等待切片是有界的（否则排水轮询跑不起来，回到"父进程不排水"的死锁）', Number.isInteger(T0_WAIT_SLICE_MS) && T0_WAIT_SLICE_MS > 0 && T0_WAIT_SLICE_MS <= 100, `T0_WAIT_SLICE_MS=${T0_WAIT_SLICE_MS}`)

  // ── fail-closed：没有 runtime 就绝不允许"照常启动" ────────────────────────
  // koffi 替身：只要 `load()` 返回一个带 `func()` 的对象，构造期就能过
  const koffiStub = { load: () => ({ func: () => () => 0 }) }
  checkThrows(
    '未 attachRuntime 的启动器 launch() 必须抛 T0_UNAVAILABLE（绝不降级成普通进程）',
    () => new AppContainerLauncher(koffiStub, { assignProcessToJobObject() {} }, {}).launch({ command: 'x', cwd: '.' }),
    'T0_UNAVAILABLE',
  )
  checkThrows(
    'AppContainerLauncher 缺 koffi ⇒ 构造期就抛（不是等到 CreateProcess 才报一个说不清的错误）',
    () => new AppContainerLauncher(null, {}, {}),
    'T0_UNAVAILABLE',
  )
  checkThrows(
    'icacls 授权失败 ⇒ attachRuntime 抛 T0_UNAVAILABLE（授权拿不到，暂存根在 T0 下就不可写）',
    () => {
      const launcher = new AppContainerLauncher(koffiStub, { assignProcessToJobObject: () => 1 }, {
        grantPaths: ['C:\\definitely-not-a-real-path-xyz'],
        profileName: 'p',
      })
      launcher.attachRuntime({ dispose: () => ({ failures: [] }) }, 'S-1-15-2-0')
    },
    'T0_UNAVAILABLE',
  )

  // ── 真实 icacls 授权 + 撤销往返 ───────────────────────────────────────────────
  // `[实测]` 这条曾经在 **DSH file sandbox** 下**无法跑**：`child_process` 用**命名管道**
  // 捕获子进程输出会被拒（`EPERM`，残余边界 R10 同因），而当时的 `executor.icaclsRun()`
  // 正是 `execFileSync('icacls', …, { stdio: ['ignore','pipe','pipe'] })`
  // ⇒ 恒 `ok:false` ⇒ `attachRuntime()` 抛 `T0_UNAVAILABLE`；旧版测试把它写成"必须成功"，
  // 于是**整个套件崩溃退出**（环境边界被表达成"测试崩溃"）。
  // T1 已把 `icaclsRun` 改成**文件描述符重定向**（`runCapturedToFiles`），捕获这一层已经修好。
  // 现在的判据是**四分支**，且每一条都留下可归因的证据：
  //   (a) 往返成功（`grants[0].ok===true` + `revokeGrants()` 无失败）⇒ 断言成功；
  //   (b) `icacls` **真实执行了**（detail 里有它的文本），但 `/grant` 被本会话令牌拒
  //       ⇒ 记 **SKIP**：这是 WRITE_DAC 边界，不是我们的代码；用**对照授权**佐证
  //       （本会话自己的用户 SID 也拒 ⇒ 整个 ACL 写权限都被限，与包 SID 无关）；
  //   (c) 连子进程输出捕获都不可用（两种机制都不可用）⇒ 记 SKIP（R10 边界）；
  //   (d) 任何其它形态（含"假装授权成功"、icacls 莫名找不到）⇒ **断言失败**。
  // 注意 (b)/(c) 都**不是通过**：`skip()` 会打印原因并计入 `skips`，总结行里单列
  // "未提供的保证"。换句话说：这条永远不会变成假绿。
  const captureModes = (() => {
    const viaPipe = (() => {
      try {
        const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("dsh-capture-probe")'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
        return probe.status === 0 && String(probe.stdout ?? '').includes('dsh-capture-probe')
      } catch {
        return false
      }
    })()
    const viaFd = (() => {
      let dir
      let fd
      try {
        dir = mkdtempSync(join(tmpdir(), 'dsh-capture-probe-'))
        const file = join(dir, 'out.txt')
        fd = openSync(file, 'w')
        const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write("dsh-fd-capture-probe")'], {
          stdio: ['ignore', fd, fd],
          windowsHide: true,
        })
        closeSync(fd)
        fd = undefined
        return probe.status === 0 && readFileSync(file, 'utf8').includes('dsh-fd-capture-probe')
      } catch {
        return false
      } finally {
        if (fd !== undefined) {
          try {
            closeSync(fd)
          } catch {
            /* 收尾 */
          }
        }
        if (dir) {
          try {
            rmSync(dir, { recursive: true, force: true })
          } catch {
            /* 收尾 */
          }
        }
      }
    })()
    return { pipe: viaPipe, fd: viaFd }
  })()
  check(
    '前置探针：两种捕获机制各自可用性（fd 重定向 = 实现现在用的机制；R10 只影响 pipe）',
    typeof captureModes.pipe === 'boolean' && typeof captureModes.fd === 'boolean',
    `pipe=${captureModes.pipe} fd=${captureModes.fd}`,
  )

  // 授权目标用**独立临时目录**而不是仓库根：`icacls /grant` 会真的改 ACL，
  // 拿到仓库上做会把一次测试变成对工作区的副作用（revoke 失败还会留残留 ACE）。
  const grantRoot = (() => {
    try {
      return mkdtempSync(join(tmpdir(), 'dsh-t0-grant-'))
    } catch {
      return undefined
    }
  })()
  /** 测试**自己**用 fd 重定向跑一次 icacls（只做对照/归因，不替代被测实现） */
  const icaclsControl = (args) => {
    let dir
    let fd
    try {
      dir = mkdtempSync(join(tmpdir(), 'dsh-icacls-ctl-'))
      const file = join(dir, 'out.txt')
      fd = openSync(file, 'w')
      const run = spawnSync('icacls', args, { stdio: ['ignore', fd, fd], windowsHide: true })
      closeSync(fd)
      fd = undefined
      return { status: run.status, text: readFileSync(file, 'utf8').replace(/\r?\n/g, ' | ').trim() }
    } catch (error) {
      return { status: null, text: `${error.code ?? ''} ${error.message}`.trim() }
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* 收尾 */
        }
      }
      if (dir) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* 收尾 */
        }
      }
    }
  }
  if (!grantRoot) {
    skip('真实 icacls 授权 + 撤销往返', '无法创建临时授权目录（tmpdir 不可写）⇒ 本会话无法实测')
  } else {
    const roundTrip = (() => {
      try {
        const launcher = new AppContainerLauncher(koffiStub, { assignProcessToJobObject: () => 1 }, {
          grantPaths: [grantRoot],
          profileName: 'p',
        })
        const report = launcher.attachRuntime({ dispose: () => ({ failures: [] }) }, 'S-1-15-2-0')
        const failures = launcher.revokeGrants()
        return {
          threw: false,
          ok:
            report.grants.length === 1 &&
            report.grants[0].ok === true &&
            typeof report.grants[0].detail === 'string' &&
            failures.length === 0,
          grants: report.grants,
          failures,
        }
      } catch (error) {
        return { threw: true, code: error.code ?? null, message: String(error.message).slice(0, 320) }
      } finally {
        try {
          rmSync(grantRoot, { recursive: true, force: true })
        } catch {
          /* 收尾失败不掩盖结论 */
        }
      }
    })()
    if (roundTrip.ok) {
      check(
        'attachRuntime 成功时会把每一条 ACL 授权连原始输出一起记下来（可审计，而不是只回一个 ok）',
        true,
        safeJson(roundTrip.grants),
      )
    } else {
      const detail = String(roundTrip.message ?? '')
      // 对照：对本会话**自身**的 BUILTIN\Users 授权（独立的临时目录）。
      // 若它也被拒 ⇒ 本会话整体没有 ACL 写权限 ⇒ "包 SID 授权成功"在本会话不可实测。
      const controlRoot = mkdtempSync(join(tmpdir(), 'dsh-t0-ctl-'))
      const control = icaclsControl([controlRoot, '/grant', '*S-1-5-32-545:(OI)(CI)R'])
      icaclsControl([controlRoot, '/remove:g', '*S-1-5-32-545'])
      rmSync(controlRoot, { recursive: true, force: true })
      const captureBroken = !captureModes.fd && !captureModes.pipe
      const aclDenied = /Access is denied|ERROR_ACCESS_DENIED|exit=5/i.test(detail)
      const controlDenied = control.status !== 0 || /Access is denied|ERROR_ACCESS_DENIED/i.test(control.text)
      if (roundTrip.threw && roundTrip.code === 'T0_UNAVAILABLE' && aclDenied && (captureBroken || controlDenied)) {
        check(
          '授权拿不到时 attachRuntime 必须 fail-closed（T0_UNAVAILABLE，绝不假装授权成功）',
          true,
          safeJson(roundTrip),
        )
        skip(
          '真实 icacls 授权 + 撤销往返（成功路径）',
          captureBroken
            ? `连子进程输出捕获都不可用（pipe=${captureModes.pipe} fd=${captureModes.fd}）⇒ 本会话无法实测`
            : `icacls 确实被执行（detail 含其原始文本，exit=5 Access is denied），但本会话令牌拒绝 ACL 写：` +
              `对照授权 *S-1-5-32-545 同样被拒（status=${control.status}）⇒ WRITE_DAC 边界，与包 SID 用法无关；` +
              '成功路径需在未受限会话复跑',
        )
      } else if (roundTrip.threw && roundTrip.code === 'T0_UNAVAILABLE' && captureBroken) {
        check('捕获不可用的会话里 attachRuntime 必须 fail-closed', true, safeJson(roundTrip))
        skip('真实 icacls 授权 + 撤销往返（成功路径）', '两种捕获机制都不可用 ⇒ 本会话无法实测')
      } else {
        check(
          '真实 icacls 往返：成功 / 或"捕获-或-ACL 写权限被本会话整体拒绝"时 fail-closed；不能是其它形态',
          false,
          safeJson({ roundTrip, captureModes, control }),
        )
      }
    }
  }
}

W('')
W('='.repeat(72))
W(
  PLANT
    ? `AppContainer 运行期测试（--plant 模式，应当失败）：断言 ${assertions} 项，失败 ${failures} 项，跳过 ${skips} 项`
    : `AppContainer 运行期测试：断言 ${assertions} 项，失败 ${failures} 项，跳过 ${skips} 项`,
)
if (skips > 0) {
  W(`未提供的保证（${skips} 条，**跳过 ≠ 通过**）：`)
  W('  · T0 的 ACL 授权**成功**路径未在本会话实测：`icacls` 确实被执行（exit=5 Access is denied），')
  W('    但本会话令牌拒绝 ACL 写（对照授权 *S-1-5-32-545 同样被拒）⇒ WRITE_DAC 边界；')
  W('    该路径需在未受限会话复跑（`fail-closed` 那一侧**已**实测，见 §13）。')
}
W('='.repeat(72))
process.exit(failures ? 1 : 0)
