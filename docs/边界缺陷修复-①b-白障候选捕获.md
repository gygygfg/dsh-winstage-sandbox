# 边界缺陷修复 ①b —— 白障（whiteout）候选捕获

- 修复对象：缺陷①的**后半段**。① 已在 `shim\**` 侧落地（详见 `docs\边界缺陷修复-①TS档删除绕过.md`），
  四种删除形式在 TS 档下都会在 `<staging root>\wo\…` 留下白障标记、真实文件不再被删；
  但候选仍然是 `删除 0 项` —— 删除对 review / apply **不可见**，无法审批。
- 修复位置：`src\workspace.mjs`（唯一改动点）。`src\cli.mjs` / `src\store.mjs` **无需修改**（理由见 §3.2）。
- 测试侧：修正 `tests\file-cow-dispositions.mjs` 的 c9 陈旧期望，并把 c7b 从"记录在案的 GAP"提升为**严格断言**。
- 新增聚焦回归：`.t\shim-delete\test-whiteout-capture.mjs`（29 项断言，**不需要 shim**，直接驱动 Workspace API）。
- 未触碰：`shim\src\**` / `shim\include\**` / `dsh-plugin\**` / `tests\testrunner.mjs` / `verify.cmd` /
  `patches\**`；未重生成 `docs\源码基线.sha256`；未跑 `verify.cmd` / `autotest`。

> 证据标记：`[官方]` 手册/上游语义，`[实测]` 本次在本机跑出来的，`[推断]` 由代码路径推出、未直接观测。

---

## 1. 结论摘要

| 事实 | 修复前（旧 `src`） | 修复后（本文件） |
|---|---|---|
| 候选里的删除条数 | `0`（四个删除形式 × 工作区内外 = 8 个真实删除**全部丢失**） | `10`（8 个删除目标 + `move`/`ren` 的两个源） |
| `wo\…` 伪 create | 有：22 个 create 里 **10 个**是 `wo\C\…` 标记 | **0** |
| 从未暂存的真实文件被删 | 既不进快照、也没有候选 | 恰好一条删除候选，`path` = 真实路径、`before.hash` = 真实内容、`after.hash = "absent"` |
| CLI 行 | `沙箱内提取到 22 项变化，并入清单 22 项，删除 0 项` | `沙箱内提取到 9 项变化，并入清单 3 项，删除 6 项` |
| 注释里非 `wo\` 的 create | 12 条（`fs\…` 内容副本 + `shim.log`） | **逐条同构**（同一批路径，见 §4.4） |

`[实测]` `run.cmd .t\shim-delete\test-delete-capture.mjs --strict-deletions` → **exit 0，35 项断言全过**，
`candidate byOp={"delete":10,"create":12} delete=10 bogusWoCreates=0`
（证据 `.t\shim-delete\raw\strict-final.txt`）。

---

## 2. 根因（含 `file:line`）

白障标记**已经是**删除的权威落盘形式，但 `src\` 侧只认"暂存内容对象消失了"这一种删除信号，
于是两个错误同时发生：

### 2.1 `wo\` 被当成内容树遍历（标记被报成 create）

`src\workspace.mjs` 的 `walkStagedForHashes()`（修复前 `:137-207`）对整个 `<staging root>` 递归
hash 所有普通文件；`captureAfterExecution()`（修复前 `:1311-1329`）则以 `before === undefined`
判定 `created`。shim 在 `<staging root>\wo\C\…` 写下的**空文件标记**因此被报成"新建了
`wo\C\…`"。`[实测]` 原始候选（`.t\shim-delete\raw\before-candidate-fixer.json`，
即 ① 修复者的 `cs_0001_0533506e.json`）：

```json
"summary": { "files": 22, "byOp": { "create": 22 } },
"changes": [ …, { "path": "wo\\C\\Users\\…\\ext\\v1-ext.txt", "op": "create",
                 "before": { "hash": "absent" }, "after": { "hash": "e3b0c442…b855", "bytes": 0 } }, … ]
