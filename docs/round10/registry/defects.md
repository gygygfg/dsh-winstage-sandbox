# R10-REG 缺陷清单（域四：注册表修改与隔离）

> 基线契约：`docs/T3-注册表暂存设计.md`（v1.4）· 实现：`src/registry-stage.mjs` / `src/registry-guard.mjs` / `src/registry-bindings.mjs` / `shim/src/ws_t3reg.c`
> 实测环境：**正常态** `launchMode=shim` / `tierEffective=TS` / `degraded=false`
> （`run-burst2`、`run-isoA3`、`run-isoB3` 三份 `sandbox-lane.json` 一致；`stderr.txt` 均为 0 字节）
> 每条附**原始证据路径**；未跑过的一律标 `not-run`。
>
> **D-R8 是独立于 D-R1 的高危面**（"载体跑了但钩子没装上"），见文末；
> D-R1 的实现缺陷（回放在 `g_orig` 未就绪时调用它）已在 `修复-D-R1.md` §5.4 记录并修复。

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

> **状态更新（2026-10-09）**：根因不变；**修复已实现**（journal 回放 + 会话级 fallback hive），
> 且修复过程中发现并修掉了**我自己实现的一个缺陷**（回放在 `g_orig` 就绪前调用它 ⇒ DllMain 抛错）——
> 详见 [`修复-D-R1.md`](./修复-D-R1.md) §2 / §5.4。修复前的原始 42%/79% 与 12/12 读数保持原样。

**判定**：**根因未修复（源码自认为"契约等价"，`shim/src/ws_t3reg.c:232`）；修复补丁已交付待集成**

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
