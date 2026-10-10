# R11-D-13d 计数探针补丁交付（可逆 · 只计数）

> **基线口径（Lead 2026-10-10 校正）**：本文档里的 "D56" 指 **2026-10-10 我实施 v1 时的树状态**
> （`ws_hook.c B64D6425…`、`winstage_internal.h 6E900A72…`、`ws_file.c F5376BB1…`、`ws_entry.c 13BB930B…`、`ws_reg.c D8C571E2…`）。
> **当前树已演进为 `D56 + NtQueryValueKey(D58) + 类常量修正(D60)`**（`ws_hook.c 9F505819…`、`winstage_internal.h 01D4F52E…`），
> 因此**凡涉及"当前树"的判断一律以 [V2-HANDOFF.md §6.1](../../../../.t/round10/fileio/13d-count-probe/V2-HANDOFF.md) 的漂移表为准**。v1 候选 `5596F552…` 已判**不可用**。
> 目的：用**数据**定名"node 的 `exists/stat` 与 `cmd if exist` 到底调了哪个入口"。
> 施加时间：2026-10-10（窗口 #5 冻结期内；源码层改动不碰 `shim/out`，`exe` 用的是已冻结的 `out-16` 产物）。

## 1. 保护条件合规（Lead 四条）

| 条件 | 状态 | 证据 |
|---|---|---|
| ① 绝不动 `out-16` / `shim/out` | ✅ | 构建输出到 `.t/round10/shim/out-13d-count`；`shim/out` 三件哈希**未变**：dll `02C7418F…B76F`、inject `07FE55DD…518F`、probe `8CF81F4F…69E5`；`out-16` 未被读改（`17825DF4…` 仅作对照） |
| ② 可逆（独立补丁 + 前后哈希 + "移除即恢复 D56"） | ✅ | [`counts.patch`](../../../../.t/round10/fileio/13d-count-probe/counts.patch)（244 行 / 4 文件）；`git apply -R --check counts.patch` → **exit 0**（就地反向可应用）；等价命令 `node apply-count-probe.mjs --repo . --restore`（从 `baseline/` 复制回）；§2 有逐文件前后 sha256 |
| ③ 不动 `ws_reg.c` 的修复/插桩 | ✅ | `ws_reg.c` = `D8C571E2C63745EF022EBB1C572A752279CDBFB9FB06D7A0C99343CE436463DB`（= D56 值，**逐字节未变**）；补丁只涉及 `winstage_internal.h`/`ws_hook.c`/`ws_file.c`/`ws_entry.c` |
| ④ 注入态读数走受控替换窗口 | ⏳ | 候选已建好，**未做任何注入态读数**；等 Lead 安排窗口（窗口 #5 现开，我一律停跑） |

## 2. 改动内容（只计数，不改语义）

| 文件 | 改动前 sha256 | 改动后 sha256 |
|---|---|---|
| `shim/src/winstage_internal.h` | `6E900A72EC8EA7350F59C491ED665E749E1259316B55BF38CCA906098E72A709` | `4BD4B2F0EEED8B2B3B366B016958412363797C7DBFFF94125D6EDBCBC031A87E` |
| `shim/src/ws_hook.c` | `B64D642559FCC6CC396CA97F453923D14BB8E0F3C21C7E3879C7973A8E2F82B3` | `05EA04083C460E61696CAF5F96B55F5975AB14D76A1D31EDB4B3B300B4D6C684` |
| `shim/src/ws_file.c` | `F5376BB1F690D5ADF72F9D75D515BDDC9F649D0C586E9B7295F91B8C069B757F` | `AA0BCCB61385626B06BBECACBA9A4A3B512AA3DD7499DC3187788F1091209116` |
| `shim/src/ws_entry.c` | `13BB930B9DFBCBA73FCF97208C8FBBBEC10EDB14B2F3EEE5047509FDA68DA551` | `7300537FF46BC7F123E4FFC6D928D481B58B3FE432AF164C0ED816BF2361311D` |
| 其余 8 个 `shim/src/*`（含 `ws_reg.c`） | — | **未变**（`--check` 前后哈希逐条相同） |

