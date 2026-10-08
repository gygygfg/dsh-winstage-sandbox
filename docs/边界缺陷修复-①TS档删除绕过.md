# 边界缺陷修复 ① —— TS 档删除绕过（真删 / 无 whiteout / 不入审批面）

- 修复对象：`docs/沙箱边界实测矩阵.md` §4-①（透明档 TS 下删除真实文件：真删、无 whiteout、候选 `删除 0 项`）
- 修复位置：`shim\**`（不触碰 `src\**`；需要 src 配合的一处按 §6 报告，未擅自修改）
- 产物：`shim\out\winstage-shim.dll`（旧 `D96CD38F…24B10A` → 新 `94988D8B…159C36`）
- 回归脚本：`run.cmd .t\shim-delete\test-delete-capture.mjs`（33 项断言全过；用旧 DLL 跑同一脚本退出码 1）

---

## 1. 结论摘要

审计的**现象**成立，但审计的**机理推断**只对了一半。实测（非静态推断）表明缺陷 ① 由三个互相独立的逃逸面叠加而成：

| # | 逃逸面 | 实测调用链 | 影响 |
|---|---|---|---|
| A | 删除指令根本不经过 `DeleteFileW` | `cmd.exe` 的 `del`/`erase` → `ntdll!NtOpenFile(DELETE, **FILE_DELETE_ON_CLOSE**)`，句柄关闭时由内核删除真实文件 | V1/V2（在被注入的 cmd.exe 内部）真删 |
| B | 删除指令在**未被注入的子进程**里发生 | `cmd.exe` → `CreateProcessW` → `powershell.exe` / `node.exe`（**没有**被注入 shim） | V3/V4 真删；且一切孙子进程的写/删/改名都直接落真实磁盘 |
| C | 句柄级改名走 `MoveFileWithProgressW` | `cmd.exe` 的 `ren` → `MoveFileWithProgressW` → `NtOpenFile` + `NtSetInformationFile(FileRenameInformation=10)` | 改名真落盘（顺带发现：审计"改名已被正确拦截"只对 `move /y` 成立） |

`DeleteFileW/A`、`RemoveDirectoryW/A` 其实**早就在钩子表里**（`ws_hook.c` 目标表），所以"补上 DeleteFileW 就能修好"是错的：实测 cmd.exe 的 `DeleteFileW` IAT 槽被打补丁（hits=3），但 `ws_DeleteFileW` **一次都没被调用**（shim 日志里既无 `DeleteFileW request …` 也无 `DeleteFileW staged+whiteout`），而文件真的没了。

修复：在 shim 里补 3 条指令级钩子（`NtOpenFile` / `NtSetInformationFile` / `MoveFileWithProgressW`），并让 `CreateProcess*` 把 shim **自注入到子进程**（否则 V3/V4 在任何 API 层面都不可能被拦到——它们在别的进程里）。

---

## 2. 复现（修复前，同一台机器、同一 CLI 路径）

命令（与审计一致，绝对路径的探测脚本）：

```
run.cmd src\cli.mjs exec --workspace .t\shim-delete\ws2 --tier TS --json -- ^
    cmd /c C:\...\WinStageSandbox\.t\shim-delete\del4.cmd
```

`del4.cmd` 用四种写法各删一个**工作区外**的真实文件（`d1-cmd-del.txt` … `d4-node-unlink.txt`）。

