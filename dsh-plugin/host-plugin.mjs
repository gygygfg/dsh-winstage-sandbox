/**
 * WinStageSandbox — DeepSeek Harness 主机插件（命令与审阅面）
 *
 * 职责分工（本包装了两个 loader 行，各自一个模块）：
 *   - 本文件（行 `winstage-sandbox`）：设置开关、启动探测、`/winstage` 命令面；
 *   - `fs-entry.mjs`（行 `winstage-fs`）：`ctx.fs` 的暂存实现（见 `staging-fs.mjs`）。
 * 两行通过 `review-service.mjs` 的进程内单例共享**同一份**暂存清单。
 *
 * ── 面板的数据从哪来（一个必须如实说明的机制约束）─────────────────────────────
 * Client 的 `ctx.remote.<命名空间>` 选集是**构建时固定**的：第三方插件无法在运行时
 * 新增 Remote 命名空间或转发事件（`@deepseek-ai/dsh-api-remotes` 的 README 逐字如此）。
 * 因此本插件用三条**已有**通道：
 *   1. 读（WP3-B 起）：本文件注册一条同源只读路由 `/winstage-panel/{snapshot,trust}`，
 *      **存储根由宿主侧 `resolveReviewStoreDir()` 解析**（Phase 1 起在 Windows 缓存），
 *      客户端只拿逻辑标识（路由名 + 会话 id），不再自己拼旧布局路径；
 *   2. 写：Client 用 `ctx.remote.commands.execute` 调 `/winstage approve|reject`，
 *      命令**不产生模型消息**（`dsh-commands` 的既定语义）；
 *   3. 兼容：路由不可用时（宿主没装 webServer / 未重启）`client.js` 仍可用旧的
 *      `ctx.remote.workspaceFiles.read` 读**升级前**布局的快照 —— 那是**兜底**，
 *      绝不是首选，且只有一条被注释说明的分支。
 *
 * ── WP3：用户侧可信性状态卡（AI 侧零注入）────────────────────────────────────
 * `/winstage status` 输出六个面（档位 / 首次掉档 / 失根 / 未结算审批 / 未确认写入 /
 * 读侧可见性），面板通过 `/winstage-panel/trust` 拿同一份 `buildTrustCard()`。
 * **这些文本只走用户侧通道**：命令自身的 stdout/stderr 与工具输出逐字节不变，
 * 卡片里的暂存路径一律被剥掉（只有逻辑标签 + 存储短哈希）。
 *
 * ── 一个必须如实说明的限制（手册第 0 章证据分层）────────────────────────────
 * `[实测]` WinStageSandbox 的**受限令牌**无法在已被沙箱化的会话里再创建
 * （缺 `TOKEN_ADJUST_DEFAULT` / `TOKEN_ADJUST_SESSIONID`，见 docs/实测证据记录.md
 * 残余边界 R6）。但**暂存不需要受限令牌**：它只要求"变更落暂存树、读取走投影"，
 * 这由 `ctx.fs` 提供方在可信代码里完成。因此本插件不假装 `init()` 成功：
 * `probeRuntime()` 只如实报告"能否建立受限令牌"，而暂存面与它无关、照常工作。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Config } from './schema.js'
import { probeWin32Abi } from '../src/capability.mjs'
import { WindowsStageExecutor, resolveDshModuleRoot } from '../src/executor.mjs'
import { compareKey } from '../src/paths.mjs'
import { renderCandidateDiff } from '../src/tools.mjs'
import { verifyStageRootAlive } from '../src/stage-guard.mjs'
import { REVIEW_BASENAME, getReviewService, resolveReviewStoreDir } from './review-service.mjs'
import { installBaselineWatch } from './baseline-watch.mjs'
import { createAuditMirror } from './audit-mirror.mjs'
import { createRunCapture } from './run-capture.mjs'
// ★ BUG-B：档位（lane）判定的**同一份**分类与结论口径。只 import 纯函数/常量，
//   不 import 执行器类；`shell-executor.mjs` 反过来**不**依赖本模块（无环）。
// ★ WP3：在同一份产物上补"历史"（首次掉档 / 是否曾掉档 / 失根次数）——
//   `history` 由 `persistLane()` 写、由这里的读侧解释，**不另造第二份状态**。
import {
  LANE_JOURNAL_BASENAME,
  noteStageRootLoss,
  readLaneJournalFile,
  summarizeLane,
  summarizeLaneHistory,
} from './shell-executor.mjs'

export { Config }

export const name = 'winstage-sandbox'

/** Host 服务依赖：`commands` 可选（用 `ctx.inject` 惰性注册，缺失时不影响加载） */
export const inject = []

function makeLog(ctx) {
  const logger = ctx?.logger
  if (logger && typeof logger.info === 'function') {
    return {
      info: (msg) => logger.info(msg),
      warn: (msg) => (typeof logger.warn === 'function' ? logger.warn(msg) : logger.info(msg)),
    }
  }
  // 没有 logger 时退回 console —— 安装结果才是权威，但至少别静默
  return {
    info: (msg) => console.log(`[winstage-sandbox] ${msg}`),
    warn: (msg) => console.warn(`[winstage-sandbox] ${msg}`),
  }
}

/**
 * 真实能力探测（同步、不创建沙箱）。
 *
 * 只回答一个问题：**本会话能不能建立受限令牌与 ACL 授予**。
 * 这只影响"沙箱内跑命令"（`WindowsStageExecutor`），**不影响暂存面**。
 */
export function probeRuntime() {
  const result = {
    tokenRights: undefined,
    canMintRestrictedToken: false,
    missingRights: [],
    moduleRoots: [],
    ready: false,
    detail: '',
  }
  try {
    result.moduleRoots = resolveDshModuleRoot()
  } catch (error) {
    result.detail = `无法解析依赖位置: ${error.message}`
    return result
  }
  try {
    const caps = WindowsStageExecutor.capabilities()
    if (!caps.aclAvailable) {
      result.detail = `ACL 后端不可加载: ${caps.aclError ?? 'unknown'}`
      return result
    }
    const abi = probeWin32Abi()
    const rights = abi?.checks?.tokenRights?.granted ?? {}
    result.tokenRights = rights
    result.missingRights = Object.entries(rights)
      .filter(([, granted]) => !granted)
      .map(([right]) => right)
    result.canMintRestrictedToken = abi?.checks?.createRestrictedTokenViable?.status === 'pass'
    result.ready = result.canMintRestrictedToken
    result.detail = result.ready
      ? '本会话可以建立受限令牌，WinStageSandbox 的沙箱执行面可用'
      : `本会话无法建立受限令牌（缺少 ${result.missingRights.join(', ')}）。` +
        '这只影响"沙箱内跑命令"，暂存面不受影响。'
  } catch (error) {
    result.detail = `探测抛错: ${error.message}`
  }
  return result
}

// ==================== 命令面 ====================

/**
 * 按空白切分命令行参数，**支持双引号**（路径里的空格必须能表达）。
 *
 * `rawInput` 的契约是"命令名之后的每一个字节，包括分隔空白"，所以调用方
 * 必须先 trim 再切分。引号处理不是装饰：真实路径经常含空格，切不开就会把
 * 一个路径拆成两个不存在的参数。
 */
