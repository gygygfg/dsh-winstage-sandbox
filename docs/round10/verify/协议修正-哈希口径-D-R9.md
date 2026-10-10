# 协议修正 · 哈希/代码身份口径（D-R9 落地）+ 配套夹具纪律

> **已落地到 `docs/round10/env/00-启动配方.md`**（2026-10-10，`exe` 执行；**三次编辑**）：
> **① 首次落地**（新增第 5、6 条硬门禁 + 五条 ⚠）后该文件 sha256 `2cf97fd5…1350`（19,639 B）；
> **② 第二次编辑**（依我同日实测把 `D-FIXTURE-STAGEROOT` 的前置条件从"必须先 `--keep-stage`"改为**"可选"**）后
> sha256 `bebd86dd…1b3`（20,437 B）；
> **③ 第三次编辑**（2026-10-10 窗口 #4 定案：新增"**换件前必须 `tasklist /m winstage-shim.dll` 确认无残留载体**"
> ⚠，起因 = 窗口 #4 首次 `copy` 被残留 `powershell.exe`(PID 8736) 占用而失败、未落盘）后
> 该文件 **sha256 `ae09e7dffa58e1472b33392a6ccb64ad222ba337d1aaefdb6dea6f03b158f0fb`（21,156 B）** ← **当前值**。
> 落地前原件已备份 `.t/round10/verify/backup-00-启动配方-20261010-003525.md`（sha256
> `cdf2afd4baac86214e5d6bf398d9841784d5a6e52ecddfe585d1e287aa33f499`，16,865 B）；第二次编辑前备份
> `.t/round10/verify/backup-00-启动配方-20261010-012911.md`（sha256 `bebd86dd…1b3`）。
> 落地位置 = 该文档"最小机器判据（四条）"之后，**开窗前硬门禁处新增第 5、6 条**，并附六条 ⚠（跨构建哈希禁止断言 /
> `mtime`+显式清单 / **脚本退出码 ≠ 内部判据** / `D-FIXTURE-STAGEROOT`（**已降级为可选**，见 §6） / **两类坏件对照不得混用** /
> **换件前查残留载体**）。

> 作者：`exe`（独立复核者）· 依据：D-R9 定因（我独立复核于 `docs/round10/verify/evidence/D-R9-nonreproducible-analysis.md`）。
> **说明**：本文件为成稿；§1–§5 已按上述由 `exe` 落地进配方文档（跨域写入已获 Lead 授权、且已在无并发编辑时执行）。

## 1. 事实（已被独立复核）

同一份源码、同一 toolchain、连续两次构建：**三个产物哈希全部不同**（`out-repro1` vs `out-repro2`）。但**代码段逐字节相同**：

| 产物 | `.text` | 差异位置 |
|---|---|---|
| `winstage-shim.dll` | 204,288 B **相同** | COFF `TimeDateStamp`(相差 5 s) + `.buildid`(512 B 中 9 B，`RSDS` PDB GUID/age) + `.rdata`(39,936 B 中 **4 B** = zig 临时名 `winstage-shim.dll.tmp-<epoch-ms>`) |
| `winstage-inject.exe` | 130,560 B **相同** | 仅 `.buildid` + 时间戳 |
| `winstage-probe.exe` | 145,408 B **相同** | 仅 `.buildid` + 时间戳 |

⇒ **代码可复现；不可复现的是构建期元数据。**

## 2. 三类断言必须用三种判据（协议条文）

| 要断言的东西 | **唯一允许的判据** | 禁止的做法 |
|---|---|---|
| "**我测的就是这一件文件**"（同一文件、两个时刻） | **整件 sha256**（前后各取一次） | — |
| "**两个候选来自同一份代码**"（跨构建） | **`.text` 分段摘要**（工具 `.t/round10/verify/tools/pe-section-diff.mjs`） | ❌ 用整件哈希相等推断同源 |
| "**这次构建没有变**"（跨构建整件相等） | **不存在**——不要断言 | ❌ 任何"重建后哈希应等于 X" |

