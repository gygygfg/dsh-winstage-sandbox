/**
 * loader 行入口：`winstage-shell`。
 *
 * ── 为什么单独一个模块（与 `fs-entry.mjs` 同构）──────────────────────────────
 * `cordis.patch.yml` 的行需要一个**默认导出即可装配**的插件，而 `shell-executor.mjs`
 * 还要被离线自测直接 `import`（自测要注入替身基类、替身执行器、替身工作区）。
 * 入口只做两件事：**fail-closed 地定位运行时那一份 `dsh-shell`**，再把
 * "按调用方会话解析工作区"的装配接好。
 *
 * ── 与 `fs` 那条线的关系 ────────────────────────────────────────────────────
 * 两行共享 `review-service.mjs` 的进程内单例（按 `canonical(root)#sessionId` 分键）：
 *   `winstage-fs`（fs-entry.mjs → staging-fs.mjs）：经 `ctx.fs` 的 write/edit 走暂存；
 *   `winstage-shell`（本文件）：经 `ctx.shell` 的 pwsh 调用**在 WinStage 沙箱内执行**，
 *   写入落**暂存树**、再由捕获链并回同一个会话的清单。
 * 两者都**不写真实主机** —— 那条硬要求的两个入口。因为共用同一个 `sessionIdOf()`
 * 口径与同一个 `getReviewService` 单例，命令的产出会出现在**同一个**会话的候选中。
 *
 * ── 工作区根从哪来（本轮修复：两个半边必须取**同一个根**）────────────────────
 * 历史形态：`declaredWorkspaceRoot()` = 显式装配值 > `WINSTAGE_SHELL_WORKSPACE` >
 * `process.cwd()`。最后那一档是**猜**：shell 半边拿到 `C:\Users\Administrator`
 * （宿主 cwd），而 fs 半边拿到 profile 配置的 `…\Desktop\WinStageSandbox`，
 * 于是**同一个 sessionId** 下出现两份 `.dshstage\sessions\<sid>\manifest.json`，
 * 各自自报不同的 `workspaceRoot`；而 `getReviewService()` 按根做单例 ⇒ 两个单例
 * ⇒ 暂存写到 A、面板发布在 B（**面板看不到命令产出**）。
 * 证据：`docs/dsh2-越界与注册表-实测诊断.md` §1（第 38-51 行）。
 *
 * 现在的取值顺序（逐条，**没有 `process.cwd()` 这一档**）：
 *   1. **loader 行表**（`entry.parent.data`）里 `winstage-fs` 行的 `cwd` —— 那才是
 *      fs 半边真正的存储根（`staging-fs.mjs` 用 `canonical(config.cwd)` 建 Store），
 *      所以它**就是权威**；同一个字面值由 bundle 的 YAML 锚点 `&winstageRoot` 绑在
 *      host 行 `workspaceRoot`、fs 行 `cwd`/`workspaceRoot`、shell 行 `workspaceRoot`
 *      四处（C-8：结构性同源）；由 `shell-executor.mjs` 的 `effectiveWorkspaceRoot()`
 *      取出并**交叉校验**：两处不一致 ⇒ error 级日志 + **以 fs 根的值为准**（宁可响，
 *      也不能分叉出第二个单例）；
 *   2. 行表里 `winstage-shell` 行的 `workspaceRoot`；
 *   3. 显式装配值：`configureShellWorkspaceRoot(root)`（行 config 经
 *      `WinStageShellExecutor` 的 `onConfig` 通路自动调入，见下）；
 *   4. `WINSTAGE_SHELL_WORKSPACE`（显式诊断逃生口，**不是猜**）。
 * 都没有 ⇒ **抛错**（`WINSTAGE_SHELL_NO_WORKSPACE_ROOT`）。宁可这一行报一条可读的
 * fail-closed 错误，也绝不再回退到 `process.cwd()`：那正是"两个根"的成因。
 *
 * ── fail-closed（与 fs-entry.mjs:25-33 同一风格）──────────────────────────────
 * 定位不到 `@deepseek-ai/dsh-shell` ⇒ **直接抛**。拿不到服务定义就不该注册任何
 * shell 提供方：宁可这一行装不上（用户看得见），也绝不让 `pwsh` 悄悄落回主机直跑。
 * 真正的 `import()` 仍然延迟到第一次 `execute()`（见 `shell-executor.mjs` 的
 * `loadBaseClass()`）—— 这样"包在、但里面不是 ShellExecutor"也会是一条可读的
 * fail-closed 错误，而不是加载期的天书。
 */

import {
  createWinStageShellExecutor,
  locatePackageFile,
  workspaceRootsOfLoaderRows,
} from './shell-executor.mjs'
import { getReviewService } from './review-service.mjs'

/** 与 `src/cli.mjs` 的 `exec` 分支同序：按包名相对路径定位运行时那一份 */
const SHELL_MODULE = locatePackageFile('@deepseek-ai/dsh-shell/lib/index.js')
if (!SHELL_MODULE) {
  throw new Error(
    'WinStage 沙箱 shell：无法定位 @deepseek-ai/dsh-shell。' +
      '拿不到 ShellExecutor 服务定义就不能安全接管执行面（绝不让 pwsh 落回主机直跑），' +
      '因此这里 fail-closed。请提供包含 @deepseek-ai/* 的 node_modules 根。',
  )
}

