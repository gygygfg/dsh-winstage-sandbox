/**
 * 存储层：内容寻址 blob + 暂存清单 + 候选队列
 *
 * 手册依据：
 *   #12.6  候选保存可验证的 before 与 after；diff 两侧都必须在候选里冻结
 *   #3.7   删除是持久逻辑状态，不能靠真实磁盘回填
 *   #13.1  逻辑解除引用 → 停止写入者 → 释放句柄 → 校验归属 → 删除资源 → 记录结果
 *   #13.1  E484 类教训：清理前先修复权限，且只作用在已验证归属的私有树
 *   #3.9   暂存路径要保留可识别的文件名语义（语言识别依赖 basename/扩展名）
 *
 * 布局：
 *   .dshstage/
 *     manifest.json          暂存清单（当前逻辑工作区）
 *     blobs/<aa>/<sha256>    内容寻址：base / staged / candidate 三层共用，自动去重
 *     staged/<rel>           物化暂存树（保留真实 basename 与扩展名，供语言识别与命令执行）
 *     staged-ext/<aa>/<hash>/<name>   工作区**外**条目的物化暂存对象（见下）
 *     candidates/<id>.json   候选元数据（不可变）
 *     queue.json             待审队列与丢弃状态
 *     real/<rel>             工作区只读映射（junction），受限进程可读不可写
 *     private/               会话私有 temp（01777 语义 → Windows ACL 授予独立 SID）
 *     cache/                 能力探测缓存（键=环境指纹）
 *
 * ── 清单键模型（S3a：工作区外条目）────────────────────────────────────────────
 * 工作区**内**条目的键 = 工作区相对路径（`a\b.txt`，从不以分隔符/盘符开头）。
 * 工作区**外**条目的键 = 该目标的**规范化绝对路径**（`C:\out\a.txt`），并在条目上带
 * `external: true` 标记。两者键空间天然不相交（相对路径不可能带盘符/前导分隔符），
 * 因此无需前缀，`entryOf()` 对两种键是同一个查找。
 *
 * 为什么 `stagedPath()` 对键做哈希分桶：相对键直接拼进 `staged/` 会保留目录语义；
 * 而绝对键不能直接拼（`C:\out\a.txt` 里的冒号在 Windows 上是非法文件名字符），
 * 所以外部条目的物化对象落在 `staged-ext/<hash 分桶>/<hash16>/<原 basename>` ——
 * **保留 basename 与扩展名**（#3.9 语言识别依赖它），目录语义由清单的键承担。
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path'
// ── Phase 1 / WP0：工作根搬到 Windows 缓存，并用句柄共享语义钉住 ────────────────────
// 契约与机制全在 `stage-guard.mjs` 文件头。这里只做三件事：
//   ① 默认根**不再**是工作区里的 `.dshstage`，而是 `resolveStageRoot(...)`（缓存路径）；
//   ② 根属于缓存面时**自动**建立守护（`acquireStageGuard`）；
//   ③ 每一次往暂存面写入**之前**先 `assertAlive()` —— 根没了就抛 `STAGE_ROOT_LOST`，
//      **绝不静默重建、绝不静默回退写真实盘**。
import { STAGE_ROOT_LOST, acquireStageGuard, resolveStageRoot, stageBaseDir, verifyStageRootAlive } from './stage-guard.mjs'
// ── 三轮接线：暂存配额（磁盘上限）──────────────────────────────────────────────────
// `store.mjs` 是 blob 的**唯一落盘路径**，因此配额闸门必须落在这里（`limits.mjs` 文件末的
// "接线契约①"点名了本文件）。默认配额 = `DEFAULT_LIMITS.stagingBytes`（64 GiB，对齐上游
// NeoAI 默认值），对既有调用方**无感**；`stagingQuotaBytes: null` 是唯一的显式关闭方式。
import { DEFAULT_LIMITS, checkStagingQuota, measureTree } from './limits.mjs'

export const MANIFEST_VERSION = 1
export const CANDIDATE_VERSION = 1
/** 旧布局的工作区目录名（Phase 1 起**只用于识别/迁移**，不再是默认根） */
export const STORE_DIR = '.dshstage'
/** 便利再导出：WP2/WP4 可以只 import `store.mjs` 就拿到稳定错误码 */
export { STAGE_ROOT_LOST }
/** 本 store 的存储面是不是"缓存工作根"（决定是否默认挂守护） */
function isStageCacheDir(dir, env) {
  const base = stageBaseDir(env).toLowerCase()
  const target = normalize(String(dir)).toLowerCase()
  return target === base || target.startsWith(`${base}${sep}`)
}

