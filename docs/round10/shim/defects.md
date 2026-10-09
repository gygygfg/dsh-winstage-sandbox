# R10-SHIM 缺陷清单（产品缺陷 / 流程缺陷）

> 生成 2026-10-08 · teammate `env-harness`（task-10）
> 分类口径：**产品缺陷** = 被测系统（shim/执行器/审批面）的行为问题；
> **流程/环境缺陷** = 会让判定失真或被误读的问题（测试夹具、证据链、防护软件等）。
> 每条都带最小复现与原始证据路径；本域**未改**任何 `shim/src`，未重建 `shim/out` DLL。

---

## D-SHIM-1【产品·未修】注入后的 PowerShell 载体在 AMSI 初始化处崩溃（实测 20%）

**现象**：注入成功后，`powershell.exe` 载体**在运行脚本之前**崩溃：
成功标记不出现、真实盘未被写；退出码 `0xc0000005`（访问冲突）或 `0xe0434352`（CLR 异常）。
某些情况下注入器 30 s 超时 ⇒ 上报 `exit=null`。

**最小复现**

```cmd
cd C:\Users\Administrator\Desktop\dsh-winstage-sandbox
node tools\carrier-flake.mjs 30
```

实测（`docs/round10/shim/evidence/D1-carrier-flake-30.txt`）：**24 成功 / 6 失败（20%）**，
失败运行里 shim 日志统一出现 `STUCK waiting on lock hook`（6 次）。

**根因**（逐字原始输出 `evidence/D4-ps-amsi-crash-excerpt.txt`）：

```
System.TypeInitializationException: “System.Management.Automation.AmsiUtils”的类型初始值设定项引发异常。
  ---> System.AccessViolationException
   在 System.Management.Automation.AmsiUtils.AmsiNativeMethods.AmsiInitialize(String appName, IntPtr& amsiContext)
   在 System.Management.Automation.AmsiUtils.Init() / CheckAmsiInit() / ..cctor()
   在 System.Management.Automation.Runspaces.EarlyStartup.<>c.<Init>b__0_1()
```

⇒ 注入后 `amsi.dll` / `AmsiInitialize` 的初始化被破坏（且与 shim 锁钩子的 `STUCK` 同现）。

**状态更新（三轮尝试后仍未收敛，且已证明与覆盖缺陷同源）**：
* task-11（定因）：注入 28/100 vs 不注入 0/40，死亡点在 `g_orig.CreateFileW` 内/紧后；
* task-11b（改"只补刚加载模块"）：`carrier-flake 100` **0/100**，但被独立复核（task-9 §8）判定为
  **真实回归** —— 经 `LdrLoadDll` 载入的模块不再被补丁，`urlmon!URLDownloadToFileW` 直接写宿主真实盘
  （167 B / `B1656831…3396`）。Lead 已回滚 DLL。
* task-11c（增量收敛：只补"尚未登记补丁"的模块）：**Gate 1 通过**（两条 mode 真实盘均无写），
  但 **Gate 2 不过且更差**：`carrier-flake 100 = 70/100`（同会话旧 DLL 对照 40 次 = 50%），`STUCK` 108。
  ⇒ 按硬门禁**不替换**，保持旧 DLL。
* **结论（残余边界 R）**：崩溃与覆盖由**同一份工作**耦合 —— 补丁"我们没看到的迟到模块"既提供
  顺带覆盖、又制造崩溃；仅靠改触发点无法兼得。两条实测端点：旧 DLL = 有覆盖 + 20–50% 崩；
  task-11b = 0% 崩 + 静默真实盘越界写。落地路径（钩 `LdrLoadDll`；未补丁模块显式降级/告警；
  `LdrLockLoaderLock` 串行化后请回全量重扫）见 `报告.md` §2.6.6。

**影响面**（三处看起来无关的红都由它解释）：
`delete-capture` 的 `whiteout:V3-inside` / `write-staged:R1-ps`；`registry-guard` 的
`E8.carrier-powershell`；`file-cow` 的 `ps-*` 载体稳定性。

