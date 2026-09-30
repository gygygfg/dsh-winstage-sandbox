/**
 * WindowsCapabilityProbe — 真实执行路径能力探测
 *
 * 手册依据（v3.0）：
 *   第 5 章   能力探测 = 真实执行路径验证
 *   #5.1      探测场景必须与真实执行场景一致，否则假阳性/假阴性
 *   #5.2      支持项存在 != 可执行（/proc/filesystems 假阳性 → Windows 对应物：
 *             "功能已安装" != "本令牌能真的用上"）
 *   #5.4      承诺的降级路径必须有触发条件与测试
 *   #5.5      缓存键必须绑定环境指纹；缓存成功不等于实例可用
 *
 * 设计要点：
 *   - 每个探测都返回 { status, detail, evidence } ，status ∈ pass|fail|unknown
 *   - 不做"静态推断"：凡是能从当前进程真实调用一次 Win32 的，就真实调用一次
 *   - 无法在无管理员令牌下验证的（AppContainer 创建、Hyper-V、Windows Sandbox），
 *     标为 unknown 而不是 pass —— 手册 0.1 要求证据分层，[推断] 不得升级为 [实测]
 *   - 指纹 = 所有会影响结论的环境量；缓存文件以指纹为键
 *
 * 证据等级标注：脚本注释里的 [实测]/[官方]/[推断] 即手册 0.1 的等级。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDshModuleRoot } from './executor.mjs'
// T0 隔离判据**只从这一处来**：本文件不自己造判据，避免"两处漂移"
// （`readProcessTokenFacts` = 令牌证据；`assessAppContainerIsolation` = 五项判据缺一即 false）。
// 静态 import（不是 require_）：它是 ESM 模块，`createRequire` 解析不了 `.mjs`。
import {
  assessAppContainerIsolation,
  createKoffiAppContainerBindings,
  readProcessTokenFacts,
} from './appcontainer-runtime.mjs'
import { WINDOWS_HIDE, suppressWindowsCriticalErrorDialogs } from './spawn-window.mjs'

suppressWindowsCriticalErrorDialogs()

// ESM 下同步 require；必须在模块顶部初始化，否则函数内的引用会命中暂时性死区
const require_ = createRequire(import.meta.url)

/**
 * 探测版本。**改这个数会作废所有磁盘上的隔离测量缓存**（缓存键含它）。
 *
 * 为什么要绑定版本而不是让缓存自然过期：`appContainerIsolation.proven` 是喂给
 * `selectTier()` 的 fail-closed 闸门的**唯一**输入。只要判定口径（五项判据、proven 的
 * 推导方式、`assessAppContainerIsolation()` 的行为）改过一次，旧缓存里的 `proven` 就
 * 不能再被当成新口径下的结论 —— 那是典型的"缓存成功不等于实例可用"（手册 #5.5）。
 * 因此：**判定口径一改，这里必须 +1**。本轮把 T0 判据接进探测流程时由 1 升到 2。
 */
export const PROBE_VERSION = 2

/** 探测状态：pass=实测可用；fail=实测不可用；unknown=本上下文无法实测（禁止当作可用） */
export const PASS = 'pass'
export const FAIL = 'fail'
export const UNKNOWN = 'unknown'

function ok(detail, extra = {}) {
  return { status: PASS, detail, ...extra }
}
function no(detail, extra = {}) {
  return { status: FAIL, detail, ...extra }
}
function unknown(detail, extra = {}) {
  return { status: UNKNOWN, detail, ...extra }
}

function safe(fn, fallback) {
  try {
    return fn()
  } catch (error) {
    return fallback(error)
  }
}

/**
 * koffi 是随 DSH 安装的 FFI，用来真实调用 Win32。
 * 没有它也能跑，只是 AppContainer/令牌类探测降级为 unknown（诚实降级，不假装 pass）。
 * 解析顺序复用 executor 的 DSH 安装定位，避免硬编码路径（手册 #0.1）。
 *
 * ── 为什么还要多一个 `$DSH_PROFILE_DIR/node_modules` 候选（本轮补）──────────────
 * `[实测]` 本机 koffi 的真正落点是 `%USERPROFILE%\.dsh\profiles\node_modules\koffi`
 * （即 `DSH_PROFILE_DIR` 下的 node_modules），而 `resolveDshModuleRoot()` 给的是
 * **dsh 自身的安装树**（`...\_npx\<hash>\node_modules`）。那份树里**没有** koffi。
 * 于是默认探测里所有 Win32 探测都退化成 `unknown`，`jobObject` 拿不到证据 ⇒
 * 整个 report 的 tier 判定只能靠"猜"，这是"探测能力被环境漂移吃掉"的典型形态。
 * 这里补上 profile 级 node_modules 作为候选（仍不硬编码任何绝对路径：
 * 路径来自环境变量，缺失就自然跳过）。
 */
export function loadFfi() {
  // resolveDshModuleRoot() 返回的是 node_modules 根，因此包名直接 join 即可
  const candidates = [...resolveDshModuleRoot().map((root) => join(root, 'koffi'))]
  if (typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR.length > 0) {
    candidates.push(join(process.env.DSH_PROFILE_DIR, 'node_modules', 'koffi'))
  }
  candidates.push('koffi')
  for (const spec of candidates) {
    const loaded = safe(
      () => {
        const mod = require_(spec)
        return mod && typeof mod.load === 'function' ? mod : undefined
      },
      () => undefined,
    )
    if (loaded) return loaded
  }
  return undefined
}

