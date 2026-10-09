# DSH 集成：暂存审批悬浮窗（实测记录）

本文件记录把 WinStageSandbox 接进 DeepSeek Harness 的实际装配、验证证据、
**已知崩溃风险**与残余边界。所有结论都标了证据来源；没有实测的部分明确写"未实测"。

> **2026-09-28 第二实例实测后的更正（重要）**：本文档 §1 / §3.3 / §4 / §5 的部分结论
> 已被"独立第二实例 + 真实浏览器"的实测**修正或推翻**。更正处的证据在
> [dsh2-需求与验收.md](dsh2-需求与验收.md)、[dsh2-基线报告.md](dsh2-基线报告.md)、
> [dsh2-修复报告.md](dsh2-修复报告.md)、[.t/dsh2/T4-browser-report.md](../.t/dsh2/T4-browser-report.md)。
> 逐条更正对照见本文档 **§9**。

---

## 1. 现在的装配（两条 Host 行 + 一个 Client 半）

| loader 行 / `id` | 模块 | 职责 |
|---|---|---|
| `winstage-sandbox` | `dsh-plugin/host-plugin.mjs` | 审阅服务（快照发布）、`/winstage` 命令族、启动能力探测、设置开关 |
| `winstage-fs` | `dsh-plugin/fs-entry.mjs` → `staging-fs.mjs` | **`ctx.fs` 的唯一提供方，一个提供方两种面**：开关**开** = 暂存面（`writeText`/`editText` 落暂存树，读取命中暂存条目走投影）；开关**关** = 每个覆盖层直接 `super.*`，**原样退回平台 `SandboxedFileSystem` 的面**（围栏/`FS_SANDBOX_DENIED`/升权提示/`sandboxMode` 全一致） |
| （Client 半） | `dsh-plugin/client.js` | 设置行 + **审阅悬浮窗**（`conversation.composer`，priority 20） |

`cordis.patch.yml` 里的三项装配：

```yaml
- id: fs-sandbox
  name: '@deepseek-ai/dsh-fs-sandbox'
  disabled: true          # 同一服务名重复注册会硬失败，所以"替换"必须写成"禁用 + 插入"；
                          # 开关**不**在这里切行（行级热切换 = 提供方回收竞争 = 崩），
                          # 只切 `staging-fs.mjs` 里 `stagingEnabled()` 决定的面 —— 见 §10
- insert:
    - id: winstage-sandbox
      name: '@local/dsh-winstage-sandbox'        # ★ 必须是裸包名，见下
    - id: winstage-fs
      name: '@local/dsh-winstage-sandbox/fs'     # ★ 必须保留子路径，见下
```

### 1.1 ★ 行名规则（2026-09-28 更正：原"子路径 specifier"写法是**错的**）

原文在此处写"为什么行名是子路径 specifier"，理由（loader 按模块 URL 缓存）**成立但不适用于 host 行**，
而且它带来一个**致命副作用**：**Client 半永远不会被下发**。

```
dsh-client-modules/lib/index.js
  :82-88  exactPackageSpecifier('@scope/name/sub') → undefined（三段 specifier 不被认作包根）
  :747    locatePkgJson: !pathLike && expectedPackageName === undefined → return undefined
  :836    processOne 只处理 entry.options.name === entryName 的行 ⇒ 该行产不出 client bundle
```

⇒ 原写法下 `dsh.client`（`platform`/`immediately`/`inject`）写得再对也没用，
**审阅悬浮窗永远不会出现，刷新多少次都不会**（原 §3.3 的"页面还没刷新"归因**不成立**）。

**正确规则（两条都要记）：**

| 行 | 行名 | 为什么 |
|---|---|---|
| `winstage-sandbox`（host 半） | **裸包名** `@local/dsh-winstage-sandbox` | `exports["."]` 与 `exports["./host-plugin"]` 指向**同一模块** `./host-plugin.mjs` ⇒ 换裸名不产生二次 `apply()`，却让 client-modules 能定位 `package.json` 的 `dsh.client`。代价：丢掉"换 specifier 免重启加载新代码"的开发期技巧，**改 composition 后必须重启** |
| `winstage-fs`（fs 半） | **保留** `@local/dsh-winstage-sandbox/fs` | 裸名解析到 `exports["."]` = host-plugin ⇒ 会把 `host-plugin` **apply 两次**（命令 `definitionId` 冲突）。fs 半不需要 client 半，所以它保持子路径是**正确**的 |

**一个连带的层序陷阱（会导致真实工作区被写）**：非 insert 补丁里的 `name` 是**断言**，
不匹配时 `cordis-plugin-include/lib/index.js:95-98` 会 `warn(...); continue`，
即**整条补丁连同它的 `config` 一起被静默跳过**（启动期**不告警**）。
所以**改 bundle 行名时必须同步改所有 profile 覆盖层里的同名行**：
`.t\dsh2\home\profiles\dsh2\cordis.patch.yml` 就因此丢过 `workspaceRoot` 覆盖，
导致 3081 回落到项目根、`.dshstage` 被写进真实工作区（实测事故 INC-1，仅 1 个快照文件被写，无状态损坏）。

**同一条机制的第二个形态**：`cordis-plugin-include/lib/index.js:99-102` 对 `config` 是
**整体替换、不是深合并** ⇒ **profile 覆盖层必须重述该行 config 的所有键**；未写的键不会继承，
而是**静默消失**。实测后果：profile 只写了 `cwd`，导致 `staging-fs.mjs` 的"两键漂移 fail-closed 守卫"
第一项恒假、**永不触发**（"写了防护但其实没生效"）。


---

## 2. 数据通路（为什么不用新的 Remote 命名空间）

Client **无法**注册新的 `ctx.remote.<命名空间>`：能力选集是构建期产物
（`@deepseek-ai/dsh-api-remotes` 的 README 逐字："Client 不会在运行时发现 Host 中已启用的
服务或 Remote 定义"）。因此面板用两条**已有**通道：

| 方向 | 通道 | 说明 |
|---|---|---|
| 读 | `ctx.remote.workspaceFiles.read` | Host 把快照写成 `<workspaceRoot>/.dshstage/review.json`；面板每 1.5 s 读一次 |
| 写 | `ctx.remote.commands.execute` | 面板按钮执行 `/winstage approve …` / `/winstage reject …`；命令**不产生模型消息** |

悬浮窗挂在 `conversation.composer`（chain 槽位，契约是 `select: (owner) => unknown | null`，
条目按 priority 升序询问，第一个非 null 的接管输入框）。内置审批面板用的是同一槽位
（priority 1），所以本面板用 priority 20：审批优先，本面板次之。

---

## 3. 已验证的部分（实测证据）

### 3.1 离线自测（不依赖 DSH，可重复跑）

| 脚本 | 断言 | 结果 |
|---|---|---|
| `.t/review-selftest.mjs` | 26 | 全通过：暂存不改真实文件、快照内容、拒绝退回真实磁盘、批准才写盘、选择性批准、新建文件拒绝后彻底消失 |
| `.t/staging-fs-selftest.mjs` | 31 | 全通过：`writeText`/`stat` 版本一致、intent（`FS_STALE_VERSION`/`FS_NOT_OBSERVED`）、字面编辑错误码、CRLF 保留、目录合并（含只在暂存里存在的目录）、与审阅服务串起来 |
| `.t/command-selftest.mjs` | 22 | 全通过：6 条命令注册、`list`/`diff` 输出、**只批准指定文件**、拒绝、未知路径报错而不误批、含空格路径用引号表达、未知子命令报错 |

```powershell
node .t\review-selftest.mjs
node .t\staging-fs-selftest.mjs
node .t\command-selftest.mjs
```

### 3.2 在线实测（真实运行中的 DSH 会话）

| 动作 | 观察到的结果 |
|---|---|
| `write` 工具新建 `.t/staged-demo.txt` | 工具报告成功；`Test-Path` **False**（真实文件不存在）；内容出现在 `.dshstage/staged/`；`review.json` 报 `pending=true`，候选 `cs_0001_…`，diff 三行 `+` |
| `read` 工具读同一路径 | 返回**暂存内容**（统一视图成立） |
| `edit` 工具把 `v1` 改成 `v2` | 真实文件仍不存在；暂存内容变 v2；候选 `cs_0001` 被 `cs_0002` **取代**（手册 #3.8/#12.3 语义） |
| 批准（走 `ReviewService.approve()`，与 `/winstage approve` 同一代码路径） | `{"approved":2,"failed":[]}`；两个文件出现在真实磁盘 |
| 进程稳定性探针（75 s） | 同一 PID（10664）存活，功能全开 |

### 3.3 ~~一处尚未可视化确认~~ → **已闭环（2026-09-28 更正）**

**原文（保留作对照）**：我无法截图、也无法读取浏览器控制台。`conversation.composer` 的在线检查
显示该槽位当时仍只有内置的 3 个占用者 —— 因为**页面还没刷新**。因此面板的视觉效果未确认。

**更正**：这条归因**不成立**。真正原因是 §1.1 的行名规则 ⇒ **Client 半从未进入
`window.__DSH_BOOT__`**，所以**刷新任意次都不会出现**。
在独立第二实例（3081）+ 真实浏览器（Edge 154，headless 与有头各一轮）上的实测结果：

| 判据 | 修前 | 修后 |
|---|---|---|
| `__DSH_BOOT__` 含本包 | ❌ 65 entries 里 `@local` **命中 0** | ✅ 命中 1（`immediately:true`） |
| 全新加载后面板自现（**无任何交互**） | ❌ AX 命中 0，等 10 s 仍 0 | ✅ headless **1.9 s** 出现；有头首轮即 11 命中 |
| `commands/list` 含 `/winstage*` | ❌ 0 条 | ✅ **6 条** |
| `/winstage status` 与乱码命令 | ❌ **逐字同形**（都 `value=null`） | ✅ 带 `value`，与 `/definitely-not-a-command-xyz` **可区分** |
| 「批准所选」 | ❌ `review.json` 零变化、无文件落盘 | ✅ `pending true→false`、`files 1→0`，且 `stage-probe.txt` **真落盘** |
| 「暂时收起」 | ❌ 点中仍 11 命中 | ✅ 面板消失；新快照到来重现 |

