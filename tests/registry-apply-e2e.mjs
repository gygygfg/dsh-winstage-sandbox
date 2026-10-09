/**
 * registry-apply-e2e —— `apply()` 的**真实 hive 副作用**端到端证据（T3 责任）
 *
 * ⚠⚠ 本套件会**临时写真实 HKCU**（`HKCU\Software\WinstageShimProbe`），用完即净；
 *     它**刻意不接进 `verify.cmd` / `registry-guard`**：离线套件不许碰真实注册表。
 *     请在**未受限会话**里单独运行：
 *
 *         node tests\registry-apply-e2e.mjs
 *
 * 退出码：
 *   0 = 在**真实 hive** 上全部断言通过（这才是"闭环落点"的证据）
 *   1 = 有断言失败（或清理失败 —— 清理失败也是失败，不许静默留残留）
 *   2 = **未验证**：会话受限（写注册表被拒）/ 没有可用后端 / 键已被别人占用
 *       —— 打印大写的 NOT VERIFIED；**这不是通过**
 *
 * 覆盖（逐条对应 Lead 的验收）：
 *   P1  正例：真实 WAL 字节 → open → diff → freezeCandidate → **apply** →
 *      真实 hive 出现该键、`T4Probe` 的值与 WAL 里的 `REG_SZ` **逐字节相等**；
 *      随后**按 `planRollback` 的计划手工执行回滚**，断言真实 hive 回到原状（键消失）。
 *   P2  选择性 apply 的依赖语义（契约 v1.3）：**只**批准值单元、不批准父键的 mkdir ⇒
 *      `blocked`（status=2）+ 真实 hive **零写入**（绝不静默补建未批准的键）。
 *   P3  变异体自证（**纯判定，不需要写权限**）：把"apply 后逐字节相等"的检查器
 *      喂给 no-op 结果与编码写错的结果，必须判红。
 *   P4  清理：`finally` 里删键并**验证删除成功**（失败即 exit 1）。
 *
 * 后端选择（诚实声明）：
 *   · 读取器（baseline）恒用 `reg.exe`（独立于写入器；本机 `reg query` 可用）。
 *   · 写入器优先 koffi 绑定（生产路径 `createRegistryWriter`），koffi 不可用时退化为
 *     `reg.exe` 后端 —— 两者都由**同一个 `stage.apply()`** 驱动，
 *     因此"真实副作用"这一段结论不依赖 FFI 是否存在。
 *     `reg.exe` 后端的已知限制：`REG_MULTI_SZ` / `REG_NONE` 无法通过命令行参数表达
 *     （带内嵌 NUL），遇到时抛 `REG_E2E_BACKEND_UNSUPPORTED` 并提示用 koffi 后端。
 */

import { closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  createRegistryStage,
  createRegistryWriter,
  decodeJournalRecords,
  journalRecordForOperation,
  encodeJournalRecord,
  REG_STAGE_KIND,
} from '../src/registry-stage.mjs'
import { decodeRegistryValue, encodeRegistryValue, normalizeSnapshot, parseRegistryPath, REG_STATUS } from '../src/registry-guard.mjs'
import { findStageRoot } from './registry-conformance.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 被测对象：T4 的闭环节 runner 用的那个键（与 `tools/run-shim-closedloop.mjs` 一致） */
const PROBE_KEY = 'HKCU\\Software\\WinstageShimProbe'
const PROBE_VALUE = 'T4Probe'
/** 这些名字只用于"清理"与"预检"，绝不写进任何产物 */
const PRECHECK_KEY = 'HKCU\\Software\\WinStageT3ApplyPrecheck'
const PRECHECK_VALUE = 'T3Precheck'
const E2E_VALUE_PREFIX = 't4-probe-'

const W = (text) => process.stdout.write(`${text}\n`)

// ─────────────────────────── 判定器（纯函数；变异体自证也用它）───────────────────────────

/**
 * "apply 在真实 hive 上是否成立"的**唯一**判定器。
 * 正例与变异体走同一个函数，因此"变异体判红"直接证明这些断言有判定力。
 *
 * @returns {{ok: boolean, failures: string[]}}
 */
