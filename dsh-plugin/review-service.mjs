/**
 * WinStage 审阅服务（Host 侧）——把项目自有的「暂存—候选—选择性提交」接进 DSH。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────────
 * 暂存树（`.dshstage/`）里的变化必须有一个**权威的读侧与决定侧**：
 *   - 读侧：把"当前待审了什么"渲染成一份快照；
 *   - 决定侧：批准（写进真实工作区）或拒绝（把投影退回真实磁盘）。
 * 两者都走项目自有的 `Workspace`，因此与手工 CLI（`run.cmd`）**共用同一份状态**，
 * 不会出现"CLI 说有待审、面板说没有"的漂移。
 *
 * ── Client 怎么读到快照（这里有一个必须如实说明的机制约束）────────────────────
 * Client **无法**注册新的 `ctx.remote.<命名空间>`：`@deepseek-ai/dsh-api-remotes`
 * 的能力选集是**构建时固定**的（其 README 逐字："Client 不会在运行时发现 Host 中
 * 已启用的服务或 Remote 定义"）。因此本服务用两条**已有的**通道供数：
 *   1. 读：把快照写成工作区内的普通文件（`<workspaceRoot>/.dshstage/review.json`），
 *      Client 用已有的 `ctx.remote.workspaceFiles.read` 读它；
 *   2. 写：Client 用已有的 `ctx.remote.commands.execute` 执行 `/winstage approve|reject`。
 * 两条通道都已带鉴权与类型，不需要改 DSH 的 Client 装配（那是构建期产物）。
 *
 * ── 多进程一致性 ────────────────────────────────────────────────────────────
 * `Workspace` 的清单是**进程内内存**，每次操作前都重新 `init()` 从磁盘读回，
 * 因此 CLI（其它进程）刚做的改动不会被我方的陈旧副本覆盖。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { MASK_CLASSES, SELF_MASK_ID, canonical, compareKey, isInside, maskReason } from '../src/paths.mjs'
import { STATE, STORE_DIR, hashAbsent, hashFile, makeRemovable, writeFileAtomic } from '../src/store.mjs'
import { Workspace } from '../src/workspace.mjs'
import { renderCandidateDiff } from '../src/tools.mjs'

/** 快照文件名（相对 `<workspaceRoot>/.dshstage`） */
export const REVIEW_BASENAME = 'review.json'

/**
 * `safety:"danger"` 条目写进 review.json 的 `diff` 字段的占位原因。
 *
 * 逐字由第三阶段面板与断言共用，**不要**在别处再写一份字面量。
 */
export const SENSITIVE_OMIT_NOTE = '内容已按敏感策略省略（不把凭据/密钥片段写入 review.json）'

/**
 * `safety:"danger"` 的判定依据：命中的 mask id 属于"凭据 / 本工具自身"这一组，
 * 或该规则的 `hard === true`，或调用方用 `dangerMaskIds` 显式覆盖（自定义规则用）。
 *
 * ── 为什么 danger 集合在**这里**而不是 `src/paths.mjs`（Lead 决策 B，留痕）──────
 * `paths.mjs` 的 `MASK_CLASSES` 是**安全/遮蔽清单**（决定"能不能读"），
 * 而 normal/outside/sensitive 是**UI 呈现分级**（决定"面板怎么画、要不要二次确认"）。
 * 把"哪些算危险"写进 `paths.mjs`，就是让安全清单承担 UI 策略。
 *
 * 曾经有一版契约写的是"`rule.hard === true` ⇒ danger"，那是**错的**：
 * 磁盘上 `src/paths.mjs:181` 对内置规则硬编码 `return { …, hard: true }`，
 * 于是 `hosts`/`wifi`/`sam` **全部**带 `hard:true`，`hosts` 会被判成 danger。
 * 因此判据改为**按 id 清单认定**，并保留 `hard === true` 作为补充（不是主依据）。
 *
 * 代价（已在报告里显式声明，不是隐性行为）：**用户自定义 mask 无法声明 danger** ——
 * 危险集合由本模块持有；自定义规则只能落在 `risk`，
 * 除非调用方通过 `dangerMaskIds` 显式指定该自定义 id。
 *
 * 这份清单**不是**第二套遮蔽清单：它只是从 `MASK_CLASSES` 里挑 id，
 * 所有取值必须逐字存在于 `MASK_CLASSES`，由 `assertDangerIdsExist()` 硬失败校验。
 */
export const DANGER_MASK_IDS = Object.freeze([
  SELF_MASK_ID, // 'stage-store' → .dshstage
  'ssh',
  'aws',
  'gcloud',
  'kube',
  'git-credentials',
  'npmrc',
  'dsh-home',
  'dpapi',
  'dpapi-user',
  'browser',
  'sam',
  'sysvol-copy',
  'wifi',
])

/**
 * 必须存在于 `MASK_CLASSES` 的 id 清单（用于清单漂移硬失败）。
 * `hosts` 是**非 hard 的代表**：它必须能被判成 `risk`，所以绝不能进危险清单。
 */
export const REQUIRED_MASK_IDS = Object.freeze([...DANGER_MASK_IDS, 'hosts'])

const DANGER_IDS = new Set(DANGER_MASK_IDS)

/**
 * 清单漂移**硬失败**校验：`MASK_CLASSES` 里找不到的 id 直接抛错，
 * 而不是退化成"永不 danger"。模块加载时自动跑一次；断言脚本也会显式再跑一次。
 */
export function assertDangerIdsExist() {
  const known = new Set(MASK_CLASSES.map((rule) => rule.id))
  const missing = REQUIRED_MASK_IDS.filter((id) => !known.has(id))
  if (missing.length > 0) {
    throw new Error(
      `review-service: MASK_CLASSES 里找不到这些 id，判级会静默失准：${missing.join(', ')}。` +
        '请同步 src/paths.mjs 与 review-service.mjs 的危险清单。',
    )
  }
  const wrong = DANGER_MASK_IDS.filter((id) => !DANGER_IDS.has(id))
  if (wrong.length > 0) throw new Error(`review-service: DANGER_MASK_IDS 自相矛盾：${wrong.join(', ')}`)
  return true
}
assertDangerIdsExist()

const BUILTIN_MASK_IDS = new Set(MASK_CLASSES.map((rule) => rule.id))

/** 一次命中的 mask 是否属于"凭据 / 本工具自身" ⇒ `safety:"danger"`。
 *
 * ⚠ 判定顺序至关重要，这里是**已经被断言抓到过一次**的地方：
 * 不能先判 `hard === true`！内置规则在 `src/paths.mjs:181` **一律**返回 `hard: true`
 *（不是每条规则自己写的 `hard`），所以"`hard:true` ⇒ danger"会把
 * `hosts`/`wifi` 之类非凭据规则全部误升级成 danger（断言⑤就是这么挂的）。
 *
 * 正确规则（分两类）：
 *   1. **内置规则**（id 出现在 `MASK_CLASSES` 里）：只看 id 清单，
 *      `hard` 字段在这个分支里**没有判别力**，必须忽略；
 *   2. **自定义规则**（`options.masks` 传入的，id 不在 `MASK_CLASSES` 里）：
 *      允许用显式 `hard: true` 声明"这条归 danger" —— 这是用户唯一能把
 *      自定义 mask 抬到 danger 的口子（默认只到 `risk`，见 `DANGER_MASK_IDS` 注释）。
 */
function isDangerMask(mask, dangerIds) {
  const id = mask?.id
  if (dangerIds.has(id)) return true
  if (id && !BUILTIN_MASK_IDS.has(id) && mask?.hard === true) return true
  return false
}

