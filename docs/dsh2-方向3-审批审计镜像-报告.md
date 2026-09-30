# 方向 3：把「暂存审批」镜像进「会话审计面」

> 执行者：Lead（本轮亲手定因 + 实现 + 验证）
> 时间：2026-09-30
> 判定标记：`[实测]` = 真跑过并留原始输出；`[引用]` = 只读源码所得；`[未实测]` = 缺条件

---

## 1. 根因（一句话）

**WinStage 的暂存审批完全不写会话 transcript。**
实测判据：`dsh-plugin/**` 里 `session.append | ctx.session | .append( | audit` **0 命中**。

而原生审批把每次询问写成会话日志里的一对事件（`dsh-user-approval/lib/index.js:128-144`）：

```
approval/asked  →  await decide()  →  approval/decided
```

⇒ 两套审批的"真相"**物理上不在一个地方**：

| | 原生审批 | WinStage 暂存审批 |
|---|---|---|
| 状态存哪 | **会话日志**（`approval/asked`→`decided`） | 自己的 `review.json` |
| 共享 id | — | **无** |
| 共同清除路径 | — | **无** |
| 重放/恢复时对方知情吗 | — | **不知情** |

这就是用户最初那句"**沙箱审批会和原来的审批冲突**"的最底层形态：
不是两套逻辑谁对谁错，而是**它们没有共同的账本**。

---

## 2. 复用原生范式（不是新发明）

原生 `request()` 有两条本文刻意照抄的性质：

1. **回合内校验**（`:130` 硬抛错）：`approval/asked`/`decided` 必须**成对且回合内**，
   因为"回合之间"的事件与**崩溃尾巴**无法区分、重放时会被静默丢弃。
   → 复刻 `hasOpenTurn()`（`:49-56`：**倒序**扫 `turn/start`/`turn/end`）。
2. **`decided` 在决策之后才落** ⇒ 中断时 `asked` 无 `decided` = 孤儿（核侧已知缺口 `[引用]`）。

---

## 3. 实现（3 个文件）

| 文件 | 改动 |
|---|---|
| **`dsh-plugin/audit-mirror.mjs`**（新增） | `hasOpenTurn()`、`winStageApprovalId()`、`createAuditMirror({sessionOf,log,logError})` ⇒ `ask()` / `decide()` |
| **`dsh-plugin/review-service.mjs`** | 构造器加**可选** `options.audit`；`afterMutation()` 在 `frozen===true` 时 `ask`；`approve()` 全部成功时 `decide(approved:true)`；`reject()` 对受影响候选 `decide(approved:false)` |
| **`dsh-plugin/host-plugin.mjs`** | 导入 `createAuditMirror`；`serviceFor(invocation)` 注入 `audit`（`sessionOf` **每次现读** `invocation.agent.session`） |

### 事件载荷（与原生同词汇）

```
approval/asked    { id: 'winstage:<candidateId>', toolName: 'winstage-stage', reason }
approval/decided  { id: <同一个>, outcome: 'allowed-once' | 'rejected', pathCount?, note? }
```

- 批准 = `'allowed-once'`（原生**唯一**的授予值）。
- 拒绝 = `'rejected'`。
- **命名空间** `winstage:` 防与原生 `ApprovalRequestId` 撞号。

### 三条硬约束（都落地了）

| 约束 | 落地方式 | 断言 |
|---|---|---|
| 回合内才算 | `hasOpenTurn` 倒序扫描；回合外**不写** + info 日志 | T1–T4 |
| 审计失败**绝不影响审批** | append 抛错吞掉 + error 日志 | E1–E3、R6 |
| 不重复写 | 只在 `frozen===true` 时 `ask`（幂等早退不写） | R2 |
| 不提前闭合 | `approve()` **全部成功**才 `decide`；部分失败 ⇒ 留 pending | R3 |
| 不造孤儿 id | `reject()` 按**受影响候选**闭合，绝不用 `undefined` | R4 |

**为什么 `audit` 是可选注入而不是让 `review-service` 直接持有 `ctx`**：
本服务刻意保持"纯工作区服务"，既有 20+ 离线断言依赖它不依赖任何 DSH 运行时。
注入回调让 host 侧接线、离线测试**不传** ⇒ 既有断言逐项不变（R5 直接钉住这点）。

