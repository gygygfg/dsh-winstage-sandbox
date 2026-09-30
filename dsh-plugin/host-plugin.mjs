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
 * 因此本插件用两条**已有**通道：
 *   1. 读：审阅快照写成 `<workspaceRoot>/.dshstage/review.json`，Client 用
 *      `ctx.remote.workspaceFiles.read` 读；
 *   2. 写：Client 用 `ctx.remote.commands.execute` 调 `/winstage approve|reject`，
 *      命令**不产生模型消息**（`dsh-commands` 的既定语义）。
 *
 * ── 一个必须如实说明的限制（手册第 0 章证据分层）────────────────────────────
 * `[实测]` WinStageSandbox 的**受限令牌**无法在已被沙箱化的会话里再创建
 * （缺 `TOKEN_ADJUST_DEFAULT` / `TOKEN_ADJUST_SESSIONID`，见 docs/实测证据记录.md
 * 残余边界 R6）。但**暂存不需要受限令牌**：它只要求"变更落暂存树、读取走投影"，
 * 这由 `ctx.fs` 提供方在可信代码里完成。因此本插件不假装 `init()` 成功：
 * `probeRuntime()` 只如实报告"能否建立受限令牌"，而暂存面与它无关、照常工作。
 */

import { Config } from './schema.js'
import { probeWin32Abi } from '../src/capability.mjs'
import { WindowsStageExecutor, resolveDshModuleRoot } from '../src/executor.mjs'
import { compareKey } from '../src/paths.mjs'
import { renderCandidateDiff } from '../src/tools.mjs'
import { getReviewService } from './review-service.mjs'
import { createAuditMirror } from './audit-mirror.mjs'
import { createRunCapture } from './run-capture.mjs'

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

export function formatList(service) {
  const snapshot = service.snapshot()
  if (!snapshot.pending) return 'WinStage 暂存区没有待审改动（改了文件之后会自动出现在这里）'
  const lines = [
    `WinStage 暂存待审  ${snapshot.counts.files} 个文件  +${snapshot.counts.additions} / −${snapshot.counts.deletions}`,
  ]
  if (snapshot.counts.frozenOnly > 0) {
    // D1：冻结存档行也要出现在 CLI 清单里，并**逐行标明不可批准** —— 否则
    // "N 个文件"与"能批准几个"会对不上，读的人会以为勾了就能写。
    lines.push(`  其中 ${snapshot.counts.frozenOnly} 个已不在当前净 diff（仅存档，不可批准）`)
  }
  if ((snapshot.counts.staleBaseline ?? 0) > 0) {
    // "多轮修改后视图不一致"：真实文件在暂存之后被外部改过，直接批准会被拒绝。
    // 清单里必须**说出来**，否则用户只会看到一条必然失败的"批准"。
    lines.push(
      `  其中 ${snapshot.counts.staleBaseline} 项基线已过期（真实文件在暂存之后被外部改动过）：` +
        '直接批准会被拒绝；用 /winstage rebase [路径…] 以真实文件为基线重新暂存。',
    )
  }
  for (const file of snapshot.files) {
    const frozen = file.frozenOnly === true ? '   [已不在净 diff · 不可批准]' : ''
    const stale = file.baselineStale === true ? '   [基线已过期 · 先 rebase]' : ''
    lines.push(`  ${file.op.padEnd(7)} ${file.path}   +${file.totals.added} / −${file.totals.removed}${frozen}${stale}`)
  }
  if (snapshot.truncated) lines.push('  …（列表已截断）')
  lines.push(`候选 ${snapshot.candidateId ?? '(未冻结)'} · 工作区 ${snapshot.workspaceRoot}`)
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
    status(context) {
      return handlers.list(context)
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
        lines.push('  处理：/winstage rebase [路径…] 以真实文件为基线重新暂存；或 /winstage approve --rebase [路径…] 一步完成；不想要这份暂存就 /winstage reject [路径…]。')
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

  // 2.5) 运行后捕获（默认关；WINSTAGE_CAPTURE=1 打开）
  //      放在启动探测**之前**：`probeOnStart=false` 会在下一步 return，
  //      若把它写在后面，关掉探测就会连带把捕获面一起关掉（静默失效）。
  installRunCapture(ctx, {
    workspaceRoot,
    serviceFor,
    log: (message) => log.info(message),
    logError: (message) => {
      const logger = ctx?.logger
      if (logger && typeof logger.error === 'function') logger.error(message)
      else log.warn(message)
    },
  })

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
