# R10-REG 缺陷清单（域四：注册表修改与隔离）

> 基线契约：`docs/T3-注册表暂存设计.md`（v1.4）· 实现：`src/registry-stage.mjs` / `src/registry-guard.mjs` / `src/registry-bindings.mjs` / `shim/src/ws_t3reg.c`
> 实测环境：**正常态** `launchMode=shim` / `tierEffective=TS` / `degraded=false`
> （`run-burst2`、`run-isoA3`、`run-isoB3` 三份 `sandbox-lane.json` 一致；`stderr.txt` 均为 0 字节）
> 每条附**原始证据路径**；未跑过的一律标 `not-run`。
>
> **D-R8 是独立于 D-R1 的高危面**（"载体跑了但钩子没装上"），见文末；
> D-R1 的实现缺陷（回放在 `g_orig` 未就绪时调用它）已在 `修复-D-R1.md` §5.4 记录并修复。

---

## D-R10-enum / D-R12（条件 ③：`reg query <key>` 不带 `/v` 枚举打印为空）—— ✅ **结案**（2026-10-10，窗口 #8）

**归属**：`shim/src/ws_reg.c` 的 **`ws_reg_build_union` values 路径**（在**空名默认值**处 `break`）——
**不是**枚举钩子未装、**不是** ntdll 直调面、**不是** 打开路径、**不是** provider（D-R11 早已撤回）。

### 三段式定因链（供后人复用）

**第 1 段 · 窗口 #7：把"哪一步、哪个 pid"钉死（取代推断）**
- `step2a` = **pid 2072 / 5796 / 10260 / 10444**（每回合一个；`pid 7628` 是另一辅助进程：`tier=1`、`replayedBytes=0`、零 `REGDBG`、从未做注册表调用）。
- 四者 `replayedBytes` = **480 / 282 / 678 / 876**（`applied=5`、`tier=3`、`viewIncomplete=0`）⇒ **覆盖层确有值**，"空覆盖层/观测窗"假设**被证伪**。
- `step2a` 跑在两次写之后、同一会话同一 stage root；命令 `reg query "%KEY%" > step2a.txt 2>&1` **已收 stderr**，而文件**仅 2 B** ⇒ **开成功、无错、无输出**。
- 伪句柄句柄量级普查：`RegQueryInfoKeyW` ×8、`RegCloseKey` ×24、**`RegEnumValueW`/`RegEnumKeyExW` = 0** ⇒ `reg.exe` 未走到枚举 ⇒ 被 `RegQueryInfoKeyW` 告知"没有值"。
- **join 纪律**：按 `canonical=`（只有 `/v` 路径才写）取 hKey 再 join **结构上看不到 `step2a`**；那 8 个 pid 实为 **7 个 `/v` 读者 + 1 个写者**（`pid 7612` `replayedBytes=0` = `reg add /f` 的预读）。⇒ **按 pid 关联或按句柄量级分类**；**句柄要按数值分类（`%p` 定宽，不能按字符串长度）**。

**第 2 段 · `out-21`：把"计数为 0"定源**
- 插桩 `ws_query_info_key_inner` 的 values 循环 ⇒ `union count=0`（即 `ws_reg_build_union` 在 **index 0** 就返回失败）。
- 结合第 1 段 ⇒ `valueCount` 停在 0 ⇒ `lpcValues=0` ⇒ `reg.exe` 不枚举。

**第 3 段 · `out-22`：修 `break`，并以机制级计数证实**
- `qik`：**`lpcValues` 0 → 1**、`maxNameLen=4`、`maxValueLenComputed=26`；
- `qik-unionfail`：**`index` 0 → 1**（0 是"i=0 取不到"的致命点；1 是**正常枚举结束**）；
- 伪句柄 `RegEnumValueW`：**0 → 4**（四个 `step2a` 子进程各一次）；
- 窗口 #8 四条件 **4/4 PASS**，`step2a` 78 B 且与 `step2b`/`step3` **同一 sha256** `12AA39D1F31AF899C625CDB0D7DB384F86F394262801252D5334FADE863972CB`。

### 判据技巧（本轮沉淀）

1. **"枚举打印为空"与"值读不回"必须分开测**：`step2a`（不带 `/v`）走枚举、`step2b`（带 `/v`）走单值查询；两者一起跑才能把"枚举面"从"值面"里剥出来。
2. **优先看插桩的机制计数**，而不是只看两个输出是否相等：`lpcValues` 0→1、伪句柄 `RegEnumValueW` 0→4 才是真正的因果证据。
3. **免换件同层 override 可用于取日志读数**：只设 `WINSTAGE_SHIM_DLL`（不设 `_DIR`，injector/probe 仍取已证件）+ `step2a-min.cmd`，可在**不开窗口**的情况下拿到 `qik`/`union` 两行；`exe` 用它得到的 `step2a` 哈希与窗口内**完全一致**，构成两条独立路径互证。
4. **陈旧/构造性插桩字段不得当作结论**：`maxValueLenWritten` 是硬编 `0ul` 的标签（见下）。

**`maxValueLenWritten` 一条：已复测闭环（`pkgs` 的 `out-22b`，2026-10-10）**

记法（按实测，不夸大）：**「插桩标签缺陷（已修正）；实测值 0 = 调用方未请求该字段；产品发布路径已修并被窗口 #8 采纳；此处无残留产品缺陷」**。

- **标签修正**：`out-22b`（`9B0C6188ED88460D93CE9999466175B21E35AA60973A45616EC93B0555EC15C1` / 257,024 B；**仅标签、零语义、诊断件、不替换 `shim/out`**）把 `qik` 的 `maxValueLenWritten` 由硬编 `0ul` 改成 `lpcbMaxValueLen ? *lpcbMaxValueLen : 0ul`。
- **实测（同入口、只 override `WINSTAGE_SHIM_DLL`、免换件；门禁 `applied=5 bytes=480 rc=0`、`self=…out-22b…ok=1`）**：`REGDBG qik … lpcValues=1 maxNameLen=4 maxValueLenWritten=0 maxValueLenComputed=26`（两次一致）；`REGDBG union kind=values … valid=1 count=1`；`step2a`/`step2b` 各 **78 B**、sha256 **`12AA39D1…72CB`**，**与窗口 #8 完全一致** ⇒ 证明该标签改动**无语义影响**。
- **判读**：标签现在真实反映"实际写回值"，**仍为 0** ⇒ 最可能是**调用方（`reg.exe`）对该字段传 `NULL`**（不请求 MaxValueLen），此时写回 0 正是"**未请求**"的正确语义。
- **限制（如实记录）**：单条日志**无法区分**"指针为 NULL"与"指针被写成 0"；要彻底闭环需再加 `maxValueLenPtr=%d`（**未做**，按实测上报）。
- **产品侧已正确**：`ws_reg.c` 现为 `if (lpcbMaxValueLen) *lpcbMaxValueLen = maxValueLen;`（原 `:1865` → 今 `:1889`），即窗口 #8 采纳的 `out-22` 修复。

**关键纪律（仍成立）**：**不得**用 `out-20` 那份硬编 `0ul` 的旧读数作为"`*lpcbMaxValueLen` 发布值有误"的证据 —— 它只证明那个插桩字段没读真实值。

证据：`pkgs` 的 `.t/round10/shim/D74-out22b-label-fix.txt`。

---

