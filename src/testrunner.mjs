/**
 * testrunner.mjs — 测试运行核心（可复用）
 *
 * 为什么抽成模块：`autotest.mjs`（CLI）与 `testservice.mjs`（HTTP 服务）必须使用
 * **同一份套件清单与同一份判定逻辑**。否则两处会漂移，出现"CLI 说通过、服务说失败"
 * 这种最难查的不一致（手册第 2 章"唯一权威"的同一道理：
 * 两条消费路径必须走同一份投影）。
 *
 * 关于子进程输出捕获（重要，见残余边界 R10/#15）：
 *   受限令牌下 `spawnSync` 默认的 `stdio: 'pipe'` 走**命名管道**，客户端打开请求需要
 *   受限 SID 未被授予的写权限 → 子进程创建直接 EPERM。
 *   因此这里把 stdout/stderr **重定向到文件描述符**，完全绕开命名管道。
 */

import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WINDOWS_HIDE, suppressWindowsCriticalErrorDialogs } from './spawn-window.mjs'
import { stageBaseDir } from './stage-guard.mjs'

suppressWindowsCriticalErrorDialogs()

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 本次测试运行的唯一标签：让每个套件的暂存根在**两次运行之间**也互不污染（见 runSuite）。 */
const TEST_STAGE_RUN_TAG = `${process.pid}-${Date.now().toString(36)}`

