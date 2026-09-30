/**
 * 把 **WinStage 的暂存审批** 镜像到 **DSH 会话审计面** —— 方向 3 的核心接线。
 *
 * ── 为什么需要它（本轮定因）────────────────────────────────────────────────────
 * 原生审批把每次询问写成会话日志里的一对事件：
 *   `approval/asked` → （等待决策）→ `approval/decided`
 * （`dsh-user-approval/lib/index.js:128-144`）。
 *
 * 而 WinStage 的暂存审批把状态写在**自己的** `review.json` 里，
 * **完全不碰会话 transcript**（本轮实测：`dsh-plugin/**` 里
 * `session.append|ctx.session|append(` **0 命中**）。
 * ⇒ 两套审批的"真相"不在同一个地方：
 *   - 没有共享 id ⇒ 无法互相对账；
 *   - 没有共同的清除路径 ⇒ 一边清了另一边不知道；
 *   - 重放/恢复时对方完全不知情 ⇒ "审批条目消不掉、对不上"的底层形态。
 *
 * ── 本模块做什么 ───────────────────────────────────────────────────────────────
 * 用**与原生同一对事件名与同一套载荷语义**写审计对：
 *   asked  : `{ id: 'winstage:<candidateId>', toolName: 'winstage-stage', reason }`
 *   decided: `{ id: <同一个>, outcome: 'allowed-once' | 'rejected' }`
 * 于是两套审批**共享同一个审计面**：同一套 invariant 能检出孤儿、
 * 重放能看到 WinStage 的决策、清除语义可对齐。
 *
 * ── 三条硬约束（不遵守会造出新的静默失效）──────────────────────────────────────
 *  1. **回合内校验（照抄原生）**：`dsh-user-approval` 在 `:130` 硬校验"必须在开着回合内"，
 *     理由是**回合之间**追加的事件与"崩溃尾巴"无法区分、重放时会被静默丢弃。
 *     这里复刻它的 `hasOpenTurn`（`:49-56`：**倒序**扫 `turn/start`/`turn/end`）。
 *     回合外 ⇒ **不追加**，并记一条 warn（可见但不致命）。
 *  2. **审计失败绝不能影响审批**：append 抛错一律吞掉并记 error 级日志。
 *     一次暂存/一次批准不因为"日志写不进去"而失败。
 *  3. **可证伪**：本模块的每个分支都要能被断言打到（见 `docs/dsh2-3-audit-mirror.mjs`）。
 */

/** `turn/start` 之后、`turn/end` 之前 = 回合开着。倒序扫描，与原生同序。 */
export function hasOpenTurn(session) {
  try {
    const seq = Number(session?.seq)
    if (!Number.isFinite(seq) || seq <= 0) return false
    for (let i = seq - 1; i >= 0; i -= 1) {
      const event = session.eventAt?.(i)
      const type = event?.type
      if (type === 'turn/start') return true
      if (type === 'turn/end') return false
    }
  } catch {
    /* 读不到 ⇒ 视为没有开着回合（保守，不写审计） */
  }
  return false
}

/** WinStage 审批条目的审计 id：与候选 id 一一对应，且带命名空间防与原生撞号。 */
export function winStageApprovalId(candidateId) {
  const key = typeof candidateId === 'string' && candidateId.length > 0 ? candidateId : 'unknown'
  return `winstage:${key}`
}

/**
 * 造一个 `audit` 回调（注入 `ReviewService` 用）。
 *
 * @param {object} options
 * @param {(msg: string, level?: string) => void} [options.log] 信息级日志
 * @param {(msg: string) => void} [options.logError] error 级日志（"失败必须响"）
 * @param {() => object|undefined} options.sessionOf 取**当前** session 句柄（每次现读，拿不到返回 undefined）
 * @returns {{ ask: Function, decide: Function }}
 */
export function createAuditMirror(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {}
  const logError = typeof options.logError === 'function' ? options.logError : () => {}
  const sessionOf = typeof options.sessionOf === 'function' ? options.sessionOf : () => undefined

  /** 统一的"写一对里的一个"：回合内才写；任何失败都不上抛 */
  function emit(kind, payload) {
    try {
      const session = sessionOf()
      if (!session || typeof session.append !== 'function') {
        log(`winstage 审计：${kind} 跳过（拿不到 session 句柄）`)
        return false
      }
      if (!hasOpenTurn(session)) {
        // 照抄原生的理由：回合之间的事件 = 崩溃尾巴，重放会被静默丢弃
        log(`winstage 审计：${kind} 跳过（当前不在开着回合内，写下去与崩溃尾巴无法区分）`)
        return false
      }
      session.append(kind, payload)
      return true
    } catch (error) {
      // ★ 审计失败绝不影响审批本身
      logError(`winstage 审计：写 ${kind} 失败（已忽略，不影响审批）：${error?.message ?? error}`)
      return false
    }
  }

  return {
    /**
     * 暂存产生待审候选 ⇒ 写 `approval/asked`。
     * @param {{candidateId?: string, fileCount?: number, reason?: string}} info
     */
    ask(info = {}) {
      const id = winStageApprovalId(info.candidateId)
      const count = Number.isFinite(info.fileCount) ? info.fileCount : undefined
      const reason =
        typeof info.reason === 'string' && info.reason.length > 0
          ? info.reason
          : `${count ?? '若干'} 项变更已暂存，等待审批（/winstage approve|reject）`
      return emit('approval/asked', {
        id,
        toolName: 'winstage-stage',
        reason,
      })
    },

    /**
     * 批准/拒绝完成 ⇒ 写 `approval/decided`（与 asked 同一 id）。
     * `outcome` 沿用原生词汇：批准 = `'allowed-once'`（唯一的授予值），
     * 拒绝 = `'rejected'`。
     * @param {{candidateId?: string, approved?: boolean, pathCount?: number, note?: string}} info
     */
    decide(info = {}) {
      const id = winStageApprovalId(info.candidateId)
      const outcome = info.approved === true ? 'allowed-once' : 'rejected'
      const payload = { id, outcome }
      if (Number.isFinite(info.pathCount)) payload.pathCount = info.pathCount
      if (typeof info.note === 'string' && info.note.length > 0) payload.note = info.note
      return emit('approval/decided', payload)
    },
  }
}
