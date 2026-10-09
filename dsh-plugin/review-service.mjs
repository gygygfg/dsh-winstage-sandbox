/**
 * WinStage 审阅服务（Host 侧）——把项目自有的「暂存—候选—选择性提交」接进 DSH。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────────────
 * 暂存树（Phase 1 起位于 **Windows 缓存**里的会话工作根，见 `src/stage-guard.mjs`）
 * 里的变化必须有一个**权威的读侧与决定侧**：
 *   - 读侧：把"当前待审了什么"渲染成一份快照；
 *   - 决定侧：批准（写进真实工作区）或拒绝（把投影退回真实磁盘）。
 * 两者都走项目自有的 `Workspace`，因此与手工 CLI（`run.cmd`）**共用同一份状态**，
 * 不会出现"CLI 说有待审、面板说没有"的漂移。
 *
 * ── Client 怎么读到快照（这里有一个必须如实说明的机制约束）────────────────────
 * Client **无法**注册新的 `ctx.remote.<命名空间>`：`@deepseek-ai/dsh-api-remotes`
 * 的能力选集是**构建时固定**的（其 README 逐字："Client 不会在运行时发现 Host 中
 * 已启用的服务或 Remote 定义"）。因此本服务用两条**已有的**通道供数：
 *   1. 读：把快照写成**本会话存储根**下的 `review.json`（Phase 1 起该根由
 *      `resolveStageRoot()` 解析，默认在 Windows 缓存里；见 `reviewPath()`），
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
import { resolveStageRoot } from '../src/stage-guard.mjs'
import { Workspace, driftReasonOf } from '../src/workspace.mjs'
import { renderCandidateDiff } from '../src/tools.mjs'
import { REGISTRY_CANDIDATE_SOURCE, createRegistryStage, registryWireBytes } from '../src/registry-stage.mjs'
import { createRegExeReader, createRegExeWriter } from '../src/registry-bindings.mjs'

/**
 * 该候选是不是**注册表**候选（`src/registry-stage.mjs::freezeCandidate()` 的产物）。
 *
 * 判据用两个字段的并集，刻意不只看一个：`origin` 是 T3 的候选契约字段，
 * `source` 是同一份契约里写进 `queue.json` 的那一个。历史上本仓库栽过
 * "只认一个字段 ⇒ 另一条路径的产物被静默当成文件候选"（`registry-stage.mjs:2606`
 * 记的正是"沙箱内写成功"与"面板看得到"断成两半那次）。
 */
export function isRegistryCandidate(candidate) {
  return (
    candidate !== null &&
    typeof candidate === 'object' &&
    (candidate.origin === 'registry' || candidate.source === REGISTRY_CANDIDATE_SOURCE)
  )
}

/** 快照文件名（与暂存清单**同一个存储根**，见 `reviewPath()`） */
export const REVIEW_BASENAME = 'review.json'

/**
 * 自动对准基线（`autoRebaseDrifted()`）的最小间隔。
 *
 * `reload()` 在 fs 面的每次操作上都会跑，而"基线漂移"要逐条 stat+hash 真实文件；
 * 1 s 的节流让"漂移后立刻对齐"与"别为每次读都付这个钱"同时成立。
 * `autoRebaseDrifted({ force: true })` 绕过节流（自测/人工诊断）。
 */
const AUTO_REBASE_INTERVAL_MS = 1000

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
  SELF_MASK_ID, // 'stage-store' → 本工具自身的存储树（遮蔽表里那条 hard 规则）
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

// ═══════════════════════════════════════════════════════════════════════════
// WP2：存储根的**唯一切换点**（Phase 1）
// ═══════════════════════════════════════════════════════════════════════════
//
// Phase 1 起，生产默认存储根**不再**是工作区内的 `<workspaceRoot>/<STORE_DIR>`，
// 而是 `src/stage-guard.mjs::resolveStageRoot()` 给出的 **Windows 缓存**路径
// （默认 `%LOCALAPPDATA%\Temp\winstage-stage\<会话键>`）。
//
// 本函数是 `review-service.mjs` 里**唯一**拼存储根的地方：`getReviewService()`、
// `sessionStoreDir()`、`ReviewService.reviewPath()` / `absorbSharedStore()` 全部经它。
// 因此"某处还在拼旧布局"这种漂移在结构上只可能出现在这一个函数里。
//
// 显式 override 通道（保留给自测 / CLI / WP1）优先级：`storeDir` > `stageRoot` > 默认。
// ⚠ `env` 只影响 `stageBaseDir(env)` 的基目录；生产路径**不传**（用宿主进程 env）。
export function resolveReviewStoreDir({ workspaceRoot, sessionId, storeDir, stageRoot, env } = {}) {
  if (storeDir !== undefined && storeDir !== null && String(storeDir).trim() !== '') {
    return String(storeDir)
  }
  return resolveStageRoot({
    // 无会话身份时用**共享服务**的会话 id（与 `ReviewService` 构造函数的默认值同源），
    // 这样"共享服务写在哪"与"它自己的快照发布在哪"必然是同一个目录。
    sessionKey: sessionDirKey(sessionId) || DEFAULT_REVIEW_SESSION_ID,
    workspaceRoot,
    env,
    override: stageRoot,
  })
}

/** 升级前的**旧布局**存储根（工作区内的 `<workspaceRoot>/<STORE_DIR>`）。
 *
 * Phase 1 之后这个位置**只读/只搬走**（`adoptLegacyStore()` / `absorbSharedStore()`），
 * 任何写入路径都不再解析到它 —— 所以它不经过 `resolveStageRoot()`（那会把它指向新根，
 * 旧内容就永远搬不过来了）。名字里带 `legacy` 是刻意的：出现"这里怎么还在工作区里"
 * 的疑问时，答案就是这一句。
 */
export function legacyWorkspaceStoreDir(workspaceRoot) {
  return join(String(workspaceRoot), STORE_DIR)
}

// ═══════════════════════════════════════════════════════════════════════════
// WP4：读侧可见性（**默认只记不拦**）
// ═══════════════════════════════════════════════════════════════════════════
//
// 登记表放在本模块而不是 `staging-fs.mjs`，理由是所有权：`review.json` 的**唯一写入者**
// 是 `ReviewService.publish()`，读侧计数要进快照就必须与快照同一个所有者。
// `staging-fs.mjs` 只**喂**（`recordReadVisibility()`），不持有状态 ⇒
// "计数在 A、快照在 B"这种漂移形态结构上不可能发生。
//
// 去重键 = `maskId + maskKey`（**不是**逐次记录）：同一个敏感对象被读 N 次只留**一条**
// 计数，因此"读一百次"既不产生一百条记录，也不会刷一百条提示（用户侧提示按
// **新命中的 mask 类**至多发一条，上限 = 遮蔽表条目数）。
//
// ⚠ 诚实声明（必须随快照一起给用户看）：这是**黑名单**，不是边界。
//   只记录"本插件真的读到 / 经本入口看到的"路径；换个名字、换条通道就读不到了。

export const READ_POLICIES = Object.freeze(['record', 'block'])
export const DEFAULT_READ_POLICY = 'record'

/**
 * 共享（无会话身份）服务的会话 id。
 * 必须与 `ReviewService` 构造函数的兜底值**逐字一致**：否则"没身份的那次读"记在
 * `shared` 桶里，而快照（由 `dsh-host` 那个服务发布）永远是空的 —— 计数与快照分家。
 */
export const DEFAULT_REVIEW_SESSION_ID = 'dsh-host'

/** 读侧可见性登记表的最大条目数（超出只累计 `reads`，不再新增条目；防巨目录把快照撑爆） */
const MAX_READ_VISIBILITY_KEYS = 200

/** 会话键 → `{ key, policy, reads, byKey: Map<dedupKey, item>, notices: Set<maskId> }` */
const READ_VISIBILITY = new Map()

/** 会话 id → 登记表键（与存储根同一个来源：`sessionDirKey()`） */
export function readVisibilityKey(sessionId) {
  return sessionDirKey(sessionId) || DEFAULT_REVIEW_SESSION_ID
}

function visibilityEntry(sessionId, policy) {
  const key = readVisibilityKey(sessionId)
  let entry = READ_VISIBILITY.get(key)
  if (!entry) {
    entry = { key, policy: DEFAULT_READ_POLICY, reads: 0, byKey: new Map(), notices: new Set() }
    READ_VISIBILITY.set(key, entry)
  }
  if (policy !== undefined && READ_POLICIES.includes(policy)) entry.policy = policy
  return entry
}

