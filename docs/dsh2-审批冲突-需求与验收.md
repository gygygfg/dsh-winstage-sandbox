# 本轮：暂存机制 × 原生审批机制冲突 —— 需求与验收（Lead 维护，唯一需求来源）

> 本文件由 **Lead** 独占维护，是本轮工作的需求基线。执行者只读它，把自己的证据写进各自独占的报告文件。
> 与本文件冲突的口头约定不算数 —— 以这里为准，或先让 Lead 改这里。

---

## 0. 一句话目标

在一个**独立于 3080 会话**的第二个 DSH 进程（端口 **3081**，独立 `DSH_HOME=.t\dsh2\home`、profile `dsh2`）里装载本仓库的
WinStage 沙箱插件，用**真实浏览器（CDP）**去操作它，从而：

1. 复现并解释用户报的三件事：**（a）沙箱的修改规则互相冲突严重；（b）文件修改暂存机制与"原本的审批机制"冲突严重；
   （c）审批条目非常容易出错、消不掉、还不报错**；
2. 在 `dsh-plugin/**` 内做**最小可验证修复**，让失败**必须响**（有病历：本项目历史上反复栽在"静默失效"上）；
3. 全程**不触碰** 3080（不加载插件、不改 `C:\Users\Administrator\.dsh`、不重启、不重载）。

## 1. 角色与写范围（唯一所有者）

| 角色 | 职责 | 写范围 | 明确禁止 |
|---|---|---|---|
| **Lead**（我） | 维护本文件 + 与用户对接 + 派工/验收 | `docs/dsh2-审批冲突-需求与验收.md` | 不直接改插件、不起进程、不开浏览器 |
| T1 `rig` | 起 3081、插件 sync/重启、启停并保活浏览器 CDP | `.t/dsh2/**` | 不改 `dsh-plugin/**`、不动 3080 |
| T2a `analyst-plugin` | 插件侧根因（只读源码） | `docs/dsh2-冲突诊断-插件侧.md` | 不改任何代码、不起进程 |
| T2b `analyst-core` | DSH 核侧根因（只读核心包） | `docs/dsh2-冲突诊断-DSH核侧.md` | 不改任何代码、不起进程 |
| T4 `browser` | CDP 操作 3081，复现缺陷 | `.t/dsh2/browser/**`、`.t/dsh2/T4-browser-report.md` | 不动用户 Edge/3080 页面、不起停 3081 |
| T3 `fixer` | 按已确认根因修复插件 | `dsh-plugin/**`、`.t/dsh2/fix-asserts/**`、`.t/dsh2/fix-backup/**` | 不改 `src/**`、`tests/**`、不起停 3081（改 profile 覆盖层需 Lead 确认） |
| T5 `verifier` | 独立（对抗性）复核 | `.t/dsh2/verify/**` | 不改代码 |

**写范围重叠是告警不是锁**：同一文件同一时间只允许一个写入者。

## 2. 已确认的环境事实（Lead 只读侦察所得，执行者不要再重新发现）

| 事实 | 值/证据 |
|---|---|
| 当前 3080 实例 | `DSH_PROFILE=web`、`DSH_HOME=C:\Users\Administrator\.dsh`、`DSH_WEB_URL=http://127.0.0.1:3080`、DSH_SESSION_ID=`session-eb443f12-…` |
| 第二实例装置 | 端口 3081 / profile `dsh2` / `DSH_HOME=.t\dsh2\home` / workspaceRoot=`.t\dsh2\ws`；启动器 `.t\dsh2\run-dsh2.mjs`；手册 `.t\dsh2\HOWTO-RESTART.md` |
| 3081 凭据 | `.t\dsh2\home\.credentials.yaml` 已就绪（D1 决策：只落此处，禁止回写 `C:\Users\Administrator\.dsh`） |
| 部署方式 | profile `dsh2` 加载的是**物理复制**的 `dsh-plugin` + `src`，不是 `link:` ⇒ 改代码必须 sync+restart（`HOWTO-RESTART.md` §4） |
| 进程回收硬约束 | 工具调用结束会回收该调用启动的整棵进程树 ⇒ 3081 与浏览器都必须由**后台作业的不退出进程**承载（`HOWTO-RESTART.md` §2） |
| 无 Chrome | 只有 `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`；当前无任何 CDP 端口监听；用户自己的 Edge 正在运行（**不许碰**） |
| DSH 核心包 | `C:\Users\Administrator\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`（含 `dsh-fs-sandbox`、`dsh-user-approval`、`dsh-client-ui-approval`、`dsh-workspace-changes`、`dsh-sandbox*`、`dsh-fs*` 等） |
| 3080 未装载本插件 | profile `web` 的 `dsh.profile.bundles` 不含 `@local/dsh-winstage-sandbox` ⇒ **正确状态，不是故障**；由此 3080 上任何"面板/暂存"观察对本插件无判别力 |
| `dsh-plugin/**` 无 git 历史 | git 里是 untracked ⇒ 改动前必须自己做快照（T3 强制项） |

## 3. 本轮验收（逐条可判定）

### A. 复现（浏览器 + 快照双证据）

| 编号 | 要求 |
|---|---|
| A1 | 3081 上能造出待审条目，且 `review.json` 前后 diff 逐字留档 |
| A2 | 复现"**消不掉**"：点批准/拒绝后条目仍存在（或未按语义变化）—— 或**反证**它其实能消（两者都必须有 AX/截图/review.json 三件证据） |
| A3 | 复现"**不报错**"：失败路径没有任何用户可见提示、也没有 error 级日志 —— 或反证有 |
| A4 | 复现"**与原生审批机制冲突**"的精确形态：谁先生效、谁被顶掉、留下什么状态（真实磁盘 vs 暂存树） |
| A5 | 阴性对照：不应产生待审条目的普通操作**不**产生条目，且不报错 |

### B. 根因

| 编号 | 要求 |
|---|---|
| B1 | 插件侧与核侧各一份报告，每条结论带 文件:行号 + 代码片段 + `[实测]/[引用]/[未实测]` |
| B2 | 明确列出"所有静默失败点"（守卫 `return null`、catch 吞异常、`ok:false` 未上抛、patch 行名失配静默跳过、注册回调抛错致死） |
| B3 | 给出 `ctx.fs` 最小契约清单，以及 `winstage-fs` 相对它的差距 |

### C. 修复

| 编号 | 要求 |
|---|---|
| C1 | 每处改动对应 B 中一条已确认根因；改动前有 sha256 快照 + 基线测试输出 |
| C2 | **失败必须响**：所有拒绝/失败路径都有 error 级日志或用户可见提示，且各有一条**能 FAIL 的断言**（变异体证明） |
| C3 | 回归门：`.\autotest.cmd --skip-audit` 改后 vs 基线逐项一致或更好，原始输出落盘 |
| C4 | 3081 装载新代码后复测 A1–A5；未经浏览器复测的部分必须标 `[未实测]` |

### D. 独立复核

| 编号 | 要求 |
|---|---|
| D1 | verifier 自己跑、自己判定，不复述他人结论；对每条修复做证伪尝试 |
| D2 | 隔离契约四项复核（`--dump-config` 根、`review.json` 根、项目根 `.dshstage` 未变、3080 未被触碰） |
| D3 | 阴性对照：修好后正常路径**不应**出现 error 噪声 |

## 4. 全局约束（违反即不合格）

- **不触碰 3080**：不改 `C:\Users\Administrator\.dsh`、不重启、不重载、不给它加载本插件。
- **不共用 `.dshstage`**：3081 只用 `.t\dsh2\ws`。
- **证据三要素**：原始命令/脚本 + 原始输出（或日志路径）+ 判定。没有证据的断言视同未完成。
- **改动只在 `dsh-plugin/**`**（外加 T3 自己的证据目录）；`src/**`、`tests/**` 是 CLI 侧，不在本轮范围。
- **如实标注**：做不到就写 `[未实测]` 并说明缺什么条件，禁止含糊成"已解决"。

## 5. 已知陷阱（别重蹈）

1. 面板存在性必须**精确名**匹配（`WinStage 暂存待审` / `暂时收起`）；`/winstage status` 的回显会进聊天记录 ⇒ 用**子串**判定会**假 PASS**。
2. 判因不能只抓 console 异常：守卫链多处静默 `return null`，可能**零报错**；必须做三值比对（`configValue.workspaceRoot` / `store.state.workspaceRoot` / `review.json.workspaceRoot`）。
3. loader 行名是**断言**：改 `dsh-plugin/cordis.patch.yml` 的行名必须同步 profile 覆盖层，否则整条补丁连同 `config` 被**静默跳过**（曾导致 `.dshstage` 落回真实工作区，事故 INC-1）。
4. cordis patch 对 `config` 是**整体替换**：profile 覆盖层必须重述该行 config 的**所有**键。
5. 浏览器诊断通道是 `?winstageDebug=1`，必须**单独 navigate**（拼到 token URL 上会因 302 丢 query）。
6. 浏览器里**不做盲点击**：AX 面板未命中就停下并报告。

