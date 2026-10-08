# WinStageSandbox — Windows 暂存—候选—选择性提交沙箱

按《Agent 沙箱暂存—提交架构设计手册 v3.0》实现，面向 Windows + DeepSeek Harness。

**核心思路**：把"隔离"和"暂存"合并成同一件事——沙箱唯一可写根是**暂存树**，
真实工作区始终不被写入；沙箱内产生的变化冻结为**候选**，用户批准后才逐文件提交。

---

## 1. 快速开始

```powershell
cd C:\Users\Administrator\Desktop\WinStageSandbox

# ★ 一键跑完全部测试（推荐从这里开始）
.\autotest.cmd                    # 全部套件 + 生成 JSON 报告
.\autotest.cmd --skip-audit       # 只跑离线确定性测试（不需要未受限会话）
.\autotest.cmd --verbose          # 失败时打印完整输出

# 其他入口
.\verify.cmd                      # 25 套件离线测试的轻量版（无报告；清单 = OFFLINE_SUITES）
.\diag.cmd                        # 绑定表契约 + 完整 init（需未受限会话）
```

### 1.1 自动测试运行器 `autotest.cmd` / `autotest.mjs`

一次运行 **25 个离线套件 + 4 个沙箱套件 + 1 段沙箱审计**，分三段，并写出机器可读报告：

| 段 | 套件 | 需要未受限会话 | 说明 |
|---|---|---|---|
| A | **25 组离线确定性测试**（`OFFLINE_SUITES`，与 `verify.cmd` 逐字一致） | 否 | 手册不变量、端到端链路、结构体布局、命令解析、执行器编排、审计解析、元测试、注册表守卫、工作区回归、AppContainer 运行期、probe 自杀守卫，第三轮新增的 **网络策略 / 进程缓解 / 资源上限**、补登记的 **WFP 布局**、两个**治理套件**（接线治理 / 残余基线），C3 新增的 **审批策略一致性守门**（`policy-never-consistency`），「补丁工具包 ＋ 源码封印」轮的 **源码基线封印**（`baseline-integrity`）与 **DSH 补丁守门**（`dsh-patch-guard`），缺陷③ 轮的 **T0 污染 fail-closed**（`boundary-degraded-failclosed`），以及缺陷①b 轮的 **白障候选捕获**（`whiteout-candidate-capture`，由 `.t\shim-delete\test-whiteout-capture.mjs` 提升） |
| B | 4 个沙箱套件：`diag-bindings`、`file-cow-dispositions`、`registry-unstaged-wow64`、`delete-capture` | 是 | 绑定表契约 + 完整 `init()`；文件 CoW 处置矩阵；注册表 WOW64 视图；**缺陷①回归**（TS 档四种删除写法必须进暂存 + 白障；由 `.t\shim-delete\test-delete-capture.mjs` 提升，依赖 `shim\out\winstage-shim.dll`） |
| C | `audit` | 是 | 沙箱内真实攻击探针（结构化 JSON） |

> ⚠ **清单口径以代码为准**：`OFFLINE_SUITES` 是唯一权威，`verify.cmd` 的循环列表必须与之逐字一致。
> 这件事从第三轮起由 `tests/suite-wiring.mjs` 机器检查（此前两张清单曾**静默地顺序漂移**）。

**退出码**：`0` 无失败（含因机制边界跳过 C 段）｜`1` 存在失败｜`2` 环境错误。

**三种总判定**：

- `PASS` —— 全部通过
- `PASS-OFFLINE-ONLY` —— 离线全通过，但 C 段因**当前会话受限、无法建立嵌套沙箱**而跳过。
  这是机制边界不是失败，报告中会在 `guaranteesNotProvided` 里写明"未提供的保证"。
- `FAIL` —— 存在失败套件

报告写到 `.t/test-report.json`，含每个套件的状态、耗时、断言计数、原始输出路径，
以及按手册第 17 章要求的 **`guaranteesNotProvided`**（仍未提供的保证）。

失败时自动打印**最后一个失败套件的末尾输出**以及 `audit` 的 fail 明细，便于直接定位。

> **为什么 `autotest` 是 Node 而不是 `.ps1`**：本机执行策略为 `RemoteSigned` 且脚本未签名，
> `.ps1` 需要 `-ExecutionPolicy Bypass`，而 Bypass 子进程在本环境被拒。
> 用 Node 编写没有执行策略摩擦，也便于复用模块判断"本会话能否建立嵌套沙箱"。
>
> **为什么需要 `.cmd` 包装**：受限令牌下 `spawnSync` 默认的 `stdio: 'pipe'` 走**命名管道**，
> 客户端打开请求需要受限 SID 未被授予的写权限，子进程创建直接 EPERM。
> 运行器改用**文件描述符重定向**捕获输出，完全绕开命名管道。
> 这正是 `run.cmd` 存在的原因，已作为文档化残余边界 R10 记录。

### 1.2 元测试：运行器本身必须能检出失败

`tests/meta-runner.mjs` 用"人为失败的子进程"反证运行器的判定逻辑。
**一个永远不会报失败的运行器比没有运行器更糟 —— 它给出虚假的绿色。**
（本项目已经踩过一次"假通过"的坑：缺陷 11，见 `docs/实测证据记录.md`。）

### 1.3 手动调用

```powershell
# 初始化暂存区
.\run.cmd src\cli.mjs init    --workspace .\.t\ws

# 在 Windows 受限令牌沙箱内执行命令（写操作落进暂存树）
.\run.cmd src\cli.mjs exec    --workspace .\.t\ws -- powershell -NoProfile -Command "ni new.txt"

# 查看状态 / 待审 / diff
.\run.cmd src\cli.mjs status  --workspace .\.t\ws
.\run.cmd src\cli.mjs review  --workspace .\.t\ws
.\run.cmd src\cli.mjs diff    --workspace .\.t\ws

# 选择性提交（只应用部分路径）
.\run.cmd src\cli.mjs apply   --workspace .\.t\ws --paths new.txt

# 从沙箱内部发起真实攻击探针
.\run.cmd src\cli.mjs audit   --workspace .\.t\ws
```

### 1.4 自动测试服务（请求即测试，完成后返回输出）

不想守着终端时，可以起一个常驻服务，收到请求就跑测试并返回结果。

```powershell
# 启动服务（默认 127.0.0.1:8737，随机令牌会打印在控制台）
.\testservice.cmd
.\testservice.cmd --port 8800 --token mytoken      # 指定端口与令牌

# 用客户端触发（推荐，省得记 curl 语法）
node src\testclient.mjs --url http://127.0.0.1:8737 --token <令牌>
node src\testclient.mjs --token <令牌> --only selftest,audit
node src\testclient.mjs --token <令牌> --async        # 立即返回 jobId
node src\testclient.mjs --token <令牌> --watch <jobId>
node src\testclient.mjs --token <令牌> --log <jobId>
```

#### API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 探活（**唯一不需令牌**的端点） |
| GET | `/suites` | 可用套件清单 |
| POST | `/run` | **同步**跑一轮，完成后返回完整报告 |
| POST | `/jobs` | **异步**启动，立即返回 `jobId` |
| GET | `/jobs` | 列出全部 job |
| GET | `/jobs/<id>` | 查询单个 job（状态、进度、报告） |
| GET | `/jobs/<id>/log` | 纯文本日志（逐套件结果 + 仍未提供的保证） |
| DELETE | `/jobs/<id>` | 取消 job |
| GET | `/report/latest` | 最近一次完成的报告 |
| GET | `/report/latest/<suiteId>` | 某套件的原始结果 |

请求体（JSON，可选）：`{ "workspace": ".t/ws", "skipAudit": false, "only": ["selftest"] }`
同名参数也可走 query string（`?wait=0` 等效于异步）。

#### 实测示例

```
POST /run {}
→ overall = PASS-OFFLINE-ONLY
  套件 8 通过 / 0 失败 / 1 跳过   断言 222 ok / 0 bad   1203 ms
  [PASS                  ] selftest            217 ms  48 ok / 0 bad
  ...
  [SKIPPED-NESTING-LIMIT ] audit               113 ms   2 ok / 0 bad  coverage=13%
```

#### 安全边界（R13–R16，**不是可选项**）

这个服务**按请求执行本机测试套件**，本质上是本机代码执行入口。因此：

| 编号 | 边界 | 实现 |
|---|---|---|
| R13 | **只监听回环** | 默认 `127.0.0.1`，并校验 `remoteAddress` 属于回环，否则 403 |
| R14 | **强制令牌** | 默认随机生成并在启动时打印；除 `/health` 外全部要求 `Authorization: Bearer <token>` |
| R15 | **套件白名单** | 只接受固定的套件 id，**绝不接受任意命令或脚本路径**；非法 id 返回 400 |
| R16 | **串行执行** | 显式 FIFO 队列 + 单一泵，同一时刻只跑一轮，避免并发互相污染状态 |

> **为什么必须串行**：手册第 17.2 节要求套件隔离配置、注册表、cwd、缓存、端口与持久状态。
> 并发跑两轮测试会让它们争用同一份 `.t` 工作区，产生"偶发失败"这类最难查的问题。

> **为什么用 Node 内置 http**：零依赖，且与测试同栈 —— 服务与 CLI 直接复用
> `src/testrunner.mjs` 的**同一份**套件清单与判定逻辑，避免"CLI 说通过、服务说失败"的漂移。

> **注意**：`Start-Process` 和 `start /b` 在本沙箱下都无法让服务常驻（进程随父 shell 退出），
> 请在前台运行 `testservice.cmd`，或用后台作业方式启动。

---

## 2. 架构

```
┌─────────────────────────────────────────────────────────────────────┐
│ 逻辑视图（对 AI 唯一可见的世界）                                     │
│   read_file / write_file / edit_file / delete_file / list_files      │
│   / search_files            → src/tools.mjs   （进程内层：同一投影）  │
├─────────────────────────────────────────────────────────────────────┤
│ 统一工作区服务 Workspace Service                    → src/workspace.mjs│
│   基线快照 · 逻辑状态(暂存/删除/损坏) · 目录合成 · 路径映射           │
│   候选冻结(before+after) · 选择性应用 · 陈旧基线保护                  │
│                                     ↓ src/store.mjs                  │
│   内容寻址 blob 存储（自动去重，候选两侧不可变）                      │
├─────────────────────────────────────────────────────────────────────┤
│ 受信启动器（Windows 原生隔离）                     → src/executor.mjs │
│   WRITE_RESTRICTED 受限令牌（限制 SID 交集=唯一可写根）               │
│   + Low 完整性标签（no-write-up 兜底）                               │
│   + deny FILE_DELETE_CHILD（关闭父目录删除权旁路）                   │
│   + Job Object KILL_ON_JOB_CLOSE（进程树回收）                       │
│   + 环境变量从允许清单重建（绝不 merge 父环境）                      │
│   + 显式 lpEnvironment（绕开依赖包 lpEnvironment=NULL 的限制）       │
├─────────────────────────────────────────────────────────────────────┤
│ 能力探测 CapabilityProbe                            → src/capability.mjs│
│   真实 Win32 调用实测 · 环境指纹缓存 · 档位选择 · fail-closed         │
├─────────────────────────────────────────────────────────────────────┤
│ 审计（沙箱内攻击探针）                                 → src/audit.mjs │
└─────────────────────────────────────────────────────────────────────┘
```

### 文件清单

| 文件 | 职责 |
|---|---|
| `src/paths.mjs` | 路径规范化（链接解析、长路径前缀、盘符大小写）、词法/canonical 双重边界、敏感路径硬拒绝表 |
| `src/store.mjs` | 内容寻址 blob、暂存清单、候选队列、清理前置权限修复 |
| `src/workspace.mjs` | 统一工作区服务：存在性/读取/枚举/搜索/写入/删除/目录合成/差异/候选/选择性应用 |
| `src/tools.mjs` | 工具面：结构化返回（四种"空"可区分）、路径还原、所有路径参数硬校验 |
| `src/executor.mjs` | 受限令牌启动器、Job Object、显式环境块、内建自检 |
| `src/capability.mjs` | 能力探测、环境指纹、档位选择、可选功能文件标记探测 |
| `src/audit.mjs` | 沙箱内攻击探针与证据报告 |
| `src/cli.mjs` | 命令行入口 |
| `tests/selftest.mjs` | 手册第 17 章硬验收自测（48 项） |
| `tests/e2e-flow.mjs` | 端到端链路验证（捕获→冻结→diff→选择性提交） |
| `docs/Windows功能开启清单.md` | **需要开启哪些 Windows 功能/权限** |
| `docs/实测证据记录.md` | 两侧会话的实测证据、缺陷复盘、仍未提供的保证 |

---

## 3. 手册不变量 → 实现位置 → 自测证据