export function probeWin32Abi() {
  const koffi = loadFfi()
  if (!koffi) {
    return unknown('koffi FFI unavailable; Win32 ABI probes cannot run in this context', {
      evidence: '[实测] require("koffi") failed',
    })
  }
  const results = {}

  let advapi32
  let kernel32
  try {
    advapi32 = koffi.load('advapi32.dll')
    kernel32 = koffi.load('kernel32.dll')
  } catch (error) {
    return no(`advapi32/kernel32 load failed: ${error.message}`, { evidence: '[实测]' })
  }

  const GetCurrentProcess = kernel32.func('void *GetCurrentProcess()')
  const CloseHandleK = kernel32.func('bool CloseHandle(void *hObject)')
  const OpenProcessToken = advapi32.func('bool OpenProcessToken(void *h, uint32 acc, _Out_ void **out)')

  /**
   * 令牌访问权逐项实测。
   *
   * 为什么逐项而不是"一次 TOKEN_ALL_ACCESS"：CreateRestrictedToken 需要的不是
   * TOKEN_ALL_ACCESS，而是具体的 TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY
   * | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID。逐项实测才能定位缺哪一项，
   * 也才能解释"为什么受限会话里无法再建受限令牌"（手册 #5.1 探测须与真实路径一致）。
   */
  const RIGHTS = {
    TOKEN_ASSIGN_PRIMARY: 0x0001,
    TOKEN_DUPLICATE: 0x0002,
    TOKEN_QUERY: 0x0008,
    TOKEN_ADJUST_DEFAULT: 0x0080,
    TOKEN_ADJUST_SESSIONID: 0x0100,
  }
  const granted = {}
  for (const [name, mask] of Object.entries(RIGHTS)) {
    const slot = [null]
    let okFlag = false
    try {
      okFlag = OpenProcessToken(GetCurrentProcess(), mask, slot) === true
    } catch {
      okFlag = false
    }
    granted[name] = okFlag
    if (okFlag && slot[0]) safe(() => CloseHandleK(slot[0]), () => undefined)
  }

  results.tokenRights = {
    status: Object.values(granted).every(Boolean) ? PASS : FAIL,
    evidence: '[实测] OpenProcessToken 逐项探测',
    detail: Object.entries(granted)
      .map(([name, has]) => `${name}=${has ? 'yes' : 'NO'}`)
      .join(' '),
    granted,
  }

  // CreateRestrictedToken 的实测前置条件（这是本工具最关键的降级判据）
  const restrictedTokenViable =
    granted.TOKEN_DUPLICATE && granted.TOKEN_QUERY && granted.TOKEN_ASSIGN_PRIMARY && granted.TOKEN_ADJUST_DEFAULT && granted.TOKEN_ADJUST_SESSIONID
  results.createRestrictedTokenViable = restrictedTokenViable
    ? ok('all rights required by CreateRestrictedToken are held — a nested restricted token can be minted', {
        evidence: '[实测]',
      })
    : no(
        'CreateRestrictedToken cannot succeed here: the token lacks ' +
          Object.entries(granted)
            .filter(([, has]) => !has)
            .map(([name]) => name)
            .join(', ') +
          '. A nested sandbox is impossible in an already-confined process.',
        { evidence: '[实测]', granted },
      )

  // --- 2. 写入面：工作区外、系统目录 ---
  const outsideRoot = join(dirname(tmpdir()), `dsh-probe-outside-${Date.now()}`)
  results.writeOutsideWorkspace = safe(
    () => {
      mkdirSync(outsideRoot, { recursive: true })
      writeFileSync(join(outsideRoot, 'x.txt'), 'x')
      rmSync(outsideRoot, { recursive: true, force: true })
      return ok(`created and removed ${outsideRoot} — no outer write boundary observed`, { evidence: '[实测]' })
    },
    (error) => no(`write outside workspace denied: ${error.code || error.message} — an outer write boundary is active`, { evidence: '[实测]' }),
  )

  results.writeSystemDir = safe(
    () => {
      writeFileSync('C:\\Windows\\dsh-probe-write.txt', 'x')
      rmSync('C:\\Windows\\dsh-probe-write.txt', { force: true })
      return no('C:\\Windows is writable — write boundary absent!', { evidence: '[实测]' })
    },
    (error) => ok(`C:\\Windows write denied: ${error.code || error.message}`, { evidence: '[实测]' }),
  )

  // --- 3. 读取面：只读不代表允许读（手册第 16 章） ---
  const readTargets = [
    ['C:\\Windows\\System32\\config\\SAM', '本地账户数据库'],
    ['C:\\Windows\\win.ini', '系统文件（对照项）'],
  ]
  results.readSurface = readTargets.map(([path, label]) => {
    const r = safe(() => statSync(path).size, (error) => `DENIED(${error.code || 'ERR'})`)
    return { path, label, result: r }
  })

  // --- 4. Job Object：进程树回收能力 ---
  //
  // ── FIX-E（P0）：**绝不允许把调用者自己挂进验证用 Job** ────────────────────────
  // 上一轮的 tier 假阴性修复在这里加了自指派
  //     AssignProcessToJobObject(job, GetCurrentProcess())
  // 并给验证用 Job 置了 JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE(0x2000)。本环境自指派**成功**
  // （不是预期中的 ERROR_ACCESS_DENIED(5)），于是 probe 走 `verifiedVia:'self'` 分支，
  // 而 finally 里的 `CloseHandle(job)` 被内核解释为"作业关闭 → 杀掉作业内所有进程" ——
  // 被杀死的正是**调用者自己**：进程静默终止、exit=0、stdout/stderr 全 0 字节，
  // `safe()` 连异常都来不及吞。爆炸半径覆盖 cli probe/init/audit、worker 启动探针、
  // 插件 probeOnStart。
  //   [实测] `.t\sbx3\fixE\before-diag-probeabi.out.txt`：只打出 BEFORE/IMPORTED，无 AFTER；
  //   [实测] `.t\sbx3\fixE\before-cli-probe.out.json`：0 字节且 exit=0。
  //
  // 因此本段的判据只剩**一条**，且与执行器真实路径一致（手册 #5.1）：
  //   把**我们派生的子进程**纳入 Job，再回读 JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
  //   要求 TotalProcesses>=1 —— 这正是本文件初版注释自己论证过的路径。
  //   拿不到这份证据 ⇒ fail（fail-closed 语义不变，不放宽）。
  // 两条硬约束（`tests\probe-selfkill-guard.mjs` 钉死）：
  //   (a) 当前进程**永不**被指派进验证用 Job ⇒ 关句柄不可能波及调用者；
  //   (b) 验证用 Job **不设** KILL_ON_JOB_CLOSE（纵深防御：即使将来有人误把活进程挂进来，
  //       CloseHandle 也不再等价于"杀进程"）；子进程的回收由显式 TerminateProcess 负责。
  // 结构体大小仍固定为 144（JOBOBJECT_EXTENDED_LIMIT_INFORMATION 的真实大小）。
  const CreateJobObjectW = kernel32.func('void *CreateJobObjectW(void *a, const char16_t *name)')
  const SetInformationJobObject = kernel32.func(
    'bool SetInformationJobObject(void *job, int infoClass, void *info, uint32 len)',
  )
  const AssignProcessToJobObject = kernel32.func('bool AssignProcessToJobObject(void *job, void *process)')
  const QueryInformationJobObject = kernel32.func(
    'bool QueryInformationJobObject(void *job, int cls, void *info, uint32 len, void *ret)',
  )
  const GetLastError = kernel32.func('uint32 GetLastError()')

  /** 建一个**不带任何限制**的验证用 Job，返回句柄 */
  const makeVerifyJob = () => {
    const job = CreateJobObjectW(null, null)
    if (!job) throw new Error('CreateJobObjectW returned NULL')
    const info = Buffer.alloc(144)
    // FIX-E(b)：LimitFlags 恒为 0 —— **不置** 0x2000 (KILL_ON_JOB_CLOSE)。
    // 指派证明不需要它，而它把"关闭句柄"变成"杀死作业内进程"，正是上一轮 P0 的杀伤机制。
    if (SetInformationJobObject(job, 9 /* JobObjectExtendedLimitInformation */, info, info.length) !== true) {
      const code = GetLastError()
      safe(() => CloseHandleK(job), () => undefined)
      throw new Error(`SetInformationJobObject failed (GetLastError=${code})`)
    }
    return job
  }

  /**
   * Job 里的活动进程数。
   *
   * 偏移必须与 `src\executor.mjs` 的 `OFF_ACCOUNTING` **逐字一致**（那里有 48 字节的
   * 精确大小与"偏移写错会 ERR_OUT_OF_RANGE"的教训，并有 `tests\struct-layout.mjs` 钉死）：
   *   JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
   *     TotalPageFaultCount  @32
   *     TotalProcesses       @36
   *     ActiveProcesses      @40   ← 这里要的就是它
   *     TotalTerminatedProcesses @44
   * 这里最初写成"@44 = activeProcesses"，那是**读错字段**（读到的其实是已终止进程数），
   * 而它只会让 detail 里的数字偏小、不会报错——属于"看起来成功"的假证据。
   */
  const JOB_ACCOUNTING_SIZE = 48
  const OFF_TOTAL_PROCESSES = 36
  const OFF_ACTIVE_PROCESSES = 40
  /** 返回 `{ total, active }`；查询失败返回 undefined */
  const accountingOf = (job) => {
    const accounting = Buffer.alloc(JOB_ACCOUNTING_SIZE)
    const queried = QueryInformationJobObject(job, 1, accounting, accounting.length, null)
    if (!queried) return undefined
    return { total: accounting.readUInt32LE(OFF_TOTAL_PROCESSES), active: accounting.readUInt32LE(OFF_ACTIVE_PROCESSES) }
  }

  /**
   * 派生一个用于指派验证的子进程，**在它仍然存活时**交出 pid 与 ChildProcess。
   *
   * 为什么不能沿用 `spawnSync`（FIX-E 暴露的第二个缺陷）：
   *   `spawnSync` 返回时子进程**已经退出**、libuv 已释放其进程句柄。此时
   *   `AssignProcessToJobObject` 对一个已终止的进程返回 false + ERROR_ACCESS_DENIED(5)，
   *   于是 jobObject 会被误判成 fail —— tier 假阴性会以另一种形式复活。
   *   [实测] `.t\sbx3\fixE\exp1.out.txt` A 组：spawnSync → OpenProcess 句柄非空，
   *   但 assign=false、GetLastError=5、accounting total=0；B/C 组改用存活子进程后
   *   assign=true、accounting total=1。
   * 因此改用 `spawn`：它**同步返回** pid（子进程此刻必然存活），同一 tick 内即可完成
   * OpenProcess → AssignProcessToJobObject → 回读 accounting，随后由调用者显式终止。
   *
   * 为什么子进程用"活得够久"而不是 `cmd /c exit 0`：后者可能在我们的 OpenProcess 之前
   * 就退出，重现上面那个竞态。ping / node 空转都会稳定存活到指派完成，再由
   * TerminateProcess 立即收掉（不依赖 KILL_ON_JOB_CLOSE，见 FIX-E(b)）。
   *
   * 不用 `stdio:'pipe'`：受限令牌下捕获子进程输出会走命名管道并 EPERM（残余边界 R10）。
   * 只继承 SystemRoot，避免把宿主的敏感环境变量带进探针子进程。
   */
  const spawnAssignmentProbe = () => {
    const { spawn } = require_('node:child_process')
    const systemRoot = process.env.SystemRoot || 'C:\\Windows'
    const candidates = []
    const ping = join(systemRoot, 'System32', 'ping.exe')
    if (existsSync(ping)) candidates.push({ exe: ping, args: ['-n', '30', '127.0.0.1'], kind: 'ping.exe' })
    // 绝对路径调用当前 node 自身，不依赖 PATH
    candidates.push({ exe: process.execPath, args: ['-e', 'setTimeout(() => {}, 20000)'], kind: 'node-idle' })
    for (const candidate of candidates) {
      if (!existsSync(candidate.exe)) continue
      const child = safe(
        () =>
          spawn(candidate.exe, candidate.args, {
            stdio: 'ignore',
            // 见 src/spawn-window.mjs：不用会 0xC0000142 的那组创建标志；
            // 弹框由该模块在模块入口的 SetErrorMode 抑制。
            windowsHide: WINDOWS_HIDE,
            env: { SystemRoot: systemRoot },
          }),
        () => undefined,
      )
      if (child && typeof child.pid === 'number' && child.pid > 0) {
        return { pid: child.pid, kind: candidate.kind, child }
      }
      safe(() => child?.kill?.(), () => undefined)
    }
    return undefined
  }

  results.jobObject = safe(
    () => {
      const job = makeVerifyJob()
      const probe = spawnAssignmentProbe()
      try {
        if (!probe) {
          return no(
            'no assignment probe child could be spawned (ping.exe and the current node executable were both unusable); ' +
              'cannot prove process-tree reclamation',
            { evidence: '[实测]', childSpawned: false, selfAssigned: false },
          )
        }
        const OpenProcess = kernel32.func('void *OpenProcess(uint32 access, bool inherit, uint32 pid)')
        const TerminateProcess = kernel32.func('bool TerminateProcess(void *proc, uint32 code)')
        const PROCESS_TERMINATE = 0x0001
        const PROCESS_SET_QUOTA = 0x0100
        const PROCESS_QUERY_INFORMATION = 0x0400
        const handle =
          OpenProcess(PROCESS_TERMINATE | PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION, false, probe.pid) || null
        if (!handle) {
          return no(`OpenProcess(pid=${probe.pid}) failed (GetLastError=${GetLastError()})`, {
            evidence: '[实测]',
            childSpawned: true,
            childPid: probe.pid,
            childKind: probe.kind,
            selfAssigned: false,
          })
        }
        try {
          const childAssigned = AssignProcessToJobObject(job, handle) === true
          if (!childAssigned) {
            // 拿不到"Job 可指派"的证据 → 保持 fail-closed：不得据此升级档位
            const assignError = GetLastError()
            return no(
              `AssignProcessToJobObject failed for the derived child (pid=${probe.pid}, ${probe.kind}, ` +
                `GetLastError=${assignError}); process-tree reclamation cannot be enforced in this context`,
              {
                evidence: '[实测]',
                childSpawned: true,
                childPid: probe.pid,
                childKind: probe.kind,
                childAssigned: false,
                assignError,
                selfAssigned: false,
              },
            )
          }
          // 不能只凭返回值：回读 Job 计数确认指派**真的生效**。
          // 判据用 TotalProcesses>=1（而不是 ActiveProcesses>=1）：子进程可能已经退出，
          // 那时 active 合法地为 0，但"曾经被指派进来"这一事实仍由 total 保留。
          const acct = accountingOf(job)
          if (!acct || acct.total < 1) {
            return no(
              `AssignProcessToJobObject(child pid=${probe.pid}) returned success but the job accounting does not show it ` +
                `(accounting=${acct ? JSON.stringify(acct) : 'query failed'}); refusing to treat the job as usable`,
              {
                evidence: '[实测]',
                childSpawned: true,
                childPid: probe.pid,
                childKind: probe.kind,
                childAssigned: true,
                accounting: acct ?? null,
                selfAssigned: false,
              },
            )
          }
          return ok(
            `a derived child process (pid=${probe.pid}, ${probe.kind}) was assigned into a scratch Job and verified in the ` +
              `job accounting (totalProcesses=${acct.total}, activeProcesses=${acct.active}); ` +
              `the current process is deliberately NOT assigned, so closing the job handle cannot kill the caller`,
            {
              evidence: '[实测]',
              verifiedVia: 'child-process',
              childSpawned: true,
              childPid: probe.pid,
              childKind: probe.kind,
              childAssigned: true,
              accounting: acct,
              selfAssigned: false,
              killOnJobClose: false,
            },
          )
        } finally {
          // 显式收尾：先杀子进程，再关句柄。**不依赖** KILL_ON_JOB_CLOSE（FIX-E(b)）。
          safe(() => TerminateProcess(handle, 1), () => undefined)
          safe(() => CloseHandleK(handle), () => undefined)
        }
      } finally {
        // 任何提前 return 的路径都不能留下未收管的探针子进程
        safe(() => probe?.child?.kill?.(), () => undefined)
        safe(() => CloseHandleK(job), () => undefined)
      }
    },
    (error) => no(`Job Object unavailable: ${error.message}`, { evidence: '[实测]', selfAssigned: false }),
  )

  return { status: 'mixed', checks: results }
}

