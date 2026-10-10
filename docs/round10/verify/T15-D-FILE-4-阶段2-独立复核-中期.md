# T15 · D-FILE-4 阶段2（`out-13d-count18`）独立复核 —— 中期

> 验证者 `exe`（只读审计）。task-15 第 5 项 = 我方职责；第 4 项 (i)(ii) 的**独立复跑**待 `env-harness` 探针原始件到手后逐行复核（见 §5）。
> 候选：`.t\round10\shim\out-13d-count18\winstage-shim.dll`

## 0. 判定速览

| # | 项 | 判 | 依据 |
|---|---|---|---|
| 1 | 独立度量 | **PASS · 0 差异** | §1 |
| 2 | 红线审计 36 项 | **PASS 36/36** | §2 |
| 3 | apply 链复现 | **PASS** | §1 |
| 4 | 封印面 | **PASS**（exit 0 / 115） | §2 |
| 5 | 静态审计（(i)(ii)/递归/fall-closed/误伤） | **PASS**（2 条残留已记录） | §3 |
| 6 | (i)(ii) **独立自跑 + 车道内自解析** | **PASS** | §5（lane-free 我方自跑）+ §5b（车道内逐行解析，含活性反证） |
| 7 | **污染件交叉验证**（pkgs 点名） | **成立** | §4 |
| 8 | ② `arm-t3-count18` + 载体安全 | **PASS** | §2b |

## 1. 独立度量 + apply 链（我方工具 `t5-metrics.mjs`；与 pkgs 广播逐项相等）
```
c18|out-13d-count18\winstage-shim.dll|266240|2026-10-10T10:25:45.726Z|bdf0672c449b7c70c7eb0b432068ba3dcbe40b67e312b45c74507e2cada50af7|textSha=31630977996b7cc81b7586fda8af990c8ef3c6d438fd57cb23908d6200f03335 textRaw=212992 exports=15
c18|…\winstage-inject.exe|159232|…|03c93e2cbc5ca12765ab8aa9c55ee7762ae34689a6a5553b2ec49f0fe2bc651a|textRaw=130560
c18|…\winstage-probe.exe|174592|…|9f11aed9ad40c8072a6d4e5189b4cca50b9acde8050c741f342e1278d8da0bf3|textRaw=145408
c18|.t\round10\shim\d4\D100-d4s2-ordinal-invented-export.patch|6389|…|ef33451e1755a6772285bfb8d6c8594053dd445936e16f8e26343f7a700f3138
c18|shim\src\ws_hook.c|41410|…|1c14ab545e8e9917baa9fcf90b1c8c5c6fea7ade73136ed3b08a2e6e4d189852
c18|shim\src\ws_file.c|87118|…|9826329bdfcba8419bde9c3218dc072b4dd4fb87abd2d9757721ce9fb7b1cb06
```
**apply 链（仓内 scratch，独立复现）**：`.t\round10\shim\d4\D4S2-baseline-ws_hook.c` = `3E2EBEE6…`/36,375 B → `apply --check` rc=0 → `apply` rc=0 ⇒ **`1C14AB54…`/41,410 B**（= 树值 = pkgs 声明）✅

## 2. 红线 36 项 + 封印面
工具 `.t\round10\verify\t5\t5-redline-check.mjs`（已把 REFERENCE 更新为 v2 APPLIED `ws_file.c=9826329B…`/87,118 与 D4S2 APPLIED `ws_hook.c=1C14AB54…`/41,410，并把 **count16/count17 加为 FROZEN**）：
```
T5-REDLINE ALL-PASS items=36
```
含 `shim/out`=`63808F51…`/257,024、`ws_reg.c`=`F5695A95…`、`ws_regstore.c`=`125CB9FF…`、inject/probe 原件、count2–count17（**count16 `97CB71A2…` 作为被拒证据保留、count17 `B451ABE3…` 作为 v2 留档，均未被重建**）、out-16…out-22b、out-13c/14c、旧 `02C7418F`。
封印面：`基线一致：115 个受封印文件与 docs/源码基线.sha256 逐条相符` / **exit 0**。

