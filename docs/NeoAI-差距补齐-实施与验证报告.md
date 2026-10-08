# NeoAI 差距补齐 —— 实施与独立验证报告

- 验证对象：`WinStageSandbox` 第三轮新增的三个模块（`src/netpolicy.mjs` / `src/mitigations.mjs` / `src/limits.mjs`）
  及其接线、四个新治理/接线套件、`src/testrunner.mjs` 与 `verify.cmd` 的清单同步、`README.md` 的更新。
- 验证者立场：**未参与上述任何代码的编写**。任务是证伪，不是背书。所有"作者自报"的数字都重新跑过。
- 证据分层：`[实测]` = 本次在本机（`C:\Users\Administrator\Desktop\WinStageSandbox`，node v24.21.0，
  workspace-write 受限会话）真的跑出该结果；`[推断]` = 由代码/官方语义推导，未直接观测；
  `[未实测]` = 本机无法证明。
- 时间点：本次验证会话。工作区根目录即仓库根。

---

## 1. 验证了什么（命令 → 结果）

### 1.1 主关口：`verify.cmd`（20 套件离线关口）

```
cmd /c "verify.cmd > .t\verif-final-verify.txt 2>&1"
```

`[实测]` 退出码 **0**；输出末尾为 `RESULT: ALL PASS`；20 个套件块，合计 **1819** 条 `✓`/`[OK]` 标记，
`✗` 为 0。逐套件（`✓` 计数与套件自报一致）：

| # | 套件 | 断言 | 结果 |
|---|---|---|---|
| 1 | tests/selftest.mjs | 51 | PASS |
| 2 | tests/e2e-flow.mjs | 21 | PASS（"端到端链路：全部通过"） |
| 3 | tests/struct-layout.mjs | 24 | PASS |
| 4 | tests/appcontainer-layout.mjs | 34 | PASS |
| 5 | tests/resolve-exec.mjs | 19 | PASS |
| 6 | tests/executor-stub.mjs | 143 | PASS |
| 7 | tests/audit-parse.mjs | 43 | PASS |
| 8 | tests/paths-masks.mjs | 58 | PASS |
| 9 | tests/registry-guard.mjs | 378 | PASS（1 skip） |
| 10 | tests/workspace-regressions.mjs | 16 | PASS |
| 11 | tests/meta-runner.mjs | 4 | PASS |
| 12 | tests/appcontainer-runtime.mjs | 178 | PASS（1 skip） |
| 13 | tests/probe-selfkill-guard.mjs | 27 | PASS（ASCII 标记，`countChecks`=0，判定来自退出码） |
| 14 | **tests/netpolicy.mjs** | **129** | `RESULT: PASS checks=129 failures=0 mode=normal` |
| 15 | **tests/mitigations.mjs** | **160** | `RESULT: PASS checks=160 failed=0` |
| 16 | **tests/limits.mjs** | **175** | `RESULT: PASS (assertions=175 failures=0 skips=0)` |
| 17 | **tests/integration-wiring.mjs** | **144** | `RESULT: PASS checks=144 failures=0 mode=normal` |
| 18 | tests/wfp-layout.mjs | 146 | PASS |
| 19 | **tests/suite-wiring.mjs** | **28** | `RESULT: PASS checks=28 failures=0 mode=normal` |
| 20 | **tests/residual-baseline.mjs** | **41** | `RESULT: PASS checks=41 failures=0 mode=normal` |
| | **合计** | **1819** | **RESULT: ALL PASS（exit 0）** |

结论：`verify.cmd` 的 **ALL PASS 与 20 套件/约 1819 断言**属实；六个新套件的自报数字
（129 / 160 / 175 / 144 / 28 / 41）逐一对上。

### 1.2 附加：`autotest.mjs --skip-audit`

```
cmd /c "node autotest.mjs --skip-audit > .t\verif-autotest.txt 2>&1"   → 退出码 [实测] 1
```

`[实测]` 总判定 `FAIL`：**21 通过 / 2 失败 / 0 跳过**，断言 1836 ok / 6 bad。
- 20 个离线套件在 `autotest` 内部同样全绿，数字与 §1.1 完全一致（互证）。
- 2 个失败**全部**是 `SANDBOX_SUITES`（需要未受限会话）：
  - `registry-unstaged-wow64`（30 ok / 6 bad）：首条失败是**前置条件**——
    "真实 hive 里先建好这个键（用未注入的 reg.exe）"失败，其后 5 条是级联。
    **解释：会话受限导致的沙箱段失败（文档化的嵌套/权限边界），不是本轮三个模块的回归。**
  - `file-cow-dispositions`（`FAILED (15/18)`）：套件自己在输出里把它标成 `GAP`——
    `c6cmd-canary`（cmd.exe 的 `if exist` 看的是真实文件系统，不看覆盖层）与
    `c7b`（node `fs.unlinkSync` 返回成功但真实文件仍可读，无 whiteout）。
    **解释：这是 shim 覆盖层**既有**的功能缺口（套件内如实记录），不是嵌套限制，也不是本轮新模块引入的。**
- 说明：`autotest.mjs:125` 的退出码是 `overall === 'FAIL' ? 1 : 0`，`[实测]` 确为 1
  —— 顶层入口**没有**吞掉失败（我最初用 `cmd & echo %ERRORLEVEL%` 读到 0，那是 cmd 解析期展开的假读数，已用
  `$LASTEXITCODE` 复测纠正）。

### 1.3 清单一致性（独立于 `suite-wiring` 手工复核）

`[实测]` `src/testrunner.mjs:26-72` 的 `OFFLINE_SUITES` 恰好 **20** 条；
`verify.cmd:38` 的 `for %%S in (...)` 列表恰好 **20** 条，**逐项同序同名**
（selftest, e2e-flow, struct-layout, appcontainer-layout, resolve-exec, executor-stub, audit-parse,
paths-masks, registry-guard, workspace-regressions, meta-runner, appcontainer-runtime,
probe-selfkill-guard, netpolicy, mitigations, limits, integration-wiring, wfp-layout, suite-wiring,
residual-baseline）。
`[实测]` `verify.cmd` 全文 2959 字节，**字节值 > 0x7F 的数量 = 0**（纯 ASCII，符合 R11）。
`[实测]` `verify.cmd` 的失败传播模式（`if errorlevel 1 set FAIL=1` → `exit /b %FAIL%`）用复刻脚本
+ `tests/_planted-failure.mjs` 验证：`RESULT: FAIL` 且退出码 **1**。

---

## 2. 独立证伪（每一次攻击、结果、结论是否存活）

所有攻击脚本是我自己写的临时脚本（跑完已删除），替身绑定表/替身 Win32 表也是我自己构造的。
不复用被测套件里的替身，避免"用被验证的判据验证被验证的代码"。

### 2.1 网络 fail-closed / fail-open

**A1 档位归一（大小写 / 空白 / 非字符串）** — `[实测]`
对 `resolveNetworkPolicy({requested:x})` 遍历
`'offline'` / `'Offline'` / `'OFFLINE '` / `' OFFLINE'` / `'OFFLINE\n'` / `'OFfline'` / `42` / `null` /
`{}` / `[]` / `true` / `['OFFLINE']`：
- 除 `undefined`（走默认参数 → `OBSERVED_ONLINE` → `not-implemented`）外，**全部抛
  `NETWORK_TIER_INVALID`**；`enforced` 一律 `false`。
- executor 视角（`assertNetworkPolicyEnforceable()`）：
  - `'OBSERVED_ONLINE'` → 放行（`not-implemented`，不拦任何东西，符合默认语义）；
  - `'OFFLINE'` → 抛 `SANDBOX_NETWORK_POLICY_UNENFORCED`（本机无可用 WFP 绑定表 ⇒ `refused`）；
  - `'offline'/'Offline'/'OFFLINE '` / `42` → 抛 `NETWORK_TIER_INVALID`（`run()` 的**第一道门**，
    在任何暂存写入/子进程创建之前；`src/executor.mjs:2147`）。
- 能力报告面（`capabilityDimensions`）：未知档位降级成 `state:'unknown', enforced:false`。
- **结论：不存在"小写 offline 静默变成不阻断还照跑"的 fail-open 洞。** 失败方向是拒绝执行。
  唯一可挑的是错误码是 `NETWORK_TIER_INVALID` 而不是 `SANDBOX_NETWORK_POLICY_UNENFORCED`（分类精度问题，非安全洞）。

**A2 `refused` 是否可能携带 `enforced:true` / 非 OFFLINE 是否可能 `enforced:true`** — `[实测]`
穷举 540 组输入（档位 × 绑定表形态 × guids × probe 结果，含抛错样本）：
- `state === refused` 且 `enforced !== false`：**0 例**；
- `state === not-implemented` 且 `enforced !== false`：**0 例**；
- `state !== enforced` 且 `enforced === true`：**0 例**；
- 无安装证据且非 OFFLINE 时 `enforced === true`：**0 例**。
- **结论：这一条不变量存活。**（但见 D2：`enforced:true` 需要"安装证据"，而证据本身可被调用方伪造。）

**A3 中途失败是否在宿主上零残留（拆除顺序）** — `[实测]`
用记录型替身（真实记录 `open/sublayerAdd/filterAdd/filterDelete/sublayerDelete/close` 与宿主表）：
- 第 3 条 `FwpmFilterAdd0` 失败：
  `engineOpen → subLayerAdd → filterAdd ×3(第3条失败) → filterDelete:2306 → filterDelete:2305 →
  subLayerDelete → subLayerDelete → engineClose`；宿主 `filters=0, sublayers=0`。
  （两次 sublayer 删除：一次是 `applyOfflinePlan` 自己的回滚，一次是 `installNetworkPolicy` 的 teardown，
  第二次命中幂等码，无害。）
- `FwpmFilterAdd0` 成功但**不回传 filterId**：抛 `NETWORK_POLICY_INSTALL_FAILED`
  （`originalCode=WFP_FILTER_ID_MISSING`），宿主零残留。
- 回读说"过滤器不在"（`FWP_E_FILTER_NOT_FOUND`）：抛 `NETWORK_POLICY_VERIFY_FAILED`，
  日志显示 **逆序** `filterDelete:2310…2305 → subLayerDelete → engineClose`，`teardownFailures=[]`，
  宿主 `filters=0 / sublayers=0`。
- **结论：拆除顺序（删 filter 逆序 → 删 sublayer → 关引擎）与"零残留"存活。**