/** AppContainer 创建探测：必须在**当前令牌**下真实调用 CreateAppContainerProfile */
export function probeAppContainer() {
  const koffi = loadFfi()
  if (!koffi) return unknown('koffi FFI unavailable')
  const userenv = safe(() => koffi.load('userenv.dll'), () => undefined)
  if (!userenv) return unknown('userenv.dll unavailable')
  return safe(
    () => {
      const CreateAppContainerProfile = userenv.func(
        'long CreateAppContainerProfile(const char16_t *name, const char16_t *displayName, const char16_t *description, void *capabilities, uint32 capabilityCount, _Out_ void **sid)',
      )
      const DeleteAppContainerProfile = userenv.func('long DeleteAppContainerProfile(const char16_t *name)')
      const name = `dsh.probe.${Date.now().toString(36)}`
      const sid = [null]
      const hr = CreateAppContainerProfile(name, name, 'dsh capability probe', null, 0, sid)
      if (hr === 0) {
        DeleteAppContainerProfile(name)
        return ok('CreateAppContainerProfile succeeded — AppContainer available in this token', {
          evidence: '[实测]',
        })
      }
      return no(`CreateAppContainerProfile failed hr=0x${(hr >>> 0).toString(16)}`, {
        evidence: '[实测]',
        hint: '0x80070005=E_ACCESSDENIED（需要非受限令牌/管理员或已存在配置）',
      })
    },
    (error) => no(`AppContainer probe threw: ${error.message}`),
  )
}

/** Windows Sandbox / 隔离容器 / 虚拟化平台 的存在性（只读探测，不假装可用） */
export function probeOptionalFeatures() {
  const features = {
    'Containers-DisposableClientVM': ['Windows Sandbox', 'WindowsSandbox.exe', 'C:\\Windows\\System32\\WindowsSandbox.exe'],
    'Microsoft-Hyper-V': ['Hyper-V', 'vmcompute', 'C:\\Windows\\System32\\vmcompute.exe'],
    Containers: ['容器', 'containerd', 'C:\\Program Files\\containerd\\containerd.exe'],
    VirtualMachinePlatform: ['虚拟机平台', 'vmmem', null],
    'HypervisorPlatform': ['Windows 虚拟机监控程序平台', 'WinHvPlatform.dll', 'C:\\Windows\\System32\\WinHvPlatform.dll'],
  }
  const out = {}
  for (const [feature, [label, marker, path]] of Object.entries(features)) {
    const present = path ? existsSync(path) : undefined
    out[feature] = {
      label,
      marker,
      state: present === true ? 'present' : present === false ? 'absent' : unknown('no filesystem marker'),
      evidence: '[实测] 文件标记探测',
      note: '功能开关状态需管理员执行 dism /online /get-featureinfo 确认',
    }
  }
  out['Device-Guard-Credential-Guard'] = {
    label: 'Credential Guard / VBS',
    state: safe(() => (existsSync('C:\\Windows\\System32\\WinVerifyTrust.exe') ? 'host-present' : 'unknown'), () => 'unknown'),
    evidence: '[推断]',
    note: '是否启用需 msinfo32 或 Get-CimInstance Win32_DeviceGuard（管理员）',
  }
  return out
}

