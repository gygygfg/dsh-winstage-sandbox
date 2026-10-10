# 修复 D-R1：共享 overlay hive 失手降级导致跨进程"写成功→读不回"

> 任务：`task-14`（owner `registry`）· 2026-10-09
> 范围：**只改** `shim/src/ws_t3reg.c`、`shim/src/ws_regstore.c`（+ `docs/round10/registry/**`、`.t/round10/registry/**`）
> **未碰** `ws_hook.c` / `ws_file.c` / `winstage_internal.h`（env-harness 范围）；**未写** `shim/out/**`。
> 交付状态：**源码改动完成、离线验证完成**；**端到端注入态验证未完成（见 §5，明确记为 INCONCLUSIVE）**。

---

## 0. 一句话

**根因不是并发，是设计**：`RegLoadAppKeyW + REG_PROCESS_APPKEY` 让覆盖 hive 一次只能被一个进程加载，
而被注入的父进程会**全程持有**共享 `overlay.hive`；于是每个子进程必然拿到
`ERROR_SHARING_VIOLATION(32)`，落到**按 pid 命名**的私有 hive，`Detach` 又把它删掉
⇒ **写进程退出即抹掉自己的覆盖层**，读进程从空 hive 起步。
修法：**把 journal 当唯一事实，app hive 只当它的物化视图**——每次 attach 回放 journal 到
"本轮拿到的那个 hive"；并把降级名改成会话级 `overlay.local.hive` 且不再删除。

---

## 1. 只读定因（原始证据）

### 1.1 机制链

| # | 事实 | 出处 |
|---|---|---|
| 1 | `DSH_REG_PROCESS_APPKEY` 使 hive 具**每进程**语义，进程 B 再 `RegLoadAppKeyW` 同一文件必得 `ERROR_SHARING_VIOLATION(32)` | `shim/src/ws_t3reg.c` 原注释（`t3_build_paths`）+ 实测 |
| 2 | 被注入的父进程（pwsh/cmd）在 attach 时拿到共享 `overlay.hive`，**持有到退出** | `shim.log` 的 `tier=1 hive=…overlay.hive` 行 |
| 3 | 每个被注入的子进程因此失手并降级 | `shared hive unusable (32) -> per-process hive=…overlay.<pid>.hive`，旧 DLL 实测 53/69 次 |
| 4 | 旧 `DshRegStageDetach` **删除**该私有 hive | `ws_t3reg.c:482-484`（原实现） |
| 5 | 于是"进程 A 写、进程 B 读"必然落空 | §2 的确定性复现 |

**关键更正（对 Phase 1 报告的修正）**：D-R1 不是"失手率 42%~100% 的抽奖"。
并发档的 42%/64%/79% 只是**掩盖**了必然性；**顺序形态（先写进程退出、再读）是 100% 必失**。

### 1.2 确定性最小复现（`probe/r1-repro.cmd`）

同一沙箱线程内，四个独立回合，每回合：`reg add` 建键 → `reg add /v V /d` 写值 → **另两个进程** `reg query` 读回。

| 回合 | 建键 | 写值 | 读键 | 读值 | 再读值 |
|---|---|---|---|---|---|
| t1 | 0 | 0 | **1** | **1** | **1** |
| t2 | 0 | 0 | **1** | **1** | **1** |
| t3 | 0 | 0 | **1** | **1** | **1** |
| t4 | 0 | 0 | **1** | **1** | **1** |

**8/8 写报成功（exit=0），12/12 读失败（exit=1，`unable to find the specified registry key or value`）**。
同时 WAL 里那 16 条写记录**一条不少**（`records=16 problems=0`）——写确实进了暂存，只是读不回来。

证据：`evidence/fix-r1/repro-baseline/`（`repro-t{1..4}.txt`、`wal/12-decoded.json`、`shim.log`）

> 复现脚本自身踩过的坑（已修，基线/修复两臂同用修正版）：早期版本用
> `cmd /c ""reg.exe" add … > file"` 的嵌套引号形式，cmd 把它解析坏 ⇒ 写成功却报 `exit=5`、
> 且 `/d` 值被截成空串。修正为**直接调用 + `> file 2>&1`** 后，退出码与数据都正确。

---

## 2. 修法（4 处，全部在授权文件内）

### 2.1 `ws_t3reg.c`

| # | 改动 | 作用 |
|---|---|---|
| **① 主修：attach 后回放 journal** | 新增 `t3_replay_journal()` / `t3_read_journal_all()` / `t3_replay_one()` / `t3_replay_create_key()` / `t3_replay_open_key()` | **app hive 不再被当作事实源**，它只是 journal 的物化视图；于是"本轮拿到哪个 hive"都不影响能不能读回。回放**幂等**（CREATE 已存在即 no-op、SET 同字节覆盖、DELETE 重打同一白障），所以可无条件在"可能已含部分状态"的 hive 上跑。 |
| ② 契约纪律 | 回放**跳过** `HARD_DENY(5)` / `UNSTAGED(6)` | 按 T3 §8.5.1：`UNSTAGED` 描述的是"这次调用**已经**交给真实系统"，重放 = 双重写入 |
| ③ 降级名改会话级 + 不再删 | `overlay.<pid>.hive` → `overlay.local.hive`；`Detach` 只删 tier-3 的 pid hive | 一个会话共用一个覆盖层文件，写进程退出不再抹掉它 |
| ④ 共享 hive **有界重试** | tier-1 最多 5 次、退避 5/10/15/20 ms；只对 `SHARING_VIOLATION`/`ACCESS_DENIED`/`BUSY` 重试 | `ERROR 32` 多半是兄弟进程正在退出，等一下就能拿回**共享**对象，不必付私有 hive 的代价 |
| ⑤ 三级兜底 | tier-3 唯一 `overlay.<pid>.hive`（仅当两个共享名都被并发占用） | 保证写仍能进 journal（宿主读的就是它），而不是硬拒 |
| ⑥ fail-closed | 回放失败 ⇒ `viewIncomplete=1` + `viewIncompleteStatus`；新增导出 `ws_t3_view_incomplete(LSTATUS*)` | 视图已知不完整时**绝不许写成功**（正是 D-R2 形态） |

### 2.2 `ws_regstore.c`

