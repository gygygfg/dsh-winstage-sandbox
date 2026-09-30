# 第二实例：发现台账（多人共享，**只追加，不要改别人的小节**）

> 规则：每人只维护自己的小节，标题逐字用 `## T1` / `## T2` / `## T3` / `## T4` / `## T5`。
> 每条发现一行：`- [判定] 一句话结论 —— 证据路径`，判定取 `[实测]` / `[引用]` / `[未实测]`。
> 详细论证写各自的报告文件；这里只放"能让别人快速接上"的最小集。

## Lead

- [实测] 当前 3080 会话 `createRestrictedToken` **不可行**：`TOKEN_ADJUST_DEFAULT=NO`、`TOKEN_ADJUST_SESSIONID=NO`
  —— 证据：`node -e "import('./src/capability.mjs').then(m=>console.log(JSON.stringify(m.probeWin32Abi(),null,2)))"`
  （输出见 `docs/dsh2-需求与验收.md` §6 与 T2 报告）。
- [实测] 当前 3080 会话**外层 DSH 沙箱已拒绝工作区外写入**（`writeOutsideWorkspace: deny(EPERM)`）。
  含义：受限会话里观察到的"工作区外写入被拒"**不能**当作 WinStage 插件起作用的证据。
- [实测] `client.js:124` `routeOf()` 在没有 `owner.sessionId` 时必然返回 `null`，即 `conversation.composer`
  槽位不接管输入框；面板读快照走 `workspaceFiles.read`，路径基准来自 profile 而非插件 config。
- [实测] **T2 复核后更正 Lead 的过度归因**：`routeOf` 的 `!owner.sessionId → null` **不是缺陷**
  （chain 槽位本就要求会话，内置审批窗同理）；真正的根因是 client 半从未进入 `__DSH_BOOT__`。
  —— 证据：`docs/dsh2-基线报告.md` §4.4
- [实测] 30 分钟粒度校验：两个实例各自的 `review.json` **workspaceRoot 都正确**
  （项目根 / `.t\dsh2\ws` 各自独立、各自 `pending=true`、candidate id 不共享）⇒ 隔离当前成立。
- [引用] 本机**无 Chrome**、用户 Edge 未开远程调试端口 ⇒ 浏览器测试改为**隔离 Edge 实例**
  （独立 `--user-data-dir` + `--remote-debugging-port=9222`，headless 与有头各跑一次对账）。
- [实测] 归属更正：05:55:49「项目根被 publish」事故 = 3081 profile 覆盖层 `name` 断言失配导致
  回退到项目根，**由 T1 排查发现**（不是无关噪声，也不是 T2 产出）。
- [引用] `cordis-plugin-include/lib/index.js:99-102` `target[key] = value` ⇒ patch 对 `config` 是
  **整体替换、不是深合并** ⇒ profile 覆盖层必须重述该行 config 的**所有键**，否则 bundle 层新增键
  **在实例里静默丢失**（T3 的 fail-closed 守卫因此在 3081 一度空转）。Lead 已要求 T1 修复。
- [实测] **S5 已闭环**（用户沙箱外启动 Edge 154 headless + CDP）：审阅悬浮窗**确实出现**，AX 11 命中
  （`WinStage 暂存待审` + `暂时收起 / 拒绝全部 / 批准全部`）。截图
  `.t\dsh2\browser\r2-headless-panel-visible.png`。出现前置：关首次运行模态 + 有工作区/会话 + composer 重挂载。
- [实测] **面板出现但三个控件无效**（另有 `全选/清空选择` 可用的**阴性对照**，排除"没点到"）：
  **B** `/winstage*` 未注册进会话命令面 ⇒ 批准/拒绝**静默失效**（`/winstage status` 与
  `/definitely-not-a-command-xyz` 行为完全相同）；**A** 页面加载/刷新不挂载（10s 仍 0 命中，点「新会话」→11）；
  **C** `暂时收起` 收不起自己。→ 已建 `task-5` 交 T3 修。
- [实测] **T1 早先的 "commands=6" 不成立为线上证据**：那是进程内直接调 `registerCommands()` 得到的，
  **绕过了 `ctx.inject(['commands'], …)`**。Lead 已明确禁止再用这种断言形式。
- [实测] **A/B/C 已修并复测 PASS**（headful 9223 与 headless 9222 结论一致）：B 根因 = `input:{placeholder}` 而校验器要
  `hint`（`dsh-commands:154-163`）⇒ 回调抛错 ⇒ 6 条全未注册；A/C 根因 = 槽位只在渲染时 `select`，
  改为"仅在接管状态跃迁时重挂注册"。**"批准所选"后 `review.json` 变化且 `stage-probe.txt` 真落盘（22 B）。**
- [实测] **cookie 跨 3081 重启存活**：cookie 名与 `expires` 与重启前**逐字相同**
  （`dsh-auth-w3iJaA6qw3qDSBs2Itl-h4S-Y-ZeYCC-N_iZO-eI_qw`），两个浏览器实例都不用重装。
  注意它 `httpOnly:true`，`document.cookie` 读不到，必须用 `Network.getAllCookies`。
- [实测] **Lead 自己踩到的三个度量/解析坑**（写下来免得后人重踩）：
  ① `__DSH_BOOT__` 会**先出现在 `<script src=…>` 的属性里** ⇒ 必须找赋值语句 `__DSH_BOOT__"] = {`，找回字串会拿到属性；
  ② client bundle 的 URL 必须**逐字用 entry 自带的 `url`**（`plugins/??<id>/client.js&rev=…`），自己拼 `/client.js` 会 404；
  ③ `GET /?token=…` 是 **303 且 body 为空**，必须再带 cookie 取一次首页才有 HTML。
- [实测] **T4 的度量陷阱（会造出假 PASS）**：`/winstage status` 的**输出会回显进聊天记录**，
  AX 里出现 `button "winstage winstage WinStage 暂存待审 …"` 这类**回显节点**且**包含**面板文案 ⇒
  用**子串**匹配判面板存在性会误判。必须用**精确名**匹配（面板自身名恰好是 `WinStage 暂存待审` / `暂时收起`）。
- [实测] **收尾已完成**（用户选择"停掉 3081 + 两个 Edge"、"回写 `docs/DSH集成.md`"）：
  3081 `bindFree=true`（`stop-dsh2.mjs` exit 0），9222/9223 经 CDP `Browser.close` 优雅关闭；
  `docs/DSH集成.md` 已更正 §1 行名规则 / §3.3 S5 归因 / §3.4 三个新缺陷 / §3.5 假证据 /
  §4 崩溃风险 / §5 边界状态（S2/S5/S7 已改，新增 S8/S9）/ §7 DSH 侧边界 / §9 更正对照表；
  `README.md` 增补 §7.1。**代码改动仍未提交 git（本环境 PATH 无 git）**。
- [实测] 3081 的两个「选择/添加工作区」入口都失败（`directory picker failed: spawn EPERM`，
  native 选择器由沙箱内宿主进程 spawn），且**无手动路径兜底**；T4 用应用自身 RPC
  `POST /api/workspace/create` 绕过并建立真实会话（未伪造面板状态）。
- [实测] `?winstageDebug=1` 的 dump 是 **apply 时输出、非实时轮询** ⇒ 面板已正常显示后它仍写
  `review:{"status":"idle"}`，**不可当"没接管"的证据**；它只适合判 `containsMine`/`myFormStatus`。

## T1

（dsh2-rig 追加）

## T2

> 详细论证与原始输出见 `docs/dsh2-基线报告.md` 与 `.t/dsh2/probe/out/**`。这里只放最小集。

- [实测] S7 成立：暂存变更不触发任何 `watch()` 事件；同一观察者在真实磁盘变更时会触发
  —— 证据：`node .t\dsh2\probe\p1-watch.mjs` → `.t\dsh2\probe/out/p1-watch.json`
  （`stagedWriteEmitsWatchEvent=false` / `realDiskWriteEmitsWatchEvent=true`）
- [引用] `watch(target, changed, signal)` 契约 = "仅失效通知"（无事件类型/路径）；本地后端 chokidar `depth:0`
  —— 证据：`dsh-fs\lib\types\index.d.ts:71`、`dsh-fs-local\lib\index.js:726-750`
- [引用] S7 的唯一消费者是 `ctx.remote.workspaceFiles.changes` 的文件变更流（全包仅 1 处 `ctx.fs.watch(`）
  —— 证据：`dsh-api-workspace-files\lib\index.js:75`
- [实测] S2 成立：`stageOutside` 默认 `direct`（工作区外 `writeText` 直接落盘）；`deny` 抛 `FS_SANDBOX_DENIED`
  —— 证据：`.t\dsh2\probe\out\p2-outside.json`（含 env 开关 unset/""/垃圾值 → direct）
- [引用] S2 改 `deny` **不破坏 DSH 自身落盘**：会话日志/附件/spill/storage 全走 `node:fs`；经 `ctx.fs` 写的
  只有模型面 `write`/`edit`（`dsh-tool-fs:586/735`）与 `dsh-tool-str-replace-editor:148/174/214`
- [实测]+[引用] 受限会话里测不出 S2 插件行为：外层 DSH 沙箱先以 `EPERM` 拒绝工作区外写入
  —— 证据：`.t\dsh2\probe\out\b1-probeWin32Abi.json`（`writeOutsideWorkspace=fail/EPERM`）；
  故 S2 验收断言必须绑定**插件专属错误码**，不能靠 EPERM 区分
- [实测]+[引用] S1 成立：`pwsh`/`bash` 写入完全不经 `ctx.fs`（`ctx.shell` → `ctx.subprocess`，真实 cwd）
  —— 证据：`.t\dsh2\probe\out\p3-shell-bypass.json`；`dsh-tool-pwsh:263-268/314`、`dsh-pwsh-local:173-180/215`
- [实测]+[引用] S1 在本机**不可能实现也不可能验证**（依赖受限令牌 + 接管 `ctx.shell`）⇒ 正确交付 =
  文档标注"未提供 + 前提 = 不受限会话" —— 证据：§3.2 三个档位
- [引用] B-1 成立并加强：插件只装载暂存面，`WindowsStageExecutor` **没有接进 `ctx.shell`/`ctx.sandbox`**；
  唯一适配层 `dsh-plugin\provider.mjs` **无人引用**，且它 import 的 `bridge.mjs` **文件不存在**
  —— 证据：`cordis.patch.yml`（只 3 项）、`host-plugin.mjs:28/77`、`provider.mjs:46`、`dsh-plugin` 目录清单
- [实测] B-2 档位 1（3080 受限会话）：`createRestrictedTokenViable=fail`，缺
  `TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID` —— 证据：`.t\dsh2\probe\out\b1-probeWin32Abi.json`
  （与 Lead 的数字逐字一致）
- [实测] B-2 档位 2（3081 **谱系**，非 agent shell）：同为 `fail`，缺同样两项
  —— 证据：`.t\dsh2\logs\probe-restricted-token-3081.txt`（T1 代跑，归属见报告 §3.2）
- [未实测] B-2 档位 3（不受限会话）本机拿不到；3081 **自身 agent shell** 也无法驱动（无 attach 子命令、
  3081 无 agent 会话）⇒ 两档都写 `[未实测]`，不用推理冒充
- [实测] B-3 CLI 执行器层：`src/cli.mjs exec` → `SANDBOX_INIT_FAILED: OpenProcessToken failed (Win32 5)`
  （退出码 1）；`probe` 判 `tier=T2 (acl-only)`、`nesting.viable=false`
  —— 证据：`.t\dsh2\probe\out\b3-cli-probe.txt`、`b3-cli-exec.txt`
- [实测]+[引用] B-4 内核隔离层：**本插件不提供**；AppContainer `E_ACCESSDENIED` 且未接进执行器
  —— 证据：`b3-cli-probe.txt`（`hr=0x80070005`）、`README.md:372-382`、`docs/实测证据记录.md` N8