/** 卷 / 文件系统指纹：staging root 必须落在支持安全描述符（NTFS）的卷上 */
export function probeVolume(root) {
  const absolute = resolve(root)
  let cursor = absolute
  const chain = []
  while (true) {
    chain.push(cursor)
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const existing = chain.find((p) => safe(() => statSync(p).isDirectory(), () => false))
  const scratch = join(existing || absolute, `.dsh-fs-probe-${Date.now().toString(36)}`)
  const writable = safe(
    () => {
      mkdirSync(scratch, { recursive: true })
      writeFileSync(join(scratch, 'a'), 'a')
      rmSync(scratch, { recursive: true, force: true })
      return true
    },
    () => false,
  )
  return {
    requestedRoot: absolute,
    existingAncestor: existing,
    writable,
    // FAT/exFAT 不保存安全描述符（#14.2 与 windows-acl README 的 FAT 残余边界）
    fatWarning: 'FAT-class volumes store no security descriptor; integrity labels are system-assigned and unverified',
    evidence: '[实测] 可写性; 文件系统类型需管理员确认',
  }
}

/** 环境指纹：缓存键（手册 #5.5） */
export function environmentFingerprint(extra = {}) {
  const parts = {
    probeVersion: PROBE_VERSION,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    osRelease: safe(() => require_('node:os').release(), () => 'unknown'),
    cwd: process.cwd(),
    user: safe(() => process.env.USERNAME || process.env.USER, () => 'unknown'),
    sessionName: safe(() => process.env.SESSIONNAME, () => ''),
    dshProfile: safe(() => process.env.DSH_PROFILE, () => ''),
    ...extra,
  }
  const digest = createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16)
  return { digest, parts }
}

// ═══════════════════════════════════════════════════════════════════════════
// T0（AppContainer）隔离证据 —— 由**实测**产出，而不是由任何人填 true
// ═══════════════════════════════════════════════════════════════════════════
//
// ── 为什么要有这一段（接线与收尾的核心）──────────────────────────────────────
// `selectTier()` 的 T0 闸门读的是 `report.appContainerIsolation?.proven === true`。
// 在本次接线之前，**没有任何代码路径会设置这个字段** —— 于是闸门永远关着，T0 永远
// 不可选。那是安全的，但等于 T0 从未落地；反过来，为了让 T0"跑起来"而在这里硬写
// `proven: true`，就把本项目最想避免的"看起来隔离了、其实没有"重新引进来。
//
// 折中只有一个：**`proven` 由真实观测算出来**，且**缺任何一项证据即 false**。
// 观测项与 T0 的五项判据一一对应（全部来自 `src/appcontainer-runtime.mjs`，本文件
// 不自己造判据，避免两处漂移）：
//   1. `TokenIsAppContainer(29) = 1`      → 子进程真的在 AppContainer 里
//   2. `TokenAppContainerSid(31)` = 本次启动期望的包 SID
//      （`[实测]` 注意：**不能**拿 `TokenUser` 比包 SID —— AppContainer 令牌的
//        `TokenUser` 本来就是用户 SID，包身份在 31/29 里。阶段 B 的"原因 3"就是判据错）
//   3. `TokenIntegrityLevel = S-1-16-4096`（Low）
//   4. 区外写被拒（宿主先做阳性对照，证明"被拒"不是命令本身有问题）
//   5. 未声明 `internetClient` 时网络被阻断
//
// ── 何时会真的跑（性能与副作用必须说清）──────────────────────────────────────
// 这个探针会创建 AppContainer profile、`icacls` 授权暂存目录、起 2 个真实子进程，
// 再逐项清理。**绝不允许每次探测都无条件跑**。门控按以下顺序（任一不满足就**不跑**，
// 并如实写明原因；不跑 ⇒ 没有 appContainerIsolation ⇒ T0 fail-closed）：
//
//   ① `--no-appcontainer-isolation-probe`        → 显式禁用（最高优先级）
//   ② `koffi` 不可用                              → 无 FFI，跑不了
//   ③ `probeAppContainer()`（**本来就会跑**的那一步）不是 pass
//      → `[实测]` 受限令牌下 `CreateAppContainerProfile` 返回 `0x80070005 E_ACCESSDENIED`，
//        后续所有步骤都必然失败。**先看这一步再决定**，因此不会多花任何一次 profile 创建。
//   ④ 磁盘缓存命中且未过期                        → 复用上次的**原始观测**（连带其 observedAt）
//   ⑤ `--appcontainer-isolation-probe` / `--appcontainer-probe` → 显式强制重测（跳过 ④）
//
// 也就是说：**默认**在"能建 profile 的会话"里跑**一次**并把原始观测落盘，
// 之后走缓存；在受限会话里**一次都不跑**（第 ③ 步就返回）。
// 缓存落在调用方给的 `cacheDir`（CLI 是 `<workspace>\.dshstage\cache`），
// 键含 `PROBE_VERSION` + 环境指纹 + **profile 名** —— 包 SID 是 per-profile 的，
// 换 profile 必须重测（`assessAppContainerIsolation()` 的 note 明确写了这一点）。

/** `[实测]` 隔离测量缓存的默认有效期：6 小时（过期即重测一次） */
export const APPCONTAINER_ISOLATION_TTL_MS = 6 * 60 * 60 * 1000

/** `[实测]` 单个探针子进程的等待上限（`WaitForSingleObject(thread, 30000)` 之外的外层兜底） */
export const APPCONTAINER_ISOLATION_CHILD_TIMEOUT_MS = 30_000

/** 解析一个"开/关"型命令行标志：否定形式优先，避免 `--a --no-a` 的歧义被静默吃掉 */
function argvFlag(name, argv = process.argv) {
  const positive = `--${name}`
  const negative = `--no-${name}`
  const has = (flag) => argv.some((value) => value === flag || value.startsWith(`${flag}=`))
  if (has(negative)) return { present: true, enabled: false, source: negative }
  if (has(positive)) return { present: true, enabled: true, source: positive }
  return { present: false, enabled: false, source: null }
}

/**
 * 读取隔离探针的**显式**命令行开关。
 *
 * 为什么读 `process.argv` 而不是加参数：探针会被多条入口消费（`src\cli.mjs probe/init`、
 * `src\audit.mjs`、插件的 probeOnStart、worker 启动探针），逐个加参数会漂移；
 * 而 `process.argv` 对**所有**入口都是"用户这一次真的这么说了"的同一份投影。
 *
 * `--refresh-appcontainer-isolation-probe` 是 `--appcontainer-isolation-probe` 的同义开关
 * （前者是"强制重测"的自然读法，后者是任务书里的例子 `--appcontainer-probe`）。
 */
export function readAppContainerIsolationSwitches(argv = process.argv) {
  const enabled = argvFlag('appcontainer-isolation-probe', argv)
  const alias = argvFlag('appcontainer-probe', argv)
  const refresh = argvFlag('refresh-appcontainer-isolation-probe', argv)
  const disabled = enabled.present && enabled.enabled === false
  const forced = (enabled.present && enabled.enabled) || (alias.present && alias.enabled) || (refresh.present && refresh.enabled)
  return {
    disabled,
    forced,
    source: disabled ? enabled.source : forced ? enabled.source ?? alias.source ?? refresh.source : null,
  }
}

function isolationCacheFile(cacheDir, digest) {
  if (!cacheDir || typeof cacheDir !== 'string') return undefined
  return join(cacheDir, `appcontainer-isolation-${digest}.json`)
}

function readIsolationCache(file) {
  if (!file || !existsSync(file)) return undefined
  return safe(
    () => {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : undefined
    },
    () => undefined,
  )
}

/**
 * 落盘一次**原始观测**（不是结论）。
 *
 * 写临时文件再 `rename`：否则"写到一半被中断"会留下半截 JSON，而半截 JSON 的下场是
 * **静默走不到缓存**（读不出来 ⇒ 重测）—— 那还算轻的；更坏的是若将来有人把读失败
 * 当成 `proven:false` 缓存下来，就变成"一次中断永久禁用 T0"。原子替换消除这类形态。
 */