/** 离线确定性套件：不需要沙箱、不需要管理员，任何会话都能跑 */
export const OFFLINE_SUITES = [
  { id: 'selftest', script: 'tests/selftest.mjs', title: '手册不变量（统一视图/删除权威/候选冻结/选择性应用/遮蔽/返回语义）' },
  { id: 'e2e-flow', script: 'tests/e2e-flow.mjs', title: '端到端链路（捕获→冻结→diff→选择性提交）' },
  { id: 'struct-layout', script: 'tests/struct-layout.mjs', title: '结构体布局（大小/偏移/越界/扩展限制/环境块编码）' },
  { id: 'appcontainer-layout', script: 'tests/appcontainer-layout.mjs', title: 'AppContainer 布局（STARTUPINFOEX/SECURITY_CAPABILITIES/创建标志）' },
  { id: 'resolve-exec', script: 'tests/resolve-exec.mjs', title: '可执行文件解析（PATHEXT/相对与绝对路径/失败显式化）' },
  { id: 'executor-stub', script: 'tests/executor-stub.mjs', title: '执行器编排（装配/spawn 契约/0x400/Job 配额/结果收集/fail-closed）' },
  { id: 'audit-parse', script: 'tests/audit-parse.mjs', title: '审计解析（哨兵/空输出必须判 fail/单引号转义）' },
  { id: 'paths-masks', script: 'tests/paths-masks.mjs', title: '敏感清单与探针映射（N1–N10/类别与理由/单调收紧）' },
  // FIX-C 追加：`registry-guard` 的 125 条断言此前**只被单独跑过**，从未进 verify/autotest 的套件清单
  // ——"改坏了没人知道"的那类漏洞。它与 verify.cmd 的清单必须逐字一致（两处都改了）。
  { id: 'registry-guard', script: 'tests/registry-guard.mjs', title: '注册表快照/差异/回滚计划（含 F8：非十六进制 data 必须抛错）' },
  { id: 'workspace-regressions', script: 'tests/workspace-regressions.mjs', title: '工作区回归（D8 重解析点不可崩 / D10 合成目录不得误报损坏）' },
  // 元测试：反证"运行器真的能检出失败"。永远报绿的运行器比没有运行器更糟。
  { id: 'meta-runner', script: 'tests/meta-runner.mjs', title: '元测试（运行器能否检出失败）' },
  // FIX-F 追加（接线与收尾）：下面两个套件此前**只被单独跑过**，从未进 verify/autotest
  // —— 与 FIX-C 给 registry-guard 记下的问题完全同族："改坏了没人知道"。
  // 与 verify.cmd 的清单必须逐字一致（两处同时改）。
  { id: 'appcontainer-runtime', script: 'tests/appcontainer-runtime.mjs', title: 'AppContainer 运行期（属性列表/启动原语/令牌证据/隔离判定 fail-closed）' },
  // ⚠ 计数口径（如实声明，不要读成"这个套件没有断言"）：
  //   `countChecks()` 只统计输出里的 `✓`/`✗`。本套件**刻意**用 ASCII 标记
  //   `[OK  ]`/`[FAIL]`（原因见其文件头：cmd/PowerShell 5.1 控制台按 OEM 代码页解码，
  //   非 ASCII 标记会变乱码，从而让"红还是绿"看起来一样 —— 缺陷 11 的形态）。
  //   因此它的 `checksOk` 会显示为 0，而**判定仍严格来自退出码**（失败即 FAIL，不因计数为 0 而变绿）。
  //   它真实的自报断言数由套件自己打印在输出末行（形如 `断言 23 项，失败 0 项`），可在
  //   `.t\run-probe-selfkill-guard.txt` 复核。这里不改 `countChecks` 的全局语义：
  //   那个投影同时服务所有套件，顺手放宽会悄悄改掉既有 11 个套件的计数基准。
  { id: 'probe-selfkill-guard', script: 'tests/probe-selfkill-guard.mjs', title: 'FIX-E 回归（probeWin32Abi 自杀死：子进程指派 + 回读 accounting，不得自指派）' },
  // 第三轮（网络/缓解/上限三块新能力）追加。三个套件本身都是**离线确定性**的：
  // 用替身绑定表与合成缓冲区验证，不需要管理员、不触碰真实 WFP/BFE、不创建子进程，
  // 因此归 OFFLINE_SUITES（与 verify.cmd 的清单必须逐字一致，两处同时改）。
  { id: 'netpolicy', script: 'tests/netpolicy.mjs', title: '网络策略（WFP 档位解析 / fail-closed / 安装后回读校验）' },
  { id: 'mitigations', script: 'tests/mitigations.mjs', title: '进程缓解策略（seccomp 等价物：ACG/CIG/禁 Win32k/禁扩展点）' },
  { id: 'limits', script: 'tests/limits.mjs', title: '资源上限（暂存配额 / 输出上限 / 重解析点不越界）' },
  // 接线验收：套件本身只读源码/注册表（不跑任何子进程），因此也是离线确定性的。
  // ⚠ 该文件由**并行 agent 创建**：若本轮结束时仍不存在，要在 README 里如实记成缺口，
  //   不得为了让清单好看而把它摘掉（"套件存在但没人跑"正是本项目反复记录的缺陷形态）。
  { id: 'integration-wiring', script: 'tests/integration-wiring.mjs', title: '接线验收（新模块必须真的被运行期调用）' },
  // 下面这个是**补登记**的：`tests/wfp-layout.mjs` 早在本轮之前就存在且手动跑是绿的，
  // 但它既不在 OFFLINE_SUITES 也不在 verify.cmd —— 与 `registry-guard`（FIX-C）、
  // `appcontainer-runtime`（FIX-F）完全同族的"改坏了没人知道"漏洞。
  // 它按文件头明确声明只钉合成缓冲区、**不触碰任何系统状态**，所以属离线档。
  { id: 'wfp-layout', script: 'tests/wfp-layout.mjs', title: 'WFP 结构体布局与参数构造（合成缓冲区，需管理员的行为不参与）' },
  // 治理套件（把"清单漂移"与"残余边界漂移"本身变成可执行断言，对齐 NeoAI 的
  // "已知残余冻结为基线"实践）：都是纯静态检查 / 纯函数调用，零依赖、零副作用。
  { id: 'suite-wiring', script: 'tests/suite-wiring.mjs', title: '套件接线治理（注册表 = verify.cmd 清单 = 磁盘文件，未登记文件必须显式列名）' },
  { id: 'residual-baseline', script: 'tests/residual-baseline.mjs', title: '残余边界基线（R1–R12 不得消失 / 网络与缓解的 [未实测] 声明不得被删）' },
  // C3 追加（审批策略 never 的用户感知一致性）：把"潜在硬断裂"从人工记忆变成机器断言。
  //   - 活动 profile 的 `permission` 行必须有**显式** `defaultPreset` 且指向 `presets` 里的预设
  //     （缺失 ⇒ `dsh-permission-presets` 装配期抛错 ⇒ composer 的访问模式控件整块消失）；
  //   - `sandboxMode` 必须恒报最窄可用档（改成"反映生效档位"会形成会话档位反馈环）；
  //   - 槽位接管只看 WinStage 自己的三态开关；WinStage 审批不经过 `ctx.approval`；
  //   - `audit-mirror` 不得自己编造 `approval/decided`；
  //   - `docs/DSH集成.md` 不得再声称 `sandboxMode` 报 `undefined`。
  // 纯静态文本 + 纯函数行为，零子进程、零管理员、零网络 ⇒ 离线档。
  // 与 verify.cmd 的清单必须逐字一致（两处同时改；tests/suite-wiring.mjs 机器检查）。
  { id: 'policy-never-consistency', script: 'tests/policy-never-consistency.mjs', title: '审批策略一致性守门（defaultPreset 硬断裂 / sandboxMode 静态 / 槽位与审批 seam 无关 / 审计镜像不造假）' },
  // 本轮（复现式补丁工具包 + 源码基线封印）追加两个**离线确定性**套件：
  //   - `baseline-integrity`：本仓曾把 `.gitignore` 写成整体忽略 `tests/`，`tools/` 与
  //     `src/limits.mjs` 等源码从未入版本库 ⇒ "只改了注释、行为一字未动"这句话此前
  //     **没有基线可比**，未跟踪文件的漂移在 `git status` 里也看不见（整理轮已把收录面
  //     全部入库，封印继续钉住**内容**与**覆盖面**）。本套件把 `docs/源码基线.sha256`
  //     变成硬判据：受封印文件逐条哈希必须相符，漂移即红并打印刷新指令；
  //     清单缺失 / 不可读 / 为空**默认判红**（fail-closed），只有显式逃生口才 SKIP。
  //   - `dsh-patch-guard`：DSH 是 **npx 缓存安装树**（编译产物，无源码无构建工具），
  //     手工补丁会在 `npm i`/升级后**无声消失**，上游一升级锚点也会漂。本套件把
  //     "现场哈希必须恰好等于 before（未打）或 after（已打）"变成红灯；定位不到 harness 时如实 SKIP。
  // 两者都零子进程、零网络、零管理员、零系统状态 ⇒ 离线档。
  // 与 verify.cmd 的清单必须逐字一致（两处同时改；tests/suite-wiring.mjs 机器检查）。
  { id: 'baseline-integrity', script: 'tests/baseline-integrity.mjs', title: '源码基线封印（受封印文件逐条哈希 == docs/源码基线.sha256；漂移即红并给出刷新指令）' },
  { id: 'dsh-patch-guard', script: 'tests/dsh-patch-guard.mjs', title: 'DSH 补丁守门（清单自洽 + 现场哈希 ∈ {before, after}；harness 漂移即红，找不到 harness 如实 SKIP）' },
  // 缺陷③ 修复轮追加：T0 污染让 T1 暂存写永久失效 + 自检已报 degraded 却照跑命令返回 0。
  //   A 段（判据/判定/闸门/修复命令）纯离线确定性：零真实 ACL 写、零真实子进程；
  //   B 段（真机 ACL 复现与自愈）会真的往**临时**工作区注入一条 ACE，跑完必删，
  //   因此仍归离线清单（与 file-cow-dispositions 那类"必须注入子进程"的套件不同：
  //   本套件不碰注册表、不碰真实工作区、不依赖 shim）。
  //   与 verify.cmd 的清单必须逐字一致（两处同时改）。
  { id: 'boundary-degraded-failclosed', script: 'tests/boundary-degraded-failclosed.mjs', title: '缺陷③回归（T0 污染 → T1 静默降级必须 fail-closed + init 侧陈旧包 SID ACE 修复）' },
  // 缺陷①b 修复轮追加（finisher 收口）：白障标记必须变成"真实路径的删除候选"。
  //   原文件是 `.t\shim-delete\test-whiteout-capture.mjs` —— 它是 ①b 的唯一聚焦回归，
  //   却只被单独跑过（与 registry-guard / appcontainer-runtime / wfp-layout 同族的
  //   "改坏了没人知道"漏洞）。本轮**原样提升**为 `tests\whiteout-candidate-capture.mjs`，
  //   登记进两张表。判据仍是纯 Workspace API + 伪造的 shim 落盘布局：
  //   零子进程、零 ACL 写、零 shim 依赖 ⇒ 离线档，任何会话都能跑。
  //   与 verify.cmd 的清单必须逐字一致（两处同时改；tests/suite-wiring.mjs 机器检查）。
  { id: 'whiteout-candidate-capture', script: 'tests/whiteout-candidate-capture.mjs', title: '缺陷①b回归（白障标记 → 删除候选：不得出现 wo\\ 伪 create / 真实路径必须进审批面）' },
  // 修复② 轮追加：装配层"shell 提供方择一"的离线回归。
  //   守的是 `dsh-plugin/cordis.patch.yml` 里 `pwsh-sandbox` 与 `winstage-shell` 两条
  //   `disabled: !!js` 表达式必须**逐字成对取反**；本条修复把门控从进程环境变量
  //   `WINSTAGE_SHELL` 改成 profile 开关（旧口径下第二实例的 winstage-shell 永不装载
  //   ⇒ 注册表写没有 shim、只剩内核硬拒）。纯文本 + 纯函数求值，零子进程 ⇒ 离线档。
  //   与 verify.cmd 的清单必须逐字一致（两处同时改；tests/suite-wiring.mjs 机器检查）。
  { id: 'assembly-toggle-selftest', script: 'tests/assembly-toggle-selftest.mjs', title: '装配层择一（profile 开关为唯一权威 / 两条 !!js 表达式必须成对取反 / YAML 形态回归）' },
  // 缺陷②（子 agent 未纳入沙箱）修复轮追加：身份必须归到**顶层祖先会话**，
  //   否则子 agent 的暂存落进用户看不见的子会话存储（既批不了也拒不了 = 静默）。
  //   纯函数 + 静态接线断言，零子进程 ⇒ 离线档。
  //   与 verify.cmd 的清单必须逐字一致（两处同时改；tests/suite-wiring.mjs 机器检查）。
  { id: 'session-enclosure-selftest', script: 'tests/session-enclosure-selftest.mjs', title: '子会话纳入同一审批面（parentSession 逐级归并 / 两个 provider 都接线 / 变异自证）' },
  // Method A 主线（进程内结构化审计）轮追加：审计聚合器 `aggregateAudit` 的离线自测。
  //   纯函数、零子进程、零 Win32 ⇒ 离线档。与 verify.cmd 清单必须逐字一致。
  { id: 'sandbox-audit', script: 'tests/sandbox-audit.mjs', title: '审计聚合器（Method A：进程树文件/注册表读写 → workspace/outside 分类统计）' },
  // 启动环境监测（fail-closed）轮追加：`dsh-plugin/environment-gate.mjs` 的纯判定。
  { id: 'environment-gate', script: 'tests/environment-gate.mjs', title: '启动环境监测（非 Windows / 受限令牌不可用 ⇒ 拒绝启动；逃生口须显式）' },
]

