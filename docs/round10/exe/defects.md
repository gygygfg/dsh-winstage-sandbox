# 域三（exe 安装完整性与沙箱隔离）缺陷台账

> 维护者：teammate `exe`。每条都有原始证据；未复现的写 `not-run`，不猜测。
> 严重度：高 / 中 / 低 / 信息。Phase 1 结论见 `报告.md`。

## D-EXE-1（低）`tools/pe-exports.mjs --require` 把"要求的导出名"当成输入文件 ⇒ 文档化的完整性门永远报失败（fail-closed 假阴性）

- **发现阶段**：Phase 0（宿主，只读）
- **证据**：`docs/round10/exe/evidence/02-pe-integrity-raw.txt`
- **原始输出**（逐字）：

```text
== cmd: node tools/pe-exports.mjs shim\out\winstage-shim.dll --require WinstageShimInit,DshRegStageAttach
exitCode=1
== shim\out\winstage-shim.dll
   machine=x86_64 is64=true isDll=true sections=[.text,.rdata,.buildid,.data,.pdata,.tls,.reloc]
   exports(15): DshRegStageAbiVersion, DshRegStageAttach, ..., WinstageShimInit, ...
node.exe : parse failed: ENOENT: no such file or directory, open 'C:\Users\Administrator\Desktop\dsh-winstage-sandbox\WinstageShimInit,DshRegStageAttach'
```

- **机制**（`tools/pe-exports.mjs:113-122`）：`const files = args.filter((a) => !a.startsWith('--'))` 把 `--require` 的**取值**也算进 `files`；该取值不以 `--` 开头 ⇒ 被当作待解析的 PE 文件 ⇒ `ENOENT` ⇒ `failed=true` ⇒ `exit 1`。
  文档 `docs/T4-shim设计.md:203` 恰恰以 `--require WinstageShimInit,DshRegStageAttach` 的形式给出用法。
- **影响**：导出符号齐全时该命令**也返回 1**。属 **fail-closed 假阴性**（不会误判为"完整"），但文档里那条"必需导出"门**不可用**；用于 CI/门禁会得到恒定失败信号，进而可能被忽略/绕过。
- **本轮处置**：改用列表模式（`--json`）取全量导出名后自行判集合包含（`WinstageShimInit` / `DshRegStageAttach` 均在 15 个导出中）。
- **修复建议**（未实施；本任务禁止改仓库代码）：解析时先剥离 `--require` 及其取值。

## D-EXE-2（中·信息）宿主存在**两条既有 WinStage 计划任务**，其中一条 Enabled/Ready，且都指向**已删除的旧根**

- **发现阶段**：Phase 0（宿主，只读）
- **证据**：`docs/round10/exe/evidence/03-host-preexisting-winstage-residue.md`
- **原始输出**（`schtasks /query /tn <t> /v /fo LIST` 摘录）：

```text
TaskName: \WinStageSandbox-Keeper   Status: Disabled   Last Run Time: 2026/9/29 21:18:01   Last Result: -1073741510
Task To Run: C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\watchdog-task.cmd
TaskName: \WinStageSandbox-sbx3     Status: Ready      Last Run Time: 2026/9/29 0:24:34    Last Result: -2147023829
Scheduled Task State: Enabled
Task To Run: C:\Users\Administrator\Desktop\WinStageSandbox\.t\sbx3\sbx3-task.cmd
```

- **事实**：旧根已按交接单 §1 彻底删除，但两条任务仍注册在宿主；`sbx3` 为 Enabled/Ready。
- **为什么记**：本域要求"宿主侧零残留"。它们不是本轮产物，但是判定的**基线前提**（判定规则已在 Phase 0 事前写死）；也说明历史会话确实在宿主计划任务留过痕。
- **本轮处置**：只作基线扣除，**不删除**（不在授权范围，且不可逆）。
- **附带**：`HKCU:\Software\WinstageOpenq0731wq4`（`P=z`）存在（复现既有报告 §8 c2）。

## D-EXE-3（高）Defender 隔离 `winstage-inject.exe` ⇒ 嵌套沙箱**静默降级为 tier=T1（artifact-missing）**，写入语义整体改变

- **发现阶段**：Phase 1（run-1）
- **证据**：`docs/round10/exe/evidence/06-defender-quarantine-and-t1-fallback.md`
- **原始事实**：
  - Defender 事件 1116/1117（22:31:11 / 22:31:26 / 22:31:33）：`Trojan:Win32/Bearfoos.B!ml`，Path = `…\shim\out\winstage-inject.exe`，Action = **隔离**（ThreatID 2147731849）。
  - 该 run 的 `sandbox-lane.json`：`launchMode=restricted-token`、`tierEffective=T1`、`degraded=true`、`fallbackClass=artifact-missing`、`fallbackReason="transparent shim unavailable (not found: …\shim\out\winstage-inject.exe)"`、`shimCount=0`、`degradeCount=6`。
