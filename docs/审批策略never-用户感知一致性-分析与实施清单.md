# 审批策略 `ask → never` / 文件策略 `workspace-write → danger-full-access`：WinStage 用户感知一致性分析与实施清单

- 定位：**侦察（recon）**。本文件是本次分析唯一的产出；**未修改任何源码、测试、配置或既有文档**。
- ➜ **实施结果见第 5 节**（由后续实施会话（C1+C2+C3）追加；第 0–4 节原样保留、未改动一个字）。
- 仓库：`C:\Users\Administrator\Desktop\WinStageSandbox`（下文行号以本工作区为准）。
- Harness 只读参考：`C:\Users\Administrator\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`（下文以 `R\` 代指该路径）。
- 用户诉求原文：**「尽量保证用户感知的行为一致」**。
- 本会话实测环境：`DSH_HOME=C:\Users\Administrator\.dsh`、`DSH_PROFILE=web`、`DSH_SESSION_ID=aa3a2635-…`；
  `DSH_PERMISSION_MODE`（空=未设）、`WINSTAGE_SHELL`（空=未设）、`WINSTAGE_STAGE_OUTSIDE`（空=未设）。

---

## 0. 先把"策略是怎么变的"钉死（后续结论的前提）

任务描述里的"审批策略 `ask→never`"与"文件策略 `workspace-write→danger-full-access`"在 DSH 里有**两条互斥的实现路径**，后果不同，必须先分辨：

| 机制 | 证据 | 本会话是否命中 |
|---|---|---|
| **A. 会话级预设切换**：`PermissionPresetService.apply()` 依次追加 `permission/preset` → `sandbox/mode` → `approval/policy` | `R\dsh-permission-presets\lib\index.js:344-361`（`:359` 写 preset、`:356` 写 sandbox、`:357` 写 approval）；`R\dsh-permission-presets\lib\index.js:144-157` 的 `danger-full-access = {sandbox:'danger-full-access', approval:'never'}` | **[实测] 是。** 父会话 `session-364215a1-…` 日志：`seq578 permission/preset=danger-full-access`、`seq579 sandbox/mode=danger-full-access`、`seq580 approval/policy=never`（前 577 条为 `seq0 preset=workspace-write` / `seq1 sandbox/mode=workspace-write` / `seq2 approval/policy=ask`） |
| **B. 部署级环境开关**：`DSH_PERMISSION_MODE=danger-full-access` 同时决定 `sandboxPolicy.defaultMode` 与 `ApprovalService.config.policy` | `R\dsh-base\cordis.patch.yml:232` `mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`；`:248` `policy: !!js "(…?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"` | **[未验证] 未命中（本会话 `DSH_PERMISSION_MODE` 为空）**，但基座 bundle 支持这条路，且它与 A 的用户可见后果不同（见 Q4） |

**子会话继承**：`R\dsh-subagent\lib\index.js:535-541` `captureDelegatedPolicyOverrides()` —— `sandboxMode` 只取**父会话显式 override**（`:539`），而 `approvalPolicy` **无条件钉成 `'never'`**（`:540`，注释见 `:531`），再由 `:552-562` 以 `source:'delegation'` 写入子会话日志。
本会话日志实测：`seq1 sandbox/mode=danger-full-access(source=delegation)`、`seq2 approval/policy=never(source=delegation)`、`seq3 permission/preset=danger-full-access` ⇒ 与上述代码逐条吻合。**[实测]**

实测命令（probe 脚本**复制到 `%TEMP%` 后运行**，仓库内 `.t\approval-probe.txt` 未被改写，mtime 仍为 2026-09-28 12:22:34）：

```powershell
Copy-Item .t\approval-probe.mjs $env:TEMP\winstage-recon -Force
cmd /c "node %TEMP%\winstage-recon\approval-probe.mjs <最新 8 个 session.v4.jsonl.zstd>"
```

关键输出（原文）：

```
=== …\session-364215a1-…\session.v4.jsonl.zstd
   审批类事件: approval/policy=2      权限/模式事件: permission/preset=2, sandbox/mode=2
   {"type":"approval/policy","seq":2,  "data":{"policy":"ask"}}
   {"type":"approval/policy","seq":580,"data":{"policy":"never"}}
   {"seq":578,"type":"permission/preset","data":{"preset":"danger-full-access"}}
   {"seq":579,"type":"sandbox/mode","data":{"mode":"danger-full-access"}}
=== …\aa3a2635-…\session.v4.jsonl.zstd        （本会话）
   审批类事件: approval/policy=1      权限/模式事件: sandbox/mode=1, permission/preset=1
   {"type":"approval/policy","seq":2,"data":{"policy":"never","source":"delegation"}}
   {"seq":1,"type":"sandbox/mode","data":{"mode":"danger-full-access","source":"delegation"}}
   {"seq":3,"type":"permission/preset","data":{"preset":"danger-full-access"}}
=== …\3b39f005-…（另 3 个同目录会话同形）
   审批类事件: approval/policy=1      权限/模式事件: sandbox/mode=1
   {"type":"approval/policy","seq":2,"data":{"policy":"never","source":"delegation"}}
   {"seq":1,"type":"sandbox/mode","data":{"mode":"workspace-write","source":"delegation"}}   ← 注意：workspace-write + never
=== …\session-8a1a9290-…（对照：ask 下的升权）
   审批类事件: approval/policy=2, approval/asked=7, approval/decided=7
   {"type":"approval/policy","seq":2,"data":{"policy":"ask"}}
   {"type":"approval/asked","seq":60,"data":{"id":"1146…","toolName":"pwsh","callId":"call_00_cWLB…",
     "reason":"escalate sandbox to danger-full-access: browser-use.exe lives outside the workspace…"}}
   {"type":"approval/decided","seq":61,"data":{"outcome":"allowed-once"}}
   （共 7 对，全部 allowed-once）
