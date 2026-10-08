/**
 * 统一工作区服务（Workspace Service）
 *
 * 手册依据：
 *   第 1 章 统一视图 / 连续修改 / 删除权威性
 *   第 2 章 唯一权威：所有工具走同一份投影
 *   第 3 章 文件、目录、删除标记的统一语义
 *   第 4 章 结构化返回与路径还原
 *   第 7 章 删除捕获必须完整
 *   第 12 章 候选完整性、选择性应用
 *
 * 本类刻意实现的"已付学费"的不变量：
 *   - 存在性判断区分文件与目录（#3.1）
 *   - 目录参数不当文件参数重写（#3.2）
 *   - 删除是持久逻辑状态，副本缺失 = 损坏而非删除，也绝不回退真实磁盘（#3.7 / 3.1）
 *   - 连续修改跨 attempt 存活（#3.4）：清单常驻，不随一次调用清空
 *   - 写文件前准备受控父目录（#3.5）
 *   - 目录枚举合并基线与新增，递归合成父目录（#3.11）
 *   - 暂存路径保留 basename 与扩展名（#3.9）
 *   - 正反向映射幂等，二次暂存复用同一份（#3.10）
 *   - 无净变化不入队（#12.1），但 host_op 不因文件数为零被过滤（#12.4）
 *   - 部分应用后其余保留为可追踪修订（#12.2）
 *   - 陈旧候选沿 superseded_by 链重定向，终态幂等（#12.3）
 *   - 遮蔽前先规范化，符号链接不能绕过（#16.6）；硬拒绝先于软遮蔽（#16.7）
 */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  CANDIDATE_STATUS,
  CANDIDATE_VERSION,
  STATE,
  Store,
  hashAbsent,
  hashFile,
  isExternalKey,
  newCandidateId,
  sha256Buffer,
  writeFileAtomic,
  makeRemovable,
} from './store.mjs'
import { canonical, compareKey, isInside, isMasked, lexical, lexicalInside, maskReason, relativeTo, segments, stableSort } from './paths.mjs'
// 缺陷③（Fix B）：陈旧 AppContainer 包 SID ACE 的判据与落地只从 executor 来
import { repairStaleAppContainerAces } from './executor.mjs'

export class SandboxError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'SandboxError'
    this.code = code
    this.detail = detail
  }
}

/**
 * 是不是一个**重解析点**（symlink / junction / mount point），即"名字代理"结点。
 *
 * 为什么必须单独判：Windows 上 `statSync().isDirectory()` 对 junction 返回 **true**，
 * 而 `readFileSync(junction)` 会**跟随解析**到目标；目标若是目录就得到
 * `EISDIR: illegal operation on a directory, read`。
 * 于是"暂存树里有一个 junction"会让整条 `cli exec` 在命令执行**之前**就崩在
 * `snapshotStagedTree()` 上（原始证据 `.t\sbx3\t-fs\out\13-cli-exec-junction-crash.err`）。
 *
 * ── task-7：旧判据是**恒 false 的假判据**（安全缺陷，不是测试问题）──────────────
 * 旧实现是 `(Number(info.mode ?? 0) & 0x400) !== 0`，作者以为 `mode` 里带着
 * Win32 `FILE_ATTRIBUTE_REPARSE_POINT`(0x400)。**Node 的 `fs.Stats` 根本没有
 * `attributes` 字段，`mode` 是 POSIX 位** —— 该表达式对本机所有对象**恒为 false**
 * （普通目录 0x41b6、junction 同样 0x41b6），于是 junction 守卫**从未生效**。
 * 此前一直绿，只因为受限会话里 `mklink` 失败、测试走了 `--SKIP--` 分支：
 * 典型的"假通过"（与缺陷 11 同级）。
 *
 * ── 判据怎么选出来的：**实测选型**，不是推断（`node tests\workspace-regressions.mjs --probe-reparse`）
 * `[实测]` 本机 node v24.21.0 / win32，node 的 `fs.Stats` 逐字段打印：
 *
 * | 对象 | `lstat.isSymbolicLink()` | `mode & 0x400` | `readlinkSync()` | `realpath.native()` | `dirent.isSymbolicLink()` |
 * |---|---|---|---|---|---|
 * | 普通目录 | false | false | `EINVAL` | 等于自身 | **false** |
 * | 普通文件 | false | false | `EINVAL` | 等于自身 | **false** |
 * | junction（`fs.symlinkSync(…,'junction')`） | **false** | false | `EINVAL` | **解析到目标** | **true** |
 * | junction（`cmd mklink /J`） | **false** | false | `EINVAL` | **解析到目标** | **true** |
 * | `C:\Users\ADMINI~1`（8.3 短名，**不是**重解析点） | false | false | `EINVAL` | **解析到长名** | false |
 *
 * 三条被实测推翻的"想当然"：
 *   ① `lstat.isSymbolicLink()` 对 junction 是 **false**（所以不能只靠它）；
 *   ② `readlinkSync()` 对 junction 抛 `EINVAL`（Node 的 readlink **不**覆盖 junction，不能用）；
 *   ③ `realpathSync.native()` 会把 junction **和 8.3 短名都**换成另一个路径 ⇒ 单独用它会把
 *      正常短名目录**误判成重解析点**（静默漏采真实内容，比原缺陷更糟）。
 * 因此判据取**目录项类型** `dirent.isSymbolicLink()`：它是实测中唯一"对 junction 为 true、
 * 对普通目录/文件/8.3 短名全为 false"的信号；`lstat.isSymbolicLink()` 作为第二条防线保留，
 * 并用"`lstat` 说是目录、`dirent` 说不是目录"这条**交叉校验**兜住未来 Node/libuv 的行为漂移。
 *
 * @param {string} item 绝对路径（仅用于第二/第三条防线）
 * @param {import('node:fs').Dirent} [dirent] `readdirSync(dir,{withFileTypes:true})` 给出的目录项
 * @returns {undefined|string} `undefined` = 普通对象；否则是**跳过原因**（结构化字段用）
 */
function classifyEntry(item, dirent) {
  if (dirent && typeof dirent.isSymbolicLink === 'function' && dirent.isSymbolicLink()) return 'reparse-point'
  try {
    const info = lstatSync(item)
    // 第二条防线：真符号链接（在别的平台上 `dirent.isSymbolicLink()` 未必可用）
    if (info.isSymbolicLink()) return 'reparse-point'
    // 第三条防线（交叉校验）：`lstat` 说是目录而目录项说不是 ⇒ 保守跳过。
    // junction 正是这一形态（`lstat.isDirectory()=true` 且 `dirent.isDirectory()=false`）。
    if (info.isDirectory() && dirent && typeof dirent.isDirectory === 'function' && dirent.isDirectory() === false) {
      return 'reparse-point'
    }
    return undefined
  } catch (error) {
    // lstat 都拿不到（权限/竞态/路径过长）：**保守跳过**并如实记录原因 ——
    // 宁可漏采，也不能跟随一个无法判定的结点去读；同时不让整个快照崩掉。
    return `unreadable:${error.code ?? 'ERR'}`
  }
}

/** 遍历深度上限（纵深防御：即使重解析点判据将来再漏，也不会无界递归） */
const WALK_MAX_DEPTH = 64

/**
 * 白障（whiteout）标记子树的固定叶名 —— `<staging root>\wo\`。
 *
 * `[官方]` 与 shim 内置 provider 的布局同构（`shim\src\ws_stage.c:4-6` / `:84-91`）：
 *   `<root>\wo\C\a\b`                 ← 逻辑路径 `C:\a\b` 的删除标记（空文件）
 *   `<root>\wo\_unc\server\share\x`   ← 逻辑路径 `\\server\share\x` 的删除标记
 *   `<root>\fs\C\a\b`                 ← 同一逻辑路径的内容副本（另一棵树）
 *
 * `wo\` **不是内容树**：它是"删除"这一逻辑状态的落盘形式。把它当内容对象遍历，
 * 就会得到 `create wo\C\a\b` 这种伪路径（缺陷①b 前半）；而真正被删的真实文件
 * 因为从未进过执行前快照，候选里 `删除 0 项`（缺陷①b 后半，见
 * `docs\边界缺陷修复-①b-白障候选捕获.md`）。
 */
const WHITEOUT_LEAF = 'wo'

/**
 * 白障标记 → 逻辑绝对路径（`ws_fs_map()` 的逆映射，`shim\src\ws_stage.c:34-73`）。
 *
 * `[实测]` TS 档 shim 落下的标记（`.t\shim-delete\run-*\.dshstage\staged\wo`）：
 *   `wo\C\Users\...\a.txt`   → `C:\Users\...\a.txt`（盘符冒号被丢弃，其余逐字保留）
 *   `wo\_unc\server\share\x` → `\\server\share\x`
 *
 * 反解失败（层级不足 / 首段既不是盘符也不是 `_unc`）返回 `undefined`：调用方按
 * "无法归因"跳过并**如实记录**（进 `skipped`），绝不猜一个路径出来 ——
 * 猜出来的路径会变成一条"用户删除了它"的待审候选。
 */
function logicalFromWhiteoutMarker(woRoot, markerPath) {
  const rel = relative(woRoot, markerPath)
  if (!rel || rel.startsWith('..')) return undefined
  const parts = rel.split(sep).filter((part) => part !== '')
  if (parts.length < 2) return undefined
  if (parts[0].toLowerCase() === '_unc') {
    // UNC：`\_unc\server\share\x` → `\\server\share\x`
    if (parts.length < 3) return undefined
    return `\\\\${parts.slice(1).join(sep)}`
  }
  if (!/^[a-zA-Z]$/.test(parts[0])) return undefined
  // 盘符统一大写，与 `paths.mjs::lexical()` 的口径一致（只影响盘符，不动其余大小写）
  return `${parts[0].toUpperCase()}:${sep}${parts.slice(1).join(sep)}`
}


/**
 * 暂存树内容戳：一次遍历，返回
 *   `{ hashes: Map<rel, sha256>, realPaths: Map<rel, relOnDisk>, seen: Set<abs>,
 *      whiteouts: Map<compareKey(逻辑绝对路径), 逻辑绝对路径>, skippedReparsePoints: string[] }`
 *
 * `wo\` 子树（白障 / 删除标记）**不进入 `hashes`**，而是被解释进 `whiteouts`：标记不是
 * 内容对象（缺陷①b，见 `WHITEOUT_LEAF`）。两条口径必须在执行前快照与执行后捕获之间
 * 完全一致，因此两者共用本函数。
 *
 * 键是 `relative()` 的原样相对路径（**不做大小写归一**）。
 *
 * 为什么不用 `compareKey()` 当键（这是修复 D9 时被真实数据抓到的一处隐患）：
 * Windows 不区分大小写，`Src\App.js` 与 `src\app.js` 是同一个文件；若键被小写化后
 * 再拿去 `writeFile()`，清单里就会出现**第二个键**（原大小写的旧条目 + 小写的新条目），
 * 快照与捕获因此永远对不上。保留原样相对路径，并额外给出 `realPaths` 供"要落盘/要暂存"
 * 的调用方使用，比较语义由调用方显式决定。
 *
 * 为什么抽成一个模块级函数：`snapshotStagedTree()`（执行前）与 `captureAfterExecution()`
 * （执行后）必须**用同一个口径**看待暂存树，否则"执行前跳过了 junction、执行后又去 hash 它"
 * 会让命令执行完仍在同一个地方崩掉。两处共用一份 walker 是唯一能保证不再漂移的写法。
 *
 * 跳过重解析点的取舍见 `snapshotStagedTree()` 的注释（缺陷 D8）。
 */
