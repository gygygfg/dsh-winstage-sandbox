# NeoAI 沙箱能力分析与差距输入

> 分析对象：GitHub `gygygfg/NeoAI`（默认分支 `master`，分析时 HEAD = `34a781defb51ce42802d697fffc9396b504ba152`，2026-09-30）
> 分析方法：GitHub REST API 枚举文件树 → `raw.githubusercontent.com` 逐文件读取源码与设计文档 → 提取机制/代码证据。
> 证据分级：**【直接观测】**= 本次抓取到的原始代码/文档原文；**【文档声明】**= 仅设计文档声明、本次未读实现代码；**【推断】**= 分析者综合判断。

---

## 0. 结论速览（最重要的事实）

1. **仓库可访问且公开**，但 **`gygygfg/NeoAI` 不是 Windows 沙箱，也不是独立沙箱产品**：它是**一个 Neovim（Lua）AI 编程助手插件**，语言 `Lua`（GitHub 统计），其 `lua/NeoAI/sandbox/` 是一个**内嵌给 AI 工具调用用的 Linux 专用沙箱子系统**（`bwrap`/`unshare` + seccomp + cgroup v2 + overlayfs + 遮蔽挂载 + 用户态代理 + 审批流）。
2. **平台为 Linux-only，无任何 Windows/macOS 实现**：全树无 `.ps1/.bat/.cmd/.exe`、无 AppContainer/WFP/Job Object/注册表/令牌/Hyper-V/WSL/Docker Desktop 相关文件（本次对 382 个路径做了关键字筛查，见 §1.3）。
3. **隔离层次为 内核（命名空间/seccomp/cgroup/netfilter）+ 用户态（应用层代理、策略、审批、暂存与 CAS 发布）**，**不存在 hypervisor 级隔离**（无 VM/microVM/Windows Sandbox 对应物）。
4. 该项目**有若干真正由内核强制执行的强边界**（seccomp syscall 拒绝、设备节点屏障、`/proc/sys` 只读、敏感路径遮蔽、整机根 overlay 暂存、PID 命名空间），**同时存在明确自认的残余边界**（默认共享 netns、裸 TCP 不经代理、`/proc/net/*` 与 hostname 可见、默认载荷 uid=0）。

---

## 1. 访问结果（URL / 状态 / 获取方式）

### 1.1 逐个 URL 的实测结果

| URL | 结果 | 证据/说明 |
| --- | --- | --- |
| `https://github.com/gygygfg/NeoAI` | **失败** | `Error: web fetch failed: TypeError: fetch failed`（HTML 页面抓取通道不可用；非 404） |
| `https://api.github.com/repos/gygygfg/NeoAI` | **HTTP 200** | 返回仓库元数据：`"name":"NeoAI"`、`"private":false`、`"language":"Lua"`、`"default_branch":"master"`、`"size":19003`、`"stargazers_count":1`、`"pushed_at":"2026-09-30T10:49:44Z"` |
| `https://api.github.com/users/gygygfg/repos` | **HTTP 200** | 确认 `gygygfg/NeoAI` 存在且公开（同批返回 9 个公开仓库） |
| `https://api.github.com/repos/gygygfg/NeoAI/git/trees/master?recursive=1` | **HTTP 200** | `"truncated":false`，共 **382** 条目（346 个 blob + 目录节点）；本报告的文件清单与体积均来自此响应 |
| `https://api.github.com/repos/gygygfg/NeoAI/commits?per_page=10` | **HTTP 200** | 提交信息本身即沙箱证据（如 `fix(sandbox): PTY 路径补 OOM 归因`、`feat(sandbox): 本机网络访问按端口+服务进程粒度同意`） |
| `https://raw.githubusercontent.com/gygygfg/NeoAI/master/<path>` | **HTTP 200**（逐个文件） | 唯一可用的文件内容获取通道；本报告所有代码原文均来自该前缀 |
| `https://github.com/gygygfg` | 未单独抓取（通过 users API 间接确认） | — |
| `web_search`: `gygygfg NeoAI sandbox github` / `NeoAI sandbox windows` / `NeoAI 沙箱` | **无相关结果** | 返回的是无关项目（`neomjs/neo`、`neo.projectdiscovery.io`、`docs.neoagent.io`）。**网上没有关于 `gygygfg/NeoAI` 沙箱的第三方描述**，本报告内容全部来自仓库原文 |

### 1.2 获取方式（可复现）

```text
# 1) 仓库元数据 / 分支
GET https://api.github.com/repos/gygygfg/NeoAI
# 2) 全树
GET https://api.github.com/repos/gygygfg/NeoAI/git/trees/master?recursive=1
# 3) 原文
GET https://raw.githubusercontent.com/gygygfg/NeoAI/master/<path>
```

注意：`pwsh` 内的直接 HTTPS（`Invoke-RestMethod`/`curl.exe`）在本机沙箱环境下**失败或不可用**（TLS `基础连接已经关闭`、`curl.exe ... Access is denied`），因此全部内容只能经 `web_fetch` 工具获取；本报告未写入除本文件以外的任何文件。

### 1.3 本次实际读取原文的文件（证据基础）

| 文件 | 大小 | 读取状态 |
| --- | --- | --- |
| `lua/NeoAI/sandbox/runtime.lua` | 138,779 B | 全文（约 106 KB，尾部有系统截断） |
| `lua/NeoAI/sandbox/seccomp.lua` | 11,826 B | 全文 |
| `lua/NeoAI/sandbox/cgroup.lua` | 27,549 B | 全文 |
| `lua/NeoAI/sandbox/privilege.lua` | 37,050 B | 全文 |
| `lua/NeoAI/sandbox/risk.lua` | 23,505 B | 全文 |
| `lua/NeoAI/sandbox/conceal.lua` | 9,679 B | 全文 |
| `lua/NeoAI/sandbox/policy.lua` | 8,789 B | 全文 |
| `lua/NeoAI/sandbox/host_proxy.lua` | 30,055 B | 全文 |
| `lua/NeoAI/sandbox/net_consent.lua` | 20,124 B | 全文 |
| `lua/NeoAI/sandbox/net_gateway.lua` | 6,717 B | 全文 |
| `lua/NeoAI/sandbox/container.lua` | 12,119 B | 全文 |
| `lua/NeoAI/sandbox/init.lua` | 26,458 B | 全文 |
| `lua/NeoAI/default_config.lua` | 96,632 B | 全文（沙箱段完整） |
| `docs/en/sandbox.md` | 237,362 B | **部分**：仅取到约 100 KB（到 systemd `--user` 一节） |
| `lua/NeoAI/tests/test_sandbox_boundary_escape.lua` | — | 全文（边界断言矩阵） |
| `scripts/sandbox_audit.lua` | 9,003 B | 全文（项目自带逃逸/泄露审计脚本） |

---

## 2. 沙箱子系统的文件级清单（职责）

`lua/NeoAI/sandbox/` 共 **62 个模块，约 1.4 MB Lua 源码**（另有 30+ 个 `tests/test_sandbox*` 测试）。

### 2.1 内核/隔离后端（本次读到实现代码）

