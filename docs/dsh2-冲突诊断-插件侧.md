# dsh2 冲突诊断 — 插件侧（T2a）

> 角色：T2a-analyst（插件侧根因）｜写范围：本文件｜**只读**分析 `dsh-plugin/**`、`src/**` 与 DSH 核心包（核心包深挖归 T2b）
> 分析基线：工作目录 `C:\Users\Administrator\Desktop\WinStageSandbox`，本轮仓库源码（未做任何修改）
> 判定标记：`[实测]`= 本轮真跑过并留下原始输出；`[引用]`= 只读源码/契约得到的判定（含纯函数求值）；`[未实测]`= 需要第二轮实例/插桩才能定论
> 时间：2026-09-29（本地时间；文件时间戳为本地时区，日志/JSON 里的 `generatedAt` 为 UTC）

---

## §0 结论摘要

用户报的三件事 → 本报告给出的代码级根因（每条都带证据三要素，展开见 §1–§4）：

| # | 现象 | 结论 | 判定 |
|---|---|---|---|
| **C-1** | 审批条目"**不报错**" | `client.js:1370` 把命令结果当成 `value.kind` 读，而 RPC 返回的 value 是 `{commandId, result:{kind,text}}` ⇒ `kind` 恒为 `undefined` ⇒ 恒判成 `'success'` ⇒ **宿主辛苦构造的每一条 `{kind:'error'}` 提示在面板上一个字都不显示**（含 `STALE_BASELINE`、`SANDBOX_PATH_MASKED_CONFIRM` 二次确认指引、`没有匹配的待审路径`、"0 应用 0 失败"）。§17 的"修复"只加了 `if (kind !== 'success')` 字符串，读的还是错层级 | **[实测]**（抽真实表达式求值 + 平台自带 client 对照 + T4 报告里同一条 RPC 的原始值） |
| **C-2** | 审批条目"**消不掉**" | `host-plugin.mjs:307` 在 `diffEntries()` 为空时**早退**，于是 `ReviewService.reject()` 里专门为"净 diff 空但队列还有活候选"写的清理分支**永远不可达** ⇒ 冻结存档行（`frozenOnly:true`，面板上**没有勾选框**）既批不了也拒不掉，`snapshot().pending` 永远为 true ⇒ 面板永不卸载、条目永久留存 | **[实测]**（exp3：命令面走完 reject 后 `frozenOnly:1 / pending:true`；直接调 `service.reject(undefined)` 立刻 `discarded:[cs_0001…] / pending:false`） |
| **C-3** | 审批条目"**批不掉 / 一点就是没用**" | `src/workspace.mjs:632-637` `ensureEntry()` 对已存在条目**幂等早退**，从不刷新 `baseHash`；`staging-fs.mjs` 的 write/edit 也从不以真实文件为基线重述 ⇒ 真实文件被外部改过之后，`applyOneChange()` 的 `STALE_BASELINE`（workspace.mjs:1109-1117）**永久**拒绝落盘，条目留在 `review.json`。这正是 docs §7.8 断言"不是缺陷"的那一段 | **[实测]**（exp1：`baseHashUnchangedSinceStep1:true`、`failed:[STALE_BASELINE]`、`entryStillThere:true`、`stillInNetDiff:1`；rebase 后立刻可批） |
| **C-4** | 沙箱"**修改规则互相冲突**"（活的 3080） | 活的 `web` profile 写着 `enabled: false`（`C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml:28-32`，mtime **18:29:48**），但 **18:40–18:43** 的三次 `ctx.fs` 写入**仍然进了暂存树**（`.dshstage/manifest.json` 里 `external:true` + 暂存对象在 `.dshstage/staged-ext/`） ⇒ 线路上 `stagingEnabled()` 返回了 `true`。**"关掉开关 = 退回平台审批模式"在活实例上不成立**；同时 `client.js:631-638` 看到 `enabled:false` 就把面板整体卸载 ⇒ 用户看到"开关已关、面板没了、但写文件的回执却在骗人" | **[实测]**（profile 文件内容+mtime、manifest 条目与真实磁盘缺失三方对照） |
| **C-5** | 条目"**看不见 / 随会话漂移**" | 活的 3080 里写入落在**共享根** `.dshstage/`（`manifest.sessionId = "dsh-host"`，`review.json` 也写在这里），同时**另有一份**会话语料 `.dshstage/sessions/session-e28ec339-e8e0-4f87-8139-1d28ebd12d51/review.json` ⇒ `staging-fs.sessionIdOf()` 对一部分调用**拿不到会话身份**（回落到共享存储），而面板按会话语料读 ⇒ 同一时刻两份"待审真相" | **[实测]**（manifest/两个 review.json 直接读盘） |
| **C-6** | 沙箱"**修改规则互相冲突**"（本会话亲历） | 本轮 T2a **自己**在 3080 里用 `write` 工具写 `%TEMP%\winstage-exp\exp1.mjs`：工具回执 `Created file`、插件自己的 `read` 能读回，但 `pwsh` 侧 `Test-Path` = **False**，文件实际在 `.dshstage\staged-ext\a9\a9f5eed0a13d3bc9\exp1.mjs`。同一个 agent 同时看到两个文件系统：`write/edit`（ctx.fs）走暂存，`bash/pwsh` 直写真实磁盘 | **[实测]**（本会话，含命令与路径） |
| **C-7** | 暂存面与**原生审批机制**冲突 | `staging-fs.mjs:377-380` `sandboxMode` 在接管时返回 `undefined` ⇒ `dsh-tool-fs` 在 **apply 时**（`lib/index.js:1084-1086`）定下 `escalationModes=[]`、`policy=undefined` ⇒ ① `write`/`edit` 的 schema 里**不再有** `sandbox_permissions`/`justification`（模型无法申请升权）；② 不再有 `FS_SANDBOX_DENIED` / 同回合升权提示；③ **该判定是 apply 期冻结的**，事后把开关关掉也不会把升权广告还回来 | **[引用]** |
| **C-8** | 批准落盘**绕过**原生机制 | `review-service.mjs:762-767` → `Workspace.applyCandidate` → `applyOneChange` → `writeFileAtomic(abs, content)`（`src/store.mjs`，纯 `node:fs`）⇒ 批准写真实磁盘的那一条路径**完全不经过 `ctx.fs`**：不过沙箱围栏、不发 `fs/observed`、不更新 observation policy 的版本、不占用提供方的 per-target 锁 | **[引用]** |
| **C-9** | 沙箱"修改规则互相冲突"（版本口径） | 暂存命中时插件把 version 报成 `winstage:<内容哈希>`（`staging-fs.mjs:648-650/682-683`），批准后条目不再投影 ⇒ 同一路径的 version 换成 fs-local 的 `dev:ino:size:mtimeNs:ctimeNs`（`dsh-fs-local/lib/index.js:145-146`）。observation policy 把上一次观察到的 `winstage:…` 作为 `replaceIfVersion` 传回（`dsh-fs-observation-policy/README.md:74`），两串永不相等 ⇒ **批准之后对同一文件的第一次 edit 会假报 `FS_STALE_VERSION`**（内容其实一位没变） | **[引用]**（两个命名空间已 [实测] 不相交） |
| **C-10** | 装配契约（C-8 同源） | `cordis.patch.yml:44-48` 用 YAML 锚点把 host 行 `workspaceRoot` 与 fs 行 `cwd` 绑成同一字面值，但 profile 覆盖层对 `config` 是**整体替换**（`.t/dsh2/HOWTO-RESTART.md:59-63`）⇒ 锚点被绕过，实际退化成"两个手写的字面值"。`staging-fs.mjs:211-216` 的漂移守卫第一项要求 `config.workspaceRoot !== undefined`，只重述 `cwd` 的覆盖层会让**整条守卫空转** | **[引用]** |
| **C-11** | "关不掉的暂存" | `staging-fs.stagingEnabled()` 有**三重 fail-open**：`!Array.isArray(data) → true`、`!row ││ !row.config → true`、`catch → true`（`staging-fs.mjs:361-367`）。任何结构性失配（行名断言被静默丢弃、层不同组、config 被整体替换）都**默认"接管"** | **[引用]** |
| **C-12** | 静默失效清单 | 6 类 `return null/undefined/true`、5 处 `catch` 只记日志、2 处 patch 断言失配整条跳过、1 处 `normalizeDefinition()` 抛错会杀掉整个注册回调（现已被 try/catch 兜住但只落 warn） | **[引用]** 见 §2.4 |
| **C-13** | "两边都不管" | `dsh-plugin/provider.mjs`（`ctx.sandbox` confine 面）与 `selfcheck.mjs` **没有被任何 loader 行 import**（全仓仅互相在注释里提及）⇒ 插件只替换了 `ctx.fs`，命令执行面仍是平台机制；`bash/pwsh` 的写入不进暂存（`staging-fs.mjs:30` 已如实标注） | **[引用]** |

**一句话结论**：插件把 `ctx.fs` 的写入面整体搬进了自己的暂存树，但**"关掉开关"这条退路在活实例上失灵（C-4/C-11）**、**把手动审批这条主路的失败提示全丢（C-1）**、**并给出一个永远清不掉的条目终态（C-2）**；三者叠加正好复现用户的三句话。

### 判定强度与残余不确定性（如实标注）

- `[实测]` 部分全部是本轮可复算的：`.\autotest.cmd --skip-audit` = **PASS，14 套件 / 646 断言 / exit 0**（报告 `.t\test-report.json`）；函数级实验脚本在 `%TEMP%\winstage-exp\{exp1,exp2,exp3}.mjs`（**不在仓库内**，内容见 §4.5）。
- `[未实测]`（需要第二轮实例或插桩，见 §4.4）：① 3080 上 `stagingEnabled()` 到底走的是哪一条 fail-open 分支；② `ctx.agents.currentInitiator()` 为何拿不到会话身份（C-5 的直接成因）；③ C-9 的假 `FS_STALE_VERSION` 端到端；④ C-7 中 `dsh-tool-fs` 的 `FsSandboxController` 是否确实是在 `sandboxMode===undefined` 时构造的（apply 次序）。

---

## §1 冲突面（Q1）：替换 `fs-sandbox` 之后，"文件策略/审批触发"归谁

### 1.1 装配事实：一行禁用 + 两行插入

`dsh-plugin/cordis.patch.yml:50-73`

```yaml
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  disabled: true

- insert:
    - id: winstage-sandbox
      name: '@local/dsh-winstage-sandbox'
      config: { enabled: true, workspaceRoot: &winstageRoot C:\...\WinStageSandbox, probeOnStart: true }
    - id: winstage-fs
      name: '@local/dsh-winstage-sandbox/fs'
      config: { cwd: *winstageRoot, workspaceRoot: *winstageRoot }
```

`fs` 是单例服务名，所以"替换"只能写成"禁用 + 插入"（同文件 :29-31 的理由）。于是**平台原本承担"文件策略/审批触发"的那一行被禁用**，职责按下面的分岔转移：

| 平台原生职责（`dsh-fs-sandbox`） | 禁用后由谁接手 | 证据 |
|---|---|---|
| `sandboxMode` 广告（决定 `write/edit` 是否暴露 `sandbox_permissions`） | 暂存面：`sandboxMode → undefined`；关掉开关时 `super.sandboxMode` | `staging-fs.mjs:377-380` |
| per-call 围栏 `checkedTarget()`：`read-only` 全拒、`workspace-write` 只允许可写根内、`danger-full-access` 放行 | 暂存面**完全不接手**（工作区内/外都进暂存，不再抛 `FS_SANDBOX_DENIED`）；开关关闭时才退回平台 | `dsh-fs-sandbox/lib/index.js:153-166`；`staging-fs.mjs:472-486` |
| `FS_SANDBOX_DENIED` → `[sandbox: …]` 标记 + 同回合升权提示 | **不再产生**（外部写入 = 进暂存，工具回执仍成功） | `dsh-tool-fs/lib/index.js:1159-1163`；`staging-fs.mjs:28-29` 注释自认"硬拒已取消" |
| 用户审批（`ctx.approval` / `dsh-user-approval`）：升权请求走审批弹窗 | **改为**本插件自己的"审批条目 + 面板 + `/winstage approve`"，且这条手动路是**唯一**决定落盘的入口 | `review-service.mjs:748-782`；`host-plugin.mjs:251-303` |

### 1.2 "两边都要管"的三条路径

**(a) 批准落盘：绕过暂存、也绕过一切原生机制（C-8）**

`review-service.mjs:762-767`

```js
const result = ws.applyCandidate(latest.id, {
  paths, force: options.force === true, ...(options.confirmedMasks !== undefined ? {...} : {}),
})
```

→ `src/workspace.mjs:1042-1047` → `applyOneChange` → `src/workspace.mjs:1140-1142`

```js
const content = this.store.readBlob(change.after.hash)
// 原子替换：临时文件 + rename（同卷）
writeFileAtomic(abs, content)
```

`writeFileAtomic` 是 `src/store.mjs` 里的纯 `node:fs`（同目录、临时文件 + rename）。它不是 `ctx.fs`，于是：不经过沙箱围栏、不发 `fs/observed`（observation policy 的版本记账整条跳过）、不占 `dsh-fs-local` 的 per-target 锁（`withLock`，`dsh-fs-local/lib/index.js:770`，提供方写路径用的就是它）。**"批准"这条写入路径与平台上任何一条规则都不相交** —— 它只受 `applyOneChange` 自己的 `STALE_BASELINE`（:1109-1117）与 `maskOf` 二次确认（`applyCandidate` :1006-1041）约束。

**(b) 暂存命中时不报任何审批事件、且把平台围栏"暂停"**

`staging-fs.mjs:470-486`

```js
async writeText(target, content, expected, signal, sandboxPolicy) {
  if (!this.stagingEnabled()) return super.writeText(target, content, expected, signal, sandboxPolicy)
  if (!this.inConfiguredWorkspace(sandboxPolicy)) { this.warnForeignWorkspace(sandboxPolicy); return super.writeText(...) }
  ...
  if (place.external && stageOutside === 'direct') return super.writeText(...)   // 显式逃生口，默认关闭
  const service = this.stagingFor(this.sessionIdOf(sandboxPolicy))
```

工作区内**任何**写入、以及工作区外（默认 `stageOutside='stage'`，见 `staging-fs.mjs:156`）的写入都不再走 `super`，因此：围栏不触发、`FS_SANDBOX_DENIED` 不产生、`dsh-fs-sandbox.checkedTarget` 不被调用。工具侧看到的是 `{operation, version, before, after}` 成功回执（:515），**模型与用户都以为写成功了**，而真实磁盘一位未动。

**(c) 命令执行面：两套 fs，谁都不管谁（C-6/C-13）**

`staging-fs.mjs:30` 逐字自认：

```
*   - `bash` / `pwsh` 的写入不经过 `ctx.fs`，因此仍然落在真实工作区；
```