## 2b. ②（registry `arm-t3-count18`）独立复核 + 载体安全 —— **PASS**
我方**自己复算**（不抄结论）：
- `step1a`=`step1b`=`4499283166530CE395CBC12677FEF2BD52759EACDCC5BDDE56C039B1A2E99C0B`/40 B；
- **`step2a`=`step2b`=`step3` = `12AA39D1F31AF899C625CDB0D7DB384F86F394262801252D5334FADE863972CB` / 78 B**（逐字节一致）；
- 四轮 `t1..t4`：`query-value-exit=0` **×4**、`query2-value-exit=0` **×4** ⇒ **四条件 4/4**；
- 门禁 `t3_replay_journal: applied=5 auditSkipped=0 bytes=480 rc=0` **在**（22 处）；
- `child injection armed: self=` **唯一值 = `…\out-13d-count18\winstage-shim.dll`**；
- provenance：`OVERRIDE_DLL_SHA256_BEFORE = AFTER = BDF0672C…`、`OVERRIDE_DLL_HASH_STABLE_DURING_RUN=True`、`SHIM_OUT_UNTOUCHED=True`、`EXEC_EXIT=0`；
- **载体安全三项（我方在整目录内核对）**：`tierRequested=TS`、`tierEffective=TS`、`launchMode=shim`，且 `fallbackReason` **0 处**、`0xC00000FD` **0 处** ⇒ **通过**；
- `logs\shim.log` = 15,312,394 B / `0096B6AC4A014489FEEBB69F5EE471AB6259CFC31F3BD48BC4FBBC240DA06753`。
（这一点是 task-15 里"最关键回归门"——`GetProcAddress` 语义被改动而注册表/文件面色零回归 ⇒ **成立**。）

## 3. 补丁静态审计（`D100` = 2 hunk，均在 `ws_hook.c`）

### (i) 禁"发明导出" —— **实现正确**
新流程：`if (!g_orig.GetProcAddress) return NULL;` → **先用真实解析器** `real = g_orig.GetProcAddress(hModule, lpProcName)` → `if (!real || !lpProcName) return real;` → 名字路径走 `ws_hook_resolve`，**未命中回落 `real`**。
⇒ `GetProcAddress(kernel32,"NtQueryInformationByName")`：真实解析器给 **NULL** ⇒ **返回 NULL**（旧代码会返回我们的包装 ⇒ "发明导出"已消除）✅
⇒ 对**未覆盖**名字：行为与旧代码**同**（仍是一次真实解析）✅

### (ii) 序数路由 —— **按指针同一性实现，且用真实解析器**
`ws_wrapper_for_real(addr)`：先查 `g_targets[i]`（要求 `originalSlot` 非空且 **`*slot == addr`**，并 `ws_family_enabled`）；再查新增 `g_d4OrdMap[6]`（其 original 在 `ws_file.c` 的 file-static 变量里，`ws_hook_init` 填不到），每项用 **`g_orig.GetProcAddress`** 在 `{kernelbase, kernel32, advapi32, ntdll}` 里**惰性**解析真身后做**同一性比较**。`ws_d4_ord_real` 用 `InterlockedCompareExchangePointer` 做线程安全缓存；**无真实解析器 ⇒ 返回 NULL ⇒ 不换**。`ws_LdrGetProcedureAddress` 的序数分支同样以 `*ProcedureAddress` 做同一性判定。⇒ 命中才换成包装，**未命中恒保留真身** ✅

### 递归（pkgs/Lead 点名）—— **未引入**
新增路径里对外的调用只有 **`g_orig.GetProcAddress`（捕获的真实 API）**；其余为纯内存比较（`ws_hook_resolve` / `ws_family_enabled` / `Interlocked*`）。**没有**经 `GetProcAddress`/`LdrGetProcedureAddress` 的**被挂钩**入口回环 ⇒ 无自递归。**注意**：若实现里误用直接名 `GetProcAddress`（而非 `g_orig.`）就会自递归——本补丁**没有**这种写法（我已逐行核对）。

