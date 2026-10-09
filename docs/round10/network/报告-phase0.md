# 域五（network, task-6）· 网络服务与网络访问 —— 阶段 0 报告（基线与控制组）

> 生成线程：**宿主未受限线程**（`DSH_SESSION_ID=6c49ffef-da13-45cf-a764-52bfdc80ea4a`，`WINSTAGE_SHELL=0`，用户 `win-dv9kreclbvs\administrator`，`IsAdmin=True`）。
> 铁律遵守情况：本线程**未加载沙箱**；宿主 node PID 7812（监听 3080）只读观察，未触碰；宿主 profile 只读；仓库源码未改动。
> 证据分层：`[实测]` = 本线程原始输出（文件已落盘）；`[对照]` = 同宿主未受限侧读数，用于给"沙箱内"的读数定基准；`not-run` = 未执行。

## 0. 状态：Phase 0 完成 / Phase 1 not-run

| 阶段 | 状态 |
|---|---|
| Phase 0 宿主侧基线 + 控制组 | **已完成** |
| Phase 1 沙箱内（带沙箱 DSH 线程）出站 / 入站 / 审计日志实测 | **not-run**（等 Lead 发配方） |
| Phase 1 真实 WFP 过滤器左右对照（沙箱测试前后各一次） | **not-run** |

因此本文件**只声明基线与控制组**，任何"沙箱内能不能通网"的结论都留到 Phase 1 报告补齐。

---

## 1. 口径与红线

1. **"代码里有策略" ≠ "运行期装了过滤器"。** 前者读 `src/netpolicy.mjs`（1118 行）、`src/wfp.mjs`（1202 行）、`src/mitigations.mjs`；后者只能靠 `netsh wfp show filters` 数**运行期 BFE 对象**。本域两者分开陈述（§3 vs §5）。
2. 测试克制：合计 **8 个网络目标**（DNS 3 + HTTPS 3 + TCP 2，其中 1 个 DNS 负控），无端口扫描、无压力测试、无第三方服务。目标只有国内镜像 + 1 个历史对照 IP。
3. 端口约定：本地服务用 **188xx** 段。本域占用 **18871**（绑定位矩阵）、**18811**（与 `gui` 约定、宿主回环服务）、18872（刻意不绑的负控）。`gui` 自用 3091/9222，不冲突。
4. 用完即关：所有常驻 listener 都记录 PID、用 `taskkill /T /F` 关闭、并复核监听表。

---

## 2. 探针与脚本（可复现清单）

| 文件 | 作用 | 用法 |
|---|---|---|
| `.t\round10\network\net-out.mjs` | 出站探针（DNS / HTTPS / 裸 TCP），自己 `fs.writeFileSync` 落盘 | `node net-out.mjs <out.json> <label>` |
| `.t\round10\network\net-in.mjs` | `bind` 绑定矩阵 / `serve` 常驻服务（写 ready JSON + 请求日志）/ `probe` 客户端单次 GET | `node net-in.mjs bind\|serve\|probe ...` |
| `.t\round10\network\in-host-access.mjs` | 起服务 → 自访问 → 负控 → 关服务 → 复核监听的编排器（子进程 stdio 走文件，不用管道） | `node in-host-access.mjs <outDir> <label> <host> <port> <side>` |
| `.t\round10\network\wfp-check.ps1` / `.cmd` | 只读 WFP 核对：`show filters` / `show state` / 服务 / 监听 + 统计 JSON | `wfp-check.cmd <OutDir> <Tag>` |

设计要点（踩过的坑，供 Phase 1 复用）：
- `serve` 同时写 `<label>-serve.json`（诊断）与 `**<label>-serve.ready.json`（就绪标记）**；编排器只等后者 —— 早期版本漏写标记导致编排器空等 15 s（已修，见 §4.2 的失败记录）。
- 受限 shell 里管道捕获原生 stdout 会 EPERM ⇒ 一律让 node 自己 `writeFileSync`；PowerShell 侧 `.ps1` 直接跑会被执行策略拒（`not digitally signed`），必须经 `wfp-check.cmd` 的 `-ExecutionPolicy Bypass` 包装。`.cmd` 注释**只能用 ASCII**（中文注释在 GBK 代码页下会把 `REM` 拆坏）。