/** 登记/更新本会话的读策略（`staging-fs` 在装配时登记一次；快照据此如实说明档位） */
export function setReadVisibilityPolicy(sessionId, policy) {
  return visibilityEntry(sessionId, policy).policy
}

export function getReadVisibilityPolicy(sessionId) {
  return visibilityEntry(sessionId).policy
}

/**
 * 记一次**命中遮蔽表**的读（只记不拦时由 `staging-fs.mjs` 的读入口调用）。
 *
 * @param {{sessionId?: string, maskId: string, maskKey: string, reason?: string, op?: string}} input
 * @returns {{dedupKey: string, maskId: string, reads: number, firstForMaskId: boolean, dropped: boolean}}
 *   `firstForMaskId === true` ⇒ 调用方可以发**一条**用户侧合并提示（同一个 mask 类只发一次）。
 */
export function recordReadVisibility(input = {}) {
  const entry = visibilityEntry(input.sessionId)
  const maskId = String(input.maskId ?? 'unknown')
  const key = String(input.maskKey ?? '')
  const dedupKey = `${maskId}\u0000${key.toLowerCase()}`
  entry.reads += 1
  const existing = entry.byKey.get(dedupKey)
  if (existing) {
    existing.reads += 1
    existing.lastAt = new Date().toISOString()
    if (input.op && !existing.ops.includes(input.op)) existing.ops.push(input.op)
    return { dedupKey, maskId, reads: existing.reads, firstForMaskId: false, dropped: false }
  }
  if (entry.byKey.size >= MAX_READ_VISIBILITY_KEYS) {
    return { dedupKey, maskId, reads: 1, firstForMaskId: false, dropped: true }
  }
  const now = new Date().toISOString()
  entry.byKey.set(dedupKey, {
    maskId,
    path: key,
    reason: input.reason,
    reads: 1,
    ops: input.op ? [input.op] : [],
    firstAt: now,
    lastAt: now,
  })
  const firstForMaskId = !entry.notices.has(maskId)
  if (firstForMaskId) entry.notices.add(maskId)
  return { dedupKey, maskId, reads: 1, firstForMaskId, dropped: false }
}

/** 该会话的读侧可见性快照（放进 `review.json` 的 `readVisibility` 段；纯读） */
export function readVisibilitySnapshot(sessionId) {
  const entry = visibilityEntry(sessionId)
  const byMaskId = {}
  const items = []
  for (const item of entry.byKey.values()) {
    byMaskId[item.maskId] = (byMaskId[item.maskId] ?? 0) + 1
    items.push({
      maskId: item.maskId,
      path: item.path,
      reason: item.reason,
      reads: item.reads,
      ops: [...item.ops],
      firstAt: item.firstAt,
      lastAt: item.lastAt,
    })
  }
  items.sort((a, b) => (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : 0))
  return {
    policy: entry.policy,
    /** 去重后的"敏感对象"条数（去重键 = `maskId + maskKey`） */
    objects: entry.byKey.size,
    /** 未去重的读取次数（同一个对象读 N 次就 +N，但**不**新增条目） */
    reads: entry.reads,
    /** 是否因为条目上限而不再新增条目（只累计 `reads`）—— 如实标注，不假装计数完整 */
    truncated: entry.byKey.size >= MAX_READ_VISIBILITY_KEYS,
    byMaskId,
    items,
    note: '读侧可见性：只记录、不改写读结果（默认 readPolicy=record）。这是黑名单式的记录，不是读边界。',
  }
}

/** 清空某会话的读侧可见性登记（自测用；生产路径不调用） */
export function resetReadVisibility(sessionId) {
  READ_VISIBILITY.delete(readVisibilityKey(sessionId))
}

/**
 * 基线漂移**形状** —— 直接复用 `src/workspace.mjs` 的实现，**不再写第二份**。
 *
 * 值的来源必须唯一：`Workspace.baselineDrift().reason`（面板与批准前的诊断用它）与
 * 快照渲染用的 `change.before.hash vs 真实 hash`（渲染层用它）判的是同一件事，
 * 两处若各写一份 `if/else`，迟早会出现"面板说 appeared、批准说 drifted"。
 * 这里 re-export 给 `review-service.mjs` 的使用者（host/client 断言）同一入口。
 *
 * 缺陷②（F5b）实测的形状就是 `baseline-appeared`：基线 = absent（新增）、
 * 真实文件在暂存之后由 shell 出现。旧实现只有一个布尔位 ⇒ 面板只能说
 * "基线已过期"，用户看不出这是"磁盘上多出一份没有暂存副本的内容"。
 */
export { driftReasonOf }

/**
 * 单个漂移形状的**人话**（命令面 / 面板共用一份字面量来源）。
 * 未知形状按最保守的"外部改写"表述。
 */
export function driftReasonText(reason) {
  if (reason === 'baseline-appeared') return '真实文件在暂存之后出现（基线本为"不存在"）'
  if (reason === 'baseline-deleted') return '真实文件在暂存之后被外部删除'
  return '真实文件在暂存之后被外部改写'
}

/**
 * 判级纯函数：`change` → `{ external, risk, safety, riskReason }`。
 *
 * 三档**不是互斥树**，因此判级是一条**短路顺序链**：
 *   1. 命中敏感规则 ⇒ `sensitive`（不管在不在工作区内：本工具自身的存储树就是"内 + 敏感"）；
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
  //（如工作区根下本工具自身存储树里的暂存对象），按词法会把"内+敏感"错判成 external（断言 ④ 抓到的）。
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
 * ── WP5′.2：截断的**机读原因**（纯函数；`snapshot()` 与离线断言**共用同一实现**）─────
 *
 * 旧实现把两种完全不同的截断塞进同一个布尔位 `truncated`：
 *   · `row-limit`     —— 行数超过 `limits.maxFiles`，**有整行没列出来**（少报条目）；
 *   · `content-limit` —— 某条的 `diff` 片段被 `limits.maxLinesPerFile` 截了（内容不全）。
 * 两者对用户的含义、对断言的判据都不一样，共用一个布尔位就无法机检"到底是哪一种"。
 * 本函数把它们分开命名，合并时用 `+` 连接（`'row-limit+content-limit'`），`null` = 没截断。
 *
 * 为什么导出：`_r3/wp5-test.mjs` 要**直接**验证这套映射（含"行被安全策略省略 diff 时
 * `truncated` 必须保持 false"这一条 —— 省略不是截断，两个语义不能混）。
 *
 * @param {Array<{truncated?: boolean}>} listed 全量行（截断前）
 * @param {number} listedCount 本页实际列出的条数
 * @returns {string|null}
 */
