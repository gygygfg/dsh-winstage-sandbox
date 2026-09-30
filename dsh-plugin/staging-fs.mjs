/**
 * WinStage 暂存文件系统 —— `ctx.fs` 的一个**替代**提供方。
 *
 * ── 它做什么 ────────────────────────────────────────────────────────────────
 * 继承 `LocalFileSystem`（DSH 自带的本地后端），只改两件事：
 *   1. **变更面**（`writeText` / `editText`）：写进暂存树，**绝不写真实工作区**；
 *   2. **读取面**：命中暂存条目的路径读**投影**，其余一律 `super` 走真实磁盘。
 * 于是 DSH 的 `write` / `edit` / `read` 工具在**不改工具代码**的前提下获得
 * "暂存—候选—选择性提交"语义 —— 这正是 `@deepseek-ai/dsh-fs-sandbox` 的对接方式
 * （它替换 `fs-local` 的方式与本文件完全相同）。
 *
 * ── 三条必须遵守的契约（读源码 + 实测得到，违反会静默劣化）────────────────────
 *   1. `writeText` 返回的 `version` **不是装饰**：`dsh-tool-fs` 会把它作为
 *      `fs/observed` 的版本记进观测策略，并在**下一次**编辑时作为 `expected.version`
 *      传回。因此 `stat()` 必须对同一内容返回**同一个** version，且必须真的校验
 *      `expected`（不匹配 → `FS_STALE_VERSION`；`createIfAbsent` 撞上已存在 →
 *      `FS_NOT_OBSERVED`）。返回常量会使陈旧检测**静默失效**。
 *   2. 抛出的错误必须是**同一个模块实例**的 `FsError`：`dsh-tool-fs` 用
 *      `error instanceof FsError` 判别，第二份 dsh-fs 副本会让判别失败。
 *      所以这里用 `resolveDshModuleRoot()` 定位**运行时那一份**并按其绝对路径 import。
 *   3. 边界映射必须先 `canonical()`：`Workspace.relative()` 用**词法**判定，
 *      而 8.3 短名（`ADMINI~1`）与长名是同一对象的两种拼写；不归一就会被判成
 *      "在工作区外"（实测踩到过）。
 *
 * ── 它刻意不做的事（残余边界，见 README 的对应小节）──────────────────────────
 *   - 工作区**之外**的写入同样进暂存（S3a：**硬拒已取消**，不再有 `FS_SANDBOX_DENIED`）；
 *     外部条目的键 = 规范化绝对路径，物化对象在 `.dshstage/staged-ext/`，
 *     **真实磁盘在批准之前一位不改**；只有 `stageOutside:'direct'` 这个显式逃生口
 *     才会直通真实磁盘（默认关闭，供宿主自身流程排障用）；
 *   - `bash` / `pwsh` 的写入不经过 `ctx.fs`，因此仍然落在真实工作区；
 *   - `watch` 已覆写：超类（真实磁盘）观察者照旧，**另把暂存变更转成失效通知**；
 *     **跨进程**改动（CLI / 另一个 DSH 实例写同一份暂存树）仍然不会通知。
 */

import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { canonical } from '../src/paths.mjs'
import { STATE, hashAbsent, isExternalKey } from '../src/store.mjs'
import { resolveDshModuleRoot } from '../src/executor.mjs'
import { getReviewService } from './review-service.mjs'

