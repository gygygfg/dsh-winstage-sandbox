/**
 * registry-stage 的离线确定性测试（**不需要管理员、不需要真实注册表写入、不碰任何系统状态**）
 *
 * 为什么单独一个文件、又同时被 `tests/registry-guard.mjs` 调用：
 *   · 单独一个文件 → 可以 `node tests\registry-stage.mjs` 独立跑，定位问题更清楚；
 *   · 导出 `runRegistryStageChecks(harness)` 供 `registry-guard` 的套件复用 →
 *     让 `verify.cmd` / `src\testrunner.mjs` 的既有入口**自动**覆盖它
 *     （`verify.cmd` 的清单不在 T3 的写入范围内，把断言接到既有入口上，
 *     比"新增一个没人跑的套件"诚实得多）。
 *
 * 覆盖的验收点（逐条对应 `docs/T3-注册表暂存设计.md`）：
 *   1. 覆盖区路径 / 覆盖 hive 内路径映射（纯函数，与权限无关）；
 *   2. 仍然是**硬拒**的清单：hive / API / 选项掩码 / 值类型 —— 且清单**可执行**（真抛错）；
 *   3. 覆盖层"写 → 读回自己写的值"，八种受支持类型全覆盖，含未命名默认值；
 *   4. 覆盖视图语义：中间键、`delete-key` 的清空语义、大小写不敏感；
 *   5. WAL 定长头的**逐字段偏移**（C 结构体与 JS 解析器不许漂移）+ 撕裂尾部必须报出来；
 *   6. 全链路：写 → 读回 → 冻结候选（与文件候选同构、同一 `candidates/`+`queue.json`）
 *      → 选择性应用（只动选中路径）→ 丢弃；
 *   7. **未应用时真实 hive 一个字节都不变**（用假真实 hive 的写日志证明，不靠"我觉得"）；
 *   8. 诚实边界：基线读不到时**不**冻结候选；无 writer 时 apply 必须抛错（不许假装成功）；
 *      冻结后真实 hive 变了必须判 stale。
 *
 * 用法：
 *   node tests\registry-stage.mjs
 *   node tests\registry-guard.mjs        # 同一批断言也会在既有套件里执行
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  REG_STAGE_KIND,
  REG_STAGE_FLAGS,
  REG_STAGE_JOURNAL_MAGIC,
  REG_STAGE_RECORD_OFFSETS,
  REG_STAGE_RECORD_SIZE,
  REG_STAGE_HOOKED_APIS,
  REG_STAGE_UNSUPPORTED_TYPES,
  REGISTERED_HARD_DENIALS,
  HARD_DENY_STATUS,
  REG_HIVES_STAGEABLE,
  REG_LOAD_APP_KEY_FLAGS,
  REG_OPTIONS,
  KEY_WOW64,
  applyOverlayOperation,
  canonicalFromOverlaySubKey,
  classifyOverlayNetEffect,
  classifyRegistryOperation,
  createOverlayState,
  createRegistryStage,
  createRegistryWriter,
  decodeJournalRecords,
  diffOverlay,
  encodeJournalRecord,
  journalHardDenyRecord,
  journalRecordForOperation,
  overlayChangesToCandidateChanges,
  overlayContainerChain,
  overlaySubKeyFor,
  overlayTouchedPaths,
  overlayView,
  readRegistryJournal,
  registryDataHex,
  registryValueUnitPath,
  registryWireBytes,
  replayJournal,
  resolveRegistryStageDiscardedPath,
  resolveRegistryStageJournalPath,
  resolveRegistryStagePath,
  resolveRegistryStageRoot,
  resolveRegistryStageStatePath,
  summarizeRegistryChanges,
  writeRegistryJournal,
  __internal,
} from '../src/registry-stage.mjs'
import {
  REG_STATUS,
  REG_TYPES,
  decodeRegistryValue,
  encodeRegistryValue,
  normalizeSnapshot,
  parseRegistryPath,
} from '../src/registry-guard.mjs'

function stableJson(value) {
  return JSON.stringify(value, (key, item) => (typeof item === 'bigint' ? `${item}n` : item))
}

// ─────────────────── 假真实 hive（可观测的"真实注册表"）───────────────────
//
// 关键设计：它**记录每一次写入**，并且只有在 writer 被调用时才改变内容。
// 于是"未应用时真实 hive 不变"是一条**可判定**的事实（写日志长度为 0 +
// 前后序列化文本逐字相同），而不是一句声明。
function createFakeRegistry(seed = []) {
  const keys = new Map() // fold(path) → { path, values: Map(fold(name) → {name,type,data:typed}) }
  const log = { reads: 0, writes: [] }

  const ensure = (path) => {
    const fold = path.toLowerCase()
    if (!keys.has(fold)) keys.set(fold, { path, values: new Map() })
    return keys.get(fold)
  }
  const parentOf = (path) => {
    const index = path.lastIndexOf('\\')
    return index <= 0 ? undefined : path.slice(0, index)
  }
  const lastSegment = (path) => path.slice(path.lastIndexOf('\\') + 1)

  for (const [path, name, type, data] of seed) ensure(path).values.set(String(name).toLowerCase(), { name, type, data })

  return {
    keys,
    log,
    reader: {
      read(path) {
        log.reads += 1
        const { canonical } = parseRegistryPath(path)
        const fold = canonical.toLowerCase()
        const record = keys.get(fold)
        if (!record) return { exists: false }
        const subKeys = []
        for (const other of keys.values()) {
          const parent = parentOf(other.path)
          if (parent !== undefined && parent.toLowerCase() === fold) subKeys.push(lastSegment(other.path))
        }
        const values = {}
        for (const entry of record.values.values()) values[entry.name] = { type: entry.type, data: entry.data }
        return { exists: true, subKeys, values }
      },
    },
    writer: {
      createKey(path) {
        log.writes.push(['create-key', path])
        ensure(path)
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      setValue(path, name, type, dataHex) {
        log.writes.push(['set-value', path, name, type, dataHex])
        ensure(path).values.set(String(name).toLowerCase(), { name, type, data: decodeRegistryValue(type, dataHex, name) })
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      deleteValue(path, name) {
        log.writes.push(['delete-value', path, name])
        const record = keys.get(path.toLowerCase())
        if (record) record.values.delete(String(name).toLowerCase())
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      deleteKey(path) {
        log.writes.push(['delete-key', path])
        const fold = path.toLowerCase()
        keys.delete(fold)
        for (const other of [...keys.keys()]) if (other.startsWith(`${fold}\\`)) keys.delete(other)
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
    },
    /** 外部（"别的程序"）直接改真实 hive —— 用来验证 stale 判定 */
    mutate(path, name, type, data) {
      ensure(path).values.set(String(name).toLowerCase(), { name, type, data })
    },
    snapshotText() {
      return stableJson(
        [...keys.entries()]
          .sort(([left], [right]) => (left < right ? -1 : 1))
          .map(([fold, record]) => [fold, record.path, [...record.values.entries()].sort()]),
      )
    },
  }
}

/**
 * 全部断言。`harness` 由调用方提供，因此既能在本文件独立跑，
 * 也能被 `tests/registry-guard.mjs` 的计数器统一统计。
 */
