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

---

# ★ 8. 更正（线程 #9 实测，2026-10-10）—— 以下三条**取代**前文对应文字

> 本规格在实施中被实测推翻三处。**前文 §3 骨架、§6、§7 的对应文字均已被本节取代**；完整更正汇总见 `docs/round10/fileio/13d/更正-汇总-线程9.md`。

## 8.1 §3 骨架 `un.Buffer = mapped;` **是缺陷**（导致 v1"脆性绿"）
`ws_stat_resolve` 返回的 `mapped` 是 **Win32 形态**（`C:\…`，因为 `ws_GetFileAttributesW` 用它调 Win32 API），而 `NtQueryInformationByName` 的 `ObjectName` 必须是 **NT 对象路径**；`RootDirectory=NULL` 时裸 `C:\…` 被对象管理器当作根下的 `\C:\…`。

- **无车道、无 shim 的直接实验**（`docs/round10/verify/evidence/t5/T5-4-rootcause-nt-form-proof.txt`）：
  `\??\C:\Windows\System32\kernel32.dll` → **`0x0`**；`C:\Windows\System32\kernel32.dll` → **`0xC000003B`**（`STATUS_OBJECT_PATH_SYNTAX_BAD`）。
- 后果：按 §3 骨架实现的 v1（`D96`）**覆盖层映射调用 67/67（T5 轮 87/87）全为 `0xC000003B`、成功 0 条**；端到端 `statSync` 变绿只是因为 **libuv 在 `STATUS_OBJECT_PATH_SYNTAX_BAD` 上回退 `CreateFileW`** ⇒ 记 **fragile-green（脆性绿）**，**不满足 §4 ③**。
- **正确写法**（`D98`）：换名前构造 **NT 形态** —— 盘符绝对 ⇒ `\??\` + mapped；真 UNC `\\server\share\…` ⇒ `\??\UNC\server\share\…`；已是 `\??\` 不重复加；**其它一切形态（`\\?\…`、`\\.\…`、`\Device\…`、卷 GUID、相对名）⇒ 不换名、原样透传**（绝不猜）。`Length`/`MaximumLength` 按 **NT 串**重算。同文件先例：`ws_NtOpenFile`（`ws_file.c:1173`）—— `\??\` 只用于自己的判断，交回真实 API 时保持 NT 原名。

## 8.2 §6 的顺序不完整：必须**先剥 NT 前缀、再绝对化**
`GetFullPathNameW("\??\C:\x")` 实测 = **`C:\??\C:\x`**（它**不剥** `\??\`）⇒ 只照 §6"用 CWD 拼成绝对路径"对合法 NT 形态**仍是 no-op**。正确次序：**先**把 `\??\C:\…` / `\??\UNC\…` 剥成 Win32 形态，**再**用 CWD 绝对化，**再**交 `ws_stat_resolve`。

## 8.3 §7 的归因是**误归因**：`class=4` 探针无区分力
§7 把 `0xC000000D` 归因于"以**裸路径串**（`class=4`）调用"。**实测更正**：该探针的 `OBJECT_ATTRIBUTES` **是合法的**（`InitializeObjectAttributes` + `\??\` 绝对名 + 正确 `Length`）；`STATUS_INVALID_PARAMETER` 来自 **`FileInformationClass=4` 被该 API 拒绝**（无 shim 直调 `kernel32.dll` 同样 `0xC000000D`）。
⇒ **该探针无区分力**（v1/v2/修前均同码）；**验收判据只能用 `class=77` 的真实调用行**。§7"必须用合法 `OBJECT_ATTRIBUTES`"这一**要求本身仍然正确**，被更正的只是**归因**。

## 8.4 §4 ③ 的判据签名（实施后补全，供后轮复用）
除"`statSync`/`lstatSync` 转成功"外，**必须**同时满足可机检的调用级门禁：
- `ATTRDBG-NQIFBN … staged=1 status=0x0` **≥1 条**，且 `… staged=1 status=0x3b` **= 0 条**；
- 成功行要与 `statSync`/`lstatSync` **同 pid 序列**对齐，且其后**无**该夹具的 `CreateFileW` 回退；
- 日志需含 `nt=`（实际交给真实 API 的串）、`mapped=`、`staged=`（`-1` = 没走到解析链）；
- `existsSync` 判据已改判为**必须为 `true`（正确值）**（详见 `更正-汇总-线程9.md` §1.5）。