export function splitArgs(rawInput) {
  const out = []
  let current = ''
  let quoted = false
  for (const ch of String(rawInput ?? '')) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * 解析**伞形**命令 `/winstage <子命令> [参数…]`。
 *
 * 注意：单用途命令（`/winstage-approve <路径…>`）**不能**用这个函数 ——
 * 它的第一个词就是路径，不是子命令。早期版本对两者用同一个解析器，
 * 结果 `/winstage approve src/a.mjs` 的 `args` 为空 → **批准了全部待审文件**。
 * 这是自测抓到的真实缺陷，修复方式是把"子命令归属"写进命令规格。
 */
export function parseInvocation(rawInput) {
  const parts = splitArgs(rawInput)
  if (parts.length === 0) return { subcommand: 'list', args: [] }
  return { subcommand: parts[0].toLowerCase(), args: parts.slice(1) }
}

/** 把一个参数匹配到待审路径（精确相对路径，或"不含分隔符 → 匹配 basename"） */
export function matchPaths(changes, args) {
  if (!args || args.length === 0) return []
  const wanted = args.map((arg) => compareKey(arg.replace(/^\.?[\\/]/, '')))
  return changes.filter((change) => {
    const key = compareKey(change.path)
    const base = key.split(/[\\/]/).pop()
    return wanted.some((want) => want === key || (want.indexOf('\\') < 0 && want.indexOf('/') < 0 && want === base))
  })
}

/**
 * 漂移形状 → 命令面里的短标签（与 `review-service.mjs` 的 `driftReasonOf()` 同字面量）。
 *
 * 缺陷②（F5b）：`baseline-appeared` 是"基线 = absent（新增）而真实文件在暂存之后出现"
 * 这一档 —— 它过去**完全不可见**，批准会静默覆盖磁盘上那份内容。命令面必须把形状
 * 说出来，用户才知道"先看 before/after 再决定"而不是直接点批准。
 */
export function staleShapeText(code) {
  if (code === 'baseline-appeared') return '· 真实文件在暂存后出现'
  if (code === 'baseline-deleted') return '· 真实文件被外部删除'
  if (code === 'baseline-drifted') return '· 真实文件被外部改写'
  return ''
}

/**
 * @param service 审阅服务
 * @param [snapshot] 已构建的快照（**可选**）。`/winstage status` 一次调用要同时渲染
 *   清单与状态卡，两处都用同一份快照 —— 否则 `publish()` 会被跑两遍，快照的
 *   `generatedAt` 还会差一版（清单与卡片各说一个时间戳）。
 */
export function formatList(service, snapshot) {
  const snap = snapshot ?? service.snapshot()
  if (!snap.pending) return 'WinStage 暂存区没有待审改动（改了文件之后会自动出现在这里）'
  const lines = [
    `WinStage 暂存待审  ${snap.counts.files} 个文件  +${snap.counts.additions} / −${snap.counts.deletions}`,
  ]
  if (snap.counts.frozenOnly > 0) {
    // D1：冻结存档行也要出现在 CLI 清单里，并**逐行标明不可批准** —— 否则
    // "N 个文件"与"能批准几个"会对不上，读的人会以为勾了就能写。
    lines.push(`  其中 ${snap.counts.frozenOnly} 个已不在当前净 diff（仅存档，不可批准）`)
  }
  if ((snap.counts.staleBaseline ?? 0) > 0) {
    // "多轮修改后视图不一致"：真实文件在暂存之后被外部改过，直接批准会被拒绝。
    // 清单里必须**说出来**，否则用户只会看到一条必然失败的"批准"。
    // ★ 缺陷②（F5b）：还要说**形状**（`baseline-appeared` = 磁盘上多出一份内容、
    //   基线本为"不存在"）。这条形状过去没有任何可见性，批准会把它静默覆盖。
    const lossy = snap.counts.staleBaselineLossy ?? 0
    lines.push(
      `  其中 ${snap.counts.staleBaseline} 项基线已过期（真实文件在暂存之后被外部改动过）：` +
        '直接批准会被拒绝；用 /winstage rebase [路径…] 以真实文件为基线重新暂存。',
    )
    if (lossy > 0) {
      lines.push(
        `  ⚠ 其中 ${lossy} 项会覆盖真实磁盘上**已存在**的内容（真实文件不是空基线）：` +
          '批准已按 STALE_BASELINE 拒绝，先 rebase 看清 before/after 再决定，或 /winstage reject 丢弃这份暂存。',
      )
    }
  }
  for (const file of snap.files) {
    const frozen = file.frozenOnly === true ? '   [已不在净 diff · 不可批准]' : ''
    const stale = file.baselineStale === true ? `   [基线已过期${staleShapeText(file.baselineStaleCode)} · 先 rebase]` : ''
    lines.push(`  ${file.op.padEnd(7)} ${file.path}   +${file.totals.added} / −${file.totals.removed}${frozen}${stale}`)
  }
  if (snap.truncated) {
    // 只写"列表已截断"不够：用户看到 40 行却不知道**到底还有多少**。
    // `counts.files` 现在是**截断前全量**、`counts.listed` 是实际列出行数，
    // 两者相减即被隐藏的条数（这正是"审批不显示"修复后新增的可见性）。
    const total = snap.counts.files
    const shown = snap.counts.listed ?? snap.files.length
    const hidden = Math.max(0, total - shown)
    lines.push(hidden > 0
      ? `  …（列表已截断：共 ${total} 项，已显示 ${shown} 项，**还有 ${hidden} 项未显示**；用 /winstage diff <路径> 或按路径批准）`
      : '  …（列表已截断）')
  }
  lines.push(`候选 ${snap.candidateId ?? '(未冻结)'} · 工作区 ${snap.workspaceRoot}`)
  lines.push(
    '用 /winstage diff <路径> 看改动；/winstage approve [路径…] 写入真实工作区；' +
      '/winstage rebase [路径…] 以真实文件为基线重新暂存（基线过期时）；/winstage reject [路径…] 退回真实磁盘',
  )
  return lines.join('\n')
}

export function formatDiff(service, args) {
  const ws = service.reload()
  const changes = ws.diffEntries()
  if (changes.length === 0) return 'WinStage 暂存区没有待审改动'
  const wanted = args && args.length > 0 ? matchPaths(changes, args) : changes
  if (wanted.length === 0) return `没有匹配的待审路径：${args.join(' ')}`
  const lines = []
  for (const change of wanted) {
    lines.push(`--- ${change.op} ${change.path}`)
    for (const line of renderCandidateDiff(ws.store, { changes: [change] }, { maxLines: 120 })) {
      if (line.type === 'add') lines.push(`+ ${line.text}`)
      else if (line.type === 'remove') lines.push(`- ${line.text}`)
      else if (line.type === 'note') lines.push(`  (${line.text})`)
    }
  }
  return lines.join('\n')
}

/**
 * ── BUG-B：`/winstage status` 必须回答"沙箱到底生效了没有" ────────────────────
 *
 * 事故形态（已确证）：`tier:'auto'` 的透明垫片探测不过 ⇒ `selectLaunchMode()`
 * fail-closed 回退受限令牌档 ⇒ **没有 shim** ⇒ 写入只剩内核硬拒、子进程 stdio 被掐断。
 * 而会话内表现与"一切正常"**一模一样**（`WINSTAGE_STAGE_ROOT` 为空、`node -v` 静默空输出），
 * 用户与模型都看不出沙箱已经退化 —— 本仓库最忌讳的静默失败。
 *
 * 因此这里读执行器落下的**结构化产物**（`<会话存储根>/sandbox-lane.json`，
 * 由 `shell-executor.mjs` 的 `persistLane()` 写），并把结论**明说**一句。
 * ⚠ 本段只出现在 `/winstage status` 的命令文本里（人工/命令通道），
 * 绝不进命令自身的 stdout/stderr —— 零痕迹契约不变。
 */
export function readLaneJournal(service) {
  const dir = service?.workspace?.store?.dir
  if (typeof dir !== 'string' || dir.length === 0) {
    return { available: false, reason: 'no-store-dir', file: undefined }
  }
  // WP3：读法只有**一处**（`shell-executor.mjs::readLaneJournalFile()`）——
  // 与执行器的写入侧同一份实现，读侧不再自己拼文件名/自己 JSON.parse。
  return readLaneJournalFile(dir)
}

// ═══════════════════════════════════════════════════════════════════════════
// WP3：用户侧**可信性状态卡**（六个面，机读 + 人读两用）
// ═══════════════════════════════════════════════════════════════════════════
//
// ── owner 已定的模型（照做，不得偏离）────────────────────────────────────────
//   · **AI 侧必须意识不到沙箱**：本文件产出的这些文本**只走用户侧通道**
//     （`/winstage status` 的命令文本、面板）。**绝不**进命令自身的 stdout/stderr、
//     也绝不进任何工具可见载荷 —— 零痕迹契约不破。
//   · 沙箱信息只在用户侧；不做 `stage where`，不向用户暴露暂存文件清单。
//   · 卡片里**不出现任何暂存绝对路径**（连产物文件路径也不出现）：机读侧用
//     `storeHash`（存储根路径的短哈希）做关联，人读侧只给"会话工作根"这类**逻辑**标签。
//     这一条是硬要求：命令文本会进会话日志，路径一旦写进去就再也收不回来。
//
// 六个面：①档位 ②首次掉档 ③失根 ④未结算审批 ⑤未确认写入 ⑥读侧可见性。
// 前两个面的**真值来源**是 `sandbox-lane.json`（`persistLane` 写、`summary`/`history`），
// 这里只做解释与呈现，**不重造**判据（`summarizeLane` / `summarizeLaneHistory` 同一份实现）。

/** 存储根路径的**短哈希**：让机读侧能关联"是哪一份存储"而不泄漏路径本身（FNV-1a 32 位） */
export function storeHash(dir) {
  const text = typeof dir === 'string' ? dir : ''
  if (text.length === 0) return null
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 面 ④：**未结算审批** —— 会话日志里 `approval/asked` 没有配对的 `approval/decided`。
 *
 * 为什么读会话事件而不是自己记账：审计对（`audit-mirror.mjs`）本来就写进**会话日志**
 * （与原生审批同一对事件名、同一套 id）。从同一份真相上读，"未结算"就与原生审批的
 * 孤儿检测同一口径；自己再存一份必然漂移。
 *
 * 本轮实测形态：会话卡在"问过但没人答"上，用户在命令面与面板上**都看不出**这件事。
 *
 * 纯函数（只调 `session.eventAt()`），读不到会话时如实返回 `available:false`。
 * @returns {{available: boolean, scanned: number, unsettledCount: number, unsettled: Array<object>, reason?: string}}
 */
export function summarizeUnsettledApprovals(session) {
  const empty = { available: false, scanned: 0, unsettledCount: 0, unsettled: [] }
  if (!session || typeof session.eventAt !== 'function') {
    return { ...empty, reason: 'no-session' }
  }
  const seq = Number(session.seq)
  if (!Number.isFinite(seq) || seq <= 0) return { ...empty, available: true, reason: 'no-events' }
  const open = new Map()
  let scanned = 0
  for (let i = 0; i < seq; i += 1) {
    let event
    try {
      event = session.eventAt(i)
    } catch {
      break
    }
    if (!event || typeof event !== 'object') continue
    scanned += 1
    const id = event?.data?.id
    if (typeof id !== 'string' || id.length === 0) continue
    if (event.type === 'approval/asked') {
      if (!open.has(id)) open.set(id, { id, reason: event?.data?.reason ?? null, toolName: event?.data?.toolName ?? null, seq: i })
    } else if (event.type === 'approval/decided') {
      open.delete(id)
    }
  }
  const unsettled = [...open.values()].sort((a, b) => a.seq - b.seq)
  return { available: true, scanned, unsettledCount: unsettled.length, unsettled }
}

/**
 * 面 ⑤：**未确认写入**（WP2 面，`staging_write_not_persisted`）。
 *
 * 真值来源是**清单条目**：`staging-fs.mjs::verifyPersistedWrite()` 回读闸门失败时把
 * `entry.persistenceFailure = { at, hash, stagedPath, problems }` 记进清单并 `touch()` 落盘。
 * 这里只**读**那份记账 —— 不重造判据、不碰 `staging-fs.mjs`。
 *
 * ⚠ `stagedPath` **不进卡片**（它是暂存落点）：这里只取 `at` / `hash` / `problems` / 条目键。
 * ⚠ 诚实声明：清单条目被后续成功写入取代时该记账会随之消失 ⇒ 本面是"**最近一次已知**"，
 *   不是"历史上发生过几次"的审计（机读字段 `note` 如实写明）。
 *
 * @param {string|undefined} manifestPath 清单文件绝对路径（`store.manifestPath`）
 */
export function summarizeUnpersistedWrites(manifestPath) {
  const empty = { available: false, count: 0, items: [], last: null }
  if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
    return { ...empty, reason: 'no-manifest-path' }
  }
  if (!existsSync(manifestPath)) return { ...empty, available: true, reason: 'no-manifest' }
  let manifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    return { ...empty, reason: `manifest-unreadable: ${error?.message ?? error}` }
  }
  const entries = manifest?.entries && typeof manifest.entries === 'object' ? manifest.entries : {}
  const items = []
  for (const [key, entry] of Object.entries(entries)) {
    const failure = entry?.persistenceFailure
    if (!failure || typeof failure !== 'object') continue
    items.push({
      path: key,
      at: failure.at ?? null,
      hash: failure.hash ?? null,
      // `problems` 是**结构化检查项**（例如 `manifest-not-persisted`），不含路径片段
      problems: Array.isArray(failure.problems)
        ? failure.problems.map((p) => ({ check: p?.check ?? 'unknown', detail: p?.detail ?? null }))
        : [],
    })
  }
  items.sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')))
  return {
    available: true,
    count: items.length,
    items,
    last: items.length > 0 ? items[items.length - 1] : null,
    note: '只反映**清单里仍然留着**的未确认写入（被后续成功写入取代后该记账会消失）；不构成历史审计。',
  }
}