function writeIsolationCache(file, payload) {
  if (!file) return false
  return safe(
    () => {
      mkdirSync(dirname(file), { recursive: true })
      const tmp = `${file}.tmp-${process.pid}`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`)
      renameSync(tmp, file)
      return true
    },
    () => false,
  )
}

/** 纯决策：这次探测该做什么（离线可测，不触碰任何系统状态） */
export function planAppContainerIsolationProbe(context = {}) {
  const {
    platform = process.platform,
    ffiAvailable = false,
    appContainerStatus = UNKNOWN,
    cachedMeasurement = null,
    ttlMs = APPCONTAINER_ISOLATION_TTL_MS,
    now = Date.now(),
    switches = { disabled: false, forced: false, source: null },
  } = context
  if (platform !== 'win32') return { action: 'skip', reason: 'platform-not-windows' }
  if (switches.disabled) return { action: 'skip', reason: 'disabled-by-flag', flag: switches.source }
  if (!ffiAvailable) return { action: 'skip', reason: 'ffi-unavailable' }
  if (appContainerStatus !== PASS) return { action: 'skip', reason: 'appcontainer-profile-unavailable' }
  const fresh =
    cachedMeasurement &&
    Number.isFinite(cachedMeasurement.observedAt) &&
    now - cachedMeasurement.observedAt <= ttlMs
  if (fresh && !switches.forced) {
    return { action: 'use-cache', reason: 'cache-hit', flag: switches.source, ageMs: now - cachedMeasurement.observedAt }
  }
  if (switches.forced) return { action: 'measure', reason: 'forced-by-flag', flag: switches.source }
  return { action: 'measure', reason: cachedMeasurement ? 'cache-expired' : 'cache-miss' }
}

/**
 * 跑一次真实的隔离测量（**有副作用**：建 profile、改暂存目录 ACL、起子进程；结束时逐项回收）。
 *
 * 刻意与 `planAppContainerIsolationProbe()` 分开：决策是纯函数（离线可测），
 * 这里是那个决策的执行体。合在一起会让"什么时候会真跑"这句话没法被测试钉死。
 *
 * 返回的是**原始观测**，不是结论：
 *   `{ observedAt, profileName, expectedSid, tokenFacts, outsideWrite, network, cleanup }`
 * 结论由 `assessAppContainerIsolation()` 给出，且**必须**由调用方在拿到观测后才能算。
 *
 * @param {{workspaceRoot: string, probeRoot?: string, profileName?: string, timeoutMs?: number}} options
 */
export function measureAppContainerIsolation(options = {}) {
  const workspaceRoot = resolve(options.workspaceRoot || process.cwd())
  const stamp = `${Date.now().toString(36)}${process.pid.toString(36)}`
  const probeRoot = options.probeRoot ? resolve(options.probeRoot) : join(workspaceRoot, '.dshstage', `appcontainer-probe-${stamp}`)
  const profileName = options.profileName || `dsh.stage.iso.${stamp}`
  const childTimeoutMs = options.timeoutMs ?? APPCONTAINER_ISOLATION_CHILD_TIMEOUT_MS

  const cleanup = {
    profileDeleted: null,
    aclRevoked: null,
    probeRootRemoved: null,
    notes: [],
  }

  const koffi = loadFfi()
  if (!koffi) {
    const error = new Error('APPCONTAINER_PROBE_UNAVAILABLE: koffi FFI unavailable')
    error.code = 'APPCONTAINER_PROBE_UNAVAILABLE'
    throw error
  }
  // 绑定表与执行路径**共用同一份实现**（手册 #5.1：探测必须与真实执行路径一致）。
  // 这里直接用 runtime 的工厂，不另写一份 Koffi 声明 —— 那正是"探测与执行漂移"的入口。
  const bindings = createKoffiAppContainerBindings(koffi)

  const kernel32 = koffi.load('kernel32.dll')
  const ResumeThread = kernel32.func('uint32 ResumeThread(void *thread)')
  const TerminateProcess = kernel32.func('bool TerminateProcess(void *process, uint32 code)')
  const WaitForSingleObject = kernel32.func('uint32 WaitForSingleObject(void *handle, uint32 ms)')
  const GetExitCodeProcess = kernel32.func('bool GetExitCodeProcess(void *process, _Out_ uint32 *code)')
  const CloseHandle = kernel32.func('bool CloseHandle(void *handle)')
  const { execFileSync } = require_('node:child_process')

  const icacls = (args) => {
    try {
      return { ok: true, text: String(execFileSync('icacls', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).replace(/\r?\n/g, ' | ').trim() }
    } catch (error) {
      return { ok: false, text: `FAILED: ${error.message}` }
    }
  }

  // 暂存目录：**区内可写**的前置。`planCombinationOrder()` 的 residuals 已声明：
  // 包 SID 必须被显式授权，否则连暂存根都不可写（那会让"区外写被拒"的判据失去对照）。
  mkdirSync(probeRoot, { recursive: true })
  const stage = join(probeRoot, 'stage')
  mkdirSync(stage, { recursive: true })

  const cmd = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  const hostExec = (commandLine, cwd) =>
    safe(
      () => {
        execFileSync(cmd, ['/d', '/c', commandLine], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000, windowsVerbatimArguments: true })
        return 0
      },
      (error) => (typeof error.status === 'number' ? error.status : null),
    )

  const created = bindings.createAppContainerProfile(profileName, profileName, 'WinStageSandbox T0 isolation probe', null, 0)
  const hr = created?.hr >>> 0
  if (hr !== 0) {
    // `[实测]` **失败也可能已经落了配置**：非法/超长的 profile 名会在返回非 0 的同时留下
    // `%LOCALAPPDATA%\Packages\<name>`（FIX-F 期间实测到 3 个残留）。因此这里显式删一次，
    // 并把结果如实记进 cleanup —— "创建失败"不等于"什么都没留下"。
    const deleteAfterFailure = safe(() => bindings.deleteAppContainerProfile(profileName) === 0, () => false)
    cleanup.profileDeleted = deleteAfterFailure
    cleanup.notes.push(
      `CreateAppContainerProfile hr=0x${hr.toString(16)} ⇒ 额外执行了一次 DeleteAppContainerProfile（结果=${deleteAfterFailure}）`,
    )
    cleanup.probeRootRemoved = safe(() => (rmSync(probeRoot, { recursive: true, force: true }), true), () => false)
    const error = new Error(`CreateAppContainerProfile(${profileName}) failed hr=0x${hr.toString(16)}`)
    error.code = 'APPCONTAINER_PROFILE_CREATE_FAILED'
    error.cleanup = cleanup
    throw error
  }
  const packageSid = bindings.sidToString(created.sid)
  if (typeof packageSid !== 'string' || packageSid.length === 0) {
    safe(() => bindings.deleteAppContainerProfile(profileName), () => undefined)
    cleanup.profileDeleted = true
    cleanup.probeRootRemoved = safe(() => (rmSync(probeRoot, { recursive: true, force: true }), true), () => false)
    const error = new Error('CreateAppContainerProfile succeeded but ConvertSidToStringSidW produced no SID string')
    error.code = 'APPCONTAINER_SID_UNREADABLE'
    throw error
  }

  const grant = icacls([stage, '/grant', `*${packageSid}:(OI)(CI)M`])
  cleanup.notes.push(`icacls grant → ${grant.text}`)

  /**
   * 起一个 AppContainer 子进程。
   *
   * `resume=false` ⇒ 返回**仍然挂起**的进程（查令牌要求进程存活）；
   * `resume=true`  ⇒ 等到退出并取回退出码（行为面判据要的就是退出码）。
   *
   * 配置沿用 FIX-B 实测跑通的那一组：`inheritHandles=false` + `CREATE_SUSPENDED`
   * + `CREATE_NEW_CONSOLE`（`[实测]` 继承句柄且无自有控制台 ⇒ 子进程 0xC0000142
   * STATUS_DLL_INIT_FAILED，创建成功但一条命令都不执行）。
   */
  const spawnChild = ({ commandLine, cwd, resume }) => {
    const sizeSlot = [0]
    bindings.initializeProcThreadAttributeList(null, 1, 0, sizeSlot)
    const attributeList = Buffer.alloc(Math.max(1, Number(sizeSlot[0]) || 0))
    bindings.initializeProcThreadAttributeList(attributeList, 1, 0, sizeSlot)
    const securityCapabilities = Buffer.alloc(24)
    securityCapabilities.writeBigUInt64LE(BigInt(created.sid), 0)
    securityCapabilities.writeBigUInt64LE(0n, 8)
    // CapabilityCount = 0 ⇒ **不**声明 internetClient ⇒ 网络默认阻断（这是正向手段，不是漏配）
    securityCapabilities.writeUInt32LE(0, 16)
    securityCapabilities.writeUInt32LE(0, 20)
    const updated = bindings.updateProcThreadAttribute(attributeList, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, securityCapabilities, 24, null, null)
    if (!win32BoolForProbe(updated)) {
      const code = bindings.getLastError()
      const error = new Error(
        `UpdateProcThreadAttribute(PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES) failed with ${code}; ` +
          'the attribute list was NOT written, so any child would silently run outside the AppContainer',
      )
      error.code = 'APPCONTAINER_ATTRIBUTE_UPDATE_FAILED'
      error.win32Code = code
      throw error
    }
    const startupInfo = buildStartupInfoExForProbe(attributeList, koffi)
    const flags = (EXTENDED_STARTUPINFO_PRESENT_PROBE | CREATE_SUSPENDED_PROBE | CREATE_NEW_CONSOLE_PROBE) >>> 0
    const out = { process: null, thread: null, pid: 0 }
    const ok = bindings.createProcessW(cmd, commandLine, null, null, false, flags, null, cwd, startupInfo, out)
    if (!win32BoolForProbe(ok) || !out.process || !out.thread) {
      const lastError = bindings.getLastError()
      if (out.process) safe(() => TerminateProcess(out.process, 1), () => undefined)
      if (out.thread) safe(() => CloseHandle(out.thread), () => undefined)
      if (out.process) safe(() => CloseHandle(out.process), () => undefined)
      return { created: false, lastError }
    }
    if (!resume) return { created: true, pid: out.pid, process: out.process, thread: out.thread }
    const previousSuspendCount = ResumeThread(out.thread)
    const waitResult = WaitForSingleObject(out.thread, childTimeoutMs)
    const codeSlot = [0]
    const got = GetExitCodeProcess(out.process, codeSlot)
    const exitCode = win32BoolForProbe(got) ? codeSlot[0] : null
    safe(() => TerminateProcess(out.process, 1), () => undefined)
    safe(() => CloseHandle(out.thread), () => undefined)
    safe(() => CloseHandle(out.process), () => undefined)
    return { created: true, pid: out.pid, previousSuspendCount, waitResult, exitCode }
  }

  const closeChild = (child) => {
    if (!child || child.created !== true) return
    safe(() => TerminateProcess(child.process, 1), () => undefined)
    safe(() => CloseHandle(child.thread), () => undefined)
    safe(() => CloseHandle(child.process), () => undefined)
  }

  try {
    // ── 1. 令牌事实：`CREATE_SUSPENDED` 状态下直查（令牌在创建时就定了）────────
    const tokenChild = spawnChild({ commandLine: `${cmd} /d /c exit /b 42`, cwd: stage, resume: false })
    if (!tokenChild.created) {
      const error = new Error(`AppContainer child could not be created (GetLastError=${tokenChild.lastError})`)
      error.code = 'APPCONTAINER_CREATE_PROCESS_FAILED'
      throw error
    }
    let tokenFacts
    try {
      tokenFacts = readProcessTokenFacts(bindings, tokenChild.process)
    } finally {
      closeChild(tokenChild)
    }

    // ── 2. 区外写：宿主先做阳性对照，证明"被拒"只能归因于隔离 ────────────────
    // 目标刻意选在**独立临时目录**（不是探测根的子目录）：`probeRoot` 下的一切都继承了
    // 暂存目录那条 `*<包 SID>:(OI)(CI)M` 授权，拿它做"区外"会得到一个假的"写成功"。
    const outsideDir = mkdtempForProbe()
    const outsideTarget = join(outsideDir, `dsh-iso-outside-${stamp}.txt`)
    cleanup.notes.push(`区外写目标（独立临时目录，未授权）= ${outsideTarget}`)
    let outsideWrite
    try {
      const hostOutsideExit = hostExec(`copy /y "${winIni}" "${outsideTarget}" > NUL`, stage)
      const hostOutsideCreated = existsSync(outsideTarget)
      if (hostOutsideCreated) safe(() => rmSync(outsideTarget, { force: true }), () => undefined)
      const childOutside = spawnChild({ commandLine: `${cmd} /d /c copy /y "${winIni}" "${outsideTarget}"`, cwd: stage, resume: true })
      const childOutsideCreated = existsSync(outsideTarget)
      if (childOutsideCreated) safe(() => rmSync(outsideTarget, { force: true }), () => undefined)
      outsideWrite = {
        attempted: hostOutsideCreated === true && childOutside.created === true,
        blocked: childOutside.created === true && childOutside.exitCode !== 0 && childOutsideCreated === false,
        detail:
          `宿主阳性对照（同一命令）=exit ${hostOutsideExit} / 文件存在 ${hostOutsideCreated}；` +
          `AppContainer 子进程 exit=${childOutside.exitCode} / 文件存在 ${childOutsideCreated}`,
        evidence: '[实测] 同一命令宿主成功、AppContainer 被拒 ⇒ 失败只能归因于隔离',
      }
    } finally {
      safe(() => rmSync(outsideDir, { recursive: true, force: true }), () => undefined)
    }

    // ── 3. 网络：CapabilityCount=0（未声明 internetClient）⇒ 预期被阻断 ────────
    const networkChild = spawnChild({ commandLine: `${cmd} /d /c curl.exe -s -m 8 -o NUL http://1.1.1.1/`, cwd: stage, resume: true })
    const network = {
      attempted: networkChild.created === true,
      blocked: networkChild.created === true && networkChild.exitCode !== 0,
      detail: `AppContainer 子进程 curl exit=${networkChild.exitCode}（0=连通；7=CURLE_COULDNT_CONNECT=被阻断）`,
      evidence: '[实测] .t/sbx3/dev/raw-t0-behaviour.txt：声明 S-1-15-3-1(internetClient) 后同一命令 exit=0',
    }

    return {
      observedAt: Date.now(),
      probeVersion: PROBE_VERSION,
      profileName,
      expectedSid: packageSid,
      tokenFacts,
      outsideWrite,
      network,
      command: cmd,
      probeRoot,
      stage,
      detail:
        `AppContainer 隔离实测：TokenIsAppContainer=${tokenFacts.isAppContainer} ` +
        `TokenAppContainerSid=${tokenFacts.appContainerSid} TokenIntegrityLevel=${tokenFacts.integrityLevel} ` +
        `区外写被拒=${outsideWrite.blocked} 网络被阻断=${network.blocked}`,
      cleanup,
    }
  } finally {
    // 逆序回收：ACL → profile → 目录。任何一步失败都留在 cleanup 里如实上报，不吞。
    const revoke = icacls([stage, '/remove:g', `*${packageSid}`])
    cleanup.aclRevoked = revoke.ok
    cleanup.notes.push(`icacls remove:g → ${revoke.text}`)
    cleanup.profileDeleted = safe(() => bindings.deleteAppContainerProfile(profileName) === 0, () => false)
    cleanup.probeRootRemoved = safe(() => (rmSync(probeRoot, { recursive: true, force: true }), !existsSync(probeRoot)), () => false)
  }
}

/** 与 `src/appcontainer.mjs::buildCreationFlags()` 同值的本地常量（探测子进程的固定配置） */
const EXTENDED_STARTUPINFO_PRESENT_PROBE = 0x00080000
const CREATE_SUSPENDED_PROBE = 0x00000004
const CREATE_NEW_CONSOLE_PROBE = 0x00000010
/** `[官方]` `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` = `ProcThreadAttributeValue(9, FALSE, TRUE, FALSE)` */
const PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES = 0x00020009

/** `C:\Windows\win.ini`：宿主可读的对照文件（用它做"复制到区外"的源，避免引入网络依赖） */
const winIni = join(process.env.SystemRoot || 'C:\\Windows', 'win.ini')

/** 一个**独立**的临时目录（刻意不放在探测根下，见区外写判据的注释） */
function mkdtempForProbe() {
  const base = join(tmpdir(), 'dsh-ac-probe-outside')
  mkdirSync(base, { recursive: true })
  return mkdtempSyncIn(base)
}

function mkdtempSyncIn(base) {
  const { mkdtempSync } = require_('node:fs')
  return mkdtempSync(join(base, 'run-'))
}

/** 与 `src/appcontainer-runtime.mjs::buildStartupInfoExBuffer` 同一不变量（cb 必须 112） */
function buildStartupInfoExForProbe(attributeList, koffi) {
  const buffer = Buffer.alloc(112)
  buffer.writeUInt32LE(112, 0)
  // `[实测]` lpAttributeList 是**内嵌指针**：JS Buffer 没有可查的原生地址，
  // 必须用 koffi.address()。传 Buffer 会抛 APPCONTAINER_POINTER_INVALID（阶段 B 实测缺陷）。
  const address = koffi && typeof koffi.address === 'function' ? koffi.address(attributeList) : undefined
  if (typeof address !== 'bigint') {
    throw new Error('koffi.address(attributeList) did not return a bigint; refusing to launch with an invalid lpAttributeList')
  }
  buffer.writeBigUInt64LE(address, 104)
  return buffer
}

/** 与 `src/appcontainer-runtime.mjs::win32BoolSucceeded` 同语义的本地副本（只依赖公开行为） */
function win32BoolForProbe(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  return false
}

/**
 * 完整探测。
 *
 * @param {{root: string, cacheDir?: string, useCache?: boolean,
 *          appContainerIsolationProbe?: boolean, appContainerIsolationCache?: boolean,
 *          appContainerIsolationTtlMs?: number, appContainerIsolationProbeRoot?: string,
 *          appContainerIsolationSwitches?: {disabled:boolean,forced:boolean,source:string|null}}} options
 *
 * `appContainerIsolationProbe` 默认 **true**（= 允许在"能建 profile"的会话里跑一次真实
 * 隔离测量并落盘缓存）；它在受限会话里会因为 `appContainer` 探测不是 pass 而**一次都不跑**。
 * 想彻底关掉（例如离线时间敏感的场景）传 `false`，或命令行加 `--no-appcontainer-isolation-probe`。
 */
export function probe(options) {
  const root = resolve(options.root || process.cwd())
  const fp = environmentFingerprint({ root })
  const cacheDir = options.cacheDir
  const cacheFile = cacheDir ? join(cacheDir, `capability-${fp.digest}.json`) : undefined

  if (options.useCache && cacheFile && existsSync(cacheFile)) {
    const cached = safe(() => JSON.parse(readFileSync(cacheFile, 'utf8')), () => undefined)
    if (cached && cached.fingerprint === fp.digest) {
      // 手册 #5.5：缓存命中也要做实例级必要检查
      const instance = instanceChecks(root)
      return {
        ...cached,
        cached: true,
        instanceChecks: instance,
        degradedByInstanceCheck: instance.some((c) => c.status !== PASS),
      }
    }
  }

  const report = {
    probeVersion: PROBE_VERSION,
    fingerprint: fp.digest,
    fingerprintParts: fp.parts,
    time: new Date().toISOString(),
    root,
  }
  // 分步执行并记录异常：任何一步失败都必须留下**可定位**的证据，
  // 而不是让整个探测静默返回空结果（手册 #17.1 先拿原始输出再下结论）。
  const steps = {
    win32: () => probeWin32Abi(),
    appContainer: () => probeAppContainer(),
    volume: () => probeVolume(root),
    optionalFeatures: () => probeOptionalFeatures(),
    instanceChecks: () => instanceChecks(root),
  }
  report.steps = {}
  for (const [name, run] of Object.entries(steps)) {
    try {
      report[name] = run()
      report.steps[name] = { status: 'ok' }
    } catch (error) {
      report[name] = { status: UNKNOWN, detail: `probe step threw: ${error.message}` }
      report.steps[name] = { status: 'threw', message: error.message, stack: String(error.stack || '').split('\n').slice(0, 4) }
    }
  }
  // ── T0 隔离证据（本轮接线）────────────────────────────────────────────────
  // 放在 tier 之前：`selectTier()` 的 T0 闸门读的就是这里产出的 `appContainerIsolation`。
  // 放在 `appContainer` 步骤之后：门控第 ③ 条要读它的 status（受限会话在那里就返回，
  // 不会白跑一次 profile 创建）。`report.appContainerProbe` 如实记录"这次到底跑没跑、为什么"。
  report.appContainerProbe = resolveAppContainerIsolation({ root, cacheDir, report, options })
  // ★ 关键一步：只有**拿到判定对象**时才设置 `appContainerIsolation`。
  // 没测出来就保持 undefined —— `selectTier()` 的 `?.proven === true` 因此为 false。
  // 绝不允许在这里写 `{ proven: false }` 之类的占位：那会让"没测"和"测了没过"
  // 在报告里长得一样，而这两件事的处置完全不同（前者要去看 appContainerProbe.reason）。
  report.appContainerIsolation = report.appContainerProbe.isolation
  report.cached = false
  report.tier = selectTier(report)
  if (cacheFile) {
    safe(() => {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(cacheFile, JSON.stringify(report, null, 2))
    }, () => undefined)
  }
  return report
}

/**
 * 把"要不要跑、跑完怎么算"收成一处（**这是 T0 唯一的证据来源**）。
 *
 * 返回 `{ status, source, reason, cache, ageMs, durationMs, isolation }`：
 *   - `isolation` 只有两种可能：`undefined`（没测出来）或 `assessAppContainerIsolation()`
 *     依据**实测观测**算出的判定对象（`proven` 由五项判据推导，本函数**从不**直接写 true）。
 *   - `status='measured'`  ⇒ 本次真的跑了（有副作用，见模块注释）
 *   - `status='cached'`    ⇒ 复用了上次落盘的原始观测（连带其 observedAt）
 *   - `status='skipped'`   ⇒ 没跑，`reason` 是机器可读的原因
 *   - `status='failed'`    ⇒ 尝试跑了但抛错，`reason` 带错误码/消息（**fail-closed：不给 T0**）
 */
export function resolveAppContainerIsolation({ root, cacheDir, report, options = {} } = {}) {
  const switches = options.appContainerIsolationSwitches ?? readAppContainerIsolationSwitches()
  const enabled = options.appContainerIsolationProbe !== false && switches.disabled !== true
  const base = {
    status: 'skipped',
    source: null,
    reason: null,
    cacheFile: undefined,
    ttlMs: options.appContainerIsolationTtlMs ?? APPCONTAINER_ISOLATION_TTL_MS,
    isolation: undefined,
  }
  if (!enabled) {
    return { ...base, reason: switches.disabled ? 'disabled-by-flag' : 'disabled-by-option' }
  }

  const ffi = loadFfi() !== undefined
  const digest = createHash('sha256')
    .update(JSON.stringify({ probeVersion: PROBE_VERSION, fingerprint: report?.fingerprint ?? null, root, profile: 'iso' }))
    .digest('hex')
    .slice(0, 16)
  const cacheFile =
    options.appContainerIsolationCache === false || !cacheDir ? undefined : isolationCacheFile(cacheDir, digest)
  const cachedEntry = readIsolationCache(cacheFile)
  const cachedMeasurement =
    cachedEntry && cachedEntry.probeVersion === PROBE_VERSION && cachedEntry.root === root && cachedEntry.measurement
      ? cachedEntry.measurement
      : null

  const plan = planAppContainerIsolationProbe({
    platform: process.platform,
    ffiAvailable: ffi,
    appContainerStatus: report?.appContainer?.status ?? UNKNOWN,
    cachedMeasurement,
    ttlMs: base.ttlMs,
    switches: { disabled: switches.disabled, forced: switches.forced, source: switches.source },
  })

  if (plan.action === 'skip') return { ...base, source: 'skipped', reason: plan.reason, flag: plan.flag, cacheFile }

  if (plan.action === 'use-cache') {
    const isolation = assessAppContainerIsolation({
      tokenFacts: cachedMeasurement.tokenFacts,
      expectedSid: cachedMeasurement.expectedSid,
      outsideWrite: cachedMeasurement.outsideWrite,
      network: cachedMeasurement.network,
    })
    return {
      ...base,
      status: 'cached',
      source: 'cache',
      reason: plan.reason,
      cacheFile,
      ageMs: plan.ageMs,
      observedAt: cachedMeasurement.observedAt,
      isolation,
    }
  }

  const started = Date.now()
  try {
    const measurement = measureAppContainerIsolation({
      workspaceRoot: root,
      probeRoot: options.appContainerIsolationProbeRoot,
      timeoutMs: options.appContainerIsolationChildTimeoutMs,
    })
    const isolation = assessAppContainerIsolation({
      tokenFacts: measurement.tokenFacts,
      expectedSid: measurement.expectedSid,
      outsideWrite: measurement.outsideWrite,
      network: measurement.network,
    })
    writeIsolationCache(cacheFile, {
      probeVersion: PROBE_VERSION,
      root,
      observedAt: measurement.observedAt,
      measurement: {
        observedAt: measurement.observedAt,
        expectedSid: measurement.expectedSid,
        tokenFacts: measurement.tokenFacts,
        outsideWrite: measurement.outsideWrite,
        network: measurement.network,
        detail: measurement.detail,
        cleanup: measurement.cleanup,
      },
    })
    return {
      ...base,
      status: 'measured',
      source: 'live-probe',
      reason: plan.reason,
      cacheFile,
      durationMs: Date.now() - started,
      observedAt: measurement.observedAt,
      detail: measurement.detail,
      cleanup: measurement.cleanup,
      isolation,
    }
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      source: 'live-probe',
      reason: plan.reason,
      cacheFile,
      durationMs: Date.now() - started,
      error: { code: error.code ?? null, message: String(error.message).slice(0, 400) },
    }
  }
}

