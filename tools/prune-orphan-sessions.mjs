#!/usr/bin/env node
/**
 * 孤儿会话清理 ── **默认 dry-run**，显式 `--apply` 才真删（task-9）。
 *
 * ── 什么是"孤儿会话"────────────────────────────────────────────────────────────
 * WinStage 的会话存储落在 `<workspaceRoot>\.dshstage\sessions\<会话键>\`，而
 * `manifest.json` 里**自己声明**了 `workspaceRoot`。所谓孤儿 = **自报的根与它所在的那个根
 * 不是同一个**：这是「shell 半边回退 `process.cwd()`」那个缺陷留下的产物（见
 * `docs/T5-痕迹与根统一报告.md` §4.2）。它们不在当前活动工作区的存储里，
 * 当前面板/命令面**永远看不到也清不掉**，但里面可能有**用户未审批**的暂存内容。
 *
 * ⇒ 因此本脚本的纪律：
 *   1. **默认 dry-run**：不做任何写/删，只列清单（谁将被删、多少条、多大、多久没动过）；
 *   2. **`--apply` 才删**，且**每个目录删前先导出** `<目录>.orphan-backup.json`
 *      （整份 manifest + 队列 + 文件清单），备份写不出来/回读不上就**不删**（fail-closed）；
 *   3. **不跟随重解析点**（符号链接 / junction）：遍历用 `readdirSync(withFileTypes)` 的
 *      `isSymbolicLink()` 判据（`lstatSync().mode & 0x400` 认不出 junction —— 见
 *      `.t/reparse-probe.txt`）；会话目录**自身**是重解析点 ⇒ 拒绝删除；
 *   4. 拒绝删除**活动工作区之内**或与活动根相同的路径（防"参数写错删了正仓"）；
 *   5. `manifest.json` 缺失/读不了/没有 `workspaceRoot` ⇒ **不判为可删**（证据不足不删除）。
 *
 * ── 用法 ───────────────────────────────────────────────────────────────────────
 *   node tools/prune-orphan-sessions.mjs                      # dry-run（默认扫 C:\Users\Administrator）
 *   node tools/prune-orphan-sessions.mjs --json                # dry-run + 机器可读
 *   node tools/prune-orphan-sessions.mjs --apply               # 真删（逐目录先备份）
 *   node tools/prune-orphan-sessions.mjs --self-test           # 自测（临时目录，不碰真实数据）
 *   node tools/prune-orphan-sessions.mjs --root <dir> [--root <dir>...] --workspace <dir>
 *
 * 退出码：0 = 无失败 ｜ 1 = 有删除失败 ｜ 2 = 参数错误
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

/** 存储目录名（与 `src/store.mjs` 的 `STORE_DIR` 同一个字面值） */
export const STORE_DIR = '.dshstage'

/** 默认活动工作区根（本仓库）。可用 `--workspace` 覆盖。 */
const DEFAULT_WORKSPACE = 'C:\\Users\\Administrator\\Desktop\\dsh-winstage-sandbox'

/**
 * 默认扫描根。**为什么是这个**：缺陷态下 shell 半边把根回退成宿主 cwd
 * （`C:\Users\Administrator`），于是孤儿存储在 `C:\Users\Administrator\.dshstage\sessions\`。
 * 脚本只扫 `<root>\.dshstage\sessions`，不会漫游整盘。
 */
const DEFAULT_ROOTS = ['C:\\Users\\Administrator']

/** 备份后缀（与目标同目录，便于人工核查） */
export const BACKUP_SUFFIX = '.orphan-backup.json'