| # | 改动 | 作用 |
|---|---|---|
| ⑦ fail-closed 守卫 | 新增 `rs_view_incomplete_status()`，接在 4 条写路径入口：`key_materialize` / `key_delete` / `value_set` / `value_delete` | 拒绝时 `ws_rstore_hard_deny(path, <真实 LSTATUS>)` 落 WAL ⇒ **三分类必有其一**（消灭 D-R2 的"一种都不成立"） |
| ⑧ 白障可被回放重建 | 新增公开访问器 `ws_rstore_tomb_add()`（tomb 表仍 file-static，只有这一个写入口） | 早先进程删过的键/值，在后来进程回放时必须重新打白障，否则"删除"会复活 |

> 为何用 `extern` 自行声明而不是改头文件：`winstage_internal.h` 在本任务**写范围之外**；
> `ws_t3reg.c` / `ws_regstore.c` 各自声明对方新增的 2 个符号，语义不外泄、不扩大改动面。

---

## 3. 离线验证（用**真实源码**，确定性）

两文件单独编译（`zig cc -target x86_64-windows-gnu -std=c11 -O2 -Wall -Wextra`）：
**exit 0，0 warning**。

**完整构建**（env-harness 修好 `ws_hook.c` 后）：
`node tools\build-shim.mjs --out-dir .t/round10/registry/out-r1` ⇒ **exit 0，250,880 B，15 exports，0 warnings**
（只写我的 scratch 目录，未碰 `shim/out`）。

### 3.1 harness：两个**独立进程**，链接**未修改的真实源码**

`harness/harness.c` 只补 hook 层最小桩（`g_orig` 指向普通 Win32 `Reg*` API），
链接 `shim/src/ws_t3reg.c` + `shim/src/ws_regstore.c`（**就是交付的那两份源码**）。

| 用例 | app hive | journal | 结果 | 说明 |
|---|---|---|---|---|
| **AFTER** | 保留 | 保留 | **read-exit=0**，`value_get=0 type=1 bytes=24 hex=7700720069007400740065006e002d00620079002d004100` = `"written-by-A"` | 跨进程读回**成功且逐字节一致** |
| **C1** | **删除全部** | 保留 | **read-exit=0**，`replayedBytes=194` | **仅靠 journal 回放**就把状态带回 ⇒ 回放是真在干活，不是摆设 |
| **C2** | **删除全部** | **移走** | **read-exit=1**，`value_get=1`、`key_open=2`(FILE_NOT_FOUND)、`replayedBytes=0` | 断言**有牙**：这正是修复前的失败形态 |
| **C3** | 保留 | **首记录魔数损坏** | **write 被拒**：`JOURNAL REPLAY FAILED (13)` → `materialize status=13` / `value_set status=13`；WAL 追加 **2 条 `HARD_DENY status=13`** | fail-closed 生效且**可归因** |

C3 追加的两条记录逐字段合规：
`rec1 HARD_DENY type=REG_NONE status=13 flags=[HARD_DENY] path='HKCU\Software\WSTestR10DR1'`（rec2 同形）。

证据：`evidence/fix-r1/r1-verify.txt`、`{AFTER,C1,C2,C3}-*.txt`、`C3-harddeny.txt`

### 3.2 判据汇总

| 要求 | 结果 |
|---|---|
| ① 确定性最小复现 | ✅ 4/4 回合、12/12 读失败（100%，非抽样率）；`arm-baseline` 在**已钉哈希**的 DLL 上复现 |
| ② 修：写成功→读得回 | ✅ 离线两进程验证通过（§3.1）；**注入态端到端待下一次受控窗口**（§5.2.3，现记"无法判定"） |
| ③ D-R2 可归因 | ✅ 拒绝走 `HARD_DENY` + 真实 LSTATUS（C3 实证） |
| ④ D-R3 值冻结 | ⏳ 只做归因，未改（见 §6） |
| ⑤ 门禁不回归 | ⏳ 待受控替换窗口（`exe` 执行；候选 `out-r2` `C642B6AF…`，见 §7.3） |
| ⑥ **修复过程中的自查** | ✅ 修掉了**我自己实现的一个缺陷**（回放在 `g_orig` 就绪前调用 ⇒ DllMain 抛错）：离线两态对照 BEFORE `NULL err=1114` → AFTER `OK`（§5.2.2）；并因此单列出独立高危缺陷 **D-R8（fail-open）** 与信息项 **D-R9（构建不可字节复现）** |

---

## 4. 与修复前的对照（同口径）

| 指标 | 修复前（旧实现） | 修复后（离线 harness，真实源码） |
|---|---|---|
| 跨进程读回 | **12/12 失败** | **成功**（24 B 逐字节一致） |
| app hive 被删后能否读回 | 不能（状态随之消失） | **能**（journal 回放，C1） |
| hive + journal 都没了 | 失败 | **失败**（C2，符合预期） |
| 回放失败时的写 | 报成功（静默不一致） | **拒写 + `HARD_DENY(status=13)`**（C3） |
| 降级 hive 命名 | `overlay.<pid>.hive`（一进程一个） | `overlay.local.hive`（一会话一个，不删） |
| 共享 hive 冲突 | 立刻降级 | 先**有界重试** 5 次再降级 |

---

## 5. ⚠ 端到端（注入态）验证：**无法判定**（不声明通过）

> 三选一结论 = **无法判定**。已定案的是**修复前必失**（§5.1，哈希已钉）；未定案的是修复后能否读回（§5.2）。
> 阻断原因是**注入器只把候选装进宿主、装不进子进程**，与我的改动无关（同形现象在我自己的候选与
> env-harness 的 13c 上**逐字相同**）。

### 5.1 已定案的一半：**修复前必失**（哈希已钉）

| 运行 | 起始 | DLL（钉死并记录） | 结果 | 判定 |
|---|---|---|---|---|
| `arm-baseline` | **17:31:26** | `shim/out/winstage-shim.dll` 246,784 B = `02C7418EF0F11AFD45FEEA601733E848ECB697FD393915565420F7A41248B76F`（injector `07FE55DD…518F`） | **4/4 回合、8/8 写 exit=0、12/12 读 exit=1** | ✅ **确定性必失，成立** |

证据：`evidence/fix-r1/arm-baseline/{DLL-PROVENANCE.txt, transcripts/repro-t{1..4}.txt, wal/}`

### 5.2 未定案的一半：注入态读路径 —— **最初判"无法判定"，随后定因为"候选自身缺陷（已修）"**

#### 5.2.1 现象的两次尝试（保留原始读数）

三次候选臂（我自己的 `out-r1`、`out-cur`，以及 env-harness 的 `out-13c`）**全部**卡在同一位置：