/** 需要未受限会话的套件 */
export const SANDBOX_SUITES = [
  { id: 'diag-bindings', script: 'tests/diag-bindings.mjs', title: '绑定表契约 + 完整 init' },
  // T6 接线：门禁收敛（去令牌化 TS）新增/重写的两个真产物闸门此前只被单独跑过。
  // 它们都要注入子进程（后者还要写真实 hive），因此归"需要未受限会话"一类，不进 verify.cmd。
  { id: 'file-cow-dispositions', script: 'tests/file-cow-dispositions.mjs', title: '文件层 CoW/创建处置矩阵 + 沙箱内可观测性（逐字节）' },
  { id: 'registry-unstaged-wow64', script: 'tests/registry-unstaged-wow64.mjs', title: '注册表 WOW64（64KEY no-op / 32KEY UNSTAGED 透传）与 apply 忽略 UNSTAGED' },
  // 缺陷① 修复轮追加（finisher 收口）：TS 档四种删除写法（cmd del/erase、
  //   PowerShell Remove-Item、node fs.unlinkSync）必须"真实文件存活 + 白障已记"，
  //   同时钉住孙子进程自注入、move/ren 暂存与两条负面对照。
  //   它驱动**真实 CLI + 真实 shim 注入 + 真实子进程**（依赖
  //   `shim\out\winstage-shim.dll` 的新鲜度），因此归"需要未受限会话"一类，
  //   不进 verify.cmd（与 file-cow-dispositions 同理）。原文件是
  //   `.t\shim-delete\test-delete-capture.mjs`，本轮原样提升为 tests\delete-capture.mjs。
  //   `--strict-deletions` 现在是默认值（①b 让候选删除数可致命）。
  { id: 'delete-capture', script: 'tests/delete-capture.mjs', title: '缺陷①回归（TS 档删除必须进暂存 + 白障 + 孙进程注入；真实 shim/子进程）' },
]