| 手册条款 | 不变量 | 实现位置 | 自测用例 |
|---|---|---|---|
| 1.1 / 2.1 | 统一视图：所有工具看同一版本 | `workspace.mjs` 全部读取走同一投影 | 统一工作区 9 项 |
| 1.1-2 | 连续修改跨 attempt 存活 | `store.mjs` 清单常驻 | 「连续两次写同一文件可叠加」 |
| 1.1-3 | 删除是持久逻辑状态 | `STATE.DELETED` + 副本缺失=损坏 | 删除权威性 6 项 |
| 3.1 | 存在性区分文件与目录 | `exists()` 返回 `kind` | 「存在性判断区分文件与目录」 |
| 3.1 | 副本丢失 ≠ 删除，禁止回退真实磁盘 | `verifyProjection()` + `WORKSPACE_CORRUPT` | 「暂存 blob 丢失时明确报损坏」 |
| 3.4 | 连续修改叠加 | 持久 `manifest.entries` | 「连续两次写同一文件可叠加」 |
| 3.5 | 写文件前准备受控父目录 | `synthesizeParents()` | 「深层新建文件可见」 |
| 3.7 | 删除态不被复活 | 读取先查清单，命中即返回 | 「读已删除文件报不存在」 |
| 3.8 / 12.1 | 取代限定在同一分支与修订关系内 | `freezeCandidate()` 按 session + 路径交集 | 「同一路径的新修订取代旧待审」 |
| 3.9 | 暂存路径保留 basename/扩展名 | `staged/<rel>` | 「暂存路径保留 basename 与扩展名」 |
| 3.10 | 正反向映射幂等 | `ensureEntry()` 复用既有条目 | 「同一路径重复暂存不产生新条目」 |
| 3.11 | 目录枚举合并并递归合成父目录 | `listDir()` 合并 + `hasStagedDescendant` | 「合成目录可枚举出子项」 |
| 4.1 | 路径还原覆盖错误分支 | `restorePaths()` / `restoreDetail()` | 「工具结果只暴露逻辑路径」 |
| 4.2 | 退出码 0 且无输出 = 完成无输出 | `completedWithoutOutput` | 见 `exec` 输出 |
| 4.3 | 空/无匹配/不存在/无权限四种结果 | `RESULT` 枚举 | 结构化返回语义 5 项 |
| 5.1 / 5.5 | 探测与真实执行一致；缓存不替代实例检查 | `probe()` + `instanceChecks()` | `probe` 输出 |
| 5.2 / 1.2 | 能力不足拒绝任务，不绑定真实工作区为可写 | `init()` 抛 `SANDBOX_UNAVAILABLE` | `SANDBOX_UNAVAILABLE` 路径实测 |
| 6 / 7 | 一个 attempt 一条物化路径；删除捕获完整 | `materializeForExecution()` + `captureAfterExecution()` | 删除型变更应用后真实消失 |
| 8.3 | 环境从允许清单重建，禁止 merge | `buildChildEnvironment()` | 审计 `secret-env-blocked` / `proxy-env-blocked` |
| 12.1 | 无净变化不入队 | `freezeCandidate()` 提前返回 | 「无净变化时不入队」 |
| 12.2 | 部分应用不丢其余 | `applyCandidate()` 保留 `remaining` | 选择性应用 4 项 |
| 12.3 | 陈旧引用重定向 + 幂等 | `resolveCandidate()` 沿链 + 环路保护 | 「陈旧候选可沿 superseded_by 链解析」 |
| 12.5 | 丢弃是有状态操作 | `discardCandidate()` 先落状态后回收 | 丢弃 3 项 |
| 12.6 | diff 两侧都在候选里冻结 | blob 内容寻址 + 冻结哈希 | 「候选冻结了 before 与 after 两侧内容」 |
| 12.7 | 待审计数按文件 | `summary.files` / `pendingFiles` | `status` 输出 |
| 13.1 | 清理前先修复权限，只作用已验证归属 | `makeRemovable()` 不跟随链接 | GC 2 项 |
| 16.6 | 遮蔽前先规范化，符号链接不能绕过 | `maskOf()` 先 canonical 再判豁免 | 「junction 逃逸仍被遮蔽」 |
| 16.7 | 硬边界先于可协商项；覆盖所有路径参数 | `assertToolPaths()` 先遮蔽后边界 | 「经 junction 读取被硬拒绝」 |
| 16.8 | 豁免限定作用域，不含自己 | 工作区内才豁免；`.dshstage` 永不豁免 | 豁免 2 项 |

**自测结果：48 / 48 通过。** 详细报告：`.t/selftest-report.json`。

### 自测抓出的前 3 个真实缺陷（安全相关，全部已修）

按手册第 17 章纪律，失败用例暴露的是**实现缺陷**而非测试问题：

1. **遮蔽顺序写反（安全相关）**：`maskOf()` 先查遮蔽表、后用 `isInside()` 判豁免，
   而 `isInside()` 内部会 canonical 化 → 工作区内指向宿主敏感目录的 junction
   被误判为"在工作区内"而**获得豁免**。修复：先 canonical 解析，只有解析后仍在
   工作区内才谈豁免。（手册 #16.6 / #16.8）
2. **边界判定混淆词法与 canonical**：`relative()` 用 canonical 判定，
   导致 junction 逃逸时直接抛异常，遮蔽表**没有机会**给出 `SANDBOX_PATH_MASKED`。
   修复：新增 `lexicalInside()`，边界判定用词法，逃逸交给遮蔽判定。（手册 #16.7）
3. **存在性查询以异常表达"不可见"**：`exists()` 经 `relative()` 抛
   `PATH_OUTSIDE_WORKSPACE`，而不是返回不可见。修复：存在性用词法判定，
   解析后逃逸返回 `source: 'masked'` 且不暴露解析目标。

> 其余 13 个缺陷（编号 4–16）见下面 §4 的完整清单。

---

## 4. 当前实测状态（诚实声明）

关键结论：**同一份代码在受限会话内无法建立沙箱、在未受限会话内可以**。
这从两侧实测证明了"Windows 进程隔离不可嵌套"。

### ★ 验收结论（第 12 轮，未受限 PowerShell）

```
汇总: {"pass":19,"fail":0,"residual":3,"informational":2,"not-run":0}
覆盖度: 100%  判定: pass-with-residuals
```

| 手册第 17.1 节硬验收项 | 实测结果 |
|---|---|
| 未授权宿主句柄 / 越界文件效应 | ✅ 写/删越界全部 `denied`；暂存根内 `ok` |
| 进程内工具访问敏感路径 | ⚠ 部分收敛（SAM/SYSTEM/会话/SSH/DPAPI/Git 凭据 → 拒绝；hosts/Unattend/npmrc → 可读，属残余） |
| 密钥与代理不进入子进程 | ✅ `present=false` |
| 临时目录会话私有 | ✅ `TEMP` 重写为 `dsh-stage-temp\<uuid>` |
| 生命周期与资源归属 | ✅ Job 总进程数增量 1、子进程退出码 0、纳管确认 |
| 清理与自检 | ✅ `init()` 自检 + `dispose()` 幂等（离线测试覆盖） |

3 个 ⚠ 是**如实声明的残余边界 R1**（本后端限制写/删但**不限制读取**），不是失败，
但**不得声明为硬边界**（手册 #16.10）。

| 项 | 进程内（DSH GUI 会话） | 未受限 PowerShell | 证据 |
|---|---|---|---|
| 暂存—候选—提交主链路 | ✅ 48/48 | ✅ 48/48 | `[实测]` |
| 端到端链路 | ✅ 通过 | ✅ 通过 | `[实测]` |
| ACL / 进程库可加载 | ✅ | ✅ | `[实测]` |
| **建立受限令牌 + ACL 授予** | ❌ `CreateRestrictedToken` 失败 | ✅ **成功（tier=T1，flags=0x2000）** | `[实测]` 两侧对比 |
| 沙箱内写入/删除边界 | ⏸ 无法取证 | ✅ **全部取得实测结果** | `[实测]` |
| 沙箱内读取面 | ⏸ 无法取证 | ⚠ 3 项可读（残余边界 R1） | `[实测]` |
| 沙箱内攻击探针覆盖率 | ⏸ 13% | ✅ **100%** | `[实测]` |
| 网络收敛 | ⚠ 不涉及，残余边界 R2 | 同 | `[官方]` |

> **`[实测]` 隔离不可嵌套**：受限会话内令牌缺 `TOKEN_ADJUST_DEFAULT` / `TOKEN_ADJUST_SESSIONID`，
> `CreateRestrictedToken` 失败；在未受限会话内同一调用成功。
> 因此沙箱**必须由未受限宿主进程建立**，在已受限会话内必须 fail-closed。

完整证据与"仍未提供的保证"见 [docs/实测证据记录.md](docs/实测证据记录.md) §C.1.1 与 §D。

### 实测暴露的 16 个真实缺陷（已全部修复）

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| 1 | `run.cmd` 报 `'WRITE_RESTRICTED' 不是内部或外部命令` | 批处理含 UTF-8 中文注释，cmd.exe 按 OEM 代码页解析并当成命令执行 | `run.cmd` 改为纯 ASCII |
| 2 | `this.api.spawnPipedProcess is not a function` | 我捕获的是 `AclSandbox` 的**私有安全绑定表**，它不含进程库原语 | 新增 `mergeBindingTables()`：以低层表为基底，只补入 ACL 独有扩展 |
| 3 | `QueryInformationJobObject failed (24 …长度不正确)` | 该 API 要求长度**恰好**等于结构大小；原实现传 64（实际 48） | 实测确定 48 并固化 |
| 4 | 报 `did not expose spawnPipedProcess`，且被**错误归因为令牌不足** | 混为一谈：`loadWin32ProcessBindings()` 返回**低层表**（从不含 `spawnPipedProcess`），而 `spawnPipedProcess(api, options)` 是**模块级函数** | 三者分离取用；审计归因改造：只有确实因令牌权限不足才标 `not-run`，其余一律标 `fail` |
| 5 | `offset is out of range … Received 48` | 我**凭记忆**写的结构体偏移整体错 4 字节（应为 32/36/40/44，我写成 32/40/44/48） | 修正偏移；抽出 `parseBasicAccounting()` + 边界断言；新增不依赖 Win32 的 `tests/struct-layout.mjs` |
| 6 | `CreateProcessAsUserW failed (Win32 2)`，命令 `pwsh` | **该 API 不做 shell 式可执行文件解析**：不补 `PATHEXT`、不查 App Paths。裸名字必然 `ERROR_FILE_NOT_FOUND` | 新增 `resolveExecutable()`，在宿主侧按 CreateProcess 搜索顺序解析成绝对路径 |
| 7 | 修好解析后仍 Win32 2 | **本机没有安装 `pwsh`**，只有 Windows PowerShell 5.1；代码硬编码了 `pwsh` | 新增 `resolvePowerShell()`，按 `pwsh → powershell` **实际探测**并缓存 |
| 8 | 沙箱启动失败时异常从 `run()` **冒泡**，调用方无法区分"沙箱坏了"与"命令被拒" | `launcher.launch()` 未包 try/catch，违反手册第 4 章返回契约 | 失败时返回 `exitCode:127` + `launchFailed:true` + `runner-failure` 分类 |
| 9 | 超时被**误分类为 `runner-failure`** | `classifyOutcome` 先匹配裸前缀 `/dsh-stage: /`，而超时消息也带该前缀 | 先认最具体标记（`dsh-stage: timeout after`），再认通用前缀 |
| 10 | 替身无法被发现：`captureLaunchState` 要求令牌必须是 `bigint`/`object` | 类型假设过强；真正证明令牌有效的是随后能带着它 spawn 成功 | 改为按字段名匹配、不假设类型 |
| 11 | 读取面 10 项**全部假通过**（显示"拒绝读取 unknown"），写入面全 fail，`TEMP=undefined` | **审计把"脚本没有产出任何输出"当成了"操作被拒绝"**；读取面在结果里找不到路径时也判 `readable=false` → `status='pass'` | 新增**预检门**（先验证 shell 能否产出输出）+ **输出哨兵** `DSH-AUDIT-JSON:` + 读取面改按序号回传布尔值；空结果一律判 fail |
| 12 | 审计模块自身被编码破坏：255 处 mojibake、行被合并、字符串字面量引号被截断 | 我用 PowerShell 做 `Get-Content -Raw` → `Set-Content -Encoding UTF8` 文本往返，读取时未指定 UTF-8 | 以正确 UTF-8 重写；新增编码自检。**绝不用 shell 文本往返修改含非 ASCII 的源码** |
| 13 | `CreateProcessAsUserW failed (Win32 87 = ERROR_INVALID_PARAMETER)`，`launchFailed=true`，**子进程根本没创建** | 注入 UTF-16LE 环境块时**没有同时置 `CREATE_UNICODE_ENVIRONMENT` (0x400)**。库内部以 `creationFlags = 0` 调用（其受限路径本来传 `lpEnvironment = NULL`），我们补了环境块却丢了这个必须成对出现的标志 | 注入分支上 `flags \|= 0x400`；未注入的调用不改 flags |
| 14 | `AssignProcessToJobObject failed (1816 = ERROR_NO_SYSTEM_RESOURCES)`，即 **Job 配额耗尽**，任何命令都起不来 | ① `init()` 自检**把宿主自身进程挂进了常驻 Job**；② Job 设了 `ACTIVE_PROCESS` 上限（曾默认 32）。自身占掉名额后，再挂沙箱子进程就越界 | 自检改用**临时 Job**（建→查→即释放），不把宿主进程挂进任何 Job；**默认不设** `ACTIVE_PROCESS` 上限；`init()` 断言常驻 Job 启动时为空 |
| 15 | `child.wait is not a function`；子进程已创建但拿不到输出 | **调用了不存在的 API**：`spawnPipedProcess` 返回 `{ pid, process, stdoutRead, stderrRead }`，**没有 `wait()`**；管道要用 `drainPipe`，退出码要用 `waitForProcessExit` | 新增 `collectChild()` 用真实 API 收集结果；缺失即 fail-closed。**并修正了失真的替身** |
| 16 | 预检回报 `子进程关键变量=undefined` | `parseMarkedJson()` 把哨兵**硬编码**成 `AUDIT_MARKER`，而预检用的是 `DSH-PREFLIGHT-…`，查找永远不匹配 | 参数化哨兵 `parseMarkedJson(stdout, marker = AUDIT_MARKER)`；断言"不传哨兵时解析不出自定义哨兵"以证明该参数必需 |