## 3. 开窗流程中的硬门禁（新增第 4 条，与原 4 条并列）

原配方 §0 的四条致命判据（lane/降级等）不变，另加：

5. **防整件交付漂移**：开窗**前**对候选做**在盘整件 sha256**，必须等于 `registry`/`env-harness` 交付声明中的值；不等 ⇒ 判"窗口内未取得有效读数"或直接不换件。
6. **记录代码身份（不作 pass/fail）**：同一时刻记录候选的 `.text` 摘要，写进窗口证据；它的用途是"事后回答这是不是同一份代码"，**不是**门禁阈值（新候选源码必然变，硬性相等会永远红）。
   唯一可作硬门禁的形态：**交付声明的 `.text` == 窗口实测的 `.text`**（防**代码**漂移）。

## 4. 新鲜度/血统检查的写法

- ❌ 不得写"哈希相同 ⇒ 同源/未变"。
- ✅ 一律改为 **mtime + 显式清单**（例如 A.2/A.5 那类"WAL/报告必须比当前 DLL 新"）。
- 若确需"同代码"校验，用 §2 的 `.text` 摘要。

## 5. 可选（低优先、非阻塞）：让整件字节可复现

需规范化 ① COFF `TimeDateStamp` ② `.buildid` 的 `RSDS` GUID/age ③ `.rdata` 里的 zig 临时文件名。
**具体编译/链接开关 `not-run`（未验证，不猜）**；且**不阻塞任何结论**——按 §2/§3 已足够。

## 6. 配套纪律（`D-FIXTURE-STAGEROOT`，2026-10-09 窗口 #3 暴露 → **2026-10-10 已修，前置条件降级**）

**旧行为（已消除）**：`tests/registry-conformance.mjs` 的 `findStageRoot()` 会**回退到旧的保留暂存树**（其 journal 不含本次探针写入）⇒ 在**任何 DLL** 上假红 `A.2 记录里的数据字节` / `A.3 真实 hive 数据逐字节一致`。

**修法（`registry`，2026-10-10）**：新增 `journalProbeVerdict(journal,{runId})` —— 要求 journal 含 `HKCU\Software\WinstageShimProbe\T4Probe` 且数据**逐字节 = `t4-probe-<该树的 runId>`**；`findStageRoot()` 每层都过此谓词、按 journal `mtime` **降序试到合格为止**；显式 `DSH_CONFORMANCE_STAGE_ROOT` 不合格 ⇒ **直接抛错 + 4 段诊断**（不静默通过 / 不静默假红 / 不静默回退）。文件 `tests/registry-conformance.mjs` = `E14685B5AF36F79435966B0F6757B36F31985177BF01CE74D0F01DFFEDAED2D8` / 54,607 B（我实测核对一致）。

**复核者独立实测（`exe`，2026-10-10；在用 DLL `02C7418F…` mtime 16:37:26；**不跑**闭环、**不带** `--keep-stage`）**：
- 机器上存在 9 棵陈旧 `--keep-stage` 保留树的前提下：`registry-conformance` **65/0 bad/1 skip exit 0**、`registry-guard` **385/0 bad/1 skip exit 0**（58/378 → 65/385，新增 **S3b 7 条**回归断言）；
- 整仓 `autotest --skip-audit` = **exit 0 / PASS / 33 通过 0 失败 0 跳过 / 断言 2076 ok 0 bad**（2069 → 2076 = +7）。

⇒ **"开窗前必须先 `--keep-stage` 重跑闭环"这条前置条件，已由实测降级为"可选"**（新谓词会拒绝陈旧树）。仍保留的例外：当套件报 **"无合格 journal"** 或 **A.2 新鲜度红**（全新机器、或刚换 DLL 而没有任何比它新的 WAL）时，跑一次 `node tools\run-shim-closedloop.mjs --keep-stage` 即可。该结论已同步写进 `docs/round10/env/00-启动配方.md`（开窗前硬门禁段）。