## D-R10【高 · 归属 `shim/src/ws_reg.c`（owner: `env-harness`）】伪句柄直通真实 API ⇒ 覆盖层里**已存在的键**读值时 `ERROR_INVALID_HANDLE(6)`

**判定**：**未修复** · 本域只交付定因证据与代码路径；`ws_reg.c` **不在本任务写范围**，Lead 已派 owner。

### 10.1 现象（受控窗口 #3，候选 `out-r2` `C642B6AF…`，正常态 `tier=TS`/`degraded=false`）

`r1-repro` 四回合**逐字相同**（判据 = `query-value-exit`，见 §10.4）：

```
add-key-exit=0        add-value-exit=0
query-key-exit=0      ← 键**可见**，但 step2a 输出为空（0 个值）
query-value-exit=1    ERROR: The handle is invalid.
query2-value-exit=1   ERROR: The handle is invalid.
```

对比修复前（无回放）：`query-key-exit=1`「找不到」⇒ **回放让键变可见了，从而首次走到伪句柄读路径并撞上这个既有缺陷**。

### 10.2 定因（离线判据：链接真实源码的 harness + 本次窗口的原始 journal 4576 B / 28 条）

```
t3_replay_journal: applied=28 auditSkipped=0 bytes=4576 rc=0
key_resolve=0 flags=17 key_open=0   (STAGED=1 EXISTS=16 REAL=4)
value_get(V) status=0 type=1 bytes=26 hex=7700720069007400740065006e002d00620079002d0041000000 text="written-by-A"
RESULT readseeded key_resolve=0 key_open=0 key_exists=1 value_get=0
```
⇒ **回放把值正确写进了 app hive，provider 也能逐字节读回**。所以失败**不在回放**，而在钩子层的伪句柄读路径。
证据：`evidence/fix-r1/offline/readseeded-decisive-b.txt`（另存种子 `arm-window-journal-seed.journal`）

### 10.3 代码路径（`shim/src/ws_reg.c`）

| 位置 | 内容 |
|---|---|
| `:958` | `int canServe = ws_reg_read_ctx(hKey, NULL, 0, …) && !isBareRoot;` |
| `:960-962` | `if (canServe && !isPseudo && !ws_reg_overlay_has_key(canonical)) canServe = 0;` |
| `:967-969` | **`if (!canServe) return g_orig.RegQueryValueExW(hKey, …);`** ← `hKey` 若是伪句柄就必然 `ERROR_INVALID_HANDLE(6)` |
| `:963-966` | 注释**逐字预言**了该错误码："A pseudo handle must NEVER reach a real API … the call would fail with ERROR_INVALID_HANDLE(6)" |
| `:568` / `:600` / `:687` | 覆盖层键的打开路径在此造伪句柄 `ws_pseudo_key_make(hive, canonical)` |

**待查点**：为什么对"覆盖层里确实存在"的键（`flags=STAGED|EXISTS`），`:958` 的 `ws_reg_read_ctx` 仍解析失败／`canServe` 仍为假。
**建议最小单变量定位**：在 `:958` 前后各打一行，输出 `read_ctx` 返回值、`isPseudo`、`isBareRoot`、`canonical`。

### 10.3b 窗口 #4 追加定因：**task-17 只修了一个函数，同族三个"读类"函数仍在直通伪句柄**（2026-10-10）

窗口 #4（候选 `out-15` `17825DF4F255B72BFE6091CC4B937E70DC44AE11FEDFEB399C9363EAC0FD76E9`）**复现同一签名**：
`replayedBytes>0` ✅（`0,170,282,368,480,566,678,764,876`）、`self=` 正确、`DLL_HASH_STABLE_DURING_RUN=True`（无中途回滚），
但四回合 `query-value-exit=1` / `query2-value-exit=1`，**`ERROR: The handle is invalid.` × 8**。

此时 `shim/src/ws_reg.c` **已经**含 task-17 的修复（`:958-987`：`!canServe && isPseudo` 时用 `ws_pseudo_key_path`
取回 canonical 并置 `canServe=1`；`!canServe` 且 `isPseudo` 时 **fail-closed 返回 `ERROR_FILE_NOT_FOUND`**，不再直通）。
**但该修复只作用于 `ws_query_value_ex` 一个函数**，同族三处仍是老代码：

| 行 | 函数 | 现状 |
|---|---|---|
| `:1464-1466` | `ws_query_info_key_inner`（`RegQueryInfoKeyW`） | `if (!ws_reg_read_ctx(…) \|\| isBareRoot) return g_orig.RegQueryInfoKeyW(hKey, …)` ⇒ **伪句柄直通** |
| `:1550-1552` | `ws_enum_value_inner`（`RegEnumValueW`） | 同上 ⇒ 伪句柄直通 |
| `:1635-1637` | `ws_enum_key_ex_inner`（`RegEnumKeyExW`） | 同上 ⇒ 伪句柄直通 |
| `:1474` / `:1558` / `:1643` | 同三者的 `!isPseudo && !overlay_has_key` 分支 | 有 `!isPseudo` 保护，**没问题** |
| `:679`（`:695` 注释） | `ws_RegOpenKeyExW` | 已 "forward by PATH, never with the pseudo handle"，**没问题** |

**这解释了窗口 #3/#4 的每一个表征**：
1. `query-value-exit=1` + `ERROR: The handle is invalid.` —— `reg.exe /v V` 会先调 `RegQueryInfoKeyW`（探测值是否存在/取长度）⇒ 撞 `:1464` ⇒ **`ERROR_INVALID_HANDLE(6)`**。
2. **`step2a` 为空但 `query-key-exit=0`** —— 不带 `/v` 的 `reg query <key>` 走 `RegEnumKeyEx`/`RegEnumValue` ⇒ 撞 `:1550`/`:1635` ⇒ 枚举 0 项 ⇒ **打印空、退出码 0**（不是"键里没值"，是**枚举也被打挂**）。

**修法（给 owner）**：把 task-17 在 `:966-984` 的那套（`ws_pseudo_key_path` 取回 canonical + `!canServe && isPseudo` 时 **fail-closed，绝不直通**）
抽成一个共用小函数，应用到 `:1464` / `:1550` / `:1635` 三处。

**独立交叉验证（`exe`，同一件 `out-15`）**：他自建的**离线**双进程探针（LoadLibrary + **真实 `RegQueryValueExW`**，A 写 / B 读，**先删掉 app hive 只留 journal**）
取到 **`ERROR_SUCCESS` + `written-by-A`**；基线 `02C7418F…` 取到 `RegOpenKeyExW rc=2`、`out-13c` 取到 `LoadLibraryW=NULL err=1114`。
⇒ **回放侧与加载侧都无问题**，失败点在**沙箱内的伪句柄读路径**，与本节定因一致。

**下一候选（建议 `out-16`）验收口径**：四回合 `query-value-exit=0` **且** `query2-value-exit=0` **且** `step2a` **非空**（枚举能看到值）**且** `replayedBytes>0`。
前三者缺一即说明读路径仍有未修的伪句柄直通点。

**另（重要经验，`exe` 提供）**：窗口 #4 内**并集门禁全绿**（closedloop 30/30、`registry-guard` 385/0、`registry-conformance` 65/0、
`registry-unstaged-wow64` 36/0、delete-capture 36、file-cow 19/19、boundary 62/0、整仓 autotest **33/0/0 · 2076 ok/0 bad**）
**却仍然 `query-value-exit=1`** ⇒ **没有任何门禁能替代"读回"判据**；此点必须写进下一轮验收清单。

