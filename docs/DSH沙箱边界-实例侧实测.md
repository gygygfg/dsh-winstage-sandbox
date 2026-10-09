# DSH 沙箱边界 —— 实例侧实测（3081 / WinStage 插件运行面）

> 本文件由一次**独立的边界测试会话**产出：不改动任何仓库源码 / 测试 / 配置（`src/**`、`tests/**`、`dsh-plugin/**`、
> `verify.cmd`、`run.cmd`、`autotest.mjs`、`tools/**`、`patches/**` 全程只读），只读取、只运行、只写 `.t/**`
> 与本文。所有 `[实测]` 行都附"命令 + 观测到的原始输出"。未跑过的，一律标 **未实测**，不写成结论。
>
> - 执行者：子代理（边界测试会话）
> - 时间：2026-10-01 20:24 – 21:26 (+08:00)
> - 目标：**运行中的第二实例（端口 3081）里的 WinStage 插件边界**（不是 OS 级沙箱边界；后者见
>   `docs\沙箱边界实测矩阵.md`）
> - 原始证据目录：`.t\boundary-dsh\`（索引见 §7）

---

## 1. 环境与驱动方式

### 1.1 环境事实 `[实测]`

| 项 | 值 | 证据 |
|---|---|---|
| 实例 | 第二 DSH 实例，端口 **3081**，PID **10884** | `netstat -ano \| findstr :3081` → `LISTENING 10884`；`.t\dsh2\dsh2.pid` |
| profile / DSH_HOME | `dsh2` / `C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\home` | `dsh2.pid` |
| 工作区根 | `C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\ws` | `dsh2.pid`、`review.json.workspaceRoot` |
| 启动时刻 | 2026-10-01T12:13:44.724Z（本地 20:13:44） | `dsh2.pid.startedAt`、`supervisor.log`（PID 9960→10884，**本轮期间实例被重启过一次**） |
| 健康检查 | 裸 `GET http://127.0.0.1:3081/` → **401** | `Invoke-WebRequest` → `远程服务器返回错误: (401) 未经授权。`（信任围栏设计，非故障） |
| 当前启动 URL | `http://127.0.0.1:3081/?token=NhnsnInR_rQ2EXcErOsUlx0okI1xvMp5sCEj8Z1o9OI` | `.t\dsh2\logs\dsh2.out.log` 逐字 |
| 浏览器 | CDP `http://127.0.0.1:9222`（PID 4468，**未动**）；daemon `BU_NAME=wstage`；标签页 URL `http://127.0.0.1:3081/?winstageDebug=1`（复用上一轮已装 cookie 的标签，**只有这一个标签**，未触碰用户 Edge / 3080） | `browser-use --doctor`；`list_tabs()` 只返回 1 项 |
| 3080 / 用户 `.dsh` | 3080 PID 10876 **前后一致**；`C:\Users\Administrator\.dsh\` 未写 | `netstat`；本会话所有写入仅落在 `.t\**` 与 `docs\` 下这一份报告 |
| 项目根 `.dshstage` | 未被本轮触碰（目录 mtime 仍为 2026-09-30） | `Get-ChildItem C:\...\WinStageSandbox\.dshstage` |
| 会话 | `session-7ef9ba50-797f-4850-8c84-250f6ff2ddc7`（承接上一轮的 `browser-probe.txt` 待审项） | 会话目录 / `review.json.sessionId` |

### 1.2 怎么驱动的

- **消息面**：用 CDP 在 3081 标签的 composer 里 `Input.insertText` 注入中文 prompt，再用**真实鼠标点击**发送
  按钮（`Input.dispatchMouseEvent`，非 `element.click()`）；会话轨迹从**实例自己的会话日志**
  （`.t\dsh2\home\sessions\...\session.v4.jsonl.zstd`，**123 个 zstd 帧**）解出**原始 `tool/call` 与 `tool/result`**，
  而不是只读 UI 文本。
- **面板面**：`click_at_xy` 真实鼠标点击 chip / 复选框 / 「拒绝全部」「批准所选」。
- ★ **本次踩到并解决了两个会让"点了没反应"的坑**（对后续任何一次实例侧实测都适用，方法见 §7.4）：
  1. 标签页是 `visibilityState: hidden`，Chromium 在页面加载约 **4 秒**后把页面放进 **Back-Forward Cache**，
     `ws://127.0.0.1:3081/api/remote.mux` 随之断开（`Log.entryAdded`：`WebSocket connection to ... failed:
     Page entered Back-Forward Cache.`）。此时 UI 变成**只读快照**：输入框能打字、消息会乐观显示，但
     **永远到不了服务器**，点「批准 / 拒绝」也**不会生效**（`act()` 走 `executeCommand` = 同一条 mux 连接）。
     解法：导航后立刻 `Emulation.setFocusEmulationEnabled(enabled=true)` +
     `Page.setWebLifecycleState(state='active')` ⇒ `visibilityState` 变 `visible`、socket 存活、UI 可交互。
  2. 浏览器脚本经 stdin 交给 `browser-use` 时，**harness 用 cp936 解码脚本**，脚本里的**字面中文会烂掉**
     （实测 `'暂存'` 变成 3 个错误码点 `0x93c6,0x509a,0x74e8`）。因此所有中文常量改为从 UTF-8 数据文件
     （`.t\boundary-dsh\patterns.json`，显式 `encoding='utf-8'` 读取）加载后 base64 注入页面。

---

## 2. 边界实测矩阵

格式：`探针 | 契约 / 预期 | 实测（真实盘 / 暂存树 / UI 三处） | 状态`
状态取值：`PASS` / `FAIL` / `已记录残余` / `本机不可测`。暂存树根 = `.t\dsh2\ws\.dshstage\sessions\
session-7ef9ba50-797f-4850-8c84-250f6ff2ddc7\`（有会话 id 时用会话级存储；根 `.dshstage\review.json` 全程
`pending:false`，与既有文档一致）。

| 探针 | 契约 / 预期 | 实测（真实盘 / 暂存树 / UI） | 状态 |
|---|---|---|---|
| **F1** `write` 工具·工作区内 | 真实盘无、暂存有、面板显示待审 | 真实盘 `Test-Path .t\dsh2\ws\f1-inside.txt` = **False**；暂存 `staged\f1-inside.txt` = `F1-INSIDE-STAGED`（17 B）；`review.json`：`op=create` / `external=false` / `risk=normal` / `+2 −0`；UI 面板逐字「新增 f1-inside.txt +2 / −0」 | **PASS** |
| **F2** `write` 工具·工作区外（`%TEMP%\winstage-boundary\probe.txt`） | 进暂存（`external:true` → `staged-ext`）或硬拒；真实盘不动 | 真实盘 `Test-Path $env:TEMP\winstage-boundary\probe.txt` = **False**，且连目录 `%TEMP%\winstage-boundary` **都不存在**（捕获发生在写入真实磁盘之前）；暂存 `staged-ext\b8\b814e879557075dc\probe.txt` = `F2-OUTSIDE`（11 B）；`review.json`：`external=true` / `risk=outside`；UI 面板 **L2 工作区外 (1)** + 「命中敏感策略」（**没有**硬拒，与 S3a 取消硬拒的设计一致） | **PASS** |
| **F3** `edit` 工具·覆盖已有暂存条目 | 编辑进暂存；同一路径**只保留最终版本一个条目** | 真实盘 `f3-edit.txt` = **False**；暂存 = `F3-AFTER`（9 B）；`manifest.entries['f3-edit.txt']` 只有**一条**（`createdAt` 12:59:14.415Z → `updatedAt` 13:05:43.709Z，`stagedHash 0af1741a…`）；`review.json` 里 `f3-edit.txt` 只出现一次。本轮实际经历 `write(F3-BEFORE) → edit(F3-AFTER) → write(F3-BEFORE) → edit(F3-AFTER)` 两轮，最终只剩一条 `F3-AFTER` | **PASS** |
| **F4** 删除能力 | 删除真实文件必须成为**删除候选**、不得静默丢失（项目历史缺陷） | **该实例的 `ctx.fs` 工具面没有删除工具。** 证据三重：① agent 原话「没有删除工具。我当前可用的文件工具只有 read、write、edit、glob、grep、present（以及 read_image）……没有任何 delete / remove / rm 类工具」；② `dsh-tool-fs` 只注册 `read` / `write` / `edit` / `read_image`（`lib/index.js` 四次 `defineTool`）；③ `dsh-plugin\staging-fs.mjs` **没有覆写任何删除方法**，而基类 `LocalFileSystem` / `SandboxedFileSystem` 也**没有** remove/delete/unlink。真实盘 `t7-a.txt` 未动 | **本机不可测** |
| **F5** `pwsh` 写**与 `write` 工具同一路径** | 已声明残余 S1：shell 写绕过 `ctx.fs` | 见 §3 逐字证据。结论：**真实盘立即出现 `f1-inside.txt`（`F5-SHELL-OVERWROTE`，23 B，21:07:39）**，暂存里仍是 `F1-INSIDE-STAGED`，面板照旧列「新增 f1-inside.txt +2 / −0」 | **已记录残余** |
| **F5b**（追加）外部改动可见性 | 基线被外部改动 ⇒ 应有 stale 提示 / 告警 / 至少不被静默覆盖 | 见 §3.4。暂存 `STAGED-VERSION`、真实盘被 shell 改成 `SHELL-VERSION`；**90 秒内 snapshot 一次都没重发布**（`generatedAt` 冻结在 13:20:55.920Z），`staleBaseline=0`、`alerts=[]`、`risk=normal`、UI 无任何徽标；**点「批准所选」后真实盘被静默覆盖成 `STAGED-VERSION`，无提示、无告警、无错误** | ~~**FAIL**~~ → **PASS**（修复后复测，离线复现：`staleBaseline≥1` + 批准被 `STALE_BASELINE` 拒绝 + 真实盘不变；见 §9） |
| **F6** `pwsh` 读敏感路径 | 期望被遮蔽 / 拒绝（`src\paths.mjs` 的 `MASK_CLASSES`） | `.ssh`：`Cannot find path 'C:\Users\Administrator\.ssh' because it does not exist.` ⇒ **不存在，不是被拒**；`.npmrc`（`MASK_CLASSES: npmrc`）**原样读出** `registry=https://registry.npmmirror.com`；`.dsh`（`MASK_CLASSES: dsh-home`）**可枚举**：`attachments / cache / llm-deepseek / logs / profiles`。⇒ shell 侧读面**没有任何遮蔽** | **已记录残余** |
| **F7** `pwsh` 网络 | 允许（残余 R2） | `Invoke-WebRequest http://127.0.0.1:3081/` → `ERR 远程服务器返回错误: (401) 未经授权。`（**连通**，401 是应用层信任围栏）；`Resolve-DnsName example.com` → `example.com`（DNS 通） | **已记录残余** |
| **F8** `pwsh` 写注册表（`HKCU`，随后清理） | 拒绝 / 暂存 / 直写？ | `New-Item HKCU:\Software\WinStageBoundaryProbe` → `New-Item : Access to the registry key 'HKEY_CURRENT_USER\Software\WinStageBoundaryProbe' is denied.`（`UnauthorizedAccessException`）；后续 `Set-ItemProperty` / `Get-ItemProperty` 均 `PathNotFound`；`Remove-Item` + `Test-Path` → **False**；**未进暂存**（`review.json` 无该项）、**未直写**（本机复测 `Test-Path 'HKCU:\Software\WinStageBoundaryProbe'` = False） | **PASS** |
| **F9-拒绝** | 拒绝后真实盘不变、面板更新 | 面板**唯一**的拒绝入口是「拒绝全部」（逐字：`/winstage reject`；DOM 里没有逐项「拒绝所选」）。点击后 **2 秒内**面板消失；`review.json`：`pending=false`、`files=[]`、`revision=18`；`staged\` 清空；真实盘 `browser-probe.txt` = **False**、`f3-edit.txt` = **False**、TEMP probe = **False** | **PASS** |
| **F9-批准** | 单个条目勾选即可批准（不必「批准全部」），真实盘出现暂存内容 | 勾选 `f9-approve.txt` 后，面板按钮从 `[…拒绝全部, 批准全部]` 变 `[…拒绝全部, **批准所选**, 批准全部]`（逐字实测）⇒ **「批准全部」不是必须的**；点击「批准所选」（= `/winstage approve "f9-approve.txt"`）后 2 秒面板消失；真实盘 `f9-approve.txt` = `F9-APPROVED-CONTENT`（20 B，21:18:18）；`manifest`：`stagedHash == baseHash`、`changed=false`、`baseKind=file` ⇒ 正确转为新基线、不留待审 | **PASS** |
| **F10** 开关 | 报 `enabled` 值 + 该状态下 UI 行为（**不**切换 live profile） | `.t\dsh2\home\profiles\dsh2\cordis.patch.yml` 逐字：`- id: winstage-sandbox` / `name: '@local/dsh-winstage-sandbox'` / `config: enabled: true` / `workspaceRoot: '…\.t\dsh2\ws'` / `probeOnStart: true`。UI 行为：composer 里是 **WinStage 控件**（chip 逐字「W 暂存待审 N」；title「WinStage 沙箱：文件写入先落暂存、批准后才写真实工作区（已替代平台的访问模式选择器）」），DOM 中 `aria-label` 含「访问模式」的元素数 = **0** ⇒ 平台的访问模式选择器不在 DOM；可写入时「批准 / 拒绝」进面板，不弹平台审批 | **PASS** |

**计数**：10 个指定探针 + 1 个追加探针 = 11 行 ⇒ **PASS 6**（F1/F2/F3/F8/F9×2/F10）、**已记录残余 3**（F5/F6/F7）、
**本机不可测 1**（F4）、**FAIL 1**（F5b，追加探针，见 §3.4）。

> **修复后复测（finisher 收口，2026-10-02）**：F5b 由 **FAIL → PASS**（离线复现，见 §9）。
> 修复后计数：**PASS 7**（F1/F2/F3/F8/F9×2/F10/F5b）、**已记录残余 3**（F5/F6/F7）、**本机不可测 1**（F4）、**FAIL 0**。
> F5（shell 写绕过暂存）**仍是已声明残余 S1**：修复把它变成"**可见 + 可拒绝**"，**不是**"可回滚/可拦截"。

---

## 3. shell 绕过：如实写出（F5 / F5b）

### 3.1 事前状态（F5 之前）

- 21:05:43 面板快照（`review.json` v15）里 `f1-inside.txt` 是待审的「新增」项，`baseHash = absent`，
  `stagedHash = fa603157…`，暂存内容 `F1-INSIDE-STAGED`；真实盘 `Test-Path .t\dsh2\ws\f1-inside.txt` = **False**。

### 3.2 送给实例 agent 的命令（逐字，会话日志 `tool/call` 原文）

```json
{"command": "Set-Content -LiteralPath 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox\\.t\\dsh2\\ws\\f1-inside.txt' -Value 'F5-SHELL-OVERWROTE' -Encoding utf8; Get-Content -LiteralPath 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox\\.t\\dsh2\\ws\\f1-inside.txt'", "description": "Run probe command A"}
```

`tool/result`（逐字）：`F5-SHELL-OVERWROTE` （`isError=false`）。

> 旁注 `[实测]`：`tool/result` 的报错文本里能看到宿主对命令的包装前缀 `... ew($false); <用户的命令>`，
> 即 shell 命令确实经过平台 shell 提供方，但**不经过 `ctx.fs`**。

### 3.3 同一时刻的三处观察 `[实测]`（21:07:39 之后立刻取证）

| 观察处 | 观测 | 命令 / 位置 |
|---|---|---|
| **真实盘** | **文件存在**，内容 `F5-SHELL-OVERWROTE`（23 B，`LastWriteTime 21:07:39`） | `Test-Path .t\dsh2\ws\f1-inside.txt` → **True**；`Get-Content … -Raw` → `F5-SHELL-OVERWROTE` |
| **暂存树** | 内容仍是**旧**的 `F1-INSIDE-STAGED`（17 B） | `.t\dsh2\ws\.dshstage\sessions\session-7ef9ba50…\staged\f1-inside.txt` |
| **UI / 快照** | 仍把 `f1-inside.txt` 列为待审「**新增** +2 / −0」（快照 `generatedAt 13:05:43Z` 早于 shell 写入 13:07:39Z，**之后没有重发布**） | 面板截图 `F9-panel-before-4items.png`；`review.json` 仍 `files[].op=create` |

**⇒ 结论（直白）**：`pwsh` 的写**立刻落到真实工作区**，既不进暂存、也不产生候选、也不出现在审批面板；
面板在同一路径上继续展示一个与真实磁盘**已经不一致**的候选。**用户的"批准/拒绝"手势管不到这次写入。**

### 3.4 追加探针 F5b：外部改动**不可见**，且批准会**静默覆盖** `[实测]`

> **修复后复测（finisher 收口，2026-10-02）：已修复 —— 本节现象不再复现，F5b 由 FAIL 改为 PASS。**
> 证据见 §9（离线 `ReviewService` 复现：漂移可见 + 批准被 `STALE_BASELINE` 拒绝 + 真实盘不变）。
> **以下为修复前的原始记录，保留不改。**

F5 只证明了"绕过"。F5b 追问"那插件到底发不发现"：

1. 21:20:55 agent：`write f5b-stale.txt = STAGED-VERSION` ⇒ 暂存 `STAGED-VERSION`，`baseHash=absent`，
   `review.json` 发布（`generatedAt 13:20:55.920Z`，`staleBaseline=0`，`alerts=[]`，`risk=normal`）。
2. 同一轮紧接着 agent：`pwsh Set-Content … f5b-stale.txt -Value 'SHELL-VERSION'` ⇒ 真实盘 = `SHELL-VERSION`（`tool/result` 逐字 `SHELL-VERSION`）。
3. **90 秒**每 15 s 复测 `review.json`：`generatedAt` **一直是 13:20:55.920Z**（一次都没重发布）、
   `revision=23`、`staleBaseline=0`、`alerts` 空、`files[0].risk=normal`、`files[0].safety=null`；
   `manifest.entries['f5b-stale.txt'].changed=true`、`baseHash=absent`（**真实文件已存在**）。
4. 于是我在面板里勾选 `f5b-stale.txt` → 点「**批准所选**」（`/winstage approve "f5b-stale.txt"`）：
   - 结果：**无二次确认弹窗、无告警、无 notice、无错误**，2 秒内面板消失、`pending=false`；
   - 真实盘内容由 `SHELL-VERSION` **变成** `STAGED-VERSION` —— **shell 写入的内容被静默丢弃**；
   - `manifest`：`baseHash = stagedHash = 231ff8ac…`、`changed=false`、`baseKind=file`（当作"正常落盘"记账）。

**⇒ 结论**：对「新增」类候选（基线 = absent），**真实文件在暂存之后由 shell 出现且内容不同**这一形状，
本实例**既没有 stale 提示、也没有告警、也没有在应用时做冲突检测**，批准即覆盖。
"外部改动可见"这条保证在本形状下**不成立**；它比"绕过暂存"更进一步：**shell 写的内容还会在下一次批准时无声消失**。

### 3.5 安全后果（为什么这不是"文档化的无害残余"）

1. **写面无审批**：模型只要用 `pwsh` 就能改真实工作区里的任何可写文件（含源码、`README.md`、`docs\**`），
   没有 diff、没有候选、没有用户手势。会话里 `ctx.fs` 的"先暂存、批准后落盘"对这条路**完全不适用**。
2. **插件自身存储也不设防**：`staging-fs.mjs` 的 P0-8 守卫（`FS_SANDBOX_DENIED`）**只作用于 `ctx.fs`**，
   源码注释已如实写明 "shell writes bypass ctx.fs and are not covered"。也就是说 `.dshstage\**`
   （`review.json` / `manifest.json` / `staged\**`）经 `pwsh` **可写**——自指条目、永久 pending 这类
   历史上出现过的形态，仍然是"shell 能造、插件拦不住"。本轮**未实测**对 `.dshstage` 的 shell 写（避免污染
   证据快照），但机制上无任何拦截点。
3. **不可回退**：F9-拒绝实测后，真实盘 `f1-inside.txt` **仍然存在且仍是 `F5-SHELL-OVERWROTE`**。
   即"拒绝"**无法**把工作区恢复到 shell 写入之前的状态。用户看到的"不批准就不会写真实工作区"这句话，
   在有 shell 写的前提下是**假的**。
4. **静默数据丢失**：§3.4 实测的"批准覆盖 shell 内容"是一条**没有任何 UI 提示的丢数据路径**。
   用户若在别处（编辑器 / 另一个进程）改过同一文件，同样形状会中招。
5. **读面不设防（F6）**：同一把 shell 还能读 `.npmrc`、枚举 `.dsh`（会话 / profile / 日志）。写面绕过 +
   读面不收敛叠加，等于"模型在用 shell 时基本不受本插件约束"。

### 3.6 与设计文档的关系（不是新发现，但需要说清边界）

`docs\DSH集成.md` §5 S1 已**逐字**声明："**shell 写入不经过暂存** / 仍然存在，且本机不可能实现"。
所以 §3.3 的 F5 属于**已声明残余**，本报告只是把它在 live 实例上钉死。
**但 §3.4 的 F5b（不可见 + 静默覆盖）不在 S1 的声明范围内**：S1 说的是"shell 写绕过暂存"，
没有说"外部改动检测失效、批准会静默覆盖"。因此 F5b 计 **FAIL**，并明确：**本报告只做现象定因到
"manifest/review 未体现外部改动"，未读透 `src\workspace.mjs` 做源码级定因。**

---

## 4. 截图（绝对路径）

均在 `.t\dsh2\browser\shots\` 下（`[实测]` 由 `browser-use` 的 `capture_screenshot` 直接落盘）：

| 文件（绝对路径） | 拍到了什么 |
|---|---|
| `C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\browser\shots\baseline-F9-before.png` | 面板基线：1 项待审（`browser-probe.txt`），未勾选，**只有**「全选 / 清空选择 / 暂时收起 / 拒绝全部 / 批准全部」——没有逐项批准/拒绝 |
| `C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\browser\shots\F9-panel-before-4items.png` | **F5 之后**的面板：4 项待审「L1 工作区内 (3) / L2 工作区外 (1)」，其中 `f1-inside.txt` **仍显示「新增 +2 / −0」**（真实盘其实已经有内容了）；左下角「重新连接中…」= 冻结标签的证据 |
| `C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\browser\shots\F9-panel-selected.png` | 勾选 `browser-probe.txt` 后，面板出现「**批准所选**」 |
| `C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\browser\shots\F9-panel-selected-single.png` | F9-批准：只勾选 `f9-approve.txt`，「批准所选」出现（证明**不需要**「批准全部」） |
| `C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\browser\shots\F9b-approve-stale.png` | F5b：勾选被 shell 覆盖过的 `f5b-stale.txt`（面板对该冲突**毫无提示**） |
| `C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\browser\shots\F9-panel-after-approve.png` | 批准完成后：面板、chip、正文里都没有「暂存待审」⇒ 待审清零、真实盘已落盘 |

---

## 5. `仍未提供的保证`（如实清单）

1. **shell 半边（`winstage-shell`）在本实例根本没有启用。** `[实测]` 启动器
   `.t\dsh2\run-dsh2.mjs` / `start-dsh2.mjs` **不设置 `WINSTAGE_SHELL`**，而
   `dsh-plugin\cordis.patch.yml:128` 的 `winstage-shell` 行是
   `disabled: !!js process.env.WINSTAGE_SHELL !== '1' || …` ⇒ 恒真 ⇒ **该行未装载**；同一对条件的
   `pwsh-sandbox` 行因此**启用**（平台 shell 接管）。**所以本实例的 shell 既没有暂存、也没有注册表暂存、
   也没有读遮蔽**——F5/F6/F7/F8 测到的都是**平台 shell 的面，不是 WinStage shell 的面**。
2. **注册表面**：本实例只有"被内核 / ACL 拒绝"这一种结果（F8）。`docs\T3-注册表暂存设计.md` 的注册表
   暂存**未接线到本实例**（因为 shell 半未启用）。"注册表改动会被捕获成候选"这条保证**未提供**。
3. **网络面**：R2 未收敛（F7 实测 DNS / HTTP 皆通）。
4. **读面**：R1 未收敛（F6 实测 `.npmrc` 原文可读、`.dsh` 可枚举）。`MASK_CLASSES` 是检测/兜底，
   **不是硬边界**；`pwsh` 走的是完全另一条路。
5. **删除面**：本实例**没有** `ctx.fs` 删除工具可测（F4）。因此"删除必须成为删除候选、不得静默丢失"
   这条不变量在本实例**无法验证**；能保证的只有"agent 经 `ctx.fs` 删不掉"。**残余风险**：`staging-fs.mjs`
   继承基类，只覆写了变更面/读取面，**没有覆写任何删除方法**；一旦将来有调用方在基类或别处用到
   remove/delete（`src\tools.mjs:251` 的 `deleteFile → workspace.remove` 就是这种形状的另一套工具层），
   那条路会**直写真实磁盘、不进暂存、不产生删除候选**——正是历史缺陷的形状，当前只是"够不到"。
6. **外部改动的可见性**：~~无~~ → **已补足（部分）**：F5b 形状（真实文件在暂存后出现）现在**可见**
   （`counts.staleBaseline` / `files[].baselineStale` + `baselineStaleCode` / 面板徽标与逐行说明 /
   `alerts`）且**批准会被 `STALE_BASELINE` 拒绝**；但 shell 已经写进真实盘的内容**仍不可回滚**
   （见 §9 与 ② 修复报告 §7 第 5 条）。
7. **开关 OFF 路径**：**未实测**。`enabled: true` 是当前 live 值；OFF 时应"退回平台沙箱/审批面"
   （`staging-fs.mjs` 的 `sandboxMode` / 转发语义，属代码依据），但本报告**没有**切换 live profile 去验它，
   因此 `OFF ⇒ 平台面` 只有**代码依据、无本实例实测**。
8. **跨进程 / 跨实例**：CLI 或另一 DSH 实例写同一份暂存树时的失效通知，源码已声明不支持，本轮未测。
9. **不在本报告范围**：OS 级沙箱（T0/T1/TS 档位、AppContainer、WFP）——见 `docs\沙箱边界实测矩阵.md`。

---

## 6. 与我方文档的出入

| 文档 | 文档口径 | 本次实例侧实测 | 判定 |
|---|---|---|---|
| `docs\DSH集成.md` §5 **S1** | "shell 写入不经过暂存 —— 仍然存在，且本机不可能实现" | F5 完全复现（真实盘立即变、暂存不动、面板照旧） | **一致**（本次把它在 live 实例上钉死） |
| `docs\dsh2-越界与注册表-实测诊断.md` | `ctx.fs` 工作区外写 → 外部条目 + `staged-ext` 物化；`ctx.shell` 越界写 / 注册表写 → **内核级硬拒** | F2 一致（`staged-ext\b8\b814e879557075dc\probe.txt`，真实盘连目录都没建）；F8 一致（`Access to the registry key … is denied.`） | **一致** |
| `src\paths.mjs`（`MASK_CLASSES` / T2 收敛） | 敏感路径**应当**被遮蔽；文档同时如实声明这是"检测/兜底"、非硬边界 | F6：`.npmrc`（`npmrc` 类）、`.dsh`（`dsh-home` 类）经 **`pwsh`** 原样可读 / 可枚举 | **一致**（文档已声明 R1 残余；本次确认该残余同样适用于 shell 面） |
| `src\workspace.mjs` / `docs` 中关于 **STALE_BASELINE / `staleBaseline` / 基线过期可见** 的口径 | 基线被外部改动后应可见（`staleBaseline` 计数、`data-winstage-baseline-stale` 徽标、`STALE_BASELINE` 错误码） | F5b：真实盘被 shell 改成 `SHELL-VERSION`、基线 `absent` 时，`staleBaseline=0`、`alerts=[]`、无徽标、90 s 不重发布；「批准所选」**静默覆盖**为 `STAGED-VERSION` | ~~**出入（记 FAIL）**：文档描述的 stale 可见性**没有覆盖"基线 = absent（新增）而真实文件在暂存后出现"这一形状**；本报告只到现象定因，未做源码定因~~ → **修复后已一致（本轮复测）**：② 修复补齐了该形状（`baselineStaleCode=baseline-appeared`）并让批准 fail-closed；本报告的失败读数已成为历史口径，见 §9 |
| 任务书 F9 的隐含假设 | "对单个条目点『拒绝』" | 面板**只有**「拒绝全部」（`/winstage reject`），**没有**逐项拒绝；逐项拒绝只能走 `/winstage reject <path>` 命令（`host-plugin.mjs:381-387` 已注册带可选路径的命令）。「批准所选」则确实存在（勾选后出现） | **需澄清**：UI 层"逐项拒绝"不存在，逐项批准存在 |
| `README.md` §6 / §"残余边界" | 残余边界列表指向 `docs\DSH集成.md`（含 S1） | 与 S1 一致；但 README 未提"外部改动不可见 / 批准静默覆盖" | **漏项**（建议在残余边界列表补一条） |

---

## 7. 附录

### 7.1 原始证据索引（`.t\boundary-dsh\`）

| 文件 | 内容 |
|---|---|
| `session-transcript.json` | 实例会话日志**全量解帧**（123 个 zstd 帧）后的 218 行原文（10 轮 / 18 次工具调用），本报告所有 `tool/call` / `tool/result` 逐字引用均出自此 |
| `evidence-turns.txt` | 逐轮 `USER / CALL / RES` 摘要（含 turn 1 起的历史轮） |
| `evidence-shell.txt` | F4 回答 + F5–F8 命令与原始输出（A–H 八条） |
| `evidence-f5b.txt` | F5b（`write` 暂存 → `pwsh` 覆盖）的原始调用与返回 |
| `evidence-all.txt` | 全量可读版 |
| `panel-*.json` / `out-*.json` / `f9-*.json` | 面板 DOM、复选框、按钮、快照、事件流的机器可读记录 |
| `patterns.json` | 全部中文 prompt / 正则（UTF-8 数据文件，规避 cp936 stdin 坑） |
| `bh.py` / `send3.py` / `p_*.py` / `dump-session.cjs` / `extract*.cjs` | 驱动与取证脚本 |

### 7.2 会话结构（本报告相关轮次）

`turn 1`（上一轮遗留 `browser-probe.txt`）→ `turn 2` F1 → `turn 3` F2 + F3 基座 → `turn 4` F3 edit →
`turn 5`（F2/F3 重放，确认"更新"路径）→ `turn 6` F3 edit → `turn 7` F4 → `turn 8` F5–F8（8 条 shell 命令）→
`turn 9` F9 待审项 → `turn 10` F5b。

### 7.3 关键复现命令

```powershell
# 健康：必须是 401
cmd /c "curl -s -o NUL -w \"%{http_code}\" http://127.0.0.1:3081/"