/** 词法规范化：分隔符统一 + 去尾分隔符 + 小写（**不碰磁盘**，与 realpath 区分开） */
export function normalizePath(value) {
  const text = String(value ?? '').trim()
  if (text.length === 0) return ''
  const unified = text.replace(/\//g, '\\')
  const trimmed = unified.length > 3 ? unified.replace(/\\+$/, '') : unified
  return trimmed.toLowerCase()
}

/** `a` 是否等于 `b` 或位于 `b` 之内（词法比较，两侧先 normalize） */
export function isInsidePathOrSame(a, b) {
  const left = normalizePath(a)
  const right = normalizePath(b)
  if (left.length === 0 || right.length === 0) return false
  return left === right || left.startsWith(right.endsWith('\\') ? right : `${right}\\`)
}

/**
 * 该目录项是不是重解析点。
 * ⚠ 必须用 **Dirent**：实测 junction 的 `lstatSync().isSymbolicLink()` 是 false、
 *   `mode & 0x400` 也是 false，唯一可靠判据是 `readdirSync(withFileTypes)` 的 dirent
 *   （证据 `.t/reparse-probe.txt`）。这里两者都查，取并集。
 */
export function isReparseEntry(dirent, fullPath) {
  if (dirent && typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink()) return true
  try {
    const info = lstatSync(fullPath)
    return info.isSymbolicLink() || (Number(info.mode) & 0x400) !== 0
  } catch {
    return false
  }
}

/**
 * 判定**一个路径自身**是不是重解析点（没有现成 Dirent 时用）。
 *
 * ⚠ 必须再做一次父目录 Dirent 复核：Windows junction 的
 *   `lstatSync(path).isSymbolicLink()` 与 `mode & 0x400` **都是 false**
 *   （实测证据 `.t/reparse-probe.txt`），唯一可靠判据是 `readdirSync(withFileTypes)`
 *   的 `dirent.isSymbolicLink()`。少了这一步，"会话目录自身是 junction"就会被
 *   当成普通目录**穿进去**（自测 5 正是抓这个）。
 */
export function isReparsePath(fullPath) {
  try {
    const info = lstatSync(fullPath)
    if (info.isSymbolicLink() || (Number(info.mode) & 0x400) !== 0) return true
  } catch {
    return false
  }
  try {
    const parent = dirname(fullPath)
    const name = basename(fullPath)
    const dirent = readdirSync(parent, { withFileTypes: true }).find((item) => item.name === name)
    return Boolean(dirent && typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink())
  } catch {
    return false
  }
}

/**
 * 广度优先遍历一棵树（**不跟随重解析点**），返回文件清单与最近修改时间。
 * @returns {{files: Array<{rel: string, size: number}>, bytes: number, lastModified: number, reparseSkipped: string[]}}
 */
export function walkTree(root) {
  const files = []
  const reparseSkipped = []
  let bytes = 0
  let lastModified = 0
  const stack = [{ dir: root, rel: '' }]
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      const relPath = rel.length > 0 ? `${rel}${sep}${entry.name}` : entry.name
      if (isReparseEntry(entry, full)) {
        reparseSkipped.push(relPath)
        continue // ★ 绝不下降进重解析点
      }
      if (entry.isDirectory()) {
        stack.push({ dir: full, rel: relPath })
        continue
      }
      if (!entry.isFile()) continue
      let size = 0
      let mtimeMs = 0
      try {
        const info = statSync(full)
        size = info.size
        mtimeMs = info.mtimeMs
      } catch {
        /* 读不到元数据也照常记账（大小 0） */
      }
      files.push({ rel: relPath, size })
      bytes += size
      if (mtimeMs > lastModified) lastModified = mtimeMs
    }
  }
  return { files, bytes, lastModified, reparseSkipped }
}

/** 安全地读一个 JSON 文件（读不到/解析失败返回 undefined） */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** 数一个对象/数组的条目数（manifest.entries 是键值表） */
function countEntries(value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value === 'object') return Object.keys(value).length
  return 0
}

/**
 * 检查一个会话目录，给出"是否可安全删除"的判断与全部证据。
 *
 * @param {string} dir `<...>\.dshstage\sessions\<会话键>` 的绝对路径
 * @param {{expectedWorkspace: string}} options
 * @returns {object} 记录（含 `deletable` / `reason` / `revision` / `entries` / `files` / `lastModified`）
 */