```

（`e3b0c442…b855` = 空内容的 SHA-256。22 个 create 里 10 个是 `wo\…`。）

### 2.2 从未暂存的路径**不可能**出现在执行前快照里

`src\cli.mjs:204` 在命令执行**之前**取快照：

```js
const before = workspace.snapshotStagedTree()   // src\cli.mjs:204
const execution = await executor.run({ … })
const captured = workspace.captureAfterExecution(before)   // src\cli.mjs:213
```

删除一个"工作区外、从未进过暂存树的真实文件"时，暂存树里**没有任何对象消失**
（`beforeSnapshot` 里本来就没有它），所以 `captureAfterExecution()` 的删除分支
（修复前 `:1322-1327`：`快照里有、现在没有`）永远命中不了它 → `ingested.deletions = 0`。
这不是 shim 能补的：标记写在 `<root>\wo\`，而快照早于命令执行。

### 2.3 逻辑删除 → 候选的那一段本来是通的

`ingestCapturedChanges()`（`:1548`）走的是既有删除语义：`remove(abs, {missingOk:true})`
（`:948`，`store.stagedPath()` `src\store.mjs:381-387`）把条目置为 `STATE.DELETED`，
`diffEntries()`（`:1076` 的 `op:'delete'` 分支）按"`baseHash !== absent` 或 `baseKind !== undefined`"
产出删除单元，`applyOneChange()`（`:1373`）在批准时 `rmSync` 真实路径。
因此缺陷**只**在于"删除信号没有抵达 `captureAfterExecution()`"，而非存储/审批语义有洞。

---

## 3. 改动

### 3.1 `src\workspace.mjs`（3 处，全部围绕"白障是状态、不是内容"）

1. **新增常量与逆映射**（`:118-157`）
   - `WHITEOUT_LEAF = 'wo'`：与 `shim\src\ws_stage.c:4-6 / :84-91` 的 provider 布局同构的注释
     （`<root>\wo\C\a\b` ← `C:\a\b`；`<root>\wo\_unc\server\share\x` ← `\\server\share\x`）。
   - `logicalFromWhiteoutMarker(woRoot, markerPath)`：`ws_fs_map()` 的逆映射；
     层级不足或首段既不是盘符也不是 `_unc` → `undefined`（**不猜路径**，调用方如实记入 `skipped`）。
2. **`walkStagedForHashes()`**（`:183-313`）
   - 顶层 `wo\` 目录**不再进入内容 hash**；改为 `walkWhiteouts()`（`:212`）单独遍历，
     只把**普通文件**当标记（`<root>\wo\C` 这种父链目录是 `ws_fs_map()` 丢盘符冒号的副产品，
     当成标记会把 `C:\` 整体判成已删除 —— `shim\src\ws_stage.c:99-115` 记过这条教训）。
   - 返回值多一个 `whiteouts: Map<compareKey(逻辑绝对路径), 逻辑绝对路径>`；
     `walkWhiteouts` 与 `walk` 共用同一套重解析点 / 环路 / 深度守卫，执行前快照与执行后捕获
     因此**不可能漂移**。
3. **`captureAfterExecution()`**（`:1444-1492`）与 **`snapshotStagedTree()`**（`:1522-1529`）
   - 快照把 `whiteouts` 挂在返回的 `Map` 上（`:1526`）；捕获时做**差集**，只把"这次新出现"的
     标记报成删除（`:1480-1489`）：

```js
// 新出现的白障标记 `wo\C\a\b` → 删除逻辑路径 `C:\a\b`
const beforeWhiteouts = beforeSnapshot.whiteouts instanceof Map ? beforeSnapshot.whiteouts : new Map()
for (const [whiteoutKey, logical] of whiteouts) {
  if (beforeWhiteouts.has(whiteoutKey)) continue     // 上一次 exec 留下的标记：不是这次的变化
  if (deletedLogical.has(whiteoutKey)) continue      // 与"内容对象消失"两面都留痕 → 只报一次
  if (lexicalInside(this.store.dir, logical) !== undefined) continue   // 沙箱自身存储不是用户内容
  const rel = lexicalInside(this.root, logical)      // 工作区内用相对键，工作区外用绝对键（S3a）
  changes.push({ path: rel === undefined ? logical : rel, hash: hashAbsent(), deleted: true })
}
```

   三条守卫各自的理由：
   - **去重**：同一个删除可能同时在 `wo\` 与"暂存对象消失"两个面上留痕（`[实测]`
     `.t\shim-delete\test-whiteout-capture.mjs` 的 `no-duplicate-for-two-signals`），
     只报一次，`删除 N 项` 不会虚高。
   - **存储守卫**：`.dshstage` 在 `maskOf()` 里一律判遮蔽（手册 #16.8），沙箱把
     自己的 blob/候选删了不是"用户内容变化"，不能变成待审候选。
   - **键空间**：工作区内 → 相对键（与工具面同一清单键），工作区外 → 规范化绝对键 + `external:true`，
     与 `diffEntries()` / `applyOneChange()` 既有口径一致。

### 3.2 为什么没改 `src\store.mjs` / `src\cli.mjs`

- `store.stagedPath()`（`src\store.mjs:381-387`）对相对键 / 绝对键的分派**已经**满足
  "反解出的真实路径"这一输入；`remove()` 的 `ensureEntry()` 会把**真实磁盘当前内容**
  记成 `baseHash`（`:752-755`），这正是删除候选 `before` 需要的（审批时 `STALE_BASELINE`
  才比得中）。
- `src\cli.mjs:254` 的 `删除 ${ingested.deletions} 项` 取的就是 `ingestCapturedChanges()`
  的返回值，删除信号一旦抵达就自然是非零，**不需要动 CLI**。
- 删除候选的落盘路径（`applyOneChange()` 的 `rmSync`，`:1373-1376`）与工作区内外两种键都兼容。

### 3.3 测试侧：`tests\file-cow-dispositions.mjs`

`[实测]` 修复前该套件 18 项里红 1 项，唯一失败恰好是本缺陷的陈旧期望：

```
FAIL c9  … failures=[c7b: File.Exists=false expected true]
CLOSED c7b  node fs.unlinkSync (DELETE access + SetFileInformationByHandle) returns success but the file is still readable
            deleteOk=true whiteout=present readBackAfterDelete=absent realIntact=true stagedCopy=absent