export function checkApplyOutcome({ beforeExists, afterExists, expectedHex, afterHex, appliedCount, failedCount, blockedCount, candidateUnits }) {
  const failures = []
  if (beforeExists !== false) failures.push(`apply 前真实 hive 里该键必须不存在（实测 ${String(beforeExists)}）：用例不许覆盖既有数据`)
  if (afterExists !== true) failures.push(`apply 后真实 hive 里该键必须存在（实测 ${String(afterExists)}）`)
  if (expectedHex === undefined) failures.push('WAL 里没有可用的期望字节（expectedHex 未定义）')
  else if (afterHex !== expectedHex) failures.push(`apply 后值必须与 WAL 里的字节逐字节相等（期望 ${expectedHex}，实测 ${String(afterHex)}）`)
  if (appliedCount < 1) failures.push(`applied 数必须 ≥1（实测 ${appliedCount}）`)
  if (failedCount !== 0) failures.push(`failed 必须为 0（实测 ${failedCount}）`)
  if (blockedCount !== 0) failures.push(`blocked 必须为 0（实测 ${blockedCount}）`)
  if (typeof candidateUnits === 'number' && appliedCount !== candidateUnits) {
    failures.push(`候选的每个单元都必须被应用（候选 ${candidateUnits}，已应用 ${appliedCount}）`)
  }
  return { ok: failures.length === 0, failures }
}

// ─────────────────────────── reg.exe 后端（独立于 FFI）───────────────────────────

/**
 * 一次 `reg.exe` 调用。
 *
 * ⚠ **必须把 stdout/stderr 重定向到文件**，不能用管道：受限会话里 `spawnSync` 默认的
 * `stdio: 'pipe'` 走**命名管道**，客户端打开请求需要受限 SID 未被授予的权限 ⇒ EPERM
 * （这是本仓库反复踩到的 R10/#15，`src/testrunner.mjs` 也是为此改成 fd 重定向的）。
 */