### fail-closed / 误伤 / 代价
- `!g_orig.GetProcAddress ⇒ return NULL`：与**旧代码逐字相同**（未新增 fail-closed）✅；其余一切失败回落真实结果 ✅
- **误伤**：只对"真实解析结果存在"的调用做替换；未覆盖名字/其它模块走 `return real` ✅（见下"残留 1"）
- **代价（观察项）**：对约 60 个覆盖名字**每次多一次真实解析**（旧代码短路）——作者已注明；可接受。

### 残留（记录，非阻塞）
1. **名字路径仍按"名字"匹配**（`ws_hook_resolve(lpProcName)` 不校验 `real` 是否属于该模块）：若某模块合法导出**同名但不同函数**且我们覆盖该名，会被换成我们的包装。**此为既有设计**（D4S2 之前即如此、且当时更糟——会发明导出）；若要闭环，可改为对名字路径也先做 `ws_wrapper_for_real(real)` 指针同一性、失败再回落名字匹配。**建议列入后续加固**。
2. 名字路径的**额外真实解析**会让"覆盖名 + 冷缓存"路径多一次解析；`ws_d4_ord_real` 的惰性表仅在序数路径触发。

## 4. 污染件交叉验证（pkgs 点名，**成立**）
- 我今日 18:09 记录的**污染件** count17：`01ECE1E2…` / **266,240 B** / `.text 31630977…`
- 今日的 **count18**（声明 v2+D4S2）：`BDF0672C…` / **266,240 B** / **`.text 31630977…`（完全相同）**
⇒ **`.text` 逐字节相同、整件仅因构建元数据不同** ⇒ 独立证明"那次污染 = v2 + D4S2，且无杂散改动"；count18 = 同一代码的**合法重建** ✅
**连带确认**：我当时对污染件跑出的 7/7（已撤回）**实际测的是 v2+D4S2 的代码**——撤回仍然正确（它不是被声明的候选），但它顺带说明 D4S2 代码在 D-FILE-5 的 7 门上也能全过（**仅记录，不作 D4S2 的验收**）。

## 5. (i)(ii) **独立自跑** —— **PASS**（我方亲自跑，非转述）

**载具是 lane-free 的**（`LoadLibraryW` 候选 + 直接 `GetProcAddress`，无需车道/注入器）⇒ 我**自己跑了一遍**：
```
cmd /c "call .t\round10\shim\d4\D4S2-offline-gpa-count18.cmd"   （RC=0）
```
我方原始输出：`.t\round10\verify\t12\t15-gpa-mine.txt`（与既有件 `.t\round10\shim\d4\D4S2-offline-gpa-count18.txt` **模式逐行一致**，含地址——本会话 ASLR 基址相同）。

| 用例（`what`） | `before`（无 shim，真值） | `count15`（修前控制） | **`count18`（v2+D4S2）** | 判 |
|---|---|---|---|---|
| `wrong-module:owned-name`（kernel32 + 覆盖名） | `ptr=0` owner=NULL | **`0x6FBF4CE0` owner=winstage-shim.dll**（**发明导出**） | **`ptr=0` owner=NULL** | **(i) PASS** |
| `wrong-module:owned-name-2` | `0` | **包装** | **`0`** | **(i) PASS** |
| `right-module:owned-name`（ntdll） | 真身 `0x7FFB63745230` | 包装 `0x6FBF4CE0` | **包装 `0x6FBF5420`** | **活性正对照 PASS** |
| `ordinal-495`（NQIFBN 序数） | 真身 `0x7FFB63745230` | **真身**（无路由） | **包装 `0x6FBF5420`**（= 上面同名包装指针） | **(ii) PASS** |
| `ordinal-496` | 真身 `0x7FFB63745250` | 真身 | **真身 `0x7FFB63745250`** | **(ii) PASS** |
| `not-covered:NtClose` | 真身 | 真身 | **真身** | **未误伤 PASS** |
| `not-covered:GetModuleHandleW` | 真身 | 真身 | **真身** | **未误伤 PASS** |
| `null-module` | `0` | **包装**（发明） | **`0`** | **(i) PASS** |
| `LDR ldr-by-name` | 真身 | 包装 | **包装** | 活性 PASS |
| `LDR ldr-ordinal-495` | 真身 | **真身**（无路由） | **包装** | **(ii) PASS** |
| `LDR ldr-ordinal-496` | 真身 | 真身 | **真身** | **(ii) PASS** |
| 各段 RC | `BEFORE_RC=0` | `C15_RC=0` | `C18_RC=0` | — |

