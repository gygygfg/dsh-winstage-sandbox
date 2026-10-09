/**
 * mitigations.mjs — 进程缓解策略（Process Mitigation Policies）：本项目对
 * "seccomp-BPF syscall denylist" 的 Windows 等价物。
 *
 * ── 差距来源（为什么必须补这一层）────────────────────────────────────────────
 * `docs/NeoAI-沙箱能力分析与差距输入.md` §3.2：NeoAI 在**内核**里用自建 seccomp-BPF
 * 拒绝 `ptrace`/`mount`/`unshare`/`setns`/`bpf`/`io_uring_*`/`keyctl` 等系统调用，
 * 架构不匹配直接 `KILL_PROCESS`，`mknod` 创建设备节点返回 `EPERM`。
 * 同文 §5.1 第 4 条明确指出 Windows 侧的等价物是
 * **「进程缓解策略（Process Mitigation Policies）：ACG（任意代码保护）、CIG（代码完整性保护）、
 * 禁止动态代码、禁止 Win32k 系统调用、禁止扩展点注入、CFG」**；
 * §6 差距摘要表把「syscall 级拒绝」的 Windows 必补项写成
 * 「进程缓解策略（ACG/CIG/禁 Win32k）+ minifilter 拒绝 `\Device\*` 写」。
 * `docs/WinStageSandbox-能力清单与差距基线.md` §2 能力矩阵中该项为 **ABSENT**
 * （"进程 / 系统调用缓解"整行缺失）。本模块补上其中的**进程缓解策略**这一半。
 *
 * ── 本模块在启动路径中的位置 ────────────────────────────────────────────────
 * 缓解策略通过**属性列表**（`PROC_THREAD_ATTRIBUTE_LIST`）传给 `CreateProcess`，
 * 与 `src/appcontainer.mjs` 的 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` 并列：
 *
 *   InitializeProcThreadAttributeList(list, 2, 0, &size)   // 2 = 包身份 + 缓解策略
 *   UpdateProcThreadAttribute(list, 0, 0x00020009, &secCaps, 24, NULL, NULL)  // AppContainer
 *   UpdateProcThreadAttribute(list, 0, 0x00020010, &policy,  8,  NULL, NULL)  // 本模块
 *   CreateProcessW(..., EXTENDED_STARTUPINFO_PRESENT | ..., &siEx, ...)
 *
 * `[官方]` 属性的值指针「must persist until the attribute list is destroyed」——
 * 因此 `buildMitigationPolicy()` 返回的 `buffer` 必须由调用方持有到
 * `CreateProcessW` 结束（并在需要真实原生地址时用 `pin` 钉住）。来源：
 * https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute
 *
 * ── 诚实声明（证据分层，见手册第 0 章）──────────────────────────────────────
 * 本模块**只做纯构造 + 注入 + fail-closed 判定**。常量来自官方文档与官方头文件定义
 * （`[官方]`）；**本机上没有 SDK 头文件**（`C:\Program Files (x86)\Windows Kits\...` 不存在，
 * 已核对），也没有跑过任何真实 `CreateProcess`，因此：
 *   - 所有「运行期会怎样」的陈述一律 `[未实测]`/`[推断]`，**没有一条 `[实测]`**；
 *   - 「策略是否真的生效」不在本模块判定 —— 本模块只保证
 *     「要么属性列表被写入，要么抛错中止启动」，即 fail-closed 的**注入**语义。
 *     真实生效判定需要子进程侧观测（AppContainer 令牌事实 + 行为面），属集成方的职责。
 */

// ─────────────────────────── 1. 属性号（含推导留档）───────────────────────────

/**
 * `PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY` 的属性号。
 *
 * ── 推导（与 `src/appcontainer.mjs` 对 0x00020009 的留档同一套规则）────────────
 * 1. `[官方]` winnt.h 的宏：
 *      `#define PROC_THREAD_ATTRIBUTE_x ProcThreadAttributeValue(Number, Thread, Input, Additive)`
 *      `ProcThreadAttributeValue(Number, Thread, Input, Additive) =`
 *      `  Number | (Thread ? 0x10000 : 0) | (Input ? 0x20000 : 0) | (Additive ? 0x40000 : 0)`
 *      （`Number` 取低 16 位；`Thread` 位 = 0x10000；`Input` 位 = 0x20000；`Additive` 位 = 0x40000）。
 * 2. `[官方]` winnt.h 里该属性的编号与调用形状：
 *      `#define ProcThreadAttributeMitigationPolicy 16`
 *      `#define PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY \`
 *      `    ProcThreadAttributeValue(ProcThreadAttributeMitigationPolicy, FALSE, TRUE, FALSE)`
 *    ⇒ `16 | 0x00020000 = 0x00020010`。（`Thread=FALSE` 故无 0x10000；`Additive=FALSE` 故无 0x40000。）
 * 3. `[官方]` 与已实测属性号的**互证**（同一条宏规则，只用本仓库已落档的证据）：
 *      `src/appcontainer.mjs:94` 的 `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009`
 *      对应 `ProcThreadAttributeValue(9, FALSE, TRUE, FALSE)`，`[实测]` 该值被
 *      `UpdateProcThreadAttribute` 接受（证据 `.t/sbx3/dev/raw-t0-forensics.txt` §1、
 *      `raw-t0-pinvoke.txt` §3）。同一规则、同一个 `Input=TRUE` 分支、同一段编号空间
 *      （0x00020000 | Number，Number ≤ 0xFFFF）⇒ 属性 16 必然映射到 `0x00020010`。
 * 4. `[官方]` 该属性的语义（同上 Microsoft Learn 原文）：
 *      "The lpValue parameter is a pointer to a DWORD or DWORD64 that specifies the exploit
 *       mitigation policy for the child process. Starting in Windows 10, version 1703, this
 *       parameter can also be a pointer to a two-element DWORD64 array."
 *      "The specified policy overrides the policies set for the application and the system and
 *       cannot be changed after the child process starts running."
 *      "Supported in Windows 7 and newer and Windows Server 2008 R2 and newer."
 *    ⚠ `[未实测]` 本机未跑过该调用：本仓库**没有任何** `0x00020010` 的原始输出存档，
 *    该值目前只有「宏推导 + 同规则已实测的 0x00020009」这一条证据链（无独立实测通道）。
 *    集成方第一次在真实启动路径里接上它时，应把 `UpdateProcThreadAttribute` 的返回值
 *    + `GetLastError` 落盘，作为这条推导的**独立实测**证据。
 *
 * 用法示例（本模块不直接构造属性列表）：
 *   `InitializeProcThreadAttributeList(list, 2, 0, &size)` —— 计数要**同时**算上
 *   `SECURITY_CAPABILITIES` 与本属性，否则 `UpdateProcThreadAttribute` 返回
 *   `ERROR_INSUFFICIENT_BUFFER(122)`。`[官方]` InitializeProcThreadAttributeList 文档：
 *   "The number of attributes to be initialized" 需与实际 Update 次数匹配。
 */
export const MITIGATION_POLICY_ATTRIBUTE = 0x00020010

