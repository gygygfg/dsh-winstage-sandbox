/**
 * WinStage 沙箱 shell 执行器 —— `ctx.shell` 的一个**替代**提供方。
 *
 * ── 它做什么 ────────────────────────────────────────────────────────────────
 * 继承 `@deepseek-ai/dsh-shell` 的 `ShellExecutor`（**运行时那一份**），把 DSH 的
 * `pwsh` 工具的每一次调用**真的关进 WinStage 沙箱**里执行：
 *
 *   dsh-tool-pwsh ──resolve/execute──▶ 本文件 ──▶ WindowsStageExecutor
 *                                                  （受限令牌 / ACL / Job Object）
 *                                                       │
 *                                                       ▼
 *                                      cwd = 暂存树；产出被捕获回清单 → 候选
 *
 * 命令的 **cwd 是暂存树**（`<store>/staged`），不是真实工作区；命令在暂存树里写下
 * 或删掉的东西由 `captureAfterExecution()` 抓回来，经 `ingestCapturedChanges()`
 * 并入清单、`freezeIfNeeded()` 冻结成待审候选 —— 与 `src/cli.mjs` 的 `exec` 分支
 * **同一条链、同一顺序**（那里的用法是这条流程的唯一权威）：
 *
 *   materializeForExecution → snapshotStagedTree → run(cwd=stagedDir)
 *     → captureAfterExecution → ingestCapturedChanges → freezeIfNeeded → dispose
 *
 * ── 为什么 `sandboxMode` 必须报 `undefined`（刻意，不是"没实现"）──────────────
 * `dsh-tool-pwsh` 在装配时读 `ctx.shell.sandboxMode`（dsh-tool-pwsh/lib/index.js:314-317）：
 *   `const defaultMode = ctx.shell.sandboxMode`
 *   `const escalationModes = defaultMode === void 0 ? [] : ESCALATION_TARGETS`
 *   `const sandboxPolicy = defaultMode === void 0 ? void 0 : ctx.get('sandboxPolicy')`
 *   `if (defaultMode !== void 0 && sandboxPolicy === void 0) throw new Error(...)`
 * 一旦我们报出一个模式，工具就：①**要求** `ctx.sandboxPolicy` 存在（拿不到整条插件
 * 加载失败）；②向模型广告 `sandbox_permissions`/`justification` 并走 `ctx.approval`
 * 的"升权"路径；③把 `sandboxPolicy` 塞进 `ShellExecRequest`，期望执行器**按它围栏**。
 * 而本设计里"升权"= 允许直写**主机**，与"绝不在主机上直接执行"直接冲突；
 * 围栏由 `WindowsStageExecutor` 的受限令牌 + ACL 提供，我们不接受任何更大权限的请求。
 * 所以这里如实报 `undefined`：不广告、不升权、不要 `ctx.sandboxPolicy`。
 * （与 `staging-fs.mjs` 在暂存面 `get sandboxMode() { return undefined }` 同一口径。）
 *
 * ── 三条必须遵守的契约（读 DSH 源码得到，违反会静默劣化）──────────────────────
 *   1. **fail-closed 是绝对的**：能力不可用 / `init()` 抛错 / 物化失败 / 拿不到
 *      `WindowsStageExecutor` / 定位不到暂存树 ⇒ **抛错**。任何情况下都**不退回**
 *      "在主机上直接跑" —— 那正是本插件存在的理由。
 *      ★ WP6 修订：错误文案**不再**统一写"本次命令没有执行"（那句话在
 *      "报 access-denied 但子进程其实跑过"的场景里会变成**与事实相反的结论**）。
 *      现在按**三层语义**给文案（见本文件 `SEMANTIC_CODES` 一节）：
 *        · `DENIED_ACTION_NOT_PERMITTED: 请求的操作不被允许（权限/策略判定），本次未执行。`
 *        · `ENV_FAULT_RETRYABLE: 执行环境故障，命令没有运行；这是可重试的环境问题。`
 *        · `COMMAND_FAILED: 命令失败。`（`WINSTAGE_SHELL_RUN_FAILED` 逐条命令判定；
 *          有执行证据时 `error.indeterminate === true` 且 `winstage.executed === 'unknown'`，
 *          **不得**据此断言"命令未执行"）
 *      三类机读码**互不相同**；文案里零沙箱痕迹（禁用词见
 *      `src/executor.mjs::TRANSPARENCY_FORBIDDEN_TOKENS`，`_r3/wp6-test.mjs` B 组机检）。
 *   2. `execute()` 返回**已结算**的句柄：契约明写"Expiry during preparation returns
 *      a **settled** timed-out handle without output"
 *      （dsh-shell/lib/types/index.d.ts:40），所以"跑完再构造句柄"是合法的。
 *      `status`/`exitCode`/`signal`/`done`/`result()`/`readOutput()`/`observed`/`kill()`
 *      逐项按 `ShellExecution` 填。
 *   3. 错误必须是**可归因**的：`dsh-tool-pwsh` 用 `result.aborted` / `isError` 判别。
 *      这里不 import 任何 DSH 核心包，只 import **本仓库**的 `src/executor.mjs`，
 *      并在运行时按 `resolveDshModuleRoot()` 找到的**绝对路径** import `dsh-shell`
 *      （与 `staging-fs.mjs:59-72` 同一写法，避免第二份 Service 基类实例问题）。
 *
 * ── 与同目录另一份 `shell-executor.mjs` 草稿的关系（如实说明）──────────────────
 * 写入前磁盘上已存在一份**别的写入者**留下的草稿（顶层 `await import(dsh-shell)` +
 * 要求 `options.workspaceRoot` + 固定起 `powershell -NoProfile -Command`）。本文件
 * 按派工单重写，与那份草稿的差异是**刻意的**：
 *   - 顶层 await → 移到 `execute()` 内（`loadBaseClass()`）：拿不到 DSH 包时给出
 *     **可读的 fail-closed 错误**，而不是让 loader 行加载失败；
 *   - `workspace` 由**构造时的字面值**改为**每次现读**（函数/带 `reload()` 的服务/
 *     实例三种形态都接受）：跨进程改动可见，装配方也能构造之后再挂；
 *   - `pwsh` 路径**显式解析**（PATH 上的 pwsh.exe → Windows PowerShell 5.1 兜底），
 *     不再硬编码 `powershell`；
 *   - 输出按 `CollectedOutput` 形状**有界捕获**（`truncated` 如实标注、不伪造 spillPath）；
 *   - 捕获/冻结的失败信息**随返回带出**（`winstage.capture.failures` + error 级日志），
 *     但**绝不进模型可见的 stdout/stderr**（那两路必须与命令自己的输出逐字节一致）。
 *
 * ── 如实声明的残余边界（不得读成"已经解决"）────────────────────────────────
 *   - **读取面不设限**：受限令牌只约束**写类**访问（WRITE_RESTRICTED + Low 完整性
 *     标签只做 no-write-up），沙箱内进程仍可读调用者可读的文件
 *     （`src/executor.mjs` 文件头"诚实声明"一节）。读取收敛仍靠 DSH 工具层遮蔽。
 *   - **命令字符串的解析**：DSH 的 pwsh 工具把整条 PowerShell 脚本放进 `spec.command`。
 *     这里只识别 `pwsh`/`powershell` 开头的**显式前缀**（含 `-NoLogo -NoProfile …` 这类
 *     开关）并剥掉，取 `-Command` 之后的**全部文本**作为**一个**参数（PowerShell 自己
 *     解析脚本，中间没有第二层 shell ⇒ 没有引号转义问题）。`-EncodedCommand` / `-File` /
 *     `-Version` 等其它形态**不解析**，原样留在参数里（不静默改写语义）。
 *   - **stdin 不支持**：`WindowsStageExecutor` 走 `CreateProcessAsUserW` + 管道，没有通到
 *     子进程 stdin 的通道。`spec.stdin` 被如实记入 error 级注记（不静默丢弃、不报成功）。
 *   - **没有"当场 kill"**：`execute()` 等 `executor.run()` 跑完才返回句柄，句柄一出生就是
 *     终态，`kill()` 只能返回 `false`；超时/中止是**跑完后如实分类**，真正的时限由
 *     `WindowsStageExecutor.run()` 自己的 timeout + `terminate(124)` 执行。
 *   - **环境**：子进程环境按执行器的允许清单**重建**（绝不 merge 父环境），另加
 *     `dshEnv` / `env` 覆盖与 `NO_COLOR`/`PAGER`/`GIT_PAGER`。名字像凭据的覆盖项会被
 *     执行器拒绝（`envRejected`），这里只如实记一条注记。
 *   - **明文出站凭据只拦"能看见的"**（WP7′，**不得**读成"已经拦住"）：`detectCleartextSecret()`
 *     只在**命令文本里**同时出现"出站动词 + 密钥形态"（PEM 私钥块 / `AKIA…` / `ghp_…` /
 *     `xox?-…` / `sk-…` / JWT / `Authorization: Bearer …`）时判定"该请求不被允许"。
 *     **检测不到**的两类必须如实说明：① **TLS 正文**里的凭据（加密后正则看不见）；
 *     ② 运行期才从文件/环境变量读出来、再拼进请求体的密钥（命令文本里根本没有那个字面量）。
 *     ⇒ 本检测是**尽力而为的正向证据**，不构成"出站凭据不会泄漏"的保证。用户侧安全声明
 *     （`/winstage status` / README）由**别人**负责，这里只保证**不写成"已拦截"**。
 */

import { appendFileSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  WindowsStageExecutor,
  resolveDshModuleRoot,
  // ── WP6/WP7′：错误语义分层 + 限制即失败（同一口径，不另造第二套判定）──────────
  //   `classifyFailureSemantics` / `transparencyViolations` 是**纯函数**，
  //   本文件与 `_r3/wp6-test.mjs` 复用同一份实现 ⇒ 两处口径不会漂移。
  classifyFailureSemantics,
  transparencyViolations,
  detectCleartextSecret,
  FAILURE_SEMANTICS,
  FAILURE_CATEGORY_CODES,
  CLEARTEXT_SECRET_FAILURE,
} from '../src/executor.mjs'
// ★ 同仓库模块（不是 DSH 包）：命令产出「立刻出现在面板」要用到审阅快照发布
//   （`getReviewService(...).publish()` —— 与 `/winstage refresh` 同一条调用）。
//   ⚠ 本模块源码会被 `.t/shell-selftest.mjs` 复制成变异体，复制时要**同时**改基准：
//     `'../src/executor.mjs'` → `'../../src/executor.mjs'`，`'./review-service.mjs'` →
//     `'../../dsh-plugin/review-service.mjs'`，`'../src/audit-report.mjs'` →
//     `'../../src/audit-report.mjs'`（见该文件 `loadMutant()` 的 rebase）。
import { getReviewService } from './review-service.mjs'
import { buildAuditReport, summarizeAudit } from '../src/audit-report.mjs'
import { captureRegistryChanges } from './registry-capture.mjs'
import { rootSessionIdFor, rootSessionIdOf } from './session-identity.mjs'

// ==================== 常量 ====================

/**
 * 与 `@deepseek-ai/dsh-pwsh-local` 的同名配置**同值**（那边 lib/index.js:142-145
 * 的 `12e4 / 6e5 / 64e3`）。同值不是为了好看：`dsh-tool-pwsh` 会
 * `await handle.result()`，超时/输出预算一旦不一致，"同一台机器上换个执行器就换了行为"。
 */
export const DEFAULT_TIMEOUT_MS = 120_000
export const DEFAULT_MAX_TIMEOUT_MS = 600_000
export const DEFAULT_MAX_OUTPUT_BYTES = 64_000

/**
 * 与 `dsh-pwsh-local` 逐字相同的两个事实源（那边 lib/index.js:87-100）：
 *   - 环境覆盖：`NO_COLOR`/`PAGER`/`GIT_PAGER`（不让分页器把命令挂住）；
 *   - UTF-8 前导：Windows PowerShell 5.1 默认按控制台代码页输出，非 ASCII 会乱码。
 * 这里**复制字面值**而不是 import `dsh-pwsh-local`：那份模块会把
 * `@deepseek-ai/schemastery` 与 `dsh-subprocess` 拉进加载图，而本插件只需要两个常量；
 * 值有变时以 `dsh-pwsh-local/lib/index.js` 为准（行号已钉在上面）。
 */