**A4 说谎的替身绑定表** — `[实测]`
- 一个"自答自证"的替身（`Add` 返回 0 并给 id、`GetByKey` 返回与计划逐字段一致的条目）：
  `installNetworkPolicy` → `audit.reason='verified'`、`layerChecked=true`、
  `resolveNetworkPolicy` → `state=enforced, enforced=true, verified=true`（`filterAdd=6, getByKey=6`）。
  这是**必然**的：审计只能核对"绑定表自己说的话"，无法核对内核。**这是残余边界，不是本轮缺陷**，
  但它意味着 `verified:true` 的说服力上限 = 绑定表可信度。
- 绑定表**不提供**回读入口（只有 `Add/Delete`）：`audit.reason='enumeration-unavailable'`，
  `resolveNetworkPolicy` 仍返回 `state=enforced, enforced=true, verified=false`，
  而 executor 的闸门只判 `state === ENFORCED` ⇒ **OFFLINE 会在"完全没有独立核对"的情况下放行执行**。
  这是作者在 `README §9.1` 明确写下的设计（"已强制但未独立验证"），
  `Add` 返回 `ERROR_SUCCESS` 在 WFP 语义下确实是"装上去了"，所以我不判它是缺陷，
  但必须在"仍未提供的保证"里点名：**该路径下的"已强制"没有独立证据**。

**A5 调用方伪造 `install`/`audit` 证据（报告面）** — `[实测]`，**见缺陷 D2（本报告唯一的方向性 fail-open）**
- `capabilityDimensions({ networkTier:'OFFLINE', networkBindings:<完整替身表>, networkGuids, networkProbe:{available:true},
  networkInstall:{installed:[6 条]}, networkAudit:{verified:true} })`
  → `networkPolicy.state='enforced', enforced=true, verified=true`，
  而底层 WFP 调用日志只有 `[engineOpen, engineClose]`，**`FwpmFilterAdd0` 调用 0 次**。
- **executor 不受影响**：`src/executor.mjs:2010-2011` 只读 `this.networkInstallEvidence`（由它自己调用
  `installNetworkPolicy` 产生），**不读** `options.networkInstall/networkAudit`；验证中给 executor 传伪造证据时，
  它仍然真的调了 6 次 `filterAdd` 并自己产生证据。
- 也就是说：洞只在**进程内能力报告 API**（`capabilityDimensions`/`resolveNetworkPolicy` 的公开入参）上，
  且需要调用方同时提供一个 WFP 绑定表。**不可从 CLI 触达**（全仓库没有任何生产代码传 `networkBindings`）。
  严重度按"可达性低 + 声明面失真"记为**中**。

**A6 默认档位是否零 WFP 调用** — `[实测]`
用 `Proxy` 统计绑定表属性读取次数：`new WindowsStageExecutor({networkBindings:proxy})` 默认档位
→ `state=not-implemented, enforced=false`，**绑定表读取 0 次**；`capabilityDimensions` 默认档位同样 0 次。
**结论：存活。**（判定顺序里绑定表/探测/引擎打开只在 `isOffline` 分支内。）

### 2.2 进程缓解策略

**B1 属性号独立算术** — `[实测]` `MITIGATION_POLICY_ATTRIBUTE = 0x20010`，
独立算术 `16 | 0x20000 = 0x20010` 一致；`MITIGATION_POLICY_VALUE_SIZE=8`。

**B2 是不是"默认就是关的"** — `[实测]`
- `new WindowsStageExecutor({})` → `profile='none'`, `flags=0x0000000000000000`, `noop=true`；
- `capabilityDimensions({})` → `profile='none'`, `noop=true`, `defaultProfile='none'`, `optIn=true`；
- `attributeListCountFor(null|undefined|'none'|{profile:'none'})` → **1**；`'baseline'/'hardened'/'untrusted'` → **2**；
- `'bogus'` → 抛 `MITIGATION_PROFILE_UNKNOWN`（executor 构造期即抛，不是等到启动）。
- 模块级 `buildMitigationPolicy()` 无参默认是 `baseline`（`src/mitigations.mjs:413,638`），
  但报告面与执行器都**显式**传 `'none'`，`appcontainer-runtime` 构造期 `options.mitigationPolicy ?? null`
  ⇒ `resolveMitigationPolicy(null) = null`。**结论：三处生产默认都是关的，存活。**
  唯一的坑（不是缺陷，是接口语义）：直接调 `applyMitigationPolicy({policy:'none'})` 时
  **仍会写一条 flags=0 的属性**（`src/mitigations.mjs:795,836`）——归一成 null 的逻辑只在
  `appcontainer-runtime.mjs:432-439` 里。作者已在注释里划线，但两个入口语义不同，集成方容易踩。

**B3 属性列表计数必须等于 2，且写入序列/尺寸正确** — `[实测]`（走**真实**启动原语
`spawnSuspendedAppContainer` + 记录型替身 Win32 表）

| 传入策略 | `InitializeProcThreadAttributeList` 的 count | `updateProcThreadAttribute` 序列 | 返回 `attributeCount` |
|---|---|---|---|
| `null` | 1 | `0x20009/24B` | 1 |
| `'none'` | 1 | `0x20009/24B` | 1 |
| `'baseline'` | 2 | `0x20009/24B` → `0x20010/8B` | 2 |
| `'hardened'` | 2 | 同上 | 2 |
| `'untrusted'` | 2 | 同上 | 2 |

**结论：存活**（`MITIGATION_ATTRIBUTE_LIST_COUNT=1`，非 no-op 时 `1+1=2`；两个 update 的属性号与
`valueSize` 逐项对上；`baseline` 的 flags `0x0000010111111107` 与按位号独立求和一致）。

**B4 策略写失败是否中止启动** — `[实测]`
让 `0x00020010` 的 `updateProcThreadAttribute` 返回 false、`GetLastError=122`
（属性列表容量不足这一已知 Windows 失效模式）：
抛 `APPCONTAINER_ATTRIBUTE_UPDATE_FAILED`（`win32Code=122`,
`mitigationCode=MITIGATION_ATTRIBUTE_UPDATE_FAILED`, `profile=hardened`），
且 **`createProcessW` 调用次数 = 0**。
另测：`MITIGATION_PIN_FAILED`（pin 返回 null）、`MITIGATION_BINDINGS_INVALID`（缺
`updateProcThreadAttribute`）、`MITIGATION_ATTRLIST_INVALID`（attrList=null）都抛。
`probeMitigationSupport` 五种输入下**没有任何"乐观返回 true"**的分支（无绑定表/无 attrList/抛错/返回 false 全为
`supported:false`）。**结论：存活。**

### 2.3 资源上限

**C1 重解析点是否越界 + 作者"lstatSync 对 junction 是盲的"这一声称** — `[实测]`（真 junction，`fs.symlinkSync(...,'junction')`）
本机 node v24.21.0 实测：
- `lstatSync(junc).isSymbolicLink() === false`、`isDirectory() === true`、
  `mode = 0x41b6`（`mode & 0x400 === 0`）、`ino` 与目标目录**完全相同**（`3659174697668815`）、
  目标目录删掉后 `lstatSync` 直接 `ENOENT`；
- 同一次 `readdirSync(..., {withFileTypes:true})` 里该 junction 的 `Dirent.isSymbolicLink() === true`、
  `isDirectory() === false`；
- `realpathSync(junc)` 返回 junction 自身；`realpathSync.native(junc)` 返回目标真实路径。
⇒ **作者的声称完全属实，我独立复现了每一条。**
- `measureTree(tree)`（`tree` 内 8 字节文件 + 一个指向树外 1 MiB 目录的 junction）：
  `bytes=8, skipped=1, errors=0, truncated=false`，skip 原因 `realpath-outside-tree`。
- `guard: () => false`（故意漏判）仍然 `bytes=8`、仍然被 skip ⇒ **guard 只能加严，不能削弱硬判据，存活。**
- 打开变异钩子 `followReparsePoints=true` 后同一棵树 `bytes=1048584`，复位后回 8
  ⇒ 这几行判据**真的**控制行为（`--plant` 变红的机制成立）。
- 树内**非环** junction（`link -> inner`，100 B 文件）：`bytes=100, files=2, skipped=0, truncated=false`
  ⇒ inode 去重生效，没有重复计字节。

**C2 统计不完整/被截断是否**拒绝**而不是放行** — `[实测]`
- `measureTree(maxEntries=2)` → `truncated=true` + `errors=[MEASURE_TREE_BOUND]`；
  `checkStagingQuota(...)` → `measure.complete=false`（注意：`allowed` 仍为 `true`，
  这是**模块自己的设计**：把"信不信这个账"留给调用方，注释写明了）。
- 两个在仓库内的调用方都接住了：
  - `WindowsStageExecutor.assertStagingQuota` → 抛 `STAGING_QUOTA_MEASUREMENT_INCOMPLETE`
    （用注入 `measureStaging` 返回 `errors:[{code:'X'}]` 实测）；
  - `Store.putBlob`（`src/store.mjs:241,272-281`）同样判 `complete===false`。
- **结论：在仓库内所有调用点，截断/出错都是拒绝写入（fail-closed），存活。**
  但注入缝有个形状依赖：`measureStaging` 返回 `{bytes:0}`（**没有** `truncated/errors` 字段）时
  `complete` 被算成 `true`、放行。生产不传 `measureStaging`，所以不是可达缺陷，
  但"报告缺字段 = 完整账"这个默认方向值得写进集成约束。

**C3 配额取值 0 / 负 / NaN / 小数 / Infinity** — `[实测]` 全部 fail-closed：
- `checkStagingQuota(quotaBytes=0, incoming=1)` → `allowed=false`；
- `-1 / NaN / 1.5 / Infinity / 2**53 / true / 'abc' / '64GiB' / '0' / null` → 抛 `LIMITS_INVALID`；
- `undefined` → 默认 64 GiB；
- executor(`stagingQuotaBytes=0`).assertStagingQuota(1) → `STAGING_QUOTA_EXCEEDED`；
  `-1/NaN/1.5/Infinity/'64GiB'` → 抛 `LIMITS_INVALID`；`null` → **显式关闭**（文档化的唯一关闭方式）；
- **"恰好用满"放行**：`assertStagingQuota(5)` with quota 5 → 放行（符合写下的契约）。
- `Store.putBlob`（quota=3，写 4 字节）→ 抛 `STAGING_QUOTA_EXCEEDED`，
  且 blob 目录里**文件数 = 0**（`[实测]` 确实"写入前拒绝"，不是事后发现）；
  quota=4 写 4 字节成功；同内容再写一次 hash 相同（去重语义未变）。
- **结论：存活。**