| 文件 | 体积 | 职责（【直接观测】） |
| --- | --- | --- |
| `sandbox/runtime.lua` | 138,779 | 外部隔离后端探测与进程前缀构造：优先 `bwrap`，退化 `unshare`；只读白名单挂载、`mask_paths` 遮蔽、`/proc/sys` 只读、私有 tmpfs 根、capability 收敛、`setpriv` 降权、overlay 能力实测、`conceal` 私有目录 |
| `sandbox/seccomp.lua` | 11,826 | 生成并施加 seccomp BPF denylist（x86_64/aarch64 双架构）：arch 不符即 `KILL_PROCESS`、x32 ABI 位守卫、危险 syscall 表、`socket` 地址族白名单、`clone/clone3` 命名空间标志过滤、`mknod/mknodat` 设备节点屏障 |
| `sandbox/cgroup.lua` | 27,549 | cgroup v2 资源域：`memory.max`/`pids.max`/`cpu.max`、共享父域全局 CPU 预算、`cgroup.kill` 整树终止、OOM 归因、可写委派子树（供沙箱内 systemd 用） |
| `sandbox/privilege.lua` | 37,050 | T0/T1/T2 权限档位与自动提权：命令分段分类（包安装/容器/网络/系统管理/降权包装器）、`cap_add`/挂载/解除遮蔽/嵌套 userns、docker socket 受控挂载 |
| `sandbox/conceal.lua` | 9,679 | 反指纹与输出脱敏：overlay 挂载选项改写、`bwrap`→`init`、`EROFS`→`EACCES`、沙箱自有路径替换 |
| `sandbox/host_proxy.lua` | 30,055 | 宿主侧应用层过滤代理（HTTP CONNECT / 绝对形式 / SOCKS5）：拦截指向宿主本机（回环/宿主网卡/169.254/fe80）、DNS 单次解析防 rebinding、软件源自动放行、fail-closed |
| `sandbox/net_consent.lua` | 20,124 | 网络访问同意服务：按 `host:port@<服务进程>` 颗粒度记忆、`/proc/net/tcp*` LISTEN inode→PID 归属解析、超时自动拒绝、headless 失败关闭 |
| `sandbox/net_gateway.lua` | 6,717 | 独立 netns + veth + `iptables` 的「仅可达宿主网关」模式（需 root + `ip`） |
| `sandbox/container.lua` | 12,119 | 容器运行时门面：podman/buildah 注入 `--net/pid/ipc/uts=host` 共享沙箱命名空间；docker/nerdctl 明确拒绝或改写为 podman |
| `sandbox/policy.lua` | 8,789 | 策略评估与聚合（`DENY > NEEDS_CONFIRMATION > ALLOW`），受限 Lua 规则执行（`setfenv` 白名单 + 关 JIT + 指令/墙钟预算） |
| `sandbox/risk.lua` | 23,505 | 安全级别 L0–L3 评估、审批动作建议、**内核/破坏性命令硬拒绝**（`deny_reason`）、代理规避检测、本机 SSH 目标拒绝 |
| `sandbox/init.lua` | 26,458 | 控制面门面：`init/probe/gate/attach/commit/discard/list/show`、异步审查队列、任务授权、证据分页、依赖闭包与组合发布 |

### 2.2 暂存/发布/审批（本项目文档逐条列出其职责，本次仅读 `init.lua` 与文档）

| 文件 | 体积 | 职责（【文档声明】+ `init.lua` 观测） |
| --- | --- | --- |
| `sandbox/candidate.lua` | 169,629 | 私有暂存、候选冻结、CAS 发布、overlay 捕获/物化、白障（whiteout）、`.git` 原子分组（object→pointer） |
| `sandbox/wrapper.lua` | 128,652 | 执行门禁：`attach` 工具规格、`gate` 所有执行、后处理（捕获/冻结/结算）、结果脱敏改写 |
| `sandbox/review.lua` | 70,591 | 异步审查：change set 队列、`review_state`/`apply_state`、选择性应用、撤销/重做快照、依赖闭包 |
| `sandbox/store.lua` | 33,507 | 候选/回执持久化、快照元数据、异步写入与 flush |
| `sandbox/host_proxy.lua` 已列于上 | — | — |
| `sandbox/resident.lua` | 39,949 | 会话常驻沙箱实例（长驻命名空间内的命令服务器，支持后台进程跨调用存活） |
| `sandbox/secret.lua` | 90,567 | 密钥防护：高熵检测 → **格式保真"假密钥"**替换、进程内映射、落盘/执行时还原 |
| `sandbox/systemd.lua` | 122,016 | systemd 门面：在沙箱内完整模拟 `systemctl/journalctl/systemd-run/systemd-analyze/hostnamectl/timedatectl/dmesg`，**从不调用宿主 systemd** |
| `sandbox/writer.lua` | 15,446 | 发布写入器：先非 root，权限错误 → `NEEDS_ROOT`，审批后 root/`sudo`(tty) |
| `sandbox/audit.lua` / `ai_audit.lua` | 4,531 / 16,166 | AI 读写/调用行为监控与风险分；把待审变更交给模型逐条裁决（**建议**，不自动应用） |
| `sandbox/script_scan.lua` | 20,789 | 间接脚本执行静态扫描（shell 正文 + 高级语言内嵌 shell、递归、不可解析=不透明） |
| `sandbox/observe.lua` / `observer.lua` / `trace.lua` / `evidence.lua` | 7,390 / 26,487 / 4,724 / 5,594 | 影响记录（fs/process/network）、eBPF/strace/procfs 观测后端、越界访问留痕、证据分页（不含文件内容） |
| `sandbox/grant.lua` / `replay.lua` / `cache.lua` / `control.lua` / `tool_spec.lua` / `diag.lua` | 4,577 / 2,569 / 3,264 / 7,174 / 7,072 / 8,451 | 窄范围任务授权（scope/operations/budget/ttl/撤销）、策略回放、内容寻址缓存、ID/状态机/幂等键/租约、按工具效果分类、故障注入与基准 |
| `sandbox/service.lua` / `systemd_ipc.lua` / `systemd_user.lua` | 20,781 / 6,763 / 2,172 | 沙箱内长驻服务（自有 overlay + cgroup）、systemd 门面的宿主侧 IPC 桥、`systemctl --user` 伪解析 |
| `sandbox/network.lua` / `gateway.lua` / `broker.lua` / `hostop.lua` | 2,109 / 9,047 / 5,706 / 7,577 | 受控网络网关与声明式端点、网关探针服务、外部操作适配器协议、主机操作提案（审批后在宿主 replay） |
| `sandbox/disk.lua` / `background.lua` / `instance.lua` / `exec.lua` / `lsp.lua` / `git_guard.lua` / `l3_warning.lua` / `approval_hub.lua` | 5,431 / 1,750 / 3,498 / 12,060 / 15,292 / 3,655 / 6,114 / 6,488 | 暂存磁盘上限门禁、后台命令识别、每进程实例隔离、进程前缀执行封装、沙箱内 LSP overlay、git 目标守卫、L3 二次确认警告、多页审批分流中心 |
| `sandbox/envelope.lua` / `impact.lua` / `bench.lua` / `fault.lua` | 139 / 137 / 130 / 130 | **兼容 shim**，实际已并入 `observe.lua`（文档说明） |
| `sandbox/writer.lua`、`sandbox/review.lua`、`sandbox/candidate.lua`、`sandbox/wrapper.lua`、`sandbox/store.lua`、`sandbox/resident.lua`、`sandbox/secret.lua`、`sandbox/systemd.lua` | 见上 | 体积最大的 8 个模块（合计 ~700 KB），本次未逐行通读 |

### 2.3 仓库中**不存在**的隔离技术（对 382 个路径做过关键字筛查）

**未发现**：`AppContainer`、`WDAC`、`WFP`、`Job Object`、`token`（Windows 令牌）、`registry`（注册表）、`Hyper-V`、`WSL`、`Docker Desktop`、`sandboxie`、`firejail`、`bubblewrap 之外的 jail`、`landlock`、`AppArmor`、`SELinux` 策略、`microVM`/`gVisor`/`Kata`。
出现在路径名中的 `registry.lua`/`window/*` 均与隔离无关（模型注册表、UI 窗口）。

---

