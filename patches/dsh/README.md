# DSH harness 补丁工具包（`patches/dsh/`）

> **本工具包默认不应用任何补丁。**`--check` 是默认动作，`--apply` 必须显式给出。
> 本轮交付**没有**执行过 `--apply`（安装树 `C:\Users\Administrator\AppData\Local\npm-cache\_npx\1e7f6d9597241db0` 一字未改，`[实测]`：`tools\dsh-patches.mjs --check` 报 4/4 未应用）。

## 0. 为什么是"可重放补丁包"而不是"直接改"

本机 DSH 是 **npx 缓存安装树**：`<root>\node_modules\@deepseek-ai\...` 下只有编译产物 `lib/*.js`，
**没有源码、没有构建工具、没有测试**。手工改它有三个必然结局：

1. **不持久**：`npm i` / 升级 / 清缓存之后，改动无声消失，而"看起来一切正常"；
2. **会错位**：上游一升级，行号、锚点文案、文件哈希全变，旧补丁变成"看似还在、其实早就不匹配"；
3. **不可证伪**：没人能说出"这个文件现在到底打没打补丁"。

因此三处修复被做成：**一份机器可读清单**（`manifest.json`，唯一数据源）→ **一个可重放工具**
（`tools/dsh-patches.mjs`）→ **一条会红的守门测试**（`tests/dsh-patch-guard.mjs`）。

> **唯一持久修复是上游**。本工具包是"在当前装机上可复现、可验证、失效时会喊"的工程妥协，
> 不是替代品。上游化建议见 §5。

## 1. 目录与命令

| 路径 | 作用 |
|---|---|
| `patches/dsh/manifest.json` | **唯一数据源**：每条 = 一个文件；含 `target`（相对 harness 根）、`before`/`after` 精确片段、`beforeSha256`/`afterSha256`（**整文件**哈希）、`rationale`、`upstream`、`verified`/`unverified`/`residuals` |
| `patches/dsh/pristine/<id>/…` | 被改文件的**原样副本**（只读复制得到，逐字节相同）。用于：离线自洽校验、重新生成 diff、`--revert` 回落 |
| `patches/dsh/pristine/SOURCE.md` | **原样副本的来源与 MIT 许可归属**：逐文件列出上游包名 / 版本 / harness 内原路径 / 许可，并在 `pristine/LICENSES/<包名>.LICENSE` 附上四个上游包各自 `LICENSE` 的逐字节副本（MIT 要求副本中保留版权与许可声明） |
| `patches/dsh/*.patch` | 由同一份清单生成的 unified diff（`git diff --no-index`，在临时目录里生成，**不碰**安装树） |
| `tools/dsh-patches.mjs` | CLI + 纯函数（`--check` 默认 / `--apply` / `--revert` / `--emit-patches`） |
| `tests/dsh-patch-guard.mjs` | 守门套件：清单自洽 + **现场哈希必须恰好等于 `before` 或 `after`** |

```
node tools\dsh-patches.mjs --check           # 定位 harness、逐条判定"未应用/已应用"、复核锚点
node tools\dsh-patches.mjs --apply           # 幂等；先备份 <file>.dsh-patch-backup，再写入并复核 afterSha256
node tools\dsh-patches.mjs --revert          # 优先用备份（先校验它是 before），否则用包内原样副本
node tools\dsh-patches.mjs --emit-patches    # 由清单重新生成 patches\dsh\*.patch
node tests\dsh-patch-guard.mjs               # 守门（找不到 harness 时如实 SKIP，不是 PASS）
```

**退出码**：`0` 正常（未应用或已应用都算正常）/ `1` 用法或清单错误 / `3` **找不到 harness 根** / `4` **漂移**。
"找不到"与"没问题"是两个不同的码 —— 不允许静默通过。

