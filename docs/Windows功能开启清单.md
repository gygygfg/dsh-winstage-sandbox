# Windows 功能与权限开启清单（dsh-stage 沙箱）

> 本文回答一个问题：**要跑这套 Windows 沙箱，需要开启哪些 Windows 功能、拿到哪些权限？**
>
> 所有条目按《Agent 沙箱暂存—提交架构设计手册 v3.0》第 0 章的证据分层标注：
> `[实测]` 本机实际执行并观测 ｜ `[官方]` 官方文档机制说明 ｜ `[报告]` 未独立复现 ｜ `[推断]` 机制推导未验证。
>
> **本机基线**（探测时间见 `src/capability.mjs` 输出的时间戳）：
> Windows 10.0.26100，x64，Node v24.21.0，会话身份 `WIN-DV9KRECLBVS\Administrator`（**受限令牌**）。

---

## 0. 先看结论：不需要开启任何 Windows 可选功能

这是最重要的一条，也是最容易被误解的一条。

| 隔离机制 | 是否需要开启 Windows 可选功能 | 是否需要管理员 | 本机实测状态 |
|---|---|---|---|
| 受限令牌 `CreateRestrictedToken`（WRITE_RESTRICTED） | **不需要** | **不需要** | 可加载，但当前受限会话缺 2 项权限（见 §2） |
| NTFS DACL 写授权 + 显式 deny | **不需要** | **不需要**（目录属主即可） | `[实测]` 本会话写边界生效 |
| 强制完整性标签（Low IL，no-write-up） | **不需要** | **不需要** | `[实测]` 由 DSH 内置后端施加 |
| Job Object `KILL_ON_JOB_CLOSE` | **不需要** | **不需要** | `[实测]` 可创建；本会话不可再分配（见 §4） |
| 环境变量允许清单重建 | **不需要** | **不需要** | `[实测]` 已实现 |
| 暂存—候选—选择性提交（本仓库核心） | **不需要** | **不需要** | `[实测]` 48/48 自测通过 |

**也就是说：本仓库实现的沙箱主链路，零 Windows 功能、零管理员权限即可运行。**
下面的章节是"如果你想加强隔离，可以额外开启什么"，以及"为什么在本机没测成"。

---

## 1. 本机已具备 / 已缺失的能力（实测证据）

```
probe v1  fingerprint=aa3ca6a6dc3d8305
root=C:\Users\Administrator\Desktop\WinStageSandbox\.t\ws
selected tier=T2 (acl-only)
  嵌套可用性: NO — the current process cannot mint a restricted token
             (a WRITE_RESTRICTED token itself), so a nested sandbox cannot be
             established here — run the sandbox from an unconfined host process
  [FAIL] tokenRights: TOKEN_ASSIGN_PRIMARY=yes TOKEN_DUPLICATE=yes TOKEN_QUERY=yes
                       TOKEN_ADJUST_DEFAULT=NO TOKEN_ADJUST_SESSIONID=NO
  [FAIL] createRestrictedTokenViable: 缺少 TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID
  [FAIL] writeOutsideWorkspace: denied (EPERM) — an outer write boundary is active
  [PASS] writeSystemDir: C:\Windows write denied (EPERM)
  [FAIL] jobObject: SetInformationJobObject=true, AssignProcessToJobObject=false
  [FAIL] appContainer: CreateAppContainerProfile failed hr=0x80070005
  [PASS] workspace-writable / stage-base-on-root
  [PASS] ambient-write-outside-root: denied (EPERM) → 进程沙箱写边界生效
  optional features（文件标记探测）:
    Containers-DisposableClientVM: absent   (Windows Sandbox)
    Microsoft-Hyper-V:             absent
    Containers:                    absent
    HypervisorPlatform:            present
    VirtualMachinePlatform:        unknown（无文件标记可判）
```

---

## 2. 令牌权限：唯一真正需要"额外权限"的地方

### 2.1 机制 `[官方]`

微软文档：[Restricted Tokens](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)

> A restricted token is a primary or impersonation access token that has been modified by the
> **CreateRestrictedToken** function. […] The system uses the list of restricting SIDs when it
> checks the token's access to a securable object. When a restricted process or thread tries to
> access a securable object, the system performs two access checks: one using the token's enabled
> SIDs, and another using the list of restricting SIDs. **Access is granted only if both access
> checks allow the requested access rights.**