function walkStagedForHashes(stagedDir) {
  const hashes = new Map()
  const realPaths = new Map()
  const seen = new Set()
  /** 白障标记：`compareKey(逻辑绝对路径)` → 逻辑绝对路径（缺陷①b：删除要能被捕获） */
  const whiteouts = new Map()
  const skippedReparsePoints = []
  /** 结构化跳过记录（task-7 要求：跳过必须可归因，不是一句"跳过了"） */
  const skipped = []
  const record = (path, reason) => {
    skipped.push({ path, reason })
    if (reason === 'reparse-point') skippedReparsePoints.push(path)
  }
  /** 目录的**解析后**身份键：用于环路检测（大小写不敏感） */
  const identityOf = (dir) => {
    try {
      return realpathSync.native(dir).toLowerCase()
    } catch {
      return normalize(dir).toLowerCase()
    }
  }
  /**
   * `wo\` 子树的**独立**遍历：标记是"逻辑状态"，不是内容对象。
   *
   * 与 `walk()` 共用同一套守卫（重解析点 / 环路 / 深度上限），因此执行前快照与执行后
   * 捕获对"哪些是标记"永远不会漂移。只有**普通文件**算标记：`<root>\wo\C` 这种
   * 父链目录是 `ws_fs_map()` 丢盘符冒号的副产品，把它当标记会把 `C:\` 整体判成已删除
   * （`[实测]` 这正是 `shim\src\ws_stage.c:99-115` 记下的教训）。
   */
  const walkWhiteouts = (woRoot, dir, ancestors, depth) => {
    if (depth > WALK_MAX_DEPTH) {
      record(dir, 'depth-limit')
      return
    }
    const key = identityOf(dir)
    if (ancestors.has(key)) {
      record(dir, 'cycle-detected')
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      record(dir, `unreadable:${error.code ?? 'ERR'}`)
      return
    }
    ancestors.add(key)
    try {
      for (const dirent of entries) {
        const item = join(dir, dirent.name)
        const reason = classifyEntry(item, dirent)
        if (reason !== undefined) {
          seen.add(item)
          record(item, reason)
          continue
        }
        if (dirent.isDirectory()) {
          walkWhiteouts(woRoot, item, ancestors, depth + 1)
          continue
        }
        const logical = logicalFromWhiteoutMarker(woRoot, item)
        if (logical === undefined) {
          // 反解不出来就**如实记录**（不猜路径，也不静默丢弃）
          record(item, 'whiteout-unmappable')
          continue
        }
        whiteouts.set(compareKey(logical), logical)
      }
    } finally {
      ancestors.delete(key)
    }
  }
  /**
   * 环路防护（纵深防御，独立于重解析点判据）。
   *
   * 为什么必须有：`[实测]` 一个**自指 junction**（指向自己的祖先）会让朴素 walker
   * 造出无限深的路径，最终 `lstat` 抛 `ELOOP: too many symbolic links`。
   * 判据用"祖先链上的**解析后身份**"而不是字符串前缀：只有真成环才会命中，
   * 正常的深层目录（哪怕名字很长）不受影响；外加 `WALK_MAX_DEPTH` 的硬上限兜底。
   */
  const walk = (dir, ancestors, depth) => {
    if (depth > WALK_MAX_DEPTH) {
      record(dir, 'depth-limit')
      return
    }
    const key = identityOf(dir)
    if (ancestors.has(key)) {
      record(dir, 'cycle-detected')
      return
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      record(dir, `unreadable:${error.code ?? 'ERR'}`)
      return
    }
    ancestors.add(key)
    try {
      for (const dirent of entries) {
        const item = join(dir, dirent.name)
        const reason = classifyEntry(item, dirent)
        if (reason !== undefined) {
          // 跳过但**记入 seen**：`captureAfterExecution()` 据此不把它误判成"被命令删除"
          seen.add(item)
          record(item, reason)
          continue
        }
        if (dirent.isDirectory()) {
          // `wo\` 是删除标记子树（见 `WHITEOUT_LEAF`）：不作为内容树进入，
          // 单独按"标记 → 逻辑路径"解释成删除；否则标记会被报成 `create wo\…` 伪路径。
          if (depth === 0 && dirent.name.toLowerCase() === WHITEOUT_LEAF) {
            seen.add(item)
            walkWhiteouts(item, item, ancestors, 0)
            continue
          }
          walk(item, ancestors, depth + 1)
          continue
        }
        seen.add(item)
        const rel = relative(stagedDir, item)
        hashes.set(rel, hashFile(item))
        realPaths.set(rel, rel)
      }
    } finally {
      ancestors.delete(key)
    }
  }
  if (existsSync(stagedDir)) walk(stagedDir, new Set(), 0)
  return { hashes, realPaths, seen, whiteouts, skippedReparsePoints, skipped }
}

/**
 * 基线漂移的**形状**命名（纯函数，供 `baselineDrift()` 与审阅快照共用）。
 *
 * 为什么要把形状单独命名：`STALE_BASELINE` 过去只有一个布尔位，面板只能说
 * "基线已过期"，用户看不出这次漂移**会不会丢数据**。缺陷②（F5b）的实测形状是
 * **基线 = absent（新增）而真实文件在暂存之后出现** —— 面板对它完全无话可说，
 * 批准即静默覆盖。三种形状：
 *   - `baseline-appeared`：基线是"不存在"，真实文件却存在 ⇒ 磁盘上多出一份**没有暂存副本
 *     可回退**的内容（F5b 那一档）；
 *   - `baseline-deleted`：基线有文件，真实文件却没了 ⇒ 外部删除，批准会把它写回来；
 *   - `baseline-drifted`：两边都有文件但内容不同 ⇒ 外部改写。
 * 不 stale（含目录 / 非普通文件等"无法参与内容比较"的形态）⇒ `null`。
 *
 * @param {string} expected 清单记录的基线 hash（`hashAbsent()` 表示"基线不存在"）
 * @param {string} found 真实磁盘当前 hash（`hashAbsent()` 表示"磁盘上没有这个文件"）
 * @returns {'baseline-appeared'|'baseline-deleted'|'baseline-drifted'|null}
 */
export function driftReasonOf(expected, found) {
  if (expected === found) return null
  if (expected === hashAbsent()) return 'baseline-appeared'
  if (found === hashAbsent()) return 'baseline-deleted'
  return 'baseline-drifted'
}

/**
 * ── WP8.2：宿主原件的**基线指纹**（size + mtime + sha256）────────────────────────
 *
 * 暂存一条变更时记下"当时真实磁盘上那份原件长什么样"。应用之前**重算**一次：
 *   - 三者都一致 ⇒ 未变 ⇒ 允许替换；
 *   - 任一不一致 ⇒ 判**冲突** ⇒ 不覆盖，把选择权交回用户。
 *
 * 为什么不是只比 sha256：sha256 是内容的完备判据，但它说不清"**怎么**变的"。
 * 面板要告诉用户的是"这个文件在你暂存之后被改过（大小 12→40 字节、时间 10:02→10:07）"，
 * 而 `size`/`mtimeMs` 让这句话可读、也让冲突两条路径（被外部改写 vs 被外部同一内容重写）
 * 在证据里可分。判据以 sha256 为准（见 `baselineConflictOf()`），三者一起**如实上报**。
 *
 * @returns {{sha256:string,size:number,mtimeMs:number}|undefined} 非普通文件 / 读不到 ⇒ undefined
 */
export function hostFileFingerprint(abs) {
  try {
    const info = statSync(abs)
    if (!info.isFile()) return undefined
    return { sha256: hashFile(abs), size: info.size, mtimeMs: info.mtimeMs }
  } catch {
    return undefined
  }
}

/**
 * 基线指纹 → 冲突描述（纯函数，`applyOneChange()` 与审阅快照**共用同一判据**）。
 *
 * 判据（写死，避免两处漂移）：
 *   - 记录的指纹缺失（`expected.fingerprint` 无值）⇒ **不判冲突**（旧清单/目录/外部键）；
 *   - 真实文件现在不存在而记录里存在 ⇒ `host-file-missing`；
 *   - 记录里不存在而现在存在 ⇒ `host-file-appeared`；
 *   - 两者都存在且 `sha256` 不同，或 `size` 不同 ⇒ `host-file-modified`。
 *
 * `mtimeMs` **单独不足以**判冲突：内容相同的"触碰式"重写（touch / 复制同内容）会改 mtime
 * 却没有任何内容需要保护，为它拒绝批准是假阳性。反之 mtime 变了而 sha256/size 也变，
 * 早已被前两条判据捕获。因此 mtime 只作为**证据**参与上报。
 *
 * @returns {{code:string,expected:object,found:object|null,changed:string[]}|null}
 */
export function baselineConflictOf(expectedFingerprint, foundFingerprint) {
  if (!expectedFingerprint || typeof expectedFingerprint.sha256 !== 'string') return null
  const changed = []
  if (!foundFingerprint) {
    return { code: 'host-file-missing', expected: expectedFingerprint, found: null, changed: ['exists'] }
  }
  if (expectedFingerprint.sha256 !== foundFingerprint.sha256) changed.push('sha256')
  if (expectedFingerprint.size !== undefined && foundFingerprint.size !== expectedFingerprint.size) changed.push('size')
  if (
    expectedFingerprint.mtimeMs !== undefined &&
    foundFingerprint.mtimeMs !== undefined &&
    Math.abs(foundFingerprint.mtimeMs - expectedFingerprint.mtimeMs) > 1
  ) {
    changed.push('mtime')
  }
  // 内容判据（sha256 / size）任一不同即冲突；仅 mtime 不同不算冲突（见上）
  const contentChanged = changed.some((key) => key === 'sha256' || key === 'size')
  if (!contentChanged) return null
  return { code: 'host-file-modified', expected: expectedFingerprint, found: foundFingerprint, changed }
}

/**
 * **原子替换**（WP8.1）：同卷"写临时文件 → 原子替换目标"。
 *
 * 相对 `store.mjs::writeFileAtomic`（它只用 `renameSync`）多两件事：
 *   1. `renameSync` 在"目标是**已存在**文件"时本机实测会抛 `EPERM`（Windows 的
 *      `MoveFileEx` 语义不是 POSIX 的"覆盖式 rename"）。因此这里先试 `renameSync`，
 *      失败后退到"**显式删掉目标再改名**"—— 两步都在目标**同目录同卷**，
 *      中间窗口只有一次 unlink+rename 的间隔；
 *   2. 把"写整份内容到临时文件"这一步也包进来读取源内容，从而**在第一次触碰目标之前**
 *      就能发现"内容读不出来"这类错误 ⇒ 失败时目标文件**一字节未动**。
 *
 * 失败语义（WP8.1 的硬要求）：任何一步失败都**保留原文件**并抛错，绝不留下半成品；
 * 临时文件在失败路径上被清理。
 *
 * @param {string} target 目标绝对路径（必须已存在或允许新建）
 * @param {Buffer} content 新内容
 * @returns {{strategy:'rename'|'replace', bytes:number}}
 */