/** 实例级检查：每次启动都必须做，不能被缓存跳过（手册 #5.5） */
export function instanceChecks(root) {
  const checks = []
  // 1. 工作区可写且可建子目录
  const probeDir = join(root, '.dshstage', 'instance-probe')
  checks.push(
    safe(
      () => {
        mkdirSync(probeDir, { recursive: true })
        writeFileSync(join(probeDir, 'probe'), 'ok')
        rmSync(probeDir, { recursive: true, force: true })
        return { name: 'workspace-writable', status: PASS, detail: root }
      },
      (error) => ({ name: 'workspace-writable', status: FAIL, detail: error.code || error.message }),
    ),
  )
  // 2. 暂存区基目录必须与工作区同卷（跨卷移动会破坏原子替换）
  checks.push(
    safe(
      () => {
        const stageBase = join(root, '.dshstage')
        mkdirSync(stageBase, { recursive: true })
        return { name: 'stage-base-on-root', status: PASS, detail: stageBase }
      },
      (error) => ({ name: 'stage-base-on-root', status: FAIL, detail: error.code || error.message }),
    ),
  )
  // 3. 受限令牌/进程沙箱是否生效（真实写入尝试到工作区外）
  const outside = join(process.env.TEMP || tmpdir(), '..', `dsh-instance-probe-${Date.now().toString(36)}`)
  checks.push(
    safe(
      () => {
        mkdirSync(outside, { recursive: true })
        rmSync(outside, { recursive: true, force: true })
        return {
          name: 'ambient-write-outside-root',
          status: PASS,
          detail: `${outside} writable → 本次会话没有进程沙箱写边界`,
        }
      },
      (error) => ({
        name: 'ambient-write-outside-root',
        status: PASS,
        detail: `denied (${error.code}) → 进程沙箱写边界生效`,
        boundaryActive: true,
      }),
    ),
  )
  return checks
}

