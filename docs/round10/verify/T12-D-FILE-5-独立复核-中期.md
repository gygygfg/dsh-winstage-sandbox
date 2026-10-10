# T12 · D-FILE-5 候选独立复核（**中期**：count16 判 UNTESTABLE）

> 验证者：`exe`（只读审计，未改任何产品文件）。任务：`task-12`（`in_progress`；待 D99 v2 全量复核）。
> 候选：`.t\round10\shim\out-13d-count16\winstage-shim.dll` = `97CB71A27E056A8101C14D57675C2507288392A0DE8E1F0D554231889F8D2DA0` / 265,216 B / `.text` `c2f694c446ea687e6d66125d37cd88402b35b38aa316f404921e91852465f7f3` / exports 15
> 补丁：`.t\round10\shim\D99-nqaf-nqfaf-overlay.patch` = `29211B42…3E873837` / 12,231 B（CR=0）

## 0. 总判定

| # | 项 | 判定 |
|---|---|---|
| 1 | 独立度量 + apply 后 hex | **PASS**（与构建者 0 差异） |
| 2 | 红线审计（34 项） | **PASS 34/34** |
| 3 | ③ 独立复跑 | count16 = **UNTESTABLE（候选缺陷阻断）**；**干净 v2（count17）= PASS 7/7 ×2 轮**（§8） |
| 4 | ② 复核（registry） | 污染件轮 = **INVALID**（`OVERRIDE_DLL_SHA256_BEFORE=01ECE1E2…`）；**干净轮 `arm-t3-count17b` = PASS**（§8） |
| 5 | 封印面 | **PASS**（exit 0 / 115） |
| 6 | 补丁静态审计 | **PASS**（无 IOSB 误用 / 不就地改写 / 不 fail-closed / USHORT 不回绕）；**1 处致命：栈占用** |
| 7 | 本结论件 | 本文件 |

> **★ 候选身份变更（必读）**：`out-13d-count16`（`97CB71A2…`）→（**污染件 `01ECE1E2…` 已废弃**，见 §5b）→ **干净 v2 = `out-13d-count17` = `B451ABE3445F71FD3D457CD0DAE9757F85F4378B315DB542B960894406FF5EC3` / 265,216 B / `.text 9fed3919cf933c566eff9535c3aa36d1fe4c1439dc14f497a865674bbc9456bd`**。
> **我方已撤回一条读数**：我曾对**污染件** `01ECE1E2…` 跑出 `T12-D5-GATES ALL-PASS 7/7` —— **该读数作废**（其构建输入含未申报的 D-FILE-4 stage 2；Lead 已判 INVALID）。对**干净件**的门禁读数见 §8（等其车道轮）。

**根因判定**：`out-13d-count16` 使 TS 车道 **fail-closed**——载体 `powershell.EXE` 初始化期 `STATUS_STACK_OVERFLOW (0xC00000FD)`，**3/3 复现**，executor 回落 T1 ⇒ **拿不到任何有效 TS 车道读数**。候选记 **已废弃（载体崩溃）**；task-10/11/12 的 count16 结论一律 `not-run / UNTESTABLE`。
**根因终判（A/B 双向定案 + 我方重查）**：**无重入守卫导致的重入**为因；≈49 KB/调用为**放大器**（诊断件 A 只加守卫即救活载体且 7/7；诊断件 B 只缩栈仍 `0xC00000FD`）。机制链与实测键见 §6。

## 1. 项 1 · 独立度量（我方工具 `t5-metrics.mjs`，与广播逐项相等）

```
t9|out-13d-count16\winstage-shim.dll|265216|…|97cb71a27e056a8101c14d57675c2507288392a0de8e1f0d554231889f8d2da0|textSha=c2f694c446ea687e6d66125d37cd88402b35b38aa316f404921e91852465f7f3 textRaw=212480 exports=15
t9|…\winstage-inject.exe|159232|…|90423b966fc04db10325e9cef9ad6fb19ae4311bb52b072b327935586421b66a
t9|…\winstage-probe.exe|174592|…|2d5ff8065ec3751f37a70b9d44ad66e888421ecc88c0d716755451496accbda5
t9|D99-nqaf-nqfaf-overlay.patch|12231|…|29211b422934ab2680d7b1e5db2e2099e0ed1852ad884cb11cd4b2eb3e873837
```
**apply 链（我方在仓内 scratch 独立复现）**：`git show a7bc51e:shim/src/ws_file.c` ⇒ `4CF967E3…`/76,609 B（v2 态）→ `apply --check` rc=0 → `apply` rc=0 ⇒ **`9A003B947DD151F40DE654DF998855086DC6C92F0AD086FBFF74A9E4294F9A08` / 85,240 B**；`apply -R` rc=0 ⇒ **无损回 `4CF967E3…`**。与构建者声明**逐字节一致**。**差异 = 0**。
（方法学：必须在**仓内** apply——仓外会被本机 `core.autocrlf=true` 整文件改 CRLF，得假值。）

