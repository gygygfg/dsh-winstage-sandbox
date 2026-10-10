# R10 域一（fileio）缺陷台账

## ★ 置顶：四条跨域拦截纪律（本轮用真金白银换来的）

> 这四条都来自"看起来成立、实测不成立"的推断。**结论必须落在直接证物上**，不许跨一步外推。
> 1. **件里有字符串 ≠ 该 API 被挂钩**（本轮我犯过两次）。判挂钩**必须查 `g_targets[]`**（现成工具：`.t/round10/fileio/13d-count-probe/check-target-tables.mjs`）。
>    —— 由 `D-FILE-1` 与 `D-FILE-2` 换来：`FindFirstFileW` 的字符串来自 shim **自己调用**它，而不是它被挂钩。
> 2. **wrapper 被调用 ≠ 原函数已解析 ≠ 参数/类分发正确**（`exe` 提出）。计数/插桩挂在包装体里，**不代表**转发到了正确的原函数。
> 3. **门禁全绿 ≠ 已修**（本轮被多次印证：Defender 窗口内"看起来通过"、`SKIP` 无对象可跳却显示"无变化"）。
> 4. **面向演进中的树的补丁必须重生成、并按当时的树重验，且记录 apply 前/后文件哈希；过期补丁不得直接套用。**
>    —— 由 v2a→v2b 换来：`counts-v2.patch` 因 `pkgs` 在 out-18c/out-19 期间往 `g_targetNames[]` 加名而 `git apply --check` 退 1（冲突于 `ws_hook.c:117`）；
>    重生成的 `counts-v2b.patch` 才退 0。**判据三件**：`git apply --check` 退 0 **且** 在副本上编译零告警 **且** 补丁记录的目标哈希与套用后实物一致。
>
> 同族提醒：**"档位不是 TS 的读数" 与 "没有读到数" 都不得写成"未命中/未发生"**（见 `13d/命中表.md` 与 `13d/count-window-evidence/README.md`）。

> 口径：**只记实测**。每条给"载体 + 原始证据路径 + 复现命令"。
> 载体代号：C1 = 新开的带沙箱 DSH 线程；C2 = `run.cmd src\cli.mjs exec`（受限令牌 + shim）；C3 = 本线程未受限 shell。
> 本轮共 3 次作废重跑（Defender 隔离窗口），见 `evidence/threads/VOID-*/VOID-REASON.txt`。
> **R11-D 修复轮的缺陷/结论见文末 §R11-D**（另见 [修复-工具面.md](修复-工具面.md)）。

---

## R11-D【已修】工具面 `readdir` 与 `stat` 自相矛盾（`wo\` 白障被 `listDir` 忽略）