export function writeFileAtomicReplacing(target, content) {
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.${randomUUID()}.stage-tmp`)
  writeFileSync(tmp, content)
  try {
    try {
      renameSync(tmp, target)
      return { strategy: 'rename', bytes: content.length }
    } catch (renameError) {
      // 目标存在时的 Windows 覆盖式改名：先摘掉目标，再改名。此路径下临时文件已写好，
      // 因此不存在"内容还没准备好就把原文件删了"的窗口。
      if (!existsSync(target)) {
        throw renameError
      }
      rmSync(target, { force: true })
      renameSync(tmp, target)
      return { strategy: 'replace', bytes: content.length }
    }
  } catch (error) {
    cleanupTemp(tmp)
    throw error
  }
}

/** 失败路径上清理临时文件；清理失败**不掩盖**原错误（与 store.mjs 同一纪律） */
function cleanupTemp(path) {
  try {
    unlinkSync(path)
  } catch {
    /* 清理失败不掩盖原错误 */
  }
}

/** 依据实际类型决定逻辑状态（#3.1） */
function statKind(path) {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) {
      // 悬空链接：按目标是否存在判断，避免"看得到但读不了"的幽灵
      try {
        const target = statSync(path)
        return { kind: target.isDirectory() ? 'dir' : 'file', symlink: true }
      } catch {
        return { kind: 'dangling', symlink: true }
      }
    }
    if (info.isDirectory()) return { kind: 'dir', symlink: false }
    return { kind: 'file', symlink: false }
  } catch {
    return undefined
  }
}

export class Workspace {
  /**
   * @param {{workspaceRoot: string, sessionId?: string, ownerToken?: string, masks?: Array<{id?:string,pattern:RegExp,reason?:string,hard?:boolean}>}} options
   */
  constructor(options) {
    if (!options?.workspaceRoot) throw new SandboxError('WORKSPACE_REQUIRED', 'workspaceRoot is required')
    this.root = canonical(options.workspaceRoot)
    this.store = new Store(this.root, options)
    this.sessionId = options.sessionId
    this.extraMasks = options.masks || []
    this.maskEnforcement = true
  }

  /** 启动：恢复持久状态，再重建投影（手册 13.1） */
  init(meta = {}) {
    this.store.ensureLayout()
    this.manifest = this.store.manifest({ sessionId: this.sessionId, ...meta })
    this.sessionId = this.manifest.sessionId
    this.queue = this.store.loadQueue()
    // 13.2：持久状态与投影一起恢复 —— 校验每个暂存条目
    this.corruption = this.verifyProjection()
    return this
  }

  /**
   * 校验投影完整性：记录声明文件存在而存储对象缺失 → 损坏，禁止发布（3.1）。
   * 绝不把"暂存副本意外丢失"解释为用户删除。
   *
   * ── 目录条目不得走 blob 分支（缺陷 D10）──────────────────────────────────────
   * 目录条目（含 `synthesizeParents()` 合成的父目录，以及 `createDirectory()` 建的目录）
   * 天生 `stagedHash === hashAbsent()`：目录**不是**内容对象，没有 blob 是**正确状态**。
   * 初版第一分支缺少 `entry.kind !== 'dir'` 守卫，于是健康工作区被报成
   * "损坏项 N 个（禁止发布）"，例如 `corruption:[{path:"seed",reason:"staged blob missing"}]`
   * （原始证据 `.t\sbx3\t-fs\out\cli-init-healthy.json`）。
   * 第二分支本来就有同类守卫（见下），两处必须同口径：
   *   - 文件：blob 缺失 = 损坏；blob 在但暂存树物化缺失 = 损坏
   *   - 目录：不查 blob，只查"是否有东西被声称物化了却没有"（合成目录允许不存在）
   */
  verifyProjection() {
    const corrupt = []
    for (const [rel, entry] of Object.entries(this.manifest.entries)) {
      if (entry.state === STATE.DELETED) continue
      if (entry.kind === 'dir') {
        // 目录没有内容对象；只有"非合成且既无 blob 又无物化目录"才可疑。
        // 合成目录（synthetic:true）在真实磁盘上**本就不存在**，那不是损坏。
        if (entry.synthetic === true) continue
        if (entry.stagedHash !== hashAbsent() && !this.store.hasBlob(entry.stagedHash)) {
          corrupt.push({ path: rel, reason: 'staged blob missing', state: STATE.CORRUPT })
        }
        continue
      }
      const okBlob = entry.stagedHash === hashAbsent() ? false : this.store.hasBlob(entry.stagedHash)
      const materialized = existsSync(this.store.stagedPath(rel))
      if (!okBlob && entry.state === STATE.FILE) {
        corrupt.push({ path: rel, reason: 'staged blob missing', state: STATE.CORRUPT })
      } else if (!materialized && entry.state === STATE.FILE && entry.kind !== 'dir') {
        corrupt.push({ path: rel, reason: 'staged tree object missing', state: STATE.CORRUPT })
      }
    }
    return corrupt
  }

  // ==================== 遮蔽 ====================

  /**
   * 遮蔽判定：**先规范化，再判豁免**（#16.6）。
   *
   * 顺序至关重要，这里曾经写反过并被自测抓到：`isInside()` 内部会对两侧做
   * canonical()，所以"工作区内的 junction 指向宿主敏感目录"这类绕过会被
   * 误判为"在工作区内"而获得豁免。正确顺序是：
   *   1. 先 canonical() 得到链接解析后的真实路径；
   *   2. 只有**解析后仍在工作区内**才谈豁免（豁免必须限定作用域，#16.8）；
   *   3. 解析后落到工作区外的（含 junction/符号链接逃逸）一律走硬拒绝表。
   * 反例：仓库位于被遮蔽目录之下时，项目文件解析后仍在工作区内 → 不误伤。
   */
  maskOf(absolutePath) {
    const resolved = canonical(absolutePath)
    // ── Phase 1 / WP0：自身存储的遮蔽必须**跟着存储根走** ──────────────────────────
    // 旧规则只认工作区里的 `<root>\.dshstage`，因为存储根以前必定在工作区内；
    // 现在默认根搬到了 `%LOCALAPPDATA%\Temp\winstage-stage\<会话键>`（见 `stage-guard.mjs`），
    // 那条相对路径规则**再也命中不到任何东西** —— 于是"存储面不出现在模型视野里"
    // 这条不变式会**静默失效**。所以这里改成按**实际存储根**判定，
    // 工作区内/外一视同仁；旧规则保留，覆盖迁移期仍未搬走的布局。
    const storeDir = this.store?.dir
    if (storeDir && isInside(storeDir, resolved)) {
      return { id: 'stage-store', reason: '本工具自身存储（unmask 永不解除；目录自身与其下所有文件）', hard: true }
    }
    if (isInside(this.root, resolved)) {
      // 沙箱自身存储永不豁免（unmask 也不得解除，#16.8）
      const rel = relative(this.root, resolved)
      if (!/^\.?dshstage([\\/]|$)/i.test(rel)) return undefined
    }
    return maskReason(resolved, this.extraMasks)
  }

  /** 硬检查必须能被所有工具路径命中，不能只挂在 read 上（#16.7 / A72） */
  assertReadable(absolutePath) {
    if (!this.maskEnforcement) return
    const mask = this.maskOf(absolutePath)
    if (mask) {
      throw new SandboxError('SANDBOX_PATH_MASKED', `reading ${absolutePath} is denied by mask "${mask.id}": ${mask.reason}`, {
        maskId: mask.id,
        reason: mask.reason,
        path: absolutePath,
      })
    }
  }

  // ==================== 路径 ====================

  /**
   * 逻辑路径 → 工作区相对路径（**词法**判定，不解析链接）。
   *
   * 为什么用词法而不是 canonical：工作区内的 junction 可以解析到工作区外，
   * 若此处按 canonical 判定就会抛错，导致遮蔽表根本没有机会给出
   * SANDBOX_PATH_MASKED（手册 #16.7 硬边界先于可协商项）。
   * 因此：词法在外 → 抛错；词法在内、解析后逃逸 → 返回相对路径，
   * 交给 maskOf() 判定为遮蔽不可见。
   */
  relative(target) {
    const rel = lexicalInside(this.root, target)
    if (rel === undefined) {
      const error = new SandboxError('PATH_OUTSIDE_WORKSPACE', `path escapes workspace: ${target}`, {
        workspaceRoot: this.root,
        target: lexical(target),
      })
      throw error
    }
    return rel
  }

  /**
   * 逻辑路径 → **清单键**（S3a：工作区外条目底座）。
   *
   *   - 词法在工作区内 → `{ key: <相对路径>, external: false }`（与 `relative()` 同一口径）
   *   - 词法在工作区外 → `{ key: <规范化绝对路径>, external: true }`
   *
   * 为什么键用**规范化绝对路径**而不是 `..\..` 相对路径：相对路径在暂存树里会产生
   * 语义歧义（`..` 既可能是"用户写的相对路径"也可能是"越界逃逸"），而绝对路径与
   * 工作区内相对路径的键空间天然不相交 —— `entryOf()` 因此对两种条目是同一个查找。
   *
   * 与 `relative()` 的关系：`relative()` **保持原样**（工作区外仍抛
   * PATH_OUTSIDE_WORKSPACE），因为它是"这个路径必须工作区内"的断言式入口，
   * 已被读取工具与既有测试依赖；`keyOf()` 是新增的双键空间入口，两者不互相改变语义。
   */
  keyOf(target) {
    const rel = lexicalInside(this.root, target)
    if (rel !== undefined) return { key: rel, external: false, abs: rel === '' ? this.root : this.store.realPath(rel) }
    const abs = canonical(target)
    return { key: abs, external: true, abs }
  }

  /** 相对路径 → 真实绝对路径 */
  absolute(rel) {
    return this.store.realPath(rel)
  }

  /** 相对路径 → 暂存绝对路径（保留 basename，供语言识别，见 #3.9） */
  staged(rel) {
    return this.store.stagedPath(rel)
  }

  entryOf(rel) {
    return this.manifest.entries[rel]
  }

  /**
   * **以真实文件为基线重新暂存**（`/winstage rebase` 的落地动作）。
   *
   * 暂存条目是"相对某个基线的 diff"。基线一旦被外部改动（shell / 另一个进程 /
   * 编辑器），`applyOneChange()` 会以 `STALE_BASELINE` 拒绝落盘（手册 #12.1，
   * 不能静默覆盖），而面板上的 diff 还停在旧基线 ⇒ "视图与现实不一致、批准必然失败"。
   * 本方法把 `baseHash/baseKind` 换成磁盘当前值，**不改 `stagedHash`、不改 `state`**
   * —— 这是重述基线，不是强制覆盖：
   *   - 真实内容 ≠ 暂存内容 ⇒ 变成一条**可批准的**新 diff（before 现在是真实内容）；
   *   - 真实内容 == 暂存内容 ⇒ 无净变化，条目自动退出视图（连批准都不需要）。
   * @returns {boolean} 是否找到并更新了条目
   */
  rebaseEntry(rel) {
    const entry = this.entryOf(rel)
    if (!entry) return false
    const abs = this.absolute(rel)
    const info = statKind(abs)
    const baseHash = info && info.kind === 'file' ? hashFile(abs) : hashAbsent()
    if (baseHash !== hashAbsent()) this.store.putBlob(readFileSync(abs))
    entry.baseHash = baseHash
    entry.baseKind = info?.kind
    // WP8.2：重述基线时指纹一并重述（对齐后"未变才替换"的对象就是此刻这份内容）
    entry.baseFingerprint = info?.kind === 'file' ? hostFileFingerprint(abs) : undefined
    entry.baseRevision = this.manifest.revision
    entry.changed = entry.state === STATE.DELETED ? true : entry.stagedHash !== entry.baseHash
    entry.updatedAt = new Date().toISOString()
    return true
  }

  /**
   * 该条目的真实基线是否已经偏离**清单记录**（外部改动）。
   *
   * 判据与 `applyOneChange()` 的 `STALE_BASELINE` 检查**同源**：只比 hash
   * （`before.hash` 对 absent 的条目同样用 `hashAbsent()`），因此"面板说没 stale"
   * 与"批准会成功"不会互相矛盾。
   * @returns {{stale: boolean, expected: string, found: string}}
   */
  baselineDrift(rel) {
    const entry = this.entryOf(rel)
    if (!entry) return { stale: false, expected: hashAbsent(), found: hashAbsent(), reason: null }
    const info = statKind(this.absolute(rel))
    const found = info && info.kind === 'file' ? hashFile(this.absolute(rel)) : hashAbsent()
    const expected = entry.baseHash ?? hashAbsent()
    return { stale: found !== expected, expected, found, reason: driftReasonOf(expected, found) }
  }

  // ==================== 读取面 ====================

  /**
   * 存在性：必须区分文件与目录（#3.1）。
   *
   * 注意这里用**词法边界**判定而不是 canonical：
   * 工作区内的 junction 若解析到工作区外，`relative()` 会抛 PATH_OUTSIDE_WORKSPACE，
   * 而存在性查询不应该以异常表达"不可见"。词法上在工作区内、解析后逃逸的路径，
   * 统一走遮蔽/不可见语义（#16.6），从而与 read 的硬拒绝保持一致而不崩溃。
   */
  exists(target, opts = {}) {
    const lexicalRel = lexicalInside(this.root, target)
    if (lexicalRel === undefined) {
      // S3a：工作区外**也可以有暂存条目**（键 = 规范化绝对路径）。命中即按投影回答，
      // 未命中才回落到既有的"外部不可见/遮蔽"语义（真实磁盘由调用方按 baseline 读）。
      const key = canonical(target)
      const entry = this.entryOf(key)
      if (entry) {
        if (entry.state === STATE.DELETED) return { exists: false, kind: entry.kind, source: 'deleted', external: true }
        if (entry.state === STATE.CORRUPT) {
          throw new SandboxError('WORKSPACE_CORRUPT', `staged object for ${key} is missing; refusing to fall back to the real disk`, {
            path: key,
          })
        }
        return { exists: true, kind: entry.kind === 'dir' ? 'dir' : 'file', source: 'staged', external: true }
      }
      if (this.hasStagedDescendant(key)) return { exists: true, kind: 'dir', source: 'synthetic', external: true }
      // 未命中暂存 → **统一视图**回落到真实磁盘（"命中暂存走投影，其余走真实磁盘"）。
      // 顺序与工作区内分支一致：先遮蔽判定（遮蔽即不可见），再 statKind。
      if (!opts.skipMaskCheck) {
        const mask = this.maskOf(target)
        if (mask) return { exists: false, kind: undefined, source: 'masked', maskId: mask.id, external: true }
      }
      const outsideInfo = statKind(key)
      if (!outsideInfo) return { exists: false, source: 'outside', external: true }
      return { exists: true, kind: outsideInfo.kind === 'dir' ? 'dir' : 'file', source: 'baseline', external: true }
    }
    const rel = lexicalRel
    if (rel === '') return { exists: true, kind: 'dir', source: 'baseline' }
    const entry = this.entryOf(rel)
    if (entry) {
      if (entry.state === STATE.DELETED) return { exists: false, kind: entry.kind, source: 'deleted' }
      if (entry.state === STATE.CORRUPT) {
        throw new SandboxError('WORKSPACE_CORRUPT', `staged object for ${rel} is missing; refusing to fall back to the real disk`, {
          path: rel,
        })
      }
      return { exists: true, kind: entry.kind === 'dir' ? 'dir' : 'file', source: 'staged' }
    }
    // 合成父目录：真实不存在但暂存树内有子项（#3.11）
    if (this.hasStagedDescendant(rel)) return { exists: true, kind: 'dir', source: 'synthetic' }
    const abs = this.absolute(rel)
    if (!opts.skipMaskCheck) {
      // 先规范化再判豁免（#16.6）；命中则不可见
      const mask = this.maskOf(abs)
      if (mask) {
        // 解析后逃逸到工作区外的链接：必须不可见，且不暴露解析目标
        return { exists: false, kind: undefined, source: 'masked', maskId: mask.id }
      }
    }
    const info = statKind(abs)
    if (!info) return { exists: false }
    return { exists: true, kind: info.kind === 'dir' ? 'dir' : 'file', source: 'baseline' }
  }

  /**
   * 暂存树里是否有该键的**后代**。
   *
   * S3a 追加两条约束：
   *   1. 键空间不混：相对键只看工作区内条目，绝对键只看外部条目。否则
   *      `C:\out` 会被当成工作区根的"后代"而污染根枚举（这正是必须防的错）。
   *   2. `rel === ''`（工作区根）不再走 `compareKey('')` —— 那个调用会抛 TypeError
   *      （`lexical()` 拒绝空串）。根的语义就是"是否有任何工作区内条目"。
   */
  hasStagedDescendant(rel) {
    const external = isExternalKey(rel)
    if (rel === '') {
      return Object.values(this.manifest.entries).some((entry) => entry.external !== true)
    }
    const prefix = compareKey(rel) + sep.toLowerCase()
    for (const [key, entry] of Object.entries(this.manifest.entries)) {
      if ((entry.external === true) !== external) continue
      if (compareKey(key).startsWith(prefix)) return true
    }
    return false
  }

  readFile(target) {
    const { key: rel } = this.keyOf(target)
    const entry = this.entryOf(rel)
    if (entry) {
      if (entry.state === STATE.DELETED) {
        throw new SandboxError('ENOENT', `${target} does not exist in the workspace view (deleted)`, { path: rel })
      }
      if (entry.kind === 'dir') {
        throw new SandboxError('EISDIR', `${target} is a directory`, { path: rel })
      }
      if (!this.store.hasBlob(entry.stagedHash)) {
        throw new SandboxError('WORKSPACE_CORRUPT', `staged content for ${target} is missing; refusing to read the real disk`, {
          path: rel,
        })
      }
      return this.store.readBlob(entry.stagedHash)
    }
    const abs = this.absolute(rel)
    this.assertReadable(abs)
    if (!existsSync(abs)) throw new SandboxError('ENOENT', `${target} does not exist`, { path: rel })
    if (statKind(abs)?.kind === 'dir') throw new SandboxError('EISDIR', `${target} is a directory`, { path: rel })
    return readFileSync(abs)
  }

  readText(target) {
    return this.readFile(target).toString('utf8')
  }

  stat(target) {
    const { key: rel } = this.keyOf(target)
    const state = this.exists(target)
    if (!state.exists) return undefined
    if (state.source === 'staged' && this.entryOf(rel)) {
      const entry = this.entryOf(rel)
      const materialized = this.staged(rel)
      const size = existsSync(materialized) && entry.kind !== 'dir' ? statSync(materialized).size : 0
      return { path: rel, kind: state.kind, source: 'staged', size, hash: entry.stagedHash, modified: entry.updatedAt }
    }
    if (state.source === 'synthetic') return { path: rel, kind: 'dir', source: 'synthetic', size: 0 }
    const abs = this.absolute(rel)
    const info = statSync(abs)
    return { path: rel, kind: info.isDirectory() ? 'dir' : 'file', source: 'baseline', size: info.size, modified: info.mtime.toISOString() }
  }

  /**
   * 目录枚举：合并基线目录与新增子项，递归合成父目录（#3.11）。
   * 返回的 path 一律是**逻辑路径**；目录项不带暂存路径（#3.2 / #3.3）。
   */
  listDir(target, opts = {}) {
    const { key: rel, external } = this.keyOf(target)
    const state = this.exists(target)
    if (!state.exists) throw new SandboxError('ENOENT', `directory ${target} does not exist`, { path: rel })
    if (state.kind !== 'dir') throw new SandboxError('ENOTDIR', `${target} is not a directory`, { path: rel })

    const merged = new Map()

    // 1) 基线项
    const abs = this.absolute(rel)
    if (existsSync(abs)) {
      for (const name of readdirSync(abs)) {
        const childRel = rel === '' ? name : join(rel, name)
        const childAbs = this.absolute(childRel)
        const info = statKind(childAbs)
        const source = info?.kind === 'dir' ? 'dir' : 'file'
        merged.set(compareKey(childRel), {
          path: childRel,
          name,
          kind: source,
          origin: 'baseline',
          symlink: info?.symlink === true,
          masked: this.maskOf(childAbs) !== undefined,
        })
      }
    }

    // 2) 暂存项覆盖 / 新增
    //    键空间隔离（S3a）：列的若是工作区内目录，只能合并工作区内条目；
    //    列的若是外部目录（绝对键），只能合并外部条目。否则 `C:\out` 会被当成
    //    工作区根的直接子项（`c:`）混进根枚举。
    const prefix = rel === '' ? '' : compareKey(rel) + sep.toLowerCase()
    for (const [key, entry] of Object.entries(this.manifest.entries)) {
      if ((entry.external === true) !== external) continue
      const ckey = compareKey(key)
      if (rel === '') {
        if (!ckey.includes(sep.toLowerCase())) {
          this.applyEntryToMerge(merged, key, entry, key)
        } else {
          const head = key.slice(0, key.search(/[\\/]/))
          this.applyEntryToMerge(merged, head, { kind: 'dir', state: entry.state === STATE.DELETED ? STATE.FILE : entry.state }, head, 'synthetic')
        }
      } else if (ckey.startsWith(prefix)) {
        const rest = key.slice(rel.length + 1)
        const head = rest.split(/[\\/]/)[0]
        const childRel = join(rel, head)
        const isDirect = !rest.slice(head.length).match(/[\\/]/)
        this.applyEntryToMerge(merged, childRel, isDirect ? entry : { kind: 'dir', state: STATE.FILE }, childRel, isDirect ? undefined : 'synthetic')
      }
    }

    // 3) 删除标记移除（删除对所有工具表现为不存在）
    for (const [key, entry] of Object.entries(this.manifest.entries)) {
      if (entry.state !== STATE.DELETED) continue
      if ((entry.external === true) !== external) continue
      const ckey = compareKey(key)
      if (rel === '') {
        if (!ckey.includes(sep.toLowerCase())) merged.delete(ckey)
        else {
          const head = key.slice(0, key.search(/[\\/]/))
          // 只有当该子目录整体被删除时才移除
          if (compareKey(head) === ckey) merged.delete(compareKey(head))
        }
      } else if (ckey.startsWith(prefix)) {
        const rest = key.slice(rel.length + 1)
        if (!rest.match(/[\\/]/)) merged.delete(ckey)
      }
    }

    let items = [...merged.values()]
    if (!opts.includeMasked) items = items.filter((item) => !item.masked)
    items = stableSort(items.map((i) => i.path)).map((p) => merged.get(compareKey(p)))

    if (opts.recursive) {
      const out = []
      for (const item of items) {
        out.push(item)
        if (item.kind === 'dir') {
          try {
            out.push(...this.listDir(this.absolute(item.path), { recursive: true, includeMasked: opts.includeMasked }))
          } catch {
            /* 合成目录可能没有真实对应物 */
          }
        }
      }
      return out
    }
    return items
  }

  applyEntryToMerge(merged, path, entry, origin, forcedKind) {
    const key = compareKey(path)
    if (entry.state === STATE.DELETED) {
      merged.delete(key)
      return
    }
    const kind = forcedKind || (entry.kind === 'dir' ? 'dir' : 'file')
    merged.set(key, {
      path,
      name: path.split(/[\\/]/).pop(),
      kind,
      origin: origin || (entry.kind === 'dir' ? 'staged' : 'staged'),
      symlink: false,
      masked: false,
    })
  }

  /**
   * 搜索：跨基线与暂存，删除标记不可见（#3.6 同一工作区所有读者看到同一版本）。
   */
  search(pattern, opts = {}) {
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern, opts.flags || 'i')
    const limit = opts.limit ?? 500
    const matches = []
    const walk = (rel) => {
      if (matches.length >= limit) return
      let items
      try {
        items = this.listDir(this.absolute(rel), { includeMasked: false })
      } catch {
        return
      }
      for (const item of items) {
        if (matches.length >= limit) return
        if (item.masked) continue
        if (opts.glob && !globMatch(opts.glob, item.name)) {
          if (item.kind === 'dir') walk(item.path)
          continue
        }
        if (item.kind === 'file') {
          let text
          try {
            text = this.readText(this.absolute(item.path))
          } catch {
            continue
          }
          if (text.includes('\u0000')) continue // 二进制跳过
          const lines = text.split(/\r?\n/)
          for (let i = 0; i < lines.length; i += 1) {
            if (regex.test(lines[i])) {
              matches.push({ path: item.path, line: i + 1, text: lines[i], origin: item.origin })
              if (matches.length >= limit) return
            }
          }
        } else {
          walk(item.path)
        }
      }
    }
    walk('')
    return matches
  }

  // ==================== 变更面 ====================

  ensureEntry(rel, opts = {}) {
    const existing = this.entryOf(rel)
    if (existing && existing.state !== STATE.DELETED) {
      // 幂等：已暂存路径不重复暂存（#3.10 —— 只要求"不新增条目"，不要求"不更新基线"）
      if (opts.kind && existing.kind !== opts.kind && existing.kind !== 'dir') {
        // 类型替换：记录并允许
        existing.kind = opts.kind
      }
      // ── P0-3：幂等早退**必须**把基线重述为真实磁盘当前值 ─────────────────────
      // 旧行为在此直接 `return existing`，`baseHash` 从此停在**首次暂存那一刻**的真实
      // 内容上。于是"暂存 v1 → 外部改了真实文件 → 再暂存 v2 同一路径"之后：
      //   · diff 的 before 仍是 v0（视图与现实不一致）；
      //   · `applyOneChange()` 拿 v0 与真实值比 ⇒ **STALE_BASELINE 永久拒绝**（"批不掉"）。
      // 现在每次（重新）暂存都以真实磁盘为基线 —— 与 `rebaseEntry()` 同一语义、同一判据
      // （只比 hash），因此"面板说没 stale"与"批准会成功"不会再互相矛盾。
      // #12.1 的硬闸门**不受影响**：它拦的是"最后一次暂存之后真实文件又被外部改动"
      // （那条路径不经过本方法），`tests/selftest.mjs` 的 #12.1/#12.2 逐字不动。
      if (opts.refreshBaseline !== false) {
        const absNow = this.absolute(rel)
        const infoNow = statKind(absNow)
        const baseNow = infoNow && infoNow.kind === 'file' ? hashFile(absNow) : hashAbsent()
        if (baseNow !== existing.baseHash) {
          if (baseNow !== hashAbsent()) this.store.putBlob(readFileSync(absNow))
          existing.baseHash = baseNow
          existing.baseKind = infoNow?.kind
          // WP8.2：基线被重述 ⇒ 宿主原件指纹同步重述，否则"未变才替换"会比错对象
          existing.baseFingerprint = infoNow?.kind === 'file' ? hostFileFingerprint(absNow) : undefined
          existing.baseRevision = this.manifest.revision
          // 新增键（只加不改）：记录"该条因外部漂移在重新暂存时被重述过"
          existing.baselineRefreshedAt = new Date().toISOString()
        }
        existing.changed = existing.stagedHash !== existing.baseHash
      }
      return existing
    }
    const abs = this.absolute(rel)
    const info = statKind(abs)
    const baseHash = info && info.kind === 'file' ? hashFile(abs) : hashAbsent()
    if (baseHash !== hashAbsent()) this.store.putBlob(readFileSync(abs))

    const entry = {
      path: rel,
      kind: info?.kind === 'dir' ? 'dir' : opts.kind || 'file',
      state: STATE.FILE,
      baseHash,
      baseKind: info?.kind,
      // WP8.2：宿主原件基线指纹（size + mtime + sha256）—— 应用前重算，未变才替换
      ...(info?.kind === 'file' ? { baseFingerprint: hostFileFingerprint(abs) } : {}),
      stagedHash: baseHash,
      symlink: info?.symlink === true,
      baseRevision: this.manifest.revision,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      changed: false,
      origin: opts.origin || 'tool',
      // 工作区**外**条目的显式标记（键就是规范化绝对路径，见 keyOf 的说明）。
      // 工作区内条目**不写这个字段**：保持既有清单形态逐字不变（可回归对照）。
      ...(isExternalKey(rel) ? { external: true, absPath: abs } : {}),
    }
    this.manifest.entries[rel] = entry
    return entry
  }

  /**
   * 写文件：新建或复制都先建受控父目录（#3.5）。
   *
   * S3a：`target` 在工作区**外**时同样进暂存 —— 键 = 规范化绝对路径，
   * 物化对象落在 `.dshstage/staged-ext/<分桶>/<basename>`，**真实磁盘一位不改**
   * （落盘只能经 applyCandidate，见 :applyOneChange）。
   */
  writeFile(target, content, opts = {}) {
    const { key: rel, external } = this.keyOf(target)
    if (rel === '') throw new SandboxError('EISDIR', 'cannot write the workspace root')
    const entry = this.ensureEntry(rel, { kind: 'file', origin: opts.origin })

    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8')
    const hash = this.store.putBlob(buffer)
    const stagedPath = this.staged(rel)
    mkdirSync(dirname(stagedPath), { recursive: true })
    writeFileSync(stagedPath, buffer)

    entry.kind = 'file'
    entry.state = STATE.FILE
    entry.stagedHash = hash
    entry.size = buffer.length
    entry.updatedAt = new Date().toISOString()
    entry.changed = hash !== entry.baseHash
    // 外部条目**不做**父目录合成：它的父目录是真实 NTFS 目录，且键不是相对路径，
    // 合成会产生 `C:` 这类畸形键（那也是 listDir 根枚举污染的来源）。
    if (!external) this.synthesizeParents(rel)
    this.store.touch(this.manifest)
    return { path: rel, hash, bytes: buffer.length, changed: entry.changed }
  }

  editText(target, edit, opts = {}) {
    const current = this.exists(target)
    const before = current.exists && current.kind === 'file' ? this.readText(target) : undefined
    const next = applyEdit(before, edit)
    const result = this.writeFile(target, next, opts)
    return { ...result, previousHash: before === undefined ? hashAbsent() : sha256Buffer(Buffer.from(before, 'utf8')) }
  }

  /** 删除：持久化删除标记，而不是"尽力而为"（#3.7 / 第 7 章）——工作区外同样只留墓碑 */
  remove(target, opts = {}) {
    const { key: rel, external } = this.keyOf(target)
    if (rel === '') throw new SandboxError('EPERM', 'refusing to delete the workspace root')
    const state = this.exists(target)
    if (!state.exists && !opts.missingOk) {
      // 已删除 → 幂等成功；从未存在 → 报错，避免幽灵删除（#3.1）
      const entry = this.entryOf(rel)
      if (entry?.state === STATE.DELETED) return { path: rel, deleted: true, idempotent: true }
      throw new SandboxError('ENOENT', `${target} does not exist`, { path: rel })
    }

    const entry = this.ensureEntry(rel, { origin: opts.origin })
    entry.state = STATE.DELETED
    entry.deletedAt = new Date().toISOString()
    entry.updatedAt = entry.deletedAt
    entry.changed = true
    delete entry.stagedHash

    // 释放临时资源（13.2 顺序：先解除引用，再删资源）
    const stagedPath = this.staged(rel)
    if (existsSync(stagedPath)) {
      const repair = makeRemovable(stagedPath)
      try {
        rmSync(stagedPath, { recursive: true, force: true })
      } catch (error) {
        entry.cleanupFailure = { code: error.code, message: error.message, repaired: repair.repaired }
      }
    }
    if (!external) this.synthesizeParents(rel)
    this.store.touch(this.manifest)
    return { path: rel, deleted: true, wasKind: state.kind }
  }

  createDirectory(target, opts = {}) {
    const { key: rel, external } = this.keyOf(target)
    if (rel === '') return { path: rel, created: false, reason: 'root' }
    const state = this.exists(target)
    if (state.exists) {
      if (state.kind === 'dir') return { path: rel, created: false, idempotent: true }
      throw new SandboxError('EEXIST', `${target} exists as a file`, { path: rel })
    }
    const entry = this.ensureEntry(rel, { kind: 'dir', origin: opts.origin })
    entry.kind = 'dir'
    entry.state = STATE.FILE
    entry.stagedHash = hashAbsent()
    entry.changed = entry.baseKind !== 'dir'
    mkdirSync(this.staged(rel), { recursive: true })
    if (!external) this.synthesizeParents(rel)
    this.store.touch(this.manifest)
    return { path: rel, created: true }
  }

  rename(from, to, opts = {}) {
    const { key: fromRel } = this.keyOf(from)
    const { key: toRel } = this.keyOf(to)
    const state = this.exists(from)
    if (!state.exists) throw new SandboxError('ENOENT', `${from} does not exist`, { path: fromRel })
    if (state.kind === 'file') {
      const content = this.readFile(from)
      this.remove(from, { missingOk: true, origin: opts.origin })
      this.writeFile(to, content, opts)
    } else {
      for (const item of this.listDir(from, { recursive: true })) {
        const childFrom = item.path
        const childTo = join(toRel, relative(fromRel, childFrom))
        if (item.kind === 'file') {
          const content = this.readFile(this.absolute(childFrom))
          this.remove(this.absolute(childFrom), { missingOk: true })
          this.writeFile(this.absolute(childTo), content, opts)
        } else {
          this.createDirectory(this.absolute(childTo), opts)
        }
      }
      this.remove(from, { missingOk: true, origin: opts.origin })
    }
    // 目标父目录必须先在逻辑上存在（#3.5）—— 仅工作区内键需要（外部键的父目录是真实目录）
    if (!isExternalKey(toRel)) this.synthesizeParents(toRel)
    this.store.touch(this.manifest)
    return { from: fromRel, to: toRel }
  }

  /** 递归补齐各级父目录，使目录树在逻辑视图里自洽（#3.11） */
  synthesizeParents(rel) {
    // 外部键（绝对路径）不合成：父目录是真实 NTFS 目录，按相对语义切分会得到 `C:` 这类畸形键
    if (isExternalKey(rel)) return
    const parts = segments(rel)
    parts.pop()
    let cursor = ''
    for (const part of parts) {
      cursor = cursor === '' ? part : join(cursor, part)
      const entry = this.entryOf(cursor)
      if (entry && entry.state !== STATE.DELETED) continue
      const abs = this.absolute(cursor)
      const info = statKind(abs)
      this.manifest.entries[cursor] = {
        path: cursor,
        kind: 'dir',
        state: STATE.FILE,
        baseHash: hashAbsent(),
        baseKind: info?.kind,
        stagedHash: hashAbsent(),
        synthetic: true,
        changed: info?.kind !== 'dir',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        origin: 'synthetic',
      }
    }
  }

  // ==================== 差异与候选 ====================

  /**
   * 净变化清单。无净变化返回空数组 → 调用方不得入队（#12.1）。
   *
   * S3a：工作区**外**条目的 `path` 就是它的**规范化绝对路径**（键即路径），
   * 并额外带 `external: true`；工作区内条目**不多写任何字段**（保持既有候选 JSON 逐字不变）。
   * 判级（三档）由第二阶段按 `change.path` + `change.external` 做，本层不改分级语义。
   */
  diffEntries() {
    const changes = []
    for (const rel of stableSort(Object.keys(this.manifest.entries))) {
      const entry = this.manifest.entries[rel]
      const external = entry.external === true ? { external: true } : {}
      /**
       * WP8.2：把**宿主原件基线指纹**随 `before` 一起透出（`hostFile` 键）。
       * 只在清单记过指纹（= 普通文件）时出现，因此目录/外部键的 `before` 形态逐字不变。
       */
      const hostFile = entry.baseFingerprint ? { hostFile: entry.baseFingerprint } : {}
      if (entry.state === STATE.DELETED) {
        if (entry.baseHash === hashAbsent() && entry.baseKind === undefined) continue // 删除一个从未存在的东西不算变化
        changes.push({
          path: rel,
          op: 'delete',
          kind: entry.baseKind === 'dir' ? 'dir' : 'file',
          before: { hash: entry.baseHash, kind: entry.baseKind, ...hostFile },
          after: { hash: hashAbsent() },
          ...external,
        })
        continue
      }
      if (entry.kind === 'dir') {
        if (entry.baseKind !== 'dir' && !entry.synthetic) {
          changes.push({ path: rel, op: 'mkdir', kind: 'dir', before: { hash: hashAbsent() }, after: { hash: hashAbsent() }, ...external })
        }
        continue
      }
      if (entry.stagedHash === entry.baseHash) continue // 内容与基线相同 → 无净变化
      changes.push({
        path: rel,
        op: entry.baseHash === hashAbsent() ? 'create' : 'modify',
        kind: 'file',
        before: { hash: entry.baseHash, kind: entry.baseKind, ...hostFile },
        after: { hash: entry.stagedHash, bytes: entry.size },
        ...external,
      })
    }
    return changes
  }

  /**
   * 冻结候选：before/after 两侧都在候选里冻结（#12.6）。
   * 同一分支同一路径的新候选取代旧待审（#3.8），但只在明确修订关系内（#12.1 / 12.3）。
   */
  freezeCandidate(opts = {}) {
    const changes = this.diffEntries()
    const hostOperations = this.manifest.hostOperations.filter((op) => op.status === 'pending')
    if (changes.length === 0 && hostOperations.length === 0) {
      // 无实际改动按只读完成处理（#12.1），host_op 例外（#12.4）
      return { enqueued: false, reason: 'no-net-change', changes: [], hostOperations: [] }
    }

    /**
     * ── WP5′：候选 id 的序号来自**单调计数器**而不是 `queue.order.length` ──────────
     *
     * 旧实现用 `order.length + 1`。一旦开始**修剪**（`pruneCandidates()` 把已被取代 /
     * 已应用的候选从 `order` 里摘掉），`order.length` 就不再单调，会**重发**已经用过的
     * 序号（`cs_0003` 出现第二次）。id 里还带 randomUUID，所以不会真的撞车，
     * 但"编号回退"会让审计与人工核对误判"这是同一件事"。因此序号改由 `queue.sequence`
     * 这个只增不减的计数器承担 —— 与 id 唯一性判据一致，且不依赖队列长度。
     */
    const sequence = Math.max(Number(this.queue.sequence) || 0, this.queue.order?.length || 0) + 1
    const id = newCandidateId(sequence)
    const createdAt = new Date().toISOString()
    const candidate = {
      version: CANDIDATE_VERSION,
      id,
      createdAt,
      sessionId: this.manifest.sessionId,
      workspaceRoot: this.root,
      revision: this.manifest.revision,
      source: opts.source || 'tool',
      status: CANDIDATE_STATUS.PENDING,
      supersededBy: undefined,
      changes: changes.map((change) => ({
        ...change,
        // 两侧 hash 直接指向 blob；blob 是内容寻址的，因此天然不可变
        frozen: true,
      })),
      hostOperations: hostOperations.map((op) => ({ ...op })),
      summary: summarize(changes, hostOperations),
    }

    this.store.saveCandidate(candidate)
    this.queue = this.store.loadQueue()
    this.queue.order.push(id)
    this.queue.candidates[id] = { id, status: CANDIDATE_STATUS.PENDING, createdAt, files: candidate.summary.files }

    // 取代：同一分支、同一路径的新修订取代旧待审（非全局按路径，见 #12.1）
    for (const otherId of this.queue.order) {
      if (otherId === id) continue
      const other = this.store.loadCandidate(otherId)
      if (!other || other.status !== CANDIDATE_STATUS.PENDING) continue
      if (other.sessionId !== candidate.sessionId) continue
      const overlapping = other.changes.some((c) => changes.some((n) => compareKey(n.path) === compareKey(c.path)))
      if (!overlapping) continue
      other.status = CANDIDATE_STATUS.SUPERSEDED
      other.supersededBy = id
      other.supersededAt = createdAt
      this.store.saveCandidate(other)
      this.queue.candidates[otherId] = { ...this.queue.candidates[otherId], status: CANDIDATE_STATUS.SUPERSEDED, supersededBy: id }
      this.queue.supersededBy[otherId] = id
    }

    this.queue.sequence = sequence
    // ── WP5′：冻结之后立刻**回收已终结的候选** ────────────────────────────────────
    // 旧实现把每一轮冻结产生的候选**永久**留在 `queue.order` + `candidates/*.json` 里：
    // 30 轮写入 ⇒ 30 份候选（每份都带全套 change 与两侧 hash），而 `listReviews()` 只按
    // `pending` 过滤 ⇒ 审批面上真正可用的永远只有最后一份，其余全是**只有成本没有信息**的
    // 历史堆积。owner 的原话是"多轮的中间产物不要保留…每一轮暂存都叠加的话会使计算量
    // 指数增长"。因此这里在**冻结这个唯一的入口**上做修剪：`superseded`（已被取代）
    // 与 `applied` 的候选是**已结案**的，落盘状态对后续任何决定都不再产生影响。
    this.pruneCandidates()
    this.store.saveQueue(this.queue)

    for (const op of hostOperations) op.status = 'enqueued'
    this.store.touch(this.manifest)
    return { enqueued: true, candidate, changes, hostOperations }
  }

  /**
   * ── WP5′：把已结案的候选**从队列与磁盘上移除**，让状态量与轮次解耦 ──────────────
   *
   * 判据（只有"绝对没有后续决定会读它"的状态才回收）：
   *   · `superseded`   —— 已被同路径的更新修订取代（`freezeCandidate()` 刚写过 supersededBy）。
   *                       任何读取都会沿 `supersededBy` 走到最新那份，因此旧那份是死数据。
   *                       若它还带 `hostOperations`（宿主操作台账），则**不回收**：
   *                       那张台账没有"取代"语义，丢了就等于丢账。
   *   · `applied`      —— 全部路径已落盘，`resolveCandidate()` 对它只会回 `ALREADY_APPLIED`，
   *                       而落盘事实已经由 **manifest 的 stagedHash/baseHash** 承担
   *                       （重放一次是 no-op，因为此时 `stagedHash === baseHash`），
   *                       所以候选文件不是任何事实的唯一载体。
   *
   * 刻意**不**回收：`pending` / `partially-applied` / `stale`（都还有决定价值）、
   * 以及注册表候选（它们的产物由 `src/registry-stage.mjs` 持有，本文件不越界处置）。
   *
   * 不变式（`_r3/wp5-test.mjs` 断言）：连续 N 轮写入后
   *   `queue.order.length` 与 `candidates/*.json` 的条数都 **≤ 1**，与 N 无关。
   *
   * @returns {{pruned: string[], kept: number}}
   */
  pruneCandidates(options = {}) {
    const queue = this.queue || this.store.loadQueue()
    queue.order = Array.isArray(queue.order) ? queue.order : []
    const keep = new Set()
    const pruned = []
    for (const id of queue.order) {
      const candidate = this.store.loadCandidate(id)
      if (!candidate) {
        // 文件已经不在了（上一轮修剪/外部清理）⇒ 从 order 里摘掉，避免幽灵条目
        pruned.push(id)
        continue
      }
      const registry = candidate.origin === 'registry' || candidate.source === 'registry-stage'
      const settled =
        candidate.status === CANDIDATE_STATUS.SUPERSEDED || candidate.status === CANDIDATE_STATUS.APPLIED
      const hasHostLedger = Array.isArray(candidate.hostOperations) && candidate.hostOperations.length > 0
      if (options.all === true || (settled && !hasHostLedger && !registry)) {
        pruned.push(id)
        /**
         * ── 修剪**必须**留下"这个 id 已结案"的墓碑（幂等性的关键）──────────────────
         * 候选文件删掉之后，`resolveCandidate(id)` 再也读不到它。若不记账，重复批准
         * （用户双击、命令重放、审计对账重跑）就会从"`ALREADY_APPLIED`（幂等无操作）"
         * 退化成 `CANDIDATE_NOT_FOUND`（**看起来像错误**）—— 这与 WP8.6 的"重复应用幂等"
         * 直接冲突，也会让审计面上出现假失败。
         * 墓碑是**单个 id → 终态**的映射（`queue.resolved`），因此它的大小只随"被真正
         * 应用/取代过的候选数"增长，而**不随每轮的 change 数量**增长：
         * 每个 id 只占一个短字符串，30 轮 ≈ 30 × ~30 字节，与"每轮一份完整候选"的量级
         * 完全不同（后者每份都带全套 before/after 与 blob 引用）。
         */
        const tombstone = candidate.status === CANDIDATE_STATUS.APPLIED ? 'applied' : 'superseded'
        queue.resolved = queue.resolved && typeof queue.resolved === 'object' ? queue.resolved : {}
        queue.resolved[id] = { status: tombstone, at: candidate.appliedAt ?? candidate.supersededAt ?? new Date().toISOString() }
        delete queue.candidates[id]
        try {
          rmSync(this.store.candidatePath(id), { force: true })
        } catch {
          // 回收失败**不改判据**：条目已从 order 摘除，它不再参与任何 UI/决定；
          // 磁盘上多留一个文件不影响正确性（也绝不因此让冻结失败）。
        }
        continue
      }
      keep.add(id)
    }
    queue.order = queue.order.filter((id) => keep.has(id))
    this.queue = queue
    return { pruned, kept: queue.order.length }
  }

  /** 待审列表：展开为按文件计数的口径（#12.7 / A27） */
  listReviews(opts = {}) {
    const out = []
    for (const id of this.queue.order) {
      const candidate = this.store.loadCandidate(id)
      if (!candidate) continue
      if (!opts.includeResolved && ![CANDIDATE_STATUS.PENDING, CANDIDATE_STATUS.PARTIALLY_APPLIED, CANDIDATE_STATUS.STALE].includes(candidate.status)) continue
      if (opts.path && !candidate.changes.some((c) => compareKey(c.path) === compareKey(opts.path))) continue
      out.push(candidate)
    }
    return out
  }

  /** 陈旧引用重定向：沿 superseded_by 链走到最新，带环路保护（#12.3） */
  resolveCandidate(id) {
    const seen = new Set()
    let current = id
    while (current) {
      if (seen.has(current)) {
        throw new SandboxError('CANDIDATE_CYCLE', `supersede chain contains a cycle at ${current}`, { chain: [...seen] })
      }
      seen.add(current)
      const candidate = this.store.loadCandidate(current)
      if (!candidate) {
        /**
         * ── WP5′：被修剪掉的候选 → 按**墓碑**回答，而不是 `CANDIDATE_NOT_FOUND` ─────────
         * `pruneCandidates()` 会把 `applied` / `superseded` 的候选从磁盘回收（否则状态量随
         * 轮次线性增长）。回收之后"重复批准同一个 id"必须仍然是**幂等无操作**：
         *   · `applied` 墓碑   ⇒ 和真身还在时一样回 `ALREADY_APPLIED`；
         *   · `superseded` 墓碑 ⇒ 回 `CANDIDATE_SUPERSEDED_BY_PRUNE`（该 id 已被更新修订取代，
         *     且取代它的那份也已结案）——**不是**"这个 id 从没存在过"。
         * 只有两条墓碑都不命中，才是真的 `CANDIDATE_NOT_FOUND`。
         */
        const resolved = (this.queue ?? this.store.loadQueue())?.resolved?.[current]
        if (resolved?.status === 'applied') return { candidate: { id: current, status: CANDIDATE_STATUS.APPLIED, changes: [], pruned: true }, idempotent: 'ALREADY_APPLIED' }
        if (resolved?.status === 'superseded') {
          throw new SandboxError('CANDIDATE_SUPERSEDED_BY_PRUNE', `candidate ${current} was superseded and has been reclaimed`, { id: current })
        }
        throw new SandboxError('CANDIDATE_NOT_FOUND', `candidate ${current} does not exist`, { id: current })
      }
      if (candidate.status === CANDIDATE_STATUS.APPLIED) return { candidate, idempotent: 'ALREADY_APPLIED' }
      if (candidate.status === CANDIDATE_STATUS.DISCARDED) {
        throw new SandboxError('CANDIDATE_DISCARDED', `candidate ${current} was discarded`, { id: current })
      }
      if (candidate.status === CANDIDATE_STATUS.SUPERSEDED && candidate.supersededBy) {
        current = candidate.supersededBy
        continue
      }
      return { candidate }
    }
    throw new SandboxError('CANDIDATE_NOT_FOUND', `candidate ${id} could not be resolved`)
  }

  /** 丢弃是一个有状态操作，不是删文件（#12.5 / A28） */
  discardCandidate(id, opts = {}) {
    const { candidate, idempotent } = this.resolveCandidate(id)
    if (idempotent === 'ALREADY_APPLIED') {
      throw new SandboxError('ALREADY_APPLIED', `candidate ${candidate.id} is already applied`, { id: candidate.id })
    }
    this.queue = this.store.loadQueue()
    candidate.status = CANDIDATE_STATUS.DISCARDED
    candidate.discardedAt = new Date().toISOString()
    candidate.discardReason = opts.reason || 'user'
    // 先持久化状态，再解除引用，最后回收存储（#13.1 顺序）
    this.store.saveCandidate(candidate)
    this.queue.candidates[candidate.id] = { ...this.queue.candidates[candidate.id], status: CANDIDATE_STATUS.DISCARDED }
    this.queue.discarded.push({ id: candidate.id, at: candidate.discardedAt, reason: candidate.discardReason })
    this.store.saveQueue(this.queue)
    return { discarded: candidate.id }
  }

  /**
   * 选择性应用。
   *   - 逐文件条件检查：真实文件自暂存以来被外部改动 → 该文件 STALE，不静默覆盖
   *   - 未选部分保留为可追踪修订，不丢弃整份候选（#12.2）
   */
  applyCandidate(id, opts = {}) {
    const { candidate, idempotent } = this.resolveCandidate(id)
    if (idempotent === 'ALREADY_APPLIED') {
      // WP5′：候选可能已被修剪（磁盘上只剩墓碑）⇒ 这里必须仍然返回**旧口径的完整形状**
      // （`applied/failed/remaining` 一个都不少），否则调用方的 `result.failed.length` 会炸。
      return { idempotent: 'ALREADY_APPLIED', applied: [], failed: [], blockedByMask: [], maskWarnings: [], conflicts: [], remaining: 0 }
    }
    const selected = opts.paths ? new Set(opts.paths.map(compareKey)) : undefined
    const chosen = candidate.changes.filter((change) => (selected ? selected.has(compareKey(change.path)) : true))

    const applied = []
    const failed = []
    /** 命中敏感策略、**等待二次确认**的条目（不是硬拒：确认后即可落盘） */
    const blockedByMask = []
    /** 允许落盘、但属敏感档的条目（第二阶段据此标 sensitive/danger，第三阶段据此做二次确认） */
    const maskWarnings = []
    /** 二次确认集合：`true` = 本次全部遮蔽项都已确认；数组 = 逐路径确认 */
    const confirmedMasks = opts.confirmedMasks
    const confirmedSet =
      confirmedMasks === true || confirmedMasks === undefined
        ? null
        : new Set([...confirmedMasks].map(compareKey))

    /**
     * ── WP8.2：**基线冲突预检（全选或全不选，绝不半覆盖）** ────────────────────────
     *
     * 本次真正会落盘的条目 = 选中 ∩（落盘后会有净变化的那些）。对其中每一条重算宿主原件
     * 指纹，与候选冻结时记下的那份比：**未变才替换**；变了就是冲突。
     *
     * 为什么预检要**先于任何写入**、且冲突时整批中止：审批是用户对一个批次的**一次**决定，
     * `conflicts` 里列出的是"我没敢动的那些"。如果一边替换了一部分、一边把另一部分判成冲突，
     * 用户会拿到一个**混合状态**（哪些生效了要靠读结果才知道），而"覆盖/放弃"这个选择
     * 本来是针对**整批**的。因此这里选择：只要有冲突 ⇒ 一个字节都不写、`applied=[]`、
     * `conflicts=[…]` 如实上报，由用户显式决定（面板的重试带 `force:true`，或改走 rebase/reject）。
     *
     * 与 `applyOneChange()` 的分工：这里管"整批拒绝"，那里管"逐条兜底"——`applyOneChange()`
     * 同样会检查（因此**不存在**"绕过预检就静默覆盖"的路径），且 `opts.force === true` 时两者
     * 都放行。这正是 `_r3/wp5-test.mjs` 断言④⑤的两条通道。
     */
    const conflicts = []
    const pendingChanges = []
    for (const change of chosen) {
      /**
       * 删除类**不参与**指纹冲突判定，判据是**内容 hash**（`applyOneChange()` 里的
       * `before.hash` 闸门）。理由（这里是幂等性的关键）：删除成功之后真实文件就**不在**了，
       * 而"文件不在"与冻结时记的指纹天生不符 ⇒ 若把删除也纳入指纹判据，
       * **重复应用同一次删除会永远被判冲突**，而"删除一个已经删掉的文件"恰恰应当是无操作。
       * 反过来说，指纹判据要保护的"原件被替换/改写"风险对删除并不存在：
       * 删除不写任何内容，它要么删掉当前那份、要么被 hash 闸门拦下。
       */
      if (change.op === 'delete' || change.after?.hash === hashAbsent()) continue
      // 内容已经是它要写的样子 ⇒ 无需替换 ⇒ 不参与冲突判定（幂等重批不该被自己的旧基线挡住）
      const current = existsSync(this.absolute(change.path)) ? hashFile(this.absolute(change.path)) : hashAbsent()
      if (current === change.after?.hash) continue
      pendingChanges.push(change)
    }
    if (opts.force !== true) {
      for (const change of pendingChanges) {
        const conflict = this.baselineConflictOf(change)
        if (!conflict) continue
        /**
         * 两条**内容 hash**（不是指纹里的 sha256 字段）一并带上：`applyOneChange()` 的
         * `STALE_BASELINE` 口径是"`before.hash` vs 磁盘当前 hash"，`driftReasonOf()` 要的
         * 正是这两个。指纹的 sha256 与 `before.hash` 内容相同但**语义不同**
         * （前者是"原件那一份"，后者是"暂存基线那一份"），因此不互相顶替。
         */
        const foundNow = existsSync(this.absolute(change.path))
          ? (statKind(this.absolute(change.path))?.kind === 'file' ? hashFile(this.absolute(change.path)) : hashAbsent())
          : hashAbsent()
        conflicts.push({
          path: change.path,
          op: change.op,
          ...conflict,
          expectedHash: change.before?.hash ?? hashAbsent(),
          foundHash: foundNow,
        })
      }
    }
    if (conflicts.length > 0) {
      /**
       * ── 两条通道都要给（口径不同，不是重复）────────────────────────────────────
       *   · `conflicts[]`（**新增**键）：结构化的人工/面板通道 —— 谁、什么形状、
       *     期望/实际指纹、变了哪几项。面板据此列"覆盖 / 放弃"。
       *   · `failed[]`（**既有**键）：逐条保留"若真的逐条落盘会抛什么"的**旧口径**
       *     （`code: 'STALE_BASELINE'` + `driftReason`）。旧消费者（`tests/selftest.mjs`
       *     的 #12.1、命令面的失败渲染）读的就是它；把整批预检做成"`failed` 为空"
       *     会让"拒绝覆盖"在它们眼里变成"什么都没发生" —— 那是**安全语义的静默降级**，
       *     比多一个字段危险得多。两者同源（都出自 `baselineConflictOf()`），不会漂移。
       */
      const failed = conflicts.map((conflict) => ({
        path: conflict.path,
        op: conflict.op,
        code: 'STALE_BASELINE',
        message: `real file changed after this edit was recorded (baseline conflict: ${conflict.changed.join('+')}); refusing to overwrite`,
        // 用的是**内容 hash**口径（与 `applyOneChange()` 同源），不是指纹里的 sha256 字段
        driftReason: driftReasonOf(conflict.expectedHash, conflict.foundHash),
        expected: conflict.expected,
        found: conflict.found,
      }))
      return {
        id: candidate.id,
        status: candidate.status,
        applied: [],
        failed,
        blockedByMask: [],
        maskWarnings: [],
        conflicts,
        remaining: chosen.map((change) => change.path),
        totalChanged: candidate.changes.length,
        requeued: true,
        // 命令面/面板据此列出"哪些文件在你暂存之后被改过"，并给出覆盖 / 放弃两个出口
        note: 'baseline-conflict: refused to overwrite host files that changed after staging (nothing was written)',
      }
    }

    for (const change of chosen) {
      const abs = this.absolute(change.path)
      const mask = this.maskOf(abs)
      if (mask) {
        const info = {
          path: change.path,
          maskId: mask.id,
          reason: mask.reason,
          hard: mask.hard === true,
          external: change.external === true,
        }
        // ── 命中敏感策略**不再死拦**（用户契约：弹窗说清后果 + 二次确认即可）。
        // 工作区**内**的遮蔽（首要是 `.dshstage` 自身存储）从"硬失败"改成**需二次确认**：
        // 未确认只回 `SANDBOX_PATH_MASKED_CONFIRM`（含后果说明），确认后正常落盘。
        // 工作区**外**的遮蔽维持原语义（落盘 + 警告）—— 它本来就没有拦。
        // `maskOf()` 对工作区内**非** `.dshstage` 的路径本就不判遮蔽（#16.8 的豁免），
        // 所以这一半管的就是 `.dshstage`/extraMasks 这一类。
        if (isInside(this.root, abs)) {
          const confirmed = confirmedMasks === true || (confirmedSet !== null && confirmedSet.has(compareKey(change.path)))
          if (!confirmed) {
            blockedByMask.push(info)
            failed.push({
              path: change.path,
              op: change.op,
              code: 'SANDBOX_PATH_MASKED_CONFIRM',
              message: `${mask.reason}（批准会把暂存内容写入真实磁盘且不可撤销；需要二次确认）`,
              maskId: mask.id,
              hard: mask.hard === true,
            })
            continue
          }
          maskWarnings.push({ ...info, confirmed: true })
        } else {
          maskWarnings.push(info)
        }
      }
      try {
        this.applyOneChange(change, opts)
        applied.push({ path: change.path, op: change.op })
      } catch (error) {
        failed.push({
          path: change.path,
          op: change.op,
          code: error.code || 'ERR',
          message: error.message,
          // `applyOneChange()` 的 STALE_BASELINE 分支在 details 里带着形状
          // （`driftReason`）⇒ 只加不改地透出给命令面；旧调用方读不到也照旧工作。
          ...(error?.detail?.driftReason ? { driftReason: error.detail.driftReason } : {}),
        })
      }
    }

    const allChanged = new Set(candidate.changes.map((c) => compareKey(c.path)))
    const appliedKeys = new Set(applied.map((a) => compareKey(a.path)))
    const remaining = candidate.changes.filter((c) => !appliedKeys.has(compareKey(c.path)))

    this.queue = this.store.loadQueue()
    let status
    if (applied.length === 0 && failed.length > 0) {
      status = candidate.status === CANDIDATE_STATUS.PENDING ? CANDIDATE_STATUS.PENDING : CANDIDATE_STATUS.STALE
    } else if (remaining.length > 0 || failed.length > 0) {
      status = CANDIDATE_STATUS.PARTIALLY_APPLIED
    } else {
      status = CANDIDATE_STATUS.APPLIED
    }
    candidate.status = status
    candidate.appliedAt = new Date().toISOString()
    candidate.appliedPaths = [...(candidate.appliedPaths || []), ...applied.map((a) => a.path)]
    candidate.lastApply = { applied, failed, blockedByMask, maskWarnings, conflicts: [] }
    this.store.saveCandidate(candidate)
    this.queue.candidates[candidate.id] = {
      ...this.queue.candidates[candidate.id],
      status,
      appliedFiles: candidate.appliedPaths.length,
      remainingFiles: remaining.length,
    }

    // 已应用的文件退出暂存（工作区已是新基线）
    for (const item of applied) {
      const entry = this.entryOf(item.path)
      if (!entry) continue
      if (change_isDelete(candidate, item.path)) {
        entry.baseHash = hashAbsent()
        entry.baseKind = undefined
        // WP8.2：删除之后**没有**原件可比 ⇒ 指纹必须一并清掉，
        // 否则下一次针对同路径的暂存会拿"上一个已消失的原件"当基线判冲突
        entry.baseFingerprint = undefined
        entry.state = STATE.DELETED
      } else {
        entry.baseHash = entry.stagedHash
        entry.baseKind = entry.kind
        // WP8.2：把基线指纹刷新成**刚落盘那份内容**的指纹。
        // 不刷新的话，"批准 → 外部改写 → 再次批准"这条链上的第二跳会把
        // "我们自己刚写的文件"误判成冲突（真实文件与冻结指纹不符），
        // 而它恰恰就是我们要保护的现状。
        entry.baseFingerprint = hostFileFingerprint(this.absolute(item.path))
        entry.changed = false
      }
    }
    if (applied.length > 0) this.store.touch(this.manifest)

    /**
     * ── WP5′：应用之后**回收已结案的候选** ────────────────────────────────────────
     * 全部应用成功 ⇒ 这份候选是 `applied`，任何后续决定都不会再读它（落盘事实已在 manifest
     * 的 `baseHash/stagedHash` 里）。不回收的话，"批准-再暂存-再批准"的每一轮都会在
     * `queue.order` + `candidates/*.json` 里留下一份**只增不减**的历史 —— 审批面的条目数
     * 就重新和轮次挂钩了，正是本轮要切断的那条线。
     * 只应用了一部分（`partially-applied`）时**不回收**：用户还要对它剩下的路径再决定。
     */
    if (status === CANDIDATE_STATUS.APPLIED) {
      this.pruneCandidates()
      this.store.saveQueue(this.queue)
    }

    return {
      id: candidate.id,
      status,
      applied,
      failed,
      blockedByMask,
      maskWarnings,
      // WP8.2：整批预检的冲突清单（非空 ⇒ `applied` 必为空；只加不改：老调用方读不到也照旧）
      conflicts: [],
      remaining: remaining.map((c) => c.path),
      totalChanged: allChanged.size,
      // 未选部分重新入队为可追踪修订（#12.2）
      requeued: remaining.length > 0,
    }
  }

  /**
   * ── WP8.2：单条变更的**宿主原件基线冲突**判定（`applyOneChange()` 与
   * `applyCandidate()` 的整批预检**共用这一个判据**，绝不各写一份）────────────────
   *
   * 指纹来源优先级：
   *   1. `change.before.hostFile` —— 候选里**冻结**的那一份（批准时唯一权威的口径：
   *      批准针对的就是这份冻结候选）；
   *   2. 清单条目上的 `baseFingerprint` —— 兜底（老候选没有 `hostFile` 时）；
   *   3. 两者都没有 ⇒ 返回 `null`（不判冲突）。这是**故意的宽松**：老清单/目录/外部键
   *      没有指纹可比，此时既有行为（`before.hash` 闸门）照旧生效，不新增拒绝面。
   *
   * @returns {{code:string,expected:object,found:object|null,changed:string[]}|null}
   */
  baselineConflictOf(change) {
    const expected = change?.before?.hostFile ?? this.entryOf(change?.path)?.baseFingerprint
    if (!expected) return null
    const abs = this.absolute(change.path)
    const found = hostFileFingerprint(abs)
    return baselineConflictOf(expected, found)
  }

  applyOneChange(change, opts) {
    const abs = this.absolute(change.path)
    // 条件检查：真实文件必须仍是我们记录的基线（#12.1）
    const realNow = existsSync(abs) && statKind(abs)?.kind === 'file' ? hashFile(abs) : hashAbsent()
    const expected = change.before?.hash ?? hashAbsent()
    if (!opts.force && realNow !== expected) {
      throw new SandboxError('STALE_BASELINE', `real file changed after this edit was recorded (expected ${expected}, found ${realNow}); refusing to overwrite`, {
        path: change.path,
        expected,
        found: realNow,
        // 缺陷②（F5b）：把**漂移形状**随失败一起上报，命令面/面板才能说清
        // "真实文件在暂存之后出现"（有内容丢失风险）而不是笼统的"基线已过期"。
        driftReason: driftReasonOf(expected, realNow),
      })
    }

    if (change.op === 'delete' || change.after?.hash === hashAbsent()) {
      if (existsSync(abs)) {
        const repair = makeRemovable(abs)
        try {
          /**
           * ── WP8.3（白障语义）：删除必须**真的落到宿主机**，且失败不留半成品 ──────────
           *
           * 先 `makeRemovable()` 摘掉只读/权限位，再 `rmSync`。`rmSync` 成功 ⇒ 白障生效；
           * 失败 ⇒ 抛 `EDELETE_FAILED`，**原文件仍在原处**（rmSync 是"全删或抛错"，
           * 不存在"删了一半的文件"这种中间态；目录树的递归删除也是先尽力再抛，
           * 此时 `repaired` 会把"我动过权限位"这件事如实带出去）。
           * 幂等由 `applyCandidate()` 的 entry 改写承担：成功后 `baseHash` 变 `absent`、
           * `state=deleted` ⇒ 该键退出 `diffEntries()`，重复批准是**无操作**。
           */
          rmSync(abs, { recursive: true, force: true })
        } catch (error) {
          throw new SandboxError('EDELETE_FAILED', `could not delete ${change.path}: ${error.message}`, {
            path: change.path,
            repaired: repair.repaired,
          })
        }
      }
      return
    }

    if (!this.store.hasBlob(change.after.hash)) {
      throw new SandboxError('BLOB_MISSING', `candidate content for ${change.path} is missing; candidate is unusable`, {
        path: change.path,
        hash: change.after.hash,
      })
    }
    const content = this.store.readBlob(change.after.hash)
    /**
     * ── WP8.2 逐条兜底：宿主原件指纹冲突 ⇒ 拒绝替换（`_r3/wp5-test.mjs` 断言⑤）─────
     *
     * 这条路与 `applyCandidate()` 的整批预检**必须都做**，理由不是重复，而是**覆盖所有入口**：
     * 除 `applyCandidate()` 之外，测试与自测会直接调它，"整批预检"在单条调用上根本不存在。
     * 两处用的是**同一个** `baselineConflictOf()`，所以不存在"两套判据"。
     */
    if (opts.force !== true) {
      const conflict = this.baselineConflictOf(change)
      if (conflict) {
        throw new SandboxError('BASELINE_CONFLICT', `host file changed since staging (${conflict.changed.join('+')}); refusing to overwrite`, {
          path: change.path,
          code: conflict.code,
          expected: conflict.expected,
          found: conflict.found,
          changed: conflict.changed,
        })
      }
    }
    // ── WP8.1 原子替换：同卷"临时文件 → 原子替换"（目标已存在时先摘再改，见函数注释）
    //    失败 ⇒ 抛错且**原文件一字节未动**（内容与临时文件都已提前备好，替换是最后一步）。
    writeFileAtomicReplacing(abs, content)
  }

  // ==================== 命令执行前后的物化与提取（#3.2 / 3.6 / A16） ====================

  /**
   * ── 缺陷③（Fix B）：`init` 面上的**修复路径** ───────────────────────────────────
   *
   * 检查暂存根上有没有"被显式写进去的 AppContainer 包 SID 允许 ACE"
   * （`S-1-15-2-…:(OI)(CI)(M)`，上一次 `--tier T0` 运行留下、却没被撤销），
   * 有就摘掉，让 T1 的暂存写重新可用。
   *
   * 为什么挂在 `init` 上：`init` 是用户"把这个工作区收拾好"的既有动词，
   * 而 `cli exec` 每次都会先 `executor.init()`；因此**下一次任何命令都会自愈**，
   * 与审计记下的"重跑 init 不自愈"正好相反。
   *
   * 判定与执行都在 `src/appcontainer.mjs`（纯 SDDL 判据）+ `src/executor.mjs`
   * （`repairStaleAppContainerAces`，用 icacls 落地），本方法只做工作区侧的转接，
   * 不重复实现判据（判据漂移会让"修复"和"测量"对不上）。
   *
   * @param {{repairImpl?: Function, runIcacls?: Function, readSddl?: Function}} [options] 注入缝（离线测试用）
   */
  repairStaleAppContainerAces(options = {}) {
    const impl = options.repairImpl ?? repairStaleAppContainerAces
    const result = impl(this.store.stagedDir, options)
    return { stagingRoot: this.store.stagedDir, ...result }
  }
  /** 执行前物化当前工作区版本到 staging root */
  materializeForExecution() {
    const report = { copied: 0, failed: [] }
    for (const [rel, entry] of Object.entries(this.manifest.entries)) {
      if (entry.state === STATE.DELETED) continue
      if (entry.kind === 'dir') {
        mkdirSync(this.staged(rel), { recursive: true })
        continue
      }
      const target = this.staged(rel)
      try {
        mkdirSync(dirname(target), { recursive: true })
        if (this.store.hasBlob(entry.stagedHash)) writeFileSync(target, this.store.readBlob(entry.stagedHash))
        report.copied += 1
      } catch (error) {
        report.failed.push({ path: rel, message: error.message })
      }
    }
    return report
  }

  /**
   * 执行后提取：相对输入版本的新增变化（#3.2）。
   * 只提取相对 staging 快照的净变化，不重复暂存已暂存路径（#3.10 幂等）。
   *
   * 重解析点（D8）：与 `snapshotStagedTree()` 共用 `walkStagedForHashes()`，
   * 因此 junction/symlink 既不会被 hash（否则 EISDIR 直接崩），也不会被误判成"被命令删除"
   * ——`seen` 里包含它们，下面的删除检测据此跳过。
   *
   * ── 删除的第二条来源：白障标记（缺陷①b）──────────────────────────────────────
   * 快照是**执行前**取的（`src\cli.mjs:204`），shim 不可能让一个"从未暂存过的路径"
   * 出现在里面；它在 `<staging root>\wo\…` 写下的标记才是"这条路径被删除了"的唯一痕迹。
   * 因此：内容对象消失（非 shim 档的 `del` 直接删暂存副本）与**新出现的白障标记**
   * 两条来源都要报删除，并按逻辑路径去重（同一次删除在两个面上都留痕时只报一次）。
   */
  captureAfterExecution(beforeSnapshot) {
    const changes = []
    const { hashes, realPaths, seen, whiteouts } = walkStagedForHashes(this.store.stagedDir)
    /** 已由"内容对象消失"报过删除的逻辑路径（compareKey），白障标记据此去重 */
    const deletedLogical = new Set()
    for (const [key, now] of hashes) {
      const before = beforeSnapshot.get(key)
      if (before === now) continue
      const change = { path: realPaths.get(key) ?? key, hash: now, previous: before }
      if (before === undefined) change.created = true
      changes.push(change)
    }
    // 被命令删除的文件：快照里有、现在没有
    for (const [key, previousHash] of beforeSnapshot) {
      if (hashes.has(key)) continue
      // 仍以重解析点形态存在 → 不是删除（walker 的 seen 里含它）
      if (seen.has(this.store.stagedPath(key))) continue
      const logical = realPaths.get(key) ?? key
      changes.push({ path: logical, hash: hashAbsent(), previous: previousHash, deleted: true })
      deletedLogical.add(compareKey(this.absolute(logical)))
    }
    // 新出现的白障标记 `wo\C\a\b` → 删除逻辑路径 `C:\a\b`
    const beforeWhiteouts = beforeSnapshot.whiteouts instanceof Map ? beforeSnapshot.whiteouts : new Map()
    for (const [whiteoutKey, logical] of whiteouts) {
      if (beforeWhiteouts.has(whiteoutKey)) continue // 上一次 exec 留下的标记：不是这次的变化
      if (deletedLogical.has(whiteoutKey)) continue // 两个面都留痕 → 只报一次
      // 沙箱自身存储在 `maskOf()` 里一律判遮蔽（#16.8），它的删除不是用户内容变化，
      // 不能变成待审候选；这里用词法判定（不解析链接），与 `keyOf()` 同一口径。
      if (lexicalInside(this.store.dir, logical) !== undefined) continue
      // 工作区**内**的路径用相对键（与工具面同一键空间），工作区外保留绝对键（S3a）
      const rel = lexicalInside(this.root, logical)
      changes.push({ path: rel === undefined ? logical : rel, hash: hashAbsent(), deleted: true })
    }
    return changes
  }

  /**
   * 执行前对暂存树做**内容戳快照**（#3.2 / A16）。
   *
   * ── 重解析点必须跳过（缺陷 D8；判定在 task-7 修好）────────────────────────────
   * `lstatSync(junction).isDirectory()` 在 Windows 上返回 **true**，而
   * `hashFile(junction)` 会跟随解析目标；目标若是目录就抛
   * `EISDIR: illegal operation on a directory, read`，
   * 于是一条 `cli exec` 会在**命令还没跑**的时候崩掉（exit=1）。
   * 守卫本身（`classifyEntry()`）在旧版是**恒 false 的假判据**（`mode & 0x400`），
   * task-7 用实测选型换成 `dirent.isSymbolicLink()` + 交叉校验，并补了环路防护。
   *
   * 跳过而不是"按目标内容记戳"的理由：重解析点在暂存树里不是一个内容对象，
   * 跟随解析会①越过暂存边界读取（可能是宿主任意目录，甚至形成环），
   * ②让"文件在暂存树里"这个前提失真。它在暂存树里表现为**不透明结点**，
   * 因此既不入快照，也不被当成"被命令删除了"。代价（如实记录）：
   * 暂存树内 junction 指向的目标内容变化**不会**被 `captureAfterExecution` 捕获。
   *
   * 返回值仍是 `Map`（调用方按 `Map` 用），另外挂两个**可观测**属性（不是静默跳过）：
   *   · `skippedReparsePoints: string[]` —— 被判为重解析点的路径（兼容既有调用方）；
   *   · `skipped: Array<{path, reason}>` —— **结构化**跳过记录，reason ∈
   *     `reparse-point` / `cycle-detected` / `depth-limit` / `whiteout-unmappable` /
   *     `unreadable:<CODE>`。
   *
   * 另挂 `whiteouts: Map<compareKey(逻辑绝对路径), 逻辑绝对路径>`（缺陷①b）：执行前已有的
   * 白障标记，`captureAfterExecution()` 用它做差集，只把**这次新出现**的标记报成删除。
   * `wo\` 子树在此**不进入内容戳**（`walkStagedForHashes()` 的统一口径），因此
   * 上一次运行留下的标记既不会被当成暂存内容对象，也不会被当成"暂存对象消失"。
   */
  snapshotStagedTree() {
    const { hashes, whiteouts, skippedReparsePoints, skipped } = walkStagedForHashes(this.store.stagedDir)
    hashes.skippedReparsePoints = skippedReparsePoints
    hashes.skipped = skipped
    hashes.whiteouts = whiteouts
    return hashes
  }

  /**
   * 把"沙箱内捕获到的变化"并入逻辑工作区（#3.2）。
   *
   * 为什么必须由 Workspace 承担（缺陷 D9）：`cli exec` 原先只打印 `capturedChanges` 的**条数**，
   * 从不把捕获结果写回清单，于是暂存树里明明有命令产出的文件，
   * `diffEntries()` 却一个变化都看不到 → `review` 永远是空队列 →
   * 文档承诺的 `exec → review → apply` 链路**根本跑不通**
   * （原始证据 `.t\sbx3\t-fs\out\07-cli-exec-clean-smoke.out` / `09-cli-status-clean-exec.out` /
   *  `10-cli-review-clean-exec.out`：执行成功、`capturedChanges=1`，但 `pendingCandidates=0`）。
   * 这段逻辑原先只存在于 `tests\e2e-flow.mjs` 里（测试自己在 CLI 之外手工补了这两步），
   * 属于"测试替被测代码干活"——所以这里把它搬进正主，测试改为调用本方法。
   *
   * 幂等（#3.10）：`captured` 是**相对执行前快照**的净变化，已暂存路径不会被重复暂存；
   * 内容相同的重复 exec 捕获为空数组，什么都不做。
   *
   * @param {Array<{path: string, hash: string, previous?: string, deleted?: boolean}>} captured
   * @returns {{ingested: number, deletions: number, skipped: Array<{path: string, reason: string}>}}
   */
  ingestCapturedChanges(captured = []) {
    const result = { ingested: 0, deletions: 0, skipped: [] }
    for (const change of captured) {
      // 一律经 absolute() 映射（而不是裸 join(root, path)）：
      // 万一 captured 里出现绝对路径（外部条目键就是绝对路径），
      // `join('C:\\ws', 'C:\\out\\a.txt')` 会得到 `C:\ws\C:\out\a.txt` 这种畸形路径。
      const abs = this.absolute(change.path)
      if (change.deleted) {
        try {
          this.remove(abs, { missingOk: true, origin: 'exec' })
          result.deletions += 1
        } catch (error) {
          result.skipped.push({ path: change.path, reason: error.message })
        }
        continue
      }
      // ── 取内容的口径必须与捕获口径一致：以**暂存树当前内容**为准 ──────────────
      // 曾经写成"优先复用条目里的 stagedHash"，那是**执行前**的内容戳，
      // 会直接把沙箱内进程刚写下的内容覆盖回去（实测：x=3 被还原成 x=2，
      // 于是 apply 落盘的是旧内容，e2e 阶段 9 红）。
      // 正确顺序：先按捕获到的 hash 找 blob（内容寻址，天然幂等），找不到再读暂存树物化对象。
      const hash = change.hash && change.hash !== hashAbsent() ? change.hash : undefined
      if (hash && this.store.hasBlob(hash)) {
        this.writeFile(abs, this.store.readBlob(hash), { origin: 'exec' })
        result.ingested += 1
        continue
      }
      const stagedPath = this.store.stagedPath(change.path)
      if (!existsSync(stagedPath)) {
        result.skipped.push({ path: change.path, reason: 'staged object missing; not ingesting' })
        continue
      }
      this.writeFile(abs, readFileSync(stagedPath), { origin: 'exec' })
      result.ingested += 1
    }
    return result
  }

  /**
   * 幂等冻结候选（缺陷 D9 的后半段）。
   *
   * `freezeCandidate()` 无条件新建候选并取代同路径旧待审；如果每次 `exec` 都调它，
   * 队列会被无意义地刷屏（同一个变更反复产生候选）。因此这里先看
   * 最新待审候选是否**恰好**覆盖当前净变化（按路径 + 操作 + 两侧 hash），
   * 是则复用，否则才冻结。判据与 `dsh-plugin\review-service.mjs::represents()` 同一口径。
   *
   * @returns {{frozen: boolean, candidate?: object, reason?: string, changes: number}}
   */
  freezeIfNeeded(opts = {}) {
    const changes = this.diffEntries()
    if (changes.length === 0) return { frozen: false, reason: 'no-net-change', changes: 0 }
    const pending = this.listReviews()
    const latest = pending[pending.length - 1]
    if (latest && candidateRepresents(latest.changes, changes)) {
      return { frozen: false, reason: 'already-represented', candidate: latest, changes: changes.length }
    }
    const frozen = this.freezeCandidate(opts)
    if (frozen.enqueued !== true) return { frozen: false, reason: frozen.reason || 'not-enqueued', changes: changes.length }
    return { frozen: true, candidate: frozen.candidate, changes: changes.length }
  }

  recordHostOperation(operation) {
    const op = {
      id: `host_${this.manifest.hostOperations.length + 1}_${Date.now().toString(36)}`,
      kind: operation.kind || 'host_op',
      summary: operation.summary,
      detail: operation.detail,
      riskLevel: operation.riskLevel || 'L2',
      status: 'pending',
      createdAt: new Date().toISOString(),
    }
    this.manifest.hostOperations.push(op)
    this.store.touch(this.manifest)
    return op
  }
}