| 臂 | DLL | 路径 | `TS_INJECTION_FAILED` | 子进程是否被注入 | 结果 |
|---|---|---|---|---|---|
| `arm-baseline` | `02C7418E…` | **`shim/out`** | **0** | **是** | 4/4 回合跑完 |
| `arm-fixed` | `4066041E…` | `.t/…/registry/out-r1` | **20** | **否** | 只跑完 t1 |
| `arm-13c` | `5E7A010E…` | `.t/round10/shim/out-13c` | **15** | **否** | 只跑完 t1 |
| `arm-cur` | `0C373595…` | `.t/…/registry/out-cur` | **24** | **否** | 只跑完 t1 |
| `arm-ctl`（**位置对照**） | `02C7418E…`（**内容=基线，仅换目录**） | `.t/…/registry/out-ctl` | **0** | **是** | 4/4 回合跑完 |

`arm-ctl` 排除了"DLL 在 `shim/out` 之外就装不进子进程"这一猜想 —— **位置不是原因**。
失败形态：`remote LoadLibraryW failed — refusing to continue unconfined (fail-closed)`；
`reg.exe` 子进程无 shim ⇒ 返回 `ERROR_ACCESS_DENIED(5)`。

#### 5.2.2 定因：**我自己的实现缺陷**（NULL 调用），已修

`ws_entry.c` 在 **`:157`** 调 `DshRegStageAttach()`，而 `ws_hook_init()`（捕获 original API）在 **`:165`** 才执行。
我的 journal 回放跑在 attach 里 ⇒ 调用 `g_orig.RegCreateKeyExW` 时 **`g_orig` 仍是全 0** ⇒ **NULL 调用 → DllMain 抛错 →
`LoadLibraryW` 返回 NULL / `ERROR_DLL_INIT_FAILED(1114)`**。
只在 **journal 非空**时触发 —— 正是"读回别人写的值"那一刻（写方 attach 时 journal 还是空的，所以写总是"成功"）。

**离线决定性对照**（`harness/loadtest.c`：只 `LoadLibraryW`，不涉沙箱；seed = 170 B 真实 journal）：

| DLL | 空 journal | **非空 journal** |
|---|---|---|
| stock `02C7418E`（无 D-R1） | OK | **OK** |
| BEFORE `out-r1` / `out-13c` / `out-cur` | OK | **NULL err=1114** |
| **AFTER `out-fix1` `441D159D…`** | OK | **OK** ✅ |
| **AFTER `out-r2` `C642B6AF…`** | OK | **OK** ✅ |

**修法**（仅 `ws_t3reg.c`）：回放不再直接用 `g_orig.Reg*`，改走 6 个包装
`t3_reg_create` / `t3_reg_open` / `t3_reg_set_value` / `t3_reg_delete_key` / `t3_reg_delete_value` / `t3_reg_close`：
**original 已就绪就用它，否则直调 Win32**。安全性：`ws_hook_install()` 在 `:170`，回放更早 ⇒ 直调不可能重入本 DLL 的钩子；
`ws_hook_init()` 之后 `g_orig.*` 非空 ⇒ 后到的 re-attach 仍走 original。顺带把 `DshRegStageDetach` 里
唯一一处未加保护的 `g_orig.RegCloseKey` 也换成了 `t3_reg_close`（同一类 NULL 调用）。

**顺带解决**：`exe` 窗口里 `registry-unstaged-wow64 30/6`（`/reg:32` 由 `ACCESS_DENIED(5)` 变为返回 0 + 真实 hive 键消失 +
`UNSTAGED` 缺失）与 `registry-guard`/`registry-conformance` 的 A.2/A.5 新鲜度红，**均由这条缺陷解释**
（后者是证据链被打断，前者见独立缺陷 [`defects.md` D-R8](./defects.md)：**载体无钩子运行 = fail-open**）。

#### 5.2.3 结论（三选一）—— **受控窗口 #3 已给出终局读数：仍未修（已定因到 `ws_reg.c`）**

**窗口 #3**（2026-10-09 21:51:55 起；候选 `out-r2` `C642B6AF…` 换入 `shim/out`，`exe` 执行并复核"在盘整件哈希 = 交付声明"，无交付漂移）：

| 项 | 读数 |
|---|---|
| 钉哈希 | 跑前/跑后均 `C642B6AF546B66E9441F9C51E31FB5A9977299D2B6CA320575E6A224008FF684`（脚本两次钉哈希一致） |
| `self=` | `…\shim\out\winstage-shim.dll` ⇒ 确为候选 |
| **`replayedBytes>0`** | ✅ `t3_replay_journal: applied=3 auditSkipped=0 bytes=282 rc=0`（多进程一致；`viewIncomplete=0` 全部；tier 1/2/3 均在用） |
| `query-key-exit` | **0**（键可见）——但 `step2a` 输出**为空**（0 个值） |
| **`query-value-exit` / `query2-value-exit`** | **1**，`ERROR: The handle is invalid.`（四回合逐字相同） |
| **结论** | **仍未修**（值读回 4/4 失败） |

**判据纪律（我此前"`query-*-exit=0`"的表述含糊，已修正）**：
- ✅ **唯一权威判据 = `query-value-exit` / `query2-value-exit`**；
- ❌ `query-key-exit` **不等价** —— 只证明"**键**在覆盖层里可见"（键在而值空也算 0）；
- ❌ `r1-repro.cmd` 的外层 `EXIT=0` **不是判据** —— 只是批处理脚本退出码（实测 `stdout.ndjson` 里 `EXIT=0` 与 `query-value-exit=1` 同时出现）。

**定因（离线判据：链接真实源码的 harness + 本次窗口原始 journal 4576 B / 28 条）**：
```
t3_replay_journal: applied=28 auditSkipped=0 bytes=4576 rc=0
key_resolve=0 flags=17 key_open=0   (STAGED=1 EXISTS=16 REAL=4)
value_get(V) status=0 type=1 bytes=26 hex=7700720069007400740065006e002d00620079002d0041000000 text="written-by-A"
RESULT readseeded key_resolve=0 key_open=0 key_exists=1 value_get=0
```
⇒ **回放把值正确写进了 app hive、provider 逐字节读回成功** ⇒ 失败**不在回放**，而在**钩子层的伪句柄读路径**：
`shim/src/ws_reg.c:958` 的 `canServe` 为假时，`:967-969` **把伪句柄直通 `g_orig.RegQueryValueExW`** ⇒ `ERROR_INVALID_HANDLE(6)`
（`:963-966` 的注释**逐字预言**了该错误码；伪句柄在 `:568/:600/:687` 由 `ws_pseudo_key_make` 产生）。
**已单列为 [`defects.md` D-R10](./defects.md)（高；归属 `ws_reg.c`；Lead 已派 owner `env-harness`）。**