**判据说明（满足"指针身份"口径）**：以 `before`（无 shim）行为**真值基准**——`wrong-module:owned-name` 与 `ordinal-495/496` 的**真身指针**即真实解析器给出的地址；`count18` 下：
- **(i)** 覆盖名问错模块 ⇒ **NULL**（与真值一致），修前返回我们的包装 ⇒ **"发明导出"确已消除**；
- **(ii)** 序数 495 ⇒ **我们的包装**、496 ⇒ **真身**、未覆盖项恒真身、`null-module` ⇒ NULL；
- **活性正对照齐备**：同 run 内 `right-module:owned-name`、`CreateFileW`、`LDR by-name` 均返回包装 ⇒ 钩子确实在场，故本轮的"NULL/真身"是**有效阴性**而非"没走到"。
- 附带：`count15`（修前控制）在同一载具上**复现了缺陷**（发明导出 + 序数不路由）⇒ A/B 成立。

## 5b. **车道内**路由原始件独立解析（`lane-runner` 的 `count18-s2`，我方自解析）
原始件：`.t\round10\shim\d4\stage-count18-s2\staged\evidence\d4-probe-raw.txt`（9,591 B / `AE18FB32075C0E6534CD8D4ABCFA568DF0C4BED3B8AD0ED268E31E6F853B78E9`）；车道事实与日志指纹**我方自算**：
`tierRequested=TS`、`tierEffective=TS`、`launchMode=shim`、`fallbackReason` **缺席**、`0xC00000FD` **缺席**、`exitCode=0`；`injection.txt` 唯一 `self=…\out-13d-count18\winstage-shim.dll ok=1`；`shim.log` = **13,375,564 B / 52,027 行 / `00BE91684AACA117DCF481B201DB7737756104326291613117F887182AA5CD3E`**。

| 路由（我方逐行判） | count18 原始读数 | 判 |
|---|---|---|
| `ordinal-nq`（495） | `RESOLVE route=ordinal … ordinal=495 raw=00007FFB63745230 gpa=000000006FBF5420 owner=…out-13d-count18…`；三次 `CALLCALL … class=77 st=0x00000000 iosb=0x00000000` | **(ii) PASS**（真身 → 包装；且经包装的调用成功） |
| `wrongmod-nq` | `hmodule=kernel32 ptr=0000000000000000 owner=<not-in-any-module>` + `result=NULL (real loader semantics)` | **(i) PASS** |
| `static(iat-slot)` / `gpa`（NQIFBN） | 均 `ptr=000000006FBF5420 owner=…count18…`；`st=0x0` | **活性正对照 PASS** |
| `resolver control`（`GetProcAddress` static） | `ptr=000000006FBF6BD0 owner=…count18…` | **GPA 钩子在场**（活性） |
| `mixed-nq`（static+gpa） | 六次 `st=0x00000000` | **PASS** |
| `manual-nq` | `ptr=ntdll 真身`；`st=0xC000003A` ×3 | **未拦截（已知私有解析边界，与阶段1结论一致）** |
| `rawgpa-nq` | `resolver=kernelbase!GetProcAddress` → `NtQueryInformationByName` = **真身 ntdll**；`st=0xC000003A` ×3 | **未拦截** |
| `rawldr-nq` | `resolver=ntdll!LdrGetProcedureAddress` → **真身**；`st=0xC000003A` ×3 | **未拦截** |
| 未覆盖项 `496` / `NtClose` / `GetModuleHandleW` | **真身**（取自 §5 **我方自跑**的 lane-free 探针与既有件） | **未误伤 PASS** |

