/**
 * registry-conformance —— 用**真实产物**（DLL + 闭环节报告 + DLL 写出的 WAL）钉契约
 *
 * 存在理由（2026-09-30 的集成实测）：
 *   shim DLL 自创了 `reg\<HIVE>\<Key>\values.wsv`，**没有导出 `DshRegStage*`、
 *   没有写 `registry/overlay.journal`**。结果是"沙箱内注册表写成功"与"审批面板看得到"
 *   断成两半（`tools/run-shim-closedloop.mjs` 19/21）。消息对齐抓不住这种漂移，
 *   所以本套件把契约变成**可执行判定**，并且断言的对象是**构件的字节**：
 *
 *   S0  契约数据自洽（机器可读清单与路径函数一致）
 *   S1  WAL 校验器的判定力：**变异体自证**（正例必须过；七个变异体必须各自报出预期问题码）
 *   S2  读回证据校验器的判定力：`queryRc==0` 却没有内容 ⇒ 必须红（README 缺陷 11 同类）
 *   S3  证据新鲜度校验器的判定力：报告比 DLL 旧 ⇒ 必须红
 *   S4  PE 导出解析器的判定力：把真实 DLL 内存副本里的一个导出**改名** ⇒ 必须立刻报缺
 *   A1  真实 DLL：PE32+ x64 DLL、**契约要求的 4 个导出全部存在**（缺一即红）
 *   A2  真实 WAL：`<stageRoot>/registry/overlay.journal` 存在且逐字段合规
 *   A3  在**真实 WAL 字节**上跑完整链路：open→diff→freezeCandidate→选择性 apply→discard
 *   A4  真实报告里的读回证据：`queryRc==0` 必须带回内容，且必须等于探针写入的值
 *   A5  真实报告：必须 21/21 且**比 DLL 新**（过期证据一律判红）
 *
 * ── 产物缺失时的策略（诚实优先）────────────────────────────────────────────
 * 默认 `DSH_CONFORMANCE_ARTIFACTS=auto`：`shim/out/winstage-shim.dll` **不存在**时
 * 整个 A 段显式 SKIP（打印原因，绝不算通过）—— 新克隆里 `shim/` 未入库，verify 仍应是绿的。
 * 一旦 DLL 存在，A 段就是**强制**的：这就是"做不到时哪些 check 必须红"。
 *   `=required`：DLL 不存在也判红（给"必须先构建"的 CI 用）
 *   `=off`     ：跳过 A 段（应急离线）。会打印一行大写的"未验证"，因为这不是绿。
 *
 * 用法：
 *   node tests\registry-conformance.mjs
 *   node tests\registry-guard.mjs          # 同一批判定也会在既有套件里执行
 *   DSH_CONFORMANCE_STAGE_ROOT=<stage>     # 指定保留了 --keep-stage 的暂存树
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  REG_STAGE_ABI_OPTIONAL_EXPORTS,
  REG_STAGE_ABI_REQUIRED_EXPORTS,
  REG_STAGE_CONFORMANCE,
  REG_STAGE_FLAGS,
  REG_STAGE_JOURNAL_MAGIC,
  REG_STAGE_KIND,
  REG_STAGE_RECORD_OFFSETS,
  REG_STAGE_RECORD_SIZE,
  createRegistryStage,
  encodeJournalRecord,
  journalRecordForOperation,
  replayJournal,
  validateEvidenceFreshness,
  validateJournalBuffer,
  validateReadbackEvidence,
} from '../src/registry-stage.mjs'
import { REG_TYPES, parseRegistryPath } from '../src/registry-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

/** DLL 必须导出的 shim 自身 ABI（不得回归） */
const SHIM_OWN_EXPORTS = ['WinstageShimAbiVersion', 'WinstageShimBindStageApi', 'WinstageShimInit', 'WinstageShimOriginal', 'WinstageShimRefreshHooks', 'WinstageShimShutdown', 'WinstageShimStatsJson']

// ─────────────────── 自带的极简 PE 导出解析器（不依赖任何外部工具）───────────────────
//
// 为什么自己写一份而不是直接复用 tools/pe-exports.mjs：本套件要能在**没有任何 T4 工具**的
// 情况下工作，而且"两个独立解析器给出同一结论"本身就是一条值得断言的交叉校验。
// 返回的 `exports[].nameOffset` 是名字字符串在文件里的**精确偏移** —— S4 的变异体要用它。