```

（证据 `.t\shim-delete\raw\cow-before.txt`；c7b 的**实际**观测早已是
`whiteout=present / readBack=absent`，只有断言还停在旧世界。）

改动（不放宽、不删案）：

1. `plan.statChecks` 的 c7b 从
   `{ expectExists: true, expectSize: contents.c7breal.length }` 改为
   `{ expectExists: false, expectDir: false }`（File.Exists=false 且 Directory.Exists=false，
   仍是一条**实判**，不是恒真）。
2. c7b 从 `gap('c7b', …)`（"记录在案、默认不计入失败"）提升为 `add('c7b', …)` **严格断言**：
   `deleteOk===true && whiteout 存在且 0 字节 && readBack===null && 真实文件字节不变 && 暂存副本已撤`。
   旧 `gapPresent` 判据（`wo===null && read===真实字节`）整条删除 —— 它现在只会在"缺陷复发"时成立。
3. 同步修正三处文字：文件头 c7b 条目（从 KNOWN GAP 段搬到严格用例段）、
   `disp` 展示注释（`no whiteout` → `whiteout written`）、c11 旁注。

---

## 4. 证据

### 4.1 前 / 后候选 JSON（同一探测脚本，只有 `src\` 不同）

**前**（① 修复者的运行，旧 `src`，`.t\shim-delete\run-mupoqkhj-2tw\…\cs_0001_0533506e.json`
副本 `.t\shim-delete\raw\before-candidate-fixer.json`）：

```json
"summary": { "files": 22, "hostOperations": 0, "byOp": { "create": 22 }, "bytes": 23487 }
// 其中 10 条： { "path": "wo\\C\\…\\ext\\v1-ext.txt", "op": "create", "after": { "bytes": 0 } }
```
CLI：`ingested={"ingested":22,"deletions":0}`。

**后**（本修复，`--strict-deletions --keep`，`.t\shim-delete\run-muppskth-a40\…\cs_0001_dc8184ad.json`
副本 `.t\shim-delete\raw\after-candidate-strict.json`）：

```json
"summary": { "files": 22, "hostOperations": 0, "byOp": { "delete": 10, "create": 12 }, "bytes": 23498 }
"changes": [
  { "path": "C:\\…\\run-muppskth-a40\\ext\\r3-move-src.txt", "op": "delete",
    "before": { "hash": "74bd80b3…a0281fb" }, "after": { "hash": "absent" }, "external": true },
  { "path": "v1-ws.txt", "op": "delete", "before": { "hash": "b5637601…2ce6d4d" }, "after": { "hash": "absent" } },
  … (共 10 条：8 个删除目标 + r3/r4 的源) …
]
```
CLI（`--json` 载荷）：`ingested={"ingested":12,"deletions":10,"skipped":[]}`。

### 4.2 四种删除形式端到端 + 人类可读 CLI 行

`[实测]` 独立证据运行 `.t\shim-delete\evidence-1b\`（`cmd del` / `cmd erase` /
`powershell Remove-Item` / `node fs.unlinkSync`，工作区外 5 个 + 工作区内 1 个从未暂存的真实文件，
其中一个被 `del` **两次**）。非 `--json` 的 CLI 输出（`.t\shim-delete\evidence-1b\raw\exec.txt`）：

```
$ cmd /c C:\…\.t\shim-delete\evidence-1b\probe.cmd
PS-OK
NODE-OK
PROBE-DONE