/**
 * 属性值的字节数：`DWORD64` 的 8 字节。
 *
 * `[官方]` `PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY` 的 `lpValue` 是
 * "a pointer to a **DWORD** or **DWORD64**"。这里**恒取 64 位 8 字节**，不按 32/64 位自适应，
 * 理由有二（`[推断]`，但方向是收紧而非放宽）：
 *   1. 掩码位一直用到 bit 63（`IMAGE_LOAD_PREFER_SYSTEM32 = 0x1 << 60`），
 *      32 位 `DWORD` 表达不了本模块 `hardened`/`untrusted` 档所依赖的位
 *      （`EXTENSION_POINT_DISABLE = 0x1 << 32` 就已经越界）；
 *   2. `[官方]` 自 Windows 10 1703 起该属性支持双 `DWORD64` 数组（第二个 DWORD64 承载
 *      `PROCESS_CREATION_MITIGATION_POLICY2_*`）；本模块暂只用第一个，但尺寸与官方一致。
 * `[未实测]` 未在 32 位宿主上验证过「32 位子进程接受 8 字节值」；本仓库的 AppContainer
 * 路径本身就是 64 位（`SECURITY_CAPABILITIES` 里是 8 字节指针）。
 */
export const MITIGATION_POLICY_VALUE_SIZE = 8

// ─────────────────────────── 2. 标志位（winnt.h 常量）─────────────────────────

/**
 * 缓解策略标志表：名字 → 64 位（BigInt）标志。
 *
 * `[官方]` 全部数值取自 Microsoft Learn
 * `UpdateProcThreadAttribute` 页 Remarks 的 `PROCESS_CREATION_MITIGATION_POLICY_*` 列表
 * （与 winnt.h 定义同源），来源 URL 见文件头与 `MITIGATION_MAP` 的 `source` 字段。
 * 每一项都是 `0x1 << n` 的**单一位**（`ALWAYS_ON` 取值），位号 n 写在注释里，
 * 供测试用「独立算术」复核（`tests/mitigations.mjs` 不抄常量，而是按位号重算）。
 *
 * ⚠ 本机没有 SDK 头文件（已核对：`C:\Program Files (x86)\Windows Kits\10\Include` 不存在），
 * 因此 `[官方]` 是**文档/官方头文件定义**层证据，不是本机 `#include` 量出来的值。
 *
 * 已知的两族例外（占用**两个位**的 MASK，本表只收录其 `ALWAYS_ON` 取值）：
 *   - `PROHIBIT_DYNAMIC_CODE`：MASK = `0x3 << 36`
 *     （`DEFER=0`、`ALWAYS_ON=1`、`ALWAYS_OFF=2`、`ALWAYS_ON_ALLOW_OPT_OUT=3`）；
 *   - `BLOCK_NON_MICROSOFT_BINARIES`：MASK = `0x3 << 44`
 *     （`DEFER=0`、`ALWAYS_ON=1`、`ALWAYS_OFF=2`、`ALLOW_STORE=3`）；
 *   - `FONT_DISABLE`：MASK = `0x3 << 48`（`DEFER/ALWAYS_ON/ALWAYS_OFF/AUDIT_NONSYSTEM_FONTS=3`）；
 *   - `IMAGE_LOAD_*`：MASK = `0x3 << 52/56/60`（`DEFER/ALWAYS_ON/ALWAYS_OFF/RESERVED=3`）。
 * 也就是说：把 `ALWAYS_ON` 单独置位是官方定义的行为；但调用方若把同一个 MASK 的另一位
 * 也置上（例如 `0x3 << 36` = `ALWAYS_ON_ALLOW_OPT_OUT`），语义就**不再**是
 * "禁止动态代码" —— 这种越界组合由 `validateMitigationFlags()` 显式报出，
 * 不会被 `describeMitigationPolicy()` 静默读成"已开启"。
 */
export const MITIGATION_FLAGS = Object.freeze({
  // bit 0 —— 数据执行保护（NX）
  DEP_ENABLE: 0x1n,
  // bit 1 —— DEP-ATL thunk 仿真（必须与 DEP_ENABLE 同开；官方原文
  // "This value can be specified only with PROCESS_CREATION_MITIGATION_POLICY_DEP_ENABLE"）
  DEP_ATL_THUNK_ENABLE: 0x2n,
  // bit 2 —— SEH 覆盖保护
  SEHOP_ENABLE: 0x4n,
  // bit 8 —— 强制 ASLR：不兼容动态基址的映像被强行重定位（无重定位节则不加载）
  FORCE_RELOCATE_IMAGES: 0x1n << 8n,
  // bit 12 —— 堆损坏即终止进程
  HEAP_TERMINATE: 0x1n << 12n,
  // bit 16 —— 自底向上随机化（含栈随机化）
  BOTTOM_UP_ASLR: 0x1n << 16n,
  // bit 20 —— 高熵自底向上随机化（官方：仅当 BOTTOM_UP_ASLR 也开才有效，且只对原生 64 位有意义）
  HIGH_ENTROPY_ASLR: 0x1n << 20n,
  // bit 24 —— 坏句柄立即抛异常（而非返回失败状态）
  STRICT_HANDLE_CHECKS: 0x1n << 24n,
  // bit 28 —— 禁 Win32k 系统调用（本模块的「syscall 类别拒绝」，见 MITIGATION_MAP）
  WIN32K_SYSTEM_CALL_DISABLE: 0x1n << 28n,
  // bit 32 —— 禁内置第三方扩展点：AppInit DLL / Winsock LSP / 全局 Windows 钩子 / 旧式 IME
  EXTENSION_POINT_DISABLE: 0x1n << 32n,
  // bit 36 —— 禁止生成动态代码或修改可执行代码（ACG 的行为面，W^X）
  PROHIBIT_DYNAMIC_CODE: 0x1n << 36n,
  // bit 40 —— 控制流保护（CFG）：对启用 CFG 编译的代码收紧间接调用
  CONTROL_FLOW_GUARD: 0x1n << 40n,
  // bit 44 —— 二进制签名策略（CIG）：EXE/DLL 必须被正确签名
  BLOCK_NON_MICROSOFT_BINARIES: 0x1n << 44n,
  // bit 48 —— 禁加载非系统字体
  FONT_DISABLE: 0x1n << 48n,
  // bit 52 —— 禁从远程设备加载映像
  IMAGE_LOAD_NO_REMOTE: 0x1n << 52n,
  // bit 56 —— 禁加载带 Low 强制标签的文件（Low IL 落地物不能当映像加载）
  IMAGE_LOAD_NO_LOW_LABEL: 0x1n << 56n,
  // bit 60 —— 优先从 System32 加载同名 DLL（DLL 劫持/本地投放缓解）
  IMAGE_LOAD_PREFER_SYSTEM32: 0x1n << 60n,
})

/**
 * 多位置位的 MASK（`0x3 << 位移`）：用来判定"调用方是否在同一族里置了 `ALWAYS_ON` 以外的位"。
 * `[官方]` 同样是 winnt.h 的 `*_MASK` 定义（值见上面 `MITIGATION_FLAGS` 的注释）。
 */
export const MITIGATION_MASKS = Object.freeze({
  PROHIBIT_DYNAMIC_CODE: 0x3n << 36n,
  BLOCK_NON_MICROSOFT_BINARIES: 0x3n << 44n,
  FONT_DISABLE: 0x3n << 48n,
  IMAGE_LOAD_NO_REMOTE: 0x3n << 52n,
  IMAGE_LOAD_NO_LOW_LABEL: 0x3n << 56n,
  IMAGE_LOAD_PREFER_SYSTEM32: 0x3n << 60n,
})