- 判据纪律同样适用于**退出码**：**脚本外层退出码 ≠ 内部步骤判据**（窗口 #3 的 `r1-repro.cmd` 的 `EXIT=0` 曾是"值读不回"的假绿；真判据是 `query-value-exit`）。

## 7. 复核纪律：离线 harness 的 `g_orig` 桩层必须覆盖被测 API（2026-10-10，源自 `registry` 的 D-R11 假阳性）

**规则**：若离线 harness 用**桩层替身**承载 `g_orig.*`，则**任何未被桩层覆盖的 API 都会返回 NULL/失败**，从而产生**假阳性或假阴性**读数。**这种读数记 `not-run`，不得作结论。**

**实例**：`registry` 的离线 harness 只填了 8 个 `g_orig.Reg*`，**漏了 `RegEnumValueW`/`RegQueryInfoKeyW`** ⇒ `g_orig.RegEnumValueW == NULL` ⇒ 报出 `value_enum status=1` 的**假阳性 `D-R11`**（"provider 枚举缺陷"），一度进入 Lead 的采纳清单；后由其自检撤回。
**我独立复跑同一工具确认撤回**（`.t/round10/verify/d58-dr11-diagseed.txt`）：
```text
value_get(V)  status=0 bytes=26
value_enum(0) status=0 name=""      <- 默认空名项
value_enum(1) status=0 name="V"     <- 探针值正常枚举
value_enum(2) status=1              <- 结束
RESULT diagseed value_get=0
```
⇒ provider 的 get/enum **一致**，`D-R11` 不存在，`ws_regstore.c` 无需补丁。

**复核者三步检查（采信任何离线 harness 读数前必做）**：
1. harness **覆盖了哪些** `g_orig.*`？（读源码，不读自述）
2. 被测路径**实际会调用哪些** API？（含间接：`reg.exe /v` 先 `RegQueryInfoKeyW`；`reg query` 走 `RegEnumValueW`/`RegEnumKeyExW`；收尾 `RegCloseKey`）
3. 两集合的**差集是否为空**？**非空 ⇒ 该读数记 `not-run`。**

> 自证：我自己的 `ntprobe.exe`/`dshregprobe2.exe` 走**真实 `LoadLibraryW` + 真实 API**，**无桩层**，故不受此风险影响（已在证据中注明）。

## 8. 环境开关的传播边界（2026-10-10 判定：**测试限制 by design，非产品缺陷**）

**`WINSTAGE_SHIM_DISABLE` / `WINSTAGE_SHIM_SKIP` 不会传播进嵌套沙箱线程的注入子进程。** 证据（逐行读源码）：

| 位置 | 内容 |
|---|---|
| `src/executor.mjs:5294-5296` | 注释原文：**"只传递 shim 自己的契约变量 + 允许清单环境（不设 `WINSTAGE_SHIM_DISABLE` —— 设了就等于 shim 完全不生效，那是裸跑）"**；子进程环境由 `buildChildEnvironment({}, …)` **允许清单**构造 |
| `src/executor.mjs:5301-5315` | 实际注入的契约变量只有 `WINSTAGE_STAGE_ROOT`/`WINSTAGE_SHIM_LOG`/`WINSTAGE_SHIM_CONFIG`（可选 `WINSTAGE_REGSTAGE_SESSION_DIR`/`DSH_REGSTAGE_ROOT`）——`DISABLE` 不在其中 |
| `tests/executor-stub.mjs:1069` | 断言 **"绝不设 `WINSTAGE_SHIM_DISABLE`（设了就等于裸跑）"** ⇒ **被测试锁定的不变量** |
| `shim/include/winstage_shim.h:73` | 该变量是**进程自身**的逃生阀，文档**未承诺**穿透沙箱启动器 |
| `tools/{triage-families,bisect-api,minimize-hooks,whiteout-repro}.mjs` | 用 `--set-env` **直传**即可生效 ⇒ 能力在**直接注入器路径**上存在 |
| `src/executor.mjs:4801-4806` | `WINSTAGE_SHIM_DIR/_DLL/_INJECTOR/_PROBE` 由 executor **自己**读取 ⇒ 这解释了为何 `WINSTAGE_SHIM_DLL` 能用于"换件式对照"而 `DISABLE` 不行 |