- [实测] 本机 PATH 无 `pwsh`、无 PowerShell 7 ⇒ 工具名 `pwsh` 实际执行 Windows PowerShell 5.1
  —— 证据：`p3-shell-bypass.json` 的 `shellResolution`
- [实测] C-3 **S5 头号根因**：client 半从未进入 `window.__DSH_BOOT__` —— 3081 首页启动图 entries 里
  winstage 出现 **0 次**（host 半却在跑：review.json 13:51:00 已发布）
  —— 证据：`.t\dsh2\probe\out\c2-boot-graph-3081.json` + `index-3081.html`
- [引用] C-3 机制：loader 行名是**子路径 specifier**（`cordis.patch.yml:20/27`），而 client 扫描器只认
  **精确包名** —— `dsh-client-modules\lib\index.js:82-88`（3 段 → undefined）、`:747`（于是直接 return
  undefined）、`:836`（有 fiber 且未 disabled 才成 bundle）⇒ `dsh.client` 声明再对也没用
- [实测/更正] `docs/DSH集成.md` §3.3「页面还没刷新」的归因**不成立**：刷新任意次都不会出现
  —— 证据同上（这是要回写进该文档的更正）
- [引用] C-4 `client.js:124` 的 `!owner.sessionId → null` 属实但**不是缺陷**（composer 是 chain 槽位，
  内置审批面板 `dsh-client-ui-approval:344-354` 同样要求会话；它是 Lead 的过度归因）
- [引用] C-7 串台缺陷（优先级仅次于 S5）：`client.js:176` `configValue.workspaceRoot || owner.session.cwd`
  的静默兜底 + `workspaceFiles.read` 的 `locateFile` **不做 contains 校验**
  （`dsh-api-workspace-files\lib\index.js:588-608`，只有 `list` 在 `:500` 校验）
  ⇒ 会把**项目根**那份 `pending=true` 的快照显示到 3081 面板上
- [引用] C-8 配置漂移：host 行用 `config.workspaceRoot`（`host-plugin.mjs:297`）、fs 行用 `config.cwd`
  （`staging-fs.mjs:131`）；`getReviewService` 按根做单例（`review-service.mjs:330-343`）⇒ 两值不一致时
  暂存写 A、快照发布 B
- [引用]+[未实测] C-5 首屏时序窗口：chain 锚点只在槽位版本变化时重渲染
  （`dsh-client-ui-renderer\lib\client.js:1096-1103`），而 `store.publish()` 不 bump 版本、只有面板自己订阅
  （`client.js:319-320`）⇒ "快照到了但面板还没接管"的窗口。**行为层面 `[未实测]`，Lead 决定留待 T4 判定，
  不得据此改代码**
- [实测] 回归门基线（改动前）：`.\autotest.cmd --skip-audit` = 9 套件全过 / 250 断言 / 退出码 0
  —— 证据：`.t\dsh2\probe\out\b0-autotest-baseline.txt`
- [实测] 3080 现状：profile **未装载**该 bundle（`dsh.profile.bundles` 无此项，有 13:25/13:28 的
  `*.bak-winstage-*` 备份为反证），且 `read` 工具读到真实磁盘 v2 而非暂存 v3
  ⇒ **3080 上的 UI 观察对本插件无判别力**（用户明确要求不用该进程加载插件，Lead 决策不重启 3080）

## T3

> 详细论证、前后 SHA256、回滚手册与全部原始输出见 `docs/dsh2-修复报告.md`；
> 一条命令复跑全部断言：`.t\dsh2\fix-asserts\run-all.cmd`（退出码 0）。这里只放最小集。

- [实测] **F1 已修并活体验证通过**：3081 首页 `__DSH_BOOT__`（rev `3851a05f1d1a`，65 entries）里出现
  `{"id":"@local/dsh-winstage-sandbox","url":"plugins/??…/client.js&rev=c20a44a40ab9","immediately":true}`，
  该 bundle 路由返回 `200 text/javascript`（我量到 25948 B）
  —— 证据：`node .t\dsh2\fix-asserts\f1-live-3081.mjs` → `fix-asserts/f1-live-3081.json`。
  **T4 独立复现了同一条**（`browser/raw/r2-dsh-boot-parsed.json`），且确认 bundle 内含面板文案
- [引用] F1 根因（我独立复核，与 T2 §4.3 一致）：`dsh-client-modules\lib\index.js:82-88` 对三段 specifier
  返回 `undefined` → `:747` 直接 `return undefined` → `:836 processOne` 收不到 source ⇒ client 半不下发
- [实测] **"命令只 apply 一次"的判据**（不靠日志计数）：用**真 `applyEntryPatches`**
  （`cordis-plugin-include\lib\index.js:246` 导出）+ 真 js-yaml 组合 bundle 层，断言恰好 **1 行**解析到
  `host-plugin.mjs`；反事实：两行同用裸名 → 2 行 ⇒ **fs 行必须保持子路径**（三条理由见报告 §2.3）
  —— 证据：`.t\dsh2\fix-asserts\f1-static.mjs` 的 A3 / A3-counterfactual 组
- [实测] **3081 行名来自"仓库 patch 的部署副本"**：`dsh-app-boot\lib\index.js:507-509/931-932` 用
  `resolveBundleDir` 得到的安装目录取 `dsh.bundle.patch`；`node_modules\@local\dsh-winstage-sandbox` 是**实体目录**；
  部署副本与仓库改前逐字节相同（SHA256 `2BF6FB7E…`，`Compare-Object` 差异 0 行）
- [实测]+[引用] **profile 覆盖层的断言陷阱**（差点翻车）：非 insert 补丁的 `name` 是**断言**，
  不匹配则**整条补丁连 config 一起被跳过**（`cordis-plugin-include\lib\index.js:95-98`；且 `:99-102` 的
  overrides 排除 `name`，永远不能重命名）—— 若 profile 层仍断言 `.../host-plugin`，3081 的
  `workspaceRoot: .t\dsh2\ws` 会被静默丢弃、`.dshstage` 落回项目根（T4 观测到的 05:55:49 事故产物即此形态）。
  **T1 已同步改名为裸包名**；现 3081 的 `.t\dsh2\ws\.dshstage\review.json` 的 `workspaceRoot` 确为 `.t\dsh2\ws`
  —— 证据：`fix-asserts/f1-static.mjs` 的 A4 组（陷阱版 → `A4-TRAP-CONFIRMED`；现为 PASS）
- [实测] **F2-C7 串台已修**：`client.js:206` 删掉 `|| owner.session.cwd` 静默兜底、`:153` 加
  "快照自带 `workspaceRoot` ↔ 面板的根"零 IO 自校验。用**真 `client.js`** 跑：
  根为空时 `matched=null` 且 `readCallCount=0`（**一次都不读**）；而**改动前备份**在同一输入下
  确实读了 `C:\...\WinStageSandbox\.dshstage\review.json`（项目根）并接管 ⇒ 串台被复现且被挡住
  —— 证据：`.t\dsh2\fix-asserts\f2-client-c7.mjs`（7/7，含 2 条改动前对照）。
  **T4 给出的二值判别式可直接复用**：部署后若面板列出 `stage-probe.txt` = 根正确；
  列出 `.t\staged-demo.txt` = 跨工作区泄漏复现
- [实测] **F2-C8 已修**：`cordis.patch.yml` 用 YAML 锚点 `&winstageRoot`/`*winstageRoot` 让
  `host.workspaceRoot`、`fs.cwd`、`fs.workspaceRoot` **结构性同源**；`staging-fs.mjs:147-168` 加
  漂移 fail-closed（`code=FS_STAGE_ROOT_DRIFT`）。并**实测**该键能穿过 loader 校验
  （`cordis\lib\index.js:956-961` 真实路径：`Config['~standard'].validate` 保留未知键）
  —— 证据：`.t\dsh2\fix-asserts\f2-c8-root-drift.mjs`（8/8）
- [实测]+[引用] ⚠ **C-8 守卫在"只重述 cwd"的 profile 层下是空转的**：`cordis-plugin-include\lib\index.js:99-102`
  对 `config` 是**整体替换**不是深合并 ⇒ 该行最终 config = `{cwd}` ⇒ `workspaceRoot===undefined`
  ⇒ 判据第一项恒假、守卫永不触发，且 bundle 补丁的锚点也被整段绕过（退化成"两个恰好相等的字面值"）。
  **这不是"正常形态"**（我最初的注释写错了前提，已按 Lead 指正改成显式 ⚠ 已知限制）。
  T1 已在 profile 的 fs 行补 `workspaceRoot` 使其真正生效 ⇒ **通用教训**：profile 覆盖层必须重述该行 config 的
  **所有**键，未写的键不会从 bundle 层继承，而是**静默消失**
- [实测] **F3 默认已收紧为 `deny`**：`fs-entry.mjs:21` 改为 `=== 'direct' ? 'direct' : 'deny'`（未设/空/垃圾值全 deny），
  `staging-fs.mjs:128` 同步；工作区内写入不受影响（仍只进暂存树）
- [实测] **F3 判别证据（Lead 要求的"限制前后原文"）**：同一个目标路径、同一个操作 ——
  限制前（`direct`）：`threw=false`、真实文件存在、内容 `same-operation\n`；
  限制后（默认 deny）：`threw=true`、`code=FS_SANDBOX_DENIED`、`instanceof FsError=true`、
  原文 `cannot write "…\g-same-operation.txt": outside the staged workspace root`、真实文件不存在。
  对照的**外层沙箱**拒绝（写会话工作区之外，真实观测）：`code=EPERM`、`instanceof FsError=false`、
  原文 `EPERM: operation not permitted, open 'C:\Users\Administrator\Desktop\winstage-outer-boundary-probe.tmp'`
  ⇒ 判别式 `error instanceof FsError && error.code === 'FS_SANDBOX_DENIED'` 可把两者完全分开
  —— 证据：`.t\dsh2\fix-asserts\f3-outside-default.mjs` 的 G / E 组（7/7；探针文件已删除）
- [实测] **F4 `watch()` 已覆写**：超类观察者照旧 + 暂存变更本地失效。暂存写文件 → `fileEvents=1`
  （P1 修前实测 `0`）；真实磁盘写仍触发（`{1,1}→{2,2}`）；精度对齐超类 —— 兄弟文件的暂存变更**不**通知
  file target、孙辈的暂存变更**不**通知 dir target；`close()` 后不再通知
  —— 证据：`.t\dsh2\fix-asserts\f4-watch.mjs`（7/7；T2 的 P1 探针只读未改，逻辑复制后扩展）
- [引用] F4 残余边界（如实标注，未承诺）：**跨进程**改动（CLI / 另一个 DSH 实例写同一份暂存树）
  仍不会触发通知 —— `dsh-fs-local\lib\index.js:726-750` 的本地 chokidar 观察者也看不到
- [实测] **回归门**：`.\autotest.cmd --skip-audit` = **9 套件全过 / 250 断言 / 退出码 0**，
  与 T2 基线逐项一致；且是**最终字节**上跑的。`run-all.cmd` 亦全绿（退出码 0）
- [未实测] **F2/F3/F4 尚未在 3081 活体验证**：`[实测]` 现部署快照**只含 F1**
  （`cordis.patch.yml`=`64834DDA…`、`client.js`/`staging-fs.mjs`/`fs-entry.mjs` = 改动前哈希）
  ⇒ 需 **T1 再 sync + 重启 3081**；F2 的**界面可见性**验收还叠加 T4 的浏览器阻塞
- [未实测] **C-5（首屏时序窗口）**：按 Lead 决策**未改代码**，待 T4 用真实浏览器判定
- [实测] 写范围自证：`dsh-plugin` 下改动恰好 4 个文件（`cordis.patch.yml`/`client.js`/`staging-fs.mjs`/`fs-entry.mjs`），
  `src/`、`tests/` 同期**零改动**；未重启/未改 3080 实例与 `C:\Users\Administrator\.dsh`

### T3 追加（T5b：浏览器实测三缺陷 B / A / C）

