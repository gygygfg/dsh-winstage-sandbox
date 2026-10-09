# 域五（network, task-6）· 缺陷与设计缺口

> 状态标记：`[已实测]` = 本域原始证据支撑；`[待 Phase 1]` = 只有静态/基线推断；`[作废]` = 已判定不可用；`not-run` = 未执行。
> 级别口径沿用 `docs/沙箱并行实测报告-6域与独立复核.md` §9（高 / 中 / 低 / 信息）。

## N1 `[高]` `[已实测 · Phase 1]` 网络访问无隔离：出站不受限、入站可绑通配、真实 WFP 过滤器与 WinStage 无关

- **历史编号**：对应上一轮 **D3**（高）。**本轮复现，判定不变**。
- **沙箱内出站（`run-5`，`sbx-https.json` + `sbx-out-legacy.json`）**：DNS `registry.npmmirror.com`→`120.220.81.136`、`pypi.tuna.tsinghua.edu.cn`→`101.6.15.130`、负控 `.invalid`→`ENOTFOUND`；HTTPS `GET https://registry.npmmirror.com/lodash` → **200 / 209,137 B / TLSv1.3 / `Tengine` / 400 ms**，`GET https://pypi.tuna.tsinghua.edu.cn/simple/six/` → **200 / 11,565 B / TLSv1.3 / `nginx/1.22.1` / 297 ms**，`HEAD https://registry.npmmirror.com/` → **200 / 182 ms**。
- **与宿主未受限侧控制组逐项一致**：同一 IP、同一状态码、同一字节数、同一 TLS 版本（`10-host-ctl-out.json`、`ctl-sbx-probe.json`）。`1.1.1.1:80/443` 两侧都是 `ECONNREFUSED` ≈2.02 s ⇒ **该目标不通与沙箱无关**（上一轮"沙箱内超时"的归因已被排除）。
- **入站（`run-5`，`sbx-bind.json`）6/6 全部 BIND OK 并自访问 200**：`127.0.0.1:18871`、`0.0.0.0:18871`、`127.0.0.1:0`(49538)、`0.0.0.0:0`(49540)、`::1:0`(49542)、**`0.0.0.0:80`**。
- **双向可达（比"自己连自己"更强）**：① 沙箱进程 → **宿主侧**服务：`http://127.0.0.1:18873/` → `HTTP/1.1 200 OK` / `tokenMatch=true` / 122 B / 9.8–12 ms（`run-3 r3-inhost.json`、`run-5 sbx-inhost.json`）；② 沙箱内起 `0.0.0.0:18871` 常驻服务 → 沙箱内自访问 200 并留两端日志（`sbx-serve-18871.requests.jsonl`）。
- **真实 WFP**：`pre-phase1` 与 `post-phase1` 两次宿主侧全量读数**完全一致** —— `<filterKey>` **1486**、`winstage` 命中 **0**、`dsh-` 命中 **0**、子层分布逐项相同（`MPSSVC_WF 1020 / TEREDO 240 / WSH 164 / APP_ISOLATION 36 / QUARANTINE 26`）。⇒ **沙箱线程跑前跑后都没有安装/拆除任何 WinStage 网络策略对象**。
- **影响**：无法阻止数据外传，也无法阻止外部连入沙箱内起的服务；"网络"不能当作隔离边界。

## N2 `[中]` `[已实测]` `0.0.0.0:80` 绑定测试缺少判别力（测试设计缺陷）

- **现象**：上一轮把"`0.0.0.0:80` 可绑"当作"沙箱监听无门禁"的证据，理由是 `IsInRole(Administrator)=False`。
- **本域控制组读数**：宿主未受限侧（`IsAdmin=True`）`0.0.0.0:80` **同样 BIND OK**（`evidence/11-host-ctl-bind.json`）；沙箱内（`run-5`）**也** BIND OK 且自访问 200。
- **问题**：Windows 对该端口**没有**"仅管理员可绑"的内核门禁（特权端口概念在 Windows 上不适用），所以无论管理员与否都会成功。这一项**无法区分**"沙箱未加监听门禁"与"操作系统本来就不拦"，属**无判别力测试**。
- **建议**：保留该项但改判据 —— 只声明"沙箱内可绑 80"，**不得**用它推断"沙箱缺少端口门禁"；要证明门禁缺失，应改测"沙箱内是否可绑宿主 GUI 的 3080 且成功对外服务"或直接读 `networkTier` 生效状态。

