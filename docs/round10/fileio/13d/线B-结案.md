# 线 B 结案：立项前提被 v2 实测**证伪** ⇒ 不立候选，转回归项（doc-only）

> 任务：`task-6`（Lead 2026-10-10 改判）。作者：`line-a-fix`。
> 范围：**只写本文件**，不改任何代码/补丁/候选。红线（`shim/out`、inject/probe 原件、冻结候选、
> `ws_regstore.c`、injection/路径逻辑、`LdrLoadDll` 修复）全程未碰。
> 证据不入库：`.t/**`（`.gitignore:24`）与 `docs/round10/**/evidence/`（`.gitignore:149`）都不入库；
> 本结案件落在 `docs/round10/fileio/13d/`（非 evidence 目录）⇒ **会入库**。

---

## 0. 结论（一句话）

线 B 的立项前提 —— `.t/round10/shim/D87-existsync-deciding-line.txt` 的
「`GetFileAttributesW` 成功返回 `attrs=0x20`，调用方仍见 `false` ⇒ **post-call 返回值被丢弃/改写**」——
**被 v2 候选的实测反证**：决定 `existsSync` 真假的**是按名查询 `NtQueryInformationByName` 的 status**
（其 `ObjectName` 必须是 NT 形态 `\??\C:\…`），**不是** `GetFileAttributesW` 的返回值。
线 A 的 v2 一并把它修好 ⇒ **线 B 不立单独候选**，改列为**回归项**。

> **留痕**：本结案对 Lead 通报的两处更正（①Node `existsSync` 语义；②v1(c14) 的 `exists` 是**回退 credit**）
> 已被 Lead **全部采纳并记入 `task-6` 描述 revision 5**（原表述作废）。
> `exe` 的独立复核（`docs/round10/verify/线B-结案-独立复核.md`，复审版）= **4/4 核心反证成立**
> （(a) Node 语义 / (c) W 不是判别量 / (d) v1 有回退 & v2 无回退 / (4) 机检复跑），判定「前提证伪 + 回归项」**通过**；
> `exe` 并在该文中**主动更正了自己此前的两处错误**（"`existsSync` 建在 `stat` 之上"、"v1 仍为 false"），
> 两份文档的分歧只在**笔者原表述**，**结论无冲突**。

---

## 1. 两轮 + 基线对照表（数字全部来自 `verify-v2.mjs` 机检，原始输出见 §6）

| 轮次 | 候选 | 夹具 `NQIFBN` status | `exists` | `stat` | `lstat` | `read` | 机检 gate |
|---|---|---|---|---|---|---|---|
| `b13` | 基线件 | `0xC0000034` | **false** | `ERR:ENOENT` | `ERR:ENOENT` | OK | `PASS=false` |
| `c14` | v1 = D96 | `0xC000003B` | true（**回退credit**） | `{size:12}`（**回退**） | `{size:12}`（**回退**） | OK | `PASS=false` |
| `c15` | v2 = D98 | **`0x0`** | **true（无回退）** | `{size:12}`（**viaNqifbn**） | `{size:12}`（**viaNqifbn**） | OK | **`PASS=true`** |

`c15` 机检 gate 逐键（`verify-c15-final.txt`，终态日志）：

```
GATE label=c15 PASS=true
  hasStaged1Status0=true
  zeroStaged1Status3b=true
  existsTrue=true
  realDiskControlOk=true
  allFixtureActionsPass=true
  action=exists pid=7256 tag=pa-fixture.txt verdict=PASS successLines=1 bad3b=0 cfwFallback=no result=true
  action=stat   pid=3728 tag=pa-fixture.txt verdict=PASS successLines=1 bad3b=0 cfwFallback=no result={"size":12,"isFile":true}
  action=lstat  pid=6660 tag=pa-fixture.txt verdict=PASS successLines=1 bad3b=0 cfwFallback=no result={"size":12,"isSymbolicLink":false}
  action=read   pid=4532 tag=pa-fixture.txt verdict=PASS successLines=0 bad3b=0 cfwFallback=no result="PER-ACTION\r\n"
```