function runReg(args, tag) {
  const outFile = join(tmpdir(), `t3-apply-e2e-${process.pid}-${tag}.out.txt`)
  const errFile = join(tmpdir(), `t3-apply-e2e-${process.pid}-${tag}.err.txt`)
  const outFd = openSync(outFile, 'w')
  const errFd = openSync(errFile, 'w')
  let result
  try {
    result = spawnSync('reg.exe', args, { stdio: ['ignore', outFd, errFd], windowsHide: true })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  let stdout = ''
  let stderr = ''
  try {
    stdout = readFileSync(outFile, 'utf8')
    stderr = readFileSync(errFile, 'utf8')
  } catch {
    /* 读不到就是空输出；下面的状态码判定仍然有效 */
  }
  for (const file of [outFile, errFile]) {
    try {
      rmSync(file, { force: true })
    } catch {
      /* 临时文件清不掉不影响判定 */
    }
  }
  const text = `${stdout}\n${stderr}`
  let status = result.status ?? 1
  if (/Access is denied/i.test(text)) status = REG_STATUS.ERROR_ACCESS_DENIED
  else if (/unable to find/i.test(text)) status = REG_STATUS.ERROR_FILE_NOT_FOUND
  return { status, stdout, stderr }
}

function regTarget(fullPath) {
  const { hive, subKey } = parseRegistryPath(fullPath)
  return subKey.length > 0 ? `${hive}\\${subKey}` : hive
}

/** `reg query` 的文本 → `normalizeSnapshot` 需要的类型化值 */
function typedValueFromRegText(typeName, text) {
  const raw = text === '(value not set)' ? '' : text
  switch (typeName) {
    case 'REG_SZ':
    case 'REG_EXPAND_SZ':
      return raw
    case 'REG_DWORD':
      return Number.parseInt(raw.replace(/^0x/i, ''), 16) >>> 0
    case 'REG_QWORD':
      return BigInt(`0x${raw.replace(/^0x/i, '')}`)
    case 'REG_BINARY':
      return Buffer.from(raw.replace(/\s+/g, ''), 'hex')
    case 'REG_MULTI_SZ':
      return raw.split('\\0').filter((entry) => entry.length > 0)
    default:
      throw Object.assign(new Error(`reg.exe reader: ${typeName} 没有可用的文本表示`), { code: 'REG_E2E_BACKEND_UNSUPPORTED', type: typeName })
  }
}

/**
 * 真实 hive 的读取器（宿主令牌 = 当前进程令牌）。
 * 契约与 `createRegistryReader` 相同：`{exists, accessDenied?, errorCode?, subKeys, values}`。
 */
function createRegExeReader() {
  let tag = 0
  return {
    read(fullPath) {
      const canonical = parseRegistryPath(fullPath).canonical
      tag += 1
      const queried = runReg(['query', regTarget(canonical)], `r${tag}`)
      if (queried.status === REG_STATUS.ERROR_ACCESS_DENIED) return { exists: true, accessDenied: true, errorCode: 5 }
      if (queried.status === REG_STATUS.ERROR_FILE_NOT_FOUND) return { exists: false, errorCode: 2 }
      if (queried.status !== 0) {
        throw Object.assign(new Error(`reg query ${canonical} failed: ${queried.stderr.trim() || queried.status}`), { code: 'REG_OPEN_FAILED', status: queried.status })
      }
      const lines = queried.stdout.split(/\r?\n/)
      const subKeys = []
      const values = {}
      for (const line of lines) {
        if (line.trim().length === 0) continue
        if (/^HKEY_/i.test(line.trim())) {
          // 第一行是"被查询的键自身"，其余是子键的完整路径
          if (line.trim().toLowerCase() !== regTarget(canonical).toLowerCase()) {
            const segments = line.trim().split('\\')
            subKeys.push(segments[segments.length - 1])
          }
          continue
        }
        const match = line.match(/^\s{4}(\S.*?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/)
        if (match) {
          const [, name, typeName, text] = match
          const valueName = name === '(Default)' ? '' : name
          values[valueName] = { type: typeName, data: typedValueFromRegText(typeName, text) }
        }
      }
      return { exists: true, subKeys, values, errorCode: 0 }
    },
  }
}

/** 真实 hive 的写入器（`reg.exe` 后端；接口与 `createRegistryWriter` 相同：返回 {status}） */
function createRegExeWriter() {
  let tag = 0
  return {
    createKey(path) {
      tag += 1
      return { status: runReg(['add', regTarget(path), '/f'], `ak${tag}`).status }
    },
    setValue(path, valueName, type, dataHex) {
      tag += 1
      const typeName = typeof type === 'string' ? type : undefined
      const typed = typeName ? decodeRegistryValue(typeName, dataHex, valueName) : undefined
      let dataArg
      if (typeName === 'REG_SZ' || typeName === 'REG_EXPAND_SZ') dataArg = String(typed)
      else if (typeName === 'REG_DWORD') dataArg = `${typed}`
      else if (typeName === 'REG_QWORD') dataArg = `0x${typed.toString(16)}`
      else if (typeName === 'REG_BINARY') dataArg = Buffer.isBuffer(typed) ? typed.toString('hex') : String(typed)
      else {
        throw Object.assign(
          new Error(
            `reg.exe 后端无法表达 ${typeName}（命令行参数不能携带内嵌 NUL）—— 请让 koffi 可用后重跑 ` +
              '（生产写入器是 createRegistryWriter(koffi bindings)）',
          ),
          { code: 'REG_E2E_BACKEND_UNSUPPORTED', status: REG_STATUS.ERROR_ACCESS_DENIED },
        )
      }
      const target = regTarget(path)
      const args = valueName.length > 0 ? ['add', target, '/v', valueName, '/t', typeName, '/d', dataArg, '/f'] : ['add', target, '/ve', '/t', typeName, '/d', dataArg, '/f']
      return { status: runReg(args, `sv${tag}`).status }
    },
    deleteValue(path, valueName) {
      tag += 1
      const args = valueName.length > 0 ? ['delete', regTarget(path), '/v', valueName, '/f'] : ['delete', regTarget(path), '/ve', '/f']
      return { status: runReg(args, `dv${tag}`).status }
    },
    deleteKey(path) {
      tag += 1
      return { status: runReg(['delete', regTarget(path), '/f'], `dk${tag}`).status }
    },
  }
}

/** 优先 koffi（生产路径），不可用则 `reg.exe`；返回 {writer, backend, note} */
async function resolveWriter() {
  try {
    const { loadFfi } = await import(pathToFileURL(join(REPO, 'src', 'capability.mjs')).href)
    const koffi = loadFfi()
    if (koffi) {
      const advapi32 = koffi.load('advapi32.dll')
      const bindings = createKoffiRegistryBindings(koffi, advapi32)
      return { writer: createRegistryWriter(bindings), backend: 'koffi', note: '生产写入器 createRegistryWriter(koffi bindings)' }
    }
  } catch (error) {
    return { writer: createRegExeWriter(), backend: 'reg.exe', note: `koffi 不可用（${String(error.message).slice(0, 80)}）⇒ 退化到 reg.exe 后端` }
  }
  return { writer: createRegExeWriter(), backend: 'reg.exe', note: 'koffi 不可用 ⇒ 退化到 reg.exe 后端' }
}

/**
 * koffi 绑定（形状与 `createRegistryReader`/`createRegistryWriter` 期望的 JS 契约一致）。
 * `[未验证]`：本机没有 koffi，这条分支在**未受限会话**里才会被真正执行；
 * 若它出错，套件会打印 koffi 的错误并**退化到 reg.exe**（见 resolveWriter），不会假装通过。
 */
function createKoffiRegistryBindings(koffi, advapi32) {
  const HKEY = koffi.pointer('void')
  const DWORD = koffi.types.uint32
  const regOpenKeyExW = advapi32.func('long RegOpenKeyExW(void* hKey, const char16_t* lpSubKey, uint32 ulOptions, uint32 samDesired, _Out_ void** phkResult)')
  const regCreateKeyExW = advapi32.func('long RegCreateKeyExW(void* hKey, const char16_t* lpSubKey, uint32 Reserved, char16_t* lpClass, uint32 dwOptions, uint32 samDesired, void* lpSecurityAttributes, _Out_ void** phkResult, _Out_ uint32* lpdwDisposition)')
  const regSetValueExW = advapi32.func('long RegSetValueExW(void* hKey, const char16_t* lpValueName, uint32 Reserved, uint32 dwType, const void* lpData, uint32 cbData)')
  const regDeleteValueW = advapi32.func('long RegDeleteValueW(void* hKey, const char16_t* lpValueName)')
  const regDeleteKeyExW = advapi32.func('long RegDeleteKeyExW(void* hKey, const char16_t* lpSubKey, uint32 samDesired, uint32 Reserved)')
  const regCloseKey = advapi32.func('long RegCloseKey(void* hKey)')
  void HKEY
  void DWORD
  return {
    regOpenKeyExW: (handle, subKey, options, samDesired) => {
      const out = [null]
      const status = regOpenKeyExW(handle, subKey, options, samDesired, out)
      return { status, handle: out[0] }
    },
    regCreateKeyExW: (handle, subKey, reserved, cls, dwOptions, samDesired) => {
      const out = [null]
      const disposition = [0]
      const status = regCreateKeyExW(handle, subKey, reserved, cls, dwOptions, samDesired, null, out, disposition)
      return { status, handle: out[0], disposition: disposition[0] }
    },
    regSetValueExW: (handle, valueName, reserved, type, data) => ({ status: regSetValueExW(handle, valueName, reserved, type, data, data.length) }),
    regDeleteValueW: (handle, valueName) => ({ status: regDeleteValueW(handle, valueName) }),
    regDeleteKeyExW: (handle, subKey, samDesired, reserved) => ({ status: regDeleteKeyExW(handle, subKey, samDesired, reserved) }),
    regCloseKey: (handle) => regCloseKey(handle),
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

function findJournalBytes() {
  const stageRoot = findStageRoot()
  if (!stageRoot) return { source: 'none' }
  const journalPath = join(stageRoot, 'registry', 'overlay.journal')
  try {
    return { source: 'artifact', stageRoot, journalPath, buffer: readFileSync(journalPath) }
  } catch {
    return { source: 'none', stageRoot, journalPath }
  }
}

function synthesizeJournal() {
  const data = `${E2E_VALUE_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}`
  const records = [
    journalRecordForOperation({ op: 'create-key', path: PROBE_KEY }),
    journalRecordForOperation({ op: 'set-value', path: PROBE_KEY, valueName: PROBE_VALUE, type: 'REG_SZ', value: data }),
  ]
  return { source: 'synthesized', buffer: Buffer.concat(records.map((record) => encodeJournalRecord(record))), expectedData: data }
}

/** 从 WAL 字节里取出"探针那次写入"的期望字节（正例与变异体都用它） */
function expectedFromJournal(buffer) {
  const { records } = decodeJournalRecords(buffer)
  const record = records.find(
    (entry) => entry.kind === REG_STAGE_KIND.SET_VALUE && parseRegistryPath(entry.path).canonical === PROBE_KEY && entry.valueName === PROBE_VALUE,
  )
  if (!record) return { expectedHex: undefined, expectedString: undefined, unitPath: undefined }
  return {
    expectedHex: record.data,
    expectedString: decodeRegistryValue(record.typeName, record.data, PROBE_VALUE),
    unitPath: `${PROBE_KEY}\\${PROBE_VALUE}`,
  }
}

function keysOf(reader) {
  try {
    return reader.read(PROBE_KEY)
  } catch (error) {
    return { exists: false, error: String(error.message) }
  }
}

async function main() {
  const assertions = { total: 0, failed: 0 }
  const check = (name, condition, detail) => {
    assertions.total += 1
    if (!condition) assertions.failed += 1
    W(`${condition ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
  }
  const notVerified = (reason) => {
    W('')
    W('!'.repeat(72))
    W(`NOT VERIFIED —— ${reason}`)
    W('本次**没有**在真实 hive 上验证 apply()；这不是通过。请在未受限会话里重跑：')
    W('  node tests\\registry-apply-e2e.mjs')
    W('!'.repeat(72))
    return 2
  }

  const reader = createRegExeReader()
  const journal = findJournalBytes()
  const wal = journal.source === 'artifact' ? journal : synthesizeJournal()
  const expected = expectedFromJournal(wal.buffer)
  W(`registry-apply-e2e：真实 hive 副作用端到端（WAL 来源 = ${wal.source}${wal.stageRoot ? `：${wal.stageRoot}` : ''}）`)
  W(`  期望写入：${PROBE_KEY} / ${PROBE_VALUE} = ${JSON.stringify(expected.expectedString)}`)
  W(`  期望字节：${expected.expectedHex}`)

  // ── P3 变异体自证（纯判定，先跑：任何会话都能证明"断言有判定力"）─────────────────
  W('')
  W('=== P3. 判定器的判定力（变异体自证；不需要注册表写权限）===')
  {
    const positive = checkApplyOutcome({
      beforeExists: false,
      afterExists: true,
      expectedHex: 'abcd',
      afterHex: 'abcd',
      appliedCount: 2,
      failedCount: 0,
      blockedCount: 0,
      candidateUnits: 2,
    })
    check('正例：apply 前不存在 / apply 后存在且字节相等 ⇒ 判定通过', positive.ok === true, positive.failures.join(' | ') || 'ok')
    const noopMutant = checkApplyOutcome({ beforeExists: false, afterExists: false, expectedHex: 'abcd', afterHex: undefined, appliedCount: 0, failedCount: 0, blockedCount: 0, candidateUnits: 2 })
    check('变异体 1（apply 变成 no-op：真实 hive 没变）必须判红', noopMutant.ok === false && noopMutant.failures.some((line) => /必须存在/.test(line)), noopMutant.failures.join(' | '))
    const encodingMutant = checkApplyOutcome({ beforeExists: false, afterExists: true, expectedHex: 'abcd', afterHex: 'ab00', appliedCount: 2, failedCount: 0, blockedCount: 0, candidateUnits: 2 })
    check('变异体 2（编码/长度写错：字节不相等）必须判红', encodingMutant.ok === false && encodingMutant.failures.some((line) => /逐字节相等/.test(line)), encodingMutant.failures.join(' | '))
    const clobberMutant = checkApplyOutcome({ beforeExists: true, afterExists: true, expectedHex: 'abcd', afterHex: 'abcd', appliedCount: 2, failedCount: 0, blockedCount: 0, candidateUnits: 2 })
    check('变异体 3（apply 前键已存在：会覆盖别人数据）必须判红', clobberMutant.ok === false, clobberMutant.failures.join(' | '))
  }

  // ── 预检：会话是否可写真实注册表；键是否被占用 ────────────────────────────────
  W('')
  W('=== P0. 预检（可写性 + 不覆盖既有数据）===')
  let precheckCreated = false
  let precheckLeftover = false
  const preExisting = keysOf(reader)
  try {
    const pre = runReg(['add', regTarget(PRECHECK_KEY), '/f'], 'pre')
    precheckCreated = pre.status === 0
    if (!precheckCreated) {
      W(`  ⊘ SKIP 会话可写 HKCU —— reg add 预检被拒（status=${pre.status} ${pre.stderr.trim()}）`)
      if (preexistingOnlyOurProbe(preExisting, reader)) {
        // 上一次崩溃留下的探针键：只在我们能确认它"就是我们的探针形状"时才清
        const cleaned = runReg(['delete', regTarget(PROBE_KEY), '/f'], 'preclean')
        W(`  ⊘ 顺手清理上一次运行遗留的探针键：status=${cleaned.status}`)
      }
      return notVerified(`本会话不能写真实注册表（status=${pre.status}）：apply 的真实副作用无法在这里验证`)
    }
    check('会话可写 HKCU（reg add 预检键）', true, 'writable')
    if (preExisting.exists === true) {
      if (preexistingOnlyOurProbe(preExisting, reader)) {
        precheckLeftover = true
        const cleaned = runReg(['delete', regTarget(PROBE_KEY), '/f'], 'preclean')
        check('探针键已存在且形状匹配 t4-probe-* ⇒ 判定为上次残留并清理', cleaned.status === 0, `status=${cleaned.status}`)
      } else {
        return notVerified(`${PROBE_KEY} 已存在且不像我们的测试残留 —— 拒绝覆盖既有数据`)
      }
    } else {
      check('apply 前真实 hive 里探针键不存在', true, `exists=${preExisting.exists}`)
    }
  } finally {
    if (precheckCreated) runReg(['delete', regTarget(PRECHECK_KEY), '/f'], 'preclean2')
  }

  const { writer, backend, note } = await resolveWriter()
  W(`  写入后端：${backend}（${note}）`)
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-apply-e2e-'))
  let appliedKeyExists = false
  try {
    // ── P1 正例：真实 WAL → open/diff/freeze/apply ─────────────────────────────
    W('')
    W('=== P1. 真实 WAL → open → diff → freezeCandidate → apply（真实 hive）===')
    const sessionDir = join(tempRoot, 'apply')
    mkdirSync(join(sessionDir, 'registry'), { recursive: true })
    writeFileSync(join(sessionDir, 'registry', 'overlay.journal'), wal.buffer)
    const stage = createRegistryStage({ sessionDir, sessionId: 'apply-e2e', reader, writer })
    const opened = stage.open()
    check('open() 能重放 WAL', opened.resumed > 0 && opened.torn === false, `resumed=${opened.resumed} torn=${opened.torn} rejected=${opened.rejected.length}`)
    const before = keysOf(reader)
    check('apply 前真实 hive 里探针键不存在', before.exists === false, `exists=${before.exists}`)
    const diff = stage.diff()
    const frozen = stage.freezeCandidate()
    const candidateUnits = frozen.candidate?.changes?.length ?? 0
    check('冻结候选：含该值单元且候选单元数 ≥2（父键 mkdir + 值 create）', frozen.enqueued === true && candidateUnits >= 2, `units=${candidateUnits}`)
    const applied = stage.apply()
    appliedKeyExists = true
    const after = keysOf(reader)
    const afterEntry = after.exists === true ? readProbeValueBytes(reader) : undefined
    const outcome = checkApplyOutcome({
      beforeExists: before.exists,
      afterExists: after.exists,
      expectedHex: expected.expectedHex,
      afterHex: afterEntry?.hex,
      appliedCount: applied.applied.length,
      failedCount: applied.failed.length,
      blockedCount: applied.blocked.length,
      candidateUnits,
    })
    check('apply 后：真实 hive 出现该键，且 T4Probe 的值与 WAL 逐字节相等', outcome.ok === true, outcome.failures.join(' | ') || `applied=${applied.applied.length} hex=${afterEntry?.hex}`)

    // ── P1b 回滚：**按 planRollback 的计划手工执行**，断言真实 hive 回到原状 ──────────
    W('')
    W('=== P1b. 用 diff 的回滚计划把真实 hive 恢复原状（计划可执行性证据）===')
    const planOps = []
    for (const root of Object.values(diff.roots)) {
      for (const operation of root.rollback?.operations ?? []) {
        if (operation.op === 'delete-value' || operation.op === 'delete-key' || operation.op === 'set-value') planOps.push(operation)
      }
    }
    const irreversible = planOps.filter((operation) => operation.reversibility === 'impossible')
    check('回滚计划里含可执行的 delete-value/delete-key（本场景不需要"不可能"的还原）', planOps.length > 0 && irreversible.length === 0, `ops=[${planOps.map((op) => `${op.op}:${op.path}${op.valueName ? '\\' + op.valueName : ''}`).join(',')}]`)
    // **安全阀**：用例会删真实键。只允许删除"至少三级"的路径（`HKCU\Software\X`），
    // 永不触碰 `HKCU\Software` 这类系统键 —— 计划若给出更浅的路径，判红并拒绝执行。
    const tooShallow = planOps.filter((operation) => operation.path.split('\\').length < 3)
    check('回滚计划不得包含浅于三级的路径（安全阀：绝不删 HKCU\\Software 这类系统键）', tooShallow.length === 0, tooShallow.length === 0 ? `deepest-safe: ${planOps.map((op) => op.path).join(',')}` : `unsafe=[${tooShallow.map((op) => op.path).join(',')}]`)
    const rollbackResult = tooShallow.length === 0 ? executePlan(planOps, writer) : { done: [], failed: [{ reason: 'refused: shallow path in plan' }] }
    check('按计划执行回滚：每一步都返回 ERROR_SUCCESS', rollbackResult.failed.length === 0, JSON.stringify(rollbackResult))
    const restored = keysOf(reader)
    appliedKeyExists = restored.exists === true
    check('回滚后真实 hive 恢复原状（探针键不存在 ⇒ 与 apply 前的状态一致）', restored.exists === false, `exists=${restored.exists}`)
    stage.discard({ reason: 'apply-e2e' })

    // ── P2 选择性 apply 的依赖语义 ─────────────────────────────────────────────
    W('')
    W('=== P2. 只批准值单元、不批准父键 mkdir ⇒ blocked + 真实 hive 零写入 ===')
    const selectiveDir = join(tempRoot, 'selective')
    mkdirSync(join(selectiveDir, 'registry'), { recursive: true })
    writeFileSync(join(selectiveDir, 'registry', 'overlay.journal'), wal.buffer)
    const selectiveStage = createRegistryStage({ sessionDir: selectiveDir, sessionId: 'apply-e2e-selective', reader, writer })
    selectiveStage.open()
    selectiveStage.diff()
    selectiveStage.freezeCandidate()
    const selective = selectiveStage.apply({ paths: [expected.unitPath] })
    check(
      '只选值单元 ⇒ blocked（status=2，reason 指明父键未批准）',
      selective.applied.length === 0 && selective.blocked.length === 1 && selective.blocked[0].status === 2 && /parent key/.test(selective.blocked[0].reason),
      JSON.stringify(selective.blocked),
    )
    const untouched = keysOf(reader)
    check('blocked 时真实 hive 未被写入（没有半个键、没有空键）', untouched.exists === false, `exists=${untouched.exists}`)
    selectiveStage.discard({ reason: 'apply-e2e-selective' })
  } finally {
    // ── P4 清理：失败也要清；清不掉就是失败 ────────────────────────────────────
    W('')
    W('=== P4. 清理（finally：失败也执行）===')
    const cleanup = runReg(['delete', regTarget(PROBE_KEY), '/f'], 'cleanup')
    const remaining = keysOf(reader)
    check(
      `真实 hive 已恢复（探针键不存在）${appliedKeyExists ? '（本次确实 apply 过）' : ''}`,
      remaining.exists === false,
      `delete status=${cleanup.status} exists=${remaining.exists}`,
    )
    rmSync(tempRoot, { recursive: true, force: true })
  }

  W('')
  W('='.repeat(72))
  W(`registry-apply-e2e（真实 hive）：断言 ${assertions.total} 项，失败 ${assertions.failed} 项`)
  W('='.repeat(72))
  return assertions.failed > 0 ? 1 : 0
}

/** 从真实 hive 读回探针值的**原始字节**（用独立于写入器的 reader 路径） */
function readProbeValueBytes(reader) {
  const snapshot = normalizeSnapshot({ root: PROBE_KEY, ...reader.read(PROBE_KEY) })
  const entry = Object.entries(snapshot.values).find(([name]) => name.toLowerCase() === PROBE_VALUE.toLowerCase())
  if (!entry) return undefined
  const [, value] = entry
  return { hex: value.data, type: value.type }
}

/** 只在我们能确认"这个键就是我们的测试残留"时才清（值是 `t4-probe-*` 形状） */
function preexistingOnlyOurProbe(snapshot, reader) {
  try {
    if (!snapshot || snapshot.exists !== true) return false
    const current = normalizeSnapshot({ root: PROBE_KEY, ...reader.read(PROBE_KEY) })
    const names = Object.keys(current.values)
    // 只有"空键"或"只有一个 T4Probe 且值是 t4-probe-* 形状"才算我们的残留
    if (names.length > 1) return false
    if (names.length === 0) return true
    if (names[0].toLowerCase() !== PROBE_VALUE.toLowerCase()) return false
    const entry = current.values[names[0]]
    const decoded = decodeRegistryValue(entry.type, entry.data, names[0])
    return typeof decoded === 'string' && decoded.startsWith(E2E_VALUE_PREFIX)
  } catch {
    return false
  }
}

/**
 * 按 `planRollback` 的计划执行回滚（**用例侧**手工执行；生产不提供自动回滚 API，见文档 §13.4）。
 * 顺序：delete-value → delete-key（深 → 浅）→ set-value（还原旧值）。
 */
function executePlan(operations, writer) {
  const results = { done: [], failed: [] }
  const deletes = operations.filter((operation) => operation.op === 'delete-value')
  const keyDeletes = operations
    .filter((operation) => operation.op === 'delete-key')
    .sort((left, right) => right.path.split('\\').length - left.path.split('\\').length)
  const setValues = operations.filter((operation) => operation.op === 'set-value')
  for (const operation of [...deletes, ...keyDeletes, ...setValues]) {
    let result
    try {
      if (operation.op === 'delete-value') result = writer.deleteValue(operation.path, operation.valueName ?? '')
      else if (operation.op === 'delete-key') result = writer.deleteKey(operation.path, { recursive: true })
      else result = writer.setValue(operation.path, operation.valueName ?? '', operation.type, operation.data)
    } catch (error) {
      results.failed.push({ op: operation.op, path: operation.path, reason: String(error.message) })
      continue
    }
    const status = (result?.status ?? result ?? 0) >>> 0
    // 删一个已经不存在的东西（2）在回滚里是**幂等成功**，不是失败
    if (status === 0 || (operation.op.startsWith('delete') && status === REG_STATUS.ERROR_FILE_NOT_FOUND)) results.done.push({ op: operation.op, path: operation.path, status })
    else results.failed.push({ op: operation.op, path: operation.path, status })
  }
  return results
}

function isMainModule() {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry.length === 0) return false
  try {
    return import.meta.url === pathToFileURL(entry).href
  } catch {
    return false
  }
}

if (isMainModule()) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      W(`registry-apply-e2e FAILED: ${error.stack ?? error.message}`)
      process.exitCode = 1
    })
}