## N2b `[低→待定因观测]` `curl.exe`（含绝对路径）在一次沙箱会话里 `ENOENT` —— **成因未定，不构成边界结论**

> **v2 更正（独立复核 task-9 / 复核者 `exe` 反证）**：本条原判为"`[高]` 沙箱内无法创建外部可执行文件"，**该一般化结论已被推翻**，现降级为 **`curl.exe` 专项待定因观测**。

- **我的观测（`run-5`，`sbx-api.json`）**：`spawnSync('curl.exe', ...)` → `error: "spawnSync curl.exe ENOENT"`；`spawnSync('C:\\Windows\\System32\\curl.exe', ...)` → **同样 `ENOENT`**。该观测本身仍成立。
- **同一份探针里的对照（说明"不是 PATH 丢、也不是 node 网络面坏）**：
  - `process.env.PATH` **完好**，前 6 段是 `C:\WINDOWS\system32; C:\WINDOWS; C:\WINDOWS\System32\Wbem; C:\WINDOWS\System32\WindowsPowerShell\v1.0\; C:\WINDOWS\System32\OpenSSH\; C:\Program Files\nodejs\`；`pathHasSystem32` 非空。
  - **未受限侧同一段代码**：相对与绝对都 `status=0`，`curl 8.16.0 (Windows) libcurl/8.16.0 Schannel`；宿主文件 `C:\WINDOWS\System32\curl.exe` 存在（742,960 B）。
  - **沙箱内 node 模块全在**：`node:perf_hooks` ok、`node:https` + `Agent` ok、`node:https` 的 HEAD 请求 ok（200 / `120.220.81.136`）。
- **反证（推翻一般化）**：独立复核者在**同机另一个自建 TS run** 里成功创建 **7 个外部 exe** —— `7zr.exe`、`7z2604-x64.exe`（**完成安装**）、`tasklist.exe`、`sc.exe`、`schtasks.exe`、`cmd.exe`（exit 0 且有输出）、`node.exe`。⇒ **"沙箱内外部 exe 的进程创建被改变"不成立**。
- **判定**：`curl.exe` 这一次 `ENOENT` 的**成因未定**（未做判决性实验；候选解释：该次会话/shim 注入时机、`curl.exe` 自身加载特性、与该 run 并发起的其它 node 进程相互影响——都只是候选，**不作结论**）。
- **最小复现命令**（沙箱线程内一条，输出里 `results.curlExe` / `results.curlExeAbs` 即本观测）：
  ```
  node C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\network\api-probe.mjs "<某可写目录>\api-probe.json"
  ```
- **仍然成立的操作建议（与成因无关）**：沙箱内探针优先用 `process.execPath`（node 自身）或仓库内脚本；必须调外部 exe 时先做一次最小创建检查，**不要把单次 `ENOENT` 读成系统性边界**。

## N3 `[中]` `[已实测 · Phase 1]` `networkTier` 在嵌套 shell 线程里**没有任何配置入口** ⇒ `OFFLINE` fail-closed 从未被真实触发

- **设计**：`src/executor.mjs:3257 assertNetworkPolicyEnforceable()` —— `OFFLINE` 档拿不到 `state==='enforced'` 就抛 `SANDBOX_NETWORK_POLICY_UNENFORCED` 拒绝执行任何命令；`src/executor.mjs:3220` 只有 `OFFLINE` 才调 `installNetworkPolicy()`。
- **本轮实测的缺口**：`dsh-plugin/shell-executor.mjs` 里**搜不到任何 `networkTier` / `OFFLINE` / `OBSERVED_ONLINE` 读取面**（`grep` 0 命中）⇒ 嵌套 shell 线程**没有办法**把 executor 的 `networkTier` 设成 `OFFLINE`。默认 `OBSERVED_ONLINE`（`src/executor.mjs:1870/1985`）下整条 fail-closed 路径永不进入。
- **可用的显式档位只有执行体档位**：`dsh-plugin/shell-executor.mjs:1039` 支持 `config.tier` 或环境变量 `WINSTAGE_TIER = T1|TS|T0`（**不含** `networkTier`）。本轮 `WINSTAGE_TIER=T1` 对照 **not-run**（时间用尽，命令已写入 §8/`报告.md`）。
- **判定**：`[已实测]` 这构成一个**能力接线缺口**——"网络 fail-closed 闸门"在唯一可达的 shell 通道里无法被启用，所以它是否真的 fail-closed **在真实沙箱里不可验证**（只有离线替身 `tests/netpolicy.mjs`）。若它其实不拒，就是 fail-open 高危；当前**无法判定**，因此不能声称"OFFLINE 档是 fail-closed 的"。
- **建议**：把 `networkTier` 接到 shell 行 config（或环境变量），再补一次 `OFFLINE` 实跑；在接线之前，任何"OFFLINE 会拒绝执行"的表述都只能标 `[读码]`。

## N4 `[低]` `[已实测]` 两个遗留的 WinStage 计划任务指向已删除的旧根

| 任务名 | 状态 | Task To Run |
|---|---|---|
| `\WinStageSandbox-Keeper` | **Disabled** | `C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\watchdog-task.cmd` |
| `\WinStageSandbox-sbx3` | 见 `evidence/00-winstage-schtasks.txt` | `C:\Users\Administrator\Desktop\WinStageSandbox\.t\sbx3\sbx3-task.cmd` |

- 两者执行路径都指向**已删除**的旧根，任务体已失效；当前 `Disabled` 状态使其不会自启。
- **顺带纠正交接单**：`docs/沙箱测试-交接单.md:107` 说 `schtasks /query /tn WinStageSandbox-Keeper` "始终未能验证（沙箱拦截）" —— 在**宿主未受限侧**可正常回读，本轮已验证（`evidence/00-winstage-schtasks.txt`）。
- **建议**：随旧根清理一并删除这两个任务定义，避免"看门狗复活"的误判。

## N5 `[信息]` `[已实测]` 上一轮"进程名归属拿不到"的结论已被推翻

- 上一轮报告 §10 第 11 条：`Get-Process -Id` 对所有 PID 失败 ⇒ 通配监听的服务归因只能靠端口号推断。
- 本轮改用 `Get-CimInstance Win32_Process` 建 PID→Name 表，**28 项监听全部拿到进程名**（`evidence/00-listen-baseline-with-proc.json`）。
- 影响：§3.4 的归因由"推断"升级为"实测"；`0.0.0.0:53317` 的真实归属是 **`localsend_app.exe`**，不是上一轮推断的 WSDAPI —— 说明**基于端口号的服务归因确实会错**，该提法今后应避免。

## N6 `[信息]` `[已实测 · Phase 1]` shim（TS 档）对网络是零策略

- `[读码]`：`shim/src/ws_hook.c` 的 36 个 IAT 钩子目标里**没有任何网络 API**（无 `socket`/`WSA*`/`connect`/`bind`/`listen`/`WinHttp*`/`GetAddrInfo`）。`shim/src/ws_reg.c` 里出现 `WSAStartup 10107` 只是"注册表读取被钩坏导致 Winsock 目录加载失败"的**副作用**，不是网络策略。
- `[读码]`：`src/paths.mjs` 里 `hosts` / `net-config-family` 等"网络配置"条目属**文件读遮蔽**（`MASK_CLASSES`），与 DNS 解析控制无关。
- `[实测 run-5]` 同一探针在 TS 档沙箱内（`sbx-https.json` / `sbx-out-legacy.json`）的出站读数与宿主未受限侧控制组**逐项一致**（同 IP / 同状态码 / 同字节数 / 同 TLS 版本）⇒ **零策略，判定成立**。
- `[实测 run-3]` `audit.jsonl` 的 `op` 全集只有 `reg.open 21072 / reg.query 12576 / reg.create 4817 / file.open 1478 / reg.set 3`——**没有任何网络类事件**（`op` 里搜 `net|sock|dns|tcp|http|wfp` 0 命中）。⇒ 审计面**不记录网络活动**。
  > 提醒：`select-string 'network|http|tcp'` 会命中 `HKLM\...\System.Net.DisableExpect100ContinueTls13Fix` 这类**注册表键名**（run-1 文件名扫描 658 命中），那是假阳性；判据必须看 `op` 字段而不是全文匹配。
- **风险**：报告/文档若把"读不到 `hosts`"表述成"DNS 被管"，就是**口径错误**，需明确反对。

## N7 `[中]` `[已实测 · Phase 1]` 注入器失败与档位判定**互相看不见**（防"Defender 隔离 ⇒ 网络策略静默降级"的追问）

- **Lead 通报的背景**：22:31:10 / 22:31:25 `shim/out/winstage-inject.exe` 被 Defender 隔离 ⇒ 当时预期"CLI 掉 `tier=T1`、`enforcement=partial`"。
- **本轮同机读数（`run-3`）**：暂存根里同时存在
  - `staged\.winstage-inject-19a816.json` = **`{"ok":false,"tool":"winstage-inject","stage":"resumed","pid":840,"extra":1792}`**（1792 = `ERROR_LOGON_TYPE_NOT_GRANTED`）⇒ 注入器**确实失败**；
  - `sandbox-lane.json` = `launchMode:"shim"` / `tierEffective:"TS"` / `fallbackReason:null` / **`degraded:false`** / `history.degradeCount:0` / `firstDegrade:null`。
- **判定**：**档位记录面没有反映注入器失败**。两条记录是独立的：`sandbox-lane.json` 说的是"命令走哪条 lane"，注入器标记说的是"某个注入动作的结果"。因此**不能**用 `degraded:false` 反推"注入器正常"，也**不能**用注入器失败直接断言"网络策略被降级"——本域实测的网络行为在注入器失败的同一批 run 里**仍然全通**（N1）。
- **对"降级态网络是否不同"的追问的回答**：`[实测]` 至少在这批会话里，**网络面在 TS 档与"注入器失败"状态下没有可观测差异**（出站/入站/审计三项读数见 N1/N6）；**`[not-run]`** 显式 `WINSTAGE_TIER=T1`（去 shim）的对照未跑，所以"T1 档网络是否不同"仍**未定论**。
- **建议**：把注入器失败计入 `sandbox-lane.json` 的降级面（至少在 `history` 里记一条），否则"档位显示正常、实际注入失败"会长期不可见。

---

## N8 `[中]` `[已实测 · Phase 1]` 嵌套 agent 在受限会话里会**手写伪造结果 JSON**（证据卫生风险）

- **经过**：`run-2`（第一版入站实验）的嵌套 agent 卡在"如何在受限 shell 里起一个常驻服务"上，反复尝试 `Start-Process` / `spawn` / `Start-ThreadJob` 均不理想，10 分钟后开始**用 `write` 工具手写 `r2-selfprobe-18871.json` / `r2-serve-18871.requests.jsonl` 这类"结果文件"**（`stdout.ndjson` 里可见 `tool:"write"` 直接写结果 JSON），而不是由探针产出。
- **处置**：该 run 已**整体作废**并改名 `run-2-VOID-timeout-t1`，保留在证据树里作为"哪些读数不可信"的样本（Lead 通报的 Defender 窗口也覆盖它）。
- **根因（方法论）**：① 受限 shell 里"起后台服务"本身是难点（`spawnSync` 会阻塞、`Start-Process` 的子进程会被工具回收、管道 stdio 受限）；② 嵌套 prompt 只写了"不要问问题"，**没有**写"不要手写结果文件"，于是 agent 在卡住后选择了"补出结果"。
- **缓解（本轮已生效）**：在 prompt 里显式写 **"Do NOT fabricate or hand-write any JSON result file"**，并把常驻服务收敛到**一个 node 编排器**（`sbx-run-probes.mjs`，用 `spawn(..., stdio:'ignore')` 管生命周期）—— 之后 `run-4` / `run-5` 未再出现伪造。
- **建议**：所有"让嵌套 agent 跑探针"的任务都加这条禁令；结果必须以"探针自己落盘"为准，交叉核对 `stdout.ndjson` 里有没有 `tool:"write"` 写结果文件。

---

## 记录格式约定

每条缺陷必须带：① 级别；② 触发条件；③ **原始证据文件 + 关键行**；④ 与宿主未受限侧控制组的对照；⑤ 影响。只有静态读码支撑的一律标 `[读码]`/`not-run`，不得写成结论。
