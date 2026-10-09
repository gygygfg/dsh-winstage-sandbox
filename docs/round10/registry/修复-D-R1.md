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

#### 5.2.3 结论（三选一）

- 对 **BEFORE 候选（`out-r1`/`out-cur`/`out-13c`）**：**仍失**，且已定因为**候选自身缺陷**（非"方向错"）。
- 对 **AFTER 候选（`out-r2`）**：离线三态对照已证明缺陷消失；**但注入态端到端尚未取得读数**
  ⇒ 仍记 **无法判定**，等下一次受控窗口（届时必须查 `replayedBytes>0` 且读 `exit=0`）。
**指不到子进程**。所以"用候选指路即可拿到注入态端到端"这条路径**不成立**——
决定性验证必须在候选**真的位于 `shim/out`** 时做（即 `out-14` 走正式采纳、或 env-harness
临时换上），而 `shim/out/**` 在我本任务的写范围之外。

**顺带排除的两件事（有价值）**：
1. **不是我的 `out-r1` 构建坏了** —— env-harness 的 13c 表现**逐字相同**（宿主 ok=1 / 子进程 15 次失败），
   且 13c 里确实含我的改动（ASCII 串 `tier=%d hive=%ls`/`JOURNAL REPLAY FAILED`/`SESSION hive=%ls`/
   `viewIncomplete=%d` 命中；宽串 `overlay.local.hive` 以 UTF-16LE 命中）。
2. **我的写路径在候选里是通的** —— `arm-13c` 那次唯一被注入的 `reg add` 成功写进了 journal
   （`rec1 CREATE_KEY` + `rec2 SET_VALUE`，170 B，`problems=0`），只是随后的读进程都没被注入。

**仍未闭合的唯一断言**：`replayedBytes>0` 的 attach 行。等候选真的进 `shim/out` 后再取。

### 5.3 环境事件（影响取证，不影响源码）

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
