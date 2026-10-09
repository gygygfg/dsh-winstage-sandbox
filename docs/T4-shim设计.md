# T4 shim 设计（用户态文�?注册表写入暂�?shim�?
> 状态：**已交付并通过闭环**。`node tools/run-shim-closedloop.mjs` �?**30/30 PASS**（含宿主
> `createRegistryStage()` 产出候选、cmd/node/powershell 载体门）�?> 本文如实区分「已实测」「未覆盖」「已知绕过」，不把未验证的东西写成保证�?
---

## 1. 交付�?
| 产物 | 说明 |
|---|---|
| `tools/fetch-toolchain.mjs` | bootstrap 工具链（幂等、SHA256 双源校验、失败可诊断�?|
| `tools/build-shim.mjs` | 一条命令构�?DLL + 注入�?+ 探针，并用自�?PE 解析校验导出�?|
| `shim/out/winstage-shim.dll` | 注入用的 x64 DLL�?2 个导出，�?§4�?|
| `shim/out/winstage-inject.exe` | 挂起注入器（`CREATE_SUSPENDED` + 远程 `LoadLibraryW`�?|
| `shim/out/winstage-probe.exe` | 探针：`selftest`（真可用性探测）、文�?注册表操作、`appkey`（app hive 行为实测�?|
| `tools/pe-exports.mjs` | 自研 PE 解析（本机无 dumpbin�?|
| `tools/run-shim-closedloop.mjs` | 端到端验收（30 项断言，含负例与变异体�?|
| `tools/smoke-inject.mjs` | 载体门：cmd / node / powershell 注入后必�?exit 0 |
| `tools/triage-families.mjs` | 分族矩阵（全开 / 关注册表�?/ 关文件族 / 全关�?|
| `tools/bisect-api.mjs`、`tools/minimize-hooks.mjs` | �?API 二分�?*贪心最小化**失败集（无需重编�?|
| `tools/dbg-registry.mjs` | 单目�?verbose 运行 + 日志摘要 |
| `shim/src/**`、`shim/include/**` | C 源码、公开 ABI 头、内部头 |

---

## 2. 工具链选择与理由（含失败的方案�?
**本机事实**（已实测）：`cl` / `clang` / `clang-cl` / `gcc` / `g++` / `rustc` / `cargo` /
`ml64` / `nasm` / `zig` 全无；无 Visual Studio、无 Windows SDK、无 .NET SDK�?
**选定：Zig 0.13.0 官方 zip**（`https://ziglang.org/download/0.13.0/zig-windows-x86_64-0.13.0.zip`�?79,163,968 字节）。理由：

1. `zig cc -target x86_64-windows-gnu` **自带 mingw-w64 头与�?*（`windows.h`、`winreg.h`�?   `aclapi.h`、`sddl.h` 都可用），不需�?SDK�?2. 体积与依赖最小：解包 15,373 个文�?/ 308 MB，产�?DLL 只依�?`ADVAPI32.dll`�?   `KERNEL32.dll` �?UCRT（`api-ms-win-crt-*`，Win10+ 自带），**不需�?VC 运行�?*�?3. 单文件可执行、可放仓库内，便于复现�?
**SHA256 双源校验**：脚本内置固化哈�?`d859994725ef9402381e557c60bb57497215682e355204d754ee3df75ee3c158`�? 固化大小 79,163,968），
且每次运行都重新�?`https://ziglang.org/download/index.json`�?*要求厂商公布�?shasum 与固化�?一�?*才继续；不一致直接拒绝安装（防止上游产物被悄悄替换）。下载流式算哈希，先�?`.part` 再改名�?
**实测失败的方案（记录在此，不写在注释里糊过去�?*�?
| 方案 | 实测结果 | 结论 |
|---|---|---|
| `registry.npmmirror.com/-/binary/zig/` | HTTP 404（npmmirror 没有 zig 镜像�?| 不可�?|
| `github.com/ziglang/zig/releases/...` | HTTP 404 | 路径错，应用 ziglang.org `/download/` |
| `registry.npmmirror.com/-/binary/mingw-w64/` | 404 | 不可�?|
| PyPI `ziglang` wheel（清华镜像） | 0.8.0�?.16.0 win_amd64 wheel **存在**（~80�?4 MB，zip 格式�?| **备选方�?*（当 ziglang.org 不可达时可用）；本机最终未采用 |
| `.zip.sha256` / `shasums.txt` 伴随文件 | 404 | 官方只提�?index.json 内的 shasum，故按上面双源校验做 |