**harness 定位顺序（三级）**：`DSH_HARNESS_ROOT` → 已知 npx 路径 → 扫 `%LOCALAPPDATA%\npm-cache\_npx\*`。
判据不是"目录存在"，而是"该根下真的能读到清单里第一条 `target`"。本机实测命中
`known-npx-path`：`C:\Users\Administrator\AppData\Local\npm-cache\_npx\1e7f6d9597241db0`（`[实测]`）。

**为什么把原样副本放进仓库**：这样"清单是否自洽"可以在**没有 harness** 的机器上离线判定
（副本哈希 == `beforeSha256`；`before` 锚点恰好一处；对副本做替换后的哈希 == `afterSha256`）。
守门测试因此能区分两件事：**补丁包自己坏了**（红，且与 harness 无关）与
**harness 漂了或补丁丢了**（红，需要重新验证补丁）。

## 2. 两个正交的 verification 概念

| 概念 | 判据 | 谁保证 |
|---|---|---|
| **片段级正确**（清单可信） | 副本哈希 == `beforeSha256`；`before` 恰好 1 处；派生 after 哈希 == `afterSha256` | `tests/dsh-patch-guard.mjs` §2 + `--emit-patches` 生成时 |
| **现场级符合**（装机状态可判定） | 安装文件哈希 ∈ {`before`, `after`}；**第三个数 = 漂移 = 红** | `tests/dsh-patch-guard.mjs` §3 |

漂移时的红灯原文（`[实测]`，见 `.t/dpg-plant.txt`）：`harness drifted — re-validate the patch` + 文件路径 +
期望哈希 + 实际哈希。这就是"补丁被静默丢掉"变成失败测试的那个开关。

## 3. 三个修复（逐条）

三处修复的**共同上游**是 `git+https://github.com/deepseek-ai/deepseek-harness.git`（`package.json`
`repository`），版本 `0.2.0-rc.2`。每条给出 `repository.directory`（`[官方]`：读各包 `package.json`）。

### P1 —— H1：`approval: never` 下自动拒绝的升级被说成"用户拒绝了"

| 项 | 内容 |
|---|---|
| **问题** | `@deepseek-ai/dsh-user-approval/lib/index.js:175` 在 `effectivePolicy(session) === "never"` 时**直接** `return "rejected"`（**不派发 waterfall**，也就是**根本没问过用户**）；而 `@deepseek-ai/dsh-sandbox` 把每个 `rejected` 都渲染成 `the user rejected escalating this …`。模型于是拿到一句**甩锅给用户**的错误，并可能据此反复尝试。 |
| **目标文件** | `node_modules/@deepseek-ai/dsh-sandbox/lib/index.js`（harness 根相对） |
| **锚点** | `case "rejected"`，`lib/index.js:118`，位于 `switch (outcome)` 内（`approveEscalation` 函数体）。全文件仅 1 处（`[实测]`）。 |
| **改动** | 该分支先问策略：`approval.approver.effectivePolicy?.(approval.agent.session)`（整段 `try/catch` 包住）；为 `"never"` 时抛 `error.code = "ESCALATION_POLICY_DENIED"` 的**不甩锅**错误（说明会话审批策略、说明命令未执行、要求上报而非绕过）；其余情况**原文案一字不变**。 |
| **上游包路径** | `@deepseek-ai/dsh-sandbox` → `packages/sandbox/sandbox`；源码文件 `packages/sandbox/sandbox/src/types/escalation.ts`（`[推断]`：编译产物的 region 注释是 `lib/types/escalation.js`，见 `lib/index.js:6`） |
| **已验证** | ① before/after 与文件逐字节一致（生成器断言唯一性）；② `ApprovalService` 把 `effectivePolicy`/`overrideOf` 定义在原型上（`dsh-user-approval/lib/index.js:152-165`），而调用方传的 `approver` 就是 `ctx.get("approval")`（`dsh-tool-pwsh/lib/index.js:341`）⇒ **运行期确实存在**（`[官方]` 读码 + `[实测]` 本机文件内容）；③ `"never"` 是该分支的唯一入口（`[官方]`：`decide()` 只在 `signal.aborted` 与 `never` 两处短路）；④ 计算 message 的路径不会抛（try/catch ＋ `agent` 已在 :104 非空校验）；⑤ 该 switch 覆盖 **6 个调用家族**（`[实测]`：本机 grep `approveEscalation` 命中 `dsh-tool-bash:364`、`dsh-tool-fs:1128`、`dsh-tool-pwsh:335`、`dsh-tools:1194`、`dsh-tools/lib/types/ptc:308`、`dsh-plugin-manager/lib/types/tools:32`；六个调用点里 `approver: ctx.get("approval")` 的供给行分别是 `:370`/`:1134`/`:341`/`:1200`/`:314`/`:35`。旧稿写 `dsh-tool-bash:354` 是错的 —— 那一行是 `{@link approveEscalation}` 的 JSDoc 引用，不是调用点） |
| **`[未实测]`** | 未在运行期真正触发一次 never 档位的升级请求（需要打补丁后重启 harness 再让模型发一次 `sandbox_permissions`）；未移植回上游 TS（上游 `EscalationApproval.approver` 的结构类型只声明了 `request()`，移植时**必须同步放宽类型**） |
| **残余** | 若某组合里的 `approver` 是只实现 `request()` 的替身，`effectivePolicy` 缺失 ⇒ 回落原文案（不退化、不抛错） |
| **持久性** | npx 缓存 ⇒ 重装/升级即丢；`--check` 会报 `NOT-APPLIED`，守门套件**不会**因此变红（未应用是合法状态）——所以"要不要打"由人决定，"打完有没有丢"由机器盯 |