/**
 * 对照表：每个 Windows 缓解策略 ↔ 它替代的 NeoAI/Linux 控制。
 *
 * 这是评审要读的那张表 —— 左边是我们**真的有**的 Windows 手段，右边是 Linux 侧
 * seccomp/系统调用/装载面控制。`substitutes` 与 `equivalentTo` 的措辞刻意区分：
 *   - `substitutes`：在**本项目**的对照语境里，它填的是哪个缺口；
 *   - `equivalentTo`：它真正对应的 Linux 原语（可能是 bwrap 的 mount 面，而不是 seccomp）；
 *   - `notEquivalent`：**不等价**之处 —— 防止把"进程缓解"读成"内核 syscall 过滤"。
 *   - `enforcement`：`REAL`（内核强制）/ `PARTIAL`（仅内核在特定条件下强制）。
 *
 * ⚠ `[推断]` 整张表的映射关系是**语义对照**，不是实测结论；`[未实测]` 本机没有逐条
 * 验证过"某个策略确实拦住了某个 syscall 类别"。NeoAI 侧的 seccomp 事实见
 * `docs/NeoAI-沙箱能力分析与差距输入.md` §3.2 / §3.5（该文自述亦为"未运行任何测试"）。
 */
export const MITIGATION_MAP = Object.freeze({
  DEP_ENABLE: {
    linuxControl: 'W^X 的内存面（NX 位）',
    equivalentTo: '内核 NX / 不可执行映射（PAX_MPROTECT 一类）',
    substitutes: '把"数据页不可执行"这一最基础的执行面收口，作为 denylist 之外的强制前提',
    enforcement: 'REAL',
    gapClosed: '进程内存的可执行面（seccomp 管不到，但它是 mprotect(PROT_EXEC) 类滥用的地基）',
  },
  DEP_ATL_THUNK_ENABLE: {
    linuxControl: '无直接对应（ATL thunk 是 Windows 特有兼容层）',
    equivalentTo: '无',
    substitutes: '补齐 DEP 的兼容性例外面：只有与 DEP_ENABLE 同开才有意义',
    enforcement: 'REAL',
    gapClosed: 'DEP 的兼容性退让面',
  },
  SEHOP_ENABLE: {
    linuxControl: '无直接对应（SEH 是 Windows 特有异常链）',
    equivalentTo: '无',
    substitutes: '异常处理链完整性（ROP/覆盖 SEH 类利用的阻断）',
    enforcement: 'REAL',
    gapClosed: '异常分发面的控制流劫持',
  },
  FORCE_RELOCATE_IMAGES: {
    linuxControl: 'ASLR / 强制映像重定位',
    equivalentTo: '内核 ASLR（randomize_va_space=2 一类）',
    substitutes: '映像基址随机化的**强制**（不依赖每个模块自己声明的 /DYNAMICBASE）',
    enforcement: 'REAL',
    gapClosed: '地址空间布局的可预测性',
  },
  HEAP_TERMINATE: {
    linuxControl: 'glibc malloc 一致性检查 / 堆加固',
    equivalentTo: '堆元数据完整性检查（MALLOC_CHECK_ 一类）',
    substitutes: '堆被破坏即终止，而不是带着已损坏的堆继续执行',
    enforcement: 'PARTIAL',
    notEquivalent: '官方原文：heap terminate on corruption is **user mode enforced**（不是内核强制）',
    gapClosed: '堆利用的持续驻留面',
  },
  BOTTOM_UP_ASLR: {
    linuxControl: 'mmap/栈的自底向上随机化',
    equivalentTo: '内核 mmap 随机化（mmap_rnd_bits）',
    substitutes: '把最低用户地址随机化（含栈随机化）',
    enforcement: 'REAL',
    gapClosed: '地址空间布局的可预测性（分配面）',
  },
  HIGH_ENTROPY_ASLR: {
    linuxControl: '高熵 ASLR（1 TB 级自底向上方差）',
    equivalentTo: '内核高熵 mmap 随机化',
    substitutes: '把分配面熵从数 GB 级抬到 TB 级（官方：仅原生 64 位有意义，且需 BOTTOM_UP_ASLR 同开）',
    enforcement: 'REAL',
    notEquivalent: 'WOW64 / 32 位子进程上只有限效果',
    gapClosed: '地址空间布局的可预测性（熵不足）',
  },
  STRICT_HANDLE_CHECKS: {
    linuxControl: '无直接对应（Linux fd 表本身没有"句柄有效性异常"语义）',
    equivalentTo: 'NeoAI 的「启动前关闭 3..65535 全部 fd」（fd 面收口）',
    substitutes: '坏句柄引用立即抛异常，把"句柄误用/暴力探测"从可继续执行变成立即失败',
    enforcement: 'REAL',
    notEquivalent: 'NeoAI 是**启动时**枚举关闭 fd；本策略是**运行期**对无效句柄引用抛异常，两者互补但不互相替代',
    gapClosed: '句柄/描述符面的探测与误用',
  },
  WIN32K_SYSTEM_CALL_DISABLE: {
    linuxControl: 'seccomp denylist 的**syscall 类别**拒绝',
    equivalentTo: 'seccomp-BPF 按 syscall 号/类别拒绝（NeoAI seccomp.lua 的 blocked 表）',
    substitutes: '整类 Win32k（USER/GDI）系统调用不可达 —— 直接把"图形/窗口/输入/剪贴板"这一整片 syscall 面切掉',
    enforcement: 'REAL',
    notEquivalent:
      'seccomp 是**任意 syscall 号**粒度的 denylist；Win32k 只切掉 Win32k 这一类。' +
      'NT 原生 syscall 面（Nt*/Zw*）不受本策略约束 —— 它替代的是"类"而不是"表"',
    gapClosed: 'syscall 级拒绝（类别面）：窗口站/桌面/输入注入/剪贴板/GPU 的 syscall 入口',
  },
  EXTENSION_POINT_DISABLE: {
    linuxControl: 'LD_PRELOAD / ld.so.preload 注入面阻断',
    equivalentTo: '禁止 preload 式注入（NeoAI 侧等价物是其 IAT/遮蔽层面对"外部注入"的默认拒绝）',
    substitutes:
      '禁 AppInit DLL / Winsock LSP / 全局 Windows 钩子 / 旧式 IME —— 即"第三方代码被宿主进程自动加载"的四条通道',
    enforcement: 'REAL',
    notEquivalent: '官方原文：**Local hooks still work**（本地钩子仍可用）；它挡的是全局/自动加载的扩展点',
    gapClosed: '进程内的自动注入面（UIPI/钩子/输入法）',
  },
  PROHIBIT_DYNAMIC_CODE: {
    linuxControl: 'mprotect(PROT_EXEC) / W^X 强制（禁止生成或改写可执行代码）',
    equivalentTo: 'seccomp 对 mprotect/mmap(PROT_EXEC) 的限制 + W^X（ACG 的运行时面）',
    substitutes: '任意代码保护（ACG）：进程既不能生成动态代码，也不能把已有页改成可执行',
    enforcement: 'REAL',
    notEquivalent:
      'ACG 是**进程级模式**：开启后 JIT 全部不可用（Node/V8、.NET、Java、部分 Python 扩展）。' +
      '因此本模块把它放进 **opt-in 的 untrusted 档**，不进 baseline',
    gapClosed: 'syscall 级拒绝的执行面：JIT 喷射 / 运行期代码改写（ROP 链的落地步骤）',
  },
  CONTROL_FLOW_GUARD: {
    linuxControl: 'CET/影子栈一类的控制流完整性（近似）',
    equivalentTo: 'CFI（间接调用白名单）',
    substitutes: '对**已启用 CFG 编译**的代码收紧间接调用目标',
    enforcement: 'PARTIAL',
    notEquivalent:
      '官方原文：只对 "code that has been built with CFG enabled" 生效 —— 未开 CFG 编译的模块不受约束，' +
      '它是"对已加固代码的加固"，不是全进程的控制流完整性',
    gapClosed: '间接调用/跳转面（仅覆盖已启用 CFG 的模块）',
  },
  BLOCK_NON_MICROSOFT_BINARIES: {
    linuxControl: '未签名二进制执行拒绝（IMA/签名校验一类）',
    equivalentTo: '代码完整性策略（CIG）：EXE/DLL 必须被正确签名',
    substitutes: '未签名（或非受信签名）的 EXE/DLL 无法加载 —— 直接掐掉"投放一个自己的载荷再执行"这条路',
    enforcement: 'REAL',
    notEquivalent:
      '官方另有 `ALLOW_STORE(3)` 取值放行 Store 应用；与 ACG 同开时，未签名二进制连加载都不行。' +
      '必须在 **untrusted 档 opt-in**：本仓库自带的未签名产物（含 shim DLL）会被拒',
    gapClosed: 'syscall 级拒绝的执行面：未签名二进制/载荷的执行（NeoAI 用"不透明脚本升级审批"近似覆盖）',
  },
  FONT_DISABLE: {
    linuxControl: '字体解析面收口（无直接 syscall 对应）',
    equivalentTo: '无直接对应',
    substitutes: '进程不可加载非系统字体 —— 掐掉字体解析器的攻击面（历史上 TTF/OTF 解析器是常见的 RCE 面）',
    enforcement: 'REAL',
    gapClosed: '不可信数据 → 解析器（字体）这条代码执行路径',
  },
  IMAGE_LOAD_NO_REMOTE: {
    linuxControl: 'noexec 挂载 / 禁止从远程或可移动介质执行',
    equivalentTo: 'mount 面的 noexec + 远程路径不可执行（NeoAI 的 mount ns 只读/遮蔽近似）',
    substitutes: '禁止从远程设备（网络共享、可移动介质）加载映像',
    enforcement: 'REAL',
    gapClosed: '从"区外/不可信存储"装载可执行映像这条路径',
  },
  IMAGE_LOAD_NO_LOW_LABEL: {
    linuxControl: '禁止执行低完整性落地物（映射到"暂存目录不可执行"）',
    equivalentTo: '挂载面 noexec（对低标签数据）',
    substitutes:
      '禁止加载带 Low 强制标签的映像 —— 与 AppContainer（Low IL）正好互补：' +
      '沙箱里写出来的东西不能被当作映像装载回来',
    enforcement: 'REAL',
    gapClosed: '载荷落盘 → 回读执行（Low IL 暂存物当二进制用）这条路径',
  },
  IMAGE_LOAD_PREFER_SYSTEM32: {
    linuxControl: '无直接对应（DLL 搜索顺序是 Windows 特有）',
    equivalentTo: '固定库搜索路径 / rpath 收紧（近似）',
    substitutes: '同名 DLL 优先从 System32 解析，阻止"本地投放同名 DLL 劫持加载"',
    enforcement: 'PARTIAL',
    notEquivalent: '它是"优先"而非"仅允许"：非 System32 路径仍可被显式加载',
    gapClosed: 'DLL 劫持/相对路径投放（本仓库的暂存目录正是"可写且可被当搜索路径"的位置）',
  },
})

