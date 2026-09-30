# 沙箱审批 × 原生审批：实测诊断（越界写 / 注册表 / 审批落盘）

> 只读侦察 + 受控实测，未改动插件源码。
> 实测时间：2026-09-30（本地）；会话 `session-b5a590d5-eb1f-4197-a6da-0ceb671e833d`。
> 判定标记：`[实测]` = 本轮真跑过并留下原始输出；`[引用]` = 只读源码/契约所得。
> **v2 更正（T-A/T-B/T-C 完成后）**：§0/§4 关于"越界 fs 写会落真实磁盘"的判断**已被单变量实验推翻**。
> 已确认的真缺陷是**延迟物化**与**`appliedPaths` 说谎**。**以 §8 为准**；§0/§4 保留原文以存证。

---

## 0. 结论先行（v1 初判，部分已被 §8 推翻）

用户命题的**前半句（"沙箱审批会和原来的审批冲突"）成立**，后半句（"工作区外的文件修改和注册表修改不会被沙箱捕获"）
**要分两条路看，不能一句话概括**：

| 路径 | 越界写（工作区外文件） | 注册表写 | 判定 |
|---|---|---|---|
| **`ctx.shell`（pwsh）** | **内核级硬拒**（ACL），**不是**"没捕获" | **内核级硬拒** | `[实测]` 边界成立 |
| **`ctx.fs`（write/edit 工具）** | **进暂存**（外部条目 + `staged-ext` 物化）⇒ **"被捕获"** | 不适用（fs 不写注册表） | `[实测]` 捕获成立 |

⇒ **两条路对"同一件事"给出两种完全不同的结果**，这才是冲突的实体：
一条**硬拒且无审批出口**，另一条**吸收进暂存、等待审批**，而审批落盘又走**全权 `node:fs`**、越过前者赖以成立的 ACL 边界。

---

## 1. 运行期装置（本会话实测）

```
DSH_SANDBOX              = win-stage
DSH_SANDBOX_ENFORCEMENT  = partial
DSH_SANDBOX_TIER         = T1
DSH_SANDBOX_NOTE         = writes confined to the staged root; reads are NOT confined (documented residual boundary)
DSH_SHELL                = 1
真实 cwd（沙箱内）= C:\Users\Administrator\.dshstage\sessions\session-b5a590d5-…\staged
真实工作区（注记）= C:\Users\Administrator
```

**两半的"根"互不相同** `[实测]`——这是后续一切不对称的来源：

| 半边 | 配置来源 | 生效根 |
|---|---|---|
| `ctx.fs`（`winstage-fs` 行） | profile 覆盖层 `cwd`/`workspaceRoot` | `…\Desktop\WinStageSandbox` |
| `ctx.shell`（`winstage-shell` 行） | `shell-entry.declaredWorkspaceRoot()`：显式装配值 > env > `process.cwd()` | `C:\Users\Administrator` |

⇒ 同一个路径 `C:\Users\Administrator\AppData\Local\Temp\x.txt`，对 fs 半边是**外部的**（越界、进 `staged-ext`），
对 shell 半边是**根内的**（`C:\Users\Administrator` 之下）。

证据：`.dshstage\sessions\session-b5a590d5-…\manifest.json` 的
`workspaceRoot = C:\Users\Administrator`，而另一份
`Desktop\WinStageSandbox\.dshstage\sessions\session-b5a590d5-…\manifest.json` 的
`workspaceRoot = C:\Users\Administrator\Desktop\WinStageSandbox`；**两份都自报同一个 sessionId**。

---

## 2. 越界写：shell 侧是内核级硬拒（不是"没捕获"）

| 探针 | 命令 | 结果 `[实测]` |
|---|---|---|
| 越界建文件 | `Set-Content C:\Users\Administrator\AppData\Local\Temp\wstage-outside-probe.txt` | `UnauthorizedAccessException: Access to the path … is denied.` |
| 越界建目录 | `New-Item -ItemType Directory …\wstage-acl-probe` | `PermissionDenied` |
| 调外部程序 | `cmd.exe /c mklink /J …` | `Program 'cmd.exe' failed to run: Access is denied` |
| 改 ACL | `icacls <dir> /grant *S-1-1-0:(OI)(CI)M` | `icacls.exe failed to run: Access is denied` |
| 暂存根内写 | `Set-Content <staged>\wsp3.txt` | **OK**，且捕获链回报 `captured 2 … frozen candidate cs_0001_…` |