**判定**：**测试限制（by design），不是产品缺陷**——产品**刻意**不转发且以断言锁定，文档亦未承诺；"无钩子对照"能力在直接注入路径上依然可用。
**协议要求**：需要"无钩子"对照时用 ㈠ **直接注入器 + `--set-env`**，或 ㈡ **缺失/加载失败工件**（`WINSTAGE_SHIM_DLL` → 不存在路径，lane 应降 `T1/artifact-missing`；或 `out-13c`：journal 非空 ⇒ `err=1114`）。**窗口 #6 的 fail-open 阳性对照按 ㈡ 执行。**
**Lead 裁定（2026-10-10）**：㈠ 已采纳（写进协议）；㈡ "仅测试 profile 的显式转发项"**批准为将来可选**，但**当前行为不得改动**，除非同步更新 `tests/executor-stub.mjs:1069` 的断言与文档；**不立项缺陷**。

## 9. 编辑纪律：非 ASCII 文件名一律用受版本管护的编辑工具（2026-10-10，我自己踩到）

**规则**：**凡文件名含非 ASCII 字符**（如 `协议修正-哈希口径-D-R9.md`、`最终验收-冻结态.md`）**一律使用受版本管护的编辑工具（read→edit/write）**，**不得**用 shell（`pwsh`/cmd/`[System.IO.File]::AppendAllText`）做文本往返；**改动后必须回读校验**（行数/标题/关键句）。

**实例**：本轮我用 shell 对该文件追加 §7/§8，命令**报告成功并打印了文件大小**，但内容**静默丢失**（回读发现文件仍止于 §6），且**未产生杂散文件**（无 `git status` 之外的新文件）。改用编辑工具重做后 §7/§8 正常落盘。此前同会话亦有 `Set-Content -Encoding UTF8` 造成 mojibake 的先例。
**复核者要求**：① 任何"已写入"的声明必须伴随**回读证据**（`Get-Content` 的行数或标题列表）；② 证据文件若为中文名，**优先用编辑工具创建/修改**；③ 发现静默丢失时，先确认**无杂散文件**再重做（本轮已确认零残留）。
**Lead 已记录在案**（同步其台账）。

## 10. 环境覆盖（override）的射程：**取决于启动者，不是"跨层必丢"**（2026-10-10 修正）

**结论（三个数据点，全部有原始依据）**：

| 场景 | `WINSTAGE_SHIM_DLL` 是否到达**注入态** | 依据 |
|---|---|---|
| **同一 executor 层**（我的门禁路径：`WINSTAGE_SHIM_DLL=…\out-16…` + 5 套件 + 整仓 `autotest`） | ✅ **到达** | 被注入子进程 `shim.log`：`child injection armed: self=…\.t\round10\shim\out-16\winstage-shim.dll ok=1` |
| **嵌套 DSH 线程**（走 `sbx-thread.cmd`；env-harness `D44`，`WINSTAGE_SHIM_DLL=…\out-13c…`） | ✅ **到达** | `D44-13c-verdict-and-void-correction.txt` L17-19：3 个 pid `self=…\out-13c\winstage-shim.dll ok=1`（`D42`/`D43` 同） |
| **`registry` 的窗口 runner**（`.t\round10\registry\harness\run-in-window.ps1:38-39`） | ❌ **不到达，但属"故意清除"** | 该 runner **显式删除** `WINSTAGE_SHIM_DIR/_DLL/_INJECTOR/_PROBE/_OUT`，注释原文："An inherited `WINSTAGE_SHIM_*` override would **silently redirect** the run to a DIFFERENT directory and **invalidate the whole measurement**, so clear them explicitly" |