`c14` 对照（同一脚本、同一判据）：`exists` 的 `result` 也是 `true`，但 `cfwFallback=yes`；
**`stat`/`lstat` 被 gate 判 FAIL**，而它们的 `result` 却写着 `{size:12}` —— 这就是"脆性绿"的机检形态。

**因果链（唯一同步变化量 = `NQIFBN` 的 status）**：

```
b13  NQIFBN 0xC0000034  →  exists=false（真失败）
c14  NQIFBN 0xC000003B  →  libuv 回退 CreateFileW(overlay)  →  exists=true（脆性绿）
c15  NQIFBN 0x0         →  直接 exists=true（无回退）
```

`exe` 独立复核另给了一个**第三方 c14 run**（其自己的 pid 7644）同样 `result:true`，与 `env-harness` 的 c14（pid 3500）一致
⇒ `exists=false` **只**出现在修前控制 `b13`（及 D87 那轮 `pa-out3`），**不是 v1 的属性**。

---

## 2. 反证链（逐条附原始行）

### (a) ⚠ 更正 Lead 通报的口径：Node 的 `existsSync` **不是** `statSync` + try/catch

本主机 Node = **v24.21.0**，`fs.existsSync` 的实现（`node -e "console.log(require('fs').existsSync.toString())"` 原始输出）：

```js
function existsSync(path) {
  try {
    path = getValidatedPath(path);
  } catch (err) {
    if (showExistsDeprecation && err?.code === 'ERR_INVALID_ARG_TYPE') { /* warning */ }
    return false;
  }
  return binding.existsSync(path);
}
```

即：它走 **`binding.existsSync(path)`**（内部的、**不抛异常**的绑定），**不是**把 `statSync` 包进 try/catch
（后者是更早版本 Node 的实现）。探针 `per-action.mjs` 也确认两条动作调用不同 API：

```
line 10:   if (action === 'exists') out.result = fs.existsSync(target)
line 11:   else if (action === 'stat') { const s = fs.statSync(target); ... }
```

⇒ 「`existsSync` = `statSync` 包 try/catch ⇒ 其真假由 stat 那条路决定」这句**在本主机上不成立**。
**但这不改变结论方向**：`exists` 与 `stat` 都落在**同一条 Windows 按名查询**上，见 (b)。

### (b) 决定 `exists` 的是夹具绑定的 `ATTRDBG-NQIFBN`，每个 pid 恰 1 条

`c15` 中三个夹具动作各自的 NQIFBN 原始行（`stage-c15/staged/shim.log`，行号见前）：

```
L43238 [winstage-shim][7256][412] ATTRDBG-NQIFBN pid=7256 handle=0000000000000000 path=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt mapped=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4\stage-c15\staged\fs\C\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt nt=\??\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4\stage-c15\staged\fs\C\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt staged=1 status=0x0 class=77 seq=89
L43682 [winstage-shim][3728][407] ATTRDBG-NQIFBN pid=3728 handle=0000000000000000 path=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt mapped=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4\stage-c15\staged\fs\C\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt nt=\??\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4\stage-c15\staged\fs\C\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt staged=1 status=0x0 class=77 seq=85
L44125 [winstage-shim][6660][407] ATTRDBG-NQIFBN pid=6660 handle=0000000000000000 path=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt mapped=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4\stage-c15\staged\fs\C\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt nt=\??\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4\stage-c15\staged\fs\C\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt staged=1 status=0x0 class=77 seq=85
```

（以上三行为**逐字**全文，无折叠；同一批还可对照 `.t/round10/fileio/13d-t4/collect-c15.log` 第 28-33 行。）

`verify-v2` 计数：`fixtureBound=6`（其中 1 条是 class=4 的**非法裸路径探针** `status=0xc000000d`，
按规格 §7 不计入任何否定）。三个动作各 **1 条**夹具 NQIFBN，`successLines=1`、`bad3b=0`。

### (c) 三轮的 `ATTRDBG-W` **同形**（仅 `mapped=` 里的 stage 目录名各轮必不同），而 `exists` 从 false 翻到 true