⇒ 写边界由**受限令牌 + ACL**在**内核**执行（唯一可写 = `stagingRoot`），
**不是**"先让写发生、再靠捕获发现"。

---

## 3. 注册表：同样内核级硬拒，且拒绝来自受限令牌本身

| 探针 | 结果 `[实测]` |
|---|---|
| `New-Item HKCU:\Software\WinStageProbeTmp` | `UnauthorizedAccessException: Access to the registry key … is denied.` |
| `HKCU:\Software\Microsoft\Windows\CurrentVersion\Run` 写值 | `SecurityException` |
| `HKLM:\Software\WSP3` | `UnauthorizedAccessException` |

**归因证据**（不是"路径不存在"之类的误读）：`HKCU:\Software` 的 SD 里
`NT AUTHORITY\RESTRICTED` 只有 **`ReadKey`**，而受限令牌**_确含**该 SID：

```
=== HKCU:\Software ACL ===
  NT AUTHORITY\RESTRICTED : ReadKey : Allow
  WIN-DV9KRECLBVS\Administrator : FullControl : Allow   ← 非沙箱进程本可写
=== 当前令牌 ===
  Name: WIN-DV9KRECLBVS\Administrator    admin=False
```

⇒ 拒绝**恰由沙箱的受限令牌引入**，而非系统默认或账户权限不足。

---

## 4. `ctx.fs` 侧：越界写**确实"被捕获"**——但捕获 ≠ 隔离

以 `write` 工具写 `C:\Users\Administrator\AppData\Local\Temp\wstage-fs-outside-probe.txt`（对 fs 根而言=外部）`[实测]`：

**（a）进了暂存清单**（外部条目）：

```json
"C:\\Users\\Administrator\\AppData\\Local\\Temp\\wstage-fs-outside-probe.txt": {
  "state": "file", "baseHash": "absent", "external": true,
  "stagedHash": "a6de5e15b095a631…", "origin": "dsh-tool", "size": 90
}
```

**（b）对象物化在 `staged-ext`：**
`staged-ext\76\76bd6a74b9647834\wstage-fs-outside-probe.txt`（90 B）。

**（c）★ 但真实磁盘上出现了逐字节相同的文件：**

```
EXISTS: C:\Users\Administrator\AppData\Local\Temp\wstage-fs-outside-probe.txt
  size=90  sha= A6DE5E15B095A631…   ← 与条目 stagedHash 一致
EXISTS: C:\Users\Administrator\ws-probe-control.txt
  size=21  sha= 249BA668F7DB4AE4…   ← 与条目 stagedHash 一致
```

**（d）而"该不该落盘"的裁决者 `review.json` 说"没有待审"：**

```json
{"pending":false,"counts":{"files":0,"net":0,"frozenOnly":0},
 "candidates":[],"files":[]}
```

### 4.1 判定（这就是用户感知到的"冲突"）

4(a)/(b) 证明**捕获发生了**；4(c)/(d) 证明**捕获没有阻止落盘**。
两份"真相"同时存在、互不一致：

- 清单层：4 条外部条目 `state:file`，对象在 `staged-ext`；
- 审批层：`pending:false`、`counts.files:0`、**无任何待审**。

⇒ 若用户的"被沙箱捕获"指**"改动进入审批视野、在批准前不碰真实磁盘"**，
那么在本 session 的 fs 路线上**后半句成立**：**真实磁盘已被改、而审批面显示无事可审**。

**残余不确定性（如实标注，`[未实测]`）**：本轮**未**构造"只经 `write` 工具、不经任何其他路径"的干净时序，
因此**不排除**真实磁盘那份来自**另一条独立机制**（store 更新失败后的直写、或并发写者）。
要把 (c) 与 (b) 的因果钉死，需要一条**单变量**复现（见 §6 待办）。**不得**把本条当作已定因。

---

## 5. 审批冲突的**可复现硬证据**：原子写替补文件被 ACL 挡死

审批面的元数据提交本身**失败并外泄错误**（连续 2 次逐字相同）`[实测]`：