| 事实 | 修复前实测值 | 证据 |
|---|---|---|
| 宿主文件还在吗 | **全部消失**（`Test-Path` 全 False） | `.t\shim-delete\raw\before-02-cli.json` |
| 有 whiteout 吗 | `staged\wo\` 下**一个都没有** | 同上（目录列举为空） |
| 候选说什么 | `ingested.deletions=0`，`summary.byOp={"create":1}`，CLI 打 `删除 0 项` | `.t\shim-delete\ws2\.dshstage\candidates\cs_0001_57b549d1.json` |
| 档位是否真的是 TS | `tier=TS`、`enforcement=shim-user-mode`、`transparentShim.available=true` | 同上 JSON |

审计的原始证据（`.t\boundary-os\raw\60-ts-iso-delete.txt`、`61-del-variants.txt`）与本次复现一致；本文档所有数字都以本次实测为准。

---

## 3. 根因（含 `file:line`）

### 3.1 逃逸面 A：`FILE_DELETE_ON_CLOSE`（V1/V2）

测量方法：临时诊断 DLL（只记日志、不改行为，见 `shim\src\ws_diag.c` 的设计说明；该文件已在最终构建前删除），把 `NtOpenFile` / `NtSetInformationFile` / `SetFileInformationByHandle` / `MoveFileWithProgressW` / `CreateProcessW` 加进目标表并用 `WINSTAGE_SHIM_VERBOSE=1` 记录。原始日志：`.t\shim-delete\raw\diag2-del4.txt`、`.t\shim-delete\stage-diag\shim.log`。

`[实测]` 注入 cmd.exe 后执行 `del`：

```
DIAG NtOpenFile name=\??\C:\...\ext\d1-cmd-del.txt access=0x10000 share=0x4 options=0x5040 -> 0x0
DIAG NtSetInformationFile class=14 ... path=\??\C:\...\del4.cmd -> 0x0     ← 只是 FilePositionInformation(14)
```

- `access=0x10000` = `DELETE`；`options=0x5040` = `FILE_OPEN_FOR_BACKUP_INTENT(0x4000) | **FILE_DELETE_ON_CLOSE(0x1000)** | FILE_NON_DIRECTORY_FILE(0x40)`。
- 全程**没有** `FileDispositionInformation(13)`：删除在句柄关闭时由内核完成。
- 该进程里 cmd.exe 的 `DeleteFileW` IAT 槽确实被打了补丁（诊断日志 `iat DeleteFileW <- cmd.exe`，`target DeleteFileW hits=3`），但 `ws_DeleteFileW` 从未进入 → "钩子存在但调用者不用它"。

因此只钩 Win32 删除 API 永远拦不到 `cmd del`。

### 3.2 逃逸面 B：孙子进程完全没有被注入（V3/V4，且远不止删除）

`[实测]` 注入 cmd.exe 后，日志里只有**一个 PID**（cmd.exe 自己）。它用 `CreateProcessW` 启动的子进程：

```
DIAG CreateProcessW app=C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe flags=0x80000 -> 1 pid=2068
DIAG CreateProcessW app=C:\Program Files\nodejs\node.exe                    flags=0x80000 -> 1 pid=328
```

（`0x80000` = `EXTENDED_STARTUPINFO_PRESENT`。）这些子进程里没有 shim，于是：

- `node -e "fs.writeFileSync(<真实路径>,'x')"` → **真实文件被创建**（宿主侧 `g1-node-w.txt` 存在）；
- `powershell Set-Content <真实路径>` → **真实文件被创建**（`g2-ps-w.txt` 存在）；
- 四种删除写法里的 V3/V4 就是这样逃出去的。

`[实测]` 修复前的子进程写证据：`.t\shim-delete\raw\diag-child.txt`。这也说明缺陷 ① 的 V3/V4 不是"删除 API 没钩"，而是"载体进程没钩"。

### 3.3 逃逸面 C：`ren` 用 `MoveFileWithProgressW`

`[实测]` 同一批日志：

```
DIAG MoveFileWithProgressW src=\??\...\ext\d-ren.txt dst=\??\...\ext\d-ren2.txt flags=0x2
DIAG NtOpenFile            name=\??\...\ext\d-ren.txt access=0x110080 ...
DIAG NtSetInformationFile  class=10 len=184 path=\??\...\ext\d-ren.txt -> 0x0   ← FileRenameInformation
```

`MoveFileWithProgressW` 不在钩子表里，真实文件被真改名（宿主侧 `d-ren2.txt` 存在、`d-ren.txt` 消失）。对照：`move /y` → `MoveFileExW`（已钩，日志 `MoveFileExW staged`），审计看到的"改名被拦截"只覆盖了这一种写法。

### 3.4 为什么 `NtSetInformationFile` 也必须钩

`[实测]` 修复后 `node fs.unlinkSync` 的调用链（新 DLL 的 shim 日志）：

```
NtSetInformationFile disposition class=64 raw=<stageRoot>\fs\C\...\ext\d4-node-unlink.txt
                          logical=C:\...\ext\d4-node-unlink.txt staged=1
