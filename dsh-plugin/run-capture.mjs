/**
 * WinStage 执行后捕获（run capture）—— **监视真实主机**并产出可验证的候选。
 *
 * ── 它补的是哪一段空白 ────────────────────────────────────────────────────────
 * `src/workspace.mjs` 已有的捕获先例（`snapshotStagedTree()` / `captureAfterExecution()` /
 * `ingestCapturedChanges()`，约 1199-1299 行）盯的是**暂存树**：命令在暂存树里跑，执行前后
 * 各做一次内容戳，差值并入清单。但 `bash` / `pwsh` / 真实子进程的写入**不经过 `ctx.fs`**
 * （见 `staging-fs.mjs` 文件头第 30 行），它们直接改真实主机；暂存树里一位没动，于是
 * "命令改了宿主、审阅面板却空着"。本模块就是这一段的捕获面：**在真实主机上取执行前镜像，
 * 执行后比对，把净变化搬进暂存并冻结候选，最后把主机还原成执行前的样子**。
 *
 * ── 与既有先例逐条对齐的口径（照抄，不另立一套）─────────────────────────────
 *   1. **跳过重解析点**：与 `workspace.mjs::isReparsePoint()` 同判据
 *      （`isSymbolicLink()` **或** `FILE_ATTRIBUTE_REPARSE_POINT` 0x400 属性位）。
 *      只判 `isSymbolicLink()` 会漏掉 junction/mount point —— 那是实测崩过的缺陷 D8。
 *   2. **幂等**：同一内容重复捕获不产生重复候选。判据复用既有的
 *      `freezeIfNeeded()` → `candidateRepresents()`（按路径 + 操作 + 两侧 hash），
 *      本模块**不自建**第二套"什么算重复"。
 *   3. **删除语义**：删除是持久逻辑状态，after 侧用 `store.hashAbsent()` 哨兵，
 *      与 `diffEntries()` / `applyOneChange()` 同口径；"删除一个从未存在的东西不算变化"
 *      这条由 `diffEntries()` 自己把守，本模块不去绕它。
 *   4. **无净变化不入队**（手册 #12.1）：`changes` 为空时一次日志都不写、一个候选都不建。
 *   5. **失败必须响**（C2）：单点失败一律进 `failures` **并且** `log(..., 'error')`；
 *      `capture()` 绝不抛异常。
 *
 * ── ⚠ 关键设计决定：入队前**必须显式钉住 before 基线**（不这么做就是假绿）────────
 * 落暂存走 `workspace.writeFile()`，而 `ensureEntry()` 每次都会把
 * `baseHash/baseKind` 重述为**真实磁盘当前值**（那是 P0-3 的修复，对"经 `ctx.fs` 的写入"
 * 完全正确）。但执行后捕获的顺序是"磁盘已经是 after → 落暂存 → 再把磁盘还原成 before"，
 * 于是那次基线重述会把 `baseHash` 钉成 **after** ⇒ `diffEntries()` 里
 * `stagedHash === baseHash` ⇒ **零净变化 ⇒ 永远不入队**。而且还原得越忠实，这个洞越深。
 * 因此 `stage()` 在 `writeFile()` 之后**按捕获到的 before/after 覆写条目基线**
 * （`baseHash` / `baseKind` / `changed`），与 `rebaseEntry()` 在同一层、用同一套字段
 * （`entry.baseHash` / `entry.baseKind` / `entry.changed`）。
 * 这不是绕过既有口径，而是把"条目是相对哪个基线的一笔 diff"这句话**说准**。
 *
 * ── 镜像索引（执行前镜像的唯一权威）──────────────────────────────────────────
 * `<store.dir>/capture-mirror.json`：本模块**自己的**文件，刻意与
 * `manifest.json` / `review.json` / `queue.json` 分开（那三份的写入者与契约都属于
 * Store / ReviewService，本模块一个字节都不碰）。
 * 每条含 `hash`（内容寻址的 **before**）、`size`、`mtimeMs`（仅作诊断，**不参与判变**）。
 *
 * ── 为什么 `diff()` 只认内容哈希 ─────────────────────────────────────────────
 * mtime 会骗人：还原（`materializeBlob` 走 copy/rename）会刷新 mtime，
 * 于是"改完又还原"这种最常见形态会被 mtime 判成有变化。`kind` 一律由
 * `before.hash !== after.hash` 判定；mtime 只用于日志与镜像。
 *
 * ── 本模块刻意不做的事 ──────────────────────────────────────────────────────
 *   - 不构造 `Store` / `Workspace`（由调用方注入）：离线自测因此不需要 DSH 核心包；
 *   - 不 import 任何 DSH 包（只依赖 `node:*` 与 `src/store.mjs`）；
 *   - 不动 `manifest.json` 之外的任何状态机文件，不写 `review.json`（发布快照是
 *     `ReviewService.publish()` 的职责）。
 */

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'
import { canonical } from '../src/paths.mjs'
import { STATE, hashAbsent, isExternalKey, writeFileAtomic } from '../src/store.mjs'