**踩过的坑（与工具链有关，写清以免后人重踩�?*�?
1. **PowerShell 不能包裹原生 exe 的管�?*：`node ... | Select-Object`、`node ... > file`
   会报 `Program 'x' failed to run: Access is denied` 或产出空文件。本项目**所有采集一�?   「原生进�?+ 输出重定向到文件 + node 读文件�?*（`tools/lib/exec` 风格或脚本内 `spawnSync`
   �?`stdio: ['ignore', fd, fd]`）�?2. **Zig 缓存目录**必须�?*环境变量**指定（`ZIG_GLOBAL_CACHE_DIR` / `ZIG_LOCAL_CACHE_DIR`）；
   `--cache-dir` 不是 `zig cc` 的合法选项（那�?`zig build` 的）。见 `tools/build-shim.mjs`�?3. **首次交叉编译很慢**（要现场构建自带 mingw libc�?120 s，需转后台），第二次 ~4 s�?4. 官方 zip �?*顶层版本目录**，解包后需上提一层才能得到稳定的 `zig.exe` 路径
   （脚本里做了 hoist）�?
---

## 3. 注入方式

**采用：远�?`LoadLibraryW`（挂起窗口注入）**

```
CreateProcessW(exe, cmdline, ..., CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, env, cwd)
  �?VirtualAllocEx + WriteProcessMemory(DLL 全路�?UTF-16)
  �?CreateRemoteThread(kernel32!LoadLibraryW, remoteMem)
  �?等远程线程结束，�?HMODULE�? �?失败�?  �?ResumeThread(主线�?
```

- 注入发生�?*主线程尚未执行用户代�?*的窗口内；`DllMain` 检测到 `WINSTAGE_STAGE_ROOT` /
  `DSH_REGSTAGE_ROOT` / `WINSTAGE_SHIM_CONFIG` �?*自动初始�?*（远程注入无法调用导出函数，
  所以自动初始化是必需路径；显�?`WinstageShimInit(path)` 供启动器调用）�?- **拒绝的方�?*：`QueueUserAPC(LoadLibraryW)`（早�?APC 不可靠、无控制台进程不投递）�?  改子进程 PE 导入表（改内存镜像、破坏签名假设、攻击面大）；`AppInit_DLLs` / IFEO（写全局注册表，
  正是本项目最不该做的事）�?- 命令行契约：
  `winstage-inject.exe --dll <path> [--set-env K=V]... [--report <json>] [--cwd <dir>] [--timeout-ms N] -- <exe> [args...]`
  退出码：`111` 注入失败、`112` 用法错误、否则转发子进程退出码�?- **目标解析**：`resolve_executable()` �?绝对路径 �?`SearchPathW(name)` �?`SearchPathW(name, ".exe")`
  （`CreateProcessW` 不做 PATHEXT/App Paths 解析；裸 `powershell.exe` 会得�?Win32 2）�?- **argv 引号**：按 MSVCRT 规则重建命令行（反斜杠转义、尾随反斜杠双写）；
  修复�?`node -e "process.stdout.write('X')"` 会变�?"Cannot find module �?�?- 宿主限制：注入方需�?`OpenProcess(PROCESS_ALL_ACCESS|CREATE_THREAD)`
  （同用户、同或更高完整性级别）。低完整性子进程同样可注入（远程线程由创建者发起）�?- **限制（如实）**：只注入**直接子进�?*，不做进程树递归注入；子进程若再 `CreateProcess`�?  它的子进程不受管（见 §9）�?