/** 逻辑状态（手册 3.1 表） */
export const STATE = {
  FILE: 'file', // 暂存文件：读暂存内容
  DELETED: 'deleted', // 删除标记：对所有工具表现为不存在
  CORRUPT: 'corrupt', // 记录存在但存储对象缺失 → 明确损坏，禁止回退真实磁盘
}

export const CANDIDATE_STATUS = {
  PENDING: 'pending',
  APPLIED: 'applied',
  PARTIALLY_APPLIED: 'partially-applied',
  SUPERSEDED: 'superseded',
  DISCARDED: 'discarded',
  STALE: 'stale',
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

export function hashFile(path) {
  return sha256Buffer(readFileSync(path))
}

export function hashAbsent() {
  return 'absent'
}

/**
 * 清单键是不是"工作区外条目"的键（= 规范化绝对路径）。
 * 相对键永远不以盘符/前导分隔符开头，所以这是**无歧义**的判别式。
 */
export function isExternalKey(key) {
  return typeof key === 'string' && key.length > 0 && isAbsolute(key)
}

/** 外部条目物化对象的安全叶名：保留 basename/扩展名，剔除 Windows 非法字符 */
function externalLeaf(key) {
  const raw = basename(normalize(key))
  const cleaned = String(raw)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
  return cleaned.length === 0 ? 'entry' : cleaned.slice(0, 120)
}

/** 外部条目的内容戳：不区分大小写（NTFS 默认），保证同一目标永远同一分桶 */
export function externalKeyDigest(key) {
  return sha256Buffer(Buffer.from(normalize(key).toLowerCase(), 'utf8'))
}

/** 原子写：先写临时文件再 rename，避免半写状态被后续读取到 */
export function writeFileAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 清理失败不掩盖原错误 */
    }
    throw error
  }
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export function writeJson(path, value) {
  writeFileAtomic(path, JSON.stringify(value, null, 2))
}

/**
 * 手册 #13.1 的清理前置：先把目录权限修回可删除，再删。
 * 只递归真实子目录，不跟随符号链接（避免越界修改用户目录）。
 */