export function inspectSession(dir, { expectedWorkspace }) {
  const name = dir.split(/[\\/]/).pop()
  const record = {
    path: dir,
    name,
    exists: existsSync(dir),
    isReparsePoint: false,
    manifestFound: false,
    manifestReadable: false,
    workspaceRoot: undefined,
    sessionId: undefined,
    revision: undefined,
    entries: 0,
    queuePending: undefined,
    fileCount: 0,
    bytes: 0,
    lastModified: undefined,
    reparseSkipped: [],
    files: [],
    deletable: false,
    reason: '',
  }
  try {
    record.isReparsePoint = isReparsePath(dir)
  } catch {
    record.reason = 'stat-failed'
    return record
  }
  if (!record.exists) {
    record.reason = 'missing'
    return record
  }
  if (record.isReparsePoint) {
    record.reason = 'reparse-point (拒绝：不跟随重解析点)'
    return record
  }
  const walked = walkTree(dir)
  record.fileCount = walked.files.length
  record.bytes = walked.bytes
  record.lastModified = walked.lastModified > 0 ? new Date(walked.lastModified).toISOString() : undefined
  record.reparseSkipped = walked.reparseSkipped
  record.files = walked.files

  const manifestPath = join(dir, 'manifest.json')
  record.manifestFound = existsSync(manifestPath)
  if (!record.manifestFound) {
    record.reason = 'no-manifest (证据不足，不删)'
    return record
  }
  const manifest = readJson(manifestPath)
  if (!manifest || typeof manifest !== 'object') {
    record.reason = 'manifest-unreadable (证据不足，不删)'
    return record
  }
  record.manifestReadable = true
  record.workspaceRoot = typeof manifest.workspaceRoot === 'string' ? manifest.workspaceRoot : undefined
  record.sessionId = typeof manifest.sessionId === 'string' ? manifest.sessionId : undefined
  record.revision = typeof manifest.revision === 'number' ? manifest.revision : undefined
  record.entries = countEntries(manifest.entries)
  const queue = readJson(join(dir, 'queue.json'))
  record.queuePending = queue ? countEntries(queue.candidates ?? queue.pending ?? queue) : undefined

  if (typeof record.workspaceRoot !== 'string' || record.workspaceRoot.length === 0) {
    record.reason = 'manifest-without-workspaceRoot (证据不足，不删)'
    return record
  }
  if (normalizePath(record.workspaceRoot) === normalizePath(expectedWorkspace)) {
    record.reason = 'belongs-to-active-root (属于活动工作区，不删)'
    return record
  }
  record.deletable = true
  record.reason = 'orphan: manifest.workspaceRoot != 活动根（缺陷态遗留）'
  return record
}

/**
 * 扫描一批根，产出计划（**只读**，不做任何修改）。
 * @param {{roots?: string[], expectedWorkspace?: string}} [options]
 */
export function planPrune(options = {}) {
  const expectedWorkspace = options.expectedWorkspace ?? DEFAULT_WORKSPACE
  const roots = options.roots ?? DEFAULT_ROOTS
  const sessions = []
  for (const root of roots) {
    const sessionsDir = join(root, STORE_DIR, 'sessions')
    if (!existsSync(sessionsDir)) continue
    let names = []
    try {
      names = readdirSync(sessionsDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of names) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      const dir = join(sessionsDir, entry.name)
      const record = inspectSession(dir, { expectedWorkspace })
      record.sweepRoot = root
      sessions.push(record)
    }
  }
  const orphans = sessions.filter((record) => record.deletable === true)
  return {
    at: new Date().toISOString(),
    expectedWorkspace,
    roots,
    sessions,
    orphans,
    summary: {
      scanned: sessions.length,
      orphans: orphans.length,
      orphanEntries: orphans.reduce((sum, record) => sum + record.entries, 0),
      orphanBytes: orphans.reduce((sum, record) => sum + record.bytes, 0),
    },
  }
}

/**
 * 执行删除（**只有 `--apply` 会走到这里**）。
 *
 * 每个目录：① 写 `<目录>.orphan-backup.json`；② **回读校验**备份存在且路径一致；
 * ③ `rmSync`。任一前置步骤失败 ⇒ **不删**（fail-closed），如实记 reason。
 *
 * @param {object} plan `planPrune()` 的结果
 * @param {{expectedWorkspace?: string}} [options]
 */