`dsh-plugin/provider.mjs:113-125` 只提供了 `createConfineSurface()`，`selfcheck.mjs` 只提供 `selfCheck()`；全仓 `grep provider\.mjs|selfcheck\.mjs` 只命中它们**自己文件里的注释**（见 §2.4 清单第 12 条）⇒ 没有任何 loader 行 `import` 它们 ⇒ `ctx.provide('sandbox', …)` 从未发生（`provider.mjs:109-111` 自己写明"还需要 `ctx.provide`"）。**结论：命令执行沙箱这条路由平台机制照旧承担，插件的暂存语义不覆盖它**；于是同一个 agent 的 `write` 与 `pwsh` 落在两个不同的"磁盘"上。

### 1.3 本会话亲历证据（C-6，[实测]）

T2a 在 3080 会话里用 `write` 工具落一个临时脚本（真实意图是写到 `%TEMP%`）：

| 观察 | 结果 |
|---|---|
| `write` 工具回执 | `Created file`（成功） |
| 插件自己的 `read` 工具回读 | 可读（走暂存投影） |
| `pwsh`：`Test-Path 'C:\Users\Administrator\AppData\Local\Temp\winstage-exp\exp1.mjs'` | **False** |
| 文件实际位置 | `C:\Users\Administrator\Desktop\WinStageSandbox\.dshstage\staged-ext\a9\a9f5eed0a13d3bc9\exp1.mjs` |
| `.dshstage/manifest.json` 里的条目 | `{"kind":"file","state":"file","baseHash":"absent","stagedHash":"707264ad…","external":true,"absPath":"C:\\Users\\Administrator\\AppData\\Local\\Temp\\winstage-exp\\exp1.mjs","origin":"dsh-tool","createdAt":"2026-09-29T10:43:44.587Z"}` |

⇒ "工具说成功、真实磁盘没有"这条**回执不可信**在活实例上是可复现的（`external:true` 证明走的是 `staging-fs.mjs` 的外部条目分支）。

### 1.4 谁赢（胜出点，逐条）

| 冲突对 | 胜出者 | 胜出点（行） |
|---|---|---|
| 平台围栏 vs 暂存 | **暂存**（围栏根本不执行） | `staging-fs.mjs:472`（`stagingEnabled()` 为真时直接进暂存分支） |
| 用户"关闭"开关 vs 暂存继续 | **暂存**（活实例实测） | `staging-fs.mjs:361-364` 的 fail-open `return true` |
| 面板可写集合 vs 净 diff | **净 diff**（面板按净 diff 过滤；冻结行不可点） | `host-plugin.mjs:261-266`、`review-service.mjs:503-513` |
| 平台 observation policy 版本 vs 插件 version | **插件**（提供方最后比较，判 `FS_STALE_VERSION`） | `staging-fs.mjs:499-501`（write）、`:543-545`（edit） |
| 批准落盘 vs 一切围栏 | **批准**（纯 node fs） | `src/workspace.mjs:1142` |
| `.dshstage` 自遮蔽（`maskOf`） vs 批准写入 | **遮蔽**（需二次确认），但**仅对 `applyCandidate` 生效**；暂存树自身的写入走 `src/store.mjs` 的裸 fs，不受遮蔽约束 | `src/workspace.mjs:214-222`、`review-service.mjs`/`applyCandidate` :1006-1041 |

---

## §2 消不掉的条目与静默失败（Q2）

### 2.1 完整调用链：面板点一下到底走了什么

```
[面板按钮] client.js:1739 rejectAll  onClick: () => act('/winstage reject')
   └─ act(line, targets)                  client.js:1349-1381
        └─ executeCommand(matched.sessionId, line)   ← inject 自 client.js:2151 runCommand
             └─ runCommand: ctx.remote.commands.execute(sessionId, line, [])   client.js:609-614
                  └─ [Host] CommandsService.execute()      dsh-commands/lib/index.js:327-395
                       ├─ appendLifecycle(command/run)
                       └─ handler(invocation) = host-plugin.mjs:344-372 的包装
                            ├─ isEnabled() 检查（关时回 DISABLED_TEXT 的 kind:'error'）
                            ├─ serviceFor(invocation) → getReviewService({workspaceRoot, sessionId})
                            └─ handlers[sub]({args, service})
                                 ├─ approve: host-plugin.mjs:251-303 → service.approve(paths, opts)
                                 │     └─ ReviewService.approve  review-service.mjs:748-782
                                 │          └─ Workspace.applyCandidate → applyOneChange（纯 node fs 落盘）
                                 └─ reject:  host-plugin.mjs:304-315 → service.reject(paths)
                                       └─ ReviewService.reject  review-service.mjs:855-894
                                            ├─ revert() 逐路径删清单条目 + 回收暂存对象
                                            └─ reconcileCandidates() 终结空壳候选
                  ← settle() 包装成 { commandId, result }   dsh-commands/lib/index.js:340-351
             ← RemoteResult 信封 { ok:true, value:{commandId, result:{kind,text}} }
        ← runCommand 解信封，返回 result.value = { commandId, result:{…} }
   └─ .then((value) => { const kind = value && typeof value.kind === 'string' ? value.kind : 'success' … })
```

**这条链上有 5 个"什么都不做也不报错"的断点**，其中 C-1、C-2 是必现的（见下）。

### 2.2 C-1：面板把命令结果读错层级 ⇒ 一切 `kind:'error'` 静默（[实测]）

**证据一（代码）** `client.js:1366-1376`

```js
Promise.race([pending, timeout])
  .then((value) => {
    const kind = value && typeof value.kind === 'string' ? value.kind : 'success'
    if (kind !== 'success') {
      const text = typeof value?.text === 'string' && value.text.length > 0 ? value.text : t('commandNoOp')
      showFailure(text, Array.isArray(targets) ? targets : undefined)
    }
  })
  .catch((error) => showFailure(String(error?.message ?? error), …))
```

**证据二（宿主真实返回形状，三处独立）**

1. `dsh-commands/lib/index.js:340-351`：`settle(result)` 返回 `Object.freeze({ commandId, result: Object.freeze(result) })` —— `kind/text` 在 `result` **里面**。
2. 远程 schema 逐字：`dsh-commands/lib/typert.remote-client.js:20-30`

```js
const _…_execute_result$schema = () => (… ??= z.union([z.undefined(), z.object({
  'commandId': …readonly(),
  'result': z.union([z.object({'kind': z.literal("success").readonly(), …}),
                     z.object({'kind': z.literal("error").readonly(), 'text': z.string().readonly()})]).readonly(),
})]))
```

3. `[实测]` 项目自己的记录：`.t/dsh2/T4-browser-report.md:1013-1016`

```
'/winstage status' -> ok=True value={"commandId":"cmd-41f0b8d3-9",
                       "result":{"kind":"success","text":"WinStage 暂存待审  1 个文件  +1 / −0 …
```
（同一条在 `docs/dsh2-发现记录.md:749-750` 复述为"`result.kind=success`"。）

**证据三（平台自带 client 的正确读法）** `@deepseek-ai/dsh-client-ui-commands/lib/client.js:1041-1045`

```js
this.notifyExecuted(session.sessionId, submittedCommandName(line), result.value.result);
if (attachments.length > 0 && result.value.result.kind === "error") return { kind: "error", text: result.value.result.text };
```

**证据四（本轮函数级求值，exp1 E3）**：把 `client.js` 里那段三元表达式原样切出来求值

```
extractedExpression : value && typeof value.kind === 'string' ? value.kind : 'success'
kindOf({commandId:'cmd-41f0b8d3-9', result:{kind:'error', text:'…'}})  ->  'success'
silent_for_error    : true
```

⇒ **所有**由宿主构造、本意是"让 UI 把原因显示出来"的错误都到不了用户的屏幕，逐条列出（每一条都是宿主的**有意设计**）：

| 宿主的 kind:'error' | 出处 | 本意 |
|---|---|---|
| `DISABLED_TEXT`（开关已关，命令拒绝执行） | `host-plugin.mjs:227-228, 346` | 告诉用户"写入已交回平台" |
| `未知开关：…` | `host-plugin.mjs:256-259` | 指出拼错的 flag |
| `没有匹配的待审路径：…` | `host-plugin.mjs:264-266, 309` | 指出路径不匹配 |
| `没有条目被应用：选中的路径不在最新候选里…` + 处理建议 | `host-plugin.mjs:286-290` | 修"批准全部点了没反应"（docs §17 的第 4 条静默源） |
| `STALE_BASELINE` 说明 + `/winstage rebase` 出路 | `host-plugin.mjs:280-283` | 修 C-3 的唯一可见指引 |
| `SANDBOX_PATH_MASKED_CONFIRM` 二次确认指引（含 `--confirm-mask` 重发命令行） | `host-plugin.mjs:291-301` | 敏感项落盘前的唯一确认通道 |
| 命令注册失败降级 | `host-plugin.mjs:431-436`（只写日志） | — |

**这解释了"§17 的修复看起来做了、线上依旧没反应"**：`.t/approve-button-selftest.mjs:57` 只断言源码里**存在**这个字符串：

```js
check('命令返回非 success 时显示原因', source.includes("if (kind !== 'success')") && source.includes('showFailure(text, Array.isArray(targets)'))
```

字符串断言在"读错层级"的实现上**照样通过**（19/19），所以这条缺陷两轮都没被抓到。**这是"静默失效被静态断言掩盖"的教科书样本。**

### 2.3 C-2：「拒绝全部」也清不掉冻结存档行 ⇒ 条目永久留存（[实测]，必现）

**代码定位（两行之差）**

`host-plugin.mjs:304-310`

```js
reject({ args, service }) {
  const ws = service.reload()
  const changes = ws.diffEntries()
  if (changes.length === 0) return { kind: 'success', text: '没有待审文件' }   // ← ★ 早退
  const paths = args.length > 0 ? matchPaths(changes, args).map((c) => c.path) : undefined
  ...
```

而 `review-service.mjs:862-866` 明确写了**不能早退**：

```js
// 净 diff 已经空了、但队列里还有活候选时**不能**早退：那些候选正是"空壳 pending"，
// 而"拒绝全部"是用户唯一能清掉它们的出口（否则面板会停在只有冻结存档行的状态里）。
if (!selected && changes.length === 0 && liveBefore.length === 0) { … }
```

⇒ **服务层为"空壳 pending"写的唯一出口，被它前面的命令 handler 挡住了，永远不可达。**

**为什么会有"净 diff 空、队列还有活候选"**：`snapshot()` 的 D1 设计（`review-service.mjs:567-577/579-642`）会把"仍有活的候选里、但已不在当前净 diff"的路径渲染成 `frozenOnly:true` 的只读存档行，`pending` 因此为真。而 `frozenOnly` 行在面板上**没有勾选框**（`client.js:1524-1534`：`actionable ? <input type=checkbox> : <span frozenBadge>`），也没有单行拒绝按钮（`client.js:1736-1741` 只有全量「拒绝全部」）。

**本轮最小构造（exp3，全程只用插件自己的 API，无 fixture hack）**

| 步 | 操作 | 观察 |
|---|---|---|
| 1 | `ctx.fs` 写 `A.txt`、`B.txt` | `counts.net=2`，候选 `cs_0001…` PENDING |
| 2 | `/winstage approve "A.txt"`（命令面） | `{kind:'success', text:'已应用 1 项\n 仍在待审：B.txt'}`，候选 → `partially-applied`，`appliedPaths=[A.txt]` |
| 3 | agent 把 `B.txt` 写回**原内容**（= 真实基线） | `snapshot()`：`counts.net=0`、`frozenOnly=1`、`files=[{path:'B.txt', frozenOnly:true, frozenReason:'no-net-change'}]`、**`pending:true`** |
| 4 | 「拒绝全部」→ `/winstage reject` | 返回 `{kind:'success', text:'没有待审文件'}`；**`snapshot()` 仍然 `frozenOnly:1 / pending:true`** |
| 5 | `/winstage reject "B.txt"` | 同上，**行还在** |
| 6 | 直接调 `svc.reject(undefined)`（绕过命令 handler） | `discarded:['cs_0001_b053c9e2']` ⇒ `pending:false`、`files:0` |

⇒ **C-2 是插件侧 100% 确定的"消不掉"**：第 4/5 步是用户唯一能按的两个按钮，第 6 步证明服务层本来能清 —— 挡住它的是 `host-plugin.mjs:307`。再叠加 C-1（连"没有待审文件"这句都在面板上不显示），用户看到的就是"点了没反应 + 条目不动"。

**边界（如实标注）**：第 3 步的触发条件是"**部分批准之后，另一条被冻结路径又被写回它的基线**"。生产里等价场景：agent 改了一行又改回来、或用户先只批准一部分、随后 agent 撤销另一部分。另一类 `frozenOnly` 成因（`reclaimed`/`no-op`）需要清单被跨进程/夹具改动过（D1 在 3085 fixture 上 `[实测]` 过，出处 `review-service.mjs:456-480`）；本轮 exp2 B 段用**直接改清单**复现了同一条判据：`frozenOnly:true, frozenReason:'reclaimed'`，同样在步骤 4/5 清不掉。**两类的"清不掉"点是同一个：`host-plugin.mjs:307`。**

### 2.4 C-3：`ensureEntry` 幂等早退 ⇒ baseHash 停在旧值（Q2 点名的假设：**成立**）

**代码** `src/workspace.mjs:629-663`

```js
ensureEntry(rel, opts = {}) {
  const existing = this.entryOf(rel)
  if (existing && existing.state !== STATE.DELETED) {
    // 幂等：已暂存路径不重复暂存（#3.10）
    if (opts.kind && existing.kind !== opts.kind && existing.kind !== 'dir') {
      existing.kind = opts.kind
    }
    return existing                                    // ★ 早退：baseHash 一位不动
  }
  const abs = this.absolute(rel)
  const info = statKind(abs)
  const baseHash = info && info.kind === 'file' ? hashFile(abs) : hashAbsent()
  ...
  const entry = { …, baseHash, baseKind: info?.kind, stagedHash: baseHash, … }
```

`staging-fs.mjs` 的写路径从不重述基线（`writeText` :510 只调 `ws.writeFile`），`ws.writeFile`（`src/workspace.mjs:672-694`）只更新 `stagedHash/size/changed`。**⇒ 一条路径的 `baseHash` 锚定在它"第一次被暂存那一刻"的真实内容上，此后所有 write/edit 都不再刷新。**

**本轮实验（exp1，[实测]，函数级）**

| 步 | 状态 |
|---|---|
| 真实 `a.txt=v0`，暂存 `v1` | `baseHash=84325551…(v0)`、`stagedHash=2d27fbdf…(v1)`、`diff=[{op:'modify', before:84325551…, after:2d27fbdf…}]` |
| **外部**把真实文件改成 `vX` | `realFileNowIs_vX: true` |
| 再次暂存 `v2`（同路径） | `baseHashUnchangedSinceStep1: true`（**仍是 v0 的哈希**）、`stagedHashChangedFromStep1: true`、`diffBeforeEqualsBaseHash: true` |
| `applyCandidate()`（= `ReviewService.approve` 的底层调用） | `applied: []`、`failed: [{path:'a.txt', code:'STALE_BASELINE'}]`、`status:'pending'`、`realFileAfter:'vX\n'`、`entryStillThere:true`、`stillInNetDiff:1` |
| `rebaseEntry('a.txt')` 后再冻结、再批准 | `applied:['a.txt']`、`realFileAfter:'v2\n'`、`baseHash===stagedHash`、`netDiffAfter:0` |