> 详细论证见 `docs/dsh2-修复报告.md` §12。以下为最小集。

- [实测] **B（致命）根因已定位并修好**：`host-plugin.mjs:260` 传的是 `input: { placeholder: … }`，
  而 `dsh-commands\lib\index.js:154-163 normalizeDefinition()` 要求 **`hint`**
  ⇒ 抛 `TypeError: command "winstage" input hint must be a string` ⇒ 整个 `ctx.inject(['commands'], …)`
  回调在第一条就死 ⇒ **6 条命令一条都没注册**。改用 `input: { hint: … }`
  —— 证据：`.t\dsh2\fix-asserts\f5-commands-register.mjs`（7/7、
  **真 `Context` + 真 `CommandRuntime` + 真 `ctx.inject`**）
- [实测] **"T1 的 commands=6 是假证据"已实证**：那是在进程内直接调 `registerCommands()`、
  把定义塞进 mock 数组，**绕过 `normalizeDefinition()`**。同一份改动前代码经**真实路径**注册
  = **0 条**，报错原文即上面的 `TypeError`（`f5` 的 B4/B5 两条 CONTROL）
- [引用] **`ctx.inject(['commands'], cb)` 在根 ctx 上足够**（回答任务的问题）：cordis
  `inject(inject, callback)` 就是 `plugin({inject, apply})`（`cordis\lib\index.js:1600-1606`）；
  平台自带 `dsh-permission-presets\lib\index.js:206` 与 `dsh-plan-mode\lib\index.js:180`
  用同一模式，且它们的 `permission`/`plan` 确实出现在 T4 实测的 `commands/list` 里
  ⇒ **缺陷不在挂载层，在定义本身**
- [实测] 另加"失败必须响"：注册包进 `try/catch` 并 **error 级日志**
  （`命令注册失败：…（/winstage* 将不可用）`）—— 这族命令原本会**静默消失**
- [引用] **A/C 同一根因**：`conversation.composer` 是 chain 槽位，渲染锚点用 uSES 订阅**槽位版本**
  （`dsh-client-ui-renderer\lib\client.js:1097`）、渲染时才调 `select`（`:1163`）
  ⇒ 模块级 `store` 变化**不会**让 `select` 重跑。A（首屏不挂载）、C（收起无效）都是这条
- [引用] **备选方向 b 不可行**（实证否决）：`SlotCore.register` 的 `options.store` 只是 **scope handle**
  （"one handle, one scope"，`dsh-client-ui-slots\lib\index.js:82-86/195-199`），
  全文**没有** store→`markDirty` 路径 ⇒ 它不是响应式状态座位。T2 当初的判断正确
- [引用] **方向 a 第三方做不到**：ownerProps 由宿主组装，插件无法加字段；内置审批面板能用
  是因为 `pendingInteraction` 本来就在会话标准套件里
- [实测] **采用的通道 = 方向 c，只用公开 API**：`SlotCore` 无公开 invalidate/touch
  （方法清单见 `dsh-cordis-client-runner\lib\client.js:2156` 声明串）；唯一公开的版本推进通道是
  `register()` 与其 disposer —— 各自 `markDirty()`（`ui-slots:223`/`:240`），
  而 `markDirty` 会 `rec.version += 1` 并通知 uSES 订阅者（`:553-563`）。
  ⇒ 实现：**仅在"是否应当接管"发生跃迁时**重挂注册；判据抽成唯一实现
  `winstageElection(sessionId)` 供 `routeOf` 与轮询器 `shouldElect()` 共用
  —— 证据：`.t\dsh2\fix-asserts\f6-slot-election.mjs`（12/12）
- [实测] **防 churn 与归属安全**（两条都做了断言）：
  ① 稳态下 8 次 refresh（每次都 `store.publish`）**不再重挂**（注册数恒为 2）
  ⇒ 轮询不会清掉面板里的勾选/展开状态；
  ② `ctx.slots.register` 的 `this.ctx` 由"从哪个 ctx 读到 `.slots`"决定
  （`cordis\lib\index.js:673-675 getTraceable`）⇒ 重挂出的 effect 仍归本插件 fiber。
  另收紧 `observe()`：无会话时**清空**记住的 `sessionId`，否则两个判据会打架并每 1.5s 来回重挂
- [实测] **C 用"真实组件的 onClick"验证**（不是手写 store 变更）：断言脚本从真 `client.js` 的
  组件树里按文案取出「暂时收起」按钮并调用其 `onClick` ⇒ 槽位版本 +2、`select` 返回 null
- [实测] 改动前对照（同一 harness）：A 场景版本增量为 **0**、C 场景版本增量为 **0**
  ⇒ 断言有判别力，不是自证
- [实测] **回归门**：`.\autotest.cmd --skip-audit` = 9 套件 / 250 断言 / exit 0（= 基线）；
  `run-all.cmd`（现 8 个脚本）全绿、exit 0
- [未实测/待 T4] **A/C 的界面效果**（面板真的在刷新后出现、点收起真的消失）**只能**由浏览器复测保证；
  我的断言只证明"失效通道被触发"这一客户端机制（不渲染 React、不产生像素）。
  B 同理：`/winstage status` 经浏览器 remote 通路返回 `value` 需 T4 复测
- [实测] **部署状态**：`cordis.patch.yml`/`staging-fs.mjs`/`fs-entry.mjs` 已与仓库**逐字节一致**；
  **`client.js`（`D210068E…`→ 需 `5F8AA910…`）与 `host-plugin.mjs`（`6C80E082…`→ 需 `F18AB4EF…`）
  尚未部署** ⇒ 需一次 sync + 重启，再由 T4 复测
- [实测] `f1-live-3081.mjs` 已改为优先取 `logs/dsh2.out.log` 里**最后一条** `?token=`
  （令牌每次重启轮换，`READY.json` 会过期 —— T4 §4.1 的实测），并对候选逐个试到装 cookie 为止

### T3 追加（S3b：三档判级与敏感内容不外泄）

> 详细论证、字段契约与示例 JSON 见 `docs/dsh2-修复报告.md` §13。以下为最小集。
> 施工单 `task-7`，独占文件 `dsh-plugin/review-service.mjs`（**未碰** `staging-fs.mjs`/`src/**`/`client.js`）。

- [实测] **三档落地为"短路顺序链"，不是互斥树**：`classifyChange()` 先判敏感 ⇒ `sensitive`，
  再判工作区外 ⇒ `outside`，否则 `normal`。因此 `external` 字段与 `risk` 档位**可以不一致**：
  `<wsRoot>\.dshstage\staged\x` 实际是 `external:false` + `risk:"sensitive"`（工作区内但敏感）。
  —— 证据：`.t\dsh2\fix-asserts\stage3-classify.json`（`A`/`B`/`D` 三条）
- [实测] ★★ **Lead 的 `hard` 契约有误，已更正**：原契约写"`rule.hard === true` ⇒ danger"，
  但 `src/paths.mjs:181` 对**内置**规则**硬编码** `return { …, hard: true }`
  ⇒ `hosts`/`wifi`/`sam` **全部**带 `hard:true`，`hosts` 会被误判成 danger。
  实测 `MASK_CLASSES` 里只有 `stage-store` 自己写了 `hard:true`（`:164`）。
  **更正为 Lead 决策 B**：danger 按 **id 清单**（`DANGER_MASK_IDS`，14 个）判定，内置规则的 `hard` 一律**忽略**。
  —— 证据：断言 `E`（hosts⇒`risk`）与 `E2`（回归点）在改回 `hard` 判据时会立刻挂
- [引用] **`hard` 字段此前没有任何消费者**：全仓库 `grep` 只有 `workspace.mjs:141 assertReadable`
  读 mask，且只判 `if (mask)` 存在性 ⇒ 这次语义澄清**不改变**任何遮蔽/拒绝行为，
  `src/**` 因此**零改动**（Lead 的 A 方案被否，理由：安全清单不该承担 UI 呈现分级）
- [实测] **danger 集合漂移 ⇒ 硬失败**（Lead 要求"必须响"）：`assertDangerIdsExist()` 在模块加载时
  与断言里各跑一次；抹掉 `MASK_CLASSES` 里的 `ssh` ⇒ 立即抛错，恢复后重新通过。
  —— 证据：断言 `J`
- [实测] ★ **安全断言（端到端且不依赖 S3a）**：把暂存工作区根放在 `.dshstage` 之下，
  普通暂存条目即 danger ⇒ 读**落盘后的** `review.json`：`diff: []` + `truncated: false` +
  `note` 说明，且整份 JSON **逐字搜不到**凭据原文（`G`/`G2` 两条）。
  `totals` 计数与 `riskReason` **照给**（`G3`）—— 面板仍能显示"哪个文件、改了多少行、为什么敏感"
- [实测] **老字段零破坏**：`path`/`op`/`kind`/`totals`/`diff`/`truncated` 逐条在且类型正确，
  新增 `external`/`risk`/`safety`/`riskReason` 与顶层 `riskCounts` —— 证据：断言 `H`/`H2`/`I`/`I2`
- [实测] ★★ **真实 external 条目端到端已通**（S3a 的"工作区外暂存"在本次施工中途落地，
  我实测到行为**从抛错变为暂存**）：工作区外 `.ssh/id_rsa` 经**真实暂存层**⇒
  `risk:"sensitive"` / `safety:"danger"` / `external:true` / `path` 为**绝对路径逐字**，
  且**真实磁盘上没有该文件**（是暂存不是直通）；另一条工作区外普通路径 ⇒ `risk:"outside"`。
  外部危险条目同样 `diff: []` + `note`，整份 JSON 搜不到凭据原文。
  —— 证据：断言 `L1`–`L6`，样例 `.t\dsh2\fix-asserts\stage3-review-sample-external.json`
- [实测] **非阻断提示通道 `alerts`**（对应用户拍板的"运行时只对 danger 报一次、其余一律不阻断"）：
  快照顶层新增 `alerts[]`，danger 存在时恰 1 条
  `{id, kind:"danger-change", severity:"danger", count, paths, message, hint}`；
  `id` 由 `candidateId` 派生 ⇒ 同一候选反复轮询**逐字相同**，Client 可据此"只报一次"；
  无 danger 时 `alerts: []`（不泛化）。**Host 侧不实现任何阻塞式审批** —— 只声明数据。
  —— 证据：断言 `K`/`K2`/`K3`/`L5`
- [实测] **回归门**：`.\autotest.cmd --skip-audit` = **9 套件 / 250 断言 / exit 0**（= 基线，未升未降）；
  本套 `stage3-classify.mjs` = **25/25 强制断言通过 / exit 0**
- [未实测] **面板实际渲染**未测（第三阶段职责）：本轮只保证**字段与取值**可供渲染，
  没跑浏览器、没产生像素

### T3 / S3a（staging-ext，task-6）—— 工作区外条目的底座

- [实测] **硬拒已取消**：`FS_SANDBOX_DENIED` 与 `outsideWrite()` 从可执行代码删除（只剩注释）；
  工作区外 `writeText` 现在**进暂存**：不抛错、真实文件不存在、清单出现 `external:true` 条目。
  —— 证据：`stage3-store.mjs` 的 `A1`/`A1b`/`A13`（`.t\dsh2\fix-asserts\stage3-store.json`）
- [实测] **统一视图（读写都做）**：同一外部路径的 `readText`/`stat`/`lstat`/`readBytes` 返回**暂存投影**，
  未命中暂存的外部路径**回落真实磁盘**；外部目录 `listDir` = 真实磁盘 + 暂存叠加；
  清单 JSON 落盘后**全新 `Workspace` 实例**仍看到 `external:true` 条目（重启后仍在）。
  —— 证据：`A2`/`A2b`/`A2c`/`A4b`
- [实测] **先批准后落盘**：`approve` 前真实磁盘逐字不变；`approve` 按**原始绝对路径**写回；`reject` 退回且条目消失；
  **陈旧基线保护对外部条目同样生效**（`STALE_BASELINE`，外部改动未被覆盖）。—— 证据：`A5`–`A8`