/** 全部套件（含沙箱段），供白名单与文档使用 */
export const ALL_SUITE_IDS = [...OFFLINE_SUITES, ...SANDBOX_SUITES].map((s) => s.id)

/**
 * 运行一个子进程并捕获输出（fd 重定向，绕开命名管道）。
 * @returns {{status:number|null, signal:string|null, error:Error|undefined, text:string, durationMs:number}}
 */
export function runCaptured(command, argv, options = {}) {
  const outFile = options.outFile
  mkdirSync(dirname(outFile), { recursive: true })
  const fd = openSync(outFile, 'w')
  const started = Date.now()
  let result
  try {
    result = spawnSync(command, argv, {
      cwd: options.cwd ?? REPO,
      timeout: options.timeout ?? 600000,
      stdio: ['ignore', fd, fd],
      // 见 src/spawn-window.mjs：不碰 CREATE_NO_WINDOW/CREATE_NEW_CONSOLE 这一组
      // （原生 CreateProcess 实测会 0xC0000142）；弹框由该模块的 SetErrorMode 抑制。
      windowsHide: WINDOWS_HIDE,
      env: options.env,
    })
  } finally {
    closeSync(fd)
  }
  const text = existsSync(outFile) ? readFileSync(outFile, 'utf8') : ''
  return {
    status: result.status,
    signal: result.signal,
    error: result.error,
    text,
    durationMs: Date.now() - started,
  }
}