/** 面 ⑥：读侧可见性摘要（WP4 面）—— 从快照的 `readVisibility` 段收敛成一行+机读字段 */
export function summarizeReadVisibility(readVisibility) {
  const rv = readVisibility && typeof readVisibility === 'object' ? readVisibility : undefined
  if (!rv) return { available: false, policy: null, objects: 0, reads: 0, truncated: false, topMaskIds: [], note: null }
  const byMaskId = rv.byMaskId && typeof rv.byMaskId === 'object' ? rv.byMaskId : {}
  const topMaskIds = Object.entries(byMaskId)
    .map(([maskId, count]) => ({ maskId, count: Number(count) || 0 }))
    .sort((a, b) => b.count - a.count || (a.maskId < b.maskId ? -1 : 1))
  return {
    available: true,
    policy: rv.policy ?? null,
    objects: Number(rv.objects) || 0,
    reads: Number(rv.reads) || 0,
    truncated: rv.truncated === true,
    topMaskIds,
    note: typeof rv.note === 'string' ? rv.note : null,
  }
}

/**
 * 组装**可信性状态卡**（机读对象；人读渲染见 `formatTrustCard()`）。
 *
 * 六个面全部**总是有键**（拿不到就 `available:false` + `reason`），因为这张卡是
 * "机读 + 人读两用"：机读侧不许出现"字段偶尔消失"的形态。
 *
 * @param {{service?: object, session?: object, snapshot?: object, env?: object, now?: string}} options
 *   `service` = 审阅服务（取存储根/清单）；`session` = 会话句柄（面④读事件）；
 *   `snapshot` = 已发布的快照（面⑥读 `readVisibility`；不传就如实标 `available:false`）
 */
export function buildTrustCard(options = {}) {
  const service = options.service
  const store = service?.workspace?.store
  const dir =
    typeof store?.dir === 'string' && store.dir.length > 0
      ? store.dir
      : typeof options.storeDir === 'string' && options.storeDir.length > 0
        ? options.storeDir
        : undefined

  // ── 面 ①②：档位 + 首次掉档（真值来源 = `sandbox-lane.json`，判据与执行器同一份）──
  const journal = readLaneJournalFile(dir)
  const record = journal.available ? journal.record ?? {} : undefined
  const lane = summarizeLane(record ?? {})
  const history = summarizeLaneHistory(record)
  const tier = {
    /** 产物是否存在（= 有没有命令真的经过本执行器） */
    recorded: journal.available,
    recordedReason: journal.reason,
    at: record?.at ?? null,
    launchMode: lane.launchMode,
    tierEffective: lane.tierEffective,
    requestedTier: lane.requestedTier,
    winStageEnabled: lane.winStageEnabled,
    fallbackClass: lane.fallback,
    fallbackText: lane.fallbackText,
    fallbackReasonRaw: record?.fallbackReason ?? null,
    status: lane.status,
    degraded: lane.degraded,
    conclusion: lane.conclusion,
  }
  const firstDegrade = {
    everDegraded: history.everDegraded,
    at: history.firstDegrade?.at ?? null,
    seq: history.firstDegrade?.seq ?? null,
    launchMode: history.firstDegrade?.launchMode ?? null,
    tierEffective: history.firstDegrade?.tierEffective ?? null,
    fallbackClass: history.firstDegrade?.fallbackClass ?? null,
    fallbackReason: history.firstDegrade?.fallbackReason ?? null,
    degradeCount: history.degradeCount,
    shimCount: history.shimCount,
    commandSeq: history.commandSeq,
  }

  // ── 面 ③：失根（**活体查询** + 观测历史）───────────────────────────────────
  let live
  if (store && typeof store.stageStatus === 'function') {
    try {
      live = store.stageStatus()
    } catch (error) {
      live = { alive: false, reason: `status-threw: ${error?.message ?? error}` }
    }
  } else if (dir !== undefined) {
    live = verifyStageRootAlive(dir)
  }
  const checked = live !== undefined
  const aliveNow = checked ? live.alive === true : null
  /**
   * ★ **"还没建根" 与 "根丢了" 是两件事**（本卡最容易误报的一处）。
   *
   * 会话还没跑过任何命令时，存储根本来就**不存在** —— 那时 `verifyStageRootAlive()`
   * 答 `root-missing`。把它当成"失根"会对着一个"一切正常、只是还没用过"的会话报警，
   * 而误报的告警与静默失败一样有害（用户学会忽略它）。
   *
   * 判据：根**曾经存在过**（有档位产物 ⇒ 至少跑过一次；或活体查询给出的不是
   * `root-missing`/`root-not-directory`）才算"丢"。
   */
  const rootMissing = checked && live.alive !== true && (live.reason === 'root-missing' || live.reason === 'root-not-directory')
  const everCreated = journal.available || (checked && !rootMissing)
  const lossRelevant = checked && aliveNow !== true && everCreated
  let rootLoss = history.rootLoss
  if (lossRelevant) {
    // 观测点②：用户查看状态也是一次观测（与命令执行前同一个记账函数）
    const entry = noteStageRootLoss(dir, { reason: live.reason ?? 'not-alive', phase: 'status' })
    if (entry) {
      rootLoss = {
        everLost: true,
        count: entry.count,
        lastReason: entry.lastReason,
        lastAt: entry.lastAt,
        lastPhase: entry.lastPhase,
        lastSeq: entry.lastSeq,
        observedAt: entry.observedAt,
      }
    }
  }
  const stageRoot = {
    checked,
    alive: aliveNow,
    reason: live?.reason ?? null,
    /** `never-created` = 根还没建（不是故障）；其余取值即 `verifyStageRootAlive()` 的 reason */
    reasonCode: rootMissing && !everCreated ? 'never-created' : live?.reason ?? null,
    guarded: live?.guarded ?? null,
    everCreated,
    lossRelevant,
    everLost: rootLoss?.everLost === true,
    lossCount: rootLoss?.count ?? 0,
    lastLossAt: rootLoss?.lastAt ?? null,
    lastLossReason: rootLoss?.lastReason ?? null,
    lastLossPhase: rootLoss?.lastPhase ?? null,
    lastLossSeq: rootLoss?.lastSeq ?? null,
    observedAt: Array.isArray(rootLoss?.observedAt) ? [...rootLoss.observedAt] : [],
    note: '失根次数是**被观测到**的次数（观测点：命令执行前 / 用户查看状态时），不是完整审计；"根还没建"不算失根。',
  }

  // ── 面 ④⑤⑥ ────────────────────────────────────────────────────────────────
  const approvals = summarizeUnsettledApprovals(options.session)
  const manifestPath =
    typeof store?.manifestPath === 'string' && store.manifestPath.length > 0 ? store.manifestPath : dir ? join(dir, 'manifest.json') : undefined
  const writes = summarizeUnpersistedWrites(manifestPath)
  const readVisibility = summarizeReadVisibility(options.snapshot?.readVisibility)

  // ── 一句话结论（严重度顺序：失根 > 掉档 > 写入未确认 > 档位未知 > 关闭 > 有事项 > 可信）──
  const blockers = []
  let level
  if (stageRoot.lossRelevant) {
    level = 'lost'
    blockers.push({ code: 'stage-root-lost', detail: stageRoot.reason })
  } else if (tier.winStageEnabled !== false && tier.status === 'degraded') {
    level = 'degraded'
    blockers.push({ code: 'lane-degraded', detail: tier.fallbackClass })
  } else if (writes.count > 0) {
    level = 'write-unconfirmed'
    blockers.push({ code: 'unpersisted-write', detail: writes.last?.path ?? null })
  // ★ `off` 必须**先于** `unknown`：开关被显式关掉时，"没有档位记录"是**预期形态**而不是告警
  //   （owner 模型：关态属预期；BUG-B 的原始设计也是"关态不静默、也不谎报告警"）。
  //   反例（改前）：关态 + 无记录 ⇒ 落到 `unknown` ⇒ `ok=false` ⇒ kind=error，用户会被假告警误导。
  } else if (tier.winStageEnabled === false) {
    level = 'off'
    blockers.push({ code: 'sandbox-off', detail: null })
  } else if (tier.status === 'unknown') {
    level = 'unknown'
    blockers.push({ code: tier.recorded ? 'lane-unknown' : 'lane-unrecorded', detail: tier.recordedReason })
  } else if (approvals.unsettledCount > 0 || readVisibility.reads > 0) {
    level = 'attention'
    if (approvals.unsettledCount > 0) blockers.push({ code: 'unsettled-approval', detail: approvals.unsettledCount })
    if (readVisibility.reads > 0) blockers.push({ code: 'sensitive-reads', detail: readVisibility.reads })
  } else {
    level = 'trusted'
  }
  const ok = level === 'trusted' || level === 'off' || level === 'attention'
  const conclusion =
    level === 'lost'
      ? `沙箱此刻**不可信**：会话工作根已不可用（${stageRoot.reason ?? '原因未知'}）——写入会以 STAGE_ROOT_LOST 失败，不会静默改写真实文件。`
      : level === 'degraded'
        ? `沙箱此刻**不可信**：档位回退到 ${tier.launchMode ?? '(未报出)'}，没有去令牌化通道 —— 写入只剩内核硬拒、命令产出不进暂存。`
        : level === 'write-unconfirmed'
          ? `沙箱档位正常，但有 ${writes.count} 次写入**没有确认落盘**（最近一次：${writes.last?.path ?? '未知'}）——那次写入不应当成已完成。`
          : level === 'unknown'
            ? '沙箱档位**未知**：本会话还没有一次档位判定经过本执行器 —— 按"未证实已生效"对待。'
            : level === 'off'
              ? `沙箱**关闭**（属预期）：档位=${tier.launchMode ?? '(未报出)'}，本执行器不接管暂存面，此形态仅作记录。`
              : level === 'attention'
                ? `沙箱档位正常（已生效），但有 ${blockers.length} 类**待处理事项**：${blockers.map((b) => b.code).join('、')}。`
                : '沙箱此刻**可信**：命令走去令牌化通道，文件/注册表写入先落暂存、批准后才写真实磁盘。'

  return {
    kind: 'winstage-trust-card',
    version: 1,
    at: typeof options.now === 'string' ? options.now : new Date().toISOString(),
    /** 存储根的**短哈希**（关联用；**不是**路径 —— 路径绝不进卡片） */
    storeHash: storeHash(dir),
    storeLabel: dir ? '会话工作根（Windows 缓存）' : '（无会话存储根）',
    tier,
    firstDegrade,
    stageRoot,
    approvals,
    writes,
    readVisibility,
    trust: { level, ok, blockers },
    conclusion,
  }
}