- [实测] **删除/改名可暂存**：外部删除=墓碑（批准前真实文件仍在）、外部改名=`delete`+`create` 绝对键。—— 证据：`A9`/`A10`
- [实测] **敏感路径照暂存**（`…\.ssh\id_rsa` 不拒绝、只打标记；判级归 S3b）。—— 证据：`A11`
  —— **后果如实标注**：`applyCandidate` 的 `maskWarnings` 只记录、不阻断、无外层消费方 ⇒
  对外部敏感项**服务端不再拒绝，唯一的门是 Client 面板（可被绕过）**；用户已取消运行时二次确认，
  只有 `danger` 档经 S3b 的 `alerts[]` 报一次（Client 去重）
- [实测] **回归门**：`.\autotest.cmd --skip-audit` = **9 套件 / 250 断言 / exit 0**（= 基线）；
  `stage3-store.mjs` = **20/20 / exit 0**
- [实测]**有意反转**了 `f3-outside-default.mjs`（旧断言"S2 默认 deny"与新契约 1 直接冲突）；
  这是**契约变更导致的断言反转，不是掩盖失败** —— **Lead 已批准，不回滚**（team-message-372e1773）；
  反转前原文备份 `.t\dsh2\fix-backup\stage3-f3-outside-default.before.mjs`（SHA256 `2EB1BE7C…`），
  回滚命令留在文件头备查；新 f3 = 9/9 PASS
- [未实测] shell（`bash`/`pwsh`）的工作区外写入仍绕过 `ctx.fs` ⇒ 不进暂存；`src/tools.mjs` 的 CLI 越界拒绝未改（不在授权范围）

### T3 追加（T8/S3c：审批面板三档显示）

> 详细论证见 `docs/dsh2-修复报告.md` §13；断言脚本 `.t\dsh2\browser\ui3\f8-three-tier.mjs`（34/34 PASS）。

- [实测] **三档显示已实现**（只改 `dsh-plugin\client.js` 一个文件）：按 **`risk`** 分 `工作区内/工作区外/敏感` 三组、
  空组不显示、组内按 `path` 稳定排序；摘要行 `N 个文件 · N 个在工作区外 · N 个敏感 · N 个危险`；
  徽标只用 `--dsw-alias-state-{warn,error}-*` token（**新代码不写 hex 颜色**）—— 证据：`f8` 的 `A1`–`A4`/`B1`/`B2`
- [实测] **两条反直觉契约都落实并被断言**：① 分组按 `risk` **不是** `external`
  （`external:false` + `risk:"sensitive"` 落 **sensitive 组**，`A1`）；② `external:true` 的 `path` **逐字渲染绝对路径**、
  不再拼 `workspaceRoot`（`B3`）
- [实测] **向后兼容**：旧快照/缺 `risk`/未知值 ⇒ 一律 `normal`，**不崩**、**不用 `external` 猜档**
  （`A5`、`A5b`）；`note` 按**条件键**读（`'note' in item`，四态：present/absent/null/empty 全断言，`A6`）；
  `danger` 是 `sensitive` 的**子计数**（`A4`）
- [实测] **用户拍板的交互模型（覆盖 task-8 原文的弹窗写法）**：**没有实现任何二次确认对话框**，
  改"授权手势即点击"—— 初始选择集为空 ⇒ 6/6 勾选框默认未勾（`A10`/`B4`）；`danger` 的 `riskReason` **内联**显示（`B3b`）
- [实测] **alerts 只报一次且绝不阻断**：`pickFreshAlert(alerts, store.alertedId)` 按 `id` 去重（`A11`/`A12`）；
  渲染为 `role="status"` 横幅，**横幅内按钮数 = 0**，批准/拒绝按钮始终在位（`B5`/`B6`）—— 没有变成"必须点掉才能批准"
- [实测] **「批准全部」不把未勾选的高风险项卷进去**：载荷 = 全部 `normal` + **已勾选**的高风险项
  （`A7`/`A8`；`B9` 实测命令为 `/winstage approve "a-inside.txt" "b-inside.txt" "C:\outside\z.txt"`，**不含** `id_rsa`/`.dshstage\x`/工作区外项）；
  按钮旁**内联文案**说明范围，不用弹窗拦截
- [实测]+[⚠取舍]**「全选」改为只选普通项**（`A9`、`B12`）：一次点击不该等于逐个授权高风险项。
  按钮名保持「全选」不变（T4 的 `click_by_name` 按名字找，改名会破坏其脚本），范围写在 `title` 里。
  这是相对旧行为的**有意收紧**，已在报告 §13.2 显式声明
- [⚠张力/请 Lead 定夺] 你原话"内联文案说清**它包含**工作区外/敏感项"与"**不得**把未勾选的高风险项卷进去"
  存在语义张力。我按**安全优先**实现，文案写成"= 全部普通项 + **你已勾选**的高风险项"。
  若要改成"真的全部写盘"，是**一行文案 + 一个过滤条件**的改动
- [实测] 断言是**真 node 跑真 `client.js`**：纯函数层把源码 S3c 段落**原样抽出执行**（`A1`–`A13`）；
  渲染层用最小 React 钩子跑**真组件函数体**（`B1`–`B12`）；并用**改动前部署副本**做 3 条对照
  （`CONTROL-before-has-no-groups`、`CONTROL-before-approve-all-is-unscoped`、`CONTROL-before-pure-block-absent`）
  ⇒ 断言有判别力，不是自证
- [实测] **踩坑记录（值钱的）**：mini-React 第一版在**渲染中**跑 `useEffect` ⇒
  `poller.observe` → `store.publish` → `setState` 嵌套渲染搅乱 hook 游标 ⇒ "点了没反应"；
  第二版修了时机但 `buildHarness` **自己又 new 了一个 mini-React 实例** ⇒ 组件写 A 实例 hooks、断言读 B 实例
  （`_hooks()` 打出 `hooks: []` 才暴露）。结论：**React 实例必须同一个**。两次都靠 `_hooks()` 诊断，不是靠猜
- [未实测/只能靠浏览器] ① 真的按三档**着色**渲染（CPU 不渲染像素）；② 真实点击链路
  （点勾选框 → 变勾选 → 「批准所选」出现）；③ `--dsw-*` 在真实主题下的实际效果；④ 首屏即挂载（T5b 的 A）
  —— 复测脚本已交付 `.t\dsh2\browser\ui3\check-three-tier.py`（复用 `cdp.py`；CDP 端口 env `WINSTAGE_CDP_PORT`；
  **只做读取与选择类点击，绝不点批准/拒绝/收起**；无 CDP `exit 3`、面板不在 `exit 4`；
  已用 T4 的 python `py_compile` 通过并冒烟验证 `exit 3`）
- [实测] **Lead 点名的判别性守卫已加并实测**：`check-three-tier.py` 在**连浏览器之前**先读 `review.json` ——
  **没有 `risk`/`riskCounts` 字段 ⇒ `exit 5` + "snapshot lacks risk fields — backend (S3a/S3b) not deployed"**
  （理由：后端没部署 ⇒ 面板全判 normal ⇒ 只显示一组 ⇒ 会被误读成"三档没实现"，这种假阴性很贵）。
  退出码：`2`=没令牌、`3`=没 CDP 浏览器、`4`=没有待审改动（面板不会出现）、`5`=缺判级字段。
  `[实测]` 两条分支都用 fixture 验过：`fixture-no-risk.json` → **exit 5**；`fixture-with-risk.json` → 守卫放行 →
  走到浏览器门 **exit 3**
- [实测] **脚本已参数化，可直接打 3082**：`--profile dsh3`（从 `.t/dsh2/<profile>.pid` 取 port/workspaceRoot，
  token 日志 `.t/dsh2/logs/dsh3.out.log`）。实测 `--profile dsh2` → exit 4、`--profile dsh3` → exit 2
  （`dsh3.out.log` 目前 0 字节 ⇒ 需先按运行手册登录装 cookie）
- [实测] 两个踩坑（写下来别重演）：① 本机控制台 GBK，`print` 含 `⇒`/`⚠` 会抛 `UnicodeEncodeError` 把脚本搞崩
  （第一次实测就是 exit 1 崩溃而非预期 4）⇒ 已 `reconfigure(errors="replace")`；
  ② **不要**用 PowerShell `Get-Content -Raw | -replace | Set-Content` 批量改 .py —— 会把多行注释并成一行 + mojibake，
  直接 `IndentationError`，只能整文件重写
- [实测]**Lead 已确认两条设计决定**（team-message-8e6cbf5b）：① 「批准全部」= 全部普通项 + 已勾选高风险项；
  ② 「全选」只选普通项。两条都按 **显式行为变更** 写进报告 §13.2（含"未来对比旧版本请读成有意的安全收紧，不是回归"）
  —— 而不是悄悄改掉
- [实测] **回归**：`.\autotest.cmd --skip-audit` = 9 套件 / 250 断言 / exit 0（= 基线，S3c 最终字节）；
  我此前修的 **A/B/C 未回归**（`f5` 7/7、`f6` 12/12 复跑仍全绿）
- [实测] **部署需求（阶段三）**：需要**一次完整 sync**，不只是我的文件 —— `client.js`（S3c）与
  S3a/S3b 的 `cordis.patch.yml`/`staging-fs.mjs`/`fs-entry.mjs`/`review-service.mjs` **都与仓库不一致**；
  后端判级字段若未部署，面板拿不到 `risk` ⇒ 会**全判 normal**（只会看到一组）。

### T3 追加（T9/S3d 对比度 + T10/S3e 收起后回不来）—— 两个**用户实测**缺陷

> 详细论证见 `docs\dsh2-修复报告.md` §16（T9）与 §17（T10）。
> 这两个都是**用户真人用起来才暴露的呈现/交互缺陷**，离线断言只能证机制。

**T9 / S3d：按钮文字看不清（可访问性）**

- [实测]**原委（用户贴的 DOM）**：`<button>` 同时有 `background: var(--dsw-alias-brand-primary, #247bbf)` 与
  **硬编码 `color: rgb(255,255,255)`**，再加 Dark Reader 注入的 `--darkreader-inline-bg`/`data-darkreader-inline-bg`
  ⇒ **底被换成它算的深色、写死的白字它不调** ⇒ 深底深字
- [实测]**修法（选 A + 同时去硬编码）**：`primary` 改成 token 对
  `background: var(--dsw-alias-brand-primary)` + **`color: var(--dsw-alias-brand-text)`**
  （实测两者在亮/暗里**互为反色**：light primary=bluish-50/text=bluish-1000，dark 反之 ⇒ 两主题都自动有对比度）；
  `strip`/`alert`/`badgeDanger` 的文字色改用 `var(--dsw-alias-label-primary)`（tinted 底上用**前景 token**，
  原来同色系的 warn-primary/error-primary 在暗色下是同色相中低对比）；
  **每个自绘控件 + 面板根 + 卡片 + 横幅 + 设置行开关加 `data-darkreader-ignore`（全小写）**，
  面板根另加 `data-winstage-panel="1"` 作审计锚点
- [引用]**"React 是否透传未知 `data-*`"（Lead 要求实测、不许假设）**：`[实测]` 本机**没有**
  `react`/`react-dom`/`jsdom` ⇒ **无法在 Node 里用真 React 断言**（我没有假装做过）；
  `[引用]` 用本仓库**实际运行的那套预构建 React** 作证据 —— `dsh-client-ui-renderer\lib\client.js:622/638/1100/1147`
  自己就在 JSX 里用 `"data-slot"`/`"data-slot-error"`/`"data-factory-error"`，说明 DSH 前端**本就依赖**透传；
  `[实测]` 真浏览器里由审计脚本 `querySelectorAll` 直接查 DOM 兜底 ⇒ **透传不成立就会 FAIL，不会静默通过**