⇒ **正确口径 = "取决于启动者是否转发/清除"，而非"同层可达、跨层丢失"**（后者会误导：① 让人以为嵌套路径不能用 override —— `D44` 证明可用；② 让人去修一个不存在的"传播缺陷"）。
**operational 结论不变**：`registry` 的四回合窗口**必须换件**——因为**其 runner 有意清除**这些变量以保证测的是 `shim/out`，**不是**平台层丢失。

**机制（解释了为什么不同开关表现不同）**：
- **被 executor 自己读取**的开关（`WINSTAGE_SHIM_DLL/_DIR/_INJECTOR/_PROBE`，见 `src/executor.mjs:4801-4806`）⇒ 只要该变量在 **executor 所在进程的环境**里就生效（同层 ✅、`sbx-thread.cmd` 嵌套 ✅）；**同理，谁清除它，换件对照就退化回 `shim/out`**。
- **被注入子进程读取**的开关（`WINSTAGE_SHIM_DISABLE`、`WINSTAGE_SHIM_SKIP`、`WINSTAGE_SHIM_DISABLE_FILE/_REG`）⇒ 必须进入**子进程环境**；而 `ENV_ALLOWLIST`（`src/executor.mjs:211`）**丢弃 `WINSTAGE_*`**，executor 只注入 4 个契约变量（§8）⇒ **经宿主环境不可达**；**可达的路径**是 ㈠ `--env` 经 `WindowsStageExecutor.run(options)` → `ShimLauncher.launch({...this.env, ...env})`（`src/executor.mjs:5535-5540`；`fileio` 的 `env-override-harness.mjs` 走这条），㈡ 直接注入器 `--set-env`（`tools/*.mjs`）。
- **对 `fileio` 13d 计数的建议路径据此修正为**：用其 harness 的 **`--env WINSTAGE_SHIM_DLL=<candidate>`**（**而不是**依赖宿主环境继承——那条被 allowlist 丢弃），并在证据里用 `shim.log self=` 断言实际注入件。

**定稿（Lead 2026-10-10 采纳；"同层可达、跨层丢失"表述作废）**：
- 由 **executor 自己读取**的开关（`WINSTAGE_SHIM_DLL/_DIR/_INJECTOR/_PROBE`）在 **同层 ✅ 与嵌套 `sbx-thread.cmd` ✅ 都可达**（`D44` 三个 pid `self=…out-13c…` 为证）；`registry` 的 runner **显式 `Remove-Item Env:WINSTAGE_SHIM_*`**（有意清除）⇒ 它**必须换件**，理由 = "**启动者清除**"，**不是**平台层丢失。
- 由**注入子进程读取**的开关（`DISABLE`/`SKIP`/`DISABLE_FILE`/`DISABLE_REG`）受 `ENV_ALLOWLIST` 丢弃 `WINSTAGE_*` + 只注入 4 个契约变量所限 ⇒ 宿主 env 不可达；**可达路径 ㈠ `--env`、㈡ 直传注入器 `--set-env`**。

## 11. 门禁自测纪律（2026-10-10 窗口 #7 事故，Lead 裁定合并）

**门禁自测绝不能用"真候选哈希 + 当前在位件"跑。** 必须用**不存在的哈希**（或干脆不跑）。
**事故**：`registry` 做"哈希门禁自测"（本意是证明门禁会在候选不在位时 exit 3）时，**恰逢换件落盘** ⇒ 门禁读到 `BEFORE == EXPECTED` 而**正确放行**，于是**自测变成了真跑**（跑完一次真实四回合）。读数有效但**非官方启动**，其 `README-WINDOW7.txt` 已逐条自曝来路。
**并合规则（Lead 裁定）**：**"带 `finally` 的脚本被拦截/中断时，`finally` 不会执行；任何'已回滚'都必须以在盘哈希 + mtime 复核为唯一判据，不以脚本自述为凭。"**
**推论**：① 自测用"不存在的哈希"；② 任何"窗口"证据必须携带 `BEFORE/EXPECTED/AFTER` 与 `DLL_HASH_STABLE`，且复核者**独立重算**；③ 自测与真跑**不得共享 OutDir**。