`ReviewService` 层的同一场景（exp1 E2）：`approve()` → `{ok:false, approved:0, failed:[STALE_BASELINE], message:'已应用 0 项，失败 1 项', remaining:['b.txt']}`，`snapshot().counts.staleBaseline=1`，`pending:true`；`reject(undefined)` 后 `pending:false`；`rebase()+approve()` 后 `approved:1`、真实文件变成新内容、`pending:false`。

**代码级判定**：
- 该幂等本身**不是**"同一路径再也无法被批准"的充分条件 —— `rebase` / `reject` 都能解锁（`src/workspace.mjs:307-320`、`review-service.mjs:855-894`）。
- 但它**确实**让"外部改动过 → 批准必然失败"成为**默认终态**，且失败原因是"陈旧的 before.hash"，与用户当前看到的真实文件无关。**在面板上表现为：同一条目点多少次「批准」「批准全部」都不会消失。** 这就是用户说的"消不掉"。
- **docs §7.8:323-325 的判定（"不是缺陷；办法是先摘掉历史条目再重新暂存"）在本轮不成立**：那是手工 CLI 夹具的做法；在插件装配下，用户没有"摘掉条目"的按钮（唯一等价操作是 `/winstage rebase` 或 `/winstage reject`，且两者都受 C-1/C-2 影响）。另外该段引用的行号 `502-508` 已经过期，实际在 `629-638`。
- 最小复现处方见 §4 的 **R-A**。

### 2.4b `ensureEntry` 的一个次生"基线说谎"窗口（[引用]）

`src/workspace.mjs:1076-1089`：批准成功后

```js
for (const item of applied) {
  const entry = this.entryOf(item.path)
  if (!entry) continue
  if (change_isDelete(candidate, item.path)) { … }
  else { entry.baseHash = entry.stagedHash; entry.baseKind = entry.kind; entry.changed = false }
}
```

它把 `baseHash` 设为**清单当前的** `stagedHash`，而落盘写的是**候选冻结的** `change.after.hash`。两者在正常时序下相等（`ensureCandidate` 会在净 diff 变化时重新冻结，`review-service.mjs:428-451`），但一旦有**跨进程/异步**的再写入插在 `ensureCandidate()` 与 `applyCandidate()` 之间，清单就会声称"基线 = 新内容"而磁盘上是旧内容 ⇒ `diffEntries()` 归零、面板显示"没有待审"，而 `read` 读到的是另一个版本。这条窗口我**没有**构造出确定性复现（需要跨进程竞态），标 `[未实测]`；它只影响"多进程/异步写同一路径"的场景。

### 2.5 `client.js` 里其它"点了没反应"的分支（逐条，[引用]）

| 位置 | 代码 | 静默后果 | 判定 |
|---|---|---|---|
| `client.js:1349-1350` | `if (busy) return` | 并发点击被丢，无提示 | [引用] |
| `client.js:1356` | `if (!executeCommand) return` | 注入缺失 ⇒ 点击无反应、无提示 | [引用]（`.t/approve-button-selftest.mjs:59` 的字符串断言只覆盖了 `!matched?.sessionId` 那半句） |
| `client.js:1370-1374` | `value.kind` | **C-1**，一切命令错误不可见 | [实测] |
| `client.js:1817` | `if (busy \|\| !sessionId \|\| !executeCommand) return` | 访问模式菜单里的「刷新/重新对齐」静默 | [引用] |
| `client.js:1819-1822` | `.catch(() => {})`，且**从不读** `kind` | 菜单里的 `/winstage rebase`、`/winstage refresh` 失败完全无痕 | [引用] |
| `client.js:1882` | `Promise.resolve(setEnabled(false)).catch(() => {})` | 关闭开关失败无痕（`WinStageRow` 的开关有 `failed` 态，这里没有） | [引用] |
| `client.js:694-695` | poller 唯一 catch → `store.publish({status:'error'})`；`store.state.error` 在 `WinStageReview` 里**没有被渲染**（只渲染 `snapshot/notice/failures/alert`） | 轮询失败（如 review.json 读不到）不可见；面板只是"不出现" | [引用] |
| `client.js:644-653` | `!sessionId \|\| root===''` ⇒ 发 idle | root 读不到 ⇒ 面板**永不出现且零报错**（docs 发现记录 §"第四条静默不出现的路径"已记过） | [引用] |

### 2.6 命令面/服务面的静默吞掉（[引用]）

| 位置 | 形态 | 后果 |
|---|---|---|
| `review-service.mjs:404-407` | `absorbSharedStore` 整段 `try{…}catch{ this.log(...); return 0 }` | 合并共享存储失败只写日志（`serviceFor` 的 log = `log.info`）⇒ 条目"消失"无痕 |
| `review-service.mjs:411-416` | `afterMutation` 的 `ensureCandidate` 失败被吞（"冻结候选失败（已忽略，暂存内容仍在）"） | 候选没冻结 ⇒ 面板看不到，但写入"成功" |
| `review-service.mjs:920-925` | `reconcileCandidates` 里 `discardCandidate` 失败被吞 | **正是 C-2 的清理动作**；失败无声 |
| `review-service.mjs:935-943` | `revert()` 回收暂存对象失败只记日志 | 清单已删、对象残留（后续 `verifyProjection` 可能报损坏） |
| `review-service.mjs:347,349,354,357,364` | `absorbSharedStore` 的 5 处 `return 0` | 解析失败/空清单 → 静默不合并 |
| `staging-fs.mjs:609-625` | `notifyStagedChange` 每个观察者 `try{…}catch{ this.log(...) }` | 失效通知失败 ⇒ 客户端文件视图不刷新（S7） |
| `staging-fs.mjs:365-367` | `stagingEnabled()` 的 `catch { return true }` | **见 C-11**：任何异常都意味着"接管" |
| `staging-fs.mjs:47-49` | `locatePackageFile` 的 `catch { roots = [] }` | 定位依赖失败退化为"找不到模块"，最终由 :63-69 fail-closed 兜住（这条是好的） |
| `staging-fs.mjs:262-267/294-300` | `sessionIdOf`/`sessionWorkspaceOf` 的 `catch {}` | **C-5**：拿不到会话身份 → 落共享存储 |
| `host-plugin.mjs:431-436` | 命令注册失败只 `logger.error` + `log.warn` | 面板上 `/winstage*` 整族消失、无 UI 提示（T5-B 实测过这条静默失效） |
| `review-service.mjs:105` `assertDangerIdsExist()` | 模块加载时硬失败（**好**：这是"清单漂移不许静默"的正面例子） | — |
| `host-plugin.mjs:337-343` 注释 | `normalizeDefinition()` 要求 `input.hint`，否则抛 `TypeError` 杀掉整个 `ctx.inject(['commands'], …)` 回调 ⇒ **线上 0 条命令**（现在被 :428-436 兜住） | 历史缺陷，已兜 |

**patch 装配层的两条静默失效**（`.t/dsh2/HOWTO-RESTART.md:44-63`，本轮引用）：
1. 非 insert 补丁的 `name` 是**断言**：不匹配 ⇒ `cordis-plugin-include/lib/index.js:95-98` `warn(...); continue` ⇒ **整条补丁连同 config 被跳过**（行名改名事故，曾导致 `.dshstage` 写进真实工作区）；
2. 覆盖层对 `config` 是**整体替换**（`:99-102` `target[key] = value`）⇒ 漏写的键静默消失（`winstage-fs` 只写 `cwd` 时，`staging-fs.mjs:211-216` 的漂移守卫第一项恒假 ⇒ 守卫空转）。

### 2.7 C-5：会话隔离在活实例上只做了一半（[实测]，直接指向"条目看不见/消不掉"）

活 3080 的两份"真相"同时存在：

| 存储 | 内容 | 证据 |
|---|---|---|
| 共享根 `.dshstage/manifest.json` | `sessionId = "dsh-host"`（= `ReviewService` 无会话时的默认值，`review-service.mjs:277`）、`revision = 25` | 直接读盘 |
| 共享根 `.dshstage/review.json` | `workspaceRoot=C:\...\WinStageSandbox`、`sessionId="dsh-host"`、`pending:true`、`counts:{files:5, net:5, frozenOnly:0}`、`riskCounts:{normal:2,outside:3,sensitive:0,danger:0}`、`candidates:[{id:'cs_0012_cde88b95',status:'pending',paths:5}]` | 直接读盘（`generatedAt 2026-09-29T10:43:44.616Z`） |
| 共享根 `.dshstage/queue.json` | `order` 12 个候选，1 discarded、10 superseded、1 pending；**21 分钟内 12 个候选** | 直接读盘 |
| 会话语料 `.dshstage/sessions/session-e28ec339-e8e0-4f87-8139-1d28ebd12d51/` | 自带 `manifest.json/queue.json/review.json/candidates/` | 目录列举 |

`staging-fs.sessionIdOf()`（:255-278）的优先级是：显式 `fixedSessionId` → `sandboxPolicy.sessionId` → `ctx.agents.currentInitiator()` → **`undefined`（落共享存储）**。共享根里出现 `dsh-host` 就证明**第三条也失败了**。而客户端读的是**会话语料**（`client.js:586-607`：有 `sessionId` 时读 `.dshstage/sessions/<key>/review.json`）⇒ 谁读谁写不是同一个目录时，面板就是"看不见"，而写入方拿着成功回执。`review-service.absorbSharedStore()`（:343-408）只在"**拿到会话身份的**写/命令"上触发，**面板轮询只读、不触发合并**（`client.js:586-607` 不调任何写命令）⇒ 共享根的条目可以长期不被并回。

**为什么拿不到身份（两个候选原因，[未实测]）**：
- [引用] `dsh-tool-fs/lib/index.js:1084-1087,1122-1126`：`ctx.fs.sandboxMode === undefined` 时 `policy = undefined`，`resolvePolicy()` 直接返回 `undefined` ⇒ 工具调用**根本不带 `sandboxPolicy`** ⇒ 只剩 ambient initiator 一条路；
- [未实测] ambient `ctx.agents.currentInitiator()` 在本轮这些调用上返回了空（需要插桩：在 `sessionIdOf()` 打点，或在 `/winstage status` 输出 `receivedSessionId`）。

**判别式**：`manifest.json` 的 `sessionId` 字段。`"dsh-host"` ⇒ 落共享存储；`session-<uuid>` ⇒ 会话隔离生效。

---

## §3 修改规则冲突清单（Q3）

### 3.1 生效中的规则（全量）

| # | 规则 | 出处 | 作用域 |
|---|---|---|---|
| R1 | 审批策略档位 `read-only / workspace-write / danger-full-access`（profile 预设，默认 `workspace-write`；`read-only→approval:ask`、`workspace-write→ask`、`danger-full-access→never`） | `.dsh\profiles\web\cordis.patch.yml:14-27`（本轮读到的活配置） | `ctx.sandboxPolicy` → 平台 fs 围栏 + `ctx.approval` |
| R2 | 平台围栏：`read-only` 全拒、`workspace-write` 只允许可写根内、`danger-full-access` 放行；拒绝抛 `FS_SANDBOX_DENIED` | `dsh-fs-sandbox/lib/index.js:153-166` | 只有 `super.*` 路径会走到 |
| R3 | 升权广告：`ctx.fs.sandboxMode !== undefined` 才给 `write/edit` 加 `sandbox_permissions`/`justification`；**判定发生在 `dsh-tool-fs` 的 apply 期一次** | `dsh-tool-fs/lib/index.js:1084-1087`、`:540/697`、`:1122-1143` | 模型可见 schema |
| R4 | 同回合升权提示 `[sandbox: …]` | `dsh-tool-fs/lib/index.js:1159-1163` | 只在 `FS_SANDBOX_DENIED` 时 |
| R5 | 暂存面接管：`stagingEnabled()` 为真 ⇒ `write/edit` 落暂存树 | `staging-fs.mjs:356-368, 470-486` | 工作区内 + 工作区外（默认） |
| R6 | `stageOutside`：只有显式 `'direct'` 才直通真实磁盘，**任何其它值（含历史 `'deny'`）都归一为 `'stage'`** | `staging-fs.mjs:151-156`；`fs-entry.mjs:36`（读 `WINSTAGE_STAGE_OUTSIDE`） | 工作区外写入 |
| R7 | 外部条目的键 = **规范化绝对路径**，物化在 `.dshstage/staged-ext/`，批准前真实磁盘一位不改 | `staging-fs.mjs:384-408`、`src/workspace.mjs:657-659` | 工作区外 |
| R8 | `.dshstage` 自遮蔽：工作区内 `.dshstage/**` **永不豁免**遮蔽（`maskOf`） | `src/workspace.mjs:214-222` | 读侧硬拒 + 批准侧二次确认 |
| R9 | 三档判级：`classifyChange()`（`sensitive` 优先 → `outside` → `normal`；`danger` 由 id 清单 + 自定义 `hard`） | `review-service.mjs:136-209` | 面板呈现 + 二次确认触发条件（`client.js:1422`） |
| R10 | file-observation-policy：未观察 → `write` 用 `createIfAbsent`（`FS_NOT_OBSERVED` 若已存在）、`edit` 用 `FS_NOT_OBSERVED`；已观察存在 → `{kind:'replaceIfVersion', version:vObserved}` | `dsh-fs-observation-policy/lib/index.js:67,90`、`README.md:74` | 所有 `ctx.fs` 变更 |
| R11 | 提供方版本守卫：`expected.version` 不匹配 → `FS_STALE_VERSION` | `staging-fs.mjs:497-504`（write）、`:543-545`（edit） | 暂存面 |
| R12 | 插件自己的基线守卫（#12.1）：真实文件 ≠ 候选冻结的 `before.hash` → `STALE_BASELINE` 拒绝落盘 | `src/workspace.mjs:1106-1117` | 批准落盘 |
| R13 | 插件的 `baseHash` 基线：`ensureEntry()` 幂等早退，**只在首次暂存 / rebase / 批准成功时更新** | `src/workspace.mjs:629-638, 1076-1089, 307-320` | 暂存条目 |
| R14 | C-8 配置漂移 fail-closed：`config.workspaceRoot` 与 `config.cwd` 都给出且不同 ⇒ throw | `staging-fs.mjs:211-224` | 装配 |
| R15 | 装配层：非 insert 的 `name` 是断言（失配 ⇒ 整条补丁+config 静默跳过）；覆盖层对 `config` 整体替换 | `cordis.patch.yml:36-41`；`cordis-plugin-include/lib/index.js:95-102`（经 `.t/dsh2/HOWTO-RESTART.md:44-63` 引用） | 装配 |
| R16 | 面板可写集合：只批**净 diff**；`frozenOnly` 行不可勾；高风险项需勾选且档位签名未变 | `review-service.mjs:503-513`；`client.js:506-531` | 面板 |
| R17 | 命令面开关：`isEnabled()` 现读 `config.enabled`；关时回 `DISABLED_TEXT`（kind:'error'，但见 C-1） | `host-plugin.mjs:224, 346, 394` | `/winstage*` |
| R18 | 暂存面开关：`stagingEnabled()` 现读 loader 行的 `config.enabled`；**读不到 ⇒ `true`** | `staging-fs.mjs:356-368` | `ctx.fs` 十一个入口 |