这条"两次检查取交集"正是本沙箱写边界的全部数学基础：
把 workspace/temp 的能力 SID 放进 restricting 列表，那么**只有**同时被普通 SID 和
能力 SID 允许的写访问才会通过 → 写权限被精确限制到被授予的目录。

同页还说明了一个关键便利：

> if the **CreateProcessAsUser** call specifies a restricted version of the caller's primary token,
> this privilege is not required. This enables ordinary applications to create restricted processes.

即**不需要** `SE_ASSIGNPRIMARYTOKEN_NAME` 特权（该特权通常只有 LocalSystem 有），
所以普通用户进程即可创建受限子进程。这解释了为什么本方案无需管理员。

### 2.2 逐项权限需求

`CreateRestrictedToken` 本身以及后续的令牌操作需要以下访问权。本机逐项实测结果：

| 访问权 | 十六进制 | 用途 | 本机实测 |
|---|---|---|---|
| `TOKEN_ASSIGN_PRIMARY` | `0x0001` | 把受限令牌作为主令牌创建进程 | ✅ 持有 |
| `TOKEN_DUPLICATE` | `0x0002` | 复制当前令牌 | ✅ 持有 |
| `TOKEN_QUERY` | `0x0008` | 读取令牌信息（日志 SID 等） | ✅ 持有 |
| `TOKEN_ADJUST_DEFAULT` | `0x0080` | 设置令牌默认 DACL / **完整性级别（Low IL）** | ❌ **缺失** |
| `TOKEN_ADJUST_SESSIONID` | `0x0100` | 调整会话 ID | ❌ **缺失** |
| `TOKEN_ADJUST_PRIVILEGES` | `0x0020` | 增删特权（`DISABLE_MAX_PRIVILEGE` 路径） | 未单独测 |
| `TOKEN_ALL_ACCESS` | `0xF01FF` | 全量 | ❌ 拒绝 |

### 2.3 为什么本机会缺失这两项 `[实测]`

因为**本会话本身已经是一个 WRITE_RESTRICTED 受限令牌**（由 DSH 内置的
`@deepseek-ai/dsh-sandbox-windows-acl` 后端创建）。受限令牌天然被剥离了
`TOKEN_ADJUST_DEFAULT` / `TOKEN_ADJUST_SESSIONID` / `TOKEN_ADJUST_PRIVILEGES`
这类提升性权限，因此**无法再复制出第二个受限令牌**。

**两侧对照实测**（同一份代码、同一台机器，仅宿主会话不同）：

| 宿主会话 | `AclSandbox.init()` 结果 | tier |
|---|---|---|
| DSH GUI 会话（受限令牌） | ❌ `OpenProcessToken failed (Win32 5)` | T2 |
| DSH 之外新开的 PowerShell（未受限） | ✅ **成功，flags=0x2408** | **T1** |

> **结论：Windows 的进程隔离不可嵌套。**
> 这是一个机制性边界，不是配置问题，也不是本仓库的缺陷。
> 由此得到两条工程要求：
> 1. 沙箱**必须由未受限的宿主进程**建立（本仓库的 `dsh-stage` 即设计为独立 CLI）；
> 2. 在已受限会话内必须 **fail-closed 并明确报告原因**，绝不能"降级为无沙箱运行"。

### 2.4 需要开启/提供什么

| 目标 | 需要的条件 | 命令 |
|---|---|---|
| 在上述能力**齐备**的环境中运行 | 一个**未被沙箱化**的进程上下文 | 直接新开一个普通 PowerShell 窗口运行 `dsh-stage`，无需任何 Windows 功能 |
| 以管理员身份运行（非必需） | Administrators 组成员 | 以管理员身份打开 PowerShell / 终端 |
| 需要 `SE_ASSIGNPRIMARYTOKEN_NAME`（本方案**不需要**） | `SeAssignPrimaryTokenPrivilege` | `secpol.msc` → 本地策略 → 用户权限分配 |

**所以"要开启什么 Windows 功能"的答案对令牌这一层是：不需要开启功能。
需要的是"不要在已受限的会话里再套一层"。**