## 3. 能力矩阵（逐项：机制 / 强制层 / 隔离对象 / 强制性 / 证据）

> 「隔离对象」列取值：fs / net / registry / process / ipc / window。**registry 与 window 在本项目为 N/A（Linux 进程，无注册表；Neovim 是 TUI，无 GUI 桌面对象隔离）**。
> 「强制/建议」列：**强制（kernel）**= 内核或内核接口拒绝；**强制（宿主用户态）**= 宿主侧进程/代理真正拦截；**建议（用户态策略）**= 仅影响审批/风险分级/记录，不构成隔离边界。

### 3.1 文件系统与挂载

| 能力 | 机制 | 强制层 | 隔离对象 | 强制性 | 证据（路径 + ≤5 行原文 + 原始 URL） |
| --- | --- | --- | --- | --- | --- |
| 挂载命名空间隔离 | `bwrap` 前缀 + 只读白名单挂载 + 私有 tmpfs 根 | 内核 | fs | 强制 | `lua/NeoAI/sandbox/runtime.lua`：<br>`argv[#argv + 1] = "bwrap"`<br>`argv[#argv + 1] = "--die-with-parent"`<br>`if not no_pid_ns then argv[#argv + 1] = "--as-pid-1" end`<br>`for _, f in ipairs({ "--dev", "/dev", "--proc", "/proc" }) do`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/sandbox/runtime.lua |
| 整机根只读 + overlay 暂存（COW） | `--overlay-src <root> --overlay <upper> <work> <root>`，写入只进 upper；不支持 overlay 时降级 bind+seed | 内核（overlayfs） | fs | 强制 | 同上：<br>`table.insert(argv, "--overlay-src"); table.insert(argv, ov.root)`<br>`table.insert(argv, "--overlay"); table.insert(argv, ov.upper)`<br>`table.insert(argv, ov.work); table.insert(argv, ov.root)` |
| 宿主敏感路径遮蔽 | 目录 → 空 `--tmpfs`；文件/socket → `--bind /dev/null`（socket 变字符设备，`connect` 返回 `ENOTSOCK`） | 内核 | fs、进程控制通道 | 强制 | 同上：<br>`if mp.kind == "dir" then`<br>`  table.insert(argv, "--tmpfs"); table.insert(argv, mp.path)`<br>`else`<br>`  table.insert(argv, "--bind"); table.insert(argv, "/dev/null"); table.insert(argv, mp.path)` |
| 默认遮蔽清单 | `DEFAULT_MASK_PATHS` 内置（docker.sock/containerd/podman、D-Bus、systemd、`/root/.ssh`、`/home/*/.ssh`、keyring、`/etc/shadow`、`/etc/sudoers`、`/etc/machine-id`、`/var/log`、cron、shell history…） | 内核 | fs、凭据、进程控制 | 强制 | 同上：<br>`local DEFAULT_MASK_PATHS = {`<br>`  "/run/docker.sock", "/var/run/docker.sock",`<br>`  "/run/containerd", "/run/containerd/containerd.sock",` |
| `/proc` 泄露项遮蔽 + `/proc/sys` 只读 | 强制 `MANDATORY_PROC_MASKS`（`core_pattern`、`modprobe`、`kexec_load_disabled`、`unprivileged_bpf_disabled`…）+ 用户可增项；以空文件只读覆盖 | 内核（只读 bind） | fs、内核状态 | 强制 | 同上：<br>`local MANDATORY_PROC_MASKS = {`<br>`  "/proc/sys/kernel/core_pattern",`<br>`  "/proc/sys/kernel/modprobe",`<br>（注释：写返回 `EROFS`，从根上封死 coredump/modprobe 提权原语） |
| 每会话私有 `/tmp`、`/var/tmp`、`/run` | 会话私有目录 bind 回根路径，**绝不把宿主真实 `/tmp` 作为 lower** | 内核 | fs、ipc（临时文件） | 强制 | 同上：<br>`_append_tmpfs_roots(argv, opts.session_tmp_dir, opts.tmpfs_base)`<br>（注释：`绝不把宿主真实 /tmp、/var/tmp 作为 lower/内容暴露`） |
| 设备节点创建屏障 | `mknod/mknodat` 的 `S_IFCHR\|S_IFBLK` 位 → `EPERM`（FIFO/普通文件放行） | 内核（seccomp-BPF） | fs、块设备 | 强制 | `lua/NeoAI/sandbox/seccomp.lua`：<br>`local S_IFDEV_MASK = 0x6000`<br>`parts[#parts + 1] = _insn(BPF_JEQ_K, 0, 3, spec.mknodat) -- nr==mknodat ? 检查 mode : 跳过`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/sandbox/seccomp.lua |
| 候选冻结 + CAS 发布 + 冲突检测 | 暂存 → 冻结（SHA-256）→ 校验/授权 → `candidate.publish`；CAS 模式默认 `hash`（逐文件整读+哈希） | 宿主用户态 | fs | 强制（写入真实工作区必经此路径） | `lua/NeoAI/sandbox/init.lua`：<br>`local pub = candidate.publish(cand, opts or {})`<br>`if pub.ok then`<br>`  store.write_receipt(pub.receipt)`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/sandbox/init.lua |
| 暂存磁盘上限 | 统计暂存基目录 + 存储根占用，超限（默认 **64 GiB**）拒绝新的写类/进程工具 | 宿主用户态 | fs（磁盘耗尽） | 强制（拒绝执行） | `lua/NeoAI/default_config.lua`：<br>`disk_bytes = 64 * 1024 * 1024 * 1024, -- 64 GiB`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/default_config.lua |

### 3.2 系统调用 / 进程 / 权限