/** 面 ①②的人读渲染（`formatLaneSection()` 与状态卡共用同一份，不写第二份文案） */
function formatTierLines(card) {
  const { tier, firstDegrade } = card
  const lines = ['【沙箱档位与降级告警】']
  if (!tier.recorded) {
    lines.push(`  · 没有档位判定记录（${tier.recordedReason}）`)
    lines.push(
      '  · 结论：**尚未证实沙箱真的生效**（档位判定只在命令执行时产生）。' +
        '跑一条 pwsh 命令（例如 `node -v`）后再看这里；若那时仍无记录，说明命令没有经过 WinStage 执行器。',
    )
    return lines
  }
  lines.push(`  · 最近一次判定：${tier.at ?? '（无时间戳）'}`)
  lines.push(
    `  · lane（launchMode）= ${tier.launchMode ?? '（未报出）'}；tierEffective = ${tier.tierEffective ?? '（未报出）'}；` +
      `请求档位 = ${tier.requestedTier ?? '（未报出）'}；WinStage 开关 = ${tier.winStageEnabled ? '开' : '关'}`,
  )
  lines.push(`  · 回退分类 = ${tier.fallbackClass}${tier.fallbackText ? ` — ${tier.fallbackText}` : ''}`)
  lines.push(`  · 原始 fallbackReason = ${tier.fallbackReasonRaw ?? '（无）'}`)
  lines.push(`  · 结论：${tier.conclusion}`)
  // ★ WP3 新增的第 2 个面：**首次掉档**（"是否曾掉档"只有历史答得了）
  lines.push(
    firstDegrade.everDegraded
      ? `  · 首次掉档：${firstDegrade.at ?? '（无时间戳）'}（第 ${firstDegrade.seq ?? '?'} 条命令）` +
        `，launchMode=${firstDegrade.launchMode ?? '?'}，分类=${firstDegrade.fallbackClass ?? '?'}` +
        `；本会话累计掉档 ${firstDegrade.degradeCount} 次 / 正常 ${firstDegrade.shimCount} 次` +
        `（共 ${firstDegrade.commandSeq ?? '?'} 次判定）`
      : `  · 首次掉档：**没有掉过档**（本会话 ${firstDegrade.commandSeq ?? '?'} 次判定全部走 shim 通道）`,
  )
  if (tier.status === 'degraded') {
    lines.push(
      '  · 处置：① 查 shim 产物是否齐备（DLL / winstage-inject.exe / winstage-probe.exe）；' +
        '② 查探测证据（暂存根下的 shim.log 与能力探测输出）；' +
        '③ 在修好之前，本窗口的写入结果按"可能只剩内核硬拒"对待，**不要**当成沙箱内成功。',
    )
  }
  return lines
}

/**
 * 渲染"沙箱档位与降级告警"一段（**保留导出**：既有调用方/文档用它，语义不变 ——
 * 最危险的形态（`launchMode !== 'shim'` 且开关为开）返回 `kind:'error'`，命令文本要显眼）。
 *
 * WP3 起它是状态卡的①②两个面的**同一份**渲染（`formatTierLines`），不再自己读产物。
 *
 * @returns {{kind: 'success'|'error', text: string}}
 */
export function formatLaneSection(service) {
  const card = buildTrustCard({ service })
  const status = card.tier.status
  return {
    kind: status === 'degraded' ? 'error' : 'success',
    text: formatTierLines(card).join('\n'),
  }
}

/** 状态卡 → **人读文本**（机读对象见 `buildTrustCard()`；两者同一份数据，不各算一次） */
export function formatTrustCard(card) {
  const { tier, firstDegrade, stageRoot, approvals, writes, readVisibility, trust } = card
  const lines = [`【WinStage 可信性状态卡】 生成于 ${card.at}`]
  lines.push(`  结论：${card.conclusion}`)
  lines.push(
    `  机读：level=${trust.level} ok=${trust.ok} …` +
      `store=${card.storeHash ?? '(none)'} markers=${trust.blockers.map((b) => b.code).join(',') || '(none)'}`,
  )
  lines.push('')
  lines.push('① 档位')
  for (const line of formatTierLines(card).slice(1)) lines.push(line)
  lines.push('')
  lines.push('② 首次掉档 / 是否曾掉档')
  lines.push(
    `  · 是否曾掉档 = ${firstDegrade.everDegraded ? '是' : '否'}；首次 = ${firstDegrade.at ?? '（无）'}` +
      `；命令序号 = ${firstDegrade.seq ?? '（无）'}；原因分类 = ${firstDegrade.fallbackClass ?? '（无）'}`,
  )
  lines.push(`  · 计数：掉档 ${firstDegrade.degradeCount} 次 / 走 shim ${firstDegrade.shimCount} 次（判定总数 ${firstDegrade.commandSeq ?? 0}）`)
  if (firstDegrade.fallbackReason) lines.push(`  · 首次原因原文 = ${firstDegrade.fallbackReason}`)
  lines.push('')
  lines.push('③ 失根')
  lines.push(
    `  · 此刻 = ${
      !stageRoot.checked
        ? '（未检查：没有会话存储根）'
        : stageRoot.alive
          ? '存活'
          : stageRoot.reasonCode === 'never-created'
            ? '尚未建立（本会话还没有过暂存写入 —— **不是**故障）'
            : `**不可用**（${stageRoot.reason}）`
    }；是否发生过 = ${stageRoot.everLost ? '是' : '否'}；次数 = ${stageRoot.lossCount}`,
  )
  if (stageRoot.everLost) {
    lines.push(`  · 最近一次：${stageRoot.lastLossAt ?? '（无时间戳）'}（${stageRoot.lastLossReason ?? '原因未知'}，观测点=${stageRoot.lastLossPhase ?? '?'}，命令序号=${stageRoot.lastLossSeq ?? '?'}）`)
  }
  lines.push(`  · 口径：${stageRoot.note}`)
  lines.push('')
  lines.push('④ 未结算审批')
  lines.push(
    approvals.available
      ? `  · 有 ${approvals.unsettledCount} 项 \`approval/asked\` 没有应答（扫过 ${approvals.scanned} 条会话事件）` +
        `${approvals.unsettledCount > 0 ? '：会话可能正卡在等待决策上' : ''}`
      : `  · 读不到会话事件（${approvals.reason ?? 'unknown'}）——这一面**未知**，不是"没有"。`,
  )
  for (const item of approvals.unsettled.slice(0, 5)) {
    lines.push(`    · ${item.id}${item.reason ? ` — ${item.reason}` : ''}`)
  }
  lines.push('')
  lines.push('⑤ 未确认写入（staging_write_not_persisted）')
  lines.push(
    writes.available
      ? `  · 清单里还留着 ${writes.count} 条未确认写入` +
        `${writes.last ? `：最近 ${writes.last.at ?? '（无时间戳）'} 的 ${writes.last.path}` : ''}`
      : `  · 读不到清单（${writes.reason ?? 'unknown'}）——这一面**未知**，不是"没有"。`,
  )
  if (writes.last?.problems?.length) {
    lines.push(`    · 检查项：${writes.last.problems.map((p) => p.check).join('、')}`)
  }
  if (writes.available) lines.push(`  · 口径：${writes.note}`)
  lines.push('')
  lines.push('⑥ 读侧可见性')
  lines.push(
    readVisibility.available
      ? `  · 策略=${readVisibility.policy ?? '?'}；去重对象 ${readVisibility.objects} 个；读取 ${readVisibility.reads} 次` +
        `${readVisibility.truncated ? '（已达条目上限，计数只累计不再新增）' : ''}` +
        `${readVisibility.topMaskIds.length > 0 ? `；按类：${readVisibility.topMaskIds.map((x) => `${x.maskId}×${x.count}`).join('、')}` : ''}`
      : '  · 还没有已发布的快照，这一面暂无数据（**不是**"没有敏感读"）。',
  )
  lines.push('')
  lines.push('  说明：本卡片只走**用户侧**通道（/winstage status 文本、面板）；命令自身的 stdout/stderr 与工具输出**逐字节不变**，不含本卡任何内容。')
  return lines.join('\n')
}

// ═══════════════════════════════════════════════════════════════════════════
// WP3-B：面板**读侧路径对齐**（宿主侧解析 + 逻辑标识，客户端不再拼旧布局）
// ═══════════════════════════════════════════════════════════════════════════
//
// 缺口（实测）：存储根已迁到 Windows 缓存（`resolveStageRoot()`），而 `client.js` 仍按
// **旧布局**拼 `<workspaceRoot>/.dshstage/sessions/<键>/review.json` ⇒ 面板永远读不到
// 新根里的快照（读到的是"没有待审"，或者更糟：升级前遗留的**旧**快照）。
//
// 修法：把"存储根在哪"这一判断**收回宿主侧**，且只有一条解析路径
// （`review-service.mjs::resolveReviewStoreDir()`，签名不改）。客户端只拿**逻辑标识**
// （路由名 + 会话 id），**不接触任何暂存路径** —— `PANEL_STORE_LABEL` 是给人看的逻辑标签，
// `storeHash` 是给机器关联的短哈希，两者都不含路径。

export const PANEL_ROUTE_PREFIX = '/winstage-panel'
export const PANEL_SNAPSHOT_PATH = `${PANEL_ROUTE_PREFIX}/snapshot`
export const PANEL_TRUST_PATH = `${PANEL_ROUTE_PREFIX}/trust`