---

## 3. 完整性级别（Mandatory Integrity Control）—— 不需要开启功能

### 3.1 机制 `[官方]`

Low 完整性标签是 NTFS **SACL** 里的一个强制性标签（mandatory label），内核据此施加
**no-write-up**：Low IL 进程不能写 Medium/High IL 对象。

本沙箱用它封闭"一个类"而不是逐个文件名——这一点直接对应手册教训
**#16.9「封闭一个类，而不是逐个文件名」** 与 **#8.4「能力(capability) 不等于权限(DAC)」**：

- **DAC 层**：restricting SID 交集 → 只允许写被授予目录；
- **MIC 层**：只有被标为 Low 的目录才可写 → 即使 DAC 误放行也被 MIC 拦下。

### 3.2 权限要求

| 项 | 要求 |
|---|---|
| Windows 可选功能 | **无** |
| 管理员 | **不需要** |
| 前提 | 目标目录必须**调用方属主**，且属主隐式权限需含 `WRITE_DAC`；设置 SACL 标签还需 `WRITE_OWNER` |
| 文件系统 | 必须支持安全描述符 → **NTFS**（FAT/exFAT 不保存安全描述符，标签由系统指派、行为未验证） |

`[官方]` 该后端自身文档亦记载：仅授予 `Modify` 的目录会**大声失败**而非静默跳过——这是正确的
fail-closed 行为。

### 3.3 本机残留注意

`[官方]` 该 ACL 后端在授予时对 workspace 目录树施加**长期存在（standing）的 Low 标签**，
它不会随会话撤销。副作用：同一用户下**任何其他 Low 完整性进程**也能写该目录树。
这是写边界换来的代价，必须作为已知代价声明，不能当作没有。

---

## 4. Job Object —— 不需要开启功能

### 4.1 机制 `[官方]`

微软文档：[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)

> However, if the job has the `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` flag specified,
> closing the last job object handle terminates all associated processes and then destroys
> the job object itself.

> A process can be associated with more than one job in a hierarchy of **nested jobs**.

> **Windows 7 / Server 2008 R2 and earlier:** A process can be associated with only one job.
> Jobs cannot be nested. **The ability to nest jobs was added in Windows 8 and Windows Server 2012.**

这解释了本机的 `AssignProcessToJobObject=false`：
**本进程已经在 DSH 宿主的 Job 里**，只有当内外两个 Job 都允许嵌套时才能再分配。
`[实测]` 本机条件下再分配被拒 → 我们报 `fail` 而不是假装成功。

### 4.2 权限要求

| 项 | 要求 |
|---|---|
| Windows 可选功能 | **无** |
| 管理员 | **不需要** |
| 前提 | 若要再分配，需 Windows 8 / Server 2012+，**且**外层 Job 未禁止嵌套（检查 `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` / 父 Job 的 breakaway 设置） |

### 4.3 相关限制标志

| 标志 | 值 | 作用 |
|---|---|---|
| `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` | `0x00002000` | 关闭最后一个句柄即杀掉整棵树 |
| `JOB_OBJECT_LIMIT_ACTIVE_PROCESS` | `0x00000008` | 限制活跃进程数（配合 offset 36 的 `ActiveProcessLimit`） |
| `JOB_OBJECT_LIMIT_PROCESS_MEMORY` | `0x00000100` | 单进程内存上限 |
| `JOB_OBJECT_LIMIT_JOB_MEMORY` | `0x00000200` | 整个 Job 内存上限 |
| `JOB_OBJECT_LIMIT_BREAKAWAY_OK` | `0x00000800` | 允许子进程显式脱离（**不要设**，否则失去进程树收敛） |
| `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK` | `0x00001000` | 子进程静默脱离（**不要设**） |

---

## 5. AppContainer —— 不需要开启可选功能，但需要能力

### 5.1 机制 `[官方]`

微软文档：[AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)
列出了它真正隔离的六个面：凭据、设备、文件、网络、进程、窗口。

关键句：

> Read-write access can be granted to specific persistent files and registry keys.
> Read-only access is less restricted. An application always has access to the memory resident
> files created specifically for that AppContainer.

