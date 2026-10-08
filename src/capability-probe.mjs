/**
 * WinStageSandbox capability probe —— 一次跑完，输出**稳定 JSON**
 *
 * 用途（task-1 交付物 4）：给 Lead 的 `tests/acceptance-transparent.mjs` 与任何
 * 自动化提供一个可编程判据，回答三件事：
 *   1. **当前生效的运行模式**到底是哪一种（`shim` / `restricted-token` /
 *      `unrestricted-host`），以及它是"真的建立了沙箱"还是"恰好没开沙箱"；
 *   2. 管道 / 重定向 / TLS / 系统查询（whoami、tasklist、CIM、防火墙、TCP）在
 *      **沙箱内**是否可用；
 *   3. 子进程环境里有没有 `DSH_SANDBOX*` 痕迹。
 *
 * ── 采集纪律（关键，来自 README §1.1 / 残余边界 R10）────────────────────────
 * 本文件**绝不用命名管道**采集子进程输出：受限令牌下默认的 `stdio: 'pipe'`
 * 会让子进程创建直接 EPERM，那正是被测的故障之一。全部子进程用
 * **文件描述符重定向**（`spawnSync` + 文件 fd）—— 也就是 `run.cmd` 的先例。
 * 这让本探针在"管道修复前"和"修复后"都能跑，且结论可比。
 *
 * ── 输出契约（稳定；改动必须同步 Lead 侧）──────────────────────────────────
 *   {
 *     "schema": "winstage.capability-probe/1",
 *     "at": ISO8601,
 *     "host": { node, pid, platform, cwd, command },
 *     "mode": {
 *       "requested": "TS"|"T1"|"auto"|...,
 *       "effective": "shim"|"restricted-token"|"appcontainer"|"unrestricted-host",
 *       "sandboxEstablished": bool,          // ★ 别把"没开沙箱"误报成"模式生效"
 *       "hostConfined": bool,                // 宿主自身是否在 WRITE_RESTRICTED 令牌里
 *       "hostConfinement": {...},            // 判定证据（特权条数 + 区外写探针）
 *       "enforcement": string, "backend": string,
 *       "fallbackReason": string|undefined,  // 回退原因（如探测失败）
 *       "transparentShim": {...}|undefined,  // TS 三级探测的逐条 checks
 *       "initError": string|undefined,
 *       "selfTest": {...}
 *     },
 *     "capabilities": {
 *       "pipe":     {"ok":bool,"source":"sandbox"|"ambient"|"unavailable","raw":{...}},
 *       "redirect": {...},
 *       "tls":      {"ok":bool,"localCredentials":bool,"internetHandshake":bool|null,...},
 *       "systemQueries": {"ok":bool,"items":{whoamiUser:bool,...},"raw":{...}},
 *       "envTrace": {"ok":bool,"dshSandboxVars":[...]}
 *     },
 *     "contexts": {"ambient": {...}, "sandbox": {...}|null},
 *     "claims": {"capabilitiesRestored":bool,"confinementActive":bool,"mechanism":string},
 *     "summary": {"ok":n,"total":n,"failed":[...]}
 *   }
 *
 * 用法：
 *   node src\capability-probe.mjs                     # JSON 打到 stdout
 *   node src\capability-probe.mjs --out out.json
 *   node src\capability-probe.mjs --tier TS           # 强制请求去令牌化档位
 *   node src\capability-probe.mjs --ambient-only      # 不建立 winstage 沙箱
 *
 * 退出码：0 = 生效上下文的四类能力全通过；1 = 有失败；2 = 环境错误（非 win32）。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import {
  WindowsStageExecutor,
  buildCapabilityCanaryScript,
  judgeCanary,
  parseMarkerJson,
  runCapturedToFiles,
} from './executor.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

/** 与验收台 T3 一致的上网 TLS 用例（网络相关，标记 informational，不参与退出码） */
function buildInternetTlsScript() {
  return [
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12",
    'try {',
    "  $t = New-Object Net.Sockets.TcpClient('registry.npmmirror.com', 443)",
    "  $s = New-Object Net.Security.SslStream($t.GetStream(), $false, { $true })",
    "  $s.AuthenticateAsClient('registry.npmmirror.com')",
    '  "TLS=OK:" + $s.SslProtocol',
    '  $t.Close()',
    '} catch {',
    '  $m = $_.Exception.Message',
    '  if ($_.Exception.InnerException) { $m = $_.Exception.InnerException.Message }',
    '  "TLS=FAIL:" + $m',
    '}',
  ].join('\r\n')
}