- **影响（为什么要记成"高"）**：
  1. **语义整体改变**：TS 下越界写是"**重定向进暂存**"（隔离且可审批）；T1 下是"**内核硬拒 EPERM**"（隔离但工作流直接失败）。两者用同一句"沙箱已启用"会被读成同一件事。
  2. **静默**：命令仍能跑、agent 仍能写自己的暂存区，唯一显式信号只落在 `sandbox-lane.json`（`degraded=true`）；在没有专门看这个文件的会话里，使用者不会知道垫片没启用。
  3. **复发**：Lead 记录同一威胁在 10-03 / 10-04 / 10-06 于旧根复发；根因是 Defender `ExclusionPath` 仍指向**已删除的旧根**（迁移遗留）。
- **本轮处置**：判定 run-1 **作废**（依 Lead 纪律），并在每轮 run 里记录 `winstage-inject.exe` 存在性与 `winstage-shim.dll` sha256；22:52 后重跑（run-3/run-4 均 `tier=TS / degraded=false`）。
- **建议**：把"垫片产物缺失 ⇒ 降级"在**命令结果/UI 层**显形（而不是只写 `sandbox-lane.json`），并把排除项改成跟随仓库根解析而非硬编码路径。

## D-EXE-4（高）tier=TS 下**第三方便携 exe 崩溃 `0xC0000005`**（`7zr.exe` 5/5）

- **发现阶段**：Phase 1（run-3 主证据 + run-4 独立复现）
- **证据**：`docs/round10/exe/evidence/07-probe-summaries.md` §A/§C；`docs/round10/exe/evidence/threads/run-4-min/.../probe-result-portable-min.json`
- **原始读数**：

```text
run-3 (TS, shim)          : 7zr i -> exit=3221225477 (0xC0000005) ; 7zr a -> 同 ; 7zr t -> 同 ; 归档未生成
run-4 (TS, 第二次会话)    : 7zr i -> 0xC0000005 ; 7zr i -> 0xC0000005
run-1 (T1, 无垫片)        : 7zr i/a/t -> exit=0
run-2 (平台, 无沙箱)      : 7zr i/a/t -> exit=0 ; selftest.7z 159 B 生成
同 run-3: node --version exit=0 ; 7z2604-x64.exe /S exit=0
```

- **侧证**（`shim.log`）：每个 7zr PID 都有 `child injection armed ok=1` + `hooks installed: 319 IAT sites across 28 modules`，随后**无 shutdown 记录即截断**。
- **判别性**：同一二进制、同一参数、同一 fd 重定向写法；**垫片开 ⇒ 崩，垫片关 ⇒ 正常**；同 run 内 node 与 7-Zip 安装器都不崩。
- **影响**：**"便携 exe 在沙箱内可运行"不成立**（默认获胜档位就是 TS）。任何以"解包即用"方式在沙箱内跑第三方 exe 的工作流都不可靠；同时使本域的"运行完整性"判定为**不成立**。
- **未做（如实标注）**：根因未定位到代码级；未做 dump / 最小化复现（换纯控制台 exe）。

## D-EXE-5（中·设计边界）`requireAdministrator` 安装器在沙箱内**连创建都做不到**（`EACCES`）

- **发现阶段**：Phase 1（run-1，T1）
- **证据**：`evidence/06` §C（静态 manifest）+ `evidence/07` §D（动态）
- **原始读数**：
  - 静态：`7z2604-x64.exe` → `["requireAdministrator","requestedExecutionLevel","uiAccess"]`；`7zr.exe` → `["asInvoker",…]`。
  - 动态（T1）：`spawnSync(... 7z2604-x64.exe /S /D=…)` → `error=EACCES`（CreateProcess 层失败，日志文件只有命令行头、无任何子进程输出）。
- **影响**：需要提权的安装器（大量商业安装器）**无法在沙箱内运行/安装/被评估**。这不是越权，而是"这类任务在本沙箱下不可达"，**必须在文档里显式声明**，否则会被误读成"测试没做"或"隔离把安装挡住了"（本轮实测：TS 档下同一个安装器**能**跑，因为 TS 去令牌化）。
- **建议**：能力清单里加一条"需要 `requireAdministrator` 的载体：T1 不可用；TS 可用（其写入进暂存）"。

## D-EXE-6（中）读侧不一致：外部目录的 `readdir` 只返回暂存 overlay，`stat` 却按真实盘返回 ⇒ 沙箱内程序会误判目录内容

