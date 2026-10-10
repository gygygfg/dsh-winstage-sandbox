# D-FILE-4 阶段2 · **③ 车道判定**（tag `count18-s2`，候选 `out-13d-count18`）+ 预登记的两处事后更正

> 判定者：`line-d4`（task-14）｜2026-10-10｜执行与原始件：`lane-runner`（只逐字回报）｜期望值表（跑前冻结）：`docs/round10/shim/D4-阶段2-车道期望值表-count18.md`（`07A9A143…`）
> 候选：`out-13d-count18\winstage-shim.dll` = `BDF0672C449B7C70C7EB0B432068BA3DCBE40B67E312B45C74507E2CADA50AF7` / 266,240 B（= v2(D99+guard) **+ D4S2**）
> 机算档案：`.t/round10/shim/d4/D4S2-count18-s2-analyze.txt`（`37475439…`，修正标签后 **`VERDICT ALL-MATCH`**）

---

## 0. 判定速览

| # | 项 | 判定 |
|---|---|---|
| 1 | **接受面（本次应变的 2 条）** | ✅ **PASS**：`ordinal-nq` `ATTRDBG-NQIFBN 0→3` 且 `gpa` 落在 shim 模块；`wrongmod-nq` `3→0` 且 `ptr=0000000000000000`、**无 CALLCALL** |
| 2 | **护栏（必须不变的 5 条 + `identity` 不变式）** | ✅ **PASS**：计数/状态/同址全部与预登记一致 |
| 3 | **负对照（必须仍 0 命中且指针仍真身）** | ✅ **PASS**：`manual-nq`/`rawgpa-nq`/`rawldr-nq` 均 `NQ=0` + 真身 + `st=0xC000003A`；`manual-w` `W=0` + 真身（attrs 见 §3 更正） |
| 4 | 载体安全 / 注入 / 档位 | ✅ `tierEffective=TS`、`launchMode=shim`、`fallbackReason` 缺席、无 `0xC00000FD`、`exec-stderr.txt`=0 B；24 行注入、`self=…out-13d-count18… ok=1` |
| 5 | **两处"不符预期"** | ⚠ **均为我方预登记口径问题，不是产品缺陷**：① `manual-w` 的 `attrs`（§3）；② `owner` NULL 标签（§3）。**冻结表不改**，更正另记 |
| 6 | **本轮的附加收获** | ✅ 原始行**独立复核了 `D-FILE-7` 的机理与守卫**（§4） |

**结论**：`D4S2` 的 ③ 行为验收**在预登记接受面上 PASS**；② 零语义与封印面/红线不在本文件范围（由 `registry`/`exe` 与 Lead 的读数为准）。

---

## 1. 逐路由：预登记 vs 实测

`W` = 夹具路径上的 `ATTRDBG-W` 行数；`NQ` = `ATTRDBG-NQIFBN` 行数；均按**前缀 pid** 归属（一进程一路由）。

