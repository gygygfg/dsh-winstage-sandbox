/**
 * Lead 侧端到端验收台：透明暂存沙箱
 * ============================================================================
 * 用途：在**沙箱开启**的会话里运行，逐项验证用户提出的目标是否达成：
 *   1. 沙箱痕迹不可见（模型可见通道里没有 DSH_SANDBOX* / [winstage] / .dshstage）
 *   2. 管道与重定向在沙箱内可用
 *   3. .NET/WinHTTP TLS 在沙箱内可用
 *   4. whoami / tasklist / Get-CimInstance 等系统查询可用
 *   5. 工作区外的文件写入「报告成功」且真实磁盘不变（进暂存）
 *   6. 注册表写入「报告成功」且真实 hive 不变（进暂存）
 *   7. 敏感文件读取被拒
 *   8. 上述所有修改都出现在审批面板（review.json）里
 *
 * 采集纪律（重要）：本文件**绝不用命名管道**采集子进程输出。
 * 全部子进程用 node 的 spawnSync + 文件描述符重定向（stdio: [ignore, fd, fd]），
 * 这正是 run.cmd / run-capture.mjs 已验证可行的方式，也让本验收台在
 * 「管道修复前」和「管道修复后」都能跑。
 *
 * 用法：
 *   node tests/acceptance-transparent.mjs            # 人类可读输出
 *   node tests/acceptance-transparent.mjs --json     # 机器可读
 * 退出码：0 全通过 ｜ 1 有失败 ｜ 2 环境错误
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const JSON_OUT = process.argv.includes('--json')

const WORKSPACE = process.env.WINSTAGE_ACCEPT_WORKSPACE || REPO
const results = []
const evidence = {}

/**
 * 载体模式 —— 本验收台的核心前置条件（docs/T5-痕迹与根统一报告.md §1.3）。
 *
 *   'shell'（默认）：直接 spawn powershell.exe。只有在**由 winstage 沙箱托管的会话**里才有意义
 *                    （那时命令载体由该 provider 约束，整棵命令树在同一层强制下）。
 *   'inject'       ：每个载体都经 `winstage-inject.exe` 注入 shim —— 与 TS 档位探测/闭环同一机制。
 *
 * 为什么必须"逐载体"注入：shim 是**按进程**打 IAT 的，且**不向子进程传播**。实测（2026-09-30）：
 * 把 shim 注入 node 后，node 自己写盘 → 进覆盖层；而它 spawn 的 powershell 写盘 → **真实磁盘**
 * （`realExists=True`）。所以"把整个验收脚本托管成一个被注入的进程"是不够的，
 * 必须让**每一个被测载体**自己带上 shim。
 *
 * 用法：`WINSTAGE_ACCEPT_CARRIER=inject node tests\acceptance-transparent.mjs`（或 `--inject`）。
 */
const CARRIER = process.env.WINSTAGE_ACCEPT_CARRIER === 'inject' || process.argv.includes('--inject') ? 'inject' : 'shell'
const SHIM_DIR = process.env.WINSTAGE_SHIM_DIR ? resolve(process.env.WINSTAGE_SHIM_DIR) : join(REPO, 'shim', 'out')
const POWERSHELL_EXE = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function record(id, title, status, detail) {
  results.push({ id, title, status, detail })
  if (!JSON_OUT) {
    const tag = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }[status]
    console.log(`[${tag}] ${id}  ${title}`)
    if (detail) console.log(`       ${String(detail).replace(/\n/g, '\n       ')}`)
  }
}

const rand = Math.random().toString(36).slice(2, 10)

