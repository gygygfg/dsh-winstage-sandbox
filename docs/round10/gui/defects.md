# 域七（gui）· 缺陷台账

> 域七 = 浏览器实操 + 沙箱线程 GUI 易用性实测。
> 证据目录：`docs/round10/gui/evidence/`。所有"实测"结论都对应那里的 PNG / `*-copy.txt`。
> 本次实测宿主：`dsh --profile web --patch .t/round10/gui/overlay-gui.yml --port 3091 --no-open`
> （`WINSTAGE_SHELL=1`、`DSH_SESSION_ID=` 清空、`WINSTAGE_STAGE_ROOT` 钉在 `.t\round10\gui\stage-base-3091*`）。
> **未改仓库代码。** `profiles\web\cordis.patch.yml` 的 mtime/size 变化**不是**违规写入，而是本域设置页操作的 DSH 语义副作用 ⇒ 见 §O0（观察）。

---

## O0（**观察，不是缺陷**）设置页持久化目标就是 `profiles\web\cordis.patch.yml`（D0 的裁定改写）

> Lead 已裁定（2026-10-08）：他没写过 `profiles\web\**`，也不是违规——**是我自己 3091 宿主的设置页按 DSH 语义写回 profile 层**。本节按裁定从"待定缺陷"改写为观察；由它引出的**真缺陷**是 §D1b。

| 项 | 值 |
|---|---|
| 机制 | `dsh --profile web …` ⇒ 设置页的持久化目标 = `%DSH_HOME%\profiles\web\cordis.patch.yml`，**与 3080（Lead GUI）共用同一个 profile 文件** |
| 观察到的副作用 | 我那次"点开关"的交互触发了 profile 序列化：`name: "dsh-winstage-sandbox"` → `name: dsh-winstage-sandbox`，1236 → 1234 B，mtime `2026-10-08T22:53:03`，sha256 `F847B672614A9CB6CBE90F6B05817BD15A550A62FAFDB46736E7CE465E392429` |
| 语义等价性（Lead 只读核对 + 我的 diff） | `- id: winstage-sandbox` / `name: dsh-winstage-sandbox` / `enabled: false` / `workspaceRoot: C:\Users\Administrator\Desktop\dsh-winstage-sandbox` **四项全部未漂移**，唯一差异是 `name` 的引号风格 |
| 对 3080 的影响 | **无**（内容语义一致） |
| 处置 | **不改回**（Lead 裁定）。改回只差引号风格，反而会再写一次、再动一次 mtime |
| 证据 | `.t\round10\gui\profile-web-cordis.patch.yml.after.txt`（当前）、`.before.txt`（更早的 `bak-20261008-201124-939`，指向已删除的旧根，**不是**本会话前态，只用于证明引号风格被打平过） |
| **由此暴露的共享风险** | **同一 profile 被多个宿主共享 ⇒ 任一宿主的设置页写回都会改动其他宿主正在读的 profile 层**；`web` profile 还是 `patchReload: live`。3080 与 3091 同用 `profiles\web` 时，这个影响是跨宿主的 |

---

## D1（高 · 实测）设置页开关写回失败，且报错不可诊断

| 项 | 值 |
|---|---|
| 步骤 | 3091 宿主（3 个 winstage 行都在且 `enabled` 生效）→ 设置 → 通用设置 → 滚到 `WinStage 沙箱` 行 → 点开关 |
| 观察 | 开关**弹回原状**，行内出现 `写入失败，已保留原值`；`aria-checked` 仍为 `"true"` |
| 证据 | `evidence/05-switch-off-after.png`、`evidence/11-panel-selected-copy.txt`（同页文案里含该句）、`evidence/03-settings-winstage-row.png`（行原文） |
| 缺什么 | **无错误码、无原因、无出路**。用户无法判断是"profile 覆盖层锁住了值"、"env 覆盖了值"还是"宿主拒绝写入"。`client.js:81` 只有 `error: '写入失败，已保留原值'` 这一句 |
| 严重度 | 高（开关是本插件唯一的用户入口；写不进去又说不清，等于入口失效） |
| 建议 | 错误文案带上宿主返回的 `code`/原因，并提供两条显式出路：①"本值被 profile 覆盖层固定（`enabled` 来自 `cordis.patch.yml`）"；②"被进程环境变量 `WINSTAGE_SHELL` 强制，请去掉该变量后重启宿主" |
| 备注 | 对照组 3092（`--patch` 完全不参与、`WINSTAGE_SHELL=1`）：点击后**没有**报错、`aria-checked` 变 `"true"`，但 `cordis.patch.yml` 的 `enabled` 仍是 `false` ⇒ 见 **D6** |

