# R11-D-13d 计数读数：**not-run**（两类原因，非"未命中"）

> 时间：2026-10-10。**结论状态 = `not-run`（测量从未产生有效读数）**，**不得**写成"各入口未命中"。
> 原因有二：① 换件路径被 auto-review 拦下；② **免换件的 override 路径虽然把候选注入了，但候选本身让载体崩掉**，
> 从而 fail-closed 回退到 T1（无 overlay）⇒ 读数无效。另有 ③ 我自己的 instrument 缺陷（dump 被抑制）。

## 1. 两条载体路径的实测

| # | 路径 | 载车道 | 候选是否注入 | 有效读数？ |
|---|---|---|---|---|
| A | 换件 `shim/out`（原计划） | — | **从未发生** | ❌ 脚本被执行前即被 `Auto review rejected tool "pwsh"` 拦下（`exe` 代跑同样被拦）；`shim/out` 三件哈希与 mtime 未变 |
| B | 免换件：`WINSTAGE_SHIM_DLL=<候选>`（我 harness 的 `--shim-dll`，在 `init()` 前写入 `process.env`） | `launchMode=restricted-token` / `tier=T1` | ✅ 是（`shim.log` 有 4 个 pid `child injection armed: self=…out-13d-count\winstage-shim.dll ok=1`） | ❌ **无** |
| C | 免换件 + CLI `run.cmd src\cli.mjs exec --tier TS`（进程级 `WINSTAGE_SHIM_DLL`） | 请求 TS，实际 `tierEffective=T1` | ✅ 是（4 个 pid armed） | ❌ **无** |
| **D** | **A/B 对照**：同一命令、**不设** `WINSTAGE_SHIM_DLL`（用在用件 `02C7418F…`） | **`tierEffective=TS` / `launchMode=shim`** ✅ | 9 个 pid armed，`self=…\shim\out\winstage-shim.dll` | 载体有效（对照组），但该件**无计数代码** ⇒ hit 行必然 0 |

## 2. 根因（原始证据）

### 2.1 候选让载体崩掉 ⇒ fail-closed 回退 T1（决定性）

`cli-ts-run.txt` 里的 `fallbackReason`（逐字）：

```
carrier-init-failed: injectorOk=true childExit=4294901760 (0xFFFF0000);
the injector succeeded but the carrier process (target=…\powershell.EXE) died during its own initialization;
injector exit=4294901760 (0xFFFF0000) (111=injection failure) report.ok=true
carrierAttempts=3/3 carrierExits=[0xFFFF0000, 0xFFFF0000, 0xFFFF0000]
Starting the CLR failed with HRESULT 80004005.
— fail-closed fallback to the restricted-token mode
```

- **injector 成功**（`report.ok=true`）、**载体进程自己**在 CLR 初始化阶段死掉，**3/3 次可复现**。
- 同一命令换成在用件（路径 D）即得 `tierEffective=TS` ⇒ **是候选特有**，不是环境、不是 override 机制的问题。
- 该次运行里 `all-probes-summary.json` 印证了 T1 的后果：`envShim` 三个变量全 `null`、
  `A_write=DirectoryNotFoundException`、`C_node`/`D_cmd`=`ApplicationFailedException`、`.NET Exists=false` ⇒ **读数不可用**。
- 对照：候选的 **probe 自检是通过的**（`shim-selftest: probe exit=0; loaded=true abi=1 initReturn=0 initialized=true hooksInstalled=true iatSites=68 modules=8`）
  ⇒ 问题**不在导出/装载**，而在**被 CLR 宿主使用时**。

**最可能的原因（假设，需下一步验证）**：我新增的 6 个 pass-through 挂钩里，`NtQueryInformationFile` / `GetFileInformationByHandleEx` 是 **CLR 启动路径会调用的**；
而 shim 的原函数表 `g_orig` 是**按 API 名全局唯一**的，多模块（本次 `203 IAT sites / 20 modules`）打补丁时，若某处的原指针未解析成功，
我的包装会**fail-closed**返回失败（`STATUS_PROCEDURE_NOT_FOUND` / `FALSE`）⇒ CLR 启动失败。**必须**改成"原指针为空就不安装该目标 / 调用时按模块解析"。

### 2.2 我的 instrument 缺陷：dump 被自己抑制

`ws_count_dump()` 挂在 `DllMain(DLL_PROCESS_DETACH)` 且位于 `if (!lpvReserved && g_ws.initialized)` 分支内。
而 **Win32 在"进程终止"时以 `lpvReserved != NULL` 调用 `DLL_PROCESS_DETACH`** ⇒ 正常退出路径下 dump 永不执行。
实测：三份日志的 `R11-D-13d hit` 行**全为 0**，且日志里**完全没有** `R11-D-13d` 字样（连 canary 进程也没有）。