具体：

1. **`winstage_internal.h`**
   - `WsOriginals` 增 6 个 **pass-through 原函数指针**（`GetFileInformationByHandleEx`、`NtQueryInformationFile`、`NtQueryInformationByName`、`SearchPathW`、`PathFileExistsW`、`PathFileExistsA`）；
   - 声明 `ws_callhit_named()` / `ws_count_dump()` 与 6 个包装函数原型。
2. **`ws_hook.c`**
   - `g_targets[]` 增 6 个 `WS_TARGET(...)`；`g_targetNames[]` 同步增 6 个名字（保持**索引对齐**）；
   - 新增 `g_callHits[128]` + `ws_callhit_named()`（按名字线性查表 → `InterlockedIncrement`，**无 I/O** ⇒ 不重入）
     与 `ws_count_dump()`（进程卸载时把非零计数写成 `R11-D-13d hit <name> n=<count>`，带 `g_countDumping` 重入旗标）。
3. **`ws_file.c`**
   - 在 **7 个既有包装函数体首行**加 `ws_callhit_named("<name>")`（`CreateFileW`、`GetFileAttributesW/A`、`GetFileAttributesExW/ExA`、`NtOpenFile`、`NtSetInformationFile`）——逐处已核对落在正确函数体内；
   - 文件末尾追加 **6 个纯计数 pass-through 包装**：计数后原样调用 `g_orig.*`；原指针为 NULL 时 fail-closed 返回
     （`FALSE`+`ERROR_PROC_NOT_FOUND` / `STATUS_PROCEDURE_NOT_FOUND` / `0`），不崩溃、不伪造成功。
4. **`ws_entry.c`**
   - `DLL_PROCESS_DETACH` 分支里 `ws_hook_remove()` **之后**调用 `ws_count_dump()`（撤钩后写日志 ⇒ 不会重入钩子）。

> **未采纳"改 `WS_STUCK` 宏"的方案**：实测只有 `CreateFileW` 一个目标走 `WS_STUCK`，改宏覆盖不全且影响面更大；改为 7 处显式插入，影响面最小、可读性最好。

## 3. 候选构建（隔离目录，绝不发布）

```
node tools\build-shim.mjs --out-dir .t\round10\shim\out-13d-count
→ exit 0 ；dll 253,952 B ；exports 15（契约不变）；warnings 0
```

| 件 | sha256 | 备注 |
|---|---|---|
| `out-13d-count/winstage-shim.dll` | `5596F552C7BFB189C14B9430D8F0F5A9934213CADB6159EA24665FCCF0AE3CD1` | `.text` = `6604F4C88D1B9B05E055F8AC3003023833E5F9BB0757DA5D8896E076C30519B1`（204,288 B） |
| `out-13d-count/winstage-inject.exe` | `D7EC97489A928FCD04D991FF49C842671255EB8CB2B22B301E0C8B90ED44A711` | `.text` = `694ECCC66A36DBE72D57CDDF4A68E4D0FD8E6B9B4E6BB8A09836330EECD92145` |
| 对照 `out-16`（D56，正式修复） | `17825DF4F255B72BFE6091CC4B937E70DC44AE11FEDFEB399C9363EAC0FD76E9` | `.text` = `CD320EBF745E4E2ED606477F42CEF42043E27655696027B6EE7634ACCE7D287C` |

> 构建只调用交错编译器与 PE 解析（`build-shim.mjs` 的 `spawnSync` 仅两处，均为工具链/PE 读取），**不运行注入器** ⇒ 不是 WinStage 运行。

## 4. 下一步（等窗口）

注入态读数**必须**在被注入的子进程里加载本候选，而 `WINSTAGE_SHIM_DLL` 只影响宿主 ⇒ 需要 Lead 安排的**受控替换窗口**。窗口内要跑的读数（脚本已就绪）：

