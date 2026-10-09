#!/usr/bin/env node
/**
 * tools/dsh-patches.mjs —— DSH 补丁工具包的**唯一权威**
 * ============================================================================
 * 为什么要有这个文件（本轮任务的核心动机）：
 *   本机的 DSH 是 **npx 缓存安装树**（`...\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\...`），
 *   里面只有编译产物 `lib/*.js`，**没有源码、没有构建工具**。手工改这种树有三个必然结局：
 *     1) 装在缓存里 ⇒ `npm i` / 换版本 / 清缓存 之后**无声消失**；
 *     2) 上游一升级，行号与文案全变 ⇒ 旧的手工改动变成"看起来还在、其实早就错位"的补丁；
 *     3) 没人知道它到底打没打上（"改坏了/丢了没人知道"的经典形态，与本仓 README §8.2 的
 *        registry-guard 同族）。
 *   所以这里把三处修复做成**机器可读清单 + 可重放工具 + 会红的守门测试**：
 *     `patches/dsh/manifest.json`（唯一数据源）→ 本文件（--check/--apply/--revert/--emit-patches）
 *     → `tests/dsh-patch-guard.mjs`（harness 漂移即红）。
 *
 * 硬约束（本文件刻意遵守）：
 *   - **默认不 apply**：`--check` 是默认动作，`--apply` 必须显式给出；本任务期间不得执行 `--apply`。
 *   - **不改 harness 根**：`--check` 只读；`--emit-patches` 只在临时目录里造副本；只有 `--apply`
 *     会写 harness，且写之前必须先建 `<file>.dsh-patch-backup`。
 *   - **不用默认管道**：子进程输出一律重定向到文件描述符（受限令牌下 `stdio:'pipe'` 走命名管道，
 *     会 EPERM —— 见 src/testrunner.mjs 文件头 R10 的说明）。`--emit-patches` 需要 `git`。
 *
 * 退出码：
 *   0 = 一切符合预期（未打补丁 / 已打补丁都算预期）
 *   1 = 用法错误 / 清单读不了 / 工具缺依赖
 *   3 = **找不到 harness 根**（"没找到"必须与"没问题"分开，绝不能静默通过）
 *   4 = **漂移**（安装文件既不是 before 也不是 after，或补丁包自身的原样副本对不上哈希）
 *
 * 用法：
 *   node tools\dsh-patches.mjs --check           # 默认动作；报告三个补丁是"未应用/已应用"
 *   node tools\dsh-patches.mjs --apply           # 幂等应用（本任务期间禁止执行）
 *   node tools\dsh-patches.mjs --revert          # 从备份/原样副本回滚
 *   node tools\dsh-patches.mjs --emit-patches    # 由清单重新生成 patches\dsh\*.patch
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const MANIFEST_PATH = join(REPO, 'patches', 'dsh', 'manifest.json')
export const PATCH_DIR = join(REPO, 'patches', 'dsh')

/** 已知的 npx 缓存根（本机实测路径）。找不到时会扫 `%LOCALAPPDATA%\npm-cache\_npx\*`。 */
export const KNOWN_HARNESS_ROOT = 'C:\\Users\\Administrator\\AppData\\Local\\npm-cache\\_npx\\1e7f6d9597241db0'

/** 退出码（见文件头） */
export const EXIT = Object.freeze({ OK: 0, USAGE: 1, NO_HARNESS: 3, DRIFT: 4 })

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/** 读取清单（唯一数据源）。任何解析失败都抛，不静默降级。 */
export function readManifest(path = MANIFEST_PATH) {
  if (!existsSync(path)) throw new Error(`补丁清单不存在：${path}`)
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed?.patches)) throw new Error(`补丁清单格式不对（缺少 patches 数组）：${path}`)
  return parsed
}

/**
 * 定位 harness 根，三级回退：环境变量 → 已知路径 → 扫 `_npx\*`。
 * 判据不是"目录存在"，而是"该根下真的能读到第一个 entry 的 target 文件"，
 * 否则扫描会命中一个空壳缓存。
 * @returns {{root:string, source:string}|{root:null, tried:string[]}}
 */