## D1b（高 · 实测 · **M3 证据升级**）"报失败，但 profile 文件已被改写"

> **✅ 已在修复轮（task-15）修复并实测**（`修复轮-记录.md` §3；证据 `evidence/fix/06-settings-error-copy.txt` / `.png`）。
> 新文案（界面逐字）：`设置值未生效：已保留原值（本行 config 被覆盖层/环境变量固定）。注意：此次交互可能已把 profile 文件重新序列化写入（仅格式规范化，键值语义不变）——可核对 %DSH_HOME%\profiles\<profile>\cordis.patch.yml 的修改时间与 sha256；同一 profile 若被多个宿主共用，请避免并发改动。`
> 同一次交互的磁盘事实复核：`profiles\web\cordis.patch.yml` 1234 B / mtime `2026-10-08T22:53:03` / sha256 `F847B672…2929`，四项语义未漂移。

> Lead 裁定：这才是真缺陷。"写回失败且无出路"只是它的表层；更硬的是**失败通报与磁盘事实相反**。

| 项 | 值 |
|---|---|
| 最小复现 | ① `set WINSTAGE_SHELL=1` + `set DSH_SESSION_ID=` ② `dsh --profile web --patch .t\round10\gui\overlay-gui.yml --port 3091 --no-open` ③ 浏览器打开该 URL → `设置` → `通用设置` → 滚到 `WinStage 沙箱` 行 ④ 记录 `profiles\web\cordis.patch.yml` 的 **size / mtime / sha256** ⑤ 点一次该开关 ⑥ 界面报 `写入失败，已保留原值`（开关弹回、`aria-checked` 仍 `"true"`）⑦ **再记一次** size / mtime / sha256 |
| 实测前后 | **前**：1236 B、`name: "dsh-winstage-sandbox"`、预写 time 早于 22:53。**后**：**1234 B**、`mtime = 2026-10-08T22:53:03`、sha256 `F847B672614A9CB6CBE90F6B05817BD15A550A62FAFDB46736E7CE465E392429`、`name: dsh-winstage-sandbox`（引号被规范化掉） |
| 内容等价性 diff | **唯二差异**：`line 37: "dsh-winstage-sandbox"` → `dsh-winstage-sandbox`（引号）；字节数 −2。`id` / `enabled: false` / `workspaceRoot` / `probeOnStart` **一字未变** ⇒ **语义等价** |
| 为什么是缺陷 | 界面说"**已保留原值**"，磁盘上**同一个文件已被重写**（mtime 变了、字节变了）。用户据此判断"什么都没发生"，从而不会去查"是否影响了共用一个 profile 的其他宿主"。**报错语义与副作用方向相反** |
| 跨宿主暴露面 | 3091 与 **3080（Lead GUI）共用 `profiles\web`**，且该 profile 是 `patchReload: live` ⇒ 任一宿主的设置页写回都会改动另一个宿主正在读的 profile 层。本次未造成语义漂移，但机制上通 |
| 严重度 | 高（M3"开关语义=差"的**升级证据**：不只是"写不进去又说不清"，而是"说没写、其实写了、还可能写到别人头上"） |
| 建议 | ① 设置页写回必须区分两种结局：`applied`（值+文件都变了）/`rejected`（值没变、**文件也不许动**）；② 报"已保留原值"前先确认磁盘确实未被触碰，否则改为"值未生效，但 profile 文件已被序列化重写（mtime/sha256 见详情）"；③ 对 `patchReload: live` 的共享 profile 给出并发写保护或显式告知 |
| 证据 | `evidence/05-switch-off-after.png`（`写入失败，已保留原值` 逐字）、`.t\round10\gui\profile-web-cordis.patch.yml.after.txt`（当前字节）、`.before.txt`（引号风格对照）、`Get-Item` 的 size/mtime 原始输出 |

## D2（高 · 实测）待审面板展开时，消息输入区被从 DOM 移除

> **✅ 已在修复轮（task-15）修复并实测**（`docs/round10/gui/修复轮-记录.md` §1；证据 `evidence/fix/05-final-verified.*`）。
> 修法：注入 `[data-chain-overlay-fallback="conversation.composer"]{display:block !important}` —— 输入条**本来就在 DOM 里**、只是被平台隐藏。
> 修复后实测：`ceRect=[297,243,708,36]`（修复前 `[0,0,0,0]`）、`fallbackDisplay=block`，且**面板开着时第二条消息成功送达**（`FINAL-VERIFY-OK`）。
> DLL：`02C7418F…`（过门禁版）。