function change_isDelete(candidate, path) {
  const change = candidate.changes.find((c) => compareKey(c.path) === compareKey(path))
  return change ? change.op === 'delete' : false
}

/**
 * 两份变更清单是否**恰好**描述同一件事（按路径 + 操作 + 两侧 hash）。
 *
 * 与 `dsh-plugin\review-service.mjs::represents()` 同一判据：只比较"做了什么"，
 * 不比较时间戳/候选 id，因此"同一批净变化重复冻结"会被识别为重复。
 */
function candidateRepresents(candidateChanges, changes) {
  if (!Array.isArray(candidateChanges) || candidateChanges.length !== changes.length) return false
  const index = new Map(candidateChanges.map((c) => [compareKey(c.path), c]))
  for (const change of changes) {
    const other = index.get(compareKey(change.path))
    if (!other) return false
    if (other.op !== change.op) return false
    if ((other.before?.hash ?? hashAbsent()) !== (change.before?.hash ?? hashAbsent())) return false
    if ((other.after?.hash ?? hashAbsent()) !== (change.after?.hash ?? hashAbsent())) return false
  }
  return true
}

function summarize(changes, hostOperations) {
  const byOp = {}
  for (const change of changes) byOp[change.op] = (byOp[change.op] || 0) + 1
  return {
    files: changes.length,
    hostOperations: hostOperations.length,
    byOp,
    bytes: changes.reduce((sum, c) => sum + (c.after?.bytes || 0), 0),
  }
}

