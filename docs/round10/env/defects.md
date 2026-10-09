# R10-ENV 缺陷与观察清单

> 生成：2026-10-08，env-harness（task-1）
> 约束：本域**只写** `docs/round10/env/**`、`.t/round10/env/**` 与新建的 `profiles/sbx/**`；
> 仓库代码（`src/`、`dsh-plugin/`、`shim/`、`tests/`、`tools/`）**未改一行**。
> 每条都带最小复现与原始证据路径；建议补丁只描述，不实施。

---

## D1【阻断级】默认暂存根是常量 `dsh-host`，机器上第二个 WinStage 宿主必然 fail-closed

**现象**：新起的带沙箱线程里 `winstage-fs` 不激活，`tool-fs` 永远 `pending (waiting for service: fs)`
⇒ 线程**没有文件工具**；`stderr.txt` 里只有一句 `dsh: warning: 5 entries did not activate`，
进程仍以 **exit 0** 结束。

**最小复现**

```cmd
set WINSTAGE_SHELL=1
dsh sbx --json "reply OK"     :: 不设 WINSTAGE_STAGE_ROOT
```

`stderr`（逐字节见 `evidence/run1/stderr.txt`）：

```
winstage-fs (dsh-winstage-sandbox/fs): StageGuardUnavailableError: the protected session directory
 could not be established (sentinel-held-by-live-guard: ... "The process cannot access the file
 'C:\Users\Administrator\AppData\Local\Temp\winstage-stage\dsh-host\.winstage-guard' because it is
 being used by another process.")
```

**根因链（实测）**

1. `dsh-plugin/review-service.mjs:229` `DEFAULT_REVIEW_SESSION_ID = 'dsh-host'`：拿不到会话身份时
   暂存键退化成**常量**。
2. `src/stage-guard.mjs:201-205` 缓存基 = `%LOCALAPPDATA%\Temp\winstage-stage`，
   根 = `<缓存基>\<会话键>` ⇒ `...\winstage-stage\dsh-host`。
3. `src/store.mjs:229-232`：根在缓存面内 ⇒ 自动 `acquireStageGuard()`。
4. 正在跑的 3080 宿主（**PID 7812**）早在 21:17 就建了该根，守护进程 powershell **PID 9284**
   仍以 `FILE_SHARE_READ` 持有 `.winstage-guard`。
5. 第二个宿主覆盖哨兵失败 ⇒ `StageGuardUnavailableError`（fail-closed，**这里是对的**），
   但结果是整个线程没有 `fs` 服务。

**证据**：`evidence/run1/stderr.txt`；`evidence/run1/stage-base-before.txt`（运行前 `dsh-host` 已存在）；
`%LOCALAPPDATA%\Temp\winstage-stage\dsh-host\.winstage-owner.json`
（`"keeperPid":9284,"parentPid":7812`）与 `.winstage-keeper.error`（同一条异常）。

**影响面**：只要 3080 宿主活着，**任何**没有会话身份的 WinStage 宿主（含本轮的 `sbx` 嵌套线程）
都无法装载 `winstage-fs`。本轮所有域都受此约束。

**建议补丁（未实施）**：把常量键换成进程唯一键，例如
`DEFAULT_REVIEW_SESSION_ID = 'dsh-host'` → `'dsh-host-' + process.pid`
（或在 `resolveReviewStoreDir()` 里对"无会话身份"分支追加 `process.pid`）。
保留 `'dsh-host'` 作为**显式**共享存储的键（自测/CLI 仍可传）。改动一处即可，风险面小。

**本轮绕行（配方默认）**：`WINSTAGE_STAGE_ROOT=<outDir>\stage-root-<rand>`
（`src/stage-guard.mjs:214-217` 是官方逃生口）。

---

## D2【高】沙箱未装载时线程"一切正常"且会写真实盘

**现象**：run1 里 `winstage-fs` 未激活、`fs-sandbox` 又被本 bundle 置 `disabled: true`
⇒ **没有任何 `fs` 提供方**；同时 `WINSTAGE_SHELL=0` 让平台 `pwsh-sandbox` 接管 shell。
结果：agent 的 `pwsh` 调用**直接写进真实工作区**（`<repo>\fs-tool.txt`、`<repo>\pwsh-tool.txt`，
实测 18 B / 22 B），而进程 exit 0、模型侧看不到任何沙箱相关错误。

**证据**：`evidence/run1/stdout.ndjson`（4 次 pwsh 调用 + `"cwd":"C:\\...\\dsh-winstage-sandbox"`）；
`evidence/run1/stderr.txt`（只有 warning 级）。

> 说明：run1 触发了两次"静默降级"——`dsh-host` 撞根（D1）使 fs 面消失，
> 调用者进程的 `WINSTAGE_SHELL=0` 被继承使 shell 面交还平台（§5.3）。
> 两者叠加后，"开着沙箱"的线程对真实盘做了无限定的写，而唯一的信号是一行 stderr warning。

**建议补丁（未实施）**：`winstage-fs` 激活失败时不要只留 warning —— 让加载失败升级为
error 且让 headless app 以非零退出码结束（"没有 fs 服务的 DSH 不是一个可用的 DSH"）。
若不愿改 loader 语义，至少在 `dsh-plugin` 里注册一个"fs 未提供"的显式诊断并在首轮 tool 调用前拒绝。

---

## D3【中】`pwd` / `Get-Location` 泄漏暂存树真实路径（透明性缺口）

