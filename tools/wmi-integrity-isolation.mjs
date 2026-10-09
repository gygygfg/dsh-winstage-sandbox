// Isolate WHY a process created by winstage-inject.exe loses access to
// root\StandardCimv2 (the firewall canary). The query result is written to a
// FILE so cases that pass no inheritable handles can still report.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = 'C:\\Users\\Administrator\\Desktop\\dsh-winstage-sandbox'
const OUT = process.argv.includes('--out-dir')
  ? path.resolve(REPO, process.argv[process.argv.indexOf('--out-dir') + 1])
  : path.join(REPO, 'esc', 'par', 'lead')
const INJ = path.join(OUT, 'winstage-inject.exe')
const SHIM_DLL = path.join(OUT, 'winstage-shim.dll')
const VERSION_DLL = 'C:\\Windows\\System32\\version.dll'
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const BASE = path.join(REPO, 'esc', 'wmi-iso2')
fs.rmSync(BASE, { recursive: true, force: true })

function scriptFor(resultPath) {
  return [
    '$ErrorActionPreference = "Continue"',
    `$out = '${resultPath}'`,
    '$lines = @()',
    'try { Get-CimInstance -Namespace root/cimv2 -ClassName Win32_OperatingSystem -ErrorAction Stop | Out-Null; $lines += "CIMV2=OK" } catch { $lines += "CIMV2=ERR:" + $_.Exception.Message }',
    'try { Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetFirewallProfile -ErrorAction Stop | Out-Null; $lines += "STDCIM=OK" } catch { $lines += "STDCIM=ERR:" + $_.Exception.Message }',
    'try { Get-NetFirewallProfile -ErrorAction Stop | Out-Null; $lines += "NETFW=OK" } catch { $lines += "NETFW=ERR:" + $_.Exception.Message }',
    '$lines += "ELEV=" + (New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    'Set-Content -LiteralPath $out -Value ($lines -join " | ") -Encoding UTF8',
  ].join('\r\n')
}

function runCase(label, injectorArgs) {
  const stage = path.join(BASE, label)
  fs.mkdirSync(stage, { recursive: true })
  const resultPath = path.join(stage, 'result.txt')
  const script = scriptFor(resultPath)
  const o = fs.openSync(path.join(stage, 'out.txt'), 'w')
  const e = fs.openSync(path.join(stage, 'err.txt'), 'w')
  let r
  try {
    if (injectorArgs) {
      r = spawnSync(INJ, [...injectorArgs, '--', PS, '-NoProfile', '-NonInteractive', '-Command', script],
        { stdio: ['ignore', o, e], cwd: REPO, timeout: 180000, windowsHide: true })
    } else {
      r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', script],
        { stdio: ['ignore', o, e], cwd: REPO, timeout: 180000, windowsHide: true })
    }
  } finally { fs.closeSync(o); fs.closeSync(e) }
  const result = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8').replace(/\s+/g, ' ').trim() : '(no result file)'
  return `${label.padEnd(34)} exit=${String(r.status).padStart(4)}  ${result}`
}

const envFor = (stage) => [
  '--set-env', `WINSTAGE_STAGE_ROOT=${stage}`,
  '--set-env', `DSH_REGSTAGE_ROOT=${stage}`,
  '--set-env', `WINSTAGE_SHIM_LOG=${path.join(stage, 'shim.log')}`,
]

const rows = []
rows.push(runCase('01-direct', null))
rows.push(runCase('02-noinject-suspend-inherit', ['--no-inject', '--dll', VERSION_DLL]))
rows.push(runCase('03-noinject-nosuspend-inherit', ['--no-inject', '--no-suspend', '--dll', VERSION_DLL]))
rows.push(runCase('04-noinject-suspend-noinherit', ['--no-inject', '--no-inherit', '--dll', VERSION_DLL]))
rows.push(runCase('05-noinject-nosuspend-noinherit', ['--no-inject', '--no-suspend', '--no-inherit', '--dll', VERSION_DLL]))
rows.push(runCase('06-inject-shim-nosuspend-inherit', ['--no-suspend', '--dll', SHIM_DLL, ...envFor(path.join(BASE, '06'))]))
rows.push(runCase('07-inject-shim-suspend-inherit', ['--dll', SHIM_DLL, ...envFor(path.join(BASE, '07'))]))
for (const row of rows) console.log(row)
