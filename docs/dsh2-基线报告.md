# WinStageSandbox 第二实例：T2 基线侦察报告（动手改代码前）

> 作者：T2 `dsh2-probe`。范围：只读侦察 + 独立探针脚本。
> 本文件**不是我改过代码的证据**，而是"改之前现状是什么"的证据基线。修复由 T3 执行。
> 判定标签：`[实测]`（我在本机跑出来、附原始命令与原始输出）、`[引用]`（读源码逐字，
> 给绝对文件:行）、`[未实测]`（没有条件测，明确写清前提，不用推理冒充证据）。
>
> ⚠ **行号时效**：本文所有 `文件:行` 都是**改动前基线**（2026-09-28 05:57Z 之前读取）。
> T3 已开始修改 `dsh-plugin/**`（例如 `staging-fs.mjs` 已新增 `watch()`），
> 行号会漂移；**以函数名/行为为准，行号只用于回溯基线**。
>
> 需求基线：`docs/dsh2-需求与验收.md`（Lead 维护）。本文与它冲突时以它为准。

---

## 0. 摘要：11 条可判定结论

| # | 结论 | 判定 | 证据 |
|---|---|---|---|
| A-1 | **S7 成立**：暂存变更不触发任何 `watch()` 事件；同一观察者在真实磁盘变更时会触发 | `[实测]` | §2.1，`.t/dsh2/probe/out/p1-watch.json` |
| A-2 | `watch(target, changed, signal)` 的契约是"失效通知"，没有事件类型/路径；本地后端用 chokidar + `depth:0` | `[引用]` | §2.1，`dsh-fs\lib\types\index.d.ts:71`、`dsh-fs-local\lib\index.js:726-750` |
| A-3 | **S7 的唯一消费者是 `ctx.remote.workspaceFiles.changes` 的文件变更流**，不是核心写路径 | `[引用]` | §2.1，全仓 `ctx.fs.watch(` 仅 `dsh-api-workspace-files` 1 处 |
| A-4 | **S2 成立**：`stageOutside` 默认 `direct`，工作区外 `writeText` 直接落真实磁盘；`deny` 会抛 `FS_SANDBOX_DENIED` | `[实测]` | §2.2，`.t/dsh2/probe/out/p2-outside.json` |
| A-5 | **S2 改 `deny` 不破坏 DSH 自身落盘**：会话日志/附件/spill/storage 全部走 `node:fs`，不经 `ctx.fs`；经 `ctx.fs` 写的只有模型面 `write`/`edit` 工具 | `[引用]` | §2.2，全包 grep 结果表 |
| A-6 | **在受限会话里测不出 S2 的插件行为**：外层沙箱已把工作区外写入挡在插件之前（`EPERM`） | `[实测]`+`[引用]` | §2.2、§3.2；`b1-probeWin32Abi.json` |
| A-7 | **S1 成立**：`pwsh`/`bash` 的写入完全不经 `ctx.fs`（走 `ctx.shell` → `ctx.subprocess`，真实 cwd） | `[实测]`+`[引用]` | §2.3，`.t/dsh2/probe/out/p3-shell-bypass.json` |
| A-8 | S1 在本机**不可能实现也不可能验证**：它依赖受限令牌，而本会话/本谱系创建不出（R6） | `[实测]`+`[引用]` | §2.3、§3.2 |
| B-1 | 结论草案**成立并加强**：插件只装载暂存面；`WindowsStageExecutor` 只被 `src/cli.mjs`/`src/audit.mjs`/`dsh-plugin/selfcheck.mjs` 使用，**没有接进 `ctx.shell`/`ctx.sandbox`**；唯一的适配层 `dsh-plugin/provider.mjs` 无人引用，且它 import 的 `bridge.mjs` **不存在** | `[引用]` | §3.1 |
| B-2 | 三个会话档位：**3080 受限会话 fail**（已复核 Lead 的数字）；**3081 谱系 fail**（T1 代跑，但**不是** 3081 的 agent shell）；**不受限会话拿不到 →`[未实测]`** | `[实测]`×2 + `[未实测]` | §3.2 |
| B-3 | CLI 执行器层在本会话：`src/cli.mjs exec` → `SANDBOX_INIT_FAILED: OpenProcessToken failed (Win32 5)`；`probe` 判 `tier=T2 (acl-only)`、`nesting.viable=false` | `[实测]` | §3.3，`b3-cli-*.txt` |
| B-4 | 内核隔离层：**本插件不提供**；AppContainer 在本令牌下 `E_ACCESSDENIED`，也尚未接进执行器 | `[实测]`+`[引用]` | §3.4 |
| C-1 | 插件侧**没有任何** 3080/3081/localhost 硬编码；DSH 侧的 `3080` 只是 web bundle 的默认端口 | `[实测]`grep+`[引用]` | §4.1 |
| C-2 | 3080 与 3081 并发在信任域/鉴权上**天然隔离**：loopback 一律受信；cookie 名与签名受众都含 authority（含端口） | `[引用]` | §4.1 |
| C-3 | **首次加载即挂载 client 半的前提是"loader 行名是精确包名"**；本插件两行用的是**子路径 specifier** ⇒ client 半**永远不会被下发** | `[实测]`(3081 启动图) + `[引用]`(源码) | §4.3 |
| C-4 | Lead 的硬约束复核：`client.js:124` 属实但**不是缺陷**；"读路径≠写快照路径"**不是** S5 根因，真正的不对称在「host 行 `workspaceRoot` vs fs 行 `cwd`」与「settings 为空时回退到 `owner.session.cwd`」 | `[引用]` | §4.4 |
| C-5 | 第二个真实缺口：`store.publish()` 不会 bump chain 槽位版本，`select` 只在锚点重渲染时才重跑 ⇒ 首屏存在"快照到了但面板还不接管"的窗口 | `[引用]`（机制）+ `[未实测]`（行为） | §4.5 |
| C-6 | `workspaceFiles.read` **不做工作区包含校验**（只有 `list` 校验），绝对路径可越界读 | `[引用]` | §4.4 |
| C-7 | **串台缺陷（优先级仅次于 S5）**：settings 未显式给 `workspaceRoot` 时，客户端回退到 `owner.session.cwd`，加上 C-6 的无包含校验 ⇒ 3081 面板会读到**项目根**那份 `pending=true` 的快照 | `[引用]` | §4.4(b)1 |
| C-8 | **配置漂移**：host 行用 `config.workspaceRoot`、fs 行用 `config.cwd`；两者不一致 ⇒ 暂存写到 A、快照发布在 B | `[引用]` | §4.4(b)2 |