**现象**：run2（沙箱已正确生效）里让模型跑 `(Get-Location).Path`，返回

```
CWD=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\docs\round10\env\evidence\run2\stage-root-14627293213701\staged
```

即**暂存树的绝对路径**。而 `manifest.json.workspaceRoot` 写的是真实工作区 `...\.t\round10\env\ws1`。
模型只要 `pwd` 一次就能确认自己在沙箱里，也能拿到内部存储根的路径。

**证据**：`evidence/run2/stdout.ndjson`（`"type":"final"`）；`evidence/run2/stage-root-meta.txt`。

**建议补丁（未实施）**：shell 面在 `pwd`/`Get-Location`/`$PWD` 上做投影（把 cwd 表现成
`effectiveWorkspaceRoot()`），或在 shim 层替换返回值。注意 `stage-guard.mjs` 的
"模型可见文案"透明性约束（`FORBIDDEN_MODEL_TEXT`）目前只覆盖 error message，**不覆盖命令输出**。

---

## D4【中】`WINSTAGE_SHELL=0` 只关 shell 面，fs 面仍在暂存（两个面不同步）

**实测（run3 对照）**：`WINSTAGE_SHELL=0` + profile `enabled: true` 时：

* `write` 工具 → **仍进暂存**（`blobs\01\01c42434795d...` = `fs-tool-content-OK\n` 的内容哈希）；
* `pwsh` 工具 → **真实盘**（`ws3\pwsh-tool.txt` 22 B，`CWD=...\ws3`）。

也就是说"关掉 shell 沙箱"并不等于"关掉沙箱"：同一个线程里文件面与命令面行为相反。
调用方若只看 `WINSTAGE_SHELL=0` 就以为"完全退回平台"，会误判。

**证据**：`evidence/run3-control-platform/workspace-inventory.txt`（真实盘 2 个文件）、
`.../stage-root-inventory.txt`（blobs 里有 fs 工具的内容）、`.../stdout.ndjson`。

**建议补丁（未实施）**：`WINSTAGE_SHELL=0` 语义保持不变（作者注释里写了 fs 面刻意运行期现读开关、
且 shell 面热切换崩过宿主），但应在 `/winstage status` 与文档里把**两个面**分别报出来。
本域已在 `00-启动配方.md` §5 如实标注。

---

## D5【工具】守护"退出即清根"让默认布局无法事后取证

**现象**：默认（缓存内）暂存根由 keeper 在宿主退出时 `Remove-Item -Recurse` 清掉
（`src/stage-guard.mjs` KEEPER_SCRIPT `finally`），于是"宿主侧核对 staged/blobs/candidates"
在进程结束后**不可能**做到；只能
(a) 宿主机活着时实时取清单，或
(b) 用 `WINSTAGE_STAGE_ROOT` 把根钉到缓存基之外（不挂守护，根留存）。

**证据**：run1 的 v0 脚本用 robocopy 实时镜像，一次跑出 **3.46 GB / 4556 文件**；
且因 stop 文件未生成导致镜像 cmd 变孤儿，删目录时被它反复重建。

**建议（未实施）**：给守护加一个显式逃生口，例如 `WINSTAGE_KEEP_STAGE=1`
（只跳过 `finally` 里的删除，其余不变），让取证不必依赖实时拷贝。

---

## D6【脚本坑】`dsh` 是 `.cmd` shim，批处理里必须 `call`

**现象**：run1 的 v0 脚本里写 `dsh ...`，脚本在 dsh 结束处**直接终止**，
`exitcode.txt` / `session-id.txt` / 后续核对全部缺失，而外层 `ERRORLEVEL` 仍是 0（假绿）。

**建议**：本域脚本已改 `call dsh`；任何用 `.cmd` 包 DSH 的域都要注意这条。

---

## D7【低】壳工具的错误文案乱码（UTF-8 被按 GBK 解码）

**现象**：run4 的 `pwsh` tool_result 是
`"Error: COMMAND_FAILED: 鍛戒护澶辫触銆?`（正确文案应为 `命令失败。`）——
UTF-8 字节 `E5 91 BD E4 BB A4 E5 A4 B1 E8 B4 A5 E3 80 82` 被按 GBK 逐字节解码。

**证据**：`evidence/run4-ask-preset/stdout.ndjson` 第 6、8 行。

**影响**：模型读到的是乱码，无法据此判断失败原因（run4 里模型明确说"The error is not very specific"）。

**建议（未实施）**：`shell-executor.mjs` 回传 stderr/stdout 时统一 `TextDecoder('utf-8')`
（或显式声明 console 代码页为 65001），不要让宿主代码页参与解码。

---

## 未验证项（not-run，禁止当结论用）

* `/winstage approve|discard` 命令面在 headless 线程里的行为：`not-run`。
* 注册表暂存（`staged\reg`）在嵌套线程里的端到端批准：`not-run`
  （run2 只观察到 `registry\overlay.hive*` 文件生成，未做批准）。
* `shim/out/winstage-shim.dll` 是否被重建：**是**（task-11b，D-SHIM-1 修复）。
  修复前 `245,760 B / 47DF4A5AAAB32EBE4A533270EDD6C598F21DB91EE558F5BF326B1469712DD6F2`
  → 修复后 `246,784 B / 4233A422A87DF82DAFD983CE31A41AC50ACCDED73538F0DBC7A3F47EB34783EA`
  （旧件备份 `.t\round10\shim\backup-winstage-shim-47DF4A5A.dll`）。