NtSetInformationFile disposition staged+whiteout C:\...\ext\d4-node-unlink.txt
```

即 libuv 先 `CreateFileW(DELETE)`（被我们的 `CreateFileW` 钩子重定向到暂存副本），再 `SetFileInformationByHandle(FileDispositionInfoEx=21)`；`kernelbase.dll` 的 `NtSetInformationFile` IAT 槽同样被打补丁（诊断日志 `iat NtSetInformationFile <- KERNELBASE.dll`），所以在 `NtSetInformationFile` 一处即可覆盖 `SetFileInformationByHandle` 与 kernelbase 内部删除——因此**不需要**单独钩 `SetFileInformationByHandle`。

注意：因为 kernelbase 也被打补丁，shim 自己调用 `g_orig.DeleteFileW/RemoveDirectoryW/MoveFileExW` 时会经由 kernelbase 的 IAT 再次进入我们的 Nt 钩子 → 必须加**线程内重入守卫**（`ws_file.c:31` 的 `_Thread_local int t_wsFileBusy`，见 `ws_file.c:381 / 436 / 504 / 915`），否则递归。

---

## 4. 修复内容

### 4.1 最终钩子清单（每条都有实测调用者）

| 钩子 | 实测调用者（本机） | 行为 |
|---|---|---|
| `NtOpenFile` | `cmd.exe` 的 `del` / `erase`（`FILE_DELETE_ON_CLOSE`） | 摘掉 `FILE_DELETE_ON_CLOSE` 再调真实 API（真实文件绝不会被内核删）；真实 open 成功后记 whiteout + 删暂存副本；记录失败则关句柄 + `STATUS_ACCESS_DENIED`（fail-closed）。`ws_file.c:937` |
| `NtSetInformationFile` | `kernelbase!SetFileInformationByHandle` ← libuv（`node fs.unlinkSync`, class=64）；kernelbase 内部删除（class=13） | `FileDispositionInformation(13)`/`Ex(64)` 且 delete 位为真：句柄路径若在覆盖层外→记 whiteout；若句柄指向**暂存副本**（被我们自己的 `CreateFileW` 重定向过）→反解逻辑路径后同样记 whiteout，返回 `STATUS_SUCCESS`，**不碰真实文件**。`ws_file.c:990` |
| `MoveFileWithProgressW` | `cmd.exe` 的 `ren` | 复用 `ws_move_locked()`（与 `MoveFileExW` 同一套暂存语义）。`ws_file.c:1046` |
| `CreateProcessW` / `CreateProcessAsUserW` | `cmd.exe` 启动 `powershell.exe` / `node.exe`（`CreateProcessW` hits=4/5） | 强制 `CREATE_SUSPENDED` → 远程 `LoadLibraryW` 注入本 DLL → 调用方未要求挂起则 `ResumeThread`；注入失败=终止子进程并 `ERROR_ACCESS_DENIED`（fail-closed，绝不留下未钩住的子进程）。`ws_proc.c:169 / 239 / 246` |
| `DeleteFileW` / `DeleteFileA` | `node.exe` 导入表；注入后的 `powershell.exe`（.NET `File.Delete` → `DeleteFileW`，实测 `DeleteFileW staged+whiteout`） | 原有实现，未改语义（仅加重入守卫） |
| `RemoveDirectoryW` / `RemoveDirectoryA` | `cmd.exe` 的 `rd`（实测 `RemoveDirectoryW staged+whiteout`） | 原有实现，未改语义 |

**没有**添加（无实测调用者，属推测）：`NtCreateFile`、`CreateProcessA`/`CreateProcessAsUserA`、`MoveFileWithProgressA`、`SHFileOperation`、`IFileOperation`、`SetFileInformationByHandle`（已被 kernelbase IAT 覆盖）。

### 4.2 关键实现点

- 唯一的落地规则：**逻辑路径记为删除（whiteout）**，真实文件绝不触碰；覆盖层写不进去就 `STATUS_ACCESS_DENIED`（`ws_record_delete()`，`ws_file.c:899`）。
- 暂存副本反解：`ws_logical_from_staged()`（`ws_file.c:837`）按内置 provider 的布局 `<root>\fs\C\a\b → C:\a\b`、`<root>\fs\_unc\… → \\…`（`ws_stage.c:34-73`）反解；反解失败→fail-closed。
- 句柄取路径：`GetFinalPathNameByHandleW`（`ws_file.c:814`，非钩子目标，不会重入）；DELETE-only 句柄实测可解析（`d-ren.txt` access=0x110080）。
- 负面对照天然成立：只有真实 open **成功**后才记 whiteout，"删一个不存在的文件"仍是普通 open 失败（见 §5）。
- 子进程注入的环境契约：`WINSTAGE_STAGE_ROOT/LOG/CONFIG` 必须出现在子进程环境里，否则注入进去的 shim 会"加载但不初始化"（更坏：看起来被钩住却在写穿）。调用方自带 env 块时由 `ws_env_with_contract()`（`ws_proc.c:66`）重建；cmd.exe 传 env=NULL（继承），实测三个变量都在（能力金丝雀 `winstageVars=3`）。

---

## 5. 重建证据（旧/新 SHA-256 + 载体证明）

| 项 | 值 |
|---|---|
| 旧 DLL | `shim\out\winstage-shim.dll`，228352 字节，`D96CD38F4C8B92712B3EDEE6161440BE7FE356ED6909260F9915ED9D7D24B10A`（备份：`.t\shim-delete\winstage-shim.before.dll`） |
| 新 DLL | 235520 字节，`94988D8B903DB9702192AEA35EF87022FFC96A087629D7E8A6247AF391159C36` |
| 构建命令 | `run.cmd tools\build-shim.mjs`（zig 0.13.0，`tools\toolchain\zig-0.13.0\zig.exe`），`warnings: 0`，产物同时重编 `winstage-inject.exe` / `winstage-probe.exe`；日志 `.t\shim-delete\raw\build-final.txt` |
| probe 自检（`[实测]`） | `winstage-probe.exe selftest shim\out\winstage-shim.dll <out>` → exit 0，`loaded=true abiVersion=1 initReturn=0`，`initialized=true hooksInstalled=true iatSites=73 modules=9`（`.t\shim-delete\stage-probe\selftest.json`） |
| executor 侧证明（`[实测]`，回归脚本内） | `transparentShim.artifacts.dllPath = C:\...\shim\out\winstage-shim.dll`，同一文件 SHA-256 = 新值；8 项检查全过：`shim-dll / shim-injector / shim-probe-exe / shim-config / shim-selftest(iatSites=64,modules=8) / shim-inject-canary(exit 0) / shim-log-observed / shim-canary-capabilities(all capabilities present)`；`tier=TS`、`enforcement=shim-user-mode`（`.t\shim-delete\run-mupoqkhj-2tw\raw\cli.json`） |

> 结论：TS 档只在 probe"证明"了 shim 时才被选中（`src\executor.mjs:2989-3173`），本次运行正是这种情况，且被注入的确实是新 DLL（路径 + SHA-256 双证）。

---

## 6. 四写法修复前后对照

同一脚本（`.t\shim-delete\test-delete-capture.mjs`）同一探测命令，只换 DLL：

| 写法 | 修复前（旧 DLL） | 修复后（新 DLL） |
|---|---|---|
| `cmd del` | 宿主文件**消失**、无 whiteout | 宿主文件**仍在**、whiteout 已写 |
| `cmd erase` | 宿主文件**消失**、无 whiteout | 宿主文件**仍在**、whiteout 已写 |
| `powershell Remove-Item -Force` | 宿主文件**消失**、无 whiteout | 宿主文件**仍在**、whiteout 已写（且 `powershell.exe` 现在是**被注入**的子进程） |
| `node fs.unlinkSync` | 宿主文件**消失**、无 whiteout | 宿主文件**仍在**、whiteout 已写（`NtSetInformationFile class=64` 走暂存反解） |

- 工作区内、工作区外两种位置都测（8 个删除目标）：修复后 16 项断言（宿主存在 + whiteout）全过。
- 修复后 shim 日志中四个删除分别落在：`NtOpenFile delete-on-close`（del/erase）、`DeleteFileW staged+whiteout`（PowerShell）、`NtSetInformationFile disposition`（node）、`RemoveDirectoryW staged+whiteout`（rd）。
- 顺带修好：孙子进程写（`node`/`powershell` 直接写真实路径）→ 现在进暂存；`ren` → 现在进暂存（`move /y` 原本就正常）。

**负面对照**（`[实测]`）：`del` 一个从不存在的文件 → 宿主当然不存在、`staged\wo\` **没有**该路径的标记；`node fs.unlinkSync` 对一个不存在的文件 → 抛 `ENOENT`（预期），同样不产生删除记录。原因：whiteout 只在真实 open **成功**之后才记（`ws_file.c:963-975`）。

**无回归**（`[实测]`，同一脚本）：载体自写（`cmd echo >`）→ 真实磁盘无、覆盖层有；孙子进程写 → 同上；`move /y`（`MoveFileExW`）与 `ren`（`MoveFileWithProgressW`）→ 真实源仍在、真实目标未建、源有 whiteout；CLI 能力金丝雀仍全绿（管道/重定向/whoami/tasklist/CIM/防火墙/TCP/TLS 九项 + 无 DSH 痕迹）。

---

## 7. 仍然没修好的、以及必须由 `src\**` 完成的一处（未擅自修改）

### 7.1 候选仍然"删除 0 项"——这是 `src\` 侧的白名单缺口，不是 shim 能修的

`[实测]` 修复后 CLI 输出：`ingested={"ingested":22,"deletions":0}`，候选 `summary.byOp={"create":22}`，其中 **10 条是 `wo\...` 路径**（whiteout 标记被当成"新建文件"），候选 JSON：`.t\shim-delete\run-mupoqkhj-2tw\ws\.dshstage\candidates\cs_0001_0533506e.json`。

同一现象在**修复前**的审计候选里就能看到：`.t\ws\.dshstage\candidates\cs_0011_d2ef6522.json` 里有
`create wo\C\Users\...\ext\w3b-move.txt`（那是重命名的 whiteout 标记）。

原因：`src\workspace.mjs:1311-1329` 的 `captureAfterExecution()` 只把"执行前快照里有、执行后没有"的暂存对象判为删除，而：
1. 它把整个 `<stagedDir>`（含 `wo\`）当内容树遍历 → 新出现的 whiteout 标记被报成 `create`（还带 `wo\` 前缀的伪路径）；
2. 工作区外、从未进过暂存树的真实文件被删时，暂存树里没有任何对象消失 → 捕获不到，`删除 0 项`。

**这不是 shim 能绕过的**：删除记录写在 `<stageRoot>\wo\`，而快照是在命令执行**之前**取的（`src\cli.mjs:202`），shim 无法让一个从未暂存过的路径出现在"执行前快照"里。因此"候选计入 1 项删除"必须由 src 侧解释 whiteout 标记。

**建议改动（精确位置，请 src 负责人实施；我未修改）**

1. `src\workspace.mjs:1311-1329`（`captureAfterExecution`）：
   - 内容 diff 里**排除** `wo\`（以及 `registry\`）子树，别再把标记当 create；
   - 对每个**新出现**的 `wo\` 标记，反解 provider 布局（`wo\C\a\b → C:\a\b`、`wo\_unc\server\share\x → \\server\share\x`，与 `shim\src\ws_stage.c:34-73` 同构），产出 `{ path: <逻辑绝对路径>, hash: hashAbsent(), deleted: true }`。
2. `src\workspace.mjs:1353`（`snapshotStagedTree`）：同样排除 `wo\`，否则上一次运行的标记会被当成暂存内容对象。
3. `src\store.mjs:381-387`（`stagedPath`）+ `src\workspace.mjs:820-848`（`remove`）：让 store 知道"删除"持久化为 `<stagedDir>\wo\<...>` 标记，使 `diffEntries()`（`src\workspace.mjs:946` 的 `op:'delete'`）与 `apply`/`discard`（`src\workspace.mjs:1232`）口径一致。
4. （可选）`src\cli.mjs:252` 的 `删除 ${ingested.deletions} 项` 无需改动，1-3 落地后自然变成非零。

回归脚本已经预留了这个开关：`run.cmd .t\shim-delete\test-delete-capture.mjs --strict-deletions`（默认只把它记为 WARNING，因为 shim 侧的"捕获"= 宿主未被删 + whiteout 已记，这部分现在是**致命断言**且全过）。

### 7.2 未覆盖 / 未验证（诚实声明）

1. **未跑 `verify.cmd` / `autotest`**（任务要求，门禁由另一位修复者持有）。**子进程自注入会改变孙子进程的覆盖面**：任何以前观察到"孙子进程写穿"的用例（例如 `reg.exe /reg:32` 的 WOW64 透传、`CR3-ADS`、硬链接等）在 TS 档下现在会变成"进暂存 / fail-closed"。这是本修复的**预期后果**，但必须由 finisher 重跑门禁确认，我这边只测了自己的脚本与 probe。
2. **子进程注入失败 = fail-closed**（终止子进程 + `ERROR_ACCESS_DENIED`），这与项目"不能暂存就拒绝、绝不静默写穿"的规则一致，但副作用未测：x64 DLL 注入不进 32 位（WOW64）子进程，所以 TS 档下**32 位子进程会被拒绝**。诊断/受保护创建（`DEBUG_PROCESS`/`DEBUG_ONLY_THIS_PROCESS`/`CREATE_PROTECTED_PROCESS`）被显式豁免，只记日志不注入（代码路径存在，未实测触发）。
3. `NtCreateFile` + `FILE_DELETE_ON_CLOSE` **没有**钩（无实测调用者；Win32 `CreateFileW(..., FILE_FLAG_DELETE_ON_CLOSE)` 本来就被 `CreateFileW` 钩子覆盖并进暂存）。直接调 `NtCreateFile` 带该标志的进程仍可真删 —— `[推断]`（文档调用链），本机未实测到。
3b. **`[实测]` Win32 `CreateFileW(FILE_FLAG_DELETE_ON_CLOSE)`（含 .NET `FileOptions::DeleteOnClose`）：宿主文件保住了，但删除没有留痕。**
   测量：注入 powershell.exe 后执行
   `[System.IO.File]::Create('<ext>\d7-delonclose.txt', 4096, [System.IO.FileOptions]::DeleteOnClose)` 并 `Close()` →
   宿主 `d7-delonclose.txt` **仍在**，`staged\wo\` 里**没有**它的 whiteout（`.t\shim-delete\raw\d7.txt`）。
   原因：Win32 的 create 走 `kernelbase!CreateFileW → ntdll!NtCreateFile`（不是 `NtOpenFile`），实参 `FILE_FLAG_DELETE_ON_CLOSE` 落到**我们重定向后的暂存副本**上，句柄关闭时内核删掉的是暂存副本，逻辑路径没有 whiteout → 删除静默丢失（方向是安全的：真实文件没被破坏）。
   我没有顺手修，因为最小改法（在 `ws_create_file_core()` 打开成功后立刻 `ws_record_delete()`）会让"句柄还开着"的窗口期内该路径立刻表现为不存在，破坏"DeleteOnClose 临时文件在生命周期内仍可被按路径读回"的语义；正确修法要在 `NtClose` 上做"句柄→逻辑路径"跟踪后于关闭时记 whiteout，属独立一轮工作，且不在本次四写法范围内。
4. `NtSetInformationFile(FileRenameInformation=10)` 没有拦截（不属缺陷 ① 范围）：`ren` 已在 `MoveFileWithProgressW` 层拦住，但**直接**发该指令的调用者仍会真改名。
5. `GetFinalPathNameByHandleW` 解析不了句柄时 `NtSetInformationFile` 一律 `STATUS_ACCESS_DENIED`（fail-closed 分支）。本机所有测试都解析成功，未遇到该分支。
6. TS 档对**完全不受我们派生**的外部进程（用户另开的 cmd、服务、其它 DSH 会话）依旧没有覆盖 —— 这是 IAT 补丁档位的固有边界，未变。
7. 我未测 `apply` 对删除候选的落盘行为（因为候选里现在根本没有删除单元，见 §7.1）。

---

## 8. 复现 / 验证命令清单

```bat
rem 构建（默认输出 shim\out\）
run.cmd tools\build-shim.mjs