**归因纪律**：这是**既有**缺陷、由本修复**首次暴露** —— 修复前该键在覆盖层里不存在（`query-key-exit=1`「找不到」），根本走不到 `:958`；
修复后键可见，才撞上它。所以 `out-r2` 判"仍未修"**准确**，但**待修对象不是我的文件**。`ws_reg.c` 我一行未动。

**对 BEFORE 候选（`out-r1`/`out-cur`/`out-13c`）**：**仍失**，且已定因为**候选自身缺陷**（见 §5.2.2，非"方向错"）。

**下一轮**：候选由 `env-harness` 出（`ws_reg.c` 修复 + 我的 D-R1 源码合并；建议命名 `out-16` 并记录 `.text` 代码身份）。
我只需在窗口内跑四回合 `r1-repro`，判据 **`query-value-exit=0` 且 `replayedBytes>0`**，**不需要**重建候选。

#### 5.2.4 受控窗口 #4：候选 `out-15` **仍未修**，并定位到 `ws_reg.c` 的**另外三个函数**

`exe` 换入 `out-15` = `17825DF4F255B72BFE6091CC4B937E70DC44AE11FEDFEB399C9363EAC0FD76E9`（251,392 B），
我在窗口内跑四回合（`evidence/fix-r1/arm-window4/**`）：

| 项 | 读数 |
|---|---|
| 哈希门禁 | `BEFORE = EXPECTED = 17825DF4…`；`AFTER` 同值 ⇒ `DLL_HASH_STABLE_DURING_RUN=True`（**无中途回滚**） |
| `self=` | `…\shim\out\winstage-shim.dll ok=1` |
| **`replayedBytes>0`** | ✅ `0,170,282,368,480,566,678,764,876` |
| `query-key-exit` | **0**（键可见；`step2a` 输出为空） |
| **`query-value-exit` / `query2-value-exit`** | **1 / 1**（四回合一致） |
| 错因 | **`ERROR: The handle is invalid.` × 8** |
| **结论** | **仍未修（read-back 0/4）** —— 与窗口 #3 **同一签名** |

**追加定因（本轮最有价值的一条）**：`out-15` 里 `ws_reg.c` **确实已含 task-17 修复**（`:958-987`），
但**只修了 `ws_query_value_ex` 一个函数**；同族三处仍在把伪句柄直通 advapi32 ——
`:1464-1466`（`RegQueryInfoKeyW`）、`:1550-1552`（`RegEnumValueW`）、`:1635-1637`（`RegEnumKeyExW`）。
这同时解释了两个表征：`/v V` 读值撞 `RegQueryInfoKeyW` ⇒ `ERROR_INVALID_HANDLE(6)`；
不带 `/v` 的 `reg query <key>` 撞枚举 ⇒ **0 项 + 退出码 0（`step2a` 为空）**。
详见 [`defects.md` D-R10 §10.3b](./defects.md)（含修法：把那套 `ws_pseudo_key_path` 取回 + fail-closed 抽成共用函数，应用到三处）。

**`exe` 的独立交叉验证**（同一件 `out-15`，离线双进程 + 真实 `RegQueryValueExW`）：取到 **`ERROR_SUCCESS` + `written-by-A`**
⇒ 回放侧与加载侧都无问题，失败点确在沙箱内的伪句柄读路径，与上述定因一致。

**下一候选（`out-16`）验收口径（四者必须同时成立）**：
① 四回合 `query-value-exit=0` ② 四回合 `query2-value-exit=0` ③ **`step2a` 非空**（枚举能看到值）④ `replayedBytes>0`。
①③ 缺一即说明读路径仍有未修的伪句柄直通点。

**⚠ 一条必须写进下一轮清单的经验**：窗口 #4 内**并集门禁全绿**（closedloop 30/30、`registry-guard` 385/0、
`registry-conformance` 65/0、`registry-unstaged-wow64` 36/0、delete-capture 36、file-cow 19/19、boundary 62/0、
整仓 autotest **33/0/0 · 2076 ok/0 bad**）**却仍然 `query-value-exit=1`**
⇒ **没有任何门禁能替代"读回"判据**；门禁全绿不等于 D-R1 已修。

**窗口 #4 收尾（`exe` 广播）**：`shim/out` 已回滚 `02C7418F…`/246,784 B，inject/probe 未覆盖，`baseline --check` exit 0/115，
回滚后 `registry-conformance` 65/0/1 exit 0。我的 runner 表现合格（哈希硬门禁拦住错件、逐回合判据解析、AFTER 同值）。

#### 5.2.5 受控窗口 #5（`out-16` `06B2D381…`）：四条件 **0/4**，并缩小到两个独立读路径缺陷

| # | 条件 | 读数 |
|---|---|---|
| — | 哈希门禁 | `BEFORE = EXPECTED = AFTER = 06B2D3816684E407DA3C31D32220BF7838A85F86462102137AE5A93201919D2C`（无中途回滚）；`self=…\shim\out\winstage-shim.dll ok=1` |
| ① | `query-value-exit=0` ×4 | **1 / 1 / 1 / 1** ❌ |
| ② | `query2-value-exit=0` ×4 | **1 / 1 / 1 / 1** ❌ |
| ③ | `step2a` 非空 | **空**（2 B = 仅 CRLF）×4 ❌ |
| ④ | `replayedBytes>0` | ✅ `0,170,282,…,876` |
| — | 错因 | `ERROR: The handle is invalid.` × 8 |

**`REGDBG`（`out-16` 内建插桩）的运行时事实**：对探针键 `HKCU\Software\WSTestR10DR1`，**8 个读子进程逐个**都是
`ctxOk=1 isPseudo=1 isBareRoot=0 canServe=1` + `branch=ctx-recovered`；全日志 `branch=` 仅 `PASSTHROUGH=7316` / `ctx-recovered=8`；
每个读子进程都 `hooks installed: 75 IAT sites across 9 modules (… reg=on)`；**8 个读者全部 tier=3**（`BOTH shared hives unusable (32/32)`）。
⇒ **task-17 的修复路径确实执行了、钩子确实装上了** —— 失败点不在"没拦到"，而在"拦到之后仍读不回"。

### 5.3 时序疑点闭环（Lead 正交合查项）：journal 长度**不会**落后，`real-open err=2` **不是**竞态

**最小复现**（离线、两进程、真实源码；`harness/r1harness.exe`）：