**给 Lead 的一句话**：S5 的头号根因不是 `routeOf`，是 **client 半根本没进 `window.__DSH_BOOT__`**（§4.3，有 3081 首页原始证据），
修复面是 `dsh-plugin\cordis.patch.yml:20` 一行的行名；紧随其后的是 **C-7 串台**（§4.4）与 **C-8 配置漂移**。
另外：**3080 当前 profile 里这个 bundle 已经被摘掉了**（§5），因此 3080 上的 UI 观察对本插件无判别力。

---

## 1. 方法与纪律

- **探针一律用独立临时工作区**：`.t/dsh2/probe/p*-ws`，各自带自己的 `.dshstage`。
  项目根 `.dshstage` 在整个侦察期间**未被本报告的任何脚本写入**（只有 3080 会话里那两个
  遗留状态是别人早先留下的）。
- **脚本落盘原始输出**，不依赖控制台转码：所有 JSON 日志由脚本自己 `writeFileSync` 写 UTF-8。
  原因见下条。
- **本沙箱禁止"被捕获的管道 stdio"**：`node ... | Tee-Object`、`node ... *>` 会
  `Program 'node.exe' failed to run: Access is denied`；`child_process` 默认 `pipe` 会 `EPERM`。
  探针因此统一用「脚本自己写文件」或「子进程 stdio 直接绑到文件描述符」。
  这是本机使用限制，不是被测代码的缺陷。
- 探针构造的是**真实类**：`createStagingFileSystem()` 默认基类就是 DSH 的 `LocalFileSystem`
  （含 chokidar），只在 `ctx` 上给一个满足 cordis `Service` 构造契约的最小替身
  （`{ reflect: { provide(){} } }`）。替身只影响"注册服务"这一步，不影响磁盘与监听行为。
- 回归门基线已跑：`.\autotest.cmd --skip-audit` → **9 套件全过 / 250 断言 / 退出码 0**
  （原始输出：`.t/dsh2/probe/out/b0-autotest-baseline.txt`）。

---

## 2. A 组：暂存语义（S7 / S2 / S1）

### 2.1 S7 —— `watch()` 不覆盖暂存

**现状（源码）**
- `dsh-plugin/staging-fs.mjs` 没有覆写 `watch`；文件头第 28 行自述"`watch` 继承本地实现，只观察真实磁盘"。
- 基类契约（`node_modules\@deepseek-ai\dsh-fs\lib\types\index.d.ts:71`）：
  `watch(target, changed: (error?: Error) => void, signal): Promise<() => Promise<void>>`
  —— 回调**没有事件类型、没有路径**，只是"这个 target 失效了"。
- 本地实现（`dsh-fs-local\lib\index.js:726-750`）：chokidar，`ignoreInitial: true`、`depth: 0`；
  文件目标观察 `dirname`，目录目标观察自身；`changed()` 无参 = 失效，`changed(error)` = 出错。

**探针（`[实测]`）**：`.t/dsh2/probe/p1-watch.mjs` → `.t/dsh2/probe/out/p1-watch.json`

原始命令：`node .t\dsh2\probe\p1-watch.mjs`（工作区根 `.t/dsh2/probe/p1-ws`）
原始输出（节选，全部字段见 JSON）：

```
watchers-initialized  fileEvents=0 fileErrors=0 dirEvents=0 dirErrors=0
A_staged-write        outcomeVersion=winstage:848db6…b9e396
                      fileEvents=0 dirEvents=0            ← 暂存写入（文件 + 新文件）不触发监听
B_real-disk-write     fileEvents=1 dirEvents=1            ← 真实磁盘写入触发（对照组有效）
projectedReadText     "v1-staged-only\n"                   ← ctx.fs 读到暂存投影
realDiskText          "v2-real-disk\n"                     ← 真实磁盘是另一份内容
stagedNewFileVisibleInStagingTree  true
verdict.stagedWriteEmitsWatchEvent  false
verdict.realDiskWriteEmitsWatchEvent true
```

**唯一消费者（限定影响面）**：全 `node_modules\@deepseek-ai` 里 `ctx.fs.watch(` 只有一处 ——
`dsh-api-workspace-files\lib\index.js:75`（`WorkspaceChangeFeed.follow`）。它服务于
`ctx.remote.workspaceFiles.changes`（客户端文件变更流/侧栏刷新）。
所以 S7 的后果是**UI 新鲜度**：走 `write`/`edit` 的暂存改动不会让客户端文件视图失效；
**不是**数据损坏，也不影响审批/提交（那些走 `reload()` 显式重读）。

**最小修复面**：`dsh-plugin/staging-fs.mjs`，新增 `async watch(target, changed, signal)`：
1. `const close = await super.watch(target, changed, signal)`（保留真实磁盘语义，`stageOutside: direct` 的直通写入仍会通知）；
2. 在实例上维护 `this.watchers` 集合（元素 = `{ rel, isDir, changed }`）；
3. 在 `writeText`/`editText` 的**暂存分支**里、`this.staging.afterMutation(...)` 之后，
   对该路径及其父目录的观察者调用 `changed()`（对齐本地实现：文件目标只在自己这条路径时通知，
   目录目标对直接子项通知）；
4. 返回 `async () => { this.watchers.delete(entry); await close() }`。
**风险**：① 跨进程改动（CLI / 另一个 DSH 实例写同一份暂存树）仍然不会通知——本地观察者也看不到，
必须在文档里如实标注；② 通知必须是**同步/无异常**的，chokidar 的回调抛错会变成 error 分支，
所以调用点要 try/catch；③ `delete` 造出的"暂存删除标记"与 `deny` 组合下要不要通知，需明确（建议一律通知）。
**验收断言**：重跑 `p1-watch.mjs`，`verdict.stagedWriteEmitsWatchEvent === true` **且**
`verdict.realDiskWriteEmitsWatchEvent === true`（不能为了前者牺牲后者）。
**该断言在哪种会话下有意义**：任意会话（探针不依赖外层沙箱，只用工作区内的独立根）。

### 2.2 S2 —— 工作区外写入默认直通

**现状（源码）**
- `dsh-plugin/fs-entry.mjs:14-16`：`stageOutside: process.env.WINSTAGE_STAGE_OUTSIDE === 'deny' ? 'deny' : 'direct'`。
- `dsh-plugin/staging-fs.mjs:112`：同样的归一；`staging-fs.mjs:250-253` `outsideWrite()`：
  `direct` → `run()`（委托真实磁盘）；否则抛 `FS_SANDBOX_DENIED`。

**探针（`[实测]`）**：`.t/dsh2/probe/p2-outside.mjs` → `.t/dsh2/probe/out/p2-outside.json`
（暂存根 `.t\dsh2\probe\p2-ws`，工作区外目标 `.t\dsh2\probe\p2-outside\**` —— 仍在会话工作区内，
**所以外层沙箱不会介入**，测到的是插件自己的行为）