// ─────────────────────────── 3. 档位（预设）───────────────────────────────────

/**
 * 档位预设：名字 → 名字列表（**不是**裸标志，便于 `include`/`exclude` 做集合运算与汇报）。
 *
 * `baseline`：「对普通工具链安全」的集合 —— 这些策略官方语义都是**加固**而非**禁止**，
 * 不会让常规 CLI（含 Node）无法启动。`untrusted` 是唯一会**破坏** JIT/未签名二进制的档，
 * 因此它必须由调用方显式点名，绝不作为默认。
 */
export const MITIGATION_PROFILES = Object.freeze({
  /** 不注入任何策略：`flags = 0n`，`applyMitigationPolicy` 会成为 no-op（`isNoop()` 可判） */
  none: Object.freeze([]),
  /**
   * 基线：DEP/ASLR/SEHOP/堆终止/严格句柄/CFG。
   * 为什么这七条"安全"：官方对它们的说明都是**加固既有行为**（DEP 开、映像强制重定位、
   * 分配面随机化、堆坏即终止、坏句柄抛异常、CFG 只约束已启用 CFG 的模块），
   * 没有一条要求二进制必须被签名或必须不开 JIT —— 因此普通工具链可承受。
   */
  baseline: Object.freeze([
    'DEP_ENABLE',
    'DEP_ATL_THUNK_ENABLE',
    'SEHOP_ENABLE',
    'FORCE_RELOCATE_IMAGES',
    'HEAP_TERMINATE',
    'BOTTOM_UP_ASLR',
    'HIGH_ENTROPY_ASLR',
    'STRICT_HANDLE_CHECKS',
    'CONTROL_FLOW_GUARD',
  ]),
  /** 加固：基线 + 禁 Win32k 系统调用 + 禁扩展点注入（对应 §5.1 第 4 条点名的两项） */
  hardened: Object.freeze([
    'DEP_ENABLE',
    'DEP_ATL_THUNK_ENABLE',
    'SEHOP_ENABLE',
    'FORCE_RELOCATE_IMAGES',
    'HEAP_TERMINATE',
    'BOTTOM_UP_ASLR',
    'HIGH_ENTROPY_ASLR',
    'STRICT_HANDLE_CHECKS',
    'CONTROL_FLOW_GUARD',
    'WIN32K_SYSTEM_CALL_DISABLE',
    'EXTENSION_POINT_DISABLE',
  ]),
  /**
   * 不可信载荷：加固 + ACG（禁动态代码）+ CIG（二进制签名）+ 禁非系统字体 + 禁远程映像。
   *
   * ⚠ **opt-in，且会破坏普通工具链**（如实声明，不得作为默认档）：
   *   - `PROHIBIT_DYNAMIC_CODE`（ACG）⇒ JIT 全部失效：**Node/V8 进程无法启动**，
   *     .NET/Java 同样不适用；任何运行期生成代码的运行时都会被拒；
   *   - `BLOCK_NON_MICROSOFT_BINARIES`（CIG）⇒ 签名策略生效：**未签名的 EXE/DLL 无法加载**，
   *     包括本仓库自己构建的未签名产物与 shim DLL；`ALLOW_STORE` 取值可放行 Store 应用，
   *     但本档取的是严格的 `ALWAYS_ON`；
   *   - `FONT_DISABLE` ⇒ 非系统字体不可加载（普通 CLI 无感，但任何依赖自带字体的渲染会变）；
   *   - `IMAGE_LOAD_NO_REMOTE` ⇒ 网络共享/可移动介质上的映像不可加载（含"从共享目录跑工具"）。
   *   `[未实测]` 本机没有跑过这些组合（无 SDK、未做真实 CreateProcess）；上面四条是
   *   **官方语义的直接推论**（`[官方]` 语义 + `[推断]` 后果），不是本机实测结论。
   *   用途：只给"已冻结、无 JIT、已签名"的候选载荷用。
   */
  untrusted: Object.freeze([
    'DEP_ENABLE',
    'DEP_ATL_THUNK_ENABLE',
    'SEHOP_ENABLE',
    'FORCE_RELOCATE_IMAGES',
    'HEAP_TERMINATE',
    'BOTTOM_UP_ASLR',
    'HIGH_ENTROPY_ASLR',
    'STRICT_HANDLE_CHECKS',
    'CONTROL_FLOW_GUARD',
    'WIN32K_SYSTEM_CALL_DISABLE',
    'EXTENSION_POINT_DISABLE',
    'PROHIBIT_DYNAMIC_CODE',
    'BLOCK_NON_MICROSOFT_BINARIES',
    'FONT_DISABLE',
    'IMAGE_LOAD_NO_REMOTE',
  ]),
})