export function applyPrune(plan, options = {}) {
  const expectedWorkspace = options.expectedWorkspace ?? plan.expectedWorkspace ?? DEFAULT_WORKSPACE
  const sweepRoots = Array.isArray(plan.roots) ? plan.roots : []
  const results = []
  for (const record of plan.orphans ?? []) {
    const target = record.path
    const outcome = { path: target, entries: record.entries, backupPath: undefined, action: 'skipped', reason: '' }
    // 守卫 1：目标必须在某条扫描根的 `sessions/` 之下
    const insideSweep = sweepRoots.some((root) => isInsidePathOrSame(target, join(root, STORE_DIR, 'sessions')))
    if (!insideSweep) {
      outcome.reason = 'outside-sweep-roots'
      results.push(outcome)
      continue
    }
    // 守卫 2：绝不动活动工作区之内的东西
    if (isInsidePathOrSame(target, expectedWorkspace)) {
      outcome.reason = 'inside-active-workspace (拒绝)'
      results.push(outcome)
      continue
    }
    // 守卫 3：目标自身不得是重解析点（不跟随，也不删链接指向的东西）
    try {
      if (isReparsePath(target)) {
        outcome.reason = 'reparse-point (拒绝)'
        results.push(outcome)
        continue
      }
    } catch (error) {
      outcome.reason = `stat-failed: ${error?.message ?? error}`
      results.push(outcome)
      continue
    }
    // ① 备份（写不出来 ⇒ 不删）
    const backupPath = `${target}${BACKUP_SUFFIX}`
    try {
      const walked = walkTree(target)
      const payload = {
        at: new Date().toISOString(),
        note: 'WinStage 孤儿会话快照（由 tools/prune-orphan-sessions.mjs --apply 在删除前导出）',
        path: target,
        expectedWorkspace,
        manifestWorkspaceRoot: record.workspaceRoot,
        sessionId: record.sessionId,
        revision: record.revision,
        entries: record.entries,
        queuePending: record.queuePending,
        manifest: readJson(join(target, 'manifest.json')),
        queue: readJson(join(target, 'queue.json')),
        files: walked.files,
        bytes: walked.bytes,
        reparseSkipped: walked.reparseSkipped,
      }
      writeFileSync(backupPath, JSON.stringify(payload, null, 2), 'utf8')
    } catch (error) {
      outcome.reason = `backup-failed (不删): ${error?.message ?? error}`
      results.push(outcome)
      continue
    }
    // ② 回读校验：宁可多读一次，也不在"备份可能没落盘"的情况下删
    const verify = readJson(backupPath)
    if (!verify || normalizePath(verify.path) !== normalizePath(target)) {
      outcome.reason = 'backup-verify-failed (不删)'
      results.push(outcome)
      continue
    }
    outcome.backupPath = backupPath
    // ③ 删除
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 2 })
      outcome.action = existsSync(target) ? 'delete-incomplete' : 'deleted'
      outcome.reason = outcome.action === 'deleted' ? 'ok' : '删除后目录仍存在'
    } catch (error) {
      outcome.action = 'delete-failed'
      outcome.reason = String(error?.message ?? error)
    }
    results.push(outcome)
  }
  return results
}

// ==================== CLI ====================

function parseArgs(argv) {
  const out = { roots: [], workspace: undefined, apply: false, json: false, selfTest: false, help: false }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--root') out.roots.push(argv[++i])
    else if (token === '--workspace') out.workspace = argv[++i]
    else if (token === '--apply') out.apply = true
    else if (token === '--json') out.json = true
    else if (token === '--self-test') out.selfTest = true
    else if (token === '--help' || token === '-h') out.help = true
    else if (typeof token === 'string' && token.startsWith('--')) out.error = `未知参数：${token}`
  }
  return out
}