export function locateHarnessRoot(manifest = readManifest()) {
  const probe = manifest.patches[0]?.target
  const looksLikeHarness = (root) => typeof root === 'string' && root.length > 0 && typeof probe === 'string' && existsSync(join(root, probe))
  const tried = []

  const fromEnv = process.env.DSH_HARNESS_ROOT
  tried.push(`DSH_HARNESS_ROOT=${fromEnv ?? '(未设置)'}`)
  if (looksLikeHarness(fromEnv)) return { root: resolve(fromEnv), source: 'DSH_HARNESS_ROOT' }

  tried.push(`known=${KNOWN_HARNESS_ROOT}`)
  if (looksLikeHarness(KNOWN_HARNESS_ROOT)) return { root: KNOWN_HARNESS_ROOT, source: 'known-npx-path' }

  const localAppData = process.env.LOCALAPPDATA
  tried.push(`scan=${localAppData ? join(localAppData, 'npm-cache', '_npx') : '(LOCALAPPDATA 未设置)'}`)
  if (localAppData !== undefined) {
    const npxDir = join(localAppData, 'npm-cache', '_npx')
    if (existsSync(npxDir)) {
      for (const name of readdirSync(npxDir)) {
        const candidate = join(npxDir, name)
        try {
          if (!statSync(candidate).isDirectory()) continue
        } catch {
          continue
        }
        if (looksLikeHarness(candidate)) return { root: candidate, source: `scan:${name}` }
      }
    }
  }
  return { root: null, tried }
}

/** 原样副本的绝对路径（补丁包自带，用于离线自洽性校验与 diff 生成）。 */
export const pristinePath = (entry) => join(REPO, entry.pristine)

/** 读原样副本文本；缺失即抛（补丁包自身不完整属于硬错误）。 */
export function readPristine(entry) {
  const path = pristinePath(entry)
  if (!existsSync(path)) throw new Error(`entry ${entry.id}: 原样副本缺失 ${entry.pristine}`)
  return readFileSync(path, 'utf8')
}

/** 片段出现次数（锚点唯一性判据）。 */
export function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0
  return haystack.split(needle).length - 1
}

/**
 * 由任意"等于 before"的文本派生 after 文本。
 * 之所以不直接用原样副本生成 after：`--apply` 必须对**现场安装文件**做替换，
 * 这样"清单里写的 before == 现场文件"这一前提一旦成立，结果就与离线派生的 after 逐字节一致
 * （后者由 tests/dsh-patch-guard.mjs 独立复算并比对 afterSha256）。
 */
export function deriveAfter(text, entry) {
  const n = countOccurrences(text, entry.before)
  if (n !== 1) throw new Error(`entry ${entry.id}: before 片段在目标文本里出现 ${n} 次（必须恰好 1 次）`)
  return text.replace(entry.before, entry.after)
}

/**
 * 补丁包自洽性（不依赖 harness，纯离线）：
 *   - id / target / pristine 唯一且字段齐全
 *   - 原样副本存在，且 sha256 === beforeSha256
 *   - before 片段在副本里恰好出现一次
 *   - 对副本做 before→after 替换后的 sha256 === afterSha256（所以 afterSha256 是**可复算**的）
 * @returns {{errors:string[], details:object[]}}
 */
export function auditManifest(manifest = readManifest()) {
  const errors = []
  const seen = new Map()
  const details = []
  for (const entry of manifest.patches) {
    const info = { id: entry.id, target: entry.target, ok: true, problems: [] }
    for (const field of ['id', 'target', 'before', 'after', 'beforeSha256', 'afterSha256', 'pristine']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        info.problems.push(`缺少字段 ${field}`)
      }
    }
    for (const key of ['id', 'target', 'pristine']) {
      const value = entry[key]
      if (typeof value !== 'string') continue
      if (seen.has(value)) info.problems.push(`${key} 与 ${seen.get(value)} 重复`)
      else seen.set(value, entry.id)
    }
    if (info.problems.length === 0) {
      try {
        const text = readPristine(entry)
        const actualBefore = sha256(Buffer.from(text, 'utf8'))
        if (actualBefore !== entry.beforeSha256) info.problems.push(`原样副本哈希 ${actualBefore} != beforeSha256 ${entry.beforeSha256}`)
        const n = countOccurrences(text, entry.before)
        if (n !== 1) info.problems.push(`before 片段在副本里出现 ${n} 次（必须恰好 1 次）`)
        if (n === 1) {
          const derived = deriveAfter(text, entry)
          const actualAfter = sha256(Buffer.from(derived, 'utf8'))
          if (actualAfter !== entry.afterSha256) info.problems.push(`由副本派生的 after 哈希 ${actualAfter} != afterSha256 ${entry.afterSha256}`)
        }
      } catch (error) {
        info.problems.push(String(error?.message ?? error))
      }
    }
    info.ok = info.problems.length === 0
    if (!info.ok) errors.push(`${entry.id}: ${info.problems.join('; ')}`)
    details.push(info)
  }
  return { errors, details }
}

