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
 *     candidates/<id>.json   候选元数据（不可变）
 *     queue.json             待审队列与丢弃状态
 *     real/<rel>             工作区只读映射（junction），受限进程可读不可写
 *     private/               会话私有 temp（01777 语义 → Windows ACL 授予独立 SID）
 *     cache/                 能力探测缓存（键=环境指纹）
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
import { dirname, join, normalize, sep } from 'node:path'

export const MANIFEST_VERSION = 1
export const CANDIDATE_VERSION = 1
export const STORE_DIR = '.dshstage'

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
    this.dir = join(workspaceRoot, STORE_DIR)
    this.manifestPath = join(this.dir, 'manifest.json')
    this.queuePath = join(this.dir, 'queue.json')
    this.blobDir = join(this.dir, 'blobs')
    this.stagedDir = join(this.dir, 'staged')
    this.candidateDir = join(this.dir, 'candidates')
    this.realDir = join(this.dir, 'real')
    this.privateDir = join(this.dir, 'private')
    this.cacheDir = join(this.dir, 'cache')
    this.ownerToken = options.ownerToken || randomUUID()
  }

  ensureLayout() {
    for (const dir of [this.dir, this.blobDir, this.stagedDir, this.candidateDir, this.realDir, this.privateDir, this.cacheDir]) {
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
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, buffer)
    }
    return hash
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

  stagedPath(relativePath) {
    return join(this.stagedDir, normalize(relativePath))
  }

  /** 真实路径 → 工作区相对路径（带边界校验，越界 fail-closed） */
  realPath(relativePath) {
    const clean = normalize(relativePath)
    if (clean.startsWith('..') || clean.includes(`..${sep}`)) {
      const error = new Error(`unsafe relative path: ${relativePath}`)
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
