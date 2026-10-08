// Proper token/privilege comparison: direct spawn vs injector spawn.
// (The previous version lost the whoami output because native `*>` redirection
// inside -Command did not work; capture into a variable instead.)
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox'
const OUT = path.join(REPO, 'esc', 'par', 'lead')
const INJ = path.join(OUT, 'winstage-inject.exe')
const DLL = path.join(OUT, 'winstage-shim.dll')
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const BASE = path.join(REPO, 'esc', 'token-cmp2')
fs.rmSync(BASE, { recursive: true, force: true })

function script(resultPath) {
  return [
    `$out = '${resultPath}'`,
    '$l = @()',
    '$l += "--- priv ---"',
    '$l += ((& whoami.exe /priv | Out-String) -split "`r?`n" | Where-Object { $_ -match "Se[A-Za-z]+Privilege" })',
    '$l += "privCount=" + @((& whoami.exe /priv | Out-String) -split "`r?`n" | Where-Object { $_ -match "Se[A-Za-z]+Privilege" }).Count',
    '$l += "--- groups ---"',
    '$l += ((& whoami.exe /groups | Out-String) -split "`r?`n" | Where-Object { $_ -match "Mandatory Label|Administrators|deny|LogonSession|S-1-5-5-" })',
    'Set-Content -LiteralPath $out -Value ($l -join "`r`n") -Encoding UTF8',
  ].join('\r\n')
}

function runCase(label, injectorArgs) {
  const stage = path.join(BASE, label)
  fs.mkdirSync(stage, { recursive: true })
  const resultPath = path.join(stage, 'token.txt')
  const s = script(resultPath)
  const o = fs.openSync(path.join(stage, 'out.txt'), 'w')
  const e = fs.openSync(path.join(stage, 'err.txt'), 'w')
  let r
  try {
    const argv = injectorArgs
      ? [...injectorArgs, '--', PS, '-NoProfile', '-NonInteractive', '-Command', s]
      : ['-NoProfile', '-NonInteractive', '-Command', s]
    r = spawnSync(injectorArgs ? INJ : PS, argv, { stdio: ['ignore', o, e], cwd: REPO, timeout: 180000, windowsHide: true })
  } finally { fs.closeSync(o); fs.closeSync(e) }
  return { label, status: r.status, text: fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : '(missing)' }
}

const direct = runCase('direct', null)
const injected = runCase('injector-noinject-noinherit-noenv', ['--no-inject', '--no-inherit', '--inherit-env', '--dll', DLL])

console.log('############ DIRECT ############')
console.log(direct.text.trim())
console.log('\n############ INJECTOR ############')
console.log(injected.text.trim())

const count = (t) => (t.match(/privCount=(\d+)/) || [])[1]
console.log(`\nprivCount direct=${count(direct.text)} injector=${count(injected.text)}`)
