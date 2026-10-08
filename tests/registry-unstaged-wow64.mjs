#!/usr/bin/env node
/**
 * tests/registry-unstaged-wow64.mjs —— A2 段真实产物门（registry layer，契约 v1.4）
 *
 * 它钉的是**两条曾被写错、且都在真实负载上炸过**的规则：
 *
 *  (a) `KEY_WOW64_64KEY` 在 64 位进程里是 winreg.h **文档化的 no-op**。
 *      `RegCreateKeyExW` + `KEY_WOW64_64KEY` 去创建一个**还不存在**的键，必须
 *      **成功并正常暂存**（覆盖层拿到 CREATE_KEY/SET_VALUE，真实 hive 不动）。
 *      旧行为：`ws_create_key()` 拿**原始掩码**判"受限" ⇒ 返回 `ERROR_ACCESS_DENIED(5)`
 *      ⇒ CLR `0x80070005` / node `WSAStartup 10107`。
 *
 *  (b) "覆盖层复现不了这次调用" **不是** "你没有权限"。`KEY_WOW64_32KEY` 指向的是
 *      另一个 hive 位置（32 位视图），app hive 没有视图概念 ⇒ **透传真实 API**，
 *      并留下一条 `UNSTAGED`（kind 6）审计记录。旧行为：硬拒 5。
 *      本门用 `reg delete <key> /reg:32` 做这件事：整次调用**只有一步**（不经过
 *      "先拿真实句柄、再写值" 的分裂路径），因此"真实 hive 真的变了"可以被
 *      **字节级**验证（键在运行前存在、运行后消失）。
 *
 *  (c) `UNSTAGED` 记录**绝不能被重放**：它描述的调用**已经到达真实系统**，
 *      把它当覆盖层操作重放就是双重写入。因此候选（diff）与应用单元里都不许有它。
 *      这条同时用**真实 WAL 字节**（上一段跑出来的 overlay.journal）和**纯层**
 *      （`createRegistryStage` + 假 reader/writer）两边验证。
 *
 * 运行：
 *   $env:WINSTAGE_SHIM_OUT='esc\par\a2'; node tests\registry-unstaged-wow64.mjs
 *
 * 产物缺失 ⇒ **显式 SKIP**（打印"未验证"，绝不算通过；与 registry-conformance 同一纪律）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  OVERLAY_JOURNAL_NAME,
  REGISTERED_HARD_DENIALS,
  REG_STAGE_FLAGS,
  REG_STAGE_KIND,
  REG_STAGE_UNSTAGED_REASON,
  classifyRegistryOperation,
  createRegistryStage,
  decodeJournalRecords,
  encodeJournalRecord,
  journalUnstagedRecord,
  replayJournal,
  validateJournalBuffer,
} from '../src/registry-stage.mjs'
import { REG_STATUS, diffSnapshots, normalizeSnapshot, parseRegistryPath } from '../src/registry-guard.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const OUT = process.env.WINSTAGE_SHIM_OUT ? path.resolve(REPO, process.env.WINSTAGE_SHIM_OUT) : path.join(REPO, 'shim', 'out')
const SYS = process.env.SystemRoot || 'C:\\Windows'
const REG = path.join(SYS, 'System32', 'reg.exe')

const RUN_ID = crypto.randomBytes(4).toString('hex')
const STAGE = path.join(REPO, 'shim', '.stage', `a2-unstaged-${RUN_ID}`)
const EV = path.join(STAGE, 'evidence')
const JOURNAL = path.join(STAGE, 'registry', OVERLAY_JOURNAL_NAME)
const K64 = 'HKCU\\Software\\WinStageA2W64Probe'
const K32 = 'HKCU\\Software\\WinStageA2W32Gone'

let assertions = 0
let failures = 0
let skips = 0

const W = (text) => process.stdout.write(`${text}\n`)
function check(name, condition, detail) {
  assertions += 1
  if (!condition) failures += 1
  W(`${condition ? '  ✓' : '  ✗'} ${name}${detail !== undefined ? `\n      证据: ${detail}` : ''}`)
}
function skip(name, reason) {
  skips += 1
  W(`  ⊘ SKIP ${name}\n      原因: ${reason}`)
}
function section(title) {
  W('')
  W(`=== ${title} ===`)
}

// ───────────────────────── 产物与启动器 ─────────────────────────
//
// 为什么要把 injector + DLL **复制到 %TEMP% 再跑**（不是洁癖，是判定力问题）：
// Windows 让新进程的完整性级别取**父进程令牌**与**映像文件强制标签**的较低者。
// 仓库目录 `...\Desktop\WinStageSandbox` 带 Low 强制标签（S-1-16-4096），因此仓库里
// 构建出来的 exe 也是 Low ⇒ 载体一启动就是 Low IL ⇒ **内核的 no-write-up 会拒绝
// 任何真实 hive 写入**，于是 (b) 的"真实 hive 真的变了"永远观测不到（而且失败原因
// 与本次改动无关）。`%TEMP%` 是**无标签**目录，复制过去跑出来的载体是 Medium/High。
// `tools/build-shim.mjs` 现在也会把产物标签修回 Medium，但本门不依赖那个步骤。

function readIfExists(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

function prepareLauncher() {
  const srcDll = path.join(OUT, 'winstage-shim.dll')
  const srcInjector = path.join(OUT, 'winstage-inject.exe')
  if (!fs.existsSync(srcDll) || !fs.existsSync(srcInjector)) {
    return null
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `winstage-a2-unstaged-${RUN_ID}-`))
  const dll = path.join(dir, 'winstage-shim.dll')
  const injector = path.join(dir, 'winstage-inject.exe')
  fs.copyFileSync(srcDll, dll)
  fs.copyFileSync(srcInjector, injector)
  return { dir, dll, injector, srcDll, srcInjector }
}

function runNative(exe, args, tag) {
  fs.mkdirSync(EV, { recursive: true })
  const out = path.join(EV, `${tag}.out.txt`)
  const err = path.join(EV, `${tag}.err.txt`)
  const o = fs.openSync(out, 'w')
  const e = fs.openSync(err, 'w')
  let res
  try {
    // 环境规则：绝不通过 PowerShell 管道捕获原生进程输出 —— 用 fd 落盘再读。
    res = spawnSync(exe, args, { stdio: ['ignore', o, e], cwd: REPO, env: process.env, windowsHide: true, timeout: 120000 })
  } finally {
    fs.closeSync(o)
    fs.closeSync(e)
  }
  return { status: res.status, stdout: readIfExists(out), stderr: readIfExists(err), outFile: out, errFile: err }
}

function runInjected(launcher, tag, childArgs, extraEnv = {}) {
  return runNative(launcher.injector, [
    '--dll', launcher.dll,
    '--set-env', `WINSTAGE_STAGE_ROOT=${STAGE}`,
    '--set-env', `DSH_REGSTAGE_ROOT=${STAGE}`,
    '--set-env', `WINSTAGE_SHIM_LOG=${path.join(STAGE, 'shim.log')}`,
    ...Object.entries(extraEnv).flatMap(([key, value]) => ['--set-env', `${key}=${value}`]),
    '--report', path.join(EV, `${tag}.inject.json`),
    '--timeout-ms', '60000', '--child-timeout-ms', '120000',
    '--', ...childArgs,
  ], tag)
}

/** 32 位视图对 `HKCU\Software\X` 是否重定向到 `WOW6432Node` 由系统决定 ⇒ 两处都查。 */
function realKeyExists(keyPath) {
  const candidates = [keyPath, keyPath.replace('\\Software\\', '\\Software\\WOW6432Node\\')]
  for (const candidate of candidates) {
    const res = runNative(REG, ['query', candidate], `query-${candidate.replace(/[^A-Za-z0-9]/g, '_')}`)
    if (res.status === 0) return { exists: true, path: candidate, stdout: res.stdout }
  }
  return { exists: false, path: null, stdout: '' }
}