/** 档位名清单（供调用方/报告枚举） */
export const MITIGATION_PROFILE_NAMES = Object.freeze(Object.keys(MITIGATION_PROFILES))

/** 默认档：**保守**的 `baseline`，而不是 `none`（fail-closed：不点名也要有基线加固） */
export const DEFAULT_MITIGATION_PROFILE = 'baseline'

/**
 * `[官方]` 二进制签名策略的 `ALLOW_STORE` 取值（`0x3 << 44`）。
 * 本模块的 `untrusted` 档**不**使用它（取严格的 `ALWAYS_ON`）；单独导出是为了让
 * 调用方能显式表达"放行 Store 应用"这一官方例外，而不是把它写成一个魔数。
 */
export const BLOCK_NON_MICROSOFT_BINARIES_ALLOW_STORE = 0x3n << 44n

/** `[官方]` ACG 的 `ALWAYS_ON_ALLOW_OPT_OUT` 取值（`0x3 << 36`） */
export const PROHIBIT_DYNAMIC_CODE_ALLOW_OPT_OUT = 0x3n << 36n

// ─────────────────────────── 4. 错误（typed，fail-closed）─────────────────────

/**
 * 构造带 `code` 的 typed error（与 `src/appcontainer-runtime.mjs::runtimeError` 同风格：
 * `code` + `message` 前缀 + 结构化附加字段）。本模块**不吞任何失败**。
 */
function mitigationError(code, message, extra = {}) {
  const error = new Error(`${code}: ${message}`)
  error.code = code
  Object.assign(error, extra)
  return error
}

/**
 * Win32 `BOOL` → 成功？（与 `src/appcontainer-runtime.mjs::win32BoolSucceeded` 同语义）
 *
 * `[实测]`（本仓库已落档，见 `src/appcontainer-runtime.mjs:181-201`）：koffi 把 C 的 `bool`
 * 返回成 JS **boolean**，离线替身返回数字 `1`/`0`；只判 `=== 0` 会让**真实运行期的所有
 * 失败检查变成死代码**。因此在本地重复这条语义（不 import：那是别的模块的内部判定，
 * 跨模块依赖会让依赖升级的破坏面变大 —— 与 `appcontainer-runtime.mjs:246-249` 同一取舍）。
 */
function win32BoolSucceeded(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return false
}

// ─────────────────────────── 5. 纯构造：策略解析 ──────────────────────────────

/** 把名字数组规范化成「去重 + 按旗标位序稳定排序」的列表 */
function canonicaliseNames(names) {
  const seen = new Set()
  const out = []
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    out.push(name)
  }
  // 稳定序：按位号从低到高（= 数值从小到大），保证 Buffer/摘要可比对
  return out.sort((a, b) => (MITIGATION_FLAGS[a] < MITIGATION_FLAGS[b] ? -1 : MITIGATION_FLAGS[a] > MITIGATION_FLAGS[b] ? 1 : 0))
}

/** 名字列表 → 64 位标志（未知名字必须已经在前置校验里被拒） */
function flagsForNames(names) {
  let flags = 0n
  for (const name of names) flags |= MITIGATION_FLAGS[name]
  return flags
}

/** 标志值 → 名字列表（只认 `MITIGATION_FLAGS` 里的**单一位**） */
function namesForFlags(flags) {
  const names = []
  for (const [name, value] of Object.entries(MITIGATION_FLAGS)) {
    if ((flags & value) === value) names.push(name)
  }
  return canonicaliseNames(names)
}

/** `bigint|number|string` → `bigint`（不静默取整；非法输入直接抛） */
function toFlagValue(value, where) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw mitigationError('MITIGATION_FLAGS_INVALID', `${where}: number must be a non-negative safe integer (got ${value}); pass a bigint for 64-bit masks`)
    }
    return BigInt(value)
  }
  if (typeof value === 'string') {
    const text = value.trim()
    if (!/^(0[xX])?[0-9a-fA-F]+$/.test(text)) {
      throw mitigationError('MITIGATION_FLAGS_INVALID', `${where}: string "${value}" is not a hexadecimal flag value`)
    }
    return BigInt(text.startsWith('0x') || text.startsWith('0X') ? text : `0x${text}`)
  }
  throw mitigationError('MITIGATION_FLAGS_INVALID', `${where}: expected bigint/number/hex-string, got ${value === null ? 'null' : typeof value}`)
}

function assertFlagRange(flags, where) {
  if (flags < 0n || flags > 0xffffffffffffffffn) {
    throw mitigationError('MITIGATION_FLAGS_INVALID', `${where}: 0x${flags.toString(16)} does not fit in 64 bits (DWORD64)`)
  }
}

function assertKnownNames(list, where) {
  if (!Array.isArray(list)) {
    throw mitigationError('MITIGATION_SPEC_INVALID', `${where} must be an array of mitigation flag names`)
  }
  for (const name of list) {
    if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(MITIGATION_FLAGS, name)) {
      throw mitigationError(
        'MITIGATION_FLAG_UNKNOWN',
        `${where}: unknown mitigation flag ${JSON.stringify(name)}; known flags: ${Object.keys(MITIGATION_FLAGS).join(', ')}`,
        { unknown: String(name) },
      )
    }
  }
}

/**
 * 把调用方给的四种形态规范化成内部规范。
 *
 * 接受：
 *   1. 档位名字符串：`'baseline'`；
 *   2. `{ profile }`；
 *   3. `{ include: [...], exclude: [...] }`（可与 `profile` 组合）；
 *   4. `{ flags }`（`bigint` / 安全整数 / 十六进制字符串）。
 *
 * 第 3 种形态的**底面**是显式的：给了 `profile` 就以该档为底，没给就以 `none` 为底
 * （于是 `{include:['A']}` 恰好等于 `{A}`，不会静默把 baseline 的 9 条一起带上）。
 *
 * 拒绝（**绝不静默丢弃**，这是 denylist 的语义底线）：
 *   - 未知档位名 → `MITIGATION_PROFILE_UNKNOWN`；
 *   - 未知标志名 → `MITIGATION_FLAG_UNKNOWN`；
 *   - 同一个名字同时出现在 `include` 与 `exclude` → `MITIGATION_SPEC_CONFLICT`
 *     （静默取其中一边就是在猜调用方的意图，宁可不启动）；
 *   - `flags` 与 `profile`/`include`/`exclude` 混用 → `MITIGATION_SPEC_INVALID`
 *     （两种表达方式混用会让"到底哪个生效"变成猜测）。
 */
