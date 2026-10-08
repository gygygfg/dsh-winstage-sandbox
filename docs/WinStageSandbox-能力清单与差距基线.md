# WinStageSandbox 能力清单与差距基线

> 本文件是**只读分析**产物：不修改任何源码。所有结论都给出 `文件:行` 证据。
> 证据分层沿用手册第 0 章：`[实测]`（本仓库存档的原始输出）> `[官方]` > `[推断]`；
> 本次分析本身未运行任何探针，凡源码未写明实测结果的，一律记为 **UNVERIFIED**。

---

## 0. 方法与两条必读前提

1. **本清单以 `src/`、`shim/`、`dsh-plugin/` 的当前代码为准，不以 README 为准。**
   README 的 §8 明显早于当前代码，至少有三处已过时：
   - README 称 "T0 未接线到执行器"；`src/executor.mjs:1574-1606` 已实现 T0 装配，且
     `src/capability.mjs:1286` 的闸门（`appContainerIsolation.proven === true`）仍在 —— 属
     **"已接线但默认不选 T0"**，不是 "未接线"。
   - README §5.1 称注册表"本轮未新增策略"；`src/registry-stage.mjs` + `shim/src/ws_reg*.c`
     已实现 **WAL-first 的注册表写入覆盖层暂存**（HARD_DENY / STAGED / UNSTAGED 三态）。
   - README 称执行器 T1 是默认；`dsh-plugin/shell-executor.mjs:564` 的插件默认档位已是
     **`'auto'`**（探测通过则走 `TS` 去令牌化 shim）。
2. **"enforced" 分三级**，本清单严格区分：
   - **REAL**：由内核/OS 对象（令牌、ACL、完整性标签、Job、AppContainer 包 SID）强制，
     进程内代码无法自行解除。
   - **ADVISORY/USER-MODE**：由用户态代码（进程内投影、IAT 钩子）判定；可被绕过，
     但**是本项目刻意的 fail-closed 设计**（钩子无法暂存时返回 `ERROR_ACCESS_DENIED`）。
   - **ABSENT**：没有实现。

---

## 1. 模块地图