| 项 | 内容 |
|---|---|
| 载体 | 插件 `ctx.fs` 面，替身基类 + 真实目录（`.t/round10/fileio/toolface-consistency.mjs`），**不经过 shim** |
| 症状 | 目录里 `readdir` **列着**一个已被逻辑删除的真实文件，`stat` 同一路径返回**不存在** ⇒ 同目录自相矛盾（与 `exe` 域 **D-EXE-6** 同形） |
| 根因 | `listDirInner` 只从**内容树 `fs\`** 出发发现删除标记（`shimChildrenOf`）；真实盘上被删的文件在内容树里没有对应项 ⇒ 看不见；内容目录不存在时 `shimChildrenOf` 返回 `undefined` ⇒ **整棵 `wo\` 树被忽略**，早退回 `super.listDir` |
| 实测 | C6 `listed=true stat=undefined`、C7 `realdel.txt: listed but stat=undefined`（改动前 9 PASS/2 FAIL） |
| 修法 | 新增 `shimDeletionsOf()` 独立扫 `wo\` 树；`selfDeleted` ⇒ 空列表；早退条件加 `woDeleted.size===0`；合并后按 `woDeleted` 最后压一次 |
| 复验 | 11 PASS/0 FAIL；受控回退复现 → [before](evidence/fix/toolface-consistency-before.json) / [after](evidence/fix/toolface-consistency-after.json) |
| 残余 | `readBytes/readByteRange/streamText` 本来就走 `currentOf()`（承认白障）；**目录型白障未单测**（`not-run`） |

## R11-D【上界·非缺陷】默认档"工作区外写"的成功回执**无法**携带诚实信息

| 项 | 内容 |
|---|---|
| 实测 | `dsh-tool-fs` 的 `write` 输出 schema 是 `additionalProperties:false`（仅 `path/operation/before/after`），渲染器 `formatWriteOutput` 只按 `operation` 输出 `Created/Updated file` ⇒ 插件加键**到不了模型** |
| 处理 | 诚实信息放非枚举 diagnostics（`appliedToDisk:false` / `pendingApproval:true` / `outsideWorkspace:true`）；需要模型面诚实时用 `stageOutside:'deny'`（抛 `FS_SANDBOX_DENIED`，实测模型看到插件自己的诚实文案） |
| 处方 | 上游给 `operation` 扩一态或渲染器接受可选 notice；或装配方选 `'deny'`。**另**：`fs-entry.mjs:36` 只认 `WINSTAGE_STAGE_OUTSIDE=direct`，经 env 启用 `deny` 需改一行（该文件不在本任务写范围） |

## R11-D【既有缺陷候选·不是本次改动引起】`whiteout-candidate-capture` 在整仓顺序下 2/29 红

| 项 | 内容 |
|---|---|
| 症状 | `candidate-byOp {"create":4,"delete":3}`（期望 `delete===3 && create===1`）、`apply-no-failures` 报 `BLOB_MISSING: candidate content for a.txt is missing` |
| **因果判定** | **仅回退**本次唯一相关的改动（`listDirInner` 白障合并）后跑整仓 `verify.cmd`，**逐条相同** ⇒ 与 `task-16` **无关** |
| 佐证 | 该套件单跑 **29 ok / 0 bad**；与 `delete-capture` / `e2e-flow` / `boundary-degraded-failclosed` 两两组合全绿；只在**整仓顺序**下红 ⇒ 顺序/共享状态相关 |
| 证据 | [verify-with-itemC-reverted.txt](evidence/fix/verify-with-itemC-reverted.txt)、[after-verify-full-run2.txt](evidence/fix/after-verify-full-run2.txt)、[only-whiteout-alone.txt](evidence/fix/only-whiteout-alone.txt) |
| 建议 | 交 `Lead`/`env-harness` 收口：优先查套件间共享工作区（runner 的 `STAGING=join(ctx.workspace,'.dshstage','staged')`）与 `BLOB_MISSING` 的 blob 生命周期 |

---

## D1【设计/预期不符·中】DSH `write` 工具对工作区外路径**不拒绝**，而是静默进暂存

| 项 | 内容 |
|---|---|
| 载体 | C1（nested thread `session-d5f49e4c…`，run-1） |
| 预期（任务书第 3 组） | 工作区外写 = **拒绝**，且宿主侧零残留 |
| 实测 | **4/4 全部"成功"**，工具返回 `<content>Created file</content>`，路径回显就是工作区外真实路径 |
| 目标 | `C:\Users\Administrator\Desktop\ws-probe-r10-inthread.txt`、`C:\Windows\Temp\…`、`C:\Users\Administrator\Documents\…`、`..\..\ws-probe-r10-inthread.txt`（→ `<repo>\.t\round10\`） |
| 实际去向 | 4 条都进 `staged-ext/<sha256(小写绝对键)[0:2]>/<[0:16]>/<叶名>`，blob 命中（4 B，`ca3704aa…`），候选 `cs_0010` 记 12 changes |
| 真实盘 | **4/4 不存在**（C3 逐条 `Test-Path`）→ 内容零残留成立 |
| 归因（读码） | `dsh-plugin/staging-fs.mjs:503-508`：`stageOutside` **默认 `'stage'`** = "工作区外写入进暂存、等批准"；文件头第 28 行同义。**这是插件刻意设计**，不是逃逸 |
| 判定 | **不是隔离失效**；是**任务书预期与产品设计不一致**。AI 视角下"写工作区外"会得到成功回执（`Created file`），只有面板/审批面才知道它没落盘。**读取面/写面语义不对称**，建议在开发者文档里明说，或在工具回执里带上"待审批"语义 |
| 证据 | `evidence/threads/run-1/stdout.ndjson`（4 条 write 的 call+result）、`chain-probe.json`（4 条 staged-ext PASS）、`./out/boundary-*-residue.txt` |

**反证纪律**：本条的"内容零残留"由 C3 侧真实盘 `Test-Path` 独立证明，未采信沙箱自述。

---

## D2【编码·低】Windows PowerShell 5.1 `Set-Content -Encoding UTF8` 写出 BOM + 尾 CRLF

| 项 | 内容 |
|---|---|
| 载体 | C1（run-1，pwsh 工具） |
| 现象 | 预期 23 B 的文件实际 28 B |
| 实测字节 | `EF BB BF` + `cjk dir and spaced name` + `0D 0A` = 28 B |
| 影响 | 与 ACP=936 一起构成"shell 写文本的字节与直觉不符"；不是沙箱缺陷 |
| 处理 | 探针引入 `allowedVariants`（utf8-crlf / utf8-bom-crlf）显式建模，而不是把 28 当成"沙箱改了字节" |
| 证据 | `evidence/threads/run-1/expect-run1.json`（variants）、`out/cjk-bytes-hex.txt` |

---

## D3【编码/可用性·低】受限会话里 pwsh 写脚本 + node 执行会撞 ESM/CJS 判定

| 项 | 内容 |
|---|---|
| 载体 | C1（run-2，`session-34f8ccfa…`） |
| 现象 | `in\deep-probe.js` 用 `require` 被当成 ESM（仓库 `package.json` 有 `"type":"module"`）⇒ `ReferenceError: require is not defined` |
| 归因 | 暂存树里的临时 `.js` 继承了**仓库**的 module 类型；沙箱 cwd 在暂存树，但 `package.json` 解析走到了仓库根 |
| 影响 | 可用性坑：沙箱内临时脚本必须显式用 `.cjs`，或自带 `package.json` |
| 证据 | `evidence/threads/run-2/stdout.ndjson`（DEEP= 段） |

---

## D4【平台边界·中】>260 字符路径：node 通道可写（含 456 字符），PowerShell 5.1 全通道不可写

| 项 | 内容 |
|---|---|
| 载体 | C1（run-2 / run-2b / run-2c） |
| node 通道 | **265 / 273 / 345 / 456 字符绝对路径全部写入成功**，manifest `stagedHash`、blob、`staged/<rel>` 三处哈希一致（`longpath-check.mjs` 逐条核） |
| PowerShell 5.1 无前缀 | `DirectoryNotFoundException`（MAX_PATH，非策略拒绝） |
| PowerShell 5.1 带 `\\?\` 前缀 | 也失败，但**失败原因是父目录链未建**（该轮 `New-Item -Force` 只建到 `in\deep2`）⇒ `\\?\` 臂**inconclusive**，不是 `\\?\` 被拒 |
| 附带发现（探针侧） | PowerShell 的 `Test-Path`/`Get-Item` 在 MAX_PATH 之外**静默返回 False**，会让"清单说文件在、磁盘说没有"变成**假结论**；核长路径必须用 node（`longpath-check.mjs`） |
| 证据 | `evidence/threads/run-2b/chain-probe.json`、`evidence/threads/run-2c/longpath-check.txt` |
| 判定 | 长路径能力**按载体分层**：node ✓（至 456 字符已测）、PowerShell 5.1 ✗（MAX_PATH）；这不是沙箱策略，是 Windows/PS 5.1 平台事实 |

---

## D5【异常·待定因】run-2 深路径写入未落暂存：目录建了、文件没有、也没有错误

| 项 | 内容 |
|---|---|
| 载体 | C1（run-2，`session-34f8ccfa…`） |
| 现象 | `in\deep` **目录存在但为空**；目标文件（约 495 字符绝对路径）在 manifest 里**完全没有条目**；`chain-probe` 报 `missing-everywhere` |
| 直接证据 | node 复查 `fs.existsSync('<stage>/staged/in/deep')=true`，其下 0 项；manifest 里 `in\*deep*` 只有 `in\deep-probe.js state=deleted`（agent 自己删的脚本） |
| 归因线索 | run-2 那一轮 agent 为了绕 ESM 判定，**在暂存根里临时放了一个 `package.json`**；run-2b / run-2c 在 265/345/456 字符下用同一 node 通道**全部成功** ⇒ 触发条件与"路径长度"无关，怀疑与那次本地 `package.json`/agent 的额外操作有关 |
| 现状 | **无法复现**；agent 自述的"120 s 超时"没有拿到任何原始超时输出。标 `needs-reproduction`，**不作产品结论** |
| 影响（若成立） | 深路径写入可能"静默无产物且无报错"，属于最难查的一类缺陷 |
| 证据 | `evidence/threads/run-2/stdout.ndjson`（DEEP= 段）、`evidence/threads/run-2/chain-probe.json` |


---

## D6【功能缺口·低】ADS（备用数据流）在沙箱内不可写

| 项 | 内容 |
|---|---|
| 载体 | C1（run-2） |
| 现象 | `Set-Content -LiteralPath 'in\edge\ads.txt:evil'` → `DriveNotFoundException` |
| 对照 | 上一轮（平台 `SandboxedFileSystem`）工作区内 ADS **可创建可回读** |
| 判定 | 本轮 WinStage 通道下 ADS 不可写；影响面小，记录为通道能力差异 |
| 证据 | `evidence/threads/run-2/stdout.ndjson`（EDGE= 段） |

---

## D7【工具缺口·低】`Remove-Item -Recurse` 删不掉 >260 字符的暂存树

| 项 | 内容 |
|---|---|
| 载体 | C3（本线程清理 CLI 遗留 stage root） |
| 现象 | `Remove-Item -Recurse -Force` → `DirectoryNotFoundException`；目录仍在 |
| 绕行 | `cmd /c rmdir /s /q` 成功 |
| 影响 | 取证清理脚本若只用 `Remove-Item` 会**静默留下整棵暂存树**（含长路径文件），可能污染后续按路径扫描的结论 |
| 建议 | 清理产物统一走 `cmd /c rmdir` 或 node `fs.rmSync` |
| 证据 | `./out/stage-root-cleanup.txt` |

---

## 探针自身缺陷（不是产品缺陷，但同样入账）

| 编号 | 缺陷 | 发现方式 | 修复 |
|---|---|---|---|
| D-P1 | `boundary-probe.ps1` 的 `unc` 项用 `Join-Path '\\?\C:\Windows\Temp' …` 抛 "drive is null"，该异常吞掉本行后续 ⇒ `unc` 臂**退化成重复测 `dotdot`** | Lead 在宿主侧对照臂输出里指出（`boundary-host-lead.txt:29-30` target 与 dotdot 相同） | 改显式字符串拼接 `JoinAbs()`；拆成 `ext_prefix`（`\\?\`）与 `unc`（`\\localhost\C$`）两条真臂 |
| D-P2 | `staged-chain-probe.mjs` 外部条目的分桶推导写成"内容哈希前 2 位"，而真实规则是 **`sha256(小写绝对键)` 前 2 位** | run-1 首跑 4 条 `staged-ext` 报 `not-found`（blob 侧却命中） | 改为 `import { externalKeyDigest } from '../src/store.mjs'`，以被测程序自身函数为 oracle；并加全树按叶名兜底 |
| D-P3 | `verify-thread-run.mjs` 的 J5 判据含裸 `/degraded/i`，命中**模型自己写的散文**（"the shim deadlocked"）⇒ run-2 假 FAIL | run-2 verdict 输出 | 判据只扫机器标记（`injector exit=null` / `injection failure` / `tier=T1` / `StageGuardUnavailable` / `sentinel-held-by-live-guard`），并把 `text`/`final`/`thinking` 从扫描面剔除 |
| D-P4 | 第一批 run-1/run-2 落在 Defender 隔离窗口内，实际**没有 shim**（`staged/fs` 文件数 0）却"看起来通过" | Lead 的 Defender 通告 + 事后复核 | 作废重跑；新增 J2b"`staged/fs/**` 非空"作为 **shim 真的活着**的机器判据 |

---

## D-FILE-1【既有 · 本次未动 · 真实缺陷】`ws_hook.c` **两张平行表漂移** ⇒ **现成的假 oracle**（`ws_hook_target_names()`）

> **⚠ 这是本条的主缺陷。** `g_targets[]`（决定"谁被挂钩"）与 `g_targetNames[]`（对外交出的"钩子名单"）**已经漂移**：
> 当前 **56 vs 57**、**从 index 52 起整体错位一格** ⇒ 访问器 `ws_hook_target_names()` 交出的 `count` **多报 1**，且 **index→name 从 52 起全错**。
> **任何以它为"哪些 API 被挂钩"依据的诊断/计数（含 Stage 5）都会被误导** —— 这正是本轮那条跨域纪律（见本文件置顶第 1 条）的又一具体面。

| 项 | 内容 |
|---|---|
| 载体 | `shim/src/ws_hook.c` 静态解析：`.t/round10/fileio/13d-count-probe/check-target-tables.mjs`（可复算、不构建不运行） |
| 事实（当前树） | `g_targets` = **56**、`g_targetNames` = **57**、`aligned=false`；`onlyInNames=["LdrGetProcedureAddress"]`；**从 index 52 起整体错位一格**（target `NtQueryValueKey` vs name `LdrLoadDll`、`NtEnumerateValueKey` vs `NtQueryValueKey`、`NtQueryKey` vs `NtEnumerateValueKey`、`LdrLoadDll` vs `NtQueryKey`） |
| 成因 | out-18 把新目标追加到 `g_targets` 的 `LdrLoadDll` **之后**，名字插到 `g_targetNames` 的 `LdrGetProcedureAddress` **之前**（`v2-baseline` 快照 54 vs 55 同样错位 ⇒ **既有结构脆弱**，非某次新引入；`pkgs` 已独立确认其插入位置） |
| 严重性（如实） | **潜在**，非行为缺陷：`g_targets` 决定挂钩且**按名字匹配** ⇒ **挂钩行为不受影响**；`ws_hook_target_names()`（`ws_hook.c:655-661`）目前**零调用者**（全仓仅声明+定义）。**危险正在"零调用者"里**：它现在是一个**没被拆穿的假 oracle**，谁先用谁中招 |
| 影响 | ① **Stage 5 计数 `FindFirstFileW` 依赖本修复**（未挂钩 ⇒ 计不到，那个 0 是"未挂钩"而非"未调用"）；② 通用判据"件里有字符串 ≠ 被挂钩；判挂钩必须查 `g_targets[]`"由此确立 |
| 附带澄清（我 2026-10-10 自纠） | 我最初写"`FindFirstFileW` 仅存在于 `g_targetNames`"是**错误归因**：实测**两表都没有**它，件里字符串来自 **`ws_file.c:635`/`1023`、`ws_t3reg.c:362` 对它的直接调用**（shim 自身内部枚举）+ 一处注释。**不变的结论**：`FindFirstFileW` 确实**未被挂钩**，"`SKIP=FindFirstFileW` 不影响 `readdir`"因此得到**更强**解释（没有对象可跳） |
| 独立方案（**已备，不执行**） | **`docs/round10/fileio/13d/D-FILE-1-独立方案.md`** —— 最小修复（按 `g_targets` 重排 + `_Static_assert`）与推荐修复（X-macro 单一来源，结构上不可能漂移）；静态判据（checker 退 0 + 编译零告警）、动态双向判据（`--env WINSTAGE_SHIM_SKIP=FindFirstFileW`：基线 `hit>0` ↔ SKIP 后该行消失）、回滚三件套、与 Stage 5 的依赖图 |
| 判定 | **既有问题、本次未动**；执行统一由唯一构建者 `pkgs` 在**窗口 #7 收尾后**做 |
| 证据 | 本条目 + 独立方案 §0/§1；`check-target-tables.mjs` 当前树输出 `targets=56 names=57 aligned=false` |

---

## D-FILE-2【本次引入并已定位】新增 pass-through 包装在 `g_orig` 未解析时 **fail-closed** ⇒ **CLR 宿主初始化失败、载体连崩 3 次** ⇒ 平台 fail-closed 降 T1

| 项 | 内容 |
|---|---|
| 载体 | R11-D-13d 计数候选 v1 `5596F552C7BFB189C14B9430D8F0F5A9934213CADB6159EA24665FCCF0AE3CD1`（补丁新增 6 个 pass-through 挂钩） |
| 现象 | 候选经 `WINSTAGE_SHIM_DLL` 注入后，被注入载体 **`powershell.exe` 在自身 CLR 初始化阶段死亡**：`childExit=4294901760 (0xFFFF0000)`、`Starting the CLR failed with HRESULT 80004005`、`carrierAttempts=3/3`（**3 次同值**）、`injectorOk=true` ⇒ `fallbackReason=carrier-init-failed … fail-closed fallback to the restricted-token mode` |
| 后果 | 该次 `tierEffective=T1`（无 overlay）：子进程三个 `WINSTAGE_SHIM_*` 全 `null`、`A_write=DirectoryNotFoundException`、`node`/`cmd` 派生 `ApplicationFailedException`、`.NET Exists=false` ⇒ **读数全部无效**（13d 计数因此记 `not-run`，**不是**"未命中"） |
| A/B（归因关键） | 同一命令、同一 stage root、**不设 override**（用在用件 `02C7418F…`）⇒ `tierEffective=TS` / `launchMode=shim` / 9×`child injection armed` ✅ ⇒ **候选特有**，与 override 机制和环境无关 |
| 归因（假设，强指向） | 新增包装在 `g_orig.<Name>` 未解析时**返回失败**（`FALSE`+`ERROR_PROC_NOT_FOUND` / `STATUS_PROCEDURE_NOT_FOUND`）。shim 原指针表按 API 名**全局唯一**，一次安装跨 20 个模块打 **203** 个站点 ⇒ 只要一处原指针为空，CLR 初始化路径上的调用即被**伪造失败**。probe 自检本身通过（`probe exit=0 … iatSites=68 modules=8`）⇒ 问题在**被 CLR 宿主使用时**才暴露 |
| 修法 | **零新增挂钩目标**（v2：只统计已挂钩入口）；若将来仍要新增，必须 (a) 原指针为空**不安装**该目标，或 (b) 调用时**按模块解析**原函数，且 (c) 包装带重入守卫 |
| **正面结论（重要）** | 平台在"载体连续 3 次启动失败"后**没有裸跑**，而是 **fail-closed 降级到受限令牌 T1** 并如实给出 `fallbackReason` ⇒ **行为正确**；这与 **`D-R8`（反向的 fail-open）** 正好构成一对：**同一平台在"载体起不来"时是 fail-closed，在 `D-R8` 那条路径上是 fail-open** —— 两条各自留档 |
| 证据 | `docs/round10/fileio/13d/count-window-evidence/README.md`；`cli-ts-run.txt`（`fallbackReason` 全文）；`ab-inuse-run.txt`（A/B 对照） |
| 状态 | 已由 v2 修法规避；v1 候选冻结但**标注不可用**（`.t/round10/shim/out-13d-count`） |
| 证据 | `.t/round10/fileio/13d-count-probe/PATCH-SPEC.md` §6.2 的双编码普查；`docs/round10/fileio/13d/TS-四项基线.md` §3 |

---

## D-FILE-3【新发现 · 未修】node 的 `existsSync/statSync` 看不见暂存文件（**属性面已排除**；指向 `CreateFileW` 属性打开 / `GetFileInformationByHandle`）

| 项 | 内容 |
|---|---|
| 现象 | 同一次 TS 运行内：`node` 对暂存文件 `…\probe\count-fixture.txt` 的 `existsSync=false`/`stat=ENOENT`/`lstat=ENOENT`，而**同一路径的 `readFileSync` 成功**。`.NET`/pwsh 对同一文件 `Exists=true`。 |
| 影响 | **本轮 13d 要解释的核心信号**：`read` 通、`stat/exists` 不通。产品面：任何用 `stat/exists` 判存在性的工具（node、`cmd if exist`）在 TS 车道上会把暂存文件误判为"不存在"。 |
| **已被推翻的早期推断 ①** | "`\\?\` 前缀是根因"。**推翻**：受控 A/B（pwsh 同进程、先造夹具、只变形态）⇒ `verbatim_dotnetExists=true`；源码 `ws_normalize_path()`（`ws_util.c:815-827`）**本就剥离** `\\?\`/`\\?\UNC\`。 |
| **已被推翻的早期推断 ②** | "失败在 `ws_GetFileAttributesW` 的属性解析分支"。**推翻**：`out-13d-count4` 定名读显示 `branch=masked` **0**、`branch=resolve-fail` **0**；node 的 fixture 调用为 `rc=0`、`mapped=` **覆盖层路径**、`staged=1`、**`attrs=0x20`(ARCHIVE)、`err=0`＝真实 API 成功** ⇒ **属性面给出的是正确答案**。 |
| **正面判别（新）** | node 进程**只有 2 次** `GetFileAttributesW`（fixture + `ps-seed.ps1`，**两次都成功**）、**0 次** `GetFileAttributesExW`、**0 次** `NtOpenFile`；而探针对同一路径做了 `existsSync/statSync/lstatSync` **三次**查询。若走 `W`，fixture 至少应有 3 行 `ATTRDBG-W`，实测**只有 1 行且成功** ⇒ **`W` 不可能是失败路径** ⇒ node 的 stat/exists 走**未被本仪器覆盖的入口**。 |
| 下一步指向 | 最可能是 libuv 经典实现：**`CreateFileW`（属性专用打开）+ `GetFileInformationByHandle`**（后者**不在 `g_targets[]`、未挂钩**）。→ 先做 `CreateFileW` 打开形态日志（`out-13d-count5`，`cfw-openform-log.patch`，零语义、不新增目标）；**若**确需挂钩 `GetFileInformationByHandle`，**必须另立候选**并遵守 `D-FILE-2` 安全写法（per-site trampoline / 绝不 fail-closed / 先日志先过㈠）。 |
| 证据 | `docs/round10/fileio/13d/stage-name/结论.md`（定名读，含完整 `ATTRDBG-W` 行）；`docs/round10/fileio/13d/stage-attr/结论.md`（属性面日志）；`docs/round10/fileio/13d/stage-0/命中表.md`（首批命中表） |
| 状态 | **未修**；下一步增量（`CreateFileW` 打开形态日志）已交 `pkgs` 构建 `out-13d-count5`，取数归我、**先过㈠** |

---

## D-FILE-4【设计边界 · 非回归 · 非 fail-open】IAT-interception coverage boundary（IAT 挂钩对动态解析调用不可见）

| 项 | 内容 |
|---|---|
| 一句话 | **仅经 `GetProcAddress` / 延迟导入使用的 API，IAT 挂钩点无法覆盖** ⇒ 隔离面在该类调用上存在**盲区**。 |
| 判据（**双条件，缺一不可**） | ① **显式探针可命中**：`.t/round10/fileio/13d-count-probe/loadprobe/gfibhex-probe.exe`（`5620B04037C3FDA6F1D8608B046B634C088F67D840F855C38C153FE47F8A30DA`）显式导入并调用 ⇒ `shim.log` 出现 `ATTRDBG-GFIBHEX` **4 行** + `R11-D-13d hit GetFileInformationByHandleEx n=2`，全 `ok=1 err=0`；② **目标进程 0 行**：同候选 `out-13d-count9` 主探针 run 中该标记**全进程 0 行**、hit **0 条**（对照：`NtQueryInformationFile` 599 行/5 pid、`GetFileInformationByHandle` 91 行/3 pid）。 |
| 归因 | 两条件同时成立 ⇒ 该进程集合中**没有任何模块按名导入**该 API ⇒ **无 IAT 站点可打**（与 `ws_hook.c` 安装期注释一致：hit=0 意味着没有模块导入它，只能经 `GetProcAddress` 到达）。 |
| 含义 | 任何"**某 API 未被调用**"的否定结论，若该 API 可能被动态解析使用，**必须**附活性反证（显式探针）；**没有活性反证的 0 只能记 `inconclusive`**。本轮的 0 因此从"③"降级为"覆盖边界"。 |
| **性质（务必分清）** | **不是回归**、**不是 fail-open**、**不是行为证据**。 |
| **与 `D-R8` 的区别** | `D-R8` 问"**拦截失败时平台是否裸跑**"（fail-open 判据，窗口 #8 仍**未被演示**）；本条问"**拦截面本身看不看得见**"（覆盖/可见性）。二者**不同层**。 |
| 建议 | ① 凡"未调用"结论必须带活性反证；② 若需覆盖动态解析类调用，要**非 IAT 的拦截手段**（`GetProcAddress`/`LdrGetProcedureAddress` 钩子或内核侧），属另一立项；③ 文中凡引用"IAT 0 命中"处须同时标注本条边界。 |
| 证据 | `docs/round10/fileio/13d/stage-gfibhex/①-活性正对照.md`（已置顶为一等结论）；`stage-gfibhex/结论.md`；`.t/round10/fileio/13d-count-probe/loadprobe/*` |
| 状态 | **已知设计边界**（不修，属方法论）；已升为一等结论 |

---

## D-FILE-5【残留产品面缺口 · 未修 · 非窗口缺陷/非回归】`NtQueryFullAttributesFile`（及同族 `NtQueryAttributesFile`）**不感知 overlay**

| 项 | 内容 |
|---|---|
| 现象 | 线 A#2 主探针 run 中，唯一夹具绑定行来自**非探针进程**：`[4964][7659] ATTRDBG-NQFAF pid=4964 handle=0 path=\??\…\ws-stage16\probe\pa-fixture.txt status=0xc000003a` ⇒ 我们的 `NtQueryFullAttributesFile` 对**逻辑路径**原样返回 `STATUS_OBJECT_PATH_NOT_FOUND`，**未做 overlay 感知**（同族 `NtQueryAttributesFile` 亦同）。 |
| 含义 | **将来任何调用方若用 `NQFAF`/`NQAF` 查询"已暂存/被覆盖层服务"的文件，我们会报"不存在"** ⇒ 对依赖这两个 API 做存在性判定的调用方属**隔离语义缺口**（真实存在性被漏报）。 |
| 现状定性 | **不是** node 的失败路径（node 的 `stat`/`lstat` 根本不走这两个 API —— 线 A#1/A#2 已证 **③**）⇒ 属**同族入口的覆盖边界/语义缺口**，**未修**。 |
| 与 `D-FILE-4` 的区别 | `D-FILE-4` 问"**看得见吗**"（IAT 对动态解析不可见）；`D-FILE-5` 是"**看得见但语义不对**"。 |
| 证据 | `docs/round10/fileio/13d/stage-nqfaf/evidence/shim.log`（`9681E4B6AAFC44D1D2752AA594904C65F9C46A4D907EAD389EE2D8235B45C6CF`，9,945,585 B，53,963 行）；`pkgs` 车道内活性样例（`status=0x0` 存在 / `0xC0000034` 名不存在 / `0xC000003A` 路径不存在）。 |
| 建议修法（留待单独候选，先日志/先判据） | ① 在这两个包装内做 **overlay 感知的存在性判定**（命中覆盖层即按覆盖层回答）；或 ② **明确文档化"不感知 overlay"语义**并禁止其用于暂存路径判定。二者择一。 |
| 状态 | **未修**；已随线 A#3 一并立案（Lead 要求） |

---

## D-FILE-6【高 · 产品缺陷 · 未修 · 已造成真实用户可见故障】新挂钩的**按名查询**类 API 未做 overlay 语义 —— 实例 `NtQueryInformationByName`

| 项 | 内容 |
|---|---|
| 一句话 | `NtQueryInformationByName` 被挂钩但**只 pass-through**、**不感知 overlay** ⇒ 按**逻辑名**查询**已暂存**文件时内核返回 `STATUS_OBJECT_PATH_NOT_FOUND` ⇒ **沙箱内 `statSync`/`lstatSync` 失败**。 |
| 现象（原始行） | `ATTRDBG-NQIFBN pid=3932 handle=0 path=\??\C:\…\ws-stage17\probe\pa-fixture.txt status=0xC000003A class=77`；`lstat`(8384) 与 `exists`(2528) **各同形 1 条**。 |
| 判据 | 夹具绑定行**存在**且 `status=0xC000003A`（失败）⇒ 预登记表 **②**（"被调用但返回失败"）。活性反证：全局 `ATTRDBG-NQIFBN` **95 行**、`hit n=24/24/24/23` ⇒ **不是死钩子**。 |
| 影响（高） | **真实用户可见**：node 的 `fs.statSync`/`fs.lstatSync`（以及 `existsSync` 的一次探测）对**沙箱内已暂存文件**报 `ENOENT`；与"`readFileSync` 成功"并存 ⇒ 同路径两套 API 结论矛盾。 |
| 与同族条目的三条区分 | `D-FILE-4` = **看得见吗**（IAT/动态解析覆盖边界）；`D-FILE-5` = 看得见但**语义不对**（`NQAF`/`NQFAF`，暂无已知调用方）；**`D-FILE-6` = 语义不对且已造成真实故障**（`NQIFBN`）。 |
| 证据 | `docs/round10/fileio/13d/stage-nqifbn/evidence/shim.log`（`00219500CB44B994C8722212709334ECFA30A815B910E4F61C4484C38093FBBE`，10,025,461 B，**54,104 行**）；`pa-actions.jsonl`（`C8984BCA3A4112DC7BBB73A23BDA0CE2B0FA5007148334E95F8716B2D9B55DF8`）。 |
| 建议修法（下一个修复候选） | 在包装内**先按覆盖层解析逻辑名**（与读路径同源；命中即按覆盖层回答存在/属性），**未命中才回落真实 API**；**未解析/异常一律安全降级、绝不 fail-closed**；不动其它目标与 injection/路径逻辑。验收三层：① 离线 `dshregprobe2 ALL=True`；② 零语义复跑（`step2a`/`step2b` 逐字节 `12AA39D1…`、D-R1 四条件不回归）；③ **行为验收**：同车道免换件下 `statSync`/`lstatSync` 对已暂存文件**转成功**、`readFileSync` 不变、`existsSync` 现状不变（其异常属线 B），并附夹具绑定原始行。**任一回归即回滚停下上报。** |
| 状态 | **未修**；已定为**下一个修复候选**（Lead 2026-10-10 裁定，定级高） |