**十一条方法论教训：**

- **缺陷 4：归因纪律。** 审计原先把"沙箱建立失败"一律解释成"嵌套不可用"，
  于是一个**代码缺陷**被伪装成**环境限制**。若不核对，它会被永久归因给令牌。
- **缺陷 5：不要凭记忆写结构体布局。** 该错误连过两轮审计，因为受限会话跑不到那一步。
- **缺陷 6+7：命令能不能起来，必须被独立测试。**
- **缺陷 8+9：编排层必须能被离线测试。**
- **缺陷 11（最严重）：空结果不是拒绝。** 它让审计**报出了一组完全错误的结论**——
  10 项"读取被拒绝"全是假通过。这比"探测失败"危险得多，因为它**伪装成证据**。
  也正是它让缺陷 13、14、15 在此前**永远无法被发现**。
- **缺陷 12：工具选择错误。** 用 shell 往返文本处理非 ASCII 源码是自伤行为。
- **缺陷 13：补参数别漏配套标志。** 一路走到第 8 轮才暴露。
- **缺陷 14：自检必须是只读的。** "把自身挂进 Job 再查询"改变了运行期状态，
  反而制造了它本要预防的故障（手册第 17.2 节同一道理）。
- **缺陷 15：替身失真比没有替身更危险。** 我给假 child 伪造了真实库并不存在的 `wait()`，
  于是离线测试全绿、真实环境立刻炸。**替身必须逐字段对齐真实 API**，
  宁可让它复杂，也不要让它比真实对象"更好用"（与手册第 15.5 节同类错误）。

失败点逐层后移的时间线（1 批处理 → 2/4 绑定表 → 3 Job 长度 → 5 结构体偏移 →
6/7 命令解析 → 11/12 结论可信性 → 13 创建参数 → 14 Job 配额 → 15 结果收集 API）说明：
**把"假通过"改成"明确失败 + 可定位诊断"是整个工作的转折点。**

现在有 **6 组不依赖 Win32 的确定性测试**，一条命令即可全跑：

```powershell
.\verify.cmd     # 25 套件（清单 = OFFLINE_SUITES）；权威表与断言数口径见 §8.2
```

| 测试 | 项数 | 覆盖 |
|---|---|---|
| `tests/selftest.mjs` | **51** | 手册不变量：统一视图、删除权威、候选冻结、选择性应用、遮蔽、返回语义、**测试卫生（不残留重解析点）** |
| `tests/e2e-flow.mjs` | 16 | 捕获 → 冻结 → diff → 选择性提交全链路 |
| `tests/struct-layout.mjs` | 24 | 结构体大小/偏移/越界、扩展限制、环境块编码 |
| `tests/appcontainer-layout.mjs` | **27** | **AppContainer 布局**：STARTUPINFOEX / SECURITY_CAPABILITIES / 创建标志 / 属性号 |
| `tests/resolve-exec.mjs` | 19 | 可执行文件解析、PATHEXT 回退、子环境含 PATH |
| `tests/executor-stub.mjs` | **72** | init 装配、spawn 契约、**0x400 标志**、**Job 配额/自检只读性**、**真实结果收集形状**、环境注入、fail-closed、超时回收、dispose |
| `tests/audit-parse.mjs` | 23 | 哨兵解析、**空输出必须判 fail**、单引号转义、**自定义哨兵** |
| `tests/meta-runner.mjs` | 4 | 元测试：运行器能否检出失败 |
| `tests/diag-bindings.mjs` | 14 | 绑定表契约 + 完整 init |

> ⚠️ **上表是第二轮之前的旧口径，已被 §8.2 的权威表取代**：`executor-stub` 72 → **84**、`audit-parse` 23 → **43**、
> `appcontainer-layout` 27 → **34**、`e2e-flow` 16 → **21**、`command-selftest`（§7）22 → **24**，
> 并新增 `paths-masks` **37** / `registry-guard` **125** / `workspace-regressions` **10**。
> 旧文"`verify.cmd` 现为 **11 套件 / 452 断言**；`autotest --skip-audit` 为 **12 套件 / 474 ok**"是**第二轮时点口径**，
> 第三轮起 `verify.cmd` 覆盖 **20 个离线套件**（含网络策略 / 进程缓解 / 资源上限 / WFP 布局 / 两个治理套件），
> 本轮 C3 追加 `policy-never-consistency` ⇒ **21 个**；此后「补丁工具包 ＋ 源码封印」轮 ⇒ **23**、
> 缺陷③轮 ⇒ **24**、缺陷①b轮 ⇒ **25**（断言数已由 finisher 全量复跑填入：**2034 标记 / `RESULT: ALL PASS`** —— 见 §8.2）。

详见 [docs/实测证据记录.md](docs/实测证据记录.md) §C.2。

---

## 5. 档位与**实现状态**

### 5.1 各 Windows 原语的实现状态（诚实区分"已实现/已探测/未实现"）

本项目的目标里点名了 5 类 Windows 原生能力。**必须逐类说清到底做到哪一步**，
不能让"档位表里出现过 AppContainer"被读成"AppContainer 已经能用"：

| 能力 | 状态 | 说明 | 证据 |
|---|---|---|---|
| **Restricted Token**（WRITE_RESTRICTED） | ✅ **已实现并实测** | 复用 `AclSandbox` 构造的受限令牌 + 受限 SID 交集＝唯一可写根；在此基础上自行注入显式环境块与 Job 归属 | `[实测]` 写入面 7 项 + `tests/executor-stub.mjs` 72 项 |
| **ACL**（DACL 授权 + deny `FILE_DELETE_CHILD` + Low IL 标签） | ✅ **已实现并实测** | 由 `@deepseek-ai/dsh-sandbox-windows-acl` 施加；越界写/删实测全部 `denied` | `[实测]` audit 写入面 |
| **Job Object**（`KILL_ON_JOB_CLOSE`） | ✅ **已实现并实测** | 自建 Job，子进程挂入；会计自检（精确 48 字节）在 `init()` 内强制；超时即终止整树 | `[实测]` audit 生命周期段（总进程数增量 1） |
| **AppContainer** | ✅ **运行期已实测生效（`proven=true`）且已接线到执行器；但默认档位仍是 `T1`，`selectTier()` 的 T0 闸门仍要求 `proven === true`** | `src/appcontainer.mjs` + `src/appcontainer-runtime.mjs` 提供 `STARTUPINFOEX` / `SECURITY_CAPABILITIES` / 属性列表构造，并新增**权威判据**（`TokenIsAppContainer=29` / `TokenAppContainerSid=31` / `TokenIntegrityLevel=25`）与 `assessAppContainerIsolation()`（五项判据**缺一即 false**，无硬编码、无跨 profile 复用）。`[实测]` 真实子进程：`IsAppContainer=1`、包 SID 一致、**Low IL**、**区外写被拒**（宿主对照成功）、`caps=0` 时 `curl` **exit 7** ⇒ **`proven=true`**。离线布局测试 **34 项**（`tests/appcontainer-layout.mjs`） | `[实测]` 端到端隔离证据（`.t/sbx3/dev/raw-t0-isolation-proof.txt`）；**接线与默认档位的准确说法见下方 §5.1 与 §8** |
| **WFP**（Windows Filtering Platform） | ⚠️ **结构/调用层与策略层已实现，OFFLINE 档位 fail-closed；真实安装 `[未实测]`** | `src/wfp.mjs` 提供 `FWPM_FILTER0` / `FWPM_SUBLAYER0` / `FWPM_SESSION0` / `FWPM_FILTER_CONDITION0` 等结构的构造与 `Fwpm*` 调用编排；`src/netpolicy.mjs` 把它接成**策略**：前置能力（绑定表 / pin 回调 / 可用性探测 / 引擎可开）任一缺失即 `refused`，`enforced:true` **只**在"过滤器确实装上且回读核对通过"时出现。离线证据：`tests/wfp-layout.mjs`（合成缓冲区钉死布局）+ `tests/netpolicy.mjs`（替身绑定表钉死五条不变量）+ `tests/residual-baseline.mjs`。**但本机从未安装过任何真实过滤器** —— 安装过滤器是系统级状态变更，本阶段未获授权 | 离线 `[实测]`（合成缓冲区 / 替身绑定表）；真实 BFE 行为与端到端阻断 `[未实测]`。差距来源：[docs/NeoAI-沙箱能力分析与差距输入.md](docs/NeoAI-沙箱能力分析与差距输入.md) §3.3 / §5.3（要求内核层出站过滤）与 [docs/WinStageSandbox-能力清单与差距基线.md](docs/WinStageSandbox-能力清单与差距基线.md) §2（网络面 ABSENT） |

**因此：**

- **T0 的隔离已 `[实测]` 生效，T0 也已接进执行器；但默认档位仍然是 `T1`。**
  准确说法（逐条，别再互相矛盾）：
  ① T0 **已经接线**：显式请求 `tier: 'T0'` 时，`src/executor.mjs:3380-3382`（`selectLaunchMode('T0') → 'appcontainer'`）、
  `:1544-1547`（写入 `launchMode`）、`:1669-1704`（装配 `createAppContainerLauncher`，失败即
  `SANDBOX_UNAVAILABLE`、**不静默回退 T1**）、`:2181-2192`（T0 启动分支）真的会走 AppContainer 路径；
  ② 但**默认选不到 T0**：执行器默认 `this.tier = options.tier || 'T1'`（`src/executor.mjs:1304`），
  只有调用方显式点名 T0 才会用；
  ③ 能力报告的档位建议 `selectTier()` 的 T0 闸门逐字仍是
  `report.appContainerIsolation?.proven === true`（`src/capability.mjs:1436`，四条同时成立见 `:1462`），
  而 `proven` 需要跑一次真实隔离探针 —— 没有探针结果时 T0 一律 fail-closed。
  因此"默认路径跑在 `T1`"是**档位默认值 + `selectTier()` 闸门**两件事的结果，
  **不是**"T0 没接线"；反过来，`proven=true` 也**不**等于"沙箱已经默认用上隔离"。
- **AppContainer 布局已用合成缓冲区离线钉死**（**34** 项），这是从缺陷 5（Job 结构体偏移错 4 字节）
  与缺陷 13（漏 `CREATE_UNICODE_ENVIRONMENT`）总结出的做法：**先把布局测对，再谈运行**。
- **网络面：策略层已存在，真实强制仍是 `[未实测]`**。`src/netpolicy.mjs` + `src/wfp.mjs` 的 OFFLINE
  判定是 fail-closed（能力不足即 `refused`，绝不 `enforced:true`），但本机**未安装任何真实 WFP 过滤器**
  ⇒ 沙箱内实际仍可开 socket，"已断网"的说法依旧不成立（R2）。详见 §9.1。
  （补：T0 自己的网络阻断只是"**不声明能力**"的默认值——一旦声明 `internetClient` 网络即通，
  所以能力集必须由策略层白名单化，不能由调用方随手传。）
- **旧结论更正**：早先由本表读出的"AppContainer 探测 `E_ACCESSDENIED` ⇒ 隔离为零 / 进不了容器"
  **已被推翻** —— 那是**判据错误**（拿 `TokenUser` 比包 SID，而 AppContainer 令牌的 `TokenUser`
  **本来就是用户 SID**，包身份在 `TokenAppContainerSid(31)`，且包 SID **不在** `TokenGroups` 里）。
  详见 §8 与 [.t/sbx3/dev/03-FIX-B报告.md](.t/sbx3/dev/03-FIX-B报告.md)。