function countChecks(text) {
  return {
    ok: (text.match(/✓/g) ?? []).length,
    bad: (text.match(/✗/g) ?? []).length,
  }
}

function verdictLineOf(text) {
  return (
    text
      .split(/\r?\n/)
      .filter((l) => /RESULT|判定:|全部通过|诊断结论|元测试：/.test(l))
      .pop() ?? ''
  )
}

/**
 * 运行一个普通套件。
 * @param {{id:string,script:string,title:string}} suite
 * @param {{outDir:string, workspace:string, kind?:string, timeout?:number, onEvent?:(e:object)=>void}} ctx
 */
export function runSuite(suite, ctx) {
  const outFile = join(ctx.outDir, `run-${suite.id}.txt`)
  // 封印逃生口**不得被子进程继承**（本轮 LOW 缺陷的收口）：
  //   `tests\baseline-integrity.mjs` 认 `WINSTAGE_ALLOW_UNSEALED=1`（或 `--allow-unsealed`）——
  //   清单缺失时打印 "RESULT: SKIP manifest-unsealed-allowed" 并**退出码 0**。这对
  //   "人工单跑该套件"是正确的，但共享运行器一旦把它传下去，`autotest.mjs` 与
  //   `testservice.mjs`（HTTP 测试服务）就会与 `verify.cmd` 犯同一个毛病：
  //   把清单移走仍能拿到绿色判定，而消费方只看最终一行。
  //   注意必须 **delete 键**，不能只赋 `undefined`：环境块是按键序列化后传给子进程的，
  //   留下这个键就等于把"逃生口已开启"写在子进程的环境里。
  //   （`verify.cmd` 另有一道 `set "WINSTAGE_ALLOW_UNSEALED="`，两道一起覆盖批处理直跑。）
  const childEnv = { ...process.env, STAGING: join(ctx.workspace, '.dshstage', 'staged') }
  delete childEnv.WINSTAGE_ALLOW_UNSEALED
  // 暂存根隔离（本轮修复）：默认暂存根按 `env.DSH_SESSION_ID` 取键 ⇒ 同一会话下**所有套件
  // 共用一个持久根**，上一次运行留下的暂存条目会被当成本次的净变化。实测 e2e-flow 的 #12.2
  // 四条断言因此假红（"其余变更未应用" / "剩余变更全部应用" / "真实 src/app.js 现为 x = 3" /
  // "嵌套新建 out/build.log 已提交"）。这里给每个套件一个"运行标签 + 套件 id"的唯一根：
  // 套件之间、两次运行之间都不再互相污染；父目录与产品同源（stageBaseDir），不另造一份口径。
  childEnv.WINSTAGE_STAGE_ROOT = join(stageBaseDir(childEnv), `tests-${TEST_STAGE_RUN_TAG}-${suite.id}`)
  const run = runCaptured(process.execPath, [join(REPO, suite.script)], {
    cwd: REPO,
    timeout: ctx.timeout ?? 300000,
    outFile,
    // 有些套件需要显式工作区根（diag-bindings 用 STAGING）。
    // 不传会让它因"未指定 stagingRoot"跳过，从而**掩盖**真正的嵌套边界原因。
    env: childEnv,
  })
  const { ok, bad } = countChecks(run.text)
  const status = run.error || run.status !== 0 ? 'FAIL' : 'PASS'
  ctx.onEvent?.({ type: 'suite-start', id: suite.id })
  return {
    id: suite.id,
    title: suite.title,
    kind: ctx.kind ?? 'offline',
    status,
    exitCode: run.status,
    spawnError: run.error ? String(run.error.code || run.error.message) : undefined,
    signal: run.signal ?? undefined,
    durationMs: run.durationMs,
    checksOk: ok,
    checksBad: bad,
    verdictLine: verdictLineOf(run.text),
    outputFile: outFile,
    tail: run.text.split(/\r?\n/).filter(Boolean).slice(-25),
  }
}

