# D-FILE-4 · O1b（task-16 追加）：`ws_LdrGetProcedureAddress` **名字路径**也改指针同一性

> 作者：`line-d4`｜2026-10-10｜Lead 裁定（机制已被 D101 证明、缺口已被探针演示，条件成熟）
> **patch-only：真树 `shim/src` 全程未写**；`D101b` 与 `D101` **并成同一候选 `count19`**
> 基线（= **D101 apply 后态**）：`.t/round10/shim/d4/D4O1-ws_hook.c` = `9A96354EB844D33C5C1136606D505BC51AACF5E4F7093F9D462063B955DF4EFC` / 43,890 B
> 补丁：`.t/round10/shim/d4/D101b-o1b-ldr-name-identity.patch` = `D936F84D06A5033AA3812C41606FB4BC6FEFE2EF19E98081E00FFB4D0A08E4FF` / 1,399 B / 26 行
> apply 后 `ws_hook.c` = **`0222702B56E75AA3DDE43AA19AB3B9624AF2A62FC200BD5A04DA3FE68EE405B2` / 44,587 B**（blob `5a822fd24702a4062abc023c1f895a8bee7bdce5`）

---

## 0. 结论速览

| # | 项 | 结论 |
|---|---|---|
| 1 | **缺口（兄弟入口上的同名不同址）** | ✅ **已闭合**：外部模块同名导出经 `LdrGetProcedureAddress` 解析：修前/D101-only = 被换成我们的包装（`result=0x20`）；**D101+O1b = 该模块自己的函数**（owner=`d4samename.dll`、`result=0xDEADBEEF`） |
| 2 | **语义与 D101 完全一致** | ✅ 同一个 `ws_name_identity()`（一处实现、一套证据）：命中才换、**未命中保留 `real`**、永不 fail-closed、**无递归**（只用真身 `g_orig.LdrGetProcedureAddress` 已解析出的结果 `*ProcedureAddress`） |
| 3 | **LDR 路径覆盖对照** | ✅ **零丢失**（17 名 × 4 模块逐项）：除 `LdrGetProcedureAddress` 自身由 `nt:R` → `nt:S`（见 §3 覆盖**增益**说明）外，其余**逐字相同** |
| 4 | **D101 的 `GetProcAddress` 证据不受影响** | ✅ `MODMAP cov=`（GPA 路径）[3] 与 [4] **逐项相同**；两者共用 `ws_name_identity`，**无共享可变状态**（纯函数 + 只读表） |
| 5 | 双前置 | ✅ 副本树编译 **exit 0 / 0 warning / 15 exports**；apply 链（副本树）`check=0 / apply=0 / apply -R=0 / apply=0` 且可逆 |
| 6 | 红线 | ✅ 真树仍 `1C14AB54…`；`shim/out`/inject·probe 原件/冻结候选/`ws_reg*`/`winstage_internal.h` 未动 |

---

## 1. 改动（`ws_LdrGetProcedureAddress` 名字分支）

```c
    if (st >= 0 && ProcedureNumber == 0 && ProcedureName && ProcedureAddress && *ProcedureAddress) {
        const unsigned char *s = (const unsigned char *)ProcedureName; /* ANSI_STRING */
        unsigned short len = *(const unsigned short *)(s + 0);
        const char *buf = *(const char *const *)(s + 8);
        if (buf && len && len < 128) {          /* 长度不可信就不换（不猜） */
            char namez[128];                    /* counted ANSI_STRING -> 有界 NUL 串 */
            memcpy(namez, buf, len);
            namez[len] = 0;
            void *rep = ws_name_identity(namez, *ProcedureAddress);   /* ← 与 D101 同一处 */
            if (rep) {
                *ProcedureAddress = rep;
            }
        }
    } else if (st >= 0 && ProcedureNumber != 0 && ProcedureAddress && *ProcedureAddress) {
        /* 序数分支：D4S2 既有语义，未动 */
        void *wrap = ws_wrapper_for_real(*ProcedureAddress);
        if (wrap) {
            *ProcedureAddress = wrap;
        }
    }
```