/**
 * 隔离档位选择（fail-closed，手册 1.2 / 5.2）。
 *
 * tier 语义：
 *   T0 appcontainer  AppContainer 能力令牌 + Job + Low IL + ACL 写边界（读面也收敛）
 *   T1 restricted    WRITE_RESTRICTED 受限令牌 + Job + Low IL + ACL 写边界（读面不收敛）
 *   T2 acl-only      仅 ACL 写边界，无令牌降级（不可用于需要进程隔离的任务）
 *   T3 none          无可用原语 → **拒绝执行**，不允许绑定真实工作区为可写
 *
 * ── T0 的 fail-closed 闸门（实验阶段 B 实测后加入）────────────────────────────
 * `appContainer` 探测为 pass 只说明 `CreateAppContainerProfile` 能建 profile，
 * **不等于**子进程真的进不了 AppContainer。阶段 B 实测（`.t\sbx3\dev\02-阶段B报告.md`）：
 *   - `[实测]` 原 `SECURITY_CAPABILITIES_SIZE=32` 是错的（官方 24），cbSize 错会让
 *     `UpdateProcThreadAttribute` 返回 false + ERROR_INVALID_PARAMETER(87)；
 *   - `[实测]` **即使把常量改成 24、属性确实写入成功，派生出的子进程 TokenUser 仍然是用户 SID**
 *     —— 隔离为零，而路径上没有任何报错。
 * 这正是手册 #5.1/#5.2 最怕的一类假阳性："看起来成功、实则无隔离"。
 * 因此本函数**不得**仅凭 `appContainer.status === PASS` 就返回 T0；
 * 必须另有**隔离被真正证明**的证据（`report.appContainerIsolation.proven === true`，
 * 由真实的"子进程身份 + 读面 + 网络面"探针给出）。没有这份证据就按下一档 fail-closed，
 * 并在 `reasons` 里如实写明"AppContainer 可用但隔离未证明"。
 *
 * 重要区分：这里的 tier 描述的是"在当前进程内**还能再建**什么"。
 * 若当前进程本身已被外层沙箱限制（createRestrictedTokenViable=false），
 * 则无法建立嵌套沙箱，必须由未受限的宿主进程来建立——见 report.nesting。
 */