**C4 `applyOutputCap` 会不会吐出半个码点 / 静默丢输出** — `[实测]` 91 组 fuzz
（13 种输入 × 7 组上限，含 emoji、中文、落单代理项、CRLF、BOM、`maxBytes=0`、`maxLines=0`）：
- 违反不变量 **0** 条：未截断时逐字节原文返回且 `marker===null`；截断时
  `keptBytes + droppedBytes === 原文总字节`、保留段是原文前缀、标记必在末尾且**纯 ASCII**、
  保留段**不含落单代理项**、`truncated===true`。
- 落单代理项在切点**之前**且触发行截断时：抛 `OUTPUT_CAP_INVALID`（宁可抛，不发出坏码点）；
  未触发截断时原文返回。executor 的捕获路径是 `Buffer.toString('utf8')`，不会产生落单代理项，
  所以这条抛错路径在真实链路上不可达。
- **结论：存活（不会静默丢输出，也不会发出坏码点）。**
- 相关残余（不是本模块缺陷）：上限是在**收集完之后**才施加的（`src/executor.mjs:1968-1976` 先 `drainPipe`
  到内存，`2265` 再 cap），因此它**不限制子进程能产生多少输出**，只限制交出去的部分 —— 见 §5。

**C5 树内自指 junction（**我找到的新缺陷**）** — `[实测]`，见 **D1**
同一棵树，只把 `measureTree` 的 `maxEntries` 调大：

| maxEntries | entries | readdirSync | 耗时 |
|---|---|---|---|
| 30 | 30 | 15 | 6 ms |
| 300 | 300 | 150 | 44 ms |
| 3000 | 3000 | 1500 | 340 ms |
| 20000 | 20000 | 10000 | 2157 ms |
| **200000（生产默认）** | **200000** | — | **21080 ms** |

现场只有 **1 个 1 字节文件 + 1 个指向自身的 junction**。生产默认下一次 `measureTree` 要烧 **21 秒**。

### 2.4 默认值与回归

**D1' T0 闸门是否被放松** — `[实测]` + 源码核对
`src/capability.mjs:1427` 仍是字面量 `report.appContainerIsolation?.proven === true`；
`1453` 的 T0 分支要求 `writable && job && ac && acIsolationProven` 四条同时成立。
`tests/integration-wiring.mjs` 里也有一条源码级断言钉住这个字面量（本次复跑为绿）。
**结论：未放松。**

**D2' 新选项的默认值是否保持行为不变** — `[实测]`
`networkTier` 默认 `OBSERVED_ONLINE`（零 WFP 调用，见 A6）；`mitigationProfile` 默认 `none`
（属性列表 count 仍是 1，见 B2/B3）；`limits` 默认 64 GiB / 4 MiB / 200000 行
（`summariseLimits(undefined)` → `stagingGiB=64`, `maxOutputBytes=4194304`, `maxOutputLines=200000`,
`source='defaults'`, `stagingSource='[官方]'`, `outputSource='[推断]'`）。
**结论：默认值是行为保持型。**

### 2.5 Meta：判定力（`--plant` 必须真的红）

六个套件**逐个单独**跑（不并发），`[实测]` 退出码全部为 **1**，且都点名了被拆掉的东西：

| 套件 | `--plant` 结果 | 是否点名 |
|---|---|---|
| tests/netpolicy.mjs | `RESULT: FAIL checks=130 failures=26 mode=plant` | 是（如"无视能力缺口直接宣称网络已强制"） |
| tests/mitigations.mjs | `RESULT: FAIL checks=160 failed=4 mode=--plant` | 是（属性号/位号被改成假期望值） |
| tests/limits.mjs | `RESULT: FAIL (assertions=177 failures=6 skips=0 plant=true)` | 是（4a/4b/4e/4f/4g/4p 逐条） |
| tests/integration-wiring.mjs | `RESULT: FAIL checks=144 failures=37 mode=plant` | 是 |
| tests/suite-wiring.mjs | `RESULT: FAIL checks=29 failures=7 mode=plant` | 是 |
| tests/residual-baseline.mjs | `RESULT: FAIL checks=42 failures=5 mode=plant` | 是 |

⇒ 自报红数（26 / 4 / 6 / 37 / 7 / 5）**逐一属实**；"恒绿的假关口"这一风险不成立。

### 2.6 诚实性抽查

- `[实测]` `limits.mjs` 的 junction 声称（§2.3 C1）逐条复现；
  `limits.mjs:423` 的 "`ino`/`dev` 是真实数值"：`lstat('.').ino=3940649673955725`,
  `dev=2489330908`，都是 number。**属实。**
- `[实测]` `mitigations.mjs:33` 的"本机没有 SDK 头文件"：
  `C:\Program Files (x86)\Windows Kits\10`（含 `\Include`）与 `C:\Program Files\Microsoft Visual Studio`
  **均不存在**。**属实。**
- `[实测]` `netpolicy.mjs:119` 的历史声称"修复前 `guids:null` 会抛原生 TypeError"：
  底层 `planOfflineRules({guids:null})` 现在仍抛
  `TypeError: Cannot read properties of null (reading 'ALE_PACKAGE_ID')`
  —— 机制属实；修复后的 `netpolicy` 归一化路径由 `tests/netpolicy.mjs`（本次绿）断言为类型化
  `WFP_GUIDS_MISSING`。**该 `[实测]` 是一句"修复前"的历史记录，无法在不回退代码的情况下复跑，
  但机制与修复后的行为都对得上。**
- `[实测]` 被引用的证据文件都存在（抽样）：`.t/sbx3/dev/raw-t0-forensics.txt`、
  `raw-probe-koffi.txt`、`raw-t0-launch-matrix.txt`、`raw-t0-behaviour.txt`、
  `raw-probe-ac-token.txt`、`.t/sbx3/fixE/{before-diag-probeabi.out.txt,before-cli-probe.out.json,exp1.out.txt}`、
  `docs/Windows功能开启清单.md`。
- `[实测]` BFE 服务 `Running`（与 `wfp.mjs` 的 `describeWfpStatus` 注释一致）。
- `[实测]` `README` §5.1 / §8.2 / §9 的不支持陈述：见 **D3–D6**（有，且不止一处）。

---

## 3. 缺陷

严重度：**高** = 可导致安全边界失效；**中** = 可用性/声明面失真；**低** = 文档失真。
按验证规则，我**没有**修任何一处，只给可复现命令。

### D1（中）树内自指目录 junction 让 `measureTree` 反复重扫同一目录，配额统计退化为"永远不完整"

- **文件:行**：`src/limits.mjs:669-671`（把 `resolved` 路径入栈，没有"已访问目录/inode 环检测"）
  + `:545`/`:716-723`（只有 `maxEntries` 兜底，触发后置 `truncated`）。
  与 `tests/limits.mjs` 文件头 ⑥ 记录的旧缺陷（把**父目录**入栈）形态同族但**不是同一个**：
  这里是把**解析后的同一目录**反复入栈，形成自环。
- **复现**（`.t/adv/` 下的临时脚本，已验证）：
  ```
  # .t/adv/bomb = { a.txt(1B), loop -> 自身 }（fs.symlinkSync(BASE, BASE+'/loop', 'junction')）
  node .t/adv/bomb-repro.mjs     # maxEntries=30/300/3000/20000 的 readdir 次数与耗时
  node .t/adv/bomb-prod.mjs      # 生产默认 maxEntries=200000
  ```
- **观测 vs 期望**：
  - 观测：`maxEntries=30` → `entries=30, truncated=true, errors=[MEASURE_TREE_BOUND], readdirSync=15`；
    生产默认 `entries=200000`，**耗时 21080 ms**，`truncated=true`。
  - 期望：一棵只有 2 个条目的树应在毫秒级量完，且**不因链接自环**而截断。
- **后果链（fail-closed，但方向是"沙箱不可用"）**：
  `measureTree` 返回 `complete=false` → `checkStagingQuota` 报 `complete:false` →
  `Store.putBlob`/`WindowsStageExecutor.assertStagingQuota` 抛
  `STAGING_QUOTA_MEASUREMENT_INCOMPLETE` ⇒ **该工作区再也写不进暂存**（每次判定还要先烧 21 秒）。
- **判定**：安全方向没有被绕过（不会超配额写入），但这是**廉价的不可用性攻击/故障**
  （1 个 junction 换 21 秒 CPU + 永久拒绝写入），且 `--plant` 与现有 175 条断言都覆盖不到。
  写进来的 junction 可以来自工作区本身（pnpm/build 缓存很常见）。
- **建议方向（未实施）**：遍历时维护"已入栈真实路径 / 目录 inode"集合，命中即记
  `skipped: {kind:'cycle'}` 并跳过；或对每个真实目录只展开一次。

### D2（中，可达性低）能力报告面接受调用方伪造的"安装证据"，可在**零条过滤器**的情况下报 `enforced:true`

- **文件:行**：`src/netpolicy.mjs:342`（`enforcementFromEvidence({plan, install, audit})`）
  + `:366-420`（只数 `install.installed.length`、只看 `audit.verified`，**不验证证据来源**）；
  `src/capability.mjs:1055-1056`（把 `options.networkInstall ?? null` / `options.networkAudit ?? null`
  原样透传）。
- **复现**：
  ```
  node .t/adv/honesty.mjs     # §H3：capabilityDimensions + 伪造 install/audit
  ```
- **观测 vs 期望**：
  - 观测：`state='enforced', enforced=true, verified=true`，
    而 WFP 调用日志只有 `[engineOpen, engineClose]`，**`FwpmFilterAdd0` 调用 0 次**。
  - 期望：报告里出现"网络已强制阻断"时，至少要有一次真实 `FwpmFilterAdd0`（或明确标注"证据由调用方提供"）。
- **边界（必须一起读，否则会高估影响）**：
  - **executor 不受影响**：`src/executor.mjs:2010-2011` 只用自己的 `networkInstallEvidence`，
    我实测"给 executor 传伪造证据"时它仍然真的装了 6 条（`filterAdd=6`）。
  - **CLI 不可达**：全仓库没有任何生产代码传 `networkBindings`（只有注释与测试），
    所以这个洞目前只能在"进程内调用 `capabilityDimensions`/`resolveNetworkPolicy` 并转发了不可信 options"时被触发。
- **判定**：这是本轮"fail-closed 网络声明"这条链上**唯一**能被构造成 `enforced:true` 而无任何安装动作的路径。
  作者文档里的措辞（"`enforced:true` 只在安装证据齐全且回读通过时出现"）在**字面上**成立
  （确实有一个 `install` 对象），但在**语义上**过度承诺：证据没有来源校验。
  建议方向（未实施）：`capabilityDimensions` 一侧不接受外部 `install/audit`，或给摘要加
  `evidenceSource:'caller'` 标记并在 `enforced:true` 时要求 `verified:true` 且证据带 HMAC/内部令牌。