```
# node 侧：exists/stat/read/readdir + env
node .t\round10\fileio\13d-count-probe\env-override-harness.mjs --stage-root <stage> --ws <ws> -- node query-probe.mjs <staged> ...
# cmd 侧：if exist / dir / type
... -- cmd /c cmd-ifexist.cmd <staged>
# 正对照：.NET Exists
... -- powershell -File ps-query.ps1 -Target <staged>
# 读数来源：子进程 shim 实例在 DLL_PROCESS_DETACH 时写进 <stage>\staged\shim.log 的
#           `R11-D-13d hit <name> n=<count>` 行（宿主侧直接读该文件）
```

判读：`GetFileInformationByHandleEx` / `NtQueryInformationFile` / `NtQueryInformationByName` **命中 > 0** ⇒ 定名成功；
`SearchPathW`/`PathFileExistsW/A` 命中 > 0 ⇒ cmd 侧定名成功；**全部 0** ⇒ 转路径规范化/白名单匹配假设（见 `PATCH-SPEC.md` §6.4）。

## 5. 已知限制（如实）

- **性能**：`ws_callhit_named()` 是 59 项线性 `strcmp`，在 `CreateFileW` 等热路径上有少量开销。**仅测量构建**如此；正式修复件不应带它。
- **落盘通道**：计数走 `shim.log`（卸载时一次性 dump），**未**扩展 `WinstageShimStatsJson`。理由：该导出只在**进程内**可调用，而被注入的 node/cmd 无法从外部调用它；日志是两进程共享的唯一通道。
- **`g_targets` 与 `g_targetNames` 既有不同步**（本次**未**引入）：当前 56 vs 57，**从 index 52 起整体错位一格**，`onlyInNames=["LdrGetProcedureAddress"]`。
  **更正**：`FindFirstFileW` **两张表里都没有**（我早前说"在 `g_targetNames` 里"是**错误归因** —— 那个字符串来自 `ws_file.c:635`/`ws_file.c:1023`/`ws_t3reg.c:362` 对它的**直接调用**）。
  ⇒ **`FindFirstFileW` 今天并未被挂钩**，这与"`SKIP=FindFirstFileW` 不影响 node 的 readdir"一致（且解释更强：没有对象可跳）。详见 **`D-FILE-1`** 与 `D-FILE-1-独立方案.md`。

---

## 6. 运行时验证结果（2026-10-10）：**候选不可用**，13d 计数 = `not-run`

载体验证跑了三条路径（详见 [count-window-evidence/README.md](count-window-evidence/README.md)）：

| 路径 | 结果 |
|---|---|
| 换件 `shim/out`（`exe` 代跑，含我的脚本） | **被 auto-review 拦下，从未执行**；`shim/out` 三件哈希/mtime 未变 |
| 免换件 override（`--shim-dll` / 进程级 `WINSTAGE_SHIM_DLL`） | 候选**确实注入**（`shim.log` 4×`self=…out-13d-count… ok=1`），但 **`tierEffective` 落到 T1** |
| **A/B 对照**：同命令换用在用件 `02C7418F…` | **`tierEffective=TS` / `launchMode=shim`** ✅ |

**根因 1（候选破坏载体）**：`fallbackReason` 逐字为
`carrier-init-failed: … the carrier process (target=…powershell.EXE) died during its own initialization … Starting the CLR failed with HRESULT 80004005 … carrierAttempts=3/3 … fail-closed fallback to the restricted-token mode`
⇒ injector 成功、**载体自身 CLR 初始化崩溃**（3/3 可复现），候选特有（A/B 已证）。probe 自检本身是通过的。
**根因 2（instrument dump 被抑制）**：`ws_count_dump()` 在 `DllMain(DLL_PROCESS_DETACH)` 的 `!lpvReserved` 分支内，而**进程终止时 `lpvReserved != NULL`** ⇒ 正常退出路径永不 dump。三份日志 `R11-D-13d hit` 行全 0，连 `R11-D-13d` 字样都没有。

### 6.1 必须的两处修法（重建候选前）

1. **载体安全**：新增的 pass-through 挂钩**不要 fail-closed** —— 要么在打补丁时**原指针为空就不安装该目标**，
   要么调用时**按模块解析**原函数；并给包装加**重入守卫**。优先怀疑 `NtQueryInformationFile` / `GetFileInformationByHandleEx`
   （CLR 启动路径会调用）。