---

## 4. DLL 公开 ABI�?2 个导出）

**shim 自身�?�?*

| 导出 | 签名/语义 |
|---|---|
| `WinstageShimInit` | `int __cdecl (const wchar_t* configJsonPath)`�?=成功，非 0=Win32 错误码；`NULL` = 只读环境变量；幂�?|
| `WinstageShimShutdown` | `void __cdecl (void)` |
| `WinstageShimAbiVersion` | `uint32_t __cdecl (void)`，当�?1 |
| `WinstageShimBindStageApi` | 采用外部 staging provider（校�?`abi_version`/`struct_size`�?|
| `WinstageShimOriginal` | 诊断：取某个 API �?hook 前的原函数地址 |
| `WinstageShimRefreshHooks` | 重扫所有已加载模块的导入表 |
| `WinstageShimStatsJson` | **存活/生效自检**：UTF-8 JSON（`initialized`/`hooksInstalled`/`stageRoot`/`hooks.iatSites`…） |

**T3 注册表契约（5，`__cdecl`，见 §8�?*：`DshRegStageAbiVersion` / `DshRegStageAttach` /
`DshRegStageDetach` / `DshRegStageJournalAppend` / `DshRegStageAttachState`�?
**环境变量契约**

| 变量 | 含义 |
|---|---|
| `WINSTAGE_STAGE_ROOT` | 文件暂存根（必需；缺�?+ �?config �?`WinstageShimInit` 返回 1610，且**不挂钩子**�?|
| `DSH_REGSTAGE_ROOT` | T3 �?sessionDir（注册表 `registry/` 落在其下）；缺省时用 `WINSTAGE_STAGE_ROOT` |
| `WINSTAGE_REGSTAGE_SESSION_DIR` | 显式指定 sessionDir（优先级最高） |
| `WINSTAGE_SHIM_CONFIG` | config JSON 路径（缺�?`<stageRoot>\winstage-shim.config.json`�?|
| `WINSTAGE_SHIM_LOG` | 日志文件（缺�?`<stageRoot>\shim.log`�?|
| `WINSTAGE_SHIM_DISABLE` | �?"0" �?完全不生效（返回 `ERROR_SERVICE_DISABLED`�?|
| `WINSTAGE_SHIM_VERBOSE` | �?"0" �?逐操作日志（诊断�?|
| `WINSTAGE_SHIM_DISABLE_FILE` / `_REG` | 分族开关（诊断/二分�?|
| `WINSTAGE_SHIM_SKIP=a,b,c` | �?API 不挂钩（二分用） |
| `WINSTAGE_UNSTAGED_WRITES=passthrough` | 无法 stage 时改为调用真�?API�?*默认关闭**，见 §7�?|

配置 JSON（扁平；解析器是扫描式，不支持嵌套对象）�?`{"stageRoot","logPath","failClosed","readThrough","verbose","traceStagedOps","passthrough":[...]}`

---

## 5. 钩子清单与安装机�?
**机制**：扫描所有已加载模块的导入表（PEB �?`InMemoryOrderModuleList`），�?*导入�?*匹配目标�?改写 IAT 槽位（`VirtualProtect` + 还原保护）�?*跳过 shim 自身模块**，且**shim 内部一切调�?使用 init 时捕获的原函数指�?`g_orig.*`**（这一点是 §10 根因 3b 的修复，必须保持）�?
- **运行时解析覆�?*：`GetProcAddress`、`ntdll!LdrGetProcedureAddress` 也是目标 �?  delay-load 助手（它最终走这两个之一）拿到的也是我们的替换函数�?- **后加载模�?*：`LoadLibraryW/A/ExW/ExA` 是目标，包装函数在真实加载返回后重扫所有模块；
  也可�?`WinstageShimRefreshHooks()`�?- **不做延迟导入 IAT 预填�?*：MSVC �?delay-load 助手首次运行时会**覆盖**槽位，预填无效，
  而且会提前加载所�?delay-load DLL（行为改变）。真实覆盖靠上面两条解析路径�?