/** 面板读到的存储的**逻辑**标识（不含路径）；机读 `hash` 由 `storeHash()` 给 */
export function panelStoreIdentity(dir, sessionId) {
  const scope = typeof sessionId === 'string' && sessionId.trim().length > 0 ? 'session' : 'shared'
  return { scope, label: scope === 'session' ? '会话工作根（Windows 缓存）' : '共享工作根（Windows 缓存）', hash: storeHash(dir) }
}

/**
 * 宿主侧解析某会话的存储根 —— **唯一**入口是 `resolveReviewStoreDir()`。
 *
 * 为什么不在客户端解析：缓存根的基目录来自宿主进程的 `%LOCALAPPDATA%`，浏览器里没有这个
 * 事实；客户端自己拼只能拼出旧布局（这正是本次缺口）。**纯函数、无副作用、不建目录**。
 */
export function panelStoreDir({ workspaceRoot, sessionId, env } = {}) {
  return resolveReviewStoreDir({ workspaceRoot, sessionId, env })
}

/**
 * 读**已发布**的快照（只读：不实例化审阅服务 ⇒ 不建目录、不触发认领/自愈）。
 * @returns {{ok: boolean, code?: string, dir?: string, snapshot?: object, detail?: string}}
 */
export function readPublishedSnapshot({ workspaceRoot, sessionId, env } = {}) {
  const dir = panelStoreDir({ workspaceRoot, sessionId, env })
  const file = join(dir, REVIEW_BASENAME)
  if (!existsSync(file)) return { ok: false, code: 'no-snapshot', dir }
  try {
    return { ok: true, dir, snapshot: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    return { ok: false, code: 'snapshot-unreadable', dir, detail: String(error?.message ?? error) }
  }
}

/**
 * 面板路由的**纯**核心：`(pathname, query) → {status, body}`（可离线断言，不起 HTTP）。
 *
 * 两条路由：
 *   · `PANEL_SNAPSHOT_PATH` → 已发布快照 + **逻辑**存储标识（路径字段一律剥掉）；
 *   · `PANEL_TRUST_PATH`    → 可信性状态卡（与 `/winstage status` 同一份 `buildTrustCard()`）。
 *
 * ⚠ 关闭态返回 `503 disabled`：面板在关闭时本来就不该看到任何暂存内容（`client.js` 的
 *   开关闸门是同一语义；这里再挡一道，免得"关掉了却仍在审批"从路由侧回来）。
 */
export function buildPanelPayload({ pathname, query, workspaceRoot, sessionId, env, isEnabled = () => true, session, now } = {}) {
  const read = (key) => {
    if (query instanceof Map) return query.get(key) ?? undefined
    if (query && typeof query.get === 'function') return query.get(key) ?? undefined
    return undefined
  }
  if (pathname !== PANEL_SNAPSHOT_PATH && pathname !== PANEL_TRUST_PATH) {
    return { status: 404, body: { ok: false, code: 'unknown-route', route: pathname } }
  }
  if (!isEnabled()) return { status: 503, body: { ok: false, code: 'disabled', route: pathname } }
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    return { status: 500, body: { ok: false, code: 'no-workspace-root', route: pathname } }
  }
  const sid = read('session')
  const published = readPublishedSnapshot({ workspaceRoot, sessionId: sid, env })
  const store = panelStoreIdentity(published.dir, sid)
  if (pathname === PANEL_SNAPSHOT_PATH) {
    if (!published.ok) {
      // `no-snapshot` 是**正常**的"当前没有待审"，与"读不到"必须分开
      return { status: published.code === 'no-snapshot' ? 404 : 500, body: { ok: false, code: published.code, store, detail: published.detail } }
    }
    return { status: 200, body: { ok: true, store, snapshot: published.snapshot, source: 'host-route' } }
  }
  const card = buildTrustCard({
    service: undefined,
    // 面板侧**不实例化审阅服务**（那会建目录、触发认领/自愈），所以把宿主解析出的
    // 存储根**显式**交给状态卡：①②③⑤ 四个面照样齐 —— 面板看到的与 `/winstage status`
    // 是同一份判据、同一份数据。
    storeDir: published.dir,
    session,
    // 面⑥要靠已发布快照（这里**不**写盘）
    snapshot: published.ok ? published.snapshot : undefined,
    now,
  })
  return { status: 200, body: { ok: true, store, card, source: 'host-route' } }
}

/**
 * 造面板路由处理器（`ctx.webServer.register({kind:'prefix', path: PANEL_ROUTE_PREFIX, handler})`）。
 *
 * @param {{workspaceRoot: string, isEnabled?: Function, env?: object, sessionOf?: Function, log?: Function}} options
 *   `sessionOf(invocation)`：本路由没有 command invocation，面④需要调用方给一个"当前会话"
 *   的取法；拿不到就如实标"未知"，**不猜**。
 */
export function createPanelHandler(options = {}) {
  const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true
  const log = typeof options.log === 'function' ? options.log : () => {}
  return async function winStagePanelHandler(req, res) {
    let url
    try {
      url = new URL(String(req?.url ?? '/'), 'http://localhost')
    } catch {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, code: 'bad-url' }))
      return
    }
    let session
    try {
      session = typeof options.sessionOf === 'function' ? options.sessionOf() : undefined
    } catch {
      session = undefined
    }
    const payload = buildPanelPayload({
      pathname: url.pathname,
      query: url.searchParams,
      workspaceRoot: options.workspaceRoot,
      sessionId: url.searchParams.get('session') ?? undefined,
      env: options.env,
      isEnabled,
      session,
    })
    try {
      res.writeHead(payload.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload.body))
    } catch (error) {
      log(`面板路由写响应失败：${error?.message ?? error}`)
    }
  }
}


/**
 * 注册 `/winstage` 命令族。
 *
 * 命令处理器**不产生模型消息**，且在接收 agent 的会话日志里留下 `command/run` /
 * `command/done` 这对审计事件（`dsh-commands` 的既定行为），因此"谁在什么时候批准了
 * 哪些文件"是可回溯的。
 */
/**
 * @param scope 命令注册作用域
 * @param {object | ((invocation: object) => object)} serviceOrResolver
 *   审阅服务对象，或"按本次调用解析服务"的函数 —— 生产用后者（**审批内容按会话隔离**）。
 */