## 2. 项 2 · 红线审计 **34/34 ALL-PASS**
我方工具 `.t\round10\verify\t5\t5-redline-check.mjs`（已加入 count14/count15 与 D99 apply 后 `ws_file.c` 期望值）：
`shim/out`=`63808F51…`/257,024 B｜`ws_reg.c`=`F5695A95…`｜`ws_regstore.c`=`125CB9FF…`｜inject/probe 原件未动｜
**冻结候选 count2…count15（含 `count14`=`108CFD37…`/262,656、`count15`=`2240F2BB…`/262,656）全部未变**（sha+`.text`+exports）｜`shim/src` 无 `.rej/.orig`｜无换件窗口。原始输出：`.t\round10\verify\t5\t12-redline.txt`。

## 3. 项 5 · 封印面
`cmd /c "call run.cmd tools\baseline-sha256.mjs --check"` ⇒ `基线一致：115 个受封印文件与 docs/源码基线.sha256 逐条相符` / **exit 0**。

## 4. 项 3/4 · ③/② 为何 UNTESTABLE（原始行）

**两份彼此独立的车道证据**（均为被复核方自己写下的原始件）：
- **registry `…\arm-t3-count16\BLOCKER-transparent-probe-c16.json`**：
  `"shim-inject-canary" ok=false`；`reason` = `carrier-init-failed: injectorOk=true childExit=3221225725 (0xC00000FD); … carrierAttempts=3/3 carrierExits=[0xC00000FD,0xC00000FD,0xC00000FD] … Process is terminated due to StackOverflowException.`；`"shim-dll"` detail = **265216 bytes**（= count16）。
- **env-harness `.t\round10\fileio\d5\out-d5-c16\exec.json`**：
  `tierRequested="TS"` 但 **`tierEffective="T1"` / `launchMode="restricted-token"` / `transparentShim.available=false`**，`fallbackReason` 同上（3/3 `0xC00000FD`）。
- **单变量对照（同 runner/入口/时段，仅换 DLL）**：`…\BLOCKER-transparent-probe-c15.json` ⇒ `shim-inject-canary ok=true`、`injector exit=0 (0x00000000)` ⇒ **`0xC00000FD` 可归因到 D99**。
- 由此：`d5` 的 `CASE=… NQAF status=…` **是 T1（无覆盖层语义）结果**；其 `self=` 4 行来自**崩掉的 canary**，不是探针进程 ⇒ **不得作 ③ 依据**。

## 5. 项 6 · 补丁静态审计（我方独立读补丁 + 已 apply 源码）