三条原始行（分别来自 `b13` / `c14` / `c15` 的 `staged/shim.log`）：

```
b13 L43217 [winstage-shim][2648][365] ATTRDBG-W rc=0 in=\\?\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt mapped=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4\stage-b13\staged\fs\C\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt staged=1 attrs=0x20 err=203
c14 L43424 [winstage-shim][3500][537] ATTRDBG-W rc=0 in=\\?\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt mapped=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4\stage-c14\staged\fs\C\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt staged=1 attrs=0x20 err=203
c15 L43235 [winstage-shim][7256][409] ATTRDBG-W rc=0 in=\\?\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt mapped=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4\stage-c15\staged\fs\C\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt staged=1 attrs=0x20 err=203
```

**术语定义（本节及全文）**：**「同形」= 判别字段逐字相同** —— 即 `rc` / `staged` / `attrs` / `err` / `in=`；
**`mapped=` 不参与该判断**（它是"本轮映射到哪"，`stage-b13` / `stage-c14` / `stage-c15` **各轮必然不同**）。
按此定义，三行**同形**：`rc=0` / `staged=1` / `attrs=0x20`（ARCHIVE，属性正确） / `err=203`（陈旧残留） / `in=` 同值；
而**严格意义的"整行逐字相等"不成立**（`exe` 独立复核已按行号逐行比对确认；其复核文 §7 另有终态重验记录）。
而 `exists` 在 `b13` = **false**、在 `c15` = **true** ⇒
**决定 `exists` 的不是 W 的返回值**，而是同 pid 那条夹具 `NQIFBN` 的 status（`0xC0000034` vs `0x0`）。

> ⚠ **与 Lead 通报口径的差异（须知悉）**：Lead 通报"v1（`0xc000003b`）下 `exists=false`"。
> 实测 `c14` 的 `exists` 动作 `result` = **true**（它被 libuv 的 `0xC000003B` 回退"救"成了绿）：
> 同 pid 检出 `cfwFallback=yes`（`ATTRDBG-CFW … desiredAccess=0x80` + `ATTRDBG-CFW-OVL … valid=1`），
> 且同轮 `stat`/`lstat` 在 gate 里判 **FAIL**（`result` 却是 `{size:12}`）。
> `exists=false` 的读数在 **`b13`**（`0xC0000034`）与 **D87 当时那轮**（`pa-out3`，同为 `0xC0000034`）成立。
> 该差异不削弱结论：反证的支点是 (c) 的"W 行同形而 exists 翻转"与 (d) 的"无回退"，两者都不依赖 v1 的 exists 取值。

### (d) v2 同 pid 链：夹具 `NQIFBN` 之后**再无**该夹具 `CreateFileW` ⇒ 成功来自 NQIFBN 本身

`verify-v2` 的 per-action 判定（含"同 pid、NQIFBN 之后 12 条内不得有该夹具 `ATTRDBG-CFW`"这条硬规则）：

| 轮次 | 夹具动作 | successLines | bad3b | cfwFallback | gate verdict | 动作 result |
|---|---|---|---|---|---|---|
| `b13` | exists/stat/lstat | 0 | 0 | no | FAIL | false / ENOENT / ENOENT |
| `c14` | exists | 0 | 1 | **yes** | PASS（仅凭 result） | true |
| `c14` | stat / lstat | 0 | 1 | **yes** | **FAIL** | `{size:12}` |
| `c15` | exists/stat/lstat | **1** | **0** | **no** | **PASS** | true / `{size:12}` / `{size:12}` |

回退行的原始凭据（`c14`，pid = stat/lstat/exists 各自）：