### P2 —— H2：系统提示禁止升级，工具却还在登广告（**draft，`[未验证]` 部分已明示**）

| 项 | 内容 |
|---|---|
| **问题** | 组合层审批策略为 `"never"` 时，系统提示写死 `NEVER_SENTENCE`（`dsh-user-approval/lib/index.js:39`："do not request sandbox escalation"），而 `dsh-tool-pwsh` 仍：注册 `sandbox_permissions`/`justification` 参数（`:483-493`）、走带升级措辞的 `description` 分支（`:459` ＋ `:254-258`）、在**三处**提示里说"可以升级"（`sandboxNotes :22-30`、`renderPwshResult :155-176`、`renderPwshJobRead :202-212`）。模型得到两条互相矛盾的事实。 |
| **目标文件** | `node_modules/@deepseek-ai/dsh-tool-pwsh/lib/index.js` |
| **锚点** | `const defaultMode = ctx.shell.sandboxMode;` / `const escalationModes = defaultMode === void 0 ? [] : ESCALATION_TARGETS;`（`L314-L315`） |
| **改动** | `escalationModes` 额外与**组合层审批默认策略**相与：`ctx.get("approval")?.config?.policy === "never"` ⇒ 空数组（参数、描述分支、三处提示**同时**消失），并 `ctx.logger.warn` 出声。`escalationModes` 是这四者的**唯一**开关（`[实测]`：逐个消费者按行号读过）。 |
| **上游包路径** | `@deepseek-ai/dsh-tool-pwsh` → `packages/shell/tool-pwsh`；源码 `packages/shell/tool-pwsh/src/index.ts`（`[推断]`） |
| **已验证** | ① 片段与文件逐字节一致；② 四个消费者共用同一闭包（置空即同时消失）；③ 执行期不漏放行：字段被隐藏后若模型硬塞 `sandbox_permissions`，`approvePwshEscalation`（`:333`）直接抛 `sandbox_permissions is not available in this composition`（fail-closed）；④ 组合层默认策略的来源已定位：`dsh-base/cordis.patch.yml:248` 用 `!!js` 由 `DSH_PERMISSION_MODE` 决定（`[官方]`） |
| **`[未实测]`（本条目 `status: draft`）** | ① **可达性**：`ctx.get(name, strict=true)` 只在服务 fibre 处于 ACTIVE 时返回值（`cordis/lib/index.js:763-769`），而 cordis loader 用 `Promise.allSettled` **并发**启动各 entry（`cordis-plugin-loader/lib/index.js:143-158`）⇒ `apply()` 时刻审批服务是否已激活**没有硬保证**。因此本改动是**防御性**的：拿不到策略就保持现状，不会误伤，但也**不保证**一定收紧。② **效果**：未实测"参数/描述真的从模型可见的工具清单里消失"（需要重启 harness 观察 schema）。③ **本机现状**：`DSH_PERMISSION_MODE` 未设 ⇒ 组合层策略是 `ask`（profile 的 `defaultPreset: workspace-write`）⇒ **本机即使打上本补丁也看不到任何变化**。 |
| **残余（重要，任务要求写明）** | `escalationModes` **每个 fibre 只算一次**，而工具 schema 是**进程级注册期**事实 ⇒ **会话级**覆写为 `never`（`/permission` 切换、委托子代理把 approval 钉成 never；本会话正是后者）**依旧会登广告**。要彻底解决必须让"sandbox_permissions 是否出现"按会话求值 —— 这需要上游把工具 schema 与会话策略挂钩，或由审批服务自己声明可用性。本补丁在**本机当前会话**里**不改变任何行为**，这一点是**已实测**的（`[实测]`：`--check` 之外没有任何运行期证据被采集；本机组合层策略 = `ask`）。 |
| **持久性** | 同 P1 |