/** 镜像索引的文件名（与 Store 的三份状态机文件并列，但**属于本模块**） */
export const MIRROR_BASENAME = 'capture-mirror.json'

/** 镜像格式版本：形状变了就必须能被读出来识别，解析失败的镜像一律当"无镜像" */
export const MIRROR_VERSION = 1

/** 默认监视集：工作区根 */
const DEFAULT_ROOTS = (workspaceRoot) => [workspaceRoot]

/**
 * 默认排除集。刻意**不引第三方 glob 库**（本仓库零依赖的自测要能直接跑），
 * 用下面 `globToRegExp()` 这一小段自己实现，能力边界如实声明在它的注释里。
 * `.dshstage` 必须排除：镜像与状态机文件就在里面，不排除会立刻自指。
 */
const DEFAULT_EXCLUDE = ['**/.dshstage/**', '**/.git/**', '**/node_modules/**']

/** 默认单文件上限（与 `ReviewService` 的渲染上限无关：这里卡的是"要不要进捕获面"） */
const DEFAULT_MAX_FILE_BYTES = 5_000_000

/** 默认单次捕获的文件数上限：防止遍历一个巨大工作区把面板拖死 */
const DEFAULT_MAX_FILES = 5000

/** 每个监视文件最多记多少条 skip 记录（不设上限会让 `skipped` 在巨大仓库里爆掉） */
const MAX_SKIP_RECORDS = 200

function isReparse(info) {
  if (!info) return false
  if (typeof info.isSymbolicLink === 'function' && info.isSymbolicLink()) return true
  // ⚠ 实测纠正（证据 `.t/reparse-probe.txt`，`mklink /J` 建的真 junction）：
  //     lstatSync(junction).isSymbolicLink() → **false**
  //     lstatSync(junction).mode = 0o40666 ⇒ (mode & 0x400) → **false**
  //     readdirSync(…, { withFileTypes: true }).isSymbolicLink() → **true**
  //   也就是说这一位**认不出 junction**。唯一可靠的判据是 **Dirent**
  //   （见 `walkMonitored()` 里那个必须带 `withFileTypes` 的 `readdirSync`）。
  //   留它只作双保险；把"mode 位能认 junction"当真，正是仓库既有
  //   `workspace-regressions`（D8）用例红掉的原因：递归进自指 junction ⇒ ELOOP。
  return (Number(info.mode ?? 0) & 0x400) !== 0
}

/**
 * 该路径是否命中一条排除模式。
 *
 * ⚠ 与 `staging-fs.mjs` 的"边界映射必须先 canonical"是**两件事**：
 * 排除判定是**词法**的（"要不要看这个路径"），不是边界判定（"这个键在工作区内还是外"）。
 * 因此这里只做分隔符归一 + 大小写归一，**不** `canonical()` —— 对整棵树逐项 realpath
 * 既慢又会在悬空链接上得到反直觉结果。
 */
function matchesAny(patterns, rel, abs) {
  const relSlash = rel.split(sep).join('/')
  const absSlash = abs.split(sep).join('/')
  for (const pattern of patterns) {
    if (pattern.test(relSlash)) return true
    if (pattern.test(absSlash)) return true
  }
  return false
}

/** 该目录名是否被排除（被排除的目录整体不下降，因此排除目录里的文件不会进 skipped 逐条记录） */
function excludedDir(patterns, rel, abs) {
  if (matchesAny(patterns, rel, abs)) return true
  const relSlash = rel.split(sep).join('/')
  const absSlash = abs.split(sep).join('/')
  return patterns.some((pattern) => pattern.test(`${relSlash}/`) || pattern.test(`${absSlash}/`))
}

/**
 * 极简 glob → RegExp。**只实现本模块用得到的那一档**（如实声明，不做假承诺）：
 *   `*`   匹配段内任意字符（不跨 `/`）
 *   `?`   匹配段内单个字符
 *   `**`  跨段匹配（`**\/x` 也匹配段首的 `x`）
 * 不支持 `{a,b}`、`[abc]`、`!`。它只服务于 `exclude` 的默认三条与用户自写的同形模式。
 */
function globToRegExp(glob) {
  const text = String(glob).split('\\').join('/')
  let out = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '*') {
      if (next === '*') {
        i += 1
        if (text[i + 1] === '/') {
          i += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      continue
    }
    out += /[a-zA-Z0-9_/-]/.test(ch) ? ch : `\\${ch}`
  }
  return new RegExp(`^${out}$`, 'i')
}