/** 判级链的共享前半段：路径 → 规范化绝对路径 + 命中的 mask（无则 undefined） */
export function maskEntryFor(anyPath, extraMasks = []) {
  const resolved = canonical(anyPath)
  return { resolved, mask: maskReason(resolved, extraMasks) }
}

/**
 * 判级纯函数：`change` → `{ external, risk, safety, riskReason }`。
 *
 * 三档**不是互斥树**，因此判级是一条**短路顺序链**：
 *   1. 命中敏感规则 ⇒ `sensitive`（不管在不在工作区内：`.dshstage` 就是"内 + 敏感"）；
 *   2. 否则不在工作区内 ⇒ `outside`；
 *   3. 否则 ⇒ `normal`。
 *
 * `safety` / `riskReason` **仅**在 `sensitive` 档有值，其余为 `null`
 * （契约逐字如此；面板据此判断"要不要走二次确认"）。
 *
 * "在不在工作区内"用 `canonical()` 解析后的 `isInside()` 判定（无掩码时才需要），
 * 与 `Workspace.maskOf()` 同一套口径：工作区内的 junction 指向宿主敏感目录也逃不掉（#16.6）。
 *
 * 纯函数：不读盘（除 `canonical()` 为解析链接所做的 stat）、不写盘、无副作用。
 *
 * @param {{path: string, external?: boolean, [key: string]: any}} change 暂存条目
 * @param {{workspaceRoot?: string, masks?: Array<object>, dangerMaskIds?: Iterable<string>}} options
 */
export function classifyChange(change, options = {}) {
  if (typeof change?.path !== 'string' || change.path.length === 0) {
    throw new TypeError('classifyChange: change.path must be a non-empty string')
  }
  const workspaceRoot = options.workspaceRoot
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    throw new TypeError('classifyChange: options.workspaceRoot is required')
  }

  // 工作区外条目的 `path` 由 S3a 写为**绝对路径**（契约），工作区内条目是**相对路径**。
  // 相对路径必须先按 `workspaceRoot` 拼接再 canonical —— 裸 canonical 会拿进程 cwd 当基准，
  // 于是工作区内的相对条目会被误判成"外面"（断言 ① 抓到的真缺陷）。
  //
  // `external` 的判据（顺序）：显式 `change.external` 布尔 > **resolved 后是否在工作区内**。
  // 为什么不"词法上是否绝对路径"：工作区**内**的绝对路径真实存在
  //（如 `<wsRoot>\\.dshstage\\staged\\x`），按词法会把"内+敏感"错判成 external（断言 ④ 抓到的）。
  // 用 resolved 判定与 `Workspace.maskOf()` 同源，也与 S3a 的暂存语义一致：
  // 外部条目 canonical 后不落在 workspace realpath 下 ⇒ 必然判为 external。
  const explicitExternal = typeof change.external === 'boolean' ? change.external : undefined
  const absolute = isAbsolute(change.path) ? change.path : join(workspaceRoot, change.path)
  const resolved = canonical(absolute)

  const dangerIds = options.dangerMaskIds ? new Set(options.dangerMaskIds) : DANGER_IDS
  const mask = maskReason(resolved, options.masks || [])

  let inside
  if (explicitExternal === undefined) {
    try {
      inside = isInside(workspaceRoot, resolved)
    } catch {
      inside = true // 判不出来时按"在工作区内"处理（normal），绝不凭空升格为 outside
    }
  }
  const external = explicitExternal ?? !inside

  if (mask) {
    return {
      external,
      risk: 'sensitive',
      safety: isDangerMask(mask, dangerIds) ? 'danger' : 'risk',
      riskReason: mask.reason ?? null,
    }
  }

  // 无敏感命中：只有"在不在工作区内"影响档位。
  // 取"显式声明"与"resolved 判定"任一为外：工作区内的 junction 指到外部时，
  // 呈现层宁可多提示一次，也不把外部条目画成普通改动。
  const outside = external === true || inside === false
  return {
    external: outside,
    risk: outside ? 'outside' : 'normal',
    safety: null,
    riskReason: null,
  }
}

/** 三档 + danger 汇总（顶层 `riskCounts`） */
export function countRisks(files) {
  const counts = { normal: 0, outside: 0, sensitive: 0, danger: 0 }
  for (const item of files) {
    if (item.risk === 'normal') counts.normal += 1
    else if (item.risk === 'outside') counts.outside += 1
    else if (item.risk === 'sensitive') {
      counts.sensitive += 1
      if (item.safety === 'danger') counts.danger += 1
    }
  }
  return counts
}

/**
 * 顶层 `alerts`：**只承载数据，不做任何阻断**。
 *
 * 为什么需要它（用户拍板的交互模型）：运行时**不弹任何东西**，只有"明确信息泄露"
 *（`safety:"danger"`）在运行时**报一次**，批准/拒绝全部异步。
 * Host 侧因此**不实现任何阻塞式审批** —— 本服务只负责在快照里**声明**
 * "有 N 项危险改动"，由 Client 决定怎么呈现（日志 / 横幅 / 一次性提示）。
 *
 * 去重语义由数据本身表达，而不是靠 Host 记状态：
 *   - `id` = `candidateId` + `kind` ⇒ 同一份候选反复轮询得到**同一个** id。
 *     Client 只要记住"这个 id 报过没有"，就能做到"报一次"而不会每次刷新都弹。
 *   - `candidateId` 变化（用户又改了暂存树）⇒ id 变化 ⇒ 值得再报一次。
 *
 * 注意 alert 文本里**不含文件内容**，只有数量与档位：凭据路径本身也可能敏感，
 * 但"有 3 项凭据改动"是用户必须知道的信息，且不泄露内容。
 */
export function buildAlerts(files, candidateId) {
  const dangers = files.filter((item) => item.safety === 'danger')
  if (dangers.length === 0) return []
  return [
    {
      id: `${candidateId ?? 'no-candidate'}:danger`,
      kind: 'danger-change',
      severity: 'danger',
      count: dangers.length,
      /** 命中的路径（供 Client 定位；顺序即 files 顺序） */
      paths: dangers.map((item) => item.path),
      message: `${dangers.length} 项改动命中凭据/本工具自身等敏感路径，内容已省略`,
      hint: '这是一次信息泄露风险提示，不阻断任何操作；批准/拒绝依旧异步。',
    },
  ]
}

/** 快照体积上限：Client 侧 `workspaceFiles.read` 是分页读取，快照必须是有界的 */
const DEFAULT_LIMITS = {
  maxFiles: 40,
  maxLinesPerFile: 60,
  maxLineChars: 240,
  /** 统计用的渲染上限：只为计数，不发给 Client */
  countLines: 4000,
}

/** 与 workspace.mjs 的目录前缀判定保持同一套键（不区分大小写的比较键 + 平台分隔符） */
const childPrefix = (rel) => `${compareKey(rel)}${sep.toLowerCase()}`