function parseArgs(argv) {
  const options = { json: true, out: undefined, tier: undefined, ambientOnly: false, workspace: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--out') options.out = argv[++index]
    else if (token === '--tier') options.tier = argv[++index]
    else if (token === '--workspace') options.workspace = argv[++index]
    else if (token === '--ambient-only') options.ambientOnly = true
    else if (token === '--help' || token === '-h') options.help = true
  }
  return options
}

/**
 * 宿主自身的受限状态判定（**不依赖 FFI**）。
 *
 * 依据（README §4 实测）：WRITE_RESTRICTED 受限令牌会把特权折叠到只剩
 * `SeChangeNotifyPrivilege`（1 条），未受限会话是 20+ 条；并且受限令牌下
 * 工作区外（`C:\Windows\Temp`）写入会被拒。两个信号取或，并如实记录证据。
 */
export function detectHostConfinement(captureDir) {
  const privilegeProbe = runCapturedToFiles('whoami.exe', ['/priv'], { captureDir, timeoutMs: 20000 })
  const privileges = (privilegeProbe.out.match(/Se[A-Za-z]+Privilege/g) ?? []).length
  const outsideDir = join(process.env.SystemRoot || 'C:\\Windows', 'Temp')
  const outsidePath = join(outsideDir, `winstage-probe-${randomUUID().slice(0, 8)}.txt`)
  let outsideWriteAllowed = false
  let outsideWriteError
  try {
    writeFileSync(outsidePath, 'probe')
    outsideWriteAllowed = true
    rmSync(outsidePath, { force: true })
  } catch (error) {
    outsideWriteError = error.message
  }
  return {
    confined: privileges <= 1 || !outsideWriteAllowed,
    privilegeCount: privileges,
    privilegesProbeExit: privilegeProbe.code,
    outsideWorkspaceWriteAllowed: outsideWriteAllowed,
    outsideWorkspaceWriteError: outsideWriteError,
    outsideWorkspacePath: outsidePath,
    method:
      'whoami /priv privilege count (a WRITE_RESTRICTED token collapses to SeChangeNotifyPrivilege) + outside-workspace write probe',
  }
}

/** TS 三级探测结果的稳定摘要（capability-probe 的输出契约的一部分） */
function summarizeTransparent(probe) {
  if (!probe) return undefined
  return {
    available: probe.available,
    reason: probe.reason,
    transport: probe.transport,
    artifacts: probe.artifacts,
    abiVersion: probe.abiVersion,
    stats: probe.stats,
    checks: probe.checks,
    canaryJudge: probe.canaryJudge,
    canary: probe.canary,
  }
}

function emptyContext(reason) {
  return { available: false, reason, canary: undefined, judge: undefined }
}

