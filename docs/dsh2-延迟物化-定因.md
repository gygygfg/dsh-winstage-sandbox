# 延迟物化·定因报告（谁、何时把暂存内容写进真实磁盘）

> 只读侦察 + 对**已存在的产物与日志**的实测取证；**未改动任何产品代码**。
> 时间基准：**本地时间 = UTC+8**。会话记录里的 `time` 是 epoch ms，`appliedAt` 是 UTC（`…Z`）。
> 例：`2026-09-30T02:35:05.659Z` = **本地 10:35:05.659**。
> 判定标记：`[实测]` 本轮真跑过并留下输出；`[引用]` 只读源码/契约所得；`[未实测]` 未取得直接证据。

---

## 0. 结论先行

**「延迟物化」= 用户命令面发起的 `/winstage approve`。**
不存在任何"定时/轮询把暂存投影回真实磁盘"的机制。那条链路只有一个落盘出口：

```
用户（WinStage 面板按钮 / 斜杠命令）        source:{"kind":"user"}
  → ctx.remote.commands.execute            dsh-plugin/client.js:701-706（调用点 :1551 / :2031）
  → /winstage approve 处理器               dsh-plugin/host-plugin.mjs:261-295（:289 service.approve）
  → ReviewService.approve()                dsh-plugin/review-service.mjs:792-833（:811 调 applyCandidate）
  → Workspace.applyCandidate()             src/workspace.mjs:1008-1127（:1066 调 applyOneChange）
  → Workspace.applyOneChange()             src/workspace.mjs:1129-1166（:1165 落盘）
  → writeFileAtomic(真实绝对路径, blob)     src/store.mjs:107-121
```

**「延迟」不是轮询周期。** 全仓库（含 live 部署副本）**唯一**的 host 侧定时器是
**面板轮询** `setInterval(tick, POLL_MS)`（`dsh-plugin/client.js:813`，常数 `POLL_MS = 1500` 在 `client.js:57`），
而它的 `tick` 只**读**快照（`client.js:747` `readReview`）并更新面板本地状态，**不执行任何命令**。
分钟级的间隔 = **write 工具回执 → 用户按下"批准"之间的人为间隔**。

### 0.1 一手证据：5 次 `/winstage approve` 与 5 次落盘的毫秒级对齐 `[实测]`

取证对象：`C:\Users\Administrator\.dsh\sessions\--C-Users-Administrator-Desktop-WinStageSandbox--\session-b5a590d5-eb1f-4197-a6da-0ceb671e833d\session.v4.jsonl.zstd`
（817 个 zstd 帧，解压后 3,989,380 字节 / 1301 条记录）。该会话共 **6 条 `command/run`**，其中 **5 条是 `winstage approve`**，全部 `source:{"kind":"user"}`：

| `command/run` 时刻(本地) | 命令 args | `command/done` 时刻 | 对应候选 `appliedAt`(本地) | 真实磁盘 `birthtime`(本地) |
|---|---|---|---|---|
| 10:30:37.343 | `approve "…\Temp\wstage-fs-outside-probe.txt" "…\ws-probe-control.txt"` | 10:30:37.385 | `cs_0002` **10:30:37.369** | `02:30:37.363` / `02:30:37.367` |
| **10:35:05.636** | **`approve "docs\dsh2-越界与注册表-实测诊断.md"`** | **10:35:05.677** | **`cs_0005` 10:35:05.659** | (见下注：该版已被 10:39 的两次批准覆盖) |
| 10:39:04.176 | `approve "…ws-singlevar-outside.txt" "…wstage-immediate-check.txt" "…wstage-immediate-check2.txt" "docs\dsh2-t1-consistency-probe.md"` | 10:39:04.228 | `cs_0007` 10:39:04.205 | `02:39:04.198/201/203/205` |
| 10:39:20.024 | `approve "docs\dsh2-越界与注册表-实测诊断.md"` | 10:39:20.087 | `cs_0008` 10:39:20.064 | — |
| 10:39:41.431 | `approve "docs\dsh2-越界与注册表-实测诊断.md"` | 10:39:41.477 | `cs_0009` 10:39:41.456 | **`02:39:41.455`**（今日现存文件的 birthtime） |

对齐结论（逐条可核对）：