/**
 * 运行沙箱内审计（结构化 JSON）。
 *
 * 判定规则（重要）：
 *   - 有 fail ⇒ FAIL
 *   - 覆盖度极低且全是 not-run ⇒ SKIPPED-NESTING-LIMIT（机制边界，不算失败也不算通过）
 *   - 否则 PASS
 * 把"跳过"与"通过"分开，是手册第 17 章要求的诚实性：
 *   0% 覆盖的"无 fail"不构成任何保证。
 */
export function runAudit(ctx) {
  const jsonFile = join(ctx.outDir, 'run-audit.json')
  const run = runCaptured(
    process.execPath,
    [join(REPO, 'src', 'cli.mjs'), 'audit', '--workspace', ctx.workspace, '--json'],
    { cwd: REPO, timeout: ctx.timeout ?? 600000, outFile: jsonFile },
  )

  let audit
  const i = run.text.indexOf('{')
  const j = run.text.lastIndexOf('}')
  if (i >= 0 && j > i) {
    try {
      audit = JSON.parse(run.text.slice(i, j + 1))
    } catch {
      audit = undefined
    }
  }

  if (!audit) {
    return {
      id: 'audit',
      title: '沙箱内真实攻击探针',
      kind: 'insandbox',
      status: 'FAIL',
      exitCode: run.status,
      spawnError: run.error ? String(run.error.code || run.error.message) : undefined,
      durationMs: run.durationMs,
      checksOk: 0,
      checksBad: 0,
      verdictLine: 'audit produced no parsable JSON',
      outputFile: jsonFile,
      tail: run.text.split(/\r?\n/).filter(Boolean).slice(-25),
    }
  }

  const s = audit.summary ?? {}
  const nestingLimited =
    audit.verdict === 'inconclusive-no-evidence' ||
    (audit.coverage <= 20 && (s['not-run'] ?? 0) > 0 && (s.fail ?? 0) === 0)
  const status = (s.fail ?? 0) > 0 ? 'FAIL' : nestingLimited ? 'SKIPPED-NESTING-LIMIT' : 'PASS'
  const fails = (audit.findings ?? []).filter((f) => f.status === 'fail')

  return {
    id: 'audit',
    title: '沙箱内真实攻击探针',
    kind: 'insandbox',
    status,
    exitCode: run.status,
    durationMs: run.durationMs,
    checksOk: s.pass ?? 0,
    checksBad: s.fail ?? 0,
    coverage: audit.coverage,
    verdict: audit.verdict,
    residual: s.residual ?? 0,
    notRun: s['not-run'] ?? 0,
    sandboxUsable: audit.sandboxUsable,
    verdictLine: `coverage=${audit.coverage}% verdict=${audit.verdict}`,
    outputFile: jsonFile,
    failDetails: fails.map((f) => ({ id: f.id, detail: String(f.detail).slice(0, 300) })),
  }
}