---

## 3. 宿主侧基线（`[实测]`，Phase 0）

### 3.1 环境指纹

- OS build **26100**（Windows 11 24H2），PowerShell **5.1.26100.33438**，node **v24.21.0**，`NodeIsAdmin=True`。
- `BFE`(Base Filtering Engine) / `MpsSvc` / `WinRM` / `LanmanServer` 全部 `Running` + `Automatic`。
- 防火墙三档（Domain/Private/Public）`Enabled=True`，`DefaultInboundAction=NotConfigured`、`DefaultOutboundAction=NotConfigured`。
- 证据：`evidence/00-host-fingerprint.json`、`evidence/00-services.json`、`evidence/phase0-services.json`。

### 3.2 真实 WFP 对象：**1486 个过滤器 / 0 个 WinStage 对象**

| 指标 | 值 |
|---|---|
| `<filterKey>` 计数 | **1486** |
| `<providerKey>` 计数 | 1497 |
| `<subLayerKey>` 计数 | 1486 |
| 关键词 `winstage`（忽略大小写）命中 | **0** |
| 关键词 `dsh-` 命中 | **0** |
| `netsh wfp show filters` 退出码 / 产物 | 0 / 3,634,935 B |
| `netsh wfp show state` 退出码 / 产物 | 0 / 4,572,829 B（其中 `winstage` 命中 **0**） |

子层分布（全部是微软自带，**没有任何第三方/产品自定义子层**）：

| 子层 | 过滤器数 |
|---|---|
| `FWPM_SUBLAYER_MPSSVC_WF`（Windows 防火墙） | 1020 |
| `FWPM_SUBLAYER_TEREDO` | 240 |
| `FWPM_SUBLAYER_MPSSVC_WSH`（Windows Service Hardening） | 164 |
| `FWPM_SUBLAYER_MPSSVC_APP_ISOLATION` | 36 |
| `FWPM_SUBLAYER_MPSSVC_QUARANTINE` | 26 |

提供者里出现 2 个**裸 GUID**（`{1bebc969-…}`、`{aa6a7d87-…}`，各 1 条过滤器）—— 属系统/SDK 侧无名字提供者，**不是** WinStage（`winstage` 关键词 0 命中）。`netsh wfp show state` 的分节只有 ALE 端点 / IPsec / IKE 统计，**不含子层清单**；子层要数 `show filters` 的那一份（早期误判已纠正）。
证据：`evidence/phase0-wfp-summary.json`、`phase0-wfp-filters.xml`、`phase0-wfp-state.xml`、`01-host-wfp-filters.xml`、`02-host-wfp-state.xml`。

### 3.3 防火墙规则：432 条，全部 `Action=Allow`，**0 条 Block**，0 条 WinStage 命名

- 总规则 432（Enabled 246 / Disabled 186；Inbound 256 / Outbound 176）；`Name`/`DisplayName` 含 `winstage|dsh|node` 的：**0**。
- **诚实标注**：PowerShell 5.1 下 `Get-NetFirewallRule` 的 `Action` 恒为 `Allow`（规则对象本身不带 `Block` 语义，真正的动作在 WFP filter 里）。所以"0 条 Block"是**工具口径的局限**，不能读成"本机没有阻断规则"；阻断面的权威读数是 §3.2 的 1486 条 WFP 过滤器。**结论只取：没有任何 WinStage 命名的防火墙规则。**
- 证据：`evidence/01b-host-firewall-rules.json`。

### 3.4 监听面：28 项 / 通配 23 项（进程归属已拿到）