- **发现阶段**：Phase 1（run-3）
- **证据**：`evidence/07` §A（`installer-D` / `installer-default` 两条）
- **原始读数**：

```text
post.pf7z      = {"exists":false,"code":"ENOENT"}          # fs.statSync('C:\Program Files\7-Zip')
post.pf7zListing = {"ok":true,"entries":[7-zip.chm,7z.dll,7zFM.exe,Uninstall.exe,Lang,…]}  # readdirSync 同一路径
post.pfListing   = {"ok":true,"entries":["winstage-round10.txt"]}   # readdirSync('C:\Program Files') 只剩暂存那一项
```

- **影响**：真实 `C:\Program Files` 有 25 个顶层项，沙箱内 `readdir` 只看到 1 项（暂存新增）。任何"先列目录再决定"的程序（安装器、卸载器、构建工具）在沙箱内会得到**结构性错误的世界图景**；`stat` 与 `readdir` 自相矛盾也会让"存在性判断"不可靠。
- **建议**：读侧 overlay 要么完全 readThrough（合并真实内容 + 暂存），要么明确 fail-closed 报错，不要"半合并"。

## D-EXE-7（低）`msiexec /a` 必然 1601（服务端 `0x80070005`），并在服务端留下 1 个瞬时 `msiexec.exe /V`

- **发现阶段**：Phase 1（run-3）
- **证据**：`evidence/07` §A（`installer-msi`）+ `evidence/08` §3
- **原始读数**：`exit=1601`；日志 `连接到服务器失败。错误: 0x80070005` / `Failed to connect to server.` / `MainEngineThread is returning 1601`；宿主侧 23:02:26Z 抓到 `msiexec.exe /V`（PID 12016，父 `services.exe`，起始 23:00:06），23:1x 已自行退出。
- **影响**：MSI 通道在沙箱内不可用（与既有报告一致）；瞬时残留进程会被"零残留"检查抓到，需要在判定时排除/等待。

## D-EXE-8（信息）T1 档下 `tasklist` 返回 `Access denied` ⇒ **沙箱内无法自查残留进程**

- **证据**：`evidence/07` §D（`tasklist: exit=1`，日志 `ERROR: Access denied`）；同命令在 TS 档 `exit=0`（`evidence/07` §A `surface`）。
- **影响**：T1 档下"无残留进程"只能由宿主侧证明；沙箱内的自检不可用。

## D-EXE-9（低）注册表暂存共享 hive 不可用 ⇒ 每进程独立 hive；且 `review.json` 的 `registry` 计数为 0

- **证据**：`shim.log`：`DshRegStageAttach: shared hive unusable (32) -> per-process hive=…\registry\overlay.<pid>.hive`；stage root 下同时存在 `overlay.hive` / `overlay.2176.hive` / `overlay.9288.hive`；`sandbox-audit.json` 记 `registryWritten=41`，而 `review.json` 的 `counts.registry=0`。
- **影响**：注册表改动被分散到多个 hive，且**没有**作为候选计数进入审批视图（`registry=0`）⇒ 审批面板看不到注册表通道的改动量。本轮未深挖是否"未捕获"还是"未计数"（`not-run`）。

## D-EXE-10（低·命名）`sandbox-audit.json` 的 `filesWrittenOutside=295` 极易被误读为"写到了宿主"

- **证据**：`evidence/09` §4：`{"filesWrittenOutside":295,"filesWrittenInWorkspace":0,"registryWritten":41}`，而宿主侧同一批真实路径**全部为 False**（`evidence/08` §1/§2）。
- **事实**：这里的 "outside" 指"工作区外"（已进 `staged\fs\C\...` 暂存），不是"宿主真实盘"。
- **影响**：只看审计汇总会得出**与本轮相反**的结论（"295 个文件写到宿主了"）。
- **建议**：字段改名或加 `staged:true` / `materialized:false` 标注。

---

## 既有残留基线（非缺陷，判定时必须扣除）

`\WinStageSandbox-Keeper`(Disabled)、`\WinStageSandbox-sbx3`(Enabled/Ready)、`HKCU\Software\WinstageOpenq0731wq4`、`HKLM/HKCU\SOFTWARE\7-Zip` + `Uninstall\7-Zip`(24.09)、`C:\Windows\Temp\winstage-r2-escape.txt`、`C:\Windows\Temp\winstage-r2-toolwrite.txt`、`C:\ProgramData\winstage-r2-fs02-programdata.txt`、`%APPDATA%\Microsoft\Windows\Recent\{dsh-winstage-sandbox,WinStageSandbox}.lnk`、`%LOCALAPPDATA%\Temp\winstage-stage\**`、`%LOCALAPPDATA%\pnpm\store\…\dsh-winstage-sandbox\**`。