function normalizeSpec(spec) {
  const input = spec === undefined || spec === null ? DEFAULT_MITIGATION_PROFILE : spec

  if (typeof input === 'string') {
    if (!Object.prototype.hasOwnProperty.call(MITIGATION_PROFILES, input)) {
      throw mitigationError(
        'MITIGATION_PROFILE_UNKNOWN',
        `unknown mitigation profile ${JSON.stringify(input)}; known profiles: ${MITIGATION_PROFILE_NAMES.join(', ')}`,
        { unknown: input },
      )
    }
    const names = canonicaliseNames(MITIGATION_PROFILES[input])
    return { profile: input, names, flags: flagsForNames(names) }
  }

  if (typeof input !== 'object' || Array.isArray(input)) {
    throw mitigationError('MITIGATION_SPEC_INVALID', `expected a profile name or a spec object, got ${Array.isArray(input) ? 'array' : typeof input}`)
  }

  const hasFlags = input.flags !== undefined && input.flags !== null
  const hasInclude = input.include !== undefined && input.include !== null
  const hasExclude = input.exclude !== undefined && input.exclude !== null
  const hasProfile = input.profile !== undefined && input.profile !== null

  if (hasFlags && (hasInclude || hasExclude || hasProfile)) {
    throw mitigationError(
      'MITIGATION_SPEC_INVALID',
      'spec mixes {flags} with {profile|include|exclude}; pick one form — a silent precedence rule would make the resulting policy unguessable',
    )
  }

  if (hasFlags) {
    const flags = toFlagValue(input.flags, 'spec.flags')
    assertFlagRange(flags, 'spec.flags')
    const names = namesForFlags(flags)
    return { profile: 'custom', names, flags }
  }

  // 两个列表即使不是数组也要先抛（否则后面 `?? []` 会把它静默当成空表）
  if (hasInclude) assertKnownNames(input.include, 'spec.include')
  if (hasExclude) assertKnownNames(input.exclude, 'spec.exclude')

  // ── 语义选择（必须显式，不能靠"猜"）────────────────────────────────────────
  // 只给 include/exclude 而没给 profile 时，**不**以某个隐含档位为底，
  // 而是取 `none` 为底：`{include:[A]}` 就该**恰好等于 {A}**。
  // 若以 baseline 为底，`{include:['SEHOP_ENABLE']}` 会静默变成 9 条策略，
  // 调用方"我只想要这一条"的意图被无声改写 —— 这类"静默扩大策略集"的写法
  // 在 denylist 语义下不可接受（audit 面会读出完全不同的策略）。
  // 想要"基线 + 某条"必须写成 `{ profile: 'baseline', include: ['X'] }`。
  let profile
  if (hasProfile) {
    if (typeof input.profile !== 'string' || !Object.prototype.hasOwnProperty.call(MITIGATION_PROFILES, input.profile)) {
      throw mitigationError(
        'MITIGATION_PROFILE_UNKNOWN',
        `unknown mitigation profile ${JSON.stringify(input.profile)}; known profiles: ${MITIGATION_PROFILE_NAMES.join(', ')}`,
        { unknown: String(input.profile) },
      )
    }
    profile = input.profile
  } else {
    profile = hasInclude || hasExclude ? 'none' : DEFAULT_MITIGATION_PROFILE
  }

  if (hasInclude && hasExclude) {
    const both = input.include.filter((name) => input.exclude.includes(name))
    if (both.length > 0) {
      throw mitigationError(
        'MITIGATION_SPEC_CONFLICT',
        `spec lists ${both.join(', ')} in both include and exclude; refusing to guess which side wins`,
        { conflicting: both },
      )
    }
  }

  const names = new Set(MITIGATION_PROFILES[profile])
  for (const name of input.include ?? []) names.add(name)
  for (const name of input.exclude ?? []) names.delete(name)

  const ordered = canonicaliseNames([...names])
  return { profile, names: ordered, flags: flagsForNames(ordered) }
}

/**
 * 构造缓解策略（纯函数，不碰任何 Win32）。
 *
 * @param {string|{profile?:string, include?:string[], exclude?:string[], flags?:bigint|number|string}|null} [profileOrNames]
 *   （`include`/`exclude` 未给 `profile` 时以 `none` 为底：只得到点名的那些标志）
 * @returns {{profile:string, names:readonly string[], flags:bigint, buffer:Buffer, hex:string}}
 *   - `flags`：64 位标志（BigInt，避免 JS number 在 bit 44+ 上丢精度）；
 *   - `buffer`：**8 字节小端** `DWORD64`，即 `lpValue` 指向的内容。
 *     `[官方]` 该缓冲区必须存活到属性列表销毁 → 调用方持有本对象即可；
 *   - `hex`：`0x` + 16 位十六进制，供报告/日志直接引用。
 *
 * 未知档位/未知标志一律**抛错**，没有"忽略未知项"的分支（fail-closed）。
 */
export function buildMitigationPolicy(profileOrNames = DEFAULT_MITIGATION_PROFILE) {
  const { profile, names, flags } = normalizeSpec(profileOrNames)
  const buffer = Buffer.alloc(MITIGATION_POLICY_VALUE_SIZE)
  buffer.writeBigUInt64LE(flags, 0)
  const result = {
    profile,
    names: Object.freeze(names),
    flags,
    buffer,
    hex: `0x${flags.toString(16).padStart(16, '0')}`,
  }
  return Object.freeze(result)
}

/**
 * 该策略是否**无事可做**（`flags === 0n`）：调用方可据此跳过 `UpdateProcThreadAttribute`
 * 并少算一个属性列表容量。
 *
 * 注意：`none` 档与"空 include/空 exclude"都会得到 `true`；这是**显式**语义，
 * 不是失败 —— 但**默认档不是 `none`**（见 `DEFAULT_MITIGATION_PROFILE`）。
 */
export function isNoop(policy) {
  const built = isBuiltPolicy(policy) ? policy : buildMitigationPolicy(policy)
  return built.flags === 0n
}

function isBuiltPolicy(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof value.flags === 'bigint' &&
    Buffer.isBuffer(value.buffer) &&
    Array.isArray(value.names) &&
    typeof value.profile === 'string'
  )
}

/**
 * 审计/报告用：把策略（或裸标志值）还原成**已启用的标志名**。
 *
 * 判定方式：对一个名字，当且仅当 `(flags & MITIGATION_FLAGS[name]) === 该标志` 时算启用。
 * 因 `MITIGATION_FLAGS` 全是单一位，这等价于"该位被置上" —— 且它**不猜**多位置位族的语义：
 * 例如 `0x3 << 36`（`ALWAYS_ON_ALLOW_OPT_OUT`，官方语义是"ACG，但允许 opt-out"）
 * 会被读成 `PROHIBIT_DYNAMIC_CODE` 已开启，同时 `validateMitigationFlags()` 会报
 * "该族置了 ALWAYS_ON 以外的位" —— 报告里既不会漏报，也不会假装它是严格的 ACG。
 *
 * @param {bigint|number|string|{flags:bigint}} flagsOrResult
 * @returns {string[]} 已启用标志名（按位序稳定排序）
 */
export function describeMitigationPolicy(flagsOrResult) {
  let flags
  if (isBuiltPolicy(flagsOrResult)) {
    flags = flagsOrResult.flags
  } else if (flagsOrResult !== null && typeof flagsOrResult === 'object' && flagsOrResult.flags !== undefined) {
    flags = toFlagValue(flagsOrResult.flags, 'flagsOrResult.flags')
  } else {
    flags = toFlagValue(flagsOrResult, 'flagsOrResult')
  }
  assertFlagRange(flags, 'flagsOrResult')
  return namesForFlags(flags)
}

/**
 * 显式校验标志值里的"越界组合"与"官方前提缺失"，供审计/报告使用。
 *
 * 返回 `{ warnings: string[], names: string[] }`（不抛错：这是**审计**入口，
 * 目的是把问题**报出来**；抛错的 fail-closed 判定在 `buildMitigationPolicy` 与
 * `applyMitigationPolicy` 上）。三条判据都是 `[官方]` 语义的直读：
 *   1. `DEP_ATL_THUNK_ENABLE` 官方要求必须与 `DEP_ENABLE` 同开；
 *   2. `HIGH_ENTROPY_ASLR` 官方要求仅当 `BOTTOM_UP_ASLR` 也开才有效；
 *   3. `*_MASK` 族置了 `ALWAYS_ON` 之外的位（`0x3 << n` 里的另一位）⇒ 语义已不是"硬开"。
 */