### P3 —— H3：未钉住的 `custom` 默认值把整个 `permission` 行端下屏幕

| 项 | 内容 |
|---|---|
| **问题** | `@deepseek-ai/dsh-permission-presets` 在装配期 `derive(EMPTY_KNOBS) === "custom"`（组合出的 sandbox＋approval 不匹配任何预设）时**直接抛错**（`lib/index.js:180`）⇒ 构造函数后半段（**包括 `permissions` 会话投影单元** `:188-201`）根本没执行 ⇒ 客户端 `useProjection("permissions")` 恒为 `undefined` ⇒ `PermissionSelect` 命中 `client.js:324` 的 `return null` ⇒ **访问模式控件整块消失**，用户看不到任何解释。 |
| **目标文件（宿主半）** | `node_modules/@deepseek-ai/dsh-permission-presets/lib/index.js`，锚点 `L178-L186` |
| **改动（宿主半）** | 派生为 `custom` 时**不再抛**：显式**命名**的未知默认值仍然抛（`this.resolve(namedDefault)`）；否则把**设置面的新会话默认钉在第一个已配置预设**，并 `ctx.logger.warn` 说明理由。一个预设都没配且派生 custom 时才抛（真·无解配置）。**投影面**（`wire.view: (state) => ({ currentValue: this.derive(state) })`，`:199`）**本来就报 `custom`** —— 它此前只是没被注册而已。 |
| **目标文件（客户端半）** | `node_modules/@deepseek-ai/dsh-client-ui-permission-presets/lib/client.js`，锚点 `L324` |
| **改动（客户端半）** | 拆开两个条件：`catalog === null` 仍 `return null`（没有可选项可渲染）；`selection === void 0` 改为渲染一个 **disabled** 的 `Custom / 自定义` 控件，让行**仍然可见**并带解释性 aria-label。 |
| **上游包路径** | `@deepseek-ai/dsh-permission-presets` → `packages/interaction/permission-presets`（源码 `src/index.ts`，`[官方]`：`lib/typert.host.js:35` 记录了该源位置）；`@deepseek-ai/dsh-client-ui-permission-presets` → `packages/client/ui-permission-presets`（源码 `src/client/PermissionSelect.tsx`，`[推断]`） |
| **已验证（关键设计决定）** | 任务书要求"先验证 `defaultSettings()` 与投影视图的**每一个**消费者，若返回 `{defaultPreset:'custom'}` 会打破下游校验，就把设置面钉在真实预设、只让投影面报 custom，并写明做了什么"。本补丁**正是后者**，理由是实测读码：<br>① 客户端 `permissionDefaultOf`（`client.js:570-581`）**硬要求** `currentValue ∈ catalog.defaultOptions`，否则抛 `permission catalog does not advertise its current default`；② `catalog.defaultOptions = Object.keys(presets)`（`index.js:248`）**不含** `custom`（`custom` 只是 `optionOf("custom")` 这个渲染项，`names`（`:238-240`）不含它）；③ `pinInitialPermission`（`:370-389`）对新会话会 `this.resolve(this.defaultPreset)` ⇒ 返回 `custom` 会抛。<br>因此：**`defaultSettings()` 绝不返回 `custom`**（钉在 `this.names[0]`，构造期等于 `Object.keys(this.presets)[0]`，是真实预设），**只有投影面报 `custom`**。<br>④ `ctx.approval`/`ctx.shell` 在构造期可用（`static inject = ["shell","approval",…]`，`:160-165`；`ctx.approval.config.policy` 在 `:297` 已有同样用法）；⑤ 客户端新增的 early return 位于**全部 hooks 之后**（`:309-323`），不改变 hook 顺序。 |
| **`[未实测]`** | ① 未在真实装配里制造"派生为 custom"的部署（需要 `DSH_PERMISSION_MODE` 与 profile 预设不匹配，且 profile 不带显式 `defaultPreset`；本机 profile **带** `defaultPreset: workspace-write`，走不到该分支）；② 未在浏览器里验证"行仍挂载 ＋ 显示 Custom"（需重启 3080 并截图）。 |
| **残余** | ① 同包 `lib/types/index.js:150-215` 是同一实现的**另一份编译副本**、带同样的抛错，但**运行期不可达**（package.json `exports` 的 `.` 指向 `lib/index.js`；全仓无任何 import 指向它，`[实测]`：grep `permission-presets/lib`、`permission-presets/types`）⇒ 本补丁**刻意不动它**；② 钉在"第一个已配置预设"是策略选择（让新会话默认成为确定值）；若部署真的想让新会话停在 custom，需要上游给 `defaultSettings` 一个"未设置"的表达，本补丁不发明新值；③ `Custom / 自定义` 是双语字面量而非 i18n 键（避免动 locale 字典：`zh` 是键集权威、`en` 要逐键对齐）；④ 投影首次到达前 `selection` 也是 `undefined` ⇒ 加载瞬间会显示 disabled 的 Custom 而不是空白（行为变化，如实记录）。 |
| **持久性** | 同 P1；客户端半还要注意 `lib/client.js` 是 **HMR 产物**，升级后一样会丢 |