1. **落盘时刻 == `appliedAt`**，误差 ≤ 7 ms（`cs_0007` 的 4 个文件 birthtime 与 `appliedAt` 02:39:04.205 同毫秒或早 7 ms 内；`cs_0009` 的 birthtime 02:39:41.455 与 `appliedAt` 02:39:41.456 **同毫秒**）。`[实测]`
2. **Lead 观测的"10:35:05 首现"的文件内容与 `cs_0005.after.hash` 逐字节相同**：Lead 记录的 `sha=5F8ECC230F77B28D` == `cs_0005.changes[2].after.hash = 5f8ecc230f77b28dbabccbf80798ced92b0b9cc4ff03ae3b1cef5a839af4252e`（前 16 位一致）。`[实测]`
3. 该文件今日 hash 是 `47bf0696…`（**不是** 5f8ecc…），因为 10:39:20（cs_0008 → `18ed53…`）、10:39:41（cs_0009 → `7cb186…`）、以及 10:46:19（无暂存痕迹，见 §5）又各写过一次。**"同一个路径被多次批准"会让任何"候选 hash vs 当前磁盘"的朴素校验必然报错**（见 Q4）。
4. `queue.json`/`review.json` 的状态机与 `command/done` 文本一致（`cs_0005` → `partially-applied`，`appliedFiles:1 remainingFiles:2`；`command/done` 原文：`已应用 1 项\n 仍在待审：…wstage-immediate-check.txt, …wstage-immediate-check2.txt`）。`[实测]`

⇒ **"write 工具 10:30 报成功 → 真实磁盘 10:35:05 出现"这 4.5 分钟，就是"10:35:05.636 那条用户批准命令"与写入之间的间隔。**
另一例 `docs\dsh2-t1-consistency-probe.md`（write 10:38:33 → 批准 10:39:04）同理；Lead 在 10:38:39 观测到 "仍 False"，正落在这段"已暂存、未批准"的窗口内。

---

## Q1 机制：除了「批准」，还有哪条路径会把暂存 blob 写到真实磁盘？

**结论：没有第二条。** 完整候选清单（含被排除项与排除理由）见 §6。
下面逐条给出被点名怀疑方向的一手核对结果。

### 1.1 唯一的"内容物化"出口：`applyOneChange` → `writeFileAtomic` `[引用]`

`src/workspace.mjs:1157-1166`：

```js
    if (!this.store.hasBlob(change.after.hash)) {
      throw new SandboxError('BLOB_MISSING', `candidate content for ${change.path} is missing; candidate is unusable`, …)
    }
    const content = this.store.readBlob(change.after.hash)
    // 原子替换：临时文件 + rename（同卷）
    writeFileAtomic(abs, content)          // ← abs = this.absolute(change.path) = 真实工作区路径
```

`src/store.mjs:107-121`：

```js
export function writeFileAtomic(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  writeFileSync(tmp, data)
  try { renameSync(tmp, path) } catch (error) { … unlinkSync(tmp) … throw error }
}
```

调用者只有 `Workspace.applyCandidate`（`src/workspace.mjs:1066`，`try { this.applyOneChange(change, opts); applied.push(...) }`）。
`src/workspace.mjs:693` 的自我声明与实测一致：**"落盘只能经 applyCandidate"**。

同函数还有一处真实磁盘写：**删除分支** `src/workspace.mjs:1142-1154`（`rmSync(abs)`）——同样只在批准路径上。

### 1.2 `review-service.mjs` 的 `absorbSharedStore()` / `reconcileCandidates()` / `publish()`

| 方法 | 是否落真实工作区 | 证据 `[引用]` |
|---|---|---|
| `absorbSharedStore()` `:375-441` | **否** | 目标目录恒为 `this.workspace.store.dir`（`:386-392`）；搬运用 `renameSync` `:407`、合并清单 `writeFileSync(targetManifestPath,…)` `:420`、`copyTreeMissing(shared/blobs|staged|staged-ext → target/…)` `:421-423`。**源与目标都在 `.dshstage` 内**；`:432` 的 `publish()` 只写 `<store.dir>/review.json`。 |
| `adoptLegacyStore()` `:1075-1103` | **否** | `renameSync(legacyDir/<name> → targetDir/<name>)` `:1093`，两边都是 `.dshstage` 子树。 |
| `copyTreeMissing()` `:1109-1134` | **否（目标由调用方给）** | 唯一 `copyFileSync` 在 `:1130`，调用点只有 `:409`（整份搬的降级）与 `:421-423`（blobs/staged/staged-ext）。 |
| `reconcileCandidates()` `:965-986` | **否** | 只做 `ws.discardCandidate()`（写 `candidates/*.json` + `queue.json`）。`:963` 注释："只在**变更路径**（`reject()`）调用：轮询只读路径绝不改状态"。 |
| `publish()` `:781-785` | **否** | `writeFileAtomic(this.reviewPath(), …)`，`reviewPath()` `:360-362` = `<store.dir>/review.json`。 |
| `snapshot()` `:613-676` / `frozenOnlyRows()` `:537-588` | **否（纯读）** | 只 `statSync`/`hashFile`（`realHashOf()` `:591-599`）与 `listReviews()`；`:534` 注释："本方法是**纯读**：不改任何状态"。 |
| `revert()` `:989-1007` | **否** | 删清单条目 + `rmSync(ws.staged(rel))`（**暂存对象**，非真实文件）。 |

### 1.3 `staging-fs.mjs`：有没有"读完就把暂存投影回真实磁盘"的逻辑？

**没有。** 逐条核对：