**证据**：`evidence/fix-r1/arm-window4/{WINDOW-PROVENANCE.txt,transcripts,logs,wal}`（跑前/跑后钉哈希均为 `17825DF4…`）。

### 10.4 判据纪律（本轮踩过的坑，务必沿用）

| 量 | 是不是"读回成功"的判据 | 理由 |
|---|---|---|
| **`query-value-exit` / `query2-value-exit`** | ✅ **是**（唯一权威判据） | 只有它证明"别人写的**值**能读回" |
| `query-key-exit` | ❌ 不是 | 只证明"**键**在覆盖层里可见"；键在而值空也算 0 |
| `r1-repro.cmd` 的外层 `EXIT=0` | ❌ 不是 | 那只是**批处理脚本**跑完的退出码（实测 `stdout.ndjson` 里 `EXIT=0` 与 `query-value-exit=1` 同时出现） |

**影响面**：任何依赖"读回自己/他人写入的值"的上游（审批面板的 before 快照、`apply()` 前的校验、按值判定的白障/净变化）在覆盖层键上都会**拿到 `ERROR_INVALID_HANDLE(6)` 或读不到值**，而写入侧却报成功 —— 与 D-R1 同族的"账本与事实不一致"，但**责任方在钩子层**。

**归因纪律**（Lead 已采纳）：这是**既有**缺陷，由 D-R1 的修复**首次暴露**；修复前该键不可见，走不到这段代码。因此 `out-r2` 判"仍未修"是准确的，但**待修对象是 `ws_reg.c`**。

**交接物**：`evidence/fix-r1/offline/readseeded-decisive-b.txt` + `evidence/fix-r1/arm-window/{transcripts,logs,wal}`。

---

## D-R11【❌ 已撤回 · **我方夹具假阳性**，非产品缺陷】~~`ws_rstore_value_enum` 看不到 `ws_rstore_value_get` 能看到的值~~

> **⚠ 本条已撤回（2026-10-10，撤回者 `registry` 本人）。它不是产品缺陷，请勿据此修改 `shim/src/ws_regstore.c`。
> 保留在案只为防止后人重犯同一种错误。根因与正确读数见 §11.0；原文保留在 §11.1 以下（已作废）。**

### 11.0 撤回原因与正确读数（**以本节为准**）

**根因**：我的离线 harness 的**桩层**只填了 8 个 `g_orig.Reg*`
（`RegCreateKeyExW`/`RegOpenKeyExW`/`RegSetValueExW`/`RegQueryValueExW`/`RegDeleteKeyW`/`RegDeleteValueW`/`RegCloseKey`/`RegEnumKeyExW`），
**漏填了 `RegEnumValueW`（以及 `RegQueryInfoKeyW`）** ⇒ `g_orig.RegEnumValueW == NULL`
⇒ 我观测到的 `value_enum(0) status=1` 是**无效读数**，与 `ws_rstore_value_enum` 的真实行为无关。
**这是夹具缺陷（与 D-R6 同类），不是产品缺陷。**

**补全桩层后的正确读数**（同一 journal 876 B、同一进程、同一把键）：
```
diagseed: value_get(V) status=0 bytes=26
diagseed: value_enum(0) status=0 name=""      <- 默认值（空名），正确
diagseed: value_enum(1) status=0 name="V"     <- 探针值正常枚举出来
diagseed: value_enum(2) status=1              <- 枚举正常结束
diagseed: key_resolve=0 flags=17
```
⇒ **provider 的 `get` 与 `enum` 是一致的**；"`get(name)` 成功 ⟺ 该 name 出现在 `enum` 里"这条断言**成立（绿）**。

**净影响**：受影响的**只有"基于 enum 的结论"**。`value_get`/回放/AFTER/C1/C2/C3、以及窗口 #3/#4/#5 的四条件读数
**全部照旧有效**（它们走的是 `RegQueryValueExW`，该指针本来就在桩里）。
窗口 #5 条件 ③（`step2a` 为空）**改归因**：不是 provider 枚举，而是 **D-R10 那一族的钩子层路径**
（`reg query <key>` 不带 `/v` 会先调 `RegQueryInfoKeyW`、再走 `RegEnumValueW`/`RegEnumKeyExW`，
而这四个 API 正是 `out-16` 里**唯一没有 REGDBG 插桩的**）。
⇒ **四条件之红大概率同源于 D-R10 一族**，provider 无须改动。

**纪律教训（建议纳入新一轮清单）**：离线 harness 的 `g_orig` **必须覆盖被测 API**；
凡是调用 `g_orig.X` 而 X 未被桩层填充的读数**一律无效**——必须先证明"桩已覆盖"再报数。

**证据**：`evidence/fix-r1/tier3-timing/{case2-enum-vs-get-WITHDRAWN.txt,case2-enum-vs-get-CORRECTED.txt,control-apphive-enum.txt}`。

---

<details><summary>以下为**已作废**的原始条目（保留存档）</summary>

### 11.1 现象（同进程 / 同 hive / 同键，一次运行内同时取两路读数）

`.t/round10/registry/harness/r1harness.exe diagseed <seededTree>`（journal 876 B，replay `applied=9 bytes=876 rc=0`）：
```
diagseed: journal=…\overlay.journal bytes=876
diagseed: attach status=0
diagseed: per-process hive …\overlay.<pid>.hive exists=0
diagseed: value_get(V) status=0 bytes=26      ← 值在
diagseed: value_enum(0) status=1 name=""      ← 枚举说"没有了"（1 = NO_MORE_ITEMS）
diagseed: key_resolve=0 flags=17              ← STAGED|EXISTS
```
⇒ **同一把键、同一进程：`get` 拿得到值，`enum` 一个都列不出来。**

### 11.2 排除"app hive 不支持枚举"（关键对照）

`RegLoadAppKeyW`+`REG_PROCESS_APPKEY` 的 app hive **完全支持** `RegEnumValueW` ——
纯 Win32 对照程序 `.t/round10/registry/harness/apphive-enum.c`（**不含任何 shim 代码**）自建 hive 后：
```
[B] RegEnumValueW(0) on create-handle   status=0 name="V"
[B] RegEnumValueW(1) on create-handle   status=0 name="W"
[C] RegEnumValueW(0) on reopened-handle status=0 name="V"     ← 重新打开也枚举得到
[D] RegEnumValueW(0) KEY_READ-only      status=0 name="V"
```
⇒ 平台不背这个锅；**是 provider 的枚举路径本身看不到值**。

### 11.3 影响

- **`reg query <key>`（不带 `/v`）会打印空、退出码 0** —— 这正是受控窗口 #5 四条件之 ③ `step2a` 为空；
  用户看到的是"这个键没有值"，而 `query-value` 那条路又因伪句柄缺陷（D-R10）失败 ⇒ **"写成功却什么都不显示"**。
- 任何依赖枚举的消费方（列出暂存值的 UI、按值遍历的净变化/白障计算、安装器式遍历）都会**看不到已暂存的键值**。
- 与 D-R10 是**两个独立的读路径缺陷**（一个在钩子层伪句柄，一个在 provider 枚举），**可叠加**。

### 11.4 修法方向（给 owner）

