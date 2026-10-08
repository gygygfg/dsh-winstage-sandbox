/**
 * 修复阶段的两条针对性回归：D8（暂存树里的重解析点）与 D10（合成父目录被误报损坏）。
 *
 * ── 为什么必须单独有这条测试 ────────────────────────────────────────────────
 * 这两条缺陷的共同点是"**健康状态被误判成故障**"，而且都不是靠读代码能长期防住的：
 *   D8  `snapshotStagedTree()` 缺 `isSymbolicLink()`/重解析点守卫 →
 *       `readFileSync(junction)` 跟随解析到目录 → `EISDIR`，`cli exec` **在命令之前**就崩。
 *   D10 `verifyProjection()` 的 blob 分支缺 `kind !== 'dir'` 守卫 →
 *       健康工作区被打印"损坏项 N 个（禁止发布）"。
 * 两者都已经真实发生过（原始证据见 `.t\sbx3\t-fs\out\13-cli-exec-junction-crash.err`、
 * `.t\sbx3\t-fs\out\cli-init-healthy.json`），因此这里把它们钉成断言。
 *
 * ── 关于 D8 的"真实 junction"（task-7 修好后**不再有 SKIP 分支**）──────────────
 * 早期版本用 `cmd /c mklink /J` 建 junction，并声称"需要管理员或开发者模式"——
 * 这条**是错的**：junction 与特权无关，失败的是**受限会话里起不了 cmd.exe**；
 * 而"受限时打印 `--SKIP--` 继续跑"让 D8 在最需要它的场景里**一次都没真跑过**，
 * 也正因如此，`src\workspace.mjs` 里那个恒 false 的假判据（`mode & 0x400`）长期假绿。
 * 现在改用 `fs.symlinkSync(target, path, 'junction')`：不依赖外部 exe、不需要特权，
 * 在受限会话里同样能建（`[实测]` 见 `--probe-reparse` 输出）。
 *
 * ── 追加（本轮修复）：junction 的 `lstatSync` 形态是**宿主 / DSH 文件策略相关**的 ─────────
 * `[实测]` **同一台机器**上、同一段 `fs.symlinkSync(…,'junction')`，两种 DSH 文件策略给出两种 lstat：
 *   · `workspace-write`（更早的受限会话）：`mode=0x41b6`、`isSymbolicLink()===false`、
 *     `isDirectory()===true`（lstat **看不见** junction，它看起来就是个目录）；
 *   · `danger-full-access`（本轮）：`mode=0xa1b6`、`isSymbolicLink()===true`、
 *     `isDirectory()===false`（lstat **看得见** junction）。
 * 因此**断言只许钉"安全结局"**（重解析点永不跟随 / 树外内容永不进快照），
 * **不许钉某个 lstat 形态** —— 本轮那条"旧判据必然失效"的断言就是钉宿主事实钉红的（见 D8 段 ②/③）。
 * 两种形态下都恒真的是：`mode & 0x400 === 0`（`Stats.mode` 是 POSIX 位）与
 * `dirent.isSymbolicLink()===true`/`dirent.isDirectory()===false`。
 *
 * 用法：
 *   node tests\workspace-regressions.mjs
 *   node tests\workspace-regressions.mjs --plant           # 变异体：判据改回假判据，D8 必须见红
 *   node tests\workspace-regressions.mjs --probe-reparse   # 重解析点判据选型台（只出证据）
 */

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Workspace } from '../src/workspace.mjs'
import { hashAbsent, sha256Buffer } from '../src/store.mjs'
import { WINDOWS_HIDE, suppressWindowsCriticalErrorDialogs } from '../src/spawn-window.mjs'

suppressWindowsCriticalErrorDialogs()