| 项 | 值 |
|---|---|
| 步骤 | 有待审候选（面板展开）时，检查输入区几何 |
| 观察 | `document.querySelectorAll('[contenteditable="true"]')` 命中 1 个，但 `getBoundingClientRect()` = `(0,0,0,0)`（`vis:false`）⇒ **输入区不可见也不可输入**；发送按钮 `disabled` |
| 证据 | 本轮命令输出（`COMPOSER-LEN: 0` / `sendDisabled: true` / `ce: [0,0,0,0]`），以及恢复过程 `16-collapsed-chip.png`（点「暂时收起」后 `ce:[296,374,705,52]`，输入恢复） |
| 用户可感知 | "我想就这份待审改动追问一句" —— 做不到，除非先点「暂时收起」。而「暂时收起」是**并列**在「全选 / 清空选择 / 拒绝全部 / 批准全部」中的一个次要按钮，语义上不像"恢复输入" |
| 严重度 | 高（阻断一个正常使用场景，且没有任何提示告诉用户"收起才能继续对话"） |
| 建议 | ① 待审面板不要吃掉 composer 布局（改为抽屉/浮层，或把 composer 下移而不是移除）；② 若必须让位，在面板里显式写一句"面板展开时不接受新消息，点「暂时收起」即可继续" |
| 备注 | 这条同时解释了本轮 3 次"发不出去"的现象，不是浏览器工具的问题 |

## D3（高 · 实测）可信性头条与事实相反："写入会失败"，但写入**成功了**

> **✅ 已在修复轮（task-15）修复并实测**（`修复轮-记录.md` §2）。
> 判据由 `writes.count>0 || (checked && alive===false)` **收紧为 `writes.count>0`**：实测发现 `alive===false` 本身就是误报源
> （暂存根钉在缓存基之外 ⇒ 无哨兵 ⇒ 恒答 `marker-missing`，而候选正常生成）。判据不足时不再断言，改走 `trustBaseUnverifiable`。
> 修复后界面逐字：`⚠ 沙箱档位信息不完整（面板拿到的卡片里没有档位字段）：**暂存写入此刻可用**（待审候选正常生成）；是否已降档无法据此判定，请跑 /winstage status 看权威结论。`
> 同轮新发现并记为 **§D11**（面板/宿主信任数据不同源）。

| 项 | 值 |
|---|---|
| 步骤 | 在 3091（`已启用`）里由嵌套 agent 用**写文件工具**创建 `t1-degrade-probe.txt` |
| 事实 | 候选生成、`staged\t1-degrade-probe.txt` 存在、面板显示 `新增 t1-degrade-probe.txt +1 / −0`（`14-t1-trust-copy.txt`）。**写入没有失败**，它按设计进了暂存 |
| 文案 | 面板头条红字：`可信性：⚠ 会话工作根已不可用：写入会失败，不会静默改写真实文件`（`client.js:179 trustLost`） |
| 为什么是缺陷 | 该句取自 `trustLost`。在本次会话里 `stageRoot.lossCount` 从 78 一路涨到 489，**同时**候选持续正常生成 ⇒ 这个 headline 表达的是"某类根探测失手 N 次"，却被渲染成"写入会失败"。用户按字面读会得出"沙箱坏了"的结论，而真实发生的是"沙箱工作正常，只是有个计数器在涨" |
| 证据 | `evidence/14-t1-trust-copy.txt`、`evidence/14-t1-degraded.png`、以及 4 轮独立面板快照的 `失根` 序列 `141 → 145 → 149 → 153 → 157 → 161`（每 6 s +4，线性）。完整版在 `.t\round10\gui\stage-base-3091-t1\review.json` 同目录的 `sandbox-lane.json` |
| 严重度 | 高（误导性文案，属 M7 类；方向是"把正常说成坏"，会诱发用户错误操作） |
| 建议 | ① headline 只保留**已被证实**的事实（"暂存正常，写入不会落到真实盘"）；② 把"失根计数"降级为可展开的详情，并注明"这是探测计数，不等于写入失败"；③ 若计数确有阈值语义，写明阈值与触发后果 |

## D4（高 · 实测）降级不可见：档位从透明垫片掉到受限令牌档，界面**不**说"沙箱已降级"