| 能力 | 机制 | 强制层 | 隔离对象 | 强制性 | 证据 |
| --- | --- | --- | --- | --- | --- |
| seccomp syscall 拒绝表 | 自建 BPF（无 libseccomp 依赖）；x86_64 拒绝 `ptrace`、`pivot_root`、`chroot`、`mount/umount2`、`swapon/swapoff`、`reboot`、`iopl/ioperm`、`init_module/delete_module`、`kexec_load`、`keyctl`、`unshare`、`perf_event_open`、`open_by_handle_at`、`setns`、`process_vm_*`、`bpf`、`userfaultfd`、`io_uring_*`、`open_tree/move_mount/fsopen/fsconfig/fsmount/fspick`、`pidfd_getfd`、`process_madvise`、`mount_setattr` 等 | 内核 | process、fs、内核状态 | 强制 | 同上 seccomp.lua（`local ARCH = { x86_64 = { ... blocked = { 101, -- ptrace`） |
| 架构不匹配即杀进程 + x32 守卫 | `JEQ arch → KILL_PROCESS`；`nr & __X32_SYSCALL_BIT` 即 `KILL_PROCESS`（防 x32 号段绕过 denylist） | 内核 | process | 强制 | 同上：<br>`parts[#parts + 1] = _insn(BPF_JEQ_K, 1, 0, spec.audit)`<br>`parts[#parts + 1] = _insn(BPF_RET_K, 0, 0, SECCOMP_RET_KILL_PROCESS)`<br>`parts[#parts + 1] = _insn(BPF_JSET_K, 0, 1, X32_SYSCALL_BIT)` |
| 嵌套命名空间封堵 | `unshare/setns` 在 denylist；`clone/clone3` 带 `CLONE_NEW*`（`0x7E020000`）→ `EPERM`；`clone3` → `ENOSYS` | 内核 | process、net、fs | 强制 | 同上：<br>`local CLONE_NS_MASK = 0x7E020000`<br>`parts[#parts + 1] = _insn(BPF_JSET_K, 0, 1, CLONE_NS_MASK)`<br>`parts[#parts + 1] = _insn(BPF_RET_K, 0, 0, SECCOMP_RET_ERRNO_ENOSYS)` |
| 地址族白名单 | `socket()` 仅放行 AF_UNIX/AF_INET/AF_INET6/AF_NETLINK；`AF_VSOCK`（可绕过 netns 直连宿主）等 → `EPERM` | 内核 | net、host 服务 | 强制 | 同上：<br>`local AF_ALLOW = { 1, 2, 10, 16 }`<br>（注释：`尤其 AF_VSOCK 不受网络命名空间隔离，也不经代理，可直达宿主 vsock 服务`） |
| PID 命名空间隔离 | `--unshare-pid --as-pid-1`（LSP 场景可 `no_pid_ns` 关闭） | 内核 | process | 强制 | runtime.lua `--as-pid-1`（见上）；测试断言见 3.5 |
| `NoNewPrivs=1` | bwrap 设置 NNP，使 setuid/文件能力被忽略 | 内核 | process、权限提升 | 强制 | `lua/NeoAI/tests/test_sandbox_boundary_escape.lua`：<br>`t.matches("NoNewPrivs:%s+1", out, "载荷应带 NoNewPrivs=1")` |
| Capability 收敛 | 默认 `--cap-drop ALL` + 档位 `--cap-add`；另有**全局 `cap_drop`**（即使 `cap_add=ALL` 也逐项丢弃 `CAP_NET_ADMIN/CAP_SYS_TIME/CAP_SYS_MODULE/CAP_SYS_RAWIO/CAP_SYS_BOOT/CAP_MAC_ADMIN/CAP_MAC_OVERRIDE/CAP_AUDIT_CONTROL`） | 内核 | process、宿主全局状态 | 强制 | runtime.lua：<br>`if not full then`<br>`  argv[#argv + 1] = "--cap-drop"`<br>`  argv[#argv + 1] = "ALL"`<br>`end` |
| 载荷身份降权（可选） | root 启动时可用 `setpriv --reuid <uid> --regid <gid>` 让**载荷**非 root（bwrap 仍 root 以完成挂载）；嵌套 userns 档位时保持 userns root（能力被 userns 作用域限制） | 内核（uid/gid） | process | 强制（但**默认 `run_as.uid = 0`，即不降权**） | runtime.lua：<br>`if root_drop and not userns then`<br>`  for _, c in ipairs({ "CAP_SETUID", "CAP_SETGID" }) do`<br>`    argv[#argv + 1] = "--cap-add"; argv[#argv + 1] = c`<br>默认值见 `default_config.lua`：`run_as = { uid = 0, gid = 0 }` |
| 进程树精确终止 | `cgroup.kill`（按资源域），避免 `jobstop` 只杀外层 bwrap 而载荷存活；超时/取消/输出截断均走此路径 | 内核（cgroup v2） | process | 强制 | `lua/NeoAI/sandbox/cgroup.lua`：<br>`  pcall(_write_file, handle.path .. "/cgroup.kill", "1")`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/sandbox/cgroup.lua |
| 资源限制 | `memory.max`（动态=宿主内存×0.75，受容器配额封顶）、`pids.max`（默认 8192）、`cpu.max`（全局预算 `max(1,核数-2)`，父域封顶防超卖）、CPU 亲和性 `taskset` | 内核（cgroup v2） | process（CPU/内存/PID） | 强制，但**能力缺失时默认 fail-open**（`limits.fail_closed=false`） | 同上：<br>`applied.memory = _write_file(path .. "/memory.max", tostring(limits.memory_bytes))`<br>`_write_file(parent .. "/cpu.max", tostring(global_us) .. " 100000")` |
| 权限档位 T0/T1/T2 | T0 最小（`CAP_DAC_OVERRIDE/SETUID/SETGID`）；T1 提权（网络、受控 docker socket）；T2 特权（嵌套 userns + `cap_add=ALL`，主机效果冻结为提案待审） | 内核（参数）+ 宿主用户态（审批） | process、fs、net | T0/T1 自动；**T2 需审批**；超 `max_tier` 直接拒绝 | `lua/NeoAI/sandbox/privilege.lua`：<br>`[0] = {`<br>`  name = "minimal", review = "auto", network = true,`<br>`  cap_add = { "CAP_DAC_OVERRIDE", "CAP_SETUID", "CAP_SETGID" }, mounts = {}, unmask = {},`<br>`},`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/sandbox/privilege.lua |
| 内核/破坏性命令硬拒绝（不可被用户确认覆盖） | 首词命中 `DENY_BINS`（`modprobe/insmod/rmmod/sysctl/kexec/reboot/poweroff/setcap/swapon...`）→ 拒绝；`CAP_GATED_BINS`（iptables/nft…）按能力判定；L3 破坏性模式（`mkfs`、`of=/dev/`、`wipefs`、fork 炸弹、`curl\|sh`）→ `DESTRUCTIVE` 拒绝 | 宿主用户态（策略） | process、fs（块设备/磁盘） | **强制（硬拒绝层，不执行）** | `lua/NeoAI/sandbox/risk.lua`：<br>`local DENY_BINS = {`<br>`  -- 内核模块与内核状态`<br>`  modprobe = true, insmod = true, rmmod = true, kmod = true, modinfo = true,`<br>`  ...`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/sandbox/risk.lua |
| 继承 fd 关闭 | 载荷启动前关闭除 0/1/2 外所有 fd（bash → python3 `os.closerange` → sh 三级回退）：防止用 `openat(dir_fd, "..")` 逐级逃出 chroot/命名空间 | 宿主用户态（包装脚本体） | fs、process | 强制（包装器执行） | runtime.lua：<br>`local PY_FD_CLOSE = "import os,sys; os.closerange(3, 65536); os.execvp(sys.argv[1], sys.argv[1:])"` |
| 策略受限执行 | 规则以白名单 env + `setfenv` 真隔离执行，禁 `os/io/debug/load/require`，关 JIT 后以 `debug.sethook` 施加指令预算（20 万）与墙钟预算（100 ms）；失败/超时/结构错误统一 `DENY` | 宿主用户态 | process（规则自身） | 强制（fail-closed） | `lua/NeoAI/sandbox/policy.lua`：<br>`if type(setfenv) ~= "function" or type(getfenv) ~= "function" then`<br>`  return false, "POLICY_ISOLATION_UNAVAILABLE"`<br>`end`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/sandbox/policy.lua |

### 3.3 网络