```
Error: EPERM: operation not permitted, rename
  '…\Desktop\WinStageSandbox\.dshstage\sessions\session-b5a590d5-…\review.json.tmp-6892'
  -> '…\Desktop\WinStageSandbox\.dshstage\sessions\session-b5a590d5-…\review.json'
```

- 机制 `[引用]`：`src/store.mjs:106-112` `writeFileAtomic()` = 写 `<path>.tmp-<pid>-<rnd>` 再 `renameSync`。
- 残留物 `[实测]`：`review.json.tmp-6892`（1329 B）**留在盘上** ⇒ rename 失败后没人清。
- 该目录随后**恰好**指向上述 fs 半边 store（`workspaceRoot=…\Desktop\WinStageSandbox`）。
- 同刻 `review.json` 内容正常（`revision:5`）⇒ **不是**"文件不存在"，而是**提交动作被拒**。
- 对照：shell 侧对同一棵树 `.dshstage\…\manifest.json` 的 `Set-Content` 亦被
  `UnauthorizedAccessException` 拒绝 ⇒ 两半都够不着这棵树的写权限。

**含义**：审批面（fs 半边、全权 `node:fs`）与沙箱面（shell 半边、ACL 受限）**互相争夺同一份 review store**，
而该 store 的**原子替换**正好落在 ACL 拒绝区。这正是"审批条目容易出错"的一条**确定性**来源，
并且它**如实报错**（不是静默）——与历史病历里"静默失效"是两类病。

---

## 6. 归因小结与待办

**已确认（可判定）**

1. `ctx.shell` 的越界写/注册表写是**内核级硬拒**，**无审批出口**——"被拒绝"而非"未捕获"。
2. `ctx.fs` 的越界写**进暂存**（`staged-ext` + 外部条目），捕获机制**确实工作**。
3. 两侧**根不同**（Desktop\WinStageSandbox vs `C:\Users\Administrator`），导致"同一路径两种归属"。
4. **原生审批与暂存审批是两套互不认识的语义**：`review.json` 与 `ctx.approval` 无共享 id/状态/清除路径。
5. 审批 store 的原子提交**可复现地失败**（EPERM rename），留下 `.tmp-*` 残骸。

**待办（需要单变量实验才能定论，`[未实测]`）**

- **T-A**：在**不**触发其他写者、且仓库快照完整的前提下，只经 `ctx.fs` 写一个全新越界路径，
  在 **≤2s 内**由 host shell 判定真实磁盘是否存在，并同时留 `manifest`/`review.json`/`staged-ext` 三份快照。
  判据：真实磁盘存在 ∧ `review.json.pending===false` ⇒ **"捕获不阻止落盘"** 确证。
- **T-B**：定位 `review.json` 上 `renameSync` 被拒的**确切** ACL 项（DACL 逐条 + 受限令牌 SID 交集），
  判定是"沙箱 runner 的 ACL 边界"还是"运行中进程持有的锁"。
- **T-C**：确认 fs 半边为何能在受限令牌下写真实磁盘（是否**不经** `WindowsStageExecutor`）——
  这决定"审批落盘"是不是一条**越权通道**（`review-service` → `applyOneCandidate` → `writeFileAtomic`，纯 `node:fs`）。

---

## 7. 本轮侦察留下的残留物（需用户裁示，我无法自行清理）

沙箱边界把我**双向**挡住：越界路径我**删不掉**（ACL 拒），`ctx.fs` 删又会被暂存成新的待审条目。
故如实列出，**未自行处置**：

**真实磁盘（4 个探针文件，均为我本轮所写）**

```
C:\Users\Administrator\ws-probe-control.txt                                       21 B
C:\Users\Administrator\AppData\Local\Temp\wstage-fs-outside-probe.txt            90 B
C:\Users\Administrator\AppData\Local\Temp\wstage-immediate-check.txt             22 B
C:\Users\Administrator\AppData\Local\Temp\wstage-immediate-check2.txt            15 B
```