| 路由 | 预登记（count18） | 实测（`lane-runner` 原始 + 我方机算） | 判 |
|---|---|---|---|
| `identity` | `static(iat-slot)` 与 `gpa` **同址**、owner=shim；`manual*` owner 真身；`ordinal=495`；ntdll-export 六行 | `NQIFBN`：`6FBF5420`（static）== `6FBF5420`（gpa）**同址**；`W`：`6FBF3890` 同址；`GetProcAddress manual`→KERNELBASE；`LdrGetProcedureAddress manual`→ntdll；六行 export 行不变 | ✅ PASS |
| `static-w` | `W=3`、`attrs=0x20` | `W=3`；`attrs=0x00000020 err=183` ×3 | ✅ PASS |
| `gpa-w` | `W=3`、`attrs=0x20` | `W=3`；`RESOLVE owner=…count18`；`attrs=0x20 err=0` ×3 | ✅ PASS |
| `manual-w` | `W=0`（**我错写的 attrs 期望见 §3**） | `W=0`；`RESOLVE ptr=…KERNELBASE 真身`；`attrs=0x00000020 err=0` ×3 | ✅ PASS（按更正后口径：**只判 `W=0` + owner=真身**） |
| `static-nq` | `NQ=3`、`staged=1 status=0x0 class=77` | `NQ=3`；3 行全 `staged=1 status=0x0 class=77`；`st=0x0` ×3 | ✅ PASS |
| `gpa-nq` | `NQ=3`、`staged=1 status=0x0` | `NQ=3`；同上；`st=0x0` ×3 | ✅ PASS |
| `manual-nq` | `NQ=0`、owner=ntdll 真身、`st=0xC000003A` | `NQ=0`；`owner=ntdll.dll`；`st=0xC000003A` ×3 | ✅ PASS |
| `rawgpa-nq` | `NQ=0`、两个 owner 均真身、`st=0xC000003A` | `NQ=0`；resolver→KERNELBASE 真身、结果→ntdll 真身；`st=0xC000003A` ×3 | ✅ PASS |
| `rawldr-nq` | `NQ=0`、owner=ntdll 真身、`st=0xC000003A` | `NQ=0`；resolver 与结果均 ntdll 真身；`st=0xC000003A` ×3 | ✅ PASS |
| **`ordinal-nq`（★应变）** | `NQ 0→3`；`gpa` 落 shim；`st=0x0` | `NQ=3` 全 `staged=1 status=0x0 class=77`；`RESOLVE … ordinal=495 raw=00007FFB63745230 gpa=000000006FBF5420 owner=…out-13d-count18\winstage-shim.dll`；`st=0x00000000` ×3 | ✅ **PASS（item ii 生效）** |
| **`wrongmod-nq`（★应变）** | `NQ 3→0`；`ptr=0`；无 CALLCALL | `NQ=0`；`RESOLVE … hmodule=kernel32 ptr=0000000000000000`；新增行 `RESOLVE route=wrongmod result=NULL (real loader semantics)`；**无 CALLCALL**（本轮 CALLCALL 总数 36→33，差 3 恰好=该路由的 3 次调用） | ✅ **PASS（item i 生效）** |
| `mixed-nq` | `NQ=6`、`st=0x0` ×6 | `NQ=6`；3 static + 3 gpa 全 `st=0x00000000` | ✅ PASS |

**判读纪律**（已遵守）：只按前缀 pid、`W` 只数夹具路径、**不看 `err=` 残留**、跨构建只比 owner；活性正对照 = `static-w`/`static-nq` 命中（本轮两者均命中 ⇒ 0 行是真阴性）。

---

## 2. 接受面判定（逐字证据）

```
RESOLVE route=ordinal api=NtQueryInformationByName ordinal=495 raw=00007FFB63745230 gpa=000000006FBF5420 \
        owner=C:\…\out-13d-count18\winstage-shim.dll
CALLCALL tag=ordinal-nq api=NtQueryInformationByName class=77 st=0x00000000 iosb=0x00000000   ×3
[winstage-shim][9460][13] ATTRDBG-NQIFBN pid=9460 … path=C:\…\ws-count18-s2\probe\d4-fixture.txt \
        mapped=C:\…\stage-count18-s2\staged\fs\C\…\d4-fixture.txt nt=\??\… staged=1 status=0x0 class=77 seq=8
```
```
RESOLVE route=wrongmod api=NtQueryInformationByName hmodule=kernel32 ptr=0000000000000000 owner=<not-in-any-module>
RESOLVE route=wrongmod result=NULL (real loader semantics)
（该 pid 8652 无 CALLCALL、NQIFBN=0）
```
**① 序数路由**：`gpa` 由"ntdll 真身"变为"**shim 包装**"（`raw=` 仍真身——私有解析本就绕开包装，本阶段不修），且包装确实被调用进日志（3 行 `staged=1 status=0x0`）。
**② 发明导出**：`ptr` 全 0 + 显式 `result=NULL` + **一次真实调用都没发生**（0 CALLCALL、0 日志行）⇒ 与真实 loader 语义一致。
**③ 无越界**：`manual-*`/`rawgpa`/`rawldr`/`ordinal-496` 与两个非覆盖名（离线核）**全部仍为真身**，无一被"顺带"改写。

---

## 3. 预登记的两处**事后更正**（我方口径问题；冻结表不改，另记于此）

### 更正 A：`manual-w` 的 `attrs` 期望（**我错**，不是产品差异）
- 我按阶段 1（count15）读法写死 `attrs=0xFFFFFFFF err=3`。实测 count18 为 `attrs=0x00000020 err=0`，且**两份基线（`stage-c15`/`stage-adopted`）都确为 `0xFFFFFFFF`**（`lane-runner` 独立逐行对照、我方复核一致）。
- **正确口径**：该行只判 **`W=0` + `RESOLVE owner=KERNELBASE.dll`（证明绕开了我们的 W 包装）**；`attrs` **不是**该路由的判据（其值由内核层是否被钩住决定，见 §4）。
- 夹具暂存状态已独立核实无误：真实盘 `ws-count18-s2\probe\d4-fixture.txt` **不存在**；覆盖层副本存在（20 B）⇒ 0x20 **不是**"真实盘上恰好有文件"。