退出码=0 分类=ok 用时=2319ms
沙箱内提取到 9 项变化，并入清单 3 项，删除 6 项
已冻结候选 cs_0001_8bcfef62（9 个变更单元）→ 可用 review/apply 处理
```

`review`（`.t\shim-delete\evidence-1b\raw\review.txt`）——**真实路径、无 `wo\…` 伪条目**：

```
候选 cs_0001_8bcfef62  [pending]  9 文件 / 0 宿主操作
   delete  C:\…\evidence-1b\ext\e1-cmd-del.txt
   delete  C:\…\evidence-1b\ext\e2-cmd-erase.txt
   delete  C:\…\evidence-1b\ext\e3-ps-remove.txt
   delete  C:\…\evidence-1b\ext\e4-node-unlink.txt
   delete  C:\…\evidence-1b\ext\e5-never-staged.txt
   delete  e6-internal.txt
   create  fs\C\…\__PSScriptPolicyTest_….ps1        ← 见 §6.1（本次范围外的既有问题）
   create  fs\C\…\__PSScriptPolicyTest_….psm1
   create  shim.log
```

四个删除形式各自对应的 shim 调用链见 `docs\边界缺陷修复-①TS档删除绕过.md` §4.1
（`NtOpenFile` / `DeleteFileW` / `NtSetInformationFile` / `RemoveDirectoryW`）。

### 4.3 从未暂存的文件 → 恰好一条

- `evidence-1b`：`e6-internal.txt` 在探测脚本里被 `del` **两次**，`review` 里**只有一行**
  （第二次 `del` 时真实 open 失败 → 不再记标记 → 不重复报；去重也兜住"两面留痕"）。
- 聚焦用例 `.t\shim-delete\test-whiteout-capture.mjs`：外部真实路径 / 工作区相对路径 /
  暂存对象消失 + 标记并存（`staged-del.txt`）/ UNC 逆映射四种形态各断言一次；
  `no-duplicate-for-two-signals`、`unmappable-not-emitted`、`store-internal-marker-ignored`
  分别锁住去重、不可归因、存储守卫。

### 4.4 无回归（create/modify 不变）

- 聚焦用例 `plain-create-unchanged`：直接写进暂存树的内容对象仍然被报成 `created`
  且带原 hash；同一候选里 `create:1`，`apply` 后真实文件按内容写出。
- `[实测]` 同一探测脚本的前 / 后候选，**非 `wo\` 的 create 逐条同构**（去掉 `run-<id>` 前缀与
  随机后缀后完全一致）：6 条 PowerShell policy 临时文件 + `r1-node-child-write.txt` +
  `r1-ps-child-write.txt` + `r3-move-dst.txt` + `r4-ren-dst.txt` + `r2-carrier-write.txt` + `shim.log`
  = 12 条；前 22 = 12 + 10 个 `wo\…`，后 22 = 12 + 10 个 `delete`。

---

## 5. 验证清单（本机全部实跑）

| # | 命令 | 结果 | 证据 |
|---|---|---|---|
| 1 | `run.cmd .t\shim-delete\test-delete-capture.mjs --strict-deletions` | **exit 0**，`RESULT: PASS (35 checks)`，`delete=10 bogusWoCreates=0` | `.t\shim-delete\raw\strict-final.txt` |
| 2 | 四种删除形式端到端（`evidence-1b`） | CLI `删除 6 项`；`review` 6 条 delete 真实路径 | `.t\shim-delete\evidence-1b\raw\exec.txt` / `review.txt` |
| 3 | 从未暂存的文件 | 每个路径恰好 1 条；无 `wo\…` 伪条目 | 上表 + `test-whiteout-capture.mjs`（PASS 29） |
| 4 | `node tests\file-cow-dispositions.mjs` | **PASSED (19/19)**，c9 PASS、c7b PASS（严格） | `.t\shim-delete\raw\cow-final.txt` |
| 5 | `node tests\boundary-degraded-failclosed.mjs`（③ 的套件） | **PASS checks=57 failures=0 skips=0** | `.t\shim-delete\raw\boundary-final.txt` |
| 6 | create/modify 正常路径 | 聚焦用例 PASS；非 `wo\` create 前后同构 | `.t\shim-delete\raw\wo-unit-final.txt` |

追加：`.t\shim-delete\test-whiteout-capture.mjs` → `RESULT: PASS (29 checks)`（不需要 shim，
纯 Workspace API，可直接被 finisher 接进门禁）。

---

## 6. 未修 / 未实测（诚实声明）

1. **`fs\` 内容副本仍被当成暂存内容对象。** `[实测]` 候选里的 create 至今带着
   `fs\C\…\file` 这种前缀（见 §4.2 的 `review` 输出），这是"shim 的 `<root>\fs\` 内容树"与
   "工作区 `<root>\<rel>` 暂存树"两套布局并存造成的，**先于本缺陷存在**，
   也不在 ①b 的范围（①b 只要求删除可见）。本次只把 `wo\` 从内容 diff 里摘掉，
   `fs\` 的语义化（`fs\<盘符>\…` → 真实逻辑路径 + 内容）应作为独立一轮工作；
   本轮若顺手改它会同时改变 create 候选的形状（与"create/modify 与修复前一致"的验收相冲突）。
2. **未跑 `verify.cmd` / `autotest`**（任务要求，门禁由 finisher 持有）；未重生成
   `docs\源码基线.sha256`。
3. **PowerShell 偶发崩溃**（环境，不是本修复）：`[实测]` 本次第一次基线运行里
   `V3-inside`（`powershell Remove-Item` 工作区内路径）在
   `System.Management.Automation.Security.NativeMethods.WTGetSignatureInfo` 抛
   `AccessViolationException`（rc=-1073741819），该次 `whiteout:V3-inside` 红；
   同一脚本紧接着重跑即全绿（`.t\shim-delete\raw\baseline-nostrict.txt` 第一次失败、
   `baseline2.txt` PASS 33、`strict-final.txt` PASS 35）。这是 CLR/WinTrust 侧的偶发，
   与 `src\` 无关，但**会让 `--strict-deletions` 偶发红**，finisher 重跑时请留意。
4. `[未实测]` `apply` 一个"工作区外、从未暂存"的删除候选在**真实 CLI** 下的落盘
   （聚焦用例在 Workspace API 层做了：`apply-removed-real-ext-file` 等 4 项断言全过；
   真实 CLI 的 `apply` 未在 evidence-1b 上跑，以免占着 3080/并发门禁）。
5. `[推断]` UNC 白障（`wo\_unc\…`）在当前机器上无法端到端实测（本机没有可写的 UNC 共享），
   只在聚焦用例里以标记逆向验证（`unc-delete-candidate`；不存在的 `\\server\share` 目标
   按"幽灵删除不算变化"被正确丢弃，`unc-target-absent-control`）。

---

## 7. 复现命令

```bat
rem ①b 聚焦回归（无需 shim；29 项断言）
node .t\shim-delete\test-whiteout-capture.mjs

