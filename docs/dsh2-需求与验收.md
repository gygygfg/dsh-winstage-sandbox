# 第二 DSH 实例：需求与验收（Lead 维护，唯一需求来源）

> 本文件是本次工作的**需求基线**。Lead 只改这个文件；执行者只读它、并把自己的证据写进各自
> 独占的报告文件。任何与本文件冲突的口头约定都不算数 —— 以这里为准，或先让 Lead 改这里。

---

## 0. 一句话目标

在一个**独立于当前 3080 实例**的第二个 DSH 进程（端口 3081，独立 `DSH_HOME`）里装载本仓库的
WinStage 沙箱插件，用**真实浏览器控制**去操作它，从而：

1. 把 [DSH集成.md](DSH集成.md) 里那条从未闭环的 **S5「面板视觉未确认」** 变成有截图、有 AX 树、
   有点击结果的实测证据；
2. 修掉用户勾选的三类问题（**UI 适配** / **暂存语义 S1·S2·S7** / **Windows 沙箱的调用与支持情况**）；
3. 全程**不触碰**承载用户与 Lead 会话的 3080 实例。

## 1. 角色与边界（谁干什么，谁不许干什么）

| 角色 | 职责 | 写范围（唯一所有者） | 明确禁止 |
|---|---|---|---|
| **Lead**（我） | 只维护本需求文档 + 与用户对接 + 派工/验收 | `docs/dsh2-需求与验收.md` | 不直接操作插件、不起进程、不开浏览器 |
| T1 `dsh2-rig` | 起第二实例、交付启停脚本与 READY 证据 | `.t/dsh2/**`（home、ws、logs、脚本、READY.json、T1-report.md） | 不改 `dsh-plugin/**`；不改 `C:\Users\Administrator\.dsh\**` |
| T2 `dsh2-probe` | 动手前的只读基线侦察（S1/S2/S7、Windows 沙箱、端口/信任域/client 契约） | `docs/dsh2-基线报告.md`、`.t/dsh2/probe/**`、`docs/dsh2-发现记录.md` 的 `## T2` 小节 | 不改 `dsh-plugin/**`、`src/**`、`tests/**` |
| T3（按需派） | 按 T2 报告做最小修复 | `dsh-plugin/**` 指定文件 | 不跑第二实例、不开浏览器 |
| T4（按需派） | 浏览器（CDP）操作 3081，闭环 S5 与 UI 适配 | `.t/dsh2/browser/**`、`.t/dsh2/T4-browser-report.md`、`## T4` 小节 | 不关别人的 tab、不动 3080 页面 |
| T5（按需派） | 独立复核，不信任何人的结论 | `.t/dsh2/verify/**` | 不修代码，只报告 |

**写范围重叠是告警不是锁**：不允许两个人同时改同一个文件。共享台账 `docs/dsh2-发现记录.md`
按 `## T1` `## T2` `## T4` 分节，**各写各的小节，只追加**。

## 2. 已确认的环境事实（Lead 只读侦察所得，执行者不要再花时间重新发现）

