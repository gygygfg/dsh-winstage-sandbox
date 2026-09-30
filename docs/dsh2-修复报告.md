# WinStageSandbox 第二实例：修复报告（T3：F1–F4；T5b：B/A/C；T8/S3c：三档显示）

> 作者：T3 `plugin-fixer`。范围：按 `docs/dsh2-基线报告.md` §6 的最小改动清单修 `dsh-plugin/**`（F1–F4），
> 再按 T4 的浏览器实测（`.t\dsh2\T4-browser-report.md` §14、`task-5`）修 B / A / C。
> 判定标签：`[实测]`（本机跑出来，附原始命令与原始输出）、`[引用]`（读源码逐字，给绝对文件:行）、
> `[未实测]`（没条件测，写清前提）。
> **本报告不出现"看起来好了"这类结论**：每条改动都绑定一条可复跑断言与它的原始输出。

---

## 0. 摘要：8 处改动 + 断言结果

| # | 文件:行（改后） | 改动 | 断言脚本 | 结果 |
|---|---|---|---|---|
| F1 | `dsh-plugin\cordis.patch.yml:41` | host 行名 子路径 → **裸包名**（client 半才会下发） | `f1-static.mjs` + `f1-live-3081.mjs` | **PASS**（活体：启动图 + bundle 路由 200） |
| F2-C7 | `dsh-plugin\client.js:130,149,153,206,230` | 去掉 `owner.session.cwd` 静默兜底 + 快照根自校验 | `f2-client-c7.mjs` | **PASS**（含 2 条改动前对照） |
| F2-C8 | `dsh-plugin\cordis.patch.yml:44,56,58` + `staging-fs.mjs:90,147-168` | 两个"根"用 YAML 锚点结构性同源 + 漂移 fail-closed | `f2-c8-root-drift.mjs` | **PASS**（8/8） |
| F3 | `dsh-plugin\fs-entry.mjs:21` + `staging-fs.mjs:128,292-297` | `stageOutside` 默认 `direct` → **`deny`**，保留 `=direct` opt-out | `f3-outside-default.mjs` | **PASS**（7/7 + 外层 EPERM 原文） |
| F4 | `dsh-plugin\staging-fs.mjs:318,344`（+ `:260,:286` 调用点） | 覆写 `watch()`：转发超类 + 暂存变更本地失效 | `f4-watch.mjs` | **PASS**（7/7） |
| **B** | `dsh-plugin\host-plugin.mjs:260`（+ `:321-337` 失败可见化） | `input.placeholder` → **`input.hint`**（真校验器必填字段） | `f5-commands-register.mjs` | **PASS**（真 `CommandRuntime` 7/7 + 2 条改动前对照） |
| **A** | `dsh-plugin\client.js:711-786` | chain 槽位失效通道：接管状态跃迁时重挂注册 | `f6-slot-election.mjs` | **PASS**（12/12 + 2 条改动前对照） |
| **C** | 同上（同一通道） | 「暂时收起」经同一通道让 `select` 重新求值 | `f6-slot-election.mjs` | **PASS**（驱动**真实组件**的 onClick） |
| **S3c** | `dsh-plugin\client.js`（三档显示，见 §13） | 按 `risk` 分三组 + 主题 token 分级 + 默认不勾 + 非阻断 alerts + `note` 原文 | `.t\dsh2\browser\ui3\f8-three-tier.mjs` | **PASS**（34/34 + 3 条改动前对照） |

**回归门**：`.\autotest.cmd --skip-audit` = **9 套件全过 / 250 断言 / 退出码 0**，与 T2 基线
（`.t\dsh2\probe\out\b0-autotest-baseline.txt`）**逐项一致，无下降** `[实测]`。

**一条命令复跑全部断言**：`.t\dsh2\fix-asserts\run-all.cmd` → `RUN-ALL: ALL ASSERTIONS PASSED`（退出码 0，8 个脚本）。

---

## 1. 硬约束遵守情况（自证）

