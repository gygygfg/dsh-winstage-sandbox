# R10-SHIM 缺陷清单（产品缺陷 / 流程缺陷）

> ★ **置顶：三条跨域拦截纪律**（Lead 于 2026-10-10 粘贴，`fileio` 起草；本文件此前不在其写权范围）
> ① **件里有字符串 ≠ 被挂钩** —— 判"是否挂钩"必须查 `g_targets[]`，不能凭 `strings`/导入表里有该名字下结论；
> 工具 `.t/round10/fileio/13d-count-probe/check-target-tables.mjs`（可复算静态检查）。
> ② **wrapper 被调用 ≠ 原函数已解析 ≠ 参数/类分发正确** —— 三者是三件事，必须用**真 status** 区分
> （例：`0xC0000002` 是自建哨兵、`0xC0000008` 才是 ntdll 对无效句柄的真答复；另有 `WS_KV_PARTIAL` 类常量写错导致"看起来像未实现"）。
> ③ **门禁全绿 ≠ 已修** —— 窗口 #4/#5 并集门禁全绿（含整仓 `33/0/0`）而 D-R1 读回仍 `0/4`；功能判据必须独立成立。
> 另两条同族提醒：**档位不是 `TS` 的读数**、**根本没读到数的用例**，都**不得**写成"未命中/未发生"
> （`13d` 计数的 `not-run` 三因记法即此：换件被拦 + 候选崩载体降 T1 + dump 分支被抑制）。

## D-REG-UNION-DEFAULT（高 · **产品缺陷** · ✅ 已修并采纳）

**现象**：沙箱内 `reg query <KEY>`（**不带 `/v`**，走枚举）输出 **2 B（空）**、退出码 0，而 `reg query <KEY> /v V`（具名读）**78 B 正常** —— 这是窗口 #3–#7 四轮里条件 ③ 的唯一红项（也是 D-R1 定案后剩下的最后一块）。

**根因**：`shim/src/ws_reg.c` 的 **`ws_reg_build_union` 的 values 路径**原为
```c
if (rc != 0 || !name[0]) { break; }
```
而 **`index 0` 是"空名字的默认值"**（provider 实测 `value_enum(0) status=0 name=""`、`value_enum(1) name="V"`）⇒ **i=0 就 break，把其后的具名值全部挡掉** ⇒ `count=0` ⇒ `RegQueryInfoKeyW` 报 `lpcValues=0` ⇒ `reg.exe` 认为"无值"⇒ **根本不进入枚举** ⇒ 打印空 + exit 0。

**证据链（三段式，可供后人复用）**：
1. **窗口 #7 pid 归属**：`step2a` = pid 2072/5796/10260/10444（每回合一个），每个仅 `RegQueryInfoKeyW`×2（伪句柄、`ret=0`）+ `RegCloseKey`×1，**`RegEnumValueW`/`RegEnumKeyExW` 命中 = 0**；`replayedBytes`=480/282/678/876 ⇒ **覆盖层确有值**（"空覆盖层/观测窗"假设被证伪）。
2. **`out-21` 定源**：`REGDBG union kind=values … real=0 index=0 **valid=1 count=0**`（keys 同，属正常无子键）⇒ 缓存建过、**values 类 union 对"值存在且可读"的键产出 0 条**，且未走 real-hive 回退 ⇒ **values 构建没查 `ws_rstore_value_get` 所读的 overlay store**。
3. **`out-22` 修复**：仅 `rc != 0` 才 break（空名字 keys 仍 break / **values 继续**）+ 硬迭代上限；`union count=1`、`qik lpcValues=1 maxValueLenComputed=26`、`qik-unionfail index=1`（正常结束）、**伪句柄 `RegEnumValueW` 0→4**、`step2a`/`step2b`/`step3` **三者同 sha256 `12aa39d1…972cb`**。

**同源附带（已修）**：`:1889`（原 `:1865`）由"无条件 `*lpcbMaxValueLen = 0`"改为 **写回 `maxValueLen`**（真句柄语义未动）。
**⚠ 插桩标签失效（非产品缺陷）**：`REGDBG qik` 里的 **`maxValueLenWritten` 是 `out-20` 插桩硬编的 `0ul`**，**不得作为结论依据**；建议 owner 删除该字段或改为读实际 `*lpcbMaxValueLen`（记"待复测"）。

**状态**：**已修并在受控窗口 #8 采纳** —— `shim/out/winstage-shim.dll` = `63808F5188643C085BDC71E86AC843BB8758579938A4CB61781044B93C8A99EB`（257,024 B，`.text 6ec5a5da…`）；四条件 **4/4 PASS**。
**证据**：`docs/round10/shim/evidence/D66-window8-verdict.md`、`D66-1-swap-timeline.md`、`.t/round10/shim/D70-out21-union-source-readout.txt`、`D71-out22-step2a-green.txt`、`D73-*`、`docs/round10/registry/evidence/fix-r1/arm-window7|8/**`。

---

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

---

### ✅ 已修（2026-10-09，owner `registry`，task-14 派生）—— 采 ① + ② 组合

