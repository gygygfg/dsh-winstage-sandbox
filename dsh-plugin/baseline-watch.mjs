/**
 * 基线漂移**只读轮询复核**（缺陷② F5b：过期基线不可见的触发点补全）。
 *
 * ── 根因（为什么"发布"不够）──────────────────────────────────────────────────
 * `review.json` 只在**变更/命令**时发布：`staging-fs` 的写盘后钩子（`afterMutation`）、
 * 每条 `/winstage*` 命令、shell 命令的 `publishWorkspaceSnapshot()`。而 `pwsh` 工具
 * **绕过 `ctx.fs` 直接写真实磁盘**，不产生上述任何一个事件 ⇒ 快照的 `generatedAt`
 * 会一直冻在上一次发布。实测（`docs/DSH沙箱边界-实例侧实测.md` §3.4 F5b）：
 * 90 秒内一次都没重发布，`staleBaseline = 0`、`alerts = []`、UI 无任何徽标，
 * 面板上那条"新增 f5b-stale.txt"看起来毫无异常 —— 直到点「批准所选」把真实盘
 * 上的 `SHELL-VERSION` 静默覆盖成 `STAGED-VERSION`。
 *
 * ── 本模块做什么 / 不做什么 ─────────────────────────────────────────────────
 * 做：按**轮询节拍**（默认 1500 ms，与 Client 读快照的轮询对齐）调用每个会话服务的
 * `reviewDrift()`。那个方法是**纯读**的：先用"清单 mtime + 每条净 diff 两侧 hash +
 * 漂移形状"组成指纹，指纹没变就立刻返回，**不写盘、不改状态**；只有事实真的变了
 * 才 `publish()` 一版新快照。因此外部写入会在一个节拍内出现在面板上，
 * 而"什么都没动"时这里是零 IO（不是忙等）。
 *
 * 同时把新出现的漂移送上**人工侧**诊断通道（`service.logError` → 宿主 logger /
 * 宿主 stderr）。⚠ 契约（`shell-executor.mjs:1319-1335` 的分离纪律）：
 * **绝不**写模型可见的 stdout/stderr，也绝不进任何命令的 `text` 返回值。
 *
 * 不做：不对准基线、不 discard 候选、不冻结候选、不写任何暂存状态。
 * 也就是说，"轮询"永远不会成为那个把外部内容盖掉的动作 —— 那是缺陷②的另一半。
 *
 * ── 生命周期 ────────────────────────────────────────────────────────────────
 * 通过 `ctx.effect()` 装配（cordis 的卸载协议）；没有 `ctx.effect` 时退化成
 * `setInterval` + `unref()`（定时器不把进程钉住）。间隔可用 `WINSTAGE_WATCH_MS`
 * 覆盖（自测用；非正数 = 关闭）。
 *
 * 为什么不用 `fs.watch`：真实工作区里会被外部改的是**任意**文件，而 `fs.watch`
 * 在 Windows 上只给"某个目录下发生了什么"、还要为每个暂存键的父目录挂一棵递归
 * 监听树（工作区外键更是挂不动）。指纹轮询的代价是"读几个 mtime + 对漂移路径
 * 各算一次 hash"，条数被暂存条数界住，比一棵监听树可预测得多。
 */

import { listReviewServices } from './review-service.mjs'

/** 默认节拍：与 Client 读 `review.json` 的 1500 ms 轮询同一档（不多打一拍） */
export const WATCH_INTERVAL_MS = 1500

/** 从环境读节拍（自测用）。非法/非正数 ⇒ undefined（调用方退回默认/关闭） */
export function watchIntervalFromEnv(env = process.env) {
  const raw = env?.WINSTAGE_WATCH_MS
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  if (!Number.isFinite(value)) return undefined
  return value
}

/**
 * 装配只读复核。幂等：同一进程里重复调用会各起一个定时器，因此调用方只应调一次。
 *
 * @param {object} ctx cordis 上下文（可选 `effect`；没有也能跑）
 * @param {{workspaceRoot: string, log?: (message: string) => void, logError?: (message: string) => void, intervalMs?: number, env?: object}} options
 * @returns {{stop: () => void, intervalMs: number, tick: () => number}}
 *   `tick()` 是**可离线调用**的一拍（自测直接用，不必等定时器）：返回本拍处理的
 *   服务数（便于断言"确实复核了 N 个会话"）。
 */
export function installBaselineWatch(ctx, options = {}) {
  const { workspaceRoot, log = () => {}, logError = () => {}, env = process.env } = options
  if (!workspaceRoot) throw new Error('installBaselineWatch: workspaceRoot is required')

  const envInterval = watchIntervalFromEnv(env)
  const intervalMs = options.intervalMs !== undefined ? options.intervalMs : envInterval !== undefined ? envInterval : WATCH_INTERVAL_MS

  /**
   * 一拍：
   *   1. 找当前工作区的所有活着的会话服务（没建过的会话不在册，零成本）；
   *   2. 每个服务跑一次 `reviewDrift()`（纯读 + 指纹短路）；
   *   3. 把**新出现**的漂移写进人工侧诊断通道（`emitDriftDiagnostics` 自己去重）。
   * 任何单个服务的异常都吞掉并记 error ⇒ 复核面永不拖垮插件。
   */
  const tick = () => {
    let services = []
    try {
      services = listReviewServices(workspaceRoot)
    } catch (error) {
      logError(`基线复核：枚举会话服务失败（已忽略）：${error?.message ?? error}`)
      return 0
    }
    for (const service of services) {
      try {
        const result = service.reviewDrift()
        if (result.changed === true && result.stale.length > 0) {
          log(`基线复核：外部改动使 ${result.stale.length} 项基线过期，已重新发布快照。`)
        }
        if (typeof service.emitDriftDiagnostics === 'function') service.emitDriftDiagnostics(result.stale)
      } catch (error) {
        logError(`基线复核失败（已忽略，不影响审批）：${error?.message ?? error}`)
      }
    }
    return services.length
  }

  // 非正数/0 ⇒ 关闭（自测的"关掉复核"档）；`undefined` 已被上面的默认值吃掉
  if (!(intervalMs > 0)) {
    return { stop: () => {}, intervalMs: 0, tick }
  }

  let timer
  const start = () => {
    timer = setInterval(tick, intervalMs)
    // 不让复核定时器成为"进程退不出去"的原因（Node 特有；浏览器/其他环境没有这个方法）
    if (timer && typeof timer.unref === 'function') timer.unref()
  }
  const stop = () => {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  if (ctx && typeof ctx.effect === 'function') {
    // cordis 卸载协议：effect 返回清理函数，行被卸载/重挂时定时器随之消失
    ctx.effect(() => {
      start()
      return stop
    }, 'winstage-sandbox: baseline watch')
  } else {
    start()
  }

  return { stop, intervalMs, tick }
}