```
A_default_stageOutside      write.threw=false  realFileExists=true  text="written-with-default-stageOutside"
B_stageOutside_deny         write.threw=true code=FS_SANDBOX_DENIED realFileExists=false
C_inside_workspace          write.threw=false realFileExists=false stagedCopyExists=true
D_fs_entry_env_switch       (unset)->direct, ""->direct, "DIRECT"->direct, "deny"->FS_SANDBOX_DENIED
```

**「工作区外写不出去」在受限会话里不能当作插件证据（`[实测]`+`[引用]`）**
- 本会话 `probeWin32Abi().checks.writeOutsideWorkspace = fail / "write outside workspace denied: EPERM"`，
  且 `instanceChecks.ambient-write-outside-root = denied (EPERM) → 进程沙箱写边界生效`
  （`.t/dsh2/probe/out/b1-probeWin32Abi.json`、`b3-cli-probe.txt`）。
- 也就是说：在 3080 这类受限会话里，工作区外写入**到不了插件那一层**。
  要观察 `stageOutside` 的真实行为，必须让"工作区外"仍然落在**外层允许写的范围**内
  （我的 P2 就是这么做的），或者使用一个不受外层约束的会话（本机没有）。

**改成 `deny` 的兼容性代价清单（D2 要求，`[引用]`）**
方法：在 `node_modules\@deepseek-ai\**\lib\index.js` 上 grep `ctx\.fs\.(writeText|writeBytes|editText|mkdir|remove|rename)`，
并逐个检查常见"落盘方"是否用 `node:fs`。结果：

| 组件 | 是否经 `ctx.fs` 写 | 受影响？ |
|---|---|---|
| `dsh-tool-fs`（模型面 `write`/`edit`） | 是（`lib/index.js:586`、`:735`） | **是**：工作区外 → `FS_SANDBOX_DENIED`（这正是 D2 想要的收紧） |
| `dsh-tool-str-replace-editor` | 是（`lib/index.js:148/174/214`） | **是**：同上 |
| `dsh-session-persistence-jsonl`（会话日志） | 否（3 处 `node:fs` 写） | 否 |
| `dsh-attachment-local`（附件） | 否（2 处） | 否 |
| `dsh-spill-local`（溢出文件） | 否（1 处） | 否 |
| `dsh-storage-json`（设置持久化） | 否（1 处） | 否 |
| `dsh-jobs-local` / `dsh-output-retention` / `dsh-file-reference-local` / `dsh-host-frontend-static` | 否（0 处写） | 否 |

⇒ **改默认 `deny` 不会把 DSH 自身的正常落盘（日志/附件/临时文件）变成拒绝**；行为变化只发生在
模型通过 `write`/`edit` 指向**暂存工作区根之外**的路径时。真正需要 Lead 拍板的是产品语义：
工作区外的写入会从这里开始**硬失败**，而不是"静默直通"。

**风险**：① `workspaceRoot` 与 `ctx.fs` 的 `cwd` 不一致时（见 §4.4），"根"的判定会与用户预期不同，
`deny` 会把本可写的路径拒掉；② 会话文件策略是 `danger-full-access` 的部署里，模型有正当理由写工作区外
（本次 D2 明确接受这种破坏性变更）；③ `deny` 之下 `write` 工具是否应广告 `sandbox_permissions`
仍然由 `sandboxMode`（`staging-fs.mjs:140-142` 返回 `undefined`）决定 —— 保持不变即可。
**验收断言**：`WINSTAGE_STAGE_OUTSIDE` 未设/置空/置垃圾值时，向"暂存根之外"的 `writeText` 必须抛
**插件自己的专属错误码**（现为 `FS_SANDBOX_DENIED`，由 `staging-fs.mjs:252` 抛出的 `FsError`）
且真实文件不存在（即 P2 的 D 组四项翻转）。

> **Lead 要求的关键区分（务必写进验收）**：在受限会话里，工作区外写入会先被**外层 DSH 沙箱**
> 以 `EPERM` 拒绝（§3.2）。因此断言**不能**写成"抛错即可"或"看到 EPERM 就算通过"——
> 那样永远分不清是插件生效还是外层生效。断言必须绑定**插件错误码**（`error.code === 'FS_SANDBOX_DENIED'`
> 且 `error instanceof FsError`），并同时断言"真实文件不存在"。
> 而"默认值是否改了"这件事本身，可以在任意会话里用 P2 那种"独立暂存根 + 根外目标仍在可写范围"
> 的方式测出来。

**该断言在哪种会话下有意义**：区分两件事 ——
(a) "插件在 `deny` 下抛专属错误码"：任意会话都能测（P2 已给出可复跑脚本）；
(b) "真实工作区外（如 `C:\Windows`、`%TEMP%` 的父目录）被拒绝"：受限会话里测到的是**外层边界**，
必须在不受限会话里跑才有判别力（§3.2 档位 3 为 `[未实测]`）。

### 2.3 S1 —— shell 写入不经暂存

**现状（源码，`[引用]`）**
- `dsh-tool-pwsh\lib\index.js:263-268` `resolveWorkdir()`：workdir 取 `exec.agent?.session.header.cwd`
  （**真实 OS 路径**），相对路径 `resolve(headerCwd, ...)`；工具只注入 `ctx.shell`（`:314` 读 `ctx.shell.sandboxMode`），
  **全文没有 `ctx.fs`**。`dsh-tool-bash` 同构（`:294`、`:344`、`:402`）。
- `dsh-pwsh-local\lib\index.js`：`resolve()` 把 `workdir` 定成 `config.cwd ?? process.cwd()`（`:173-180`），
  `spawnSpec()` 用 `cwd: spec.workdir` 交给 `ctx.subprocess.spawn`（`:208-215`）—— 真实进程 cwd，
  与 `ctx.fs` 的 target 抽象没有交集。

**探针（`[实测]`）**：`.t/dsh2/probe/p3-shell-bypass.mjs` → `.t/dsh2/probe/out/p3-shell-bypass.json`
（在**同一个已挂载暂存文件系统的工作区**里，用真实 shell 子进程写文件）

```
shellResolution.chosen = C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe   ← 见下方注
1_shell_subprocess_write   exitCode=0 realFileExists=true realFileText="written-by-shell"
                           stagedCopyExists=false                    ← 暂存树里没有这条
2_staging_write_same_path  projectedReadText="written-by-staging-fs\n"
                           realDiskTextAfterStagingWrite="written-by-shell"
                           stagedCopyExists=true                     ← 同一路径两条写路径**分叉**
3_staging_listDir          listing 含 "shell-created-dir"（shell 造的目录，由真实磁盘枚举可见）
verdict.shellWriteLandedOnRealDisk true / shellWriteCreatedStagedEntry false / divergence true
```