**目标清单（按名匹配，`WinstageShimStatsJson` 报每项被替换的站点数�?*

- 文件族（15）：`CreateFileW/A`、`CreateDirectoryW/A`、`DeleteFileW/A`、`MoveFileExW/A`�?  `MoveFileW/A`、`RemoveDirectoryW/A`、`CopyFileW/A`、`SetFileAttributesW`
- 注册表族�?2）：`RegCreateKeyExW/A`、`RegCreateKeyW/A`、`RegOpenKeyExW/A`、`RegOpenKeyW/A`�?  `RegSetValueExW/A`、`RegQueryValueExW/A`、`RegDeleteKeyExW/A`、`RegDeleteKeyW/A`�?  `RegDeleteValueW/A`、`RegCloseKey`、`RegFlushKey`、`RegQueryInfoKeyW`、`RegEnumValueW`、`RegEnumKeyExW`
- 控制族（6）：`GetProcAddress`、`LoadLibraryW/A/ExW/ExA`、`LdrGetProcedureAddress`

典型进程实测�?*118�?28 �?IAT 站点 / 10�?9 个模�?*（随目标进程加载�?DLL 数变化）�?
---

## 6. 路径与键映射规则

### 6.1 文件

```
<stageRoot>/
  fs/C/Windows/Temp/x.txt        �?"C:\Windows\Temp\x.txt"（盘符冒号丢弃）
  fs/_unc/server/share/x.txt     �?"\\server\share\x.txt"
  wo/C/Windows/Temp/x.txt        �?删除白障标记（空文件�?  shim.log
```

