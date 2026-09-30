/**
 * 装配层「开关判定」—— WinStage 此刻是否应当接管执行面/文件面。
 *
 * ── 为什么单独一个模块（这是本轮修掉的结构性缺口）──────────────────────────────
 * 设置页那个开关的值**落在 profile 覆盖层** `<DSH_HOME>/profiles/<DSH_PROFILE>/cordis.patch.yml`
 * 的 `id: winstage-sandbox` 行的 `config.enabled` 上（实测：该文件里逐字写着 `enabled: false`）。
 *
 * 而 bundle 层（`cordis.patch.yml`）的**行装载决策**发生在 profile 覆盖层**之前**，
 * 拿不到"组合后的 config" ⇒ 无法直接知道开关是开是关。于是历史上只能靠一个
 * **环境变量** `WINSTAGE_SHELL` 做环境级门控；一旦某个 profile 用**字面量**
 * 覆盖 `disabled`（3080 的 web profile 就是这么做的），
 * 那个门控就被静默绕过 ⇒ WinStage **永远**占着 `ctx.shell`，
 * 哪怕开关是关的、哪怕档位是 `danger-full-access`。
 * 后果实测：每一条 `pwsh` 都被拒 ⇒ 用户感知"关了沙箱 shell 全废"。
 *
 * ── 本模块做什么 ───────────────────────────────────────────────────────────────
 * 用**纯文本 + 正则**从 profile 覆盖层读出 `enabled` 的布尔值：
 *   - 不解析 YAML（避免在 loader 求值表达式里引入解析器依赖与失败面）；
 *   - 只认 `id: winstage-sandbox` 这一段内的**第一个** `enabled: true|false`；
 *   - **fail-safe**：任何"判不出"的情况一律返回 `true`（= 保持历史行为：WinStage 接管）。
 *     这是刻意的：把"读不懂"解释成"关闭"会让用户**静默失去沙箱**，比保守更危险。
 *
 * 该判定同时被两处使用，保证**唯一真源**：
 *   1. bundle 的 `cordis.patch.yml` 里 `!!js` 内联（**必须内联**，见下）；
 *   2. `dsh-plugin/host-plugin.mjs` 的运行时判定（直接 import 本模块）。
 *
 * ── 为什么 YAML 里的 `!!js` 不能 import 本模块 ──────────────────────────────────
 * `!!js` 的求值器是 `new Function('ctx','expr','with (ctx) { return eval(expr) }')`
 * （`cordis-plugin-loader/src/config/utils.ts:5-9`），**同步**求值，
 * 而 `import()` 返回 Promise ⇒ 无法在其中 `await`。
 * 且实测该作用域内 **`require` 不可用**（`typeof require === 'undefined'`），
 * 唯一可用的读文件通道是 `process.getBuiltinModule('node:fs')`。
 * 因此 YAML 里必须写一段**内联**的等价判定；两处逻辑必须保持一致。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** profile 覆盖层的路径（DSH 的层序：bundle → profile → home → overlays） */
export function profilePatchPath(env = process.env) {
  const home = typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0 ? env.DSH_HOME : undefined
  const profile = typeof env.DSH_PROFILE === 'string' && env.DSH_PROFILE.length > 0 ? env.DSH_PROFILE : undefined
  if (!home || !profile) return undefined
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}

/**
 * 从一份 entry-list YAML **文本**里判定 `id: winstage-sandbox` 行的 `config.enabled`。
 * @param {string} source
 * @returns {boolean} `true` = WinStage 接管；判不出也返回 `true`（fail-safe 见文件头）
 */
export function winStageEnabledInProfileText(source) {
  if (typeof source !== 'string' || source.length === 0) return true
  // 只取 `id: winstage-sandbox` 之后、下一个 `- id:` 之前的那一段
  const section = /id:\s*winstage-sandbox\b([\s\S]*?)(?=\n\s*-\s*id:|\s*$)/.exec(source)
  if (!section) return true
  const hit = /enabled:\s*(true|false)\b/.exec(section[1])
  if (!hit) return true
  return hit[1] !== 'false'
}

/**
 * 读 profile 覆盖层并判定。**读不到文件/读失败也返回 `true`**（fail-safe）。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function winStageEnabledFromProfile(env = process.env) {
  try {
    const path = profilePatchPath(env)
    if (!path || !existsSync(path)) return true
    return winStageEnabledInProfileText(readFileSync(path, 'utf8'))
  } catch {
    return true
  }
}
