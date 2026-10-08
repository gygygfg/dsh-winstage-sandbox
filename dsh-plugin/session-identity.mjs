/**
 * session-identity —— "这次调用属于**哪个审批面**"的唯一口径。
 *
 * ── 解决的问题（用户报障"子 agent 没有包含在沙箱里"）─────────────────────────────
 * DSH 的每一次委派都会给子会话一个**自己的** session id（会话头里带
 * `parentSession` / `origin:'subagent'` / `delegationDepth`，见
 * `@deepseek-ai/dsh-session/lib/index.js:1048-1051`）。而 WinStage 的暂存/审批面是
 * **按会话**隔离的（`getReviewService()` 的键是 `canonical(root)#sessionKey`）——
 * 于是同一个任务里：
 *   · 主 agent 的改动落在**主会话**的 `queue.json` / `review.json` ⇒ 面板看得见；
 *   · 子 agent 的改动落在**子会话**的存储里 ⇒ **面板一条都不显示**，`/winstage approve`
 *     也批不到（用户看到的现象就是"子 agent 不在沙箱/审批面里"）。
 * 更糟的一种形态：子会话的身份在某些调用路径上解析不到（ambient initiator 缺位）⇒
 * 落到**共享** `.dshstage/` 存储，同样与面板脱节。
 *
 * 本模块把"归属哪个审批面"这件事收成一条规则：**子会话归到它的顶层祖先会话**。
 * 理由（设计选择，写清楚以免被当成实现细节）：
 *   · 用户是**一个人**、一轮任务**一个面板** —— 审批面按"人/任务"分，不按"agent 实例"分；
 *   · 委派是**同一轮任务的内部结构**，不是新的信任边界。让子 agent 的改动另开一个
 *     用户看不见的暂存区，等于"这批改动永远不会被批准，也永远不会被拒绝"，
 *     正是"静默"这一类缺陷；
 *   · 归到顶层**不放宽任何围栏**：写仍然先落暂存、仍要用户手势才落真实系统。
 *
 * ── 为什么不用"就把 sessionId 原样透传" ──────────────────────────────────────
 * 这正是修复前的行为，也是缺陷本身。父会话 id 只有在"子会话链的头"上才等于审批面，
 * 因此必须**沿 `parentSession` 向上走到头**，而不是只抄一层。
 */

/**
 * 顶层（非委派）祖先的 session id。
 *
 * @param {object} ctx        cordis 上下文（用 `ctx.get('sessions')` 拿会话注册表）
 * @param {object} session    当前调用方的 session 对象（`ctx.agents.currentInitiator()?.session`）
 * @returns {string|undefined}
 */
export function rootSessionIdOf(ctx, session) {
  if (!session || typeof session !== 'object') return undefined
  const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : ctx?.sessions
  let current = session
  const seen = new Set()
  for (let depth = 0; depth < 16; depth += 1) {
    const id = typeof current?.id === 'string' ? current.id : ''
    if (id.length === 0) return undefined
    if (seen.has(id)) return id // 环（不该出现）：停在这里，别无限走
    seen.add(id)
    const parentId = current?.header?.parentSession
    if (typeof parentId !== 'string' || parentId.length === 0) return id // 顶层：它就是审批面
    const parent = sessions && typeof sessions.get === 'function' ? sessions.get(parentId) : undefined
    if (!parent) {
      // 父会话对象拿不到（已回收 / 另一个进程）：仍然回到**父 id**。
      // 理由：父 id 至少比子 id 更接近审批面，而且它是稳定的（会话头的字面值）。
      return parentId
    }
    current = parent
  }
  return current?.id
}

/**
 * 把"显式给出的 sessionId"也归到顶层。`sandboxPolicy.sessionId` 是**字符串**，
 * 拿不到 session 对象时只能退回沿注册表查一次；查不到就原样返回
 * （**不猜**：宁可停在已知的那个 id，也不要凭空改身份）。
 */
export function rootSessionIdFor(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const sessions = ctx && typeof ctx.get === 'function' ? ctx.get('sessions') : ctx?.sessions
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
  if (!session) return sessionId
  return rootSessionIdOf(ctx, session) ?? sessionId
}