**建议真修（未实施，需 Lead 许可重建 DLL）**：
① 把 `amsi.dll` 及其依赖从覆盖层/重定向面排除（AMSI 属于安全子系统，不该被 CoW/映射）；
② 或把钩子安装推迟到 CLR/AMSI 初始化完成之后（当前是注入即挂钩 ⇒ 与 `AmsiUtils..cctor()`
   的初始化竞争）；③ 顺带查 `STUCK waiting on lock hook`（锁钩子自旋/死锁，
   与崩溃同现，见 `D1-carrier-flake-30.txt` 的 `STUCK` 行）。

**判定侧的处置**（已做，不掩盖）：
* `tools/run-shim-closedloop.mjs` 的 `E8.carrier-*` 有界重试 3 次，逐次尝试进
  `evidence.carriers[].attemptDetail` / `evidence.carrierFlakes`；**全败仍红**。
* `tests/delete-capture.mjs` 把 AMSI 崩溃签名并入既有 SKIP 纪律（守卫不变：
  真实盘被改 / 成功标记出现 ⇒ 仍然 FAIL）。

---

## D-DEFENDER-1【环境/流程·已由 Lead 修】Defender 反复隔离 `winstage-inject.exe`

**现象**：`shim/out/winstage-inject.exe` 被当木马隔离 ⇒ 注入器缺失 ⇒ `tier=T1`/`enforcement=partial`
降级、所有注入类套件以 `exit=null` 或"载荷没跑"的形态变红；`tools/carrier-flake.mjs` 直接
`ENVIRONMENT UNAVAILABLE`（exit 2）。

**证据** `evidence/D0-defender-quarantine.txt`：`Get-MpThreatDetection`
`2026/10/8 22:31:10` 与 `22:31:25`，资源 `…\shim\out\winstage-inject.exe`；
事件 1116/1117 `Trojan:Win32/…`；历史同形 **10-03 / 10-04 / 10-05 / 10-06**（旧根）。

**根因**：仓库根迁移时**没有迁移 Defender 排除项** —— 旧根 `…\Desktop\WinStageSandbox`
的排除项成了死条目，于是每次重建/复制注入器都会被重新隔离。

**Lead 修复**（`evidence/D0b-defender-exclusion-and-restore.txt`）：
`ExclusionPath` 加入新根 + `%LOCALAPPDATA%\Temp\winstage-stage`，`ExclusionProcess` 加
`winstage-inject.exe`（**未关**实时防护）；从归档恢复注入器，sha256
`07FE55DD386D489B93FA2FCFF55DB152304BD9FD4E857A5CDECF152B77CE518F`（159,232 B）。
**复核**：`node tools/carrier-flake.mjs 30` / closed-loop 跑通，三个载体都能起来。

**残余风险**：排除项是**机器级**状态，不进仓库。任何新机器/新根都要重做这一步，
否则本缺陷会以"莫名其妙的 `exit=null`"复发。建议把该步骤写进 `PUBLISHING.md`/自检脚本。

---

## D-COUPLE-1【流程·半修】证据记录陈旧优先级让 A.5 与 A.2/A.3 互相矛盾

**现象**：按 A.5 的要求重跑 `tools/run-shim-closedloop.mjs` 之后，`registry-guard` 反而多出两条红：

```
✗ A.2 记录里的数据字节 = 探针写入的 UTF-16LE 内容
     expected=t4-probe-<新 runId>   got=<上一轮 runId 13-41-27-554Z-f591d3 的字节>
✗ A.3 完整 apply 后真实 hive 只出现这一个值，且数据逐字节一致
```

**机制**：runner 默认**删除**自己的暂存树，且**只有非 `--keep-stage` 分支**才写
`closedloop-evidence-latest.json` ⇒ 重跑后该文件仍是上一轮的、指向的旧 `run-*` 的 journal 还在；
`findStageRoot()` 旧逻辑固定先读 evidence-latest ⇒ 取旧 WAL 比新 `report.runId`。
（`tests/registry-conformance.mjs:170-203`）

**已修的半**：`findStageRoot()` 改为**按 mtime 取最新记录**，再按"声明的 stageRoot 下真的有 journal"筛选；
操作侧用 `--keep-stage` 让报告与 WAL 同源 ⇒ `registry-guard` 378/0/1 全绿。
**未修的根**：runner 默认删树的语义没变。建议 runner 在删树前把 `registry/overlay.journal`
复制到 `shim/out`（或在报告里内联 WAL 字节），让 A.2/A.3 不再依赖"暂存树是否还活着"。