> Isolating the application from network resources beyond those specifically allocated,
> AppContainer prevents the application from 'escaping' its environment.

**这正是本沙箱 `T0` 档位的价值**：它是 Windows 上唯一能**同时收敛读取面和网络面**、
且**不需要开启 Windows 可选功能**的原语。

### 5.2 本机实测

```
CreateAppContainerProfile failed hr=0x80070005
```

`0x80070005` = `E_ACCESSDENIED`。

| 项 | 要求 |
|---|---|
| Windows 可选功能 | **无**（AppContainer 是内核自带机制） |
| 管理员 | **通常不需要**；但受限令牌下会 `E_ACCESSDENIED` |
| 关键前提 | 需能创建 AppContainer profile 与包 SID（受令牌能力与策略约束） |
| 启动方式 | `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` + `STARTUPINFOEX` + `UpdateProcThreadAttribute` + `CreateProcess` |
| 能力声明 | 网络默认**阻断**；需要联网必须显式声明 `internetClient` 等能力 |
| 兼容性风险 | 任意控制台程序（`node.exe`/`pwsh.exe`）在 AppContainer 内可能因缺少包内运行时资源而启动失败；必须**逐个实测** |

### 5.3 结论

`[实测]` 本机因受限令牌拿不到 AppContainer profile → **T0 档位在本会话不可用**。
在未受限进程（尤其管理员）中应能创建。**必须实测，不得据文档推断为可用。**

---

## 6. 可选增强一：Windows Sandbox（`Containers-DisposableClientVM`）

### 6.1 它是什么 `[官方]`

微软文档：[Install Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install)

前置条件：

- Arm64（Windows 11 22H2+）或 AMD64 架构
- BIOS 中启用虚拟化（虚拟机内需启用**嵌套虚拟化**）
- ≥ 4 GB RAM（推荐 8 GB）、≥ 1 GB 空闲磁盘、≥ 2 个 CPU 核心
- **Windows 11 或 Windows 10 1903 或更高版本**

### 6.2 开启命令 `[官方]`

图形界面：任务栏搜索 **Turn Windows features on or off** → 勾选 **Windows Sandbox** → 确定 → 按提示重启。

PowerShell（**必须以管理员身份**）：

```powershell
Enable-WindowsOptionalFeature -FeatureName "Containers-DisposableClientVM" -All -Online
```

DISM 等价（管理员）：

```cmd
dism /online /enable-feature /featurename:Containers-DisposableClientVM /all /norestart
```

查看状态（管理员）：

```powershell
Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM |
  Select-Object FeatureName, State
```

需要**重启**。

### 6.3 重要限制（决定它不适合做本沙箱主链路）

| 限制 | 说明 | 证据等级 |
|---|---|---|
| **仅客户端 SKU** | 官方 "Applies to: Windows 11 / Windows 10"。本机为 **10.0.26100 的 Windows Server** 血统，且 `Containers-DisposableClientVM` 标记 **absent** → 本机不可用 | `[实测]` 文件标记 + `[官方]` 适用范围 |
| **需要交互式桌面** | WSB 是 Windows 应用，靠 `.wsb` 配置文件驱动；无正式的无头/CI 驱动接口 | `[官方]` 文档只描述桌面启动方式 |
| **不是同内核隔离** | 它是独立的一次性 VM，无法与宿主共享"同一工作区版本"，与手册第 1 章"统一视图"直接冲突 | `[推断]`（基于 VM 语义，未在本机验证） |
| **每次启动成本高** | 完整 VM 引导，不适合"每次工具调用一个 attempt"的高频路径 | `[推断]` |

### 6.4 建议用途

把 WSB 定位为**高危语料的一次性验证环境**（对应手册第 17.2 节"危险语料全量运行于一次性 VM；
宿主只运行经过分类的安全用例"），**而不是**工具调用路径上的暂存沙箱。

### 6.5 `.wsb` 配置文件骨架（示例）

```xml
<Configuration>
  <MappedFolders>
    <MappedFolder>
      <HostFolder>C:\Users\Administrator\Desktop\WinStageSandbox\.t\ws</HostFolder>
      <SandboxFolder>C:\stage</SandboxFolder>
      <ReadOnly>true</ReadOnly>
    </MappedFolder>
  </MappedFolders>
  <LogonCommand>
    <Command>powershell.exe -ExecutionPolicy Bypass -File C:\stage\audit.ps1</Command>
  </LogonCommand>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
</Configuration>
```