### 3.2 冲突对（谁赢、胜出点、用户的感受）

| 冲突对 | 冲突实质 | 胜出 | 胜出点 | 用户感受 |
|---|---|---|---|---|
| **R1/R2/R3/R4（平台审批+围栏） vs R5/R6（暂存）** | 两者都想决定"这次写入到底会发生什么" | **R5/R6**：`stagingEnabled()` 为真时 `super` 根本不调用 | `staging-fs.mjs:472, 520` | 平台"拒绝/升权/审批"三条对 `write/edit` **全部失效**；写入变成"进暂存 + 成功回执" |
| **R17（命令面读到 enabled=false） vs R18（暂存面仍读到 true）** | 同一个 `enabled` 被**两个真源**读：命令面读 `apply` 收到的 `config` 对象（`host-plugin.mjs:394`），暂存面读 loader 树的 `rootEntry.parent.data`（`staging-fs.mjs:360-364`） | **R18**（默认接管） | `staging-fs.mjs:361-367` 的三重 fail-open | 关掉开关后：面板卸载（`client.js:631-638`）+ 写入继续进暂存 + **零提示** ⇒ "规则互相打架" |
| **R10/R11（observation 版本） vs R13（插件基线）** | 两套"陈旧"判据，口径不同（provider 版本 vs 内容哈希基线） | 各自在自己那层赢 | 写：`staging-fs.mjs:499-501`；批准：`src/workspace.mjs:1111-1117` | 同一文件可能**先**被 `FS_STALE_VERSION` 挡住（假陈旧），**再**被 `STALE_BASELINE` 挡住（真陈旧），用户分不清 |
| **R11 的 version 命名空间** | 暂存命中报 `winstage:<sha>`，批准后（不再投影）报 `dev:ino:size:mtimeNs:ctimeNs` | **提供方**（字符串比较，必不相等） | `staging-fs.mjs:543-545` | 批准之后第一次 `edit` 假报 "file changed since it was read"（内容没变） |
| **R9（`classifyChange` 判级） vs R8（`maskOf` 执法）** | 面板是否弹二次确认按 R9，宿主是否真拦按 R8 | 执法按 R8，呈现按 R9 | `client.js:1422`（`Boolean(file.safety)`） vs `src/workspace.mjs:1008`（`this.maskOf(abs)`） | 会出现"弹了确认框但其实不需要确认"（工作区内命中内置 mask 但 `maskOf` 豁免）；反向（宿主拦、面板没弹）在现有装配里**不可达**（两者都只看内置 mask） |
| **R16（可写集合=净 diff） vs `pending`（= `files.length>0`）** | 面板显示的行数可以 > 能批准的行数 | **R16**：冻结行不可批 | `review-service.mjs:586-603`、`client.js:1524` | "有 5 项待审"但只有 4 项能勾；第 5 项**永远清不掉**（C-2） |
| **R19（暂存树自身的写入） vs R8** | 暂存对象写在 `.dshstage/**` 下，但那是 `src/store.mjs` 的裸 `node:fs`，不经 `ctx.fs`；而 agent 若通过 `ctx.fs` 写 `.dshstage/**`，它会被当作**普通工作区内条目**再暂存一层（`.dshstage/staged/.dshstage/…`） | 无守卫；两条路各走各的 | `src/store.mjs`（裸 fs）；`staging-fs.mjs:397-408` | `.dshstage` 的遮蔽只对"读"和"批准"生效，对"写入/暂存"不生效 ⇒ 自指路径没有专门的规则 |
| **R15（装配） vs R14（漂移守卫）** | 覆盖层整体替换 config ⇒ `workspaceRoot` 可能不存在 ⇒ R14 空转 | **R15** | `staging-fs.mjs:211-216` 第一项 `config.workspaceRoot !== undefined` | 两个暂存根的"结构性同源"退化成"两处手写字面值恰好相等"（当前相等，靠人守） |
| **R3（apply 期冻结） vs R17（调用期现读）** | 开关是"调用期现读"的，但 `dsh-tool-fs` 的升权广告是"apply 期一次"的 | **R3**（冻结） | `dsh-tool-fs/lib/index.js:1084-1086` | **重新打开开关也不会恢复升权广告**（除非重启/重挂 tool-fs）⇒ "关掉再打开"无法回到"没装插件"的等价状态 |

### 3.3 `stageOutside` 的"看起来是规则其实不是"（[引用]）

`staging-fs.mjs:151-156` 与 `fs-entry.mjs:19-20` 逐字：

```
 *   `stageOutside` **默认 `'stage'`**：工作区外的写入进暂存、等批准。只有显式传
 *   `'direct'` 才直通真实磁盘（旧值 `'deny'` 已随硬拒一起取消，任何非 `'direct'`
 *   的值都归一为 `'stage'`；旧的 `deny` 配置**不会**复活拒绝行为）。
```

⇒ 若外部有人按旧文档配 `WINSTAGE_STAGE_OUTSIDE=deny` 期望"拒绝越界写"，实际得到的是"静默进暂存"。这是一条**读起来像规则、实际已失效**的配置项，必须在文档里改掉或删掉。

---

## §4 复现处方（Q4）

三条处方都给了**两档**：(L1) 纯函数级，**本报告作者已跑过**，与线上无关、可立刻复算；(L2) 活实例级（3081；3080 绝对不许碰），留给 T4/T5 做端到端判定式。

脚本位置（**不在仓库内**，避免污染工作区）：`%TEMP%\winstage-exp\{exp1,exp2,exp3}.mjs`；跑法 `node %TEMP%\winstage-exp\expN.mjs`（Node 24，工作目录任意）。本轮全套离线测试：`.\autotest.cmd --skip-audit` ⇒ `PASS 14/14 套件、646 ok / 0 bad、exit 0`（报告 `.t\test-report.json`）。

### R-A（L1）"能产生待审条目，但批准后条目不消失、不落盘"（= C-3）

最小序列（exp1 E1 段，逐字可重建）：

1. 临时工作区建 `a.txt = "v0\n"`；`new Workspace({workspaceRoot, sessionId:'exp'}).init()`；
2. `ws.writeFile(a,'v1\n')` → 暂存；`ws.freezeCandidate()`；
3. **外部**把真实文件写成 `"vX\n"`（模拟用户/另一个进程/`pwsh`）；
4. `ws.writeFile(a,'v2\n')` → 同路径再次暂存；
5. `ws.freezeCandidate()`；`ws.applyCandidate(id,{})`（= `ReviewService.approve` 的底层调用）。

**期望观察**：`applied:['a.txt']`，真实文件 = `v2\n`，净 diff 归零。
**实际观察**（本轮原始输出）：

```json
"E1_step3": { "baseHashUnchangedSinceStep1": true, "stagedHashChangedFromStep1": true,
              "diffBeforeEqualsBaseHash": true, "realFileNowIs_vX": true },
"E1_step4_approve": { "applied": [], "failed":[{"path":"a.txt","code":"STALE_BASELINE"}],
                      "status":"pending", "realFileAfter":"vX\n",
                      "entryStillThere": true, "stillInNetDiff": 1 }
```

**判定式**：`realFileAfter !== 'v2\n'` ∧ `entryStillThere === true` ∧ `failed[0].code === 'STALE_BASELINE'` ⇒ R-A 成立。
（同一条在服务层：`ReviewService.approve()` → `{ok:false, approved:0, failed:[STALE_BASELINE], remaining:['b.txt']}`，`snapshot().counts.staleBaseline === 1`、`pending === true`。）

### R-A（L2）活实例版（3081）

1. 在 `.t\dsh2\ws` 放 `probeA.txt = "v0\n"`（用 `pwsh`，即**真实磁盘**）；
2. 用面板同款通路让 agent `write` 该文件为 `v1\n`（或直接调用 `ctx.fs.writeText` 的等价 RPC）→ 面板出现 1 条待审；
3. **在沙箱外用 `pwsh`** 把 `.t\dsh2\ws\probeA.txt` 改成 `vX\n`；
4. 读 `.t\dsh2\ws\.dshstage\sessions\<key>\review.json`（或共享根 `.dshstage\review.json`，看 `manifest.sessionId`）→ 记录 `pending/counts.net/counts.staleBaseline/generatedAt`；
5. 点面板「批准全部」（或发 `commands/execute` `/winstage approve "probeA.txt"`）。

**判定式**：`review.json` 的 `counts.net` 与 `generatedAt` 在批准前后**都不变**、真实文件仍是 `vX\n`、RPC 返回 `value.result.kind === 'error'` 且 text 含 `STALE_BASELINE` ⇒ R-A 在线上成立。

### R-B（L1）"可见的静默失败"（= C-1）

**期望**：失败路径有用户可见提示（面板 `[data-winstage-notice]` / `[data-winstage-row-error]`）。
**实际**：命令返回 `kind:'error'`，面板一个节点都不多。纯函数判定（exp1 E3 / exp2 C 段）：

```js
const ternary = "value && typeof value.kind === 'string' ? value.kind : 'success'"   // 从 client.js 原样切出
const kindOf = new Function('value', 'return ' + ternary)
// dsh-commands/lib/index.js:347-350 的真实信封
kindOf({ commandId: 'cmd-41f0b8d3-9', result: { kind: 'error', text: '…' } })   // => 'success'   ★ 静默
// 对照：平台自带 client 读 result.value.result.kind（dsh-client-ui-commands/lib/client.js:1042）=> 'error'
```

**判定式**：`kindOf(真实信封) !== 'error'` ⇒ R-B 成立（本轮 `silent_for_error: true`）。
**反证要求**（给 T5）：修好之后同一条断言必须变 `'error'`，且面板出现 `[data-winstage-notice]`。

### R-B（L2）活实例版（3081）

1. 重复 R-A 的 1–3 步，制造一条必然失败的批准；
2. 点击「批准全部」；
3. 立刻（`< 20s` 超时窗口内）检查 DOM：`document.querySelectorAll('[data-winstage-notice],[data-winstage-row-error]').length`；
4. 同时用 RPC 取 `/winstage approve` 的返回值。

**判定式**：`value.result.kind === 'error'` ∧ `DOM 命中数 === 0` ∧ `review.json` 未变 ⇒ 静默失败在真实浏览器上成立。
（注：`.t/dsh2/发现记录.md` 已记录过同类"面板不挂载/收起无反应"的静默路径，本轮新增的是**命令结果**这一条。）

### R-C（L1）"条目永久清不掉"（= C-2，**必现，无需竞态/夹具**）

完整脚本（exp3 的全部有效内容，可直接照抄运行；`import` 用绝对 `file://` URL）：

```js
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const ROOT = 'C:/Users/Administrator/Desktop/WinStageSandbox'
const { canonical } = await import(pathToFileURL(join(ROOT, 'src/paths.mjs')).href)
const { registerCommands } = await import(pathToFileURL(join(ROOT, 'dsh-plugin/host-plugin.mjs')).href)
const { ReviewService } = await import(pathToFileURL(join(ROOT, 'dsh-plugin/review-service.mjs')).href)

const wsRoot = mkdtempSync(join(canonical(tmpdir()), 'winstage-expc-'))
const a = join(wsRoot, 'A.txt'), b = join(wsRoot, 'B.txt')
writeFileSync(a, 'a0\n'); writeFileSync(b, 'b0\n')
const svc = new ReviewService({ workspaceRoot: wsRoot, sessionId: 'expc', log: () => {} })
svc.workspace.init()
svc.workspace.writeFile(a, 'a1\n', { origin: 'dsh-tool' })      // = ctx.fs.writeText
svc.workspace.writeFile(b, 'b1\n', { origin: 'dsh-tool' })
svc.afterMutation('dsh-write')

const captured = new Map()
registerCommands({ commands: { register: (d) => { captured.set(d.name, d); return () => {} } } }, () => svc,
                 { info(){}, warn(){}, error(){} })
const call = (n, rawInput) => captured.get(n).handler({ rawInput, agent: {}, attachments: [],
                                                        signal: new AbortController().signal, commandId: 'cmd-test' })

call('winstage-approve', '"A.txt"')                            // 部分批准 → partially-applied
svc.workspace.writeFile(b, 'b0\n', { origin: 'dsh-tool' })     // B 写回基线 → B 退出净 diff
svc.afterMutation('dsh-write')
console.log(JSON.stringify({ afterFreeze: svc.snapshot().counts, files: svc.snapshot().files.map(f => [f.path, f.frozenOnly, f.frozenReason]) }))
console.log(JSON.stringify({ rejectAll: call('winstage-reject', ''), stillPending: svc.snapshot().pending }))
console.log(JSON.stringify({ rejectNamed: call('winstage-reject', '"B.txt"'), stillPending: svc.snapshot().pending }))
console.log(JSON.stringify({ directService: svc.reject(undefined), pending: svc.snapshot().pending }))
rmSync(wsRoot, { recursive: true, force: true })
```

**本轮原始输出**（关键字段）：

```json
{"afterFreeze":{"files":1,"net":0,"frozenOnly":1},"files":[["B.txt",true,"no-net-change"]]}
{"rejectAll":{"kind":"success","text":"没有待审文件"},"stillPending":true}
{"rejectNamed":{"kind":"success","text":"没有待审文件"},"stillPending":true}
{"directService":{"rejected":0,"discarded":["cs_0001_b053c9e2"]},"pending":false}
```

**判定式**：`/winstage reject` 之后 `snapshot().pending === true` ∧ `counts.frozenOnly >= 1` ⇒ "消不掉"成立；而**绕过命令 handler** 直接调 `svc.reject(undefined)` 立刻 `pending === false` ⇒ 缺陷精确定位在 `host-plugin.mjs:307`。
**L2 版**：3081 上重复"批准 A → 把 B 写回基线"，然后点面板「拒绝全部」并观察 `review.json` 的 `pending/counts`；判定式同上。

### R-D（L1，可选）"关掉开关后仍然接管"的对照（= C-11）

`staging-fs.mjs` 的 `stagingEnabled()` 读 loader 树；纯函数级只能验证 `enabledOverride` 分支。要判定**线上**分支必须插桩：
1. 3081 上把 profile 覆盖层的 `winstage-sandbox.config.enabled` 改成 `false`（T1 的写范围）；
2. `pwsh` 侧在 `.t\dsh2\ws` 放一个文件 → 让 agent `write` 它；
3. 看 `.t\dsh2\ws\.dshstage\manifest.json` 是否新增 `external:false` 条目、真实磁盘是否变化。

