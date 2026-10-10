# 修复规格：`NtQueryInformationByName` **overlay 感知**（`D-FILE-6`，高）

> 供实现者直接开工。**本规格不含代码补丁**；实现者按既有五件套出件。
> 目标：让沙箱内**已暂存文件**经 `NtQueryInformationByName` 查询时**不再报"不存在"**，且**不改动**其它语义。

## 1. 必须复用的解析语义（**不要自创**）

现成读路径的解析链（与 `ws_GetFileAttributesW`/`ExW` 的 overlay 感知同源），实现者应在**同一文件**里复用：

| 环节 | 位置（供定位，实现时请以当时源码为准） | 作用 |
|---|---|---|
| 是否接管 | `shim/src/ws_file.c` 的 `ws_should_intercept(path, norm, cch)` | 规范化 + 排除 `stageRoot`/`passthrough`/设备名 ⇒ 回答"要不要走覆盖层" |
| 路径规范化 | `shim/src/ws_util.c` 的 `ws_normalize_path()`（对 `\\?\`/`\\?\UNC\`/`\\?\GLOBALROOT` 有剥离分支） | 得到 norm |
| **覆盖层解析** | `shim/src/ws_file.c` 的 `ws_stat_resolve(lpFileName, mapped, WS_PATH_MAX, &isStaged)`（`ws_GetFileAttributesW` 内即调用它） | 把逻辑名解析为**覆盖层映射路径**并给出 `isStaged` |
| 语义意图解析（可选更底层） | `ws_resolve_file(norm, intent, out, flags)` → `g_wsStage.file_resolve` | 带 intent/flags 的 provider 级解析（读分支 `flags & WINSTAGE_RES_STAGED` 即"命中覆盖层"） |
| 真实 API 直调 | `ws_real_attrs_w()` / `g_orig.*`（**不得**走本模块自身 IAT 之外的钩子路径，避免自递归） | 回落时调用真实实现 |

**三条行为契约（Lead 裁定）**：
1. **命中覆盖层** ⇒ **按覆盖层回答**（存在/属性以覆盖层映射路径为准）；
2. **未命中** ⇒ **回落真实 API**（在原逻辑名上调用，保持真实盘语义）；
3. **异常/无法解析**（`ws_should_intercept` 失败、`ws_stat_resolve` 失败、`ObjectName` 为空等）⇒ **安全降级**：仍调用真实 API 或返回可区分的真 status；**绝不 fail-closed**、**绝不伪造成功**。

## 2. 包装位置与改动面

- **位置**：`shim/src/ws_file.c` **文件末尾**的包装 `ws_NtQueryInformationByName`（即 `nqifbn-probe.patch` 的落点），在其内部**解析后**把传入的 `ObjectAttributes->ObjectName` 换成覆盖层映射名再调用原函数。
- **注意**：`ObjectAttributes` 是**调用方结构**，**不得就地改写**；如需换名，**构造一个本地副本**（`OBJECT_ATTRIBUTES` + 本地 `UNICODE_STRING`，缓冲区用**栈上** `wchar_t mapped[]`；注意 `ws_stat_resolve` 的目标缓冲需足够长 `WS_PATH_MAX`）。
- **按名解析需要路径形态**：`ObjectName` 是 `\??\C:\…` 形态 ⇒ 复用规范化剥离后再交给解析链（不要假设 NUL 结尾，按 `Length` 取值）。
- **不新增其它挂钩目标**；**不动 injection/路径逻辑**；**不破坏 `LdrLoadDll` 修复**；包装内**零 path I/O**（不新增读写）；ntdll 族**不包夹 `LastError`**。

## 3. 交付口径（与既有五件套一致）

1. **双前置**：副本 `zig cc -target x86_64-windows-gnu -std=c11 -O2 -Wall -Wextra -Wno-unused-parameter -Wno-unused-function -DUNICODE -D_UNICODE -shared`（DLL）**exit 0/零告警**；`git apply --check` 对**当前树** **exit 0**（冲突则按当时树重生成，不硬套）；
2. **三文件完整 64 位 hex**（apply 前 → 后）：`winstage_internal.h` = `9627EFBAE3DCE981A94A307E92FB219C907E28F785FC584A6B25A9D615DC1005`、`ws_hook.c` = `3E2EBEE63573E9E0886960B6ED1A26EDC8C6A8A0D4E529AFCC76F557309E2224`、`ws_file.c` = `60ACEC390146DDA60970D1D28D576CF3C6EF14833C81943BD6883353FCBF8D39`（**以当时树为准**）；`ws_reg.c` = `F5695A951EA08534B495C520C48EE2C7A199060E88E05C2E91848221F9D23223` **须不变**；
3. **唯一锚点**：`ws_NtQueryInformationByName` 包装体内（`nqifbn-probe.patch` 的落点）；若需辅助函数，插在包装**之前**并保证**唯一命中**；
4. **`git apply -R` 可回滚**；
5. 交唯一构建者 `pkgs`（**不得**自行替换 `shim/out`）。

## 4. 验收三层（**缺一不算完成**）

| # | 层次 | 判据 |
|---|---|---|
| ① | 离线 | `dshregprobe2 read` = **`ALL=True`** |
| ② | **零语义复跑** | `step2a` = `step2b` **逐字节一致**（sha `12AA39D1F31AF899…`）；**D-R1 四条件不回归**；门禁与既有绿项不回归 |
| ③ | **行为验收**（同车道、免换件、先过㈠、`self=…`被注入件断言） | **`statSync`/`lstatSync` 对已暂存文件转为成功**；**`readFileSync` 不变**（仍成功）；**`existsSync` 现状不变**（其异常属**线 B**，不在本候选范围）；附**夹具绑定原始行**（`ATTRDBG-NQIFBN` 的 `status` 应从 `0xC000003A` 转为覆盖层成功，或该调用不再单独决定结果） |

**回归处置**：行为验收出现任何回归（尤其**真实盘语义被改坏**、`dshregprobe2` 非 `ALL=True`、零语义项不过）⇒ **立即回滚该补丁并停下上报 Lead**，不得带疑推进。

## 5. 纪律与红线

- 判据用 **`status`/`rc`/`attrs`/`staged`**，**不得用 `LastError` 残留**（`D88`）；
- 证据/输出路径**纯 ASCII**；证据写 **stage 的 passthrough 区**；载体级 `shim.log` 入 `docs/…/evidence/` 并给 **sha256/大小/行数**；**按 pid 过滤**；
- **红线**：`shim/out`（`63808F51…`，已采纳件）、`inject`/`probe` 原件、冻结 `count2`–`count13` 与 `out-16`–`out-22`、`ws_regstore.c`、`injection`/路径逻辑 —— **一律不得碰**。

---

## 6. ★ 必须先把名规范化成**绝对**（第 0 步实测，`pkgs`；证据 `docs/round10/shim/evidence/D95-step0-isStaged-rawlines.txt` = `B914F0E30F718BD240AE98538A2358D58788012BD5FE432078F6F250A62C0627`，2,433 B / 21 行）

`ws_stat_resolve` **只覆盖"绝对路径 + 被重定向"形态，不覆盖相对名**：

| 入参形态 | 实测结果 |
|---|---|
| **相对逻辑名** `in=stage0-target.txt` | **`isStaged=0` 且 `mapped == in`**（即 **no-op**，原样返回） |
| **绝对且被重定向** `in=C:\Users\…\PowerShell` | `mapped=<stage>\staged\fs\C\Users\…`、**`staged=1`** |
| （字段活性对照） | 同 run `staged=1` = **93** 次 / `staged=0` = **7,140** 次 ⇒ **`isStaged` 是活字段，不是死字段** |

⇒ **修复必须先做规范化**：用**进程 CWD** 把 `OBJECT_ATTRIBUTES.ObjectName` 拼成**绝对路径**（并沿用既有 `ws_normalize_path()` 的 `\\?\`/`\\?\UNC\` 剥离语义），**再**调用 `ws_stat_resolve`；
否则对本探针使用的**相对形态**，解析链**从未生效**（看起来"没坏"只是因为没走到）。

> **另一处必须澄清的假象**：**相对名当前"看起来成功"（`attrs=0x20`）并非 overlay 映射**，而是**沙箱内进程 CWD 已位于 `<stage>\staged`**（因此真实 API 在 CWD 下直接命中暂存树）。
> ⇒ 修复判据**必须基于绝对 / 被重定向形态**，**不得**把"CWD 命中"当作 overlay 生效的证据。

## 7. ★ 行为/活性探针必须使用**合法调用形态**

`pkgs` 实测：`NtQueryInformationByName` 以**裸路径串**（`class=4`）调用时返回 **`0xC000000D`（`STATUS_INVALID_PARAMETER`）** —— **连 `kernel32.dll` 作为目标时亦同** ⇒ **该 API 要求 `OBJECT_ATTRIBUTES`**（不是裸路径）。

⇒ **§4 的 ③ 行为验收与 `D-FILE-4` 要求的活性正对照，都必须用合法的 `OBJECT_ATTRIBUTES`**（含**绝对** `ObjectName`、`OBJ_CASE_INSENSITIVE`、正确的 `Length`），
否则**无法区分"修好了"与"根本没走到"**（后者会被误读成"0 行/失败"）。
活性探针若沿用 `nqifbn-probe.c`，请把 `ObjectName` 设为**绝对 NT 路径**（`\??\C:\…`）并且**不要**传相对名。