### D3（低，文档）`README` §9.4 与 §8.2 的"待落盘缺口"在当前交付状态下是假的

- **文件:行**：`README.md:633-636`（"截至本次交付该文件**仍不存在**"、"请移除
  `tests/suite-wiring.mjs` 中 `PENDING_REGISTRATIONS` 的那一条"）与 `README.md:522-525`（同一说法的旧版）。
- **实测**：`tests/integration-wiring.mjs` **存在**，本次跑出 `RESULT: PASS checks=144 failures=0`；
  `tests/suite-wiring.mjs:82-83` 已明确写着那张 `PENDING_REGISTRATIONS` 表"**曾经**有"（已被删除）；
  `verify.cmd` 20 套件 `ALL PASS`。`README §9.4:623` 说 suite-wiring 是 29 项，正常模式实测为 **28** 项
  （29 是 `--plant` 模式多出的那条元断言）。
- **观测 vs 期望**：文档说"红点仍在、文件不存在"；实际"文件在、关口绿、豁免表已删"。
- 判定：**交付文档与交付物的当前状态不一致**，属于本项目最忌讳的"看起来有缺口/看起来没缺口"的错位。

### D4（低，文档）`README` 仍说 "T0 未接线到执行器 / AppContainer 本项目未实现"，与代码相反

- **文件:行**：`README.md:384`（"尚未接线到执行器"）、`389-393`（"T0 **仍未接进
  `WindowsStageExecutor`** ⇒ 实际运行在 T1"）、`410`（档位表同一说法）、`482`、`564`（§8.3）。
  另外 `README.md:423`（§6 R1）说"读取面收敛只能靠 AppContainer（**本项目未实现**）"，
  与同一份文档 §5.1:384 的"AppContainer 运行期已 `[实测]` 生效（`proven=true`）"自相矛盾。
- **实测/源码**：`src/executor.mjs:3380-3382` `selectLaunchMode('T0') → mode:'appcontainer'`；
  `:1544-1547` 写入 `launchMode`；`:1669-1704` 显式请求 T0 时装配 `createAppContainerLauncher`，
  失败即 `SANDBOX_UNAVAILABLE`（不静默回退 T1）；`:2181-2192` 是 T0 启动分支。
  也就是说 T0 **已经**接进执行器（仅当调用方显式要 T0；`selectTier()` 仍要求 `proven===true`，
  这一点两处文档都没说错）。
- 判定：文档**低报**了自己的能力，读者无法据此判断现状；且文档内部互相矛盾。

### D5（低，文档）`src/limits.mjs` 头部与尾部的"本模块不接线"已过期

- **文件:行**：`src/limits.mjs:23`（"它**不**接线到 `src\store.mjs` / 捕获路径 —— 接线由集成方完成"）
  与 `:1202`（"本模块**不**自己接线 —— 任务边界"）。
- **实测**：`src/store.mjs:241`（`putBlob` 写入前调用 `assertStagingQuota`）、
  `src/executor.mjs:2150`（`run()` preflight）与 `:2265-2266`（stdout/stderr 走 `applyOutputCap`）
  都接了。作者在其它地方（§9.3、`integration-wiring`）又说接了 —— 同一交付物里两种说法。
- 附带：`src/limits.mjs:25` 写"见 `tests\limits.mjs` 的 **60** 项断言"，实测该套件 **175** 项。

### D6（低，诚实性/文档）`README` §8.2 的套件表数字与本机全量复跑结果不符（部分行差 2–3 倍）

`[实测]` 本次 `verify.cmd` + `autotest.mjs` 的逐套件断言数 vs `README.md:494-516`：

| 套件 | README 写 | 本次实测 | 差 |
|---|---|---|---|
| executor-stub | 84 | 143 | +59 |
| paths-masks | 37 | 58 | +21 |
| registry-guard | 125 | 378 | +253 |
| workspace-regressions | 10 | 16 | +6 |
| appcontainer-runtime | 140 | 178 | +38 |
| netpolicy / mitigations / limits / integration-wiring / wfp-layout | "自报"（无数） | 129 / 160 / 175 / 144 / 146 | 未填 |
| suite-wiring | 29 | 28（`--plant` 29） | 口径混用 |
| verify.cmd 合计 | "不再写单一数字" | 20 套件 / ≈1819 断言 | 未填 |

- README 的脚注（`:518-520`）确实声明"标自报的行必须由一次全量复跑填入，不得凭印象补"，
  历史行的偏差也被"历史口径"标注覆盖 —— 所以这**不是**编造，而是**该填的没填**：
  交付时一次全量复跑已经存在（本报告 §1.1），但 §8.2 仍是占位符；同时 5 行历史数字与当前相差巨大，
  读者若按表行事会误判。
- 另外 `limits.mjs:25` 的 "60 项断言" 同族（见 D5）。

### 我试过但**没有**构成缺陷的项（避免读者以为漏了）

- `verify.cmd` 吞失败：**不成立**（复刻脚本 + `_planted-failure` 实测 `RESULT: FAIL` + 退出码 1；
  `autotest.mjs:125` 实测退出码 1）。
- `verify.cmd` 含非 ASCII：**不成立**（>0x7F 字节数 0）。
- 小写/带空白档位静默变成"不阻断还照跑"：**不成立**（A1）。
- `refused` 携带 `enforced:true`：**不成立**（540 组样本 0 例）。
- 缓解属性默认被打开：**不成立**（三处生产默认 `none`，`attributeCount=1`）。
- 属性列表容量算成 1 却写两条（`ERROR_INSUFFICIENT_BUFFER` 的成因）：**不成立**（B3 实测 2/2）。
- 策略写失败继续启动：**不成立**（`createProcessW` 0 次）。
- `applyOutputCap` 发出坏码点/静默丢输出：**不成立**（91 组 fuzz 0 违反）。
- 越界 junction 被计入字节：**不成立**（`bytes=8`，skip 有痕，guard 无法削弱）。
- T0 闸门被放松：**不成立**（`proven === true` 字面量在）。

---

## 4. 声明逐条状态表

| # | 声明 | 状态 | 依据 |
|---|---|---|---|
| 1 | `verify.cmd` 20 套件 `RESULT: ALL PASS` | **已验证** | §1.1，exit 0 |
| 2 | `netpolicy` 129 项 / `--plant` 26 红 | **已验证** | §1.1 + §2.5（plant 实测 26，且 checks=130） |
| 3 | `mitigations` 160 项 / `--plant` 4 红 | **已验证** | §1.1 + §2.5 |
| 4 | `limits` 175 项 / `--plant` 6 红 | **已验证** | §1.1 + §2.5 |
| 5 | `integration-wiring` 144 项 / `--plant` 37 红 | **已验证** | §1.1 + §2.5 |
| 6 | `suite-wiring` 28 项 | **已验证**（plant 模式 29 项，README 用错口径） | §1.1 + D3 |
| 7 | `residual-baseline` 41 项 | **已验证** | §1.1 |
| 8 | `OFFLINE_SUITES` = 20 且 `verify.cmd` id-for-id 一致 | **已验证** | §1.3（手工复核，非只信 `suite-wiring`） |
| 9 | OFFLINE 档位 fail-closed：能力不足即 REFUSED | **已验证**（本机无真实安装能力 ⇒ 恒 REFUSED） | §2.1 A1/A2、§2.6 |
| 10 | "绝不谎报 `enforced:true`" | **部分验证 / 有洞** | 执行器侧成立；报告 API 侧可被伪造证据说服（**D2**）；无回读入口时 `enforced:true/verified:false` 是文档化设计 |
| 11 | 未知/大小写档位不会静默降级 | **已验证** | A1 |
| 12 | 中途失败主机零残留、拆除顺序正确 | **已验证** | A3（替身日志） |
| 13 | 默认档位零 WFP 调用 | **已验证** | A6 |
| 14 | 缓解属性默认关（executor/能力报告/appcontainer runtime） | **已验证** | B2（模块级无参默认 `baseline`，但三处生产入口显式 `none`） |
| 15 | 非 noop 时 `attributeCount === 2` | **已验证** | B3（走真实启动原语） |
| 16 | `applyMitigationPolicy` 失败中止启动 | **已验证** | B4（`createProcessW` 0 次） |
| 17 | 真实 `0x00020010` 的内核效果 | **本机不可验证** | §5（无 SDK、未做真实 CreateProcess） |
| 18 | 统计不完整/截断 ⇒ 拒绝写入 | **已验证**（仓库内两个调用点都接住） | C2 |
| 19 | `stagingQuotaBytes` 0/负/NaN fail-closed | **已验证** | C3 |
| 20 | `applyOutputCap` 不吐坏码点、不静默丢输出 | **已验证** | C4 |
| 21 | `measureTree` 不跟随树外 junction；"lstatSync 对 junction 是盲的" | **已验证**（逐条复现） | C1 |
| 22 | `measureTree` 的遍历不会被链接自环拖垮 | **被证伪** | **D1**（生产默认 21 秒 + 永久"统计不完整"） |
| 23 | T0 闸门仍要求 `proven === true` | **已验证** | §2.4 D1' |
| 24 | 新选项默认值行为保持 | **已验证** | §2.4 D2' |
| 25 | `--plant` 能让 6 个套件真的红 | **已验证** | §2.5 |
| 26 | `[实测]` 标注都有本机依据 | **大体成立**（junction/ino/dev/SDK 缺失/证据文件/机制复现均已抽查），**但** `limits.mjs:25` 的 "60 项" 与 `:23/:1202` 的"不接线"已过期 | §2.6、D5 |
| 27 | `README` §5.1 / §8.2 / 新章节的陈述都被代码支持 | **被证伪** | **D3 / D4 / D6** |
| 28 | `verify.cmd` 纯 ASCII 且不吞失败 | **已验证** | §1.3 |
| 29 | 真实 WFP 过滤器被安装 / 网络真的被挡住 | **本机不成立** | §5（R2 仍未收敛） |

---

## 5. 仍未提供的保证（本机无法证明的部分）

以下每一条都**不是**"通过"，请与 §1 的绿灯一起读：