export function runRegistryStageChecks(harness) {
  const { check, checkThrows, section } = harness
  const workRoot = mkdtempSync(join(tmpdir(), 'dsh-regstage-'))

  try {
    section('S1. 覆盖区路径与映射（纯函数；shim 与宿主必须用同一份）')
    {
      const sessionDir = join(workRoot, 's1')
      check('resolveRegistryStageRoot = <sessionDir>/registry', resolveRegistryStageRoot(sessionDir) === join(sessionDir, 'registry'), resolveRegistryStageRoot(sessionDir))
      check('resolveRegistryStagePath = .../registry/overlay.hive', resolveRegistryStagePath(sessionDir) === join(sessionDir, 'registry', 'overlay.hive'), resolveRegistryStagePath(sessionDir))
      check('journal / state / discarded 三个路径都在同一个 registry 目录下', [resolveRegistryStageJournalPath(sessionDir), resolveRegistryStageStatePath(sessionDir), resolveRegistryStageDiscardedPath(sessionDir)].every((path) => dirname(path) === join(sessionDir, 'registry')), resolveRegistryStageJournalPath(sessionDir))
      checkThrows('sessionDir 为空时抛错（不猜当前目录）', () => resolveRegistryStagePath(''), undefined)

      check(
        '覆盖 hive 内路径映射：HKEY_ 全名归一成短名（与真实路径 canonical 逐字相同）',
        overlaySubKeyFor('HKEY_LOCAL_MACHINE\\Software\\X') === 'HKLM\\Software\\X' &&
          overlaySubKeyFor('HKCU\\Software\\X') === 'HKCU\\Software\\X',
        `${overlaySubKeyFor('HKEY_LOCAL_MACHINE\\Software\\X')} | ${overlaySubKeyFor('HKCU\\Software\\X')}`,
      )
      check(
        '映射往返恒等（canonicalFromOverlaySubKey ∘ overlaySubKeyFor = id）',
        canonicalFromOverlaySubKey(overlaySubKeyFor('HKLM\\SOFTWARE\\Run')) === 'HKLM\\SOFTWARE\\Run',
        canonicalFromOverlaySubKey(overlaySubKeyFor('HKLM\\SOFTWARE\\Run')),
      )
      checkThrows('未知根键在映射处就抛错（不猜根键）', () => overlaySubKeyFor('Software\\X'), 'REG_HIVE_UNKNOWN')
      check(
        '容器链不含裸 hive 根、含目标自身（HKLM\\Software\\X → 2 级）',
        stableJson(overlayContainerChain('HKLM\\Software\\X')) === stableJson(['HKLM\\Software', 'HKLM\\Software\\X']),
        stableJson(overlayContainerChain('HKLM\\Software\\X')),
      )
      check('只有根键时容器链为空（不会去"创建" HKCU 本身）', overlayContainerChain('HKCU').length === 0, stableJson(overlayContainerChain('HKCU')))
      check(
        '值单元路径：有名值 = key\\name，未命名（默认）值 = key\\@',
        registryValueUnitPath('HKCU\\A', 'V') === 'HKCU\\A\\V' && registryValueUnitPath('HKCU\\A', '') === 'HKCU\\A\\@',
        `${registryValueUnitPath('HKCU\\A', 'V')} | ${registryValueUnitPath('HKCU\\A', '')}`,
      )
      checkThrows('createRegistryStage 缺 sessionDir 抛错', () => createRegistryStage({}), undefined)
    }

    section('S2. 仍然是硬拒的清单（可执行：真抛错，不是文档承诺）')
    {
      const hkpd = classifyRegistryOperation({ api: 'RegCreateKeyExW', path: 'HKPD\\Anything' })
      check('HKPD（HKEY_PERFORMANCE_DATA）硬拒，LSTATUS = ERROR_ACCESS_DENIED', hkpd.stageable === false && hkpd.status === HARD_DENY_STATUS, stableJson(hkpd))
      check('HKPD 的拒绝理由说明"无后备配置单元文件"', /后备配置单元文件/.test(hkpd.reason), hkpd.reason)
      check(
        '五个真实 hive 全部可暂存（HKCR/HKCU/HKLM/HKU/HKCC）',
        REG_HIVES_STAGEABLE.every((hive) => classifyRegistryOperation({ api: 'RegCreateKeyExW', path: `${hive}\\Probe` }).stageable === true),
        REG_HIVES_STAGEABLE.join(','),
      )
      // 长名与短名必须同判（否则 HKLM 被拒、HKEY_LOCAL_MACHINE 被放行）
      check(
        'hive 长短名同判（HKEY_LOCAL_MACHINE\\X 与 HKLM\\X 都是 stageable）',
        classifyRegistryOperation({ api: 'RegCreateKeyExW', path: 'HKEY_LOCAL_MACHINE\\X' }).stageable === true &&
          classifyRegistryOperation({ api: 'RegCreateKeyExW', path: 'HKLM\\X' }).stageable === true,
        'both stageable',
      )

      const hardDenyApis = ['RegSetKeySecurity', 'RegLoadKey', 'RegUnLoadKey', 'RegSaveKey', 'RegRestoreKey', 'RegReplaceKey', 'RegRenameKey', 'RegCopyTree', 'RegCreateKeyTransactedW', 'RegConnectRegistryW', 'NtSetValueKey', 'ZwSetValueKey', 'NtCreateKey']
      check(
        `未支持的 ${hardDenyApis.length} 个 API 全部硬拒且带理由`,
        hardDenyApis.every((api) => {
          const verdict = classifyRegistryOperation({ api, path: 'HKLM\\X' })
          return verdict.stageable === false && verdict.status === HARD_DENY_STATUS && typeof verdict.reason === 'string' && verdict.reason.length > 20
        }),
        hardDenyApis.filter((api) => classifyRegistryOperation({ api, path: 'HKLM\\X' }).stageable !== false).join(',') || 'all denied',
      )
      check(
        '被 hook 的 8 个 API 与任务契约逐字一致',
        stableJson([...REG_STAGE_HOOKED_APIS].sort()) ===
          stableJson(['RegCreateKeyExW', 'RegDeleteKeyExW', 'RegDeleteValueW', 'RegEnumKeyExW', 'RegEnumValueW', 'RegOpenKeyExW', 'RegQueryValueExW', 'RegSetValueExW'].sort()),
        REG_STAGE_HOOKED_APIS.join(','),
      )
      check(
        '8 个被 hook 的 API 都可暂存（否则"hook 了却拒绝"会变成静默的功能缺失）',
        REG_STAGE_HOOKED_APIS.every((api) => classifyRegistryOperation({ api, path: 'HKLM\\Software\\Probe' }).stageable === true),
        REG_STAGE_HOOKED_APIS.join(','),
      )
      const unknownApi = classifyRegistryOperation({ api: 'RegSomethingElseW', path: 'HKLM\\X' })
      check('未 hook 的 API 硬拒（fail-closed，而不是"放过算了"）', unknownApi.stageable === false && unknownApi.code === 'REG_STAGE_API_NOT_HOOKED', stableJson(unknownApi))

      const linkOption = classifyRegistryOperation({ api: 'RegCreateKeyExW', path: 'HKLM\\X', dwOptions: 0x00000002 })
      check('REG_OPTION_CREATE_LINK 硬拒（覆盖层没有"链接键"这个对象）', linkOption.stageable === false && linkOption.code === 'REG_STAGE_OPTION_HARD_DENY', stableJson(linkOption))
      const wow64 = classifyRegistryOperation({ api: 'RegDeleteKeyExW', path: 'HKLM\\X', samDesired: 0x0200 })
      // 契约 v1.4 变更（旧期望：`stageable === false && code === 'REG_STAGE_SAM_HARD_DENY'`）：
      // `KEY_WOW64_32KEY` 指向**另一个 hive 位置**，覆盖层复现不了它 —— 但"复现不了"不是"没权限"，
      // 因此结论从**硬拒**改成 **unstaged 透传**（真实 API 才知道 32 位视图在哪）。
      check(
        'KEY_WOW64_32KEY ⇒ unstaged 透传（不是硬拒：不可暂存 ≠ 没权限）',
        wow64.stageable === false && wow64.unstaged === true && wow64.code === 'REG_STAGE_SAM_UNSTAGED' && wow64.status === 0,
        stableJson(wow64),
      )
      // 旧期望：`code === 'REG_STAGE_SAM_HARD_DENY'`（64KEY 也被硬拒）。
      // 新期望：64 位进程里 KEY_WOW64_64KEY 是 winreg.h 文档化的 **no-op** ⇒ 既不拒也不是视图请求，
      // 走**正常暂存**路径（把它当硬拒正是 "创建一个还不存在的键 → ACCESS_DENIED" 的根因）。
      const wow64Noop = classifyRegistryOperation({ api: 'RegOpenKeyExW', path: 'HKLM\\X', samDesired: 0x0100 })
      check(
        'KEY_WOW64_64KEY 在 64 位进程里是 no-op（必须可暂存，不能拒）',
        wow64Noop.stageable === true && wow64Noop.code === 'REG_STAGE_OK' && wow64Noop.unstaged === undefined,
        stableJson(wow64Noop),
      )
      // 契约自身的完备性：真的处在 WOW64 进程里时，64KEY 也**确实**指向另一个视图 ⇒ 按不可暂存处理。
      check(
        'WOW64 进程里 KEY_WOW64_64KEY 才是真视图请求 ⇒ unstaged（而不是硬拒）',
        classifyRegistryOperation({ api: 'RegOpenKeyExW', path: 'HKLM\\X', samDesired: 0x0100, wow64Process: true }).unstaged === true,
        stableJson(classifyRegistryOperation({ api: 'RegOpenKeyExW', path: 'HKLM\\X', samDesired: 0x0100, wow64Process: true })),
      )

      check(
        `四个"合法但无编解码器"的值类型全部硬拒（${REG_STAGE_UNSUPPORTED_TYPES.join('/')}）`,
        REG_STAGE_UNSUPPORTED_TYPES.every((type) => {
          const verdict = classifyRegistryOperation({ api: 'RegSetValueExW', path: 'HKLM\\X', type })
          return verdict.stageable === false && verdict.code === 'REG_TYPE_UNSUPPORTED'
        }),
        REG_STAGE_UNSUPPORTED_TYPES.join(','),
      )
      check(
        '清单可执行（不是文档承诺）：这四个类型在编解码层也真的抛 REG_TYPE_UNSUPPORTED',
        REG_STAGE_UNSUPPORTED_TYPES.every((type) => {
          try {
            decodeRegistryValue(type, '00', 'v')
            return false
          } catch (error) {
            return error.code === 'REG_TYPE_UNSUPPORTED'
          }
        }),
        'encode/decode 都拒',
      )
      check(
        '未知类型名走 REG_TYPE_UNKNOWN（与"合法但不支持"区分开）',
        classifyRegistryOperation({ api: 'RegSetValueExW', path: 'HKLM\\X', type: 'REG_MAGIC' }).code === 'REG_TYPE_UNKNOWN',
        'REG_TYPE_UNKNOWN',
      )
      checkThrows('classify 缺 api 时抛错（而不是默认放行）', () => classifyRegistryOperation({ path: 'HKLM\\X' }), 'REG_STAGE_POLICY_INVALID')
      checkThrows('dwOptions 非整数时抛错', () => classifyRegistryOperation({ api: 'RegCreateKeyExW', path: 'HKLM\\X', dwOptions: 1.5 }), 'REG_STAGE_POLICY_INVALID')

      check(
        // 契约 v1.4 变更（旧期望：`REGISTERED_HARD_DENIALS.sam.length > 0`，即两个 WOW64 位都在硬拒清单里）。
        // 新期望：`sam` **必须为空**（视图位不再是权限问题），而"不可暂存 ⇒ 透传"的新类别必须非空 ——
        // 少了这条，`sam` 悄悄变空就会被当成"没变化"。
        '硬拒清单数据化：hives/apis/options/types 非空、sam 为空（视图位不再是硬拒）、unstaged 类非空、语义级残余 ≥5',
        REGISTERED_HARD_DENIALS.hives.length > 0 &&
          REGISTERED_HARD_DENIALS.apis.length > 0 &&
          REGISTERED_HARD_DENIALS.options.length > 0 &&
          REGISTERED_HARD_DENIALS.sam.length === 0 &&
          REGISTERED_HARD_DENIALS.types.length > 0 &&
          REGISTERED_HARD_DENIALS.semantic.length >= 5 &&
          REGISTERED_HARD_DENIALS.unstaged.length > 0,
        `hives=${REGISTERED_HARD_DENIALS.hives.length} apis=${REGISTERED_HARD_DENIALS.apis.length} sam=${REGISTERED_HARD_DENIALS.sam.length} unstaged=${REGISTERED_HARD_DENIALS.unstaged.length} semantic=${REGISTERED_HARD_DENIALS.semantic.length}`,
      )
      check(
        '语义级残余必须点到"只覆盖被 hook 的调用"与"写进覆盖层 ≠ 系统生效"',
        REGISTERED_HARD_DENIALS.semantic.some((line) => /hook/.test(line)) &&
          REGISTERED_HARD_DENIALS.semantic.some((line) => /系统生效/.test(line)) &&
          REGISTERED_HARD_DENIALS.semantic.some((line) => /安全描述符/.test(line)),
        REGISTERED_HARD_DENIALS.semantic.length + ' 条',
      )
    }

    section('S3. 覆盖层写 → 读回自己写的值（八种受支持类型 + 默认值 + 大小写）')
    {
      const sessionDir = join(workRoot, 's3')
      const real = createFakeRegistry([['HKCU\\Software\\T', 'Existing', 'REG_DWORD', 1]])
      const stage = createRegistryStage({ sessionDir, sessionId: 's3', reader: real.reader, writer: real.writer })
      stage.open()
      const beforeText = real.snapshotText()

      const cases = [
        ['REG_SZ', 'hello'],
        ['REG_EXPAND_SZ', '%SystemRoot%\\x'],
        ['REG_MULTI_SZ', ['one', 'two']],
        ['REG_DWORD', 42],
        ['REG_DWORD_BIG_ENDIAN', 0x01020304],
        ['REG_QWORD', 18446744073709551615n],
        ['REG_BINARY', Buffer.from([0, 1, 255])],
        ['REG_NONE', Buffer.alloc(0)],
      ]
      let roundTrips = 0
      for (const [type, value] of cases) {
        stage.stageSetValue('HKCU\\Software\\T', `V_${type}`, type, value)
        const read = stage.readValue('HKCU\\Software\\T', `V_${type}`)
        // 判定口径：读回的**编码文本**必须与编码器对该类型化值的产物逐字相同，
        // 且解码回来必须等于原值（BigInt/Buffer/数组都要真比较）。
        const expectedHex = encodeRegistryValue(type, value)
        const decoded = read.status === 0 ? decodeRegistryValue(type, read.data, type) : undefined
        const sameValue =
          type === 'REG_QWORD'
            ? decoded === value
            : type === 'REG_BINARY'
              ? // REG_BINARY 的解码产物就是**十六进制文本**（与快照口径一致），不是 Buffer
                decoded === expectedHex
              : type === 'REG_MULTI_SZ'
                ? stableJson(decoded) === stableJson(value)
                : type === 'REG_NONE'
                  ? decoded === ''
                  : decoded === value
        if (read.status === 0 && read.data === expectedHex && sameValue) roundTrips += 1
      }
      check(`八种类型"写进去 → 读回来"全部成立（${cases.length} 种）`, roundTrips === cases.length, `${roundTrips}/${cases.length}`)

      stage.stageSetValue('HKCU\\Software\\T', '', 'REG_SZ', 'default-value')
      const defaultRead = stage.readValue('HKCU\\Software\\T', '')
      check('未命名（默认）值可暂存并读回（RegSetValueExW 允许 lpValueName = NULL/""）', defaultRead.status === 0 && defaultRead.value === 'default-value', stableJson(defaultRead))

      stage.stageSetValue('HKCU\\Software\\T', 'MiXeD', 'REG_SZ', 'x')
      check('值名大小写不敏感：写 MiXeD、读 mixed 命中同一个值', stage.readValue('HKCU\\Software\\T', 'mixed').status === 0, stableJson(stage.readValue('HKCU\\Software\\T', 'mixed')))
      check('读一个不存在的值 = ERROR_FILE_NOT_FOUND(2)', stage.readValue('HKCU\\Software\\T', 'nope').status === REG_STATUS.ERROR_FILE_NOT_FOUND, String(stage.readValue('HKCU\\Software\\T', 'nope').status))

      check('真实 hive 的写日志**仍为空**（只读了、没写）', real.log.writes.length === 0, `writes=${real.log.writes.length}`)
      check('真实 hive 内容逐字不变（前后序列化相同）', real.snapshotText() === beforeText, 'unchanged')

      checkThrows('DWORD 越界（>UINT32）时抛错，不静默截断', () => stage.stageSetValue('HKCU\\Software\\T', 'Bad', 'REG_DWORD', 2 ** 40), 'REG_SNAPSHOT_INVALID')
      checkThrows('写值到一个不存在的键 = ERROR_FILE_NOT_FOUND(2)（对齐 RegSetValueExW）', () => stage.stageSetValue('HKCU\\Software\\Nope', 'V', 'REG_SZ', 'x'), 'REG_STAGE_KEY_NOT_FOUND')
      checkThrows('删一个不存在的值 = ERROR_FILE_NOT_FOUND(2)', () => stage.stageDeleteValue('HKCU\\Software\\T', 'nope'), 'REG_STAGE_VALUE_NOT_FOUND')
      checkThrows('删一个不存在的键 = ERROR_FILE_NOT_FOUND(2)', () => stage.stageDeleteKey('HKCU\\Software\\Nope'), 'REG_STAGE_KEY_NOT_FOUND')
      check(
        '基线上的既有值仍可读（覆盖层是叠加，不是替换）',
        stage.readValue('HKCU\\Software\\T', 'Existing').value === 1,
        stableJson(stage.readValue('HKCU\\Software\\T', 'Existing')),
      )
    }

    section('S4. 覆盖视图语义：中间键 / delete-key 清空 / 子键增删')
    {
      const sessionDir = join(workRoot, 's4')
      const real = createFakeRegistry([['HKCU\\Software', 'Base', 'REG_SZ', 'kept']])
      const stage = createRegistryStage({ sessionDir, sessionId: 's4', reader: real.reader, writer: real.writer })
      stage.open()
      stage.stageCreateKey('HKCU\\Software\\A\\B\\C')

      const viewA = stage.snapshot('HKCU\\Software\\A')
      check('create-key 的中间键被隐式创建（HKCU\\Software\\A 存在）', viewA.exists === true, stableJson({ exists: viewA.exists }))
      check('中间键的子键列表含下一级 B', viewA.subKeys.includes('B'), stableJson(viewA.subKeys))
      const viewTop = stage.snapshot('HKCU\\Software')
      check('父键的子键列表出现新子键 A（subkey-added 的来源）', viewTop.subKeys.includes('A'), stableJson(viewTop.subKeys))
      check('父键自身的值不受影响（Base 仍在）', Object.keys(viewTop.values).includes('Base'), stableJson(Object.keys(viewTop.values)))
      check('枚举接口与视图一致', stableJson(stage.enumKeys('HKCU\\Software\\A').names) === stableJson(['B']), stableJson(stage.enumKeys('HKCU\\Software\\A')))
      check(
        'enumValues 带出 {name,type,data} 三元组（shim 的 RegEnumValueW 形状）',
        stage.enumValues('HKCU\\Software').values.some((entry) => entry.name === 'Base' && entry.type === 'REG_SZ'),
        stableJson(stage.enumValues('HKCU\\Software').values),
      )

      checkThrows(
        '删除仍有子键的键 = ERROR_KEY_HAS_CHILDREN(1020)（真实 RegDeleteKeyExW 同样拒绝，暂存不许假装删掉整棵子树）',
        () => stage.stageDeleteKey('HKCU\\Software\\A'),
        'REG_STAGE_KEY_HAS_CHILDREN',
      )
      const childErr = (() => {
        try {
          stage.stageDeleteKey('HKCU\\Software\\A')
          return undefined
        } catch (error) {
          return error
        }
      })()
      check('该错误带 LSTATUS 1020（不是笼统的 5）', childErr?.status === 1020 && REG_STATUS.ERROR_KEY_HAS_CHILDREN === 1020, stableJson({ status: childErr?.status }))

      stage.stageDeleteKey('HKCU\\Software\\A\\B\\C')
      stage.stageDeleteKey('HKCU\\Software\\A\\B')
      const afterDeleteB = stage.snapshot('HKCU\\Software\\A')
      check('删掉子键 B 后父键的子键列表里没有 B', !afterDeleteB.subKeys.includes('B'), stableJson(afterDeleteB.subKeys))

      // delete → create：真实语义是"空键"，基线里的值**不能**复活
      checkThrows('删除不存在的键抛 REG_STAGE_KEY_NOT_FOUND', () => stage.stageDeleteKey('HKCU\\Software\\T2'), 'REG_STAGE_KEY_NOT_FOUND')
      const real2 = createFakeRegistry([['HKCU\\Software\\T3', 'Old', 'REG_DWORD', 7]])
      const stage2 = createRegistryStage({ sessionDir: join(workRoot, 's4b'), sessionId: 's4b', reader: real2.reader, writer: real2.writer })
      stage2.open()
      stage2.stageDeleteKey('HKCU\\Software\\T3')
      stage2.stageCreateKey('HKCU\\Software\\T3')
      check(
        'delete-key 后 create-key 得到的是**空键**（基线里的 Old 不复活）',
        stage2.snapshot('HKCU\\Software\\T3').exists === true && Object.keys(stage2.snapshot('HKCU\\Software\\T3').values).length === 0,
        stableJson(stage2.snapshot('HKCU\\Software\\T3').values),
      )
      const deleteView = stage2.snapshot('HKCU\\Software\\T3\\Child\\Deep')
      check('被删除键的后代一律不存在', deleteView.exists === false, stableJson({ exists: deleteView.exists }))
      check('touched paths 覆盖祖先（父键的子键列表变化也要进 diff）', overlayTouchedPaths(stage2.getState()).includes('HKCU\\Software'), stableJson(overlayTouchedPaths(stage2.getState())))
      check('overlayView 的基线 root 不匹配时抛错（比较不同键毫无意义）', (() => {
        try {
          overlayView({ state: stage2.getState(), path: 'HKCU\\Software\\T3', baseline: normalizeSnapshot({ root: 'HKCU\\Other', exists: true }) })
          return false
        } catch (error) {
          return error.code === 'REG_STAGE_BASELINE_ROOT_MISMATCH'
        }
      })(), 'REG_STAGE_BASELINE_ROOT_MISMATCH')
    }

    section('S5. WAL：定长头偏移钉死 + 撕裂尾部 + 重放等价')
    {
      const O = REG_STAGE_RECORD_OFFSETS
      check(
        'WAL 头逐字段偏移与 docs 的 C 结构体一致（C 与 JS 不许漂移）',
        O.magic === 0 && O.version === 4 && O.kind === 6 && O.type === 8 && O.flags === 10 && O.pathChars === 12 && O.nameChars === 16 && O.dataBytes === 20 && O.status === 24 && O.reserved === 28 && O.total === 32,
        stableJson(O),
      )
      check('REG_STAGE_RECORD_SIZE = 32', REG_STAGE_RECORD_SIZE === 32, String(REG_STAGE_RECORD_SIZE))
      check('magic = 0x47525344（小端字节序是 44 53 52 47 = "DSRG"）', REG_STAGE_JOURNAL_MAGIC === 0x47525344, `0x${REG_STAGE_JOURNAL_MAGIC.toString(16)}`)

      const create = encodeJournalRecord({ kind: REG_STAGE_KIND.CREATE_KEY, path: 'HKCU\\A' })
      check('create-key 记录长度 = 32 头 + 12 负载（"HKCU\\A" 6 个 UTF-16 码元）', create.length === 44, String(create.length))
      check('头 4 字节 = DSRG', create.subarray(0, 4).toString('hex') === '44535247', create.subarray(0, 4).toString('hex'))
      check('version=1 / kind=1 / type=0 / flags=0（小端 uint16）', create.readUInt16LE(4) === 1 && create.readUInt16LE(6) === 1 && create.readUInt16LE(8) === 0 && create.readUInt16LE(10) === 0, `${create.readUInt16LE(4)}/${create.readUInt16LE(6)}`)
      check('pathChars = 6（UTF-16 码元数，不含 NUL）', create.readUInt32LE(12) === 6, String(create.readUInt32LE(12)))
      check('负载逐字节 = UTF-16LE 的 HKCU\\A', create.subarray(32).equals(Buffer.from('HKCU\\A', 'utf16le')), create.subarray(32).toString('hex'))
      check('reserved 恒为 0（保留字段不许被塞东西）', create.readUInt32LE(28) === 0, String(create.readUInt32LE(28)))

      const setRec = journalRecordForOperation({ op: 'set-value', path: 'HKLM\\X', valueName: 'V', type: 'REG_DWORD', value: 42 })
      const setBuf = encodeJournalRecord(setRec)
      const setDecoded = decodeJournalRecords(setBuf).records[0]
      check('set-value 记录的 type 字段是 winreg.h 数值（4 = REG_DWORD）', setDecoded.type === REG_TYPES.REG_DWORD, String(setDecoded.type))
      check('set-value 记录带 HAS_VALUE_NAME|HAS_DATA 标志', setDecoded.flags === (REG_STAGE_FLAGS.HAS_VALUE_NAME | REG_STAGE_FLAGS.HAS_DATA), String(setDecoded.flags))
      check('线格式字节 = DWORD 小端 2a 00 00 00（不是"文本当字节"）', setDecoded.wireBytes.toString('hex') === '2a000000', setDecoded.wireBytes.toString('hex'))
      check('宿主口径 data = 0x0000002a（与快照同口径）', setDecoded.data === '0x0000002a', String(setDecoded.data))
      check(
        '线格式 ↔ 快照口径互为往返（八种类型）',
        [
          ['REG_SZ', 'hi'],
          ['REG_MULTI_SZ', ['a']],
          ['REG_DWORD', 1],
          ['REG_DWORD_BIG_ENDIAN', 0x01020304],
          ['REG_QWORD', 7n],
          ['REG_BINARY', Buffer.from([1, 2])],
          ['REG_NONE', Buffer.alloc(0)],
          ['REG_EXPAND_SZ', '%x%'],
        ].every(([type, value]) => {
          const hex = encodeRegistryValue(type, value)
          return registryDataHex(type, registryWireBytes(type, hex)) === hex
        }),
        'all round-trip',
      )
      check('DWORD_BIG_ENDIAN 走大端字节序（01 02 03 04）', registryWireBytes('REG_DWORD_BIG_ENDIAN', '0x01020304').toString('hex') === '01020304', registryWireBytes('REG_DWORD_BIG_ENDIAN', '0x01020304').toString('hex'))
      check('QWORD 走小端 8 字节', registryWireBytes('REG_QWORD', '0x000000000000007b').toString('hex') === '7b00000000000000', registryWireBytes('REG_QWORD', '0x000000000000007b').toString('hex'))
      checkThrows('非十六进制文本被发现（不许静默截断成空字节）', () => registryWireBytes('REG_BINARY', 'hello'), 'REG_SNAPSHOT_INVALID')
      checkThrows('奇数长度十六进制被发现', () => registryWireBytes('REG_BINARY', 'abc'), 'REG_SNAPSHOT_INVALID')

      // 撕裂尾部：截掉最后 3 字节 → 前面完整记录保留，尾部的残缺被**报出来**
      const two = Buffer.concat([create, setBuf])
      const torn = decodeJournalRecords(two.subarray(0, two.length - 3))
      check('撕裂尾部：torn=true（"写了一半"必须与"没发生"区分开）', torn.torn === true && torn.bytesConsumed === 44, stableJson({ torn: torn.torn, consumed: torn.bytesConsumed }))
      check('撕裂尾部：完整的记录前缀仍然可用（WAL 的前缀语义）', torn.records.length === 1 && torn.records[0].kind === REG_STAGE_KIND.CREATE_KEY, stableJson(torn.records.map((record) => record.kind)))
      check('撕裂尾部：报告未消费字节数（可用于定位/截断修复）', torn.trailingBytes === two.length - 3 - 44 && torn.trailingBytes > 0, `${torn.trailingBytes} vs ${two.length - 3 - 44}`)
      check('不足一个定长头的尾巴也判 torn，且 trailingBytes 精确', (() => {
        const tail = decodeJournalRecords(Buffer.concat([create, Buffer.from([7, 7, 7])]))
        return tail.torn === true && tail.trailingBytes === 3 && tail.bytesConsumed === 44
      })(), '3 bytes')
      check('空 Buffer = 零记录且不 torn（日志文件刚建、还没写）', decodeJournalRecords(Buffer.alloc(0)).records.length === 0 && decodeJournalRecords(Buffer.alloc(0)).torn === false, '0 records')

      const badMagic = Buffer.from(create)
      badMagic.writeUInt32LE(0xdeadbeef, 0)
      checkThrows('magic 坏了 → REG_STAGE_JOURNAL_CORRUPT（不猜内容）', () => decodeJournalRecords(badMagic), 'REG_STAGE_JOURNAL_CORRUPT')
      const badKind = Buffer.from(create)
      badKind.writeUInt16LE(99, 6)
      checkThrows('kind 未知 → REG_STAGE_JOURNAL_CORRUPT', () => decodeJournalRecords(badKind), 'REG_STAGE_JOURNAL_CORRUPT')
      const badVersion = Buffer.from(create)
      badVersion.writeUInt16LE(9, 4)
      checkThrows('version 不匹配 → REG_STAGE_JOURNAL_VERSION', () => decodeJournalRecords(badVersion), 'REG_STAGE_JOURNAL_VERSION')

      // 硬拒记录：把"哪些调用仍然是硬拒"变成可审计数据
      const denyBuf = encodeJournalRecord(journalHardDenyRecord({ api: 'RegSetKeySecurity', path: 'HKLM\\X', status: 5, reason: 'SD 不可暂存' }))
      const denyDecoded = decodeJournalRecords(denyBuf).records[0]
      check('硬拒记录保留原始 LSTATUS 与 HARD_DENY 标志', denyDecoded.kind === REG_STAGE_KIND.HARD_DENY && denyDecoded.status === 5 && (denyDecoded.flags & REG_STAGE_FLAGS.HARD_DENY) !== 0, stableJson({ kind: denyDecoded.kind, status: denyDecoded.status }))
      check('硬拒记录可以不携带数据（data 长度 0）', denyDecoded.wireBytes.length === 0 && denyDecoded.data === null, String(denyDecoded.wireBytes.length))
      const denyNoPath = journalHardDenyRecord({ api: 'NtSetValueKey' })
      check('连"路径都拿不到"的硬拒也能被记录（占位名，不进歧义）', /unknown/.test(denyNoPath.path) && encodeJournalRecord(denyNoPath).length > 0, denyNoPath.path)

      // 重放等价：WAL → 状态 == 直接 applyOverlayOperation 的状态
      const direct = [
        { op: 'create-key', path: 'HKCU\\W\\X' },
        { op: 'set-value', path: 'HKCU\\W\\X', valueName: 'V', type: 'REG_SZ', value: 'v' },
        { op: 'delete-value', path: 'HKCU\\W\\X', valueName: 'V' },
        { op: 'set-value', path: 'HKCU\\W\\X', valueName: 'W', type: 'REG_DWORD', value: 5 },
      ]
      let directState = createOverlayState({})
      for (const operation of direct) directState = applyOverlayOperation(directState, operation)
      const journalBytes = Buffer.concat(direct.map((operation) => encodeJournalRecord(journalRecordForOperation(operation))))
      const replayed = replayJournal(decodeJournalRecords(journalBytes).records)
      check(
        'WAL 重放得到与直接操作**完全相同**的状态（JSON 逐字相同）',
        stableJson(replayed.state.ops) === stableJson(directState.ops),
        `${replayed.state.ops.length} vs ${directState.ops.length} ops`,
      )
      check('重放结果没有 rejected（记录形状合法）', replayed.rejected.length === 0, stableJson(replayed.rejected))
      const replayWithDeny = replayJournal(decodeJournalRecords(Buffer.concat([journalBytes, denyBuf])).records)
      check('重放把硬拒记录收进 hardDenied（不进状态、不静默丢弃）', replayWithDeny.hardDenied.length === 1 && stableJson(replayWithDeny.state.ops) === stableJson(replayed.state.ops), stableJson(replayWithDeny.hardDenied))

      const journalPath = join(workRoot, 's5', 'registry', 'overlay.journal')
      const written = writeRegistryJournal(journalPath, [journalRecordForOperation(direct[0]), journalRecordForOperation(direct[1])])
      const readBack = readRegistryJournal(journalPath)
      check('writeRegistryJournal → readRegistryJournal 往返（文件级）', written.records === 2 && readBack.records.length === 2 && readBack.torn === false, stableJson({ written, records: readBack.records.length }))
      check('readRegistryJournal 对不存在的文件返回 missing=true（不是抛错）', readRegistryJournal(join(workRoot, 's5', 'nope.journal')).missing === true, 'missing')
    }

    section('S6. 差异 + 候选：与文件候选同构，且未应用时真实 hive 不变')
    {
      const sessionDir = join(workRoot, 's6')
      const real = createFakeRegistry([
        ['HKCU\\Software\\App', 'Keep', 'REG_SZ', 'same'],
        ['HKCU\\Software\\App', 'Changed', 'REG_SZ', 'old'],
      ])
      const stage = createRegistryStage({ sessionDir, sessionId: 's6', reader: real.reader, writer: real.writer })
      stage.open()
      const beforeText = real.snapshotText()
      stage.stageCreateKey('HKCU\\Software\\App\\Sub')
      stage.stageSetValue('HKCU\\Software\\App', 'Changed', 'REG_SZ', 'new')
      stage.stageSetValue('HKCU\\Software\\App', 'Added', 'REG_DWORD', 7)

      const diff = stage.diff()
      const kinds = diff.changes.map((change) => `${change.kind}:${change.valueName ?? change.key}`)
      check('检出 subkey-added', diff.changes.some((change) => change.kind === 'subkey-added' && change.key.endsWith('Sub')), kinds.join(' '))
      check('检出 value-changed（data 维度）', diff.changes.some((change) => change.kind === 'value-changed' && change.valueName === 'Changed'), kinds.join(' '))
      check('检出 value-added', diff.changes.some((change) => change.kind === 'value-added' && change.valueName === 'Added'), kinds.join(' '))
      check('未变化的 Keep 不进差异（不产生噪音）', !diff.changes.some((change) => change.valueName === 'Keep'), kinds.join(' '))
      check('差异带 registryPath（用于回滚计划与候选单元）', diff.changes.every((change) => typeof change.registryPath === 'string'), 'all')
      check('每个 root 都带 planRollback（不可逆项如实统计）', Object.values(diff.roots).every((root) => root.rollback && Array.isArray(root.rollback.operations)), 'all roots')

      const units = overlayChangesToCandidateChanges(diff)
      check(
        '变更单元与文件候选同构（kind=registry / external / path / op / before / after / frozen）',
        units.every((unit) => unit.kind === 'registry' && unit.external === true && unit.frozen === true && typeof unit.path === 'string' && typeof unit.op === 'string' && 'before' in unit && 'after' in unit),
        stableJson(units[0]),
      )
      check('值单元路径 = key\\name（可被 --paths 选择性应用）', units.some((unit) => unit.path === 'HKCU\\Software\\App\\Changed' && unit.valueName === 'Changed'), stableJson(units.map((unit) => unit.path)))
      check('键单元 op = mkdir（与文件候选的 mkdir 同一词汇）', units.some((unit) => unit.path === 'HKCU\\Software\\App\\Sub' && unit.op === 'mkdir'), stableJson(units.map((unit) => `${unit.op}:${unit.path}`)))
      check('summary 计数与变更单元一致', (() => {
        const summary = summarizeRegistryChanges(units)
        return summary.files === units.length && Object.values(summary.byOp).reduce((a, b) => a + b, 0) === units.length
      })(), stableJson(summarizeRegistryChanges(units)))

      const frozen = stage.freezeCandidate()
      check('冻结产生候选且入队', frozen.enqueued === true && typeof frozen.candidate.id === 'string', frozen.candidate?.id)
      check(
        '候选顶层字段与文件候选同构（version/id/createdAt/sessionId/status/changes/hostOperations/summary）',
        ['version', 'id', 'createdAt', 'sessionId', 'status', 'changes', 'hostOperations', 'summary'].every((key) => key in frozen.candidate) && frozen.candidate.status === 'pending',
        Object.keys(frozen.candidate).join(','),
      )
      check('候选带 origin=registry（面板据此区分来源，而不是靠猜 id 前缀）', frozen.candidate.origin === 'registry' && frozen.candidate.source === 'registry-stage', `${frozen.candidate.origin}/${frozen.candidate.source}`)
      check('候选落盘在同一个 candidates/ 目录（与文件候选共用审批存储）', readFileSync(join(sessionDir, 'candidates', `${frozen.candidate.id}.json`), 'utf8').includes(frozen.candidate.id), frozen.candidate.id)
      const queue = JSON.parse(readFileSync(join(sessionDir, 'queue.json'), 'utf8'))
      check('queue.json 登记了候选（面板的待审列表来自 queue.order）', queue.version === 1 && queue.order.includes(frozen.candidate.id) && queue.candidates[frozen.candidate.id].status === 'pending', stableJson(queue.order))
      check('队列条目 files 计数 = 候选变更单元数', queue.candidates[frozen.candidate.id].files === frozen.candidate.changes.length, String(queue.candidates[frozen.candidate.id].files))
      check('候选冻结了 before 侧（baselines 里有序列化快照）', Object.keys(frozen.candidate.baselines).length > 0 && Object.values(frozen.candidate.baselines).every((text) => typeof text === 'string' && text.includes('"values"')), Object.keys(frozen.candidate.baselines).join(','))

      check('**未应用**：真实 hive 写日志为空', real.log.writes.length === 0, `writes=${real.log.writes.length}`)
      check('**未应用**：真实 hive 内容逐字不变', real.snapshotText() === beforeText, 'unchanged')
      check('**丢弃前**覆盖层仍看得到暂存值（写成功是真的）', stage.readValue('HKCU\\Software\\App', 'Changed').value === 'new', stableJson(stage.readValue('HKCU\\Software\\App', 'Changed')))

      // 第二次冻结：同一会话、同一路径 → 旧候选被取代（与 workspace.freezeCandidate 同口径）
      stage.stageSetValue('HKCU\\Software\\App', 'Changed', 'REG_SZ', 'newer')
      const second = stage.freezeCandidate()
      const queue2 = JSON.parse(readFileSync(join(sessionDir, 'queue.json'), 'utf8'))
      check('同一会话同路径的新候选取代旧待审（superseded）', second.candidate.id !== frozen.candidate.id && queue2.candidates[frozen.candidate.id].status === 'superseded' && queue2.supersededBy[frozen.candidate.id] === second.candidate.id, stableJson(queue2.supersededBy))
      check('无净变化时**不**入队（no-net-change）', (() => {
        const fresh = createRegistryStage({ sessionDir: join(workRoot, 's6-empty'), sessionId: 's6e', reader: real.reader, writer: real.writer })
        fresh.open()
        const result = fresh.freezeCandidate()
        return result.enqueued === false && result.reason === 'no-net-change' && result.changes.length === 0
      })(), 'no-net-change')
    }

    section('S7. 选择性应用：只动选中路径；无 writer 不许假装成功；stale / 失败如实上报')
    {
      const sessionDir = join(workRoot, 's7')
      const seed = [['HKCU\\Software\\App', 'A', 'REG_SZ', 'a0']]
      const real = createFakeRegistry(seed)
      const stage = createRegistryStage({ sessionDir, sessionId: 's7', reader: real.reader, writer: real.writer })
      stage.open()

      // 7a：没有 writer 时必须抛错，且一个字节都不写
      const noWriter = createRegistryStage({ sessionDir: join(workRoot, 's7-nowriter'), sessionId: 's7n', reader: real.reader })
      noWriter.open()
      noWriter.stageSetValue('HKCU\\Software\\App', 'A', 'REG_SZ', 'a1')
      const writerlessErr = (() => {
        try {
          noWriter.apply()
          return undefined
        } catch (error) {
          return error
        }
      })()
      check('没有 writer 时 apply() 抛 REG_WRITER_MISSING（绝不假装应用成功）', writerlessErr?.code === 'REG_WRITER_MISSING', writerlessErr?.code)
      check('没有 writer 时真实 hive 写日志为空', real.log.writes.length === 0, `writes=${real.log.writes.length}`)

      // 7b：选择性应用
      stage.stageSetValue('HKCU\\Software\\App', 'A', 'REG_SZ', 'a1')
      stage.stageSetValue('HKCU\\Software\\App', 'B', 'REG_DWORD', 2)
      const frozen = stage.freezeCandidate()
      const result = stage.apply({ paths: ['HKCU\\Software\\App\\B'] })
      check('只应用选中的路径（A 未被写）', result.applied.length === 1 && result.applied[0].path === 'HKCU\\Software\\App\\B', stableJson(result.applied))
      check('未选中的单元标 not-selected（不静默丢掉）', result.skipped.some((unit) => unit.path === 'HKCU\\Software\\App\\A' && unit.reason === 'not-selected'), stableJson(result.skipped))
      check('部分应用后的状态 = partially-applied', result.status === 'partially-applied' && stage.getResolution().status === 'partially-applied', result.status)
      check('真实 hive 只被选中的值改动（B=2，A 仍是 a0）', real.keys.get('hkcu\\software\\app').values.get('b')?.data === 2 && real.keys.get('hkcu\\software\\app').values.get('a')?.data === 'a0', stableJson([...real.keys.get('hkcu\\software\\app').values.entries()]))
      check('未选中的单元仍在覆盖层（可以稍后再应用）', stage.readValue('HKCU\\Software\\App', 'A').value === 'a1', stableJson(stage.readValue('HKCU\\Software\\App', 'A')))
      const rest = stage.apply({ paths: ['HKCU\\Software\\App\\A'] })
      check('再次 apply 补齐后状态 = applied', rest.status === 'applied' && real.keys.get('hkcu\\software\\app').values.get('a')?.data === 'a1', rest.status)

      // 7c：陈旧性 —— 冻结之后真实 hive 被"别的程序"改了
      const staleDir = join(workRoot, 's7-stale')
      const staleReal = createFakeRegistry(seed)
      const staleStage = createRegistryStage({ sessionDir: staleDir, sessionId: 's7s', reader: staleReal.reader, writer: staleReal.writer })
      staleStage.open()
      staleStage.stageSetValue('HKCU\\Software\\App', 'A', 'REG_SZ', 'a1')
      staleStage.freezeCandidate()
      staleReal.mutate('HKCU\\Software\\App', 'A', 'REG_SZ', 'someone-else')
      const staleResult = staleStage.apply()
      check('冻结后真实 hive 变了 ⇒ 该单元标 stale 且**不写**（候选的 before 已失效）', staleResult.stale.length === 1 && staleResult.applied.length === 0, stableJson(staleResult))
      check('stale 时真实值保持"别人写的那个"（没有被我们的旧候选覆盖）', staleReal.keys.get('hkcu\\software\\app').values.get('a')?.data === 'someone-else', stableJson(staleReal.keys.get('hkcu\\software\\app').values.get('a')))
      check('stale 后状态 = stale', staleStage.getResolution().status === 'stale', staleStage.getResolution().status)
      const forced = staleStage.apply({ force: true })
      check('force:true 才允许覆盖（显式选择，而不是默认行为）', forced.applied.length === 1 && staleReal.keys.get('hkcu\\software\\app').values.get('a')?.data === 'a1', stableJson(forced.applied))

      // 7d：writer 返回非 0 LSTATUS ⇒ failed（不吞错、不当作成功）
      const failDir = join(workRoot, 's7-fail')
      const failReal = createFakeRegistry(seed)
      const failingWriter = {
        ...failReal.writer,
        setValue: () => ({ status: REG_STATUS.ERROR_ACCESS_DENIED }),
      }
      const failStage = createRegistryStage({ sessionDir: failDir, sessionId: 's7f', reader: failReal.reader, writer: failingWriter })
      failStage.open()
      failStage.stageSetValue('HKCU\\Software\\App', 'A', 'REG_SZ', 'a1')
      failStage.freezeCandidate()
      const failResult = failStage.apply()
      check('writer 返回 5 ⇒ failed 且带原始 LSTATUS（旧沙箱硬拒的真实形态被如实保留）', failResult.failed.length === 1 && failResult.failed[0].status === REG_STATUS.ERROR_ACCESS_DENIED && failResult.applied.length === 0, stableJson(failResult.failed))
      check('失败时不产生 appliedPaths（状态不许谎报）', !failStage.getResolution().appliedPaths.includes('HKCU\\Software\\App\\A'), stableJson(failStage.getResolution().appliedPaths))

      // 7e：写适配器的调用形状（T4/宿主接线用）
      const calls = []
      const bindings = {
        regCreateKeyExW: (handle, subKey, reserved, cls, options, sam) => {
          calls.push(['createKeyExW', handle, subKey, options, sam])
          return { status: 0, handle: 0x55n }
        },
        regOpenKeyExW: (handle, subKey, options, sam) => {
          calls.push(['openKeyExW', handle, subKey, sam])
          return { status: 0, handle: 0x66n }
        },
        regSetValueExW: (handle, name, reserved, type, data) => {
          calls.push(['setValueExW', handle, name, type, data.toString('hex')])
          return { status: 0 }
        },
        regDeleteValueW: (handle, name) => {
          calls.push(['deleteValueW', handle, name])
          return { status: 0 }
        },
        regDeleteKeyExW: (handle, subKey, sam, reserved) => {
          calls.push(['deleteKeyExW', handle, subKey, sam])
          return { status: 0 }
        },
        regCloseKey: (handle) => calls.push(['closeKey', handle]),
      }
      const writer = createRegistryWriter(bindings)
      check('createRegistryWriter 缺绑定时抛 REG_BINDINGS_MISSING', (() => {
        try {
          createRegistryWriter({})
          return false
        } catch (error) {
          return error.code === 'REG_BINDINGS_MISSING'
        }
      })(), 'REG_BINDINGS_MISSING')
      writer.setValue('HKLM\\SOFTWARE\\App', 'V', 'REG_DWORD', '0x0000002a')
      check('setValue 打开后写 KEY_SET_VALUE 并关闭句柄', calls.some((call) => call[0] === 'openKeyExW' && (call[3] & 0x0002) !== 0) && calls.some((call) => call[0] === 'closeKey'), stableJson(calls.map((call) => call[0])))
      check('setValue 传的是 REG_DWORD 的数值 4 与 4 字节小端数据', calls.some((call) => call[0] === 'setValueExW' && call[3] === REG_TYPES.REG_DWORD && call[4] === '2a000000'), stableJson(calls.find((call) => call[0] === 'setValueExW')))
      calls.length = 0
      writer.deleteKey('HKLM\\SOFTWARE\\App\\V')
      check('deleteKey 传的是**父键句柄 + 子键名**（用自身句柄会把父键删掉）', calls.some((call) => call[0] === 'deleteKeyExW' && call[2] === 'SOFTWARE\\App\\V'), stableJson(calls))
      calls.length = 0
      const failedWriter = createRegistryWriter({ ...bindings, regSetValueExW: () => ({ status: REG_STATUS.ERROR_ACCESS_DENIED }) })
      check('写适配器如实返回非 0 LSTATUS（绝不吞掉）', failedWriter.setValue('HKLM\\X', 'V', 'REG_SZ', encodeRegistryValue('REG_SZ', 'x')).status === REG_STATUS.ERROR_ACCESS_DENIED, 'status=5')
      calls.length = 0
      writer.createKey('HKLM\\X', { dwOptions: REG_OPTIONS.REG_OPTION_VOLATILE })
      check('createKey 把 dwOptions 原样传给 RegCreateKeyExW（volatile 不能被吞）', calls.some((call) => call[0] === 'createKeyExW' && call[3] === REG_OPTIONS.REG_OPTION_VOLATILE), stableJson(calls))

      // 7f：volatile 必须从 WAL 一路走到真实调用（否则文档里"应用时保留 volatile"就是空话）
      const volDir = join(workRoot, 's7-volatile')
      const volReal = createFakeRegistry([])
      const volCalls = []
      const volWriter = {
        createKey: (path, opts) => {
          volCalls.push([path, opts?.dwOptions])
          return { status: 0 }
        },
        setValue: () => ({ status: 0 }),
        deleteValue: () => ({ status: 0 }),
        deleteKey: () => ({ status: 0 }),
      }
      const volStage = createRegistryStage({ sessionDir: volDir, sessionId: 's7v', reader: volReal.reader, writer: volWriter })
      volStage.open()
      volStage.stageCreateKey('HKLM\\SOFTWARE\\Vol', { dwOptions: REG_OPTIONS.REG_OPTION_VOLATILE })
      const volOps = volStage.getState().ops
      check('WAL/状态里记下 volatile（目标键 true、中间键 false）', volOps.some((op) => op.path === 'HKLM\\SOFTWARE\\Vol' && op.volatile === true) && volOps.filter((op) => op.volatile === true).length === 1, stableJson(volOps.map((op) => [op.path, op.volatile])))
      volStage.freezeCandidate()
      volStage.apply()
      check('apply 时把 REG_OPTION_VOLATILE(0x1) 传给真实写入器', volCalls.some(([path, options]) => path === 'HKLM\\SOFTWARE\\Vol' && options === REG_OPTIONS.REG_OPTION_VOLATILE), stableJson(volCalls))
      const volJournal = readRegistryJournal(resolveRegistryStageJournalPath(volDir))
      const volRecord = volJournal.records.find((record) => record.path === 'HKLM\\SOFTWARE\\Vol' && record.kind === REG_STAGE_KIND.CREATE_KEY)
      check('落盘的 WAL 记录带 VOLATILE 标志（C 侧读同一位也是如此）', (volRecord?.flags & REG_STAGE_FLAGS.VOLATILE) !== 0, stableJson(volRecord?.flags))
    }

    section('S8. 丢弃：真实 hive 不变、覆盖层清空、WAL 留审计副本、丢弃后不许 apply')
    {
      const sessionDir = join(workRoot, 's8')
      const real = createFakeRegistry([['HKCU\\Software\\App', 'A', 'REG_SZ', 'a0']])
      const stage = createRegistryStage({ sessionDir, sessionId: 's8', reader: real.reader, writer: real.writer })
      stage.open()
      const beforeText = real.snapshotText()
      stage.stageSetValue('HKCU\\Software\\App', 'A', 'REG_SZ', 'a1')
      stage.freezeCandidate()

      // 覆盖创建 hive 文件（模拟 shim 已经用 RegLoadAppKeyW 把它建出来）
      writeFileSync(stage.hivePath, Buffer.from('not-a-real-hive-but-a-placeholder'))
      const discarded = stage.discard({ reason: 'test-discard' })
      check('丢弃后 hive 文件被删（覆盖层不许留着被误加载）', discarded.hiveRemoved === true && discarded.auditPath !== null, stableJson(discarded))
      check('丢弃后 WAL 改名保留为审计副本（审计轨迹不销毁）', readFileSync(resolveRegistryStageDiscardedPath(sessionDir), 'utf8').length > 0, 'audit kept')
      check('丢弃后真实 hive 内容逐字不变', real.snapshotText() === beforeText, 'unchanged')
      check('丢弃后再 apply 抛 REG_CANDIDATE_DISCARDED（不是静默成功）', (() => {
        try {
          stage.apply()
          return false
        } catch (error) {
          return error.code === 'REG_CANDIDATE_DISCARDED'
        }
      })(), 'REG_CANDIDATE_DISCARDED')
      const queueAfter = JSON.parse(readFileSync(join(sessionDir, 'queue.json'), 'utf8'))
      check('丢弃反映到 queue.json（面板看到 discarded 而不是永远 pending）', queueAfter.candidates[stage.getResolution().candidateId].status === 'discarded' && queueAfter.discarded.length === 1, stableJson(queueAfter.discarded))
    }

    section('S9. 诚实边界：基线读不到 ⇒ 不冻结候选、不许猜"打开还是创建"；无 reader ⇒ 不许 diff')
    {
      const sessionDir = join(workRoot, 's9')
      const deniedReader = { read: () => ({ exists: true, accessDenied: true, errorCode: REG_STATUS.ERROR_ACCESS_DENIED }) }
      const stage = createRegistryStage({ sessionDir, sessionId: 's9', reader: deniedReader, writer: null })
      stage.open()
      // 用**直接写 WAL** 的方式构造状态：这同时证明了"宿主能容忍一份由别人写出的 journal"，
      // 而不是只能在它自己调用 stage* 的情况下工作。
      writeRegistryJournal(resolveRegistryStageJournalPath(sessionDir), [
        journalRecordForOperation({ op: 'create-key', path: 'HKLM\\SOFTWARE\\Denied' }),
        journalRecordForOperation({ op: 'set-value', path: 'HKLM\\SOFTWARE\\Denied', valueName: 'V', type: 'REG_SZ', value: 'ours' }),
      ])
      const reopened = createRegistryStage({ sessionDir, sessionId: 's9', reader: deniedReader, writer: null })
      reopened.open()
      const diff = reopened.diff()
      check('基线被拒 ⇒ 该路径进 unreadable，且**不产出**差异（不把"读不到"说成"里面没东西"）', diff.unreadable.includes('HKLM\\SOFTWARE\\Denied') && diff.totalChanges === 0, stableJson({ unreadable: diff.unreadable, total: diff.totalChanges }))
      const frozen = reopened.freezeCandidate()
      check('基线被拒 ⇒ 冻结被拒（no-freezable-change），并带 warning 解释原因', frozen.enqueued === false && frozen.reason === 'no-freezable-change' && frozen.warnings.some((line) => /ERROR_ACCESS_DENIED/.test(line)), frozen.reason)
      check('读值语义：基线被拒且未暂存过该值 ⇒ ERROR_ACCESS_DENIED(5)', reopened.readValue('HKLM\\SOFTWARE\\Denied', 'V2').status === REG_STATUS.ERROR_ACCESS_DENIED, String(reopened.readValue('HKLM\\SOFTWARE\\Denied', 'V2').status))
      check('读值语义：基线被拒**但本会话写过** ⇒ 仍能读回自己写的那一个值', reopened.readValue('HKLM\\SOFTWARE\\Denied', 'V').value === 'ours', stableJson(reopened.readValue('HKLM\\SOFTWARE\\Denied', 'V')))
      checkThrows('没有 reader 时 diff 抛 REG_READER_MISSING（拒绝用"假定为空"的基线做差异）', () => diffOverlay({ state: reopened.getState(), baselineFor: undefined }), 'REG_READER_MISSING')
      // 净变化闸门要求"打开 vs 创建"可判定；基线读不到时必须**失败**，不许猜
      // （猜"创建"⇒ 造出空壳键（本次阻塞级缺陷）；猜"打开"⇒ 静默丢掉一次真实写入）
      const netGate = (() => {
        try {
          reopened.stageCreateKey('HKLM\\SOFTWARE\\Denied2')
          return undefined
        } catch (error) {
          return error
        }
      })()
      check(
        '基线读不到 ⇒ stageCreateKey 抛 REG_BASELINE_UNREADABLE（fail-closed：不许猜"打开还是创建"）',
        netGate?.code === 'REG_BASELINE_UNREADABLE' && netGate?.status === REG_STATUS.ERROR_ACCESS_DENIED,
        stableJson({ code: netGate?.code, status: netGate?.status }),
      )
    }

    section('S11. 枚举必须合并 + 净变化闸门（`[实测]` 阻塞级缺陷：空壳键遮蔽真实子键）')
    {
      // 场景复刻：真实 hive 的 HKCU\Software 下有大量子键（.NET 证书存储的形状），
      // 覆盖层只因为"打开或创建"而多了一个空壳键。枚举**必须**返回并集。
      const realSubKeys = ['Classes', 'Microsoft', 'Policies', 'WOW6432Node', 'RegisteredApplications']
      const real = createFakeRegistry([['HKCU\\Software', 'RealValue', 'REG_SZ', 'keep']])
      for (const name of realSubKeys) real.keys.set(`hkcu\\software\\${name.toLowerCase()}`, { path: `HKCU\\Software\\${name}`, values: new Map() })
      const sessionDir = join(workRoot, 's11')
      const stage = createRegistryStage({ sessionDir, sessionId: 's11', reader: real.reader, writer: real.writer })
      stage.open()
      const baselineUnion = new Set([...realSubKeys.map((name) => name.toLowerCase()), 'microsoft\\systemcertificates'])

      // ① 只读打开一个**真实已存在**的键 ⇒ 覆盖层零新增条目、候选零文件
      const opsBefore = stage.getState().ops.length
      const readOnly = stage.stageCreateKey('HKCU\\Software\\Microsoft')
      check(
        '① 只读打开真实已存在的键 ⇒ 净变化为零：不写 WAL、不进覆盖层（net=false）',
        readOnly.net === false && readOnly.bytes === 0 && stage.getState().ops.length === opsBefore,
        stableJson({ net: readOnly.net, bytes: readOnly.bytes, reason: readOnly.reason }),
      )
      const frozenEmpty = stage.freezeCandidate()
      check('① 候选零文件（幻影条目不得入候选）', frozenEmpty.enqueued === false && frozenEmpty.reason === 'no-net-change', stableJson({ enqueued: frozenEmpty.enqueued, reason: frozenEmpty.reason }))

      // ② 覆盖层出现空壳（真实里不存在的新键）+ 真实有大量子键 ⇒ 枚举必须是并集
      stage.stageCreateKey('HKCU\\Software\\Microsoft\\SystemCertificates')
      stage.stageCreateKey('HKCU\\Software\\Microsoft\\SystemCertificates\\CA')
      const newChild = 'WinStageShell'
      stage.stageCreateKey(`HKCU\\Software\\${newChild}`)
      const merged = stage.enumKeys('HKCU\\Software')
      const mergedLower = merged.names.map((name) => name.toLowerCase())
      check(
        '② 枚举是并集：真实的 5 个子键**一个不少**（这正是 PowerShell 起不来的那条）',
        realSubKeys.every((name) => mergedLower.includes(name.toLowerCase())),
        `names=[${merged.names.join(',')}]`,
      )
      check('② 覆盖层新增的直接子键也在并集里', mergedLower.includes(newChild.toLowerCase()), `names=[${merged.names.join(',')}]`)
      check(
        '② 并集不重复（大小写不敏感）且按名字排序（index→name 在多次调用间稳定）',
        new Set(mergedLower).size === merged.names.length &&
          stableJson(merged.names) === stableJson([...merged.names].sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))),
        `names=[${merged.names.join(',')}]`,
      )
      check('② 键自身的真实值仍在（合并不能把值也遮掉）', Object.keys(stage.snapshot('HKCU\\Software').values).includes('RealValue'), stableJson(Object.keys(stage.snapshot('HKCU\\Software').values)))
      check('② 未受影响的叶子键继续看到真实内容（覆盖层没有条目时不得凭空造空壳）', stage.snapshot('HKCU\\Software\\Policies').exists === true, `exists=${stage.snapshot('HKCU\\Software\\Policies').exists}`)
      check(
        '② 深层 create-key 只产生**新增层级**（真实已存在的层级不得留下空壳条目）',
        stage.getState().ops.every((op) => op.path !== 'HKCU\\Software' && op.path !== 'HKCU\\Software\\Microsoft'),
        stableJson(stage.getState().ops.map((op) => op.path)),
      )

      // ③ 覆盖层删除某键后 ⇒ 该名从并集里剔除（白障）
      stage.stageDeleteKey('HKCU\\Software\\Policies')
      const afterDelete = stage.enumKeys('HKCU\\Software').names.map((name) => name.toLowerCase())
      check('③ 覆盖层删除的键必须从并集里剔除（白障语义）', !afterDelete.includes('policies') && realSubKeys.filter((n) => n !== 'Policies').every((name) => afterDelete.includes(name.toLowerCase())), `names=[${afterDelete.join(',')}]`)

      // ④ 值枚举同样合并 + 白障（用独立会话，避免基线缓存掩盖"真实侧新增"这件事）
      const valuesDir = join(workRoot, 's11-values')
      const realValues = createFakeRegistry([
        ['HKCU\\Software', 'RealValue', 'REG_SZ', 'keep'],
        ['HKCU\\Software', 'Other', 'REG_DWORD', 9],
      ])
      const valuesStage = createRegistryStage({ sessionDir: valuesDir, sessionId: 's11v', reader: realValues.reader, writer: realValues.writer })
      valuesStage.open()
      valuesStage.stageSetValue('HKCU\\Software', 'Mine', 'REG_DWORD', 1)
      const values = valuesStage.enumValues('HKCU\\Software').values.map((entry) => entry.name)
      check('④ 值枚举也是并集（真实 Other + 覆盖层 Mine），且真实值一个不少', values.includes('Other') && values.includes('Mine') && values.includes('RealValue'), `values=[${values.join(',')}]`)
      valuesStage.stageDeleteValue('HKCU\\Software', 'Other')
      const valuesAfter = valuesStage.enumValues('HKCU\\Software').values.map((entry) => entry.name)
      check('④ 覆盖层删除的值必须从并集里剔除', !valuesAfter.includes('Other') && valuesAfter.includes('Mine'), `values=[${valuesAfter.join(',')}]`)

      // ⑤ 变异体自证：把"并集"退化成"只返回覆盖层" ⇒ 上述并集断言必须变红
      const beforeMutant = stage.enumKeys('HKCU\\Software').names
      __internal.enumerationMerge = false
      let mutantNames
      try {
        mutantNames = stage.enumKeys('HKCU\\Software').names
      } finally {
        __internal.enumerationMerge = true
      }
      const mutantLower = mutantNames.map((name) => name.toLowerCase())
      check(
        '⑤ 变异体自证：关掉合并后真实的子键全部消失（⇒ ②的断言真的有判定力，这就是本次阻塞级缺陷）',
        realSubKeys.filter((name) => name.toLowerCase() !== 'policies').every((name) => !mutantLower.includes(name.toLowerCase())) && mutantLower.length > 0,
        `mutant=[${mutantNames.join(',')}]`,
      )
      check('⑤ 关闭合并的开关是对称的：恢复后并集立刻回来', stableJson(stage.enumKeys('HKCU\\Software').names) === stableJson(beforeMutant), `names=[${stage.enumKeys('HKCU\\Software').names.join(',')}]`)

      // ⑥ 净变化引擎本身的判定（基线用**归一化快照**，与生产路径一致）
      const netReal = createFakeRegistry([['HKCU\\Software\\Exists', 'V', 'REG_DWORD', 1]])
      netReal.keys.set('hkcu\\software', { path: 'HKCU\\Software', values: new Map() })
      const netBaseline = (path) => normalizeSnapshot({ root: path, ...netReal.reader.read(path) })
      let netState = createOverlayState({})
      for (const operation of [
        { op: 'set-value', path: 'HKCU\\Software\\Exists', valueName: 'V', type: 'REG_DWORD', value: 1 },
        { op: 'set-value', path: 'HKCU\\Software\\Exists', valueName: 'V', type: 'REG_DWORD', value: 2 },
        { op: 'delete-value', path: 'HKCU\\Software\\Exists', valueName: 'Missing' },
        { op: 'delete-value', path: 'HKCU\\Software\\Exists', valueName: 'V' },
        { op: 'create-key', path: 'HKCU\\Software\\Exists\\Child' },
      ]) netState = applyOverlayOperation(netState, operation)
      const verdict = classifyOverlayNetEffect({ state: netState, baselineFor: netBaseline })
      const effects = verdict.operations.map((entry) => `${entry.effect}:${entry.op}:${entry.path}${entry.valueName ? '\\' + entry.valueName : ''}`)
      check(
        '⑥ 净变化引擎：同值 set-value / 缺失值 delete-value / 已存在键的 create-key 全判 no-op',
        verdict.summary.noop === 3 && verdict.summary.unknown === 0,
        stableJson({ summary: verdict.summary, effects }),
      )
      check(
        '⑥ 净变化引擎：真变化（改值 / 删值 / 新建子键）判 net，共 3 条',
        verdict.summary.net === 3 && verdict.summary.total === 6,
        stableJson({ summary: verdict.summary, effects }),
      )
      check(
        '⑥ "打开或创建"的判定理由写明了 RegCreateKeyExW 的语义（T4 可据此决定是否 Append）',
        verdict.operations.some((entry) => entry.op === 'create-key' && entry.path === 'HKCU\\Software' && entry.effect === 'no-op' && /open or create/.test(entry.reason)),
        stableJson(verdict.operations.find((entry) => entry.op === 'create-key' && entry.effect === 'no-op')),
      )
      check('⑥ hasNetChange 与 net 计数一致', verdict.hasNetChange === (verdict.summary.net > 0), stableJson(verdict.summary))

      // ⑦ 路径映射边界（lead 要求：空/相对/预定义根句柄不许静默出错）
      check('⑦ 预定义根句柄 + NULL/空子键 ⇒ 规范路径就是裸根名，且容器链为空', overlaySubKeyFor('HKEY_CURRENT_USER') === 'HKCU' && overlayContainerChain('HKEY_CURRENT_USER').length === 0, overlaySubKeyFor('HKEY_CURRENT_USER'))
      check('⑦ 裸根 create-key 净变化为零（根键永远存在，不得入 WAL）', (() => {
        const next = applyOverlayOperation(createOverlayState({}), { op: 'create-key', path: 'HKCU' })
        return next.ops.length === 0
      })(), 'zero ops')
      checkThrows('⑦ 裸根 delete-key 抛 REG_STAGE_ROOT_READONLY（预定义根不可删除）', () => applyOverlayOperation(createOverlayState({}), { op: 'delete-key', path: 'HKCU' }), 'REG_STAGE_ROOT_READONLY')
      check('⑦ 相对路径（无根键）在策略层就是硬拒（不猜根键）', classifyRegistryOperation({ api: 'RegOpenKeyExW', path: 'Software\\X' }).code === 'REG_STAGE_ROOT_UNKNOWN', stableJson(classifyRegistryOperation({ api: 'RegOpenKeyExW', path: 'Software\\X' })))
      checkThrows('⑦ 空路径抛错', () => parseRegistryPath(''), undefined)
      check('⑦ 正斜杠/尾部分隔符/大小写都被归一（HKEY_CURRENT_USER/Software/X/ ⇒ HKCU\\Software\\X）', overlaySubKeyFor('HKEY_CURRENT_USER/Software/X/') === 'HKCU\\Software\\X', overlaySubKeyFor('HKEY_CURRENT_USER/Software/X/'))
      check('⑦ 裸根的判定位带在策略结果里（bareRoot），DLL 可据此走"透传真实根句柄"分支', classifyRegistryOperation({ api: 'RegOpenKeyExW', path: 'HKCU' }).flags.bareRoot === true, stableJson(classifyRegistryOperation({ api: 'RegOpenKeyExW', path: 'HKCU' }).flags))
    }

    section('S10. 覆盖 hive 生命周期常量（[官方] 事实，T4 的实现依据）')
    {
      check('REG_PROCESS_APPKEY = 0x1（winreg.h）', REG_LOAD_APP_KEY_FLAGS.REG_PROCESS_APPKEY === 0x00000001, `0x${REG_LOAD_APP_KEY_FLAGS.REG_PROCESS_APPKEY.toString(16)}`)
      check('REG_OPTION_VOLATILE = 0x1 / REG_OPTION_CREATE_LINK = 0x2（winreg.h）', REG_OPTIONS.REG_OPTION_VOLATILE === 1 && REG_OPTIONS.REG_OPTION_CREATE_LINK === 2, `${REG_OPTIONS.REG_OPTION_VOLATILE}/${REG_OPTIONS.REG_OPTION_CREATE_LINK}`)
      check('WOW64 视图位 = 0x100/0x200（winreg.h）', KEY_WOW64.KEY_WOW64_64KEY === 0x100 && KEY_WOW64.KEY_WOW64_32KEY === 0x200, '764/732')
      check('覆盖 hive 文件名固定为 overlay.hive（宿主与 DLL 必须用同一个名字）', resolveRegistryStagePath('C:\\s').endsWith('overlay.hive'), resolveRegistryStagePath('C:\\s'))
    }
    section('S12. 空 journal / 空覆盖层：宿主必须判"无候选"，不许报错、不许产出空候选')
    {
      // 实测由来：T4 的写路径一度因句柄泄漏写不出任何记录，`registry/overlay.journal` 是 **0 字节**。
      // 宿主在这种情况下必须是"安静地没有候选"，而不是抛错或产出一个空候选（后者会让面板出现空条目）。
      const real = createFakeRegistry([['HKCU\\Software\\App', 'A', 'REG_SZ', 'a']])

      const emptyDir = join(workRoot, 's12-empty')
      mkdirSync(join(emptyDir, 'registry'), { recursive: true })
      writeFileSync(resolveRegistryStageJournalPath(emptyDir), Buffer.alloc(0))
      const emptyStage = createRegistryStage({ sessionDir: emptyDir, sessionId: 's12a', reader: real.reader, writer: real.writer })
      const opened = emptyStage.open()
      check('0 字节 journal：open() 正常返回（resumed=0、torn=false、无 rejected）', opened.resumed === 0 && opened.torn === false && opened.rejected.length === 0, stableJson({ resumed: opened.resumed, torn: opened.torn, rejected: opened.rejected.length }))
      const emptyDiff = emptyStage.diff()
      check('0 字节 journal：diff() 返回零变化且不抛错', emptyDiff.totalChanges === 0 && emptyDiff.paths.length === 0, stableJson({ total: emptyDiff.totalChanges, paths: emptyDiff.paths }))
      const emptyFrozen = emptyStage.freezeCandidate()
      check('0 字节 journal：freezeCandidate() 判 no-net-change（**不**产出空候选、不写候选文件）', emptyFrozen.enqueued === false && emptyFrozen.reason === 'no-net-change' && emptyFrozen.changes.length === 0, stableJson({ enqueued: emptyFrozen.enqueued, reason: emptyFrozen.reason }))
      check('0 字节 journal：快照 paths 为空、且没有 queue.json 噪声', emptyStage.snapshot().paths.length === 0 && !existsSync(join(emptyDir, 'queue.json')), `paths=${emptyStage.snapshot().paths.length}`)
      check('0 字节 journal：readRegistryJournal 返回 missing=false / records=0 / torn=false', (() => {
        const read = readRegistryJournal(resolveRegistryStageJournalPath(emptyDir))
        return read.missing === false && read.records.length === 0 && read.torn === false
      })(), 'empty file is not "missing"')

      const noJournalDir = join(workRoot, 's12-absent')
      const absentStage = createRegistryStage({ sessionDir: noJournalDir, sessionId: 's12b', reader: real.reader, writer: real.writer })
      const absentOpened = absentStage.open()
      check('journal 文件不存在：open() 也正常（resumed=0），freezeCandidate() 判 no-net-change', absentOpened.resumed === 0 && absentStage.freezeCandidate().enqueued === false, `resumed=${absentOpened.resumed}`)
      check('以上两种情况下真实 hive 都零写入（空覆盖层不碰真实系统）', real.log.writes.length === 0, `writes=${real.log.writes.length}`)
    }

    section('S13. apply 的父键依赖与"只应用已批准单元"（契约 v1.3）')
    {
      // 场景：真实 hive 里 `HKCU\Software` 存在，`...\Brand` 不存在。
      // 候选 = [mkdir HKCU\Software\Brand, create HKCU\Software\Brand\V]。
      const makeFixture = (tag) => {
        const real = createFakeRegistry([['HKCU\\Software', 'Existing', 'REG_SZ', 'x']])
        const writes = []
        // 写日志 + **真的把变化落到假真实 hive**（否则"父键已建出"这件事在下一轮 apply 里不可见，
        // 而 apply 的父键判定按设计就是"以真实 hive 现状为准"）。这层包装同时证明：
        // blocked 的那一次**没有任何调用**被委派下去。
        const writer = {
          createKey: (p, o) => {
            writes.push(['create-key', p])
            return real.writer.createKey(p, o)
          },
          setValue: (p, n, t, hex) => {
            writes.push(['set-value', p, n, t, hex])
            return real.writer.setValue(p, n, t, hex)
          },
          deleteValue: (p, n) => {
            writes.push(['delete-value', p, n])
            return real.writer.deleteValue(p, n)
          },
          deleteKey: (p, o) => {
            writes.push(['delete-key', p])
            return real.writer.deleteKey(p, o)
          },
        }
        const stage = (name) => {
          const sessionDir = join(workRoot, `s13-${tag}-${name}`)
          const created = createRegistryStage({ sessionDir, sessionId: `s13-${tag}-${name}`, reader: real.reader, writer })
          created.open()
          created.stageCreateKey('HKCU\\Software\\Brand')
          created.stageSetValue('HKCU\\Software\\Brand', 'V', 'REG_DWORD', 7)
          return created
        }
        return { real, writes, writer, stage }
      }

      // ① 只批准值单元 ⇒ blocked(status=2)，且**一个字节都不写**
      const fx = makeFixture('main')
      const selective = fx.stage('selective')
      const frozen = selective.freezeCandidate()
      const valueUnit = frozen.candidate.changes.find((change) => change.valueName === 'V')
      const blockedResult = selective.apply({ paths: [valueUnit.path] })
      check(
        '① 只批准值单元、不批准父键 mkdir ⇒ blocked（status=2 且理由指明父键）',
        blockedResult.applied.length === 0 &&
          blockedResult.blocked.length === 1 &&
          blockedResult.blocked[0].status === REG_STATUS.ERROR_FILE_NOT_FOUND &&
          /parent key/.test(blockedResult.blocked[0].reason),
        stableJson(blockedResult.blocked),
      )
      check('① blocked 时写入器一次都没被调用（绝不静默补建未批准的键）', fx.writes.length === 0, `writes=${fx.writes.length}`)

      // ② 父键 mkdir 单独批准 ⇒ 只建空键，值不写
      const mkdirUnit = frozen.candidate.changes.find((change) => change.op === 'mkdir' && change.registryPath.endsWith('Brand'))
      const mkdirResult = selective.apply({ paths: [mkdirUnit.path] })
      check(
        '② 只批准父键 mkdir ⇒ 只创建空键（值单元仍是 not-selected）',
        mkdirResult.applied.length === 1 &&
          mkdirResult.applied[0].op === 'create-key' &&
          fx.writes.filter((entry) => entry[0] === 'set-value').length === 0,
        stableJson({ applied: mkdirResult.applied, writes: fx.writes }),
      )
      // ③ 补齐值单元 ⇒ 父键在真实 hive 里已存在（本次 apply 建出来的），必须放行
      const rest = selective.apply({ paths: [valueUnit.path] })
      check(
        '③ 父键已在真实 hive 里建出后，值单元放行（blocked 不是永久拒绝）',
        rest.applied.length === 1 && rest.blocked.length === 0 && fx.writes.some((entry) => entry[0] === 'set-value'),
        stableJson({ applied: rest.applied, blocked: rest.blocked }),
      )

      // ④ 一次性全批准 ⇒ 一个单元都不落（用**全新**的假真实 hive，避免被 ②③ 的写入污染）
      const fx4 = makeFixture('full')
      const full = fx4.stage('full')
      full.freezeCandidate()
      const fullResult = full.apply()
      check(
        '④ 全量 apply：候选每个单元都被应用，failed/blocked 均为 0',
        fullResult.applied.length === 2 && fullResult.failed.length === 0 && fullResult.blocked.length === 0,
        stableJson({ applied: fullResult.applied, failed: fullResult.failed, blocked: fullResult.blocked }),
      )
      check('④ 全量 apply 后写入器收到 create-key 与 set-value 各一次', fx4.writes.filter((entry) => entry[0] === 'create-key').length === 1 && fx4.writes.filter((entry) => entry[0] === 'set-value').length === 1, stableJson(fx4.writes))
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true })
  }
}