export function selectTier(report) {
  const checks = report.win32?.checks ?? {}
  const ac = report.appContainer?.status === PASS
  /**
   * T0 的**唯一**闸门（接线后不变，仍然是 fail-closed）。
   *
   * `proven` 只能来自 `resolveAppContainerIsolation()` → `measureAppContainerIsolation()`
   * （真实子进程）→ `assessAppContainerIsolation()`（五项判据缺一即 false）。
   * 本函数**不读** `report.appContainerProbe.status`、**不读**缓存时间、**不读**任何开关：
   * 那些说的是"这次跑没跑"，而这里要的是"隔离有没有被证明"。把两者混起来，
   * 就会出现"因为缓存命中了所以算证明过"这种最坏的推理。
   * `proven !== true`（undefined / false / 类型不对）⇒ 与接线前的行为**逐字一致**。
   */
  const acIsolationProven = report.appContainerIsolation?.proven === true
  const canMintRestricted = checks.createRestrictedTokenViable?.status === PASS
  const job = checks.jobObject?.status === PASS
  const writable = report.volume?.writable === true

  const reasons = []
  if (!writable) reasons.push('workspace not writable')
  if (!job) reasons.push('Job Object unavailable (process-tree reclamation cannot be enforced)')
  if (!canMintRestricted) reasons.push('CreateRestrictedToken prerequisites missing in this process')
  if (!ac) reasons.push('AppContainer unavailable in this token')
  if (ac && !acIsolationProven) {
    reasons.push(
      'AppContainer profile creation succeeds but confinement is NOT proven ' +
        '(no probe has shown a child process really running under the package SID); T0 stays disabled (fail-closed)',
    )
  }

  const nesting = canMintRestricted
    ? { viable: true, detail: 'the current process can mint a restricted token, so a nested sandbox can be established' }
    : {
        viable: false,
        detail:
          'the current process cannot mint a restricted token (a WRITE_RESTRICTED token itself), ' +
          'so a nested sandbox cannot be established here — run the sandbox from an unconfined host process',
      }

  if (writable && job && ac && acIsolationProven) {
    return { tier: 'T0', name: 'appcontainer', reasons, nesting, t0Gate: 'isolation-proven' }
  }
  if (writable && job && canMintRestricted) {
    return { tier: 'T1', name: 'restricted-token', reasons, nesting, t0Gate: ac ? 'isolation-not-proven' : 'appcontainer-unavailable' }
  }
  if (writable) return { tier: 'T2', name: 'acl-only', reasons, nesting, t0Gate: 'lower-tier' }
  return { tier: 'T3', name: 'none', reasons: reasons.length ? reasons : ['no usable primitive'], nesting, t0Gate: 'unusable' }
}

export function formatReport(report) {
  const lines = []
  lines.push(`probe v${report.probeVersion}  fingerprint=${report.fingerprint}  cached=${report.cached}`)
  lines.push(`root=${report.root}`)
  lines.push(`selected tier=${report.tier.tier} (${report.tier.name})`)
  if (report.tier.reasons?.length) lines.push(`  reasons: ${report.tier.reasons.join('; ')}`)
  if (report.tier.nesting) lines.push(`  嵌套可用性: ${report.tier.nesting.viable ? 'yes' : 'NO'} — ${report.tier.nesting.detail}`)
  const w = report.win32?.checks
  if (w) {
    for (const [key, value] of Object.entries(w)) {
      if (value && typeof value === 'object' && 'status' in value) {
        lines.push(`  [${value.status.toUpperCase().padEnd(7)}] ${key}: ${value.detail}`)
      }
    }
  }
  for (const [name, step] of Object.entries(report.steps || {})) {
    if (step.status !== 'ok') lines.push(`  ⚠ 探测步骤 ${name} 抛错: ${step.message}`)
  }
  lines.push(`  [${String(report.appContainer?.status).toUpperCase().padEnd(7)}] appContainer: ${report.appContainer?.detail}`)
  lines.push('  optional features（文件标记探测；开关状态需管理员确认）:')
  for (const [name, value] of Object.entries(report.optionalFeatures || {})) {
    lines.push(`    ${name}: ${typeof value.state === 'string' ? value.state : JSON.stringify(value.state)} (${value.label})`)
  }
  lines.push('  instance checks (每次启动强制):')
  for (const check of report.instanceChecks || []) {
    lines.push(`    [${check.status.toUpperCase()}] ${check.name}: ${check.detail}`)
  }
  return lines.join('\n')
}