让 `ws_rstore_value_enum` 与 `ws_rstore_value_get` **同源**：要么复用 `get` 的打开/取数路径，
要么直接**以 journal 为准**枚举（设计原则本就是"journal 是事实，hive 只是物化"——见 D-R1 修复 §2）。
并加一条**两者必须一致**的回归断言：对已回放的 hive，`get(name)` 成功 ⟺ 该 name 出现在 `enum` 结果里。

**证据**：`docs/round10/registry/evidence/fix-r1/tier3-timing/{case2-enum-vs-get.txt,control-apphive-enum.txt}`。

</details>

---

## D-R9【信息 · 影响验证协议，非功能缺陷】`build-shim.mjs` **不是字节可复现** —— 但**代码可复现，不可复现的是元数据**

**判定**：**未修复（不在本任务写范围内）** · 只报告，供集成/验证协议修正口径

**发现者**：我（`registry`）先测到"同源两次构建哈希全不同"；**`exe` 用自写 PE 分段比对器独立定位到原因**
（`docs/round10/verify/evidence/D-R9-nonreproducible-analysis.md`；工具 `.t/round10/verify/tools/pe-section-diff.mjs`）。
⇒ **准确结论是：代码可复现，不可复现的是元数据。**

| 产物 | 代码段 | 差异（仅元数据） |
|---|---|---|
| `winstage-shim.dll` | **`.text` 逐字节相同**（204,288 B）；`.data`/`.pdata`/`.tls`/`.reloc` 全同 | `.rdata` 39,936 B 中 **4 B**（zig 构建临时名 `winstage-shim.dll.tmp-1791542066494` vs `…071418`）；`.buildid` 512 B 中 **9 B**（`RSDS` PDB GUID/age）；COFF `TimeDateStamp` 10:34:28Z vs 10:34:33Z |
| `winstage-inject.exe` | **CODE-LEVEL IDENTICAL = true**（`.text` 130,560 B 相同） | 同上（`.buildid` + 时间戳） |
| `winstage-probe.exe` | 同理（`.text` 145,408 B 相同） | 同上 |

我自己的原始读数（同源两次构建，三产物哈希全不同）：
`winstage-shim.dll` `4A7E0D82…` vs `92495239…`；`winstage-inject.exe` `B17EBA8C…` vs `0A12E99D…`；`winstage-probe.exe` `3DABC4F8…` vs `3BACDA30…`。
（`out-r2` 的三次构建里 injector 得到 `85595276…`/`9355F013…` —— 同源另一次构建，不是引用错目录。）

**⇒ 精确口径（替代原先"哈希不可信"的粗说法）**：
1. **哈希仍然可信且必做**，语义只有一条：**"我测的就是这一件"**（钉住被测产物）。
2. **哈希不能证明"同源 / 未变"**：跨构建**必然**不同哈希 ⇒ 任何"哈希相等 ⇒ 同一份代码"的断言必须删除。
3. **新鲜度 / 血统检查**（`A.2`/`A.5`"报告必须比 DLL 新"、`shim-artifact-integrity`）改用 **`mtime` + 显式清单**。
4. **需要断言"同代码"时用 `.text` 分段摘要**（`pe-section-diff.mjs` 直接输出逐段 sha256，可复用）——它对上述全部差异来源免疫。
5. 若要**整件字节可复现**（可选、收益有限）：需规范化 COFF `TimeDateStamp` + `.buildid` 的 `RSDS` PDU GUID/age + `.rdata` 里的 zig 临时名。**具体开关 `not-run`**（未验证，不猜）。

**协议细化（采纳 `exe` 建议，2026-10-09）**：
- **`.text` 分段摘要不进 pass/fail 硬门禁**，而作为**"代码身份"记录字段**：每个新候选源码都会变，硬性相等会永远红。
- **唯一合理的硬门禁形态**：**"交付时声明的 `.text` 摘要 == 窗口内实测的 `.text` 摘要"（防**代码**漂移）**；
  **整件交付漂移**另有一条独立判据：**复核者在窗口开始前对在盘整件 sha256 复核**并与交付声明比对（`exe` 已纳入窗口清单）。两者不可互相替代。
- 整件字节可复现 ⇒ **低优先单列任务**给 `tools/build-shim.mjs` 的 owner（三项：COFF 时间戳 / `RSDS` / zig 临时名）；**不阻塞本轮任何结论**。
- 工具：`exe` 的 `.t/round10/verify/tools/pe-section-diff.mjs` 可 **read-only 复用**（本域不改他人文件）。

**代码身份表（`exe` 独立计算，`.text` sha256；本域直接引用）**：

| 产物 | DLL sha256(前 8) | `.text` sha256(前 16) | `.text` 大小 |
|---|---|---|---|
| `shim/out`（R 基线） | `02C7418F` | `c75106beaa2bacf2` | 198,656 B |
| backup | `47DF4A5A` | `23144d8423504187` | 198,144 B |
| `out-11b` / `out-11c` | `4233A422` / `3E094092` | `97b0ab4aa73e3f05` / `507880dd97cf256a` | — |
| `out-13b` / `out-13c` | `21FDB793` / `5E7A010E` | `f82bdeb4f59bb5c6` / `4d99256a8106e154` | — |
| `out-r1`（修复前候选） | `4066041E` | `c3b89467e34a3a4a` | — |
| `out-fix1`（仅修 attach） | `441D159D` | `6af8c9d3ec2776a7` | 204,288 B |
| **`out-r2`（下一轮候选）** | **`C642B6AF`** | **`1cfb891399c10af9`** | 204,288 B |
| `out-repro1` / `out-repro2`（D-R9 两次构建） | `4A7E0D82` / `92495239` | **`1cfb891399c10af9`**（与 `out-r2` 同） | — |
| `out-14-VOID-11c` | `c505f9c6` | `4b26f6cd0fd0122f` | — |

**两个可直接读出的结论（措辞已按 `exe` 的"射程边界"收紧）**：
1. **`out-repro1` / `out-repro2` / `out-r2` 三者 `.text` 相同（`1cfb8913…`）**
   ⇒ **代码身份一致**（充分、可复现），独立佐证"同源另一次构建"。
   ⚠ **射程边界**：`.text` 相等**只**证明**代码**相同，**不能**证明**整件未漂移** ——
   整件哈希的差异恰恰可能来自元数据（这正是 D-R9 本身的内容）。
   ⇒ **"整件交付漂移"的判定必须由复核者在窗口开始前对在盘整件 sha256 复核**，并与交付声明比对
   （`exe` 已把它列为窗口硬门禁项之一）。本域在开窗通知里给出 `out-r2` 三件的在盘整件 sha256。
2. `out-fix1`(`6af8c9d3`) ≠ `out-r2`(`1cfb8913`) ⇒ 两者**是不同代码**，与"fix1 只修回放、r2 又补了 `Detach` 同类加固"一致（如实记录，避免被误当同一件）。

**与 D-R1 的关系**：无因果。它解释了交付过程中"同一路径 injector/probe 哈希前后不一致"的现象（`exe` 已在其 D46-3 §6 追溯更正）。

**证据**：`.t/round10/registry/out-repro1|out-repro2/`（我的两次构建）+ `evidence/fix-r1/offline/build-reproducibility.txt`
+ `exe` 的 `docs/round10/verify/evidence/D-R9-nonreproducible-analysis.md`（分段比对原始读数）。

---

## D-R8【高 · 独立于 D-R1】载体**无钩子运行**却按"已隔离"继续（fail-open）

**判定**：**未修复（不在本任务写范围内）** · 本域只交付证据与加固建议