> 附带实测（对 B 组有用）：本机 **PATH 上没有 `pwsh`，也没有 PowerShell 7**，
> `dsh-pwsh-local` 的候选顺序（`:29-32`）会落到
> `C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe`（Windows PowerShell 5.1）。
> 即：工具名叫 `pwsh`，本机实际执行的是 **PowerShell 5.1**。

**可行路径与代价（D2 要求"尽量做"，我的判定：本机不可能做，正确交付 = 如实标注未提供）**
把"shell 的可写根指向暂存树"在做这件事上等价于 `src/cli.mjs exec` 那条链路：
`workspace.materializeForExecution()` → 在受限令牌里跑命令 → `captureAfterExecution()` 回收变化
（`src/cli.mjs:185-243`）。要在 DSH 里成立，必须**替换 `ctx.shell`** 为
`dsh-plugin/provider.mjs` 那个适配层，而：
1. `WindowsStageExecutor.init()` 需要 `CreateRestrictedToken` ⇒ 本会话/本谱系拿不到（R6，见 §3.2）；
2. `provider.mjs` 在当前装配里**没有任何引用**（`cordis.patch.yml` 只插入 `host-plugin` 与 `fs` 两行），
   它 `import` 的 `dsh-plugin/bridge.mjs` **文件不存在**，即使挂上也会加载失败；
3. 不替换 `ctx.shell`、只做"事后捕获"是不诚实的：命令仍可写绝对路径，等于没有围栏
   （手册对 `ctx.sandbox` 的硬约束也是 "silent unconfined passthrough is forbidden"）。
**结论**：S1 应如实标注为 **未提供**，并写清前提：**需要不受限会话**（能 `CreateRestrictedToken`
的宿主进程）**加上**把 `provider.mjs` 真正接进 `ctx.sandbox`（并补齐 `bridge.mjs`）。
**验收断言**：本机**不存在**有意义的断言；只能在文档与 `selfcheck`/`provider` 的自检层面
断言"未接线的部分不会假装成功"。任何"S1 已解决"的说法都必须附不受限会话里的 `tier` 与
`createRestrictedTokenViable=pass` 原始输出。

---

## 3. B 组：Windows 沙箱的调用与支持情况（三层分开）

### 3.1 结论草案验证：执行器有没有被接进 `ctx.shell` / `ctx.sandbox`？

**验证结果：草案成立，并加强。`[引用]`**

- `dsh-plugin/host-plugin.mjs:28` 只 import，`:77` 只用 `WindowsStageExecutor.capabilities()`
  （纯查询，不建沙箱），`:61-98` `probeRuntime()` 只返回报告；`:334-338` 只把结果写日志。
  `:328-332` 的注释与行为一致："探测结果只记录、不影响暂存面"。
- `WindowsStageExecutor` 的全部引用点：`src/cli.mjs:29/188`、`src/audit.mjs:20/112`、
  `dsh-plugin/selfcheck.mjs:16/44`、`dsh-plugin/provider.mjs:42/159`。**没有一个在 DSH 插件装配里生效**：
  `dsh-plugin/cordis.patch.yml` 只做三件事（禁 `fs-sandbox` + 插 `winstage-sandbox` + 插 `winstage-fs`）。
- `provider.mjs`（唯一想把执行器包成 `ctx.sandbox` provider 的文件）**无人引用**；
  它的 `BRIDGE_PATH = join(HERE, 'bridge.mjs')`（`:46`）指向一个**不存在的文件**
  （`dsh-plugin` 目录清单里没有 `bridge.mjs`）。
- `ctx.shell` 的提供方是 DSH 自己：`dsh-shell\lib\index.js:83-93` 定义抽象 `shell` 服务，
  `dsh-pwsh-local`/`dsh-bash-local` 提供具体执行器。本插件**没有**任何一行替换它们。

**三层定义（回答用户"沙箱的调用与支持情况"）**

| 层 | 是什么 | 本插件是否装载 | 证据 |
|---|---|---|---|
| 1. DSH 插件层（暂存） | 替换 `ctx.fs`，`write`/`edit` 落 `<workspaceRoot>\.dshstage`，读取走投影；每 workspaceRoot 一份 | **是**（当 bundle 在 profile 里时） | `cordis.patch.yml`、`staging-fs.mjs` |
| 2. CLI 执行器层（受限令牌 + Low IL + ACL + Job Object + 显式环境块） | `src/executor.mjs` 的 `WindowsStageExecutor`，由 `src/cli.mjs exec` / `src/audit.mjs` 驱动 | **否**（未接进 `ctx.shell`，只在 CLI 与自检里） | §3.3 |
| 3. 内核隔离层 | 真内核边界（AppContainer / 独立会话 / VM） | **不提供** | §3.4 |

### 3.2 三个会话档位下的 `createRestrictedToken`

探测入口：`node -e "import('./src/capability.mjs').then(m=>console.log(JSON.stringify(m.probeWin32Abi(),null,2)))"`

**档位 1 —— 当前 3080 会话（受外层沙箱约束）：`[实测]` fail（复核 Lead，数字逐字一致）**
- 原始输出：`.t/dsh2/probe/out/b1-probeWin32Abi.json`（我独立跑的）＋ `docs/dsh2-需求与验收.md` §6（Lead 跑的）
- `tokenRights.detail = "TOKEN_ASSIGN_PRIMARY=yes TOKEN_DUPLICATE=yes TOKEN_QUERY=yes TOKEN_ADJUST_DEFAULT=NO TOKEN_ADJUST_SESSIONID=NO"`
- `createRestrictedTokenViable.status = "fail"`，detail 逐字："…A nested sandbox is impossible in an already-confined process."
- 同批输出：`writeOutsideWorkspace=fail(EPERM)`、`writeSystemDir=pass`、`jobObject=fail(SetInformationJobObject=true, AssignProcessToJobObject=false)`

**档位 2 —— 3081 实例：`[实测]` fail，但归属必须如实标注**
- T1 代为执行，原始输出：`.t\dsh2\logs\probe-restricted-token-3081.txt`（T1 自述：跑在
  **启动 3081 supervisor 的父 pwsh 谱系**里，不是 3081 的 agent shell —— 3081 目前还没有 agent 会话）。