### 5.2 档位表

| 档位 | 机制 | 读取面 | 网络面 | 前置条件 | 本项目实现状态 |
|---|---|---|---|---|---|
| `T0` appcontainer | AppContainer 能力令牌 + Job + Low IL + ACL | ✅ 收敛 | ✅ 默认阻断 | 能创建 AppContainer profile | ⚠️ **隔离已 `[实测]` 生效（`proven=true`）且已接进执行器；但默认档位是 `T1`（显式 `tier:'T0'` 才走 T0），`selectTier()` 的闸门仍要求 `proven===true`**（见 §5.1 与 §8） |
| `T1` restricted-token | WRITE_RESTRICTED + Job + Low IL + ACL | ❌ 不收敛 | ❌ 不收敛 | 令牌具备全部访问权 | ✅ **已实现并实测** |
| `T2` acl-only | 仅 ACL 写边界 | ❌ | ❌ | 目录属主 | ✅ 已实现（降级路径） |
| `T3` none | 无可用原语 | — | — | — | ✅ **拒绝执行**（fail-closed） |

档位由 `selectTier()` 依据**真实 Win32 调用结果**选择，不据文档推断。

---

## 6. 已知残余边界

完整清单见 `docs/Windows功能开启清单.md` 第 13 节（R1–R12）。最关键几条：

- **R1 读取面不收敛**：本后端限制写/删，不限制读。读取面收敛只能靠 AppContainer
  （**T0 已实现、隔离 `[实测]` 生效、且已接进执行器，但默认档位是 `T1`** —— 见 §5.1/§5.2）
  或工具层硬拒绝清单。
- **R2 网络面不收敛**：网络策略层已存在且 OFFLINE 档位 fail-closed，但**本机未安装真实过滤器**
  （`[未实测]`）⇒ 沙箱内实际仍可开 socket。见 §5.1、§9.1。
- **R6 嵌套隔离不可用**：已受限进程无法再建受限令牌 → 沙箱必须由未受限宿主进程建立。
- **R7 环境块需运行时注入**：依赖包的受限 spawn 固定传 `lpEnvironment=NULL`（继承父环境，
  违反手册 #8.3）；本实现替换绑定表注入显式环境块，并在结构不符时 **fail-closed 拒绝启动**，
  绝不静默退回继承父环境。

---

## 7. DSH 集成：暂存审批悬浮窗

把本沙箱接进 DeepSeek Harness，使 **DSH 自己的 `write`/`edit` 工具也落暂存树**，
并在输入框上方给出「待审文件 + 逐文件 diff + 批准/拒绝」的悬浮窗：

- 装配与数据通路（为什么用 `review.json` + `/winstage` 命令而不是新的 Remote 命名空间）、
  **实测证据**、**已知崩溃风险**（在线切换该 bundle 会让宿主进程退出，改配置后请重启）、
  残余边界（shell 写入不经过暂存等）：见 [docs/DSH集成.md](docs/DSH集成.md)。
- 三套可重复跑的离线自测：`.t/review-selftest.mjs`（26 项）、
  `.t/staging-fs-selftest.mjs`（31 项）、`.t/command-selftest.mjs`（22 项）。
- `/winstage [list|diff|approve|reject|refresh]` 是人工侧的批准入口；命令不产生模型消息。

### 7.1 第二实例 + 真实浏览器实测（2026-09-28）

在**独立的第二个 DSH 实例**（另一端口、独立 `DSH_HOME`）上装了本插件，用真实浏览器（CDP）
把面板**看得见、点得动**逐条验过。结论摘要，证据见
[需求与验收](docs/dsh2-需求与验收.md) / [基线报告](docs/dsh2-基线报告.md) /
[修复报告](docs/dsh2-修复报告.md) / [发现台账](docs/dsh2-发现记录.md)：

- **面板确实出现**（headless + 有头双证据，截图在 `.t/dsh2/browser/`）；
  「批准所选」后 `review.json` 变化且文件**真的落盘**，「暂时收起」后消失。
- **修掉 7 个缺陷**，其中两个是"看不见就永远查不出来"的：
  ① loader 行名用子路径 specifier ⇒ **client 半永不下发**（面板永远不出现，刷新无效）；
  ② 命令定义写成 `input: { placeholder }` 而校验器要 **`hint`** ⇒ 注册抛错 ⇒
  `/winstage*` **一条都没注册** ⇒ 面板的批准/拒绝**静默失效**。
- **两条硬规则**（改 composition 前必读）：**host 行必须用裸包名、fs 行必须保留子路径**；
  且 **profile 覆盖层必须重述该行 config 的所有键**（`config` 是整体替换、不是深合并，
  漏写的键**静默消失**）。
- **环境事实**：本 Agent 沙箱内**起不了 Chromium**（Mojo 要命名管道），浏览器验收必须在
  **沙箱外的终端**启动浏览器再用 CDP 操作 —— Runbook 见
  [.t/dsh2/S5-浏览器Runbook.md](.t/dsh2/S5-浏览器Runbook.md)。

> **本节写于当时，其中一条已经作废（整理轮更正）**：原文写"改动尚未提交 git（本环境 PATH
> 上没有 git）"，而本机确有 git 2.55，且 `dsh-plugin/` 下的 `cordis.patch.yml`、
> `host-plugin.mjs`、`client.js`、`staging-fs.mjs`、`fs-entry.mjs` 已随后续
> "整理仓库并纳入插件与测试"入版本库。**整理轮**（测试套件入库）又把此前一直未跟踪的
> `tests/*.mjs`、`tools/*.mjs`、`src/` 与 `dsh-plugin/` 的漏项、`patches/` 一并入库，
> 详见 §11 与 `.gitignore` 头部的两条设计原则。

---

## 8. 第二轮修复（FIX-A/B/C/D）

第二个修复轮次按四个工作流并行推进，各修一处/一组缺陷，**每条结论都有原始输出存档**。
完整叙述（含逐条原始字段）见 [.t/sbx3/最终报告.md](.t/sbx3/最终报告.md) §12。

### 8.1 修了什么（一句话一条 + 证据路径）