### 8.1 一句话

只要"注入器放行 / 载体已启动"与"钩子**实际**装上"之间存在缺口，命令就会**在完全没有暂存、没有审计的状态下**直接作用于真实系统 —— 这是沙箱最坏的一类失效（比"硬拒"和"报错"都危险，因为它是**静默放行**）。

### 8.2 已证实的两个事实（分别独立）

**事实 A（我离线确定性复现）**：DLL 的 `DllMain` 一旦抛错，`LoadLibraryW` 返回 **NULL + `ERROR_DLL_INIT_FAILED(1114)`**；
此时 `ws_entry.c` 的 `DllMain` 仍会走到 `return TRUE`（`:371`），而 `g_ws.initialized` **保持 0** ⇒ **钩子从未安装**。

```
harness/loadtest.c（只 LoadLibraryW，无沙箱），seed = 170 B 真实 overlay.journal：
  stock 02C7418E（无 D-R1）        EMPTY: OK      SEEDED: OK
  BEFORE out-r1 / out-13c / out-cur EMPTY: OK      SEEDED: NULL err=1114   ← DllMain 抛错
  AFTER  out-fix1 441D159D…        EMPTY: OK      SEEDED: OK               ← 已修
```
证据：`.t/round10/registry/fix-evidence/dll-load-differential.txt`（原始三态表）

**事实 B（`exe` 的受控替换窗口读数，候选 `5E7A010E…` 下）**：
`registry-unstaged-wow64` **30/6**，其中 `/reg:32` 的删除**由 `ACCESS_DENIED(5)` 变为返回 0、真实 hive 的键真的消失、WAL 里的 `UNSTAGED` 记录缺失**。
`UNSTAGED` 缺失意味着**这次调用没有经过 shim 的判定层**；真实键消失意味着**它真的落到了真实 hive**。

**因果（标注为推断，`not-run`）**：A + B 与"执行该删除的子进程**没有可用的 shim**"一致。
但我**没有**在窗口内取证到"到底是注入器拒绝了而载体仍被放行，还是 `LoadLibraryW` 成功但初始化失败" —— 窗口已关闭，
两种路径的区分记 **`not-run`**，不得当成已定因。（可区分的方法见 8.4。）

### 8.3 影响面

| 面 | 后果 |
|---|---|
| 注册表 | 真实 hive 被改/被删，**无候选、无 `HARD_DENY`、无 `UNSTAGED`** ⇒ 审批面板看不到任何东西 |
| 文件 | 同理：真实磁盘写入绕过暂存与审计 |
| 审计 | `WINSTAGE_AUDIT_LOG` / shim.log 里**没有该次调用**（钩子没装，日志自然没有）⇒ **事后不可追溯** |
| 用户感知 | 与"沙箱已生效"无法区分（`sandbox-lane.json` 可能仍报 `degraded=false`） |

### 8.4 检测 / 加固建议（按性价比排序）

1. **载体启动自检（最关键）**：放行前必须问 shim"你装上了吗" —— 现成的 `WinstageShimStatsJson` 会回
   `{"initialized":…,"hooksInstalled":…}`。**`initialized != true` 或 `hooksInstalled != true` ⇒ fail-closed**（拒绝执行），
   绝不允许"注入器返回成功"被当成"隔离已生效"。当前 `src/executor.mjs:5449` 的 `available` 判据只看注入器退出码与 `report.ok`，
   **没有校验 `initialized`/`hooksInstalled`** —— 这正是缺口所在。
2. **注入器侧**：`LoadLibraryW` 返回 NULL 时，除了 `report.ok=false`，再显式回传 `GetLastError`（现在拿不到远程线程的 last error，
   所以应至少标注"remote DLL init failed"）并**不**把该次运行标为 available。
3. **`DllMain` 侧（`ws_entry.c`，本任务写范围外）**：autoinit 被请求却失败时，DllMain 目前**静默 `return TRUE`**（`:344-359`）。
   若调用方只检查 `LoadLibraryW`，就得到 8.3 的静默放行。建议至少在 shim.log 之外再留一个**可被启动器读到**的标记文件。
4. **新增红 check（可直接接门禁）**：
   - `非空 journal + LoadLibraryW ⇒ 必须成功，且 statsJson.initialized==true`（我这份 `loadtest` 可直接当夹具）；
   - `注册表写命令在 shim 未初始化时必须失败`（用一个 `WINSTAGE_SHIM_DISABLE=1` 的正对照验证"未生效 ⇒ 不执行"）。

### 8.5 与本任务的关系

D-R8 **不是** D-R1 引入的：D-R1 的实现缺陷只是**恰好把 `DllMain` 打挂**，从而把这个一直存在的缺口**照亮**了。
即使 D-R1 修好（`out-r2` 已修），只要"放行判据不校验钩子已装上"，任何导致 `ws_init_full` 失败的原因
（配置缺失、权限、hive 占用、未来的新 bug）都会重新打开同一条 fail-open 路径。
⇒ 建议把它作为**独立任务**派给插件侧（`src/executor.mjs` + `shim/src/ws_entry.c` 的负责方）。

---

## D-R1【高】"写成功 → 立刻读不回来"：共享覆盖 hive 一失手就换成**逐进程私有 hive**，而私有 hive 覆盖了读路径

> **✅ 状态更新（2026-10-10，受控窗口 #6）：D-R1 已修并端到端验证（跨进程读回成立）。**
> 候选 `out-18b` = `8FEAB38D89ED372BD891A2A017575D5B81C86C0199DCA3F7C11EE784FDB82D66`（253,440 B）换入 `shim/out`，
> 经**官方入口** `sbx-thread` 跑四回合（`exe` 执行换件、我执行测量；跑前=跑后钉哈希一致、`self=…\shim\out\winstage-shim.dll ok=1`）：
> **四回合每回合 `query-value-exit=0` 且 `query2-value-exit=0`**，`reg query … /v V` 逐字打印
> `V    REG_SZ    written-by-A` —— **前一个进程写、后一个进程读回，逐字节成立**。
> 窗口 #3/#4/#5 连续三轮的读回红项**全部消失**。⇒ **D-R1 的"写成功→读得回"目标达成。**
> 四条件合计 **3/4**：①②④ 绿，③（`reg query <key>` **不带 `/v`** 的枚举面仍打印空）仍红 ——
> 该残留**不是** D-R11/provider（那条已撤回），归属见 `exe` 的 `docs/round10/shim/evidence/D61-window6-verdict.md`
> 与下一轮待办 `D-R10-enum`/`D-R12`。原始件：`evidence/fix-r1/arm-window6/**`（含逐字 transcript 与 `step2a`=2 B vs `step2b`=78 B 的反差）。
>
> **状态更新（2026-10-09）**：根因不变；**修复已实现**（journal 回放 + 会话级 fallback hive），
> 且修复过程中发现并修掉了**我自己实现的一个缺陷**（回放在 `g_orig` 就绪前调用它 ⇒ DllMain 抛错）——
> 详见 [`修复-D-R1.md`](./修复-D-R1.md) §2 / §5.4。修复前的原始 42%/79% 与 12/12 读数保持原样。

**判定**：**✅ 已修复，并在受控窗口 #8 端到端验证通过 + 已采纳**（`shim/out` 现为 `63808F5188643C085BDC71E86AC843BB8758579938A4CB61781044B93C8A99EB`/257,024 B；窗口 #8 四条件 **4/4 PASS**，含条件 ③ 枚举面）。原始"根因未修复"判定见下方归档；修复过程与候选沿革见 [`修复-D-R1.md`](./修复-D-R1.md) §5.2.3–§5.3c。