- [实测] `f9-contrast-static.mjs` **7/7**（真 node 跑真 `client.js`：抽出 `styles` 求值断言
  "有 background 的样式其 color 必须是 `var(--dsw-*)`"，+ 真组件树断言 **9/9** 控件带 DR 标记）；
  改动前对照 `A1` 抓到 `{primary:{background:'var(...#247bbf)',color:'#fff'}}`、`A2` 抓到 `color:'#fff'`、
  `B2` 抓到 9/9 控件无 DR 标记 ⇒ 有判别力
- [未实测/只能浏览器] 三种模式的**真实 WCAG 对比度** + Dark Reader 是否真跳过；
  `contrast-audit.py` 已交付（页面内沿祖先链合成有效色、4.5:1 / 3:1 阈值、逐元素报告+截图；
  **无 CDP `exit 3`、Dark Reader 未安装记 `SKIP`=exit 2，两者都不是通过**）。**浏览器还没起 ⇒ 尚未跑过**

**T10 / S3e：收起之后回不来（功能可用性）**

- [实测]**两层根因**（Lead 定位，我复核）：① `暂时收起` 只改 `store.dismissed`，判定在槽位 `select` 里
  ⇒ 没人让 `select` 重跑；② 快照不变时 `routeOf` **恒为 null** ⇒ **根本没有入口叫回面板**（缺交互，不是时机）
- [实测]**第 1 条退路 = 常驻 chip**：`WinStageChip` 注册在 **`conversation.input.dock`**（**始终渲染的 list 槽位**，
  已有 queue/todo/goal）⇒ **不依赖 composer chain**（挂回 composer 等于没有入口）；
  只在"有待审 + 这一版已收起"时渲染；点击 = `restorePanel()` ⇒ **复用**已有的跃迁重挂通道
  （`S1` 断言 `conversation.composer` 的 `slots.inject` 全文仍只有 **1** 处，没造第二套通道）；
  跨刷新记忆 `sessionStorage['winstage.dismissedSnapshot'] = generatedAt`（值即 generatedAt ⇒ 新快照天然失效）
- [实测]**第 2 条退路 = 设置行「默认收起」开关**：`localStorage['winstage.defaultCollapsed']` 持久化。
  选**客户端偏好**而非 host Config 字段的理由：加 Config 字段要改 `schema.js`（host 半，不在写范围）。
  开启后默认收起，**chip 仍在**（`F4`：偏好不会拿走回去的路）
- [实测]**新快照自动恢复**：`dismissed` 存的是 `generatedAt` ⇒ 新快照到达即不匹配 ⇒ 无需用户操作（`E2`）
- [未做/说明原因]**第 3 条退路 `/winstage show` 故意没做**：它必须改 `host-plugin.mjs`（不在写范围），
  且要走 `commands.execute` 往返，而**命令面曾经静默失效**（B 缺陷）。**失败模式**：命令未注册时点击无反应也无提示
  ⇒ 只能锦上添花，不能当唯一出路
- [实测] `f10-reopen.mjs` **28/28**：覆盖**完整往返**（收起→版本+2→chip 出现→点 chip→版本再+2→**面板回来**→chip 隐藏）、
  先收起再"刷新"（同一 sessionStorage）仍能找回、新快照自动恢复、设置开关存在且持久化、
  改动前版本**压根没有 chip 槽位**（chipSlot=0）⇒ 有判别力
- [未实测/只能浏览器] **完整往返的真实点击**：`check-chip-roundtrip.py` 已交付
  （step1 面板可见 → step2 点真实「暂时收起」（**允许点：不改 review.json、不消耗候选**）→ step3 消失 →
  step4 chip 出现 → step5 点 chip → step6 面板回来 → step7 chip 再隐藏 → step8 刷新后绝不死路；逐步截图）。
  **浏览器还没起 ⇒ 尚未跑过**
- [实测]**回归**：`autotest --skip-audit` = 9/250/exit 0；`f8` 34/34、`f9` 7/7、`f10` 28/28、`f5` 7/7、`f6` 12/12 全绿
- [实测]**回滚注意**：`client.t8-before.js` 一个文件同时回退 S3c+T9+T10（三者同在 `client.js`，
  而 task-8/9/10 的写范围只给了 `ui3\**`）；**只撤 T10** 需手工移除 chip 注册与存储部分 —— 别误操作

### T3 追加（T11/S3f）—— 更正 T9：**运行时**才暴露的 1.00:1，以及把这类错误变成不可能

- [实测]**我错在哪**：T9 我断言"`brand-text` 与 `brand-primary` 互为反色"，只核**静态文本**、
  **没验证运行时解析值**。`browser-tester` 在 3082 只读测得两个主按钮
  `color == backgroundColor`（light `rgb(15,17,21)`、dark `rgb(249,250,251)`）⇒ **1.00:1，字隐形**。
  根因：按主题块解析主题 CSS 后，`brand-primary` 与 `brand-text` **在两种主题下取值完全相同**
  （`brand-text` 的语义是"用品牌色当文字"，不是"品牌底上的文字"）。**责任在我**：用"看起来对"代替了"渲染出来对"
- [实测]**改法**：统一规则 **文字色只用前景 token（`label-*`）**，语义色只用于背景 tint 与边框/左边条。
  `primary` 改用**实测互为反色**的一对：`brand-primary` + `label-primary-foreground`
  ⇒ 计算 **18.90:1（light）/ 18.08:1（dark）**；组标题 amber-600（2.79:1）、危险红 red-600（4.4976:1，临界不过）
  全部改用 `label-primary`，色相改由 3px 左边条承载 ⇒ 30 对（15 样式 × 2 主题）最低 **11.91:1**
- [实测]**防复发（本轮最重要）**：上一轮的断言套件**结构上抓不到**这个 bug（它只查"用了 token/没有硬编码"，
  而这两条对 1.00:1 全为真）。`f9` 新增 4 条（现 **11/11**）：`D1` 整份源码禁止 `color: var(--dsw-alias-{state,brand}-*)`；
  `D2` 按**主题 CSS 真实解析值**算，两种主题都 ≥4.5:1；`D3` `primary` 底与字必须解析出**不同**颜色；
  `D4` **渲染树**逐元素算（含渲染处内联色/祖先背景继承/`opacity`）。
  `D1` 一开始只查 `styles` 对象、**漏掉渲染处的颜色覆盖** —— 我自己用变异体抓到后改成扫整份源码
- [实测]**能 FAIL 的证明**（`f11-assert-can-fail.mjs` **10/10**）：8 个定向变异体 + 2 条基线；
  其中 `T9-primary-token-pair-is-itself`（把 `brand-text` 换回来）**让 A3/D1/D2/D3/D4 全红**
  ⇒ 上一轮的真实事故已被机械检测。Lead 点名的 M7/M1/M8 三个盲区分别由 `B6b`/`B13`/`B14` 抓住
- [实测]**f8 新增 10 条**（现 **41/41**）：`B6b/B6c/B6d` 横幅在场时批准/拒绝 `disabled===false` **且真能触发**；
  `B13` 只有 normal 时**只渲染 1 个组头**；`B14` **渲染出来的**摘要含 outside/sensitive/danger 计数；
  `B15/B15b/B15c` G1 跨快照档位升级（旧手势失效 + 内联提示 + 重新勾选后可批准）；
  `B16` G2 danger 带 diff 也**不渲染内容**；`B17` G3 截断时按 `max(派生, 声明)` **不少报**
- [实测]**G1 顺带修出一个交互死循环**：档位升级后条目"勾着却批不了"，若点一下是**取消勾选**，
  用户会陷入死循环 ⇒ 该点击语义定为**重新授权**（由 `B15c` 逼出）
- [实测]**回归**：`autotest --skip-audit` = 9/250/exit 0；`f8` 41/41、`f9` 11/11、`f10` 28/28、`f11` 10/10、`f5` 7/7、`f6` 12/12
- [未实测]**浏览器复测**：Lead 已 sync + 重启 3082（rev `05afe8155355`，客户端 66177 B）；但见下方"部署后复核"——
  我在 sync 后又改了 1 行 ⇒ **复测前需重新 sync**。T9 验收 = `contrast-audit.py` 亮/暗 `exit 0` + 逐元素数字；
  T10 验收 = `check-chip-roundtrip.py` 完整往返（该脚本已按独立复核 §5 改成 **DOM 锚点**判定，不再用整页文本子串）
- [实测]**来源核对**：`f8`/`f9` 的 JSON 现写入 `clientPath`；`f11` 每次变异都验证"替换确实生效"，
  不生效判 FAIL —— 避免"变异体其实没变"的假证明（采纳 `browser-tester` 的 `bundle-provenance` 思路）
- [实测]**部署后复核 ①token 作用域**：主题 CSS 只有 6 个规则块，只有 `body` / `body[data-ds-dark-theme]`
  定义 token（另两个是 `html[data-platform=darwin] body`，29 字符，不含我用的 token）⇒ **没有"包裹元素级覆盖"**，
  解析值应等于浏览器计算值。**互相印证**：卡片底色 `--dsw-specific-input-major` = `#fff`(light) / `#2c2c2e`(dark)，
  而 T4 实测暗色那条 `bg=rgb(44,44,46)` 正是 `#2c2c2e`
- [实测]**②查出一个真 bug（已修）**：`--dsw-alias-state-error-tertiary` 在当前主题**根本没有定义**
  （`warn-tertiary` 有、`error-tertiary` 无）；T9 给 `alert` 用它时**没带 fallback** ⇒ 声明非法 ⇒ 背景透明 ⇒
  红色提示条只剩 1px 边框。已补 `rgba(220,60,60,.14)` fallback ⇒ `client.js` 变为 `D7359F29…`（66532 B），
  **与部署的 66177 B 不同**；审计里这些元素 `bg=` 会由白变红 tint（对比度不变，预期变化）
- [决策]**③Dark Reader 档不做受控模拟**：写假 DR 是**循环论证**（"它是否尊重 `data-darkreader-ignore`"
  正是待验项，模拟的假设直接决定结论）⇒ 只会造出有覆盖率的假场景。本轮尝试取一手来源失败
  （GitHub discussion 返回导航外壳、darkreader.org 按语言路由）⇒ **不声称"退出标记已验证"**。
  可靠路径只有：**用户自己那台装了扩展的浏览器**（一张截图定论）或**手工装进 CDP 用的 Edge profile**。
  **诚实边界**：配色修复缩小了 DR 影响面但没单独关闭它 —— 能关掉它的只有"退出标记被真的尊重"
- [实测]**④采纳 Lead 建议：断言"token 必须能解析到值"（`f9` 的 `D5`，现 12/12）**：
  **没有 fallback 的 `var(--dsw-*)` 必须在主题 CSS 里解析到值**；未定义**但带 fallback** 的引用允许（显式降级）。
  首次运行一次性暴露整族：`--dsw-alias-state-error-tertiary`（本轮事故那个）+ `--dsw-alias-text-l1`、
  `--dsw-radius-md/lg/xl`、`--dsw-shadow-lv2` 属"未定义但有 fallback"；**未定义且无 fallback：空**。
  **局限**：`D5` 只知道主题 CSS；`--dsw-radius-*`/`--dsw-shadow-*` 可能由应用自身样式提供 ⇒
  判据是"要么主题能解析、要么作者显式写了 fallback"。变异体 `T11-undefined-token-without-fallback`
  （去掉 fallback）⇒ `D5` 翻红；`f11` 现 **11/11** ⇒ "名字像一对""token 不存在"两种形态都有机械哨兵
- [实测]**⑤运行事实（Lead 提供，以后复用）**：改 `client.js` **只需 `sync-plugin.mjs` + 页面 reload**，
  **不必重启 3082**（客户端 bundle 按请求从文件读、rev 即内容哈希）；只有 **host 侧**改动
  （`host-plugin.mjs`/`staging-fs.mjs`/`review-service.mjs`）才需要重启