/**
 * 逐个 entry 对现场安装文件判定状态。
 * @returns {{results:object[], drift:number}}
 */
export function checkEntries(manifest, root) {
  const results = []
  let drift = 0
  for (const entry of manifest.patches) {
    const file = join(root, entry.target)
    const result = { id: entry.id, group: entry.group, target: entry.target, file, status: 'UNKNOWN', detail: '' }
    if (!existsSync(file)) {
      result.status = 'DRIFT'
      result.detail = '目标文件不存在'
      drift += 1
      results.push(result)
      continue
    }
    const text = readFileSync(file, 'utf8')
    const actual = sha256(Buffer.from(text, 'utf8'))
    result.actualSha256 = actual
    if (actual === entry.beforeSha256) {
      const anchors = countOccurrences(text, entry.before)
      result.status = anchors === 1 ? 'NOT-APPLIED' : 'DRIFT'
      result.detail = anchors === 1 ? '锚点完好：before 片段恰好 1 处' : `哈希=before 但 before 片段出现 ${anchors} 次`
    } else if (actual === entry.afterSha256) {
      const anchors = countOccurrences(text, entry.after)
      result.status = anchors === 1 ? 'APPLIED' : 'DRIFT'
      result.detail = anchors === 1 ? '锚点完好：after 片段恰好 1 处' : `哈希=after 但 after 片段出现 ${anchors} 次`
    } else {
      result.status = 'DRIFT'
      result.detail = `既不是 before 也不是 after（期望 ${entry.beforeSha256.slice(0, 12)}… 或 ${entry.afterSha256.slice(0, 12)}…）`
    }
    if (result.status === 'DRIFT') drift += 1
    results.push(result)
  }
  return { results, drift }
}

/** 备份路径：紧挨着被改文件（任务书要求 `<file>.dsh-patch-backup`）。 */
export const backupPath = (file) => `${file}.dsh-patch-backup`

/** `--apply`：幂等；先校验 beforeSha256，再备份，最后写入派生内容并复核 afterSha256。 */
export function applyPatch(entry, root) {
  const file = join(root, entry.target)
  if (!existsSync(file)) throw new Error(`${entry.id}: 目标文件不存在 ${file}`)
  const text = readFileSync(file, 'utf8')
  const actual = sha256(Buffer.from(text, 'utf8'))
  if (actual === entry.afterSha256) return { id: entry.id, action: 'already-applied' }
  if (actual !== entry.beforeSha256) throw new Error(`${entry.id}: 漂移，拒绝应用（现场 ${actual}，期望 before ${entry.beforeSha256}）`)
  const backup = backupPath(file)
  if (existsSync(backup) && sha256(readFileSync(backup)) !== entry.beforeSha256) {
    process.stdout.write(`  ! ${entry.id}: 已存在的备份 ${backup} 不是 before 内容，将被覆盖\n`)
  }
  copyFileSync(file, backup)
  const next = deriveAfter(text, entry)
  const nextHash = sha256(Buffer.from(next, 'utf8'))
  if (nextHash !== entry.afterSha256) throw new Error(`${entry.id}: 派生结果 ${nextHash} != afterSha256 ${entry.afterSha256}（清单与现场不自洽）`)
  writeFileSync(file, next, 'utf8')
  return { id: entry.id, action: 'applied', backup }
}

/** `--revert`：优先用备份（并核对它是 before），否则回落到原样副本。 */
export function revertPatch(entry, root) {
  const file = join(root, entry.target)
  if (!existsSync(file)) throw new Error(`${entry.id}: 目标文件不存在 ${file}`)
  const actual = sha256(readFileSync(file))
  if (actual === entry.beforeSha256) return { id: entry.id, action: 'already-pristine' }
  if (actual !== entry.afterSha256) throw new Error(`${entry.id}: 漂移，拒绝回滚（现场 ${actual}）`)
  const backup = backupPath(file)
  if (existsSync(backup)) {
    if (sha256(readFileSync(backup)) !== entry.beforeSha256) throw new Error(`${entry.id}: 备份 ${backup} 内容不是 before，拒绝用它回滚`)
    copyFileSync(backup, file)
    return { id: entry.id, action: 'reverted-from-backup', backup }
  }
  writeFileSync(file, readPristine(entry), 'utf8')
  return { id: entry.id, action: 'reverted-from-pristine' }
}