## 4. 为什么默认不应用（诚实声明）

1. **npx 缓存 ⇒ 不持久**：应用了也会在下一次 `npm i` / 升级 / 清缓存时消失，而"消失"本身不可见；
2. **上游是唯一持久修复**：补丁把语义钉在**编译产物的行号与文案**上，上游任何一次重构都会让它失配；
3. **P2 在本机是空转**：组合层策略是 `ask`，本补丁不改变本机行为（见 P2 的 `[未实测]` 与残余）；
4. **未在运行期验证过效果**：三处修复都只做了**片段级 + 消费者级**的静态验证，没有一次"重启 harness 后
   观察模型可见事实"的端到端证据。因此把补丁**默认留在"未应用"**、由需要它的人显式 `--apply`，
   是当前证据强度下唯一诚实的默认值。

## 5. 上游化建议（持久修复的方向）

| 补丁 | 上游做法 |
|---|---|
| P1 | 在 `packages/sandbox/sandbox/src/types/escalation.ts` 里把策略判定**上移**：`EscalationApproval` 增加一个显式的"策略"输入（例如 `effectivePolicy(session)` 闭包），或在 `dsh-user-approval` 里为 `never` 短路产出一个**独立 outcome**（如 `"policy-denied"`），让"没问过用户"在类型层面就无法被误读成"用户拒绝"。同步放宽 `approver` 的结构类型。 |
| P2 | 让升级面**按会话**求值：由审批服务暴露"本会话是否允许升级"的事实，工具 schema 在会话建立时（而不是 fibre 启动时）据此构建；或把 `sandbox_permissions` 收进一个"仅当策略允许时注册"的动态工具。 |
| P3 | 在 `packages/interaction/permission-presets/src/index.ts` 里把 `defaultSettings` 的返回类型改成"预设名 **或** custom"，并让客户端 `permissionDefaultOf` 接受 `custom`（渲染成 disabled 项）；或干脆禁止"组合默认不匹配任何预设"的配置在装配期静默存在。 |