**暂存残留（`Desktop\WinStageSandbox\.dshstage\sessions\session-b5a590d5-…\`）**

```
manifest.json 4 条 external 条目；staged-ext\{76,c5,ca,e9}\…；review.json.tmp-6892（1329 B）
```

清理命令（**请你在沙箱外的普通 PowerShell 里执行**）：

```powershell
Remove-Item 'C:\Users\Administrator\ws-probe-control.txt',
            'C:\Users\Administrator\AppData\Local\Temp\wstage-fs-outside-probe.txt',
            'C:\Users\Administrator\AppData\Local\Temp\wstage-immediate-check.txt',
            'C:\Users\Administrator\AppData\Local\Temp\wstage-immediate-check2.txt',
            'C:\Users\Administrator\AppData\Local\Temp\ws-singlevar-outside.txt' -Force
```

---

## 8. T-A / T-B / T-C 复盘（本节权威，取代 §0/§4 的相关判断）

### 8.1 T-A：单变量实验**推翻**"越界 fs 写会落真实磁盘" `[实测]`

单变量序列：冻结基线 → **只**经 `ctx.fs` 写一个全新越界路径
`C:\Users\Administrator\AppData\Local\Temp\ws-singlevar-outside.txt` → T+0/3/10s 三值快照。

| 时刻 | realDisk | manifestState | stagedHash | review.pending |
|---|---|---|---|---|
| T+0s | **False** | file | `4b827eb7b8efe48f` | True (files=3) |
| T+3s | **False** | file | `4b827eb7b8efe48f` | True (files=3) |
| T+10s | **False** | file | `4b827eb7b8efe48f` | True (files=3) |

对象物化正确：`staged-ext\83\833eae9fc54bba7a\ws-singlevar-outside.txt`（39 B）。

⇒ **越界写的暂存与隔离是有效的**（10 秒窗口内零泄漏）。
**§0/§4 的"捕获不阻止落盘"结论撤回**；先前观测到的 4 个越界文件确实在真实磁盘上，
但**不能归因于**"暂存阶段镜像写盘"，成因归入 **§8.2 的延迟物化**。

### 8.2 ★ 真缺陷一：**延迟物化**——工具回执与真实磁盘长期分叉 `[实测]`

工具对一次 `write` 报 `Created file`，但真实磁盘落盘**晚于**回执，延迟量级达**分钟**：

| 文件 | write 工具返回 | 真实磁盘首现 | 延迟 |
|---|---|---|---|
| `docs\dsh2-越界与注册表-实测诊断.md` | 10:30 报 `Created file` | **10:35:05** | **≈4.5 分钟** |
| `docs\dsh2-t1-consistency-probe.md` | 10:38 报 `Created file` | 10:38:39 仍 **False** | ≥1 分钟（观测窗内未落） |

字节比对 `[实测]`（证明是**完整**物化，不是半写）：

```
staged 对象 : .dshstage\…\blobs\5f\5f8ecc23…   sha=5F8ECC230F77B28D
staged 副本 : .dshstage\…\staged\docs\…         sha=5F8ECC230F77B28D
真实磁盘    : docs\dsh2-越界与注册表-实测诊断.md   sha=5F8ECC230F77B28D   ← 三者一致
真实磁盘大小 10819 B / 212 行（完整）
```

⇒ 内容**完整无损**，但**"工具说成功"与"磁盘已有"之间存在数分钟的不一致窗口**。
在该窗口内，任何依赖"磁盘即时一致"的判据（含本项目自己的验收脚本）都会得出错误结论。

**残余不确定（`[未实测]`）**：触发物化的**确切机制**未定 —— 候选
①运行期 reconcile / auto-apply 定时器；②`ctx.fs` 提供方在某观察点把暂存投影回真实磁盘；
③外部进程（3080 profile 侧）。

### 8.3 ★ 真缺陷二：`appliedPaths` **说谎**（记录层 vs 磁盘层不一致） `[实测]`

`review.json` 声称已应用，磁盘却不存在：

```
candidate cs_0005_7dbce141 status=partially-applied
    applied=True   realExists=False   docs\dsh2-越界与注册表-实测诊断.md