- `writeText` `:550-600`：`super.writeText` 只在两种情形走（`:552` 开关关、`:555/:559` 非本工作区/映射不出），其余一律 `ws.writeFile(abs, content, {origin:'dsh-tool'})` `:593` → `src/workspace.mjs:695-717`，其中真实落盘语句**不存在**：`putBlob` `:701`（写 `.dshstage/blobs`）、`writeFileSync(stagedPath, buffer)` `:704`（写 **`staged/`**）、`store.touch` `:715`（写 manifest）。**真实磁盘一位不改**（与 `:692` 注释一致）。
- `editText` `:602-639` 同构（`:634` `ws.writeFile`）。
- 读取面（`readText :792`/`readBytes :820`/`stat :755`/`listDir :859`…）只从 `store.readBlob(entry.stagedHash)` 与 `super.*` 返回数据，**没有任何写调用**。
- 唯一两处"直写真实磁盘"是显式逃生口 `if (place.external && stageOutside === 'direct') return super.writeText/editText(...)`（`:567-569` / `:616-618`）：**默认关闭**（`fs-entry.mjs:36` `stageOutside: process.env.WINSTAGE_STAGE_OUTSIDE === 'direct' ? 'direct' : 'stage'`），且它是**立即**直写、不产生"延迟"。`[引用]`
- 第三处是 `stagingEnabled()` 为假时的整片回退（`:418-430`，`get sandboxMode` `:439-442`）。此时**根本没有暂存**，因此不构成本问题（但会影响当前会话，见 §5）。`[引用]`

### 1.4 `src/workspace.mjs` 的 `materializeForExecution()` / 其它 `writeFileSync` 调用点

`src/workspace.mjs:1171-1189`：

```js
  materializeForExecution() {
    const report = { copied: 0, failed: [] }
    for (const [rel, entry] of Object.entries(this.manifest.entries)) {
      if (entry.state === STATE.DELETED) continue
      if (entry.kind === 'dir') { mkdirSync(this.staged(rel), { recursive: true }); continue }
      const target = this.staged(rel)                       // ← staged/ 或 staged-ext/，不是真实路径
      try { mkdirSync(dirname(target), { recursive: true })
        if (this.store.hasBlob(entry.stagedHash)) writeFileSync(target, this.store.readBlob(entry.stagedHash))
```

⇒ 目标恒为 `store.staged(rel)`（**暂存树**）。调用点只有 `src/cli.mjs:201` 与 `dsh-plugin/shell-executor.mjs:840`。
该文件全部 `writeFileSync`：**仅 `:704`（staged 对象）与 `:1182`（staged 树）**；真实落盘 `writeFileAtomic` 仅 `:1165`。`[实测]`（grep 全量结果：`workspace.mjs` 里 `writeFileSync|writeFileAtomic|copyFileSync|renameSync|materializeForExecution` 共 6 处命中，见上）

### 1.5 `host-plugin.mjs` 的启动 / probe / reconcile 路径

- 启动：`apply()` `:630-720` 只注册命令面（`:680-693`）、装配运行后捕获（`:698-707`）、跑能力探测（`:714` `probeRuntime()`）。
- `probeRuntime()`（`dsh-plugin/provider.mjs`）确实**会写真实磁盘**，但写的是它自己的探针：`:201` `insideTarget = join(stagingRoot,'inside.txt')`、`:217` `outsideTarget = join(process.env.TEMP,…)`（后者的期望结果是 **DENIED**，`:224`）。**它不写任何暂存内容**。`[引用]`
- `serviceFor()` `:660-677` 里的 `absorbSharedStore()`（`:675`）—— 见 1.2，只在 `.dshstage` 内搬运。
- `refresh` 命令 `:238-241` → `publish()` → 只写 `review.json`。
- 运行后捕获钩子 `installRunCapture()` `:466-626`：**默认关闭**，`:469` `if (env.WINSTAGE_CAPTURE !== '1') return {enabled:false}`；开启时其落盘走 `run-capture` 的 `store.materializeBlob`（见 §6 第 4 项）。

### 1.6 `src/cli.mjs` 的 `exec` 分支会不会间接触发落盘？

**不会。** `src/cli.mjs:201` `workspace.materializeForExecution()` → 只写暂存树（见 1.4）；`:232` 把它放进报告。CLI 里**唯一**调用 `applyCandidate` 的是 **`apply` 子命令**（`:312-333`，`:323`）——那是"批准"的另一个入口，不是 `exec`。`[引用]`

---

## Q2 触发者：这个动作由谁触发？

**用户命令面**，不是定时器、不是面板轮询、也不是启动期 reconcile。