**判定式**：真实磁盘**不变**（= 仍进暂存）∧ 配置为 `enabled:false` ⇒ C-11/C-4 在 3081 复现。
**插桩（判定"哪一条 fail-open"）**：在 `staging-fs.mjs:356-368` 的四个 return 前各加一行 `this.log('stagingEnabled:branch=N')`，重启 3081 后看 `logs/dsh2.out.log`。这条属于 T3 的写范围（改 `dsh-plugin/**`），我只读给出处方。

---

## §5 建议的最小修复点（按优先级；每条 = 文件:行 + 修法 + 回归风险）

> T3-fixer 的写范围是 `dsh-plugin/**`（+ `.t/dsh2/fix-asserts/**`、`.t/dsh2/fix-backup/**`）。下面**必须修**的 P0-1…P0-5 全部落在该范围内；P1-6/P1-7 也在；**没有任何一条需要改 `src/**` 或 `tests/**`**（超出写范围的项已明确标出，须 Lead 决策）。

### P0-1（必须修）`client.js:1370` 读错结果层级 ⇒ 面板永不显示命令错误（C-1）

**现状**（:1366-1376）：`const kind = value && typeof value.kind === 'string' ? value.kind : 'success'`
**修法**（保持现有字面断言可过，同时兼容两种形状）：

```js
.then((value) => {
  // RPC 的 value 是 CommandExecution = { commandId, result:{kind,text} }（dsh-commands/lib/index.js:347-350）；
  // 兼容直接返回裸 CommandResult 的调用方（自测/旧宿主）。
  const payload = value && typeof value === 'object' && value.result && typeof value.result === 'object'
    ? value.result
    : value
  const kind = payload && typeof payload.kind === 'string'
    ? payload.kind
    : (value === undefined ? 'error' : 'success')   // 命令名未解析 ⇒ execute() 返回 undefined ⇒ 必须报错
  if (kind !== 'success') {
    const text = (typeof payload?.text === 'string' && payload.text.length > 0)
      ? payload.text
      : (value === undefined ? t('unknownCommand') : t('commandNoOp'))
    showFailure(text, Array.isArray(targets) ? targets : undefined)
  }
})
```

配套：在 `dicts` 里给 `unknownCommand` 补中英两条（与 `commandNoOp` 同格式，`client.js:202-230` 一带）。
**回归风险**：
- `.t/approve-button-selftest.mjs:57` 断言的是字符串 `if (kind !== 'success')` 与 `showFailure(text, Array.isArray(targets)` ⇒ 上面**保留**了这两个字面，19/19 不变；
- `.t/failure-inline-selftest.mjs` 切的是 `#region failure-map`（`client.js:482-503`），不动；
- `.t/dsh2/browser/ui3/adversarial/{ui3-probes.mjs:330,_debug-buttons.mjs:73}` 的 stub 是 `{ok:true, value:{commandId, result:{kind:'success',…}}}` ⇒ 仍判 success；**新增**一条断言喂 `{commandId, result:{kind:'error', text:'X'}}`，要求 `showFailure` 被调用（见 P0-1b）。
**P0-1b（必须修，防复发）** `.t/approve-button-selftest.mjs:57` 的**字符串断言**换成**行为断言**：把 `act` 的 `.then` 回调体切成纯函数（或直接用 R-A/R-B 的表达式切片），喂真实信封，断言 `kind === 'error'`。**只在 `.t/**`，不在本任务写范围；已提请 T3/Lead 处理。**

### P0-2（必须修）`host-plugin.mjs:307` 早退挡住唯一的清理出口（C-2，"消不掉"）

**修法**（`reject` handler）：

```js
reject({ args, service }) {
  const ws = service.reload()
  const changes = ws.diffEntries()
  // ★ 不能因净 diff 为空就早退：队列里可能还有"仅存档/空壳"候选，
  //   而"拒绝全部"是用户唯一能清掉它们的出口（review-service.mjs:862-866 的既有契约）。
  const live = typeof ws.listReviews === 'function' ? ws.listReviews() : []
  if (changes.length === 0 && live.length === 0) return { kind: 'success', text: '没有待审文件' }
  const paths = args.length > 0 ? matchPaths(changes, args).map((c) => c.path) : undefined
  if (args.length > 0 && paths.length === 0) {
    return { kind: 'error', text: `没有匹配的待审路径：${args.join(' ')}（若它只是"仅存档行"，请用不带路径的 /winstage reject 清除）` }
  }
  const result = service.reject(paths)
  if (result.rejected === 0 && (result.discarded || []).length === 0) {
    return { kind: 'error', text: '没有任何条目被清掉：所选路径既不在净 diff、也没有对应的活候选。' }
  }
  const ended = (result.discarded || []).length
  return {
    kind: 'success',
    text: `已退回 ${result.rejected} 个文件：${result.paths.join(', ') || '（无净 diff 条目）'}${ended > 0 ? `；已终结 ${ended} 个候选` : ''}`,
  }
}
```

**回归风险**：
- `src/workspace.mjs:924-934` `listReviews()` 是公开方法，无副作用；净 diff 与队列都空时文案与旧版逐字一致（"没有待审文件"）⇒ 现有"无待审"断言不受影响；
- `result.discarded` 是 `ReviewService.reject()` 既有返回值（`review-service.mjs:888,893`），不需要改服务；
- 若某个套件（`f8`/`stage3-*` 里）断言"净 diff 空时 reject 返回 success"，需要改成断言"返回 error 且说明存档行"。**已列入 T3 的断言补强清单**。

### P0-3（必须修）`host-plugin.mjs:262` 批准在"只有存档行"时谎报成功（C-2 的另一半）

**现状**：`if (changes.length === 0) return { kind: 'success', text: '没有待审文件' }` —— 用户按下唯一的按钮，得到"成功 + 什么都没有"，而且这句话被 P0-1 吞掉。
**修法**：

```js
const ws = service.reload()
const changes = ws.diffEntries()
if (changes.length === 0) {
  const live = typeof ws.listReviews === 'function' ? ws.listReviews() : []
  const frozen = live.reduce((n, c) => n + (c.changes || []).length, 0)
  if (live.length > 0) {
    return { kind: 'error', text: `没有可批准的净变化：队列里还有 ${live.length} 份候选（共 ${frozen} 条冻结路径）已不在净 diff，属"仅存档、不可批准"。用 /winstage reject 清除它们。` }
  }
  return { kind: 'success', text: '没有待审文件' }
}
```

**回归风险**：`.t/approve-button-selftest.mjs:68` 的 stub 服务没有 `listReviews` ⇒ 上面的 `typeof` 守卫让它退回旧行为（stub 的 `reload().diffEntries()` 返回 1 条，本来就不会进这个分支）；`host-plugin.mjs:260-266` 的路径匹配逻辑不变。

### P0-4（必须修）开关是**两个真源**：命令面读 `config`、暂存面读 loader 树（C-4/C-11/C-17 冲突对）

**证据**：`host-plugin.mjs:394` `const isEnabled = () => config.enabled !== false`（读 apply 收到的 `config` 对象）；
`staging-fs.mjs:360-364` `(this.rootEntry ?? this.ctx?.fiber?.entry)?.parent?.data` → `row.config.enabled !== false`（读 loader 树的另一份副本）。

**修法（两步，第一步零测试改动）**

**4a — 单一真源（推荐先做，安全）**：新增 `dsh-plugin/switch-state.mjs`（与 `review-service.mjs` 的单例同机制：两个 loader 行 import 同一文件 ⇒ 同模块实例）：

```js
let reader = null
export function bindEnabled(fn) { reader = typeof fn === 'function' ? fn : null }
export function isBound() { return reader !== null }
export function stagingEnabledNow() {
  if (reader === null) return undefined            // 未绑定 ⇒ 调用方按历史行为
  try { return reader() !== false } catch { return undefined }
}
```

- `host-plugin.mjs:394` 之后加一行：`bindEnabled(isEnabled)`（import 自 `./switch-state.mjs`）；
- `staging-fs.mjs:356-368` 改成：`if (enabledOverride) …; const shared = stagingEnabledNow(); if (shared !== undefined) return shared;` 再走原来的树读。
- **回归风险**：所有 `.t` 自测都直接 import `staging-fs.mjs`、从不 `bindEnabled` ⇒ `shared === undefined` ⇒ 走原路径 ⇒ **行为逐字不变**（包括 `.t/toggle-selftest.mjs:162` 的"没有开关行 ⇒ 接管"）。生产上设置页写 `config.enabled` 的那个对象就是 host 行 `apply` 收到的 `config`（`host-plugin.mjs:385-394` 的注释声明 volatile 通道原地写回该对象）⇒ 开关成为**唯一真源**。

**4b — 行/配置读不到时 fail-closed（语义变更，须 Lead 拍板）**：把 `staging-fs.mjs:361-366` 的三处 `return true` 改成"有真 loader entry（`this.rootEntry` 存在）却找不到可读的行/配置 ⇒ `return false` + 一次 warn；离线（`rootEntry === undefined`）⇒ 保持 `true`"。
- **回归风险（已核过）**：会打破 `.t/toggle-selftest.mjs:162`（断言 `noRow ⇒ true`），并影响所有"构造了带 `parent.data` 但没有开关行"的假 ctx 断言；`.t/dsh2/fix-asserts/f2-c8-root-drift.mjs`、`f3-outside-default.mjs`、`stage3-store.mjs`、`.t/dsh2/probe/p2-outside.mjs` 等用的是**无 rootEntry**的构造 ⇒ 不受影响。**必须同步改 `.t/toggle-selftest.mjs:162` 的期望值并在报告里留痕**（这正是"行被静默移除 ⇒ 默认接管"这条历史决策的反转）。

### P0-5（必须修）面板按会话读、宿主按共享写 ⇒ 条目"看不见"（C-5）

**修法（最小、纯 client 侧）**：`client.js:586-607` `readReview()` 在会话路径读不到（`null`）时，**回落读同一个 workspaceRoot 的共享根** `.dshstage/review.json`，并在快照上校验 `workspaceRoot`（`client.js:656-660` 已有该校验）：

```js
const sessionPath = key ? joinPath(root, '.dshstage', 'sessions', key, 'review.json') : null
return readOne(sessionPath).then((snap) => (snap || !sessionPath ? snap : readOne(joinPath(root, '.dshstage', 'review.json'))))
```

**回归风险**：会重新引入"读到另一个会话/根的快照"的可能 ⇒ 必须保留 `sameRoot(snapshot.workspaceRoot, root)` 自校验（:656-660，已有），并且**只在会话路径 not-found 时**回落（不要用"空文件"触发）。`F2/C-7` 的跨根泄漏断言（`.t` 里的 `has('sameRoot')`、T4 §14 的 `F2 未复现`）依赖该校验，别把它删了。
**替代方案（Host 侧，更彻底但要 Lead 定）**：让 `staging-fs.sessionIdOf()` 在**拿不到身份且命令面已绑定会话**时拒绝写暂存（返回错误而不是落共享存储）；这会改变"agentless 调用与升级前一致"的既有契约，风险更高。

### P1-6（必须修，建议与 P0-1 同批）暂存 version 命名空间冲突 ⇒ 批准后第一次 edit 假报 `FS_STALE_VERSION`（C-9）

**现状**：`staging-fs.mjs:649-650/682-683` 命中投影时报 `winstage:${stagedHash}`；条目不再投影（刚批准、`baseHash===stagedHash`）时 `currentOf` 落到 `super.stat` ⇒ 报 `dev:ino:size:mtimeNs:ctimeNs`（`dsh-fs-local/lib/index.js:145-146`）。observation policy 会把上一次的 `winstage:…` 当 `expected.version` 传回（`:543-545` 比较）⇒ 必不相等。
**修法（最小、只碰暂存面）**：在 `staging-fs.mjs:635-668` `currentOf()` 的"非投影、但条目仍在且内容与真实文件一致"分支里，**优先报内容哈希版本**：

```js
// 已批准/无净变化，但真实内容 == entry.stagedHash ⇒ 内容未变，版本必须保持上次观察到的措辞
if (entry && entry.state !== STATE.DELETED && entry.stagedHash && entry.stagedHash !== hashAbsent()) {
  let realHash
  try { realHash = hashFile(abs) } catch { realHash = undefined }
  if (realHash === entry.stagedHash) {
    return { exists: true, kind: 'file', text: <读真实文本>, version: `winstage:${entry.stagedHash}` }
  }
}
```
（`hashFile` 从 `src/store.mjs` 引入；`abs` 就是 `place.abs`。）
**回归风险**：这条**只**在"内容相同"时放行，内容真变了仍走 `super.stat` 的版本 ⇒ `FS_STALE_VERSION` 的真实检测能力不减；但 `staging-fs-selftest.mjs`/`projection-selftest.mjs` 里若有断言"批准后 stat 的 version 来自 fs-local"需要更新期望值。**必须先加一条断言**："批准后同路径 write/edit 带 `expected.version='winstage:<stagedHash>'` **不得**抛 `FS_STALE_VERSION`"。

### P1-7（必须修）C-8 漂移守卫在"整体替换 config"的覆盖层上空转（C-10）

**现状**：`staging-fs.mjs:211-216` 首项 `config?.workspaceRoot !== undefined` ⇒ 覆盖层只重述 `cwd` 时守卫恒假。
**修法（二选一，均只改 `dsh-plugin/**`）**：
- (a) 让守卫**要求两个键都在**：`const hasBoth = String(config?.workspaceRoot ?? '').length > 0 && String(config?.cwd ?? '').length > 0; if (!hasBoth) throw（或 warn+fail-closed）`；
- (b) 让 fs 行不再依赖"两处手写同值"：`workspaceRoot` 缺省时**向 host 行取**（配合 4a 的 `switch-state.mjs`，把 host 行的 `workspaceRoot` 也绑进同一个共享模块），fs 行拿不到就 throw。
**回归风险**：(a) 会让"只写 `cwd`"的合法简化配置直接起不来 —— 这**正是想要的 fail-closed**，但必须同步 `.t/dsh2/home/profiles/*/cordis.patch.yml` 与 `.t` 里的装配测试；`.t/dsh2/fix-asserts/f2-c8-root-drift.mjs` 已经按"两键都给"设计 ⇒ 不冲突。

### P2（建议，需 Lead 决策）