/** 在 fd 上跑子进程（**不使用** stdio:'pipe'），stdout/stderr 各写各的文件（避免 git 的 CRLF 警告混进 diff）。 */
function runCaptured(command, argv, cwd, outFile, errFile) {
  mkdirSync(dirname(outFile), { recursive: true })
  mkdirSync(dirname(errFile), { recursive: true })
  const outFd = openSync(outFile, 'w')
  const errFd = openSync(errFile, 'w')
  let result
  try {
    result = spawnSync(command, argv, { cwd, stdio: ['ignore', outFd, errFd], windowsHide: true })
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
  return { status: result.status, error: result.error, text: read(outFile), err: read(errFile) }
}

/**
 * `--emit-patches`：在**临时目录**里摆出 `a/<target>` 与 `b/<target>` 两份副本，
 * 用 `git diff --no-index --no-prefix` 生成人类可读的 unified diff，写到 `patches/dsh/<id>.patch`。
 * 全程不碰 harness 根（a/ 用包内原样副本，b/ 由清单派生）。
 */
export function emitPatches(manifest, outDir = PATCH_DIR) {
  const written = []
  for (const entry of manifest.patches) {
    const work = mkdtempSync(join(tmpdir(), `dsh-patch-${entry.id}-`))
    try {
      const a = join(work, 'a', entry.target)
      const b = join(work, 'b', entry.target)
      mkdirSync(dirname(a), { recursive: true })
      mkdirSync(dirname(b), { recursive: true })
      const before = readPristine(entry)
      writeFileSync(a, before, 'utf8')
      writeFileSync(b, deriveAfter(before, entry), 'utf8')
      const outFile = join(work, 'diff.txt')
      const errFile = join(work, 'diff.err.txt')
      const rel = entry.target.split('/').join('/')
      const run = runCaptured('git', ['diff', '--no-index', '--no-prefix', '--', `a/${rel}`, `b/${rel}`], work, outFile, errFile)
      if (run.error !== undefined && run.error !== null) throw new Error(`${entry.id}: 无法运行 git（${String(run.error.message ?? run.error)}）`)
      // git diff 退出码 1 = 有差异（正常）；0 = 没有差异（清单不自洽）；>1 = 真错误。
      if (run.status !== 1) throw new Error(`${entry.id}: git diff 返回 ${run.status}（期望 1=有差异）\n${run.text}\n${run.err}`)
      const header = [
        `# ${entry.id} — ${entry.title}`,
        `# target (相对 harness 根): ${entry.target}`,
        `# upstream: ${entry.upstream.package}@${entry.upstream.version} (${entry.upstream.directory})`,
        `# status: ${entry.status}`,
        `# rationale: ${entry.rationale}`,
        `# 本文件由 tools/dsh-patches.mjs --emit-patches 从 patches/dsh/manifest.json 派生，请勿手工编辑。`,
        `# 应用方式（在 harness 根下）: git apply -p1 <本文件>  或  node tools\\dsh-patches.mjs --apply`,
        '',
      ].join('\n')
      // git 在 Windows 上可能吐 CRLF；统一成 LF，便于逐字复核。
      const diff = run.text.replace(/\r\n/g, '\n')
      const patchFile = join(outDir, `${entry.id}.patch`)
      writeFileSync(patchFile, `${header}${diff}`, 'utf8')
      written.push(patchFile)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
  return written
}

function usage() {
  return [
    '用法: node tools\\dsh-patches.mjs [--check|--apply|--revert|--emit-patches] [--manifest <path>]',
    '  --check         （默认）定位 harness，逐条判定 未应用/已应用，并复核锚点；漂移即退出码 4',
    '  --apply         幂等应用（先备份 <file>.dsh-patch-backup；漂移即拒绝）',
    '  --revert        回滚（优先用备份，其次用包内原样副本）',
    '  --emit-patches  由清单重新生成 patches\\dsh\\*.patch（临时目录 + git diff --no-index）',
    '  --json          以 JSON 输出 --check 的结果（便于机器消费）',
    '退出码: 0 正常 / 1 用法或清单错误 / 3 找不到 harness 根 / 4 漂移',
  ].join('\n')
}

function main(argv) {
  const args = argv.slice(2)
  const wants = (flag) => args.includes(flag)
  const manifestPath = (() => {
    const i = args.indexOf('--manifest')
    return i >= 0 && args[i + 1] !== undefined ? resolve(args[i + 1]) : MANIFEST_PATH
  })()

  if (wants('--help') || wants('-h')) {
    process.stdout.write(`${usage()}\n`)
    return EXIT.OK
  }

  let manifest
  try {
    manifest = readManifest(manifestPath)
  } catch (error) {
    process.stderr.write(`[清单错误] ${String(error?.message ?? error)}\n`)
    return EXIT.USAGE
  }

  // 补丁包自洽性先查：它决定"清单值不值得信"，因此必须独立于 harness 是否存在。
  const audit = auditManifest(manifest)
  if (audit.errors.length > 0) {
    process.stderr.write('[补丁包漂移] 清单与原样副本不自洽：\n')
    for (const line of audit.errors) process.stderr.write(`  ✗ ${line}\n`)
    return EXIT.DRIFT
  }

  if (wants('--emit-patches')) {
    try {
      const written = emitPatches(manifest)
      for (const file of written) process.stdout.write(`  ✓ 已生成 ${file.slice(REPO.length + 1)}\n`)
      return EXIT.OK
    } catch (error) {
      process.stderr.write(`[生成失败] ${String(error?.message ?? error)}\n`)
      return EXIT.USAGE
    }
  }

  const located = locateHarnessRoot(manifest)
  if (located.root === null) {
    process.stderr.write('[找不到 harness 根] 没有可用的 DSH 安装树；这不是"通过"。\n')
    for (const line of located.tried) process.stderr.write(`  - 已尝试: ${line}\n`)
    process.stderr.write('  修复：设置 DSH_HARNESS_ROOT 指向 npx 缓存根（其下应有 node_modules\\@deepseek-ai\\dsh-sandbox）。\n')
    return EXIT.NO_HARNESS
  }

  if (wants('--apply') || wants('--revert')) {
    const apply = wants('--apply')
    let failures = 0
    for (const entry of manifest.patches) {
      try {
        const outcome = apply ? applyPatch(entry, located.root) : revertPatch(entry, located.root)
        process.stdout.write(`  ✓ ${entry.id}: ${outcome.action}${outcome.backup ? ` (backup ${outcome.backup})` : ''}\n`)
      } catch (error) {
        failures += 1
        process.stderr.write(`  ✗ ${entry.id}: ${String(error?.message ?? error)}\n`)
      }
    }
    return failures > 0 ? EXIT.DRIFT : EXIT.OK
  }

  const { results, drift } = checkEntries(manifest, located.root)
  if (wants('--json')) {
    process.stdout.write(`${JSON.stringify({ harnessRoot: located.root, source: located.source, results, drift }, null, 2)}\n`)
  } else {
    process.stdout.write(`harness 根: ${located.root}  (来源: ${located.source})\n`)
    process.stdout.write(`补丁清单: ${manifestPath.slice(REPO.length + 1)}  (${manifest.patches.length} 个文件级 entry)\n`)
    for (const entry of manifest.patches) {
      const r = results.find((x) => x.id === entry.id)
      const mark = r.status === 'DRIFT' ? '✗' : '✓'
      const human = r.status === 'NOT-APPLIED' ? '未应用' : r.status === 'APPLIED' ? '已应用' : '漂移'
      process.stdout.write(`  ${mark} ${entry.id.padEnd(36)} ${human.padEnd(5)} ${entry.target}\n      ${r.detail}\n`)
    }
    const applied = results.filter((r) => r.status === 'APPLIED').length
    process.stdout.write(`判定: ${results.length - drift}/${results.length} 符合预期（未应用 ${results.length - applied - drift}，已应用 ${applied}，漂移 ${drift}）\n`)
  }
  return drift > 0 ? EXIT.DRIFT : EXIT.OK
}

// 仅在被当作 CLI 调用时执行（测试直接 import 上面的函数，不 spawn 任何子进程）。
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exitCode = main(process.argv)