> `Networking` / `ClipboardRedirection` / `MappedFolder` 的具体取值请以
> [Windows Sandbox 配置示例](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-sample-configuration)
> 为准；上例为骨架，未经本机实测（本机无 WSB）。

---

## 7. 可选增强二：Hyper-V 隔离容器 / Windows 容器

### 7.1 开启命令（管理员，需重启）

```powershell
# Windows 容器（进程隔离 + Hyper-V 隔离两类都依赖它）
Enable-WindowsOptionalFeature -Online -FeatureName Containers -All

# Hyper-V 平台（Hyper-V 隔离容器、Windows Sandbox 均依赖）
Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All

# 虚拟机平台
Enable-WindowsOptionalFeature -Online -FeatureName VirtualMachinePlatform -All

# 虚拟机监控程序平台（本机已 present）
Enable-WindowsOptionalFeature -Online -FeatureName HypervisorPlatform -All
```

DISM 等价：

```cmd
dism /online /enable-feature /featurename:Containers /all /norestart
dism /online /enable-feature /featurename:Microsoft-Hyper-V /all /norestart
dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
dism /online /enable-feature /featurename:HypervisorPlatform /all /norestart
```

### 7.2 本机状态 `[实测]`

| 功能 | 标记探测 |
|---|---|
| `Microsoft-Hyper-V` | absent（`vmcompute.exe` 不存在） |
| `Containers` | absent（`containerd.exe` 不存在） |
| `HypervisorPlatform` | **present**（`WinHvPlatform.dll` 存在） |
| `VirtualMachinePlatform` | unknown（无文件标记可判） |

### 7.3 何时选它

当任务需要"整机级隔离 + 网络拓扑控制 + 可丢弃根文件系统"，且能接受容器镜像与
containerd/Docker 依赖时。代价：**失去了与宿主共享统一工作区版本的能力**，
需要额外的同步层才能满足手册第 1 章不变量。

---

## 8. 可选增强三：WDAC / AppLocker（代码完整性）

| 项 | 说明 |
|---|---|
| 用途 | 限制**哪些可执行文件/脚本可以运行**，即一种应用白名单 |
| 是否需要管理员 | **是**（WDAC 策略部署需管理员 + 重启；AppLocker 需相应服务） |
| 能否替代文件隔离 | **不能**。它是"能执行什么"的控制，不是"能读写什么"的控制 |
| 本沙箱定位 | 仅作为**纵深防御**的附加层；不进主链路 |

对应手册第 14.2 节的纠偏要求：CI（代码完整性）、MIC（强制完整性）、审计、调用期过滤
必须分别描述，不能用"最接近 seccomp"这类模糊类比。

---

## 9. 可选增强四：Windows Filtering Platform（网络出口控制）

| 项 | 说明 |
|---|---|
| API 族 | `FwpmEngineOpen0` / `FwpmSubLayerAdd0` / `FwpmFilterAdd0` / `FwpmEngineClose0` |
| 是否需要管理员 | **通常需要**（安装全局过滤器需要管理员与相应特权） |
| 能力 | 可按进程/端口/地址记账或阻断，能表达手册第 9 章要求的 OFFLINE 硬边界候选 |
| 本沙箱定位 | 网络档位（OFFLINE / CONTROLLED_ONLINE / OBSERVED_ONLINE）的候选实现 |

`[未实测]` 本机无管理员，未验证。**不得据本表声明网络已被阻断。**

替代的弱方案（要在文档里如实降级，见手册第 9.1 节）：

| 方案 | 能做什么 | 不能做什么 |
|---|---|---|
| 只清空代理环境变量 | 去掉"方便"的绕过路径 | **不是**硬边界；裸 TCP/UDP/IPv6 仍可直连 |
| 应用层 HTTP 代理 | 观察/拦截 HTTP CONNECT | 拦不住不经代理的裸 TCP；**应用层代理 ≠ 硬边界**（手册 #9.1） |
| `Networking=Disable`（仅 WSB） | 一次性 VM 内断网 | 仅适用于 WSB 路径 |