| 能力 | 机制 | 强制层 | 隔离对象 | 强制性 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 默认**不**隔离网络命名空间 | T0 标志集 `NO_USER_FLAGS` **不含** `--unshare-net`；`offline=false` 为默认 | 无 | net | **不隔离（残余边界）** | runtime.lua：<br>`-- 同时保留 mount/pid/ipc/uts/cgroup 隔离。net 不隔离（默认共享），offline 时另加 --unshare-net。`<br>`local NO_USER_FLAGS = { "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup" }` |
| 宿主本机访问拦截（应用层代理） | 宿主启动 HTTP CONNECT / 绝对形式 / SOCKS5 代理；解析目标 IP，命中回环 `127/8`、`::1`、宿主网卡 IP、`169.254/16`（含云元数据）、`fe80::/10` → 拦截；`offline=true` 时硬拒绝网络工具 | 宿主用户态（代理） | net（本机/SSRF） | **强制但仅对走代理的工具**；裸 TCP 绕过（作者自认） | `lua/NeoAI/sandbox/host_proxy.lua`：<br>`--- 边界（见 docs/sandbox.md）：这是**应用层**过滤。不认代理的裸 TCP（nc/ssh/数据库客户端等）`<br>`--- 不经代理即可直连，不受拦截——共享 netns 下无法在内核层按目的地过滤`<br>`if policy == "deny" then return cb(false, block_reason) end`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/sandbox/host_proxy.lua |
| DNS rebinding 防护 | 目标域名只解析一次，校验与连接复用同一批 IP（不再二次解析） | 宿主用户态 | net | 强制 | 同上：<br>`local target = (#ips > 0) and ips[1] or host`（注释：`避免 DNS rebinding 在校验与连接之间切换答案`） |
| 失败关闭（解析失败视为本机） | 域名无法解析时 `return true, {}` 即按"本机"进入拦截/询问分支 | 宿主用户态 | net | 强制 | 同上：<br>`if #ips == 0 then return true, {} end -- 解析失败：无法证明非本机，fail-closed` |
| 按端口 + 服务进程粒度的用户同意 | `/proc/net/tcp{,6}` LISTEN inode ↔ 全 PID 域 fd 扫描定位宿主监听进程，白名单键细化为 `host:port@<exe>`；每次连接以短 TTL 重校验；**超时（默认 30 s）自动拒绝**；headless 无 UI 一律拒绝 | 宿主用户态 | net | **强制（默认 `access="ask"`）**，但属"人工闸门"而非隔离 | `lua/NeoAI/sandbox/net_consent.lua`：<br>`owner = {`<br>`  pid = tonumber(name),`<br>`  comm = (comm and comm:gsub("%s+$", "")) or "?",`<br>`if tms > 0 then`<br>`  vim.defer_fn(function() ... decide("deny") end, tms)`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/sandbox/net_consent.lua |
| 沙箱内自建服务免权限 | 以 cgroup 归属（路径含 `/neoai/`）判定 LISTEN socket 持有者：沙箱自己监听的回环端口自动登记免权限（宿主回环服务仍询问） | 宿主用户态 | net | 判定逻辑（策略） | 同上：<br>`function M._is_sandbox_cgroup(text)`<br>`  return type(text) == "string" and text:find("/neoai/", 1, true) ~= nil` |
| 独立 netns + 仅可达宿主网关（强隔离模式，需 root） | `ip netns add` + veth 对 + 默认路由指向网关；`iptables -I INPUT` 仅按"目的地址+端口"放行网关端口，`-I FORWARD -i <veth> -j DROP` 阻断转发直达局域网/外网 | 内核（netns + netfilter） | net | 强制（opt-in；非默认） | `lua/NeoAI/sandbox/net_gateway.lua`：<br>`if not _ns_run(ns, { "ip", "route", "add", "default", "via", gw_ip }) then return fail("GATEWAY_ROUTE_FAILED") end`<br>`local fwd_rule = { "-i", h, "-j", "DROP" }`<br>`if vim.uv.getuid and vim.uv.getuid() ~= 0 then return false, "GATEWAY_NEEDS_ROOT" end`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/sandbox/net_gateway.lua |
| 代理规避检测 | 静态识别 `unset *proxy`、`env -u *proxy`、`--noproxy`、`--proxy ""`、变量间接（`c=--noproxy`）等显式旁路 | 宿主用户态 | net | 硬拒绝（策略） | risk.lua：<br>`if first == "unset" then`<br>`  for i = 2, #toks do`<br>`    if _is_proxy_var(toks[i]) then return "PROXY_EVASION:unset" end` |
| 本机 SSH 服务禁止 | `ssh/scp/sftp/sshpass/ssh://` 指向 `localhost/127./::1/0.0.0.0/169.254.` → 命令级拒绝（配合遮蔽 `/run/sshd`、`SSH_AUTH_SOCK` 清理） | 宿主用户态 | net、凭据 | 硬拒绝（策略） | risk.lua：<br>`local SSH_LOCAL_TARGETS = { "localhost", "127.", "::1", "[::1]", "0.0.0.0", "169.254." }` |
| 软件源自动放行 | 内置包源域名后缀表（pypi/npm/crates/debian/ubuntu/alpine/国内镜像…）+ 用户扩展；本机目标不走此分支 | 宿主用户态 | net | 策略（减少弹窗） | host_proxy.lua：<br>`local PACKAGE_SOURCE_SUFFIXES = {`<br>`  "pypi.org", "pythonhosted.org", "pypi.python.org",` |
| 容器门面 | podman/buildah 注入 `--net/pid/ipc/uts=host` 使容器与沙箱同命名空间；docker/nerdctl 无守护进程共享 → 明确拒绝或改写为 podman | 宿主用户态 + 内核（后续共享 ns） | process、fs、net | 强制（拒绝/改写） | `lua/NeoAI/sandbox/container.lua`：<br>`local SHARE_FLAGS = { "--net=host", "--pid=host", "--ipc=host", "--uts=host" }`<br>`plan.reason = "DOCKER_NAMESPACE_NOT_SHARABLE"`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/sandbox/container.lua |

### 3.4 审批 / 策略 / 审计 / 密钥 / 反指纹