截图：`.t/dsh2/browser/r2-headful-a-fixed.png`、`r2-headless-a-fixed.png`、
`r2-headful-after-approve-selected.png`。**面板能出现的前置条件（都是必要项）**：
① 关掉首次运行的「内测声明」模态；② 必须有工作区 + 会话；③ composer 需要一次**应用内重新挂载**
（这一条已由 §3.4 的修复消除）。

### 3.4 浏览器实测额外炸出的三个缺陷（已修，附根因）

面板"能看见"**不等于**"能用"。在 `全选 / 清空选择` **可用**（阴性对照，排除"没点到"）的前提下，
发现三个控件**静默失效**：

| 缺陷 | 根因 | 修法 |
|---|---|---|
| **B（致命）** `/winstage*` 未注册 ⇒ 批准/拒绝静默失效 | `input: { placeholder: … }`，而 `dsh-commands/lib/index.js:154-163 normalizeDefinition()` 要求 **`hint`** ⇒ 第一条 spec 即抛 `TypeError: command "winstage" input hint must be a string` ⇒ 整个 `ctx.inject(['commands'], …)` 回调死掉 ⇒ **6 条一条都没注册**。面板 `act()` 拿到 `undefined`，静默无效果 | 改 `hint`；注册包进 `try/catch` + **error 级日志**（这族命令原先消失时**毫无提示**）。`ctx.inject(['commands'], cb)` 在根 ctx 上**足够**（`cordis:1600-1606` 即 `plugin({inject, apply})`；平台自带 `dsh-permission-presets:206`、`dsh-plan-mode:180` 用同一模式） |
| **A** 页面加载/刷新**不挂载**面板 | `conversation.composer` 是 chain 槽位，锚点订阅**槽位版本**、只在**渲染时**调 `select`（`dsh-client-ui-renderer:1097/1163`）⇒ 模块级 `store` 变化不会让 `select` 重跑 | 只在"是否应当接管"**跃迁时**重挂一次注册（`register()`/disposer 是唯一公开的版本推进通道，各触发一次 `markDirty`，`ui-slots:223/240`）；判据抽成唯一实现供渲染期与轮询期共用 |
| **C** `暂时收起` 收不起自己 | 与 A 同根因 | 同 A |

**被源码否决的两个备选方向**（避免后人重试）：`ui-slots` 的 `store` 只是 **scope handle**，
全文没有 store→`markDirty` 路径；`ownerProps` 由宿主组装，第三方插件加不了字段。

### 3.5 一条曾被当成证据的假证据（务必引以为戒）

早期记录里的"**6 条命令已注册**"是在进程内**直接调用 `registerCommands()`** 得到的 ——
它**绕过**了 `normalizeDefinition()`，所以既能打印"6 条"、又掩盖了 `placeholder`/`hint` 的错误。
**"我调了函数"不等于"线上生效"**：能证明线上生效的只有"经真实服务 + 真实浏览器可区分"的断言
（例如 `/winstage status` 必须与 `/definitely-not-a-command-xyz` 行为可区分）。

---

## 4. 已知崩溃风险（本轮实测，必须正视）

- **在线启用/禁用这个 bundle 会让宿主进程退出。** 我在 12:49–12:50 两次调用
  `set_bundle` 都得到"调用被中断、结果未知"，随后出现新进程（12:50:10 启动）。
  机制上可解释：本 bundle 的补丁**替换核心 `ctx.fs` 服务**，重载事务里
  `provide('fs')` 与旧提供方的回收存在竞争，而 cordis 对重复注册是**硬失败**
  （`service "fs" has been registered at <...>`）。
- **稳态是稳定的**：12:50:10 启动的进程在功能全开（含 `ctx.fs` 替换）下存活 5 分半以上。
  2026-09-28 在第二实例上多次"重启加载同一条装配"均正常（含 `sync` 后重启共 4 次），
  每次都 `bindFree=true` → 起来 → `stderr 0 字节`。
- **结论**：不要在线切换该 bundle；**改 composition 后请重启 dsh**（重启加载同一条装配正常）。
- **2026-09-29 补充（开关修复）**：设置页那个开关**不再**卸载/重挂任何 loader 行 —— 它只切
  `winstage-fs` 行的"面"（开 = 暂存，关 = 原样退回平台沙箱/审批）。因此**切开关本身不触发
  上面这条提供方回收竞争**；但**改插件源码**仍受"loader 按模块 URL 缓存"约束，需要重启 dsh
  （或换一个从未导入过的 specifier）。完整说明与证据见 §10。
- **既有隐患（早于本次改动）**：当时进程的启动日志里有
  `listen EADDRINUSE 127.0.0.1:3081`、`hmr config reload … failed`、`HMR is disposed`。
  第二实例实测给这件事补了一个解释：**3080 那次 3081 端口冲突就是本文档自己的第二实例**
  （或同类实例）占了端口。**HMR 失效本身与插件无关**（该 profile 从启动起就坏），
  所以"改 composition 必须重启"这条结论仍然成立、且**不能**指望 HMR 帮忙。
- **本轮另发现两个非插件的环境限制**（与崩溃无关，但会误导排查）：
  受限令牌沙箱**不允许建目录符号链接**（`pnpm link:` 落成 junction，Node 的 JS 层不跟随 ⇒
  只能物理复制部署，代价是"部署即快照"）；且**常驻进程必须挂在一个不退出的监督进程上**
  （`detached+unref` 的进程在工具调用返回后即被回收）。

---

## 5. 残余边界（按 2026-09-28 实测更新状态）

| 编号 | 边界 | 状态与说明 |
|---|---|---|
| S1 | **shell 写入不经过暂存** | **仍然存在，且本机不可能实现**。`[实测]` `pwsh`/`bash` 走 `ctx.shell` → `ctx.subprocess`（真实 cwd），与 `ctx.fs` 完全无关。要覆盖它必须替换 `ctx.shell`（`dsh-plugin/provider.mjs` 那个适配层），但：①受限令牌在本机谱系创建不出（R6）；②`provider.mjs` **全仓无人引用**，且它 import 的 `dsh-plugin/bridge.mjs` **文件不存在**。⇒ 如实标注为**未提供**，前提 = 不受限会话 + 真正接进 `ctx.sandbox` |
| S2 | ~~工作区外写入默认直通~~ → **已改为默认 `deny`** | `[实测]` 默认值改为 `deny`，`WINSTAGE_STAGE_OUTSIDE=direct` 可显式放开。判别证据：插件拒绝 = `FsError`/`FS_SANDBOX_DENIED`；外层沙箱拒绝 = `EPERM`/非 `FsError` ⇒ 两者可区分。`[引用]` 改 `deny` **不会破坏 DSH 自身落盘**：会话日志/附件/spill/storage 全走 `node:fs`，经 `ctx.fs` 写的只有模型面 `write`/`edit`。**注意**：受限会话里外层沙箱本身就先拒工作区外写入，所以插件行为的判别必须靠插件专属错误码，不能靠 `EPERM` |
| S3 | 面板靠轮询 | 仍然存在（机制约束）。**补充**：轮询本身不会清掉面板里的勾选状态（稳态 8 次 refresh 不重挂注册，已断言） |
| S4 | 暂存不是内核边界 | 仍然存在：可信代码里的**策略围栏**，不是内核隔离 |
| S5 | ~~面板视觉未确认~~ → **已闭环** | 见 §3.3。headless + 有头**双证据**，且批准真的落盘 |
| S6 | 在线切换 bundle 会崩 | 仍然存在（**仅指**增删/启停 bundle 或换 `fs` 提供方行）；设置里的开关只切"面"，不碰行 —— 见 §10 |
| S7 | ~~`watch()` 不覆盖暂存~~ → **已实现覆写** | 覆写 `watch()`：超类观察者照旧 + 暂存变更本地失效。**残留**：跨进程改动仍不可见（需文档标注）。`[引用]` 契约是"失效通知"（无事件类型/路径），唯一消费者是 `ctx.remote.workspaceFiles.changes` |
| **S8** | **新增：两个"根"的配置漂移** | host 行用 `config.workspaceRoot`、fs 行用 `config.cwd` 表达同一个暂存根；不一致会产生两个 `getReviewService()` 单例 ⇒"暂存写到 A、快照发布在 B"。已用 YAML 锚点做结构性同源 + `staging-fs.mjs` fail-closed 守卫；**但守卫只在两键都给时生效**，而 profile 覆盖层对 `config` 是**整体替换** ⇒ 覆盖层必须重述所有键（见 §1.1） |
| **S9** | **新增：跨工作区串台** | `workspaceFiles.read` **不做包含校验**（见 §7），所以 client 侧一旦"根选错"，结果不是"读不到"而是"**读到别的工作区的快照并渲染出来**"。已修：client 兜底必须落在 config 根之内，并用 `review.json` 自带的 `workspaceRoot` 做零额外 IO 的自校验 |


---

## 6. 怎么用

```text
/winstage                       查看待审清单
/winstage diff <路径>            看某个文件的改动
/winstage approve [路径…]        写入真实工作区（省略路径 = 全部）
/winstage approve --rebase […]   先把"基线已过期"的对齐到真实文件，再写入
/winstage reject [路径…]         退回真实磁盘（省略路径 = 全部）
/winstage rebase [路径…]         以真实文件为基线重新暂存（基线过期时；不改暂存内容）
/winstage refresh                重新发布审阅快照
```

等价命令：`/winstage-status`、`/winstage-diff`、`/winstage-approve`、`/winstage-reject`、
`/winstage-rebase`、`/winstage-refresh`。路径含空格时用双引号包住（`/winstage approve "a b.txt"`）。
开关类参数：`--rebase`（先把基线过期的对齐到真实文件）、`--force`（跳过 #12.1 的基线检查，
直接覆盖；两者可并用，见 §11）。

悬浮窗出现时（有待审改动）会接管输入框：勾选文件 → 「批准所选」；或「批准全部」/
「拒绝全部」；不想现在处理就点「暂时收起」（收起只对当前这一版快照生效）。
设置页的「WinStage 沙箱」开关是本 bundle 的**总闸**：**关** = 暂存面整体退回平台自带的
沙箱/审批模式（不再有暂存候选，读/写/目录枚举全部走真实磁盘），审阅悬浮窗与常驻入口
一并卸载；**开** = 暂存面接管。关掉后 `/winstage*` 命令仍然可见，但会**如实拒绝执行**
（不是静默消失）。两种状态都不需要重启。

---