- **归一�?*：去 `\\?\` / `\\?\UNC\` 前缀、统一 `\`、折叠重复分隔符、去尾分隔符�?  `\\?\GLOBALROOT`、`\\.\`、`\Device\`、`\??\` �?*控制�?伪设备名**
  （`CONOUT$`/`CONIN$`/`CONOUT`/`CONIN`/`CLOCK$`/`NUL`/`CON`/`PRN`/`AUX`/`COM1-9`/`LPT1-9`�?  �?basename 判定）一�?*穿�?*�?- **相对路径**先按进程 CWD 绝对化再判定/暂存（否则相对写会静默落到真实磁盘）�?- **�?*：覆盖层命中 �?用覆盖层；未命中 �?真实路径（`readThrough`）。白�?�?`ERROR_FILE_NOT_FOUND`�?- **�?*：进覆盖层�?*销毁性处�?*（`CREATE_NEW`/`CREATE_ALWAYS`/`TRUNCATE_EXISTING`）直接写覆盖层副本；
  **非销毁性写打开**（`OPEN_EXISTING`/`OPEN_ALWAYS` + 写权限）先做**写时复制（CoW�?*�?  真实文件存在则先复制进覆盖层，再打开覆盖层副本。缺 CoW 会让 `OPEN_ALWAYS` 在覆盖层造出**空文�?*
  （调用方读到�?—�?这是 §10 根因 2 的另一半）�?- `CreateDirectoryW` 对真实已存在目录返回 `ERROR_ALREADY_EXISTS`（与真实 API 一致）�?- `DeleteFileW`/`RemoveDirectoryW`：删覆盖层副�?+ 写白障；真实独有对象按真实语义检�?  （目录非空返�?`ERROR_DIR_NOT_EMPTY`）�?- `MoveFileExW`：源在覆盖层 �?覆盖层内改名；源仅真实存�?�?复制进覆盖层 + 给源写白障�?- **目录枚举不合�?*（`FindFirstFile` �?hook）：覆盖层目录是整体替换视图�?*已知限制**�?
### 6.2 注册表（T3 契约，方�?A�?
- **存储**：`<sessionDir>/registry/overlay.hive`（`RegLoadAppKeyW` 加载�?app hive�?  + `<sessionDir>/registry/overlay.journal`（WAL）�?*没有第二份存�?*（旧的自�?`values.wsv` 已删除）�?- **句柄**：给调用方的�?*伪句�?*（显式存活表�?*查表判定**，绝不按数值猜�?—�?预定�?  `HKEY_*` 常量数值上比任�?小指针阈�?都大，按阈值判定会解引�?0x80000001 而崩）�?  伪句�?*永不**传给真实 API（否则内核看到堆指针 �?`ERROR_INVALID_HANDLE(6)`，这正是
  `reg add` 的失败形态之一）；需要真实键时按**规范路径**重新打开�?- **路径**：规范真实路径的**�?hive �?*形式，恒等映射进 app hive�?  `HKEY_CURRENT_USER\Software\X` �?`HKCU\Software\X`。长�?短名必须归一到同一字符�?  （否则同一位置两种写法互不相等 �?覆盖层永远查不中）�?- **净变化原则**：真�?hive **已存�?*的键，`RegCreateKeyExW`/`RegOpenKeyExW` **不产生覆盖层条目、不�?WAL**
  （只返回真实句柄）；只有真实不存在的键才延迟建。容器链**排除�?hive �?*，且真实已存在的层级
  �?*不写 `CREATE_KEY`**（否�?`HKCU\Software` 这类中间层会灌爆候选队列）�?- **WAL-first**：每次变更先 `WriteFile` + `FlushFileBuffers`（`LockFileEx` 跨进程串行）�?  **成功后才**�?app hive；追加失�?�?调用失败（绝不静默成功）�?- **�?*：覆盖层命中 �?覆盖层；未命�?�?真实 hive（受限令牌下真实读是允许的）�?  覆盖层独有的伪句柄未命中 �?�?*路径**读真�?hive，或 `ERROR_FILE_NOT_FOUND`�?- **枚举**�?*必须合并**（`overlay �?real`，同名覆盖层优先，白障剔除，名字大小写不敏感稳定排序）�?  T3 旧契约的"v1 不合�?已作�?—�?实测证明空壳键会�?`HKCU\Software` 下真实子键全部消失，
  PowerShell 因此崩在 `InitialSessionState`。为性能加了**单条缓存 + 世代计数**（每次写操作递增作废）�?- **�?API 的失败语�?*：无法解�?裸根/`HKPD`/WOW64 �?**穿透真�?API**（拒绝读会打�?CLR）�?- **WOW64**：本 DLL �?x64，在 x64 进程�?`KEY_WOW64_64KEY` �?*无操�?*（CLR �?`reg.exe` 都会传它），
  因此按无标志处理；只�?`KEY_WOW64_32KEY`（或 WOW64 进程里的 64KEY）才�?app hive 没有 32 位视�?�?  把它当硬拒曾导致 CLR `0x80070005`�?- **A/W 变体**：`RegQueryValueExA`/`RegSetValueExA` **不得**转发�?W 版本 —�?  ANSI 调用方要的是 ANSI 数据（`REG_SZ`/`REG_EXPAND_SZ`/`REG_MULTI_SZ` 双向转换，二进制原样）�?  �?A �?W 曾让 Winsock 目录读取拿到 UTF-16/`ERROR_MORE_DATA(234)` �?node `WSAStartup 10107`�?- **app hive 访问�?*：`WS_APPKEY_SAM = KEY_READ | KEY_WRITE`（实�?`KEY_ALL_ACCESS` 亦可�?  但不需要更大权限；`winstage-probe.exe appkey` �?*不注�?*跑的行为探针，可复现）�?
---

## 7. fail-closed 语义

| 情形 | 行为 |
|---|---|
| shim 未初始化 / `WINSTAGE_SHIM_DISABLE` | **不挂钩子，裸�?*（因此启动器必须先做真可用性探测：`winstage-probe.exe selftest`�?|
| 已初始化，写无法暂存（provider 拒绝、暂存路径不可建、WAL 追加失败�?| **失败**（`ERROR_ACCESS_DENIED` �?provider �?LSTATUS），**不回落真实系�?*；同时写一�?`HARD_DENY` WAL 记录（可审计�?|
| 硬拒清单（T3 §8）：`HKPD`、WOW64_32KEY、`REG_OPTION_CREATE_LINK/BACKUP_RESTORE/OPEN_LINK`�?`REG_LINK`/`REG_RESOURCE_LIST`/`REG_FULL_RESOURCE_DESCRIPTOR`/`REG_RESOURCE_REQUIREMENTS_LIST`�?无法解析的句�?| 返回 `ERROR_ACCESS_DENIED(5)` + `HARD_DENY` 记录 |
| 删除有子键的�?| `ERROR_KEY_HAS_CHILDREN(1020)`�?*�?*替调用方删子�?|
| 删�?设值但键不存在 | `ERROR_FILE_NOT_FOUND(2)` |
| 读路径无法服�?| **穿�?*真实 API（读不是泄漏面；拒绝读会破坏运行时） |
| 注入失败 | 注入�?exit 111 + `--report` JSON |

**`WINSTAGE_UNSTAGED_WRITES=passthrough`**：把"写无�?stage"�?fail-closed 改成真实 API 穿透�?默认**关闭**：开启即意味着真实系统会被写入，我不愿意把隔离保证换成"看起来能�?。需�?liveness
优先时由宿主显式打开�?
---

## 8. �?T3 契约对齐状态（方案 A�?
**已实�?*：`DshRegStageAbiVersion/Attach/Detach/JournalAppend/AttachState` 导出�?`<sessionDir>/registry/overlay.hive|overlay.journal`；`#pragma pack(4)` 32 字节定长�?（`magic 'DSRG'`/`version=1`/`kind`/`type`/`flags`/`pathChars`/`nameChars`/`dataBytes`/`status`/`reserved=0�?+ 变长负载 `path �?valueName �?data`；`view=WAL-first`（`LockFileEx` + `FlushFileBuffers`）；
`kind 1..5`；`flags HARD_DENY/HAS_VALUE_NAME/HAS_DATA/VOLATILE`；`DshRegStageAttach` 幂等
（同 sessionDir 重复 attach 不二�?`RegLoadAppKeyW`）�?
**实测证据**：宿主侧�?T3 �?`decodeJournalRecords` 解算 shim 写出�?journal�?`E3.journal-has-set-value` 断言 `path/name/type/wireBytes`；`E9` �?`createRegistryStage()`
`open→diff→freezeCandidate` 产出**入队候�?*（两条变更：新建子键 + 新增值）�?
**未做/待对齐（如实�?*�?
1. shim �?*不解析自己写过的 journal**（没有实�?T3 �?`replayJournal`）⇒ **注册表白�?   （`DELETE_KEY`/`DELETE_VALUE`）只在进程内 tombstones 里生效，跨进�?重启不持�?*�?   宿主侧不受影响（WAL 里有 `DELETE_*` 记录，宿�?`replayJournal` 能算对）�?2. `DshRegStageAttachState` �?T3 给的 32 字节结构实现，但**T3 声明该结构未验证**�?3. `apply()` / `discard()` 是宿主侧（T3）职责，本轮未验证；shim 只负�?写成�?+ 留下 WAL"�?4. `RegQueryInfoKeyW` 合并视图�?`lpcbMaxValueLen` 按需查询两侧（覆盖层已存在的键才走合并）�?   未做"每值精确枚举长�?的缓存优化�?
---