```
c14 L43428 [winstage-shim][3500][541] ATTRDBG-CFW seq=170 desiredAccess=0x80 share=0x7 disposition=3 flags=0x2000000 path=\\?\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt
c14 L43433 [winstage-shim][3500][546] ATTRDBG-CFW-OVL handle=0000000000000310 valid=1 err=0 path=\\?\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt
c14 L44008 [winstage-shim][9856][536] ATTRDBG-CFW seq=166 desiredAccess=0x80 share=0x7 disposition=3 flags=0x2000000 path=\\?\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt
c14 L44013 [winstage-shim][9856][541] ATTRDBG-CFW-OVL handle=00000000000002DC valid=1 err=0 path=\\?\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt
c14 L44587 [winstage-shim][4252][536] ATTRDBG-CFW seq=166 desiredAccess=0x80 share=0x7 disposition=3 flags=0x2200000 path=\\?\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt
c14 L44592 [winstage-shim][4252][541] ATTRDBG-CFW-OVL handle=00000000000002F4 valid=1 err=0 path=\\?\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt
```

（三组 pid=3500 `exists` / pid=9856 `stat` / pid=4252 `lstat`，各自紧跟在自己那条 NQIFBN `0xc000003b` 之后；
`desiredAccess=0x80` = `FILE_READ_ATTRIBUTES`，`ATTRDBG-CFW-OVL … valid=1` = 经 overlay 打开成功 —— 这就是"脆性绿"的落点。
⚠ **判据串坑**（`exe` 独立复核时踩过、已提醒）：判"无回退"必须用 **`ATTRDBG-CFW-OVL`** 作为串；
若写成 `CFW-OVL valid=1`，会因实际行中间隔着 `handle=… ` 而**数到 0 条**，从而得出**假的"无回退"**。）

`c15` 的夹具 `CreateFileW` 只有两条、且都不是 stat 回退（`verify-v2` 对 exists/stat/lstat 三个 pid 全判 `cfwFallback=no`）：

```
c15 L42797 [winstage-shim][944][379] ATTRDBG-CFW seq=224 desiredAccess=0x40000000 share=0x1 disposition=2 flags=0x80 path=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt
c15 L44566 [winstage-shim][4532][405] ATTRDBG-CFW seq=83 desiredAccess=0x120089 share=0x7 disposition=3 flags=0x2000080 path=\\?\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt
c15 L44571 [winstage-shim][4532][410] ATTRDBG-CFW-OVL handle=00000000000002E8 valid=1 err=0 path=\\?\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws\probe\pa-fixture.txt
```

（pid=944 是夹具播种（`GENERIC_WRITE`/`0x40000000`），pid=4532 就是 `readFileSync` 动作本体 —— 二者都不是 stat 回退。）

⇒ v2 的 `existsSync/statSync/lstatSync` 之所以为真，是 **NQIFBN 本身成功**（`staged=1 status=0x0 nt=\??\C:\…`），
**不是** libuv 在 `0xC000003B` 上的回退。

### (e) 附带（不属于反证链，但同轮证据）：**目录面 A/B 与已采纳读路径一致 ⇒ 不触发 v3**

同轮 `ab-dirs.mjs` 终值（冻结件 `docs/round10/fileio/13d/evidence/t4-v2-ab-dirs-c15.txt`
= `BFD7B6CFFA900F154026BF4552D25C98A2D61B00C9CF59DF4903C79299021B68` / 13,520 B）：

```
AB label=v2-c15-final focus=C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4-ws
  samePidPairs=14
  agree=14
  disagree=0
  postStagingPairs=14
  postStagingDisagree=0
  ADMISSIBLE(post-staging)=14 VERDICT=CONSISTENT_WITH_ADOPTED_READ_PATH
  focus pid=7176 c: W=overlay(staged=1,attrs=0x10,line=54370) NQIFBN=overlay(staged=1,status=0x0,nt=\??\C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\fileio\13d-t4\stage-c15\staged\fs\C\,line=54373) agree=true postStaging=true
```

