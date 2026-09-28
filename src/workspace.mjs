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
   */
  verifyProjection() {
    const corrupt = []
    for (const [rel, entry] of Object.entries(this.manifest.entries)) {
      if (entry.state === STATE.DELETED) continue
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
      // 词法上就在工作区外：按遮蔽表判定，命中即不可见
      return { exists: false, source: this.maskOf(target) ? 'masked' : 'outside' }
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

  hasStagedDescendant(rel) {
    const prefix = compareKey(rel) + sep.toLowerCase()
    for (const key of Object.keys(this.manifest.entries)) {
      if (compareKey(key).startsWith(prefix)) return true
    }
    return false
  }

  readFile(target) {
    const rel = this.relative(target)
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
    const rel = this.relative(target)
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
    const rel = this.relative(target)
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
    const prefix = rel === '' ? '' : compareKey(rel) + sep.toLowerCase()
    for (const [key, entry] of Object.entries(this.manifest.entries)) {
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
      // 幂等：已暂存路径不重复暂存（#3.10）
      if (opts.kind && existing.kind !== opts.kind && existing.kind !== 'dir') {
        // 类型替换：记录并允许
        existing.kind = opts.kind
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
    }
    this.manifest.entries[rel] = entry
    return entry
  }

  /** 写文件：新建或复制都先建受控父目录（#3.5） */
  writeFile(target, content, opts = {}) {
    const rel = this.relative(target)
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
    this.synthesizeParents(rel)
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

  /** 删除：持久化删除标记，而不是"尽力而为"（#3.7 / 第 7 章） */
  remove(target, opts = {}) {
    const rel = this.relative(target)
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
    this.synthesizeParents(rel)
    this.store.touch(this.manifest)
    return { path: rel, deleted: true, wasKind: state.kind }
  }

  createDirectory(target, opts = {}) {
    const rel = this.relative(target)
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
    this.synthesizeParents(rel)
    this.store.touch(this.manifest)
    return { path: rel, created: true }
  }

  rename(from, to, opts = {}) {
    const fromRel = this.relative(from)
    const toRel = this.relative(to)
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
    // 目标父目录必须先在逻辑上存在（#3.5）
    this.synthesizeParents(toRel)
    this.store.touch(this.manifest)
    return { from: fromRel, to: toRel }
  }

  /** 递归补齐各级父目录，使目录树在逻辑视图里自洽（#3.11） */
  synthesizeParents(rel) {
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
   */
  diffEntries() {
    const changes = []
    for (const rel of stableSort(Object.keys(this.manifest.entries))) {
      const entry = this.manifest.entries[rel]
      if (entry.state === STATE.DELETED) {
        if (entry.baseHash === hashAbsent() && entry.baseKind === undefined) continue // 删除一个从未存在的东西不算变化
        changes.push({
          path: rel,
          op: 'delete',
          kind: entry.baseKind === 'dir' ? 'dir' : 'file',
          before: { hash: entry.baseHash, kind: entry.baseKind },
          after: { hash: hashAbsent() },
        })
        continue
      }
      if (entry.kind === 'dir') {
        if (entry.baseKind !== 'dir' && !entry.synthetic) {
          changes.push({ path: rel, op: 'mkdir', kind: 'dir', before: { hash: hashAbsent() }, after: { hash: hashAbsent() } })
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
    const blockedByMask = []

    for (const change of chosen) {
      const abs = this.absolute(change.path)
      const mask = this.maskOf(abs)
      if (mask) {
        blockedByMask.push({ path: change.path, maskId: mask.id, reason: mask.reason })
        failed.push({ path: change.path, op: change.op, code: 'SANDBOX_PATH_MASKED', message: mask.reason })
        continue
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
    candidate.lastApply = { applied, failed, blockedByMask }
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
   */
  captureAfterExecution(beforeSnapshot) {
    const changes = []
    const seen = new Set()
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const item = join(dir, name)
        const info = lstatSync(item)
        if (info.isSymbolicLink()) {
          seen.add(item)
          continue
        }
        if (info.isDirectory()) {
          walk(item)
          continue
        }
        seen.add(item)
        const rel = relative(this.store.stagedDir, item)
        const before = beforeSnapshot.get(compareKey(rel))
        const now = hashFile(item)
        if (before === now) continue
        changes.push({ path: rel, hash: now, previous: before })
      }
    }
    if (existsSync(this.store.stagedDir)) walk(this.store.stagedDir)
    // 被命令删除的文件：快照里有、现在没有
    for (const [rel, previousHash] of beforeSnapshot) {
      if (seen.has(this.store.stagedPath(rel))) continue
      changes.push({ path: rel, hash: hashAbsent(), previous: previousHash, deleted: true })
    }
    return changes
  }

  snapshotStagedTree() {
    const snapshot = new Map()
    if (!existsSync(this.store.stagedDir)) return snapshot
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const item = join(dir, name)
        const info = lstatSync(item)
        if (info.isDirectory()) {
          walk(item)
          continue
        }
        snapshot.set(compareKey(relative(this.store.stagedDir, item)), hashFile(item))
      }
    }
    walk(this.store.stagedDir)
    return snapshot
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
