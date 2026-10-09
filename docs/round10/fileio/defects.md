# R10 域一（fileio）缺陷台账

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