1. **真实 WFP 过滤器的安装与生效 —— `[未实测]`。**
   全仓库没有任何生产代码向 executor/能力报告传 `networkBindings`（只有注释与测试），
   所以本机 `networkTier='OFFLINE'` 只会得到 `refused` ⇒ `SANDBOX_NETWORK_POLICY_UNENFORCED`。
   一次真实的 `FwpmFilterAdd0`/`FwpmSubLayerAdd0`、真实 BFE 裁决、以及"沙箱内 curl 真的失败"
   都**没有**在这台机器上发生过。`README §9.1` 与 `summarise().guaranteesNotProvided` 对这一点是诚实的。
2. **`PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY`（`0x00020010`）的内核效果 —— `[未实测]`。**
   属性号只有"winnt.h 宏推导 + 同规则已实测的 `0x00020009`"这一条证据链；
   本机无 SDK 头文件（已核对），也没有在真实 `CreateProcess` 上用该属性启动过任何子进程。
   "ACG/CIG/禁 Win32k 真的拦住了什么"**完全未验证**；`--plant` 只证明"位号写错会红"。
3. **AppContainer T0 的默认选择 —— 本会话 `[未实测]`。**
   `selectTier()` 的闸门是 `proven === true`，而 `proven` 需要跑一次真实隔离探针；
   本次验证没有跑该探针（受限会话 + 会创建真实 profile）。结构上：不显式请求 `tier:'T0'` 就不会走 T0，
   默认路径仍是 T1。`README §5.1` 关于"T0 未接线"的说法已被代码推翻（D4），
   但"默认档位会不会自动升到 T0"这件事**不能**由本次验证背书。
4. **读取面收敛（R1）—— 未改变。**
   本轮三个模块都不触碰读面；`README §6`/`§8.3` 与 `guaranteesNotProvided` 也如实保留这一条。
5. **网络面收敛（R2）—— 未改变。** 沙箱内实际仍可开 socket（没有真实过滤器）。
   另外 §3 D2 表明：即使将来接上真实绑定表，只要调用方走的是能力报告 API 且证据可注入，
   `enforced:true` 仍可能没有对应的真实安装动作。
6. **暂存配额不等于 NeoAI 的 cgroup `disk_bytes`。**
   `[实测]` 配额只在**宿主侧** `Store.putBlob`（`store.mjs:241`）与 `run()` 之前的
   preflight（`executor.mjs:2150`，`incomingBytes=0`）生效；
   受限子进程**自己**往暂存树里写多少字节，本轮**没有任何**上限，也没有运行后的复量。
   所以"64 GiB 暂存配额"目前只覆盖"宿主把内容物化成 blob"这一条路，不覆盖"子进程直接写暂存目录"。
7. **输出上限不限制子进程产出量。**
   `[推断]`（源码顺序清楚）：`executor.mjs:1968-1976` 先把 stdout/stderr 全部收进内存，
   `:2265` 才做 `applyOutputCap`。因此 4 MiB/200000 行是"交出去的上限"，
   不是"子进程能消耗的内存/磁盘上限"。
8. **无回读入口时 `enforced:true / verified:false` 是文档化设计，不是独立验证。**
   若未来的绑定表只提供 `Add/Delete` 而没有 `GetByKey/Enum`，
   executor 的闸门（只看 `state === ENFORCED`）会放行 —— 此时"网络已强制"的全部依据是
   `FwpmFilterAdd0` 返回 0。这一点 `README §9.1` 有写，但它是**声明面的极限**，不是证据。
9. **本轮 `--plant` 只覆盖被作者点名的变异点。** 我另加的 D1（自环 junction）说明
   "现有断言全绿"与"没有别的失效形态"是两件事。
10. **`autotest.mjs` 的沙箱段在本会话不可作为回归证据。**
    `file-cow-dispositions`（2 个已知 GAP）与 `registry-unstaged-wow64`（真实 hive 前置失败）
    必须在**未受限**会话复跑才能定性；本报告只把它们的失败归因到"会话受限 + 既有 GAP"，
    不主张它们没有回归。

---

## 附：本次验证用到的临时脚本（已删除，命令可复现）

`[实测]` 全部在 `.t/adv/` 下现写现跑，**跑完已删除**（含现场里的 junction / 1 MiB 文件）：

| 脚本 | 用途 |
|---|---|
| `.t/adv/net-attacks.mjs` | 档位归一、540 组不变量扫描、伪造证据、替身自答自证、拆除顺序、零调用 |
| `.t/adv/mit-attacks.mjs` | 常数算术、默认档、`attributeListCountFor`、`applyMitigationPolicy` 形状与 fail-closed、真实启动原语的 count/序列 |
| `.t/adv/lim-attacks.mjs` | junction 事实核查、逃逸/guard/变异钩子、树内 junction、截断、配额取值、`putBlob`、91 组输出 fuzz |
| `.t/adv/bomb-repro.mjs` / `.t/adv/bomb-prod.mjs` | 自环 junction 的重扫计数与生产默认耗时（D1） |
| `.t/adv/honesty.mjs` | `guids:null` 机制、`ino/dev`、能力报告被伪造证据说服（D2） |
| `.t/adv/failcheck.cmd` + `tests/_planted-failure.mjs` | 复刻 `verify.cmd` 的失败传播模式 |

保留的验证产物：`.t/verif-final-verify.txt`（主关口全量输出）、`.t/verif-autotest.txt`
（`autotest --skip-audit` 全量输出）—— 二者由本报告 §1 的命令生成。

---

# 第二轮复核（修复后冻结版）

- 复核者立场：**第二轮独立验证者**，未参与第一轮审计，也未参与本轮修复。任务是**独立复现**修复声明，不采信修复 agent 自报的任何数字。
- 复核对象：修复后的**冻结**工作区（`C:\Users\Administrator\Desktop\WinStageSandbox`，node v24.21.0，workspace-write 受限会话）。
- 复核者改动的文件：**仅本文件（追加本节）** 与 `.t/` 下临时脚本（跑完已删）。源码/测试/配置**未改动**。
- 证据分层沿用第一轮：`[实测]` = 本轮在本机真的跑出该结果；`[模拟]` = 我写的复刻脚本（不是被测代码）；`[未实测]` = 本机无法证明。
- 命令约定：`cmd /c "… > .t\v2-*.txt 2>&1"`（本会话直接 pwsh 管道到 node 被禁用）。

## R1. 主关口（独立复跑）

`[实测]` `cmd /c "verify.cmd > .t\v2-final-verify.txt 2>&1"` → **退出码 0**，末尾 `RESULT: ALL PASS`，
`RESULT: FAIL` 出现 **0** 次，**20** 个 `=== tests\X.mjs ===` 块，按块统计 `✓`/`[OK  ]` 标记合计 **1838**。
逐套件与修复声明/README §8.2 表逐行核对，**全部一致，无一处不符**：

| 套件 | 本轮实测 | 声明 | 套件 | 本轮实测 | 声明 |
|---|---|---|---|---|---|
| selftest | 51 | — | probe-selfkill-guard | 27 | 27 |
| e2e-flow | 21 | — | netpolicy | 139 | 139 |
| struct-layout | 24 | — | mitigations | 160 | 160 |
| appcontainer-layout | 34 | — | limits | **182** | 182 |
| resolve-exec | 19 | — | integration-wiring | 144 | 144 |
| executor-stub | **143** | 143 | wfp-layout | **146** | 146 |
| audit-parse | 43 | — | suite-wiring | **28** | 28（不是 29） |
| paths-masks | **58** | 58 | residual-baseline | **43** | 43 |
| registry-guard | **378** | 378 | **合计** | **1838** | 1838 |
| workspace-regressions | **16** | 16 | meta-runner | 4 | — |
| appcontainer-runtime | **178** | 178 | | | |

## R2. D1（`measureTree` 目录环）——独立复现

`[实测]` 自写脚本 `.t/v2-d1.mjs`（已删），现场 `.t/v2-d1-root`（已删）。生产默认（`maxEntries=200000`）：

| 场景 | 耗时 | entries | files/dirs | truncated | skipped | complete/allowed |
|---|---|---|---|---|---|---|
| 1 字节文件 + `loop -> BASE`（自指 junction） | **1.22 ms**（插桩跑 3.03 ms） | **3** | 1 / 1 | **false** | 1（`already-visited-cycle` + `notes:cycle-skipped`） | **true / true** |
| 互指（A→B 且 B→A） | 3.08 ms | 7 | 2 / 3 | false | 2（均为 `already-visited-cycle`） | — |
| `checkStagingQuota(root=BASE, incoming=1)` | 1.79 ms | — | — | false | 1 | `allowed=true, usedBytes=1, complete=true` |

- **声明数字逐个对上**：修复 agent 声明的 `1.63 ms / entries=3 / truncated=false / complete=true / allowed=true` 与我的 `1.22–3.03 ms / entries=3 / false / true / true` 一致（耗时为噪声级差异）。
- `entries=3` 的口径已查明：`src\limits.mjs:519` 为**根自身**记 1 条，此后才是 `a.bin`、`loop` 两条 ⇒ 3。不是重复扫描。
- **机制证据**（不是只看结果）：用插桩 `fsImpl` 统计 `readdirSync` 调用 = **1 次** ⇒ 该真实目录只被展开一次。
- **不变式 (a)**：`ESC = {small.bin(8B), out -> 树外 1 MiB 目录}` ⇒ `bytes=8`、`files=1`、外部 1 MiB **一字节未计**，`skipped=[{kind:'symlink+realpath-escape', reason:'realpath-outside-tree:…\outside'}]`。
- **不变式 (b)**：`guard: () => false`（故意漏判）⇒ 仍是 `bytes=8`、仍被 skip（硬判据未被削弱）；`guard: () => true`（加严）⇒ `bytes=0`（整棵被跳过，方向只会更保守）；`guard` 抛错 ⇒ 按"是链接"处理，`bytes=0`。**结论：guard 只能加严，存活。**
- `[模拟]` 我另写一段**旧逻辑复刻**（无 `visitedDirs`，其余判定路径照抄）跑同一棵树：`entries=200000`、`bytes=100000`、`truncated=true`、耗时 **57.7 s**。与第一轮记录的 21080/22033 ms 同量级（我的模拟更慢），**旧缺陷形态与量级可信**；但 22033 ms 这个**具体数字**本轮无法回退代码复跑，只能算旁证。
- **行为变化（已声明，非缺陷）**：树内**别名**链接（`link -> inner`，都在树内）现在 `bytes=100`、`files=1`、`skipped=1`；第一轮是 `files=2 / skipped=0`。字节数不变（配额判定只读 `bytes`），`src\limits.mjs:554-555` 已如实写明这一副作用。

## R3. D2（伪造安装证据）——独立复现 + 品牌击破