### 现象（同一沙箱会话、同一条 `reg.exe` 通道、跨进程）

| 探针 | 写 | 紧接着的读 |
|---|---|---|
| `HKCU\Software\WSTestR10` | `reg add … /f` → `exit=0` `The operation completed successfully.` | `reg query` → `exit=1` `ERROR: The system was unable to find the specified registry key or value.` |
| `HKCU\Software\WSTestR10\Sub` 默认值 | `exit=0` | `reg query` → `exit=1` 找不到 |
| `HKCU\Software\WSTestR10Node`（node 通道） | `status=0` | `status=1` 找不到 |
| `HKCU\Software\WSTestR10Iso`（隔离探针） | 建键 `exit=0`、写值 `exit=0` | 读整个键 `exit=1` 找不到 |

**同进程内是可读的**（所以不是"写没发生"）：

```
02-ps.txt  P2 New-ItemProperty HKCU:\Software\WSTestR10Ps -Name PSZ
           reportedSuccess=True ; readBack=True value=ps-sz-r10
```

### 根因（源码 + 原始日志双证）

`shim/src/ws_t3reg.c:429-455`：先试共享 `overlay.hive`；
失败则 `RegLoadAppKeyW(<regRoot>\overlay.<pid>.hive)`（**每进程一个**），只用它当 `g_t3.root`；
WAL（`overlay.journal`）保持共享。`Detach` 时 **`DeleteFileW` 删掉该私有 hive**（`:482-484`，注释称其为 derived state）。

原始日志（`run-burst2/staged/shim.log`）：

```
[winstage-shim][<pid>][1] DshRegStageAttach: shared hive unusable (32)
  -> per-process hive=<stageRoot>\registry\overlay.<pid>.hive
  (journal stays shared: <stageRoot>\registry\overlay.journal)
```

**量化（三份运行，同一 stage root 结构）**：

| 运行 | attach 次数 | 落入逐进程 hive | 比例 | 宿主侧实际留存 `overlay.<pid>.hive` |
|---|---|---|---|---|
| `run-burst2`（多进程并发） | 92 | **73** | 79% | **0**（Detach 全删） |
| `run-isoA3` | 52 | **22** | 42% | 0 |
| `run-isoB3` | 22 | **14** | 64% | 1（`overlay.4296.hive`，被强杀未 Detach） |
| `run-seq2`（顺序化复跑） | 39 | **39** | **100%** | 1（`overlay.8452.hive`/`3968.hive` 短暂出现后被清扫） |

**关键**：最低一档也有 **42%**，最高一档 **100%** —— 即"跨进程读回"**没有一档是稳的**。
`overlay.hive` 本身恒被创建（8192 B），失手发生在 `RegLoadAppKeyW` 的**跨进程共享**这一步。

⇒ **每一次"新进程读"都从空 hive 起步**：上一个 `reg.exe` 写进私有 hive、
退出时把它删掉，下一个 `reg.exe` 拿到的是另一个空 hive。
**唯一跨进程的事实是 WAL，而 shim 的读路径不读 WAL。**

### 为什么算缺陷（不是纯风格问题）

契约 `docs/T3-注册表暂存设计.md` §1.2 的验收句就是
**"写成功、能读回自己写的值；真实 hive 一个字节不动"**；§4.4.4 要求读路径"先查覆盖层、命中即返回"；
§11.2 的净变化判据依赖"这个键在覆盖层里存不存在"。
本形态下**跨进程读一致性为零**，而**返回值仍是成功** ⇒ 调用方看到"写成功、立刻读不到"，
正是本项目明令禁止的"账本与事实不一致"。

**作者已知并接受**：`:232-236` 注释写"per-process hive is contract-equivalent: the hive is only
this process's read-back view; the durable cross-process truth is the SHARED journal"。
本清单的任务是**把代价写清楚并给它一条能 FAIL 的断言**，而不是说作者不知情。

### 证据
- `docs/round10/registry/evidence/threads/run-burst2/stage-root-22752627926352/staged/probeout/01-regcmd.txt`（步骤 6 vs 11、12 vs 14）
- 同目录 `02-ps.txt`（P1/P2 同进程可读 vs P3/P4 另进程不可写）、`06-node-child.jsonl`（N1 `status=0` / N3 `status=1`）
- 同 stage root `staged/shim.log`（`shared hive unusable` ×73；`overlay.<pid>.hive` 路径清单）
- `.../evidence/surface/run-burst2/13-surface-bounded.txt`（shared=1、per-process=0 —— 私有 hive 已被删除）
- `.../evidence/surface/run-isoB3/13-surface-bounded.txt`（per-process=1：`overlay.4296.hive` 8192 B）

### 建议最小红检查
同一会话内：`reg add <新键> /f`（断言退出码 0）→ **另起一个进程** `reg query <同一键>`
（断言退出码 0 且能读回值）。当前必然红。

---

## D-R2【中】"往**已存在**的键里写"被路径级拒绝，且 WAL 里既无 `SET_VALUE` 也无 `HARD_DENY`/`UNSTAGED`

**判定**：**未修复**（不可归因 —— 三种结论一种都没留下）

### 事实（`02-ps.txt`，同一进程、`is_admin=True` 实测）

| 路径 | 真实 hive 里是否存在 | 结果 |
|---|---|---|
| `New-Item HKCU:\Software\WSTestR10Ps` | **不存在** | `reportedSuccess=True` |
| `New-ItemProperty …\WSTestR10Ps -Name PSZ` | **不存在** | `reportedSuccess=True`，读回 `ps-sz-r10` |
| `Set-ItemProperty HKCU:\Console -Name WSTestR10PsVal` | **存在** | `SecurityException: Requested registry access is not allowed.` |
| `New-ItemProperty HKCU:\…\CurrentVersion\Run -Name WSTestR10Run` | **存在** | `SecurityException: Requested registry access is not allowed.` |
| `reg add HKCU\Console /v WSTestR10Val …` | **存在** | `exit=1`，之后 `reg query … /v WSTestR10Val` → 找不到 |

**WAL 侧**：`run-burst2` 43 条记录中 `HARD_DENY=0`、与 `HKCU\Console` / `Run` 相关的记录 **0 条**
（键直方图：`CREATE_KEY 22 / SET_VALUE 16 / UNSTAGED 5`）。
⇒ 这条拒绝**既没进暂存、也没进透传记录**。

### 为什么算缺陷
契约 §8.0 要求每条写路径归入 **暂存 / UNSTAGED 透传 / HARD_DENY** 三类之一，且
"不可暂存 ⇒ 透传 + `UNSTAGED`（原因码）"是 v1.4 的**核心修复**（旧行为"把表示不了伪装成
`ERROR_ACCESS_DENIED`"被明确列为已修复缺陷）。
而"往已存在的键写值"是**最常见**的注册表写法、也是 §11.2 净变化原则的主场景；
当前它既不可用、又不可归因。调用方对 5 无能为力，而真实 API 本可以告诉它该怎么做。

### 证据
`run-burst2/.../probeout/02-ps.txt`（P1–P4）、`run-burst2/wal/12-decoded.json`（`HARD_DENY` 计数 0、无 Console/Run 记录）