`C:\` 那条由 `lane-runner` 的 **dir-root 补轮**补齐（这正是 c15 `shim.log` 在 13:56:34 被追加的内容）：
**同 pid 7176、同路径 `C:\`** 的 `W staged=1`（line 54370）与
`NQIFBN staged=1 status=0x0 nt=\??\…\staged\fs\C\`（line 54373）**同源**。
判据：配对必须**同 pid 且同路径**且 `postStaging=true`。
⇒ 目录面（`GetFileAttributesW`）与已采纳读路径（`NtQueryInformationByName`）在 v2 上
`agree=14/14`、`disagree=0` ⇒ **一致、不触发 v3**。

---

## 3. **不作废**的纪律（D87 的第二半，必须保留）

被推翻的只是 D87 的**归因**（"post-call 返回值被丢弃/改写"），**不是**它纠正的那条判据纪律：

> **判据不能用 `err` 残留。** `GetFileAttributesW` **成功时不清 `LastError`**，所以日志里的 `err=203`
> 是初始化期留下的陈旧值（上面三条 W 行都是 `rc=0`/`attrs=0x20` 却 `err=203`）。
> 正确判别字段是 **`rc` / `attrs` / `staged`**（本结案另加 `status`）。

该纪律在本结案的全部读数里都被遵守（`status`/`rc`/`attrs`/`staged`/`cfwFallback`，无一处用 `err` 判成败）。

---

## 4. 转为**回归项**（判据写死，机检可复跑）

| 编号 | 判据 | 机检 |
|---|---|---|
| **R-B1** | `existsSync(已暂存夹具)` === **true**（正确值） | `verify-v2.mjs` gate `existsTrue` |
| **R-B2** | 该 true **必须**由夹具 `NQIFBN` 的 `staged=1 status=0x0` 解释，且**同 pid、该行之后 12 条内无该夹具 `ATTRDBG-CFW`**（不得借 libuv 回退） | gate `hasStaged1Status0` + per-action `viaNqifbn=true` / `cfwFallback=no` |
| **R-B3** | 真实盘负对照不回归：`real-fixture.txt` 四个动作全成功，且其 `NQIFBN` 为 `staged=0 status=0x0` | gate `realDiskControlOk` + `counts.realStaged0Status0≥1` |
| **R-B4** | 全局硬门禁：`staged=1 status=0x0` **≥1**、`staged=1 status=0xc000003b` **=0** | gate `hasStaged1Status0` / `zeroStaged1Status3b` |

机检工具：`.t/round10/fileio/13d-t4/verify-v2.mjs`（exit 0 = PASS）。
**反例登记（教条意义）**：`c14` 的 `gate=false` 而 `exists result=true` ⇒
任何**只看动作 result** 的判据都是"脆性绿"，**不得**用作回归判据；必须看 NQIFBN 自身的 status + 无回退。

**`exe` 独立复核建议的等价机械口径**（供终版直接采用；与上表同义，措辞更便于机器判读）：

- **R-B1**：已暂存文件的 `existsSync` 必须 `true`，且**不依赖回退** ——
  判法：同 pid 出现 `ATTRDBG-NQIFBN … staged=1 status=0x0`，且**其后该路径无 `ATTRDBG-CFW`**（判据串必须含 `ATTRDBG-CFW`/`ATTRDBG-CFW-OVL`，见 §2(d) 的串坑）。
- **R-B2**：真实盘文件的 `existsSync`/`statSync`/`lstatSync` 按其**真实状态**回答（负对照三轮全绿）。
- **R-B3**：**`err` 不得进入任何判据**（`D88` 回归；`err=203` 出现在**成功**的 W 上）。

---

## 5. 与线 A 的关系、`D-FILE-3` 结案

- 线 B 由**线 A 的 v2 一并覆盖** ⇒ **不立单独候选**（避免开换件窗口与并车）。
- `D-FILE-3`（`existsSync/statSync` 看不见暂存文件）在**同一条**上结案：同一根因（按名查询不感知 overlay）
  同一修复覆盖；其"**属性面已排除**"的历史读数**仍然成立**（D87 已证：`GetFileAttributesW` 挂钩成功、
  `attrs=0x20` 正确、`masked`/`resolve-fail` 全 0）。
- 线 A v2 的**权威绑定**（引用候选时必须给源码内容哈希，因为 DLL 不逐字节可复现）：
  - 源码内容：`shim/src/ws_file.c` = `4CF967E349091413F695A2DF7D403C6D5D51997CF6B34E395EECE3732A75E259`（76,609 B）
  - 补丁：`.t/round10/shim/D98-nqifbn-ntform.patch`（基线 `60ACEC39…` → v2）
  - 候选件（验收轮使用）：`.t/round10/shim/out-13d-count15/winstage-shim.dll`
    = `2240F2BB7A275474E03C85DC1453E920CBF4DB2470ABDE6DF2CF6E767135A346`（262,656 B）
  - ⚠ 同一 D98 源码在另一台/另一次构建得到过 `0E7E282F…`（我的副本编译）⇒ **哈希非确定**，
    以源码内容哈希为准，DLL 哈希只作当轮凭据。

---

## 6. 原始件引用（sha256 / 大小 / 行数）

### 6.1 载体级 `shim.log` 与动作证据（每轮一套；均为 stage 的 passthrough 区）

| 文件 | sha256 | 大小 | 行数 |
|---|---|---|---|
| `.t/round10/fileio/13d-t4/stage-b13/staged/shim.log` | `4F4A9F45B1DF71ADB94F204B3882B1B5B63199496E2DE0D59F14568B61FF07A9` | 8,769,126 B | 47,491 |
| `.t/round10/fileio/13d-t4/stage-b13/staged/evidence/pa-actions.jsonl` | `38D1CF732283894CE9433C21C0BD03C76D6BF52807A54500E14137725235C6A4` | 1,988 B | 10 |
| `.t/round10/fileio/13d-t4/stage-c14/staged/shim.log` | `3A3CD2081B795FB16EC71452F1D1561C28C20D0CB856D508DEFE0836622C0A1C` | 9,163,728 B | 49,309 |
| `.t/round10/fileio/13d-t4/stage-c14/staged/evidence/pa-actions.jsonl` | `3631BED18625C09A0FBC821AFE018A94E3F27D05C745C72D5479B9ACBAAB6388` | 2,055 B | 10 |
| `.t/round10/fileio/13d-t4/stage-c15/staged/shim.log` | `5E54DD8EC4669E499C2932AAF7AC413E4C1F540B1B320880F657A805D2153202` | 10,130,827 B | 54,429 |
| `.t/round10/fileio/13d-t4/stage-c15/staged/evidence/pa-actions.jsonl` | `D7215F11E0F3CCB7F08680D5D3586BF7F9B7CFE45310E5FCC864038FBFE11231` | 3,534 B | 22 |

> ⚠ c15 的 `shim.log` 在 2026-10-10 **13:56:34** 被 **dir-root 补轮**追加（我首次哈希时是
> `E10AA212…` / 10,000,538 B / 53,668 行）；上表是**终态**。补轮前后 **gate 判定与全部计数逐项不变**
> （§6.3 已在终态日志上复跑）。
> c14 / b13 的 `shim.log` 终态与冻结副本**逐字节相同**（`3A3CD208…` / `4F4A9F45…`），未被追加。

### 6.1b 终态冻结副本（`docs/round10/fileio/13d/evidence/`；`.gitignore:149` ⇒ **不入库但随树保留**）

| 冻结件 | sha256 | 大小 |
|---|---|---|
| `t4-v2-c15-shim.log` | `5E54DD8EC4669E499C2932AAF7AC413E4C1F540B1B320880F657A805D2153202` | 10,130,827 B |
| `t4-v2-c15-pa-actions.jsonl` | `D7215F11E0F3CCB7F08680D5D3586BF7F9B7CFE45310E5FCC864038FBFE11231` | 3,534 B |
| `t4-v2-gate-c15.txt` | `3B5A8048B5422ED05B95F1F38261A300693AF2861616A5D4A22F1F3373ADBDCE` | 20,512 B |
| `t4-v2-ab-dirs-c15.txt` | `BFD7B6CFFA900F154026BF4552D25C98A2D61B00C9CF59DF4903C79299021B68` | 13,520 B |
| `t4-v2-c15-T4-summary.txt` | `76FAFBFABA2538378792F0B7CB2C7E42820052736A426AACA14FEAB38BE71256` | 27,374 B |
| `t4-v1-c14-shim.log` | `3A3CD2081B795FB16EC71452F1D1561C28C20D0CB856D508DEFE0836622C0A1C` | 9,163,728 B |
| `t4-v1-c14-pa-actions.jsonl` | `3631BED18625C09A0FBC821AFE018A94E3F27D05C745C72D5479B9ACBAAB6388` | 2,055 B |
| `t4-v1-gate-c14.txt` | `3528046AEB9DAAB3B9B0C3033C54A7701BBAADBF118A05FB440077B22F0F7767` | 12,053 B |
| `t4-v1-b13-shim.log` | `4F4A9F45B1DF71ADB94F204B3882B1B5B63199496E2DE0D59F14568B61FF07A9` | 8,769,126 B |

### 6.2 D87 及其原始来源（基线侧）

| 文件 | sha256 | 大小 | 行数 |
|---|---|---|---|
| `.t/round10/shim/D87-existsync-deciding-line.txt` | `6EDCC93936638B6AFE4C41D82A5F6EF6864E5BB3D789226300FA624F97FFF7A7` | 2,823 B | 42 |
| `.t/round10/fileio/13d-count-probe/pa-out3/shim.log`（D87 的 grep 来源） | `5029609A7FAC11B19F0BB565C9724E1BCFCA946A76C5453FBB69E2BBA02DFF64` | 5,623,362 B | 38,100 |
| `.t/round10/fileio/13d-count-probe/pa-out3/stage-evidence/pa-actions.jsonl` | `9BA21CD07F35331DD3991C1A7E6BE2EED4696FD847C12A41EF184B29B7D7B63A` | 780 B | 4 |

### 6.3 机检原始输出（本结案自己跑的，落 `.t/round10/fileio/line-b/`）

命令（免 shim、免车道、纯离线）：

```
cmd /c "call run.cmd .t\round10\fileio\13d-t4\verify-v2.mjs --log .t\round10\fileio\13d-t4\stage-<K>\staged\shim.log \
        --actions .t\round10\fileio\13d-t4\stage-<K>\staged\evidence\pa-actions.jsonl --label <K> --serial"