违反计数 = 1
```

而同一条目**稍后确实出现在磁盘上** ⇒ `appliedPaths` 是"打算应用/已入候选"的记录，
**不是**"已成功落盘"的事实。这正是"审批条目非常容易出错"的记录层形态：
**审批账本与磁盘事实之间没有一致性校验**。

### 8.4 ★ 真缺陷三：`publish()` 失败时**残留**临时文件（且与 `store.mjs` 两种口径） `[实测]`+`[引用]`

- 残留物 `[实测]`：`review.json.tmp-6892`（1329 B）曾在盘上。
- 定因 `[引用]`：该命名 = **`dsh-plugin/review-service.mjs:771`**
  `const temp = \`${target}.tmp-${process.pid}\`` —— **不是** `store.mjs`。
- `review-service.mjs:766-775` `publish()`：

  ```js
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, JSON.stringify(snapshot), 'utf8')
  renameSync(temp, target)        // ← 无 try/catch：失败即留残骸，原错误上抛
  ```

- **同仓库两种口径**：`src/store.mjs:107-121` 的 `writeFileAtomic()` 在 rename 失败时
  **会** `unlinkSync(tmp)`；`publish()` **不会**。
- 实测报错：`EPERM: operation not permitted, rename '…review.json.tmp-6892' -> '…review.json'`。

⇒ "同一件事两套实现"的一致性缺陷：**store 侧修好了，审批侧漏了**。

### 8.5 方向 1 收口：定论 + 待定因

| 项 | 判定 |
|---|---|
| 越界 fs 写是否在批准前落真实磁盘 | **否** `[实测]`（单变量 10s 零泄漏）⇒ §0/§4 撤回 |
| shell 越界写 / 注册表写 | **内核级硬拒**（ACL）`[实测]`，边界成立 |
| `review.json` 提交失败性质 | **ACL 拒绝**，非文件锁 `[实测]`（store 内 create/rename 全被拒） |
| shell 为何写不了 fs 侧 store | ACL 中只有两个受限 SID 有该目录写权（`S-1-4-56185984-…`、`S-1-4-1039366120-…`），**本会话 runner SID 不在其中** `[实测]` |
| 延迟物化触发机制 | **`[未实测]`——下一个必做项** |

**方向 2 修法据此收敛**（原 2a 需修正）：

- ~~2a"越界条目批准前不落盘"~~ ⇒ **不是缺陷，不修**；改为**加断言钉死**该不变式防回归。
- **2b（保留，已定因）**：`publish()` 复用 `writeFileAtomic` 语义 —— 失败清 `tmp`、错误可归因、不留残骸。
- **新增 2c**：`appliedPaths` 加**磁盘一致性校验**（§8.3），让"账本 ≠ 事实"必须响。
- **新增 2d**：定因并修**延迟物化**（§8.2）——用户"规则冲突"感受的直接来源之一。

---

## 9. 方向 2 实施记录（本轮）

### 9.1 【已实施·待验证】2b：`publish()` 复用 `writeFileAtomic`

| 项 | 内容 |
|---|---|
| 文件 | `dsh-plugin/review-service.mjs` |
| 导入 | 第 28 行加 `writeFileAtomic`（`from '../src/store.mjs'`） |
| `publish()` | 删除自写的 `` `${target}.tmp-${process.pid}` `` + 无清理 `renameSync`，改为 `writeFileAtomic(this.reviewPath(), JSON.stringify(snapshot))` |
| 覆盖 | 一处改动覆盖 **6 个调用点**：本文件 `:432/:451/:807/:866/:936` + `host-plugin.mjs:239` |
| 语义变化 | **只有**"rename 失败时不留 `.tmp-*`"；原错误照旧上抛（不吞、不降级）⇒ 错误路径的观察不变 |
| 部署核对 | 部署副本同样是 `const temp = \`${target}.tmp-${process.pid}\`` + `renameSync(temp, target)`（`:771/:773`）⇒ 是同源缺陷，修一次修两边 |

**判据（待跑）**：构造 rename 失败 ⇒ ①抛错仍发生；②`.tmp-*` **不留**；③正常路径 **0 error**、`review.json` 内容不变。

### 9.2 【已实施·待验证】"关闭沙箱后 shell 未恢复"——**这是设计缺口**

**实测现象**：会话档位为 `danger-full-access` 时，**每一条 `pwsh`** 都被拒：

```
winstage-shell: requested sandbox mode "danger-full-access" differs from what this
executor applies ("workspace-write"); WinStage 不支持升权，本次命令没有执行（绝不静默忽略）。
```

**根因**（`[引用]` 源码 + `[实测]` 运行期）：