### 更正 B：NULL owner 的字符串标签
- 我在表里写 `owner=<NULL>`（那是我**离线**探针的输出）；**车道探针** `d4-probe.c` 的 `owner_of()` 对 NULL 打印 `owner=<not-in-any-module>`（无 NULL 特判）。
- **正确判据**：`ptr=0000000000000000` **且** 有 `result=NULL (real loader semantics)` 行 **且** 无 CALLCALL ⇒ 两种标签都算成立。
- 已修正机算档案 `analyze-count18.mjs`（`E48AFD13…`）：接受 `<NULL>` 与 `<not-in-any-module>` 两种写法 ⇒ 重跑得 `VERDICT ALL-MATCH`（`ASSERT wrongmod-nq … PASS`）。

---

## 4. `manual-w` 的机理（**并独立复核了 `D-FILE-7`**）

`manual-w` 直接调用**真身** `kernelbase!GetFileAttributesW`（`RESOLVE owner=KERNELBASE.dll`），所以**没有** `ATTRDBG-W` 行（`W=0` ✓）。但 kernelbase 内部走 `NtQueryAttributesFile`——**该 IAT 站点已被挂钩**，而 count18 的 NQAF 包装**已 overlay 感知（D99）**，于是这条"私有解析"仍拿到覆盖层答案。原始行（pid 6472，每次调用一组）：

```
[winstage-shim][6472][11] ATTRDBG-NQAF … path=\??\…\staged\wo\C\…\ws-count18-s2\probe\d4-fixture.txt mapped=<none> nt=<none> staged=-1 status=0xc000003a class=0
[winstage-shim][6472][12] ATTRDBG-NQAF … path=\??\…\staged\fs\C\…\ws-count18-s2\probe\d4-fixture.txt mapped=<none> nt=<none> staged=-1 status=0x0      class=0
[winstage-shim][6472][13] ATTRDBG-NQAF … path=C:\…\ws-count18-s2\probe\d4-fixture.txt mapped=C:\…\staged\fs\C\…\d4-fixture.txt nt=\??\…\d4-fixture.txt staged=1 status=0x0 class=0
（×3 组，seq 8/13/18；随后 CALLCALL attrs=0x20）
```

### 4.1 ★ 决定性 A/B：**count15 基线同一路由也回落到同一个已钩 NQAF**

**同一路由（`manual-w`）、同一夹具状态（两轮覆盖层副本都是 20 B、真实盘都不存在）、同一个已钩 NQAF**；唯一变量是 **NQAF 包装是否 overlay 感知**：

```
（count15 基线，pid 336；NQAF 当时是 pass-through，日志为旧格式，无 mapped=/staged=）
[winstage-shim][336][11] ATTRDBG-NQAF pid=336 … path=\??\C:\…\ws-c15\probe\d4-fixture.txt status=0xc000003a class=0 seq=6
[winstage-shim][336][14] ATTRDBG-NQAF … path=\??\C:\…\ws-c15\probe\d4-fixture.txt status=0xc000003a class=0 seq=9
[winstage-shim][336][17] ATTRDBG-NQAF … path=\??\C:\…\ws-c15\probe\d4-fixture.txt status=0xc000003a class=0 seq=12
⇒ 真实盘没有该件 ⇒ GetFileAttributesW 返回 INVALID ⇒ CALLCALL attrs=0xFFFFFFFF err=3
```
```
（count18，pid 6472；NQAF 已 overlay 感知，日志含 mapped=/nt=/staged=）
[6472][13] ATTRDBG-NQAF … path=<同一逻辑名> mapped=<覆盖层> nt=\??\<覆盖层> staged=1 status=0x0
⇒ CALLCALL attrs=0x00000020 err=0
```

⇒ **`manual-w` 的 `attrs` 差异与 D4S2 无关**：D4S2 只改 `ws_GetProcAddress`/`ws_LdrGetProcedureAddress`，既不在该调用链上、也没有产生任何 `GetProcAddress` 调用；两轮**都**走 `真身 kernelbase!GetFileAttributesW → 已钩 NQAF`，差别只在 **NQAF 包装的语义（D99 v2 的 overlay 感知）**。`W=0` 恒成立 ⇒ 我们的 W 包装从未被进入。