## 7. 已知的 DSH 侧边界（不是本插件缺陷，但决定了本插件的能力上限）

### 7.1 `workspaceFiles.read` 不做工作区包含校验（`[实测]`）

`@deepseek-ai/dsh-api-workspace-files` 的类文档**逐字**写明读面
"including paths outside the workspace … **not a read-containment restriction**"；
实现上 `read`/`readBytes`/`stat` 都走**不调用 `confine()`** 的 `locateFile`，
只有 `list` 调 `confine()`。

复现（一条命令、三行铁证）：`node .t\dsh2\probe\c6-workspacefiles-read-escape.mjs`

```
PROOF session-A-scope read session-B file -> "content-of-session-B"
PROOF session-A-scope read C:\Windows\win.ini -> "; for 16-bit app support…"
PROOF same scope list session-B dir -> workspace-file/outside-workspace   ← 同一目录 list 被拒、read 成功
```

**前置四条件缺一不可**：可解析的会话 id、`/api` 认证、Host/Origin 围栏、后端读权限。
签名密钥落在 `$DSH_HOME\.credentials.yaml`，所以门槛是**"能读 `$DSH_HOME` 或以该用户身份运行"**
—— 即**已经等于代码执行权**。**远程/LAN 默认不能**（绑 `127.0.0.1`、`--host 0.0.0.0` 硬拒、
`SameSite=Strict` 且签名受众绑定 authority）。⇒ **"本机同用户"级别的暴露面，不是远程接口。**
完整分析见 [dsh2-越界读复现.md](dsh2-越界读复现.md)。

**对本插件的直接影响**：这正是 S9（串台）为什么"根选错"不会表现为"读不到"，而是
"**把别的工作区的快照渲染出来**"。

### 7.2 其它会误导排查的环境事实（`[实测]`）

| 事实 | 后果 |
|---|---|
| 本机 Chromium 在本 Agent 沙箱内**起不来**：Mojo IPC 需命名管道 → `FATAL platform_channel.cc:187 Check failed: Access denied`（`--single-process`/`--no-sandbox`/两种 headless 全试过） | 想做浏览器验收，**必须在沙箱外的终端启动浏览器**，再用 CDP 从会话内操作。Runbook 见 [.t/dsh2/S5-浏览器Runbook.md](../.t/dsh2/S5-浏览器Runbook.md) |
| 受限令牌**不允许建目录符号链接**（EPERM）⇒ `pnpm link:` 落成 junction（`cmd /c dir /AL` 实测：`<JUNCTION> dsh-winstage-sandbox [C:\...\dsh-plugin]`） | 曾据此得出"插件只能物理复制部署" |
| ⚠ **上一条的"Node 不跟随 junction"在 Node v24 上已不成立**（2026-09-30 复测，见 §12.6）：`fs.readlinkSync(junction)` 正常返回目标、`fs.realpathSync` 解析到工作区、读文件逐字节一致（`client.js` 两边同为 132140 B / 同一 sha256） | 当前部署**就是** link：改工作区源码 = 改 profile 模块路径，**不需要 install_bundle**（在线 install 会回 `changed:false` + `ambiguous-install`）。但"改了就生效"仍**不成立**：打包态 HMR `root: []`（不 watch 产物），client 图启动时组合一次 ⇒ 改 **client 半**需要**重启宿主**（见 §12.6） |
| 常驻进程必须挂在**不退出的监督进程**上（`detached+unref` 的进程在工具调用返回后即被回收） | 启动脚本要写成一个不退出的小进程，并以后台作业运行 |
| 宿主里 `commands.list()` 是**按 agent 作用域**解析的；`ctx.inject(['commands'], cb)` 在根 ctx 上**足够**（平台自带插件同模式） | 命令"注册失败"时要先查**定义是否合法**，不要先怀疑接线层（本轮 B 就是这么错过的） |

---

## 8. 开发期约束（踩过的坑）

1. **loader 按模块 URL 缓存**：改实现文件不会重载；**改 composition 后必须重启 dsh**
   （§1.1 讲了为什么 host 行**不能**再用"换 specifier"这个技巧）。
2. **在线替换核心服务有崩溃风险**：见 §4。
3. **`ctx.fs` 被替换后，本会话自己的 `write`/`edit` 工具也会被暂存** —— 也就是说
   代理改自己的源码时，真实文件不会立即变化。此时用 **shell**（`pwsh`）写盘，
   或先批准。`.t/approve-once.cjs` 就是为此准备的：它按同一代码路径调用
   `ReviewService.approve()` 把已暂存的内容落盘。
4. **不要在 shell 里做非 ASCII 源码的文本往返**（本项目缺陷 12 的教训）；
   用文件工具写，再批准。
5. **改 bundle 行名时，必须同步改所有 profile 覆盖层里的同名行**，
   否则那条覆盖会被**静默跳过**（连 `config` 一起丢）。见 §1.1。
6. **profile 覆盖层必须重述该行 config 的 `所有` 键**（`config` 是整体替换，不是深合并）。见 §1.1。
7. **"我调了函数"不等于"线上生效"**：命令注册、`ctx.fs` 替换、面板接管都必须用
   **经真实服务 + 真实浏览器可区分**的断言验收。见 §3.5。
8. **判"面板是否存在"不能用子串匹配**：`/winstage status` 的输出会**回显进聊天记录**，
   AX 里会出现 `button "winstage WinStage 暂存待审 …"` 这类**包含面板文案的回显节点**。
   必须用**精确名**匹配（面板自身名恰好是 `WinStage 暂存待审` / `暂时收起` 等）。
9. **`?winstageDebug=1` 的诊断 dump 是 `apply()` 时输出，不是实时轮询**：面板已正常显示后
   它里面仍写 `review:{"status":"idle"}`，**不可当"没接管"的证据**；它只适合判
   `containsMine`/`myFormStatus`。要让标志位生效，必须先装 cookie、再**单独 navigate** 到
   `/?winstageDebug=1`（`GET /?token=…` 返回 `Location: ./`，相对解析会**丢掉 query string**）。

---

## 9. 更正对照表（2026-09-28 实测 vs 原文）

| 原文位置 | 原结论 | 更正后 | 判定 |
|---|---|---|---|
| §1 行名 | host 行用**子路径 specifier**（为了免重启热加载） | host 行**必须**用裸包名；子路径写法导致 **Client 半永不下发** | `[实测]`+`[引用]` |
| §1 行名 | fs 行同样用子路径 | fs 行**保持**子路径是**正确**的（裸名会让 host-plugin 二次 apply） | `[引用]` |
| §3.3 | 面板未确认，因为"页面还没刷新" | **归因错误**。刷新任意次都不会出现；真实原因是 §1 的行名。修后 headless 1.9 s 自现 | `[实测]` |
| §3.3 | 面板"已可用"即算闭环 | 面板**能出现 ≠ 能用**：另外炸出 B（命令未注册，批准静默失效）/ A（首屏不挂载）/ C（收不起自己） | `[实测]` |
| §3 早期记录 | "6 条命令已注册" | **假证据**：进程内直调 `registerCommands()` 绕过了 `normalizeDefinition()`；线上实际 **0 条** | `[实测]` |
| §4 隐患 | `EADDRINUSE 127.0.0.1:3081`、HMR 失效"与崩溃未必无关" | 3081 端口冲突就是**本文档自己的第二实例**占的；HMR 从启动起就坏，与插件无关。"改 composition 必须重启"仍然成立 | `[实测]` |
| §5 S2 | 工作区外写入默认直通 | **默认已改 `deny`**，保留 `WINSTAGE_STAGE_OUTSIDE=direct` 放开 | `[实测]` |
| §5 S5 | 面板视觉未确认 | **已闭环**（headless + 有头双证据，且批准真落盘） | `[实测]` |
| §5 S7 | `watch()` 不覆盖暂存 | **已实现覆写**；残留：跨进程改动仍不可见 | `[实测]` |
| §5 | 只有 S1–S7 | 新增 **S8 配置漂移**、**S9 跨工作区串台** | `[引用]` |
| —— | 未记录 | 新增 §7：`workspaceFiles.read` **不做包含校验**（DSH 侧设计边界，非本插件缺陷） | `[实测]` |

**本轮修复涉及的代码文件**（均已部署到第二实例并复测）：
`cordis.patch.yml`、`host-plugin.mjs`、`client.js`、`staging-fs.mjs`、`fs-entry.mjs`。
每处的根因源码行号、前后 SHA256、回滚命令与断言原始输出见 [dsh2-修复报告.md](dsh2-修复报告.md)。
**注意**：这些改动**尚未提交 git**（本环境 PATH 上没有 git）。


---

## 10. 开关修复：关掉 = 退回原来的审批模式（2026-09-29）

### 10.1 缺陷（实测）

设置页把开关关掉（profile 补丁里 `winstage-sandbox.config.enabled: false`）之后：

- `host-plugin.mjs` 的 `apply()` 确实早退了，但那是**启动期**行为；`enabled` 是 volatile
  字段，设置页改它**不会重挂本行**，所以运行中的进程里命令面照旧注册；
- 真正的问题在 `ctx.fs`：补丁只把平台自带的 `fs-sandbox` 行 `disabled: true`，而
  `winstage-fs` 行**照常挂载**，于是暂存实现继续接管 `ctx.fs` —— 开关关了，写入却仍然
  进暂存树、读取仍然被**陈旧暂存投影**遮蔽。表现就是：
  - 工作区外的修改"写不进去"（进的是暂存树，不是真实磁盘）；
  - 快照里的旧条目已被后来的候选取代（superseded）⇒ 面板只给"已不在当前净 diff：
    暂存内容已被取代，无法再批准"的冻结行，用户既改不了也批不了；
  - **还有不可见的另一半**：批准过的条目**不会**从暂存清单里消失（`applyOneChange()`
    只把 `baseHash = stagedHash` 记为"已是新基线"，src/workspace.mjs:1002-1015）。此后真实
    文件若被外部（shell / 另一个进程 / 编辑器）改过，这条`stagedHash === baseHash`的条目
    在 `diffEntries()` 里是"无净变化"（所以面板什么都不显示），但旧投影只看 `entryOf()`，
    仍然拿**批准当时**的旧 blob 遮蔽真实磁盘 ⇒ `read` 看到陈旧内容、`write` 又拿它当基线。
    这正是"净 diff 是空的，却改不动"的机制。