- 结果：`createRestrictedTokenViable=fail`，缺 `TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID`（其余 granted）。
- **不能据此断言"3081 沙箱内工具进程拿到的令牌"**：只能说"与 3081 同谱系的令牌如此"。
- **「3081 自身 agent 会话里」这一档：`[未实测]`，原因是可判定的，不是含糊**（Lead 已允许保持未实测）：
  1. 3081 目前**没有任何 agent 会话**（T1 明确：只有 host 起来了、插件装载了；我实测其
     `.t\dsh2\ws\.dshstage\review.json` 也是 `pending:false` 的空快照）；
  2. 从外部驱动 3081 的 agent 需要实现 `/api` 的信封式 RPC（`client-request`/`server-response`
     + operator peer 准入，见 `dsh-client-connection\lib\index.js` 的 rpc 段）；
     `dsh` CLI **没有** attach/send 类子命令（`dsh\lib\bin.js:115` 只有 `plugin` 一个子命令），
     且这样做会在 T1 的常驻实例里创建会话、消耗其凭据，风险与收益不成比例。
  3. **推理（不是证据，明确标注）**：Windows 令牌权限由子进程继承，3081 的 node 进程与其工具
     子进程同属 T1 那条受限谱系，因此**预期**同样是 fail —— 但按纪律，未经实测就写 `[未实测]`，
     不得把它当成结论。

**档位 3 —— 不受限会话：`[未实测]`**
- 本机拿不到：本会话所有派生进程都继承同一受限令牌（T1 的档位 2 就是证据），
  唯一可能不受限的进程是用户桌面启动器拉起的 3080 服务进程本身，而它**不在我的可测范围**
  （禁止触碰 3080）。
- 结论形态：`[未实测] —— 需要在一个由不受外层约束的宿主进程启动的 DSH 里跑同一条命令`。

**推论（对 S1/S2 的影响形态，Lead 特别要求写清）**
受限会话里观察到的"工作区外写入被拒"是**外层边界的证据**，不是插件 `stageOutside` 的证据。
S2 的插件行为只能在"工作区外仍在可写范围"的会话里测（我把 P2 设计成这样）；
S1 则必须在不受限会话里才可能实现（受限令牌 + 接管 `ctx.shell`）。

### 3.3 CLI 执行器层实测（本会话）

原始命令：`node .t\dsh2\probe\b3-cli.mjs`（把三条 CLI 调用的 stdout/stderr 直接绑到文件描述符）

| 命令 | 退出码 | 原始输出 |
|---|---|---|
| `node src/cli.mjs probe --workspace .t\dsh2\probe\cli-ws --json` | 0 | `.t\dsh2\probe\out\b3-cli-probe.txt` |
| `node src/cli.mjs status --workspace .t\dsh2\probe\cli-ws --json` | 0 | `.t\dsh2\probe\out\b3-cli-status.txt` |
| `node src/cli.mjs exec --workspace .t\dsh2\probe\cli-ws --json -- <powershell.exe> -Command "Set-Content .\inside.txt"` | 1 | `.t\dsh2\probe\out\b3-cli-exec.txt` |

关键原文：
- `b3-cli-exec.txt` → `SANDBOX_INIT_FAILED: OpenProcessToken failed (Win32 5): pid 10328`
  （`src/cli.mjs:195-198` fail-closed，`executor.init()` 未通过。）
- `b3-cli-probe.txt` → `tier = { "tier": "T2", "name": "acl-only", "reasons": ["Job Object unavailable…",
  "CreateRestrictedToken prerequisites missing in this process", "AppContainer unavailable in this token"] }`，
  `nesting.detail = "the current process cannot mint a restricted token … run the sandbox from an unconfined host process"`。
- `instanceChecks`: `ambient-write-outside-root = pass / denied (EPERM) → 进程沙箱写边界生效`，
  `workspace-writable=pass`，`stage-base-on-root=pass`。
- `appContainer: fail hr=0x80070005 (E_ACCESSDENIED)`。

⇒ **执行器层的代码路径本身是好的（离线测试全绿）**，问题只在"当前会话的令牌不够"这个环境事实上；
而它在 DSH 里**根本没被装载**（§3.1）。

### 3.4 内核隔离层

- **本插件不提供内核级隔离。** 它是"可信代码里的策略围栏"（替换 `ctx.fs` 的提供方，
  与 `dsh-fs-sandbox` 同类）；`README.md:372-382` 与 `docs/实测证据记录.md` N8 已如实记录：
  AppContainer 路径"结构已实现 + 27 项离线布局测试，但 `CreateAppContainerProfile` 返回
  `E_ACCESSDENIED`，执行器尚未接进 `WindowsStageExecutor`"。
- 本次独立复核一致：`probe.appContainer.status=fail hr=0x80070005`（`b3-cli-probe.txt:90-95`）。
- `jobObject` 亦为 `fail`（进程已在某个 job 里 ⇒ `AssignProcessToJobObject=false`）⇒ 进程树回收
  在本会话无法保证。`[实测]`

---

## 4. C 组：UI 适配

### 4.1 端口 / 信任域 / 3080-3081 并发

- **插件侧无硬编码**：`[实测]` 在 `dsh-plugin/**` 与 `src/**` 上 grep
  `3080|3081|trustedHost|trusted-host|resolveLanTrust|0.0.0.0` → **0 命中**；
  命中只在 `docs/**`（本任务自己的文档）。
- **DSH 侧**（`[引用]`）：
  - 默认绑定 `host: ctx.webStartup.host ?? '127.0.0.1'`、`port: ctx.webStartup.port ?? 3080`
    （`dsh-web-app\cordis.patch.yml:167-168`）——`3080` 只是默认端口，不是"对 3080 的假设"。
  - `--host 0.0.0.0` 硬拒：`dsh-web-app\lib\startup.js:40`
    （"…would expose remote code execution to the network; use 127.0.0.1 instead"）。
  - LAN 信任只在绑定全接口时才派生：`resolveLanTrust(bindHost, extra)`（`dsh-web-app\lib\index.js:83-89`）。
  - `/api` 信任围栏：`dsh-client-connection\lib\index.js:205-219` `isTrustedApiRequest`
    —— loopback 主机名**一律受信**；非 loopback 必须精确命中 `trustedHosts`；
    另拒 `sec-fetch-site: cross-site`、以及 Origin ≠ Host。
  - 浏览器 cookie：`cookieName(authority) = 'dsh-auth-' + base64url(sha256(authority))`（`:284-285`），
    属性 `HttpOnly; SameSite=Strict; Path=/`（`:296-298`），签名受众也绑定 authority（`:322`）。
- **3080/3081 并发结论**：两个实例都在 `127.0.0.1`，信任围栏对 loopback 天然放行；
  端口进 authority ⇒ **cookie 名与签名受众都不同**，浏览器会把两个 cookie 都发给两个实例，
  但每个实例只读自己那个（另一个解签失败 → 401，不是 403）。
  因此**不存在跨实例的 trust/CSRF 相互干扰**。
- `[未实测]`：我没有直接观测"两实例同时在线时的 3081 页面加载"，这条留给 T4/T5 按
  H1 的验收方式补（要求附 4xx/5xx 原文）。我能给的只有上面的源码结论 + §4.3 的 3081 首页 200 证据。

### 4.2 client 插件加载契约（`dsh.client` / `immediately` / `inject` / 刷新）