**"0 行/阴性必附活性反证"已满足**：同 run 内 `static`/`gpa`/`ordinal`/`mixed` 四条路由**都拿到包装**且调用 `st=0x0`，另有 `resolver control` 行证明 `ws_GetProcAddress` 钩子确实安装 ⇒ 上表"未拦截/真身"是**有效阴性**，不是"没走到"。
**与 `env-harness` 的差异清单**：其**判读表**我尚未收到（Lead 转述的 `ordinal-nq`/`wrongmod-nq` 三行与我的逐字一致）⇒ 就已公布的读数而言 **0 差异**；若其另发判读表，我按本表逐项 diff。
**旁证**：`analyze-count18.mjs` 对**修前 count15** 自测 = `ASSERT-FAIL`（两条断言均 FAIL）⇒ 该断言集对修前件会失败、对 count18 成立（断言有判别力，不是恒真）。

## 5c. 对 `env-harness` 交付件集的**逐件复核 + 差异清单**（我方自算哈希/行数，只信原始行）
| 件 | 其声明 | 我方实测 | 判 |
|---|---|---|---|
| `…\d4\D4-rawlines-c15.txt`（修前基线） | `757682B9…` / 23,458 B / 120 行 | **同** | ✅ |
| `…\d4\analysis-c15.txt` | `CBC56B27…` / 3,665 B / 43 行 | **同** | ✅ |
| `…\stage-count18-s2\staged\evidence\d4-probe-raw.txt`（主件） | `AE18FB32…B78E9` / 9,591 B / 75 行 | **同** | ✅ |
| `…\evidence\attrdbg-nqifbn.txt`（活性） | `548F50D0…` / 9,626 B / **15** 行 | **同** | ✅ |
| `…\evidence\attrdbg-w.txt` | `A282490E…` / 350,668 B / 1,423 行 | **同** | ✅ |
| `…\evidence\injection.txt` | `43601789…` / 3,542 B / 22 行 | **同** | ✅ |
| `…\out-count18-s2\exec-stdout.json` | `7ACC29B3…` / 22,619 B / 254 行 | **同** | ✅ |
| `…\stage-count18-s2\staged\shim.log` | `00BE9168…` / 13,375,564 B / 52,027 行 | **同** | ✅ |

**修前 A/B（我自解析 `D4-rawlines-c15.txt`）**：`route=wrongmod … ptr=000000006FBF4CE0 owner=…out-13d-count15…`（**发明导出**）、`route=ordinal 495 raw=真身 gpa=00007FFB63745230 owner=ntdll.dll`（**未路由**）、`manual/rawgpa/rawldr=真身`；对照修后 count18：`wrongmod ptr=0x0`、`ordinal gpa=包装 0x6FBF5420` ⇒ **A/B 双向成立**。
**活性正对照（我方自算分组）**：`attrdbg-nqifbn.txt` 共 **15 行** = pid **9732×3**（static-nq）+ **1644×3**（gpa-nq）+ **9460×3**（**ordinal-nq**）+ **9548×6**（mixed-nq），**status 全 `0x0`**。
**差异清单（唯一一条，文档级）——制作者已解释、撤回，并由我方独立证实其根因（见 §5d）**：其报"另有 **6372×1**（canary）"⇒ 该文件**实际共 15 行**（3+3+3+6），**无 6372 行**（我按 `ATTRDBG-NQIFBN` + `pid=`/`status=` 全量分组，各组计数之和 = 文件行数）。**其结论不受影响**：活性由 9732/1644/9460/9548 四组承担；且 `manual/rawgpa/rawldr` 在该文件 **0 行**这一阴性另有互证（同一轮其 `RESOLVE` 指针 = 真身 ntdll 且调用 `st=0xC000003A`，而 `static/gpa/ordinal/mixed` 均被替换且 `st=0x0`）⇒ **有效阴性，非 inconclusive**。
**判据口径一致性**：其口径（真身 = 手写 PE 导出目录解析、不经 `GetProcAddress`；包装 = 本进程 IAT 槽值；只判"指针 ∈ {真身,包装,NULL,其它}"、不用 `LastError`）**与我方一致**，可采用。

