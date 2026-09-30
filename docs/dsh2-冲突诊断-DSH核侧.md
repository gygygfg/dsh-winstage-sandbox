# DSH 核侧冲突诊断（T2b / analyst-core）

- 任务：task-3（T2b-analyst，DSH 核侧根因）
- 分析对象根目录（只读）：`C:\Users\Administrator\AppData\Local\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`
- 约定：**依赖包只以随包发布的 `lib/` 与 `lib/types/**/*.d.ts` 为准，未见其 `src/`**（checkout 内不含这些包的源码）。
- 判定标记：`[实测]` = 本次真的跑了脚本/读了现成产物得到的事实；`[引用]` = 读发布产物代码/JSDoc 得到；`[未实测]` = 只有推理，需他人确认。
- 本文只写核侧事实与契约；插件内部实现根因归 T2a（`docs/dsh2-冲突诊断-插件侧.md`），涉及插件处仅引其已公开的实现面作为"消费者/生产者"证据。

---

## §0 结论摘要

**一句话**：用户三个抱怨在 DSH 核侧都有可判定的结构性原因，且**与插件围栏做得好不好无关**——核侧自身就存在"审批条目只创建不闭合、且无人报错"的设计缺口，以及"`ctx.fs.sandboxMode` 一节门控三个契约"的隐式耦合。

1. **"审批条目消不掉、还不报错"是核侧缺陷，不是插件 bug。**
   `ApprovalService.request()` 先落 `approval/asked`，再 `await` 决定，最后才落 `approval/decided`（`dsh-user-approval/lib/index.js:128-144`）。而中断/崩溃修复路径 `openTurnClosers()`（`dsh-session/lib/types/repair.js:45-144`）关闭未完成回合时只合成 `tool/result` + `step/end` + `turn/end`，**从不合成 `approval/decided`**；包自带 invariant（`dsh-user-approval/lib/invariant.js:201-221`）也**只校验"decided 必须有对应 asked"，从不校验"asked 必须被 closed"**。⇒ 任何在"asked 已落盘"与"decided 落盘"之间发生的中断（用户按停、进程重启、宿主被 kill）都会留下一条**永久不闭合、无任何报错、且能被正常重放**的审批条目。
   **已在 3081 的持久化会话日志里抓到实例**（§2.4）。

2. **"修改规则冲突严重"的核侧机制是 `ctx.fs.sandboxMode` 的隐式多职责。**
   这个 getter 名义上是"能力事实（这个后端围不围栏）"，实际上一节门控三件事：
   (a) `dsh-tool-fs` 是否广告 `sandbox_permissions`/`justification` 与是否走 `approveEscalation`（`dsh-tool-fs/lib/index.js:1084-1088, 1096-1126`）；
   (b) 核侧是否把 `SandboxExecutionPolicy`（含**官方会话身份 `sessionId`**）逐调用传给 `writeText/editText/editText`（`dsh-tool-fs/lib/index.js:581, 730`；`dsh-fs/lib/types/index.d.ts:216-237`）；
   (c) `dsh-tool-str-replace-editor` 是否安装自己的围栏（`dsh-tool-str-replace-editor/lib/index.js:56-57`）。
   插件在暂存面把它返回 `undefined`（`dsh-plugin/staging-fs.mjs:377-379`，本次 `[实测]` 复现），核侧于是把整个 FS 面当成"从不围栏的本地后端"：**升权字段消失 ⇒ FS 变更永远不再产生任何审批请求；`sandboxPolicy` 消失 ⇒ 插件丢掉唯一的权威会话身份，只能退回 ambient/共享存储**（实测该实例 `.dshstage/manifest.json` 的 `sessionId` 全是 `dsh-host`，§3.4）。

3. **核侧存在两套互不认识的"审批"语义，这是"冲突严重"的结构性来源。**
   核侧只有一套对外审批服务 `ctx.approval`（工具越权，走 `approval/request` 远程瀑布 → `dsh-client-ui-approval` 面板）；插件的暂存审阅是另一套（`.dshstage/review.json` + `/winstage approve|reject` 命令）。两者没有共享的条目 id、状态或清除路径。**实测**：核侧 `approval/asked` 卡死成孤儿后，用户正是用 `/winstage approve` / `/winstage reject`（插件命令面）去试图"消掉条目"——而那条核侧条目依旧无解（同一会话 seq 67-70，§2.4）。

4. **3081 的"原本的审批机制"并没有因为禁用 `dsh-fs-sandbox` 而消失。** 实测该实例的客户端 bundle 里仍加载 `@deepseek-ai/dsh-client-ui-approval/client.js`（`.t/dsh2/logs/16-index-3081.html`），`ctx.approval`（`dsh-base` 的 `approval` 行）与 `ctx.sandboxPolicy` 也都还在。**被削掉的只有文件系统这一侧的审批来源**（§3.1），bash/pwsh 的升权审批照常工作——实测 incident 里那条 `approval/asked` 正是 `pwsh` 发起的。

---

## §1 `ctx.fs` 契约清单与 `winstage-fs` 差异（Q1）

### 1.1 `ctx.fs` 提供者契约（权威来源：`dsh-fs/lib/types/index.d.ts`）

`ctx.fs` 的类型是抽象类 `FileSystem extends Service`，服务名恰为 `"fs"`（`dsh-fs/lib/index.js:58-61`）。接口分三类：

**(A) 必须实现（abstract，缺一个就是运行时 TypeError，不会静默降级）**

| # | 成员 | 签名要点 | 语义要点 | 证据 |
|---|---|---|---|---|
| 1 | `resolve(path, opts?)` | `=> Promise<FsTarget>` | 同一文件必须给同一 `targetKey`；相对路径按 `opts.cwd`；可能做 I/O | `index.d.ts:94-97` |
| 2 | `processPath(target)` | `=> string` | 本执行世界里子进程可打开的绝对路径；**与 `targetKey` 刻意分离**，消费者不得解析 `targetKey` | `index.d.ts:106` |
| 3 | `fileUrl(target)` | `=> string` | 规范 `file:` URI（后端负责编码） | `index.d.ts:123` |
| 4 | `contains(parent, child)` | `=> boolean` | 后端自证的包含判定，两个参数必须来自同一 provider | `index.d.ts:131` |
| 5 | `stat(target, signal?)` | `=> Promise<FsInfo \| undefined>` | 只回元数据；`undefined` = 不存在；`version` 是新鲜度 token | `index.d.ts:138`；`types.d.ts:67-74` |
| 6 | `lstat(path, opts?, signal?)` | `=> Promise<FsPathInfo \| undefined>` | **不跟随末段符号链接**，可报 `symlink` | `index.d.ts:153-155`；`types.d.ts:81-88` |
| 7 | `readText(target, signal?)` | `=> Promise<string>` | 整文件 UTF-8；二进制/非正则文件要抛 `FS_NOT_TEXT`/`FS_NOT_REGULAR_FILE` | `index.d.ts:162` |
| 8 | `streamText(target, signal?)` | `=> Promise<AsyncIterable<string>>` | 大文件分块；跨块 UTF-8 解码由后端负责 | `index.d.ts:172` |
| 9 | `readBytes(target, signal, maxBytes)` | `=> Promise<Uint8Array>` | 无解码/无二进制拒绝；超上限必须 `FS_TOO_LARGE`，**不得截断** | `index.d.ts:183` |
| 10 | `readByteRange(target, {offset,length}, signal?)` | `=> Promise<Uint8Array>` | 只传窗口，不许整文件缓冲 | `index.d.ts:197-200` |
| 11 | `listDir(target, signal?)` | `=> Promise<FsDirEntry[]>` | 稳定名序；**绝不读文件内容** | `index.d.ts:208`；`types.d.ts:93-104` |
| 12 | `writeText(target, content, expected?, signal?, sandboxPolicy?)` | `=> Promise<FsWriteOutcome>` | 原子创建/替换；`expected` 是守卫；`sandboxPolicy` 由围栏后端消费 | `index.d.ts:221`；`types.d.ts:111-134` |
| 13 | `editText(target, edit, expected?, signal?, sandboxPolicy?)` | `=> Promise<FsEditOutcome>` | 版本校验 + 字面匹配 + 重写必须在**同一临界区** | `index.d.ts:235-237`；`types.d.ts:136-156` |

**(B) 有基类默认实现（可覆盖，不覆盖就是"能力申报"）**