| 步骤 | 读数 |
|---|---|
| A（写者）attach | `tier=1`，`replayedBytes=0` |
| A 写 | `materialize=0 value_set=0 same_process_get=0` |
| **A 落盘后 journal 字节** | **194** |
| B（读者）attach | **`applied=2 bytes=194 rc=0`** ⇒ **恰好等于 A 落盘后的 journal 长度** |
| B 读 | `value_get status=0 bytes=24 "written-by-A"`；`key_resolve=0 flags=17 key_open=0` |

第二轮（同法）：journal **304** ⇒ 读者 `applied=3 bytes=304`。**两次逐字节吻合。**

**结论 1 —— journal 长度不会落后**：WAL-first（先追加 journal 再落实状态）+ 共享追加文件 ⇒ 读者看到的 **≥** 写者已 flush 的记录；
两个受控例子 `replayedBytes` 与 journal 字节数**完全相等**（194/194、304/304）；窗口 #5 读者的 `170,282,…,876` 也正是 journal 的累积前缀，
**无截断、无旧长度** ⇒ **这不是四条件继续红的原因**。

**结论 2 —— `real-open ok=0 err=2` 不是 per-process hive 的创建/命名/清理竞态，与 `swept` 无关**：
它出自 `ws_reg.c` 的 **real-hive 回退**（`ws_reg_real_root(hive)` + `RegOpenKeyExW(realRoot, rel, …)`）；
`err=2` = `ERROR_FILE_NOT_FOUND`，因为**真实 HKCU 本来就没有这个只被暂存的键** ⇒ **期望行为**。
它的价值是**症状**：`real-open` 出现即说明那一刻 **provider 的 `value_get` 没供上值**。

**结论 3 —— ❌ 原判 D-R11「provider 枚举看不到已回放的值」是 **我方夹具假阳性**，已撤回（存档见 [`defects.md` D-R11](./defects.md) §11.0）**：

当时的（**无效**）读数：
```
value_get(V)  status=0 bytes=26      ← 值在
value_enum(0) status=1 name=""       ← 假阳性：来自 NULL 指针，不是 provider 行为
```
**根因**：我的离线 harness 桩层只填了 8 个 `g_orig.Reg*`，**漏填 `RegEnumValueW`**（与 `RegQueryInfoKeyW`）
⇒ `g_orig.RegEnumValueW == NULL` ⇒ 枚举读数无效。**补全桩层后**（同一 journal / 进程 / 键）：
```
value_get(V)  status=0 bytes=26
value_enum(0) status=0 name=""       ← 默认值（空名）
value_enum(1) status=0 name="V"      ← 探针值正常枚举出来
value_enum(2) status=1               ← 枚举正常结束
```
⇒ **provider 的 `get`/`enum` 一致；`ws_regstore.c` 无须改动。**（纯 Win32 对照 `harness/apphive-enum.c` 也证明 app hive 枚举本来正常。）
`exe` 已用同一二进制独立复跑确认（其原始件 `.t/round10/verify/d58-dr11-diagseed.txt`）。
**净影响**：只有"基于 enum 的结论"作废；回放/AFTER/C1/C2/C3 与窗口 #3/#4/#5 的四条件读数**全部照旧有效**。

**⇒ 四条件之红（撤回后修订）= 单一族**：`query-value-exit` 与 `step2a` 空**大概率同源**，都由 **D-R10（钩子层伪句柄，`ws_reg.c`）** 一族解释 ——
`reg query <key>`（不带 `/v`）会先调 `RegQueryInfoKeyW`、再走 `RegEnumValueW`/`RegEnumKeyExW`，
而这四个 API（含 `RegCloseKey`）正是 `out-16` 里**唯一没有 REGDBG 插桩的** ⇒ **下一窗该动的是插桩那四个 API，不是 provider。**

**未做的取证（`not-run`）**：原想用 `holdshared` 模式持有两把共享 hive 制造 `SHARING_VIOLATION(32)` 以离线强制 tier=3，
但 `Start-Process` 被策略拦截 ⇒ **tier=3 下读数未取得**。（撤回 D-R11 后，这条不再影响归因。）

#### 5.2.7 受控窗口 #7（`out-18c` `DE59C89D…`）：四条件 **3/4**，仅枚举面仍红

候选 `out-18c` = `DE59C89D84700FDF57EEFB2D9D81555E8B80E0B9242B49B2939E2AD23A57E881`（256,000 B；`.text` `20511486…`；15 exports）
换入 `shim/out`（`exe` 执行并复核在盘=交付值）。**过程披露**：本次运行原是我为"哈希门禁自测"启动的干跑（OutDir `gate-selftest3`），
启动瞬间换件落盘，脚本读到 `BEFORE == EXPECTED` ⇒ **门禁正确放行并直接跑完一次真实四回合**；
读数有效但非"官方启动"，已在 `evidence/fix-r1/arm-window7/README-WINDOW7.txt` 逐条写明来路。

| # | 条件 | 读数 |
|---|---|---|
| — | 钉哈希 | `BEFORE = EXPECTED = AFTER = DE59C89D…`；`DLL_HASH_STABLE_DURING_RUN=True`；`self=…\shim\out\winstage-shim.dll ok=1` |
| ① | `query-value-exit=0` ×4 | **0 / 0 / 0 / 0** ✅ |
| ② | `query2-value-exit=0` ×4 | **0 / 0 / 0 / 0** ✅ |
| ③ | `step2a` 非空 | **2 B / 0 非空白** ❌ |
| ④ | `replayedBytes>0` | ✅ `0,170,282,…,876`（`applied=2 bytes=170 rc=0` …） |

值读回逐字 `V    REG_SZ    written-by-A`（四回合一致）⇒ **D-R1 的读回目标继续成立**。

**③ 的最尖线索**：`step2a`（**不带 `/v`**）= **2 B**，而 `step2b`/`step3`（**带 `/v V`**）= **78 B / 58 非空白、都打印出了值**。
**`REGDBG api=` 计数**：`RegCloseKey` 17,512（全 `ret=0`）、`RegQueryInfoKeyW` 12,290（全 `ret=0`）、
`RegEnumValueW` 8,042（`ret=0`×8005、`ret=259`×37）、`RegEnumKeyExW` 2,557（`ret=0`×2462、`ret=259`×95）。
⇒ **四个 API 都被拦到且绝大多数返回 0，`reg query <key>` 仍打印空** ⇒ 残留**不是**"API 未挂钩"的朴素形态。
归属仍由 owner 判定（`exe` D61 / `D-R10-enum` / `D-R12`）；本域只交事实与该反差。
#### 5.2.6 受控窗口 #6（`out-18b` `8FEAB38D…`）：**D-R1 已修并端到端验证（四条件 3/4）**