> **◐ 部分修复（task-15）**：降档文案 `trustDegradedAction`（含"下一步"）已实现，且头条不再被噪声占满（见 §D3 修复）。
> **但本次 gated-DLL 复跑里该文案没有在界面出现过** —— 因为面板拿到的那份信任卡 `tier` 字段为空（`tierEffective=?`、`degraded=no`），
> 与宿主路由返回的 `tier.status="degraded"` **不同源** ⇒ 已记为 **§D11（需 host 侧修）**。
> 在 `§D11` 修好之前，本缺陷**不能算已修复**（诚实声明，不作为"已修"引用）。

| 项 | 值 |
|---|---|
| 步骤 | 用 `--patch` 把 `winstage-shell.tier` 钉成 `T1`（等价于注入器/透明垫片不可用后的 fail-closed 终态），新会话跑一条 pwsh + 一次写文件 |
| 观察 | 面板详情行显示 `档位 restricted-token · 掉档 1 次 · 失根 …`，但**头条行被 `失根` 那条占满**，没有出现 `trustDegraded` 的那句「⚠ 沙箱**不可信**：档位已掉档，写入只剩内核硬拒」。`掉档 1 次` 只以 12 px 灰字出现在第二行 |
| 用户可感知 | Lead 问的正是这件事：**Defender 把注入器隔离后，用户界面看不出沙箱已降级**。他要从一行小字里的 `restricted-token` + `掉档 1 次` 自己推断 |
| 证据 | `evidence/14-t1-degraded.png`、`evidence/14-t1-trust-copy.txt`（逐字：`可信性：⚠ 会话工作根已不可用…` / `档位 restricted-token · 掉档 1 次 · 失根 78 次 …`） |
| 环境核对 | 本 run（23:16–23:29）`winstage-inject.exe` **存在**，sha256 `07FE55DD386D489B93FA2FCFF55DB152304BD9FD4E857A5CDECF152B77CE518F`（159,232 B，与 Lead 通报一致）；`winstage-shim.dll` sha256 `47DF4A5AAAB32EBE4A533270EDD6C598F21DB91EE558F5BF326B1469712DD6F2`（245,760 B）。因此本轮**没有**遇到 `tier=T1` 偶发形态，降级是我**显式构造**的 |
| 严重度 | 高（安全问题被发现的可观测性） |
| 建议 | `trustDegraded` 必须能**顶掉** `trustLost` 成为头条，或两条并列显示；并给出"下一步做什么"（例如：`/winstage status`、检查 `shim\out\winstage-inject.exe` 是否被安全软件隔离） |

## D5（中 · 实测）沙箱内部绝对路径泄漏给用户与模型

| 项 | 值 |
|---|---|
| 现象 | ① 嵌套 agent 自报 `pwd = C:\Users\Administrator\Desktop\dsh-winstage-sandbox\.t\round10\gui\stage-base-3091\staged`（`11-panel-selected-copy.txt` 的 `round10-gui-pwd.txt` diff 里逐字可见，`+1` 行）；② 面板行路径在 3091b 里是 `新增fs\C\Users\Administrator\AppData\Local\Temp\dsh-stage-temp\...` 的**内部布局**形态 |
| 影响 | 用户/模型能看出"自己在暂存树里"，且要读懂反斜杠转义的内部键 |
| 证据 | `evidence/11-panel-selected-copy.txt`、`evidence/10-panel-with-candidates.png` |
| 备注 | `docs/round10/env/00-启动配方.md` §3 已记过同形态（记为 `defects.md §D3`，headless 侧）。此处补充的是**它在 GUI 面板里的显示形态** |
| 建议 | 面板路径列统一按工作区相对路径显示（`round10-gui-fs.txt` 已经是相对路径，说明可行），把 `fs\C\...` 这种内部键折叠到"详情"里 |

## D6（中 · 实测 · 需裁定）`WINSTAGE_SHELL=1` 下，设置开关的写回**未生效但不报错**