export function truncatedReasonOf(listed = [], listedCount = 0) {
  const rowTruncated = listed.length > listedCount
  const contentTruncated = listed.some((item) => item?.truncated === true)
  const parts = []
  if (rowTruncated) parts.push('row-limit')
  if (contentTruncated) parts.push('content-limit')
  return parts.length === 0 ? null : parts.join('+')
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
    this.sessionId = options.sessionId || DEFAULT_REVIEW_SESSION_ID
    /**
     * 本会话的存储根（WP2：由 `resolveReviewStoreDir()` → `resolveStageRoot()` 解析；
     * 默认 = Windows 缓存里的会话工作根，**不再**是工作区内的旧布局）。
     *
     * 为什么必须留住它：**注册表**候选的布局是"覆盖层 + WAL + 候选 + 队列"全在
     * `<sessionDir>/` 下（`src/registry-stage.mjs:1758-1766`），而 `apply()`/`discard()`
     * 要拿同一个 sessionDir 重新打开覆盖层。丢了它就只能"看得到、批不了"。
     */
    this.storeDir = options.storeDir
      ? String(options.storeDir)
      // WP2：没显式注入时**不是** `undefined`（旧版就是 undefined，于是注册表候选只能
      // "看得到、批不了"）。这里与 `this.workspace.store.dir` 走**同一个**解析入口，
      // 因此两者逐字相等是结构性事实，不靠约定。
      : resolveReviewStoreDir({
          workspaceRoot: this.workspaceRoot,
          sessionId: this.sessionId,
          stageRoot: options.stageRoot,
          env: options.env,
        })
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
    /**
     * 缺陷②（F5b）：只读轮询复核的记账。
     * `driftFingerprint` = 上一次发布时"清单 mtime + 每条净 diff 两侧 hash"的指纹，
     * 用来判断"是否值得再写一次 review.json"；`driftSnapshot` = 那一版快照。
     * 两者都只是缓存，丢了最多多发一次快照，不影响正确性。
     */
    this.driftFingerprint = undefined
    this.driftSnapshot = undefined
    /** 已上报过的漂移（`emitDriftDiagnostics()` 按 路径+形状+两侧 hash 去重，只报一次） */
    this.reportedDrift = new Set()
    /** `stageBaseDir(env)` 的注入缝（自测用；生产不传 ⇒ 用宿主进程 env） */
    this.env = options.env
    this.workspace = new Workspace({
      workspaceRoot: this.workspaceRoot,
      sessionId: this.sessionId,
      // WP2：存储根**只有一条**解析路径（`resolveReviewStoreDir()`）；显式注入优先，
      // 否则 `Workspace` → `Store` 也会走同一个 `resolveStageRoot()`（`src/store.mjs`）。
      ...(options.storeDir ? { storeDir: options.storeDir } : {}),
      ...(options.env ? { env: options.env } : {}),
    })
    this.workspace.init({ origin: 'host-plugin' })
    this.markFresh()
  }

  /**
   * **warn / error 级**日志（§7.3 S11–S14："失败必须响"）。
   *
   * 这些分支以前只用 `this.log`（= `logger.info`）记一句就吞掉，实测表现是"零报错"。
   * 顺序：`logger.warn` → `logger.error` → `console.error`（进程 stderr）。
   *
   * ⚠ **痕迹边界（本轮复核）**：本方法是**人工侧通道**（宿主 logger / 宿主进程 stderr），
   * 不是模型可见通道 —— 它永远不参与命令的 stdout/stderr，也绝不能被拼进 `/winstage*`
   * 命令的 `text` 返回值（那两路都会被模型看到）。因此这里的 `[winstage]` 前缀保留：
   * 它是给运维/用户看的归因标记。**新增任何面向模型的文案时，不要走这里。**
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
    // ★ 缺陷②（F5b）：这里**不再**自动对准基线。
    //   旧版在每次 reload() 上跑 `autoRebaseDrifted()`，而 reload() 又被 snapshot() /
    //   publish() / approve() 调用 ⇒ "重新发布快照"这个动作本身就把漂移抹掉了，
    //   面板永远看不到 `baselineStale`（F5b 实测 90 s：`staleBaseline=0`、无徽标），
    //   紧接着 approve() 的自动对齐还让批准**静默成功**。
    //   现在：reload() 只重读清单；无损漂移由显式 rebase / 诊断路径处理，
    //   有损漂移保持可见并以 `STALE_BASELINE` 拒绝落盘。
    return this.workspace
  }

  /**
   * ★ **自动对准基线** —— 只处理**无损**漂移（缺陷② F5b 收窄后的语义）。
   *
   * 暂存条目是"相对某个基线的 diff"。基线一旦被**外部**改动，`applyOneChange()` 会以
   * `STALE_BASELINE` 拒绝落盘（这层保护是对的：绝不静默覆盖）。
   *
   * 本方法把 `/winstage rebase` 的落地动作（`_rebase()` → `rebaseEntry()` 重述
   * `baseHash/baseKind`，**不动** `stagedHash/state`）在一处集中执行，但**只对**
   * 真实内容与暂存内容相同（⇒ 对准后无净变化、磁盘一个字节都不会被改）的漂移生效：
   *   - 真实内容 == 暂存内容 ⇒ 无损：对准后条目自动退出视图；
   *   - 真实内容 ≠ 暂存内容（含"基线 absent 而真实文件已出现"）⇒ **blocked**，
   *     绝不自动对准 —— 否则这条会变成"可批准"，下一次批准静默覆盖外部写入
   *     （F5b 实测的数据丢失路径）。它保持 `baselineStale`，由显式 `/winstage rebase`
   *     或 `/winstage reject` 处置。
   *
   * 调用点（收窄后）：`/winstage rebase`（`rebase()`）、`approve --rebase` 的显式意图、
   * 以及自测/人工诊断。**不在** `reload()` / `publish()` / `afterMutation()` / `approve()`
   * 里 —— 那些路径一旦自动对准，快照就永远看不到漂移（F5b 的 90 s 静默就是这么来的）。
   *
   * 幂等 + 节流：没有漂移时不重冻结、不写快照；1 秒内重复调用直接返回上次结论。
   * 逃生口：`WINSTAGE_AUTO_REBASE=0` 关掉（回到显式 `/winstage rebase`）。
   *
   * @param {{force?: boolean}} [options] `force` 绕过节流（自测/人工诊断用）
   * @returns {{rebased: string[], discarded: string[], blocked: Array<{path:string,reason:string,expected:string,found:string}>, skipped: boolean, throttled?: boolean}}
   */
  autoRebaseDrifted(options = {}) {
    if (process.env.WINSTAGE_AUTO_REBASE === '0') {
      return { rebased: [], discarded: [], blocked: [], skipped: true }
    }
    const now = Date.now()
    if (options.force !== true && this.autoRebaseLastAt !== undefined && now - this.autoRebaseLastAt < AUTO_REBASE_INTERVAL_MS) {
      return { rebased: [], discarded: [], blocked: [], skipped: false, throttled: true }
    }
    // 重入保护：`_rebase()` 里会走 `reconcileCandidates()` / `ensureCandidate()`，
    // 它们可能再次触发 `reload()`；没有这道闸就是无限递归。
    if (this.autoRebasing === true) {
      return { rebased: [], discarded: [], blocked: [], skipped: false, throttled: true }
    }
    this.autoRebasing = true
    try {
      const ws = this.workspace
      const drifted = []
      const blocked = []
      for (const change of ws.diffEntries()) {
        const drift = ws.baselineDrift(change.path)
        if (!drift.stale) continue
        /**
         * ★ 缺陷②（F5b）的核心闸门：**只有在"重述基线不会丢内容"时才允许自动对准**。
         *
         * 重述基线的语义是"把 before 换成现实、把暂存内容留作 after"。于是：
         *   - 真实内容 **等于** 暂存内容 ⇒ 对准后是"无净变化"，条目自动退出视图，
         *     磁盘一个字节都不会被改 —— 无损，可以自动做；
         *   - 真实内容 **不等于** 暂存内容 ⇒ 对准之后那一条就变成"可批准"，
         *     下一次批准会把真实内容盖掉。旧实现在这里**静默**对准 ⇒ F5b 实测：
         *     基线 = absent（新增）而真实盘被 shell 写成 `SHELL-VERSION`，90 s 内
         *     无任何标记，点「批准所选」直接把真实盘覆盖成 `STAGED-VERSION`，
         *     无提示、无告警、无错误（数据静默丢失）。
         *
         * 因此这一档**拒绝自动对准**：漂移留在清单里 ⇒ `renderChange()` 照旧标
         * `baselineStale` ⇒ 面板有徽标、命令面有文案、`applyOneChange()` 以
         * `STALE_BASELINE` 拒绝落盘。出路仍是既有的那条：显式
         * `/winstage rebase`（`_rebase()` 不受这里约束）或 `/winstage reject`。
         */
        const staged = ws.entryOf(change.path)?.stagedHash ?? hashAbsent()
        if (drift.found !== hashAbsent() && drift.found !== staged) {
          blocked.push({ path: change.path, reason: drift.reason, expected: drift.expected, found: drift.found })
          continue
        }
        drifted.push(change.path)
      }
      this.autoRebaseLastAt = now
      if (drifted.length === 0) return { rebased: [], discarded: [], blocked, skipped: false }
      const result = this._rebase(drifted)
      return { rebased: result.rebased, discarded: result.discarded, blocked, skipped: false }
    } finally {
      this.autoRebasing = false
    }
  }

  /** 快照文件绝对路径（与暂存清单**同一个存储根**；会话隔离时即该会话的目录） */
  reviewPath() {
    return join(this.workspace.store.dir, REVIEW_BASENAME)
  }

  /**
   * **自愈**：把**别处**已经落下的条目并进本会话的存储（WP2：候选来源经
   * `resolveStageRoot()` 解析，绝不硬拼旧布局）。
   *
   * 为什么需要：只要有一次调用拿不到会话身份（旧进程、agentless、initiator 不可读），
   * 内容就会落到**共享根**，而面板只读自己的会话目录 ⇒ 条目"随 Turn 消失"。这里在**每次
   * 会话级写/命令**上做一次便宜检查（manifest 不存在就零成本返回）：
   *   - 目标还没有 manifest ⇒ 整份搬（rename 优先，失败退回复制）；
   *   - 目标已有 manifest ⇒ 按**条目键**合并（目标优先），blobs/staged 只补缺失的；
   *   - 并完清掉来源的 manifest/queue（`candidates` 丢弃：净 diff 会重新冻结）。
   *
   * 两个来源（顺序即优先级）：
   *   1. **共享根** = `resolveReviewStoreDir({ sessionId: undefined })` —— Phase 1 之后
   *      "没有会话身份"的那次写落在缓存里的哪，这里就扫哪；
   *   2. **旧布局**（`legacyWorkspaceStoreDir()`）—— 升级前积在工作区里的内容。
   *      只读/只搬走，永不回写（写入路径一个字节都不会再落到那里）。
   * @returns {number} 并入的条目数（0 = 没有可并的）
   */
  absorbSharedStore() {
    const seen = new Set()
    let total = 0
    for (const dir of [this.sharedStoreDir(), legacyWorkspaceStoreDir(this.workspaceRoot)]) {
      let dedup
      try {
        dedup = canonical(dir).toLowerCase()
      } catch {
        dedup = String(dir).toLowerCase()
      }
      if (seen.has(dedup)) continue
      seen.add(dedup)
      total += this.absorbFromStore(dir)
    }
    return total
  }

  /** 本进程"共享（无会话身份）"服务的存储根 —— 与 `getReviewService()` 同一解析入口 */
  sharedStoreDir() {
    return resolveReviewStoreDir({ workspaceRoot: this.workspaceRoot, sessionId: undefined, env: this.env })
  }

  /** 从**某一个**来源存储把条目并进本会话（`absorbSharedStore()` 的实体；逐来源独立记账） */
  absorbFromStore(sharedDir) {
    const targetDir = this.workspace.store.dir
    try {
      if (canonical(targetDir) === canonical(sharedDir)) return 0 // 本服务就是那个来源
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
        this.log(`已把来源存储里的 ${moved} 条待审并入会话存储：${targetDir}`)
      }
      return moved
    } catch (error) {
      // S11：以前只有 `logger.info`（实测"零报错"）⇒ 现在 warn/error 级
      this.logError(`并入来源存储失败（已忽略）：${error?.message ?? error}`)
      return 0
    }
  }

  /** 变更过暂存树之后：冻结候选并发布快照（供 Client 轮询） */
  afterMutation(reason = 'mutation') {
    /**
     * ★ 缺陷②（F5b）：这里**不再**自动对准基线。
     *
     * 旧注释写的是"每次修改都强制对齐一次基线"，理由是"对齐必须发生在冻结候选之前，
     * 这样候选的 before 一定是现实"。但那个理由只对**无损**形状成立：
     *   - 真实内容 ≠ 暂存内容时，"重述基线"会把外部写入变成一条**可批准**的 diff，
     *     于是下一次批准静默覆盖它 —— F5b 实测（基线 = absent、真实盘被 shell 写成
     *     `SHELL-VERSION`）就是这样丢掉内容的；
     *   - 而"本次修改"通常只涉及一个路径，无差别对齐会把**其它**路径的漂移一起抹掉。
     *
     * 现在的分界：`autoRebaseDrifted()` 只自动处理**无损**漂移（真实内容 == 暂存内容，
     * 对准后无净变化）；有内容丢失风险的漂移留给显式 `/winstage rebase` / `reject`。
     * 因此这里不再需要"先对齐再冻结"——漂移路径会以 `baselineStale` 出现在快照里。
     */
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
      // 注册表候选走 `registryRows()` 这条**可批准**的路，绝不在这里被降级成
      // "冻结存档行"（那正是"看得到、勾不上、批不了"的形态）。
      if (isRegistryCandidate(candidate)) continue
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

  /**
   * 注册表候选 → Client 可直接渲染的**可批准**行。
   *
   * 与文件行同构（同样的 `path/op/kind/totals/diff/external/risk/safety/riskReason`），
   * 只多两个字段：`kind:'registry'` 与 `registryPath`/`valueName`。
   * ⚠ 这些行**没有 diff 内容**：注册表变更的内容不在文件系统里，面板至少能显示
   * "哪个键/哪个值、什么操作、三档风险"，这与"看不到内容就不给批准"的既有硬约束
   * 并不冲突 —— 覆盖层的语义是"批准=把这条键值变更照原样应用到真实 hive"，
   * 而用户看到的就是那条变更本身。
   */
  registryRows(ws, pending) {
    const rows = []
    for (const candidate of pending) {
      if (!isRegistryCandidate(candidate)) continue
      for (const change of candidate.changes || []) {
        let verdict
        try {
          verdict = classifyChange(
            { ...change, external: true },
            { workspaceRoot: this.workspaceRoot, masks: ws?.extraMasks },
          )
        } catch {
          verdict = { external: true, risk: 'outside', safety: 'normal', riskReason: 'registry change' }
        }
        const row = {
          path: change.path,
          op: change.op,
          kind: 'registry',
          registry: true,
          totals: { added: 0, removed: 0 },
          diff: [],
          truncated: false,
          external: true,
          risk: verdict.risk,
          safety: verdict.safety,
          riskReason: verdict.riskReason,
          candidateIds: [candidate.id],
          registryPath: change.registryPath ?? change.key,
          note:
            '注册表变更：此刻只存在于覆盖层里（**真实注册表一个字节未变**）；' +
            '勾选并批准后才由宿主令牌写入真实 hive，拒绝则丢弃。',
        }
        if (change.valueName !== undefined) row.valueName = change.valueName
        if (change.appliable === false) {
          row.appliable = false
          row.note = `该注册表变更**不可应用**：${change.unsupportedReason ?? '覆盖层无法表示'}`
        }
        rows.push(row)
      }
    }
    return rows
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
   * ── WP8.2：宿主原件**指纹冲突**（`snapshot` 与 `approve` 共用同一判据）──────────────
   *
   * 委派给 `src/workspace.mjs` 的方法（判据只有一份：`baselineConflictOf()` 纯函数 +
   * `hostFileFingerprint()`）。**刻意不在这里重写一遍比较逻辑** —— 审批面与落盘面
   * 一旦各持一套判据，"面板说没冲突、批准却拒绝"就会成为常态，而这类不一致正是
   * F5b 那次静默覆盖的同源缺陷。
   *
   * 纯读（只 `statSync` + `hashFile`），不写任何状态；`workspace` 侧注入缝也随之失效时
   * 一律回 `null`（不判冲突），保证老清单/外部键的行为逐字不变。
   *
   * @returns {{code:string,expected:object,found:object|null,changed:string[]}|null}
   */
  baselineConflictOf(ws, change) {
    try {
      if (typeof ws?.baselineConflictOf !== 'function') return null
      return ws.baselineConflictOf(change)
    } catch {
      return null
    }
  }

  /**
   * Method A 主线读侧：把宿主 `sandbox-audit.json`（AI 进程树的文件/注册表读写分类统计）
   * 作为快照的 `audit` 段带给面板。**纯读、有界**：只带 summary + 每类 ≤50 行样本，
   * 完整报告在文件里。文件由 `shell-executor.captureAudit()` 写在**同一会话存储根**；
   * 不存在则返回 null（无审计/未开启）。
   */
  auditSummary() {
    try {
      const file = join(dirname(this.reviewPath()), 'sandbox-audit.json')
      if (!existsSync(file)) return null
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const slice = (arr) => (Array.isArray(arr) ? arr.slice(0, 50) : [])
      return {
        generatedAt: raw.generatedAt ?? null,
        summary: raw.summary ?? null,
        files: {
          read: slice(raw.files?.read),
          written: slice(raw.files?.written),
          deleted: slice(raw.files?.deleted),
        },
        registry: { read: slice(raw.registry?.read), written: slice(raw.registry?.written) },
        note: 'bounded: summary + up to 50 rows per list; full report in sandbox-audit.json',
      }
    } catch {
      return null
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
    /**
     * ── WP5′：审批面 = **本轮净变更**，按需实时算（不再累积）────────────────────────
     *
     * owner 定下的模型与顾虑（原话）："多轮的中间产物不要保留…每一轮暂存都叠加的话会使
     * 计算量指数增长"。因此这里的分工被**钉死**成：
     *
     *   · `changes = ws.diffEntries()` —— **唯一**的条目来源。它是"暂存层 vs 宿主真实文件"
     *     的实时比对结果，条数只与**逻辑路径数**有关，与**轮次**无关：
     *     同一路径写 30 次 → 2 个 blob（当前暂存 + 基线）+ **1 条 net diff**，不是 30 条。
     *     这就是"审批面与轮次解耦"的全部机制 —— 不存在需要清理的累积状态。
     *   · 候选（`candidates/*.json` + `queue.json`）退化为**结案台账**：
     *     `workspace.pruneCandidates()` 在"冻结"与"全部应用"两个唯一入口上回收
     *     `superseded` / `applied` 的候选，只留一份 id → 终态的**墓碑**（幂等性所需，
     *     见 `queue.resolved` 注释）。因此 `pending.length` 上界是常数（每路径一份未决候选），
     *     `_r3/wp5-test.mjs` 断言①用 30 轮实测钉住这一点。
     *
     * 代价（如实声明，不是隐性行为）：每次快照都要重算净 diff（含逐条 `classifyChange`
     * 与内容片段渲染）。这与旧实现的区别是"成本与**当前变更集**成正比"，
     * 而旧实现是"成本与**历史**成正比"——后者是 owner 明确不要的那一种。
     */
    const changes = ws.diffEntries()
    const pending = ws.listReviews()
    const latest = pending[pending.length - 1]
    const limits = { ...this.limits, ...(options.limits || {}) }

    const netKeys = new Set(changes.map((change) => compareKey(change.path)))
    const netFiles = changes.map((change) => this.renderChange(ws, change, limits))
    const registryFiles = this.registryRows(ws, pending)
    // 冻结存档行：只在"仍有一份活的候选、其路径却已不在本轮净 diff"时才产生。
    // 候选被修剪之后这个集合自然收缩到空 —— 它不再是历史的容器。
    const frozenFiles = this.frozenOnlyRows(ws, netKeys)
    const listed = [...netFiles, ...registryFiles, ...frozenFiles]

    /**
     * ── WP5′.2：`listed` / `totalFiles` / `truncated` **三者自洽** ────────────────
     *
     * 契约（机读，`_r3/wp5-test.mjs` 断言②逐项核对）：
     *   · `counts.totalFiles` = **全量**待审条数（截断前）；
     *   · `counts.listed`     = 本页实际列出的条数；
     *   · `counts.pageSize`   = 本页上限；
     *   · 不变式：`counts.listed === Math.min(counts.totalFiles, counts.pageSize)`；
     *   · `counts.truncated`  = `totalFiles > listed`（**机读布尔位**，旧版恒 false）；
     *   · `truncatedReason`   = `'row-limit'` / `'content-limit'` / `'row-limit+content-limit'`
     *     —— 机器可判"是哪一种截断"，不必靠人读 `truncated` 猜（旧版两种语义共用一个布尔位）。
     *
     * `contentTruncated` 与行数无关：它是"某条 `diff` 片段被 `maxLinesPerFile` 截了"
     * （旧版把这个也塞进顶层 `truncated`，于是"行数没超但有文件内容被截"与
     * "行数超了"无法区分；现在两者分开给）。
     */
    const pageSize = Math.max(0, Number(limits.maxFiles) || 0)
    const files = listed.slice(0, pageSize)
    const rowTruncated = listed.length > files.length
    const totals = listed.reduce((acc, f) => ({
      added: acc.added + f.totals.added,
      removed: acc.removed + f.totals.removed,
    }), { added: 0, removed: 0 })

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      workspaceRoot: this.workspaceRoot,
      sessionId: ws.manifest?.sessionId,
      candidateId: latest?.id,
      revision: ws.manifest?.revision,
      // 待审 = 面板上有**任何**一行（全量口径：被截断掉的行也是待审）
      pending: listed.length > 0,
      /** 行级截断的机读位（旧语义保留：只回 true 当"有行没列出来"） */
      truncated: rowTruncated,
      counts: {
        /** 待审**总数**（截断前） */
        files: listed.length,
        /** 面板实际列出的行数（≤ `pageSize`）；`files - listed` 即被截断条数 */
        listed: files.length,
        /** 显式全量键（与 `files` 同值），名字不含歧义 */
        totalFiles: listed.length,
        /** 本页上限（= `limits.maxFiles`）—— 断言②要拿它做 `min()` */
        pageSize,
        /** `totalFiles > listed` 的机读布尔位（旧版恒 false，见文件头缺陷记录） */
        truncated: rowTruncated,
        additions: totals.added,
        deletions: totals.removed,
        /** 净 diff 的条数 = 真正可批准的那部分（**与轮次无关**，WP5′ 的核心指标） */
        net: changes.length,
        /** 其中"冻结存档行"的条数（只显示、不可批准）——按**全量**统计 */
        frozenOnly: listed.filter((f) => f.frozenOnly === true).length,
        /** 注册表候选行数（机读；本轮实测曾出现"注册表行 0 条"，故单列一项供断言） */
        registry: listed.filter((f) => f.registry === true).length,
        staleBaseline: listed.filter((f) => f.baselineStale === true).length,
        staleBaselineLossy: listed.filter((f) => f.baselineStale === true && f.baselineStaleCode !== 'baseline-deleted').length,
        /**
         * WP8.2：**基线冲突**（宿主原件在暂存之后被改过 ⇒ 判冲突、不覆盖）的条数。
         * 与 `staleBaseline` 的区别：后者是"批准会被 `STALE_BASELINE` 拒绝"，
         * 本键是"新指纹判据（size+mtime+sha256）命中了冲突"。两者同源不同粒度，
         * 都保留，因为面板对二者的措辞与出路不同（前者：rebase/reject；后者：覆盖/放弃）。
         */
        baselineConflict: listed.filter((f) => f.baselineConflict === true).length,
      },
      /**
       * 截断的**机读原因**（`null` = 没截断）。合并语义用 `+` 连接：
       *   · `row-limit`     —— 行数超过 `pageSize`，有整行没列出来；
       *   · `content-limit` —— 某条的 `diff` 片段被 `maxLinesPerFile` 截了（行数没超也可能有）。
       * 与两个计数位**同源**（同一个 `truncatedReasonOf()`），不在这里再推一遍。
       */
      truncatedReason: truncatedReasonOf(listed, files.length),
      /** 分页细节（面板据此画"显示前 N / 共 M"）；与 `counts` 同源，不另算一遍 */
      page: { pageSize, listed: files.length, total: listed.length, omitted: Math.max(0, listed.length - files.length) },
      riskCounts: countRisks(listed),
      alerts: buildAlerts(netFiles, latest?.id),
      candidates: pending.map((candidate) => ({
        id: candidate.id,
        status: candidate.status,
        paths: (candidate.changes || []).map((change) => change.path),
        appliedPaths: [...(candidate.appliedPaths || [])],
      })),
      readVisibility: readVisibilitySnapshot(this.sessionId),
      /** Method A 主线：AI 进程树读了/改了什么的分类统计（见 `auditSummary()`） */
      audit: this.auditSummary(),
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
   * （凭据/密钥/本工具自身存储等），默认**不把内容片段写进 review.json** ——
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
        // 缺陷②（F5b）：光有布尔位说不清"会不会丢数据"。把**形状**一并给出，
        // 面板因此能说"真实文件在暂存之后出现"而不是笼统的"基线已过期"。
        item.baselineStaleCode = driftReasonOf(expected, found)
      }
      /**
       * ── WP8.2：宿主原件**指纹冲突**（size + mtime + sha256）────────────────────────
       *
       * 与上面的 `baselineStale` 是**两个口径**，都要给：
       *   · `baselineStale`    —— 批准会被 `applyOneChange()` 以 `STALE_BASELINE` 拒绝
       *                           （判据：内容 hash；出路：`/winstage rebase|reject`）；
       *   · `baselineConflict` —— **新的默认安全闸**：宿主原件在暂存之后被改过 ⇒
       *                           判冲突、不覆盖，出路是用户在面板上选「覆盖 / 放弃」。
       * 判据用与 `applyOneChange()` **同一个**纯函数（`baselineConflictOf()`），
       * 因此"面板说冲突"与"批准会拒绝"不可能互相矛盾（同一份指纹、同一套比较）。
       * 只在清单记过指纹（`baseFingerprint`，= 普通文件）时才可能为真。
       */
      const conflict = this.baselineConflictOf(ws, change)
      if (conflict) {
        item.baselineConflict = true
        item.baselineConflictCode = conflict.code
        // 变了哪几项（sha256 / size / mtime）—— 面板据此说"内容被改过"还是"只是被触碰"
        item.baselineConflictChanged = conflict.changed
        item.hostBaseline = { expected: conflict.expected, found: conflict.found }
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
  /**
   * 强制自动对准基线，**失败只记 error 日志**，绝不影响调用方。
   *
   * ⚠ 缺陷②（F5b）收窄后：这里**只**对准无损漂移（见 `autoRebaseDrifted()`）。
   * 有内容丢失风险的漂移会原样留在清单里（返回值里的 `blocked`），继续可见、继续拒绝批准。
   *
   * 调用点（收窄后）：显式 rebase 路径与自测/人工诊断。**不再**由
   * `reload()` / `publish()` / `afterMutation()` / `approve()` 调用。
   */
  autoAlignQuietly() {
    try {
      return this.autoRebaseDrifted({ force: true })
    } catch (error) {
      try {
        this.logError(`自动对准基线失败（不影响本次操作）：${error?.message ?? error}`)
      } catch {
        /* best effort：日志失败也不许影响调用方 */
      }
      return { rebased: [], discarded: [], blocked: [], skipped: false, failed: true }
    }
  }

  publish() {
    // ★ 缺陷②（F5b）：发布路径**绝不**自动对准基线（旧版这里调 `autoAlignQuietly()`）。
    //   原因与 `afterMutation()` 逐字相同：对齐会把"真实文件被外部改动"这件事实
    //   从快照里抹掉，而快照正是用户唯一能看见它的地方。发布必须是**纯读**：
    //   漂移照旧标 `baselineStale`（+ 形状），批准照旧被 `applyOneChange()` 拒绝。
    //   显式出路只有两条：`/winstage rebase`（`_rebase()`）或 `/winstage reject`。
    const snapshot = this.snapshot()
    writeFileAtomic(this.reviewPath(), JSON.stringify(snapshot))
    return snapshot
  }

  /**
   * **只读**轮询复核（缺陷② F5b 的"正确触发点"）。
   *
   * ── 为什么需要它 ────────────────────────────────────────────────────────────
   * `review.json` 只在"变更 / 命令"时发布。shell（`pwsh` 工具）绕过 `ctx.fs`
   * 直接写真实磁盘 **不产生任何** 上述事件 ⇒ 快照的 `generatedAt` 会一直冻在
   * 上一次发布（F5b 实测：90 s 一次都没重发布），面板于是长期显示一条与现实
   * 不符的"新增"行，且 `staleBaseline = 0`。
   *
   * 本方法是**读路径**，三条纪律：
   *   1. **绝不改状态**：不 `init()` 之外的写、不 rebase、不 discard、不冻结候选。
   *      不这样的话，"轮询"本身就会变成那个把外部内容盖掉的动作；
   *   2. **代价受控**：先比一个便宜的指纹（发布时记下的"清单 mtime + 净 diff 的
   *      before/after hash"），指纹没变就直接返回 —— 调用方因此可以按秒级节拍
   *      轮询而不产生可见负载；
   *   3. **指纹变了才写盘**：只在真的需要把新事实告诉面板时才 `publish()`。
   *
   * 返回里 `changed` = 本次是否重发布；`stale` = 当前漂移清单（含形状），
   * 供宿主把它送上**人工侧**诊断通道（`review-service.mjs` 的 `logError` 契约：
   * 绝不进模型可见的 stdout/stderr / 命令文本）。
   *
   * @returns {{changed: boolean, snapshot: object, stale: Array<{path:string,reason:string,expected:string,found:string}>}}
   */
  reviewDrift() {
    const ws = this.reload()
    const changes = ws.diffEntries()
    const stale = []
    const parts = []
    for (const change of changes) {
      const drift = ws.baselineDrift(change.path)
      if (!drift.stale) continue
      stale.push({ path: change.path, reason: drift.reason, expected: drift.expected, found: drift.found })
      parts.push(`${change.path}:${drift.reason}:${drift.found}`)
    }
    // 指纹 = 清单 mtime + 每一条净 diff 的 before/after + 每个漂移形状。
    // 拿它当"要不要重发布"的判据：外部写真实文件会改漂移形状（→ 变），
    // 而一切都没动时它逐字不变（→ 不写盘）。
    let stamp
    try {
      stamp = statSync(ws.store.manifestPath).mtimeMs
    } catch {
      stamp = 'none'
    }
    for (const change of changes) parts.push(`${change.path}|${change.before?.hash ?? ''}|${change.after?.hash ?? ''}`)
    const fingerprint = `${stamp}\u0000${parts.join('\u0001')}`
    if (this.driftFingerprint === fingerprint && this.driftSnapshot) {
      return { changed: false, snapshot: this.driftSnapshot, stale }
    }
    this.driftFingerprint = fingerprint
    this.driftSnapshot = this.publish()
    return { changed: true, snapshot: this.driftSnapshot, stale }
  }

  /**
   * 把漂移送上**人工侧**诊断通道（宿主 logger / 宿主 stderr），按"形状 + 路径 + 两侧 hash"
   * 去重 ⇒ 同一次漂移只报一次，真实文件又被改一次（hash 变）才会再报。
   *
   * ⚠ 契约（`shell-executor.mjs:1319-1335` 的分离纪律）：这里**只**写人工通道，
   * 绝不写模型可见的 stdout/stderr，也不进任何命令的 `text` 返回值。
   * @returns {number} 本次真正报出的条数
   */
  emitDriftDiagnostics(stale) {
    if (!Array.isArray(stale) || stale.length === 0) {
      // 漂移都解除了 ⇒ 去重集合一并收缩，避免进程内无限增长
      if (this.reportedDrift instanceof Set && this.reportedDrift.size > 0) this.reportedDrift.clear()
      return 0
    }
    if (!(this.reportedDrift instanceof Set)) this.reportedDrift = new Set()
    const live = new Set(stale.map((item) => item.path))
    for (const key of this.reportedDrift) {
      if (!live.has(key.split('\u0000')[0])) this.reportedDrift.delete(key)
    }
    let emitted = 0
    for (const item of stale) {
      const key = `${item.path}\u0000${item.reason}\u0000${item.expected}\u0000${item.found}`
      if (this.reportedDrift.has(key)) continue
      this.reportedDrift.add(key)
      this.logError(
        `基线过期（${item.reason}）：${item.path} —— ${driftReasonText(item.reason)}；` +
          '已拒绝静默落盘，处理：/winstage rebase [路径…] 以真实文件为基线重新暂存，或 /winstage reject [路径…] 丢弃这份暂存。',
      )
      emitted += 1
    }
    return emitted
  }

  /**
   * 批准：把候选（可只选部分路径）写进真实工作区。
   * 逐文件条件检查由 `applyCandidate` 承担：真实文件自暂存以来被外部改动 →
   * 该文件 `STALE_BASELINE` 失败，而不是静默覆盖（手册 #12.1）。
   */
  approve(paths, options = {}) {
    this.reload()
    /**
     * ── 注册表候选（本轮接线）──────────────────────────────────────────────────
     * 注册表候选不是文件变更，`Workspace.applyCandidate()` 对它无能为力（它按
     * `change.before/after` 的文件哈希落盘）。因此必须先把它**摘出来**交给
     * `createRegistryStage().apply()`（宿主令牌 `reg.exe`），再把剩下的路径交给原来的
     * 文件逻辑。两条路合起来仍然只有**一个**审批面（同一个 `queue.json`、同一套
     * `/winstage approve|reject`）。
     */
    const pendingBefore = this.reload().listReviews()
    const registryPending = pendingBefore.filter((candidate) => isRegistryCandidate(candidate))
    const registryKeys = new Set(
      registryPending.flatMap((candidate) => (candidate.changes || []).map((change) => compareKey(change.path))),
    )
    const selectedRegistry = paths && paths.length > 0 ? paths.filter((p) => registryKeys.has(compareKey(p))) : []
    const wantsRegistry =
      registryPending.length > 0 && ((paths ?? []).length === 0 || selectedRegistry.length > 0)
    const registryOutcome = wantsRegistry ? this._approveRegistry(selectedRegistry) : undefined
    const filePaths =
      wantsRegistry && paths && paths.length > 0 ? paths.filter((p) => !registryKeys.has(compareKey(p))) : paths
    /**
     * ★ 缺陷②（F5b）：这里**删掉了**原来的 `this.autoAlignQuietly()`。
     *
     * 旧注释是这样写的："批准**之前**强制对齐一次基线（不受 `reload()` 的 1 s 节流限制）…
     * 对齐只**重述 before**，所以面板展示的 before 就是现实，不存在'静默覆盖'。"
     * 结论的后半句**是错的**：重述 before 会把"真实文件已被外部改动"这件事实从
     * 清单里擦掉，于是紧随其后的 `applyCandidate()` 拿到的是一个 before == 现实的
     * 候选 ⇒ 检查通过 ⇒ **静默覆盖**。F5b 实测（基线 = absent、真实盘 = `SHELL-VERSION`、
     * 暂存 = `STAGED-VERSION`）：`approve()` 返回 `ok:true, approved:1, failed:[]`，
     * 真实盘变成 `STAGED-VERSION`，没有任何提示。
     *
     * 现在批准**只**依据候选冻结时的那份 before 做条件检查：
     *   - 未漂移 ⇒ 正常落盘（正面控制）；
     *   - 已漂移 ⇒ `applyOneChange()` 抛 `STALE_BASELINE` ⇒ 命令面给出
     *     "rebase / reject" 的既有出路（`host-plugin.mjs` 的 `STALE_BASELINE` 分支）。
     * 显式 `--rebase`（`options.rebase === true`）走的仍是 `_rebase()`，一字未改。
     */
    // `rebase: true`：显式要求"先以真实文件为基线重新暂存，再批准"。
    // 这是**用户明确点过**的出路（面板的「重新对齐并批准所选」/ `/winstage approve --rebase`），
    // 与"静默对齐"的区别在于：用户在命令里看得见它，且 rebase 之后面板会显示新的
    // before/after（真实内容出现在将被替换的那一侧）。
    const rebaseResult = options.rebase === true ? this._rebase(filePaths) : undefined
    const rebased = rebaseResult ? rebaseResult.rebased : []
    // S13/S14：`--rebase` 也会走候选对账 ⇒ 没清干净的必须随返回值上报（新增键）
    const clearFailures = rebaseResult && Array.isArray(rebaseResult.failures) ? rebaseResult.failures : []
    /**
     * 注册表结果的合并口径：`ok` 取两者与，`approved` 相加，`failed` 合并。
     * 为什么要合并而不是"先处理注册表再早退"：用户点「批准全部」时，文件面与注册表面
     * 都必须落盘；两次调用各自返回一半真话，合起来才是"这一次批准到底发生了什么"。
     */
    const withRegistry = (result) => {
      if (!registryOutcome) return result
      const failed = [...(result.failed ?? []), ...(registryOutcome.failed ?? [])]
      return {
        ...result,
        ok: result.ok === true && registryOutcome.ok === true,
        approved: (result.approved ?? 0) + (registryOutcome.approved ?? 0),
        failed,
        registry: registryOutcome,
        message: `${result.message ?? ''}${registryOutcome.message ? `；${registryOutcome.message}` : ''}`.trim(),
      }
    }
    // 只勾了注册表行 ⇒ 文件面必须**一个都不碰**（`paths: []` 会被 applyCandidate 解释成
    // "什么都没选"，但传 `undefined` 会解释成"全部" —— 两者都错，所以这里直接早退）。
    if (registryOutcome && Array.isArray(paths) && paths.length > 0 && filePaths.length === 0) {
      this.publish()
      this.markFresh()
      return withRegistry({ ok: true, approved: 0, failed: [], remaining: [], rebased, failures: clearFailures, message: '注册表变更已处理' })
    }
    if (this.workspace.diffEntries().length === 0) {
      return withRegistry({ ok: true, approved: 0, failed: [], remaining: [], rebased, failures: clearFailures, message: '没有待审文件' })
    }
    this.ensureCandidate('approve')
    const ws = this.reload()
    const pending = ws.listReviews()
    const latest = pending[pending.length - 1]
    if (!latest) {
      return withRegistry({ ok: true, approved: 0, failed: [], remaining: [], rebased, failures: clearFailures, message: '没有待审候选' })
    }
    const result = ws.applyCandidate(latest.id, {
      paths: filePaths,
      force: options.force === true,
      // 命中敏感策略时的**二次确认**（面板弹窗 / `/winstage approve --confirm-mask`）
      ...(options.confirmedMasks !== undefined ? { confirmedMasks: options.confirmedMasks } : {}),
    })
    this.publish()
    this.markFresh()
    /**
     * ── WP8.2：**基线冲突**（宿主原件在暂存之后被改过）⇒ 不覆盖，把选择权交回用户 ─────
     *
     * `applyCandidate()` 在有冲突时**一个字节都不写**（整批预检，`applied=[]`），
     * 这里只做两件事：
     *   1. 把冲突清单原样带进返回值（`conflicts` + 人话 `message`），命令面/面板据此
     *      **列出这些路径**，并给出"覆盖 / 放弃"两个出口：
     *        · 覆盖 ⇒ 再次 approve 带 `force:true`（显式知情）；
     *        · 放弃 ⇒ `/winstage reject`（退回宿主原件视图）。
     *   2. 审计面**不闭合**（`failed` 非空 ⇒ 走不到下面的 `decide`）—— 这次决定没有
     *      真正落盘，闭合它会让"账本说已决定、磁盘说没变"。
     */
    const conflicts = Array.isArray(result.conflicts) ? result.conflicts : []
    if (conflicts.length > 0) {
      return withRegistry({
        ok: false,
        candidate: result.id,
        approved: 0,
        failed: result.failed,
        conflicts,
        remaining: result.remaining,
        rebased,
        failures: clearFailures,
        message:
          `有 ${conflicts.length} 个文件在你这次改动被记下之后又被改过，已**拒绝覆盖**（磁盘上一个字节都没改）：` +
          `${conflicts.map((item) => item.path).join('、')}。` +
          '逐条列出在 conflicts 里（含字节数、时间戳与两侧的内容摘要）。' +
          '要用你这次的内容覆盖，请显式确认（批准时带 force）；要放弃，请执行 reject 丢弃本次待审内容。',
      })
    }
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
    return withRegistry({
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
    })
  }

  /**
   * 注册表候选的**懒建**执行面：`sessionDir` = 本会话的存储根。
   *
   * 与文件面共用同一个 `queue.json` / `candidates/`，但 apply/discard 必须走
   * `createRegistryStage()`（它才认识覆盖层与 WAL）。拿不到 `storeDir`
   * （无会话身份的共享存储）时返回 `undefined` —— 调用方据此如实报错，
   * **绝不**假装批准成功。
   */
  registryStage() {
    if (typeof this.storeDir !== 'string' || this.storeDir.length === 0) return undefined
    if (!this._registryStage) {
      this._registryStage = createRegistryStage({
        sessionDir: this.storeDir,
        sessionId: this.sessionId,
        workspaceRoot: this.workspaceRoot,
        reader: createRegExeReader(),
        writer: createRegExeWriter({ wireBytes: registryWireBytes, log: (message) => this.log(message) }),
      })
    }
    return this._registryStage
  }

  /** 内部：批准注册表候选（`selection` 为空 = 全部）。永不抛。 */
  _approveRegistry(selection) {
    const stage = this.registryStage()
    if (!stage) {
      return {
        ok: false,
        approved: 0,
        failed: [{ path: '(registry)', error: 'REG_STORE_DIR_MISSING: 本会话没有存储根，无法应用注册表候选' }],
        message: '注册表候选无法应用（缺 sessionDir）',
      }
    }
    try {
      stage.open()
      const result = stage.apply(Array.isArray(selection) && selection.length > 0 ? { paths: selection } : {})
      const failed = []
      for (const entry of result.failed ?? []) {
        failed.push({ path: entry.path, error: `${entry.status ?? ''} ${entry.reason ?? ''}`.trim() || 'registry-apply-failed' })
      }
      for (const entry of result.blocked ?? []) {
        failed.push({ path: entry.path, error: `${entry.status ?? ''} ${entry.reason ?? ''}`.trim() || 'parent-key-missing' })
      }
      const applied = result.applied ?? []
      return {
        ok: failed.length === 0,
        approved: applied.length,
        failed,
        stale: result.stale ?? [],
        message: `注册表：已应用 ${applied.length} 项${failed.length ? `，失败 ${failed.length} 项` : ''}`,
      }
    } catch (error) {
      const detail = `${error?.code ?? error?.name ?? 'error'}: ${error?.message ?? error}`
      this.logError(`注册表批准失败（如实上报，不假装成功）：${detail}`)
      return { ok: false, approved: 0, failed: [{ path: '(registry)', error: detail }], message: `注册表批准失败：${detail}` }
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
   * @returns {{rebased: string[], discarded: string[], reasons: Record<string,string>, failures: Array}}
   */
  _rebase(paths) {
    this.clearFailures = []
    const ws = this.reload()
    const selected = paths && paths.length > 0 ? new Set(paths.map(compareKey)) : undefined
    const rebased = []
    /** 路径 → 漂移形状（**重述之前**读，重述之后 drift 已归零，读不到） */
    const reasons = {}
    for (const rel of Object.keys(ws.manifest.entries)) {
      if (selected && !selected.has(compareKey(rel))) continue
      const drift = ws.baselineDrift(rel)
      if (!drift.stale) continue
      if (ws.rebaseEntry(rel)) {
        rebased.push(rel)
        reasons[rel] = drift.reason ?? 'baseline-drifted'
      }
    }
    if (rebased.length === 0) return { rebased, discarded: [], reasons, failures: [] }
    ws.store.touch(ws.manifest)
    const affected = new Set(rebased.map(compareKey))
    const netKeys = new Set(ws.diffEntries().map((change) => compareKey(change.path)))
    const discarded = this.reconcileCandidates(ws, { reason: 'rebase', affected, netKeys })
    if (ws.diffEntries().length > 0) this.ensureCandidate('rebase')
    return { rebased, discarded, reasons, failures: this.clearFailures.slice() }
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
          : `已以真实文件为基线重新暂存 ${result.rebased.length} 项` +
            (Object.values(result.reasons || {}).includes('baseline-appeared')
              ? '（其中含"真实文件在暂存之后出现"的条目：现在面板显示的 before 就是磁盘上的真实内容）'
              : ''),
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
    /**
     * 注册表候选的拒绝 = **丢弃覆盖层意图**（`createRegistryStage().discard()`）：
     * 真实 hive 从头到尾没被碰过，所以"拒绝"在这里是零成本的 —— 这正是暂存层的意义。
     * 与 `approve()` 同一套切分：先摘注册表路径，剩下的交回文件面。
     */
    const registryPending = this.reload().listReviews().filter((candidate) => isRegistryCandidate(candidate))
    const registryKeys = new Set(
      registryPending.flatMap((candidate) => (candidate.changes || []).map((change) => compareKey(change.path))),
    )
    const selectedRegistryDiscard = paths && paths.length > 0 ? paths.filter((p) => registryKeys.has(compareKey(p))) : []
    const wantsRegistryDiscard =
      registryPending.length > 0 && ((paths ?? []).length === 0 || selectedRegistryDiscard.length > 0)
    let registryDiscard
    if (wantsRegistryDiscard) {
      const stage = this.registryStage()
      if (stage) {
        try {
          stage.open()
          registryDiscard = stage.discard({ reason: 'user-rejected' })
        } catch (error) {
          const detail = `${error?.code ?? error?.name ?? 'error'}: ${error?.message ?? error}`
          this.logError(`注册表候选丢弃失败（真实 hive 从未被改，故无残留）：${detail}`)
          registryDiscard = { error: detail }
        }
      } else {
        registryDiscard = { error: 'REG_STORE_DIR_MISSING' }
      }
    }
    const rejectPaths =
      wantsRegistryDiscard && paths && paths.length > 0 ? paths.filter((p) => !registryKeys.has(compareKey(p))) : paths
    // 只勾了注册表行 ⇒ 文件面一个都不碰。⚠ 这里**不能**把空数组继续往下传：
    // `paths.length === 0` 在下面的口径里等于"未给路径"= **拒绝全部文件**，那会把
    // 用户没勾的文件改动一起回退掉。所以直接早退并如实回报。
    if (wantsRegistryDiscard && Array.isArray(paths) && paths.length > 0 && rejectPaths.length === 0) {
      this.publish()
      this.markFresh()
      return {
        ok: registryDiscard?.error === undefined,
        rejected: 0,
        paths: [],
        discarded: [],
        registryDiscarded: registryDiscard,
        failures: registryDiscard?.error ? [{ path: '(registry)', error: registryDiscard.error }] : [],
        message: registryDiscard?.error ? `注册表候选丢弃失败：${registryDiscard.error}` : '注册表候选已丢弃（真实注册表从未被改）',
      }
    }
    const ws = this.reload()
    const changes = ws.diffEntries()
    const netKeys = new Set(changes.map((change) => compareKey(change.path)))
    const liveBefore = ws.listReviews()
    const selected = rejectPaths && rejectPaths.length > 0 ? new Set(rejectPaths.map(compareKey)) : undefined

    // 净 diff 已经空了、但队列里还有活候选时**不能**早退：那些候选正是"空壳 pending"，
    // 而"拒绝全部"是用户唯一能清掉它们的出口（否则面板会停在只有冻结存档行的状态里）。
    if (!selected && changes.length === 0 && liveBefore.length === 0) {
      return {
        ok: true,
        rejected: 0,
        paths: [],
        discarded: [],
        ...(registryDiscard ? { registryDiscarded: registryDiscard } : {}),
        message: registryDiscard ? '注册表候选已丢弃' : '没有待审文件',
      }
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
    return {
      ok: true,
      rejected: targets.length,
      paths: targets.map((c) => c.path),
      discarded,
      ...(registryDiscard ? { registryDiscarded: registryDiscard } : {}),
      failures: this.clearFailures.slice(),
    }
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

/**
 * 某会话的存储根（WP2：`resolveReviewStoreDir()` → `resolveStageRoot()`）。
 *
 * ⚠ 契约变化（Phase 1）：**总是返回一个路径**。旧版在"无会话身份"时返回 `undefined`
 * 让调用方去拼工作区里的旧布局 —— 那正是生产默认根没有真正切换过去的原因。
 * 现在无会话身份 ⇒ 共享服务的会话 id（`DEFAULT_REVIEW_SESSION_ID`），
 * 与 `getReviewService({ workspaceRoot })`（不传 sessionId）解析出的根**逐字相同**。
 *
 * `options`（全部可选）：`{ storeDir, stageRoot, env }` —— 显式注入通道，供自测 / CLI / WP1。
 */
export function sessionStoreDir(workspaceRoot, sessionId, options = {}) {
  return resolveReviewStoreDir({
    workspaceRoot,
    sessionId,
    storeDir: options.storeDir,
    stageRoot: options.stageRoot,
    env: options.env,
  })
}

/**
 * 把**升级前**的共享存储（工作区内的旧布局，`legacyWorkspaceStoreDir()`）认领给
 * 第一个需要会话存储的会话。
 *
 * 为什么需要：隔离改造之前，所有暂存内容都写在那个共享根里。不搬的话，用户升级前
 * 的待审内容会变成"谁也看不见"的孤儿。做法是 **move**（同卷 rename，不复制大文件），
 * 并用旧布局下 `sessions/.legacy-claimed` 的 `wx` 创建做"只有第一个会话能认领"的闸。
 * 任何一步失败都静默保留原处（会话拿空存储继续跑），绝不因此让插件起不来。
 *
 * Phase 1 之后这里**只读/只搬走**：目标 `targetDir` 是 `resolveStageRoot()` 给的缓存路径。
 * @returns {boolean} 是否真的搬走了一些东西
 */
function adoptLegacyStore(workspaceRoot, targetDir) {
  try {
    const legacyDir = legacyWorkspaceStoreDir(workspaceRoot)
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

/**
 * 已经在本进程里建好的审阅服务（按 `workspaceRoot#sessionKey` 缓存）。
 *
 * 供宿主侧的**只读轮询复核**使用（`dsh-plugin/baseline-watch.mjs`）：它必须能找到
 * "当前工作区里所有还活着的会话服务"，才能把漂移变化重新发布给面板。
 * 只读：返回快照数组，调用方不得借此改状态。
 */
export function listReviewServices(workspaceRoot) {
  const wanted = workspaceRoot ? canonical(workspaceRoot) : undefined
  const out = []
  for (const service of SERVICES.values()) {
    if (!service || typeof service.reviewDrift !== 'function') continue
    if (wanted && canonical(service.workspaceRoot) !== wanted) continue
    out.push(service)
  }
  return out
}

export function getReviewService(options = {}) {
  if (!options?.workspaceRoot) throw new Error('getReviewService: workspaceRoot is required')
  const root = canonical(options.workspaceRoot)
  const sessionKey = sessionDirKey(options.sessionId)
  const key = sessionKey ? `${root}#${sessionKey}` : root
  let service = SERVICES.get(key)
  if (!service) {
    // ── WP2：生产默认根的**唯一切换点** ─────────────────────────────────────────
    // 旧实现这里是 `sessionKey ? join(root, STORE_DIR, 'sessions', sessionKey) : undefined`
    // —— 两条都在把存储根钉在工作区里。现在一律经 `resolveReviewStoreDir()`
    // → `resolveStageRoot()`（默认 = Windows 缓存里的会话工作根）。
    // 显式 override 通道保留：`options.storeDir`（逐字采用）/ `options.stageRoot` /
    // `options.env`，供离线自测与 WP1 用。
    const storeDir = resolveReviewStoreDir({
      workspaceRoot: root,
      sessionId: options.sessionId,
      storeDir: options.storeDir,
      stageRoot: options.stageRoot,
      env: options.env,
    })
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