export function applyEdit(before, edit) {
  if (typeof edit === 'string') {
    if (before === undefined) throw new SandboxError('ENOENT', 'cannot replace content of a nonexistent file without insert semantics')
    return edit
  }
  if (!edit || typeof edit !== 'object') throw new SandboxError('BAD_EDIT', 'edit must be a string or an object')
  let text = before
  if (edit.mode === 'create' || before === undefined) {
    if (edit.mode !== 'create' && before === undefined) throw new SandboxError('ENOENT', 'file does not exist')
    text = edit.content ?? ''
    if (edit.oldText) throw new SandboxError('BAD_EDIT', 'oldText is not valid when creating a file')
    return text
  }
  if (edit.oldText !== undefined) {
    const occurrences = text.split(edit.oldText).length - 1
    if (occurrences === 0) {
      throw new SandboxError('EDIT_NO_MATCH', 'oldText was not found; the file may have changed', { occurrences })
    }
    if (occurrences > 1 && !edit.replaceAll) {
      throw new SandboxError('EDIT_AMBIGUOUS', `oldText matched ${occurrences} times; refusing an ambiguous edit`, { occurrences })
    }
    text = edit.replaceAll ? text.split(edit.oldText).join(edit.newText ?? '') : text.replace(edit.oldText, edit.newText ?? '')
  }
  if (edit.append) text += edit.append
  if (edit.prepend) text = edit.prepend + text
  if (edit.insertAtLine !== undefined) {
    const lines = text.split('\n')
    lines.splice(edit.insertAtLine, 0, edit.content ?? '')
    text = lines.join('\n')
  }
  return text
}

export function globMatch(glob, name) {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^\\\\/]*')
    .replace(/\?/g, '.')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${pattern}$`, 'i').test(name)
}

export const __internal = { statKind, summarize, change_isDelete, lexical }