### 10.2 修复

**一个提供方，两种面**（不切行）：

1. `staging-fs.mjs` 的基类默认就是平台的 `SandboxedFileSystem`（`createStagingFileSystem`
   的 `Base`），并新增 `stagingEnabled()`：**每次调用都现读** loader 行
   `winstage-sandbox` 的 `config.enabled`（`ctx.fiber.entry.parent.data` 是 patch
   组合后的那份；设置改动走 configEditor → reconcile → `EntryGroup.update()` 换整份）。
2. 每个覆盖层（`writeText`/`editText`/`watch`/`stat`/`lstat`/`readText`/`streamText`/
   `readBytes`/`readByteRange`/`listDir`）的第一行都是
   `if (!this.stagingEnabled()) return super.<method>(…)`。关掉时**逐字**走平台后端：
   策略围栏、`FS_SANDBOX_DENIED`、同回合升权提示、`sandboxMode` 广告全部与"没装本插件"一致。
3. `fs-entry.mjs` 显式 `base: SandboxedFileSystem`，并在定位不到该包时 **fail-closed**
   （绝不退化成"没有围栏的本地写"）。
4. `host-plugin.mjs` 的 `apply()` **不再早退**：命令面**始终注册**，每次执行现读开关，
   关时返回 `kind: 'error'` 的"已在设置中关闭"说明。这样"关掉再打开"不需要重启。
5. `client.js` 的轮询器在 `config.enabled === false` 时直接 `publish({status:'idle',
   snapshot:null, alert:null})`：审阅面板、常驻 chip 与轮询整体卸载，**不会**再拿上一版
   `review.json` 显示可点的"批准"。
6. **投影口径与净 diff 对齐**（`staging-fs.mjs` 新增 `projectsEntry()`，判据与
   `src/workspace.mjs:780 diffEntries()` 逐条相同）：`hasEntry`/`hasEntryUnder`/`currentOf`/
   合成目录/`listDir` 合并一概只认**构成净变化**的条目。没有这一条，即使开关关掉、面板
   卸载，`read` 仍会被"已批准后又被外部改过"的旧条目遮蔽 —— 用户看到的就是那句
   "暂存内容已被取代，无法再批准"。

### 10.3 为什么不做"行级热切换"

看起来更直观的做法是：关掉开关就 enable `fs-sandbox` 行、disable `winstage-fs` 行。
**不能这么做**：`fs` 同时只能有一个提供方，而 `EntryGroup.update()` 对同一层的 id
**并发** `create()`；被关掉那行的 `fiber.dispose()`（内部异步）不 await，新打开那行的
`provide('fs')` 可能先执行 ⇒ `service "fs" has been registered at <...>` 硬失败 ——
§4 记录的就是这一类崩溃。因此开关只切"面"，不切"行"。

### 10.4 证据（可重复跑）

```powershell
# ★ 前 4 项为**本轮 C2 复核**（本机本会话，`cmd /c node …`）逐条实跑的口径，标注即当次运行；
#   其余为主线上一轮时点口径，本轮未复跑 —— 引用时不要把两者混成同一天的数。
node .t\toggle-selftest.mjs          # 20/20（本轮实测，exit 0）：关=平台面、开=暂存面、现读换面、命令面拒绝、基类断言
node .t\default-on-selftest.mjs      # 11 PASS / 1 FAIL(L5b) / 2 PENDING-LIVE-FLIP（本轮实测，exit 1；见 §20.3）
node .t\shell-selftest.mjs           # 120/120（本轮实测，exit 0）：sandboxMode 恒报最窄档 + fail-closed 把关顺序
node .t\permission-slot-selftest.mjs # 45/45（本轮实测，exit 0；旧文写 14/14 是过期口径，见 §12.6）
# 以下为**上一轮**口径，本轮未复跑：
node .t\projection-selftest.mjs     # 14/14：批准后外部改动 ⇒ 读取必须回到真实磁盘（净 diff 口径）
node .t\loader-toggle-harness.mjs   # 10/10：**真 cordis loader** 上改 config 不重挂 fs fiber 且即刻换面
node .t\staging-fs-selftest.mjs     # 31/31（回归）
node .t\review-selftest.mjs         # 26/26（回归）
node .t\command-selftest.mjs        # 24/24（回归）
```

`.t/loader-toggle-harness.mjs` 值得单独说明：它用真 `@deepseek-ai/cordis` + `Loader` +
`Include` 起一个**临时**装配（假 host 行 + 仓库里真实的 `fs-entry.mjs`），走
`Entry.update({config:{patches}})`（= configEditor 的同一条路径）改开关，并以
**loader entry 的 `fiber.uid` 不变**证明"只换面、不重挂"。它还抓出过一个真实缺陷：
`ctx.<service>` 是 cordis 的 **traceable 代理**（`createTraceable` 把 `service.ctx` 改写为
**调用方** ctx），所以开关判定必须用**构造时抓住的** `rootEntry`，不能读 `this.ctx`。

**残余边界（如实标注）**：`stagingEnabled()` 读的是 loader 树里 `winstage-sandbox` 行的
`config.enabled`，因此它依赖"该行存在且 id 不变"。行被删除时默认 `true`（维持历史的
"接管"行为），而不是 fail-open 到平台面；改名/删除行时必须同步本文件与
`staging-fs.mjs`（已在 `cordis.patch.yml` 头部写明这条联动）。

**部署提示**：以上改动落在源码文件上；运行中的进程仍持有旧模块（loader 按模块 URL
缓存）。让修复生效需要**重启 dsh**，或把 `fs` 行的 specifier 换成一个从未导入过的子路径
（代价是首次重载即回到 §4 的提供方切换场景，故不推荐）。


---

## 11. 基线过期（STALE_BASELINE）与"视图一致性"（2026-09-29）

### 11.1 缺陷（实测输出）

多轮修改之后，批准会得到：

```text
已应用 0 项，失败 1 项
  ✗ .t\wcg\compare.mjs: STALE_BASELINE — real file changed since staging
    (expected absent, found be92694a3bb6…); refusing to overwrite
  仍在待审：.t\wcg\compare.mjs, C:\…\sbx-audit-…\T5-registry.md
  说明：真实文件在暂存之后被外部改动过，因此拒绝覆盖（手册 #12.1）。
```

拒绝本身是**故意的安全闸**（#12.1：绝不静默覆盖外部改动）。缺陷在于**视图**：

- 暂存条目是"相对某个基线的 diff"。基线被外部改动后（shell / 另一个进程 / 编辑器），
  面板仍然把它渲染成一条**可点的"批准"**，点了必然失败；
- 快照里**没有任何字段**说明"这条的基线已经过期"，所以用户既不知道原因，也没有出路
  —— 只能 reject（丢掉自己的暂存内容）。

### 11.2 修复：把真值搬进视图 + 给一条显式出路

1. **快照标注**（`review-service.mjs renderChange()`）：对每条可批准行，比较
   **候选冻结的 `change.before.hash`** 与真实文件当前 hash（与 `applyOneChange()` 的
   `STALE_BASELINE` 判据**同源**）。不一致 ⇒ `baselineStale: true` + `baseline:{expected,found}`；
   顶层 `counts.staleBaseline` 给汇总。面板据此显示「基线已过期」徽章与提示，
   CLI 的 `/winstage list` 逐行标 `[基线已过期 · 先 rebase]`。
2. **rebase 原语**（`/winstage rebase [路径…]`，`ReviewService.rebase()` +
   `Workspace.rebaseEntry()`）：把 `baseHash/baseKind` 换成磁盘当前值，
   **不改 `stagedHash`、不改 `state`** —— 这是重述基线，不是强制覆盖：
   - 真实内容 ≠ 暂存内容 ⇒ 变成一条新的、**可批准的** diff（before 现在是真实内容，
     用户看得见自己将要替换什么）；
   - 真实内容 == 暂存内容 ⇒ 无净变化，该行自动退出视图（连批准都不需要）。
   对齐后旧候选整份 discard（`affected` 规则，与 D2 同一条纪律），剩下的净 diff
   用 `ensureCandidate('rebase')` 重新冻结 —— 否则 diff 还是旧基线的、批准仍会失败。
3. **显式一步批准**：`/winstage approve --rebase [路径…]`（面板「重新对齐并批准所选」，
   与「批准所选」共用同一份 `authorizedPaths()`，不会多覆盖任何文件）。
   `--force` 仍然保留（跳过检查直接覆盖），但**默认路径不碰它**。
4. **Client**：行内「基线已过期」徽章 + 正文汇总 + 两个按钮（`重新对齐基线` /
   `重新对齐并批准所选`）。绝不隐式覆盖。

### 11.3 证据（可重复跑）

```powershell
node .t\rebase-selftest.mjs        # 25/25：标 stale / 默认拒绝 / rebase / 一步批准 / 工作区外 / 命令面
node .t\command-selftest.mjs       # 24/24（含 7 条命令的期望同步）
node .t\toggle-selftest.mjs        # 20/20
node .t\projection-selftest.mjs    # 14/14
```

`.t/rebase-selftest.mjs` 覆盖的两条关键语义："外部写入与暂存内容**相同**时，rebase 后该行
退出视图"（视图与现实一致，而不是留一条永远批不了的 create），以及"**工作区外**条目
（键 = 规范化绝对路径）同样适用"。

### 11.4 残余边界（如实标注）

- rebase 是**显式**动作：默认批准仍按 #12.1 拒绝覆盖外部改动。想一步完成就加
  `--rebase`（或点面板按钮）——那是用户明确表达"以我的暂存内容为准"。
- `--force` 连"记录基线"都不看，**只能在用户确认要用暂存内容覆盖外部改动时**使用。
- 面板对"基线已过期"的判定与 `applyOneChange` 同源（都是 `change.before.hash` vs 真实
  hash）。若真实文件在**点击批准与落盘之间**再次变化，仍会得到 STALE_BASELINE ——
  这是 #12.1 的最终一道闸，不做放宽。


---

## 12. composer 的「访问模式」控件：WinStage 开启时由沙箱按钮替换（2026-09-29）

### 12.1 需求与冲突