export function makeRemovable(target) {
  if (!existsSync(target)) return { repaired: 0 }
  let repaired = 0
  const stack = [target]
  while (stack.length) {
    const current = stack.pop()
    let info
    try {
      info = lstatSync(current)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue // 不跟随链接
    if (info.isDirectory()) {
      const mode = info.mode & 0o777
      if (mode !== 0o700) {
        try {
          chmodSync(current, 0o700)
          repaired += 1
        } catch {
          /* 权限修复失败继续尝试删除，最终错误上报 */
        }
      }
      let entries = []
      try {
        entries = readdirSync(current)
      } catch {
        entries = []
      }
      for (const entry of entries) stack.push(join(current, entry))
    }
  }
  return { repaired }
}

export class Store {
  /** @param {string} workspaceRoot 真实工作区根（绝对路径，已 canonical） */
  constructor(workspaceRoot, options = {}) {
    this.workspaceRoot = workspaceRoot
    /**
     * 存储根（Phase 1 / WP0）。
     *
     * 默认**不再**是 `<workspaceRoot>/.dshstage`，而是 `resolveStageRoot(...)`：
     *   `<stageBaseDir>\<会话键>`，默认 `%LOCALAPPDATA%\Temp\winstage-stage\<会话键>`。
     * 显式覆盖有三条路，优先级：`storeDir` > `stageRoot` > 默认。
     *
     * `options.storeDir` 仍是**按会话隔离**的注入缝：`getReviewService({ sessionId })`
     * 现在应当传 `resolveStageRoot({ sessionKey, workspaceRoot })`（WP2/WP4 接线）；
     * 传别的路径也照旧工作（旧布局 `<root>/.dshstage/sessions/<key>` 仍能跑，
     * 只是不挂句柄守护）。
     */
    this.stageRootOverride = options.stageRoot !== undefined ? String(options.stageRoot) : undefined
    this.stageEnv = options.env
    this.dir = options.storeDir
      ? String(options.storeDir)
      : resolveStageRoot({
          sessionKey: options.sessionKey || options.sessionId,
          workspaceRoot,
          env: options.env,
          override: this.stageRootOverride,
        })
    /** 是否挂句柄守护：`false` 关、`true` 开、对象=直接用、缺省=缓存面才自动开 */
    if (options.stageGuard === false) this.stageGuardMode = 'off'
    else if (options.stageGuard === true) this.stageGuardMode = 'on'
    else if (options.stageGuard && typeof options.stageGuard === 'object') this.stageGuardMode = 'given'
    else this.stageGuardMode = 'auto'
    this.givenGuard = this.stageGuardMode === 'given' ? options.stageGuard : undefined
    this.guard = undefined
    /** 这个 store 的存储面是否受句柄守护（也决定写入前是否做"丢失即显形"断言） */
    this.stageGuarded =
      this.stageGuardMode === 'on' ||
      this.stageGuardMode === 'given' ||
      (this.stageGuardMode === 'auto' && isStageCacheDir(this.dir, this.stageEnv))
    this.manifestPath = join(this.dir, 'manifest.json')
    this.queuePath = join(this.dir, 'queue.json')
    this.blobDir = join(this.dir, 'blobs')
    this.stagedDir = join(this.dir, 'staged')
    /** 工作区**外**条目的物化暂存对象（哈希分桶，不参与 staged/ 的目录语义遍历） */
    this.stagedExtDir = join(this.dir, 'staged-ext')
    this.candidateDir = join(this.dir, 'candidates')
    this.realDir = join(this.dir, 'real')
    this.privateDir = join(this.dir, 'private')
    this.cacheDir = join(this.dir, 'cache')
    this.ownerToken = options.ownerToken || randomUUID()
    /**
     * ── 三轮接线：暂存配额 ──────────────────────────────────────────────────────
     * `stagingQuotaBytes`：暂存树允许占用的字节数。
     *   · 缺省 = `DEFAULT_LIMITS.stagingBytes`（64 GiB，`[官方]` 对齐上游 NeoAI 的
     *     `disk_bytes`）——**默认就生效**，但对既有小规模测试/会话无感；
     *   · `null` = 显式关闭（唯一关闭方式；写在代码里才看得见，不做隐式回落）。
     * `measureStaging`：统计实现的注入缝（默认 `limits.mjs::measureTree`）。
     *   生产路径**不传**；离线测试用它确定性地复现"统计截断 / 条目不可读"这类
     *   难复现故障（fail-closed 分支必须能被测到）。
     */
    this.stagingQuotaBytes = options.stagingQuotaBytes === undefined ? DEFAULT_LIMITS.stagingBytes : options.stagingQuotaBytes
    this.measureStaging = typeof options.measureStaging === 'function' ? options.measureStaging : measureTree
  }

  /**
   * 建立/取得守护（幂等）。返回 `undefined` 表示本 store 不挂句柄守护
   * （例如调用方显式 `stageGuard: false`，或存储面是旧布局 `<root>/.dshstage`）。
   *
   * ── 接线须知（WP2/WP4 + 离线测试，**实测**）────────────────────────────────────
   * `%LOCALAPPDATA%\Temp\winstage-stage` 对**被沙箱收窄的命令行子进程**是**只读**的：
   * 连 `mkdir` 都返回 `EPERM`（本机实测，pwsh 与 node 结果一致）。
   * 而**宿主进程**（DSH 插件所在进程，即 `write` 工具那条通道）可以创建并写入它。
   * 因此：
   *   · 生产路径（插件 = 宿主进程）**不需要**任何额外配置，默认根就是可用的；
   *   · 任何跑在**受限档**里的离线测试/脚本，必须显式把根指到可写处：
   *     `new Store(root, { stageRoot: <可写临时目录>, stageGuard: true })`，
   *     或 `new Store(root, { storeDir: <可写目录> })`（后者不挂守护）。
   * 建不出根时这里 **fail-closed**：抛 `STAGE_GUARD_UNAVAILABLE`，
   * **绝不静默回落**到工作区、也绝不"无守护地继续暂存"（那会让抗外部清理悄悄变成假）。
   */
  guardStageRoot() {
    if (!this.stageGuarded) return undefined
    if (this.guard) return this.guard
    this.guard = this.givenGuard || acquireStageGuard(this.dir, { env: this.stageEnv })
    return this.guard
  }

  /**
   * "丢失即显形"的唯一闸门：**每一次**往暂存面写之前都要过这一关。
   *
   * 判据交给 `stage-guard.mjs::assertAlive()`（根在 + 标记在 + 哨兵未被篡改 + 守护存活）。
   * 任一失效 ⇒ 抛 `StageRootLostError`（`code === STAGE_ROOT_LOST`）。
   *
   * ⚠ 这里**不做任何重建**：根被外部清掉之后"顺手再建一个"正是必须避免的静默行为 ——
   * 那会把"暂存面被抹掉"伪装成什么都没发生，并且让后续写入落到一个**不再受守护**的目录里。
   */
  assertStageAvailable() {
    if (!this.stageGuarded) return { alive: true, reason: 'unguarded' }
    return this.guardStageRoot().assertAlive()
  }

  /** 只看不建：当前存储面的存活状态（供审批面/自检报告根因） */
  stageStatus() {
    if (!this.stageGuarded) return { alive: true, reason: 'unguarded', root: this.dir }
    const status = verifyStageRootAlive(this.dir)
    return { ...status, guarded: true }
  }

  /**
   * 正常释放（退出清理的调用点）：守护释放句柄并清空该根。
   * 宿主进程退出时会话根由守护自动清理；这里给"知道自己在收尾"的调用方一个确定性的出口。
   */
  releaseStageGuard(options = {}) {
    if (!this.guard) {
      return { root: this.dir, removed: !existsSync(this.dir), alreadyReleased: true }
    }
    const report = this.guard.release(options)
    this.guard = undefined
    return report
  }

  ensureLayout() {
    // 守护必须先于布局建立：根从第一次落盘起就被钉住，而不是"建完再补个锁"。
    this.assertStageAvailable()
    for (const dir of [this.dir, this.blobDir, this.stagedDir, this.stagedExtDir, this.candidateDir, this.realDir, this.privateDir, this.cacheDir]) {
      mkdirSync(dir, { recursive: true })
    }
    return this
  }

  // ---------- 内容寻址 ----------

  blobPath(hash) {
    return join(this.blobDir, hash.slice(0, 2), hash)
  }

  hasBlob(hash) {
    return hash !== hashAbsent() && existsSync(this.blobPath(hash))
  }

  /** 把内存内容落成一个 blob，返回 sha256 */
  putBlob(buffer) {
    const hash = sha256Buffer(buffer)
    const path = this.blobPath(hash)
    if (!existsSync(path)) {
      // ── Phase 1 / WP0：「丢失即显形」的闸门必须在**写入之前** ─────────────────
      // 根被外部清掉时，这里的 `existsSync(path)` 也是 false —— 如果不先断言，
      // 下面 `mkdirSync(dirname(path))` 就会把根**静默重建**成一个没有守护的普通目录。
      this.assertStageAvailable()
      // ── 三轮接线：配额闸门放在**写入之前**（写完再量只能事后发现超了，磁盘已经占了）──
      // 内容寻址：hash 已存在时直接返回，不重复写、也不消耗配额（去重语义逐字不变）。
      this.assertStagingQuota(buffer.length)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, buffer)
    }
    return hash
  }

  /**
   * 暂存配额闸门（fail-closed，两条判据）。
   *
   * `limits.mjs::checkStagingQuota()` 的入参是数字，它**看不到** `measureTree` 的
   * `errors[]/truncated`；其文件末"接线契约①"明确要求调用方在统计不完整时按
   * "已用 = 无上限"处理。本方法就是那个调用方：
   *   1. `measure.complete === false`（截断或条目出错）⇒ `STAGING_QUOTA_MEASUREMENT_INCOMPLETE`；
   *      **统计不了的树等于配额的洞**，宁可拒绝写入；
   *   2. `allowed === false`（used + incoming > quota）⇒ `STAGING_QUOTA_EXCEEDED`。
   *     `limits.mjs` 的口径是"恰好用满"放行（零余量），本方法不额外收紧。
   *
   * 抛的是带 `code` 的类型化错误（与 `BLOB_MISSING` 同风格），并把完整判定挂在 `error.quota`
   * 上，便于审批面解释根因（used/quota/headroom/reason 一个都不丢）。
   */
  assertStagingQuota(incomingBytes = 0) {
    if (this.stagingQuotaBytes === null) {
      this.assertStageAvailable()
      return { allowed: true, reason: 'staging quota explicitly disabled (stagingQuotaBytes:null)' }
    }
    this.assertStageAvailable()
    // 根不存在不是"统计不完整"，而是"空树"：先建出来，免得把 ENOENT 读成配额洞。
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    const decision = checkStagingQuota({
      root: this.dir,
      quotaBytes: this.stagingQuotaBytes,
      incomingBytes,
      measure: this.measureStaging,
    })
    if (decision.measure && decision.measure.complete === false) {
      const error = new Error(
        `STAGING_QUOTA_MEASUREMENT_INCOMPLETE: 暂存树统计不完整（truncated=${decision.measure.truncated}, ` +
          `errors=${decision.measure.errors}, skipped=${decision.measure.skipped}），拒绝写入 ${incomingBytes} 字节 —— ` +
          `${decision.reason}`,
      )
      error.code = 'STAGING_QUOTA_MEASUREMENT_INCOMPLETE'
      error.quota = decision
      throw error
    }
    if (!decision.allowed) {
      const error = new Error(`STAGING_QUOTA_EXCEEDED: 暂存配额不足，拒绝写入 ${incomingBytes} 字节 —— ${decision.reason}`)
      error.code = 'STAGING_QUOTA_EXCEEDED'
      error.quota = decision
      throw error
    }
    return decision
  }

  /** 把已有文件内容落成 blob（用于冻结 base/after） */
  putBlobFromFile(sourcePath) {
    return this.putBlob(readFileSync(sourcePath))
  }

  /** 把 blob 还原到目标路径（物理替换语义，手册 #7.3） */
  materializeBlob(hash, targetPath, options = {}) {
    if (hash === hashAbsent()) {
      // 删除语义：移除目标
      rmSync(targetPath, { recursive: true, force: true })
      return { removed: true }
    }
    mkdirSync(dirname(targetPath), { recursive: true })
    if (options.useRename) {
      const tmp = `${targetPath}.stage-${randomUUID().slice(0, 8)}`
      copyFileSync(this.blobPath(hash), tmp)
      if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true })
      renameSync(tmp, targetPath)
    } else {
      if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true })
      copyFileSync(this.blobPath(hash), targetPath)
    }
    return { removed: false }
  }

  readBlob(hash) {
    if (!this.hasBlob(hash)) {
      const error = new Error(`blob missing for hash ${hash}`)
      error.code = 'BLOB_MISSING'
      throw error
    }
    return readFileSync(this.blobPath(hash))
  }

  // ---------- 清单 ----------

  loadManifest() {
    const raw = readJson(this.manifestPath, undefined)
    if (!raw) return undefined
    if (raw.version !== MANIFEST_VERSION) {
      const error = new Error(`unsupported manifest version ${raw.version}`)
      error.code = 'MANIFEST_VERSION'
      throw error
    }
    return raw
  }

  saveManifest(manifest) {
    this.assertStageAvailable()
    writeJson(this.manifestPath, manifest)
  }

  createManifest(meta = {}) {
    const now = new Date().toISOString()
    const manifest = {
      version: MANIFEST_VERSION,
      sessionId: meta.sessionId || randomUUID(),
      ownerToken: this.ownerToken,
      workspaceRoot: this.workspaceRoot,
      createdAt: now,
      updatedAt: now,
      revision: 0,
      entries: {},
      hostOperations: [],
    }
    this.saveManifest(manifest)
    return manifest
  }

  /** 读取清单，若不存在则创建（幂等） */
  manifest(meta = {}) {
    const existing = this.loadManifest()
    if (existing) return existing
    this.ensureLayout()
    return this.createManifest(meta)
  }

  touch(manifest) {
    manifest.updatedAt = new Date().toISOString()
    manifest.revision = (manifest.revision || 0) + 1
    this.saveManifest(manifest)
    return manifest
  }

  /**
   * 清单键 → 物化暂存对象的绝对路径。
   *
   * 相对键（工作区内）：沿用 `staged/<rel>`（保留完整目录语义，命令执行的 cwd 就是它）。
   * 绝对键（工作区外）：`staged-ext/<aa>/<hash16>/<basename>` —— 绝对路径不能直接拼进
   * `staged/`（`C:` 的冒号是 Windows 非法文件名字符），故按稳定哈希分桶，只保留叶名。
   */
  stagedPath(key) {
    if (isExternalKey(key)) {
      const digest = externalKeyDigest(key)
      return join(this.stagedExtDir, digest.slice(0, 2), digest.slice(0, 16), externalLeaf(key))
    }
    return join(this.stagedDir, normalize(key))
  }

  /**
   * 清单键 → **真实目标**绝对路径（带边界校验，越界 fail-closed）。
   *
   * 绝对键 = 工作区外目标：键本身就是它的真实路径，直接返回（键在建立时已 canonical）。
   * 相对键 = 工作区内：仍然做 `..` 逃逸校验，行为与改动前逐字一致。
   */
  realPath(key) {
    if (isExternalKey(key)) return normalize(key)
    const clean = normalize(key)
    if (clean.startsWith('..') || clean.includes(`..${sep}`)) {
      const error = new Error(`unsafe relative path: ${key}`)
      error.code = 'UNSAFE_RELATIVE_PATH'
      throw error
    }
    return join(this.workspaceRoot, clean)
  }

  // ---------- 队列 ----------

  loadQueue() {
    const raw = readJson(this.queuePath, undefined)
    if (!raw || raw.version !== 1) {
      return { version: 1, order: [], candidates: {}, supersededBy: {}, discarded: [] }
    }
    return raw
  }

  saveQueue(queue) {
    this.assertStageAvailable()
    writeJson(this.queuePath, queue)
  }

  // ---------- 候选 ----------

  candidatePath(candidateId) {
    return join(this.candidateDir, `${candidateId}.json`)
  }

  loadCandidate(candidateId) {
    return readJson(this.candidatePath(candidateId), undefined)
  }

  saveCandidate(candidate) {
    this.assertStageAvailable()
    writeJson(this.candidatePath(candidateIdOf(candidate)), candidate)
  }

  listCandidateIds() {
    if (!existsSync(this.candidateDir)) return []
    return readdirSync(this.candidateDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort()
  }

  // ---------- 归属与清理 ----------

  /** 校验归属：只清理带本 store 标记的私有树（手册 #13.1） */
  verifyOwnership() {
    const manifest = this.loadManifest()
    if (!manifest) return { ok: true, reason: 'no-manifest' }
    if (manifest.workspaceRoot && normalize(manifest.workspaceRoot) !== normalize(this.workspaceRoot)) {
      return { ok: false, reason: `manifest workspace mismatch: ${manifest.workspaceRoot}` }
    }
    return { ok: true, reason: 'owned' }
  }

  /** 清理单个 blob 之外的资源：按 13.2 顺序执行 */
  disposeResources(targets = []) {
    const report = { removed: [], failed: [], repaired: 0 }
    for (const target of targets) {
      if (!existsSync(target)) continue
      const repair = makeRemovable(target)
      report.repaired += repair.repaired
      try {
        rmSync(target, { recursive: true, force: true })
        report.removed.push(target)
      } catch (error) {
        report.failed.push({ target, code: error.code || 'ERR', message: error.message })
      }
    }
    return report
  }

  /** 回收无引用的 blob（被任何层引用的都不动） */
  collectGarbage(options = {}) {
    const referenced = new Set()
    const manifest = this.loadManifest()
    if (manifest) {
      for (const entry of Object.values(manifest.entries)) {
        if (entry.baseHash && entry.baseHash !== hashAbsent()) referenced.add(entry.baseHash)
        if (entry.stagedHash && entry.stagedHash !== hashAbsent()) referenced.add(entry.stagedHash)
      }
    }
    const queue = this.loadQueue()
    for (const id of queue.order) {
      const candidate = this.loadCandidate(id)
      if (!candidate) continue
      for (const change of candidate.changes || []) {
        if (change.before?.hash && change.before.hash !== hashAbsent()) referenced.add(change.before.hash)
        if (change.after?.hash && change.after.hash !== hashAbsent()) referenced.add(change.after.hash)
      }
    }

    const report = { scanned: 0, removed: 0, kept: referenced.size, freedBytes: 0, failures: [] }
    if (!existsSync(this.blobDir)) return report
    const apply = options.apply === true
    for (const shard of readdirSync(this.blobDir)) {
      const shardDir = join(this.blobDir, shard)
      if (!lstatSync(shardDir).isDirectory()) continue
      for (const name of readdirSync(shardDir)) {
        report.scanned += 1
        if (referenced.has(name)) continue
        const path = join(shardDir, name)
        const bytes = statSync(path).size
        if (apply) {
          try {
            unlinkSync(path)
            report.removed += 1
            report.freedBytes += bytes
          } catch (error) {
            report.failures.push({ path, message: error.message })
          }
        }
      }
    }
    return report
  }
}

export function candidateIdOf(candidate) {
  return candidate.id
}

export function newCandidateId(sequence) {
  return `cs_${String(sequence).padStart(4, '0')}_${randomUUID().slice(0, 8)}`
}