---

## 6. 本轮已确认的第一手发现（Lead 直接实测，覆盖前文过时结论）

### 6.1 【实测·最高优先】本 3080 进程自己就在运行本插件，且 write/edit 工具写入被静默暂存
- `C:\Users\Administrator\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` **含** `@local/dsh-winstage-sandbox`（与 `docs/dsh2-需求与验收.md` §3.5 的"3080 未装载"结论**相反**；该结论已过时）。
- `C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml` 里该行 `config.enabled: false`，**但暂存面仍在工作**。
- 对照实验（同一路径、同一时刻）：
  | 写入方式 | 工具/命令报告 | 真实磁盘 | 实际落点 |
  |---|---|---|---|
  | write 工具 `.t\dsh2\probe-tool-write.txt` | `Created file` | **不存在** | `.dshstage\staged\.t\dsh2\probe-tool-write.txt` (28 B) |
  | `pwsh Set-Content` `.t\dsh2\probe-shell-write.txt` | 无输出 | **存在** (33 B) | 真实路径 |
- 后果：本会话所有 `write`/`edit` 产物都进 `<repo>\.dshstage\staged\…`；`read` 工具（经 ctx.fs）能看到，`grep`(ripgrep)/`node`/shell 看不到 ⇒ 团队协作会出现"一半人看得见"的假象。
- 这就是用户抱怨"**各种修改规则冲突严重**"的第一手形态：会话横幅声明 `file policy=danger-full-access`、`approval=never`（"不限制文件修改"），而 fs 提供方却把每次写入变成一条**需要审批**的暂存候选，且**不报错**。

### 6.2 【实测】受控实验已派工：`enabled` 开关是否真的能关闭暂存面
- task-7（T1b-rig）在 3081 上做：改 profile 覆盖层 `enabled: false` → 重启 → 走 3081 的 `ctx.fs` 写探针 → 判定真实磁盘是否变化 → 恢复。**这是"开关是否被忽略"的唯一权威判定**，不许用推论代替。

### 6.3 【实测·核侧，T2b】"审批条目消不掉还不报错"的核侧确凿证据
- `.t\dsh2\home\sessions/…session-5bfece37…/session.v4.jsonl.zstd`：seq62 `approval/asked`(pwsh 升权, id 4a60e08b…) → seq63 合成 `TOOL_OUTCOME_UNKNOWN` → seq65 `turn/end{interrupted}`，**decided=0**。
- 机制：`ApprovalService.request()`（dsh-user-approval/lib/index.js:128-144）先落 `approval/asked` 再 `await`；中断/崩溃修复 `openTurnClosers()`（dsh-session/lib/types/repair.js:45-144）只合成 `tool/result`+`step/end`+`turn/end`，**从不补 `approval/decided`**；包自带 invariant 也**不校验 asked 必须闭合** ⇒ 条目永久留在持久化日志里、重放正常、**零报错**。
- 另有：`ctx.fs.sandboxMode === undefined` 一节门控三件事（dsh-tool-fs/lib/index.js:1084-1088,1096-1126,1159-1163；dsh-tool-str-replace-editor/lib/index.js:56-57）——升权字段消失、`SandboxExecutionPolicy.sessionId` 断链、编辑器围栏关闭；插件在暂存面把它返回 `undefined`（`dsh-plugin/staging-fs.mjs:377-379`）。
- 核侧存在**两套互不认识的审批语义**：`ctx.approval`（远程瀑布 → dsh-client-ui-approval 面板）vs 插件 `review.json` + `/winstage approve|reject`，无共享 id/状态/清除路径；审批面板优先级 0 会被 `ask_user_question`(1/2) 遮蔽（dsh-client-ui-session/lib/client.js:299-313）。

---

## 7. 本轮全队强制的写纪律（不遵守则产出会消失）