/**
 * 一次监视集遍历。
 *
 * 返回 `{ files: Map<abs, {size, mtimeMs}>, skipped: Array<{path, reason}> }`。
 *
 * 三条硬约束都在这里落地（与 `walkStagedForHashes()` 同风格）：
 *   - 目录**不下降进**重解析点（`lstatSync().isDirectory()` 对 junction 返回 true）；
 *   - 重解析点、超限文件、非普通文件都**不纳入**，并各记一条 skip；
 *   - `maxFiles` 一旦触顶就**停止收集**（已收的仍然有效），并记一条 skip —— 静默截断
 *     会让"捕获面比用户以为的小"这件事不可见。
 */
function walkMonitored(roots, patterns, maxFileBytes, maxFiles) {
  const files = new Map()
  const skipped = []
  const note = (path, reason) => {
    if (skipped.length < MAX_SKIP_RECORDS) skipped.push({ path, reason })
  }
  let truncated = 0

  const walk = (dir) => {
    let entries
    try {
      // ★ 必须带 `withFileTypes`：junction 的**唯一可靠判据**就在这里。
      //   实测（`.t/reparse-probe.txt`）：`mklink /J` 建的 junction 上
      //   `lstatSync().isSymbolicLink()` 与 `mode & 0x400` **都是 false**，
      //   只有 Dirent.isSymbolicLink() 为 true。
      //   少了这个参数，目录会被当真目录下降进去 ⇒ 自指 junction 无限递归
      //   （仓库既有 `workspace-regressions` D8 用例就是这么 ELOOP 的）。
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      note(dir, `readdir-failed: ${error.message}`)
      return
    }
    for (const entry of entries) {
      const name = entry.name
      const abs = join(dir, name)
      const rel = relative(dir, abs)
      // 重解析点一律不下降、不纳入 —— 这一层是**主判据**
      if (entry.isSymbolicLink()) {
        note(abs, 'reparse-point')
        continue
      }
      let info
      try {
        info = lstatSync(abs)
      } catch (error) {
        note(abs, `lstat-failed: ${error.message}`)
        continue
      }
      if (info.isDirectory()) {
        if (excludedDir(patterns, rel, abs)) continue
        if (isReparse(info)) {
          note(abs, 'reparse-point(directory)')
          continue
        }
        walk(abs)
        continue
      }
      if (isReparse(info)) {
        note(abs, 'reparse-point')
        continue
      }
      if (!info.isFile()) {
        note(abs, 'not-a-regular-file')
        continue
      }
      if (matchesAny(patterns, rel, abs)) continue
      if (info.size > maxFileBytes) {
        note(abs, `too-large(${info.size}>${maxFileBytes})`)
        continue
      }
      if (files.size >= maxFiles) {
        truncated += 1
        continue
      }
      files.set(abs, { size: info.size, mtimeMs: info.mtimeMs })
    }
  }

  for (const root of roots) {
    const absRoot = normalize(root)
    let info
    try {
      info = lstatSync(absRoot)
    } catch (error) {
      note(absRoot, `root-missing: ${error.message}`)
      continue
    }
    // 允许把单个文件当 root 传（外部条目的常见用法），也允许传目录
    if (info.isDirectory()) {
      if (isReparse(info)) {
        note(absRoot, 'reparse-point(directory)')
        continue
      }
      walk(absRoot)
      continue
    }
    if (isReparse(info) || !info.isFile()) {
      note(absRoot, isReparse(info) ? 'reparse-point' : 'not-a-regular-file')
      continue
    }
    if (info.size > maxFileBytes) {
      note(absRoot, `too-large(${info.size}>${maxFileBytes})`)
      continue
    }
    if (files.size < maxFiles) files.set(absRoot, { size: info.size, mtimeMs: info.mtimeMs })
    else truncated += 1
  }

  if (truncated > 0) {
    // 触顶必须响：否则"命令产出了 8000 个文件、只捕获了 5000 个"是静默丢失
    note(`<maxFiles>`, `truncated: ${truncated} more file(s) were NOT collected (maxFiles=${maxFiles})`)
  }
  return { files, skipped }
}

/** `Map<abs, ...>` 或镜像对象都能作为"执行前状态"被接受（后者只取 `before` / `files`） */
function asMap(before) {
  if (before instanceof Map) return before
  if (before && typeof before === 'object') {
    if (before.before instanceof Map) return before.before
    if (before.files && typeof before.files === 'object') return new Map(Object.entries(before.files))
  }
  return new Map()
}

/**
 * 镜像键（= 清单键）→ **绝对路径**。镜像照规格按键写（工作区内 = 相对路径、
 * 工作区外 = 规范化绝对路径），但捕获面遍历出来的是绝对路径，因此两边必须有**唯一一处**
 * 换算。换算失败就返回 `undefined` ⇒ 调用方按"镜像里没有该路径"处理（fail-closed，
 * 绝不猜一个路径去 materialize）。
 */