- 通配（`0.0.0.0`/`::`）：135、139、445、2179、5357、5985、47001、49664-49671、53317 等 —— 全部归属系统服务（`svchost`/`System`/`lsass`/`spoolsv`/`services`/`vmms`/`AsusLinkNear`/`localsend_app`）。
- 仅回环：**3080**（node PID **7812**，DSH Web GUI，宿主运行中）、**9222**（msedge，`gui` 的 CDP 实例）、**50296**（browser-use 的 python daemon）。
- **80 端口当前无监听**（`Get-NetTCPConnection -LocalPort 80 -State Listen` 计数 0）—— 给 Phase 1 的 `0.0.0.0:80` 绑定测试留出干净画布。
- 进程名归属本轮**拿到了**（上一轮报告称 `Get-Process -Id` 对所有 PID 失败 ⇒ 只能推断）。走 `Get-CimInstance Win32_Process` 建 PID→Name 表即可。
- 证据：`evidence/00-listen-baseline-with-proc.json`、`phase0-listeners.json`。

### 3.5 遗留物：两个**已禁用**的 WinStage 计划任务

| 任务名 | 状态 | Task To Run |
|---|---|---|
| `\WinStageSandbox-Keeper` | **Disabled** | `C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\watchdog-task.cmd` |
| `\WinStageSandbox-sbx3` | （见 `00-winstage-schtasks.txt`） | `C:\Users\Administrator\Desktop\WinStageSandbox\.t\sbx3\sbx3-task.cmd` |

两者的执行路径都指向**已删除的旧根** `C:\Users\Administrator\Desktop\WinStageSandbox`。`schtasks /query /tn WinStageSandbox-Keeper` 可正常回读（上一轮交接单说"始终未能验证（沙箱拦截）"）—— 在宿主未受限侧**可验证**。
WinStage 相关服务：**0** 个。

---

## 4. 宿主未受限侧控制组（`[实测]` / `[对照]`）

控制组的意义：**同一个探针脚本**先在未受限侧跑一遍，Phase 1 在沙箱内跑同样的脚本。两边差异才能归因给沙箱；两边一致则说明差异来自上游网络。

### 4.1 出站（`evidence/10-host-ctl-out.json`）

| 目标 | 结果 |
|---|---|
| `dns.lookup(registry.npmmirror.com)` | `120.220.81.136`（IPv4） |
| `dns.lookup(pypi.tuna.tsinghua.edu.cn)` | `101.6.15.130` |
| `dns.lookup(no-such-host-r10.invalid)`（负控） | `ENOTFOUND` ✅ 符合预期 |
| `GET https://registry.npmmirror.com/lodash` | **200** / 209,137 B / 2,107 ms / `TLSv1.3` / server `Tengine` / remote `120.220.81.136` |
| `GET https://pypi.tuna.tsinghua.edu.cn/simple/six/` | **200** / 11,565 B / 1,000 ms / `TLSv1.3` / server `nginx/1.22.1` / remote `101.6.15.130` |
| `HEAD https://registry.npmmirror.com/` | **200** / 0 B / 245 ms |
| `tcp 1.1.1.1:443` | **ECONNREFUSED**，2,022 ms |
| `tcp 1.1.1.1:80` | **ECONNREFUSED**，2,023 ms |