| 项 | 值 |
|---|---|
| 步骤 | 3092 宿主（**无 `--patch`**，`WINSTAGE_SHELL=1`，profile 里 `enabled: false`）→ 设置行初始显示 `已关闭` → 点开关 |
| 观察 | 开关变 `已启用`（`aria-checked="true"`），**无任何错误文案**；但 `profiles\web\cordis.patch.yml` 的 `enabled` 仍是 `false`，mtime 未变 |
| 判读（**未定论**，如实写） | 可能是"`WINSTAGE_SHELL` 优先级高于 `config.enabled` ⇒ 请求值与生效值本来就不同 ⇒ 设置层做了 no-op"；也可能是"写成功了但被门控覆盖面掩盖"。两种解释下用户看到的都是 **`已启用` 这个勾选态 ≠ 文件里的 `false`** |
| 证据 | `evidence/06-3092-toggle-off.png`、`.t\round10\gui\profile-web-cordis.patch.yml.after.txt` |
| 严重度 | 中（用户对"我这个开关到底是什么状态"失去可信答案） |
| 建议 | 当存在 `WINSTAGE_SHELL` 覆盖时，在设置行里**显式**标出"当前由环境变量强制为开/关，profile 值被忽略"，并把开关置为只读或加锁图标 |

## D7（中 · 实测）待审面板被 PowerShell 策略探针噪声淹没