| 模块 | 用途 | Windows 机制 | 强制性质 |
|---|---|---|---|
| `src/executor.mjs`（3104 行） | 受信启动器：装配令牌/AppContainer/shim + Job + 显式环境块 + 结果收集 | `CreateRestrictedToken`(经依赖包) / `Low IL` / AppContainer `STARTUPINFOEXW`+`SECURITY_CAPABILITIES` / Job Object / 显式 `lpEnvironment`+`CREATE_UNICODE_ENVIRONMENT` / shim 注入 | T0/T1 **REAL**；TS **USER-MODE** |
| `src/appcontainer.mjs`（324 行） | AppContainer 结构体布局与创建标志（纯常量 + 合成缓冲区可测） | `STARTUPINFOEXW`(112B)、`EXTENDED_STARTUPINFO_PRESENT`、`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`、`SECURITY_CAPABILITIES.cbSize=24` | 布局层（不执行） |
| `src/appcontainer-runtime.mjs`（1340 行） | AppContainer 运行期：能力 SID 派生、属性列表两阶段协商、profile 生命周期、令牌事实读取与隔离判定 | `DeriveCapabilitySidsFromName`、`InitializeProcThreadAttributeList`、`CreateAppContainerProfile`、`GetTokenInformation(TokenIsAppContainer=29 / TokenAppContainerSid=31 / TokenIntegrityLevel=25)` | **REAL**（T0 生效时） |
| `src/wfp.mjs`（1202 行） | WFP 过滤器**结构与参数构造层 + 调用层** | `FwpmEngineOpen0/Close0`、`FwpmSubLayerAdd0`、`FwpmFilterAdd0`、`FwpmFilterDeleteById0` | **调用层可用；过滤器从未安装**（`src/wfp.mjs:28-30`） |
| `src/registry-guard.mjs`（1219 行） | 注册表**检测**：快照 / 差异 / 回滚计划 / ACL 限制**计划**（不自动执行） | `RegOpenKeyExW/RegQueryValueExW/RegEnumKeyExW`（经可注入 reader）+ `RegSetKeySecurity` 计划 | **ADVISORY**（`src/registry-guard.mjs:14-21` 明确"不阻止写入"） |
| `src/registry-stage.mjs`（2901 行） | 注册表**写入暂存**：私有 app hive 覆盖区 + WAL 日志 + 候选 + 选择性应用 | `RegLoadAppKeyW`(app hive) + shim 侧 8 个 `Reg*` 钩子 | **USER-MODE**（`src/registry-stage.mjs:20-27` 明确"逻辑重定向，不是内核边界"） |
| `src/store.mjs`（460 行） | 内容寻址 blob、暂存清单、候选队列、GC、清理前权限修复 | COW 副本 + `renameSync` 原子替换 + `.dshstage` 树 | **ADVISORY** |
| `src/workspace.mjs`（1509 行） | 统一工作区服务：基线/暂存/删除/损坏状态、目录合成、候选冻结、选择性应用、重解析点守卫 | 用户态投影 + `realpathSync.native` + `dirent.isSymbolicLink()` | **ADVISORY** |
| `src/paths.mjs`（692 行） | 路径规范化、词法/canonical 双边界、敏感路径硬拒绝表、shim mask 投影 | `realpathSync.native`、长路径前缀、8.3 短名归一 | **ADVISORY**（`hard:true` 仅表示"进程内不可协商"） |
| `src/tools.mjs`（307 行） | 进程内工具面：结构化返回、路径还原、所有路径参数硬校验 | 用户态 | **ADVISORY** |
| `src/audit.mjs`（1052 行） | 沙箱内攻击探针与证据报告（读/写/删/环境/生命周期） | 经执行器进沙箱跑 PowerShell 探针 | **取证**（不是边界） |
| `src/capability.mjs`（1350 行） | 真实路径能力探测、环境指纹缓存、档位选择、T0 隔离证据链 | 真实 Win32 调用（koffi）+ 原子缓存 | 判定层 |
| `src/spawn-window.mjs`（112 行） | 子进程控制台/模态错误框策略 | `SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOOPENFILEERRORBOX)` | 健壮性 |
| `src/cli.mjs`（364 行） | CLI：init/status/probe/exec/review/diff/apply/discard/gc/audit | 汇集上述各层 | 入口 |
| `src/testrunner.mjs`（315 行） | 套件清单 + 判定 + `guaranteesNotProvided` 生成 | fd 重定向（绕开命名管道） | 测试基础设施 |
| `shim/src/*.c`（约 30 万字节 C） | **TS 档透明 shim DLL**：文件与注册表写入的 IAT 钩子 + 读遮蔽 | 远程 `LoadLibraryW` 注入 + IAT 补丁（`ws_hook.c:84-92` 列 36 个 API） | **USER-MODE，fail-closed** |
| `dsh-plugin/host-plugin.mjs`（616 行） | `/winstage list|diff|approve|reject|rebase|refresh` 人工批准入口 | DSH Remote 命令 + `review.json` | 审批（**ADVISORY**，人类在环） |
| `dsh-plugin/review-service.mjs`（1032 行） | 审阅快照、敏感内容省略、approve/reject 编排、审计镜像 | `review.json` + `approval/asked|decided` | 审批 |
| `dsh-plugin/staging-fs.mjs`（736 行） | 让 DSH 自身 `write`/`edit` 也落暂存树 | 用户态 fs 投影 | **ADVISORY** |
| `dsh-plugin/shell-executor.mjs`（1083 行） | 让 DSH shell 工具进沙箱（默认 `tier='auto'`） | 复用 `src/executor.mjs` | 入口 |

---

## 2. 能力矩阵

> `enforced?` 取值：**REAL**（内核强制）/ **USER-MODE**（用户态强制且 fail-closed）/ **ADVISORY**（仅进程内校验或仅记录）/ **ABSENT**。