- **直接证据** `[实测]`：会话 b5a590d5 的 transcript 中 5 条 `command/run` 的 `data.source` 逐字为 `{"kind":"user"}`；`command/done` 返回 `{"kind":"success","text":"已应用 1 项"}` 等（若是开关关闭态，`host-plugin.mjs:228-229` 的 `DISABLED_TEXT` 会返回完全不同的文本，实测**没有**出现）。
- **代码链** `[引用]`：
  `client.js:701-706 runCommand` → `ctx.remote.commands.execute(sessionId, line, [])`；
  调用点仅两处，都是 **UI 手势**：`:1551`（面板"批准"按钮，`WinStageReview` 组件内）与 `:2031`（权限芯片）；注入点在 `:2389` / `:2462`。
  → `host-plugin.mjs:261-295` 的 `approve` 处理器 → `:289 service.approve(paths, {...})`。
- **`client.js` 的 poller 不会经 command 面触发写** `[实测]+[引用]`：`tick`（`client.js:713-811`）里唯一的远端调用是 `readReview(...)`（`:747`）——通过 `ctx.remote.workspaceFiles.read` 读 `review.json`；其余是本地 `store.publish`。整个 `tick` 里**没有** `runCommand`。`runCommand` 只在 `:1551`/`:2031` 被用户手势触发。
- **另一进程的 CLI**：`node src/cli.mjs apply`（`cli.mjs:323`）会写同样的文件，但**与观察不符**：CLI 不产生 `command/run` 记录，而本轮的 5 次落盘与 5 条 `command/run` **毫秒级对齐**（§0.1）。`[实测]`
- **启动期 reconcile**：`staging-fs`/`review-service` 的"自愈"只有 `adoptLegacyStore`/`absorbSharedStore`，目标都在 `.dshstage` 内（§1.2）。启动期没有任何真实工作区写入。`[引用]`

---

## Q3 时机：为什么延迟是"分钟级"？

**因为那不是延迟，是"人还没点批准"。**

- **host 侧零定时器** `[实测]`：对 **live 部署副本** `C:\Users\Administrator\.dsh\profiles\web\node_modules\@local\dsh-winstage-sandbox\*.mjs|*.js` 全量 `Select-String 'setInterval|setTimeout'`，只有两处命中，且都在 **client.js**：`client.js:813 setInterval(tick, POLL_MS)`、`client.js:1553 setTimeout(...)`。
- **唯一的周期常数** `[引用]`：`client.js:57 const POLL_MS = 1500`（1.5 s）。若延迟由它造成，量级应是 **秒**、且**每次**都会发生；实测 5 次落盘全部发生在**有 `command/run` 的那一拍**，而不是任意一拍。
- **实测间隔** `[实测]`：write 10:30 → 批准 10:35:05（≈4.5 min）；write 10:38:33 → 批准 10:39:04（≈31 s）。两者都等于"下一次用户批准"的时刻。
- 写路径上确实有**状态机**写入（`staging-fs.mjs:595-596 markFresh()+afterMutation('dsh-write')` → `ensureCandidate()`+`publish()`），但它们只写 `<store.dir>/manifest.json|queue.json|candidates/*.json|review.json`，**不写真实工作区**（§1.2/§1.3）。这正是"工具一回执就立刻能看到候选、而真实磁盘一动不动"的原因。

---

## Q4 `appliedPaths` 是何时、由哪段代码写入的？它和真实落盘的先后关系？

### 4.1 写入点唯一，且在落盘**之后** `[引用]`

`appliedPaths` 在**全仓库只有一处**赋值：`src/workspace.mjs:1088`（grep 全仓 `appliedPaths` 命中源文件仅 `src/workspace.mjs:1088/1094` 与 `review-service.mjs` 的读取/透传）。

```js
    for (const change of chosen) {
      …
      try { this.applyOneChange(change, opts); applied.push({ path: change.path, op: change.op }) }  // :1066-1067 ← 落盘在此成功
      catch (error) { failed.push({ path: change.path, op: change.op, code: …, message: … }) }        // :1068-1070
    }
    …
    candidate.appliedAt   = new Date().toISOString()                                                  // :1087
    candidate.appliedPaths = [...(candidate.appliedPaths || []), ...applied.map((a) => a.path)]       // :1088
    candidate.lastApply   = { applied, failed, blockedByMask, maskWarnings }                          // :1089
    this.store.saveCandidate(candidate)                                                               // :1090  ← 此刻才可被外部读到
```

⇒ **单文件内的时序是**：`writeFileAtomic` 完成（`:1165`）→ `applied.push`（`:1067`）→ `appliedAt`（`:1087`）→ `appliedPaths`（`:1088`）→ **持久化**（`:1090`）。
⇒ **不存在"`appliedPaths` 已落盘、而目标文件还没写"的时间窗**（对 `create`/`modify` 类而言）。

### 4.2 唯一真实存在的"记账 ≠ 磁盘"情形：删除类墓碑 `[引用]`

`src/workspace.mjs:1142-1154`：删除类（或 `after.hash === 'absent'`）走的是