| # | 位置 | 修法 | 回归风险 |
|---|---|---|---|
| P2-8 | `staging-fs.mjs:490-516`（writeText）/`537-554`（editText） | 写之前若 `!this.projectsEntry(entry)` 且真实内容 ≠ `entry.baseHash`（说明条目此前已批准、或外部改过），先 `ws.rebaseEntry(place.key)` 把基线重述为**真实当前内容**，再 `ws.writeFile` | **语义变更**：#12.1 的"外部改动不许静默覆盖"从"永远拒绝"变成"以现状为基线重新暂存 ⇒ 交给用户在面板上审"。这与文档 §7.8 的"不是缺陷"判定相反，**必须 Lead 拍板**；`src/**` 不动（`rebaseEntry` 是公开方法） |
| P2-9 | `client.js:1816-1822` | `run(line)` 改为 `Promise.resolve(...).then(v => { const p = v?.result ?? v; if (p?.kind !== 'success') console.warn('[winstage]', p?.text) })`，并把失败写进 `store.publish({notice:…})`（复用 P0-1 的读法） | 菜单里的按钮已有 `busy` 态，加提示不影响布局断言（`.t/permission-slot-selftest.mjs` 断言的是 `store.subscribe(sync)` 等字符串） |
| P2-10 | `client.js:1356`（`if (!executeCommand) return`）与 `:1349-1350`（`if (busy) return`） | 前者 `showFailure(t('commandNoOp'))`；后者保持静默但**不禁用按钮**（`disabled: busy` 已有） | 低 |
| P2-11 | `review-service.mjs:404-407/411-416/920-925/935-943` | 把"已忽略"的 catch 改成**计数 + 返回值**（例如 `reconcileCandidates` 返回 `{discarded, failures}`），让 handler 能把"清理失败"报成 `kind:'error'` | 低；只加返回值，不改现有行为 |
| P2-12 | `src/workspace.mjs:1140-1142`（**超出 T3 写范围**） | 批准落盘改走 `ctx.fs.writeText`（或至少走 `fs-local` 的 `withLock` + 发 `fs/observed`），让"批准"重新进入平台的可观测/围栏面 | 高：需要 `ReviewService` 拿到 `ctx`；会改变"批准不走暂存"这一结构事实。**仅提交 Lead 评估** |
| P2-13 | `staging-fs.mjs:28-30`、`fs-entry.mjs:19-20`、`provider.mjs`/`selfcheck.mjs` | 文档与死代码：把 `provider.mjs`/`selfcheck.mjs` 标注为"未接入的适配层/自检"，或明确接入 `ctx.provide('sandbox', …)`（后者是功能，不是修 bug） | 无 |
| P2-14 | `dsh-plugin/cordis.patch.yml:34` 注释、`README`/docs | 删掉/改写 `stageOutside: 'deny'` 的历史说法（**任何非 `direct` 都是 `stage`**）；修正 `docs/dsh2-需求与验收.md:323` 引用的行号（`502-508` → `629-638`） | 无（纯文档） |
| P2-15 | `review-service.mjs:1076-1093` + `host-plugin.mjs:411-421` | 共享存储条目并回会话存储的**触发点**从"写/命令"扩展到"面板轮询"（Host 侧加一个 `/winstage absorb` 或让 `snapshot()` 先 `absorbSharedStore()`） | 中：`snapshot()` 会写盘（违反它自己"纯读"的注释 `:500-501`），需 Lead 定 |

### 修复顺序建议（给 T3）

1. **P0-1 + P0-3**（一次改完 `client.js` 的错误显示 + `host-plugin.mjs` 的两个"没有待审文件"分支），并补一条喂真实信封的断言；
2. **P0-2**（`reject` 早退）—— 这是"消不掉"的**唯一必现根因**，改完必须用 §4 R-C 的脚本回归（期望：`/winstage reject` 后 `pending === false`）；
3. **P0-4a + P1-7**（单一开关真源 + C-8 守卫），然后用 §4 R-D 在 3081 上验证"关掉开关 ⇒ 真实磁盘立刻可写、`.dshstage` 不再新增条目"；
4. **P1-6**（version 命名空间），用一条新断言锁住"批准后同路径写不抛假 `FS_STALE_VERSION`"；
5. **P0-5**（面板回落共享根）作为可见性兜底；
6. P2 各项按 Lead 决策排期。

---

## §6 证据索引与复算方法

| 证据 | 位置 | 判定 |
|---|---|---|
| 离线全套测试 | `.\autotest.cmd --skip-audit` → `PASS 14/14 套件、646 ok / 0 bad、exit 0`；报告 `.t\test-report.json` | [实测] |
| exp1（`ensureEntry`/baseHash/STALE_BASELINE/ReviewService 全链路/kind 表达式/两套 version） | `%TEMP%\winstage-exp\exp1.mjs`（不在仓库） | [实测] |
| exp2（命令面 handler 真实返回值、D1 冻结行、信封→client 读法） | `%TEMP%\winstage-exp\exp2.mjs` | [实测] |
| exp3（"消不掉"最小构造，R-C） | `%TEMP%\winstage-exp\exp3.mjs`（全文已在 §4） | [实测] |
| 活 3080 的 profile 开关 | `C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml:28-32`（`enabled:false`，mtime 18:29:48）；`package.json:14`（bundle 已挂） | [实测] |
| 活 3080 的暂存落点 | `.dshstage/manifest.json`（`sessionId:"dsh-host"`、`revision:25`、`exp1.mjs` 条目 `external:true`）；`.dshstage/review.json`（`pending:true`、`counts:{files:5,net:5}`）；`.dshstage/queue.json`（12 候选） | [实测] |
| 本会话 `write` 回执 vs 真实磁盘 | `pwsh Test-Path` = False；对象在 `.dshstage/staged-ext/a9/a9f5eed0a13d3bc9/exp1.mjs` | [实测] |
| 命令返回形状（宿主） | `dsh-commands/lib/index.js:340-351`、`lib/typert.remote-client.js:20-30` | [引用] |
| 命令返回形状（平台 client 的读法） | `dsh-client-ui-commands/lib/client.js:1041-1045` | [引用] |
| 命令返回形状（项目自己的实测） | `.t/dsh2/T4-browser-report.md:1013-1016`、`docs/dsh2-发现记录.md:749-750` | [实测/引用] |
| 升权广告与围栏 | `dsh-tool-fs/lib/index.js:1084-1087,540,697,1122-1143,1159-1163`；`dsh-fs-sandbox/lib/index.js:103-113,153-166` | [引用] |
| observation policy 语义 | `dsh-fs-observation-policy/README.md:74,109`、`lib/index.js:67,90` | [引用] |
| fs-local version 构成 | `dsh-fs-local/lib/index.js:145-146` | [引用] |
| 装配两条静默失效 | `.t/dsh2/HOWTO-RESTART.md:44-63`；`cordis-plugin-include/lib/index.js:95-102` | [引用] |

**本轮对仓库的唯一副作用（如实披露）**：
1. 本报告是本任务唯一写入的仓库文件（`docs/dsh2-冲突诊断-插件侧.md`，用 `pwsh` 写真实磁盘）；
2. 运行 `.\autotest.cmd` 会刷新 `.t\test-report.json`（测试套件自身的既定输出）；
3. **我的一次 `write` 工具调用（写 `%TEMP%\winstage-exp\exp1.mjs`）在 3080 的共享暂存队列里留下了一条待审条目**（`.dshstage/review.json` 的 5 条之一，`external:true`）。它由 C-6 的机制造成，**不是我有意的仓库改动**；如需清理，请在面板/命令面用 `/winstage reject`（注意：这条正好会撞上 C-1/C-2，建议在 P0-1/P0-2 修好后清）。T2a 未删除任何清单条目、未起停任何进程、未改 `C:\Users\Administrator\.dsh` 的任何文件。

---

# §7 追加：Lead Q-A…Q-E 的插件侧判定（含外部独立复现）

> 阅读约定：本附录是对 §1–§5 的**增补**，不是另起一套结论。对应关系：
> §7.1(Q-A) → 增补 §1.4/§3.2 的"两个真源"冲突对 + §5 新增 **P0-6**；§7.2(Q-B) → 增补 §2.3 + §5；§7.3(Q-C) → 与 §2.5/§2.6 合并；§7.4(Q-D) → 增补 §1.1/§5 的 P1-6 决策；§7.5(Q-E) → **新增**，并给出 §5 新增 **P0-8**；§7.6 → **应并读为 §2 的外部独立复现**；§7.7 → R8 归属与 §5 新增 **P0-7**。

## §7.1 Q-A｜开关悖论：`enabled:false` 为什么还接管（判定：**patch 文件本身是对的，运行中的树与文件不同步**）

### 结论（先给判定）

| 候选机制 | 判定 | 依据 |
|---|---|---|
| M1 读不到该行 / `id` 不匹配（例如行 id 变成 `include:winstage-sandbox`） | **否** | `cordis_inspect_query(host, Config, listConfigs)` `[实测]` 返回的 entry id 是 `include:winstage-sandbox`，但那是**树路径**（`EntryTree.sep = ":"`，`cordis-plugin-loader/lib/index.js:127,167-179`）；`parent.data` 里放的是**patch 行**，其 `id` 就是 `winstage-sandbox` |
| M2 patch 失配 / config 整体替换把 `enabled` 弄丢 | **否**（已用平台自己的 `applyEntryPatches` 复算） | 见下"离线复算"：两份真实文件组合出的 `config.enabled === false`，且**没有** `entry winstage-sandbox not found` 告警 |
| M3 `stagingEnabled()` 读的是**运行中的 loader 树**，而它没有被 18:29 的文件改动重新组合 | **高度成立（首选）** | 活证据：18:29:48 文件写 `false`，18:40–18:43 写入仍进暂存；且 `schema.js:68` 把 `enabled` 声明为 **volatile**，项目自己的契约注释（`host-plugin.mjs:386-394`）明说 volatile 写的语义是"**不改挂载行**、把新值原地写回 `apply` 收到的 config 对象" |
| M4 完全没有被调用 | 否 | 我的 `write` 被暂存（`manifest.json` 里 `external:true` 的条目）就是 `stagingEnabled()===true` 的直接后果 |

### 离线复算（M2 的排除，[实测]）

用平台自身的补丁算法（`cordis-plugin-include.applyEntryPatches`，`lib/index.js:56-105`）对**两份真实文件**组合：

```
bundle  : dsh-plugin/cordis.patch.yml           （2 行：disable fs-sandbox + insert 两行）
profile : C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml （含 - id: winstage-sandbox, config.enabled:false）
warns   : ["patch: entry ui-settings-general not found", "patch: entry agent-default-model not found",
           "patch: entry permission not found"]         ← 没有任何 winstage 相关告警
composedWinstageRow.config = { "enabled": false, "workspaceRoot": "…\\WinStageSandbox", "probeOnStart": true }
effectiveEnabled                                  = false
nameAssertionMatches                              = true
// 对照（prepareProfileEntries 风格：对空列表应用全部 patch）：
effectiveEnabledFromEmpty                         = false
composedFsSandbox.disabled                        = true
```

⇒ **文件层是自洽的**：`winstage-sandbox` 行被 profile 覆盖成 `enabled:false`，`fs-sandbox` 被 disabled，行名断言匹配。**所以问题不在"读不到"，而在"读的是哪一份"。**

### 机制（两个真源 + volatile 契约互相矛盾）

- 命令面读的是 **apply 时收到的 `config` 对象**：`host-plugin.mjs:394` `const isEnabled = () => config.enabled !== false`；
- 暂存面读的是 **loader 树的行**：`staging-fs.mjs:360-364` `(this.rootEntry ?? this.ctx?.fiber?.entry)?.parent?.data` → `row.config.enabled !== false`；
- 两者只在"`EntryGroup.update()` 真的重跑了"时才同步（`staging-fs.mjs:346-352` 的注释就是这么假设的）；
- 但 `enabled` 是 **volatile**（`schema.js:68` `meta: { volatile: true, … }`）。`host-plugin.mjs:386-392` 逐字声明：

```
* `enabled` 在 `schema.js` 里是 volatile 字段，设置页改它**不会重挂本行**
* （loader 的 volatile 通道把新值原地写回 apply 收到的这个 config 对象）。
```

⇒ **"volatile 不重挂行"是设计；"parent.data 会被换成新的一份"是暂存面的假设。二者互斥。** 活实例的观测（文件 false / 暂存继续）恰好落在"命令面看到 false、暂存面仍看到 true"那一格。这是 §1.4/§3.2 里"两个真源"冲突对的**代码级闭环**。

### 独立缺陷（同一现象的第二条根因，[实测]）：Config 投影本身被平台拒绝

`cordis_inspect_query(host, Config, listConfigs, {entry:"include:winstage-sandbox"})` **直接报错**：

```
Error: config/enabled: volatile fields require a fixed object path without an enclosing volatile field
```

离线复算（exp5 末段，用平台导出物 `dsh-app-boot.createConfigProjector`）：

```
isNative                      = true
currentProjection             = { ok:false, error:"config/enabled: volatile fields require a fixed object path without an enclosing volatile field" }
rootMeta                      = { "default": {}, "volatile": true }        ← 根
childMeta                     = { "volatile": true, "default": true, … }   ← 字段
fixedProjection（仅把根的 volatile 去掉）= { ok:true, keys:["schema","definitions","acceptsMissing","limitations"] }
```

出处：`dsh-app-boot/lib/index.js:2320-2332` `validateVolatilePlacement()`（`:2326` 抛）+ `:2349-2350` 在 `createConfigProjector()` 的第一步调用；同一段校验被**打包进客户端**（`dsh-client-connection/lib/client.js:505`、`dsh-client-ui-settings/lib/client.js:507`、`dsh-client-locale/lib/client.js:524` 等 10+ 处，错误文案逐字相同）。
⇒ **结论**：`schema.js` 的"根 + 字段都标 volatile"写法（`schema.js:68,127`）**违反平台契约**；该命名空间的表单**无法被投影**。这既是"开关点不动"的一条独立根因，也很可能就是 `client.js:644` `root === ''` ⇒ 面板永不出现（docs 发现记录里的"第四条静默不出现的路径"）的上游。
[未实测]：3080 上 `configForms.get('winstage-sandbox').getSnapshot()` 的确切 `status`（`unavailable` / 空 value）——用既有诊断开关即可判定：先带 `?token=` 装 cookie，再单独导航 `http://127.0.0.1:3081/?winstageDebug=1`，读 `window.__winstageLogs` 的 `containsMine` / `myFormStatus`（方法见 `docs/dsh2-发现记录.md:660-673`）。

### 判别式与最小复现（Q-A）

**判别式（插件侧可观测）**：在一次 `ctx.fs` 写入之后，`.dshstage/manifest.json` 是否新增了 `external:false` 的条目。
- 文件 `enabled:false` **且** 新条目出现 ⇒ M3 成立（运行中的树仍是 true）；
- 文件 `enabled:false` **且** 真实磁盘被直接写入 ⇒ 开关生效。