## 9. 尚未覆盖�?API 与已知绕过（如实，不夸大�?
**未覆盖的 API**

- 文件：`CopyFile2`、`MoveFileWithProgressW`、`ReplaceFile`、`SetFileInformationByHandle`�?  `WriteFile`（句柄已开的情况不受影响）、`FindFirstFileW/FindNextFileW`�?*枚举不合�?*）�?  `GetFileAttributesW/SetFileTime`（只 hook �?`SetFileAttributesW`）、`CreateFile2`�?  `NtCreateFile`/`Zw*`�?*直接�?ntdll 的路径完全不受管**）、`\\?\GLOBALROOT\Device\...`�?- 注册表：`RegSetKeySecurity`（且 app hive 禁止）、`RegLoadKey/UnLoadKey/SaveKey/RestoreKey/ReplaceKey`�?  `RegRenameKey`、`RegCopyTree`、`RegConnectRegistry*`、`RegOverridePredefKey`�?  `RegOpenCurrentUser`、`RegOpenUserClassesRoot`、`RegCreateKeyTransacted*`�?  `RegQueryMultipleValues`、`RegSaveKeyEx`、`NtSetValueKey`/`NtCreateKey` 等原�?API�?- 进程/加载器：`NtCreateProcess`、`CreateProcessAsUser`（未 hook）、映射文件的写（`MapViewOfFile`）�?  其它进程代写、内核驱动、服�?COM 代理�?
**已知绕过（黑名单性质，改形状即可绕过�?*