```js
    if (change.op === 'delete' || change.after?.hash === hashAbsent()) {
      if (existsSync(abs)) { … rmSync(abs, …) }
      return                                  // ← 目标本就不存在时：什么都不做，但仍是"成功"
    }
```

因此"删除一个从未存在的对象"会进 `appliedPaths` 而磁盘上没有该文件——这是**设计内的**（`review-service.mjs:508-517` 与 `docs/实测证据记录.md:639` 都逐字记过；`diffEntries()` 也刻意跳过这类墓碑，`src/workspace.mjs:786`）。
**但它不适用于 Lead 报告里的那一条**：`cs_0005` 的该条 change 是 `{"op":"create","kind":"file","before":{"hash":"absent"},"after":{"hash":"5f8ecc23…"}}`（我实测读出），`after.hash` 不是 `absent` ⇒ 不会走删除分支。`[实测]`

### 4.3 那 §8.3 的"`applied=True / realExists=False`（违反计数=1）怎么解释？

我**未能**复现该违反，且本轮实测给出三个可验证的替代解释（前两个可在本机按需重放）：

**(a) 相对路径判据 —— 强候选** `[实测]`
`ctx.shell`（pwsh）的 cwd 是**暂存树**，不是真实工作区：`shell-executor.mjs:883` `cwd: stagedDir`（`:884` 另给 `logicalCwd: workspace.root`）。本会话实测：

```
cwd                      = C:\Users\Administrator\.dshstage\sessions\256e5ced-…\staged   （空目录）
Test-Path 'docs\dsh2-越界与注册表-实测诊断.md'                 → False     ← 相对路径
Test-Path 'C:\Users\Administrator\Desktop\WinStageSandbox\docs\dsh2-越界与注册表-实测诊断.md' → True
```

⇒ **在沙箱 shell 里，任何相对路径的存在性判据对工作区文件恒为 False**，与真实磁盘无关。§8.3 打印的正是裸相对路径 `docs\dsh2-…md`。
（同理 `C:\Users\Administrator\.dshstage\…` 与 `Desktop\WinStageSandbox\.dshstage\…` 是**两套 store**，shell 侧根是 `C:\Users\Administrator`；见 `C:\Users\Administrator\.dshstage\sessions\256e5ced-…\manifest.json` 的 `workspaceRoot:"C:\\Users\\Administrator"`。）

**(b) 编码陷阱 —— 同一个文件两种读法给出两个文件名** `[实测]`
同一份 `cs_0005_7dbce141.json`：
- 用 `Get-Content -Raw`（经 shell 捕获链）读出的是 **GBK 乱码名** `docs\dsh2-瓒婄晫涓庢敞鍐岃〃-瀹炴祴璇婃柇.md`；
- 用 `node` 直接 `fs.readFileSync` 读同一文件、并以**码点**打印，得到 `64 6f 63 73 5c 64 73 68 32 2d 8d8a 754c 4e0e 6ce8 518c 8868 2d 5b9e 6d4b 8bca 65ad 2e 6d 64` = 正确的中文 `docs\dsh2-越界与注册表-实测诊断.md`；磁盘上同名文件确实存在（19 字符条目，码点一致）。

⇒ 任何把"读出来的字符串"直接拿去 `Test-Path` 的探针，在编码被破坏的那条通道上会**必然**得到"不存在"。

**(c) 朴素 hash 校验在"同路径被多次批准"时必然误报** `[实测]`
`docs\dsh2-越界与注册表-实测诊断.md` 被批准/写入了 3–4 次（`cs_0005` 5f8ecc → `cs_0008` 18ed53 → `cs_0009` 7cb186 → 10:46:19 直写 47bf0696）。
我按 `queue.json.order` 全量复核**今日**盘面（脚本：读各候选 `appliedPaths`，逐条 `fs.existsSync` + `sha256`）：

```
9 条 appliedPaths（cs_0002×2、cs_0005×1、cs_0007×4、cs_0008×1、cs_0009×1）→ 全部 exists=true
其中 6 条 diskHash === candidate.changes[i].after.hash
    3 条不等，且全部是同一个路径 docs\dsh2-越界与注册表-实测诊断.md
        cs_0005 承诺 5f8ecc… / cs_0008 承诺 18ed53… / cs_0009 承诺 7cb186… ，现盘 47bf0696…
```

⇒ 若判据是"这份候选的 `after.hash` == 当前磁盘 hash"，则在该路径上会产生 **3 条**"违反"，**哪怕每一次落盘都成功**（现盘 47bf0696 是 10:46:19 那一次**未经暂存**的直写，见 §5）。这正是把"被后续写入覆盖"误读成"账本说谎"的机制。

**诚实标注** `[未实测]`：§8.3 的原始探针脚本**不在仓库里**（全仓 grep `违反计数` 只命中该报告正文，无脚本），因此我**无法**判断它当时用的是哪种判据、cwd 是什么、编码通道是否被破坏。上面的 (a)(b)(c) 是**可复现的替代解释**，不是对那次具体测量的复现。
**需要什么条件才能定论**：见 §7 实验 E1/E2。