export class ReviewService {
  /**
   * @param {{workspaceRoot: string, sessionId?: string, limits?: object, log?: (msg: string) => void}} options
   */
  constructor(options = {}) {
    if (!options?.workspaceRoot) throw new Error('ReviewService: workspaceRoot is required')
    this.workspaceRoot = options.workspaceRoot
    this.sessionId = options.sessionId || 'dsh-host'
    this.limits = { ...DEFAULT_LIMITS, ...(options.limits || {}) }
    this.log = options.log || (() => {})
    /** 可选 logger（由 `staging-fs` 传入 `ctx.logger`）：让"失败必须响"能到 warn/error 级 */
    this.logger = options.logger
    /**
     * 可选**审计镜像**（方向 3）：把 WinStage 的暂存审批写进 DSH 会话审计面
     * （`approval/asked` / `approval/decided`），与原生审批共享同一对事件语义。
     *
     * 为什么是**可选注入**而不是直接持有 `ctx`：本服务刻意保持"纯工作区服务"，
     * 现有 20+ 离线断言都依赖它不依赖任何 DSH 运行时。注入回调让 host 侧接线，
     * 离线测试**不传**⇒ 既有断言逐项不变。
     * 实现见 `dsh-plugin/audit-mirror.mjs`（含回合内校验与"失败不影响审批"）。
     */
    this.audit = options.audit
    /** 清除路径上"回收 / 丢弃失败"的记账（`reject()` / `_rebase()` 复位并随返回值上报） */
    this.clearFailures = []
    this.workspace = new Workspace({
      workspaceRoot: this.workspaceRoot,
      sessionId: this.sessionId,
      // 会话隔离：存储根落到该会话自己的目录；不传时保持 <root>/.dshstage
      ...(options.storeDir ? { storeDir: options.storeDir } : {}),
    })
    this.workspace.init({ origin: 'host-plugin' })
    this.markFresh()
  }