const ENV_OVERRIDES = { NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' }
const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
  '$OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

// ==================== 档位（lane）判定：分类 + 持久化 + 一句话结论 ====================

/**
 * ── BUG-B：档位降级必须**可查询**，不许只活在一条 error 级日志里 ──────────────
 *
 * `tier:'auto'` 的透明垫片探测不过时，`selectLaunchMode()`（`src/executor.mjs:3805-3816`）
 * fail-closed 回退到**受限令牌档**，`fallbackReason` 形如
 * `transparent shim unavailable (…) — fail-closed fallback to the restricted-token mode`。
 * 那一档里**没有 shim**：注册表写只剩内核硬拒（`ERROR_ACCESS_DENIED`）、子进程 stdio
 * 可能被掐断、命令的文件产出也不进暂存 —— 而会话内表现与"沙箱一切正常"**一模一样**。
 * 这正是本仓库最忌讳的静默失败形态。
 *
 * 修法（不碰"零痕迹"契约）：把"最近一次档位判定"落成**结构化可查询产物**
 * （会话存储根下的 `sandbox-lane.json`），`/winstage status` 直接读它并给出**一句话结论**。
 * ⚠ 结构化产物与 `notes` 都属于**人工/命令通道**，**不是**命令自身的 stdout/stderr
 * （见 `settledExecution()`），因此模型可见通道仍然逐字节干净。
 */

/** 档位判定的持久化产物名（落在 `workspace.store.dir` = 会话存储根） */
export const LANE_JOURNAL_BASENAME = 'sandbox-lane.json'

/**
 * 「载体进程初始化失败」这一类的一句话文案（`classifyLaneFallback` 用）。
 *
 * 刻意写明"**不是**能力/ABI 问题"：旧分类把这条原因归成 `probe-failed`
 * （文案"探测未通过（金丝雀能力 / selftest / ABI 不匹配）"），把排查方向直接引偏
 * （BUG-carrier-init-failure §4.2）。
 */
export const CARRIER_INIT_FAILED_TEXT = '载体进程初始化失败（注入成功但子进程 CLR/.NET 启动期退出；不是能力/ABI 问题）'

/**
 * `fallbackReason` → **可读分类**（纯函数，离线自测直接喂字符串）。
 *
 * 无法归类 ⇒ `unclassified` 并**原样透出** `raw`（绝不吞掉原因）。
 * 判定优先级 = ①**结构化前缀**（认前缀，措辞无关）→ ②`carrier-init-failed` 正则兜底
 * → ③`artifact-missing` → ④其余。两条顺序不变量：
 *   · `carrier-init-failed` 必须**先于** `probe-failed`：后者的 `unavailable` 会抢走
 *     `selectLaunchMode()` 自己的外壳文本（实测，见函数内注释）；
 *   · `artifact-missing` 必须**先于** `token-restricted`：那条真实 reason 里同时含
 *     `restricted-token` 字样（"…fallback to the restricted-token mode"），先判令牌就会
 *     把"产物缺件"误报成"令牌能力不足"，把用户引到完全错误的排查方向。
 */
export function classifyLaneFallback(reason) {
  const raw = typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : null
  if (raw === null) return { code: 'none', text: '没有回退原因（本次档位是直接选定的）', raw: null }
  /**
   * 先剥掉 `selectLaunchMode()` 那句**后果**描述
   * （"…— fail-closed fallback to the restricted-token mode"）：**每一次**回退都带它，
   * 而里面的 `token` 字样会把"产物缺件"这类**原因**误判成"令牌能力不足"，
   * 把用户引到完全错误的排查方向（离线自测抓到的第一条假分类）。
   */
  const lowered = raw.toLowerCase()
  const lower = lowered.replace(/[—–-]?\s*fail-closed fallback to the restricted-token mode\.?/g, ' ')
  const hit = (code, text, re) => (re.test(lower) ? { code, text, raw } : undefined)
  /**
   * ── C1：**先读结构化前缀**，正则只兜底（BUG-carrier-init-failure §4.3(a)）────────
   *
   * 为什么必须"先读前缀"而不是继续堆正则：实测（报告 §4.2）在 347 字符的真实
   * `fallbackReason` 上，旧分类器的**唯一命中项是 `selectLaunchMode()` 自己写的外壳词
   * `unavailable`** —— 分类结果是**外壳措辞的函数**，不是真实原因的函数；把外壳剥掉后
   * 同一条原因立刻退化成 `unclassified`（因为原文只有 `failure`、没有 `failed`）。
   * 现在 `src/executor.mjs` 在"注入器 ok 但载体起不来"时把原因写成
   * `carrier-init-failed: …`，这里**认前缀**，措辞再变也不会掉类。
   */
  const structured = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*):/.exec(lowered)
  if (structured !== null && structured[1] === 'carrier-init-failed') {
    return { code: 'carrier-init-failed', text: CARRIER_INIT_FAILED_TEXT, raw }
  }
  return (
    hit('carrier-init-failed', CARRIER_INIT_FAILED_TEXT, /carrier-init-failed|injector exit=(0x)?ffff0000|4294901760|the shell cannot be started|could not load file or assembly|exception from hresult|0x8007054f|0x800700b7|0xe0434352|status_dll_init_failed|0xc0000142/) ??
    hit('artifact-missing', 'shim 产物缺失或不完整（DLL / winstage-inject.exe / winstage-probe.exe）', /not found:|no such file|enoent|incomplete|artifacts missing/) ??
    hit('acl-denied', 'ACL/写权限被拒（EPERM / ACCESS_DENIED / 暂存根建不出来）', /access is denied|eperm|eacces|privilege not held|cannot create|cannot write|dacl/) ??
    hit('env-missing', '环境缺件（暂存根未给出、shim 配置/环境变量写不进）', /stagingroot|stage-root|environment|env\b|not set|required|config/) ??
    hit('token-restricted', '受限令牌能力不可用（创建令牌 / 权限不足）', /token|logon|privilege|seclogon|restricted/) ??
    // ⚠ 这里的 `fail(ed|ure)` **必须带归因作用域**，不能裸放：裸放会让任何只是"提到 failure"
    // 的未知原因都被贴成"探测未通过"——分类重新变成**措辞**的函数（§4.2 那类缺陷的翻版），
    // 也违反"无法归类必须原样透出成 unclassified"的契约。
    // 因此只在**归因于注入器/shim/透明通道**时才认（`injector … injection failure` 要判
    // probe-failed），而 `some brand new failure nobody has seen` 这类无归因散文必须留 unclassified。
    // 载体初始化失败另有更强的判据：上面的结构化前缀与具体错误码
    // （0x8007054f / 0xc0000142 / could not load file or assembly …）。
    hit('probe-failed', '探测未通过（金丝雀能力 / selftest / ABI 不匹配）', /probe|canary|selftest|self-test|abi|unavailable|(?:injector|shim|transparent)[^.]{0,40}?fail(ed|ure)/) ?? {
      code: 'unclassified',
      text: `未归类的回退原因：${raw}`,
      raw,
    }
  )
}

/**
 * 档位记录 → **结构化状态 + 一句话结论**（纯函数）。
 *
 * 最危险的形态（`launchMode !== 'shim'` 且开关为**开**）必须给出明确结论：
 * "沙箱未生效：命令在受限令牌档执行，写入只剩内核硬拒…"。
 * 开关为**关**时同样要如实记录（关态不是"没有事实"，只是"不是告警"），
 * 但结论里标明"属预期，仅作记录"。
 */
export function summarizeLane(lane) {
  const record = lane && typeof lane === 'object' ? lane : {}
  const reported = typeof record.launchMode === 'string' && record.launchMode.length > 0 ? record.launchMode : null
  /** `launchMode: 'unknown'`（执行器没报出通道）与"根本没记录"是两件事，都不许猜成 shim。 */
  const launchMode = reported === 'unknown' ? null : reported
  const off = record.winStageEnabled === false
  const fallback = classifyLaneFallback(record.fallbackReason)
  const tier = record.tierEffective ?? null
  const base = {
    /**
     * 对外**原样**透出执行器报出的通道名（`'unknown'` 也如实显示）；
     * 判定用的是下面归一后的 `launchMode`（`'unknown'` ⇒ 按"未证实已生效"对待）。
     */
    launchMode: reported ?? null,
    tierEffective: tier,
    requestedTier: record.requestedTier ?? null,
    winStageEnabled: !off,
    fallback: fallback.code,
    fallbackText: fallback.text,
    at: record.at ?? null,
  }
  if (launchMode === null) {
    return {
      ...base,
      status: 'unknown',
      degraded: null,
      conclusion:
        reported === 'unknown'
          ? '沙箱档位未知：执行器没有报出 launchMode（无法判断是否走了 shim 通道）—— 按"未证实已生效"对待。'
          : '沙箱档位未知：本会话还没有记录到任何一次档位判定（没有命令经过执行器）。下一步：跑一条 pwsh 命令后再看这里。',
    }
  }
  if (launchMode === 'shim') {
    return {
      ...base,
      status: 'active',
      degraded: false,
      conclusion: `沙箱已生效：命令走透明垫片（去令牌化）通道（tier=${tier ?? '?'}），文件与注册表写入进暂存。`,
    }
  }
  const cause =
    fallback.code === 'none'
      ? '（没有回退原因记录：这个档位是被直接选定的，并非探测失败后的回退）'
      : `（回退分类：${fallback.code} — ${fallback.text}）`
  if (off) {
    return {
      ...base,
      status: 'off',
      degraded: true,
      conclusion:
        `WinStage 开关为关闭态：档位=${launchMode}（tier=${tier ?? '?'}），没有 shim 通道 —— ` +
        `本执行器此刻不接管暂存面，此形态属预期，仅作记录。${cause}`,
    }
  }
  const laneText = launchMode === 'appcontainer' ? 'AppContainer 档（T0）' : '受限令牌档'
  /**
   * 归因提示按**分类**给，不再一律"请检查 shim 产物是否齐备"。
   * `carrier-init-failed` 时产物与注入器都是好的（`report.ok=true`），那句话会把用户
   * 引到错误的排查方向（BUG-carrier-init-failure §4.2 的文案误导）。
   */
  const remedy =
    fallback.code === 'carrier-init-failed'
      ? '注入器自报 ok=true ⇒ 不是产物/注入器问题：是载体进程自身（powershell.exe 的 CLR/.NET）在初始化期退出，退出码/HRESULT 已原样保留在该回退原因尾部。'
      : '请检查 shim 产物是否齐备。'
  return {
    ...base,
    status: 'degraded',
    degraded: true,
    conclusion:
      `沙箱未生效：命令在${laneText}（launchMode=${launchMode}, tier=${tier ?? '?'}）执行，` +
      '写入只剩内核硬拒、子进程 stdio 可能被掐断、文件产出不进暂存；' +
      `${remedy}${cause}`,
  }
}

/**
 * ── WP3：档位 / 失根的**历史**（"是否曾掉档"与"首次掉档"）──────────────────────
 *
 * BUG-B 只落了**最近一次**判定，回答不了用户真正会问的两个问题：
 *   · "这个会话**掉过档没有**？"（只看 lastLane 的话，恢复成 shim 之后那段历史就消失了）
 *   · "**第一次**掉档是什么时候、第几条命令、什么原因？"
 *
 * 因此产物里多出一段 `history`（**只加不改**：原有顶层字段一个不动、`summary` 原样保留，
 * 于是 BUG-B 的读侧与既有断言都不受影响）：
 *
 *   { seq, history: {
 *       commandSeq, shimCount, degradeCount,
 *       firstDegrade: null | { at, seq, launchMode, tierEffective, fallbackClass, fallbackReason },
 *       rootLoss:     null | { everLost, count, lastReason, lastAt, lastPhase, lastSeq, observedAt } } }
 *
 * `seq` 是**持久化**的命令序号（每落一次档位判定 +1，从产物里的旧值续）：进程重启后
 * 内存计数器会归零，那样"第 3 条命令掉档"就永远是错的。
 *
 * `firstDegrade` **写一次就冻结**（后续写入只读不覆盖）—— 这正是"首次"的语义，
 * 也是"是否曾掉档"的唯一权威来源。
 */

/** 读档位产物（**宽容**：缺失/损坏都返回 `{available:false}`，绝不抛） */
export function readLaneJournalFile(dir) {
  const file = typeof dir === 'string' && dir.length > 0 ? join(dir, LANE_JOURNAL_BASENAME) : undefined
  if (file === undefined) return { available: false, reason: 'no-store-dir', file }
  if (!existsSync(file)) return { available: false, reason: 'not-recorded', file }
  try {
    return { available: true, reason: 'recorded', file, record: JSON.parse(readFileSync(file, 'utf8')) }
  } catch (error) {
    return { available: false, reason: `unreadable: ${error?.message ?? error}`, file }
  }
}

/** 产物里的 `history` 段 → **结构化**（纯函数；缺失字段一律如实标 null，不猜） */
export function summarizeLaneHistory(record) {
  const history = record && typeof record === 'object' && record.history && typeof record.history === 'object' ? record.history : {}
  const first = history.firstDegrade && typeof history.firstDegrade === 'object' ? history.firstDegrade : null
  const loss = history.rootLoss && typeof history.rootLoss === 'object' ? history.rootLoss : null
  const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0)
  return {
    commandSeq: Number.isFinite(Number(record?.seq)) ? Number(record.seq) : null,
    shimCount: num(history.shimCount),
    degradeCount: num(history.degradeCount),
    /** "是否曾掉档" = 有首次掉档记录（与 `degradeCount > 0` 同真同假，断言钉住） */
    everDegraded: first !== null,
    firstDegrade: first
      ? {
          at: first.at ?? null,
          seq: Number.isFinite(Number(first.seq)) ? Number(first.seq) : null,
          launchMode: first.launchMode ?? null,
          tierEffective: first.tierEffective ?? null,
          fallbackClass: first.fallbackClass ?? null,
          fallbackReason: first.fallbackReason ?? null,
        }
      : null,
    rootLoss: loss
      ? {
          everLost: loss.everLost === true,
          count: num(loss.count),
          lastReason: loss.lastReason ?? null,
          lastAt: loss.lastAt ?? null,
          lastPhase: loss.lastPhase ?? null,
          lastSeq: Number.isFinite(Number(loss.lastSeq)) ? Number(loss.lastSeq) : null,
          observedAt: Array.isArray(loss.observedAt) ? [...loss.observedAt] : [],
        }
      : null,
  }
}

/**
 * 上一次产物 + 本次档位 ⇒ 新的 `history`（纯函数）。
 *
 * `firstDegrade` 与 `rootLoss` 一旦落下就**只增不改**（前者冻结，后者由
 * `noteStageRootLoss()` 递增）—— 保证"首次"与"次数"不会因为后来的正常执行被抹掉。
 */
export function advanceLaneHistory(previous, lane) {
  const record = previous && typeof previous === 'object' ? previous : {}
  const prior = summarizeLaneHistory(record)
  const degraded = lane?.degraded === true
  const commandSeq = (prior.commandSeq ?? 0) + 1
  const firstDegrade =
    prior.firstDegrade ??
    (degraded
      ? {
          at: lane?.at ?? new Date().toISOString(),
          seq: commandSeq,
          launchMode: lane?.launchMode ?? null,
          tierEffective: lane?.tierEffective ?? null,
          fallbackClass: lane?.fallbackClass ?? classifyLaneFallback(lane?.fallbackReason).code,
          fallbackReason: lane?.fallbackReason ?? null,
        }
      : null)
  return {
    commandSeq,
    shimCount: prior.shimCount + (degraded ? 0 : 1),
    degradeCount: prior.degradeCount + (degraded ? 1 : 0),
    firstDegrade,
    rootLoss: prior.rootLoss,
  }
}

/**
 * 记一次**失根**（`verifyStageRootAlive()` 判 not-alive）。
 *
 * 为什么是一个共享函数：观测点有两个 —— ① 每次命令执行前（`execute()`）；
 * ② 用户查看 `/winstage status` 时（host-plugin）。两处都调这一个 ⇒ "次数"口径统一。
 *
 * ⚠ 诚实声明：这是**观测计数**，不是"根被删了几次"的精确审计（没人观测时发生的失根
 * 不会被计入）。机读字段 `observedAt` 列出观测点，不假装是完整审计。
 *
 * 失败一律吞掉（best effort）：状态记录绝不能影响命令或命令面。
 * @returns {object|null} 写进去的 rootLoss 条目；拿不到存储根时返回 null
 */