- [实测]**⑥`D5` 的"带 fallback ⇒ 允许"≠"没问题"（Lead 要求标注）**：`alert`/`badgeDanger`/`danger`
  引用的是**不存在**的 `--dsw-alias-state-error-tertiary`，实际生效的是我写的 `rgba(220,60,60,.14)`
  ⇒ **视觉降级真实存在**、且该 fallback **承重**（实测 computed bg 正好等于它）。
  ⇒ 今后一律表述为：**`D5` 通过 = "不会产生非法声明"，≠"视觉与设计一致"**

### T3 追加（T12/S3g）—— 危险横幅"闪 2 秒就永久消失"

- [实测]**用户实测**：横幅 t=1s 在 / t=3s 消失 / 之后 14s 不回，**而危险项仍待审**
  ⇒ 用户定的"danger 在运行时报一次"变成"报得没人看得见"
- [实测]**机制（我核实；与 Lead 假设略有不同）**：清空点是 **两个** idle 分支（`!sessionId||root===''` 的 L403
  与**根失配**的 L409）**都**写 `alert: null`；"永久"来自另一条 —— `fresh` 只在首次非 null
  （`alertedId` 一记就再无 `fresh`）、`keep` 又依赖 `store.alert` 非空 ⇒ `alert` 一旦被清，
  `fresh`/`keep` **同时** false ⇒ 之后每一拍都发 `alert: null`。**两条都要修，只修一条仍复现**
- [实测]**改法**：① ready 分支 `alert` 从**当前快照**派生（危险在审 ⇒ 一直在；快照不再声明 ⇒ 才消失）；
  ② **两个** idle 分支都不再清 `alert`（idle 时 snapshot 为 null ⇒ 不选举 ⇒ 面板本就不挂载，不会显示陈旧横幅）；
  ③ `alertedId` 降级为"报过哪些"的记录、**不再决定可见性**。
  **语义变化**：可见性从"store 记忆"改为"**跟随快照**"；"只报一次"仍成立且更强（内联横幅、从不打断、**从不要求点掉**）
- [实测]**断言**：`f8` 新增 6 条（现 **47/47**）：`B18` 初始在场、`B18b` 后续轮询仍在（不是闪现）、
  `B18c/d` 两种瞬时 idle 都不清、`B18e` 恢复后仍在**且批准/拒绝仍可用**、`B18f` 仅在快照解决时才消失。
  `f11` 现 **13/13**：`T12-alert-one-shot-gating`→`B18b` 红、`T12-alert-idle-wipes`→`B18c` 红
- [实测]**我越界跑了一次浏览器（如实报出）**：为验证"无浏览器 → exit 3"而写 `check-alert-persistence.py`，
  发现 9222 已起，脚本**真的跑了 20 秒只读采样**（零点击、零候选消耗），违反"浏览器 leg 归 browser-tester"的分工。
  **数字**（被测 = 部署的 `D7359F29`，**未含**本次修复）：只读读到 `review.json` 有
  `alerts=[{id:"no-candidate:danger",...}]`、`pending=true`、3 文件；逐秒 t=0..20 **panel=True 全程、banner=False 全程**
  ⇒ **独立复现**（危险在审、面板在、横幅连续 20s 不在）。边界：首采样在导航后 ~1s 内，**没**捕获那 1–2 秒闪现窗口
- [实测]**修复后的数字必须重测**：本次是客户端改动 ⇒ **只需 sync + reload、不必重启**；
  由 browser-tester 跑 `check-alert-persistence.py` 拿"连续在场 ≥15s"的时序
- [实测]**顺带查出我自己的脚本每跑一次漏一个标签页**：`cdp.Page.close()` **只关 WebSocket、不关 tab**
  （`cdp.py:169`；另有 `cdp.close_tab`）——这正是"tab 累积到 5 个导致超时"的成因之一。
  已修 4 个脚本（`contrast-audit.py`、`check-chip-roundtrip.py` 含早退路径、`check-alert-persistence.py`、
  `check-three-tier.py`），`py_compile` 全过。**当前浏览器 3 个 target（2×3082 + about:blank）全 IDLE**，
  至少一个是我泄漏的；**我未清理**（Lead 要求我不碰浏览器，且两个 3082 URL 相同、无法证明哪个是我的）
  ⇒ 建议 browser-tester 下轮前清掉，**别关到最后一个标签页**（会让 headless 整个退出）

### T3 追加（T12/S3h）—— chip 显示 L1/L2/L3 分级数量

- [实测]**用户要求**："要显示 L1、L2、L3 等级的审批都有几个"（他贴的 DOM 当时只有总数 `WinStage 待审 · 3`）。
  映射由 Lead 定死：**L1 = `normal`（工作区内）、L2 = `outside`（工作区外）、L3 = `sensitive`（敏感）**；
  `danger` 是 **L3 里更严的子档**，**不额外计一档**
- [实测]**采用排布**：`WinStage 待审 · 3（L1 1 · L2 1 · L3 1 · 危险 1）`（零档不列；全零不渲染 chip）。
  取舍：保留 `L1/L2/L3` 标签而**非**位置式 `（1/1/1）`（无图例的位置数字分不清哪级）；
  `危险` 放**同一括号内**（尾随段会读成第二句话）；`·` 而非 `/`（避免与 Windows 路径混淆）；
  最宽 ≈43 字符 ≈280px；`nowrap`+`maxWidth100%`+`ellipsis` ⇒ 窄屏退化为 `…` 不撑破布局；
  完整图例与"带 + 表示截断"写在 `title`
- [实测]**数据**：新增纯函数 `levelCounts(files, declared)`，**复用 `summarize`** ⇒ 继承 G3 的
  `max(派生, 声明)`；`danger` 取子计数不重复计；`truncated ⇒ 标 `+``（不静默少报）
- [实测]**文案**：新增 `chipLabelLevels`/`chipL1`/`chipL2`/`chipL3`/`chipDanger`（zh+en）并扩充 `chipTitle`；
  **刻意不用 `L{level}` 占位符**（宿主插值只用过 `{count}`/`{files}`，少一个失败面）
- [实测]**断言**：`f10` 现 **35/35**，新增 7 条，且 harness 现在**真跑 `ctx.effect` + 捕获 `locale.register` 字典**
  ⇒ 断言比的是**用户实际看到的字符串**：`H1` 精确等于 `WinStage 待审 · 3（L1 1 · L2 1 · L3 1 · 危险 1）`、
  `H4` 只有 normal 时不出现 L2/L3/危险、`H5` 截断用声明值并标 `+`、`H6` 无待审不渲染、`H7` en 文案
- [实测]**能 FAIL**：`f11` 现 **15/15**（3 基线 + 12 变异体），新增 `T12-chip-ignores-declared-riskcounts`
  ⇒ `H5` 红；同时修了 `f11` 的路由（此前 `runner` 只认 `f9`，f10 的变异体会错跑到 f8 上）
- [实测]**不回归**：可见性/点击恢复/`sessionStorage`/`data-winstage-chip="1"`/`data-darkreader-ignore`
  由 `A3/C2-C4/B4/D0-D3/H3/H6` 守住
- [实测]**回归**：`f8` 47/47、`f9` 12/12、`f10` 35/35、`f11` 15/15、`f5` 7/7、`f6` 12/12、
  `autotest` 9/250/exit 0；对比度 58 对最低 11.91:1（未受影响）；`A13` 字典覆盖 **52** key
- [未实测]**只能浏览器确认**：真实 composer 里 pill 的**实际宽度/是否省略**，以及用户眼睛看到的字符串
  是否等于 `WinStage 待审 · 3（L1 1 · L2 1 · L3 1 · 危险 1）`（3082 fixture 正是三档各 1 + danger 1）
- [实测]**字节**：`client.js` = `8CE236FC768BC237E5FAC01DAE73363A0E7C36B4B4AEBF49A1072C33A5CCEC5F`（71282 B），
  **未部署** ⇒ `node .t\dsh2\sync-plugin.mjs --profile dsh3` + reload（**不必重启**）

### T3 追加（T13/S3i）—— 面板内部也显示 L1/L2/L3（标题条 + 组头徽章）

- [实测]**用户要求**："展开也是显示 L1、L2、L3"。按 Lead 定死的排布实现：
  标题条 `3 个文件（L1 1 · L2 1 · L3 1 · 危险 1）`（零档不列、截断带 `+`）；
  三个组头 `L1 · 工作区内（1）`/`L2 · 工作区外（1）`/`L3 · 敏感（1）`，徽章是独立元素
  `styles.groupBadge`（描边 pill、只用 `--dsw-*` token、`data-darkreader-ignore`）
- [实测]**同一口径**：标题条与 chip **都走 `levelCounts()` + `levelSegments()`**（S3h 的函数直接复用），
  没有第二套算法；分组仍按 `risk`（**不是 `external`**），`危险` 仍是 **L3 组内的子档**、**未新增第四组**
- [实测]**locale**：新增 `levelL1/L2/L3` + `reviewLevels`（zh/en）；**仍未引入 `L{level}` 占位符**
- [实测]**两处断言格式变更（必须显式说明）**：`B14`/`B17` 原先断言**旧摘要格式**（`summaryOutside` 等），
  而 task-13 **定死了新格式** ⇒ 期望值必须改。守的性质**未削弱、反而更强**：仍是"渲染出来的文案"，
  且升级为**真字典 + 真插值**（`f8` 的 harness 现在也真跑 `ctx.effect` 并捕获 `locale.register`）。
  `B17` 的 id 不变；`B14` 改名 `B14-rendered-strip-shows-all-levels`
- [实测]**退役**：正文首行 `headline` 摘要行 + `styles.headline` 一并移除（摘要已到标题条，
  否则同一数字出现两遍）⇒ `reviewFiles`/`summaryOutside|Sensitive|Danger` 变成**闲置 key**（保留未删，如实标注）
- [实测]**Lead 点名的"新徽章成对比度盲区"风险**：实测 `D4` **自动覆盖**了新徽章
  （`span levelL1`/`levelL3`：light 18.90 / dark 13.34，bg `rgb(255,255,255)`/`rgb(44,44,46)`）；
  但"自动覆盖"必须被断言 ⇒ 新增 `D4b-s3i-group-badges-are-covered`（≥2 徽章 × 2 主题在测量列表里）。
  对比度总对数 **58 → 60**，最低仍 **11.9076:1**
- [实测]**断言**：`f8` **51/51**（新增 `B19/B20/B21/B22` + 重写 `B14/B17`）、`f9` **13/13**（新增 `D4b`）、
  `f11` **17/17**（新增 3 个变异体：`T13-strip-ignores-declared-riskcounts`→`B17` 红、
  `T13-group-header-drops-level-badge`→`B19/B20/B21/B22` 红、`T13-group-badge-low-contrast`→`D1/D2/D4` 红）
- [实测]**方法学（我自己踩的两个坑，如实记录）**：
  ① `B22` 第一版写"面板不许出现任何中文"，**当场判红** —— 命中的是**宿主数据**（`alert.message/hint` 是中文）。
  **那是数据不是硬编码**；改为**全 ASCII fixture** 后，任何残留中文只能来自我自己的标签 ⇒ 断言才真正测到"文案走 locale"。
  ② `f11` 的 `applied=false` 守卫抓到**两个过期变异体**（`M8-summary-outside-removed`、
  `G3-ignore-declared-riskcounts` 的替换靶子被 S3i 重构删掉了）——没有这条守卫它们会**静默假绿**。
  处理：`M8` 改靶为"渲染时丢掉 L2 段"；`G3` 那条**退役**（`B17` 已由新靶子的 `T13-` 变异体覆盖，属去重非降覆盖）
- [实测]**回归**：`f8` 51/51、`f9` 13/13、`f10` 35/35、`f11` 17/17、`f5` 7/7、`f6` 12/12、
  `autotest` 9/250/exit 0；`A13` 字典覆盖 **53** key