export function validateMitigationFlags(flagsOrResult) {
  const flags = isBuiltPolicy(flagsOrResult)
    ? flagsOrResult.flags
    : typeof flagsOrResult === 'object' && flagsOrResult !== null && flagsOrResult.flags !== undefined
      ? toFlagValue(flagsOrResult.flags, 'flagsOrResult.flags')
      : toFlagValue(flagsOrResult, 'flagsOrResult')
  assertFlagRange(flags, 'flagsOrResult')

  const names = namesForFlags(flags)
  const warnings = []

  if ((flags & MITIGATION_FLAGS.DEP_ATL_THUNK_ENABLE) !== 0n && (flags & MITIGATION_FLAGS.DEP_ENABLE) === 0n) {
    warnings.push('DEP_ATL_THUNK_ENABLE is set without DEP_ENABLE; [官方] ATL thunk emulation may only be specified together with DEP_ENABLE')
  }
  if ((flags & MITIGATION_FLAGS.HIGH_ENTROPY_ASLR) !== 0n && (flags & MITIGATION_FLAGS.BOTTOM_UP_ASLR) === 0n) {
    warnings.push('HIGH_ENTROPY_ASLR is set without BOTTOM_UP_ASLR; [官方] high-entropy randomization is effective only if bottom-up ASLR is also enabled')
  }
  for (const [name, mask] of Object.entries(MITIGATION_MASKS)) {
    const on = MITIGATION_FLAGS[name]
    if ((flags & mask) !== 0n && (flags & mask) !== on) {
      warnings.push(
        `${name}: bits 0x${(flags & mask).toString(16)} are set inside MASK 0x${mask.toString(16)}, which is not the ALWAYS_ON value 0x${on.toString(16)}; the family semantics differ (e.g. ALWAYS_OFF / ALLOW_STORE / ALLOW_OPT_OUT)`,
      )
    }
  }
  const unknownBits = flags & ~Object.values(MITIGATION_FLAGS).reduce((a, b) => a | b, 0n)
  if (unknownBits !== 0n) {
    warnings.push(`bits 0x${unknownBits.toString(16)} are not covered by MITIGATION_FLAGS (either a PROCESS_CREATION_MITIGATION_POLICY2_* bit belonging to the second DWORD64, or reserved)`)
  }

  return { names, warnings }
}

// ─────────────────────────── 6. 注入（fail-closed）────────────────────────────

/** 解析 `pin`：函数则调用（带 `what` 便于报错），否则原样透传（内联指针/地址） */
function resolvePinnedValue(pin, buffer, what) {
  if (pin === null || pin === undefined) return buffer
  if (typeof pin === 'function') {
    const resolved = pin(buffer, what)
    if (resolved === null || resolved === undefined) {
      throw mitigationError(
        'MITIGATION_PIN_FAILED',
        `pin(${what}) returned nothing; refusing to pass a buffer without a resolvable native address ` +
          '(the attribute value pointer must stay valid until the attribute list is destroyed)',
      )
    }
    return resolved
  }
  return pin
}

/**
 * 把缓解策略写进属性列表。
 *
 * `api.updateProcThreadAttribute(attrList, 0, MITIGATION_POLICY_ATTRIBUTE, value, 8, null, null)`
 *
 * **绝不吞失败**：返回 `false`（或 `null`/`undefined`/非法类型）即抛
 * `MITIGATION_ATTRIBUTE_UPDATE_FAILED`，并带上 `GetLastError()` 的 `win32Code`
 * （`GetLastError` 本身不可用/抛错时 `win32Code = null`，仍然抛）。
 * 理由就是 denylist 的语义：**没能施加的策略等于没有策略** ——
 * 让启动继续下去会得到一个"看起来被加固、实际裸奔"的子进程，
 * 与本仓库已留档的最坏缺陷形态（`appcontainer-runtime.mjs:181-196` 的 DWORD 错误）
 * 完全同族。
 *
 * `pin` 的语义与 `src/appcontainer-runtime.mjs` 一致：`(buffer, what) => address`；
 * 真实运行期用 koffi 时传 `(b) => koffi.address(b)`。`[官方]` 属性值指针的**生命周期**
 * 由调用方负责：本函数只把指针交给属性列表，缓冲区仍由 `buildMitigationPolicy` 的
 * 返回值持有（`[未实测]` 未在本机真实验证过生命周期——依赖方引用了返回对象即安全）。
 *
 * @param {{api:{updateProcThreadAttribute:Function, getLastError?:Function}, attrList:unknown,
 *          policy?:string|object, pin?:Function|unknown}} params
 * @returns {{applied:true, attribute:number, size:number, value:unknown, flags:bigint, names:string[], profile:string, noop:boolean}}
 */
export function applyMitigationPolicy({ api, attrList, policy, pin } = {}) {
  if (!api || typeof api.updateProcThreadAttribute !== 'function') {
    throw mitigationError(
      'MITIGATION_BINDINGS_INVALID',
      'api.updateProcThreadAttribute is not a function; refusing to continue — an un-applied mitigation policy is not a policy',
    )
  }
  if (attrList === null || attrList === undefined) {
    throw mitigationError('MITIGATION_ATTRLIST_INVALID', 'attrList is null/undefined; InitializeProcThreadAttributeList must run first (and must have sized the list for this extra attribute)')
  }

  const built = isBuiltPolicy(policy) ? policy : buildMitigationPolicy(policy ?? DEFAULT_MITIGATION_PROFILE)
  const value = resolvePinnedValue(pin, built.buffer, 'PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY')

  const updated = api.updateProcThreadAttribute(
    attrList,
    0,
    MITIGATION_POLICY_ATTRIBUTE,
    value,
    MITIGATION_POLICY_VALUE_SIZE,
    null,
    null,
  )

  if (!win32BoolSucceeded(updated)) {
    let code = null
    if (typeof api.getLastError === 'function') {
      try {
        code = api.getLastError()
      } catch {
        code = null
      }
    }
    throw mitigationError(
      'MITIGATION_ATTRIBUTE_UPDATE_FAILED',
      `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY) failed with ${code}. ` +
        `Attr id=0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}, value size=${MITIGATION_POLICY_VALUE_SIZE}, ` +
        `profile=${built.profile}, flags=${built.hex}. ` +
        'The attribute list was NOT written, so the child would silently run WITHOUT these mitigations; ' +
        'aborting the launch (fail-closed).',
      { win32Code: code, attribute: MITIGATION_POLICY_ATTRIBUTE, size: MITIGATION_POLICY_VALUE_SIZE, profile: built.profile, flags: built.flags },
    )
  }

  return {
    applied: true,
    attribute: MITIGATION_POLICY_ATTRIBUTE,
    size: MITIGATION_POLICY_VALUE_SIZE,
    value,
    flags: built.flags,
    names: built.names,
    profile: built.profile,
    noop: built.flags === 0n,
  }
}

// ─────────────────────────── 7. 可用性探测 ───────────────────────────────────