`[引用]`（源码逐字）
- `dsh-plugin/package.json:14-23`：`platform: "web"`、`exports["./client"] = "./client.js"`、
  `immediately: true`、`inject: ["@deepseek-ai/dsh-client-ui-settings"]` —— **声明形式合法**。
- `immediately` 的语义（`dsh-client-modules\lib\types\client\manifest.d.ts:43/60`）：
  "marks stage-one prefetch … load the script for factory registration during module-face boot"。
  它在 host 侧只影响是否把该行标成 stage-one（`lib\index.js:394-403` `graphRow`）；
  **不影响是否会挂载**：客户端 `reconcile()` 会对 `manifest.modules` 里的**每一行**都
  prefetch→import→create Loader entry（`lib\client.js:396-416`），`plugins` 视图里的
  `immediately` 只被解析、未被用来改变行为（全文只出现在 68/73/127/138 行）。
- `inject` 的语义：客户端 `arriveGraphRow` 对 `row.inject` 里**存在**的包先到达
  （`lib\client.js:656-659`），不存在则**静默跳过**（`if (dependency !== void 0)`）。
  本次的注入目标 `@deepseek-ai/dsh-client-ui-settings` 在 web roster 里存在
  （`dsh-web-app\cordis.patch.yml:283`）且自身声明了 `dsh.client`（其 package.json:28-35）⇒ 合法。
- **刷新会不会重新抓 client 半**：会。启动图是**每次首页响应**注入的
  （`bootInjections(graph)` + `__DSH_BOOT__`），bundle URL 带 `rev` 缓存戳；
  `start()` 会为每个 client 行新建 Loader entry（`lib\client.js:254-270`）。
  ⇒ "刷新一下就好"在**行名正确**的前提下成立；本次的问题不在刷新（见 §4.3）。

### 4.3 头号根因（`[实测]`+`[引用]`）：client 半从未进入 `window.__DSH_BOOT__`

**实测（T1 的 3081 实例，只读 HTTP）**：`.t\dsh2\probe\c2-boot-graph-3081.mjs`
→ `.t\dsh2\probe\out\c2-boot-graph-3081.json`、`.t\dsh2\probe\out\index-3081.html`

```
token-exchange  status=303  hasSetCookie=true          ← 令牌取自 .t\dsh2\logs\dsh2.out.log
index           status=200  bytes=34240
__DSH_BOOT__    true（以 globalThis["__DSH_BOOT__"] 形式；不是 window.）
entries         ~40 条，全部是裸包名（@deepseek-ai/...）；**winstage 出现次数 = 0**
同时：.t\dsh2\ws\.dshstage\review.json 是活的（2026-09-28T05:51:00Z 发布，pending=false）
```

⇒ **host 半在跑，client 半完全缺席**。所以"面板不出现"与 `routeOf` 无关：面板代码根本没被加载。

**机制（`[引用]`，可逐行核）**：`node_modules\@deepseek-ai\dsh-client-modules\lib\index.js`
- `exactPackageSpecifier()`（`:82-88`）：`@scope/name` 恰好 2 段才算包名；
  `@local/dsh-winstage-sandbox/host-plugin` split 后 3 段 ⇒ 返回 `undefined`。
- `locatePkgJson()`（`:743-747`）：`if (!pathLike && expectedPackageName === undefined) return undefined`
  ⇒ 定位不到 `package.json` ⇒ 读不到 `dsh.client`。
- `processOne()`（`:835-838`）：只把"有 fiber 且未 disabled 的行"纳入扫描；命中不了就**没有 client bundle**。
- 而 `dsh-plugin/cordis.patch.yml` 的两行用的正是子路径 specifier：
  `:20 name: '@local/dsh-winstage-sandbox/host-plugin'`、`:27 name: '@local/dsh-winstage-sandbox/fs'`。

⇒ **`dsh.client` 声明写得再对都没用；`docs/DSH集成.md` §3.3「页面还没刷新」的归因不成立**
（刷新任意次都不会出现）。这直接解释 S5。

> **需要回写进 `docs/DSH集成.md` 的更正**（Lead 要求原样保留）：
> 原文 §3.3「`conversation.composer` 的在线检查显示该槽位当时仍只有内置的 3 个占用者 ——
> 因为**页面还没刷新**（Client 半是页面加载时抓取的）」这一归因**被实测推翻**：
> client 半从未进入 `window.__DSH_BOOT__`，因此**刷新多少次都不会出现**；
> 真正的成因是 loader 行名用了子路径 specifier。
> （Lead 已独立复核 `dsh-client-modules/lib/index.js:82-88 / :747 / :836` 三处，结论一致。）

**最小修复面（T3 只需要改一行）**
`dsh-plugin/cordis.patch.yml:20`：`name: '@local/dsh-winstage-sandbox/host-plugin'`
→ `name: '@local/dsh-winstage-sandbox'`。
- 为什么安全：`package.json:8` 的 `exports["."] = "./host-plugin.mjs"`，裸包名解析到同一份
  `host-plugin.mjs`（`index.js` 只是 `export *` 转发），ESM 按 URL 缓存 ⇒ 不会二次初始化模块。
- **不要**再加第三行用裸包名：那会让同一 `apply()` 被调用两次（`definitionId` 冲突 / 命令重复注册）。
- 代价：丢掉"换一个未导入过的 specifier 以便热加载新代码"的开发期技巧（`DSH集成.md` §7.1）；
  改 composition 后重启一次即可（§4 本来就要求重启）。
- 风险：若将来 `fs` 行也要自带 client，同样规则适用（它不需要）。

**验收断言（该断言必须在"bundle 已在 profile 里"的前提下跑）**：
取 3081 首页 + 令牌 → `JSON.parse(__DSH_BOOT__).entries.some(e => e.id === '@local/dsh-winstage-sandbox') === true`。
这一条**不需要浏览器**，T4 之前就能判定；面板出现与否另由 T4 用 AX 树证。

### 4.4 Lead 硬约束复核（`routeOf` + 读路径 vs 写路径）

**（a）`client.js:124 if (!owner || !owner.sessionId) return null` —— 属实，但不是缺陷。`[引用]`**
- `conversation.composer` 是 chain 槽位：`dsh-client-ui-slots\lib\index.js:187-190` 强制要求 `select`；
  渲染端 `dsh-client-ui-renderer\lib\client.js:1158-1170` 按 priority 升序询问 `select(ownerProps)`，
  全 `null` 就落回宿主输入框。
- 内置审批面板 `dsh-client-ui-approval\lib\client.js:344-354` 用的是同一槽位，
  它的 `select: ({ pendingInteraction }) => ...` **同样只在会话里成立**。
  没有会话时没有输入框可接管 ⇒ 这不是本插件特有的缺陷。