/** 在候选 node_modules 根中定位**真实文件**（包的 exports 映射不作用于绝对 file: URL） */
function locatePackageFile(relativePath) {
  let roots = []
  try {
    roots = resolveDshModuleRoot() || []
  } catch {
    roots = []
  }
  for (const root of roots) {
    if (!root) continue
    const candidate = join(root, relativePath)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const FS_MODULE = locatePackageFile(join('@deepseek-ai', 'dsh-fs', 'lib', 'index.js'))
const FS_LOCAL_MODULE = locatePackageFile(join('@deepseek-ai', 'dsh-fs-local', 'lib', 'index.js'))
const FS_SANDBOX_MODULE = locatePackageFile(join('@deepseek-ai', 'dsh-fs-sandbox', 'lib', 'index.js'))

if (!FS_MODULE || !FS_LOCAL_MODULE) {
  // fail-closed：拿不到契约就不注册任何 fs 提供方（宁可文件工具不激活，也不静默放行）
  throw new Error(
    'WinStage 暂存文件系统：无法定位 @deepseek-ai/dsh-fs 或 @deepseek-ai/dsh-fs-local。' +
      '请设置 DSH_SANDBOX_NODE_ROOT 指向含 @deepseek-ai/* 的 node_modules。',
  )
}

const { FsError, FsVersion, FsTargetKey } = await import(pathToFileURL(FS_MODULE).href)
const { LocalFileSystem } = await import(pathToFileURL(FS_LOCAL_MODULE).href)

/**
 * 平台自带的**沙箱** fs 后端（`ctx.fs` 的正常提供方）。
 *
 * 关闭开关时本提供方整体按它的面工作 ⇒「关掉暂存」==「退回平台原来的沙箱/审批模式」
 * （围栏、`FS_SANDBOX_DENIED`、同回合升权提示、`sandboxMode` 广告全部一致），而**不需要
 * 在运行中把 `fs` 这个服务名从一行搬到另一行**。
 *
 * 为什么不做行级热切换（关掉开关就 enable `fs-sandbox` 行、disable `winstage-fs` 行）：
 * `EntryGroup.update()` 对同一层的 id **并发** `create()`；被关掉那行的
 * `fiber.dispose()`（内部异步）不 await，而新打开那行的 `provide('fs')` 可能先执行 ⇒
 * cordis 对重复 provide 硬失败（`service "fs" has been registered at <...>`）。
 * 本 profile 在线切换 bundle 时**实测崩过宿主进程**（docs/DSH集成.md §4）。
 * 一个提供方、两种面，就没有这个事务。
 *
 * 找不到该包时这里是 `undefined` —— 装配方（fs-entry.mjs）会 fail-closed，
 * 绝不静默退化成"没有围栏的本地写"。
 */
const SandboxedFileSystem = FS_SANDBOX_MODULE
  ? (await import(pathToFileURL(FS_SANDBOX_MODULE).href)).SandboxedFileSystem
  : undefined

export { SandboxedFileSystem }

/** LF 归一（与 fs-local 的 diff basis 一致） */
function normalizeLineEndings(text) {
  return String(text).replace(/\r\n?/g, '\n')
}

/** 记录原始换行风格，写入时还原（避免一次编辑把整个 CRLF 文件变成 LF） */
function lineEndingOf(text) {
  return String(text).includes('\r\n') ? '\r\n' : '\n'
}

function restoreLineEndings(text, eol) {
  return eol === '\r\n' ? String(text).replace(/\n/g, '\r\n') : String(text)
}

/**
 * 两个"暂存根"是否指向同一目录（C-8 fail-closed 用）。
 * 走 `canonical()` 归一（长路径前缀 / 分隔符 / 8.3 短名 / 链接），再按 Windows
 * 大小写不敏感比较；任一步抛错就退回字面比较，绝不因为比较本身让插件起不来。
 */
function sameRoot(a, b) {
  try {
    return canonical(String(a)).toLowerCase() === canonical(String(b)).toLowerCase()
  } catch {
    return String(a).toLowerCase() === String(b).toLowerCase()
  }
}

/**
 * WinStage 自身存储的**状态机路径**（P0-8）。
 *
 * `.dshstage/**` 既是插件元数据（manifest/review/queue）又是暂存对象树（blobs/staged/
 * staged-ext/candidates/sessions）。**写侧此前零判据**（读/批准侧只有 `src/paths.mjs:199`
 * 的 `stage-store`（hard:true）遮蔽）⇒ agent 可以经 `ctx.fs` 把 `review.json` /
 * `manifest.json` / `staged/**` 改写进暂存并生成**自指条目**：出生即 stale ⇒ 批准必然
 * `STALE_BASELINE`、`pending` 永久（"条目怎么点都不消失"）。
 *
 * 这里拒绝的是**状态机本身**：三个元数据文件 + 存储目录树。`.dshstage` 根下的**其它**
 * 普通文件（例如敏感路径测试用的 `confirm-probe.txt`）不在其列，保持既有行为。
 *
 * ⚠ 边界（必须如实声明）：本守卫**只在经 `ctx.fs`** 的路径上生效。
 *   `bash`/`pwsh` 等 shell 写入完全绕过 `ctx.fs`（见本文件头部第 30 行），插件自己的
 *   `src/store.mjs` 也走 `node:fs` 直写 —— 那些**不受本守卫约束**。
 *   因此这**不等于**解决 R8。
 */
const STORE_SEGMENT_TAIL = '\\.dshstage\\'
const STORE_METADATA_FILES = new Set(['manifest.json', 'review.json', 'queue.json'])
const STORE_STATE_DIRS = new Set(['blobs', 'staged', 'staged-ext', 'candidates', 'sessions', 'real', 'private', 'cache'])

/** 该绝对路径是否命中 WinStage 存储的**状态机**（元数据文件或存储目录树） */
function isStoreStatePath(abs) {
  if (typeof abs !== 'string' || abs.length === 0) return false
  const normalized = abs.replace(/\//g, '\\')
  const at = normalized.toLowerCase().lastIndexOf(STORE_SEGMENT_TAIL)
  if (at < 0) return false
  const rest = normalized.slice(at + STORE_SEGMENT_TAIL.length)
  if (rest.length === 0) return false
  const slash = rest.indexOf('\\')
  if (slash < 0) return STORE_METADATA_FILES.has(rest.toLowerCase())
  return STORE_STATE_DIRS.has(rest.slice(0, slash).toLowerCase())
}

/** 字面替换，错误码与 fs-local 对齐 */
function applyLiteralEdit(text, edit, displayPath) {
  if (!edit || typeof edit.oldString !== 'string' || edit.oldString.length === 0) {
    throw new FsError(`cannot edit "${displayPath}": oldString must be a non-empty string`, 'FS_EDIT_NOT_FOUND')
  }
  const occurrences = text.split(edit.oldString).length - 1
  if (occurrences === 0) {
    throw new FsError(`cannot edit "${displayPath}": the text to replace was not found`, 'FS_EDIT_NOT_FOUND')
  }
  if (occurrences > 1 && edit.replaceAll !== true) {
    throw new FsError(`cannot edit "${displayPath}": the text to replace is ambiguous (${occurrences} matches)`, 'FS_AMBIGUOUS_EDIT')
  }
  const next = edit.replaceAll === true
    ? text.split(edit.oldString).join(edit.newString ?? '')
    : text.replace(edit.oldString, edit.newString ?? '')
  return next
}

/**
 * 构造暂存文件系统类。
 *
 * 返回的类就是 loader 行的插件本身（与 `SandboxedFileSystem` 同构）：
 * 它 `extends LocalFileSystem`，`Config` 由基类继承（`cwd` / `diffBasisMaxBytes`），
 * 服务名 `fs` 由 `FileSystem` 基类在构造时 `provide` 出来。
 *
 * @param {{log?: (msg: string, level?: string) => void, onMutation?: () => void, stageOutside?: 'stage'|'direct', base?: object}} options
 *   `base` 仅供**自测**替换基类（默认就是 DSH 的 `LocalFileSystem`）；生产装配不要传。
 *   `stageOutside` **默认 `'stage'`**：工作区外的写入进暂存、等批准。只有显式传
 *   `'direct'` 才直通真实磁盘（旧值 `'deny'` 已随硬拒一起取消，任何非 `'direct'`
 *   的值都归一为 `'stage'`；旧的 `deny` 配置**不会**复活拒绝行为）。
 */
export function createStagingFileSystem(options = {}) {
  const stageOutside = options.stageOutside === 'direct' ? 'direct' : 'stage'
  // 生产默认基类 = 平台的 `SandboxedFileSystem`：关掉开关时**原样**退回它。
  // 离线自测显式传 `base`（替身基类），因此两种面都能被断言。
  const Base = options.base || SandboxedFileSystem || LocalFileSystem
  /** 自测/装配方可注入"是否接管"的判定；生产默认读 loader 树（见 stagingEnabled()） */
  const enabledOverride = typeof options.enabled === 'function' ? options.enabled : undefined

  return class StagingFileSystem extends Base {
    /**
     * `cwd` / `diffBasisMaxBytes` 的 schema 来自基类，这里显式声明为**自有**静态属性：
     * 静态属性虽然可继承，但把配置契约摆在自己身上更稳（装配器读的是 `plugin.Config`）。
     */
    static Config = Base.Config

    constructor(ctx, config) {
      super(ctx, config)
      /**
       * **本插件自己的** loader entry —— 必须在构造时抓住。
       *
       * 不能改成"调用时读 `this.ctx.fiber.entry`"：`ctx.<service>` 拿到的是 cordis 的
       * traceable 代理（cordis/lib/index.js:123-129 `createTraceable`），它会把
       * `service.ctx` 改写成**调用方**的 ctx。于是 `dsh-tool-fs` 调
       * `ctx.fs.writeText(...)` 时，方法里的 `this.ctx` 是**工具的** ctx，那里的
       * `fiber.entry.parent.data` 根本不是 loader 根 include 的条目表 —— 开关会永远
       * 读成"没找到该行 ⇒ 接管"。真实 loader 实测抓到这个
       * （`.t/loader-toggle-harness.mjs`）。
       * `fiber.entry` 在插件**构造之前**就由 loader 的 `internal/plugin` 处理器设好
       * （cordis/lib/index.js:129-135），所以这里能直接拿到，且 entry 对象在
       * 后续 `EntryGroup.update()` 里是复用的（`group.create()` 先查 `store[id]`）。
       */
      this.rootEntry = ctx?.fiber?.entry
      const logger = ctx?.logger
      this.log =
        options.log ||
        ((message) => {
          if (logger && typeof logger.info === 'function') logger.info(message)
          else console.log(`[winstage-fs] ${message}`)
        })
      /** 存下来给 ReviewService 用（"失败必须响"要走 error/warn 级日志） */
      this.logger = logger
      /**
       * **error 级**日志：守卫/拒绝路径必须响。优先 `logger.warn` / `logger.error`
       * （DSH 实例日志可见），没有 logger 时退到 `console.error`（进程 stderr）。
       */
      this.logError = (message) => {
        const line = `[winstage-fs] ${message}`
        try {
          if (logger && typeof logger.warn === 'function') return logger.warn(line)
          if (logger && typeof logger.error === 'function') return logger.error(line)
        } catch {
          /* best effort */
        }
        try {
          console.error(line)
        } catch {
          /* best effort */
        }
      }
      // ── C-8 配置漂移 fail-closed（与文件头 58-64 行同风格）──────────────────────
      // 两个 loader 行用**不同的配置键**表达同一个暂存根：host 行 `workspaceRoot`、
      // 本行 `cwd`。`getReviewService()` 按 canonical 根做进程内单例
      // （review-service.mjs:330-343），两键一旦不一致就会产生两个单例 ——
      // 于是"暂存写到 A、快照发布在 B"，面板永远看不到改动。
      // 因此：两键**都给了且不一致**时直接 throw，宁可不激活，也不静默分叉。
      //
      // ⚠ 已知限制（**不要**读成"守卫生效"）：`cordis-plugin-include/lib/index.js:99-102`
      //   对 `config` 是**整体替换**（`target[key] = value`），不是深合并。所以任何
      //   **只重述 `cwd`** 的 profile 覆盖层（例如现存形态的 3081
      //   `.t\dsh2\home\profiles\dsh2\cordis.patch.yml`）会把本行 config 换成
      //   `{ cwd }` 而已 —— `workspaceRoot === undefined` ⇒ 上面第一个合取项恒假
      //   ⇒ **本守卫在该实例上不触发**，且 bundle 补丁里锚点提供的
      //   `fs.config.workspaceRoot` 也被整段绕过。此时 drift 检测退化为
      //   "外部约定两处写同一个字面值"。
      //   要让守卫真正生效，profile 覆盖层必须**同时**重述 `workspaceRoot` 与 `cwd`
      //   （T1 正在补）。在此之前，3081 上这条守卫是**空转**的。
      const drift =
        config?.workspaceRoot !== undefined &&
        config?.workspaceRoot !== null &&
        String(config.workspaceRoot).length > 0 &&
        String(config?.cwd ?? '').length > 0 &&
        !sameRoot(config.cwd, config.workspaceRoot)
      if (drift) {
        const error = new Error(
          `WinStage 暂存文件系统：配置漂移 —— workspaceRoot(${config.workspaceRoot}) 与 cwd(${config.cwd}) ` +
            '必须指向同一个暂存根，否则"暂存写到 A、快照发布在 B"',
        )
        error.code = 'FS_STAGE_ROOT_DRIFT'
        throw error
      }
      /**
       * 工作区根（canonical）—— **键映射与存储根解耦**：`keyOf()` 只用它判断内外，
       * 存储根则按会话走（见 `stagingFor()`）。
       */
      this.workspaceRoot = canonical(config?.cwd || process.cwd())
      /** 装配/自测可固定一个会话身份；生产里不传，按每次调用现解析 */
      this.fixedSessionId =
        typeof options.sessionId === 'string' && options.sessionId.length > 0 ? options.sessionId : undefined
      /** 会话 id（'' = 无会话/共享）→ ReviewService；一次进程内不重复解析 */
      this.sessionServices = new Map()
      /** 无会话的共享服务（日志用；也保证升级前的 `.dshstage/` 布局原样存在） */
      this.staging = this.stagingFor(undefined)
      /** 本实例登记的 `watch()` 观察者：`{ rel, isDir, changed }`（见下方 watch 覆写） */
      this.watchers = new Set()
      this.log(
        `暂存文件系统已挂载：工作区 = ${this.workspaceRoot}；` +
          `存储 = 按会话隔离（无会话时 .dshstage/ 根）；工作区外写入 = ${stageOutside === 'direct' ? 'direct（显式逃生口）' : 'stage（进暂存，等批准）'}`,
      )
    }

    /**
     * 本次调用的**会话身份**（审批内容隔离的根）。按优先级：
     *   1. 构造时显式注入的 `sessionId`（装配/自测）；
     *   2. `sandboxPolicy.sessionId` —— 工具层按会话解析后**随每次写调用**传进来
     *      （dsh-sandbox-policy 的 resolve() 在带 session 时返回它）；
     *   3. **调用方 ctx 上的 ambient initiator**（`ctx.agents.currentInitiator()`）：
     *      agent loop 用 `withInitiator` 包住整轮驱动，所以 read/stat/listDir 这些
     *      **没有 policy 参数**的调用也能拿到身份。
     * 都拿不到 ⇒ `undefined` ⇒ 走共享存储（与升级前逐字一致）。
     */
    sessionIdOf(sandboxPolicy) {
      if (this.fixedSessionId) return this.fixedSessionId
      if (sandboxPolicy && typeof sandboxPolicy.sessionId === 'string' && sandboxPolicy.sessionId.length > 0) {
        return sandboxPolicy.sessionId
      }
      try {
        const agents = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('agents') : this.ctx?.agents
        const agent = agents?.currentInitiator?.()
        const id = agent?.session?.id
        if (typeof id === 'string' && id.length > 0) return id
      } catch {
        /* 读不到 initiator ⇒ 下面统一记一次日志 */
      }
      // 拿不到会话身份 ⇒ 只能落共享存储（行为与升级前一致），但**必须响**：
      // 静默分流正是"面板里条目随 Turn 消失"的根因（见 review-service.absorbSharedStore）。
      if (!this.warnedNoSession) {
        this.warnedNoSession = true
        this.log(
          '拿不到调用方会话身份（sandboxPolicy.sessionId 与 ctx.agents.currentInitiator() 都不可用）：' +
            '本次变更会落在共享 .dshstage/ 存储；下一次带会话身份的写/命令会自动把它并入会话存储。',
        )
      }
      return undefined
    }

    /**
     * 本次调用的**会话工作区根**（会话自己的 cwd）。
     * 写路径来自 `sandboxPolicy.workspaceRoot`（策略服务按会话 cwd 解析）；读路径没有 policy
     * 参数，改从 ambient initiator 的 `session.header.cwd` 取。
     * @returns {string|undefined} canonical 根；拿不到返回 undefined
     */
    sessionWorkspaceOf(sandboxPolicy) {
      if (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot.length > 0) {
        try {
          return canonical(sandboxPolicy.workspaceRoot)
        } catch {
          /* 落回 ambient */
        }
      }
      try {
        const agents = this.ctx && typeof this.ctx.get === 'function' ? this.ctx.get('agents') : this.ctx?.agents
        const cwd = agents?.currentInitiator?.()?.session?.header?.cwd
        if (typeof cwd === 'string' && cwd.length > 0) return canonical(cwd)
      } catch {
        /* 读不到 ⇒ undefined */
      }
      return undefined
    }

    /**
     * 本会话是否属于**插件配置的暂存根**。
     *
     * 不匹配时**绝不假装暂存**（那会让"写成功"回执与真实磁盘脱节，且内容进了一个
     * 该会话看不见的待审存储）：调用方改为直接 `super`（平台沙箱/审批面）。
     * 拿不到会话工作区（agentless 调用）时按"属于"处理，保持升级前行为。
     */
    inConfiguredWorkspace(sandboxPolicy) {
      const sessionRoot = this.sessionWorkspaceOf(sandboxPolicy)
      if (sessionRoot === undefined) return true
      try {
        return sameRoot(sessionRoot, this.workspaceRoot)
      } catch {
        return true
      }
    }

    /**
     * 不匹配时的**一次性**日志（每次调用都刷屏没有意义；但静默更糟）。
     */
    warnForeignWorkspace(sandboxPolicy) {
      if (this.warnedForeignWorkspace) return
      this.warnedForeignWorkspace = true
      this.log(
        `会话工作区（${this.sessionWorkspaceOf(sandboxPolicy) ?? '未知'}）与 WinStage 配置的暂存根（${this.workspaceRoot}）不同：` +
          '本会话的读写**不经过暂存**，直接走平台沙箱/审批面（避免"工具说写成功、真实磁盘却没有"）。',
      )
    }

    /** 会话身份 → 该会话自己的审阅服务（缓存；`undefined` ⇒ 共享存储） */
    stagingFor(sessionId) {
      const key = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : ''
      let service = this.sessionServices.get(key)
      if (!service) {
        service = getReviewService({
          workspaceRoot: this.workspaceRoot,
          ...(key ? { sessionId: key } : {}),
          // T3d：只有"本行此刻接管"时才允许认领共享存储里的条目；关闭态一律不认领。
          // （写路径上还有一次显式 `absorbSharedStore()`，在 `!stagingEnabled()` 早退**之后**，
          //   所以关闭态的写既不走暂存也不会认领。）
          claimShared: this.stagingEnabled(),
          ...(this.logger ? { logger: this.logger } : {}),
        })
        this.sessionServices.set(key, service)
      }
      return service
    }

    /**
     * 本行此刻是否应当接管变更面 —— **开关的唯一真源**。
     *
     * 读的是 loader 行 `winstage-sandbox`（设置页那一行）的 `config.enabled`，而且
     * **每次调用都现读**：`rootEntry.parent.data` 是 patch 组合后的那一份，设置改动走
     * configEditor → reconcileProfilePatches → `EntryGroup.update()` 会把整份换新
     * （`parent` 这个 EntryGroup 对象本身不变，只有它的 `data` 被换）。
     * 因此"关掉/打开"即时生效，且**不需要卸载或重挂任何行**；命令面与面板也按
     * 同一个开关现读，所以三处不会漂移。
     *
     * 树里找不到该行（离线自测、行被移除）时默认 `true`：保持"接管"这一历史行为。
     */
    stagingEnabled() {
      if (enabledOverride) return enabledOverride() !== false
      try {
        // 只认构造时抓住的 rootEntry；`this.ctx.fiber.entry` 会指向**调用方**（见构造函数注释）
        const data = (this.rootEntry ?? this.ctx?.fiber?.entry)?.parent?.data
        if (!Array.isArray(data)) return true
        const row = data.find((item) => item && item.id === 'winstage-sandbox')
        if (!row || !row.config) return true
        return row.config.enabled !== false
      } catch {
        return true
      }
    }

    /**
     * 围栏能力**只跟着开关的面走**：
     *   - 开启（暂存面）：报 `undefined`，`dsh-tool-fs` 就不向模型广告
     *     `sandbox_permissions` —— 升权了变更也仍进暂存，广告它只会失真；
     *   - 关闭（平台面）：报平台后端自己的默认模式（`super.sandboxMode`），
     *     于是 `[sandbox: …]` 拒绝与同回合升权提示都与"没装本插件"逐字一致。
     */
    get sandboxMode() {
      if (this.stagingEnabled()) return undefined
      return super.sandboxMode
    }

    // ==================== 路径映射 ====================

    /**
     * `FsTarget` → **清单键**（S3a）。
     *
     *   工作区**内** → `{ key: <相对路径>, external: false, abs }`（根为 `''`）
     *   工作区**外** → `{ key: <规范化绝对路径>, external: true, abs }`
     *
     * 根返回 `''` 而不是 `undefined` 是**必须**的：根自身不参与暂存（写根会报错），
     * 但根的**目录枚举**必须合并暂存子项 —— 早期版本在这里返回 `undefined`，
     * 导致"只在暂存里存在的新目录"在根枚举中消失（自测抓到）。
     *
     * 外部键用**绝对路径**（与 `src/workspace.mjs` 的 `keyOf()` 同一模型），
     * 因此 `entryOf()` 对两种条目是同一个查找，键空间天然不相交。
     */
    /**
     * P0-8：**经 `ctx.fs` 的存储写入一律拒绝**（"失败必须响"）。
     *
     * 抛 `FsError` + `FS_SANDBOX_DENIED`：`dsh-tool-fs` 的 `mapError()` 会把它渲染成
     * 共享的 `[sandbox: …]` 拒绝标记（`dsh-tool-fs/lib/index.js:1146-1162`），
     * 因此模型与用户**都能看见**，不是静默失败；同时这里再留一条 error 级日志。
     */
    denyStoreWrite(place, verb) {
      const target = String(place?.abs ?? '')
      this.logError(`P0-8 refused to ${verb} WinStage's own store: ${target}`)
      throw new FsError(
        `refusing to ${verb} "${target}": this path belongs to WinStage's own store ` +
          `(metadata / blobs / staged / staged-ext / candidates / sessions). Staging it would create a ` +
          `self-referential entry that can never be approved. NOTE: shell writes bypass ctx.fs and are not covered.`,
        'FS_SANDBOX_DENIED',
      )
    }

    keyOf(target) {
      try {
        const abs = canonical(target.targetKey)
        const root = this.workspaceRoot
        const rel = relative(root, abs)
        if (rel === '') return { key: '', external: false, abs: root }
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { key: abs, external: true, abs }
        return { key: rel, external: false, abs }
      } catch {
        return undefined
      }
    }

    entryOf(ws, rel) {
      return ws.entryOf(rel)
    }

    /**
     * 该路径是否存在**构成净变化的**暂存条目。
     *
     * 不再是"清单里有条目就算"：批准过的条目**不会**从清单里消失 —— `applyOneChange()`
     * 只是把 `baseHash = stagedHash` 标记为"已是新基线"（src/workspace.mjs:1002-1015）。
     * 此后真实文件若被外部改过，暂存 blob 仍是**批准当时**的旧内容；继续遮蔽真实磁盘就会
     * 让用户看到"净 diff 是空的、read 却是陈旧内容" —— 那正是面板那句"已不在当前净 diff：
     * 暂存内容已被取代，无法再批准"不可见的那一半。
     */
    hasEntry(ws, rel) {
      return this.projectsEntry(ws.entryOf(rel))
    }

    /**
     * 该暂存条目是否构成**净变化** —— 只有净变化才允许遮蔽真实磁盘。
     *
     * 判据与 `src/workspace.mjs:780 diffEntries()` **逐条对齐**（同一个仓库不能有两套
     * "什么算变化"的口径）：删除类看真实基线是否曾经存在、目录类只看**非合成**的 mkdir、
     * 文件类看 `stagedHash !== baseHash`。
     */
    projectsEntry(entry) {
      if (!entry) return false
      if (entry.state === STATE.DELETED) {
        return !(entry.baseHash === hashAbsent() && entry.baseKind === undefined)
      }
      if (entry.kind === 'dir') return entry.baseKind !== 'dir' && entry.synthetic !== true
      return entry.stagedHash !== entry.baseHash
    }

    /**
     * 该目录下（含自身）是否有暂存条目；根（`''`）表示"暂存树里是否有工作区内条目"。
     * 键空间隔离：列工作区内目录时不把外部条目算进来（反之亦然）——
     * 否则 `C:\out` 会被当成工作区根的直接子项（`c:`）混进根枚举。
     */
    hasEntryUnder(ws, rel) {
      const external = isExternalKey(rel)
      const inSpace = (entry) => (entry.external === true) === external
      const projects = (entry) => this.projectsEntry(entry)
      if (rel === '') {
        return Object.values(ws.manifest.entries).some((entry) => entry.external !== true && projects(entry))
      }
      if (this.hasEntry(ws, rel)) return true
      const prefix = `${rel}${sep}`.toLowerCase()
      return Object.entries(ws.manifest.entries).some(
        ([key, entry]) => inSpace(entry) && projects(entry) && key.toLowerCase().startsWith(prefix),
      )
    }

    /** 变更前把该会话的 Workspace 重建成最新（另一进程/会话可能刚改过） */
    reloaded(service) {
      service.reload()
      return service.workspace
    }

    // ==================== 变更面 ====================

    async writeText(target, content, expected, signal, sandboxPolicy) {
      // 关：原样走平台沙箱后端（围栏 + 真实磁盘），暂存树一位不碰
      if (!this.stagingEnabled()) return super.writeText(target, content, expected, signal, sandboxPolicy)
      if (!this.inConfiguredWorkspace(sandboxPolicy)) {
        this.warnForeignWorkspace(sandboxPolicy)
        return super.writeText(target, content, expected, signal, sandboxPolicy)
      }
      if (signal?.aborted) throw new FsError('write aborted', 'FS_ABORTED')
      const place = this.keyOf(target)
      if (place === undefined) return super.writeText(target, content, expected, signal, sandboxPolicy)
      if (place.key === '') {
        throw new FsError(`cannot write "${target.displayPath}": the workspace root is not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      // ── P0-8：WinStage 自己的存储状态机**不给经 `ctx.fs` 的写权** ──────────────
      // 放在 `stageOutside === 'direct'` 之前：那个逃生口会**直写真实磁盘**，更必须先拦。
      if (isStoreStatePath(place.abs)) this.denyStoreWrite(place, 'write')
      // 显式逃生口（默认关闭）：直通真实磁盘。**不是**默认路径，也不再有"拒绝"分支。
      if (place.external && stageOutside === 'direct') {
        return super.writeText(target, content, expected, signal, sandboxPolicy)
      }
      const service = this.stagingFor(this.sessionIdOf(sandboxPolicy))
      // 自愈：上一段"拿不到会话"的写可能积在共享存储里（旧进程尤其如此）
      service.absorbSharedStore?.()
      return this.withLock(String(target.targetKey), async () => {
        const ws = this.reloaded(service)
        const abs = place.abs
        const current = await this.currentOf(ws, target, place.key, signal)
        if (current.exists && current.kind !== 'file') {
          throw new FsError(`cannot write "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        }
        if (expected?.kind === 'replaceIfVersion') {
          if (!current.exists) throw new FsError(`cannot write "${target.displayPath}": file no longer exists`, 'FS_STALE_VERSION')
          if (current.version !== String(expected.version)) {
            throw new FsError(`cannot write "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
          }
        } else if (expected?.kind === 'createIfAbsent' && current.exists) {
          throw new FsError(`cannot overwrite existing "${target.displayPath}" without reading it first`, 'FS_NOT_OBSERVED')
        }

        const before =
          current.exists && Buffer.byteLength(String(content), 'utf8') < (this.config?.diffBasisMaxBytes ?? 0)
            ? normalizeLineEndings(current.text)
            : null
        const result = ws.writeFile(abs, String(content), { origin: 'dsh-tool' })
        const after = normalizeLineEndings(content)
        service.markFresh()
        service.afterMutation('dsh-write')
        this.notifyStagedChange(place.key)
        return { operation: current.exists ? 'update' : 'create', version: FsVersion(`winstage:${result.hash}`), before, after }
      })
    }

    async editText(target, edit, expected, signal, sandboxPolicy) {
      if (!this.stagingEnabled()) return super.editText(target, edit, expected, signal, sandboxPolicy)
      if (!this.inConfiguredWorkspace(sandboxPolicy)) {
        this.warnForeignWorkspace(sandboxPolicy)
        return super.editText(target, edit, expected, signal, sandboxPolicy)
      }
      if (signal?.aborted) throw new FsError('edit aborted', 'FS_ABORTED')
      const place = this.keyOf(target)
      if (place === undefined) return super.editText(target, edit, expected, signal, sandboxPolicy)
      if (place.key === '') {
        throw new FsError(`cannot edit "${target.displayPath}": the workspace root is not a regular file`, 'FS_NOT_REGULAR_FILE')
      }
      // ── P0-8：同 writeText（见那里的说明）────────────────────────────────────
      if (isStoreStatePath(place.abs)) this.denyStoreWrite(place, 'edit')
      if (place.external && stageOutside === 'direct') {
        return super.editText(target, edit, expected, signal, sandboxPolicy)
      }
      const service = this.stagingFor(this.sessionIdOf(sandboxPolicy))
      // 同上：写路径是"一定会话级"的入口，顺手把共享存储并进来
      service.absorbSharedStore?.()
      return this.withLock(String(target.targetKey), async () => {
        const ws = this.reloaded(service)
        const abs = place.abs
        const current = await this.currentOf(ws, target, place.key, signal)
        if (!current.exists) throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        if (current.kind !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
        if (expected && current.version !== String(expected.version)) {
          throw new FsError(`cannot edit "${target.displayPath}": file changed since it was read`, 'FS_STALE_VERSION')
        }
        const normalized = normalizeLineEndings(current.text)
        const edited = applyLiteralEdit(normalized, edit, target.displayPath)
        const storage = restoreLineEndings(edited, lineEndingOf(current.text))
        const result = ws.writeFile(abs, storage, { origin: 'dsh-tool' })
        service.markFresh()
        service.afterMutation('dsh-edit')
        this.notifyStagedChange(place.key)
        return { version: FsVersion(`winstage:${result.hash}`), before: normalized, after: edited }
      })
    }

    // ==================== 监听面（S7） ====================

    /**
     * 覆写 `watch`：**超类观察者照旧**（真实磁盘变更仍然通知），
     * 另把**暂存变更**也转成失效通知。
     *
     * 为什么需要：基类 `LocalFileSystem.watch`（dsh-fs-local/lib/index.js:726-750）
     * 只盯真实磁盘；暂存写入从不碰真实磁盘，所以走 `write`/`edit` 的改动过去不会让
     * `ctx.remote.workspaceFiles.changes` 的客户端文件视图失效（S7）。
     *
     * 契约（dsh-fs `watch(target, changed, signal)`）：回调**没有事件类型、没有路径**，
     * 只表示"这个 target 失效了"；所以这里只需决定"该不该叫醒它"。
     * 判定与超类逐字对齐（`:731-739`）：**目录** target 对**直接子项**通知；
     * **文件** target 只对该文件本身通知。
     *
     * 残余边界（如实标注，不做假承诺）：**跨进程**改动
     * （CLI / 另一个 DSH 实例写同一份暂存树）仍然不会通知 —— 超类的本地观察者也看不到。
     */
    async watch(target, changed, signal) {
      // 关：暂存树不会被改动，失效通知也就没有暂存来源 —— 原样只观察真实磁盘
      if (!this.stagingEnabled()) return super.watch(target, changed, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.watch(target, changed, signal)
      }
      const close = await super.watch(target, changed, signal)
      const place = this.keyOf(target)
      if (place === undefined) return close
      const rel = place.key
      let isDir = rel === ''
      if (!isDir) {
        try {
          isDir = (await super.stat(target, signal))?.type === 'directory'
        } catch {
          isDir = false
        }
      }
      // 外部条目（绝对键）同样登记：它现在也有暂存变更需要失效通知
      // （S3a 之前工作区外根本没有暂存条目，所以这里只会走真实磁盘语义）。
      const entry = { rel, isDir, changed }
      this.watchers.add(entry)
      return async () => {
        this.watchers.delete(entry)
        await close()
      }
    }

    /**
     * 暂存变更 → 本地失效通知。
     * 只触碰本次登记的观察者；**任何异常都在这里吞掉**（chokidar 的回调抛错会变成
     * error 分支，而写路径绝不能因为"通知"失败而失败）。
     */
    notifyStagedChange(rel) {
      if (this.watchers.size === 0) return
      const changedRel = String(rel)
      const parentOf = (value) => {
        const dir = dirname(value === '' ? '.' : value)
        return dir === '' ? '.' : dir
      }
      for (const entry of [...this.watchers]) {
        try {
          const hit = entry.isDir
            ? parentOf(changedRel) === (entry.rel === '' ? '.' : entry.rel)
            : changedRel === entry.rel
          if (hit) entry.changed()
        } catch (error) {
          this.log(`暂存变更通知失败（${changedRel}）：${error?.message ?? error}`)
        }
      }
    }

    // ==================== 读取面 ====================

    /**
     * 当前状态：暂存条目优先，否则回落到真实磁盘。
     * `key` 既可以是工作区相对路径，也可以是工作区外条目的绝对路径键（S3a）。
     * @returns {{exists: boolean, kind?: 'file'|'dir', text?: string, version?: string}}
     */
    async currentOf(ws, target, key, signal) {
      const entry = ws.entryOf(key)
      // 只有**净变化**条目才遮蔽真实磁盘：批准过、随后被外部改过的旧条目不投影
      const projected = this.projectsEntry(entry)
      if (projected && entry.state === STATE.DELETED) return { exists: false }
      if (projected && entry.state !== STATE.DELETED) {
        if (entry.kind === 'dir') return { exists: true, kind: 'dir', version: `winstage:dir:${key}` }
        if (!ws.store.hasBlob(entry.stagedHash)) {
          throw new FsError(`staged content for "${target.displayPath}" is missing`, 'FS_IO_ERROR')
        }
        return {
          exists: true,
          kind: 'file',
          text: ws.store.readBlob(entry.stagedHash).toString('utf8'),
          version: `winstage:${entry.stagedHash}`,
        }
      }
      // 合成目录：真实不存在，但暂存树里有**构成净变化的**子项。
      // 用本文件的 hasEntryUnder 而不是 workspace.hasStagedDescendant：后者不看净变化，
      // 会把"只剩已批准条目"的目录也合成出来。
      if (this.hasEntryUnder(ws, key)) return { exists: true, kind: 'dir', version: `winstage:dir:${key}` }
      const info = await super.stat(target, signal)
      if (!info) return { exists: false }
      if (info.type === 'directory') return { exists: true, kind: 'dir', version: String(info.version) }
      if (info.type !== 'file') return { exists: true, kind: 'other', version: String(info.version) }
      // 基线文件：文本按需读（只在需要 before 文本时读）
      let text
      try {
        text = await super.readText(target, signal)
      } catch {
        text = undefined
      }
      return { exists: true, kind: 'file', version: String(info.version), text }
    }

    async stat(target, signal) {
      if (!this.stagingEnabled()) return super.stat(target, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.stat(target, signal)
      }
      const place = this.keyOf(target)
      if (place === undefined) return super.stat(target, signal)
      const ws = this.stagingFor(this.sessionIdOf()).fresh()
      const current = await this.currentOf(ws, target, place.key, signal)
      if (!current.exists) return undefined
      if (current.kind === 'dir') return { version: FsVersion(current.version), type: 'directory', size: 0 }
      if (current.kind !== 'file') return { version: FsVersion(current.version), type: 'other' }
      return { version: FsVersion(current.version), type: 'file', size: Buffer.byteLength(current.text ?? '', 'utf8') }
    }

    async lstat(path, opts, signal) {
      if (!this.stagingEnabled()) return super.lstat(path, opts, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.lstat(path, opts, signal)
      }
      if (typeof path !== 'string' || path.trim().length === 0) {
        throw new FsError('file_path must be a non-empty string', 'FS_NOT_FOUND')
      }
      const base = opts?.cwd || this.config?.cwd || process.cwd()
      const abs = canonical(isAbsolute(path) ? path : join(base, path))
      const place = this.keyOf({ targetKey: FsTargetKey(abs), displayPath: path })
      if (place === undefined) return super.lstat(path, opts, signal)
      const ws = this.stagingFor(this.sessionIdOf()).fresh()
      const current = await this.currentOf(ws, { targetKey: FsTargetKey(abs), displayPath: path }, place.key, signal)
      if (!current.exists) return undefined
      if (current.kind === 'dir') return { version: FsVersion(current.version), type: 'directory', size: 0 }
      if (current.kind !== 'file') return { version: FsVersion(current.version), type: 'other' }
      return { version: FsVersion(current.version), type: 'file', size: Buffer.byteLength(current.text ?? '', 'utf8') }
    }

    async readText(target, signal) {
      if (!this.stagingEnabled()) return super.readText(target, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.readText(target, signal)
      }
      const place = this.keyOf(target)
      if (place === undefined) return super.readText(target, signal)
      const ws = this.stagingFor(this.sessionIdOf()).fresh()
      if (!this.hasEntry(ws, place.key)) return super.readText(target, signal)
      const current = await this.currentOf(ws, target, place.key, signal)
      if (!current.exists) throw new FsError(`"${target.displayPath}" does not exist`, 'FS_NOT_FOUND')
      if (current.kind === 'dir') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      return current.text ?? ''
    }

    async streamText(target, signal) {
      if (!this.stagingEnabled()) return super.streamText(target, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.streamText(target, signal)
      }
      const text = await this.readText(target, signal)
      return (async function* stream() {
        yield text
      })()
    }

    async readBytes(target, signal, maxBytes) {
      if (!this.stagingEnabled()) return super.readBytes(target, signal, maxBytes)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.readBytes(target, signal, maxBytes)
      }
      const place = this.keyOf(target)
      if (place === undefined) return super.readBytes(target, signal, maxBytes)
      const ws = this.stagingFor(this.sessionIdOf()).fresh()
      if (!this.hasEntry(ws, place.key)) return super.readBytes(target, signal, maxBytes)
      const current = await this.currentOf(ws, target, place.key, signal)
      if (!current.exists) throw new FsError(`"${target.displayPath}" does not exist`, 'FS_NOT_FOUND')
      if (current.kind === 'dir') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      const buffer = Buffer.from(current.text ?? '', 'utf8')
      if (Number.isSafeInteger(maxBytes) && buffer.length > maxBytes) {
        throw new FsError(`cannot read "${target.displayPath}": file is larger than ${maxBytes} bytes`, 'FS_TOO_LARGE')
      }
      return new Uint8Array(buffer)
    }

    async readByteRange(target, range, signal) {
      if (!this.stagingEnabled()) return super.readByteRange(target, range, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.readByteRange(target, range, signal)
      }
      const place = this.keyOf(target)
      if (place === undefined) return super.readByteRange(target, range, signal)
      const ws = this.stagingFor(this.sessionIdOf()).fresh()
      if (!this.hasEntry(ws, place.key)) return super.readByteRange(target, range, signal)
      const current = await this.currentOf(ws, target, place.key, signal)
      if (!current.exists) throw new FsError(`"${target.displayPath}" does not exist`, 'FS_NOT_FOUND')
      if (current.kind === 'dir') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      const buffer = Buffer.from(current.text ?? '', 'utf8')
      const offset = Number(range?.offset ?? 0)
      const length = Number(range?.length ?? buffer.length)
      return new Uint8Array(buffer.subarray(offset, Math.min(buffer.length, offset + length)))
    }

    async listDir(target, signal) {
      if (!this.stagingEnabled()) return super.listDir(target, signal)
      if (!this.inConfiguredWorkspace()) {
        this.warnForeignWorkspace()
        return super.listDir(target, signal)
      }
      const place = this.keyOf(target)
      if (place === undefined) return super.listDir(target, signal)
      const rel = place.key
      const ws = this.stagingFor(this.sessionIdOf()).fresh()
      if (!this.hasEntryUnder(ws, rel)) return super.listDir(target, signal)

      /** @type {Map<string, {name: string, type: string, target: object, version?: string, size?: number}>} */
      const merged = new Map()
      try {
        for (const entry of await super.listDir(target, signal)) {
          merged.set(entry.name.toLowerCase(), entry)
        }
      } catch {
        // 目录只存在于暂存树里（真实磁盘上没有）→ 基线为空
      }

      // 键空间隔离（S3a）：列工作区内目录时不合并外部条目（否则 `C:\out` 会以 `c:` 混进根枚举）；
      // 列外部目录时只合并外部条目。真实磁盘那一侧由上面的 super.listDir 提供。
      const external = place.external
      const prefix = rel === '' ? '' : `${rel}${sep}`.toLowerCase()
      for (const [key, entry] of Object.entries(ws.manifest.entries)) {
        if ((entry.external === true) !== external) continue
        if (!this.projectsEntry(entry)) continue // 无净变化的条目（已批准、后来被外部改过）不合并
        const lower = key.toLowerCase()
        if (rel !== '' && !lower.startsWith(prefix)) continue
        const rest = rel === '' ? key : key.slice(rel.length + 1)
        if (rest.length === 0) continue
        const head = rest.split(/[\\/]/)[0]
        const childRel = join(rel, head)
        const isDirect = !rest.slice(head.length).match(/[\\/]/)
        const childAbs = ws.absolute(childRel)
        const targetOfChild = { targetKey: FsTargetKey(canonical(childAbs)), displayPath: childAbs }
        const keyOfChild = head.toLowerCase()

        if (entry.state === STATE.DELETED && isDirect) {
          merged.delete(keyOfChild)
          continue
        }
        const direct = isDirect ? entry : undefined
        const kind = direct ? direct.kind : 'dir'
        if (kind === 'dir') {
          merged.set(keyOfChild, { name: head, type: 'directory', target: targetOfChild })
          continue
        }
        merged.set(keyOfChild, {
          name: head,
          type: 'file',
          target: targetOfChild,
          version: FsVersion(`winstage:${direct.stagedHash}`),
          size: direct.size,
        })
      }
      return [...merged.values()]
    }
  }
}