composer 工具行里那个按钮（`aria-label="访问模式，当前：工作区内修改"`，见
`@deepseek-ai/dsh-client-ui-permission-presets`）让用户选 read-only / workspace-write /
danger-full-access 与审批 ask/never。但 **WinStage 开启时，文件写入由暂存面接管**：
不管用户在平台控件里选哪个预设，`write`/`edit` 都先进暂存、等批准（预设对**文件面**的
效果被暂存面拦截）。那个按钮因此**只描述了一件不再成立的事** —— 需要替换的是
**元素和它的逻辑**。

> **修订（勿改回）：`sandboxMode` 的正确口径。** 本执行器的 `get sandboxMode()`
> （`dsh-plugin/shell-executor.mjs:783-785`）**报最窄可用档**（`return 'workspace-write'`），
> 且**恒定不变**：它不读调用方 spec、不读会话档位、不读审批策略。
> 这不是图省事，而是**实测挡下来**的 —— 本文件早期按"不广告升权"的思路把该值写成 `undefined`，
> 结果 `@deepseek-ai/dsh-permission-presets`（`dsh-base` 里、默认必装）**在装配期直接拒绝
> 装载 `permission` 行**（原始报错逐字见历史日志 `.t/e2e2.log:1-2`），`permissions` 投影随之
> 缺失 ⇒ 客户端 `PermissionSelect` 返回 `null` ⇒ composer 上的**访问模式控件整块消失**。
> 反过来，报一个模式并不会放大权限：本执行器**从不接受升权**
> （`dsh-plugin/shell-executor.mjs:898-941`：更宽档位只记 error 级日志 + 返还注记，
> 绝不改写语义）。两侧合起来才是现在的形态：**报最窄可用档 + 拒绝放大**。`[官方]`（读
> `@deepseek-ai/dsh-permission-presets` 的装配路径）+ 历史原始日志 `.t/e2e2.log:1-2`；
> 对应的源码级守门测试见 `tests/policy-never-consistency.mjs` 检查 2。

### 12.2 落点（读源码得到的槽位契约）

| 事实 | 出处 |
|---|---|
| 槽位 `conversation.input.permission`，kind **single**，scope session，`replaceRisk: shadows-shipped-ui` | 客户端 `Slots` inspect（`listSubTree` 的 exact root） |
| 平台条目注册在 **priority 0** | `dsh-client-ui-permission-presets/lib/client.js` 的 `ctx.slots.register({name:'conversation.input.permission', …}, PermissionSelect)` |
| 遮蔽规则：**最低 priority 渲染**；同 priority 注册**抛错** | `dsh-client-ui-slots/lib/index.js` 的 register 分支与 `entriesOfSlot()`；报错文案逐字：`register at a different priority to shadow it (lowest renders)` |

因此：**注册在 priority -10** ⇒ 开启即遮蔽平台控件；**撤销注册** ⇒ 平台控件原样回来。
（同 priority 会直接抛错，所以不能写 0。）

### 12.3 实现

`dsh-plugin/client.js`：

- 常量 `PERMISSION_PRIORITY = -10`；
- 组件 `WinStagePermission`：状态标签（`暂存待审 N` / `WinStage 暂存`，有基线过期时带
  `!` 角标）+ 自绘菜单：
  1. 有待审 ⇒「查看待审（N）」= 恢复审阅面板；没有待审 ⇒「刷新暂存快照」；
  2. 有基线过期 ⇒「重新对齐基线（N 项过期）」= `/winstage rebase`；
  3. 「关闭 WinStage 沙箱」= `form.set('enabled', false)` ⇒ 注册撤销 ⇒ **平台访问模式选择器回来**。
  控件全部自绘 + 主题 token（`--dsw-*`），**不 import 任何 Harness Client 包**；
  点外面关闭菜单用 `document` 的 mousedown 监听，只在打开时挂。
- 注册/撤销由开关真值驱动，**关闭立即恢复**：`sync()` 优先读 `ConfigForm.getSnapshot()`
  并订阅它（`ConfigForm.subscribe()`，见 dsh-client-ui-settings 的 config-form.d.ts:59）——
  设置页的写入会立刻 fold 回表单快照，因此 `enabled === false` 时**当场** dispose 注册，
  平台条目重新成为该 single 槽位的唯一赢家（元素与逻辑一起回来），不必等轮询周期；
  轮询器发布的 `store.state.enabled` 只作兜底信号（表单读不到时）。

### 12.4 证据

```powershell
node .t\permission-slot-selftest.mjs   # 45/45（本轮 C2 复核实测，exit 0；旧文写 14/14 是过期口径）
```

该套件用**真的** `@deepseek-ai/dsh-client-ui-slots` 的 `SlotCore` 起一个声明了该槽位的
最小账本，断言：平台条目是赢家 → 同 priority 注册抛错 → 注册 -10 后**只有** WinStage
条目渲染（平台条目仍在账本里）→ 撤销后平台条目原样回来；另有源码级断言（常量、注册选项、
组件名、关闭时撤销分支、不 import Harness 包）。

### 12.5 残余边界（如实标注）

- 只替换 **composer 上这一个入口**：平台的权限预设行仍在
  `settings.general.item`（id `permission`）里，可继续用来调整 **shell** 的沙箱与审批 ——
  WinStage 只接管**文件写入面**，这一点不能被"选择器不见了"误读。
- 平台条目仍在槽位账本里，只是被遮蔽（`entriesOfSlot` 取最低 priority 的赢家）。
  若平台插件有**不经该槽位渲染**的入口（快捷键/命令），它依然存在。
- 这是一个 `replaceRisk: shadows-shipped-ui` 的槽位：平台若改槽位契约或优先级语义，
  本插件会在 `slots.register` 处抛错并只打一条日志（`permission-slot takeover failed`），
  不会让整个 client 半加载失败。
- 开关初始状态**未知**时（Config 还在 `loading`、或命名空间 `unavailable`）**不注册** ——
  见下面的 §12.6。旧实现按"开"注册，最长一个轮询周期（1.5 s）后才纠正；那不只是"闪一下"：
  若命名空间始终不可用（宿主插件没装 / 本页看不到），它会**永久**盖住平台控件。

### 12.6 「关闭/未知沙箱不得覆盖原版审批弹窗」（用户诉求，2026-09-30）

用户原话：**"原版审批的弹窗关闭沙箱时不要覆盖掉"**。

#### 缺陷（结构性，不是时序抖动）
`conversation.input.permission` 是 `replaceRisk: shadows-shipped-ui` 的 **single** 槽位，
平台条目在 priority 0，WinStage 用 -10 遮蔽它（§12.2）。而旧的开关真值判定是：

```js
const readEnabled = () => {
  const snapshot = form && typeof form.getSnapshot === 'function' ? form.getSnapshot() : undefined
  const value = snapshot && snapshot.value ? snapshot.value : undefined
  if (value && typeof value.enabled === 'boolean') return value.enabled
  return store.state.enabled !== false     // ★ fail-open：读不到 = 当作"开"
}
```

`ConfigFormSnapshot.status` 的第三个值是 **`unavailable`**（"该命名空间没有暴露给本客户端"，
`config-form-types.d.ts:7-14`）。此时 `value` 为空 ⇒ 落到 `store.state.enabled !== false`
⇒ `undefined !== false` ⇒ **true** ⇒ 注册 -10 遮蔽 ⇒ **平台控件与它的预设弹窗被永久盖住**，
而沙箱其实根本没装/没生效。轮询器同样按"未知"继续读 `review.json` 并发布快照
（`if (configValue.enabled === false)` 只拦"明确关闭"），于是 composer 上的 WinStage 审阅卡
还可能顶掉平台自己的审批卡。

#### 修法：唯一的三态真值 + 只有 `'on'` 才接管平台 UI
`client.js` 新增唯一实现 `readSwitch(form)`：

| 快照 | 判定 | 平台 UI |
|---|---|---|
| `status==='ready'` 且 `value.enabled===true` | `'on'` | WinStage 可接管（唯一允许遮蔽的状态） |
| `status==='ready'` 且 `enabled` 非 true（false / 字段缺席） | `'off'` | 不接管，平台控件与弹窗原样 |
| `status==='loading'` / `'unavailable'` / 没有表单 | `'unknown'` | **不接管**（旧实现正是在这里 fail-open） |

三处一起收口，防止判据漂移：

1. 权限槽位：`readEnabled = () => readSwitch(form) === 'on'`（**严格等于 `'on'`** ——
   `'unknown'` 是真值字符串，少写这个比较就又变成 fail-open）；关闭/未知 ⇒ `dispose()`，
   平台条目立刻重新成为该 single 槽位的唯一赢家。仍由 `form.subscribe` 驱动 ⇒ **立即**恢复。
2. composer 审阅卡：`winstageElection()` 开头加 `if (store.state.enabled !== true) return null`。
3. 轮询器：`if (readSwitch(configForm) !== 'on')` ⇒ 不读 `review.json`、不发快照、`enabled:false`
   （因此常驻 chip 也不会渲染：它本来就要求 `pending && collapsed`）。

代价只有一个：Config 读回前不再"抢先"接管，晚一拍（`ready` 后立刻接管）。
方向选择是刻意的：**宁可晚一拍，也不覆盖平台 UI** —— "沙箱没生效"绝不能表现成"平台弹窗不见了"。

#### 证据（离线，真代码真槽位）

```powershell
node .t\permission-slot-selftest.mjs    # 45/45（含三态真值表 + 变异自证；本轮 C2 复核实测，exit 0）
node .t\permission-tristate-apply.mjs   # 19/19（把 client.js 的 factory/apply 真跑起来）
```

`permission-tristate-apply.mjs` 把 `dsh-plugin/client.js` 的 `factory(require)`/`apply(ctx)`
真的执行（stub `window.__ModuleLoader__` / `require('react')` / cordis ctx / `configForms`），
槽位账本用**真的** `@deepseek-ai/dsh-client-ui-slots` 的 `SlotCore`，逐状态断言赢家：

```
初始 loading（未知）⇒ 平台控件是赢家
ready + enabled=false（关闭）⇒ 平台控件是赢家
ready + enabled=true（开启）⇒ WinStage 接管
关闭 ⇒ 立即恢复平台控件（form.subscribe 驱动）
unavailable（宿主插件没装）⇒ 平台控件是赢家     ← 旧 fail-open 会永久遮蔽
非 on 状态下一次都没有读过 review.json
卸载（插件停用/热卸载）后平台控件原样回来 + 不再轮询
```