候选 `out-18b` = `8FEAB38D89ED372BD891A2A017575D5B81C86C0199DCA3F7C11EE784FDB82D66`（253,440 B；15 exports；含 `REGDBG api=` 5 处）换入 `shim/out`，
经**官方入口** `sbx-thread` 跑四回合（`evidence/fix-r1/arm-window6/**`）：

| # | 条件 | 读数 |
|---|---|---|
| — | 哈希门禁 | `BEFORE = EXPECTED = AFTER = 8FEAB38D…`；`DLL_HASH_STABLE_DURING_RUN=True`；`self=…\shim\out\winstage-shim.dll ok=1` |
| **①** | `query-value-exit=0` ×4 | **0 / 0 / 0 / 0** ✅ |
| **②** | `query2-value-exit=0` ×4 | **0 / 0 / 0 / 0** ✅ |
| ③ | `step2a` 非空 | **仍空**（2 B）❌ |
| **④** | `replayedBytes>0` | ✅ `0,170,282,…,876` |

**决定性正面证据（`transcripts/repro-t1.txt` 逐字，t2/t3/t4 同形）**：
```
--- STEP2 read (reg.exe child) ---
query-key-exit=0

query-value-exit=0

HKEY_CURRENT_USER\Software\WSTestR10DR1
    V    REG_SZ    written-by-A        <- 前一个进程写的值，被后一个进程逐字节读回

--- STEP3 read again (third reg.exe child) ---
query2-value-exit=0

HKEY_CURRENT_USER\Software\WSTestR10DR1
    V    REG_SZ    written-by-A
```
⇒ **窗口 #3/#4/#5 连续三轮的"写成功→读不回"红项全部消失。D-R1 的修目标达成。**

**③ 的残留（唯一未过项，且已缩小范围）**：`step2a`（`reg query <key>`，**不带 `/v`**）仍空，但**反差鲜明**：
`step2b`（带 `/v V`）与 `step3` 各 **78 B / 58 非空白字符**，**都打印出了那个值**。
⇒ 失败只在"**枚举**"这一面，**不是** provider（D-R11 已撤回），也不是"值读不回"。
归属见 `exe` 的 `docs/round10/shim/evidence/D61-window6-verdict.md`（记为同一族的未完成面：ntdll 直调面
`NtQueryValueKey` 已修、`NtEnumerateValueKey`/`NtQueryKey` 仍 `0xC0000008`），并单列下一轮待办 `D-R10-enum`/`D-R12`。
**我的读数只支持"枚举面单独未过"，不替 owner 下归属结论**；`step2a`=2 B vs `step2b`=78 B 这条反差可直接复用。

**四 `REGDBG api=` 证据（本窗新插桩，条件③定因用）**：`exe` 统计 `RegCloseKey` 16,292 / `RegQueryInfoKeyW` 11,472 /
`RegEnumValueW` 7,372 / `RegEnumKeyExW` 2,353，返回值域含 `0,0,259`（`259 = ERROR_NO_MORE_ITEMS`）；
原文在 `arm-window6/logs/shim.log`（我 runner 新增的抽取段会原样附回）。

**窗口收尾**：`exe` 按协议回滚 `shim/out` = `02C7418F…`，`baseline --check` exit 0/115。
**纪律（本轮教训，已写入 D-R6 第 0 条）**：离线 harness 的 `g_orig` **必须覆盖被测 API**；
凡调用 `g_orig.X` 而 X 未被桩层填充者，读数**一律无效** —— 先证明"桩已覆盖"再报数。`exe` 已把它并入复核协议（三步检查：覆盖了哪些 / 被测路径调用哪些 / 差集是否为空）。

**纪律**：本轮**未改 `shim/src`** —— 授权到手后我在动手前先做了桩层自检，从而发现了假阳性，**最终没有对 `ws_regstore.c` 施加任何补丁**
（其 sha256 仍为 `125CB9FFA5D83F9651214C0FB989A45FB8E49515698406963B79B3B094F03D23`，未改一行）；
本轮改动仅限 `.t/round10/registry/harness/**`（自建夹具）与文档。

**顺带排除的两件事（有价值）**：
1. **不是我的 `out-r1` 构建坏了** —— env-harness 的 13c 表现**逐字相同**（宿主 ok=1 / 子进程 15 次失败），
   且 13c 里确实含我的改动（ASCII 串 `tier=%d hive=%ls`/`JOURNAL REPLAY FAILED`/`SESSION hive=%ls`/
   `viewIncomplete=%d` 命中；宽串 `overlay.local.hive` 以 UTF-16LE 命中）。
2. **我的写路径在候选里是通的** —— `arm-13c` 那次唯一被注入的 `reg add` 成功写进了 journal
   （`rec1 CREATE_KEY` + `rec2 SET_VALUE`，170 B，`problems=0`），只是随后的读进程都没被注入。

**本修复的正面外部读数（`exe` 独立记录）**：候选 `out-r2` 下 **`registry-unstaged-wow64` 由 6 bad 改善到 `36/0`**
（原始见 `docs/round10/shim/evidence/D47-2-window3-verdict.md`）。
⇒ 说明 D-R1 的改动**确实**修好了一部分真实用例；唯一残留是 D-R10 的钩子层缺陷。

**环境阻塞（与本次结论无关，但会挡住任何后续验证）**：`exe` 通报
**`src/stage-guard.mjs:209` 存在 Git 冲突标记 `<<<<<<< HEAD`**，24 个受封印文件漂移、`baseline --check` exit 4
⇒ **所有套件当前都跑不起来**。该文件**不在本任务写范围**（我在 5.2 的对照里也是"窗口内四回合"而非套件）。
⇒ **冲突解决前不得开新窗口**；我已同步 `exe`/Lead，不自行动他人的文件。

**仍未闭合的唯一断言**：`replayedBytes>0` 的 attach 行。等候选真的进 `shim/out` 后再取。

#### 5.3c 受控窗口 #8（`out-22` `63808F51…`）：**四条件 4/4 —— PASS，并已按协议采纳（保留）**