/** inject 模式的一次性装配：产物 + 掩码清单 + 本次运行的暂存根与 shim 配置。 */
function setupInjectedCarrier() {
  const dll = join(SHIM_DIR, 'winstage-shim.dll')
  const injectorExe = join(SHIM_DIR, 'winstage-inject.exe')
  const maskFile = join(SHIM_DIR, 'mask.json')
  for (const [label, file] of [['shim dll', dll], ['injector', injectorExe]]) {
    if (!existsSync(file)) throw new Error(`${label} not found: ${file} — run node tools\\build-shim.mjs`)
  }
  if (!existsSync(maskFile)) {
    const ex = spawnSync(process.execPath, [join(REPO, 'src', 'paths.mjs'), '--export-mask', maskFile], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true })
    if (ex.status !== 0 || !existsSync(maskFile)) throw new Error(`read-mask export failed (${ex.status}); expected ${maskFile}`)
  }
  // 默认用本次运行自己的临时暂存根；设 WINSTAGE_ACCEPT_STAGE_ROOT 可指向
  // **会话 store**（<root>/.dshstage/sessions/<sid>）—— 那时 shim 的暂存与插件读的是同一棵树，
  // T8（审阅快照）才有机会看到 T5/T6 的写入。
  const stageRoot = process.env.WINSTAGE_ACCEPT_STAGE_ROOT
    ? resolve(process.env.WINSTAGE_ACCEPT_STAGE_ROOT)
    : join(WORKSPACE, '.dshstage', `accept-inject-${rand}`)
  mkdirSync(stageRoot, { recursive: true })
  const configPath = join(stageRoot, 'winstage-shim.config.json')
  const logPath = join(stageRoot, 'shim.log')
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        stageRoot,
        logPath,
        failClosed: true,
        readThrough: true,
        readDenyFile: maskFile,
        passthrough: [stageRoot],
        traceStagedOps: true,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  )
  return { dll, injectorExe, maskFile, stageRoot, configPath, logPath, reports: 0 }
}

let injector = null
if (CARRIER === 'inject') {
  injector = setupInjectedCarrier()
  if (!JSON_OUT) console.log(`# 载体模式 = inject（逐载体注入）\n# shim   = ${injector.dll}\n# stage  = ${injector.stageRoot}`)
}

/** 用文件描述符重定向跑 PowerShell 脚本，返回 { code, out, err }。绝不使用管道。 */
function runPowerShell(script, { timeout = 60000 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'winstage-accept-'))
  const ps1 = join(dir, 'probe.ps1')
  const outF = join(dir, 'out.txt')
  const errF = join(dir, 'err.txt')
  // 用 UTF-8 BOM 写脚本，避免非 ASCII 被 OEM 代码页破坏
  writeFileSync(ps1, '\uFEFF' + script, 'utf8')
  const outFd = openSync(outF, 'w')
  const errFd = openSync(errF, 'w')
  let r
  try {
    if (injector) {
      injector.reports += 1
      r = spawnSync(
        injector.injectorExe,
        [
          '--dll', injector.dll,
          '--set-env', `WINSTAGE_STAGE_ROOT=${injector.stageRoot}`,
          '--set-env', `DSH_REGSTAGE_ROOT=${injector.stageRoot}`,
          '--set-env', `WINSTAGE_SHIM_CONFIG=${injector.configPath}`,
          '--set-env', `WINSTAGE_SHIM_LOG=${injector.logPath}`,
          '--report', join(injector.stageRoot, `inject-${injector.reports}.json`),
          '--timeout-ms', '60000', '--child-timeout-ms', '120000',
          '--', POWERSHELL_EXE, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1,
        ],
        { stdio: ['ignore', outFd, errFd], timeout, windowsHide: true },
      )
    } else {
      r = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1],
        { stdio: ['ignore', outFd, errFd], timeout, windowsHide: true },
      )
    }
  } finally {
    closeSync(outFd)
    closeSync(errFd)
  }
  const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '')
  const res = { code: r.status, signal: r.signal, error: r.error ? String(r.error.message) : null, out: read(outF), err: read(errF) }
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  return res
}