/**
 * 按手册第 17 章汇总"仍未提供的保证"。
 * 版本出口必须同时给出实际结果**与**仍未提供的保证，不能只报通过。
 */
export function summarise(suites, audit) {
  const checksOk = suites.reduce((n, s) => n + (s.checksOk ?? 0), 0)
  const checksBad = suites.reduce((n, s) => n + (s.checksBad ?? 0), 0)
  const failed = suites.filter((s) => s.status === 'FAIL')
  const skipped = suites.filter((s) => String(s.status).startsWith('SKIPPED'))
  const passed = suites.filter((s) => s.status === 'PASS')

  const overall = failed.length > 0 ? 'FAIL' : audit?.status === 'SKIPPED-NESTING-LIMIT' ? 'PASS-OFFLINE-ONLY' : 'PASS'

  const guaranteesNotProvided = []
  if (audit?.status === 'SKIPPED-NESTING-LIMIT') {
    guaranteesNotProvided.push('沙箱内读/写/删边界的实测证据（当前会话受限，无法嵌套；需未受限会话复跑）')
  }
  // 读取面收敛（R1）：**结构性残余，不随本轮新模块改变**，因此无条件声明；
  // 本次审计量到的残余条数只作为附注追加（不再决定这条声明是否出现 —— 否则会出现
  // "没跑审计 ⇒ 读面看起来收敛了"这种最危险的读法）。
  guaranteesNotProvided.push(
    (audit?.residual ?? 0) > 0
      ? `读取面收敛（R1）未改变：本后端限制写/删但不限制读取，本次审计另有 ${audit.residual} 项残余`
      : '读取面收敛（R1）未改变：本后端限制写/删但不限制读取（读面收敛仍只能靠 AppContainer 或工具层硬拒绝清单）',
  )
  // 网络面：口径必须分两段，不得再沿用"网络硬阻断未提供"这一句笼统话。
  //   (a) 策略/强制层**已经存在**（src/netpolicy.mjs + src/wfp.mjs），OFFLINE 档位是 fail-closed：
  //       前置能力不足一律 `refused`/`not-enforced`，绝不返回 `enforced:true`。这是**离线钉死**的，
  //       但只表示"判定正确"，不表示"网络上真的被挡住了"。
  //   (b) 本机**没有安装任何真实 WFP 过滤器**，真实 BFE 行为 `[未实测]`（安装过滤器是系统级状态
  //       变更，本阶段未获授权）。因此在当前主机上"网络已强制阻断"依旧**不成立**。
  guaranteesNotProvided.push(
    '网络强制（部分补足）：策略/强制层已存在（src/netpolicy.mjs + src/wfp.mjs），OFFLINE 档位 fail-closed —— ' +
      '前置能力不足即 REFUSED，绝不报告 enforced=true；但本机**未安装任何真实 WFP 过滤器**，' +
      '真实引擎行为与端到端阻断均为 [未实测]，因此"网络已强制阻断"在当前主机上仍不成立（残余边界 R2）',
  )
  // 进程缓解策略：代码与离线布局/调用契约测试齐备（tests/mitigations.mjs），但
  // 真实 `UpdateProcThreadAttribute` 上的缓解组合**从未在本机运行期实测**。
  guaranteesNotProvided.push(
    '进程缓解策略运行期实测（[未实测]）：ACG/CIG/禁 Win32k/禁扩展点的位号与调用契约由离线替身钉死，' +
      '但真实子进程是否因此被加固、`untrusted` 档位是否会打断 JIT/Node，均未在本机实测',
  )
  // 暂存配额：有了写前守卫（判定层 + 离线测试），但"真的挡住一次越界写"没有被端到端证明过。
  guaranteesNotProvided.push(
    '暂存配额与输出上限的端到端阻断证据：配额守卫已实现且离线判定为红/绿双档（tests/limits.mjs），' +
      '但尚未证明它能在一次真实写入路径上真正拒绝落盘（未测到"守卫拦住真实写"这一层）',
  )
  guaranteesNotProvided.push(
    '操作系统级一次性隔离（本机为 Server 血统，Containers-DisposableClientVM 不存在）',
  )

  return {
    overall,
    suitesTotal: suites.length,
    suitesPassed: passed.length,
    suitesFailed: failed.length,
    suitesSkipped: skipped.length,
    checksOk,
    checksBad,
    guaranteesNotProvided,
  }
}