- profile `web/cordis.patch.yml`：`pwsh-sandbox`（平台原生 shell）被 `disabled: true`，
  `winstage-shell` 为 `disabled: false` ⇒ **WinStage 整体替换了 `ctx.shell` 这个单例服务名**。
- `staging-fs`（fs 侧）**继承**平台 `LocalFileSystem`，关闭时可 `super.writeText(...)` **天然回退**；
  而 `shell-executor` 的基类 `ShellExecutor` **本身不执行任何东西** ⇒ **没有 `super` 可退**。
- 于是关掉开关后本行仍占着服务名，继续按 `workspace-write` 围栏拒绝 ⇒
  用户感知为"**关了沙箱 shell 全废**"。

**已实施修法**（`dsh-plugin/shell-executor.mjs`）：

| 项 | 内容 |
|---|---|
| 常量 | 新增 `NATIVE_PWSH_MODULE = '@deepseek-ai/dsh-pwsh-local/lib/index.js'`（`:173`） |
| 构造 | 抓住 `this.rootEntry = ctx?.fiber?.entry`（与 `staging-fs.mjs:220` 同写法同理由）+ `this.rawConfig`（`:429/:493`） |
| `winStageEnabled()` | 与 `staging-fs.stagingEnabled()` **同一真源、同一读法**：现读 loader 行 `winstage-sandbox` 的 `config.enabled`；找不到行默认 `true`（fail-open 保持历史行为） |
| `nativeExecutorFor()` | 惰性 `import` 平台原生 `PwshLocalExecutor` 并缓存；**定位不到就 fail-closed 抛错**（绝不静默退回某种围栏） |
| `execute()` | **开关关闭 ⇒ `return native.execute(spec)`**（交还平台，不做暂存捕获）；开关开启 ⇒ 仍按原围栏拒绝任何非 `workspace-write` 请求 |
| 错误文案 | `WINSTAGE_SHELL_ESCALATION_NOT_SUPPORTED` 追加一句可操作提示（告知"关闭开关即可交还平台"） |

**为什么这是正确修法**：与 fs 侧 `sandboxMode` 关闭时报 `super.sandboxMode` 是**同一个设计意图**
（"关闭后的行为与没装插件逐字一致"），只是 shell 侧必须**显式装载**平台实现才能兑现 ——
因为单例服务名没有 `super`。

**判据（待跑）**：
1. 开关**关闭** + 档位 `danger-full-access` ⇒ `pwsh` **可执行**（不再抛 `ESCALATION_NOT_SUPPORTED`）；
2. 开关**开启** + 档位 `danger-full-access` ⇒ **仍拒绝**（保持"不静默无效批准"）；
3. 开关**开启** + 档位 `workspace-write` ⇒ 行为与改前**逐字一致**（回归门应 0 变化）。

### 9.3 本轮未完成（阻塞）

`2c`（`appliedPaths` 磁盘一致性校验）、`2a`（越界隔离不变式钉死断言）、`2d`（延迟物化定因）、
**方向 3**（合并两套审批语义）**均未开始**。

**阻塞原因**：本会话 `ctx.shell` 被上面 9.2 的缺口整条拒掉，且 **subagent 继承同一档位**
（已实测：三条命令全被同一条拒），因此**无法启动进程**⇒ 无法跑 `autotest`、无法跑断言与变异体、
也无法按要求"另开一个 DSH 进程加载沙箱"（那需要启动进程）。
按本项目纪律（"没有能 FAIL 的断言等于没验证"），**未验证的改动不得宣称完成**。

**解除方式（任一）**：
- **A**：把会话档位改回 `workspace-write`（`winstage-shell` 唯一接受的档位）⇒ 我自行完成全部验证；
- **B**：由用户在普通终端执行下述命令并回贴输出。

```powershell
cd C:\Users\Administrator\Desktop\WinStageSandbox
node --check dsh-plugin\shell-executor.mjs
node --check dsh-plugin\review-service.mjs
Select-String -Path dsh-plugin\review-service.mjs -Pattern 'tmp-\$\{process\.pid\}'   # 期望无命中
.\autotest.cmd --skip-audit                                                            # 期望 14 套件 / 646 ok / 0 bad / exit 0
```


