// Sensor: inside an injected PowerShell, ask the OS (via the shim) about a set of
// paths and record the answers, so the whiteout-induced flip can be identified.
// Uses only .NET calls (no cmdlets) so it still runs when PowerShell autoload is
// broken, and writes the result with [IO.File]::WriteAllText.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const REPO = 'C:\\Users\\Administrator\\Desktop\\WinStageSandbox'
const OUT = process.argv.includes('--out-dir')
  ? path.resolve(REPO, process.argv[process.argv.indexOf('--out-dir') + 1])
  : path.join(REPO, 'esc', 'par', 'lead')
const INJ = path.join(OUT, 'winstage-inject.exe')
const DLL = path.join(OUT, 'winstage-shim.dll')
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
const BASE = path.join(REPO, 'esc', `stat-sensor-${Date.now().toString(36)}`)
// P2-8: the injector's child timeout defaults to 300s, longer than this tool's
// own spawnSync timeout, so the parent would kill the injector before it could
// write its report. Keep the child timeout 30s under the parent timeout.
const PARENT_TIMEOUT_MS = 120000
const CHILD_TIMEOUT_MS = PARENT_TIMEOUT_MS - 30000
fs.mkdirSync(BASE, { recursive: true })

function scriptFor(resultPath) {
  const paths = [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Utility',
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1',
    'C:\\Program Files\\WindowsPowerShell\\Modules',
    'C:\\Users\\Administrator\\Documents\\WindowsPowerShell\\Modules',
    'C:\\Windows',
    'C:\\Users\\Administrator\\AppData\\Local\\Temp',
  ]
  const body = paths
    .map((p, i) => `$l += "P${i} ${p} file=" + [IO.File]::Exists('${p}') + " dir=" + [IO.Directory]::Exists('${p}')`)
    .join('\r\n')
  return [
    '$l = @()',
    `$tmp = '${path.join(BASE, 'probe-note.txt')}'`,
    '$l += "TMPDIR " + $env:TEMP',
    body,
    `[IO.File]::WriteAllText('${resultPath}', ($l -join [char]13 + [char]10))`,
  ].join('\r\n')
}

function run(label, { marker }) {
  const stage = path.join(BASE, label)
  fs.mkdirSync(stage, { recursive: true })
  if (marker) {
    const wo = path.join(stage, 'wo', ...marker.split('/'))
    fs.mkdirSync(path.dirname(wo), { recursive: true })
    fs.writeFileSync(wo, '')
  }
  const resultPath = path.join(stage, 'result.txt')
  const o = fs.openSync(path.join(stage, 'out.txt'), 'w'); const e = fs.openSync(path.join(stage, 'err.txt'), 'w')
  let r
  try {
    r = spawnSync(INJ, ['--dll', DLL,
      '--set-env', `WINSTAGE_STAGE_ROOT=${stage}`,
      '--set-env', `DSH_REGSTAGE_ROOT=${stage}`,
      '--set-env', `WINSTAGE_SHIM_LOG=${path.join(stage, 'shim.log')}`,
      '--report', path.join(stage, 'inj.json'),
      '--child-timeout-ms', String(CHILD_TIMEOUT_MS), '--',
      PS, '-NoProfile', '-NonInteractive', '-Command', scriptFor(resultPath)],
      { stdio: ['ignore', o, e], cwd: REPO, timeout: PARENT_TIMEOUT_MS, windowsHide: true })
  } finally { fs.closeSync(o); fs.closeSync(e) }
  const res = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : '(no result)'
  const err = fs.readFileSync(path.join(stage, 'err.txt'), 'utf8').replace(/\s+/g, ' ').trim()
  return { label, status: r.status, res, err }
}

const a = run('01-no-whiteout', {})
const b = run('02-whiteout', { marker: 'C/Windows/Temp/zzz-unrelated.txt' })
const lines = (t) => Object.fromEntries(t.trim().split(/\r?\n/).map((l) => [l.split(' ')[0], l.slice(l.indexOf(' ') + 1)]))
const la = lines(a.res), lb = lines(b.res)
console.log(`01-no-whiteout exit=${a.status} err=${JSON.stringify(a.err.slice(0, 80))}`)
console.log(`02-whiteout   exit=${b.status} err=${JSON.stringify(b.err.slice(0, 80))}`)
for (const k of new Set([...Object.keys(la), ...Object.keys(lb)])) {
  const same = la[k] === lb[k]
  console.log(`${same ? '  ' : '>>'} ${k.padEnd(7)} pass=${JSON.stringify(la[k])}`)
  if (!same) console.log(`            fail=${JSON.stringify(lb[k])}`)
}
console.log(`base: ${BASE}`)
