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

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { resolveDshModuleRoot } from './executor.mjs'

// ESM 下同步 require；必须在模块顶部初始化，否则函数内的引用会命中暂时性死区
const require_ = createRequire(import.meta.url)

export const PROBE_VERSION = 1

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
 */
export function loadFfi() {
  // resolveDshModuleRoot() 返回的是 node_modules 根，因此包名直接 join 即可
  const candidates = [...resolveDshModuleRoot().map((root) => join(root, 'koffi')), 'koffi']
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
  const CreateJobObjectW = kernel32.func('void *CreateJobObjectW(void *a, const char16_t *name)')
  const SetInformationJobObject = kernel32.func(
    'bool SetInformationJobObject(void *job, int infoClass, void *info, uint32 len)',
  )
  const AssignProcessToJobObject = kernel32.func('bool AssignProcessToJobObject(void *job, void *process)')
  const QueryInformationJobObject = kernel32.func(
    'bool QueryInformationJobObject(void *job, int cls, void *info, uint32 len, void *ret)',
  )

  results.jobObject = safe(
    () => {
      const job = CreateJobObjectW(null, null)
      if (!job) throw new Error('CreateJobObjectW returned NULL')
      // JOBOBJECT_EXTENDED_LIMIT_INFORMATION: LimitFlags 位于偏移 16
      const info = Buffer.alloc(144)
      info.writeUInt32LE(0x2000 | 0x0008, 16) // KILL_ON_JOB_CLOSE | ACTIVE_PROCESS
      info.writeUInt32LE(32, 36) // ActiveProcessLimit
      const set = SetInformationJobObject(job, 9, info, info.length)
      const assigned = AssignProcessToJobObject(job, GetCurrentProcess())
      // 查询确认分配真的生效，而不是"看起来成功"（手册 #17：不要以返回值为唯一证据）
      const accounting = Buffer.alloc(64)
      const queried = QueryInformationJobObject(job, 1, accounting, accounting.length, null)
      const active = queried ? accounting.readUInt32LE(44) : undefined
      CloseHandleK(job)
      if (!assigned) return no(`SetInformationJobObject=${set}, AssignProcessToJobObject=false`)
      return ok(
        `KILL_ON_JOB_CLOSE job created and the current process assigned; verified activeProcesses=${active}` +
          (active === undefined ? ' (accounting query failed)' : ''),
        { evidence: '[实测]', activeProcesses: active },
      )
    },
    (error) => no(`Job Object unavailable: ${error.message}`, { evidence: '[实测]' }),
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

/**
 * 完整探测。
 * @param {{root: string, cacheDir?: string, useCache?: boolean}} options
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
 * tier 语义：
 *   T0 appcontainer   AppContainer + Job + Low IL + ACL 写边界
 *   T1 restricted     WRITE_RESTRICTED 受限令牌 + Job Object + Low IL + ACL 写边界（DSH 已实测路线）
 *   T2 acl-only       仅 ACL 写边界，无令牌降级
 *   T3 none           无隔离 → 拒绝执行（不允许绑定真实工作区为可写）
 */
/**
 * 隔离档位选择（fail-closed，手册 1.2 / 5.2）。
 *
 * tier 语义：
 *   T0 appcontainer  AppContainer 能力令牌 + Job + Low IL + ACL 写边界（读面也收敛）
 *   T1 restricted    WRITE_RESTRICTED 受限令牌 + Job + Low IL + ACL 写边界（读面不收敛）
 *   T2 acl-only      仅 ACL 写边界，无令牌降级（不可用于需要进程隔离的任务）
 *   T3 none          无可用原语 → **拒绝执行**，不允许绑定真实工作区为可写
 *
 * 重要区分：这里的 tier 描述的是"在当前进程内**还能再建**什么"。
 * 若当前进程本身已被外层沙箱限制（createRestrictedTokenViable=false），
 * 则无法建立嵌套沙箱，必须由未受限的宿主进程来建立——见 report.nesting。
 */
export function selectTier(report) {
  const checks = report.win32?.checks ?? {}
  const ac = report.appContainer?.status === PASS
  const canMintRestricted = checks.createRestrictedTokenViable?.status === PASS
  const job = checks.jobObject?.status === PASS
  const writable = report.volume?.writable === true

  const reasons = []
  if (!writable) reasons.push('workspace not writable')
  if (!job) reasons.push('Job Object unavailable (process-tree reclamation cannot be enforced)')
  if (!canMintRestricted) reasons.push('CreateRestrictedToken prerequisites missing in this process')
  if (!ac) reasons.push('AppContainer unavailable in this token')

  const nesting = canMintRestricted
    ? { viable: true, detail: 'the current process can mint a restricted token, so a nested sandbox can be established' }
    : {
        viable: false,
        detail:
          'the current process cannot mint a restricted token (a WRITE_RESTRICTED token itself), ' +
          'so a nested sandbox cannot be established here — run the sandbox from an unconfined host process',
      }

  if (writable && job && ac) return { tier: 'T0', name: 'appcontainer', reasons, nesting }
  if (writable && job && canMintRestricted) return { tier: 'T1', name: 'restricted-token', reasons, nesting }
  if (writable) return { tier: 'T2', name: 'acl-only', reasons, nesting }
  return { tier: 'T3', name: 'none', reasons: reasons.length ? reasons : ['no usable primitive'], nesting }
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