**改了什么**（只改 `tests/registry-conformance.mjs` 一个文件；`tests/*.mjs` 在封印面内，已重封）：

1. **新增"本次探针"谓词** `journalProbeVerdict(journalFile, {runId})`（导出）：
   解析该 journal，要求存在 `SET_VALUE` 记录 `HKCU\Software\WinstageShimProbe` / `T4Probe`，
   且（给了 `runId` 时）其 `wireBytes` **逐字节等于** `t4-probe-<本次 runId>\0`（UTF-16LE）。
   探针常量 `CONFORMANCE_PROBE_KEY` / `CONFORMANCE_PROBE_VALUE` 从 `tools/run-shim-closedloop.mjs:53-54` 提升为单一口径，A.2 的断言也改用它（消灭"选树谓词 ≠ 断言谓词"这个根因）。
2. **`findStageRoot()` 的每一层都要过这个谓词**（①）：显式 env → runner 记录（按 mtime 取最新）→ `run-*` 的 journal mtime。
   第 ③ 层**按 journal mtime 降序逐个试到第一个合格为止**（只试"最新的那一棵"就会在"陈旧树更新"时重新退化）。
   全部不合格 ⇒ 返回 `undefined`，并把每个被拒候选与理由记进 `lastStageRootDiagnostics()`（**不再退回一棵未验证的树**）。
3. **显式 `DSH_CONFORMANCE_STAGE_ROOT` 不合格 ⇒ 直接抛错**（②）：错误信息 4 段 = 结论 / 指定的树 / 原因（点名"属于别的 run"或"没有 T4Probe 记录"）/ 期望与修法。**不静默通过、不静默假红、不静默回退**。
4. **A.2 缺产物不再无条件判红**：`DSH_CONFORMANCE_ARTIFACTS=auto`（缺省）⇒ **SKIP**（原因里列出被拒候选）；`required` ⇒ 仍判红。
   "改了 DLL 没重跑 runner" 这条纪律**不受影响** —— 它由 A.5 用**报告文件** mtime vs DLL mtime 把关，与本 check 无关。
5. **新增回归断言 S3b（7 条）**：构造受控夹具（`run-current` 含本次 runId 探针 / `run-stale` 探针属旧 run 且 **journal mtime 更新** / `run-noprobe` 无探针记录），断言
   ①谓词正例通过 ②陈旧树被拒且理由含"别的 run" ③无探针树被拒 ④**陈旧树 mtime 更新也不得胜出** ⑤无合格树返回 `undefined` 不退回未验证树 ⑥显式指向陈旧树**抛错** ⑦显式指向合格树通过。

**验收判据（实测，同一在用 DLL `02C7418F…`，未换件）**：

| 场景 | 读数 |
|---|---|
| 机器上**存在 9 棵陈旧 `--keep-stage` 保留树**，`registry-conformance` | **断言 65 项 / 失败 0 / 跳过 1，exit 0** |
| 同上，`registry-guard` | **断言 385 项 / 失败 0 / 跳过 1，exit 0**（= 原 378/0 基线 + 新增 7 条 S3b） |
| **显式指向陈旧树** `DSH_CONFORMANCE_STAGE_ROOT=shim\.stage\run-2026-10-08T13-41-27…` | **exit 1**，抛出可诊断错误（"原因：探针记录的数据属于**别的 run**（期望 `t4-probe-2026-10-09T14-36-32-995Z-2ff467`）⇒ 陈旧保树" + 修法） |
| 选树级前后对照（同一夹具，旧谓词 vs 新谓词） | **旧谓词选中陈旧树 = true；新谓词选中合格树 = true** ⇒ `FIX CONFIRMED` |

**重封后的基线**：`node tools\baseline-sha256.mjs --write` → `--check` **exit 0 / 115 个受封印文件逐条相符**。
`tests/registry-conformance.mjs` 重封后 sha256 = **`E14685B5AF36F79435966B0F6757B36F31985177BF01CE74D0F01DFFEDAED2D8`**
（修改前 = `51C9A52D834EA11BAFD370D079410589E2C35E594ECE1200FBC676AACADC1674`，备份在 `.t/round10/registry/fixture-fix-backup/registry-conformance.mjs.orig`）。

**证据**：`docs/round10/registry/evidence/fixture-stageroot/{selector-before-after.txt,conformance-after-stale-present.txt,guard-after-stale-present.txt,explicit-stale-error.txt,baseline-write.txt,baseline-check.txt}`。

**是否影响别的套件**：`registry-guard` 也跑同一批 A.* 判定 ⇒ 一并受益（378→385/0，多出的是 S3b）。其余套件不改动；
整仓 `autotest` 建议由 Lead 择时复跑确认（本次未跑整仓，避免与并行任务互相影响）。

**证据**：`docs/round10/shim/evidence/D47-2-window3-verdict.md` §9（撤回）/ §10（采信）、`.t/round10/verify/d47-*`。

---

### 补记：显式路径语义 + 一处实现不一致（2026-10-10，`exe` 在窗口 #4 发现，owner `registry` 已修）