/** 在**宿主自己的上下文**里跑能力金丝雀（不经过 winstage 沙箱） */
function probeAmbient(context) {
  const captureDir = context.captureDir
  const scriptPath = join(captureDir, '.winstage-ambient-canary.ps1')
  writeFileSync(scriptPath, `\uFEFF${buildCapabilityCanaryScript()}\r\n`, 'utf8')
  const run = runCapturedToFiles(
    'powershell.exe',
    ['-NoLogo', '-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { cwd: context.cwd, env: context.env, timeoutMs: context.timeoutMs, captureDir },
  )
  rmSync(scriptPath, { force: true })
  const canary = parseMarkerJson(run.out)
  return {
    available: true,
    context: 'ambient',
    exitCode: run.code,
    canary,
    judge: judgeCanary(canary),
    stderrTail: String(run.err ?? '').slice(0, 600),
    internetTls: runInternetTls('powershell.exe', [], context),
  }
}

/** 上网 TLS（informational） */
function runInternetTls(file, extraArgs, context) {
  const scriptPath = join(context.captureDir, `.winstage-tls-${randomUUID().slice(0, 6)}.ps1`)
  writeFileSync(scriptPath, `\uFEFF${buildInternetTlsScript()}\r\n`, 'utf8')
  const run = runCapturedToFiles(
    file,
    [...extraArgs, '-NoLogo', '-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    { cwd: context.cwd, env: context.env, timeoutMs: 45000, captureDir: context.captureDir },
  )
  rmSync(scriptPath, { force: true })
  const match = /TLS=(OK|FAIL):(.*)/.exec(run.out)
  return { ok: match?.[1] === 'OK', detail: match ? match[2].trim() : `no output (exit=${run.code}) ${String(run.err).slice(0, 200)}` }
}

/** 在 winstage 沙箱内跑同一条金丝雀 */
async function probeSandboxed(executor, context) {
  const scriptPath = join(context.stagingRoot, '.winstage-sandbox-canary.ps1')
  writeFileSync(scriptPath, `\uFEFF${buildCapabilityCanaryScript()}\r\n`, 'utf8')
  const outcome = await executor.run({
    command: 'powershell.exe',
    args: ['-NoLogo', '-NonInteractive', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    cwd: context.stagingRoot,
    timeoutMs: context.timeoutMs,
  })
  const canary = parseMarkerJson(outcome.stdout)
  const internet = await executor
    .run({
      command: 'powershell.exe',
      args: ['-NoLogo', '-NonInteractive', '-NoProfile', '-Command', buildInternetTlsScript()],
      cwd: context.stagingRoot,
      timeoutMs: 60000,
    })
    .then((result) => {
      const match = /TLS=(OK|FAIL):(.*)/.exec(result.stdout)
      return { ok: match?.[1] === 'OK', detail: match ? match[2].trim() : `no output (exit=${result.exitCode}) ${result.stderr.slice(0, 200)}` }
    })
    .catch((error) => ({ ok: false, detail: `probe error: ${error.message}` }))
  return {
    available: true,
    context: 'sandbox',
    exitCode: outcome.exitCode,
    launchFailed: outcome.launchFailed === true,
    timedOut: outcome.timedOut === true,
    canary,
    judge: judgeCanary(canary),
    stderrTail: String(outcome.stderr ?? '').slice(0, 600),
    internetTls: internet,
  }
}

function capabilitiesFrom(context, source) {
  if (!context?.available) {
    const reason = context?.reason ?? 'context not available'
    const empty = { ok: false, source: 'unavailable', reason }
    return {
      pipe: { ...empty },
      redirect: { ...empty },
      tls: { ...empty, localCredentials: false, internetHandshake: null },
      systemQueries: { ...empty, items: {} },
      envTrace: { ...empty, dshSandboxVars: null },
    }
  }
  const canary = context.canary ?? {}
  const judge = context.judge ?? { ok: false, items: {} }
  const items = judge.items ?? {}
  const internet = context.internetTls ?? { ok: false, detail: 'not measured' }
  return {
    pipe: { ok: items.pipe === true, source, raw: { pipeText: canary.pipeText ?? null } },
    redirect: { ok: items.redirect === true, source, raw: { redirectText: canary.redirectText ?? null } },
    tls: {
      ok: items.tlsCredentials === true || internet.ok === true,
      source,
      localCredentials: items.tlsCredentials === true,
      internetHandshake: internet.ok,
      internetDetail: internet.detail,
      localDetail: canary.tlsDetail ?? null,
      informationalInternet: true,
    },
    systemQueries: {
      ok:
        items.whoamiUser === true &&
        items.whoamiGroups === true &&
        items.tasklist === true &&
        items.cim === true &&
        items.firewall === true &&
        items.tcpConnection === true,
      source,
      items: {
        whoamiUser: items.whoamiUser === true,
        whoamiGroups: items.whoamiGroups === true,
        tasklist: items.tasklist === true,
        cim: items.cim === true,
        firewall: items.firewall === true,
        tcpConnection: items.tcpConnection === true,
      },
    },
    envTrace: {
      ok: items.noDshSandboxTrace === true,
      source,
      dshSandboxVars: canary.dshSandboxVars ?? null,
      winstageVars: canary.winstageVars ?? null,
    },
  }
}

export async function runCapabilityProbe(options = {}) {
  if (process.platform !== 'win32') {
    const error = new Error('the capability probe requires process.platform === "win32"')
    error.code = 'UNSUPPORTED_PLATFORM'
    throw error
  }
  const workspace = resolve(options.workspace || REPO)
  // 采集目录与私有 temp 都放在**工作区里**：受限会话下工作区一定可写，
  // 而真实 %TEMP% 在平台沙箱里可能不在授权范围内（那会让探针自己先失败）。
  const probeRoot = join(workspace, '.dshstage', 'capability-probe')
  const stagingRoot = join(probeRoot, 'staged')
  const tempDir = join(probeRoot, `temp-${randomUUID().slice(0, 8)}`)
  const captureDir = join(probeRoot, `capture-${randomUUID().slice(0, 8)}`)
  mkdirSync(stagingRoot, { recursive: true })
  mkdirSync(captureDir, { recursive: true })
  const tier = options.tier || process.env.WINSTAGE_TIER || 'auto'
  const timeoutMs = options.timeoutMs ?? 60000

  const host = {
    node: process.version,
    pid: process.pid,
    platform: process.platform,
    cwd: process.cwd(),
    argv: process.argv.slice(2),
    workspace,
  }
  const hostConfinement = detectHostConfinement(captureDir)

  const mode = {
    requested: tier,
    effective: 'unrestricted-host',
    sandboxEstablished: false,
    hostConfined: hostConfinement.confined,
    hostConfinement,
    confinementSource: 'none',
    enforcement: 'none',
    backend: 'none',
    fallbackReason: undefined,
    transparentShim: undefined,
    initError: undefined,
    selfTest: undefined,
    tierRequested: undefined,
    tierEffective: undefined,
  }

  let executor
  let sandboxContext = null
  if (options.ambientOnly !== true) {
    executor = new WindowsStageExecutor({ stagingRoot, tempDir, mode: 'workspace-write', tier, keepTemp: true })
    try {
      const report = await executor.init()
      mode.sandboxEstablished = true
      mode.effective = report.launchMode ?? 'restricted-token'
      mode.enforcement = report.enforcement
      mode.backend = report.backend
      mode.fallbackReason = report.fallbackReason
      mode.tierRequested = report.tierRequested
      mode.tierEffective = report.tierEffective
      mode.jobEnabled = report.jobEnabled !== false
      mode.transparentShim = summarizeTransparent(report.transparentShim)
      mode.selfTest = {
        enforcement: report.enforcement,
        checks: (report.checks ?? []).map((check) => ({ name: check.name, status: check.status, detail: String(check.detail ?? '').slice(0, 300) })),
      }
      sandboxContext = await probeSandboxed(executor, { stagingRoot, captureDir, timeoutMs })
    } catch (error) {
      mode.initError = `${error.code ?? 'INIT_FAILED'}: ${error.message}`
      mode.fallbackReason = mode.initError
      // ★ 即使 init() 抛错（例如本会话无法铸受限令牌），executor 上**已经算出**的
      // TS 三级探测结果也必须在报告里 —— 那正是"为什么没有选去令牌化模式"的证据。
      // 丢掉它会让报告退化成一句"沙箱建不起来"，把 T4 侧的真实原因藏起来。
      if (executor?.transparent) mode.transparentShim = summarizeTransparent(executor.transparent)
      if (executor?.fallbackReason) mode.fallbackReason = executor.fallbackReason
      if (executor?.tierRequested) mode.tierRequested = executor.tierRequested
      // ★ 关键区分（Lead 明确要求）：沙箱**没建立**时，"子进程仍然受限"这件事
      // 来自**宿主令牌继承**，不是 winstage 生效。用独立的模式名如实报告。
      mode.effective = hostConfinement.confined ? 'inherited-confinement' : 'unrestricted-host'
      mode.confinementSource = hostConfinement.confined ? 'host-inherited' : 'none'
      sandboxContext = emptyContext(`winstage sandbox could not be established: ${mode.initError}`)
      sandboxContext.internetTls = undefined
    }
  } else {
    mode.fallbackReason = 'probe ran with --ambient-only (no winstage sandbox was established)'
    mode.effective = hostConfinement.confined ? 'inherited-confinement' : 'unrestricted-host'
    mode.confinementSource = hostConfinement.confined ? 'host-inherited' : 'none'
  }

  const ambientContext = probeAmbient({ cwd: process.cwd(), env: process.env, captureDir, timeoutMs })

  const effectiveContext = mode.sandboxEstablished ? sandboxContext : ambientContext
  const source = mode.sandboxEstablished ? 'sandbox' : 'ambient'
  const capabilities = capabilitiesFrom(effectiveContext, source)
  if (mode.sandboxEstablished && !effectiveContext?.available) {
    const unavailable = capabilitiesFrom(effectiveContext, 'unavailable')
    for (const key of Object.keys(capabilities)) {
      if (capabilities[key].ok !== true) capabilities[key] = { ...unavailable[key], ok: false }
    }
  }

  const summary = {
    ok: 0,
    total: 0,
    failed: [],
  }
  const verdicts = {
    pipe: capabilities.pipe.ok,
    redirect: capabilities.redirect.ok,
    tls: capabilities.tls.ok,
    systemQueries: capabilities.systemQueries.ok,
    envTrace: capabilities.envTrace.ok,
  }
  for (const [name, ok] of Object.entries(verdicts)) {
    summary.total += 1
    if (ok) summary.ok += 1
    else summary.failed.push(name)
  }

  const claims = {
    capabilitiesRestored: summary.failed.length === 0,
    confinementActive:
      mode.sandboxEstablished && mode.effective !== 'unrestricted-host' ? true : mode.effective === 'inherited-confinement',
    // ★ 直接回答 Lead 的担忧：不能把"恰好没开沙箱"读成"模式生效"
    mechanism:
      mode.effective === 'shim'
        ? 'winstage transparent shim (normal token, normal integrity; IAT-level write redirection)'
        : mode.effective === 'restricted-token'
          ? 'winstage WRITE_RESTRICTED restricted token + Low IL'
          : mode.effective === 'appcontainer'
            ? 'AppContainer (tier T0)'
            : mode.effective === 'inherited-confinement'
              ? "host-inherited WRITE_RESTRICTED token: the winstage sandbox could NOT be established, children inherit this host's restricted token"
              : 'no confinement at all (children ran as ordinary processes of an unrestricted host)',
    sandboxMeasured: mode.sandboxEstablished,
    confinementSource: mode.confinementSource ?? (mode.sandboxEstablished ? 'winstage-sandbox' : 'none'),
  }

  const report = {
    schema: 'winstage.capability-probe/1',
    at: new Date().toISOString(),
    host,
    mode,
    capabilities,
    contexts: { ambient: ambientContext, sandbox: mode.sandboxEstablished ? sandboxContext : null },
    claims,
    summary,
  }

  try {
    if (executor) executor.dispose()
  } catch {
    /* cleanup only */
  }
  rmSync(captureDir, { recursive: true, force: true })
  if (options.keepTemp !== true) rmSync(tempDir, { recursive: true, force: true })
  return report
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write('usage: node src/capability-probe.mjs [--out <file>] [--tier TS|T1|auto] [--workspace <dir>] [--ambient-only]\n')
    return 0
  }
  let report
  try {
    report = await runCapabilityProbe(options)
  } catch (error) {
    process.stderr.write(`capability-probe: ${error.code ?? ''} ${error.message}\n`)
    return 2
  }
  const text = `${JSON.stringify(report, null, 2)}\n`
  if (options.out) writeFileSync(options.out, text, 'utf8')
  else process.stdout.write(text)
  return report.summary.failed.length === 0 ? 0 : 1
}

const isMain = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false
if (isMain) {
  main().then((code) => {
    process.exitCode = code
  })
}

export { buildInternetTlsScript }