**（b）"读路径 ≠ 写快照路径" —— 部分属实，但形态与 Lead 的描述不同，且不是 S5 根因。`[引用]`**
- 客户端 `client.js:173-181`：`const root = configValue.workspaceRoot || workspaceRoot`，
  其中 `configValue` 来自 `configForms.get('winstage-sandbox')` 的快照，
  `workspaceRoot` 来自 `owner?.session?.cwd`（`:200-204`）。
  ⇒ **优先插件 Config**，不是"来自 profile"。Lead 的表述需要修正。
- 真正的不对称有两条：
  1. **settings 里 `workspaceRoot` 为空时**回退到 `owner.session.cwd`。schema 的默认值是 `''`
     （`dsh-plugin/schema.js:159-162`），所以"没显式配置"就会走回退。若会话 cwd ≠ 插件 config 的工作区，
     面板会去读**另一个工作区**的 `.dshstage/review.json`。
     本项目根那份 review.json 现在还写着 `pending:true`（1 个待审文件）—— 这种回退会把**别的实例的**
     待审内容显示出来。
  2. **host 行与 fs 行的"根"来自两个不同的配置键**：`host-plugin.mjs:297`
     用 `config.workspaceRoot`，`staging-fs.mjs:131` 用 `config.cwd`。
     `getReviewService()` 按 canonical 根做**进程内单例**（`review-service.mjs:330-343`），
     两个键一旦不一致 → 两个单例 → **暂存写到 A、快照发布在 B**，面板读 B 永远看不到改动。
     当前 `cordis.patch.yml` 把两者写成同一个路径（`:23` 与 `:30`）所以没暴露，但这是真实的脆弱点。
- 放大风险：`workspaceFiles.read` 走 `locateFile()`（`dsh-api-workspace-files\lib\index.js:588-608`），
  **不调用 `confine()`**（`contains` 校验只在 `list` 的 `:500`）；`read`/`readBytes` 都走 `locateFile`。
  ⇒ 客户端可以读**任意绝对路径**（受 OS 读权限约束），所以 (b)1 的后果不仅是"读不到"，而是"读错工作区"。

**建议修复（C-7 串台，优先级仅次于 S5；Lead 已确认方向）**
- `dsh-plugin/client.js:173-181`：去掉 `configValue.workspaceRoot || workspaceRoot` 里的**静默兜底**。
  改为：只有 `configValue.workspaceRoot` 显式存在且非空时才轮询/接管；
  若必须用 `owner.session.cwd` 兜底，则**先判定它是否位于 `config.workspaceRoot` 之下**
  （或至少不越过插件 config 的工作区），不满足就 `store.publish({ status: 'idle' })` 并且
  `routeOf` 返回 `null` —— 宁可不显示，也不显示别的工作区的待审内容。
- `dsh-plugin/client.js:126-128`：`routeOf` 可再加一条"快照里的 `workspaceRoot` 与我打算显示的根一致"
  的自校验（review.json 本身就带 `workspaceRoot` 字段，`review-service.mjs:162`），
  不一致就拒绝接管。这是**零额外 IO** 的兜底，能直接挡住串台。
- 验证方式：把 3081 的 profile 里 `workspaceRoot` **留空**，同时保证项目根 `.dshstage/review.json`
  仍是 `pending:true`；修好后 3081 面板**不得**出现（因为 3081 的工作区 `.t\dsh2\ws` 没有待审），
  而修好前会出现"项目根的待审文件"——这就是串台的判别实验。

**建议修复（C-8 配置漂移；Lead 倾向在 bundle patch 里写死两者，我同意）**
- `dsh-plugin/cordis.patch.yml`：把 `winstage-sandbox.config.workspaceRoot`（`:23`）
  与 `winstage-fs.config.cwd`（`:30`）**在补丁里显式写成同一个值**（现在恰好相同，
  但应改成"结构性同源"，避免将来只改一处）。
- 可选加固：`staging-fs.mjs:131` 读取 `config?.cwd || process.cwd()` 时，
  若 `config.workspaceRoot !== undefined && config.cwd !== config.workspaceRoot` 就 `throw`
  （fail-closed，宁可 fs 行不激活，也不要"暂存写 A、快照发布 B"的静默漂移）。
  这与该文件第 58-64 行"拿不到契约就不注册任何 fs 提供方"的既有 fail-closed 风格一致。
- 验证方式：把两个配置故意写成不同路径，期望 fs 行**拒绝激活并报错**（而不是静默分叉）。

### 4.5 第二个缺口：快照到了但 chain 选举不会自己重跑（`[引用]`机制 + `[未实测]`行为）

- 渲染锚点只在**槽位记录版本变化**时重渲染：
  `dsh-client-ui-renderer\lib\client.js:1096-1103`
  `useSyncExternalStore(fn => host.subscribe(slotKey, fn), () => host.getVersion(slotKey))`。
- 版本只在**注册/注销/崩溃让位**时 bump（`dsh-client-ui-slots`：`markDirty` 的调用点全部来自
  `register`/`dispose`/`reportEntryError`；`SlotCore` 没有公开的 "invalidate" 方法）。
- 本插件 `select` 读的是**模块级 store**（`client.js:107-120`），而 `store.publish()` 只通知
  `store.subscribe(...)` 的订阅者 —— 全文件只有**已经渲染出来的面板自己**订阅（`client.js:319-320`）。
  ⇒ 首次拉取快照不会让 `select` 重跑；面板要等到锚点因为别的原因重渲染（流式输出/切会话/其它槽位变更）
  才可能接管。
- 对照设计：内置审批面板把状态放在 **ownerProps**（会话标准套件）里，所以它会随会话状态变化自动重选。
  **最小修复方向**（T3 二选一，需 T4 验证）：
  1. 让 `select` 只依赖 `ownerProps` 里的会话状态（例如把一个"有待审"的会话级标记放到待审状态源里）；
  2. 或把审阅状态放进槽位的 `store` 座位（`ui-slots` 的 `defineStore` 座位），让状态变化走
     槽位订阅通道（**需要先确认该座位是否会 bump 版本** —— 我在 `SlotCore` 里没有找到
     store→`markDirty` 的路径，这一条实现前必须先做一次最小实验，不能想当然）。
- **行为层面记 `[未实测]`**：这属于"时序窗口"，只能用真实浏览器观测（T4）。
  验收断言：新开 3081 tab、`review.json` 已是 `pending:true` 的前提下，
  **不做任何其它交互**，AX 树在 N 秒内出现"WinStage 暂存待审"；若出现不了，
  就说明需要显式失效通道（而不是"再等等"）。

---

## 5. 环境事实与风险（不属于修复项，但会影响所有结论）

