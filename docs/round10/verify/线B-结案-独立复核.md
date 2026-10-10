# 线 B 结案 · **独立复核**（`exe`，2026-10-10；复审版，含对我自己前一版的主动更正）

> 复核对象：`docs\round10\fileio\13d\线B-结案.md`（`line-a-fix` 出件，**只写文档、未改代码/补丁/候选**）
> 我方实测该件身份：**21,074 B / sha256 `3718DF7DE361390CFC74E1F034F8A797955EEDBFB60558992D657228AFDD636E`** ⇒ 与其声明一致。
> 方法：**不读自述下判，逐条取原始行自己复算**。轮次：`b13`（修前 `out-13d-count13`）、`c14`（v1 `out-13d-count14`）、`c15`（v2 `out-13d-count15`）；原始件 `.t\round10\fileio\13d-t4\stage-<K>\staged\{shim.log,evidence\pa-actions.jsonl}` 与我方自己的 `.t\round10\verify\t5\stage-cli-{c14,c15}`。
> **结论：其 4 条核心反证 4/4 成立；"前提证伪 + 回归项"结案成立。但我前一版复核文有一处结论错误，见 §5（已更正并回报 Lead）。**

## 1. 逐条复核（其 4 条核心反证）

### (a) Node 语义：`existsSync` **不是** `statSync` 包 try/catch —— **成立**
我方独立跑（输出落 `.t\round10\verify\t5\existsSync-source.txt`）：
```
v24.21.0
function existsSync(path) { … return binding.existsSync(path); }
```
⇒ 它是**独立的绑定实现**（`binding.existsSync`），不是 `try { statSync } catch`。
**这也更正了我自己此前的错误说法**（我在 `T5-独立复核报告` §3b 与本文旧版里写过"`existsSync` 建在 stat 之上"）——**该说法作废**。

### (c) 决定 `exists` 的**不是** `ATTRDBG-W` —— **成立（附一处必要限定）**
我方按行号逐行取（`[IO.File]::ReadLines`）：
| 轮 | 行 | 内容（`<R>` = 仓库根） |
|---|---|---|
| b13 | L43217 | `[2648][365] ATTRDBG-W rc=0 in=\\?\<R>\.t\…\13d-t4-ws\probe\pa-fixture.txt mapped=<R>\.t\…\stage-b13\staged\fs\…\pa-fixture.txt staged=1 attrs=0x20 err=203` |
| c14 | L43424 | 同上，**仅** `mapped=` 里的 stage 目录名为 `stage-c14` |
| c15 | L43235 | 同上，**仅** `mapped=` 里的 stage 目录名为 `stage-c15` |
⇒ 三条**除"各自的 stage 根目录名"外逐字相同**（`rc=0` / `staged=1` / `attrs=0x20` / `err=203` / 同一 `in=`）。而三轮 `existsSync` = **false / true / true** ⇒ **`ATTRDBG-W` 不是判别量**，其主张成立。
（限定：严格逐字相等**不**成立——`mapped=` 内含每轮各自的 stage 根，必然不同；我按"同形"判并写明差异来源。）

### (d) v1 有回退、v2 无回退 —— **成立**
我方按 pid 独立计数（**判据串必须写成 `ATTRDBG-CFW-OVL … valid=1`**；写成 `CFW-OVL valid=1` 会因中间隔着 `handle=… ` 而误得 0——我第一次就踩了这个字符串坑，特此记录）：
| 轮 | exists/stat/lstat 动作 pid | fixture `ATTRDBG-CFW` | fixture `CFW-OVL`(valid=1) |
|---|---|---|---|
| c14 (v1) | 3500 / 9856 / 4252 | **各 2 条**（含 `desiredAccess=0x80`） | **各 1 条** |
| c15 (v2) | 7256 / 3728 / 6660 | **各 0 条** | 0 条 |
逐行样例（c14 pid 3500，seq 升序）：
```
[540] ATTRDBG-NQIFBN … staged=1 status=0xc000003b class=77 seq=169
[541] ATTRDBG-CFW seq=170 desiredAccess=0x80 share=0x7 disposition=3 flags=0x2000000 path=\\?\…\pa-fixture.txt
[545] read-branch resolved flags=0x11 mapped=<stage-c14>\staged\fs\…\pa-fixture.txt
[546] ATTRDBG-CFW-OVL handle=0000000000000310 valid=1 err=0 path=\\?\…\pa-fixture.txt
[547] CreateFile overlay(read) <stage-c14>\staged\fs\…\pa-fixture.txt
```
c15 三个 pid 的同位置**只有** `ATTRDBG-NQIFBN … nt=\??\… staged=1 status=0x0 class=77`，其后**无任何** fixture `CreateFileW`。