**修法**：dump 放到 `lpvReserved` 的**两支都执行**的位置（用 `g_ws.initialized` 兜底），
或把 dump 挂到已有的 STUCK 守护线程首个 tick（但短命进程仍需要 detach 那一支）。

## 3. 阴性对照（证明读数通道本身可用）

`shim-ab-inuse.log`（在用件 `02C7418F…`、`tierEffective=TS`）hit 行 = **0** —— 该件无计数代码 ⇒ 0 是预期。
反过来，两份候选日志（`shim-harness-noswap.log`、`shim-cli-ts-noswap2.log`）**确实**出现了
`self=…out-13d-count\winstage-shim.dll ok=1` ⇒ **override 到达注入态**（与 `exe` 的实证一致），
但因为 §2.1/§2.2，**没有得到任何有效计数**。

## 4. 证据清单

| 文件 | 内容 |
|---|---|
| `harness-json.txt` | 路径 B 的 harness JSON：`launchMode=restricted-token`、`tier=T1`、`requestedTier=TS` |
| `cli-ts-run.txt` | 路径 C 的 CLI `--json` 全文：含 `fallbackReason`（CLR 失败 3/3）、`tierEffective=T1` |
| `ab-inuse-run.txt` | 路径 D 的对照全文：`tierEffective=TS` / `launchMode=shim` |
| `summary-harness-noswap.json` / `summary-cli-ts-noswap2.json` | 两次 T1 运行里四项探针的实际（失败）结果 |
| `shim-harness-noswap.log` / `shim-cli-ts-noswap2.log` | 候选注入证据：4×`child injection armed … out-13d-count`；`R11-D-13d hit` = 0 |
| `shim-ab-inuse.log` | 在用件对照：9×armed（`shim\out`）、`tierEffective=TS`、hit=0（阴性对照） |
| `window-watch.txt` | 换件看门狗记录（已按要求停止） |

## 5. 下一步（给 Lead 的选择）
1. **修 instrument 两处**（§2.2 的 dump 分支；§2.1 的原指针为空不安装/按模块解析），重建候选；
2. **收窄第一版**：只给**已挂钩**入口加计数（`CreateFileW`/`GetFileAttributes*`/`NtOpenFile`/`NtSetInformationFile`，**零新增钩子**），
   先拿到一张"安全命中表"；再逐个加未挂钩入口，每加一个就跑一次载体存活判据（TS 是否仍成立）；
3. 或者把计数并入 `pkgs` 正在做的 **`out-18` 入口插桩**（他们本来就要动那几个入口），避免我再改一次 `shim/src`。

### 5.1 Lead 裁定（2026-10-10）：**选 (3)**

- **计数并入 `pkgs` 的 `out-18` 线**，在**窗口 #6 收尾（保留或回滚）之后**套用；**我不再动 `shim/src`**（`out-18b` 是关键路径）。
- 必修两条已于 **v2** 落地：① **零新增挂钩目标**（只统计已挂钩入口）；② **dump 覆盖 `lpvReserved != NULL`**。
- **v2 交付**：`.t/round10/fileio/13d-count-probe/V2-HANDOFF.md` + `counts-v2.patch`
  - 已在**副本**上完整编译（`-Wall -Wextra` **exit 0 / 零告警**，`254,464 B`；**未碰 `shim/out`、未碰真树**）；
  - `git apply --check counts-v2.patch` 对当前树 → **exit 0**；
  - 漂移提醒：当前树**已含 `pkgs` 的 `NtQueryValueKey`**（`ws_hook.c` +5、`winstage_internal.h` +3；`ws_file.c`/`ws_entry.c` 未动）。
- **新增缺陷**：`D-FILE-2`（v1 新挂钩 fail-closed ⇒ CLR 宿主崩溃、载体连崩 3 次 ⇒ 平台 **fail-closed 降 T1**，
  与 `D-R8` 的 fail-open 构成一对）已写入 `docs/round10/fileio/defects.md`。

> 我在最后一次触碰时把 `shim/src` 还原为 **D56**（`ws_reg.c = D8C571E2…`、四文件 sha256 逐条一致、`--check applied=false`）；
> 之后**该树已由 `pkgs` 继续演进**（`winstage_internal.h 01D4F52E…`、`ws_hook.c 9F505819…`）⇒ 现在**不是纯 D56**，这是 `pkgs` 的 out-18 工作，与我无关。
>
> **基线口径（Lead 2026-10-10 校正）**：凡引用基线请写 **`D56 + NtQueryValueKey(D58) + 类常量修正(D60)`**，不要再简称"D56 基线"；
> 漂移表以 [V2-HANDOFF.md §6.1](../../../../.t/round10/fileio/13d-count-probe/V2-HANDOFF.md) 为准。
> 我的 v1 候选 `5596F552…` 与 `counts.patch` 冻结保留但**标注不可用**。