| 能力 | 机制 | 强制层 | 隔离对象 | 强制性 | 证据 |
| --- | --- | --- | --- | --- | --- |
| 默认异步审批（dry-run & commit） | 工具默认在沙箱内**立即执行并冻结候选**，真实工作区修改进入待审队列；`mode="dry_run"` 为默认；`approval.mode="async"` | 宿主用户态 | fs（真实工作区） | 强制（工作区写入必经 commit） | `lua/NeoAI/default_config.lua`：<br>`mode = "dry_run", -- dry_run（默认，仅出候选）\| commit（授权后立即 CAS 发布）`<br>`mode = "async", -- async（默认，异步审批：立即沙箱执行，事后确认应用）` |
| 安全级别 L0–L3 与分级审批 | 路径级别（工作区/用户目录/系统路径）、网络、包安装、权限档位、密钥作用域、危险命令模式综合定级；动作 `auto/record/review/block`；密钥与包安装永不因会话自动审批跳过 | 宿主用户态 | fs、process、凭据 | 建议（决定审批路径，非隔离） | `lua/NeoAI/sandbox/risk.lua`：<br>`M.LEVEL = { LOW = 0, MODERATE = 1, HIGH = 2, CRITICAL = 3 }`<br>`if opts.secret then return "review" end`<br>（`l3_warning.enabled` + `package_confirm=true`：L3/敏感安装需 AI 后果警告 + 二次确认） |
| 策略聚合 | `DENY > NEEDS_CONFIRMATION > ALLOW`；约束取更严格交集（数值取 min、列表取交集） | 宿主用户态 | 全部 | 强制（fail-closed） | `lua/NeoAI/sandbox/policy.lua`：<br>`-- 3) 聚合：DENY > NEEDS_CONFIRMATION > ALLOW；约束取更严格交集` |
| 不可绕过的硬拒绝 | 设计不变量：**硬拒绝不可被人工确认覆盖**；`policy.deny_tools` 亦不可覆盖 | 宿主用户态 | 全部 | 强制（设计不变量 + 文档/门禁） | `lua/NeoAI/sandbox/init.lua`：<br>`--- 不变量（设计文档 §1.1）：`<br>`---   dry-run 不构成安全边界；隔离执行只改私有状态；commit 只发布已冻结候选；`<br>`---   硬拒绝不可被确认覆盖；未知结果不报告为成功。` |
| 脚本间接执行静态扫描 | `bash deploy.sh` / `python setup.py` / `bash -c` / `./run.sh` 等读取脚本正文（优先暂存副本）折叠进危险识别；不可解析（eval、`base64\|sh`、动态 `-c "$VAR"`、读不到）=**不透明**→ 提升级别并强制复核 | 宿主用户态 | fs、process | 建议（提升审批级别；脚本内破坏性命令仍硬拒绝） | `docs/en/sandbox.md`：<br>`- device-level/kernel commands inside scripts are **hard denied** (same rule as direct commands);`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/docs/en/sandbox.md |
| 密钥假化与出网守卫 | 高熵/具名规则命中 → 替换为**格式保真假密钥**（同长度/同字符类，进程内映射不落盘）；向非白名单主机发送密钥时经 `utils.http` 守卫弹窗阻止；密钥数据流账本，不可逆派生文件发布前强制人工确认 | 宿主用户态 | fs、net（凭据外泄） | 建议/强制混合（"真实密钥出现即停止 Agent"= 强制） | `lua/NeoAI/default_config.lua`（`secrets` 段）：<br>`enabled = true, -- 总开关`<br>`flow_tracking = true,`<br>`alert = { enabled = true, timeout_ms = 0, -- 0 = 不超时（一直等待用户决策） }` |
| 越界访问留痕 | `read_all` 下可读但被记录，审批悬浮窗展示（工具/类型/命令/时间）；排除沙箱自身路径与包缓存 | 宿主用户态 | fs（信息面） | 建议（记录） | runtime.lua：<br>`function M.outside_workspace(path, cwd)`<br>（注释：`用于越界访问留痕（read_all 下这些目录可读，但会记录并在审批悬浮窗展示）`） |
| 反指纹（弱） | 进程名/挂载选项/错误码改写：`bwrap`→`init`、`lowerdir=hidden`、`EROFS`→`EACCES`、沙箱路径→`/tmp/.cache`；PID1 伪装为 systemd（`/proc/1/comm\|cmdline\|stat\|status`，仅 PID ns 生效） | 宿主用户态 | 信息面 | **建议（作者自认尽力而为，不可检测性不成立）** | `lua/NeoAI/sandbox/conceal.lua`：<br>`--- 边界：本层为「抬高识别门槛」的尽力而为，不声称让沙箱不可检测；namespace inode、`<br>`s = s:gsub("lowerdir=[^,%s]+", "lowerdir=hidden")`<br>`s = s:gsub("bwrap", "init")`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/sandbox/conceal.lua |
| systemd 门面（不触碰宿主） | 沙箱内 `systemctl/journalctl/systemd-run/...` 被薄入口覆盖，经 `/run/systemd/units` 文件 IPC 转发给宿主 Lua 门面；服务进程在沙箱命名空间内由其自有 overlay + cgroup 承载；**明确拒绝** `.socket` 单元、模板单元与 `poweroff/reboot/kexec` | 宿主用户态 | process、fs（配置） | 强制（不调用宿主 systemd；输出与退出码仿真） | `docs/en/sandbox.md`：<br>`the **host systemd is never called and the host is never`<br>`modified**.`<br>`**Explicitly rejected (no host fallback, no hostop)**: `.socket` units, template/instance` |
| 自带逃逸审计脚本 | 从沙箱内运行探测命令并结构化输出（`write_*` 期望 READONLY；`raw_tcp_host`/`proc_net_*`/`ip_*` 标注为已知残余），并旁路检查 `read_file` 是否泄露 overlay 真实路径 | 宿主用户态（离线脚本） | 全部（自检） | 工具（非强制） | `scripts/sandbox_audit.lua`：<br>`-- 关注：所有 `write_*` 应为 READONLY；`raw_tcp_host`/`proc_net_*`/`ip_*` 为已知残余边界。`<br>https://raw.githubusercontent.com/gygygfg/NeoAI/master/scripts/sandbox_audit.lua |

### 3.5 由测试固化的"真实强制"证据（最有力的旁证）

`lua/NeoAI/tests/test_sandbox_boundary_escape.lua` 直接对真实 bwrap 沙箱断言内核行为：

```lua
t.eq(0, #wrong, "denylist syscall 应全部返回 EPERM(1)，异常: " .. table.concat(wrong, ","))
t.matches("clone3=38", out, "clone3 应返回 ENOSYS(38)")
t.matches("clone_newuser=1", out, "clone(CLONE_NEWUSER) 应 EPERM(1)")
t.matches("vsock=1", out, "AF_VSOCK 应 EPERM(1)")
t.matches("chr=1", out, "字符设备 mknod 应 EPERM(1)")
t.matches("blk=1", out, "块设备 mknod 应 EPERM(1)")
t.matches("NoNewPrivs:%s+1", out, "载荷应带 NoNewPrivs=1")
t.matches("0", out:gsub("%s", ""), "沙箱内不应看到宿主标记进程")   -- PID ns
```
URL: https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/tests/test_sandbox_boundary_escape.lua

同文件还**把残余边界固化为"设计基线断言"**（一旦变化即告警）：

```lua
t.matches("NET_TCP_READABLE", out, "基线：/proc/net/tcp 可读（共享 netns 残余）")
t.matches("NET_UNIX_READABLE", out, "基线：/proc/net/unix 可读（共享 netns 残余）")
t.matches("HOSTNAME_VISIBLE", out, "基线：hostname 继承宿主")
```

另有端到端哨兵测试：写 `/etc/shadow` 后比对宿主 SHA-256 不变、在 `/usr`、`/var/log`、`/root`、`/etc` 放置哨兵文件后确认沙箱内 `echo HACKED > <哨兵>` **不落宿主**、`/run` 写入宿主不可见。

### 3.6 默认配置取值（影响"是否真的开启"）

| 配置键 | 默认值 | 含义 |
| --- | --- | --- |
| `tools.sandbox.enabled` / `fail_closed` | `true` / `true` | 沙箱服务缺失时**拒绝执行**，不静默降级 |
| `tools.sandbox.mode` | `"dry_run"` | 只出候选；`:NeoAISandboxCommit`/审批后 CAS 应用 |
| `tools.approval.mode` | `"async"` | 立即沙箱执行 + 事后异步确认 |
| `tools.sandbox.backend` | `"auto"` | 优先 bwrap，退化 unshare |
| `tools.sandbox.offline` | `false` | **网络默认放行（仅记录）**，靠 host_proxy 拦本机 |
| `tools.sandbox.require_seccomp` | `true` | 缺 seccomp 能力 → 拒绝外部执行（fail-closed） |
| `tools.sandbox.seccomp.enabled` | `true` | 施加 denylist 基线（仅 bwrap 后端） |
| `tools.sandbox.cap_add` | `{}` | 默认 `--cap-drop ALL`，按需窄加回 |
| `tools.sandbox.run_as` | `{uid=0, gid=0}` | **默认不降权**（写入仍全进 overlay） |
| `tools.sandbox.mask_paths` | 大体量内置清单 | 目录→空 tmpfs，文件/socket→`/dev/null` |
| `tools.sandbox.read_all`（`process_roots` 语义） | 整机根 overlay 默认可写暂存 | 根文件系统原样可写、写入全部进 upper |
| `tools.sandbox.staging_uncovered` | `"reject"` | 有暂存但无 overlay 可写层 → 拒绝执行 |
| `tools.sandbox.degraded_seed` | `true`（上限 2 GiB） | 无 overlay 时把可写根真实内容复制进私有副本 |
| `tools.sandbox.fuse_root_overlay` | `true`（产品默认；测试默认 false） | 内核 overlay 不可用时尝试 fuse-overlayfs 整机根（有"卡死宿主内核"风险，见 commit `3720e85`） |
| `tools.sandbox.limits` | 动态：内存=宿主×0.75、PID=8192、CPU=`max(1,核数-2)`；`fail_closed=false`；`disk_bytes=64 GiB` | 资源限制 |
| `tools.sandbox.packages.mode` | `"review"` | 包安装**永不自动落盘** |
| `tools.sandbox.review.session_auto_approve` | `false` | 不自动放行 |
| `tools.sandbox.review.cas_mode` | `"hash"` | 发布逐文件整读 + 哈希（最强一致性） |
| `tools.sandbox.network.access` / `host_local_block` | `"ask"` / 默认开启 | 外部访问询问；本机访问经代理拦截 |
| `tools.sandbox.network.gateway.enabled` | 默认 **false**（需显式开启，且需 root） | 独立 netns 强网络隔离非默认 |
| `tools.sandbox.privilege.max_tier` | `2` | 允许最高 T2 |
| `tools.sandbox.systemd.enabled` | 默认 enabled（`maintscript_stubs=true`） | systemd 门面 + `policy-rc.d` 桩 |
| `tools.sandbox.retention` | `candidate_days=7`, `max_pending=20` | 保留期 |
| `tools.sandbox.workspace_root` | `stdpath("cache")/NeoAI/sandbox`，按 `<pid>_<启动时间>` 分实例 | 多 nvim 会话审批互不可见 |