## 6. 证据与复核

| 证据 | 位置 |
|---|---|
| `--check` 判定（4/4 未应用，命中 known-npx-path，exit 0） | `.t/patchcheck.txt` |
| 守门套件正常模式（30 项 0 失败，`RESULT: PASS`；含临时副本上的 `--apply`/`--revert` 六条行为） | `.t/dpg-normal.txt` |
| 守门套件 `--plant`（伪造清单哈希 ＋ 翻掉临时副本一个字节 ⇒ 4 红，`RESULT: FAIL`） | `.t/dpg-plant.txt` |
| **反证的另一条通路**：临时清单副本（翻一位哈希 / 删一行 / 加幽灵行 / 非法行）＋ 翻一个字节的现场文本 ⇒ 两条守门都红，且真实清单/真实安装树未被触碰 | `.t/patchkit-guards-drift.txt` |
| `--emit-patches` 输出（4 个 `.patch`，exit 0） | `.t/emitpatches.txt` |
| 派生 after 的语法验证（四个文件 `node --check` 全 exit 0） | `.t/aftercheck.txt`（派生文件本身是临时产物，已清理） |
| 整仓关口（23/23 套件 / `RESULT: ALL PASS` / **1948** 标记 ＝ 1920 `✓` ＋ 28 `[OK  ]` / 0 条红断言） | `.t/patchkit-verify.txt`（封印修复后又复跑一次，口径相同：`.t/seal-fix-verify.txt`） |
| 源码封印的 `--check`（95 条逐条相符，exit 0）；套件正常模式 14/0（清单**缺失 / 不可读 / 为空默认判红**，只有显式 `WINSTAGE_ALLOW_UNSEALED=1` / `--allow-unsealed` 才 SKIP） | `.t/bl-check.txt`、`.t/bi-normal.txt`、`.t/seal-fix-verify.txt` |
| 源码封印的 `--plant`（四种清单损坏各被抓到 ⇒ 5 红） | `.t/bi-plant.txt` |

### 维护：换到新的上游版本时

1. 重新只读复制四个目标文件到 `patches/dsh/pristine/<id>/`（**不要**用安装树做实验）；
2. 更新 `manifest.json` 里对应的 `before`/`after`（从副本里按行号抄 `before`，逐字节，含 TAB 缩进）；
3. 重算两个整文件哈希（依赖只有 node 自身）：

   ```
   node -e "const c=require('node:crypto'),f=require('node:fs');const p='patches/dsh/pristine/P1-escalation-policy-denied/index.js';console.log(c.createHash('sha256').update(f.readFileSync(p)).digest('hex'))"
   ```

   `afterSha256` 用"把 `before` 替换成 `after` 之后的文本"同法计算；
4. `node tools\dsh-patches.mjs --check`（清单自洽性会当场指出任何哈希/锚点不符）→
   `node tests\dsh-patch-guard.mjs` → `node tools\dsh-patches.mjs --emit-patches`。