---

## 5. 当前会话（256e5ced）还能复现吗？—— 一个必须说清的边界

`[实测]` live profile `C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml`（mtime 10:51:17）里：

```yaml
- id: winstage-sandbox
  config:
    enabled: false          # ← :51（`winstage-fs`/`winstage-shell` 仍 enabled）
```

按 `staging-fs.stagingEnabled()`（`:418-430`，读 `winstage-sandbox` 行的 `config.enabled`）与 `host-plugin.mjs:643 isEnabled()`：

- **开关关闭 ⇒ `ctx.fs` 的每个覆盖层早退到 `super.*`（`:552`/`:603`/`:756`/`:772`/`:793`…）⇒ 根本没有暂存**：没有 manifest 条目、没有候选、没有 `review.json`、也就**没有"延迟物化"可言**。
- 连带效应：`host-plugin.mjs:225-229` 的 `approve` 会返回 `DISABLED_TEXT`（"暂存与审阅面未接管…命令不会执行"），面板轮询在 `client.js:723` 直接 `idle` 卸载。
- **证据**：`Desktop\WinStageSandbox\.dshstage\sessions\` 下**没有** `session-256e5ced-…` 目录（本会话未产生任何暂存），而 b5a590d5 等旧会话有。
- 本会话观测到的 `command/run` 与 `docs\dsh2-越界…md` 的延迟证据，**全部来自 b5a590d5 会话（10:16–10:46）**，当时的开关是**开**的（否则 `/winstage approve` 不可能返回"已应用 N 项"）。

⇒ **建议 Lead 把"当前开关状态"写进后续结论**：在 `enabled:false` 下既不会复现延迟，也**不再有暂存保护**；两者不能混为一谈。

### 5.1 本报告的写入本身，就是这条边界的单变量实测 `[实测]`

我在本会话（256e5ced）用 `write` 工具创建了本文件，然后**立刻**（同一分钟，间隔约 3 s）用绝对路径复核：

```
write 工具回执 : Created file
now            : 11:03:30.629
绝对路径 exists : True      size=31694   birth=11:03:27.352   mtime=11:03:27.353
fs 侧 store    : .dshstage\sessions\ 下【不存在】session-256e5ced-…（现有 7 个目录，全是 10:39 以前的旧会话）
暂存副本       : 两套 store 全树搜索 *延迟物化* → 【0 命中】
相对路径 exists : False     ← 陷阱①再次复现（cwd = 空的 staged 目录）
```

⇒ 本会话 `ctx.fs` 的写入是**即时直落真实磁盘**（零延迟、零暂存）。这与 §5 的配置读数（`enabled:false`）互相印证，也说明：
**"暂存 + 延迟物化"只在开关为 `true` 时存在；开关为 `false` 时既无延迟、也无隔离**。
因此后续任何"延迟物化"的复现实验，**第一步都必须先确认开关状态**（§7 前置条件 1）。

---

## 6. 候选路径清单（含排除项与理由）

| # | 候选路径（文件:行） | 能否把**暂存内容**写到真实磁盘 | 证据 / 排除理由 |
|---|---|---|---|
| 1 | `review-service.mjs:811` → `workspace.mjs:1066` → `:1165` `writeFileAtomic(abs, content)` | **能（唯一）** | `[实测]` 5 次落盘与 5 条 `command/run`/`appliedAt` 毫秒级对齐；blob→真实路径的语义正确 |
| 2 | `workspace.mjs:1142-1154`（删除分支 `rmSync(abs)`） | **能（删除）** | 批准路径的一部分；同 `applyCandidate` |
| 3 | `src/cli.mjs:312-333`（`apply` 子命令 → `:323 applyCandidate`） | **能（同一引擎，另一入口）** | `[引用]` 与 `[实测]` 排除：本轮 5 次落盘都伴随同一会话的 `command/run`，CLI 无此记录 |
| 4 | `src/store.mjs:234-251 materializeBlob`（写**任意**目标路径） | **能，但本轮未生效** | 调用者**只有** `run-capture.mjs:690`（`hashAbsent()` → `rmSync`）与 `:700`（还原 before）。`[实测]` **两套 live store 里都没有 `capture-mirror.json`**（全仓只有 `.t\capture-*\`、`.t\wiring-ws\` 等夹具里有）⇒ `WINSTAGE_CAPTURE=1`（`host-plugin.mjs:469`）在这一轮**从未打开**。语义上它是"把主机还原成执行前/删除新建文件"，方向与观测相反 |
| 5 | `staging-fs.mjs:567-569` / `:616-618`（`stageOutside==='direct'` → `super.writeText/editText`） | 能（工作区**外**路径） | 默认 `'stage'`（`fs-entry.mjs:36`，仅 `WINSTAGE_STAGE_OUTSIDE=direct` 打开）；且是**立即**直写，不产生延迟 |
| 6 | `staging-fs.mjs` 全片 `super.*` 回退（`:552/:555/:559/:603/:756/:772/:793/:809/:821/:841/:860`） | 不适用（此时**无暂存**） | `[实测]` 当前 live profile `enabled:false` ⇒ 走这条路。无暂存 ⇒ 无"物化"，且立即落盘 |
| 7 | `review-service.mjs:375-441 absorbSharedStore()`（`renameSync :407`、`writeFileSync :420`） | **否** | 源=`<root>/.dshstage`，目标=`<store.dir>`（会话隔离子目录），**都在暂存根内**；`:430-432` 只 `init/markFresh/publish` |
| 8 | `review-service.mjs:1075-1103 adoptLegacyStore()` / `:1109-1134 copyTreeMissing()` | **否** | 目标恒为 `store.dir`/`.dshstage/sessions/<key>`；`:1130 copyFileSync` 的调用点只有 `:409`/`:421-423` |
| 9 | `review-service.mjs:781-785 publish()` | **否** | 只写 `<store.dir>/review.json`；6 个调用点（`:432/:451/:817/:876/:946` + `host-plugin.mjs:239`）都不带真实路径 |
| 10 | `review-service.mjs:965-986 reconcileCandidates()` | **否** | 只 `discardCandidate()`（`candidates/*.json`+`queue.json`）；`:963` 明确"轮询只读路径绝不改状态" |
| 11 | `review-service.mjs:613-676 snapshot()` / `:537-588 frozenOnlyRows()` | **否（纯读）** | 只 `statSync`/`hashFile` |
| 12 | `review-service.mjs:989-1007 revert()` | **否** | 删**暂存对象** `ws.staged(rel)` + 清单条目 |
| 13 | `workspace.mjs:1171-1189 materializeForExecution()`（`:1182 writeFileSync`） | **否** | 目标 = `this.staged(rel)`（`staged/`|`staged-ext/`）。调用点 `cli.mjs:201`、`shell-executor.mjs:840` |
| 14 | `workspace.mjs:695-717 writeFile()`（`:704 writeFileSync(stagedPath)`） | **否** | 目标 = `store.staged(rel)`；`ctx.fs` 的写工具走这里 |
| 15 | `run-capture.mjs:622-707 capture()/stage()`（`:422 workspace.writeFile(abs, readFileSync(abs))`、`:690/:700 materializeBlob`） | 否（写暂存方向相反）/ 未启用 | 见 #4；`:422` 是"把真实内容读进暂存"，方向相反 |
| 16 | `host-plugin.mjs:466-626 installRunCapture()` prime/post 钩子 | 否（自身不写） | 落盘全部经 `store.materializeBlob`（#4） |
| 17 | `provider.mjs:201-231 probeRuntime()`（`:204 writeFileSync(insideTarget)`、`:220 outsideTarget`） | 能（**探针文件**，非暂存内容） | `[引用]` 目标是它自建的临时 stagingRoot 与 Temp；检查 4 的期望结果是 DENIED |
| 18 | `host-plugin.mjs:238-241 refresh` → `publish()` | **否** | 只 `review.json` |
| 19 | `client.js` poller（`:813`/`:713-811`） | **否** | 只 `readReview`（`:747`）+ 本地 `store.publish`；`runCommand` 只在 `:1551/:2031` 用户手势 |
| 20 | `src/cli.mjs:201 exec` 分支 | **否** | 只 `materializeForExecution()`（#13） |

---

## 7. 最小可执行的下一步实验设计

> 目标：把"落盘 == 批准"这条因果**钉死到可断言**，并顺带把"§8.3 违反"的来源分离出来。
> 执行者：Lead（或任一在**开关开**的会话里能发命令的成员）。观察者：另一进程的普通 PowerShell / `node`（**必须用绝对路径**）。

**前置条件（缺一不可）**
1. `C:\Users\Administrator\.dsh\profiles\web\cordis.patch.yml` 的 `winstage-sandbox.config.enabled` = **true**（改完需重启 `dsh web`，并确认 `review.json` 会被发布）；否则本轮无暂存。
2. 记录当前时刻与 `.dshstage\sessions\<sessionId>\` 的 store 路径（fs 侧根 = `C:\Users\Administrator\Desktop\WinStageSandbox`）。
3. 探针一律用**绝对路径**，且输出走 `node`（避免 shell 捕获链的编码/相对路径两个陷阱）。

**E1（判据：工具回执 ≠ 落盘，落盘只在批准发生）**
1. 观察进程先跑：`node -e` 打印 `Date.now()` 与目标绝对路径的 `fs.existsSync`、`fs.statSync().birthtimeMs`。
2. Agent 用 `write` 工具创建 `docs\__dm_probe_<随机>.md`（全新路径）。
3. **T+0 / T+5s / T+30s** 各查一次真实磁盘 → **预期全部 `exists=false`**；同时查 store：manifest 出现该条目、`staged/` 有对象、`review.json.pending=true`。
4. 用户执行 `/winstage approve "docs\__dm_probe_<随机>.md"`。
5. 立刻（同秒）查：`exists=true` ∧ `birthtimeMs` ≈ 该候选 `appliedAt`（±50 ms）∧ `candidate.appliedPaths` 含该路径。
   **判据**：第 3 步恒 false、第 5 步恒 true 且时间对齐 ⇒ "物化=批准"确证；若第 3 步提前为 true ⇒ 存在第二条写者，回到 §6 逐项插桩。

**E2（判据：分离 §8.3 违反的三种来源）**
对同一条 `appliedPaths` 记录，**分别**用四种判据各算一次违反：
① 绝对路径 + `existsSync`；② 相对路径 + `existsSync`（在沙箱 shell 里，cwd=staged）；③ 磁盘 hash == `candidate.changes[i].after.hash`；④ 磁盘 hash == 该候选 `lastApply` 时的 hash。
**预期**：①=0；②=全部（证明相对判据不可用）；③在"后来被再次批准的路径"上>0（证明显式是"被后续批准覆盖"，不是"记账说谎"）；④=0。
**这一步能直接判定** Lead §8.3 的那一次是测量缺陷还是产品缺陷。

**E3（可选，验证 run-capture 这条"潜在第二写者"）**
在**独立夹具**（`.t/` 下的临时工作区，不要用现役 store）里设 `WINSTAGE_CAPTURE=1`，跑一次会写文件的 `pwsh`，然后：
① 检查 `<store.dir>/capture-mirror.json` 是否出现；
② **重点核对 `run-capture.mjs:727-736` 的镜像刷新**：对 `kind!=='created'` 的条目，无论 `restore` 是否把磁盘还原成 before，写入镜像的都是 `hash: change.afterHash`（`:735`）。
若 restore 已把磁盘复位，则镜像与磁盘**故意不一致**；下一次以"磁盘镜像"为基准的捕获会把它判成 modified，并在 restore 时 `materializeBlob(镜像里那份 hash, …)` ——**这构成一条"把旧内容重新写回真实磁盘"的延迟通道**。本轮 `[未实测]`（`WINSTAGE_CAPTURE` 未开启，无 `capture-mirror.json`），但**必须在开启捕获前先验这一条**。

---

## 8. 取证方法与两个必须留痕的陷阱

1. **相对路径判据在沙箱 shell 里恒假** `[实测]`：`shell-executor.mjs:883 cwd: stagedDir`。任何 `Test-Path docs\x.md` / `[ -f docs/x.md ]` 都不能用来判断真实工作区。**改用绝对路径**。
2. **非 ASCII 文件名经 shell 捕获链可能被 GBK 破坏** `[实测]`：同一文件 `Get-Content -Raw` 得乱码名、`node` 得正确码点。**核对文件名一律用码点（`Array.from(s).map(c=>c.codePointAt(0).toString(16))`）**。
3. **两套 store 并存** `[实测]`：fs 侧 `<Desktop\WinStageSandbox>\.dshstage`（`workspaceRoot=…\Desktop\WinStageSandbox`）与 shell 侧 `C:\Users\Administrator\.dshstage`（`workspaceRoot=C:\Users\Administrator`）。只看一套会得出"没有暂存"的错结论。
4. **判定一律以绝对路径 + 内容/时间戳真值**，不以"工具回执"为准（这正是本问题的教训）。

---

## 9. 仍未定论的部分（如实标注）

| 项 | 状态 | 缺什么条件 |
|---|---|---|
| §8.3"违反计数=1"的**原始判据** | `[未实测]` | 原始探针脚本不在仓库；需按 E2 四判据重跑（§4.3 给出三个可复现替代解释，但未复现那一次） |
| `docs\dsh2-越界与注册表-实测诊断.md` 10:46:19 的第 4 次写入 | `[未实测]` | 该次写入在两套 live store 里**都没有任何暂存痕迹**（无 manifest 条目、无候选、无 `review.json` 变化），⇒ 它**未经暂存**。最可能是当时开关已关/正在切换（live profile 的 `enabled:false`、`cordis.patch.yml` mtime 10:51:17、部署副本 `review-service.mjs` 10:44:51 / `shell-executor.mjs` 10:55:23、备份目录 `winstage-backup-before-fix2-20260930-104914` 10:49:14）。**未取得当时的进程日志**，故不下定论 |
| `run-capture` 镜像回写通道（§7 E3） | `[未实测]` | 需在开关开启的独立夹具里跑一次 `pwsh` 并核对 `capture-mirror.json` 与 `materializeBlob` 的落盘 |

> 本文所有 `[实测]` 结论都可按文中给出的**绝对路径 + 命令**重放；未重放的一律标 `[未实测]`，不以推断冒充实测。