## 5d. 第二仪器交叉轮（`stage-d4-x18`）逐件复核 + `6372` 根因证实 —— **0 差异**
**件集（我方自算哈希/字节/行数，全部与其声明一致）**：`t15-d4-x18-probe-output.txt`=`48CD936B…`/1,134/13｜`t15-d4-x18-log-nqifbn.txt`=`29DF7B0B…`/618/1｜`t15-d4-x18-log-injection.txt`=`EE567725…`/1,933/12｜`t15-d4-x18-exec.json`=`704F2579…`/12,050/254｜`t15-d4-x18-shim.log`=`C4E906D0…`/13,307,086/51,423（路径：`docs\round10\fileio\13d\evidence\`）。
**我自解析主件**（`t15-d4-x18-probe-output.txt`）：
```
D4 TRUE nqifbn_name=0x7ffb63745230 nqifbn_ordinal=495 … real495=0x7ffb63745230 ord496_name=NtQueryInformationCpuPartition real496=0x7ffb63745250
D4 IAT nqifbn_slot=0x6fbf5420 (real=0x7ffb63745230 -> PATCHED) wrapper=0x6fbf5420 WRAPPER_DETECTED=1
D4 A1  kernel32_NtQueryInformationByName=0x0    class=null    verdict=PASS
D4 A1b kernel32_NtQueryFullAttributesFile=0x0   class=null    verdict=PASS
D4 A2  ntdll_ordinal495=0x6fbf5420              class=wrapper verdict=PASS
D4 A3  ntdll_ordinal496=0x7ffb63745250          class=real    verdict=PASS
D4 A4  ntdll_NtClose=0x7ffb637429c0             class=real    verdict=PASS
D4 A5  kernel32_GetModuleHandleW=0x7ffb6213b500 class=real    verdict=PASS
D4 A6  kernel32_GetLastError=0x7ffb62118640     class=real    verdict=PASS
D4 LIVE called_via=iat_slot status=0x00000000 iosb=0x00000000
```
- **独立真值**：该仪器用**手写 PE 导出目录**证明 `NQIFBN = ntdll 序号 495`（`real495` 与按名解析同址）、`496 = NtQueryInformationCpuPartition` ⇒ **(ii) 的序数前提被第二套解析器独立确认**。
- **判定**：(i) `A1`/`A1b` = **NULL** PASS；(ii) `A2` = **包装** PASS、`A3` = 真身 PASS；未误伤 `A4/A5/A6` = 真身 PASS；活性 `LIVE status=0x0` + `WRAPPER_DETECTED=1` PASS。
- **跨仪器指针一致性**：其 `wrapper=0x6fbf5420` **=** 阶段 1 件的 `ordinal495 gpa=000000006FBF5420`（我在 §5b 已独立读到该值）⇒ 两套独立解析器给出**同一包装地址**。
- **车道事实（我方自算）**：`tierRequested/tierEffective=TS`、`launchMode=shim`、`fallbackReason` **缺席**、`C00000FD` **缺席**、`exitCode=0`；`self=` 唯一 = `…\out-13d-count18\winstage-shim.dll`；活性行 `[9856][8] ATTRDBG-NQIFBN … staged=1 status=0x0 class=77`（`nt=\??\<stage>\staged\fs\…`）⇒ **经 IAT 槽的那次调用确实命中覆盖层**。
- **`6372` 根因（我方独立证实）**：在 `count18-s2` 的 `shim.log`（`00BE9168…`）中，`pid=6372` 的 **`ATTRDBG-NQIFBN` 行数 = 0**（`-CaseSensitive` 过滤）；其被误命中的那一行是 **`ATTRDBG-CFW`（CreateFileW 写证据文件）**：`[winstage-shim][6372][1033] ATTRDBG-CFW seq=774 … path=…\stage-count18-s2\…` ⇒ 其解释成立：PowerShell `Select-String` **默认大小写不敏感**，模式 `ATTRDBG-NQIFBN` 命中了路径里的**文件名** `attrdbg-nqifbn.txt`。**该假阳性已撤回；其结论不受影响。**
⇒ **与第二仪器交叉轮：0 差异（逐件哈希 + 逐项判定）**。T15 的 (i)(ii) 现由**四条独立来源**互证：我方 lane-free 自跑、车道内解析（`count18-s2`）、修前 A/B（`count15`）、第二仪器交叉轮（`d4-probe.exe`）。