原始 URL：https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/default_config.lua

---

## 4. UNKNOWN / NOT VERIFIED（明确未证实项）

1. **`docs/en/sandbox.md` 只读约 43%**（237 KB 中取到约 100 KB，止于 systemd `--user` 一节）。**§6 之后的网络/密钥/权限档位/降级等章节未读到原文**——本报告中这些主题的证据来自源码（`runtime/seccomp/cgroup/privilege/risk/policy/host_proxy/net_consent/net_gateway`）与 `default_config.lua`，而非文档。
2. **未逐行通读的大模块**：`candidate.lua`(170 KB)、`runtime.lua`(139 KB, 尾部截断)、`wrapper.lua`(129 KB)、`systemd.lua`(122 KB)、`secret.lua`(91 KB)、`review.lua`(71 KB)、`resident.lua`(40 KB)、`store.lua`(34 KB)、`privilege.lua`(37 KB, 已读到主体但尾部截断)。→ 这些模块的**内部实现细节**（如 CAS 冲突判定算法、白障落盘顺序、快照无损性、密钥 tokenize 往返）本次**未验证**；其*对外承诺*来自 `init.lua`、`default_config.lua` 与文档，已标注【文档声明】。
3. **未运行任何测试、未执行任何沙箱命令**（任务约束）。因此所有"强制"结论要么来自源码中内核接口的直接使用（bwrap/seccomp/cgroup/iptables 参数、`cgroup.kill` 写入），要么来自项目自带测试的断言文本，而**非本次实测复现**。
4. **内核版本/发行版最低要求未确认**：抓取到的文档片段中没有 Linux 内核版本下限、`unprivileged_userns_clone` 要求或 cgroup v2 挂载前提的明确文字（`scripts/sandbox_audit.lua` 会探测 `seccomp`/`NoNewPrivs`/`CapEff`，但门槛值无原文）。**UNKNOWN**。
5. **Landlock / AppArmor / SELinux**：源码与已抓取文档中**均未发现**使用；也未发现显式声明"不使用"。→ 记为"未观测到"，非"确认不存在"。
6. **`read_all`（整机根 overlay）默认值的字面键名未在 `default_config.lua` 顶部确认**：文档多处提及"`read_all` 默认开"，`default_config` 中相关可观测项是 `process_roots = {}` + 注释"`read_all=true`（默认）时整机根已是可写 overlay"；**具体键定义位置未定位**。→ 语义已确认（默认可写整机根 + overlay 暂存），键名归属**未验证**。
7. **`fuse_overlay.lua`(5.2 KB) 与 `observer.lua`(26 KB, eBPF/strace 后端) 未读**：因此"eBPF 观测是否真正加载/回退顺序"、"fuse-overlayfs 整机根的具体实现"**未验证**（仅知 `fuse_root_overlay=true` 为产品默认，且 commit `3720e85` 记录了它曾卡死内核因而在测试中默认关闭）。
8. **`systemd` 门面的"不可检测性"边界按其自述为有限**：入口是脚本非 ELF、无 D-Bus、模板单元不支持、门面启动的服务在嵌套命名空间内 `ps` 看不到（文档自认"known detectable difference"）。→ 已确认是**有限仿真**，不是隔离边界。
9. **无 hypervisor 层**：未发现任何 VM/microVM/Windows Sandbox/WSL2/Hyper-V 相关实现。**因此本仓库不能作为"Windows 沙箱能力基线"使用**，只能作为"Linux 沙箱能力参照"。

---

## 5. FEATURES A COMPARABLE WINDOWS SANDBOX SHOULD HAVE

> 以下为**分析者综合推断（【推断】）**：把 NeoAI 在 Linux 上实现的强制/建议能力映射为 Windows 上等价或更强的机制。**不是该仓库的内容**，而是"对标清单/差距输入"。

### 5.1 进程与令牌（对标 bwrap userns + cap-drop + setpriv + NNP）
1. **受限令牌（`CreateRestrictedToken`）**：禁用 SID 与特权，仅保留 `SeChangeNotifyPrivilege`。
2. **AppContainer 隔离（含 LPAC / Less Privileged AppContainer）**：网络能力（`internetClient`/`privateNetworkClientServer`）与文件能力（`broadFileSystemAccess` 默认不授予）显式声明。
3. **Job Object 资源域**：`JOB_OBJECT_LIMIT_PROCESS_MEMORY`/`JOB_OBJECT_LIMIT_JOB_MEMORY`、`ActiveProcessLimit`、`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`、CPU rate control（对标 cgroup v2 + `cgroup.kill` 的整树终止）。
4. **进程缓解策略（Process Mitigation Policies）**：ACG（任意代码保护）、CIG（代码完整性保护）、禁止动态代码、禁止 Win32k 系统调用、禁止扩展点注入、CFG —— 作为 seccomp denylist 的 Windows 等价物。
5. **完整性级别（MIC）+ 禁止提权**：Low/Medium IL、阻断 UAC 自动提升、禁止 `SeDebugPrivilege`/`SeImpersonatePrivilege`/`SeLoadDriverPrivilege`（对标 cap_drop 的 `CAP_SYS_MODULE`/`CAP_SYS_RAWIO`）。
6. **无继承句柄（`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`）**：杜绝 `openat(dir_fd, "..")` 式句柄上溯逃逸（对标 NeoAI 的 fd closing）。
7. **禁止子进程创建 / 允许列表化的 `CreateProcessAsUser` 代理**：等价于 `clone(CLONE_NEW*)` 拦截。

### 5.2 文件系统（对标 mount ns + overlay CoW + mask_paths + CAS commit）
8. **文件系统虚拟化/重定向（minifilter 或 Projected File System）**：整机只读 + 写重定向到私有暂存层（COW），支持白障（whiteout）语义。
9. **VHDX 差分盘 / Windows Container 层**：镜像级 COW 与快照回滚（对标 overlay upper + snapshot undo/redo）。
10. **敏感路径遮蔽（deny-list minifilter）**：`\\.\pipe\docker_engine`、`\\.\pipe\containerd-*`、`\\.\pipe\lsass`、`%USERPROFILE%\.ssh`、`%APPDATA%\gcloud`、凭据管理器、DPAPI 主密钥目录、SAM/SECURITY/SYSTEM hive、`\Device\PhysicalDrive*` 等一律拒绝或重定向到空对象（对标默认 `DEFAULT_MASK_PATHS` + `/dev/null` 覆盖）。
11. **命名管道/ALPC 端点 ACL 收敛**：阻断容器守护进程、服务控制管理器（SCM）、LSASS、RPC 端点的控制通道（对标遮蔽 `/run/docker.sock`、`/run/dbus`、`/run/systemd`）。
12. **注册表虚拟化 / 事务（KTM）**：`HKLM\SYSTEM`、`HKLM\SECURITY`、`HKLM\SAM` 只读或重定向到每沙箱 hive；写操作进入待审层（对标 `/proc/sys` 只读 + `/etc` overlay）。
13. **磁盘配额与暂存上限**：每沙箱暂存目录硬配额（对标 `limits.disk_bytes = 64 GiB`）。
14. **内容寻址暂存 + CAS 发布**：写入宿主前做哈希基线比对（`expected_base`），冲突即拒绝整单元（对标 `cas_mode="hash"`）。