**两条结论**：
1. **Win32 层的"私有解析"并不等于裸奔**：绕开 `GetFileAttributesW` 的 IAT 站点，仍会在 kernelbase 内部落回**已被挂钩的 ntdll NQAF** ⇒ 覆盖层语义仍然生效。这与阶段 1 实测的**直接 ntdll 旁路**（`manual-nq`/`rawgpa`/`rawldr` 仍 `0xC000003A`）形成**清晰对照**：能绕开的只有"直达 ntdll 且不经任何已钩入口"的那一类。
2. 那些 `staged=-1` / `mapped=<none>` 的行正是 **`D-FILE-7` 的 `_Thread_local` 守卫在 helper 入口拒绝重入**的实测形态（`status=0xc000003a`/`0x0` 的派生候选查询被挡；c15 轮因 NQAF 不解析覆盖层，故**没有**这类派生查询）；**载体全程 `TS`、无 `0xC00000FD`** ⇒ 守卫在真实车道里**确实把环断在了入口**。这是对 `dbg-guard` 结论的一次**独立、in-the-wild 复核**（与 `docs/round10/fileio/defects.md` 的 `D-FILE-7` 一致）。

---

## 5. 本轮**不覆盖**的项（明写）

| 项 | 状态 |
|---|---|
| ② 零语义复跑（`step2a/b` 逐字节 + D-R1 四条件） | 不在本轮（`registry` ROUND 5 全绿由 Lead 记）；本补丁未碰注册表路径 |
| 载体安全门禁 | ✅ 本轮 PASS（§0 第 4 行） |
| "非覆盖导出名恒真身"（`NtClose`/`GetModuleHandleW`）、`hModule=NULL`、`LdrGetProcedureAddress` **序数**分支 | **该驱动无对应路由**；已由 lane-free 探针对 count18 预跑（`D4S2-offline-gpa-count18.txt` = `7998BC7B…`），**声明为离线证据、不构成车道 ③** |
| 序数 495/496 的跨版本稳定性 | 未测（判据用**指针同一性**，与具体序号无关） |
| `manual-w` 的 `attrs` 作为判据 | **明令不作为判据**（§3 更正 A） |

---

## 6. 证据与哈希（我方独立复算）

| 件 | sha256 | 字节 | 行 |
|---|---|---|---|
| `stage-count18-s2\staged\evidence\shim.log`（evidence 快照） | `52ED88CB5023C3B043ADA48F845E8D3E1881C48C9C1404D75146216917E34ACB` | 13,360,123 | 51,950 |
| `stage-count18-s2\staged\shim.log`（stage 根原件，`lane-runner` 报值） | `00BE91684AACA117DCF481B201DB7737756104326291613117F887182AA5CD3E` | 13,375,564 | 52,027 |
| `stage-count18-s2\staged\evidence\attrdbg-nqifbn.txt` | `548F50D044E923FB619B43ADB591C75F927BEEA2564289C5392B84E73CC49802` | 9,626 | **15** |
| `stage-count18-s2\staged\evidence\attrdbg-w.txt` | `A282490E0695F1DA63C79C1EA729972639690C582E5B32EA8689054ABD31C19B` | 350,668 | 1,423 |
| `stage-count18-s2\staged\evidence\d4-probe-raw.txt` | `AE18FB32075C0E6534CD8D4ABCFA568DF0C4BED3B8AD0ED26831E6F853B78E9` | 9,591 | 75 |
| `stage-count18-s2\staged\evidence\injection.txt` | `436017899B76169B3F5C5BB96637CC3EB5465434A0C3DA54EA08ED88425F8C47` | 3,542 | 22 |
| `out-count18-s2\exec-stdout.json` / `exec-stderr.txt` | `7ACC29B3A7AD4E89CAD644512748CC6C8FBCC1F6ECB7995DC46F057E4775B127` / `E3B0C442…`（空） | 22,619 / 0 | 254 / 0 |
| `D4S2-count18-s2-analyze.txt`（机算，标签修正后 `ALL-MATCH`） | `374754391F78A3CEE77A02FAE2A0EFF14C6D634FC257EFDCEEAF14255E21EA11` | 4,047 | 50 |
| `analyze-count18.mjs`（修正后） | `E48AFD13FC6C23F6C15E90EBA2DCAC049014FB40EDB55FBEE37F89584AD68A0E` | 5,922 | — |
| `out-13d-count18\winstage-shim.dll` | `BDF0672C449B7C70C7EB0B432068BA3DCBE40B67E312B45C74507E2CADA50AF7` | 266,240 | — |

**树未写（PRE=POST）**：`ws_file.c` = `9826329B…`、`ws_hook.c` = `1C14AB54…`（构建者出 count18 时应用的 D100）；执行者与作者本轮均只读。

---

## 7. 结论与建议