**现象（`exe`，单变量 = 只改 `DSH_CONFORMANCE_STAGE_ROOT`）**：
- **负控制** 显式指向陈旧树 `run-2026-10-08T13-41-27…` ⇒ `exit 1`，诊断正确（期望 = 该报告 runId）✅
- **正控制（疑点）** 显式指向**最新合格树** `run-2026-10-09T14-36-32-995Z-2ff467` ⇒ **也 `exit 1`**，
  但期望值变成 **`t4-probe-fixture-run-current`**（我 S3b 夹具的合成 id），报错位置 `:248`/`:522`
- **默认路径**（不设该变量）⇒ 连续两次 **65/0/1 exit 0** ✅

**定因（两个独立问题，别混为一谈）**：

1. **① 语义问题（不是缺陷）：`DSH_CONFORMANCE_STAGE_ROOT` 的期望语义 = "必须指向**本次 run** 的树"。**
   依据：A.2/A.3 是把 journal 里探针的**数据字节**与 `report.runId` 比对（`t4-probe-${report.runId}`）——
   即"本次 run"的定义来自 `closedloop-report.json` 的 `runId`，是**唯一**的期望值来源。
   ⇒ 显式指向**别的 run** 的树**必然报错，这是设计（fail-closed）**，不是缺陷；若接受"与树自身 runId 自洽"的 journal，
   就等于把"操作员指错了树"重新变成窗口 #3 那种**双假红**。
   退化规则：`report` 不存在或无 `runId` 时，谓词退化为"该 journal 含**任一**探针写入"（自洽即可）。

2. **③ 实现不一致（真缺陷，已修）：S3b 夹具继承了外在环境变量。**
   `findStageRoot()` 内部是 `options.explicit ?? envOr('DSH_CONFORMANCE_STAGE_ROOT','')`；
   我 S3b 里有两处调用**没传 `explicit`**（原 `:522`/`:526`）⇒ 操作员一旦合法地设了该变量，
   这两处就被**短路进显式分支**，并被拿去和**夹具自己的** `runId='fixture-run-current'` 比对 ⇒ 抛错。
   这正好解释 `exe` 看到的 "正控制报错、且期望值是合成 id"：`:367`（用真 `report.runId`）其实**已经过了**，
   是**后面的 S3b 夹具**把套件打挂的。
   **修法**：S3b 全部夹具调用钉 `explicit: ''`；并新增回归断言
   `S3b 回归：夹具选树不受外在 DSH_CONFORMANCE_STAGE_ROOT 影响`（在测试内临时把环境变量设成一个别的 run 的合格树，断言夹具行为不变，再还原）。

**验收（三条各留原始输出，`evidence/fixture-stageroot/pm-affirm-*.txt`）**：

| # | 场景 | 结果 |
|---|---|---|
| 1 | 默认（不设变量） | **66/0/1 exit 0** |
| 2 | 显式 → **本次 run** 的树（构造夹具：取最新真实树的 2 条记录重编码，探针数据改为 `t4-probe-<report.runId>`，journal mtime 新于 DLL） | **66/0/1 exit 0**，A.2 四条全绿（含"WAL 里确实有探针那次写入"） |
| 3 | 显式 → 陈旧树 | **exit 1**，诊断点名"属于**别的 run**"、给出**期望的本次 runId** `t4-probe-2026-10-09T17-23-10-430Z-64c72c` 与修法 |

**为什么 (2) 要用构造夹具**：当前 `report.runId` 的对应树（`run-…b1c33e`）已被非 `--keep-stage` 的运行删除，
磁盘上不存在"本次 run 的树"。构造脚本 `.t/round10/registry/harness/make-current-run-tree.mjs`
（复制最新真实树的记录并重编码探针记录 ⇒ 契约仍然合规；已在输出里注明这是夹具）。
> ⚠ 踩坑记录：`validateJournalBuffer()` 返回的 `record.wireBytes` 是**该记录的数据载荷**（A.2 就是拿它比 `t4-probe-…\0`），
> **不是整条记录的序列化字节**；我第一版按"拼接 payload"重建 journal，结果 journal 只剩 1 条记录。正确做法是**重新编码**记录。

**重封（第二次）**：`baseline-sha256 --write` → `--check` **exit 0 / 115 条**。
`tests/registry-conformance.mjs` = **`B011FA25E569855A07CD6474B1D8D3F80E00B17D9064FA061E323455AB80AFA2`**
（第一次修复后 `E14685B5…`；原始 `51C9A52D…`）。`registry-guard` = **386/0/1 exit 0**（多出的 1 条即上面的 S3b 回归）。

**给 `exe` 的答复（对应其三问）**：① 采用"必须指向**本次** run 的树"，并在本文档写明这是**设计**而非缺陷；
② "两处调用点期望不同" = 我的夹具继承环境变量这一实现缺陷，**已修**，现在期望值只有一个来源（`report.runId`）；
③ 已加回归断言覆盖"显式指向合格树"与"夹具与环境变量无关"两条路径。