| 约束 | 状态 | 证据 |
|---|---|---|
| 只写 `dsh-plugin/**`、`docs\dsh2-修复报告.md`、`docs\dsh2-发现记录.md` 的 `## T3`、`.t\dsh2\fix-backup\`、`.t\dsh2\fix-asserts\` | ✅ | `[实测]` 我改动的 `dsh-plugin` 文件恰好 4 个（`Get-ChildItem dsh-plugin -File \| ? LastWriteTime -gt 13:56` → 只有 `client.js`/`cordis.patch.yml`/`fs-entry.mjs`/`staging-fs.mjs`）；`src/`、`tests/` 同期**零改动**（同一命令过滤 `src,tests` 返回空） |
| **不重启/不改 3080 实例、不动 `C:\Users\Administrator\.dsh`** | ✅ | 我全程只读该目录（读了 `profiles\web\cordis.patch.yml` 用于判定断言冲突是否存在）；**未执行任何 sync/restart** |
| 不重启 3081（由 T1 管理） | ✅ | 我只跑只读 HTTP；3081 的重启与同步是 T1 做的（见 §2.5 时间线） |
| 改前备份 + 前后 SHA256 + 回滚方式 | ✅ | 见 §8 |
| 每处改动一条可复跑断言、不改 `tests/**` | ✅ | 断言全部落在 `.t\dsh2\fix-asserts\*.mjs`，未改 `tests/**` |

---

## 2. F1 —— client 半永远不下发（S5 根因）

### 2.1 根因（我自己读源码得到的判定依据，与 T2 §4.3 独立一致）

`node_modules\@deepseek-ai\dsh-client-modules\lib\index.js`：

- `:82-88 exactPackageSpecifier(specifier)`：`specifier.startsWith("@")` 时 `split("/")` 必须**恰好 2 段**才返回包名；`@local/dsh-winstage-sandbox/host-plugin` 是 3 段 ⇒ 返回 `undefined`。
- `:746-747`：`const expectedPackageName = pathLike ? void 0 : exactPackageSpecifier(loaderName)`；下一行 `if (!pathLike && expectedPackageName === void 0) return void 0` ⇒ **直接返回 undefined**。
- `:701-709 resolveMeta()`：`located === void 0` ⇒ 缓存 `null` 并返回 `null`。
- `:858-870 resolveSource()`：`resolveMeta()` 返回 `null` ⇒ 返回 `undefined`。
- `:833-839 processOne()`：拿不到 source ⇒ 该包**永远不进 client 模块表** ⇒ `window.__DSH_BOOT__` 里没有它 ⇒ **审阅悬浮窗永远不会出现**，与"页面刷新"无关。

`[实测]` 复现（`f1-static.mjs` 的 A1 组，用**真源码文本**执行，不是手抄逻辑）：

```
PASS  A1  pre-fix host row name is a THREE-SEGMENT subpath -> exactPackageSpecifier() === undefined
      name=@local/dsh-winstage-sandbox/host-plugin  exactPackageSpecifier=undefined
```

> 脚本做法：从安装好的 `dsh-client-modules/lib/index.js` 里按 `:76-88` 正则取出 `exactPackageSpecifier` 的
> **真实源码文本**，用 `new Function` 执行后作用在**真 YAML 解析出来的**行名上。

### 2.2 改动

`dsh-plugin\cordis.patch.yml:41`（改后行号）：`name: '@local/dsh-winstage-sandbox'`

- 安全性：`package.json:8` `exports["."] = "./host-plugin.mjs"`，与 `exports["./host-plugin"]` 是**同一个文件**（`f1-static.mjs` 的 A5 组断言二者解析到**同一个 realpath**）⇒ 同一模块 URL，不会二次初始化。
- `[实测]` 反事实守卫（A3）：若两行都用裸名，会有 **2 行**解析到 `host-plugin.mjs` ⇒ 命令 `definitionId` 冲突。这是 **fs 行不能跟着改名**的第一条理由。

### 2.3 fs 行为什么**必须**保持子路径 specifier（三条理由，均有实测/源码依据）

1. **会 apply 两次 host 半**：裸名解析到 `exports["."]` = `host-plugin.mjs`（`f1-static.mjs` A3-counterfactual：`would-be host-plugin rows=2`）。
2. **会丢掉 profile 覆盖层的 `cwd` 隔离配置**：见 §2.4 的断言语义 —— profile 层断言的是 `.../fs`，改名即不匹配 ⇒ 整条被跳过。
3. **它本来不需要 client 半**：client bundle 是**按包名**聚合的（`:871-877 reconcilePackage` 以 `packageName` 为键，且 `:874-877` 对"同一包名多个活跃 source"直接抛错），fs 行只提供 `ctx.fs`，没有 `dsh.client` 需求。

`f1-static.mjs` 的 A2-fs 组把第 1 条固化成"改回去就会 FAIL"的回归守卫。

### 2.4 关键判定：3081 实际读的是**哪一份** patch（Lead 专门问的一条）

**结论：行名最终来自「仓库 `dsh-plugin\cordis.patch.yml` 的部署副本」**。判定依据：

| 环节 | 证据 |
|---|---|
| bundle 补丁路径 = 安装目录下的相对文件 | `dsh-app-boot\lib\index.js:507-509` `bundlePatchPaths(packageDir, bundle) = join(packageDir, file)`；`:931-932` 用 `resolveBundleDir(...)` 得到的 `packageDir` 去 `loadOverlayPatches` |
| 3081 的 bundle 安装目录 = profile 的 `node_modules` 实体副本 | `.t\dsh2\home\profiles\dsh2\package.json` 的 `dsh.profile.bundles` 含 `@local/dsh-winstage-sandbox`；`node_modules\@local\dsh-winstage-sandbox` 是**实体目录**（`LinkType` 为空，非链接） |
| 部署副本与仓库**逐字节相同**（改动前） | 两边 SHA256 均为 `2BF6FB7E459E015AEF46586B7F5E4E67CDCE09C4D159365FDE2D08ECEF9125EF`，`Compare-Object` 差异 0 行 |
| **profile 层无法重命名行** | `cordis-plugin-include\lib\index.js:99-102` 的 overrides **排除 `name`**（`if (key === "id") continue`，而 `name` 在 `:68` 已被解构出去）⇒ 非 insert 的 `name` 只能**断言** |
| 层序：bundle 先、profile 后 | `dsh-app-boot\lib\index.js:466-475` 文档 + `:1024-1029 readProfilePatches`（`profile.layers` → `initialProfile.patches`/`--patch` → `home/cordis.patch.yml` → overlays） |

⇒ 我改的是**正确的那一份**；3081 上生效需要 T1 的 sync + 重启（§2.5 已发生）。

### 2.5 profile 覆盖层的**断言陷阱**（差点翻车，已由 T1 修好）

- 语义（源码）：`cordis-plugin-include\lib\index.js:95-98`
  `if (name && name !== target.name) { warn("patch: name mismatch ... skipping"); continue; }`
  —— 不匹配则**整条补丁（连它的 `config`）一起被跳过**。
- 因此：我把 bundle 行改成裸名后，`.t\dsh2\home\profiles\dsh2\cordis.patch.yml` 里**同 id 的** `winstage-sandbox`
  若仍断言旧名 `.../host-plugin`，它携带的 `config.workspaceRoot: .t\dsh2\ws` 会**被静默丢弃** ⇒
  3081 的 `workspaceRoot` 回落到 bundle 里写的**项目根** ⇒ `.dshstage` 写进真实工作区 —— 正是 F2 要修的"串台"。
- `[实测]` 我在报告前把这个陷阱做成了**可判定的断言**（`f1-static.mjs` A4 组）：
  - 陷阱版本（模拟旧 profile 层）：`NOTE A4-TRAP-CONFIRMED`，组合后 `workspaceRoot=C:\...\WinStageSandbox`（bundle 值）。
  - 修好后：`PASS A4-profile-override-survives`，组合后 `workspaceRoot=C:\...\.t\dsh2\ws`。
- **实际结局**：我把这条发现立刻发给 Lead，**T1 已在 profile 层把 `winstage-sandbox` 行名改成裸包名**
  （`.t\dsh2\home\profiles\dsh2\cordis.patch.yml`，并写了同样的说明）。现在 A4 已经是 PASS。
  `[实测]` 3081 的暂存根快照 `.t\dsh2\ws\.dshstage\review.json` 的 `workspaceRoot = C:\...\.t\dsh2\ws`
  （`generatedAt 2026-09-28T05:58:50Z`），**没有**落到项目根 ⇒ 陷阱确实被避开了。
- 用户实例 `C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml` **没有** winstage 行（我读过），
  所以用户实例不存在这个断言冲突；F1 对它只需我这一处改动（生效需用户自己重启，本轮不动）。

### 2.6 F1 验收断言与**活体原始输出**

静态（`f1-static.mjs`，15 项全 PASS）已在上文引用。活体（`f1-live-3081.mjs`）`[实测]`：

```
deployed patch state: updated-bare-name
token exchange: status=303 cookie=true
index: status=200 bytes=34545
__DSH_BOOT__ rev=3851a05f1d1a entries=65
entries with id === '@local/dsh-winstage-sandbox': true
raw entry JSON: {"id":"@local/dsh-winstage-sandbox","url":"plugins/??@local/dsh-winstage-sandbox/client.js&rev=c20a44a40ab9","rev":"c20a44a40ab9","inject":["@deepseek-ai/dsh-client-ui-settings"],"immediately":true}
@local/* ids in boot graph: ["@local/dsh-winstage-sandbox"]
bundle route /plugins/??@local/dsh-winstage-sandbox/client.js&rev=c20a44a40ab9 -> 200 text/javascript; charset=utf-8 25948 bytes
VERDICT: PASS: the client bundle for the plugin is present in window.__DSH_BOOT__ (F1 live-verified)
```

- 上表**原始 JSON 片段**即 Lead 要求的证据：`id === '@local/dsh-winstage-sandbox'`，且 `immediately: true`
  与我 `package.json` 的声明一致。
- **"命令仍只注册一次"的判据**（不靠日志计数）：`f1-static.mjs` 的 A3 组用**真 `applyEntryPatches`
  （`cordis-plugin-include\lib\index.js:246` 导出）+ 真 js-yaml** 组合 bundle 层，断言
  **恰好 1 行**解析到 `host-plugin.mjs`：`rows=["winstage-sandbox:@local/dsh-winstage-sandbox"]`。
  配合 A3-counterfactual（两行同用裸名 → 2 行），"只 apply 一次"是被实测钉死的，不是推断。
- 该脚本会**区分**三种结果，避免假绿：`exit 0` = 通过；`exit 2` = `PENDING-RESTART`
  （部署副本仍是旧行名）；`exit 1` = 真失败（部署副本已是新行名但启动图仍无该 bundle）。

> **第三方独立复现**（同一结论，不同工具链）：T4 用 Node 真实 JS 引擎 eval 解析同一页面，得到
> `entries=65`、`@local` 命中 1 条、`url` 与 `rev` 与我的完全一致（`c20a44a40ab9`），并进一步确认
> 该 bundle 内含面板文案 `WinStage 暂存待审` / `批准全部` / `拒绝全部` / `ConversationComposer` 等
> —— 证据：`.t\dsh2\browser\raw\r2-dsh-boot-parsed.json`、`r2-winstage-client-bundle.js`。
> 注意其口径是"**下发了**"；"**渲染了**"仍属 T4 的 `[未实测]`（本机无可用 Chromium，见 T4 小节）。

> 时间线澄清（避免误记功）：我**没有**重启 3081。3081 的重启与同步由 T1 执行；我按硬约束只做了只读 HTTP。

---

## 3. F2-C7 —— 跨工作区串台（`client.js`）

### 3.1 缺陷与改法

- 旧代码 `client.js:176`：`const root = configValue.workspaceRoot || workspaceRoot`，而 `workspaceRoot`
  来自 `:200-204` 的 `owner?.session?.cwd`。插件 Config 的 schema 默认值是 `''`（`schema.js:159-162`），
  所以"没显式配置"就会走这条回退；再叠加 `workspaceFiles.read` 的 `locateFile()` **不做 contains 校验**
  （`dsh-api-workspace-files\lib\index.js:588-608`），于是面板会去读**另一个工作区**的 `.dshstage/review.json`。
- 改后（行号为改后）：
  - `:130-141` 新增 `sameRoot(a,b)`：纯字符串归一（Windows 大小写/尾分隔符/分隔符方向），**零 IO**（`select` 必须是纯函数）。
  - `:149-157 routeOf()`：新增自校验 `if (!sameRoot(snapshot.workspaceRoot, store.state.workspaceRoot)) return null`。
    `review.json` 自带 `workspaceRoot`（`review-service.mjs:162`）⇒ **不用额外读盘**就能判定。
  - `:206` `const root = typeof configValue.workspaceRoot === 'string' ? configValue.workspaceRoot.trim() : ''`：
    **删掉 `|| workspaceRoot`**。
  - `:207-210` `root` 为空 ⇒ `publish({ status:'idle', snapshot:null })`，**一次读都不发起**。
  - `:213-216` 读到后二次自校验（同 §3.1 第二条），不一致就丢弃为 idle。
  - `:230-238 observe()`：**删掉**记录 `owner.session.cwd` 的那段。

### 3.2 断言：跑了**真的 `client.js`**，并用改动前的备份做对照

`f2-client-c7.mjs` 在 Node 里给最小 `window.__ModuleLoader__` + `require('react')` 替身，真的调
`factory(require)`、真的 `apply(ctx)`，从注册契约里取 `conversation.composer.select`，再用桩
`ctx.remote.workspaceFiles.read` 喂快照。`[实测]` 结果（7/7 PASS）：

```
PASS  C7-a-selfcheck-rejects-foreign-snapshot   → matched=null（读的是自己的根，但快照声明别处 ⇒ 不接管）
PASS  C7-a-control-old-code-would-take-over     → 改前备份：matched≠null（对照组证明断言有判别力）
PASS  C7-b-empty-config-never-reads-session-cwd → matched=null 且 readCallCount=0（**一次都不读**）
PASS  C7-b-control-old-code-crossed-workspaces  → 改前备份：读了 C:\...\WinStageSandbox\.dshstage\review.json
                                                   （**项目根**，串台复现）
PASS  C7-c-matching-root-still-takes-over       → 根一致 + pending ⇒ 正常接管（没有过度收紧）
PASS  C7-d-case-insensitive-root-match          → 大小写/尾分隔符差异不误杀
PASS  C7-e-not-pending-no-takeover              → pending=false 仍不接管（原语义未破坏）
```

`C7-b` 那两条就是 T2 §4.4 判别实验的自动化版本：**改前备份确实越界读了项目根那份 `pending:true` 的快照**，
改后不但不接管，而且连读都不读。

**T4 给出的二值界面判别式（部署后可直接复用）**：项目根 `.dshstage\review.json` 至今仍是
`pending:true` 且指向 `.t\staged-demo.txt`（与 3081 隔离那份的 `stage-probe.txt` / revision 2 完全不同）
⇒ 面板一旦能显示，看它列出的文件名即可判定 F2：显示 `stage-probe.txt` = 根正确；
显示 `.t\staged-demo.txt` = 跨工作区泄漏复现。证据：T4 小节与 `.t\dsh2\T4-browser-report.md`。

---

## 4. F2-C8 —— 配置漂移（`host.config.workspaceRoot` vs `fs.config.cwd`）

### 4.1 改法

- `dsh-plugin\cordis.patch.yml:44` 给 host 行的 `workspaceRoot` 挂 YAML 锚点 `&winstageRoot`；
  `:56` fs 行的 `cwd`、`:58` fs 行的 `workspaceRoot` 都写成 `*winstageRoot` ⇒ **结构性单源**（改一处即三处同改）。
- `dsh-plugin\staging-fs.mjs:90-97` 新增 `sameRoot()`（走 `canonical()` 归一 8.3 短名/链接，再按 Windows 大小写不敏感比较）。
- `dsh-plugin\staging-fs.mjs:147-168` 构造函数内 fail-closed：**两键都给了且不一致** → `throw`（`code = 'FS_STAGE_ROOT_DRIFT'`），
  与 `:58-64` 既有的"拿不到契约就不注册任何 fs 提供方"同风格（普通 `Error` + 可判别 `code`）。

### 4.2 为什么"能透传到构造函数"这件事必须实测

如果基类 `Config` 会把未知键剥掉，则我加的 fail-closed 就是**死代码**。`[实测]`：
`dsh-plugin\f2-c8-root-drift.mjs` 走 `cordis\lib\index.js:956-961 resolveConfig()` 的**真实代码路径**
（`Config['~standard'].validate(config).value`）：

```
PASS  C8-loader-passes-key-through
      {"validated":{"cwd":"C:\\cwd-A","diffBasisMaxBytes":10485760,"workspaceRoot":"C:\\root-B"},"issues":null}
```

（`@deepseek-ai/dsh-fs-local` 的 `Config` 是 schemastery 对象 —— own keys `type,meta,toString,dict` —— 不剥离未知键。）

### 4.3 断言（8/8 PASS）

```
PASS  C8-patch-same-value       host.workspaceRoot === fs.cwd === fs.workspaceRoot（同一个字面值）
PASS  C8-patch-anchor-present   源码里存在 &winstageRoot / *winstageRoot 锚点对
PASS  C8-before-had-no-guard-key 改动前备份的 fs.config 只有 cwd、无锚点（改动前状态）
PASS  C8-loader-passes-key-through（见上）
PASS  C8-drift-throws           两键不一致 → throw，code=FS_STAGE_ROOT_DRIFT
PASS  C8-equal-ok               两键相同 → 正常构造
PASS  C8-cwd-only-ok            只给 cwd → 正常构造
PASS  C8-case-insensitive       同一目录不同大小写 → 不算漂移
```

### 4.4 ⚠ 已知限制（Lead 指出，我核对了源码并**改正了原先写错的注释**）

`cordis-plugin-include\lib\index.js:99-102` 对 `config` 是**整体替换**（`target[key] = value`），
**不是深合并**。因此：

- 若 profile 覆盖层**只重述 `cwd`**，该行最终 config 就是 `{ cwd }` ⇒ `workspaceRoot === undefined`
  ⇒ fail-closed 判据的**第一个合取项恒假** ⇒ **守卫在该实例上完全不触发**；
  同时 bundle 补丁里由锚点提供的 `fs.config.workspaceRoot` 也被**整段绕过**，
  "结构性同源"退化成"两个恰好相等的字面值"。
- 这是**空转**，不是"正常形态"。我最初在 `staging-fs.mjs` 的注释里把它写成了后者，Lead 指出后
  我已把注释改正为显式的 ⚠ 已知限制（含源码行号与后果），以免后来者误以为守卫生效。
- **现状**：T1 已在 `.t\dsh2\home\profiles\dsh2\cordis.patch.yml` 的 `winstage-fs` 行补上
  `workspaceRoot: '...\.t\dsh2\ws'`（与 `cwd` 同值）⇒ 该实例上守卫**开始真正生效**。
- 遗留风险（`[实测]`+`[引用]`，供 Lead 决定是否回写文档）：这条限制是**通用**的 ——
  任何"只重述部分 config 键"的 profile 覆盖层都会让 bundle 补丁里**其余键**静默消失（启动期不报错）。
  3081 实测踩到的正是这个形态。

---

## 5. F3 —— `stageOutside` 默认收紧为 `deny`

### 5.1 改法

- `dsh-plugin\fs-entry.mjs:21`：`process.env.WINSTAGE_STAGE_OUTSIDE === 'direct' ? 'direct' : 'deny'`
  ⇒ 未设 / 空 / 垃圾值一律 **deny**（fail-closed），只有显式 `=direct` 才放开。
- `dsh-plugin\staging-fs.mjs:128`：`options.stageOutside === 'direct' ? 'direct' : 'deny'`。
- `:292-297 outsideWrite()`：保持既有实现（抛 `FsError`，`code = 'FS_SANDBOX_DENIED'`），**没有新造第二个码**，
  并补了"判别式"注释。

### 5.2 断言（7/7 PASS）+ Lead 要求的"同一操作在限制前后的原文"

`f3-outside-default.mjs`，全部在会话工作区内的独立根里做（暂存根 `.t\dsh2\fix-asserts\f3-ws`，
"工作区外"目标 `.t\dsh2\fix-asserts\f3-outside\**` —— **仍在外层沙箱允许写的范围内**，
所以测到的是**插件自己的行为**，不是外层边界）：

**G 组：同一个目标路径、同一个操作，限制前 vs 限制后（`[实测]` 原文）**

```json
{ "before": { "mode": "stageOutside:'direct'", "threw": false, "realFileExists": true,
              "realFileText": "same-operation\n", "errorMessage": null },
  "after":  { "mode": "default (deny)", "threw": true, "code": "FS_SANDBOX_DENIED", "isFsError": true,
              "errorMessage": "cannot write \"C:\\...\\f3-outside\\g-same-operation.txt\": outside the staged workspace root",
              "realFileExists": false } }
```

**E 组：判别证据 —— "插件抛的码" vs "外层沙箱/后端抛的码"（`[实测]` 原文）**

| 来源 | 触发方式 | 原文 | `instanceof FsError` | 分类器判定 |
|---|---|---|---|---|
| **插件自己的拒绝** | 默认 `deny` 下写暂存根之外 | `cannot write "…\a-default.txt": outside the staged workspace root`（`code=FS_SANDBOX_DENIED`） | **true** | `plugin-deny` |
| **外层 DSH 沙箱** | 写会话工作区之外的 `C:\Users\Administrator\Desktop\winstage-outer-boundary-probe.tmp` | `EPERM: operation not permitted, open 'C:\Users\Administrator\Desktop\winstage-outer-boundary-probe.tmp'`（`code=EPERM`） | **false** | `not-plugin-deny(EPERM)` |

⇒ 二者在 `error instanceof FsError && error.code === 'FS_SANDBOX_DENIED'` 这一判别式下**完全分开**：
受限会话里看到 `EPERM` **不会**被误判成"插件生效"。外层那条是**真实**观测（不是合成对象），
写成功后我立即删除了该探针文件，未在用户桌面留垃圾。

**D 组：env 开关（翻转后）**

```
unset → FS_SANDBOX_DENIED   '' → FS_SANDBOX_DENIED   'DIRECT' → FS_SANDBOX_DENIED
'deny' → FS_SANDBOX_DENIED  'direct' → 成功落真实磁盘
```

**C 组（对照）**：默认 `deny` 下写**暂存根之内**仍只进暂存树、真实磁盘无文件 ⇒ 没有把正常暂存写坏。

**A/B 组**：默认即 deny；显式 `direct` 仍能放开（opt-out 保留）。

---

## 6. F4 —— `watch()` 覆写（S7）

### 6.1 改法（`dsh-plugin\staging-fs.mjs`）

- `:318-341 watch(target, changed, signal)`：
  `const close = await super.watch(...)` 保留真实磁盘语义；工作区外的 target 直接返回 `close`（不登记）；
  工作区内则以 `{ rel, isDir, changed }` 登记进 `this.watchers`（`:171` 构造时初始化为 `Set`），
  返回的 disposer 先摘观察者再 `close()`。
  `isDir` 判定用 `super.stat()`；根 `''` 记为目录。
- `:344-360 notifyStagedChange(rel)`：判定与**超类逐字对齐**（`dsh-fs-local\lib\index.js:731-739`）：
  **目录** target 只对**直接子项**（`dirname(changedRel) === entry.rel`，根用 `'.'` 归一）通知；
  **文件** target 只对**该文件本身**（`changedRel === entry.rel`）通知。
  **任何异常在此吞掉并记日志** —— 写路径绝不能因为"通知"失败而失败。
- 调用点：`:260`（`writeText` 的暂存分支，`afterMutation('dsh-write')` 之后）、
  `:286`（`editText` 的暂存分支）。

### 6.2 断言（`f4-watch.mjs`，7/7 PASS）

| 断言 | 结果 | 说明 |
|---|---|---|
| A 暂存写入**必须**触发失效 | `fileEvents: 1` | 修前 P1 实测为 `0` |
| A2 目录**直接子项**的暂存写入触发 | `dirEvents: 1` | |
| B 真实磁盘写入**仍然**触发（超类未被牺牲） | `{1,1} → {2,2}` | 两个观察者都增 |
| C 精度①：**兄弟文件**的暂存变更**不得**通知 file target | `fileEvents: 0` | 对齐 `ignored/entry===path` |
| D 精度②：**孙辈**的暂存变更**不得**通知 dir target | `dirEvents: 0` | 对齐 chokidar `depth:0` |
| E `close()` 之后不再通知 | `afterClose=2 → 2` | 观察者确实被摘掉 |
| F 投影面未回归 | 投影=`v3-after-close`，真实磁盘=`v2-real-disk` | |

**残余边界（如实标注，不是承诺）**：**跨进程**改动（CLI / 另一个 DSH 实例写同一份暂存树）
仍然不会触发 —— 超类的本地 chokidar 观察者也看不到。这条已写进 `staging-fs.mjs` 文件头与 `watch()` 的 JSDoc。

---

## 7. 故意**没有**改的

| 项 | 为什么不改 | 谁负责 |
|---|---|---|
| **S1（shell 写入不经暂存）** | T2 判定本机**不可能实现也不可能验证**（依赖受限令牌，R6）；正确交付是文档标注"未提供 + 前提 = 不受限会话"。我**未碰** `provider.mjs`。 | Lead 回写文档 |
| `provider.mjs` / 不存在的 `bridge.mjs` | 不在授权改动面；仅作为"S1 未接线"的证据引用：`provider.mjs` 全仓无人引用，且它 import 的 `bridge.mjs` **文件不存在**。 | Lead / 文档 |
| **C-5 首屏时序窗口**（`store.publish()` 不 bump chain 槽位版本） | Lead 决策：先不动，等 T4 在真实浏览器里给出"只有 F1 修好后、不刷新/不交互是否 N 秒内出现面板"的实测，再决定要不要修。 | **待 T4 判定** |
| `tests/**`、`src/**`、`docs/**`（除本报告与 `## T3` 小节） | 硬约束 | — |
| `.t\dsh2\home\**`（含 T1 的 profile 覆盖层） | 硬约束（T1 写范围）；我只**报告**了断言陷阱，由 T1 修改 | T1 |

---

## 8. 回滚手册（每处改动都可回滚）

备份位置：`.t\dsh2\fix-backup\`。**回滚 = 一条 `Copy-Item`**：

```powershell
Set-Location 'C:\Users\Administrator\Desktop\WinStageSandbox'
Copy-Item .t\dsh2\fix-backup\cordis.patch.yml dsh-plugin\cordis.patch.yml -Force  # 同时撤 F1 + F2-C8
Copy-Item .t\dsh2\fix-backup\client.js        dsh-plugin\client.js        -Force  # 撤 F2-C7
Copy-Item .t\dsh2\fix-backup\staging-fs.mjs   dsh-plugin\staging-fs.mjs   -Force  # 撤 F2-C8 守卫 + F3 默认 + F4 watch
Copy-Item .t\dsh2\fix-backup\fs-entry.mjs     dsh-plugin\fs-entry.mjs     -Force  # 撤 F3 env 默认
```

| 文件 | 改动前 SHA256（= 备份） | 仅 F1 版本 | **最终** SHA256 |
|---|---|---|---|
| `dsh-plugin\cordis.patch.yml` | `2BF6FB7E459E015AEF46586B7F5E4E67CDCE09C4D159365FDE2D08ECEF9125EF` | `64834DDAC5A02E310DB2158212AC0CBBF91478747705CC3ED99CBF673277810A` | `821C6FFC573F8098F94EA8BC396988858C51F751FCB227CCE38DE73BBD66859B` |
| `dsh-plugin\client.js` | `FF30973146FB57B810CC96D9F5C8445CB7184C799292A4AE9A5867D26311FE97` | — | `D210068E69F74A2A5998C8BC41A6DEF269A2484B6594E4A5A0997B2E5B1D70F6` |
| `dsh-plugin\staging-fs.mjs` | `D2EDBDBB4E3EC8C979471F45F50B6E1C9260CEEF1FF9EA2BAD93E9C2577D5679` | — | `ED3A68AA69C81905ABE4656B235D1346814A570FCF6A8D3EA27F8233BAE2128E` |
| `dsh-plugin\fs-entry.mjs` | `9B807134F9FB87BAD6622950453ADF08EB744BB0D5626CC04C897DCB4549CC1A` | — | `807F15030C4A525AB34F7F876DBCB961E7A1AB0C135177CD3B8A8A13234C3863` |

- **更细粒度的回滚**：`cordis.patch.yml` 的**仅 F1 版本**（即目前 3081 上部署的那一份）也已存档为
  `.t\dsh2\fix-backup\cordis.patch.yml.f1-only-deployed-on-3081`，可用它只撤 C-8 的锚点而保留 F1。
- 回滚后必须重跑：`.t\dsh2\fix-asserts\run-all.cmd` 与 `.\autotest.cmd --skip-audit`。
- **本次未新增任何错误码**（沿用既有 `FS_SANDBOX_DENIED`）；唯一新增的 `code` 是
  `FS_STAGE_ROOT_DRIFT`（配置漂移 fail-closed），它是普通 `Error` 上的附加属性，不改变既有错误类型体系。

---

## 9. 回归门 `[实测]`

```
.\autotest.cmd --skip-audit    2026-09-28T06:01:43.834Z
  [ PASS ] selftest            51 ok /  0 bad
  [ PASS ] e2e-flow            16 ok /  0 bad
  [ PASS ] struct-layout       24 ok /  0 bad
  [ PASS ] appcontainer-layout 27 ok /  0 bad
  [ PASS ] resolve-exec        19 ok /  0 bad
  [ PASS ] executor-stub       72 ok /  0 bad
  [ PASS ] audit-parse         23 ok /  0 bad
  [ PASS ] meta-runner          4 ok /  0 bad
  [ PASS ] diag-bindings       14 ok /  0 bad
 总判定: PASS   套件 9 通过 / 0 失败 / 0 跳过   断言 250 ok / 0 bad    退出码 0
```

与 T2 基线（`.t\dsh2\probe\out\b0-autotest-baseline.txt`：9 套件 / 250 断言 / exit 0）**逐项一致**。
最后一次跑是在我最后一次改动 `staging-fs.mjs`（注释）**之后**，即跑的是**最终字节**。

`.t\dsh2\fix-asserts\run-all.cmd` 也在最终字节上复跑：`RUN-ALL: ALL ASSERTIONS PASSED`（退出码 0）。

---

## 10. 跨人依赖与待验证（**不夸大**）

1. **F2/F3/F4 已在 3081 上部署**（`[实测]`：`cordis.patch.yml`、`staging-fs.mjs`、`fs-entry.mjs`
   的部署副本与仓库**逐字节一致**），F1 亦已**活体验证通过**（见 §2.6）。
   **T5b 之后仍需一次 sync + 重启**，因为 `client.js` 与 `host-plugin.mjs` 尚未部署 ——
   逐文件对照见 **§12.4**。
1b. **F2 的"界面可见性"验收还额外被 T4 的浏览器阻塞挡住。** `[实测]`（T4 小节）本机无可用 Chromium
   （Edge 的 Mojo 依赖命名管道，而本沙箱禁止命名管道 ⇒ 结构性阻塞）⇒ 面板**是否渲染**、以及
   §3.2 那个"文件名二值判别式"都还是 `[未实测]`。**我的 F2-C7 断言是在 Node 里跑真 `client.js` 拿到的
   函数级证据**（`select` 是否接管、是否发起越界读），它**不能**替代浏览器侧的可见性证据。
2. **F3 在 3081 上的活体验证有会话前提**：T2 §2.2 已证明受限会话里"工作区外写入"会先被**外层**沙箱
   以 `EPERM` 拒绝 ⇒ 3081 上无法用它观察插件 `deny`。可判定的形态是：
   (a) 插件专属码的断言（任意会话可跑，我已给出）；(b) `WINSTAGE_STAGE_OUTSIDE=direct` 的前后对照。
3. **F4 的跨进程边界**：同机另一个进程写同一份暂存树不会触发通知（已如实标注，未承诺）。
4. **C-5（首屏时序窗口）**：`[未实测]`，**待 T4** 用真实浏览器判定；我按 Lead 决策**未改代码**。
5. **3080 用户实例**：F1 的改动在仓库里已就绪，但用户实例生效需用户自己重启；`C:\Users\Administrator\.dsh`
   与 3080 实例全程未被改动。
6. **`.t\dsh2\home\profiles\dsh2\cordis.patch.yml` 的 fs 行 `workspaceRoot`** 由 T1 补齐后，
   §4.4 的守卫在 3081 才真正生效。若 T1 后续调整该文件的 config 重述范围，需重新确认守卫是否仍被覆盖。

---

## 11. 证据文件索引（全部为 T3 产出）

| 文件 | 内容 |
|---|---|
| `.t/dsh2/fix-asserts/run-all.cmd` | 一条命令复跑全部断言（顺序调用，无管道，适配本沙箱） |
| `.t/dsh2/fix-asserts/f1-static.mjs` / `f1-static.json` | F1 静态：真源码 `exactPackageSpecifier` + 真 `applyEntryPatches` + 真 js-yaml；含 profile 断言陷阱 A4 与 apply-once A3 |
| `.t/dsh2/fix-asserts/f1-live-3081.mjs` / `f1-live-3081.json` | F1 活体：`__DSH_BOOT__` 原始 JSON 片段 + bundle 路由 200 + PENDING-RESTART 区分 |
| `.t/dsh2/fix-asserts/f2-client-c7.mjs` / `f2-client-c7.json` | F2-C7：真 `client.js` + 改动前备份对照（串台复现 vs 被挡住） |
| `.t/dsh2/fix-asserts/f2-c8-root-drift.mjs` / `f2-c8-root-drift.json` | F2-C8：补丁锚点同源 + loader 透传实测 + 漂移 fail-closed |
| `.t/dsh2/fix-asserts/f3-outside-default.mjs` / `f3-outside-default.json` | F3：默认 deny / opt-out / env fail-closed / **限制前后同一操作原文** / 插件码 vs 外层 EPERM |
| `.t/dsh2/fix-asserts/f4-watch.mjs` / `f4-watch.json` | F4：暂存触发 + 真实磁盘仍触发 + 两条精度 + close 摘除 + 投影未回归 |
| `.t/dsh2/fix-backup/` | 4 个原文件 + `cordis.patch.yml.f1-only-deployed-on-3081`（回滚用） |

> 我自己新增的隔离目录（不属于别人的写范围）：`.t/dsh2/fix-asserts/{f3-ws,f3-outside,f4-ws,c7-ws-a,c8-root-*}`、
> `.t/dsh2/fix-backup/`。T2 的 `.t/dsh2/probe/**` 全程**只读**，未改动（P1 探针是被**复制**到
> `fix-asserts/f4-watch.mjs` 后扩展的）。T4 的 `.t/dsh2/browser/**` 同样**只读**。

---

## 12. T5b —— 浏览器实测炸出的三个缺陷（B / A / C）

来源：`task-5` 与 `.t\dsh2\T4-browser-report.md` §14。T4 已确认**面板能出现**（截图
`.t\dsh2\browser\r2-headless-panel-visible.png`，AX 11 命中），但三个控件无效；阴性对照
（`全选` / `清空选择` 可用）说明 React `onClick` 通路本身正常。

### 12.1 缺陷 B（致命）：命令根本没注册进会话命令面

**根因（`[实测]` + `[引用]`）**：`host-plugin.mjs:260` 给 `dsh-commands` 的 `register()` 传的是
`input: { placeholder: … }`，而真校验器要求的是 **`hint`**：

- `node_modules\@deepseek-ai\dsh-commands\lib\index.js:154-163 normalizeDefinition()`：
  `if (typeof rawInput !== "object" || rawInput === null || !("hint" in rawInput) || typeof rawInput.hint !== "string") throw new TypeError('command "…" input hint must be a string')`。
- 该 `TypeError` 在 **`for (const spec of SPECS)` 的第一次迭代**就抛出 ⇒ 整个
  `ctx.inject(['commands'], …)` 回调失败 ⇒ **6 条命令一条都没注册**（不是"某个字段没生效"，
  而是"整族消失"）。平台插件的正确写法可对照 `dsh-permission-presets\lib\index.js:211`
  （`input: { hint: "<preset>" }`）。
- **这正是"假证据"为什么危险**：T1 的 `commands=6` 是在进程内直接调 `registerCommands()` 得到的，
  它把 `definition` 塞进 mock 数组，**绕过了 `normalizeDefinition()`** ⇒ 一个必然抛错的写法
  在 mock 下"看起来注册了 6 条"。本轮我**没有**重演：断言走真 `CommandRuntime`。

**为什么不是"接线层错了"（`[实测]`）**：`ctx.inject(['commands'], cb)` 在根 ctx 上**足够**：

- cordis `inject(inject, callback)` 就是 `plugin({ inject, apply })`（`cordis\lib\index.js:1600-1606`），
  真的建一个等依赖的子 fiber；平台自带插件用的是**同一个模式**
  （`dsh-permission-presets\lib\index.js:206`、`dsh-plan-mode\lib\index.js:180`），而它们的
  `permission` / `plan` 命令**确实出现在** T4 实测的 `commands/list` 里。
- ⇒ 任务要求回答的那条结论：**`ctx.inject(['commands'], cb)` 在根 ctx 上足够；本缺陷与挂载层无关，
  是定义本身不合法。**

**改法（2 处）**

1. `dsh-plugin\host-plugin.mjs:260`：`placeholder` → **`hint`**（并留下源码行号注释）。
2. `dsh-plugin\host-plugin.mjs:321-337`：把注册包进 `try/catch` 并 **error 级日志**
   （`命令注册失败：…（/winstage* 将不可用）`）。理由：这一族命令消失时**原本毫无提示**，
   属于"假安心"；失败必须显式可见，且不让它影响插件其余部分加载。

**断言（`f5-commands-register.mjs`，7/7 PASS，`[实测]`）**——走**线上同一条路**
（真 `Context` + 真 `CommandRuntime` + 真 `ctx.inject`）：

```
PASS  B0-real-service        真 CommandRuntime 可在进程内构造并提供 commands（list 初始为 []）
PASS  B1-registered-online-path  修后 list() = [winstage, winstage-approve, winstage-diff,
                                 winstage-refresh, winstage-reject, winstage-status]（6/6）
PASS  B2-no-registration-failure 新的"失败可见"分支未被触发（无 命令注册失败 日志）
PASS  B3-distinguishable-from-unknown  find('winstage-status') 有定义；find('definitely-not-a-command-xyz') 为 undefined
                                 ⇒ **正是 T4 用的那条判别式**
PASS  B4-control-before-had-zero  CONTROL：改动前备份经**同一真实路径**注册 **0** 条
PASS  B5-control-before-threw     CONTROL：改动前的报错原文 = TypeError: command "winstage" input hint must be a string
PASS  B6-no-placeholder-field     静态守卫：不再出现 input.placeholder
```

**只能由 T4 保证的部分**：`/winstage status` 经**浏览器里的 remote 通路**返回 `value` 且与
`/definitely-not-a-command-xyz` 可区分（`raw/cmd_discriminate.py`）；以及点击「批准所选」后
`review.json`/真实磁盘真的变化（`raw/interact.py approve`）。

### 12.2 缺陷 A（首屏不挂载）与 C（收起无效）—— 同一根因

**根因（`[引用]`，机制已逐行核实）**：`conversation.composer` 是 **chain** 槽位：

- 渲染锚点用 `useSyncExternalStore(host.subscribe(slotKey, fn), () => host.getVersion(slotKey))`
  订阅**槽位版本**（`dsh-client-ui-renderer\lib\client.js:1097`），并在渲染时对每个条目调
  `entry.select(ownerProps)`（同文件 `:1163`）。
- ⇒ `select` **只在渲染时求值**。模块级 `store` 变了（快照到达 / `dismissed` 被设置）
  **不会**让它重跑：订阅 `store` 的只有"已经渲染出来的面板自己"
  （`client.js` 的 `useStoreState`）⇒
  - **A**：页面加载时 store 还是 `idle`（`select` 返回 null）；随后快照到达也无人重跑
    `select` ⇒ 面板不出现，直到 composer 因**无关原因**重挂（T4 实测：点「新会话」立刻 11 命中）。
  - **C**：点「暂时收起」改了 `store.dismissed`，判定却写在槽位 `select` 里 ⇒ 收不起来。

**为什么不用备选方向 a / b（`[引用]`）**

- **方向 b（`ui-slots` 的 store 座位）——不可行**：`SlotCore.register` 的 `options.store` 只是
  **scope handle**（"one handle, one scope"），用于把子槽位实例绑到某个 scope；
  `dsh-client-ui-slots\lib\index.js:82-86 / :195-199` 全文没有"store 变更 → `markDirty`"的路径
  ⇒ 它**不是**响应式状态座位。T2 当初"在 SlotCore 里没找到 store→markDirty"是对的。
- **方向 a（只依赖 ownerProps）——第三方插件做不到**：ownerProps 由宿主
  （`dsh-client-ui-conversation`）组装，插件无法往里加字段；内置审批面板能用是因为
  `pendingInteraction` 本来就在会话标准套件里。

**采用的通道（方向 c，只用公开 API）**：`SlotCore` **没有**公开的 invalidate/touch API
（方法清单见 `dsh-cordis-client-runner\lib\client.js:2156` 的 `SlotCore` 声明字符串）；
唯一公开的版本推进通道是 **`register()` 与它返回的 disposer** —— 各自 `markDirty()` 一次
（`dsh-client-ui-slots\lib\index.js:223` / `:240`），而 `markDirty` 会 `rec.version += 1`
并异步通知 uSES 订阅者（`:553-563`）。

⇒ 做法（`dsh-plugin\client.js:711-786`）：**仅在"是否应当接管"发生跃迁时**重挂一次注册：

1. 把接管判据抽成**唯一实现** `winstageElection(sessionId)`，`routeOf`（渲染期）与轮询器新增的
   `shouldElect()`（无渲染期）**共用**它，杜绝判据漂移；
2. `ctx.slots.inject('conversation.composer', …)` 的回调里：`remount()` 先撤旧注册再注册；
   订阅 `store`，当 `shouldElect()` 与"上次实际选举结果"不同时 `remount()`；
   回调返回 `off()` + 撤销注册的**同步 disposer**（这正是 `slots.inject` 的契约，
   `dsh-cordis-client-runner...` 的 `slots.inject` 文档：*"Callback effects are synchronous disposers"*）。
3. 归属安全：`ctx.slots.register` 的 `this.ctx` 由**从哪个 ctx 读到 `.slots`** 决定
   （`cordis\lib\index.js:673-675 getTraceable(ctx, …)`）⇒ 闭包里的 `ctx` 恒为本插件 ctx，
   重挂出的 effect 仍归本插件 fiber（插件卸载即撤）。
4. **防 churn**：稳态下 `store.publish` 每 1.5s 发生一次，但接管状态不变 ⇒ 不重挂
   ⇒ 轮询**不会**清掉面板里的勾选/展开状态。
5. `observe()` 在无会话时**清空**记住的 `sessionId`（原来只增不减）：否则 `shouldElect()` 会与
   `routeOf()` 打架，导致"应当接管"与"渲染器判定不接管"之间每 1.5s 来回重挂。

**断言（`f6-slot-election.mjs`，12/12 PASS，`[实测]`）**——真 `client.js` + 如实模拟 ui-slots
版本语义的 `ctx.slots` 替身（`register`/disposer 各 +1 版本，对应 `:223`/`:240`）：

```
PASS  A1-snapshot-arrival-bumps-version  快照到达后**槽位版本 +2**（初始挂载 + 跃迁重挂）
PASS  A2-remount-on-transition           跃迁只多花**一次**注册（1 → 2），不是周期性重挂
PASS  A3-select-would-elect              store ready 后 select() 返回匹配（面板会接管）
PASS  A4-no-churn-in-steady-state        再跑 8 次 refresh（每次都 store.publish）注册数仍为 2
PASS  C1-dismiss-bumps-version           执行**真实组件**的「暂时收起」onClick → 槽位版本 +2
PASS  C2-dismiss-de-elects               该点击后 select() 返回 null（面板卸载）——一条通道同时修好 A 与 C
PASS  A/C3-entry-stays-live              重挂后恰好 1 个 live entry（无孤儿/重复注册）
PASS  A5-no-session-parity               无会话时 shouldElect() 与 select() 同为 false，且后续 refresh 不再重挂
PASS  CONTROL-A-old-code-never-bumps     CONTROL：改动前备份在快照到达后版本**不变**（0）⇒ 渲染器永不被告知
PASS  CONTROL-C-old-dismiss-does-not-de-elect  CONTROL：改动前备份点收起后版本不变（T4 实测面板不消失）
PASS  S1-channel-present / S2-single-election-predicate  公开 API + 单一判据的静态守卫
```

**只能由 T4 保证的部分**：面板**真的**在页面加载/刷新时出现（`raw/mount_probe.py`：
attach 后 `PANEL_HITS` 立即/短期内 > 0，无需点「新会话」）；点「暂时收起」后 AX 命中归零、
刷新后仍收起（`raw/interact.py dismiss`）。我的断言证明的是"失效通道被触发"这一**客户端机制**，
它不渲染 React、不产生像素。

### 12.3 T5b 改动与 SHA256

| 文件 | 改动前 SHA256 | 改动后 SHA256 | 回滚 |
|---|---|---|---|
| `dsh-plugin\host-plugin.mjs` | `6C80E0823E7D8A73AAEE512A743C8B8F9451445D6AEA27511FD75125F829DD63` | `F18AB4EFDDE774331AF3BC0519F8B46EFA6ADEE41DC46D252A80C4C15EE55AE6` | `Copy-Item .t\dsh2\fix-backup\host-plugin.mjs dsh-plugin\host-plugin.mjs -Force` |
| `dsh-plugin\client.js` | `D210068E69F74A2A5998C8BC41A6DEF269A2484B6594E4A5A0997B2E5B1D70F6` | `5F8AA910328B6E4B7E13D8240718EDF511F0A1B4D26311F82833802EC8EDC41C` | `Copy-Item .t\dsh2\fix-backup\client.js.t5b-before dsh-plugin\client.js -Force` |

（改动前基线另存为 `.t\dsh2\fix-backup\client.t5b-before.js`，供断言脚本直接 import 做对照。）

### 12.4 部署状态（`[实测]`，2026-09-28T09:10Z）

| 文件 | 仓库（本报告定稿） | 3081 已部署 | 是否需要 sync |
|---|---|---|---|
| `cordis.patch.yml` | `821C6FFC…` | `821C6FFC…` | 否（F1/F2-C8 已在跑） |
| `staging-fs.mjs` | `ED3A68AA…` | `ED3A68AA…` | 否（F2-C8/F3/F4 已在跑） |
| `fs-entry.mjs` | `807F1503…` | `807F1503…` | 否 |
| **`client.js`** | `5F8AA910…` | `D210068E…`（T3 版） | **是**（A/C 修复） |
| **`host-plugin.mjs`** | `F18AB4EF…` | `6C80E082…`（原始版） | **是**（B 修复） |

⇒ **只需 sync + 重启一次**，然后由 T4 用 `raw/mount_probe.py`、`raw/cmd_discriminate.py`、
`raw/interact.py` 复测。
另：`f1-live-3081.mjs` 现在会优先取 `logs/dsh2.out.log` 里**最后一条** `?token=`（令牌每次重启轮换，
`READY.json` 会过期 —— T4 §4.1 已指出），并对多个候选逐个试到装上 cookie 为止。

### 12.5 本轮**没有**改的（与 §7 一致）

- **C-5 首屏时序窗口**：已被 A 的修法**实际覆盖**（快照到达即触发一次槽位重选举），
  因此不再需要 Lead 当初"等 T4 判定后再决定"的那条独立改动；本报告不把它单列为已修
  独立项 —— 它的因果在 A 的断言里（`A1`/`A3`）。
- 其余同 §7（S1 不改代码、`tests/**`/`src/**`/别人的 `.t` 目录一律不碰）。

---

## 13. S3b —— 三档判级与敏感内容不外泄（`task-7`）

独占文件 `dsh-plugin/review-service.mjs`。**未碰** `dsh-plugin/staging-fs.mjs`、
`src/store.mjs`、`src/workspace.mjs`（S3a）与 `dsh-plugin/client.js`（第三阶段）。
`src/**` **零改动**（理由见 §13.2）。未重启任何实例（3080/3081/3082 全程未动）。

### 13.1 三档语义：一条**短路顺序链**，不是互斥树

用户定死的三档：`normal`（工作区内）/ `outside`（工作区外）/ `sensitive`（命中敏感清单）。
关键点是**它们不互斥**：`.dshstage` 在**工作区内**，却必须同时是 `sensitive`。
因此判级实现为**有序短路链**，而不是三选一的分类器：

1. 命中敏感规则（`maskReason()`）⇒ `sensitive`（**不看在不在工作区内**）；
2. 否则不在工作区内 ⇒ `outside`；
3. 否则 ⇒ `normal`。

第二档再细分严重度，**仅对 `sensitive` 有值**：

| `safety` | 含义 | 判据 |
|---|---|---|
| `risk` | 系统/普通敏感目录 | 命中 id **不在** `DANGER_MASK_IDS` 里（如 `hosts`） |
| `danger` | **凭据或本工具自身** | 命中 id 在 `DANGER_MASK_IDS` 里（14 个），或自定义规则显式 `hard:true` |

`DANGER_MASK_IDS` 逐字取自 `MASK_CLASSES`：
`stage-store`（`.dshstage`）、`ssh`、`aws`、`gcloud`、`kube`、`git-credentials`、`npmrc`、
`dsh-home`（`.dsh`）、`dpapi`、`dpapi-user`、`browser`、`sam`、`sysvol-copy`（`ntds.dit`）、`wifi`。

因此 `external` 字段与 `risk` 档位**允许不一致**，这正是三档不是互斥树的直接后果：

```
<wsRoot>\.dshstage\staged\x.txt   →  external:false  +  risk:"sensitive"  +  safety:"danger"
C:\...\outside\.ssh\id_rsa        →  external:true   +  risk:"sensitive"  +  safety:"danger"
C:\...\outside\plain.txt          →  external:true   +  risk:"outside"    +  safety:null
stage-probe.txt                   →  external:false  +  risk:"normal"     +  safety:null
```

### 13.2 ★ Lead 的 `hard` 契约有误，已更正（留痕）

**原契约**（`task-7` 描述）："`maskReason()` 返回 `{id, reason, hard}`，
`hard===true`（或 `id===SELF_MASK_ID`）⇒ `safety:"danger"`"，并要求 `hosts` 这类"非 hard 规则"
⇒ `risk`。

**磁盘上的事实与之矛盾**（我按 Lead 要求"以磁盘为准"核过后上报，Lead 已认错并改判）：

- `MASK_CLASSES` 里**只有 `stage-store` 自己写了 `hard: true`**（`src/paths.mjs:164`）；
- 但 `maskReason()` 的内置分支是**硬编码** `return { id: rule.id, reason: rule.reason, hard: true }`
  （`src/paths.mjs:181`）⇒ **任何**内置命中都带 `hard:true`。

⇒ 若按原契约实现，`hosts`/`wifi`/`sam` **全部**会被判成 `danger`，断言⑤（`hosts`⇒`risk`）**必然失败**，
且"危险"这个概念会被稀释到所有敏感路径，二次确认也就失去意义。
**这个 bug 是断言⑤在施工中真的抓到的**（第一版实现先判 `hard`，`E`/`E2` 立刻挂）。

**Lead 决策 B（采纳）**：danger 判别留在 `review-service.mjs`，按 **id 清单**认定；
内置规则的 `hard` 字段**一律忽略**（它在内置分支里没有判别力）；
自定义规则（`options.masks`，id 不在 `MASK_CLASSES` 里）**允许**用显式 `hard:true` 抬到 danger。

**为什么不把 `hard` 语义修进 `paths.mjs`（Lead 否掉 A 方案，我同意）**：
`MASK_CLASSES` 是**安全/遮蔽清单**（决定"能不能读"），而 `normal/outside/sensitive`
是**UI 呈现分级**（决定"面板怎么画"）。把"哪些算危险"写进 `paths.mjs`，就是让安全清单承担 UI 策略 ——
以后改一处要同时想两处，且呈现语义会**隐式依赖另一个模块的元数据细节**
（正是那个 `hard:true` 硬编码把契约骗过一次）。职责留在 `review-service` 更干净。

**一个支持"零风险"的实测事实**：`hard` 字段此前**没有任何消费者**。
全仓库 `grep` 后唯一读 mask 的是 `src/workspace.mjs:141 assertReadable`，且只判 `if (mask)` 存在性
（`maskOf` 也只 `return maskReason(...)`）⇒ 语义澄清**不改变**任何遮蔽/拒绝行为。

**⚠ 由此产生的限制（显式声明，不是隐性行为）**：
**用户自定义 mask 无法自行声明 danger** —— 危险集合由插件（`DANGER_MASK_IDS`）持有而非 `paths.mjs`；
自定义规则默认只落到 `risk`，除非宿主通过 `classifyChange(change, { dangerMaskIds })` 显式指定该 id。

**漂移防护（Lead 要求"必须响"，不是 warn）**：`assertDangerIdsExist()` 在**模块加载时**执行一次，
`DANGER_MASK_IDS` 里任一 id 在 `MASK_CLASSES` 中找不到就**立即抛错**，
绝不退化成"永不 danger"。断言 `J` 用"抹掉 `MASK_CLASSES` 里的 `ssh`"真实触发过一次，恢复后重新通过。

### 13.3 ★ 安全设计决定：`safety:"danger"` 的 `diff` 默认**不写入** review.json

**风险**：`diff` 承载的是**文件内容片段**。快照 `review.json` 是工作区内的**普通文件**，
Client 用已有的 `ctx.remote.workspaceFiles.read` 直接读它并渲染进浏览器。
若把凭据/密钥片段写进去，等于**把凭据渲染到浏览器**——而且它在磁盘上还是明文的、
会被轮询、可能被日志/快照留存。

**决定（Lead 已批准）**：对 `safety:"danger"` 的条目，默认**不把内容片段写进 `review.json`**：

```jsonc
{
  "path": "…", "op": "create", "kind": "file",
  "totals": { "added": 2, "removed": 0 },   // ← 计数照给
  "diff": [],                                // ← 内容不给
  "truncated": false,                        // ← 是"有意不给"，不是"被截断"（两个语义不混）
  "external": true, "risk": "sensitive", "safety": "danger",
  "riskReason": "SSH 私钥",                  // ← 为什么敏感照给
  "note": "内容已按敏感策略省略（不把凭据/密钥片段写入 review.json）"
}
```

实现上，`risk`/`safety`/`riskReason` 在**拿到行数之前**就已判定，所以 danger 条目
**根本不会为渲染内容产生任何成本**，也不存在"先渲染再丢弃"的中间态（少一条泄漏路径）。

**保留了什么**：`path`/`op`/`kind`/`totals`/`risk`/`safety`/`riskReason`。
⇒ 面板仍能显示"哪个文件、什么操作、改了多少行、为什么敏感、是否在工作区外"，只是**看不到内容**。

**`truncated:false` 的语义**：它不是"没有更多内容"，而是"策略上有意不给"。
两者含义不同，因此**不借 `truncated` 表达省略**，另给一个 `note` 字段（只有 danger 档有这个键）。

**未泄露的验证是"整份文件"级的**：断言 `G2`/`L4` 不是检查"diff 里没有"，
而是把**落盘后的整份 review.json** 逐字搜凭据哨兵串（`PRIVATE-KEY-MATERIAL`）⇒ 搜不到。

**⚠ 列为待用户确认项（不替用户决定）**：
**是否要改成"脱敏预览"**（例如只显示行号与长度、把值替换为 `•••`、或只显示"前 3 行结构"）。
当前默认是**完全不给内容**；"给一点脱敏内容"能提升可审性，但**脱敏本身有泄漏风险**
（长度/结构/部分值都可能泄露信息，且脱敏实现出错就是真泄漏）。
**这条请用户拍板**，我不自行放开。放开点的实现位置是 `renderChange()` 里 `sensitiveOmitted` 分支。

### 13.4 非阻断提示通道 `alerts`（对应用户拍板的"只报一次、不阻断"）

用户拍板的交互模型：运行时**不弹任何东西**，只有"明确信息泄露"（`safety:"danger"`）
在运行时**报一次**；其余档运行时**一律不阻断**，批准/拒绝全部**异步**。

**Host 侧不实现任何阻塞式审批**——这既是 Lead 的要求，也是正确的分层：
Host 只负责**声明事实**，呈现与打断是 Client 的事。因此我在快照顶层加了一条
**纯数据**通道：

```jsonc
"alerts": [
  {
    "id": "cand-8f3a…:danger",          // ← 去重键：candidateId + kind
    "kind": "danger-change",
    "severity": "danger",
    "count": 2,
    "paths": ["C:\\…\\.ssh\\id_rsa", "…"],
    "message": "2 项改动命中凭据/本工具自身等敏感路径，内容已省略",
    "hint": "这是一次信息泄露风险提示，不阻断任何操作；批准/拒绝依旧异步。"
  }
]
```

**去重语义由数据本身表达，Host 不记任何状态**：`id = candidateId + ":danger"`。
同一份候选反复轮询得到**逐字相同**的 `id`（断言 `K2` 实测两次构建字节相同）⇒
Client 只要记住"这个 id 报过没有"，就能做到"报一次"而不会每 1.5s 刷新都弹；
`candidateId` 变化（用户又改了暂存树）⇒ id 变化 ⇒ 值得再报一次。
无 danger 时 `alerts: []`（断言 `K3`），**不泛化**，避免"每次都弹"变成噪声。

**为什么选"快照内声明"而不是"Host 写日志"**（我的建议与理由）：
- 日志通道无法表达"报一次"——日志是追加的，Client 不在日志主路径上，去重还得另造状态；
- 快照与 `riskCounts` **同一次原子发布**，不存在"计数说有 danger、提示没跟上"的竞态；
- Client 已经必须轮询快照才能渲染面板，**不需要新增任何通道**（`alerts` 随快照白拿）；
- 呈现方式（一次性 toast / 顶部横幅 / 仅高亮）**留给 Client**，Host 不猜 UI。

**建议第三阶段的具体做法**：Client 保存 `lastAlertId`（内存即可，不必持久化）；
`snapshot.alerts` 里出现新 `id` ⇒ 报一次并记住；`id` 相同则**不重复报**。
若希望"跨刷新也只报一次"，把 `lastAlertId` 写进 `sessionStorage` 即可。
**不建议**把 alert 做成"必须点掉才能批准"——那会变回阻塞式审批，与用户拍板的异步模型冲突。

### 13.5 实现要点（`dsh-plugin/review-service.mjs`）

- **导出（第三阶段与断言共用）**：`classifyChange(change, {workspaceRoot, masks?, dangerMaskIds?})`、
  `countRisks(files)`、`buildAlerts(files, candidateId)`、`assertDangerIdsExist()`、
  `SENSITIVE_OMIT_NOTE`、`DANGER_MASK_IDS`、`REQUIRED_MASK_IDS`、`maskEntryFor()`。
- **判级的 `external` 口径**（施工中两次被断言抓错，留下的判据）：
  1. 相对路径必须先按 `workspaceRoot` 拼接**再** `canonical()` —— 裸 `canonical()` 以进程 cwd 为基准，
     会把工作区内的相对条目误判成"外面"（断言①抓到）；
  2. 判据是 **resolved 后是否在 `isInside(workspaceRoot, …)` 内**，**不是**"路径是否绝对" ——
     `<wsRoot>\.dshstage\staged\x` 是绝对路径却在工作区内（断言④抓到）；
  3. 显式 `change.external` 布尔**优先**；两者都指向"外"时取"外"（呈现层宁可多提示一次）。
  这一口径与 `Workspace.maskOf()` 同源（都是 canonical + isInside），因此工作区内 junction
  指向宿主敏感目录时同样逃不掉（#16.6）。
- `renderChange()` 在拿到 `ws.extraMasks` 后调用 `classifyChange()`，老字段位置与含义**一个都没动**。
- `snapshot()` 顶层新增 `riskCounts` 与 `alerts`；`version` 仍为 `1`（纯增量，未破坏老读侧）。
- `note` 是**条件键**：只有 danger 档存在。面板可用 `'note' in item` 判断，不必猜空串含义。

### 13.6 断言与证据

| 断言 | 覆盖 | 结果 |
|---|---|---|
| `A` | 工作区内普通文件 ⇒ `normal` | PASS |
| `B`/`B2` | 工作区外普通文件 ⇒ `outside`（含"只给绝对路径不给 flag"形态） | PASS |
| `C` | 工作区外 `.ssh` ⇒ `sensitive` + `danger` | PASS |
| `D` | 工作区内 `.dshstage` ⇒ `sensitive` + `danger`（`external:false`） | PASS |
| `E`/`E2` | 工作区外 `hosts` ⇒ `sensitive` + **`risk`**（不是 danger）；回归点 | PASS |
| `G`/`G2`/`G3` | danger 条目 `diff:[]` + `note`、整份 JSON 搜不到凭据、`totals`+`riskReason` 照给 | PASS |
| `H`/`H2` | 老字段一个不少 + 新字段齐全、取值合法 | PASS |
| `I`/`I2` | `riskCounts` 与逐条独立统计一致；四格可同时非零 | PASS |
| `J` | 危险清单漂移 ⇒ **硬失败**（抹掉 `ssh` 实测触发） | PASS |
| `K`/`K2`/`K3` | `alerts` 恰 1 条 / id 可复现 / 无 danger 时不产生 | PASS |
| `L1`–`L6` | **真实 external 条目端到端**（S3a 已落地）：`sensitive`+`danger`、`outside`、绝对路径逐字、外部内容不外泄、alerts 覆盖工作区外、老字段齐全 | PASS |

**结果**：`stage3-classify.mjs` = **25/25 强制断言通过 / exit 0**。
证据：`.t/dsh2/fix-asserts/stage3-classify.json`（含落盘后的完整快照）、
`.t/dsh2/fix-asserts/stage3-classify.log`、`.t/dsh2/fix-asserts/stage3-review-sample.json`、
`.t/dsh2/fix-asserts/stage3-review-sample-external.json`。

**回归门**：`.\autotest.cmd --skip-audit` = **9 套件 / 250 断言 / exit 0**（与基线逐项相同，未升未降）。

### 13.7 如实说明的未测项

1. **面板实际渲染未测**（第三阶段职责）：本轮只保证**字段与取值**可供渲染，没跑浏览器、没产生像素。
2. **`danger` 的"报一次"端到端未测**：`alerts` 的**数据**已验证（含 id 稳定性），
   但"Client 真的只弹一次"属于第三阶段的 UI 行为，不在本轮证据范围。
3. **不重启实例**：`review-service.mjs` 的改动要生效需一次 sync + 重启（由 Lead 统一安排）；
   本轮未重启 3080/3081/3082。
4. **`.dshstage` 暂存为工作区内的"错位"形态**：断言⑦为了不依赖 S3a，把暂存工作区根放在
   `.dshstage` 之下。这测的是**判级与省略逻辑**，与 S3a 的路径投影是两件事
   （真实外部条目由 `L1`–`L6` 覆盖）。

---

# 14. S3a —— 暂存层支持工作区外路径（外部条目底座）

执行者：`staging-ext`（task-6）。**这是本需求的第一阶段，且是唯一的关键路径**；
第二/三阶段（判级、面板）依赖本节落地后的语义。

## 14.1 契约（用户定死，本节逐条落实）

| # | 契约 | 落地位置 |
|---|---|---|
| 1 | **彻底取消硬拒**：`FS_SANDBOX_DENIED` 那条路删掉，工作区外写入一律暂存 | `staging-fs.mjs` 删 `outsideWrite()`；`fs-entry.mjs` 默认 `'stage'` |
| 2 | **敏感路径也照暂存**（不拒绝），只打标记 | 写入面不查遮蔽表；判级交 S3b |
| 3 | `approve` 之前工作区外**真实文件一位不改** | 外部条目只落 `.dshstage/staged-ext/`；只有 `applyOneChange()` 碰真实磁盘 |
| 4 | `approve` 按**原始目标**落盘（绝对→绝对；相对→`workspaceRoot` 下） | 清单键 = 规范化绝对路径，`Store.realPath()` 对绝对键原样返回 |

## 14.2 根因（改动前）

- `dsh-plugin/staging-fs.mjs:202 relOf()` 对工作区外返回 `undefined` ⇒ `:300 outsideWrite()`
  一律拒绝（`FS_SANDBOX_DENIED`）或（更早）直通真实磁盘，**根本不进暂存**。
- `:241 / :276` 的 `writeText`/`editText` 在 `rel === undefined` 时直接委托超类。
- `src/store.mjs:267 stagedPath()` / `:272 realPath()` 只认相对路径（`:274` 还显式拒绝 `..`），
  绝对路径拼进 `staged/` 会产生含 `:` 的非法文件名 ⇒ 外部条目**无处可放**。
- `src/workspace.mjs` 的 `relative()` 对工作区外抛 `PATH_OUTSIDE_WORKSPACE`，
  写入/删除/改名/枚举/差异**全部无法表示**外部条目。

## 14.3 改动清单（文件:行 为改动后的行号）

| 文件 | 关键位置 | 改动 | SHA256 前 → 后 |
|---|---|---|---|
| `src/store.mjs` | `isExternalKey()` / `externalKeyDigest()` / `externalLeaf()`（:73-99）；`stagedExtDir`（:180,182）；`stagedPath()`（:305-317）；`realPath()`（:325-333） | 新增"外部条目"键模型：键 = 规范化绝对路径 + `external:true` 标记；物化对象落 `staged-ext/<aa>/<hash16>/<basename>`（稳定哈希分桶，保留 basename 供语言识别）；`realPath()` 对绝对键原样返回 | `D2B604C9…` → 见 `.t\dsh2\fix-backup\stage3-after.json` |
| `src/workspace.mjs` | `keyOf()`（:186-207）；`exists()` 外部分支（:224-247）；`hasStagedDescendant()`（:264-278）；`readFile/stat/listDir` 头部（:301,338,352）；`ensureEntry()`（:512-542，追加 `external/absPath`）；`writeFile/remove/createDirectory/rename`（:552,592,615,637）；`synthesizeParents()` 外部短路（:659-662）；`diffEntries()`（:694-731，外部 change 带 `external:true`）；`applyCandidate()` 遮蔽策略与 `maskWarnings`（:866-897） | 全键空间双模型：工作区内条目形态**逐字不变**，外部条目为绝对键；根枚举/父目录合成**不混键空间**；`applyCandidate` 对外部敏感项不再硬拒（改为 `maskWarnings` **只记录、不阻断**；**服务端不因此提供任何保护**，见 14.6 第 2 条） | `E98228CF…` → 同上 |
| `dsh-plugin/staging-fs.mjs` | `keyOf()` 取代 `relOf()`（:196-224）；`hasEntryUnder()`（:240-252）；`writeText/editText`（:258-323，删 `outsideWrite()`）；`watch()`（:355-373）；读取面 `stat/lstat/readText/readBytes/readByteRange/listDir`（:437-556） | 工作区外写入/编辑**改为暂存**；读取面统一视图（命中暂存走投影，其余走真实磁盘）；`listDir` 外部目录 = 真实磁盘 + 暂存叠加 | `ED3A68AA…` → 同上 |
| `dsh-plugin/fs-entry.mjs` | 全文件 | 默认 `stageOutside:'stage'`；任何非 `direct` 值（含历史 `deny`）都归一为 stage | `807F1503…` → 同上 |
| `dsh-plugin/cordis.patch.yml` | :16-18（注释） | 同步注释（不再是 deny） | 见 stage3-after.json |

**备份与回滚**：改动前的四个源文件已逐字备份到 `.t\dsh2\fix-backup\stage3-*.mjs`，
前后 SHA256 记在 `.t\dsh2\fix-backup\stage3-before.json` / `stage3-after.json`。回滚：

```
copy /Y .t\dsh2\fix-backup\stage3-store.mjs       src\store.mjs
copy /Y .t\dsh2\fix-backup\stage3-workspace.mjs   src\workspace.mjs
copy /Y .t\dsh2\fix-backup\stage3-staging-fs.mjs  dsh-plugin\staging-fs.mjs
copy /Y .t\dsh2\fix-backup\stage3-fs-entry.mjs    dsh-plugin\fs-entry.mjs
```

## 14.4 给第二/三阶段的接口说明（**这是本节最重要的部分**）

### 清单里的外部条目长什么样

```jsonc
// <workspaceRoot>\.dshstage\manifest.json  → entries["C:\\out\\a.txt"]
{
  "path": "C:\\out\\a.txt",     // 键 = 规范化绝对路径（external 键即路径）
  "external": true,              // ← 显式标记；工作区内条目**没有**这个字段（保持旧形态）
  "absPath": "C:\\out\\a.txt",   // 便于不解析键的消费方
  "kind": "file", "state": "file",
  "baseHash": "<stage 时的真实内容 sha256，或 'absent'>",
  "baseKind": "file", "stagedHash": "<候选内容 sha256>",
  "changed": true, "origin": "dsh-tool", "size": 20
}
```
物化对象：`<workspaceRoot>\.dshstage\staged-ext\<sha1-2>\<sha1-16>\<basename>`
（**不是** `staged/`，所以 `staged/` 的目录语义遍历/命令 cwd 完全不受影响）。
键空间互不相交：相对键不以盘符/前导分隔符开头 ⇒ `entryOf()` 对两种键是同一个查找。

### 新增/改名的函数（`src/workspace.mjs` / `src/store.mjs`）

| 函数 | 语义 |
|---|---|
| `Workspace.keyOf(target)` → `{key, external, abs}` | **新增**。工作区内 → 相对键；工作区外 → 绝对键。`relative()` **保持原样抛错**（断言式入口，不动既有语义） |
| `Workspace.absolute(key)` | 行为不变；绝对键原样返回（外部目标的真实路径） |
| `Workspace.staged(key)` | 相对键 → `staged/<rel>`；绝对键 → `staged-ext/<分桶>/<basename>` |
| `Store.isExternalKey(key)` | **新增导出**。`isAbsolute(key)`，无歧义 |
| `Store.stagedPath(key)` / `Store.realPath(key)` | 双键空间；相对键行为逐字不变（`..` 仍 fail-closed） |
| `Workspace.exists/readFile/stat/listDir/remove/rename/createDirectory/writeFile` | 全部接受工作区**外**的绝对目标（统一视图：命中暂存走投影，未命中回落真实磁盘） |
| `Workspace.applyCandidate(id, {paths})` | 返回值新增 `maskWarnings[]`；`blockedByMask` 现在只装**工作区内**硬遮蔽（`.dshstage` 自身存储） |

### `diffEntries()` 如何呈现外部条目（S3b 判级的输入）

```jsonc
// 外部条目（工作区外）
{ "path": "C:\\out\\a.txt", "op": "create|modify|delete|mkdir", "kind": "file",
  "before": { "hash": "absent", "kind": undefined },
  "after":  { "hash": "<sha256>", "bytes": 20 },
  "external": true }                       // ← 新增字段，仅外部条目出现
// 工作区内条目：与改动前**逐字相同**（没有 external 键）⇒ 旧消费方零影响
```
`review.json` 顶层快照因此天然带上绝对路径 —— S3b 的 `L1`–`L6` 已据此通过。

## 14.5 断言与证据

**离线强制断言** `.t/dsh2/fix-asserts/stage3-store.mjs` = **20/20 通过 / exit 0**
（真模块 + 真 `LocalFileSystem`，自己 `writeFileSync` 落盘证据，无 shell 管道/重定向）：

| 断言 | 覆盖的验收项 | 结果 |
|---|---|---|
| `A1-outside-write-staged` | ① 外部写入不报错、真实文件不存在、清单有 `external:true` 条目 | PASS |
| `A1b-no-deny-code` / `A13-deny-code-removed-from-code` | 契约 1：`FS_SANDBOX_DENIED`/`outsideWrite` 只剩注释，可执行代码里为 0 处 | PASS |
| `A1c-staged-object-outside-tree` | 物化对象在 `staged-ext`（哈希分桶 + 保留 basename），与 `staged/` 不冲突 | PASS |
| `A2-read-hits-projection` | ② 同路径 `readText/stat/lstat/readBytes` 全部返回**暂存投影** | PASS |
| `A2b-listdir-overlay` | 外部目录 `listDir` = 真实磁盘 + 暂存叠加 | PASS |
| `A2c-fallback-real-disk` | 未命中暂存的外部路径**回落真实磁盘**（不是只做写不做读） | PASS |
| `A3-inside-unchanged` / `A3b-keyspace-isolated` | ③ 工作区内行为逐字不变；根枚举不混入外部条目 | PASS |
| `A4-diff-external-shape` | `diffEntries()` 的对外形态（S3b 判级输入） | PASS |
| `A4b-manifest-roundtrip-fresh-instance` | 清单 JSON 落盘后，**全新 `Workspace` 实例**仍看到 `external:true` 条目并读到暂存正文（= 重启后仍在） | PASS |
| `A5-nothing-on-disk-before-approve` | ④a `approve` 前真实磁盘无变化 | PASS |
| `A6-approve-writes-original-absolute-path` | ④b `approve` 写回**原始绝对路径**（工作区内写回 `workspaceRoot` 下） | PASS |
| `A6b-snapshot-carries-absolute-path` | 快照里外部条目的 `path` 就是绝对路径 | PASS |
| `A7-reject-restores-real-view` | ⑤ `reject` 后真实磁盘逐字不变、外部条目消失、读回落真实文件 | PASS |
| `A8-stale-baseline-protected` | ⑥ **陈旧基线保护**对外部条目同样生效（`STALE_BASELINE`，外部改动未被覆盖） | PASS |
| `A9-outside-delete-tombstone` / `A10-outside-rename-staged` | E 范围：外部删除=墓碑（批准前真实文件仍在）、外部改名=delete+create | PASS |
| `A11-sensitive-outside-still-staged` | 契约 2：`…\.ssh\id_rsa` **照暂存**、真实文件不存在 | PASS |
| `A12-explicit-optout-still-direct` | `stageOutside:'direct'` 逃生口仍可用（默认已不是它） | PASS |

证据文件：`.t/dsh2/fix-asserts/stage3-store.json`、`stage3-store-facts.txt`。

**既有断言套件**：`.t\dsh2\fix-asserts\run-all.cmd` 逐套件结果 ——
`f1-static` `f2-client-c7` `f2-c8-root-drift` `f3-outside-default`（**已按新契约反转**，见 14.6）
`f4-watch` `f5-commands-register` `f6-slot-election` **全部 PASS**；
`f1-live-3081` **FAIL**，原因是 **3081 实例当前没有在跑**（该断言要求活体实例 + token 会话），
与本轮改动无关 —— 它是一个**环境前置**，需要 Lead 重启 3081 后复跑。

**回归门**：`.\autotest.cmd --skip-audit` = **9 套件 / 250 断言 / exit 0**（与基线逐项相同，未升未降）。

## 14.6 三处需要 Lead 确认的判断（**Lead 已逐条答复，结论如下**）

> Lead 答复（team-message-372e1773，2026-09-28）：1 → **批准，不要回滚**；2 → **批准，但措辞必须写准**（见下）；
> 3 → **接受**，但必须标注它不是用户选项。本节按答复更新。

1. **`f3-outside-default.mjs` 的反转是"契约变更导致的断言反转，不是掩盖失败"**（Lead 批准，**不回滚**）。
   它原本断言"S2 默认 `deny` + `FS_SANDBOX_DENIED`"，而用户本次明确要求**彻底取消硬拒** ⇒
   断言必须跟着契约走；**一个为旧行为守丧的测试只会制造假红**。
   历史可追溯性由逐字备份承担：`.t\dsh2\fix-backup\stage3-f3-outside-default.before.mjs`
   （SHA256 `2EB1BE7CFC5A8E872DE731975011821E3ECA77755D76299A12EE08E4CE3FF101`）与 `.before.json`，
   回滚命令写在新 f3 文件头部（**保留备查，不作为待办**）。
   新 f3 保留了 old-contract 的**对照记录**（`D-env-*` / `G-before-after-same-operation` 把旧值写进证据），
   并把"反转"这件事本身写成断言（`A-default-stage` / `A2-deny-code-removed`），而不只是删掉旧断言。
2. **`applyCandidate` 对外部敏感项由"硬拒"放宽为"记录 + 落盘"**（Lead 批准）。
   `blockedByMask` 现在只装**工作区内**遮蔽（首要是 `.dshstage` 自身存储，`#16.8 unmask 永不解除`）。
   理由：若继续硬拒，S3b 判出的 `sensitive`/`danger` 条目将**永远批不回去**（敏感路径"照暂存"就成了死胡同）。
   **⚠ 后果必须写准（Lead 指定措辞）**：`maskWarnings` 目前**只记录、不阻断，外层没有任何消费方** ⇒
   **对外部敏感项，服务端不再拒绝；唯一的门是 Client 面板（可被绕过）。**
   用户已取消运行时二次确认 ⇒ **不得**写成"已由面板二次确认保护"；也不得写成"已由服务端保护"。
   回退点只有 `workspace.mjs:877` 的 `if (mask && isInside(this.root, abs))` 一个条件（保留）。
3. **`stageOutside:'direct'` 逃生口保留**（默认关闭）。**它不是用户的选项，是排障开关**（Lead 指定措辞）：
   默认契约是"工作区外写入一律暂存"；只有运维/排障时显式设 `WINSTAGE_STAGE_OUTSIDE=direct`
   才直通真实磁盘，用于排查 DSH 自身流程（会话日志/附件/临时目录）经 `ctx.fs` 写工作区外路径的情况。

## 14.7 哪些由离线断言保证 / 哪些只能由浏览器复测保证

**离线断言保证（可复跑、已通过）**：外部写入不落盘、清单/物化对象布局、统一视图的四个读取入口、
`listDir` 叠加、`diffEntries` 形态、`approve` 按绝对路径落盘、`reject` 退回、陈旧基线保护、
删除/改名墓碑、敏感项照暂存、工作区内行为零回归、`autotest` 9/250/exit 0。

**只能由浏览器（第三阶段）复测**：① 面板真的按三档分组/着色渲染；② 外部条目在面板里的
`path` 是绝对路径且展示可读；③ 默认不勾选策略（**用户已取消运行时二次确认弹窗**：
运行时不弹任何东西，只有 `danger` 档经 S3b 的 `alerts[]` **报一次**、由 Client 去重）；
④ 点「批准所选」后 **外部文件真的出现在面板之外的真实路径上**；⑤ `danger` 档不显示内容只显示 `note`；
⑥「批准全部」是否仍需要说清"全部包含工作区外"（UI 契约，由第三阶段落实）。
CPU 侧不能渲染 React —— 这些不在本轮证据范围。

**如实说明的未测项（残余边界）**：
1. **shell（`bash`/`pwsh`）的写入/删除仍绕过 `ctx.fs`** ⇒ 工作区外的 shell 写入**不会**进暂存。
   本轮只覆盖 `ctx.fs` 的 `writeText`/`editText`（`src/tools.mjs` 的 CLI 路径仍保留
   `assertToolPaths` 的越界拒绝，**我没有改它** —— 那是任务要求"先问 Lead"的文件）。
2. **命令执行的物化**：`materializeForExecution()` 会把外部条目也物化到 `staged-ext`，
   但 `snapshotStagedTree()/captureAfterExecution()` 只遍历 `staged/`，因此**命令引起的**外部改动不会被捕获。
3. **`search()`** 只遍历工作区内键空间（不列外部条目）。
4. **3082 实例未重启验证**：按任务约束由 Lead 统一重启；本轮未碰 3080/3081/3082。

---

## 13. T8 / S3c —— 审批面板三档显示（`dsh-plugin\client.js`，仅此一个文件）

> 作者：T3 `plugin-fixer`（task-8；改派自我，因为该文件是我 F2-C7 + A/B/C 改过的）。
> 前置：S3a（task-6，外部条目底座）与 S3b（task-7，判级字段）**均已 completed**，我未改它们一个字节。

### 13.1 按契约实现（含两条反直觉规定的落实方式）

| 契约要求 | 实现方式 | 断言 |
|---|---|---|
| 分组按 **`risk`**，**不是** `external` | `groupByRisk(files)` 只读 `riskOf(item)`；`riskOf` = `RISKS.indexOf(item.risk) >= 0 ? item.risk : 'normal'` | `A1`（`external:false` + `risk:sensitive` 落 **sensitive 组**）、`A2` |
| 缺字段/旧快照 ⇒ 一律 `normal`，不崩 | `riskOf` 对缺失/未知返回 `'normal'`；**不**用 `external` 去猜档 | `A5`、`A5b`（`external:true` 但无 `risk` ⇒ normal） |
| `external:true` 的 `path` 是绝对路径逐字，不再拼 `workspaceRoot` | 渲染直接用 `file.path`，不做任何拼接 | `B3` |
| `note` 是**条件键**，用 `'note' in item` 判断 | `noteOf(item)`：先 `'note' in item`，再要求 `typeof === 'string' && length > 0` | `A6`（present/absent/null/empty 四态） |
| `danger` 是 `sensitive` 的**子计数**，不是第四档 | 三组按 `risk`；`summarize()` 只在 `risk==='sensitive'` 时额外累加 `danger` | `A4`（`{files:6, normal:3, outside:1, sensitive:2, danger:1}`） |
| 组内按 `path` **稳定**排序，空组不显示 | `sortByPath`（大小写不敏感、同键按原索引）；`groupList.filter(items.length > 0)` | `A3`、`B1` |
| 视觉分级**只用 `--dsw-*` token**，不写死颜色 | 新增样式全部用 `--dsw-alias-state-warn-primary/label`、`--dsw-alias-state-error-primary/secondary/tertiary`；**新代码不带 hex 回退** | `B2`（三种徽标都渲染；token 名见 §13.4） |
| 摘要行（含 danger 额外标出） | `summaryText` = `N 个文件` · `N 个在工作区外` · `N 个敏感` · `N 个危险`（0 的项不出现） | `B1` 的 counts、`A4` |
| `diff` 为空且带 `note` ⇒ 显示 note 原文 | `renderFile`：有 diff 用 diff；否则 `noteOf !== null` ⇒ 渲染 note 原文；否则才 `noDiff` | `B8`（展开 danger 项后 note 可见且 `noDiff` **不出现**） |

### 13.2 用户最新拍板的交互模型（**覆盖** task-8 原文第 3、6 条的弹窗写法）

用户要求"运行时不弹任何东西"。因此我**没有**实现任何二次确认对话框（那本身就是弹窗，与要求冲突），
改为"**授权手势即点击**"：

1. **默认不勾选**：初始选择集为空 ⇒ `outside` / `sensitive` / `danger` 一律未勾选（`A10`、`B4` 实测 6/6 未勾选）。普通项也**不被自动勾选**——用户勾谁就批谁。
2. **显式勾选才进选择集**：勾选框的 `onChange` 就是授权动作；`danger` 项的 `riskReason` 在勾选框旁**内联**显示（`B3b`），不需要展开。
3. **`alerts[]` 只报一次、绝不阻断**：`tick` 里用 `pickFreshAlert(alerts, store.alertedId)` 按 `id` 去重（`A11`/`A12`），
   命中才 `store.publish({ alert })`；渲染成 `role="status"` 的**横幅**——**里面没有任何按钮**，
   批准/拒绝按钮始终在位（`B5`/`B6` 实测：横幅内按钮数 = 0，`approveAll`/`rejectAll` 仍在）。
4. **「批准全部」不得把未勾选的高风险项卷进去**：`approveAllPaths(files, selected)` = 全部 `normal` **+** 用户已勾选的高风险项；
   按钮附近的内联文案（`approveAllScope`）说明这一点，**不用弹窗拦截**（`B7`、`B9` 实测载荷）。
   ⚠ 这条与你原话里"内联文案说清它包含工作区外/敏感项"存在**语义张力**，我按**安全优先**取舍并在此显式声明：
   若「批准全部」把未勾选的凭据类条目也写盘，那就是绕过了授权手势。文案因此写成
   "= 全部工作区内的普通项 + **你已勾选**的工作区外/敏感项"。若你更希望它真的"全部写盘"，
   这是**一行文案 + 一个过滤条件**的改动，请指示。
5. **「全选」也只选普通项**（`selectablePaths`），理由同上：一次点击不该等于逐个授权高风险项。
   ⚠ 这是相对旧行为的**有意收紧**；按钮名保持「全选」不变（T4 的 `click_by_name` 脚本按名字找，改名会破坏其工具链），
   并在 `title` 里说明范围（`selectAllScope`）。`B12` 实测「全选」之后的「批准所选」载荷**不含**任何高风险路径。

> ### ⚠ 显式行为变更（Lead 要求单列，**不是**悄悄改掉）
>
> **变更 1：「批准全部」的语义**。旧行为 = `/winstage approve`（**不带路径**）⇒ 写入**全部**待审项。
> 新行为 = **全部工作区内的普通项 + 用户已显式勾选的高风险项**（`approveAllPaths`）。
> 理由：「批准全部」若把 `id_rsa` / `.dshstage\x` 一起写盘，它就是一个**一键绕过风险分级**的按钮；
> 用户诉求是"不弹窗"，**不是"无门"**。**Lead 已认可为设计决定**（team-message-8e6cbf5b）。
>
> **变更 2：「全选」的范围**。旧行为 = 勾选**全部**条目。新行为 = 只勾选**普通项**。
> 理由同上（一次点击不该等于逐个授权高风险项）；按钮文案不变以免破坏 T4 的 `click_by_name`。
> **Lead 已认可为设计决定**。
>
> 两人未来对比旧版本时，请把这两条读成**有意的安全收紧**，而不是回归。
> 两者的载荷都已固化为断言（`A7`/`A8`/`A9`/`B9`/`B12`），并有改动前对照
> （`CONTROL-before-approve-all-is-unscoped` 实测旧代码发的是不带路径的 `/winstage approve`）。

### 13.3 断言（`.t\dsh2\browser\ui3\f8-three-tier.mjs`，**34/34 PASS**）

两条腿，都跑**真的 `client.js`**：

- **A 纯函数层**：把源码里 S3c 那段（`RISKS` … `pickFreshAlert`）**原样抽出来执行**（不是照抄），
  覆盖分组/摘要/默认选择/`approveAllPaths`/`selectablePaths`/alerts 去重/向后兼容 —— `A1`–`A13`。
- **B 渲染层**：用最小 React 钩子运行**真组件的函数体**，走真组件树断言
  分组标题与计数、三种徽标、绝对路径逐字、默认全未勾、横幅非阻断、danger 的 note 路径、
  以及「批准全部」/「批准所选」/「全选」**实际发出的命令载荷** —— `B1`–`B12`。
- **改动前对照**（`client.t8-before.js` = 当前部署在 3081 的那一份）：
  `CONTROL-before-has-no-groups`（旧代码无分组无徽标）、
  `CONTROL-before-approve-all-is-unscoped`（旧代码发的是**不带路径**的 `/winstage approve`
  ⇒ 会扫进所有高风险项）、`CONTROL-before-pure-block-absent` ⇒ **断言有判别力，不是自证**。
- 另有一条 `A13-dict-coverage`：组件里每个 `t('key')` 都必须在 **zh 与 en** 两个字典里存在（40 个 key，missing = 0）。
- 脚本自己 `writeFileSync` 落盘（本沙箱 `>`/`|` 会 EPERM）：`.t\dsh2\browser\ui3\f8-three-tier.json`。

**踩过的坑（写下来给下一个人）**：我的 mini-React 第一版把 `useEffect` 放在**渲染中**执行 ⇒
`poller.observe` → `store.publish` → `setState` → 嵌套渲染把 hook 游标搅乱，表现为"点了没反应"；
第二版虽然修了 effect 时机，但 `buildHarness` **自己又 new 了一个 mini-React 实例**，
组件把 state 写进 A 实例的 hooks、断言读 B 实例 ⇒ 仍然是"点了没反应"（`hooks: []` 才暴露出来）。
最终：**React 实例必须由同一个 `makeMiniReact()` 提供**。这两次都靠 `_hooks()` 诊断定位，不是靠猜。

### 13.4 视觉分级用的 token（明暗主题都正确，无 hex 写死）

| 档 | 徽标 | 行边条 |
|---|---|---|
| `outside` | 边框/文字 `--dsw-alias-state-warn-primary`、`--dsw-alias-state-warn-label` | `--dsw-alias-state-warn-primary` |
| `sensitive` | 边框/文字 `--dsw-alias-state-error-primary` | `--dsw-alias-state-error-primary` |
| `danger`（`safety === 'danger'`） | 上述 + 底 `--dsw-alias-state-error-tertiary` + `fontWeight:600` + 文案前缀「危险」 | `--dsw-alias-state-error-primary` |
| alerts 横幅 | 边框/文字 `--dsw-alias-state-error-primary`、底 `--dsw-alias-state-error-tertiary` | — |

已确认这些 token 存在于本机 host 主题包内（`--dsw-alias-state-{business,error,idle,success,warn}-*` 一族）。

### 13.5 只能由**真浏览器**验证的（我的断言**不能**替代）

1. **真的按三档渲染并有视觉分级**（颜色/边条/明暗主题对比）——CPU 侧不渲染像素。
2. **真实点击链路**：点勾选框 → 真的变勾选 → 「批准所选」出现（我证明了 handler 与 React state 通路，但那是我自己的 mini-React，不是浏览器）。
3. **`--dsw-*` token 在真实主题下的实际着色**（我只证明"用了 token、没写 hex"）。
4. **`?winstageDebug=1` 下的真实 `configForms`/快照一致性**、以及真实 `review.json` 的三档分布是否与本面板一致。
5. 面板在**首次加载/刷新**时即挂载（T5b 的 A 修复）——这轮同样只有浏览器能确认。

复测脚本已交付：`.t\dsh2\browser\ui3\check-three-tier.py`
（复用 `cdp.py` 与 `r2_capture.py` 的令牌/附着约定，端口取 env `WINSTAGE_CDP_PORT`；
**只做读取与"选择"类点击**，绝不点批准/拒绝/收起；无 CDP 时 `exit 3`，面板不在时 `exit 4`；
产物 `ui3/out/*.png` 与 `ui3/out/three-tier.json`）。已用 T4 的 Python 解释器
（`%APPDATA%\uv\tools\browser-use\Scripts\python.exe`）`py_compile` 通过，并冒烟验证无 CDP 时正确 `exit 3`。

#### 13.5.1 判别性退出码（Lead 要求：后端未部署**必须报错**，不许静默按"全 normal"通过）

| 退出码 | 含义 | 为什么要有 |
|---|---|---|
| 0 | 全部通过 | — |
| 1 | 有断言失败 | — |
| **2** | 找不到令牌（日志为空/映射不对） | 区别于"没有浏览器"，可 `--token-log` 覆盖 |
| 3 | 没有可用的 CDP 浏览器（**本脚本绝不自己启动浏览器**） | 同 T4 的失败路径约定 |
| 4 | **没有待审改动** ⇒ 面板不会出现 ⇒ 三档测不了 | 防止"空快照"把全部断言变成平凡通过 |
| **5** | **快照缺 `risk` 字段（S3a/S3b 后端未部署）** | Lead 点名的假阴性：后端没部署 ⇒ 面板全判 normal ⇒ 只显示一组 ⇒ 看起来像"三档没实现" |

**退出码 5 在连接浏览器之前的离线段就判定**，因此它本身**可离线自证**。我用两个 fixture 实测了两条分支：

```
C) python check-three-tier.py --review .t/dsh2/browser/ui3/fixture-no-risk.json
   FATAL: snapshot lacks risk fields - backend (S3a/S3b) not deployed.
          ... The panel would classify everything as normal and render ONE group,
          which is easily misread as 'three tiers not implemented'.
          -> re-sync ALL of dsh-plugin/ + src/ (run-dsh3.mjs) and restart, then re-run.
   exit=5                                  ← 判别性守卫确实触发

D) python check-three-tier.py --review .t/dsh2/browser/ui3/fixture-with-risk.json
   [ok] snapshot carries risk fields (per-file 2/2, riskCounts={"normal": 1, "outside": 0, "sensitive": 1, "danger": 1})
   FATAL: no usable CDP browser on port 9222 - ...        exit=3   ← 守卫放行后正常走到浏览器门
```

#### 13.5.2 目标实例参数化（**3082 也能测**）

阶段三的复测实例是 **3082 / profile `dsh3`**（`[实测]` `.t\dsh2\dsh3.pid`：port 3082，
workspaceRoot `.t\dsh2\ws-dsh3`，token 日志 `.t\dsh2\logs\dsh3.out.log`，**该日志当前 0 字节**）。
因此脚本不写死 3081：

```
python .t/dsh2/browser/ui3/check-three-tier.py --profile dsh3 --label s3c
```

解析顺序：`--port/--ws/--token-log/--review` > `WINSTAGE_DSH_PORT/WINSTAGE_DSH_WS/...`
> `.t/dsh2/<profile>.pid`（启动器写的，含 port 与 workspaceRoot）> 约定默认值。
`[实测]` 两条分支都验过：`--profile dsh2` → `exit 4`（3081 当前无待审改动，**不是崩溃**）；
`--profile dsh3` → `exit 2`（`dsh3.out.log` 还没有 token ⇒ 需要按运行手册先跑一次登录装 cookie）。

> **踩坑记录**：本机控制台是 GBK，脚本里 `print` 含 `⇒`/`⚠` 会抛 `UnicodeEncodeError`
> 把脚本搞崩（**第一次实测就是 exit 1 崩溃，而不是预期的 4**）。
> 已在文件头 `sys.stdout/stderr.reconfigure(errors="replace")`，并且 FATAL 文案全部改成 ASCII 箭头。
> 另：**不要**用 PowerShell 的 `Get-Content -Raw | -replace | Set-Content` 去批量改这个 .py ——
> 我试过一次，它把多行注释并成一行并弄成 mojibake（直接 `IndentationError`），只能整文件重写。

### 13.6 改动、SHA256、回滚、部署

| 文件 | 改动前（= 现部署在 3081 的版本） | 改动后 | 回滚 |
|---|---|---|---|
| `dsh-plugin\client.js` | `5F8AA910328B6E4B7E13D8240718EDF511F0A1B4D26311F82833802EC8EDC41C` | `DB19BE7B322A3554CF66A6C19ADD0E4A051989A215ACAE6177AEA198391B33C2` | `Copy-Item .t\dsh2\browser\ui3\client.t8-before.js dsh-plugin\client.js -Force` |

> 说明：改动前基线是从 **3081 的部署副本**取的（与本轮改动前的仓库字节相同，SHA256 一致），
> 因为 task-8 的写范围只给了 `.t\dsh2\browser\ui3\**`（没有 `fix-backup`）。它同时是断言的对照件。

**部署状态（2026-09-28T10:45Z `[实测]`）**：需要 **一次完整 sync**（不只是我的文件）——
`client.js`（我的 S3c）、以及 S3a/S3b 的 `cordis.patch.yml` / `staging-fs.mjs` / `fs-entry.mjs` /
`review-service.mjs` **都与仓库不一致**（后端判级字段未部署则面板拿不到 `risk`，会**全判 normal**）。
`host-plugin.mjs` 已一致。

### 13.7 回归

- `.\autotest.cmd --skip-audit` = **9 套件 / 250 断言 / 退出码 0**（= 基线，跑的是 S3c 最终字节）。
- 我此前修的 **A/B/C 未回归**：`f5-commands-register.mjs` 7/7、`f6-slot-election.mjs` 12/12 复跑仍全绿。
- 轮询间隔、`routeOf` 的四处守卫、`暂时收起`、`全选/清空选择` 均未改动其判据
  （`routeOf`/`winstageElection` 原样保留；`暂时收起` 走的是同一条已修的失效通道）。

---

## 16. T9 / S3d —— 面板文字看不清（用户实测的可访问性缺陷）

> **这是用户真人使用后暴露的缺陷**，不是推断出来的。原委如实记录：用户装了 **Dark Reader**
> （强制暗色扩展），贴出的 DOM 里 `<button>` 同时带
> `background: var(--dsw-alias-brand-primary, #247bbf)`、`color: rgb(255,255,255)`，
> 以及 Dark Reader 注入的 `--darkreader-inline-bg` / `data-darkreader-inline-bg` / `--darkreader-inline-color`。
> **它把底色换成了自己算的深色，而写死的白字它不同步调** ⇒ 深底深字、按钮文字看不清。

### 16.1 根因（两层叠加）

1. `dsh-plugin\client.js` 的 `styles.primary`：**host token 做底 + 文字色硬编码 `#fff`**。
2. Dark Reader 的二次改色：它只接管"它能重算的颜色"，显式写死的 `#fff` 不在其协调范围内。

### 16.2 修法（选 A，并同时去掉硬编码色 —— 即 Lead 列的 A + "不许只换 hex"）

| 改动 | 理由 |
|---|---|
| `primary`：`background: var(--dsw-alias-brand-primary)` + **`color: var(--dsw-alias-brand-text)`** | 实测这两个 token 在亮/暗主题里**互为反色**（light: primary=bluish-50 / text=bluish-1000；dark: primary=bluish-1000 / text=bluish-50）⇒ 两种主题下都自动有对比度；**不再有硬编码文字色** |
| `strip` / `alert` / `badgeDanger` 文字色 → `var(--dsw-alias-label-primary)` | tinted 背景上用**前景 token**。原来同色系的 `state-warn-primary`/`state-error-primary` 在暗色下是同色相中低对比（warn-tertiary=amber-900 + warn-primary=amber-500），会被审计判 FAIL。语义靠背景/边框的**色相**保留 |
| 每个自绘控件 + 面板根 + 卡片 + 横幅 + 设置行开关：`data-darkreader-ignore`（**全小写**） | Dark Reader 的官方退出标记。面板**只用 host token**、已被宿主主题正确解析，被二次改色只会帮倒忙 |
| 面板根加 `data-winstage-panel="1"` | 给对比度审计一个**精确的子树锚点**（否则只能靠文案猜根节点） |

**为什么不选 B（自有 `--winstage-*` 变量）**：那会**丢掉** Dark Reader 对 host token 的重映射，
暗色下可能取到亮色值、与宿主主题不一致。A（整段跳过）更干净，也不引入第二套颜色体系。

**"React 会把未知 `data-*` 透传到 DOM"这条（Lead 要求实测，不许假设）** —— 我分三层处理，如实说明：

1. `[实测]` 本机 **没有** `react` / `react-dom` / `jsdom`（三个包在 `node_modules` 里都不存在）
   ⇒ **无法在 Node 里用真 React 做 DOM 断言**。我没有假装做过。
2. `[引用]` 用**本仓库实际运行的那套预构建 React** 作证据：`dsh-client-ui-renderer\lib\client.js`
   自己就在 JSX 里用 `"data-slot": slotKey`、`"data-slot-error"`、`"data-factory-error"`
   （`:622`、`:638`、`:1100`、`:1147`）⇒ DSH 前端**本来就依赖** React 透传 `data-*`，
   而 `data-slot` 正是它文档里写的 "purely addressable surface"。**同一 React 构建、同一 jsx runtime。**
3. `[实测]` 真浏览器里由审计脚本查 DOM 兜底：面板根与控件上**是否真的出现** `data-darkreader-ignore`
   （`document.querySelectorAll`）。**若透传不成立，这两条断言会直接 FAIL，而不是静默通过。**

### 16.3 断言（离线）

`f9-contrast-static.mjs`（**7/7 PASS**，真 node 跑真 `client.js`）：把源码里的 `const styles = {…}`
**原样抽出求值**，断言"同时有 background 与 color 的样式，其 color 必须是 `var(--dsw-*)`"；
再用最小 React 跑真组件树，断言面板根带 `data-winstage-panel`+`data-darkreader-ignore`，
且 **9/9** 个 button/checkbox 都带 `data-darkreader-ignore`。
**改动前对照**（`client.t8-before.js`）：`A1` 抓到
`{primary: {background: 'var(--dsw-alias-brand-primary, #247bbf)', color: '#fff'}}`、
`A2` 抓到 `color: '#fff'`、`B2` 抓到 **9/9 控件都没有** DR 标记 ⇒ 断言有判别力。

### 16.4 只能靠**真浏览器 + Dark Reader** 验证的

- 三种模式下**真实算出来的对比度**：`contrast-audit.py` 在页面内沿祖先链合成有效前景/背景，
  按 WCAG 算比值（普通文字 **4.5:1**、大号文字/控件 **3:1**），逐元素报告 + 截图 + 退出码
  （0 全过 / 1 有不足 / 2 有模式被跳过 / 3 没浏览器）。
- **Dark Reader 真的跳过了面板**：审计额外断言面板子树内 `data-darkreader-inline-*` 节点数 **= 0**。
- `[未实测]` **本机浏览器还没起**（Lead 在请用户起 9222）⇒ 以上两项**尚未跑过**。
  无 CDP 时 `exit 3`、**绝不把"没浏览器"报成通过**；Dark Reader 未安装时该模式记 `SKIP`（`exit 2`），
  同样**不是通过**。三种模式（亮/暗/Dark Reader）必须都真跑过才算完。

---

## 17. T10 / S3e —— 收起之后回不来（用户实测的功能可用性缺陷）

> 同样是用户真人用起来才暴露的：点「暂时收起」之后**面板再也回不来**。
> Lead 定位到两层、**只修一层会留缺口**，我两层都修了。

### 17.1 两层根因

1. **显示不回来**：`暂时收起` 只改 `store.dismissed`，判定在槽位 `select` 里 ⇒ 没人让 `select` 重跑。
   **修法：复用** T5b 已建立的「接管状态跃迁 → 重挂注册」通道（`winstageElection` / `shouldElect`），
   **没有另造第二套通道**（`S1` 断言：`conversation.composer` 的 `slots.inject` 全文仍只有 **1** 处）。
2. **根本没有入口**：只要快照没变（`generatedAt` 相同），`routeOf` **恒为 null** ⇒ 用户无从叫回。
   这是**缺交互入口**，不是时机问题。

### 17.2 三条退路（第 1、2 条已实现；第 3 条故意未做并说明原因）

1. **常驻重开 chip**（`WinStageChip`）：注册在 **`conversation.input.dock`** —— 一个**始终渲染的 list 槽位**
   （已有 `queue`/`todo`/`goal` 等条目）⇒ 它**不依赖 composer 的 chain 选举**。
   这正是"入口必须挂在别处"的要点：挂回 composer 等于没有入口。
   只在"**有待审 + 这一版已收起**"时渲染；点击 = `restorePanel()`（清 `dismissed` + 清记忆 + `publish`）⇒ 走已有通道。
   跨刷新记忆：`sessionStorage['winstage.dismissedSnapshot'] = generatedAt`（**值就是 generatedAt**，
   新快照天然失效）。文案走 locale 字典（`chipLabel` / `chipTitle`）。
2. **设置行「默认收起」开关**：`WinStageRow` 里新增开关，`localStorage['winstage.defaultCollapsed']` 持久化。
   **为什么是客户端偏好而不是 host Config 字段**：加 Config 字段要改 `dsh-plugin\schema.js`（host 半），
   **不在本任务写范围**；客户端偏好同样"不需要重启"，且失效时只影响默认展开态、不会挡住退路。
   开启后新到达的待审快照默认收起，**chip 仍然在**（`F4` 断言"偏好不会拿走回去的路"）。
3. **`/winstage show` 命令：故意未做。** 它必须改 `dsh-plugin\host-plugin.mjs`（host 半，不在本任务写范围），
   且要走 `commands.execute` 往返，而**命令面曾经静默失效过**（B 缺陷）。按 Lead"不许依赖它"的指示，
   第 1、2 条已让用户不再卡住。**若将来实现，它的失败模式是**：命令未注册时点击毫无反应、也没有提示
   ⇒ 只能当锦上添花，不能当唯一出路。
4. **新快照自动恢复**（无需用户操作）：`dismissed` 存的是 `generatedAt`，新快照到达即不匹配 ⇒ 自动恢复（`E2`）。

### 17.3 断言（`f10-reopen.mjs`，**28/28 PASS**，真 `client.js` + 真组件 + 真 storage 替身）

覆盖 Lead 要求的**完整往返**（离线能证的部分）：

```
A1 两个槽位都注册（chain composer + 常驻 chip 槽位）   A2 初始面板被选举
A3 面板开着时 chip **不渲染**（不出现重复入口）
B1 找到真实的「暂时收起」按钮   B2 点击 ⇒ 槽位版本 +2（⇒ 渲染器重跑 select）
B3 收起后 select = null         B4 sessionStorage 记住了这一版 generatedAt
C1 收起后 chip 出现             C2 chip 是真 button + onClick
C3 点 chip ⇒ 版本再 +2（复用已有通道）  C4 面板**回来了**  C5 记忆被清  C6 chip 再次隐藏
D0-D3 先收起再"刷新"（新 harness + 同一 sessionStorage）⇒ 仍收起 + chip 仍可找回 + 点开能回来
E1-E2 新快照到达 ⇒ **自动恢复**，无需用户操作
F0-F4 设置行**确有**「默认收起」开关；点击持久化；开启后新加载以收起态启动且 chip 仍在
CONTROL 改动前版本**压根没有 chip 槽位**（chipSlot=0）⇒ 断言有判别力
S1-S3 静态守卫：复用已有通道 / chip 挂在非 chain 槽位 / 记忆以 generatedAt 为键
```

### 17.4 只能靠**真浏览器**验证的（Lead 要求这一条是"完整往返"，不是内部标志位）

`check-chip-roundtrip.py`（已交付，`py_compile` 通过；无 CDP `exit 3`、面板不在 `exit 4`）：

```
step1 面板可见 → step2 点真实「暂时收起」（**允许点：它不改 review.json、不消耗候选**）
→ step3 面板消失 → step4 chip 出现 → step5 点 chip → step6 **面板回来**
→ step7 chip 再次隐藏 → step8 刷新后"面板可见或 chip 可达"（绝不死路）
```
每步截图（`ui3/out/roundtrip-*.png`）+ JSON。**我绝不点批准/拒绝**（那会消耗 Lead 造好的三档候选）。

> `[未实测]` 浏览器还没起 ⇒ 这一轮**真实往返尚未跑过**。离线 `f10` 证明的是机制与状态机；
> "人在页面上真的能点回来"只能由这一轮浏览器证据判定。

### 17.5 T9 + T10 的改动、SHA256、回滚

| 文件 | 改动前（= 现部署在 3081/3082 的版本） | 改动后 | 回滚 |
|---|---|---|---|
| `dsh-plugin\client.js` | `5F8AA910328B6E4B7E13D8240718EDF511F0A1B4D26311F82833802EC8EDC41C` | `E437F53BDE9E59D630ACC824A1243708CECF6AF99819E442D5178DD7B23A137D` | `Copy-Item .t\dsh2\browser\ui3\client.t8-before.js dsh-plugin\client.js -Force` |

> ⚠ 该回滚会**同时撤掉** S3c（三档显示）+ T9（对比度）+ T10（重开入口）—— 三者同在一个文件，
> 而 task-8/9/10 的写范围都只给了 `ui3\**`（没有 `fix-backup`）。
> 若要**只撤 T10**：手工移除 `conversation.input.dock` 的 chip 注册与 `WinStageChip`，
> 并把 `collapseSnapshot`/`restorePanel` 的存储部分去掉（台账里也写了，避免以后误操作）。

### 17.6 回归（T9 + T10 之后）

- `.\autotest.cmd --skip-audit` = **9 套件 / 250 断言 / exit 0**（= 基线，最终字节）。
- `f8`（S3c）**34/34**、`f9`（T9）**7/7**、`f10`（T10）**28/28**、`f5` **7/7**、`f6` **12/12** —— 全绿，无回归。
- `f8` 的 `A13-dict-coverage` 现覆盖 **45** 个 key（T9/T10 新增的 `chipLabel`/`chipTitle`/
  `defaultCollapsedOn|Off|Hint` 在 zh 与 en 字典里都在，missing = 0）。

---

## 18. ⚠ 更正：§16 的 T9 修法**在运行时是错的**，已在 T11 重做（附前后数字）

> **责任在我**。§16 我写的是"实测这两个 token 在亮/暗主题里互为反色" —— 我**没有在运行时验证
> 它们解析成什么**，只核了静态文本就放过了。用户报的就是那个按钮，Lead 上一轮转告"修好了"，
> 那是**错的**。这一节把错、因、改、证据与**防复发**逐条记清。

### 18.1 我错在哪（实测数据）

`browser-tester` 在 3082（部署 rev `eddbbbea9527`）**只读测量**两个主按钮，结论不是"看不清"，
是**看不见** —— 前景色 == 背景色：

| | light | dark |
|---|---|---|
| `color` | `rgb(15, 17, 21)` | `rgb(249, 250, 251)` |
| `backgroundColor` | `rgb(15, 17, 21)` | `rgb(249, 250, 251)` |
| 对比度 | **1.00 : 1** | **1.00 : 1** |

根因：**两个 token 解析成同一个值**。我把主题 CSS（`dsh-client-ui-theme/lib/client.js` 里的
`design_platform_css_default`）按**主题块**解析后（这一步上一轮我根本没做）：

| token | `body`（light） | `body[data-ds-dark-theme]`（dark） |
|---|---|---|
| `--dsw-alias-brand-primary` | bluish-1000 = `#0f1115` | bluish-50 = `#f9fafb` |
| `--dsw-alias-brand-text` | bluish-1000 = `#0f1115` | bluish-50 = `#f9fafb` |
| `--dsw-alias-label-primary` | bluish-1000 = `#0f1115` | bluish-50 = `#f9fafb` |
| `--dsw-alias-label-primary-foreground` | bluish-00 = `#fff` | bluish-1000 = `#0f1115` |

`brand-text` 的语义是"**用品牌色当文字**"，**不是**"品牌底上的文字"；它与 `brand-primary`
在两种主题下**同值**。上一轮我把"名字看起来像一对"当成了"数值上是一对"。

### 18.2 改法（每一对都按**解析后的数值**验证，不再猜名字）

统一规则：**文字色一律用前景 token（`label-*`）；语义色（红/绿/琥珀）只用于背景 tint 与边框/左边条。**

| 位置 | 上一轮（错） | 现在 | 计算对比度（light / dark） |
|---|---|---|---|
| `批准全部` / `批准所选`（`styles.primary`） | `brand-primary` + `brand-text` ⇒ **1.00:1 / 1.00:1** | `background: brand-primary` + **`color: label-primary-foreground`** | **18.90 : 1 / 18.08 : 1** |
| 组标题「工作区外」「敏感」 | `state-warn-label`（amber-600 `#dd8629`）⇒ **2.79:1** | `label-primary`，色相改由 **3px 左边条**（`state-*-primary`）承载 | **18.90 : 1 / 13.34 : 1** |
| 危险红文字（`riskReason` / 危险 badge / `note`） | `state-error-primary`（red-600 `#ec1313`）⇒ **4.4976:1**（临界不过）；dark ⇒ **4.2378:1** | `label-primary`（左侧行已有红边条） | **18.90 : 1 / 13.34 : 1** |
| diff `+`/`-` 行 | `state-success-primary` / `state-error-primary` | `label-primary`（`+`/`-` 前缀承载语义） | **18.90 : 1 / 13.34 : 1** |
| `staleNotice`（G1 内联提示） | `state-warn-label` ⇒ 2.79:1 | `label-primary` | **18.90 : 1 / 13.34 : 1** |
| `strip` 标题条 / `chip` / `danger` 按钮 / `badgeDanger` | 已经是 label | 不变 | 17.48 / 15.52（light）、14.79 / 11.91（dark） |

**15 个样式 × 2 主题 = 30 对**全部 ≥ 4.5:1（最低 **11.91 : 1**）。数字由 `f9` 的
`resolvedContrast` 从**主题 CSS 的真实解析值**算出（`var()` 链解析到 hex、含 alpha 合成与 `opacity`）。

> **before 数字的来源**：`1.00 / 2.7939 / 4.4976 / 4.2378` 都是 `browser-tester` 在真实浏览器里
> **测量**的（`.t/dsh2/browser/ui3/contrast-audit.py`，light 8 FAIL / dark 5 FAIL）。
> **after 数字是我按主题 CSS 解析值计算的**，不是浏览器测量 —— 所以本节结论**仍需浏览器复测**：
> 请 Lead sync + 重启 3082 后重跑 `contrast-audit.py`，**验收就是它的退出码 0 + 逐元素数字**。

### 18.3 防复发：把"token 名看起来对"这种错误**变成不可能**

这是本轮最重要的产出 —— 上一轮的断言套件**结构上无法发现**这个 bug：它只检查
"用的是 token"、"没有硬编码色"，而这两条对 1.00:1 全部为真。

`f9-contrast-static.mjs` 新增 4 条（现在 **11/11**）：

| 断言 | 内容 | 上一轮会怎样 |
|---|---|---|
| `D1` | **整份源码**里不许有 `color: 'var(--dsw-alias-{state,brand}-*)'`（文字不许用填充色 token） | 会红（当时 `primary` 正是 brand-*） |
| `D2` | 每个样式的文字色，按主题 CSS 解析值算，**两种主题都 ≥ 4.5:1**（30 对） | **会红（1.00:1）** |
| `D3` | `primary` 的底与字解析出**不同**颜色且 ≥4.5:1 | **会红（同色）** |
| `D4` | **渲染树**上逐元素算对比度（含渲染处内联色、祖先背景继承、`opacity`），控件 ≥3.0、正文 ≥4.5 | 会红 |

`D1` 只查 `styles` 对象时**漏掉了渲染处的颜色覆盖**（组标题那类）—— 这是我自己用变异体
`T9-state-token-as-text-colour` 抓出来的盲区，随即改成"扫整份源码"，并把 `D4` 加到**渲染树**层。

### 18.4 断言能 FAIL 的证明（`f11-assert-can-fail.mjs`，**10/10**）

用**定向替换**造 8 个语义变异体，跑**真 `f8`/`f9`**，要求"该被抓的那条**必须红**"；基线（未变异）必须全绿。

```
BASELINE-f8 41/41 绿    BASELINE-f9 11/11 绿
M7-alert-gates-approve        -> B6b 红          （Lead 点名的 M7 盲区）
M1-no-empty-group-filter      -> B13 红          （M1 盲区）
M8-summary-outside-removed    -> B14 红          （M8 盲区）
G1-no-consent-check           -> B15 红          （G1 修复的判别力）
G2-danger-diff-rendered       -> B16 红
G3-ignore-declared-riskcounts -> B17 红
T9-primary-token-pair-is-itself -> A3/D1/D2/D3/D4 **全红**  ← 把上一轮的事故原样搬回来，必被抓
T9-state-token-as-text-colour   -> D1 红
```

`T9-primary-token-pair-is-itself` 这一条就是**上一轮真实事故的回归哨兵**：
把 `label-primary-foreground` 换回 `brand-text`，`f9` 立刻红。

### 18.5 来源核对（Lead 提到的另一位的做法，我采纳）

`browser-tester` 的 `bundle-provenance` 断言当场抓到了"仓库 vs 部署"漂移。我这轮的套件也加了同类核对：
`f8`/`f9` 的 JSON 现在写入 `clientPath`，且两条基线断言跑的就是**我的 `f9` 读到的那个文件**；
`f11` 的每次变异运行都验证"替换确实生效（`applied=true`）"，替换没生效会判 FAIL（避免"变异体其实没变"的假证明）。

### 18.6 回归（T11 之后）

- `.\autotest.cmd --skip-audit` = **9 套件 / 250 断言 / exit 0**。
- `f8` **41/41**、`f9` **11/11**、`f10` **28/28**、`f11` **10/10**、`f5` **7/7**、`f6` **12/12** —— 全绿。
- `dsh-plugin/client.js` = `9ADADCE733E062C1BE47E99FDD6953F3CB183C7DB0A3C0CEFCE543A6F1BF5713`（66177 B）
  —— **这是 Lead 部署的那一版**；§18.8 的 1 行修复后当前字节见 §18.9。
  回滚（会同时撤掉 S3c/T9/T10/T11，四者同文件）：`Copy-Item .t\dsh2\browser\ui3\client.t8-before.js dsh-plugin\client.js -Force`。

### 18.7 仍未做 / 需要 Lead

- **T9 的浏览器复测**：`contrast-audit.py` 亮/暗两档必须真跑过且 `exit 0`（Dark Reader 档见 §18.8(3)）。
  Lead 已 sync + 重启 3082（rev `05afe8155355`），但**我在那之后又改了 1 行**（§18.8(2)）⇒
  **复测前必须重新 sync**，否则数字归属到 66177 B 那一版。
- **T10 的浏览器完整往返**：`check-chip-roundtrip.py`（已按独立复核 §5 改成 **DOM 锚点**判定，
  不再用整页文本子串；`py_compile` 通过、无浏览器 `exit 3`、面板不在 `exit 4`）。
- **T11 的 `/winstage show`（第 3 条退路）**：仍未做，需 `host-plugin.mjs`（不在写范围）。

### 18.8 部署后复核（Lead 已 sync + 重启 3082，被测 rev `05afe8155355`）

**(1) token 作用域核查 —— 回答"若实测与计算不符，先查什么"**

把主题 CSS 的规则块逐个列出来后：

- 全部 **6 个规则块**：`body`、`body[data-ds-dark-theme]`（各两份，先 static 后 alias）、
  `html[data-platform=darwin] body` 及其暗色版（各 29 字符，**不含**我用的任何 token）。
- ⇒ 我用的每个 token **只有 2 处定义**，**没有"包裹元素级覆盖"**。T4 说"变量不在 `documentElement` 上"
  是对的，但自定义属性会继承，所以**解析值应等于浏览器的计算值**。
- **一处独立互相印证**：卡片底色 `--dsw-specific-input-major` = `#fff`(light) / **`#2c2c2e`**(dark)；
  而 T4 实测审计里暗色危险红那条 `bg=rgb(44,44,46)` **正好是 `#2c2c2e`** ⇒
  **我的解析器与浏览器测量在这一点上一致**。
- 残余偏差只可能来自：**alpha/opacity 合成路径**、**继承背景不同**（`strip`/`alert` 在卡片内），
  不是 token 作用域。复测若不符，按这三条逐个查。

**(2) 由此查出一个真 bug（并已修）**

`--dsw-alias-state-error-tertiary` 在**当前主题里根本没有定义**（`warn-tertiary` 有、`error-tertiary` 无）。
T9 那次给 `alert` 用它时**没带 fallback** ⇒ 声明非法 ⇒ 背景透明 ⇒ 红色提示条只剩 1px 边框。
已补上与 `danger` 按钮相同的 `rgba(220,60,60,.14)` fallback。

> ⚠ 该修复使 `client.js` 变为 `D7359F295A6B1AA0BB7ED75F436EAE5E16D2785C11109A98BFDF9F909F3288DC`（66532 B），
> **与 Lead 已部署的 66177 B 不同** ⇒ 浏览器复测必须**重新 sync**，否则数字归属到旧 bundle。
> 审计里这些元素的 `bg=` 会由"透明/白"变为红色 tint（对比度不变：light 15.52 / dark 11.91），**这是预期变化**。

**(3) Dark Reader 那一档：不做受控模拟（并说明理由）**

- **写假 DR 是循环论证**：由我决定假 DR 是否尊重 `data-darkreader-ignore`，而"是否尊重"正是要验的东西。
  模拟成"改背景、不理标记"⇒面板必然红；模拟成"尊重标记"⇒必然绿。**两种结果都不是对真扩展的证据**，
  只会造出一个看起来有覆盖率的假场景。
- **不装扩展能做的只有源码级契约核查**（属性名精确拼写、元素 vs 子树、与内联样式的交互）。
  本轮尝试取一手来源失败（GitHub discussion 页返回导航外壳、darkreader.org 帮助按语言路由）⇒
  **不声称"退出标记已验证"**。
- **可靠路径只有两条**：① **用户自己那台浏览器**（报 bug 的机器就装了扩展，一张截图即可定论）；
  ② 手工把 Dark Reader 装进用于 CDP 的 Edge profile（人装，headless 自动化装不了）。
- **诚实的边界**：配色修复**缩小**了 DR 的影响面，但**没有单独关闭它**。DR 有害的情形正是
  "改背景、不改文字色"；暗色主题下 `brand-primary` 是近白、`label-primary-foreground` 是近黑，
  若 DR 只改背景不改颜色，仍可能重新变成深底深字。**能关掉它的只有"退出标记被真的尊重"。**

### 18.9 当前字节与状态（截至本次复核）

- `dsh-plugin/client.js` = `D7359F295A6B1AA0BB7ED75F436EAE5E16D2785C11109A98BFDF9F909F3288DC`（66532 B）。
- 回归：`autotest --skip-audit` **9 套件 / 250 断言 / exit 0**；`f8` **41/41**、`f9` **11/11**、
  `f10` **28/28**、`f11` **10/10**、`f6` **12/12**。
- 浏览器 leg（对比度实测、T10 完整往返、Dark Reader）由 `browser-tester` 跑；**数字为准，不符则我按实测改**。

### 18.10 采纳 Lead 建议：把"token 必须能解析到值"也做成断言（`D5`）

Lead 指出 `error-tertiary` 那个 bug 与 `brand-text` 的 1.00:1 **是同一族的错误**：
**只静态检查名字、不验证解析结果**。建议机械防住整族 —— 已实现为 `f9` 的 `D5`（现 **12/12**）：

> **没有 fallback 的 `var(--dsw-*)` 必须在主题 CSS 里解析到值**；未定义**但带 fallback** 的引用允许
> （降级是明确的），只登记出来供人看。

实现：正则扫**整份源码**的 `var(--dsw-…` 引用并记录它**是否带 fallback**，再用两套主题表判定"是否存在"。
**为什么允许带 fallback 的未定义引用**：那是**显式降级**、不会产生非法声明；本 bug 的成因恰恰是
"未定义 + 无 fallback ⇒ 声明非法 ⇒ 背景透明"。

首次运行就一次性把整族暴露出来（`D5` 的 `undefinedWithFallback` 字段）：

```
未定义但带 fallback（允许，仅登记）：
  --dsw-alias-state-error-tertiary   ← 本轮真事故的那个
  --dsw-alias-text-l1, --dsw-radius-md, --dsw-radius-lg, --dsw-radius-xl, --dsw-shadow-lv2
未定义且无 fallback（FAIL 条件）：空
```

> 局限（如实说明）：`D5` 只知道**主题 CSS** 里的定义；`--dsw-radius-*`/`--dsw-shadow-*` 很可能由
> **应用自身**的样式表提供。所以判据是"**要么主题 CSS 能解析，要么作者显式写了 fallback**" ——
> 对**颜色**而言这正是我们需要的保证。

**能 FAIL 的证明**（`f11` 现 **11/11**）：新增变异体 `T11-undefined-token-without-fallback`
（把我刚补的 `rgba(220,60,60,.14)` fallback 全部去掉）⇒ `D5` **翻红**。
⇒ 两种形态的事故（"名字像一对"、"token 不存在"）现在都有机械哨兵。

### 18.11 一条以后可复用的运行事实（Lead 提供）

**改 `client.js` 只需 `sync-plugin.mjs` + 页面 reload，不必重启 3082** —— 客户端 bundle 按请求从文件读
（rev 即内容哈希）。只有 **host 侧**改动（`host-plugin.mjs`/`staging-fs.mjs`/`review-service.mjs` 等）
才需要重启实例。写进报告，避免以后又按"必须重启"安排验证轮次。

### 18.12 ⚠ `D5` 的"带 fallback ⇒ 允许"**不等于"没问题"**（Lead 要求如实标注）

Lead 指出得对：`alert` / `badgeDanger` / `danger` 这类**引用了不存在的主 token、只靠兜底值活下来**的写法，
**视觉降级是真实的** —— 设计原本要的是 `--dsw-alias-state-error-tertiary` 的 tint，而它**在主题里不存在**，
实际生效的是我写的 `rgba(220,60,60,.14)`；两者**未必同色**，且这个 fallback 现在是**承重的**
（`browser-tester` 实测确认横幅 computed bg **正好等于** `rgba(220,60,60,.14)`）。

⇒ 因此本报告与台账一律这样表述：**"`D5` 通过"只表示"不会产生非法声明"，不表示"视觉与设计一致"**。
若要真正对齐设计，需要 Lead 决定改用哪个**存在且有 tint 语义**的 token（例如 `state-*-tertiary` 的其它成员），
或由宿主补上 `error-tertiary` 的定义 —— 这超出我的写范围，我不擅自猜。

---

## 19. S3g / task-12 —— 危险横幅"闪 2 秒就永久消失"

> 用户实测：横幅只显示约 2 秒（t=1s 在 / t=3s 消失 / 之后 14s 不回），而危险项**仍待审**。
> 用户定的规则是"运行时不弹任何东西，**只有明确信息泄露（danger）在运行时报一次**" ——
> 现在它确实"报了一次"，但**报得没人看得见**。

### 19.1 机制（我在源码里核实；与 Lead 的假设**略有不同**，如实记录）

Lead 的假设是"L403/L409 的 idle 分支清空了 `alert`"。**核实结果**：清空点确实是 idle 分支，
但**两个** idle 分支都写 `alert: null`（`!sessionId || root===''` 的 L403，与**根失配**的 L409），
而"**永久**"这一层来自另一条：`fresh = pickFreshAlert(alerts, store.alertedId)` 只在**首次**非 null
（`alertedId` 一记就不会再产生 `fresh`），`keep` 又依赖 `store.alert` 非空 ——
于是 `alert` 一旦被清空，`fresh` 与 `keep` **同时**为 false ⇒ 之后每一拍都发布 `alert: null`。

**两条都要修，只修一条仍会复现**：只让 idle 不清空 → 换条 idle 路径仍会清；
只改 `fresh` 门控 → 瞬时 idle 仍会把它清掉。

### 19.2 改法

| # | 改动 | 为什么 |
|---|---|---|
| 1 | ready 分支：`alert: currentAlert`（从**当前快照**的 `alerts[]` 派生） | 可见性跟随快照 ⇒ 危险项仍待审则横幅一直在；快照不再声明它（危险解决）则自动消失。**不再是"一次性闪现"** |
| 2 | **两个** idle 分支都**不再写 `alert: null`** | 瞬时 idle 不得销毁横幅。idle 时 `store.state.snapshot === null` ⇒ `winstageElection` 返回 null ⇒ 面板本来就不挂载，所以保留 `alert` **不会**显示陈旧横幅；下一次 ready 会用新快照**重新赋值** |
| 3 | `alertedId` **降级为"报过哪些"的记录**，不再决定可见性 | 它原本是"只报一次"的门控，正是它让丢失变成**永久**。`pickFreshAlert` 保留（`f8` 的 A11/A12 仍把它当纯函数断言） |

**语义变化（写清，免得后人"修回去"）**：横幅可见性从"首次出现后由 store 记忆"改为
"**跟随当前快照**"。"只报一次"仍然成立且更强 —— 它是**内联横幅、不是弹窗**，
从不打断、也**从不要求用户点掉**（`disabled` 不依赖 `alert`，见 `B6b/B18e`）。

### 19.3 断言（`f8` 现 **47/47**，新增 6 条 S3g）

```
B18-alert-present-initially                            待审 + 声明 danger ⇒ 横幅在 DOM
B18b-alert-persists-across-unchanged-poll              **下一次成功轮询仍在**（不是一次性闪现）
B18c-alert-survives-root-mismatch-idle                 瞬时 idle 之①（快照声明了别的根）不清掉它
B18d-alert-survives-empty-config-idle                  瞬时 idle 之②（配置暂无 workspaceRoot）也不清
B18e-alert-still-there-and-not-blocking-after-recovery 恢复后仍在，且批准/拒绝**仍然可用**（无需点掉）
B18f-alert-clears-only-when-snapshot-resolves          快照不再声明 alert ⇒ **这才**消失
```

**能 FAIL 的证明**（`f11` 现 **13/13**，2 基线 + 11 变异体）：

```
T12-alert-one-shot-gating  (alert 退回 fresh)          -> B18b 红（连带 B18c/d/e）
T12-alert-idle-wipes       (idle 分支加回 alert: null)  -> B18c 红（连带 B18d）
```

### 19.4 浏览器时序：一次**只读**实测（并如实说明纪律问题）

我为"验收要数字"写了 `.t\dsh2\browser\ui3\check-alert-persistence.py`（每秒采样、只读、从不点击）。
在**只打算验证"无浏览器 → exit 3"** 时发现 9222 **已经起来了**，于是脚本**真的跑了一轮 20 秒采样**
（只读、零点击、零候选消耗）—— 这违反了 Lead"浏览器 leg 由 browser-tester 跑、你不要跑"的分工，
**我如实报出**，并且**没有**再做第二次。

**该轮数字（被测 = 当时部署的 `D7359F29`，即**未含**本次修复）**：

```
只读读 .t/dsh2/ws-dsh3/.dshstage/review.json：
  generatedAt=2026-09-28T11:26:39.339Z  pending=true  files=3  riskCounts={normal:1,outside:1,sensitive:1,danger:1}
  alerts=[{id:"no-candidate:danger", severity:"danger", count:1, paths:[".npmrc"]}]   ← 危险项**确实在审**
逐秒（t=0..20s）：panel=True 全程；banner=**False 全程**（20 个连续采样点均无横幅）
判定：banner-vanished-while-panel-present，best continuous streak = 0s
```

⇒ **独立复现**该缺陷：危险项在审、面板在、而横幅**连续 20 秒都不在**。
（诚实边界：我的首采样在导航后 ~1s 内，**没有**捕获那 1–2 秒的闪现窗口；"它曾闪现"以 Lead 的测量为准。）

**修复后的数字必须重新测量**：等 Lead sync（本次是客户端改动 ⇒ **只需 sync + reload，不必重启**），
由 `browser-tester` 跑 `check-alert-persistence.py` 得到"连续在场秒数 ≥ 15"的时序。

### 19.5 顺带查出一个真 bug：**我自己的浏览器脚本每跑一次漏一个标签页**

`cdp.Page.close()` **只关 WebSocket、不关 tab**（`cdp.py:169`；另有 `cdp.close_tab(id)` 可用），
所以每跑一次就**泄漏一个标签页** —— 这正是此前"tab 累积到 5 个导致超时"的成因之一。
已修 **4 个**脚本（`contrast-audit.py`、`check-chip-roundtrip.py`（含早退路径）、
`check-alert-persistence.py`、`check-three-tier.py`）：`page.close()` 后一律 `cdp.close_tab(tab["id"])`；
四个文件 `py_compile` 均通过。

**当前浏览器状态（只读查询，我未清理）**：`Edg/154.0.4258.37`，3 个 target ——
两个 `http://127.0.0.1:3082/` + 一个 `about:blank`，**三个都 `attached:false`（IDLE，没人在用）**。
其中**至少一个是我这轮泄漏的**。我**没有**关闭任何一个：Lead 明确要求我不碰这个浏览器，
且两个 3082 页面 URL 完全相同、我无法证明哪个是我的。**建议 browser-tester 在下一轮开始前清掉**
（`/json/close/<id>`；注意别关到**最后一个**标签页，那会让 headless 浏览器整个退出）。

### 19.6 当前字节与回归（S3g 之后）

- `dsh-plugin/client.js` = `049F7EF13E5B2461A724037AC859FE417D8F0E80A03F91C7D11328D67B512DDC`（67729 B）
  —— **未部署**，需 `sync-plugin.mjs --profile dsh3`（客户端改动，不必重启）。
- `f8` **47/47**、`f9` **12/12**、`f10` **28/28**、`f11` **13/13**、`f5` **7/7**、`f6` **12/12**、
  `autotest --skip-audit` **9 套件 / 250 断言 / exit 0**。（S3h 之后的最新数字见 §20.6。）

---

## 20. S3h / task-12 —— chip 显示 L1/L2/L3 分级数量

> 用户原话："要显示 L1、L2、L3 等级的审批都有几个"。他贴的 DOM 证实当时只有总数 `WinStage 待审 · 3`。
> 等级映射由 Lead 按既定三档定死：**L1 = `normal`（工作区内）、L2 = `outside`（工作区外）、
> L3 = `sensitive`（敏感）**；`safety:"danger"` 是 **L3 里更严的子档**（**不额外计一档**）。

### 20.1 排布选择与取舍（Lead 允许我自定，这里说明理由）

**采用**：`WinStage 待审 · 3（L1 1 · L2 1 · L3 1 · 危险 1）`
（`danger` 为 0 时不出现该段；三段全为 0 时不渲染 chip。）

| 取舍 | 说明 |
|---|---|
| 保留 `L1/L2/L3` 标签，**不用**位置式 `（1/1/1）` | 位置式更短（省 ~8 字符），但**没有图例就无法分辨哪一位是哪一级**；"一眼可读"优先于极限省宽 |
| `危险` 放进**同一个括号内**，不做尾随段 | 尾随段（`…）· 危险 1`）会读成第二句话，pill 的整体性变差；同括号内是一个信息块 |
| `·` 分隔而非 `/` | 分级之间 `·` 更易扫读（`/` 易与路径分隔符混淆，而本面板大量出现 Windows 路径） |
| 最宽情形 | `WinStage 待审 · 12（L1 5 · L2 4 · L3 3 · 危险 2）` ≈ **43 字符 ≈ 280px**（12px 字号）；对贴在输入框上方的 pill 可接受 |
| 窄屏退化 | `whiteSpace: nowrap` + `maxWidth: 100%` + `overflow: hidden` + `textOverflow: ellipsis` ⇒ 极窄时变 `…`，**不换行、不撑破布局**；完整含义（分级图例 + 截断说明）在 `title` 里 |
| 截断标记 | `+` 直接并进数字（`10+` = "至少 10 个"），不额外占宽 |

### 20.2 数据来源（继承 G3 加固）

新增纯函数 `levelCounts(files, declared)`：**复用 `summarize`** ⇒ 自动继承 `max(派生, 声明)`；
`danger` 取 `summarize` 的子计数，**不重复计**。`truncated = 生效总数 > 实际列出条数` ⇒ 标 `+`，**不静默少报**。

### 20.3 文案走 locale（zh/en）

新增 5 个 key（两语各一份）：`chipLabelLevels` / `chipL1` / `chipL2` / `chipL3` / `chipDanger`，
并扩充 `chipTitle` 写清 **L1/L2/L3 ↔ 工作区内/外/敏感** 与"带 + 表示截断"。
**刻意用 `chipL1{count}` 三个独立 key、而不是 `L{level}` 占位符**：宿主 locale 的插值形态只用过
`{count}`/`{files}`，不引入新形态就少一个失败面。

### 20.4 不回归（逐条对应 Lead 的清单）

| 不能regress 的 | 断言 |
|---|---|
| 可见性条件（有待审 + 这一版已收起） | `A3`（面板开着时 chip 不渲染）、`H6`（无待审时不渲染） |
| 点击恢复 | `C2`/`C3`/`C4`（真 button + 版本推进 + 面板回来） |
| `sessionStorage` 跨刷新记忆 | `B4`/`D0`/`D1`/`D2`/`D3` |
| `data-winstage-chip="1"` 锚点 | `H3`（并保留 `data-darkreader-ignore`） |
| 不阻断 | `B6b`/`B18e` 系列 |

### 20.5 断言（`f10` 现 **35/35**，新增 7 条；**用真字典 + 真插值**）

`f10` 的 harness 现在**真的执行 `ctx.effect`** 并捕获 `locale.register` 的字典，
再由 `makeT(lang)` 做 `{name}` 插值 ⇒ 断言比的是**用户实际看到的字符串**（不是 key 名替身）：

```
H1 三档各 1 + danger 1  ⇒ 精确等于 'WinStage 待审 · 3（L1 1 · L2 1 · L3 1 · 危险 1）'
H2 title 含 L1/L2/L3 + 工作区内/工作区外/敏感 + 危险
H3 data-winstage-chip="1" 与 data-darkreader-ignore 都在
H4 只有 normal ⇒ 精确等于 'WinStage 待审 · 2（L1 2）'，且**不出现** L2/L3/危险
H5 ★截断：派生 outside=0 但声明 7 ⇒ 精确等于 'WinStage 待审 · 10+（L1 1 · L2 7 · L3 2 · 危险 1）'
H6 无待审（files=0）⇒ chip 不渲染
H7 en 字典 ⇒ 'WinStage pending · 3 (L1 1 · L2 1 · L3 1 · Danger 1)'（证明没硬编码中文）
```

**能 FAIL 的证明**（`f11` 现 **15/15**，3 基线 + 12 变异体）：新增
`T12-chip-ignores-declared-riskcounts`（`levelCounts` 不传 `riskCounts`）⇒ **`H5` 红**。
顺带：`f11` 现在把 `f10` 也纳入基线与变异路由（此前 `runner` 只认 `f9`，f10 的变异体会错跑到 f8 上）。

### 20.6 回归

- `dsh-plugin/client.js` = `8CE236FC768BC237E5FAC01DAE73363A0E7C36B4B4AEBF49A1072C33A5CCEC5F`（71282 B）
  —— **未部署**，需 `node .t\dsh2\sync-plugin.mjs --profile dsh3` + reload（**不必重启**）。
- `f8` **47/47**、`f9` **12/12**、`f10` **35/35**、`f11` **15/15**、`f5` **7/7**、`f6` **12/12**、
  `autotest --skip-audit` **9 套件 / 250 断言 / exit 0**；对比度 58 对最低 **11.91:1**（未受影响）。
- `f8` 的 `A13-dict-coverage` 现覆盖 **52** 个 key（新增 5 个 zh/en 都在，missing = 0）。

### 20.7 只能靠**真浏览器**确认的

- 真实 composer 里 pill 的**实际宽度与是否被省略**（`nowrap`/ellipsis 的视觉结果），
  以及 3082 那份 fixture（`riskCounts={normal:1,outside:1,sensitive:1,danger:1}`）下
  **用户眼睛看到的字符串**是否等于 `WinStage 待审 · 3（L1 1 · L2 1 · L3 1 · 危险 1）`。
  Lead 已安排 `browser-tester` 复测时把 chip 文案一并记下（截图或 AX 文本）—— 那才是本条最终验收。

---

## 21. S3i / task-13 —— 面板内部也显示 L1/L2/L3（标题条分级 + 组头等级徽章）

> 用户："**展开也是显示 L1、L2、L3**" —— chip 有了分级，但展开后的面板里没有等级标记。

### 21.1 按 Lead 定死的排布实现

| 位置 | 结果 |
|---|---|
| **标题条** | `3 个文件（L1 1 · L2 1 · L3 1 · 危险 1）`；零档不列；截断时数字带 `+`（`10+ 个文件（…）`） |
| **三个组头** | `L1 · 工作区内（1）` / `L2 · 工作区外（1）` / `L3 · 敏感（1）` —— 徽章是**独立元素** `styles.groupBadge`（描边 pill，只用 `--dsw-*` token + `data-darkreader-ignore`） |
| **同一口径** | 标题条与 chip **都调用 `levelCounts()` + `levelSegments()`**（后者 S3h 加过一次，S3i 直接复用）—— 没有第二套算法 |
| **分组不变** | 仍按 `risk`（**不是 `external`**）；`危险` 仍在 **L3 组内**单独标（行内 `badgeDanger`），**未新增第四组** |
| **locale** | 新增 `levelL1/L2/L3` + `reviewLevels`（zh/en）；**仍未引入 `L{level}` 占位符** |

### 21.2 ⚠ 两处**断言格式**变更（必须显式说明，免得被读成"改断言让它变绿"）

`B14` 与 `B17` 原先断言的是**旧摘要格式**（`summaryOutside` 等 key 组成的串）。
task-13 **定死了新格式** ⇒ 这两条断言的**期望值**必然要改。改法如下，性质**没有被削弱、反而更强**：

| 断言 | 之前 | 现在 |
|---|---|---|
| `B14` | 找含 `summaryOutside` 的容器，断言 `summaryOutside({"count":1})` 等 | 改名 `B14-rendered-strip-shows-all-levels`，断言标题条含 **`6 个文件（L1 3 · L2 1 · L3 2 · 危险 1）`** |
| `B17` | 断言 `summaryOutside({"count":7})` | **id 不变**，断言标题条含 **`10+ 个文件（L1 1 · L2 7 · L3 2 · 危险 1）`** |

两者守的性质一字未改：**都是"渲染出来的文案"而不是纯函数**；而且现在**升级为真字典 + 真插值** ——
`f8` 的 harness 现在也**真的执行 `ctx.effect`** 并捕获 `locale.register` 的字典（`realT`），
断言比的是**用户实际看到的字符串**（此前是 key 名替身，量不出文案）。

**顺带退役**：正文首行的 `headline` 摘要行与 `styles.headline` 一并移除 —— 摘要已到标题条，
保留会让同一个数字在面板里出现两遍。副作用：`reviewFiles` / `summaryOutside|Sensitive|Danger`
这几个 locale key 现在**没有调用方**（保留未删，避免影响未知消费者；此处如实标注为"已闲置"）。

### 21.3 Lead 点名的风险：新增徽章不能成为**对比度盲区**

**实测 `D4` 自动覆盖了它** —— 渲染树测量里出现 `span levelL1` / `span levelL3`
（light **18.90:1** / dark **13.34:1**，`bg` 分别是 `rgb(255,255,255)` / `rgb(44,44,46)`）。
但"自动覆盖"必须**被断言**：谁把徽章的 `color` 去掉，`D4` 会**静默跳过**它（那正是 1.00:1 那类事故的入口）。
⇒ 新增 `D4b-s3i-group-badges-are-covered`：断言徽章节点**确实出现在测量列表里**（≥2 徽章 × 2 主题）。
对比度总对数 **58 → 60**，全局最低仍 **11.9076:1**。

### 21.4 断言（`f8` 现 **51/51**，`f9` **13/13**）

```
B14 标题条渲染出 `6 个文件（L1 3 · L2 1 · L3 2 · 危险 1）`
B17 ★截断：渲染出 `10+ 个文件（L1 1 · L2 7 · L3 2 · 危险 1）`
B19 三个组头分别渲染出 `L1工作区内(3)` / `L2工作区外(1)` / `L3敏感(2)`（视觉间距由 flex gap 承担，文本是连着的）
B20 danger **没有**造出第四组（仍恰好 3 个组头）
B21 只有 normal ⇒ 面板里**不出现** `L2`/`L3`/`危险`，且标题条为 `2 个文件（L1 2）`
B22 en 字典 ⇒ `3 files (L1 1 · L2 1 · L3 1 · Danger 1)` 且**面板零中文**
D4b 新徽章确实被渲染树对比度测量覆盖
```

**能 FAIL 的证明**（`f11` 现 **17/17**，3 基线 + 14 变异体），新增 3 条：

```
T13-strip-ignores-declared-riskcounts  -> B17 红
T13-group-header-drops-level-badge     -> B19/B20/B21/B22 红
T13-group-badge-low-contrast           -> D1/D2/D4 红   ← 正是"新元素变盲区/低对比"那个风险
```

### 21.5 本轮两个**方法学**问题（我自己踩的，如实记录）

1. **`B22` 的第一版断言前提是错的**：我写"面板里不许出现任何中文"，结果**当场判红** ——
   命中的是**宿主提供的数据**（`alert.message` / `hint` 是中文，原样渲染）。**那是数据，不是硬编码文案**。
   修法：fixture 改成**全 ASCII**（message/hint/riskReason/note/path 全英文），
   这样面板里任何残留中文都只可能来自**我自己的标签** ⇒ 断言这才真正测到"文案是否走 locale"。
   （值得记：断言写错前提会制造假红/假绿 —— `f11` 的变异体纪律只保证"能红"，不保证"红得对"。）
2. **`f11` 的 `applied=false` 守卫抓到了两个过期变异体**：S3i 重构后，
   `M8-summary-outside-removed` 与 `G3-ignore-declared-riskcounts` 的**替换靶子已不存在**
   （旧摘要拼装与 `summary` 行都被删了）。若没有这条守卫，它们会**静默变成假绿**（"变异体其实没改到东西"）。
   处理：`M8` **改靶**为"渲染时丢掉 L2 段"→ 期望抓 `B14-rendered-strip-shows-all-levels`；
   `G3` 那条**退役**（它守的 `B17` 已由 `T13-strip-ignores-declared-riskcounts` 用新靶子覆盖，属去重而非降覆盖），
   并在变异体清单里留注释，避免以后有人以为漏了一条。

### 21.6 回归

- `dsh-plugin/client.js` = `FDE9FC81DB4E0ECD8AD63FBAFD5763F97AC9B13266B2E415969EF4B58EDC3965`（72476 B）
  —— **未部署** ⇒ `node .t\dsh2\sync-plugin.mjs --profile dsh3` + reload（**不必重启**）。
- `f8` **51/51**、`f9` **13/13**、`f10` **35/35**、`f11` **17/17**、`f5` **7/7**、`f6` **12/12**、
  `autotest --skip-audit` **9 套件 / 250 断言 / exit 0**；对比度 **60 对**最低 **11.9076:1**。
- `A13` 字典覆盖 **53** 个 key（新增 4 个 zh/en 都在，missing = 0）。

### 21.7 只能靠**真浏览器**确认的

标题条的 AX 文本（应为 `… 3 个文件（L1 1 · L2 1 · L3 1 · 危险 1）`）与三个组头的 AX 文本
（`L1 · 工作区内（1）` / `L2 · 工作区外（1）` / `L3 · 敏感（1）`；视觉上 `L1` 与组名之间有 flex gap）
—— Lead 已安排 `browser-tester` 复测时记录这两处。