export function registerCommands(scope, serviceOrResolver, log, options = {}) {
  /**
   * 命令面与开关**解耦**：命令始终注册（关掉再打开时 apply 不会重跑，只有"始终
   * 注册 + 执行时现读"才能让命令面回来），但每次执行都按当前开关决定是否放行。
   */
  const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : () => true
  /** 服务解析：老调用方传对象（自测），生产传 `(invocation) => service` */
  const serviceOf = typeof serviceOrResolver === 'function' ? serviceOrResolver : () => serviceOrResolver
  const DISABLED_TEXT =
    'WinStage 沙箱已在设置中关闭：暂存与审阅面未接管（写入走平台沙箱/审批模式），命令不会执行。'

  const handlers = {
    list({ service }) {
      return { kind: 'success', text: formatList(service) }
    },
    /**
     * `/winstage status`（含 `winstage-status`）：暂存清单 + **WP3 可信性状态卡**。
     *
     * 状态卡把六个面合并成一张（档位 / 首次掉档 / 失根 / 未结算审批 / 未确认写入 /
     * 读侧可见性），机读字段与人读结论同源。**只在用户侧**：命令文本 + 面板路由；
     * 命令自身的 stdout/stderr 与工具输出一个字节都不变（下面的 `text` 只回到命令面）。
     */
    status(context) {
      const service = context?.service
      // 一次构建、两处复用：清单与卡片共用**同一份**快照（避免 publish 跑两遍、时间戳分叉）
      let snapshot
      if (service && typeof service.snapshot === 'function') {
        try {
          snapshot = service.snapshot()
        } catch (error) {
          return { kind: 'error', text: `读取暂存快照失败：${error?.message ?? error}` }
        }
      }
      const listed = snapshot
        ? { kind: 'success', text: formatList(service, snapshot) }
        : handlers.list(context)
      const card = buildTrustCard({
        service,
        // 面④要读会话事件（`approval/asked` 有没有配对）。命令面拿得到 agent/session，
        // 拿不到就如实标"未知"——**不猜**。
        session: context?.invocation?.agent?.session,
        snapshot,
      })
      // 最危险的档位（掉档/失根）必须显眼：命令面用 error 级
      const alarming = card.trust.level === 'lost' || card.trust.level === 'degraded'
      return {
        kind: alarming ? 'error' : listed.kind,
        text: `${listed.text}\n\n${formatTrustCard(card)}`,
      }
    },
    refresh({ service }) {
      const snapshot = service.publish()
      return { kind: 'success', text: `已刷新审阅快照：${snapshot.counts.files} 个待审文件` }
    },
    rebase({ args, service }) {
      const result = service.rebase(args.length > 0 ? args : undefined)
      const lines = [result.message]
      for (const path of result.rebased) lines.push(`  ↻ ${path}`)
      if (result.rebased.length > 0) lines.push(`  现在可批准 ${result.remaining} 项（/winstage list 查看）`)
      // S13/S14：rebase 也走候选对账 ⇒ 没清干净必须响（不能再"success 但其实没清掉"）
      const failures = Array.isArray(result.failures) ? result.failures : []
      if (failures.length > 0) {
        lines.push(`  ⚠ 有 ${failures.length} 项清理失败（没清干净）：`)
        for (const failure of failures) {
          lines.push(`    · ${failure.path ?? failure.candidateId ?? '?'}: ${failure.code} — ${failure.message}`)
        }
        return { kind: 'error', text: lines.join('\n') }
      }
      return { kind: 'success', text: lines.join('\n') }
    },
    diff({ args, service }) {
      return { kind: 'success', text: formatDiff(service, args) }
    },
    approve({ args, service }) {
      // 开关：`--rebase` = 先把基线过期的条目对齐到真实文件再批准；
      //       `--force`  = 跳过 #12.1 的基线检查直接覆盖（更危险，两者可并用）。
      const flags = new Set(args.filter((arg) => arg.startsWith('--')))
      const names = args.filter((arg) => !arg.startsWith('--'))
      const unknown = [...flags].filter((flag) => flag !== '--rebase' && flag !== '--force' && flag !== '--confirm-mask')
      if (unknown.length > 0) {
        return { kind: 'error', text: `未知开关：${unknown.join(' ')}；可用：--rebase、--force、--confirm-mask` }
      }
      const ws = service.reload()
      const changes = ws.diffEntries()
      if (changes.length === 0) {
        // S9（§7.3）：净 diff 为空、但队列里还有候选，**不是**"没有待审文件" ——
        // 用户按下唯一的按钮却拿到 success + 什么都没有，这正是"点了没反应"。
        const live = typeof ws.listReviews === 'function' ? ws.listReviews() : []
        const frozen = live.reduce((n, c) => n + (c.changes || []).length, 0)
        if (live.length > 0) {
          return {
            kind: 'error',
            text: `没有可批准的净变化：队列里还有 ${live.length} 份候选（共 ${frozen} 条冻结路径）已不在净 diff，属"仅存档、不可批准"。用 /winstage reject 清除它们，或 /winstage rebase 重新对齐基线。`,
          }
        }
        return { kind: 'success', text: '没有待审文件' }
      }
      const paths = names.length > 0 ? matchPaths(changes, names).map((c) => c.path) : undefined
      if (names.length > 0 && paths.length === 0) {
        return { kind: 'error', text: `没有匹配的待审路径：${names.join(' ')}` }
      }
      const result = service.approve(paths, {
        rebase: flags.has('--rebase'),
        force: flags.has('--force'),
        // `--confirm-mask` = 用户已经看到过后果并确认。给了路径就确认这些路径；
        // "批准全部"没给路径 ⇒ `true`（确认本次全部遮蔽项）。
        ...(flags.has('--confirm-mask') ? { confirmedMasks: paths && paths.length > 0 ? paths : true } : {}),
      })
      const lines = [result.message]
      if (result.rebased?.length) lines.push(`  已先以真实文件为基线重新暂存：${result.rebased.join(', ')}`)
      // S13/S14：`approve --rebase` 的候选对账失败也必须响
      const clearFailures = Array.isArray(result.failures) ? result.failures : []
      if (clearFailures.length > 0) {
        lines.push(`  ⚠ 有 ${clearFailures.length} 项清理失败（没清干净）：`)
        for (const failure of clearFailures) {
          lines.push(`    · ${failure.path ?? failure.candidateId ?? '?'}: ${failure.code} — ${failure.message}`)
        }
      }
      for (const failure of result.failed) {
        lines.push(`  ✗ ${failure.path}: ${failure.code} — ${failure.message}`)
      }
      if (result.remaining?.length) lines.push(`  仍在待审：${result.remaining.join(', ')}`)
      if (result.failed.some((f) => f.code === 'STALE_BASELINE')) {
        lines.push('  说明：真实文件在暂存之后被外部改动过，因此默认拒绝覆盖（手册 #12.1）。')
        // ★ 缺陷②（F5b）：把**形状**说清。`baseline-appeared`（基线本为"不存在"、
        //   真实文件在暂存之后出现）是实测那条"点批准就静默丢掉磁盘内容"的形状；
        //   光说"基线已过期"用户不知道磁盘上已经有东西了。
        const shapes = [...new Set(result.failed.filter((f) => f.code === 'STALE_BASELINE').map((f) => staleShapeText(f.baselineStaleCode ?? f.driftReason)))]
          .filter((text) => text.length > 0)
        if (shapes.length > 0) lines.push(`  形状：${shapes.join('；')}。真实磁盘上的那份内容**没有被覆盖**。`)
        lines.push('  处理：/winstage rebase [路径…] 以真实文件为基线重新暂存（之后面板会显示 before/after，你确认的就是将要替换的内容）；或 /winstage approve --rebase [路径…] 一步完成；不想要这份暂存就 /winstage reject [路径…]。')
      }
      // "批准了 0 项、也没失败"同样是**静默无效**（面板上看就是"点了没反应"）：
      // 显式回报成 error，让 UI 把原因显示出来。
      if (result.approved === 0 && result.failed.length === 0) {
        lines.push('  没有条目被应用：选中的路径不在最新候选里（可能已被后来的写入取代）。')
        lines.push('  处理：/winstage refresh 重新发布快照后重试。')
        return { kind: 'error', text: lines.join('\n') }
      }
      if (clearFailures.length > 0) return { kind: 'error', text: lines.join('\n') }
      const needConfirm = result.failed.filter((f) => f.code === 'SANDBOX_PATH_MASKED_CONFIRM')
      if (needConfirm.length > 0) {
        // **不是硬拒**：说清后果，确认后即可落盘（面板上是一次弹窗确认）
        lines.push('  需要二次确认（本次**未**写入）：以下路径命中敏感策略，批准会把暂存内容写到真实磁盘且不可撤销。')
        for (const failure of needConfirm) {
          lines.push(`    · ${failure.path} — ${failure.message}${failure.hard ? '［沙箱自身存储·强警告］' : ''}`)
        }
        lines.push(
          `  确认后重发：/winstage approve --confirm-mask ${needConfirm.map((f) => `"${f.path}"`).join(' ')}`,
        )
      }
      return { kind: result.ok ? 'success' : 'error', text: lines.join('\n') }
    },
    reject({ args, service }) {
      const ws = service.reload()
      const changes = ws.diffEntries()
      // ★ P0-2：**不能**因净 diff 为空就早退。队列里可能只剩"仅存档 / 空壳"候选，而
      //   「拒绝全部」是用户唯一能清掉它们的出口（`review-service.reject()` 的清理分支
      //   已经能在净 diff 为空时终结它们）。早退的实测后果：
      //   「拒绝全部」返回 success 而 `review.json` 的 `pending` 仍为 true ⇒ 条目永久留存。
      const live = typeof ws.listReviews === 'function' ? ws.listReviews() : []
      if (changes.length === 0 && live.length === 0) return { kind: 'success', text: '没有待审文件' }
      const paths = args.length > 0 ? matchPaths(changes, args).map((c) => c.path) : undefined
      if (args.length > 0 && paths.length === 0) {
        return {
          kind: 'error',
          text: `没有匹配的待审路径：${args.join(' ')}（若它只是"仅存档行"，请用不带路径的 /winstage reject 清除）`,
        }
      }
      const result = service.reject(paths)
      const discarded = Array.isArray(result.discarded) ? result.discarded : []
      const clearFailures = Array.isArray(result.failures) ? result.failures : []
      // S13/S14：清除路径上的失败必须响 —— 不许"返回 success 但其实什么都没清掉"
      if (result.rejected === 0 && discarded.length === 0 && clearFailures.length === 0) {
        return {
          kind: 'error',
          text: `没有任何条目被清掉：${result.message ?? '所选路径既不在净 diff、也没有对应的活候选。'}`,
        }
      }
      const lines = [
        `已退回 ${result.rejected} 个文件：${result.paths.join(', ') || '（无净 diff 条目）'}` +
          `${discarded.length > 0 ? `；已终结 ${discarded.length} 个候选` : ''}（真实工作区未被改动）`,
      ]
      if (clearFailures.length > 0) {
        lines.push(`  ⚠ 有 ${clearFailures.length} 项清理失败（没清干净）：`)
        for (const failure of clearFailures) {
          lines.push(`    · ${failure.path ?? failure.candidateId ?? '?'}: ${failure.code} — ${failure.message}`)
        }
        return { kind: 'error', text: lines.join('\n') }
      }
      return { kind: 'success', text: lines.join('\n') }
    },
  }

  const registered = []
  // 命令规格：`sub === null` 表示伞形命令（第一个词是子命令），
  // 其余命令把整个 rawInput 当作参数列表。
  const SPECS = [
    { name: 'winstage', sub: null, description: '查看 WinStage 暂存待审文件（/winstage list|diff|approve|reject|rebase|refresh）' },
    { name: 'winstage-status', sub: 'status', description: 'WinStage 暂存：查看待审清单' },
    { name: 'winstage-refresh', sub: 'refresh', description: 'WinStage 暂存：重新发布审阅快照' },
    { name: 'winstage-rebase', sub: 'rebase', description: 'WinStage 暂存：以真实文件为基线重新暂存（基线过期时）' },
    { name: 'winstage-diff', sub: 'diff', description: 'WinStage 暂存：显示改动（可给路径，空格用引号包住）' },
    { name: 'winstage-approve', sub: 'approve', description: 'WinStage 暂存：把改动写入真实工作区（可给路径）' },
    { name: 'winstage-reject', sub: 'reject', description: 'WinStage 暂存：把改动退回真实磁盘（可给路径）' },
  ]

  for (const spec of SPECS) {
    registered.push(
      scope.commands.register({
        definitionId: `winstage-sandbox/${spec.name}`,
        name: spec.name,
        description: spec.description,
        // ⚠ 字段名必须是 `hint`，不能用 `placeholder`：
        // `dsh-commands/lib/index.js:154-163 normalizeDefinition()` 在 `input` 存在时
        // 要求 `"hint" in input && typeof input.hint === "string"`，否则抛
        // `TypeError: command "<name>" input hint must be a string`。
        // 该异常会让整个 `ctx.inject(['commands'], …)` 回调失败 ⇒ **线上 0 条命令注册**，
        // 而进程内直接调 `registerCommands()`（绕过该校验）会「看起来注册了 6 条」。
        input: { hint: '文件路径（可省略；含空格时用双引号）' },
        handler: (invocation) => {
          try {
            if (!isEnabled()) return { kind: 'error', text: DISABLED_TEXT }
            // **按会话解析**：命令在哪条会话里点的，就只动那条会话的暂存
            const service = serviceOf(invocation)
            const raw = String(invocation?.rawInput ?? '')
            let sub
            let args
            if (spec.sub === null) {
              const parsed = parseInvocation(raw)
              sub = parsed.subcommand
              args = parsed.args
            } else {
              sub = spec.sub
              args = splitArgs(raw)
            }
            const handler = handlers[sub]
            if (!handler) {
              return {
                kind: 'error',
                text: `未知子命令 "${sub}"；可用：list、status、diff、approve、reject、rebase、refresh`,
              }
            }
            return handler({ args, invocation, raw, service })
          } catch (error) {
            log.warn(`/${spec.name} 失败：${error?.message ?? error}`)
            return { kind: 'error', text: `/${spec.name} 失败：${error?.message ?? error}` }
          }
        },
      }),
    )
  }
  return registered
}