**最小复现（3081，T1-rig 的 task-1b 正好覆盖）**：
1. 覆盖层写 `enabled:false` → **不重启**，让 agent 写 `.t\dsh2\ws\a.txt`：若 `.dshstage/manifest.json` 新增条目 ⇒ M3；
2. 重启 3081（`run-dsh2.mjs` 会重新组合）后再写同一文件：若这次写真实磁盘 ⇒ 结论确凿（= 热组合缺口），若仍进暂存 ⇒ 需要插桩；
3. 插桩（属 T3 写范围）：在 `staging-fs.mjs:361-366` 每个 `return` 前打一行 `this.log('stagingEnabled:branch=…')`，并**同时**打印 `row?.config?.enabled` 与 `data.length`；再在 `host-plugin.mjs:397` 后加一行把 `isEnabled()` 的结果写日志。两个来源的值不同即闭环。

## §7.2 Q-B｜可清除性、增长与"reject 会不会动真实文件"

### （1）`/winstage reject` / 面板拒绝对真实文件**是安全的**（[实测]，逐情形）

| 情形 | 结果 |
|---|---|
| 工作区内 `modify`（真实文件 `REAL-ORIGINAL`，暂存 `STAGED-NEW`） | `reject` 后真实文件仍 `REAL-ORIGINAL`、仍存在；暂存对象被回收 |
| 工作区外条目（键=绝对路径，真实文件由外部创建为 `REAL-EXTERNAL`） | `reject` 后真实文件仍 `REAL-EXTERNAL`；暂存对象在 `.dshstage\staged-ext\c0\c0e6738d61102c8f\ext.txt`，被回收 |
| `create` 条目（真实磁盘不存在） | `reject` 后真实磁盘仍不存在 |
| 墓碑（`baseHash=absent`，删除一个从未存在的对象） | `reject` 不删任何东西；该路径**不在净 diff** 里，服务层 `targets` 为空（命令面还会因 §5 P0-2 的早退提前返回） |

代码依据：`review-service.mjs:931-947` `revert()` 只做两件事 —— 删清单条目 + `rmSync(ws.staged(rel))`；而 `src/store.mjs:318-324` 对**两种键**都把物化对象放在 `.dshstage` 下（相对键 `staged/<rel>`、绝对键 `staged-ext/<分桶>/<哈希16>/<basename>`）⇒ **`revert` 的删除目标永远在暂存树内**。
⇒ **对 Lead 的直接影响：`/winstage reject` 不会删/回退 `docs/dsh2-审批冲突-需求与验收.md` 或任何真实文件。**真正会动真实文件的是 **approve**：`applyOneChange` 的 `delete` 分支会 `rmSync(abs)`（`src/workspace.mjs:1119-1132`）、其他分支会 `writeFileAtomic(abs, …)`（`:1140-1142`）。所以"不要 approve 报告文件"是对的，"reject 危险"不成立。
（已在 §4 R-A/R-C 与本节双重验证；`reject` 唯一副作用是删清单条目 + 回收 `.dshstage` 内的对象 + 终结候选。）

### （2）`superseded` / `discarded` 条目**没有任何清除路径**，会无界增长（[实测]）

一次 6 次连续写入的实验：

```
写入 6 次后：.dshstage/candidates/*.json = 6 个；queue.order = 6；
             状态 = [superseded×5, pending×1]
再 reject 一条后：candidates = 7 个；queue.order = 7；queue.discarded = 1
ws.listReviews()（= frozenOnlyRows / reconcileCandidates 的遍历域）= 1
孤立候选文件数 = 7 − 1 = 6
```

- `review-service.mjs:503-546`（`frozenOnlyRows`）与 `:909-928`（`reconcileCandidates`）都**只遍历 `ws.listReviews()`**，而 `listReviews()` 只返回 `PENDING / PARTIALLY_APPLIED / STALE`（`src/workspace.mjs:924-934`）⇒ `superseded`/`discarded` 的候选**永远不会被对账、也永远不会被删除**；
- `store.saveCandidate()` 只在**没有**删除逻辑：`.dshstage/candidates/<id>.json` 只增不减；`queue.json` 的 `order` / `candidates` / `discarded` 只增不减；
- 活 3080 的实测比例：**21 分钟 12 个候选**（`.dshstage/queue.json`，10 superseded + 1 discarded + 1 pending），其中 5 条冻结路径里 15 条被 superseded 候选冻结过 ⇒ 与"每次写入换一份候选"的节奏吻合（`review-service.mjs:428-437` 的 `ensureCandidate` 在净 diff 变化时重新冻结）。

**判定**：`review.json` 是有界的（每次 `publish()` 重写，`maxFiles:40`、`maxLinesPerFile:60`，`review-service.mjs:258-265`），但 **`queue.json` 与 `.dshstage/candidates/` 无界增长**，且**孤儿候选是永久留档**。这与 T2b 报告的核侧缺陷**同形**（`approval/asked` 缺 `decided`、没有任何补全路径 ⇒ 永久留档、重放正常、零报错）：插件的候选状态机同样**没有"终结态回收"**，只是它把孤儿写进了自己的 JSON，而不是会话日志。
⇒ 新增修复建议 **P1-16**（见 §7.8）。

## §7.3 Q-C｜"失败必须响"：调用链上全部静默分支 + 最小修法 + 浏览器断言

（与 §2.2/§2.5/§2.6 同一清单，这里按"批准/拒绝/清除"三条链重新归并，并给出修法与断言。）

| # | 分支 | 位置 | 现状 | 最小修法（二选一） | 浏览器断言"响了" |
|---|---|---|---|---|---|
| S1 | 命令结果读错层级 | `client.js:1370` | `kind` 恒 `'success'` ⇒ **一切**命令错误不可见 | §5 **P0-1**（读 `value.result.kind`，`undefined` 亦算 error） | 点「批准」后 `document.querySelectorAll('[data-winstage-notice],[data-winstage-row-error]').length > 0` |
| S2 | 没有会话身份 | `client.js:1351-1355` | 有 `showFailure(t('noSession'))`（**好的**） | 保持 | 同上（文案含 `noSession`） |
| S3 | `executeCommand` 未注入 | `client.js:1356` | **静默 return** | `showFailure(t('commandNoOp'))` | 同上 |
| S4 | `busy` 并发点击 | `client.js:1349-1350` | 静默丢弃 | 按钮已 `disabled: busy`；保持 | — |
| S5 | 访问模式菜单的 run() | `client.js:1816-1822` | `.catch(() => {})` 且**从不读 kind** | 复用 S1 的读法 + `store.publish({notice})`（§5 P2-9） | 点菜单「重新对齐」后 notice 出现 |
| S6 | 关闭开关失败 | `client.js:1882` | `.catch(() => {})` | 复用 `WinStageRow` 的 `setFailed(true)` | 行内出现 `t('error')` |
| S7 | 轮询异常 | `client.js:694-695` | 写进 `store.error` 但**组件不渲染它** | 在 `WinStageReview` 里渲染 `state.error`（与 `notice` 同一行） | `[data-winstage-notice]` 含错误 |
| S8 | `reject` 早退 | `host-plugin.mjs:307` | `{kind:'success','没有待审文件'}`，**且服务层清理分支不可达** | §5 **P0-2** | 点「拒绝全部」后 `review.json` 的 `pending ⇐ false`（DOM 侧面板消失） |
| S9 | `approve` 只有存档行 | `host-plugin.mjs:262` | 同上谎报 success | §5 **P0-3** | 同上 + notice 文本含"仅存档" |
| S10 | "0 应用 0 失败" | `host-plugin.mjs:286-290` | 已是 `kind:'error'`（**好**），但被 S1 吞掉 | 无需改；S1 修好即显形 | notice 文本含"没有条目被应用" |
| S11 | `absorbSharedStore` 失败 | `review-service.mjs:404-407` | 只 `this.log(...)`（= `log.info`） | 改成 `log.warn` + 计数（可在 `/winstage status` 输出） | `/winstage status` 文本含"并入失败" |
| S12 | `afterMutation` 冻结候选失败 | `review-service.mjs:411-416` | 吞掉（"暂存内容仍在"） | 同上；并让 `approve` 结果带 `warnings` | `/winstage approve` 文本含警告 |
| S13 | `reconcileCandidates` 丢弃失败 | `review-service.mjs:920-925` | 吞掉 —— **正好是清除路径** | 返回 `failures`，handler 报 error | 同 S8 |
| S14 | `revert` 回收对象失败 | `review-service.mjs:935-943` | 只记日志 | 同上 | 同 S8 |
| S15 | 命令注册失败 | `host-plugin.mjs:428-436` | `logger.error` + `warn`（**好的**，但 UI 不可见） | 在 `WinStageRow` 上显示"命令面不可用"（读 `commands/list`） | 设置行出现错误文案 |
| S16 | `normalizeDefinition()` 抛错 | `host-plugin.mjs:337-343` 注释 | 会杀掉整个 `ctx.inject(['commands'])` 回调 ⇒ 线上 0 命令（现被 S15 兜住） | 保持 try/catch | `commands/list` 出现 12 条 |

**浏览器断言方法（统一）**：`?winstageDebug=1` 的诊断块（`client.js:2059-2094`）给出 `containsMine / myFormStatus / review.status / review.error / counts`；DOM 侧用**精确名**判面板存在（`data-winstage-panel`、`data-winstage-notice`、`data-winstage-row-error`），**不要用子串匹配面板文案**（`.t/dsh2/发现记录.md:765-770` 的假阳性教训）。

## §7.4 Q-D｜`sandboxMode` 返回 `undefined` 有没有插件侧的安全替代？

**先明确现状（§1.1 C-7 + T2b 的三条门控）**：`staging-fs.mjs:377-380` 在接管时返回 `undefined` ⇒ `dsh-tool-fs/lib/index.js:1084-1087` 在 **apply 期**定下 `escalationModes=[]`、`policy=undefined` ⇒ ① `sandbox_permissions/justification` 从 `write/edit` schema 消失；② `SandboxExecutionPolicy.sessionId`（官方唯一权威身份）断链；③ `str-replace-editor` 的围栏一起消失。

| 方案 | 可行性 | 收益 | 回归风险 | 判定 |
|---|---|---|---|---|
| D-1 直接 `return super.sandboxMode`（= workspace-write） | 技术可行（一行） | 恢复升权广告、恢复 `policy`（⇒ `sessionId` 有了来源，C-5 直接缓解） | **严重**：模型会看到 `sandbox_permissions` 并可能申请 `danger-full-access`，`approveEscalation` → 用户审批 → 批准后**该次调用仍然进暂存**（`staging-fs.mjs:472`）⇒ 升权语义是假的；`mapError` 的 `[sandbox: …]` 提示也在"其实没被拦"的情况下产生误导；且 `FsSandboxController` 是 apply 期构造 ⇒ **改完必须重启**；`write/edit` schema 变化会打到断言 schema 形状的套件 | **不推荐**（除非同时让暂存面在收到升权 policy 时 `super` 直通 —— 那就是把两套语义合成一套，属架构决策） |
| D-2 只借 `policy` 不要广告：让 `sessionIdOf()` 从 `ctx.sandboxPolicy` 取身份 | 受限 | 恢复会话隔离 | `SandboxedFileSystem.inject = ['sandboxPolicy']`（`dsh-fs-sandbox:104`）⇒ fs 行的 ctx **有** `sandboxPolicy`；但 `resolve()` 不带 session 时拿不到 per-session `sessionId`（权威身份来自 `dsh-tool-fs` 的 `resolvePolicy`，而它返回 `undefined`）⇒ **拿不到**，除非 fs 行自己能拿到当前 agent | **不可行（当前信息）** |
| D-3 读侧统一（**推荐**）：不动 `sandboxMode`，把"宿主写到哪里"与"面板读哪里"对齐 | 高（纯插件侧） | 直接消除"条目看不见/消不掉"的可见性那一半 | 见 §5 P0-5 的回归风险（必须保留 `sameRoot` 自校验、只在 not-found 时回落）；根治版是 P2-15（让 `snapshot()` 先 `absorbSharedStore()`），但要接受 `snapshot()` 写盘 | **推荐** |
| D-4 单一开关真源（`switch-state.mjs`，§5 P0-4a） | 高 | 顺带让"关掉开关 ⇒ 命令面与暂存面同时换面"可验证 | 低（未 `bindEnabled` 的自测行为不变） | **必做** |
| D-5 若一定要恢复升权广告：加一个显式开关（默认关）并在广告时同步声明"本 composition 的变更进暂存" | 中 | 诚实且可回滚 | 需要 Lead 决策 + 重启验证 | **建议由 Lead 决策**，不要在 T3 里默认开启 |

**一句话**：`sandboxMode=undefined` 是**正确**的（暂存面确实不围栏），坏的是它被 apply 期冻结、以及身份随之断链；插件侧能安全做的是 **D-3 + D-4**，**不要**透传 `super.sandboxMode`。

## §7.5 Q-E｜`.dshstage/**` 是否被排除在暂存之外？（判定：**(b)+(c)：完全没有"前缀排除"，只有"部分防护"**）

### （1）全仓"跳过/忽略某路径前缀"的逻辑清单（只有这些）

| 位置 | 判据 | 是否排除 `.dshstage` |
|---|---|---|
| `dsh-plugin/staging-fs.mjs:397-408` `keyOf()` | `relative(root, abs)`；`''`=根（写根报错）、`..`/绝对=external | **不排除**：`.dshstage\review.json` 落在工作区内 ⇒ 普通相对键 |
| `staging-fs.mjs:470-486`（writeText）/`:519-533`（editText） | 只判 `stagingEnabled()`、`inConfiguredWorkspace()`、`place.key === ''`、`external && stageOutside==='direct'` | **不排除** |
| `src/workspace.mjs:629-663` `ensureEntry()` | 只判"已存在条目幂等早退" | 不排除 |
| `src/workspace.mjs:672-694` `writeFile()` | 只拒绝 `rel === ''`；`if (!external) synthesizeParents(rel)` | 不排除 |
| `src/workspace.mjs:787-789` `synthesizeParents()` | 只对 **external** 键跳过 | 不排除（`.dshstage` 内还会被合成父目录） |
| `src/store.mjs:318-324` `stagedPath()` | 相对键 → `<store>/staged/<rel>`；绝对键 → `staged-ext/…` | 不排除（反而把元数据**复制**进 `staged/.dshstage/…`） |
| `src/store.mjs:139-159` `makeRemovable()` | 只跳过符号链接（不跟随） | 不排除 |
| `src/paths.mjs:199` `{ id:'stage-store', pattern:/\\.dshstage\\/i, hard:true }` | **遮蔽表**（读/批准侧的防护） | **这是唯一的 `.dshstage` 特殊处理** |
| `src/workspace.mjs:214-222` `maskOf()`、`:225-235` `assertReadable()`、`:368-374/:390-398` `exists()` | 用上面的遮蔽表判"不可见/不可读" | 只在 **`Workspace.readFile/readText`、`exists()`、`listDir()`** 里生效 |
| `dsh-plugin/staging-fs.mjs`（全文 835 行） | `maskOf`/`assertReadable`/`Workspace.readFile` **出现 0 次**（grep 复核） | ⇒ **`ctx.fs` 的读路径根本不走遮蔽** |
| `src/workspace.mjs:1006-1041` `applyCandidate()` | `this.maskOf(abs)` ⇒ 工作区内命中遮蔽 ⇒ 需 `confirmedMasks` 才落盘 | **批准侧**是唯一真拦的地方（且只是"二次确认"，不是禁止） |