  /**
   * **warn / error 级**日志（§7.3 S11–S14："失败必须响"）。
   *
   * 这些分支以前只用 `this.log`（= `logger.info`）记一句就吞掉，实测表现是"零报错"。
   * 顺序：`logger.warn` → `logger.error` → `console.error`（进程 stderr）。
   */
  logError(message) {
    const line = `[winstage] ${message}`
    const logger = this.logger
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

  /** 清除路径失败的记账：由命令面读出来告诉用户"没清干净" */
  noteClearFailure(entry) {
    if (!Array.isArray(this.clearFailures)) this.clearFailures = []
    this.clearFailures.push(entry)
  }

  /** 记录"我读的是哪一版清单"（mtime 作为便宜的变更戳） */
  markFresh() {
    try {
      this.loadedStamp = statSync(this.workspace.store.manifestPath).mtimeMs
    } catch {
      this.loadedStamp = undefined
    }
    return this.workspace
  }

  /**
   * 读路径用的**便宜**新鲜度检查：清单文件 mtime 未变就不重新读盘。
   *
   * 为什么不每次都 `reload()`：`init()` 会重建清单对象并逐个校验投影，
   * 而 `stat`/`readText` 是被文件工具高频调用的。CLI（另一进程）改动过暂存树时
   * mtime 一定变化，因此这个判据足以避免"读到陈旧副本"。
   */
  fresh() {
    let stamp
    try {
      stamp = statSync(this.workspace.store.manifestPath).mtimeMs
    } catch {
      stamp = undefined
    }
    if (stamp !== this.loadedStamp) {
      this.workspace.init()
      this.markFresh()
    }
    return this.workspace
  }

  /** 每次操作前重读持久状态（CLI 与插件共用一份暂存树） */
  reload() {
    this.workspace.init()
    return this.workspace
  }

  /** 快照文件绝对路径（与暂存清单**同一个存储根**；会话隔离时即该会话的目录） */
  reviewPath() {
    return join(this.workspace.store.dir, REVIEW_BASENAME)
  }

  /**
   * **自愈**：把共享存储（`<root>/.dshstage/`）里已经落下的条目并进本会话的存储。
   *
   * 为什么需要：只要有一次调用拿不到会话身份（旧进程、agentless、initiator 不可读），
   * 内容就会落到共享根，而面板只读自己的会话目录 ⇒ 条目"随 Turn 消失"。这里在**每次
   * 会话级写/命令**上做一次便宜检查（共享 manifest 不存在就零成本返回）：
   *   - 目标还没有 manifest ⇒ 整份搬（rename 优先，失败退回复制）；
   *   - 目标已有 manifest ⇒ 按**条目键**合并（目标优先），blobs/staged 只补缺失的；
   *   - 并完清掉共享 manifest/queue（`candidates` 丢弃：净 diff 会重新冻结）。
   * @returns {number} 并入的条目数（0 = 没有可并的）
   */
  absorbSharedStore() {
    const sharedDir = join(this.workspaceRoot, STORE_DIR)
    const targetDir = this.workspace.store.dir
    try {
      if (canonical(targetDir) === canonical(sharedDir)) return 0 // 本服务就是共享服务
      const sharedManifestPath = join(sharedDir, 'manifest.json')
      if (!existsSync(sharedManifestPath)) return 0
      let shared
      try {
        shared = JSON.parse(readFileSync(sharedManifestPath, 'utf8'))
      } catch {
        return 0
      }
      const sharedEntries = shared && typeof shared.entries === 'object' && shared.entries ? shared.entries : {}
      if (Object.keys(sharedEntries).length === 0) return 0

      mkdirSync(targetDir, { recursive: true })
      const targetManifestPath = join(targetDir, 'manifest.json')
      let target = null
      try {
        target = JSON.parse(readFileSync(targetManifestPath, 'utf8'))
      } catch {
        target = null
      }

      let moved = 0
      if (!target || typeof target !== 'object') {
        // 目标还没有清单：整份搬（同卷 rename 快；失败退回复制）
        for (const name of ['manifest.json', 'queue.json', 'blobs', 'staged', 'staged-ext', 'candidates', 'real', 'private', 'cache']) {
          const from = join(sharedDir, name)
          if (!existsSync(from)) continue
          try {
            renameSync(from, join(targetDir, name))
          } catch {
            copyTreeMissing(from, join(targetDir, name))
          }
          moved += 1
        }
      } else {
        target.entries = target.entries && typeof target.entries === 'object' ? target.entries : {}
        for (const [rel, entry] of Object.entries(sharedEntries)) {
          if (target.entries[rel]) continue
          target.entries[rel] = entry
          moved += 1
        }
        writeFileSync(targetManifestPath, JSON.stringify(target, null, 2))
        copyTreeMissing(join(sharedDir, 'blobs'), join(targetDir, 'blobs'))
        copyTreeMissing(join(sharedDir, 'staged'), join(targetDir, 'staged'))
        copyTreeMissing(join(sharedDir, 'staged-ext'), join(targetDir, 'staged-ext'))
      }

      if (moved > 0) {
        rmSync(sharedManifestPath, { force: true })
        rmSync(join(sharedDir, 'queue.json'), { force: true })
        rmSync(join(sharedDir, 'candidates'), { recursive: true, force: true })
        this.workspace.init()
        this.markFresh()
        this.publish()
        this.log(`已把共享存储里的 ${moved} 条待审并入会话存储：${targetDir}`)
      }
      return moved
    } catch (error) {
      // S11：以前只有 `logger.info`（实测"零报错"）⇒ 现在 warn/error 级
      this.logError(`并入共享存储失败（已忽略）：${error?.message ?? error}`)
      return 0
    }
  }

  /** 变更过暂存树之后：冻结候选并发布快照（供 Client 轮询） */
  afterMutation(reason = 'mutation') {
    let frozenInfo
    try {
      frozenInfo = this.ensureCandidate(reason)
    } catch (error) {
      // S12：以前只有 `logger.info` ⇒ 面板上看不出"这次暂存没有产生候选"
      this.logError(`冻结候选失败（已忽略，暂存内容仍在）：${error.message}`)
    }
    // ★ 方向 3：**新产生**待审候选 ⇒ 向会话审计面写 `approval/asked`。
    //   只在真正新建候选时写（`frozen === true`）：幂等早退（represents 命中）不重复写，
    //   否则每次快照/命令都会刷出新的 asked，把审计面对账搞坏。
    //   审计失败绝不影响暂存（audit-mirror 内部已吞并记 error）。
    if (frozenInfo?.frozen === true) {
      try {
        this.audit?.ask?.({
          candidateId: frozenInfo.candidate?.id,
          fileCount: Array.isArray(frozenInfo.candidate?.changes) ? frozenInfo.candidate.changes.length : undefined,
          reason: `${reason}: 变更已暂存，等待审批`,
        })
      } catch (error) {
        this.logError(`审计镜像 ask 失败（已忽略，不影响暂存）：${error?.message ?? error}`)
      }
    }
    const snapshot = this.publish()
    this.markFresh()
    return snapshot
  }

  /**
   * 把当前净变化冻结成候选（幂等：已由最新待审候选覆盖时不再产生新候选）。
   *
   * 为什么要判重：`freezeCandidate()` 每次调用都会新建候选并**取代**同路径旧待审。
   * 快照与命令是高频调用，若无条件冻结，队列会被无意义地刷屏。
   */
  ensureCandidate(source = 'panel') {
    const ws = this.reload()
    const changes = ws.diffEntries()
    if (changes.length === 0) return { frozen: false, reason: 'no-net-change' }
    const pending = ws.listReviews()
    const latest = pending[pending.length - 1]
    if (latest && this.represents(latest.changes, changes)) return { frozen: false, candidate: latest }
    const frozen = ws.freezeCandidate({ source })
    return { frozen: frozen.enqueued === true, candidate: frozen.candidate }
  }

  /** 最新待审候选是否**恰好**覆盖这批净变化（按路径 + 操作 + 两侧哈希） */
  represents(candidateChanges, changes) {
    if (candidateChanges.length !== changes.length) return false
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

  /**
   * 冻结候选里"已不在当前净 diff、而且磁盘上也不是它要写的内容"的路径
   * → **只读存档行**（实测缺陷 D1 的修法）。
   *
   * ── 为什么需要它（实测）──────────────────────────────────────────────────────
   * `files[]` 过去**只**由 `ws.diffEntries()`（当前净 diff）驱动。于是一个**仍有活的**
   * 候选，只要它的路径后来被从净 diff 里抹掉，它在面板上就**不可见、不可勾、不可批**，
   * 而 `queue.json` 里它仍挂着 `pending`（"空壳 pending"）。实测证据
   * `.t/sbx3/browser/out/s3b2-visibility.txt`：`cs_0005` 的两条路径
   * （`.ssh\id_rsa`、`r3-a.txt`）`panelRenders=no`，而候选状态是 `pending`。
   *
   * ── 收录判据（逐条可核对）────────────────────────────────────────────────────
   * 一条冻结路径进面板，当且仅当**三条同时成立**：
   *   1. 它不在当前净 diff 里（在的话由 `renderChange` 渲染成可批准行）；
   *   2. 它**不是"已经落盘"**。"已经落盘"的路径不需要任何决定，把它再列成"待审"
   *      只会虚报数量、并让"未选路径仍在待审"这类判据失真 —— 实测踩到过：
   *      部分批准之后 `counts.files` 从 1 变成 2（多出一条已落盘的存档行）。
   *      判据用**磁盘真值**（`realHashOf()`）而不是记账字段，因此"另一个候选/手工
   *      把同样内容写好了"也算已落盘；
   *   3. 它仍被某份有活的候选冻结着（`ws.listReviews()`）。
   *
   * ── ⚠ "已经落盘"对**删除类**必须换判据（实测踩到过，必须在报告里留痕）──────────
   * 删除类条目的 `after.hash` 就是 `'absent'` 哨兵，而"文件不存在"的磁盘真值也是
   * `'absent'` ⇒ 拿两者比较会把**删除一个基线本就不存在的对象**判成"已完成"。
   * 这类墓碑正是 `diffEntries()` 刻意跳过的那种（`src/workspace.mjs:786`："删除一个
   * 从未存在的东西不算变化"），于是候选会在面板上**永远消失** —— 这就是实测缺陷 D1
   * 在 3085 现役 fixture 上的真实形态（`cs_0005` 的 `.ssh\id_rsa` / `r3-a.txt` 都是
   * 这种墓碑，manifest 里 `state:"deleted"` + `baseHash:"absent"`）。
   * 因此两分：
   *   - `appliedPaths` 命中（这份候选自己已经应用过它，删除类也适用）⇒ 已落盘；
   *   - **非删除类**才用磁盘比对（磁盘上已经是它要写的内容）⇒ 已落盘。
   *
   * ── 取舍：为什么这些行**不给勾选框**（`frozenOnly: true`）──────────────────────
   *   1. 写入面本来就按**当前净 diff** 过滤路径（`ReviewService.approve()` 在净 diff
   *      为空时早退 + `host-plugin.mjs` 用 `matchPaths(ws.diffEntries(), …)`），
   *      勾一条不在净 diff 里的路径只会得到"没有匹配的待审路径" —— 那是**假操作**，
   *      而"给了勾选框却必然失败"比"标记成不可批准"更糟；
   *   2. 冻结 blob 可能已被回收（`revert()` 会 `rmSync` 暂存对象），要渲染内容就得
   *      额外引入 blob 读取与异常分支；
   *   3. 硬约束是"**绝不让用户在看不到内容的情况下批准**"：这些行的内容既不可保证
   *      也不可写入 ⇒ 只给元数据（路径 / 操作 / 三档）与"已不在净 diff"的标记。
   * 危险档的内容省略策略在这里**同样适用**（`diff: []` + `note`），一行都不例外。
   *
   * ── 代价 ─────────────────────────────────────────────────────────────────────
   * 对"不在净 diff 里"的**非删除类**候选路径各算一次真实文件哈希。只在**发布快照**
   * 时发生（变更/命令），不在 Client 的 1.5 s 轮询路径上；条数被候选数界住。
   *
   * 本方法是**纯读**：不改任何状态。自动 discard 只发生在 `reject()` 这条**变更**路径上
   * （见 `reconcileCandidates()`），因此轮询永远不会写盘。
   */
  frozenOnlyRows(ws, netKeys) {
    const merged = new Map()
    for (const candidate of ws.listReviews()) {
      const appliedKeys = new Set((candidate.appliedPaths || []).map((entry) => compareKey(entry)))
      for (const change of candidate.changes || []) {
        const key = compareKey(change.path)
        if (netKeys.has(key)) continue // 在净 diff 里 ⇒ 已由 renderChange 渲染成可批准行
        const want = change.after?.hash ?? hashAbsent()
        const isDelete = change.op === 'delete' || want === hashAbsent()
        if (appliedKeys.has(key)) continue
        if (!isDelete && this.realHashOf(ws, change) === want) continue
        const verdict = classifyChange(change, { workspaceRoot: this.workspaceRoot, masks: ws.extraMasks })
        const entry = ws.entryOf(change.path)
        // 三种成因，逐条可核对：
        //   reclaimed      清单条目已不在（`revert()`/`pruneEmptyDirs()` 回收过暂存对象）
        //   no-op          条目是"删除一个基线不存在的对象"的墓碑 ⇒ 对真实磁盘没有净变化
        //   no-net-change  条目还在且不是墓碑，但暂存内容与真实基线相同（内容已被取代）
        const frozenReason = !entry ? 'reclaimed' : entry.state === STATE.DELETED ? 'no-op' : 'no-net-change'
        const row = {
          path: change.path,
          op: change.op,
          kind: change.kind === 'dir' ? 'dir' : 'file',
          totals: { added: 0, removed: 0 },
          diff: [],
          truncated: false,
          external: verdict.external,
          risk: verdict.risk,
          safety: verdict.safety,
          riskReason: verdict.riskReason,
          /** D1：本行来自"冻结候选"、已不在当前净 diff ⇒ 面板不得给勾选框 */
          frozenOnly: true,
          frozenReason,
          /** 冻结它的候选（同一路径可被多份候选共享，见 D6） */
          candidateIds: [candidate.id],
        }
        if (verdict.safety === 'danger') row.note = SENSITIVE_OMIT_NOTE
        const prev = merged.get(key)
        if (!prev) {
          merged.set(key, row)
          continue
        }
        prev.candidateIds = [...new Set([...prev.candidateIds, ...row.candidateIds])]
      }
    }
    return [...merged.values()].sort((a, b) => {
      const left = compareKey(a.path)
      const right = compareKey(b.path)
      if (left < right) return -1
      if (left > right) return 1
      return 0
    })
  }

  /** 真实文件当前内容哈希（不存在 / 读不了 / 非普通文件 ⇒ `hashAbsent()`，与 applyOneChange 同口径） */
  realHashOf(ws, change) {
    try {
      const abs = ws.absolute(change.path)
      if (!statSync(abs).isFile()) return hashAbsent()
      return hashFile(abs)
    } catch {
      return hashAbsent()
    }
  }

  /**
   * 当前待审快照（对象形式；Client 读的是它的 JSON 序列化）。
   *
   * ── D1：`files[]` = 净 diff 行（可批准） ∪ 冻结存档行（`frozenOnly`，只显示）──
   * 只渲染净 diff 会让"仍有活的候选"整体消失，于是 `queue.json` 里的 `pending`
   * 变成用户看不见也清不掉空壳。净 diff 行**排在前面**，因此"第一个普通项"仍然是
   * 可批准的那一个（套件与用户的手感都不变）。
   *
   * **D1 不变式**（`fixd_selftest.mjs` 逐候选核对）：对每一份仍有活的候选，
   * 它的每一条冻结路径，要么**已经落盘**（磁盘内容就是它要写的内容 ⇒ 无需决定），
   * 要么在 `files[]` 里有一行。因此"有活候选 = 面板上一定看得见"。
   */
  snapshot(options = {}) {
    const ws = this.reload()
    const changes = ws.diffEntries()
    const pending = ws.listReviews()
    const latest = pending[pending.length - 1]
    const limits = { ...this.limits, ...(options.limits || {}) }

    const netKeys = new Set(changes.map((change) => compareKey(change.path)))
    const netFiles = changes.map((change) => this.renderChange(ws, change, limits))
    const frozenFiles = this.frozenOnlyRows(ws, netKeys)
    const listed = [...netFiles, ...frozenFiles]
    const files = listed.slice(0, limits.maxFiles)
    const additions = files.reduce((sum, f) => sum + f.totals.added, 0)
    const deletions = files.reduce((sum, f) => sum + f.totals.removed, 0)

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      sessionId: ws.manifest?.sessionId,
      candidateId: latest?.id,
      revision: ws.manifest?.revision,
      // 待审 = 面板上有**任何**一行。D1 之前这里只看净 diff：净 diff 一空，面板就整体
      // 卸载，于是队列里的 pending 变成"空壳"（看不到、勾不到、也清不掉）。
      pending: files.length > 0,
      truncated: listed.length > limits.maxFiles || files.some((f) => f.truncated),
      counts: {
        /** 面板实际列出的行数（净 diff 行 + 冻结存档行）——旧版是"净 diff 条数" */
        files: files.length,
        additions,
        deletions,
        /** 净 diff 的条数 = 真正可批准的那部分（旧口径，保留给断言与 CLI） */
        net: changes.length,
        /** 其中"冻结存档行"的条数（只显示、不可批准） */
        frozenOnly: files.filter((f) => f.frozenOnly === true).length,
        /**
         * 其中"基线已过期"的条数：真实文件在暂存之后被外部改动 ⇒ 直接批准会被
         * `STALE_BASELINE` 拒绝。面板据此提示并给出 `/winstage rebase` 的出路。
         * （**只算可批准行**：冻结存档行本来就不可批准，不在这个口径里。）
         */
        staleBaseline: files.filter((f) => f.baselineStale === true).length,
      },
      /** 三档汇总（顶层，供面板显示"共 N 项，其中 M 项在工作区外、K 项敏感"） */
      riskCounts: countRisks(files),
      /**
       * 非阻断性提示（danger 档"报一次"的通道；只给数据，Client 决定怎么呈现）。
       * ⚠ 只按**可批准**的行（净 diff）算：冻结存档行没有任何被写入的可能，
       * 把它们算成"危险改动"会让横幅长期虚报。
       */
      alerts: buildAlerts(netFiles, latest?.id),
      /**
       * 仍有活的候选。`appliedPaths` 是**必需**的：删除类路径的"是否已落盘"只能由
       * "这份候选自己应用过它"判定（`after.hash === 'absent'` 与"文件不存在"同值，
       * 拿磁盘比对会误判），断言侧要复现同一条判据就必须拿到这份记账。
       */
      candidates: pending.map((candidate) => ({
        id: candidate.id,
        status: candidate.status,
        paths: (candidate.changes || []).map((change) => change.path),
        appliedPaths: [...(candidate.appliedPaths || [])],
      })),
      files,
    }
  }

  /**
   * 单条变更 → Client 可直接渲染的项。
   *
   * `totals` 是**真实**增删行数（统计渲染），`diff` 是**有界**的展示片段；
   * 两者刻意分开，避免"截断后的展示"被当成"这就是全部改动"（缺陷 11 的同类错误）。
   *
   * ── 安全设计决定（Lead 已批准）──────────────────────────────────────────────
   * `diff` 承载的是**文件内容片段**。对 `safety:"danger"` 的条目
   * （凭据/密钥/`.dsh`/`.dshstage` 等），默认**不把内容片段写进 review.json** ——
   * 否则等于把凭据渲染进浏览器（快照是普通文件，Client 用
   * `ctx.remote.workspaceFiles.read` 直接读它）。
   *
   * 做法：`diff: []` + `truncated: false` + 顶层 `note` 说明"内容已按敏感策略省略"。
   * `totals`（纯计数）、`path`、`op`、`kind`、`risk`、`safety`、`riskReason` **照常给出**，
   * 面板因此仍能显示"哪个文件、什么操作、为什么敏感、改了多少行"，只是看不到内容。
   *
   * `risk`/`safety`/`riskReason` 这三个字段**在拿到行数之前**就定好了，
   * 所以 danger 条目根本不会为渲染内容而产生任何成本，也不存在
   * "先渲染再丢弃"的中间态。
   */
  renderChange(ws, change, limits) {
    const verdict = classifyChange(change, {
      workspaceRoot: this.workspaceRoot,
      masks: ws.extraMasks,
    })
    const sensitiveOmitted = verdict.safety === 'danger'

    const item = {
      // ── 老字段（向后兼容：一个都不能少、不能改名）──────────────────────
      path: change.path,
      op: change.op,
      kind: change.kind === 'dir' ? 'dir' : 'file',
      totals: { added: 0, removed: 0 },
      diff: [],
      truncated: false,
      // ── 新增字段（Lead 锁定的 review.json 契约）───────────────────────
      external: verdict.external,
      risk: verdict.risk,
      safety: verdict.safety,
      riskReason: verdict.riskReason,
    }
    // ── 基线漂移（"多轮修改后视图不一致"的根因）──────────────────────────────
    // `applyOneChange()` 在真实文件偏离 **候选冻结的 before** 时以 STALE_BASELINE 拒绝
    // 落盘（手册 #12.1）。旧面板不显示这件事：用户看到一条可点的"批准"，点了必然失败。
    // 这里把**同一处真值**（`change.before.hash` vs 真实文件当前 hash）搬进快照，
    // 面板据此标"基线已过期"，并给出 `/winstage rebase` 的出路。
    // 目录行（mkdir）不参与：`applyOneChange` 对它的判据是 hashAbsent 之间的比较。
    if (item.kind !== 'dir') {
      const expected = change.before?.hash ?? hashAbsent()
      const found = this.realHashOf(ws, change)
      if (found !== expected) {
        item.baselineStale = true
        item.baseline = { expected, found }
      }
    }
    // 敏感省略说明：**只有** danger 档才有这个字段（`undefined` 在 JSON.stringify 里整键消失，
    // 面板因此可以用 `'note' in item` 判断，不需要猜空串含义）
    if (sensitiveOmitted) item.note = SENSITIVE_OMIT_NOTE

    if (item.kind === 'dir') return item

    const candidateLike = { changes: [change] }
    const all = renderCandidateDiff(ws.store, candidateLike, { maxLines: limits.countLines })
    for (const line of all) {
      if (line.type === 'add') item.totals.added += 1
      else if (line.type === 'remove') item.totals.removed += 1
    }

    // 凭据/密钥类：**计数照给，内容不给**（`truncated` 保持 false —— 内容不是被截断，
    // 而是策略上有意不给，两个语义不能混）
    if (sensitiveOmitted) return item

    for (const line of all) {
      if (line.type === 'change-header' || line.type === 'note') continue
      if (item.diff.length >= limits.maxLinesPerFile) {
        item.truncated = true
        break
      }
      const text = String(line.text ?? '')
      item.diff.push({
        type: line.type,
        line: line.line,
        text: text.length > limits.maxLineChars ? `${text.slice(0, limits.maxLineChars)}…` : text,
      })
    }
    return item
  }

  /**
   * 原子写出快照（先写临时文件再 rename，Client 绝不会读到半个 JSON）。
   *
   * ★ 复用 `src/store.mjs` 的 `writeFileAtomic()`，**不再自写一份**：
   *   本函数原先用 `${target}.tmp-${process.pid}` 手写 tmp + `renameSync`，
   *   而那条路径**没有**失败清理 —— 实测在盘上留下过
   *   `review.json.tmp-6892`（1329 B）残骸：`rename` 抛 `EPERM` 后 tmp 无人回收
   *   （对比：`store.mjs:107-121` 的 `writeFileAtomic()` 在 rename 失败时会
   *   `unlinkSync(tmp)` 再抛）。同一件事两种口径 ⇒ 审批侧的提交失败会**污染 store**。
   *   `publish()` 有 6 个调用点（本文件 :432/:451/:807/:866/:936 + `host-plugin.mjs:239`），
   *   收口到一处即全部修好。
   *
   * 语义变化**只有**"失败时不留 tmp"：原错误照旧上抛（不吞、不降级），
   * 因此调用方与断言对错误路径的观察不变。
   */
  publish() {
    const snapshot = this.snapshot()
    writeFileAtomic(this.reviewPath(), JSON.stringify(snapshot))
    return snapshot
  }

  /**
   * 批准：把候选（可只选部分路径）写进真实工作区。
   * 逐文件条件检查由 `applyCandidate` 承担：真实文件自暂存以来被外部改动 →
   * 该文件 `STALE_BASELINE` 失败，而不是静默覆盖（手册 #12.1）。
   */
  approve(paths, options = {}) {
    this.reload()
    // `rebase: true`：批准前先把"基线已过期"的条目重新对齐到真实文件。
    // 这是**显式**动作（`/winstage approve --rebase` / 面板按钮）；默认路径仍然按
    // 手册 #12.1 拒绝覆盖外部改动，绝不静默改语义。
    const rebaseResult = options.rebase === true ? this._rebase(paths) : undefined
    const rebased = rebaseResult ? rebaseResult.rebased : []
    // S13/S14：`--rebase` 也会走候选对账 ⇒ 没清干净的必须随返回值上报（新增键）
    const clearFailures = rebaseResult && Array.isArray(rebaseResult.failures) ? rebaseResult.failures : []
    if (this.workspace.diffEntries().length === 0) {
      return { ok: true, approved: 0, failed: [], remaining: [], rebased, failures: clearFailures, message: '没有待审文件' }
    }
    this.ensureCandidate('approve')
    const ws = this.reload()
    const pending = ws.listReviews()
    const latest = pending[pending.length - 1]
    if (!latest) {
      return { ok: true, approved: 0, failed: [], remaining: [], rebased, failures: clearFailures, message: '没有待审候选' }
    }
    const result = ws.applyCandidate(latest.id, {
      paths,
      force: options.force === true,
      // 命中敏感策略时的**二次确认**（面板弹窗 / `/winstage approve --confirm-mask`）
      ...(options.confirmedMasks !== undefined ? { confirmedMasks: options.confirmedMasks } : {}),
    })
    this.publish()
    this.markFresh()
    // ★ 方向 3：**只有在这一批全部落盘成功**时才写 `approval/decided`。
    //   部分失败（`failed.length > 0`）⇒ 候选仍 pending，此时写 decided 会让
    //   审计对**提前闭合**，与 review.json 的 `pending` 说法相反 —— 那正是
    //   "账本对不上"的新来源。所以：失败 ⇒ 不闭合，留待下一次决定。
    if (result.failed.length === 0) {
      try {
        this.audit?.decide?.({
          candidateId: result.id,
          approved: true,
          pathCount: result.applied.length,
        })
      } catch (error) {
        this.logError(`审计镜像 decide 失败（已忽略，不影响批准）：${error?.message ?? error}`)
      }
    }
    return {
      ok: result.failed.length === 0,
      candidate: result.id,
      approved: result.applied.length,
      failed: result.failed,
      remaining: result.remaining,
      rebased,
      // 新增键（只加不改）
      failures: clearFailures,
      message:
        result.failed.length === 0
          ? `已应用 ${result.applied.length} 项`
          : `已应用 ${result.applied.length} 项，失败 ${result.failed.length} 项`,
    }
  }

  /**
   * 内部：把基线已过期的条目重新对齐到真实文件（**不** publish）。
   *
   * 对齐后必须**重新冻结候选**：旧候选里每条 change 的 `before/after` 都是旧基线的
   * 快照，继续用它去批准仍会 STALE_BASELINE、diff 也还是错的。因此：
   *   1. 命中的候选整份 discard（`reconcileCandidates` 的 `affected` 规则，
   *      与 D2 的"discard 范围必须与回收范围一致"同一条纪律）；
   *   2. 剩下的净 diff 用 `ensureCandidate('rebase')` 重新冻结成新候选。
   * @returns {{rebased: string[], discarded: string[]}}
   */
  _rebase(paths) {
    this.clearFailures = []
    const ws = this.reload()
    const selected = paths && paths.length > 0 ? new Set(paths.map(compareKey)) : undefined
    const rebased = []
    for (const rel of Object.keys(ws.manifest.entries)) {
      if (selected && !selected.has(compareKey(rel))) continue
      if (!ws.baselineDrift(rel).stale) continue
      if (ws.rebaseEntry(rel)) rebased.push(rel)
    }
    if (rebased.length === 0) return { rebased, discarded: [], failures: [] }
    ws.store.touch(ws.manifest)
    const affected = new Set(rebased.map(compareKey))
    const netKeys = new Set(ws.diffEntries().map((change) => compareKey(change.path)))
    const discarded = this.reconcileCandidates(ws, { reason: 'rebase', affected, netKeys })
    if (ws.diffEntries().length > 0) this.ensureCandidate('rebase')
    return { rebased, discarded, failures: this.clearFailures.slice() }
  }

  /**
   * 以真实文件为基线重新暂存（`/winstage rebase [路径…]`）。
   *
   * 为什么不自动做：`STALE_BASELINE` 是**故意的**安全闸（手册 #12.1）——它保证
   * "被外部改动过的文件不会被悄悄覆盖"。rebase 把基线换成现实、同时把真实内容
   * 放进 diff 的 before（用户看得见自己将要替换什么），是显式、可复核的出路，
   * 而不是把闸门删掉。
   *   - 不给路径 = 对所有基线过期的条目生效；
   *   - 真实内容恰好等于暂存内容时，该条目变成"无净变化"，自动退出视图。
   */
  rebase(paths) {
    const result = this._rebase(paths)
    const snapshot = this.publish()
    this.markFresh()
    return {
      ok: true,
      rebased: result.rebased,
      discarded: result.discarded,
      // 新增键（只加不改）：清除路径上"没清干净"的项
      failures: Array.isArray(result.failures) ? result.failures : [],
      remaining: snapshot.counts.net,
      message:
        result.rebased.length === 0
          ? '没有基线过期的待审条目（视图已经与真实磁盘一致）'
          : `已以真实文件为基线重新暂存 ${result.rebased.length} 项`,
    }
  }

  /**
   * 拒绝：把这些路径的暂存改动**退回真实磁盘视图**（不是删文件）。
   *
   * ── 语义（逐条，含 D2 修好之后的行为）────────────────────────────────────────
   *   - 删除清单条目 + 回收暂存对象 → 读取重新落到真实文件；
   *   - **discard 的范围必须与回收的范围一致（实测缺陷 D2）**：旧实现对全部净 diff
   *     路径做 `revert()`，却只 `discardCandidate(latest)` ⇒ 其它"被回收光了暂存内容"
   *     的候选留在 `queue.json` 里当 `pending`（本轮 `cs_0002` 就是 host 事后补 discard 的）。
   *     现在改为：**所有受本次拒绝影响、或已经失去全部可审内容的候选一并 discard**
   *     （`reconcileCandidates()`），因此拒绝之后**不会再留下空壳 pending**；
   *   - 仍有暂存内容的剩余改动重新冻结成**一份新候选**，否则被拒绝的路径仍留在候选里，
   *     下次批准会把它又写回去（#12.2 的反例）；
   *   - **拒绝全部（未给路径）= 清空全部暂存 + 终结全部候选**。因此它之后
   *     `pending=false` ⇒ **面板整体卸载是设计，不是缺陷**（没有任何东西可审了）。
   *     旧版"只 discard 最新候选"会让面板先卸载、队列里却留着 pending —— 那才是缺陷。
   *   - 给了路径时只影响这些路径所属的候选；其余候选照旧留在面板上。
   */
  reject(paths) {
    this.clearFailures = []
    const ws = this.reload()
    const changes = ws.diffEntries()
    const netKeys = new Set(changes.map((change) => compareKey(change.path)))
    const liveBefore = ws.listReviews()
    const selected = paths && paths.length > 0 ? new Set(paths.map(compareKey)) : undefined

    // 净 diff 已经空了、但队列里还有活候选时**不能**早退：那些候选正是"空壳 pending"，
    // 而"拒绝全部"是用户唯一能清掉它们的出口（否则面板会停在只有冻结存档行的状态里）。
    if (!selected && changes.length === 0 && liveBefore.length === 0) {
      return { ok: true, rejected: 0, paths: [], discarded: [], message: '没有待审文件' }
    }

    const targets = selected ? changes.filter((c) => selected.has(compareKey(c.path))) : changes
    // 受影响集合 = 本次要回收的净 diff 路径 ∪ 被点名的"冻结但已不在净 diff"的路径。
    // 「拒绝全部」时 = 净 diff + 所有候选的冻结路径（即"全部"），因此不会有候选被漏掉。
    const affected = new Set(selected || netKeys)
    if (!selected) {
      for (const candidate of liveBefore) {
        for (const change of candidate.changes || []) affected.add(compareKey(change.path))
      }
    } else {
      const touchesCandidate = liveBefore.some((candidate) =>
        (candidate.changes || []).some((change) => selected.has(compareKey(change.path))),
      )
      if (targets.length === 0 && !touchesCandidate) {
        return { ok: true, rejected: 0, paths: [], discarded: [], message: '所选路径没有待审改动' }
      }
    }

    for (const change of targets) this.revert(ws, change.path)
    ws.store.touch(ws.manifest)

    const discarded = this.reconcileCandidates(ws, { reason: 'user-rejected', affected, netKeys })
    if (ws.diffEntries().length > 0) this.ensureCandidate('reject-remaining')

    this.publish()
    this.markFresh()
    // ★ 方向 3：拒绝完成 ⇒ 闭合审计对（`approval/decided`, outcome='rejected'）。
    //   要闭合的是"**被本次拒绝影响的候选**"，不只是被 discard 的那些：
    //   给了具体路径时，候选可能仍然 pending（其余路径还在），但针对这些路径的
    //   那一次询问已经由用户作结了 —— 所以按 `affected` 命中的候选逐个闭合。
    //   用 `undefined` 当 id 会写出 `winstage:unknown`，那是新的孤儿来源，必须避免。
    try {
      const affectedKeys = affected instanceof Set ? affected : new Set()
      const closedIds = new Set(Array.isArray(discarded) ? discarded : [])
      for (const candidate of liveBefore) {
        const hit = (candidate.changes || []).some((change) => affectedKeys.has(compareKey(change.path)))
        if (hit) closedIds.add(candidate.id)
      }
      for (const candidateId of closedIds) {
        this.audit?.decide?.({ candidateId, approved: false, note: 'user-rejected' })
      }
    } catch (error) {
      this.logError(`审计镜像 reject-decide 失败（已忽略，不影响拒绝）：${error?.message ?? error}`)
    }
    // `failures` 是**新增键**（只加不改）：清除路径上"没清干净"的项，命令面据此报 error
    return { ok: true, rejected: targets.length, paths: targets.map((c) => c.path), discarded, failures: this.clearFailures.slice() }
  }

  /**
   * 候选对账（D2）：把**已经没有可审内容**的候选一并 `discard`，让 discard 的范围
   * 与暂存回收的范围一致。
   *
   * 判据（两条，任一命中即终结该候选；两条都只依赖 host 侧真值）：
   *   1. `affected` 命中：候选的某条冻结路径正是本次被拒绝的路径 —— 候选的冻结清单
   *      已经与现实不符，而产品没有"从候选里摘掉一条 change"的 API，只能整份终结
   *      （剩下的净 diff 路径会由 `ensureCandidate('reject-remaining')` 重新冻结）；
   *   2. 已经是空壳：候选的**每一条**冻结路径都不在当前净 diff 里 ⇒ 它一条都批不了
   *      （写入面按净 diff 过滤），留着只会污染"待审数"口径。
   *
   * 只在**变更路径**（`reject()`）调用：轮询只读路径绝不改状态。
   */
  reconcileCandidates(ws, options = {}) {
    const netKeys = options.netKeys || new Set(ws.diffEntries().map((change) => compareKey(change.path)))
    const affected = options.affected
    const reason = options.reason || 'no-stageable-paths'
    const discarded = []
    for (const candidate of ws.listReviews()) {
      const keys = (candidate.changes || []).map((change) => compareKey(change.path))
      if (keys.length === 0) continue
      const touched = affected ? keys.some((key) => affected.has(key)) : false
      const noStageable = keys.every((key) => !netKeys.has(key))
      if (!touched && !noStageable) continue
      try {
        ws.discardCandidate(candidate.id, { reason })
        discarded.push(candidate.id)
      } catch (error) {
        // S13：这正是**清除路径** —— 以前只记一句 info 就吞掉，用户永远不知道"没清掉"
        this.logError(`候选对账：丢弃 ${candidate.id} 失败：${error.message}`)
        this.noteClearFailure({ candidateId: candidate.id, code: 'ECANDIDATE_DISCARD_FAILED', message: error.message })
      }
    }
    return discarded
  }

  /** 解除一个路径的暂存引用并回收其暂存对象（先落状态、再回收，#13.1） */
  revert(ws, rel) {
    const entry = ws.entryOf(rel)
    if (!entry) return false
    const stagedPath = ws.staged(rel)
    delete ws.manifest.entries[rel]
    if (existsSync(stagedPath)) {
      try {
        makeRemovable(stagedPath)
        rmSync(stagedPath, { recursive: true, force: true })
      } catch (error) {
        // S14：也是**清除路径** —— 清单条目已删、暂存对象却没回收，必须能上报
        this.logError(`回收暂存对象失败 ${rel}：${error.message}`)
        this.noteClearFailure({ path: rel, code: 'ESTAGED_RECLAIM_FAILED', message: error.message })
      }
    }
    // 父目录条目若因此变成"没有暂存子项的目录"，一并撤掉，避免投影里出现幽灵目录
    this.pruneEmptyDirs(ws)
    return true
  }

  pruneEmptyDirs(ws) {
    let removed = 0
    for (const [rel, entry] of Object.entries(ws.manifest.entries)) {
      if (entry.kind !== 'dir') continue
      const prefix = childPrefix(rel)
      const hasChild = Object.keys(ws.manifest.entries).some((other) => other !== rel && compareKey(other).startsWith(prefix))
      if (hasChild) continue
      if (existsSync(ws.absolute(rel))) continue
      delete ws.manifest.entries[rel]
      removed += 1
    }
    return removed
  }
}

/**
 * 进程内单例：`winstage-sandbox`（命令面）与 `winstage-fs`（暂存文件系统）
 * 是**两个 loader 行**、两个模块实例，必须共享同一份清单对象，
 * 否则两行各自持有内存副本，谁的写都会被对方的 `fresh()` 当成"外部改动"重读。
 */
const SERVICES = new Map()

/**
 * FNV-1a（32 位，纯 JS、同步）—— 只用于把**非常规字符**的会话 id 压成目录名。
 * client.js 里有同名切片函数（`#region session-key`），两者必须逐字一致，
 * `.t/session-key-selftest.mjs` 用同一组输入断言它们相等。
 */
function fnv1a32(text) {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 会话 id → **存储目录名**。
 *
 * 常规 id（`session-<uuid>`）逐字使用；含可疑字符/过长时压成 `s_<fnv>_<len>`，
 * 因此永远只会产生一个安全的单层目录名，不会出现路径穿越。
 * @param {unknown} sessionId
 * @returns {string} 目录名；无会话身份时返回 `''`（= 共享存储）
 */
export function sessionDirKey(sessionId) {
  const raw = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (raw.length === 0) return ''
  if (/^[A-Za-z0-9._-]{1,64}$/.test(raw)) return raw
  return `s_${fnv1a32(raw)}_${raw.length}`
}

/** 某会话的存储根（无会话身份时返回 undefined ⇒ 调用方用默认 `<root>/.dshstage`） */
export function sessionStoreDir(workspaceRoot, sessionId) {
  const key = sessionDirKey(sessionId)
  return key ? join(workspaceRoot, STORE_DIR, 'sessions', key) : undefined
}

/**
 * 把**升级前**的共享存储（`<root>/.dshstage/`）认领给第一个需要会话存储的会话。
 *
 * 为什么需要：隔离改造之前，所有暂存内容都写在共享根里。不搬的话，用户升级前
 * 的待审内容会变成"谁也看不见"的孤儿。做法是 **move**（同卷 rename，不复制大文件），
 * 并用 `.dshstage/sessions/.legacy-claimed` 的 `wx` 创建做"只有第一个会话能认领"的闸。
 * 任何一步失败都静默保留原处（会话拿空存储继续跑），绝不因此让插件起不来。
 * @returns {boolean} 是否真的搬走了一些东西
 */
function adoptLegacyStore(workspaceRoot, targetDir) {
  try {
    const legacyDir = join(workspaceRoot, STORE_DIR)
    const legacyManifest = join(legacyDir, 'manifest.json')
    if (!targetDir || !existsSync(legacyManifest) || existsSync(targetDir)) return false
    const claimDir = join(legacyDir, 'sessions')
    mkdirSync(claimDir, { recursive: true })
    try {
      writeFileSync(join(claimDir, '.legacy-claimed'), '', { flag: 'wx' })
    } catch {
      return false // 已经有别的会话认领过
    }
    mkdirSync(targetDir, { recursive: true })
    let moved = 0
    for (const name of ['manifest.json', 'queue.json', 'blobs', 'staged', 'staged-ext', 'candidates', 'real', 'private', 'cache']) {
      const from = join(legacyDir, name)
      if (!existsSync(from)) continue
      try {
        renameSync(from, join(targetDir, name))
        moved += 1
      } catch {
        /* 单个条目搬不动（可能被占用）⇒ 留在原处，不阻断 */
      }
    }
    return moved > 0
  } catch {
    return false
  }
}

/**
 * 纯文件操作：把 `src` 里**目标不存在**的文件复制过去（blobs/staged 都是内容寻址或按键
 * 物化，覆盖没有意义）。目录不存在就建；任何单个文件失败都跳过（自愈绝不抛出）。
 */
function copyTreeMissing(src, dst) {
  let info
  try {
    info = statSync(src)
  } catch {
    return
  }
  if (info.isDirectory()) {
    mkdirSync(dst, { recursive: true })
    let names = []
    try {
      names = readdirSync(src)
    } catch {
      return
    }
    for (const name of names) copyTreeMissing(join(src, name), join(dst, name))
    return
  }
  if (!info.isFile() || existsSync(dst)) return
  try {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
  } catch {
    /* 单个文件失败不影响其余 */
  }
}

export function getReviewService(options = {}) {
  if (!options?.workspaceRoot) throw new Error('getReviewService: workspaceRoot is required')
  const root = canonical(options.workspaceRoot)
  const sessionKey = sessionDirKey(options.sessionId)
  const key = sessionKey ? `${root}#${sessionKey}` : root
  let service = SERVICES.get(key)
  if (!service) {
    const storeDir = sessionKey ? join(root, STORE_DIR, 'sessions', sessionKey) : undefined
    // T3d：`adoptLegacyStore()` 与 `absorbSharedStore()` 是**同一类"认领别处内容"**的动作
    // （前者=目标会话目录还不存在时整份 move，后者=已存在时按键合并）。实测：在"共享存储里有
    // 别身份的内容 + 本会话目录还不存在"这一最常见形态下，真正搬走内容的是**前者**，所以
    // 只在 absorb 上加开关是无效的 —— 两处都必须受 `claimShared` 管。
    if (storeDir && options.claimShared !== false) adoptLegacyStore(root, storeDir)
    service = new ReviewService({ ...options, workspaceRoot: root, storeDir })
    SERVICES.set(key, service)
  } else if (options.log && !service.log) {
    service.log = options.log
  }
  // 后到的调用方补 logger（`staging-fs` 传的是 `ctx.logger`）：只补不覆盖
  if (options.logger && !service.logger) service.logger = options.logger
  // 自愈：任何"拿到会话身份"的入口都会把共享存储里积下的条目并进来（不存在则零成本）
  //
  // T3d：**自愈只在"沙箱此刻接管"时发生**。调用方通过 `claimShared: false` 表达"模式开关是关" ⇒
  // 不认领、不搬移、不删共享清单：内容留在共享存储里，由共享/agentless 面负责，
  // **绝不会变成本会话里可批准（进而可落盘）的条目**。
  // 默认仍为认领，因此"启用态"的既有自愈语义与 `.t/session-isolation-selftest.mjs` §8 一字不变。
  if (sessionKey && options.claimShared !== false && typeof service.absorbSharedStore === 'function') service.absorbSharedStore()
  return service
}