`permission-slot-selftest.mjs` §F 另做**变异自证**：把旧规则（读不到就当开）跑一遍，
断言它在 `unavailable` 下**确实会**遮蔽平台控件（红），再用新规则对同一输入撤销遮蔽（绿）——
两行成对，证明这组断言不是空转。

#### 生效方式与**已完成的实机验证**（2026-09-30 补测）

本 profile 的依赖是 **`link:`**，不是拷贝：

```json
// C:\Users\Administrator\.dsh\profiles\web\package.json
"@local/dsh-winstage-sandbox": "link:C:/Users/Administrator/Desktop/WinStageSandbox/dsh-plugin"
```

实测 `node_modules/@local/dsh-winstage-sandbox` 是**符号链接**：`realpath` 与工作区相同，
`client.js` 两边 sha256/大小逐字节一致（`132140 B`）。
⇒ **不需要 `install_bundle`**（这正是在线 `install_bundle` 返回 `changed:false` +
`ambiguous-install` 的原因：包已经以 link 形式在场，无物可装）。改工作区即改 profile 的模块路径。

实机（运行中的宿主 + 已连接的页面）两条证据：

```
cordis_inspect_query  platform=client  provider=Slots  root=conversation.input.permission
  kind=single  replaceRisk=shadows-shipped-ui
  occupants = [ { registrant: "mf", priority: 0, active: true } ]      ← 只有平台条目
  ⇒ 沙箱关闭时 WinStage 的 -10 条目**不在账本里**，平台控件与它的预设弹窗原样在场

cordis_inspect_query  platform=host  provider=Config  name=@local/dsh-winstage-sandbox
  entries = [ { id: "include:winstage-sandbox", status: "schema" } ]   ← 行已装配且带 schema
  ⇒ 客户端表单快照是 ready + enabled=false（与本插件三态判定的输入一致）
```

client-modules 的图是**启动时组合一次**的（`client-modules/lib/index.js:541` `this.composed = this.compose()`），
之后只有两条路径会重读产物：HMR 的 `rebuilt(id)`（`:601-602`「the HMR watch's registration hook —
the only entry point through which build changes reach the graph」）或 loader 重新激活
（`internal/plugin` → `dirty` → `flush()`）。而本 profile 走的是**打包态**，base bundle 把 HMR 配成：

```yaml
- id: hmr
  name: '@deepseek-ai/dsh-hmr'
  disabled: !!js "!ctx.get('profileContext')"
  config:
    root: []          # ← 空 = 不 watch 任何产物（dsh-base/cordis.patch.yml）
```

空 root ⇒ watcher 不 watch（`dsh-hmr/lib/index.js:439` `root.length === 0 ? "resolved"`），
`rebuilt()` 永远不会被调用 ⇒ 图的 rev 停在启动那一刻；`bundleResource` 又按
`pathname+search`（含 rev）缓存响应（`:958-972`），**第一次 GET 之后那份字节就冻住了**。

⇒ **只刷新页面不够，必须重启宿主**（重启时才 `flush()` 重新 stat/读取，得到新的 rev 与新字节）。
本页首次修正稿曾写"刷新即可、不必为它重启"，**那是错的**：那一条把 HMR 当成了常开。
重启后 `enabled: true` 那个开关也正好一起生效，顺序建议：
① 改 profile 第 45 行 `enabled: false → true`；② 重启 DSH；③ 页面重新打开；
④ 在设置里把开关关掉一次，观察 composer 上的控件立刻换回**平台**的访问模式控件（本诉求的端到端验证）。

**尚未做**：浏览器 daemon 未连接（`browser-use --doctor`：daemon not alive、0 连接），
本地直接 `fetch` 又需要 `dsh web` 打印的那个带鉴权的 URL（否则 401），所以**没有截图**。
两个零成本的自查：`.t/check-served-client.mjs "<dsh web 打印的完整 URL>"`（宿主现在发的是
工作区当前字节还是旧字节；脚本**不会**回显该 URL），以及上面第 ④ 步的人工观察。





---

## 13. 「默认收起」= **启动偏好**，不是"每一版新快照都收起"（2026-09-29）

### 13.1 缺陷（用户实测）

设置行里那个「默认收起」开关（localStorage `winstage.defaultCollapsed`）本意是"刚启动时
别弹我一脸"，但旧实现在**每一次轮询**都重新求值：

```js
if (!store.dismissed && (remembered === generatedAt || defaultCollapsed)) store.dismissed = generatedAt
```

而 `publish()` 每次都写新的 `generatedAt` ⇒ **每一轮 Turn / 每一次快照发布都会重新收起**。
"S3e：收起只对当前这一版生效"的自动恢复紧接着又被偏好压回去，结果是**开了这个开关就永远
打不开面板**（只能看 chip）。

### 13.2 修复：启动偏好只生效一次

- 判定收进**纯函数** `nextDismissed(state)`（client.js 里 `#region collapse-decision` /
  `#endregion` 之间，刻意不依赖 window/React，因此离线自测可以把这段**出厂源码切片求值**）；
- 规则（顺序有讲究）：
  1. 快照换代（`generatedAt` 变）⇒ 上一版的"收起"作废（**S3e 原语义不变**）；
  2. 「默认收起」只在**本次页面加载后的第一版有待审的快照**上生效**一次** —— 用 page 级
     标记 `store.defaultCollapseApplied` 记账（刷新即重置，这正是"只管刚启动"的定义）；
     第一版快照没有待审时**不消费**标记，留给第一版真正的待审快照；
  3. sessionStorage 记住的那一版仍按 `generatedAt` 精确匹配（跨刷新保持收起）。
- 设置行文案同步改成"只在页面加载后的第一版待审快照上默认收起；之后各轮按你的手势"。

### 13.3 证据

```powershell
node .t\collapse-selftest.mjs   # 17/17
```

该套件**切片求值 client.js 里的 `nextDismissed`**（不是复刻品），核心回归是：
"启动 + 偏好开 ⇒ 收起 G1 一次" → "第二轮 Turn（G2）⇒ **恢复展开**" → "第三轮同样不再收起"；
另含同一版重复轮询、用户手动收起、跨刷新记忆、偏好关、首版无待审不消费标记等边界，
以及"旧实现那一行已从源码消失"的断言。

### 13.4 残余边界

- 标记是 **page 级**：刷新页面（或重开标签）后，第一版有待审的快照会再次按偏好收起 ——
  这就是"刚启动时"的边界，不再往下延伸。
- 偏好本身仍是 localStorage（长期记忆），与"这一版是否收起"（sessionStorage + page 标记）
  是两个层次，不要混。


---

## 14. 不同会话的审批内容隔离（2026-09-29）

### 14.1 缺陷

`getReviewService()` 只按 canonical 工作区根做**进程内单例**，而存储固定写死
`<root>/.dshstage/`。于是同一工作区里的**所有会话共用一份** manifest/queue/blobs/staged/
`review.json`：

- A 会话的面板会列出 B 会话暂存的文件，`/winstage approve` 也会把 B 的内容一起批走；
- 两个会话改同一个文件时，后写的一方直接覆盖前者的暂存内容（连内容都分不清是谁的）。

### 14.2 修法：按会话分存储根

| 层 | 变更 |
|---|---|
| `src/store.mjs` | `Store(workspaceRoot, options)` 新增 `options.storeDir`（绝对路径）⇒ 存储根可覆盖 |
| `review-service.mjs` | 单例键 = `根#会话目录名`；会话目录 = `<root>/.dshstage/sessions/<key>`；`reviewPath()`/`publish()` 跟随该存储根 |
| `staging-fs.mjs` | **每次调用现解析会话**：写用 `sandboxPolicy.sessionId`（工具层按会话解析后随调用传入），读用 ambient `ctx.agents.currentInitiator()`（agent loop 用 `withInitiator` 包住整轮驱动，所以 read/stat/listDir 也有身份）；装配/自测可用 `createStagingFileSystem({ sessionId })` 固定 |
| `host-plugin.mjs` | `registerCommands` 接受"服务解析器"；生产传 `(invocation) => getReviewService({ sessionId: invocation.agent.session.id })`（`CommandInvocation.agent` 由 dsh-commands 明确给出）；不再启动时预热全局实例 |
| `client.js` | 读**自己会话**的快照：`<root>/.dshstage/sessions/<key>/review.json`（`sessionDirKey` 与 host 同规则，放在 `#region session-key` 切片里供测试比对）；无会话身份时退回共享路径 |

**会话目录名**（`sessionDirKey`）：常规 id（`session-<uuid>`）逐字使用；含可疑字符或超过
64 字符时压成 `s_<fnv1a32>_<长度>`，因此永远是一个安全的单层目录名，不会路径穿越。
host 与 client 各有一份实现 —— `.t/session-isolation-selftest.mjs` 对同一组输入断言两者相等。

**升级前的共享存储**：改造前的待审内容都写在 `<root>/.dshstage/` 根。第一个需要会话存储的
会话会**认领并搬走**它（同卷 `rename`，用 `.dshstage/sessions/.legacy-claimed` 的 `wx`
创建保证只认领一次），避免旧内容变成谁也看不见的孤儿；任何一步失败都保留原处、不阻断。

### 14.3 边界（如实标注）

- **隔离 ≠ 静默覆盖**：两个会话分别暂存同一路径时，各自读到自己那份内容；A 先批准后，
  B 再批准会拿到 `STALE_BASELINE`（手册 #12.1），要显式 `/winstage rebase` 才能覆盖 ——
  与 §11 那条修复是同一条闸门。
- **无会话身份时逐字保持旧布局**（`<root>/.dshstage/`）：CLI/agentless 调用、离线自测
  不受影响。
- 会话目录会随会话累积（每份含自己的 blobs/staged/candidates）；**尚无 GC**。
- 认领是 best-effort：若旧存储的某个目录被占用导致 `rename` 失败，它留在原处（不复制大文件）。

### 14.4 证据

```powershell
node .t\session-isolation-selftest.mjs   # 26/26
```

覆盖：两会话各自存储/快照/投影、A 批准不带走 B、**同路径**两边各读各写且 B 必须 rebase、
无会话时旧布局不变、旧共享存储被第一个会话认领且第二个不重复认领、host/client 目录名算法一致。


---

## 15. 命中敏感策略：弹窗说清后果 + 二次确认，不再死拦（2026-09-29）

### 15.1 缺陷