/**
 * 探测当前绑定表能否接受 `PROC_THREAD_ATTRIBUTE_MITIGATION_POLICY`。
 *
 * 语义（刻意保守）：
 *   - 绑定表缺 `updateProcThreadAttribute` ⇒ `supported:false`，`errorCode:'MITIGATION_BINDINGS_INVALID'`；
 *   - 调用返回假值时 ⇒ `supported:false`，`errorCode` = `GetLastError()` 的数字码（拿不到就是 `null`）；
 *   - 调用**抛异常**时 ⇒ `supported:false`，`errorCode` 为异常对象上的 `code`/`win32Code`
 *     （没有就是 `null`），`reason` 里带异常 message；
 *   - **只有**调用返回真值时才 `supported:true`。
 *
 * 这样写的原因：`[推断]` 平台/镜像/版本差异下"该属性号不被接受"是完全可能的结果
 * （官方页只承诺 Windows 7+ 的**属性**存在，策略位本身按版本分级支持，
 * 例如 `EXTENSION_POINT_DISABLE` 等高位在新系统上才落地）。
 * 探测出错时返回 `true` 是最危险的默认值，因此这里**没有任何**"乐观返回 true"的分支。
 *
 * ⚠ `[未实测]` 本机没有跑过真实 API。用离线替身时，`attributeList` 需要由调用方给
 * （真实 API 会校验它是 `InitializeProcThreadAttributeList` 产出的指针；替身通常不校验）。
 * 显式传 `ownAttributeList: true` 时，会在缺省 `api.initializeProcThreadAttributeList` 的
 * 情况下临时造一个假列表 —— 这只对替身有意义，**不要**在真实启动路径里用（真实调用
 * 会因假指针返回 `ERROR_INVALID_PARAMETER`，被本函数如实报成"不支持"，
 * 从而把"探测方式不对"误读成"平台不支持"）。
 *
 * @param {{api:object, attributeList?:unknown, policy?:string|object, ownAttributeList?:boolean}} params
 * @returns {{supported:boolean, reason:string, errorCode:number|string|null, attribute:number, size:number, notes:string[]}}
 */
export function probeMitigationSupport({ api, attributeList, policy, ownAttributeList = false } = {}) {
  const base = {
    supported: false,
    attribute: MITIGATION_POLICY_ATTRIBUTE,
    size: MITIGATION_POLICY_VALUE_SIZE,
  }
  const fail = (errorCode, reason, notes = []) => ({ ...base, reason, errorCode, notes })

  if (!api || typeof api.updateProcThreadAttribute !== 'function') {
    return fail(
      'MITIGATION_BINDINGS_INVALID',
      'bindings lack updateProcThreadAttribute, so the mitigation policy attribute can never be written',
      ['[推断] 缺绑定 ⇒ 无法证明该属性可施加；按 fail-closed 记为不支持，而不是静默假定支持'],
    )
  }

  const notes = []
  let list = attributeList
  if (list === null || list === undefined) {
    if (!ownAttributeList) {
      return fail(
        'MITIGATION_ATTRLIST_REQUIRED',
        'no attribute list supplied for the probe; pass { attributeList } (produced by InitializeProcThreadAttributeList) ' +
          'or set ownAttributeList:true to fabricate one for a stub binding table',
        notes,
      )
    }
    if (typeof api.initializeProcThreadAttributeList === 'function') {
      try {
        const sizeSlot = [0]
        api.initializeProcThreadAttributeList(null, 1, 0, sizeSlot)
        list = Buffer.alloc(Math.max(1, Number(sizeSlot[0]) || 0))
        api.initializeProcThreadAttributeList(list, 1, 0, sizeSlot)
        notes.push('[推断] 探测用属性列表由 api.initializeProcThreadAttributeList 两阶段协商得到')
      } catch (error) {
        return fail(
          error?.code ?? error?.win32Code ?? null,
          `initializeProcThreadAttributeList threw during probe: ${error?.message ?? String(error)}`,
          notes,
        )
      }
    } else {
      list = Buffer.alloc(8)
      notes.push('[推断] ownAttributeList 且无 initializeProcThreadAttributeList：使用 8 字节假列表，仅对离线替身有意义')
    }
  }

  const built = isBuiltPolicy(policy) ? policy : buildMitigationPolicy(policy ?? DEFAULT_MITIGATION_PROFILE)
  let result
  try {
    result = api.updateProcThreadAttribute(list, 0, MITIGATION_POLICY_ATTRIBUTE, built.buffer, MITIGATION_POLICY_VALUE_SIZE, null, null)
  } catch (error) {
    return fail(
      error?.code ?? error?.win32Code ?? null,
      `updateProcThreadAttribute(0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}) threw: ${error?.message ?? String(error)}`,
      notes,
    )
  }

  if (!win32BoolSucceeded(result)) {
    let code = null
    if (typeof api.getLastError === 'function') {
      try {
        code = api.getLastError()
      } catch {
        code = null
      }
    }
    return fail(code, `updateProcThreadAttribute(0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}) returned ${String(result)}, GetLastError=${code}`, notes)
  }

  return {
    ...base,
    supported: true,
    reason: `updateProcThreadAttribute(0x${MITIGATION_POLICY_ATTRIBUTE.toString(16)}) accepted an ${MITIGATION_POLICY_VALUE_SIZE}-byte value (profile=${built.profile})`,
    errorCode: null,
    notes,
  }
}

// ─────────────────────────── 8. 报告摘要 ─────────────────────────────────────

/**
 * 能力报告用的摘要：`{ profile, flags: string(hex), names }`。
 *
 * 刻意**只**输出这三项（外加可选的属性号/尺寸/可用性，便于报告直接引用）：
 * 报告里必须能一眼看出"这一档到底置了哪些位"，而不是只写一句"已启用缓解策略"。
 *
 * @param {{profile:string, flags:bigint, names:string[]}} result `buildMitigationPolicy()` 的返回值
 * @returns {{profile:string, flags:string, names:string[], attribute:string, size:number, noop:boolean}}
 */
export function summariseMitigations(result) {
  const built = isBuiltPolicy(result) ? result : buildMitigationPolicy(result ?? DEFAULT_MITIGATION_PROFILE)
  return {
    profile: built.profile,
    flags: `0x${built.flags.toString(16).padStart(16, '0')}`,
    names: [...built.names],
    attribute: `0x${MITIGATION_POLICY_ATTRIBUTE.toString(16).padStart(8, '0')}`,
    size: MITIGATION_POLICY_VALUE_SIZE,
    noop: built.flags === 0n,
  }
}

// ─────────────────────────── 9. 集成方接线须知（属性列表容量）──────────────────

/**
 * 本模块**新增**的属性列表条目数：恰好 1。
 *
 * 集成方接线时必须把这一条算进 `InitializeProcThreadAttributeList` 的
 * `dwAttributeCount`：AppContainer 路径已有 1 条（`SECURITY_CAPABILITIES` = `0x00020009`），
 * 加上本属性就是 **2**。`[官方]` 若实际 `UpdateProcThreadAttribute` 次数超过初始化的容量，
 * 调用会返回 `ERROR_INSUFFICIENT_BUFFER(122)` —— 本模块的 `applyMitigationPolicy` 会把它
 * 如实抛成 `MITIGATION_ATTRIBUTE_UPDATE_FAILED`（**不会**被当成"策略已生效"）。
 *
 * `0x00020009` 这个数字**不在本模块重复定义**（避免与 `src/appcontainer.mjs` 两处漂移），
 * 这里只声明"本模块占 1 个槽位"这一条事实。
 */
export const MITIGATION_ATTRIBUTE_LIST_COUNT = 1

/** 测试与集成方复用的内部工具（**不是**对外 API：稳定契约是上面那些导出） */
export const __internal = Object.freeze({
  normalizeSpec,
  namesForFlags,
  flagsForNames,
  win32BoolSucceeded,
})