/**
 * 运行全部套件。
 * @param {{workspace?:string, outDir?:string, skipAudit?:boolean, only?:string[], timeout?:number, onEvent?:(e:object)=>void}} options
 * @returns {Promise<object>} 报告对象（与 CLI 的 test-report.json 同构）
 */
export async function runAll(options = {}) {
  const workspace = resolve(options.workspace ?? join(REPO, '.t', 'ws'))
  const outDir = resolve(options.outDir ?? join(REPO, '.t'))
  mkdirSync(workspace, { recursive: true })
  mkdirSync(outDir, { recursive: true })

  const wanted = options.only && options.only.length > 0 ? new Set(options.only) : undefined
  const startedAt = Date.now()
  const suites = []

  const selected = (list) => (wanted ? list.filter((s) => wanted.has(s.id)) : list)
  const offline = selected(OFFLINE_SUITES)
  const sandbox = selected(SANDBOX_SUITES)
  const wantAudit = !options.skipAudit && (!wanted || wanted.has('audit'))

  for (const suite of offline) {
    options.onEvent?.({ type: 'suite-begin', id: suite.id, title: suite.title })
    const r = runSuite(suite, { outDir, workspace, kind: 'offline', timeout: options.timeout, onEvent: options.onEvent })
    suites.push(r)
    options.onEvent?.({ type: 'suite-end', id: suite.id, status: r.status })
  }
  for (const suite of sandbox) {
    options.onEvent?.({ type: 'suite-begin', id: suite.id, title: suite.title })
    const r = runSuite(suite, { outDir, workspace, kind: 'insandbox', timeout: options.timeout, onEvent: options.onEvent })
    suites.push(r)
    options.onEvent?.({ type: 'suite-end', id: suite.id, status: r.status })
  }

  let audit
  if (wantAudit) {
    options.onEvent?.({ type: 'suite-begin', id: 'audit', title: '沙箱内真实攻击探针' })
    audit = runAudit({ outDir, workspace, timeout: options.timeout })
    suites.push(audit)
    options.onEvent?.({ type: 'suite-end', id: 'audit', status: audit.status })
  }

  const summary = summarise(suites, audit)
  return {
    tool: 'WinStageSandbox test runner',
    time: new Date().toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    node: process.execPath,
    repo: REPO,
    workspace,
    ...summary,
    suites,
  }
}