rem 回归（致命断言：四写法捕获 + 孙子进程写 + move/ren + 负面对照 + 无回归）
run.cmd .t\shim-delete\test-delete-capture.mjs

rem A/B：同一脚本换回修复前的 DLL → 退出码 1
run.cmd .t\shim-delete\test-delete-capture.mjs --dll .t\shim-delete\winstage-shim.before.dll --keep

rem src 补齐 whiteout 捕获后，把候选删除数也变成致命断言
run.cmd .t\shim-delete\test-delete-capture.mjs --strict-deletions
```

关键原始证据（全部留在 `.t\shim-delete\raw\`）：
`build-final.txt`、`selftest-fixed.txt`、`regress-final.txt`（新 DLL，PASS 33）、`regress-before.txt`（旧 DLL，FAIL 23）、`before-02-cli.json`（修复前 CLI）、`fix-cli-ws.json`（修复后 CLI）、`diag2-del4.txt` / `diag-child.txt`（调用链测量）、`diag-01.txt`、`fix1-del4.txt`、`fix-childwrite.txt`。

---

## 9. 收口（finisher，2026-10-02；本节 `[实测]`）

> **本节的目的是接线与复测，不重写上面的发现。**

### 9.1 门禁登记

- `.t\shim-delete\test-delete-capture.mjs` 已**原样提升**为 `tests\delete-capture.mjs`，并登记进
  `src\testrunner.mjs::SANDBOX_SUITES`（id `delete-capture`）。它注入真实子进程、依赖
  `shim\out\winstage-shim.dll`，因此**不进** `verify.cmd` 的离线清单（与 `file-cow-dispositions` 同理）。
- `--strict-deletions` 在提升版里提升为**默认**（①b 已让候选删除数可致命）；逃生口 `--no-strict-deletions`。
- 与既有套件不重复：原 `.t\` 脚本保留为历史产物，不重复登记。

### 9.2 复测读数

- `node tests\delete-capture.mjs` → **exit 0、`RESULT: PASS (35 checks)`**；
  `tier=TS`、`transparentShim.available=true`（新 DLL SHA-256 `94988D8B…9C36` 被 executor 侧证明）；
  `candidate byOp={"delete":10,"create":12} delete=10 bogusWoCreates=0`（`.t\finish-delete-capture.txt`）。
- **稳定性口径修正（收尾轮，据独立复核 §6 第 1 条）**：本行原文只给了 35/35，容易被读成"无条件全绿"。
  实测事实：本机 PowerShell 载体偶发**启动即失败**（CLR 加载器 `System.Data.dll`、HRESULT
  `0x8007054F`），此时 `write-staged:R1-ps` 会红，而同一次 `write-not-real:R1-ps` 仍绿 ⇒ 是
  宿主/CLR 侧 flake、**没有写穿**。收尾轮的处置（只改 `tests\delete-capture.mjs`）：先做**一次
  有界重试**；重试后仍红且命中该加载器签名、对应真实盘未被改动、且未出现 PowerShell 成功标记
  （`PS-RI-OK` / `PS-W-OK`）时，记**响亮 SKIP ＋ 确切原因**（退出码 0、不计失败）；**真实捕获失败
  仍一律 FAIL**（写穿 / 真删 / 白障缺失）。`[实测]` 收尾轮**连续 3 次**运行均为
  `RESULT: PASS (35 checks)`、exit 0（`.t\closelow-dc-run1..3.txt`）；SKIP 形态与"仍须 FAIL"的
  反向验证见 `.t\closelow-selftest\A.txt`（SKIP）、`B.txt` / `C.txt`（FAIL）。
- 四种写法 × 工作区内外 = 8 个删除目标：**宿主文件全部存活 + 每处一条 whiteout**（16 项致命断言全过）。
- 孙进程写（`node` / `powershell`）→ 进暂存；`move /y` 与 `ren` → 源存活/目标未建/源有白障；
  两条负面对照（删不存在的文件）不产生删除记录。
- 受影响套件：`file-cow-dispositions` **19/19**；`registry-unstaged-wow64` 36/0；
  `run-shim-closedloop --keep-stage` **30/30**；`registry-conformance` 58/0（1 SKIP）；
  `acceptance-transparent`（`WINSTAGE_ACCEPT_CARRIER=inject`）8/1 —— 与修复前逐项相同（仅 T8 面板）。
- 门禁 `verify.cmd` = **25 套件 / 1949 `✓` + 85 `[OK  ]` = 2034 标记 / `RESULT: ALL PASS`**。

### 9.3 §7.2 残余的复测结论

| 残余 | 本轮复测 | 证据 |
|---|---|---|
| 3b `FILE_FLAG_DELETE_ON_CLOSE` 不留白障 | **确认存在**：预置真实文件后，TS 内 `[System.IO.File]::Create(..., DeleteOnClose)` → 真实文件**存活且字节不变**（`REAL-D7B-BYTES`），但 `wo\` **无标记**、`ingested.deletions=0`。方向安全，删除静默丢失 | `.t\finish-ts32\d7b.json` |
| 2 32 位 WOW64 子进程被拒绝 | **确认存在**：`C:\Windows\SysWOW64\cmd.exe` → `TS_INJECTION_FAILED`（exit 111，`remote LoadLibraryW failed — refusing to continue unconfined`）、退出码 127、`classification.kind=runner-failure`；x64 对照 `X64` exit 0。fail-closed | `.t\finish-ts32\wow32.json` / `x64.json` |
| 3.3 `ren` 走 `MoveFileWithProgressW` | **已修**（`move-whiteout:R4-ren` 通过） | 同 9.2 |

**未复测**：§7.2 第 4 条（直接发 `NtSetInformationFile(FileRenameInformation=10)` 的调用者）、
第 5 条（`GetFinalPathNameByHandleW` 解析失败分支）、第 6 条（非本沙箱派生的外部进程）、
第 7 条（`apply` 删除候选的真实 CLI 落盘）。以上**本轮没有新增证据**，口径不变。