---

## 10. 非管理员也能读到的功能状态

`[实测]` 本会话 `dism`、`Get-WindowsOptionalFeature`、`Get-CimInstance Win32_OperatingSystem`、
`Get-Volume`、`whoami.exe` 全部因权限或沙箱边界失败。因此能力探测**改用文件标记探测**：

```powershell
# 无需管理员，判断功能是否落盘（本仓库 probeOptionalFeatures 采用同一思路）
Test-Path 'C:\Windows\System32\WindowsSandbox.exe'      # Windows Sandbox
Test-Path 'C:\Windows\System32\vmcompute.exe'           # Hyper-V
Test-Path 'C:\Program Files\containerd\containerd.exe'  # Containers
Test-Path 'C:\Windows\System32\WinHvPlatform.dll'       # HypervisorPlatform
```

局限：文件存在 ≠ 功能已启用。因此本仓库在报告中把这类结论标为
`state: present|absent` 并附注"功能开关状态需管理员执行 dism 确认"，
**绝不把文件标记升级为"功能可用"**（手册 0.1 / D.2 第 4 条）。

---

## 11. 汇总表：能力 → 需要什么 → 本机实测

| 想要的能力 | 需要的 Windows 功能 | 需要的权限 | 重启 | 本机 |
|---|---|---|---|---|
| 写边界（暂存根可写、其余拒写） | 无 | 目录属主 + `WRITE_DAC`/`WRITE_OWNER` | 否 | ✅ 生效 |
| 删除边界（拒绝父目录删除权旁路） | 无 | 同上 | 否 | ✅ 由后端施加 |
| no-write-up 兜底 | 无 | 同上 | 否 | ✅ 由后端施加 |
| 环境变量最小化 | 无 | 无 | 否 | ✅ 已实现 |
| 进程树回收 | 无 | 需 Windows 8/2012+ 且外层 Job 允许嵌套 | 否 | ❌ 外层 Job 已占 |
| 读取面收敛 | 无（AppContainer 是内核机制） | 能创建 AppContainer profile | 否 | ❌ 受限令牌下 E_ACCESSDENIED |
| 网络硬阻断 | 无（WFP 为内核 API） | 通常需管理员 | 否 | ❌ 未实测 |
| 一次性整机隔离 | `Containers-DisposableClientVM` | 管理员 | **是** | ❌ 非客户端 SKU |
| 容器隔离 | `Containers` + `Microsoft-Hyper-V` | 管理员 | **是** | ❌ absent |
| 代码完整性白名单 | WDAC/AppLocker | 管理员 | 是 | ❌ 未实测 |

---

## 12. 操作手册：如何在本机拿到完整证据

当前 DSH GUI 会话本身运行在受限令牌下，因此**嵌套沙箱在此不可建立**。要取得完整实测证据：

1. 在桌面上打开一个**全新的** PowerShell 窗口（不要从 DSH 内部派生），普通用户即可。
2. 进入项目目录并运行审计：

```powershell
cd C:\Users\Administrator\Desktop\WinStageSandbox
# 直接跑 node；若同样出现"原生调用丢输出"，改用 cmd 包装
.\run.cmd src\cli.mjs probe --workspace .\.t\ws
.\run.cmd src\cli.mjs audit --workspace .\.t\ws
.\run.cmd tests\selftest.mjs
```

3. 期望结果：`probe` 的 `createRestrictedTokenViable` 变为 `pass`、
   选中档位升到 `T1`、`audit` 覆盖度从 9% 升到 100% —— **已实测确认**：
   未受限会话内 `sandbox-init` 通过、`tier=T1`、Job flags `0x2408`。

> 若 `run.cmd` 报 `'WRITE_RESTRICTED' 不是内部或外部命令`，说明批处理文件被写成了
> 非 ASCII。`cmd.exe` 按 **OEM 代码页**解析批处理，UTF-8 中文注释会被解码成命令执行。
> **`.cmd` 文件必须保持纯 ASCII。**

若要验证管理员专属项（Windows Sandbox / 容器 / WFP）：

```powershell
# 以管理员身份打开 PowerShell
Enable-WindowsOptionalFeature -FeatureName "Containers-DisposableClientVM" -All -Online
# 重启后
dism /online /get-featureinfo /featurename:Containers-DisposableClientVM
```