---

## D-GAP-1【产品·如实保留】`cmd.exe` 的 `if exist` 不认暂存文件

**现象/最小复现**：注入后的同一个 cmd 进程里，`type <staged file>` 能读到覆盖层内容，
而 `if exist <staged file>` 判"不存在"（输出 `CANARY-MISSING`）。

**证据**：`evidence/D9b-file-cow.txt` 的 `KNOWN GAPS` 段（`GAP c6cmd-canary`）。

**判定**：这是**产品缺口**（`cmd` 的存在性检查走的不是 `GetFileAttributesW/ExW`，
shim 少覆盖一个 API 面）。真修需要 `shim/src` + 重建 DLL ⇒ 本轮**不修、不抹**：
`--strict-gaps` 下仍会把它计成失败（`knowngaps` 的 strict 分支未改）。

---

## D-REVIEW-1【流程/可用性】auto-review 按 **prompt 内容** 拒绝启动嵌套沙箱线程

**现象**：`docs/round10/sensitive/evidence/threads/launch-run2.cmd`（以及 4 种等价写法）被
`Auto review rejected tool "pwsh"` 拒绝；Lead 代跑、我代跑（`env-harness`）同样被拒。

**单变量判定**（本域实测，同一 `sbx-thread.cmd`、同一 ws、同一 out 根，只换 prompt）：

| 试验 | 命令形态 | prompt 内容 | 结果 |
|---|---|---|---|
| C1 | `cmd /c docs\round10\sensitive\…\launch-run2.cmd` | 敏感（脚本内 prompt-2.txt） | **拒绝** |
| C2 | `cmd /c docs\round10\env\scripts\sbx-thread.cmd <中性路径>` | 中性（"create hi.txt"） | **通过**，exit 0，session `session-7b4328d4-…` |
| C3 | 与 C2 **逐字相同**，仅 prompt 文件换成敏感 prompt 的副本 | 敏感 | **拒绝** |
| C4 | 与 C2 相同，prompt 文件名含 `sensitive`、内容中性 | 中性 | **通过**（⇒ 命令文本里的 `sensitive` 字样不是触发条件） |

⇒ 触发条件是**被引用 prompt 的内容**（其中 STEP 4 要求读
`C:\Users\Administrator\.dsh\.credentials.yaml`），**不是命令形态**。

**判定**：这不是"命令被拦"，而是**策略在按内容工作**（要求 agent 去读凭据文件的 prompt
被拦下，从安全角度看是合理的）。但对本项目是**可用性/可发现性**问题：
sensitive 域的测试**目的恰恰是验证沙箱挡住了对凭据的访问**，却因此无法通过评审通道启动，
而且报错只有一句 `Auto review rejected tool "pwsh"`，**不说明触发词**，排查成本高。

**建议**（不绕评审）：①这类"验证凭据访问被挡"的用例改由**人工在终端**运行 launcher
（把原始输出落盘即可），或走显式人工审批；②把"内容触发"这一事实写进交接单/配方，
避免每个域各撞一次；③若产品希望支持这类安全验证，需要一个显式的、可审计的
"安全验证模式"开关，而不是让 prompt 措辞去规避评审。

---

## D-LANE-1【流程/方法学·已固化】"暂存面在工作"不等于"沙箱按 TS 档在工作"

**现象**（reviewer `exe`（task-9）先实测；本域复现并固化）：把 `WINSTAGE_SHIM_INJECTOR`
指向不存在的路径（= Defender 隔离掉注入器之后的形态）后：

| 判据 | 结果 |
|---|---|
| `stderr.txt` 为空 | ✅ 0 B（**假绿**） |
| `staged\hi.txt` 存在 + `candidates\*.json` 存在 | ✅（**假绿**） |
| 真实 workspace 只有 seed | ✅（**假绿**） |
| 同 run `sandbox-lane.json` | ❌ `tierEffective=T1 / degraded=true / fallbackClass=artifact-missing / shimCount=0` |