| 审计点 | 判定 | 依据 |
|---|---|---|
| **无 IoStatusBlock 误用** | **PASS** | 补丁中 `IoStatusBlock`/`IO_STATUS_BLOCK` 出现 **3 次全在注释**（L11/L110/L166）；D99 helper/两包装区域内 `IoStatusBlock->` **成员访问 = 0 次**；whiteout 仅 `return 0xC0000034`，命中仅 `return ws_st`（真实 API 自己填 `FileInformation`） |
| 不就地改写调用方结构 | **PASS** | `OBJECT_ATTRIBUTES ws_oa = *ObjectAttributes;` + 本地 `UNICODE_STRING`（`Buffer` → 本地 `ws_nt`）；调用方结构只读 |
| 不 fail-closed | **PASS** | 出口穷举：`-1`（未解析/busy/空名/超长/`RootDirectory!=NULL`/仍在 NT 命名空间）⇒ 透传；`0`（未命中 **或** NT 形态不可信）⇒ 透传；`2` = 契约 whiteout；`1` ⇒ 调真实 API 并原样返回其 status |
| whiteout 不伪造成功 | **PASS**（风险同族） | 返回 `0xC0000034`（不存在），非成功；残留风险=provider 误判 whiteout 会伤真实盘 ⇒ 由 ③ 的真实盘负对照封口 |
| NT 形态三例 + 其它透传 | **PASS** | 已是 `\??\`（不重复加）/ 真 UNC ⇒ `\??\UNC\` / 盘符绝对 ⇒ `\??\`；`\\?\`、`\\.\`、`\Device\`、卷 GUID、相对名 ⇒ `nt_out[0]=0` 透传 |
| USHORT 回绕 / 越界 | **PASS** | `ws_nt` 由 `ws_append_w(…, WS_PATH_MAX, …)` 限长 ⇒ ≤4095 字符 ⇒ `Length ≤ 8190`、`MaximumLength ≤ 8192 < 65535`；`nz[n]=0` 有 `Length ≤ (WS_PATH_MAX-1)*2` 门 |
| 新增路径 I/O | **PASS** | 直接零新增（`GetFullPathNameW` 纯字符串；`ws_stat_resolve` 仅 lockdown 名族触发一次**只读**真实属性查询，属既有边界） |
| **栈占用** | **❌ 致命** | 每个包装 **3×`WS_PATH_MAX`**（3×8 KB = **24 KB**）+ helper **2×`WS_PATH_MAX`**（**16 KB**）**同时存活** ⇒ **单次 NQAF/NQFAF 调用约 40 KB 栈**；两 API 位于启动/装载热路径深栈处（c16 `shim.log` 最后一条即 PowerShell 装载 `System.Management.Automation.resources.dll` 的 `ATTRDBG-NQAF`） |

## 6. **重入/递归判断 —— 含"预测被证伪"与重查定案**（Lead 点名）

### 6.0 记录：我的可证伪预测**被实测证伪**
我先前预测：`dbg-smallframe` 应消除本次崩溃、`dbg-guard` 预期不能。**`lane-runner` 单变量两轮（同入口/同驱动/同 ws，只换 DLL）结果相反**，我逐字复核了两份 `exec.json`：

| 件 | 整件 sha256 / 字节 | `tierEffective` | `launchMode` | `fallbackReason` | `carrierExits` | 载体 |
|---|---|---|---|---|---|---|
| **A `dbg-guard`**（只加重入守卫，栈画像与 D99 **相同**） | `E7B396A9E5641A8D4429A13F4436D9682D63702B0882C0C2732B3CDF0B4AD7A5` / 265,728 | **TS** | **shim** | **缺席** | **缺席** | **存活**（3,240 ms，stderr 空，stdout 含 `D5_END`） |
| **B `dbg-smallframe`**（只把大缓冲移出栈，**无守卫**） | `2136F97369C9FE6AE7074E0E3D130300F7D99DD718325E84A580E84317C4CD81` / 306,176 | **T1** | **restricted-token** | 有 | `[0xC00000FD ×3]` | **仍崩**（342 ms） |

⇒ **"本次未走到递归"的结论作废**；**根因 = 无重入守卫**；≈49 KB/调用是**放大器而非成因**（B 单独不充分、A 单独充分）。

### 6.1 重查：用**正确的键**找到重入链（我方工具 `t12-reentry-scan.mjs`）
**我原先的排除键错了**：我用"同 `(pid|path)` 连续重复"=0，但**递归每层的路径都被解析链派生成新形态**（`…\staged\wo\…` / `…\staged\fs\…` / 逻辑名），所以那个键**天然看不见**路径派生化重入（Lead 的判断成立）。改用四个键后（同一用例，A 与 B/c16 唯一差异 = 守卫）：

| 键 | 含义 | **B（无守卫，崩）** | **c16（无守卫，崩）** | **A（有守卫，活）** |
|---|---|---|---|---|
| **K1** | 入参 `path=` **本身已是覆盖层路径**（`…\staged\{wo,fs}\…`）⇒ 该名字只可能由 shim 自己派生 ⇒ **就是重入** | **1,390 / 1,562（89%）** | **1,433 / 1,601（89%）** | 15,663 / 17,802（88%） |
| **K1 细分** | 这些重入调用在 helper 里的去向 | **`staged=0`：1,390（100%）**；`mapped=<none>`：**0** | **`staged=0`：1,433（100%）**；`mapped=<none>`：**0** | **`staged=-1`：8,019（51%）**（被守卫**拒于入口**，`mapped=<none>`）；`staged=0`：7,644 |

> ⚠️ **K1 细分的读法更正（我方自查；重要）**：我曾把崩轮的"`staged=0` 100%"读成"**继续解析并逐层递归**"——**这不准确**。对**落在 stageRoot 下**的覆盖层路径，`ws_stat_resolve` 会走 `ws_should_intercept` 的"stage 内直通"分支，得 `mapped=input`、`isStaged=0` 并**返回 0**（即"解析跑了但按直通规则拒绝"）。所以 `staged=0` 只说明**解析链跑了**，**不等于**"又派生了下一层"。
> **真正证明"嵌套重入"的是守卫轮的 `staged=-1` = 8,019 次**：`t_wsAttrBusy` **只有在另一次调用尚未返回时才可能为 1** ⇒ 这 8,019 条是**货真价实的嵌套到达**；而**崩轮同一位置的拒绝数 = 0**（守卫不存在）⇒ 嵌套到达被**照单接收**。两条合起来才构成"重入为因"的实测闭环。
> K2=0/maxDepth=1 也与此一致：**没有**"同一字段里层层重加 stage 前缀"的形态；重入是**经 provider 探针**发生的**一层（或少数层）嵌套**，而不是同一字符串的自叠加。
| **K2** | 单个字段里 `\staged\` ≥2 次（逐层重新前缀） | 0（maxDepth=1） | 0（maxDepth=1） | 0（maxDepth=1） |
| **K3** | 同 pid 内 `path == 更早某行的 mapped/nt`（链环） | **0** | **0** | **37** |
| **K4** | 同 pid 相邻 NQAF 行的 `seq` 间隔 | **median=1**（p10=1） | **median=1** | median=1（p90=3, max=25） |

### 6.2 机制链（源码 + 上述实测，已可判）
**重入**向量**已定名到源码行**（这比我早前"仅 lockdown 名族"的写法准确得多）：
`ws_NtQueryAttributesFile` → `ws_attrbyname_overlay` → `ws_stat_resolve` → `ws_resolve_file` → **provider `dp_file_resolve`（`ws_stage.c:131-168`）** → **`ws_marker_exists(wo)`（`:146`）与 `ws_exists(staged)`（`:150`）** → 二者内部都是 **`GetFileAttributesW(path)`（`ws_stage.c:99-124`）**，且传入的正是**覆盖层候选路径**（`<stage>\staged\wo\…` 的白out 标记、`<stage>\staged\fs\…` 的暂存副本）⇒ kernelbase 的 `GetFileAttributesW` 内部走 **`NtQueryAttributesFile`**，其 IAT 站点已被本 shim 挂钩 ⇒ **以该覆盖层路径重入我们的 NQAF 包装**（= K1 的 89% 入参形态：`path=\??\…\staged\wo\…`）。
1. 外层：外部（装载器/.NET，例 `…\wo\…\mscoree.dll.local`）调用 NQAF(逻辑名) → 包装（帧 ≈24.7 KB）→ helper → `ws_stat_resolve`（自带 `norm[]` 8 KB）→ provider 探针（上面两行）⇒ **内层重入**；
2. 内层：以覆盖层路径进入包装 → 再次分配 ≈24.7 KB + 16.4 KB + 8 KB；因路径在 stageRoot 下，`ws_stat_resolve` 走直通分支返回 0（`staged=0`、`mapped=input`）⇒ **该层不再派生**（与 K2=0 一致）；
3. **因此重入是"每外层调用至少一次内层到达"的有界嵌套，但每层 ~49 KB 且发生在启动/装载深栈处**；**无守卫**时这些内层到达被照单接收（崩轮拒绝数 = 0），**有守卫**时在入口即被拒（守卫轮 8,019 条 `staged=-1`）⇒ 环被切断、栈不再增长到溢出；
4. 对 Lead 三问的直接回答：**(a)** 派生链存在（K1 = 88–89% 的入参已是覆盖层派生形态，向量已定名到 `ws_stage.c` 探针）；**(b)** 复现间隔中位数 = **1 个 shim 序号**（背靠背嵌套，`p90=3`）；**(c)** 守卫在 **`ws_attrbyname_overlay` 入口 / NQIFBN 的解析调用前后**断开环——实测对照 = **"崩轮 0 次拒绝 vs 守卫轮 8,019 次拒绝"**。
5. `dbg-smallframe` 把每层帧压小（pkgs 实测其 3 个 D99 大帧消失），**但仍崩** ⇒ **栈只是放大器**；**守卫单独充分**（A 件 7/7）。

### 6.3 栈量化（仍然成立，作为放大器）
| 项 | 字节 | 来源 |
|---|---|---|
| `ws_NtQueryAttributesFile` / `ws_NtQueryFullAttributesFile` 帧 | **24,720** ×2 | 3×`wchar_t[WS_PATH_MAX]` = 24,576 + 帧开销（我方扫描：该尺寸**恰在 count16 新增**） |
| `ws_attrbyname_overlay`（共享 helper）帧 | **16,432** ×1 | 2×`wchar_t[WS_PATH_MAX]` = 16,384 + 开销 |
| `ws_stat_resolve` 的 `wchar_t norm[WS_PATH_MAX]`（`ws_file.c:850`） | **8,192** | 同链存活 |
| **单次 NQAF/NQFAF 最坏栈开销** | **≈49,344 B ≈ 49 KB** | 合计 |
**独立复算**（`.t\round10\verify\t12\t12-framescan.mjs`，**不复用** pkgs 的 `stackscan.mjs`）：扫 `mov eax,imm32(B8) → call ___chkstk_ms(E8) → sub rsp,rax(48 2B C4)`；`count15` = `sub rsp,rax` **82** 站点（无 `24,720`、`16,432` 仅 ×4）；`count16` = **85（+3）**，新增 **`24,720B ×2` + `16,432B ×5（+1）`** ⇒ 与 pkgs 逐项吻合。⚠️ 我先前"≈41 KB"**漏计**了 `ws_stat_resolve` 的 8,192 B ⇒ 已更正为 **≈49 KB**（pkgs 先给出，我复算确认）。
**非判据观察**：最大帧 `196,808 B` 是**既有代码**（count15 也在）⇒ 帧大本身不致命；且 **B 证明"缩栈"单独不充分** ⇒ 判据只能是"重入守卫 + 栈画像"两项。**

### 6.4 结构性推论（保留，供缺陷记录）
> **`out-13d-count15`（NQIFBN v2）之所以安全，只是因为当时 `NQAF`/`NQFAF` 仍是 pass-through**：`kernelbase!GetFileAttributesW` **不会**回调 `NtQueryInformationByName`，故那个环不闭合。**D99 一旦让 `NQAF` overlay 感知，环就闭合了**——**这是"给同族 API 逐个加 overlay 感知"路线的结构性约束**。**`ws_GetFileAttributesW`（已采纳路径）自身就调 `ws_real_attrs_w`（`:912`），距此环只差一步**。
> **本次修正（我先前只说"lockdown 名族"）**：环**不限于** lockdown 名族——实测 K1 证明重入由**覆盖层路径**触发（provider/`ws_real_attrs_w` 对 overlay 候选路径的真实查询），与 `__PSScriptPolicyTest_*` **无关**（那些名字 0 命中）。⇒ 我已建议 `line-d4` 在 `D-FILE-7` 里把"触发面"从"lockdown 名族"改为"**任一使 `ws_real_attrs_w` 以覆盖层路径落到 kernelbase 的调用**"，守卫位置 = **helper/包装入口**（`_Thread_local` 计数）。
> **（task-18 定稿，2026-10-10）**：`D-FILE-7` 已按上述更正**定稿**为 **已修复 / 已验证（v2，提交 `3144719`）** ⇒ 正文见 `docs/round10/fileio/defects.md` 的 `D-FILE-7` 段落（含机制行号 `shim/src/ws_stage.c:99-124/131-168/146/150`、量化 89%/8,019/median=1/≈49 KB 非因果、单变量 A/B、**在野外佐证**、与 `D-FILE-2` 的区分、证据清单）。
> **在野外佐证（本条新增，我方实测）**：`count18`（含守卫）TS 车道轮 `ATTRDBG-NQAF` 中 `staged=-1`+`mapped=<none>` = **8,252** 条，逐行是**派生形态（`…\staged\wo\…` / `…\staged\fs\…`）被入口拒绝**、`status=0xc000003a`（= 透传给真实 API 的真实结果）⇒ 守卫在生产形态下的现场表现；对照 `count15`（NQAF 尚 pass-through）同规格日志该字段 **0 条**（**旧格式字段根本不存在**，而非"解析了却没拒绝"）⇒ 两者**不是同一量，勿误读**。原始件：`.t/round10/shim/d4/stage-count18-s2/staged/shim.log`（`00BE9168…`）、`.t/round10/fileio/d5/stage-d5-b15/staged/shim.log`（`A42F8516…`）。

## 7. 三条口径更新（Lead 2026-10-10 裁定，已登记备 v2 使用）
1. **一等门禁「载体安全」**：`tierEffective=TS` **且** `fallbackReason` 为空 **且** `carrierExits` 无 `0xC00000FD` —— 与四条件/③ 门禁**并列**。
2. **中间态严键**（宽键作废）：`staged=0` **且** `mapped` 指向覆盖层 `…\staged\fs\…` **且** `path` 不在 stage 内 ⇒ 才算"想修但没修成"；`mapped == path` 一律记"无覆盖层副本（正常透传）"。
3. **剔除探针用例**：`\??\C:\.` 对这两个 API 返回 `0xC0000033`（NAME_INVALID），修前/候选同值 ⇒ 属探针命名形态问题，**不作为判据**。

## 8. **干净 v2（`out-13d-count17` = `B451ABE3…`）全量复核结果**

### 8.1 七项判定
| # | 项 | 判定 | 我方原始读数 |
|---|---|---|---|
| 1 | 独立度量 + apply 链 | **PASS · 0 差异** | 整件 `B451ABE3445F71FD3D457CD0DAE9757F85F4378B315DB542B960894406FF5EC3` / **265,216 B** / `.text` `9fed3919cf933c566eff9535c3aa36d1fe4c1439dc14f497a865674bbc9456bd`(raw 212,480) / exports **15**；inject `A09386B3…`、probe `3B5AA34A…`；补丁 `EB6553EC…`/10,161 B；**仓内 apply 复现**：`9A003B94…`(85,240) + D99-v2 ⇒ `9826329B…`/87,118 B（= 树值，`--check`/`apply` 均 rc=0） |
| 2 | 红线 34 项 | **PASS**（33 恒等 + 1 预期） | `shim/out`=`63808F51…`/257,024；`ws_reg.c`=`F5695A95…`；`ws_regstore.c`=`125CB9FF…`；**`ws_hook.c`=`3E2EBEE6…`（已复原，不含 D-FILE-4）**；冻结候选 count2–count15（含 `count14`=`108CFD37…`、`count15`=`2240F2BB…`）全等；inject/probe 原件未动；无 `.rej/.orig`。唯一 FAIL = REFERENCE `ws_file.c`=`9826329B…`/87,118 B（**v2 APPLIED，预期**） |
| 3 | ③ 独立复跑（7 门） | **PASS 7/7 ×2 轮** | 两轮干净车道（`out-d5-v2-gate` 18:15 / `out-d5-v2b` 18:16，均 `dll_bytes=265216`）：G1 `TS/shim`/fallback 空/无 `C00000FD`；G2 30 行 `self=…out-13d-count17…ok=1`；G3 NQAF 17,802–18,694 / NQFAF 2,691；G4 命中 **33**（NQAF 20 + NQFAF 13，`nt=\??\`、`staged=1 status=0x0`、`badStaged1=0`）；G5 whiteout **2**；G6 真实盘 **20 行/6 成功**；G7 严键 **0** |
| 4 | ② 复核（干净轮 `arm-t3-count17b`） | **PASS** | 我方自算：`step2a`=`step2b`=`step3` = `12AA39D1F31AF899C625CDB0D7DB384F86F394262801252D5334FADE863972CB`/78 B；`step1a`=`44992831…`/40 B；四轮 t1–t4 `query-value-exit=0` + `query2-value-exit=0` **4/4**；门禁 `applied=5 auditSkipped=0 bytes=480 rc=0` 在（22 处）；`self=` 唯一 = `out-13d-count17\…ok=1`；provenance `BEFORE=AFTER=B451ABE3…`、`HASH_STABLE_DURING_RUN=True`、`SHIM_OUT_UNTOUCHED=True`、`EXEC_EXIT=0`；`logs\shim.log` = 15,132,072 B / `12DBD048…` |
| 5 | 封印面 | **PASS** | `基线一致：115 个受封印文件…逐条相符` / **exit 0** |
| 6 | 静态审计（含守卫早退/漏清位、NQIFBN 守卫语义、无 IOSB 误用、USHORT、fail-closed） | **PASS** | 见 §6.5；**1 条文档级不一致**：v2 补丁注释仍写"仅 lockdown 名族"触发（实测向量是 provider 探针，见 §6.2），**不影响 `.text`/行为** |
| 7 | 结论件 + 差异清单 | **PASS** | 本文件 |

### 8.2 与**诊断件 A**（`E7B396A9…` / `.text 59bbac56…` / 265,728 B，7/7）的**逐项差异清单**
| 门 | A（dbg-guard，诊断件） | 干净 v2（count17，候选） | 差异 |
|---|---|---|---|
| G1 | PASS（TS/shim/空/[]/canary=true） | PASS（同） | **无** |
| G2 | PASS（30 行，self=dbg-guard） | PASS（30 行，self=count17） | 仅注入件路径不同（预期） |
| G3 | PASS（NQAF 17,802 / NQFAF 2,691） | PASS（17,802–18,694 / 2,691） | **仅 NQAF 行数随 run 流量浮动**，非语义差异 |
| G4 | PASS（33 = 20+13；badStaged1=0） | PASS（**33 = 20+13**；badStaged1=0） | **无**（数值逐项相同） |
| G5 | PASS（2） | PASS（2） | **无** |
| G6 | PASS（20 行 / 6 成功） | PASS（20 / 6） | **无** |
| G7 | PASS（0） | PASS（0） | **无** |
**`.text` 不同属预期**：A = `59bbac56…`(raw 212,992) vs v2 = `9fed3919…`(raw 212,480) —— v2 多含 **`ws_NtQueryInformationByName` 守卫**（2 处 hunk：入口条件 + 包裹 `ws_stat_resolve`），且守卫实现形态与 A 的 `do/while(0)` 版本不同 ⇒ 代码不同、**行为面读数逐项相同**（尤其 G4/G5/G6 的 33/2/20/6 完全相同 ⇒ **NQAF/NQFAF 语义未被 v2 改动**，v2 只在 NQIFBN 路径加守卫）。
**方法学提醒（已遵守）**：A 是**诊断件、非候选**；上表只作**对照**，v2 的 PASS 全部来自 count17 自己的车道轮读数。

### 8.3 递归演示件（Lead 点名的"一等对照"）—— 我方从原始件复核
对象：`D99-v2-demo-lockdown-caller.exe`（`DB02984D…`/151,552 B）跑进 **TS 车道**，轮次 `out-d5-v2b-demo`（由 `lane-runner` 执行、用其自有驱动 `d5-demo-driver.cmd`）。
**我方从 `exec.json` 原始件逐字读**（非转述）：
```
D5DEMO_RC=0
DEMO pid=7440 name=\??\C:\…\ws-d5\probe\__PSScriptPolicyTest_d99demo.ps1
DEMO NtQueryAttributesFile     status=0xC0000034  returned => loop TERMINATED
DEMO NtQueryFullAttributesFile status=0xC0000034  returned => loop TERMINATED
DEMO_END
```
车道事实（我自己解析）：`tierEffective=TS`（出现 1 次）、`launchMode=shim`（1 次）、**`C00000FD` = 0 次**、`execution.exitCode=0`、`exec.err` = 0 B、`cli.rc=0`。
⇒ **两条 `status=` 都有值且 `DEMO_END` 出现** = 守卫把"lockdown 名族触发的重入环"**就地终止**（同一演示件在无守卫的 D99/count16 上按作者设计会死于 `0xC00000FD`、打不出 `DEMO_END`）。**残留说明**：本轮由 `lane-runner` 执行、用其驱动；我方已冻结一份等价驱动 `.t\round10\verify\t12\d99-demo-driver.cmd`（`76B140A17021038B931A90C80CADA798443F321727D3B6CC5EC23539C979DFC2` / 660 B / 非 ASCII=0）备用，**本轮未使用**（避免无谓重复轮次）。
> **调用形态更正（`lane-runner` 指出，我方记录）**：冻结的 `cli-run.cmd` **只取 5 个参数** `<dll> <stage> <ws> <out> <driver>`；我先前消息里多写的第 6 个 `<evdir>` **会被忽略**。我的驱动**不使用**该参数（其 `EV` 仅为占位、默认 `.`），故按 **5 参数形式**调用即可，无功能影响。**这一条已写入以备后人别再写错。**

## 5b. **污染事故的独立观察**（Lead 指派）+ 防复发护栏

**事故**：`out-13d-count17` 的**第一次**构建（`01ECE1E2…` / 266,240 B / `.text 31630977…`，18:08:01）把 `line-d4` 于同时刻落树的 **D-FILE-4 stage 2**（`shim\src\ws_hook.c` = `1C14AB54…`）**编了进去**，而交付声明只提 D99 v2 ⇒ **候选身份与实际输入不符**。Lead 判其**污染件**，基于它的 `out-d5-v2` 等一切车道读数 **INVALID**。

**我方独立观测（均出自我自己的测量，非转述）**
| 时刻（本地） | 我的观测 | 含义 |
|---|---|---|
| 18:09 | 污染件：`01ECE1E2…` / **266,240 B** / `.text 31630977…` | 我方**当时已记录**该哈希与尺寸（该文件**其后被覆盖**，此记录是仅存的原始痕迹之一） |
| （同期） | 树：`ws_file.c` = `9826329B…` / 87,118 B | v2 源码身份 |
| 18:13 | **干净重建**：`B451ABE3…` / **265,216 B** / `.text 9fed3919…`（build-logs 18:12:53–57） | 同 `ws_file.c`、`ws_hook.c` 已复原 |
| 18:13 | `ws_hook.c` = **`3E2EBEE6…`** / 36,375 B（基线值） | 复原已生效 |
| 18:13 | `treesha.mjs` ⇒ `c88909ae…` / 12 文件；**我另用独立序列化**（sorted `name\|sha256\|size`）算得 `E216F467…` / 12 文件，逐文件哈希含 `ws_hook.c=3E2EBEE6…`、`ws_file.c=9826329B…` | 两法**同源一致**（不同序列化 ⇒ 摘要值不同属预期） |
**独立证据（不依赖任何一方的自述）**：**同一份 `ws_file.c`（`9826329B…`）下，污染件 266,240 B vs 干净件 265,216 B，差 +1,024 B**；两份构建之间**唯一的源码差**就是 `ws_hook.c`（`1C14AB54…` → `3E2EBEE6…`）⇒ **尺寸差本身就是"hook 改动被编入"的独立指纹**（与 pkgs 的 zig 对象缓存证据 `ws_hook.obj` 17:49:35/55,804 B → 18:08:00/58,758 B 互证；其记录见 `.t\round10\shim\count17-contamination-report.txt`）。**说明**：我未能在本机找到 zig 缓存目录（我查的 4 个候选路径均不存在）⇒ 那一条我记为"**转述 pkgs**"，**不冒充我复现**。

**我建议的防复发护栏（4 条，供终版纪律）**
1. **构建输入指纹必须在广播里**：候选播报 = 整件 sha + `.text` sha + **`shim/src` 全树指纹**（pkgs 已加 `treesha.mjs`）+ 补丁 sha。**缺树指纹的候选不得进入验收。**
2. **构建窗口 = 源码写者互斥**：任何"落树源码"的改动与"构建"不得重叠；建议在共享任务板上以**显式时间窗 + 占用者**登记（本次事故根因正是**写者未串行化**）。
3. **对象缓存要可审计**：构建记录里落**被触翻译单元的缓存 obj 尺寸/mtime**（或每次构建用独立缓存目录），让"编进去的是哪份 obj"事后可查。
4. **废弃件留痕**：污染件被覆盖后只剩口头哈希 ⇒ 建议把废弃件**改名留档**（如 `retired-<sha8>-winstage-shim.dll`）或至少把"哈希+尺寸+mtime"写进构建记录；本次这两项**恰好被我方独立记下**，才得以在报告里给出尺寸差指纹。

## 6.5 守卫类改动的**静态审计**（Lead 点名："早退路径是否会漏清位 → 永久透传"）
对象：`D99-v2-guard.patch`（`EB6553EC…`，184 行全文已读；`t_wsAttrBusy` 共 8 处）。

| 审计点 | 判定 | 依据 |
|---|---|---|
| helper 是否"单一清位点" | **PASS** | `t_wsAttrBusy = 1;` 后进入 `do { … } while (0)`，**所有出口都是 `break`**（`ret = -1/-0/2/0/1; break;` 见 L94/115/126/130/151/154），循环后**唯一** `t_wsAttrBusy = 0; return ret;` |
| 是否存在"置位后早退漏清" | **PASS（无）** | 该 helper 内**没有任何 `return`** 位于置位之后、清位之前；入口检查的 `return -1` 发生在**置位之前** |
| NQIFBN 侧是否漏清 | **PASS** | `t_wsAttrBusy = 1; int ws_wo = ws_stat_resolve(...); t_wsAttrBusy = 0;` **紧密包裹、其间无 return**；随后的 `if (ws_wo) { … return … }` 在**清位之后** |
| 嵌套调用会不会误清别人的位 | **PASS** | 重入的 helper 在**入口**因 `t_wsAttrBusy` 为真即 `return -1`，**从不触碰标志** ⇒ 不会提前清位 |
| 入口是否同时看两个守卫 | **PASS** | 入口条件 `!have_orig \|\| t_wsFileBusy \|\| t_wsAttrBusy \|\| !ObjectAttributes`；NQIFBN 入口亦加 `!t_wsAttrBusy` |
| **是否"零语义变化"？** | **不是**（如实说明） | 这是**有意的 fail-safe 语义守卫**：**嵌套**的按名查询改为**透传**（= 修复前行为），而**顶层**调用（正常入口 `t_wsAttrBusy==0`）行为**不变**。**残留权衡（需记录）**：若某"窗口内合法嵌套调用"本应得到覆盖层答案，守卫会使其得到真实盘答案；考虑嵌套发生在解析窗口内部，判为可接受。 |
| 注释与实测是否一致 | **不一致（文档级，非阻塞）** | v2 补丁注释（L11–14）仍把触发面写成「仅 `ws_is_lockdown_probe`」+「触发名族 `__PSScriptPolicyTest_*`/`__PSAppLockerTest__`」，而 §6 的 K1 实测显示向量是 **provider 探针**（`dp_file_resolve`（`ws_stage.c:131-168`）→ `ws_marker_exists`/`ws_exists`（`:146`/`:150`）→ `GetFileAttributesW`（`:99-124`））。**注释不影响 `.text`/行为**，建议在 v2 正式入册时按实测改写该注释（或在结案文里加一句更正）。 |