`applyCandidate()` 对**工作区内**的遮蔽（`maskOf()` 对工作区内的普通文件本来就豁免，
所以实际命中的就是 `.dshstage` 自身存储 / extraMasks）直接回 `SANDBOX_PATH_MASKED` 硬失败：
内容能暂存、面板能看见，但**永远批不回去** —— 用户要的"先弹窗说清后果、确认后写盘"没有出路。

### 15.2 修法：把"硬拒"换成"逐路径二次确认"

| 层 | 变更 |
|---|---|
| `src/workspace.mjs` | 命中工作区内遮蔽时：未确认 ⇒ 只回 `SANDBOX_PATH_MASKED_CONFIRM`（带 `maskId`/`reason`/`hard` + "写入真实磁盘且不可撤销"的后果说明），记进 `blockedByMask`，**不写盘**；已确认 ⇒ 正常 `applyOneChange`，并把 `{confirmed:true, hard}` 记进 `maskWarnings`。工作区**外**的遮蔽维持原语义（落盘 + 警告）。确认集合 `opts.confirmedMasks`：`true` = 本次全部，数组 = 逐路径 |
| `review-service.mjs` | `approve(paths, { confirmedMasks })` 透传 |
| `host-plugin.mjs` | `/winstage approve --confirm-mask [路径…]`：给了路径就确认这些路径，"批准全部"没给路径 ⇒ 确认本次全部；未确认时输出逐条后果 + 可直接重发的确认命令 |
| `client.js` | `approvePaths()` 闸门：选中项里 `safety` 非空 ⇒ 弹**二次确认弹窗**（逐条列路径 + 命中原因 + 危险档后果），点「我了解后果，确认写入」才发 `--confirm-mask`；普通项直接发 |

**为什么不是"点过一次就永久放行"**：确认是**逐次、逐路径**的（`confirmedMasks` 随该次调用），
所以下一次批准同一路径仍会再要一次确认 —— 面板的弹窗也因此每次都会出现。

### 15.3 边界（如实标注）

- **读侧的硬遮蔽不变**：`assertReadable()` 对命中遮蔽的路径仍然硬拒读取（#16.7/#16.8）。
  本次只改"批准已暂存内容"这一步。
- `.dshstage`（`stage-store`）在数据里仍带 `hard: true`：弹窗会显示**最强警告**
  （"可能是凭据/密钥或沙箱自身存储"）。批准它仍是允许的（用户明确确认之后），
  但覆盖引擎自身文件的后果请自行评估。
- `--confirm-mask` 是"我确认"，不是"白名单"：CLI 每次都显式带它才会落盘。

### 15.4 证据

```powershell
node .t\sensitive-confirm-selftest.mjs   # 27/27
```

覆盖：默认批准"0 应用 / 1 待确认 + 不写盘"、确认了别的路径仍然不写（逐路径闸门）、
二次确认后落盘且 `maskWarnings.confirmed && hard`、命令面不带/带 `--confirm-mask` 的两条路、
`maskOf()` 的豁免面不变（工作区内普通文件不判遮蔽、工作区外敏感仍走警告放行）、
client.js 弹窗存在且三个批准入口都经过它。


---

## 16. 暂存"分流"导致条目随 Turn 消失：自愈（2026-09-29）

### 16.1 现场证据

一条会话里同时存在**两份**存储：

| 存储 | 内容 | 谁在写 |
|---|---|---|
| `<root>/.dshstage/sessions/<会话id>/` | 认领过来的旧存储 + 会话级待审 | 拿到会话身份的调用 |
| `<root>/.dshstage/`（共享根） | 新落下的条目与它自己的 `review.json` | **拿不到会话身份**的调用（首要是**尚未重启的旧进程**） |

而面板只读自己会话目录的 `review.json` ⇒ 落在共享根的那些条目**在面板上看不到**；
随着每一轮 Turn 继续往共享根写，表现就是"未审批的条目一个个消失"。
`sessionIdOf()` 原先在拿不到身份时**静默**退回共享存储，所以这件事在日志里也看不见。

### 16.2 修法：会话级入口一律先"自愈"

`ReviewService.absorbSharedStore()`：只要共享根的 `manifest.json` 里有条目，就并进**当前
会话**的存储 ——

- 目标还没有 manifest ⇒ 整份搬（同卷 `rename`，失败退回复制）；
- 目标已有 manifest ⇒ 按**条目键**合并（目标优先），blobs / staged / staged-ext 只补缺失的；
- 并完清掉共享 `manifest.json`/`queue.json`/`candidates/`（候选会在下一次
  `ensureCandidate` 用当前净 diff 重新冻结）；
- 合并后立即 `publish()`，面板下一个轮询周期就能看到。

挂在三个"一定会话级"的入口上：`getReviewService()`（拿到会话服务时）、fs 的
`writeText`/`editText`、命令面 `serviceFor()`。
同时 `sessionIdOf()` 拿不到身份时**在日志里响一次**（"本次变更会落在共享存储……下一次
带会话身份的写会自动并入"），不再静默分流。

### 16.3 边界（如实标注）

- 共享根里的条目**没有归属信息**：第一个拿到会话身份的会话会把它们并走；若两个会话
  恰好同时自愈，理论上各拿一份副本（首个完成者删除共享 manifest）。这类条目本就是
  "无法归属"的遗留内容，宁可重复可见也不要静默消失。
- 自愈会**丢弃共享根的 queue/candidates**（保留净 diff）：候选是冻结快照，可由当前
  净 diff 重新冻结；净 diff 才是权威。
- 自愈是**声明式**的：拿不到会话身份的调用仍会写共享根（与升级前一致），但下一次
  会话级写/命令会把它并回来 —— 不再需要人工干预。

### 16.4 证据

```powershell
node .t\session-isolation-selftest.mjs   # 34/34（含自愈一节）
```

自愈一节复现了现场：先建与会话存储、再往共享根写一条（会话快照看不到）⇒ 断言
"拿不到身份会响一次日志" ⇒ 用带 `sessionId` 的写触发自愈 ⇒ 会话快照 = 共享条目 +
本次写入、共享 manifest 被清掉、再并一次为 0（幂等）、并进来的条目**可正常批准**
（blobs 已带过来）。


---

## 17. "批准全部点了没反应"：把静默失败全部显示出来（2026-09-29）

### 17.1 四个静默源（都在面板→命令这条路上）

1. `sendApprove()` **无条件**拼 `--confirm-mask`：宿主若是**尚未重启的旧进程**，不认识该开关
   ⇒ 回 `{kind:'error', text:'未知开关：…'}`；
2. `act()` **只处理 promise rejection**，命令返回的 `{kind:'error'}` 从不显示 ⇒ 点了像没点；
3. `approvePaths([])`（全是"仅存档"行、或高风险项未勾选/档位已变）**直接 return**；
4. 宿主侧"**0 应用 / 0 失败**"（选中路径不在最新候选里）也是一条 `kind:'success'` 的静默无效。

### 17.2 修法

- `approveCommandLine(paths, mode, confirm)`：纯函数（`#region approve-command` 切片，
  `.t/approve-button-selftest.mjs` 直接求值断言）。`--confirm-mask` **只在用户确实看过后果
  （弹窗确认）时**携带 —— 既诚实，也让普通批准在旧宿主上照常可用。
- `act()`：没有会话身份 ⇒ 显示 `noSession`；命令结果 `kind !== 'success'` ⇒ 把 `text` 显示到
  面板（无 text 时退回 `commandNoOp`）；promise 异常照旧显示。
- `approvePaths([])` ⇒ 显示 `nothingToApprove`（含"共 N 项 / 其中 M 项仅存档 / K 项高风险
  未勾选或档位已变"的计数），不再静默 return。
- 命令面：`approved === 0 && failed.length === 0` ⇒ 显式 `{kind:'error'}` + "选中路径不在最新
  候选里，请 `/winstage refresh` 后重试"。

### 17.3 证据

```powershell
node .t\approve-button-selftest.mjs   # 19/19
```

一半是**出厂源码切片**求值（普通批准不带 `--confirm-mask`、确认才带、`--rebase` 组合、
含空格路径加引号、`confirm` 只认严格 `true`），一半是源码级断言（三个"说出原因"的分支都在、
旧的无条件前缀已删）+ 一条**宿主级**断言（用 stub 服务把 `approved:0, failed:[]` 走一遍命令
handler，必须得到 `kind:'error'`）。

### 17.4 边界

- `--confirm-mask` 仍然是"用户确认过"的唯一凭据：普通批准不带它，敏感项必须先过弹窗
  （§15），服务器侧对工作区内遮蔽项照样有 `SANDBOX_PATH_MASKED_CONFIRM` 闸门。
- 面板把命令失败**原样**显示（不做翻译），文案以宿主为准。


---

## 18. 外部边界测试给出的两条：外工作区直通 + "覆盖层易失"核查（2026-09-29）

### 18.1 会话工作区 ≠ 插件配置的暂存根 ⇒ 不再"假暂存"

外部报告 §4：会话工作区是 `Desktop`，而本插件 Config 的 `workspaceRoot` 是
`Desktop\WinStageSandbox` ⇒ 该会话在工作区内的**任何**写入都被判 `external`：进了
（根不匹配的）待审存储、面板看不到、不批准不落盘，而工具回执仍是 `Created file` ——
这就是"回执不可信"的真正来源。

修法（`staging-fs.mjs`）：每次调用解析**会话工作区根**——
- 写：`sandboxPolicy.workspaceRoot`（策略服务按会话 cwd 解析）；
- 读/watch：ambient `ctx.agents.currentInitiator().session.header.cwd`（这两个面没有 policy 参数）；
- 与 `this.workspaceRoot` **不同** ⇒ 本会话的 10 个入口（write/edit/watch/stat/lstat/
  readText/streamText/readBytes/readByteRange/listDir）**直接 `super`**（平台沙箱/审批面），
  并只记一次日志说明"为什么这个会话不经过暂存"。
- 拿不到会话工作区（agentless 调用）⇒ 按"属于"处理，保持升级前行为。

于是：插件真正作用域内的会话照旧暂存；**作用域外的会话拿到的是真实磁盘语义**（回执与
磁盘一致），而不是"看不见的待审"。

### 18.2 "覆盖层易失 / 约 40 秒后候选被丢弃"：源码核查结论