- [未实测]**只能浏览器确认**：标题条 AX 文本与三个组头的 AX 文本（含 `L1` 与组名之间的 flex gap 视觉）
- [实测]**字节**：`client.js` = `FDE9FC81DB4E0ECD8AD63FBAFD5763F97AC9B13266B2E415969EF4B58EDC3965`（72476 B），
  **未部署** ⇒ `sync-plugin.mjs --profile dsh3` + reload（**不必重启**）

## T4

浏览器取证（teammate `browser-tester`，task-3）。完整报告：`.t\dsh2\T4-browser-report.md`。

- [实测] **本会话无法运行任何 Chromium ⇒ 面板的可见性/交互本轮未能判定**（这不是操作错误）。
  本机无 Chrome，唯一浏览器是 Edge 且不带 remote debugging（9222/9223 无监听；9220–9230/9333/9444/9515 全扫；
  `DevToolsActivePort` 两份都不存在）。按 Lead 选定的隔离实例方案启动 Edge，
  `--headless=new`/`--headless=old`/`--single-process`/`--no-sandbox` **三种变体同一处 FATAL**：
  `FATAL:mojo\public\cpp\platform\platform_channel.cc:187 Check failed: . : 拒绝访问。 (0x5)`（returncode 0x80000003）。
  Mojo 依赖**命名管道**，而沙箱明确禁止 ⇒ 结构性阻塞，非 flag 可解。WebView2 同内核、Cordis Inspect 无浏览器 provider。
  原始 stderr：`.t\dsh2\browser\raw\edge-dump-dom.err.txt`、`edge2-*.err.txt`。
  ⇒ 因此 **AX 树 / 截图 / console / 点击交互四项全部 `[未实测]`**，本报告不含任何伪造的视觉结论。
- [实测] **F1 的投递层已修好（环境已向前走，`READY.json` 是陈旧数据）**：3081 在 05:55–05:58 被重启 5 次
  （`logs/supervisor.log`），`READY.json` 的 `pid 2624`/token/`halves.client.loaded:false` 全部过期
  （token 每次重启轮换，正确来源是 `logs/dsh2.out.log` 最后一条 `?token=`；当前 pid 8236）。
  用当前 token 走完整流程（303 + `Set-Cookie` → `GET /` 200 / 34545 B）后：
  `globalThis["__DSH_BOOT__"]`（**变量名是中括号形式 `__DSH_BOOT__"] = `，按 `__DSH_BOOT__ =` 搜不到**）
  经 **Node 真实 JS 引擎 eval 解析**得 `entries=65`、**`@local` 命中 1 条**：
  `{"id":"@local/dsh-winstage-sandbox","url":"plugins/??@local/dsh-winstage-sandbox/client.js&rev=c20a44a40ab9","immediately":true,"inject":["@deepseek-ai/dsh-client-ui-settings"]}`，
  且它是 `phase:"application"` 合并 bundle 的 `entries[0]`。该 bundle **GET 200 / 28590 B**，
  含 `WinStage 暂存待审`/`批准全部`/`批准所选`/`拒绝全部`/`暂时收起`/`Approve all`… 各 1、
  `conversation.composer`×4、`review.json`×3、`workspaceFiles`×3。
  ⇒ **T3 的 F1 验收断言实测通过**（投递层）。证据：`browser/raw/r2-dsh-boot.js`、`r2-dsh-boot-parsed.json`、
  `r2-winstage-client-bundle.js`、`r2-manifest-context.txt`。
  **注意：这只证明"下发了"，不证明"渲染了"**；面板是否出现仍是 `[未实测]`。
- [实测] 状态前置条件已满足：`.t\dsh2\ws\.dshstage\review.json` = `pending:true`、`counts.files=1`
  （`stage-probe.txt`, create, revision 2, `sessionId:"dsh-host"`）。
- [实测] 无 trust/CSRF/403 异常：`?token=` 303 → cookie → 200；`/api/state`、`/api/sessions` 是 **404 不是 403**。
  两次 `GET /` 的 rev 完全一致（刷新不变）。3080 与 3081 各自 401，**未见互相影响**；全程未触碰 3080。
- [实测] `client.js:124` 硬约束在**3081 实际下发的 bundle** 里逐字确认：
  `if (!owner || !owner.sessionId) return null`（另见无 pending、已 dismissed 两处守卫，
  `workspaceFiles.read`、`ctx.slots.inject('conversation.composer',…)`）。
  **但"无会话时槽位不接管"的页面侧 DOM 证据仍 `[未实测]`。**
  （F1-only 时行号是 124/126/127/141/662；**F2 部署后已变为 150/152/153/154/206/213/695**，见本节末条。）
- [实测] **跨工作区泄漏仍在，并给出二值判别式**：repo 根 `.dshstage\review.json`
  （`workspaceRoot=C:\...\WinStageSandbox`，`generatedAt 05:55:49.292Z`，`revision 32`，文件 `.t\staged-demo.txt`）
  **至今 `pending:true`** —— 即 `profiles\dsh2\cordis.patch.yml` 记的 05:55:49 事故产物，仍是"活着的会被误读的快照"。
  隔离那份是 `stage-probe.txt` / revision 2 / 05:58:50Z。两者文件名、revision、generatedAt 全不同
  ⇒ **面板一可用，看它列出的文件名即可二值判定 F2 是否复现**：显示 `stage-probe.txt` = 根正确；
  显示 `.t\staged-demo.txt` = **F2 跨工作区泄漏在 3081 上复现**。建议作为 F2 验收断言。