// ==================== 运行后捕获（post-run capture） ====================

/**
 * 装配"运行后捕获" —— **默认关闭**，靠环境变量显式打开。
 *
 * ── 为什么走环境变量而不是 Config 字段 ──────────────────────────────────────
 * `schema.js` 的字段清单被既有断言钉死为 4 个
 * （`.t/dsh2/fix-asserts/p06-config-projection.mjs:56`），且设置页投影对 volatile
 * 嵌套极其敏感（P0-6 曾整份投影失败）。**加字段是一次独立的契约变更**，要连断言一起改，
 * 不该混进本增量。仓库已有先例：`fs-entry.mjs` 的 `WINSTAGE_STAGE_OUTSIDE`。
 *
 * ── 它补的是哪一段空白 ──────────────────────────────────────────────────────
 * `bash` / `pwsh` 的写入不经过 `ctx.fs`（`staging-fs.mjs` 文件头第 30 行自认），
 * 因此过去**直接落真实主机、不进暂存**：命令改了宿主，审阅面板却空着。这里用 DSH 的一等
 * 钩子把这段接进来（出处：`dsh-tools/lib/index.js:3225` / `:3504`）：
 *
 *   `tools/pre-execute`  → 执行前在真实主机上取**内容镜像**（before 的唯一权威来源）
 *   `tools/post-execute` → 执行后比对、落暂存、冻结候选、**把主机还原成执行前**
 *
 * 于是"写入在沙箱内成功"（工具调用成功、主机不动）与"改动进待审"同时成立。
 *
 * ── 失败必须响（C2）────────────────────────────────────────────────────────
 * 取镜像失败、落暂存失败、还原失败一律走 **error 级**日志；绝不假装成功、绝不吞异常。
 * `capture()` 自己也不抛（失败进 `failures`），这里的 try/catch 是第二道兜底。
 *
 * @param {object} ctx cordis 上下文（需要 `ctx.on`）
 * @param {{workspaceRoot: string, serviceFor: Function, log?: Function, logError?: Function, env?: object}} options
 * @returns {{enabled: boolean, tools: string[], restore?: boolean, reason?: string}}
 */
export function installRunCapture(ctx, options = {}) {
  const { workspaceRoot, serviceFor, log = () => {}, logError = () => {}, env = process.env } = options

  if (env.WINSTAGE_CAPTURE !== '1') {
    log('运行后捕获：未启用（设 WINSTAGE_CAPTURE=1 打开）。')
    return { enabled: false, tools: [] }
  }
  if (typeof ctx?.on !== 'function') {
    // 没有事件总线 = 钩子挂不上。**必须响**，不能"看起来装上了其实没装"。
    logError('运行后捕获：本 ctx 没有事件总线（ctx.on 缺失），捕获面**未**装配。')
    return { enabled: false, tools: [], reason: 'no-event-bus' }
  }

  const tools = new Set(
    String(env.WINSTAGE_CAPTURE_TOOLS || 'pwsh,bash')
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean),
  )
  const restore = env.WINSTAGE_CAPTURE_RESTORE !== '0'
  const exclude = String(env.WINSTAGE_CAPTURE_EXCLUDE || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const maxFileBytes = Number(env.WINSTAGE_CAPTURE_MAX_BYTES || '') || undefined
  const maxFiles = Number(env.WINSTAGE_CAPTURE_MAX_FILES || '') || undefined

  /** 未结算的执行前快照：key → {before, name}。只在 pre 与 post 之间存活。 */
  const pending = new Map()
  const callKey = (exec) =>
    (typeof exec?.callId === 'string' && exec.callId.length > 0 ? exec.callId : `${exec?.name}@${exec?.agent?.session?.id ?? 'nosession'}`)

  /**
   * 本次调用所属会话的捕获实例。
   *
   * 为什么每次都新建：`ReviewService.reload()` 会把 `service.workspace` **换成新对象**
   * （`review-service.mjs` 的 `reloaded()` 就是 `service.reload(); return service.workspace`），
   * 缓存旧实例会让捕获写进一个已经被替换掉的 Workspace。
   */
  const captureFor = (exec) => {
    const service = serviceFor?.({ agent: exec?.agent })
    if (!service) {
      logError(`运行后捕获：按会话解析暂存服务失败（tool=${exec?.name}），本次不捕获。`)
      return undefined
    }
    try {
      service.reload?.()
    } catch (error) {
      logError(`运行后捕获：reload 暂存清单失败（${error?.message ?? error}），仍按当前实例继续。`)
    }
    const workspace = service.workspace
    if (!workspace?.store) {
      logError(`运行后捕获：暂存服务没有 Workspace/Store（tool=${exec?.name}），本次不捕获。`)
      return undefined
    }
    return createRunCapture({
      workspaceRoot,
      store: workspace.store,
      workspace,
      log: (message, level) => (level === 'error' ? logError(message) : log(message)),
      ...(exclude.length > 0 ? { exclude } : {}),
      ...(maxFileBytes ? { maxFileBytes } : {}),
      ...(maxFiles ? { maxFiles } : {}),
    })
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    // 被拒 / 等审批 ⇒ 工具体不会跑，没有可捕获的东西（也就不能留下悬空的 before）
    if (decision?.kind !== 'allow') return decision
    if (!tools.has(exec?.name)) return decision
    const key = callKey(exec)
    try {
      const cap = captureFor(exec)
      if (cap) {
        // ⚠ 必须是 `prime()`，**不是** `snapshot()`。
        // `snapshot()` 只走元数据（`run-capture.mjs:426-436`）：不读内容、不落 before blob、
        // 不写 `capture-mirror.json`。用它取"执行前镜像"，执行后每条变化都会命中
        // "该路径不在执行前镜像里，无法还原（未调用 materializeBlob）" ⇒ **主机根本回滚不了**，
        // 整个"写入在沙箱内成功"的前提落空。
        // 这条不是推理：`.t/wiring-selftest.mjs` 的 W1/W2 就是这么红的，改回 prime() 才转绿。
        const primed = await cap.prime()
        pending.set(key, {
          before: primed?.before,
          name: exec.name,
          // prime 阶段**读失败**的路径 = "执行前是什么"未知。把它交给 capture()，
          // 让那些路径**不参与**删除式还原（否则"读不到"会被当成"执行前不存在"而删掉真文件）。
          unknownPaths: (Array.isArray(primed?.skipped) ? primed.skipped : [])
            .map((entry) => entry?.path)
            .filter(Boolean),
        })
        log(`运行后捕获：已取执行前镜像（${exec.name}，${primed?.files ?? 0} 个文件 / ${primed?.bytes ?? 0} 字节）。`)
      }
    } catch (error) {
      logError(`运行后捕获：执行前取镜像失败（${exec?.name}）：${error?.message ?? error}`)
    }
    return decision
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    const key = callKey(exec)
    const record = pending.get(key)
    if (!record) return decision
    pending.delete(key)
    /** 需要"响"到模型/用户面前的失败（不只是日志） */
    const surfaced = []
    try {
      const cap = captureFor(exec)
      if (!cap) return decision
      const report = await cap.capture(record.before, { restore, unknownPaths: record.unknownPaths })
      const failures = Array.isArray(report?.failures) ? report.failures : []
      const staged = report?.staged ?? 0
      if (staged > 0 || failures.length > 0) {
        log(
          `运行后捕获：${record.name} 净变化 ${report?.changes?.length ?? 0} 条、` +
            `落暂存 ${staged} 条、还原 ${report?.restored ?? 0} 条、失败 ${failures.length} 条。`,
        )
      }
      for (const failure of failures) {
        const line = `运行后捕获失败[${failure?.phase ?? '?'}] ${failure?.path ?? '?'}：${failure?.message ?? '（无消息）'}`
        logError(line)
        surfaced.push(`- ${line}`)
      }
    } catch (error) {
      const line = `运行后捕获：执行后捕获抛错（${exec?.name}）：${error?.message ?? error}`
      logError(line)
      surfaced.push(`- ${line}`)
    }
    if (surfaced.length === 0) return decision
    // ── 失败必须**响** ──────────────────────────────────────────────────────
    // 光有 error 级日志不够：本仓库反复栽在"静默失效"上，而"主机其实没回滚"这件事
    // 恰恰是**用户最需要当场知道**的。所以除了日志，还要把它随**工具结果**回给模型。
    // 契约（`dsh-tools/lib/types/index.d.ts:465-479`）：`accept` 可以带 `content`。
    // `content` 与 `value` 互斥，且我们**不替换**下游内容、只追加一块，避免弄坏别人的输出。
    if (decision?.kind === 'accept' && Array.isArray(decision.content)) {
      return {
        ...decision,
        content: [
          ...decision.content,
          {
            type: 'text',
            text:
              `[WinStage 运行后捕获] ${record.name}：有 ${surfaced.length} 处**没有**按预期处理完，` +
              '真实主机上可能仍保留着命令写入的内容。\n' +
              `${surfaced.join('\n')}\n` +
              '请不要把未列出的部分当成已被回滚；已捕获的改动仍可以在 WinStage 面板上批准。',
          },
        ],
      }
    }
    logError(
      '运行后捕获：该工具的返回不是 content 形态（`accept.value` 与 `content` 互斥），' +
        '失败明细只能留在 error 级日志里，无法随结果回给模型。',
    )
    return decision
  })

  log(`运行后捕获：已启用；工具=${[...tools].join(',')}；还原=${restore ? '开' : '关'}。`)
  return { enabled: true, tools: [...tools], restore }
}

// ==================== 插件入口 ====================