// ─────────────────── 独立运行入口（verify.cmd 走的是 registry-guard 那条路）───────────────────

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
  let assertions = 0
  let failures = 0
  const write = (text) => process.stdout.write(`${text}\n`)
  const check = (name, condition, detail) => {
    assertions += 1
    if (!condition) failures += 1
    write(`${condition ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
  }
  const checkThrows = (name, fn, expectedCode) => {
    assertions += 1
    try {
      fn()
      failures += 1
      write(`  ✗ ${name}\n      证据: 竟然没有抛错（期望 ${expectedCode ?? '任意错误'}）`)
      return undefined
    } catch (error) {
      const ok = expectedCode === undefined || error.code === expectedCode
      if (!ok) failures += 1
      write(`  ${ok ? '✓' : '✗'} ${name}\n      证据: code=${error.code ?? '(none)'} ${String(error.message).slice(0, 160)}`)
      return error
    }
  }
  const section = (title) => {
    write('')
    write(`=== ${title} ===`)
  }

  write('registry-stage 测试（独立运行）')
  runRegistryStageChecks({ check, checkThrows, section })
  write('')
  write('='.repeat(72))
  write(`registry-stage 测试：断言 ${assertions} 项，失败 ${failures} 项`)
  write('='.repeat(72))
  process.exit(failures ? 1 : 0)
}