- 原实现是 `ws_hook_resolve_n(buf, len)`（**只按名**）；现改为 `ws_name_identity(namez, *ProcedureAddress)`（**地址同一性**，名单门仍由 `ws_hook_resolve` 把守）。
- `real` 的来源正是**真身解析器刚为调用方模块句柄解析出的地址** `*ProcedureAddress` ⇒ 它天然是"这个模块里该名字的真实函数"。
- 未命中 ⇒ 不改写 `*ProcedureAddress` ⇒ 调用方拿到真身（**绝不 fail-closed、绝不发明**）。
- 无递归：本分支不调用 `GetProcAddress`/`LdrGetProcedureAddress`；`ws_name_identity` 内部只用真身 `g_orig.GetProcAddress`（且仅在"名字覆盖且全局表未命中"时）。

---

## 2. LDR 专属离线证据（4 臂 A/B，lane-free）

构件：`probe\d4samename.dll`（`120CD9F5…`，合法导出 `GetFileAttributesW` ⇒ `return 0xDEADBEEF;`）；探针 `probe\d4-o1-probe.exe`（`561251D7…`，新增 `LDRCOV` 矩阵）。
原始件：`.t/round10/shim/d4/D4O1b-offline-4arm.txt`（`DBF09C0E…`，21,339 B）。

| 臂 | 注入件 | `SAMENAME`（GPA 路径） | **`LDR-NAME` / `LDR-CALL`（兄弟入口）** |
|---|---|---|---|
| [1] | 无 shim | `ptr=6FDB1000 owner=d4samename.dll result=0xDEADBEEF` | `ptr=6FDB1000 owner=d4samename.dll result=0xDEADBEEF` |
| [2] | count18（D4S2） | `ptr=6FBF3890 owner=winstage-shim.dll result=0x20`（错换） | **`ptr=6FBF3890 owner=winstage-shim.dll result=0x20`（错换）** |
| [3] | **D101 only** | `ptr=6FBC1000 owner=d4samename.dll result=0xDEADBEEF` ✅ | **`ptr=6FBF3890 owner=d4-o1-shim.dll result=0x20`（残留，即 O1b 要修的点）** |
| [4] | **D101 + O1b** | `ptr=6FBC1000 owner=d4samename.dll result=0xDEADBEEF` ✅（不变） | **`ptr=6FBC1000 owner=d4samename.dll result=0xDEADBEEF` ✅（修复）** |

**活性正对照（同 run）**：[3][4] 中 `KB-GFAW` 都返回包装且实调 `0x20`（钩子活着、覆盖在）；`KB-CFW`、`NT-NQIFBN` 仍为包装。
**阴性对照**：`TEST-NTCLOSE`/`TEST-NQIFBN`（被测模块不导出）三臂皆 `NULL`；`NtClose` 走 `LDRCOV`/`MODMAP` 恒为真身。

---

## 3. LDR 路径覆盖对照（17 名 × {kb,k32,adv,nt}，`LDRCOV` 逐项）

| 名字类 | [2] count18 | [3] D101 | **[4] D101+O1b** |
|---|---|---|---|
| `GetFileAttributesW` / `CreateFileW` / `GetProcAddress` / `LoadLibraryW` / `GetFileInformationByHandle(Ex)` / `MoveFileWithProgressW` | `kb:S k32:S` | `kb:S k32:S` | **`kb:S k32:S`（相同）** |
| `RegCreateKeyExW` | `kb:S k32:S adv:S` | `kb:S k32:S adv:S` | **`kb:S k32:S adv:S`（相同）** |
| `LdrLoadDll` / `NtQueryInformationByName` / `NtQueryInformationFile` / `NtQueryAttributesFile` / `NtQueryFullAttributesFile` / `NtOpenFile` / `NtSetInformationFile` | `nt:S` | `nt:S` | **`nt:S`（相同）** |
| `NtClose`（非覆盖） | `nt:R` | `nt:R` | **`nt:R`（相同，未误伤）** |
| **`LdrGetProcedureAddress`（自身）** | `nt:R` | `nt:R` | **`nt:S` ← 覆盖增益** |

