/**
 * 环境监测（fail-closed）—— 插件启动前必须通过的门。
 *
 * ── 为什么要有它 ──────────────────────────────────────────────────────────────
 * 历史行为：`host-plugin.mjs` 启动探测**只 warn**（`probeRuntime().ready === false`
 * 也照样把插件装起来）。于是"环境不具备（非 Windows / 无法建立受限令牌 / ACL 后端
 * 不可用）"时，插件仍然接管 `ctx.fs`/`ctx.shell` —— 用户看到的是一堆难懂的失败，
 * 而不是"这个插件在你机器上不适用"。
 *
 * 现在：**环境不通过 ⇒ 插件拒绝启动**（`apply()` 抛错，行不激活）。每项检查都给出
 * 机读码与一句人能读的原因。
 *
 * ── 何时不拦（显式逃生口，绝不被顺手触发）──────────────────────────────────────
 *   · 设置里 `probeOnStart: false`（用户显式关掉启动探测）；
 *   · 环境变量 `WINSTAGE_SKIP_ENV_GATE=1`（开发/离线自测）。
 * 两者都**必须显式写出**，默认一律判红。
 *
 * 本模块是**纯函数层**（不读 fs、不调 Win32）；探测结果由 `host-plugin.mjs` 的
 * `probeRuntime()` 注入，因此可离线单测。
 */

/**
 * 评估环境。
 * @param {{
 *   enabled?: boolean,
 *   skip?: boolean,
 *   platform?: string,
 *   probeResult?: {ready?: boolean, detail?: string, missingRights?: string[], canMintRestrictedToken?: boolean} | null,
 * }} input
 * @returns {{ok: boolean, skipped: boolean, code: string, checks: Record<string, {ok: boolean, detail: string}>, failures: string[]}}
 */
export function evaluateEnvironment(input = {}) {
  const enabled = input.enabled !== false
  const skip = input.skip === true
  const platform = input.platform ?? process.platform
  const probe = input.probeResult

  const checks = {}
  if (skip) {
    return { ok: true, skipped: true, code: 'WINSTAGE_ENV_GATE_SKIPPED', checks, failures: [] }
  }
  if (!enabled) {
    return { ok: true, skipped: true, code: 'WINSTAGE_DISABLED', checks, failures: [] }
  }

  checks.platform = {
    ok: platform === 'win32',
    detail: `platform=${platform}（WinStage 沙箱依赖 Windows 受限令牌 / ACL / Job Object）`,
  }
  checks.runtime = probe
    ? { ok: probe.ready === true, detail: probe.detail ?? (probe.ready === true ? 'ready' : 'not ready') }
    : { ok: false, detail: '没有可用的运行期探测结果（probeResult 缺失）' }

  const failures = Object.entries(checks)
    .filter(([, v]) => !v.ok)
    .map(([k]) => k)
  return { ok: failures.length === 0, skipped: false, code: failures.length ? 'WINSTAGE_ENV_UNSUPPORTED' : 'WINSTAGE_ENV_OK', checks, failures }
}

/**
 * 面向人的一句失败原因（也用于日志与 `/winstage status`）。
 * @param {ReturnType<typeof evaluateEnvironment>} report
 */
export function environmentFailureMessage(report) {
  if (!report) return '环境监测：无报告'
  if (report.skipped) return `环境监测已跳过（${report.code}）`
  if (report.ok) return '环境监测通过'
  const parts = report.failures.map((k) => `${k}: ${report.checks[k]?.detail ?? '未通过'}`)
  return `环境监测未通过（${report.code}）：${parts.join('；')}`
}