- [实测] 两个沙箱障碍与绕过（可复现性）：`browser-use.exe` 与**任何把 stdin 喂给原生 exe 的 PowerShell 管道**
  都被拒（`Program 'bu.exe' failed to run: Access is denied`，技能的 `browser-use <<'PY'` 正是此形态）
  ⇒ 改为**进程内 `import browser_harness.helpers`**（`.t\dsh2\browser\bh.py`）；
  daemon spawnlock 在 `%USERPROFILE%\.config\browser-harness\runtime\`（工作区外）⇒ 需重定位
  `BH_HOME`/`BH_RUNTIME_DIR` 进工作区。本机当前**没有活着的 daemon**（陈旧 port 文件 64141 已 refused）。
- [未实测/待解阻塞] 解除阻塞只需沙箱外一条命令起浏览器（独立 profile，不复用用户 Edge profile）：
  `msedge.exe --remote-debugging-port=9222 --user-data-dir=.t\dsh2\browser\edge-profile --headless=new …`。
  已就绪：`browser/cdp.py`（原生 CDP 客户端，失败路径已冒烟 `exit=3`）与 `browser/r2_capture.py`
  （一键完成 截图 + AX 过滤 + console 全量 + 刷新对比 + 点击）。沙箱允许回环 TCP，故浏览器一起来我即可自取全证。
- [实测] **06:04:25 又一次重启后（F1+F2/F3/F4 全部署）复验：F1 依然有效；F2 修复已进入下发代码，
  但它把 F2 的**表现**从"显示错的快照"改成了"**静默不接管**"——这修正了我上面那条判别式。**
  bundle rev `c20a44a40ab9` → **`86655e0cd5c3`**，28590 → **30950 B**；`__DSH_BOOT__` 仍 65 entries /
  **`@local` 命中 1** / `immediately:true`；bundle 仍 **200**；`review.json` 仍 `pending:true`
  （`stage-probe.txt`、rev 2、`workspaceRoot=.t\dsh2\ws`、`generatedAt 06:04:27.437Z`）；两次 GET 的 rev 一致；
  `/api/*` 仍 404（非 403）。⇒ **根因清单第 1 条（client 半未加载）已排除。**
  新 bundle 守卫链：`150 if(!owner||!owner.sessionId)return null`、`152` 无 pending、
  **`153 if(!sameRoot(snapshot.workspaceRoot, store.state.workspaceRoot)) return null`（F2 新增）**、`154` 已 dismissed；
  另有 `206` 单一根来源 `configValue.workspaceRoot`、`213/214` 失配即 publish idle 拒绝跨工作区。
  ⇒ **修正判别式**：F2 修复前跨工作区泄漏 = "面板显示错的那份快照"；**修复后同一场景 = "面板根本不出现"（153/213 静默 `return null`）**。
  因此若第二轮面板仍不出现，**`sameRoot` 失配是高概率且可判定的根因**：在浏览器里同时读
  `configValue.workspaceRoot`、`store.state.workspaceRoot`、`review.json.workspaceRoot` 三个值比对；
  若第一项回落成 repo 根 ⇒ profile 覆盖层的 `winstage-sandbox` 断言又被静默丢弃（05:55:49 事故形态）
  ⇒ 面板**永不出现且无任何 console 报错**。
  **⚠️ 推论：第二轮不要只靠"找 console 异常"判因——四处守卫都是 `return null`，很可能一无所获。**
  另一高概率真原因：`owner.sessionId` 为空（`review.json.sessionId` 是 `dsh-host`，不是真人会话 id）。
  详见 `.t\dsh2\T4-browser-report.md` §12。
- ★ [实测/源码级] **第二轮的关键杠杆：插件自带诊断通道 `?winstageDebug=1`。**
  读下发 bundle 的 `apply()`（`raw/r2-winstage-client-bundle.js:632-667`）发现，插件**自己实现了三值比对 dump**：
  当 `location.search` 匹配 `[?&]winstageDebug=1` 时，`console.log('[winstage] configForms.describe()', …)`
  会输出 `status/error/writable/hasDocument/namespaceCount/namespaces/containsMine/myFormStatus`
  以及 **`review.workspaceRoot`（= `store.state.workspaceRoot`）**。
  ⇒ **不需要去够模块私有闭包**，`Runtime.evaluate` 读 `window.__winstageLogs` 即可拿到结构化数据
  （`r2_capture.py` 已注入 console 包装器把对象 `JSON.stringify` 存下来）。
  **⚠️ 坑（我已踩到）**：不能只把 `&winstageDebug=1` 拼到 token URL —— `GET /?token=…` 返回 `Location: ./`，
  相对解析**丢掉 query string**，标志位失效。**正确做法：先用 token URL 装 cookie，再单独 navigate 到
  `http://127.0.0.1:3081/?winstageDebug=1`**（有 cookie 就不再 303，`location.search` 保住）。
- [实测/源码级] **第四条静默不出现的路径**（此前没列出）：`createPoller` 第 `207` 行
  `if (!sessionId || root.length === 0) { publishIdle(); return }`，而
  `root = (ctx.configForms.get('winstage-sandbox')?.getSnapshot().value || {}).workspaceRoot`（`191-206`），
  注释明写**不再回退 `owner.session.cwd`**。⇒ 若 `configForms` 拿不到该命名空间，`root=''` ⇒ 面板**永不出现且零报错**。
  `?winstageDebug=1` 的 `containsMine` / `myFormStatus` 就是**直接判定这一条**用的。
  ⇒ 完整守卫链：`207`（root 空）/`150`（无 sessionId）/`152`（无 pending）/`153`（root 失配）/`154`（已 dismissed），
  **全部静默**。第二轮**不要只靠"找 console 异常"判因**。
- [实测] `r2_capture.py` 已升级为**四模式驱动器**（`baseline` / `approve` / `dismiss` / `reject`），
  会**复用同一个 3081 tab**（选择/收起状态跨步骤保留）；**只在 AX 面板命中非空时才进入交互**，
  否则 `!! panel not present -> cannot test approve; stopping (no blind clicks)` 并 `exit 4`；
  找不到 AX 目标只报警不盲点坐标；**绝不点「批准全部」**。无浏览器时冒烟 `exit=3` 已实测。

### T4 第二轮（真实浏览器，headless Edge 154，用户按 Lead 的 (a) 在沙箱外启动）—— ★ 结论已闭环

完整报告见 `.t\dsh2\T4-browser-report.md` **§14**。全程只操作我 `new_tab` 出的 3081 tab，未碰 3080 与另两个 target。

- ★ [实测] **审阅悬浮窗确实出现。** 截图 `.t\dsh2\browser\r2-headless-panel-visible.png`；AX 11 命中：
  `StaticText WinStage 暂存待审` + `button 暂时收起/拒绝全部/批准全部`；正文含
  `等待你批准后才写入真实工作区 | 1 个文件 | +1 / −0 | …\.t\dsh2\ws | 新增stage-probe.txt | 全选 | 清空选择 | 暂时收起 | 拒绝全部 | 批准全部`，
  checkbox 数 = 1；**勾选单文件后 `批准所选` 才出现**（11→14 命中，与 `507: selected.size>0` 一致）。
- ★ [实测] **F2 跨工作区泄漏未复现**：面板显示的是 `stage-probe.txt` + 隔离根 `.t\dsh2\ws`，
  **不是** repo 根那份 `.t\staged-demo.txt` ⇒ §8.3 判别式落在"根正确"分支；§12.4 里"第 153 行 `sameRoot` 失配"
  这条最高优先级假设**未发生**。**F2 的自校验在真实浏览器里生效且没误杀。**
- ★ [实测] **新缺陷 A：面板在页面加载/刷新时不挂载。** 会话已激活 + `review.json` `pending:true` 时，
  刚 attach `PANEL_HITS=0`，**再等 10s 仍 0**；点应用内「新会话」（重新挂载 composer）→ **11**。
  ⇒ 用户勾选的「首次加载即挂载」**实测失败**，且**实测证实了 T2 预测的"快照到了但面板还没接管"窗口**。
  机制：`select` 是纯函数只读模块级 `store`，首次渲染时 `store` 仍 `idle` ⇒ `routeOf` 返回 null；
  `observe` 虽用 `queueMicrotask` 补上 sessionId 并触发 `tick` 让 store 变 `ready`，
  **但没有任何东西会重新触发槽位的 `select`** ⇒ 直到 composer 被重新挂载才出现。
- ★ [实测] **新缺陷 B：「批准所选」「拒绝全部」完全无效，根因已定位：
  `/winstage*` 没有注册在该会话的命令面上。** 页面内用面板自己走的同一条 remote 通路测：
  `commands/list(agentId)` 只返回 `[compact, export, feedback, goal, permission, plan]`（**无 winstage**）；
  `commands/execute` 对照组：`/compact` → `ok=true` **带 value**（`cmd-…` success），
  而 `/winstage status`、`/winstage refresh`、`/winstage-status` 与
  **`/definitely-not-a-command-xyz` 行为完全相同**（`ok=true`、**无 value**）。
  ⇒ 面板 `act()` 拿到 `undefined`，静默无效果。三法一致：点击后 `review.json` **完全未变**
  （`generatedAt`/`revision`/`pending` 全同）、真实磁盘始终**没有** `stage-probe.txt`、直接 RPC 同样无副作用。
  根因行：`dsh-plugin\host-plugin.mjs:321-326` 的 `ctx.inject(['commands'], scope => …)`。
  **⚠️ 重要**：T1 的 `commands=6` 证据是**进程内直接调 `registerCommands()`**（`logs/19-half-verification.txt`），
  **绕过了这条 inject**，因此**不能证明线上 inject 触发过**；浏览器侧行为说明**没有生效**。
- ★ [实测] **新缺陷 C：「暂时收起」完全无效。** 两法各测一次，均确认**点中按钮本身**
  （`elementFromPoint === button`，`isSelf:true`，rect `[1060,1046,82,34]`），但 `PANEL_HITS` 始终 11、面板不消失。
  **阴性对照**：同一次运行里 `全选` 生效（11→14 命中、`批准所选` 出现）、`清空选择` 生效（checkbox true→false）
  ⇒ **React onClick 通路没问题，不是"没点到"**。机制（`489-501`）：`onClick` 只做
  `store.dismissed = snapshot?.generatedAt; store.publish({})`，而判据在槽位 `select` 第 `154` 行；
  组件一旦挂载**没人重新执行 `select`** ⇒ 面板无法收起。与缺陷 A 是**同一类**。
- [实测] 交互矩阵：加载挂载 ❌ / 应用内重挂载挂载 ✅ / 全选 ✅ / 清空选择 ✅ / 批准所选 ❌ / 拒绝全部 ❌ / 暂时收起 ❌；
  **「批准全部」未点击**（按 Lead 要求，且同上根因）。有头对照轮**未做**（用户启动的是 headless），
  但三个缺陷均与 headless/headed **无关**（非可见性/尺寸问题）。
- [实测] 附带 UI 适配：3081 的「选择工作区」与「添加工作区」**两个入口都**失败于
  `directory picker failed: spawn EPERM`（native 选择器由**跑在沙箱内的** 3081 宿主进程 spawn）；
  对话框只有 关闭/取消/**重新选择**（`U+91CD U+65B0 U+9009 U+62E9`，**不是**"手动选择"）⇒ **无手动路径兜底**。
  3081 只装配了 `dsh-client-ui-directory-picker-native`（DSH 另有 `…-browse` 未被装配）。
  我用应用**自己的** RPC 绕过：`POST /api/workspace/create {"args":{"request":{"path":"…\\.t\\dsh2\\ws"}}}` →
  `created:true`（workspaceId `88b5615a-…`），再 `workspace/initializeDefault` ⇒ 出现 `session-26c3e002-…`。
- [实测] **方法论修正**：`?winstageDebug=1` 的 `[winstage] configForms.describe()` **只在 `apply()` 与 configForms 变化时输出**，
  **不是**对 `store.state` 的实时轮询 —— 面板已正常显示后它里面的 `review:{"status":"idle"}` **仍是 idle**，
  **不可当作"面板没接管"的证据**（必须用 AX/DOM 判定）。它有用的字段是 `containsMine`/`myFormStatus`/`namespaces`；
  本轮实测 `containsMine:true`、`myFormStatus:"ready"` ⇒ **配置通道没问题**。
- ★ [实测] **修复前基线已冻结（Lead 要求的"修前对照"）**：在 3081 **尚未重启**时
  （`pid=356` / `startedAt=06:04:25.460Z`）重跑三个脚本，把 A/B/C 的"修前"逐字固定，写在报告 **§14.12**。
  要点：**A** 全新加载 `PANEL_HITS=0`、等 10s 仍 0、点「新会话」才 11；
  **B** `commands/list` = `[compact,export,feedback,goal,permission,plan]`（无 winstage），
  `/winstage status|refresh|-status` 与 `/definitely-not-a-command-xyz` **逐字同形**（`ok=true`、`value=null`），
  而 `/compact` 返回带 `value`（`cmd-87eaeab9-2`）；点「批准所选」（`disabled=False`, 命中 (1191,1063)）后
  `review.json` **未变**、`.t\dsh2\ws` 仍只有 `['.dshstage']`；
  **C** 点「暂时收起」（命中 (1011,1063)）后 `PANEL_HITS` 仍 14、面板不消失。
  **⚠️ 3081 一重启，这份对照即不可再生**；§14.12.5 给了三条到复测脚本的映射与写死的修后判据。
  **复测判据（写死，不接受"面板能点了"）**：①`commands/list` 出现 winstage 命令；
  ②`/winstage status` 返回带 `value` 且与乱码命令**可区分**；
  ③「批准所选」后 `review.json` **真的变化**且 `stage-probe.txt` **真的落盘**（`pending` 归零或该项从 `files` 消失）。

### T4 第三轮：修后复测（**A/B/C 全部 PASS；有头 9223 与 headless 9222 结论一致**）★

完整见报告 **§14.13–§14.14**。部署：PID 4512/supervisor 8744，rev **`7bcfc028443e`**，bundle 200/34854 B。

- ★ [实测] **A PASS（两轮）**：全新加载后**不做任何交互**，面板**自行出现** ——
  headless 首次 post-load 轮询 `panel_present=True`（1.9s，含页面加载时间）；headful 同样首次即 True。
  修前对照：加载 0 命中、**等 10s 仍 0**、必须点「新会话」。⇒ 用户勾选的「首次加载即挂载」**已修好**。
- ★ [实测] **B① PASS**：`commands/list` 从 6 条变 **12 条**，新增 6 条全部命中：
  `winstage` / `winstage-approve` / `winstage-diff` / `winstage-refresh` / `winstage-reject` / `winstage-status`，
  `definitionId` 形态 `winstage-sandbox/winstage*`（与 `host-plugin.mjs:246-251` 一一对应）。
- ★ [实测] **B② PASS**：`/winstage status` 返回**带 `value`**（`commandId cmd-41f0b8d3-9`，
  `result.kind=success`，文本含真实待审清单与候选 id），而 `/definitely-not-a-command-xyz` 仍 **`value=null`**
  ⇒ **两者可区分**。修前二者**逐字同形**。
- ★ [实测] **B③ PASS（两轮各一次，真落盘）**：
  headful 点「批准所选」→ `review.json` `pending true→false`/`revision 2→3`/`files 1→0`，
  真实磁盘出现 **`stage-probe.txt` 22B = `WINSTAGE-STAGE-PROBE-1`**；
  headless 同操作 → `pending true→false`/`revision 5→6`，真实磁盘出现 **`stage-probe2.txt` 22B = `WINSTAGE-STAGE-PROBE-2`**。
  批准后 `pending` 归零、面板自行消失。⇒ **"只写指定文件"得到证实**。
- ★ [实测] **C PASS（两轮，part1+part2）**：点「暂时收起」→ `panel_present=False exact_nodes=0`（**面板真的消失**）；
  再 `/winstage refresh` 产生**新 `generatedAt`** → `panel_present=True`（**只对当前版本生效**，新快照重现）。
- ★ [实测] **cookie 跨 3081 重启存活**（我自己的二值式，非推理）：**完全不带 `?token=`** 导航 `/` →
  document 响应 **200**、`__DSH_BOOT__` True、`title=DeepSeek Harness`、cookie 名与重启前**逐字相同**
  （`dsh-auth-w3iJaA6qw3qDSBs2Itl-h4S-Y-ZeYCC-N_iZO_eI_qw`）、`expires` 也一致 ⇒ **不需重装 cookie**。
  附注：该 cookie `httpOnly:true`，`document.cookie` **读不到**（空串），只能用 `Network.getAllCookies`。
- ★ [实测] **暂存写入后面板即时出现（无需刷新）**：用应用自己的 `session/prompt` RPC 让 3081 agent 真写文件
  （`{"accepted":true}`），随后同页面未刷新即 `panel_hits` 出现。⇒ 真实用户路径"agent 写 → 面板出现"通。
- ⚠️ [实测/**方法论**] **子串匹配判面板存在性会假阳性**：`cmd_discriminate.py` 执行 `/winstage status` 后，
  其输出被**回显进聊天记录**，AX 里出现 `button "winstage WinStage 暂存待审 …"` 这类**命令回显节点**，
  它们**包含**面板文案 ⇒ 我原按子串的 `filter_ax` 在面板已正确收起后仍报命中（第一次跑 C 得到假 `FAIL`）。
  **修法**：`cdp.py` 新增**精确名**的 `panel_nodes()`/`panel_present()`（面板自身名恰好是
  `WinStage 暂存待审`/`暂时收起`/…；回显是长句、chip 名是 `winstage`/`winstage-status`，都不精确相等）。
  **凡 `/winstage` 输出可能进聊天记录，就必须用精确名或"面板独有按钮 `暂时收起`"判存在性。**
- [实测] 有头/headless **无任何不一致项** ⇒ 无需"以有头为准"裁定分歧；**面板可见性 S5 现有 headless+headful 双证据**。
- [实测] 本轮脚本改动（均在 §14.12 基线冻结之后，仅**度量/端口/标签**层面，不改被测行为）：
  `cdp.py` 端口 env 化 + 精确名检测；`r2_capture.py` 端口 env 化 + stdout UTF-8（修 `+1 / −0` 的 U+2212 打印崩溃）；
  新增 `raw/a_test.py`、`raw/c_test.py`、`raw/cookie_survival.py`、`raw/stage_probe2.py`；
  `raw/interact.py` 改精确检测 + 截图标签按端口命名；`raw/cmd_discriminate.py` 加紧凑命令清单输出。

## T5