// ───────────────────────────────────────────────────────────────────────────
// 0. 沙箱载体：注入 shim 后 PowerShell 必须仍能正常启动
//    （Lead 实测：某版 shim 注入后 powershell.exe 会以
//     "The type initializer for 'System.Management.Automation.Runspaces.InitialSessionState'
//      threw an exception." 崩溃，exit 0xFFFF0000。所有 shell 命令都是 PowerShell
//     子进程，所以这一项失败会让后面每一项都以级联失败的形式出现——显式列出来便于定位。）
// ───────────────────────────────────────────────────────────────────────────
{
  const r = runPowerShell(`
"PS-CARRIER=" + ($PSVersionTable.PSVersion.ToString())
& node --version | Out-String | ForEach-Object { "PS-CARRIER-NODE=" + $_.Trim() }
`)
  const ver = /PS-CARRIER=([\d.]+)/.exec(r.out)?.[1]
  const nodeV = /PS-CARRIER-NODE=(.*)/.exec(r.out)?.[1]?.trim()
  if (r.code === 0 && ver) {
    record('T0-powershell-carrier', 'PowerShell 载体可用（shim 注入后不崩）', 'pass', `PS ${ver}${nodeV ? ` / node ${nodeV}` : ''}`)
  } else {
    record(
      'T0-powershell-carrier',
      'PowerShell 载体可用（shim 注入后不崩）',
      'fail',
      `exit=${r.code} out="${r.out.trim().slice(0, 200)}" err="${r.err.trim().slice(0, 300)}"`,
    )
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 1. 沙箱痕迹不可见
// ───────────────────────────────────────────────────────────────────────────
{
  const r = runPowerShell(`
$envNames = [Environment]::GetEnvironmentVariables().Keys | Where-Object { $_ -like 'DSH_SANDBOX*' }
"ENVCOUNT=" + @($envNames).Count
"ENVLIST=" + (@($envNames) -join ',')
"MARKER=" + [bool]($envNames.Count -gt 0)
`)
  const envCount = /ENVCOUNT=(\d+)/.exec(r.out)?.[1]
  const list = /ENVLIST=(.*)/.exec(r.out)?.[1] ?? ''
  if (r.code !== 0) record('T1-env-invisible', '子进程环境中无 DSH_SANDBOX*', 'fail', `powershell 退出码 ${r.code}: ${r.err}`)
  else if (Number(envCount) === 0) record('T1-env-invisible', '子进程环境中无 DSH_SANDBOX*', 'pass', 'ENVCOUNT=0')
  else record('T1-env-invisible', '子进程环境中无 DSH_SANDBOX*', 'fail', `仍存在: ${list}`)
}

// ───────────────────────────────────────────────────────────────────────────
// 2. 管道与重定向
// ───────────────────────────────────────────────────────────────────────────
{
  const r = runPowerShell(`
& node --version | Out-String | ForEach-Object { "PIPE=[" + $_.Trim() + "]" }
$f = Join-Path $env:TEMP 'winstage-accept-redir.txt'
& node --version > $f
"REDIR=[" + ((Get-Content $f -Raw -ErrorAction SilentlyContinue) + '').Trim() + "]"
Remove-Item $f -Force -ErrorAction SilentlyContinue
`)
  const pipe = /PIPE=\[(.*?)\]/.exec(r.out)?.[1] ?? ''
  const redir = /REDIR=\[(.*?)\]/.exec(r.out)?.[1] ?? ''
  const pipeOk = /^v\d+\./.test(pipe)
  const redirOk = /^v\d+\./.test(redir)
  evidence.pipe = { pipe, redir, stderr: r.err.slice(0, 400) }
  if (pipeOk && redirOk) record('T2-pipe-redirect', '管道与重定向可用', 'pass', `pipe=${pipe} redir=${redir}`)
  else record('T2-pipe-redirect', '管道与重定向可用', 'fail', `pipe="${pipe}" redir="${redir}" stderr=${r.err.slice(0, 200)}`)
}

// ───────────────────────────────────────────────────────────────────────────
// 3. .NET/WinHTTP TLS
// ───────────────────────────────────────────────────────────────────────────
{
  const r = runPowerShell(`
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
try {
  $t = New-Object Net.Sockets.TcpClient('registry.npmmirror.com', 443)
  $s = New-Object Net.Security.SslStream($t.GetStream(), $false, {$true})
  $s.AuthenticateAsClient('registry.npmmirror.com')
  "TLS=OK:" + $s.SslProtocol
  $t.Close()
} catch {
  $m = $_.Exception.Message
  if ($_.Exception.InnerException) { $m = $_.Exception.InnerException.Message }
  "TLS=FAIL:" + $m
}
`)
  const m = /TLS=(OK|FAIL):(.*)/.exec(r.out)
  if (m && m[1] === 'OK') record('T3-tls', '.NET TLS 握手成功', 'pass', m[2].trim())
  else record('T3-tls', '.NET TLS 握手成功', 'fail', m ? m[2].trim() : `无输出 (code=${r.code}) ${r.err.slice(0, 200)}`)
}

// ───────────────────────────────────────────────────────────────────────────
// 4. 系统查询
// ───────────────────────────────────────────────────────────────────────────
{
  const r = runPowerShell(`
$ok = 0; $bad = @()
& whoami.exe /user  > $null 2>&1; if ($LASTEXITCODE -eq 0) { $ok++ } else { $bad += 'whoami-user' }
& whoami.exe /groups > $null 2>&1; if ($LASTEXITCODE -eq 0) { $ok++ } else { $bad += 'whoami-groups' }
& tasklist.exe /FI "IMAGENAME eq node.exe" > $null 2>&1; if ($LASTEXITCODE -eq 0) { $ok++ } else { $bad += 'tasklist' }
try { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop | Out-Null; $ok++ } catch { $bad += 'cim' }
try { Get-NetFirewallProfile -ErrorAction Stop | Out-Null; $ok++ } catch { $bad += 'firewall' }
"OK=$ok"
"BAD=" + ($bad -join ',')
`)
  const ok = Number(/OK=(\d+)/.exec(r.out)?.[1] ?? -1)
  const bad = /BAD=(.*)/.exec(r.out)?.[1] ?? ''
  if (ok === 5) record('T4-system-queries', '系统查询 5/5 可用', 'pass', 'whoami/tasklist/CIM/防火墙 全部 OK')
  else record('T4-system-queries', '系统查询 5/5 可用', 'fail', `通过 ${ok}/5，失败项: ${bad}`)
}

// ───────────────────────────────────────────────────────────────────────────
// 5. 工作区外文件写入：报告成功 + 真实磁盘不变 + 进暂存
// ───────────────────────────────────────────────────────────────────────────
{
  const outsideDir = 'C:\\Windows\\Temp'
  const probeName = `winstage-accept-outside-${rand}.txt`
  const probePath = `${outsideDir}\\${probeName}`
  const r = runPowerShell(`
try {
  Set-Content -LiteralPath '${probePath}' -Value 'accept-outside' -ErrorAction Stop
  "WRITE=OK"
} catch { "WRITE=FAIL:" + $_.Exception.GetType().Name }
`)
  const writeOk = /WRITE=OK/.test(r.out)
  const realExists = existsSync(probePath)
  // 未生效（例如载体模式=shell 却跑在没有 winstage 托管的会话里）时这次写入会**真的落盘**。
  // 验收台不能留下垃圾：只在真的漏到真实磁盘时清掉，并把结果写进证据（沙箱正常时不会触发）。
  let realCleaned = false
  if (realExists) {
    try {
      rmSync(probePath, { force: true })
      realCleaned = !existsSync(probePath)
    } catch {}
  }
  let staged = null
  try {
    const stack = [join(WORKSPACE, '.dshstage')]
    while (stack.length) {
      const d = stack.pop()
      let ents = []
      try { ents = readdirSync(d, { withFileTypes: true }) } catch { continue }
      for (const e of ents) {
        const p = join(d, e.name)
        if (e.isDirectory()) stack.push(p)
        else if (e.name === probeName) staged = p
      }
    }
  } catch {}
  evidence.outsideWrite = { probePath, writeOk, realExists, realCleaned, staged }
  if (writeOk && !realExists && staged) record('T5-outside-write-staged', '工作区外写入报告成功且真实磁盘不变', 'pass', `staged=${staged}`)
  else if (!writeOk) record('T5-outside-write-staged', '工作区外写入报告成功且真实磁盘不变', 'fail', `写入未报成功: ${r.out.trim()} ${r.err.slice(0, 200)}`)
  else if (realExists) record('T5-outside-write-staged', '工作区外写入报告成功且真实磁盘不变', 'fail', `真实磁盘出现了文件: ${probePath}`)
  else record('T5-outside-write-staged', '工作区外写入报告成功且真实磁盘不变', 'fail', `报成功但未在暂存树找到副本 (真实磁盘无)`)
}

// ───────────────────────────────────────────────────────────────────────────
// 6. 注册表写入：报告成功 + 真实 hive 不变 + 进暂存
// ───────────────────────────────────────────────────────────────────────────
{
  const keyName = `WinstageAccept${rand}`
  const r = runPowerShell(`
try {
  New-Item -Path 'HKCU:\\Software\\${keyName}' -Force -ErrorAction Stop | Out-Null
  New-ItemProperty -Path 'HKCU:\\Software\\${keyName}' -Name Probe -Value 'accept' -Force -ErrorAction Stop | Out-Null
  "WRITE=OK"
} catch { "WRITE=FAIL:" + $_.Exception.GetType().Name }
`)
  const writeOk = /WRITE=OK/.test(r.out)
  // 真实 hive 的判据：用**独立进程**（reg query 不过 shim 的覆盖层）查真实键。
  // 若 ctx.shell 不是 WinStage、载体模式又不是 inject，这次写入会**真的进真实 hive**；
  // 验收台必须自己清掉，绝不留下 `WinstageAccept*` 残渣。
  const realKey = (() => {
    try {
      return spawnSync('reg.exe', ['query', `HKCU\\Software\\${keyName}`], { encoding: 'utf8', windowsHide: true }).status === 0
    } catch {
      return false
    }
  })()
  let realCleaned = false
  if (realKey) {
    try {
      spawnSync('reg.exe', ['delete', `HKCU\\Software\\${keyName}`, '/f'], { encoding: 'utf8', windowsHide: true })
      realCleaned = spawnSync('reg.exe', ['query', `HKCU\\Software\\${keyName}`], { encoding: 'utf8', windowsHide: true }).status !== 0
    } catch {}
  }
  // 只认**本次新产生**的注册表覆盖物：名为 `overlay.hive`、不在 capability-probe 的旧暂存根里、
  // 且 mtime 在最近 5 分钟内。旧写法"路径里带 registry 就算"会把 capability-probe 的陈旧
  // overlay.hive 当成证据 ⇒ 未生效时也会报绿（2026-09-30 实测到的假绿就是这么来的）。
  const overlayDir = join(WORKSPACE, '.dshstage')
  let overlay = null
  const freshAfter = Date.now() - 5 * 60 * 1000
  try {
    const stack = [overlayDir]
    while (stack.length) {
      const d = stack.pop()
      let ents = []
      try { ents = readdirSync(d, { withFileTypes: true }) } catch { continue }
      for (const e of ents) {
        const p = join(d, e.name)
        if (e.isDirectory()) { stack.push(p); continue }
        if (e.name !== 'overlay.hive') continue
        if (/capability-probe/i.test(p)) continue
        try { if (statSync(p).mtimeMs < freshAfter) continue } catch { continue }
        overlay = overlay ?? p
      }
    }
  } catch {}
  evidence.registryWrite = { keyName, writeOk, realKey, realCleaned, overlay }
  if (writeOk && overlay && !realKey) record('T6-registry-staged', '注册表写入报告成功且真实 hive 不变、进暂存', 'pass', `overlay=${overlay}`)
  else if (!writeOk) record('T6-registry-staged', '注册表写入报告成功且真实 hive 不变、进暂存', 'fail', `写入未报成功: ${r.out.trim()} ${r.err.slice(0, 200)}`)
  else if (realKey) record('T6-registry-staged', '注册表写入报告成功且真实 hive 不变、进暂存', 'fail', `真实 hive 出现了 HKCU\\Software\\${keyName}（已清理=${realCleaned}）`)
  else record('T6-registry-staged', '注册表写入报告成功且真实 hive 不变、进暂存', 'fail', '报成功但暂存树未发现**本次**注册表覆盖物（需新鲜的 overlay.hive，且非 capability-probe 旧根）')
}

// ───────────────────────────────────────────────────────────────────────────
// 7. 敏感文件读取被拒
// ───────────────────────────────────────────────────────────────────────────
{
  const targets = [
    ['DSH 凭据', 'C:\\Users\\Administrator\\.dsh\\.credentials.yaml'],
    ['Edge Login Data', 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Login Data'],
    ['PSReadLine 历史', 'C:\\Users\\Administrator\\AppData\\Roaming\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt'],
  ]
  const r = runPowerShell(targets.map(([, p], i) => `
$p = '${p.replace(/\\/g, '\\\\')}'
try {
  if (Test-Path -LiteralPath $p) {
    $fs = [IO.File]::Open($p, 'Open', 'Read', 'ReadWrite'); $fs.Close()
    "READ${i}=READABLE"
  } else { "READ${i}=NOTPRESENT" }
} catch { "READ${i}=DENIED" }
`).join('\n'))
  const verdicts = targets.map(([label], i) => {
    const v = new RegExp(`READ${i}=(\\w+)`).exec(r.out)?.[1] ?? 'NOOUTPUT'
    return { label, verdict: v }
  })
  evidence.reads = verdicts
  const leaked = verdicts.filter((v) => v.verdict === 'READABLE')
  if (verdicts.some((v) => v.verdict === 'NOOUTPUT')) record('T7-sensitive-reads', '敏感文件读取被拒', 'fail', `无输出，采集失败: ${r.err.slice(0, 200)}`)
  else if (leaked.length === 0) record('T7-sensitive-reads', '敏感文件读取被拒', 'pass', verdicts.map((v) => `${v.label}=${v.verdict}`).join(' '))
  else record('T7-sensitive-reads', '敏感文件读取被拒', 'fail', `仍可读: ${leaked.map((v) => v.label).join(', ')}`)
}

// ───────────────────────────────────────────────────────────────────────────
// 8. 审批面板覆盖所有修改
// ───────────────────────────────────────────────────────────────────────────
{
  // 会话隔离后快照落在 <root>/.dshstage/sessions/<sid>/review.json；同时兼容旧版共享位置
  // <root>/.dshstage/review.json。优先匹配当前 DSH_SESSION_ID，否则取最新 mtime。
  // 走一次与 winstage shell 执行器**同一条**的发布路径：真实命令跑完后执行器做的
  // 就是这件事（publishSnapshotIfChanged -> publishWorkspaceSnapshot）。
  // 只有把 stage 根指到会话 store 时才有意义。
  if (CARRIER === 'inject' && process.env.WINSTAGE_ACCEPT_STAGE_ROOT && process.env.WINSTAGE_ACCEPT_PUBLISH !== '0') {
    try {
      const { publishWorkspaceSnapshot } = await import(pathToFileURL(join(REPO, 'dsh-plugin', 'shell-executor.mjs')).href)
      const published = await publishWorkspaceSnapshot(process.env.DSH_SESSION_ID, WORKSPACE)
      evidence.publish = { ok: true, files: published?.files?.length ?? null, pending: published?.pending ?? null }
    } catch (error) {
      evidence.publish = { ok: false, error: String(error?.message ?? error) }
    }
  }

  const candidates = []
  const sharedReview = join(WORKSPACE, '.dshstage', 'review.json')
  if (existsSync(sharedReview)) candidates.push(sharedReview)
  try {
    const sessionsDir = join(WORKSPACE, '.dshstage', 'sessions')
    for (const e of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = join(sessionsDir, e.name, 'review.json')
      if (existsSync(p)) candidates.push(p)
    }
  } catch {}
  const sid = process.env.DSH_SESSION_ID
  let reviewPath = sid ? candidates.find((p) => p.includes(sid)) : undefined
  if (!reviewPath) {
    reviewPath = candidates
      .map((p) => ({ p, m: (() => { try { return statSync(p).mtimeMs } catch { return 0 } })() }))
      .sort((a, b) => b.m - a.m)[0]?.p
  }
  let review = null
  try { review = reviewPath ? JSON.parse(readFileSync(reviewPath, 'utf8')) : null } catch {}
  if (!review) {
    record('T8-approval-panel', '审批面板覆盖所有修改', 'fail', `读不到 review.json（候选 ${candidates.length} 个）`)
  } else {
    const files = Array.isArray(review.files) ? review.files : []
    const hasOutside = files.some((f) => /winstage-accept-outside-/.test(f.path ?? ''))
    const hasReg = files.some((f) => /WinstageAccept/.test(f.path ?? ''))
    evidence.review = { pending: review.pending, count: files.length, hasOutside, hasReg }
    if (hasOutside && hasReg) record('T8-approval-panel', '审批面板覆盖所有修改', 'pass', `pending=${review.pending} files=${files.length}`)
    else record('T8-approval-panel', '审批面板覆盖所有修改', 'fail', `files=${files.length} 越界文件命中=${hasOutside} 注册表命中=${hasReg}`)
  }
}

// ───────────────────────────────────────────────────────────────────────────
const pass = results.filter((r) => r.status === 'pass').length
const fail = results.filter((r) => r.status === 'fail').length
const summary = { total: results.length, pass, fail, results, evidence, at: new Date().toISOString() }
if (JSON_OUT) console.log(JSON.stringify(summary, null, 2))
else {
  console.log('')
  console.log('='.repeat(72))
  console.log(`透明暂存验收：${pass} 通过 / ${fail} 失败 / 共 ${results.length} 项`)
  if (fail) console.log('失败项：' + results.filter((r) => r.status === 'fail').map((r) => r.id).join(', '))
  console.log('='.repeat(72))
}
process.exit(fail ? 1 : 0)