### 建议最小红检查
写 `HKCU\Console` 的探针值，断言 **"要么成功且能读回、要么 WAL 里留下带真实 LSTATUS 的记录"**。
当前两者皆无。

### 后续线索（`推断，未取证` ⇒ 供 `ws_reg.c` owner 参考，**不得当结论**）

D-R10 定因之后，本条的"写被拒 + WAL 零记录"有一个**自洽的候选解释**：
`ws_reg.c` 的伪句柄读/写路径在 `canServe == false` 时会**把伪句柄转给真实 API**（`:967-969`）。
对**已存在**的键（`HKCU\Console`/`Run`），钩子层可能因 `canServe` 判定失败而"不接手"，
于是调用落到真实 API、再由**受限令牌**拒绝 —— 返回 5/SecurityException，**而因为从未进入 provider，WAL 自然没有记录**。
这能同时解释 D-R2 的两个表征（"拒绝" + "零记录"）。

**为什么只标推断**：本条的原始读数来自 Phase 1（`tier=TS` 正常态），当时**没有**采集 `ws_reg_read_ctx`/`canServe` 的运行时值；
要证实需要一次专门探针（在 `:958` 打点 + 对已存在键做写探针）。`not-run`。
⇒ **建议 `ws_reg.c` 修复后重跑本条的"建议最小红检查"**，若同时转绿，则 D-R2 与 D-R10 同源。

---

## D-R3【中】新建键的 `SET_VALUE` **无法冻结进候选**（16/16 丢失），候选退化成"只有 mkdir"

**判定**：**未修复 · 但宿主侧行为诚实**（`registry-bindings.mjs` 拒绝把"读不到"翻译成"不存在"，这点是对的）

### 事实

WAL（43 条）：`CREATE_KEY 22 / SET_VALUE 16 / UNSTAGED 5`。
候选 `cs_0008_95bc4aec.json`：

```json
"summary": {"files":14,"hostOperations":0,"byOp":{"mkdir":14},"bytes":0,"keys":14,"values":0,"unsupported":0}
```

- **14 条全是 `op=mkdir` / `diffKind=subkey-added`；`values=0`** ⇒ **16 条值写一条没进候选**；
- `unfrozen` 列 **17 个路径**、`warnings` **17 条**，措辞统一：

```
"<路径>: 基线读取失败（reg query <路径> did not run or failed unrecognizably
 (status=1, via=pipe, …): refusing to translate "we could not read it" into
 "the key does not exist"），该路径 **不** 进入候选 —— 候选必须冻结一个可验证的 before"
```

**因果链**：新建的沙箱键在**真实 hive 里不存在** ⇒ 宿主 reader（`reg.exe query`）读不到 ⇒
`classifyQueryFailure` 正确判"读不到"（不是"不存在"）⇒ 候选**拒绝冻结**。
`unfrozen=17 = 14 个进候选的键 + 3 个只有值写的键`，与 WAL 的路径集合吻合。

⇒ **可用性缺口**：候选面**只包含键创建**。即使候选被应用，值也不会被写回。
（对照：`run-isoA3` 的候选 `cs_0002_7fecd7be` / `cs_0003_cdb34931` / `cs_0004_f39647ee`
**有 `values=1` / `op=modify`** —— 证明"值冻结"这条代码路径本身可用，只是对**新建键**走不通。）

### 证据
- `run-burst2/wal/12-decoded.json`、`run-burst2/.../candidates/cs_0008_95bc4aec.json`（`values=0`；`unfrozen` 17；`warnings` 17）
- `evidence/surface/run-burst2/13-surface-bounded.txt`（8 个候选的 `summary` 一览，含 `cs_0016`＝shell 面 104 文件）
- `evidence/surface/run-isoA3/13-surface-bounded.txt`（`values=1` 的反例）

### 建议最小红检查
候选里必须至少出现一条 `valueName` 非空的注册表变更单元（当前 `values=0` 必然红）。
**附带问题**：17 条 `unfrozen` 里 `via=pipe` 出现 17 次 —— 宿主 reader 在管道被拒后是否每次
都白挨一次 EPERM（`runReg` 的 `pipesRefused` 粘性记忆只在一个进程内有效，每次 `reg query`
都是新进程）值得单独确认：**`not-run`**（本轮未测量该开销）。

---

## D-R4【低】`/reg:32` 整条通道不可用：契约要求"透传"，透传目标一律 `Access is denied`

**判定**：**契约符合 / 能力缺失**（v1.4 行为正确，但结果不可用于"视图对照"）

**契约侧符合**（WAL 逐字节证据）：5 条 `UNSTAGED`（`flags=[UNSTAGED]`、`status=0`）：

```
rec20 HKLM\SOFTWARE\WSTestR10Wow32      rec21 HKCU\Software\WSTestR10Wow32Cu
rec28 HKLM\SOFTWARE\WSTestR10Node32     rec37 HKLM\SOFTWARE\WSTestR10Registry32
rec43 HKLM\SOFTWARE\WSTestR10Net32
```

⇒ **没有任何一条 32KEY 被记成硬拒** ⇒ §8.3「64KEY 是 no-op、32KEY 透传」在本机成立。
`KEY_WOW64_64KEY` 走正常暂存：`WSTestR10Wow64` / `WSTestR10Registry64` 都是 `CREATE_KEY + SET_VALUE`、`status=0`。

**能力侧不可用**：

```
04-wow64.txt      [13] W9_HKCU_reg32_write        exit=1  ERROR: Access is denied.
05-wow64-net.txt  Registry32 create 'SOFTWARE\WSTestR10Net32'
                    → MethodInvocationException: "Access to the registry key … is denied."
                  Registry64 create 'SOFTWARE\WSTestR10Net64' → reportedSuccess=True
物理位置对照（HKLM\SOFTWARE\WOW6432Node\{WSTestR10Wow32,Wow64,Net32,Net64}）→ 全部 absent（一致）
```

⇒ **如实边界**：只能证明"64 位视图可暂存、32 位视图被正确透传且透传目标拒绝"，
**不能**证明"两个视图各自独立"。上一轮的 `.reg` 导入通道"无法评估"在本轮**已部分解除**
（`reg.exe` 可启动，见 §零残留 Z3），但 `reg import` 本身返回
`ERROR: Error accessing the registry.`（`03-regimport.txt` G1）——**而 WAL 里却留下了那次的 7 条记录**
（`run-burst2` 的 `rec11–rec17`：`WSTestR10Reg` 的 `RegImportSZ`/`RegImportDW`、`Child` 的 `ChildVal`、
以及 `HKLM\SOFTWARE\WSTestR10Reg` 那份）
⇒ 又一次"报告失败但暂存成功"的不一致（与 D-R1 同族，方向相反）。

### 证据
`run-burst2/.../probeout/04-wow64.txt`、`05-wow64-net.txt`、`03-regimport.txt`；`run-burst2/wal/12-decoded.json`

---

## D-R5【信息】**已由 Lead 修复**：注入器被 Defender 隔离期 ⇒ `tier=T1` 降级态下注册表写入 fail-closed（全拒）

**判定**：**降级路径本身正确**（缺陷是"产物被误杀"，22:52 已修）