| 项 | 值 |
|---|---|
| 现象 | 一次"写两个文件 + pwd"的任务，面板里 14 个候选有 **10 个**是 `__PSScriptPolicyTest_*.ps1/.psm1`（PowerShell 每次启动自建的 AppLocker 探针），真正的工作成果只有 3 个；L1 标题写 `14 个文件（L1 14）`，`+1482 / −0` 里绝大部分是 `shim.log` 的 1466 行 |
| 影响 | 用户为了批准 3 个文件，必须在一屏只显示约 2 行的列表里向下滚过 10 条噪声，并且要能分辨哪些是该批的 |
| 证据 | `evidence/10-panel-copy.txt`、`evidence/10-panel-with-candidates.png` |
| 建议 | ① 提供"只显示工作成果"过滤器（默认折叠 `fs\...\Temp\` 一类外部路径）；② `shim.log` 这类沙箱自身副作用日志不应默认进候选（`review-service.mjs:1448` 有相关注释，建议评估默认排除或单独分区） |

## D8（低 · 实测）会话历史与待审面板的计数语义不一致

| 项 | 值 |
|---|---|
| 现象 | 同一屏里：会话历史摘要写 `已编辑 59 个文件 +53,108 −829`，待审面板写 `14 个文件 +1482 / −0`，而面板 L1 分组标题又写 `工作区内 (14)` |
| 影响 | 用户在"批准全部"之前无法判断到底会写多少个文件 |
| 证据 | `evidence/11-panel-selected-copy.txt`（历史摘要）、`evidence/10-panel-copy.txt`（面板计数） |
| 建议 | 给两个数字各加限定词（"本回合工具调用累计" vs "当前待审净变化"），或把面板计数放在历史摘要同一行的同一语义下 |

## D9（低 · 需 Lead 裁定归因）宿主进程在观测窗口内静默退出

| 项 | 值 |
|---|---|
| 现象 | 第一轮 3091 宿主（PID 10024）与 3092 宿主（PID 4912）在 23:0x 前后同时不再监听；GUI 显示 `重新连接中...`，已发送消息未落地（`09-reconnect-boot.png` 里 prompt 仍是草稿） |
| 日志 | `host3091.stderr.txt` / `host3091b.err.txt` / `host3091t1.err.txt` **全为空**；`dsh web` 只打印一行 URL。**没有崩溃栈** |
| 归因 | **未定论**。时间窗与 Lead 的 Defender 事件（22:31–22:52）不重合；重启后（新 PID 5404 / 1844）稳定运行到本轮收尾，两次重启各跑完整个用例。不排除是我"同一端口先后起 3 个宿主 + 同一 `WINSTAGE_STAGE_ROOT` 基目录"造成的环境冲突 |
| 影响 | 无数据损坏；但"宿主静默退出且零日志"本身是可诊断性缺口 |
| 建议 | 宿主退出时应至少落一条带退出码/信号的日志；`dsh web` 目前只打印 URL，崩溃/正常退出都无迹可查 |

## D11（高 · 实测 · **修复轮新发现，需 host 侧修**）面板与宿主路由的信任卡**不同源** ⇒ 面板拿不到档位字段

| 项 | 值 |
|---|---|
| 现象 | 同一时刻：**宿主路由** `GET /winstage-panel/trust` 返回 `{ok, store, card, source}`，其中 `card.tier = {status:"degraded", degraded:true, launchMode:"restricted-token", tierEffective:"T1"}`、`card.stageRoot = {checked:true, alive:false, reason:"marker-missing", lossRelevant:true, lossCount:150}`、`card.writes.count = 0`、`card.trust = {level:"lost", ok:false, blockers:[{code:"stage-root-lost", detail:"marker-missing"}]}`；**而面板渲染出的那张卡 `tier` 为空**（界面详情行逐字：`判据：宿主 level=lost · tierEffective=? · degraded=no`） |
| 影响 | ① 面板无法展示"已降档"（`D4` 的文案因此从未出现）；② 面板拿着 `level:"lost"` 却缺 `tier`，修复前就退化成"继续喊写入会失败"（`D3`）。**这是修复轮里发现的二次误导的根因** |
| 归因（待 host 侧确认） | 客户端 `readTrustCard()` 把响应取成 `result.card ?? result`，而面板侧读到的对象里没有 `tier`。可能是：面板走了**另一条读取路径**（旧布局兜底 `readReviewViaLegacyPath` 一类），或宿主路由对**不同调用方/session 参数**返回了不同 shape。需要 host 侧核对 `/winstage-panel/trust` 的两条消费路径 |
| 严重度 | 高（直接决定安全降级能否被用户看见，且会导致文案反向断言） |
| 建议 | 让面板与 `/winstage status` 读**同一份**卡片对象（同源），并在卡片里**始终**带 `tier.{status,degraded,tierEffective,launchMode}`；若确实取不到，路由应明确返回 `tier: null` 并让前端据此走"判据不足"分支（本修复轮已把前端这条分支做好） |
| 证据 | `evidence/fix/04-trust-block.json`（面板侧逐字）、`evidence/fix/02-trust-card.json`（路由侧完整卡）、`修复轮-记录.md` §2(b) |
| 状态 | **未修**（属 host 侧；本轮写范围只有 `client.js`） |

## D10（中 · **可复核性缺陷 / 我方取证纪律**，非产品缺陷）首轮"批准=落盘"的宿主侧原始输出未落盘且证据物被删

> 复核者 `exe`（task-9）独立复核指出，Lead 已认可。**这是我的取证纪律问题，不是 WinStage 产品缺陷。**

| 项 | 值 |
|---|---|
| 现象 | 首轮（23:06）我声明"批准 = 真实落盘"并给了三条 SHA256，但：① 那三条哈希的**原始 `Get-FileHash` stdout 没有落进 `evidence/`**（`exe` 在 gui 全域证据树检索三个哈希 → **命中 0**）；② 取证后我把那 3 个测试文件**从真实工作区删掉**了 |
| 后果 | 事后只能证明"与 `staged/` 副本哈希一致"（同源于暂存侧），**无法证明它们真的曾落在真实盘上** ⇒ 该声明降级为**自证残留风险**，第三方不可复核 |
| 根因 | 方法论错误：用"界面截图 + 事后哈希"支撑一个**关于真实磁盘**的声明，而且**先删证据物、后写报告** |
| 纠正（已完成） | 重跑最小批准用例 `run-20261008-234610`，把**同一 run、宿主未受限侧**的原始输出落盘：`evidence/rerun-20261008-234610/`（`00-host-before.txt` Test-Path=False → `03-host-after-approval.txt` Test-Path=True + Length + LastWriteTime + SHA256 + `cmd /c dir` + review.json → `04-staged-vs-real-hash-compare.txt` MATCH=True → `06-host-after-reject.txt` counts=0）。本轮**刻意不删**仓库根下的 `r10-recheck-fs.txt` / `r10-recheck-pwsh.txt`，供独立重算 |
| 判据（今后必须） | **UI 类声明必须留宿主侧原始输出**（同 run、未受限、含时间戳与 run 标识），且**先落原始输出 → 再引用 → 最后才谈清理**；不得在留证前删除证据物 |
| 证据 | `evidence/rerun-20261008-234610/MANIFEST.txt`、`报告.md` §3.1 / §3.3 |

---

## 未列入缺陷（如实说明的做法类观察）

| 项 | 说明 |
|---|---|
| 磁盘残留 | 「拒绝全部」后 `review.json` 的 `counts.files = 0`、`pending = false`，**未批准路径零落盘**（`shim.log` / `winstage-shim.config.json` 在真实根下均不存在）。但暂存树 `stage-base-3091\staged\` 下仍留着 `round10-gui-fs.txt` 等文件副本（见报告 §6 的原始计数：`staged` 内 20 个条目）。暂存树本身在 `.t\round10\gui\` 下，不是工作区污染 |
| 批准路径的真实落盘 | 3 个文件在批准后确实出现在真实工作区，`Get-FileHash` 与暂存内容一致（报告 §6 有哈希表）；取证后我已把这 3 个测试文件从真实工作区**删掉**，工作区恢复干净 |