# 三处取证的"真实盘 + 暂存树"
$ws = 'C:\Users\Administrator\Desktop\WinStageSandbox\.t\dsh2\ws'
$ss = "$ws\.dshstage\sessions\session-7ef9ba50-797f-4850-8c84-250f6ff2ddc7"
Test-Path "$ws\f1-inside.txt"                      # F5 之后 = True
Get-Content "$ss\staged\f1-inside.txt" -Raw        # 仍 = F1-INSIDE-STAGED
Get-Content "$ss\review.json" -Raw                 # pending / counts.staleBaseline / files[].op
```

### 7.4 让 3081 标签页"真的可交互"的两条 CDP（否则一切点击都无效）

```python
cdp('Emulation.setFocusEmulationEnabled', enabled=True)
cdp('Page.setWebLifecycleState', state='active')
```

不加这两条时 `[实测]`：页面加载 ~4 s 后 `Network.webSocketFrameError: Page entered Back-Forward Cache`，
`document.visibilityState === 'hidden'`，UI 变成只读快照。

---

## 8. 一句话总结

**`ctx.fs` 这一半在本实例上按契约工作**（F1/F2/F3 全 PASS：工作区内进暂存、工作区外进 `staged-ext`、
编辑只留最终版本；F9 拒绝不动真实盘、批准按暂存内容落盘且单项即可批准；F8 注册表写被内核硬拒）。
**但 shell 这一半（F5/F6/F7）完全不设防**——`pwsh` 立刻直写真实工作区、可读遮蔽清单里的文件、可连网。
~~且**插件对外部改动既不可见、批准时还会静默覆盖**（F5b，FAIL）。~~ ⇒ **修复后复测（2026-10-02）：
F5b 已修 —— 插件现在对外部改动可见、批准被 `STALE_BASELINE` 拒绝、真实盘不再被静默覆盖（§9，PASS）**；
但 shell 已写进真实盘的内容**仍不可回滚**（残余不变）。本实例**未启用** `winstage-shell`，
所以"shell 也有围栏"这件事在本实例**不存在**，"删除会被捕获"在本实例**无从验证**。

---

## 9. 修复后复测（finisher 收口，2026-10-02；`[实测]`，离线复现）

> 说明：本轮**没有**操作 3081 实物面板（避免扰动 live 实例），改用 `.t\fix2-repro-f5b.mjs`
> ——它用 **真实文件系统 + 真实 `ReviewService`** 复刻 §3.4 的 1→2→3 序列，走同一份
> `dsh-plugin\review-service.mjs` / `src\workspace.mjs` 代码路径。② 的实物侧（3081 面板徽标、
> 「重新对齐并批准所选」按钮）证据保留在 `docs\边界缺陷修复-②基线过期不可见.md` §4。

| 探针 | 修复前 | 修复后 |
|---|---|---|
| `.t\fix2-repro-f5b.mjs`（§3.4 序列） | 7 FAIL / 10（`.t\fix2-repro-before.txt`） | **exit 0，9 PASS / 0 FAIL，`结果：ALL PASS`**（`.t\finish2b-fix2-repro-f5b.txt`） |
| `.t\fix2-after-fix.mjs` | —（本轮新增） | **41 PASS / 0 FAIL** |
| `.t\baseline-watch-selftest.mjs` | —（本轮新增） | **20 PASS / 0 FAIL** |

关键读数（逐条取自原始输出）：

| 观测 | §3.4 修复前 | §9 修复后 |
|---|---|---|
| 漂移可见性 | `staleBaseline=0`、`alerts=[]`、无徽标、90 s 不重发布 | `counts.staleBaseline ≥ 1`；该行 `baselineStale=true` 且带 `baselineStaleCode`（本形状为 **`baseline-appeared`**） |
| 「批准所选」 | **静默覆盖**为 `STAGED-VERSION`，无提示无错误 | **被拒**：`approved=0`、`code=STALE_BASELINE`、`driftReason="baseline-appeared"`、消息 `real file changed since staging (expected absent, found 2c68a8df…) … refusing to overwrite` |
| 拒绝后的真实盘 | 已是 `STAGED-VERSION`（原 `SHELL-VERSION` 丢失） | **仍是 `SHELL-VERSION`**（内容未被覆盖） |
| 账本 | `baseHash = stagedHash`、`changed=false`（当作正常落盘） | 漂移条目保留（未静默对准）；`/winstage rebase` 与面板「重新对齐并批准所选」是显式出路 |
| 正面控制（未漂移的新增） | — | `baselineStale` 为空（**无假阳性**），批准后正常落真实盘 |

**残余（不变）**：shell 已经写进真实盘的那份内容**仍然无法回滚**。本次修复把它从"不可见 + 静默覆盖"
变成"**可见 + 可拒绝**"，没有、也不可能把它变成"可回滚"（② 报告 §7 第 5 条）。
§5 的其余保证清单不受本次修复影响。