`[实测]` 自写脚本 `.t/v2-d2.mjs`（已删），自造替身绑定表（不复用 `tests/netpolicy.mjs` 的替身）。

- **伪造证据（原始 D2 形状）**：`capabilityDimensions({networkTier:'OFFLINE', networkBindings:<替身>, networkGuids, networkProbe:{available:true}, networkInstall:{installed:[6 条]}, networkAudit:{verified:true}})`
  ⇒ `state='not-enforced'`、`enforced=false`、`verified=false`；
  底层调用日志 = `engineOpen,engineClose`，**`filterAdd` = 0 次**。直接调 `resolveNetworkPolicy` 同样 `not-enforced / false / false`。
  **与声明一致，D2 的方向性 fail-open 已关闭。**
- **正例仍成立**：`installNetworkPolicy()` over 替身表 ⇒ `installed=6`、`filterAdd=6`、`subLayerAdd=1`、`getByKey=6`、`audit.verified=true`；
  同一证据 + 同一 `audit` 走能力报告 ⇒ **`state='enforced' / enforced=true / verified=true`**。
  `tests/integration-wiring.mjs`（驱动执行器真实安装路径）在本轮关口 **144 项全绿**。
- **品牌击破（全部被拒，方向 fail-closed）**：

| 攻击 | 结果 |
|---|---|
| `{...inst}` | `not-enforced`，reason=`not-branded` |
| `Object.assign({}, inst)` | `not-enforced`，reason=`not-branded` |
| `JSON.parse(JSON.stringify(inst))` | `not-enforced`，reason=`not-branded` |
| `structuredClone(inst)` | 抛 `DataCloneError`（函数不可克隆），无法造出证据 |
| 抄走品牌 Symbol（`getOwnPropertySymbols` + `defineProperty`） | `not-enforced`，reason=`not-produced-by-installNetworkPolicy`（WeakMap 才是权威） |
| 真证据 + **另一张** `api` | `not-enforced`，reason=`api-mismatch` |
| 真证据 + **换 target** 的计划 | `not-enforced`，reason=`plan-mismatch` |
| 真证据 + 伪造 `{verified:true}` 的 audit | `not-enforced`，reason=`audit-mismatch` |
| `teardown()` 之后再用同一证据 | `not-enforced`，reason=`evidence-torn-down`（且 `hostFilters=0`、`failures=[]`） |
| 篡改 `inst.installed.length = 0` / `filterIds.length = 0` | **仍 `enforced:true`**（计数来自冻结快照，不被调用方数组影响） |

- `enumeration-unavailable` 的替身（无回读入口）：`enforced=true / verified=false`，且篡改 `installed` 长度不影响判定 ⇒ 第一轮 §5.8 的"已强制但未独立验证"口径仍成立。
- **但快照不完整 ⇒ 新发现 N1/N2（见 R6）**：冻结只覆盖 `installed/filterIds`；`record.plan` 与 `record.audit` 仍是**调用方可见对象的引用**。

## R4. 回归清扫（第一轮已确认的不变量）

`[实测]` 自写脚本 `.t/v2-reg.mjs`（已删），全部存活：

| 项 | 结果 |
|---|---|
| 未知/畸形档位 `'offline'/'Offline'/'OFFLINE '`/前导空格/`'OFFLINE\n'`/`'OFfline'`/`42`/`{}`/`[]`/`true`/`['OFFLINE']`/`null` | 全部抛 `NETWORK_TIER_INVALID`（12/12）；报告面降级为 `unknown`、`enforced=false`（`null` 走默认 ⇒ `not-implemented`，与文档一致） |
| `refused`/`not-implemented` 携带 `enforced:true` | **0 例**（无 api / 缺绑定 / probe 不可用 / 非 OFFLINE 默认档） |
| 中途 WFP 失败（第 3 条 `filterAdd` 失败） | 抛 `NETWORK_POLICY_INSTALL_FAILED`；宿主 `filters=0 / sublayers=0`；删除序 **逆序**；`engineClose` 1 次；`teardownFailures=[]`。调用序：`engineOpen,subLayerAdd,filterAdd×3,filterDelete×2,subLayerDelete×2,engineClose` |
| 默认档位的绑定表读取 | **0 次**（`Proxy` 计数；`resolveNetworkPolicy` 与 `capabilityDimensions` 都是 `not-implemented`） |
| 缓解默认 | `capabilityDimensions({}).mitigations` ⇒ `profile='none' / noop=true`；`attributeListCountFor(null/undefined/'none'/{profile:'none'})` = **1**；`baseline/hardened/untrusted` = **2**；`'bogus'` ⇒ `MITIGATION_PROFILE_UNKNOWN` |
| 配额取值 | `quotaBytes=0` ⇒ `allowed=false`；`-1/NaN/1.5/Infinity/'64GiB'/true` ⇒ `LIMITS_INVALID`；恰好用满 ⇒ 放行 |
| `applyOutputCap`（8 输入 × 7 上限 = 56 组） | **静默截断 0**；非 ASCII 标记 0；**截断结果落单代理项 0**；未截断时逐字节原文（identityLoss=0）。3 处落单代理项全部出现在**未截断**的原文回传（输入本身已畸形），与第一轮"未触发截断时原文返回"一致 |
| `verify.cmd` 纯 ASCII | 2959 字节，`>0x7F` 计数 **0** |

## R5. Meta：`--plant` 仍真的红且非空洞

`[实测]` 逐个单独跑（不并发）：

| 套件 | `--plant` 结果 | 退出码 |
|---|---|---|
| `tests/limits.mjs` | `RESULT: FAIL (assertions=184 failures=6 skips=0 plant=true)` | 1 |
| `tests/netpolicy.mjs` | `RESULT: FAIL checks=140 failures=31 mode=plant` | 1 |
| `tests/residual-baseline.mjs` | `RESULT: FAIL checks=44 failures=5 mode=plant` | 1 |
| `tests/suite-wiring.mjs`（附带） | `RESULT: FAIL checks=29 failures=7 mode=plant` | 1 |

- limits 的 6 红 = `4a/4b/4e/4f/4g/4p`（**恰好 6**，与声明一致）。netpolicy 的 31 红里**包含新增的 D2 断言** `2g(×2)/2h/2i/2j`（第一轮 26 红 → 31 红），residual-baseline 5 红、suite-wiring 7 红。
- **不是空洞**（独立验证，不看套件自报）：用 `__internal.setTestHooks({followReparsePoints:true, disableHardlinkDedupe:true})` 实测**源码行为真的变了** —— 同一棵逃逸树 `bytes 8 → 1048584`，`resetTestHooks()` 后回到 `8`。同时**自指 junction 树在钩子打开时仍是 `entries=3 / truncated=false / complete=true`** ⇒ D1 的环检测独立于 `--plant` 钩子，新增的 `4v–4ab` 断言在两种模式下都过，**没有把 `--plant` 冲淡**。

## R6. 新发现（本轮修复本身留下的两个洞，同一根因）

**N1（中，可达性低）`install.audit` 是可变共享对象 ⇒ 可把"已强制但未独立验证"升级成"已核对"。**
- 复现（`.t/v2-d2.mjs` §8，已删）：无回读入口的替身 ⇒ 真安装后 `resolveNetworkPolicy(...)` 得 `state='enforced' / enforced=true / verified=false`（`audit.reason='enumeration-unavailable'`）；随后 `inst.audit.verified = true; inst.audit.reason = 'verified'` ⇒ **同一证据重判得 `verified=true`**。
- 文件:行：`src/netpolicy.mjs:699`（`audit: auditResult` 按引用存入记录）+ `:500`/`:509`（判定直接读 `record.audit.verified`）。
- 这正是 `verifyInstallEvidence()` 注释里点名"**不允许的 fail-open 方向**"：`audit-mismatch` 只校验**同一性**，而记录持有的就是那个可变对象。冻结快照只覆盖了 `installed/filterIds`。

**N2（低）`install.plan` 是可变共享对象 ⇒ 计划指纹校验可被绕过。**
- 复现：真安装（target=appcontainer）后 `inst.plan.filters = <app-identifier 计划>.filters; inst.plan.subLayerKey/target = …`，再以 `target:'app-identifier'` 判同一证据 ⇒ **`enforced:true / verified:true`**（未经变动时为 `plan-mismatch`）。被违反的声明是 `src/netpolicy.mjs:148-149` 的"判据 5：计划指纹一致"。
- 文件:行：`src/netpolicy.mjs:697`（`plan,` 按引用存入）+ `:168-169`（每次重算 `planFingerprint(record.plan)`）。
- 影响有限：只能在 appcontainer ↔ app-identifier 两个 OFFLINE 目标间互换；既不伪造"装过过滤器"这一事实，也需要持有真证据对象（同一信任域）。**两洞的修法同源**：安装时就把 `plan` 指纹算成**字符串**存下、把 `audit` 存成冻结快照（`{verified, reason}`），不要存引用。

## R7. 诚实性与文档缺陷（D3–D6）复核

- `[实测]` 我 grep 了全部被改文件的 `[实测]` 标注并逐条对照本机能跑的东西：
  - **可复跑且我已复跑的**：`src/limits.mjs:28-31`（182 项）、`:431`（`ino/dev`）、`:541-547` 的**修复后**行为、`src/netpolicy.mjs:120-124` 的**修复后**结果、`tests/limits.mjs` 的 junction 事实、`tests/netpolicy.mjs:680` 的"修复后"结果 —— 全部与我的独立观测一致。
  - **属于"修复前"的历史标注**（无法不回退代码复跑）：`limits.mjs:541-547`/`tests/limits.mjs:28,500-505` 的 22033 ms、`netpolicy.mjs:111-119` 与 `tests/netpolicy.mjs:676` 的修复前 fail-open、`netpolicy.mjs:200` 的 `guids:null` 旧形态。这些**都写明了是修复前/独立验证会话的时点**，且我复刻的旧逻辑与第一轮记录同量级 ⇒ **不构成 overclaim**，但"22033 ms"这一具体数字本轮**未被独立证实**。
  - **未发现**把"未跑到的东西"标成 `[实测]` 的情形。