| 时刻 | 事件 |
|---|---|
| 22:31:10 / 22:31:25 | Defender `ThreatID 2147731849` 隔离 `shim\out\winstage-inject.exe`（`Get-MpThreatDetection` 原文） |
| 22:33–22:36 | 我的 `run-burst` / `run-isoA` / `run-isoA2`：`launchMode=restricted-token`、`tierEffective=T1`、`fallbackClass=artifact-missing`、`degraded=true`，每次命令都降级 |
| 22:52 | Lead 修复（排除项 + 从归档恢复 `winstage-inject.exe`，159,232 B / `07FE55DD…518F`） |
| 23:05 起 | 正常态：`run-burst2` = `launchMode=shim` / **`tierEffective=TS`** / `degraded=false` |

**降级态下的注册表行为（单独一条观察，按要求不与正常态混写）**：
`run-burst`（降级）全部注册表写探针 **一律 `ERROR: Access is denied.`**
（`02-ps.txt` 13/13；`09-isolation` 步骤 [1]/[2] 均 `exit=1 Access is denied`），
**真实 hive 零残留**（宿主侧 25 项探针全 absent）。
`sandbox-lane.json` 自述与之逐字一致：
`"conclusion": "沙箱未生效：命令在受限令牌档（launchMode=restricted-token, tier=T1）执行，写入只剩内核硬拒…fail-closed fallback to the restricted-token mode"`。

⇒ **结论：Defender 隔离 → 透明模式失效 → 降级路径 fail-closed（不静默放行、不落真实盘）**。
这条链**是正确**的；应作为"降级不退化为静默放行"的正面证据引用。

### 证据
- `docs/round10/registry/evidence/threads/run-burst/stage-root-177071336716863/sandbox-lane.json`（降级原文）
- `run-burst/.../staged/probeout/02-ps.txt`、`09-isolation-isoA.txt`（降级态全拒）
- `helpers/95-runmeta.txt`（三件产物 PRESENT + sha256；本轮 `winstage-shim.dll` = `47DF4A5A…2DD6F2`，与配方 §5.6 记载一致）

---

## D-R6【低 · 探针侧，非产品缺陷】我的探针缺陷（已修，存证以免误判为产品问题）

0. **★ 离线 harness 桩层漏填 `g_orig.RegEnumValueW`（2026-10-10，导致 D-R11 假阳性）**
   —— 我的 `harness.c` 桩层只填了 8 个 `g_orig.Reg*`（`RegCreateKeyExW`/`RegOpenKeyExW`/`RegSetValueExW`/
   `RegQueryValueExW`/`RegDeleteKeyW`/`RegDeleteValueW`/`RegCloseKey`/`RegEnumKeyExW`），
   **漏了 `RegEnumValueW` 与 `RegQueryInfoKeyW`** ⇒ `g_orig.RegEnumValueW == NULL`
   ⇒ 基于枚举的读数**全部无效**，我据此报出的 **D-R11 是假阳性**（已撤回，见该条 §11.0）。
   修法：桩层补齐 `g_orig.RegEnumValueW = RegEnumValueW;` / `g_orig.RegQueryInfoKeyW = RegQueryInfoKeyW;`；补齐后枚举读数正确
   （`value_enum(0) name=""`、`value_enum(1) name="V"`、`value_enum(2) status=1`）。
   **影响面**：仅"基于 enum 的结论"；走 `RegQueryValueExW` 的回放/AFTER/C1/C2/C3 与窗口 #3/#4/#5 四条件读数**不受影响**。
   **纪律**：离线 harness 的 `g_orig` **必须覆盖被测 API**；凡调用 `g_orig.X` 而 X 未被桩层填充者，读数一律无效 —— 先证明"桩已覆盖"再报数。
   **证据**：`evidence/fix-r1/tier3-timing/{case2-enum-vs-get-WITHDRAWN.txt,case2-enum-vs-get-CORRECTED.txt}`。

1. **批处理 `:label` 里用 `%*`**：`%*` 在 `call :label` 内仍展开**原始 `%0..%9`** ⇒ 把标签自身当程序执行，
   首轮 `run-burst` 步骤 1–15 全 `exit=9009`（`'"A1_read_control_…" is not recognized …'`）。
   修法：`%2 %3 %4 %5 %6 %7 %8 %9`。**已用只读冒烟复跑验证**（`92-smoke-readonly.cmd` 5/5 正常退出）。
2. **`06-node-child.js` 被当 ESM**（仓库 `package.json` 有 `"type":"module"`）⇒ `require is not defined`。
   修法：改名 `06-node-child.cjs`，复跑已绿（5 条真实结果 + 显式负对照）。
3. **批处理传含空格的双引号参数会被截断**：`/d "hello-wstest-r10"` 实际写入 `dataBytes=2`（`0000`，空串）。
   影响 01-regcmd 的 SZ/DWORD/QWORD/BINARY 四个值探针；**不影响结论** —— 值读写由
   `02-ps.txt` 的 `PSZ=ps-sz-r10`（20 B）与 `C2 /ve "default-r10"`（24 B）独立证明。
4. `decode-journal.ps1` 的 `Write-Output $m` 在 `$m` 为多元素数组时逐元素输出 ⇒ 已改为 `Write-Output "$m"`。
5. **`08-staging-surface.ps1` 的递归清点在"stage root 内含 GB 级 `staged\`"时会跑几分钟** ⇒
   新增有界版 `13-surface-bounded.ps1`（不递归），本轮所有 surface 证据用它产出。

---

## D-R7【信息】历史遗留键仍在（**只报告，未删除**）

```
HKCU\Software\WinstageOpenq0731wq4
    P    REG_SZ    z
```

基线（Phase 1 前）与终态 export **逐字节相同**：
`sha256 = 90F6A9729E6A85E8BA48A67A6F2DCA31D1B6D8076A0F286FDB228077EB83C7C8`（两侧一致）。
与上一轮 verifier c2 的发现同源（`WinstageOpenq0731wq4`，`P=z`），属**先前会话遗留**。
按纪律**未删除、未修改**，仅登记。

**证据**：`evidence/baseline/export-HKCU-legacy-WinstageOpenq0731wq4-{baseline-phase1,final}.reg`

---

## 未测 / 不计入缺陷（诚实边界）

| 项 | 状态 |
|---|---|
| 上一轮"`reg.exe` 进程创建阶段被拒 7/7" | **本轮不复现**：正常态下 `reg.exe` 可启动且可写（`exit=0`）⇒ 上一轮那是受限令牌/降级态的产物，**不是**注册表策略本身 |
| 覆盖层「本进程写 → 本进程读回」 | **绿**（`02-ps.txt` P2 `readBack=True value=ps-sz-r10`） |
| 覆盖层「跨进程读回」 | **红**（D-R1） |
| `/reg:32` 真实视图隔离 | `not-run`（透传目标一律 `Access is denied`） |
| `apply()` 真实副作用 | `not-run`（本轮刻意不触发应用，避免动真实 hive） |
| `REG_OPTION_VOLATILE` / `RegSetKeySecurity` / §8.2 的 25 条硬拒 API | `not-run`（需专门夹具；本轮探针未构造） |
| "本轮写入不落真实注册表" | **绿**（零残留 Z1–Z7，见 `报告.md`） |
| 跨会话"互不可见"**正向**对照 | **不可判定**：本进程内自己的值都读不回（D-R1）⇒ 只能给"零交叉污染 + 真实 hive 不变"证据，**不能**给"互不可见"证据（如实降级表述） |
| `reg import` 的 7 条 WAL 记录 vs `ERROR: Error accessing the registry.` | 已记录（D-R4 末尾），**成因 not-run** |
