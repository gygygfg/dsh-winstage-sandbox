# R11-D-13d：TS 车道四项同场基线 + 正对照（② 的 before 基线）

> 目的：为"沙箱内 node/libuv 与 cmd 看不见暂存文件"建立**当次档位可信**的基线。
> 载体：`run.cmd src\cli.mjs exec --tier TS`（**必须显式 `--tier TS`**，见 §4 的档位坑）。
> 四次运行的 `tierEffective` 均为 **TS**（原始件 `out/ts-q0..q3*.txt` 内含该字段）。
> 载体哈希：`shim/out/winstage-shim.dll` = `02C7418FF0F11AFD45FEEA601733E848ECB697FD393915565420F7A41248B76F`（246,784 B），
> `.text` = `C75106BEAA2BACF22AB6067567DDC2C8C25CB9F40856289EF3F8E93C5CACDB88`（198,656 B，`pe-text-hash.mjs`）。
> 夹具：`<ws>\probe\ts2.txt`（13 B，内容 `TS2-CONTENT`），由注入态 pwsh 用**绝对路径**写入 ⇒ 落 shim 暂存，
> **真实盘不存在**；暂存树里可见 `staged/fs/…`、`staged/winstage-shim.config.json`、`staged/shim.log`（overlay 确认激活）。

## 1. 四项读数（同夹具、同暂存根、同一 DLL）

| # | 载体（被注入的直接子进程） | 命令 | 读数 |
|---|---|---|---|
| Q0 | `powershell.exe` | 用绝对路径写夹具 | `wrote_bytes=13`、`dotnetExists=True`、`testPath=True` |
| Q1 | **`node.exe`** | `existsSync/statSync/lstatSync/readFileSync/readdirSync` | **`existsSync=false`**、**`stat=ERR:ENOENT`**、**`lstat=ERR:ENOENT`**、**`read` 成功 = `TS2-CONTENT`**、**`readdir(<ws>\probe)=["ts2.txt"]`** |
| Q2 | `cmd.exe` | `if exist` / `dir /b` / `type` | **`if exist` = NO**、`dir` = FAIL、`type` = FAIL |
| Q3 | `powershell.exe`（**正对照**） | `[IO.File]::Exists` / `Test-Path` / `Get-Item` / `[IO.File]::GetAttributes` / `ReadAllText` | **`dotnetFileExists=true`**、`testPath=true`、`getItemLength=13`、`attrs=Archive`、`readAllText=TS2-CONTENT` |

## 2. 这份基线给出的三个结论

1. **同一进程、同一路径、同一次运行内自相矛盾**：node 的 `existsSync/statSync/lstatSync` 说"不存在"（ENOENT），
   而 `readFileSync` **成功读出内容**、`readdirSync` **能列出该文件** ⇒ 缺陷不在"路径没映射"，而在
   **node 用来做 stat/exists 的那条 API 没有被 shim 挂钩**。
2. **`.NET` 正对照为 True** ⇒ overlay 确实激活、`GetFileAttributes*` 那条路是通的（与 Lead 的已知事实一致）。
3. **`cmd if exist` = NO** ⇒ cmd 的存在性判定走的是**另一条**未挂钩入口（与 node 的 stat 同族问题）。

## 3. 与族级二分的交叉印证（`docs/round10/fileio/13d/family-bisect.md`）

运行时开关（免源码）3/3 稳定：

| 配置 | node exists | node stat | node **read** | node readdir | **.NET Exists** | cmd if exist |
|---|---|---|---|---|---|---|
| baseline | false | ENOENT | **OK** | ts2.txt | **true** | NO |
| `SKIP=GetFileAttributesExW` | false | ENOENT | OK | ts2.txt | **false** ← .NET 用这条 | NO |
| `SKIP=GetFileAttributesW` | false | ENOENT | OK | ts2.txt | true | NO |
| `SKIP=FindFirstFileW` | false | ENOENT | OK | ts2.txt | true | NO |
| `SKIP=NtOpenFile` | false | ENOENT | OK | ts2.txt | true | NO |
| `SKIP=CreateFileW` | false | ENOENT | **FAIL** ← node read 用这条 | ENOENT | true | NO |
| `DISABLE_FILE=1` | false | ENOENT | FAIL | ENOENT | false | NO |
| `DISABLE_REG=1`（对照） | false | ENOENT | OK | ts2.txt | true | NO |

⇒ 两条正对照（`.NET→GetFileAttributesExW`、`node read→CreateFileW`）证明**开关链路真实生效**；
而 **node 的 `exists/stat` 与 `cmd if exist` 在"跳过任一已挂钩入口"后都不翻转** ⇒ 它们**不走已挂钩入口**。
13c 已否证 `NtQueryAttributesFile`/`NtQueryFullAttributesFile`，故剩余候选是未挂钩的句柄/查询族
（`NtQueryInformationFile`、`NtCreateFile`、`GetFileInformationByHandleEx`、`NtQueryInformationByName`、`NtQueryVolumeInformationFile`）——
这正是计数探针要定名的对象（规格见 `.t/round10/fileio/13d-count-probe/PATCH-SPEC.md`）。

## 4. ⚠ 档位坑（会污染任何"目录面/暂存可见性"结论）

`run.cmd src\cli.mjs exec` **默认 `tier=T1` / `launchMode=restricted-token`**：**没有 shim、没有 overlay**
（实测 `<stage>/staged/` 下无 `winstage-shim.config.json`、无 `shim.log`、无 `staged/fs/**`）。
在该载体上得到的 node/.NET/`cmd` ENOENT 读数**与 overlay 无关**，一律按 VOID 处理。
判据（可复算）：显式 `--tier TS` **加** 暂存树里出现 `staged/winstage-shim.config.json` + `shim.log` + `staged/fs/**`。

## 5. 原始输出

| 文件 | 内容 |
|---|---|
| `.t/round10/fileio/13d-count-probe/out/ts-q0-seed.txt` | Q0 全文（含 `tierEffective: TS`、`PS_SEED` 行） |
| `.t/round10/fileio/13d-count-probe/out/ts-q1-node.txt` | Q1 全文（含 `QUERY` JSON：exists/stat/lstat/read/readdir） |
| `.t/round10/fileio/13d-count-probe/out/ts-q2-cmd.txt` | Q2 全文（`CMD_IFEXIST_NO` / `CMD_DIR_FAIL` / `CMD_TYPE_FAIL`） |
| `.t/round10/fileio/13d-count-probe/out/ts-q3-dotnet.txt` | Q3 全文（正对照 JSON） |
| `.t/round10/fileio/13d-count-probe/env-override-harness.mjs` | `env` override harness（族级二分载体，实测开关可达子进程） |
| `.t/round10/fileio/13d-count-probe/family-bisect.mjs` + `docs/round10/fileio/13d/family-bisect.{md,json}` | 族级二分运行器与结果 |
| `.t/round10/fileio/13d-count-probe/pe-text-hash.mjs` | file/`.text` 双哈希（与 `pkgs` 对 out-15 的独立结果互校一致） |