**关键对照结论（写入 Phase 1 归因基线）**：
`1.1.1.1` 在**宿主未受限侧**也是不通的，且是 **`ECONNREFUSED`（约 2.0 s）而非 `ETIMEDOUT`**。这与上一轮报告"沙箱内 8 s 超时（静默丢包）"不同（探针与超时参数不同），但指向同一件事：**该目标的不可达性来自主机上游链路/中间设备的干预，不是沙箱造成的**。因此 Phase 1 不得把 `1.1.1.1` 的不通当作"沙箱网络隔离生效"的证据。
另：环境变量 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` 均为 `null`（未走代理）。

### 4.2 入站绑定位矩阵（`evidence/11-host-ctl-bind.json`）

| 绑定 | 结果 |
|---|---|
| `127.0.0.1:18871` | BIND OK（18871） |
| `0.0.0.0:18871` | BIND OK |
| `127.0.0.1:0` | BIND OK（临时端口 62744） |
| `0.0.0.0:0` | BIND OK（62746） |
| `::1:0` | BIND OK（62748） |
| `0.0.0.0:80` | **BIND OK（80）** |

**重要口径修正**：本线程是 `IsAdmin=True`，所以"`0.0.0.0:80` 绑定成功"在宿主侧**完全符合预期**，不构成任何缺陷证据。上一轮"沙箱内 `IsInRole(Administrator)=False` 却仍能绑 80"才是异常读数。Phase 1 必须**同时**记录沙箱内的 `IsInRole(Administrator)` 与绑定结果，否则该行无判别力。

### 4.3 宿主回环服务的"起 → 访问 → 关"闭环（`evidence/hostctl-*`）

编排器 `in-host-access.mjs` 一次跑通（`hostctl-host-access.json`）：

| 步骤 | 原始读数 |
|---|---|
| 起服务 | `LISTENING host=127.0.0.1 port=18873 pid=8896` |
| ready JSON | `ok=true`，`boundAddress=127.0.0.1`、`boundPort=18873` |
| 自访问 `GET http://127.0.0.1:18873/` | `HTTP/1.1 200 OK`、**`tokenMatch=true`**、122 B、40 ms |
| 服务端请求日志 | `{"method":"GET","url":"/","peer":"127.0.0.1:58315","ua":"r10-net-host-probe","localPort":18873}` —— 双向都留证 |
| 负控 `GET http://127.0.0.1:18872/`（未绑） | **`ECONNREFUSED`** ✅ |
| 关服务 | `taskkill /PID 8896 /T /F` → `SUCCESS`；`post-kill-alive=false`；`18873` 监听计数 **0** |

控制组里还记录了一次**失败**并已修复：首版 `net-in.mjs` 声明了 `readyPath` 却漏写该文件，导致编排器空等 15 s、`ready=null`。修复后重跑通过。这条保留下来是因为 Phase 1 的嵌套会话若拿不到 ready 文件，第一嫌疑就是"服务没真起来"而不是"网络不通"。

---

## 5. 设计面（源码）与运行期的差距 —— 待 Phase 1 用运行期读数收口

| # | 设计面（`[读码]`） | 运行期真值（Phase 0 `[实测]`） |
|---|---|---|
| 1 | `src/wfp.mjs` 结构/调用层齐备；`src/wfp.mjs:28-30` 自述"一个 `Fwpm*Add0` 都没调用过" | `netsh wfp show filters`：1486 条过滤器、**`winstage` 命中 0** ⇒ 与自述一致 |
| 2 | `src/netpolicy.mjs` 把 wfp 从"惰性库"变成"可强制可审计"：四态 `enforced/not-enforced/refused/not-implemented`；fail-closed；`ENUMERATION_UNAVAILABLE_REASON='enumeration-unavailable'` | 运行期是否需要安装由 `src/executor.mjs:3220` 决定：**只有 `EXECUTOR networkTier === 'OFFLINE'`** 且 `result.plan` 非空才调 `installNetworkPolicy()` |
| 3 | `src/executor.mjs:1870/1985` `networkTier` **默认 `'OBSERVED_ONLINE'`** | 默认档位下 `prepareNetworkPolicy()` 只做判定，**不装过滤器、不改系统状态**（源码自述 + §5.1 运行期 0 命中） |
| 4 | `assertNetworkPolicyEnforceable()`（`:3257`）在 `OFFLINE` 且未 enforced 时抛 `SANDBOX_NETWORK_POLICY_UNENFORCED` 拒绝执行 | **not-run**：需在带沙箱线程里以 `networkTier=OFFLINE` 实跑一次，看是否真的 fail-closed |
| 5 | `src/wfp.mjs::probeWfpAvailability`/`openEngine` 在 High IL 下 `[实测]` 可开引擎（阶段 B 记录于 `.t/sbx3/dev/raw-probe-wfp-runtime.txt`） | **not-run**（本域不重跑引擎探针；装过滤器属系统级状态变更，本轮不授权） |
| 6 | shim（TS 档）**不钩任何网络 API**：`shim/src/ws_hook.c` 的 36 个目标里没有 `socket/WSA*/connect/bind/listen`；仅在 `ws_reg.c` 注释里提到 `WSAStartup 10107` 是注册表读取被钩坏的**副作用** | `[读码]` ⇒ **推断**：TS 档对网络是**零策略**。Phase 1 用同一探针在 TS 档 vs 纯宿主侧对照验证 |
| 7 | `src/paths.mjs` 的 `MASK_CLASSES` 含 `hosts`/`net-config-family` 等"网络配置"读遮蔽（`win.ini`/`hosts`/`networks`/`evtx`） | `[读码]` ⇒ 这是**文件读遮蔽**，不是网络策略。别把"读不到 hosts"读成"DNS 被管" |