| 成员 | 基类默认 | 含义 | 证据 |
|---|---|---|---|
| `watch(target, changed, signal)` | `signal.throwIfAborted(); reject(FsError("Filesystem watching is not supported by this provider.", "FS_IO_ERROR"))` | 不覆盖 = 明确"不支持观察" | `dsh-fs/lib/index.js:70-73` |
| `get sandboxMode` | `undefined` | **不覆盖 = 申报"我从不围栏"** | `dsh-fs/lib/index.js:86` |
| `processPathFromHostPath(hostPath)` | `undefined` | 不覆盖 = 无法把宿主路径映射进来 | `dsh-fs/lib/index.js:95` |

**(C) 事件契约（`declare module '@deepseek-ai/cordis'`，`index.d.ts:15-53`）——注意这些事件**不是** provider 发的，而是**工具层**发的：**

| 事件 | 模式 | 谁消费 | 语义 |
|---|---|---|---|
| `fs/write-intent(target, actor, next)` | waterfall，单槽决策 | `dsh-fs-observation-policy` | 第一个返回 intent 的监听者胜出；`next()` = 无条件写 |
| `fs/edit-intent(target, actor, next)` | waterfall，单槽决策 | `dsh-fs-observation-policy` | 同上，返回 `{version}` |
| `fs/observed(target, observation, actor)` | emit，**同步记录器**（throws 会 fail 工具调用；返回的 promise **不被 await**） | `dsh-fs-observation-policy` | 记录权威 present/absent 观察 |

`actor` 的 owner 抽取是 `actor?.agent?.session`（`dsh-fs-observation-policy/lib/index.js:29-31`）——即**守卫状态按会话隔离**。

**(D) 错误契约（`dsh-fs/lib/types/types.d.ts:157-172`）**
`FsError extends HarnessError`，携带封闭枚举 `FsErrorCode`：

```
FS_NOT_FOUND | FS_NOT_DIRECTORY | FS_NOT_TEXT | FS_NOT_REGULAR_FILE | FS_TOO_LARGE
FS_PERMISSION_DENIED | FS_SANDBOX_DENIED | FS_IO_ERROR | FS_STALE_VERSION
FS_NOT_OBSERVED | FS_AMBIGUOUS_EDIT | FS_EDIT_NOT_FOUND | FS_ABORTED
```

两个关键"语义契约"（**不是**可以由后端自定义的措辞）：

- `FS_STALE_VERSION` = "目标存在但版本不匹配，或应当存在却不存在"（`dsh-fs-local/lib/index.js:869-870, 886-888`）；`dsh-tool-fs` 会把它渲染成 `"...— re-read the file, then retry"`（`dsh-tool-fs/lib/index.js:475-478`）。
- `FS_SANDBOX_DENIED` = 策略拒绝；**核侧把它当作精确字符串契约**：`dsh-tool-fs` 的 `mapError` 用 `error instanceof FsError && error.code === "FS_SANDBOX_DENIED"` 判定，再替换成共享 marker（`dsh-tool-fs/lib/index.js:1159-1163`），marker 文本由 `dsh-sandbox` 单点拥有（`dsh-sandbox/lib/index.js:64-66, 76-78`）。

### 1.2 `dsh-fs-sandbox` 那一行原本额外注册了什么

**结论：什么都没额外注册。** 它只把 `ctx.fs` 从 `LocalFileSystem` 换成 `SandboxedFileSystem`。

- 类定义只有一处：`class SandboxedFileSystem extends LocalFileSystem`（`dsh-fs-sandbox/lib/index.js:103`），`static inject = ["sandboxPolicy"]`（`:104`），`export { SandboxedFileSystem, SandboxedFileSystem as default }`（`:169`）。
- 全包只有两个 lib 文件：`lib/index.js`、`lib/types/containment.d.ts`（`containment` 只导出 `isPathUnder`，是内部机制）。
- 它覆盖的成员**只有三个**：`writeText`、`editText`、`get sandboxMode`（`:111-113, 125-127, 139-141`），其余全部继承 `LocalFileSystem`。
- 它**不**注册任何事件、**不**注册任何工具、**不**调用 `ctx.approval`、**不**提供 `sandboxPolicy`（只是 `inject` 它）。
- 围栏本身：`checkedTarget()`（`:153-166`）——`danger-full-access` 原样放行；`read-only` 直接抛 `FS_SANDBOX_DENIED`（`:157`）；`workspace-write` 重新 `resolve` 一次并要求落在 `writableRoots(policy)`（workspace 根 + `/tmp` + `os.tmpdir()`，`dsh-sandbox/lib/index.js:166-173`）之下，否则抛 `FS_SANDBOX_DENIED`（`:164`）。
- 该行被 `disabled: true` 只影响"谁是 `ctx.fs`"，**不影响审批服务、不影响 bash/pwsh 围栏、不影响 `ctx.sandboxPolicy`**（`dsh-base/cordis.patch.yml:225-261, 517-518`）。

### 1.3 `winstage-fs` 的实测接口面

`[实测]` 直接 import `dsh-plugin/staging-fs.mjs` + 真实 `SandboxedFileSystem`，检查生成类的原型：

```
exports: [ 'SandboxedFileSystem', 'createStagingFileSystem' ]
inject = ["sandboxPolicy"]          # 从 SandboxedFileSystem 继承（自身未声明）
base.inject = ["sandboxPolicy"]
Config identity = true
own sandboxMode descriptor = "own"
has writeText/editText/watch/resolve/stat/lstat/readText/streamText/readBytes/readByteRange/listDir/processPath/fileUrl/contains/processPathFromHostPath = function
```

⇒ **13 个 abstract 成员全部可用**（10 个由 `LocalFileSystem` 提供，3 个由插件自己覆盖）；`watch` 被覆盖并 `super.watch` 兜底 ⇒ 能力面不缺方法。

`[实测]` 直接调用 `sandboxMode` getter（跳过 Service 构造）：

```
staging ON  -> sandboxMode = undefined
staging OFF -> sandboxMode = "workspace-write"
```

（对应 `dsh-plugin/staging-fs.mjs:377-379`：`if (this.stagingEnabled()) return undefined; return super.sandboxMode`。）

### 1.4 `winstage-fs` 必须满足的最小契约清单（供 Lead 核对）

| ID | 契约 | 判定方式（可执行） | 现状 |
|---|---|---|---|
| C1 | 13 个 abstract 方法齐备 | 生成类原型上全是 `function` | ✅ `[实测]` |
| C2 | `resolve()` 的 `targetKey` 在同一文件上必须稳定，且 `processPath(targetKey)` 可被本执行世界打开 | 对同一路径 `resolve` 两次比较 `targetKey`；用 `processPath` 去 `stat` | ⚠️ 未做端到端断言；注意"只在暂存树存在的文件"其 `processPath` 指向真实磁盘上**不存在**的路径（`dsh-fs-local/lib/index.js:789-791`） |
| C3 | `writeText` 必须回传**真实产出的** `version`，且该 version 必须与 `stat()` 报的一致；`operation`/`before`/`after` 语义必须保持 `before===null ⇒ 新建` | 写完后 `stat` 的 `version` 必须等于 `outcome.version`；否则 `fs-observation-policy` 的下一次 `replaceIfVersion` 必假 | ⚠️ 见 C2/§3.5：投影 version 与真实磁盘 version 是**两个 token 空间** |
| C4 | `writeText`/`editText` 必须消费第 5 个参数 `sandboxPolicy`（核侧按合约会传） | 用一个假 `sandboxPolicy` 调 `writeText`，观察行为是否依赖它 | ⚠️ 核侧**只在** `sandboxMode !== undefined` 时才传（§1.5），当前暂存面永远收不到 |
| C5 | `FS_SANDBOX_DENIED` 必须是 `FsError` 实例且 `code` 精确等于该字符串 | `error instanceof FsError && error.code === "FS_SANDBOX_DENIED"` | 暂存面已删（见 `dsh-plugin/cordis.patch.yml:32-33`）；关闭开关时由 `super` 保证 ✅ |
| C6 | 若 `sandboxMode !== undefined`，则 `ctx.sandboxPolicy` 必须存在，否则 `dsh-tool-fs` **在 apply 期就 throw** | 见 `dsh-tool-fs/lib/index.js:1087` | ✅ dsh-base 有 `sandbox-policy` 行 |
| C7 | 不得注册第二个 `fs` 提供方（cordis 硬失败） | 同层同时 enable `fs-sandbox` + `winstage-fs` 会 `service "fs" already registered` | ✅ 现形态用"一个提供方两种面"规避 |
| C8 | `fs/observed` 由工具层发，provider **不得**假设自己发了它 | — | ✅ 契约本身就写明 |
| C9 | 身份一致性：`fs-observation-policy` 的 owner 是 `actor.agent.session`；provider 若需要"调用方会话身份"必须用同一来源 | 见 §3.4 | ❌ 当前因 C4 断链，退回 ambient |