```

| 输出（**终态日志**上复跑，权威） | exit | sha256 | 大小 |
|---|---|---|---|
| `.t/round10/fileio/line-b/verify-b13-final.txt` | 1（gate=false，预期） | `EC03F03877ED24B1A812CFDC9B89DC10B0503B84C66B59FC7EE527D502EEF099` | 8,165 B |
| `.t/round10/fileio/line-b/verify-c14-final.txt` | 1（gate=false，预期） | `C7689FB3E7C11ED7B9E6EBCD4DCD02A64C8E937432419D31BBDBAD8D8A85B7F7` | 12,059 B |
| `.t/round10/fileio/line-b/verify-c15-final.txt` | **0（gate=true）** | `68703E58AE43414F9A4EFDDC37ADB6C9131863FC64C84B2D61E6989830699897` | 20,506 B |

（补轮前的同一复跑另存 `verify-b13.txt` / `verify-c14.txt` / `verify-c15.txt` = `33939F65…` / `395D22E9…` / `F1DBC31A…`；
两者 gate 判定与 counts **逐项相同**，差异仅来自 c15 日志被追加的那条 `C:\` 补轮记录。）

三者的 `counts` 块（**终态日志**、机检、非人工抄写）：

```
b13: nqifbnTotal=240  cfwTotal=537  fixtureBound=6  staged1=0    staged1Status0=0    staged1Status3b=0
c14: nqifbnTotal=240  cfwTotal=867  fixtureBound=6  staged1=167  staged1Status0=0    staged1Status3b=165  staged1Win32Form=167
c15: nqifbnTotal=550  cfwTotal=683  fixtureBound=6  staged1=386  staged1Status0=384  staged1Status3b=0    staged1Win32Form=386  staged0=164  staged0Status0=164  realStaged0Status0=3
```

> **口径限定（务必保留）**：以上计数是**全日志口径**（整份 `shim.log` + `verify-v2.mjs` 的字段定义），
> 不是"单轮/单动作"口径。`b13` 是 D96 之前的件，日志**没有** `mapped=/staged=` 字段 ⇒ 其 `staged*` 全 0 是
> "**字段不存在**"，不是"没命中"（`verify-v2` 用 `hasStagedField` 区分）。
> `staged1Win32Form` 统计的是 `path=`（**调用方传入的**逻辑名），**不是**实际交给真实 API 的 NT 串
> （后者是 `nt=`）⇒ **不要**把它当 NT 形态计数器用。
> `nqifbnTotal`/`staged1` 含探针对 `C:\`、`C:\Users`… 逐级父路径的查询（`dir-ab` 部分），
> 故与 Lead 通报的 67（主轮）/ 87（T5 轮）/ 165（三轮合并）**不是同一基数范围**——
> 两者不矛盾；其中 `c14 staged1Status3b=165` 与通报的 165 **逐位一致**。

### 6.4 工具与探针源码（引用其行为）

| 文件 | 作用 |
|---|---|
| `.t/round10/fileio/13d-t4/verify-v2.mjs` | v2 硬门禁（只看 NQIFBN 自身成败 + 无回退credit），147 行 |
| `.t/round10/fileio/13d-t4/collect.mjs` | 证据收集（`counts nqifbnAll/fixtureBound/staged1` 与注入断言），95 行 |
| `.t/round10/fileio/13d-count-probe/per-action.mjs` | **一进程一动作**（action↔pid↔seq 绑定的前提），30 行 |
| `.t/round10/fileio/13d-t4/collect-c15.log` | c15 轮收集器原始输出（**补轮前采集**；含 §2(b) 的夹具 NQIFBN 逐字行与 `counts nqifbnAll=526 fixtureBound=6 staged1=369`） |

---

## 7. 证据不入库

- `.t/` 与 `.t/**`：`.gitignore:24` ⇒ 上述所有日志、jsonl、机检输出、探针、补丁均**不入库**
  （`git check-ignore -v` 实测：`.gitignore:24:.t/`）。
- `docs/round10/**/evidence/`：`.gitignore:149` ⇒ 终态冻结副本**已经存在**于
  `docs/round10/fileio/13d/evidence/`（清单与 sha256 见 §6.1b），它们同样**不入库**、
  仅随工作树保留（供 `exe` 复核与后续回归复跑比对）。
- 本文件 `docs/round10/fileio/13d/线B-结案.md` 不在 evidence 目录 ⇒ **会入库**。

---

## 8. 未决 / 风险（不越权放宽口径）

1. **Node 内部 `binding.existsSync` 的确切实现**未反编译；本结案只用两个可测事实：它是 `binding.existsSync`
   （非 `statSync`+try/catch），且其进程流是"1×`ATTRDBG-W` + 1×`ATTRDBG-NQIFBN`"（与 `statSync` 进程流不同）。
   结论不依赖该细节。
2. **`c14` 的 `exists=true` 是回退credit**：若有人日后把 c14 当作"v1 已修好"的证据，会误判；
   本结案用 gate 的 `cfwFallback=yes` 明确标注。
3. D87 的原始来源 `pa-out3` 只覆盖 4 个动作（780 B / 4 行），其 `exists=false` 是 `0xC0000034` 时代的读数。
4. 本结案的机检复跑依赖 `.t` 下的历史日志仍在（未入库 ⇒ 若被清理则不可复跑）；
   三轮 `shim.log` 的终态冻结副本已存在 `docs/round10/fileio/13d/evidence/`（§6.1b，同样不入库），
   建议一并把 `verify-*-final.txt` 复制过去，以免 `.t` 被清理后失去可复跑的机检读数。
5. 复核：按 `task-6`，`exe` 的独立复核见 `docs/round10/verify/线B-结案-独立复核.md`，与本结案结论同向、无冲突。