---

## 6. Phase 1 复现清单（等 Lead 配方后执行）

```powershell
# ── A. 沙箱内（带沙箱 DSH 线程；sandbox profile 已存在：C:\Users\Administrator\.dsh\profiles\sbx）
$env:WINSTAGE_SBX_WORKSPACE = 'C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\network\ws'
node .t\round10\network\net-out.mjs .t\round10\network\out\sbx-out.json sandbox
node .t\round10\network\net-in.mjs bind .t\round10\network\out\sbx-bind.json sandbox
# 记录 IsInRole(Administrator) 与 0.0.0.0:80 绑定结果，两者必须同时留证

# ── B. 沙箱内起 18811（给 gui 复核）+ 18871（本域），宿主侧访问
node .t\round10\network\in-host-access.mjs docs\round10\network\evidence sbx-18811 127.0.0.1 18811 sandbox
node .t\round10\network\in-host-access.mjs docs\round10\network\evidence sbx-18871 0.0.0.0 18871 sandbox
# 随后在**宿主未受限侧**（本线程）访问 http://127.0.0.1:18811/ 并核对 token

# ── C. 沙箱测试前后各做一次宿主侧 WFP 左右对照
cmd /c ".t\round10\network\wfp-check.cmd docs\round10\network\evidence pre-sbx"
cmd /c ".t\round10\network\wfp-check.cmd docs\round10\network\evidence post-sbx"
# 判据：两次都必须 winstageKeywordHits=0 / dshKeywordHits=0，子层分布不新增条目

# ── D. 审计日志
$env:WINSTAGE_AUDIT_LOG = '<路径>'; # 由沙箱侧 shell 会话注入，检查 JSONL 里是否有网络事件
```

## 7. 证据索引

| 文件 | 内容 |
|---|---|
| `evidence/00-host-fingerprint.json` | 宿主/权限/版本指纹 |
| `evidence/00-services.json`、`phase0-services.json` | BFE/MpsSvc/WinRM/LanmanServer 状态 |
| `evidence/00-listen-baseline-with-proc.json`、`phase0-listeners.json` | 监听 + 进程归属 |
| `evidence/01-host-wfp-filters.xml`、`phase0-wfp-filters.xml` | 真实 WFP 过滤器全量（各 3.6 MB） |
| `evidence/02-host-wfp-state.xml`、`phase0-wfp-state.xml` | WFP 运行状态（各 4.5 MB） |
| `evidence/phase0-wfp-summary.json` | 过滤器/子层/提供者计数 + 关键词命中 |
| `evidence/01b-host-firewall-rules.json` | 432 条防火墙规则（含工具口径局限说明） |
| `evidence/00-schtasks-all.txt`、`00-winstage-schtasks.txt` | 计划任务全量 + WinStage 命中 |
| `evidence/10-host-ctl-out.json` | 宿主侧出站控制组 |
| `evidence/11-host-ctl-bind.json` | 宿主侧绑定矩阵控制组 |
| `evidence/hostctl-host-access.json`、`hostctl-probe.json`、`hostctl-neg-probe.json`、`hostctl-serve.requests.jsonl` | 宿主回环服务闭环 |

*本文件为 Phase 0 产物；Phase 1 结论将追加在 `报告.md` 的 Phase 1 章节，并保留本节所有基线作为对照。*