| # | 条件 | 读数 |
|---|---|---|
| — | 钉哈希 | `BEFORE = EXPECTED = AFTER = 63808F5188643C085BDC71E86AC843BB8758579938A4CB61781044B93C8A99EB`（257,024 B）；injector `07FE55DD…518F` 未覆盖；`DLL_HASH_STABLE_DURING_RUN=True`；`SBX_THREAD_EXIT=0`；`self=…\shim\out\winstage-shim.dll ok=1` |
| ① | `query-value-exit=0` ×4 | **0/0/0/0** ✅ |
| ② | `query2-value-exit=0` ×4 | **0/0/0/0** ✅ |
| ③ | `step2a` 非空 ×4 | ✅ **78 B / 58 非空白**；`step2a` / `step2b` / `step3` **三者同一 sha256** `12AA39D1F31AF899C625CDB0D7DB384F86F394262801252D5334FADE863972CB`，内容 `HKEY_CURRENT_USER\Software\WSTestR10DR1` ＋ `V    REG_SZ    written-by-A` |
| ④ | `replayedBytes>0` | ✅ `0,170,282,368,480,566,678,764,876` |
| — | **VERDICT** | **PASS（四条件全中）** |

**两条独立路径互证**：`step2a` 的 sha256 与 `exe` 在**窗口外、只改 `WINSTAGE_SHIM_DLL`、不换件**跑 `step2a-min.cmd` 得到的哈希**完全相同**（`12AA39D1…72CB`）。

**机制级证实（比"两串字节相等"更强）**——插桩原文：
```
REGDBG qik pid=2624 hKey=0000025114ADF1B0 isPseudo=1 ret=0 lpcValues=1 maxNameLen=4 maxValueLenWritten=0 maxValueLenComputed=26
REGDBG qik-unionfail pid=2624 index=1 hive=HKCU rel=Software\WSTestR10DR1 canonical=HKCU\Software\WSTestR10DR1 real=0
```
`lpcValues` **0 → 1**、`qik-unionfail` 的 `index` **0 → 1**。
**句柄量级普查**（`hKey > 0x100000` 为伪句柄）：`RegQueryInfoKeyW` pseudo=8 / real=11,464；
**`RegEnumValueW` pseudo=4** / real=7,372（**窗口 #7 为 0**）；`RegEnumKeyExW` pseudo=0 / real=2,485；`RegCloseKey` pseudo=22 / real=16,359。
⇒ 伪句柄上 `RegEnumValueW` **0 → 4** 正对应"四个 `step2a` 子进程各枚举一次"，与条件 ③ 转绿同步。
（`exe` 独立按数值重算得 pseudo `RegQueryInfoKeyW=8` / `RegEnumValueW=4` / `RegCloseKey=20`；22 vs 20 属句柄归类边界，**决定性结论一致**。）

**采纳状态**：按协议"**全过保留 / 任一不过回滚**"，本窗 **4/4 ⇒ 保留**：`shim/out` 现为 `63808F51…`/257,024 B。
（我此前一句"可按协议回滚"是**笔误**，`exe` 已更正、Lead 已确认。）

**⚠ 口径更正（避免幻影缺陷）**：我先前写"`maxValueLenWritten=0` 而 `maxValueLenComputed=26` ⇒ `:1889`（原 `:1865`）仍是缺陷"——**本窗无法支持该结论**：
`maxValueLenWritten` 是 `out-20` 插桩里**硬编为 `0ul` 的构造性陈旧标签**，**并未读取 `:1889` 实际发布的值**。
⇒ 本窗只证明"该插桩字段没读真实值"，**不证明发布值有误**。**该条已由 `pkgs` 的 `out-22b` 复测闭环**（仅标签诊断件、不替换 `shim/out`）：标签改为读实际发布值后**实测仍为 0**，`union kind=values valid=1 count=1`，`step2a`/`step2b` 仍 78 B 且与窗口 #8 同哈希 ⇒ **无语义影响**；判读为**调用方（`reg.exe`）对该字段传 `NULL`（未请求 MaxValueLen），写回 0 属正确语义**；产品侧 `ws_reg.c` 已是 `if (lpcbMaxValueLen) *lpcbMaxValueLen = maxValueLen;`（**无残留产品缺陷**）。**限制**：单条日志无法区分"指针为 NULL"与"被写成 0"，彻底闭环需再加 `maxValueLenPtr=%d`（未做）。详见 [`defects.md`](./defects.md) 的 `D-R10-enum` 节。原状态：**"未被本窗证据支持，待复测"**；
复测方式：把插桩改为读取实际发布的 `*lpcbMaxValueLen`，或加一个只读该字段的调用方探针。

**证据**：`evidence/fix-r1/arm-window8/**`（`README-WINDOW8-PASS.txt`、`WINDOW-PROVENANCE.txt`、`transcripts/*`、`logs/shim.log`、`wal/*`）。

### 5.6 环境事件（影响取证，不影响源码）

---

## 6. D-R3（值 0/16 冻结）—— 只做归因，未改

根因在**宿主侧**：新建键在真实 hive 中不存在 ⇒ 宿主 reader（`reg.exe query`）读不到 ⇒
`classifyQueryFailure` **正确地**拒绝把"读不到"翻译成"不存在" ⇒ 候选拒绝冻结该路径。
`ws_regstore.c` 侧能做的是"把这件事实显式化"（例如在 WAL/审计里标出"该单元基线不可验证"），
**不改变语义、也不该在本任务扩大改动面**。按 Lead 指示：**维持归因，不动**。

---

## 7. 待集成清单（交给 env-harness / Lead）

### 7.1 改了哪些文件

| 文件 | 大小 | mtime | 说明 |
|---|---|---|---|
| `shim/src/ws_t3reg.c` | 46,009 B | 10-09 16:51:26 | 回放 + 三级 hive + 重试 + fail-closed 状态 + `ws_t3_view_incomplete` |
| `shim/src/ws_regstore.c` | 30,604 B | 10-09 16:51:03 | 4 条写路径 fail-closed 守卫 + `ws_rstore_tomb_add` |
| **未改** `ws_hook.c` / `ws_file.c` / `winstage_internal.h` | —— | —— | 交给 env-harness 的那半 |

### 7.2 候选 DLL（**不在 `shim/out`**）