| capability | mechanism | isolated resource | enforced? | evidence (file:line) | test coverage (test file name) |
|---|---|---|---|---|---|
| 文件系统写隔离（T1） | WRITE_RESTRICTED 受限令牌（限制 SID 交集）+ ACL deny + Low 完整性标签 | 除暂存根外的整机可写面 | **REAL** | `src/executor.mjs:26-29,1352-1354`；`src/executor.mjs:1268` | `tests/executor-stub.mjs`、`tests/diag-bindings.mjs`、`tests/acceptance-transparent.mjs` |
| 文件系统写隔离（TS 去令牌化） | shim IAT 钩子把写入重定向进暂存树；无法暂存即 `ERROR_ACCESS_DENIED` | 真实工作区 + 区外路径 | **USER-MODE**（fail-closed） | `shim/include/winstage_shim.h:23-27`；`shim/src/ws_hook.c:84-87`；`src/executor.mjs:2285-2296` | `tests/file-cow-dispositions.mjs`（c1–c8 逐字节）、`tools/run-shim-closedloop.mjs`、`tests/acceptance-transparent.mjs` |
| 文件系统写隔离（T0） | AppContainer 包 SID 默认拒绝区外写 | 整机（除显式 ACL 授予） | **REAL** | `src/appcontainer-runtime.mjs:54-58`；`src/executor.mjs:1574-1606` | `tests/appcontainer-runtime.mjs`（140 项，`--plant` 6 红）、`tests/appcontainer-layout.mjs`（34 项） |
| 文件系统读隔离 / 白名单 | TS shim 的 `readDeny`/`readAllow` 正则在 `CreateFileW` 上判定；无法判定即 deny | 敏感路径（`paths.mjs::MASK_CLASSES`） | **USER-MODE**（fail-closed） | `shim/src/ws_file.c:199-204,631-632`；`shim/src/ws_mask.c:900-921`；`src/paths.mjs:192-379` | `tests/paths-masks.mjs`（37 项）、`tools/mask-regression.mjs`、`tools/mask-e2e.mjs` |
| 文件系统读隔离（T1 受限令牌） | 无 | — | **ABSENT** | `src/executor.mjs:26-29` 明示"本执行器**不限制读取**"；`src/executor.mjs:1705` | `tests/audit-parse.mjs`（残余 R1 记录） |
| 文件系统读隔离（T0） | AppContainer 默认拒绝区外读 | 整机读面 | **REAL**（仅 `tier=T0`） | `src/appcontainer-runtime.mjs:54-58`；`src/capability.mjs:1286-1313` | `tests/appcontainer-runtime.mjs` |
| 符号链接 / junction / 重解析点逃逸防护 | 先 `canonical()`（`realpathSync.native`）再判边界；`dirent.isSymbolicLink()` 识别 junction；词法边界与 canonical 边界分离 | 工作区边界 | **ADVISORY** | `src/paths.mjs:25-67,96`；`src/workspace.mjs:54-88,868-896` | `tests/workspace-regressions.mjs`（`--probe-reparse`）、`tests/paths-masks.mjs`、`tests/selftest.mjs` |
| 暂存写时复制（CoW） | 内容寻址 blob 三层（base/staged/candidate）+ `staged/<rel>` 物化 + `staged-ext/` 区外对象 | 工作区文件内容 | **ADVISORY** | `src/store.mjs:11-33,218-251`；`src/workspace.mjs:719-780` | `tests/file-cow-dispositions.mjs`（c1/c1p/c2/c3/c4/c4b/c4d/c5/c5c/c5t/c6cmd/c6ps）、`tests/e2e-flow.mjs` |
| 选择性逐路径提交（apply/reject/diff/review） | 候选冻结 before+after；`applyCandidate` 子集落盘 + `remaining` 保留；`superseded_by` 链重定向；`STALE_BASELINE` 拒绝 | 真实工作区 | **ADVISORY** | `src/workspace.mjs:1047-1066,1096-1262`；`src/store.mjs:409-448` | `tests/selftest.mjs`（选择性应用 4 项、丢弃 3 项）、`tests/e2e-flow.mjs`、`tests/workspace-regressions.mjs` |
| 网络出站限制（WFP） | `FwpmEngineOpen0` 可开、`FwpmFilterAdd0` 调用层齐备，但**从未安装任何过滤器** | 出站网络 | **ABSENT**（`src/wfp.mjs:28-30`："一个 `Fwpm*Add0` 都没调用过"） | `src/wfp.mjs:906-946,1006-1057,1076-1150`；无生产调用方（`grep` 全 `src/` 仅 `wfp.mjs` 自身） | `tests/wfp-layout.mjs`（**仅布局**，745 行） |
| 网络出站限制（AppContainer） | 不声明 `internetClient` 即默认阻断；声明后立即连通 | 出站网络 | **REAL**（仅 `tier=T0`） | `src/appcontainer-runtime.mjs:54-58`；`src/appcontainer.mjs:36-41` | `tests/appcontainer-runtime.mjs` |
| 网络出站限制（默认档位） | 无 | — | **ABSENT** | `src/testrunner.mjs:245-246`；README §8.3 "R2 网络面未收敛" | 无 |
| 回环 / localhost 策略 | 无任何代码 | — | **ABSENT** | `grep` 全 `src/`、`shim/src` 无命中 | 无 |
| DNS 策略 | 无托管 DNS；仅 AppContainer 缺 `internetClient` 时整体不通 | — | **ABSENT**（无独立 DNS 控制） | 同上 | 无 |
| 注册表写入暂存 / 虚拟化 | `RegLoadAppKeyW` 私有 app hive 覆盖层 + WAL（`overlay.journal`）+ 候选进同一审批队列；真实 hive 在 `apply()` 前不变 | 真实 hive | **USER-MODE**（仅被 hook 的 8 个 `Reg*` API） | `src/registry-stage.mjs:12-27,2163,2272,2459`；`shim/src/ws_hook.c:88-92`；`shim/src/ws_reg.c:307,425-442` | `tests/registry-stage.mjs`、`tests/registry-conformance.mjs`、`tests/registry-apply-e2e.mjs`、`.t/reg-staged-key-reopen.mjs` |
| 注册表暂存绕道（HARD_DENY 清单） | 覆盖层无法复现的调用 → 硬拒并记 HARD_DENY；`NtSetValueKey`/直接写 hive/未注入 `reg.exe` **照样命中真实 hive** | — | **PARTIAL**（明示残余） | `src/registry-stage.mjs:20-27,647-665`；`shim/src/ws_reg.c:307,320-322,442,487,745` | `tests/registry-guard.mjs`（378 断言，F8 含 12 条新断言） |
| 注册表 WOW64 视图 | `KEY_WOW64_64KEY` 在 64 位进程是 no-op（正常暂存）；`KEY_WOW64_32KEY` 不可暂存 → **透传真实 API + UNSTAGED 审计** | 32/64 位视图 | **PARTIAL**（32KEY 不隔离，如实声明） | `src/registry-stage.mjs:203-206,306-347`；`shim/src/ws_reg.c:163-197` | `tests/registry-unstaged-wow64.mjs`（36 项） |
| 注册表读暂存 / 虚拟化 | 覆盖层提供 `RegOpenKeyExW`/`RegQueryValueExW` 钩子，值可读回自己写的 | 读面 | **USER-MODE**（仅读取视图，不是读隔离） | `shim/src/ws_hook.c:89-90`；`src/registry-stage.mjs:13-18`（"能读回自己写的值"） | `tests/registry-stage.mjs`、`tests/registry-apply-e2e.mjs` |
| 注册表 ACL 限制 | 只产出 `planAclRestriction()` **计划**，**绝不自动执行** | — | **ABSENT**（有计划的，无执行） | `src/registry-guard.mjs:14-17,981-…` | `tests/registry-guard.mjs` |
| 进程 / 令牌限制（T1） | 受限令牌 + Low IL + deny `FILE_DELETE_CHILD`（由 `@deepseek-ai/dsh-sandbox-windows-acl` 施加） | 进程身份 | **REAL** | `src/executor.mjs:19-22,1268`；README §5.1 | `tests/diag-bindings.mjs`、`tests/audit-parse.mjs` |
| 子进程继承：句柄 | T1：库内 `inheritHandles` 参数 + 显式 `lpEnvironment`；T0：`inheritHandles` 默认 **false**，为 true 时必须配 `CREATE_NEW_CONSOLE` 否则 fail-closed | 继承句柄集 | **PARTIAL**（无显式 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` 白名单） | `src/executor.mjs:363-367,521,673,996-1023`；`src/appcontainer-runtime.mjs:60-66` | `tests/executor-stub.mjs`（0x400、fail-closed）、`tests/appcontainer-runtime.mjs` |
| 子进程继承：进程树 | Job Object `KILL_ON_JOB_CLOSE`，超时 `TerminateJobObject` 整树回收 | 子进程树 | **REAL** | `src/executor.mjs:302,1059`；`src/executor.mjs:2892`（shim 侧用 `taskkill /T /F`，非 Job） | `tests/executor-stub.mjs`（Job 配额/自检只读性）、`tests/probe-selfkill-guard.mjs` |
| Job Object 限制 | `KILL_ON_JOB_CLOSE`（恒开）；`ACTIVE_PROCESS`/`PROCESS_MEMORY`/`JOB_MEMORY`/`PROCESS_TIME` **仅在显式传参时**设置 | 资源上限 | **PARTIAL**（默认只开 KILL_ON_JOB_CLOSE） | `src/executor.mjs:300-321,936-943` | `tests/executor-stub.mjs`（84 项） |
| CPU / 内存限制 | 支持 `perProcessTimeLimitMs`、`processMemoryLimit`、`jobMemoryLimit`，**默认全部不设** | — | **PARTIAL**（能力在，默认关） | `src/executor.mjs:308-319,939-943` | `tests/struct-layout.mjs`（24 项，布局/偏移/越界） |
| AppContainer / 沙箱 profile | `CreateAppContainerProfile` + 五项判据（`TokenIsAppContainer=29`/`TokenAppContainerSid=31`/`TokenIntegrityLevel=25` + 行为面）缺一即 false；用完即删 profile | 凭据/设备/文件/网络/进程/窗口 | **REAL**（仅显式 `tier=T0`） | `src/appcontainer-runtime.mjs:8-10,45-69`；`src/capability.mjs:1273-1313` | `tests/appcontainer-runtime.mjs`、`tests/appcontainer-layout.mjs` |
| 能力 SID（capability SIDs） | `DeriveCapabilitySidsFromName` + `SID_AND_ATTRIBUTES[]`；`internetClient`(S-1-15-3-1) 显式声明才通网 | 网络等能力 | **REAL**（`caps=0` 时 `curl` exit 7；`caps=1` 时 exit 0，`[实测]`） | `src/appcontainer-runtime.mjs:8,54-58` | `tests/appcontainer-runtime.mjs` |
| 环境变量清洗 | **从允许清单重建**（绝不 merge 父环境）+ 敏感名 denylist + 不注入 `DSH_SANDBOX*` 痕迹 | 秘密/代理/Node 注入 | **REAL**（子进程环境由父显式构造） | `src/executor.mjs:171-226`；`shim/include/winstage_shim.h:70-80`（shim 自己的契约变量） | `tests/executor-stub.mjs`、`tests/audit-parse.mjs`、`src/audit.mjs:637-638`（`secret-env-blocked`/`proxy-env-blocked`） |
| 敏感文件秘密脱敏 | `review.json` 对 danger 级条目**省略内容**；探针只回报 `len`+`head4` 的 SHA-256（**无正文**） | 审批面/证据面 | **ADVISORY**（不是读边界） | `dsh-plugin/review-service.mjs:45-49,793-800`；`src/audit.mjs:94-110` | `tests/audit-parse.mjs`（43 项，"秘密红线"） |
| 沙箱内动作审计 / telemetry | `audit.mjs` 结构化 JSON（哨兵 `DSH-AUDIT-JSON:`）+ 五态读取判定 + shim `shim.log`/`stats` + `approval/asked|decided` 镜像 | 证据面 | **ADVISORY**（取证，非阻断） | `src/audit.mjs:44,102-110,111`；`src/executor.mjs:2859`；`dsh-plugin/audit-mirror.mjs:6-7,95-124` | `tests/audit-parse.mjs`、`tests/dsh2-3-audit-mirror.mjs` |
| 攻击探针（沙箱内真实攻击面） | 写/删越界探针、10→N 条敏感读探针（只读）、环境秘密探针、生命周期探针 | 宿主对象 | **ADVISORY**（取证；空输出一律判 fail） | `src/audit.mjs:394-395,637-638,669-675,841`；README §4 第 12 轮验收表 | `src/cli.mjs audit`、`tests/acceptance-transparent.mjs`、`tests/dsh2-2a-outside-isolation.mjs` |
| 审批工作流 / 人在环 | `review.json` + `/winstage list|diff|approve|reject|rebase|refresh` + 悬浮窗；敏感命中要 `--confirm-mask` 二次确认 | 真实工作区发布 | **ADVISORY**（人类门禁，不是隔离） | `dsh-plugin/host-plugin.mjs:262-317,336-363,371-387`；`dsh-plugin/review-service.mjs:923-975,1062-1120` | `.t/review-selftest.mjs`、`.t/staging-fs-selftest.mjs`、`.t/command-selftest.mjs`、`.t/approve-button-selftest.mjs`、`.t/sensitive-confirm-selftest.mjs` |
| 并发（暂存存储多进程竞态） | 单文件原子写（`tmp-<pid>-<uuid>` + `renameSync`）+ `ownerToken`；**无跨进程锁** | 暂存树 | **PARTIAL**（文件级原子，非事务） | `src/store.mjs:107-116,197,242-245`；`src/workspace.mjs:1252` | `tests/workspace-regressions.mjs`、`tests/selftest.mjs` |
| 会话隔离 | 每会话 `sessionId` + `ownerToken`；候选取代限定在同一 `sessionId` | 暂存/候选 | **ADVISORY** | `src/store.mjs:197,279-294`；`src/workspace.mjs:235-244,1015` | `.t/session-isolation-selftest.mjs`、`.t/foreign-workspace-selftest.mjs` |
| 崩溃 / 重启恢复 | 清单常驻 `.dshstage/manifest.json`；启动恢复投影；`verifyProjection()` 把"记录在而 blob 缺失"判为 `WORKSPACE_CORRUPT`（绝不回退真实磁盘） | 暂存状态 | **ADVISORY** | `src/workspace.mjs:247,265,445-470,518-525`；`src/store.mjs:264-302` | `tests/selftest.mjs`（「暂存 blob 丢失时明确报损坏」）、`tests/e2e-flow.mjs` |
| 超时 | `timeoutMs`（默认 120000）+ `timeoutPromise` 返回退出码 124 + 整树终止 | 执行时长 | **REAL**（父进程强制终止） | `src/executor.mjs:1904,1951-1955,2165-2175` | `tests/executor-stub.mjs`（超时回收） |
| 输出大小限制 | 无上限；`drainPipeAvailable` 按 64 KiB 分块但不设总配额 | — | **ABSENT** | `src/executor.mjs:760-776`（无 `maxBytes`）；全 `src/` 无 `maxOutput` | 无 |
| stdio 处理 | T1/T0：匿名管道 + `drainPipe`/`PeekNamedPipe` 非阻塞排水；**T0 下 stdout/stderr 合并为单管道**；测试运行器改用 fd 重定向绕开命名管道 | I/O 通道 | **REAL**（可用性层面） | `src/executor.mjs:545-627,666-697,1831-1870`；`src/testrunner.mjs:9-13` | `tests/executor-stub.mjs`（D11 红/绿双档）、`tests/audit-parse.mjs` |
| 删除处理 | `STATE.DELETED` 持久逻辑状态；候选用 `hashAbsent()` 墓碑；shim 用 `<stage>\wo` 白障（whiteout） | 删除语义 | **USER-MODE**（捕获完整；T1 下由 ACL/令牌拒绝） | `src/store.mjs:57-60`；`src/workspace.mjs:823-846,1194`；`tests/file-cow-dispositions.mjs:37-38`（c7） | `tests/file-cow-dispositions.mjs`、`tests/selftest.mjs`（删除权威性 6 项） |
| 文件重命名 | `Workspace.rename()` 支持（含目录、类型替换与父目录合成） | 重命名语义 | **ADVISORY** | `src/workspace.mjs:868-896`；`shim/src/ws_hook.c:85`（`MoveFileExW/MoveFileW` 钩子） | `tests/selftest.mjs`、`tests/file-cow-dispositions.mjs` |
| 硬链接 | 无任何处理（无 `CreateHardLink`、无 hardlink 记账） | — | **ABSENT** | `grep` 全 `src/`、`shim/src` 无命中 | 无 |
| 备用数据流（ADS） | 无任何处理（`::$DATA` / 流名未归一化、未记账） | — | **ABSENT** | `grep` 全 `src/`、`shim/src` 无命中 | 无 |
| 8.3 短名 | `canonical()` 归一化短名；探针表含 `C:\Users\ADMINI~1\NTUSER.DAT` 防绕过用例 | 路径边界 | **ADVISORY** | `src/paths.mjs:14,96,500-502,608-625`；`src/workspace.mjs:79-88` | `tests/paths-masks.mjs`、`tests/workspace-regressions.mjs` |
| IPC / 命名管道 | 仅作为 stdio 传输通道使用；受限令牌下命名管道会 EPERM（已被 fd 重定向规避）；**无命名管道隔离策略** | — | **ABSENT**（隔离面） | `src/testrunner.mjs:9-13`；`src/audit.mjs:75-79`（`pipe-absent` 探针） | `tests/diag-bindings.mjs`（R10 边界） |
| 窗口 / 消息队列隔离 | 无自有代码；**仅在 T0 生效时**由 AppContainer 提供 OS 级窗口/消息隔离 | — | **ABSENT**（本项目未实现）；T0 下 **REAL** | `grep` 全 `src/`、`shim/src` 无 `WindowStation`/`CreateDesktop`/`GetMessage`；`src/appcontainer.mjs:36-41` | 无 |
| 剪贴板 | 无任何代码 | — | **ABSENT** | `grep` 全 `src/`、`shim/src` 无命中 | 无 |
| 屏幕捕获 | 无任何代码 | — | **ABSENT** | `grep` 全 `src/`、`shim/src` 无命中 | 无 |
| GPU / 设备访问 | 无任何代码；T0 下由 AppContainer 设备默认拒绝间接覆盖 | — | **ABSENT**（本项目无实现） | `grep` 全 `src/`、`shim/src` 无 `DeviceIoControl`/GPU 命中 | 无 |
| WMI | 无阻断；仅探测（`capability-probe` 的 CIM/firewall canary） | — | **ABSENT** | `src/executor.mjs:2544,2575,2620`；`tools/wmi-integrity-isolation.mjs`（诊断工具） | 无（`docs/T6:16` 记录 Low IL 下防火墙 WMI 被拒，属副作用） |
| COM | 无任何代码 | — | **ABSENT** | `grep` 全 `src/`、`shim/src` 无 `CoCreateInstance` | 无 |
| 服务（SCM） | 无任何代码 | — | **ABSENT** | `grep` 全 `src/`、`shim/src` 无 `CreateService` 命中 | 无 |
| 计划任务 | 无任何代码 | — | **ABSENT** | `grep` 全 `src/`、`shim/src` 无 `schtasks` 命中 | 无 |
| 提权防御（UAC bypass / 令牌复制 / 句柄继承） | 未做显式提权防御：无 `AdjustTokenPrivileges`、无 `DuplicateToken` 检测、无 `HANDLE_LIST` 白名单；依赖受限令牌 + Job + （TS）shim | 令牌/句柄 | **PARTIAL**（靠基础原语，无针对性防护） | `grep` `src/executor.mjs` 无命中；`src/executor.mjs:363-367,673,996-1023` | `tests/executor-stub.mjs`（句柄/环境契约）、`tests/probe-selfkill-guard.mjs` |
| 逃逸 / 负向测试 | 沙箱内真实攻击探针；越界暂存不变式 + **变异体证明**；shim closedloop；`--plant` 变异 | — | **PRESENT**（测试能力） | `tests/dsh2-2a-outside-isolation.mjs:9-23`（M1/M2/M3）；`docs/T7:14`（closedloop 30/30） | `tests/dsh2-2a-outside-isolation.mjs`、`tests/file-cow-dispositions.mjs`、`tests/acceptance-transparent.mjs`（`WINSTAGE_ACCEPT_CARRIER=inject` 8/1）、`tools/run-shim-closedloop.mjs` |
| 元测试（证明测试套件能失败） | 人为失败子进程反证运行器判定；`--plant` 变异体各自见红 | — | **PRESENT** | `tests/meta-runner.mjs`；`tests/_planted-failure.mjs`；`src/testrunner.mjs:39-40` | `tests/meta-runner.mjs`（4 项）、`tests/appcontainer-runtime.mjs --plant`（6 红）、`tools/mask-regression.mjs` |
| 磁盘配额（暂存树） | 无任何配额实现 | — | **ABSENT** | `grep` 全 `src/` 无 `quota`/`diskUsage`；Job 内存限制与磁盘无关 | 无 |
| 暂存树清理 / GC | `collectGarbage({apply})` 按引用集回收 blob；`makeRemovable()` 清理前修权限且不跟随链接；`ownerToken` 归属 | 暂存树 | **ADVISORY** | `src/store.mjs:139-183,409-448`；`src/cli.mjs:343-344` | `tests/selftest.mjs`（GC 2 项）、`tools/prune-orphan-sessions.mjs` |
| 暂存键重开 / 逐载体注入 | shim 钩子对"暂存空键"可重开；验收台支持 `WINSTAGE_ACCEPT_CARRIER=inject` 逐载体注入 | 载体进程 | **USER-MODE** | `docs/T7:14-18,25-60`；`shim/src/ws_reg.c` | `.t/reg-staged-key-reopen.mjs`、`tests/acceptance-transparent.mjs` |

---

## 3. 档位与接线现状（决定上表哪一格真的生效）

| 档位 | 机制 | 现状 | 默认？ |
|---|---|---|---|
| **T0** `appcontainer` | AppContainer 包 SID + Job + Low IL + ACL | **已接线**（`src/executor.mjs:1574-1606`），可被能力探测的 `proven=true` 证明；`selectTier()` 闸门未放宽 | 否 |
| **T1** `restricted-token` | WRITE_RESTRICTED + Low IL + ACL + Job | **已实现并实测**；库默认档位 | `WindowsStageExecutor` 默认 `'T1'`（`src/executor.mjs:1255`） |
| **TS** `shim`（去令牌化） | 普通令牌 + 正常完整性 + **用户态 IAT 钩子**强制/暂存 | **已实现**：真实 DLL（`shim/out/winstage-shim.dll` 228352 B）、注入器、探测金丝雀；探测不过则 fail-closed 回退 T1 | **插件默认 `'auto'`**（`dsh-plugin/shell-executor.mjs:564`） |
| **T2** `acl-only` | 仅 ACL 写边界 | 降级路径 | 否 |
| **T3** `none` | — | 拒绝执行（fail-closed） | 否 |

---

## 4. 已知差距 / 未提供的保证

### 4.1 README §8.3「第二轮仍未提供的保证」（原文要点）

- **T0 未接线到执行器**：`proven=true` 只证明"隔离能生效"，不证明"沙箱已在用 T0"。
  > **本清单更正**：当前代码**已接线**（`src/executor.mjs:1574-1606`），但**默认不选 T0**
  > （`src/capability.mjs:1286` 仍需 `proven===true`）。结论相同、措辞需更新。
- **T0 读面未收敛**：实测仍可读 `C:\Windows\win.ini`（残余 **R1**）。
- **WFP 未装过滤器**、**注册表 ACL 未启用**；沙箱内 `reg add` 的 `Access is denied`
  来自受限令牌/ACL 的既有约束，不是新增注册表策略。
- **R2 网络面未收敛**：沙箱内可开 socket（`src/testrunner.mjs:245-246`）。
- **`drainPipe` 吞吐**：固定 1 ms 轮询 ⇒ ~77 KB/s（库侧，未修）。
- **S1 二级未定论**：创建阶段 `Access is denied` 与用户态 `0xC0000142` 是否同因，保持未定论。
- **D1/D2 浏览器侧回归 `[未实测]`**（离线替代证据：`fixd_selftest 48/48` 等）。
- **遮蔽规则仍是黑名单**：改名/换扩展名/换目录形状即绕过；非 AppData 的
  Mozilla `key4.db`/`logins.json` **未覆盖**；**遮蔽 ≠ 拒绝**。

### 4.2 `src/testrunner.mjs::guaranteesNotProvided`（程序化生成，`src/testrunner.mjs:238-258`）

- 沙箱内读/写/删边界的实测证据（受限会话无法嵌套时）
- 读取面收敛：本后端限制写/删但不限制读取，残余边界 **R1**（`src/testrunner.mjs:243`）
- 网络硬阻断（受限令牌与 ACL 均不涉及网络；需 WFP 或 AppContainer 能力管控，`:245-246`）

### 4.3 手册（v3.0）要求但本项目**未提供**的保证

- **第 16.2 条只读系统集用白名单**：本项目的读面收敛是"黑名单 + shim 正则"，
  手册要求"未列出路径在沙箱内不存在"的**白名单**语义未实现。
- **第 10 章秘密三阶段拆分**：本项目实现的是"环境变量不注入 + 审批面省略内容"，
  没有占位符/映射恢复/broker 的完整三阶段机制。
- **第 9 章三种网络模式（OFFLINE / CONTROLLED_ONLINE / OBSERVED_ONLINE）**：无实现。
- **第 11 章 LSP 分片与缓存**：无实现（本项目不涉及 LSP）。
- **第 13.2 条清理顺序**中"停止写入者""记录残留预算与重试状态"：`collectGarbage`
  有归属校验与失败上报，但无"写入者收敛"概念。
- **第 17.1 硬验收表**中若干净依赖 T0/网络/LSP 的行：未满足。

### 4.4 本次分析**未能验证**（UNVERIFIED）的点

| 项 | 原因 |
|---|---|
| TS shim 在本机的**实际可用性**（`proven`） | 未运行金丝雀探测；仅有 `docs/T7:14` 的 `[实测]` 存档（30/30） |
| 载体启动 flake（`docs/T6:21` 的 ~4%，5/131）是否仍存在 | 未复跑 |
| `tier='auto'` 下 shim 载入失败时的**逐次**回退行为 | 仅从 `src/executor.mjs:3082-3101` 静态推断 |
| 暂存存储在**两个宿主进程同时写**时的实际竞态 | 无跨进程锁的静态结论；未做并发实验 |
| `NtSetValueKey` / 直接写 hive 的绕过是否被 `REGISTERED_HARD_DENIALS` 完整枚举 | 仅读代码与注释，未逐条复现 |
| `.t/` 下 19 个 selftest 的**当前**通过状态 | 未运行 |

---

## 5. 一句话差距基线

> **本项目真正由内核强制的只有三件：T1 的受限令牌+ACL+Low IL（限写/删，不限读）、
> Job Object 的进程树回收、以及显式 `tier=T0` 时的 AppContainer 包 SID 隔离（读+网+设备）；
> 其余全部是"用户态强制且 fail-closed"或"仅记录/仅取证"。
> 网络（WFP）与注册表 ACL 只有代码与计划、没有生效的过滤器或 ACL；
> 硬链接、ADS、剪贴板、窗口站、WMI/COM/服务/计划任务、磁盘配额、输出上限
> —— **本项目一行实现都没有**。**

---

*本文件由只读分析产出，未修改任何源文件。行号以 `read` 工具的编号为准。*