| 缺陷 | 结论 | 关键证据 |
|---|---|---|
| **D11** `cli exec` 管道死锁 | **已修（产品级）**：同一 300 KB 用例由「挂死到封装超时（`outBytes=0`、`durationMs=150153`、连 `--timeout 60000` 的 124 都没打印）」变为 **300395 B / `exitCode=0` / `4376 ms`**。改法：`src/executor.mjs` 新增 `waitForExitWithoutStarvingEventLoop`（**50 ms 有界等待切片** + `await setTimeout(0)` 让出事件循环），`collectChild` 改为**先发起两条排水、把退出等待延后一个宏任务**。判定力：把 `collectChild` 回退成同步等退出 ⇒ `tests/executor-stub.mjs` 由 **84 ok/0 bad → 84 ok/3 bad**，随后按字节还原（SHA256 `00E593D9…33A0`）。**残留**：`drainPipe` 固定 1 ms 轮询 ⇒ 吞吐 ~77 KB/s（**库侧，未修**） | `.t/sbx3/fixA/out/EVIDENCE-INDEX.md`、`out/fixA-d11-summary-*.json`、`out/D11-stub-{GREEN,RED}-*.txt`、`out/jobs/big.cli.out.txt` |
| **S1** 沙箱内子进程静默死亡 | **精确表征（与 D11 不同因）**：同一 `cmd.exe /c ver` 只改创建标志 —— `0x0` → **exit 0 且有 `ver` 输出**；`CREATE_NO_WINDOW(0x08000000)` / `CREATE_NEW_CONSOLE(0x10)` → **`0xC0000142`**；`NEW_PROCESS_GROUP(0x200)` / `UNICODE_ENV(0x400)` → 0；`DETACHED(0x8)` → 1 ⇒ **受限令牌下「需要新建控制台」⇒ 子进程秒死**（`CreateProcessW` 仍返回成功）。**执行器主路径不受影响**（`spawnPipedProcess` 本就 `creationFlags=0`）；二级（PowerShell 侧**创建阶段**就 `Access is denied`）**未定论、不合并** | `.t/sbx3/fixA/out/s1-flag-diff.json`、`out/s1-stage1.json`、`out/node-spawn-probe.json` |
| **T0 / AppContainer** | **"第 3 因"不存在，是判据错误**：AppContainer 令牌的 `TokenUser` **本来就是用户 SID**，包身份在 `TokenAppContainerSid(31)`，包 SID **不在** `TokenGroups` 里。四组实验（koffi / 显式 AC 令牌 + `DuplicateTokenEx` / 独立 PS P/Invoke / `caps=0` vs `1`）实测：`IsAppContainer=1`、包 SID 一致、**Low IL**、**区外写被拒**、**`caps=0` 时 `curl exit 7`**、**`caps=1(internetClient)` 时 `curl exit 0`**。顺带修掉两个真缺陷：`deriveCapabilitySidsFromName` **悬垂指针**（整进程 `0xC0000374` 堆损坏）、`bInheritHandles=TRUE` + 无自有控制台 ⇒ 子进程 `0xC0000142`（默认改 `false` + 危险组合 fail-closed）。`proven` 接到实测证据（五项判据缺一即 false），真机 `proven=true`；T0 **已经接进执行器**（显式 `tier:'T0'` 时装配并启动，失败即 `SANDBOX_UNAVAILABLE`），但**默认档位仍是 `T1`**，且 `selectTier()` 的 T0 闸门继续要求 `proven === true` —— 两者都不是"未接线" | `.t/sbx3/dev/03-FIX-B报告.md`、`raw-t0-{forensics,pinvoke,launch-matrix,isolation-proof}.txt`、`raw-fixb-{layout,runtime}-{green,plant}.txt` |
| **S3** `dpapi-user` 漏掉 `Microsoft\Protect` 目录自身 | **已修**：`canonical()` 会**去掉结尾分隔符** ⇒ 旧模式（要求结尾 `\`）只能命中目录下的文件；改为 `(\\\|$)` 并新增**目录探针** | `.t/sbx3/fixC/out/s3-dpapi-dir.before-after.txt` |
| **S5** 非 AppData 的浏览器凭据库不被命中却可读 | **已修**：新增两条规则 `browser-profile-auth-db` / `browser-profile-state`（各带**可命中**探针），覆盖 `Login Data` **129024 B**、`Login Data For Account` 51200 B、`Local State` **74863 B** 等 6 条路径；并修掉首版 `[^\\]*profile` 只匹配紧邻上一级的漏网 | `.t/sbx3/fixC/out/s5-browser-nonappdata.before-after.txt` |
| **F8** 非十六进制 `data` 被静默解码 | **已修（实测比原描述更糟）**：原先**静默**解出**与写入值无关的垃圾**（`REG_SZ('hello')` → `0000`、`REG_DWORD` → 0、`REG_QWORD` 抛**无 code** 的 `SyntaxError`）⇒ 新增 `assertShape()` 抛 `code='REG_SNAPSHOT_INVALID'`，**12 条新断言** | `.t/sbx3/fixC/out/raw-registry-guard-{green,plant}.stdout.txt` |
| **读取探针** | `src/audit.mjs::READ_PROBES` **10 → 42 条**（原 10 条 **id/顺序逐字保留**）+ **五态**判定（`readable` / `denied` / `read-metadata-only`（记 fail）/ `not-present`（**绝不记 denied**）/ `error`）。实测三态分布 `{read-metadata-only:5, readable:16, not-present:21}`；只记 `id/path/verdict/len/head4/errCode`，**秘密不进证据** | `.t/sbx3/fixC/out/read-probes-run.txt`、`.t/sbx3/fixC/REPORT.md` |
| **D1** 面板只渲染净 diff，活候选不可见 | **已修**：`files[]` = 净 diff 行（可批准）**∪ 冻结存档行**（`frozenOnly:true`，只显示、**无勾选框**、带 `frozenReason`）；新增 `counts.{net,frozenOnly}` 与 `candidates[]`（含 `appliedPaths`）。**关键坑**：`cs_0005` 的两条是 `state:"deleted"` + `baseHash:"absent"` 的墓碑，删除类 `after.hash` 也是 `'absent'` ⇒ 用磁盘比对会误判成"已完成"，已改为 `appliedPaths` ∪ 非删除类磁盘比对。修前 FAIL：`s2-candidate-paths-visible`（`invisible=[cs_0005 .ssh\id_rsa, cs_0005 r3-a.txt]`，exit 5） | `.t/sbx3/browser/out/fixd-pre-s2-panel.txt`、`out/fixd-post-restart-loaded.json`、`.t/sbx3/browser/FIX-D-报告.md` |
| **D2** `reject()` 连坐回收却只 discard 最新候选 | **已修**：`reject()` 重写 + `reconcileCandidates()` ⇒ **discard 范围 = 回收范围**，不再留"空壳 pending"；语义明确「拒绝全部 = 清空全部暂存 + 终结全部候选 ⇒ 面板卸载是**设计**」。修前 FAIL：`s4-no-shell-pending`（`openAfter` 留下 3 份空壳，exit 5）。跨工作区守卫（`sameRoot()`/选举/poller 自校验）**一字未改**，另有**独立控制组** | `.t/sbx3/browser/out/fixd-pre-s4-reject.txt`、`fixd_client_selftest.mjs`（E1/E2） |

### 8.2 权威测试套件表（25 套件；数字来自一次具体的全量复跑，`[实测]`）

`verify.cmd`（离线确定性套件，任何会话可跑）—— **25 套件**（第三轮 13 → 20，C3 20 → 21，「补丁工具包 ＋ 源码封印」21 → 23，缺陷③ 23 → 24，缺陷①b 24 → 25；清单 = `OFFLINE_SUITES`）。

> **表中数字的口径（本轮最新权威，finisher 收口）**：来自
> `cmd /c "verify.cmd > .t\finish-verify.txt 2>&1"`（`[实测]` 本机本会话、DSH 文件策略
> **danger-full-access**；**exit 0**、`RESULT: ALL PASS`；**25/25 套件全绿、0 条红断言**，
> 标记计数 **2034**）。
> 计数方式与下表逐行口径一致：25 个套件块共 **1949** 个 `✓` 标记，加上用 ASCII 标记
> （`[OK  ]`）自报的 **85** 项 = `tests/probe-selfkill-guard.mjs` **28** ＋
> `tests/boundary-degraded-failclosed.mjs` **57**（这两个套件在 `countChecks` 里显示 0，
> 见 `src/testrunner.mjs` 的计数口径注记）。
> 与上一份权威日志 `.t/patchkit-verify.txt`（23 套件 / 1920 `✓` + 28 = 1948）相比，
> **差异恰好是新增两行**：`tests/boundary-degraded-failclosed.mjs` **57** 项（`[OK  ]`）
> ＋ `tests/whiteout-candidate-capture.mjs` **29 ✓**（1948 ＋ 57 ＋ 29 = 2034），其余 23 个套件逐项不变。
> 封印同步刷新为 **99 条**（原 96 ＋ `dsh-plugin/baseline-watch.mjs` ＋ 本轮两个新套件）。
> 下方引用块保留的是**同一批套件在 C3 时点**的说明与历史口径，供对照，其数字已被本块取代。

> **历史口径（C3 时点 `.t/policy-verify3.txt`，21 套件 / 1900）**：全部来自**收尾轮（F1–F4）之后的那一次全量复跑**
> `cmd /c "verify.cmd > .t\policy-verify3.txt 2>&1"`（`[实测]` 本机本会话、DSH 文件策略
> **danger-full-access**；**exit 0**、`RESULT: ALL PASS`；**21/21 套件全绿、0 条红断言**，
> 标记计数 **1900**）。
> 计数方式与下表逐行口径一致：21 个套件块共 **1872** 个 `✓` 标记，
> 加上 `tests/probe-selfkill-guard.mjs` 用 ASCII 标记（`[OK  ]`）自报的 **28** 项。
> 与上一份权威日志 `.t/policy-verify2.txt` 相比，**只有 `tests/limits.mjs` 一行按设计变化 187 → 188**
> （收尾轮 F1 新增 §4p3：双盲 `fsImpl`（`lstat` ＋ `readdir`/`Dirent` 都看不见链接）＋ `guard: ()=>false`，
> 给"guard 只能加严、不能削弱"这条硬不变式补上本机**活的失败路径**；变异体
> `shouldNotFollow = guard ? guardSaysLink : escaped` 下该断言唯一见红），其余 20 个套件逐项不变。
> `[实测]` 上一份日志 `.t/policy-verify.txt` 里那 2 套件 / 3 条红断言**已修**，根因是
> **junction 的 `lstatSync` 形态随 DSH 文件策略变化**（同一台机器：`workspace-write` ⇒
> `mode=0x41b6 / isSymbolicLink()=false / isDirectory()=true`；`danger-full-access` ⇒
> `mode=0xa1b6 / isSymbolicLink()=true / isDirectory()=false`），而旧断言把其中一种形态
> 写成了 `[实测]` 基线（**钉宿主事实**，不是钉不变量）。改法（只动这三个文件 + 文档）：
> `tests/limits.mjs` §4x/§4ab 接受 `already-visited-cycle` **或** `reparse-point-not-followed`，
> 并把"**没有任何真实目录被展开超过一次**"做成注入 `fsImpl` 的 `readdirSync` 计数断言，
> 另加 §4p2 用"盲 lstat"在**两种形态下**钉住"树外 junction 一个字节都不计"；
> `tests/workspace-regressions.mjs` 改为**行为分流**（先测本机 `lstat` 形态，再断言对应的安全结局）；
> `src/limits.mjs` **只改注释**（记录两种形态与"该策略下 in-tree junction 完全不展开"的残留，
> 逻辑 / 导出 API / 默认值一字未动）。
> 历史口径对照：上一轮全量复跑 `.t/r4-verify.txt`（20 套件 / **1863** 断言 / `RESULT: ALL PASS`）；
> 更早的 `.t/v3-final-verify.txt`（20 套件 / 1851）等已在下方合计行注明。

| 套件 | 断言数（`.t/finish-verify.txt` 那一次运行） | 变化 |
|---|---|---|
| `tests/selftest.mjs` | 51 | 历史口径（第一轮 51 → 不变） |
| `tests/e2e-flow.mjs` | 21 | 历史口径（16 → 21） |
| `tests/struct-layout.mjs` | 24 | 历史口径 |
| `tests/appcontainer-layout.mjs` | 34 | 历史口径（27 → 34，`--plant` 6 条红） |
| `tests/resolve-exec.mjs` | 19 | 历史口径 |
| `tests/executor-stub.mjs` | **143** | 历史口径写 84；上一轮实测 143（D11 红/绿双档），本轮不变 |
| `tests/audit-parse.mjs` | 43 | 历史口径（23 → 43） |
| `tests/paths-masks.mjs` | **58** | 历史口径写 37；上一轮实测 58，本轮不变 |
| `tests/registry-guard.mjs` | **378** | 历史口径写 125；FIX-C 补登记后 378，本轮不变 |
| `tests/workspace-regressions.mjs` | **17** | 历史口径写 10 → 上一轮 16 → 本轮 **17**（全绿）。`[实测]` 上一份日志里那 1 条「旧判据必然失效（junction `lstat.isSymbolicLink()=false`）」**已删**：它钉的是**宿主 / 文件策略相关**的 lstat 形态（本轮 `danger-full-access` 下 junction 的 `isSymbolicLink()=true`）。改为"**先测本机形态、再断言对应的安全结局**"（重解析点绝不进快照 / 树外内容永不被读 / `mode & 0x400` 在两种形态下都恒为假），原始观测保留在注释里并**明确标注为策略相关、非普适** |
| `tests/meta-runner.mjs` | 4 | 历史口径 |
| `tests/appcontainer-runtime.mjs` | **178**（`--plant` 6 红） | 历史口径写 140；上一轮实测 178，本轮不变 |
| `tests/probe-selfkill-guard.mjs` | **28** | 输出刻意用 ASCII 标记（`[OK  ]`），`countChecks` 计到 0，判定严格来自退出码（`src/testrunner.mjs:45-52`）。上一轮记 27，本轮自报 28 |
| `tests/netpolicy.mjs` | **164**（`--plant` 40 红） | **第三轮新增**：网络策略（WFP 档位解析 / fail-closed / 安装后回读校验 / **D2 证据来源校验**），离线替身绑定表；**第四轮加固**：R3-1 计划指纹覆盖 `guids`、R3-2 拆除走安装时定住的引擎凭据 |
| `tests/mitigations.mjs` | **160** | **第三轮新增**：进程缓解策略（ACG/CIG/禁 Win32k/禁扩展点），离线替身 |
| `tests/limits.mjs` | **192** | **第三轮新增**：资源上限（暂存配额 / 输出上限 / 重解析点不越界 / **D1 目录环检测**）。本轮口径 **192**（上一份权威日志 `.t/policy-verify3.txt` 为 **188**）：两者都是该套件**自报**的数字（`RESULT: PASS (assertions=…)`），差 4 项来自**并行改动**（本任务未改该文件）。此前一行（C3 时点）记 188 全绿：`4x` 接受两种**安全**处置（`already-visited-cycle` / `reparse-point-not-followed`），`4x2`/`4ab3` 用注入 `fsImpl` 数 `readdirSync` 断言"**没有任何真实目录被展开超过一次**"（这是真正能抓住"环检测失效 / 无界重扫"的那一条），`4ab` 去掉固定的 `cycles=2`，`4ab4` 补互指树的配额判定，`4p2` 用"盲 lstat"在两种形态下钉住树外 1 MiB 不计数（`--plant` 下反向断言钩子的破坏力，避免本机 `followReparsePoints` 失效导致变异覆盖变空）；**收尾轮再加 `4p3`**（**双盲** lstat/Dirent ＋ `guard: ()=>false`：断言外部 1 MiB 不进账、`outside` 从未被 `readdir`；`--plant` 反向断言，变异体下唯一见红），187 → **188** |
| `tests/integration-wiring.mjs` | **144** | **第三轮新增**：接线验收（新模块必须真的被运行期调用）。文件已落盘，见下方声明 |
| `tests/wfp-layout.mjs` | **146** | **本轮补登记**：该文件早于本轮存在，但 `verify.cmd` 与 `OFFLINE_SUITES` **两处都没有**（与 `registry-guard` 同族的"改坏了没人知道"） |
| `tests/suite-wiring.mjs` | **28**（`--plant` 29——多出的是那条元断言） | **第三轮新增治理套件**：`verify.cmd` = `OFFLINE_SUITES` = 磁盘文件；未登记文件必须显式列名。**注意口径：正常模式 28，不是 29** |
| `tests/residual-baseline.mjs` | **43**（`--plant` 5 红） | **第三轮新增治理套件**：R1–R12 基线 + `guaranteesNotProvided` 声明面 + netpolicy fail-closed 不变量 |
| `tests/policy-never-consistency.mjs` | **29 ✓**（0 失败 / 另有 **1 SKIP** ＝ 30 用例；`--plant` 30 检查 / 12 红） | **C3 新增守门套件**：活动 profile 的显式 `defaultPreset` —— 这是**条件性**硬断裂，**不是**无条件因果：只有当**装配期** `derive(EMPTY_KNOBS)` 组合出"无任何预设匹配"的 `custom` 时，`permission` 行才会在构造期抛错、composer 访问模式控件**整块消失**；该条件需要**部署级机制**（`DSH_PERMISSION_MODE` 在装配时被设成与 profile 预设不匹配的值，即分析文档 §4.4 的"机制 B"：`dsh-base\cordis.patch.yml` 用 `DSH_PERMISSION_MODE ?? 'workspace-write'` 同时决定 `sandboxPolicy.defaultMode` 与审批 `policy`）**加上**一个没有显式 `defaultPreset` 的 profile。**本会话不成立**：`DSH_PERMISSION_MODE` 未设 ⇒ 组合为 `workspace-write ＋ ask`，与 profile 的 `workspace-write` 预设匹配 ⇒ 本会话即便删掉 `defaultPreset` 也不会抛。因此这是**源码推导的 `[推断]`**（§4.4 读码），**未在真实装配中复现**（V1 待办）；防它回归仍由本套件负责——一旦有人删掉 profile 的 `defaultPreset`、或把 WinStage shell 半边改成报更宽档，测试立刻红。其余检查：`sandboxMode` 恒报最窄档、槽位接管与审批策略无关、WinStage 审批不经过 `ctx.approval`、`audit-mirror` 不编造 `decided`、文档不得再称 `sandboxMode` 报 `undefined` |
| `tests/baseline-integrity.mjs` | **14**（`--plant` 19 项 / 5 红） | **本轮新增（源码封印）**：受封印文件（`src/*.mjs`、`tests/*.mjs`、`dsh-plugin/*.mjs`、`tools/*.mjs` ＋ 四个根入口）逐条哈希必须等于 `docs/源码基线.sha256`；四种损坏（内容变化 / 清单缺失 / 僵尸行 / 格式非法）分别点名，并打印刷新指令。动机：本仓曾把 `tests/` 整目录忽略、`tools/` 与 `src/limits.mjs` 等源码留在版本库之外 ⇒ "只改了注释、行为一字未动"此前**没有基线可比**（整理轮已把收录面全部入库；封印继续钉住**内容**与**覆盖面**两件事）。清单缺失 / 不可读 / 为空**默认判红**（fail-closed：`RESULT: FAIL manifest-unsealed`、退出码 1、打印修复指令；只有显式 `WINSTAGE_ALLOW_UNSEALED=1` / `--allow-unsealed` 才 SKIP）—— 删掉清单不再能让封印静默失效。见 §11 |
| `tests/dsh-patch-guard.mjs` | **30**（`--plant` 33 项 / 4 红） | **本轮新增（补丁守门）**：DSH 是 **npx 缓存安装树** ⇒ 手工补丁会在重装/升级后**无声消失**。判据一句话：受补丁文件的现场哈希必须**恰好等于 `before`（未打）或 `after`（已打）**，第三个数即漂移、即红灯（打印"harness drifted — re-validate the patch"＋文件＋期望＋实际）。另含**离线**清单自洽性（原样副本哈希、`before` 锚点唯一性、可复算的 `afterSha256`），以及在**临时副本**上跑通 `--apply`/`--revert` 的六条行为（写入结果 / 备份 / 幂等 / 从备份回滚 / 从原样副本回落 / **漂移必须拒绝**）——`--apply` 本身在本任务期间被禁止对 harness 根执行，因此它的正确性是这样被钉住的。定位不到 harness 时**如实 SKIP**（不是 PASS）。见 §10 |
| **`verify.cmd` 合计** | **2034**（25 套件；1949 `✓` ＋ 85 `[OK  ]`；**0 套件红 / 0 条断言红**，`RESULT: ALL PASS`） | 上一份权威口径 `.t/patchkit-verify.txt` 为 **1948**（23 套件 / 1920 `✓` ＋ 28 `[OK  ]`）；本轮 **+86** = 新增两行（`boundary-degraded-failclosed` 57 `[OK  ]` ＋ `whiteout-candidate-capture` 29 `✓`），其余逐项不变。旧行"11 套件 / 452 断言"是**第二轮时点口径，已作废**；再上一行口径（`.t/policy-verify.txt`，1890 / 2 套件红 / 3 条断言红）描述的是 junction `lstat` 形态随文件策略变化的**测量层脆性**，已按上方口径说明修掉；上一轮 `.t/r4-verify.txt` 为 **20 套件 / 1863 / ALL PASS**；"1819"/"1838"/"1851" 是更早的独立验证/加固前后口径，均已作废 |
| `tests/boundary-degraded-failclosed.mjs` | **57**（ASCII `[OK  ]`；`--plant` 8 红） | **缺陷③轮新增（已由该轮修复者登记，本轮 finisher 未重复登记、未绕过）**：T0 污染 ⇒ T1 静默降级必须 fail-closed（typed error `STAGING_WRITE_UNVERIFIED` ＋ 命令不 spawn），以及 `init` 侧陈旧 AppContainer 包 SID ACE 的检测与修复。A 段纯离线；B 段注入一条临时 ACE、跑完必删 |
| `tests/whiteout-candidate-capture.mjs` | **29 ✓** | **缺陷①b轮新增（finisher 本轮提升登记）**：白障标记必须变成**真实路径的删除候选**（不得出现 `wo\…` 伪 create），从未暂存过的真实文件被删时**恰好一条**候选，`apply` 真的删掉被批准的真实文件；UNC 不可归因标记如实记入 `skipped`。由 `.t\shim-delete\test-whiteout-capture.mjs` **原样提升**（只改路径根/临时目录/标记字形），零 shim 依赖 |

> **断言数口径（诚实声明）**：上表是**一次真实全量复跑**的逐套件标记计数（`✓` 与 `[OK  ]`，
> 与被测套件自报数字逐一对上），**不是凭印象补的**。若要复核：跑
> `cmd /c "verify.cmd > .t\finish-verify.txt 2>&1"` → 末尾应为 `RESULT: ALL PASS`（本轮 `exit 0`），
> 再按 `=== tests\X.mjs ===` 分块数标记即可复现上表（上一份权威日志 `.t/patchkit-verify.txt`
> 为 23 套件 / 1948 口径，差别只有新增 `boundary-degraded-failclosed` 57 ＋ `whiteout-candidate-capture` 29；
> 更早的 `.t/policy-verify.txt` 是"测量层脆性"修复**之前**的那次运行，末尾为 `FAIL`，只作对照保留）。

> **`tests/integration-wiring.mjs` 的状态（已落盘，不再是缺口）**：该文件**已存在**并在 `verify.cmd` 内跑绿
> （`RESULT: PASS checks=144 failures=0 mode=normal`），`OFFLINE_SUITES` 与 `verify.cmd` 两处都有登记。
> 第三轮交付时它由并行 agent 创建、当时确实尚未落盘；**现在已落盘**。
> `tests/suite-wiring.mjs` 里那张 `PENDING_REGISTRATIONS` 豁免表**已经删除**（该文件头部注释写明"曾经有"）——
> 现在"已登记但磁盘上不存在"是**硬失败**，没有豁免通道。下方 §9.4 的旧"待落盘"注记同步作废。

`autotest.cmd --skip-audit`（离线 25 套 + 沙箱 4 套）：

| 项 | 数 | 备注 |
|---|---|---|
| 离线套件 | **25**（清单见上，与 `verify.cmd` 同源） | `OFFLINE_SUITES` |
| `tests/diag-bindings.mjs` | **14 `✓` ＋ 1 SKIP**（`[实测]` 收尾轮复跑，exit 0；`.t\closelow-diag.txt`） | 需未受限会话；`init()` 段按机制边界 SKIP（`SANDBOX_UNAVAILABLE: stagingRoot is required`）。**旧行"22（历史）"是历史口径、与现状不符**：独立复核 §6 第 2 条指出该行容易被读成现状，已按本轮真实复跑更正 |
| `tests/file-cow-dispositions.mjs` | **19/19**（`[实测]` 本轮） | 需未受限会话（T6 接线：文件 CoW/创建处置矩阵）；c7b 已由 ①b 提升为严格断言 |
| `tests/registry-unstaged-wow64.mjs` | **36 / 0**（`[实测]` 本轮） | 需未受限会话（T6 接线：注册表 WOW64 透传 + UNSTAGED） |
| `tests/delete-capture.mjs` | **35 项断言**（`[实测]` 收尾轮**连续 3 次**均为 `RESULT: PASS (35 checks)`、exit 0；`candidate byOp={"delete":10,"create":12} delete=10 bogusWoCreates=0`；`.t\closelow-dc-run1..3.txt`） | 需未受限会话 + `shim\out\winstage-shim.dll`（缺陷①回归：TS 档四种删除写法 + 孙进程注入 + move/ren + 负面对照）。**稳定性口径（据独立复核 §6 第 1 条修正，不再写"无条件 35/35"）**：PowerShell 载体在本机偶发**启动即失败**（CLR 加载器 `System.Data.dll`、HRESULT `0x8007054F`），会让 PowerShell 依赖项（`write-staged:R1-ps`、`whiteout:V3-*`）偶发红；本套件先做**一次有界重试**，若仍失败且命中该加载器签名、且真实盘未被改动、且未出现 PowerShell 成功标记，则记**响亮 SKIP 的确切原因**（退出码 0、不计失败）；**真实捕获失败一律仍 FAIL**：文件被写穿 / 真实文件被删 / 白障缺失（`.t\closelow-selftest\A.txt` 为 SKIP 形态、`B.txt`/`C.txt` 为"有签名但写穿 / 有标记"仍 FAIL 的反向验证） |
| **合计** | **离线 2034 标记 / 0 红**（`[实测]` 收尾轮 `.t\closelow-verify.txt`，见 §8.2 下方口径）；**沙箱 4 套：`delete-capture` 连续 3 次 PASS (35) / `diag-bindings` 14 `✓` ＋ 1 SKIP / `file-cow-dispositions` 19/19 / `registry-unstaged-wow64` 36/0**（`[实测]` 收尾轮） | 上一轮写成"沙箱 4 套全绿"**过于绝对**（独立复核 §6 第 1 条）：`delete-capture` 的 PowerShell 依赖项在本机可能因宿主/CLR 加载器偶发启动失败而**响亮 SKIP**（有界重试后仍失败、且真实盘未被改动时；退出码 0、不计失败），`diag-bindings` 的 `init()` 段按机制边界 SKIP。**SKIP ≠ 静默通过**，真实捕获失败仍为红。旧行"474 ok / 0 bad（12 套件）"是第二轮口径，**已作废** |

插件侧与辅助套件（离线，不依赖 Win32 沙箱）：

| 套件 | 断言数 | 备注 |
|---|---|---|
| `.t/review-selftest.mjs` | 26 / 0 | 第二轮复跑 |
| `.t/staging-fs-selftest.mjs` | 31 / 0 | 第二轮复跑 |
| `.t/command-selftest.mjs` | **24** / 0 | 第二轮复跑（§7 旧文写 22） |
| `.t/sbx3/browser/fixd_selftest.mjs` | **48** / 0 | 第二轮新增（D1/D2 宿主半） |
| `.t/sbx3/browser/fixd_client_selftest.mjs` | 25 / 0 | 第二轮新增（客户端半） |
| `.t/sbx3/browser/fixd_forecast.mjs` | 11 / 0 | 第二轮新增（真实 fixture 不变式 + 预报） |
| `.t/default-on-selftest.mjs` | **11 PASS / 1 FAIL(L5b) / 2 PENDING-LIVE-FLIP**（本轮 C2 实测，exit 1） | 「默认开启沙箱」五层默认值 + 活动 profile 装配（见 docs/DSH集成.md §20.3）。**旧文写 13/0 是过期口径**：L5b 报"没找到'只认显式 false'的判据"，L6b/L6e 因 live profile 仍为 `enabled: false` 记为 PENDING-LIVE-FLIP；三者均与本轮审批策略变化无关，且 `dsh-plugin/client.js` 不在本轮授权改动范围内 |
| `tests/appcontainer-runtime.mjs` | **178** / 0（`--plant` 6 红） | ✅ **已接入 `verify.cmd` / `OFFLINE_SUITES`**；旧行 ⚠️"尚未接入…属已知缺口"**已作废**（见上表） |

未登记但与注册表并列在案的套件文件（`tests/suite-wiring.mjs` 的 `KNOWN_UNREGISTERED` 显式列名，各带理由）：
`tests/acceptance-transparent.mjs`（Lead 侧验收台，须"沙箱已开启"会话手动跑）、
`tests/registry-apply-e2e.mjs`（写真实 HKCU，文件头明确不许进 verify）、
`tests/registry-conformance.mjs`（断言对象是真实 DLL/WAL 产物，缺产物时整段 SKIP）、
`tests/registry-stage.mjs`（断言已由 `registry-guard` 在既有关口内覆盖）、
以及 `tests/dsh2-*.mjs` 7 个第二轮一次性诊断脚本（结论已归档 `docs/dsh2-*.md`）。
**这张名单是诚实逃生口**：一个文件从注册表里悄悄消失、又没进这个名单，`suite-wiring` 会判红。

> 口径说明（历史）：FIX-C 当时报的 `verify.cmd` **11 套件 / 448 断言**是其**时点口径**
> （那时 `appcontainer-layout` 还是 30 条）；最终一次全量回归（`verify-final.txt`，晚于那一轮全部代码改动）
> 是 **11 套件 / 452 断言 / 0 失败**。两者不矛盾；它们是**第二轮**口径，第三轮清单见上表。

### 8.3 第二轮仍未提供的保证（必须与任何"通过"一起读）

- **T0 默认未启用（不是"未接线"）**：T0 已接进执行器，但默认档位是 `T1`（`src/executor.mjs:1304`），
  只有显式 `tier:'T0'` 才走 AppContainer 启动分支；`selectTier()` 的 T0 闸门仍要求
  `report.appContainerIsolation?.proven === true`（`src/capability.mjs:1436`）。因此"能生效"≠"默认在用"。
- **T0 读面未收敛**：实测仍可读 `C:\Windows\win.ini`（**R1** 残余）。
- **WFP 未装过滤器**（第三轮补：结构/策略层现已存在且 OFFLINE 档位 fail-closed，真实安装仍 `[未实测]` —— 见 §9.1）、**注册表 ACL 未启用**（沙箱内 `reg add` 的 `Access is denied` 来自受限令牌/ACL 的既有约束，这一轮未新增注册表策略）。
- **R2 网络面未收敛**：沙箱内可开 socket。
- **`drainPipe` 吞吐**：固定 1 ms 轮询 ⇒ ~77 KB/s（**库侧，未修**）。
- **S1 二级未定论**：创建阶段 `Access is denied` 与用户态 `0xC0000142` **是否同因**，保持未定论。
- **D1/D2 的浏览器侧回归 `[未实测]`**：3085 重启后 HTTP 未监听（`START-EXIT 1`、supervisor ~2 s 判死、`sbx3.out/err.log` **0 字节**），**与插件改动无关**（同一轮 `DUMP-CONFIG-PASS` 通过、插件成功发布了新格式快照）。离线替代证据：`fixd_selftest 48/48`、`fixd_client_selftest 25/25`、`fixd_forecast 11/11`、`s3_suite --dry-run 5/5`（目录 52 = 代码 52）。
- **遮蔽规则仍是黑名单**：改名 / 换扩展名 / 换目录形状即绕过；非 AppData 的 Mozilla `key4.db` / `logins.json` **未覆盖**；**遮蔽 ≠ 拒绝**。

> **`autotest.mjs --skip-audit` 在受限会话里的 2 个失败（如实记录，不是本轮的回归）**：
> `node autotest.mjs --skip-audit` 会先跑全部离线套件（本节记录写于 **21 套件**时点；当前 **25 套件**的复跑口径见 §8.2：
> **25 绿 / 0 红**，`.t/finish-verify.txt`；当时的 21 绿 / 0 红见
> `.t/policy-verify3.txt`；此前 `.t/policy-verify.txt` 的 2 套件 / 3 条红断言是 junction `lstat`
> 形态随 DSH 文件策略变化的**测量层脆性**，已修 —— 与本节记录的两个沙箱段失败**不是同一件事**），
> 再跑 `SANDBOX_SUITES`（当前 **4 个**需要**未受限会话**的套件；本节记录时点为 3 个）。在本会话（workspace-write 受限）里
> 独立验证记录到 **2 个失败**（`.t/verif-autotest.txt`；本轮未复跑该入口）：
> ① `registry-unstaged-wow64`（30 ok / 6 bad）—— 首条失败是**前置条件**"真实 hive 里先建好这个键
> （用未注入的 `reg.exe`）"，其后 5 条是级联；② `file-cow-dispositions`（`FAILED (15/18)`）——
> 套件**自己**把两条标成 `GAP`（`c6cmd-canary`：cmd.exe 的 `if exist` 看真实文件系统、不看覆盖层；
> `c7b`：node `fs.unlinkSync` 返回成功但真实文件仍可读、无 whiteout）。
> 判定：这两项是**会话受限导致的沙箱段失败**与**既有的 shim 覆盖层 GAP**，
> **不是本轮 D1/D2 修复（以及三个新模块）的回归**；要彻底定性必须在**未受限会话**里复跑。
> 顶层退出码没有被吞（`autotest.mjs:125` 的 `overall === 'FAIL' ? 1 : 0`）。

---

## 9. 第三轮新增能力（网络策略 / 进程缓解 / 资源上限）

三块新能力共用同一条纪律：**先把判定与失败形态离线钉死，再谈运行期生效；真实生效一律标 `[未实测]`**。
差距来源：[docs/NeoAI-沙箱能力分析与差距输入.md](docs/NeoAI-沙箱能力分析与差距输入.md)（NeoAI 残余是"裸 TCP 绕过应用层代理"，
§5.3 要求 Windows 侧用 WFP 做**内核层**出站过滤）与
[docs/WinStageSandbox-能力清单与差距基线.md](docs/WinStageSandbox-能力清单与差距基线.md) §2（网络面、暂存配额、输出上限均为 ABSENT）。

### 9.1 网络策略：fail-closed 契约（`src/netpolicy.mjs` + `src/wfp.mjs`）

- **四态互斥**：`enforced` / `not-enforced` / `refused` / `not-implemented`，不允许第五种含混表述。
- `enforced:true` **当且仅当**"过滤器确实装上（数量 = 计划数量）**且**回读核对通过"。
  绑定表不提供回读入口时返回 `enforced:true` 但 `verified:false`，理由写明 `enumeration-unavailable`
  —— **不得读成"已核对"**。
- OFFLINE 任一前置缺失（绑定表 / `pin` 回调 / 可用性探测 / 引擎打不开 / GUID 缺失）⇒ `refused`，
  **绝不**谎报已阻断；判定顺序是确定性的、可逐条钉死。
- 非 OFFLINE 档位（`CONTROLLED_ONLINE` / `OBSERVED_ONLINE`）⇒ `not-implemented`：**不作阻断声明**，
  因此仍允许执行，但绝不 `enforced:true`；未知档位直接抛 `NETWORK_TIER_INVALID`（不把未知当成"不阻断"）。
- 安装中途失败 ⇒ **同一路径**内 best-effort 拆除（删 filter → 删 sublayer → 关引擎，DYNAMIC 会话兜底），
  拆除自身失败一并上报，绝不掩盖原错误。
- **安装证据必须来源可信（第三轮缺陷 D2 的修复）**：`resolveNetworkPolicy()` 只采信
  `installNetworkPolicy()` 亲自产出的对象（模块私有 `WeakMap` + 私有品牌符号，且必须与本绑定表/
  本计划同源，`teardown()` 之后作废），调用方自造或转发的 `{ installed: [...] }`（含伪造的
  `{ verified: true }`）一律降级成 `state:'not-enforced'` / `enforced:false`。
  `[实测]` 修复前的 fail-open 由**独立验证会话**在本机实测（离线替身；原始记录
  `docs/NeoAI-差距补齐-实施与验证报告.md` §2.1 A5 / §3 D2）：`capabilityDimensions({networkTier:'OFFLINE', …
  networkInstall:{installed:[6 条]}, networkAudit:{verified:true}})` 能报 `enforced:true` 而底层
  `FwpmFilterAdd0` **调用 0 次**；`[实测]` **本轮修复会话**复跑同一攻击形状（同机同替身表）⇒
  `state:'not-enforced'` / `enforced:false` / `verified:false`，`FwpmFilterAdd0` 仍为 0 次，
  而真实 `installNetworkPolicy()` 产物 + 回读通过仍能到 `enforced:true`。判定力由 `tests/netpolicy.mjs`
  的 2g–2l 与 `tests/residual-baseline.mjs` 的 C3b/C3c 钉死。
- **计划指纹覆盖 GUID 值（第四轮 R3-1 加固）**：指纹的输入除计划结构（tier/target/subLayerKey/每条规则
  的 key/层/条件键/匹配类型/动作/描述）外，还包含该计划**真正会写进 BFE 的 `guids`** —— 每条规则的
  ALE 层 GUID、条件 GUID（`ALE_PACKAGE_ID`/`ALE_APP_ID`）与 `guids.targetValue`。因此同一份真安装证据
  换 GUID 复判 ⇒ `plan-mismatch` / `enforced:false`（旧实现能给它背书）；同一份 `guids` 复判仍
  `enforced:true`/`verified:true`（`tests/netpolicy.mjs` 的 2q/2r 钉死）。
- **拆除不读可变的 `result.engine`（第四轮 R3-2 加固）**：`teardown()` 通过**安装时**捕获并
  `Object.freeze` 的引擎凭据（句柄快照 + `bind` 后的关闭函数）删除过滤器 / sublayer 并关引擎。
  改写 `result.engine.close`、置空 `result.engine.handle` 或整体替换 `result.engine` 都伪造不出
  `engineClosed:true`；关闭真失败时 `failures` 如实点名（`tests/netpolicy.mjs` 的 2s/2t 钉死）。
  `engine-missing` / `evidence-torn-down` 的降级语义不变。
- 离线证据：`tests/netpolicy.mjs`（替身绑定表钉死五条不变量）、`tests/wfp-layout.mjs`（合成缓冲区钉死布局）、
  `tests/residual-baseline.mjs`（把上面几条变成本套件的**基线断言**，任一漂移即报警）。
- **`[未实测]`**：本机**没有安装过任何真实 WFP 过滤器**（安装是系统级状态变更，本阶段未获授权），
  真实 BFE 行为与端到端阻断均未实测 ⇒ 残余边界 **R2 依旧成立：沙箱内实际仍可开 socket**。

### 9.2 进程缓解策略：seccomp 等价物（`src/mitigations.mjs`）

- 覆盖 **ACG**（任意代码禁止）、**CIG**（强制代码完整性）、**禁 Win32k 系统调用**、**禁扩展点注入**，
  以及 **`untrusted`（不可信代码）**档位；属性号/位号/参数构造由 `tests/mitigations.mjs` 用记录型假 binding
  离线钉死（位号写错、失败被当成成功都会判红）。
- ⚠ **`untrusted` 是 opt-in，且会打断 JIT**：该档位面向"不可信代码"，对 Node/V8 这类**运行期生成代码**的进程
  会导致 JIT 失败甚至根本起不来。因此**默认档位不含它**；只有明确的不可信负载才可选，选了就要接受
  "目标程序可能起不来"这一代价。这条必须写在策略旁边，不能只写在测试里。
- **`[未实测]`**：真实 `UpdateProcThreadAttribute` 上的缓解组合**从未在本机运行期实测**
  （离线替身刻意不创建进程、不需要管理员）。§5.1 的 `[实测]` 只覆盖 AppContainer 隔离本身，**不覆盖缓解策略这一层**。

### 9.3 资源上限：暂存配额 / 输出上限（`src/limits.mjs`）

- **暂存配额**：写入**之前**先判定（有界遍历 + 配额比较），拒绝时**显式**报错，不产生"看起来写成功"的假象。
- **输出上限**：字节/行截断必须**显式可机检**（`byteTruncated` / `lineTruncated`），且截断后不得吐出半个码点；
  `parseSize` 遇无单位输入必须拒绝，不许 `NaN` 漏出去。
- **重解析点不越界**：判据以父目录 `readdirSync(..., { withFileTypes: true })` 的 `Dirent.isSymbolicLink()`
  外加 `realpathSync.native` 解根校验为准 —— `[实测]` 本机 node v24.21.0 下 junction 的 lstat 字段
  **随 DSH 文件策略变化**：`workspace-write` 会话里 `lstat().isSymbolicLink() === false`、
  `mode=0x41b6`；`danger-full-access` 会话里 `isSymbolicLink() === true`、`mode=0xa1b6`。
  **两种形态下 `mode & 0x400` 都是 0**（`Stats.mode` 是 POSIX 位、不携带 Win32 重解析属性），
  所以"不跟随"必须建立在 dirent + 结构性出树校验上，而不是 `mode & 0x400`
  （两种形态各有一条证据：真实形态 §4a/§4p、模拟盲形态 §4p2）。
- **树内目录环不再拖垮统计（第三轮缺陷 D1 的修复）**：`measureTree` 现在维护"已展开真实目录"集合，
  **每个真实目录只展开一次**。`[实测]` 两种文件策略下"没跟随"的 reason 不同、但**都安全**：
  `workspace-write` 形态记 `skipped{reason:'already-visited-cycle'}`；
  `danger-full-access` 形态（lstat 看得见 junction）更早就在"非目录链接"分支被拒，记
  `skipped{reason:'reparse-point-not-followed'}` ⇒ **该策略下任何 in-tree junction 都不会被展开**
  （内容仍可经真实路径到达、树外目标从不计数 ⇒ 安全，但**覆盖面变小**，已列为残留）。
  因此 `tests/limits.mjs` §4v–4ab 断言的是**不变量**（终止 / 有界 / 不截断 /
  **没有任何真实目录被展开超过一次** / 配额判定可用 / guard 只能加严），**不钉具体 reason**。
  `[实测]`（本机 node v24.21.0，1 字节文件 + 一个自指 junction）：
  修复前生产默认 `maxEntries=200000` 下单次 `measureTree` **22033 ms**、`entries=200000`、
  `truncated=true`、`checkStagingQuota.complete=false`（⇒ `Store.putBlob` /
  `executor.assertStagingQuota` 抛 `STAGING_QUOTA_MEASUREMENT_INCOMPLETE`，该工作区永久写不进暂存）；
  修复后 **1.6 ms**、`entries=3`、`truncated=false`、`complete=true`
  （本轮 `danger-full-access` 形态复跑同值，`.t/ml-fix-normal.txt`；该形态下 reason 是
  `reparse-point-not-followed`、`readdir` 只被调用 1 次）。
  这条环检测**只加严**：树外 junction 依旧不跟随、guard 依旧只能加严（`tests/limits.mjs` §4v–4ab；
   收尾轮另加 §4p3：双盲 `fsImpl` ＋ `guard: ()=>false`，给"guard 只能加严"补上本机**活的失败路径**）。
- **`[未实测]`**：配额守卫**尚未被证明**能在一次真实写入路径上真正拒绝落盘；输出上限也未在真实 `spawn`
  捕获链路上端到端复跑。因此 `summarise().guaranteesNotProvided` 如实保留这一条。

### 9.4 治理：把"缺口"变成断言（第三轮）

- `tests/suite-wiring.mjs`（**28 项** / `--plant` 29 项、7 红）：`verify.cmd` 循环列表 == `OFFLINE_SUITES`
  （**逐项、同序、同数**）、`tests/*.mjs` 必须"已登记"或在 `KNOWN_UNREGISTERED` 里显式列名并给出理由、
  已登记脚本必须在磁盘上、全部 `.cmd` 必须纯 ASCII（R11）。
  **一个文件从注册表里悄悄消失 = 判红** —— 这正是本项目反复出现的缺陷形态。
  ⚠ 口径：正常模式 **28** 项；**29** 是 `--plant` 模式（多出那条"失败项 ≥3"的元断言），
  旧文把 29 当正常口径是错的。`PENDING_REGISTRATIONS` 豁免表**已被删除**，
  "已登记但磁盘上不存在"现在是**硬失败**，没有豁免通道。
- `tests/residual-baseline.mjs`（**43 项** / `--plant` 5 红）：`docs/Windows功能开启清单.md` §13 的 **R1–R12 逐条仍在**、
  `guaranteesNotProvided` 仍含读取面 R1 行与网络/缓解的 `[未实测]` 行、且**不再**沿用旧的笼统
  "网络硬阻断（受限令牌与 ACL 均不涉及网络…）"说法；同时用离线替身**真的调用** `src/netpolicy.mjs`，
  钉死"非 OFFLINE 档位永不 `enforced:true`""`refused` 永不携带 `enforced:true`"等诚实比较不变量，
  并含一条**正例**（真实 `installNetworkPolicy()` 产物 + 回读通过 ⇒ `enforced:true`）证明这些不是恒假的空断言，
  以及 D2 回归（自造证据 / 展开拷贝 / `teardown()` 之后 ⇒ 一律 `enforced:false`）。
- 两个套件的 `--plant` 都证明"判定真的能红"；§8.2 的权威表数字即 finisher 本轮全量复跑（`.t/finish-verify.txt`，
  25 套件 / 2034 标记 / `RESULT: ALL PASS`）的口径（更早的 `.t/patchkit-verify.txt` 为 23 套件 / 1948，
  C3 时点的口径见 `.t/policy-verify3.txt`）。
- ✅ **`tests/integration-wiring.mjs` 已落盘**（不再是缺口）：文件存在、`verify.cmd` 内跑绿
  （`RESULT: PASS checks=144 failures=0 mode=normal`），`OFFLINE_SUITES` 与 `verify.cmd` 两处都有登记；
  `tests/suite-wiring.mjs` 的 `PENDING_REGISTRATIONS` 豁免表已删除。第三轮交付时"该文件仍不存在"的旧说法**已作废**。

---

## 10. DSH 补丁工具包（`patches/dsh/`）：**默认不应用**

动机：本机 DSH 是 **npx 缓存安装树**（`<root>\node_modules\@deepseek-ai\...`），只有编译产物
`lib/*.js`，**没有源码、没有构建工具**。手工改它的三个必然结局是：**不持久**（重装/升级/清缓存后
无声消失）、**会错位**（上游升级后行号与文案全变）、**不可证伪**（没人说得出现在到底打没打）。
因此三处修复被做成"**机器可读清单 → 可重放工具 → 会红的守门测试**"三段式。

| 补丁 | 打到哪 | 一句话 | 证据状态 |
|---|---|---|---|
| **P1** H1 | `…\dsh-sandbox\lib\index.js`（`case "rejected"`，`:118`） | `approval:never` 时 `dsh-user-approval` **没问过用户**就直接返回 `rejected`（`lib/index.js:175`），而 `dsh-sandbox` 把每个 `rejected` 都渲染成"**用户拒绝了**"。改法：该分支先问策略（`approval.approver.effectivePolicy?.(…)`，try/catch 包住 ⇒ 计算 message 绝不抛），为 `never` 时抛 `error.code='ESCALATION_POLICY_DENIED'` 的**不甩锅**错误，其余原文案不变。一处改动覆盖 **6 个调用家族**（`[实测]` grep：`dsh-tool-bash:364`、`dsh-tool-fs:1128`、`dsh-tool-pwsh:335`、`dsh-tools:1194`、`dsh-tools/lib/types/ptc:308`、`dsh-plugin-manager/lib/types/tools:32`） | 锚点/消费者 `[实测]`；运行期效果 `[未实测]` |
| **P2** H2 | `…\dsh-tool-pwsh\lib\index.js`（`:314-315`） | 系统提示写死"禁止请求升级"（`NEVER_SENTENCE`），工具却仍注册 `sandbox_permissions`/`justification`、走带升级措辞的描述分支、并在**三处**提示里说"可以升级"。改法：`escalationModes` 额外与**组合层**审批默认策略相与（`never` ⇒ 空数组 ⇒ 参数＋描述分支＋三处提示**同时**消失） | **`status: draft`**：`ctx.get("approval")` 在 `apply()` 时刻是**竞态**（cordis loader 用 `Promise.allSettled` 并发启动 entry，且 `get` 是 strict）⇒ 拿不到策略就保持现状（不误伤、也不保证收紧）；**会话级** `never` 覆写依旧登广告（本机正是这种情形，所以**本机打上也看不到变化**） |
| **P3** H3 | `…\dsh-permission-presets\lib\index.js`（`:178-186`）＋ `…\dsh-client-ui-permission-presets\lib\client.js`（`:324`） | 装配期组合默认值算成 `custom` 时构造函数**直接抛错** ⇒ `permissions` 投影单元**根本没注册** ⇒ 客户端 `selection === undefined` 命中 `return null` ⇒ 访问模式控件**整块消失**。改法：宿主半不再抛（**命名**的未知默认值仍然抛；否则把设置面默认**钉在第一个真实预设**并 `warn`，投影面本来就报 `custom`）；客户端半把 `catalog === null`（保持 `null`）与 `selection === void 0`（渲染 **disabled 的 `Custom / 自定义`**）拆开 | 锚点/消费者 `[实测]`（含为什么**不能**让 `defaultSettings()` 返回 `custom`：客户端 `permissionDefaultOf` 会用 `catalog does not advertise its current default` 抛错）；真实装配复现 `[未实测]` |

**为什么默认不应用**：npx 缓存 ⇒ 不持久；上游才是有源可查的持久修复；P2 在本机是空转；
三处修复都只做到"片段级 ＋ 消费者级"静态验证，**没有**一次"重启 harness 后观察模型可见事实"的端到端证据。

```
node tools\dsh-patches.mjs --check         # 默认动作：4 个文件级 entry 逐条判定"未应用/已应用"（本轮 4/4 未应用）
node tools\dsh-patches.mjs --emit-patches  # 由清单重新生成 patches\dsh\*.patch（临时目录 + git diff --no-index）
node tests\dsh-patch-guard.mjs             # 守门：现场哈希必须恰好是 before 或 after，否则 harness drifted 红灯
node tests\dsh-patch-guard.mjs --plant     # 只扰动副本（清单假哈希 + 临时现场翻一个字节）⇒ 4 红
```

- 退出码：`0` 正常 ｜ `1` 用法/清单错误 ｜ **`3` 找不到 harness 根** ｜ **`4` 漂移**（"没找到"与"没问题"必须是两个码）。
- harness 定位三级：`DSH_HARNESS_ROOT` → 已知 npx 路径 → 扫 `%LOCALAPPDATA%\npm-cache\_npx\*`；本机命中
  `known-npx-path`（`[实测]`）。
- 清单里带**原样副本**（`patches/dsh/pristine/`），因此"清单自洽性"可以在**没有 harness** 的机器上离线判定。
- 每条补丁的完整说明（问题 / 精确锚点 / 改法 / 上游包路径 `repository.directory` / 已验证 vs `[未验证]` /
  残余 / 上游化建议）见 [`patches/dsh/README.md`](patches/dsh/README.md)。

## 11. 源码基线封印（`docs/源码基线.sha256`）：**改了就红，直到你有意识地刷新**

动机：本仓曾把 `.gitignore` 写成**忽略 `tests/`**，`tools/` 整个目录未跟踪，`src/limits.mjs` 等源码
也从未入版本库。于是有两种**无法证伪的说法**：①"只改了注释、行为一字未动"——**没有基线可比**；
②"这个文件没被动过"——未跟踪文件的静默漂移在 `git status` 里**看不见**。
**整理轮（测试套件入库）已把整个收录面纳入版本库**（`tests/*.mjs`、`tools/*.mjs`、
`src/` 与 `dsh-plugin/` 的漏项、`patches/`），但封印**不因此作废**：`git status` /
`git diff` 只能说明"某个文件被改过"，说不出**"这份清单是否仍覆盖全部收录面"**，
而本套件同时钉住内容（逐条哈希）与覆盖面（清单条数 == 磁盘受封印文件数）。

- `tools/baseline-sha256.mjs --write` 生成 `docs/源码基线.sha256`：**有序**的
  `sha256  <repo 相对路径>`（与 `sha256sum` 同格式，LF/UTF-8/无 BOM）。
- 收录面：`src/*.mjs`、`tests/*.mjs`、`dsh-plugin/*.mjs`、`tools/*.mjs` ＋ 根入口
  `autotest.mjs`、`verify.cmd`、`run.cmd`、`testservice.cmd`。截至整理轮共 **110 条**（`[实测]`；
  其中 `dsh-plugin/baseline-watch.mjs` 由缺陷②轮新增，`tests/boundary-degraded-failclosed.mjs` 与
  `tests/whiteout-candidate-capture.mjs`、`tests/delete-capture.mjs` 由缺陷③/①b/① 轮新增）。
- 排除面：清单自身，以及 `.t/`、`node_modules/`、`shim/`、`esc/`、`filemod/`、`retest/`、`.dshstage/`
  下的任何东西；`tools/lib`、`tools/toolchain` 这类**子目录**不在 `tools/*.mjs` 的深度内（"深度 1"这一给定范围的自然结果，**已作为残余写明**）。
- `--check` 把四类差异分别点名：**内容变化 / 清单缺失 / 僵尸行 / 格式非法**，并打印确切修复指令
  （`node tools\baseline-sha256.mjs --write` → **复核清单 diff** → 再跑 `--check` 与整仓关口）。
- `tests/baseline-integrity.mjs`（**14 项** / `--plant` 19 项 5 红）把这件事变成机制；
  **清单缺失 / 不可读 / 为空默认判红**（`RESULT: FAIL manifest-unsealed`、退出码 1，并打印
  `--write` → 复核清单 diff 的修复指令）—— **fail-closed**：旧版"缺失即 SKIP ＋ 退出码 0"
  意味着删掉 / 移走清单就能让封印**静默失效**而整仓仍报 `ALL PASS`（独立复核 §8.7 的高危缺陷）。
  只有**显式**逃生口（`set WINSTAGE_ALLOW_UNSEALED=1` 或 `--allow-unsealed`）才 SKIP（打印原因、退出码 0），
  逃生口故意做成不会被顺手触发。
- **逃生口仅限开发用，关口一律剥掉它**（本轮 LOW 缺陷的收口）：该逃生口是给**人工单跑**
  `tests/baseline-integrity.mjs` 用的（本地故意不封印时不阻塞手头工作），但**不得被关口继承**。
  `verify.cmd` 在跑套件清单之前先 `set "WINSTAGE_ALLOW_UNSEALED="`；共享运行器
  `src/testrunner.mjs` 的 `runSuite` 为每个子进程**删除**该键（是 delete，不是置 `undefined`），
  因此 `autotest.mjs` 与 HTTP 测试服务（`testservice.mjs`）同样覆盖，不只是批处理那一条路径。
  于是"环境里恰好有个变量"不能把整仓关口解封：清单被移走时 `verify.cmd` 的**最终一行**必须是
  `RESULT: FAIL`，而不是 `RESULT: ALL PASS`。
  `[实测]` 本轮验收（on the real tree，清单临时移到 `%TEMP%` 并在 `finally` 里还原、前后 sha256 一致）：
  (a) `set WINSTAGE_ALLOW_UNSEALED=1` ＋ 清单移走 ⇒ `verify.cmd` 最终行 `RESULT: FAIL`（此前是 `ALL PASS`）；
  (b) 清单还原后 `tools\baseline-sha256.mjs --check` 退出码 0；
  (c) 变量已设但清单在场 ⇒ 关口正常路径不受影响，25/25 全绿；
  (d) 直接单跑该套件（变量已设、清单缺失）⇒ 仍打印 `RESULT: SKIP manifest-unsealed-allowed`、退出码 0
  —— 逃生口对人工完好。正常路径的整仓关口证据见 `.t/seal-hatch-verify.txt`。

> **这是一份有意的封印，不是自动化的敌人**：改动任何受封印文件都会让关口变红，
> 直到有人**有意识地**重新生成清单。**那次生成产生的清单 diff 就是"改了什么"的可复核记录** ——
> 这正是把"注释只说改注释"从一句话变成一份可比证据的方式。
> `[实测]` 本轮就当场演示过两次：① 改完 `tests/baseline-integrity.mjs` 后忘了刷新 ⇒ `--check` 立刻报
> `tests/baseline-integrity.mjs（清单 73c070bf9f2e… / 磁盘 4d19920e248d…）`；
> ② 改完 `tools/baseline-sha256.mjs`（哈希显示格式）后跑整仓关口 ⇒ `baseline-integrity` 报
> `RESULT: FAIL checks=14 failures=2`，整仓 `RESULT: FAIL`。