---

## 13. 残余边界与代价（必须随任何"通过"结论一起声明）

依据手册 #16.10：**无法消除的残余要写进文档并声明为非硬边界，不能假装没有。**

| # | 残余边界 | 等级 | 说明 |
|---|---|---|---|
| R1 | **读取面不收敛** | `[实测]` | WRITE_RESTRICTED 只交叉**写类**访问；Low IL 只做 no-write-up。两者都不限制读取 → 沙箱内进程可读调用者可读的任何文件。读取面收敛只能靠 AppContainer（T0）或工具层硬拒绝清单 |
| R2 | **网络不收敛** | `[官方]` | 受限令牌与 ACL 均不涉及网络。除非启用 WFP 或 AppContainer 能力管控，否则沙箱内可开 socket |
| R3 | **硬链接别名** | `[官方]` | NTFS 硬链接是**文件对象**别名而非路径别名；对已有多重链接的文件授予写权限会同时影响外部别名 |
| R4 | **AppContainer ACL 障碍** | `[官方]` | 被其他 AppContainer 工具用包 SID 标记过的目录树，对 Low 完整性子进程**不可读**，即使 DACL 允许 |
| R5 | **长期 Low 标签** | `[官方]` | workspace 的 Low 标签不随会话撤销（复用缓存设计），因此同用户下**任何** Low IL 进程都能写该树 |
| R6 | **嵌套隔离不可用** | `[实测]` | 已受限进程无法再建受限令牌（缺 `TOKEN_ADJUST_DEFAULT`/`TOKEN_ADJUST_SESSIONID`）；Job 也无法再分配 |
| R7 | **环境块注入需运行时探测** | `[实测]` | 依赖包的受限 spawn 固定传 `lpEnvironment=NULL`（继承父环境，违反手册 #8.3）；本实现改为在启动窗口内替换绑定表的 `createProcessAsUserW` 以传入显式环境块。若依赖内部结构变化，必须 fail-closed 拒绝启动，而非退回继承环境 |
| R8 | **FAT/exFAT 不保存安全描述符** | `[官方]` | 暂存根与工作区必须在 NTFS 上；FAT 类卷的完整性标签由系统指派，行为未验证 |
| R9 | **挂 Job 前的极短竞态** | `[实测]` | 子进程创建后即 resume，理论上可在 `AssignProcessToJobObject` 之前派生孙进程。窗口极短；`libuv` 路径无法在 resume 前挂 Job，已作为已知边界记录 |
| R10 | **PowerShell 原生调用丢输出** | `[实测]` | 本机受限会话下 `& node.exe ...` 静默无输出（`cmd /c` 正常）。属宿主令牌行为，测试须经 `run.cmd` |
| R11 | **`.cmd` 必须纯 ASCII** | `[实测]` | `cmd.exe` 按 OEM 代码页解析批处理文件，UTF-8 中文/制表符注释会被解码成命令并执行（实测报 `'WRITE_RESTRICTED' 不是内部或外部命令`）。所有 `.cmd` 保持 ASCII，中文说明放 `.md` |
| R12 | **Job 结构长度必须精确** | `[实测]` | `QueryInformationJobObject` 要求传入长度**恰好等于**结构大小，多一字节即返回 Win32 24（`ERROR_BAD_LENGTH`）。`JobObjectBasicAccountingInformation` 实测唯一可接受值为 **48**；传 64 会导致"Job 不可用"的假故障 |

---

## 14. 引用来源

- [Restricted Tokens — Win32 apps](https://learn.microsoft.com/en-us/windows/win32/secauthz/restricted-tokens)
- [Job Objects — Win32 apps](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)
- [AppContainer isolation — Win32 apps](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation)
- [Install Windows Sandbox](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-install)
- [Windows Sandbox sample configuration](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-sample-configuration)
- 本机实测输出：`src/cli.mjs probe`、`src/cli.mjs audit`、`tests/selftest.mjs`
- 内置后端文档：`node_modules/@deepseek-ai/dsh-sandbox-windows-acl/README.md`
- 设计依据：《Agent 沙箱暂存—提交架构设计手册 v3.0》