## 12. 自建探针的回归纪律（2026-10-10 窗口 #7，我自己踩到）

**任何对自建探针的改动，重建后必须跨 DLL 跑"对照矩阵"（含基线 `02C7418F…`）。** 若**所有** DLL 同时失败，几乎必是**探针问题**而非候选问题。
**事故**：我编辑 `ntprobe.cs`（枚举字段解析）后重建的 `ntprobe.exe` 对**四个 DLL（含基线）全部** `LoadLibraryW=NULL err=1114`；同目录同 DLL 的 `loadprobe.exe` 却全部 OK ⇒ 探针侧回归。
**修**：`ntprobe2.exe` 改为**动态解析 ntdll**（`LoadLibraryW("ntdll.dll")` + `GetProcAddress` + `GetDelegateForFunctionPointer`；**无静态 `[DllImport("ntdll.dll")]`**），并**分字段**判定枚举（`TitleIndex/Type/DataOffset/DataLength/NameLength/Name`），**不把 name 与 data 拼成一个断言对象**。
**另**：探针的输出字段必须**逐字段可判**（本轮的实例：`name="V"` 与 `dataLength=26`/`data="written-by-A"` 分开断言）。

**操作纪律（两条，强制）**：
1. **凡"用 override 做换件式对照"的用例** ⇒ **必须先确认启动者没有清除 `WINSTAGE_SHIM_*`**（本仓已知清除者：`registry` 的 run-in-window.ps1:38-39）。被清除时该用例**不成立**，必须走真实换件。
2. **凡"用 env 开关做钩子开/关对照"的用例** ⇒ **必须走 `--env`（`WindowsStageExecutor.run(options)` → `ShimLauncher.launch({...this.env, ...env})`）或注入器 `--set-env`**；依赖宿主 env 继承**必然无效**（`ENV_ALLOWLIST` 丢弃 `WINSTAGE_*`）。

## 13. 日志关联纪律：**按 pid 关联，不要按"只有部分路径才会写的字段"关联**（2026-10-10 窗口 #7，我自己踩到）

**规则**：分析"某条命令的子进程做了什么"时，**必须按 `pid` 关联**（或用**句柄量级**等与路径无关的分类维度）；**不得**用"只有部分代码路径才会打印的字段"（如 `canonical=`）做 join —— 那会**在结构上把被测对象排除在外**。
**实例（我的盲区）**：我按 `canonical=` 含探针键取 hKey 再 join，得出"探针键句柄上枚举/InfoKey 命中 0/0/0"；但**只有 `/v V` 子进程会调用 `RegQueryValueExW`**（也才因此有 `canonical=` 行），**`reg query <KEY>`（不带 `/v`）的子进程从不调用它 ⇒ 永远不出现** ⇒ 该 join **看不到被测对象**，结论无效。**按 `pid` 复算后**才拿到真相：四个 `step2a` 子进程各自只有 `RegQueryInfoKeyW`×2 + `RegCloseKey`×1（均 `ret=0`、伪句柄）。
**配套纪律**：
1. **作用域必须写明**：任何计数/命中结论都要标注"**按 pid/按键** vs **全局**"。
   **实例（我第二次踩到，2026-10-10 由 `registry` 更正）**：我把"`RegEnumValueW` 8,005 / `RegEnumKeyExW` 2,462 次 `ret=0`"标成"**伪句柄上**"，**错了** —— 那是**全局（真实句柄、别的键）**计数。按数值分类后的**正确**分布是：**伪句柄**（`hKey > 0x100000`，全日志仅 ~30 条）只有 `RegQueryInfoKeyW` ×8（= `step2a` 四进程各 ×2）与 `RegCloseKey` ×20–24，**`RegEnumValueW`/`RegEnumKeyExW` = 0**；**真实句柄**上才是那 8,005 / 2,462（别的键的流量）。**两个数都对，但标签错了就会把结论反过来读**（"伪句柄枚举是通的" vs "伪句柄上枚举从未发生"）。