```

---

## 1. 证据表（5 个问题）

### Q1. `conversation.input.permission` 槽位在 `approval:'never'` / `danger-full-access` 下是否仍然存在并渲染？

**结论：仍然存在、仍然渲染；平台条目照旧注册；WinStage 的接管判据与审批策略无关。⇒ 不存在"面板消失"这一硬断裂。**（另有一条**条件性**硬断裂，见 Q4-(a)）

| # | 事实 | 证据 | 置信度 |
|---|---|---|---|
| 1.1 | 槽位由会话客户端声明为 **single / scope=session**，声明处**没有任何** approval/沙箱模式条件 | `R\dsh-client-ui-conversation\lib\client.js:18305-18308`：`"conversation.input.permission": { kind: "single", scope: "session" }`；类型契约 `R\dsh-client-ui-conversation\lib\types\client\contract\slots.d.ts:264` | [实测]（读码） |
| 1.2 | 渲染调用**无条件**（只判断 `sessionId`） | `R\dsh-client-ui-conversation\lib\client.js:17522`：`sessionId === void 0 ? null : renderSlot("conversation.input.permission", { locked })`（祖先 `div` 在 `:17494` 带 `hidden: activity`，与策略无关） | [实测]（读码） |
| 1.3 | 平台条目**无条件**注册（不看审批策略） | `R\dsh-client-ui-permission-presets\lib\client.js:815-822`（`ctx.slots.register({name:'conversation.input.permission',…}, PermissionSelect)`），位于 `apply(ctx)`（`:769`）内；依赖清单 `:731-742` 与 approval/策略无关 | [实测]（读码） |
| 1.4 | 平台控件自身只在**投影或目录缺失**时返回 `null`，与策略无关 | `R\dsh-client-ui-permission-presets\lib\client.js:324`：`if (selection === void 0 || catalog === null) return null;` | [实测]（读码） |
| 1.5 | single 槽位"最低 priority 渲染"，WinStage 注册 `-10` ⇒ 开关开时遮蔽平台条目 | `R\dsh-client-ui-slots\lib\index.js:221`（single 按 priority 升序）、`:168`（`register at a different priority to shadow it (lowest renders)`）；WinStage `dsh-plugin\client.js:63`（`PERMISSION_PRIORITY = -10`）、`:2477-2486`、`:2500-2510` | [实测]（读码 + 自测） |
| 1.6 | WinStage 的接管/撤销真值只读**自己的开关**（三态），与审批策略无关 | `dsh-plugin\client.js:333-357`（`readSwitch`）、`:2501-2510`（`readEnabled = () => readSwitch(form) === 'on'`） | [实测]（读码） |
| 1.7 | 离线自测实测：槽位遮蔽/恢复、三态真值、变异自证全部通过 | `cmd /c "node .t\permission-slot-selftest.mjs"` ⇒ `PASS=45 FAIL=0 PENDING=0 EXIT=0` | [实测] |
| 1.8 | 平台客户端插件在本 profile 中确实挂载 | `R\dsh-web-app\cordis.patch.yml:388-389`（`id: ui-permission` → `@deepseek-ai/dsh-client-ui-permission-presets`） | [实测]（读码） |

> 注意（与本问题无关但会改变"用户看到什么"）：本 profile 的 WinStage 开关当前是 **off**
> （`C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml:46-51` `enabled: false`），
> 因此**当前线上**在 composer 上是**平台**的访问模式控件，WinStage 的替代按钮处于不接管态。
> 这一点由 `.t/default-on-selftest.mjs` 的 L6b 断言显式记录（`[PENDING-LIVE-FLIP] … live profile 显式 enabled: false`）。

---

### Q2. 携带 `sandbox_permissions` / `justification` 的工具调用现在会怎样？拒绝发生在 WinStage 执行器**之前**还是只是"记一笔"？

**结论：是"执行器之前就失败"。** `approveEscalation()` 在 `execute()` 的**第一步被 await**；`never` 下审批服务**直接返回 `rejected`（不派发任何 answerer）**，于是 `approveEscalation` 抛错，`ctx.shell.execute()` **根本不会被调用**。WinStage 执行器里那条"档位不匹配 → 降级执行 + 注记"的分支（`shell-executor.mjs:922-940`）在升权调用上**永远不会被执行到**。

| # | 事实 | 证据 | 置信度 |
|---|---|---|---|
| 2.1 | 升权解析发生在执行之前 | `R\dsh-tool-pwsh\lib\index.js:611-618`：`execute()` 第 1 行 `validatePwshArgs`，第 2 行 `resolveSandboxPolicy`，第 3 行 `await approvePwshEscalation(...)`；请求体 `:620-626` 与真正的执行都在其后 | [实测]（读码） |
| 2.2 | 升权阶梯与失败语义（等于当前档=免审批放行；更窄/不支持=抛错；更宽=走审批，`rejected` ⇒ 抛错） | `R\dsh-sandbox\lib\index.js:99-123`：`:101 if (mode === effectiveMode) return effectiveMode`、`:102 throw …not strictly wider…`、`:105 await approval.approver.request(...)`、`:118 case "rejected": throw new Error('the user rejected escalating this …')` | [实测]（读码） |
| 2.3 | `never` 下 `decide()` **立即**返回 `rejected`，**不**派发 `approval/request` waterfall | `R\dsh-user-approval\lib\index.js:172-176`：`:175 if (this.effectivePolicy(session) === "never") return "rejected";`（在 waterfall 之前） | [实测]（读码） |
| 2.4 | `never` 下**仍然**写入 `asked+decided(rejected)` 这一对审计事件 | `R\dsh-user-approval\lib\index.js:128-144`：`:132 append('approval/asked', …)` → `:138 await this.decide(...)` → `:139 append('approval/decided', {outcome})` | [实测]（读码） |
| 2.5 | 审计对里出现的 `rejected` 是"自动拒绝"，不是"用户点了拒绝"；但错误文案把责任推给用户 | 同上 `:175` + `R\dsh-sandbox\lib\index.js:118`（`the user rejected escalating this command to "…"`） | [实测]（读码） |
| 2.6 | 模型侧**仍然**被告知可以用升权字段（schema 不按策略收窄） | `R\dsh-tool-pwsh\lib\index.js:314-315`（`escalationModes = defaultMode === void 0 ? [] : ESCALATION_TARGETS`）、`:483-491`（`sandbox_permissions` / `justification` 两个参数）；而 WinStage 恒定报 `'workspace-write'`（`dsh-plugin\shell-executor.mjs:783-785`）⇒ `escalationModes` 非空 | [实测]（读码） |
| 2.7 | 系统提示同时说"禁止请求升权" | `R\dsh-user-approval\lib\index.js:39`（`NEVER_SENTENCE = "Approval prompts are disabled in this session: … do not request sandbox escalation (do not set \`sandbox_permissions\`)."`）、`:79-88`（注入点） | [实测]（读码） |
| 2.8 | 「改前」用户确实会被问到、并且能点"允许一次" | 会话 `8a1a9290` 日志：7 对 `approval/asked→approval/decided(allowed-once)`，reason 逐字为 `escalate sandbox to danger-full-access: …`；客户端弹窗来自活瀑布 `R\dsh-client-ui-approval\lib\client.js:355 ctx.remote.$on("approval/request", …)`（`:347` 选 `pendingInteraction`） | [实测]（日志 + 读码） |
| 2.9 | 「当前会话态」下升权请求大多**够不到**审批：当前生效档 = `danger-full-access`，请求 `danger-full-access` 命中 `:101` 免审批放行（但仍会被 WinStage 判为"更宽" ⇒ 降级注记）；请求 `workspace-write` 命中 `:102` 抛"not strictly wider" | `R\dsh-sandbox\lib\index.js:101-102` + `R\dsh-sandbox-policy\lib\index.js:141-148`（`:144` 会话 override 优先） | [推断] |

---

### Q3. `approval:'never'` 下继续往会话里写 `approval/asked` 还正确吗？有没有消费者在等 `decided`／把它渲染成"待审批"？

**结论：写 `asked` 仍然正确且**应当保留**；没有任何 harness 消费者要求 `decided`，也没有任何客户端把日志里的 `asked` 渲染成挂起审批。**唯一需要注意的是"孤儿 asked"在不变式里被容忍但会留在 `pending` 集合内（不会报错、不会上屏）。

| # | 事实 | 证据 | 置信度 |
|---|---|---|---|
| 3.1 | 事件词表与格式校验仍接受 `winstage:` 形态的 `asked`（只要求 id/toolName 非空） | `R\dsh-session-format-v0-to-v1\lib\index.js:287-292`；WinStage 写入 `winstage:<candidateId>` / `toolName:'winstage-stage'`（`dsh-plugin\audit-mirror.mjs:52-55`、`:105-109`） | [实测]（读码） |
| 3.2 | `asked` 必须在**开着的回合内**写入 | `R\dsh-user-approval\lib\invariant.js:202-205`（`:203 asked appended outside any open turn`）；WinStage 已复刻该前置条件（`dsh-plugin\audit-mirror.mjs:35-49`、`:79-83`） | [实测]（读码） |
| 3.3 | 不变式**只在 `decided` 找不到 `asked` 时报错**；孤儿 `asked` 仅留在 `pending` 集合 | `R\dsh-user-approval\lib\invariant.js:211-226`（`:213 decided has no matching approval/asked`、`:224 pending.add`）；违反 ⇒ `throw new InvariantError`（`R\dsh-invariants\lib\index.js:93,123`） | [实测]（读码） |
| 3.4 | 客户端**没有**任何"按日志重放渲染审批"的路径：全包扫描 `approval/asked` 只命中 schema/格式迁移/不变式/已知事件表，无渲染器 | `grep approval/asked`（`--include *.js`，作用域 `R\`）共 37 命中，全部是类型声明 / `dsh-session-format-v0-to-v1` / `dsh-session\lib\index.js:82` / `dsh-session\lib\types\known-event-types.js:24` / `dsh-user-approval\lib\invariant.js` / `R\dsh-api-session-controller\lib\client.js:137-142`（`KNOWN_SESSION_EVENT_TYPES` 白名单） | [实测]（grep） |
| 3.5 | 唯一的审批 UI 由**活瀑布**驱动（`pending.answerable` + `approval/request` 事件），与日志 `asked` 无关 | `R\dsh-client-ui-approval\lib\client.js:32-48`、`:61`、`:287-303`、`:347`、`:355` | [实测]（读码） |
| 3.6 | 没有 `approval` 相关的 session projection；会话日志设置页也不渲染审批事件 | `grep approval` 于 `R\dsh-session-projection\lib` ⇒ 0 命中；`grep approval|asked|decided` 于 `R\dsh-client-ui-settings-session-log\lib` ⇒ 0 命中 | [实测]（grep） |
| 3.7 | WinStage 侧始终成对写入（新候选才写 `asked`；落盘成功才写 `decided`；拒绝写 `decided(rejected)`） | `dsh-plugin\review-service.mjs:543-545`、`:957-958`、`:1101`；实现 `dsh-plugin\audit-mirror.mjs:98-125` | [实测]（读码） |
| 3.8 | 与平台语义的**数据面**差异：`never` 下平台的自我配对是"立即 `asked→decided(rejected)`"，WinStage 的 `asked` 会一直开到人去点 `/winstage approve|reject` | `R\dsh-user-approval\lib\index.js:172-176` vs `dsh-plugin\host-plugin.mjs:682-717`（WinStage 审批完全走自己的 `review.json` + 命令面，**不经过 `ctx.approval`**） | [实测]（读码） |
| 3.9 | 潜在（**先于本次策略变化即存在**）：若 `asked` 因"回合未开"被跳过，而用户之后在同一回合内批准 ⇒ 写出无配对 `decided` ⇒ 不变式抛错 | `dsh-plugin\audit-mirror.mjs:79-83`（跳过 asked） + `review-service.mjs:1101`（写 decided）+ `R\dsh-user-approval\lib\invariant.js:213` | [推断] |

**裁定：不改。** 停止写 `asked` 会拆掉"两套审批共享同一审计面"的唯一对账通道（`dsh-plugin\host-plugin.mjs:684-698` 的定因）；而"自动补一个 `decided(rejected)`"是**说谎** —— WinStage 的暂存审批在 `never` 下**依然可以被用户批准**（它不属于平台审批 seam）。

---

### Q4. 写死的 `sandboxMode='workspace-write'` 与宿主的 `danger-full-access` 是否已构成用户可见矛盾？

**结论：正常路径下"不"——平台控件的显示值取自会话投影（`sandbox/mode` 事件），不读 `ctx.shell.sandboxMode`；但它有 3 个真实出口，其中 1 个是**潜在硬断裂**（控件整块消失），另 1 个是"每次命令都响"的运维面告警。**

| # | 事实 | 证据 | 置信度 |
|---|---|---|---|
| 4.1 | 平台控件显示值来自 `permissions` 投影的 `currentValue` | `R\dsh-client-ui-permission-presets\lib\client.js:307-308`、`:324-327`、`:744-746` | [实测]（读码） |
| 4.2 | 投影 view = `{ currentValue: this.derive(state) }`，而 `derive` **优先用日志状态**，`ctx.shell.sandboxMode` 只是兜底 | `R\dsh-permission-presets\lib\index.js:197-200`；`:295-306`（`:296 const sandbox = state.sandbox ?? this.ctx.shell.sandboxMode`、`:298 matches`、`:305 return CUSTOM_PRESET`） | [实测]（读码） |
| 4.3 | ⇒ 只要会话有 `sandbox/mode` 事件（本仓库**每个**会话都会被 `pinInitialPermission` 写一条：`:381` 或 `:387`），显示值就是 `danger-full-access`，与 WinStage 的常量无关 | `R\dsh-permission-presets\lib\index.js:370-389` | [实测]（读码） |
| 4.4 | **潜在硬断裂**：装配期 `derive(EMPTY_KNOBS)` = `ctx.shell.sandboxMode` + `ctx.approval.config.policy`；WinStage 挂 shell 半时报 `'workspace-write'`，若部署级策略是 `never`（机制 B）⇒ 组合成 `workspace-write + never` ⇒ **无任何预设匹配 ⇒ `'custom'` ⇒ 构造器抛错 ⇒ `permission` 行装不上** ⇒ `permissionPresets` 服务与 `permissions` 投影缺失 ⇒ 客户端 `PermissionSelect` 返回 `null`（`:324`）⇒ **composer 的访问模式控件与设置页那一行整块消失**（开关为 off 时用户在该位置什么都看不到） | `R\dsh-permission-presets\lib\index.js:177`（无 `sandboxMode` 抛错）、`:178 inferredDefault = this.derive(EMPTY_KNOBS)`、`:180 if (defaultPreset === 'custom') throw new Error('permission: composed sandbox and approval defaults match no preset; configure defaultPreset explicitly')`；`:326-330`（`custom` 显示名 `"Custom"`）；`R\dsh-base\cordis.patch.yml:229-233`、`:245-248`；`R\dsh-client-ui-permission-presets\lib\client.js:324`、`:808-814` | [官方]（读码；**未在真实装配中复现**） |
| 4.5 | 该断裂**今天被掩蔽**：只有本 profile 显式给了 `defaultPreset`，bundle 层只给 `presets`、没给 `defaultPreset` | `C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml:27 defaultPreset: workspace-write`；`Select-String defaultPreset` 于 `R\dsh-base\cordis.patch.yml`、`R\dsh-web-app\cordis.patch.yml`、`R\dsh-web-app\presets\*.yml` ⇒ **0 命中** | [实测]（grep） |
| 4.6 | 第 2 个出口：`pinInitialPermission` 在"会话没有 `sandbox/mode` 事件"时把 `ctx.shell.sandboxMode`（=WinStage 的 `'workspace-write'`）写进日志，而不是部署默认档 | `R\dsh-permission-presets\lib\index.js:387 if (sandbox === null) setSandboxMode(session, this.ctx.shell.sandboxMode)` | [实测]（读码） |
| 4.7 | 但该路径实际不可达：本仓库每个会话创建即被 pin（`:381` 写具体 `spec.sandbox`），子会话又由 delegation 抄父会话的显式 override | `R\dsh-permission-presets\lib\index.js:381`、`:202-205`；`R\dsh-subagent\lib\index.js:539` | [推断] |
| 4.8 | 第 3 个出口：`dsh-tool-pwsh` 用它判定"这是有围栏的组合"⇒ 继续广告升权、且要求 `ctx.sandboxPolicy` 存在；每调用的真实档位仍来自会话投影 | `R\dsh-tool-pwsh\lib\index.js:314-317`、`:319` | [实测]（读码） |
| 4.9 | 对照：平台自己的 `dsh-pwsh-sandbox.sandboxMode` = `ctx.sandboxPolicy.defaultMode`（非 `undefined`）⇒ 有无 WinStage，"广告升权"都一样 ⇒ 4.8 **不是** WinStage 引入的差异 | `R\dsh-pwsh-sandbox\lib\index.js:134-139` | [实测]（读码） |
| 4.10 | WinStage **自己**的 shell 半边现在与生效档位持续矛盾：`requestedMode='danger-full-access' ≠ 'workspace-write'` ⇒ 每条命令都进 `mismatched` 分支：error 级日志 + `degradeNote` | `dsh-plugin\shell-executor.mjs:922-940`（`:922 requestedMode`、`:923 mismatched`、`:925 logError`、`:935-938 degradeNote`） | [实测]（读码） |
| 4.11 | 但该告警**刻意不上屏**：只进 `handle.winstage.notes` 与诊断文件；`handle.winstage` 不属于 `ShellExecution` 契约，harness 里对 `winstage` 的引用为 **0** | `dsh-plugin\shell-executor.mjs:1319-1335`（模型可见面"一个字节都不注入"）、`:1336-1354`（诊断文件）、`:1400-1423`（`winstage:{…, notes}`）；`grep winstage`（`--include *.js`，作用域 `R\`）⇒ **0 命中** | [实测]（读码 + grep） |
| 4.12 | 而且在**当前线上 profile** 里这条根本不会触发：`WINSTAGE_SHELL` 未设 ⇒ bundle 的 `!!js` 把 `winstage-shell` 置为 disabled，profile 又显式重开了平台 `pwsh-sandbox` | `dsh-plugin\cordis.patch.yml:96-99`（pwsh-sandbox 的 `disabled: !!js …WINSTAGE_SHELL === '1'…`）、`:123-128`（winstage-shell 的 `disabled: !!js process.env.WINSTAGE_SHELL !== '1' || …`）；`…\profiles\web\cordis.patch.yml:38-39`（只重述 `id/name`，不带 `disabled`） | [实测]（读码 + `$env:WINSTAGE_SHELL` 为空） |
| 4.13 | fs 半边的口径**不同且是刻意的**：暂存开启时 `sandboxMode` 报 `undefined` ⇒ `write/edit` 不广告升权 | `dsh-plugin\staging-fs.mjs:439-441`、`:435`；`R\dsh-tool-fs\lib\index.js:1082-1088` | [实测]（读码） |
| 4.14 | 现有自测把 `'workspace-write'` **钉死**：改这一行会立刻见红 | `cmd /c "node .t\shell-selftest.mjs"` ⇒ `pass=120 fail=0 total=120`，含 `S1.2 sandboxMode === 'workspace-write'`、`S1.2b 且确实不是 undefined`、`S1.2c 最窄`、`S3b.2`、`M1` | [实测] |
| 4.15 | 文档已过时：`docs/DSH集成.md:480` 仍写「`sandboxMode` 也刻意报 `undefined`」，与现行代码相反 | `docs\DSH集成.md:479-481` vs `dsh-plugin\shell-executor.mjs:783-785` | [实测]（读码） |

---

### Q5. 其它**可证明**会改变用户所见的东西

| # | 现象 | 谁会看到 | 复现 / 证据 | 归属 |
|---|---|---|---|---|
| 5.1 | 模型收到的文件策略句子变成「danger-full-access。**DSH 文件沙箱不限制**文件修改」，而 WinStage（开关开）仍然"先暂存、等批准" | 用户间接（模型的行为/表述） | `R\dsh-sandbox-policy\lib\index.js:72-83`（`:76` 那句逐字）vs `docs\DSH集成.md:477-481` | 策略变化本身；WinStage 无法消除（除非它自己改写模型上下文，超出授权） |
| 5.2 | 模型可见通道自相矛盾：系统提示说"禁用审批、不要请求升权"，工具描述仍说"必要时升权重试一次"、否认提示仍说"审批会问用户" | 用户间接（模型反复申请必然失败的升权） | `R\dsh-user-approval\lib\index.js:39`、`:79-88` vs `R\dsh-tool-pwsh\lib\index.js:257`、`:314-315`、`:483-491`；`R\dsh-sandbox\README.zh.md:150`（`the approval prompt asks the user`） | **Harness 侧**（平台执行器同样如此，见 4.9） |
| 5.3 | composer 的**原生审批卡再也不会出现** | 用户 | `R\dsh-user-approval\lib\index.js:175`（`never` 直接返回，不进 waterfall）+ `R\dsh-client-ui-approval\lib\client.js:355`（只在 `approval/request` 上挂） | 策略变化本身（预期语义） |
| 5.4 | 会话 knob 组合 `workspace-write + never` 会让访问模式控件显示「Custom / 自定义」而不是预设名 | 用户（控件文字） | `R\dsh-permission-presets\lib\index.js:295-305`、`:326-330`；**实测**：`3b39f005`、`36c136a7`、`48b576ee`、`439b23fd` 四个会话日志均为 `sandbox/mode=workspace-write(source=delegation)` + `approval/policy=never(source=delegation)` | 策略变化 + `dsh-subagent\lib\index.js:540`（子会话审批无条件钉 `never`）；**不是** WinStage 的常量造成（sandbox 值来自父会话 override，见 `:539`） |
| 5.5 | 若走机制 B（部署级 `DSH_PERMISSION_MODE=danger-full-access`）且 WinStage shell 半边在场且 profile 没有 `defaultPreset` ⇒ 访问模式控件**整块消失**（不只是替换） | 用户 | 同 4.4 / 4.5 | 策略变化 × WinStage 常量；**潜在**，当前被 profile 的显式 `defaultPreset` 掩蔽 |
| 5.6 | 未发现差异的项（都检查过） | — | (i) 槽位是否存在/渲染（Q1）；(ii) WinStage 接管与"关闭即恢复平台控件"（Q1，45/45 自测）；(iii) 常驻重开 chip 挂在**另一个**槽位 `conversation.input.dock`（`dsh-plugin\client.js:2438-2465`），与审批策略无关；(iv) `/winstage*` 命令族完全不经过 `ctx.approval`（`dsh-plugin\host-plugin.mjs:682-733`、`review-service.mjs`），`never` 下批准/拒绝照旧可用；(v) WinStage 的 `approval/asked|decided` 镜像**没有任何** UI 消费者（Q3）；(vi) `handle.winstage.notes` 没有任何 harness 消费者（4.11） | [实测] |

---

## 2. 用户可感知差异（结论清单）

**必须说清楚的前提：本次分析未发现任何"由 WinStage 插件自身行为在当前装配下造成"的用户可感知差异。** 现有差异都可归因到 **平台策略语义**（1、2）或**条件性/运维面**（3、4、5）：

1. **[实测] 升权不再询问，改为立即失败。** 谁看到：用户（一条失败的 `pwsh` 调用，文案 `the user rejected escalating this command to "…"`，而用户从未被问）。复现：`8a1a9290` 日志在 `ask` 下有 7 对 `asked/decided(allowed-once)`；`never` 下 `R\dsh-user-approval\lib\index.js:175` 直接返回 ⇒ `R\dsh-sandbox\lib\index.js:118` 抛错，**发生在 WinStage 执行器之前**（Q2）。归属：**平台**（非 WinStage 会话完全同形）。
2. **[实测] 子会话的访问模式控件可能显示「自定义」。** 谁看到：用户（控件文字）。复现：Q5-5.4 的四个会话日志 + `R\dsh-permission-presets\lib\index.js:295-305`。归属：**策略变化 × 平台的 delegation 审批钉死**。
3. **[推断·运维面] WinStage shell 半边在场时，`danger-full-access` 会话里每条命令都会产生 error 级日志与 `degradeNote`**（改前只在真的申请升权时才可能出现）。谁看到：**只有看日志/诊断文件的人**（`dsh-plugin\shell-executor.mjs:1319-1335` 明确不注入模型可见面；harness 对 `winstage` 零引用）。当前线上 `WINSTAGE_SHELL` 未设 ⇒ 该半边未装载，实际不触发（4.12）。
4. **[推断·潜在硬断裂] 机制 B + WinStage shell 半边 + 无显式 `defaultPreset` ⇒ composer 的访问模式控件整块消失。** 谁看到：用户（该位置空白，且开关为 off 时无任何替代）。当前被 `profiles\web\cordis.patch.yml:27` 掩蔽；本轮**无法在真实装配中复现**（见 §4）。
5. **[实测·仅模型可见] 模型上下文从"workspace-write（可在工作区内改）"变为"danger-full-access（不限制）"，而 WinStage 仍在暂存+审批。** 谁看到：用户间接。

**明确回答"如果没有发现差异"：** 在"WinStage 面板是否消失""接管/恢复开关是否失效""重开 chip 是否失效""`/winstage` 命令是否失效""WinStage 审计镜像是否上屏"这 5 个面上，**没有差异**；检查方式见 5.6 与第 1 节各条证据（读码 + `grep` + 4 个离线自测 + 8 份真实会话日志解码）。

---

## 3. 最小改动清单

### 3.1 建议改（都是"防未来 + 对齐文档"，不动运行时行为）

| # | 位置 | 要编码的行为规则 | 为什么能保住用户感知 | 风险 | 需要更新/新增的测试 |
|---|---|---|---|---|---|
| **C1** | `docs/DSH集成.md:480`（§12.1） | 把「`sandboxMode` 也刻意报 `undefined`（不广告升权）」改为现行事实：**报最窄可用档 `'workspace-write'`**，理由是 `dsh-permission-presets` 会因 `sandboxMode === undefined` 拒绝装配（`R\dsh-permission-presets\lib\index.js:177`，原始日志 `.t/e2e2.log:1-2`），并且本执行器**不接受任何升权**（`shell-executor.mjs:898-941`）。 | 文档漂移会诱导后人"改回去"，而那正是历史上让 `permission` 整行装不上的操作（⇒ 用户失去访问模式控件）。纯文档，零风险。 | 无 | 无（可选：在 `.t/shell-selftest.mjs` 追加一条"文档与常量一致"的源码级断言） |
| **C2** | `docs/DSH集成.md:515`（§12.4 写 `14/14`）与 `:585`（§12.6 写 `45/45`）、`:379`（§10.4 写 `default-on-selftest 13/13`） | 统一为**实测**口径：`permission-slot-selftest` **45 PASS / 0 FAIL**；`toggle-selftest` **20 PASS / 0 FAIL**；`default-on-selftest` **11 PASS / 1 FAIL(L5b) / 2 PENDING-LIVE-FLIP**；`shell-selftest` **120/120**。 | 假绿的数字会让"回归门"失去意义；而回归门正是"用户感知不变"的唯一机械化保证。纯文档。 | 无 | 无 |
| **C3** | 新增 `.t/policy-never-consistency.mjs`（或并入 `.t/permission-slot-selftest.mjs`） | 断言三条**可证伪**的规则：① `derive({sandbox:'workspace-write', approval:'never'}) === 'custom'`（直接调用/复刻 `R\dsh-permission-presets\lib\index.js:295-305`），并断言"若 `inferredDefault==='custom'` 且未配置显式 `defaultPreset`，构造器必抛 `permission: composed sandbox and approval defaults match no preset`"（`:180`）；② 读取活动 profile 的 `cordis.patch.yml`，断言 `id: permission` 行**存在显式 `defaultPreset`**（当前 `:27` 的 `workspace-write`）—— 这条就是 4.4/5.5 潜在硬断裂的守门；③ 断言 `approval-mirror` 的 `ask()` **不**产生自动 `decided`，且 `hasOpenTurn` 为假时返回 `false`（现状的成对语义）。 | 把"panel 会不会整块消失"从**人工记忆**变成**机器断言**：一旦有人删掉 profile 的 `defaultPreset`、或把 WinStage 的常量改成报更宽档，测试立刻红。用户感知面（访问模式控件是否存在）由此被钉住。 | 低。仅新增测试，不改运行时；断言基于 clone 出来的纯函数/源码文本，不启动真 cordis（真装配能力见 §4） | 新增该文件即可；不动 `shell-selftest` 的 `S1.2/S1.2b/S1.2c/S3b.2/M1`（它们钉的是"必须报模式且不得更宽"，仍然正确） |

### 3.2 明确**不要**改（附理由）

| # | 位置 | 不要改的原因 |
|---|---|---|
| **N1** | `dsh-plugin/shell-executor.mjs:783-785`（`sandboxMode` 恒报 `'workspace-write'`） | 改成"反映生效档"（例如 `danger-full-access`）会造成：① `dsh-permission-presets` 的**种子路径**反过来读 `ctx.shell.sandboxMode`（`R\dsh-permission-presets\lib\index.js:387`）⇒ 会话档位与执行器互相追随，形成反馈环；② `R\dsh-tool-fs` 一类"有围栏 ⇒ 必须要求 `ctx.sandboxPolicy`"的装配检查语义被改写（`R\dsh-tool-fs\lib\index.js:1087`）；③ 现有 `S1.2/S1.2b/S1.2c/S3b.2/M1` 全部见红，而这些断言记录的是**实测过的装配失败**（`.t/e2e2.log:1-2`）。而它带来的用户可见收益为**零**：显示值走会话投影（4.1–4.3），那条装配风险用 C3 守门即可。 |
| **N2** | `dsh-plugin/audit-mirror.mjs`（继续写 `approval/asked`） | Q3 全部证据：写 `asked` 合法（3.1）、无消费者等待 `decided`（3.4–3.6）、不变式只惩罚"decided 无 asked"（3.3）。停止写入会拆掉唯一的审计对账通道；自动补 `decided(rejected)` 则会**谎报**"用户拒绝了"（WinStage 审批在 `never` 下仍可被批准，见 3.8）。 |
| **N3** | `dsh-plugin/client.js:2470-2523`（槽位接管/撤销） | Q1 全部证据：接管只由 WinStage 自己的三态开关驱动，与审批策略无关；`45 PASS / 0 FAIL` 覆盖遮蔽/恢复/未知态。任何"因为策略变了就调整接管条件"的改动都会破坏 `'unknown' ⇒ 不接管`（用户诉求"关闭沙箱时不要覆盖原版弹窗"，`docs\DSH集成.md:537-580`）。 |
| **N4** | `R\*`（harness 只读参考）里的 `dsh-tool-pwsh` / `dsh-sandbox` / `dsh-user-approval` | 本任务明确规定 harness 侧只读。但其两处**平台侧**缺陷应上报（见 3.3）。 |
| **N5** | `…\profiles\web\cordis.patch.yml:38-39`（重开平台 `pwsh-sandbox`）与 `:46-51`（`winstage-sandbox: enabled:false`） | 这是"一个服务名一个提供方"的既有装配决策，且当前线上行为（WinStage shell 半分未装载、平台执行器在场）正是它决定的；本次策略变化不构成改它的理由。 |

### 3.3 建议**上报 Lead**（超出本仓库权限，属 harness/装配层）

- **H1（平台语义说谎）**：`never` 下 `decide()` 返回 `'rejected'`（`R\dsh-user-approval\lib\index.js:175`），而 `approveEscalation` 抛出的文案是 `the user rejected escalating this command to "…"`（`R\dsh-sandbox\lib\index.js:118`）。用户从未被询问 ⇒ 建议在 `never` 下改用不归咎用户的文案/独立 outcome（例如 `unavailable` 语义或新增 `auto-rejected`）。
- **H2（模型可见通道自相矛盾）**：`NEVER_SENTENCE`（`R\dsh-user-approval\lib\index.js:39`）说"不要请求升权"，但只要有围栏执行器，`dsh-tool-pwsh` 就继续广告 `sandbox_permissions`/`justification` 并在工具描述里教模型升权重试（`R\dsh-tool-pwsh\lib\index.js:257`、`:314-315`、`:483-491`）。这段矛盾**与 WinStage 无关**（平台执行器同样如此，4.9），但会让模型浪费回合。
- **H3（装配脆弱）**：`permission` 行的可用性取决于 profile 是否给了显式 `defaultPreset`（4.4/4.5）。建议平台侧在 `derive(EMPTY_KNOBS)==='custom'` 时降级为"保留 catalog 但标 custom"，而不是整行抛错装不上 —— 否则一个错误的策略组合会让 composer 的访问模式控件**整块消失**。

---

## 4. 本会话不可验证

| # | 项目 | 为什么不可验证 | 现有最接近的证据 |
|---|---|---|---|
| V1 | **真实 cordis 装配**下"机制 B + WinStage shell 半边 + 无 `defaultPreset`"是否真的让 `permission` 行装不上、控件是否真的整块消失 | 需要以 `DSH_PERMISSION_MODE=danger-full-access` + `WINSTAGE_SHELL=1` 重起一个宿主进程并改 profile；本会话是"审批禁用"的受限子会话，不得重启/替换 GUI 宿主，也不得改配置 | 4.4/4.5 的源码路径（`R\dsh-permission-presets\lib\index.js:177-181`）+ "bundle 无 `defaultPreset`"的 grep 实测 |
| V2 | `DSH_PERMISSION_MODE` 是否**曾经**被改成 `danger-full-access`（机制 B 是否同时在场） | 环境变量当前为空；日志里无法区分 A 与 B（两者都会让子会话出现 `source:'delegation'` 事件）；bundle 的 `!!js` 只在启动时求值 | 父会话 `seq578-580` 的**运行时**预设切换（机制 A）[实测] |
| V3 | WinStage shell 半边在场时，`danger-full-access` 会话的"每条命令一条 degrade 注记"是否真的落地 | 当前 `WINSTAGE_SHELL` 未设 ⇒ 该半边未装载；需要一次 `WINSTAGE_SHELL=1` 的端到端启动 | `shell-executor.mjs:922-940`（代码路径）+ 4.12（当前未装载） |
| V4 | `.t/default-on-selftest.mjs` 的 L5b `[FAIL]` 与 L6b `[PENDING-LIVE-FLIP]` 是否与本次策略变化有关 | 两者都只读源码文本/profile 文本，且断言目标（`configValue.enabled === false` 判据、live profile 期望 `enabled=true`）与审批策略无关；**无法排除**它们在本轮之前就已红 | 实测：`PASS=11 FAIL=1 PENDING=2 EXIT=1`，失败详情 `没找到"只认显式 false"的判据`；`docs\DSH集成.md:379` 记的是 `13/13`（口径漂移） |
| V5 | `dsh-invariants` 的 `user-approval-invariant` 伴生插件在**本 profile 是否装载** | 需要读 loader 行表（`dsh-base` 里没有显式的 `user-approval-invariant` 行；实际装载状态需运行期 inspect） | `R\dsh-user-approval\lib\invariant.js:197,199,282`（伴生插件形态）+ `R\dsh-invariants\lib\index.js:80-93` |
| V6 | 3.9 的"orphan decided ⇒ 不变式抛错"是否会真的打断一次用户批准 | 需要真装配 + 人为构造"回合外暂存、回合内批准"的时序 | `dsh-plugin\audit-mirror.mjs:79-83` + `review-service.mjs:1101` + `R\dsh-user-approval\lib\invariant.js:213` [推断] |

---

## 附录：本轮实测记录（逐字）

```
cmd /c "node .t\permission-slot-selftest.mjs"   → PASS=45 FAIL=0 PENDING=0  EXIT=0
cmd /c "node .t\toggle-selftest.mjs"            → PASS=20 FAIL=0 PENDING=0  EXIT=0
cmd /c "node .t\default-on-selftest.mjs"        → PASS=11 FAIL=1 PENDING=2  EXIT=1
    [FAIL] L5b client：只认显式 false 才算关（enabled 缺失时不判关） —— 没找到"只认显式 false"的判据
    [PENDING-LIVE-FLIP] L6b profile web：…（期望 enabled=true）—— live profile 显式 enabled: false