- **`D4S2` ③ = PASS**（预登记接受面 2/2 生效；护栏与负对照全绿；载体安全 PASS）。**无回归**：除两条应变路由与 `manual-w` 的**已解释**差异外，其余逐字与阶段 1 一致。
- 建议 Lead 据此把 `D100-d4s2-ordinal-invented-export.patch`（`EF33451E…`）纳入 v2 候选的**验收结论**；`D4S2` 本身**不需要**任何补丁修改。
- 建议把 §4 的两条结论记入台账：① "Win32 私有解析仍落回已钩 ntdll 层 ⇒ 覆盖层语义生效"；② "`staged=-1/mapped=<none>` 是 `D-FILE-7` 守卫在野外的形态"。

### 7.1 **D99 的行为后果（正面，已随 v2 采纳；Lead 要求入台账）**

`kernelbase!GetFileAttributesW` 处理**逻辑名**时，现在会经其内部的 `NtQueryAttributesFile`（本 shim 已挂钩）得到**覆盖层命中**属性：count15（pre-D99）= `attrs=0xFFFFFFFF err=3`；**v2 起 = `attrs=0x00000020 err=0`**。⇒ 这是"**同名 API 面一致性**"的延伸：**即使调用方绕开 `GetFileAttributesW` 的 IAT 站点**（自走导出表取真身），只要它经由 kernelbase 实现，覆盖层语义仍然生效。已在 `docs/round10/fileio/13d/更正-汇总-线程9.md` 记入一条。

### 7.2 `count17-ctl` 收口轮 **无效（T1 回落）**；**盘上已有单变量证据，不必重跑**

- `count17-ctl`（`lane-runner` 跑）：`tierEffective=T1` / `launchMode=restricted-token` / `fallbackReason=transparent shim unavailable (injector exit=111 …)`；其 `manual-w` 的 `0xFFFFFFFF/3` **不构成证据**（该 pid 无任何 `ATTRDBG` 行 ⇒ 未挂钩）。属注入器/通道问题，与 D4S2 无关；执行者按纪律停手，正确。
- **替代证据（已在我方盘上，独立复算）** —— `nqaf-scan.mjs`（`D4S2-nqaf-scan.txt`）：

| 日志 | 注入件 `self=` | `ATTRDBG-NQAF` | 带 `mapped=` |
|---|---|---|---|
| `d5\stage-d5-b15b` | count15 | 10,160 | **0（0.0%）** |
| `d5\stage-d5-v2b` | **count17（v2，无 D4S2）** | 18,899 | **18,899（100%）** |
| `d5\stage-d5-v2` | count17 | 18,784 | 100% |
| `d4\stage-c15` | count15 | 10,458 | 0（0.0%） |
| `d4\stage-count18-s2` | count18 | 18,178 | 100% |

⇒ `count17`（**无 D4S2**）已 100% overlay 感知 ⇒ `manual-w` 差异归因 **D99/v2**；D4S2 排除。**建议直接收口，不重跑**（若要形式化 `count17-ctl2` 亦可，但非门禁）。

### 7.3 **收口（2026-10-10，Lead 确认）**

- **五方同判**：`line-d4`（本判定件）+ `lane-runner`（原始件与逐行基线对照）+ `pkgs`（构建/冻结与存在性标记）+ `exe`（逐件复算哈希/字节/行数、自解析，逐项与本文一致）+ `env-harness`（**手写 PE 导出目录解析**取真身、不经 `GetProcAddress`，给出同一判定）⇒ **(i)(ii) 生效 + 必须不变 + 未误伤 + 活性 + 载体安全 全 PASS**；`eddfb66` 的"待裁"**正式解除**。
- **`manual-w` 归因**：**D99/v2**（kernelbase 内部 `NtQueryAttributesFile` 已被挂钩、v2 起 overlay 感知）；**非 D4S2**。期望表口径已重锚（期望表 §0.5）并更正（期望表 §9）。
- **`count17-ctl`**：**环境性无效**（`injector exit=111` → T1 回落，非 `C00000FD` 型），不进判据；未重跑，收口依据为盘上 `count15↔count17` 的 NQAF 存在性标记（0% ↔ 100%）。
- **`count18`（`BDF0672C…` = v2 + D4S2）**：**③ 验收闭环**；树与候选已由 `pkgs` 冻结（`ws_file.c 9826329B…` + `ws_hook.c 1C14AB54…`），作者与执行者**均不再动树**。
- 本条为 `task-14` 的最终结论页；后续加固项（名字路径指针同一性、冷缓存解析、缩栈 B 类）由 Lead 另开任务，仍守"**只交补丁、不落树**"。