### 1.5 核侧"`sandboxMode` 一节门控"的精确代码

`dsh-tool-fs/lib/index.js:1082-1088`：

```js
constructor(ctx) {
  this.ctx = ctx;
  const defaultMode = ctx.fs.sandboxMode;                       // ← 唯一门控
  this.escalationModes = defaultMode === void 0 ? [] : ESCALATION_TARGETS;
  this.policy = defaultMode === void 0 ? void 0 : ctx.get("sandboxPolicy");
  if (defaultMode !== void 0 && this.policy === void 0) throw new Error("tool-fs: the mounted filesystem confines but ctx.sandboxPolicy is missing");
}
```

`dsh-tool-fs/lib/index.js:1122-1143`（`resolvePolicy`）：

```js
const standingPolicy = this.policy?.resolve({ ...exec.agent ? { session: exec.agent.session } : {} });
if (args.sandbox_permissions === void 0 || args.justification === void 0) return standingPolicy;  // ← 返回 undefined
if (this.escalationModes.length === 0) throw new Error("sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)");
```

`dsh-tool-str-replace-editor/lib/index.js:53-58`：

```js
constructor(ctx) {
  this.policy = ctx.fs.sandboxMode === void 0 ? void 0 : ctx.get("sandboxPolicy");
  if (ctx.fs.sandboxMode !== void 0 && this.policy === void 0) throw new Error("tool-str-replace-editor: the mounted filesystem confines but ctx.sandboxPolicy is missing");
}
```

⇒ **`sandboxMode === undefined` 的三个后果，全部静默**：
1. `escalationModes = []` ⇒ 工具 schema 里不再有 `sandbox_permissions` / `justification`；模型没有升权闸门，**因此 FS 变更永远不会产生审批条目**（不是"出错"，是"没有这条路径"）。
2. `policy` 消失 ⇒ `writeText/editText` 的第 5 参永远 `undefined` ⇒ `SandboxExecutionPolicy.sessionId` 这条**官方会话身份通道**断掉（`dsh-sandbox/lib/types/index.d.ts:32-39` 明确它是"调用会话的不透明身份，后端拿它做 per-session 状态；无 agent 的调用才缺失"）。
3. `str-replace-editor` 的 `MutationPolicy` 变成空对象 ⇒ 既不围栏、也不再能产生 `FS_SANDBOX_DENIED` marker。

---

## §2 审批条目状态机与静默失败点（Q2，重点）

### 2.1 参与方与角色

| 角色 | 位置 | 职责 |
|---|---|---|
| 服务定义 | `dsh-user-approval`（`ctx.approval`） | 会话策略折叠、审计对（asked/decided）、把决定交给瀑布、把决定规约为 4 值封闭集 |
| 请求方 A | `dsh-tools` 的 `serviceAsk` | `tools/pre-execute` 返回 `{kind:"ask"}` 时调用（`dsh-tools/lib/index.js:3226, 3439-3491`） |
| 请求方 B | `dsh-sandbox` 的 `approveEscalation` | `write`/`edit`/`bash`/`pwsh` 的 `sandbox_permissions` 升权（`dsh-sandbox/lib/index.js:99-123`） |
| 传输/投影 | `dsh-api-remotes` → `dsh-api-gateway` | 把 host 的 `approval/request` 瀑布投到浏览器（`dsh-api-remotes/lib/index.js:22-25, 215-232`；`dsh-api-gateway/lib/index.js:846-943`） |
| 应答方（UI） | `dsh-client-ui-approval` | 面板 + `ctx.remote.$on("approval/request")`（`lib/client.js:284-357`） |
| 其他应答方 | `dsh-acp` | 同进程 ACP 通道（`dsh-acp/lib/index.js:1116`） |
| 崩溃修复 | `dsh-session` 的 `openTurnClosers` / `interruptedTurnClosers` | 关闭未完成回合（`dsh-session/lib/types/repair.js:45-144`） |
| 不变量 | `dsh-user-approval/invariant` | 审计流校验（`lib/invariant.js:201-275`） |

### 2.2 完整状态机

```
                  ┌─ 前置：hasOpenTurn(session) 必须为真，否则 throw（不落任何事件）
                  │      dsh-user-approval/lib/index.js:130
                  ▼
  [无条目] ──session.append("approval/asked",{id,toolName,callId?,reason?})──▶  [ASKED]
                  dsh-user-approval/lib/index.js:132-137                      │
                                                                              │ decide(req,session)
                                                                              ▼
                            ┌─────────────── signal?.aborted ──▶ "cancelled"   │ id:174
                            ├─────────────── effectivePolicy==="never" ─▶ "rejected"  id:175
                            │
                            └─ ctx.waterfall(scopeTarget(agent,agent), "approval/request", req, ()=>"unavailable")
                                     │  dsh-user-approval/lib/index.js:176
                                     │
                       ┌─────────────┴──────────────┐
                       │ 已连浏览器 + ui-approval    │ 无应答方 / 应答方 throw / 返回非法值
                       ▼                             ▼
              [面板 PendingApproval]            "unavailable"（catch 无日志，见 §2.5-①）
                       │                             │
        ┌──────────────┼──────────────────┐          │
        ▼              ▼                  ▼          │
 allowed-once     rejected         signal abort       │
        │              │            → "cancelled"     │
        └──────────────┴──────────────┴────────────────┘
                                     │
                  session.append("approval/decided",{id,outcome})   id:139-142
                                     ▼
                                 [CLOSED]
```

**谁能清除 `pendingRemoteEvents` 里的 pending（gateway 侧，`dsh-api-gateway/lib/index.js`）**：

| 清除路径 | 触发 | 代码 |
|---|---|---|
| 应答方返回 result | 用户点了"允许一次/拒绝" | `:899-906` → `settleRemoteEvent` |
| 应答方返回 rejected（应答方抛错） | UI 端 listener 抛错 | `:907` → `cancelRemoteEvent` → 瀑布 reject |
| 所有已投递客户端都答 `next()` 且 `deliveries.size===0` | 多客户端时最后一个也放弃 | `:908` |
| `signal` abort | 回合被取消/工具超时 | `:865-868` → `cancelRemoteEvent` |
| Agent Context 释放 | carrier fiber dispose | `:855-857` → `cancelRemoteEvent` |
| gateway / remote source 关闭 | 进程退出、profile reload、HMR | `:940-943` `closeRemoteEvents` |
| **客户端断线** | 页面刷新/关标签 | `:910-918` `removeRemoteEventClient` **只把 pending 从该客户端摘掉，pending 本体留在 `pendingRemoteEvents`** |

`receiveRemoteEventResult` 里 `kind:'result'` 但 `value === undefined` 会被规范化成 `{kind:'result'}`（`dsh-api-gateway/lib/types/client/remote-events.js:143-149`）→ host 收到 `undefined` → `ApprovalService.decide` 的 `OUTCOMES.includes(undefined)` 为假 → **"unavailable"**（`dsh-user-approval/lib/index.js:176`）。

### 2.3 永久不闭合（"创建了但永远不会被清除"）的全部分支

> 判定基准：`approval/asked` 已落盘，但 `approval/decided` **永远不会**再落盘。注意这是**持久化**的：它会跟着 `session.v4.jsonl.zstd` 一起被重放，且没有任何消费者会清理它。