- `[实测]` README T0 陈述与源码一致：`src\executor.mjs:1304` `this.tier = options.tier || 'T1'`；`:3380-3382` `selectLaunchMode('T0') → 'appcontainer'`；`:1544-1547` 写入 `launchMode`；`src\capability.mjs:1436` 字面量 `report.appContainerIsolation?.proven === true`，`:1462` 四条同时成立才返回 T0。README 引用的行号（`capability.mjs:1436`、`:1462`、`executor.mjs:1304`、`:3380-3382`）**逐条对得上**（第一轮的 `:1427` 行号因本轮改动已整体位移，README 已同步改写）。
- `[实测]` README §8.2 套件表 20 行数字与我本轮关口日志**逐行一致**，合计 1838；口径说明（1838 = 1819 + limits+7 + netpolicy+10 + residual+2）成立。
- `[实测]` 第一轮文档缺陷已修：`tests/suite-wiring.mjs` 的 `PENDING_REGISTRATIONS` 只剩历史注释（`suite-wiring.mjs:82`），正常模式 **28**（`--plant` 29）；README §8.2/§9.4 的"文件仍不存在 / 请移除豁免表"旧文已改为"已落盘、豁免表已删除"；`src\limits.mjs:23` 已改为"**已经接线**"、`:1247/:1250` 已改为"已落地的三处调用点"、`:29` 的"60 项"已改为 **182**；README 不再残留 `60 项` 或 `capability.mjs:1427`。

## R8. 本机仍无法证明的保证（与第一轮一致 + 本轮新增）

1. **真实 WFP 过滤器安装 / 真实 BFE 裁决 / 沙箱内真的被阻断（R2）** —— `[未实测]`，仍未收敛。
2. **`PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY`（`0x00020010`）的内核效果** —— `[未实测]`（无 SDK、未做真实 `CreateProcess`）。
3. **AppContainer T0 的默认选择** —— `[未实测]`（需真实隔离探针；默认仍是 T1）。
4. **读取面收敛（R1）** —— 未改变。
5. **暂存配额不覆盖"受限子进程自己往暂存树里写"** —— 没有运行后复量。
6. **输出上限不限制子进程产出量** —— 上限在收集之后才施加。
7. **无回读入口时的 `enforced:true / verified:false` 没有独立证据** —— 文档化设计，非证据。
8. **D2 的证据来源校验在"持有真证据对象并改写其 `audit`/`plan` 字段"面前仍可被说服** —— 见 R6 N1/N2（本轮新发现）。
9. **沙箱段套件（`registry-unstaged-wow64` / `file-cow-dispositions`）** 仍需未受限会话，本轮未跑。

## 附：本轮复核的命令与产物

`[实测]` 全部临时脚本现写现跑、**跑完已删**（含现场里的 junction 与 1 MiB 文件；`.t/v2-d1-root`、`.t/v2-reg-root`、`.t/v2-hook-root` 均已清理）：

| 脚本（已删） | 用途 | 保留的输出（证据） |
|---|---|---|
| `.t/v2-d1.mjs` | 自指/互指 junction、逃逸、guard 加严、旧逻辑模拟 | `.t/v2-d1.txt` |
| `.t/v2-d2.mjs` | 伪造证据、品牌击破、真例、teardown、N1/N2 | `.t/v2-d2.txt` |
| `.t/v2-reg.mjs` | R4 回归清扫 | `.t/v2-reg.txt` |
| `.t/v2-hook.mjs` | `--plant` 钩子是否真改行为 + D1 独立性 | `.t/v2-hook.txt` |

主关口与 plant 日志：`.t/v2-final-verify.txt`（exit 0 / ALL PASS / 1838）、
`.t/v2-plant-limits.txt`、`.t/v2-plant-netpolicy.txt`、`.t/v2-plant-residual.txt`、`.t/v2-plant-suitewiring.txt`。

# 第三轮复核（N1/N2 修复后）

- 复核者立场：**第三轮独立验证者**，未参与前两轮审计，也未参与 N1/N2 修复；不采信修复 agent 自报的任何数字。
- 冻结对象：`src/netpolicy.mjs`（SHA-256 `8C81C520…21EAB05`，2026/10/1 0:53:48）、`tests/netpolicy.mjs`（`8ED82ADE…6D71918`，0:53:19）。
- 本轮全部结论均由**本机新写的临时脚本**（`.t/v3-exp.mjs`，跑完已删）与独立复跑得出；输出证据 `.t/v3-final-verify.txt`、`.t/v3-np-normal.txt`、`.t/v3-np-plant.txt`、`.t/v3-exp-out.txt`、`.t/v3-iw.txt`、`.t/v3-rb.txt`。

## V1. 主关口与计数（独立复跑）

`[实测]` `verify.cmd` ⇒ exit **0**、`RESULT: ALL PASS`、**20/20** 套件、0 失败。断言总数**独立计数 = 1851**：日志里 20 个套件块共 **1824** 个 `✓`，加上 `tests/probe-selfkill-guard.mjs` 自报的 **27** 项（该套件不用 `✓` 标记），二者相加恰为 1851（6 个套件只打印"全部通过"、不打印断言行，因此"从日志求和"必须用标记计数，不能只求和打印出的数字）。
`[实测]` `node tests\netpolicy.mjs` ⇒ `RESULT: PASS checks=152 failures=0 mode=normal`（exit 0）；`--plant` ⇒ `RESULT: FAIL checks=153 failures=35 mode=plant`（exit 1）。三个数字与修复 agent 自报完全一致，但**独立复跑得到**。
`[实测]` `node tests\integration-wiring.mjs` ⇒ 144/0（exit 0）；`node tests\residual-baseline.mjs` ⇒ 43/0（exit 0）。

## V2. N1（无枚举入口 + 篡改 audit）—— 修复成立

`[实测]` 自建替身绑定表（无 `fwpmFilterGetByKey0`/`fwpmFilterEnum0`）真安装 6 条后 `audit.verified=false / reason=enumeration-unavailable`；此后各种攻击全部 fail-closed：
`inst.audit.verified=true`（带该 audit）⇒ `audit-mismatch`/`enforced:false`；换成全新 `{verified:true}` 对象 ⇒ 同上；手写 `audit` 参数 ⇒ 同上；`Object.defineProperty(inst,'audit',…)`、`delete inst.audit` ⇒ 判定仍只读安装时冻结快照（`enforced:true / verified:false`，与篡改前逐字相同）；抛错 getter 的 `Proxy` audit ⇒ `evidence-check-threw`/`enforced:false`，异常不外泄；`Object.getOwnPropertySymbols(inst)` 只暴露非枚举品牌（值为 `true`），把品牌抄到自造对象上 ⇒ `not-produced-by-installNetworkPolicy`；`inst.engine.handle=null` ⇒ `engine-missing`（只降级）；整体替换 `inst.engine` ⇒ 记录仍持自己的对象，判定不变。
**没有任何一条能让 `verified` 从 false 变 true。** 正例（有枚举入口）仍 `enforced:true/verified:true`。

## V3. N2（活计划篡改/冒名）—— 修复成立

`[实测]` 分别篡改 `filters` / `target` / `subLayerKey` / 三者齐改 / 整体换 `inst.plan`：按 `target:'app-identifier'` 解析**一律** `plan-mismatch`/`enforced:false`；按原 target 解析仍 `enforced:true/verified:true`（这是**正确**判定：请求侧重建的计划就是真装过的那份，与活对象无关）。`delete inst.plan` 后判定不变，证明记录里没有活计划、指纹是**请求侧重算**的。把返回值的 `installed[]`/`filterIds[]` 清空再 push ⇒ 计数不受影响（记录里是冻结副本）。

## V4. 回归清扫

`[实测]` 伪造 `{installed:[6]}`+伪造 audit ⇒ `not-branded`/`enforced:false` 且 `FwpmFilterAdd0` 增量为 0；展开拷贝件 ⇒ 拒绝；`'offline'/'Offline'/'OFFLINE '/42/{}/null` ⇒ 全部 `NETWORK_TIER_INVALID`；`api=null`/缺绑定 ⇒ `refused`/`enforced:false` 且零调用；`CONTROLLED_ONLINE`/`OBSERVED_ONLINE` ⇒ `not-implemented`/`enforced:false` 且零绑定表读取；默认档位（不传 `requested`）⇒ 零绑定表读取；第 3 条 `FwpmFilterAdd0` 失败 ⇒ 类型化错误、主机 0 过滤器/0 sublayer、逆序删 2 条、引擎关闭、`teardownFailures=[]`；`teardown()` ⇒ `evidence-torn-down` 且幂等。

## V5. Meta：`--plant` 非空洞、新断言有判定力

`[实测]` `--plant` 把 `resolvePolicy` 换成"OFFLINE 一律 `enforced:true`"的包装 ⇒ 35 条断言见红（含 N1 的 `2m` `audit-mismatch` 与 N2 的 `2o` 两条），即这套断言**不是恒绿**；失败原因都是不变量被违反的实义断言，不是崩溃。

## V6. 本轮遗留（新发现/残留，均非 N1/N2 未修复）

- **R3-1（低）指纹不含 `guids`/条件值 ⇒ 同一份真证据可给"另一个应用身份"的请求背书。** `[实测]` 用 GA（`ALE_PACKAGE_ID=aaaa…`、`targetValue=0x2000`）真安装后，再以 GB（`dddd…`、`0x9999`，层 GUID 也不同）解析同一证据，仍得 `enforced:true/verified:true`；而安装字节里记录的条件值确为 `aaaa…/0x2000`。`planFingerprint` 只覆盖 tier/target/subLayerKey + 每条规则的 6 个结构字段（`src/netpolicy.mjs:171-188`、`:254-257`、`:815`），`guids` 只影响 `applyOfflinePlan` 的字节构造，不进计划。**树内不可达**：`src/executor.mjs:2000-2025` 的安装与复判共用同一 `resolveInput.guids`。需持有真证据且跨两次调用换 `guids` 才成立，故定性为残留加固项而非 fail-open 通道。
- **R3-2（低，注释）记录仍持有一个活引用 `engine`。** `src/netpolicy.mjs:816`（`engine`）与 `:131-135`/`:804-808` 的"记录不存任何活引用"表述不符。`[实测]` 改写 `result.engine.close` 后 `teardown()` 报 `engineClosed:true`、`failures:[]`，而真实 `FwpmEngineClose0` 调用 0 次 —— 只影响**拆除报告的真实性**，不影响判定（`engineHandleOf` 只做空值检查，篡改只能降级）。该项自 D2 轮即存在。
- **R3-3（低，文档漂移）`README.md` §8.2 与关口不符。** `README.md:525` 仍写 `tests/netpolicy.mjs` = **139**、`:532` 仍写 `verify.cmd` 合计 **1838**；本轮关口实测 **152** / **1851**（差 +13，正是套件 139→152 的增量）。修复 agent 只被允许改两个文件，故未同步；需由文档所有者更新。

## V7. 诚实性