**机制**：`WINSTAGE_SHIM_INJECTOR` 只影响透明 shim（TS 档）的可用性
（`src/executor.mjs:4805` 的 `injectorPath`）；shim 不可用时执行器 **fail-closed 回退
restricted-token（T1）**，而**暂存面（暂存树/候选）照常工作** ⇒ 三条"暂存面"判据全绿，
却完全不能推出"命令走 TS 档"。

**已做**：`docs/round10/env/00-启动配方.md` §0 把判据从三条升为**四条致命判据**
（第 4 条 = `LANE_OK`：`degraded===false && tierEffective==='TS'`）；
`docs/round10/env/scripts/sbx-extract.mjs` 抽取 `<outDir>\lane.txt` 并在汇总行打印 `lane_ok=`；
§5.7 记录假绿反例；正/负例证据 `docs/round10/env/evidence/lane-positive/`、`lane-negative/`。

**为什么值得单独记**：这是本轮最有价值的**方法学**发现 —— 判"沙箱生效"必须分别取
两条独立证据（暂存面清单 + lane 档位），任何"单面判据"都可能给出假绿。

---

## 附：本轮修掉的**夹具缺陷**（非产品缺陷，记录以免被读成产品问题）

| 编号 | 位置 | 夹具错在哪 | 判定依据 |
|---|---|---|---|
| F-B4 | `tests/boundary-degraded-failclosed.mjs` | 用**只读**探针 `cmd /c echo …` 断言"污染态必须拒绝"；而 BUG-4 明确豁免正向只读命令 | `evidence/D2-b4-repro.txt`：write/indeterminate 被拒，read-only 放行并记账 |
| F-ACL | `tests/executor-stub.mjs` | 在 `err.message` 里找 `OpenProcessToken`；契约把诊断放 `.detail`/`.steps` | `stageGrantError` 注释 + `err.code==='STAGE_GRANT_FAILED'` 实测 |
| F-C4D | `tests/file-cow-dispositions.mjs` | 前提"目录打不开"不成立：未注入主机同样 `openOk=true`（libuv BACKUP_SEMANTICS） | `evidence/D10-c4d-uninjected-control.txt` 两侧对照 |
| F-STAGE | `tests/registry-conformance.mjs` | 记录文件固定先读 evidence-latest ⇒ 陈旧优先 | 见 D-COUPLE-1 |

---

## D-FIXTURE-STAGEROOT（中 · 测试夹具假红，2026-10-09 新增）

**现象**：`registry-guard` / `registry-conformance` 在**任何** DLL 上各报 2 条红：
`✗ A.2 记录里的数据字节 = 探针写入的 UTF-16LE 内容`、`✗ A.3 完整 apply 后真实 hive 只出现这一个值且数据逐字节一致`；
连带整仓 `autotest` 假红为 `32 通过 / 1 失败 · 2067 ok / 2 bad`。

**机制**：`tests/registry-conformance.mjs:170` 的 `findStageRoot()` 按 mtime 选记录，**只要求该 `stageRoot` 下真的有 journal**，
未要求"该 journal 含本次探针写入/属本次运行" ⇒ 旧的 `--keep-stage` 保留树稳定胜出，套件永远读那份不含探针写入的 WAL。

**单变量实测（`exe`，在用 DLL 全程 `02C7418F…` 未换件）**：闭环带 `--keep-stage` 重跑使最新记录指向本次
`run-2026-10-09T14-36-32…` 后 ⇒ `registry-conformance 58/0 bad`、`registry-guard exit 0 (378/0)`、
整仓 `autotest exit 0 · PASS 33/0/0 · 2069 ok/0 bad`。⇒ **冻结基线确为 33/0，旧读数是夹具假红**。

**修法候选**：① `findStageRoot()` 拒绝不含本次探针写入的树；② 强制显式 `DSH_CONFORMANCE_STAGE_ROOT`；
③ 闭环默认 `--keep-stage` 并保留其 WAL。**在修好前，任何窗口/门禁都必须先做一次带 `--keep-stage` 的闭环重跑**，
否则会在任何 DLL 上误报 2 条红（本轮已实际误导过一次，`D47-2 §9`→§10 撤回）。

**证据**：`docs/round10/shim/evidence/D47-2-window3-verdict.md` §9（撤回）/ §10（采信）、`.t/round10/verify/d47-*`。