| # | 分支 | 机制 | 证据 | 判定 |
|---|---|---|---|---|
| **P1** | **回合被中断（用户按停 / 宿主被 kill / 进程重启）后由修复路径收尾** | `approval/asked` 已 append，`await decide` 尚未返回，回合保持 open；之后 `openTurnClosers` 合成 `tool/result(TOOL_OUTCOME_UNKNOWN)`+`step/end`+`turn/end`——**不合成 `approval/decided`**。两个调用点：`dsh-agent-loop/lib/index.js:1935-1936`（resume 时 `handle.append(closers)` → **落盘**）、`dsh-session-query/lib/index.js:34-53`（冷读时只拼进内存 seed，不改存储） | `dsh-session/lib/types/repair.js:45-144`（`switch` 里无 `approval` 分支，`approval/asked` 落 `default:` 不动游标）；实测实例 §2.4 | **[实测]** |
| **P2** | **进程在两次 append 之间崩溃** | `request()` 没有事务/补偿；`asked` 与 `decided` 是两条独立 append | `dsh-user-approval/lib/index.js:132-142` | `[引用]` |
| **P3** | **`decided` 的 append 自身失败** | `await this.decide(...)` 成功后 `session.append("approval/decided")` 抛错 ⇒ 只剩 `asked` | `:139-142`；JSDoc 自述 `throws when ... either audit event fails before the session append commit point`（`types/index.d.ts:132-133`） | `[引用]` |
| **P4** | **客户端断线且无人再连** | `removeRemoteEventClient` 不 cancel pending；只要 signal 未 abort、agent context 未释放、gateway 未关，pending 与那半条审计**同时**悬停 | `dsh-api-gateway/lib/index.js:910-918`；无 TTL/无定时器（网关里没有对 pending 的扫描清理） | `[引用]` |
| **P5** | **浏览器侧没有应答方（ui-approval 未加载 / inject 不满足 / 连接的是无 `remote.$on` 的旧客户端）** | pending 被投递但无人应答；`startRemoteEvent` 也不投递（无 client）⇒ pending 静默驻留 | `dsh-client-ui-approval/lib/client.js:275-281`（`inject` 需 `sessions/remote/uiSession/slots/locale`）；`dsh-api-gateway/lib/index.js:889` | `[引用]` |
| **P6** | **应答方拿不到 session scope 就静默放行** | `answerApproval` 在 `ctx.sessions.scopeOf(owner) === undefined` 时直接 `return next()` ⇒ 没有面板、没有日志、瀑布落到默认 `"unavailable"` | `dsh-client-ui-approval/lib/client.js:285-286` | `[引用]` |
| **P7** | **代码里根本没有"清理孤儿 asked"的地方** | 全局 grep `approval/asked` 只有：事件目录（生成文件）、会话格式迁移、invariant、`request()` 本身。**没有任何投影/清理/超时消费者** | `dsh-user-approval/lib/invariant.js:201-221`；`dsh-session/lib/types/known-event-types.js:24-25`；`dsh-session-format-v0-to-v1/lib/index.js:34-35`；`dsh-api-session-controller/lib/client.js:140-141` | `[实测]**（grep 全仓包） |
| **P8** | **不变量不认为这是错误** | `validateApprovalEvent` 对 `approval/asked` 只查"在 open turn 内 / toolName 非空 / id 未重复"，**不要求回合结束时为零**；对 `turn/end` 不做 pending 检查 | `dsh-user-approval/lib/invariant.js:201-221`；`seed()` 只重放不做收尾校验（`:228-244`） | `[引用]` |
| **P9** | **重放/`resume` 把它当正常尾部** | `interruptedTurnClosers` 只按 `turn/start|turn/end|step/*|assistant/message|tool/call|tool/result` 移动游标，`approval/asked` 落到 `default:` 分支（不动游标） | `dsh-session/lib/types/repair.js:51-93` | `[引用]` |

### 2.4 实测：3081 会话日志里抓到 P1 的实例

来源：`.t\dsh2\home\sessions\--C-Users-Administrator-Desktop-WinStageSandbox-.t-dsh2-ws--\session-5bfece37-230a-4b25-9f77-dff68678173c\session.v4.jsonl.zstd`
（zstd 多帧拼接；本次用系统临时目录脚本逐帧解压后审计，脚本见 §6.2。）

事件序列（`seq` 为持久化序号）：

```
seq 58  step/start      turn=1 step=8
seq 59  session-log-deepseek/delivery-accepted  throughSeq=58
seq 60  assistant/message  （模型解释 "Cannot read properties of undefined (reading 'mode')"）
seq 61  tool/call       name=pwsh  callId=call_00_H35nYPozER2QN2sW93zW7289
                        args={ "command":"...", "description":"Diagnose workspace path existence and ACL",
                               "sandbox_permissions":"danger-full-access",
                               "justification":"工作区写入被沙箱 ACL 授权失败（Win32 5）阻断…" }
seq 62  approval/asked  id=4a60e08b-1d96-46f0-a862-540ed6a42a37
                        toolName=pwsh  callId=call_00_H35nYPozER2QN2sW93zW7289
                        reason="escalate sandbox to danger-full-access: 工作区写入被沙箱 ACL 授权失败（Win32 5）阻断…"
seq 63  tool/result     id="interrupted-tool-result-call_00_H35nYPozER2QN2sW93zW7289-63"
                        isError=true  error={name:"ToolOutcomeUnknownError", code:"TOOL_OUTCOME_UNKNOWN"}
                        time == seq62 的 time（1790591096411）  ← openTurnClosers 的 "time = last.time" 指纹
seq 64  step/end        turn=1 step=8
seq 65  turn/end        turn=1 reason={kind:"interrupted"}
seq 66  session/end-seed
seq 67  command/run     name=winstage args=' approve "inside-note.txt"'   ← 用户随后用**插件命令面**去消条目
seq 69  command/run     name=winstage args=' reject'
```

**这三条合成事件是谁写的（判定 `[实测]`+`[引用]`）**：`interrupted-tool-result-<callId>-<seq>` 这一 id 形状、`TOOL_OUTCOME_UNKNOWN` 码、以及 `time` 复用"最后一条真实事件的时间"三者合起来**只可能**来自 `openTurnClosers`（`dsh-session/lib/types/repair.js:108-142`）。而该函数只有两个调用点：`dsh-session-query` 的冷读（只拼进内存 seed，`:52`，**不写存储**）与 `dsh-agent-loop.resumeWith`（`await handle.append(closers)`，**写存储**，`:1936`）。既然这三条事件**在磁盘日志里**，写入者就是 `resumeWith`。

⇒ 事故链（不依赖"用户是否按了停"）：**审批提示出现 → 宿主在审批未决期间被重启/会话被 resume → 修复路径把回合收尾（合成一条 `ToolOutcomeUnknownError`）→ 那条 `approval/asked` 无人收尾，永久留下**。`approval/asked`(seq62) 与合成收尾(seq63-65) 时间戳相同，说明中断几乎与提问同时发生（该时段 T1-rig 正在重启 3081）。

审计结果（全量 4 个会话文件）：

| 会话文件 | 事件数 | `approval/asked` | `approval/decided` | 孤儿 id | 末尾未闭合回合 | 结构化工具错误码 |
|---|---|---|---|---|---|---|
| session-26c3e002-… | 62 | 0 | 0 | — | 无 | — |
| **session-5bfece37-…** | **72** | **1** | **0** | **4a60e08b-1d96-46f0-a862-540ed6a42a37** | **无** | `SEARCH_FAILED`, `TOOL_OUTCOME_UNKNOWN` |
| session-c2d28127-… | 5 | 0 | 0 | — | 无 | — |
| session-f9c38780-… | 28 | 0 | 0 | — | 无 | — |

⇒ **一条 `approval/asked` 永久留在持久化日志里；回合已正常闭合；不变量与重放都不报错。**这正是"消不掉、还不报错"。[实测]

附带实测（同一日志）：`write` 工具两次失败，返回的是**裸 TypeError**：

```
seq 20 / seq 56  tool/result  isError=true
                 content.text = "Error: Cannot read properties of undefined (reading 'mode')"
                 error 字段 = 缺失（无 name / 无 code）
```

原因链（核侧，判定 `[引用]`）：`dsh-tools` 只对 `HarnessError` 提取 `{name, code}`（`dsh-tools/lib/index.js:2611-2621`），`toolErrorResult` 于是只带 `message`（`:3616-3630`）；`dsh-tool-fs` 的 `remediateFsError` 也只识别 `FS_NOT_OBSERVED`/`FS_STALE_VERSION`（`dsh-tool-fs/lib/index.js:475-478`）。⇒ 非 `FsError` 的 provider 内部故障在核侧表现成"只有一句 message、没有码、没有分类"，上层（重试策略、UI、观测）无法路由。这解释了"出错但不报（结构化的）错"。

### 2.5 把错误吞掉（catch 无上抛 / 无日志 / 无用户可见）的全部分支

| # | 位置 | 代码 | 吞掉了什么 | 用户可见性 |
|---|---|---|---|---|
| ① | `dsh-user-approval/lib/index.js:176` | `.then((outcome) => OUTCOMES.includes(outcome) ? outcome : "unavailable", () => "unavailable")` | **瀑布的任何 reject**（含应答方抛错、传输中断、Context 释放）→ 静默变 `"unavailable"` | 只表现为模型收到 "no approval channel is available"；**界面无任何提示**，无日志。`[引用]` |
| ② | 同上 `:176` | `OUTCOMES.includes(outcome) ? outcome : "unavailable"` | 应答方返回非法值（含 `undefined`）→ 静默 `"unavailable"` | 同上。`[引用]` |
| ③ | `dsh-api-gateway/lib/index.js:861-864` | `catch { source.resolve({ kind: "next" }); return; }` | `context.value.effect()` 失败 → 静默下一位 → `"unavailable"` | 无。`[引用]` |
| ④ | `dsh-api-remotes/lib/index.js:230` | `if (!queue.push(dispatch)) Promise.resolve().then(next)...` | 队列已关闭 → 静默下一位 | 无。`[引用]` |
| ⑤ | `dsh-client-ui-approval/lib/client.js:64-68` | `pending.answer(outcome).catch(() => { if (!active.current \|\| !pending.answerable) return; waiting.current=false; setAnswered(false); })` | 应答失败被吞，UI 只是悄悄恢复可点 | 面板无错误提示（重挂后才可见）。`[引用]` |
| ⑥ | `dsh-client-ui-approval/lib/client.js:285-286` | `if (sessionId === void 0) return next();` | 无法定位会话 → 不显示面板、不报错 | 无。`[引用]` |
| ⑦ | `dsh-client-ui-approval/lib/client.js:142-149` | `settlePendingComposer` 把同步 throw 变成 rejected promise，交给⑤吞 | 重复 settle（`finish()` 抛 "already settled"）被静默 | 无。`[引用]` |
| ⑧ | `dsh-api-gateway/lib/types/client/remote-events.js:176-178` | `reportError` 只 `console.error` | 应答方 `adapter.resolve` 抛错只进浏览器 console | 仅 devtools。`[引用]` |
| ⑨ | `dsh-tools/lib/index.js:3267-3272` | `catch (error) { return next({kind:"final-result", result: toolErrorResult(error)}); }` | 把 `approval.request()` 的 throw（如 §2.2 的 `hasOpenTurn` 前置）转成工具错误结果 | 模型可见（"Error: approval.request() outside an open turn…"），**用户界面不可见**。`[引用]` |
| ⑩ | `dsh-tools/lib/index.js:3409-3427` | `notifyResult` 里 observer 失败只 `logger.warn` | `tools/result` 观察者异常 | 仅日志。`[引用]` |
| ⑪ | `dsh-client-ui-approval/lib/client.js:192-201, 240-245` | `request.signal === undefined` 时**没有** abort 兜底；`abort()` 只 reject 自己的 promise | signal 缺失的请求只能靠外部清除 | 无。`[引用]` |

**特别注意 ①+⑪ 的组合**：`ApprovalService.decide` 的 signal 竞速只在 `req.signal !== undefined` 时生效（`:177-188`）；而 `dsh-tool-fs` 的 `writeText/editText` **没有声明 `timeoutMs`**（`[实测]`：`grep timeoutMs dsh-tool-fs/lib/index.js` 无命中），所以 `dsh-tool-call-timeout-policy` 不会为它们装 deadline（该插件只对声明了 `timeoutMs` 的工具生效，`dsh-tool-call-timeout-policy/lib/index.js:116-131`）。⇒ FS 变更走的审批**没有超时兜底**，只能靠回合取消/进程退出清除。

### 2.6 UI 侧还有一条"条目存在但看不见"的分支

`dsh-client-ui-approval` 用 `ctx.uiSession.registerPendingInteraction(() => 0)` 注册，**优先级 0**（`lib/client.js:343`）；`pendingInteraction` 每会话只发布**优先级最高的一条**（`dsh-client-ui-session/lib/client.js:299-313`，`precedence >= previous.precedence` 时后者胜）。`dsh-client-ui-user-questions` 注册的是 plan-review=2 / 其他=1（`dsh-client-ui-user-questions/lib/client.js:877`）。

⇒ 同一会话里只要有一个 `ask_user_question`（或 plan-review）待答，**审批面板根本不会被渲染**（composer 的 `select` 拿不到它），而 host 侧的 pending 与 `asked` 都在。如果那个更高优先级的交互也卡住/消失，审批条目就既不可见也不可清除。`[引用]`

---

## §3 禁用 `dsh-fs-sandbox` 的消费者影响（Q3）

### 3.1 先确定一件事：核侧没有"因为 fs-sandbox 缺失而报错"的直接消费者

`dsh-fs-sandbox` 只提供 `ctx.fs`（§1.2）。所以"禁用"本身不会让谁拿不到服务——`winstage-fs` 补上了 `fs`。真正的退化全部来自 **`sandboxMode` 返回 `undefined`**（§1.5）。

### 3.2 直接读 `ctx.fs.sandboxMode` 的消费者（全部；这是"静默退化"的名单）

| 消费者 | 读了之后做什么 | `undefined` 时的行为 | 判定 |
|---|---|---|---|
| `dsh-tool-fs`（`write`/`edit`） | ① 是否广告 `sandbox_permissions`+`justification`；② 是否解析并传 `sandboxPolicy`；③ 是否把 `FS_SANDBOX_DENIED` 映射成 `[sandbox: …]`+升权提示 | 三者全灭：**FS 变更不再有任何审批入口**；`sandboxPolicy` 第 5 参恒为 `undefined`；`mapError` 永不命中（因为不会再有 `FS_SANDBOX_DENIED`） | `[实测]`（getter 返回值）+`[引用]`（`dsh-tool-fs/lib/index.js:1084-1088, 1096-1108, 1122-1144, 1159-1163`） |
| `dsh-tool-str-replace-editor` | 是否安装 `MutationPolicy`（拿 `ctx.sandboxPolicy` 并逐调用 resolve） | `policy = undefined` ⇒ `create`/`str_replace` 全部**无策略标记**；同时**不 throw**（只有 `sandboxMode !== undefined` 且 policy 缺失才 throw） | `[引用]`（`lib/index.js:53-67`） |
| 其他包 | `grep -n "\.sandboxMode"` 的其余命中都是 `ctx.shell.sandboxMode`（bash/pwsh 侧）或 `dsh-permission-presets` 的 derive | **不读 `ctx.fs.sandboxMode`** | `[实测]`（全包 grep） |

一条极易被误判的点：**`dsh-permission-presets` 读的是 `ctx.shell.sandboxMode`**（`dsh-permission-presets/lib/index.js:177, 296, 356, 387`），与 `ctx.fs` 无关；因此禁用 `fs-sandbox` **不会**动权限预设（`workspace-write`/`danger-full-access` 的档位切换仍走 bash/pwsh 侧）。但反过来说：**权限预设所声称的档位，对 `ctx.fs` 面并不成立**——切到 `read-only` 后，FS 写入既不会被围栏（因为 provider 暂存/透明），也不会产生审批，模型却从系统提示里读到 "Current DSH file policy: read-only"（`dsh-sandbox-policy/lib/index.js:72-83`）。这是"修改规则冲突"最直接的用户可见形态。

### 3.3 `ctx.fs` 的其他消费者（不读 `sandboxMode`，但会被暂存投影影响）

| 消费者 | 用法 | 暂存面下的后果 | 判定 |
|---|---|---|---|
| `dsh-tool-fs-search`（`glob`/`grep`） | **不走 `ctx.fs`**：直接 spawn 打包的 ripgrep，workdir = `exec.agent.session.header.cwd`（`lib/index.js:1212-1216` 的 inject 无 `fs`；`:168` workdir） | 只看**真实磁盘**：只存在于暂存树的文件对 `glob`/`grep` 完全不可见；真实 cwd 不存在时直接 `SEARCH_FAILED`。**实测**该 incident 会话的 `glob` 就是 `SEARCH_FAILED` | `[实测]`+`[引用]` |
| `dsh-api-workspace-files` | 内容走 `ctx.fs`（`readBytes`/`readByteRange`/`listDir`/`watch`/`lstat`），但 `absolutePath` 走 `ctx.fs.processPath(target)`（`:92, 530, 611`），`path` 走 `fileUrl`（`:509`） | 侧栏/变更视图的"绝对路径"指向真实磁盘上**可能不存在**的文件；"用编辑器打开/预览图片"会 404 | `[引用]` |
| `dsh-workspace-changes` | 用 `session/event`+`tools/pre-execute` 在**真实磁盘**上做变更前捕获（`capture()` → `captureFile(canonicalPath(resolve(cwd,path)))`，`lib/types/recorder.js:76-92`；入口 `lib/index.js:1095-1103`），回合末再与真实磁盘比对（`recorder.js:107-122`），并用 **git** 做整体快照（`lib/index.js:1044-1060`） | 暂存里的改动**不会**出现在 turn 变更摘要/`workspace/changes` 里（磁盘没变）；反过来，若暂存条目后来被批准落盘，也不会归因到原回合 | `[引用]` |
| `dsh-client-ui-deliverables` | `fs.processPathFromHostPath(path)` 做"宿主路径可验证"校验（`lib/index.js:130-131`） | 交付物若只在暂存树，校验对着真实磁盘 ⇒ 422 或打开失败 | `[引用]` |
| `dsh-office-to-pdf` | 内容走 `workspaceFiles`+`ctx.fs`（`files.stat`/`files.readBytes`、`fs.resolve(fs.processPath(target))` → `fs.readBytes`，`lib/index.js:524-569`），因此**读到的是暂存投影内容（正确）**；但 `source.absolutePath = fs.processPath(target)` 被写进 source key 与返回值（`:544, 574`） | 对外暴露的 `absolutePath` 指向真实磁盘，可能**尚不存在或尚未更新**；下游若按该路径取文件（打开/预览/再交付）会读到旧内容或失败。内容本身不受影响 | `[引用]` |
| `dsh-llm` / `dsh-llm-pi-ai` / `dsh-spill-policy` / `dsh-repeat-tool-reminder` / `dsh-tmux-context` | `processPathFromHostPath` 做图片附件 access 映射 | 暂存的新图片文件映射到真实路径 ⇒ 附件解析失败/降级 | `[引用]` |
| `dsh-skill-filesystem` / `dsh-headless` | `processPath(target)` 取工作目录 | 结果与真实磁盘一致（目录一般真实存在） | `[引用]` |

### 3.4 会话身份断链：`sandboxPolicy.sessionId` 是核侧唯一的权威通道

`SandboxExecutionPolicy.sessionId` 的契约（`dsh-sandbox/lib/types/index.d.ts:32-39`）：

> Opaque identity of the calling session (the branded `dsh-session` SessionId). Backends key per-session state off it (e.g. windows-acl gives each live session/workspace pair a random private temp directory and SID…); **absent for agentless calls**, which fall back to per-call backend state.

核侧谁产生它：`dsh-sandbox-policy` 的 `resolve({session})`（`lib/index.js:141-148`：`...session === void 0 ? {} : { sessionId: session.id }`）；谁传递它：`dsh-tool-fs` 的 `resolvePolicy`（`lib/index.js:1124`）——**只有 `sandboxMode !== undefined` 才发生**（§1.5）。

⇒ 暂存面把 `sandboxMode` 报成 `undefined`，等于**主动放弃这条通道**，插件只能退回 ambient（`ctx.agents.currentInitiator()`）或共享存储。

`[实测]` 该实例的暂存存储身份确实是"无会话"：

```
.t\dsh2\ws\.dshstage\manifest.json   → sessionId: "dsh-host"   entries: stage-probe.txt, stage-probe2.txt (origin: dsh-tool)
.t\dsh2\ws\.dshstage\review.json     → sessionId: "dsh-host"
.t\dsh2\ws-dsh3\.dshstage\review.json→ sessionId: "dsh-host"
扫描 .t\dsh2 下所有 *.dshstage/manifest.json → 除自测夹具（s3b-assert*、'selfcheck'/'swaptest'）外全部 sessionId=dsh-host
扫描 .t\dsh2 下是否存在 .dshstage/sessions/** → 不存在
```

插件自己在代码里把这条后果写得很清楚（引用 T2a 已公开的实现，仅作为"消费者受伤"的证据）：`dsh-plugin/staging-fs.mjs:268-276` 的注释——"静默分流正是'面板里条目随 Turn 消失'的根因"；`:487, 534` 把 `sessionIdOf(sandboxPolicy)` 作为暂存分区键。

`[未实测]` ambient `ctx.agents.currentInitiator()` 在 3081 上为何也没能提供会话身份（是没拿到，还是拿到了但被共享服务缓存 `SERVICES` 按 root 键复用），需要 T2a 定论；但**核侧能提供而没提供的那一半（`sandboxPolicy.sessionId`）已在本文定论**。

### 3.5 版本 token 双空间：`FsVersion` 的语义冲突

核侧把 `FsVersion` 定义为"provider 自证的不透明新鲜度 token"，但**同一 token 槽位被两套守卫消费**：

- `dsh-fs-observation-policy` 用它做 `replaceIfVersion` / `{version}`（`lib/index.js:51-70`），owner = `actor.agent.session`；
- provider 自己也用它做 CAS（`dsh-fs-local/lib/index.js:868-871, 886-888`）；
- 工具层把 `outcome.version` 当作"真实产出"回写观察（`dsh-tool-fs/lib/index.js:590-593, 743-746`）。

暂存面的版本空间（`winstage:file:<hash>` / `winstage:dir:<key>` / 透传的真实 stat 版本，见 `dsh-plugin/staging-fs.mjs:639-703`）与真实磁盘版本**不是同一个空间**。只要出现"条目只存在于暂存树"或"真实文件被暂存投影遮蔽"的组合，`fs-observation-policy` 记下的 version 与 provider 下一次比较的 version 就可能来自不同空间，产生两类静默错误：

- 假 `FS_STALE_VERSION`：内容没变却被判 stale（模型被要求"重读再试"，永远重试不成功）；
- 假绿：真实磁盘已被第三方改动，但暂存条目仍按"净变化"投影，写入按暂存基线落盘 ⇒ **静默覆盖**。

`[未实测]`：本次没有构造双空间竞态用例，属推断；但两条断言都可写成可执行测试（§5 的 C3/C10）。

---

## §4 判别式：三种情况怎么区分（Q4）

三种情况的**共同现象**都是"用户看不到可点的审批条目/模型被拒绝"。可用下列三组观察点**互斥**地区分。

### 4.1 观察面清单（按可得性排序）

**(a) 会话日志 `session.v4.jsonl.zstd`**（最权威；用 §6.2 的脚本读）
- `approval/asked` / `approval/decided` 的**配对**与 `id`；
- `tool/result.data.error.code`（结构化码）；
- `turn/end.reason.kind`（`interrupted` 是 P1 的指纹）；
- `permission/preset` / `sandbox/mode` / `approval/policy` 三个折叠事件（确认策略面）。

**(b) 工具结果 `error.info.code`**（模型可见，UI 也可见）
- 只对 `HarnessError` 存在（`dsh-tools/lib/index.js:2611-2621`）。**没有 code** 本身就是一条结论（见 §4.2 第 4 行）。

**(c) 浏览器 Network / WS**
- `approval/request` 的 `type:"waterfall"` 帧是否真的下发到该 client（`dsh-api-gateway/lib/index.js:873-879` 的 frame 形状）；
- 客户端是否回了 `{kind:'result',value:'allowed-once'|'rejected'|'next'}`。

**(d) 进程侧**
- `pendingRemoteEvents` 是否仍有该 pending（只有 debug/注入能看；网关不导出它）；
- `.dshstage/manifest.json` / `review.json` 的 `sessionId` 是否 `dsh-host`；
- 真实磁盘上目标文件是否存在/内容是否变。

### 4.2 判别表

| 情况 | 会话日志 | 工具结果 | 浏览器 | 结论 |
|---|---|---|---|---|
| **A. 审批机制本身没跑** | **完全没有 `approval/asked`** | 若由升权失败产生：错误文本含 `no approval channel is available`（`dsh-sandbox/lib/index.js:120`）/ 或无审批相关码；若是 FS 面：**根本不会有升权请求**（模型没这个参数） | WS 上没有 `approval/request` 帧 | 不是"条目卡住"，而是**没有任何条目**。核侧原因：`effectivePolicy==="never"`（静默 `rejected`，`:175`）／无应答方（`:176` 落 `unavailable`）／`sandboxMode===undefined` 导致模型没有升权参数 |
| **B. 条目创建了但 resolve 失败被吞** | 有 `approval/asked`，**无 `approval/decided`**，且日志里**有** `turn/end`（常见 `reason.kind==="interrupted"`） | 若回合被中断：该 callId 的结果是 `TOOL_OUTCOME_UNKNOWN`（`dsh-session/lib/index.js:823-829`）；若回合还在跑：**该工具调用没有 `tool/result`**（永远挂起） | 面板可能出现过又消失；刷新后重连会**重新下发**该 pending（`dsh-api-gateway/lib/index.js:814`），所以"刷新一下又出现"是 B 的强指纹 | **P1/P2/P4 类孤儿**。核侧不会报错、不会清理（§2.3）。若"刷新即恢复" ⇒ B；若"刷新后仍无面板" ⇒ 看 D 行 |
| **C. resolve 成功但持久化没生效** | `approval/asked` **与** `approval/decided` **成对**，`outcome` 为 `allowed-once`；同回合的 `tool/result` 有结果（可能 isError） | 成对存在 ⇒ 审批链路是通的，问题在效果面 | — | 审批已闭合。此时"修改没生效"要去看：真实磁盘 vs `.dshstage/staged/**`（`ctx.fs` 面被暂存吸收）；或 `FS_STALE_VERSION`（守卫拒绝） |
| **D. 条目看不见但不是没创建** | 有 `asked` 无 `decided`（同 B） | 无 `tool/result` | WS **收到过** `approval/request` 帧，但 DOM 里没有面板 | **§2.6 的优先级遮蔽**（同会话有 `ask_user_question`/plan-review）或 `ui-approval` 未加载 |
| **E. 出错但"没报错"** | `tool/result.data.error` **不存在**，只有 `message` | `error.info` 缺失（非 `HarnessError`） | 无 | provider 内部故障（如裸 `TypeError`）。核侧无法分类 ⇒ 重试/UI/观测都拿不到信号。实测例：`Cannot read properties of undefined (reading 'mode')` |

### 4.3 一条可复制的判定命令（审计日志配对）

§6.2 的脚本会输出每个会话的 `asked` / `decided` / `unmatchedAsked` / `openTurnAtEnd` / 结构化工具错误码。判读规则：

```
unmatchedAsked.length > 0            ⇒ 情况 B/D（孤儿条目存在）
unmatchedAsked.length === 0 && asked === 0 且模型报 "no approval channel"  ⇒ 情况 A
asked>0 && decided>0 && outcome==allowed-once && 磁盘无变化  ⇒ 情况 C（效果面问题）
tool/result 无 error 字段且 message 是 TypeError 文风  ⇒ 情况 E
```

---

## §5 对插件侧修复的硬约束（T3-fixer 照此做）

> 形式：每条都是**可判定**的（有明确的通过/失败判据）。`必须` = 不满足就会破坏核侧契约；`禁止` = 已知错误做法。

### 5.1 关于 `ctx.fs` 提供者面

- **M1（必须）** `winstage-fs` 的 13 个 abstract 成员必须全部可调用，且 **Overlay 关闭时必须逐字退回 `super.*`**。
  判据：`stagingEnabled()===false` 时，对同一输入 `writeText/editText/stat/lstat/watch/readText/streamText/readBytes/readByteRange/listDir/resolve` 的返回必须与直接挂 `SandboxedFileSystem` 逐字段相等（含抛出的 `FsError.code`）。[现形态设计上满足，需断言]
- **M2（必须）** `writeText`/`editText` 必须接受并**正确使用**第 5 个参数 `sandboxPolicy`，尤其是 `sessionId`（会话分区键）与 `workspaceRoot`（边界根）。
  判据：用一个 `{mode, workspaceRoot, sessionId:"S1"}` 调 `writeText`，产出的暂存条目必须落在 `S1` 的分区；`sessionId` 缺失时必须走**显式**的 fallback 分支并留下可观测日志（不得静默）。
- **M3（必须）** `sandboxMode` 的返回值必须与"真实围栏能力"一致，二者只能选一种组合：
  - **(方案 α) 申报"围栏"**：`get sandboxMode()` 返回真实档位（如 `"workspace-write"`），并且 `writeText/editText` **真的**按 `sandboxPolicy.mode` 围栏，拒绝时抛 `FsError(msg, "FS_SANDBOX_DENIED")`。→ 此时核侧会恢复升权字段与 `sandboxPolicy` 传递（解决 M2 与"FS 变更无审批"）。
  - **(方案 β) 申报"不围栏"**：保持返回 `undefined`，但**必须同时**放弃任何对 `sandboxPolicy` 的依赖（改用 ambient 身份，或改由插件自己的命令/面板面承载审批），并**明确接受**：FS 变更不会产生 `ctx.approval` 条目、核侧权限预设的 `read-only` 对该面无效。
  - **禁止**"申报围栏但不围栏"（核侧会广告升权、用户批准后 provider 忽略 → **审批被消费但权限没变**，比没有审批更糟），也**禁止**"申报不围栏但继续读 `sandboxPolicy`"（当前形态：身份靠 `undefined` 的第 5 参兜底，静默）。
- **M4（必须）** `version` 单一性：`stat()`/`writeText()`/`editText()` 报告给核侧的 `version` 必须是**同一个 token 空间**且在"真实内容变化"与"暂存投影变化"下都可判定为变了。
  判据：同一文件 `stat().version === writeText(...).version`；连续两次读写同一内容，第二次用第一次的 version 做 `replaceIfVersion` 必须成功；第三方改动真实磁盘后，暂存面的判断必须能区分"外部已变"而不是静默覆盖。
- **M5（必须）** `writeText` 返回的 `operation`/`before`/`after` 必须遵守 `FsWriteOutcome` 语义（`before===null` ⇔ 新建；`after` 为 LF 归一化存储文本）。`[引用] dsh-fs/lib/types/types.d.ts:117-134`
- **M6（必须）** 出错必须抛 `FsError`（或至少 `HarnessError` 子类）且带正确 `code`；**禁止**让裸 `TypeError`/`ReferenceError` 逃逸。
  判据：`error instanceof FsError` 为真、`code` 在枚举内；实测反例：两次 `write` 返回 `Cannot read properties of undefined (reading 'mode')` 且 `tool/result.data.error` 缺失。
- **M7（必须）** 不得注册第二个 `fs` 服务名；关闭开关**不得**走"disable 一行 + enable 另一行"的热切换（同层并发 `create()` 会撞 `service "fs" has already been registered`）。
  判据：一个进程内任何时刻只有一个 `fs` 提供方；开关切换过程中不出现服务注册冲突（现形态"一个提供方两种面"正确）。
- **M8（必须）** `fs/write-intent` / `fs/edit-intent` / `fs/observed` 的语义必须保持：intent 由核侧插件产生、由 provider 执行；provider **不得**自己 emit `fs/observed` 或替消费者缓存观察状态。
  判据：禁用 `dsh-fs-observation-policy` 后，未观察文件上的 `edit` 必须仍然被拒（`FS_NOT_OBSERVED`），即该策略仍由核侧事件驱动。

### 5.2 关于审批面

- **A1（必须）** **不得**用插件的暂存审阅面去"代替"或"遮蔽"`ctx.approval`；两者必须能被用户区分（不同入口、不同文案、不同条目 id）。
  判据：UI 上"DSH 工具越权审批"与"暂存条目审批"不会渲染成同一个可点条目；一条核侧 `approval/asked` 的存在与一条暂存 candidate 的存在互相独立。
- **A2（必须）** 当插件的一侧（暂存面板/命令）选择"不参与"某次审批时，必须让核侧那条请求能被**正常闭合**（approve→`allowed-once` / 拒绝→`rejected`），**禁止**留下未应答的 host 瀑布。
  判据：任何被插件"看到"的 `approval/request` 都必须以 `allowed-once`/`rejected` 之一结束；**不得**返回 `undefined` 或永久 pending（返回 `undefined` 会被核侧规范化成 `unavailable`，静默）。
- **A3（必须）** 若插件要参与 `approval/request`，必须实现 `next()` 链语义：只在"确实要接管"时返回决定，否则**必须** `next()`（`dsh-client-ui-approval/lib/client.js:299-305` 的 delegation 模式是正例）。
- **A4（必须）** 借用核侧审批面时，**必须**保持核侧的审计对闭合语义（§2.3）：不能"问了不答"，也不能在 `approval/asked` 之后自行落一条假的 `approval/decided`（配不上 id 会被 invariant 直接 fail：`dsh-user-approval/lib/invariant.js:213`）。
- **A5（必须）** 若要减少"孤儿条目"，插件侧能做的是**缩短 pending 窗口**，而不是改核侧日志：给所有会触发审批的工具声明 `timeoutMs`（这样 `dsh-tool-call-timeout-policy` 会给 `exec.signal` 装 deadline，`decide` 的 signal 竞速会把它收敛成 `cancelled`，审计对得以闭合）。
  判据：触发审批后让回合超时，日志里必须出现成对的 `asked`+`decided(outcome=cancelled)`；`pendingRemoteEvents` 不再持有该 id。
  > 注：这是**核侧可用的唯一收敛手段**；孤儿条目的彻底修复在核侧（需要 `openTurnClosers` 或 invariant 补一条"回合结束时闭合未决 asked"的规则），不在插件写范围内。
- **A6（禁止）** 禁止把暂存条目做成"需要用户点 DSH 审批面板才能消掉"的形态（两套面板优先级不同：审批=0、user-questions=1/2，见 §2.6，会导致条目被遮蔽而不可见）。
- **A7（必须）** 任何"消不掉但要用户知道"的状态必须有**用户可见**的出口（面板/命令/日志三选一且可复现），不得只依赖 `console.error` 或 `logger.info`。

### 5.3 关于"不要静默降级"的通用约束

- **S1（必须）** 任何"我拿不到 `sandboxPolicy`/会话身份 ⇒ 退回共享存储/不做围栏"的分支，必须在用户可见面留下一次性提示（插件已在 `staging-fs.mjs:270-276` 做了一次 `log()`，但只是 `logger.info`：`[未实测]` 该实例日志里未观察到这条），且必须能被 §4.2 的判别式观察到。
- **S2（必须）** 开关关闭时，`ctx.fs` 面必须与"没装插件"**不可区分**：`sandboxMode`、`FS_SANDBOX_DENIED`、`[sandbox: …]` marker、升权提示四件事必须与核侧默认逐字一致。判据见 M1 + C5。
- **S3（禁止）** 禁止在 `get sandboxMode()` 里做"按调用/按会话变化"的判断（核侧在 `apply` 期读一次并缓存：`dsh-tool-fs/lib/index.js:1084`）。`sandboxMode` 必须是**部署级常量事实**；会话级差异只能通过 `sandboxPolicy` 逐调用表达。
  > 这是当前形态的一个真实风险：`stagingEnabled()` 是"每次调用现读"（`staging-fs.mjs:356-368`），但 `sandboxMode` 只在插件 apply 时被核侧读一次给 `dsh-tool-fs` 缓存 ⇒ **运行中开关翻转后，核侧对"是否围栏"的认知不会跟着变**，而 provider 的行为会变。这本身就是"修改规则冲突"的一个具体机制。[引用]

---

## §6 证据、复现与未实测清单

### 6.1 主要证据来源

- 核包（只读）：`%NPM_CACHE%\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\{dsh-fs, dsh-fs-local, dsh-fs-sandbox, dsh-fs-observation-policy, dsh-sandbox, dsh-sandbox-policy, dsh-tools, dsh-tool-fs, dsh-tool-str-replace-editor, dsh-tool-fs-search, dsh-user-approval, dsh-client-ui-approval, dsh-client-ui-session, dsh-client-ui-user-questions, dsh-api-remotes, dsh-api-gateway, dsh-session, dsh-agent-loop, dsh-permission-presets, dsh-workspace-changes, dsh-api-workspace-files, dsh-base, dsh-web-app, dsh-experimental-auto-review}`
- 现成产物（只读）：`.t\dsh2\logs\16-index-3081.html`（证明 3081 客户端 bundle 含 `dsh-client-ui-approval`）、`.t\dsh2\logs\19-half-verification.txt`、`.t\dsh2\ws\.dshstage\{manifest,review}.json`、`.t\dsh2\home\sessions\**\session.v4.jsonl.zstd`
- 插件面（只读，仅作消费者证据）：`dsh-plugin\{cordis.patch.yml, fs-entry.mjs, staging-fs.mjs}`、`.t\dsh2\home\profiles\dsh2\{cordis.patch.yml, package.json}`

### 6.2 复现脚本（放在系统临时目录，只读运行；不写入仓库）

**(1) 接口面探针**（`[实测]` §1.3 / §1.4 的来源）

```js
const root = "C:/Users/Administrator/AppData/Local/npm-cache/_npx/1e7f6d9597241db0/node_modules"
const mod = await import("file:///C:/Users/Administrator/Desktop/WinStageSandbox/dsh-plugin/staging-fs.mjs")
const sbx = await import("file:///" + root + "/@deepseek-ai/dsh-fs-sandbox/lib/index.js")
const C = mod.createStagingFileSystem({ base: sbx.SandboxedFileSystem })
console.log("inject =", JSON.stringify(C.inject))
const g = Object.getOwnPropertyDescriptor(C.prototype, "sandboxMode").get
console.log("staging ON  sandboxMode =", JSON.stringify(g.call({ stagingEnabled: () => true,  defaultMode: "workspace-write" })))
console.log("staging OFF sandboxMode =", JSON.stringify(g.call({ stagingEnabled: () => false, defaultMode: "workspace-write" })))
```

**(2) 会话日志审计**（`[实测]` §2.4 的来源；注意 `session.v4.jsonl.zstd` 是**多帧拼接**，`zstdDecompressSync` 只解第一帧，必须按 magic `28 b5 2f fd` 切帧）

```js
import { readdirSync, readFileSync } from "node:fs"; import { join } from "node:path"; import { zstdDecompressSync } from "node:zlib"
const MAGIC = Buffer.from([0x28,0xb5,0x2f,0xfd])
function decode(f){const b=readFileSync(f),ix=[];let i=0;while((i=b.indexOf(MAGIC,i))!==-1){ix.push(i);i+=4}
  let t="";for(let k=0;k<ix.length;k++){try{t+=zstdDecompressSync(b.subarray(ix[k],k+1<ix.length?ix[k+1]:b.length)).toString("utf8")}catch{}}return t}
function walk(d,a=[]){for(const e of readdirSync(d,{withFileTypes:true})){const p=join(d,e.name);e.isDirectory()?walk(p,a):e.name.endsWith(".jsonl.zstd")&&a.push(p)}return a}
for(const f of walk(process.argv[2])){
  const pending=new Set(),errs=[],c={}
  for(const line of decode(f).split("\n").filter(Boolean)){let ev;try{ev=JSON.parse(line)}catch{continue}
    const t=ev.type,d=ev.data??{};c[t]=(c[t]??0)+1
    if(t==="approval/asked")pending.add(d.id)
    else if(t==="approval/decided")pending.delete(d.id)
    else if(t==="tool/result"&&d.error)errs.push(d.error.code??"(no code)")}
  console.log(f, "asked="+(c["approval/asked"]??0), "decided="+(c["approval/decided"]??0), "unmatched="+JSON.stringify([...pending]), "codes="+JSON.stringify(errs))
}
```

### 6.3 未实测（需 T2a / T1 / Lead 确认或补测）

| # | 项 | 为什么没测 | 建议由谁确认 |
|---|---|---|---|
| U1 | ambient `ctx.agents.currentInitiator()` 在 3081 上为何没能提供会话身份（导致 `dsh-host` 共享存储） | 属插件内部逻辑；我只读到 `sessionIdOf` 的优先级与回退 | T2a |
| U2 | `winstage-fs` 关闭开关时与 `SandboxedFileSystem` 的**逐字段等价性**（M1 判据） | 属 T3-fixer 的验收测试 | T3-fixer |
| U3 | `version` 双空间竞态（假 `FS_STALE_VERSION` / 静默覆盖，§3.5） | 未构造竞态用例 | T3-fixer（§5 M4 判据） |
| U4 | 审批孤儿能否被"用户按停"**以外的**中断路径产生（如 HMR/profile reload 期间的 gateway 关闭） | 未做故障注入 | T1-rig 可加一个注入用例 |
| U5 | 3080 实例（`DSH_HOME=C:\Users\Administrator\.dsh`）的 bundle 差异对"原本的审批机制"的影响细节 | 任务书要求不碰该目录；我只用 `dsh-base`/`dsh-web-app`/`dsh-experimental-auto-review` 发布产物推断 | Lead（如需可只读比对） |
| U6 | `dsh-acp` 作为另一应答方在 3081 是否挂载 | 未在 3081 客户端/服务清单里见到 ACP 入口，未逐一验证 | T1-rig |
| U7 | 核侧孤儿条目的**修复点**（`openTurnClosers` 补 `approval/decided`，或 invariant 增"回合结束未决 asked"规则）是否可行、是否要报上游 | 超出本任务写范围（不许改核包） | Lead 决定是否提出上游建议 |

---

## §7 给 Lead 的三条核侧事实（最短版）

1. **孤儿审批条目是核侧设计缺口**：`approval/asked` 先落盘、`openTurnClosers()` 修复中断回合时不合成 `approval/decided`、invariant 也不要求闭合 ⇒ 永久不闭合、无报错。**实测**：`session-5bfece37-…` 里 `asked=1 / decided=0`，`turn/end reason=interrupted`，用户随后用 `/winstage approve|reject` 试图消条目。
2. **`ctx.fs.sandboxMode` 是核侧隐式多职责开关**：报告 `undefined` 会让 `dsh-tool-fs` 同时失去"升权广告 + `sandboxPolicy` 逐调用传递 + `FS_SANDBOX_DENIED` 映射"，`dsh-tool-str-replace-editor` 失去围栏；`SandboxExecutionPolicy.sessionId`（核侧唯一权威会话身份）因此断链。**实测**：staging ON → `sandboxMode=undefined`；该实例全部暂存 manifest 为 `sessionId=dsh-host`。
3. **核侧有两套互不认识的审批语义**（`ctx.approval` 远程瀑布 vs 插件 `.dshstage/review.json` + `/winstage` 命令），无共享 id/状态/清除路径，且审批面板优先级 0 会被 higher-precedence 的 `ask_user_question`（1/2）遮蔽。**实测**：3081 客户端 bundle 仍加载 `dsh-client-ui-approval`，出事的 `approval/asked` 来自 `pwsh` 升权——即"原本的审批机制"还在，被削掉的只有 FS 侧的审批来源。