`[实测]` 逐条核对 `src/netpolicy.mjs` / `tests/netpolicy.mjs` 的证据标注：**修复后**的 `[实测]`（`src/netpolicy.mjs:122-126`、`:142-146`；`tests/netpolicy.mjs:687`、`:809` 的修复后一半）本机全部复现且与本轮观测逐字一致，**无 overclaim**。
**修复前**的 `[实测]`（`src/netpolicy.mjs:113-119`、`:136-141`、`:290`；`tests/netpolicy.mjs:683`、`:809` 前半）指向已删除脚本，冻结修订里已无修复前源码（`src/netpolicy.mjs` 未被 git 跟踪 ⇒ 无历史可回退），本轮**无法**独立复跑。可佐证：第二轮留存的独立日志 `.t/v2-d2.txt` 记录了修复前同一形态 `AUDIT-MUTATION … after={enforced:true,verified:true}` 与 `PLAN-switch-target-mutated-plan {enforced:true,verified:true}`（那一次复核对着**修复前**修订跑的）。因此这些标注不构成"把没跑过的说成跑过"，但其**具体时点**只能靠该留存日志背书。

## V8. 本机仍无法证明

1. **真实 WFP/BFE 安装与端到端阻断** `[未实测]`：本轮全程离线替身表，未安装任何真实过滤器、未改系统状态。
2. **修复前行为本身**：修复前源码与 `.t/n1n2-repro.mjs`、`.t/fix-d2-repro.mjs` 均已不存在，只能引用 `.t/v2-d2.txt` 的历史日志。
3. **修复 agent 只动了两个文件**：证据是时间戳（12 个"不得触碰"文件全部 ≤ 2026/10/1 0:30:02，两个受控文件为 0:53:19 / 0:53:48）+ 全量关口里**其余 19 个套件逐套件 `✓` 计数与第二轮完全相同**（`netpolicy` 唯一变化 139→152）；这是强力旁证，但无基线哈希，不构成密码学证明。

本轮临时脚本 `.t/v3-exp.mjs` 已删；保留的输出：`.t/v3-final-verify.txt`、`.t/v3-np-normal.txt`、`.t/v3-np-plant.txt`、`.t/v3-exp-out.txt`、`.t/v3-iw.txt`、`.t/v3-rb.txt`。

---

## 第四轮复核（R3-1/R3-2/R3-3 修复后，冻结版）

复核者：独立第四轮 verifier（未参与本项目任何代码编写）。修订冻结；修复 agent 本轮只动了 `src/netpolicy.mjs`、`tests/netpolicy.mjs`、`README.md`。全部结论均为本机本轮 `[实测]`（node v24.21.0；离线替身绑定表；`cmd /c` 重定向到 `.t/`，因本会话直接 pwsh 管道到 node 被禁）。

### 1. 关口（全量复跑，与修复 agent 各自独立跑过）

- `cmd /c "verify.cmd > .t\v4-final-verify.txt 2>&1"` ⇒ **exit 0**、`RESULT: ALL PASS`、**20/20** 套件块、**0** 个 `✗`。
- 独立计数：20 个套件块共 **1836** 个 `✓` + `tests/probe-selfkill-guard.mjs` 自报 **27** 个 `[OK  ]` = **1863**。
- 逐套件与修复 agent 的 `.t/r4-verify.txt`（282250 字节）**20/20 逐套件计数完全一致**；第三轮存留的 `.t/v3-final-verify.txt` = 1824+27 = **1851**（20 套件），本轮 +12 恰为 `netpolicy` 152→164。
- 单跑：`tests/netpolicy.mjs` **164/0**（exit 0）；`--plant` **165 断言 / 40 红**（exit 1，非空转）；`tests/integration-wiring.mjs` **144/0**；`tests/residual-baseline.mjs` **43/0**。

### 2. R3-1（计划指纹绑定 `guids`）：**确认修复**

自建独立替身绑定表（`.t/v4-probe.mjs`，含真实 `FwpmFilterGetByKey0` 回读），真安装 6 条过滤器后换 `guids` 复判：

| 变动 | 结果 |
|---|---|
| 条件 GUID `ALE_PACKAGE_ID`（appcontainer） | `not-enforced` / `enforced:false` / reason 含 `plan-mismatch` |
| 单条层 GUID | 同上 |
| 全部 6 条层 GUID | 同上 |
| `targetValue` 0x2000n→0x9999n | 同上 |
| 上述全部一起 | 同上 |
| 条件 GUID `ALE_APP_ID`（target=`app-identifier`） | 同上 |
| **正例（`guids` 完全相同）** | `enforced/true` / `verified:true`（6/6 回读通过） |
| `targetValue` `0x2000n` / `0x2000` / `8192n` / `8192` 四种表示 | 均 `enforced:true`（同值同串，无假阳性） |
| 畸形取值（`42` / `{}` / `Symbol` / 3 字节 Buffer / `null` / 抛错 Proxy） | 无原生 `TypeError` 逃逸；`plan-mismatch` 或 `refused`，一律 `enforced:false` |

- **INFO（非缺陷，口径说明）**：指纹只覆盖**该计划真正消费的** `guids`。target=`appcontainer` 时单独换 `ALE_APP_ID`（或 target=`app-identifier` 时单独换 `ALE_PACKAGE_ID`）仍得 `enforced:true` —— 因为请求侧重算出的安装计划与字节完全一致，该键在本目标下从不写入 BFE，不存在 fail-open 方向。`src/netpolicy.mjs:196-197` 的表述（"该计划真正会写进 BFE 的取值"）与实际行为一致，无需修改。

### 3. R3-2（拆除用安装时定住的 `engineCloser`）：**确认修复**

真安装后，同时①改写 `inst.engine.close` 为假函数、②把 `inst.engine.handle` 置 `null`、③整体替换 `inst.engine`，再调 `teardown()`：

- 真实 `FwpmEngineClose0` 计数 **+1**，且传入句柄 === 安装时那个句柄；假 `close` **0 次调用**。
- `removed=6`（逆安装序）、`engineClosed:true`、`failures:[]`、`skipped:false`。
- 关闭**真失败**时仍如实上报（`0x80320009` ⇒ `engineClosed:false`、`failures` 点名该状态码；抛错 ⇒ 点名 throw 消息）—— 不因调用方改写而粉饰。
- 未触碰语义回归：`teardown()` 幂等（第二次 `skipped:true`、真实关闭不增）；拆除后同一证据 ⇒ `evidence-torn-down` / `enforced:false`；换 `api` 对象 ⇒ `api-mismatch` / `enforced:false`；安装后把 `engine.handle` 置 `null` ⇒ `engine-missing` / `enforced:false`。

### 4. 回归清扫（短）

伪造证据（`{...install}` 展开 / `Object.assign` / 手写 audit）全部 `not-branded` 拒绝且 `FwpmFilterAdd0` 增量为 **0**；畸形档位 `'offline'` / `'OFFLINE '` / `42` / `{}` / `null` 全部抛 `NETWORK_TIER_INVALID`；任何 `refused` / `not-implemented` 均 `enforced:false`（含无 api、无 pin、`guids:null`、两个在线档位）；中途失败（第 3 条 `FwpmFilterAdd0` 失败）⇒ 0 过滤器 / 0 子层、删除为逆序、引擎恰关闭 1 次、`teardownFailures:[]`；默认档位（`OBSERVED_ONLINE`）对绑定表 **0 次读取**。独立探针共 **49 项断言全绿**（3 条 INFO 记录）。

### 5. R3-3（README 计数）：**确认修复**

`README.md` §8.2 表 20 行逐行与**本轮我自跑的**关口日志一致：`netpolicy` **164**、`verify.cmd` 合计 **1863**（20 套件）；其余 19 行无一漂移（含 `probe-selfkill-guard` 27 的 ASCII 标记口径，`README.md:525` 与 `src/testrunner.mjs:45-52` 一致）。`README.md:503` 引用的 `.t/r4-verify.txt` 确实存在（282250 字节，1:13:19），内容与本轮独立复跑逐套件一致。旧口径 139/1838 已被显式标注作废。

### 6. 只改三个文件（时间戳证据）

`src/netpolicy.mjs` = 1:11:59、`tests/netpolicy.mjs` = 1:12:31、`README.md` = 1:14:22；全部对照文件更早：`src/limits.mjs` 0:22:33、`src/capability.mjs` 0:22:20、`tests/residual-baseline.mjs` 0:22:00、`tests/limits.mjs` 0:18:46，其余（`src/executor.mjs`、`src/store.mjs`、`src/appcontainer-runtime.mjs`、`src/testrunner.mjs`、`verify.cmd`、`tests/suite-wiring.mjs`、`tests/integration-wiring.mjs`、`tests/mitigations.mjs`）均 ≤ 2026/9/30 23:49。旁证：除 `netpolicy`（152→164）外其余 19 个套件断言数与第三轮逐一相同。`src/netpolicy.mjs` / `tests/netpolicy.mjs` 未被 git 跟踪（`?? `），无基线哈希，故为强力旁证而非密码学证明。

### 7. 诚实性

三个受控文件中的"修复后"`[实测]`（`src/netpolicy.mjs:200-202`、`:766-768`；`README.md:498-509`）本轮**独立复现且逐字一致**，无 overclaim。README 仍明确写"真实 BFE 安装与端到端阻断 `[未实测]`"（`README.md:385`）。"修复前"的 `[实测]`（如 `src/netpolicy.mjs:336-337` 的 `guids:null` 原生 TypeError）指向已不存在的修复前源码，冻结修订下**无法**独立复跑，但也不构成把没跑过的说成跑过。

### 8. 本机仍无法证明

1. **真实 WFP/BFE 安装与端到端阻断**：全程离线替身表，未安装任何真实过滤器、未改系统状态；真实 Windows SDK 的 GUID 真值/`FWP_ACTION_*` 位值仍无本机来源。
2. **修复前行为本身**：修复前源码与相关临时脚本均已不存在。
3. **"只改三个文件"的密码学证明**：`netpolicy` 两文件未入 git，只有时间戳 + 其余 19 套件计数不变的旁证。

### 9. 本轮新增缺陷

**无。** 唯一新增记录是 §2 的 INFO 口径说明（未被消费的 `guids` 键不参与指纹），不是缺陷。

本轮临时脚本 `.t/v4-probe.mjs` 已删；保留的输出：`.t/v4-final-verify.txt`、`.t/v4-np-normal.txt`、`.t/v4-np-plant.txt`、`.t/v4-iw.txt`、`.t/v4-rb.txt`、`.t/v4-probe-out.txt`。