export function readPeExports(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) {
    throw new Error('not a PE file (bad MZ signature)')
  }
  const eLfanew = buffer.readUInt32LE(0x3c)
  if (buffer.readUInt32LE(eLfanew) !== 0x00004550) throw new Error('bad PE signature')
  const coff = eLfanew + 4
  const machine = buffer.readUInt16LE(coff)
  const numberOfSections = buffer.readUInt16LE(coff + 2)
  const sizeOfOptionalHeader = buffer.readUInt16LE(coff + 16)
  const characteristics = buffer.readUInt16LE(coff + 18)
  const opt = coff + 20
  const magic = buffer.readUInt16LE(opt)
  const is64 = magic === 0x20b
  if (magic !== 0x20b && magic !== 0x10b) throw new Error(`unsupported optional header magic 0x${magic.toString(16)}`)
  const dataDirOffset = opt + (is64 ? 112 : 96)
  const sectionTable = opt + sizeOfOptionalHeader
  const sections = []
  for (let index = 0; index < numberOfSections; index += 1) {
    const base = sectionTable + index * 40
    sections.push({
      virtualSize: buffer.readUInt32LE(base + 8),
      virtualAddress: buffer.readUInt32LE(base + 12),
      sizeOfRawData: buffer.readUInt32LE(base + 16),
      pointerToRawData: buffer.readUInt32LE(base + 20),
    })
  }
  const rvaToOffset = (rva) => {
    for (const section of sections) {
      const size = Math.max(section.virtualSize, section.sizeOfRawData)
      if (rva >= section.virtualAddress && rva < section.virtualAddress + size) {
        return section.pointerToRawData + (rva - section.virtualAddress)
      }
    }
    return -1
  }
  const info = {
    machine: machine === 0x8664 ? 'x86_64' : machine === 0x14c ? 'i386' : `0x${machine.toString(16)}`,
    machineRaw: machine,
    is64,
    isDll: (characteristics & 0x2000) !== 0,
    exports: [],
    importDlls: [],
  }
  const expRva = buffer.readUInt32LE(dataDirOffset)
  const expSize = buffer.readUInt32LE(dataDirOffset + 4)
  if (expRva && expSize) {
    const directory = rvaToOffset(expRva)
    if (directory < 0) throw new Error(`export directory RVA 0x${expRva.toString(16)} is not mapped`)
    const numberOfNames = buffer.readUInt32LE(directory + 24)
    const addressOfNames = buffer.readUInt32LE(directory + 32)
    const namesOffset = rvaToOffset(addressOfNames)
    for (let index = 0; index < numberOfNames; index += 1) {
      const nameRva = buffer.readUInt32LE(namesOffset + index * 4)
      const offset = rvaToOffset(nameRva)
      const end = buffer.indexOf(0, offset)
      info.exports.push({ name: buffer.toString('latin1', offset, end), nameOffset: offset })
    }
    info.exports.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  }
  const impRva = buffer.readUInt32LE(dataDirOffset + 8)
  if (impRva) {
    let directory = rvaToOffset(impRva)
    while (directory > 0) {
      const nameRva = buffer.readUInt32LE(directory + 12)
      if (!nameRva) break
      const offset = rvaToOffset(nameRva)
      info.importDlls.push(buffer.toString('latin1', offset, buffer.indexOf(0, offset)))
      directory += 20
    }
  }
  return info
}

// ─────────────────────────── 产物定位 ───────────────────────────

function envOr(name, fallback) {
  const value = process.env[name]
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function artifactMode() {
  const mode = envOr('DSH_CONFORMANCE_ARTIFACTS', 'auto').toLowerCase()
  return ['auto', 'required', 'off'].includes(mode) ? mode : 'auto'
}

/**
 * 定位"最新一次运行"的暂存树。
 *
 * 上一版的缺陷（T4 实测）：按**目录名字典序**取第一个带 journal 的 `run-*`，
 * 在保留了多轮历史的机器上会挑到**修复前**的旧 journal ⇒ 对当前 DLL 报出
 * `PATH_IS_BARE_ROOT` 与 `STALE_EVIDENCE`（把旧字节当成新产物评级）。
 * 现在按证据强度依次取：
 *   1. 显式 `DSH_CONFORMANCE_STAGE_ROOT`；
 *   2. runner 自己记下的"最新一次运行"（`closedloop-evidence-latest.json` / `closedloop-report.json` 的 `stageRoot`）
 *      —— 这是**权威**信号：它就是最后一次运行的目录；
 *   3. 所有 `run-*` 里 **journal 文件 mtime 最新**的那个（比目录名/目录 mtime 都更贴近"哪份字节最新"）；
 *   4. 都没有 journal 时，退化成目录 mtime 最新的（只为把"期望路径"写进红 check 的 detail）。
 * ⚠ runner 默认会删除暂存树（只有 `--keep-stage` 保留）⇒ 缺 journal 时提示用 `--keep-stage` 重跑。
 */
export function findStageRoot() {
  const explicit = envOr('DSH_CONFORMANCE_STAGE_ROOT', '')
  if (explicit) return explicit
  for (const record of [join(REPO, 'shim', 'out', 'closedloop-evidence-latest.json'), join(REPO, 'shim', 'out', 'closedloop-report.json')]) {
    const parsed = jsonIfExists(record)
    const root = parsed?.stageRoot
    if (typeof root === 'string' && root.length > 0 && fileMtimeMs(join(root, 'registry', 'overlay.journal')) !== undefined) return root
  }
  const base = join(REPO, 'shim', '.stage')
  let entries = []
  try {
    entries = readdirSync(base).filter((name) => name.startsWith('run-'))
  } catch {
    return undefined
  }
  let bestWithJournal
  let bestJournalMtime = -1
  let fallback
  let fallbackMtime = -1
  for (const name of entries) {
    const dir = join(base, name)
    const journalMtime = fileMtimeMs(join(dir, 'registry', 'overlay.journal'))
    if (journalMtime !== undefined && journalMtime > bestJournalMtime) {
      bestJournalMtime = journalMtime
      bestWithJournal = dir
    }
    const dirMtime = fileMtimeMs(dir)
    if (dirMtime !== undefined && dirMtime > fallbackMtime) {
      fallbackMtime = dirMtime
      fallback = dir
    }
  }
  return bestWithJournal ?? fallback
}

function fileMtimeMs(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return undefined
  }
}