cmd /c "node .t\shell-selftest.mjs"             → 断言计数：pass=120 fail=0 total=120  EXIT=0
    [PASS] S1.2 sandboxMode === 'workspace-write'（必须报模式，**不能**报 undefined）
    [PASS] S1.2b 且确实不是 undefined（undefined 会让 dsh-permission-presets 拒绝装配）
    [PASS] S1.2c 报的是最窄模式：既不 undefined，也不广告更宽档位
    [PASS] S3b.2 变异体 sandboxMode 仍是 'workspace-write'（只摘了 fail-closed 这一处）
    [PASS] M1 变异体 sandboxMode = undefined ⇒ S1.2/S1.2b 必然 FAIL
cmd /c "node %TEMP%\winstage-recon\approval-probe.mjs <最新 8 份会话日志>"  → 见 §0 的逐字输出
```

**未改动任何仓库文件**：`approval-probe.mjs` 复制到 `%TEMP%\winstage-recon\` 后运行（其自身的 `approval-probe.txt` 因此写在 `%TEMP%`），仓库内 `.t\approval-probe.txt` 的 mtime 仍为 `2026-09-28 12:22:34`。本文件是本轮唯一新增文件。（以上为**侦察轮**口径；随后由实施会话追加第 5 节并改动 C1/C2/C3 涉及的文件，详见 §5。）

---

## 5. 实施结果（C1 + C2 + C3，2026-10-01 本轮）

> 本节由**实施会话**追加；§0–§4 的侦察分析与结论**原样保留、未做任何修改**。
> 本轮**未改任何运行时行为**：`dsh-plugin/**` 与 `C:\Users\Administrator\.dsh\**` 一个字节都没动。

### 5.1 C1 —— 文档真值（`docs/DSH集成.md`）

- 位置：§12.1（现行 `docs/DSH集成.md:479-495`）。
- 改了什么：删掉与代码相反的「`sandboxMode` 也刻意报 `undefined`（不广告升权）」，改写为现行事实 ——
  `get sandboxMode()`（`dsh-plugin/shell-executor.mjs:783-785`）**报最窄可用档 `'workspace-write'`、恒定不变**，
  并保留完整因果与证据：报 `undefined` ⇒ `@deepseek-ai/dsh-permission-presets` 装配期拒绝装载 `permission` 行
  （历史原始日志 `.t/e2e2.log:1-2`）⇒ `permissions` 投影缺失 ⇒ composer 的**访问模式控件整块消失**；
  同时说明本执行器**从不接受升权**（`shell-executor.mjs:898-941`）。`[官方]`（读 harness 装配路径）+ 历史日志。
- 同一小节里再没有第二处重复该旧说法（已 grep 确认）。
- 防回归：新套件 `tests/policy-never-consistency.mjs` 检查 6 断言**文档里不得有任何一行同时出现
  `sandboxMode` 与 `undefined`**，并要求就近有 `'workspace-write'` 的更正说法。

### 5.2 C2 —— 实测数字（不再沿用假绿口径）

本轮在本机本会话逐条实跑（`cmd /c "node .t\<file>.mjs"`，工作区根目录），**这就是本节所有数字的口径**：

| 自测 | 实测结果 | exit |
|---|---|---|
| `.t/permission-slot-selftest.mjs` | **通过 45/45**（`✓45 ✗0`，无 SKIP/PENDING） | 0 |
| `.t/toggle-selftest.mjs` | **通过 20/20** | 0 |
| `.t/default-on-selftest.mjs` | **`断言 11/12 PASS，2 PENDING-LIVE-FLIP，0 SKIP`**；失败项 `[FAIL] L5b`（"没找到'只认显式 false'的判据"）；`[PENDING-LIVE-FLIP] L6b / L6e`（live profile 仍 `enabled: false`） | **1** |
| `.t/shell-selftest.mjs` | **`pass=120 fail=0 total=120`**（含 S1.2 / S1.2b / S1.2c / S3b.2 / M1） | 0 |

写入文档的位置（均标注"本轮实测/本轮 C2 复核实测"与 exit code，不粉饰红项）：

- `docs/DSH集成.md:377-390`（§10.4 证据块）：四条重测 + 明确标注其余几条为**上一轮口径、本轮未复跑**；
- `docs/DSH集成.md:534`（§12.4）与 `:604`（§12.6）：`permission-slot-selftest` 由过期的 `14/14` 更正为 **45/45**；
- `docs/DSH集成.md:1058-1075`（§20.3）：`default-on-selftest` 由过期的 `13/13` 更正为
  **11 PASS / 1 FAIL(L5b) / 2 PENDING-LIVE-FLIP，exit 1**，并写明三者与本次审批策略变化无关。

**如实记录的偏差**：`default-on-selftest` 的 `L5b` 是**真实红项**（源码级断言与现行 `dsh-plugin/client.js` 文本对不上），
本轮**没有修**——`dsh-plugin/**` 不在授权改动范围内；`L6b/L6e` 是 live profile 显式 `enabled: false` 造成的
PENDING-LIVE-FLIP（§1 的 Q1 注记早已记录），待 Lead 翻转后自动转 PASS。

### 5.3 C3 —— 新守门套件 `tests/policy-never-consistency.mjs`（新文件，618 行）

离线、确定性、**零子进程 / 零管理员 / 零网络 / 不启动 harness**；输入只有源码文本、活动 profile 文本与
`dsh-plugin/audit-mirror.mjs` 的纯函数导出。6 个检查段（逐条 `✓`/`✗`，末行含 `RESULT:`，支持 `--plant`）：

1. **潜在硬断裂守门**：活动 profile（`%DSH_HOME%\profiles\%DSH_PROFILE%\cordis.patch.yml`）的 `permission`
   行必须有**显式** `defaultPreset` 且该值在同行 `presets` 里有定义（本机实测 `defaultPreset=workspace-write`，
   presets=`[read-only, workspace-write, danger-full-access]`）。env 未设 / 文件不可读 / 值是不可静态求值的
   `!!js` 表达式 ⇒ **SKIP 并写明原因**，绝不假 PASS。
2. **`sandboxMode` 静态最窄**：源码级锚定 `get sandboxMode()` 必须是**恰好一处**
   `return <字符串字面量>` 形态，值 `=== 'workspace-write'`，体里不得出现 `spec/session/approval/policy/ctx/this`。
3. **面板策略无关**：`conversation.input.permission` 注入块内判据必须严格 `readSwitch(form) === 'on'`，
   注册/撤销只由它驱动，去注释去字符串后块内**没有** `approval/preset/sandboxMode/danger-full-access/read-only`。
4. **不经过平台审批 seam**：`review-service.mjs`、`host-plugin.mjs` 的**代码行**里没有
   `ctx.approval` / `approver` / `requestApproval` / `approval/request`（两文件里 `approval` 只出现在注释），
   且 `host-plugin.mjs` 仍注册自己的 `/winstage*` 命令面。
5. **审计镜像行为**（注入假 session 汇，驱动 `audit-mirror.mjs` 真实现）：`ask()` 写 `approval/asked`
   且**自身不产生任何 `decided`**；重复 `ask` 也不产生；`decide()` 只在配对的 `asked` 之后写 `decided`
   且 id 完全相同；outcome 语义 `allowed-once`/`rejected` 与 `note` 透传；`hasOpenTurn` 真值表；
   **回合未开时 `ask`/`decide` 都跳过并返回 falsy、一个事件都不写**（不造孤儿事件）；拿不到 session 句柄跳过不抛；
   `append` 抛错被吞掉且留 error 日志（审计失败不影响审批）。
6. **文档真值**：`docs/DSH集成.md` 不得再声称 `sandboxMode` 报 `undefined`（见 C1）。

**计数（本轮实跑）**：

- 正常模式：`RESULT: PASS checks=29 failures=0 skips=1 mode=normal`（**29 个已执行断言全部 ✓ ＋ 1 个 SKIP ＝ 30 个用例**，exit 0）。
  唯一的 SKIP 是"`decide()` 强制必须已有同 id 的 `asked`"：`audit-mirror` **只做 emit、不做模块级配对校验**，
  配对由调用方顺序（`review-service.mjs:549` / `:963` / `:1114`）与平台不变式
  （`R\dsh-user-approval\lib\invariant.js:213`）兜底；跨回合孤儿场景需真装配 + 人为时序，离线无法证伪
  ⇒ 按"宁可 SKIP 也不假 PASS"处理（对应侦察 §3.9 / V6）。
- `--plant` 模式：`RESULT: FAIL checks=30 failures=12 skips=1 mode=plant`（exit 1）——变异体覆盖
  删 `defaultPreset`、`sandboxMode=undefined`、判据改 `!== 'off'`、注入 `ctx.approval`、
  审计镜像自补 `decided`、文档追回旧说法；每个变异体都真的打到对应断言（非空转）。

### 5.4 接线与全量离线门

- `src/testrunner.mjs:82`（`OFFLINE_SUITES` 末位）与 `verify.cmd:44`（`for %%S in (…)` 末位）**同序同项**登记
  `policy-never-consistency`；`tests/suite-wiring.mjs` 机器校验通过（`RESULT: PASS checks=28 failures=0`）。
  `verify.cmd` 保持纯 ASCII（R11），`suite-wiring` 第 4 节同时校验了这一点。
- 全量门：`cmd /c "verify.cmd > .t\policy-verify.txt 2>&1"` ⇒ **21/21 套件都跑到，`RESULT: FAIL`，exit 1**；
  标记计数 **1890**（1862 个 `✓` + `probe-selfkill-guard` 自报 28 个 `[OK  ]`）。
  - 19 套件绿（含新套件 29/0/1SKIP、`suite-wiring` 28/0、`residual-baseline` 43/0）。
  - **2 套件红、共 3 条断言**，全部是同一件**环境事实**、与 C1/C2/C3 **无关**：
    `tests/limits.mjs` 的 `4x`/`4ab`（自指/互指 junction 环检测）与
    `tests/workspace-regressions.mjs:266-270`（"旧判据必然失效：junction `lstat.isSymbolicLink()=false`"）。
    实测：本会话 `lstatSync(<junction>)` = `mode=0xa1b6 / isSymbolicLink()=true`，而这两个套件记录的
    `[实测]` 基线是 `mode=0x41b6 / isSymbolicLink()=false`（`src/limits.mjs:667-670`）⇒
    `src/limits.mjs:698` 的 `info.isDirectory()` 为假 ⇒ 走 `:719 reparse-point-not-followed`，环检测分支进不去。
  - 判定：**不是本轮改动引入**。这两个文件本轮未触碰，mtime（`src/limits.mjs` 0:22:33、`tests/limits.mjs` 0:18:46）
    早于最近一次全绿日志 `.t/r4-verify.txt`（1:13:19，20 套件 / 1863 / `ALL PASS`）；
    `.t` 里 8 份历史 verify 日志 limits 全绿，本次是本会话（file policy = `danger-full-access`）第一次红。
    推测与"受限令牌 vs danger-full-access 下 libuv `lstat` 走哪条路径"有关（`[推断]`，本会话无法用受限令牌复跑证实）。
    **处置需改 `tests/limits.mjs` / `tests/workspace-regressions.mjs`，超出本轮授权文件表 ⇒ 本轮不动、只如实上报。**

### 5.5 README 数字更正（`README.md`）

- 清单口径 20 → **21 套件**（`:21`、`:27`、`:31`、`:346`、`:365-366`、`:498-500`、`:552`、`:556`、`:595`）。
- §8.2 权威表（`:498-539`）整表改为 `.t/policy-verify.txt` 那一次运行的逐套件计数：新增
  `policy-never-consistency` 行；`workspace-regressions` 16 → **15（+1 ✗）**；`limits` 182 → **180（+2 ✗）**；
  `probe-selfkill-guard` 27 → **28**；合计 1863 → **1890**；并注明 **2 套件红 / 3 条断言**与原因。
- 插件侧辅助表（`:572`）：`.t/default-on-selftest.mjs` 由 `13/0` 更正为
  **11 PASS / 1 FAIL(L5b) / 2 PENDING-LIVE-FLIP（exit 1）**。

### 5.6 刻意**没有**改的东西（与 §3.2 的 N1–N5 一致）

| # | 未改 | 理由 |
|---|---|---|
| N1 | `dsh-plugin/shell-executor.mjs` 的 `sandboxMode='workspace-write'` | 改成"反映生效档位"会形成会话档位反馈环并改写 `dsh-tool-fs`/`dsh-tool-pwsh` 装配语义（§3.2 N1）；本轮反而在 C1 文档与新套件检查 2 两处把它钉死 |
| N2 | `dsh-plugin/audit-mirror.mjs`（继续写 `approval/asked`、不自动补 `decided`） | §3.2 N2；新套件检查 5 用行为断言把它钉住（含"回合外跳过、不造孤儿事件"） |
| N3 | `dsh-plugin/client.js` 的槽位接管/撤销判据 | §3.2 N3；新套件检查 3 把它钉住（只认 `readSwitch(form) === 'on'`） |
| N4 | `R\*`（harness 只读参考） | 本任务规定只读；三条平台侧缺陷仍按 §3.3 上报 Lead（H1/H2/H3） |
| N5 | `~\.dsh\profiles\web\cordis.patch.yml`（含 `winstage-sandbox: enabled:false`、重开 `pwsh-sandbox`） | §3.2 N5；新套件检查 1 **只读**它、只断言显式 `defaultPreset` 存在且自洽，绝不写它 |
| — | `.t/default-on-selftest.mjs` 的 `L5b` 红项 | 修它要动 `dsh-plugin/client.js`（授权外）；本轮如实记录，不粉饰 |
| — | `tests/limits.mjs` / `tests/workspace-regressions.mjs` 的 junction 基线 | 授权外；属环境口径问题，已在 §5.4 与 README §8.2 如实记录并上报 Lead |

### 5.7 授权外但必须上报的一件事（新增）

**H4（测试工具层的环境依赖）**：两个套件把"junction 被 `lstat` 穿透"写成 `[实测]` 基线
（`src/limits.mjs:667-670`、`tests/workspace-regressions.mjs:266-270`），而该行为**随会话/令牌环境而变**：
本会话实测 junction 是 `isSymbolicLink()=true`（mode `0xa1b6`），于是 3 条断言红。建议把这些断言从
"钉死某个 OS 行为"改成"探测当前行为并断言**实现自身的口径正确**"（例如：无论 `lstat` 报目录还是符号链接，
环都必须被 `already-visited-cycle` 收住），否则同一个仓库在不同会话里会给出不同的红绿结论。

---

## 6. 实施结果（测量层脆性修复轮；C1/C2/C3 索引 + 本轮新增修复）

> 本节由**测量层修复会话**追加（DSH 文件策略 = **danger-full-access**、审批策略 = `never`）。
> §0–§5 **原样保留、未改一个字**（§5 是上一轮 C1+C2+C3 实施会话的追加）。
> 口径声明：本节里标 `[实测]` 的都是**本轮本机本会话真的跑过**的命令与数字；
> 没有复跑的（例如 C2 的四条 `.t` 自测、沙箱段）继续沿用上一轮口径并如实标注。

### 6.1 C1 —— 文档真值修正（上一轮已落地，本轮未再改）
- 落点：`docs/DSH集成.md` §12.1（现行 `:479-495`）不再声称 `sandboxMode` 报 `undefined`，
  改为"恒定报最窄可用档 `'workspace-write'`"并保留因果链；`tests/policy-never-consistency.mjs`
  检查 6 把它变成机器可检的断言（文档里不得有同一行同时出现 `sandboxMode` 与 `undefined`）。
  细节与证据见 §5.1（本节只索引，不重复）。

### 6.2 C2 —— `.t` 自测实测数字（上一轮已落地，本轮未复跑）
- 上一轮实跑口径见 §5.2 的表：`permission-slot-selftest` 45/45、`toggle-selftest` 20/20、
  `shell-selftest` 120/120、`default-on-selftest` **11 PASS / 1 FAIL(`L5b`) / 2 PENDING-LIVE-FLIP（exit 1）**。
- `[未实测]`（本轮）：这四条**本轮没有复跑**（本轮授权文件表不含 `dsh-plugin/**` 与 `.t/**`），
  因此它们的数字仍是**上一轮时点口径**；`L5b` 那条红项**仍未修**（修它要动 `dsh-plugin/client.js`，授权外）。

### 6.3 C3 —— 新守门套件 `tests/policy-never-consistency.mjs`（上一轮已落地）
- 6 个检查段：显式 `defaultPreset` 硬断裂、`sandboxMode` 静态最窄、槽位接管与审批策略无关、
  不经过 `ctx.approval`、审计镜像不编造 `decided`、文档真值（详见 §5.3）。
- `[实测]` 上一轮口径：正常 `RESULT: PASS checks=29 failures=0 skips=1`（29 断言 + 1 SKIP = 30 用例）；
  `--plant` `FAIL checks=30 failures=12`。本轮全量门里该套件仍是 **29 ✓ / 0 ✗ / 1 SKIP**（见 6.4）。
- 登记：`src/testrunner.mjs:82` 与 `verify.cmd:44` 同序同项；`tests/suite-wiring.mjs` 机器校验
  `[实测]` 本轮 **28 项 / 0 失败**。

### 6.4 本轮新增修复：测试不许把"宿主 `lstat` 形态"当不变量（H4 的落地）
**根因（`danger-full-access` 行 ＝ 本轮实测；`workspace-write` 行 ＝ 历史受限会话实测、本机现不可复现）**：
同一台机器上、同一段 `fs.symlinkSync(…,'junction')`，junction 的 `lstatSync` 随
DSH 文件策略给出**两种形态**：

| 文件策略 | `mode` | `isSymbolicLink()` | `isDirectory()` | `dirent.isSymbolicLink()` | 来源 / 本轮可测性 |
|---|---|---|---|---|---|
| `workspace-write`（更早的受限会话；`.t/` 历史全绿日志均为该策略） | `0x41b6` | `false` | `true` | `true` | **历史（受限会话）实测**；**`[未实测]` 本轮** —— 本机（`danger-full-access`）**不可复现**该形态，本轮只在 `tests/limits.mjs` §4p2/§4p3 里用**注入的盲 lstat / 双盲 `fsImpl`** 模拟它（`[注入]`，不是本轮实测） |
| `danger-full-access`（本轮） | `0xa1b6` | `true` | `false` | `true` | **`[实测]` 本轮**（复核者 §7.1/§7.3.3 亦复现）；这是"根因（本轮实测）"里**唯一**可测的一行 |

`mode & 0x400` 在**两种形态下都是 0**（Node 的 `Stats.mode` 是 POSIX 位，不携带 Win32 重解析属性）。
后果：`src/limits.mjs:731` 的 `else if (info.isDirectory())` 在本轮形态下为假 ⇒ 走
`:752 reparse-point-not-followed`，`already-visited-cycle` 分支**到不了** ⇒ 旧断言
（`tests/limits.mjs` §4x/§4ab、`tests/workspace-regressions.mjs:266-270`）整片变红。
（上述两处是**本轮改完注释之后**的行号。）
**两种处置都安全**：都不入栈、不重扫、不越界、不截断；只有 reason 字符串与环计数不同。

改动（只动授权文件表的 5 个文件；**没有**为了让门变绿而放宽任何安全判据）：

1. `tests/limits.mjs`
   - 文件头 ②/⑦ 与 `--plant` 段（`:14-64`）：把"junction 的 lstat 必然是 X"改成"两种形态都实测过、
     都安全"，并如实记录 `[实测]` 本轮 `followReparsePoints` 对 junction **已失效**（见第 4 点）。
   - 新增 §4p2（`:499-533`）：注入**盲 lstat**（只把 `escape` 报成目录，模拟 `workspace-write` 形态），
     正常模式下断言**结构性"解析后出树"判据（判据 C）独自**拒掉树外 1 MiB、reason 为
     `realpath-outside-tree*`；`--plant` 下**反向断言**钩子确实把树外 1 MiB 计了进来
     ⇒ 即使本机钩子对 junction 失效，"树外 junction 被跟随"这条不变式仍有**变异覆盖**（不是死断言）。
   - §4v–4ab（`:557-762`）：新增 `SAFE_JUNCTION_REASONS`（`:596`，接受
     `already-visited-cycle` **或** `reparse-point-not-followed`）与计数用 `countingFs`（`:599`）；
     `4x` 只要求"结构化 skipped + reason 属于两种安全处置 + 走环分支时必须有 `cycle-skipped` 证据"；
     **新增 `4x2`/`4ab3`**：注入 `fsImpl` 数 `readdirSync`，断言
     **"没有任何真实目录被展开超过一次"**（`max=1`）——这才是环检测失效/无界重扫时必然见红的那条；
     `4ab` 删掉固定的 `cycles=2`（宿主形态相关），改为"终止 + 有界 + 不截断 + 账目 5 B/1 文件"；
     `4ab2` 要求两条环链接都结构化留痕；**新增 `4ab4`** 补互指树的 `checkStagingQuota`
     ⇒ `complete=true` / `allowed=true`（D1 的真实危害是"配额统计永远不完整 ⇒ 永久拒绝暂存写入"）；
     `4z` 原有那条保留。安全方向**只加严**：树外 junction 不跟随、`guard` 只能加严（§4p/§4q/§4r/§4aa 未放宽）。
     **（§8 收尾追加）** 复核 §7.3.1 指出"§4p/§4q/§4aa 在本机没有可失败路径"⇒ 本轮新增 **§4p3**：
     注入**双盲** `fsImpl`（`lstat` ＋ `readdir`/`Dirent` 都看不见链接）＋ `guard: () => false`（故意否决判据 C），
     正常模式断言"外部 1 MiB 不进账且 `outside` 从未被 `readdir`"，`--plant` 反向断言钩子的破坏力 ——
     即用变异体 `shouldNotFollow = guard ? guardSaysLink : escaped` 验证该断言**真的能红**（§8 F1）。
   - `[实测]` 计数：正常 **187 断言 / 0 失败 / 0 SKIP**（`RESULT: PASS`，exit 0；修改前 182/2）；
     `--plant` **189 断言 / 3 失败**（恰好是 §4e/§4f/§4g 三条硬链接去重**账目**不变式，
     元断言 `PLANT1`（失败 ≥3）与 `PLANT2`（钩子可复位）均 ✓）。日志：`.t/ml-fix-normal.txt`、`.t/ml-fix-plant.txt`。
     **（§8 收尾后口径）** F1 新增 §4p3 ⇒ 正常 **188/0**、`--plant` **190/3**（红项仍恰为 §4e/§4f/§4g）；
     上面的 187/189 是 F1 **之前**的时点口径，保留作对照；新日志 `.t/f1-new-normal.txt` / `.t/f1-new-plant.txt`。
2. `tests/workspace-regressions.mjs`
   - `:283-320`：删掉"旧判据必然失效（`lstat.isSymbolicLink()=false`）"这条**钉宿主事实**的断言，
     改为**行为分流**：先测出本机形态（`lstatSeesLink`），再断言**对应的安全结局** ——
     junction 结构化记为 `reparse-point`、**未被 walk 走到**、**树外内容一个字节都没进快照**、
     且 `mode & 0x400 === 0` 在两种形态下都恒为假。原始观测（`0x41b6/false/true`）**保留在注释里**，
     并明确标注为**宿主 / 文件策略相关、非普适**。
   - `:436-482`：同一族问题——`--plant` 的 P2/P3/P4 原期望"旧 walker 优雅地用 `cycle-detected` /
     `ELOOP` / `depth-limit` 收住"，这只在 `lstat` 盲形态下成立；本轮形态下旧 walker 会把 junction
     当**文件**去 hash ⇒ `EISDIR` 当场崩。改为按形态断言"**必被抓住**"的对应形态
     （形态 A：`EISDIR`；形态 B：结构化 `skipped`），绝不放宽成"红了也行"。
   - `[实测]` 计数：正常 **17 断言 / 0 失败**（exit 0；修改前 16 项 / 1 红）；
     `--plant` **25 项 / 1 失败**（该 1 项是 P1"变异体必须被抓住"的**预期红**，锚点断言全部 ✓）。
     日志：`.t/wr-fix-normal.txt`、`.t/wr-fix-plant.txt`。
3. `src/limits.mjs` —— **只改注释，零行为改动**（导出 API、默认值、判据、遍历逻辑一字未动）：
   - `:87-100`：更正一条**错误的 `[实测]`**（旧注释称 `statSync(tmpdir)` 带 `0x400` 位；本轮实测
     `0x41b6`/`0x400` 位为 0），并记录 junction 的两种 `mode`（`0x41b6` / `0xa1b6`）**都不带 0x400**；
     非符号链接重解析点保留 `0x400` limbs 作**保守兜底**并标 `[未实测]`。
   - `:412-417`：`skipped[].reason` 明确声明**不是契约**（宿主/策略相关），要判"是否出树"只看
     `realpath-outside-tree*`。
   - `:498-500`：`shouldSkip` 的 `guard` 注释改为"lstat 是否看得见 junction 依策略而变 ⇒ 按路径自查才可靠"。
   - `:540-572`：D1 环检测注释补上"两种形态两种安全处置"，并声明 `danger-full-access` 下
     **任何 in-tree junction 都不会被展开**（残留，见 6.6）。
   - `:625-643`：判据 A 注释记录两种 `lstat` 形态**在同一台机器上都被实测到**，删掉单形态 `[实测]` 主张；
     并加推论（该形态下"跟随/入栈"分支物理上到不了）。
   - `:696-703`：`guard` + 判据 C 的注释同族更正（判据 C 永远要算，guard 只能追加）。
4. **`--plant` 的非空转证明**：本机 `danger-full-access` 形态下 `followReparsePoints` 对 junction 失效
   （`§4a/4b/4p` 在 `--plant` 下依旧绿），因此本轮用 §4p2 的"盲 lstat + 反向断言"补回这条变异覆盖；
   同时 `disableHardlinkDedupe` 仍让 §4e/§4f/§4g 三条**账目**断言变红（`PLANT1` 要求 ≥3 恰好满足）。
   ⇒ `--plant` 依旧"拆一条真不变式就变红"，不是只改期望字符串。
5. 全量离线门（`[实测]` 本轮本会话）：
   `cmd /c "verify.cmd > .t\policy-verify2.txt 2>&1"` ⇒ **`RESULT: ALL PASS`、exit 0、
   21/21 套件全绿、0 条红断言**；标记计数 **1899** ＝ 21 个套件块 **1871** 个 `✓`
   ＋ `probe-selfkill-guard` 自报 **28** 个 `[OK  ]`；逐套件只有两处变化：
   `tests/limits.mjs` 180 → **187**、`tests/workspace-regressions.mjs` 15(+1✗) → **17**。
   对照：修复前 `.t/policy-verify.txt` 为 1890（1862 `✓` + 28）／2 套件红／3 条断言红／`RESULT: FAIL`。
6. `README.md` §8.2 已按**这次运行**重写口径块与两行数字（合计 1890 → **1899**、`limits` → **187**、
   `workspace-regressions` → **17**），并把日志路径改成 `.t\policy-verify2.txt`；§9.3 的"重解析点 / D1"
   两条同步改为两形态口径（未复跑的历史数字保留并标注来源）。
7. `tests/suite-wiring.mjs` **未改也不需要改**：`verify.cmd` 与 `OFFLINE_SUITES` 均未动，
   `[实测]` 本轮 `RESULT: PASS checks=28 failures=0`。

### 6.5 测量层脆性（一句话结论）
**此前 `.t/` 里的全绿日志（`v3-final-verify.txt` / `r4-verify.txt` / `n-fix-verify.txt` /
`fix-final-verify.txt`）全部来自 `workspace-write` 会话**，它们把该策略下 junction 的 `lstat` 形态
当成了普适事实；本轮 `danger-full-access` 会话把这条隐含假设打红。现在 `tests/limits.mjs` 与
`tests/workspace-regressions.mjs` **对两种 `lstat` 形态都覆盖**：断言钉的是"安全结局 + 有界工作量"
（结构化跳过 / 不入栈 / 树外不计数 / 没有真实目录被展开两次 / 配额判定可用 / guard 只能加严），
而不是某个 reason 或某个 `mode` 值 —— 今后再换策略/换 libuv，红绿结论由**不变量**决定，不再由宿主决定。

### 6.6 残留（`[实测]` 本轮，值得标记）
- **本机 `danger-full-access` 形态下，配额遍历不再下降进任何 in-tree junction**：junction 在
  `kind !== undefined` 分支就被拒（`reason:'reparse-point-not-followed'`），
  "跟随/入栈 + `visitedDirs` 环检测"那条分支**物理上到不了**。
- **是否安全：安全。** ① 树内内容仍可经**真实路径**到达并被计数（目标目录本来就会被 walk 枚举到，
  不会因为别名不展开而漏计 —— 只少计"别名条目"本身，字节数不受影响）；② 树外目标**从不被计数**；
  ③ 不会重复计数；④ 环检测仍是独立的第二重保险，且"每个真实目录只展开一次"在本机由更早的那条判据
  （非目录链接不入栈）保证，`§4x2/§4ab3` 用计数 `readdirSync` 把结果钉住。
- **但仍记为残留（覆盖度，不是安全问题）**：`visitedDirs` 环检测分支在本机**没有活路径**，
  它的"活证据"只存在于 `workspace-write` 形态（历史日志）与本次的注释/盲形态模拟之外；
  若将来某个 Windows/libuv 版本让 junction 的 `lstat.isDirectory()` 重新变 `true`，
  本机走的就是环检测分支（现已被断言覆盖），但反过来若某版本让**非 junction 的重解析点**也
  `isDirectory()=false`，则"入栈分支"的覆盖面会进一步缩小。建议：把"本机走过的分支"记进
  `measureTree` 报告（例如 `notes` 里记一条 `branch:reparse-refused` / `branch:cycle-refused`），
  这样"分支覆盖"本身可机检；本轮**未实现**（会改行为/报告结构，超出"只改注释"的授权），
  因此在此如实列为待办。

### 6.7 仍未修 / 未验证
- `tests/workspace-regressions.mjs --plant` 与 `tests/limits.mjs --plant` **按设计红**
  （变异体必须被抓住）；它们是证据运行，不在 `verify.cmd` 门内，不做"全绿"要求。
- `.t/default-on-selftest.mjs` 的 `L5b` 红项、以及 C2 其余自测数字：**本轮未复跑**
  （授权文件表之外），仍为上一轮口径。
- 沙箱段（`SANDBOX_SUITES`，需未受限会话）本轮未跑，本文不涉及。

---

## 7. 独立复核（策略变更一致性实施后）

> 本节由**独立复核会话**追加（未参与实现；只读代码 / 日志 + `.t` 下一次性变异体与临时 profile 夹具，夹具已删除）。
> §0–§6 **原样保留、未改一个字**。复核环境：DSH 文件策略 `danger-full-access`、审批 `never`；
> 所有命令都在仓库根用 `cmd /c "… > .t\v6-*.txt 2>&1"` 跑，套件逐个跑。

### 7.1 全量门（复核者自跑，非引用）
- `cmd /c "verify.cmd > .t\v6-final-verify.txt 2>&1"` ⇒ **exit 0 / `RESULT: ALL PASS` / 21 个套件块 / 0 条 `✗` / 标记 1899**（21 块共 **1871** 个 `✓` ＋ `probe-selfkill-guard` 自报 **28** 个 `[OK  ]`）。
- 与 `.t/policy-verify2.txt` **逐套件计数逐项一致**（21 行全同；文件字节数同为 289391，hash 不同只因 `%TEMP%` 随机路径出现在日志里）。
- 与修复前 `.t/policy-verify.txt` 对照：**只有 2 个套件变化** —— `limits` 180/2 → **187/0**、`workspace-regressions` 15/1 → **17/0**；其余 **19 个逐项不变**。修复前日志复核：1862 `✓` / 3 `✗` / 28 `[OK  ]` / `RESULT: FAIL`，与 §6.4.5 的对照口径相符。
- 复核者自跑两套件：`limits` 正常 **187/0/0**（exit 0）、`--plant` **189/3**（exit 1，红项恰为 4e/4f/4g）；`workspace-regressions` 正常 **17/0**、`--plant` **25/1**（红项为 P1 预期红）。与 §6.4.1/§6.4.2 声明的数字一致。
- README §8.2 的 21 行表与合计 **1899** 与本次日志**逐行相符**。

### 7.2 对抗性变异（复核者构造，`.t/v6-adv`，脚本已删除）
| 变异体 | 做法 | 结果 |
|---|---|---|
| A 重扫 | 保留 `already-visited-cycle` + `cycle-skipped` 记录，但**照样入栈**，并让该分支对树内非目录链接可达 | **红 8 条**：4v/4w/4y/4z/4ab/4ab4 ＋ **4x2/4ab3**（`readdirSync` 计数）。⇒ "接受两种 reason"**没有开洞**：`4x`/`4ab2` 这类 reason 断言仍绿，真正抓住重扫的是 reason 无关的**展开次数/终止/账目**不变量 |
| B 判据 C 失效 | `isWithin()` 恒 `true` | **红 1 条 = 4p2**（外部 1 MiB 被计入）⇒ 4p2 非空转 |
| B2 逃逸关掉 ＋ 跟随链接目标 | `escaped=false` 且把链接目标入栈 | **红 10 条**，含 **4a**（`bytes=1048676`） |
| C guard 否决判据 C | `shouldNotFollow = guard ? guardSaysLink : escaped` | **全绿 187/0（未抓住）** ⇒ 见 7.3.1 |

### 7.3 复核发现（严重度均为**低**：测试判定力 / 文档，不是运行时缺陷）
1. **§4p/§4q/§4aa"guard 只能加严"在本机形态下没有可失败路径**（变异体 C 全绿）。原因：`danger-full-access` 下 `dirent.isSymbolicLink()===true` ⇒ 与 guard 无关地先落入"非目录链接"分支（reason `reparse-point-not-followed`），字节数恒为 100。**生产代码本身正确**：`src/limits.mjs:713-714` 把 `escaped` 与 guard 结果 **OR** 起来，guard 无法否决判据 C。复核者用"lstat+dirent 双盲 ＋ `guard:()=>false`"直接探针证明：真源码 `bytes=1`（安全），变异体 C `bytes=1048577`（危险）。⇒ 缺的是"**双盲 ＋ guard**"这条**测试组合**；该缺口**不是本轮"接受两种 reason"改写引入的**（§4x/§4ab 之外未动 guard 段），但 §6.4.1 的"§4p…未放宽"容易被读成"仍钉住"。建议补一条"双盲形态 ＋ 漏判 guard"的 4p3。
2. **`src/limits.mjs:29` 的断言数字已过期**：仍写"`tests\limits.mjs` 的 **182** 项断言，正常模式自报 `assertions=182 failures=0`"，而本轮套件为 **187/0**。C2 的口径是 `.t` 自测，未覆盖此处；但该文件本轮被改（注释），这是一处**本轮留下**的可机检不实数字（本会话唯一新增的、文档级不实陈述）。
3. **§6.4 的"根因（本轮实测）"表把两种 `lstat` 形态都算作本轮实测**：本轮只能测到 `danger-full-access` 行（`mode=0xa1b6 / isSymbolicLink()=true / isDirectory()=false`，复核者已复现）；`workspace-write` 行（`0x41b6/false/true`）**本机现不可复现**（其 `dirent` 列同样无法复核），应标为"历史受限会话实测"或 `[推断]`。对照：`tests/limits.mjs` §4p2 的盲形态**确实**是注入（文件中已明确标注），不是实测。
4. **`git diff` 对 `src/limits.mjs` 为空**：该文件**从未入库**（`?? src/limits.mjs`；`tests/limits.mjs`、`tests/policy-never-consistency.mjs` 同），且仓库内**不存在改前副本**（唯一副本 `.t\sbx3\fixE\guard-scratch\src\no-spawn-src\limits.mjs` 与现文件 **hash 相同**，`D98F6AA44ED5023B8FE32D969D2F53C77CA080EA53E60839CAAE5EE2EB2AA2B7`）⇒ **"只改注释"无法独立证明**。可用的替代证据：`.t/ml-fix-plant.txt`（16:09:22，**早于** src 改动 16:21:15）与 `.t/ml-fix-normal.txt`（16:21:46，晚于）计数完全相同（189/3、187/0），且 187 条断言对现有导出 API / 默认值 / 遍历语义全部成立（导出面：`UPSTREAM_STAGING_BYTES`/`STAGING_BYTES_SOURCE`/`OUTPUT_CAP_SOURCE`/`DEFAULT_LIMITS`/`LIMIT_KEYS`/`FILE_ATTRIBUTE_REPARSE_POINT`/`MAX_TREE_ENTRIES`/`TRUNCATION_MARKER_TEMPLATE`/`LimitsError`/`parseSize`/`formatSize`/`toGiB`/`isReparsePoint`/`reparsePointKind`/`measureTree`/`checkStagingQuota`/`applyOutputCap`/`wrapLimits`/`summariseLimits`/`__internal`）。
5. **`dsh-plugin/**` 本轮零改动（已证）**：`git diff --stat -- dsh-plugin` 相对 HEAD 有 7 文件 +643/−155，但其 mtime **全部 ≤ 2026-09-30**，而本轮改动文件的 mtime 都在 `2026-10-01 15:30–16:40`（`policy-never-consistency.mjs` 15:30、`testrunner.mjs` 15:32、`verify.cmd` 15:32、`docs/DSH集成.md` 16:00、`tests/limits.mjs` 16:08、`tests/workspace-regressions.mjs` 16:13、`src/limits.mjs` 16:21、`README.md` 16:30、本文件 16:40）⇒ 与"只动授权文件表"的声明一致。
6. **硬断裂守门的真实可达性（`[推断]`：读码，未在真实装配中复现）**：`R\…dsh-permission-presets\lib\index.js:178-180` 只在 `derive(EMPTY_KNOBS) === 'custom'` 时抛错，而 `derive`（`:296-305`）＝ `ctx.shell.sandboxMode` ＋ `ctx.approval.config.policy`。本机 profile 里 `WINSTAGE_SHELL` 未设 ⇒ `ctx.shell` 是平台 `dsh-pwsh-sandbox`（`:134-139` ＝ `ctx.sandboxPolicy.defaultMode`），`DSH_PERMISSION_MODE` 未设 ⇒ `dsh-base\cordis.patch.yml:232/:248` 给出 `workspace-write ＋ ask`（`:144` 显示 `defaultMode` **不**随会话 override 变）⇒ **与 profile 的 `workspace-write` 预设匹配** ⇒ **本会话即便删掉显式 `defaultPreset` 也不会抛**。§4.4 已把该风险条件化（机制 B）并标 `[官方]（未在真实装配中复现）`；但 README §8.2 该行是**无条件**因果（"缺失 ⇒ 控件整块消失"），建议补"需机制 B 或混合装配（如 `WINSTAGE_SHELL=1` ＋ 部署审批 `never`）"。
7. **两条失败路径不应混记**：`.t/e2e2.log:1-2` 的原始抛错是 `index.js:177`（`sandboxMode === undefined`），与 §4.4 的 `:180`（`defaultPreset === 'custom'`）是**两条不同**的构造期失败；两者都导致"`permission` 行装不上 ⇒ 控件消失"，§12.1 引的是前者、§4.4 讲的是后者，文档未混淆但应分开建账。

### 7.4 残留复核（`[实测]` 本轮）：与 §6.6 描述一致，且**安全**
现场：真实子目录（1000 B 文件）＋ 树内别名 junction（→该子目录）＋ 树内自指 junction（→树根）＋ 树外 junction（→1 MiB）。
结果：`bytes=1000 / files=1 / dirs=2 / entries=6 / truncated=false / errors=[]`；三条链接全部**结构化** `skipped`（树外那条 `reason=realpath-outside-tree:<目标>`，两条树内的 `reparse-point-not-followed`）；`readdirSync` 按真实路径去重后**每个真实目录恰好展开 1 次**；`checkStagingQuota` ⇒ `complete=true / usedBytes=1000 / allowed=true`；`notes` 里**没有** `cycle-skipped`。
⇒ 证实：① 树内内容仍经**真实路径**计一次（只少计"别名条目"本身，字节数不受影响）；② 树外目标从不被计数；③ 无重复计数；④ **环检测分支在本机确实没有活路径**。§6.6 的描述准确，残余属**覆盖度**而非安全。

---

## 8. 复核后收尾（F1–F4）

> 本节由**收尾修复会话**追加，逐条关闭 §7.3 的发现。§0–§5 与 §7 **原样保留**；§6.4 按 F3 只做
> **标注更正**（加"来源 / 本轮可测性"列 ＋ 一条时点口径更正），未改写任何结论。
> 环境同 §7：DSH 文件策略 `danger-full-access`、审批 `never`；命令都在仓库根用
> `cmd /c "… > .t\… 2>&1"` 跑。授权改动文件仅 4 个：`tests/limits.mjs`、`src/limits.mjs`（**只改注释**）、
> `README.md`、本文件。

### 8.1 逐条收尾（每条都有本会话原始输出）

| 编号 | §7 的发现 | 收尾动作 | 本会话证据 |
|---|---|---|---|
| **F1**（测试判定力，唯一实质项） | §4p/§4q/§4aa"guard 只能加严"在本机**没有可失败路径**（复核者的变异体 C `shouldNotFollow = guard ? guardSaysLink : escaped` 全绿 187/0） | `tests/limits.mjs` **新增 §4p3**：注入**双盲** `fsImpl`（`lstat` 与 `readdir`/`Dirent` **都**把 `escape` 报成普通目录 ⇒ `kind` 保持 `undefined`，只剩结构性判据 C）＋ `guard: () => false`（故意否决判据 C）。正常模式断言：**外部 1 MiB 不计入 `bytes`**（=100）**且 `outside` 从未被 `readdir`**；`--plant` 反向断言 `followReparsePoints` 钩子必须真的把 1 MiB 计进来并递归进 `outside`（与 §4p2 同口径，避免变成恒绿死断言） | `[实测]` 正常 `.t/f1-new-normal.txt`：`188/0/0`、§4p3 ✓；`--plant` `.t/f1-new-plant.txt`：`190/3`，红项**仍恰为** §4e/§4f/§4g |
| **F1 的非空转证明** | 断言必须"能红" | 把 `src\limits.mjs:714` 改成 `const shouldNotFollow = guard ? guardSaysLink : escaped`，做成临时变异体模块（`.t/f1-mutant/`，**跑完即删**）；用同一套件指向它跑 | `[实测]` 变异体：`188/1`，**唯一红项 = §4p3**（`bytes=1048676`、`recursedIntoOutside=true`、`readdir=["tree","outside"]`、`skipped=[]`）；未变异源码同口径 `188/0`。日志 `.t/f1-mutant/mutant-run.txt`（变异体 `.mjs` 已删除） |
| **F2**（文档级不实数字） | `src\limits.mjs:29` 仍写"**182** 项断言 / `assertions=182 failures=0`" | 该注释改为**本会话实测口径**：正常 **188/0**、`--plant` **190/3**（§4e/§4f/§4g）；历史 `workspace-write` 受限会话的 **182/0** 保留并**显式标注为历史形态**。**只改注释** —— 导出 API / 默认值 / 判据 / 遍历逻辑一字未动（§7.3.4 的既有可证明性局限仍在） | `.t/f1-new-normal.txt`、`.t/f1-new-plant.txt`；`src\limits.mjs:27-35` |
| **F3**（§6.4 表标签错误） | "根因（本轮实测）"表把 `workspace-write` 行也算作本轮实测 | §6.4 表**新增"来源 / 本轮可测性"列**：`workspace-write` 行 ＝ **历史受限会话实测、`[未实测]` 本轮不可复现**（本轮只以**注入**盲/双盲形态模拟，标 `[注入]`）；`danger-full-access` 行 ＝ **本轮 `[实测]`**，且是本表**唯一**可测行。标题同步改为"`danger-full-access` 行 ＝ 本轮实测；`workspace-write` 行 ＝ 历史…"。§6.4.1 的 187/189 保留为 F1 **之前**的时点口径，并附收尾后 188/190 的更正 | 本文件 §6.4 / §6.4.1 |
| **F4**（README 无条件因果） | README §8.2 把装配期硬断裂写成"缺失 ⇒ 控件整块消失"的**无条件**因果 | §8.2 该行改为**条件性**：需**装配期**机制（`DSH_PERMISSION_MODE` 在装配时取与 profile 预设不匹配的值 ＝ §4.4"机制 B"）**加上**一个没有显式 `defaultPreset` 的 profile ⇒ `derive(EMPTY_KNOBS) === 'custom'` ⇒ `permission` 行构造期抛错。明确写出**本会话不成立**（`DSH_PERMISSION_MODE` 未设 ⇒ `workspace-write ＋ ask` 与 `workspace-write` 预设匹配，删掉 `defaultPreset` 也不会抛）与**源码推导 `[推断]`、未在真实装配中复现**（V1 仍待办）；并保留 `tests/policy-never-consistency.mjs` 作为防回归守门 | README §8.2；本文件 §4.4/§7.3.6 |

### 8.2 收尾后的全量门（`[实测]` 本会话）

- `cmd /c "verify.cmd > .t\policy-verify3.txt 2>&1"` ⇒ **exit 0 / `RESULT: ALL PASS` / 21/21 套件全绿 / 0 条 `✗`**；
  标记计数 **1900** ＝ 21 个套件块 **1872** 个 `✓` ＋ `probe-selfkill-guard` 自报 **28** 个 `[OK  ]`。
- 与 §7.1 的 `.t/policy-verify2.txt`（1899 ＝ 1871 ＋ 28）逐套件对照：**只有 `tests/limits.mjs` 按设计变化
  187 → 188**（F1 新增 §4p3），其余 20 个套件逐项不变。
- `tests/limits.mjs`：正常 **188/0/0**（exit 0）；`--plant` **190/3**（exit 1，红项仍恰为 §4e/§4f/§4g）。
- `tests/workspace-regressions.mjs` **17/0**（exit 0）、`tests/suite-wiring.mjs` **checks=28 failures=0**（exit 0）：未变。
- README §8.2 的表、合计与日志路径已按**本次运行**更新（1899 → **1900**、1871 → **1872**、`limits` 187 → **188**、
  `.t/policy-verify2.txt` → `.t/policy-verify3.txt`），并在该行注明变化原因。

### 8.3 仍未做 / 边界（不粉饰）

- **V1 仍未做**：真实 cordis 装配下复现"机制 B ＋ 无 `defaultPreset` ⇒ 控件整块消失"需要重启宿主 / 改 profile
  ⇒ README 与 §4.4 都只标 `[推断]`；本会话**没有**把 F4 的修复升级成 `[实测]`。
- **"只改注释"的可证明性缺口仍在**（§7.3.4）：`src/limits.mjs` 从未入库、仓库内无改前副本 ⇒ 本轮同样只能声明，
  不能独立证明；替代证据是"改后 188 条断言对同一导出面 / 默认值全部成立"＋本节套件计数。
- **`workspace-write` 形态在本机仍不可复现**（§7.3.3）：F3 只把标注改对，没有（也无法）把它变成实测。
- §6.6 的残留（本机环检测分支无活路径）与 §7.3.7 的"两条构造期失败路径分开建账"本轮**未处理**：前者属覆盖度
  残留、后者属文档建账，均不在本次授权改动范围内。

---

## §8 独立复核（补丁工具包 + 源码封印 + junction 规则）

> 本节由**独立复核会话**追加（未参与实现；只读代码/日志/清单 + `.t\` 下一次性夹具，夹具已删除）。
> §0–§8.3 **原样保留、未改一个字**。环境：DSH 文件策略 `danger-full-access`、`DSH_PERMISSION_MODE` 未设、
> node v24.21.0；命令都在仓库根用 `cmd /c "… > .t\v7-*.txt 2>&1"` 跑，套件逐个跑。本节是本轮唯一授权改动。

### 8.4 全量门（复核者自跑，非引用）

- `cmd /c "verify.cmd > .t\v7-final-verify.txt 2>&1"` ⇒ **exit 0 / `RESULT: ALL PASS` / 23 个套件块 / 0 条 `✗` /
  标记 1948**（23 块共 **1920** 个 `✓` ＋ `probe-selfkill-guard` 自报 **28** 个 `[OK  ]`）。
- README §8.2 的 **23 行逐行相符**（复核者按 `=== tests\X.mjs ===` 分块逐块复算，每行 `✓`(+`[OK]`) 与表内数字全等；
  合计行 1948 亦然）。与 `.t\patchkit-verify.txt`（298134 B）**仅 31 行不同**，全部是 `%TEMP%` 随机目录名 /
  候选哈希 / `durationMs` 这类非确定值 ⇒ 计数可复现。
- `OFFLINE_SUITES` 的 23 个 `id` 与 `verify.cmd` 的 23 个路径**同序同集**（`suite-wiring` 28/0 亦绿）。
- 三套件复核：`limits` **192/0/0**（exit 0）、`--plant` **194/5**（exit 1，红项恰为 §4a/4b ＋ §4e/4f/4g）；
  `baseline-integrity` **14/0**、`--plant` **19/5**；`dsh-patch-guard` **30/0**、`--plant` **33/4**。

### 8.5 junction 规则（A）：真实宿主形态，零注入

- 现场：`%TEMP%` 下 1 个 7 B 文件的树 ＋ `symlinkSync(root, root\self, 'junction')`。
  探针（`.t\v7-probe-junction.mjs`，跑完即删）：`lstat(self)` = `mode=0xa1b6 / isSymbolicLink=true / isDirectory=false`；
  `dirent.isSymbolicLink=true`；`realpath.native(self) == realpath.native(root)`；`lstat(该真实路径).isDirectory=true`。
- `measureTree(root)`（**生产默认调用，无 `fsImpl`、无 `guard`**）⇒ `bytes=7 / files=1 / dirs=1 / entries=3 /
  truncated=false / errors=[]`，`skipped=[{self, already-visited-cycle}]`，`notes=[cycle-skipped]`；
  `checkStagingQuota({root})` ⇒ `allowed=true / complete=true / usedBytes=7`。
  ⇒ **D1 的"永久拒绝写入"后果链在本机真实形态下不可复现**，环检测分支确有活路径。
- **对抗性变异（复核者自建，只改 `.t\v7mut\src\limits.mjs` 的副本；真源码未动，副本已删除）**：

  | 变异体 | 改法 | 结果 |
  |---|---|---|
  | A 同一真实目录展开两次 | `if (false && visitedDirs.has(key))`（关掉 `visitedDirs`） | **红 14 条**：`4v/4w/4x/4x2/4x3/4v2/4y/4z/4ab/4ab2/4ab3/4ab4/4ab5/4ac`（`4x2` 的 `maxExpansions===1` 是主判据） |
  | B 树外 junction 的字节进账 | `const escaped = false` | **红 4 条**：`4a`（`bytes=1048676`）/`4b`/`4p2`/`4p3` |
  | C guard 削弱包含性 | `const shouldNotFollow = guard ? guardSaysLink : escaped` | **红 1 条 = §4p3**（且仅此一条）⇒ §7.3.1 的缺口**确已关闭**："双盲 lstat/Dirent ＋ `guard:()=>false`"这条组合在本机现在真的有可失败路径 |

- `--plant`（`followReparsePoints`）在本机真实形态下**重新有咬合力**（§4a/4b 变红），与文件头 ⑧ 的声明一致；
  "每个真实目录只展开一次"在 A 变异体下见红、在真源码下 `maxExpansions===1`。

### 8.6 补丁工具包（B）

- **harness 一字未改（独立复核）**：harness 根下 `Get-ChildItem -Recurse -Filter *.dsh-patch-backup` = **NONE**；
  4 个 `target` 的 `Get-FileHash`（**不经过工具**）逐一等于 manifest 的 `beforeSha256`（`b56373be…`/`1a49cd8d…`/`4f23c620…`/`7f89170d…`）。
- `cmd /c "node tools\dsh-patches.mjs --check"` ⇒ **exit 0**：`harness 根: …1e7f6d9597241db0 (来源: known-npx-path)`，
  4 条全 `未应用`、`判定: 4/4 符合预期（未应用 4，已应用 0，漂移 0）`。
- **锚点独立复核**：4 个 `before` 在 4 个安装文件里各出现**恰好 1 次**，`after` 出现 **0** 次；整文件哈希与清单全等。
- **守门能红（不碰真文件/真树）**：把 manifest **副本**（`.t\v7-manifest-badhash.json` / `…-badanchor.json`）交给
  `--check --manifest` ⇒ 两条都 **exit 4**，分别报 `原样副本哈希 … != beforeSha256 …` 与 `before 片段在副本里出现 0 次`；
  再用 `auditManifest()`/`checkEntries()` 重放守门套件 §2/§3 ⇒ 两条都 `section2_ok=false` ＋ `drift=1`（点名 DRIFT 的 entry）。
  真 manifest 哈希前后不变（`892938da43d3e66b…`）。
- **P1 正确性**：`approval.approver` 由 **6** 个调用点统一供给 `ctx.get("approval")`（`dsh-tool-bash:370 / fs:1134 /
  pwsh:341 / tools:1200 / tools/types/ptc:314 / plugin-manager/types/tools:35`）；`approveEscalation` 在 `:103/:104`
  已先判 `approver`/`agent` 非空 ⇒ `approval.agent.session` 存在；`ApprovalService.effectivePolicy(session)` 是原型方法
  （`dsh-user-approval:152-153`，`overrideOf(session) ?? config.policy ?? "ask"`），`decide()` 只在 `never` 处短路
  `return "rejected"`（`:175`）⇒"没问过用户"这个前提成立。`?.(…)` 与整段 `try/catch` 并存 ⇒ 计算 message 的路径
  **不会抛**（`approval.approver` 即使为 `null`，`TypeError` 也被 `catch` 吃掉，落回原文案）。
  **新发现的清单级不实**：`manifest.verified[4]` 与 `patches\dsh\README.md:75` 写"grep `approveEscalation` 命中
  `dsh-tool-bash:354`"，实际调用点在 **:364**（:354 是 `{@link approveEscalation}` 的 JSDoc 引用）；且调用家族是
  **6** 个而非 4 个（都走同一个函数，修复面不受影响）。严重度**低**（清单/文档，非行为）。
- **P2 的 draft 标注诚实**：`status=draft`；`unverified` 明列两条残余（① `apply()` 时刻 `ctx.get("approval")` 的
  可达性无硬保证：cordis loader 用 `Promise.allSettled` 并发启动 ⇒ 改动是**防御性**的；② 工具 schema 是注册期事实
  ⇒ **per-fibre 只算一次**，**会话级** `never` 覆写仍登广告）；`residuals` 再复述一次。复核确认
  `ctx.get("approval")?.config?.policy` 解析为字符串（`ApprovalService.config = z.object({policy:…default("ask")})`，
  `dsh-user-approval:73-77`；`dsh-permission-presets:297` 同样写法）；`DSH_PERMISSION_MODE` 未设 ⇒ 组合层 = `ask`，
  与 `dsh-base\cordis.patch.yml:248` 的 `!!js` 表达式一致，"本机打上也看不到变化"属实。
- **P3 的拆分与全部消费者一致**：`CUSTOM_PRESET` 在目标文件 `:50` 有定义；`ctx.logger`（`:395/:398`）、
  `this.names`（`:238-240`，构造期 `autoAdmit === undefined` ⇒ 等于 `Object.keys(presets)`）、`ctx.approval.config.policy`
  （`:297`）都在作用域内。`this.names[0]` 必属 `catalog().defaultOptions`（`:248` = `Object.keys(presets)`），而客户端
  `permissionDefaultOf` 硬要求 `currentValue ∈ defaultOptions`（`client.js:576`）⇒"设置面钉真预设、投影面报 custom"
  与"绝不返回 custom"的声明一致；`resolve(pinnedDefault)` 虽不再无条件调用，但 `derive` 只可能返回真实预设名或
  `custom`，无校验缺口。客户端半所用符号都在作用域：`t` 是 `PermissionSelect` 的 props（`:306`，同文件 `:392` 已有
  `t("mode",{name:…})` 同形用法）、`react_jsx_runtime`（`:8`）、`PermissionSelect_module_css_default`（`:274`），
  early return 位于全部 hooks（`:309-323`）之后 ⇒ 语法与行为均合理。

### 8.7 源码封印（C）的**脚枪**（新缺陷，严重度 **高**）

- **缺陷**：`tests/baseline-integrity.mjs:78-87` 在 `readManifestText() === undefined` 时打印 `SKIP` 并
  `process.exitCode = failures > 0 ? 1 : 0`——而该分支之前只有 §1 的 6 条**与清单无关**的"收录面"断言，
  在正常仓库里全绿 ⇒ **删掉/移走封印清单 = 静默关掉封印**。
- **复现（等价夹具，真清单未动）**：把 `tools\baseline-sha256.mjs`、`tests\baseline-integrity.mjs`、
  `tests\suite-wiring.mjs`、`tools\dsh-patches.mjs` 与必需文件按同层级结构复制到 `.t\v7seal\`，**不放
  `docs\源码基线.sha256`** ⇒ `node .t\v7seal\tests\baseline-integrity.mjs` = **exit 0**、
  `RESULT: SKIP manifest-missing checks=6 failures=0 mode=normal`。真实仓库的一行复现：
  `move /y "docs\源码基线.sha256" "%TEMP%\seal.bak"` 后跑 `node tests\baseline-integrity.mjs` ⇒ **exit 0**
  （`verify.cmd` 因此仍报 `RESULT: ALL PASS`）。
- **对照**：同一缺失下 `node tools\baseline-sha256.mjs --check` ⇒ **exit 2**（`[基线缺失] … 这是"未封印"，不是"通过"`）
  ——**工具是 fail-closed 的，被登记的却是会 SKIP 的套件**，落差就在这里。
- **建议修法**（未实施，属授权外）：清单缺失时**默认判红**（`failures += 1`，或 `process.exitCode = 1`），
  只有显式 `WINSTAGE_ALLOW_UNSEALED=1` / `--allow-unsealed` 才允许 SKIP；或让 `verify.cmd` 额外跑
  `node tools\baseline-sha256.mjs --check`（它已返回 2）。
- **(b) 单行损坏**：`.t\v7seal` 里清单第一行翻一位 ⇒ 套件 **exit 1 / `RESULT: FAIL checks=14 failures=2`**，
  ✗ 行"没有'内容变化'的受封印文件"的**证据**里点名路径；对**真清单**做内存扰动
  （`diffManifest(collectEntries(), bad)`，不落盘）⇒ `changed=["autotest.mjs（清单 854f2450e7f4…4bc0 / 磁盘 854f2450e7f4…4bcf）"]`。
- **(c) `--plant` 非空转**：19 项 / 5 红（四类损坏各自被抓 ＋ "失败项 ≥3"元断言），已复核。封印收录面：清单 **95** 行
  （独立 `Get-Content` 计数），非空 95、首行 `autotest.mjs`、末行 `verify.cmd`。

### 8.8 表面与诚实性（`[实测]` 逐条边界）

- `dsh-plugin/**` **本轮零改动**：最新 mtime `review-service.mjs` = **2026-09-30 22:06:47**，而本轮文件全部在
  **2026-10-01 17:45–18:39**（`src\limits.mjs` 17:45、`manifest.json` 18:08、`tools\dsh-patches.mjs` 18:12、
  `src\testrunner.mjs` 18:13、`verify.cmd` 18:13、`tests\baseline-integrity.mjs` 18:15、`tests\dsh-patch-guard.mjs` 18:38、
  `docs\源码基线.sha256` 18:38、`README.md` 18:39）。
- `C:\Users\Administrator\.dsh\**`：**配置/装配面零改动**——`profiles\web\**` 最新 mtime = **2026-09-30 22:43:06**
  （`cordis.patch.yml`），`settings.yaml.imported`/`web-url.txt` 为 9 月；本轮只有**会话自身**的运行时状态被写
  （`sessions\**`、`storages\session_projcache\**`、`llm-deepseek\**`、`attachments\**`），不是交付物改动。
- **`[实测]` 过度声明（新文件）**：① `src\limits.mjs:97-102` 在"本轮 `danger-full-access` 会话**复测**"这个
  `[实测]` 抬头下列出**两种** mode（`0x41b6` workspace-write 与 `0xa1b6` danger-full-access）——本轮只能观测后者，
  前者应降为"历史受限会话实测"（§7.3.3 / F3 已对 §6.4 做过同样更正，此处**漏改**）。② `manifest.verified[4]` /
  `patches\dsh\README.md:75` 的 grep 行号（见 §8.6，实际 `:364`）。③ P2/P3 **未 apply、未渲染**：
  `patches\dsh\README.md:114-116` 已写明"没有一次重启 harness 后的端到端证据"，标注诚实；P2 的 `status=draft` 生效，
  但 P1 的 `status=verified` 只是"片段级 ＋ 消费者级静态验证"（其 `unverified` 已明示未运行期触发）⇒ 不构成过度声明，
  但 `verified` 一词易被读成"运行期已验证"，建议改 `static-verified`。
- **`patches\dsh\README.md:136` 与 README §8.2 不一致**：前者写"整仓关口（23/23 套件 / `RESULT: ALL PASS` /
  **1942** 标记）"，而其引用的 `.t\patchkit-verify.txt` 实测为 **1948**（1920 `✓` ＋ 28 `[OK  ]`）⇒ 该行的 **1942 是错的**
  （严重度**低**：文档数字，不影响门）。§6 引用的 10 个 `.t\*` 证据文件**全部存在**（已逐一 `Test-Path`）。
- **`patches/dsh/pristine/` 的适当性**：4 个副本共 **99,660 B**（`index.js` 15210/30425/16503 ＋ `client.js` 37522），
  是上游 **MIT** 许可的逐字节编译产物副本（四个包 `package.json` 均 `license: MIT`，各自带 `LICENSE`）。用途正当
  （离线自洽校验、`--emit-patches`、`--revert` 回落），体积可接受；**但 MIT 要求副本中保留版权与许可声明，而
  `pristine/` 只有 `index.js`/`client.js`，未随附上游 `LICENSE`/版权行** ⇒ 建议加一份 `LICENSE`（或 `SOURCE.md`
  指向 `@deepseek-ai/*@0.2.0-rc.2` 的 MIT 许可与来源）。另：`patches/**` **不在** `baseline-sha256.mjs` 的收录面内
  （只收 `src/tests/dsh-plugin/tools` ＋ 四入口），故 `pristine/` 的静默漂移只能靠 `dsh-patch-guard` §2 兜——它确实兜住了。

### 8.9 本机仍不可证明的

- `workspace-write` 下的 junction `lstat` 形态（`0x41b6 / false / true`）：本轮**不可观测**，只能注入模拟。
- P2/P3 打在 harness 后的**运行期效果**（工具清单里参数/描述是否真的消失；`permission` 行是否真的挂载并显示
  Custom）：未 apply、未重启、未截图。
- `DSH_PERMISSION_MODE` 与 profile 预设不匹配的部署（"机制 B"）在真实装配中的硬断裂：仍为 `[推断]`（§8.3 的 V1 未变）。

---

## §9 独立复核（封印改为 fail-closed 后）

> 复核者：独立验证代理（未参与实现），对象＝§8.7 高危缺陷修复轮之后的**冻结修订**。只做"确认 1 条高＋4 条低＋重跑关口"，
> 不重审全项目。下列结论均为**本会话实跑**（`[实测]`），证据在 `.t\v8-*.txt`。

### 9.1 F1（高）封印已 fail-closed，逃生口显式且出声

清单路径**不可用 env 覆盖**（`tools/baseline-sha256.mjs:34-36`：`REPO` 由模块 URL 推出、`MANIFEST_REL` 是常量）
⇒ 用**同层级夹具** `.t\v8-fixture\`（复制套件＋工具＋必须文件、清单独立生成；**用完已删除**）逐项复现，
并在**真实树**上另做一次"备份＋`try/finally`"的临时改名（改名前后 sha256 相同，`restored=True`）：

| 情形 | 退出码 | `RESULT:` | 关键信息 |
|---|---|---|---|
| 正常（清单在） | 0 | `PASS checks=14 failures=0` | — |
| 清单缺失 | **1** | `FAIL manifest-unsealed` | `原因: 找不到 docs/源码基线.sha256（尚未封印，或被人删除 / 移走）` ＋ `修复: node tools\baseline-sha256.mjs --write` |
| 清单 0 字节 | **1** | `FAIL manifest-unsealed` | `存在但为空（0 字节，或只有空白行）` |
| 只有空白行 | **1** | `FAIL manifest-unsealed` | 同上（`trim()` 后为空） |
| 清单**不可读**（同名目录 ⇒ `readFileSync` 抛 `EISDIR`） | **1** | `FAIL manifest-unsealed` | `存在但读不出来（EISDIR…）` |
| 清单损坏：翻一位哈希 | **1** | `FAIL checks=14 failures=2` | ✗ 证据**点名路径**：`dsh-plugin/assembly-toggle.mjs（清单 aaaa…aaaa / 磁盘 b3b2…ce2e）` |
| 清单损坏：非法行 | **1** | `FAIL checks=14 failures=4` | `非法行: "this-is-not-a-manifest-line"` ＋由此产生的"清单缺失"路径 |
| 逃生口 env（清单缺失） | **0** | `SKIP manifest-unsealed-allowed` | 出声：`! SKIP（**显式逃生口已开启**…）`＋原因＋"本状态下不给出任何一致性结论" |
| 逃生口 argv `--allow-unsealed`（清单缺失） | **0** | `SKIP manifest-unsealed-allowed` | 同上 |
| 逃生口 env 但清单**正常** | 0 | `PASS checks=14 failures=0` | 逃生口不放宽正常路径 |

- 真实树：`node tests\baseline-integrity.mjs` ⇒ exit **0**（14/0）；`--plant` ⇒ exit **1**（19 项 / 5 红，四类损坏各自被抓）；
  临时移走清单 ⇒ **exit 1**、`RESULT: FAIL manifest-unsealed`，随后还原（清单 sha256 `8462618C…23C07` 前后一致）且 `--check` exit 0。
- `node tools\baseline-sha256.mjs --check` ⇒ exit **0**：`基线一致：95 个受封印文件与 docs/源码基线.sha256 逐条相符`。
- `verify.cmd:56-60` 只按 `errorlevel` 汇总 ⇒ 上述 exit 1 必然使整仓关口打印 `RESULT: FAIL`；"删掉清单仍 ALL PASS"的旧通路已断。

### 9.2 F2–F5 抽检（逐条成立，未发现仍不准确处）

- **F2**：独立重数 `.t\seal-fix-verify.txt` ＝ **1948** 标记 ＝ **1920** `✓` ＋ **28** `[OK  ]`（0 条 `✗`）；按 23 个
  `=== tests\*.mjs ===` 分块求和亦为 1948，28 个 `[OK  ]` 全部出自 `probe-selfkill-guard`。`patches\dsh\README.md` 的
  1948 与之相符（注：该行现在 **:137**，非审计稿所写 :136，系修复插入行所致）。全仓主张性文本里 `1942` 仅剩 §8.7（:695）
  对缺陷本身的**引述**，无残留错误主张。
- **F3**：`@deepseek-ai/dsh-tool-bash\lib\index.js:**364**` 确为 `return approveEscalation({` 调用点，**:354** 是
  `{@link approveEscalation}` 的 JSDoc（读码原样）；全安装树 grep 恰为 **6** 个调用点（bash:364 / fs:1128 / pwsh:335 /
  tools:1194 / tools\lib\types\ptc:308 / plugin-manager\lib\types\tools:32），与 `manifest.json:42,50`、`README.md:76` 一致。
- **F4**：`src\limits.mjs:96-114` 现在只有 `0xa1b6 / isSymbolicLink()===true / isDirectory()===false` 标 `[实测]`（:102-103）；
  `workspace-write` 的 `0x41b6 / false / true` 明标"历史受限会话实测、`[未实测]` 本轮"并说明用**注入** `fsImpl` 模拟（:104-106）。
- **F5**：`patches\dsh\pristine\SOURCE.md` 与 `LICENSES\`（4 份，各 1065 B）存在；逐份 sha256 与 SOURCE.md 表一致
  （`ebb4f099…a6be`），且与 harness 四个包 `LICENSE` **逐字节相同**（`Get-FileHash` 相等）；包名/版本（4 个 `@deepseek-ai/*`、
  `0.2.0-rc.2`、`license: MIT`）与各 `package.json` 相符；4 个 pristine 副本与安装树现状哈希逐条相同（pristine ＝ before ＝ NOT-APPLIED）。

### 9.3 封印一致性（结论：不是过期封印）

- 最大受封印文件 mtime ＝ **18:56:49**（`src\limits.mjs`；次新 `tests\baseline-integrity.mjs` 18:56:30）。
- **披露复核者自身的一处扰动**：建夹具时误在**真实仓根**跑了一次 `node tools\baseline-sha256.mjs --write`（19:01:50），
  把清单 mtime 重置为 19:01:50。**内容未变**：`renderManifest` 是纯函数，且写入前后两次 `--check` 均 exit 0、期间磁盘未变
  ⇒ 字节相同（现 sha256 `8462618C…23C07`，8580 B）。代价是"清单 mtime vs 文件 mtime"的原始比较不可用，改用**区间证明**：
  18:56:49（最后一次受封印编辑）≤ 清单重生成 ≤ **19:00:37**（`.t\seal-fix-verify.txt` 的关口已含 `baseline-integrity` **14/0 PASS**；
  清单若早于最后一次编辑即为过期，该套件必红）⇒ 清单确在最后一次封印面编辑**之后**重生成，且 `--check` 现在仍 exit 0。
- `docs/**`、`README.md`、`patches/**` 均**不在**封印收录面内，故本 §9 的追加不影响封印。

### 9.4 关口重跑与回归

- `verify.cmd` ⇒ exit **0**、**23** 个套件块、`RESULT: ALL PASS`、**1948** 标记（**1920** `✓` ＋ **28** `[OK  ]`、**0** `✗`），
  耗时 **7.7 s**；逐块求和 1948、红套件 0。与 `.t\seal-fix-verify.txt` 仅 **32** 行不同，且全部是 `%TEMP%` 随机目录名 / GUID /
  耗时毫秒（结构可复现、无语义差异）。核对：`baseline-integrity` **14**、`dsh-patch-guard` **30**、`suite-wiring` **28**，
  与 `README:132/137/138` 一致。
- `tests/suite-wiring.mjs` 全绿（28/0）：`verify.cmd` 的 `for %%S in (...)` ＝ **23** 项，与 `OFFLINE_SUITES` 逐项同序同数
  （套件内 `✓ verify.cmd 列表与 OFFLINE_SUITES 脚本完全一致（id-for-id）`）。
- harness 根（`…\_npx\1e7f6d9597241db0`）：18:30 之后**零文件写入**、无任何 `*.dsh-patch-backup`。`C:\Users\Administrator\.dsh\**`
  本轮只有 DSH 自身的 `sessions`/`storages`/`attachments`/`cache`/`llm-deepseek` 运行态写入（代理运行所必需），配置/装配面零改动。
- 本会话触及的仓库文件仅三处：`docs\源码基线.sha256`（上述披露的重写，内容不变）、本 §9、以及 `.t\v8-*.txt` 证据。

### 9.5 残余（不构成新缺陷，但如实写明）

- **（本会话新发现，严重度 低）逃生口可被继承的环境变量触发，且整仓关口末行不会出声**：
  复现（`[实测]` 本会话，真实树；清单已按 `try/finally` 还原并要求 sha256 前后一致）＝
  `set WINSTAGE_ALLOW_UNSEALED=1` ＋ 移走 `docs\源码基线.sha256` ＋ `verify.cmd`
  ⇒ 套件内打印 `RESULT: SKIP manifest-unsealed-allowed checks=6 failures=0`，但 `verify.cmd` **exit 0 / 末行 `RESULT: ALL PASS`**
  （证据 `.t\v8-gate-unsealed-optedout.txt`）。成因：`tests/baseline-integrity.mjs:111-121` 的逃生口分支退出 0，
  而 `verify.cmd:56-60` 只按 `errorlevel` 汇总。触发条件必须**显式设置该变量**（正常关口不会走到），故不是回归、也不推翻
  9.1 的 fail-closed 结论（默认路径 0 逃生口时判红）；但"末行 ALL PASS"确实不再保证封印被校验过。若要更紧：
  让 `verify.cmd` 跑前 `set WINSTAGE_ALLOW_UNSEALED=`，或让 SKIP 以非 0 退出。
- 仍不可证明（与 §8.9 同口径）：`workspace-write` 下 junction 的真实 `lstat` 形态；P2/P3 应用后的**运行期**效果；
  "机制 B" 的硬断裂。
- 未做：除"同名目录覆盖 `EISDIR` 分支"外，未构造**真实 ACL 拒绝读取**的不可读样本。
