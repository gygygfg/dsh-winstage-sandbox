# 2c 结论：NO-DEFECT（前提被推翻，无产品改动）

结论：`appliedPaths` 不存在"声称已应用、磁盘却不存在"的缺陷 ⇒ 2c 不实现，产品代码无 2c 改动。
回滚已验证 **[实测]**：`review-service.mjs` = 57934 B / 1164 行（与改动前逐字节同尺寸），7 个 2c 标记
（`auditAppliedPaths`/`appliedMissingOnDisk`/`appliedAudit`/`LEDGER_LIVE_STATUSES`/`CANDIDATE_STATUS`/
`appliedAlerts`/`appliedMissingByCandidate`）全为 0；`node --check` exit 0；2b 验证器 **16 ok / 0 bad**。

## 1 错误判据 → 正确判据（原证据的成因）
沙箱 shell 的 cwd = `<store>\sessions\<id>\staged`（暂存树）⇒ **相对路径**判据测的是暂存树里的同名路径。[实测]：
```text
相对 'Desktop\WinStageSandbox\docs\dsh2-越界与注册表-实测诊断.md' : False
绝对 'C:\Users\Administrator\Desktop\WinStageSandbox\docs\dsh2-越界与注册表-实测诊断.md' : True
相对 'dsh-plugin\review-service.mjs' : False   ← 该文件确定存在，判据仍为 False
绝对 '…\WinStageSandbox\dsh-plugin\review-service.mjs' : True
```
⇒ `applied=True realExists=False` 是相对判据的假象。可复现脚本 `docs/dsh2-2c-selftest.mjs`（6 ok / 0 bad）。

## 2 代码层判据（`src/workspace.mjs`，[实测]）
`applyOneChange` 1066（try 内，抛错→`failed`）→ `applied.push` 1067 → `appliedPaths` 1088 → `saveCandidate` 1090。
对 create/modify，`writeFileAtomic()` 是 `applyOneChange` 的最后一句 ⇒ **先落盘、再记账**，
不存在"记账已写、磁盘未写"的窗口；删除类的 appliedPaths 按设计就不在磁盘上。
（`dsh2-2c-selftest.mjs` 的 R2 打印这四个行号，任一序次变化即 FAIL。）

## 3 我自己的独立证据：产品写入路径端到端（[实测]）
`writeFile(绝对目标)` → `afterMutation()` → `approve()`（真 ReviewService + 真磁盘），独立复核：
`appliedPaths=["docs\real-layer.md"] status=applied`，`exists(ws.absolute(appliedPaths[0]))=true`（账本与磁盘一致）；
批准后 `alerts=[]`、`missing=0`；只有**人为 rm 掉真实文件后**才出现"缺失"信号（该信号只存在于已回滚的 2c 试做版）。

## 4 顺带发现：原 2c 措辞本身会变成缺陷工厂（[实测] 5 条夹具）
照字面"appliedPaths 里不存在就报响"实现 ⇒ 每次**批准删除**都永久刷假警报（删除成功的形态就是文件消失）；
且 `mkdir` 的 `after.hash` 也是 `'absent'`（`src/workspace.mjs:866`），照它判删除类会**静默漏检**"目录没建出来"。
⇒ 原措辞缺"期望存在/期望不存在"的区分，不宜直接落地。

## 5 未复核项（如实标注）
Lead 第 3 条（4.5 分钟 = 用户命令面 `/winstage approve` 与回执的人为间隔）我**未**独立复核 transcript，
标 `[未复核]`；它对结论不是必要条件（1–3 已足以判定 NO-DEFECT）。
装机级回归门 `autotest.cmd --skip-audit` **需用户在外部跑**（本会话 shell 不能写 `.t\`）。