1. **3080 当前 profile 里没有这个 bundle。`[实测]`（截至 2026-09-28T05:52Z）**
   - `C:\Users\Administrator\.dsh\profiles\web\package.json` 的 `dsh.profile.bundles`
     只有 4 条，**不含** `@local/dsh-winstage-sandbox`（`dependencies` 里还留着 `link:`）；
     `cordis.patch.yml` 里的 `winstage-sandbox` 覆盖项也没了。
     同目录存在 `package.json.bak-winstage-20260928-132527` / `cordis.patch.yml.bak-…`，
     **备份内容里有**这两项 ⇒ 13:25:35 / 13:28:48 被改过。
   - 交叉验证：`.dshstage/staged/.t/staged-demo.txt` = `v3`，而 `read` 工具读 `.t/staged-demo.txt`
     返回**真实磁盘的 `v2`** ⇒ 当前会话的 `ctx.fs` 不是 `winstage-fs`。
     另一独立迹象：我的 `write`/`edit` 工具仍广告 `sandbox_permissions`
     （`dsh-tool-fs` 由 `ctx.fs.sandboxMode` 决定，`staging-fs.mjs:140-142` 刻意返回 `undefined`）。
   - **含义（Lead 已确认这是有意为之，且必须写清）**：用户明确要求「**不要使用这个 dsh 进程来加载插件**」，
     所以 3080 不带 bundle 是**正确状态**，Lead 决策**绝不重启 3080**（它承载用户与 Lead 的会话，
     且 `DSH集成.md` §4 记录在线切换 bundle 会让宿主退出）。
     ⇒ **3080 上的任何 UI 观察（面板出现与否、暂存是否生效）对本插件没有判别力**；
     本轮所有插件逻辑结论只能来自 3081（或探针自建的实例）。
2. **`.dshstage` 是每 workspaceRoot 一份**（`review-service.mjs:100-102` +
   `Workspace({workspaceRoot})`）。T1 的 3081 用 `.t\dsh2\ws` 是正确做法；
   但要注意 §4.4(b)1 的回退会把项目根那份也读进来。
3. **本机 shell 实际是 Windows PowerShell 5.1**（§2.3 注）。
4. **在线切换 bundle 的崩溃风险**（`DSH集成.md` §4）意味着"修复后要重启 dsh"，
   而重启 3080 会中断用户会话 ⇒ 需要 Lead/用户拍板。

---

## 6. 给 T3 的最小改动清单（按 D2 授权）

| 优先级 | 文件:行 | 改法 | 风险 | 判定成功 |
|---|---|---|---|---|
| P0 | `dsh-plugin\cordis.patch.yml:20` | 行名 `@local/dsh-winstage-sandbox/host-plugin` → `@local/dsh-winstage-sandbox` | 丢热加载技巧；改 composition 需重启 | 3081 启动图出现该 id（§4.3 断言） |
| P1 | `dsh-plugin\fs-entry.mjs:15` + `staging-fs.mjs:112` | 默认从 `direct` 改为 `deny`（保留 env 开关语义，可改为 `WINSTAGE_STAGE_OUTSIDE=direct` 显式放开） | 模型面 `write`/`edit` 指向工作区外将硬失败（D2 已接受） | P2 的 D 组断言翻转；§2.2 的自身落盘清单逐项不变 |
| P1 | `dsh-plugin\staging-fs.mjs` 新增 `watch()` 覆写 | 转发超类观察者 + 暂存变更本地失效（§2.1） | 跨进程改动仍不可见（需文档标注） | `p1-watch.mjs` 两个 verdict 均为 true |
| P1 | `dsh-plugin\fs-entry.mjs:15` + `staging-fs.mjs:112`（收尾） | 确认 `deny` 分支抛的是**插件专属错误码** `FS_SANDBOX_DENIED`（`error instanceof FsError`），断言不许退化成"看到 EPERM 就算过" | 无 | 见 §2.2 的验收区分（插件码 / 外层 EPERM 必须分开） |
| P0 | `dsh-plugin\client.js:126-128` + `:173-181` | 去掉 `configValue.workspaceRoot || owner.session.cwd` 的静默兜底；并加"快照 `workspaceRoot` 与本面板根一致"自校验（**C-7 串台**） | 未配置 `workspaceRoot` 的部署需补配置，否则面板不显示（宁可不显示） | 把 3081 的 `workspaceRoot` 留空后，面板**不得**显示项目根那份 `pending=true` 的待审内容（§4.4 判别实验） |
| P1 | `dsh-plugin\cordis.patch.yml:23` 与 `:30` | 两个"根"在补丁里**显式写成同一个值**（**C-8 配置漂移**）；可选加固：`staging-fs.mjs:131` 在两值不一致时 fail-closed | 与现有 profile 配置组合需回归 | 两值故意写不同时 fs 行拒绝激活并报错；写相同时只创建一个 `ReviewService` |
| P3 | S1 | **不改代码，改文档**：把 S1 如实标为"未提供 + 前提 = 不受限会话"（§2.3） | 无 | 文档中不出现"S1 已解决" |
| 门 | — | 每处改动后重跑 `.\autotest.cmd --skip-audit` | — | 9 套件 / 250 断言**不下降**（基线见 §1） |

---

## 7. 证据文件索引（全部为本 T2 产出）

| 文件 | 内容 |
|---|---|
| `.t/dsh2/probe/p1-watch.mjs` / `out/p1-watch.json` | S7 实测（暂存不触发监听，真实磁盘触发） |
| `.t/dsh2/probe/p2-outside.mjs` / `out/p2-outside.json` | S2 实测（default direct / deny / env 开关 / 工作区内对照） |
| `.t/dsh2/probe/p3-shell-bypass.mjs` / `out/p3-shell-bypass.json` | S1 实测（shell 写真实磁盘、暂存树无条目、两条写路径分叉） |
| `.t/dsh2/probe/b1-capabilities.mjs` / `out/b1-probeWin32Abi.json` | 3080 会话 `probeWin32Abi()` 原始输出（复核 Lead） |
| `.t/dsh2/probe/b3-cli.mjs` / `out/b3-cli-probe.txt` `/b3-cli-status.txt` `/b3-cli-exec.txt` | CLI 执行器层实测（tier=T2 acl-only、exec fail-closed） |
| `.t/dsh2/probe/b0-autotest-baseline.txt` | 改动前回归门基线（9 套件 / 250 断言 / exit 0） |
| `.t/dsh2/probe/c2-boot-graph-3081.mjs` / `out/c2-boot-graph-3081.json` / `out/index-3081.html` | 3081 启动图实测（client 半缺席） |
| `.t/dsh2/logs/probe-restricted-token-3081.txt` | T1 代跑的 3081 谱系令牌原始输出（归属见 §3.2） |
| `docs/dsh2-需求与验收.md` §6、`docs/DSH集成.md` §3.3/§4/§5、`docs/实测证据记录.md` R6/N8 | 引用来源（非本次实测） |
