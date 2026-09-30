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

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'
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
 * 判据用 `FILE_ATTRIBUTE_REPARSE_POINT`(0x400) 而不是只看 `isSymbolicLink()`：
 * junction / mount point 的 `isSymbolicLink()` 为 false，但属性位同样置位。
 * 这样"跳过重解析点"是一个**覆盖全类**的守卫，而不是只堵住已见过的那一种。
 */
function isReparsePoint(info) {
  if (!info) return false
  if (typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()) return true
  return (Number(info.mode ?? 0) & 0x400) !== 0
}

/**
 * 暂存树内容戳：一次遍历，返回
 *   `{ hashes: Map<rel, sha256>, realPaths: Map<rel, relOnDisk>, seen: Set<abs>, skippedReparsePoints: string[] }`
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
  const skippedReparsePoints = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const item = join(dir, name)
      const info = lstatSync(item)
      if (isReparsePoint(info)) {
        // junction/symlink 的 isDirectory() 可能为 true：绝不能递归，也绝不能 hash
        seen.add(item)
        skippedReparsePoints.push(item)
        continue
      }
      if (info.isDirectory()) {
        walk(item)
        continue
      }
      seen.add(item)
      const rel = relative(stagedDir, item)
      hashes.set(rel, hashFile(item))
      realPaths.set(rel, rel)
    }
  }
  if (existsSync(stagedDir)) walk(stagedDir)
  return { hashes, realPaths, seen, skippedReparsePoints }
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
    if (!entry) return { stale: false, expected: hashAbsent(), found: hashAbsent() }
    const info = statKind(this.absolute(rel))
    const found = info && info.kind === 'file' ? hashFile(this.absolute(rel)) : hashAbsent()
    const expected = entry.baseHash ?? hashAbsent()
    return { stale: found !== expected, expected, found }
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
      if (entry.state === STATE.DELETED) {
        if (entry.baseHash === hashAbsent() && entry.baseKind === undefined) continue // 删除一个从未存在的东西不算变化
        changes.push({
          path: rel,
          op: 'delete',
          kind: entry.baseKind === 'dir' ? 'dir' : 'file',
          before: { hash: entry.baseHash, kind: entry.baseKind },
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
        before: { hash: entry.baseHash, kind: entry.baseKind },
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

    const sequence = (this.queue.order?.length || 0) + 1
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
    this.store.saveQueue(this.queue)

    for (const op of hostOperations) op.status = 'enqueued'
    this.store.touch(this.manifest)
    return { enqueued: true, candidate, changes, hostOperations }
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
      return { idempotent: 'ALREADY_APPLIED', applied: [], failed: [], remaining: 0 }
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
        failed.push({ path: change.path, op: change.op, code: error.code || 'ERR', message: error.message })
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
    candidate.lastApply = { applied, failed, blockedByMask, maskWarnings }
    this.store.saveCandidate(candidate)
    this.queue.candidates[candidate.id] = {
      ...this.queue.candidates[candidate.id],
      status,
      appliedFiles: candidate.appliedPaths.length,
      remainingFiles: remaining.length,
    }
    this.store.saveQueue(this.queue)

    // 已应用的文件退出暂存（工作区已是新基线）
    for (const item of applied) {
      const entry = this.entryOf(item.path)
      if (!entry) continue
      if (change_isDelete(candidate, item.path)) {
        entry.baseHash = hashAbsent()
        entry.baseKind = undefined
        entry.state = STATE.DELETED
      } else {
        entry.baseHash = entry.stagedHash
        entry.baseKind = entry.kind
        entry.changed = false
      }
    }
    if (applied.length > 0) this.store.touch(this.manifest)

    return {
      id: candidate.id,
      status,
      applied,
      failed,
      blockedByMask,
      maskWarnings,
      remaining: remaining.map((c) => c.path),
      totalChanged: allChanged.size,
      // 未选部分重新入队为可追踪修订（#12.2）
      requeued: remaining.length > 0,
    }
  }

  applyOneChange(change, opts) {
    const abs = this.absolute(change.path)
    // 条件检查：真实文件必须仍是我们记录的基线（#12.1）
    const realNow = existsSync(abs) && statKind(abs)?.kind === 'file' ? hashFile(abs) : hashAbsent()
    const expected = change.before?.hash ?? hashAbsent()
    if (!opts.force && realNow !== expected) {
      throw new SandboxError('STALE_BASELINE', `real file changed since staging (expected ${expected}, found ${realNow}); refusing to overwrite`, {
        path: change.path,
        expected,
        found: realNow,
      })
    }

    if (change.op === 'delete' || change.after?.hash === hashAbsent()) {
      if (existsSync(abs)) {
        const repair = makeRemovable(abs)
        try {
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
    // 原子替换：临时文件 + rename（同卷）
    writeFileAtomic(abs, content)
  }

  // ==================== 命令执行前后的物化与提取（#3.2 / 3.6 / A16） ====================

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
   */
  captureAfterExecution(beforeSnapshot) {
    const changes = []
    const { hashes, realPaths, seen } = walkStagedForHashes(this.store.stagedDir)
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
      changes.push({ path: realPaths.get(key) ?? key, hash: hashAbsent(), previous: previousHash, deleted: true })
    }
    return changes
  }

  /**
   * 执行前对暂存树做**内容戳快照**（#3.2 / A16）。
   *
   * ── 重解析点必须跳过（缺陷 D8）──────────────────────────────────────────────
   * `lstatSync(junction).isDirectory()` 在 Windows 上返回 **true**，而
   * `hashFile(junction)` 会跟随解析目标；目标若是目录就抛
   * `EISDIR: illegal operation on a directory, read`，
   * 于是一条 `cli exec` 会在**命令还没跑**的时候崩掉（exit=1）。
   * 同一个文件里的 `captureAfterExecution()` 本来就有 `isSymbolicLink()` 守卫，
   * 这里补齐**同一口径、且覆盖 junction/mount point** 的守卫。
   *
   * 跳过而不是"按目标内容记戳"的理由：重解析点在暂存树里不是一个内容对象，
   * 跟随解析会①越过暂存边界读取（可能是宿主任意目录，甚至形成环），
   * ②让"文件在暂存树里"这个前提失真。它在暂存树里表现为**不透明结点**，
   * 因此既不入快照，也不被当成"被命令删除了"。代价（如实记录）：
   * 暂存树内 junction 指向的目标内容变化**不会**被 `captureAfterExecution` 捕获。
   *
   * 返回值仍是 `Map`（调用方按 `Map` 用），另外挂一个
   * `skippedReparsePoints` 数组属性作为**可观测证据**（不是静默跳过）。
   */
  snapshotStagedTree() {
    const { hashes, skippedReparsePoints } = walkStagedForHashes(this.store.stagedDir)
    hashes.skippedReparsePoints = skippedReparsePoints
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