2. **dump 分支**：在 `lpvReserved` 的**两支都**执行 dump（以 `g_ws.initialized` 兜底），否则短命进程永远拿不到计数。

### 6.2 建议的第一版范围（降低风险）

先只给**已挂钩**入口加计数（`CreateFileW`、`GetFileAttributesW/A`、`GetFileAttributesExW/ExA`、`NtOpenFile`、`NtSetInformationFile`）——
**零新增钩子**，可直接回答"node 的 stat/exists 是否调用任何已挂钩入口"；拿到安全命中表后，
再逐个加入未挂钩入口，**每加一个就跑一次"载体是否仍为 TS"的存活判据**（`tierEffective` 必须为 TS）。

> `shim/src` 在我不再触碰之后**已由 `pkgs` 继续演进**（out-18）：我最后一次实测为
> `winstage_internal.h 01D4F52E…`、`ws_hook.c 9F505819…`（含 `NtQueryValueKey` +5/+3）、`ws_file.c F5376BB1…`、`ws_entry.c 13BB930B…`、`ws_reg.c D8C571E2…`
> —— 即**不再是纯 D56**；我的 v1 候选二进制 `5596F552…` 与 `counts.patch` **冻结保留但已知不可用**，不要进任何窗口。

---

## 7. Lead 裁定（2026-10-10）：v1 废弃、**v2 修正版已备好交 `pkgs`**（选 (b)）

Lead 裁定：**关键路径是 `out-18b` 的窗口 #6，`shim/src` 必须保持干净** ⇒ 不给我开重叠期；
**计数并入 `pkgs` 的 `out-18` 线**，在窗口 #6 收尾后套用（理由与 §6 的两处必修一致）。

**v2 交付（已就绪）**：`.t/round10/fileio/13d-count-probe/V2-HANDOFF.md` + `counts-v2.patch`

| v2 相对 v1 的变化 | 为什么 |
|---|---|
| **零新增挂钩目标**：删掉 6 个 pass-through 包装与 `WsOriginals` 新字段，只给 **7 个已挂钩**入口各加一行计数 | v1 的新挂钩让 CLR 宿主初始化崩溃（`D-FILE-2`） |
| **dump 覆盖 `lpvReserved != NULL`**：detach 改为 `if (g_ws.initialized) { if (!lpvReserved) ws_hook_remove(); ws_count_dump(); g_ws.initialized = 0; }` | v1 的 `!lpvReserved` 条件在"进程终止"路径上永远为假 ⇒ 计数永不落盘 |
| 不新增 `WS_TARGET`、不改 `g_targets`/`g_targetNames` | 避开 `D-FILE-1` 的两表错位风险，也避开与 `pkgs` out-18 新目标（`NtQueryValueKey`）的冲突面 |

**已验证**：
- 在**副本**上完整编译 `-Wall -Wextra` → **exit 0 / 零告警**（10 个源文件、`254,464 B`；**未碰 `shim/out`、未碰真树**）；
- `git apply --check counts-v2.patch` 对**当前树**（已含 `pkgs` 的 `NtQueryValueKey` +5/+3）→ **exit 0**；
- 漂移已量化：套用前若再改 `g_targetNames` 尾部 / 7 个包装体首行 / `DllMain` detach，需按 V2-HANDOFF §3 的锚点折叠。

**v2 的覆盖边界（必须随命中表写明）**：只统计**已挂钩**入口 ⇒ 未挂钩的 11 个入口（`GetFileInformationByHandleEx`、`NtQueryInformationFile`、
`NtQueryInformationByName`、`NtQueryAttributesFile`、`NtQueryFullAttributesFile`、`NtQueryDirectoryFile`、`FindFirstFileW/A`、
`SearchPathW`、`PathFileExistsW/A`）在 v2 下**不会出现在命中表里**，那是"**未挂钩**"、**不是**"未被调用"；
要定名它们，须先证明"加计数后载体仍为 TS"，再**逐个**加入并每次复测（判据见 V2-HANDOFF §5 的四条验收）。