function formatHuman(plan, results) {
  const lines = []
  lines.push('WinStage 孤儿会话清理（默认 dry-run；--apply 才真删）')
  lines.push(`  活动工作区：${plan.expectedWorkspace}`)
  lines.push(`  扫描根：${plan.roots.join(' , ')}`)
  lines.push('')
  lines.push(
    `  会话目录 ${plan.sessions.length} 个；判定可删 ${plan.orphans.length} 个` +
      `（共 ${plan.summary.orphanEntries} 条条目、${plan.summary.orphanBytes} 字节）`,
  )
  lines.push('')
  for (const record of plan.sessions) {
    lines.push(`  - ${record.path}`)
    lines.push(
      `      revision=${record.revision ?? '(无)'} entries=${record.entries} queuePending=${record.queuePending ?? '(无)'} ` +
        `files=${record.fileCount} bytes=${record.bytes} lastModified=${record.lastModified ?? '(未知)'}`,
    )
    lines.push(`      manifest.workspaceRoot=${record.workspaceRoot ?? '(无)'}`)
    lines.push(
      `      可删=${record.deletable ? 'YES' : 'NO'} 理由=${record.reason}` +
        (record.reparseSkipped?.length ? `（跳过的重解析点：${record.reparseSkipped.join(',')}）` : ''),
    )
  }
  if (Array.isArray(results)) {
    lines.push('')
    lines.push('  ── 执行结果（--apply）──')
    for (const item of results) {
      lines.push(
        `  * [${item.action}] ${item.path}${item.backupPath ? ` → 备份 ${item.backupPath}` : ''}` +
          `${item.reason ? ` (${item.reason})` : ''}`,
      )
    }
  } else {
    lines.push('')
    lines.push('  （dry-run：**没有**任何写/删。要执行请加 --apply）')
  }
  return lines.join('\n')
}

/** 就地跑一次 CLI（自测用）：临时替换 argv 并捕获 stdout */
function runCli(argv) {
  const savedArgv = process.argv
  const savedWrite = process.stdout.write
  let output = ''
  process.argv = ['node', 'prune-orphan-sessions.mjs', ...argv]
  process.stdout.write = (chunk) => {
    output += String(chunk)
    return true
  }
  try {
    main()
  } finally {
    process.stdout.write = savedWrite
    process.argv = savedArgv
  }
  return output
}

// ==================== 自测（临时目录，不碰真实数据）====================

/**
 * 自测：证明 dry-run 不删、`--apply` 删且留备份、重解析点不被跟随、
 * "自报根 === 活动根"的会话**不**被判为可删、伪造记录被守卫拦下。
 */