const PLANT = process.argv.includes('--plant')
const PROBE_REPARSE = process.argv.includes('--probe-reparse')
const SCRATCH = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox\\.t\\sbx3\\fix\\ws\\regressions'
const W = (s) => process.stdout.write(`${s}\n`)
let assertions = 0
let failures = 0
const check = (name, ok, detail) => {
  assertions += 1
  if (!ok) failures += 1
  W(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `\n      证据: ${detail}` : ''}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// `--probe-reparse`：**重解析点判据的实测选型台**（可复现证据，不是断言）
// ═══════════════════════════════════════════════════════════════════════════
//
// 为什么要有它（task-7 的纪律要求）：本项目吃过两次"凭记忆写字段"的亏
// （缺陷 5 结构体偏移、缺陷 13 漏标志位），所以"用哪个信号判 junction"这个问题
// **不许靠推断**，必须在一台真机上把候选信号逐个测出来：
//     `lstat.isSymbolicLink()` / `lstat.mode & 0x400` / `fs.readlinkSync()` /
//     `readdir(withFileTypes).isSymbolicLink()` / `realpathSync.native()` 前缀比较。
// 对照组必须同时包含：真 junction（两种建法）、普通目录、普通文件、符号链接文件、
// 以及**8.3 短名目录**（它会改变 `realpathSync` 结果但**不是**重解析点，是最容易误判的对照）。
if (PROBE_REPARSE) {
  const { readlinkSync, realpathSync, symlinkSync, statSync } = await import('node:fs')
  const base = join(SCRATCH, 'reparse-probe')
  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  const plainDir = join(base, 'plain-dir')
  const plainFile = join(base, 'plain.txt')
  mkdirSync(plainDir, { recursive: true })
  writeFileSync(plainFile, 'plain\n')
  const junctionFs = join(base, 'junction-fs')
  const junctionMklink = join(base, 'junction-mklink')
  const fileLink = join(base, 'file-link')
  let fsJunctionError = null
  try {
    symlinkSync(base, junctionFs, 'junction')
  } catch (error) {
    fsJunctionError = `${error.code}: ${error.message}`
  }
  const mklinkLog = join(base, 'mklink.txt')
  const mklinkFd = openSync(mklinkLog, 'w')
  const mklinkRun = spawnSync(process.env.ComSpec || 'cmd.exe', ['/c', 'mklink', '/J', junctionMklink, base], {
    stdio: ['ignore', mklinkFd, mklinkFd],
    windowsHide: WINDOWS_HIDE,
  })
  closeSync(mklinkFd)
  let fileLinkError = null
  try {
    symlinkSync(plainFile, fileLink, 'file')
  } catch (error) {
    fileLinkError = `${error.code}: ${error.message}`
  }
  // 8.3 短名对照：`C:\Users\ADMINI~1` 解析到长名，但**不是**重解析点
  const shortDir = 'C:\\Users\\ADMINI~1'

  const dirEntries = (() => {
    try {
      return readdirSync(base, { withFileTypes: true }).map((d) => ({
        name: d.name,
        isSymbolicLink: d.isSymbolicLink(),
        isDirectory: d.isDirectory(),
      }))
    } catch (error) {
      return `ERR ${error.code}`
    }
  })()

  const candidates = [
    ['plain-dir（普通目录）', plainDir],
    ['plain.txt（普通文件）', plainFile],
    ['junction-fs（fs.symlinkSync type=junction）', junctionFs],
    ['junction-mklink（cmd mklink /J）', junctionMklink],
    ['file-link（符号链接文件）', fileLink],
    ['C:\\Users\\ADMINI~1（8.3 短名，非重解析点）', shortDir],
  ]
  W('=== --probe-reparse：候选判据逐项实测（原始输出，供报告引用）===')
  W(`  环境：node ${process.version} / ${process.platform}`)
  W(`  fs.symlinkSync(junction) 结果：${fsJunctionError ?? 'OK'}`)
  W(`  cmd mklink /J 结果：status=${mklinkRun.status} error=${mklinkRun.error?.code ?? '-'} exists=${existsSync(junctionMklink)}`)
  W(`  fs.symlinkSync(file) 结果：${fileLinkError ?? 'OK'}`)
  for (const [label, path] of candidates) {
    let lst = null
    try {
      const s = lstatSync(path)
      lst = { isSymbolicLink: s.isSymbolicLink(), isDirectory: s.isDirectory(), isFile: s.isFile(), mode_hex: `0x${s.mode.toString(16)}`, mode_and_0x400: (s.mode & 0x400) !== 0 }
    } catch (error) {
      lst = `ERR ${error.code}`
    }
    let readlink
    try {
      readlink = { ok: true, target: readlinkSync(path) }
    } catch (error) {
      readlink = { ok: false, code: error.code, message: String(error.message).slice(0, 60) }
    }
    let realpath
    try {
      realpath = realpathSync.native(path)
    } catch (error) {
      realpath = `ERR ${error.code}`
    }
    let devIno = null
    try {
      const s = statSync(path)
      devIno = { dev: String(s.dev), ino: String(s.ino), isDirectory: s.isDirectory() }
    } catch (error) {
      devIno = `ERR ${error.code}`
    }
    W(`\n  ── ${label}`)
    W(`     lstat      = ${JSON.stringify(lst)}`)
    W(`     readlink   = ${JSON.stringify(readlink)}`)
    W(`     realpath   = ${realpath}`)
    W(`     stat dev/ino = ${JSON.stringify(devIno)}`)
  }
  W(`\n  readdir(withFileTypes) 的 dirent 判定：${JSON.stringify(dirEntries)}`)
  rmSync(base, { recursive: true, force: true })
  W('')
  W('（--probe-reparse 只出证据，不做断言；判定选型与断言见下面的 D8 段）')
  process.exit(0)
}

function freshWorkspace(tag) {
  const root = join(SCRATCH, tag)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * 建好 D8 的现场并跑一遍关键动作（普通模式与 `--plant` 变异体**共用同一份现场**，
 * 避免"测试为绿色单独写一套"那种替身失真）。
 *
 * 现场形状（与生产里崩过的形状一致）：
 *   `<root>\.dshstage\staged\junc` 是指向 `<root>`（stagedDir 的**祖先**）的 junction
 *   ⇒ 若 walker 跟随解析，就会 staged → junc → root → .dshstage → staged → … 自指递归。
 */
function d8Fixture(tag, WorkspaceImpl) {
  const root = freshWorkspace(tag)
  const ws = new WorkspaceImpl({ workspaceRoot: root }).init({ sessionId: `reg-${tag}` })
  ws.writeFile(join(root, 'plain.txt'), 'plain\n', { origin: 'test' })
  const stagedDir = ws.store.stagedDir
  mkdirSync(join(stagedDir, 'plaindir'), { recursive: true })
  writeFileSync(join(stagedDir, 'plaindir', 'inner.txt'), 'inner\n')
  // junction **之前**的基线（captureAfterExecution 需要它才谈得上"被删除"）
  const before = ws.snapshotStagedTree()
  const junction = join(stagedDir, 'junc')
  let created = false
  let createError = null
  try {
    symlinkSync(root, junction, 'junction')
    created = existsSync(junction)
  } catch (error) {
    createError = `${error.code ?? ''}: ${error.message}`
  }
  let dirent = null
  let info = null
  if (created) {
    dirent = readdirSync(stagedDir, { withFileTypes: true }).find((entry) => entry.name === 'junc') ?? null
    try {
      info = lstatSync(junction)
    } catch (error) {
      info = { error: `${error.code ?? ''}: ${error.message}` }
    }
  }
  let snapshot
  let snapshotError
  try {
    snapshot = ws.snapshotStagedTree()
  } catch (error) {
    snapshotError = error
  }
  let captured
  let captureError
  try {
    captured = ws.captureAfterExecution(before)
  } catch (error) {
    captureError = error
  }
  return { root, ws, stagedDir, junction, created, createError, dirent, info, before, snapshot, snapshotError, captured, captureError }
}

W('=== 1. D10：健康工作区的投影校验必须报"零损坏" ===')
{
  const root = freshWorkspace('d10-healthy')
  mkdirSync(join(root, 'sub'), { recursive: true })
  writeFileSync(join(root, 'sub', 'seed.txt'), 'seed\n')
  const ws = new Workspace({ workspaceRoot: root }).init({ sessionId: 'reg-d10' })
  // 制造一个**合成父目录**：写一个深层新文件，父目录在真实磁盘上不存在
  ws.writeFile(join(root, 'deep', 'nested', 'new.txt'), 'new\n', { origin: 'test' })
  const again = new Workspace({ workspaceRoot: root }).init({ sessionId: 'reg-d10' })

  const synthetic = again.entryOf('deep')
  check('合成父目录条目存在且 kind=dir', synthetic?.kind === 'dir', JSON.stringify(synthetic))
  check(
    '合成父目录的 stagedHash = absent（目录天生没有内容对象）',
    synthetic?.stagedHash === hashAbsent(),
    String(synthetic?.stagedHash),
  )
  check('健康工作区 corruption 为空（D10 修复）', again.corruption.length === 0, JSON.stringify(again.corruption))
}

W('')
W('=== 2. D10 的负例：真正的损坏仍必须被抓到（不能靠"永不报损坏"蒙混过关）===')
{
  const root = freshWorkspace('d10-corrupt')
  const ws = new Workspace({ workspaceRoot: root }).init({ sessionId: 'reg-d10b' })
  ws.writeFile(join(root, 'a.txt'), 'content\n', { origin: 'test' })
  // 手工把 blob 删掉：模拟"记录声明文件存在而存储对象缺失"
  const hash = ws.entryOf('a.txt').stagedHash
  const blobDir = join(root, '.dshstage', 'blobs', hash.slice(0, 2))
  rmSync(join(blobDir, hash), { force: true })
  const again = new Workspace({ workspaceRoot: root }).init({ sessionId: 'reg-d10b' })
  const hit = again.corruption.find((c) => c.path === 'a.txt')
  check('blob 真缺失时 corruption 报出该文件', hit !== undefined && hit.reason === 'staged blob missing', JSON.stringify(again.corruption))
}

W('')
W('=== 3. D8：暂存树里的重解析点不得被跟随（junction 逃逸 / 自指环路） ===')
{
  const f = d8Fixture('d8-junction', Workspace)

  // ① 现场必须真的成立 —— **不允许再用 --SKIP-- 把这条场景整个绕过**
  check(
    'D8 场景真的建出了 junction（`fs.symlinkSync(…,"junction")`，不依赖 cmd.exe/特权）',
    f.created,
    f.created ? `${f.junction} → ${f.root}` : `建立失败：${f.createError ?? '(未知)'}`,
  )
  // ② 判据的判定力。⚠ 这一段的 lstat 字段是**宿主 / DSH 文件策略相关**的（原观测保留在这里）：
  //    原断言（本轮变红的那一条，钉死宿主事实）：
  //      '实测：旧判据必然失效 —— junction 的 `lstat.isSymbolicLink()=false` 且 `mode & 0x400 = 0`'
  //      `[实测]` 它只在 workspace-write 形态下成立：`mode=0x41b6`、`isSymbolicLink()=false`、
  //      `isDirectory()=true`（lstat 看不见 junction）。
  //      `[实测·本轮 danger-full-access]` 本会话里 junction 的 lstat 是 `mode=0xa1b6`、
  //      `isSymbolicLink()=true`、`isDirectory()=false` ⇒ 原断言**恒红**，但这是环境变了、
  //      不是防线坏了。因此改成**行为分流**：先测出本机形态，再断言该形态下 guard 的**安全结局**。
  const lstatSeesLink = typeof f.info?.isSymbolicLink === 'function' && f.info.isSymbolicLink() === true
  const hostShape = lstatSeesLink ? 'A：lstat 看得见 junction' : 'B：lstat 看不见 junction（盲）'
  check(
    '实测：`mode & 0x400` 这条路在**两种宿主形态下都恒为 false**（`Stats.mode` 是 POSIX 位、不携带 Win32 重解析属性 ⇒ 旧判据永远是假判据，与形态无关）',
    (Number(f.info?.mode ?? 0) & 0x400) === 0,
    JSON.stringify({ hostShape, mode_hex: `0x${Number(f.info?.mode ?? 0).toString(16)}`, modeAnd0x400: false, isSymbolicLink: lstatSeesLink, isDirectory: f.info?.isDirectory?.() }),
  )
  check(
    '实测：`dirent.isSymbolicLink()=true` 且 `dirent.isDirectory()=false` —— 这条判据在**两种宿主形态下**都有判定力',
    f.dirent?.isSymbolicLink() === true && f.dirent?.isDirectory() === false,
    JSON.stringify({ hostShape, direntIsSymbolicLink: f.dirent?.isSymbolicLink(), direntIsDirectory: f.dirent?.isDirectory() }),
  )
  // ③ **行为断言**：本机形态对应哪一层防线命中无所谓，要紧的是"重解析点绝不进快照"。
  //    形态 A ⇒ `classifyEntry()` 第二条防线（`info.isSymbolicLink()`）就命中；
  //    形态 B ⇒ 只能靠 dirent / "lstat 说是目录而 dirent 说不是"的交叉校验命中。
  //    "没读到树外内容"的可观测口径：快照里**没有任何键**提到这条 junction（跟随它就会
  //    递归出 staged→junc→root→.dshstage→… 并把 junc\... 记进快照），且不抛错。
  const junctionSkip = (f.snapshot?.skipped ?? []).some((entry) => entry.path === f.junction && entry.reason === 'reparse-point')
  const junctionNeverWalked = ![...(f.snapshot ?? new Map()).keys()].some((key) => key.toLowerCase().includes('junc'))
  const shapeDefence = lstatSeesLink
    ? '判据第二条防线（info.isSymbolicLink()=true）'
    : 'dirent.isSymbolicLink() / 交叉校验（lstat 说是目录、dirent 说不是）'
  const shapeShapeOk = lstatSeesLink ? f.info.isDirectory() === false : f.info.isDirectory() === true
  check(
    `宿主形态 ${hostShape}：guard 的安全结局一致 —— junction 结构化记为 \`reparse-point\`、未被 walk 走到，**树外内容一个字节都没进快照**`,
    f.snapshotError === undefined && junctionSkip && junctionNeverWalked && shapeShapeOk,
    JSON.stringify({
      hostShape,
      defence: shapeDefence,
      lstatShapeMatchesHost: shapeShapeOk,
      skippedPath: f.junction,
      skippedAsReparsePoint: junctionSkip,
      junctionNeverWalked,
      snapshotError: f.snapshotError ? `${f.snapshotError.code}: ${String(f.snapshotError.message).slice(0, 80)}` : null,
      snapshotKeys: [...(f.snapshot ?? new Map()).keys()],
    }),
  )

  // ④ 判据不能误伤正常对象
  check('普通暂存文件进入快照', f.before.get('plain.txt') === sha256Buffer(Buffer.from('plain\n')), `size=${f.before.size}`)
  check(
    '普通子目录里的文件也进入快照（判据不误伤目录）',
    f.before.get(join('plaindir', 'inner.txt')) === sha256Buffer(Buffer.from('inner\n')),
    'ok',
  )
  check('普通对象不被记为跳过', (f.before.skipped ?? []).length === 0, JSON.stringify(f.before.skipped))

  // ⑤ 核心：不崩、且 junction 被**结构化**记为跳过
  check(
    'snapshotStagedTree() 在含 junction 的暂存树里不抛错（D8 真修复）',
    f.snapshotError === undefined,
    f.snapshotError ? `${f.snapshotError.code ?? ''}: ${String(f.snapshotError.message).slice(0, 160)}` : 'ok',
  )
  check(
    'junction 被记为 `reparse-point` 跳过（结构化字段 `skipped`）',
    (f.snapshot?.skipped ?? []).some((entry) => entry.path === f.junction && entry.reason === 'reparse-point'),
    JSON.stringify(f.snapshot?.skipped ?? null),
  )
  check(
    'junction 未进入快照（没有跟随解析目标）',
    ![...(f.snapshot ?? new Map()).keys()].some((key) => key.toLowerCase().includes('junc')),
    JSON.stringify([...(f.snapshot ?? new Map()).keys()]),
  )
  check('被跳过的重解析点确实在暂存树里', existsSync(f.junction), f.junction)
  check(
    'captureAfterExecution() 在含 junction 的暂存树里不抛错（与快照共用同一 walker）',
    f.captureError === undefined,
    f.captureError ? `${f.captureError.code ?? ''}: ${String(f.captureError.message).slice(0, 160)}` : 'ok',
  )
  check(
    'junction 不被误判成"被命令删除的文件"',
    (f.captured ?? []).find((change) => change.deleted) === undefined,
    JSON.stringify((f.captured ?? []).find((change) => change.deleted) ?? null),
  )

  // ── --plant：**真变异体**（文本改写 `src\workspace.mjs` 的副本），不是手写一套替身 ──
  // 每个档案都跑**同一份现场**，并保留"正确行为"的期望值 ⇒ 变异体必然见红：
  //   P1 = 判据回退成 `mode & 0x400`（恒 false）⇒ 旧行为复活：junction 被当文件 hash
  //        ⇒ `EISDIR`（这正是生产里崩过的形态）⇒ "应记为 reparse-point" 必红；
  //   P2 = P1 + 递归判据也回退成 `lstatSync(item).isDirectory()`（任务前的原版 walker）
  //        ⇒ 真去递归自指 junction ⇒ **环路防护**应记为 `cycle-detected` 且不崩；
  //   P3 = P2 + 拆掉环路防护 ⇒ 自指 junction 必须抛错（证明防护本身必需）。
  // ⚠ 追加：变异体"被抓住"的**形态**同样与宿主 `lstat` 形态有关（见 D8 段 ②/③ 的分流）：
  //   · 形态 A（本机 danger-full-access：`isSymbolicLink()=true`、`isDirectory()=false`）：
  //     旧递归判据 `lstatSync(item).isDirectory()` 为 **false** ⇒ 不会递归，而是把 junction
  //     当**普通文件**去 `hashFile()` ⇒ `readFileSync(目录)` 抛 **EISDIR** 在 `snapshotStagedTree()`
  //     当场崩（"变异体被抓住"的**更强**形态：直接崩，而不是靠纵深防御优雅收住）；
  //   · 形态 B（workspace-write：`isDirectory()=true`）：旧 walker 真递归 ⇒ 由环路防护/ELOOP/
  //     深度上限**优雅**收住（结构化 `skipped`）。
  //   两种形态都必须"被抓住"（不许变异体静默通过），因此 P2/P3/P4 各自按形态断言**对应的**被抓住形态。
  if (PLANT) {
    W('')
    W('=== 3b. --plant 变异体：把判据改回 `mode & 0x400`（锚点全部命中才作数）===')
    const makePlanted = ({ revertRecursion = false, removeCycleGuard = false, removeDepthLimit = false } = {}) => {
      const srcUrl = new URL('../src/workspace.mjs', import.meta.url)
      const source = readFileSync(srcUrl, 'utf8')
      // 相对 import 改写为绝对 URL：副本放在 `.t\` 下也解析得到同一份依赖
      let text = source.replace(/from '(\.[^']+)'/g, (match, rel) => `from '${new URL(rel, srcUrl).href}'`)
      const anchors = [
        ["if (dirent && typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink()) return 'reparse-point'", "if (false) return 'reparse-point'"],
        ["if (info.isSymbolicLink()) return 'reparse-point'", "if (false) return 'reparse-point'"],
        ["if (info.isDirectory() && dirent && typeof dirent.isDirectory === 'function' && dirent.isDirectory() === false) {", 'if (false) {'],
      ]
      if (revertRecursion) anchors.push(['if (dirent.isDirectory()) {', 'if (lstatSync(item).isDirectory()) {'])
      const applied = []
      for (const [from, to] of anchors) {
        if (!text.includes(from)) continue
        text = text.replace(from, to)
        applied.push(from.slice(0, 46))
      }
      if (removeCycleGuard) {
        const guard = 'if (ancestors.has(key)) {'
        if (text.includes(guard)) {
          text = text.replace(guard, 'if (false) {')
          applied.push('cycle-guard')
        }
      }
      if (removeDepthLimit) {
        const cap = 'if (depth > WALK_MAX_DEPTH) {'
        if (text.includes(cap)) {
          text = text.replace(cap, 'if (false) {')
          applied.push('depth-limit')
        }
      }
      const dir = join(SCRATCH, `planted-${revertRecursion ? 'legacy-walker' : 'judgement'}${removeCycleGuard ? '-no-cycle-guard' : ''}${removeDepthLimit ? '-no-depth-limit' : ''}`)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'workspace-planted.mjs')
      writeFileSync(file, text)
      return { file, applied, expected: anchors.length + (removeCycleGuard ? 1 : 0) + (removeDepthLimit ? 1 : 0) }
    }

    const p1 = makePlanted()
    check('--plant P1：变异体锚点全部命中（判据确实已被改回假判据）', p1.applied.length === p1.expected, JSON.stringify(p1.applied))
    const { Workspace: PlantedWorkspace } = await import(pathToFileURL(p1.file).href)
    const pf = d8Fixture('d8-planted', PlantedWorkspace)
    check(
      '[变异体 P1] junction 应被记为 `reparse-point` —— 判据回退后**必然失败**（旧行为把 junction 当文件 hash）',
      (pf.snapshot?.skipped ?? []).some((entry) => entry.reason === 'reparse-point'),
      JSON.stringify({ skipped: pf.snapshot?.skipped ?? null, error: pf.snapshotError ? `${pf.snapshotError.code}: ${String(pf.snapshotError.message).slice(0, 90)}` : null }),
    )

    const p2 = makePlanted({ revertRecursion: true })
    check('--plant P2：变异体锚点全部命中（判据 + 递归判据都回退到修复前）', p2.applied.length === p2.expected, JSON.stringify(p2.applied))
    const { Workspace: LegacyWalkerWorkspace } = await import(pathToFileURL(p2.file).href)
    const pf2 = d8Fixture('d8-planted-legacy-walker', LegacyWalkerWorkspace)
    /**
     * 变异体"被抓住"的可观测口径（宿主形态分流，理由见本节头注）：
     *   · 形态 A（lstat 可见 junction）⇒ `snapshotStagedTree()` 必须抛 **EISDIR**
     *     （旧 walker 把它当文件 hash；这是比"优雅收住"更强的被抓形态）；
     *   · 形态 B（lstat 盲）⇒ 不抛错，且 `skipped` 里必须出现给定期望 reason 之一
     *     （`blindReasons === undefined` ⇒ 任意非空跳过记录都算被抓住）。
     */
    const mutantCatchOf = (fixture, blindReasons) => {
      const lstatVisible = fixture.info?.isSymbolicLink?.() === true
      const reasons = [...new Set((fixture.snapshot?.skipped ?? []).map((entry) => entry.reason))]
      let caughtBy = null
      if (lstatVisible) {
        if (fixture.snapshotError?.code === 'EISDIR') caughtBy = 'EISDIR（junction 被当文件 hash）'
      } else if (fixture.snapshotError === undefined) {
        caughtBy =
          blindReasons === undefined
            ? (reasons.length > 0 ? reasons.join('+') : null)
            : blindReasons.find((reason) => reasons.includes(reason)) ?? null
      }
      return {
        lstatVisible,
        caughtBy,
        reasons,
        error: fixture.snapshotError ? `${fixture.snapshotError.code ?? ''}: ${String(fixture.snapshotError.message).slice(0, 80)}` : null,
      }
    }
    const p2Caught = mutantCatchOf(pf2, ['cycle-detected'])
    check(
      '[变异体 P2] 判据 + 递归判据都回退后自指 junction 必被抓住：形态 A ⇒ 当文件 hash 抛 EISDIR；形态 B ⇒ 环路防护记 `cycle-detected` 且不抛错',
      p2Caught.caughtBy !== null,
      JSON.stringify(p2Caught),
    )

    const p3 = makePlanted({ revertRecursion: true, removeCycleGuard: true })
    check('--plant P3：变异体锚点全部命中（判据 + 递归判据 + 环路防护都拆掉）', p3.applied.length === p3.expected, JSON.stringify(p3.applied))
    const { Workspace: NoGuardWorkspace } = await import(pathToFileURL(p3.file).href)
    const pf3 = d8Fixture('d8-planted-no-cycle-guard', NoGuardWorkspace)
    const p3Caught = mutantCatchOf(pf3, ['unreadable:ELOOP', 'depth-limit'])
    check(
      '[变异体 P3] 再拆掉环路防护后仍必被抓住：形态 A ⇒ EISDIR；形态 B ⇒ ELOOP/depth-limit 被「保守 catch」记成结构化 `skipped`',
      p3Caught.caughtBy !== null,
      JSON.stringify(p3Caught),
    )

    const p4 = makePlanted({ revertRecursion: true, removeCycleGuard: true, removeDepthLimit: true })
    check('--plant P4：变异体锚点全部命中（三层显式防护都拆掉）', p4.applied.length === p4.expected, JSON.stringify(p4.applied))
    const { Workspace: BareWorkspace } = await import(pathToFileURL(p4.file).href)
    const pf4 = d8Fixture('d8-planted-bare', BareWorkspace)
    const p4Caught = mutantCatchOf(pf4)
    check(
      '[变异体 P4] 三层显式防护全拆后仍必被抓住：形态 A ⇒ EISDIR；形态 B ⇒ `classifyEntry` 的保守 catch 如实结构化记下跳过项',
      p4Caught.caughtBy !== null,
      JSON.stringify(p4Caught),
    )
  }
}

W('')
W('='.repeat(64))
W(
  PLANT
    ? `工作区回归（D8/D10，--plant 模式）：断言 ${assertions} 项，失败 ${failures} 项`
    : `工作区回归（D8/D10）：断言 ${assertions} 项，失败 ${failures} 项`,
)
W('='.repeat(64))
process.exit(failures ? 1 : 0)