**关于最后一行的增益（必须说明，避免被当意外）**：旧名字路径用的是 `ws_hook_resolve_n()`，它**只查 `g_targets[]`**，而 `LdrGetProcedureAddress` **不在 `g_targets[]`**（只在 `g_targetNames[]`+`map[]`，靠 `ws_hook_resolve()` 里的特殊例兜）⇒ 经该入口解析它自己时**从来拿不到包装**。O1b 改用 `ws_name_identity()`（内部走 `ws_hook_resolve()`，含特殊例）⇒ 现在会返回包装 —— 这与 **GPA 路径的既有行为一致**（`MODMAP LdrGetProcedureAddress nt:S` 早在 [2] 就成立），是**同一性规则被一致应用**的结果，方向为**覆盖增益**、非丢失；其包装本身只转发真身，无语义风险、无递归。

---

## 4. 回归风险声明（Lead 要求）

- **D101 的 `GetProcAddress` 证据不受影响**：`MODMAP cov=`（GPA 路径，19 名）在 [3] 与 [4] **逐项相同**（`kb:S k32:S / adv:S / nt:S / NtClose:R`）；仅个别**绝对地址**随构建布局不同（正常）。
- **无共享可变状态**：`ws_name_identity()` 是**纯函数**（只读 `g_targets[]`/`g_d4OrdMap[]`/`g_orig` 句柄，唯一的"状态"是 `g_d4OrdMap[i].real` 的 CAS 惰性缓存，且读写都是 `InterlockedCompareExchangePointer`；两条路径调用同一函数 ⇒ 只会互补，不会互相污染）。
- **两条路径语义一致**：都"命中才换、未命中保留 `real`"，都以真身解析器结果为身份基准。

---

## 5. 出件与双前置

| 项 | 值 |
|---|---|
| 补丁 `D101b` | `D936F84D…` / 1,399 B / 26 行（**仅** `shim/src/ws_hook.c`，1 个 hunk：名字分支） |
| 锚点 | `NTSTATUS NTAPI ws_LdrGetProcedureAddress(PVOID, const void *, ULONG, PVOID *)` 内 `if (buf && len) { ws_hook_resolve_n(buf, len) … }` 五行为一处；`ws_name_identity` 本身不改（D101 已引入） |
| before → after | `9A96354E…` / 43,890 B → **`0222702B56E75AA3DDE43AA19AB3B9624AF2A62FC200BD5A04DA3FE68EE405B2`** / 44,587 B |
| 副本树编译 | `.t/round10/shim/d4/o1b-out/d4-o1b-shim.dll` = `13EE4C78CA18F038EF8993B9B5498FFA3AF8EE7C50EE74157F90EE1CD4EB3F90` / 266,240 B；**RC=0 / stderr 0 B（0 warning）/ exports(15)** |
| apply 链（`--directory=` 副本树） | `check=0 / apply=0` → `0222702B…`；`apply -R=0` → `9A96354E…`；复 `apply=0`；**真树读到仍 `1C14AB54…`** |
| 回滚 | `git -c safe.directory=* apply -R --directory=.t/round10/shim/d4/scratch-o1b .t/round10/shim/d4/D101b-o1b-ldr-name-identity.patch`（复原源 `D4O1-ws_hook.c` = `9A96354E…`）；**整链回滚**则先 `-R D101b` 再 `-R D101` |
| 原始件 | `D4O1b-build-copytree.txt`（`F100137F…`）、`D4O1b-copytree-exports.txt`（`54F7FD9F…`）、`D101b-double-front-copytree.txt`（`303E1BF4…`）、`D4O1b-offline-4arm.txt`（`DBF09C0E…`） |

---

## 6. 限制与残留

1. 名字长度 `len >= 128` 一律不换（与旧 `ws_hook_resolve_n` 的上限一致）；覆盖名最长 `CreateProcessAsUserW`=21，无影响。
2. 序数分支（`ProcedureNumber != 0`）**未动**：对 `kernel32` 转发 stub 仍保持透传（D4S2 既有保守语义）。
3. 本件与 `D101` 共用 `ws_name_identity`；若 `count19` 的任一门不过，按 Lead 在 `task-19` 预登记的二分法，先分别单独构建 `D101` 与 `D101b` 定位，**未定位前不得整体回退**。
4. 车道验收（载体门槛 + ② + ③ + 独立复核）归 `pkgs`/`exe`；本文件只覆盖"出件 + 双前置 + 离线证据"。