function mirrorAbsOf(key) {
  try {
    return canonical(key)
  } catch {
    return undefined
  }
}

/**
 * 绝对路径的**比较键**：`canonical()` 之后原样保留大小写。
 *
 * ⚠ 内部所有 `Map` 一律用它当键，**不要**直接拿 `join()` 的产物当键：
 * `canonical(join(workspaceRoot, 'a.txt'))` 在 Windows 上会把盘符/用户名还原成
 * `realpath` 的真实大小写（`C:\Users\Administrator\…`），而 `readdirSync` 走出来的
 * 绝对路径可能是另一种拼写（`C:\Users\ADMINI~1\…` 或不同大小写）。两者**字面不相等**
 * 但指向同一个文件 —— 拿它们互相 `has()`/`get()` 就是本模块第一版当场踩到的坑：
 * 已经 prime 过的路径被判成"从未 prime"（凭空多出 create 变化 + 一条 restore 失败），
 * 而被还原掉的 `created` 又被当成"仍在磁盘上"写回镜像，导致候选无限累积。
 */
function pathKey(abs) {
  try {
    return canonical(abs)
  } catch {
    return String(abs)
  }
}

/**
 * 构造一个执行后捕获器。
 *
 * `store` / `workspace` **由调用方注入**（通常是同一个 `ReviewService.workspace` 与其
 * `store`），本模块自己绝不构造它们 —— 这样离线自测可以用真实的 `Store` / `Workspace`
 * 在临时目录里跑，而生产装配也不必在插件里再造一份。
 *
 * @param {{
 *   workspaceRoot: string,
 *   store: object,
 *   workspace: object,
 *   log?: (message: string, level?: string) => void,
 *   roots?: string[],
 *   exclude?: string[],
 *   maxFileBytes?: number,
 *   maxFiles?: number,
 * }} options
 */