因为 §6.1，**`write`/`edit` 工具的成功返回不构成落盘证据**：
1. 每写一个文件后，必须用 shell 验证真实磁盘：`Test-Path` + `Get-FileHash`。
2. 缺失就落盘：`Copy-Item -LiteralPath "<repo>\.dshstage\staged\<相对路径>" -Destination "<真实路径>" -Force`（工作区外路径在 `.dshstage\staged-ext\`）。
3. 新文件优先直接用 `pwsh` 的 `Set-Content`/`Add-Content`（不经过 `ctx.fs`）。
4. **禁止**对团队报告类文件调用 `/winstage approve|reject` —— reject 对 baseHash=absent 的条目语义未明，可能回退/删除真实文件（task-2 的 Q-B 正在判定）。

## 8. 修正后的范围判定（Lead）

| 用户抱怨 | 判定 | 修复归属 |
|---|---|---|
| 修改规则互相冲突严重 | `enabled:false` 与"仍拦截"并存（§6.1/6.2）；`sandboxMode=undefined` 一节门控多职责（§6.3） | **插件侧可修**（task-5） |
| 暂存机制与原生审批机制冲突 | 两套审批语义无共享 id/状态/清除路径（§6.3） | 插件侧可**减小冲突面**；核侧结构性缺口作为发现上报 |
| 审批条目易错、消不掉、不报错 | 孤儿 `asked` 无 `decided`（核侧）；插件侧批准/拒绝链的静默分支（task-2 Q-C） | 插件侧修"失败必须响 + 可清除"；核侧缺口如实标注 |

---

## 6.4 【用户侧独立复现】harness `edit` = 影子层（与 §6.1 同一机制，字节级证据）

- shell 建基准 `BASE_V1`（sha `1754C2102DF88397`）→ harness `edit` 连续两次都回 `updated successfully` → **harness `read` 看到 `BASE_V3_BY_HARNESS_EDIT_2`，而 shell 读真实磁盘仍是 `BASE_V1`**（长度 / sha / mtime 全未变）；V3 只存在于 `.dshstage\blobs\7d\7dd3048a…`，`review.json` 记为 `op=modify +1/-1 pending=True`。
- 对照：同一文件用 shell 连写两次，每次都**真实生效**。
- 结论：§6.1 的机制被独立复现；**`read`（经 ctx.fs）与 shell 看到的内容不一致** ⇒ 本轮任何"我改了"的断言只认 shell 侧真实磁盘。

## 6.5 【用户提供·新发现 R8】可写面覆盖了沙箱自身

- `Desktop\**` 内下列文件实测**全部可写**：`Start-DshWeb.ps1`（DSH 启动器，36,399 B —— 被真实追加 46 B 后已按原始字节还原、sha256 复原一致、语法解析 0 错误、3080 GUI 仍在线）、`WinStageSandbox\src\capability.mjs`、`README.md`、以及 **`.dshstage\manifest.json` / `review.json`**（暂存与待审元数据）。
- 含义：代理可**篡改暂存/审批元数据与审计记录**（自批、自清、伪造条目），也可改写"下次启动代理的东西" ⇒ 持久化与自毁约束风险。
- **归属判定（必须分清，不许混为一谈）**：
  * `.dshstage` 元数据的自我防护 = **插件侧可修**（`ctx.fs` 层可拒绝或隔离对自身 store 的写入）；
  * `Start-DshWeb.ps1` / 仓库根的 shell 级可写 = **执行器 / 内核层**：插件层的 deny 只挡 `ctx.fs` 工具写，**挡不住 shell 写**（本会话已实测 shell 绕过暂存）。与 [docs/dsh2-需求与验收.md](dsh2-需求与验收.md) H3 结论一致：本机当前不提供内核级隔离。**不得**把插件层防护宣称成"已解决 R8"。
- 追加待查（已派 T2a，Q-E）：`.dshstage/**` **是否被排除在暂存之外**？若未排除，代理对自身 `review.json` 的写入会生成"路径即元数据自身"的候选 ⇒ 自指递归 / 状态损坏，可能正是"审批条目非常容易出错、消不掉"的一条来源。

## 9. 给 T5-verifier 的追加必查项（本轮）

1. 独立复核 §6.1 / §6.4：**以 shell 侧真实磁盘为准**，确认"工具报成功但磁盘未变"是否仍在；修复后若声称已消除，必须给出一条**能 FAIL 的变异体**证明断言有效。
2. 独立复核 §6.5：修复后 `.dshstage` 元数据是否仍能被 `ctx.fs` 工具改写；并如实标注 **shell 层仍可写**（不属于本插件修复范围）。
3. 用户提供的 §14 文件修改测试结论（工作区内语义正确、区外 6 种操作全拒、硬链接旁路失败、`FileShare.None` 解释"暂时删不掉"）——**必要时抽样复现 1–2 条**，不要整段复述。

---

## 10. 本轮已确认根因清单（T2a / T2b / T4 / T1b 交叉确认）+ Lead 范围裁定

### 10.1 用户三句话 ↔ 已确认根因（各带证据来源）

| 用户的话 | 已确认根因 | 证据 |
|---|---|---|
| "审批条目…不报错" | `dsh-plugin/client.js:1370` 读 `value.kind`，而 commands RPC 的 value 是 `{commandId, result}` ⇒ 恒判 success ⇒ 宿主每条 `kind:'error'` 一个字都不显示（`.t/approve-button-selftest.mjs:57` 的字符串断言因此**假 PASS**） | T2a，[插件侧报告](dsh2-冲突诊断-插件侧.md) |
| "消不掉"（面板） | `dsh-plugin/host-plugin.mjs:307` 净 diff 为空时早退 ⇒ `ReviewService.reject()` 专为"空壳 pending"写的清理分支**永不可达**（「拒绝全部」返回 success 而 `pending` 仍 true；绕过 handler 直调 `service.reject()` 立即 `pending:false`） | T2a exp3 |
| "批不掉 / 易出错" | `src/workspace.mjs:632-637` `ensureEntry` 幂等早退**从不刷新 `baseHash`** ⇒ 外部改过即 `STALE_BASELINE` 永久拒绝；叠加"不报错"⇒ 点多少次都没反应 | T2a exp1 |
| "暂存 × 原生审批冲突" | **同槽位互斥**：原生审批卡在场 ⇒ 整块 WinStage 面板消失（`panelPresent=false`、勾选框/按钮全空）、零解释；审批结束面板自动回归且 `review.json` **逐字节未变**。另核侧**两套互不认识的审批语义**（`ctx.approval` vs `review.json`+`/winstage`），无共享 id/状态/清除路径 | T4 R-3；T2b |
| "审批条目消不掉"（核侧） | 审批 pending 时回合被**非正常终结**（重启/崩溃）⇒ 只补合成 `TOOL_OUTCOME_UNKNOWN`+`turn/end{interrupted}`，**不写 `approval/decided`** ⇒ 日志永久孤儿；UI 里**连条目都不再出现**（无入口/无提示/无报错）。T4 活体复现（asked seq104 无 decided，与 T2b 历史样本逐项同构）；且审批 pending 时中断被**设计性禁用**（`dsh-client-ui-conversation/lib/client.js:17774`） | T4 R-5；T2b |
| "规则冲突"（开关） | patch **文件本身正确**（平台 `applyEntryPatches` 组合两份真 YAML 得 `enabled:false`、0 告警）；**3081 上开关实测有效**（改文件不重启 10s 生效 = 热重载有效；重启亦有效）；**3080 仍暂存 ⇒ 另有原因，未定因**：H2 reconcile 静默失败（诊断只进 ctx.logger，本实例不落盘）/ H4 `stagingEnabled()` 读 `rootEntry.parent.data`，而 3080 多两个 bundle | T1b/rig |
| "规则冲突"（配置投影） | `config/enabled` 被平台投影**拒绝**：`volatile fields require a fixed object path without an enclosing volatile field`（`dsh-app-boot:2326`）；只去掉根 `meta.volatile`（`dsh-plugin/schema.js:127`）即 `ok:true` ⇒ **设置页开关根本不可水合** | T2a Q-A |
| R8 自批/自清 | `.dshstage/**` **未被排除在暂存之外**：全仓只有读/批准侧遮蔽（`src/paths.mjs:199` stage-store, hard:true），**写侧零判据**；自指条目出生即 stale ⇒ 批准必然 `SANDBOX_PATH_MASKED_CONFIRM` → `STALE_BASELINE`、`pending` 永久；**`ctx.fs` 读亦无遮蔽** | T2a Q-E |
| 候选无界增长 | `superseded`/`discarded` **无任何清除路径**；`queue.order` 与 `.dshstage/candidates/` 无界增长（活 3080：21 分钟 12 候选；6 次写⇒7 个文件、6 个永久孤儿，而 `listReviews()` 只见 1） | T2a Q-B |

### 10.2 Lead 范围裁定（**覆盖**前文"只改 dsh-plugin/**"）

- **修复写范围**：`dsh-plugin/**` **加上暂存引擎** `src/workspace.mjs`、`src/store.mjs`、`src/paths.mjs`（P0-3/P0-8 的修复点在这些文件里，且 `dsh-plugin/**` 直接 import 它们）。
- **仍不在范围**：执行器/内核侧 —— `src/executor.mjs`、`src/appcontainer*.mjs`、`src/wfp.mjs`、`src/registry-guard.mjs`、`src/cli.mjs`、`src/audit.mjs`、`src/test*.mjs`；改它们需 Lead 逐次批准。
- **用户已拍板**：① `.dshstage` 元数据自我防护**纳入本轮**；② 3080 里那批 ~18 条噪声候选**先别动**。
- **R8 归属**：`.dshstage` 防护 = 插件侧可修；`Start-DshWeb.ps1` / 仓库根的 **shell 级**可写 = 执行器/内核层，**插件 deny 挡不住 shell**（已实测 shell 绕过暂存）⇒ 不得宣称"R8 已解决"。

### 10.3 安全更正（重要，推翻 Lead 先前的提醒）

T2a 实测四种情形：**reject 不会改/删真实文件**（只删清单条目 + 回收 `.dshstage` 内对象，`src/store.mjs:318-324`）；**危险的是 approve**（delete 分支 `rmSync(abs)`）。
⇒ Lead 先前的"不要 reject，可能删除真实文件"**是错的**，现更正为：**对报告文件 approve 才是危险动作**。3080 面板里的那批候选仍按用户裁定"先别动"，但理由从"reject 危险"改为"避免 approve/顺手操作引入无关变量"。

### 10.4 3080 未定因的验证授权（**不碰 3080**）

授权 T1-rig 在**独立 DSH_HOME** 里复刻 3080 的 5-bundle 组合（`dsh-base`、`dsh-web-app`、`dsh-experimental-auto-review`、`dsh-experimental-agent-team-profile`、`@local/dsh-winstage-sandbox`）来验证 H4/H2。**严禁**改 / 重启 / 重载 3080。

### 10.5 需要注意的度量口径（T4 更正）

- `?winstageDebug=1` 的 dump **只在 configForms 视图变化时触发**（`client.js:2066-2090`），页面加载时早于 poller 的 `status:'ready'` ⇒ 默认只看到 `review:{"status":"idle"}`、**看不到 workspaceRoot**；必须用 `dbgwatch` 轮询等迟到的 `changed`（t+3025ms 实测）。凡"三值只剩 idle"的旧结论都应更正为"未测到"。
- 3081 的 `review.json` 是**按会话分区**的路径，不再是单文件。

### 10.6 环境侧变更（需用户知悉）

- rig 为使 3081/CDP 跨回合存活，新增 **WMI 常驻 watchdog**（`.t/dsh2/watchdog.mjs`，parent=WmiPrvSE.exe，不在会话进程树内）与**计划任务 `WinStageSandbox-Keeper`**（每 2 分钟；删除：`schtasks /delete /tn "WinStageSandbox-Keeper" /f`）。它只拉起 3081/edge-keeper，不碰 3080、不碰用户自己的 Edge。
- 根因：**后台作业会在回合结束时被整树回收**（HOWTO §2 的旧结论只在同回合内成立）。
- 本会话 `python` 已不可用（`WindowsApps` 占位符）⇒ 浏览器驱动改用 **Node 24 零依赖 CDP 客户端**（`.t\dsh2\browser\t4.mjs`）。

---

## 11. 环境级陷阱与修复结果（Lead 记录，round 1 收尾）

### 11.1 【实测·高危】`read` 工具会被暂存覆盖层遮蔽，返回**过期内容**
- 证据：`docs/dsh2-审批冲突-需求与验收.md` 真实磁盘 = 21555 B（>208 行，含 §6–§10），而 `.dshstage\staged\docs\dsh2-审批冲突-需求与验收.md` 压着 7708 B / **98 行**（只到 §5）的旧快照。
- 用 **`read` 工具**读该文件 → 返回 **98 行、停在 §5**（旧）；用 **shell `Get-Content`** 读同一路径 → 返回最新全文。
- ⇒ 全队规则：**"经 `read` 读到"的内容一律要用 shell 复核**；本文件已用 `Copy-Item 真实→staged` 同步覆盖层（候选条目内容随之更新；未改动候选清单，遵守用户"先别动"裁定）。
- 同源机制：`write/edit` 写的是覆盖层（§6.1/§6.4），`read` 读的也是覆盖层 ⇒ 覆盖层与真实磁盘**双向分叉**。

### 11.2 【实测】上一轮 4 个断言脚本在本环境**本来就跑不动**（不是本轮回归）
`f2-c8-root-drift` / `f3-outside-default` / `f4-watch` / `stage3-store` 在 `new SandboxedFileSystem` 处抛 `TypeError: … reading 'defaultMode'`（`dsh-fs-sandbox/lib/index.js:108` 读 `ctx.sandboxPolicy`）。
fixer 用 baseline 版 `staging-fs.mjs` 换回再跑 → **同样失败**，随后按 sha256 原样换回（前后 `D08A8EAE…` 一致）⇒ **环境性失效，与 P0 改动无关**。属于"看着有、其实没跑"的测试空洞，建议后续修脚本。

### 11.3 3080 归因的新假设 H5（已派 rig 做安全版判定实验）
- web 的 `cordis.patch.yml` **CreationTime = LastWriteTime = 18:29:48**（**启动后新建**，进程 18:23:41 启动）；`patchReload` 在本构建是**死键**（全量 grep 0 命中）；3081 热重载**有效**，但 3081 的该文件**启动时就存在**。
- **H5**：热重载只对"启动时已存在的 patch 文件"生效；启动后**新建**的文件不被 watcher 接管 ⇒ 3080 的 `enabled:false` 从未被应用，运行树一直是 `enabled:true`。
- 安全红线：实验期间该文件在**任何重启时刻都必须存在**（缺失会让 `winstage-fs` config 回落到 bundle 层项目根锚点 ⇒ INC-1 复现）。

### 11.4 修复结果摘要（T3-fixer 交付，rig 独立复核）
- 改动 6 文件：`client.js`(P0-1 + S3/S5/S6/S7)、`host-plugin.mjs`(P0-2 + S9 + S11–S14 接线)、`src/workspace.mjs`(P0-3)、`schema.js`(P0-6)、`staging-fs.mjs`(P0-8)、`review-service.mjs`(S11–S14)。
- **断言 90/90，每条自带变异体证明**；回归门 `14 套件 / 646 断言 / exit 0`，**基线 = 改后逐项一致**；部署副本 sha256 == 源（rig 独立复核 6/6）。
- 未改 loader 行名 / config 契约 / `review.json` 既有键语义。
- **P0-8 三条边界（必须如实转述）**：① 挡不住 shell ⇒ **不等于解决 R8**；② 只在"插件确实接管该工作区"时生效；③ **读侧未加遮蔽**（`read` 仍能读 `.dshstage/manifest.json`）。
- `warnForeignWorkspace()` 目前是 `info` 级（与"失败必须响"口径不一致），本轮未改。

### 11.5 协作规则（本轮强制）
- **CDP 9222 上的 3081 标签页只由 T4-browser 驱动**；其他角色一律不输入/不点击，需要浏览器证据请 send_message 给 browser。
- 3081 / Edge 的起停**只由 T1-rig** 执行（watchdog 保活中）。

## 12. 给 T5-verifier 的最终必查清单（替换/细化前文 §9）
1. **真实磁盘为准**：任何"文件内容/哈希"证据必须用 shell 取；`read` 有覆盖层遮蔽（§11.1），`grep`(ripgrep)/`node` 看不到覆盖层。
2. **对抗性复核 5 个 P0**：自己重跑 `run-t3.cmd` 与其变异体；并**独立**构造至少 2 条失败输入，证明"失败必须响"是真的（同时确认正常路径**不产生** error 噪声）。
3. **回归门**：自己重跑 `.\autotest.cmd --skip-audit`，与 `.t/dsh2/fix-backup/baseline-20260929-191221/` 逐项比对；§11.2 的 4 个失效脚本**不计入回归**，但要独立确认它们"改前改后一样失败"。
4. **隔离契约四项**：dump-config 根、3081 的 review.json 根、项目根 `.dshstage` 未被本轮改动、3080 未被触碰。
5. **P0-8 边界诚实性**：确认 shell 仍可写 `.dshstage`（即不等于解决 R8），且"不接管工作区"时 P0-8 不生效。
6. **DOM 结论**：browser 的 R-1/R-2/R-3/R-5 结论要交叉核对它的原始证据文件；不要整段复述。

### 13. 3080 症状的最终归因（Lead 收口，结论已经用户侧证据闭合）

**H5（"启动后新建的 patch 文件不被热重载接管"）= 证伪 [实测]**（rig，`logs/s8-18-h5-verdict.txt`）
- 为规避"运行期缺 profile 层 ⇒ cwd 回落项目根 ⇒ INC-1 复现"的风险，rig **没有**按原方案改名 profile 文件，改用**home 层新建文件**这一等价且零风险的变体（`dsh-app-boot/lib/index.js:1023-1028` 层序：bundle → profile → home → overlays；dsh-hmr watch 该路径 `dsh-hmr:353-354`）。
- 结果：启动后新建的受 watch 文件，其 `enabled:false` **确实被热重载接管**（探针落**真实磁盘**、`.dshstage` 下 0 暂存）⇒ H5 不成立。

**收敛到的解释（与 3080 现象逐项一致）**
- profile `web` 的前一版备份 `cordis.patch.yml.bak-winstage-enable-20260929-165400` **不含任何 winstage 行**；当前版（18:29:48 写入）才有 `winstage-sandbox{enabled:false, workspaceRoot=项目根}`。
- 3080 于 **18:23:41** 启动 ⇒ 启动时 profile 层**没有** winstage 覆盖 ⇒ 生效的是 **bundle 层**的 `winstage-sandbox{enabled:true, workspaceRoot=项目根}` ⇒ **正好**解释观测到的两件事：① `enabled` 看似被忽略（其实运行的树里本就是 true）；② 暂存根 = **项目根**（bundle 锚点就是这个值）。
- 18:29:48 的那次写入**是否**在运行树里生效，无法在不触碰 3080 的前提下判定：候选 **H2**（reconcile 静默失败，诊断只进 `ctx.logger`，而 `s8-13` 实测本机 ctx.logger **不落盘** ⇒ 不可观测）与 **H6**（`name` 断言失配 ⇒ cordis `warn+continue` 整条静默跳过，其代码注释与 INC-1 均为此型）。
- ⇒ **结论**：这不是"插件忽略了 `enabled`"，而是**"启动时该覆盖尚不存在 + 运行期生效与否不可观测"**。修复方向已由 P0-6（配置投影可水合）与 P0-8（`.dshstage` 写侧守卫）覆盖一半；**用户若重启 3080，会同时拿到修正后的配置与修复后的代码**（我们**不会**替用户重启）。

**仍未闭环且不打算强行闭环**：H2/H6 二选一无法从外部区分（需要读 3080 运行期 ctx.logger 或重启 3080，两者都被用户约束禁止）。

### 13.1 归因修正（rig 补充测量，**[实测-历史证据]**）
**H6（18:29:48 行名断言失配）已被排除**：`.t\dsh2/**` 内所有 `cordis.patch.yml*` 副本按行名分类显示——`2026-09-28 12:39:42` 的旧副本是旧**子路径名** `@local/dsh-winstage-sandbox/host-plugin`；`2026-09-28 13:55:38` 起（含 baseline 快照与 dsh2 部署副本）**全部是裸包名**；3080 当前断言即裸包名且 mtime 恒为 18:29:48 ⇒ 那一刻断言**应当匹配**，整条覆盖不应被 skip。

⇒ 剩余候选只剩两个，且**在不碰 3080 的前提下都无法证伪**：
- **H7**：3080 进程里 dsh-hmr 实际**没装上 watcher**（`hmr` 行的 `disabled: !!js '!ctx.get("profileContext")'` 求值结果从未在 3080 读到）⇒ 18:29:48 的 add 无人监听。与"3081 的 add 被接管"不矛盾（两进程环境不同）。
- **H2**：那次 apply 抛错，只进 `ctx.logger`（`s8-13` 已实测本机 ctx.logger **不落盘**）。

**给用户的实务结论（可直接采用）**：
1. 插件 `enabled:false` **能**真关掉暂存面——前提是配置**确实被装载**（3081 上 A/B/A/C/D/E 五次探针全证）。
2. 改 `cordis.patch.yml` 后**不要依赖热重载**：保守做法是**重启实例**或用设置页开关，可绕开 H7/H2 两种未知。
3. 判定"开关是否真生效"的唯一可靠方法：做一次经 `ctx.fs` 的 write 探针（rig 已在 3081 做成可复用流程）。

---

## 14. T5 独立复核结论（task-6，Lead 收口）

报告：`.t\dsh2\verify\T5-VERIFY-REPORT.md`（201 行 / 26621 B / sha256 `44DD6C16F07987B9A96F5F25672C8E6A63E91D7D970F8B62A95DAEF50CB5DE26`）

### 14.1 总判定
| 项 | 判定 |
|---|---|
| P0-1 / P0-2 / P0-3 / P0-6 / P0-8 | **PASS（推翻不了）** —— verifier **自造变异体**（不复用 fixer 的 baseline）：P0-1 三处退化各产生 3/1/1 个 FAIL；P0-2 用 baseline `registerCommands` ⇒ `{"kind":"success","text":"没有待审文件","pendingAfter":true}`；P0-3 baseline ⇒ baseHash 停在 v0、0 应用、`["STALE_BASELINE"]`；P0-6 根 volatile 加回 ⇒ 平台逐字拒绝。**"假断言"嫌疑全部推翻** |
| 回归门 | **逐项相同**：14 套件 / 646 ok / 0 bad / exit 0，且逐套件 checks（51/21/24/34/19/84/43/37/125/10/4/172/0/22）与基线一致 |
| 源↔3081 部署副本 sha256 | verifier 独立重算 **14/14 MATCH** |
| 3080 未触碰 | PASS：端口属主 pid 5340 / 起于 18:23:41（早于整轮）；**`~\.dsh` 的部署副本 6 文件与修复版全不相等**（`schema.js` 恰等于 baseline）⇒ fix 从未进 `~\.dsh` |
| 失败必须响 + 阴性对照 | PASS：陈旧批准 ⇒ 命令面 `kind:'error'` 含 `STALE_BASELINE…refusing to overwrite`+64 位哈希；`ctx.fs` 写 `.dshstage/review.json` ⇒ `FS_SANDBOX_DENIED`+error 级日志；**阴性对照**：正常暂存+正常批准 ⇒ 落地成功、logger **0 条 warn/error** |
| P0-8 边界诚实性 | 成立：shell 仍可写 `.dshstage`（≠解决 R8）；"不接管"时守卫不生效、仅 1 条 **info** 级日志 |
| ctx.fs 最小契约 | PASS：13 个 abstract 成员齐备；FsError 语义 6/6（全 `instanceof`）；`watch` 不静默降级（基类不支持时 reject `FS_IO_ERROR`） |
| DOM 层 | P0-1/P0-3 证据充分（**双 rev** `f499f08cc0aa` + `f67f86921c20`）；假 PASS 哨兵检查通过（全精确选择器/AX 精确名） |

### 14.2 ★ 隔离契约第 3 条：**判据本身写错了，已更正**
verifier 按字面判 **FAIL** 并一手归因：项目根 `.dshstage` 在整轮中**确实**变化，`candidates\cs_0078…cs_0085` 的时间戳与 verifier 5 次 `write` 工具调用**逐秒对齐**，同刻出现 `staged\.t\dsh2\verify\v-*.mjs`。
⇒ **原因**：3080 进程装载的是**旧插件**，其 store 就是**项目根 `.dshstage`**，而 `write/edit` 工具写入必然更新它（R19 自指）。
⇒ **更正后的判据**（前文 §3/D2 的"项目根 `.dshstage` 未变"作废）：
1. **只能**断言"**3081 没有写项目根 `.dshstage`**"（用 3081 的 review.json 根 + `--dump-config` 根来证），**不能**断言"整轮项目根未被改动"；
2. s9-02 的 `unchanged:true` 只覆盖重启前后约 14 秒窗口，**不可外推**；
3. `write/edit` 工具在 3080 留下候选是**已知副作用**（用户已裁定"先别动"），不计入回归。

### 14.3 verifier 新发现（K 清单）
| 编号 | 级别 | 内容 | Lead 处置 |
|---|---|---|---|
| **K-1** | **中** | **P0-2 的命令面修复在"纯空壳 pending"下 UI 不可达**：`client.js:310` `winstageElection` 要求 `counts.files>=1`，`:1255 collapsedState`、`:1961 WinStageChip` 要求 `counts.files>0` ⇒ `pending=true,files=0` 时面板与恢复 chip 都不渲染，用户**点不到**「拒绝全部」。browser 独立同结论 | **纳入 v2 修复**：判据放宽到 `pending===true && (files>0 || liveCandidates>0)`；**必须**保持 `files=0 && pending=false` 不产生任何多余 UI（阴性对照） |
| **K-3** | 低 | 失败 notice/rowError **滞留**到下一次操作（`t4-t5-58`：`stale=0` 已可批准，仍显示旧 `STALE_BASELINE` 全文）⇒ 会被误读为"这版仍失败" | **纳入 v2 修复**：状态跃迁时清空 |
| K-2 | 低 | P0-8 路径判定可被 Windows 尾点/尾空格绕过（`.dshstage\review.json.` 等不被拒、进暂存）；但本机它们是**独立文件名**，批准被既有 `SANDBOX_PATH_MASKED_CONFIRM` 拦住，`/winstage reject` 可全清 ⇒ **不能接管 store**，只是字符串判定不严谨 | **不改**，记录为已知残余 |
| K-4 | 低 | "不接管"只有 info 级日志（`warnForeignWorkspace`） | **不改**，记录 |
| K-5 | 披露 | verifier 自己的 5 次 `write` 在 3080 store 留下候选/暂存副本 | 同 §14.2，已知副作用 |

### 14.4 verifier 推翻/纠正的结论（含推翻 Lead）
- **推翻 Lead 的"项目根 `.dshstage` 整轮未变"** ⇒ 见 §14.2，判据已更正。
- 推翻 rig 担心的"新 bundle 下 composer 取不到焦点"：那是探针表达式自身 `SyntaxError`；`vis:false` 是面板占用 composer 槽位，收起后 `vis:true/856×36`、新会话 `t4-t5-32` `landed:true` ⇒ **无回归**。
- verifier 自查并纠正了自己 run1 的 2 条过严断言（"START 锚点唯一"、"C1 缺 fileUrl/contains"是替身基类不全），非产品缺陷。

### 14.5 verifier 仍标 `[未实测]`
纯空心 pending 的 DOM 清场（→ 由 v2 + 定向复测补）；H7/H2；3080 面板是否显示 K-5 那 5 条；真实 `SandboxedFileSystem` 基类上的 watch 端到端（构造不可行）。

---

## 15. K-1 复核：**误报，已撤销**（Lead 独立源码确认）+ 真正的残余

### 15.1 K-1 撤销（Lead 自己查了源码，不是采信 fixer）
- `dsh-plugin/review-service.mjs:637` = `pending: files.length > 0,`；`:641` = `files: files.length,` —— **同一个 `files` 数组的两面** ⇒ `pending === (counts.files > 0)` 是**恒等式**。
- `client.js:408` 的 `if (declaredTotal > counts.files) counts.files = declaredTotal` 只会把 `files` **调大**（截断显示用），不破坏上述方向。
- ⇒ 在 `pending===true` 时 `client.js:310` 的 `counts.files >= 1` **必然通过**，`:1255/:1961` 的 `>0` 同理 ⇒ **面板会渲染（含 `[data-winstage-frozen]` 存档行）⇒「拒绝全部」点得到**。
- fixer 的离线探针（tmpdir）：造"清单条目被回收、候选仍在"⇒ 得到 `pending:true, counts.files:1, frozenOnly:1`（**files=1，不是 0**），与恒等式一致。
- ⇒ **verifier/browser 的 K-1 建立在"纯空壳定义就是 pending=true ∧ files=0"这个前提上，而该前提在构造上不成立**。判据本身无独立作用（`pending===true` 时恒真），是 D1 之前的冗余兜底。
- **裁定**：**不按 K-1 改代码**；改成加"钉死断言"（`p11-hollow-reachable.mjs`）：① 钉住 `pending===true ⇒ counts.files>=1` 且存在 `frozenOnly` 行、两处 UI 门控为真；② **阴性对照** `pending===false ∧ files===0` ⇒ 不产生任何多余 UI。变异体：`frozenOnlyRows = () => []` ⇒ `pending===false ∧ files===0`（证明二者不可能一真一假）。

### 15.2 真正的残余（如实记录，本轮不改）
**`pending=false` 但 `queue.json` 里仍有活候选**（候选的每条 change 都已落盘/已应用）⇒ 面板按设计卸载，**候选在存储里永久残留、用户既看不见也清不掉**；叠加 T2a §7.2/§7.8 已证的"`superseded`/`discarded` 无任何清除路径 ⇒ `queue.order` 与 `.dshstage/candidates/` 无界增长"。
⇒ 这才是"消不掉"的**最后一格**，属于**store 生命周期设计缺口**，不是 P0 修复的回归、也不在本轮 `dsh-plugin/**` 补丁范围内。
**建议（v3，待用户决定）**：在 `publish()`/reconcile 时自动回收"全部 change 已应用"的候选，或提供 `/winstage prune`；两者都要有"无残留候选时不得产生多余 UI/日志"的阴性对照。

### 15.3 v2 范围（Lead 裁定）
- **V2-1（K-1）**：**撤销**，改为加钉死断言（见 15.1）。
- **V2-2（K-3，notice/rowError 滞留）**：**批准实施**，只改 `dsh-plugin/client.js`（新增纯函数 `pruneResolvedFailures` + `:687` 处 publish 前调用）。守门断言 B 组：**仍陈旧时 notice/rowError 必须原样保留**（防 P0-1 回归）；A 组：再暂存/rebase 后陈旧解除 ⇒ 清空。
- K-2（Windows 尾点/尾空格绕过 P0-8 字符串判定，不能接管 store）、K-4（"不接管"仅 info 级）：**不改**，记录。
- browser 的"失败不再进 chat 回显"：fixer 给出**反例**（`t4-t5-12`、`t4-t5-22b` 的 `dom.body` 内含 transcript 回显）⇒ 按"未复现/待 browser 补确切证据"处理，交 v2 定向复测裁定。

---

## 16. v2 裁定（Lead，第二轮）

### 16.1 V2-1 选项：**α + β 批准；γ 暂缓**
- **α（必做，零风险）**：不改行为，用 `p11-hollow-reachable.mjs` 把 D1 不变式 `pending === (counts.files > 0)` **钉死**：A 组断言 hollow 态 `pending===true ∧ counts.files>=1 ∧ frozenOnly>=1 ∧ files[] 含 frozenOnly===true`，且 `client.js:310/:1255/:1961` 三处门控为真；变异体 `frozenOnlyRows = () => []` ⇒ `pending===false ∧ files===0`；**B 组（阴性对照）** 无净 diff 且无候选 ⇒ `pending===false ∧ files===0 ∧ frozenOnly===0 ∧ files[] 空` ⇒ 三处门控为假、**不产生任何多余 UI**。
- **β（批准）**：把 `client.js:310` 的 `counts.files >= 1`、`:1255`/`:1961` 的 `counts.files > 0` **收敛为 `pending === true`**（今日行为等价，防未来 `pending` 与 `files` 被解耦）。变异体断言：合成快照 `{pending:true, counts:{files:0}}` ⇒ 新代码**通过**、旧代码**失败**；`{pending:false, counts:{files:0}}` ⇒ 两者都失败（阴性对照）。**必须**同时跑 `.t/f6-slot-election.mjs`（12/12）与全量门确认无回归。
- **γ（暂缓）**：让"`pending=false` 但仍有活候选"的**孤儿候选**可见可清，需要往 `review.json` 加字段（`liveCandidates`/`queuePending`）并可能改 `review-service.mjs` / `host-plugin.mjs`。本轮**不做**，记为 **v3 候选**（见 §15.2）。理由：用户本轮的目标是"消不掉/不报错"，而该状态**面板上本来就没有可审的东西**（卸载是设计），把 store 生命周期改动塞进本轮会显著放大回归面。

### 16.2 V2-2（notice/rowError 滞留）：**批准**，只改 `dsh-plugin/client.js`
- 最小补丁：新增 `#region failure-prune` 纯函数 `pruneResolvedFailures()`、`store.failureRows` 记账（只加键）、`:687` publish 前调用。
- 断言 `p10-notice-prune.mjs` 六组 A–F；**B 组是 P0-1 守门**（仍陈旧时 notice/rowError 原样保留）；D 组覆盖 Lead 追加的"批准/拒绝后也要清"。
- **不动**选举/槽位/`#region failure-map`/`#region approve-command`/任何 `data-winstage-*` 标记。

### 16.3 browser 两处撤回（均已确认，采用**耐久记录**）
| 撤回项 | 正确判据 | 新证据 |
|---|---|---|
| §1 表格 R-1/P0-2 行 + §4「纯空壳在 UI 上不可达」 | `review-service.mjs:637` `pending: files.length > 0` 与 `:641` `files: files.length` 同一赋值两面 ⇒ `pending===true ⇒ counts.files>=1`；`:604-611` 的 D1 不变式逐字写"有活候选 = 面板上一定看得见" | 源码 + fixer 的 tmpdir 探针（`files:1, frozenOnly:1`） |
| §2.3 附注 + §9-2「失败不再进 chat 回显」 | **检测器假阴性**：`wsecho` v1 要求单元素 `textContent` 以 `winstage 已` 开头，而 transcript 把它渲染成分开的节点 | `t4-t5-66-corrected-echo-wsecho.json`（`bodyEcho`/`rows` 均抓到失败回显全文） |
- **耐久记录方式：采用方案 A** —— 在 `.t\dsh2\browser\t5-postfix-retest.md` 末尾**追加** `## 12. Erratum` 一节（原文一字不动，给出新 sha）。
- fixer 的 V2-1 分析被**三处独立确认**（Lead 源码、browser 自查、fixer 探针）。

### 16.4 方法论教训（记入本项目）
**任何"按定义"的状态断言，必须先构造或证明其可达性。** K-1 是**两位复核者共用的同一个未验证前提**（"纯空心的定义就是 `pending=true ∧ counts.files=0`"）造成的误报：verifier 与 browser 都写了"未构造出"，却都把它当成可达缺陷上报。本轮因此多花了一个来回。今后：**判"某状态不可达"或"某状态不可用"时，先给构造脚本或恒等式证明。**

---

## 17. v2 落盘结果（T3-fixer，Lead 已核）

### 17.1 改动面（机械证据：只有 `client.js` 变）
| 文件 | v2 sha256 (前 16) | 相对 v1 |
|---|---|---|
| `dsh-plugin/client.js` | **`B86330DFF968E76D`** | **CHANGED**（`B774A114…` → `B86330DF…`；114724 → 119549 B） |
| `dsh-plugin/host-plugin.mjs` | `F952475457A631F5` | 逐字节相同 |
| `dsh-plugin/review-service.mjs` | `74FB71F28E5A1D4E` | 逐字节相同 |
| `dsh-plugin/schema.js` | `20B6B5C19FBDEF6E` | 逐字节相同 |
| `dsh-plugin/staging-fs.mjs` | `D08A8EAE20556819` | 逐字节相同 |
| `src/workspace.mjs` | `55E142B52D2DE990` | 逐字节相同 |

Lead 独立复核确认：6 个里 **5 个哈希未变、只有 `client.js` 变** ⇒ 符合"只改 `client.js`"的授权。

### 17.2 断言与回归门
- **V2-2** `p10-notice-prune.mjs` **11/11**（A–G + 3 变异体）；其中 **B 组（仍陈旧 ⇒ 原样保留）** 与 **C 组（失败路径本来不在面板 ⇒ 保留）** 是 P0-1 的守门断言。
- **V2-1(α+β)** `p11-hollow-reachable.mjs` **14/14**（含 B 组阴性对照、β 的合成快照等价性、变异体）。
- `run-t3.cmd` **90/90**；`.\\autotest.cmd --skip-audit` = **14 套件 / 646 ok / 0 bad / exit 0**，与基线逐项一致；`f6-slot-election.mjs` **12/12**、`collapse-selftest.mjs` PASS、13 个 `.t` 自测全过。

### 17.3 第 4 处门控（Lead 裁定：**保留 fixer 的收敛**）
fixer 实施时发现除 `:310/:1255/:1961` 之外还有**第 4 处同表达式**（旧 `:734`，喂给 `nextDismissed()` 的"默认收起"消耗判定），并**一并收敛**为 `pending === true`。
- **裁定：保留。** 理由：① 与另三处是同一条判据，`pending===true ⇒ files>=1` ⇒ **行为等价**（不触发"非等价即停手"条件）；② 留着会成为同一判据的第五种写法。
- 已加断言钉住：shipped 源码里 `Boolean(snapshot && snapshot.pending === true)` 恰 **3** 次、旧写法 **0** 次；`winstageElection` 条件恰为 `!snapshot || snapshot.pending !== true`。
- 风险实测：`f6-slot-election` 12/12、`collapse-selftest`（直接覆盖 `nextDismissed`）PASS。

### 17.4 仍未动（如实）
γ（孤儿候选可见可清，需改 `review-service.mjs`/可能 `host-plugin.mjs`）、K-2（Windows 尾点/尾空格别名）、K-4（"不接管"仅 info 级）**本轮不改**。

### 17.5 收尾流水线（Lead 跟踪）
`fixer 已请 rig sync+restart` → rig 回执（新 pid/token + 四条验收 + 源↔部署 6/6 MATCH）→ **browser 定向复测**（① 陈旧解除 ⇒ notice/rowError 消失；② 仍陈旧 ⇒ 不消失；③ 成功路径 notice=0；④ `files=0 && pending=false` 无多余 UI；⑤ hollow 下「拒绝全部」可点；⑥ β 门控等价性）→ **verifier v2 delta 复核**（唯一性、独立变异体、回归门、源↔部署）→ Lead 终答。

---

## 18. T5 v2 delta 复核结论（task-6 重开）+ 残余登记

报告：`.t\dsh2\verify\T5-VERIFY-v2-DELTA.md`（15369 B）；harness `.t\dsh2\verify\v2-delta.mjs` → `v2-delta-report.txt` **38 PASS / 0 FAIL**。

### 18.1 逐条判定（verifier 独立重算，不复用 fixer 结论）
| 项 | 判定 | 依据 |
|---|---|---|
| v2 唯一性（6 哈希只有 `client.js` 变） | **PASS** | 逐个重算；`client.js=B86330DF…`，其余 5 个 == v1 全哈希 |
| diff 只落在 V2-1/V2-2 | **PASS** | `git diff --no-index`：3 hunk / +74 / −2；4 处门控 + 1 处 store 键 + 1 处 prune region + 3 处接线，无夹带 |
| 它**自造**变异体打 B/C 守门 | **PASS（断言能 FAIL）** | M1→打破 G1（P0-1 守门）；M2→打破 G3（不在面板守门）；M3→打破 G1+G4 |
| 四处门控逐处改回 `counts.files>0` | **PASS** | site0/1/2/3 各自使同一合成输入 `{pending:true,files:0}` 翻假 ⇒ **四处都承重** |
| `p11` 阴性对照非空转 | **PASS** | 真空现场门控=假；伪造 `pending:true` 后=真 ⇒ 伪造必然让对照 FAIL |
| 回归门 | **PASS** | 14 套件 / 646 ok / 0 bad / exit 0，**逐套件 SAME=True**；`run-t3` 90/90；`f6-slot-election` 12/12 |
| 源↔3081 部署 == v2 | **PASS** | 6/6 逐文件 sha256；**其余 8 个未改文件也 deploy==源** |
| P0-1 守门（V2-2 不许抹掉仍成立的失败） | **PASS（离线）** | 连续三轮轮询 `dropped` 恒 0、notice/failures 原样；ready 分支只在 `dropped>0` 才覆盖 |
| 阴性对照（正常路径 0 warn/error + 无多余 UI） | **PASS** | `failures` 为空时 prune 返回**同一引用** ⇒ 无 publish 抖动 |
| K-1 撤回 | **撤回成立** | verifier **自造真实 hollow**：`pending=true ⇒ counts.files>=1`（挂 frozenOnly 行）；抽掉该来源 ⇒ `pending=false ∧ files=0` ⇒ `(pending:true,files:0)` **不可满足** |

**verifier 声明：v2 没有可被推翻的断言；它推翻的是自己的 v1 K-1，并接受新纪律"按定义的状态断言必须先构造或证明可达性"。**

### 18.2 §J 那格 `[未实测]` 已被 browser 证据关闭（Lead 亲自核字段）
`t4-t6-*`（19:47–19:48，v2 部署后、双 rev 无关）：
| 证据 | 场景 | notice | rowError | stale |
|---|---|---|---|---|
| `t4-t6-08-gate-still-stale` | 失败后**仍陈旧** | **1** | **1** | 3 |
| `t4-t6-09-gate-after-wait` | 仍陈旧 + 再等一轮 | **1** | **1** | 3 |
| `t4-t6-12-resolved` | 再暂存使陈旧解除 | **0** | **0** | 2（面板仍有行） |
| `t4-t6-13-resolved-wait` | 已解除 + 再等一轮 | **0** | **0** | 2 |
| `t4-t6-05-staged` | 成功路径阴性对照 | 0 | 0 | 0 |
⇒ ① "解除 ⇒ 消失" 与 ② "仍陈旧 ⇒ 不消失"（P0-1 守门）**双向在真实 DOM 上成立**，且 0 不是"面板整体卸载"造成的假 0（仍 3 个 checkbox、`stale:2`）。与 verifier PART 5 的轮询模拟**独立同结论**。

### 18.3 残余登记（本轮不改，如实交付）
| 编号 | 级别 | 内容 | 处置 |
|---|---|---|---|
| **K-3b** | 低 | **多行失败时的"部分滞留"**：`failures` 有 2 条而只解除 1 条时，`next.size=1`，函数**原样返回 notice**（保守口径）⇒ 已解除那行的文案仍留在**聚合 notice** 里（逐条 `rowError` 已摘掉）。⇒ v2 修好的是"完全滞留"，**未完全修好"部分滞留"** | 记为残余；建议后续把聚合 notice 也按行重建或改为由 `failures` 派生 |
| K-2 | 低 | P0-8 字符串路径判定可被 Windows 尾点/尾空格别名绕过（不接管 store、可被既有 `SANDBOX_PATH_MASKED_CONFIRM` 拦住、`/winstage reject` 可清） | 记残余（§17.4） |
| K-4 | 低 | "不接管"只有 `logger.info` 级 | 记残余 |
| γ | — | `pending=false` 但仍有活候选的**孤儿候选无界增长** | v3 候选（§15.2） |
| **FR** | 脆弱点 | `store.failureRows` 目前**只有一个写入点**（`client.js:1371`）；若未来有路径直接 `publish({notice})` 而不经 `showFailure`，`failureRows` 会与 `notice` 失同步（prune 退化为"永不清"） | **加一条断言钉住"写 notice 必须同时写 failureRows"**（证据文件层，不需重部署） |

### 18.4 verifier 的其余 3 条 FAIL（v-independent 45 PASS / 3 FAIL）分类：**0 条是 v2 回归**
1. `p01` 断言脚本的 START 锚点健壮性（`.then` 出现 2 次）⇒ fixer 已把 START 收紧为含 `Promise.race(` 上下文的唯一锚点，并对 START/END **各加唯一性硬断言**（不再"取第一个碰巧对"）；`p01` 6/6、`run-t3` 90/90 不变，产品代码未动。
2. verifier 的 `T5 C1` 枚举只查 **own** 属性 ⇒ 把继承的 `contains`/`fileUrl` 误报缺失；与本轮无关。
3. `T5` 状态机第 13 条 = K-2 别名旁路（已登记）。

---

## 19. verifier 追加发现 FR-2（**V2-2 引入的窄回归**）→ 裁定：修，做 v2.1

来源：`.t\dsh2\verify\v2-fr-notice.txt`（6 PASS / 0 FAIL，verifier 独立枚举 shipped `client.js` 的全部 `store.publish` 调用点 + 确定性构造）。

### 19.1 事实（verifier 原话与原始枚举）
- shipped `client.js` 里 **5 处** `store.publish({ notice: … })` **不设** `failures`：`:1915`（`commandNoOp`）、`:1927`、`:1937`、`:2003`、`:2005`（菜单 `run()` 与 S6 路径）；它们**也都不写** `store.failureRows`（全仓该赋值仅 `:1371` 一处）。
- 确定性构造（2-2）：先有一次失败 ⇒ 随后**泛化 notice** 被 publish（`failures`/`failureRows` 仍是旧值）⇒ 该 path 离场使 `next.size===0` ⇒ prune 把**刚刚显示的泛化 notice 清成 `undefined`**（约 1.5 s 后）。
- 对照（2-3）：若那 5 处 publish **同时清空 `failureRows`** ⇒ 泛化 notice **被保留**（差异可观测）⇒ 修法有确定判据。
- verifier 定性：**窗口很窄、非数据损坏，但属 V2-2 引入的逻辑不一致**。

### 19.2 裁定：**修**（不当作可接受残余）
理由：① 这是**我们自己的修复引入的回归**；② 它落在用户的核心诉求"**不报错/不静默**"同一族（静默丢掉一条仍在显示的提示）；③ 修法已由 verifier 的对照给出确定判据；④ 成本是一次小的 `client.js` 改动 + 复测。

### 19.3 v2.1 范围（Lead 严格限定）
- **只改 `dsh-plugin/client.js`**：把那 5 处"只设 notice"的 publish **统一走一个极小 helper**，语义与 `act()` 开头一致（新消息取代旧的失败态）：设 notice 的同时**清空 `failures` 与 `failureRows`**（清 `failureRows` 使 prune 提前早退 ⇒ 泛化 notice 不被误清；清 `failures` 避免旧行错误滞留）。
- **不得**触碰 `:1372` 的成对写（showFailure）与 `:751` 的 prune 调用点；**不得**削弱 P0-1 守门（仍陈旧 ⇒ notice/rowError 必须保留）。
- **断言（替换 p12 的"计数绊线"为真不变式）**：凡 `store.publish` 设 `notice` 而不设 `failures` ⇒ **必须同时重置 `failureRows`**；反之成对写必须成对。变异体：删掉任一 reset ⇒ FAIL；新增第 N 处直写 notice 而不 reset ⇒ FAIL。
- **新增定向断言**（复刻 verifier 2-2/2-3）：失败 → 泛化 notice → 该 path 离场 → 轮询后**泛化 notice 必须仍在**；对照（不 reset 时）必须消失。
- 回归门：`run-t3`（106 + 新增）全绿、`.\\autotest.cmd --skip-audit` 14 套件 / 646 ok / 0 bad / exit 0 逐项一致；`node --check`。
- 流程：改前快照 → 真实磁盘补丁器 → 请 rig `sync+restart` → 请 browser 定向复测（泛化 notice 保留 + P0-1 守门 + 解除后清空 三条同时）→ **verifier v2.1 delta 复核** → Lead 终答。

### 19.4 其余残余（本轮仍不改，如实交付）
K-3b（多行失败的部分滞留，低）、K-2（Windows 尾点/尾空格别名，低）、K-4（"不接管"仅 info 级，低）、γ（孤儿候选无界增长，v3 候选）。

---

## 20. rig 报的 p10 异常：Lead 独立裁定 = **过期测试，不是产品回归**

### 20.1 一手证据（Lead 直接从源码读出，不采信任何转述）
- shipped v2.1：`dsh-plugin/client.js:551` = `function pruneResolvedFailures(failures, failureRows, notice, failureNotice, snapshot)` —— **5 个参数**（`failureNotice` 插在第 4 位，`snapshot` 被挤到第 5 位）。
- 旧测试：`.t\dsh2\fix-asserts\p10-notice-prune.mjs:48-50` = `function run(failures, failureRows, notice, snapshot) { return factory(failures, failureRows, notice, snapshot) }` —— **4 个实参**。
⇒ `snapshot` 被当成 `failureNotice` 传入，真正的 `snapshot` 为 `undefined` ⇒ `rows = []` ⇒ `present` 为空 ⇒ `leftPanel = wasOnPanel && !present.has(path)` 对**每一条** tracked path 都为真 ⇒ **一切都被 drop**。

### 20.2 该假设**逐条**解释 6 个 FAIL（无残余）
| p10 组 | 期望 | 实测 | 由 arity 错位解释 |
|---|---|---|---|
| B（★仍陈旧不许清） | `dropped=0` | `dropped=1, size=0` | `present` 空 ⇒ `leftPanel` 恒真 |
| E（非陈旧类失败不许丢） | `dropped=0` | `dropped=1, size=0` | 同上 |
| A / D | `notice=undefined` | `dropped=1` 但 notice 保留 | `ownsNotice` 要求 `typeof failureNotice==='string'`，而它收到的是对象 ⇒ 永不 owns |
| G | `dropped=1`、只留 p2 | `dropped=2, keys=[]` | 同上 |
| M1a | `dropped=0` | `dropped=1` | 同上 |
⇒ **裁定：(i) p10 是过期测试**；**不是** run-t3 未覆盖的真实回归。`run-t3` 当时 111/111 与它不矛盾（**p10 根本不在 `run-t3.cmd` 里**）。

### 20.3 附带暴露的过程缺陷（必须修）
**p10 是一个"不在入口里"的测试** —— 与 verifier 早先发现的 4 个环境性失效脚本同属"看着有、其实没跑"的类别。修法（证据层，**不需要重部署**）：
1. `p10` 的 `run()` 改为 v2.1 的 **5 参**顺序，并按新的所有权语义更新期望（A/D 仅在 `ownsNotice` 成立时才清 notice；B/C/E 不变；G 部分解除保留 notice）；
2. **把 `p10` 加进 `run-t3.cmd`**，使入口总数从 111 升到 111+p10，并报新总数；
3. 变异体重跑，确认仍能 FAIL。

### 20.4 流程结论
v2.1 的**产品代码无需任何改动**（`client.js` 仍 `CFA04FDD8EEA6818…`），也**不需要 sync/restart**。rig 的独立复跑抓到了一个"测试腐坏"而非"产品回归"——这正是它该做的事，记录在案。

---

## 21. v2.1 (v3) delta 复核结论（T5，task-6 第二次重开）

报告：`.t\dsh2\verify\T5-VERIFY-v2-DELTA.md`（39296 B；新 sha256 `AC198721277DD41AFCDFDA82AF072117D95BC0F762187F472A98846C74D47CA6`；§N 为纯追加）。

### 21.1 总判定：**通过**
| 项 | 判定 |
|---|---|
| verifier 自己的验收门 `v21-acceptance.mjs` | **PASS 10/0**（v2 基线 7/2，FAIL 恰在 A 组）⇒ 门可证伪且已被修复关闭 |
| 唯一性 + diff 归因 | PASS：只 `client.js`=`CFA04FDD8EEA6818` 变，其余 5 个与 v2 逐字节相同；diff **5 hunk / +27 / −3**，全部为方案 B（`failureNotice` 键 + `ownsNotice/clearNotice` + 调用点传参 + `showFailure` 记账），**无夹带** |
| verifier 自造 5 个变异体 | PASS 11/0：M1/M2/M5 打破 A1；**M3（删记账）/M4（漏传参）打破 C1** ⇒ 三个承重点各自可证伪 |
| 回归门 | `autotest` **14/646/0/exit0 逐套件 SAME=True**；`run-t3` **123/123 exit0**；p10 12/12、p12 14/14、p13 7/7、p11 14/14、f6 12/12 |
| 源↔3081 部署 | **6/6 + 另 8 个未改文件也 MATCH**；3081 pid 1456；dump-config 根正确、**0 告警** |
| DOM E1/E2/E4 | **PASS**（逐字核 browser `t4-t7-*` 原始件，非采信转述） |
| DOM E3 / V2-1β⑥ | `[未实测]` |

### 21.2 p10 定因：verifier **独立确认**了 Lead 的裁定
`v21-p10-argorder.mjs` 同场对比 shipped 切片：**5 参 6/6 全对**；**4 参恰好 6 个 FAIL**，与 §20.2 描述的形态逐条一致（A/D notice 被保留、B/E/M1a `dropped=1,size=0`、G `dropped=2,size=0`），**无残余** ⇒ **测试腐坏，非产品回归**。fixer 已把 `p10:56-59` 改为 `factory(failures, failureRows, notice, notice, snapshot)`。

### 21.3 过程缺陷（verifier 追加，Lead 采纳）
- `run-t3.cmd` 已纳入 **p10/p12/p13**（9 脚本）；但 **`p11-hollow-reachable.mjs` 与 `f6-slot-election.mjs` 仍不在入口** —— 与早先"4 个失效脚本看着有、其实没跑"同类。**裁定：一并纳入入口**（证据层改动，不涉及产品代码、不需重部署）；若某脚本 harness 形态不同，就在 `run-t3.cmd` 里显式登记其调用路径与理由，**不许留在"无人调用"状态**。
- fixer 的入口计数口径：`90（p01/p02/p03/p06/p08/ps11-s14）+ p10 12 + p12 14 + p13 7 = 123` —— 与 verifier 实测 123 一致（verifier 提到"差 12"时 p10 与 ps11-s14 恰好都是 12，按上式为准确口径）。
- verifier 自纠一处：其 A 组枚举把 `client.js:282`（**注释里**的 `store.publish({notice})`）误计为 publish 点，已排除；方案 B 不改那 5 处直写点是**预期设计**（门探测：A=false / B=true）。

### 21.4 DOM 证据（E 组）
- **E1 PASS**：`t4-t7-08-gate-3s` / `t4-t7-09-gate-7s` 均 `panelPresent=true / cb=3 / notice=1 / rowError=1 / stale=3`，notice 含 `t7-a.txt: STALE_BASELINE … refusing to overwrite` + 64 位哈希，跨 ≥4.3 s 不变。
- **E2 PASS**：`t4-t7-20-resolved` / `t4-t7-21-resolved-wait` 均 `notice=0 / rowError=0 / stale=2`、面板与 3 个 checkbox 仍在 ⇒ **选择性修剪**（非卸载假 0）；结构侧 `t7-a.txt:stale` true→false、`staleBaseline` 3→2、rev 6→8。
- **E4 PASS**：`t4-t7-03-empty`（`files=0 && pending=false` ⇒ panel=0/notice=0）、`t4-t7-24-success`（notice=0/rowError=0）、`t4-t7-32-clean`（reject-all 后面板消失、notice=0）。
- **E3 `[未实测]`**：t7 未触发 S5 `run()` 无会话/无命令面分支或 S6 关闭失败分支 ⇒ 泛化 notice 在 **UI 上不可确定性触发**；由 A1 + `p13`(7/7，真实切片) 离线确定性覆盖。**V2-1β⑥ 按裁定保持 `[未实测]`**（不扰动 `.dshstage` 内部）。