---

## 4. 验证（全部 `[实测]`）

### 4.1 方向 3 专项：`docs/dsh2-3-audit-mirror.mjs` → **36 ok / 0 bad / exit 0**

| 组 | 覆盖 |
|---|---|
| H1–H6 | `hasOpenTurn` 的回合判定（空/开/关/重开/夹其它事件/无 session） |
| A1–A12 | 事件名、`winstage:` id、`toolName`、`reason`、**id 成对同一**、`allowed-once`/`rejected` |
| T1–T4 | 回合外**不写**（含"跳过时记 info 日志，不静默"） |
| E1–E3 | append 抛错**不外抛** + 返回 false + error 日志 |
| R1–R6 | `ReviewService` 接线：恰好一次 ask、幂等不重复、批准/拒绝的 decide、不传 audit 照常、audit 抛错不影响暂存 |
| **M1** | **变异体**：绕过接线直接 `freezeCandidate` ⇒ 审计面**没有** ask ⇒ 证明 R1 抓的是接线本身 |

### 4.2 装机级回归门

`.\autotest.cmd --skip-audit` → **14 套件 / 646 ok / 0 bad / exit 0**（与基线逐项一致）。

### 4.3 全部离线验证器

| 验证器 | 结果 |
|---|---|
| `dsh2-3-audit-mirror.mjs` | 36/0 |
| `dsh2-2a-outside-isolation.mjs` | 22/0 |
| `dsh2-fix2-selftest.mjs` | 20/0 |
| `dsh2-shell-fallback-verify.mjs` | 16/0 |
| `dsh2-装配择一-验证.mjs` | 25/0 |
| `dsh2-装配择一-可行性.mjs` | 15/0 |

### 4.4 `[未实测]`（如实标注）

- **活实例端到端**：本会话的 WinStage 开关是**关闭**态（`winstage-sandbox.enabled: false`，
  装配层择一已让平台 shell 接手）⇒ 暂存面不接管 ⇒ **无法在本会话内触发真实的 ask/decide**。
  要端到端验证必须**另开一个 DSH 进程**并把开关打开（用户已明确这条约束）。
- 孤儿 `asked` 的**核侧**缺口（`dsh-user-approval` 不补 `decided`）**不在本仓库范围内**，
  本次只保证 **WinStage 侧**的 asked/decided 成对闭合。

---

## 5. 部署（仓库外需用户执行）

```powershell
$src='C:\Users\Administrator\Desktop\WinStageSandbox\dsh-plugin'
$dst='C:\Users\Administrator\.dsh\profiles\web\node_modules\@local\dsh-winstage-sandbox'
Copy-Item "$src\audit-mirror.mjs"   "$dst\audit-mirror.mjs"   -Force
Copy-Item "$src\review-service.mjs" "$dst\review-service.mjs" -Force
Copy-Item "$src\host-plugin.mjs"    "$dst\host-plugin.mjs"    -Force
foreach($f in 'audit-mirror.mjs','review-service.mjs','host-plugin.mjs'){
  $a=(Get-FileHash "$src\$f" -Algorithm SHA256).Hash
  $b=(Get-FileHash "$dst\$f" -Algorithm SHA256).Hash
  "{0,-22} {1}" -f $f, $(if($a -eq $b){"MATCH $($a.Substring(0,16))"}else{"DIFFER"})
}
```

---

## 6. 与"两套审批冲突"的最终关系（诚实收口）

**本次做到**：两套审批**共享同一个审计面与同一套事件语义** ⇒ 可对账、可检测孤儿、
重放能看到 WinStage 的决策。这是"合并两套审批语义"在**本仓库范围内**能做到的实质一步。

**本次没做（且不应假装做到）**：
- 原生 `ctx.approval` 的**弹窗**仍不会被 WinStage 的暂存动作触发 —— `ApprovalService.request()`
  必须在**调用方自己的回合内**发起（`:130`），而暂存是 fs 提供方内部的副作用，**没有**合法时机同步发起。
  要在 UI 上真正统一，需要 DSH 核提供"从提供方发起审批"的合法通道（本仓库无法单方面实现）。
- 核侧"孤儿 `asked` 不补 `decided`"仍是缺口（`[引用]`，不在本仓库范围）。