/**
 * 装配期显式覆盖（**可选**；接线方在 `cordis.patch.yml` 上加行时调用一次即可）：
 *
 *   import WinStageShellExecutor, { configureShellWorkspaceRoot } from '.../shell-entry'
 *   configureShellWorkspaceRoot(config.workspaceRoot)   // = host 行的 workspaceRoot
 *
 * 为什么不直接从构造函数拿 `config`：`WinStageShellExecutor` 是**类本身**，loader
 * 只负责 `new`，没有"装配钩子"可挂；而 `workspaceFor()` 被 `getReviewService()`
 * 按 `root#sessionId` 分键，一旦根写错就会分叉出第二个单例（面板看不到命令产出）。
 * 所以这里给一个**显式**的口子：不调用 ⇒ 走行表/env；调用 ⇒ 以调用值为准。
 */
let configuredRoot
export function configureShellWorkspaceRoot(root) {
  configuredRoot = typeof root === 'string' && root.length > 0 ? root : undefined
  return configuredRoot
}

/**
 * 工作区根：**唯一来源 = profile 配置的 `workspaceRoot`**（缺一档就抛，不猜）。
 *
 * @param {{fsRoot?: string, shellRoot?: string}} [rows]
 *   可选的 loader 行表取值（由 `shell-executor.mjs` 的 `effectiveWorkspaceRoot()`
 *   传下来；那是权威档）。传 `undefined` 时退回显式装配值 / 显式 env。
 * @returns {string} 规范化前的根字面值（非空）
 */
export function declaredWorkspaceRoot(rows) {
  const fromRows = rows && typeof rows === 'object' ? rows.fsRoot ?? rows.shellRoot : undefined
  if (typeof fromRows === 'string' && fromRows.length > 0) return fromRows
  if (configuredRoot) return configuredRoot
  const fromEnv = process.env.WINSTAGE_SHELL_WORKSPACE
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const error = new Error(
    'no workspace root is configured: the loader row config carries no "workspaceRoot" ' +
      '(and no explicit assembly value / WINSTAGE_SHELL_WORKSPACE is set). ' +
      '本次命令没有执行 —— 拒绝用 process.cwd() 去猜一个根（猜出来的根会让两侧分叉）。',
  )
  error.code = 'WINSTAGE_SHELL_NO_WORKSPACE_ROOT'
  error.winstage = { code: error.code, executed: false }
  throw error
}

/**
 * 装配用的 `workspaceFor(sessionId, rootOverride?)`。
 *
 * 为什么必须**带着 sessionId** 去取：`staging-fs.mjs` 的每一次写都按调用方会话解析
 * 存储根，而 `getReviewService` 是按 `canonical(root)#sessionKey` 做进程内单例的。
 * 这里若固定取"共享工作区"，就会出现"文件工具写进会话 A 的暂存树、命令跑在
 * 共享/别的会话的暂存树"—— 面板与 approve 只看得见一半。
 *
 * `rootOverride` 由执行器从 loader 行表算出的**权威根**传入（见文件头"工作区根从哪来"）：
 * 有了它，两个半边按定义取同一个根。
 *
 * `reload()` 照抄 `staging-fs.mjs:543-546` 的 `reloaded()`：另一个进程/会话可能
 * 刚改过同一份暂存树，命令必须跑在**最新**的那一份上。
 */
function workspaceFor(sessionId, rootOverride) {
  const rows =
    typeof rootOverride === 'string' && rootOverride.length > 0
      ? { fsRoot: rootOverride }
      : undefined
  const service = getReviewService({
    workspaceRoot: declaredWorkspaceRoot(rows),
    ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
  })
  // ★ 必须分两步：`reload()` 返回的是 `this.workspace`（Workspace 实例），
  //   对它再取 `.workspace` 得到 `undefined` —— **不抛错、只是返回假值**，
  //   于是 `execute()` 报 `WINSTAGE_SHELL_NO_WORKSPACE`、命令拒绝执行。
  //   这正是 `staging-fs.mjs:543-546` 的 `reloaded()` 写法：先 reload()，再取 workspace。
  service.reload()
  return service.workspace
}

/**
 * 默认导出就是 loader 行的插件类本身。
 *
 * ★ `base` 必须在**装配期**给出真正的 `ShellExecutor` —— 这是一个实测出来的激活阻断：
 *   `ctx.shell` 这个服务名是在**基类构造函数**里 `provide` 出去的（装配期）。
 *   本文件原先只传 `workspaceFor`，实现便退回"中性基类 + 延迟 `loadBaseClass()`"，
 *   而那个中性基类不 `provide` 任何服务 ⇒ `tool-pwsh` 永远
 *   `pending (waiting for service: shell)`、**会话里连 pwsh 工具都没有**。
 *   实测证据：`.t/shell-e2e.log` 的 `dsh: warning: 2 entries did not activate`
 *   （那 2 条正是 `permission` 与 `tool-pwsh` 在等 `service: shell`）。
 *   注意：模块顶部已经 fail-closed 地定位过 `SHELL_MODULE`，所以这一步不会引入新的失败面。
 */
const WinStageShellExecutor = createWinStageShellExecutor({
  workspaceFor,
  // Windows 路径转成 file: URL 交给动态 import（避免再引一个 import 语句）
  base: (await import(`file:///${SHELL_MODULE.replace(/\\/g, '/')}`)).ShellExecutor,
  // ★ 让**行 config** 也能定根：cordis 会把正规化后的 config 交给构造函数，
  //   这里现读 `config.workspaceRoot`。
  onConfig: (config) => {
    const root = config && typeof config.workspaceRoot === 'string' ? config.workspaceRoot : ''
    if (root.length > 0) configureShellWorkspaceRoot(root)
  },
})

export default WinStageShellExecutor
export { WinStageShellExecutor, SHELL_MODULE, workspaceFor, workspaceRootsOfLoaderRows }