function jsonIfExists(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 只读地找到暂存树里 T4 当前的私有布局（用于把"为什么会红"写得可执行） */
function legacyLayoutHint(stageRoot) {
  if (!stageRoot) return 'no stage root found'
  const regRoot = join(stageRoot, 'reg')
  try {
    const hives = readdirSync(regRoot)
    return `当前产物是私有布局 ${join('reg', hives[0] ?? '<HIVE>')}\\...\\values.wsv（宿主读不到它）`
  } catch {
    return 'no reg/ tree either'
  }
}

// ─────────────────────────── 断言主体 ───────────────────────────

/**
 * @param {{check: Function, checkThrows: Function, section: Function, skip?: (name: string, reason: string) => void}} harness
 * @param {{dllPath?: string, reportPath?: string, stageRoot?: string}} [options]
 */
export async function runRegistryConformanceChecks(harness, options = {}) {
  const { check, section } = harness
  const skip = typeof harness.skip === 'function' ? harness.skip : (name, reason) => process.stdout.write(`  ⊘ SKIP ${name}\n      原因: ${reason}\n`)
  const mode = artifactMode()
  const DLL = options.dllPath ?? envOr('DSH_CONFORMANCE_DLL', join(REPO, 'shim', 'out', 'winstage-shim.dll'))
  const REPORT = options.reportPath ?? envOr('DSH_CONFORMANCE_REPORT', join(REPO, 'shim', 'out', 'closedloop-report.json'))
  const dllExists = (() => {
    try {
      return statSync(DLL).isFile()
    } catch {
      return false
    }
  })()
  const stageRoot = options.stageRoot ?? findStageRoot()
  const report = jsonIfExists(REPORT)
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-conformance-'))
  const problemsOf = (result) => result.problems.map((problem) => `${problem.code}${problem.index === undefined ? '' : `#${problem.index}`}`).join(',') || 'none'

  try {
    section('S0. 契约数据自洽（机器可读清单 = 文档 = 测试，三方不许漂移）')
    {
      check('必需的 4 个导出都不是空串且带 DshRegStage 前缀', REG_STAGE_ABI_REQUIRED_EXPORTS.length === 4 && REG_STAGE_ABI_REQUIRED_EXPORTS.every((name) => name.startsWith('DshRegStage')), REG_STAGE_ABI_REQUIRED_EXPORTS.join(','))
      check('可选导出不与必需导出重叠', REG_STAGE_ABI_OPTIONAL_EXPORTS.every((name) => !REG_STAGE_ABI_REQUIRED_EXPORTS.includes(name)), REG_STAGE_ABI_OPTIONAL_EXPORTS.join(','))
      check(
        '记录布局：32 字节头 + 偏移与常量对象逐字段一致',
        REG_STAGE_CONFORMANCE.recordSize === 32 && REG_STAGE_RECORD_SIZE === 32 && REG_STAGE_CONFORMANCE.recordOffsets === REG_STAGE_RECORD_OFFSETS && REG_STAGE_RECORD_OFFSETS.total === 32,
        `size=${REG_STAGE_CONFORMANCE.recordSize} total=${REG_STAGE_RECORD_OFFSETS.total}`,
      )
      check(
        '目录/文件名约定：registry 子目录 + overlay.journal + overlay.hive（推荐）',
        REG_STAGE_CONFORMANCE.stageSubdir === 'registry' && REG_STAGE_CONFORMANCE.journalName === 'overlay.journal' && REG_STAGE_CONFORMANCE.hiveName === 'overlay.hive',
        `${REG_STAGE_CONFORMANCE.stageSubdir}/${REG_STAGE_CONFORMANCE.journalName}`,
      )
      check('stageRoot 参数语义写进契约（复用 shim 现有 WINSTAGE_STAGE_ROOT）', REG_STAGE_CONFORMANCE.stageRootEnv === 'WINSTAGE_STAGE_ROOT' && typeof REG_STAGE_CONFORMANCE.stageRootAliasEnv === 'string', `${REG_STAGE_CONFORMANCE.stageRootEnv} / ${REG_STAGE_CONFORMANCE.stageRootAliasEnv}`)
      check('WAL-first 与硬拒状态码写进契约（= 5）', REG_STAGE_CONFORMANCE.walFirst === true && REG_STAGE_CONFORMANCE.hardDenyStatus === 5, `walFirst=${REG_STAGE_CONFORMANCE.walFirst} deny=${REG_STAGE_CONFORMANCE.hardDenyStatus}`)
      check(
        'runner 必须满足的 4 条要求都非空且提到 E3/E5 与新鲜度',
        REG_STAGE_CONFORMANCE.runnerRequirements.length === 4 &&
          REG_STAGE_CONFORMANCE.runnerRequirements.every((line) => line.length > 20) &&
          REG_STAGE_CONFORMANCE.runnerRequirements.some((line) => line.includes('E5')) &&
          REG_STAGE_CONFORMANCE.runnerRequirements.some((line) => line.includes('新')),
        `${REG_STAGE_CONFORMANCE.runnerRequirements.length} 条`,
      )
      check('被 hook 的 8 个 API 也在契约数据里（DLL 与宿主对同一批入口负责）', REG_STAGE_CONFORMANCE.hookedApis.length === 8, REG_STAGE_CONFORMANCE.hookedApis.join(','))
    }

    section('S1. WAL 校验器的判定力（变异体自证：正例必过，七个变异体必须各自报出预期问题码）')
    {
      const probeData = 't4-probe-selfproof'
      const pristine = Buffer.concat([
        encodeJournalRecord(journalRecordForOperation({ op: 'create-key', path: 'HKCU\\Software\\WinstageShimProbe' })),
        encodeJournalRecord(journalRecordForOperation({ op: 'set-value', path: 'HKCU\\Software\\WinstageShimProbe', valueName: 'T4Probe', type: 'REG_SZ', value: probeData })),
      ])
      const positive = validateJournalBuffer(pristine)
      check('正例：真实形态的两条记录必须通过校验（否则校验器只会永远红）', positive.ok === true, problemsOf(positive))
      check('正例：摘要能指出写入的路径与 kind 计数', positive.summary.records === 2 && positive.summary.paths.includes('HKCU\\Software\\WinstageShimProbe') && positive.summary.byKind.SET_VALUE === 1, JSON.stringify(positive.summary))

      const firstRecord = encodeJournalRecord(journalRecordForOperation({ op: 'create-key', path: 'HKCU\\Software\\WinstageShimProbe' }))
      const setValueFlagsAt = firstRecord.length + REG_STAGE_RECORD_OFFSETS.flags
      const mutants = [
        ['magic 低字节被改（字节序/魔数错）', 'DECODE_FAILED', (b) => b.writeUInt8(0x00, REG_STAGE_RECORD_OFFSETS.magic)],
        ['version 改成 9（版本漂移）', 'DECODE_FAILED', (b) => b.writeUInt16LE(9, REG_STAGE_RECORD_OFFSETS.version)],
        ['kind 改成 99（未知类别）', 'DECODE_FAILED', (b) => b.writeUInt16LE(99, REG_STAGE_RECORD_OFFSETS.kind)],
        ['reserved 被塞了非 0 值', 'RESERVED_NONZERO', (b) => b.writeUInt32LE(7, REG_STAGE_RECORD_OFFSETS.reserved)],
        [
          'SET_VALUE 的 HAS_DATA 位被清掉（偏移必须按"前一条记录长度"定位）',
          'SET_VALUE_WITHOUT_DATA_FLAG',
          (b) => b.writeUInt16LE(b.readUInt16LE(setValueFlagsAt) & ~REG_STAGE_FLAGS.HAS_DATA, setValueFlagsAt),
        ],
      ]
      for (const [label, expected, patch] of mutants) {
        const buffer = Buffer.from(pristine)
        patch(buffer)
        const result = validateJournalBuffer(buffer)
        check(`变异体判红：${label}`, result.ok === false && result.problems.some((problem) => problem.code === expected), `${expected} ⇒ ${problemsOf(result)}`)
      }
      const truncated = validateJournalBuffer(pristine.subarray(0, pristine.length - 3))
      check('变异体判红：尾部被截断（半个记录）', truncated.ok === false && truncated.problems.some((problem) => problem.code === 'TORN_TAIL'), problemsOf(truncated))
      const empty = validateJournalBuffer(Buffer.alloc(0))
      check('变异体判红：零字节 WAL（= DLL 根本没实现 WAL）', empty.ok === false && empty.problems.some((problem) => problem.code === 'EMPTY_JOURNAL'), problemsOf(empty))
      const hkpd = validateJournalBuffer(encodeJournalRecord({ kind: REG_STAGE_KIND.CREATE_KEY, path: 'HKPD\\X' }))
      check('变异体判红：不可暂存的 hive（HKPD）', hkpd.ok === false && hkpd.problems.some((problem) => problem.code === 'HIVE_NOT_STAGEABLE'), problemsOf(hkpd))
      const denyZero = validateJournalBuffer(encodeJournalRecord({ kind: REG_STAGE_KIND.HARD_DENY, path: 'HKLM\\X', flags: REG_STAGE_FLAGS.HARD_DENY, status: 0 }))
      check('变异体判红：硬拒记录没有带真实 LSTATUS', denyZero.ok === false && denyZero.problems.some((problem) => problem.code === 'HARD_DENY_STATUS_ZERO'), problemsOf(denyZero))
      const unsupported = Buffer.from(pristine)
      // 直接改**字节**：DLL 若把一个无编解码器的类型写进 SET_VALUE，校验器必须判红。
      // （不能用 encodeJournalRecord 构造 —— 编码器本身就会拒绝 REG_LINK，这正是我们想要的 fail-closed。）
      unsupported.writeUInt16LE(REG_TYPES.REG_LINK, firstRecord.length + REG_STAGE_RECORD_OFFSETS.type)
      const unsupportedResult = validateJournalBuffer(unsupported)
      check(
        '变异体判红：无编解码器的值类型（REG_LINK）被当成可暂存',
        unsupportedResult.ok === false && unsupportedResult.problems.some((problem) => problem.code === 'SET_VALUE_UNSUPPORTED_TYPE'),
        problemsOf(unsupportedResult),
      )
    }

    section('S2. 读回证据校验器的判定力（queryRc==0 必须带回内容，否则是"伪装成证据"）')
    {
      const positive = validateReadbackEvidence({ probe: { openRc: 0, openOk: true, queryRc: 0, queryOk: true, type: REG_TYPES.REG_SZ, data: 't4-probe-x', allCallsSucceeded: true } })
      check('正例：rc 与内容齐全的证据必须通过', positive.ok === true, problemsOf(positive))
      // 这是本次集成实测的**原样形态**：queryRc=0 但 type=0xFFFFFFFF、bytes=0、没有 data
      const live = validateReadbackEvidence({ probe: { openRc: 0, openOk: true, queryRc: 0, queryOk: true, type: 4294967295, bytes: 0, allCallsSucceeded: true } })
      check('实测形态判红：queryRc=0 / type=0xFFFFFFFF / 无内容', live.ok === false && live.problems.some((p) => p.code === 'INVALID_TYPE') && live.problems.some((p) => p.code === 'SUCCESS_WITHOUT_CONTENT'), problemsOf(live))
      const noContent = validateReadbackEvidence({ probe: { openRc: 0, queryRc: 0, type: REG_TYPES.REG_SZ, allCallsSucceeded: true } })
      check('判红：成功但既没有 data 也没有正 bytes', noContent.ok === false && noContent.problems.some((p) => p.code === 'SUCCESS_WITHOUT_CONTENT'), problemsOf(noContent))
      const lie = validateReadbackEvidence({ probe: { openRc: 0, queryRc: 2, allCallsSucceeded: true } })
      check('判红：queryRc!=0 却声称 allCallsSucceeded（代理指标说谎）', lie.ok === false && lie.problems.some((p) => p.code === 'ALL_CALLS_INCONSISTENT'), problemsOf(lie))
      const nonNumericType = validateReadbackEvidence({ probe: { openRc: 0, queryRc: 0, type: 'REG_SZ', data: 'x', allCallsSucceeded: true } })
      check('判红：type 不是 winreg.h 数值', nonNumericType.ok === false && nonNumericType.problems.some((p) => p.code === 'INVALID_TYPE'), problemsOf(nonNumericType))
      const missing = validateReadbackEvidence({ probe: { openOk: true } })
      check('判红：连 openRc/queryRc 都没有', missing.ok === false && missing.problems.some((p) => p.code === 'MISSING_RC'), problemsOf(missing))
    }

    section('S3. 证据新鲜度校验器的判定力（报告比 DLL 旧 ⇒ 一律判红）')
    {
      check('正例：报告比 DLL 新 ⇒ 通过', validateEvidenceFreshness({ reportMtimeMs: 200, dllMtimeMs: 100 }).ok === true, 'report newer')
      const stale = validateEvidenceFreshness({ reportMtimeMs: 100, dllMtimeMs: 200 })
      check('判红：报告比 DLL 旧 ⇒ STALE_EVIDENCE', stale.ok === false && stale.problems.some((p) => p.code === 'STALE_EVIDENCE'), problemsOf(stale))
      check('判红：缺少时间戳 ⇒ NO_TIMESTAMPS', validateEvidenceFreshness({}).problems.some((p) => p.code === 'NO_TIMESTAMPS'), 'no timestamps')
      check('容差内的"稍旧"不算过期（避免把同一秒内的重跑判红）', validateEvidenceFreshness({ reportMtimeMs: 100, dllMtimeMs: 150, toleranceMs: 100 }).ok === true, 'tolerance respected')
    }

    section(`S4. PE 解析器判定力（${dllExists ? '真实 DLL 的内存副本改名' : '无 DLL ⇒ SKIP'}）`)
    let dllInfo
    if (!dllExists) {
      skip('S4.* PE 解析器判定力', `DLL 不存在：${DLL}（先 node tools/build-shim.mjs）`)
    } else {
      const dllBytes = readFileSync(DLL)
      dllInfo = readPeExports(dllBytes)
      check('真实 DLL 是 PE32+ x64 DLL', dllInfo.is64 === true && dllInfo.isDll === true && dllInfo.machine === 'x86_64', `machine=${dllInfo.machine} isDll=${dllInfo.isDll}`)
      // 交叉校验：两个独立解析器必须给出同一份导出集合。
      // 若参考实现（T4 的 tools/pe-exports.mjs）不存在，**显式跳过**而不是判红 ——
      // "工具缺失"与"DLL 不合规"是两件事，混为一谈会让红 check 指向错误的对象。
      let crossChecked = false
      let crossCheckAvailable = false
      try {
        const external = await import(pathToFileURL(join(REPO, 'tools', 'pe-exports.mjs')).href)
        const other = external.parsePe(DLL)
        crossCheckAvailable = true
        crossChecked = JSON.stringify([...other.exports].sort()) === JSON.stringify(dllInfo.exports.map((entry) => entry.name).sort())
      } catch {
        crossCheckAvailable = false
      }
      if (crossCheckAvailable) {
        check(
          '我的 PE 解析器与 tools/pe-exports.mjs 给出同一份导出集合（两个独立实现互证）',
          crossChecked,
          `mine=[${dllInfo.exports.map((entry) => entry.name).join(',')}]`,
        )
      } else {
        skip('S4 双解析器互证', 'tools/pe-exports.mjs 不可用（参考实现缺失，不是 DLL 的问题）')
      }
      // 变异体：把真实 DLL 副本里 "WinstageShimInit" 的第一个字符改掉（内存里改，不动磁盘产物）
      const mutant = Buffer.from(dllBytes)
      const target = dllInfo.exports.find((entry) => entry.name === 'WinstageShimInit')
      check('变异体前置条件：能在真实 DLL 里定位到 WinstageShimInit 的名字字节', target !== undefined && Buffer.from('WinstageShimInit').equals(mutant.subarray(target.nameOffset, target.nameOffset + 16)), `offset=${target?.nameOffset}`)
      if (target) {
        mutant.writeUInt8(0x58, target.nameOffset) // 'W' -> 'X'
        const after = readPeExports(mutant)
        const names = after.exports.map((entry) => entry.name)
        check(
          '变异体判红：改一个字符后，导出名立刻变成 XinstageShimInit 且原名消失（证明导出检查真的有判定力）',
          names.includes('XinstageShimInit') && !names.includes('WinstageShimInit') && after.exports.length === dllInfo.exports.length,
          `${names.length} exports, WinstageShimInit present=${names.includes('WinstageShimInit')}`,
        )
      }
      check('真实 DLL 的导出表非空（解析器没有把表读成空）', dllInfo.exports.length > 0, `${dllInfo.exports.length} exports`)
    }

    // ───────────────────────────── A 段：真实产物闸门 ─────────────────────────────

    if (mode === 'off') {
      section('A. 真实产物符合性（DSH_CONFORMANCE_ARTIFACTS=off）')
      process.stdout.write('  !!! 警告：真实产物闸门被 DSH_CONFORMANCE_ARTIFACTS=off 关闭 —— 本次运行**没有验证** DLL/WAL/证据。这不是"通过"。\n')
      skip('A.1..A.5 真实产物符合性', '被 DSH_CONFORMANCE_ARTIFACTS=off 显式关闭')
    } else if (!dllExists && mode === 'auto') {
      section('A. 真实产物符合性（产物缺失 ⇒ 显式 SKIP，不算通过）')
      skip('A.1 DLL 导出契约', `DLL 不存在：${DLL}（shim/ 未入库；先 node tools/build-shim.mjs）`)
      skip('A.2 on-disk WAL 布局', '没有 DLL 就没有可校验的产物')
      skip('A.3 真实产物全链路', '没有 DLL 就没有可校验的产物')
      skip('A.4 读回证据不变量', `闭环节报告不存在或未生成：${REPORT}`)
      skip('A.5 报告新鲜度与 21/21', `闭环节报告不存在：${REPORT}`)
    } else {
      section('A. 真实产物符合性（DLL 存在 ⇒ 强制；缺一即红）')
      check(`A.1 DLL 存在（${DLL}）`, dllExists, dllExists ? `${statSync(DLL).size} bytes` : 'missing; run node tools/build-shim.mjs')
      if (dllExists) {
        const names = dllInfo.exports.map((entry) => entry.name)
        const missing = REG_STAGE_ABI_REQUIRED_EXPORTS.filter((name) => !names.includes(name))
        check(
          `A.1 契约要求的 ${REG_STAGE_ABI_REQUIRED_EXPORTS.length} 个 DshRegStage* 导出全部存在（缺一即红）`,
          missing.length === 0,
          `missing=[${missing.join(',')}] actual=[${names.join(',')}]`,
        )
        const optional = REG_STAGE_ABI_OPTIONAL_EXPORTS.filter((name) => names.includes(name))
        check(
          'A.1 shim 自身 7 个 WinstageShim* 导出没有回归（不是用 ABI 替换掉旧 ABI）',
          SHIM_OWN_EXPORTS.every((name) => names.includes(name)),
          `missing=[${SHIM_OWN_EXPORTS.filter((name) => !names.includes(name)).join(',')}] optionalPresent=[${optional.join(',')}]`,
        )
        check('A.1 DLL 链接了 ADVAPI32（注册表 API 的来源）', dllInfo.importDlls.some((name) => name.toUpperCase() === 'ADVAPI32.DLL'), dllInfo.importDlls.join(','))

        // A.2 真实 WAL
        //
        // `expectedData` 必须在**这一段的作用域**里声明：A.2 用它比对记录里的原始字节，
        // A.3 用它比对 apply 到真实 hive 的内容。上一版把它声明在 A.2 的 if 块里、
        // 在 A.3 里使用 ⇒ `ReferenceError: expectedData is not defined`，整套在 52/57 处崩掉
        // （后面 5 条断言从未执行）——"断言自己崩了"比"断言失败"更坏，因为它会伪装成"没跑到"。
        const expectedData = report?.runId ? `t4-probe-${report.runId}` : undefined
        const journalPath = stageRoot ? join(stageRoot, 'registry', 'overlay.journal') : undefined
        let journalBuffer
        try {
          journalBuffer = journalPath ? readFileSync(journalPath) : undefined
        } catch {
          journalBuffer = undefined
        }
        check(
          `A.2 DLL 写出的 WAL 在契约路径上（${journalPath ?? '<no stage root>'}）`,
          Buffer.isBuffer(journalBuffer),
          journalBuffer
            ? `${journalBuffer.length} bytes`
            : `missing; ${legacyLayoutHint(stageRoot)}；runner 默认会删暂存树 ⇒ 用 ` +
              '`node tools/run-shim-closedloop.mjs --keep-stage` 重跑，或用 DSH_CONFORMANCE_STAGE_ROOT 指定保留的暂存树',
        )
        if (Buffer.isBuffer(journalBuffer)) {
          // 与 A.5 同一条纪律，但对象是 **WAL 本身**：journal 比 DLL 旧 ⇒ 这份字节不描述当前产物，
          // 不能拿它给当前 DLL 评级（否则"改了 DLL 没重跑 runner"会被静默判成通过）。
          const journalFreshness = validateEvidenceFreshness({
            reportMtimeMs: fileMtimeMs(journalPath),
            dllMtimeMs: fileMtimeMs(DLL),
          })
          check(
            'A.2 WAL 必须比当前 DLL 新（否则先重跑 node tools/run-shim-closedloop.mjs）',
            journalFreshness.ok === true,
            problemsOf(journalFreshness),
          )
          const verdict = validateJournalBuffer(journalBuffer)
          check('A.2 WAL 逐字段合规（魔数/版本/偏移/reserved/路径可解析/kind-flags 组合）', verdict.ok === true, problemsOf(verdict))
          const probeRecord = verdict.records.find(
            (record) => record.kind === REG_STAGE_KIND.SET_VALUE && parseRegistryPath(record.path).canonical === 'HKCU\\Software\\WinstageShimProbe' && record.valueName === 'T4Probe',
          )
          check(
            'A.2 WAL 里确实有探针那次写入（HKCU\\Software\\WinstageShimProbe / T4Probe / REG_SZ）',
            probeRecord !== undefined && probeRecord.typeName === 'REG_SZ',
            probeRecord ? `type=${probeRecord.typeName} bytes=${probeRecord.dataBytes}` : 'no matching SET_VALUE record',
          )
          check(
            'A.2 记录里的数据字节 = 探针写入的 UTF-16LE 内容（raw bytes，不是文本十六进制）',
            probeRecord !== undefined && (expectedData === undefined || probeRecord.wireBytes.equals(Buffer.from(`${expectedData}\u0000`, 'utf16le'))),
            `expected=${expectedData ?? '<unknown runId>'} got=${probeRecord ? probeRecord.wireBytes.toString('hex') : 'n/a'}`,
          )
        }

        // A.3 在真实 WAL 字节上跑完整链路（复制到临时目录，绝不动 T4 的暂存树）
        if (Buffer.isBuffer(journalBuffer)) {
          const makeStage = (tag) => {
            const sessionDir = join(tempRoot, tag)
            mkdirSync(join(sessionDir, 'registry'), { recursive: true })
            writeFileSync(join(sessionDir, 'registry', 'overlay.journal'), journalBuffer)
            const real = new Map() // 假真实 hive：键必须不存在（报告 evidence.regAdd.realKeyExistsAfter 已实测 false）
            const writes = []
            const reader = { read: () => ({ exists: false }) }
            const writer = {
              createKey: (p) => {
                writes.push(['create-key', p])
                return { status: 0 }
              },
              setValue: (p, n, t, hex) => {
                writes.push(['set-value', p, n, t, hex])
                real.set(`${p}\\${n}`.toLowerCase(), { path: p, name: n, type: t, dataHex: hex })
                return { status: 0 }
              },
              deleteValue: () => ({ status: 0 }),
              deleteKey: () => ({ status: 0 }),
            }
            return { stage: createRegistryStage({ sessionDir, sessionId: `conformance-${tag}`, reader, writer }), real, writes }
          }

          // A.3a 完整 apply：候选的 2 个单元（mkdir 父键 + create 值）一起提交
          const full = makeStage('full')
          const opened = full.stage.open()
          check(
            'A.3 宿主 createRegistryStage().open() 能重放 DLL 写出的 WAL（ops>0）',
            opened.resumed > 0 && opened.torn === false,
            `resumed=${opened.resumed} torn=${opened.torn} rejected=${opened.rejected.length}`,
          )
          const diff = full.stage.diff()
          check(
            'A.3 宿主 diff() 在真实产物上报出探针那次 value-added（这是"面板看得到"的证据）',
            diff.changes.some((change) => change.kind === 'value-added' && change.valueName === 'T4Probe'),
            diff.changes.map((change) => `${change.kind}:${change.valueName ?? change.key}`).join(' ') || '(no changes)',
          )
          check(
            'A.3 差异带可用的回滚计划（lead 的第 5 条验收：apply 后要有回滚计划）',
            Object.values(diff.roots).some((root) => (root.rollback?.operations ?? []).length > 0),
            Object.entries(diff.roots).map(([root, value]) => `${root}:${value.rollback.operations.length}`).join(' '),
          )
          check('A.3 冻结候选之前真实 hive 的写日志必须为 0（未应用 ⇒ 字节不动）', full.writes.length === 0, `writes=${full.writes.length}`)
          const frozen = full.stage.freezeCandidate()
          const unit = frozen.candidate?.changes?.find((change) => change.valueName === 'T4Probe')
          check(
            'A.3 候选里含该变更单元且落在候选存储里（同一审批面板的数据形状）',
            frozen.enqueued === true && unit !== undefined && ['create', 'modify'].includes(unit.op),
            `enqueued=${frozen.enqueued} unit=${JSON.stringify(unit ?? null).slice(0, 160)}`,
          )
          const applied = full.stage.apply()
          check(
            'A.3 完整 apply 后真实 hive 只出现这一个值，且数据逐字节一致',
            applied.applied.length === (frozen.candidate.changes?.length ?? 0) &&
              applied.applied.length >= 2 &&
              applied.failed.length === 0 &&
              applied.blocked.length === 0 &&
              full.real.size === 1 &&
              [...full.real.values()][0].name === 'T4Probe' &&
              expectedData !== undefined &&
              [...full.real.values()][0].dataHex === Buffer.from(`${expectedData}\u0000`, 'utf16le').toString('hex'),
            `applied=${applied.applied.length}/${frozen.candidate.changes?.length} failed=${applied.failed.length} blocked=${applied.blocked.length} real=${[...full.real.values()].map((entry) => `${entry.name}=${entry.dataHex}`).join(',')}`,
          )
          const discarded = full.stage.discard({ reason: 'conformance' })
          let discardedRefused = false
          try {
            full.stage.apply()
          } catch (error) {
            discardedRefused = error.code === 'REG_CANDIDATE_DISCARDED'
          }
          check('A.3 discard() 清理覆盖层，且丢弃后再 apply 必须抛 REG_CANDIDATE_DISCARDED', discarded.discarded === true && discardedRefused, `discarded=${discarded.discarded} refused=${discardedRefused}`)

          // A.3b 选择性 apply 的依赖语义（契约 v1.3）：**只**批准值单元、不批准父键的 mkdir
          // ⇒ 必须如实 `blocked`（status=2），且**一个字节都不写**（绝不静默替用户建未批准的键）。
          const selective = makeStage('selective')
          selective.stage.open()
          selective.stage.diff()
          const selectiveFrozen = selective.stage.freezeCandidate()
          const valueUnit = selectiveFrozen.candidate?.changes?.find((change) => change.valueName === 'T4Probe')
          const selectiveApplied = selective.stage.apply({ paths: [valueUnit?.path].filter(Boolean) })
          check(
            'A.3b 只选值单元（父键 mkdir 未选）⇒ blocked(status=2) 且真实 hive 零写入',
            selectiveApplied.applied.length === 0 &&
              selectiveApplied.blocked.length === 1 &&
              selectiveApplied.blocked[0].status === 2 &&
              /parent key/.test(selectiveApplied.blocked[0].reason) &&
              selective.writes.length === 0 &&
              selective.real.size === 0,
            `applied=${selectiveApplied.applied.length} blocked=${JSON.stringify(selectiveApplied.blocked)} writes=${selective.writes.length}`,
          )
        } else {
          skip('A.3 真实产物全链路', '没有 registry/overlay.journal ⇒ 宿主无法产候选（这正是断点本身）')
        }
      }

      // A.4 / A.5 报告证据
      if (!report) {
        check(`A.4/A.5 闭环节报告存在（${REPORT}）`, false, 'missing; run node tools/run-shim-closedloop.mjs')
      } else {
        const readback = validateReadbackEvidence(report.evidence?.regReadBack)
        check('A.4 读回证据成立：queryRc==0 必须带回内容且 type 是合法 REG_*', readback.ok === true, problemsOf(readback))
        const probe = report.evidence?.regReadBack?.probe ?? {}
        const expectedData = report.runId ? `t4-probe-${report.runId}` : undefined
        check(
          'A.4 读回的 data 必须逐字符等于探针写入的值（不是"有内容"就算过）',
          typeof probe.data === 'string' && (expectedData === undefined || probe.data === expectedData) && probe.type === REG_TYPES.REG_SZ,
          `data=${JSON.stringify(probe.data)} type=${probe.type} expected=${expectedData ?? '<unknown runId>'}`,
        )
        const missingProbe = report.evidence?.regReadMissing?.probe ?? {}
        check(
          'A.4 反例（未曾写入的值）必须 queryRc!=0 且 allCallsSucceeded=false（空结果不是成功）',
          missingProbe.queryRc !== 0 && missingProbe.allCallsSucceeded === false,
          `queryRc=${missingProbe.queryRc} allCallsSucceeded=${missingProbe.allCallsSucceeded}`,
        )
        const e5 = (report.checks ?? []).find((entry) => entry.id === 'E5.registry-read-back')
        check('A.4 报告里 E5.registry-read-back 本身必须是 ok（探针证据与判定一致）', e5?.ok === true, `E5=${JSON.stringify(e5 ?? null)}`)

        const freshness = validateEvidenceFreshness({ reportMtimeMs: fileMtimeMs(REPORT), dllMtimeMs: fileMtimeMs(DLL) })
        check('A.5 报告必须比 DLL 新（否则证据过期，必须重跑 runner）', freshness.ok === true, problemsOf(freshness))
        const failedChecks = (report.checks ?? []).filter((entry) => entry.ok !== true).map((entry) => entry.id)
        check(
          'A.5 闭环节报告必须全绿（runner 自报的每一项都 ok —— 这是"闭环成立"的总闸门）',
          report.ok === true && failedChecks.length === 0,
          `ok=${report.ok} failed=[${failedChecks.join(',')}] total=${(report.checks ?? []).length}`,
        )

        // A.6（条件断言）**重启后白障仍生效** —— 把 T4 声明的残余变成"一旦有证据就必须成立"的门槛。
        // 已知残余（§8.6 第 10 条）：DLL 目前不重放 journal ⇒ DELETE_* 只在进程内 tombstones，
        // 重启后丢失。证据形状（约定，runner 产出）：
        //   <stageRoot>/evidence/probe-reg-read-after-restart.json  = 与 probe-reg-read 同形的探针 JSON
        //   （runner 侧另记 `evidence.regRestartRead = { probe, deletedValueName, deletedKeyPath }`）
        // 产物不存在 ⇒ SKIP（**不算通过**：这是已知缺口，不是"已验证"）。
        const restartEvidence = report.evidence?.regRestartRead
        const restartProbe = restartEvidence?.probe
        if (!restartProbe) {
          skip(
            'A.6 重启后白障仍生效（journal replay）',
            '无重启读回证据（shim 尚未在 attach 时重放 journal ⇒ DELETE_* 白障跨进程丢失；见文档 §8.6 第 10 条 / §14 第 1 条）',
          )
        } else {
          const verdict = validateReadbackEvidence({ probe: restartProbe })
          check(
            'A.6 重启后读回证据本身成立（rc 与内容一致，不许"成功却无内容"）',
            verdict.ok === true,
            problemsOf(verdict),
          )
          check(
            'A.6 重启进程里被删除的值必须仍不可见（queryRc!=0）—— 白障必须跨进程持久',
            restartProbe.queryRc !== 0 && restartProbe.allCallsSucceeded === false,
            `queryRc=${restartProbe.queryRc} allCallsSucceeded=${restartProbe.allCallsSucceeded} deleted=${JSON.stringify(restartEvidence.deletedValueName ?? null)}`,
          )
        }
      }
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

// ─────────────────────────── 独立运行入口 ───────────────────────────

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
  let skips = 0
  const write = (text) => process.stdout.write(`${text}\n`)
  const check = (name, condition, detail) => {
    assertions += 1
    if (!condition) failures += 1
    write(`${condition ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
  }
  const skip = (name, reason) => {
    skips += 1
    write(`  ⊘ SKIP ${name}\n      原因: ${reason}`)
  }
  const section = (title) => {
    write('')
    write(`=== ${title} ===`)
  }

  write('registry-conformance 测试（用真实产物钉契约）')
  await runRegistryConformanceChecks({ check, skip, section })
  write('')
  write('='.repeat(72))
  write(`registry-conformance 测试：断言 ${assertions} 项，失败 ${failures} 项，跳过 ${skips} 项`)
  write('='.repeat(72))
  process.exit(failures ? 1 : 0)
}