`reconcileCandidates()` / `discardCandidate()` 的**全部**调用点只有两处：
`reject()`（用户拒绝，reason `user-rejected`）与 `_rebase()`（`/winstage rebase` 或
`approve --rebase`）。`discardCandidate()` 只改队列状态，**不回收内容**；插件与引擎里
**没有任何定时器**会丢弃候选（`setInterval/setTimeout` 只出现在与本插件无关的执行器/
测试服务里）。真正会让暂存内容消失的只有：

1. `revert()` —— 即"拒绝"路径（含"拒绝全部"）；
2. **同一路径被后来的写入取代**：暂存清单**一个路径只保留一版**，旧版本随之消失；
3. 写进了**另一个存储**（会话隔离前的"分流"，已由 §16 自愈处理；面板只读自己那份，
   看起来就像"消失了"）。

因此"内容最终哪里都不存在"要么是显式拒绝、要么是被后写取代，要么是分流；没有"40 秒自动
丢弃"这种机制。**残余边界**：同一路径的多轮改写只保留最后版本 —— 这是暂存清单的既定语义。

### 18.3 残留清理（本机实测）

- `sandbox-tests\pkg\tmp\{tmp9p_36hpu, tmpcdvkgg28, tmp_lmuw5f_}`（`mkdtemp` 0o700、
  受限 shell 写不进也删不掉）—— 已在**非受限** shell 中 `Remove-Item -Recurse -Force`
  成功删除。
- `C:\Users\Administrator\tool-outside-probe.txt` —— 已删除；其暂存条目也一并撤销。
  **根因已确证**：它由候选 `cs_0071_2862c479` **批准应用**（`appliedPaths` 含该路径），
  不是"未批准就物化"的泄漏。

### 18.4 证据

```powershell
node .t\foreign-workspace-selftest.mjs   # 11/11
```

该套件断言：匹配工作区照旧暂存（真实磁盘不动、无日志）；不匹配工作区**真实磁盘被写**、
不进暂存、日志只响一次；读路径按 ambient 会话 cwd 判定，拿到的是**真实磁盘**而不是暂存投影。


---

## 19. "点批准 → 处理中 → 没反应"：失败**立即、原地**可见（2026-09-29）

### 19.1 三个漏洞

1. 失败文案放**组件 state**（`failed`）：命令之后的 `poller.refresh()` 会换一版快照，
   组件若重挂载（slot 重新注册 / owner 变化），这条 state 直接丢 ⇒ 观感"什么都没有"；
2. 失败只出现在列表**末尾的一条横幅**里，长列表下不在视野内 ⇒ 像没反应；
3. `executeCommand` 若**永不 settle**，`busy` 永远为真 ⇒ "处理中"卡住、按钮全 disabled。

### 19.2 修法

- 失败原因放 **store**：`state.failures`（path → message，逐条）+ `state.notice`（面板级兜底），
  由 `showFailure()` 一次写入 —— 重渲染/重挂载都不丢。
- `failureByPath(text, paths)`：**纯函数**（`#region failure-map` 切片，`.t/failure-inline-selftest.mjs`
  直接求值）。宿主原文按行切成条目原因（某行包含某路径 ⇒ 该行归该条；Windows 路径大小写不敏感）。
- 逐条原因**原地**渲染在出错条目下方（`data-winstage-row-error`）；只针对一条时整段原文也贴到
  那一条（宿主不一定逐行带路径）。
- `act(line, targets)`：带 **20 秒超时**（`Promise.race`）——超时也立刻给可见失败并解除 busy；
  `sendApprove()` 把目标路径交给 `act`，于是失败自动归因到具体条目。
- 面板级横幅改读 `store.notice` 并用错误色（`data-winstage-notice`）。

### 19.3 边界（如实标注）

- 归因依赖"宿主原文里出现该路径"：宿主没逐行带路径时，**单条**操作仍能原地标注（整段兜底），
  多条操作退化为面板级横幅。
- 超时只解除 UI 冻结、**不取消**命令：命令可能仍在跑，下一次 `poller.refresh()` 会显示真实结果；
  失败文案里明确写了"本次未执行"，若事后发现其实成功，以列表为准。

### 19.4 证据

```powershell
node .t\failure-inline-selftest.mjs   # 26/26
```

覆盖：原文按路径归因（成功项不标、STALE_BASELINE 与二次确认各归各条、大小写不敏感、
空行/空入参、完全没提路径时不硬套）；失败在 store 而非组件 state；行内 `data-winstage-row-error`；
`act` 的超时上限与 `Promise.race`；`sendApprove` 传目标路径；i18n 中英齐全。

---

## 20. 「默认开启沙箱」＝ 五层默认值的合成（2026-09-29 复核）

用户对同一件事问过两次：17:02「默认启用沙箱」、23:36「默认开启沙箱」。第一次的现场是**真事故**：
profile `web` 的 `dsh.profile.bundles` 里没有本 bundle、覆盖层里也没有 winstage 行
（`.bak-winstage-20260928-132527` 就是那次改动的备份）⇒ 界面上表现为"沙箱没开 / 插件没加载"，
而**启动期不报任何错**。装配在 16:54 补上；本轮（23:3x）复核确认默认态已经成立，并加了回归门。

### 20.1 默认值分布在哪五层（缺一层就退化成"默认关"）

| 层 | 位置 | "默认开"的写法 |
|---|---|---|
| L1 插件 schema | `dsh-plugin/schema.js` `DICT.enabled` | `field('boolean', { default: true })` —— 设置页开关的初值 |
| L2 bundle patch | `dsh-plugin/cordis.patch.yml` | `insert` 的 `winstage-sandbox` 行 `config.enabled: true` |
| L3 host 行 | `dsh-plugin/host-plugin.mjs` | `config.enabled !== false`（**缺字段=开**，不是 `=== true`） |
| L4 fs 行 | `dsh-plugin/staging-fs.mjs` `stagingEnabled()` | 行缺失 / `config` 缺失 / 抛错 ⇒ `return true`（默认接管变更面） |
| L5 client 半 | `dsh-plugin/client.js` | `typeof value.enabled === 'boolean' ? value.enabled : true`；轮询器只认显式 `false` 才算关 |
| L6 活动 profile | `~/.dsh/profiles/<name>/` | `bundles` 含 `@local/dsh-winstage-sandbox`；覆盖层**没有** `enabled: false`；`winstage-fs` 覆盖层重述 `cwd` + `workspaceRoot`（C-8 同源） |
| L6e 合成结果 | `bundle 层 → profile 覆盖`（config 整体替换） | 设置页那一行**生效值** `enabled === true` 且 `workspaceRoot` 非空 —— 这是"设置页沙箱默认打开"的直接判据 |

L6 是历史上真正出错的那一层，也是最容易被静默回退的一层（改 profile 不重启不报错）。

### 20.2 本轮实测（3080，**新会话**）

会话 `session-b4e7f944-…`（23:31 起）是重启后的新会话，未做任何开关操作：

- 用 harness 的 `write` 写 `.t\default-on-probe.txt` ⇒ 真实磁盘 `Test-Path` = **False**；
- 宿主发布了 `.dshstage\sessions\session-b4e7f944-…\review.json`（23:34:18）：
  `pending:true`、`counts.files=1`、`candidateId=cs_0001_…`、`files[0].path=.t\default-on-probe.txt`。

⇒ **新会话默认就是暂存面**：变更进暂存树、等审批，而不是直写真实磁盘。这条判据与
§10.4 的"开关开着 = 暂存面"同源，但这里是**没用任何开关动作**的默认态。

### 20.3 回归门

```powershell
node .t\default-on-selftest.mjs                    # 本轮 C2 复核实测：11 PASS / 1 FAIL(L5b) / 2 PENDING-LIVE-FLIP，exit 1
node .t\default-on-selftest.mjs --profile web      # 指定要核对的活动 profile
```

**本轮（C2 复核）实测口径，如实记录、不粉饰**：`断言 11/12 PASS，2 PENDING-LIVE-FLIP，0 SKIP`，
退出码 **1**（旧文写 `13/13`，是过期口径）：

- `[FAIL] L5b client：只认显式 false 才算关（enabled 缺失时不判关）` —— 报"没找到'只认显式 false'
  的判据"，即该源码级断言与现行 `dsh-plugin/client.js` 文本对不上。**本轮未修**：该文件不在本轮
  授权改动范围内（本轮只动文档 + 新增守门测试）。
- `[PENDING-LIVE-FLIP] L6b / L6e profile web`：活动 profile 里 `winstage-sandbox` 仍是
  **显式 `enabled: false`**（`~/.dsh/profiles/web/cordis.patch.yml:46-51`，开发期有意保持关），
  因此"期望 `enabled=true`"的两项以 PENDING 记录；待 Lead 翻转后自动转 PASS。
- 上述 1 FAIL + 2 PENDING 都只读源码文本 / profile 文本，**与审批策略变化无关**，也不是本轮引入的。

把 L1–L6e 逐层钉死，并**用变异体证明它不是"永远绿"**（基线以**本轮实测**为准：11 PASS，
另有 1 FAIL(L5b) + 2 PENDING-LIVE-FLIP；下表口径来自上一轮，本轮未复跑）：

| 植入 | 命中项 |
|---|---|
| L1 `default: false` | L1 |
| L2 `enabled: false` | L2 |
| L5 初值改 `false` | L5 |
| L6a `bundles` 去掉包名 | L6a |
| L6e 覆盖层 `enabled: false`（其余键重述齐） | L6b + L6e |
| L6e 覆盖层只写 `enabled: true`（丢掉 `workspaceRoot`） | L6b + L6e |

L6/L6e 段是**只读**的：只读 profile 文件，不写任何 profile 文件（变异体跑在假的 `DSH_HOME` 上）。

### 20.4 如实标注的边界

- "默认开"**只覆盖初始/缺省态**：用户在设置页把开关关掉是**显式手势**，会被持久化
  （覆盖层出现 `enabled: false`），下次启动仍是关。这不是缺陷，是"默认"的语义边界 ——
  要恢复默认态，把开关再打开或删掉覆盖层里的那一项即可。
- L6 只核对**配置装配**，不代替端到端：真正的判据是 20.2 那两条（工具写入不进真实磁盘 +
  `review.json` 出现待审）。
- 本套件未接入 `autotest.cmd` 的 `OFFLINE_SUITES`（与 `appcontainer-runtime.mjs` 的处境相同，
  属已知缺口，见 README §8.2 的口径说明）。