export function apply(ctx, config = {}) {
  const log = makeLog(ctx)
  /**
   * error 级日志通道（"失败必须响"）。
   *
   * ★ 必须是**具名绑定**，不能只在下面 `installRunCapture({ logError: … })` 的
   *   options 里内联一份：`serviceFor()` 构造审计镜像时要把它传出去
   *   （`createAuditMirror({ sessionOf, log, logError })`）。
   *
   * 2026-09-30 用户报障：那里引用的是裸标识符 `logError`，而 apply 作用域里从来没有这个
   * 名字 ⇒ 任何 `/winstage*` 命令一到"按会话解析暂存服务"就抛
   * `ReferenceError: logError is not defined`，用户看到的是
   * 「`/winstage 失败：logError is not defined`」，整族命令（含 reject/approve）不可用。
   * 回归门：`.t/host-command-selftest.mjs`（把 host 半真的 apply 跑起来逐个调 handler）。
   *
   * 语义：错误只走 error 级日志（`ctx.logger.error`，无则 warn），**绝不进命令文本 /
   * 工具输出** —— 与 `review-service.mjs` 的 `logError` 同一契约。
   */
  const logError = (message) => {
    const logger = ctx?.logger
    if (logger && typeof logger.error === 'function') logger.error(message)
    else log.warn(message)
  }
  const workspaceRoot = config.workspaceRoot || new URL('..', import.meta.url).pathname.replace(/^\//, '')

  /**
   * 开关的**唯一读法**：每次现读 `config.enabled`，绝不在这里冻结成常量。
   *
   * `enabled` 在 `schema.js` 里是 volatile 字段，设置页改它**不会重挂本行**
   * （loader 的 volatile 通道把新值原地写回 apply 收到的这个 config 对象）。
   * 所以"关闭"必须靠**调用时判断**生效，而不是 apply 早退：早退会让"关掉再打开"
   * 永远回不来（apply 不会重跑）。变更面的卸载由 `fs-entry.mjs`/`staging-fs.mjs`
   * 按同一个开关现读完成 —— 关 = 退回平台沙箱/审批模式。
   */
  const isEnabled = () => config.enabled !== false

  if (isEnabled()) {
    log.info(`已启用；工作区根 = ${workspaceRoot}`)
  } else {
    log.info('设置里当前为关闭：暂存面已交回平台沙箱（原审批模式）；/winstage* 命令仍可见但会如实拒绝执行。')
  }

  // 1) 审阅面：**每个会话各有自己的暂存清单与快照**，因此不再在启动时预热全局实例；
  //    服务在命令调用时按 `invocation.agent` 现场解析（见 serviceFor）。
  /**
   * 本次命令调用所属会话的审阅服务 —— **审批内容按会话隔离**的入口。
   *
   * `CommandInvocation.agent` 由 dsh-commands 明确给出（"Exact agent whose UI received the
   * command"，dsh-commands/lib/types/index.d.ts:22-24），所以命令面天然知道"是谁点的"。
   * 拿不到会话（agentless 调用 / 自测）时退回**共享**存储（`.dshstage/` 根），与升级前一致。
   */
  const serviceFor = (invocation) => {
    const sessionId = invocation?.agent?.session?.id
    /**
     * ★ 方向 3 接线：把 WinStage 的暂存审批**镜像进会话审计面**。
     *
     * 根因（本轮定因）：`dsh-plugin/**` 里 `session.append` **0 命中** ⇒ 暂存审批只写
     * 自己的 `review.json`，而原生审批写会话日志（`approval/asked`→`approval/decided`）。
     * 两套"真相"不在一个地方 ⇒ 没有共享 id、没有共同清除路径 ⇒ 用户报的"两套审批互相冲突"。
     *
     * 这里用**与原生同一对事件名与同一套载荷语义**写审计对（id = `winstage:<candidateId>`），
     * 于是重放/对账/孤儿检测都能走同一套 invariant。实现在 `audit-mirror.mjs`：
     *   - 照抄原生 `hasOpenTurn`（回合外不写，避免造出"崩溃尾巴"式垃圾事件）；
     *   - 任何 append 失败一律吞掉 + error 级日志（**审计绝不影响审批**）。
     *
     * `sessionOf` 必须是**每次现读**：`getReviewService` 是按 `root#sessionKey` 缓存的，
     * 而服务跨命令存活；把 session 钉死在构造期会在会话切换后写错地方。
     */
    const sessionOf = () => invocation?.agent?.session
    const audit = createAuditMirror({ sessionOf, log, logError })
    const service = getReviewService({
      workspaceRoot,
      ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
      // T3d：**必须在这里就把开关传进去**。`getReviewService()` 内部自己也会认领一次
      // （`review-service.mjs:1143`），只在下面那行加判断是**无效**的 —— 认领在函数里就已经发生了。
      claimShared: isEnabled(),
      log: (message) => log.info(message),
      audit,
    })
    // 自愈：共享存储里可能积着"上一段拿不到会话身份"的条目（旧进程/agentless 调用）
    //
    // T3d：**这只在沙箱接管时做**。关闭沙箱 = 纯模式开关 —— 关闭态绝不认领别处（其他会话 /
    // 无会话身份）的暂存内容，否则那些内容会变成"我会话里可批准"的条目，一次批准就把别人的
    // 暂存写进真实磁盘。关闭态下共享条目留在原处，由 `/winstage`（无会话身份）自己负责。
    if (isEnabled()) service.absorbSharedStore?.()
    return service
  }

  // 2) 命令面（可选服务：没有 commands 就不注册，绝不让加载失败）
  ctx.inject(['commands'], (scope) => {
    // 注册失败必须**响**：这个回调一旦抛错，`/winstage*` 会整族消失却毫无提示
    // （T5-B 实测就是这样静默失效的）。这里把失败降级为 error 日志 + 不抛出，
    // 让"命令面不可用"这件事在日志里可见，同时不影响插件其余部分加载。
    try {
      const registered = registerCommands(scope, serviceFor, log, { isEnabled })
      log.info(`已注册 ${registered.length} 个 /winstage* 命令（暂存与快照按会话隔离）`)
    } catch (error) {
      const logger = ctx?.logger
      const message = `命令注册失败：${error?.message ?? error}（/winstage* 将不可用）`
      if (logger && typeof logger.error === 'function') logger.error(message)
      log.warn(message)
    }
  })

  // 2.1) ★ WP3-B：面板**读侧路由**（存储根在宿主侧解析，客户端只拿逻辑标识）。
  //
  // 为什么需要一条宿主路由：Client 只被允许用**已有**的 Remote（`workspaceFiles.read`
  // 要一个**路径**），而存储根自 Phase 1 起在 Windows 缓存里 —— 浏览器里没有
  // `%LOCALAPPDATA%` 这个事实，客户端自己拼只能拼出旧布局（这就是本次实测的缺口）。
  // 所以宿主把"根在哪"这件事收回自己这边，用 `resolveReviewStoreDir()` 解析，
  // 通过一条同源只读路由把**快照/状态卡**给客户端；客户端拿到的只有**逻辑标识**
  // （路由名 + 会话 id + 存储短哈希），**没有任何暂存路径**。
  //
  // 失败必须响（error 级日志）但**不影响**插件其余部分：拿不到 webServer 时命令面照常工作，
  // 面板则退回"兼容旧布局"的读法（`client.js` 里那条**唯一**的兼容分支）。
  ctx.inject(['webServer'], (webScope) => {
    // **本装配没有 webServer**（headless / ACP / 自测桩）不是故障：面板那时会走
    // `client.js` 那条被注释说明的兼容读法。这里用 info 级如实说明 —— 把正常形态
    // 记成 error 级会让"失败必须响"变成噪声，真正的失败（register 抛错）才进 error。
    if (!webScope?.webServer || typeof webScope.webServer.register !== 'function') {
      log.info('本装配没有 webServer：面板读侧路由未注册；面板将退回兼容旧布局的读法（命令面不受影响）。')
      return
    }
    try {
      const handler = createPanelHandler({
        workspaceRoot,
        isEnabled,
        log: (message) => log.warn(message),
        // 面④（未结算审批）需要"当前会话"的事件流。本路由没有 command invocation，
        // 拿不到就如实标"未知" —— 绝不用"最近一次命令的会话"冒充当前会话。
      })
      const route = { kind: 'prefix', path: PANEL_ROUTE_PREFIX, handler }
      if (typeof webScope.effect === 'function') {
        webScope.effect(() => webScope.webServer.register(route), 'winstage-sandbox: panel routes')
      } else {
        webScope.webServer.register(route)
      }
      log.info(`面板读侧路由已注册：${PANEL_ROUTE_PREFIX}（存储根在宿主侧解析；客户端不再拼旧布局）`)
    } catch (error) {
      const message = `面板读侧路由注册失败：${error?.message ?? error}（面板会退回兼容读法）`
      const logger = ctx?.logger
      if (logger && typeof logger.error === 'function') logger.error(message)
      log.warn(message)
    }
  })

  // 2.5) 运行后捕获（默认关；WINSTAGE_CAPTURE=1 打开）
  //      放在启动探测**之前**：`probeOnStart=false` 会在下一步 return，
  //      若把它写在后面，关掉探测就会连带把捕获面一起关掉（静默失效）。
  installRunCapture(ctx, {
    workspaceRoot,
    serviceFor,
    log: (message) => log.info(message),
    // 复用 apply 作用域里那个具名 logError（`serviceFor` 也要用同一个，别再内联一份）
    logError,
  })

  // 2.6) ★ 缺陷②（F5b）：基线漂移的**只读轮询复核**。
  //
  //      为什么必须有它：`review.json` 只在变更/命令时发布，而 `pwsh` 直接写真实磁盘
  //      不产生这两种事件 ⇒ 快照的 `generatedAt` 会一直冻在上一版，面板对"外部改动"
  //      完全不可见（F5b 实测 90 s、`staleBaseline=0`），随后点「批准所选」还会静默覆盖。
  //      本定时器按 Client 的轮询节拍（1500 ms）跑 `ReviewService.reviewDrift()` —— 那是
  //      **纯读**：指纹没变立刻返回、不写盘；只有事实变了才重发布 review.json。
  //      关闭态（设置里把沙箱关掉）不装配：那时本插件不接管任何东西，不该有后台读盘。
  if (isEnabled()) {
    installBaselineWatch(ctx, {
      workspaceRoot,
      log: (message) => log.info(message),
      // 漂移诊断走**人工侧**通道（error 级日志），绝不进模型可见的 stdout/stderr
      logError,
    })
    log.info('基线漂移复核已装配（只读轮询；外部写入会在一个节拍内出现在面板上）。')
  }

  // 3) 启动探测（如实报告受限令牌能力；与暂存面无关）
  if (config.probeOnStart === false) {
    log.info('probeOnStart=false，跳过启动探测。')
    return
  }
  const probe = probeRuntime()
  if (probe.ready) {
    log.info(`能力探测通过：${probe.detail}`)
  } else {
    log.warn(`能力探测未通过：${probe.detail}`)
  }
}