export function noteStageRootLoss(dir, info = {}) {
  if (typeof dir !== 'string' || dir.length === 0) return null
  const previous = readLaneJournalFile(dir).record
  const prior = summarizeLaneHistory(previous)
  const entry = {
    everLost: true,
    count: (prior.rootLoss?.count ?? 0) + 1,
    lastReason: info.reason ?? 'unknown',
    lastAt: info.at ?? new Date().toISOString(),
    lastPhase: info.phase ?? 'unknown',
    lastSeq: Number.isFinite(Number(previous?.seq)) ? Number(previous.seq) : null,
    observedAt: [...new Set([...(prior.rootLoss?.observedAt ?? []), info.phase ?? 'unknown'].filter((x) => typeof x === 'string'))],
  }
  try {
    writeFileSync(
      join(dir, LANE_JOURNAL_BASENAME),
      `${JSON.stringify(
        {
          ...(previous ?? {}),
          kind: previous?.kind ?? 'winstage-sandbox-lane',
          history: { ...(previous?.history ?? {}), ...prior, rootLoss: entry },
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    return entry
  } catch {
    return null
  }
}

// ==================== 依赖定位 ====================

/**
 * 在候选 node_modules 根中定位**真实文件**（包的 exports 映射不作用于绝对 file: URL）。
 * 与 `staging-fs.mjs:44-57` 的 `locatePackageFile()` 同一写法 —— 同一个仓库里
 * "怎么找 DSH 的运行时那一份"只应该有一处口径。
 *
 * @param {string} relativePath 相对候选根的路径
 * @param {string[]} [rootsOverride] 仅自测注入（断言"定位不到 ⇒ fail-closed"时用）
 */
export function locatePackageFile(relativePath, rootsOverride) {
  let roots = []
  try {
    roots = rootsOverride ?? resolveDshModuleRoot() ?? []
  } catch {
    roots = []
  }
  for (const root of roots) {
    if (!root) continue
    const candidate = join(root, relativePath)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * 词法同根判定（大小写、`/`↔`\`、末尾分隔符归一）。
 *
 * 刻意**不**用 `src/paths.mjs` 的 `canonical()`：那会 `realpathSync` 碰磁盘，
 * 而这里只做"两处配置声明是不是同一个根"的判定（便宜、同步、无副作用）。
 */
function sameRootText(a, b) {
  const norm = (value) =>
    typeof value === 'string' ? value.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : ''
  const left = norm(a)
  return left.length > 0 && left === norm(b)
}

/**
 * 从 loader patch **组合后**的行表（`entry.parent.data`）里取出"同一个暂存根"的两处声明值。
 *
 * 为什么这是根统一的落点：fs 半边（`winstage-fs` 行）真正决定存储根的是 `config.cwd`
 * （`staging-fs.mjs` 用 `canonical(config?.cwd || …)` 建 Store），因此它就是**权威**；
 * shell 半边自己那行（`winstage-shell`）用 `config.workspaceRoot` 表达同一个根。
 * 两处不一致 = 配置漂移 = `getReviewService()` 按根分叉 ⇒「暂存写到 A、面板发布在 B」。
 *
 * 兼容两种形态：行表既可能是**已展平**的条目列表，也可能仍是带 `insert: [...]` 的补丁行
 * （`cordis-plugin-include` 的输入形态），两种都扫。
 *
 * @param {unknown} data `entry.parent.data`
 * @returns {{fsRoot?: string, shellRoot?: string}} 缺该行/该键时对应字段为 `undefined`
 */
export function workspaceRootsOfLoaderRows(data) {
  const out = {}
  if (!Array.isArray(data)) return out
  const rows = []
  for (const item of data) {
    if (!item || typeof item !== 'object') continue
    rows.push(item)
    if (Array.isArray(item.insert)) {
      for (const inner of item.insert) if (inner && typeof inner === 'object') rows.push(inner)
    }
  }
  const text = (value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined)
  for (const row of rows) {
    const config = row.config
    if (!config || typeof config !== 'object') continue
    if (row.id === 'winstage-fs') out.fsRoot = text(config.cwd) ?? text(config.workspaceRoot)
    else if (row.id === 'winstage-shell') out.shellRoot = text(config.workspaceRoot)
  }
  return out
}

/**
 * 没有基类时用的**中性**基类（自测/装配诊断用）。
 *
 * 为什么不让 `Base === undefined` 去 `extends undefined`：那会得到
 * `TypeError: Class extends value undefined is not a constructor or null` ——
 * 一个**加载期**的崩溃，而本模块承诺"拿不到 `dsh-shell` 是一条**可读的
 * fail-closed 错误**"（见 `loadBaseClass()`）。所以这里给一个中性基类：
 * 它什么都不做，于是 `execute()` 会照常走到 `loadBaseClass()` 并抛出
 * `WINSTAGE_SHELL_BASE_MISSING`。**生产装配不传 `base`**，这条只服务诊断路径。
 */
class NeutralShellExecutorBase {
  constructor() {}
}

// ==================== 依赖定位 ====================

/** 默认的 `@deepseek-ai/dsh-shell` 入口解析：拿不到返回 undefined（调用方 fail-closed） */
function defaultResolveShellModule() {
  return locatePackageFile(join('@deepseek-ai', 'dsh-shell', 'lib', 'index.js'))
}

/**
 * 平台**原生**执行器的入口：WinStage 开关关闭时用它把执行面**交还**给平台。
 *
 * 为什么必须有这条路径（这是一个实测出来的装配缺口）：
 *   `winstage-shell` 是拿 `ctx.shell` 这个**单例服务名**的**整体替换**提供方
 *   （profile 里 `pwsh-sandbox` 被 `disabled: true`）。与 `staging-fs` 不同 ——
 *   fs 侧 `extends LocalFileSystem` 可以靠 `super.writeText(...)` 回退，
 *   而 shell 侧**没有 `super` 可退**（基类 `ShellExecutor` 本身不执行任何东西）。
 *   于是"关掉开关"之后，本执行器仍占着服务名并继续按 `workspace-write` 围栏——
 *   实测后果：会话档位一旦是 `danger-full-access`，**每一条 pwsh 都被
 *   `WINSTAGE_SHELL_ESCALATION_NOT_SUPPORTED` 拒掉**，用户感知为"关了沙箱 shell 全废"。
 *   这与 `staging-fs.sandboxMode`（关闭时报 `super.sandboxMode`，行为与"没装插件"
 *   逐字一致）是同一个设计意图，只是 shell 侧必须**显式装载**平台实现才能兑现。
 */
const NATIVE_PWSH_MODULE = '@deepseek-ai/dsh-pwsh-local/lib/index.js'

/**
 * 解析本进程应当使用的 `pwsh` 可执行文件**绝对路径**。
 *
 * 为什么必须自己解析：`CreateProcessAsUserW` 不做 PATHEXT 解析，裸名字能不能命中
 * 完全取决于 PATH 形状（`src/executor.mjs` 的"[实测] 缺陷 6"）。解析顺序与
 * `dsh-pwsh-local` 的 `resolvePwshPath()` 一致：
 *   1. 配置里的 `pwshPath`（信任原值）；
 *   2. PATH 上的 `pwsh.exe`（含 Microsoft Store 的 alias —— 用 `lstatSync` 看入口本身，
 *      不跟随重解析点，否则会撞 Store alias 目标的 ACL）；
 *   3. `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`（最后手段）。
 * 都不在 ⇒ 交回裸 `'pwsh'` 让执行器自己解析（失败会是一个明确的 exitCode=127，
 * 而不是静默换一个解释器）。
 */
export function resolvePwshPath(configured, env = process.env) {
  if (typeof configured === 'string' && configured.length > 0) return configured
  const spawnable = (candidate) => {
    try {
      const stat = lstatSync(candidate)
      return stat.isFile() || stat.isSymbolicLink()
    } catch {
      return false
    }
  }
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files'
  const systemRoot = env.SystemRoot ?? 'C:\\Windows'
  const candidates = [join(programFiles, 'PowerShell', '7', 'pwsh.exe')]
  for (const entry of String(env.PATH ?? '').split(';')) {
    const trimmed = entry.trim().replace(/^"|"$/g, '')
    if (trimmed.length === 0) continue
    candidates.push(join(trimmed, 'pwsh.exe'))
  }
  candidates.push(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))
  for (const candidate of candidates) if (spawnable(candidate)) return candidate
  return 'pwsh'
}

/**
 * `spec.command` → `{ command, args, recognized }`（**host 侧**解析，绝不经过 shell）。
 * 规则见文件头"命令字符串的解析"。
 *
 * 正则的三个细节都是**实测踩出来的**（自测 S4.10 / S4.10b 抓到过）：
 *   1. 开关与 `-Command` 之间的分隔 `\s+` **必须**存在，且开关模式自身以 `\s+` 收尾
 *      （`(?:-\S+\s+)*?`）。否则回溯会把 `-Command` 自己吸进 flags。
 *   2. `launcher` 用**预读** `(?=\s)` 而不是吞一个空格，并**排除**以 `-` 开头的 token：
 *      否则 `-NoLogo -NoProfile -Command x` 会把 `-NoLogo` 当成 launcher。
 *   3. 引号包裹的 launcher（`"C:\Program Files\PowerShell\7\pwsh.exe"`）单独一条分支。
 */
const PWSH_LEADING =
  /^(?:(?<launcher>"[^"]+"|(?!-)\S+)(?=\s)\s+)?(?<flags>(?:-\S+\s+)*?)-command\s+(?<script>[\s\S]+)$/i
const PWSH_EXE = /(?:^|[\\/])pwsh(?:\.exe)?$/i
const LEGACY_POWERSHELL_EXE = /(?:^|[\\/])powershell(?:\.exe)?$/i

export function buildCommandArgv(command, pwshPath) {
  const text = String(command ?? '')
  const match = PWSH_LEADING.exec(text)
  if (match?.groups?.script !== undefined) {
    const script = match.groups.script
    // launcher 可能是带引号的路径（`"C:\Program Files\PowerShell\7\pwsh.exe"`）——
    // 比较前**必须**把包裹引号脱掉，否则 `PWSH_EXE` 永远匹配不上（自测 S4.10c 抓到过）。
    const launcher = (match.groups.launcher ?? '').trim().replace(/^"|"$/g, '')
    const flags = String(match.groups.flags ?? '')
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0)
    // 只有"确实是 pwsh/powershell"才承认这是 shell 调用；否则按裸程序处理
    // （防止把 `foo.exe -Command x` 这种真实程序误当成解释器）
    if (launcher.length === 0 || PWSH_EXE.test(launcher) || LEGACY_POWERSHELL_EXE.test(launcher)) {
      return {
        command: pwshPath,
        args: [...flags, '-Command', `${ENCODING_PREAMBLE}${script}`],
        recognized: true,
      }
    }
  }
  // 三种落地形态（DSH pwsh 工具只会用第一种；后两种是"别人也调 ctx.shell"时的稳健性）：
  //   (a) 显式 `-Command` + 非 pwsh launcher（`foo.exe -Command x`）
  //       ⇒ 按"裸程序 + 参数"照原样跑。**绝不**给它塞一个 `-Command`（那是语义篡改）。
  //   (b) 其余一切 ⇒ 文本就是**一段 PowerShell 脚本**（DSH 工具的正常形态：
  //       `New-Item -ItemType File -Path create.txt`）。交给 `pwsh -Command <整段>`，
  //       PowerShell 自己解析。**不能**把它当程序名去 spawn —— 那是一个 100% 失败
  //       且语义错误的降级（自测 S4.10b 抓到过）。
  const foreignCommand = /^(?:"[^"]+"|(?!-)\S+)(?=\s)\s+(?:-\S+\s+)*-command\s+[\s\S]+$/i.test(text)
  if (!foreignCommand) {
    return { command: pwshPath, args: ['-Command', `${ENCODING_PREAMBLE}${text}`], recognized: true }
  }
  const tokens = text.match(/"[^"]*"|\S+/g) ?? []
  const first = (tokens[0] ?? '').replace(/^"|"$/g, '')
  if (first.length === 0) return { command: pwshPath, args: ['-Command', ENCODING_PREAMBLE], recognized: false }
  return {
    command: first,
    args: tokens.slice(1).map((token) => token.replace(/^"|"$/g, '')),
    recognized: false,
  }
}

// ==================== 小工具 ====================

/** 从 config 取一个数值（兼容 schemastery 的 `.get()` 与纯对象两种形态） */
function numericOption(raw, key, fallback) {
  const slot = raw?.[key]
  const value = slot && typeof slot === 'object' && typeof slot.get === 'function' ? slot.get() : slot
  return Number.isFinite(value) && value > 0 ? Number(value) : fallback
}

function stringOption(raw, key) {
  const slot = raw?.[key]
  const value = slot && typeof slot === 'object' && typeof slot.get === 'function' ? slot.get() : slot
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 有界捕获一条输出流，返回 `CollectedOutput` **形状**（`{text, truncated}`）。
 * 与 `dsh-subprocess` 的 `CollectedOutput` 逐字对齐：`text` 是**尾部**，`truncated`
 * 表示丢过字节。`spillPath` 只在真有完整落盘文件时才出现 —— 这里没有（见文件头
 * 残余边界），因此**不伪造** spill 路径（宁可少一个字段，也不给一个读不到的文件名）。
 */
function boundedOutput(text, maxBytes) {
  const buffer = Buffer.from(text ?? '', 'utf8')
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_OUTPUT_BYTES
  if (buffer.length <= cap) return { text: buffer.toString('utf8'), truncated: false }
  return { text: buffer.subarray(buffer.length - cap).toString('utf8'), truncated: true }
}

/**
 * 一个最小可用的 offset reader（`SubprocessOutputReader` 契约）。
 *
 * ⚠ 字段名以 DSH 源码为准（本单曾让我确认）：`SubprocessOutputRead` 的
 * "下一个偏移"字段是 **`nextOffset`**（不是 `next`/`offset`），见
 * `dsh-subprocess/lib/types/types.d.ts:113-123`。`dsh-tool-pwsh:69-77` 就是照它写的。
 */
export function makeOffsetReader(text) {
  const buffer = Buffer.from(String(text ?? ''), 'utf8')
  return {
    readFrom(fromByte) {
      const from = Number.isFinite(fromByte) && fromByte > 0 ? Math.floor(fromByte) : 0
      const lossy = from > buffer.length
      return {
        text: buffer.subarray(lossy ? 0 : from).toString('utf8'),
        nextOffset: buffer.length,
        lossy,
      }
    },
  }
}

/**
 * **默认发布器**：把审阅快照写进 `review.json` —— 与 `/winstage refresh`
 * （`host-plugin.mjs:240` 的 `const snapshot = service.publish()`）**完全同一条调用**，
 * 不另造一条路径。`staging-fs.mjs` 侧每写一次就 `afterMutation()`（同一件事）；
 * shell 侧原本缺这一次，于是"命令结束、面板不立刻变"（T5 报告 §4.3 如实声明过）。
 *
 * 为什么放在这里而不是 `shell-entry.mjs`：发布必须发生在**执行器内部**（freeze 之后、
 * 返回句柄之前），而执行器是唯一知道"这一次命令到底有没有净变化"的人。
 * `getReviewService()` 是按 `canonical(root)#sessionKey` 的**进程内单例**，因此这里拿到的
 * 就是 fs 半边那一份（根统一之后必然如此）。
 *
 * @param {string|undefined} sessionId
 * @param {string} workspaceRoot 权威根（`effectiveWorkspaceRoot()` 给出）
 */
export function publishWorkspaceSnapshot(sessionId, workspaceRoot) {
  const service = getReviewService({
    workspaceRoot,
    ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sessionId } : {}),
  })
  return service.publish()
}

/**
 * 结构化错误：每个 fail-closed 分支都要能被人一眼归因（并明说"没有执行"）。
 *
 * ⚠ **`message` 必须中性**：它会直达**模型可见**的工具错误面（`dsh-tool-pwsh` 把
 * `execute()` 抛出的错误原样上报）。因此这里**不加** `winstage-shell:` 之类的前缀，
 * 也不写沙箱/暂存树字样 —— 归因靠 `code` 与 `error.winstage`（人工侧通道）。
 */
export function shellFailure(code, message) {
  const error = new Error(String(message))
  error.code = code
  error.winstage = { code, executed: false }
  return error
}

// ═════════════════════════════════════════════════════════════════════════════
// WP6：fail-closed 分支的**三分类**（策略拒绝 / 环境故障 / 普通失败）
// ═════════════════════════════════════════════════════════════════════════════
//
// ── 三条硬约束（本任务的全部要点）────────────────────────────────────────────
//   1. **透明性零痕迹**：模型可见文案里不得出现 `沙箱|暂存|stage|staging|替代路径|
//      sandbox|overlay`（大小写不敏感）。沙箱细节只留在 `error.winstage.technicalCode`
//      / error 级日志 / `/winstage status`（**用户侧**）。
//   2. **三分类互不混淆**：三类各有**互不相同**的机读码（见 `FAILURE_CATEGORY_CODES`）。
//      "环境故障、可重试"绝不许与"操作不被允许"共用一句话。
//   3. **不给与事实相反的结论**：`execute()` 抛错 ≠ "命令没执行"。只要存在执行证据
//      （stdout 有输出 / 干净的退出码 / 调用方报的副作用），结论必须降级为
//      **不确定**（`indeterminate`），而不是断言"没有执行"。
export const SEMANTIC_CODES = FAILURE_CATEGORY_CODES

/**
 * fail-closed 分支的机读码 → 三层语义（内部口径表）。
 *
 * 键是 `shellFailure()` 用的**技术码**（人工侧归因用）；值里的 `category` 决定
 * **模型可见**那一句话（三类文案互不相同）。
 */
export const SHELL_FAILURE_CLASSIFICATION = Object.freeze({
  // ③ 普通失败：**输入/用法**问题（空命令）不是"策略拒绝"，也不是"环境坏了"
  WINSTAGE_SHELL_BAD_COMMAND: { category: FAILURE_SEMANTICS.COMMAND },
  // ② 环境故障：可重试；**不得**与策略拒绝共用文案
  WINSTAGE_SHELL_NO_WORKSPACE: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_NO_STAGED_ROOT: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_EXECUTION_BACKEND_UNAVAILABLE: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_EXECUTOR_INVALID: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_INIT_FAILED: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_MATERIALIZE_FAILED: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_BASE_MISSING: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_BASE_LOAD_FAILED: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  WINSTAGE_SHELL_WORKSPACE_FAILED: { category: FAILURE_SEMANTICS.ENVIRONMENT },
  // WP7′：明文出站请求里出现密钥形态 ⇒ 判定"该请求不被允许"（policy 族，独立机读码）
  CLEARTEXT_CREDENTIAL_IN_REQUEST: { category: FAILURE_SEMANTICS.POLICY, presetMessage: CLEARTEXT_SECRET_FAILURE.message },
  // ③ 普通失败（`RUN_FAILED` 逐条命令判定；见 `runFailureClassification()`）
  WINSTAGE_SHELL_RUN_FAILED: { category: FAILURE_SEMANTICS.COMMAND },
})

/** 某一类在**模型可见**面上使用的机读码（三类互不相同） */
export function semanticCodeOf(category) {
  return FAILURE_CATEGORY_CODES[category] ?? FAILURE_CATEGORY_CODES[FAILURE_SEMANTICS.COMMAND]
}

/**
 * 构造一条**语义已分层且模型可见面零痕迹**的 fail-closed 错误。
 *
 * 文案形状：`<语义机读码>: <中性一句话>`。机读码来自 `FAILURE_CATEGORY_CODES`
 * （`DENIED_ACTION_NOT_PERMITTED` / `ENV_FAULT_RETRYABLE` / `COMMAND_FAILED`），
 * 因此 AI 侧只看到"这个操作不被允许 / 环境故障、可重试 / 命令失败"，**看不到任何沙箱机制**。
 *
 * @param {string} technicalCode 人工侧归因码（进 `error.winstage.technicalCode`，可含机制措辞）
 * @param {object} [options]
 * @param {string} [options.category] 显式三层语义（缺省按 `SHELL_FAILURE_CLASSIFICATION`）
 * @param {string} [options.detail] 中性补充说明（**不得**含禁用词；会被机检）
 * @param {string} [options.presetMessage] 直接给定的一整句话（用于明文凭据那条）
 * @param {boolean} [options.indeterminate] "到底跑没跑"无法判定（普通失败的一种）
 * @param {object} [options.winstage] 额外的人工侧字段
 */
export function semanticShellFailure(technicalCode, options = {}) {
  const entry = SHELL_FAILURE_CLASSIFICATION[technicalCode]
  const category =
    options.category ?? entry?.category ?? FAILURE_SEMANTICS.COMMAND
  const code = semanticCodeOf(category)
  const classified = classifyFailureSemantics({ code: technicalCode, category })
  const detail = typeof options.detail === 'string' ? options.detail : ''
  // ★ `presetMessage` 优先：明文凭据那条要"不给替代路径"的固定一句话。
  //   `detail` 只应是**我们自己写的**中性补充，绝不把上游 error.message 拼进来
  //   （上游文案可能带机制措辞 ⇒ 会破坏透明性；上游原文走 `winstage.technicalDetail`）。
  const baseMessage = options.presetMessage ?? classified.message
  const message = `${code}: ${baseMessage}${detail.length > 0 ? ` ${detail}` : ''}`
  const violations = transparencyViolations(message)
  const error = shellFailure(code, message)
  error.category = category
  error.retryable = classified.retryable === true
  error.indeterminate = options.indeterminate === true
  error.winstage = {
    code,
    technicalCode,
    category,
    classification: classified.classification,
    retryable: classified.retryable === true,
    indeterminate: options.indeterminate === true,
    executed: options.indeterminate === true ? 'unknown' : false,
    transparencyViolations: violations,
    ...(options.winstage ?? {}),
  }
  return error
}

/**
 * `executor.run()` 抛错时的**逐条命令**判定（不许一刀切说"没有执行"）。
 *
 * 判据（比 `classifyStartupFailure` 宽，因为到这里 run() 已经抛了）：
 *   · `error.message` 里带 `dsh-stage:` ⇒ 执行通道自己写下的注记（启动失败/超时）；
 *   · `error.childRan === true` / `error.sideEffectsObserved === true` ⇒ 调用方给了证据；
 *   · `error.stdout` 非空 ⇒ 有输出 = 子进程跑过（**stderr 不算**：那句
 *     `Access is denied` 正是"被拒"这个断言本身，拿它当证据是循环论证）。
 * 任一成立 ⇒ 结论只能是**不确定**，绝不能写"命令没有执行"。
 */
export function runFailureClassification(error) {
  const message = String(error?.message ?? error ?? '')
  const stdout = String(error?.stdout ?? '')
  const producedOutput = stdout.trim().length > 0
  const observedSideEffects = error?.sideEffectsObserved === true || error?.childRan === true
  const channelNote = /dsh-stage:/i.test(message)
  const evidence = []
  if (producedOutput) evidence.push('stdout-has-output')
  if (observedSideEffects) evidence.push('side-effects-observed')
  if (channelNote) evidence.push('runner-note-present')
  const contradiction = /access is denied|0x80070005|e_accessdenied|unauthorizedaccessexception|permissiondenied/i.test(message)
  const indeterminate = evidence.length > 0 || contradiction
  return {
    category: FAILURE_SEMANTICS.COMMAND,
    indeterminate,
    evidence,
    /** 用户侧一句话（可含机制措辞）：这条**不进**模型可见通道 */
    userDetail: indeterminate
      ? '执行通道报错，但同时存在执行证据/拒绝声明矛盾 ⇒ 结论降级为"不确定"，不得断言未执行。'
      : '执行通道未给出可用结果，且没有执行证据。',
  }
}

/**
 * 从各种可接受的 `workspace` 注入形态里取出**当前**的 `Workspace`。
 *   1. 函数 ⇒ `() => Workspace`（生产：`getReviewService(...).reload().workspace`）
 *   2. 有 `reload()` 的服务对象 ⇒ 重新读一遍再取 `.workspace`（跨进程改动可见）
 *   3. 直接就是 Workspace 实例
 */
export function currentWorkspaceOf(source) {
  if (!source) return undefined
  if (typeof source === 'function') return currentWorkspaceOf(source())
  if (typeof source === 'object' && typeof source.reload === 'function') {
    try {
      source.reload()
    } catch {
      /* reload 失败不致命：下面照常读 .workspace */
    }
    return source.workspace ?? source
  }
  return source
}

// ==================== 工厂 ====================

/**
 * 构造 WinStage 沙箱 shell 执行器类。
 *
 * @param {object} [options]
 * @param {object|Function} [options.workspace] 生产：`Workspace` 实例、`() => Workspace`，
 *   或带 `reload()` 的审阅服务对象。自测：注入替身即可（不需要真实工作区/沙箱）。
 * @param {object} [options.store] 退路：只给 store（至少有 `stagedDir`）。
 * @param {Function} [options.base] **仅自测**：`ShellExecutor` 基类替身。生产不要传。
 * @param {Function} [options.resolveShellModule] **仅自测**：返回 `dsh-shell` 入口绝对路径。
 * @param {Function} [options.createExecutor] **仅自测**：`(opts) => {init, run, dispose, capabilities}`。
 * @param {Function} [options.log] 信息级日志。
 * @param {Function} [options.logError] error 级日志（"失败必须响"）。
 * @param {object} [options.config] 默认配置（行 config 并入）。
 */
export function createWinStageShellExecutor(options = {}) {
  /**
   * `injectedBase` = 调用方**显式**给的基类（只该是离线自测/装配诊断）。
   * 生产走 `NeutralShellExecutorBase` 让类能构造出来，真正的基类由
   * `loadBaseClass()` 在**第一次 execute()** 时解析 —— 于是"拿不到 dsh-shell"
   * 是一条可读的 fail-closed 错误，而不是加载期崩溃。
   */
  const injectedBase = options.base
  if (injectedBase !== undefined && typeof injectedBase !== 'function') {
    throw new TypeError('createWinStageShellExecutor: options.base must be a class when supplied')
  }
  const Base = injectedBase ?? NeutralShellExecutorBase
  const resolveShellModule = options.resolveShellModule ?? defaultResolveShellModule
  const createExecutor = options.createExecutor
  const configDefaults = options.config ?? {}
  /**
   * 会话感知的工作区工厂（装配方注入）：`(sessionId) => Workspace`。
   * 生产里 = `getReviewService({ workspaceRoot, sessionId }).reload().workspace`。
   *
   * 为什么必须带 `sessionId`：`staging-fs.mjs` 的每一次写都按**调用方会话**解析
   * 存 储根（`sessionIdOf()` → `getReviewService`），而 `getReviewService` 是按
   * `root#sessionKey` 做进程内单例的。shell 这一侧若不按同一个会话 id 取工作区，
   * 就会出现"文件工具写进会话 A 的暂存树、命令跑在会话 B 的暂存树"——
   * 面板与 approve 永远看不到命令产出的那一半。
   */
  const workspaceFor = typeof options.workspaceFor === 'function' ? options.workspaceFor : undefined

  return class WinStageShellExecutor extends Base {
    /**
     * ★ **刻意不声明 `static Config`** —— 这是一个实测出来的**激活阻断**，不是遗漏。
     *
     * 曾经这里是普通对象 `{ cwd:'', timeoutMs:… }`，注释还写着"普通对象也是合法 schema"。
     * 那句话是**错的**：cordis 的 `resolveConfig` 会调 `Config['~standard'].validate(...)`
     * （`cordis/lib/index.js:958`），普通对象没有 `~standard` ⇒ 抛
     *   `TypeError: Cannot read properties of undefined (reading 'validate')`
     * ⇒ 本行**根本没激活**（`ctx.shell` 不存在）⇒ `tool-pwsh` 永远
     *   `pending (waiting for service: shell)` ⇒ **会话里连 pwsh 工具都没有**。
     * 实测证据：`.t/shell-e2e.log` 的 `dsh: warning: 3 entries did not activate`；
     * `dsh-plugin/schema.js` 的文件头逐字记着同一个失败形态（那里是为了另一个行解决的）。
     *
     * 基类 `ShellExecutor` 本身**没有** `Config`，行 config 依然会被传进构造函数，
     * 所以"不声明"既不丢功能也不改变契约。若将来确实要 schema 校验，必须用
     * `schema.js` 那套自带 `~standard.validate` + `toJSON()` 的节点，**不能**用普通对象。
     */

    static inject = []

    constructor(ctx, config) {
      super(ctx, 'shell', config)
      // ★ 把行 `config` 交给装配方（`shell-entry.mjs`）现读：入口的
      //   `declaredWorkspaceRoot()` 以**行表里的 fs 根**为权威，行 `config.workspaceRoot`
      //   是它的后备档（进 `this.declaredRoot`）。没有这条通路时入口只能靠环境变量，
      //   一旦它与 `winstage-fs` 行的 `cwd` 不同根，按根做单例的审阅服务会分叉、
      //   面板看不到命令产出。没传 `onConfig` 时是空操作，不改变任何既有行为。
      try {
        options.onConfig?.(config ?? undefined)
      } catch (error) {
        try {
          console.error(`[winstage-shell] onConfig 失败（行 config 未能交给装配方）：${error?.message ?? error}`)
        } catch {
          /* best effort */
        }
      }
      const raw = { ...configDefaults, ...(config ?? {}) }
      /** 原样留一份行 config：关闭开关交还平台时要把它透传给原生执行器 */
      this.rawConfig = raw
      this.log =
        options.log ??
        ((message) => {
          try {
            const logger = ctx?.logger
            if (logger && typeof logger.info === 'function') return logger.info(message)
          } catch {
            /* best effort */
          }
          try {
            console.log(`[winstage-shell] ${message}`)
          } catch {
            /* best effort */
          }
        })
      this.logError =
        options.logError ??
        ((message) => {
          const line = `[winstage-shell] ${message}`
          try {
            const logger = ctx?.logger
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
        })

      this.timeoutMs = numericOption(raw, 'timeoutMs', DEFAULT_TIMEOUT_MS)
      this.maxTimeoutMs = Math.max(numericOption(raw, 'maxTimeoutMs', DEFAULT_MAX_TIMEOUT_MS), this.timeoutMs)
      this.stdoutMaxBytes = numericOption(raw, 'maxOutputBytes', DEFAULT_MAX_OUTPUT_BYTES)
      this.pwshPathConfig = stringOption(raw, 'pwshPath')
      this.mode = stringOption(raw, 'mode') ?? 'workspace-write'
      /**
       * 档位：默认 **`auto`** —— 探测证明 shim 可用就走去令牌化 `TS`，否则 fail-closed 回退
       * 受限令牌 `T1`（`selectLaunchMode()`，`src/executor.mjs:3031`）。
       *
       * 2026-09-30 接线：此前默认写死 `'T1'`，于是"透明沙箱"这套只在 `--tier TS` 的**能力探测**
       * 里成立，而会话里真正跑命令的 shell 执行器永远在受限令牌档 —— 那里管道/TLS/`Get-CimInstance`
       * 是坏的（`docs/T5-痕迹与根统一报告.md` §1.3 的实测结论：T1 下 T2/T3/T4 不可能变绿）。
       * 档位选择本身早就实现好了，缺的只是把它交给执行器。回退是**自愈**的：探测不过 ⇒ T1，
       * 行为与接线前完全一致。
       *
       * 仍可显式覆盖：行 `config.tier`（或环境变量 `WINSTAGE_TIER`）= `T1` | `TS` | `T0`。
       * 探测结论在进程内按"产物 stat + 暂存根"缓存（见 `probeTransparentShim`），
       * 所以"每条命令新建执行器"不会每条都重跑一次金丝雀。
       */
      this.tier = stringOption(raw, 'tier') ?? stringOption(process.env, 'WINSTAGE_TIER') ?? 'auto'

      /**
       * 工作区来源：**每次 execute() 现读**（见 `currentWorkspaceOf`），
       * 于是"另一个进程/会话刚改过暂存树"能被看到（与 `cli exec` 每次新建
       * Workspace 同一效果），装配方也可以构造之后再挂。
       */
      this.workspaceSource = options.workspace ?? options.store
      /** 固定的会话身份（装配/自测显式注入）；生产不传，按每次调用现解析 */
      this.fixedSessionId = stringOption(options, 'sessionId')
      /**
       * 行 config 里声明的根（`onConfig` 通路）—— **只是后备**：
       * 权威根由 `effectiveWorkspaceRoot()` 从 loader 行表取（fs/shell 两个半边同源）。
       */
      this.declaredRoot = stringOption(raw, 'workspaceRoot')
      /**
       * 显式诊断出口（**默认零写入**）。沙箱事实（暂存树路径、捕获计数、候选 id）
       * 绝不进模型可见通道；只有人工显式给出 `WINSTAGE_DIAG_LOG`（或装配方注入
       * 行 config `diagLog`）时，才往该文件追加一行 JSONL。默认什么都不写。
       */
      this.diagLogPath = stringOption(raw, 'diagLog') ?? stringOption(process.env, 'WINSTAGE_DIAG_LOG')
      // 审阅快照发布器 —— 命令产出"立刻出现在面板"用，默认 `publishWorkspaceSnapshot()`，
      // 即 `getReviewService(...).publish()`（与 `/winstage refresh` 同一条调用）。
      // 自测可注入替身：数调用次数、或制造发布失败以证明"失败不影响命令结果"。
      this.publishFor = typeof options.publishFor === 'function' ? options.publishFor : publishWorkspaceSnapshot
      this.resolveShellModule = resolveShellModule
      this.executorFactory = createExecutor
      /** 延迟解析并缓存：拿不到 `dsh-shell` 时给出**可读的 fail-closed 错误**，
       *  而不是让整条 loader 行加载失败（那会让用户看到一堆无法归因的启动错误）。 */
      this.resolvedBasePromise = undefined
      /** 自测用：强制"定位不到 dsh-shell" */
      this.baseUnavailable = false
      /**
       * **本插件自己的** loader entry —— 构造时抓住，用于现读开关。
       *
       * 与 `staging-fs.mjs:220` 同一写法与同一理由：`ctx.<service>` 拿到的是 cordis 的
       * traceable 代理，`ctx.fiber.entry` 在**调用方**那边会指向工具自己的 fiber，
       * 不是 loader 根 include 的条目表 ⇒ 开关会永远读错。构造期 `fiber.entry`
       * 由 loader 的 internal/plugin 处理器设好（cordis/lib/index.js:129-135）。
       */
      this.rootEntry = ctx?.fiber?.entry
      /** 平台原生执行器实例 —— **绕过**其构造期 `ctx.provide('shell', …)` 后独立持有 */
      this.nativeExecutor = undefined
      this.nativeExecutorPromise = undefined
    }

    // ==================== 能力/围栏事实 ====================

    /**
     * loader patch 组合后的行表（`entry.parent.data`）。读不到就返回 `undefined`
     * （离线自测、行被移除、ctx 形态不同）—— 调用方必须能在这条通路上失败。
     */
    loaderRows() {
      try {
        return (this.rootEntry ?? this.ctx?.fiber?.entry)?.parent?.data
      } catch {
        return undefined
      }
    }

    /**
     * **生效的工作区根** —— shell 半边与 fs 半边取同一个根的唯一入口。
     *
     * 取值顺序与理由见 `shell-entry.mjs` 文件头"工作区根从哪来"。要点：
     *   1. `winstage-fs` 行的 `cwd`（fs 半边真正的存储根）**权威**；
     *   2. `winstage-shell` 行的 `workspaceRoot`（同一根的另一处声明）；
     *   3. 行 config 经 `onConfig` 落下的显式值（`this.declaredRoot`）。
     * 1 与 2 都在且不同 ⇒ **error 级报警**（人工侧）并**以 fs 根为准**：宁可响，
     * 也绝不让 `getReviewService` 按两个根分叉出第二个单例（面板看不到命令产出）。
     *
     * 返回 `undefined` 时由入口的 `declaredWorkspaceRoot()` **抛错**（不再猜 cwd）。
     */
    effectiveWorkspaceRoot() {
      let fsRoot
      let shellRoot
      try {
        ;({ fsRoot, shellRoot } = workspaceRootsOfLoaderRows(this.loaderRows()))
      } catch {
        fsRoot = undefined
        shellRoot = undefined
      }
      if (fsRoot && shellRoot && !sameRootText(fsRoot, shellRoot)) {
        this.logError(
          `配置漂移：fs 行 cwd(${fsRoot}) 与 shell 行 workspaceRoot(${shellRoot}) 不是同一个根；` +
            `已按 fs 行的根继续（否则按根做单例的审阅服务会分叉，面板看不到命令产出）。` +
            '请让 profile 覆盖层把两个键重述成同一个值（bundle 层用 YAML 锚点绑死）。',
        )
        return fsRoot
      }
      return fsRoot ?? shellRoot ?? this.declaredRoot
    }

    /**
     * WinStage **此刻**是否应当接管执行面 —— 与 `staging-fs.stagingEnabled()`
     * **同一个真源、同一套读法**：读 loader 行 `winstage-sandbox` 的 `config.enabled`，
     * 每次调用现读（`rootEntry.parent.data` 是 patch 组合后的那一份，改开关即时生效）。
     *
     * 树里找不到该行（离线自测、行被移除）时默认 `true`：保持"接管"这一历史行为，
     * 与 `staging-fs` 的 fail-open 口径一致（关不掉比静默不管更安全）。
     */
    winStageEnabled() {
      try {
        const data = this.loaderRows()
        if (!Array.isArray(data)) return true
        const row = data.find((item) => item && item.id === 'winstage-sandbox')
        if (!row || !row.config) return true
        return row.config.enabled !== false
      } catch {
        return true
      }
    }

    /**
     * **显式诊断出口**（默认关闭）：把沙箱事实写进一个人工指定的 JSONL 文件。
     *
     * 这是"痕迹清除"的落点之一：模型可见的 stdout/stderr 必须与命令自己的输出
     * **逐字节一致**，因此本插件不再往 stderr 注入任何注记；诊断只在人工显式给出
     * `WINSTAGE_DIAG_LOG`（或装配方注入 `config.diagLog`）时才落盘。任何失败都吞掉
     * ——诊断绝不影响命令结果。
     */
    writeDiagnostics(record) {
      if (!this.diagLogPath) return
      try {
        appendFileSync(this.diagLogPath, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, 'utf8')
      } catch {
        /* best effort：诊断失败绝不改变命令结果 */
      }
    }

    /**
     * ★ BUG-B：把"最近一次档位判定"落成**可查询产物**（会话存储根 `sandbox-lane.json`）。
     *
     * 为什么落盘而不是只留在内存里：`/winstage status` 由**另一个模块**
     * （`host-plugin.mjs`）渲染，而且用户排查时进程可能已经重启过 ——
     * 内存里的 `lastLane` 活不过一次重启，"沙箱是否真的生效"就又要靠猜。
     *
     * 落点选 `workspace.store.dir`（= 会话存储根，manifest/queue/review 那一层，
     * 不是暂存树）：写进暂存树会被"提取暂存树变化"当成工作区改动摄取。
     *
     * 失败**必须响**（error 级日志，人工侧），但绝不改变命令结果、绝不进模型通道。
     *
     * @param {object} lane 档位记录（`launchMode/tierEffective/fallbackReason/requestedTier/…`）
     * @param {object} workspace 本次执行的工作区（取 `store.dir`）
     */
    persistLane(lane, workspace) {
      // 无论能不能落盘，内存里的这一份都要更新（`settledExecution()` 会读它）
      this.lastLane = lane
      const dir = workspace?.store?.dir
      if (typeof dir !== 'string' || dir.length === 0) return undefined
      const file = join(dir, LANE_JOURNAL_BASENAME)
      try {
        // ★ WP3：把**历史**并进去（首次掉档 / 是否曾掉档 / 失根次数）。
        //   先读旧产物再写 —— 否则每写一次就把"第一次掉档"抹掉，
        //   "这个会话掉过档没有"这个用户真正要问的问题就永远答不了。
        const previous = readLaneJournalFile(dir).record
        const history = advanceLaneHistory(previous, lane)
        const record = {
          kind: 'winstage-sandbox-lane',
          ...lane,
          summary: summarizeLane(lane),
          /** 持久化的命令序号（跨进程续算）："第几条命令掉档"的"条"就是它 */
          seq: history.commandSeq,
          history,
        }
        writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
        return history
      } catch (error) {
        this.logError(
          `档位判定记录写盘失败（不影响命令结果、不改变命令输出）：${file}：${error?.message ?? error}。` +
            '该次判定仍可从本次执行的 handle.winstage.notes 看到。',
        )
        return undefined
      }
    }

    /**
     * ★ WP3：**失根观测**（每次命令执行前跑一次）。
     *
     * `verifyStageRootAlive()` 只在有人**问**的时候才回答 —— 没人问，"根被外部清掉"
     * 就没有任何历史痕迹，用户看到的仍是上一次的"一切正常"。这里把观测点钉在
     * **每次命令执行前**，失败计数落进同一份档位产物（`history.rootLoss`）。
     *
     * 观测**不改变本次执行的任何结论**：不抛、不改返回值、不进模型可见输出，
     * 只在用户侧（error 级日志）如实记一条。真正抛 `STAGE_ROOT_LOST` 的是写入路径
     * （`src/store.mjs::assertStageAvailable()`），本方法只负责"让这件事看得见"。
     *
     * @returns {{alive: boolean, reason?: string, root?: string}|undefined}
     */
    observeStageRoot(workspace, phase = 'exec') {
      const store = workspace?.store
      if (!store || typeof store.stageStatus !== 'function') return undefined
      let status
      try {
        status = store.stageStatus()
      } catch (error) {
        status = { alive: false, reason: `status-threw: ${error?.message ?? error}` }
      }
      if (status?.alive === true) return status
      const entry = noteStageRootLoss(store.dir, { reason: status?.reason ?? 'not-alive', phase })
      this.logError(
        `失根观测（${phase}）：会话工作根不可用（reason=${status?.reason ?? 'not-alive'}）` +
          `${entry ? `；本会话累计观测到 ${entry.count} 次，最近一次 ${entry.lastAt}` : '；本次未能落盘记录'}。` +
          '在它恢复之前，写入会以 STAGE_ROOT_LOST 失败（不会静默改写真实文件）。',
      )
      return status
    }

    /**
     * ⚠ **保留但不再调用** —— "把执行面交还平台原生执行器"这条路已实测**不可行**。
     *
     * 三次实测的原始报错（按此顺序）：
     *   ① `new PwshLocalExecutor(ctx, cfg)` ⇒
     *      `service "shell" has been registered at <WinStageShellExecutor>`
     *      （`ShellExecutor extends Service`，构造即 `ctx.provide('shell', this)`，
     *      与本行占用的单例名冲突；`cordis/lib/index.js:813`）
     *   ② 用 no-op `provide` 的替身 ctx 绕过注册 ⇒ 构造通过，但原生 `execute()`
     *      经 `this.ctx.subprocess.spawn(...)`（`dsh-pwsh-local/lib/index.js:306`）⇒
     *      `cannot get property "subprocess" without inject`
     *      （`subprocess` 未注入本 fiber；替身 ctx 不改变 Cordis 的属性访问门）
     *   ③ 捕获②并降级执行 ⇒ 该报错仍从 try 之外逸出（根因在 ctx 属性访问层，未定位）
     *
     * ⇒ 现行语义（`execute()`）：**不交还**；档位不匹配时按本执行器自己的
     * `workspace-write` 围栏执行，并把不匹配**显式报响**（error 级日志 + 返回注记）。
     * 本方法连同 `NATIVE_PWSH_MODULE` 已无调用点，**不再删除**只为保留上述取证位置；
     * 它已不参与任何执行路径。
     */
    async nativeExecutorFor() {
      if (this.nativeExecutor) return this.nativeExecutor
      if (!this.nativeExecutorPromise) {
        this.nativeExecutorPromise = (async () => {
          const modulePath = locatePackageFile(NATIVE_PWSH_MODULE)
          if (!modulePath) {
            throw shellFailure(
              'WINSTAGE_SHELL_NATIVE_MISSING',
              `无法定位 ${NATIVE_PWSH_MODULE}；` +
                '请提供包含 @deepseek-ai/* 的 node_modules 根。',
            )
          }
          let loaded
          try {
            loaded = await import(pathToFileURL(modulePath).href)
          } catch (error) {
            throw shellFailure(
              'WINSTAGE_SHELL_NATIVE_LOAD_FAILED',
              `无法 import ${modulePath}：${error?.message ?? error}。`,
            )
          }
          const klass = loaded?.PwshLocalExecutor ?? loaded?.default
          if (typeof klass !== 'function') {
            throw shellFailure(
              'WINSTAGE_SHELL_NATIVE_LOAD_FAILED',
              `${modulePath} 没有导出 PwshLocalExecutor。`,
            )
          }
          const nativeProps = {}
          try {
            if (klass.Config && typeof klass.Config === 'function') {
              nativeProps.config = klass.Config(this.rawConfig ?? {})
            }
          } catch {
            nativeProps.config = this.rawConfig ?? {}
          }
          const stubCtx = Object.create(this.ctx)
          stubCtx.provide = () => {}
          const instance = new klass(stubCtx, nativeProps.config ?? this.rawConfig ?? {})
          instance.ctx = this.ctx
          this.nativeExecutor = instance
          return instance
        })()
      }
      return this.nativeExecutorPromise
    }

    /**
     * ★★ **不要改回 `undefined`** —— 这一行是**实测挡下来**的，不是图省事。★★
     *
     * 必须报一个模式：`dsh-permission-presets`（在 `dsh-base` 里、**默认必装**）会拒绝装配，
     * 原始报错（**原始日志**：`.t/e2e2.log:1-2`）：
     *   `dsh: warning: 1 entry did not activate`
     *   `permission (@deepseek-ai/dsh-permission-presets): Error: permission: the mounted bash
     *    executor does not confine (no sandboxMode) — presets bundle a sandbox mode, so composing
     *    this plugin over an unconfined executor is a misconfiguration`
     * ⇒ 报 `undefined` 会让 `permission` 那一行**装不上**（`sandboxPolicy` 服务随之缺失）。
     *
     * 反过来说，报一个模式会让 `dsh-tool-pwsh` 向模型广告 `sandbox_permissions` 升权并期望
     * 本执行器按 `sandboxPolicy` 围栏 —— 那是**另一条**实测结论：本执行器**不接受任何升权**，
     * 请求更宽档位只记 error 级日志 + 返还注记（`execute()` 的 `mismatched` 分支），
     * 绝不改写语义、绝不放大权限。两者相加才是现在的形态：**报最窄可用档位 + 拒绝放大**。
     *
     * 对应断言（改这一行会立刻见红，别绕过它们去改断言）：
     *   `.t/shell-selftest.mjs` S1.2 / S1.2b / S1.2c（必须 === `'workspace-write'`、不得 undefined、
     *   不得广告更宽档位）、S3b.2（变异体只摘 fail-closed 闸时本值不变）、M1（变异体改成
     *   `undefined` ⇒ 上述断言必然 FAIL）。
     *
     * 历史备注（保留取证，勿据此改回）：本文件早期确实刻意报过 `undefined`
     * （理由：我们自己就是围栏、不广告升权），那正是 `.t/e2e2.log` 记下的那次装配失败。
     */
    get sandboxMode() {
      return 'workspace-write'
    }

    /**
     * 当前工作区（可能来自函数/服务/实例三种形态）。
     *
     * `resolve()` 用 `{ bestEffort: true }` 调用：那一步承诺**不碰磁盘**，
     * 而 `getReviewService` 会做 `adoptLegacyStore`/`absorbSharedStore` 这类
     * "认领别处内容"的动作 —— 在填默认值的时候顺手搬存储是意外副作用。
     * `execute()` 用严格模式：拿不到工作区就是 fail-closed 抛错。
     */
    currentWorkspace({ bestEffort = false } = {}) {
      if (workspaceFor) {
        let resolved
        try {
          // ★ 带着**行表算出的权威根**去取工作区：两个半边按定义同一个根
          //   （见 `effectiveWorkspaceRoot()`）。自测注入的 `workspaceFor` 会忽略第二个参数。
          resolved = workspaceFor(this.sessionIdOf(), this.effectiveWorkspaceRoot())
        } catch (error) {
          if (bestEffort) return undefined
          this.logError(
            `解析本次会话的工作区失败（会话 ${this.sessionIdOf() ?? '(none)'}）：${error?.message ?? error}`,
          )
          throw semanticShellFailure('WINSTAGE_SHELL_WORKSPACE_FAILED', {
            winstage: { technicalDetail: String(error?.message ?? error) },
          })
        }
        return resolved
      }
      try {
        return currentWorkspaceOf(this.workspaceSource)
      } catch (error) {
        if (bestEffort) return undefined
        this.logError(`解析工作区失败：${error?.message ?? error}`)
        throw semanticShellFailure('WINSTAGE_SHELL_WORKSPACE_FAILED', {
          winstage: { technicalDetail: String(error?.message ?? error) },
        })
      }
    }

    /**
     * 调用方的**会话身份** —— 与 `staging-fs.mjs` 同一个口径：
     *   1. 构造时显式注入的 `sessionId`（装配/自测）；
     *   2. 本次执行的 `sandboxPolicy.sessionId`（工具层按**调用方会话**解析后塞进 spec）；
     *   3. ambient initiator（`ctx.agents.currentInitiator()`）。
     * 拿不到 ⇒ `undefined` ⇒ 落到共享存储（与 `staging-fs` 的降级行为一致）。
     *
     * ── 本轮修复（用户报障"子 agent 没有包含在沙箱里"）────────────────────────────
     * ① **不再刻意忽略 `sandboxPolicy.sessionId`**：旧注释写"本执行器不接受升权，
     *    也就不需要策略里的任何东西"——那句话把"升权档位"与"调用方身份"混为一谈。
     *    身份是**审批面归属**，不是权限；忽略它 ⇒ 子 agent 的命令产出落到别处
     *    （或共享存储），父会话面板上一行都不出现。
     * ② 无论身份来自哪一档，都经 `rootSessionIdOf()` **归到顶层祖先会话**：
     *    DSH 给每个委派子会话一个自己的 id，而用户是**一轮任务一个面板**。
     *    不归并的话，子 agent 的改动落进一个用户看不见的暂存区 —— 既批不了也拒不了，
     *    正是"静默"这一类缺陷。归并**不放宽任何围栏**（写仍先落暂存、仍要手势）。
     */
    sessionIdOf() {
      if (this.fixedSessionId) return this.fixedSessionId
      const fromSpec =
        this.currentSpec?.sandboxPolicy && typeof this.currentSpec.sandboxPolicy.sessionId === 'string'
          ? this.currentSpec.sandboxPolicy.sessionId
          : undefined
      if (typeof fromSpec === 'string' && fromSpec.length > 0) {
        return rootSessionIdFor(this.ctx, fromSpec) ?? fromSpec
      }
      try {
        const ctx = this.ctx
        const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : ctx?.agents
        const session = agents?.currentInitiator?.()?.session
        const id = session?.id
        if (typeof id === 'string' && id.length > 0) return rootSessionIdOf(ctx, session) ?? id
      } catch {
        /* 读不到 initiator ⇒ undefined */
      }
      return undefined
    }

    // ==================== resolve：纯计算 ====================

    /**
     * 填默认值与封顶。**不碰磁盘**：不建目录、不建沙箱、不物化
     * （物化只在 `execute()` 里做，因为那才是"真的要执行"的时刻）。
     */
    resolve(request) {
      const workspace = this.currentWorkspace({ bestEffort: true })
      /**
       * 逻辑 workdir（契约要求 `string`）：只用于**展示**与"相对路径的解析基准"。
       *
       * ⚠ 最后一档**刻意不是 `process.cwd()`**：那是宿主进程的目录（`C:\Users\Administrator`），
       * 把它当成"会话工作区"正是"两个根"的成因之一（见 `shell-entry.mjs` 文件头）。
       * 拿不到会话工作区时留空串（= 不知道），绝不用一个猜出来的路径假装知道。
       */
      const logicalRoot =
        (typeof request?.workdir === 'string' && request.workdir.length > 0 ? request.workdir : undefined) ??
        (typeof workspace?.root === 'string' && workspace.root.length > 0 ? workspace.root : undefined) ??
        ''
      const requested = request?.timeoutMs
      if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
        throw new Error('request.timeoutMs must be a positive finite number')
      }
      const requestedStdout = request?.stdoutMaxBytes
      if (requestedStdout !== undefined && (!Number.isFinite(requestedStdout) || requestedStdout <= 0)) {
        throw new Error('request.stdoutMaxBytes must be a positive finite number')
      }
      return {
        command: String(request?.command ?? ''),
        // 逻辑 workdir：**展示**与"相对路径的解析基准"用这里；真实执行 cwd 是命令自己的
        // 工作目录树（`execute()` 里取 `workspace.store.stagedDir`），模型可见通道里
        // **不会**出现它（见 `settledExecution()`）。
        workdir: logicalRoot,
        timeoutMs: Math.min(requested ?? this.timeoutMs, this.maxTimeoutMs),
        onExpiry: request?.onExpiry ?? 'kill',
        stdoutMaxBytes: Math.min(requestedStdout ?? this.stdoutMaxBytes, this.stdoutMaxBytes),
        ...(request?.signal ? { signal: request.signal } : {}),
        ...(request?.stdin !== undefined ? { stdin: request.stdin } : {}),
        ...(request?.env !== undefined ? { env: request.env } : {}),
        ...(request?.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {}),
        // ★ 把策略**带下去**，不要丢掉：`execute()` 要据它**拒绝任何更宽的请求**。
        //   丢弃它会让"用户批准了更宽权限"变成一次**静默无效**的批准 —— 那是说谎。
        sandboxPolicy: request?.sandboxPolicy,
      }
    }

    // ==================== execute：要么在沙箱里跑完，要么抛错 ====================

    /**
     * @param {object} spec `resolve()` 的返回值
     * @returns {Promise<object>} 已结算的 `ShellExecution`
     */
    async execute(spec) {
      this.currentSpec = spec
      try {
        return await this.executeInner(spec)
      } finally {
        // 身份只在**本次执行**内有效：不清掉的话，下一次没有 spec 的调用
        // （`publishSnapshotIfChanged` / 面板轮询）会沿用上一轮的会话身份。
        this.currentSpec = undefined
      }
    }

    /**
     * `execute()` 的主体（外层只负责"本次执行的 spec 生命周期"）。
     *
     * 拆出来的原因：`currentSpec` 必须在**所有**返回路径上被清掉，
     * 而原实现是一个超长函数、有多个 return/throw —— 用 try/finally 包一层最省事、
     * 也最不容易漏。
     *
     * @param {object} spec `resolve()` 的返回值
     */
    async executeInner(spec) {
      /**
       * ── "档位不匹配不再让 shell 整条失效"（本轮实测后的最终裁定）──────────────
       *
       * 历史行为：请求档位 ≠ `workspace-write` ⇒ **抛错、命令不执行**。
       * 实测后果：会话档位一旦是 `danger-full-access`，**每一条 pwsh 都不可用**
       * （`winstage-shell` 占着 `ctx.shell` 这个单例名，用户没有别的执行面可退）。
       * 这被用户判定为不可接受："关闭沙箱后应该完全恢复原来的 shell 行为"。
       *
       * 曾尝试"交还平台原生执行器"，**三次实测均不可行**（均已留下原始报错）：
       *   ① `new PwshLocalExecutor(ctx)` ⇒ `service "shell" has been registered
       *      at <WinStageShellExecutor>`（`Service` 构造即注册，单例名冲突）；
       *   ② 用 no-op `provide` 的替身 ctx 绕过注册 ⇒ 构造通过，但原生 `execute()`
       *      经 `this.ctx.subprocess.spawn(...)` ⇒ `cannot get property "subprocess"
       *      without inject`（该服务未注入本 fiber）；
       *   ③ 捕获②并降级 ⇒ 报错仍从 try 之外逸出（根因在 `ctx` 属性访问层，未定位）。
       * ⇒ **不交还**：只在本执行器**自己的围栏内**执行，并把档位不匹配**如实报响**。
       *
       * 这不是"放开权限"：本执行器的可写面**始终**是命令自己的工作目录（`workspace-write`），
       * 请求更宽档位只会得到"实际按更窄档位执行"的 error 级日志 + 返回注记。
       * 也**不是静默**：档位不匹配是显式告警（本仓库最忌讳静默失效）。
       * ⚠ 该告警**只走人工侧**（error 级日志 + `handle.winstage.notes`），**不进**模型可见的
       * stdout/stderr：那两路必须与命令自己的输出逐字节一致（见 `settledExecution()`）。
       */
      const requestedMode = spec?.sandboxPolicy?.mode
      const mismatched = requestedMode !== undefined && requestedMode !== 'workspace-write'
      if (mismatched) {
        this.logError(
          `请求的档位 "${requestedMode}" 比本执行器实际生效的档位宽（"workspace-write"）；` +
            '本次按生效档位执行（可写 = 命令自己的工作目录），权限未被放大。' +
            (this.winStageEnabled() ? '' : '（注意：WinStage 开关当前为关闭态。）'),
        )
      }
      return this.executeConfined(spec, {
        requestedMode,
        ...(mismatched
          ? {
              degradeNote:
                `请求档位 "${requestedMode}" 比本次实际生效的档位（"workspace-write"）更宽；` +
                '命令已按生效档位执行，权限未被放大。',
            }
          : {}),
      })
    }

    /**
     * **在 WinStage 围栏内**执行（可写 = 暂存树）。`execute()` 的两条路径共用它，
     * 避免"交还分支"与"接管分支"各写一份执行体。
     *
     * @param {object} spec `resolve()` 的返回值
     * @param {{requestedMode?: string, degradeNote?: string}} context
     *   `degradeNote` 非空表示这是"交还失败后的降级执行"⇒ 进 error 级日志 + 注记。
     */
    async executeConfined(spec, context = {}) {
      const notes = []
      const warn = (message) => {
        notes.push(message)
        this.logError(message)
      }

      // ★ "交还失败后的降级执行"必须随返回带出：用户与断言都能看见
      //   "请求了 X、实际按 workspace-write 跑"—— 这是"失败必须响"的落点。
      if (typeof context.degradeNote === 'string' && context.degradeNote.length > 0) {
        warn(context.degradeNote)
      }

      if (!spec || typeof spec.command !== 'string' || spec.command.trim().length === 0) {
        throw semanticShellFailure('WINSTAGE_SHELL_BAD_COMMAND', {
          detail: 'command must be a non-empty string.',
        })
      }

      // ── ① 运行时基类：拿不到 ⇒ fail-closed（绝不换一个基类顶替）──────────────
      await this.loadBaseClass()

      // ── ② 工作区与暂存树 ─────────────────────────────────────────────────────
      const workspace = this.currentWorkspace()
      if (!workspace || typeof workspace !== 'object') {
        throw semanticShellFailure('WINSTAGE_SHELL_NO_WORKSPACE')
      }
      const stagedDir = this.stagedDirOf(workspace)

      // ── ③ 准备执行器 + 能力探测 + init（任一失败 ⇒ fail-closed）────────────
      const factory =
        this.executorFactory ??
        ((opts) => {
          // ★ 必须把**静态**的 `WindowsStageExecutor.capabilities` 转发到实例上。
          //   下面的能力闸门问的是 `executor.capabilities()`，而静态方法在实例上取不到
          //   ⇒ 闸门永远看到 `{aclAvailable:false}` ⇒ **每条命令都被 fail-closed 拒掉**，
          //   而表面上像是"环境里 ACL 不可用"（实测：`.t/e2e6.log`、
          //   `"the WinStage sandbox backend reported itself unavailable (aclAvailable=false)"`）。
          //   真正的能力侧在本机是 `aclAvailable:true, canMintRestrictedToken:true`
          //   （`.t/shell-plan-probe.txt`），能力探针与 `DSH_SANDBOX_NODE_ROOT` 都证明它可解析。
          const instance = new WindowsStageExecutor(opts)
          instance.capabilities = () => WindowsStageExecutor.capabilities()
          return instance
        })
      const executor = factory({
        stagingRoot: stagedDir,
        // ── 注册表覆盖层落在**会话存储根**（= manifest/review/queue 那一层）─────────
        // 不能落在 `stagedDir`（暂存树）里：`WINSTAGE_STAGE_ROOT` 同时是文件族重定向根与
        // 注册表 overlay 的默认 sessionDir，覆盖层写进暂存树后会被"提取暂存树变化"
        // 当成工作区改动去摄取（本机实测 `EPERM ... overlay.<pid>.hive.LOG1`）。
        // 指到 `store.dir` 后：① 暂存树保持干净；② overlay/WAL 与候选队列同根，
        // 正是 `src/registry-stage.mjs::createRegistryStage()` 的契约布局。
        registryStageDir: workspace.store?.dir,
        mode: this.mode,
        tier: this.tier,
        timeoutMs: spec.timeoutMs,
      })

      try {
        const capabilities =
          typeof executor.capabilities === 'function' ? executor.capabilities() : { aclAvailable: false }
        if (!capabilities || capabilities.aclAvailable !== true) {
          // 机制措辞（aclAvailable / aclError）只进人工侧通道：模型只看到"环境故障、可重试"。
          this.logError(
            '执行后端不可用：' +
              `aclAvailable=${JSON.stringify(capabilities?.aclAvailable ?? null)}` +
              `${capabilities?.aclError ? `, ${capabilities.aclError}` : ''}；` +
              '本设计不允许退回未受限执行 ⇒ 本次命令没有执行。',
          )
          throw semanticShellFailure('WINSTAGE_SHELL_EXECUTION_BACKEND_UNAVAILABLE', {
            winstage: {
              aclAvailable: capabilities?.aclAvailable ?? null,
              aclError: capabilities?.aclError ?? null,
            },
          })
        }
        if (typeof executor.init !== 'function' || typeof executor.run !== 'function') {
          throw semanticShellFailure('WINSTAGE_SHELL_EXECUTOR_INVALID')
        }
        try {
          await executor.init()
        } catch (error) {
          this.logError(
            `执行后端初始化失败（${error?.code ?? 'no-code'} ${error?.message ?? error}）；` +
              '本设计不允许退回未受限执行 ⇒ 本次命令没有执行。',
          )
          throw semanticShellFailure('WINSTAGE_SHELL_INIT_FAILED', {
            winstage: { technicalDetail: String(error?.message ?? error), runnerCode: error?.code },
          })
        }

        /**
         * ── ③.5 通道必须**可见**（用户报障"注册表更改直接失败"的另一半）──────────
         *
         * `tier:'auto'` 在透明垫片探测不过时会**静默**回退到受限令牌档
         * （`src/executor.mjs:3805-3816` 的 `selectLaunchMode`）。那一档里：
         *   · **没有 shim** ⇒ 注册表写只剩内核硬拒（`ERROR_ACCESS_DENIED`），
         *     覆盖层/WAL 一个字节都不会产生 ⇒ 面板永远看不到注册表候选；
         *   · 命令自身的文件产出也不进暂存（与 `ctx.fs` 的暂存面对不上）。
         * 也就是说："沙箱开着"与"沙箱其实退化了"在用户面前**长得一模一样** ——
         * 这正是本仓库最忌讳的静默失败形态（见 README 缺陷 11 族）。
         *
         * ★ BUG-B：只把结论写进一条 error 级日志**还不够**（进程重启就没了，
         *   而且关态下连这条日志都没有 ⇒ 又一次静默）。现在结论有**三层**落点：
         *   ① `lastLane`（内存，随 `handle.winstage.notes` 带出）；
         *   ② `sandbox-lane.json`（磁盘，`/winstage status` 直接读它）；
         *   ③ error 级日志（开关**开**时）。
         *   三层都**不进**模型可见的 stdout/stderr，零痕迹契约不变。
         */
        const effectiveLane = typeof executor.launchMode === 'string' ? executor.launchMode : 'unknown'
        /**
         * ★ BUG-B 修复：档位判定**无条件记录**（含开关关闭态），并落成可查询产物。
         *
         * 历史形态是 `this.winStageEnabled() && effectiveLane !== 'shim'` 才 warn ⇒
         * 关态连 `notes` 都没有一条，用户**没有任何地方**能看到"档位退化了"。
         * 现在：记录（`lastLane` + 磁盘产物 + `notes`）与"是否报警"分开 ——
         * **记录不等于往模型通道打印**，结构化产物/notes 都不属于命令自身的
         * stdout/stderr，零痕迹契约不变（见 `settledExecution()`）。
         */
        const laneEnabled = this.winStageEnabled()
        const lane = {
          launchMode: effectiveLane,
          tierEffective: executor.tierEffective ?? null,
          fallbackReason: executor.fallbackReason ?? null,
          requestedTier: this.tier,
          winStageEnabled: laneEnabled,
          fallbackClass: classifyLaneFallback(executor.fallbackReason).code,
          degraded: effectiveLane !== 'shim',
          at: new Date().toISOString(),
        }
        this.persistLane(lane, workspace)
        /**
         * ★ WP3：**失根观测** 紧跟在档位记录之后（同一份产物，两个面）。
         *   顺序刻意如此：先落档位（保证产物存在、`seq` 已 +1），再观测根 —— 于是
         *   `history.rootLoss.lastSeq` 指的就是"第几条命令时观测到失根"。
         *   观测**不改变**本次执行的任何结论（不抛、不改返回值、不进模型通道）。
         */
        this.observeStageRoot(workspace, 'exec')
        if (effectiveLane !== 'shim') {
          const laneSummary = summarizeLane(lane)
          // 结构化注记：开关关闭时也**必须**留下（这正是本缺陷的静默面）
          notes.push(laneSummary.conclusion)
          if (laneEnabled) {
            this.logError(
              `沙箱通道回退：期望去令牌化（shim）通道，实际=${effectiveLane}` +
                `（tier=${executor.tierEffective ?? executor.tier ?? '?'}）：` +
                `${executor.fallbackReason ?? '未给出原因'}。` +
                '该通道下**没有 shim** ⇒ 注册表写无法进覆盖层（只剩内核硬拒），文件产出也不进暂存。' +
                ` 一句话结论：${laneSummary.conclusion}`,
            )
          } else {
            // 关态：如实记录（info 级，不是告警 —— 关态下没走上 shim 通道属预期）
            this.log(`档位记录（WinStage 开关为关闭态）：${laneSummary.conclusion}`)
          }
        }

        // ── ④ 执行前：物化当前工作区版本 + 取内容戳（与 cli exec 同序）─────────
        try {
          workspace.materializeForExecution()
        } catch (error) {
          this.logError(`执行前准备工作副本失败：${error?.message ?? error}；本次命令没有执行。`)
          throw semanticShellFailure('WINSTAGE_SHELL_MATERIALIZE_FAILED', {
            winstage: { technicalDetail: String(error?.message ?? error) },
          })
        }
        const before = workspace.snapshotStagedTree()

        // ── ⑤ 准备期就已 abort ⇒ 不产生任何进程（契约：合法地返回已结算句柄）──
        if (spec.signal?.aborted === true) {
          return this.settledExecution({
            spec,
            workspace,
            stagedDir,
            notes,
            execution: { exitCode: null, stdout: '', stderr: '', timedOut: false, envRejected: [] },
            aborted: true,
            capture: undefined,
          })
        }

        // ── ⑥ 在沙箱内执行：cwd = **暂存树** ─────────────────────────────────
        const argv = buildCommandArgv(spec.command, resolvePwshPath(this.pwshPathConfig))
        if (!argv.recognized) {
          this.log(
            `命令未带 pwsh/powershell 前缀，按"裸程序 + 参数"处理：${argv.command}（args=${argv.args.length}）；不做任何 shell 展开。`,
          )
        }
        const environment = { ...ENV_OVERRIDES, ...(spec.dshEnv ?? {}), ...(spec.env ?? {}) }

        /**
         * ── WP7′：**限制即失败** —— 明文出站请求里出现密钥形态 ⇒ 普通失败 ──────────
         *
         * 为什么放在这里：位置在**创建/初始化执行后端与启动任何子进程之前**
         * （`executor.init()` 在第 ③ 步、子进程在第 ⑥ 步）⇒ 被拒时
         * ① 一个子进程都不创建、② 连后端都不初始化。这是"能检测的"那一半。
         *
         * 检测实现在 `src/executor.mjs::detectCleartextSecret()`（同一份口径；
         * `WindowsStageExecutor.run()` 里另有一道，避免绕过本执行器时漏检）。
         *
         * ⚠ **检测不到的不假装拦住**：TLS 正文里的凭据、运行期才从文件/环境变量读出来的
         * 密钥，本检测看不见 ⇒ 它**不构成**"出站凭据不会泄漏"的保证。用户侧
         * （`/winstage status`、README）必须如实说明，本处**不得**写成"已拦截"。
         * 文案零沙箱痕迹：模型只看到"这个请求不被允许"，看不到任何机制。
         */
        {
          const cleartextSecret = detectCleartextSecret(spec.command)
          if (cleartextSecret.matched) {
            // 用户侧（人工通道）如实记下形态；模型侧只拿到中性一句话。
            this.logError(
              `限制即失败：命令文本里检出明文形态凭据（kind=${cleartextSecret.kind}，${cleartextSecret.snippet}）；` +
                '已按"该请求不被允许"拒绝，未创建任何子进程。' +
                '残余边界：TLS 正文与运行期才读出的密钥检测不到 —— 本检测不构成"出站凭据不会泄漏"的保证。',
            )
            throw semanticShellFailure(CLEARTEXT_SECRET_FAILURE.code, {
              category: FAILURE_SEMANTICS.POLICY,
              winstage: { secretKind: cleartextSecret.kind, secretSnippet: cleartextSecret.snippet, executed: false },
            })
          }
        }

        if (spec.stdin !== undefined && spec.stdin !== null && String(spec.stdin).length > 0) {
          warn(
            'spec.stdin 被传进来了，但无法接进受限子进程（CreateProcessAsUserW 没有 stdin 通道）；' +
              '它被**丢弃**了 —— 如实记在这里，不静默消费、也不假装成功。',
          )
        }

        let execution
        try {
          execution = await executor.run({
            command: argv.command,
            args: argv.args,
            cwd: stagedDir,
            logicalCwd: workspace.root,
            timeoutMs: spec.timeoutMs,
            env: environment,
          })
        } catch (error) {
          /**
           * ── 验收 3：**不许下与事实相反的结论** ──────────────────────────────────
           *
           * 历史形态在这里无条件写死一句话（"could not run the command" + 隐含"没有执行"）。
           * 而现场实测过：`Start-Process` 报 `Access is denied` **但子进程其实已经运行**。
           * 两条路都会经过这里 ⇒ 旧文案在那种场景下就是**与事实相反**的结论。
           *
           * 现在：先问 `runFailureClassification()` 要"有没有执行证据/拒绝声明是否自相矛盾"，
           * 有 ⇒ 结论只能是**不确定**（`indeterminate`），既不写"未执行"，也不写"被拒"，
           * 而是让调用方以实际产出为准。机读码仍是 `COMMAND_FAILED`，但 `error.indeterminate`
           * 与 `error.winstage.executed === 'unknown'` 让这一条**可机检**。
           */
          const classification = runFailureClassification(error)
          this.logError(
            `执行通道抛错（技术码=${error?.code ?? 'no-code'}，分类=${classification.category}，` +
              `indeterminate=${classification.indeterminate}，证据=[${classification.evidence.join(', ')}]）：` +
              `${error?.message ?? error}。${classification.userDetail}`,
          )
          throw semanticShellFailure('WINSTAGE_SHELL_RUN_FAILED', {
            category: classification.category,
            indeterminate: classification.indeterminate,
            winstage: {
              technicalDetail: String(error?.message ?? error),
              runnerCode: error?.code,
              evidence: classification.evidence,
            },
          })
        }

        const timedOut = execution?.timedOut === true
        // 调用方的信号若在我们跑完之后才触发：如实记为 aborted（或 timedOut，取先到者），
        // 但**不谎称**"我们当场掐断了进程"（见文件头残余边界）。
        const aborted = !timedOut && spec.signal?.aborted === true

        // ── ⑦ 执行后：捕获 → 并入清单 → 冻结候选（失败必须响，并随返回带出）──
        const capture = this.captureStagedChanges(workspace, before, warn)

        // ── ⑦.2 注册表：把 shim 写下的 WAL 变成**审批候选**（本轮闭合）──────────
        // 为什么必须在这里做：覆盖层里的写入对真实 hive 没有副作用，如果宿主不消费
        // `registry/overlay.journal`，用户看到的是"命令成功、注册表却没变"，面板上也
        // 一条都没有 —— 那是**静默空操作**，比硬拒更糟。`captureRegistryChanges()`
        // 把净变化冻结进**同一个** `queue.json`，于是面板 / `/winstage approve|reject`
        // 原样可用（不新造第二套审批面）。
        // 失败绝不打断命令：捕获是收尾动作，例外一律进 error 级日志（见模块头）。
        const registryCapture = captureRegistryChanges({
          sessionDir: workspace.store?.dir,
          sessionId: this.sessionIdOf(),
          workspaceRoot: workspace.root,
          log: (message) => this.log(message),
          logError: (message) => this.logError(message),
        })
        if (registryCapture.handled && registryCapture.enqueued) {
          notes.push(
            `注册表改动已进暂存：${registryCapture.changes} 条净变化，候选 ${registryCapture.candidateId}（批准后才写真实注册表）。`,
          )
        }

        // ── ⑦.3 审计（Method A 主线）：进程树的文件/注册表读写 → `sandbox-audit.json` ──
        //    与注册表捕获同一纪律：收尾动作、失败不打断命令。产物落在会话存储根，
        //    `review-service.snapshot()` 会把它作为 `audit` 段带进面板（同一条读侧）。
        const auditCapture = this.captureAudit(executor, workspace, warn)
        if (auditCapture.handled) {
          notes.push(`${auditCapture.text}（已写入 sandbox-audit.json）`)
        }

        const envRejected = Array.isArray(execution?.envRejected) ? execution.envRejected : []
        for (const name of envRejected) {
          warn(`环境变量 ${name} 未被采纳（名字像凭据），未进入子进程。`)
        }

        // ── ⑦.5 命令产出「立刻可见」：有净变化才发布一次审阅快照（人工侧动作）────
        //    与 `/winstage refresh`（`host-plugin.mjs:240`）**同一条调用**：`service.publish()`。
        //    绝不写 stdout/stderr（task-5 的零痕迹契约），失败也不影响命令结果。
        //    ⚠ 注册表捕获必须在它**之前**：否则这次发布的快照里没有注册表候选，
        //      用户要等下一轮才会有反应（"点了没反应"的经典形态）。
        const publish = this.publishSnapshotIfChanged({ capture, workspace, sessionId: this.sessionIdOf() })

        this.log(
          `受限执行完毕 exit=${execution?.exitCode ?? '?'} timedOut=${timedOut}；` +
            `捕获 ${capture.captured} 条、并入 ${capture.ingested} 条、删除 ${capture.deletions} 条、` +
            `候选=${capture.candidate?.frozen === true ? capture.candidate.candidate?.id : `未新建(${capture.candidate?.reason ?? 'n/a'})`}；` +
            `注册表=${registryCapture.handled ? `${registryCapture.reason}(${registryCapture.changes ?? 0})` : registryCapture.reason}；` +
            `快照发布=${publish.published ? '已发布' : `跳过(${publish.reason})`}`,
        )

        return this.settledExecution({
          spec,
          workspace,
          stagedDir,
          notes,
          execution: {
            exitCode: execution?.exitCode ?? null,
            stdout: execution?.stdout,
            stderr: execution?.stderr,
            timedOut,
            envRejected,
          },
          aborted,
          capture,
          publish,
        })
      } finally {
        // 每个命令一套令牌/ACL/Job：跑完立刻拆，绝不跨命令复用
        try {
          executor.dispose?.()
        } catch (error) {
          this.logError(`executor.dispose() 失败（不掩盖命令结果）：${error?.message ?? error}`)
        }
      }
    }

    // ==================== 内部：装配 ====================

    /**
     * 取到运行时那一份 `ShellExecutor` **基类**。
     *
     * 只在**第一次 execute()** 时 import：
     *   - 拿不到包 ⇒ 可读的 fail-closed 错误（而不是整条 loader 行加载失败）；
     *   - 包在、但不够格 ⇒ cordis 会直接报"重复的 shell 服务"，用户能看见。
     * 绝不用 `ShellExecutor` 之外的替身冒充基类（那会注册出一个假的 `ctx.shell` 变体）。
     */
    async loadBaseClass() {
      if (injectedBase) return injectedBase
      if (this.baseUnavailable) {
        this.logError('无法定位基类模块 @deepseek-ai/dsh-shell ⇒ fail-closed。请提供含 @deepseek-ai/* 的 node_modules 根。')
        throw semanticShellFailure('WINSTAGE_SHELL_BASE_MISSING')
      }
      if (!this.resolvedBasePromise) {
        this.resolvedBasePromise = (async () => {
          const modulePath = this.resolveShellModule()
          if (!modulePath) {
            this.logError('无法定位基类模块 @deepseek-ai/dsh-shell ⇒ fail-closed。请提供含 @deepseek-ai/* 的 node_modules 根。')
            throw semanticShellFailure('WINSTAGE_SHELL_BASE_MISSING')
          }
          let loaded
          try {
            loaded = await import(pathToFileURL(modulePath).href)
          } catch (error) {
            this.logError(`import ${modulePath} 失败：${error?.message ?? error}`)
            throw semanticShellFailure('WINSTAGE_SHELL_BASE_LOAD_FAILED', {
              winstage: { technicalDetail: String(error?.message ?? error), modulePath },
            })
          }
          const klass = loaded?.ShellExecutor ?? loaded?.default
          if (typeof klass !== 'function') {
            this.logError(`${modulePath} 没有导出 ShellExecutor 类。`)
            throw semanticShellFailure('WINSTAGE_SHELL_BASE_LOAD_FAILED', {
              winstage: { technicalDetail: `${modulePath} did not export a ShellExecutor class`, modulePath },
            })
          }
          return klass
        })()
      }
      return this.resolvedBasePromise
    }

    /**
     * **有净变化才发布一次审阅快照**（命令产出"立刻可见"）。
     *
     * 纪律（逐条都是硬要求）：
     *   1. **同一条调用**：默认走 `publishWorkspaceSnapshot()` = `getReviewService(...).publish()`，
     *      也就是 `/winstage refresh` 与 `staging-fs.afterMutation()` 用的那条（不另造路径）；
     *   2. **无净变化不发布**：沿用 `freezeIfNeeded()`「无净变化不入队」的同一口径，
     *      否则每条命令（含只读命令）都会刷一次盘；
     *   3. **零痕迹**：这是**纯人工侧**动作，绝不写 stdout/stderr（task-5 契约）；
     *   4. **失败不影响命令**：任何异常只记一条 error 级日志（人工侧），
     *      退出码/输出/`winstage.capture.*` 一律照原样返回。
     *
     * 根守卫：只在**行表给出的权威根**与本次实际用的 `workspace.root` 同根时才发布
     * （根统一之后必然同根；离线自测注入假工作区时通常拿不到权威根 ⇒ 自动跳过，
     * 绝不会把假工作区的改动写进真实存储）。
     *
     * @returns {{published: boolean, reason: string, error?: string}}
     */
    publishSnapshotIfChanged({ capture, workspace, sessionId }) {
      const changed =
        Boolean(capture) &&
        (capture.captured > 0 ||
          capture.ingested > 0 ||
          capture.deletions > 0 ||
          capture.candidate?.frozen === true)
      if (!changed) return { published: false, reason: 'no-net-change' }
      let root
      try {
        root = this.effectiveWorkspaceRoot()
      } catch {
        root = undefined
      }
      if (typeof root !== 'string' || root.length === 0) return { published: false, reason: 'no-workspace-root' }
      if (!sameRootText(root, workspace?.root)) return { published: false, reason: 'root-mismatch' }
      if (typeof this.publishFor !== 'function') return { published: false, reason: 'no-publisher' }
      try {
        this.publishFor(sessionId, root)
        return { published: true, reason: 'published' }
      } catch (error) {
        const message = String(error?.message ?? error)
        try {
          this.logError(`发布审阅快照失败（命令结果不受影响）：${message}`)
        } catch {
          /* best effort：日志失败也不许影响命令结果 */
        }
        return { published: false, reason: 'publish-failed', error: message }
      }
    }

    /**
     * 暂存树根 = 命令的真实 cwd。
     * 优先 `workspace.store.stagedDir`（与 `src/cli.mjs` 的 `exec` 分支逐字一致）。
     */
    stagedDirOf(workspace) {
      const stagedDir = workspace?.store?.stagedDir
      if (typeof stagedDir !== 'string' || stagedDir.length === 0) {
        this.logError('工作区没有给出可用工作目录（store.stagedDir 为空）⇒ 拒绝用一个未指定的目录去跑。')
        throw semanticShellFailure('WINSTAGE_SHELL_NO_STAGED_ROOT', {
          detail: 'refusing to run with an unspecified working directory.',
        })
      }
      return stagedDir
    }

    /**
     * 执行后的捕获链：`captureAfterExecution` → `ingestCapturedChanges` → `freezeIfNeeded`。
     * 与 `src/cli.mjs` 的 `exec` 分支同一顺序（那里是唯一权威）。
     * **任何一步失败都走 error 级日志**，并把失败信息如实带回（绝不静默）。
     */
    captureStagedChanges(workspace, before, warn) {
      const report = { captured: 0, ingested: 0, deletions: 0, skipped: [], candidate: undefined, failures: [] }
      if (typeof workspace.captureAfterExecution !== 'function') {
        report.failures.push('captureAfterExecution is not available on this workspace')
        warn('工作区没有 captureAfterExecution()：命令产出**不会**进入清单（本次执行结果仍然如实返回）。')
        return report
      }
      let captured
      try {
        captured = workspace.captureAfterExecution(before)
        report.captured = Array.isArray(captured) ? captured.length : 0
      } catch (error) {
        report.failures.push(`captureAfterExecution: ${error?.message ?? error}`)
        warn(`捕获命令产生的变更失败：${error?.message ?? error}（命令已执行，但产出没有被并入清单）`)
        return report
      }
      try {
        const ingested = workspace.ingestCapturedChanges(captured)
        report.ingested = ingested?.ingested ?? 0
        report.deletions = ingested?.deletions ?? 0
        for (const skip of ingested?.skipped ?? []) {
          report.skipped.push(skip)
          warn(`并入清单时跳过 ${skip.path}：${skip.reason}`)
        }
      } catch (error) {
        report.failures.push(`ingestCapturedChanges: ${error?.message ?? error}`)
        warn(`把捕获结果并入清单失败：${error?.message ?? error}`)
        return report
      }
      try {
        report.candidate = workspace.freezeIfNeeded({ source: 'shell' })
      } catch (error) {
        report.failures.push(`freezeIfNeeded: ${error?.message ?? error}`)
        warn(`冻结待审候选失败：${error?.message ?? error}（变更已在清单里，但没有生成候选）`)
      }
      return report
    }

    /**
     * Method A 主线：把 shim 的结构化审计（`executor.auditPath`，JSONL）聚合成
     * `sandbox-audit.json`，落在**会话存储根**（与 `review.json` 同处）⇒ 面板与 CLI
     * 读的是同一份。内容 = AI 的进程树**读了/改了/删了哪些文件、读了/改了哪些注册表键**，
     * 按 `workspace/outside` 分类。
     *
     * 这是**收尾动作**：任何失败都进 warn 并如实返回 `handled:false`，**绝不打断命令**
     * （与 `captureRegistryChanges` 同一纪律）。
     */
    captureAudit(executor, workspace, warn) {
      const auditPath = executor?.auditPath
      const storeDir = workspace?.store?.dir
      if (typeof auditPath !== 'string' || auditPath.length === 0) return { handled: false, reason: 'audit-disabled' }
      if (typeof storeDir !== 'string' || storeDir.length === 0) return { handled: false, reason: 'no-store-dir' }
      try {
        if (!existsSync(auditPath)) return { handled: false, reason: 'no-audit-file' }
        const lines = readFileSync(auditPath, 'utf8').split(/\r?\n/)
        const report = buildAuditReport(lines, { root: workspace.root, audits: [auditPath] })
        const out = join(storeDir, 'sandbox-audit.json')
        writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
        return { handled: true, path: out, summary: report.summary, text: summarizeAudit(report.summary) }
      } catch (error) {
        warn(`聚合审计失败（命令结果不受影响）：${error?.message ?? error}`)
        return { handled: false, reason: `error:${error?.message ?? error}` }
      }
    }

    // ==================== 内部：返回形状 ====================

    /**
     * 构造**已结算**的 `ShellExecution`（契约允许：dsh-shell/lib/types/index.d.ts:40
     * "Expiry during preparation returns a settled timed-out handle without output"）。
     *
     * 形状逐项对齐：status / exitCode / signal / done / sandbox? / readOutput() /
     * observed / kill() / result()。另有 `winstage` 这个**附加**可观测面（不属于契约，
     * 便于诊断：暂存树路径、捕获计数、候选 id、失败原因）。
     */
    settledExecution({ spec, workspace, stagedDir, notes, execution, aborted, capture, publish }) {
      const timedOut = execution.timedOut === true
      // cli exec 的超时口径：exitCode 124（`WindowsStageExecutor` 的 terminate(124)）。
      // 中止（信号）没有退出码可言 ⇒ null，与"被信号杀死"同形。
      const exitCode = timedOut ? 124 : aborted ? null : execution.exitCode ?? null

      const stdoutOut = boundedOutput(execution.stdout, spec.stdoutMaxBytes)
      const stderrOut = boundedOutput(execution.stderr, spec.stdoutMaxBytes)

      /**
       * ── 模型可见输出 = 命令自己的输出（**逐字节一致**，本轮修复的核心）──────────
       *
       * 历史形态是把 `[winstage] executed inside the sandbox; real cwd = <暂存树> (real
       * workspace: …)`、`[winstage] captured N change(s) …`、`CAPTURE FAILED` 与所有内部
       * 注记**追加进 stderr**。而 `dsh-tool-pwsh` 的 `renderPwshResult()` 会把 stdout 与
       * stderr 全文一起渲染进模型可见的结果 ⇒ 沙箱存在、暂存树路径、候选 id 全部暴露。
       * 实测原始形态见 `docs/dsh2-shell-交还与降级-修复报告.md:86-88`。
       *
       * 现在：**一个字节都不注入**（连尾部换行都不补 —— 否则"零痕迹"就不成立）。
       * 同一份诊断仍在，但只在**人工侧**：
       *   - `handle.winstage.*`：不属于 `ShellExecution` 契约的结构化字段；
       *   - `ctx.logger` / `logError`："失败必须响"（捕获/冻结失败在
       *     `captureStagedChanges()` 里已经进了 error 级日志）；
       *   - 显式诊断文件：`WINSTAGE_DIAG_LOG` / 行 config `diagLog`（`writeDiagnostics()`）。
       */
      this.writeDiagnostics({
        event: 'shell-execution',
        workspaceRoot: workspace.root,
        workingDirectory: stagedDir,
        /**
         * ★ 本次执行**实际走的是哪条通道**（本轮加）——
         * 用户报障"注册表更改直接失败"的根因之一就是这条通道**静默**降级：
         * `tier:'auto'` 探测不过 ⇒ 受限令牌档 ⇒ 没有 shim ⇒ 注册表写只剩内核硬拒。
         * 人工排查时必须能一眼看到它，否则"沙箱开着"与"沙箱退化了"长得一模一样。
         */
        lanes: this.lastLane ?? { launchMode: null, tierEffective: null, fallbackReason: 'not-recorded' },
        notes,
        publish: publish ?? { published: false, reason: 'not-attempted' },
        capture: capture
          ? {
              captured: capture.captured,
              ingested: capture.ingested,
              deletions: capture.deletions,
              skipped: capture.skipped,
              frozen: capture.candidate?.frozen === true,
              candidateId: capture.candidate?.candidate?.id,
              reason: capture.candidate?.reason,
              failures: capture.failures,
            }
          : { available: false, failures: ['captureAfterExecution unavailable'] },
      })

      const stderrJoined = stderrOut.text
      const stderrFinal = stderrOut

      const runResult = {
        exitCode,
        signal: null,
        timedOut,
        aborted,
        timeoutMs: spec.timeoutMs,
        stdout: { text: stdoutOut.text, truncated: stdoutOut.truncated },
        // stderr **逐字节**等于命令自己的 stderr（`stderrFinal === stderrOut`）。
        stderr: { text: stderrFinal.text, truncated: stderrFinal.truncated },
        // sandbox 事实**刻意不报**：本执行器已经广告 sandboxMode === undefined，
        // 报出 mode 会让 dsh-tool-pwsh 走 sandboxDenialMarker(mode) 渲染路径
        // （tool-pwsh/lib/index.js:165-168）—— 一个我们并不使用的模式。
      }

      let drained = false
      return {
        status: 'completed',
        exitCode,
        signal: null,
        done: Promise.resolve(),
        /** 前台投影（契约：只在基础设施故障时 reject；这里总是 resolve） */
        result: () => Promise.resolve(runResult),
        /** 消费式读：首次给全文，之后给空（连续读不重复投递） */
        readOutput() {
          if (drained) return { delta: '', lossy: false }
          drained = true
          return {
            delta: `${stdoutOut.text}${stderrOut.text.length > 0 ? `\n[stderr]\n${stderrOut.text}` : ''}`,
            lossy: false,
          }
        },
        /** 非消费式偏移读：两个流各一个 reader，独立于 readOutput 的游标 */
        observed: {
          stdout: makeOffsetReader(execution.stdout),
          stderr: makeOffsetReader(stderrJoined),
        },
        /** 已结算 ⇒ 没有可终止的区间（契约里"已经结束 ⇒ no-op"的语义） */
        kill() {
          return false
        },
        // —— 附加可观测面（不属于 ShellExecution 契约）——
        winstage: {
          kind: 'win-stage-sandbox',
          stagedDir,
          logicalWorkspaceRoot: workspace.root,
          capture: capture
            ? {
                captured: capture.captured,
                ingested: capture.ingested,
                deletions: capture.deletions,
                skipped: capture.skipped,
                frozen: capture.candidate?.frozen === true,
                candidateId: capture.candidate?.candidate?.id,
                reason: capture.candidate?.reason,
                failures: capture.failures,
              }
            : { available: false, failures: ['captureAfterExecution unavailable'] },
          /**
           * 发布结果（人工侧）：`{published, reason}`。命令产出"立刻可见"的可观测落点，
           * 面板/自测据此断言"有净变化 ⇒ 已发布 / 无净变化 ⇒ 跳过"。
           */
          publish: publish ?? { published: false, reason: 'not-attempted' },
          envRejected: execution.envRejected ?? [],
          /**
           * ★ BUG-B：本次执行**实际走的通道**（结构化，人工/命令侧可见）。
           * `verdict.status === 'degraded'` ⇒ 沙箱未生效（没有 shim ⇒ 写入只剩内核硬拒、
           * 文件产出不进暂存）。放在这里是为了让断言/排查**不必读日志**就能分辨
           * "沙箱生效"与"沙箱退化成拒绝一切"；它同样**不进**模型可见的 stdout/stderr。
           */
          lane: this.lastLane ? { ...this.lastLane, verdict: summarizeLane(this.lastLane) } : undefined,
          notes,
        },
      }
    }
  }
}

export default createWinStageShellExecutor