export function createRunCapture(options = {}) {
  if (!options || typeof options !== 'object') throw new TypeError('createRunCapture: options must be an object')
  const workspaceRoot = options.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    throw new TypeError('createRunCapture: options.workspaceRoot is required')
  }
  const store = options.store
  if (!store || typeof store.putBlob !== 'function' || typeof store.materializeBlob !== 'function') {
    throw new TypeError('createRunCapture: options.store must be a Store instance (putBlob/materializeBlob)')
  }
  const workspace = options.workspace
  if (!workspace || typeof workspace.writeFile !== 'function' || typeof workspace.diffEntries !== 'function') {
    throw new TypeError('createRunCapture: options.workspace must be a Workspace instance (writeFile/diffEntries)')
  }

  const log = typeof options.log === 'function' ? options.log : () => {}
  const roots = (Array.isArray(options.roots) && options.roots.length > 0 ? options.roots : DEFAULT_ROOTS(workspaceRoot))
    .map((root) => canonical(root))
  const exclude = (Array.isArray(options.exclude) ? options.exclude : DEFAULT_EXCLUDE).map(globToRegExp)
  const maxFileBytes = Number.isFinite(options.maxFileBytes) ? options.maxFileBytes : DEFAULT_MAX_FILE_BYTES
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : DEFAULT_MAX_FILES

  /** 镜像索引绝对路径（**自己的文件**；绝不触碰 manifest.json / review.json / queue.json） */
  const mirrorPath = join(String(store.dir), MIRROR_BASENAME)

  /** 本进程内最近一次 `prime()` 的 before 镜像；`capture()` 在镜像文件被删掉时用它兜底 */
  let lastPrimed = new Map()

  /** 当前监视集（仅元数据，不读内容） */
  function walk() {
    return walkMonitored(roots, exclude, maxFileBytes, maxFiles)
  }

  /** 清单键：工作区内 = 相对路径，工作区外 = 规范化绝对路径（与 `Workspace.keyOf()` / `store.mjs` 的键模型同一套） */
  function keyOf(abs) {
    const place = workspace.keyOf ? workspace.keyOf(abs) : undefined
    if (place && typeof place.key === 'string' && place.key.length > 0) return place.key
    return canonical(abs)
  }

  /** 读镜像；**任何**解析失败都当"无镜像"（宁可多记一次 failures，也不要拿半个索引当真） */
  function readMirror() {
    try {
      if (!existsSync(mirrorPath)) return { files: {}, error: undefined }
      const raw = JSON.parse(readFileSync(mirrorPath, 'utf8'))
      if (!raw || raw.version !== MIRROR_VERSION || typeof raw.files !== 'object' || raw.files === null) {
        return { files: {}, error: `镜像版本或形状不受支持（version=${raw && raw.version}）` }
      }
      return { files: raw.files, error: undefined }
    } catch (error) {
      return { files: {}, error: error.message }
    }
  }

  function writeMirror(files) {
    const mirror = { version: MIRROR_VERSION, updatedAt: new Date().toISOString(), files }
    writeFileAtomic(mirrorPath, JSON.stringify(mirror, null, 2))
    return mirror
  }

  /** 内容哈希 + 落 blob（after 侧）。读失败由调用方包进 failures */
  function afterHashOf(abs) {
    const buffer = readFileSync(abs)
    return { hash: store.putBlob(buffer), bytes: buffer.length }
  }

  /**
   * 把一条变化落成**暂存条目**，并把 before 基线钉住（见文件头"关键设计决定"）。
   *
   * 键模型照抄 `staging-fs.mjs:477-488` 与 `store.mjs`：
   *   工作区内 → 相对键（`external` 不写，保持既有清单形态逐字不变）；
   *   工作区外 → **规范化绝对键** + `external: true`（物化对象落 `staged-ext/`）。
   * 用 `workspace.writeFile(abs, …)` 而不是直接拼 `stagedPath`：键映射、父目录合成、
   * 清单条目创建全部由既有代码承担，本模块不自建第二条写入路径。
   */
  function stage(change) {
    const abs = change.abs
    const isDelete = change.kind === 'deleted'
    // ⚠ 基线必须在**落暂存之前**抓住：`writeFile` / `remove` 都会经 `ensureEntry()` 顺手把
    //   `baseHash/baseKind` 重述为"真实磁盘此刻的值"，而此刻磁盘上放的正是**执行后**内容。
    const priorBaseHash = workspace.entryOf(keyOf(abs))?.baseHash
    if (isDelete) {
      workspace.remove(abs, { missingOk: true, origin: 'run-capture' })
    } else {
      workspace.writeFile(abs, readFileSync(abs), { origin: 'run-capture' })
    }
    const key = keyOf(abs)
    const entry = workspace.entryOf(key)
    if (entry) {
      // ⚠ 覆写 `ensureEntry()` 刚重述过的基线：那一版基线是**执行后**的真实磁盘（= after），
      //   会让 `diffEntries()` 判成"零净变化" ⇒ 永远不入队（而且还原得越忠实，这个洞越深）。
      //   这里换成本次捕获到的 before：删除类还必须把 `state` 留在 DELETED 上（`remove()` 已设），
      //   否则 `diffEntries()` 会把墓碑当普通文件处理。
      if (isDelete) {
        entry.baseHash = change.beforeHash
        entry.baseKind = 'file'
      } else if (change.kind === 'created') {
        // `created` 的 before 就是哨兵（手册里 created 的 before 侧不存在）
        entry.baseHash = hashAbsent()
        entry.baseKind = 'file'
      } else {
        // 同一路径在本轮之前的暂存条目里可能已经钉着正确的 before；以它优先（多轮捕获不漂移）
        entry.baseHash = priorBaseHash !== undefined ? priorBaseHash : change.beforeHash
        entry.baseKind = 'file'
      }
      entry.changed = entry.state === STATE.DELETED ? true : entry.stagedHash !== entry.baseHash
      entry.updatedAt = new Date().toISOString()
    }
    return { key, entry }
  }

  /**
   * ① 建立"执行前镜像"：遍历监视集，把每个文件的内容落成 blob，写进镜像索引。
   * @returns {Promise<{files: number, bytes: number, skipped: Array<{path: string, reason: string}>, index: object, before: Map}>}
   */
  async function prime() {
    const { files, skipped } = walk()
    const entries = {}
    const before = new Map()
    let bytes = 0
    for (const [abs, info] of files) {
      let hash
      try {
        hash = store.putBlob(readFileSync(abs))
      } catch (error) {
        // 读不了就是"没进镜像"：以后捕获到这个路径时**必须**按"镜像里没有"处理（不假装能还原）
        log(`[run-capture] prime 读取失败，该路径不进执行前镜像：${abs} — ${error.message}`, 'error')
        skipped.push({ path: abs, reason: `read-failed: ${error.message}` })
        continue
      }
      const key = keyOf(abs)
      entries[key] = { hash, size: info.size, mtimeMs: info.mtimeMs }
      before.set(abs, { hash, size: info.size, mtimeMs: info.mtimeMs })
      bytes += info.size
    }
    const index = writeMirror(entries)
    lastPrimed = before
    /**
     * ★ 权威标记：**只有** `prime()` 真的扫完监视集，才敢按"created ⇒ 执行前不存在"去删真实文件。
     *
     * 为什么必须显式标记：`prime()` 返回的 `before` 与 `snapshot()` 的元数据 Map 形状几乎一样
     * （都是 `Map<abs, {...}>`）。而"created ⇒ 删除"这条语义的前提是**执行前状态是权威的** ——
     * 如果拿一个只走元数据、或压根没扫成的 Map 当权威，监视集里每个文件都会被判成 `created`，
     * 还原就会把**整个监视集删光**。反过来，没有这个标记时一律不敢删，就会出现另一个极端：
     * 新建的文件**永远**回滚不掉（`.t/wiring-selftest.mjs` 的 W1 实测就是这个症状）。
     * 两个极端都不行，所以权威性必须是一个**显式的、由 prime() 亲自许下的承诺**。
     */
    before.authoritative = true
    return { files: before.size, bytes, skipped, index, before, authoritative: true }
  }

  /**
   * ② 只走元数据（`path → {size, mtimeMs}`），**不读内容、不落 blob**。
   * 用于"只想看有没有动过"的便宜检查；判变仍以 `diff()` 的内容哈希为准。
   * 键是 `pathKey()` 归一后的绝对路径（与内部所有比较同一套键，见 `pathKey()` 的说明）。
   * @returns {Promise<Map<string, {size: number, mtimeMs: number}>>}
   */
  async function snapshot() {
    const { files } = walk()
    const out = new Map()
    for (const [abs, info] of files) out.set(pathKey(abs), { size: info.size, mtimeMs: info.mtimeMs })
    return out
  }

  /**
   * ③ 重走监视集，与执行前镜像（或显式传入的 `before`）比对。
   *
   * `kind` **只由内容哈希判定**：`created` = 镜像里没有该路径；`deleted` = 磁盘上没有了；
   * `modified` = 两边都有但哈希不同。两侧 hash 相同的一律**不进结果**（无净变化不入队）。
   * @returns {Promise<Array<{abs: string, key: string, kind: 'created'|'modified'|'deleted', beforeHash: string, afterHash: string}>>}
   */
  async function diff(before) {
    // ⚠ 必须 await：`diffAgainst()` 是 async，忘了 await 会静默返回 undefined
    //   （自测第一次运行时就当场炸在这里，所以这行别再"顺手简化"掉）
    const { changes } = await diffAgainst(before)
    return changes
  }

  /**
   * `diff()` 的实体内核：除变化清单外还给出**本次用到的执行前查找表**，
   * 好让 `capture()` 的还原/镜像刷新与判变**共用同一份 before**（否则"判变用一套、
   * 还原用另一套"就是两套口径，正是本仓库反复踩过的漂移）。
   */
  async function diffAgainst(before) {
    const base = before === undefined ? lastPrimed : asMap(before)
    const lookup = new Map()
    for (const [path, entry] of base) {
      if (!entry || typeof entry.hash !== 'string') continue
      const key = pathKey(path)
      if (!lookup.has(key)) lookup.set(key, entry)
    }
    const { files } = walk()
    const changes = []
    const seen = new Set()
    for (const [abs, info] of files) {
      const key = pathKey(abs)
      seen.add(key)
      const previous = lookup.get(key)
      const beforeHash = previous ? previous.hash : hashAbsent()
      const { hash: after } = afterHashOf(abs)
      if (beforeHash === hashAbsent()) {
        // 从未 prime 过：可能真是新建，也可能"prime 时读不了"。区分留给 capture()（它会记 failures）
        changes.push({ abs, key: keyOf(abs), kind: 'created', beforeHash, afterHash: after })
        continue
      }
      if (beforeHash !== after) {
        changes.push({ abs, key: keyOf(abs), kind: 'modified', beforeHash, afterHash: after })
      }
    }
    for (const [abs, previous] of base) {
      if (seen.has(pathKey(abs))) continue
      if (existsSync(abs)) continue // 还在磁盘上（只是没进本次监视集，例如被 exclude 或超限）：不是删除
      if (previous.hash === hashAbsent()) continue
      changes.push({ abs, key: keyOf(abs), kind: 'deleted', beforeHash: previous.hash, afterHash: hashAbsent() })
    }
    return { changes, lookup }
  }

  /**
   * ④ 完整一次捕获。
   *
   * 返回 `{ changes, staged, restored, failures }`，`failures[].phase ∈ 'blob'|'stage'|'restore'|'freeze'`。
   * **绝不抛异常**：任何单点失败都进 `failures` 并同时 `log(..., 'error')`。
   *
   * 每条变化按 a) 落 after blob → b) 落暂存条目（工作区内相对键 / 工作区外规范化绝对键 +
   * `external: true`）→ c) 入队待审候选（before / after 两侧都冻结，`created` 的 before 用
   * `hashAbsent()`）→ d) 还原真实主机。**镜像里没有该路径时绝不假装还原成功**：
   * 记一条 `phase:'restore'` 的 failure，且**不调用** `materializeBlob`。
   *
   * 候选的冻结时机刻意放在**全部落暂存之后**：这样一次捕获的 N 条变化冻结在**同一份**候选里
   * （面板上是一条可整批批准的变更），而不是 N 条互相取代的候选。还原只改真实主机、
   * 不改清单条目，因此放在冻结之后是安全的。
   *
   * @param {Map|object|undefined} before `prime()` 的返回值（**带权威标记**）或任意 before 表；不传则用镜像文件
   * @param {{restore?: boolean, unknownPaths?: string[]}} [opts]
   *   `restore:false` ⇒ 主机保留改动、候选照样建立；
   *   `unknownPaths` ⇒ prime 阶段读失败、因而"执行前是什么"未知的路径（`prime().skipped`）
   */
  async function capture(before, opts = {}) {
    const restore = opts.restore !== false
    const failures = []
    const noteFailure = (path, phase, message) => {
      failures.push({ path, phase, message })
      log(`[run-capture] ${phase} 失败：${path} — ${message}`, 'error')
    }

    const { files: mirrorFiles, error } = readMirror()
    if (error) {
      // 镜像坏了不能当"没有变化"处理：那会让"能还原的路径"被误判成"从未 prime"
      log(`[run-capture] 执行前镜像不可用（${mirrorPath}）：${error}`, 'error')
    }
    const base = before === undefined
      ? new Map(Object.entries(mirrorFiles))
      : asMap(before)

    /**
     * 执行前状态是否**权威**（`prime()` 亲自许下的承诺，见那里的长注释）。
     *
     * `false` ⇒ **绝不做删除式还原**：宁可记一条 failure 让"主机上这处改动还在"可见，
     * 也不拿一个没扫成的状态当"执行前不存在"的证据去删真实文件。
     * 不传 `before` 时退回磁盘上的镜像：文件**存在且解析成功**才算权威 ——
     * `readMirror()` 对"文件不存在"和"解析失败"都返回空表，所以这里必须另外查一次存在性。
     */
    const authoritative =
      before !== undefined ? before.authoritative === true : error === undefined && existsSync(mirrorPath)
    /** prime 读失败、执行前内容未知的路径：同样**不参与**删除式还原 */
    const unknownPaths = new Set(
      (Array.isArray(opts.unknownPaths) ? opts.unknownPaths : []).map((p) => pathKey(canonical(String(p)))),
    )

    if (workspace.init) {
      // 重读持久状态：别的进程/会话可能刚改过暂存树（与 ReviewService.reload() 同口径）
      try {
        workspace.init()
      } catch (initError) {
        log(`[run-capture] workspace.init() 失败，继续用内存中的清单：${initError.message}`, 'error')
      }
    }

    // 判变与还原共用同一份 before 查找表（见 diffAgainst 的注释）
    const { changes: changeRecords, lookup } = await diffAgainst(base)
    /** 本次真正落成暂存条目（并已钉住 before 基线）的变化 */
    const stagedChanges = []

    for (const change of changeRecords) {
      // (a) after 内容落 blob
      if (change.kind !== 'deleted') {
        try {
          afterHashOf(change.abs)
        } catch (blobError) {
          noteFailure(change.abs, 'blob', `落 after blob 失败：${blobError.message}`)
          continue
        }
      }
      // (b) 落暂存条目
      try {
        stage(change)
      } catch (stageError) {
        noteFailure(change.abs, 'stage', `落暂存条目失败：${stageError.message}`)
        continue
      }
      stagedChanges.push(change)
    }

    // (c) 入队待审候选：before / after 两侧都在候选里冻结（手册 #12.6）。
    //     幂等由 freezeIfNeeded() 的既有判据承担（同一内容重复捕获 → already-represented）。
    if (stagedChanges.length > 0) {
      try {
        const frozen = workspace.freezeIfNeeded({ source: 'run-capture' })
        if (frozen && frozen.frozen === false && frozen.reason !== 'already-represented') {
          // "no-net-change" 在这里只能是"暂存被别的进程改掉了"：必须响，不许静默
          log(`[run-capture] 未产生新候选：${frozen.reason}（净变化 ${frozen.changes ?? 0} 条）`, 'error')
        }
      } catch (freezeError) {
        // 注意：某条变化没进候选时**不能**把它算成已完成，所以 freeze 失败时逐条记账
        for (const change of stagedChanges) {
          noteFailure(change.abs, 'freeze', `冻结候选失败（暂存内容仍在）：${freezeError.message}`)
        }
      }
    }

    // (d) 还原真实主机
    //
    // `restoredChanges` 是"**真的**按 before 还原过"的那些变化。刷新镜像只能认这一份名单：
    // 没被还原的路径（镜像里没有 before、或还原本身失败）在磁盘上仍是执行后内容，
    // 把那个内容写进"执行前镜像"就是**抹掉 before 基线**（下一轮捕获会判成"无变化"，
    // 而候选里承诺的 before 还在）—— 那是静默说谎。
    let restored = 0
    const restoredChanges = []
    if (restore) {
      for (const change of stagedChanges) {
        const recorded = lookup.get(pathKey(change.abs))
        if (change.kind === 'created') {
          // ── `created` 的判据是"执行前不存在"，**不是**"镜像里没这条记录"──────────
          // 这两件事看起来一样，但 `created` 的定义本来就是"镜像里没有该路径"
          // （见 `diffAgainst`）。拿 `recorded === undefined` 当"无法还原"的判据，
          // 等于对**每一个**新建文件都不还原 —— 而新建恰恰是最常见的改动形态。
          // `.t/wiring-selftest.mjs` 的 W1 实测就是这个症状（命令建的文件留在主机上）。
          //
          // 真正的判据是**执行前状态是否权威**：
          //   · 权威（prime 真的扫完监视集）⇒ 没记录 ⇒ 执行前确实不存在 ⇒ 删除；
          //   · 不权威（未 prime / prime 读失败）⇒ 不敢删，如实记为失败。
          // 反向的安全断言见同一个测试的 W10：不权威时真实文件必须**原样保留**。
          if (!authoritative || unknownPaths.has(pathKey(change.abs))) {
            noteFailure(
              change.abs,
              'restore',
              '执行前状态不权威（未 prime，或该路径在 prime 阶段读失败）：不敢按"执行前不存在"删除，未调用 materializeBlob',
            )
            continue
          }
          try {
            store.materializeBlob(hashAbsent(), change.abs)
            restored += 1
            restoredChanges.push(change)
          } catch (restoreError) {
            noteFailure(change.abs, 'restore', `还原真实主机失败：${restoreError.message}`)
          }
          continue
        }
        const target = recorded?.hash ?? change.beforeHash
        try {
          store.materializeBlob(target, change.abs)
          restored += 1
          restoredChanges.push(change)
        } catch (restoreError) {
          noteFailure(change.abs, 'restore', `还原真实主机失败：${restoreError.message}`)
        }
      }
    }

    // 刷新镜像：把仍存在于磁盘上的路径更新为当前值；已消失的（例如 created 又被还原掉）剔除。
    // 剔除的取舍：`created` 还原后磁盘上没有这个文件，把它留在索引里也没有 mtime 可更新；
    // 候选早已冻结对应 blob，因此这里丢的只是一条诊断字段，不影响"两侧可验证"。
    //
    // ⚠ `restore === false` 时**只做剔除、绝不改写哈希**（见 `restoredChanges` 的说明）。
    try {
      const diskNow = await snapshot()
      const updated = {}
      for (const [key, value] of Object.entries(mirrorFiles)) {
        const abs = mirrorAbsOf(isExternalKey(key) ? key : join(workspaceRoot, key))
        if (!abs || !diskNow.has(pathKey(abs))) continue
        updated[key] = value
      }
      // 只有"**真的**按 before 还原过"的 created 才允许把 after 写成新的执行前状态；
      // 被拒绝删除的（未 prime / 不权威）留在主机上的是 after 内容，绝不写进镜像。
      const restoredCreates = new Set(
        restoredChanges.filter((change) => change.kind === 'created').map((change) => change.key),
      )
      for (const change of stagedChanges) {
        if (change.kind === 'deleted') continue
        if (change.kind === 'created' && !restoredCreates.has(change.key)) continue
        const meta = diskNow.get(pathKey(change.abs))
        // ⚠ 必须**以还原之后的磁盘真值**为准：`created` 还原后磁盘上已经没有这个文件，
        //   若还按"本次落过暂存"写进镜像，镜像里就会留下一条**磁盘上并不存在**的 before，
        //   下一次捕获会把同一路径判成 modified ⇒ 候选无限累积（自测 A1→A7 连锁红的根因之一）。
        if (!meta) continue
        updated[change.key] = { hash: change.afterHash, size: meta.size, mtimeMs: meta.mtimeMs }
      }
      if (!restore && stagedChanges.length > 0) {
        log(
          '[run-capture] restore=false：执行前镜像保持不变（绝不用执行后的磁盘内容覆盖 before 基线）',
          'info',
        )
      }
      writeMirror(updated)
    } catch (mirrorError) {
      log(`[run-capture] 刷新执行前镜像失败（下次捕获会退回内存镜像）：${mirrorError.message}`, 'error')
    }

    if (changeRecords.length > 0) {
      log(
        `[run-capture] 捕获完成：变化 ${changeRecords.length} 条（入暂存 ${stagedChanges.length} 条，` +
          `还原 ${restored} 条，失败 ${failures.length} 条）`,
        failures.length > 0 ? 'error' : 'info',
      )
    }
    return { changes: changeRecords, staged: stagedChanges.length, restored, failures }
  }

  return { prime, snapshot, diff, capture, mirrorPath, roots: [...roots], exclude: [...exclude] }
}