2. **句柄必须按数值分类，不能按字符串长度**：日志里句柄是**定宽** `%p` 输出（`00000118C199E560` 与 `0000000000000660` 同为 16 字符）⇒ `length>=N` 会把两类都判成同一类（我最初的错误即如此）。判据：**数值** `> 0x100000` = shim 伪句柄，其余 = 真实内核句柄。
3. 由日志得出"某 API 未被调用"之前，先问：**该 API 在被测路径上是否本就会打印该字段**？实例：**`api=` 埋点只覆盖 info/enum/close 三类；`open` 与 `queryW` 不在其中** —— 伪句柄上 `RegCloseKey`(20–24) 明显多于 `RegQueryInfoKeyW`(8) 说明有进程"打开→只 `queryW`→关闭"却**不产生任何 `api=` 行** ⇒ **不能用 `api=` 的缺席推断"没打开过键"**。

## 14. 归因纪律 + UI 侧机器复核锚点（2026-10-10 窗口 #8 后）

**归因（attribution）必须有"可复读的原始件"，否则记"未验证"，不得记"已确认"。**
**实例**：`gui` 把我在 `tasklist /m` 快照里看到的两个瞬时 `powershell.exe`（PID 936/2060）归因于它自己的"每条 `pwsh` 取证命令一个宿主"，并称证据在其 `stage-base-retest\shim.log`。**我复查该目录：`.t\round10\gui\stage-base-retest` 下 `.log` 文件数 = 0（无 `shim.log`）** ⇒ 该归因**无从复读、记为"未验证（不影响结论）"**；**实质结论（"瞬时残留、非持久载体"）仍由我方自身证据支持**：同一会话内"看到 → 数秒后 `Get-CimInstance` 查无"，且事后 `tasklist /m winstage-shim.dll` = 无。
**规则**：① 归因需指向**当下存在、可复读**的原始件（行号/pid/时间戳）；② 原始件缺失或被清理时，写"**未验证**"并给替代证据；③ 已退出进程的归因**不可事后补证**，只能记为推断。

**UI 侧机器可复核锚点（`gui` 提供，provenance = `gui`，我方尚未复现）**：`data-winstage-panel`；`data-winstage-trust` 的 `data-winstage-trust` 属性值；`data-winstage-trust-notice`；`style[data-winstage-composer-unhide]`；`[data-chain-overlay-fallback="conversation.composer"]` 的 computed `display`。其只读复测脚本：`.t\round10\gui\k01_retest.py` + `k02_lane.py`；判据对照表在 `docs\round10\gui\修复轮-记录.md §8`。
**用法**：日后若要独立复核 GUI 面，**以上述选择器/live 属性为准**（而不是截图肉眼比对）；复核结论须标注"我方复现"或"转述 `gui` 测量"。

**取证与引用纪律（两条，2026-10-10 窗口 #8 后由一次互查导出）**：
1. **引用原始件前先自校验路径存在**。本会话内出现过两次"引用件不在盘上"：① `stage-base-retest\shim.log`（该目录 `.log` 文件数 = 0）；② `evidence/fix/10-panel-copy.txt`（实际位于 `evidence/10-panel-copy.txt`）。⇒ **报出路径时当场 `Test-Path` 并给出大小/`sha256`/时间戳**；未核实的一律记"未验证"。
2. **取证时把"载体级日志"（`shim.log`）复制进 `evidence/` 长期留存**。暂存树会被清理/换件覆盖 ⇒ 事后无法复核。实例：本例的 `[winstage-shim][2408][1..4]` 初始化行**只存在于转述**；**可复读**的替代物 `docs\round10\gui\evidence\10-panel-copy.txt`（4,025 B，我核过）**只证明"候选列表里出现过 `shim.log`（`+1466 / −0`）"这一机制**，其中 `winstage-shim` 命中数 = **0**。⇒ **"机制"可由该件支撑；"具体 pid 归因"不能**（该归因已由 `gui` 在 `修复轮-记录.md §8.1` 自行撤回、降级为"推断（未验证）"）。