rem ① 的 shim 侧回归 + 候选删除数（本修复落地后 --strict-deletions 才是致命的）
run.cmd .t\shim-delete\test-delete-capture.mjs --strict-deletions

rem 人类可读 CLI 证据（删除 N 项 / review 行）
run.cmd src\cli.mjs exec --workspace .t\shim-delete\evidence-1b\ws --tier TS -- cmd /c C:\...\.t\shim-delete\evidence-1b\probe.cmd
run.cmd src\cli.mjs review --workspace .t\shim-delete\evidence-1b\ws

rem 相邻套件
node tests\file-cow-dispositions.mjs
node tests\boundary-degraded-failclosed.mjs
```

关键证据文件（全部留在 `.t\shim-delete\raw\`）：
`before-candidate-fixer.json` / `before-candidate-srcfix.json`（旧 `src` 的候选：22/19 个 create、
0 个 delete、含 `wo\…` 伪路径）、`after-candidate-strict.json`（新 `src`：`delete:10 create:12`）、
`after-candidate-evidence1b.json`、`strict-final.txt`、`wo-unit-final.txt`、`cow-final.txt`、
`boundary-final.txt`、`baseline2.txt`（旧 `src` 的 WARNING：`bogusWoCreates=10`）、
`../evidence-1b/raw/exec.txt`、`../evidence-1b/raw/review.txt`。

---

## 8. 收口（finisher，2026-10-02；本节 `[实测]`）

> **本节只做接线与复测，不重写上面的发现。**

### 8.1 门禁登记（本缺陷此前的唯一漏洞）

- `.t\shim-delete\test-whiteout-capture.mjs` 已**原样提升**为
  `tests\whiteout-candidate-capture.mjs`，并登记进**两张表**：
  `src\testrunner.mjs::OFFLINE_SUITES` 与 `verify.cmd` 的 `for %%S in (…)` 列表
  （逐项同序、同数；`tests\suite-wiring.mjs` 机器校验通过）。
- 提升时只做三处机械改动（见该文件头注释）：路径根 `.t\shim-delete` → `tests`；临时目录挪到
  `.t\whiteout-candidate-capture\`；检查标记改为 `✓`/`✗`（让运行器的标记计数口径与其余离线套件一致）。
  **29 项断言与判据一字未改。**
- 因为它不需要 shim、不需要沙箱，属离线档 ⇒ 从此"改坏了没人知道"的缺口关闭。

### 8.2 复测读数

- `node tests\whiteout-candidate-capture.mjs` → **exit 0、`RESULT: PASS (29 checks)`、29 个 `✓`**。
- 门禁整体：`verify.cmd` = **25 套件 / 1949 `✓` + 85 `[OK  ]` = 2034 标记 / `RESULT: ALL PASS`**
  （本套件贡献 29 个 `✓`）。
- 端到端（shim 侧）：`tests\delete-capture.mjs` **PASS (35 checks)**，
  `candidate byOp={"delete":10,"create":12} delete=10 bogusWoCreates=0` —— 即
  §1 摘要里"修复后 10 条删除 / 0 条 `wo\` 伪 create"在提升后的套件里**仍然成立**。

### 8.3 残余复核（口径不变）

- §6.1 `fs\…` 内容副本仍以 `fs\C\…` 前缀出现在 create 候选里（本轮 `delete-capture` 的
  `create=12` 仍含 `fs\C\…` 与 `shim.log`）—— **确认仍在**。
- §6.3 PowerShell 偶发崩溃（CLR/WinTrust 侧）：本轮 `delete-capture`（含 `Remove-Item`）与
  `file-cow-dispositions` 均一次通过，**未复现**；但这不改变"可能偶发红"的声明。
- §6.4/6.5 的 `[未实测]` 项（真实 CLI 的 `apply` 删除落盘、UNC 端到端）本轮**未新增证据**。