### (4) 机检复跑（免车道、离线） —— **成立**
我用**其脚本** `.t\round10\fileio\13d-t4\verify-v2.mjs` 独立跑三轮（我方输出落 `.t\round10\verify\t5\linesB-mine-{b13,c14,c15}.txt`）：
```
b13 -> exit 1（gate false）
c14 -> exit 1（bad3b=1 / cfwFallback=yes）
c15 -> exit 0（PASS）
```
与其声明一致；其 `.t\round10\fileio\line-b\verify-*.txt` 的取值我也逐项对过。

## 2. 我方补充的三条独立证据（不止复述其结论）

1. **v1 的 `existsSync` 本来就是 `true`**：两个彼此独立的 v1 run 都是——`env-harness` 的 c14（pid 3500）**与我自己的** c14（pid 7644，`stage-cli-c14`，两处 `pa-actions.jsonl` 逐字一致：`"result":true`）。**修前控制 b13 才是 `false`**。
2. **完整因果链（同夹具、同驱动、只换 DLL）**：
   | 轮 | NQIFBN 夹具状态 | 回退 | `existsSync` |
   |---|---|---|---|
   | b13（修前） | `0xc0000034`（硬"未找到"） | **无** | **false** |
   | c14（v1） | `0xc000003b`（换名后真实调用失败） | **有**（CFW → overlay） | **true** |
   | c15（v2） | `0x0`（直接成功，`nt=\??\…`） | **无（不需要）** | **true** |
   ⇒ 唯一与 `existsSync` 同步变化的量是 **NQIFBN 的 status**；`ATTRDBG-W` 三轮同形，回退只在 v1 出现。
3. **真实盘负对照三轮全绿**（`real-fixture.txt` 的 stat/exists 成功）⇒ whiteout 分支未伤真实盘语义。

## 3. `D87` 纪律的现状：**纪律不变，只更正归因**
- `ATTRDBG-W rc=0 … attrs=0x20 err=203`：**成功的调用却带 `err=203`**，三轮同形 ⇒ `err` 是陈旧残留，**继续禁止**作判据（`D88`）。**该纪律成立、未被推翻。**
- 被推翻的仅是 `D87` 当时的**归因**（"W 成功而调用方仍 false ⇒ post-call 返回值被丢弃"）：实测更正为"**调用方（`binding.existsSync`）的最终答案跟随 `NtQueryInformationByName` 的状态**；`GetFileAttributesW` 的成功既非充分、也非必要（三轮同形却结果不同）"。

## 4. 建议回归项（供终版采纳）
- **R-B1**：沙箱内**已暂存文件**的 `existsSync` 必须为 `true`，且**不得依赖失败后回退**。判法（可机械执行）：同 pid 序列出现 `ATTRDBG-NQIFBN … staged=1 status=0x0`，且**其后该路径无 `ATTRDBG-CFW`**。
- **R-B2**：**真实盘**（非暂存）文件的 `existsSync`/`statSync` 必须按其真实状态回答（负对照）。
- **R-B3**：`err` 字段不得进入任何判据（`D88` 回归）。

## 5. **更正声明（我方自查发现的错误，主动上报）**
本文**旧版**（今日早前）有两处错误结论，**现已作废**：
1. ❌ "`existsSync` 建在 `stat` 之上" ⇒ 实为 `binding.existsSync(path)`（§1(a)）。
2. ❌ "v1 … `GetFileAttributesW` 与 overlay `CreateFileW` 都成功，可最终 `existsSync` 仍是 `false`" ⇒ **错**：我把**修前控制 b13** 的 `false` 误当成了 v1（c14）的值；**v1 实为 `true`**（两个独立 run 一致）。
**影响面**：线 B 结案的**主张不受影响**（它主张的正是"决定量是 NQIFBN，而非 W/post-call"）；但旧措辞会让读者以为"v1 也没修好"。已在 `T5-独立复核报告` 同步更正（"建在 stat 之上" → `binding.existsSync`，并注明 v1 的 exists 已为 true）。**该错误不改变任何产品判定。**

## 6. 限制
1. 本文只证明"`existsSync` 结果与 NQIFBN 状态同步、`ATTRDBG-W` 与回退都不是判别量"，**不主张** binding 内部走哪条 syscall（未做源码级确认）。
2. `(c)` 的"逐字相同"按**同形**成立（差异仅为每轮各自的 stage 根目录名，属 `mapped=` 的必然组成）。
3. 结案件若在我复核后再次改动，以其新哈希为准（本文记录 `3718DF7D…36E` / 21,074 B）。