### 5.3 网络（对标 netns/host_proxy/net_consent/WFP）
15. **WFP（Windows Filtering Platform）按 AppContainer SID 的出站过滤**：默认拒绝、按目标地址/端口/协议放行；**内核层强制**（比 NeoAI 的应用层代理强，直接消除"裸 TCP 绕过"这一残余）。
16. **回环重定向/豁免控制**：`NetworkIsolationSetAppContainerConfig`/双端回环豁免白名单（对标 `allow_localhost_ports` + 内部端口登记）。
17. **NAT/vSwitch 隔离（WinNat、HNS）或容器网络**：每沙箱独立网络 compartment（对标独立 netns + veth + 仅可达网关）。
18. **按目标 + **持有进程** 的访问同意**：解析目标端口归属进程（`GetExtendedTcpTable`/`GetExtendedUdpTable` ↔ PID ↔ 映像路径），白名单键 = `host:port@<exe>`，进程变化即重新询问；超时默认拒绝（对标 `net_consent.port_owner`）。
19. **DNS 防 rebinding**：解析结果一次校验、连接复用（对标 host_proxy `_classify`/`_open_upstream`）。
20. **代理旁路检测**：识别 `netsh winhttp reset proxy`、`-NoProxy`、环境变量清除等显式规避并拒绝。
21. **云元数据地址阻断**：`169.254.169.254` 显式拦截（对标 `_ip_is_host_local`）。

### 5.4 凭据与数据外泄（对标 secret 假化 + egress guard + flow ledger）
22. **凭据来源枚举与假化**：环境变量、`.env`、DPAPI blob、凭据管理器、SSH agent、云 CLI token、浏览器 cookie 库 → 注入"格式保真假凭据"，仅在真正提交/执行时还原（真实密钥出现即暂停 Agent）。
23. **出站密钥守卫**：HTTP 客户端层 + WFP 层双重拦截向非白名单主机发送密钥（对标 `secret_egress.guard_http`）。
24. **数据流账本**：记录假凭据的每个流经点，对不可逆派生（加密/编码）标记为不透明并在发布前强制人工确认。
25. **Credential Guard / LSASS 保护**：禁止读取内存中的凭据（对标 Linux 侧 `/proc/*/mem` 与 ptrace 拦截）。

### 5.5 桌面/UI 与 IPC（Windows 独有的额外面）
26. **窗口站与桌面隔离**：在独立 WindowStation/Desktop 运行，阻断 `WinSta0` 交互；阻止剪贴板、屏幕捕获、`SendInput`、UIAccess、UI 自动化跨沙箱注入。
27. **UIPI + 消息钩子阻断**：禁止 `SetWindowsHookEx` 跨进程钩子、DDE/COM 激活提升（`CoGetObject`/`IDispatch` 提权路径）。
28. **命名对象命名空间隔离**：每沙箱私有 BaseNamedObjects / `Local\` 命名空间（等价于 IPC ns）。
29. **输入法/拖放/共享内存（`CreateFileMapping` 全局段）限制**。

### 5.6 策略、审批与审计（对标 policy/risk/review/audit/grant/replay）
30. **分级风险模型 L0–L3**（路径级别 × 网络 × 包安装 × 权限档位 × 凭据作用域 × 危险命令模式）→ 动作 `auto/record/review/block`。
31. **硬拒绝清单不可被用户确认覆盖**（内核模块/驱动、磁盘设备写、`format`/`diskpart clean`、防火墙修改、关机/重启）——按命令首词 + 能力双重判定。
32. **分级权限档位 T0/T1/T2 与自动升级申请**：T2 效果冻结为"主机操作提案"，审批后在宿主代执行（对标 `hostop` + `sudo` 回放）。
33. **窄范围任务授权（scope/operations/budget/TTL/撤销）** 与**策略回放**（同一事实+规则可复现裁决）。
34. **写前暂存 + 变更单元审批 UI**：按文件/按单元批准、逐文件拒绝、diff 预览、撤销保存；支持选择性应用与依赖闭包组合发布。
35. **包安装/系统管理命令的专用通道**：状态目录可写暂存、账户库（SAM）按需解除遮蔽、维护脚本服务启动桩（对标 `policy-rc.d` 桩 + `systemctl` 门面）。
36. **不可绕过的审计**：ETW 内核遥测 + 裁决证据（受影响对象清单/哈希，不落文件内容），支持越界访问留痕与告警；**沙箱服务缺失时 fail-closed 拒绝执行**。

### 5.7 反指纹与逃生面收口（可选，对标 conceal）
37. 隐藏虚拟化痕迹（挂载/注册表/设备标识、进程名、`GetSystemFirmwareTable` 差异），并把"只读"错误统一报为权限错误以降低识别度；**但必须明示这是尽力而为，不构成安全边界**。
38. **残余面清单化**：像 NeoAI 那样把已知残余（共享网络命名空间、`/proc/net` 可读、hostname 继承宿主本身）写成**基线断言测试**，任何变化都告警——Windows 版应对应到"裸 `\Device\Tcp` 句柄、`GetExtendedTcpTable` 全表可见、主机名/域信息可见、ETW 自身可探测"等条目。

---

## 6. 对"WinStageSandbox"的直接差距输入（摘要）

| 维度 | NeoAI（Linux） | Windows 对标必须补的 |
| --- | --- | --- |
| syscall 级拒绝 | seccomp-BPF denylist + 设备节点屏障（内核强制） | 进程缓解策略（ACG/CIG/禁 Win32k）+ minifilter 拒绝 `\Device\*` 写 |
| 文件隔离 | mount ns + 整机根 overlay CoW + mask_paths 遮蔽（内核强制） | minifilter/ProjectedFS 重定向 + 管道/注册表遮蔽 |
| 网络 | **应用层代理**（裸 TCP 绕过，作者自认残余）+ 可选 netns 网关 | WFP 内核级按 SID/目标过滤 + 回环豁免控制 |
| 资源 | cgroup v2（内存/PID/CPU）+ `cgroup.kill` | Job Object（内存/进程数/kill-on-close） |
| 凭据 | 假密钥 + 出网守卫 + 流账本 | 假凭据 + Credential Guard + WFP 出站守卫 |
| UI/IPC | 无（TUI 进程） | WindowStation/Desktop 隔离 + UIPI + 命名对象命名空间 |
| 审批 | 异步 dry-run + 候选冻结 + CAS 发布 + L0–L3 | 需自建等价的暂存/冻结/CAS + 分级审批 + ETW 审计 |

---

### 附：引用链接

- 仓库主页：https://github.com/gygygfg/NeoAI
- 元数据 API：https://api.github.com/repos/gygygfg/NeoAI
- 文件树 API：https://api.github.com/repos/gygygfg/NeoAI/git/trees/master?recursive=1
- 英文设计文档：https://raw.githubusercontent.com/gygygfg/NeoAI/master/docs/en/sandbox.md
- 默认配置：https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/default_config.lua
- 自带审计脚本：https://raw.githubusercontent.com/gygygfg/NeoAI/master/scripts/sandbox_audit.lua
- 边界逃逸测试：https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/tests/test_sandbox_boundary_escape.lua
- 联网同意测试：https://raw.githubusercontent.com/gygygfg/NeoAI/master/lua/NeoAI/tests/test_sandbox_boundary_net.lua