| 事实 | 证据位置 |
|---|---|
| 当前实例：`DSH_PROFILE=web`、`DSH_WEB_URL=http://127.0.0.1:3080`、`DSH_HOME=C:\Users\Administrator\.dsh` | 本会话环境变量 |
| profile `web` 已把 `@local/dsh-winstage-sandbox` 以 `link:` 指向本仓库 `dsh-plugin` | `C:\Users\Administrator\.dsh\profiles\web\package.json` |
| 插件的三件套装配（禁 `fs-sandbox` + 插 `winstage-sandbox` + 插 `winstage-fs`）已作为 **bundle patch** 存在 | [dsh-plugin/cordis.patch.yml](../dsh-plugin/cordis.patch.yml) |
| dsh 支持 `--port/--host/--no-open/--trusted-host`，且 `--host 0.0.0.0` 被硬拒；支持 `--patch` 叠加层、`--from-default-profile` | `node_modules\@deepseek-ai\dsh-web-app\lib\startup.js`、`@deepseek-ai\dsh\lib\bin.js` |
| 本会话 shell 是**受限令牌**：`cmd`、`netstat` 直接 Access denied，`Get-Process` 看不到其它用户进程 | 本次实测（[docs/实测证据记录.md](实测证据记录.md) 亦有同类记录） |
| `conversation.composer` 是 chain 槽位，`select(owner)` 返回 `null` 即不接管；本插件用 priority 20，内置审批窗 priority 1 | [dsh-plugin/client.js:123-129](../dsh-plugin/client.js#L123-L129) |

## 3. 三条硬需求（用户勾选 + 追加，逐条可验收）

### H1 UI 适配：首屏即挂载 + 端口/信任域

> **根因已定论（T2 独立得出，Lead 逐行复核）**：审阅悬浮窗**永远不会出现**，原因不是"页面没刷新"，
> 而是 loader 行用了**子路径 specifier**。`node_modules\@deepseek-ai\dsh-client-modules\lib\index.js`：
> `exactPackageSpecifier`（:82-88）对 `@scope/name/sub` 三段 specifier 返回 `undefined` →
> `locatePkgJson`（:747）直接 `return undefined` → `processOne`（:836）只处理
> `entry.options.name === entryName` 的行 ⇒ 该行**产不出 client bundle**。
> 所以 [DSH集成.md §3.3](DSH集成.md) 的"页面还没刷新"归因**不成立**（需回写更正），
> 修复 = 行名改裸包名，代价是丢掉"换 specifier 免重启加载新代码"的开发期技巧。
> 证据：`.t/dsh2/probe/out/c2-boot-graph-3081.json`（首页 `__DSH_BOOT__` 里 0 条 winstage）。

> **紧随其后的两个真缺口（T2 §4.4，判定 `[引用]`）**：
> 1. **跨工作区串台**：`client.js:176` 在 settings 未给 `workspaceRoot` 时回退到 `owner.session.cwd`，
>    而 `workspaceFiles.read` 的 `locateFile` **不做包含校验**（只有 `list` 校验）⇒ 3081 面板会读到
>    **项目根**那份 `pending=true` 的快照。修复：兜底必须落在 config 根之内，并用 `review.json`
>    自带的 `workspaceRoot` 字段做零额外 IO 的自校验，不一致就不接管。
> 2. **配置漂移**：host 行读 `config.workspaceRoot`（`host-plugin.mjs:297`）、fs 行读 `config.cwd`
>    （`staging-fs.mjs:131`）⇒ 不一致就会"暂存写 A、快照发布 B"。修复：patch 里同源 + fail-closed。

> **一个尚不确定的时序缺口（T2 §4.5，`[引用]`机制 + `[未实测]`行为，Lead 决定先不修）**：
> `store.publish()` 不 bump chain 槽位版本，`select` 只在锚点重渲染时才重跑 ⇒ 首屏可能存在
> "快照到了但面板还不接管"的窗口。**判定权交给 T4 的真实浏览器实测**：在 F1 修好、不刷新、
> 不做任何交互的前提下，面板是否在 N 秒内出现。拿到行为证据之前不做猜测性改动。

**H1 验收补充**：面板出现必须同时满足 4 个条件（缺一不可，T4 逐条取证）：
① client 半进入 `window.__DSH_BOOT__`；② 有会话（`owner.sessionId`）；③ 快照 `pending=true`；
④ 根一致（不串台）。只看①就宣布"修好了"是不合格的。


- `client.js` 的 `routeOf(owner)` 要求 `owner.sessionId` 存在（[:124](../dsh-plugin/client.js#L124)）；
  面板读快照走 `ctx.remote.workspaceFiles.read(sessionId, "<root>\.dshstage\review.json")`
  （[:138-146](../dsh-plugin/client.js#L138-L146)）。**验收**：在 3081 的新 tab 里，面板可在
  *无需任何特殊刷新技巧* 的情况下被 AX 树找到，或给出它为何不可能出现的可判定结论。
- 3081 与 3080 并发时，`/api` 无 trust/CSRF/403 异常，两实例互不干扰。**验收**：附两个实例同时
  在线时 3081 的页面加载证据与任何 4xx/5xx 响应原文。

### H2 暂存语义：S1 / S2 / S7

| 编号 | 现状（待 T2 实测确认） | 本次要求 |
|---|---|---|
| S7 | `watch()` 继承本地实现，只观察真实磁盘 | 要么实现"暂存变更触发监听事件"，要么**如实标注未提供**并写清代价。二者都必须有证据 |
| S2 | `stageOutside` 默认 `direct`，工作区外写入直通真实磁盘 | 给出把默认改成 `deny` 的兼容性代价清单（哪些 DSH 自身流程会写工作区外），再由 Lead 决策 |
| S1 | `pwsh`/`bash` 写入不经 `ctx.fs` | 给出可行路径与代价；不可行则如实标注，**禁止**含糊成"已解决" |

### H3 Windows 沙箱的调用与支持情况（用户追加的问题）

必须**分开**回答三层，不许混为一谈：

1. **DSH 插件层（暂存）**：装载了什么、边界在哪（`.dshstage` 每 workspaceRoot 一份）。
2. **CLI 执行器层（受限令牌 + Low IL + Job Object + 显式环境块）**：`WindowsStageExecutor`
   是否被接进 `ctx.shell`？由谁调用？在哪些会话下能真的创建受限令牌（受限/不受限各测一次）？
3. **内核隔离层**：如果不存在，就明确写"本插件不提供内核级隔离"。

**验收**：三个会话档位各自的 `createRestrictedToken` 实测结果（原始命令 + 原始输出）；
没有条件测的档位写 `[未实测]`，不许推断。

> **T2 已交结论（`[引用]` + `[实测]`，详见 [dsh2-基线报告.md](dsh2-基线报告.md) §3）**：
> 1. **插件层**：只装载暂存面。`WindowsStageExecutor` 只被 `src/cli.mjs`/`src/audit.mjs`/
>    `dsh-plugin/selfcheck.mjs` 使用，**没有接进 `ctx.shell`/`ctx.sandbox`**
>    （`host-plugin.mjs:28` 只 import、`:77` 只调 `capabilities()`、`:334-338` 只写日志）。
>    唯一的适配层 `dsh-plugin/provider.mjs` **全仓无人引用**，且它 import 的
>    `dsh-plugin/bridge.mjs` **文件不存在**。
> 2. **执行器层**：三个档位 —— 3080 受限会话 `fail`（`TOKEN_ADJUST_DEFAULT/SESSIONID=NO`）；
>    3081 谱系 `fail`；**不受限会话拿不到 ⇒ `[未实测]`**。
>    CLI 侧本会话实测：`src/cli.mjs exec` → `SANDBOX_INIT_FAILED: OpenProcessToken failed (Win32 5)`，
>    `tier=T2 (acl-only)`、`nesting.viable=false`。
> 3. **内核层**：本插件**不提供**内核级隔离；AppContainer 在本令牌下 `E_ACCESSDENIED`，
>    也尚未接进执行器。
>
> 结论一句话：**这台机器上，WinStage 的"沙箱执行面"是能探测、能报告、但当前会话里无法真正建立的**；
> 而"暂存面"不依赖它，正常工作。

## 3.5 一个必须记住的前提：3080 上**没有**装这个插件（这是用户要求的）

[实测] `C:\Users\Administrator\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles` 只有 4 条
（`dsh-base`、`dsh-web-app`、`dsh-experimental-auto-review`、`dsh-experimental-agent-team-profile`），
**不含** `@local/dsh-winstage-sandbox`；旁证：`.dshstage/staged/` 里的候选内容是 v3，而工具 `read`
读到的是真实磁盘的 v2 —— 即当前 3080 会话的 `ctx.fs` 是平台的 `fs-sandbox`，不是 `winstage-fs`。

用户明确要求"不要使用这个 dsh 进程来加载插件"，所以这是**正确状态**，不是故障。

**推论（对验收很重要）**：3080 上任何"面板不出现""暂存不生效"的观察**对本插件没有判别力**。
本轮所有插件逻辑结论只能来自 3081。**也不许为了验证而重启 3080** —— 它承载用户会话，
且 [DSH集成.md §4](DSH集成.md) 记录在线切换本 bundle 会让宿主进程退出。

## 4. 全局约束

- **不触碰 3080**：不改 `C:\Users\Administrator\.dsh`，不重启、不重载、不切换当前 profile。
  [DSH集成.md §4](DSH集成.md) 已记录"在线启用/禁用本 bundle 会让宿主退出"，所以**在线切换**是本项目
  明令禁止的动作。
- **不共用 `.dshstage`**：第二实例用 `.t\dsh2\ws` 作 workspaceRoot 与 `ctx.fs` 的 `cwd`，
  否则两个实例的暂存清单会互相污染。
- **证据三要素**：原始命令/脚本 + 原始输出（或日志路径）+ 判定 `[实测]`/`[引用]`/`[未实测]`。
  没有证据的断言视同未完成 —— 本项目此前栽过"假通过"（缺陷 11）与"没有可视化证据"（S5）两次。
- **改动只在 `dsh-plugin/**`**：`src/**`、`tests/**` 是 CLI 侧，不在本次范围。
- **回归门**：改动后必须重跑既有离线测试（`.\autotest.cmd --skip-audit`），不得引入回归。

## 5. 交付物清单

| 交付物 | 所有者 | 验收方式 |
|---|---|---|
| `.t/dsh2/READY.json` + 启停脚本 | T1 | Lead 能按脚本一条命令重启 3081。**注意**：`READY.json` 是**生成物**（`node .t/dsh2/make-ready.mjs` 在每次重启后重跑），当前不在盘上；权威状态看 [.t/dsh2/T1-report.md](.t/dsh2/T1-report.md) 与 [.t/dsh2/HOWTO-RESTART.md](.t/dsh2/HOWTO-RESTART.md) |
| `docs/dsh2-基线报告.md` | T2 | 每条结论带证据三要素 |
| `docs/dsh2-发现记录.md` | 全体（分节） | 各节独立、只追加 |
| `.t/dsh2/T4-browser-report.md` + 截图 + AX 摘录 | T4 | 面板出现/未出现有第一手证据 |
| 修复后的 `dsh-plugin/**` + 每处改动的理由与验证 | T3 | 每处改动对应一条可复跑断言 |
| 复核报告 | T5 | 独立复现，不复述他人结论 |
| **本文件 + 最终答复** | Lead | 与用户对接，如实汇报未闭环项 |

## 6. 用户已拍板的决策（2026-09-28，Lead 记录，执行者按此执行）

| 编号 | 决策 | 含义 |
|---|---|---|
| D1 | **允许把 LLM 凭据复制/引用到 `.t\dsh2\home`** | 第二实例必须能真跑 agent，才能用 `write` 工具造出"待审改动"，面板可见性才有意义。凭据只落在 `.t\dsh2\home`，不得回写 `C:\Users\Administrator\.dsh` |
| D2 | **授权直接改**：S2 `stageOutside` 默认改 `deny`；S1 尽量做 | 允许行为破坏性变更，但**必须有回归门**：每处改动配一条可复跑断言，且改动后 `.\autotest.cmd --skip-audit` 不得回归。改坏能回滚（改动前先记基线） |
| D3 | 端口 3081 | 用户指定；实测被占用时回报 Lead，不擅自换 |

### D2 的执行纪律（Lead 补充，不是可选项）

- S2 改默认值前，T2 必须先交"DSH 自身会写工作区外哪些路径"的清单；T3 改完后必须逐个回归这些路径，
  确认没有把 DSH 自身的正常落盘（会话日志、附件、临时文件）变成拒绝。
- S1 的量力而行判据（Lead 已初判，T2 复核）：受限令牌在**已被沙箱化的会话**里创建不出来（R6/`TOKEN_ADJUST_DEFAULT`），
  而"把 shell 可写根指向暂存树"恰恰依赖受限令牌。因此 **S1 只有在不受限会话下才可能真正实现**；
  若 T1/T2 确认无法在可用环境中验证，**正确交付是把它标注为 `[未实测]/未提供` + 写清前提条件**，
  不是用近似手段假装做完。

---

## 7. 本轮实测结果（Lead 汇总）

### 7.1 已闭环

| 项 | 结论 | 判定 |
|---|---|---|
| S5 根因 | loader 行用子路径 specifier ⇒ client 半不会下发（与"页面没刷新"无关） | `[实测]` + `[引用]` |
| F1 修复 | 行名改裸包名后，3081 的 `__DSH_BOOT__` 65 entries 里 `@local/dsh-winstage-sandbox` 命中 1；bundle 200 / 30950 B；刷新 rev 稳定 | `[实测]`（三轮独立测量一致） |
| "命令只 apply 一次" | 真 `applyEntryPatches` + 真 YAML 断言：恰好 1 行解析到 `host-plugin.mjs`（反事实：两行同用裸名 → 2 行） | `[实测]` 静态 |
| F2-C7 串台 | `client.js` 加 `sameRoot` 零 IO 自校验、删除 `owner.session.cwd` 兜底 | `[实测]` 函数级（浏览器可见性 `[未实测]`） |
| F2-C8 漂移 | YAML 锚点结构性同源 + fail-closed 守卫 | `[实测]` |
| F3 S2 | 默认 `deny`；判别式 `instanceof FsError && code === 'FS_SANDBOX_DENIED'` 与外层 `EPERM` 完全分开 | `[实测]` |
| F4 S7 | `watch()` 覆写：超类照旧 + 暂存变更本地失效 | `[实测]` 探针 |
| 回归门 | `.\autotest.cmd --skip-audit` = 9 套件 / 250 断言 / exit 0，与改动前基线逐项一致 | `[实测]` |

### 7.2 未闭环（如实标注）

| 项 | 状态 | 原因 |
|---|---|---|
| **S5 视觉证据**（截图/AX/console/交互） | `[未实测]` | 沙箱**结构性**禁止 Chromium：Mojo IPC 需命名管道 → `FATAL platform_channel.cc:187 Access denied`；`--single-process`/`--no-sandbox`/两种 headless 全试过。已请用户在**沙箱外**启动隔离 Edge + 调试口，起来后由 T4 完成 |
| **C-5 首屏时序缺口** | `[未实测]` | `store.publish()` 不 bump 槽位版本；**故意未修**，等浏览器行为证据 |
| **S1** | **未提供**，未改代码 | 依赖受限令牌，本机谱系创建不出（R6）；`provider.mjs` 无人引用且其 `bridge.mjs` 不存在。前提 = 不受限会话 + 真正接进 `ctx.sandbox` |
| 3081 自身 agent shell 令牌档位 | `[未实测]` | 需在常驻实例里创建会话，风险与收益不成比例；已有"同谱系"档位实测 fail |

> **F2 修好后的判因方法（重要）**：串台的表现从"面板显示错的那份快照"变成"**面板静默不出现**"——
> 守卫链四处 `return null`，**可能一个报错都没有**。所以不能靠抓 console 异常判因，必须比对三个值：
> `configValue.workspaceRoot` / `store.state.workspaceRoot` / `review.json.workspaceRoot`。

### 7.3 本轮踩到并已文档化的三个"静默失效"

1. **子路径 specifier** → client 半静默不下发（S5 根因，刷新无效）。
2. **profile 覆盖层的 `name` 是断言** → 不匹配时整条补丁连同 `config` 被静默跳过，启动期**不告警**
   ⇒ 隔离用的 `workspaceRoot` 丢失、`.dshstage` 落回真实工作区。**已实际发生（INC-1**：仅 1 个快照文件被写，
   无状态损坏、无数据丢失，已修并差分验证）。
3. **patch 对 `config` 是整体替换、不是深合并** → profile 层只重述 `cwd` 会让漂移守卫**永不触发**
   （"写了防护但没生效"）。已修：profile 层补齐 `workspaceRoot`。

> 通用教训：**profile 覆盖层必须重述该行 config 的所有键**；未写的键不会继承，而是静默消失。

### 7.4 浏览器复测炸出的三个缺陷（已修并复测 PASS）

面板能出现**不等于**能用。T4 用真浏览器点了一遍，在 `全选/清空选择 可用`（阴性对照）的前提下，
发现三个控件**静默失效**，全部已修并复测：

| 缺陷 | 根因（源码级） | 修法 | 复测 |
|---|---|---|---|
| **B（致命）** `/winstage*` 未注册 ⇒ 批准/拒绝静默失效 | `host-plugin` 传 `input: { placeholder: … }`，而 `dsh-commands:154-163 normalizeDefinition()` 要求 **`hint`** ⇒ 第一条 spec 即抛 `TypeError` ⇒ 整个 `ctx.inject(['commands'], …)` 回调死掉 ⇒ **6 条一条没注册** | 改 `hint`；注册包进 try/catch + error 级日志（"失败必须响"） | `commands/list` **6 条**；`/winstage status` 带 value 且与 `/definitely-not-a-command-xyz`（value=null）**可区分** |
| **A** 页面加载/刷新不挂载面板 | chain 槽位只在**渲染时**调 `select`，锚点订阅**槽位版本**；模块级 `store` 变化不触发 | 只在"是否接管"**跃迁时**重挂一次注册（`register()`/disposer 是唯一公开的版本推进通道）；判据抽成唯一实现供渲染期/轮询期共用 | headless **1.9s** 自现；headful 首轮即 11 命中 |
| **C** `暂时收起` 收不起自己 | 与 A 同根因 | 同 A | 收起后面板消失；新快照到来重现 |

**§14.5 的两个备选方向被源码否决**（不是想当然）：`ui-slots` 的 `store` 只是 scope handle（无 store→markDirty 路径）；
ownerProps 由宿主组装，第三方插件加不了字段。

**T1 的 `commands=6` 是假证据**：那是进程内直接调 `registerCommands()` 塞 mock 数组、**绕过 `normalizeDefinition()`** 得到的。
⇒ 教训：**"我调了函数"不等于"线上生效"**；能证明线上生效的只有经真实服务 + 真实浏览器可区分的断言。

### 7.4b S5 最终状态：闭环（双证据）

`[实测]` headless(9222) 与 headful(9223) **结论一致，无分歧项**：
全新加载无任何交互 ⇒ 面板自现；点击「批准所选」⇒ `review.json` 变化（`pending true→false`、`files 1→0`、`revision++`）
**且 `.t\dsh2\ws\stage-probe.txt` 真的落盘**（22 B = `WINSTAGE-STAGE-PROBE-1`）；「暂时收起」⇒ 面板消失。
截图：`.t\dsh2\browser/r2-headful-a-fixed.png`、`r2-headless-a-fixed.png`、
`r2-headful-after-approve-selected.png`、`r2-headless-after-approve-selected.png`（Lead 已亲自看图确认）。

**⚠️ 一个必须记住的度量陷阱**：`/winstage status` 的**输出会回显进聊天记录**，AX 里因此出现
`button "winstage WinStage 暂存待审 …"` 这类**回显节点**，它们**包含**面板文案 ⇒ 用**子串**判面板存在性会得到**假 PASS**。
必须用**精确名**匹配（面板自身名恰好是 `WinStage 暂存待审` / `暂时收起` 等）。


## 7.5 第四轮（三档审批 + 不做硬拒 + 运行时零弹窗）—— 已完成并验证

**用户需求**：工作区外写入不报错、进审批悬浮窗**按三档显示**；**运行时不弹任何窗**，只有"明确信息泄露"报一次；
批准/拒绝**全部异步**；外面可写根对齐到外层可写根。

| 阶段 | 交付 | 验证 |
|---|---|---|
| S3a 暂存层支持工作区外路径 | `staging-fs.mjs`、`src/store.mjs`、`src/workspace.mjs`、`fs-entry.mjs` | `stage3-store.mjs` **20/20**；`FS_SANDBOX_DENIED` 在可执行代码里 **0 处**；批准写回**原始绝对路径**；外部条目陈旧基线保护生效 |
| S3b 三档判级与暴露 | `review-service.mjs` | `stage3-classify.mjs` **25/25**（含真 external 端到端）；danger 档 `diff: []` + `note`（内容不外泄） |
| S3c 面板三档显示 | `client.js` | `f8` **47/47**；浏览器 `check-three-tier.py` **exit 0 / 全 PASS** |
| S3d 对比度（用户实测缺陷） | `client.js` | 见 §7.6 |
| S3e 收起后找回入口（用户实测缺陷） | `client.js` | 浏览器**完整往返 8/8**：收起→chip 出现→点开→面板回来→刷新后仍可达 |
| S3f 独立复核查出的 G1/G2/G3/G4 | `client.js` | `f8`/`f9`/`f10`/`f11` 全绿；每条新断言都有**能 FAIL 的变异体证明** |
| S3g 危险横幅只活 2 秒 | `client.js` | 浏览器 `check-alert-persistence.py` **exit 0**：横幅**连续 20s 在场**（修复前 `streak=0s`） |

**关键契约（review.json 增量，向后兼容）**：条目新增 `external` / `risk`(normal·outside·sensitive) /
`safety`(risk·danger) / `riskReason` / `note`（条件键）；顶层新增 `riskCounts` 与 `alerts[]`（非阻断提示通道）。
**两条反直觉但必须遵守**：① `external` 与 `risk` **不互斥**（`<wsRoot>\.dshstage\x` 是 `external:false` + `sensitive`）⇒ **分组按 `risk`**；
② `external:true` 的 `path` 是**绝对路径逐字**，不要再拼 `workspaceRoot`。

**落实的交互语义**：「批准全部」= **全部普通项 + 用户已勾选的高风险项**（不是"一键写全部"，否则就是绕过分级的按钮）；
「全选」只选普通项；高风险项**默认不勾**、需显式勾选；`danger` 的行 **diff 永不上屏**（客户端自证，不只靠宿主）；
授权手势按 `path|risk|safety` 记账 ⇒ **档位升级后旧勾选失效**，需重新授权。

### 7.6 对比度：从"看不清"到"看不见"再到达标

用户报"按钮字看不清" ⇒ 第一轮修（改 token 名）后**实测变成 1.00:1 —— 字完全不可见**。
根因：`brand-text` 的语义是"**用品牌色当文字**"，不是"品牌底上的文字"；亮/暗下它与 `brand-primary` **取同一个值**。
（上轮只**静态看源码**就放了行 —— 这是"源码里看起来对 ≠ 渲染出来对"的实例，责任在 Lead。）

**修后实测（浏览器 + 主题 CSS 解析值两条独立路径吻合）**：

| 元素 | 前 | 后 light | 后 dark |
|---|---|---|---|
| 批准全部 / 批准所选 | **1.0000**（隐形） | **18.8965** | **18.0823** |
| 组标题、危险红 | 2.7939 / 4.4976 | 18.8965 | 13.3362 |
| 危险横幅 | — | 15.5219 | 11.9076 |
| **全局最低** | 1.00 | 15.5219 | **11.9076** |

`contrast-audit.py`：**entries 35，light 0 失败 / dark 0 失败**；Dark Reader 档因 headless 无扩展记
"**未跑到**"（≠SKIP≠通过）⇒ `exit 2`（partial）是**正确**结果。

**防复发的两道机械哨兵**（都带能 FAIL 的变异体）：
- `D1–D4`：文字**不许**用 `state-*/brand-*` 填充色 token；每个文字色按主题 CSS **真实解析值**算两主题 ≥4.5；
  `primary` 的底与字必须解析出**不同**颜色（1.00:1 回归哨兵）；`D4` 走**渲染树**逐元素算。
- `D5`：引用的 `--dsw-*` **必须能解析到值**（除非显式写 fallback）。首次运行即暴露全部 6 个未定义 token。

**⚠ 一条如实标注的降级**：`--dsw-alias-state-error-tertiary` **在主题里不存在**，`alert`/`badgeDanger`/`danger`
实际靠作者写的 `rgba(220,60,60,.14)` 承重 ⇒ **"`D5` 通过"只表示"不会产生非法声明"，≠"视觉与设计一致"**。
（是否换成真实存在的 tint token，待用户/宿主决定。）

### 7.7 仍未闭环（本轮结束时）

| 项 | 状态 |
|---|---|
| **Dark Reader 真实行为** | **无自动化证据**。本机 headless 无扩展 ⇒ 该档必然"未跑到"。已知弱证据：`data-darkreader-ignore` 透传到 **14 个控件**、`data-darkreader-inline-*` = **0**，但**这不等于"DR 真的不再改色"**。唯一权威验证 = 用户在装了扩展的浏览器里刷新看（已请用户执行）。配色修复**缩小了影响面但没有单独关闭它** |
| `--dsw-alias-state-error-tertiary` 降级 | 见 §7.6 末 |
| `/winstage show`（第 3 条退路） | **故意未做**：需改 `host-plugin.mjs`（原不在写范围），且命令面曾静默失效。前两条退路（chip + 设置开关）已让用户不再卡住 |

### 7.8 分级显示（用户两次追加反馈，均已浏览器实测）

**等级映射（定死）**：**L1 = `normal`（工作区内）· L2 = `outside`（工作区外）· L3 = `sensitive`（敏感）**；
`safety:"danger"` 是 **L3 里更严的一档，不新增第四组**。零档不列；截断时数字带 `+`；全零不显示。

| 位置 | 实测文本（逐码位一致） |
|---|---|
| **收起后的 chip** | `WinStage 待审 · 3（L1 1 · L2 1 · L3 1 · 危险 1）` |
| **展开后的标题条** | `3 个文件（L1 1 · L2 1 · L3 1 · 危险 1）` |
| **三个组头** | `L1 · 工作区内（1）` / `L2 · 工作区外（1）` / `L3 · 敏感（1）` |

- chip 与标题条**共用同一个 `levelCounts()`**（没有第二套算法）；`danger` 取子计数不重复计；
  截断时取 `max(派生, 声明)` 并带 `+`（`B17` 用"声明 7 / 列表只 1 条"的输入证明它在用声明值）。
- chip 的 `title`（**同时出现在 AX 的 `description`，读屏可读**）：
  `分级：L1 = 工作区内 · L2 = 工作区外 · L3 = 敏感（"危险"是 L3 里更严的子档）。数字为全量计数，带 + 表示列表已截断。`
- **AX 形态**：组头是 `['L1']['工作区内']['(1)']` **三个独立节点**（不是连写）；DOM 侧 `flex + gap:6px`，
  `innerText` 渲染为 `L1 工作区内 (1)`。两种形态都留档（`t4-levels.txt`）。
- **对比度**：新徽章进入测量列表且达标 —— `SPAN 'L1'` light **18.8965** / dark **13.3362**；标题条 17.4828 / 14.7932；
  light/dark 各 **37 项 0 失败**（min 15.5219 / 11.9076）。新增 `D4b` 断言"徽章确实在测量列表里"，
  防止它变成新的对比度盲区。
- **设计内限制**：chip 为 `nowrap + ellipsis`，档位多/数字大时会被省略号截断（不换行、不撑破）。

**一个易被误判为 bug 的现象（已查清，是设计）**：`src/workspace.mjs:502-508` 的 `ensureEntry` 对**已存在条目直接早退**
（注释逐字："幂等：已暂存路径不重复暂存 #3.10"）⇒ 重建 fixture 时若某个文件已被批准落盘过，那条历史条目的
`baseHash` 会停在旧值、再写同内容被判 `changed:false`，该档就从快照里消失。**不是缺陷**；办法是先摘掉历史条目再重新暂存。

## 8. 已知边界（DSH 侧设计，非本插件缺陷，但用户应当知道）

`ctx.remote.workspaceFiles.read` **不做工作区包含校验**：`dsh-api-workspace-files` 类文档逐字写明读面
"including paths outside the workspace … **not a read-containment restriction**"；实现上
`read`/`readBytes`/`stat` 走不调 `confine()` 的 `locateFile`，只有 `list` 调 `confine()`。
`[实测]`：会话 A 的 scope 能读到会话 B 的文件、也能读 `C:\Windows\win.ini`；同一越界目录 `list` 被拒。

**边界**：前置四条件缺一不可（可解析会话 id、`/api` 认证、Host/Origin 围栏、后端读权限），门槛是
"能读 `$DSH_HOME` 或以该用户身份运行" —— 即**已经等于代码执行权**；**远程/LAN 默认不能**（绑回环、
`--host 0.0.0.0` 硬拒、SameSite=Strict 且受众绑定 authority）。
⇒ "本机同用户"级别的暴露面，不是远程接口。复现见 [dsh2-越界读复现.md](dsh2-越界读复现.md)。