| 产物 | 路径 | 大小 | sha256 |
|---|---|---|---|
| **候选 DLL（最终）** | `.t/round10/registry/out-r2/winstage-shim.dll` | 252,928 B | `C642B6AF546B66E9441F9C51E31FB5A9977299D2B6CA320575E6A224008FF684` |
| 候选 injector | `.t/round10/registry/out-r2/winstage-inject.exe` | 159,232 B | `855952762A33FC8E1FA24B36ABE253742477DFDE88B355F5D18B9BEAB4717633` |
| 候选 probe | `.t/round10/registry/out-r2/winstage-probe.exe` | 174,592 B | `AE01DFCFB4A7E8389C76ECF846119F1DDA9B3C8D8D7F75B42628E97DE52E7F97` |
| 中间产物（**作废**） | `out-r2` 的上一版构建 | 252,928 B | ~~`C459EAF6D451EF7B660D7DE112A11ADA1755E5E6281DED069301DEDD803DC933`~~（`exe` 曾测此件；之后我又加了 `DshRegStageDetach` 的同类 NULL 调用加固，已覆盖） |
| 修复前候选（**作废**） | `.t/round10/registry/out-r1/winstage-shim.dll` | 250,880 B | `4066041EAF86032EFDB592151578E0423CB47E1E39C21DC086878F30C6B7856E` |
| 对照基线（"R 边界正解"） | `shim/out/winstage-shim.dll` @ Lead 通知时 | 246,784 B | `02C7418FF0F11AFD45FEEA601733E848ECB697FD393915565420F7A41248B76F` |
| **集成前必须先回滚掉的** | `shim/out/winstage-shim.dll` 曾为 13b | 251,392 B | `21FDB793E6409BED81EE2E4AE6E4517E381BF1D7F19652094661E0E04548BC4B`（**已由 `exe` 回滚**，现值 `02C7418F…`） |

> 构建命令（只写 scratch）：`node tools\build-shim.mjs --out-dir .t/round10/registry/out-r1` ⇒ exit 0 / 0 warnings。

### 7.3 集成后必须跑的门禁（每项都要记录当次 DLL 哈希）

1. `node tests\registry-guard.mjs` —— **不得回归**（基线 **378 ok / 0 bad / 1 SKIP**）
2. `node tests\registry-unstaged-wow64.mjs` —— 不得回归
3. `node tests\registry-conformance.mjs` —— 不得回归
4. **我的确定性复现**：`sbx-thread.cmd … r1-repro.txt` ⇒ 期望 **12/12 读成功**（从 12/12 失败翻转）
5. **必查**：`shim.log` 里出现 `replayedBytes>0` 的 attach 行（闭合 §5.2 的未决问题）

**当前集成通道（Lead 17:3x 安排）**：env-harness 的 `out-13c` 候选（17:33 构建）**已含**本任务
的两处改动（已逐串核对，见 §5.2）。但 §5.2 的实测表明：
**`WINSTAGE_SHIM_DLL`/`WINSTAGE_SHIM_DIR` 指路只能让宿主加载候选，指不到被注入的子进程**
⇒ 决定性验证必须在候选**真的位于 `shim/out`** 时做（`out-14` 正式采纳，或 env-harness 临时替换）。
届时我会用**自己的探针与判据**独立复跑确定性复现 + 三个注册表套件，给出
「从必失变确定性通过 / 仍失 / 无法判定」三选一，并附当次 DLL 哈希与 `shim.log` 关键行。

`r1-repro` 的使用说明已发给 env-harness（含"看每个 `repro-t*.txt` 的退出码，不要只看 agent 自述"
与"`staged\` 是暂存面，run 后要立刻把 `repro-t*.txt`/`shim.log` 拷出真盘再清理"这两条踩坑记录）。

### 7.4 跑注入态测试时的环境纪律

`set "DSH_SESSION_ID="` + 钉 `WINSTAGE_STAGE_ROOT=<scratch>`；指向候选 DLL 用
`WINSTAGE_SHIM_DIR=.t/round10/registry/out-r1`（**不替换 `shim/out`**）；
每次运行把 `WINSTAGE_SHIM_DIR` 下 DLL 的 sha256 记进证据。

---

## 8. 证据索引

| 路径 | 内容 |
|---|---|
| `evidence/fix-r1/arm-baseline/` | **定案臂（修复前）**：`DLL-PROVENANCE.txt`（DLL=`02C7418E…`）、`transcripts/repro-t{1..4}.txt`、`logs/shim.log`、`wal/` |
| `evidence/fix-r1/arm-fixed/` | **候选臂（我的 out-r1，`4066041E…`）**：`DLL-PROVENANCE.txt`、`transcripts/`、`logs/shim.log`（含 13 条 attach 的 `tier=`/`replayedBytes=`）、`wal/` |
| `evidence/fix-r1/repro-baseline{,2}/` | 早期复现（哈希未记录，作旁证） |
| `evidence/fix-r1/r1-verify.txt` | AFTER + C1 + C2 三例逐条原始输出 |
| `evidence/fix-r1/C3-write-after-corrupt.txt` | fail-closed 拒绝原文（`replay status=13`、`materialize/value_set status=13`） |
| `evidence/fix-r1/C3-harddeny.txt` | 追加的 2 条 `HARD_DENY status=13` 逐字段 |
| `evidence/fix-r1/dllprobe-*.txt` | 直接 `LoadLibrary` 真实 DLL 的 ABI 探测（含崩溃码，用于 §5 分析） |
| `evidence/fix-r1/repro-fixed{,2}/` | 早期候选臂（注入失败，作废） |
| `evidence/fix-r1/harness/` | `harness.c`、`dllprobe.c`、`loadtest.c`、`r1-verify.cmd`、`r1-repro.cmd`、`dll-load-differential.cmd`、`build-variant.mjs`、`run-in-window.ps1`（全部可复跑） |
| `evidence/fix-r1/offline/dll-load-differential.txt` | **离线两态矩阵**（stock / BEFORE ×3 / AFTER）—— 本次自查的关键证据 |
| `evidence/fix-r1/offline/build-reproducibility.txt` | D-R9：同源连续两次构建三产物哈希全不同 |
| `evidence/fix-r1/offline/{r1-verify.txt,C3-failclosed.txt,out-r2-*.txt}` | harness AFTER/C1/C2、fail-closed、`out-r2` 两态原始输出 |
| `evidence/fix-r1/candidate/out-r2-artifacts.txt` | `out-r2` 三产物在盘哈希（权威读数） |
| `evidence/fix-r1/candidate/source/` | 交付源码快照（与 `shim/src` 逐字节一致） |
| `evidence/fix-r1/MANIFEST.sha256.txt` | 本目录 398 个文件的 sha256（7.4 MB） |
| `.t/round10/registry/probe/r1-repro.cmd` | 确定性最小复现脚本（两臂同用） |
| `.t/round10/registry/prompts/r1-repro.txt` | 复现用嵌套 prompt（跑 t1..t4 + 打印完整 transcript） |
| `.t/round10/registry/out-r1/` | 候选构建产物（DLL/injector/probe + build 报告） |