function cleanupRealKey(keyPath) {
  for (const candidate of [keyPath, keyPath.replace('\\Software\\', '\\Software\\WOW6432Node\\')]) {
    runNative(REG, ['delete', candidate, '/f'], `cleanup-${candidate.replace(/[^A-Za-z0-9]/g, '_')}`)
  }
}

// ───────────────────────── 纯层替身（候选/应用面）─────────────────────────

function createStubRegistry() {
  const keys = new Map()
  const writes = []
  const ensure = (p) => {
    const fold = p.toLowerCase()
    if (!keys.has(fold)) keys.set(fold, { path: p, values: new Map() })
    return keys.get(fold)
  }
  return {
    writes,
    reader: {
      read(p) {
        const { canonical } = parseRegistryPath(p)
        const record = keys.get(canonical.toLowerCase())
        if (!record) return { exists: false }
        const subKeys = []
        for (const other of keys.values()) {
          const parent = other.path.slice(0, other.path.lastIndexOf('\\'))
          if (parent.toLowerCase() === canonical.toLowerCase()) subKeys.push(other.path.slice(other.path.lastIndexOf('\\') + 1))
        }
        const values = {}
        for (const entry of record.values.values()) values[entry.name] = { type: entry.type, data: entry.data }
        return { exists: true, subKeys, values }
      },
    },
    writer: {
      createKey(p) {
        writes.push(['create-key', p])
        ensure(p)
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      setValue(p, name, type, dataHex) {
        writes.push(['set-value', p, name, type, dataHex])
        ensure(p).values.set(String(name).toLowerCase(), { name, type, data: dataHex })
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      deleteValue(p, name) {
        writes.push(['delete-value', p, name])
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
      deleteKey(p) {
        writes.push(['delete-key', p])
        keys.delete(p.toLowerCase())
        return { status: REG_STATUS.ERROR_SUCCESS }
      },
    },
  }
}

// ─────────────────────────────── 主流程 ───────────────────────────────

function main() {
  fs.mkdirSync(EV, { recursive: true })

  const launcher = prepareLauncher()
  if (!launcher) {
    W(`registry-unstaged-wow64: 产物缺失（${OUT}）`)
    skip('A2 真实产物门（注册表 unstaged/WOW64）', `缺少 ${path.join(OUT, 'winstage-shim.dll')} 或 winstage-inject.exe：先运行 node tools\\build-shim.mjs（或设置 WINSTAGE_SHIM_OUT）`)
    W('')
    W('='.repeat(72))
    W(`registry-unstaged-wow64 测试：断言 ${assertions} 项，失败 ${failures} 项，跳过 ${skips} 项 —— **未验证**（产物缺失）`)
    W('='.repeat(72))
    process.exit(0)
  }

  let cleanExit = false
  try {
    // ── (a) 64KEY 是 no-op：新键必须能建、且进覆盖层 ──────────────────────────
    section('A. KEY_WOW64_64KEY 在 64 位进程里是 no-op：新建键必须成功并暂存（不再 ACCESS_DENIED）')
    {
      cleanupRealKey(K64)
      const before = realKeyExists(K64)
      check('前置：目标键在真实 hive 里不存在（否则测不到"创建"这条路径）', before.exists === false, `exists=${before.exists}`)

      const res = runInjected(launcher, 'w64-add', [REG, 'add', K64, '/v', 'T4W64', '/t', 'REG_SZ', '/d', 'staged', '/reg:64', '/f'])
      check('reg add /reg:64（RegCreateKeyExW + KEY_WOW64_64KEY）返回 0', res.status === 0, `exit=${res.status} stdout=${JSON.stringify(res.stdout.slice(0, 200))} stderr=${JSON.stringify(res.stderr.slice(0, 200))}`)
      check(
        '输出里没有"拒绝访问 / Access is denied"（旧缺陷的签名）',
        !/拒绝访问|Access is denied/i.test(`${res.stdout}${res.stderr}`),
        JSON.stringify(`${res.stdout}${res.stderr}`.slice(0, 200)),
      )

      const after = realKeyExists(K64)
      check('真实 hive 仍然没有这个键（暂存 ≠ 真写）', after.exists === false, `exists=${after.exists}${after.path ? ` at ${after.path}` : ''}`)

      const journal = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL) : Buffer.alloc(0)
      const decoded = journal.length ? decodeJournalRecords(journal) : { records: [] }
      const staged = decoded.records.filter((record) => parseRegistryPathSafe(record.path) === K64)
      check(
        'WAL 里有这个键的 CREATE_KEY + SET_VALUE（"暂存成功"必须有记录）',
        staged.some((record) => record.kind === REG_STAGE_KIND.CREATE_KEY) && staged.some((record) => record.kind === REG_STAGE_KIND.SET_VALUE && record.valueName === 'T4W64'),
        decoded.records.map((record) => `${record.kindName}:${record.path}`).join(' ') || '(journal empty)',
      )
      check(
        'WAL 里**没有**这个键的 UNSTAGED/HARD_DENY 记录（no-op 视图位不该走透传，更不该被拒）',
        !staged.some((record) => record.kind === REG_STAGE_KIND.UNSTAGED || record.kind === REG_STAGE_KIND.HARD_DENY),
        staged.map((record) => record.kindName).join(' ') || '(none)',
      )
    }

    // ── (b) 32KEY 是另一个视图：不可暂存 ⇒ 透传 + UNSTAGED ─────────────────────
    section('B. KEY_WOW64_32KEY（覆盖层复现不了的视图）⇒ 透传真实 API + UNSTAGED 记录（不是硬拒）')
    {
      cleanupRealKey(K32)
      const setup = runNative(REG, ['add', K32, '/v', 'T4W32', '/t', 'REG_SZ', '/d', 'real', '/f'], 'w32-setup')
      const seeded = realKeyExists(K32)
      check('前置：真实 hive 里先建好这个键（用未注入的 reg.exe）', setup.status === 0 && seeded.exists === true, `exit=${setup.status} exists=${seeded.exists}`)

      const res = runInjected(launcher, 'w32-delete', [REG, 'delete', K32, '/reg:32', '/f'])
      check(
        'reg delete /reg:32（RegDeleteKeyExW + KEY_WOW64_32KEY）返回 0 —— 旧行为是 ACCESS_DENIED(5)',
        res.status === 0,
        `exit=${res.status} stdout=${JSON.stringify(res.stdout.slice(0, 200))}`,
      )

      const gone = realKeyExists(K32)
      check(
        '真实 hive 里的键**真的消失了**（字节级证据：透传确实到达了真实系统）',
        gone.exists === false,
        `exists=${gone.exists}${gone.path ? ` at ${gone.path}` : ''}`,
      )

      const journal = fs.existsSync(JOURNAL) ? fs.readFileSync(JOURNAL) : Buffer.alloc(0)
      const decoded = journal.length ? decodeJournalRecords(journal) : { records: [] }
      const unstaged = decoded.records.filter((record) => record.kind === REG_STAGE_KIND.UNSTAGED)
      check(
        'WAL 里有 UNSTAGED 记录（kind=6）',
        unstaged.length > 0,
        decoded.records.map((record) => `${record.kindName}:${record.path}`).join(' ') || '(journal empty)',
      )
      const forK32 = unstaged.filter((record) => parseRegistryPathSafe(record.path) === K32 || record.path.startsWith('<unstaged:'))
      check(
        'UNSTAGED 记录点名了这个键（审计必须能回答"哪个键去了真实 hive"）',
        forK32.some((record) => record.path === K32),
        unstaged.map((record) => record.path).join(' | ') || '(none)',
      )
      check(
        `UNSTAGED 的 type = 原因码 WOW64_32KEY(${REG_STAGE_UNSTAGED_REASON.WOW64_32KEY})，status = 0（没有被拒），带 UNSTAGED 标志`,
        forK32.some(
          (record) => record.type === REG_STAGE_UNSTAGED_REASON.WOW64_32KEY && record.status === 0 && (record.flags & REG_STAGE_FLAGS.UNSTAGED) !== 0,
        ),
        forK32.map((record) => `type=${record.type} status=${record.status} flags=0x${record.flags.toString(16)}`).join(' | ') || '(none)',
      )
      check(
        'WAL 里**没有**这个键的 DELETE_KEY/HARD_DENY 记录（透传不是删除，硬拒不是结论）',
        !decoded.records.some((record) => parseRegistryPathSafe(record.path) === K32 && (record.kind === REG_STAGE_KIND.DELETE_KEY || record.kind === REG_STAGE_KIND.HARD_DENY)),
        decoded.records.filter((record) => record.path === K32).map((record) => record.kindName).join(' ') || '(none)',
      )
      check(
        '真实 WAL 字节通过契约校验（validateJournalBuffer.ok = true，含 UNSTAGED 的字段组合）',
        validateJournalBuffer(journal).ok === true,
        JSON.stringify(validateJournalBuffer(journal).problems),
      )
    }

    // ── (c) 候选/应用面必须忽略 UNSTAGED ──────────────────────────────────────
    section('C. UNSTAGED 记录不得进入候选或应用单元（它描述的是"已经到达真实系统"的调用）')
    {
      const journal = fs.readFileSync(JOURNAL)
      const decoded = decodeJournalRecords(journal)
      const replay = replayJournal(decoded.records)
      check('replayJournal 把 UNSTAGED 收进 `unstaged[]`', replay.unstaged.length > 0, JSON.stringify(replay.unstaged.slice(0, 2)))
      check(
        'replayJournal 的状态里**没有**那个透传路径的任何 op（state.ops 只装覆盖层操作）',
        !replay.state.ops.some((entry) => parseRegistryPathSafe(entry.path) === K32),
        replay.state.ops.map((entry) => `${entry.op}:${entry.path}`).join(' ') || '(no ops)',
      )
      check(
        '同一个 WAL 里的**暂存**记录仍然正常进状态（忽略 UNSTAGED 不等于整份日志失效）',
        replay.state.ops.some((entry) => parseRegistryPathSafe(entry.path) === K64),
        replay.state.ops.map((entry) => `${entry.op}:${entry.path}`).join(' ') || '(no ops)',
      )
      check(
        'UNSTAGED 的原因码在清单里（C/TS 两侧同一套 1..4）',
        Object.values(REG_STAGE_UNSTAGED_REASON).every((code) => Number.isInteger(code) && code >= 1 && code <= 4),
        JSON.stringify(REG_STAGE_UNSTAGED_REASON),
      )
      check(
        'REGISTERED_HARD_DENIALS.sam 为空 + unstaged 清单非空（视图位不再是权限问题）',
        REGISTERED_HARD_DENIALS.sam.length === 0 && REGISTERED_HARD_DENIALS.unstaged.length > 0,
        `sam=${REGISTERED_HARD_DENIALS.sam.length} unstaged=${REGISTERED_HARD_DENIALS.unstaged.length}`,
      )

      // 纯层：宿主侧门面（参考实现）遇到不可暂存的调用，必须"不抛错、不写覆盖层、留审计"。
      const pureDir = path.join(STAGE, 'pure')
      const stub = createStubRegistry()
      const stage = createRegistryStage({ sessionDir: pureDir, sessionId: 'a2-pure', reader: stub.reader, writer: stub.writer })
      stage.open()
      stage.stageCreateKey('HKCU\\Software\\PureA')
      const stagedWrite = stage.stageSetValue('HKCU\\Software\\PureA', 'V', 'REG_SZ', 'x')

      const denyVerdict = classifyRegistryOperation({ api: 'RegDeleteKeyExW', path: 'HKCU\\Software\\PureB', samDesired: 0x0200 })
      check(
        'classifyRegistryOperation：32KEY ⇒ { stageable:false, unstaged:true, status:0 }',
        denyVerdict.stageable === false && denyVerdict.unstaged === true && denyVerdict.status === 0 && denyVerdict.code === 'REG_STAGE_SAM_UNSTAGED',
        JSON.stringify(denyVerdict),
      )
      const noopVerdict = classifyRegistryOperation({ api: 'RegCreateKeyExW', path: 'HKCU\\Software\\PureC', samDesired: 0x0100 })
      check(
        'classifyRegistryOperation：64KEY（64 位进程）⇒ 可暂存（no-op，不是拒绝）',
        noopVerdict.stageable === true && noopVerdict.unstaged === undefined,
        JSON.stringify(noopVerdict),
      )

      let unstagedResult = null
      let threw = null
      try {
        unstagedResult = stage.stageDeleteKey('HKCU\\Software\\PureB', { samDesired: 0x0200 })
      } catch (error) {
        threw = error
      }
      check(
        'stageDeleteKey(samDesired=32KEY) **不抛错**（抛错就会被上游当成"被拒"）',
        threw === null,
        threw ? `${threw.code}: ${threw.message}` : 'no throw',
      )
      check(
        '返回值如实标注 unstaged（net:false / staged:false / bytes>0 的审计记录）',
        unstagedResult !== null && unstagedResult.unstaged === true && unstagedResult.net === false && unstagedResult.staged === false && unstagedResult.record?.kind === REG_STAGE_KIND.UNSTAGED,
        JSON.stringify(unstagedResult && { unstaged: unstagedResult.unstaged, net: unstagedResult.net, kind: unstagedResult.record?.kind, bytes: unstagedResult.bytes }),
      )
      check(
        '覆盖层状态里没有 PureB（不可暂存 ⇒ 覆盖层里什么都不该发生）',
        stage.getState().ops.every((entry) => parseRegistryPathSafe(entry.path) !== 'HKCU\\Software\\PureB'),
        stage.getState().ops.map((entry) => `${entry.op}:${entry.path}`).join(' ') || '(no ops)',
      )
      check('前置：PureA 的暂存确实进了状态（否则下面的"候选里有 A 没 B"就没有判定力）', stagedWrite.net === true && stage.getState().ops.some((entry) => parseRegistryPathSafe(entry.path)?.startsWith('HKCU\\Software\\PureA')), JSON.stringify(stagedWrite).slice(0, 200))

      const frozen = stage.freezeCandidate({ enqueue: false })
      const changePaths = (frozen.changes ?? []).map((change) => change.path)
      check(
        '候选里没有 PureB（UNSTAGED 不进候选）',
        !changePaths.some((p) => p.includes('PureB')),
        changePaths.join(' ') || '(no changes)',
      )
      check('候选里有 PureA（正面判定力）', changePaths.some((p) => p.includes('PureA')), changePaths.join(' ') || '(no changes)')

      stub.writes.length = 0
      const applied = stage.apply({ force: true })
      check(
        'apply() 的 writer 从未收到 PureB 的单元（不双重写入）',
        !stub.writes.some((entry) => String(entry[1]).includes('PureB')),
        JSON.stringify(stub.writes),
      )
      check(
        'apply() 也没把 PureB 记成 applied',
        !applied.applied.some((unit) => unit.path.includes('PureB')),
        JSON.stringify({ applied: applied.applied, status: applied.status }),
      )
      const pureJournal = fs.readFileSync(path.join(pureDir, 'registry', OVERLAY_JOURNAL_NAME))
      const pureDecoded = decodeJournalRecords(pureJournal)
      check(
        '纯层的 WAL 里也留了 UNSTAGED 审计记录（宿主侧参考实现与 DLL 同协议）',
        pureDecoded.records.some((record) => record.kind === REG_STAGE_KIND.UNSTAGED),
        pureDecoded.records.map((record) => record.kindName).join(' '),
      )
      check('纯层 WAL 通过契约校验', validateJournalBuffer(pureJournal).ok === true, JSON.stringify(validateJournalBuffer(pureJournal).problems))

      // 单条 UNSTAGED 记录的编解码必须自洽（不依赖上面那次真实运行），
      // 且**混进一份日志后不得进状态**：这是 (c) 的最小可复现形态。
      const lone = journalUnstagedRecord({ api: 'RegSetValueExW', path: 'HKLM\\Software\\X', reason: 'test', unstagedReason: 'WOW64_32KEY' })
      check(
        'journalUnstagedRecord 的形状：kind=6 / UNSTAGED 位 / type=原因码 / status=0 / 无 payload',
        lone.kind === REG_STAGE_KIND.UNSTAGED &&
          lone.flags === REG_STAGE_FLAGS.UNSTAGED &&
          lone.type === REG_STAGE_UNSTAGED_REASON.WOW64_32KEY &&
          lone.status === 0 &&
          lone.valueName === null &&
          lone.data === null,
        JSON.stringify({ kind: lone.kind, flags: lone.flags, type: lone.type, status: lone.status }),
      )
      const loneBuffer = encodeJournalRecord(lone)
      const loneRound = decodeJournalRecords(loneBuffer)
      const loneReplay = replayJournal(loneRound.records)
      check(
        '单条 UNSTAGED 记录可编解码（kindName=UNSTAGED），replay 后 state.ops 为空、unstaged[] 有 1 条',
        loneRound.records.length === 1 &&
          loneRound.records[0].kindName === 'UNSTAGED' &&
          loneRound.records[0].type === REG_STAGE_UNSTAGED_REASON.WOW64_32KEY &&
          loneReplay.state.ops.length === 0 &&
          loneReplay.unstaged.length === 1,
        JSON.stringify({ records: loneRound.records.length, ops: loneReplay.state.ops.length, unstaged: loneReplay.unstaged.length }),
      )
      check('单条 UNSTAGED 记录也通过契约校验', validateJournalBuffer(loneBuffer).ok === true, JSON.stringify(validateJournalBuffer(loneBuffer).problems))
      check(
        '契约校验有判定力：UNSTAGED 记录改成 status=5（伪装成硬拒）必须判红',
        (() => {
          const broken = Buffer.from(loneBuffer)
          broken.writeUInt32LE(5, 24 /* REG_STAGE_RECORD_OFFSETS.status */)
          const verdict = validateJournalBuffer(broken)
          return verdict.ok === false && verdict.problems.some((problem) => problem.code === 'UNSTAGED_STATUS_NONZERO')
        })(),
        'mutation: status 0 -> 5',
      )
      const diff = diffSnapshots(normalizeSnapshot({ root: 'HKLM\\Software\\X', exists: false }), normalizeSnapshot({ root: 'HKLM\\Software\\X', exists: false }))
      check('（自检）空 diff 为空 —— 证明上面的"候选里没有 B"不是靠 diff 恒空', diff.changes.length === 0, JSON.stringify(diff.summary))
    }

    cleanExit = true
  } finally {
    // 不留悬挂注入进程、不留临时键、不留临时目录。
    cleanupRealKey(K64)
    cleanupRealKey(K32)
    fs.rmSync(launcher.dir, { recursive: true, force: true })
    try {
      fs.rmSync(STAGE, { recursive: true, force: true })
    } catch {
      /* 证据目录可能被占用；保留不影响判定（下面会打印路径） */
    }
  }

  W('')
  W('='.repeat(72))
  W(`registry-unstaged-wow64 测试：断言 ${assertions} 项，失败 ${failures} 项，跳过 ${skips} 项`)
  W(`产物: ${OUT}  启动器: 临时目录（%TEMP%，无强制标签）  会话: shim\\.stage\\a2-unstaged-${RUN_ID}`)
  W('='.repeat(72))
  process.exit(failures ? 1 : cleanExit ? 0 : 1)
}

function parseRegistryPathSafe(p) {
  try {
    return parseRegistryPath(p).canonical
  } catch {
    return null
  }
}

try {
  main()
} catch (error) {
  console.error(`[registry-unstaged-wow64] FAILED: ${error.stack ?? error.message}`)
  process.exit(2)
}