1. **未注入的进程**：进程树里被跳过的子进程、计划任�?服务/COM 激活的进程�?   它们对真实系统的读写完全不受管�?2. **直接系统调用**：`ntdll!Nt*`/`Zw*`、手�?`syscall` 桩，绕过全部用户�?hook�?3. **重命�?换形�?*：把敏感路径换成 junction/symlink 指向（文件侧未做 `realpath` 归一�?   仅做�?`\\?\` 前缀与分隔符归一）→ **可以绕过**；改�?换扩展名同理�?4. **文件枚举与真实目录的合并**：覆盖层目录整体替换视图（不合并），依赖枚举的程序会看到差异�?5. **注册表白障不跨进�?*（�?）�?6. **`WINSTAGE_UNSTAGED_WRITES=passthrough`** 打开时，无法 stage 的写会落到真实系统�?7. **shim 未生�?= 裸跑**：启动器必须先做真可用性探测（`winstage-probe selftest` /
   `WinstageShimStatsJson`），失败必须回退到受限令牌模式，绝不裸跑�?8. `WinstageShimInit` 失败时（�?stageRoot/无法建目录）**不挂钩子** —�?这时是裸跑，
   不是 fail-closed；探测是唯一防线�?
---

## 10. 三个真实根因与定位方法（实测记录�?
载体门（cmd/node/powershell 注入后能起来）曾经不过，根因**都不�?钩子太多"**，而是三个具体语义错�?定位手段�?`WINSTAGE_SHIM_SKIP` �?API 二分 + 贪心最小化（`tools/minimize-hooks.mjs`�?0 次运行）�?以及一�?*不注�?*�?app hive 行为探针�?
| # | 症状 | 根因 | 最小失败集 | 修复 |
|---|---|---|---|---|
| 1 | `node` �?`WSAStartup 10107` | `RegQueryValueExA` 被转发到 W 版本 �?ANSI 调用方拿�?UTF-16 / `ERROR_MORE_DATA(234)` | **`{RegQueryValueExA}` 单个 API** | A 变体独立实现（名字与字符串数据双向转换），无法服务时用真 A 版穿�?|
| 2 | `powershell` �?`InitialSessionState` / `0x80131623` | `CONOUT$` 未识别为控制台设�?�?控制台写�?stage，`CopyFileW("CONOUT$")` 失败 �?fail-closed；另一半是缺少**写时复制**（`OPEN_ALWAYS` 在覆盖层造空文件�?| **`{CreateFileW}`** | 设备名判�?+ 相对路径绝对�?+ CoW |
| 3a | `reg add` �?`ERROR_ACCESS_DENIED` | 容器链含�?hive 根；app hive 建键�?`KEY_ALL_ACCESS` | �?| `build_chain` 排除裸根；`WS_APPKEY_SAM=KEY_READ|KEY_WRITE`；真实已存在层级不写 `CREATE_KEY` |
| 3b | `reg add` �?同上（关键） | **shim 自己的内部注册表调用被自己的钩子拦了**：对 app hive 根句柄调 `RegCreateKeyExW`，该句柄既非预定义根、`NtQueryKey` 也认不出 �?解析失败 �?硬拒 | �?| **内部 staging 一律用 init 捕获�?`g_orig.Reg*`�?0 处）** |
| 4 | `reg add` �?`ERROR_INVALID_HANDLE(6)` | 延迟物化�?*伪句�?*在后�?`RegQueryValueExW`/`RegEnum*` �?穿�?给了真实 API（覆盖层还没建该键） | �?| **伪句柄永不穿�?*：按规范路径服务或按路径打开真实�?|

**教训（写进流程）**�?
- IAT 站点数（"覆盖 328 �?�?*不能**证明每个调用点都换掉了，更不能证明语义正确；
  必须�?API 计数 + �?API 二分（`WinstageShimStatsJson` 已报每项命中数）�?- "查询成功但没有内�?必须算失败（`E5` 现在要求 `type`/`data`；`E6` 是负例）�?- 变异体自证：`E7` �?WAL 位置换成目录，要�?`reg add` 必须失败且真�?hive 不变 —�?  防止"检查的是别的东�?造成的假绿�?
---

## 11. 验收：怎么复跑

```powershell
node tools\fetch-toolchain.mjs          # 幂等；已装则秒回�?-force 重装
node tools\build-shim.mjs               # 编译 3 个产�?+ 自研 PE 导出校验（缺失即失败�?node tools\build-shim.mjs --clean       # 清理后重�?node tools\smoke-inject.mjs             # 载体门：cmd / node / node -e / powershell ×2
node tools\run-shim-closedloop.mjs      # 30 项端到端（含宿主候选、负例、变异体�?node tools\triage-families.mjs          # A/B/C/D 分族矩阵
node tools\minimize-hooks.mjs --target node --base reg   # �?API 贪心最小化
node tools\pe-exports.mjs shim\out\winstage-shim.dll --require WinstageShimInit,DshRegStageAttach
shim\out\winstage-probe.exe appkey <dir> <out.json>      # 不注入：app hive 行为实测
```

最近一次结果（本机�?026-09-30）：`run-shim-closedloop.mjs` **30/30 PASS**�?`smoke-inject.mjs` **5/5 PASS**，`fetch-toolchain` �?`build-shim` 可重复成功（0 warning）�?
---

## 12. 已知限制与后�?
1. 目录枚举不合并（§6.1）；文件侧未�?symlink/junction 归一（可绕过，�?）�?2. 注册表白障不跨进程（§8）�?3. 只注入直接子进程，不做进程树覆盖�?4. `overlay.hive` �?ACL：本机继�?DACL 可用；若目标目录 DACL 只读，`RegLoadAppKeyW` 会加载成�?   �?hive 内建键被拒（脚本已内置尽力而为�?DACL 归一，但**在文件尚不存在时无效�?*—�?   首次 attach �?`RegLoadAppKeyW` 创建文件，顺序上应在加载后重试归一）�?5. 未实�?inline hook（trampoline）：如果将来需要覆�?完全不经�?IAT/GetProcAddress"的调用点�?   这是唯一可靠做法（代价：x64 长度反汇�?+ 并发保护）�?6. `--profile=file-only` 独立最�?DLL 未产出；等价二分已由 `WINSTAGE_SHIM_DISABLE_FILE/_REG`
   �?`WINSTAGE_SHIM_SKIP` 覆盖（`tools/triage-families.mjs`）�?