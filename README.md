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
.\verify.cmd                      # 6 组离线测试的轻量版（无报告）
.\diag.cmd                        # 绑定表契约 + 完整 init（需未受限会话）
```

### 1.1 自动测试运行器 `autotest.cmd` / `autotest.mjs`

一次运行 9 个套件，分三段，并写出机器可读报告：

| 段 | 套件 | 需要未受限会话 | 说明 |
|---|---|---|---|
| A | 7 组离线确定性测试 | 否 | 手册不变量、端到端链路、结构体布局、命令解析、执行器编排、审计解析、**元测试** |
| B | `diag-bindings` | 是 | 绑定表契约 + 完整 `init()` |
| C | `audit` | 是 | 沙箱内真实攻击探针（结构化 JSON） |

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
.\verify.cmd     # 11 套件 452 项断言，RESULT: ALL PASS（第一轮为 6 组 198 项；权威表见 §8）
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

> ⚠️ **上表是第一轮口径，已被 §8 的权威表取代**：`executor-stub` 72 → **84**、`audit-parse` 23 → **43**、
> `appcontainer-layout` 27 → **34**、`e2e-flow` 16 → **21**、`command-selftest`（§7）22 → **24**，
> 并新增 `paths-masks` **37** / `registry-guard` **125** / `workspace-regressions` **10**。
> `verify.cmd` 现为 **11 套件 / 452 断言 / 0 失败**；`autotest --skip-audit` 为 **12 套件 / 474 ok / 0 bad**。

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
| **AppContainer** | ✅ **运行期已实测生效（`proven=true`），但尚未接线到执行器 —— `selectTier()` 仍 fail-closed** | `src/appcontainer.mjs` + `src/appcontainer-runtime.mjs` 提供 `STARTUPINFOEX` / `SECURITY_CAPABILITIES` / 属性列表构造，并新增**权威判据**（`TokenIsAppContainer=29` / `TokenAppContainerSid=31` / `TokenIntegrityLevel=25`）与 `assessAppContainerIsolation()`（五项判据**缺一即 false**，无硬编码、无跨 profile 复用）。`[实测]` 真实子进程：`IsAppContainer=1`、包 SID 一致、**Low IL**、**区外写被拒**（宿主对照成功）、`caps=0` 时 `curl` **exit 7** ⇒ **`proven=true`**。离线布局测试 **34 项**（`tests/appcontainer-layout.mjs`） | `[实测]` 端到端隔离证据（`.t/sbx3/dev/raw-t0-isolation-proof.txt`）；**尚未接线**，见 §8 |
| **WFP**（Windows Filtering Platform） | ❌ **未实现，仅文档化候选** | 网络档位（OFFLINE / CONTROLLED_ONLINE / OBSERVED_ONLINE）在手册第 9 章有规范，本项目**没有**实现任何网络强制阻断 | 无实测；见 `docs/Windows功能开启清单.md` 第 9 节 |

**因此：**

- **T0 的隔离已 `[实测]` 生效，但执行器尚未接线到 T0。**
  `selectTier()` 的闸门是 `report.appContainerIsolation?.proven === true`（第二轮**未改动**）；
  真机端到端已实测 `proven=true`，但 T0 **仍未接进 `WindowsStageExecutor`**
  ⇒ **继续 fail-closed、实际运行在 `T1`**。这一点必须视为**未完成项**，
  不得读成"自动升级"，也不得读成"沙箱已经用上隔离"。
- **AppContainer 布局已用合成缓冲区离线钉死**（**34** 项），这是从缺陷 5（Job 结构体偏移错 4 字节）
  与缺陷 13（漏 `CREATE_UNICODE_ENVIRONMENT`）总结出的做法：**先把布局测对，再谈运行**。
- **网络面完全未被强制**：沙箱内可开 socket。任何"已断网"的说法都不成立（R2）。
  （补：T0 自己的网络阻断只是"**不声明能力**"的默认值——一旦声明 `internetClient` 网络即通，
  所以能力集必须由策略层白名单化，不能由调用方随手传。）
- **旧结论更正**：早先由本表读出的"AppContainer 探测 `E_ACCESSDENIED` ⇒ 隔离为零 / 进不了容器"
  **已被推翻** —— 那是**判据错误**（拿 `TokenUser` 比包 SID，而 AppContainer 令牌的 `TokenUser`
  **本来就是用户 SID**，包身份在 `TokenAppContainerSid(31)`，且包 SID **不在** `TokenGroups` 里）。
  详见 §8 与 [.t/sbx3/dev/03-FIX-B报告.md](.t/sbx3/dev/03-FIX-B报告.md)。

### 5.2 档位表

| 档位 | 机制 | 读取面 | 网络面 | 前置条件 | 本项目实现状态 |
|---|---|---|---|---|---|
| `T0` appcontainer | AppContainer 能力令牌 + Job + Low IL + ACL | ✅ 收敛 | ✅ 默认阻断 | 能创建 AppContainer profile | ⚠️ **隔离已 `[实测]` 生效（`proven=true`），但仅档位选择、无执行器 ⇒ 仍 fail-closed**（见 §5.1 与 §8） |
| `T1` restricted-token | WRITE_RESTRICTED + Job + Low IL + ACL | ❌ 不收敛 | ❌ 不收敛 | 令牌具备全部访问权 | ✅ **已实现并实测** |
| `T2` acl-only | 仅 ACL 写边界 | ❌ | ❌ | 目录属主 | ✅ 已实现（降级路径） |
| `T3` none | 无可用原语 | — | — | — | ✅ **拒绝执行**（fail-closed） |

档位由 `selectTier()` 依据**真实 Win32 调用结果**选择，不据文档推断。

---

## 6. 已知残余边界

完整清单见 `docs/Windows功能开启清单.md` 第 13 节（R1–R12）。最关键几条：

- **R1 读取面不收敛**：本后端限制写/删，不限制读。读取面收敛只能靠 AppContainer（**本项目未实现**）
  或工具层硬拒绝清单。
- **R2 网络面不收敛**：WFP 未实现，沙箱内可开 socket。
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

> **改动尚未提交 git**（本环境 PATH 上没有 git）。落地文件：`dsh-plugin/` 下的
> `cordis.patch.yml`、`host-plugin.mjs`、`client.js`、`staging-fs.mjs`、`fs-entry.mjs`。

---

## 8. 第二轮修复（FIX-A/B/C/D）

第二个修复轮次按四个工作流并行推进，各修一处/一组缺陷，**每条结论都有原始输出存档**。
完整叙述（含逐条原始字段）见 [.t/sbx3/最终报告.md](.t/sbx3/最终报告.md) §12。

### 8.1 修了什么（一句话一条 + 证据路径）

| 缺陷 | 结论 | 关键证据 |
|---|---|---|
| **D11** `cli exec` 管道死锁 | **已修（产品级）**：同一 300 KB 用例由「挂死到封装超时（`outBytes=0`、`durationMs=150153`、连 `--timeout 60000` 的 124 都没打印）」变为 **300395 B / `exitCode=0` / `4376 ms`**。改法：`src/executor.mjs` 新增 `waitForExitWithoutStarvingEventLoop`（**50 ms 有界等待切片** + `await setTimeout(0)` 让出事件循环），`collectChild` 改为**先发起两条排水、把退出等待延后一个宏任务**。判定力：把 `collectChild` 回退成同步等退出 ⇒ `tests/executor-stub.mjs` 由 **84 ok/0 bad → 84 ok/3 bad**，随后按字节还原（SHA256 `00E593D9…33A0`）。**残留**：`drainPipe` 固定 1 ms 轮询 ⇒ 吞吐 ~77 KB/s（**库侧，未修**） | `.t/sbx3/fixA/out/EVIDENCE-INDEX.md`、`out/fixA-d11-summary-*.json`、`out/D11-stub-{GREEN,RED}-*.txt`、`out/jobs/big.cli.out.txt` |
| **S1** 沙箱内子进程静默死亡 | **精确表征（与 D11 不同因）**：同一 `cmd.exe /c ver` 只改创建标志 —— `0x0` → **exit 0 且有 `ver` 输出**；`CREATE_NO_WINDOW(0x08000000)` / `CREATE_NEW_CONSOLE(0x10)` → **`0xC0000142`**；`NEW_PROCESS_GROUP(0x200)` / `UNICODE_ENV(0x400)` → 0；`DETACHED(0x8)` → 1 ⇒ **受限令牌下「需要新建控制台」⇒ 子进程秒死**（`CreateProcessW` 仍返回成功）。**执行器主路径不受影响**（`spawnPipedProcess` 本就 `creationFlags=0`）；二级（PowerShell 侧**创建阶段**就 `Access is denied`）**未定论、不合并** | `.t/sbx3/fixA/out/s1-flag-diff.json`、`out/s1-stage1.json`、`out/node-spawn-probe.json` |
| **T0 / AppContainer** | **"第 3 因"不存在，是判据错误**：AppContainer 令牌的 `TokenUser` **本来就是用户 SID**，包身份在 `TokenAppContainerSid(31)`，包 SID **不在** `TokenGroups` 里。四组实验（koffi / 显式 AC 令牌 + `DuplicateTokenEx` / 独立 PS P/Invoke / `caps=0` vs `1`）实测：`IsAppContainer=1`、包 SID 一致、**Low IL**、**区外写被拒**、**`caps=0` 时 `curl exit 7`**、**`caps=1(internetClient)` 时 `curl exit 0`**。顺带修掉两个真缺陷：`deriveCapabilitySidsFromName` **悬垂指针**（整进程 `0xC0000374` 堆损坏）、`bInheritHandles=TRUE` + 无自有控制台 ⇒ 子进程 `0xC0000142`（默认改 `false` + 危险组合 fail-closed）。`proven` 接到实测证据（五项判据缺一即 false），真机 `proven=true` —— **但 T0 仍未接线到执行器，`selectTier()` 继续 fail-closed** | `.t/sbx3/dev/03-FIX-B报告.md`、`raw-t0-{forensics,pinvoke,launch-matrix,isolation-proof}.txt`、`raw-fixb-{layout,runtime}-{green,plant}.txt` |
| **S3** `dpapi-user` 漏掉 `Microsoft\Protect` 目录自身 | **已修**：`canonical()` 会**去掉结尾分隔符** ⇒ 旧模式（要求结尾 `\`）只能命中目录下的文件；改为 `(\\\|$)` 并新增**目录探针** | `.t/sbx3/fixC/out/s3-dpapi-dir.before-after.txt` |
| **S5** 非 AppData 的浏览器凭据库不被命中却可读 | **已修**：新增两条规则 `browser-profile-auth-db` / `browser-profile-state`（各带**可命中**探针），覆盖 `Login Data` **129024 B**、`Login Data For Account` 51200 B、`Local State` **74863 B** 等 6 条路径；并修掉首版 `[^\\]*profile` 只匹配紧邻上一级的漏网 | `.t/sbx3/fixC/out/s5-browser-nonappdata.before-after.txt` |
| **F8** 非十六进制 `data` 被静默解码 | **已修（实测比原描述更糟）**：原先**静默**解出**与写入值无关的垃圾**（`REG_SZ('hello')` → `0000`、`REG_DWORD` → 0、`REG_QWORD` 抛**无 code** 的 `SyntaxError`）⇒ 新增 `assertShape()` 抛 `code='REG_SNAPSHOT_INVALID'`，**12 条新断言** | `.t/sbx3/fixC/out/raw-registry-guard-{green,plant}.stdout.txt` |
| **读取探针** | `src/audit.mjs::READ_PROBES` **10 → 42 条**（原 10 条 **id/顺序逐字保留**）+ **五态**判定（`readable` / `denied` / `read-metadata-only`（记 fail）/ `not-present`（**绝不记 denied**）/ `error`）。实测三态分布 `{read-metadata-only:5, readable:16, not-present:21}`；只记 `id/path/verdict/len/head4/errCode`，**秘密不进证据** | `.t/sbx3/fixC/out/read-probes-run.txt`、`.t/sbx3/fixC/REPORT.md` |
| **D1** 面板只渲染净 diff，活候选不可见 | **已修**：`files[]` = 净 diff 行（可批准）**∪ 冻结存档行**（`frozenOnly:true`，只显示、**无勾选框**、带 `frozenReason`）；新增 `counts.{net,frozenOnly}` 与 `candidates[]`（含 `appliedPaths`）。**关键坑**：`cs_0005` 的两条是 `state:"deleted"` + `baseHash:"absent"` 的墓碑，删除类 `after.hash` 也是 `'absent'` ⇒ 用磁盘比对会误判成"已完成"，已改为 `appliedPaths` ∪ 非删除类磁盘比对。修前 FAIL：`s2-candidate-paths-visible`（`invisible=[cs_0005 .ssh\id_rsa, cs_0005 r3-a.txt]`，exit 5） | `.t/sbx3/browser/out/fixd-pre-s2-panel.txt`、`out/fixd-post-restart-loaded.json`、`.t/sbx3/browser/FIX-D-报告.md` |
| **D2** `reject()` 连坐回收却只 discard 最新候选 | **已修**：`reject()` 重写 + `reconcileCandidates()` ⇒ **discard 范围 = 回收范围**，不再留"空壳 pending"；语义明确「拒绝全部 = 清空全部暂存 + 终结全部候选 ⇒ 面板卸载是**设计**」。修前 FAIL：`s4-no-shell-pending`（`openAfter` 留下 3 份空壳，exit 5）。跨工作区守卫（`sameRoot()`/选举/poller 自校验）**一字未改**，另有**独立控制组** | `.t/sbx3/browser/out/fixd-pre-s4-reject.txt`、`fixd_client_selftest.mjs`（E1/E2） |

### 8.2 权威测试套件表（第二轮最终口径，`[实测]`）

`verify.cmd`（离线确定性套件，任何会话可跑）：

| 套件 | 断言数 | 本轮变化 |
|---|---|---|
| `tests/selftest.mjs` | 51 | — |
| `tests/e2e-flow.mjs` | 21 | 16 → 21 |
| `tests/struct-layout.mjs` | 24 | — |
| `tests/appcontainer-layout.mjs` | **34** | 27 → 34（`--plant` 6 条红） |
| `tests/paths-masks.mjs` | 37 | （第一轮后段新增） |
| `tests/workspace-regressions.mjs` | 10 | （第一轮后段新增） |
| `tests/registry-guard.mjs` | **125** | **本轮补进 `verify.cmd` 与 `OFFLINE_SUITES`**（此前两处都缺） |
| `tests/resolve-exec.mjs` | 19 | — |
| `tests/executor-stub.mjs` | **84** | 72 → 84（D11 红/绿双档） |
| `tests/audit-parse.mjs` | **43** | 23 → 43（读探针表 + 秘密红线） |
| `tests/meta-runner.mjs` | 4 | — |
| **`verify.cmd` 合计** | **452** | `RESULT: ALL PASS`（`.t/sbx3/fixA/out/verify-final.txt`，11 套件 / 0 失败） |

`autotest.cmd --skip-audit`（离线 11 套 + 沙箱套件）：

| 项 | 数 | 备注 |
|---|---|---|
| 离线套件 | **452** | 同上 |
| `tests/diag-bindings.mjs` | 22 | 需未受限会话；14 → 22 |
| **合计** | **474 ok / 0 bad / 0 跳过（12 套件）** | `.t/sbx3/fixA/out/autotest-skip-audit.txt` |

插件侧与辅助套件（离线，不依赖 Win32 沙箱）：

| 套件 | 断言数 | 备注 |
|---|---|---|
| `.t/review-selftest.mjs` | 26 / 0 | 本轮复跑 |
| `.t/staging-fs-selftest.mjs` | 31 / 0 | 本轮复跑 |
| `.t/command-selftest.mjs` | **24** / 0 | 本轮复跑（§7 旧文写 22） |
| `.t/sbx3/browser/fixd_selftest.mjs` | **48** / 0 | 新增（D1/D2 宿主半） |
| `.t/sbx3/browser/fixd_client_selftest.mjs` | 25 / 0 | 新增（客户端半，含跨工作区守卫控制组） |
| `.t/sbx3/browser/fixd_forecast.mjs` | 11 / 0 | 真实 fixture 不变式 + 预报 |
| `.t/default-on-selftest.mjs` | **13** / 0（另 6 个变异体各自见红） | 新增：「默认开启沙箱」= 五层默认值 + 活动 profile 装配的回归门：五层默认值 + 活动 profile 装配 + 设置页生效值（见 docs/DSH集成.md §20） |
| `tests/appcontainer-runtime.mjs` | **140** / 0（`--plant` 6 红） | ⚠️ **尚未接入 `verify.cmd` / `OFFLINE_SUITES`**（与 `registry-guard` 被补进清单前的处境相同，属**已知缺口**） |

> 口径说明：FIX-C 当时报的 `verify.cmd` **11 套件 / 448 断言**是其**时点口径**
> （那时 `appcontainer-layout` 还是 30 条）；最终一次全量回归（`verify-final.txt`，晚于全部代码改动）
> 是 **11 套件 / 452 断言 / 0 失败**。两者不矛盾。

### 8.3 第二轮仍未提供的保证（必须与任何"通过"一起读）

- **T0 未接线到执行器**：`proven=true` 只证明"隔离能生效"，**不证明"沙箱已在用 T0"**；`selectTier()` 仍 fail-closed。
- **T0 读面未收敛**：实测仍可读 `C:\Windows\win.ini`（**R1** 残余）。
- **WFP 未装过滤器**、**注册表 ACL 未启用**（沙箱内 `reg add` 的 `Access is denied` 来自受限令牌/ACL 的既有约束，本轮未新增注册表策略）。
- **R2 网络面未收敛**：沙箱内可开 socket。
- **`drainPipe` 吞吐**：固定 1 ms 轮询 ⇒ ~77 KB/s（**库侧，未修**）。
- **S1 二级未定论**：创建阶段 `Access is denied` 与用户态 `0xC0000142` **是否同因**，保持未定论。
- **D1/D2 的浏览器侧回归 `[未实测]`**：3085 重启后 HTTP 未监听（`START-EXIT 1`、supervisor ~2 s 判死、`sbx3.out/err.log` **0 字节**），**与插件改动无关**（同一轮 `DUMP-CONFIG-PASS` 通过、插件成功发布了新格式快照）。离线替代证据：`fixd_selftest 48/48`、`fixd_client_selftest 25/25`、`fixd_forecast 11/11`、`s3_suite --dry-run 5/5`（目录 52 = 代码 52）。
- **遮蔽规则仍是黑名单**：改名 / 换扩展名 / 换目录形状即绕过；非 AppData 的 Mozilla `key4.db` / `logins.json` **未覆盖**；**遮蔽 ≠ 拒绝**。