export function selfTest() {
  const lines = []
  let pass = 0
  let fail = 0
  const check = (name, ok, detail) => {
    if (ok) {
      pass += 1
      lines.push(`[PASS] ${name}`)
    } else {
      fail += 1
      lines.push(`[FAIL] ${name} :: ${JSON.stringify(detail ?? null)}`)
    }
  }
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'prune-selftest-')))
  const ACTIVE = join(base, 'active-ws')
  const SWEEP = join(base, 'fallback-root')
  const SESSIONS = join(SWEEP, STORE_DIR, 'sessions')
  const OUTSIDE = join(base, 'outside-target')
  const LINK_TRAP = join(base, 'dummy-session-target')
  mkdirSync(ACTIVE, { recursive: true })
  mkdirSync(SESSIONS, { recursive: true })
  mkdirSync(OUTSIDE, { recursive: true })
  mkdirSync(LINK_TRAP, { recursive: true })
  writeFileSync(join(OUTSIDE, 'outside.txt'), 'outside\n', 'utf8')
  // 陷阱目标：**自报根 ≠ 活动根**（若脚本跟随 junction，就会把它判成可删并删掉）
  writeFileSync(
    join(LINK_TRAP, 'manifest.json'),
    JSON.stringify({ workspaceRoot: SWEEP, sessionId: 'trap', revision: 9, entries: { trap: {} } }, null, 2),
    'utf8',
  )

  // 孤儿 1：自报根 ≠ 活动根（缺陷态形态）
  const orphan = join(SESSIONS, 'session-orphan-1')
  mkdirSync(join(orphan, 'staged'), { recursive: true })
  writeFileSync(
    join(orphan, 'manifest.json'),
    JSON.stringify(
      { workspaceRoot: SWEEP, sessionId: 'orphan-1', revision: 3, entries: { 'a.txt': {}, 'b.txt': {} } },
      null,
      2,
    ),
    'utf8',
  )
  writeFileSync(join(orphan, 'queue.json'), JSON.stringify({ candidates: [{ id: 'cand-1' }] }), 'utf8')
  writeFileSync(join(orphan, 'staged', 'a.txt'), 'a\n', 'utf8')

  // 对照：自报根 === 活动根（绝不能删）
  const control = join(SESSIONS, 'session-active-1')
  mkdirSync(control, { recursive: true })
  writeFileSync(
    join(control, 'manifest.json'),
    JSON.stringify({ workspaceRoot: ACTIVE, sessionId: 'active-1', revision: 0, entries: {} }, null, 2),
    'utf8',
  )

  // 孤儿 2：内含 junction（不得被跟随）
  const orphan2 = join(SESSIONS, 'session-orphan-2')
  mkdirSync(orphan2, { recursive: true })
  writeFileSync(
    join(orphan2, 'manifest.json'),
    JSON.stringify({ workspaceRoot: SWEEP, sessionId: 'orphan-2', revision: 1, entries: {} }, null, 2),
    'utf8',
  )
  let junctionOk = true
  try {
    symlinkSync(OUTSIDE, join(orphan2, 'junc'), 'junction')
  } catch {
    junctionOk = false
  }

  // 会话目录**自身**是 junction（指向陷阱目标 ⇒ 必须拒绝，且陷阱目标必须活着）
  let junctionSessionOk = true
  try {
    symlinkSync(LINK_TRAP, join(SESSIONS, 'session-junction-3'), 'junction')
  } catch {
    junctionSessionOk = false
  }

  const plan = planPrune({ roots: [SWEEP], expectedWorkspace: ACTIVE })
  const byName = new Map(plan.sessions.map((record) => [record.name, record]))
  check(
    '自测 1：孤儿被判可删（revision/entries/queuePending 如实读出）',
    byName.get('session-orphan-1')?.deletable === true &&
      byName.get('session-orphan-1')?.revision === 3 &&
      byName.get('session-orphan-1')?.entries === 2 &&
      byName.get('session-orphan-1')?.queuePending === 1,
    byName.get('session-orphan-1'),
  )
  check(
    '自测 2：自报根 === 活动根的会话**不**可删',
    byName.get('session-active-1')?.deletable === false,
    byName.get('session-active-1'),
  )
  check('自测 3：summary 如实结算（≥2 个孤儿、≥2 条条目）', plan.summary.orphans >= 2 && plan.summary.orphanEntries >= 2, plan.summary)
  if (junctionOk) {
    const o2 = byName.get('session-orphan-2')
    check(
      '自测 4：遍历不跟随 junction（外部文件不进清单，且如实记下跳过的重解析点）',
      o2?.deletable === true &&
        !(o2?.files ?? []).some((f) => String(f.rel).includes('outside.txt')) &&
        (o2?.reparseSkipped ?? []).includes('junc'),
      { files: o2?.files, skipped: o2?.reparseSkipped },
    )
  } else {
    lines.push('[SKIP] 自测 4：本机无法创建 junction（symlinkSync junction 失败）')
  }
  if (junctionSessionOk) {
    check(
      '自测 5：会话目录自身是 junction ⇒ 拒绝删除（不跟随到陷阱目标）',
      byName.get('session-junction-3')?.deletable === false,
      byName.get('session-junction-3'),
    )
  } else {
    lines.push('[SKIP] 自测 5：本机无法创建 junction（symlinkSync junction 失败）')
  }

  const backupPath = `${orphan}${BACKUP_SUFFIX}`
  const entriesBefore = readdirSync(orphan).length

  // ── dry-run（走真正的 CLI 入口）⇒ 不删、不写 ──
  const dryOut = runCli(['--root', SWEEP, '--workspace', ACTIVE, '--json'])
  check(
    '自测 6：dry-run 不删也不写（目录仍在、条目数不变、无备份文件、输出注明 dry-run）',
    existsSync(orphan) &&
      readdirSync(orphan).length === entriesBefore &&
      !existsSync(backupPath) &&
      dryOut.includes('dry-run'),
    { exists: existsSync(orphan), backup: existsSync(backupPath), mode: dryOut.slice(0, 40) },
  )

  // ── --apply ⇒ 删 + 留备份 ──
  const applyOut = runCli(['--root', SWEEP, '--workspace', ACTIVE, '--apply', '--json'])
  const backup = existsSync(backupPath) ? readJson(backupPath) : undefined
  check(
    '自测 7：--apply 真删了孤儿目录（且输出 action=deleted）',
    !existsSync(orphan) && applyOut.includes('"action": "deleted"'),
    { exists: existsSync(orphan), tail: applyOut.slice(-200) },
  )
  check(
    '自测 8：删除前导出的备份存在，且含 revision/entries/files/queue',
    Boolean(backup) &&
      backup.revision === 3 &&
      backup.entries === 2 &&
      Array.isArray(backup.files) &&
      backup.files.some((f) => String(f.rel).includes('a.txt')) &&
      Boolean(backup.queue) &&
      backup.reparseSkipped !== undefined,
    { backupPath, revision: backup?.revision, entries: backup?.entries, files: backup?.files },
  )
  check(
    '自测 9：对照会话（属于活动根）没有被动过',
    existsSync(control) && !existsSync(`${control}${BACKUP_SUFFIX}`),
    { exists: existsSync(control) },
  )
  check(
    '自测 10：删除**没有跟随重解析点** —— junction 指向的外部目标与陷阱目标都活着',
    existsSync(join(OUTSIDE, 'outside.txt')) && existsSync(join(LINK_TRAP, 'manifest.json')),
    { outside: existsSync(join(OUTSIDE, 'outside.txt')), trap: existsSync(join(LINK_TRAP, 'manifest.json')) },
  )

  // ── 守卫：伪造一条指向活动工作区的记录 ⇒ 必须拒绝 ──
  const forged = applyPrune(
    { roots: [SWEEP], expectedWorkspace: ACTIVE, orphans: [{ path: ACTIVE, entries: 0 }] },
    { expectedWorkspace: ACTIVE },
  )
  check(
    '自测 11：指向活动工作区的伪造记录被守卫拦下且未删',
    forged[0]?.action === 'skipped' && existsSync(ACTIVE),
    forged[0],
  )

  try {
    rmSync(base, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
  return { pass, fail, lines }
}

// ==================== 入口 ====================

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.error) {
    process.stderr.write(`${args.error}\n`)
    process.exitCode = 2
    return
  }
  if (args.help) {
    process.stdout.write(
      'usage: node tools/prune-orphan-sessions.mjs [--root <dir>]... [--workspace <dir>] [--apply] [--json] [--self-test]\n',
    )
    return
  }
  if (args.selfTest) {
    const result = selfTest()
    process.stdout.write(`孤儿清理脚本自测：${result.pass} PASS / ${result.fail} FAIL\n${result.lines.join('\n')}\n`)
    process.exitCode = result.fail === 0 ? 0 : 1
    return
  }
  const plan = planPrune({
    roots: args.roots.length > 0 ? args.roots.map((root) => resolve(root)) : DEFAULT_ROOTS,
    expectedWorkspace: args.workspace ? resolve(args.workspace) : DEFAULT_WORKSPACE,
  })
  if (!args.apply) {
    if (args.json) process.stdout.write(`${JSON.stringify({ mode: 'dry-run', plan }, null, 2)}\n`)
    else process.stdout.write(`${formatHuman(plan)}\n`)
    return
  }
  const results = applyPrune(plan, { expectedWorkspace: plan.expectedWorkspace })
  const failed = results.filter((item) => item.action !== 'deleted')
  if (args.json) process.stdout.write(`${JSON.stringify({ mode: 'apply', plan, results }, null, 2)}\n`)
  else process.stdout.write(`${formatHuman(plan, results)}\n`)
  process.exitCode = failed.length > 0 ? 1 : 0
}

// 只有直接运行本文件时才走 CLI（被 import 做自测/复用时不动）
const invokedDirectly =
  typeof process.argv[1] === 'string' && normalizePath(process.argv[1]).endsWith(normalizePath('prune-orphan-sessions.mjs'))
if (invokedDirectly) main()