### （2）三种可能的判定

- **(a) "被排除 ⇒ ctx.fs 写入直改真实元数据"：不成立。** `ctx.fs` 写 `.dshstage/review.json` 不会落到真实文件（见下 exp 输出：`realFileContentAfterStage` 仍是旧值）。
- **(b) "未排除 ⇒ 生成自指候选"：成立，且我自己复现了完整打结。** 见 §7.5(3)。
- **(c) "部分排除"：成立但方向相反** —— 不是按文件排除，而是**按"读/批准"加防护、按"写"不设防**：`review.json`/`queue.json`/`manifest.json`/`blobs/**` 全都可以被 `ctx.fs` 写进暂存并成为候选；只有**被读到时**（`Workspace` 路径）会被 `SANDBOX_PATH_MASKED` 挡住、**被批准时**需要二次确认。
- **追加 [实测]（本节最有用的负面结论）**：`ctx.fs` 的**读**也没有遮蔽。本轮我用 `read` 工具直接读 `<repo>\.dshstage\manifest.json`，**成功返回内容**（`revision: 57`、`sessionId: "dsh-host"`），没有任何 `SANDBOX_PATH_MASKED`。⇒ "`.dshstage` 自身存储不可读"这条防护**只对插件自己的 CLI 路径成立**，对 agent 的 `read` 工具不成立。

### （3）自指条目：从写入到"永远批不掉"的完整链路（[实测]，exp5）

```
# 1) 通过 Workspace.writeFile（= staging-fs.writeText 的同一条入口）写 .dshstage/review.json
writeReturned.path        = ".dshstage\\review.json"
diffEntries               = [ { path: ".dshstage\\review.json", op: "modify" } ]     ← 成为正常暂存条目
stagedObjectPath          = <store>\\staged\\.dshstage\\review.json   （exists = true）
realFileContentAfterStage = '{"real":"OLD"}'    ← 真实元数据**没有被改**（⇒ 不是 (a)）
verifyProjection()        = []                  ← 清单没有损坏（合成父目录 ".dshstage" 也入了清单）
maskOf(该文件)            = { id: "stage-store", hard: true }
Workspace.readText(该文件) = THROW:SANDBOX_PATH_MASKED          ← 遮蔽只在这里
# 2) 走 ReviewService（afterMutation → publish() 会重写真实 review.json）
snapshotBefore            = { files:1, net:1, staleBaseline:0 }
approve(未确认)           = failed:[SANDBOX_PATH_MASKED_CONFIRM (hard:true)]
snapshotAfter             = { files:1, net:1, staleBaseline:1 }  ← **条目出生即 stale**
row                       = { path:".dshstage\\review.json", risk:"sensitive", safety:"danger", baselineStale:true }
approve(confirmedMasks)   = failed:[STALE_BASELINE]              ← **确认了也批不掉**
realReviewAfter           = {"version":1,"generatedAt":"2026-09-29T10:50:23.477Z",…   ← 正是 publish() 刚写的
pendingAfterAll           = true                                  ← 面板永远有条目
reject([该路径])           = rejected:1 ⇒ pending:false            ← 唯一出路：reject
```

**判定**：
1. **`.dshstage/**` 没有前缀排除**；(b)+(c) 成立。
2. **自指条目是"条目非常容易出错、消不掉"的一条确凿来源**：`publish()` 在任何一次变更后都会重写真实 `review.json` ⇒ 任何以 `review.json` 为目标的暂存条目**天然的 baseHash 立刻过期** ⇒ `approve` 永远 `STALE_BASELINE`；且它还命中 `stage-store`（`hard:true`）⇒ 还必须先过 `--confirm-mask`。**"批准一次快照文件"本身就是一个状态机死结**（批准成功也只会把过期快照写回去）。
3. 它**不是**唯一的"消不掉"来源（§2.3 的 C-2 才是必现主因），但它解释了"条目非常容易出错"里"莫名出现一条危险条目、怎么点都不消失"的形态。
4. 好消息：**`reject` 能清掉它**（本节 `rejected:1 ⇒ pending:false`），且不碰真实文件 —— 与 §7.2 一致。

### （4）§5 新增修复建议（P0-8，见 §7.8）：`.dshstage` 元数据与 blobs 必须对 `ctx.fs` **只读或不可见**

**能挡住什么**：agent 的 `write/edit`（`ctx.fs`）对 `.dshstage/**` 的自批/自清/伪造条目（本条 [实测] 可写：[未实测] 与 Lead 的 R8 报告一致 —— `.dshstage\manifest.json`、`review.json` 在 R8 清单里）。
**挡不住什么（必须如实写进文档）**：**shell（`bash`/`pwsh`/任意子进程）的写入**完全绕过 `ctx.fs`（`staging-fs.mjs:28-30` 自认），因此 `Start-DshWeb.ps1`、`src/**`、仓库根文件乃至 `.dshstage/**` 的 shell 级写入**不是插件能拦的**；插件层只能做到"经由 `ctx.fs` 的路径不给元数据写权 + 读遮蔽回到 tool 路径"。**不许可把这条修法表述为"R8 已解决"。**

## §7.6 外部独立复现（并入 §2，[实测/用户侧]）

**场景**（用户在 `sandbox-tests\modify\edit-target-mod.txt` 上做的字节级对照）：

| 步骤 | shell（真实磁盘） | harness（`ctx.fs`） |
|---|---|---|
| 建基准 | `BASE_V1`（sha `1754C2102DF88397`） | — |
| 修改 | 连续两次 shell 写 → **都真实生效** | `edit` 两次都回 `updated successfully` |
| 读回 | 仍是 `BASE_V1`（长度/sha/mtime 未变） | `read` 看到 `BASE_V3_BY_HARNESS_EDIT_2` |
| 落点 | — | `BASE_V3` 只在 `.dshstage\blobs\7d\7dd3048a…`；`review.json` = `op=modify +1/-1 pending=True` |

**与我的 §2/§1.3 完全同构**（我用 `write` 工具写 `%TEMP%\winstage-exp\exp1.mjs`：工具回执成功、真实磁盘 `Test-Path=False`、对象在 `.dshstage\staged-ext\…`；`pwsh Set-Content` 同路径立刻真实存在）。
⇒ **并入 §2.2/§7.6 的判定：`read` 与 shell 的视图分叉是**所有断言**的方法论前提 ——
1. **凡"文件真的变了吗"的断言，必须用 shell（`Get-FileHash`）**，不能用 harness 的 `read`/`stat`；本轮 `review.json` 的 `files[].baselineStale`、`applyOneChange` 的 `STALE_BASELINE` 都是"真实磁盘"口径，二者恰好一致（`realHashOf`/`hashFile` 都走 `node:fs`）。
2. **凡"面板该显示什么"的断言，只能读 `review.json`（或 DOM）**；真实磁盘没有待审概念。
3. §0 的 C-6、§1.3、§7.5(3) 已经各自留了 shell 侧证据，T4/T5 的报告应沿用同一条纪律（"harness 说成功" ≠ "磁盘变了"）。

## §7.7 R8 归属与"插件侧能修到哪一步"（[实测/引用]）

| R8 清单项 | 是否经 `ctx.fs` | 插件侧可修 | 说明 |
|---|---|---|---|
| `.dshstage\manifest.json` / `review.json` / `queue.json` / `blobs/**` | 是（若由 agent 的 write/edit 写入） | **可以**：P0-8（`keyOf` 返回 `undefined`/拒绝；或 `writeText/editText` 对 `stage-store` 命中直接 `FsError('FS_SANDBOX_DENIED')`），并把读遮蔽并入 `staging-fs` 的读路径 | 这是**自批/自清/伪造条目**的入口，优先级高 |
| `src\capability.mjs`、`README.md`、`docs/**` 等仓库文件 | 是 | **不能靠"插件拒绝"达成安全**：暂存的语义就是"允许改、但要审批"；能做的是让审批**响**（P0-1/P0-3）与让条目**可清**（P0-2） | 这些不是"越权写"，是"被延迟的写" |
| `Start-DshWeb.ps1`（被追加 46 B 后已还原）、`Desktop\**` 其它 | **否**（shell） | **完全不能**（插件不接管 `bash/pwsh`；`staging-fs.mjs:30` 自认） | 属执行器/内核层（T2b 的领地）；**不许**写成"插件已解决 R8" |

## §7.8 由 Q-A…Q-E 新增/修订的修复点（接 §5 优先级）

| 编号 | 位置 | 修法 | 回归风险 | 类别 |
|---|---|---|---|---|
| **P0-6** | `dsh-plugin/schema.js:127`（根 `meta`）+ `:68`（字段 `meta`） | **去掉根节点的 `volatile: true`**（`this.meta = { default: {} }`），保留字段级 `meta.volatile`（`field()` 不动） | 低：`volatileForm` 的第一分支从"根命中 ⇒ 整份直出"变成"`type==='object'` ⇒ 递归子字段"，每字段都是 volatile ⇒ 仍然投影；[实测] `createConfigProjector` 从 throw 变 `ok:true`。**必须**跑设置页/`listConfigs` 复测；`defaultCollapse` 等纯客户端偏好不受影响 | **必须修** |
| **P0-7** | `dsh-plugin/host-plugin.mjs:386-394` + `staging-fs.mjs:346-368` + 新增 `switch-state.mjs` | 见 §5 **P0-4a** 的单一真源；**并**在 host 行加一个 `/winstage debug`（或 `/winstage status` 附一行）**同时打印** `config.enabled`、`parent.data` 行的 `enabled`、`stagingEnabled()` 结果 | 低；新增命令要遵守 `input.hint` 契约（否则 `normalizeDefinition` 抛错杀注册，见 S16） | **必须修** |
| **P0-8** | `staging-fs.mjs:397-408`（`keyOf`）+ `:470-486/:519-533` | 对 `key` 命中 `stage-store`（`SELF_MASK_ID` / `src/paths.mjs:199`，注意该正则要求**前后分隔符**）的**写入**直接抛 `FsError('… is WinStage's own store; refusing to stage', 'FS_SANDBOX_DENIED')`；`readText/readBytes/stat/lstat/listDir` 同步走 `Workspace.maskOf` 语义（或在 `keyOf` 层直接判） | 中：`.dshstage` 也是**会话/共享存储**，`staging-fs` 自身**不写**它（走 `src/store.mjs` 裸 fs），所以拒绝不影响暂存机制本体；但 `.t` 里有以 `.dshstage` 为目标的断言（如 D5/敏感类）需复核；**必须**加一条断言"agent 写 `.dshstage/review.json` 被拒 + 真实元数据未变 + 不产生候选" | **必须修** |
| **P1-16** | `review-service.mjs:503-546/909-928` + `Workspace.listReviews()` 的遍历域 | 给"终结态回收"一条路：`queue.json` 的 `discarded` 提到阈值时按 id 删除 `.dshstage/candidates/<id>.json`；或提供 `/winstage gc`（保留最近 N 条 pending）。**不要**动 `superseded` 的语义（`resolveCandidate` 的 `superseded_by` 链要靠它，`src/workspace.mjs:936-960`） | 中：删候选文件会让 `resolveCandidate` 对旧 id 报 `CANDIDATE_NOT_FOUND`（对已终结 id 是合理行为，但 `.t` 的 D6/幂等断言可能依赖旧文件存在）；建议**只清 `discarded` 且只在不破坏链的情况下**动 | 建议（Lead 决策） |
| **P1-17** | `dsh-plugin/cordis.patch.yml` 头注释 + docs | 明确写："覆盖层/设置页写 `enabled` **不等价于**运行中的 loader 树立刻换面（volatile 语义 + 热组合时机）"；并把"开关真值判定式"（§7.1 判别式）写进 `.t\dsh2\HOWTO-RESTART.md` 的四条验收 | 无（纯文档） | 建议 |

**给 T3 的顺序修订**：`P0-6`（schema，一行但直接影响"开关能不能用"）→ `P0-1/P0-3`（失败可见）→ `P0-2`（消不掉）→ `P0-8`（`.dshstage` 自指/元数据保护）→ `P0-7 + P0-4a`（单一真源 + 开关判别）→ `P1-6`（version）→ `P0-5`（读侧统一）。

## §7.9 证据索引（本轮追加）

| 证据 | 位置 | 判定 |
|---|---|---|
| Q-A：真实 patch 文件的组合结果 | `%TEMP%\winstage-exp\exp6.mjs`（用 `cordis-plugin-include.applyEntryPatches` + 两份真 YAML） | [实测] |
| Q-A：Config 投影被拒 + 去根 volatile 后成功 | `%TEMP%\winstage-exp\exp5.mjs` 末段（`dsh-app-boot.createConfigProjector`） | [实测] |
| Q-A：3080 活 entry 目录 | `cordis_inspect_query(host, Config, listConfigs, {name:"@local/dsh-winstage-sandbox"})` → `[{id:"include:winstage-sandbox", patchId:"winstage-sandbox", status:"schema"}]`；`{entry:"include:winstage-sandbox"}` → **报错**（volatile 放置） | [实测] |
| Q-B：reject 安全性 | `%TEMP%\winstage-exp\exp5.mjs` 的 `QB_rejectSafety` | [实测] |
| Q-B：孤儿候选与增长 | `%TEMP%\winstage-exp\exp5.mjs` 的 `QB_growth` | [实测] |
| Q-E：`.dshstage` 无排除 + 自指打结 | `%TEMP%\winstage-exp\exp5.mjs` 的 `QE_stage` / `QE_reviewService` | [实测] |
| Q-E：`ctx.fs` 读也无遮蔽 | 本会话用 `read` 工具读 `<repo>\.dshstage\manifest.json` **成功返回**（`revision:57`、`sessionId:"dsh-host"`） | [实测] |
| 遮蔽表本体 | `src/paths.mjs:199`（`stage-store`，`hard:true`，正则要求前后分隔符）、`:416 SELF_MASK_ID` | [引用] |
| 外部独立复现（edit/read vs shell） | Lead 转述的用户实测（`BASE_V1` sha `1754C2102DF88397` vs `.dshstage\blobs\7d\7dd3048a…`） | [实测/用户侧] |
| loader 组合语义 | `cordis-plugin-include/lib/index.js:56-105`（`applyEntryPatches`）、`:107-182`（`Include.read/root.update`）、`cordis-plugin-loader/lib/index.js:78-96`（`EntryGroup.update` 换 `data`）、`:161-179`（`EntryTree.sep=":"` 与 `resolve`） | [引用] |

**本附录新增的副作用披露**：为回答 Q-E，我用 `read` 工具读了一次 `<repo>\.dshstage\manifest.json`（只读）与一次 `.dshstage\review.json` 的计数（`pwsh` 只读解析，未写）。除此之外，本轮 T2a 没有新增任何仓库写入、没有删除任何清单条目、没有起停任何进程。
